// Towns v2: every real OpenStreetMap building along the corridor, streamed in SPEC_v2 level-7 tiles (800 m) around the
// camera from DATA/tiles/b/ (OpenStreetMap, ODbL — see notes/towns.md). Roofs sample the terrain's NAIP photo, so from
// the air every roof matches the picture; walls are procedural facades by region, type and material.
//
//   Towns.init(ctx) -> Promise      ctx = { ll2w, groundY(x,z), trackDist(x,z), stationList, keepOut?(x,z), isWater?(x,z) }
//   Towns.update(camPos, env)        every frame; fetches, grounds and builds tiles within a time budget (env.budgetMs, default 4)
//   Towns.group                      add to the scene
//   Towns.roadsNear(x, z, r)         [{ pts: Float32Array xyz (world), cls, lanes, oneway, speed, width, urban, bridge }]  (loaded tiles)
//   Towns.buildingsAt(x, z, r)       OSM footprints near a point: [{ x, z, height, minHeight, kind, pts }]
//   Towns.stats                      counters (stats.detailR -> Terrain.setTownFade; stats.roadGen bumps when new road data arrives)
//   Towns.idle()                     true when nothing is left to fetch or build
const Towns = (() => {
  const TILE = 800, X0 = -45056, Z0 = -49152;       // SPEC_v2 level 7
  const DIR = 'tiles/b/';
  const ROAD_R = 1500;        // street ribbons (hidden from high up: the photo shows the streets)
  const BLD_R = 3000;         // real buildings (photo roofs, procedural facades)
  const HI_R = 750;           // full detail: parapets, rooftop units, curbs, sidewalks, crosswalks, detailed infill houses
  const SHADOW_R = 600;       // only nearby buildings cast shadows
  const SKY_R = 9000;         // tall buildings only (the skyline from afar)
  const TREE_R = 300, POLE_R = 850, POOL_R = 1500;
  const GROUND_ALT = 450;     // camera height above which street ribbons hide
  const BUDGET_MS = 4;
  const group = new THREE.Group(); group.name = 'towns';
  const stats = { tiles: 0, built: 0, buildings: 0, houses: 0, trees: 0, lights: 0, groundTris: 0, bldTris: 0, queue: 0, fetching: 0,
    lastBuildMs: 0, detailR: BLD_R, roadR: ROAD_R, roadGen: 0, sky: 0, index: 0 };
  let ctx = null, ready = false, stationW = [];
  const index = new Map();          // "tx,ty" -> { tx, ty, bytes, nb, sky }
  const tiles = new Map();          // full tiles
  const skyTiles = new Map();       // skyline-only tiles
  const decoded = new Map();        // LRU of decoded tile data (roadsNear / buildingsAt / neighbours)
  const pendingDecode = new Map();  // key -> Promise (roadsNear-triggered fetches)
  let deadline = 0;
  const now = () => performance.now();
  const K = (tx, ty) => tx + ',' + ty;
  const tileOrigin = (tx, ty) => [X0 + tx * TILE, Z0 + ty * TILE];
  const hasStream = () => typeof Stream !== 'undefined' && Stream && typeof Stream.bin === 'function';
  const hasTerrain = () => typeof Terrain !== 'undefined' && Terrain;
  const hasImagery = () => hasTerrain() && typeof Terrain.imagery === 'function';
  const floraCovers = (x, z) => typeof Flora !== 'undefined' && Flora && (typeof Flora.covers !== 'function' || Flora.covers(x, z));

  // fetch helpers (Stream if present, plain fetch + zlib otherwise)
  const DATA = (typeof window !== 'undefined' && window.BAYLINE_DATA) || './data/v2/';
  async function inflateMaybe(u8) {
    if (u8.length > 2 && (u8[0] & 0x0f) === 8 && ((u8[0] << 8) | u8[1]) % 31 === 0) {
      const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate')); return new Uint8Array(await new Response(s).arrayBuffer());
    }
    return u8;
  }
  function getBin(path, prio) {
    if (hasStream()) return Stream.bin(path, prio);
    return fetch(DATA + path).then(r => { if (!r.ok) throw Object.assign(new Error(r.status + ' ' + path), { notFound: r.status === 404 }); return r.arrayBuffer(); })
      .then(b => inflateMaybe(new Uint8Array(b)));
  }
  function getJson(path, prio) { return hasStream() ? Stream.json(path, prio) : fetch(DATA + path).then(r => r.json()); }
  function cancel(path) { if (hasStream() && Stream.cancel) Stream.cancel(path); }

  // ------------------------------------------------------------------ regions & palettes
  function regionOf(z) {                     // by latitude, from world z
    const lat = Geo.LAT0 - z / Geo.MLAT;
    if (lat > 37.708) return 0;              // San Francisco
    if (lat > 37.50) return 1;               // north Peninsula (SSF..Belmont)
    if (lat > 37.415) return 2;              // mid Peninsula (San Carlos..Palo Alto)
    if (lat > 37.335) return 3;              // South Bay (Mountain View..Santa Clara)
    if (lat > 37.20) return 4;               // San Jose
    return 5;                                // South County
  }
  const C = h => new THREE.Color(h);
  const PAL = {
    sfWall: ['#e9dcc0', '#d8c59f', '#c7d5de', '#e7e0cf', '#b9c9ad', '#e9c7a2', '#d4b9c8', '#f1eadb', '#a8bcc9', '#e6d39b', '#c9d9c3', '#f0d8c8', '#dfe3e6', '#cfd8cf'].map(C),
    penWall: ['#e8dcc4', '#efe6d2', '#d9c7a6', '#e3d3b8', '#cdbd9d', '#f3efe6', '#d9cdb8', '#c9b89b', '#e6dfd0', '#c0af90', '#dcd2bf', '#ebe2cf', '#d5d2c8', '#b8b2a4'].map(C),
    eichWall: ['#8a6b4a', '#6f7b75', '#5e6e73', '#9a8f7d', '#7d5f45', '#8f8a7a', '#6b5a48', '#4f5f63'].map(C),
    southWall: ['#e7d9bd', '#d8c3a0', '#efe4cd', '#cbb48e', '#e0d2b5', '#f0ebe0'].map(C),
    roofComp: ['#5b5650', '#6b645a', '#4f4c48', '#76695a', '#5f5f5f', '#6d6660', '#48453f'].map(C),
    roofTile: ['#b5654a', '#a35a42', '#c07556', '#9e5238', '#b86e4f'].map(C),
    roofFlat: ['#a6a298', '#8e8a80', '#c9c7c0', '#7f7b73', '#b8b3a8', '#dcdad3', '#6f6c66'].map(C),
    comm: ['#e6ddcb', '#d4c7ae', '#efe3c8', '#c9b393', '#e9e6df', '#b9a58a', '#d8c9a9', '#c4876a', '#a8ad9c', '#dcd3c4', '#b56f55', '#cfc3ae'].map(C),
    sfComm: ['#a8563f', '#b87b5c', '#c9c1b1', '#8f8f8f', '#d7cfbf', '#9b6a52', '#c2b8a3', '#7d7f82', '#e3dccd', '#6f7a80', '#b9aa92', '#8c5a44'].map(C),
    glass: ['#5f7a8e', '#6c8799', '#4f6a7d', '#7b93a3', '#56707f', '#6b7a78', '#8a8f94', '#4e5a66', '#7a8f86'].map(C),
    brick: ['#8e4a36', '#a0553c', '#7c4232', '#9a6048', '#b06a4c', '#6e3a2c'].map(C),
    stone: ['#c9bea8', '#b8ad96', '#d6ccb6', '#a89f8c', '#cfc6b3'].map(C),
    indus: ['#c2c0b8', '#b0aca0', '#d0ccc0', '#9fa3a6', '#bdb4a3', '#a7aaa3'].map(C),
    civic: ['#e8e0cc', '#d6c8a8', '#b99e7e', '#9c5a44', '#e4d9c1'].map(C),
  };
  const pick = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];

  // ------------------------------------------------------------------ materials
  const glsl_hash = `
    float tHash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
    float tHash3(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
    float tNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(tHash(i), tHash(i+vec2(1.0,0.0)), f.x), mix(tHash(i+vec2(0.0,1.0)), tHash(i+vec2(1.0,1.0)), f.x), f.y); }`;

  // Roads, sidewalks, parking, crosswalks, lawns: one material, markings drawn in the shader.
  // aMark = (type, lanes, width*4, fade*255) as unsigned bytes; aRoadUv = (metres along, metres across)
  const roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0.0 });
  roadMat.onBeforeCompile = sh => {
    sh.uniforms.uNight = U.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aMark; attribute vec2 aRoadUv; varying vec4 vMark; varying vec2 vRoadUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMark = vec4(aMark.x, aMark.y, aMark.z * 0.25, aMark.w / 255.0); vRoadUv = aRoadUv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vMark; varying vec2 vRoadUv; uniform float uNight;' + glsl_hash)
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        float t = floor(vMark.x + 0.5);
        vec2 q = vRoadUv;
        if (t > 0.5) {
          float n1 = tHash(floor(q * 1.7)), n2 = tHash(floor(q * 0.21 + 3.1));
          vec3 base = diffuseColor.rgb;
          float aa = max(fwidth(q.y), 0.015), aax = max(fwidth(q.x), 0.015);
          float lanes = vMark.y, W = vMark.z, fade = vMark.w;
          float line = 0.0; vec3 lc = vec3(0.90, 0.90, 0.86);
          if (t < 6.5) {                                   // asphalt
            float far = smoothstep(0.08, 0.6, aa);
            base *= 0.90 + (0.12 * n1 + 0.07 * n2) * (1.0 - far) + 0.03 * tNoise(q * 0.05);
            float hw = W * 0.5;
            if (t > 1.5) { float edge = abs(abs(q.y) - (hw - 0.45)); line = max(line, 1.0 - smoothstep(0.07, 0.07 + aa, edge)); }
            if (t == 2.0 || t == 5.0) {                    // two-way: double yellow center
              float c = min(abs(q.y - 0.17), abs(q.y + 0.17));
              float yl = 1.0 - smoothstep(0.06, 0.06 + aa, c);
              if (yl > line) { line = yl; lc = vec3(0.93, 0.74, 0.18); }
              float nPer = floor(lanes * 0.5 + 0.01);
              if (nPer > 1.5) {
                float lw = (hw - 0.6) / nPer;
                float k = abs(q.y) / lw; float d = abs(k - floor(k + 0.5)) * lw;
                float dash = step(fract(q.x / 12.0), 0.25) * step(0.5, k) * step(k, nPer - 0.5);
                line = max(line, dash * (1.0 - smoothstep(0.06, 0.06 + aa, d)));
              }
            } else if (t == 3.0 || t == 4.0) {             // one-way / freeway carriageway
              float lw = (W - (t == 4.0 ? 3.0 : 1.0)) / max(lanes, 1.0);
              float y0 = q.y + hw - (t == 4.0 ? 1.0 : 0.5);
              float k = y0 / lw; float d = abs(k - floor(k + 0.5)) * lw;
              float period = t == 4.0 ? 12.0 : 10.0;
              float dash = step(fract(q.x / period), 0.26) * step(0.5, k) * step(k, lanes - 0.5);
              line = max(line, dash * (1.0 - smoothstep(0.07, 0.07 + aa, d)));
              float le = abs(q.y + hw - 0.45);
              float yl = 1.0 - smoothstep(0.07, 0.07 + aa, le);
              if (yl > 0.5) { line = yl; lc = vec3(0.93, 0.74, 0.18); }
            }
            base = mix(base, lc, line * fade * (0.85 + 0.15 * n1) * (1.0 - far * 0.7));
            base *= 1.0 - 0.05 * smoothstep(0.35, 0.0, abs(fract(q.y / 1.8) - 0.5));   // tire tracks
          } else if (t == 7.0) {                           // crosswalk (continental stripes)
            float s = step(0.45, fract(q.y / 1.2));
            base = mix(base, vec3(0.88, 0.88, 0.85), s * (0.8 + 0.2 * n1));
          } else if (t == 8.0) {                           // parking lot with stall lines
            base *= 0.92 + 0.1 * n1;
            float st = 1.0 - smoothstep(0.05, 0.05 + aax * 1.5, abs(fract(q.x / 2.75) - 0.5) * 2.75);
            float row = step(abs(fract(q.y / 12.0) - 0.5) * 12.0, 2.6);
            float far = smoothstep(0.08, 0.5, aax);
            base = mix(base, vec3(0.8), st * row * 0.75 * (1.0 - far));
          } else if (t == 9.0) {                           // grass
            base *= 0.86 + 0.22 * tHash(floor(q * 0.7)) + 0.08 * n1;
          } else if (t == 10.0) {                          // lawn: mowing stripes
            base *= 0.92 + 0.08 * step(0.5, fract(q.x / 1.6)) + 0.06 * n1;
          } else if (t == 11.0) {                          // concrete sidewalk with joints
            float j = min(abs(fract(q.x / 1.5) - 0.5), 0.5) * 1.5;
            base *= (0.95 + 0.06 * n1) * (1.0 - 0.18 * (1.0 - smoothstep(0.02, 0.02 + aax, 0.75 - j)));
          }
          diffuseColor.rgb = base;
        }
      }`);
  };

  // Buildings: one material per tile (its photo-roof textures are per-tile uniforms). Facades come from a small
  // mip-mapped texture array: one layer per window style (a single window cell: R wall detail, G glass, B trim,
  // A dark bands) and per wall material, repeated per floor and column. Two lookups per pixel, no procedural noise:
  // with the logarithmic depth buffer there is no early-z, so every covered pixel pays the full shader.
  //   aWin   = (floorH*100, style, seed 0..999, eave*50)   uint16
  //   aWallUv= (metres along this wall, metres above grade) * 20   int16
  //   aB     = (surface, photo slot, material, wallLen*2)    uint8   surface: 0 wall, 1 photo roof, 2 roof, 3 street-facing wall
  const DUMMY = (() => { const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); t.needsUpdate = true; return t; })();
  const FL = { plain: 0, resid: 1, office: 2, curtain: 3, store: 4, clerestory: 5, sash: 6, civic: 7, house: 8, garage: 9,
    brick: 10, siding: 11, panels: 12, metal: 13, stone: 14, roof: 15, stucco: 16 };
  let facadeTex = null;
  function makeFacadeArray() {
    const S = 128, N = 17, data = new Uint8Array(S * S * 4 * N);
    const cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d', { willReadFrequently: true });
    const rnd = U.rng(4242);
    // channel painter: we draw R, G, B, A as separate grayscale passes into one RGBA layer
    for (let L = 0; L < N; L++) {
      const R = new Float32Array(S * S).fill(0.55), G = new Float32Array(S * S), B = new Float32Array(S * S), A = new Float32Array(S * S).fill(1);
      const rect = (arr, x0, y0, x1, y1, v, mode) => { for (let y = Math.max(0, Math.round(y0 * S)); y < Math.min(S, Math.round(y1 * S)); y++) for (let x = Math.max(0, Math.round(x0 * S)); x < Math.min(S, Math.round(x1 * S)); x++) { const k = y * S + x; arr[k] = mode === 'max' ? Math.max(arr[k], v) : v; } };
      const noise = (amt, cell) => { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const h = U.hash2(Math.floor(x / cell) + L * 97, Math.floor(y / cell)); R[y * S + x] += (h - 0.5) * amt; } };
      const win = (x0, y0, x1, y1, frame) => { rect(B, x0 - frame, y0 - frame * 1.6, x1 + frame, y1 + frame, 1); rect(G, x0, y0, x1, y1, 1); rect(B, x0, y0, x1, y1, 0); };
      // v runs up the floor: canvas y = 1 - v, so y0/y1 below are measured from the TOP of the cell
      const up = (v0, v1) => [1 - v1, 1 - v0];
      noise(0.1, 1); noise(0.08, 8);
      if (L === FL.resid) { const [a, b] = up(0.30, 0.86); win(0.30, a, 0.70, b, 0.035); rect(B, 0.27, up(0.26, 0.30)[0], 0.73, up(0.26, 0.30)[1], 1); }
      else if (L === FL.office) { const [a, b] = up(0.34, 0.84); rect(G, 0, a, 1, b, 1); for (let k = 0; k < 2; k++) rect(B, k * 0.5, a, k * 0.5 + 0.02, b, 0.6); rect(R, 0, up(0.0, 0.06)[0], 1, 1, 0.35); }
      else if (L === FL.curtain) { const [a, b] = up(0.30, 0.97); rect(G, 0.035, a, 0.965, b, 1); rect(B, 0, 0, 0.035, 1, 0.9); rect(B, 0.965, 0, 1, 1, 0.9); rect(A, 0, up(0.0, 0.30)[0], 1, 1, 0.55); }
      else if (L === FL.store) { const [a, b] = up(0.06, 0.74); rect(G, 0.04, a, 0.96, b, 1); rect(B, 0.49, a, 0.51, b, 0.9); rect(B, 0.02, a - 0.02, 0.98, a, 0.9); rect(A, 0, up(0.78, 0.96)[0], 1, up(0.78, 0.96)[1], 0.12); }
      else if (L === FL.clerestory) { const [a, b] = up(0.72, 0.90); rect(G, 0.10, a, 0.90, b, 1); rect(B, 0.08, a - 0.02, 0.92, b + 0.02, 0.7, 'max'); rect(G, 0.10, a, 0.90, b, 1); rect(B, 0.10, a, 0.90, b, 0); }
      else if (L === FL.sash) { const [a, b] = up(0.22, 0.88); win(0.22, a, 0.78, b, 0.045); rect(B, 0.22, up(0.54, 0.57)[0], 0.78, up(0.54, 0.57)[1], 1); rect(B, 0, up(0.93, 1.0)[0], 1, 1, 0.7); }
      else if (L === FL.civic) { const [a, b] = up(0.18, 0.88); win(0.28, a, 0.72, b, 0.06); rect(B, 0.28, up(0.60, 0.62)[0], 0.72, up(0.60, 0.62)[1], 1); }
      else if (L === FL.house) { const [a, b] = up(0.36, 0.80); win(0.32, a, 0.68, b, 0.04); rect(B, 0.49, a, 0.51, b, 1); rect(B, 0.32, up(0.57, 0.59)[0], 0.68, up(0.57, 0.59)[1], 1); }
      else if (L === FL.garage) { rect(A, 0, up(0.40, 0.92)[0], 1, up(0.40, 0.92)[1], 0.06); rect(R, 0, 0, 1, 1, 0.5); noise(0.08, 2); }
      else if (L === FL.brick) { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const by = Math.floor(y / 8), bx = Math.floor((x + (by % 2) * 12) / 24); const mortar = (y % 8) < 1.3 || ((x + (by % 2) * 12) % 24) < 1.5; R[y * S + x] = mortar ? 0.32 : 0.5 + (U.hash2(bx, by + 900) - 0.5) * 0.35; } }
      else if (L === FL.siding) { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) R[y * S + x] = 0.52 + 0.14 * Math.min(1, (y % 16) / 5) - ((y % 16) < 1.5 ? 0.18 : 0) + (U.hash2(x >> 3, y >> 4) - 0.5) * 0.05; }
      else if (L === FL.panels) { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) R[y * S + x] = ((x % 64) < 1.5 || (y % 64) < 1.5) ? 0.36 : 0.52 + (U.hash2(x >> 6, (y >> 6) + 300) - 0.5) * 0.12; }
      else if (L === FL.metal) { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) R[y * S + x] = 0.5 + 0.12 * Math.sin(x / S * Math.PI * 2 * 16); }
      else if (L === FL.stone) { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const by = Math.floor(y / 32), bx = Math.floor((x + (by % 2) * 32) / 64); const j = (y % 32) < 1.5 || ((x + (by % 2) * 32) % 64) < 1.5; R[y * S + x] = j ? 0.36 : 0.5 + (U.hash2(bx + 50, by) - 0.5) * 0.2; } }
      else if (L === FL.roof) { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) R[y * S + x] = 0.5 + (U.hash2(x, y + 700) - 0.5) * 0.3 + (U.hash2(x >> 4, (y >> 4) + 800) - 0.5) * 0.12; }
      else if (L === FL.stucco) { noise(0.06, 3); }
      const o = L * S * S * 4;
      for (let k = 0; k < S * S; k++) { data[o + k * 4] = Math.round(U.clamp(R[k], 0, 1) * 255); data[o + k * 4 + 1] = Math.round(G[k] * 255); data[o + k * 4 + 2] = Math.round(B[k] * 255); data[o + k * 4 + 3] = Math.round(A[k] * 255); }
    }
    void g; void rnd;
    const t = new THREE.DataArrayTexture(data, S, S, N);
    t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType; t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
    return t;
  }
  function bldShader(sh, u) {
    sh.uniforms.uNight = U.uNight; sh.uniforms.uFac = { value: facadeTex };
    const skyGlsl = (typeof Sky !== 'undefined' && Sky.glsl && Sky.uniforms) ? Sky.glsl : '';   // real sky reflections in the glass
    if (skyGlsl) Object.assign(sh.uniforms, Sky.uniforms);
    for (let i = 0; i < 4; i++) { sh.uniforms['uImg' + i] = u['uImg' + i]; sh.uniforms['uImgX' + i] = u['uImgX' + i]; }
    sh.uniforms.uImgSRGB = u.uImgSRGB;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aWin; attribute vec2 aWallUv; attribute vec4 aB; varying vec4 vWin; varying vec2 vWallUv; varying vec4 vB; varying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWin = aWin; vWallUv = aWallUv * 0.05; vB = aB; vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        ${skyGlsl}
        precision highp sampler2DArray;
        varying vec4 vWin; varying vec2 vWallUv; varying vec4 vB; varying vec3 vWP; uniform float uNight; uniform sampler2DArray uFac;
        uniform sampler2D uImg0; uniform sampler2D uImg1; uniform sampler2D uImg2; uniform sampler2D uImg3;
        uniform vec4 uImgX0; uniform vec4 uImgX1; uniform vec4 uImgX2; uniform vec4 uImgX3; uniform float uImgSRGB;
        vec3 gEmit = vec3(0.0); float gPhoto = 0.0;
        vec3 tSrgb(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
        float tHash3(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec2 wp = vWP.xz; vec2 wdx = dFdx(wp), wdy = dFdy(wp);                 // derivatives in uniform control flow
        vec2 q = vWallUv; vec2 qdx = dFdx(q), qdy = dFdy(q);
        float surf = floor(vB.x + 0.5);
        if (surf > 0.5 && surf < 2.5) {                                      // ---- roofs
          vec3 base = diffuseColor.rgb;
          float slot = floor(vB.y + 0.5);
          vec4 xf = slot < 0.5 ? uImgX0 : slot < 1.5 ? uImgX1 : slot < 2.5 ? uImgX2 : uImgX3;
          if (surf < 1.5 && xf.w > 0.5) {
            vec2 uv = clamp((wp - xf.xy) / xf.z, vec2(0.0015), vec2(0.9985)), gx = wdx / xf.z, gy = wdy / xf.z;
            vec3 ph = slot < 0.5 ? textureGrad(uImg0, uv, gx, gy).rgb : slot < 1.5 ? textureGrad(uImg1, uv, gx, gy).rgb : slot < 2.5 ? textureGrad(uImg2, uv, gx, gy).rgb : textureGrad(uImg3, uv, gx, gy).rgb;
            if (uImgSRGB > 0.5) ph = tSrgb(ph);
            float g = textureGrad(uFac, vec3(wp * 0.35, ${FL.roof}.0), wdx * 0.35, wdy * 0.35).r;
            base = ph * (0.93 + 0.14 * (g - 0.5));
            gPhoto = 1.0;
          } else {
            float g = textureGrad(uFac, vec3(wp * 0.35, ${FL.roof}.0), wdx * 0.35, wdy * 0.35).r;
            base *= 0.78 + 0.44 * g;
          }
          diffuseColor.rgb = base;
        } else if (vWin.w > 0.5 || surf > 2.5) {                             // ---- facades
          float style = floor(vWin.y + 0.5), fh = max(2.4, vWin.x * 0.01), seed = vWin.z, eave = vWin.w * 0.02;
          float mat = floor(vB.z + 0.5), segL = vB.w * 0.5; bool front = surf > 2.5; bool longWall = vB.w > 254.5;
          vec3 wall = diffuseColor.rgb;
          // wall material detail (world scale, mip-mapped)
          float ml = mat == 1.0 ? ${FL.brick}.0 : mat == 5.0 ? ${FL.siding}.0 : mat == 3.0 ? ${FL.panels}.0 : mat == 6.0 ? ${FL.metal}.0 : mat == 2.0 ? ${FL.stone}.0 : ${FL.stucco}.0;
          vec2 msc = mat == 3.0 ? vec2(1.0 / 6.0) : mat == 2.0 ? vec2(0.45) : mat == 6.0 ? vec2(0.3) : vec2(1.0 / 2.6);
          float dcam = length(vViewPosition);                               // fragments far away skip the fine detail
          float md = dcam < 200.0 ? textureGrad(uFac, vec3(q * msc, ml), qdx * msc, qdy * msc).r : 0.5;
          wall *= 0.72 + 0.56 * md;
          wall *= 0.78 + 0.22 * smoothstep(-0.2, 2.4, q.y);              // grime at the base
          vec3 outc = wall;
          float colW = style == 3.0 ? 1.5 : style == 2.0 ? 2.7 : style == 5.0 ? 6.0 : style == 6.0 ? 1.9 : style == 8.0 ? 3.8 : style == 9.0 ? 8.0 : 3.1;
          float cw = longWall ? colW : segL / max(1.0, floor(segL / colW + 0.5));
          if (style > 0.5 && q.y > 0.0 && q.y < eave - 0.3) {
            float gf = (style == 4.0 || style == 7.0) ? max(fh, 4.4) : fh;
            bool gfl = q.y < gf;
            float lay = style == 1.0 ? ${FL.resid}.0 : style == 2.0 ? ${FL.office}.0 : style == 3.0 ? ${FL.curtain}.0 : style == 4.0 ? (gfl ? ${FL.store}.0 : ${FL.resid}.0)
              : style == 5.0 ? ${FL.clerestory}.0 : style == 6.0 ? ${FL.sash}.0 : style == 7.0 ? ${FL.civic}.0 : style == 8.0 ? ${FL.house}.0 : ${FL.garage}.0;
            vec2 sc = vec2(1.0 / cw, 1.0 / (gfl ? gf : fh));
            vec2 fuv = vec2(q.x, gfl ? q.y : q.y - gf) * sc;
            vec4 f = textureGrad(uFac, vec3(fuv, lay), qdx * sc, qdy * sc);
            float glassM = f.g;
            if (style == 8.0) glassM *= step(0.4, tHash3(vec3(floor(fuv.x), floor(q.y / fh), seed)));   // houses: irregular windows
            vec3 trimC = (style == 2.0 || style == 3.0 || style == 4.0 || style == 5.0) ? vec3(0.22, 0.23, 0.24) : mix(wall, vec3(0.94, 0.93, 0.89), 0.72);
            outc = mix(wall, trimC, f.b) * mix(0.14, 1.0, f.a);
            float fres = 0.12;
            vec3 sky = mix(vec3(0.30, 0.40, 0.50), vec3(0.62, 0.72, 0.82), fres) * (1.0 - 0.92 * uNight);
            #ifdef BAYLINE_SKY
            { vec3 vv = normalize(vViewPosition), nn = normalize(vNormal); float ct = max(dot(vv, nn), 0.0);
              fres = 0.04 + 0.96 * pow(1.0 - ct, 5.0);                     // Schlick, glass F0 = 0.04
              vec3 rw = normalize((vec4(reflect(-vv, nn), 0.0) * viewMatrix).xyz); rw.y = max(rw.y, 0.03);
              sky = skyRadiance(rw); }
            #endif
            float cell = tHash3(vec3(floor(fuv.x), floor(q.y / fh), seed));
            vec3 glass = (style == 3.0 ? mix(vec3(0.10, 0.14, 0.17), wall * 0.45, 0.35) : vec3(0.07, 0.09, 0.11) + vec3(0.04, 0.05, 0.06) * cell);
            outc = mix(outc, glass, glassM);
            // coated curtain walls mirror the sky strongly; ordinary windows less, both rising with Fresnel
            gEmit += sky * glassM * (style == 3.0 ? 0.26 + 0.7 * fres : 0.10 + 0.6 * fres) * (0.85 + 0.3 * cell);
            float litP = style == 5.0 ? 0.12 : style == 3.0 ? 0.36 : (style == 2.0 || style == 4.0) ? 0.3 : style == 9.0 ? 0.9 : 0.45;
            if (style == 4.0 && gfl) litP = 0.85;
            float lit = step(cell, litP) * uNight;
            vec3 wc = mix(vec3(1.0, 0.72, 0.42), vec3(0.8, 0.88, 1.0), step(0.78, fract(cell * 7.3)) * step(1.5, style) * step(style, 3.5));
            gEmit += wc * lit * glassM * (0.5 + 0.5 * fract(cell * 13.7));
            if (!front && style == 4.0 && gfl) { outc = mix(outc, wall, 0.9); gEmit *= 0.1; }   // storefront glass only faces the street
          }
          if (front && dcam < 220.0) {                                    // street-facing wall: doors, garages, entries
            float L = longWall ? 40.0 : segL; float uu = q.x;
            if (style == 8.0 || style == 6.0) {
              float gw = L > 11.0 ? 4.9 : 2.7, gc = L * (style == 6.0 ? 0.36 : 0.7);
              if (L > 6.5 && abs(uu - gc) < gw * 0.5 && q.y < 2.2 && q.y > 0.02) { outc = mix(vec3(0.86, 0.85, 0.82), vec3(0.8, 0.79, 0.76), step(0.5, fract(q.y / 0.55 + 0.05)) * 0.5); if (fract(seed * 0.37) < 0.35) outc = vec3(0.42, 0.3, 0.2); gEmit = vec3(0.0); }
              float dc = L * (style == 6.0 ? 0.8 : 0.28);
              if (abs(uu - dc) < 0.48 && q.y < 2.12 && q.y > 0.02) { float k = fract(seed * 0.113); outc = k < 0.3 ? vec3(0.95, 0.94, 0.9) : k < 0.55 ? vec3(0.4, 0.27, 0.18) : k < 0.75 ? vec3(0.18, 0.28, 0.22) : vec3(0.5, 0.17, 0.15); gEmit = vec3(1.0, 0.75, 0.45) * uNight * 0.15; }
            } else if (style == 1.0 || style == 2.0 || style == 7.0) {
              if (abs(uu - L * 0.5) < 1.1 && q.y < 2.6 && q.y > 0.02) { outc = vec3(0.1, 0.12, 0.13); gEmit = vec3(1.0, 0.85, 0.6) * uNight * 0.6; }
            } else if (style == 5.0) {
              float k = fract(uu / 12.0);
              if (L > 8.0 && abs(k - 0.5) < 3.8 / 24.0 && q.y < 4.0 && q.y > 0.02) { outc = vec3(0.62, 0.63, 0.62) * (0.92 + 0.08 * step(0.5, fract(q.y / 0.35))); gEmit = vec3(0.0); }
            }
          }
          outc *= 1.0 + 0.09 * step(eave - 0.06, q.y);                    // parapet coping
          diffuseColor.rgb = outc;
        }
      }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmit * 1.3;')
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        if (gPhoto > 0.5) normal = normalize(mix(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), 0.55));`);
  }
  function makeImgUniforms() {
    const u = { uImgSRGB: { value: 0 } };
    for (let i = 0; i < 4; i++) { u['uImg' + i] = { value: DUMMY }; u['uImgX' + i] = { value: new THREE.Vector4(0, 0, 1, 0) }; }
    return u;
  }
  function makeBldMat(u) {
    const m = new THREE.MeshLambertMaterial({ vertexColors: true });
    m.onBeforeCompile = sh => bldShader(sh, u);
    m.customProgramCacheKey = () => 'towns-bld-v3';
    m.userData.u = u;
    return m;
  }
  const skyU = makeImgUniforms(); let skyMat = null;                    // far skyline: no photo roofs (created in init)

  // Procedural houses (infill only): instanced; per-vertex part id picks wall/roof/trim/glass/door colors per instance.
  const houseMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0 });
  houseMat.onBeforeCompile = sh => {
    sh.uniforms.uNight = U.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPart; attribute float aWinId; attribute vec3 iWall; attribute vec3 iRoof; attribute vec2 iSeed;
        varying float vPart; varying float vWinId; varying vec2 vSeed;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vPart = aPart; vWinId = aWinId; vSeed = iSeed;
        {
          vec3 c = iWall;
          if (aPart > 0.5 && aPart < 1.5) c = iRoof;
          else if (aPart > 1.5 && aPart < 2.5) c = vec3(0.93, 0.92, 0.88);
          else if (aPart > 2.5 && aPart < 3.5) c = vec3(0.17, 0.21, 0.26);
          else if (aPart > 3.5 && aPart < 4.5) { float k = fract(iSeed.x * 7.13);
            c = k < 0.3 ? vec3(0.95, 0.94, 0.9) : k < 0.5 ? vec3(0.42, 0.29, 0.2) : k < 0.65 ? vec3(0.2, 0.3, 0.24) : k < 0.8 ? vec3(0.48, 0.18, 0.16) : vec3(0.55, 0.57, 0.58); }
          else if (aPart > 4.5 && aPart < 5.5) c = vec3(0.34, 0.31, 0.29);
          else if (aPart > 5.5) { float k = fract(iSeed.x * 3.71);
            c = k < 0.2 ? vec3(0.72, 0.2, 0.17) : k < 0.4 ? vec3(0.18, 0.43, 0.7) : k < 0.6 ? vec3(0.88, 0.65, 0.16) : k < 0.8 ? vec3(0.18, 0.54, 0.34) : vec3(0.85, 0.85, 0.85); }
          vColor = c * color;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPart; varying float vWinId; varying vec2 vSeed; uniform float uNight;' + glsl_hash)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (vPart > 2.5 && vPart < 3.5) roughnessFactor = 0.15;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nif (vPart > 2.5 && vPart < 3.5) metalnessFactor = 0.3;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vPart > 2.5 && vPart < 3.5) {
          float h = tHash(vec2(vSeed.x * 91.7 + vWinId * 3.1, vWinId + vSeed.y * 17.0));
          float lit = step(h, vSeed.y) * uNight;
          totalEmissiveRadiance += vec3(1.0, 0.76, 0.46) * lit * (0.9 + 0.5 * h);
        }
        if (vPart > 5.5) totalEmissiveRadiance += diffuseColor.rgb * 0.8 * uNight;`);
  };

  // Fallback trees (only when the vegetation module is absent): vertex colors, instance tint, wind sway.
  const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.0 });
  treeMat.onBeforeCompile = sh => {
    sh.uniforms.uTime = U.uTime; sh.uniforms.uWind = U.uWind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        { float ph = instanceMatrix[3].x * 0.071 + instanceMatrix[3].z * 0.053;
          float amt = max(0.0, position.y - 2.0) * 0.012 * (0.4 + uWind);
          transformed.x += sin(uTime * 1.35 + ph) * amt; transformed.z += cos(uTime * 1.07 + ph * 1.3) * amt * 0.7; }
        #endif`);
  };
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8d9195, roughness: 0.55, metalness: 0.5 });
  const poolMat = new THREE.ShaderMaterial({
    uniforms: { uNight: U.uNight },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uNight; varying vec2 vUv;
      void main(){
        #include <logdepthbuf_fragment>
        float d = length(vUv - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - d), 1.8) * uNight * 0.55;
        if (a < 0.004) discard; gl_FragColor = vec4(vec3(1.0, 0.72, 0.42) * a, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { uNight: U.uNight },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uNight; varying vec2 vUv; varying float vA;
      void main(){ vUv = uv; vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float dist = length(c.xyz); float s = 2.4 + dist * 0.004;
        c.xyz += normalize(-c.xyz) * 0.6;
        c.xy += (uv - 0.5) * s; vA = uNight * clamp(2.4 / s, 0.25, 1.0); gl_Position = projectionMatrix * c;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec2 vUv; varying float vA;
      void main(){
        #include <logdepthbuf_fragment>
        float d = length(vUv - 0.5) * 2.0; float a = (pow(max(0.0, 1.0 - d), 2.4) + 0.6 * pow(max(0.0, 1.0 - d * 2.2), 3.0)) * vA;
        if (a < 0.003) discard; gl_FragColor = vec4(vec3(1.0, 0.8, 0.52) * a * 1.5, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });

  // ------------------------------------------------------------------ compact indexed geometry builder
  // Attributes are typed (normals int8, colours uint8, per-building data uint8/uint16), and quads share vertices,
  // so a dense San Francisco tile stays around 1–2 MB of GPU memory instead of ~9 MB.
  class TB {
    constructor(spec) { this.spec = spec; this.cap = 512; this.n = 0; this.a = {}; for (const s of spec) this.a[s[0]] = new s[2](this.cap * s[1]); this.I = new Uint32Array(1536); this.ni = 0; }
    grow() { this.cap *= 2; for (const [nm, sz, Ctor] of this.spec) { const b = new Ctor(this.cap * sz); b.set(this.a[nm]); this.a[nm] = b; } }
    v() { if (this.n >= this.cap) this.grow(); return this.n++; }
    tri(a, b, c) { if (this.ni + 3 > this.I.length) { const b2 = new Uint32Array(this.I.length * 2); b2.set(this.I); this.I = b2; } this.I[this.ni++] = a; this.I[this.ni++] = b; this.I[this.ni++] = c; }
    build() {
      if (!this.n || !this.ni) return null;
      const g = new THREE.BufferGeometry();
      for (const [nm, sz, , norm] of this.spec) g.setAttribute(nm, new THREE.BufferAttribute(this.a[nm].slice(0, this.n * sz), sz, !!norm));
      g.setIndex(new THREE.BufferAttribute(this.n < 65536 ? new Uint16Array(this.I.subarray(0, this.ni)) : this.I.slice(0, this.ni), 1));
      g.computeBoundingSphere(); g.computeBoundingBox();
      return g;
    }
  }
  const BSPEC = [['position', 3, Float32Array], ['normal', 3, Int8Array, true], ['color', 3, Uint8Array, true], ['aWin', 4, Uint16Array], ['aWallUv', 2, Int16Array], ['aB', 4, Uint8Array]];
  const RSPEC = [['position', 3, Float32Array], ['normal', 3, Int8Array, true], ['color', 3, Uint8Array, true], ['aMark', 4, Uint8Array], ['aRoadUv', 2, Float32Array]];
  const c8 = v => Math.max(0, Math.min(255, Math.round(v * 255)));
  const i16 = v => Math.max(-32768, Math.min(32767, Math.round(v)));
  // building vertex: win = [fh*100, style, seed, eave*50]; b = [surface, slot, material, wallLen*2]
  function bvert(tb, x, y, z, nx, ny, nz, col, win, u, v, b) {
    const i = tb.v(), A = tb.a, i3 = i * 3, i4 = i * 4, i2 = i * 2;
    A.position[i3] = x; A.position[i3 + 1] = y; A.position[i3 + 2] = z;
    A.normal[i3] = Math.round(nx * 127); A.normal[i3 + 1] = Math.round(ny * 127); A.normal[i3 + 2] = Math.round(nz * 127);
    A.color[i3] = c8(col.r); A.color[i3 + 1] = c8(col.g); A.color[i3 + 2] = c8(col.b);
    A.aWin[i4] = win[0]; A.aWin[i4 + 1] = win[1]; A.aWin[i4 + 2] = win[2]; A.aWin[i4 + 3] = win[3];
    A.aWallUv[i2] = i16(u * 20); A.aWallUv[i2 + 1] = i16(v * 20);
    A.aB[i4] = b[0]; A.aB[i4 + 1] = b[1]; A.aB[i4 + 2] = b[2]; A.aB[i4 + 3] = b[3];
    return i;
  }
  const _n = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
  function faceN(a, b, c) { _e1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]); _e2.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]); return _n.crossVectors(_e1, _e2).normalize(); }
  // building triangle with automatic flat normal (winding decides facing)
  function btri(tb, A, B, Cc, col, win, b, uvA = [0, 0], uvB = [0, 0], uvC = [0, 0]) {
    const n = faceN(A, B, Cc);
    const i0 = bvert(tb, A[0], A[1], A[2], n.x, n.y, n.z, col, win, uvA[0], uvA[1], b);
    const i1 = bvert(tb, B[0], B[1], B[2], n.x, n.y, n.z, col, win, uvB[0], uvB[1], b);
    const i2 = bvert(tb, Cc[0], Cc[1], Cc[2], n.x, n.y, n.z, col, win, uvC[0], uvC[1], b);
    tb.tri(i0, i1, i2);
  }
  function btriUp(tb, A, B, Cc, col, win, b) {           // horizontal-ish triangle, facing up whatever its winding
    const cr = (B[0] - A[0]) * (Cc[2] - A[2]) - (B[2] - A[2]) * (Cc[0] - A[0]);
    if (cr < 0) btri(tb, A, B, Cc, col, win, b); else btri(tb, A, Cc, B, col, win, b);
  }
  // wall quad A(bottom-left) B(bottom-right) C(top-right) D(top-left), seen from outside; u runs A->B
  function bquad(tb, A, B, Cc, D, col, win, b, u0, u1, v0, v1) {
    const n = faceN(A, D, B);                      // up x (B - A): outward for a CCW footprint edge A->B
    const ia = bvert(tb, A[0], A[1], A[2], n.x, n.y, n.z, col, win, u0, v0, b), ib = bvert(tb, B[0], B[1], B[2], n.x, n.y, n.z, col, win, u1, v0, b);
    const ic = bvert(tb, Cc[0], Cc[1], Cc[2], n.x, n.y, n.z, col, win, u1, v1, b), id = bvert(tb, D[0], D[1], D[2], n.x, n.y, n.z, col, win, u0, v1, b);
    tb.tri(ia, id, ib); tb.tri(ib, id, ic);
  }
  // road vertex: mark = [type, lanes, width*4, fade*255]
  function rvert(tb, x, y, z, nx, ny, nz, col, m0, m1, m2, m3, u, v) {
    const i = tb.v(), A = tb.a, i3 = i * 3, i4 = i * 4;
    A.position[i3] = x; A.position[i3 + 1] = y; A.position[i3 + 2] = z;
    A.normal[i3] = Math.round(nx * 127); A.normal[i3 + 1] = Math.round(ny * 127); A.normal[i3 + 2] = Math.round(nz * 127);
    A.color[i3] = c8(col.r); A.color[i3 + 1] = c8(col.g); A.color[i3 + 2] = c8(col.b);
    A.aMark[i4] = m0; A.aMark[i4 + 1] = m1; A.aMark[i4 + 2] = m2; A.aMark[i4 + 3] = m3;
    A.aRoadUv[i * 2] = u; A.aRoadUv[i * 2 + 1] = v;
    return i;
  }
  // road quad from 4 corners with per-corner (u,v,fade); faces up (or down when `down`); twoSided for curbs / parapets
  function rquad(tb, P0, P1, P2, P3, col, mark, lanes, w4, uv, fades, twoSided, down) {
    // P0-P1 = near edge (across), P2-P3 = far edge; order the triangles so the face points the right way
    let n = faceN(P0, P2, P1);
    let flip = twoSided ? false : ((n.y < 0) !== !!down);
    if (flip) n = n.multiplyScalar(-1);
    const nx = n.x, ny = n.y, nz = n.z;
    const f = fades.map(v => Math.round(v * 255));
    const a = rvert(tb, P0[0], P0[1], P0[2], nx, ny, nz, col, mark, lanes, w4, f[0], uv[0], uv[1]);
    const b = rvert(tb, P1[0], P1[1], P1[2], nx, ny, nz, col, mark, lanes, w4, f[1], uv[2], uv[3]);
    const c = rvert(tb, P2[0], P2[1], P2[2], nx, ny, nz, col, mark, lanes, w4, f[2], uv[4], uv[5]);
    const d = rvert(tb, P3[0], P3[1], P3[2], nx, ny, nz, col, mark, lanes, w4, f[3], uv[6], uv[7]);
    if (!flip) { tb.tri(a, c, b); tb.tri(b, c, d); } else { tb.tri(a, b, c); tb.tri(b, d, c); }
    if (twoSided) {
      const a2 = rvert(tb, P0[0], P0[1], P0[2], -nx, -ny, -nz, col, mark, lanes, w4, f[0], uv[0], uv[1]);
      const b2 = rvert(tb, P1[0], P1[1], P1[2], -nx, -ny, -nz, col, mark, lanes, w4, f[1], uv[2], uv[3]);
      const c2 = rvert(tb, P2[0], P2[1], P2[2], -nx, -ny, -nz, col, mark, lanes, w4, f[2], uv[4], uv[5]);
      const d2 = rvert(tb, P3[0], P3[1], P3[2], -nx, -ny, -nz, col, mark, lanes, w4, f[3], uv[6], uv[7]);
      tb.tri(a2, b2, c2); tb.tri(b2, d2, c2);
    }
  }
  function rtri(tb, A, B, Cc, col, mark, uvA, uvB, uvC) {   // flat area triangle, facing up
    let n = faceN(A, B, Cc); let flip = n.y < 0; if (flip) n = n.multiplyScalar(-1);
    const a = rvert(tb, A[0], A[1], A[2], n.x, n.y, n.z, col, mark, 0, 0, 255, uvA[0], uvA[1]);
    const b = rvert(tb, B[0], B[1], B[2], n.x, n.y, n.z, col, mark, 0, 0, 255, uvB[0], uvB[1]);
    const c = rvert(tb, Cc[0], Cc[1], Cc[2], n.x, n.y, n.z, col, mark, 0, 0, 255, uvC[0], uvC[1]);
    if (flip) tb.tri(a, c, b); else tb.tri(a, b, c);
  }

  // ------------------------------------------------------------------ tile decoding (BLT3, see tools/bake_towns.py)
  function decode(tx, ty, u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8[0] !== 66 || u8[1] !== 76 || u8[2] !== 84 || u8[3] !== 51) throw new Error('towns tile: bad magic');
    let o = 4;
    const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
    const u8r = () => dv.getUint8(o++);
    const nB = u16(), nR = u16(), nA = u16(), nT = u16(), nI = u16(), nL = u16();
    const flags = u8r(), region = u8r();
    let mask = null; if (flags & 1) { mask = u8.slice(o, o + 128); o += 128; }
    const pts = n => { const a = new Float32Array(n * 2); let x = 0, z = 0;
      for (let i = 0; i < n; i++) { const dx = dv.getInt16(o, true), dz = dv.getInt16(o + 2, true); o += 4;
        if (i === 0) { x = dx; z = dz; } else { x += dx; z += dz; } a[i * 2] = x * 0.1; a[i * 2 + 1] = z * 0.1; }
      return a; };
    const b = [], r = [], a = [], t = [], it = [], lamps = [];
    for (let i = 0; i < nB; i++) {
      const kind = u8r(), roof = u8r(), h = u16() / 4, mh = u16() / 4, wall = u16(), roofc = u16(), fl = u8r(), mat = u8r(), levels = u8r(), front = u8r(), n = u16();
      b.push({ kind, roof, h, mh, wall, roofc, flags: fl, mat, levels, front, pts: pts(n) });
    }
    for (let i = 0; i < nR; i++) { const cls = u8r(), rflags = u8r(), lanes = u8r(), width = u8r() / 4, n = u16(); const p = pts(n);
      let off = null; if (rflags & 2) { off = new Float32Array(n); for (let j = 0; j < n; j++) off[j] = u8r() / 4; }
      r.push({ cls, flags: rflags, lanes, width, pts: p, off }); }
    for (let i = 0; i < nA; i++) { const kind = u8r(); u8r(); const n = u16(); a.push({ kind, pts: pts(n) }); }
    for (let i = 0; i < nT; i++) { const x = dv.getInt16(o, true) * 0.1, z = dv.getInt16(o + 2, true) * 0.1; o += 4; t.push({ x, z, kind: u8r(), size: u8r() }); }
    for (let i = 0; i < nI; i++) { const x = dv.getInt16(o, true) * 0.1, z = dv.getInt16(o + 2, true) * 0.1; o += 4; const n = u8r(), f = u8r();
      const ap = []; for (let j = 0; j < n; j++) ap.push({ ang: u8r() / 256 * Math.PI * 2, hw: u8r() / 4 }); it.push({ x, z, flags: f, ap }); }
    for (let i = 0; i < nL; i++) { lamps.push(dv.getInt16(o, true) * 0.1, dv.getInt16(o + 2, true) * 0.1); o += 4; }
    const [ox, oz] = tileOrigin(tx, ty);
    return { tx, ty, ox, oz, region, mask, b, r, a, t, it, lamps: new Float32Array(lamps) };
  }
  function remember(k, d) { decoded.delete(k); decoded.set(k, d); while (decoded.size > 140) decoded.delete(decoded.keys().next().value); }
  function infillAt(T, x, z) {                  // tile-local metres -> is this 25 m cell open for procedural houses?
    if (!T.mask) return false; const i = Math.floor(x / 25), j = Math.floor(z / 25);
    if (i < 0 || j < 0 || i > 31 || j > 31) return false; const k = j * 32 + i; return !!(T.mask[k >> 3] & (1 << (k & 7)));
  }

  // per-tile ground-height cache on the terrain's own L7 grid (6.25 m), bilinear, so ground objects match the terrain
  const HS = 6.25, HM = 2, HN = Math.round(TILE / HS) + 1 + HM * 2;      // 133 samples across (-12.5 .. 812.5 m)
  function* heightField(t) {
    const a = new Float32Array(HN * HN);
    for (let j = 0; j < HN; j++) {
      const z = t.oz + (j - HM) * HS;
      for (let i = 0; i < HN; i++) a[j * HN + i] = ctx.groundY(t.ox + (i - HM) * HS, z);
      if ((j & 15) === 15 && now() > deadline) yield;
    }
    t.hf = (x, z) => {
      let fx = x / HS + HM, fz = z / HS + HM; fx = fx < 0 ? 0 : fx > HN - 1.001 ? HN - 1.001 : fx; fz = fz < 0 ? 0 : fz > HN - 1.001 ? HN - 1.001 : fz;
      const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, p = j * HN + i;
      return (a[p] * (1 - u) + a[p + 1] * u) * (1 - v) + (a[p + HN] * (1 - u) + a[p + HN + 1] * u) * v;
    };
  }

  // ------------------------------------------------------------------ roads
  const COL = { asphalt: C('#57585a'), asphaltOld: C('#626265'), fwy: C('#5f6063'), curb: C('#bdbab2'), walk: C('#b7b2a7'),
    walkWarm: C('#c4b9a6'), grass: C('#5d7338'), grassDry: C('#8a8a4a'), gravel: C('#7c7466'), barrier: C('#b9b5ab'),
    deck: C('#a9a59c'), park: C('#5f7a3a'), pitch: C('#4f8a3a'), play: C('#b58f63'), parking: C('#4b4c4f'), plaza: C('#c9c0ad'),
    cemetery: C('#6c8446'), allot: C('#6f7a3e'), lawn: C('#6a8a3e'), lawnDry: C('#9a9658'), drive: C('#b6b1a8'), hvac: C('#9fa2a3'),
    roofGravel: C('#8f8b84'), roofMembrane: C('#c9c7c1') };
  const LIFT = [0.40, 0.36, 0.38, 0.35, 0.33, 0.31, 0.30, 0.29, 0.28, 0.27, 0.25, 0.24, 0.24, 0.22, 0.23];
  function markType(r) {
    const c = r.cls, oneway = r.flags & 1, urban = r.flags & 8;
    if (c === 0 || c === 2) return oneway ? 4 : 5;
    if (c === 1 || c === 3) return 3;
    if (c <= 9) return oneway ? 3 : (r.lanes >= 2 ? (urban ? 2 : 5) : 1);
    return 1;
  }
  // One road piece -> asphalt ribbon with lane markings (shader), curbs, verge, sidewalks (urban), shoulders (rural),
  // parapets + piers (bridges), crosswalks at urban intersections. Sidewalks stop at cross streets.
  function roadRibbon(tb, r, T, hf, inter, hi) {
    const P = r.pts, n0 = P.length / 2; if (n0 < 2) return;
    const region = regionOf(T.oz + P[1]);
    const bridge = !!(r.flags & 2), urban = !!(r.flags & 8), core = !!(r.flags & 4), c = r.cls;
    const hw = r.width / 2, mt = markType(r);
    const walks = hi && urban && !bridge && c >= 4 && c <= 12 && c !== 5 && c !== 7 && c !== 9;
    const strip = walks && !core && region >= 1 && c >= 8 ? 1.5 : 0;
    const sw = walks ? (core ? (c <= 8 ? 3.8 : 3.0) : c <= 7 ? 3.0 : 1.9) : 0;
    const shoulder = !walks && !bridge && hi ? (c <= 3 ? 1.6 : 1.0) : 0;
    const u0 = new Float32Array(n0); for (let i = 1; i < n0; i++) u0[i] = u0[i - 1] + Math.hypot(P[i * 2] - P[i * 2 - 2], P[i * 2 + 1] - P[i * 2 - 1]);
    const total = u0[n0 - 1]; if (total < 0.5) return;
    const ints = [];
    for (let i = 0; i < n0; i++) { const it = inter.get(Math.round(P[i * 2] * 10) + ':' + Math.round(P[i * 2 + 1] * 10)); if (it) ints.push({ u: u0[i], R: it.R, flags: it.flags }); }
    const cw = hi && c >= 4 && c <= 12 && urban && !bridge;
    const brk = []; const seg = hi ? 12 : 40;
    for (let i = 0; i + 1 < n0; i++) { const L = u0[i + 1] - u0[i], m = Math.max(1, Math.ceil(L / seg)); for (let k = 0; k < m; k++) brk.push(u0[i] + L * k / m); }
    brk.push(total);
    if (hi) for (const it of ints) for (const d of [it.R + 0.3, it.R + 1.0, it.R + 4.0]) { if (it.u - d > 0) brk.push(it.u - d); if (it.u + d < total) brk.push(it.u + d); }
    brk.sort((a, b) => a - b);
    const us = []; for (const u of brk) if (!us.length || u - us[us.length - 1] > 0.05) us.push(u);
    const n = us.length;
    const xs = new Float32Array(n), zs = new Float32Array(n), os = new Float32Array(n);
    for (let j = 0, i = 0; j < n; j++) {
      while (i < n0 - 2 && u0[i + 1] < us[j]) i++;
      const L = u0[i + 1] - u0[i] || 1, t = Math.min(1, Math.max(0, (us[j] - u0[i]) / L));
      xs[j] = P[i * 2] + (P[i * 2 + 2] - P[i * 2]) * t; zs[j] = P[i * 2 + 1] + (P[i * 2 + 3] - P[i * 2 + 1]) * t;
      os[j] = r.off ? r.off[i] + (r.off[i + 1] - r.off[i]) * t : 0;
    }
    const nx = new Float32Array(n), nz = new Float32Array(n), mit = new Float32Array(n), fade = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = xs[b] - xs[a], tz = zs[b] - zs[a]; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      nx[i] = -tz; nz[i] = tx;
      let m = 1;
      if (i > 0 && i < n - 1) { const sx = xs[i + 1] - xs[i], sz = zs[i + 1] - zs[i], sl = Math.hypot(sx, sz) || 1; m = 1 / Math.max(0.55, (-sz / sl) * nx[i] + (sx / sl) * nz[i]); }
      mit[i] = m;
      let f = 1; for (const it of ints) f = Math.min(f, U.clamp((Math.abs(us[i] - it.u) - it.R - 0.5) / 3, 0, 1));
      fade[i] = f;
    }
    const nearInt = (u, extra) => { for (const it of ints) if (Math.abs(u - it.u) < it.R + extra) return it; return null; };
    const lift = LIFT[Math.min(c, 14)] + (bridge ? 0.1 : 0);
    const bands = [];     // [off0, off1, dy0, dy1, color, markType, vertical, kind]
    const asphalt = c <= 3 ? COL.fwy : (region === 0 || region === 4 || core) ? COL.asphalt : COL.asphaltOld;
    bands.push([-hw, hw, 0, 0, asphalt, mt, 0, 0]);
    if (cw && ints.length) bands.push([-hw + 0.4, hw - 0.4, 0.025, 0.025, asphalt, 7, 0, 2]);
    if (walks) {
      for (const s of [-1, 1]) {
        const e0 = hw * s, e1 = (hw + strip) * s, e2 = (hw + strip + sw) * s;
        bands.push([e0, e0, 0, 0.15, COL.curb, 0, 1, 1]);
        if (strip > 0) { bands.push([e0, e1, 0.15, 0.15, COL.grass, 9, 0, 1]); bands.push([e1, e2, 0.16, 0.16, COL.walk, 11, 0, 1]); }
        else bands.push([e0, e2, 0.15, 0.15, region === 0 || core ? COL.walk : COL.walkWarm, 11, 0, 1]);
        bands.push([e2, e2, 0.16, -0.5, COL.curb, 0, 1, 1]);
      }
    } else if (!bridge && hi) {
      for (const s of [-1, 1]) {
        bands.push([hw * s, (hw + shoulder) * s, -0.02, -0.05, COL.gravel, 9, 0, 0]);
        bands.push([(hw + shoulder) * s, (hw + shoulder) * s, -0.05, -0.8, COL.gravel, 0, 1, 0]);
      }
      if ((c === 0 || c === 2) && (r.flags & 1)) { bands.push([-hw - 0.2, -hw - 0.2, 0, 0.85, COL.barrier, 0, 1, 0]); bands.push([-hw - 0.2, -hw - 0.6, 0.85, 0.85, COL.barrier, 0, 0, 0]); }
    } else if (bridge) {
      for (const s of [-1, 1]) {
        bands.push([hw * s, hw * s, 0, 0.95, COL.barrier, 0, 1, 0]);
        bands.push([hw * s, (hw + 0.35) * s, 0.95, 0.95, COL.barrier, 0, 0, 0]);
        bands.push([(hw + 0.35) * s, (hw + 0.35) * s, 0.95, -1.4, COL.deck, 0, 1, 0]);
      }
      bands.push([hw + 0.35, -hw - 0.35, -1.4, -1.4, COL.deck, 0, 0, 3]);   // underside (faces down)
    }
    const outer = hw + strip + sw + shoulder + 0.4;
    const gC = new Float32Array(n), gL = new Float32Array(n), gR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      gC[i] = hf(xs[i], zs[i]);
      gL[i] = hf(xs[i] + nx[i] * outer, zs[i] + nz[i] * outer); gR[i] = hf(xs[i] - nx[i] * outer, zs[i] - nz[i] * outer);
    }
    const Y = (i, off) => {
      if (bridge) return gC[i] + os[i];
      const g = off >= 0 ? gC[i] + (gL[i] - gC[i]) * Math.min(1, off / outer) : gC[i] + (gR[i] - gC[i]) * Math.min(1, -off / outer);
      return Math.max(g, gC[i] - 0.6) + os[i];
    };
    const w4 = Math.min(255, Math.round(r.width * 4)), lanes = Math.min(255, r.lanes);
    for (const [o0, o1, dy0, dy1, col, mark, vert, kind] of bands) {
      for (let i = 0; i < n - 1; i++) {
        const j = i + 1, um = (us[i] + us[j]) / 2;
        if (kind === 1 && nearInt(um, 0.3)) continue;
        if (kind === 2) { const it = nearInt(um, 4.0); if (!it || Math.abs(um - it.u) < it.R + 1.0 || !(it.flags & 8) || ((it.flags & 1) && region !== 0 && !core)) continue; }
        const a0x = xs[i] + nx[i] * o0 * mit[i], a0z = zs[i] + nz[i] * o0 * mit[i], a1x = xs[i] + nx[i] * o1 * mit[i], a1z = zs[i] + nz[i] * o1 * mit[i];
        const b0x = xs[j] + nx[j] * o0 * mit[j], b0z = zs[j] + nz[j] * o0 * mit[j], b1x = xs[j] + nx[j] * o1 * mit[j], b1z = zs[j] + nz[j] * o1 * mit[j];
        const f0 = kind === 2 ? 1 : fade[i], f1 = kind === 2 ? 1 : fade[j];
        if (!vert) {
          const A = [a0x, Y(i, o0) + lift + dy0, a0z], B = [a1x, Y(i, o1) + lift + dy1, a1z], Cc = [b0x, Y(j, o0) + lift + dy0, b0z], D = [b1x, Y(j, o1) + lift + dy1, b1z];
          rquad(tb, A, B, Cc, D, col, mark, lanes, w4, [us[i], o0, us[i], o1, us[j], o0, us[j], o1], [f0, f0, f1, f1], false, kind === 3);
        } else {
          const A = [a0x, Y(i, o0) + lift + dy0, a0z], B = [a0x, Y(i, o0) + lift + dy1, a0z], Cc = [b0x, Y(j, o0) + lift + dy0, b0z], D = [b0x, Y(j, o0) + lift + dy1, b0z];
          rquad(tb, A, B, Cc, D, col, mark, lanes, w4, [us[i], o0, us[i], o0, us[j], o0, us[j], o0], [f0, f0, f1, f1], kind !== 1, false);
        }
      }
    }
    if (bridge) {                       // piers every ~28 m where the deck is high
      let next = 14;
      for (let i = 0; i < n; i++) {
        if (us[i] >= next && os[i] > 2.5) { next = us[i] + 28;
          const top = Y(i, 0) + lift - 1.4, bot = gC[i] - 0.5, w = Math.min(hw * 0.8, 5);
          roadBox(tb, xs[i], (top + bot) / 2, zs[i], 1.2, top - bot, w * 2, Math.atan2(nx[i], nz[i]), COL.deck); }
      }
    }
  }
  function roadBox(tb, x, y, z, sx, sy, sz, rot, col) {
    const c = Math.cos(rot), s = Math.sin(rot), hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const P = (dx, dy, dz) => [x + dx * c + dz * s, y + dy, z - dx * s + dz * c];
    const v = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(-hx, hy, -hz), P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)];
    const quads = [[0, 1, 3, 2], [5, 4, 6, 7], [4, 0, 7, 3], [1, 5, 2, 6]];
    for (const [a, b, cc, d] of quads) rquad(tb, v[a], v[b], v[cc], v[d], col, 0, 0, 0, [0, 0, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1], true, false);
  }
  // flat polygons (parking, plazas; parks only where there is no photo terrain) draped approximately
  const AREA_STYLE = [[COL.park, 9], [COL.pitch, 10], [COL.play, 9], [COL.parking, 8], [COL.plaza, 11], [COL.cemetery, 10], [COL.allot, 9]];
  function areaPoly(tb, a, hf) {
    const P = a.pts, n = P.length / 2; if (n < 3) return;
    const [col, mark] = AREA_STYLE[a.kind] || AREA_STYLE[0];
    const contour = []; let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (let i = 0; i < n; i++) { contour.push(new THREE.Vector2(P[i * 2], P[i * 2 + 1])); minx = Math.min(minx, P[i * 2]); maxx = Math.max(maxx, P[i * 2]); minz = Math.min(minz, P[i * 2 + 1]); maxz = Math.max(maxz, P[i * 2 + 1]); }
    let faces; try { faces = THREE.ShapeUtils.triangulateShape(contour, []); } catch (e) { return; }
    const size = Math.max(maxx - minx, maxz - minz), lift = 0.11 + 0.07 * (1 - Math.min(1, size / 400)) + (a.kind === 3 || a.kind === 4 ? 0.02 : 0);
    const box = obb(P, n); const ux = box ? box.ux : 1, uz = box ? box.uz : 0;
    const swap = box && box.h1 > box.h0;
    const uvOf = (x, z) => { const s = x * ux + z * uz, t = -x * uz + z * ux; return swap ? [t, s] : [s, t]; };
    const emit = (A, B, Cc, d) => {
      const l = Math.max((A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2, (B[0] - Cc[0]) ** 2 + (B[1] - Cc[1]) ** 2, (Cc[0] - A[0]) ** 2 + (Cc[1] - A[1]) ** 2);
      if (l > 18 * 18 && d < 6) {
        const ab = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], bc = [(B[0] + Cc[0]) / 2, (B[1] + Cc[1]) / 2], ca = [(Cc[0] + A[0]) / 2, (Cc[1] + A[1]) / 2];
        emit(A, ab, ca, d + 1); emit(ab, B, bc, d + 1); emit(ca, bc, Cc, d + 1); emit(ab, bc, ca, d + 1); return;
      }
      rtri(tb, [A[0], hf(A[0], A[1]) + lift, A[1]], [B[0], hf(B[0], B[1]) + lift, B[1]], [Cc[0], hf(Cc[0], Cc[1]) + lift, Cc[1]], col, mark, uvOf(A[0], A[1]), uvOf(B[0], B[1]), uvOf(Cc[0], Cc[1]));
    };
    for (const f of faces) emit([contour[f[0]].x, contour[f[0]].y], [contour[f[1]].x, contour[f[1]].y], [contour[f[2]].x, contour[f[2]].y], 0);
  }
  function flatQuadR(tb, hf, cx, cz, ux, uz, hw, hd, col, mark, lift) {       // yards, driveways, storefront lots
    const L = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
    const c = L.map(([a, b]) => { const x = cx + ux * a - uz * b, z = cz + uz * a + ux * b; return [x, hf(x, z) + lift, z]; });
    rtri(tb, c[0], c[1], c[2], col, mark, L[0], L[1], L[2]); rtri(tb, c[0], c[2], c[3], col, mark, L[0], L[2], L[3]);
  }

  // ------------------------------------------------------------------ OSM buildings
  function obb(P, n) {                         // minimum-area rectangle via hull edges
    const pts = []; for (let i = 0; i < n; i++) pts.push([P[i * 2], P[i * 2 + 1]]);
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    const hull = lo.slice(0, -1).concat(hi.slice(0, -1)); if (hull.length < 3) return null;
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length]; let ux = b[0] - a[0], uz = b[1] - a[1]; const L = Math.hypot(ux, uz); if (L < 1e-6) continue; ux /= L; uz /= L;
      let mn0 = 1e9, mx0 = -1e9, mn1 = 1e9, mx1 = -1e9;
      for (const p of hull) { const s = p[0] * ux + p[1] * uz, t = -p[0] * uz + p[1] * ux; mn0 = Math.min(mn0, s); mx0 = Math.max(mx0, s); mn1 = Math.min(mn1, t); mx1 = Math.max(mx1, t); }
      const ar = (mx0 - mn0) * (mx1 - mn1);
      if (!best || ar < best.ar) best = { ar, ux, uz, c0: (mn0 + mx0) / 2, c1: (mn1 + mx1) / 2, h0: (mx0 - mn0) / 2, h1: (mx1 - mn1) / 2 };
    }
    if (!best) return null;
    best.cx = best.c0 * best.ux - best.c1 * best.uz; best.cz = best.c0 * best.uz + best.c1 * best.ux;
    return best;
  }
  function polyArea(P, n) { let s = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += P[i * 2] * P[j * 2 + 1] - P[j * 2] * P[i * 2 + 1]; } return s / 2; }
  function rgbFrom565(v) { return new THREE.Color().setRGB(((v >> 11) & 31) / 31, ((v >> 5) & 63) / 63, (v & 31) / 31, THREE.SRGBColorSpace); }
  // Pick facade style, material, floor height and colours for one OSM building (deterministic per building).
  function lookOf(b, region, r1, r2, r3, area) {
    const kind = b.kind, tall = b.h > 30, glassy = !!(b.flags & 16), vict = !!(b.flags & 32), hasFront = !!(b.flags & 4);
    let style = 1, fh = 3.1, mat = b.mat || 0, wall, roofC;
    if (kind === 0) { style = vict ? 6 : 8; fh = 3.0; }
    else if (kind === 1) { style = vict ? 6 : 1; fh = 3.0; }
    else if (kind === 2) { style = glassy || tall ? 3 : (b.flags & 2) && hasFront ? 4 : b.h > 13 ? 2 : (hasFront ? 4 : 2); fh = tall ? 3.9 : 3.8; }
    else if (kind === 3) { style = 5; fh = Math.max(4.2, b.h * 0.7); }
    else if (kind === 4) { style = 7; fh = 4.3; }
    else if (kind === 5) { style = 0; }
    else if (kind === 6) { style = 4; fh = 4.5; }
    else if (kind === 7) { style = 9; fh = 3.0; }
    if (b.levels > 0 && b.h > 4) fh = U.clamp((b.h - b.mh) / b.levels, 2.6, 5.5);
    if (b.h < 3.0) style = 0;
    // wall material when OSM doesn't say: region and type conventions
    if (!mat) {
      if (style === 3) mat = 4;
      else if (kind === 3) mat = r2 < 0.55 ? 6 : 3;
      else if (kind === 4) mat = r2 < 0.45 ? 2 : r2 < 0.7 ? 1 : 7;
      else if (region === 0 && (kind === 0 || kind === 1)) mat = vict ? (r2 < 0.7 ? 5 : 7) : 7;
      else if (region === 0 && kind === 2) mat = r2 < 0.35 ? 1 : r2 < 0.55 ? 3 : 7;
      else if (kind === 0) mat = r2 < 0.22 ? 5 : r2 < 0.3 ? 1 : 7;
      else if (kind === 2) mat = r2 < 0.2 ? 1 : r2 < 0.45 ? 3 : 7;
      else if (kind === 7) mat = 3;
      else mat = 7;
    }
    if (b.wall) wall = rgbFrom565(b.wall);
    else if (mat === 1) wall = pick(PAL.brick, r1).clone();
    else if (mat === 2) wall = pick(PAL.stone, r1).clone();
    else if (mat === 4) wall = pick(PAL.glass, r1).clone();
    else if (mat === 6) wall = pick(PAL.indus, r1).clone();
    else if (mat === 3) wall = (kind === 2 ? pick(PAL.comm, r1) : pick(PAL.indus, r1)).clone();
    else if (kind === 0) wall = pick(region === 0 ? PAL.sfWall : region === 5 ? PAL.southWall : PAL.penWall, r1).clone();
    else if (kind === 1) wall = pick(region === 0 ? PAL.sfWall : PAL.penWall, r1).clone();
    else if (kind === 2) wall = pick(region === 0 ? PAL.sfComm : PAL.comm, r1).clone();
    else if (kind === 4) wall = pick(PAL.civic, r1).clone();
    else wall = pick(PAL.comm, r1).clone();
    const pitched = b.roof >= 1 && b.roof <= 4 && area < 1400;
    if (b.roofc) roofC = rgbFrom565(b.roofc);
    else if (pitched) roofC = (region >= 2 && r3 < 0.35 ? pick(PAL.roofTile, r3 * 2.7) : pick(PAL.roofComp, r3 * 3.1)).clone();
    else roofC = (r3 < 0.5 ? COL.roofMembrane : COL.roofGravel).clone().multiplyScalar(0.88 + r2 * 0.2);
    return { style, fh, mat, wall, roofC, pitched };
  }
  // footprint -> walls (+ street-facing wall flag), flat or pitched roof (photo-textured when low), details when hi
  function buildingInto(tb, b, T, hf, ri, hi, photoOk) {
    const P = b.pts, n = P.length / 2; if (n < 3) return 0;
    const region = T.region !== undefined ? T.region : regionOf(T.oz + P[1]);
    let gmin = 1e9, gmax = -1e9, cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { const g = hf(P[i * 2], P[i * 2 + 1]); gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); cx += P[i * 2]; cz += P[i * 2 + 1]; }
    cx /= n; cz /= n; { const g = hf(cx, cz); gmin = Math.min(gmin, g); }
    const area = Math.abs(polyArea(P, n));
    const seedBase = (T.tx * 7919 + T.ty * 104729) & 0xffff;
    const r1 = U.hash2(seedBase, ri), r2 = U.hash2(ri, seedBase + 7), r3 = U.hash2(ri * 3 + 1, seedBase);
    const L = lookOf(b, region, r1, r2, r3, area);
    const base = gmin + 0.02;
    // pitched roof parameters (only on footprints that are nearly their oriented box)
    let eave = b.h, box = null, rh = 0;
    if (L.pitched) {
      box = obb(P, n);
      if (box && box.ar > 0 && area / (4 * box.h0 * box.h1) > 0.72) {
        const shortHalf = Math.min(box.h0, box.h1); rh = Math.min(Math.max(shortHalf * 0.55, 1.2), 4.6); eave = Math.max(2.6, b.h - rh);
      } else box = null;
    }
    const isPart = !!(b.flags & 8);
    const yb = b.mh > 0.5 ? base + b.mh : base - 1.2, ye = base + eave;
    const seed = Math.floor(r1 * 997);
    const parapet = hi && !box && (b.kind >= 1 && b.kind <= 4 || b.kind === 6 || b.kind === 7) && area > 120 && b.h > 5 && !isPart ? (b.h > 30 ? 1.3 : 0.9) : 0;
    const topY = ye + parapet;
    const win = [Math.round(L.fh * 100), L.style, seed, Math.round((eave + (parapet ? 0.01 : 0)) * 50)];
    const photo = photoOk && (b.flags & 1) ? 1 : 2;
    const slot = (cx >= TILE / 2 ? 1 : 0) + (cz >= TILE / 2 ? 2 : 0);
    // walls (CCW ring in x,z: outward normal = (dz, -dx))
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = P[i * 2], az = P[i * 2 + 1], bx = P[j * 2], bz = P[j * 2 + 1];
      const Lw = Math.hypot(bx - ax, bz - az); if (Lw < 0.05) continue;
      const surf = (b.front === i && (b.flags & 4)) ? 3 : 0;
      const bb = [surf, slot, L.mat, Lw >= 127.5 ? 255 : Math.round(Lw * 2)];
      bquad(tb, [ax, yb, az], [bx, yb, bz], [bx, topY, bz], [ax, topY, az], L.wall, win, bb, 0, Lw, yb - base, topY - base);
    }
    const roofB = [photo, slot, 0, 0], noWin = [0, 0, 0, 0];
    if (!box) {
      const contour = []; for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(P[i * 2], P[i * 2 + 1]));
      let faces = null; try { faces = THREE.ShapeUtils.triangulateShape(contour, []); } catch (err) { faces = null; }
      if (faces) for (const f of faces) {
        const V = f.map(k => [contour[k].x, ye, contour[k].y]);
        const cr = (V[1][0] - V[0][0]) * (V[2][2] - V[0][2]) - (V[1][2] - V[0][2]) * (V[2][0] - V[0][0]);
        if (cr < 0) btri(tb, V[0], V[1], V[2], L.roofC, noWin, roofB); else btri(tb, V[0], V[2], V[1], L.roofC, noWin, roofB);
      }
      if (parapet > 0) {                        // inner face + top of the parapet so it reads as a lip from above
        let mx = 0, mz = 0; for (let i = 0; i < n; i++) { mx += P[i * 2]; mz += P[i * 2 + 1]; } mx /= n; mz /= n;
        const lip = L.wall.clone().multiplyScalar(0.86), capB = [2, slot, 0, 0];
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n; const ax = P[i * 2], az = P[i * 2 + 1], bx = P[j * 2], bz = P[j * 2 + 1];
          const k = Math.min(0.35, 0.35 / Math.max(1, Math.hypot(ax - mx, az - mz)) * 1);
          const ia = [ax + (mx - ax) * k, az + (mz - az) * k], ib = [bx + (mx - bx) * k, bz + (mz - bz) * k];
          bquad(tb, [ib[0], ye, ib[1]], [ia[0], ye, ia[1]], [ia[0], topY, ia[1]], [ib[0], topY, ib[1]], lip, noWin, [0, 0, 0, 0], 0, 1, 0, 1);
          btriUp(tb, [ax, topY, az], [bx, topY, bz], [ib[0], topY, ib[1]], lip, noWin, capB); btriUp(tb, [ax, topY, az], [ib[0], topY, ib[1]], [ia[0], topY, ia[1]], lip, noWin, capB);
        }
        const bx0 = obb(P, n);
        if (bx0 && area > 300 && !(photo === 1)) {       // rooftop units (photo roofs already show the real ones)
          const units = Math.min(6, 1 + Math.floor(area / 900));
          for (let u = 0; u < units; u++) {
            const s0 = (U.hash2(ri + u * 13, seedBase) - 0.5) * bx0.h0 * 1.2, s1 = (U.hash2(seedBase + u * 7, ri) - 0.5) * bx0.h1 * 1.2;
            const x = bx0.cx + s0 * bx0.ux - s1 * bx0.uz, z = bx0.cz + s0 * bx0.uz + s1 * bx0.ux;
            const w = 2 + U.hash2(u, ri) * 3, h = 1.2 + U.hash2(ri, u) * 1.4;
            bbox(tb, x, ye + h / 2, z, w, h, w * 0.8, Math.atan2(bx0.uz, bx0.ux), COL.hvac);
          }
        }
      }
    } else {
      const ov = 0.45, longIs0 = box.h0 >= box.h1;
      const ax = longIs0 ? [box.ux, box.uz] : [-box.uz, box.ux], bxv = longIs0 ? [-box.uz, box.ux] : [box.ux, box.uz];
      const A = (longIs0 ? box.h0 : box.h1) + ov, Bh = (longIs0 ? box.h1 : box.h0) + ov;
      const P3 = (s, t, y) => [box.cx + ax[0] * s + bxv[0] * t, y, box.cz + ax[1] * s + bxv[1] * t];
      const y0 = ye, y1 = ye + rh, rc = L.roofC;
      const up = (a, b2, c2) => ((b2[0] - a[0]) * (c2[2] - a[2]) - (b2[2] - a[2]) * (c2[0] - a[0])) < 0;
      const addTri = (a, b2, c2) => { if (up(a, b2, c2)) btri(tb, a, b2, c2, rc, noWin, roofB); else btri(tb, a, c2, b2, rc, noWin, roofB); };
      const gableEnd = (g0, g1, g2) => { const w0 = [0, 0, 0, 0]; btri(tb, g0, g1, g2, L.wall, w0, [0, slot, L.mat, 0]); btri(tb, g0, g2, g1, L.wall, w0, [0, slot, L.mat, 0]); };
      if (b.roof === 1) {
        const r0 = P3(-A, 0, y1), r1_ = P3(A, 0, y1);
        addTri(P3(-A, -Bh, y0), P3(A, -Bh, y0), r1_); addTri(P3(-A, -Bh, y0), r1_, r0);
        addTri(P3(-A, Bh, y0), r1_, P3(A, Bh, y0)); addTri(P3(-A, Bh, y0), r0, r1_);
        for (const s of [-1, 1]) gableEnd(P3(s * (A - ov), -(Bh - ov), y0), P3(s * (A - ov), Bh - ov, y0), P3(s * (A - ov), 0, y1));
      } else if (b.roof === 3) {
        const apx = P3(0, 0, y1), c4 = [P3(-A, -Bh, y0), P3(A, -Bh, y0), P3(A, Bh, y0), P3(-A, Bh, y0)];
        for (let k = 0; k < 4; k++) addTri(c4[k], c4[(k + 1) % 4], apx);
      } else if (b.roof === 4) {
        const q0 = P3(-A, -Bh, y0), q1 = P3(A, -Bh, y0), q2 = P3(A, Bh, y1), q3 = P3(-A, Bh, y1);
        addTri(q0, q1, q2); addTri(q0, q2, q3);
        for (const s of [-1, 1]) gableEnd(P3(s * (A - ov), -(Bh - ov), y0), P3(s * (A - ov), Bh - ov, y0), P3(s * (A - ov), Bh - ov, y1));
      } else {
        const inset = Math.min(Bh, A * 0.95), r0 = P3(-(A - inset), 0, y1), r1_ = P3(A - inset, 0, y1);
        const c0 = P3(-A, -Bh, y0), c1 = P3(A, -Bh, y0), c2 = P3(A, Bh, y0), c3 = P3(-A, Bh, y0);
        addTri(c0, c1, r1_); addTri(c0, r1_, r0); addTri(c2, c3, r0); addTri(c2, r0, r1_); addTri(c1, c2, r1_); addTri(c3, c0, r0);
      }
    }
    return 1;
  }
  function bbox(tb, x, y, z, sx, sy, sz, rot, col) {       // axis box rotated about Y (rooftop units)
    const c = Math.cos(rot), s = Math.sin(rot), hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const Pt = (dx, dy, dz) => [x + dx * c + dz * s, y + dy, z - dx * s + dz * c];
    const v = [Pt(-hx, -hy, -hz), Pt(hx, -hy, -hz), Pt(hx, hy, -hz), Pt(-hx, hy, -hz), Pt(-hx, -hy, hz), Pt(hx, -hy, hz), Pt(hx, hy, hz), Pt(-hx, hy, hz)];
    const w0 = [0, 0, 0, 0], bw = [0, 0, 3, 0], bt = [2, 0, 0, 0];
    bquad(tb, v[0], v[1], v[2], v[3], col, w0, bw, 0, sx, 0, sy); bquad(tb, v[5], v[4], v[7], v[6], col, w0, bw, 0, sx, 0, sy);
    bquad(tb, v[4], v[0], v[3], v[7], col, w0, bw, 0, sz, 0, sy); bquad(tb, v[1], v[5], v[6], v[2], col, w0, bw, 0, sz, 0, sy);
    bquad(tb, v[3], v[2], v[6], v[7], col, w0, bt, 0, 1, 0, 1);
  }

  // ------------------------------------------------------------------ procedural house variants (infill only)
  const HV = {};
  function vbox(vb, cx, cy, cz, sx, sy, sz, part, win = 0, top = part, bottom = false) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const F = (a, b, c, d, p) => { vb.push([a, b, c, p, win], [a, c, d, p, win]); };
    if ((part === 3 || part === 4 || part === 6) && Math.min(sx, sz) <= 0.12) {
      if (sz <= sx) { if (cz >= 0) F([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], part); else F([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], part); }
      else if (cx >= 0) F([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], part); else F([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], part);
      return;
    }
    F([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], part);
    F([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], part);
    F([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], part);
    F([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], part);
    F([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], top);
    if (bottom) F([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], part);
  }
  function vhip(vb, cx, cz, hx, hz, y0, rh, alongX = true, part = 1) {
    const A = alongX ? hx : hz, B = alongX ? hz : hx, ins = Math.min(B, A * 0.95);
    const P = (s, t, y) => alongX ? [cx + s, y, cz + t] : [cx + t, y, cz + s];
    const r0 = P(-(A - ins), 0, y0 + rh), r1 = P(A - ins, 0, y0 + rh);
    const c0 = P(-A, -B, y0), c1 = P(A, -B, y0), c2 = P(A, B, y0), c3 = P(-A, B, y0);
    const up = (a, b, c) => ((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) < 0;
    const T = (a, b, c) => vb.push(up(a, b, c) ? [a, b, c, part, 0] : [a, c, b, part, 0]);
    T(c0, c1, r1); T(c0, r1, r0); T(c2, c3, r0); T(c2, r0, r1); T(c1, c2, r1); T(c3, c0, r0);
    const D = (a, b, c) => vb.push(up(a, b, c) ? [a, c, b, 2, 0] : [a, b, c, 2, 0]);
    D(c0, c3, c2); D(c0, c2, c1);
  }
  function vgable(vb, cx, cz, hx, hz, y0, rh, alongX = true, part = 1, ov = 0.4, endPart = 0) {
    const A = alongX ? hx : hz, B = alongX ? hz : hx;
    const P = (s, t, y) => alongX ? [cx + s, y, cz + t] : [cx + t, y, cz + s];
    const up = (a, b, c) => ((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) < 0;
    const T = (a, b, c, p) => vb.push(up(a, b, c) ? [a, b, c, p, 0] : [a, c, b, p, 0]);
    const r0 = P(-A, 0, y0 + rh), r1 = P(A, 0, y0 + rh);
    T(P(-A, -B, y0), P(A, -B, y0), r1, part); T(P(-A, -B, y0), r1, r0, part);
    T(P(-A, B, y0), r1, P(A, B, y0), part); T(P(-A, B, y0), r0, r1, part);
    for (const s of [-1, 1]) { const g0 = P(s * (A - ov), -(B - ov), y0), g1 = P(s * (A - ov), B - ov, y0), g2 = P(s * (A - ov), 0, y0 + rh - 0.05); vb.push([g0, g1, g2, endPart, 0], [g0, g2, g1, endPart, 0]); }
  }
  function winRow(vb, face, y, h, xs, w, depthSign, zOrX, idStart, alongX = true) {
    let id = idStart;
    for (const x of xs) { if (alongX) vbox(vb, x, y, zOrX + depthSign * 0.04, w, h, 0.1, 3, id++); else vbox(vb, zOrX + depthSign * 0.04, y, x, 0.1, h, w, 3, id++); }
    return id;
  }
  function makeVariant(name, W, D, H, fn) {
    const vb = []; fn(vb);
    const n = vb.length * 3, pos = new Float32Array(n * 3), part = new Float32Array(n), win = new Float32Array(n), col = new Float32Array(n * 3);
    let k = 0;
    for (const [a, b, c, p, w] of vb) for (const v of [a, b, c]) { pos[k * 3] = v[0]; pos[k * 3 + 1] = v[1]; pos[k * 3 + 2] = v[2]; part[k] = p; win[k] = w; col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = 1; k++; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
    g.setAttribute('aWinId', new THREE.BufferAttribute(win, 1)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const cc = g.attributes.color.array, pp = g.attributes.position.array;
    for (let i = 0; i < n; i++) { const y = pp[i * 3 + 1]; const ao = 0.78 + 0.22 * Math.min(1, y / 1.6); cc[i * 3] = cc[i * 3 + 1] = cc[i * 3 + 2] = ao; }
    g.computeBoundingSphere();
    HV[name] = { geo: g, W, D, H, tris: n / 3 };
  }
  function buildVariants() {
    // local frame: +Z faces the street, X along the street, origin at footprint center on the ground
    makeVariant('ranch', 14, 10, 4.8, vb => {
      vbox(vb, 0, 1.5, 0, 14, 3.0, 10, 0, 0, 0); vhip(vb, 0, 0, 7.5, 5.5, 3.0, 1.75, true, 1);
      vbox(vb, 3.6, 1.12, 5.03, 5.2, 2.25, 0.08, 4); vbox(vb, -1.4, 1.05, 5.03, 1.0, 2.1, 0.08, 4); vbox(vb, 3.6, 0.02, 7.5, 5.0, 0.04, 5.0, 2);
      let id = 1; id = winRow(vb, 0, 1.65, 1.2, [-5.0, -3.3], 1.4, 1, 5.0, id); id = winRow(vb, 0, 1.75, 1.1, [-4.5, -1.5, 1.5, 4.5], 1.6, -1, -5.0, id);
      id = winRow(vb, 0, 1.75, 1.0, [-2.5, 2.0], 1.2, 1, 7.0, id, false); winRow(vb, 0, 1.75, 1.0, [-2.5, 2.0], 1.2, -1, -7.0, id, false);
      vbox(vb, -4.2, 4.1, -1.8, 0.8, 2.0, 0.8, 5);
    });
    makeVariant('twostory', 12, 10, 8.3, vb => {
      vbox(vb, -1.5, 3.0, 0, 11, 6.0, 10, 0); vhip(vb, -1.5, 0, 6.0, 5.5, 6.0, 2.2, true, 1);
      vbox(vb, 6.2, 1.4, 1.0, 5.4, 2.8, 8.0, 0); vhip(vb, 6.2, 1.0, 3.0, 4.3, 2.8, 1.1, false, 1);
      vbox(vb, 6.2, 1.1, 5.03, 4.6, 2.2, 0.08, 4); vbox(vb, -2.4, 1.1, 5.03, 1.05, 2.2, 0.08, 4); vbox(vb, -2.4, 3.05, 5.35, 2.2, 0.15, 0.8, 2);
      let id = 1; id = winRow(vb, 0, 1.6, 1.3, [-5.2, 0.8], 1.6, 1, 5.0, id); id = winRow(vb, 0, 4.4, 1.2, [-5.2, -2.4, 0.8], 1.3, 1, 5.0, id);
      id = winRow(vb, 0, 1.6, 1.3, [-5, -1, 3], 1.5, -1, -5.0, id); winRow(vb, 0, 4.4, 1.2, [-5, -1, 3], 1.3, -1, -5.0, id);
    });
    makeVariant('eichler', 15, 11, 4.1, vb => {
      vbox(vb, 0, 1.45, 0, 15, 2.9, 11, 0); vgable(vb, 0, 0, 7.5 + 0.9, 5.5 + 0.9, 2.9, 0.75, false, 1, 0.9, 3);
      vbox(vb, 4.6, 1.05, 5.03, 4.8, 2.1, 0.08, 4); vbox(vb, -1.6, 1.05, 5.03, 1.1, 2.1, 0.08, 4); vbox(vb, -0.4, 2.4, 5.04, 13.8, 0.35, 0.06, 3, 40);
      winRow(vb, 0, 1.4, 2.4, [-6, -3, 0, 3, 6], 2.8, -1, -5.5, 1);
    });
    makeVariant('bungalow', 9.5, 13, 5.6, vb => {
      vbox(vb, 0, 1.7, -0.5, 9.5, 3.4, 12, 0); vgable(vb, 0, -0.5, 5.2, 6.6, 3.4, 2.4, false, 1, 0.5, 0);
      vbox(vb, 0, 0.35, 6.4, 7.5, 0.7, 2.4, 2); for (const x of [-3.4, 3.4]) vbox(vb, x, 1.7, 7.4, 0.3, 2.7, 0.3, 2);
      vbox(vb, 0, 3.25, 6.6, 8.2, 0.25, 2.9, 1); vbox(vb, 0, 1.45, 5.53, 1.0, 2.1, 0.08, 4);
      let id = 1; id = winRow(vb, 0, 1.9, 1.4, [-2.8, 2.8], 1.6, 1, 5.5, id);
      id = winRow(vb, 0, 1.9, 1.2, [-3, 0, 3], 1.2, 1, 4.8, id, false); winRow(vb, 0, 1.9, 1.2, [-3, 0, 3], 1.2, -1, -4.8, id, false);
    });
    makeVariant('apartment', 22, 14, 9.6, vb => {
      vbox(vb, 0, 4.4, 0, 22, 8.8, 14, 0, 0, 1); vbox(vb, 0, 9.1, 0, 22.2, 0.6, 14.2, 2, 0, 2);
      let id = 1;
      for (const y of [1.6, 4.5, 7.4]) { id = winRow(vb, 0, y, 1.4, [-9, -5.4, -1.8, 1.8, 5.4, 9], 1.6, 1, 7.0, id); id = winRow(vb, 0, y, 1.4, [-9, -5.4, -1.8, 1.8, 5.4, 9], 1.6, -1, -7.0, id); }
      for (const y of [3.1, 6.0]) for (const x of [-7.2, 0, 7.2]) vbox(vb, x, y, 7.55, 3.0, 0.15, 1.1, 2);
      vbox(vb, 0, 1.2, 7.03, 1.6, 2.4, 0.08, 4); vbox(vb, -6, 9.8, -2, 2.5, 1.2, 2.0, 5);
    });
    makeVariant('simple', 12, 10, 4.8, vb => { vbox(vb, 0, 1.5, 0, 12, 3.0, 10, 0); vhip(vb, 0, 0, 6.4, 5.4, 3.0, 1.7, true, 1); });
    makeVariant('simpleFlat', 12, 12, 7, vb => { vbox(vb, 0, 3.5, 0, 12, 7, 12, 0, 0, 1); });
  }

  // ------------------------------------------------------------------ fallback trees and street lights
  const TREEG = {}, TREEG_LO = {}, _nv = new THREE.Vector3();
  function flipped(g0) {
    const g = g0.index ? g0.toNonIndexed() : g0.clone();
    for (const k in g.attributes) { const at = g.attributes[k], a = at.array, s = at.itemSize;
      for (let t = 0; t < at.count; t += 3) for (let c = 0; c < s; c++) { const i1 = (t + 1) * s + c, i2 = (t + 2) * s + c, v = a[i1]; a[i1] = a[i2]; a[i2] = v; }
      if (k === 'normal') for (let i = 0; i < a.length; i++) a[i] = -a[i]; }
    return g;
  }
  function treeGeo(kind, lo) {
    const parts = [], d = lo ? 0 : 1;
    const add = (g, col) => {
      if (g.index) g = g.toNonIndexed();
      const n = g.attributes.position.count, c = new Float32Array(n * 3), cc = new THREE.Color(col), p = g.attributes.position.array;
      for (let i = 0; i < n; i++) { const v = 0.82 + 0.3 * U.hash2(Math.round(p[i * 3] * 7), Math.round(p[i * 3 + 1] * 7 + p[i * 3 + 2] * 5));
        const top = 0.9 + 0.12 * Math.min(1, Math.max(0, (p[i * 3 + 1] - 3) / 8));
        c[i * 3] = cc.r * v * top; c[i * 3 + 1] = cc.g * v * top; c[i * 3 + 2] = cc.b * v * top; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3)); if (g.attributes.uv) g.deleteAttribute('uv'); parts.push(g); };
    const blob = (r, x, y, z, sx, sy, sz, col) => { const g = new THREE.IcosahedronGeometry(r, d), pp = g.attributes.position, nn = g.attributes.normal;
      for (let i = 0; i < pp.count; i++) { _nv.set(pp.getX(i), pp.getY(i), pp.getZ(i)).normalize(); nn.setXYZ(i, _nv.x, _nv.y * 1.2 + 0.15, _nv.z); }
      add(U.place(g, x, y, z, 0, 0, 0, sx, sy, sz), col); };
    const trunk = (r0, r1, h, col) => add(U.place(new THREE.CylinderGeometry(r0, r1, h, lo ? 3 : 5, 1, true), 0, h / 2, 0), col);
    if (kind === 'broad') { trunk(0.14, 0.26, 3.6, '#5a4634'); if (lo) blob(2.9, 0, 5.0, 0, 1.25, 0.85, 1.2, '#587239'); else { blob(2.6, 0, 4.7, 0, 1.2, 0.8, 1.1, '#56703a'); blob(1.9, 1.4, 5.5, 0.6, 1, 0.85, 1, '#5e7a3e'); blob(1.8, -1.3, 5.2, -0.8, 1, 0.8, 1, '#4f6936'); } }
    else if (kind === 'conifer') { trunk(0.2, 0.36, 5, '#4a3526'); if (lo) add(U.place(new THREE.ConeGeometry(2.6, 11, 5, 1, true), 0, 8.2, 0), '#324d2e'); else { add(U.place(new THREE.ConeGeometry(2.7, 6, 8, 1, true), 0, 6.0, 0), '#2f4a2c'); add(U.place(new THREE.ConeGeometry(2.1, 5, 8, 1, true), 0, 9.0, 0), '#34502f'); add(U.place(new THREE.ConeGeometry(1.3, 4.2, 8, 1, true), 0, 11.9, 0), '#3a5634'); } }
    else if (kind === 'palm') {
      trunk(0.2, 0.32, 9, '#8a7358'); if (!lo) add(U.place(new THREE.IcosahedronGeometry(0.6, 0), 0, 9.1, 0), '#6b5a3c');
      const nf = lo ? 5 : 10;
      for (let i = 0; i < nf; i++) { const a = (i / nf) * Math.PI * 2, tilt = 0.5 + (i % 3) * 0.22;
        const f = new THREE.PlaneGeometry(0.9, 3.8, 1, lo ? 1 : 2); f.rotateX(-Math.PI / 2); f.translate(0, 0, 1.9);
        if (!lo) { const pp = f.attributes.position; for (let k = 0; k < pp.count; k++) { const zz = pp.getZ(k); pp.setY(k, -0.08 * zz * zz); } }
        const fg = U.place(f, 0, 9.2, 0, tilt, a, 0); add(fg, i % 2 ? '#5f7d33' : '#6e8a3a'); if (!lo) add(flipped(fg), i % 2 ? '#4d6a2b' : '#5a7532'); }
    } else if (kind === 'euc') { trunk(0.2, 0.42, 9, '#cbc3b0'); if (lo) blob(3.4, 0, 11.5, 0, 1, 1.45, 1, '#7b8a68'); else { blob(3.0, 0.7, 11.2, 0, 1, 1.35, 1, '#7d8c6a'); blob(2.4, -1.8, 9.2, 0.7, 1, 1.15, 1, '#728362'); blob(2.1, 1.2, 14.0, -0.7, 1, 1.2, 1, '#869471'); } }
    const g = U.mergeGeometries(parts); g.computeBoundingSphere();
    return g;
  }
  let lightGeo = null, glowGeo = null, poolGeo = null;
  function buildLightGeo() {
    const pole = U.place(new THREE.CylinderGeometry(0.08, 0.12, 8.5, 5, 1, true), 0, 4.25, 0);
    const arm = U.place(new THREE.BoxGeometry(0.1, 0.1, 2.0), 0, 8.4, 0.95);
    const head = U.place(new THREE.BoxGeometry(0.35, 0.16, 0.75), 0, 8.32, 1.95);
    const parts = [pole, arm, head].map(g => { g = g.index ? g.toNonIndexed() : g; g.deleteAttribute('uv'); return g; });
    lightGeo = U.mergeGeometries(parts); lightGeo.computeVertexNormals();
    glowGeo = new THREE.PlaneGeometry(1, 1);
    poolGeo = new THREE.PlaneGeometry(17, 17); poolGeo.rotateX(-Math.PI / 2);
  }
  function tint(r, base, amount) { const c = base.clone(); c.offsetHSL((r - 0.5) * 0.04, (U.hash2(r * 1000, 3) - 0.5) * 0.15 * amount, (U.hash2(7, r * 1000) - 0.5) * 0.12 * amount); return c; }

  // ------------------------------------------------------------------ occupancy grid (per tile)
  const GS = 2, GN = Math.round((TILE + 40) / GS);          // 2 m cells covering -20 .. TILE+20 m
  let occ = null;
  const ci = x => Math.floor((x + 20) / GS);
  const O_YARD = 1, O_PARK = 2, O_HOUSE = 3, O_HARD = 4;
  function occAt(x, z) { const i = ci(x), j = ci(z); return (i < 0 || j < 0 || i >= GN || j >= GN) ? O_HARD : occ[j * GN + i]; }
  function markSeg(ax, az, bx, bz, hw, val) {
    const x0 = Math.max(0, ci(Math.min(ax, bx) - hw)), x1 = Math.min(GN - 1, ci(Math.max(ax, bx) + hw));
    const z0 = Math.max(0, ci(Math.min(az, bz) - hw)), z1 = Math.min(GN - 1, ci(Math.max(az, bz) + hw));
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9, hw2 = hw * hw;
    for (let j = z0; j <= z1; j++) { const pz = j * GS - 20 + GS / 2;
      for (let i = x0; i <= x1; i++) { const px = i * GS - 20 + GS / 2;
        let t = ((px - ax) * dx + (pz - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + dx * t - px, ez = az + dz * t - pz;
        if (ex * ex + ez * ez <= hw2) { const k = j * GN + i; if (occ[k] < val) occ[k] = val; } } }
  }
  function markPoly(P, n, val, dil) {
    let z0 = 1e9, z1 = -1e9; for (let i = 0; i < n; i++) { z0 = Math.min(z0, P[i * 2 + 1]); z1 = Math.max(z1, P[i * 2 + 1]); }
    const j0 = Math.max(0, ci(z0 - dil)), j1 = Math.min(GN - 1, ci(z1 + dil)); const xsx = [];
    for (let j = j0; j <= j1; j++) {
      const pz = j * GS - 20 + GS / 2; xsx.length = 0;
      for (let i = 0; i < n; i++) { const k = (i + 1) % n; const az = P[i * 2 + 1], bz = P[k * 2 + 1];
        if ((az <= pz && bz > pz) || (bz <= pz && az > pz)) { const t = (pz - az) / (bz - az); xsx.push(P[i * 2] + (P[k * 2] - P[i * 2]) * t); } }
      xsx.sort((a, b) => a - b);
      for (let m = 0; m + 1 < xsx.length; m += 2) { const i0 = Math.max(0, ci(xsx[m] - dil)), i1 = Math.min(GN - 1, ci(xsx[m + 1] + dil));
        for (let i = i0; i <= i1; i++) { const kk = j * GN + i; if (occ[kk] < val) occ[kk] = val; } }
    }
    if (dil > 0) for (let i = 0; i < n; i++) { const k = (i + 1) % n; markSeg(P[i * 2], P[i * 2 + 1], P[k * 2], P[k * 2 + 1], dil, val); }
  }
  function rectFree(cx, cz, ux, uz, hw, hd, block = 1) {
    for (let a = -hw; a <= hw + 0.01; a += Math.max(1.6, hw / 3)) for (let b = -hd; b <= hd + 0.01; b += Math.max(1.6, hd / 3)) {
      if (occAt(cx + ux * a - uz * b, cz + uz * a + ux * b) >= block) return false; }
    return true;
  }
  function markRect(cx, cz, ux, uz, hw, hd, val) {
    const c = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([a, b]) => [cx + ux * a - uz * b, cz + uz * a + ux * b]);
    const P = new Float32Array(8); c.forEach((p, i) => { P[i * 2] = p[0]; P[i * 2 + 1] = p[1]; }); markPoly(P, 4, val, 0);
  }

  // ------------------------------------------------------------------ photo roofs: texture slots per tile
  function imgAt(x, z) { if (!hasImagery()) return null; try { const r = Terrain.imagery(x, z); return r && r.tex ? r : null; } catch (e) { return null; } }
  const retainTex = tex => { if (tex && hasTerrain() && typeof Terrain.retain === 'function') try { Terrain.retain(tex); } catch (e) { /* optional API */ } };
  const releaseTex = tex => { if (tex && hasTerrain() && typeof Terrain.release === 'function') try { Terrain.release(tex); } catch (e) { /* optional API */ } };
  // Each slot (tile quadrant) uses the terrain's finest imagery when it is at least level 7; otherwise the tile loads its own
  // level-7 photo (level 6 if missing), so roofs 1–3 km away are still sharp even where the terrain only draws coarse nodes.
  function ownImagery(t) {
    if (t.own || !hasStream() || typeof Stream.image !== 'function') return;
    t.own = { state: 1, tex: null, x0: t.ox, z0: t.oz, size: TILE, L: 7 };
    const load = (L, tx, ty) => Stream.image(`tiles/img/${L}/${tx}_${ty}.jpg`, 6 + Math.round(t.dist / 500)).then(bmp => {
      if (t.state === 'dead') { if (bmp.close) bmp.close(); return; }
      const tex = new THREE.Texture(bmp); tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.anisotropy = 4; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.needsUpdate = true;
      const T = 102400 / (1 << L);
      Object.assign(t.own, { state: 2, tex, bmp, x0: X0 + tx * T, z0: Z0 + ty * T, size: T, L }); refreshImagery(t);
    });
    load(7, t.tx, t.ty).catch(() => load(6, t.tx >> 1, t.ty >> 1)).catch(() => { t.own.state = 3; });
  }
  function refreshImagery(t) {
    if (!t.u) return;
    for (let q = 0; q < 4; q++) {
      let im = imgAt(t.ox + ((q & 1) ? 0.75 : 0.25) * TILE, t.oz + ((q & 2) ? 0.75 : 0.25) * TILE);
      if (!im || im.L < 7) {
        if (!t.own) ownImagery(t);
        if (t.own && t.own.state === 2 && (!im || im.L < t.own.L)) im = t.own;
      }
      const sl = t.slots[q];
      if (!im) continue;
      if (sl.tex === im.tex && sl.x0 === im.x0 && sl.z0 === im.z0 && sl.size === im.size) continue;
      if (sl.tex !== (t.own && t.own.tex)) releaseTex(sl.tex);
      if (im !== t.own) retainTex(im.tex);
      sl.tex = im.tex; sl.x0 = im.x0; sl.z0 = im.z0; sl.size = im.size; sl.L = im.L;
      t.u['uImg' + q].value = im.tex; t.u['uImgX' + q].value.set(im.x0, im.z0, im.size, (im.L === undefined || im.L >= 6) ? 1 : 0);   // coarser photos would smear streets onto roofs
      t.u.uImgSRGB.value = im.tex.colorSpace === THREE.SRGBColorSpace ? 0 : 1;
    }
  }
  function dropImagery(t) {
    if (t.slots) for (const sl of t.slots) { if (!(t.own && sl.tex === t.own.tex)) releaseTex(sl.tex); sl.tex = null; }
    if (t.own) { if (t.own.tex) t.own.tex.dispose(); if (t.own.bmp && t.own.bmp.close) t.own.bmp.close(); t.own = null; }
  }

  // ------------------------------------------------------------------ tile building (generators, time-sliced)
  // Two independent parts per tile, each with a level:
  //   bld: 1 = real buildings (walls with shader facades, photo or procedural roofs), 2 = + parapets and rooftop units
  //   gnd: 1 = street ribbons, street lights, infill houses (simple), fallback trees; 2 = + sidewalks, curbs, crosswalks,
  //        parking lots, plazas, yards, detailed infill houses
  function* buildBld(t, lvl) {
    const T = t.data, hi = lvl >= 2, photoOk = hasImagery();
    if (!t.hf) yield* heightField(t);
    const tb = new TB(BSPEC); let nb = 0;
    for (let i = 0; i < T.b.length; i++) { nb += buildingInto(tb, T.b[i], T, t.hf, i, hi, photoOk); if ((i & 15) === 15 && now() > deadline) yield; }
    const g = tb.build();
    if (now() > deadline) yield;
    clearBld(t);
    if (g) {
      if (!t.mat) { t.u = makeImgUniforms(); t.mat = makeBldMat(t.u); t.slots = [0, 1, 2, 3].map(() => ({ tex: null, x0: 0, z0: 0, size: 0 })); }
      const m = new THREE.Mesh(g, t.mat); m.castShadow = t.dist < SHADOW_R; m.receiveShadow = true; m.name = 'buildings'; t.root.add(m); t.bldMesh = m;
      t.bldTris = (g.index ? g.index.count : 0) / 3; stats.bldTris += t.bldTris;
      refreshImagery(t);
    }
    t.bldLvl = lvl; t.nB = nb; stats.buildings += nb; stats.built++;
  }
  function clearBld(t) {
    if (t.bldMesh) { t.root.remove(t.bldMesh); t.bldMesh.geometry.dispose(); t.bldMesh = null; stats.bldTris -= t.bldTris || 0; t.bldTris = 0; }
    stats.buildings -= t.nB || 0; t.nB = 0; t.bldLvl = 0;
  }

  function* buildGnd(t, lvl) {
    const T = t.data, hi = lvl >= 2;
    if (!t.hf) yield* heightField(t);
    const hf = t.hf;
    if (!t.inter) { t.inter = new Map(); for (const it of T.it) t.inter.set(Math.round(it.x * 10) + ':' + Math.round(it.z * 10), { R: Math.max(...it.ap.map(a => a.hw)), flags: it.flags }); }
    const tb = new TB(RSPEC);
    for (let i = 0; i < T.r.length; i++) { roadRibbon(tb, T.r[i], T, hf, t.inter, hi); if ((i & 3) === 3 && now() > deadline) yield; }
    const photo = hasImagery();
    for (let i = 0; i < T.a.length; i++) {
      const a = T.a[i];
      if (photo) continue;                                               // the photo shows the real lots, parks and fields (with cars, trees)
      if ((a.kind === 3 || a.kind === 4) && !hi) continue;               // parking / plazas: close up only
      areaPoly(tb, a, hf); if ((i & 7) === 7 && now() > deadline) yield;
    }
    // --- local context: distance to the tracks (coarse lower bound, exact near the line)
    const tdc = new Float32Array(81);
    for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) tdc[j * 9 + i] = ctx.trackDist(T.ox + i * 100, T.oz + j * 100);
    const td = (x, z) => { const i = Math.min(8, Math.max(0, Math.round(x / 100))), j = Math.min(8, Math.max(0, Math.round(z / 100)));
      const lb = tdc[j * 9 + i] - Math.hypot(x - i * 100, z - j * 100); return lb > 45 ? lb : ctx.trackDist(T.ox + x, T.oz + z); };
    if (now() > deadline) yield;
    const rnd = U.rng((t.tx * 73856093) ^ (t.ty * 19349663));
    const objs = [], houses = [], lights = [];
    const trees = { broad: [], conifer: [], palm: [], euc: [] };
    const wantTrees = !floraCovers(T.ox + TILE / 2, T.oz + TILE / 2);
    // --- infill houses (only in 25 m cells the bake marked: residential land with no OSM buildings)
    if (T.mask) {
      occ = t.occ = new Uint8Array(GN * GN);
      for (const r of T.r) { const P = r.pts, n = P.length / 2; const walks = (r.flags & 8) && r.cls >= 4 && r.cls <= 12;
        const hw = r.width / 2 + (walks ? (r.cls <= 7 ? 3.4 : 3.6) : 1.5);
        for (let i = 0; i + 1 < n; i++) markSeg(P[i * 2], P[i * 2 + 1], P[i * 2 + 2], P[i * 2 + 3], hw, O_HARD); }
      if (now() > deadline) yield;
      for (const b of T.b) markPoly(b.pts, b.pts.length / 2, O_HARD, 2.0);
      for (const a of T.a) markPoly(a.pts, a.pts.length / 2, O_PARK, 0.5);
      if (now() > deadline) yield;
      for (let ri = 0; ri < T.r.length; ri++) {
        const r = T.r[ri]; const P = r.pts, n = P.length / 2; if (n < 2) continue;
        if (!(r.cls === 10 || r.cls === 12 || r.cls === 11)) continue;
        const region = T.region;
        const edge = r.width / 2 + ((r.flags & 8) ? 2.4 : 1.2);
        let carry = rnd() * 6;
        for (let i = 0; i + 1 < n; i++) {
          const ax = P[i * 2], az = P[i * 2 + 1], bx = P[i * 2 + 2], bz = P[i * 2 + 3];
          const L = Math.hypot(bx - ax, bz - az); if (L < 6) { carry = Math.max(0, carry - L); continue; }
          const ux = (bx - ax) / L, uz = (bz - az) / L;
          let s = carry;
          while (s < L) {
            const q = rnd(); let v;
            if (region === 0) v = 'simpleFlat';
            else if (region === 1) v = q < 0.45 ? 'ranch' : q < 0.75 ? 'twostory' : 'bungalow';
            else if (region === 2) v = q < 0.32 ? 'ranch' : q < 0.6 ? 'twostory' : q < 0.8 ? 'bungalow' : 'eichler';
            else if (region === 3) v = q < 0.4 ? 'ranch' : q < 0.65 ? 'eichler' : 'twostory';
            else if (region === 4) v = q < 0.45 ? 'ranch' : q < 0.7 ? 'bungalow' : 'twostory';
            else v = q < 0.55 ? 'ranch' : q < 0.85 ? 'twostory' : 'bungalow';
            const base = HV[v]; const W = base.W * (0.88 + rnd() * 0.24), D = base.D * (0.9 + rnd() * 0.2), H = base.H * (0.92 + rnd() * 0.16);
            const gap = 2.6 + rnd() * 3.5, lot = W + gap;
            if (s + W / 2 > L) break;
            const cxs = ax + ux * (s + W / 2), czs = az + uz * (s + W / 2);
            for (const side of [-1, 1]) {
              if (rnd() < 0.1) continue;
              const setback = 5.5 + rnd() * 3.5, off = edge + setback + D / 2;
              const nxs = -uz * side, nzs = ux * side;
              const cx = cxs + nxs * off, cz = czs + nzs * off;
              if (cx < 0 || cx >= TILE || cz < 0 || cz >= TILE || !infillAt(T, cx, cz)) continue;
              if (!rectFree(cx, cz, ux * side, uz * side, W / 2 + 0.8, D / 2 + 0.5, O_PARK)) continue;
              if (td(cx, cz) < 15 + Math.max(W, D) * 0.5 || (ctx.keepOut && ctx.keepOut(T.ox + cx, T.oz + cz))) continue;
              if (ctx.isWater && ctx.isWater(T.ox + cx, T.oz + cz)) continue;
              const g0 = hf(cx, cz), g1 = hf(cx + nxs * D * 0.5, cz + nzs * D * 0.5), g2 = hf(cx - nxs * D * 0.5, cz - nzs * D * 0.5);
              if (Math.abs(g1 - g2) > 4.5) continue;
              markRect(cx, cz, ux * side, uz * side, W / 2 + 0.6, D / 2 + 0.6, O_HOUSE);
              markRect(cx + nxs * 5, cz + nzs * 5, ux * side, uz * side, W / 2 + gap / 2 + 0.6, D / 2 + 8, O_YARD);
              const yaw = Math.atan2(-nxs, -nzs), rr = rnd();
              let wall, roof;
              if (v === 'eichler') { wall = pick(PAL.eichWall, rr); roof = pick(PAL.roofFlat, rnd()); }
              else if (v === 'simpleFlat') { wall = pick(PAL.sfWall, rr); roof = pick(PAL.roofFlat, rnd()); }
              else { wall = pick(region === 5 ? PAL.southWall : PAL.penWall, rr); roof = (region >= 2 && rnd() < 0.34) ? pick(PAL.roofTile, rnd()) : pick(PAL.roofComp, rnd()); }
              houses.push({ v, far: v === 'simpleFlat' ? 'simpleFlat' : 'simple', x: cx, y: Math.min(g0, g1, g2) - 0.05, z: cz, yaw, W, H, D, wall, roof, seed: rnd(), lit: 0.55 });
              if (hi && region >= 1) {
                const lawnD = setback + D + 4, lcx = cxs + nxs * (edge + lawnD / 2), lcz = czs + nzs * (edge + lawnD / 2);
                flatQuadR(tb, hf, lcx, lcz, ux, uz, (W + gap) / 2 - 0.3, lawnD / 2, tint(rnd(), region >= 4 || rnd() < 0.2 ? COL.lawnDry : COL.lawn, 1), 10, 0.10);
                const dcx = cxs + ux * (W * 0.26) + nxs * (edge + setback / 2), dcz = czs + uz * (W * 0.26) + nzs * (edge + setback / 2);
                flatQuadR(tb, hf, dcx, dcz, ux, uz, 1.6, setback / 2 + 0.3, COL.drive, 11, 0.12);
              }
              if (wantTrees && rnd() < 0.7) { const bx2 = cx + nxs * (D / 2 + 3 + rnd() * 4), bz2 = cz + nzs * (D / 2 + 3 + rnd() * 4);
                if (td(bx2, bz2) > 9) trees.broad.push([bx2, hf(bx2, bz2), bz2, 0.8 + rnd() * 0.7]); }
            }
            s += lot;
          }
          carry = Math.max(0, s - L);
        }
        if ((ri & 7) === 7 && now() > deadline) yield;
      }
      t.occ = null;
    }
    // --- street lights: mapped lamps, plus arterials / SF / downtown San Jose streets away from mapped ones
    const LM = T.lamps;
    for (let i = 0; i < LM.length; i += 2) { const x = LM[i], z = LM[i + 1]; if (x < 0 || x >= TILE || z < 0 || z >= TILE) continue; lights.push([x, hf(x, z) + 0.3, z, rnd() * Math.PI * 2]); }
    const nearMapped = (x, z) => { for (let i = 0; i < LM.length; i += 2) if (Math.abs(LM[i] - x) < 22 && Math.abs(LM[i + 1] - z) < 22) return true; return false; };
    for (const r of T.r) {
      if (!(r.flags & 8) || r.flags & 2) continue;
      const region = T.region;
      const want = (r.cls >= 4 && r.cls <= 9) || (r.cls >= 10 && r.cls <= 12 && (region === 0 || region === 4));
      if (!want) continue;
      const P = r.pts, n = P.length / 2, gapL = region === 0 ? 30 : 40; let next = rnd() * gapL, u0 = 0, side = 1;
      for (let i = 0; i + 1 < n; i++) {
        const ax = P[i * 2], az = P[i * 2 + 1], bx = P[i * 2 + 2], bz = P[i * 2 + 3], L = Math.hypot(bx - ax, bz - az);
        const ux = (bx - ax) / (L || 1), uz = (bz - az) / (L || 1);
        for (; next < u0 + L; next += gapL) {
          const s0 = next - u0, o = r.width / 2 + (r.cls <= 9 ? 1.0 : 0.7), px = ax + ux * s0 - uz * o * side, pz = az + uz * s0 + ux * o * side;
          if (px >= 0 && px < TILE && pz >= 0 && pz < TILE && td(px, pz) > 6 && !nearMapped(px, pz)) lights.push([px, hf(px, pz) + 0.3, pz, Math.atan2(uz * side, -ux * side)]);
          if (r.cls <= 7 || !(r.flags & 1)) side = -side;
        }
        u0 += L;
      }
    }
    if (now() > deadline) yield;
    // --- fallback trees (no vegetation module): mapped trees, and trees in parks
    if (wantTrees) {
      for (const tr of T.t) { const arr = tr.kind === 1 ? trees.palm : tr.kind === 2 ? trees.conifer : tr.kind === 3 ? trees.euc : trees.broad;
        if (td(tr.x, tr.z) > 7) arr.push([tr.x, hf(tr.x, tr.z), tr.z, [0.6, 0.9, 1.25, 1.6][tr.size] || 1]); }
      for (const a of T.a) {
        if (a.kind !== 0 && a.kind !== 5) continue;
        const P = a.pts, n = P.length / 2; const ar = Math.abs(polyArea(P, n)); const cnt = Math.min(120, Math.floor(ar / 420));
        let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9; for (let i = 0; i < n; i++) { minx = Math.min(minx, P[i * 2]); maxx = Math.max(maxx, P[i * 2]); minz = Math.min(minz, P[i * 2 + 1]); maxz = Math.max(maxz, P[i * 2 + 1]); }
        for (let k = 0, tries = 0; k < cnt && tries < cnt * 4; tries++) {
          const x = minx + rnd() * (maxx - minx), z = minz + rnd() * (maxz - minz);
          let inside = false; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = P[i * 2], zi = P[i * 2 + 1], xj = P[j * 2], zj = P[j * 2 + 1]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside; }
          if (!inside || td(x, z) < 9) continue;
          (rnd() < 0.1 ? trees.conifer : rnd() < 0.08 ? trees.euc : trees.broad).push([x, hf(x, z), z, 0.8 + rnd() * 0.8]); k++;
        }
        if (now() > deadline) yield;
      }
    }
    // --- meshes (nothing visible until the swap)
    const g = tb.build();
    if (now() > deadline) yield;
    let ntrees = 0;
    for (const kind in trees) {
      const list = trees[kind]; if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(TREEG_LO[kind], treeMat, list.length); mesh.userData.treeKind = kind;
      list.forEach((o, i) => {
        _q.setFromAxisAngle(_up, U.hash2(i, o[0] | 0) * Math.PI * 2); const sc = o[3];
        _m.compose(_p.set(o[0], o[1] - 0.1, o[2]), _q, _s.set(sc, sc * (0.85 + U.hash2(o[2] | 0, i) * 0.35), sc)); mesh.setMatrixAt(i, _m);
        const h = U.hash2(i * 7, o[2] | 0); _c.setRGB(0.85 + h * 0.3, 0.9 + U.hash2(i, 3) * 0.2, 0.8 + h * 0.2); mesh.setColorAt(i, _c);
      });
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere(); mesh.name = 'trees-' + kind; objs.push(mesh); ntrees += list.length;
    }
    if (lights.length) {
      const poles = new THREE.InstancedMesh(lightGeo, poleMat, lights.length), glows = new THREE.InstancedMesh(glowGeo, glowMat, lights.length);
      const pools = new THREE.InstancedMesh(poolGeo, poolMat, lights.length);
      lights.forEach((l, i) => {
        _q.setFromAxisAngle(_up, l[3]); _m.compose(_p.set(l[0], l[1], l[2]), _q, _s.set(1, 1, 1)); poles.setMatrixAt(i, _m);
        const hx = l[0] + Math.sin(l[3]) * 1.95, hz = l[2] + Math.cos(l[3]) * 1.95;
        _m.makeTranslation(hx, l[1] + 8.1, hz); glows.setMatrixAt(i, _m);
        _m.makeTranslation(hx, hf(hx, hz) + 0.5, hz); pools.setMatrixAt(i, _m);
      });
      pools.computeBoundingSphere(); pools.userData.pool = true; pools.renderOrder = 4; pools.name = 'streetlight-pools'; objs.push(pools);
      poles.computeBoundingSphere(); poles.castShadow = false; poles.userData.pole = true; glows.userData.glow = true; glows.frustumCulled = false; glows.renderOrder = 5;
      poles.name = 'streetlights'; glows.name = 'streetlight-glow'; objs.push(poles, glows);
    }
    clearGnd(t);
    if (g) { const m = new THREE.Mesh(g, roadMat); m.receiveShadow = true; m.name = 'ground'; t.root.add(m); t.gndMesh = m; t.gndTris = (g.index ? g.index.count : 0) / 3; stats.groundTris += t.gndTris; }
    for (const o of objs) t.root.add(o);
    t.objs = objs; t.houses = houses;
    t.nH = houses.length; t.nT = ntrees; t.nL = lights.length; stats.houses += t.nH; stats.trees += t.nT; stats.lights += t.nL;
    buildHouses(t, hi);
    t.gndLvl = lvl; t.treeNear = t.poleVis = t.glowVis = t.poolVis = t.gndVis = null; lodTouch(t, true);
    stats.built++;
  }
  function clearGnd(t) {
    if (t.gndMesh) { t.root.remove(t.gndMesh); t.gndMesh.geometry.dispose(); t.gndMesh = null; stats.groundTris -= t.gndTris || 0; t.gndTris = 0; }
    for (const o of t.objs || []) { t.root.remove(o); disposeObj(o); }
    for (const m of t.houseMeshes || []) { t.root.remove(m); disposeObj(m); }
    t.objs = []; t.houseMeshes = []; t.houses = null; t.gndLvl = 0;
    stats.houses -= t.nH || 0; stats.trees -= t.nT || 0; stats.lights -= t.nL || 0; t.nH = t.nT = t.nL = 0;
  }
  let groundVis = true;
  function lodTouch(t, force) {
    const gv = groundVis; if (force || t.gndVis !== gv) { t.gndVis = gv; if (t.gndMesh) t.gndMesh.visible = gv; }
    const tn = t.dist < TREE_R;
    if (force || t.treeNear !== tn) { t.treeNear = tn; for (const o of t.objs) if (o.userData.treeKind) o.geometry = (tn ? TREEG : TREEG_LO)[o.userData.treeKind]; }
    const pv = t.dist < POLE_R; if (force || t.poleVis !== pv) { t.poleVis = pv; for (const o of t.objs) if (o.userData.pole) o.visible = pv; }
    const nv = U.uNight.value > 0.02; if (force || t.glowVis !== nv) { t.glowVis = nv; for (const o of t.objs) if (o.userData.glow) o.visible = nv; }
    const lv = nv && t.dist < POOL_R && gv; if (force || t.poolVis !== lv) { t.poolVis = lv; for (const o of t.objs) if (o.userData.pool) o.visible = lv; }
  }
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _c = new THREE.Color();
  const HOUSE_ATTRS = ['position', 'normal', 'aPart', 'aWinId', 'color'];
  function buildHouses(t, near) {
    for (const m of t.houseMeshes || []) { t.root.remove(m); disposeObj(m); }
    t.houseMeshes = [];
    if (!t.houses || !t.houses.length) return;
    const groups = {};
    for (const h of t.houses) { const gv = near ? h.v : h.far; (groups[gv] = groups[gv] || []).push(h); }
    for (const gv in groups) {
      const list = groups[gv], base = HV[gv], cnt = list.length;
      const g = new THREE.BufferGeometry();
      for (const a of HOUSE_ATTRS) g.setAttribute(a, base.geo.attributes[a]);
      g.userData.sharedAttrs = HOUSE_ATTRS;
      const iw = new Float32Array(cnt * 3), ir = new Float32Array(cnt * 3), is = new Float32Array(cnt * 2);
      const mesh = new THREE.InstancedMesh(g, houseMat, cnt);
      list.forEach((o, i) => {
        _q.setFromAxisAngle(_up, o.yaw); _m.compose(_p.set(o.x, o.y, o.z), _q, _s.set(o.W / base.W, o.H / base.H, o.D / base.D)); mesh.setMatrixAt(i, _m);
        const jit = 0.93 + o.seed * 0.12;
        iw[i * 3] = o.wall.r * jit; iw[i * 3 + 1] = o.wall.g * jit; iw[i * 3 + 2] = o.wall.b * jit; ir[i * 3] = o.roof.r; ir[i * 3 + 1] = o.roof.g; ir[i * 3 + 2] = o.roof.b;
        is[i * 2] = o.seed; is[i * 2 + 1] = o.lit;
      });
      g.setAttribute('iWall', new THREE.InstancedBufferAttribute(iw, 3)); g.setAttribute('iRoof', new THREE.InstancedBufferAttribute(ir, 3)); g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(is, 2));
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere(); mesh.name = 'houses-' + gv;
      t.root.add(mesh); t.houseMeshes.push(mesh);
    }
  }
  function disposeObj(o) {
    if (o.isInstancedMesh) o.dispose();
    const g = o.geometry; if (!g || g.userData.shared) return;
    if (g.userData.sharedAttrs) for (const a of g.userData.sharedAttrs) g.deleteAttribute(a);
    g.dispose();
  }

  // skyline-only tiles: tall buildings far away (their own tiny files)
  function* buildSky(s) {
    const T = s.data; const tb = new TB(BSPEC); const hf = (x, z) => ctx.groundY(T.ox + x, T.oz + z);
    for (let i = 0; i < T.b.length; i++) { buildingInto(tb, T.b[i], T, hf, i, false, false); if ((i & 7) === 7 && now() > deadline) yield; }
    const g = tb.build();
    if (g) { const m = new THREE.Mesh(g, skyMat); m.castShadow = false; m.receiveShadow = false; m.name = 'skyline'; s.root.add(m); s.mesh = m; }
    s.built = true;
  }

  // ------------------------------------------------------------------ streaming
  const pathOf = (tx, ty, sky) => DIR + '7/' + tx + '_' + ty + (sky ? '.sky.bin' : '.bin');
  function newTile(e, sky) {
    const [ox, oz] = tileOrigin(e.tx, e.ty);
    const t = { key: K(e.tx, e.ty), tx: e.tx, ty: e.ty, ox, oz, e, sky, path: pathOf(e.tx, e.ty, sky), root: new THREE.Group(), state: 'new', data: null, raw: null,
      hf: null, inter: null, dist: 0, bldLvl: 0, gndLvl: 0, wantB: 0, wantG: 0, gen: null, genKind: '', objs: [], houseMeshes: [], built: false };
    t.root.position.set(ox, 0, oz); t.root.name = (sky ? 'sky ' : 'tile ') + t.key; group.add(t.root);
    return t;
  }
  function startFetch(t) {
    t.state = 'fetch'; stats.fetching++;
    getBin(t.path, 1 + Math.round(t.dist / 400)).then(u8 => { stats.fetching--; if (t.state !== 'fetch') return; t.raw = u8; t.state = 'decode'; },
      err => { stats.fetching--; if (t.state === 'fetch') t.state = (err && err.name === 'AbortError') ? 'new' : 'empty'; });
  }
  function ensureGround(t) {
    const ok = () => { if (t.state === 'ground') t.state = 'ready'; };
    if (!t.sky && hasTerrain() && typeof Terrain.ensure === 'function') {
      t.state = 'ground';
      try { Promise.resolve(Terrain.ensure(t.ox - 15, t.oz - 15, t.ox + TILE + 15, t.oz + TILE + 15)).then(ok, ok); setTimeout(ok, 9000); } catch (e) { t.state = 'ready'; }
    } else t.state = 'ready';
  }
  function unload(t, map) {
    if (t.state === 'fetch') cancel(t.path);
    t.state = 'dead'; t.gen = null;
    if (!t.sky) { clearBld(t); clearGnd(t); dropImagery(t); if (t.mat) t.mat.dispose(); }
    else if (t.mesh) { t.mesh.geometry.dispose(); t.mesh = null; }
    group.remove(t.root); map.delete(t.key);
  }
  const tileDist = (t, p) => { const dx = Math.max(0, Math.abs(p.x - (t.ox + TILE / 2)) - TILE / 2), dz = Math.max(0, Math.abs(p.z - (t.oz + TILE / 2)) - TILE / 2); return Math.hypot(dx, dz); };
  const _jobs = [];
  let scanX = 1e9, scanZ = 1e9, scanR = 0, imgClock = 0;
  function update(camPos, env) {
    if (!ready) return;
    const t0 = now(); const budget = (env && env.budgetMs) || BUDGET_MS; deadline = t0 + budget;
    const alt = Math.max(0, camPos.y - ctx.groundY(camPos.x, camPos.z));
    const bldR = BLD_R + Math.min(alt * 0.8, 1500), hiR = HI_R + Math.min(alt * 0.3, 400), roadR = ROAD_R + Math.min(alt * 0.5, 600), skyR = SKY_R + Math.min(alt * 2, 6000);
    stats.detailR = bldR; stats.roadR = roadR;
    groundVis = alt < GROUND_ALT;
    // discover tiles when the camera has moved or the view radius grew
    if (Math.abs(camPos.x - scanX) + Math.abs(camPos.z - scanZ) > 60 || bldR > scanR + 50) {
      scanX = camPos.x; scanZ = camPos.z; scanR = bldR;
      const cx0 = Math.floor((camPos.x - X0) / TILE), cz0 = Math.floor((camPos.z - Z0) / TILE), R = Math.ceil(skyR / TILE) + 1;
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const e = index.get(K(cx0 + dx, cz0 + dz)); if (!e) continue;
        const [ox, oz] = tileOrigin(e.tx, e.ty);
        const d = Math.hypot(Math.max(0, Math.abs(camPos.x - (ox + TILE / 2)) - TILE / 2), Math.max(0, Math.abs(camPos.z - (oz + TILE / 2)) - TILE / 2));
        if (d <= bldR + 200 && !tiles.has(e.key)) tiles.set(e.key, newTile(e, false));
        if (e.sky && d <= skyR && !skyTiles.has(e.key)) skyTiles.set(e.key, newTile(e, true));
      }
      stats.tiles = tiles.size; stats.sky = skyTiles.size;
    }
    // full tiles: state machine, wanted levels (hysteresis on the way down), unloading
    // shadows: only tiles that can overlap the sun's shadow box cast or receive (the box follows the camera; see Env)
    const shR = ((typeof Env !== 'undefined' && Env.state && Env.state.shadowSize) || SHADOW_R / 2.2) * 2.2 + 150;
    _jobs.length = 0;
    for (const t of [...tiles.values()]) {
      const d = t.dist = tileDist(t, camPos);
      if (d > bldR + 900) { unload(t, tiles); continue; }
      if (t.state === 'new') startFetch(t);
      if (t.state === 'decode' && now() < deadline) {
        try { t.data = decode(t.tx, t.ty, t.raw); remember(t.key, t.data); stats.roadGen++; } catch (e) { console.warn('[towns]', t.key, e); t.state = 'empty'; continue; }
        t.raw = null; ensureGround(t);
      }
      if (t.state !== 'ready') continue;
      let wb = d < hiR ? 2 : d < bldR ? 1 : 0, wg = d < hiR ? 2 : d < roadR ? 1 : 0;
      if (t.bldLvl > wb) { if (t.bldLvl === 2 && d < hiR + 400) wb = 2; else if (t.bldLvl >= 1 && d < bldR + 600) wb = Math.max(wb, 1); }
      if (t.gndLvl > wg) { if (t.gndLvl === 2 && d < hiR + 400) wg = 2; else if (t.gndLvl >= 1 && d < roadR + 500) wg = Math.max(wg, 1); }
      t.wantB = wb; t.wantG = wg;
      if (!t.gen) {
        if (wb === 0 && t.bldLvl) clearBld(t);
        if (wg === 0 && t.gndLvl) clearGnd(t);
      }
      if (t.gndLvl) lodTouch(t, false);
      if (t.bldMesh) { const cs = d < shR; if (t.bldMesh.castShadow !== cs) { t.bldMesh.castShadow = cs; t.bldMesh.receiveShadow = cs; for (const m of t.houseMeshes) { m.castShadow = cs; m.receiveShadow = cs; } } }
      if (t.gndMesh) { const rs = d < shR; if (t.gndMesh.receiveShadow !== rs) t.gndMesh.receiveShadow = rs; }
      if (t.gen || wb !== t.bldLvl || wg !== t.gndLvl) _jobs.push(t);
    }
    // skyline tiles: shown only where the full tile has no buildings yet
    for (const s of [...skyTiles.values()]) {
      const d = s.dist = tileDist(s, camPos);
      if (d > skyR + 1500) { unload(s, skyTiles); continue; }
      if (s.state === 'new') startFetch(s);
      if (s.state === 'decode' && now() < deadline) { try { s.data = decode(s.tx, s.ty, s.raw); } catch (e) { s.state = 'empty'; continue; } s.raw = null; s.state = 'ready'; }
      const full = tiles.get(s.key); s.root.visible = !(full && full.bldMesh);
      if (s.state === 'ready' && !s.built && !s.gen && s.root.visible) _jobs.push(s);
    }
    stats.queue = _jobs.length;
    // photo-roof upgrades (the terrain streams finer imagery over time): a few tiles per frame
    imgClock += 1;
    if (hasImagery() && (imgClock & 7) === 0) for (const t of tiles.values()) if (t.bldMesh && t.dist < bldR) refreshImagery(t);
    if (!_jobs.length) { stats.lastBuildMs = now() - t0; return; }
    _jobs.sort((a, b) => (a.sky - b.sky) || (a.dist - b.dist));
    for (const t of _jobs) {
      if (now() > deadline) break;
      if (!t.gen) {
        if (t.sky) { t.gen = buildSky(t); t.genKind = 's'; }
        else if (t.wantB !== t.bldLvl && t.wantB > 0) { t.gen = buildBld(t, t.wantB); t.genKind = 'b'; }
        else if (t.wantG !== t.gndLvl && t.wantG > 0) { t.gen = buildGnd(t, t.wantG); t.genKind = 'g'; }
        else continue;
      }
      if (t.genKind === 'g') occ = t.occ || occ;
      while (now() <= deadline) { const r = t.gen.next(); if (r.done) { t.gen = null; break; } }
    }
    stats.lastBuildMs = now() - t0;
  }
  function idle() { return ready && stats.queue === 0 && stats.fetching === 0 && ![...tiles.values()].some(t => t.state === 'fetch' || t.state === 'decode' || t.state === 'ground'); }

  // ------------------------------------------------------------------ queries
  const _speed = [29, 13, 22, 13, 18, 11, 16, 11, 13, 10, 11, 11, 7, 6, 3];   // m/s (~65 mph freeway .. 7 mph plaza)
  function requestDecode(tx, ty) {        // background fetch of a tile's data for roadsNear / buildingsAt callers
    const k = K(tx, ty); if (decoded.has(k) || pendingDecode.has(k) || !index.has(k)) return;
    const p = getBin(pathOf(tx, ty, false), 30).then(u8 => { remember(k, decode(tx, ty, u8)); stats.roadGen++; }).catch(() => {}).finally(() => pendingDecode.delete(k));
    pendingDecode.set(k, p);
  }
  function forTilesIn(x, z, r, fn) {
    const t0x = Math.floor((x - r - X0) / TILE), t1x = Math.floor((x + r - X0) / TILE), t0z = Math.floor((z - r - Z0) / TILE), t1z = Math.floor((z + r - Z0) / TILE);
    for (let ty = t0z; ty <= t1z; ty++) for (let tx = t0x; tx <= t1x; tx++) {
      const k = K(tx, ty); const T = decoded.get(k);
      if (T) fn(T); else requestDecode(tx, ty);
    }
  }
  function roadsNear(x, z, r) {
    const out = [];
    if (!ready) return out;
    forTilesIn(x, z, r, T => {
      for (const rd of T.r) {
        if (rd.cls > 12) continue;
        const P = rd.pts, n = P.length / 2; let hit = false;
        for (let i = 0; i < n; i++) if (Math.abs(T.ox + P[i * 2] - x) < r && Math.abs(T.oz + P[i * 2 + 1] - z) < r) { hit = true; break; }
        if (!hit) continue;
        const a = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { const wx = T.ox + P[i * 2], wz = T.oz + P[i * 2 + 1]; a[i * 3] = wx; a[i * 3 + 1] = ctx.groundY(wx, wz) + LIFT[Math.min(rd.cls, 14)] + (rd.off ? rd.off[i] : 0); a[i * 3 + 2] = wz; }
        out.push({ pts: a, cls: rd.cls, lanes: rd.lanes, oneway: !!(rd.flags & 1), speed: _speed[rd.cls], width: rd.width, urban: !!(rd.flags & 8), bridge: !!(rd.flags & 2) });
      }
    });
    return out;
  }
  const KINDS = ['house', 'residential', 'commercial', 'industrial', 'civic', 'garage', 'station', 'parking', 'building'];
  function buildingsAt(x, z, r = 60) {
    const out = [];
    if (!ready) return out;
    forTilesIn(x, z, r, T => {
      for (const b of T.b) {
        const P = b.pts; let cx = 0, cz = 0; const n = P.length / 2;
        for (let i = 0; i < n; i++) { cx += P[i * 2]; cz += P[i * 2 + 1]; } cx = T.ox + cx / n; cz = T.oz + cz / n;
        if (Math.abs(cx - x) > r || Math.abs(cz - z) > r) continue;
        const pts = new Float32Array(P.length); for (let i = 0; i < n; i++) { pts[i * 2] = T.ox + P[i * 2]; pts[i * 2 + 1] = T.oz + P[i * 2 + 1]; }
        out.push({ x: cx, z: cz, height: b.h, minHeight: b.mh, kind: KINDS[b.kind] || 'building', pts });
      }
    });
    return out;
  }
  function dispose() { for (const t of [...tiles.values()]) unload(t, tiles); for (const s of [...skyTiles.values()]) unload(s, skyTiles); decoded.clear(); scanX = 1e9; }

  async function init(c) {
    ctx = Object.assign({ groundY: () => 0, trackDist: () => 1e9, ll2w: Geo.ll2w, stationList: [] }, c || {});
    stationW = (ctx.stationList || []).map(s => s.x !== undefined ? s : ctx.ll2w(s.lat, s.lon));
    const idx = await getJson(DIR + 'index.json', 0);
    if (!idx || idx.version !== 3) throw new Error('towns: unexpected index version');
    for (const [tx, ty, bytes, nb, sky] of idx.tiles) index.set(K(tx, ty), { key: K(tx, ty), tx, ty, bytes, nb, sky });
    facadeTex = makeFacadeArray(); skyMat = makeBldMat(skyU);
    buildVariants();
    for (const k of ['broad', 'conifer', 'palm', 'euc']) { TREEG[k] = treeGeo(k, false); TREEG_LO[k] = treeGeo(k, true); TREEG[k].userData.shared = TREEG_LO[k].userData.shared = true; }
    buildLightGeo(); lightGeo.userData.shared = glowGeo.userData.shared = poolGeo.userData.shared = true;
    ready = true; stats.index = index.size;
    if (typeof window !== 'undefined') window.__towns = { stats, tiles, skyTiles, index, idle };   // debug / screenshot tooling
    return { tiles: index.size };
  }
  return { init, update, group, roadsNear, buildingsAt, stats, idle, dispose, regionOf,
    get ready() { return ready; }, materials: { roadMat, houseMat, treeMat, glowMat, poleMat, poolMat, get skyMat() { return skyMat; } } };
})();
