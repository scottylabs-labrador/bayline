// Towns: the real street grid, downtown buildings and neighborhoods along the corridor, streamed in
// 1 km tiles around the camera from data/baked/towns.bin (OpenStreetMap, ODbL — see notes/towns.md).
//
//   Towns.init(ctx) -> Promise      ctx = { ll2w, groundY(x,z), trackDist(x,z), stationList, keepOut?(x,z), isWater?(x,z) }
//   Towns.update(camPos, env)        call every frame; builds/unloads tiles within a time budget (env.budgetMs, default 4)
//   Towns.group                      add to the scene
//   Towns.roadsNear(x, z, r)         [{ pts: Float32Array xyz (world), cls, lanes, oneway, speed, width, urban, bridge }]
//   Towns.buildingsAt(x, z, r)       OSM footprints near a point: [{ x, z, height, minHeight, kind, pts }]
//   Towns.stats                      counters for the HUD / debugging (stats.detailR -> Terrain.setTownFade)
//   Towns.idle()                     true when nothing is left to stream in
const Towns = (() => {
  const TILE = 1000;
  const ROAD_R = 3400;        // roads, parks, parking
  const BLD_R = 2600;         // buildings, houses, trees, lights
  const HI_R = 1300;          // 'hi' tiles inside this: sidewalks, curbs, crosswalks, parapets, detailed house models
  const TREE_R = 300;         // full-poly trees inside this, low-poly beyond
  const POLE_R = 850;         // streetlight poles inside this (the night glow shows at any distance)
  const POOL_R = 1500;        // pools of lamp light on the pavement inside this (night only)
  const BUDGET_MS = 4;        // per-frame build budget
  const group = new THREE.Group(); group.name = 'towns';
  const stats = { tiles: 0, built: 0, buildings: 0, houses: 0, trees: 0, lights: 0, groundTris: 0, queue: 0, lastBuildMs: 0, detailR: BLD_R, roadR: ROAD_R };
  let ctx = null, dv = null, ready = false, stationW = [];
  const index = new Map();          // "tx,tz" -> { tx, tz, off, len }
  const tiles = new Map();          // "tx,tz" -> tile
  const decoded = new Map();        // LRU cache of decoded tile data (for roadsNear)
  let deadline = 0;
  const now = () => performance.now();
  const K = (tx, tz) => tx + ',' + tz;

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
    sfWall: ['#e9dcc0', '#d8c59f', '#c7d5de', '#e7e0cf', '#b9c9ad', '#e9c7a2', '#d4b9c8', '#f1eadb', '#a8bcc9', '#e6d39b', '#c9d9c3', '#f0d8c8'].map(C),
    penWall: ['#e8dcc4', '#efe6d2', '#d9c7a6', '#e3d3b8', '#cdbd9d', '#f3efe6', '#d9cdb8', '#c9b89b', '#e6dfd0', '#c0af90', '#dcd2bf', '#ebe2cf'].map(C),
    eichWall: ['#8a6b4a', '#6f7b75', '#5e6e73', '#9a8f7d', '#7d5f45', '#8f8a7a', '#6b5a48', '#4f5f63'].map(C),
    southWall: ['#e7d9bd', '#d8c3a0', '#efe4cd', '#cbb48e', '#e0d2b5', '#f0ebe0'].map(C),
    roofComp: ['#5b5650', '#6b645a', '#4f4c48', '#76695a', '#5f5f5f', '#6d6660', '#48453f'].map(C),
    roofTile: ['#b5654a', '#a35a42', '#c07556', '#9e5238', '#b86e4f'].map(C),
    roofFlat: ['#a6a298', '#8e8a80', '#c9c7c0', '#7f7b73', '#b8b3a8', '#dcdad3', '#6f6c66'].map(C),
    eichRoof: ['#bdb6a6', '#b1ab9c', '#c6c0b1'].map(C),
    comm: ['#e6ddcb', '#d4c7ae', '#efe3c8', '#c9b393', '#e9e6df', '#b9a58a', '#d8c9a9', '#c4876a', '#a8ad9c', '#dcd3c4', '#b56f55', '#cfc3ae'].map(C),
    sfComm: ['#a8563f', '#b87b5c', '#c9c1b1', '#8f8f8f', '#d7cfbf', '#9b6a52', '#c2b8a3', '#7d7f82', '#e3dccd', '#6f7a80'].map(C),
    glass: ['#5f7a8e', '#6c8799', '#4f6a7d', '#7b93a3', '#56707f'].map(C),
    indus: ['#c2c0b8', '#b0aca0', '#d0ccc0', '#9fa3a6', '#bdb4a3'].map(C),
    civic: ['#e8e0cc', '#d6c8a8', '#b99e7e', '#9c5a44', '#e4d9c1'].map(C),
    door: ['#f2efe8', '#6b4a33', '#2f4a3a', '#7a2e2a', '#34495e', '#d9d2c4', '#8a8f94'].map(C),
    sign: ['#b8352c', '#2f6db3', '#e0a52a', '#2e8a57', '#6b3fa0', '#d9d9d9', '#1f1f1f'].map(C),
  };
  const pick = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];

  // ------------------------------------------------------------------ materials
  const glsl_hash = `
    float tHash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
    float tHash3(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }`;

  // Roads, sidewalks, parks, lawns, parking, crosswalks: one material, markings drawn in the shader.
  const roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0.0 });
  roadMat.onBeforeCompile = sh => {
    sh.uniforms.uNight = U.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aMark; attribute vec2 aRoadUv; varying vec4 vMark; varying vec2 vRoadUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMark = aMark; vRoadUv = aRoadUv;');
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
            base *= 0.90 + 0.12 * n1 + 0.07 * n2;
            float hw = W * 0.5;
            if (t > 1.5) {
              float edge = abs(abs(q.y) - (hw - 0.45));
              line = max(line, 1.0 - smoothstep(0.07, 0.07 + aa, edge));
            }
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
            base = mix(base, lc, line * fade * (0.85 + 0.15 * n1));
            // tire tracks / oil in lane centers
            base *= 1.0 - 0.05 * smoothstep(0.35, 0.0, abs(fract(q.y / 1.8) - 0.5));
          } else if (t == 7.0) {                           // crosswalk (continental stripes along the traffic)
            float s = step(0.45, fract(q.y / 1.2));
            base = mix(base, vec3(0.88, 0.88, 0.85), s * (0.8 + 0.2 * n1));
          } else if (t == 8.0) {                           // parking lot with stall lines
            base *= 0.92 + 0.1 * n1;
            float st = 1.0 - smoothstep(0.05, 0.05 + aax * 1.5, abs(fract(q.x / 2.75) - 0.5) * 2.75);
            float row = step(abs(fract(q.y / 12.0) - 0.5) * 12.0, 2.6);
            float far = smoothstep(0.08, 0.5, aax);                   // fade the stall lines out before they alias
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

  // Buildings from OSM footprints: vertex colors + procedural windows (lit at night).
  const bldMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
  bldMat.onBeforeCompile = sh => {
    sh.uniforms.uNight = U.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aWin; attribute vec2 aWallUv; varying vec4 vWin; varying vec2 vWallUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWin = aWin; vWallUv = aWallUv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vWin; varying vec2 vWallUv; uniform float uNight; float gWinGlass = 0.0; vec3 gWinEmit = vec3(0.0);' + glsl_hash)
      .replace('#include <color_fragment>', `#include <color_fragment>
      if (vWin.w > 0.5) {
        float style = floor(vWin.y + 0.5), fh = vWin.x, seed = vWin.z, eave = vWin.w;
        vec2 q = vWallUv;                                    // x: meters along facade, y: meters above grade
        vec3 wall = diffuseColor.rgb;
        wall *= 0.74 + 0.26 * smoothstep(0.0, 2.8, q.y);      // grime / occlusion at the base
        wall *= 1.0 + 0.10 * step(eave - 0.05, q.y);          // parapet coping
        float colW = style == 3.0 ? 1.6 : style == 2.0 ? 2.4 : style == 5.0 ? 6.0 : 3.2;
        float col = floor(q.x / colW), fl = floor(q.y / fh);
        vec2 f = vec2(fract(q.x / colW), fract(q.y / fh));
        vec4 R = vec4(0.30, 0.70, 0.30, 0.86);               // window rectangle in cell space (x0, x1, y0, y1)
        if (style == 6.0) R = vec4(0.27, 0.73, 0.2, 0.88);
        else if (style == 2.0) R = vec4(0.0, 1.0, 0.36, 0.86);
        else if (style == 3.0) R = vec4(0.05, 0.95, 0.07, 0.97);
        else if (style == 4.0) R = fl < 0.5 ? vec4(0.05, 0.95, 0.05, 0.78) : vec4(0.28, 0.72, 0.30, 0.86);
        else if (style == 5.0) R = vec4(0.1, 0.9, 0.70, 0.90);
        float fx = 0.08 / colW, fy = 0.08 / fh;
        float inWin = step(R.x, f.x) * step(f.x, R.y) * step(R.z, f.y) * step(f.y, R.w);
        float inFrame = step(R.x - fx, f.x) * step(f.x, R.y + fx) * step(R.z - fy * 2.2, f.y) * step(f.y, R.w + fy);
        float ok = step(0.9, q.y) * step(q.y, eave - 0.35) * step(0.5, style);   // no windows at the foundation / parapet
        if (style == 4.0 && fl < 0.5) wall = mix(wall, vec3(0.12, 0.12, 0.13), step(0.80, f.y) * step(f.y, 0.97) * 0.85);  // sign band
        vec3 frameC = (style == 1.0 || style == 6.0) ? mix(wall, vec3(0.93, 0.92, 0.88), 0.7) : vec3(0.2, 0.21, 0.22);
        diffuseColor.rgb = mix(wall, frameC, inFrame * ok * (1.0 - inWin));
        if (inWin * ok > 0.5) {
          float h = tHash3(vec3(col, fl, seed));
          vec3 glass = vec3(0.13, 0.17, 0.22) + vec3(0.05, 0.07, 0.09) * h + vec3(0.06, 0.07, 0.08) * (f.y - R.z) / (R.w - R.z);
          if (style == 1.0 || style == 6.0) glass = mix(glass, vec3(0.55, 0.52, 0.47), step(0.72, h) * step(0.62, (f.y - R.z) / (R.w - R.z)));  // blinds
          diffuseColor.rgb = glass;
          gWinGlass = 1.0;
          float litP = style == 5.0 ? 0.12 : style == 3.0 ? 0.34 : (style == 2.0 || style == 4.0) ? 0.3 : 0.46;
          if (style == 4.0 && fl < 0.5) litP = 0.8;                       // shop windows stay lit
          float lit = step(h, litP) * uNight;
          float cool = step(0.8, tHash3(vec3(seed, col * 1.7, fl))) * step(1.5, style) * step(style, 3.5);
          vec3 warm = mix(vec3(1.0, 0.7, 0.38), vec3(0.78, 0.86, 1.0), cool);
          gWinEmit = warm * lit * (0.45 + 0.55 * tHash3(vec3(fl, seed, col)));
        }
      }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.18, gWinGlass);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.35, gWinGlass);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gWinEmit * 1.25;');
  };

  // Procedural houses: instanced; per-vertex part id picks wall/roof/trim/glass/door colors per instance.
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

  // Trees: vertex colors, instance tint, gentle wind sway.
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
  // Pools of lamp light on the pavement: flat instanced quads, additive, fade in with U.uNight.
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
  // Night glow sprites (streetlight heads): camera-facing, additive, fade in with U.uNight.
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { uNight: U.uNight },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uNight; varying vec2 vUv; varying float vA;
      void main(){ vUv = uv; vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float dist = length(c.xyz); float s = 2.4 + dist * 0.004;          // stays visible as a point of light far away
        c.xyz += normalize(-c.xyz) * 0.6;                                  // pull toward the camera so the lamp head doesn't clip it
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

  // ------------------------------------------------------------------ geometry builders
  class GB {                                   // growable geometry builder (non-indexed triangles)
    constructor(extra) { this.p = []; this.n = []; this.c = []; this.ex = {}; for (const [k, s] of extra) this.ex[k] = { s, a: [] }; }
    vert(x, y, z, nx, ny, nz, r, g, b, ex) {
      this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(r, g, b);
      for (const k in this.ex) { const e = this.ex[k], v = ex[k]; for (let i = 0; i < e.s; i++) e.a.push(v[i]); }
    }
    get count() { return this.p.length / 3; }
    build() {
      if (!this.p.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      for (const k in this.ex) g.setAttribute(k, new THREE.Float32BufferAttribute(this.ex[k].a, this.ex[k].s));
      g.computeBoundingSphere(); g.computeBoundingBox();
      return g;
    }
  }
  const _ab = new THREE.Vector3(), _ac = new THREE.Vector3(), _fn = new THREE.Vector3();
  // triangle with automatic normal (winding decides facing)
  function tri(gb, a, b, c, col, ex) {
    _ab.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]); _ac.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]); _fn.crossVectors(_ab, _ac).normalize();
    gb.vert(a[0], a[1], a[2], _fn.x, _fn.y, _fn.z, col.r, col.g, col.b, ex[0] || ex);
    gb.vert(b[0], b[1], b[2], _fn.x, _fn.y, _fn.z, col.r, col.g, col.b, ex[1] || ex);
    gb.vert(c[0], c[1], c[2], _fn.x, _fn.y, _fn.z, col.r, col.g, col.b, ex[2] || ex);
  }

  // ------------------------------------------------------------------ tile decoding
  function decode(tx, tz) {
    const k = K(tx, tz);
    if (decoded.has(k)) { const d = decoded.get(k); decoded.delete(k); decoded.set(k, d); return d; }
    const ent = index.get(k); if (!ent) return null;
    let o = ent.off;
    const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
    const u8 = () => dv.getUint8(o++);
    const nB = u16(), nR = u16(), nA = u16(), nT = u16(), nI = u16(); u16();
    const pts = n => { const a = new Float32Array(n * 2); let x = 0, z = 0;
      for (let i = 0; i < n; i++) { const dx = dv.getInt16(o, true), dz = dv.getInt16(o + 2, true); o += 4;
        if (i === 0) { x = dx; z = dz; } else { x += dx; z += dz; } a[i * 2] = x * 0.1; a[i * 2 + 1] = z * 0.1; }
      return a; };
    const b = [], r = [], a = [], t = [], it = [];
    for (let i = 0; i < nB; i++) { const kind = u8(), roof = u8(), h = u16() / 4, mh = u16() / 4, wall = u16(), roofc = u16(), n = u16(); b.push({ kind, roof, h, mh, wall, roofc, pts: pts(n) }); }
    for (let i = 0; i < nR; i++) { const cls = u8(), flags = u8(), lanes = u8(), width = u8() / 4, n = u16(); const p = pts(n);
      let off = null; if (flags & 2) { off = new Float32Array(n); for (let j = 0; j < n; j++) off[j] = u8() / 4; }
      r.push({ cls, flags, lanes, width, pts: p, off }); }
    for (let i = 0; i < nA; i++) { const kind = u8(); u8(); const n = u16(); a.push({ kind, pts: pts(n) }); }
    for (let i = 0; i < nT; i++) { const x = dv.getInt16(o, true) * 0.1, z = dv.getInt16(o + 2, true) * 0.1; o += 4; t.push({ x, z, kind: u8(), size: u8() }); }
    for (let i = 0; i < nI; i++) { const x = dv.getInt16(o, true) * 0.1, z = dv.getInt16(o + 2, true) * 0.1; o += 4; const n = u8(), flags = u8();
      const ap = []; for (let j = 0; j < n; j++) ap.push({ ang: u8() / 256 * Math.PI * 2, hw: u8() / 4 }); it.push({ x, z, flags, ap }); }
    const d = { tx, tz, ox: tx * TILE, oz: tz * TILE, b, r, a, t, it };
    decoded.set(k, d); if (decoded.size > 90) decoded.delete(decoded.keys().next().value);
    return d;
  }

  // per-tile ground-height cache (20 m grid, bilinear) so thousands of vertices don't hit ctx.groundY
  function heightField(ox, oz) {
    const N = 53, S = 20, a = new Float32Array(N * N);   // covers -20 .. 1020 m
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) a[j * N + i] = ctx.groundY(ox - 20 + i * S, oz - 20 + j * S);
    return (x, z) => {
      let fx = (x + 20) / S, fz = (z + 20) / S; fx = fx < 0 ? 0 : fx > N - 1.001 ? N - 1.001 : fx; fz = fz < 0 ? 0 : fz > N - 1.001 ? N - 1.001 : fz;
      const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, p = j * N + i;
      return (a[p] * (1 - u) + a[p + 1] * u) * (1 - v) + (a[p + N] * (1 - u) + a[p + N + 1] * u) * v;
    };
  }

  // ------------------------------------------------------------------ roads
  const COL = { asphalt: C('#3a3b3d'), asphaltOld: C('#46464a'), fwy: C('#4a4b4e'), curb: C('#bdbab2'), walk: C('#b7b2a7'),
    walkWarm: C('#c4b9a6'), grass: C('#5d7338'), grassDry: C('#8a8a4a'), gravel: C('#7c7466'), barrier: C('#b9b5ab'),
    deck: C('#a9a59c'), park: C('#5f7a3a'), pitch: C('#4f8a3a'), play: C('#b58f63'), parking: C('#4b4c4f'), plaza: C('#c9c0ad'),
    cemetery: C('#6c8446'), allot: C('#6f7a3e'), lawn: C('#6a8a3e'), lawnDry: C('#9a9658'), drive: C('#b6b1a8'), hvac: C('#9fa2a3') };
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
  function roadRibbon(gb, r, T, hf, inter, hi) {
    const P = r.pts, n0 = P.length / 2; if (n0 < 2) return;
    const region = regionOf(T.oz + P[1]);
    const bridge = !!(r.flags & 2), urban = !!(r.flags & 8), core = !!(r.flags & 4), c = r.cls;
    const hw = r.width / 2, mt = markType(r);
    const walks = hi && urban && !bridge && c >= 4 && c <= 12 && c !== 5 && c !== 7 && c !== 9;
    const strip = walks && !core && region >= 1 && c >= 8 ? 1.5 : 0;
    const sw = walks ? (core ? (c <= 8 ? 3.8 : 3.0) : c <= 7 ? 3.0 : 1.9) : 0;
    const shoulder = !walks && !bridge && hi ? (c <= 3 ? 1.6 : 1.0) : 0;
    // distances of the original vertices; intersections on this piece
    const u0 = new Float32Array(n0); for (let i = 1; i < n0; i++) u0[i] = u0[i - 1] + Math.hypot(P[i * 2] - P[i * 2 - 2], P[i * 2 + 1] - P[i * 2 - 1]);
    const total = u0[n0 - 1]; if (total < 0.5) return;
    const ints = [];
    for (let i = 0; i < n0; i++) { const it = inter.get(Math.round(P[i * 2] * 10) + ':' + Math.round(P[i * 2 + 1] * 10)); if (it) ints.push({ u: u0[i], R: it.R, flags: it.flags }); }
    const cw = hi && c >= 4 && c <= 12 && urban && !bridge;     // crosswalks on this road's approaches
    const brk = [];
    const seg = hi ? 16 : 40;
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
    // normals (left = +90deg in the XZ plane) with limited miter
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
    // bands: [off0, off1, dy0, dy1, color, markType, vertical, kind]  kind: 0 road, 1 sidewalk-ish (trimmed at cross streets), 2 crosswalk
    const bands = [];
    const asphalt = c <= 3 ? COL.fwy : (region === 0 || region === 4 || core) ? COL.asphalt : COL.asphaltOld;
    bands.push([-hw, hw, 0, 0, asphalt, mt, 0, 0]);
    if (cw && ints.length) bands.push([-hw + 0.4, hw - 0.4, 0.025, 0.025, asphalt, 7, 0, 2]);
    if (walks) {
      for (const s of [-1, 1]) {
        const e0 = hw * s, e1 = (hw + strip) * s, e2 = (hw + strip + sw) * s;
        bands.push([e0, e0, 0, 0.15, COL.curb, 0, 1, 1]);                    // curb face
        if (strip > 0) { bands.push([e0, e1, 0.15, 0.15, COL.grass, 9, 0, 1]); bands.push([e1, e2, 0.16, 0.16, COL.walk, 11, 0, 1]); }
        else bands.push([e0, e2, 0.15, 0.15, region === 0 || core ? COL.walk : COL.walkWarm, 11, 0, 1]);
        bands.push([e2, e2, 0.16, -0.5, COL.curb, 0, 1, 1]);                 // back edge down into the ground
      }
    } else if (!bridge && hi) {
      for (const s of [-1, 1]) {
        bands.push([hw * s, (hw + shoulder) * s, -0.02, -0.05, COL.gravel, 9, 0, 0]);
        bands.push([(hw + shoulder) * s, (hw + shoulder) * s, -0.05, -0.8, COL.gravel, 0, 1, 0]);
      }
      if ((c === 0 || c === 2) && (r.flags & 1)) {                          // median barrier on the left of a carriageway
        bands.push([-hw - 0.2, -hw - 0.2, 0, 0.85, COL.barrier, 0, 1, 0]); bands.push([-hw - 0.2, -hw - 0.6, 0.85, 0.85, COL.barrier, 0, 0, 0]);
      }
    } else {
      for (const s of [-1, 1]) {                                             // parapets + deck edge
        bands.push([hw * s, hw * s, 0, 0.95, COL.barrier, 0, 1, 0]);
        bands.push([hw * s, (hw + 0.35) * s, 0.95, 0.95, COL.barrier, 0, 0, 0]);
        bands.push([(hw + 0.35) * s, (hw + 0.35) * s, 0.95, -1.4, COL.deck, 0, 1, 0]);
      }
      bands.push([hw + 0.35, -hw - 0.35, -1.4, -1.4, COL.deck, 0, 0, 0]);   // underside
    }
    // ground samples: center and both outer edges; inner columns interpolate
    const outer = hw + strip + sw + shoulder + 0.4;
    const gC = new Float32Array(n), gL = new Float32Array(n), gR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      gC[i] = hf(xs[i], zs[i]);
      gL[i] = hf(xs[i] + nx[i] * outer, zs[i] + nz[i] * outer); gR[i] = hf(xs[i] - nx[i] * outer, zs[i] - nz[i] * outer);
    }
    const Y = (i, off) => {             // off > 0 = left
      if (bridge) return gC[i] + os[i];  // decks are level across
      const g = off >= 0 ? gC[i] + (gL[i] - gC[i]) * Math.min(1, off / outer) : gC[i] + (gR[i] - gC[i]) * Math.min(1, -off / outer);
      return Math.max(g, gC[i] - 0.6) + os[i];
    };
    const e4 = [0, 1, 2, 3].map(() => ({ aMark: [0, 0, 0, 0], aRoadUv: [0, 0] }));
    const setEx = (e, mark, uu, vv, f) => { e.aMark[0] = mark; e.aMark[1] = r.lanes; e.aMark[2] = r.width; e.aMark[3] = f; e.aRoadUv[0] = uu; e.aRoadUv[1] = vv; };
    for (const [o0, o1, dy0, dy1, col, mark, vert, kind] of bands) {
      for (let i = 0; i < n - 1; i++) {
        const j = i + 1, um = (us[i] + us[j]) / 2;
        if (kind === 1 && nearInt(um, 0.3)) continue;                       // sidewalks stop at the cross street's curb line
        if (kind === 2) { const it = nearInt(um, 4.0); if (!it || Math.abs(um - it.u) < it.R + 1.0 || !(it.flags & 8) || ((it.flags & 1) && region !== 0 && !core)) continue; }
        const a0x = xs[i] + nx[i] * o0 * mit[i], a0z = zs[i] + nz[i] * o0 * mit[i], a1x = xs[i] + nx[i] * o1 * mit[i], a1z = zs[i] + nz[i] * o1 * mit[i];
        const b0x = xs[j] + nx[j] * o0 * mit[j], b0z = zs[j] + nz[j] * o0 * mit[j], b1x = xs[j] + nx[j] * o1 * mit[j], b1z = zs[j] + nz[j] * o1 * mit[j];
        const f0 = kind === 2 ? 1 : fade[i], f1 = kind === 2 ? 1 : fade[j];
        setEx(e4[0], mark, us[i], o0, f0); setEx(e4[1], mark, us[i], o1, f0); setEx(e4[2], mark, us[j], o0, f1); setEx(e4[3], mark, us[j], o1, f1);
        if (!vert) {
          const A = [a0x, Y(i, o0) + lift + dy0, a0z], B = [a1x, Y(i, o1) + lift + dy1, a1z], Cc = [b0x, Y(j, o0) + lift + dy0, b0z], D = [b1x, Y(j, o1) + lift + dy1, b1z];
          const cr = (B[0] - A[0]) * (Cc[2] - A[2]) - (B[2] - A[2]) * (Cc[0] - A[0]);
          const down = dy0 < -1 && dy1 < -1;                                // bridge underside faces down
          if ((cr < 0) !== down) { tri(gb, A, B, Cc, col, [e4[0], e4[1], e4[2]]); tri(gb, B, D, Cc, col, [e4[1], e4[3], e4[2]]); }
          else { tri(gb, A, Cc, B, col, [e4[0], e4[2], e4[1]]); tri(gb, B, Cc, D, col, [e4[1], e4[2], e4[3]]); }
        } else {                                                            // vertical face (curb / edge / barrier): two-sided
          const A = [a0x, Y(i, o0) + lift + dy0, a0z], B = [a0x, Y(i, o0) + lift + dy1, a0z], Cc = [b0x, Y(j, o0) + lift + dy0, b0z], D = [b0x, Y(j, o0) + lift + dy1, b0z];
          tri(gb, A, B, Cc, col, [e4[0], e4[1], e4[2]]); tri(gb, B, D, Cc, col, [e4[1], e4[3], e4[2]]);
          tri(gb, A, Cc, B, col, [e4[0], e4[2], e4[1]]); tri(gb, B, Cc, D, col, [e4[1], e4[2], e4[3]]);
        }
      }
    }
    // bridge piers every ~28 m where the deck is high
    if (bridge) {
      let next = 14;
      for (let i = 0; i < n; i++) {
        if (us[i] >= next && os[i] > 2.5) { next = us[i] + 28;
          const top = Y(i, 0) + lift - 1.4, bot = gC[i] - 0.5, w = Math.min(hw * 0.8, 5);
          boxInto(gb, xs[i], (top + bot) / 2, zs[i], 1.2, top - bot, w * 2, Math.atan2(nx[i], nz[i]), COL.deck, e4[0]); }
      }
    }
  }
  function boxInto(gb, x, y, z, sx, sy, sz, rot, col, ex) {      // axis box rotated about Y (for piers, etc.)
    const c = Math.cos(rot), s = Math.sin(rot), hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const P = (dx, dy, dz) => [x + dx * c + dz * s, y + dy, z - dx * s + dz * c];
    const v = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(-hx, hy, -hz), P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)];
    const f = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [3, 7, 6, 2]];
    for (const [a, b, cc, d] of f) { tri(gb, v[a], v[b], v[cc], col, ex); tri(gb, v[a], v[cc], v[d], col, ex); }
  }
  // flat polygons (parks, parking, plazas) draped approximately
  const AREA_STYLE = [[COL.park, 9], [COL.pitch, 10], [COL.play, 9], [COL.parking, 8], [COL.plaza, 11], [COL.cemetery, 10], [COL.allot, 9]];
  function areaPoly(gb, a, T, hf) {
    const P = a.pts, n = P.length / 2; if (n < 3) return;
    const [col, mark] = AREA_STYLE[a.kind] || AREA_STYLE[0];
    const contour = []; let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (let i = 0; i < n; i++) { contour.push(new THREE.Vector2(P[i * 2], P[i * 2 + 1])); minx = Math.min(minx, P[i * 2]); maxx = Math.max(maxx, P[i * 2]); minz = Math.min(minz, P[i * 2 + 1]); maxz = Math.max(maxz, P[i * 2 + 1]); }
    let faces; try { faces = THREE.ShapeUtils.triangulateShape(contour, []); } catch (e) { return; }
    // smaller areas sit a little higher (a playground inside a park, a plaza inside a parking lot); all stay under roads
    const size = Math.max(maxx - minx, maxz - minz), lift = 0.11 + 0.07 * (1 - Math.min(1, size / 400)) + (a.kind === 3 || a.kind === 4 ? 0.02 : 0);
    // stall lines / mowing stripes follow the area's own orientation
    const box = obb(P, n); const ux = box ? box.ux : 1, uz = box ? box.uz : 0;
    const swap = box && box.h1 > box.h0;
    const uvOf = (x, z) => { const s = x * ux + z * uz, t = -x * uz + z * ux; return swap ? [t, s] : [s, t]; };
    const ex = [0, 1, 2].map(() => ({ aMark: [mark, 0, 0, 1], aRoadUv: [0, 0] }));
    const emit = (A, B, Cc, d) => {        // recursive split so large areas drape over the terrain
      const l = Math.max((A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2, (B[0] - Cc[0]) ** 2 + (B[1] - Cc[1]) ** 2, (Cc[0] - A[0]) ** 2 + (Cc[1] - A[1]) ** 2);
      if (l > 26 * 26 && d < 5) {
        const ab = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], bc = [(B[0] + Cc[0]) / 2, (B[1] + Cc[1]) / 2], ca = [(Cc[0] + A[0]) / 2, (Cc[1] + A[1]) / 2];
        emit(A, ab, ca, d + 1); emit(ab, B, bc, d + 1); emit(ca, bc, Cc, d + 1); emit(ab, bc, ca, d + 1); return;
      }
      const V = [A, B, Cc].map(p => [p[0], hf(p[0], p[1]) + lift, p[1]]);
      ex[0].aRoadUv = uvOf(A[0], A[1]); ex[1].aRoadUv = uvOf(B[0], B[1]); ex[2].aRoadUv = uvOf(Cc[0], Cc[1]);
      const cr = (V[1][0] - V[0][0]) * (V[2][2] - V[0][2]) - (V[1][2] - V[0][2]) * (V[2][0] - V[0][0]);
      if (cr < 0) tri(gb, V[0], V[1], V[2], col, [ex[0], ex[1], ex[2]]); else tri(gb, V[0], V[2], V[1], col, [ex[0], ex[2], ex[1]]);
    };
    for (const f of faces) emit([contour[f[0]].x, contour[f[0]].y], [contour[f[1]].x, contour[f[1]].y], [contour[f[2]].x, contour[f[2]].y], 0);
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
  const _bwEx = { aWin: [0, 0, 0, 0], aWallUv: [0, 0] };
  // Skip OSM footprints the rail modules draw themselves: station buildings / platform canopies at the stations,
  // anything straddling the tracks, and whatever the engine marks with ctx.keepOut(x, z).
  function skipBuilding(b, T) {
    const P = b.pts, n = P.length / 2; let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += P[i * 2]; cz += P[i * 2 + 1]; } cx = T.ox + cx / n; cz = T.oz + cz / n;
    const td = ctx.trackDist(cx, cz);
    if (td < 7 || ((b.kind === 5 || b.kind === 6 || b.kind === 7) && td < 22)) return true;
    if (b.kind === 6) for (const s of stationW) if (Math.hypot(s.x - cx, s.z - cz) < 160) return true;
    return !!(ctx.keepOut && ctx.keepOut(cx, cz));
  }
  function buildingInto(gb, b, T, hf, seedBase, ri, hi) {
    const P = b.pts, n = P.length / 2; if (n < 3) return;
    if (skipBuilding(b, T)) return;
    const region = regionOf(T.oz + P[1]);
    let gmin = 1e9, gmax = -1e9;
    for (let i = 0; i < n; i++) { const g = hf(P[i * 2], P[i * 2 + 1]); gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); }
    const base = gmin + 0.02, area = Math.abs(polyArea(P, n)), kind = b.kind;
    const r1 = U.hash2(seedBase, ri), r2 = U.hash2(ri, seedBase + 7), r3 = U.hash2(ri * 3 + 1, seedBase);
    // colors
    let wall, roofC;
    const tall = b.h > 28;
    if (b.wall) wall = rgbFrom565(b.wall);
    else if (kind === 0) wall = pick(region === 0 ? PAL.sfWall : region === 5 ? PAL.southWall : PAL.penWall, r1).clone();
    else if (kind === 1) wall = pick(region === 0 ? PAL.sfWall : PAL.penWall, r1).clone();
    else if (kind === 2) wall = tall ? pick(PAL.glass, r1).clone() : pick(region === 0 ? PAL.sfComm : PAL.comm, r1).clone();
    else if (kind === 3) wall = pick(PAL.indus, r1).clone();
    else if (kind === 4) wall = pick(PAL.civic, r1).clone();
    else wall = pick(PAL.comm, r1).clone();
    const pitched = b.roof >= 1 && b.roof <= 4 && area < 900;
    if (b.roofc) roofC = rgbFrom565(b.roofc);
    else if (pitched) { roofC = (region >= 2 && r2 < 0.35 ? pick(PAL.roofTile, r3) : pick(PAL.roofComp, r3)).clone(); }
    else roofC = pick(PAL.roofFlat, r3).clone();
    // window style
    let style = 0, fh = 3.2;
    if (kind === 0) { style = region === 0 ? 6 : 1; fh = 3.0; }
    else if (kind === 1) { style = region === 0 ? 6 : 1; fh = 3.0; }
    else if (kind === 2) { style = tall ? 3 : (b.h > 12 ? 2 : 4); fh = tall ? 3.9 : 3.8; }
    else if (kind === 3) { style = 5; fh = Math.max(4, b.h); }
    else if (kind === 4) { style = 1; fh = 4.2; }
    else if (kind === 6) { style = 4; fh = 4.5; }
    if (b.h < 3.2 || kind === 5) style = 0;
    // roof geometry parameters
    let eave = b.h, box = null, rh = 0;
    if (pitched) {
      box = obb(P, n);
      if (box && box.ar > 0 && area / (4 * box.h0 * box.h1) > 0.72) {
        const shortHalf = Math.min(box.h0, box.h1);
        rh = Math.min(Math.max(shortHalf * 0.55, 1.2), 4.2);
        eave = Math.max(2.6, b.h - rh);
      } else box = null;
    }
    const yb = b.mh > 0.5 ? base + b.mh : base - 1.2, ye = base + eave;
    const seed = (r1 * 997) % 97;
    const parapet = hi && !box && (kind >= 1 && kind <= 4 || kind === 6) && area > 120 && b.h > 5 ? (b.h > 30 ? 1.3 : 0.9) : 0;
    // walls
    let peri = 0;
    const ew = { aWin: [fh, style, seed, style ? eave + 0.01 : 0], aWallUv: [0, 0] };
    const e = [0, 1, 2, 3].map(() => ({ aWin: ew.aWin, aWallUv: [0, 0] }));
    const topY = ye + parapet;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = P[i * 2], az = P[i * 2 + 1], bx = P[j * 2], bz = P[j * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
      e[0].aWallUv = [peri, yb - base]; e[1].aWallUv = [peri + L, yb - base]; e[2].aWallUv = [peri + L, topY - base]; e[3].aWallUv = [peri, topY - base];
      const A = [ax, yb, az], B = [bx, yb, bz], Cc = [bx, topY, bz], D = [ax, topY, az];
      // CCW ring (x,z): outward normal = (dz, -dx); tri() uses winding, so order to face outward
      tri(gb, A, D, B, wall, [e[0], e[3], e[1]]); tri(gb, B, D, Cc, wall, [e[1], e[3], e[2]]);
      peri += L;
    }
    const noWin = { aWin: [0, 0, 0, 0], aWallUv: [0, 0] };
    if (!box) {
      // flat roof (triangulated footprint), inset parapet lip, rooftop units
      const contour = []; for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(P[i * 2], P[i * 2 + 1]));
      let faces = null; try { faces = THREE.ShapeUtils.triangulateShape(contour, []); } catch (err) { faces = null; }
      if (faces) {
        const rc = roofC, yr = ye;
        for (const f of faces) {
          const V = f.map(k => [contour[k].x, yr, contour[k].y]);
          const cr = (V[1][0] - V[0][0]) * (V[2][2] - V[0][2]) - (V[1][2] - V[0][2]) * (V[2][0] - V[0][0]);
          if (cr < 0) tri(gb, V[0], V[1], V[2], rc, noWin); else tri(gb, V[0], V[2], V[1], rc, noWin);
        }
        if (parapet > 0) {                        // inner face of the parapet (so it reads as a lip from above)
          const cxm = P.reduce((s, v, k) => (k % 2 ? s : s + v), 0) / n, czm = P.reduce((s, v, k) => (k % 2 ? s + v : s), 0) / n;
          const lip = wall.clone().multiplyScalar(0.85);
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n; const ax = P[i * 2], az = P[i * 2 + 1], bx = P[j * 2], bz = P[j * 2 + 1];
            const ia = [ax + (cxm - ax) * 0.02, az + (czm - az) * 0.02], ib = [bx + (cxm - bx) * 0.02, bz + (czm - bz) * 0.02];
            const A = [ia[0], yr, ia[1]], B = [ib[0], yr, ib[1]], Cc = [ib[0], topY, ib[1]], D = [ia[0], topY, ia[1]];
            tri(gb, A, B, D, lip, noWin); tri(gb, B, Cc, D, lip, noWin);
            tri(gb, D, Cc, [bx, topY, bz], lip, noWin); tri(gb, D, [bx, topY, bz], [ax, topY, az], lip, noWin);
          }
          // rooftop mechanical units on commercial / industrial / tall buildings
          const bx0 = obb(P, n);
          if (bx0 && area > 300) {
            const units = Math.min(6, 1 + Math.floor(area / 900));
            for (let u = 0; u < units; u++) {
              const s0 = (U.hash2(ri + u * 13, seedBase) - 0.5) * bx0.h0 * 1.2, s1 = (U.hash2(seedBase + u * 7, ri) - 0.5) * bx0.h1 * 1.2;
              const x = bx0.cx + s0 * bx0.ux - s1 * bx0.uz, z = bx0.cz + s0 * bx0.uz + s1 * bx0.ux;
              const w = 2 + U.hash2(u, ri) * 3, h = 1.2 + U.hash2(ri, u) * 1.4;
              boxInto(gb, x, yr + h / 2, z, w, h, w * 0.8, Math.atan2(bx0.uz, bx0.ux), COL.hvac, noWin);
            }
          }
        }
      }
    } else {
      // pitched roof over the oriented box (+ overhang)
      const ov = 0.45, longIs0 = box.h0 >= box.h1;
      const ax = longIs0 ? [box.ux, box.uz] : [-box.uz, box.ux], bxv = longIs0 ? [-box.uz, box.ux] : [box.ux, box.uz];
      const A = (longIs0 ? box.h0 : box.h1) + ov, Bh = (longIs0 ? box.h1 : box.h0) + ov;
      const P3 = (s, t, y) => [box.cx + ax[0] * s + bxv[0] * t, y, box.cz + ax[1] * s + bxv[1] * t];
      const y0 = ye, y1 = ye + rh;
      const rc = roofC;
      const quad = (a, b2, c2, d2, col) => { tri(gb, a, b2, c2, col, noWin); tri(gb, a, c2, d2, col, noWin); };
      const up = (a, b2, c2) => { const cr = (b2[0] - a[0]) * (c2[2] - a[2]) - (b2[2] - a[2]) * (c2[0] - a[0]); return cr < 0; };
      const addTri = (a, b2, c2, col) => { if (up(a, b2, c2)) tri(gb, a, b2, c2, col, noWin); else tri(gb, a, c2, b2, col, noWin); };
      if (b.roof === 1) {           // gable, ridge along the long axis
        const r0 = P3(-A, 0, y1), r1_ = P3(A, 0, y1);
        addTri(P3(-A, -Bh, y0), P3(A, -Bh, y0), r1_, rc); addTri(P3(-A, -Bh, y0), r1_, r0, rc);
        addTri(P3(-A, Bh, y0), r1_, P3(A, Bh, y0), rc); addTri(P3(-A, Bh, y0), r0, r1_, rc);
        // gable end walls (two-sided triangles)
        for (const s of [-1, 1]) { const g0 = P3(s * (A - ov), -(Bh - ov), y0), g1 = P3(s * (A - ov), Bh - ov, y0), g2 = P3(s * (A - ov), 0, y1);
          tri(gb, g0, g1, g2, wall, noWin); tri(gb, g0, g2, g1, wall, noWin); }
      } else if (b.roof === 3) {    // pyramid
        const ap = P3(0, 0, y1), c4 = [P3(-A, -Bh, y0), P3(A, -Bh, y0), P3(A, Bh, y0), P3(-A, Bh, y0)];
        for (let k = 0; k < 4; k++) addTri(c4[k], c4[(k + 1) % 4], ap, rc);
      } else if (b.roof === 4) {    // skillion
        const q0 = P3(-A, -Bh, y0), q1 = P3(A, -Bh, y0), q2 = P3(A, Bh, y1), q3 = P3(-A, Bh, y1);
        addTri(q0, q1, q2, rc); addTri(q0, q2, q3, rc);
        for (const s of [-1, 1]) { const g0 = P3(s * (A - ov), -(Bh - ov), y0), g1 = P3(s * (A - ov), Bh - ov, y0), g2 = P3(s * (A - ov), Bh - ov, y1);
          tri(gb, g0, g1, g2, wall, noWin); tri(gb, g0, g2, g1, wall, noWin); }
      } else {                      // hip
        const inset = Math.min(Bh, A * 0.95), r0 = P3(-(A - inset), 0, y1), r1_ = P3(A - inset, 0, y1);
        const c0 = P3(-A, -Bh, y0), c1 = P3(A, -Bh, y0), c2 = P3(A, Bh, y0), c3 = P3(-A, Bh, y0);
        addTri(c0, c1, r1_, rc); addTri(c0, r1_, r0, rc); addTri(c2, c3, r0, rc); addTri(c2, r0, r1_, rc);
        addTri(c1, c2, r1_, rc); addTri(c3, c0, r0, rc);
      }
      void quad;
    }
  }

  // ------------------------------------------------------------------ procedural house variants
  const HV = {};                     // name -> { geo, W, D, H }
  function vbox(vb, cx, cy, cz, sx, sy, sz, part, win = 0, top = part, bottom = false) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const F = (a, b, c, d, p) => { vb.push([a, b, c, p, win], [a, c, d, p, win]); };
    if ((part === 3 || part === 4 || part === 6) && Math.min(sx, sz) <= 0.12) {   // glass / doors / signs: outward face only
      if (sz <= sx) { if (cz >= 0) F([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], part); else F([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], part); }
      else if (cx >= 0) F([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], part); else F([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], part);
      return;
    }
    F([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], part);     // +z (front)
    F([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], part);     // -z
    F([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], part);     // +x
    F([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], part);     // -x
    F([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], top);      // top
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
    // soffit (underside of the overhang, trim colored; faces down so it reads from street level)
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
    for (const s of [-1, 1]) {           // gable ends
      const g0 = P(s * (A - ov), -(B - ov), y0), g1 = P(s * (A - ov), B - ov, y0), g2 = P(s * (A - ov), 0, y0 + rh - 0.05);
      vb.push([g0, g1, g2, endPart, 0], [g0, g2, g1, endPart, 0]);
    }
  }
  function winRow(vb, face, y, h, xs, w, depthSign, zOrX, idStart, alongX = true) {
    let id = idStart;
    for (const x of xs) {
      if (alongX) vbox(vb, x, y, zOrX + depthSign * 0.04, w, h, 0.1, 3, id++);
      else vbox(vb, zOrX + depthSign * 0.04, y, x, 0.1, h, w, 3, id++);
    }
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
    // subtle ambient occlusion at the base of walls
    const cc = g.attributes.color.array, pp = g.attributes.position.array;
    for (let i = 0; i < n; i++) { const y = pp[i * 3 + 1]; const ao = 0.78 + 0.22 * Math.min(1, y / 1.6); cc[i * 3] = cc[i * 3 + 1] = cc[i * 3 + 2] = ao; }
    g.computeBoundingSphere();
    HV[name] = { geo: g, W, D, H, tris: n / 3 };
  }
  function buildVariants() {
    // local frame: +Z faces the street, X along the street, origin at footprint center on the ground
    makeVariant('ranch', 14, 10, 4.8, vb => {
      vbox(vb, 0, 1.5, 0, 14, 3.0, 10, 0, 0, 0);
      vhip(vb, 0, 0, 7.5, 5.5, 3.0, 1.75, true, 1);
      vbox(vb, 3.6, 1.12, 5.03, 5.2, 2.25, 0.08, 4);                  // garage door
      vbox(vb, -1.4, 1.05, 5.03, 1.0, 2.1, 0.08, 4);                  // front door
      vbox(vb, 3.6, 0.02, 7.5, 5.0, 0.04, 5.0, 2);                    // garage apron (trim color concrete)
      let id = 1; id = winRow(vb, 0, 1.65, 1.2, [-5.0, -3.3], 1.4, 1, 5.0, id);
      id = winRow(vb, 0, 1.75, 1.1, [-4.5, -1.5, 1.5, 4.5], 1.6, -1, -5.0, id);
      id = winRow(vb, 0, 1.75, 1.0, [-2.5, 2.0], 1.2, 1, 7.0, id, false); winRow(vb, 0, 1.75, 1.0, [-2.5, 2.0], 1.2, -1, -7.0, id, false);
      vbox(vb, -4.2, 4.1, -1.8, 0.8, 2.0, 0.8, 5);                     // chimney
    });
    makeVariant('twostory', 12, 10, 8.3, vb => {
      vbox(vb, -1.5, 3.0, 0, 11, 6.0, 10, 0);
      vhip(vb, -1.5, 0, 6.0, 5.5, 6.0, 2.2, true, 1);
      vbox(vb, 6.2, 1.4, 1.0, 5.4, 2.8, 8.0, 0);                      // garage wing
      vhip(vb, 6.2, 1.0, 3.0, 4.3, 2.8, 1.1, false, 1);
      vbox(vb, 6.2, 1.1, 5.03, 4.6, 2.2, 0.08, 4);
      vbox(vb, -2.4, 1.1, 5.03, 1.05, 2.2, 0.08, 4);
      vbox(vb, -2.4, 3.05, 5.35, 2.2, 0.15, 0.8, 2);                  // entry canopy
      let id = 1; id = winRow(vb, 0, 1.6, 1.3, [-5.2, 0.8], 1.6, 1, 5.0, id); id = winRow(vb, 0, 4.4, 1.2, [-5.2, -2.4, 0.8], 1.3, 1, 5.0, id);
      id = winRow(vb, 0, 1.6, 1.3, [-5, -1, 3], 1.5, -1, -5.0, id); winRow(vb, 0, 4.4, 1.2, [-5, -1, 3], 1.3, -1, -5.0, id);
    });
    makeVariant('eichler', 15, 11, 4.1, vb => {
      vbox(vb, 0, 1.45, 0, 15, 2.9, 11, 0);
      vgable(vb, 0, 0, 7.5 + 0.9, 5.5 + 0.9, 2.9, 0.75, false, 1, 0.9, 3);  // low gable, glass gable ends (Eichler)
      vbox(vb, 4.6, 1.05, 5.03, 4.8, 2.1, 0.08, 4);                    // garage
      vbox(vb, -1.6, 1.05, 5.03, 1.1, 2.1, 0.08, 4);
      vbox(vb, -0.4, 2.4, 5.04, 13.8, 0.35, 0.06, 3, 40);               // clerestory strip
      let id = 1; id = winRow(vb, 0, 1.4, 2.4, [-6, -3, 0, 3, 6], 2.8, -1, -5.5, id);   // back: floor-to-ceiling glass
    });
    makeVariant('bungalow', 9.5, 13, 5.6, vb => {
      vbox(vb, 0, 1.7, -0.5, 9.5, 3.4, 12, 0);
      vgable(vb, 0, -0.5, 5.2, 6.6, 3.4, 2.4, false, 1, 0.5, 0);
      vbox(vb, 0, 0.35, 6.4, 7.5, 0.7, 2.4, 2);                        // porch deck
      for (const x of [-3.4, 3.4]) vbox(vb, x, 1.7, 7.4, 0.3, 2.7, 0.3, 2);
      vbox(vb, 0, 3.25, 6.6, 8.2, 0.25, 2.9, 1);                        // porch roof
      vbox(vb, 0, 1.45, 5.53, 1.0, 2.1, 0.08, 4);
      let id = 1; id = winRow(vb, 0, 1.9, 1.4, [-2.8, 2.8], 1.6, 1, 5.5, id);
      id = winRow(vb, 0, 1.9, 1.2, [-3, 0, 3], 1.2, 1, 4.8, id, false); winRow(vb, 0, 1.9, 1.2, [-3, 0, 3], 1.2, -1, -4.8, id, false);
    });
    makeVariant('sfrow', 7.6, 14, 10.2, vb => {
      vbox(vb, 0, 4.9, 0, 7.6, 9.8, 14, 0, 0, 1);
      vbox(vb, 0, 9.95, 7.05, 7.9, 0.5, 0.6, 2);                        // cornice
      vbox(vb, 0.7, 5.9, 7.45, 3.6, 5.2, 0.9, 0);                       // bay window
      let id = 1;
      for (const y of [4.6, 7.3]) { vbox(vb, 0.7, y, 7.92, 2.6, 1.6, 0.06, 3, id++); vbox(vb, -1.12, y, 7.45, 0.06, 1.6, 0.6, 3, id++); vbox(vb, 2.52, y, 7.45, 0.06, 1.6, 0.6, 3, id++); }
      id = winRow(vb, 0, 5.9, 1.9, [-2.6], 0.9, 1, 7.0, id);
      vbox(vb, -1.6, 1.25, 7.03, 3.0, 2.5, 0.08, 4);                    // garage
      vbox(vb, 2.5, 1.45, 7.03, 1.1, 2.6, 0.08, 4);                     // entry
      vbox(vb, 0, 3.05, 7.08, 7.6, 0.25, 0.2, 2);                       // belt course
      winRow(vb, 0, 5.5, 2.0, [-2.2, 0, 2.2], 1.2, -1, -7.0, id);
    });
    makeVariant('apartment', 22, 14, 9.6, vb => {
      vbox(vb, 0, 4.4, 0, 22, 8.8, 14, 0, 0, 1);
      vbox(vb, 0, 9.1, 0, 22.2, 0.6, 14.2, 2, 0, 2);                     // parapet cap
      let id = 1;
      for (const y of [1.6, 4.5, 7.4]) { id = winRow(vb, 0, y, 1.4, [-9, -5.4, -1.8, 1.8, 5.4, 9], 1.6, 1, 7.0, id); id = winRow(vb, 0, y, 1.4, [-9, -5.4, -1.8, 1.8, 5.4, 9], 1.6, -1, -7.0, id); }
      for (const y of [3.1, 6.0]) for (const x of [-7.2, 0, 7.2]) vbox(vb, x, y, 7.55, 3.0, 0.15, 1.1, 2);   // balconies
      vbox(vb, 0, 1.2, 7.03, 1.6, 2.4, 0.08, 4);
      vbox(vb, -6, 9.8, -2, 2.5, 1.2, 2.0, 5);
    });
    makeVariant('commercial', 20, 16, 5.8, vb => {
      vbox(vb, 0, 2.6, 0, 20, 5.2, 16, 0, 0, 1);
      vbox(vb, 0, 5.5, 0, 20.2, 0.7, 16.2, 2, 0, 2);
      vbox(vb, 0, 1.5, 8.03, 17, 2.6, 0.06, 3, 1);                      // storefront glass
      vbox(vb, 0, 3.9, 8.05, 17.6, 0.9, 0.08, 6);                        // sign band
      vbox(vb, 0, 3.15, 8.7, 18, 0.2, 1.4, 2);                          // awning
      vbox(vb, 5, 6.3, -3, 3, 1.4, 2.2, 5); vbox(vb, -4, 6.2, 2, 2, 1.2, 2, 5);
    });
    makeVariant('simple', 12, 10, 4.8, vb => {
      vbox(vb, 0, 1.5, 0, 12, 3.0, 10, 0);
      vhip(vb, 0, 0, 6.4, 5.4, 3.0, 1.7, true, 1);
    });
    makeVariant('simpleFlat', 12, 12, 7, vb => { vbox(vb, 0, 3.5, 0, 12, 7, 12, 0, 0, 1); });
  }

  // ------------------------------------------------------------------ trees and lights
  const TREEG = {}, TREEG_LO = {}, _nv = new THREE.Vector3();
  function flipped(g0) {                       // reversed-winding copy with inverted normals (a cheap back face)
    const g = g0.index ? g0.toNonIndexed() : g0.clone();
    for (const k in g.attributes) { const at = g.attributes[k], a = at.array, s = at.itemSize;
      for (let t = 0; t < at.count; t += 3) for (let c = 0; c < s; c++) { const i1 = (t + 1) * s + c, i2 = (t + 2) * s + c, v = a[i1]; a[i1] = a[i2]; a[i2] = v; }
      if (k === 'normal') for (let i = 0; i < a.length; i++) a[i] = -a[i]; }
    return g;
  }
  // Low-poly trees: vertex-colored parts with smooth canopy normals. lo = far LOD (a third of the triangles).
  function treeGeo(kind, lo) {
    const parts = [], d = lo ? 0 : 1;
    const add = (g, col) => {
      if (g.index) g = g.toNonIndexed();
      const n = g.attributes.position.count, c = new Float32Array(n * 3), cc = new THREE.Color(col), p = g.attributes.position.array;
      for (let i = 0; i < n; i++) { const v = 0.82 + 0.3 * U.hash2(Math.round(p[i * 3] * 7), Math.round(p[i * 3 + 1] * 7 + p[i * 3 + 2] * 5));
        const top = 0.9 + 0.12 * Math.min(1, Math.max(0, (p[i * 3 + 1] - 3) / 8));      // sunlit crowns, darker undersides
        c[i * 3] = cc.r * v * top; c[i * 3 + 1] = cc.g * v * top; c[i * 3 + 2] = cc.b * v * top; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3)); if (g.attributes.uv) g.deleteAttribute('uv'); parts.push(g); };
    const blob = (r, x, y, z, sx, sy, sz, col) => { const g = new THREE.IcosahedronGeometry(r, d), pp = g.attributes.position, nn = g.attributes.normal;
      for (let i = 0; i < pp.count; i++) { _nv.set(pp.getX(i), pp.getY(i), pp.getZ(i)).normalize(); nn.setXYZ(i, _nv.x, _nv.y * 1.2 + 0.15, _nv.z); }   // soft, sky-biased canopy normals
      add(U.place(g, x, y, z, 0, 0, 0, sx, sy, sz), col); };
    const trunk = (r0, r1, h, col) => add(U.place(new THREE.CylinderGeometry(r0, r1, h, lo ? 3 : 5, 1, true), 0, h / 2, 0), col);
    if (kind === 'broad') {                // coast live oak / street tree
      trunk(0.14, 0.26, 3.6, '#5a4634');
      if (lo) blob(2.9, 0, 5.0, 0, 1.25, 0.85, 1.2, '#587239');
      else {
        blob(2.6, 0, 4.7, 0, 1.2, 0.8, 1.1, '#56703a');
        blob(1.9, 1.4, 5.5, 0.6, 1, 0.85, 1, '#5e7a3e');
        blob(1.8, -1.3, 5.2, -0.8, 1, 0.8, 1, '#4f6936');
      }
    } else if (kind === 'conifer') {       // redwood / pine
      trunk(0.2, 0.36, 5, '#4a3526');
      if (lo) add(U.place(new THREE.ConeGeometry(2.6, 11, 5, 1, true), 0, 8.2, 0), '#324d2e');
      else {
        add(U.place(new THREE.ConeGeometry(2.7, 6, 8, 1, true), 0, 6.0, 0), '#2f4a2c');
        add(U.place(new THREE.ConeGeometry(2.1, 5, 8, 1, true), 0, 9.0, 0), '#34502f');
        add(U.place(new THREE.ConeGeometry(1.3, 4.2, 8, 1, true), 0, 11.9, 0), '#3a5634');
      }
    } else if (kind === 'palm') {          // Canary Island date palm / Mexican fan palm
      trunk(0.2, 0.32, 9, '#8a7358');
      if (!lo) add(U.place(new THREE.IcosahedronGeometry(0.6, 0), 0, 9.1, 0), '#6b5a3c');
      const nf = lo ? 5 : 10;
      for (let i = 0; i < nf; i++) { const a = (i / nf) * Math.PI * 2, tilt = 0.5 + (i % 3) * 0.22;
        const f = new THREE.PlaneGeometry(0.9, 3.8, 1, lo ? 1 : 2); f.rotateX(-Math.PI / 2); f.translate(0, 0, 1.9);
        if (!lo) { const pp = f.attributes.position; for (let k = 0; k < pp.count; k++) { const zz = pp.getZ(k); pp.setY(k, -0.08 * zz * zz); } }
        const fg = U.place(f, 0, 9.2, 0, tilt, a, 0);
        add(fg, i % 2 ? '#5f7d33' : '#6e8a3a'); if (!lo) add(flipped(fg), i % 2 ? '#4d6a2b' : '#5a7532'); }   // fronds are two-sided up close
    } else if (kind === 'euc') {           // blue gum eucalyptus: tall, pale trunk, airy crown
      trunk(0.2, 0.42, 9, '#cbc3b0');
      if (lo) blob(3.4, 0, 11.5, 0, 1, 1.45, 1, '#7b8a68');
      else {
        blob(3.0, 0.7, 11.2, 0, 1, 1.35, 1, '#7d8c6a');
        blob(2.4, -1.8, 9.2, 0.7, 1, 1.15, 1, '#728362');
        blob(2.1, 1.2, 14.0, -0.7, 1, 1.2, 1, '#869471');
      }
    }
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

  // ------------------------------------------------------------------ occupancy grid (per tile, reused)
  const GS = 2, GN = 520;                                  // 2 m cells covering -20..1020 m
  let occ = null;                                         // the occupancy grid of the tile being built (one per tile in flight)
  const ci = x => Math.floor((x + 20) / GS);
  const O_YARD = 1, O_PARK = 2, O_HOUSE = 3, O_HARD = 4;   // occupancy values (higher wins)
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
  function rectFree(cx, cz, ux, uz, hw, hd, block = 1) {   // block: lowest occupancy value that blocks
    for (let a = -hw; a <= hw + 0.01; a += Math.max(1.6, hw / 3)) for (let b = -hd; b <= hd + 0.01; b += Math.max(1.6, hd / 3)) {
      if (occAt(cx + ux * a - uz * b, cz + uz * a + ux * b) >= block) return false; }
    return true;
  }
  function markRect(cx, cz, ux, uz, hw, hd, val) {
    const c = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([a, b]) => [cx + ux * a - uz * b, cz + uz * a + ux * b]);
    const P = new Float32Array(8); c.forEach((p, i) => { P[i * 2] = p[0]; P[i * 2 + 1] = p[1]; }); markPoly(P, 4, val, 0);
  }

  // ------------------------------------------------------------------ tile building (generators, time-sliced)
  // Each tile has a level: 0 = ground only (roads, parks, parking), 1 = + buildings, houses (simple), trees, lights,
  // 2 = 'hi': sidewalks, curbs, crosswalks, parapets, rooftop units, detailed house models. build(t, lvl) swaps
  // the new meshes in only when complete, so upgrades and downgrades never pop holes.
  function* build(t, lvl) {
    if (!t.data) {
      const T = decode(t.tx, t.tz); if (!T) { t.state = 'empty'; return; }
      t.data = T; t.hf = heightField(T.ox, T.oz);
      t.inter = new Map();                             // intersection lookup (marking fades, crosswalks, sidewalk ends)
      for (const it of T.it) t.inter.set(Math.round(it.x * 10) + ':' + Math.round(it.z * 10), { R: Math.max(...it.ap.map(a => a.hw)), flags: it.flags });
      if (now() > deadline) yield;
    }
    const hi = lvl >= 2;
    if (t.groundHi !== hi || !t.groundMesh) yield* buildGround(t, hi);
    if (lvl >= 1) { if (t.lvl < 1 || (t.lvl >= 2) !== hi) yield* buildDetail(t, hi); }
    else clearDetail(t);
    t.lvl = lvl; stats.built++;
  }
  function* buildGround(t, hi) {
    const T = t.data, hf = t.hf;
    const gb = new GB([['aMark', 4], ['aRoadUv', 2]]);
    for (let i = 0; i < T.r.length; i++) { roadRibbon(gb, T.r[i], T, hf, t.inter, hi); if (now() > deadline) yield; }
    for (let i = 0; i < T.a.length; i++) { areaPoly(gb, T.a[i], T, hf); if ((i & 7) === 7 && now() > deadline) yield; }
    const g = gb.build();
    if (t.groundMesh) { stats.groundTris -= t.groundMesh.geometry.attributes.position.count / 3; t.root.remove(t.groundMesh); t.groundMesh.geometry.dispose(); t.groundMesh = null; }
    if (g) { const m = new THREE.Mesh(g, roadMat); m.receiveShadow = true; m.name = 'ground'; t.root.add(m); t.groundMesh = m; stats.groundTris += g.attributes.position.count / 3; }
    t.groundHi = hi;
  }

  function* buildDetail(t, hi) {
    const T = t.data, hf = t.hf; if (!T) return;
    const seed = (t.tx * 73856093) ^ (t.tz * 19349663);
    const rnd = U.rng(seed);
    const objs = [];
    // --- OSM buildings
    const bg = new GB([['aWin', 4], ['aWallUv', 2]]);
    for (let i = 0; i < T.b.length; i++) { buildingInto(bg, T.b[i], T, hf, seed & 0xffff, i, hi); if ((i & 15) === 15 && now() > deadline) yield; }
    const bgeo = bg.build();
    if (bgeo) { const m = new THREE.Mesh(bgeo, bldMat); m.castShadow = true; m.receiveShadow = true; m.name = 'buildings'; objs.push(m); }
    if (now() > deadline) yield;
    // --- occupancy for procedural fill: this tile's and the neighbours' roads and buildings, parks
    occ = t.occ = new Uint8Array(GN * GN);             // per tile: builds of several tiles interleave across frames
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const N = (dx || dz) ? decode(t.tx + dx, t.tz + dz) : T; if (!N) continue;
      const sx = dx * TILE, sz = dz * TILE;
      for (const r of N.r) { const P = r.pts, n = P.length / 2; const walks = (r.flags & 8) && r.cls >= 4 && r.cls <= 12;
        const hw = r.width / 2 + (walks ? (r.cls <= 7 ? 3.4 : 3.6) : 1.5);
        for (let i = 0; i + 1 < n; i++) markSeg(P[i * 2] + sx, P[i * 2 + 1] + sz, P[i * 2 + 2] + sx, P[i * 2 + 3] + sz, hw, O_HARD); }
      if (dx || dz) for (const b of N.b) { const P = b.pts; if (P[0] + sx < -40 || P[0] + sx > 1040 || P[1] + sz < -40 || P[1] + sz > 1040) continue;
        const Q = new Float32Array(P.length); for (let i = 0; i < P.length; i += 2) { Q[i] = P[i] + sx; Q[i + 1] = P[i + 1] + sz; } markPoly(Q, Q.length / 2, O_HARD, 2.0); }
    }
    if (now() > deadline) yield;
    for (const b of T.b) markPoly(b.pts, b.pts.length / 2, O_HARD, 2.0);
    for (const a of T.a) markPoly(a.pts, a.pts.length / 2, O_PARK, 0.5);
    if (now() > deadline) yield;
    // --- houses along residential streets, shops and apartments along arterials
    const houses = [];                     // { v, far, x, y, z, yaw, W, H, D, wall, roof, seed, lit }
    const trees = { broad: [], conifer: [], palm: [], euc: [] };
    const lights = [];
    const yards = new GB([['aMark', 4], ['aRoadUv', 2]]);
    const lawnEx = [0, 1, 2].map(() => ({ aMark: [10, 0, 0, 1], aRoadUv: [0, 0] })), driveEx = [0, 1, 2].map(() => ({ aMark: [11, 0, 0, 1], aRoadUv: [0, 0] })), parkEx = [0, 1, 2].map(() => ({ aMark: [8, 0, 0, 1], aRoadUv: [0, 0] }));
    const flatQuad = (gbq, cx, cz, ux, uz, hw, hd, col, exs, lift) => {
      const L = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
      const c = L.map(([a, b]) => { const x = cx + ux * a - uz * b, z = cz + uz * a + ux * b; return [x, hf(x, z) + lift, z]; });
      const up = (a, b, cc) => ((b[0] - a[0]) * (cc[2] - a[2]) - (b[2] - a[2]) * (cc[0] - a[0])) < 0;
      const T3 = (i, j, k) => { exs[0].aRoadUv = L[i]; exs[1].aRoadUv = L[j]; exs[2].aRoadUv = L[k];
        if (up(c[i], c[j], c[k])) tri(gbq, c[i], c[j], c[k], col, exs); else { exs[1].aRoadUv = L[k]; exs[2].aRoadUv = L[j]; tri(gbq, c[i], c[k], c[j], col, exs); } };
      T3(0, 1, 2); T3(0, 2, 3);
    };
    for (let ri = 0; ri < T.r.length; ri++) {
      const r = T.r[ri]; const P = r.pts, n = P.length / 2; if (n < 2) continue;
      const region = regionOf(T.oz + P[1]);
      const res = r.cls === 10 || r.cls === 12 || (r.cls === 11 && (r.flags & 8)), art = r.cls >= 4 && r.cls <= 9 && (r.flags & 8) && !(r.flags & 2);
      if (!res && !art) continue;
      const walks = (r.flags & 8) && r.cls >= 4;
      const edge = r.width / 2 + (walks ? (region >= 1 && r.cls >= 8 ? 3.8 : 2.4) : 1.2);
      const sfRow = region === 0 && res;
      let carry = rnd() * 6;
      for (let i = 0; i + 1 < n; i++) {
        const ax = P[i * 2], az = P[i * 2 + 1], bx = P[i * 2 + 2], bz = P[i * 2 + 3];
        const L = Math.hypot(bx - ax, bz - az); if (L < 6) { carry = Math.max(0, carry - L); continue; }
        const ux = (bx - ax) / L, uz = (bz - az) / L;                  // along the street
        let s = carry;
        while (s < L) {
          let v, W, D, H;                  // pick a building type for this lot
          const q = rnd();
          if (sfRow) { v = 'sfrow'; W = 7.6; D = 13 + rnd() * 3; H = 8 + rnd() * 3; }
          else if (art) { if (q < 0.55) { v = 'commercial'; W = 16 + rnd() * 10; D = 14 + rnd() * 6; H = 5 + rnd() * 2.5; } else { v = 'apartment'; W = 18 + rnd() * 8; D = 12 + rnd() * 4; H = 7 + rnd() * 5; } }
          else {
            if (region === 1) v = q < 0.42 ? 'ranch' : q < 0.72 ? 'twostory' : q < 0.92 ? 'bungalow' : 'apartment';
            else if (region === 2) v = q < 0.30 ? 'ranch' : q < 0.58 ? 'twostory' : q < 0.78 ? 'bungalow' : q < 0.94 ? 'eichler' : 'apartment';
            else if (region === 3) v = q < 0.36 ? 'ranch' : q < 0.60 ? 'eichler' : q < 0.84 ? 'twostory' : 'apartment';
            else if (region === 4) v = q < 0.42 ? 'ranch' : q < 0.66 ? 'bungalow' : q < 0.86 ? 'twostory' : 'apartment';
            else v = q < 0.5 ? 'ranch' : q < 0.82 ? 'twostory' : 'bungalow';
            if (region === 0) v = 'sfrow';
            const base = HV[v]; W = base.W * (0.88 + rnd() * 0.24); D = base.D * (0.9 + rnd() * 0.2); H = base.H * (0.92 + rnd() * 0.16);
          }
          const gap = sfRow ? 0.02 : art ? 3 + rnd() * 6 : 2.6 + rnd() * 3.5;
          const lot = W + gap;
          if (s + W / 2 > L) break;
          const cxs = ax + ux * (s + W / 2), czs = az + uz * (s + W / 2);
          for (const side of [-1, 1]) {
            if (!sfRow && rnd() < (art ? 0.35 : 0.07)) continue;     // vacant lots, variety
            const setback = sfRow ? 0.3 : art ? 3 + rnd() * 10 : 5.5 + rnd() * 3.5;
            const off = edge + setback + D / 2;
            const nxs = -uz * side, nzs = ux * side;                  // unit toward the lot (away from street)
            const cx = cxs + nxs * off, cz = czs + nzs * off;
            if (cx < 0 || cx >= TILE || cz < 0 || cz >= TILE) continue;   // each tile owns the houses centred in it
            if (!rectFree(cx, cz, ux * side, uz * side, W / 2 + (sfRow ? 0 : 0.8), D / 2 + 0.5, O_PARK)) continue;   // backyards don't block street houses
            if (ctx.trackDist(T.ox + cx, T.oz + cz) < 15 + Math.max(W, D) * 0.5 || (ctx.keepOut && ctx.keepOut(T.ox + cx, T.oz + cz))) continue;
            const g0 = hf(cx, cz), g1 = hf(cx + nxs * D * 0.5, cz + nzs * D * 0.5), g2 = hf(cx - nxs * D * 0.5, cz - nzs * D * 0.5);
            if (Math.abs(g1 - g2) > 4.5) continue;
            markRect(cx, cz, ux * side, uz * side, W / 2 + (sfRow ? 0 : 0.6), D / 2 + (sfRow ? 0 : 0.6), O_HOUSE);
            if (!sfRow) markRect(cx + nxs * 5, cz + nzs * 5, ux * side, uz * side, W / 2 + gap / 2 + 0.6, D / 2 + 8, O_YARD);   // the lot incl. backyard (keeps infill out)
            const yaw = Math.atan2(-nxs, -nzs);                       // local +Z faces the street
            const rr = rnd();
            let wall, roof;
            if (v === 'sfrow') { wall = pick(PAL.sfWall, rr); roof = pick(PAL.roofFlat, rnd()); }
            else if (v === 'eichler') { wall = pick(PAL.eichWall, rr); roof = pick(PAL.eichRoof, rnd()); }
            else if (v === 'commercial') { wall = pick(region === 0 ? PAL.sfComm : PAL.comm, rr); roof = pick(PAL.roofFlat, rnd()); }
            else if (v === 'apartment') { wall = pick(region === 0 ? PAL.sfWall : PAL.penWall, rr); roof = pick(PAL.roofFlat, rnd()); }
            else { wall = pick(region === 5 ? PAL.southWall : PAL.penWall, rr); roof = (region >= 2 && rnd() < 0.34) ? pick(PAL.roofTile, rnd()) : pick(PAL.roofComp, rnd()); }
            houses.push({ v, far: v === 'apartment' || v === 'commercial' || v === 'sfrow' ? 'simpleFlat' : 'simple',
              x: cx, y: Math.min(g0, g1, g2) - 0.05, z: cz, yaw, W, H, D, wall, roof, seed: rnd(), lit: v === 'commercial' ? 0.35 : 0.55 });
            // yard: lawn + driveway + trees (suburbs only)
            if (!sfRow && !art && region >= 1) {
              const lawnD = setback + D + 4;
              const lcx = cxs + nxs * (edge + lawnD / 2), lcz = czs + nzs * (edge + lawnD / 2);
              const dry = region >= 4 || rnd() < 0.2;
              flatQuad(yards, lcx, lcz, ux, uz, (W + gap) / 2 - 0.3, lawnD / 2, tint(rnd(), dry ? COL.lawnDry : COL.lawn, 1), lawnEx, 0.10);
              if (v !== 'eichler' || rnd() < 0.5) {
                const dcx = cxs + ux * (W * 0.26) + nxs * (edge + setback / 2), dcz = czs + uz * (W * 0.26) + nzs * (edge + setback / 2);
                flatQuad(yards, dcx, dcz, ux, uz, 1.6, setback / 2 + 0.3, COL.drive, driveEx, 0.12);
              }
              if (rnd() < 0.75) { const bx2 = cx + nxs * (D / 2 + 3 + rnd() * 4) + ux * (rnd() - 0.5) * W, bz2 = cz + nzs * (D / 2 + 3 + rnd() * 4) + uz * (rnd() - 0.5) * W;
                if (ctx.trackDist(T.ox + bx2, T.oz + bz2) > 9) (region >= 4 && rnd() < 0.12 ? trees.palm : rnd() < 0.12 ? trees.conifer : rnd() < 0.08 ? trees.euc : trees.broad).push([bx2, hf(bx2, bz2), bz2, 0.8 + rnd() * 0.7]); }
              if (rnd() < 0.3) { const fx = cxs + nxs * (edge + setback * 0.5) - ux * W * 0.25, fz = czs + nzs * (edge + setback * 0.5) - uz * W * 0.25;
                trees.broad.push([fx, hf(fx, fz), fz, 0.6 + rnd() * 0.5]); }
            }
          }
          // street trees in the planting strip / tree wells
          if (res && rnd() < (region === 0 ? 0.35 : 0.8)) for (const side of [-1, 1]) {
            if (rnd() < 0.25) continue;
            const o = r.width / 2 + (region >= 1 ? 0.9 : 0.8), px = cxs + (-uz * side) * o, pz = czs + (ux * side) * o;
            if (px >= 0 && px < TILE && pz >= 0 && pz < TILE && ctx.trackDist(T.ox + px, T.oz + pz) > 9 && occAt(px, pz) !== O_PARK)
              (region === 4 && rnd() < 0.2 ? trees.palm : trees.broad).push([px, hf(px, pz), pz, 0.75 + rnd() * 0.6]);
          }
          s += lot;
        }
        carry = Math.max(0, s - L);
      }
      if ((ri & 7) === 7 && now() > deadline) yield;
    }
    // --- infill: parcels the streets above don't reach (superblocks, commercial strips, apartment complexes)
    {
      const CG = 10, CN = 104, near = new Uint8Array(CN * CN);            // 10 m mask: 1 = near an urban street, 2 = near an arterial
      const mk = (ax, az, bx, bz, R, v) => {
        const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - R + 20) / CG)), x1 = Math.min(CN - 1, Math.floor((Math.max(ax, bx) + R + 20) / CG));
        const z0 = Math.max(0, Math.floor((Math.min(az, bz) - R + 20) / CG)), z1 = Math.min(CN - 1, Math.floor((Math.max(az, bz) + R + 20) / CG));
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
        for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) { const px = i * CG - 15, pz = j * CG - 15;
          let t = ((px - ax) * dx + (pz - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = ax + dx * t - px, ez = az + dz * t - pz; if (ex * ex + ez * ez < R * R && near[j * CN + i] < v) near[j * CN + i] = v; }
      };
      let hx = 0, hz = 0;                                                     // dominant street direction (mod 90deg)
      for (const r of T.r) { if (!(r.flags & 8) || r.cls <= 3 || r.cls >= 13) continue; const P = r.pts, n = P.length / 2, art = r.cls <= 9;
        for (let i = 0; i + 1 < n; i++) { const ax = P[i * 2], az = P[i * 2 + 1], bx = P[i * 2 + 2], bz = P[i * 2 + 3], L = Math.hypot(bx - ax, bz - az);
          const a4 = Math.atan2(bz - az, bx - ax) * 4; hx += Math.cos(a4) * L; hz += Math.sin(a4) * L;
          mk(ax, az, bx, bz, art ? 75 : 95, 1); if (art) mk(ax, az, bx, bz, 60, 2); } }
      if (hx || hz) {
        const th = Math.atan2(hz, hx) / 4, ux = Math.cos(th), uz = Math.sin(th);
        const region = regionOf(T.oz + 500);
        let nCand = 0;
        for (let a = -700; a < 700; a += 28) for (let b = -700; b < 700; b += 28) {
          if ((++nCand & 63) === 0 && now() > deadline) yield;
          const cx = 500 + ux * a - uz * b + (rnd() - 0.5) * 6, cz = 500 + uz * a + ux * b + (rnd() - 0.5) * 6;
          if (cx < 8 || cx > 992 || cz < 8 || cz > 992) continue;
          const nv = near[Math.floor((cz + 20) / CG) * CN + Math.floor((cx + 20) / CG)]; if (!nv || occAt(cx, cz)) continue;
          if ((ctx.isWater && ctx.isWater(T.ox + cx, T.oz + cz))) continue;
          let v, W, D, H;
          const q = rnd();
          if (nv === 2 || region === 0) { if (q < 0.5) { v = 'commercial'; W = 18 + rnd() * 22; D = 16 + rnd() * 16; H = 5 + rnd() * 4; } else { v = 'apartment'; W = 20 + rnd() * 14; D = 13 + rnd() * 5; H = 7 + rnd() * (region === 0 ? 9 : 5); } }
          else {
            v = region === 3 ? (q < 0.3 ? 'eichler' : q < 0.62 ? 'ranch' : q < 0.85 ? 'twostory' : 'apartment') : region === 2 ? (q < 0.12 ? 'eichler' : q < 0.45 ? 'ranch' : q < 0.75 ? 'twostory' : q < 0.9 ? 'bungalow' : 'apartment')
              : region === 5 ? (q < 0.55 ? 'ranch' : q < 0.85 ? 'twostory' : 'bungalow') : (q < 0.45 ? 'ranch' : q < 0.7 ? 'twostory' : q < 0.88 ? 'bungalow' : 'apartment');
            const base = HV[v]; W = base.W * (0.88 + rnd() * 0.24); D = base.D * (0.9 + rnd() * 0.2); H = base.H * (0.92 + rnd() * 0.16);
          }
          const turn = rnd() < 0.5, ax = turn ? -uz : ux, az = turn ? ux : uz;   // local X axis of the footprint
          if (!rectFree(cx, cz, ax, az, W / 2 + 2, D / 2 + 2)) continue;
          if (ctx.trackDist(T.ox + cx, T.oz + cz) < 18 + Math.max(W, D) * 0.5 || (ctx.keepOut && ctx.keepOut(T.ox + cx, T.oz + cz))) continue;
          const nzx = -az, nzz = ax, g0 = hf(cx, cz), g1 = hf(cx + nzx * D * 0.5, cz + nzz * D * 0.5), g2 = hf(cx - nzx * D * 0.5, cz - nzz * D * 0.5);
          if (Math.abs(g1 - g2) > 4.5) continue;
          markRect(cx, cz, ax, az, W / 2 + 4, D / 2 + 5, O_HOUSE);
          const flip = rnd() < 0.5 ? 1 : -1, yaw = Math.atan2(nzx * flip, nzz * flip);
          const rr = rnd(); let wall, roof;
          if (v === 'eichler') { wall = pick(PAL.eichWall, rr); roof = pick(PAL.eichRoof, rnd()); }
          else if (v === 'commercial') { wall = pick(region === 0 ? PAL.sfComm : PAL.comm, rr); roof = pick(PAL.roofFlat, rnd()); }
          else if (v === 'apartment') { wall = pick(region === 0 ? PAL.sfWall : PAL.penWall, rr); roof = pick(PAL.roofFlat, rnd()); }
          else { wall = pick(region === 5 ? PAL.southWall : PAL.penWall, rr); roof = (region >= 2 && rnd() < 0.34) ? pick(PAL.roofTile, rnd()) : pick(PAL.roofComp, rnd()); }
          houses.push({ v, far: v === 'apartment' || v === 'commercial' ? 'simpleFlat' : 'simple', x: cx, y: Math.min(g0, g1, g2) - 0.05, z: cz, yaw, W, H, D, wall, roof, seed: rnd(), lit: v === 'commercial' ? 0.35 : 0.55 });
          if (v !== 'commercial' && v !== 'apartment' && rnd() < 0.7) { const tx2 = cx + nzx * flip * (-D / 2 - 4), tz2 = cz + nzz * flip * (-D / 2 - 4); trees.broad.push([tx2, hf(tx2, tz2), tz2, 0.8 + rnd() * 0.6]); }
          if (v === 'commercial' && rnd() < 0.8) { const px2 = cx + nzx * flip * (D / 2 + 12), pz2 = cz + nzz * flip * (D / 2 + 12);   // storefront parking
            if (rectFree(px2, pz2, ax, az, W / 2, 9)) { markRect(px2, pz2, ax, az, W / 2, 9, O_HOUSE); flatQuad(yards, px2, pz2, ax, az, W / 2, 9, COL.parking, parkEx, 0.12); } }
        }
        if (now() > deadline) yield;
      }
    }
    // streetlights along urban arterials and SF / downtown San Jose streets
    for (const r of T.r) {
      if (!(r.flags & 8) || r.flags & 2) continue;
      const region = regionOf(T.oz + r.pts[1]);
      const want = (r.cls >= 4 && r.cls <= 9) || (r.cls >= 10 && r.cls <= 12 && (region === 0 || region === 4));
      if (!want) continue;
      const P = r.pts, n = P.length / 2, gapL = region === 0 ? 30 : 40; let next = rnd() * gapL, u0 = 0, side = 1;
      for (let i = 0; i + 1 < n; i++) {
        const ax = P[i * 2], az = P[i * 2 + 1], bx = P[i * 2 + 2], bz = P[i * 2 + 3], L = Math.hypot(bx - ax, bz - az);
        const ux = (bx - ax) / (L || 1), uz = (bz - az) / (L || 1);
        for (; next < u0 + L; next += gapL) {
          const s0 = next - u0, o = r.width / 2 + (r.cls <= 9 ? 1.0 : 0.7), px = ax + ux * s0 - uz * o * side, pz = az + uz * s0 + ux * o * side;
          if (px >= 0 && px < TILE && pz >= 0 && pz < TILE && ctx.trackDist(T.ox + px, T.oz + pz) > 6)
            lights.push([px, hf(px, pz) + 0.3, pz, Math.atan2(uz * side, -ux * side)]);   // arm reaches over the street
          if (r.cls <= 7 || !(r.flags & 1)) side = -side;
        }
        u0 += L;
      }
    }
    // OSM-mapped trees and park trees
    for (const tr of T.t) { const arr = tr.kind === 1 ? trees.palm : tr.kind === 2 ? trees.conifer : tr.kind === 3 ? trees.euc : trees.broad;
      if (ctx.trackDist(T.ox + tr.x, T.oz + tr.z) > 7) arr.push([tr.x, hf(tr.x, tr.z), tr.z, [0.6, 0.9, 1.25, 1.6][tr.size] || 1]); }
    for (const a of T.a) {
      if (now() > deadline) yield;
      if (a.kind !== 0 && a.kind !== 5) continue;
      const P = a.pts, n = P.length / 2; const ar = Math.abs(polyArea(P, n)); const cnt = Math.min(160, Math.floor(ar / 380));
      let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9; for (let i = 0; i < n; i++) { minx = Math.min(minx, P[i * 2]); maxx = Math.max(maxx, P[i * 2]); minz = Math.min(minz, P[i * 2 + 1]); maxz = Math.max(maxz, P[i * 2 + 1]); }
      for (let k = 0, tries = 0; k < cnt && tries < cnt * 4; tries++) {
        const x = minx + rnd() * (maxx - minx), z = minz + rnd() * (maxz - minz);
        let inside = false; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = P[i * 2], zi = P[i * 2 + 1], xj = P[j * 2], zj = P[j * 2 + 1]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside; }
        if (!inside || occAt(x, z) >= O_HOUSE || ctx.trackDist(T.ox + x, T.oz + z) < 9) continue;
        (rnd() < 0.1 ? trees.conifer : rnd() < 0.08 ? trees.euc : trees.broad).push([x, hf(x, z), z, 0.8 + rnd() * 0.8]); k++;
      }
    }
    if (now() > deadline) yield;
    // --- instanced trees + lights, yards (yield between the bigger steps; nothing is visible until the swap)
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
      if (now() > deadline) yield;
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
      poles.computeBoundingSphere(); poles.castShadow = true; poles.userData.pole = true; glows.userData.glow = true; glows.frustumCulled = false; glows.renderOrder = 5;
      poles.name = 'streetlights'; glows.name = 'streetlight-glow'; objs.push(poles, glows);
    }
    const yg = yards.build();
    if (yg) { const m = new THREE.Mesh(yg, roadMat); m.receiveShadow = true; m.name = 'yards'; objs.push(m); }
    if (now() > deadline) yield;
    // swap in
    t.occ = null;
    clearDetail(t);
    for (const o of objs) t.root.add(o);
    t.objs = objs; t.houses = houses; t.detailBuilt = true;
    t.nB = T.b.length; t.nH = houses.length; t.nT = ntrees; t.nL = lights.length;
    stats.buildings += t.nB; stats.houses += t.nH; stats.trees += t.nT; stats.lights += t.nL;
    buildHouses(t, hi);
    t.treeNear = t.poleVis = t.glowVis = t.poolVis = null; lodTouch(t);
  }
  // cheap per-frame LOD: tree geometry and lamp posts by distance
  function lodTouch(t) {
    const tn = t.dist < TREE_R;
    if (t.treeNear !== tn) { t.treeNear = tn; for (const o of t.objs) if (o.userData.treeKind) o.geometry = (tn ? TREEG : TREEG_LO)[o.userData.treeKind]; }
    const pv = t.dist < POLE_R; if (t.poleVis !== pv) { t.poleVis = pv; for (const o of t.objs) if (o.userData.pole) o.visible = pv; }
    const gv = U.uNight.value > 0.02; if (t.glowVis !== gv) { t.glowVis = gv; for (const o of t.objs) if (o.userData.glow) o.visible = gv; }
    const lv = gv && t.dist < POOL_R; if (t.poolVis !== lv) { t.poolVis = lv; for (const o of t.objs) if (o.userData.pool) o.visible = lv; }
  }
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _c = new THREE.Color();
  // (Re)build the instanced house meshes of a tile: detailed variants near the camera, boxes with roofs beyond.
  function buildHouses(t, near) {
    for (const m of t.houseMeshes || []) { t.root.remove(m); disposeObj(m); }
    t.houseMeshes = []; t.detailNear = near;
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
  const HOUSE_ATTRS = ['position', 'normal', 'aPart', 'aWinId', 'color'];

  function disposeObj(o) {
    if (o.isInstancedMesh) o.dispose();                        // instance buffers
    const g = o.geometry; if (!g || g.userData.shared) return;   // shared tree / lamp geometry stays resident
    if (g.userData.sharedAttrs) for (const a of g.userData.sharedAttrs) g.deleteAttribute(a);  // house variant buffers are shared
    g.dispose();
  }
  function clearDetail(t) {
    for (const o of t.objs) { t.root.remove(o); disposeObj(o); }
    for (const m of t.houseMeshes || []) { t.root.remove(m); disposeObj(m); }
    t.objs = []; t.houseMeshes = []; t.houses = null; t.detailBuilt = false; if (t.lvl > 0) t.lvl = 0;
    stats.buildings -= t.nB || 0; stats.houses -= t.nH || 0; stats.trees -= t.nT || 0; stats.lights -= t.nL || 0; t.nB = t.nH = t.nT = t.nL = 0;
  }
  function unload(t) {
    t.gen = null;
    clearDetail(t);
    if (t.groundMesh) { stats.groundTris -= t.groundMesh.geometry.attributes.position.count / 3; t.root.remove(t.groundMesh); t.groundMesh.geometry.dispose(); t.groundMesh = null; }
    group.remove(t.root); tiles.delete(t.key); stats.tiles = tiles.size;
  }

  // ------------------------------------------------------------------ public
  async function init(c) {
    ctx = Object.assign({ groundY: () => 0, trackDist: () => 1e9, ll2w: Geo.ll2w, stationList: [] }, c || {});
    stationW = (ctx.stationList || []).map(s => s.x !== undefined ? s : ctx.ll2w(s.lat, s.lon));
    const u8 = await Data.bin('towns');
    dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (magic !== 'BLT2') throw new Error('towns.bin: bad magic ' + magic);
    const n = dv.getUint32(4, true);
    for (let i = 0; i < n; i++) { const o = 8 + i * 12; const tx = dv.getInt16(o, true), tz = dv.getInt16(o + 2, true);
      index.set(K(tx, tz), { tx, tz, off: dv.getUint32(o + 4, true), len: dv.getUint32(o + 8, true) }); }
    buildVariants();
    for (const k of ['broad', 'conifer', 'palm', 'euc']) { TREEG[k] = treeGeo(k, false); TREEG_LO[k] = treeGeo(k, true); TREEG[k].userData.shared = TREEG_LO[k].userData.shared = true; }
    buildLightGeo(); lightGeo.userData.shared = glowGeo.userData.shared = poolGeo.userData.shared = true;
    ready = true; stats.index = n;
    return { tiles: n, bytes: u8.byteLength };
  }

  const _jobs = [], _rm = [];
  const tileDist = (t, p) => { const dx = Math.max(0, Math.abs(p.x - (t.tx + 0.5) * TILE) - TILE / 2), dz = Math.max(0, Math.abs(p.z - (t.tz + 0.5) * TILE) - TILE / 2); return Math.hypot(dx, dz); };
  let scanX = 1e9, scanZ = 1e9, scanR = 0;
  function update(camPos, env) {
    if (!ready) return;
    const t0 = now(); deadline = t0 + ((env && env.budgetMs) || BUDGET_MS);
    const alt = Math.max(0, camPos.y - ctx.groundY(camPos.x, camPos.z));
    const roadR = ROAD_R + Math.min(alt * 1.2, 2500), bldR = BLD_R + Math.min(alt * 0.8, 1400), hiR = HI_R + Math.min(alt * 0.5, 600);
    stats.detailR = bldR; stats.roadR = roadR;
    // look for new tiles when the camera has moved (or the view radius grew)
    if (Math.abs(camPos.x - scanX) + Math.abs(camPos.z - scanZ) > 40 || roadR > scanR + 50) {
      scanX = camPos.x; scanZ = camPos.z; scanR = roadR;
      const cx0 = Math.floor(camPos.x / TILE), cz0 = Math.floor(camPos.z / TILE), R = Math.ceil(roadR / TILE) + 1;
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const tx = cx0 + dx, tz = cz0 + dz, k = K(tx, tz); if (tiles.has(k) || !index.has(k)) continue;
        const t = { key: k, tx, tz, dist: 0, lvl: -1, want: 0, state: 'idle', objs: [], houseMeshes: [], root: new THREE.Group(), gen: null };
        if (tileDist(t, camPos) > roadR) continue;
        t.root.position.set(tx * TILE, 0, tz * TILE); t.root.name = 'tile ' + k; group.add(t.root); tiles.set(k, t);
      }
      stats.tiles = tiles.size;
    }
    // distances, unloading, wanted level (with hysteresis on the way down)
    _rm.length = 0; _jobs.length = 0;
    for (const t of tiles.values()) {
      const d = t.dist = tileDist(t, camPos);
      if (d > roadR + 900) { _rm.push(t); continue; }
      if (t.state === 'empty') continue;
      let want = d < hiR ? 2 : d < bldR ? 1 : 0;
      if (t.lvl > want && t.state === 'idle') {                 // only step down once clearly out of range
        if (t.lvl === 2 && d < hiR + 450) want = 2; else if (t.lvl >= 1 && d < bldR + 700) want = Math.max(want, 1);
      }
      t.want = want;
      if (t.lvl >= 1) lodTouch(t);
      if (t.state === 'building' || want !== t.lvl) _jobs.push(t);
    }
    for (const t of _rm) unload(t);
    stats.queue = _jobs.length;
    if (!_jobs.length) { stats.lastBuildMs = now() - t0; return; }
    // nearest first; a job in flight keeps its target level
    _jobs.sort((a, b) => a.dist - b.dist);
    for (const t of _jobs) {
      if (now() > deadline) break;
      if (!t.gen) { t.gen = build(t, t.want); t.state = 'building'; }
      occ = t.occ || occ;
      while (now() <= deadline) { const r = t.gen.next(); if (r.done) { t.gen = null; if (t.state === 'building') t.state = 'idle'; break; } }
    }
    stats.lastBuildMs = now() - t0;
  }
  // true when nothing is left to build (handy for screenshots / loading screens)
  function idle() { return ready && stats.queue === 0; }

  const _speed = [29, 13, 22, 13, 18, 11, 16, 11, 13, 10, 11, 11, 7, 6, 3];   // m/s (≈ 65 mph freeway .. 7 mph plaza)
  function roadsNear(x, z, r) {
    const out = [];
    if (!ready) return out;
    const t0x = Math.floor((x - r) / TILE), t1x = Math.floor((x + r) / TILE), t0z = Math.floor((z - r) / TILE), t1z = Math.floor((z + r) / TILE);
    for (let tz = t0z; tz <= t1z; tz++) for (let tx = t0x; tx <= t1x; tx++) {
      const T = decode(tx, tz); if (!T) continue;
      for (const rd of T.r) {
        if (rd.cls > 12) continue;
        const P = rd.pts, n = P.length / 2; let hit = false;
        for (let i = 0; i < n; i++) if (Math.abs(T.ox + P[i * 2] - x) < r && Math.abs(T.oz + P[i * 2 + 1] - z) < r) { hit = true; break; }
        if (!hit) continue;
        const a = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { const wx = T.ox + P[i * 2], wz = T.oz + P[i * 2 + 1]; a[i * 3] = wx; a[i * 3 + 1] = ctx.groundY(wx, wz) + LIFT[Math.min(rd.cls, 14)] + (rd.off ? rd.off[i] : 0); a[i * 3 + 2] = wz; }
        out.push({ pts: a, cls: rd.cls, lanes: rd.lanes, oneway: !!(rd.flags & 1), speed: _speed[rd.cls], width: rd.width, urban: !!(rd.flags & 8), bridge: !!(rd.flags & 2) });
      }
    }
    return out;
  }
  // OSM building footprints near a point (world coords) — for missions / labels / collision.
  function buildingsAt(x, z, r = 60) {
    const out = [];
    if (!ready) return out;
    const t0x = Math.floor((x - r) / TILE), t1x = Math.floor((x + r) / TILE), t0z = Math.floor((z - r) / TILE), t1z = Math.floor((z + r) / TILE);
    for (let tz = t0z; tz <= t1z; tz++) for (let tx = t0x; tx <= t1x; tx++) {
      const T = decode(tx, tz); if (!T) continue;
      for (const b of T.b) {
        const P = b.pts; let cx = 0, cz = 0; const n = P.length / 2;
        for (let i = 0; i < n; i++) { cx += P[i * 2]; cz += P[i * 2 + 1]; } cx = T.ox + cx / n; cz = T.oz + cz / n;
        if (Math.abs(cx - x) > r || Math.abs(cz - z) > r) continue;
        const pts = new Float32Array(P.length); for (let i = 0; i < n; i++) { pts[i * 2] = T.ox + P[i * 2]; pts[i * 2 + 1] = T.oz + P[i * 2 + 1]; }
        out.push({ x: cx, z: cz, height: b.h, minHeight: b.mh, kind: ['house', 'residential', 'commercial', 'industrial', 'civic', 'garage', 'station', 'parking', 'building'][b.kind] || 'building', pts });
      }
    }
    return out;
  }
  function dispose() { for (const t of [...tiles.values()]) unload(t); }
  return { init, update, group, roadsNear, buildingsAt, stats, idle, dispose, regionOf,
    get ready() { return ready; }, materials: { roadMat, bldMat, houseMat, treeMat, glowMat, poleMat, poolMat } };
})();
