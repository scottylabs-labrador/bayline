// Shared helpers. build.py concatenates every src/js/*.js file (sorted by name) into ONE function
// scope, so top-level consts declared here are visible to every later file. No imports/exports.
const U = (() => {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const invLerp = (a, b, v) => (v - a) / (b - a);
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const TAU = Math.PI * 2, DEG = Math.PI / 180;
  const wrapAngle = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };

  // mulberry32: fast seeded PRNG in [0,1)
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  // integer hash -> [0,1)
  function hash2(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // 2D simplex noise, output about [-1,1]
  const noise2 = (() => {
    const p = new Uint8Array(512); const r = rng(1337); const q = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
    for (let i = 0; i < 512; i++) p[i] = q[i & 255];
    const g = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
    const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
    return (x, y) => {
      const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s), t = (i + j) * G2;
      const x0 = x - (i - t), y0 = y - (j - t), i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
      const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
      const ii = i & 255, jj = j & 255; let n = 0;
      let t0 = 0.5 - x0 * x0 - y0 * y0; if (t0 > 0) { const gg = g[p[ii + p[jj]] & 7]; t0 *= t0; n += t0 * t0 * (gg[0] * x0 + gg[1] * y0); }
      let t1 = 0.5 - x1 * x1 - y1 * y1; if (t1 > 0) { const gg = g[p[ii + i1 + p[jj + j1]] & 7]; t1 *= t1; n += t1 * t1 * (gg[0] * x1 + gg[1] * y1); }
      let t2 = 0.5 - x2 * x2 - y2 * y2; if (t2 > 0) { const gg = g[p[ii + 1 + p[jj + 1]] & 7]; t2 *= t2; n += t2 * t2 * (gg[0] * x2 + gg[1] * y2); }
      return 70 * n;
    };
  })();
  const fbm2 = (x, y, oct = 4, lac = 2, gain = 0.5) => { let a = 0, amp = 1, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { a += amp * noise2(x * f, y * f); norm += amp; amp *= gain; f *= lac; } return a / norm; };

  // Merge BufferGeometries that share the same attribute names (indexed or not). Keeps groups off.
  function mergeGeometries(geos) {
    geos = geos.filter(Boolean); if (!geos.length) return new THREE.BufferGeometry();
    const names = Object.keys(geos[0].attributes); const indexed = geos.some(g => g.index);
    const out = new THREE.BufferGeometry(); let vtot = 0, itot = 0;
    for (const g of geos) { vtot += g.attributes.position.count; itot += g.index ? g.index.count : g.attributes.position.count; }
    for (const n of names) {
      const a0 = geos[0].attributes[n]; const arr = new a0.array.constructor(vtot * a0.itemSize); let off = 0;
      for (const g of geos) { const a = g.attributes[n]; if (!a) throw new Error('mergeGeometries: missing attribute ' + n); arr.set(a.array, off); off += a.array.length; }
      out.setAttribute(n, new THREE.BufferAttribute(arr, a0.itemSize, a0.normalized));
    }
    if (indexed) { const idx = new (vtot > 65535 ? Uint32Array : Uint16Array)(itot); let io = 0, vo = 0;
      for (const g of geos) { const c = g.attributes.position.count;
        if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.array[i] + vo; else for (let i = 0; i < c; i++) idx[io++] = i + vo;
        vo += c; }
      out.setIndex(new THREE.BufferAttribute(idx, 1)); }
    return out;
  }
  // Bake a transform into a geometry copy (for merging many parts into one mesh).
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  function place(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
    const g = geo.clone(); _q.setFromEuler(_e.set(rx, ry, rz)); _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz)); g.applyMatrix4(_m); return g;
  }
  // Add a constant vertex color to a geometry (so differently colored parts can share one material).
  function tint(geo, color) { const c = new THREE.Color(color); const n = geo.attributes.position.count; const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } geo.setAttribute('color', new THREE.BufferAttribute(a, 3)); return geo; }
  function canvasTexture(w, h, draw, opts = {}) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d'); draw(ctx, w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.anisotropy = opts.aniso || 4; if (opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; } if (opts.nearest) { t.magFilter = THREE.NearestFilter; }
    t.userData.canvas = c; t.userData.ctx = ctx; return t;
  }
  // Shared uniforms that custom shaders may reference (updated once per frame by the engine).
  const uNight = { value: 0 };   // 0 = full day, 1 = full night
  const uTime = { value: 0 };    // seconds since page start (for animation)
  const uWind = { value: 0.4 };  // 0..1
  return { clamp, lerp, invLerp, smooth, TAU, DEG, wrapAngle, rng, hash2, hashStr, noise2, fbm2,
           mergeGeometries, place, tint, canvasTexture, uNight, uTime, uWind };
})();
