// Terrain v2: streamed, chunked-LOD photoreal ground. A camera-driven quadtree over the SPEC_v2 tile grid
// (L0 102.4 km … L8 400 m) draws one mesh per node; each node uses the finest data loaded at or above it:
// NAIP imagery (L0–8), 129² heights (L0–7) and 128² masks (L0–7), with the v1 64 m field as the ultimate
// fallback, so the view sharpens progressively like a globe viewer and never shows holes.
// API (SPEC_v2): load, h, hasDetail, ensure, imagery, retain, release, isWater, urbanAt, maskAt,
//                update(camera), setTownFade (no-op in v2), group/mesh, info, lodFactor, stats.
const Terrain = (() => {
  // ---------- v1 fallback field (64 m heights + masks, whole world) ----------
  let N = 0, S = 64, FX0 = 0, FZ0 = 0, heights = null, mask = null, texFH = null, texFM = null;
  const X0 = -45056, Z0 = -49152, SIZE = 102400, LMAX = 8, LH = 7;
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
      for (const L of [6, 7, 8]) { const s = new Set(); for (const [x, y] of (idx.levels && idx.levels[L]) || []) s.add(K(L, x, y)); index[L] = s; }
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
      r.tex = t; r.bmp = bmp; r.state = 2; stats.img++; return r;
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
  function makeMaterial() {
    const u = {
      hTex: { value: texFH }, hUV: { value: new THREE.Vector4(0, 0, 1, 1) }, hTC: { value: new THREE.Vector2(1, 0) }, hInfo: { value: new THREE.Vector3(0, 64, 1 / 1600) },
      iTex: { value: null }, iUV: { value: new THREE.Vector4(0, 0, 1, 1) }, iHas: { value: 0 },
      mTex: { value: texFM }, mUV: { value: new THREE.Vector4(0, 0, 1, 1) }, mTC: { value: new THREE.Vector2(1, 0) },
      skirt: { value: 4 }, nodeSize: { value: 1000 }, night: U.uNight, time: U.uTime,
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
          uniform sampler2D iTex; uniform vec4 iUV; uniform float iHas;
          uniform sampler2D mTex; uniform vec4 mUV; uniform vec2 mTC; uniform float nodeSize;
          uniform float night; uniform float time;
          varying vec3 vW; varying vec2 vUV;
          float th(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
          float tn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(th(i), th(i+vec2(1,0)), f.x), mix(th(i+vec2(0,1)), th(i+vec2(1,1)), f.x), f.y); }
          vec3 gN; float gRough; vec3 gEmis;`)
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
            // ---- albedo: the photograph (or a quiet fallback before it streams in) ----
            vec3 col;
            if (iHas > 0.5) {
              col = texture2D(iTex, iUV.xy + vUV * iUV.zw).rgb;
            } else {
              float n1 = tn(vW.xz * 0.0015);
              col = mix(vec3(0.46, 0.39, 0.24), vec3(0.34, 0.36, 0.22), smoothstep(0.3, 0.7, n1));
              col = mix(col, vec3(0.36, 0.35, 0.33), smoothstep(0.1, 0.5, mk.g));
              col = mix(col, vec3(0.08, 0.16, 0.2), water);
            }
            // ---- near-camera detail so the photo never looks like a blurry decal ----
            float det = smoothstep(420.0, 25.0, dcam) * (1.0 - water);
            if (det > 0.0) {
              float d1 = tn(vW.xz * 1.7), d2 = tn(vW.xz * 0.43), d3 = th(floor(vW.xz * 6.0));
              col *= 1.0 + ((d1 - 0.5) * 0.22 + (d2 - 0.5) * 0.14 + (d3 - 0.5) * 0.08) * det;
              float a = tn(vW.xz * 2.1), b = tn((vW.xz + vec2(0.3, 0.0)) * 2.1), c = tn((vW.xz + vec2(0.0, 0.3)) * 2.1);
              nW = normalize(nW + vec3(a - b, 0.0, a - c) * 0.35 * det);
            }
            // ---- water: keep the photo's tint (South Bay silt, Pacific blue), add waves and a glossy surface ----
            gRough = mix(0.93, 0.07, water);
            if (water > 0.0) {
              float depth = clamp(-(hInfo.x + texture2D(hTex, tc).r), 0.0, 30.0);
              vec3 deep = vec3(0.035, 0.085, 0.11), shallow = col * 0.55;
              col = mix(col, mix(shallow, deep, smoothstep(0.0, 12.0, depth)), water * 0.8);
              float wf = smoothstep(6000.0, 300.0, dcam);
              vec2 wp = vW.xz * 0.11 + vec2(time * 0.31, time * 0.19); vec2 wq = vW.xz * 0.023 - vec2(time * 0.07, -time * 0.05);
              float wa = tn(wp), wb = tn(wp + vec2(0.37, 0.0)), wc = tn(wp + vec2(0.0, 0.37));
              float xa = tn(wq), xb = tn(wq + vec2(0.41, 0.0)), xc = tn(wq + vec2(0.0, 0.41));
              vec3 wn = normalize(vec3((wa - wb) * 0.55 * wf + (xa - xb) * 0.4, 1.0, (wa - wc) * 0.55 * wf + (xa - xc) * 0.4));
              nW = normalize(mix(nW, wn, water));
            }
            // ---- night: the photo goes dark, streets and towns glow (mask G) ----
            float gl = mk.g;
            float spark = smoothstep(0.55, 0.95, th(floor(vW.xz / 18.0))) * smoothstep(0.15, 0.6, gl);
            gEmis = vec3(1.0, 0.72, 0.42) * (pow(gl, 1.6) * 0.9 + spark * 1.6) * night * (1.0 - water) * smoothstep(120.0, 900.0, dcam);
            diffuseColor.rgb = col;
            gN = nW;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = gRough;`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += gEmis;`);
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
      let split = L < LMAX && T / d > k;
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
      if (fi) { const [r, s, ox, oy] = fi; u.iTex.value = r.tex; u.iUV.value.set(ox, oy, s, s); u.iHas.value = 1; r.used = frameNo; }
      else { u.iHas.value = 0; u.iTex.value = null; }
      u.skirt.value = Math.max(2, T / 64 * 0.8); u.nodeSize.value = T;
    }
    for (let i = cap; i < nodes.length; i++) if (nodes[i]) nodes[i].mesh.visible = false;
    if ((frameNo & 31) === 0) evict();
  }
  // ---------- LRU eviction ----------
  const CAP = { img: 300, hgt: 700, msk: 500 };
  function evictMap(map, cap, dispose) {
    if (map.size <= cap) return;
    const arr = [...map.values()].filter(r => r.state !== 1 && r.L > 2 && !(r.refs > 0) && r.used < frameNo - 30).sort((a, b) => a.used - b.used);
    for (let i = 0; i < arr.length && map.size > cap; i++) { const r = arr[i]; if (r.state === 1) continue; dispose(r); map.delete(K(r.L, r.x, r.y)); stats.evicted++; }
  }
  function evict() {
    evictMap(irec, CAP.img, r => { if (r.tex) r.tex.dispose(); if (r.bmp && r.bmp.close) r.bmp.close(); });
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
  function imagery(x, z) {
    if (!index) return null; const T8 = tileSize(LMAX); let tx = Math.floor((x - X0) / T8), ty = Math.floor((z - Z0) / T8);
    for (let L = LMAX; L >= 0; L--, tx >>= 1, ty >>= 1) { const r = irec.get(K(L, tx, ty)); if (r && r.state === 2) { const T = tileSize(L); return { tex: r.tex, x0: X0 + tx * T, z0: Z0 + ty * T, size: T, L }; } }
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
