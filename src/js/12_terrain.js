// Terrain v2: streamed, chunked-LOD photoreal ground. A camera-driven quadtree over the SPEC_v2 tile grid
// (L0 102.4 km … L9 200 m) draws one mesh per node; each node uses the finest data loaded at or above it:
// NAIP imagery (L0–9), 129² heights (L0–7, plus the optional lidar detail layer tiles/h9 at L8 3.1 m and L9 1.6 m)
// and 128² masks (L0–7), with the v1 64 m field as the ultimate fallback, so the view sharpens progressively like a
// globe viewer and never shows holes.
// API (SPEC_v2): load, h, hBase, hasDetail, ensure, imagery, retain, release, isWater, urbanAt, maskAt,
//                update(camera), setTownFade (no-op in v2), setFine, group/mesh, info, lodFactor, stats.
// Heights: h(x, z) is the finest loaded surface (what the near terrain draws). hBase(x, z) = h(x, z, 7) is the base
// surface the lidar layer never changes under roads, track, platforms and runways: street geometry is built on it.
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
  // lidar detail heights (tiles/h9/index.json, optional): { 8: Set, 9: Set, off: L8 key -> height offset o, qs }
  // (h = q / qs + o). Without it HMAX stays 7 and everything behaves as before. #h9=0 turns it off (QA: the base
  // terrain, bit for bit).
  let h9 = null, HMAX = LH;
  function hExists(L, x, y) { return L <= LH ? exists(L, x, y) : !!(h9 && h9[L] && h9[L].has(K(L, x, y))); }
  // ground materials (tiles/mat/index.json, optional): Set of L7 keys with a 512² class map (what the ground is, per 1.56 m:
  // lawn, dry grass, gravel, asphalt ...), used for the near-ground detail and by GroundCover. #mat=0 turns it off.
  let mat = null;

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
    if (index && new URLSearchParams(location.hash.slice(1)).get('h9') !== '0') {
      try {
        const hi = await Stream.json('tiles/h9/index.json', 0);
        const s8 = new Set(), s9 = new Set(), off = new Map();
        for (const [x, y, m, o] of hi.l8 || []) { s8.add(K(8, x, y)); off.set(K(8, x, y), o || 0); for (let b = 0; b < 4; b++) if (m & (1 << b)) s9.add(K(9, 2 * x + (b & 1), 2 * y + (b >> 1))); }
        h9 = { 8: s8, 9: s9, off, qs: (hi.q && hi.q.scale) || 64, attribution: hi.attribution };
        HMAX = s9.size ? 9 : 8;
      } catch (e) { h9 = null; HMAX = LH; }                // not published (yet): base terrain only
    }
    if (index && new URLSearchParams(location.hash.slice(1)).get('mat') !== '0') {
      try { const mi = await Stream.json('tiles/mat/index.json', 0); mat = new Set((mi.tiles || []).map(([x, y]) => K(LH, x, y))); if (!mat.size) mat = null; }
      catch (e) { mat = null; }
    }
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
  function decodeHeights(u8, qs = 16, qo = 200) {   // MED-predicted zigzag residuals (uint16) -> Float32 heights (h = q/qs - qo)
    const n = HS * HS; const res = new Uint16Array(u8.buffer, u8.byteOffset, n); const q = new Int32Array(n); const h = new Float32Array(n);
    for (let j = 0; j < HS; j++) for (let i = 0; i < HS; i++) {
      const k = j * HS + i; const zz = res[k]; const r = (zz >>> 1) ^ -(zz & 1); let a, b, c;
      if (j === 0 && i === 0) { q[k] = r; continue; }
      if (j === 0) { a = q[k - 1]; b = a; c = a; } else if (i === 0) { b = q[k - HS]; a = b; c = b; } else { a = q[k - 1]; b = q[k - HS]; c = q[k - HS - 1]; }
      const mx = a > b ? a : b, mn = a < b ? a : b; q[k] = r + (c >= mx ? mn : (c <= mn ? mx : a + b - c));
    }
    let mn = 1e9, mx = -1e9; for (let k = 0; k < n; k++) { const v = q[k] / qs - qo; h[k] = v; if (v < mn) mn = v; if (v > mx) mx = v; }
    return { h, mn, mx };
  }
  function needHgt(L, x, y, prio) {     // L0–7: tiles/h; L8–9: the lidar layer tiles/h9 (callers check hExists)
    const k = K(L, x, y); let r = hrec.get(k);
    if (r) { r.used = frameNo; return r.p; }
    r = { L, x, y, state: 1, used: frameNo, h: null, tex: null, mn: 0, mx: 0, refs: 0 }; hrec.set(k, r);
    const lidar = L > LH;
    r.path = lidar ? `tiles/h9/${L}/${x}_${y}.bin` : `tiles/h/${L}/${x}_${y}.bin`;
    r.p = Stream.bin(r.path, prio).then((u8) => {
      if (u8.length < HS * HS * 2) throw new Error('short height tile');
      const d = lidar && h9 ? decodeHeights(u8, h9.qs, -(h9.off.get(K(8, x >> (L - 8), y >> (L - 8))) || 0)) : decodeHeights(u8);
      r.h = d.h; r.mn = d.mn; r.mx = d.mx; r.base = d.mn;
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
  const MATN = 512, matRec = new Map();
  let matDummy = null;
  function needMat(x, y, prio) {                     // L7 class map -> R8 texture (nearest) + the CPU copy for queries
    const k = K(LH, x, y); let r = matRec.get(k);
    if (r) { r.used = frameNo; return r; }
    r = { L: LH, x, y, state: 1, used: frameNo, m: null, tex: null }; matRec.set(k, r);
    r.path = `tiles/mat/${LH}/${x}_${y}.bin`;
    Stream.bin(r.path, prio + 1.5).then((u8) => {
      if (u8.length < MATN * MATN) throw new Error('short material tile');
      r.m = u8; const t = new THREE.DataTexture(u8, MATN, MATN, THREE.RedFormat, THREE.UnsignedByteType);
      t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; r.tex = t; r.state = 2;
    }, () => { r.state = 3; });
    return r;
  }
  // ground material class at a point (0 none .. 15, see tools/tiles/materials.py), or -1 while its tile isn't loaded
  function materialAt(x, z) {
    if (!mat) return -1; const T7 = tileSize(LH), tx = Math.floor((x - X0) / T7), ty = Math.floor((z - Z0) / T7);
    const r = matRec.get(K(LH, tx, ty)); if (!r || r.state !== 2) return -1;
    const i = U.clamp(Math.floor((x - X0 - tx * T7) / T7 * MATN), 0, MATN - 1), j = U.clamp(Math.floor((z - Z0 - ty * T7) / T7 * MATN), 0, MATN - 1);
    return r.m[j * MATN + i];
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
  let geo = null, geoFine = null, fine = false; const matPool = []; const nodes = [];
  // node mesh: G x G quads over a unit square (x, z in -0.5..0.5) plus a skirt ring (y = 1 marks the skirt vertices)
  function buildGeo(G) {
    const pos = [], idx = []; const V = G + 1;
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) pos.push(i / G - 0.5, 0, j / G - 0.5);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { const a = j * V + i, b = a + 1, c = a + V, d = c + 1; idx.push(a, c, b, b, c, d); }
    const ring = []; for (let i = 0; i < G; i++) ring.push(i); for (let j = 0; j < G; j++) ring.push(j * V + G);
    for (let i = G; i > 0; i--) ring.push(G * V + i); for (let j = G; j > 0; j--) ring.push(j * V);
    const base = pos.length / 3; for (const r of ring) pos.push(pos[r * 3], 1, pos[r * 3 + 2]);
    for (let k = 0; k < ring.length; k++) { const a = ring[k], b = ring[(k + 1) % ring.length], a2 = base + k, b2 = base + (k + 1) % ring.length; idx.push(a, b, a2, b, b2, a2); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    return g;
  }
  function buildShared() {
    geo = buildGeo(G);
    try { maxAniso = Math.min(12, Env.renderer.capabilities.getMaxAnisotropy()); } catch (e) {}
  }
  // Ultra+: lidar nodes (L8/L9) get 128x128 quads, so on L9 every vertex sits on a 1.56 m lidar sample
  function setFine(on) { fine = !!on; if (fine && !geoFine && geo) geoFine = buildGeo(G * 2); }
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
  // ---------- water surface shared by the Bayline terrain and the Globe ----------
  // blWater: tint by depth, wind waves from the LEAN slope map (three scales, gusts drifting downwind, damped in the
  // shallows), roughness from the unresolved slope variance (sun glitter widens with distance), and on ocean coasts
  // whitewater lines rolling in over the shoaling bottom plus the swash on the sand.
  //   p = world xz, depth (m), water weight, fwq = pixel footprint (m), fwDepth = fwidth(depth), ocean/sea 0..1
  const WATER_GLSL = () => `
    #ifndef BL_WATER
    #define BL_WATER
    uniform sampler2D uWaveN; uniform float uWindW; uniform float uWaveT;
    float wth(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float wtn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(wth(i), wth(i+vec2(1,0)), f.x), mix(wth(i+vec2(0,1)), wth(i+vec2(1,1)), f.x), f.y); }
    // (fw = metres per pixel). Once a tile covers only a few dozen pixels its mip still holds the longest waves,
    // which would repeat tile after tile as a lattice of glints, so the slope is folded into the variance there
    vec3 waveLayer(vec2 q, float c, float s, float size, float v, float fw) {
      vec4 w = texture2D(uWaveN, vec2(c * q.x + s * q.y, -s * q.x + c * q.y) / size - vec2(v, 0.0));
      vec2 m = (w.rg * 2.0 - 1.0) * ${WAVE_S.toFixed(1)};
      float vr = max(w.b * ${(2 * WAVE_S * WAVE_S).toFixed(1)} - dot(m, m), 0.0);
      float res = smoothstep(12.0, 56.0, size / max(fw, 1e-4));
      vr += dot(m, m) * (1.0 - res); m *= res;
      return vec3(c * m.x - s * m.y, s * m.x + c * m.y, vr);
    }
    void blWater(vec2 p, float depth, float water, float fwq, float fwDepth, float ocean, float sea, inout vec3 col, inout vec3 nW, inout float rough) {
      float time = uWaveT;
      vec3 deep = vec3(0.035, 0.085, 0.11), shallow = col * 0.55;
      // deep water converges on one tone whatever the photo source (NAIP no-data fill, Sentinel-2 ocean)
      col = mix(col, mix(shallow, deep, smoothstep(0.0, 12.0, depth)), water * mix(0.8, 0.97, smoothstep(8.0, 25.0, depth)));
      vec2 wd = vec2(0.8, 0.6), wq = vec2(dot(p, wd), dot(p, vec2(-wd.y, wd.x)));
      float gust = wtn(wq / 460.0 - vec2(time * 0.011, 0.0)) * 0.65 + wtn(wq / 110.0 - vec2(time * 0.045, 0.0)) * 0.35;
      float amp = (0.35 + 1.25 * uWindW) * (0.3 + 1.4 * gust * gust) * mix(0.55, smoothstep(-0.3, 1.5, depth), sea) * (1.0 + 0.7 * ocean);
      vec3 l1 = waveLayer(wq, 1.0, 0.0, 6.1, time * 0.26, fwq);
      vec3 l2 = waveLayer(wq, 0.94, 0.34, 19.0, time * 0.105, fwq);
      vec3 l3 = waveLayer(wq, 0.9, -0.44, 57.0, time * 0.052, fwq);
      vec3 a3 = vec3(0.058, 0.066, 0.05) * amp;
      vec2 sw = l1.xy * a3.x + l2.xy * a3.y + l3.xy * a3.z;
      float vu = l1.z * a3.x * a3.x + l2.z * a3.y * a3.y + l3.z * a3.z * a3.z;
      sw = sw.x * wd + sw.y * vec2(-wd.y, wd.x);
      nW = normalize(mix(nW, normalize(vec3(-sw.x, 1.0, -sw.y)), water));
      rough = mix(rough, sqrt(sqrt(0.0007 * amp + vu)), water);
      if (ocean > 0.01) {
        float zone = smoothstep(0.15, 0.8, depth) * (1.0 - smoothstep(4.5, 8.0, depth));
        float n1 = wtn(p / 70.0 + vec2(time * 0.01, 0.0)), n2 = wtn(p / 17.0 + vec2(0.0, time * 0.03));
        float ph = depth * 3.6 + time * 0.55 + n1 * 2.4;
        float sp = sin(ph), band = smoothstep(0.45, 0.9, sp) + 0.4 * smoothstep(-0.3, 0.8, sin(ph + 0.9)) * (1.0 - smoothstep(0.45, 0.9, sp));
        band *= 0.5 + 0.75 * n2;
        band = mix(band, 0.3 * (0.5 + 0.75 * n2), smoothstep(0.5, 1.4, fwDepth * 3.6));
        // (a depth of exactly 0 means no bathymetry here, e.g. coarse fallback heights clamped to sea level: no swash)
        float swash = smoothstep(0.02, 0.1, depth) * (1.0 - smoothstep(0.1, 0.9, depth)) * (0.55 + 0.45 * sin(time * 0.35 + n1 * 6.0));
        float foam = clamp(max(band * zone, swash), 0.0, 1.0) * ocean * water;
        col = mix(col, vec3(0.9, 0.92, 0.92), foam * 0.92);
        nW = normalize(mix(nW, vec3(0.0, 1.0, 0.0), foam));
        rough = mix(rough, 0.7, foam);
      }
    }
    #endif`;
  const GTILE = 2.5;
  let groundTex = null, groundTex2 = null;
  // tileable grey-scale pattern painter shared by the detail textures (one seeded RNG each, so they are deterministic)
  function detailPainter(N, seed) {
    const M = N - 1, r = U.rng(seed), C = [0, 1, 2, 3].map(() => new Float32Array(N * N).fill(0.5));
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
    // each channel to mean 0.5 and standard deviation sd[c], then one mipmapped RGBA texture
    const pack = (sd) => {
      const d = new Uint8Array(N * N * 4);
      for (let c = 0; c < 4; c++) {
        const a = C[c]; let m = 0, v = 0; for (let i = 0; i < N * N; i++) m += a[i]; m /= N * N;
        for (let i = 0; i < N * N; i++) v += (a[i] - m) ** 2; const k = sd[c] / Math.sqrt(v / (N * N));
        for (let i = 0; i < N * N; i++) d[i * 4 + c] = Math.max(0, Math.min(255, Math.round(((a[i] - m) * k + 0.5) * 255)));
      }
      const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
      t.anisotropy = maxAniso; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
      return t;
    };
    return { N, M, r, C, vnoise, grain, disc, blade, ri, pack };
  }
  // ---------- eye-level ground detail: four tileable grey-scale patterns in one mipmapped texture ----------
  // R asphalt (aggregate), G dirt (grit and pebbles), B grass (blades over soil), A concrete (speckle and voids): 512 px
  // over a 2.5 m tile (5 mm/px). Each channel has mean 0.5 and modulates the photo's local colour; mipmaps and
  // anisotropic filtering band-limit it at any distance.
  function groundDetailTexture() {
    if (groundTex) return groundTex;
    const { N, r, C, vnoise, grain, disc, blade, ri, pack } = detailPainter(512, 4242);
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
    return (groundTex = pack([0.085, 0.11, 0.13, 0.06]));
  }
  // second set, for the ground material classes (tiles/mat): R gravel / ballast (rounded stones with contact shadows),
  // G dry grass (long straw over bare soil), B sand (grain and wind ripples), A leaf litter (leaves and twigs), same scale
  function groundDetail2Texture() {
    if (groundTex2) return groundTex2;
    const { N, r, C, vnoise, grain, disc, blade, ri, pack } = detailPainter(512, 5151);
    { const a = C[0]; a.fill(0.34); vnoise(a, 6, 0.04); grain(a, 0.05);
      for (let i = 0; i < 5200; i++) disc(a, ri(), ri(), 2.2 + Math.pow(r(), 1.6) * 5.5, 0.42 + 0.34 * r(), 0.16, 0.12); }
    { const a = C[1]; a.fill(0.36); vnoise(a, 5, 0.06); vnoise(a, 24, 0.04); grain(a, 0.05);
      for (let i = 0; i < 9000; i++) { const ang = r() * 6.2832; blade(a, r() * N, r() * N, ang, 10 + r() * 24, 0.58 + 0.3 * r()); } }
    { const a = C[2]; vnoise(a, 4, 0.04); grain(a, 0.09);
      const w = new Float32Array(N * N); vnoise(w, 3, 1.0);            // (tileable warp of the ripples)
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) a[y * N + x] += 0.06 * Math.sin(6.2832 * (9 * (x + 0.35 * y) / N) + 2.2 * w[y * N + x]); }
    { const a = C[3]; a.fill(0.3); vnoise(a, 7, 0.06); grain(a, 0.04);
      for (let i = 0; i < 2600; i++) { const cx = ri(), cy = ri(), ang = r() * 6.2832, L = 4 + r() * 7, v = 0.35 + 0.45 * r();
        for (let t = -L; t <= L; t += 0.8) { const wdt = Math.max(0.5, (1 - (t / L) ** 2) * L * 0.45); disc(a, Math.round(cx + Math.cos(ang) * t), Math.round(cy + Math.sin(ang) * t), wdt * 0.5, v); } }
      for (let i = 0; i < 500; i++) blade(a, r() * N, r() * N, r() * 6.2832, 12 + r() * 20, 0.2); }
    return (groundTex2 = pack([0.13, 0.12, 0.05, 0.11]));
  }
  function matDummyTex() {
    if (!matDummy) { matDummy = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType); matDummy.minFilter = matDummy.magFilter = THREE.NearestFilter; matDummy.needsUpdate = true; }
    return matDummy;
  }
  function makeMaterial() {
    const u = {
      hTex: { value: texFH }, hUV: { value: new THREE.Vector4(0, 0, 1, 1) }, hTC: { value: new THREE.Vector2(1, 0) }, hInfo: { value: new THREE.Vector3(0, 64, 1 / 1600) },
      iTex: { value: null }, iUV: { value: new THREE.Vector4(0, 0, 1, 1) }, iHas: { value: 0 }, iTexel: { value: 1.0 },
      mTex: { value: texFM }, mUV: { value: new THREE.Vector4(0, 0, 1, 1) }, mTC: { value: new THREE.Vector2(1, 0) },
      skirt: { value: 4 }, nodeSize: { value: 1000 }, night: U.uNight, time: U.uTime, uWaveN: { value: waveTexture() }, uWindW: U.uWind, uWaveT: U.uTime, uGround: { value: groundDetailTexture() },
      uMat: { value: matDummyTex() }, uMatUV: { value: new THREE.Vector4(0, 0, 1, 1) }, uMatOn: { value: 0 }, uGround2: { value: mat ? groundDetail2Texture() : groundDetailTexture() },
    };
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0.0, envMapIntensity: 0.5 });
    m.userData.u = u;
    m.customProgramCacheKey = () => 'bayline-terrain-v4';
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D hTex; uniform vec4 hUV; uniform vec2 hTC; uniform vec3 hInfo; uniform float skirt;
          varying vec3 vW; varying vec2 vUV;`)
        .replace('#include <beginnormal_vertex>', `
          vec2 uvn = position.xz + 0.5;
          // the heights carry bathymetry (the Golden Gate is ~110 m deep): open water is drawn at sea level, while the
          // fragment shader still reads the true depth for the water colour
          float hq = max(texture2D(hTex, (hUV.xy + uvn * hUV.zw) * hTC.x + hTC.y).r + hInfo.x, 0.0);
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
          uniform float night; uniform float time; uniform sampler2D uGround;
          uniform sampler2D uMat; uniform vec4 uMatUV; uniform float uMatOn; uniform sampler2D uGround2;
          ${WATER_GLSL()}
          // ground material class (tiles/mat) -> surface weights: A = (asphalt, concrete, grass, soil),
          // B = (dry grass, gravel, sand, leaf litter). 0 none, 1 lawn, 2 dry grass, 3 shrub, 4 leaf litter, 5 soil, 6 gravel,
          // 7 asphalt, 8 concrete, 9 roof, 10 sand, 11 rock, 12 water, 13 marsh, 14 salt pond, 15 farmland
          const vec4 MAT_A[16] = vec4[16](vec4(0.0), vec4(0.0, 0.0, 1.0, 0.0), vec4(0.0), vec4(0.0, 0.0, 0.6, 0.4), vec4(0.0, 0.0, 0.0, 0.3), vec4(0.0, 0.0, 0.0, 1.0),
            vec4(0.0), vec4(1.0, 0.0, 0.0, 0.0), vec4(0.0, 1.0, 0.0, 0.0), vec4(0.0, 1.0, 0.0, 0.0), vec4(0.0), vec4(0.0, 0.0, 0.0, 0.5), vec4(0.0),
            vec4(0.0, 0.0, 0.7, 0.3), vec4(0.0, 0.0, 0.0, 0.5), vec4(0.0, 0.0, 0.0, 0.6));
          const vec4 MAT_B[16] = vec4[16](vec4(0.0), vec4(0.0), vec4(1.0, 0.0, 0.0, 0.0), vec4(0.0), vec4(0.0, 0.0, 0.0, 0.7), vec4(0.0),
            vec4(0.0, 1.0, 0.0, 0.0), vec4(0.0), vec4(0.0), vec4(0.0), vec4(0.0, 0.0, 1.0, 0.0), vec4(0.0, 0.5, 0.0, 0.0), vec4(0.0),
            vec4(0.0), vec4(0.0, 0.0, 0.5, 0.0), vec4(0.4, 0.0, 0.0, 0.0));
          // landcover code (mask A's scheme, for the mid-range detail) of each material class; 8 = gravel
          const float MAT_LC[16] = float[16](-1.0, 0.0, 0.0, 0.0, 7.0, 0.0, 8.0, 6.0, 6.0, 6.0, 4.0, 5.0, 0.0, 2.0, 3.0, 1.0);
          int matAt(ivec2 t) { return int(texelFetch(uMat, clamp(t, ivec2(0), ivec2(511)), 0).r * 255.0 + 0.5); }
          // four nearest class cells blended bilinearly (smooth 1.56 m boundaries), sampled through a small warp so the
          // edges between lawn, path and asphalt don't follow the grid; returns the dominant class too
          int matWeights(vec2 uv, vec2 jit, out vec4 wA, out vec4 wB) {
            vec2 p = (uMatUV.xy + uv * uMatUV.zw) * 512.0 - 0.5 + jit; vec2 f = fract(p); ivec2 i = ivec2(floor(p));
            int c0 = matAt(i), c1 = matAt(i + ivec2(1, 0)), c2 = matAt(i + ivec2(0, 1)), c3 = matAt(i + ivec2(1, 1));
            float w0 = (1.0 - f.x) * (1.0 - f.y), w1 = f.x * (1.0 - f.y), w2 = (1.0 - f.x) * f.y, w3 = f.x * f.y;
            wA = MAT_A[c0] * w0 + MAT_A[c1] * w1 + MAT_A[c2] * w2 + MAT_A[c3] * w3;
            wB = MAT_B[c0] * w0 + MAT_B[c1] * w1 + MAT_B[c2] * w2 + MAT_B[c3] * w3;
            float m = max(max(w0, w1), max(w2, w3));
            return m == w0 ? c0 : m == w1 ? c1 : m == w2 ? c2 : c3;
          }
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
`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            // ---- normal from the height data (per pixel) ----
            vec2 tc = (hUV.xy + vUV * hUV.zw) * hTC.x + hTC.y; float e = hInfo.z;
            float hl = texture2D(hTex, tc - vec2(e, 0.0)).r, hr = texture2D(hTex, tc + vec2(e, 0.0)).r;
            float hd = texture2D(hTex, tc - vec2(0.0, e)).r, hu = texture2D(hTex, tc + vec2(0.0, e)).r;
            hl = max(hl + hInfo.x, 0.0); hr = max(hr + hInfo.x, 0.0); hd = max(hd + hInfo.x, 0.0); hu = max(hu + hInfo.x, 0.0);   // sea level
            vec3 nW = normalize(vec3(hl - hr, 2.0 * hInfo.y, hd - hu));
            vec4 mk = texture2D(mTex, (mUV.xy + vUV * mUV.zw) * mTC.x + mTC.y);
            float water = smoothstep(0.45, 0.6, mk.r);
            float dcam = distance(vW, cameraPosition);
            vec2 qdx = dFdx(vW.xz), qdy = dFdy(vW.xz);                         // taken here, outside any branch
            float fwq = abs(qdx.x) + abs(qdy.x) + abs(qdx.y) + abs(qdy.y);
            // ---- albedo: the photograph (or a quiet fallback before it streams in) ----
            vec3 col; float nearK = 0.0;
            if (iHas > 0.5) {
              vec2 iuv = iUV.xy + vUV * iUV.zw;
              col = texture2D(iTex, iuv).rgb;
              // ---- near ground, at any camera height: the photo holds the colour down to its own resolution; below that,
              // what the ground IS (tiles/mat classes, or a guess from the photo) supplies its texture: fine detail,
              // mid-scale features (asphalt patches and cracks, concrete slab joints, grass clumps), and a bump normal.
              // Strength follows the photo's magnification on screen (a texel over more than ~1.5 pixels reads as blur).
              // Near a low camera (eye, cab, platform) the photo's baked-in cars, shadows and smears go altogether: the
              // surface is synthesized in the photo's local ~5 m colour.
              float lowCam = 1.0 - smoothstep(5.0, 16.0, cameraPosition.y - vW.y);
              float eye = lowCam * (1.0 - smoothstep(0.45, 0.6, mk.r)) * (1.0 - smoothstep(45.0, 130.0, dcam));
              float magK = smoothstep(1.4, 4.5, iTexel / max(fwq * 0.5, 1e-4)) * (1.0 - smoothstep(0.45, 0.6, mk.r)) * (1.0 - smoothstep(150.0, 190.0, dcam));
              nearK = max(eye, magK);
              if (nearK > 0.01) {
                vec3 lf = textureLod(iTex, iuv, clamp(log2(5.0 / iTexel), 0.0, 10.0)).rgb;
                vec3 lf2 = textureLod(iTex, iuv, clamp(log2(14.0 / iTexel), 0.0, 10.0)).rgb;   // wider context
                lf = mix(lf, lf2, 0.35);
                vec2 q = vW.xz, fwv = vec2(fwq);
                // material weights: A = (asphalt, concrete, grass, soil), B = (dry grass, gravel, sand, leaf litter)
                vec4 wA = vec4(0.0), wB = vec4(0.0);
                if (uMatOn > 0.5) { vec2 jit = (vec2(tnb(q * 0.9, fwq * 0.9), tnb(q.yx * 0.9 + 7.3, fwq * 0.9)) - 0.5) * 0.9; matWeights(vUV, jit, wA, wB); }
                float ws = dot(wA, vec4(1.0)) + dot(wB, vec4(1.0));
                if (ws < 0.05) {                          // no class map here: a guess from the photo's colour
                  float lum = dot(lf, vec3(0.299, 0.587, 0.114)), sat = (max(lf.r, max(lf.g, lf.b)) - min(lf.r, min(lf.g, lf.b))) / max(lum, 0.03);
                  float veg = smoothstep(-0.005, 0.03, lf.g - max(lf.r * 0.96, lf.b)), grey = 1.0 - smoothstep(0.1, 0.24, sat), dk = 1.0 - smoothstep(0.07, 0.2, lum);
                  wA = vec4(grey * dk, grey * (1.0 - dk), veg * (1.0 - grey * 0.6), (1.0 - grey) * (1.0 - veg)); wB = vec4(0.0); ws = dot(wA, vec4(1.0));
                }
                wA /= max(ws, 1e-3); wB /= max(ws, 1e-3);
                // fine detail: two rotated scales of the detail tiles (no visible repeat), mip-filtered
                vec2 q2 = vec2(0.8 * q.x + 0.6 * q.y, -0.6 * q.x + 0.8 * q.y) / ${(GTILE * 2.9).toFixed(2)};
                vec2 q2dx = vec2(0.8 * qdx.x + 0.6 * qdx.y, -0.6 * qdx.x + 0.8 * qdx.y) / ${(GTILE * 2.9).toFixed(2)};
                vec2 q2dy = vec2(0.8 * qdy.x + 0.6 * qdy.y, -0.6 * qdy.x + 0.8 * qdy.y) / ${(GTILE * 2.9).toFixed(2)};
                vec2 q1 = q / ${GTILE.toFixed(1)}, q1dx = qdx / ${GTILE.toFixed(1)}, q1dy = qdy / ${GTILE.toFixed(1)};
                vec4 gd = mix(textureGrad(uGround, q1, q1dx, q1dy), textureGrad(uGround, q2, q2dx, q2dy), 0.38) - 0.5;
                vec4 g2 = mix(textureGrad(uGround2, q1, q1dx, q1dy), textureGrad(uGround2, q2, q2dx, q2dy), 0.38) - 0.5;
                // mid-scale features, each band-limited by the pixel footprint (they fade to their mean before aliasing)
                float macro = tnb(q * 0.11, fwq * 0.11), macro2 = tnb(q * 0.029 + 5.1, fwq * 0.029);
                float crackN = tnb(q * 0.37 + 11.3, fwq * 0.37), cw0 = 0.012 + fwq * 0.3;
                float crack = (1.0 - smoothstep(cw0, cw0 * 2.2, abs(crackN - 0.5))) * (1.0 - smoothstep(0.1, 0.35, fwq)) * smoothstep(0.35, 0.75, tnb(q * 0.05 + 2.0, fwq * 0.05));
                float patchA = smoothstep(0.64, 0.68, tnb(q * 0.085 + 3.1, fwq * 0.085));
                float slab = mix(1.5, 3.0, step(0.5, tnb(floor(q / 40.0) * 0.37, 0.0)));                // slab size per ~40 m area
                vec2 sg = abs(fract(q / slab) - 0.5); float jw = (0.005 + fwq * 0.25) / slab;
                float joint = smoothstep(0.5 - jw * 2.0, 0.5 - jw, max(sg.x, sg.y)) * (1.0 - smoothstep(0.05, 0.2, fwq));
                float stain = smoothstep(0.7, 0.85, tnb(q * 0.21 + 7.7, fwq * 0.21));
                float clump = tnb(q * 1.3, fwq * 1.3);
                float vA = gd.r * 1.8 - patchA * 0.16 - crack * 0.4 - stain * 0.08 + (macro - 0.5) * 0.16 + (macro2 - 0.5) * 0.1;
                float vC = gd.a * 1.3 - joint * 0.13 - stain * 0.1 + (macro - 0.5) * 0.12 + (macro2 - 0.5) * 0.08 - crack * 0.2;
                float vG = gd.b * 1.9 + (clump - 0.5) * 0.28 + (macro - 0.5) * 0.18;
                float vS = gd.g * 1.8 + (tnb(q * 1.9, fwq * 1.9) - 0.5) * 0.2 + (macro - 0.5) * 0.14;
                float vD = g2.g * 2.0 + (clump - 0.5) * 0.2 + (macro - 0.5) * 0.16;
                float vR = g2.r * 2.2 + (macro - 0.5) * 0.1, vN = g2.b * 1.8 + (macro2 - 0.5) * 0.12, vL = g2.a * 1.9 + (clump - 0.5) * 0.16;
                float v = dot(wA, vec4(vA, vC, vG, vS)) + dot(wB, vec4(vD, vR, vN, vL));
                // tint: grass clumps greener, dry spots straw, soil and litter a little warmer in the macro variation
                vec3 tint = mix(vec3(1.0), mix(vec3(0.94, 1.05, 0.9), vec3(1.08, 1.02, 0.86), smoothstep(0.5, 0.8, tnb(q * 0.23, fwq * 0.23))), wA.z * 0.6)
                          * mix(vec3(1.0), vec3(1.04, 1.0, 0.94), (wA.w + wB.w) * (macro - 0.3));
                // bump: the detail tiles' own slope, weighted by how rough each material is (1 cm steps, or the pixel)
                float e = max(0.012, fwq * 0.35);
                vec4 gdx = textureGrad(uGround, q1 + vec2(e / ${GTILE.toFixed(1)}, 0.0), q1dx, q1dy) - 0.5, gdz = textureGrad(uGround, q1 + vec2(0.0, e / ${GTILE.toFixed(1)}), q1dx, q1dy) - 0.5;
                vec4 g2x = textureGrad(uGround2, q1 + vec2(e / ${GTILE.toFixed(1)}, 0.0), q1dx, q1dy) - 0.5, g2z = textureGrad(uGround2, q1 + vec2(0.0, e / ${GTILE.toFixed(1)}), q1dx, q1dy) - 0.5;
                vec4 g1 = textureGrad(uGround, q1, q1dx, q1dy) - 0.5, g21 = textureGrad(uGround2, q1, q1dx, q1dy) - 0.5;
                vec4 bA = vec4(0.012, 0.006, 0.03, 0.02), bB = vec4(0.03, 0.04, 0.012, 0.025);                 // m of relief per unit
                vec4 hA0 = vec4(g1.r, g1.a, g1.b, g1.g), hB0 = vec4(g21.g, g21.r, g21.b, g21.a);
                vec4 hAx = vec4(gdx.r, gdx.a, gdx.b, gdx.g), hBx = vec4(g2x.g, g2x.r, g2x.b, g2x.a);
                vec4 hAz = vec4(gdz.r, gdz.a, gdz.b, gdz.g), hBz = vec4(g2z.g, g2z.r, g2z.b, g2z.a);
                float gxs = (dot(wA * bA, hAx - hA0) + dot(wB * bB, hBx - hB0)) / e, gzs = (dot(wA * bA, hAz - hA0) + dot(wB * bB, hBz - hB0)) / e;
                float bk = nearK * (1.0 - smoothstep(0.06, 0.25, fwq));
                nW = normalize(nW + vec3(-gxs, 0.0, -gzs) * 6.0 * bk);
                vec3 synth = lf * tint * (1.0 + v);
                col = mix(col, col * tint * (1.0 + v * 0.85), magK * (1.0 - eye));   // above eye level: the photo, detailed
                col = mix(col, synth, eye * 0.96);                                     // eye level: the synthesized surface
              }
            } else {
              float n1 = tn(vW.xz * 0.0015);
              col = mix(vec3(0.46, 0.39, 0.24), vec3(0.34, 0.36, 0.22), smoothstep(0.3, 0.7, n1));
              col = mix(col, vec3(0.36, 0.35, 0.33), smoothstep(0.1, 0.5, mk.g));
              col = mix(col, vec3(0.08, 0.16, 0.2), water);
            }
            // ---- mid-distance detail (up to ~420 m, where the near-ground texture has handed back to the photo) ----
            float det = smoothstep(420.0, 25.0, dcam) * (1.0 - water) * (1.0 - nearK);
            if (det > 0.0) {
              // surface-aware micro detail from the landcover class (mask A): each pattern fades before it can alias
              vec2 p = vW.xz; float cls = floor(mk.a * 255.0 + 0.5);
              if (uMatOn > 0.5) { vec4 wa, wb; float lc = MAT_LC[matWeights(vUV, vec2(0.0), wa, wb)]; if (lc >= 0.0) cls = lc; }
              float fw = fwq;
              float d1 = tnb(p * 1.7, fw * 1.7), d2 = tnb(p * 0.43, fw * 0.43);
              float gain = ((d1 - 0.5) * 0.18 + (d2 - 0.5) * 0.12) * det;          // broad variation everywhere
              float bump = 0.3, bf = 1.0 - smoothstep(0.07, 0.19, fw);
              if (cls > 7.5) {                                                     // gravel: stones, from the material detail texture
                float gg = textureGrad(uGround2, p / ${GTILE.toFixed(1)}, qdx / ${GTILE.toFixed(1)}, qdy / ${GTILE.toFixed(1)}).r - 0.5;
                gain += gg * 1.1 * det; bump = 0.5;
              } else if (cls > 5.5 && cls < 6.5) {                                       // pavement: asphalt grain, patching, cracks
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
            float hw = hInfo.x + texture2D(hTex, tc).r, fwDepth = fwidth(hw);          // (derivative outside the branch)
            if (water > 0.0) {
              // the Pacific side of the Peninsula (west of a line from the Golden Gate to the San Mateo coast ridge)
              float sea = 1.0 - step(1.0, hw);
              float ocean = smoothstep(700.0, -700.0, vW.x - (-18638.0 + 0.3103 * vW.z)) * sea;
              blWater(vW.xz, clamp(-hw, 0.0, 30.0), water, fwq, fwDepth, ocean, sea, col, nW, gRough);
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
    const f = finest(hrec, L, x, y, HMAX); if (f) return [f[0].mn - 2, f[0].mx + 2];
    return [-120, 1500];
  }
  function nodeWanted(L, x, y) {         // is there any data finer than L-1 here (so splitting helps)?
    if (!index) return L <= 5;
    return exists(L, x, y) || (L > LH && hExists(L, x, y));
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
      const g = fine && L > LH && geoFine ? geoFine : geo; if (n.mesh.geometry !== g) n.mesh.geometry = g;
      n.mesh.matrix.makeScale(T, 1, T); n.mesh.matrix.setPosition(X0 + (x + 0.5) * T, 0, Z0 + (y + 0.5) * T); n.mesh.matrixWorldNeedsUpdate = true;
      const prio = 2 + Math.min(40, d / 800) + (L < 3 ? -2 : 0);
      if (index) { // request this node's own data (the quadtree only visits nodes that exist)
        const own = exists(L, x, y);
        if (own) needImg(L, x, y, prio);
        if (own || (L > LH && hExists(L, x, y))) {
          const lb = Math.min(L, LH), p = L - lb; needHgt(lb, x >> p, y >> p, prio + 0.5); needMsk(lb, x >> p, y >> p, prio + 1);
          // lidar detail: the L8 tile over this node, and the L9 tile on L9 nodes (the L8 one shows while it streams)
          for (let l = LH + 1; l <= Math.min(L, HMAX); l++) { const q = L - l; if (hExists(l, x >> q, y >> q)) needHgt(l, x >> q, y >> q, prio + 0.5 - (l - LH) * 0.1); }
        }
      }
      // heights
      const fh = index ? finest(hrec, L, x, y, HMAX) : null;
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
      // ground materials: the node's L7 class map, near the camera only (the detail it drives fades out by ~420 m)
      u.uMatOn.value = 0;
      if (mat && L >= LH && d < 900) {
        const q = L - LH, mx = x >> q, my = y >> q;
        if (mat.has(K(LH, mx, my))) { const r = needMat(mx, my, prio); if (r.state === 2) { const s = 1 / (1 << q); u.uMat.value = r.tex; u.uMatUV.value.set((x - (mx << q)) * s, (y - (my << q)) * s, s, s); u.uMatOn.value = 1; } }
      }
      if (!u.uMatOn.value) u.uMat.value = matDummyTex();
      u.skirt.value = Math.max(2, T / 64 * 0.8); u.nodeSize.value = T;
    }
    for (let i = cap; i < nodes.length; i++) if (nodes[i]) nodes[i].mesh.visible = false;
    if ((frameNo & 31) === 0) evict();
  }
  // ---------- LRU eviction ----------
  const CAP = { img: 300, hgt: 1100, msk: 500 }, IMG_BUDGET = 520e6;   // imagery: count cap AND a GPU-memory budget
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
    evictMap(matRec, 48, r => { if (r.tex) r.tex.dispose(); });
    // drop queued requests nobody wants any more
    for (const map of [irec, hrec, mrec, matRec]) for (const r of map.values()) if (r.state === 1 && r.used < frameNo - 90 && r.L > 2) { Stream.cancel(r.path); }
  }

  // ---------- queries ----------
  function fallbackH(x, z) {
    if (!heights) return 0;
    let fx = (x - FX0) / S, fz = (z - FZ0) / S;
    fx = fx < 0 ? 0 : fx > N - 1.001 ? N - 1.001 : fx; fz = fz < 0 ? 0 : fz > N - 1.001 ? N - 1.001 : fz;
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * N + i;
    return heights[k] * (1 - tx) * (1 - tz) + heights[k + 1] * tx * (1 - tz) + heights[k + N] * (1 - tx) * tz + heights[k + N + 1] * tx * tz;
  }
  function h(x, z, maxL = HMAX) {
    if (index) {
      const top = maxL < HMAX ? maxL : HMAX, Tt = tileSize(top); let tx = Math.floor((x - X0) / Tt), ty = Math.floor((z - Z0) / Tt);
      for (let L = top; L >= 0; L--, tx >>= 1, ty >>= 1) {
        const r = hrec.get(K(L, tx, ty)); if (!r || r.state !== 2) continue;
        const T = tileSize(L); let fx = (x - X0 - tx * T) / T * 128, fz = (z - Z0 - ty * T) / T * 128;
        fx = fx < 0 ? 0 : fx > 127.999 ? 127.999 : fx; fz = fz < 0 ? 0 : fz > 127.999 ? 127.999 : fz;
        const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * HS + i, H = r.h;
        return Math.max(0, H[k] * (1 - u) * (1 - v) + H[k + 1] * u * (1 - v) + H[k + HS] * (1 - u) * v + H[k + HS + 1] * u * v);   // sea level (see the vertex shader)
      }
    }
    return Math.max(0, fallbackH(x, z));
  }
  const hBase = (x, z) => h(x, z, LH);
  // height tiles needed for a rectangle: the finest existing level up to maxL (default: the lidar L8 tiles for rects up
  // to 1 km, so trees and furniture are placed on the surface that will draw near them; L7 beyond, and for callers that
  // build on hBase), plus the L7 base under lidar tiles (so a lidar 404 still leaves the base loaded)
  function detailTiles(x0, z0, x1, z1, maxL) {
    const out = []; if (!index) return out;
    if (maxL === undefined) maxL = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0)) <= 1000 ? LH + 1 : LH;
    const top = Math.min(maxL, HMAX), Tt = tileSize(top);
    const a = Math.floor((Math.min(x0, x1) - X0) / Tt), b = Math.floor((Math.max(x0, x1) - X0) / Tt), c = Math.floor((Math.min(z0, z1) - Z0) / Tt), d = Math.floor((Math.max(z0, z1) - Z0) / Tt);
    const seen = new Set(), add = (L, x, y) => { const k = K(L, x, y); if (!seen.has(k)) { seen.add(k); out.push([L, x, y]); } };
    for (let ty = c; ty <= d; ty++) for (let tx = a; tx <= b; tx++) {
      let L = top, x = tx, y = ty; while (L > LH && !hExists(L, x, y)) { L--; x >>= 1; y >>= 1; }
      if (L > LH) { add(L, x, y); const q = L - LH; x >>= q; y >>= q; L = LH; }
      while (L > 5 && !exists(L, x, y)) { L--; x >>= 1; y >>= 1; }
      if (x < 0 || y < 0 || x >= (1 << L) || y >= (1 << L)) continue;
      add(L, x, y);
    }
    return out;
  }
  function hasDetail(x0, z0, x1, z1, maxL) { if (!index) return true; for (const [L, x, y] of detailTiles(x0, z0, x1, z1, maxL)) { const r = hrec.get(K(L, x, y)); if (!r || (r.state !== 2 && r.state !== 3)) return false; } return true; }
  function ensure(x0, z0, x1, z1, prio = 3, maxL) {
    if (!index) return Promise.resolve();
    return Promise.all(detailTiles(x0, z0, x1, z1, maxL).map(([L, x, y]) => needHgt(L, x, y, prio))).then(() => {});
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
  return { load, h, hBase, hasDetail, ensure, imagery, retain, release, isWater, urbanAt, maskAt, materialAt, update, setTownFade, setFine, lodFactor, stats, group,
    groundDetail: groundDetailTexture, GROUND_TILE: GTILE, waveTexture, WATER_GLSL,
    get mesh() { return group; }, get info() { return { N, S, X0: FX0, Z0: FZ0 }; }, get tiled() { return !!index; }, tileSize, TILE: { X0, Z0, SIZE, LMAX, LH },
    get HMAX() { return HMAX; }, get materials() { return mat ? { tiles: mat.size, loaded: [...matRec.values()].filter(r => r.state === 2).length } : null; }, get lidar() { return h9 ? { tiles8: h9[8].size, tiles9: h9[9].size, attribution: h9.attribution } : null; },
    get fallbackField() { return heights ? { heights, N, S, X0: FX0, Z0: FZ0 } : null; } };
})();
