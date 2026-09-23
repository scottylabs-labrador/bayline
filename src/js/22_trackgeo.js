// Railway corridor, photoreal (v2). Ballast with per-stone shading and brake-dust rust, concrete ties with
// Pandrol clips, 136RE rails with a polished running band, cant on curves, turnouts where tracks branch,
// 2×25 kV overhead catenary (H-beam and tubular poles, cantilevers, insulators, messenger + contact wire with
// droppers, feeders, portal gantries, tunnel supports), right-of-way fences, cable troughs, mileposts,
// whistle posts, bungalows and relay cases, the 1907 tunnels with portals, bridges by type, grade crossings
// (gates with lamps, flashers, bells, crossbucks, pedestrian gates, crossing panels and ramps, stop lines, RXR)
// and color-light signals (mast or signal bridge) driven by train occupancy.
// Streamed in 400 m chunks: a far layer (bed + structures) within 3.6 km once the fine terrain is in, and a
// near layer (rails, droppers, fences, small details) within 1.5 km. Build work is time-sliced (≤ 3 ms/frame).
// No floor()-hashed world noise anywhere: every procedural pattern is smooth or cell-shaded with derivative
// based fading, so nothing bands at grazing angles.
// API (unchanged): init, update(camPos, dt), updateDynamic(dt, trains, camPos), crossingsNear, nextSignal,
//                  prebuild, group, bedSpan.
const TrackGeo = (() => {
  const CH = 400, NEAR = 3600, FAR = 4600, DETAIL_IN = 1500, DETAIL_OUT = 2100, XING_IN = 1800, XING_OUT = 2600;
  const RC = 0.7545, TIE = 0.6096, TIE_HALF = 1.3, BUDGET = 3;
  const group = new THREE.Group(); group.name = 'trackgeo';
  const chunks = new Map();
  const F = {}, F2 = {}, F3 = {};
  const HCW = () => (typeof TrainKit !== 'undefined' && TrainKit.PANTO_UP_Y) || 5.9;     // contact wire = raised pantograph

  // ---------- palette: [r, g, b (linear), roughness, metalness] ----------
  const _c = new THREE.Color();
  const P = (hex, rough, metal) => { _c.setHex(hex); return [_c.r, _c.g, _c.b, rough, metal]; };
  const PAL = {
    concrete: P(0xaca79e, 0.88, 0), concreteOld: P(0x928d84, 0.9, 0), concreteDark: P(0x6f6a63, 0.92, 0), stone: P(0xa99f8f, 0.86, 0),
    galv: P(0xa3a8ac, 0.42, 0.85), galvDark: P(0x80858a, 0.5, 0.8), steel: P(0x3e423f, 0.62, 0.5), steelGreen: P(0x384238, 0.6, 0.45),
    insul: P(0x55595e, 0.42, 0.0), insulBrown: P(0x6e3a22, 0.22, 0.0), copper: P(0x6f5139, 0.36, 0.9), feeder: P(0x7d7f80, 0.4, 0.85),
    railRust: P(0x5e4232, 0.8, 0.35), railSide: P(0x77695f, 0.5, 0.65), railTop: P(0xcfd3d8, 0.12, 1.0),
    clip: P(0x2c2e30, 0.55, 0.6), pad: P(0x131313, 0.92, 0.0), shoulder: P(0x4a4643, 0.7, 0.55), tie: P(0xa6a299, 0.9, 0.0),
    black: P(0x121315, 0.62, 0.1), white: P(0xe8e8e3, 0.5, 0.0), red: P(0xb1151a, 0.42, 0.05), yellow: P(0xd8a51c, 0.5, 0.05),
    bungalow: P(0xb9bab4, 0.55, 0.35), roof: P(0x8a8d8f, 0.5, 0.6), fence: P(0x8b9094, 0.45, 0.6), asphalt: P(0x5c5a56, 0.93, 0.0),
    rubber: P(0x151515, 0.9, 0.0), lensRed: P(0x2a0604, 0.18, 0.0), lensWarm: P(0x6b5a3e, 0.3, 0.0), tunnel: P(0x6f6a62, 0.94, 0.0),
    grate: P(0x55595c, 0.55, 0.7), signPlate: P(0xd9d9d2, 0.45, 0.3), backPlate: P(0x7a7d80, 0.5, 0.6),
  };

  // ---------- geometry builder: positions, normals, colours, (roughness, metalness, tunnel darkness), atlas uvs, lamp ids ----------
  const WU = 0.0305, WV = 0.9695;            // pure-white texel of the atlas
  class MB {
    constructor() { this.p = []; this.n = []; this.c = []; this.m = []; this.u = []; this.l = []; this.i = []; this.dark = 0; this.lamp = 0; }
    get count() { return this.p.length / 3; }
    v(x, y, z, nx, ny, nz, C, u = WU, vv = WV) {
      this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(C[0], C[1], C[2]); this.m.push(C[3], C[4], this.dark); this.u.push(u, vv); this.l.push(this.lamp);
      return this.p.length / 3 - 1;
    }
    q(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
    // oriented box: centre, right-handed unit axes (ax, ay, az = ax × ay), half extents
    box(cx, cy, cz, ax, ay, az, hx, hy, hz, C, skipBottom) {
      const A = [ax, ay, az], H = [hx, hy, hz];
      for (let f = 0; f < 6; f++) {
        const fb = BOXF[f], na = fb[0], sn = fb[1], ua = fb[2], va = fb[3]; if (skipBottom && na === 1 && sn < 0) continue;
        const N = A[na], Uv = A[ua], Vv = A[va];
        const nx = N[0] * sn, ny = N[1] * sn, nz = N[2] * sn;
        const bx = cx + nx * H[na], by = cy + ny * H[na], bz = cz + nz * H[na];
        const b = this.count;
        for (let k = 0; k < 4; k++) { const su = QC[k][0], sv = QC[k][1]; this.v(bx + Uv[0] * su * H[ua] + Vv[0] * sv * H[va], by + Uv[1] * su * H[ua] + Vv[1] * sv * H[va], bz + Uv[2] * su * H[ua] + Vv[2] * sv * H[va], nx, ny, nz, C); }
        this.q(b, b + 1, b + 2, b + 3);
      }
    }
    // cylinder from A to B (radius r0 at A, r1 at B), n sides, optional caps
    cyl(ax, ay, az, bx, by, bz, r0, r1, n, C, capA, capB) {
      let wx = bx - ax, wy = by - ay, wz = bz - az; const L = Math.hypot(wx, wy, wz) || 1; wx /= L; wy /= L; wz /= L;
      let hx = 0, hy = 1, hz = 0; if (Math.abs(wy) > 0.9) { hx = 1; hy = 0; }
      let ux = hy * wz - hz * wy, uy = hz * wx - hx * wz, uz = hx * wy - hy * wx; const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      const vx = wy * uz - wz * uy, vy = wz * ux - wx * uz, vz = wx * uy - wy * ux;
      const b = this.count;
      for (let k = 0; k <= n; k++) {
        const t = k / n * Math.PI * 2, co = Math.cos(t), si = Math.sin(t);
        const dx = ux * co + vx * si, dy = uy * co + vy * si, dz = uz * co + vz * si;
        this.v(ax + dx * r0, ay + dy * r0, az + dz * r0, dx, dy, dz, C); this.v(bx + dx * r1, by + dy * r1, bz + dz * r1, dx, dy, dz, C);
      }
      for (let k = 0; k < n; k++) { const a0 = b + 2 * k, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3; this.q(a0, a1, b1, b0); }
      const cap = (px, py, pz, r, s) => { const c0 = this.v(px, py, pz, wx * s, wy * s, wz * s, C); const rb = this.count;
        for (let k = 0; k <= n; k++) { const t = k / n * Math.PI * 2, co = Math.cos(t), si = Math.sin(t); this.v(px + (ux * co + vx * si) * r, py + (uy * co + vy * si) * r, pz + (uz * co + vz * si) * r, wx * s, wy * s, wz * s, C); }
        for (let k = 0; k < n; k++) { if (s > 0) this.i.push(c0, rb + k, rb + k + 1); else this.i.push(c0, rb + k + 1, rb + k); } };
      if (capB) cap(bx, by, bz, r1, 1); if (capA) cap(ax, ay, az, r0, -1);
    }
    // tube along a polyline pts = [x,y,z, x,y,z, ...] with n sides
    tube(pts, r, n, C) {
      const m = pts.length / 3; if (m < 2) return; const b = this.count;
      for (let i = 0; i < m; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(m - 1, i + 1);
        let wx = pts[i1 * 3] - pts[i0 * 3], wy = pts[i1 * 3 + 1] - pts[i0 * 3 + 1], wz = pts[i1 * 3 + 2] - pts[i0 * 3 + 2]; const L = Math.hypot(wx, wy, wz) || 1; wx /= L; wy /= L; wz /= L;
        let hx = 0, hy = 1, hz = 0; if (Math.abs(wy) > 0.9) { hx = 1; hy = 0; }
        let ux = hy * wz - hz * wy, uy = hz * wx - hx * wz, uz = hx * wy - hy * wx; const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
        const vx = wy * uz - wz * uy, vy = wz * ux - wx * uz, vz = wx * uy - wy * ux;
        for (let k = 0; k <= n; k++) { const t = k / n * Math.PI * 2, co = Math.cos(t), si = Math.sin(t); const dx = ux * co + vx * si, dy = uy * co + vy * si, dz = uz * co + vz * si;
          this.v(pts[i * 3] + dx * r, pts[i * 3 + 1] + dy * r, pts[i * 3 + 2] + dz * r, dx, dy, dz, C); }
        if (i > 0) for (let k = 0; k < n; k++) { const a0 = b + (i - 1) * (n + 1) + k, a1 = a0 + 1, b0 = a0 + n + 1, b1 = b0 + 1; this.q(a0, a1, b1, b0); }
      }
    }
    // textured quad: centre, unit axes (ux right, vy up), half sizes, uv rect [u0,v0,u1,v1]; normal = ux × vy
    quadUV(cx, cy, cz, ux, vy, hw, hh, R, C) {
      const nx = ux[1] * vy[2] - ux[2] * vy[1], ny = ux[2] * vy[0] - ux[0] * vy[2], nz = ux[0] * vy[1] - ux[1] * vy[0];
      const b = this.count;
      this.v(cx - ux[0] * hw - vy[0] * hh, cy - ux[1] * hw - vy[1] * hh, cz - ux[2] * hw - vy[2] * hh, nx, ny, nz, C, R[0], R[1]);
      this.v(cx + ux[0] * hw - vy[0] * hh, cy + ux[1] * hw - vy[1] * hh, cz + ux[2] * hw - vy[2] * hh, nx, ny, nz, C, R[2], R[1]);
      this.v(cx + ux[0] * hw + vy[0] * hh, cy + ux[1] * hw + vy[1] * hh, cz + ux[2] * hw + vy[2] * hh, nx, ny, nz, C, R[2], R[3]);
      this.v(cx - ux[0] * hw + vy[0] * hh, cy - ux[1] * hw + vy[1] * hh, cz - ux[2] * hw + vy[2] * hh, nx, ny, nz, C, R[0], R[3]);
      this.q(b, b + 1, b + 2, b + 3);
    }
    // sweep flat-shaded cross-section segments along s: segFn(s, F) -> [[l0, y0, l1, y1, C], ...]
    // (rows with a different segment count start a new strip)
    sweep(ss, segFn, ox, oz, flip, darkFn) {
      let prev = -1, nseg = -1;
      for (let i = 0; i < ss.length; i++) {
        const s = ss[i]; Track.frame(s, F); const segs = segFn(s, F); if (!segs) { prev = -1; continue; }
        if (darkFn) this.dark = darkFn(s);
        const base = this.count; const rx = F.rx, rz = F.rz;
        for (const g of segs) {
          const l0 = g[0], y0 = g[1], l1 = g[2], y1 = g[3], C = g[4];
          let nl = -(y1 - y0), ny = l1 - l0; const L = Math.hypot(nl, ny) || 1; nl /= L; ny /= L; if (flip) { nl = -nl; ny = -ny; }
          this.v(F.x + rx * l0 - ox, F.y + y0, F.z + rz * l0 - oz, rx * nl, ny, rz * nl, C);
          this.v(F.x + rx * l1 - ox, F.y + y1, F.z + rz * l1 - oz, rx * nl, ny, rz * nl, C);
        }
        if (prev >= 0 && segs.length === nseg) for (let k = 0; k < segs.length; k++) {
          const a0 = prev + 2 * k, b0 = a0 + 1, a1 = base + 2 * k, b1 = a1 + 1;
          if (flip) this.i.push(a0, a1, b0, b0, a1, b1); else this.i.push(a0, b0, a1, b0, b1, a1);
        }
        prev = base; nseg = segs.length;
      }
      this.dark = 0;
    }
    geometry() {
      if (!this.i.length) return null;
      const g = new THREE.BufferGeometry(); const nv = this.count;
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3)); g.setAttribute('aRM', new THREE.Float32BufferAttribute(this.m, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2)); g.setAttribute('aLamp', new THREE.Float32BufferAttribute(this.l, 1));
      g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
      g.computeBoundingSphere(); return g;
    }
  }
  const QC = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  // box faces: [normal axis, sign, u axis, v axis] with u × v = sign · normal
  const BOXF = [[0, 1, 1, 2], [0, -1, 2, 1], [1, 1, 2, 0], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 1, 0]];
  const UP = [0, 1, 0];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const neg3 = (a) => [-a[0], -a[1], -a[2]];

  // ---------- materials ----------
  const M = {};
  const lampUniforms = () => ({ uActive: { value: 0 }, uNight: U.uNight, uTime: U.uTime });
  function infraMaterial(double) {
    const u = lampUniforms();
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: atlas, alphaTest: 0.5, roughness: 1, metalness: 1, side: double ? THREE.DoubleSide : THREE.FrontSide });
    m.userData.u = u; m.customProgramCacheKey = () => 'bl-infra' + (double ? '2' : '');
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 aRM; attribute float aLamp; varying vec3 vRM; varying float vLamp; varying vec3 vWp;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vRM = aRM; vLamp = aLamp;
          if (aLamp > 8.5) { vec4 wc = modelMatrix * vec4(transformed, 1.0); float dc = distance(wc.xyz, cameraPosition);
            transformed += objectNormal * max(0.0, 0.00062 * dc - 0.006); }`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          { vec4 wq = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
              wq = instanceMatrix * wq;
            #endif
            vWp = (modelMatrix * wq).xyz; }`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uActive; uniform float uNight; uniform float uTime; varying vec3 vRM; varying float vLamp; varying vec3 vWp;
          float ih3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
          float in3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
            return mix(mix(mix(ih3(i), ih3(i+vec3(1,0,0)), f.x), mix(ih3(i+vec3(0,1,0)), ih3(i+vec3(1,1,0)), f.x), f.y),
                       mix(mix(ih3(i+vec3(0,0,1)), ih3(i+vec3(1,0,1)), f.x), mix(ih3(i+vec3(0,1,1)), ih3(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          { float fw = fwidth(vWp.x) + fwidth(vWp.y) + fwidth(vWp.z);
            float w = in3(vWp * 0.31) * 0.6 + mix(in3(vWp * 2.7), 0.5, smoothstep(0.02, 0.12, fw)) * 0.4;
            diffuseColor.rgb *= 0.9 + 0.18 * w; }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = clamp(vRM.x + (in3(vWp * 3.3) - 0.5) * 0.12 * step(0.2, vRM.x), 0.05, 1.0);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
          metalnessFactor = vRM.y;`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          { float dk = 1.0 - 0.965 * vRM.z; reflectedLight.directDiffuse *= dk; reflectedLight.directSpecular *= dk; reflectedLight.indirectDiffuse *= dk; reflectedLight.indirectSpecular *= dk * dk; }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          if (vLamp > 0.5 && vLamp < 8.5) {
            float ph = step(0.5, fract(uTime * 0.92)); float on = 0.0; vec3 lc = vec3(1.0, 0.06, 0.02);
            if (vLamp < 1.5) on = uActive * ph; else if (vLamp < 2.5) on = uActive * (1.0 - ph); else if (vLamp < 3.5) on = uActive;
            else if (vLamp < 4.5) { on = 1.0; lc = vec3(1.0, 0.84, 0.6); } else { on = uNight; lc = vec3(1.0, 0.72, 0.4); }
            totalEmissiveRadiance += lc * on * 7.0;
          }`);
    };
    return m;
  }
  // ballast / cess / skirt bed: per-stone (voronoi) shading with a stone bump that fades out by ~1–4 cm per
  // pixel, brake-dust rust near the rails, ties and rails painted in at distance (geometry covers them up
  // close), smooth value noise for soil and deck, tunnel darkness. No axis-aligned block noise.
  // Ballast stone texture: a tileable 512² canvas of packed, angular stones (granite greys, dark trap rock, a few
  // warm and quartz stones) with cavity darkening, plus a matching height map. Sampled with world-planar UVs and
  // full mipmaps + anisotropy, so it filters cleanly at every distance (no procedural aliasing or banding).
  function ballastTextures() {
    const S = 512, rnd = U.rng(90723);
    const mk = () => { const cv = document.createElement('canvas'); cv.width = cv.height = S; return cv; };
    const cc = mk(), hc = mk(); const c = cc.getContext('2d'), h = hc.getContext('2d');
    c.fillStyle = '#2d2b27'; c.fillRect(0, 0, S, S); h.fillStyle = '#000'; h.fillRect(0, 0, S, S);
    const stones = [];
    for (let k = 0; k < 1100; k++) {
      const r = 9 + rnd() * 12, el = 0.62 + rnd() * 0.36, rot = rnd() * 6.283, nv = 5 + Math.floor(rnd() * 4), pts = [];
      for (let i = 0; i < nv; i++) { const a = i / nv * 6.283 + (rnd() - 0.5) * 0.7, rr = r * (0.78 + rnd() * 0.28); const lx = Math.cos(a) * rr, ly = Math.sin(a) * rr * el; pts.push([lx * Math.cos(rot) - ly * Math.sin(rot), lx * Math.sin(rot) + ly * Math.cos(rot)]); }
      const t = rnd(); let b;
      if (t < 0.58) { const g = 128 + rnd() * 46; b = [g + rnd() * 9, g + rnd() * 6, g - 3 + rnd() * 6]; }
      else if (t < 0.84) { const g = 86 + rnd() * 34; b = [g, g + 2, g + 5]; }
      else if (t < 0.94) b = [150 + rnd() * 30, 128 + rnd() * 24, 104 + rnd() * 20];
      else b = [182 + rnd() * 30, 178 + rnd() * 30, 170 + rnd() * 28];
      stones.push({ x: rnd() * S, y: rnd() * S, r, pts, b });
    }
    const draw = (st, X, Y) => {
      const path = () => { c.beginPath(); st.pts.forEach((p, i) => i ? c.lineTo(X + p[0], Y + p[1]) : c.moveTo(X + p[0], Y + p[1])); c.closePath(); };
      path(); c.fillStyle = `rgb(${st.b[0] | 0},${st.b[1] | 0},${st.b[2] | 0})`; c.fill();
      const g = c.createRadialGradient(X - st.r * 0.25, Y - st.r * 0.25, st.r * 0.1, X, Y, st.r * 1.1);
      g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.55, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.42)');
      path(); c.fillStyle = g; c.fill();
      c.strokeStyle = 'rgba(20,18,15,0.55)'; c.lineWidth = 1.3; path(); c.stroke();
      h.beginPath(); st.pts.forEach((p, i) => i ? h.lineTo(X + p[0], Y + p[1]) : h.moveTo(X + p[0], Y + p[1])); h.closePath();
      const hg = h.createRadialGradient(X, Y, 0, X, Y, st.r); hg.addColorStop(0, '#fff'); hg.addColorStop(0.7, '#9a9a9a'); hg.addColorStop(1, '#383838'); h.fillStyle = hg; h.fill();
    };
    for (const st of stones) for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) { const X = st.x + dx, Y = st.y + dy; if (X > -30 && X < S + 30 && Y > -30 && Y < S + 30) draw(st, X, Y); }
    // speckle (mica / lichen) for close-up grain
    for (let k = 0; k < 9000; k++) { c.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.09)'; c.fillRect(rnd() * S, rnd() * S, 1.2, 1.2); }
    const d = c.getImageData(0, 0, S, S).data; let mr = 0, mg = 0, mb = 0; const lin = (v) => Math.pow(v / 255, 2.2);
    for (let i = 0; i < d.length; i += 64) { mr += lin(d[i]); mg += lin(d[i + 1]); mb += lin(d[i + 2]); }
    const n = d.length / 64;
    const tc = new THREE.CanvasTexture(cc); tc.colorSpace = THREE.SRGBColorSpace;
    const th = new THREE.CanvasTexture(hc); th.colorSpace = THREE.NoColorSpace;
    let an = 8; try { an = Env.renderer.capabilities.getMaxAnisotropy(); } catch (e) {}
    for (const t of [tc, th]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = an; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; }
    return { tc, th, mean: new THREE.Vector3(mr / n, mg / n, mb / n) };
  }
  function bedMaterial() {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 });
    m.customProgramCacheKey = () => 'bl-bed';
    const BT = ballastTextures(); M.ballast = BT;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.tBallC = { value: BT.tc }; sh.uniforms.tBallH = { value: BT.th }; sh.uniforms.uBallMean = { value: BT.mean };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aSL; attribute vec4 aLanes; varying vec4 vSL; varying vec4 vLanes; varying vec3 vWb;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vSL = aSL; vLanes = aLanes;`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vWb = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tBallC; uniform sampler2D tBallH; uniform vec3 uBallMean;
          varying vec4 vSL; varying vec4 vLanes; varying vec3 vWb; float gH;
          float bh1(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          vec2 bh2(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
          float vn2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(bh1(i), bh1(i+vec2(1,0)), f.x), mix(bh1(i+vec2(0,1)), bh1(i+vec2(1,1)), f.x), f.y); }
          vec3 voro(vec2 x){ vec2 n = floor(x), f = fract(x); float d1 = 8.0, d2 = 8.0, id = 0.0;
            for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 g = vec2(float(i), float(j)); vec2 o = bh2(n + g); vec2 r = g + o - f; float d = dot(r, r);
              if (d < d1) { d2 = d1; d1 = d; id = bh1(n + g); } else if (d < d2) { d2 = d; } }
            return vec3(sqrt(d1), sqrt(d2) - sqrt(d1), id); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          { vec3 col = diffuseColor.rgb; float kind = vSL.z; gH = 0.0;
            float fw = max(fwidth(vWb.x), fwidth(vWb.z)) + fwidth(vWb.y) * 0.5;
            float dcam = distance(vWb, cameraPosition);
            vec4 dl4 = abs(vec4(vSL.y) - vLanes); float dl = min(min(dl4.x, dl4.y), min(dl4.z, dl4.w));
            // soft large-scale variation (smooth, ±6%) everywhere
            col *= 0.94 + 0.12 * vn2(vWb.xz * 0.23);
            if (kind < 1.5) {
              // stones from the mipmapped stone texture: two differently rotated/scaled samples blended by smooth noise
              float sc = kind < 0.5 ? 1.0 : 2.3;
              vec2 w = vWb.xz * sc;
              vec2 uA = w / 1.2, uB = mat2(0.8, -0.6, 0.6, 0.8) * w / 1.37 + vec2(0.31, 0.77);
              float mm = smoothstep(0.42, 0.58, vn2(vWb.xz * 0.35));
              vec3 tcol = mix(texture2D(tBallC, uA).rgb, texture2D(tBallC, uB).rgb, mm) / uBallMean;
              float th = mix(texture2D(tBallH, uA).r, texture2D(tBallH, uB).r, mm);
              col *= mix(vec3(1.0), tcol, kind < 0.5 ? 0.9 : 0.6);
              gH = th * (1.0 - smoothstep(0.02, 0.08, fw)) * (kind < 0.5 ? 1.0 : 0.4);
              if (kind > 0.5) col = mix(col, col * vec3(1.02, 0.9, 0.74), smoothstep(0.45, 0.8, vn2(vWb.xz * 0.6)) * 0.5);
              float rust = (1.0 - smoothstep(0.5, 1.55, dl)) * (kind < 0.5 ? 1.0 : 0.35);
              col = mix(col, col * vec3(0.93, 0.64, 0.45), rust * 0.6);
              float far = smoothstep(50.0, 105.0, dcam) * step(kind, 0.5);
              if (far > 0.0 && dl < 1.32) {
                float tw = fwidth(vSL.x) / 0.6096; float tph = fract(vSL.x / 0.6096);
                float tie = smoothstep(0.44 + tw, 0.44 - tw, tph); tie = mix(tie, 0.44, smoothstep(0.25, 0.7, tw));
                col = mix(col, vec3(0.47, 0.46, 0.43), tie * far * 0.92);
                float rpx = fwidth(vSL.y) + 0.004; float rw = abs(dl - 0.7545);
                float rail = 1.0 - smoothstep(0.036, 0.036 + rpx, rw); rail = mix(rail, 0.07 / (0.07 + rpx * 4.0), smoothstep(0.02, 0.1, rpx));
                col = mix(col, vec3(0.21, 0.16, 0.12), rail * far);
              }
            } else if (kind < 2.5) {
              col *= 0.94 + 0.12 * mix(vn2(vWb.xz * 1.1), 0.5, smoothstep(0.02, 0.09, fw));
            } else {
              col *= 0.96 + 0.08 * vn2(vWb.xz * 0.37);
            }
            diffuseColor.rgb = col; }`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          if (gH != 0.0) { vec3 pos = -vViewPosition; vec3 sx = dFdx(pos), sy = dFdy(pos); float hx = dFdx(gH) * 0.025, hy = dFdy(gH) * 0.025;
            vec3 r1 = cross(sy, normal), r2 = cross(normal, sx); float det = dot(sx, r1);
            vec3 grad = sign(det) * (hx * r1 + hy * r2); normal = normalize(abs(det) * normal - grad); }`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          { float dk = 1.0 - 0.965 * vSL.w; reflectedLight.directDiffuse *= dk; reflectedLight.directSpecular *= dk; reflectedLight.indirectDiffuse *= dk; reflectedLight.indirectSpecular *= dk * dk; }`);
    };
    return m;
  }
  // chain-link fence: alpha-tested diamond mesh that dissolves into a soft screen at distance (alpha to coverage)
  function fenceMaterial() {
    const tex = U.canvasTexture(128, 128, (c, w, h) => {
      c.clearRect(0, 0, w, h); c.strokeStyle = '#fff'; c.lineWidth = 6; c.lineCap = 'round';
      c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w / 2, 0); c.lineTo(w, h / 2); c.lineTo(w / 2, h); c.closePath(); c.stroke();
    }, { repeat: true, aniso: 8, srgb: false });
    const m = new THREE.MeshStandardMaterial({ color: 0x8a8f93, roughness: 0.45, metalness: 0.6, alphaMap: tex, alphaTest: 0.5, side: THREE.DoubleSide, alphaToCoverage: true });
    m.customProgramCacheKey = () => 'bl-fence';
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        { float fwu = fwidth(vAlphaMapUv.x) + fwidth(vAlphaMapUv.y); diffuseColor.a = mix(diffuseColor.a, 0.16, smoothstep(0.05, 0.25, fwu)); }`);
    };
    return m;
  }
  // signal lenses and halos: additive glow, aspect per signal (0 red, 1 yellow, 2 green); lenses top G, Y, bottom R
  function lensMaterial() {
    if (!M.lensTex) M.lensTex = U.canvasTexture(64, 64, (c, w, h) => { const g = c.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.85)'); g.addColorStop(0.58, 'rgba(255,255,255,0.16)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, w, h); });
    const u = { uAspect: { value: 2 } };
    const m = new THREE.MeshBasicMaterial({ map: M.lensTex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    m.userData.u = u; m.customProgramCacheKey = () => 'bl-lens';
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aLens; varying float vLens;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLens = aLens;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uAspect; varying float vLens;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          { float lit = abs(mod(vLens, 3.0) - (2.0 - uAspect)) < 0.5 ? 1.0 : 0.0; float halo = step(2.5, vLens);
            diffuseColor.rgb *= mix(0.01, 1.0, lit) * mix(6.0, 1.4, halo); }`);
    };
    return m;
  }

  // ---------- sign atlas (canvas): white texel, mileposts 0–87, whistle post, crossbucks, plates, road markings ----------
  let atlas = null; const ATL = 1024; const A = {};
  const rectUV = (x, y, w, h) => [x / ATL, 1 - (y + h) / ATL, (x + w) / ATL, 1 - y / ATL];
  function drawAtlas(c) {
    const FNT = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif';
    c.clearRect(0, 0, ATL, ATL);
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, 128, 64);
    const cell = (x, y, w, h, draw) => { c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip(); draw(x, y, w, h); c.restore(); };
    const txt = (s, x, y, size, color, weight = 700) => { c.fillStyle = color; c.font = `${weight} ${size}px ${FNT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(s, x, y); };
    const plate = (X, Y, W, H, bg = '#f4f3ee') => { c.fillStyle = bg; c.fillRect(X + 2, Y + 2, W - 4, H - 4); c.strokeStyle = '#141414'; c.lineWidth = 3; c.strokeRect(X + 6, Y + 6, W - 12, H - 12); };
    for (let k = 0; k < 88; k++) {   // mileposts: 88 cells of 128×64 from (0, 64)
      const x = (k % 8) * 128, y = 64 + Math.floor(k / 8) * 64;
      cell(x, y, 128, 64, (X, Y, W, H) => { plate(X, Y, W, H, '#f2f1ea'); txt('MP', X + 30, Y + H / 2 + 2, 20, '#161616'); txt(String(k), X + 80, Y + H / 2 + 2, 42, '#111'); });
      A['mp' + k] = rectUV(x + 3, y + 3, 122, 58);
    }
    let y0 = 64 + 11 * 64;   // 768
    cell(0, y0, 64, 64, (X, Y, W, H) => { c.fillStyle = '#f2f1ea'; c.fillRect(X + 2, Y + 2, W - 4, H - 4); txt('W', X + W / 2, Y + H / 2 + 2, 52, '#111', 800); }); A.whistle = rectUV(2, y0 + 2, 60, 60);
    cell(64, y0, 256, 48, (X, Y, W, H) => { plate(X, Y, W, H, '#f6f6f1'); txt('RAILROAD', X + W / 2, Y + H / 2 + 2, 34, '#111'); }); A.xbuckA = rectUV(66, y0 + 2, 252, 44);
    cell(64, y0 + 48, 256, 48, (X, Y, W, H) => { plate(X, Y, W, H, '#f6f6f1'); txt('CROSSING', X + W / 2, Y + H / 2 + 2, 34, '#111'); }); A.xbuckB = rectUV(66, y0 + 50, 252, 44);
    cell(320, y0, 160, 48, (X, Y, W, H) => { plate(X, Y, W, H, '#f6f6f1'); txt('2 TRACKS', X + W / 2, Y + H / 2 + 2, 30, '#111'); }); A.tracks2 = rectUV(322, y0 + 2, 156, 44);
    cell(320, y0 + 48, 160, 48, (X, Y, W, H) => { plate(X, Y, W, H, '#f6f6f1'); txt('3 TRACKS', X + W / 2, Y + H / 2 + 2, 30, '#111'); }); A.tracks3 = rectUV(322, y0 + 50, 156, 44);
    cell(480, y0, 256, 96, (X, Y, W, H) => { c.fillStyle = '#f4f3ee'; c.fillRect(X + 2, Y + 2, W - 4, H - 4); c.fillStyle = '#b2141a'; c.fillRect(X + 2, Y + 2, W - 4, 34); txt('NO TRESPASSING', X + W / 2, Y + 20, 28, '#fff'); txt('RAILROAD PROPERTY', X + W / 2, Y + 54, 22, '#111'); txt('VIOLATORS WILL BE PROSECUTED', X + W / 2, Y + 78, 15, '#333', 600); }); A.trespass = rectUV(482, y0 + 2, 252, 92);
    cell(736, y0, 160, 64, (X, Y, W, H) => { c.fillStyle = '#b1a898'; c.fillRect(X, Y, W, H); c.strokeStyle = 'rgba(60,50,40,.45)'; c.lineWidth = 3; c.strokeRect(X + 6, Y + 6, W - 12, H - 12); txt('1907', X + W / 2, Y + H / 2 + 3, 40, 'rgba(66,56,44,.9)', 600); }); A.date = rectUV(736, y0, 160, 64);
    cell(896, y0, 128, 96, (X, Y, W, H) => { plate(X, Y, W, H); txt('STOP HERE', X + W / 2, Y + 26, 24, '#111'); txt('ON', X + W / 2, Y + 50, 22, '#111'); c.fillStyle = '#c21a1a'; c.beginPath(); c.arc(X + W / 2, Y + 74, 12, 0, 7); c.fill(); }); A.stopRed = rectUV(898, y0 + 2, 124, 92);
    y0 += 96;   // 864: road markings on transparent backgrounds, bungalow door
    cell(0, y0, 160, 160, (X, Y, W, H) => { c.clearRect(X, Y, W, H); c.strokeStyle = '#fff'; c.lineWidth = 16; c.beginPath(); c.moveTo(X + 22, Y + 22); c.lineTo(X + W - 22, Y + H - 22); c.moveTo(X + W - 22, Y + 22); c.lineTo(X + 22, Y + H - 22); c.stroke(); txt('R', X + 30, Y + H / 2 + 4, 40, '#fff', 800); txt('R', X + W - 30, Y + H / 2 + 4, 40, '#fff', 800); }); A.rxr = rectUV(0, y0, 160, 160);
    cell(160, y0, 320, 80, (X, Y, W, H) => { c.clearRect(X, Y, W, H); txt('KEEP CLEAR', X + W / 2, Y + H / 2 + 4, 64, '#fff', 800); }); A.keep = rectUV(160, y0, 320, 80);
    cell(480, y0, 96, 128, (X, Y, W, H) => { c.fillStyle = '#b0b1ab'; c.fillRect(X, Y, W, H); c.strokeStyle = '#6c6d68'; c.lineWidth = 3; c.strokeRect(X + 14, Y + 12, W - 28, H - 18); c.fillStyle = '#3d3e3b'; c.fillRect(X + W - 32, Y + 66, 8, 14); c.fillStyle = '#9a9b95'; for (let k = 0; k < 5; k++) c.fillRect(X + 24, Y + 24 + k * 7, W - 48, 3); }); A.door = rectUV(480, y0, 96, 128);
    A.paint = rectUV(8, 8, 48, 48);
  }
  function makeAtlas() {
    atlas = U.canvasTexture(ATL, ATL, (c) => drawAtlas(c), { aniso: 8 });
    atlas.generateMipmaps = true; atlas.minFilter = THREE.LinearMipmapLinearFilter;
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { try { drawAtlas(atlas.userData.ctx); atlas.needsUpdate = true; } catch (e) {} });
  }

  // ---------- corridor helpers ----------
  function curv(s) { Track.frame(s - 20, F3); const ax = F3.dx, az = F3.dz; Track.frame(s + 20, F3); return (ax * F3.dz - az * F3.dx) / 40; }
  const rollAt = (s) => U.clamp(curv(s) * 900, -0.06, 0.06);          // the same cant the trains lean with (Sim.poseConsist)
  const tunnelDark = (s) => { for (const t of Track.feat.tunnels) if (s > t[0] && s < t[1]) return U.smooth(0, 42, Math.min(s - t[0], t[1] - s)); return 0; };
  const inTunnel = (s) => Track.inTunnel(s), onBridge = (s) => Track.onBridge(s);
  function bedSpan(s) {   // unchanged public contract: lateral extent of the bed at s
    const o = Track.offsets(s); let lo = Math.min(Track.lane(s, 0), Track.lane(s, 1)), hi = Math.max(Track.lane(s, 0), Track.lane(s, 1));
    for (const v of o) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return [lo - 2.1, hi + 2.1];
  }
  // extra tracks (sidings, station and yard tracks) as continuous runs with turnout blends toward a main lane
  const runs = [];
  function planRuns() {
    const n = Track.n, st = Track.step; let open = [];
    const close = (r) => { if ((r.i1 - r.i0) * st >= 60) runs.push(r); };
    for (let i = 0; i < n; i++) {
      const s = i * st, a = Track.lane(s, 0), b = Track.lane(s, 1); const o = Track.offsets(s);
      const next = [];
      for (const v of o) {
        if (Math.abs(v - a) < 1.9 || Math.abs(v - b) < 1.9) continue;
        let best = null, bd = 1.3; for (const r of open) { if (r.used) continue; const d = Math.abs(r.last - v); if (d < bd) { bd = d; best = r; } }
        if (best) { best.used = true; best.lats.push(v); best.last = v; best.i1 = i; next.push(best); }
        else next.push({ i0: i, i1: i, lats: [v], last: v, used: true });
      }
      for (const r of open) if (!r.used) close(r);
      for (const r of next) r.used = false; open = next;
    }
    for (const r of open) close(r);
    for (const r of runs) {   // smooth the quantized offsets, add turnout blends toward the nearest main lane
      const L = r.lats, sm = new Float32Array(L.length);
      for (let i = 0; i < L.length; i++) { let acc = 0, w = 0; for (let k = -6; k <= 6; k++) { const j = U.clamp(i + k, 0, L.length - 1); acc += L[j]; w++; } sm[i] = acc / w; }
      r.lat = sm; r.s0 = r.i0 * st; r.s1 = r.i1 * st;
      const near = (s, v) => { const a = Track.lane(s, 0), b = Track.lane(s, 1); return Math.abs(a - v) < Math.abs(b - v) ? a : b; };
      const m0 = near(r.s0, sm[0]), m1 = near(r.s1, sm[sm.length - 1]);
      r.pre = Math.abs(m0 - sm[0]) < 7 && r.s0 > 60 ? 44 : 0; r.post = Math.abs(m1 - sm[sm.length - 1]) < 7 && r.s1 < Track.length - 60 ? 44 : 0;
    }
    runs.sort((p, q) => p.s0 - q.s0);
  }
  const ease = (t) => t * t * (3 - 2 * t);
  function runLat(r, s) {   // lateral of a run at s (with turnout blends), or null
    if (s < r.s0 - r.pre || s > r.s1 + r.post) return null;
    if (s < r.s0) { const a = Track.lane(s, 0), b = Track.lane(s, 1); const v = r.lat[0]; const m = Math.abs(a - v) < Math.abs(b - v) ? a : b; return m + (v - m) * ease((s - (r.s0 - r.pre)) / r.pre); }
    if (s > r.s1) { const a = Track.lane(s, 0), b = Track.lane(s, 1); const v = r.lat[r.lat.length - 1]; const m = Math.abs(a - v) < Math.abs(b - v) ? a : b; return v + (m - v) * ease((s - r.s1) / r.post); }
    const f = (s - r.s0) / Track.step; const i = Math.min(r.lat.length - 2, Math.max(0, Math.floor(f))); const t = U.clamp(f - i, 0, 1);
    return r.lat.length > 1 ? r.lat[i] + (r.lat[i + 1] - r.lat[i]) * t : r.lat[0];
  }
  // all lanes at s as [{id, lat}] (main SB = 1, main NB = 0, runs = 100 + index); shared scratch array
  const _lanes = [], _lpool = []; for (let i = 0; i < 8; i++) _lpool.push({ id: 0, lat: 0 });
  function lanesAt(s, out = _lanes) {
    out.length = 0; let k = 0; const a = Track.lane(s, 1), b = Track.lane(s, 0);
    const put = (id, lat) => { const o = _lpool[k++] || { id: 0, lat: 0 }; o.id = id; o.lat = lat; out.push(o); };
    put(1, a); if (Math.abs(a - b) > 1.0) put(0, b);
    for (let r = 0; r < runs.length && k < 8; r++) { const R = runs[r]; if (R.s0 - R.pre > s) break; if (R.s1 + R.post < s) continue; const v = runLat(R, s); if (v === null) continue; let ok = true; for (const l of out) if (Math.abs(l.lat - v) < 0.9) { ok = false; break; } if (ok) put(100 + r, v); }
    return out;
  }
  // catenary supports: poles in the open (spacing tightens on curves) and roof supports every 15 m in tunnels
  const supports = [];
  function planSupports() {
    for (const e of Track.feat.electric || []) {
      let s = e[0] + 15;
      while (s < e[1] - 5) {
        const t = inTunnel(s); supports.push({ s, tunnel: t });
        if (t) { s += 15; continue; }
        const c = Math.abs(curv(s)); s += c > 1 / 350 ? 36 : c > 1 / 800 ? 44 : c > 1 / 2000 ? 52 : 58;
      }
    }
    supports.sort((a, b) => a.s - b.s); supports.forEach((p, i) => { p.k = i; p.stagger = (i % 2 ? 1 : -1) * 0.22; });
  }
  const stationAt = (s, pad = 0) => { for (const st of Stations.list) if (st.sMin !== undefined && s > st.sMin - pad && s < st.sMax + pad) return st; return null; };
  const crossingAt = (s, pad) => { for (const c of Track.feat.crossings) if (Math.abs(c.s - s) < pad) return c; return null; };
  // photo colour of the ground (NAIP) under a point, for skirts that must melt into the imagery
  const pixCache = new WeakMap();
  function photoAt(x, z) {
    if (!Terrain.imagery) return null; let im; try { im = Terrain.imagery(x, z); } catch (e) { return null; }
    if (!im || !im.tex || !im.tex.image) return null;
    let px = pixCache.get(im.tex);
    if (!px) {
      try { const bmp = im.tex.image; const w = bmp.width, h = bmp.height; const cv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
        const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(bmp, 0, 0); px = { w, h, d: cx.getImageData(0, 0, w, h).data }; }
      catch (e) { px = { fail: true }; }
      pixCache.set(im.tex, px);
    }
    if (px.fail) return null;
    const u = (x - im.x0) / im.size, v = (z - im.z0) / im.size;
    const i0 = U.clamp(Math.floor(u * px.w) - 1, 0, px.w - 3), j0 = U.clamp(Math.floor(v * px.h) - 1, 0, px.h - 3);
    let r = 0, g = 0, b = 0; for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) { const k = ((j0 + j) * px.w + i0 + i) * 4; r += px.d[k]; g += px.d[k + 1]; b += px.d[k + 2]; }
    const lin = (v8) => Math.pow(v8 / 9 / 255, 2.2);
    return [lin(r), lin(g), lin(b)];
  }

  // ======================================================================================================
  // BED: ballast (crib + shoulders), cess walkway, skirt melting into the photo; decks on bridges; tunnel floors
  // ======================================================================================================
  const linHex = (hex) => { _c.setHex(hex); return [_c.r, _c.g, _c.b]; };
  const C_BALL = linHex(0xa39e94), C_CESS = linHex(0x8d8373), C_DECK = linHex(0x9a958b), C_DIRT = linHex(0x7a6d58);
  const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const _arr = [0, 0, 0, 0];
  function sortedLanes(s) {   // up to 4 lateral positions, ascending, padded with the last one
    const L = lanesAt(s); let n = 0; for (const l of L) if (n < 4) _arr[n++] = l.lat;
    for (let i = 1; i < n; i++) for (let j = i; j > 0 && _arr[j - 1] > _arr[j]; j--) { const t = _arr[j]; _arr[j] = _arr[j - 1]; _arr[j - 1] = t; }
    for (let i = n; i < 4; i++) _arr[i] = _arr[n - 1];
    return n;
  }
  function buildBed(ch) {
    const ss = ch.ss, ox = ch.ox, oz = ch.oz, sBase = Math.floor(ch.s0 / TIE) * TIE;
    const pos = [], nrm = [], col = [], sl = [], ln = [], idx = [];
    const pts = []; for (let i = 0; i < 16; i++) pts.push([0, 0, null]);
    let prevBase = -1;
    for (const s of ss) {
      Track.frame(s, F); const n = sortedLanes(s); const lanes = _arr.slice(); const aL = lanes[0], aR = lanes[3];
      const roll = rollAt(s), br = onBridge(s), tn = inTunnel(s), dark = tunnelDark(s);
      const cant = (lat) => { let best = 1e9, lane = 0; for (let k = 0; k < n; k++) { const d = Math.abs(lat - lanes[k]); if (d < best) { best = d; lane = lanes[k]; } } return best < 1.7 ? -(lat - lane) * roll : 0; };
      const gnd = (lat) => U.clamp(Terrain.h(F.x + F.rx * lat, F.z + F.rz * lat) - F.y, -5, 2.5) - 0.12;
      const set = (i, lat, y, c) => { pts[i][0] = lat; pts[i][1] = y; pts[i][2] = c; };
      // centre: tie ends of every lane (canted); crowded lanes merge
      // padded slots (fewer than 4 tracks) collapse onto the outer tie end of the last real track, not its centre
      for (let k = 0; k < 4; k++) {
        const real = k < n; const lo = real ? lanes[k] - TIE_HALF : lanes[n - 1] + TIE_HALF, hi = real ? lanes[k] + TIE_HALF : lanes[n - 1] + TIE_HALF;
        set(4 + 2 * k, lo, 0, C_BALL); set(5 + 2 * k, hi, 0, C_BALL);
      }
      for (let i = 5; i < 11; i += 2) if (pts[i + 1][0] < pts[i][0]) { const m = (pts[i][0] + pts[i + 1][0]) / 2; pts[i][0] = m; pts[i + 1][0] = m; }
      // heights from the FINAL lateral positions, so merged points never leave a step (a thin wall) behind
      for (let i = 4; i < 12; i++) pts[i][1] = -0.212 + cant(pts[i][0]);
      set(3, aL - 1.62, -0.235 + cant(aL - 1.3), C_BALL); set(12, aR + 1.62, -0.235 + cant(aR + 1.3), C_BALL);
      if (br) {
        set(0, aL - 2.05, -0.45, C_DECK); set(1, aL - 2.05, -0.45, C_DECK); set(2, aL - 1.95, -0.62, C_DECK);
        set(13, aR + 1.95, -0.62, C_DECK); set(14, aR + 2.05, -0.45, C_DECK); set(15, aR + 2.05, -0.45, C_DECK);
      } else if (tn) {
        set(0, aL - 3.05, -0.96, C_CESS); set(1, aL - 3.0, -0.96, C_CESS); set(2, aL - 2.0, -0.93, C_BALL);
        set(13, aR + 2.0, -0.93, C_BALL); set(14, aR + 3.0, -0.96, C_CESS); set(15, aR + 3.05, -0.96, C_CESS);
      } else {
        // the photo terrain is carved to bed level along the line, so the shoulder is a short skirt tucked under it;
        // it only widens into a real embankment where the ground drops away (no photo sampling: that streaked)
        const gl = gnd(aL - 7.2), gr = gnd(aR + 7.2);
        const eL = U.clamp((-gl - 1.35) / 1.2, 0, 1), eR = U.clamp((-gr - 1.35) / 1.2, 0, 1);
        set(0, aL - U.lerp(3.4, 7.2, eL), U.lerp(-1.55, gl, eL), C_DIRT); set(1, aL - 3.1, Math.min(-0.97, gl + 0.3), C_CESS); set(2, aL - 2.0, -0.93, C_BALL);
        set(13, aR + 2.0, -0.93, C_BALL); set(14, aR + 3.1, Math.min(-0.97, gr + 0.3), C_CESS); set(15, aR + U.lerp(3.4, 7.2, eR), U.lerp(-1.55, gr, eR), C_DIRT);
      }
      const base = pos.length / 3;
      for (let j = 0; j < 15; j++) {
        const p0 = pts[j], p1 = pts[j + 1];
        const kind = br ? (j <= 1 || j >= 13 ? 3 : 0) : (j === 0 || j === 14 ? (tn ? 1 : 2) : j === 1 || j === 13 ? 1 : 0);
        let nl = -(p1[1] - p0[1]), ny = p1[0] - p0[0]; const L = Math.hypot(nl, ny) || 1; nl /= L; ny /= L; if (ny < 0.05 && L < 1e-4) { nl = 0; ny = 1; }
        for (const p of [p0, p1]) {
          pos.push(F.x + F.rx * p[0] - ox, F.y + p[1], F.z + F.rz * p[0] - oz); nrm.push(F.rx * nl, ny, F.rz * nl);
          const cc = kind === 0 ? C_BALL : kind === 3 ? C_DECK : p[2]; col.push(cc[0], cc[1], cc[2]);
          sl.push(s - sBase, p[0], kind, dark); ln.push(lanes[0], lanes[1], lanes[2], lanes[3]);
        }
      }
      if (prevBase >= 0) for (let j = 0; j < 15; j++) { const a0 = prevBase + 2 * j, b0 = a0 + 1, a1 = base + 2 * j, b1 = a1 + 1; idx.push(a0, b0, a1, b0, b1, a1); }
      prevBase = base;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('aSL', new THREE.Float32BufferAttribute(sl, 4)); g.setAttribute('aLanes', new THREE.Float32BufferAttribute(ln, 4));
    g.setIndex(idx); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, M.bed); m.receiveShadow = true; m.castShadow = false; return m;
  }

  // ======================================================================================================
  // RAILS: 136RE profile (foot, web, head, polished running band), canted with the curve; guard rails on bridges
  // ======================================================================================================
  const RAILP = [[-0.076, -0.185], [-0.076, -0.170], [-0.030, -0.160], [-0.0095, -0.140], [-0.0095, -0.058], [-0.036, -0.046], [-0.037, -0.014], [-0.028, -0.002],
    [-0.012, 0.0], [0.012, 0.0], [0.028, -0.002], [0.037, -0.014], [0.036, -0.046], [0.0095, -0.058], [0.0095, -0.140], [0.030, -0.160], [0.076, -0.170], [0.076, -0.185]];
  const RAILC = (j) => j === 8 ? PAL.railTop : (j === 7 || j === 9) ? PAL.railSide : (j === 6 || j === 10) ? PAL.railSide : PAL.railRust;
  const GUARDP = RAILP.slice(4, 14);
  function laneLatById(id, s) {
    if (id === 1) return Track.lane(s, 1);
    if (id === 0) { const a = Track.lane(s, 0); return Math.abs(a - Track.lane(s, 1)) > 1.0 ? a : null; }
    const r = runs[id - 100]; return r ? runLat(r, s) : null;
  }
  function railSweep(mb, ss, ox, oz, latFn, offset, prof, rollCache) {
    mb.sweep(ss, (s) => {
      const lat = latFn(s); if (lat === null) return null; const c = lat + offset; const roll = rollCache(s);
      const out = []; for (let j = 0; j < prof.length - 1; j++) { const a = prof[j], b = prof[j + 1]; out.push([c + a[0], a[1] - (c + a[0] - lat) * roll, c + b[0], b[1] - (c + b[0] - lat) * roll, prof === RAILP ? RAILC(j) : PAL.railSide]); }
      return out;
    }, ox, oz);
  }
  function buildRails(mb, ch) {
    const rc = new Map(); const rollCache = (s) => { let r = rc.get(s); if (r === undefined) { r = rollAt(s); rc.set(s, r); } return r; };
    const spans = new Map();
    for (const s of ch.ss) for (const l of lanesAt(s)) { const e = spans.get(l.id); if (e) e[1] = s; else spans.set(l.id, [s, s]); }
    for (const [id, se] of spans) {
      const ss = ch.ss.filter(s => s >= se[0] && s <= se[1]); if (ss.length < 2) continue;
      const latFn = (s) => laneLatById(id, s);
      for (const side of [-1, 1]) railSweep(mb, ss, ch.ox, ch.oz, latFn, side * RC, RAILP, rollCache);
      // guard rails inside the running rails across bridges (and 8 m beyond)
      if (id === 0 || id === 1) for (const b of Track.feat.bridges) {
        if (b[1] + 8 < ch.s0 || b[0] - 8 > ch.s1) continue;
        const gs = ss.filter(s => s > b[0] - 8 && s < b[1] + 8); if (gs.length < 2) continue;
        for (const side of [-1, 1]) railSweep(mb, gs, ch.ox, ch.oz, latFn, side * (RC - 0.3), GUARDP, rollCache);
      }
    }
  }

  // ======================================================================================================
  // TIES: instanced window around the camera (concrete bodies to 170 m, fastenings to 55 m); cant + curve aligned
  // ======================================================================================================
  function polyQuad(mb, a, b, c, d, C, hint) {   // planar quad with outward hint
    const n = norm3(cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
    if (n[0] * hint[0] + n[1] * hint[1] + n[2] * hint[2] < 0) { const t = b; b = d; d = t; n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; }
    const i0 = mb.v(a[0], a[1], a[2], n[0], n[1], n[2], C), i1 = mb.v(b[0], b[1], b[2], n[0], n[1], n[2], C), i2 = mb.v(c[0], c[1], c[2], n[0], n[1], n[2], C), i3 = mb.v(d[0], d[1], d[2], n[0], n[1], n[2], C);
    mb.q(i0, i1, i2, i3);
  }
  function tieBodyGeometry() {   // local: X lateral (±1.3), Y up (top at 0), Z along track (±0.14 base, ±0.1 top)
    const mb = new MB(); const C = PAL.tie; const h = -0.22, L = TIE_HALF;
    const P = (x, y, z) => [x, y, z];
    polyQuad(mb, P(-L, 0, -0.1), P(L, 0, -0.1), P(L, 0, 0.1), P(-L, 0, 0.1), C, [0, 1, 0]);
    polyQuad(mb, P(-L, 0, 0.1), P(L, 0, 0.1), P(L, h, 0.14), P(-L, h, 0.14), C, [0, 0.3, 1]);
    polyQuad(mb, P(-L, 0, -0.1), P(L, 0, -0.1), P(L, h, -0.14), P(-L, h, -0.14), C, [0, 0.3, -1]);
    polyQuad(mb, P(L, 0, -0.1), P(L, 0, 0.1), P(L, h, 0.14), P(L, h, -0.14), C, [1, 0, 0]);
    polyQuad(mb, P(-L, 0, -0.1), P(-L, 0, 0.1), P(-L, h, 0.14), P(-L, h, -0.14), C, [-1, 0, 0]);
    return mb.geometry();
  }
  function tieFastGeometry() {   // rail seat pads, cast shoulders and Pandrol e-clips for both rails
    const mb = new MB(); const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
    for (const r of [-RC, RC]) {
      mb.box(r, 0.006, 0, X, Y, Z, 0.09, 0.006, 0.085, PAL.pad);
      for (const sd of [-1, 1]) {
        const sx = r + sd * 0.098;
        mb.box(sx, 0.036, 0, X, Y, Z, 0.022, 0.036, 0.05, PAL.shoulder, true);
        const o = sd; const pts = [sx + o * 0.012, 0.045, 0.045, sx + o * 0.004, 0.086, 0.03, sx - o * 0.02, 0.078, 0.0, sx - o * 0.042, 0.04, -0.012, sx - o * 0.05, 0.022, -0.035];
        mb.tube(pts, 0.0085, 3, PAL.clip);
      }
    }
    return mb.geometry();
  }
  let tieBody = null, tieFast = null, tieCenter = -1e9, tieVis = false;
  const _m4 = new THREE.Matrix4(), _vx = new THREE.Vector3(), _vy = new THREE.Vector3(), _vz = new THREE.Vector3();
  function placeTie(mesh, k, s, lat) {
    Track.frame(s, F2); const roll = rollAt(s); const co = Math.cos(roll), si = Math.sin(roll);
    _vx.set(F2.rx * co, -si, F2.rz * co); _vy.set(F2.rx * si, co, F2.rz * si); _vz.set(-F2.dx, 0, -F2.dz);
    _m4.makeBasis(_vx, _vy, _vz); _m4.setPosition(F2.x + F2.rx * lat, F2.y - 0.195, F2.z + F2.rz * lat);
    mesh.setMatrixAt(k, _m4);
  }
  function updateTies(camS, camDist) {
    const vis = camDist < 600; if (tieBody) { tieBody.visible = vis; tieFast.visible = vis && camDist < 120; } if (!vis) return;
    if (tieBody && Math.abs(camS - tieCenter) < 30) return; tieCenter = camS;
    if (!tieBody) {
      tieBody = new THREE.InstancedMesh(tieBodyGeometry(), M.infra, 3200); tieBody.frustumCulled = false; tieBody.receiveShadow = true; tieBody.castShadow = false; group.add(tieBody);
      tieFast = new THREE.InstancedMesh(tieFastGeometry(), M.infra, 1200); tieFast.frustumCulled = false; tieFast.receiveShadow = true; group.add(tieFast);
    }
    let kb = 0, kf = 0;
    const s0 = Math.ceil(Math.max(0, camS - 170) / TIE) * TIE, s1 = Math.min(Track.length, camS + 170);
    for (let s = s0; s <= s1 && kb < 3196; s += TIE) {
      const near = Math.abs(s - camS) < 55;
      for (const l of lanesAt(s)) { if (kb >= 3200) break; placeTie(tieBody, kb++, s, l.lat); if (near && kf < 1200) placeTie(tieFast, kf++, s, l.lat); }
    }
    tieBody.count = kb; tieFast.count = kf; tieBody.instanceMatrix.needsUpdate = true; tieFast.instanceMatrix.needsUpdate = true;
  }

  // ======================================================================================================
  // CATENARY: H-beam / tubular poles with cantilevers and insulators, portal gantries over multi-track areas,
  // roof supports in tunnels; contact + messenger wires (zig-zag stagger, sag), droppers, feeders
  // ======================================================================================================
  function frameAt(s) { const o = {}; Track.frame(s, o); return o; }
  function supportConfig(sp) {   // lateral layout at a support
    const L = lanesAt(sp.s).map(l => ({ id: l.id, lat: l.lat })).sort((a, b) => a.lat - b.lat);
    const aL = L[0].lat, aR = L[L.length - 1].lat;
    return { L, aL, aR, kind: sp.tunnel ? 'tunnel' : (L.length >= 3 || aR - aL > 6.5) ? 'gantry' : 'poles', bridge: onBridge(sp.s), station: !!stationAt(sp.s, 5) };
  }
  function insulator(mb, a, b, C = PAL.insul) {
    mb.cyl(a[0], a[1], a[2], b[0], b[1], b[2], 0.022, 0.022, 5, C);
    for (let k = 1; k <= 4; k++) { const t = k / 5; const cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t, cz = a[2] + (b[2] - a[2]) * t;
      const dx = (b[0] - a[0]) * 0.02, dy = (b[1] - a[1]) * 0.02, dz = (b[2] - a[2]) * 0.02; mb.cyl(cx - dx, cy - dy, cz - dz, cx + dx, cy + dy, cz + dz, 0.062, 0.05, 7, C, true, true); }
  }
  function pole(mb, Fp, lat, yb, yTop, tubular, ox, oz) {
    const x = Fp.x + Fp.rx * lat - ox, z = Fp.z + Fp.rz * lat - oz, y0 = Fp.y + yb;
    const T = [Fp.dx, 0, Fp.dz], R = [Fp.rx, 0, Fp.rz];
    mb.cyl(x, y0 - 0.5, z, x, y0 + 0.22, z, 0.38, 0.36, 10, PAL.concreteOld, false, true);            // foundation
    mb.box(x, y0 + 0.24, z, T, UP, R, 0.26, 0.02, 0.26, PAL.galvDark);                                   // base plate
    const h = (yTop - yb - 0.26) / 2, yc = y0 + 0.26 + h;
    if (tubular) mb.cyl(x, y0 + 0.26, z, x, Fp.y + yTop, z, 0.165, 0.125, 10, PAL.galv, false, true);
    else { mb.box(x + T[0] * 0.12, yc, z + T[2] * 0.12, T, UP, R, 0.009, h, 0.13, PAL.galv); mb.box(x - T[0] * 0.12, yc, z - T[2] * 0.12, T, UP, R, 0.009, h, 0.13, PAL.galv); mb.box(x, yc, z, T, UP, R, 0.11, h, 0.0065, PAL.galv);
      mb.box(x, Fp.y + yTop + 0.01, z, T, UP, R, 0.15, 0.01, 0.15, PAL.galvDark); }
  }
  function cantilever(mb, Fp, PL, TL, H, HM, stagger, ox, oz) {
    const sg = Math.sign(TL - PL) || 1;
    const P = (lat, y) => [Fp.x + Fp.rx * lat - ox, Fp.y + y, Fp.z + Fp.rz * lat - oz];
    const pU = P(PL + sg * 0.17, HM + 0.45), pU2 = P(PL + sg * 0.62, HM + 0.45), pL = P(PL + sg * 0.17, H - 0.25), pL2 = P(PL + sg * 0.62, H - 0.25);
    insulator(mb, pU, pU2); insulator(mb, pL, pL2);
    const end = P(TL + sg * 0.2, HM + 0.45);
    mb.cyl(pU2[0], pU2[1], pU2[2], end[0], end[1], end[2], 0.027, 0.027, 6, PAL.galv, false, true);
    mb.cyl(pL2[0], pL2[1], pL2[2], end[0], end[1], end[2], 0.031, 0.031, 6, PAL.galv, false, false);
    const mw = P(TL, HM); mb.cyl(end[0], end[1], end[2], mw[0], mw[1] - 0.02, mw[2], 0.016, 0.016, 5, PAL.galv);
    mb.box(mw[0], mw[1] + 0.02, mw[2], [Fp.dx, 0, Fp.dz], UP, [Fp.rx, 0, Fp.rz], 0.06, 0.035, 0.035, PAL.galvDark);
    const t = (H + 0.35 - (H - 0.25)) / ((HM + 0.45) - (H - 0.25));
    const r0 = [pL2[0] + (end[0] - pL2[0]) * t, pL2[1] + (end[1] - pL2[1]) * t, pL2[2] + (end[2] - pL2[2]) * t], r1 = P(TL + sg * 0.95, H + 0.35);
    mb.cyl(r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], 0.021, 0.021, 5, PAL.galv, false, true);
    const sa = P(TL + sg * 0.62, H + 0.34), cw = P(TL + stagger, H + 0.016);
    mb.cyl(sa[0], sa[1], sa[2], cw[0], cw[1], cw[2], 0.012, 0.012, 4, PAL.galvDark);
    mb.box(cw[0], cw[1] + 0.005, cw[2], [Fp.dx, 0, Fp.dz], UP, [Fp.rx, 0, Fp.rz], 0.05, 0.018, 0.022, PAL.galvDark);
  }
  function buildSupport(mb, sp, ox, oz) {
    const Fp = frameAt(sp.s); const cfg = supportConfig(sp); const H = HCW(), HM = H + 1.3;
    const T = [Fp.dx, 0, Fp.dz], R = [Fp.rx, 0, Fp.rz];
    const gRel = (lat) => U.clamp(Terrain.h(Fp.x + Fp.rx * lat, Fp.z + Fp.rz * lat) - Fp.y, -6, 1.5);
    if (cfg.kind === 'tunnel') {   // roof bracket: drop from the crown, registration arm
      for (const l of cfg.L) {
        if (l.id !== 0 && l.id !== 1) continue; const HT = H + 0.55;
        const top = [Fp.x + Fp.rx * (l.lat - 0.6) - ox, Fp.y + 7.05, Fp.z + Fp.rz * (l.lat - 0.6) - oz], bot = [top[0], Fp.y + HT + 0.1, top[2]];
        mb.box(top[0], top[1] + 0.05, top[2], T, UP, R, 0.18, 0.05, 0.3, PAL.galvDark);
        mb.cyl(top[0], top[1], top[2], bot[0], bot[1], bot[2], 0.04, 0.04, 6, PAL.galv);
        insulator(mb, bot, [bot[0], Fp.y + HT - 0.25, bot[2]]);
        const cw = [Fp.x + Fp.rx * (l.lat + sp.stagger) - ox, Fp.y + H + 0.02, Fp.z + Fp.rz * (l.lat + sp.stagger) - oz];
        mb.cyl(bot[0], Fp.y + HT - 0.25, bot[2], cw[0], cw[1], cw[2], 0.014, 0.014, 4, PAL.galvDark);
      }
      return;
    }
    const tub = cfg.station;
    if (cfg.kind === 'gantry') {
      const PL = cfg.aL - 3.3, PR = cfg.aR + 3.3; const ybL = cfg.bridge ? -0.62 : Math.min(-0.9, gRel(PL)), ybR = cfg.bridge ? -0.62 : Math.min(-0.9, gRel(PR));
      const yTop = HM + 1.95; pole(mb, Fp, PL, ybL, yTop, tub, ox, oz); pole(mb, Fp, PR, ybR, yTop, tub, ox, oz);
      const P = (lat, y) => [Fp.x + Fp.rx * lat - ox, Fp.y + y, Fp.z + Fp.rz * lat - oz];
      const yb = HM + 0.95, yt = HM + 1.8; const mid = (PL + PR) / 2, half = (PR - PL) / 2 + 0.2;
      for (const yy of [yb, yt]) for (const dt of [-0.3, 0.3]) { const c = P(mid, yy); mb.box(c[0] + T[0] * dt, c[1], c[2] + T[2] * dt, R, UP, neg3(T), half, 0.05, 0.05, PAL.galv); }
      for (let lat = PL + 0.2; lat < PR - 0.2; lat += 1.3) for (const dt of [-0.3, 0.3]) { const a = P(lat, yb), b = P(Math.min(PR, lat + 0.65), yt), c = P(Math.min(PR, lat + 1.3), yb);
        mb.cyl(a[0] + T[0] * dt, a[1], a[2] + T[2] * dt, b[0] + T[0] * dt, b[1], b[2] + T[2] * dt, 0.022, 0.022, 4, PAL.galv); mb.cyl(b[0] + T[0] * dt, b[1], b[2] + T[2] * dt, c[0] + T[0] * dt, c[1], c[2] + T[2] * dt, 0.022, 0.022, 4, PAL.galv); }
      for (const l of cfg.L) {   // drop tube + cantilever for each track
        const dl = l.lat - 1.25; const a = P(dl, yb), b = P(dl, H - 0.45);
        mb.cyl(a[0], a[1], a[2], b[0], b[1], b[2], 0.05, 0.05, 6, PAL.galv, false, true);
        cantilever(mb, Fp, dl, l.lat, H, HM, sp.stagger, ox, oz);
      }
      return;
    }
    // side poles, one per outer track
    const pairs = cfg.L.length >= 2 ? [[cfg.aL - 3.25, cfg.aL], [cfg.aR + 3.25, cfg.aR]] : [[cfg.aL - 3.25, cfg.aL]];
    for (const pr of pairs) {
      const PL = pr[0], TL = pr[1]; const yb = cfg.bridge ? -0.62 : Math.min(-0.9, gRel(PL)); const sg = Math.sign(TL - PL);
      pole(mb, Fp, PL, yb, HM + 1.9, tub, ox, oz);
      cantilever(mb, Fp, PL, TL, H, HM, sp.stagger, ox, oz);
      // feeder bracket on the field side: arm, hanging insulator (the feeder wire itself is swept per span)
      const P = (lat, y) => [Fp.x + Fp.rx * lat - ox, Fp.y + y, Fp.z + Fp.rz * lat - oz];
      const a = P(PL, HM + 1.8), b = P(PL - sg * 0.95, HM + 1.8); mb.cyl(a[0], a[1], a[2], b[0], b[1], b[2], 0.03, 0.03, 5, PAL.galv, false, true);
      insulator(mb, b, P(PL - sg * 0.95, HM + 1.38), PAL.insul);
    }
  }
  const ELEC = (s) => Track.electric(s);
  function spanPoints(sa, sb, latFn, yFn, ox, oz) {
    const n = Math.max(2, Math.ceil((sb - sa) / 5)); const out = [];
    for (let i = 0; i <= n; i++) { const t = i / n, s = sa + (sb - sa) * t; Track.frame(s, F2); const lat = latFn(s, t); if (lat === null) return null; out.push(F2.x + F2.rx * lat - ox, F2.y + yFn(s, t), F2.z + F2.rz * lat - oz); }
    return out;
  }
  function buildWires(mbFar, mbNear, ch) {
    const H = HCW();
    const i0 = supports.findIndex(p => p.s >= ch.s0); if (i0 < 0) return;
    for (let i = i0; i < supports.length - 1 && supports[i].s < ch.s1; i++) {
      const a = supports[i], b = supports[i + 1]; if (b.s - a.s > 80 || !ELEC(a.s) || !ELEC(b.s)) continue;
      const HMa = a.tunnel ? H + 0.55 : H + 1.3, HMb = b.tunnel ? H + 0.55 : H + 1.3; const sag = Math.max(0, Math.min(HMa, HMb) - H - 0.3) * 0.72;
      const la = lanesAt(a.s).map(l => l.id), lb = new Set(lanesAt(b.s).map(l => l.id));
      for (const id of la) {
        if (!lb.has(id)) continue;
        const latFn = (s) => laneLatById(id, s);
        const cw = spanPoints(a.s, b.s, (s, t) => { const l = latFn(s); return l === null ? null : l + a.stagger + (b.stagger - a.stagger) * t; }, (s, t) => H - 0.03 * 4 * t * (1 - t), ch.ox, ch.oz);
        const mw = spanPoints(a.s, b.s, (s) => latFn(s), (s, t) => HMa + (HMb - HMa) * t - sag * 4 * t * (1 - t), ch.ox, ch.oz);
        if (!cw || !mw) continue;
        if (mbFar) { mbFar.lamp = 9; mbFar.tube(cw, 0.0072, 4, PAL.copper); mbFar.tube(mw, 0.0062, 4, PAL.copper); mbFar.lamp = 0; }
        const nd = Math.max(2, Math.round((b.s - a.s) / 9));   // droppers
        if (mbNear) for (let k = 1; k < nd; k++) {
          const t = k / nd, s = a.s + (b.s - a.s) * t; Track.frame(s, F2); const l = latFn(s); if (l === null) continue;
          const yc = H - 0.03 * 4 * t * (1 - t), ym = HMa + (HMb - HMa) * t - sag * 4 * t * (1 - t), lc = l + a.stagger + (b.stagger - a.stagger) * t;
          mbNear.lamp = 9; mbNear.cyl(F2.x + F2.rx * l - ch.ox, F2.y + ym, F2.z + F2.rz * l - ch.oz, F2.x + F2.rx * lc - ch.ox, F2.y + yc + 0.01, F2.z + F2.rz * lc - ch.oz, 0.0035, 0.0035, 3, PAL.copper); mbNear.lamp = 0;
        }
      }
      // feeders on each pole line (open-air two-track spans)
      if (mbFar && !a.tunnel && !b.tunnel) {
        const ca = supportConfig(a), cb = supportConfig(b);
        if (ca.kind === 'poles' && cb.kind === 'poles') for (const side of [-1, 1]) {
          const latA = side < 0 ? ca.aL - 3.25 + 0.95 * -1 : ca.aR + 3.25 + 0.95, latB = side < 0 ? cb.aL - 3.25 - 0.95 : cb.aR + 3.25 + 0.95;
          const fw = spanPoints(a.s, b.s, (s, t) => latA + (latB - latA) * t, (s, t) => H + 1.3 + 1.36 - 0.55 * 4 * t * (1 - t), ch.ox, ch.oz);
          if (fw) { mbFar.lamp = 9; mbFar.tube(fw, 0.011, 4, PAL.feeder); mbFar.lamp = 0; }
        }
      }
    }
  }

  // ======================================================================================================
  // SIGNALS: plan (static geometry goes into chunks; the lenses are small global glow meshes)
  // ======================================================================================================
  const signals = [];
  let sigGroup = null;
  function planSignals() {
    sigGroup = new THREE.Group(); sigGroup.name = 'signal-lamps'; group.add(sigGroup);
    const placed = [];
    for (const sg of Track.feat.signals) {
      const dir = sg.off >= 0 ? 1 : 0;
      if (placed.some(p => p.dir === dir && Math.abs(p.s - sg.s) < 60)) continue; placed.push({ s: sg.s, dir });
      const Fs = frameAt(sg.s); const L = lanesAt(sg.s).map(l => l.lat).sort((a, b) => a - b); const aL = L[0], aR = L[L.length - 1];
      const bridge = L.length >= 3;
      const lane = Track.lane(sg.s, dir);
      const lat = bridge ? lane : dir ? aR + 2.9 : aL - 2.9, yHead = bridge ? 5.55 : 4.35;
      const fx = dir ? -Fs.dx : Fs.dx, fz = dir ? -Fs.dz : Fs.dz;
      const e = { s: sg.s, dir, state: -1, type: bridge ? 'bridge' : 'mast', lat, aL, aR, fx, fz, hx: Fs.x + Fs.rx * lat, hy: Fs.y + yHead, hz: Fs.z + Fs.rz * lat, yHead };
      e.x = e.hx; e.z = e.hz;
      // lenses (top green, yellow, bottom red) + halos, facing the approaching train
      const g = new THREE.BufferGeometry(); const pos = [], col = [], uv = [], ln = [], idx = [];
      const ux = [fz, 0, -fx]; const cols = [[0.12, 1.0, 0.5], [1.0, 0.6, 0.06], [1.0, 0.07, 0.03]];
      for (let k = 0; k < 6; k++) {
        const lens = k % 3, halo = k >= 3; const oy = 0.36 - lens * 0.36, of = halo ? 0.2 : 0.17, hs = halo ? 0.62 : 0.14; const b = pos.length / 3;
        for (const [su, sv] of QC) { pos.push(fx * of + ux[0] * su * hs, oy + sv * hs, fz * of + ux[2] * su * hs); col.push(...cols[lens]); uv.push((su + 1) / 2, (sv + 1) / 2); ln.push(k); }
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('aLens', new THREE.Float32BufferAttribute(ln, 1)); g.setIndex(idx);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, lensMaterial()); mesh.position.set(e.hx, e.hy, e.hz); mesh.renderOrder = 3; mesh.frustumCulled = true; mesh.visible = false; sigGroup.add(mesh);
      e.lamp = mesh; signals.push(e);
    }
    signals.sort((a, b) => a.s - b.s);
  }
  function buildSignalStatic(mb, e, ox, oz) {
    const f = [e.fx, 0, e.fz], r = [e.fz, 0, -e.fx]; const Fs = frameAt(e.s);   // f: facing, r: right of the face
    const T = [Fs.dx, 0, Fs.dz], R = [Fs.rx, 0, Fs.rz];
    const x = e.hx - ox, z = e.hz - oz, yH = e.hy;
    const ground = Math.min(Fs.y - 0.9, Terrain.h(e.hx, e.hz));
    // head: back plate, lens housings, visors
    mb.box(x - f[0] * 0.02, yH, z - f[2] * 0.02, r, UP, neg3(f), 0.34, 0.63, 0.025, PAL.black);
    for (let k = 0; k < 3; k++) {
      const oy = 0.36 - k * 0.36; const cx = x + f[0] * 0.07, cz = z + f[2] * 0.07;
      mb.cyl(x, yH + oy, z, cx, yH + oy, cz, 0.135, 0.135, 10, PAL.black, false, false);
      mb.box(x + f[0] * 0.2, yH + oy + 0.15, z + f[2] * 0.2, f, UP, r, 0.14, 0.01, 0.15, PAL.black);
      mb.box(x + f[0] * 0.18 + r[0] * 0.15, yH + oy + 0.07, z + f[2] * 0.18 + r[2] * 0.15, f, UP, r, 0.12, 0.08, 0.008, PAL.black);
      mb.box(x + f[0] * 0.18 - r[0] * 0.15, yH + oy + 0.07, z + f[2] * 0.18 - r[2] * 0.15, f, UP, r, 0.12, 0.08, 0.008, PAL.black);
    }
    mb.box(x - f[0] * 0.12, yH, z - f[2] * 0.12, r, UP, neg3(f), 0.2, 0.5, 0.08, PAL.galvDark);   // lamp case behind
    if (e.type === 'mast') {
      const bx = x - f[0] * 0.28, bz = z - f[2] * 0.28;
      mb.box(bx, ground - 0.2, bz, T, UP, R, 0.4, 0.3, 0.4, PAL.concreteOld, true);
      mb.cyl(bx, ground + 0.1, bz, bx, yH + 0.75, bz, 0.095, 0.085, 8, PAL.galv, false, true);
      mb.box(bx, yH - 0.35, bz, T, UP, R, 0.12, 0.05, 0.12, PAL.galvDark);
      // ladder behind the mast, platform + railing at the head
      const lx = bx - f[0] * 0.26, lz = bz - f[2] * 0.26;
      for (const sd of [-0.2, 0.2]) mb.cyl(lx + r[0] * sd, ground + 0.1, lz + r[2] * sd, lx + r[0] * sd, yH - 0.55, lz + r[2] * sd, 0.018, 0.018, 4, PAL.galv);
      for (let y = ground + 0.4; y < yH - 0.6; y += 0.32) mb.cyl(lx - r[0] * 0.2, y, lz - r[2] * 0.2, lx + r[0] * 0.2, y, lz + r[2] * 0.2, 0.012, 0.012, 4, PAL.galv);
      mb.box(bx - f[0] * 0.1, yH - 0.75, bz - f[2] * 0.1, f, UP, r, 0.5, 0.025, 0.45, PAL.grate);
      for (const sd of [-0.45, 0.45]) mb.cyl(bx - f[0] * 0.5 + r[0] * sd, yH - 0.72, bz - f[2] * 0.5 + r[2] * sd, bx - f[0] * 0.5 + r[0] * sd, yH + 0.25, bz - f[2] * 0.5 + r[2] * sd, 0.015, 0.015, 4, PAL.galv);
      mb.cyl(bx - f[0] * 0.5 - r[0] * 0.45, yH + 0.25, bz - f[2] * 0.5 - r[2] * 0.45, bx - f[0] * 0.5 + r[0] * 0.45, yH + 0.25, bz - f[2] * 0.5 + r[2] * 0.45, 0.015, 0.015, 4, PAL.galv);
      // relay case at the foot of the mast
      const cx = bx - f[0] * 0.9 + r[0] * 0.6, cz = bz - f[2] * 0.9 + r[2] * 0.6;
      mb.box(cx, ground + 0.8, cz, f, UP, r, 0.3, 0.8, 0.42, PAL.bungalow); mb.box(cx, ground + 1.63, cz, f, UP, r, 0.34, 0.04, 0.46, PAL.roof);
    } else {   // signal bridge over all tracks
      const PL = e.aL - 2.9, PR = e.aR + 2.9, mid = (PL + PR) / 2, half = (PR - PL) / 2;
      const P = (lat, y) => [Fs.x + Fs.rx * lat - ox, Fs.y + y, Fs.z + Fs.rz * lat - oz];
      for (const lat of [PL, PR]) { const c = P(lat, 0); const gy = Math.min(Fs.y - 0.9, Terrain.h(c[0] + ox, c[2] + oz));
        mb.box(c[0], gy - 0.2, c[2], T, UP, R, 0.45, 0.3, 0.45, PAL.concreteOld, true); mb.box(c[0], (gy + Fs.y + 7.2) / 2, c[2], T, UP, R, 0.16, (Fs.y + 7.2 - gy) / 2, 0.16, PAL.galv); }
      for (const [yy, dt] of [[6.5, -0.3], [6.5, 0.3], [7.1, -0.3], [7.1, 0.3]]) { const c = P(mid, yy); mb.box(c[0] + T[0] * dt, c[1], c[2] + T[2] * dt, R, UP, neg3(T), half, 0.045, 0.045, PAL.galv); }
      for (let lat = PL; lat < PR - 0.5; lat += 1.2) for (const dt of [-0.3, 0.3]) { const a = P(lat, 6.5), b = P(lat + 0.6, 7.1), c = P(lat + 1.2, 6.5);
        mb.cyl(a[0] + T[0] * dt, a[1], a[2] + T[2] * dt, b[0] + T[0] * dt, b[1], b[2] + T[2] * dt, 0.02, 0.02, 4, PAL.galv); mb.cyl(b[0] + T[0] * dt, b[1], b[2] + T[2] * dt, c[0] + T[0] * dt, c[1], c[2] + T[2] * dt, 0.02, 0.02, 4, PAL.galv); }
      const w = P(mid, 6.42); mb.box(w[0] - f[0] * 0.55, w[1], w[2] - f[2] * 0.55, R, UP, neg3(T), half, 0.02, 0.35, PAL.grate);
      mb.cyl(x, yH + 0.63, z, x, Fs.y + 6.45, z, 0.05, 0.05, 6, PAL.galv);
    }
  }

  // ======================================================================================================
  // TUNNELS: lining (horseshoe, dark inside), wall lamps, cable trays; 1907-style concrete portals with wing walls
  // ======================================================================================================
  function buildTunnel(mb, ch, ta, tb) {
    const a = Math.max(ta, ch.s0), b = Math.min(tb, ch.s1); if (b <= a) return;
    const ss = []; for (let s = a; s < b; s += 5) ss.push(s); ss.push(b);
    const wall = (s) => { sortedLanes(s); return [_arr[0] - 3.05, _arr[3] + 3.05]; };
    mb.sweep(ss, (s) => {
      const [wL, wR] = wall(s); const cx = (wL + wR) / 2, ra = (wR - wL) / 2, rb = 3.95; const out = [];
      const pts = [[wL, -0.96], [wL, 1.2], [wL, 3.4]]; for (let k = 1; k <= 12; k++) { const t = Math.PI - k / 12 * Math.PI; pts.push([cx + Math.cos(t) * ra, 3.4 + Math.sin(t) * rb]); }
      pts.push([wR, 1.2], [wR, -0.96]);
      for (let k = 0; k < pts.length - 1; k++) out.push([pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], PAL.tunnel]);
      return out;
    }, ch.ox, ch.oz, true, tunnelDark);
    // cable trays (both walls) and lamps every 25 m
    mb.sweep(ss, (s) => { const [wL, wR] = wall(s); return [[wL + 0.02, 1.52, wL + 0.34, 1.52, PAL.galvDark], [wR - 0.34, 1.52, wR - 0.02, 1.52, PAL.galvDark]]; }, ch.ox, ch.oz, false, tunnelDark);
    mb.lamp = 4;
    for (let s = Math.ceil(a / 25) * 25; s < b; s += 25) {
      const Fs = frameAt(s); const [wL, wR] = wall(s); const T = [Fs.dx, 0, Fs.dz], R = [Fs.rx, 0, Fs.rz];
      for (const lat of [wL + 0.07, wR - 0.07]) mb.box(Fs.x + Fs.rx * lat - ch.ox, Fs.y + 2.95, Fs.z + Fs.rz * lat - ch.oz, T, UP, R, 0.34, 0.05, 0.06, PAL.lensWarm);
    }
    mb.lamp = 0;
    // portals
    for (const [sp, out] of [[ta, -1], [tb, 1]]) if (sp >= ch.s0 && sp < ch.s1) buildPortal(mb, ch, sp, out);
  }
  function buildPortal(mb, ch, sp, out) {
    const Fs = frameAt(sp); sortedLanes(sp); const wL = _arr[0] - 3.05, wR = _arr[3] + 3.05; const cx = (wL + wR) / 2, ra = (wR - wL) / 2, rb = 3.95;
    const T = [Fs.dx, 0, Fs.dz], R = [Fs.rx, 0, Fs.rz]; const nOut = [T[0] * out, 0, T[2] * out];
    const W = ra + 4.2, Htop = 3.4 + rb + 2.7, base = -2.5;
    // headwall with the arch opening (extruded shape), placed in a frame: x = lateral, y = up, z = out of the face
    const shape = new THREE.Shape(); shape.moveTo(-W, base); shape.lineTo(W, base); shape.lineTo(W, Htop); shape.lineTo(-W, Htop); shape.closePath();
    const hole = new THREE.Path(); const hr = ra + 0.05; hole.moveTo(-hr, base + 0.01); hole.lineTo(-hr, 3.4); for (let k = 1; k <= 16; k++) { const t = Math.PI - k / 16 * Math.PI; hole.lineTo(Math.cos(t) * hr, 3.4 + Math.sin(t) * (rb + 0.05)); } hole.lineTo(hr, base + 0.01); hole.closePath(); shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 1.2, bevelEnabled: false, curveSegments: 16 });
    // basis: X = R (lateral), Y = up, Z = outward normal; origin at the portal face centre line
    const bx = [R[0], 0, R[2]], bz = nOut; const m4 = new THREE.Matrix4().makeBasis(new THREE.Vector3(...bx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(...bz));
    m4.setPosition(Fs.x + Fs.rx * cx - ch.ox - bz[0] * 1.0, Fs.y, Fs.z + Fs.rz * cx - ch.oz - bz[2] * 1.0);
    appendGeometry(mb, geo, m4, PAL.concreteOld); geo.dispose();
    // arch ring (voussoir band), cornice, pilasters, date stone
    const face = (lat, y, d) => [Fs.x + Fs.rx * (cx + lat) - ch.ox + bz[0] * d, Fs.y + y, Fs.z + Fs.rz * (cx + lat) - ch.oz + bz[2] * d];
    for (let k = 0; k < 17; k++) {
      const t0 = Math.PI - k / 17 * Math.PI, t1 = Math.PI - (k + 1) / 17 * Math.PI, tm = (t0 + t1) / 2;
      const px = Math.cos(tm) * (hr + 0.32), py = 3.4 + Math.sin(tm) * (rb + 0.37); const c = face(px, py, 0.32);
      const tang = [-Math.sin(tm) * R[0], Math.cos(tm) * 0, -Math.sin(tm) * R[2]]; const radial = norm3([Math.cos(tm) * R[0], Math.sin(tm), Math.cos(tm) * R[2]]);
      const ax = norm3(cross3(radial, bz)); mb.box(c[0], c[1], c[2], ax, radial, bz, (hr + 0.3) * Math.PI / 17 / 2 * 1.02, 0.3, 0.14, k % 2 ? PAL.stone : PAL.concrete);
    }
    for (const sd of [-1, 1]) { const c = face(sd * (W - 0.45), (base + Htop) / 2, 0.3); mb.box(c[0], c[1], c[2], bx, UP, bz, 0.45, (Htop - base) / 2, 0.12, PAL.concrete); }
    const cor = face(0, Htop + 0.18, 0.2); mb.box(cor[0], cor[1], cor[2], bx, UP, bz, W + 0.25, 0.2, 0.8, PAL.concrete);
    const ds = face(0, 3.4 + rb + 1.25, 0.215); mb.quadUV(ds[0], ds[1], ds[2], [bx[0] * out * -1 * -1, 0, bx[2]], UP, 0.9, 0.36, A.date, [1, 1, 1, 0.8, 0]);
    // wing walls angled back into the hill
    for (const sd of [-1, 1]) {
      const dirW = norm3([bz[0] * 0.82 + bx[0] * sd * 0.57, 0, bz[2] * 0.82 + bx[2] * sd * 0.57]); const axW = norm3(cross3(UP, dirW));
      for (let k = 0; k < 5; k++) { const h = Htop - 0.4 - k * (Htop - 1.6) / 5; const along = 1.1 + k * 2.2;
        const c = face(sd * (W - 0.3), 0, 0); c[0] += dirW[0] * along; c[2] += dirW[2] * along; mb.box(c[0], Fs.y + (base + h) / 2, c[2], dirW, UP, neg3(axW), 1.15, (h - base) / 2, 0.3, PAL.concreteOld); }
    }
  }
  function appendGeometry(mb, geo, m4, C) {
    const g = geo.index ? geo.toNonIndexed() : geo; const p = g.attributes.position; g.computeVertexNormals(); const n = g.attributes.normal;
    const v = new THREE.Vector3(), nn = new THREE.Vector3(); const nm = new THREE.Matrix3().getNormalMatrix(m4);
    for (let i = 0; i < p.count; i += 3) {
      const ids = [];
      for (let k = 0; k < 3; k++) { v.fromBufferAttribute(p, i + k).applyMatrix4(m4); nn.fromBufferAttribute(n, i + k).applyMatrix3(nm).normalize(); ids.push(mb.v(v.x, v.y, v.z, nn.x, nn.y, nn.z, C)); }
      mb.i.push(ids[0], ids[1], ids[2]);
    }
    if (g !== geo) g.dispose();
  }

  // ======================================================================================================
  // BRIDGES: slab (short), through plate girder (medium), deck girders on piers (long); abutments, railings
  // ======================================================================================================
  function buildBridge(mb, ch, ba, bb) {
    const a = Math.max(ba, ch.s0), b = Math.min(bb, ch.s1); if (b <= a) return;
    const len = bb - ba; const type = len < 22 ? 'slab' : len < 70 ? 'truss' : 'deck';
    const ss = []; for (let s = a; s < b; s += 5) ss.push(s); ss.push(b);
    const edges = (s) => { sortedLanes(s); return [_arr[0] - 2.35, _arr[3] + 2.35]; };
    const bottom = type === 'deck' ? -1.25 : -1.45;
    // deck slab: outer curb faces, sides and underside (segments ordered so every normal faces out)
    mb.sweep(ss, (s) => { const [l, r] = edges(s); return [[l + 0.3, -0.45, l, -0.45, PAL.concrete], [l, -0.45, l, bottom, PAL.concrete], [r, bottom, l, bottom, PAL.concreteDark], [r, bottom, r, -0.45, PAL.concrete], [r, -0.45, r - 0.3, -0.45, PAL.concrete]]; }, ch.ox, ch.oz);
    if (type === 'slab') {   // concrete parapets
      mb.sweep(ss, (s) => { const [l, r] = edges(s); return [[l, -0.45, l, 0.55, PAL.concrete], [l, 0.55, l + 0.28, 0.55, PAL.concrete], [l + 0.28, 0.55, l + 0.28, -0.45, PAL.concrete], [r - 0.28, -0.45, r - 0.28, 0.55, PAL.concrete], [r - 0.28, 0.55, r, 0.55, PAL.concrete], [r, 0.55, r, -0.45, PAL.concrete]]; }, ch.ox, ch.oz);
    } else if (type === 'truss') {   // through plate girders with stiffeners
      mb.sweep(ss, (s) => { const [l, r] = edges(s); const gl = l - 0.35, gr = r + 0.35;
        return [[gl - 0.3, -1.8, gl - 0.3, -1.75, PAL.steelGreen], [gl, -1.75, gl, 0.95, PAL.steelGreen], [gl - 0.28, 0.95, gl + 0.28, 0.95, PAL.steelGreen], [gl + 0.02, 0.95, gl + 0.02, -1.75, PAL.steelGreen],
                [gr - 0.02, -1.75, gr - 0.02, 0.95, PAL.steelGreen], [gr - 0.28, 0.95, gr + 0.28, 0.95, PAL.steelGreen], [gr, 0.95, gr, -1.75, PAL.steelGreen], [gr + 0.3, -1.75, gr + 0.3, -1.8, PAL.steelGreen]]; }, ch.ox, ch.oz);
      for (let s = Math.ceil(a / 1.6) * 1.6; s < b; s += 1.6) { const Fs = frameAt(s); const [l, r] = edges(s); const T = [Fs.dx, 0, Fs.dz], R = [Fs.rx, 0, Fs.rz];
        for (const lat of [l - 0.42, r + 0.42]) mb.box(Fs.x + Fs.rx * lat - ch.ox, Fs.y - 0.4, Fs.z + Fs.rz * lat - ch.oz, T, UP, R, 0.012, 1.35, 0.085, PAL.steelGreen); }
    } else {   // deck girders under the slab + railings
      mb.sweep(ss, (s) => { const [l, r] = edges(s); const out = []; for (const g of [l + 0.9, (l + r) / 2 - 0.9, (l + r) / 2 + 0.9, r - 0.9]) out.push([g - 0.012, -1.25, g - 0.012, -2.9, PAL.steel], [g - 0.25, -2.9, g + 0.25, -2.9, PAL.steel], [g + 0.012, -2.9, g + 0.012, -1.25, PAL.steel]); return out; }, ch.ox, ch.oz);
      mb.sweep(ss, (s) => { const [l, r] = edges(s); return [[l - 0.02, 0.6, l + 0.02, 0.6, PAL.galv], [r - 0.02, 0.6, r + 0.02, 0.6, PAL.galv], [l - 0.02, 0.1, l + 0.02, 0.1, PAL.galv], [r - 0.02, 0.1, r + 0.02, 0.1, PAL.galv]]; }, ch.ox, ch.oz);
      for (let s = Math.ceil(a / 2) * 2; s < b; s += 2) { const Fs = frameAt(s); const [l, r] = edges(s);
        for (const lat of [l, r]) { const x = Fs.x + Fs.rx * lat - ch.ox, z = Fs.z + Fs.rz * lat - ch.oz; mb.cyl(x, Fs.y - 0.45, z, x, Fs.y + 0.62, z, 0.025, 0.025, 5, PAL.galv); } }
    }
    // piers (from the deck bottom down to the real ground) and abutments
    const bot = type === 'deck' ? -2.95 : -1.8;
    const pierAt = (s, abut) => { const Fs = frameAt(s); const [l, r] = edges(s); const c = (l + r) / 2; const x = Fs.x + Fs.rx * c, z = Fs.z + Fs.rz * c;
      const g = Math.min(Terrain.h(x, z), Terrain.h(Fs.x + Fs.rx * l, Fs.z + Fs.rz * l), Terrain.h(Fs.x + Fs.rx * r, Fs.z + Fs.rz * r)) - 0.6; const top = Fs.y + bot; if (top - g < 0.8) return;
      const T = [Fs.dx, 0, Fs.dz], R = [Fs.rx, 0, Fs.rz];
      if (abut) mb.box(x - ch.ox, (top + g) / 2, z - ch.oz, T, UP, R, 1.6, (top - g) / 2, (r - l) / 2 + 1.2, PAL.concreteOld);
      else { mb.box(x - ch.ox, (top + g) / 2, z - ch.oz, T, UP, R, 0.7, (top - g) / 2, (r - l) / 2 - 0.2, PAL.concreteOld); mb.box(x - ch.ox, top - 0.25, z - ch.oz, T, UP, R, 0.9, 0.25, (r - l) / 2 + 0.3, PAL.concrete); } };
    if (ba >= ch.s0 && ba < ch.s1) pierAt(ba - 1.2, true);
    if (bb >= ch.s0 && bb < ch.s1) pierAt(bb + 1.2, true);
    const sp = type === 'deck' ? 30 : 24; const n = Math.floor(len / sp);
    for (let k = 1; k <= n; k++) { const s = ba + k * len / (n + 1); if (s >= ch.s0 && s < ch.s1) pierAt(s, false); }
  }

  // ======================================================================================================
  // NEAR DETAILS: right-of-way fence, cable trough, mileposts, whistle posts, switch machines, bungalows
  // ======================================================================================================
  const fenceZone = (s) => { if (inTunnel(s) || onBridge(s) || stationAt(s, 25) || crossingAt(s, 17)) return false; for (const t of Track.feat.tunnels) if (s > t[0] - 35 && s < t[1] + 35) return false; for (const b of Track.feat.bridges) if (s > b[0] - 6 && s < b[1] + 6) return false; return true; };
  function buildFence(mb, fb, ch) {
    for (const side of [-1, 1]) {
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          const top = []; let dist = 0;
          for (let i = 0; i < run.length; i++) { const p = run[i]; top.push(p[0], p[1] + 1.98, p[2]); mb.cyl(p[0], p[1] - 0.35, p[2], p[0], p[1] + 2.0, p[2], 0.031, 0.031, 5, PAL.fence, false, true);
            if (i > 0) { const q = run[i - 1]; const d = Math.hypot(p[0] - q[0], p[2] - q[2]); fb.panel(q, p, dist, dist + d); dist += d; } }
          mb.tube(top, 0.021, 4, PAL.fence);
        }
        run = [];
      };
      for (let s = Math.ceil(ch.s0 / 3) * 3; s < ch.s1 + 0.1; s += 3) {
        if (!fenceZone(s)) { flush(); continue; }
        Track.frame(s, F2); sortedLanes(s); const lat = side < 0 ? _arr[0] - 7.6 : _arr[3] + 7.6; const x = F2.x + F2.rx * lat, z = F2.z + F2.rz * lat;
        if (Terrain.isWater(x, z)) { flush(); continue; }
        const y = Math.max(Terrain.h(x, z), F2.y - 6); run.push([x - ch.ox, y, z - ch.oz]);
        if (Math.round(s / 3) % 55 === 0) { const nx = F2.rx * side, nz = F2.rz * side; const up = [0, 1, 0]; const ux = [nz, 0, -nx];   // no trespassing sign facing outward
          mb.quadUV(x - ch.ox + nx * 0.06, y + 1.3, z - ch.oz + nz * 0.06, ux, up, 0.3, 0.11, A.trespass, [1, 1, 1, 0.5, 0]); mb.quadUV(x - ch.ox - nx * 0.06, y + 1.3, z - ch.oz - nz * 0.06, [-ux[0], 0, -ux[2]], up, 0.3, 0.11, A.trespass, [1, 1, 1, 0.5, 0]); }
      }
      flush();
    }
  }
  class FenceB {   // chain-link panels: position, normal, uv (6 cm diamonds)
    constructor() { this.p = []; this.n = []; this.u = []; this.i = []; }
    panel(a, b, d0, d1) {
      const dx = b[0] - a[0], dz = b[2] - a[2]; const L = Math.hypot(dx, dz) || 1; const nx = -dz / L, nz = dx / L; const base = this.p.length / 3; const k = 1 / 0.062;
      this.p.push(a[0], a[1] + 0.04, a[2], b[0], b[1] + 0.04, b[2], b[0], b[1] + 1.95, b[2], a[0], a[1] + 1.95, a[2]);
      for (let q = 0; q < 4; q++) this.n.push(nx, 0, nz);
      this.u.push(d0 * k, 0, d1 * k, 0, d1 * k, 1.91 * k, d0 * k, 1.91 * k); this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    mesh() { if (!this.i.length) return null; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2)); g.setIndex(this.i); g.computeBoundingSphere(); const m = new THREE.Mesh(g, M.fence); m.receiveShadow = true; return m; }
  }
  function buildTrough(mb, ch) {
    const ss = ch.ss.filter(s => fenceZone(s)); if (ss.length < 2) return;
    let seg = [ss[0]];
    const emit = () => { if (seg.length >= 2) mb.sweep(seg, (s) => { sortedLanes(s); const c = _arr[3] + 2.55; return [[c - 0.19, -0.95, c - 0.19, -0.78, PAL.concreteOld], [c - 0.19, -0.78, c + 0.19, -0.78, PAL.concrete], [c + 0.19, -0.78, c + 0.19, -0.95, PAL.concreteOld]]; }, ch.ox, ch.oz); };
    for (let i = 1; i < ss.length; i++) { if (ss[i] - ss[i - 1] > 5.5) { emit(); seg = []; } seg.push(ss[i]); } emit();
  }
  function postSign(mb, ch, s, lat, h, R, facing, size) {   // post + sign plate (face towards facing: +1 = +s)
    Track.frame(s, F2); const x = F2.x + F2.rx * lat - ch.ox, z = F2.z + F2.rz * lat - ch.oz; const g = Math.min(F2.y - 0.9, Terrain.h(x + ch.ox, z + ch.oz) + 0.05);
    mb.cyl(x, g - 0.3, z, x, F2.y + h + size[1], z, 0.04, 0.04, 6, PAL.galv, false, true);
    const f = [F2.dx * facing, 0, F2.dz * facing]; const ux = [f[2], 0, -f[0]];
    mb.quadUV(x + f[0] * 0.05, F2.y + h, z + f[2] * 0.05, ux, UP, size[0], size[1], R, [1, 1, 1, 0.45, 0]);
    mb.box(x, F2.y + h, z, f, UP, [-ux[0], 0, -ux[2]], 0.035, size[1], size[0], PAL.backPlate);
  }
  function buildSmall(mb, ch) {
    for (let m = Math.ceil(ch.s0 / 1609.34); m * 1609.34 < ch.s1; m++) { const s = m * 1609.34; if (inTunnel(s) || m >= 88) continue; sortedLanes(s); const lat = _arr[0] - 3.7; postSign(mb, ch, s, lat, 0.9, A['mp' + m], 1, [0.21, 0.105]); postSign(mb, ch, s + 0.08, lat, 0.9, A['mp' + m], -1, [0.21, 0.105]); }
    for (const c of Track.feat.crossings) {   // whistle posts a quarter mile before public crossings
      for (const [sw, dir] of [[c.s - 402, 1], [c.s + 402, 0]]) { if (sw < ch.s0 || sw >= ch.s1 || stationAt(sw, 10) || inTunnel(sw)) continue; sortedLanes(sw); const lat = dir ? _arr[3] + 3.7 : _arr[0] - 3.7; postSign(mb, ch, sw, lat, 1.45, A.whistle, dir ? -1 : 1, [0.23, 0.23]); }
    }
    for (const r of runs) {   // switch machines at the points
      for (const [sp, sign] of [[r.s0 - r.pre, r.pre], [r.s1 + r.post, r.post]]) {
        if (!sign || sp < ch.s0 || sp >= ch.s1) continue; Track.frame(sp, F2); const v = runLat(r, sp + (sp < r.s0 ? 1 : -1)); if (v === null) continue;
        const a = Track.lane(sp, 0), b = Track.lane(sp, 1); const main = Math.abs(a - v) < Math.abs(b - v) ? a : b; const away = main > v ? 1 : -1; const lat = main + away * 1.95;
        const T = [F2.dx, 0, F2.dz], R = [F2.rx, 0, F2.rz];
        mb.box(F2.x + F2.rx * lat - ch.ox, F2.y - 0.12, F2.z + F2.rz * lat - ch.oz, T, UP, R, 0.6, 0.2, 0.2, PAL.steelGreen);
        mb.box(F2.x + F2.rx * (main + away * 1.1) - ch.ox, F2.y - 0.17, F2.z + F2.rz * (main + away * 1.1) - ch.oz, T, UP, R, 0.03, 0.02, 0.85, PAL.galvDark);
      }
    }
  }
  function bungalow(mb, x, y, z, f, w, d, h) {   // grey steel signal house facing f (door side), gable roof, AC unit, antenna
    const r = [f[2], 0, -f[0]]; mb.box(x, y - 0.25, z, f, UP, r, d / 2 + 0.25, 0.25, w / 2 + 0.25, PAL.concreteOld, true);
    mb.box(x, y + h / 2, z, f, UP, r, d / 2, h / 2, w / 2, PAL.bungalow);
    const rl = Math.hypot(d / 2 + 0.2, 0.55); const ang = Math.atan2(0.55, d / 2 + 0.2);
    for (const sd of [-1, 1]) { const ax = norm3([f[0] * sd * Math.cos(ang), Math.sin(ang), f[2] * sd * Math.cos(ang)]); const ay = norm3(cross3(r, ax)); const c = [x + f[0] * sd * (d / 4 + 0.1), y + h + 0.3, z + f[2] * sd * (d / 4 + 0.1)];
      mb.box(c[0], c[1], c[2], ax, sd > 0 ? ay : neg3(ay), sd > 0 ? r : neg3(r), rl / 2, 0.025, w / 2 + 0.2, PAL.roof); }
    mb.quadUV(x + f[0] * (d / 2 + 0.005), y + 1.05, z + f[2] * (d / 2 + 0.005), neg3(r), UP, 0.45, 1.0, A.door, [1, 1, 1, 0.55, 0.3]);
    mb.box(x - r[0] * (w / 2 + 0.28), y + 1.3, z - r[2] * (w / 2 + 0.28), f, UP, r, 0.35, 0.4, 0.25, PAL.bungalow);
    mb.cyl(x + r[0] * (w / 2 - 0.3), y + h, z + r[2] * (w / 2 - 0.3), x + r[0] * (w / 2 - 0.3), y + h + 2.4, z + r[2] * (w / 2 - 0.3), 0.025, 0.018, 4, PAL.galv);
  }
  function buildBungalows(mb, ch) {   // one per signal cluster (interlockings)
    for (let i = 0; i < signals.length; i++) {
      const e = signals[i]; if (e.s < ch.s0 || e.s >= ch.s1) continue;
      if (!(i > 0 && signals[i - 1].s > e.s - 150) && (i + 1 < signals.length && signals[i + 1].s < e.s + 150)) {
        const s = e.s + 18; if (stationAt(s, 10) || inTunnel(s) || onBridge(s)) continue; Track.frame(s, F2); sortedLanes(s); const lat = _arr[3] + 8.2; const x = F2.x + F2.rx * lat, z = F2.z + F2.rz * lat;
        if (Terrain.isWater(x, z)) continue; bungalow(mb, x - ch.ox, Math.max(Terrain.h(x, z), F2.y - 3), z - ch.oz, [-F2.rx, 0, -F2.rz], 3.6, 2.6, 2.6);
      }
    }
  }

  // ======================================================================================================
  // GRADE CROSSINGS (built lazily near the camera, oriented to the real road from the towns network)
  // ======================================================================================================
  const crossings = [];
  let crossGroup = null;
  function planCrossings() {
    crossGroup = new THREE.Group(); crossGroup.name = 'crossings'; group.add(crossGroup);
    for (const c of Track.feat.crossings) { Track.frame(c.s, F); crossings.push({ s: c.s, kind: c.gates, x: F.x, z: F.z, t: 0, active: false, built: false, job: null, root: null, lifts: [], mat: null }); }
  }
  function roadAt(x, z, Fc) {
    if (typeof Towns === 'undefined' || !Towns.roadsNear) return null;
    let roads; try { roads = Towns.roadsNear(x, z, 45); } catch (e) { return null; }
    let best = null, bd = 22;
    for (const r of roads || []) {
      const p = r.pts; if (!p || p.length < 6) continue;
      for (let i = 0; i + 5 < p.length; i += 3) {
        const ax = p[i], az = p[i + 2], dx = p[i + 3] - ax, dz = p[i + 5] - az; const L = Math.hypot(dx, dz); if (L < 0.5) continue;
        const ux = dx / L, uz = dz / L; if (Math.abs(ux * Fc.dx + uz * Fc.dz) > 0.85) continue;   // parallel roads don't cross
        const k = U.clamp((x - ax) * ux + (z - az) * uz, 0, L); const d = Math.hypot(ax + ux * k - x, az + uz * k - z);
        if (d < bd) { bd = d; best = { ux, uz, w: r.width || (r.lanes ? r.lanes * 3.4 + 1 : 9), urban: r.urban !== false }; }
      }
    }
    return best;
  }
  function armGeometry(len, ped) {   // along +X from the pivot: striped arm, lamps on top, counterweight
    const mb = new MB(); const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
    const n = Math.max(2, Math.round(len / 0.41)); const seg = len / n; const hy = ped ? 0.035 : 0.055, hz = ped ? 0.025 : 0.035;
    for (let k = 0; k < n; k++) mb.box(0.15 + seg * (k + 0.5), 0, 0, X, Y, Z, seg / 2, hy, hz, k % 2 ? PAL.red : PAL.white);
    mb.box(-0.45, 0, 0, X, Y, Z, 0.42, 0.05, 0.05, PAL.steel); mb.box(-0.72, 0, 0, X, Y, Z, 0.16, 0.16, 0.1, PAL.steel);
    if (!ped) for (const [fx, id] of [[0.33, 1], [0.66, 2], [0.985, 3]]) { const x = 0.15 + len * fx; mb.lamp = id; mb.cyl(x, hy, 0, x, hy + 0.07, 0, 0.055, 0.05, 8, PAL.lensRed, false, true); mb.lamp = 0; }
    return mb.geometry();
  }
  function* buildCrossing(c) {
    const Fc = frameAt(c.s); const nL = sortedLanes(c.s); const lanesS = _arr.slice(0, nL); const aL = _arr[0], aR = _arr[3];
    const T = [Fc.dx, 0, Fc.dz], R = [Fc.rx, 0, Fc.rz];
    const road = roadAt(Fc.x, Fc.z, Fc);
    let ux = R[0], uz = R[2], W = 9.5, side = 1.9;
    if (road) { ux = road.ux; uz = road.uz; if (ux * R[0] + uz * R[2] < 0) { ux = -ux; uz = -uz; } W = U.clamp(road.w, 6.5, 24); side = road.urban ? 1.9 : 0; }
    const nu = [-uz, 0, ux];                                   // across the road (right of +u)
    const tn = T[0] * nu[0] + T[2] * nu[2], rn = R[0] * nu[0] + R[2] * nu[2];
    const vEdge = (lat, sg) => (sg * (W / 2 + side) - lat * rn) / (Math.abs(tn) > 0.15 ? tn : (tn < 0 ? -0.15 : 0.15));
    const ox = Fc.x, oz = Fc.z; const mb = new MB();
    const P = (lat, v, dy) => [Fc.rx * lat + Fc.dx * v, Track.yAt(c.s + v) + dy, Fc.rz * lat + Fc.dz * v];
    // surface: concrete field and gauge panels flush with the rail heads, rubber flangeway seals
    const cuts = [[aL - 2.3, 0]];
    for (const l of lanesS) cuts.push([l - RC - 0.04, 1], [l - RC + 0.037, 2], [l - RC + 0.1, 0], [l + RC - 0.1, 2], [l + RC - 0.037, 1], [l + RC + 0.04, 0]);
    cuts.push([aR + 2.3, 1]);
    for (let i = 0; i < cuts.length - 1; i++) {
      const l0 = cuts[i][0], l1 = cuts[i + 1][0], kind = cuts[i][1]; if (l1 - l0 < 0.005 || kind === 1) continue;
      const C = kind === 2 ? PAL.rubber : PAL.concrete, dy = kind === 2 ? -0.03 : -0.004;
      const va0 = Math.min(vEdge(l0, -1), vEdge(l0, 1)), vb0 = Math.max(vEdge(l0, -1), vEdge(l0, 1)), va1 = Math.min(vEdge(l1, -1), vEdge(l1, 1)), vb1 = Math.max(vEdge(l1, -1), vEdge(l1, 1));
      polyQuad(mb, P(l0, va0, dy), P(l1, va1, dy), P(l1, vb1, dy), P(l0, vb0, dy), C, UP);
    }
    // approach ramps down to the road (towns roads sit ~0.3 m above the ground), stop lines on the approach lanes
    const rampY = [];   // per side: function(dist) -> height at the road centre line
    for (const sd of [-1, 1]) {
      const le = sd < 0 ? aL - 2.3 : aR + 2.3; const dir = [ux * sd, 0, uz * sd];
      const e0 = P(le, vEdge(le, -1), -0.004), e1 = P(le, vEdge(le, 1), -0.004);
      const probe = [(e0[0] + e1[0]) / 2 + dir[0] * 14, (e0[2] + e1[2]) / 2 + dir[2] * 14];
      const dy = Math.abs(Terrain.h(probe[0] + ox, probe[1] + oz) + 0.33 - (e0[1] + e1[1]) / 2);
      const RL = U.clamp(dy / 0.11, 9, 34), NS = Math.max(4, Math.round(RL / 2.2));
      const hAt = (qx, qz) => Terrain.h(qx + ox, qz + oz) + 0.33;
      rampY.push({ e0, e1, dir, RL, hAt });
      let pa = e0, pb = e1;
      for (let k = 1; k <= NS + 2; k++) {
        const d = k * RL / NS; const t = ease(Math.min(1, d / RL));
        const qa = [e0[0] + dir[0] * d, 0, e0[2] + dir[2] * d], qb = [e1[0] + dir[0] * d, 0, e1[2] + dir[2] * d];
        qa[1] = e0[1] + (hAt(qa[0], qa[2]) + 0.02 - e0[1]) * t; qb[1] = e1[1] + (hAt(qb[0], qb[2]) + 0.02 - e1[1]) * t;
        polyQuad(mb, pa, pb, qb, qa, PAL.asphalt, UP); pa = qa; pb = qb;
        if (k === Math.min(NS, Math.max(3, Math.round(NS * 0.7)))) {
          const m = [(qa[0] + qb[0]) / 2, (qa[1] + qb[1]) / 2 + 0.015, (qa[2] + qb[2]) / 2]; const across = [-nu[0] * sd, 0, -nu[2] * sd];
          const c0 = [m[0] + across[0] * W / 4, m[1], m[2] + across[2] * W / 4];
          mb.quadUV(c0[0], c0[1], c0[2], across, [dir[0], 0, dir[2]], W / 4 - 0.2, 0.22, A.paint, PAL.white);
        }
      }
    }
    // height of the approach surface at a point beside the road, a given distance from the bed edge
    const surfaceAt = (sd, d) => { const R2 = rampY[sd < 0 ? 0 : 1]; const t = ease(Math.min(1, d / R2.RL)); const m = [(R2.e0[0] + R2.e1[0]) / 2 + R2.dir[0] * d, (R2.e0[2] + R2.e1[2]) / 2 + R2.dir[2] * d]; const y0 = (R2.e0[1] + R2.e1[1]) / 2; return y0 + (R2.hAt(m[0], m[1]) - y0) * t; };
    yield;
    // gates, flashers, crossbucks, bells: one mast on the right of each approach; pedestrian gates on sidewalks
    const mat = infraMaterial(false); c.mat = mat;
    const root = new THREE.Group(); root.position.set(ox, 0, oz); root.visible = false; c.root = root; c.lifts = [];
    for (const sd of [-1, 1]) {
      const le = sd < 0 ? aL - 2.3 : aR + 2.3; const d = [-ux * sd, 0, -uz * sd];           // traffic direction toward the tracks
      const rgt = [-d[2], 0, d[0]];                                                          // right of the approaching traffic
      const mid = P(le, (vEdge(le, -1) + vEdge(le, 1)) / 2, 0);
      const base = [mid[0] - d[0] * 3.6 + rgt[0] * (W / 2 + 0.75), 0, mid[2] - d[2] * 3.6 + rgt[2] * (W / 2 + 0.75)];
      base[1] = surfaceAt(sd, 3.6) + 0.12;
      const bx = base[0], by = base[1], bz = base[2];
      mb.cyl(bx, by - 0.4, bz, bx, by + 0.12, bz, 0.34, 0.32, 10, PAL.concreteOld, false, true);
      mb.cyl(bx, by + 0.1, bz, bx, by + 4.75, bz, 0.105, 0.095, 10, PAL.galv, false, true);
      mb.box(bx - rgt[0] * 0.28, by + 1.0, bz - rgt[2] * 0.28, d, UP, rgt, 0.17, 0.52, 0.15, PAL.steel);
      // flasher crossarm with lights front and back
      const xa = [rgt[0], 0, rgt[2]];
      mb.cyl(bx - xa[0] * 0.75, by + 3.1, bz - xa[2] * 0.75, bx + xa[0] * 0.75, by + 3.1, bz + xa[2] * 0.75, 0.035, 0.035, 5, PAL.galv);
      for (const [off, id] of [[-0.62, 1], [0.62, 2]]) for (const face of [-1, 1]) {
        const fd = [-d[0] * face, 0, -d[2] * face]; const cx = bx + xa[0] * off, cz = bz + xa[2] * off, cy = by + 3.1;
        mb.cyl(cx, cy, cz, cx + fd[0] * 0.03, cy, cz + fd[2] * 0.03, 0.3, 0.3, 14, PAL.black, false, true);
        mb.cyl(cx + fd[0] * 0.03, cy, cz + fd[2] * 0.03, cx + fd[0] * 0.13, cy, cz + fd[2] * 0.13, 0.13, 0.13, 10, PAL.black, false, false);
        mb.lamp = id; mb.cyl(cx + fd[0] * 0.12, cy, cz + fd[2] * 0.12, cx + fd[0] * 0.135, cy, cz + fd[2] * 0.135, 0.115, 0.115, 12, PAL.lensRed, false, true); mb.lamp = 0;
        mb.box(cx + fd[0] * 0.24, cy + 0.14, cz + fd[2] * 0.24, fd, UP, cross3(fd, UP), 0.14, 0.012, 0.14, PAL.black);
      }
      // crossbuck (text facing traffic, grey backs), track count plate, bell
      const f = [-d[0], 0, -d[2]], fr = norm3(cross3(UP, f));
      for (const [ang, R2] of [[Math.PI / 4, A.xbuckA], [-Math.PI / 4, A.xbuckB]]) {
        const ax = [fr[0] * Math.cos(ang), Math.sin(ang), fr[2] * Math.cos(ang)], ay = norm3(cross3(f, ax)); const cy = by + 4.2;
        mb.quadUV(bx + f[0] * 0.12, cy, bz + f[2] * 0.12, ax, ay, 0.61, 0.115, R2, [1, 1, 1, 0.5, 0]);
        mb.box(bx + f[0] * 0.105, cy, bz + f[2] * 0.105, ax, ay, f, 0.61, 0.115, 0.012, PAL.backPlate);
      }
      if (nL >= 2) mb.quadUV(bx + f[0] * 0.12, by + 3.62, bz + f[2] * 0.12, fr, UP, 0.39, 0.11, nL >= 3 ? A.tracks3 : A.tracks2, [1, 1, 1, 0.5, 0]);
      mb.cyl(bx, by + 4.75, bz, bx, by + 4.98, bz, 0.19, 0.04, 10, PAL.black, false, true);
      // cantilever flashers over wide roads
      if (W >= 14) {
        const reach = W / 2 - 0.3; const tip = [bx - rgt[0] * reach, by + 5.9, bz - rgt[2] * reach];
        mb.cyl(bx, by + 4.4, bz, bx, by + 6.1, bz, 0.12, 0.1, 8, PAL.galv, false, true);
        mb.cyl(bx, by + 5.9, bz, tip[0], tip[1], tip[2], 0.07, 0.06, 6, PAL.galv, false, true);
        for (let k = 1; k <= 2; k++) { const t = k / 2.6; const cx = bx - rgt[0] * reach * t, cz = bz - rgt[2] * reach * t, cy = by + 5.55;
          for (const [off, id] of [[-0.35, 1], [0.35, 2]]) { const lx = cx + rgt[0] * off, lz = cz + rgt[2] * off;
            mb.cyl(lx, cy, lz, lx + f[0] * 0.03, cy, lz + f[2] * 0.03, 0.28, 0.28, 12, PAL.black, false, true);
            mb.lamp = id; mb.cyl(lx + f[0] * 0.1, cy, lz + f[2] * 0.1, lx + f[0] * 0.115, cy, lz + f[2] * 0.115, 0.11, 0.11, 12, PAL.lensRed, false, true); mb.lamp = 0; } }
      }
      // the gate arm (and a pedestrian gate on the sidewalk side), each on its own pivot
      const addArm = (len, armDir, ped, px, py, pz) => {
        const pivot = new THREE.Group(); pivot.position.set(px, py, pz);
        const X = new THREE.Vector3(armDir[0], 0, armDir[2]).normalize(), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3().crossVectors(X, Y);
        pivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
        const lift = new THREE.Group(); pivot.add(lift);
        const arm = new THREE.Mesh(armGeometry(len, ped), mat); arm.castShadow = true; lift.add(arm);
        root.add(pivot); c.lifts.push(lift);
      };
      addArm(W / 2 + 0.25, [-rgt[0], 0, -rgt[2]], false, bx - rgt[0] * 0.3, by + 1.08, bz - rgt[2] * 0.3);
      if (side > 0) addArm(side + 0.1, [rgt[0], 0, rgt[2]], true, bx + rgt[0] * 0.25, by + 0.95, bz + rgt[2] * 0.25);
    }
    // crossing bungalow beside the tracks, clear of the road
    { const s = c.s + 16; Track.frame(s, F2); const lat = aR + 7.4; const x = F2.x + F2.rx * lat, z = F2.z + F2.rz * lat;
      if (!Terrain.isWater(x, z)) bungalow(mb, x - ox, Math.max(Terrain.h(x, z), F2.y - 3), z - oz, [-F2.rx, 0, -F2.rz], 2.4, 2.4, 2.5); }
    yield;
    const geo = mb.geometry(); if (geo) { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; root.add(m); }
    crossGroup.add(root); c.built = true; c.job = null;
  }
  function disposeCrossing(c) {
    if (c.root) { crossGroup.remove(c.root); c.root.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    if (c.mat) c.mat.dispose(); c.root = null; c.mat = null; c.lifts = []; c.built = false; c.job = null;
  }

  // ======================================================================================================
  // CHUNKS: far layer (bed + structures) and near layer (rails, droppers, fences, details), time-sliced jobs
  // ======================================================================================================
  const sampleRange = (s0, s1, step) => { const out = []; for (let s = s0; s < s1; s += step) out.push(s); out.push(s1); return out; };
  function chunk(ci) {
    let ch = chunks.get(ci);
    if (!ch) { const s0 = ci * CH, s1 = Math.min(Track.length, s0 + CH); Track.frame((s0 + s1) / 2, F); ch = { ci, s0, s1, ox: F.x, oz: F.z, sMid: (s0 + s1) / 2, ss: sampleRange(s0, s1, 5), far: null, near: null, farJob: null, nearJob: null, ensured: false, box: null }; chunks.set(ci, ch); }
    return ch;
  }
  function chunkBox(ch) {
    if (ch.box) return ch.box; let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let s = ch.s0; s <= ch.s1; s += 50) { Track.frame(s, F3); x0 = Math.min(x0, F3.x); x1 = Math.max(x1, F3.x); z0 = Math.min(z0, F3.z); z1 = Math.max(z1, F3.z); }
    return (ch.box = [x0 - 40, z0 - 40, x1 + 40, z1 + 40]);
  }
  function* farJob(ch) {
    const g = new THREE.Group(); g.position.set(ch.ox, 0, ch.oz); g.name = 'trk-far-' + ch.ci;
    g.add(buildBed(ch)); yield;
    const mb = new MB();
    let i = 0; while (i < supports.length && supports[i].s < ch.s0) i++;
    for (; i < supports.length && supports[i].s < ch.s1; i++) buildSupport(mb, supports[i], ch.ox, ch.oz);
    yield;
    buildWires(mb, null, ch); yield;
    for (const e of signals) if (e.s >= ch.s0 && e.s < ch.s1) buildSignalStatic(mb, e, ch.ox, ch.oz);
    buildBungalows(mb, ch); yield;
    for (const t of Track.feat.tunnels) if (t[1] > ch.s0 && t[0] < ch.s1) buildTunnel(mb, ch, t[0], t[1]);
    for (const b of Track.feat.bridges) if (b[1] > ch.s0 && b[0] < ch.s1) buildBridge(mb, ch, b[0], b[1]);
    yield;
    const geo = mb.geometry(); if (geo) { const m = new THREE.Mesh(geo, M.infra); m.castShadow = true; m.receiveShadow = true; g.add(m); }
    ch.far = g; ch.farJob = null; group.add(g);
  }
  function* nearJob(ch) {
    const g = new THREE.Group(); g.position.set(ch.ox, 0, ch.oz); g.name = 'trk-near-' + ch.ci;
    const mb = new MB(); buildRails(mb, ch); yield;
    buildWires(null, mb, ch); yield;
    const fb = new FenceB(); buildFence(mb, fb, ch); yield;
    buildTrough(mb, ch); buildSmall(mb, ch); yield;
    const geo = mb.geometry(); if (geo) { const m = new THREE.Mesh(geo, M.infra); m.castShadow = true; m.receiveShadow = true; g.add(m); }
    const fm = fb.mesh(); if (fm) g.add(fm);
    ch.near = g; ch.nearJob = null; group.add(g);
  }
  const disposeGroup = (g) => { if (!g) return; group.remove(g); g.traverse(o => { if (o.geometry) o.geometry.dispose(); }); };
  const jobs = [];    // { gen, d, owner, kind }
  function runJobs() {
    const t0 = performance.now(); jobs.sort((a, b) => a.d - b.d);
    while (jobs.length && performance.now() - t0 < BUDGET) {
      const j = jobs[0]; let r;
      try { r = j.gen.next(); } catch (e) { console.error('trackgeo job', j.kind, e); r = { done: true }; if (j.kind === 'far') j.owner.farJob = null; else if (j.kind === 'near') j.owner.nearJob = null; else j.owner.job = null; j.owner.failed = true; }
      if (r.done) jobs.shift();
    }
  }
  function dropJob(owner, kind) { for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].owner === owner && jobs[i].kind === kind) jobs.splice(i, 1); }

  // ---------- far line (aerial ribbon) only when there is no aerial photo to show the right-of-way ----------
  const farPieces = [];
  function buildFarLine() {
    const ss = sampleRange(0, Track.length, 25); const per = 80; const mat = new THREE.MeshLambertMaterial({ color: 0x5e5a54 });
    for (let st = 0; st < ss.length - 1; st += per) {
      const sub = ss.slice(st, Math.min(ss.length, st + per + 1)); Track.frame(sub[Math.floor(sub.length / 2)], F); const ox = F.x, oz = F.z;
      const mb = new MB(); mb.sweep(sub, (s) => { const [lo, hi] = bedSpan(s); return [[lo - 1.5, -1.25, (lo + hi) / 2, -0.75, PAL.concreteOld], [(lo + hi) / 2, -0.75, hi + 1.5, -1.25, PAL.concreteOld]]; }, ox, oz);
      const m = new THREE.Mesh(mb.geometry(), mat); m.position.set(ox, 0, oz); group.add(m); farPieces.push({ m, s0: sub[0], s1: sub[sub.length - 1] });
    }
  }

  // ======================================================================================================
  // PER FRAME
  // ======================================================================================================
  function update(camPos, dt) {
    const near = Track.nearest(camPos.x, camPos.z, 6000);
    if (!near) { updateTies(0, 1e9); for (const p of farPieces) p.m.visible = true; runJobs(); return; }
    const camS = near.s; const dist = Math.hypot(near.dist, Math.max(0, camPos.y - Track.yAt(camS)));
    const alt = camPos.y - Terrain.h(camPos.x, camPos.z);
    for (const p of farPieces) p.m.visible = !(dist < NEAR && alt < 900 && p.s1 > camS - 700 && p.s0 < camS + 700);
    // chunks wanted around the camera
    if (dist < NEAR) {
      const r = Math.max(600, NEAR - dist);
      for (let ci = Math.max(0, Math.floor((camS - r) / CH)); ci <= Math.floor((camS + r) / CH) && ci * CH < Track.length; ci++) {
        const ch = chunk(ci); const dAlong = Math.max(0, Math.abs(ch.sMid - camS) - CH / 2); const d = Math.hypot(dAlong, dist);
        if (!ch.far && !ch.farJob && !ch.failed) {
          const bb = chunkBox(ch);
          if (Terrain.hasDetail(bb[0], bb[1], bb[2], bb[3])) { ch.farJob = farJob(ch); jobs.push({ gen: ch.farJob, d, owner: ch, kind: 'far' }); }
          else if (!ch.ensured) { ch.ensured = true; Terrain.ensure(bb[0], bb[1], bb[2], bb[3], 2); }
        }
        if (ch.far && !ch.near && !ch.nearJob && d < DETAIL_IN) { ch.nearJob = nearJob(ch); jobs.push({ gen: ch.nearJob, d: d + 50, owner: ch, kind: 'near' }); }
        for (const j of jobs) if (j.owner === ch) j.d = d + (j.kind === 'near' ? 50 : 0);
      }
    }
    for (const [ci, ch] of chunks) {
      const dAlong = Math.max(0, Math.abs(ch.sMid - camS) - CH / 2); const d = Math.hypot(dAlong, dist);
      if (Math.abs(ch.sMid - camS) > FAR || dist > FAR) { dropJob(ch, 'far'); dropJob(ch, 'near'); disposeGroup(ch.far); disposeGroup(ch.near); chunks.delete(ci); continue; }
      if (ch.near && d > DETAIL_OUT) { disposeGroup(ch.near); ch.near = null; }
      if (ch.nearJob && d > DETAIL_OUT) { dropJob(ch, 'near'); ch.nearJob = null; }
    }
    // crossings near the camera
    for (const c of crossings) {
      const d = Math.hypot(c.x - camPos.x, c.z - camPos.z);
      if (!c.built && !c.job && !c.failed && d < XING_IN && Terrain.hasDetail(c.x - 40, c.z - 40, c.x + 40, c.z + 40)) { c.job = buildCrossing(c); jobs.push({ gen: c.job, d: d * 0.8, owner: c, kind: 'xing' }); }
      else if (c.built && d > XING_OUT) disposeCrossing(c);
      else if (c.job && d > XING_OUT) { dropJob(c, 'xing'); c.job = null; }
    }
    runJobs();
    updateTies(camS, dist);
  }
  function updateDynamic(dt, trains, camPos) {
    for (const c of crossings) {
      let act = false;
      for (const tr of trains) { const ahead = (c.s - tr.s) * (tr.dir ? 1 : -1); if (ahead > -(tr.len || 200) - 8 && ahead < Math.max(320, tr.v * 30)) { act = true; break; } }
      c.active = act;
      if (!c.built) { c.t = act ? 1 : 0; continue; }
      c.root.visible = Math.abs(c.x - camPos.x) < XING_OUT && Math.abs(c.z - camPos.z) < XING_OUT;
      c.t = U.clamp(c.t + (act ? dt / 6 : -dt / 8), 0, 1);
      const down = U.smooth(0.2, 1, c.t); for (const l of c.lifts) l.rotation.z = (1 - down) * 1.52;
      c.mat.userData.u.uActive.value = (act || c.t > 0.02) ? 1 : 0;
    }
    for (const sg of signals) {
      let occ = 1e9;
      for (const tr of trains) { if (tr.dir !== sg.dir) continue; const beyond = (tr.s - sg.s) * (sg.dir ? 1 : -1); if (beyond > 4 && beyond < occ) occ = beyond; }
      const st = occ < 1500 ? 0 : occ < 3200 ? 1 : 2;
      if (st !== sg.state) { sg.state = st; sg.lamp.material.userData.u.uAspect.value = st; }
      const dx = sg.x - camPos.x, dz = sg.z - camPos.z; sg.lamp.visible = dx * dx + dz * dz < 2600 * 2600;
    }
  }
  // aspect a driver sees for the next signal ahead of s in direction dir: {dist, aspect 0 red..2 green, s}
  function nextSignal(s, dir) { let best = null, bd = 4000; for (const sg of signals) { if (sg.dir !== dir) continue; const d = (sg.s - s) * (dir ? 1 : -1); if (d > 0 && d < bd) { bd = d; best = sg; } } return best ? { dist: bd, aspect: best.state < 0 ? 2 : best.state, s: best.s } : null; }
  const _cn = []; function crossingsNear(pos, r) { _cn.length = 0; for (const c of crossings) { const d = Math.hypot(c.x - pos.x, c.z - pos.z); if (d < r) _cn.push({ dist: d, active: c.active }); } return _cn; }
  function prebuild(s, radius) {
    for (let ci = Math.max(0, Math.floor((s - radius) / CH)); ci <= Math.floor((s + radius) / CH) && ci * CH < Track.length; ci++) {
      const ch = chunk(ci); if (!ch.far) { dropJob(ch, 'far'); const gen = farJob(ch); ch.farJob = gen; while (!gen.next().done); }
      if (!ch.near) { dropJob(ch, 'near'); const gen = nearJob(ch); ch.nearJob = gen; while (!gen.next().done); }
    }
  }
  function init() {
    makeAtlas(); M.infra = infraMaterial(false); M.bed = bedMaterial(); M.fence = fenceMaterial();
    Env.scene.add(group);
    planRuns(); planSupports(); planSignals(); planCrossings();
    if (!Terrain.tiled) buildFarLine();
  }
  return { init, update, updateDynamic, crossingsNear, nextSignal, prebuild, group, bedSpan, stats: () => ({ chunks: chunks.size, jobs: jobs.length, crossings: crossings.filter(c => c.built).length, signals: signals.length, runs: runs.length, supports: supports.length }) };
})();
