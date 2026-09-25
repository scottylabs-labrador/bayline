// Gfx: graphics settings. The player's quality choice (persisted), the Ultra+ eligibility probe and the shared WebGPU
// device Ultra+ computes with, and the "Graphics" chip rows (title card, help overlay). The renderer itself is WebGL2;
// WebGPU is used for compute only (the benchmark below and SunShade's terrain-lighting solver).
//   Gfx.pref / Gfx.setPref(p)     'auto' | 'low' | 'medium' | 'high' | 'ultra' | 'ultraplus'   (localStorage bayline.gfx)
//   Gfx.probe({ force })          Promise<{ ok, reason, ms, adapter }>: WebGPU adapter + limits + a compute benchmark,
//                                 cached per adapter and browser for 30 days
//   Gfx.device()                  Promise<GPUDevice | null>: one high-performance device, recreated once after a loss
//   Gfx.SHADOW_WGSL               the terrain sun-shadow kernel (the benchmark runs the real workload)
//   Gfx.renderChips(el, current, onPick)   draw a chip row (Ultra+ disabled with the probe's reason when ineligible)
const Gfx = (() => {
  // a passed benchmark is kept 30 days; a too-slow one only a day (it may have run while something else loaded the GPU),
  // and the Ultra+ chip stays clickable to test again. Hard failures (no WebGPU, software adapter, limits) aren't cached.
  const LS_PREF = 'bayline.gfx', LS_PROBE = 'bayline.gfx.probe.v2', PROBE_DAYS = 30, SLOW_DAYS = 1;
  const LEVELS = ['auto', 'low', 'medium', 'high', 'ultra', 'ultraplus'];
  const LABEL = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra', ultraplus: 'Ultra+' };
  // benchmark: the terrain-shadow kernel on a 512² fractal field, 160 steps, BENCH_REP dispatches per timed run, with the
  // page not drawing (second best of 7 after two warm-ups). Pass = at most 1.4x the time of an Apple M2 (10-core GPU,
  // BENCH_REF ms): Ultra+ holds ~30 fps there in dense San Francisco at 1.0x resolution, so that is the floor; M1-class and
  // integrated GPUs fail, M2 Pro/Max, M3+, and recent discrete GPUs pass (and render Ultra+ at up to 2x).
  const BENCH_N = 512, BENCH_STEPS = 160, BENCH_REP = 8, BENCH_REF = 8.5, BENCH_MAX_MS = 1.4 * BENCH_REF;   // (M2: 8.4-9.9 ms)
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  let pref = LEVELS.includes(ls.get(LS_PREF)) ? ls.get(LS_PREF) : 'auto';
  let probeP = null, probeRes = null, dev = null, devP = null, lost = 0, lastBench = null, benching = false;
  const listeners = [];

  // Terrain sun shadow over a height field (row-major f32, n x n cells of `cell` m). For every cell: march toward the
  // sun with geometrically growing steps and keep S = max_k (H(q_k) - t_k tan(elevation)), the height of the terrain
  // shadow's top above that cell (any point below S is in the terrain's shadow), and t* (the occluder distance: the
  // penumbra grows with it). Output packed as f16 pairs (S, t*) in one u32 per cell.
  const SHADOW_WGSL = /* wgsl */`
    struct P { n: u32, steps: u32, cell: f32, tanEl: f32, dir: vec2f, t0: f32, grow: f32, outN: u32, outScale: f32, offX: f32, offY: f32, row0: u32, hMax: f32, pad0: u32, pad1: u32 };
    @group(0) @binding(0) var<storage, read> H: array<f32>;
    @group(0) @binding(1) var<storage, read_write> OUT: array<u32>;
    @group(0) @binding(2) var<uniform> p: P;
    fn hAt(q: vec2f) -> f32 {
      let m = f32(p.n - 1u); let c = clamp(q, vec2f(0.0), vec2f(m - 0.001));
      let i = vec2u(floor(c)); let f = c - floor(c); let k = i.y * p.n + i.x;
      return mix(mix(H[k], H[k + 1u], f.x), mix(H[k + p.n], H[k + p.n + 1u], f.x), f.y);
    }
    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) id: vec3u) {
      let row = id.y + p.row0;
      if (id.x >= p.outN || row >= p.outN) { return; }
      let o = (vec2f(f32(id.x), f32(row)) + 0.5) * p.outScale + vec2f(p.offX, p.offY);   // output cell centre, in input samples
      var t = p.t0; var best = -1e9; var tb = 0.0;
      for (var k = 0u; k < p.steps; k++) {
        let q = o + p.dir * t;
        if (any(q < vec2f(0.0)) || any(q > vec2f(f32(p.n - 1u)))) { break; }
        let drop = t * p.cell * p.tanEl;
        if (p.hMax - drop < best) { break; }                 // nothing ahead can rise above the shadow top found so far
        let s = hAt(q) - drop;
        if (s > best) { best = s; tb = t; }
        t = t * p.grow + 0.35;
      }
      OUT[row * p.outN + id.x] = pack2x16float(vec2f(max(best, -6.0e4), tb * p.cell));   // (f16 range)
    }`;

  function adapterKey(info) { return info ? [info.vendor, info.architecture, info.device, info.description].join('|') : '?'; }
  async function getAdapter() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    try { return await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch (e) { return null; }
  }
  async function adapterInfo(a) { try { return a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null); } catch (e) { return null; } }
  function device() {
    if (dev) return Promise.resolve(dev);
    if (devP) return devP;
    devP = (async () => {
      const a = await getAdapter(); if (!a) return null;
      try {
        const d = await a.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: Math.min(a.limits.maxStorageBufferBindingSize, 256 << 20), maxBufferSize: Math.min(a.limits.maxBufferSize, 256 << 20) } });
        d.lost.then((info) => { console.warn('gfx: WebGPU device lost', info && info.message); if (dev === d) { dev = null; devP = null; lost++; } for (const f of listeners) f({ lost: true }); });
        dev = d; return d;
      } catch (e) { console.warn('gfx: no WebGPU device', e && e.message); return null; }
    })().finally(() => { if (!dev) devP = null; });
    return devP;
  }
  // a fractal height field for the benchmark (so its memory traffic and branch behaviour resemble real terrain)
  function synthField(n) {
    const h = new Float32Array(n * n), r = U.rng(99);
    const oct = [[4, 300], [16, 90], [64, 25], [256, 6]];
    const g = oct.map(([c]) => { const a = new Float32Array((c + 1) * (c + 1)); for (let i = 0; i < a.length; i++) a[i] = r() * 2 - 1; return a; });
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let v = 0;
      for (let o = 0; o < oct.length; o++) { const c = oct[o][0], fx = x * c / n, fy = y * c / n, ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, a = g[o], w = c + 1;
        v += oct[o][1] * ((a[iy * w + ix] * (1 - tx) + a[iy * w + ix + 1] * tx) * (1 - ty) + (a[(iy + 1) * w + ix] * (1 - tx) + a[(iy + 1) * w + ix + 1] * tx) * ty); }
      h[y * n + x] = Math.max(0, v + 150);
    }
    return h;
  }
  async function bench(d) {
    const n = BENCH_N, steps = BENCH_STEPS, field = synthField(n);
    const hb = d.createBuffer({ size: field.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); d.queue.writeBuffer(hb, 0, field);
    const ob = d.createBuffer({ size: n * n * 4, usage: GPUBufferUsage.STORAGE });
    const ub = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const P = new ArrayBuffer(64), u32 = new Uint32Array(P), f32 = new Float32Array(P);
    u32[0] = n; u32[1] = steps; f32[2] = 64; f32[3] = Math.tan(4 * Math.PI / 180); f32[4] = Math.cos(0.7); f32[5] = Math.sin(0.7); f32[6] = 1.5; f32[7] = 1.028; u32[8] = n; f32[9] = 1; f32[10] = -0.5; f32[11] = -0.5; u32[12] = 0; f32[13] = 1e9;
    d.queue.writeBuffer(ub, 0, P);
    const mod = d.createShaderModule({ code: SHADOW_WGSL });
    const pipe = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
    const bg = d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: hb } }, { binding: 1, resource: { buffer: ob } }, { binding: 2, resource: { buffer: ub } }] });
    const run = async () => {
      const t0 = performance.now(); const enc = d.createCommandEncoder(); const pass = enc.beginComputePass();
      pass.setPipeline(pipe); pass.setBindGroup(0, bg); for (let i = 0; i < BENCH_REP; i++) pass.dispatchWorkgroups(n / 8, n / 8); pass.end(); d.queue.submit([enc.finish()]);
      await d.queue.onSubmittedWorkDone(); return performance.now() - t0;
    };
    await run(); await run();                                               // warm-up (pipeline, caches, clocks)
    const t = []; for (let i = 0; i < 7; i++) t.push(await run()); t.sort((a, b) => a - b);
    hb.destroy(); ob.destroy(); ub.destroy();
    lastBench = t.map(v => +v.toFixed(1));
    return t[1];                    // the second best: the page renders meanwhile, so slower runs measure contention
  }
  function webglOk() {
    try { const gl = Env.renderer.getContext(); const tex = gl.getParameter(gl.MAX_TEXTURE_SIZE), smp = gl.getParameter(gl.MAX_SAMPLES) || 0, units = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
      if (tex < 8192) return `WebGL max texture ${tex} (needs 8192)`; if (smp < 4) return 'no 4x MSAA'; if (units < 16) return `only ${units} texture units`; return null;
    } catch (e) { return 'WebGL2 unavailable'; }
  }
  function probe(opts = {}) {
    if (probeP && !opts.force) return probeP;
    probeP = (async () => {
      const t0 = performance.now();
      const done = (r) => { probeRes = Object.assign({ ms: null, adapter: null }, r, { took: Math.round(performance.now() - t0) }); for (const f of listeners) f({ probe: probeRes }); return probeRes; };
      if (typeof navigator === 'undefined' || !navigator.gpu) return done({ ok: false, reason: 'Ultra+ needs WebGPU (not available in this browser)' });
      const a = await getAdapter(); if (!a) return done({ ok: false, reason: 'Ultra+ needs WebGPU (no GPU adapter)' });
      const info = await adapterInfo(a), key = adapterKey(info) + '|' + navigator.userAgent;
      if (a.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(key)) return done({ ok: false, reason: 'Ultra+ needs a hardware GPU', adapter: info && info.vendor });
      const wg = webglOk(); if (wg) return done({ ok: false, reason: 'Ultra+ unavailable: ' + wg, adapter: info && info.vendor });
      if (a.limits.maxTextureDimension2D < 8192 || a.limits.maxComputeInvocationsPerWorkgroup < 64) return done({ ok: false, reason: 'Ultra+ unavailable: GPU limits too low', adapter: info && info.vendor });
      if (!opts.force) {
        try { const c = JSON.parse(ls.get(LS_PROBE) || 'null'); const days = c && c.res && c.res.ok ? PROBE_DAYS : SLOW_DAYS;
          if (c && c.key === key && Date.now() - c.t < days * 864e5) return done(Object.assign({}, c.res, { cached: true })); } catch (e) {}
      }
      const d = await device(); if (!d) return done({ ok: false, reason: 'Ultra+ unavailable: WebGPU device could not start', adapter: info && info.vendor });
      // the page stops drawing for the ~0.3 s of the test (Gfx.benchmarking): a GPU shared with 60 fps rendering would
      // measure the game, not the GPU (runs vary 5 -> 100 ms on the same machine otherwise)
      let ms; benching = true;
      try { await new Promise(r => setTimeout(r, 120)); ms = await bench(d); } catch (e) { console.warn('gfx: benchmark failed', e); return done({ ok: false, reason: 'Ultra+ unavailable: benchmark failed', adapter: info && info.vendor }); }
      finally { benching = false; }
      const res = ms <= BENCH_MAX_MS ? { ok: true, reason: `GPU benchmark ${ms.toFixed(1)} ms`, ms, adapter: info && info.vendor }
        : { ok: false, slow: true, reason: `GPU too slow for Ultra+ (benchmark ${ms.toFixed(1)} ms, needs ≤ ${BENCH_MAX_MS.toFixed(1)})`, ms, adapter: info && info.vendor };
      ls.set(LS_PROBE, JSON.stringify({ key, t: Date.now(), res }));
      return done(res);
    })();
    return probeP;
  }
  function setPref(p) { if (!LEVELS.includes(p)) return; pref = p; ls.set(LS_PREF, p); for (const f of listeners) f({ pref: p }); }
  function renderChips(el, current, onPick) {
    if (!el) return;
    el.textContent = '';
    const lab = document.createElement('span'); lab.className = 'gfxlab'; lab.textContent = 'Graphics'; el.appendChild(lab);
    for (const p of LEVELS) {
      const b = document.createElement('button'); b.className = 'chip' + (p === current ? ' on' : ''); b.dataset.gfx = p; b.textContent = LABEL[p];
      if (p === 'ultraplus') {
        const r = probeRes;
        const noGpu = typeof navigator === 'undefined' || !navigator.gpu;
        if ((r && !r.ok && !r.slow) || noGpu) { b.disabled = true; b.title = r ? r.reason : 'Ultra+ needs WebGPU (not available in this browser)'; b.classList.add('off'); }
        else if (r && r.slow) { b.title = r.reason + ' · click to test again'; b.classList.add('off'); }
        else b.title = 'WebGPU terrain lighting, far shadows, lidar-resolution terrain, supersampling — ' + (r ? r.reason : 'runs a quick GPU test first');
      }
      b.addEventListener('click', () => onPick(p));
      el.appendChild(b);
    }
    const note = document.createElement('span'); note.className = 'gfxnote';
    const r = probeRes; note.textContent = current === 'ultraplus' ? 'Ultra+ on (WebGPU terrain lighting)' : r && !r.ok ? r.reason : (typeof navigator === 'undefined' || !navigator.gpu) ? 'Ultra+ needs WebGPU' : '';
    el.appendChild(note);
  }
  return {
    LEVELS, LABEL, SHADOW_WGSL, probe, device, setPref, renderChips,
    get pref() { return pref; }, get probeResult() { return probeRes; }, get benchmarking() { return benching; }, get deviceLost() { return lost; }, get lastBench() { return lastBench; },
    on(f) { listeners.push(f); },
  };
})();
