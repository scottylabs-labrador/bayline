// Terrain v2: streamed, chunked-LOD photoreal ground. A camera-driven quadtree over the SPEC_v2 tile grid
// (L0 102.4 km … L8 400 m) draws one mesh per node; each node uses the finest data loaded at or above it:
// NAIP imagery (L0–8), 129² heights (L0–7) and 128² masks (L0–7), with the v1 64 m field as the ultimate
// fallback, so the view sharpens progressively like a globe viewer and never shows holes.
// API (SPEC_v2): load, h, hasDetail, ensure, imagery, retain, release, isWater, urbanAt, maskAt,
//                update(camera), setTownFade (no-op in v2), group/mesh, info, lodFactor, stats.
const Terrain = (() => {
  // ---------- v1 fallback field (64 m heights + masks, whole world) ----------
  let N = 0, S = 64, FX0 = 0, FZ0 = 0, heights = null, mask = null, texFH = null, texFM = null;
  const X0 = -45056, Z0 = -49152, SIZE = 102400, LMAX = 9, LH = 7;   // L9 = GPU super-resolved imagery near the track
  const HS = 129, MS = 128;             // samples per height tile / mask tile
  const G = 64;                          // quads per node side
  const lodFactor = { value: 4.2 };
  const stats = { nodes: 0, img: 0, hgt: 0, msk: 0, loading: 0, evicted: 0 };
  const group = new THREE.Group(); group.name = 'terrain';
  let index = null;                      // level -> Set(key) of existing tiles (levels 6–8); 0–5 complete
  let ready = false;

  const tileSize = (L) => SIZE / (1 << L);
  const K = (L, x, y) => (L * 512 + y) * 512 + x;
  function exists(L, x, y) {
    const n = 1 << L; if (x < 0 || y < 0 || x >= n || y >= n) return false;
    if (L <= 5) return !!index || L <= 5;          // 0–5 always exist (if tiles are published at all)
    return !!(index && index[L] && index[L].has(K(L, x, y)));
  }

  // ---------- loading the fallback + index ----------
  async function load(onProgress) {
    const u8 = await Data.bin('terrain');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    N = dv.getUint32(4, true); S = dv.getFloat32(8, true); FX0 = dv.getFloat32(12, true); FZ0 = dv.getFloat32(16, true);
    const sc = dv.getFloat32(20, true), off = dv.getFloat32(24, true);
    const lo = u8.subarray(28, 28 + N * N), hi = u8.subarray(28 + N * N, 28 + 2 * N * N);
    mask = u8.slice(28 + 2 * N * N, 28 + 2 * N * N + N * N * 4);
    heights = new Float32Array(N * N); const q = new Int32Array(N * N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i; const zz = lo[k] | (hi[k] << 8); const r = (zz >>> 1) ^ -(zz & 1);
        let a, b, c;
        if (j === 0 && i === 0) { q[k] = r; continue; }
        if (j === 0) { a = q[k - 1]; b = a; c = a; } else if (i === 0) { b = q[k - N]; a = b; c = b; } else { a = q[k - 1]; b = q[k - N]; c = q[k - N - 1]; }
        const mx = a > b ? a : b, mn = a < b ? a : b; q[k] = r + (c >= mx ? mn : (c <= mn ? mx : a + b - c));
      }
      if ((j & 127) === 0 && onProgress) onProgress(j / N * 0.6);
    }
    for (let k = 0; k < N * N; k++) heights[k] = q[k] * sc + off;
    const hf = new Uint16Array(N * N); for (let k = 0; k < N * N; k++) hf[k] = THREE.DataUtils.toHalfFloat(heights[k]);
    texFH = new THREE.DataTexture(hf, N, N, THREE.RedFormat, THREE.HalfFloatType); texFH.minFilter = texFH.magFilter = THREE.LinearFilter; texFH.needsUpdate = true;
    texFM = new THREE.DataTexture(mask, N, N, THREE.RGBAFormat, THREE.UnsignedByteType); texFM.minFilter = texFM.magFilter = THREE.LinearFilter; texFM.needsUpdate = true;
    // tile index (optional: without it the world renders from the fallback field)
    try {
      const idx = await Stream.json('tiles/index.json', 0);
      index = {};
      for (const L of [6, 7, 8, 9]) { const s = new Set(); for (const [x, y] of (idx.levels && idx.levels[L]) || []) s.add(K(L, x, y)); index[L] = s; }
      index.meta = idx;
    } catch (e) { console.warn('terrain: no tile index, fallback field only', e && e.message); index = null; }
    buildShared();
    if (index) { // warm the top of the pyramid so there is always a photo underneath
      const warm = [];
      for (let L = 0; L <= 2; L++) for (let y = 0; y < (1 << L); y++) for (let x = 0; x < (1 << L); x++) { warm.push(needImg(L, x, y, 0), needHgt(L, x, y, 0)); }
      let done = 0; await Promise.all(warm.map(p => p.then(() => { done++; if (onProgress) onProgress(0.6 + 0.4 * done / warm.length); }, () => {})));
    }
    Env.scene.add(group); ready = true;
  }

  // ---------- tile records ----------
  const hrec = new Map(), mrec = new Map(), irec = new Map();   // key -> { L, x, y, state, ... }
  let frameNo = 0;
  function decodeHeights(u8) {   // MED-predicted zigzag residuals (uint16) -> Float32 heights
    const n = HS * HS; const res = new Uint16Array(u8.buffer, u8.byteOffset, n); const q = new Int32Array(n); const h = new Float32Array(n);
    for (let j = 0; j < HS; j++) for (let i = 0; i < HS; i++) {
      const k = j * HS + i; const zz = res[k]; const r = (zz >>> 1) ^ -(zz & 1); let a, b, c;
      if (j === 0 && i === 0) { q[k] = r; continue; }
      if (j === 0) { a = q[k - 1]; b = a; c = a; } else if (i === 0) { b = q[k - HS]; a = b; c = b; } else { a = q[k - 1]; b = q[k - HS]; c = q[k - HS - 1]; }
      const mx = a > b ? a : b, mn = a < b ? a : b; q[k] = r + (c >= mx ? mn : (c <= mn ? mx : a + b - c));
    }
    let mn = 1e9, mx = -1e9; for (let k = 0; k < n; k++) { const v = q[k] / 16 - 200; h[k] = v; if (v < mn) mn = v; if (v > mx) mx = v; }
    return { h, mn, mx };
  }
  function needHgt(L, x, y, prio) {
    L = Math.min(L, LH); const k = K(L, x, y); let r = hrec.get(k);
    if (r) { r.used = frameNo; return r.p; }
    r = { L, x, y, state: 1, used: frameNo, h: null, tex: null, mn: 0, mx: 0, refs: 0 }; hrec.set(k, r);
    r.path = `tiles/h/${L}/${x}_${y}.bin`;
    r.p = Stream.bin(r.path, prio).then((u8) => {
      if (u8.length < HS * HS * 2) throw new Error('short height tile');
      const d = decodeHeights(u8); r.h = d.h; r.mn = d.mn; r.mx = d.mx; r.base = d.mn;
      const hf = new Uint16Array(HS * HS); for (let i = 0; i < hf.length; i++) hf[i] = THREE.DataUtils.toHalfFloat(d.h[i] - r.base);
      const t = new THREE.DataTexture(hf, HS, HS, THREE.RedFormat, THREE.HalfFloatType); t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
      r.tex = t; r.state = 2; stats.hgt++; return r;
    }, (e) => { r.state = 3; return r; });
    return r.p;
  }
  function needMsk(L, x, y, prio) {
    L = Math.min(L, LH); const k = K(L, x, y); let r = mrec.get(k);
    if (r) { r.used = frameNo; return r.p; }
    r = { L, x, y, state: 1, used: frameNo, m: null, tex: null }; mrec.set(k, r);
    r.path = `tiles/m/${L}/${x}_${y}.bin`;
    r.p = Stream.bin(r.path, prio + 1).then((u8) => {
      if (u8.length < MS * MS * 4) throw new Error('short mask tile');
      r.m = u8; const t = new THREE.DataTexture(u8, MS, MS, THREE.RGBAFormat, THREE.UnsignedByteType); t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
      r.tex = t; r.state = 2; stats.msk++; return r;
    }, () => { r.state = 3; return r; });
    return r.p;
  }
  let maxAniso = 8;
  function needImg(L, x, y, prio) {
    const k = K(L, x, y); let r = irec.get(k);
    if (r) { r.used = frameNo; return r.p; }
    r = { L, x, y, state: 1, used: frameNo, tex: null, refs: 0 }; irec.set(k, r);
    r.path = `tiles/img/${L}/${x}_${y}.jpg`;
    r.p = Stream.image(r.path, prio).then((bmp) => {
      const t = new THREE.Texture(bmp); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = maxAniso; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
      r.texel = tileSize(L) / (bmp.width || 512);                               // metres per imagery texel
      t.onUpdate = () => { if (bmp.close) bmp.close(); t.onUpdate = null; };   // once on the GPU, drop the decoded CPU copy
      r.tex = t; r.bytes = bmp.width * bmp.height * 4 * 1.34; imgBytes += r.bytes; r.state = 2; stats.img++; return r;
    }, () => { r.state = 3; return r; });
    return r.p;
  }
  // finest ready record at or above (L,x,y) in a map; returns [rec, scale, offX, offY] mapping node uv -> data uv
  function finest(map, L, x, y, maxL) {
    let l = Math.min(L, maxL), xx = x >> (L - l), yy = y >> (L - l);
    for (; l >= 0; l--, xx >>= 1, yy >>= 1) {
      const r = map.get(K(l, xx, yy)); if (r && r.state === 2) { const d = L - l, s = 1 / (1 << d); return [r, s, (x - (xx << d)) * s, (y - (yy << d)) * s]; }
    }
    return null;
  }

  // ---------- shared geometry & material ----------
  let geo = null; const matPool = []; const nodes = [];
  function buildShared() {
    const pos = [], idx = []; const V = G + 1;
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) pos.push(i / G - 0.5, 0, j / G - 0.5);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { const a = j * V + i, b = a + 1, c = a + V, d = c + 1; idx.push(a, c, b, b, c, d); }
    const ring = []; for (let i = 0; i < G; i++) ring.push(i); for (let j = 0; j < G; j++) ring.push(j * V + G);
    for (let i = G; i > 0; i--) ring.push(G * V + i); for (let j = G; j > 0; j--) ring.push(j * V);
    const base = pos.length / 3; for (const r of ring) pos.push(pos[r * 3], 1, pos[r * 3 + 2]);
    for (let k = 0; k < ring.length; k++) { const a = ring[k], b = ring[(k + 1) % ring.length], a2 = base + k, b2 = base + (k + 1) % ring.length; idx.push(a, b, a2, b, b2, a2); }
    geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    try { maxAniso = Math.min(12, Env.renderer.capabilities.getMaxAnisotropy()); } catch (e) {}
  }
  const SKY_GLSL = () => (typeof Sky !== 'undefined' && Sky.glsl) ? Sky.glsl : '';
  // ---------- water: a tileable wind-wave slope map, LEAN-encoded (RG = mean slope, B = mean squared slope) ----------
  // ~70 directional waves with integer wavevectors (so the tile repeats seamlessly), a Phillips-like spectrum and
  // spreading around +x (downwind). B holds the squared slope, so mipmapping turns waves smaller than a pixel into
  // surface roughness: the sun glitter widens and dims with distance, as it does on the Bay, instead of sparkling.
  const WAVE_S = 3.0;                                  // RG range, in units of the per-axis rms slope
  let waveTex = null;
  function waveTexture() {
    if (waveTex) return waveTex;
    const N = 256, r = U.rng(7717), sx = new Float32Array(N * N), sy = new Float32Array(N * N);
    const ci = new Float32Array(N), si = new Float32Array(N), cj = new Float32Array(N), sj = new Float32Array(N);
    for (let n = 0; n < 72; n++) {
      const k = 2 + Math.pow(r(), 1.7) * 34;                           // cycles per tile, long waves favoured
      let th = (r() - 0.5) * 2.2; if (r() < 0.18) th += Math.PI;       // spread around downwind, a few running back
      const kx = Math.round(k * Math.cos(th)), ky = Math.round(k * Math.sin(th)); if (!kx && !ky) continue;
      const km = Math.hypot(kx, ky), cth = Math.cos(Math.atan2(ky, kx));
      const a = Math.pow(km, -1.45) * (0.25 + 0.75 * Math.max(cth, 0) ** 2) * (0.6 + 0.8 * r()), ph = r() * 6.2832, w = 6.2832 / N;
      for (let i = 0; i < N; i++) { ci[i] = Math.cos(kx * i * w); si[i] = Math.sin(kx * i * w); cj[i] = Math.cos(ky * i * w + ph); sj[i] = Math.sin(ky * i * w + ph); }
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {           // h = a cos(k.p + ph): slope = -a k sin(k.p + ph)
        const q = -a * (si[i] * cj[j] + ci[i] * sj[j]), o = j * N + i; sx[o] += q * kx; sy[o] += q * ky;
      }
    }
    let ss = 0; for (let o = 0; o < N * N; o++) ss += sx[o] * sx[o] + sy[o] * sy[o];
    const inv = 1 / Math.sqrt(ss / (2 * N * N)), d = new Uint8Array(N * N * 4), c8 = v => Math.max(0, Math.min(255, Math.round(v * 255)));
    for (let o = 0; o < N * N; o++) {
      const x = sx[o] * inv, y = sy[o] * inv;
      d[o * 4] = c8(x / WAVE_S * 0.5 + 0.5); d[o * 4 + 1] = c8(y / WAVE_S * 0.5 + 0.5); d[o * 4 + 2] = c8((x * x + y * y) / (2 * WAVE_S * WAVE_S)); d[o * 4 + 3] = 255;
    }
    const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.anisotropy = maxAniso; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
    return (waveTex = t);
  }
  // ---------- eye-level ground detail: four tileable grey-scale patterns in one mipmapped texture ----------
  // R asphalt (aggregate), G dirt (grit and pebbles), B grass (blades over soil), A concrete (speckle and voids): 512 px
  // over a 2.5 m tile (5 mm/px). Each channel has mean 0.5 and modulates the photo's local colour; mipmaps and
  // anisotropic filtering band-limit it at any distance.
  const GTILE = 2.5;
  let groundTex = null;
  function groundDetailTexture() {
    if (groundTex) return groundTex;
    const N = 512, M = N - 1, r = U.rng(4242), C = [0, 1, 2, 3].map(() => new Float32Array(N * N).fill(0.5));
    const vnoise = (a, cells, amp) => {                    // tileable smooth value noise with `cells` lattice cells per side
      const g = new Float32Array(cells * cells); for (let i = 0; i < g.length; i++) g[i] = r() * 2 - 1;
      for (let y = 0; y < N; y++) {
        const fy = y * cells / N, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty), r0 = (y0 % cells) * cells, r1 = ((y0 + 1) % cells) * cells;
        for (let x = 0; x < N; x++) {
          const fx = x * cells / N, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx), c0 = x0 % cells, c1 = (x0 + 1) % cells;
          a[y * N + x] += amp * ((g[r0 + c0] * (1 - sx) + g[r0 + c1] * sx) * (1 - sy) + (g[r1 + c0] * (1 - sx) + g[r1 + c1] * sx) * sy);
        }
      }
    };
    const grain = (a, amp) => { for (let i = 0; i < N * N; i++) a[i] += (r() * 2 - 1) * amp; };
    // soft-edged disc (wraps around the tile); dome > 0 brightens the middle (a rounded stone), ring > 0 adds a contact shadow
    const disc = (a, cx, cy, rad, v, dome = 0, ring = 0) => {
      const R = Math.ceil(rad + 2);
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy), o = ((cy + dy) & M) * N + ((cx + dx) & M);
        const w = Math.min(1, Math.max(0, rad + 0.5 - d));
        if (w > 0) a[o] += (v + dome * (1 - d / (rad + 0.5)) - a[o]) * w;
        else if (ring && d < rad + 2) a[o] -= ring * (1 - (d - rad - 0.5) / 1.5);
      }
    };
    const blade = (a, x, y, ang, len, v) => {              // one grass blade seen from above: a 1 px stroke, lighter at the tip
      const dx = Math.cos(ang), dy = Math.sin(ang);
      for (let t = 0; t < len; t++) { const o = ((Math.round(y + dy * t)) & M) * N + ((Math.round(x + dx * t)) & M); a[o] += (v + 0.12 * t / len - a[o]) * 0.85; }
    };
    const ri = () => Math.floor(r() * N);
    // R: asphalt — bitumen with light and dark aggregate, a few larger stones
    { const a = C[0]; vnoise(a, 4, 0.05); vnoise(a, 16, 0.04); grain(a, 0.05);
      for (let i = 0; i < 16000; i++) disc(a, ri(), ri(), 0.35 + r() * 1.1, r() < 0.68 ? 0.62 + 0.2 * r() : 0.3 + 0.1 * r());
      for (let i = 0; i < 700; i++) disc(a, ri(), ri(), 1.4 + r() * 1.5, 0.6 + 0.2 * r(), 0.05, 0.05); }
    // G: dirt — grit and pebbles with rounded tops and contact shadows over a mottled soil
    { const a = C[1]; vnoise(a, 3, 0.07); vnoise(a, 12, 0.06); vnoise(a, 48, 0.05); grain(a, 0.07);
      for (let i = 0; i < 14000; i++) disc(a, ri(), ri(), 0.35 + r() * 0.6, 0.5 + (r() - 0.5) * 0.36);
      for (let i = 0; i < 1100; i++) disc(a, ri(), ri(), 1.2 + Math.pow(r(), 2) * 5, 0.42 + 0.3 * r(), 0.1, 0.08); }
    // B: grass — soil showing between thousands of blades in every direction
    { const a = C[2]; a.fill(0.3); vnoise(a, 8, 0.05); grain(a, 0.04);
      for (let i = 0; i < 26000; i++) blade(a, r() * N, r() * N, r() * 6.2832, 5 + r() * 11, 0.48 + 0.3 * r()); }
    // A: concrete — fine speckle, air voids, faint trowel mottling
    { const a = C[3]; vnoise(a, 2, 0.035); vnoise(a, 10, 0.03); vnoise(a, 40, 0.02); grain(a, 0.03);
      for (let i = 0; i < 6000; i++) disc(a, ri(), ri(), 0.35 + r() * 0.55, r() < 0.6 ? 0.36 : 0.6); }
    const d = new Uint8Array(N * N * 4), sd = [0.085, 0.11, 0.13, 0.06];
    for (let c = 0; c < 4; c++) {
      const a = C[c]; let m = 0, v = 0; for (let i = 0; i < N * N; i++) m += a[i]; m /= N * N;
      for (let i = 0; i < N * N; i++) v += (a[i] - m) ** 2; const k = sd[c] / Math.sqrt(v / (N * N));
      for (let i = 0; i < N * N; i++) d[i * 4 + c] = Math.max(0, Math.min(255, Math.round(((a[i] - m) * k + 0.5) * 255)));
    }
    const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.anisotropy = maxAniso; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
    return (groundTex = t);
  }
  function makeMaterial() {
    const u = {
      hTex: { value: texFH }, hUV: { value: new THREE.Vector4(0, 0, 1, 1) }, hTC: { value: new THREE.Vector2(1, 0) }, hInfo: { value: new THREE.Vector3(0, 64, 1 / 1600) },
      iTex: { value: null }, iUV: { value: new THREE.Vector4(0, 0, 1, 1) }, iHas: { value: 0 }, iTexel: { value: 1.0 },
      mTex: { value: texFM }, mUV: { value: new THREE.Vector4(0, 0, 1, 1) }, mTC: { value: new THREE.Vector2(1, 0) },
      skirt: { value: 4 }, nodeSize: { value: 1000 }, night: U.uNight, time: U.uTime, uWaveN: { value: waveTexture() }, uWindW: U.uWind, uGround: { value: groundDetailTexture() },
    };
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0.0, envMapIntensity: 0.5 });
    m.userData.u = u;
    m.customProgramCacheKey = () => 'bayline-terrain-v2';
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D hTex; uniform vec4 hUV; uniform vec2 hTC; uniform vec3 hInfo; uniform float skirt;
          varying vec3 vW; varying vec2 vUV;`)
        .replace('#include <beginnormal_vertex>', `
          vec2 uvn = position.xz + 0.5;
          float hq = texture2D(hTex, (hUV.xy + uvn * hUV.zw) * hTC.x + hTC.y).r + hInfo.x;
          vec3 objectNormal = vec3(0.0, 1.0, 0.0);`)
        .replace('#include <begin_vertex>', `
          vec3 transformed = vec3(position.x, hq - position.y * skirt, position.z);
          vUV = uvn;`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vW = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D hTex; uniform vec4 hUV; uniform vec2 hTC; uniform vec3 hInfo;
          uniform sampler2D iTex; uniform vec4 iUV; uniform float iHas; uniform float iTexel;
          uniform sampler2D mTex; uniform vec4 mUV; uniform vec2 mTC; uniform float nodeSize;
          uniform float night; uniform float time; uniform sampler2D uWaveN; uniform float uWindW; uniform sampler2D uGround;
          varying vec3 vW; varying vec2 vUV;
          float th(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
          float tn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(th(i), th(i+vec2(1,0)), f.x), mix(th(i+vec2(0,1)), th(i+vec2(1,1)), f.x), f.y); }
          // band-limited noise: fades to its mean as the pattern nears the pixel footprint (fw = footprint in noise
          // units), so no term can alias into stripes or radial streaks at grazing angles
          float tnb(vec2 p, float fw) { return mix(0.5, tn(p), 1.0 - smoothstep(0.15, 0.4, fw)); }
          float thb(vec2 p, float fw) { return mix(0.5, th(floor(p)), 1.0 - smoothstep(0.06, 0.2, fw)); }
          vec3 gN; float gRough; vec3 gEmis; float gWater;
          // one wave layer: LEAN sample of the slope map in a frame rotated by (c, s); returns the slope rotated back
          // (xy) and the unresolved slope variance inside the pixel footprint (z)
          vec3 waveLayer(vec2 q, float c, float s, float size, float v) {
            vec4 w = texture2D(uWaveN, vec2(c * q.x + s * q.y, -s * q.x + c * q.y) / size - vec2(v, 0.0));
            vec2 m = (w.rg * 2.0 - 1.0) * ${WAVE_S.toFixed(1)};
            float vr = max(w.b * ${(2 * WAVE_S * WAVE_S).toFixed(1)} - dot(m, m), 0.0);
            return vec3(c * m.x - s * m.y, s * m.x + c * m.y, vr);
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            // ---- normal from the height data (per pixel) ----
            vec2 tc = (hUV.xy + vUV * hUV.zw) * hTC.x + hTC.y; float e = hInfo.z;
            float hl = texture2D(hTex, tc - vec2(e, 0.0)).r, hr = texture2D(hTex, tc + vec2(e, 0.0)).r;
            float hd = texture2D(hTex, tc - vec2(0.0, e)).r, hu = texture2D(hTex, tc + vec2(0.0, e)).r;
            vec3 nW = normalize(vec3(hl - hr, 2.0 * hInfo.y, hd - hu));
            vec4 mk = texture2D(mTex, (mUV.xy + vUV * mUV.zw) * mTC.x + mTC.y);
            float water = smoothstep(0.45, 0.6, mk.r);
            float dcam = distance(vW, cameraPosition);
            vec2 qdx = dFdx(vW.xz), qdy = dFdy(vW.xz);                         // taken here, outside any branch
            float fwq = abs(qdx.x) + abs(qdy.x) + abs(qdx.y) + abs(qdy.y);
            // ---- albedo: the photograph (or a quiet fallback before it streams in) ----
            vec3 col;
            if (iHas > 0.5) {
              vec2 iuv = iUV.xy + vUV * iUV.zw;
              col = texture2D(iTex, iuv).rgb;
              // eye level: the photo's baked-in cars, shadows and lines smear into blobs at grazing angles, so near a low
              // camera the ground becomes a synthesized surface (asphalt, concrete, grass, dry grass, dirt) whose colour is
              // the photo's local ~5 m average; aerial views keep the photograph untouched
              // only a camera at eye/cab height (walking, platforms, the cab) sees the smear; from trackside, chase and
              // helicopter heights the super-resolved photograph itself looks better, so it stays
              float lowCam = 1.0 - smoothstep(5.0, 16.0, cameraPosition.y - vW.y);
              float eye = lowCam * (1.0 - smoothstep(0.45, 0.6, mk.r));
              if (eye > 0.01) {
                vec3 lf = textureLod(iTex, iuv, clamp(log2(5.0 / iTexel), 0.0, 10.0)).rgb;
                vec3 lf2 = textureLod(iTex, iuv, clamp(log2(14.0 / iTexel), 0.0, 10.0)).rgb;   // wider context
                lf = mix(lf, lf2, 0.35);
                float lum = dot(lf, vec3(0.299, 0.587, 0.114));
                float sat = (max(lf.r, max(lf.g, lf.b)) - min(lf.r, min(lf.g, lf.b))) / max(lum, 0.03);
                float veg = smoothstep(-0.005, 0.03, lf.g - max(lf.r * 0.96, lf.b));
                float grey = 1.0 - smoothstep(0.1, 0.24, sat);
                vec2 q = vW.xz;
                // real surface texture: two rotated scales of the detail tile (no visible repeat), mip-filtered
                vec2 q2 = vec2(0.8 * q.x + 0.6 * q.y, -0.6 * q.x + 0.8 * q.y) / ${(GTILE * 2.9).toFixed(2)};
                vec2 q2dx = vec2(0.8 * qdx.x + 0.6 * qdx.y, -0.6 * qdx.x + 0.8 * qdx.y) / ${(GTILE * 2.9).toFixed(2)};
                vec2 q2dy = vec2(0.8 * qdy.x + 0.6 * qdy.y, -0.6 * qdy.x + 0.8 * qdy.y) / ${(GTILE * 2.9).toFixed(2)};
                vec4 gd = mix(textureGrad(uGround, q / ${GTILE.toFixed(1)}, qdx / ${GTILE.toFixed(1)}, qdy / ${GTILE.toFixed(1)}), textureGrad(uGround, q2, q2dx, q2dy), 0.38) - 0.5;
                // pavement: asphalt (dark) or concrete (light) with its aggregate and soft wear; the photo gives the tint
                float wear = tnb(q * 0.35, fwq * 0.35), asph = 1.0 - smoothstep(0.07, 0.2, lum);
                vec3 pave = lf * (1.0 + mix(gd.a * 1.3, gd.r * 1.8, asph) + 0.12 * (wear - 0.5));
                // vegetation: grass blades over soil, clumps, straw patches where the photo is golden
                float clump = tnb(q * 1.3, fwq * 1.3);
                vec3 grass = lf * (0.86 + 0.28 * clump) * (1.0 + gd.b * 1.9);
                grass = mix(grass, grass * vec3(1.08, 1.02, 0.86), smoothstep(0.5, 0.8, tnb(q * 0.23, fwq * 0.23)) * 0.6);
                // bare ground: soil with grit and pebbles
                vec3 dirt = lf * (0.9 + 0.2 * tnb(q * 1.9, fwq * 1.9)) * (1.0 + gd.g * 1.8);
                vec3 synth = mix(mix(dirt, pave, grey), grass, veg * (1.0 - grey * 0.6));
                col = mix(col, synth, eye * 0.96);
              }
            } else {
              float n1 = tn(vW.xz * 0.0015);
              col = mix(vec3(0.46, 0.39, 0.24), vec3(0.34, 0.36, 0.22), smoothstep(0.3, 0.7, n1));
              col = mix(col, vec3(0.36, 0.35, 0.33), smoothstep(0.1, 0.5, mk.g));
              col = mix(col, vec3(0.08, 0.16, 0.2), water);
            }
            // ---- near-camera detail so the photo never looks like a blurry decal ----
            float det = smoothstep(420.0, 25.0, dcam) * (1.0 - water);
            if (det > 0.0) {
              // surface-aware micro detail from the landcover class (mask A): each pattern fades before it can alias
              vec2 p = vW.xz; float cls = floor(mk.a * 255.0 + 0.5);
              float fw = fwq;
              float d1 = tnb(p * 1.7, fw * 1.7), d2 = tnb(p * 0.43, fw * 0.43);
              float gain = ((d1 - 0.5) * 0.18 + (d2 - 0.5) * 0.12) * det;          // broad variation everywhere
              float bump = 0.3, bf = 1.0 - smoothstep(0.07, 0.19, fw);
              if (cls > 5.5 && cls < 6.5) {                                       // pavement: asphalt grain, patching, cracks
                float g2 = tnb(p * 0.21, fw * 0.21);
                float ga = textureGrad(uGround, p / ${GTILE.toFixed(1)}, qdx / ${GTILE.toFixed(1)}, qdy / ${GTILE.toFixed(1)}).r - 0.5;
                gain += (ga * 0.9 + (g2 - 0.5) * 0.08) * det; bump = 0.12;
              } else if (cls < 0.5 || cls > 6.5) {                                // grass / natural / forest floor
                float b1 = tnb(p * 3.3, fw * 3.3), b2 = tnb(p * 11.0, fw * 11.0);
                gain += ((b1 - 0.5) * 0.16 + (b2 - 0.5) * 0.14) * det;
                col = mix(col, col * vec3(0.94, 1.05, 0.9), (b1 - 0.4) * 0.35 * det);   // green / straw variation
                bump = cls > 6.5 ? 0.55 : 0.45;
              } else if (cls > 0.5 && cls < 1.5) {                                // farmland: furrows
                float ang = floor(tn(floor(p / 160.0)) * 4.0) * 0.785; vec2 dr = vec2(cos(ang), sin(ang));
                gain += sin(dot(p, dr) * 6.2832 / 0.9) * 0.06 * (1.0 - smoothstep(0.1, 0.3, fw / 0.9)) * det; bump = 0.4;
              } else if (cls > 3.5 && cls < 4.5) {                               // sand
                gain += (thb(p * 14.0, fw * 14.0) - 0.5) * 0.08 * det; bump = 0.15;
              } else if (cls > 4.5 && cls < 5.5) {                               // rock
                gain += (tnb(p * 0.9, fw * 0.9) - 0.5) * 0.2 * det; bump = 0.7;
              }
              col *= 1.0 + gain;
              float a = tn(p * 2.1), b = tn((p + vec2(0.3, 0.0)) * 2.1), c = tn((p + vec2(0.0, 0.3)) * 2.1);
              nW = normalize(nW + vec3(a - b, 0.0, a - c) * bump * det * bf);
            }
            // ---- water: keep the photo's tint (South Bay silt, Pacific blue); wind waves from the LEAN slope map ----
            gWater = water;
            gRough = mix(0.93, 0.07, water);
            if (water > 0.0) {
              float hw = hInfo.x + texture2D(hTex, tc).r, depth = clamp(-hw, 0.0, 30.0);
              vec3 deep = vec3(0.035, 0.085, 0.11), shallow = col * 0.55;
              col = mix(col, mix(shallow, deep, smoothstep(0.0, 12.0, depth)), water * 0.8);
              // waves run downwind (the sea breeze pours ESE through the Golden Gate); gusts drift over the water as
              // patches of darker chop and glassy calm; waves die in the shallows; lakes and reservoirs stay calmer
              vec2 wd = vec2(0.8, 0.6), wq = vec2(dot(vW.xz, wd), dot(vW.xz, vec2(-wd.y, wd.x)));
              float gust = tn(wq / 460.0 - vec2(time * 0.011, 0.0)) * 0.65 + tn(wq / 110.0 - vec2(time * 0.045, 0.0)) * 0.35;
              float sea = 1.0 - step(1.0, hw);
              float amp = (0.35 + 1.25 * uWindW) * (0.3 + 1.4 * gust * gust) * mix(0.55, smoothstep(-0.3, 1.5, depth), sea);
              vec3 l1 = waveLayer(wq, 1.0, 0.0, 6.1, time * 0.26);
              vec3 l2 = waveLayer(wq, 0.94, 0.34, 19.0, time * 0.105);
              vec3 l3 = waveLayer(wq, 0.9, -0.44, 57.0, time * 0.052);
              vec3 a3 = vec3(0.058, 0.066, 0.05) * amp;                              // per-layer rms slope
              vec2 sw = l1.xy * a3.x + l2.xy * a3.y + l3.xy * a3.z;                   // resolved slope (wind frame)
              float vu = l1.z * a3.x * a3.x + l2.z * a3.y * a3.y + l3.z * a3.z * a3.z; // unresolved variance (both axes)
              sw = sw.x * wd + sw.y * vec2(-wd.y, wd.x);
              vec3 wn = normalize(vec3(-sw.x, 1.0, -sw.y));
              nW = normalize(mix(nW, wn, water));
              // GGX alpha^2 ~ total slope variance: sharp sparkles up close, a broad glitter path far away
              float alpha = sqrt(0.0007 * amp + vu);
              gRough = mix(0.93, sqrt(alpha), water);
            }
            // ---- night: the photo goes dark, streets and towns glow (mask G) ----
            // city lights from the air: a dim sodium/LED haze along lit areas plus sparse point lights; band-limited
            // so the points average out (no white sparkle) when many fall inside one pixel
            float gl = mk.g;
            float fwl = fwidth(vW.x) + fwidth(vW.z);
            float pts = smoothstep(0.86, 0.98, th(floor(vW.xz / 11.0))) * smoothstep(0.2, 0.7, gl);
            float ptsAvg = 0.07 * smoothstep(0.2, 0.7, gl);                                  // mean of the point field
            pts = mix(pts, ptsAvg, smoothstep(3.0, 11.0, fwl));
            vec3 lamp = mix(vec3(1.0, 0.62, 0.3), vec3(0.95, 0.9, 0.82), step(0.55, th(floor(vW.xz / 180.0))));   // sodium / LED districts
            gEmis = lamp * (pow(gl, 1.8) * 0.16 + pts * 1.1) * night * (1.0 - water) * smoothstep(120.0, 900.0, dcam);
            diffuseColor.rgb = col;
            gN = nW;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = gRough;`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += gEmis;`)
        .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
          #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
            radiance *= 1.0 + gWater;
          #endif`);
    };
    return m;
  }
  function getNode(i) {
    let n = nodes[i];
    if (!n) { const mat = makeMaterial(); const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false; mesh.matrixAutoUpdate = false; group.add(mesh); n = nodes[i] = { mesh, mat, u: mat.userData.u }; }
    return n;
  }

  // ---------- per-frame quadtree ----------
  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), box = new THREE.Box3(), cp = new THREE.Vector3();
  const sel = [];
  function hRange(L, x, y) { // conservative min/max of a node from the finest loaded height data
    const f = finest(hrec, L, x, y, LH); if (f) return [f[0].mn - 2, f[0].mx + 2];
    return [-120, 1500];
  }
  function nodeWanted(L, x, y) {         // is there any data finer than L-1 here (so splitting helps)?
    if (!index) return L <= 5;
    return exists(L, x, y);
  }
  function update(cam) {
    if (!ready) return; frameNo++;
    cp.copy(cam.position);
    pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); frustum.setFromProjectionMatrix(pm);
    const k = lodFactor.value; sel.length = 0;
    const stack = [[0, 0, 0]];
    while (stack.length) {
      const [L, x, y] = stack.pop(); const T = tileSize(L); const x0 = X0 + x * T, z0 = Z0 + y * T;
      const [mn, mx] = hRange(L, x, y);
      box.min.set(x0, mn - 30, z0); box.max.set(x0 + T, mx + 5, z0 + T);
      if (!frustum.intersectsBox(box)) continue;
      const dx = Math.max(x0 - cp.x, 0, cp.x - (x0 + T)), dz = Math.max(z0 - cp.z, 0, cp.z - (z0 + T)), dy = Math.max(mn - cp.y, 0, cp.y - mx);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1;
      // imagery-only levels (L8+ share the L7 heights) are cheap, so refine them farther out: crisp ground to ~200 m
      let split = L < LMAX && T / d > (L >= 8 ? k * 0.5 : k);
      if (split) {
        const kids = [[L + 1, 2 * x, 2 * y], [L + 1, 2 * x + 1, 2 * y], [L + 1, 2 * x, 2 * y + 1], [L + 1, 2 * x + 1, 2 * y + 1]];
        const any = kids.some(c => nodeWanted(c[0], c[1], c[2]));
        if (any) { for (const c of kids) { if (nodeWanted(c[0], c[1], c[2])) stack.push(c); else sel.push([c[0], c[1], c[2], d]); } continue; }
      }
      sel.push([L, x, y, d]);
    }
    // assign nodes, request data
    const cap = Math.min(sel.length, 900); stats.nodes = cap;
    for (let i = 0; i < cap; i++) {
      const [L, x, y, d] = sel[i]; const n = getNode(i); const T = tileSize(L); const u = n.u;
      n.mesh.visible = true;
      n.mesh.matrix.makeScale(T, 1, T); n.mesh.matrix.setPosition(X0 + (x + 0.5) * T, 0, Z0 + (y + 0.5) * T); n.mesh.matrixWorldNeedsUpdate = true;
      const prio = 2 + Math.min(40, d / 800) + (L < 3 ? -2 : 0);
      if (index) { // request this node's own data (the quadtree only visits nodes that exist)
        if (exists(L, x, y)) { needImg(L, x, y, prio); if (L <= LH) { needHgt(L, x, y, prio + 0.5); needMsk(L, x, y, prio + 1); } else { const p = L - LH; needHgt(LH, x >> p, y >> p, prio + 0.5); needMsk(LH, x >> p, y >> p, prio + 1); } }
      }
      // heights
      const fh = index ? finest(hrec, L, x, y, LH) : null;
      if (fh) { const [r, s, ox, oy] = fh; r.used = frameNo; u.hTex.value = r.tex; u.hUV.value.set(ox, oy, s, s); u.hTC.value.set(128 / 129, 0.5 / 129); u.hInfo.value.set(r.base, tileSize(r.L) / 128, 1 / 129); }
      else { const n2 = 1 << L; const sc = SIZE / ((N - 1) * S); u.hTex.value = texFH; u.hUV.value.set(x / n2 * sc, y / n2 * sc, sc / n2, sc / n2); u.hTC.value.set((N - 1) / N, 0.5 / N); u.hInfo.value.set(0, S, 1 / N); }
      // masks
      const fm = index ? finest(mrec, L, x, y, LH) : null;
      if (fm) { const [r, s, ox, oy] = fm; r.used = frameNo; u.mTex.value = r.tex; u.mUV.value.set(ox, oy, s, s); u.mTC.value.set(1, 0); }
      else { const n2 = 1 << L; const sc = SIZE / ((N - 1) * S); u.mTex.value = texFM; u.mUV.value.set(x / n2 * sc, y / n2 * sc, sc / n2, sc / n2); u.mTC.value.set((N - 1) / N, 0.5 / N); }
      // imagery
      const fi = index ? finest(irec, L, x, y, LMAX) : null;
      if (fi) { const [r, s, ox, oy] = fi; u.iTex.value = r.tex; u.iUV.value.set(ox, oy, s, s); u.iHas.value = 1; u.iTexel.value = r.texel || 1; r.used = frameNo; }
      else { u.iHas.value = 0; u.iTex.value = null; }
      u.skirt.value = Math.max(2, T / 64 * 0.8); u.nodeSize.value = T;
    }
    for (let i = cap; i < nodes.length; i++) if (nodes[i]) nodes[i].mesh.visible = false;
    if ((frameNo & 31) === 0) evict();
  }
  // ---------- LRU eviction ----------
  const CAP = { img: 300, hgt: 700, msk: 500 }, IMG_BUDGET = 520e6;   // imagery: count cap AND a GPU-memory budget
  let imgBytes = 0;
  function evictMap(map, cap, dispose, over) {
    if (map.size <= cap && !(over && over())) return;
    const arr = [...map.values()].filter(r => r.state !== 1 && r.L > 2 && !(r.refs > 0) && r.used < frameNo - 30).sort((a, b) => a.used - b.used);
    for (let i = 0; i < arr.length && (map.size > cap || (over && over())); i++) { const r = arr[i]; if (r.state === 1) continue; dispose(r); map.delete(K(r.L, r.x, r.y)); stats.evicted++; }
  }
  function evict() {
    evictMap(irec, CAP.img, r => { if (r.tex) r.tex.dispose(); imgBytes -= r.bytes || 0; }, () => imgBytes > IMG_BUDGET);
    stats.imgMB = Math.round(imgBytes / 1e6);
    evictMap(hrec, CAP.hgt, r => { if (r.tex) r.tex.dispose(); });
    evictMap(mrec, CAP.msk, r => { if (r.tex) r.tex.dispose(); });
    // drop queued requests nobody wants any more
    for (const map of [irec, hrec, mrec]) for (const r of map.values()) if (r.state === 1 && r.used < frameNo - 90 && r.L > 2) { Stream.cancel(r.path); }
  }

  // ---------- queries ----------
  function fallbackH(x, z) {
    if (!heights) return 0;
    let fx = (x - FX0) / S, fz = (z - FZ0) / S;
    fx = fx < 0 ? 0 : fx > N - 1.001 ? N - 1.001 : fx; fz = fz < 0 ? 0 : fz > N - 1.001 ? N - 1.001 : fz;
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * N + i;
    return heights[k] * (1 - tx) * (1 - tz) + heights[k + 1] * tx * (1 - tz) + heights[k + N] * (1 - tx) * tz + heights[k + N + 1] * tx * tz;
  }
  function h(x, z) {
    if (index) {
      const T7 = tileSize(LH); let tx = Math.floor((x - X0) / T7), ty = Math.floor((z - Z0) / T7);
      for (let L = LH; L >= 0; L--, tx >>= 1, ty >>= 1) {
        const r = hrec.get(K(L, tx, ty)); if (!r || r.state !== 2) continue;
        const T = tileSize(L); let fx = (x - X0 - tx * T) / T * 128, fz = (z - Z0 - ty * T) / T * 128;
        fx = fx < 0 ? 0 : fx > 127.999 ? 127.999 : fx; fz = fz < 0 ? 0 : fz > 127.999 ? 127.999 : fz;
        const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * HS + i, H = r.h;
        return H[k] * (1 - u) * (1 - v) + H[k + 1] * u * (1 - v) + H[k + HS] * (1 - u) * v + H[k + HS + 1] * u * v;
      }
    }
    return fallbackH(x, z);
  }
  // L7 tiles (or the finest existing level) needed for a rectangle
  function detailTiles(x0, z0, x1, z1) {
    const out = []; if (!index) return out; const T7 = tileSize(LH);
    const a = Math.floor((Math.min(x0, x1) - X0) / T7), b = Math.floor((Math.max(x0, x1) - X0) / T7), c = Math.floor((Math.min(z0, z1) - Z0) / T7), d = Math.floor((Math.max(z0, z1) - Z0) / T7);
    const seen = new Set();
    for (let ty = c; ty <= d; ty++) for (let tx = a; tx <= b; tx++) {
      let L = LH, x = tx, y = ty; while (L > 5 && !exists(L, x, y)) { L--; x >>= 1; y >>= 1; }
      if (x < 0 || y < 0 || x >= (1 << L) || y >= (1 << L)) continue;
      const k = K(L, x, y); if (!seen.has(k)) { seen.add(k); out.push([L, x, y]); }
    }
    return out;
  }
  function hasDetail(x0, z0, x1, z1) { if (!index) return true; for (const [L, x, y] of detailTiles(x0, z0, x1, z1)) { const r = hrec.get(K(L, x, y)); if (!r || (r.state !== 2 && r.state !== 3)) return false; } return true; }
  function ensure(x0, z0, x1, z1, prio = 3) {
    if (!index) return Promise.resolve();
    return Promise.all(detailTiles(x0, z0, x1, z1).map(([L, x, y]) => needHgt(L, x, y, prio))).then(() => {});
  }
  // finest loaded imagery covering (x,z), optionally capped at level maxL (callers that map one texture onto a fixed
  // area, like the photo roofs of an 800 m town tile's 400 m quadrants, pass maxL = 8)
  function imagery(x, z, maxL = LMAX) {
    if (!index) return null; const Lt = Math.min(LMAX, maxL); const Tt = tileSize(Lt); let tx = Math.floor((x - X0) / Tt), ty = Math.floor((z - Z0) / Tt);
    for (let L = Lt; L >= 0; L--, tx >>= 1, ty >>= 1) { const r = irec.get(K(L, tx, ty)); if (r && r.state === 2) { const T = tileSize(L); return { tex: r.tex, x0: X0 + tx * T, z0: Z0 + ty * T, size: T, L, texel: r.texel || T / 512 }; } }
    return null;
  }
  function retain(tex) { for (const r of irec.values()) if (r.tex === tex) { r.refs = (r.refs || 0) + 1; return; } }
  function release(tex) { for (const r of irec.values()) if (r.tex === tex) { r.refs = Math.max(0, (r.refs || 0) - 1); return; } }
  function maskAt(x, z, ch) {
    if (index) {
      const T7 = tileSize(LH); let tx = Math.floor((x - X0) / T7), ty = Math.floor((z - Z0) / T7);
      for (let L = LH; L >= 0; L--, tx >>= 1, ty >>= 1) {
        const r = mrec.get(K(L, tx, ty)); if (!r || r.state !== 2) continue;
        const T = tileSize(L); const i = U.clamp(Math.floor((x - X0 - tx * T) / T * MS), 0, MS - 1), j = U.clamp(Math.floor((z - Z0 - ty * T) / T * MS), 0, MS - 1);
        return r.m[(j * MS + i) * 4 + ch] / 255;
      }
    }
    if (!mask) return 0; const i = U.clamp(Math.round((x - FX0) / S), 0, N - 1), j = U.clamp(Math.round((z - FZ0) / S), 0, N - 1);
    return mask[(j * N + i) * 4 + ch] / 255;
  }
  const isWater = (x, z) => maskAt(x, z, 0) > 0.5;
  const urbanAt = (x, z) => { const v = maskAt(x, z, 1); return v; };
  function setTownFade() {}
  return { load, h, hasDetail, ensure, imagery, retain, release, isWater, urbanAt, maskAt, update, setTownFade, lodFactor, stats, group,
    get mesh() { return group; }, get info() { return { N, S, X0: FX0, Z0: FZ0 }; }, get tiled() { return !!index; }, tileSize, TILE: { X0, Z0, SIZE, LMAX, LH } };
})();
