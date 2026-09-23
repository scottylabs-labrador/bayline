// Sky & atmosphere (atmosphere agent). One physically based single-scattering atmosphere (Rayleigh, Mie, ozone)
// drives the sky dome, the environment map, aerial perspective, the sun/sky lighting colours and the water
// reflections; plus the Bay's marine layer ("Karl") and a cloud deck, with deterministic daily weather.
//
//   Sky.glsl      GLSL chunk: uniforms + skyRadiance(dir), skySunTrans(h, mu), skyPhaseR/M/HG(mu). Include it in any
//                 shader and Object.assign(yourUniforms, Sky.uniforms). skyRadiance() is one texture fetch.
//   Sky.glslFx    GLSL chunk (needs Sky.glsl): skyScatter(), skyAerial(), skyFogDensity(), skyCloudDens() (Post uses it)
//   Sky.uniforms  shared uniform objects (live; updated every frame)
//   Sky.update(dt, camPos)   called by Env.update
//   Sky.sunLight  { color: THREE.Color, intensity }   sun irradiance at the camera (for the DirectionalLight)
//   Sky.ambient   THREE.Color: sky fill colour (hemisphere-light scale)
//   Sky.weather   { fog, clouds, cirrus, haze, kind }   today's weather (read-only)
//   Sky.rebuildFogMap()      re-derive where the marine layer can flow (after the terrain changes)
const Sky = (() => {
  const Rg = 6360e3, Rt = 6420e3, HR = 8000, HM = 1200;
  const BR = [5.802e-6, 13.558e-6, 33.1e-6], BO = [0.650e-6, 1.881e-6, 0.085e-6];
  const MU_MIN = -0.2, LUT_W = 256, LUT_H = 64, OD_SCALE = 1e-4;
  const WORLD = { X0: -45056, Z0: -49152, SIZE: 102400 };
  const MIE_BASE = 3.996e-6;                     // clean-air Mie scattering (m^-1); weather.haze multiplies it
  const SUN_E = 1.0;                             // top-of-atmosphere sun irradiance in sky units
  const SKY_GAIN = 14.0;                         // sky radiance -> scene units (scene sun ~3.1); includes a multiple-scattering allowance
  const R = Env.renderer;

  // ---------------------------------------------------------------- transmittance LUT (optical depth to space)
  const lut = new Float32Array(LUT_W * LUT_H * 3);
  (function buildLUT() {
    for (let j = 0; j < LUT_H; j++) {
      const v = (j + 0.5) / LUT_H, h = v * v * (Rt - Rg), r = Rg + h;
      for (let i = 0; i < LUT_W; i++) {
        const mu = MU_MIN + (i + 0.5) / LUT_W * (1 - MU_MIN), k = (j * LUT_W + i) * 3;
        const b = r * mu, dg = b * b - (r * r - Rg * Rg);
        if (mu < 0 && dg > 0 && -b - Math.sqrt(dg) > 0) { lut[k] = lut[k + 1] = lut[k + 2] = 4e8; continue; }
        const tTop = -b + Math.sqrt(b * b - (r * r - Rt * Rt)); const s1 = Math.sqrt(Math.max(0, 1 - mu * mu));
        let oR = 0, oM = 0, oO = 0; const N = 48;
        for (let s = 0; s < N; s++) {
          const a0 = s / N, a1 = (s + 1) / N, t0 = tTop * a0 * a0, t1 = tTop * a1 * a1, tm = 0.5 * (t0 + t1), dt = t1 - t0;
          const hh = Math.hypot(tm * s1, r + tm * mu) - Rg;
          oR += Math.exp(-hh / HR) * dt; oM += Math.exp(-hh / HM) * dt; oO += Math.max(0, 1 - Math.abs(hh - 25000) / 15000) * dt;
        }
        lut[k] = oR; lut[k + 1] = oM; lut[k + 2] = oO;
      }
    }
  })();
  const lutTex = (() => {
    const d = new Uint16Array(LUT_W * LUT_H * 4); const H = THREE.DataUtils.toHalfFloat;
    for (let i = 0; i < LUT_W * LUT_H; i++) { d[i * 4] = H(lut[i * 3] * OD_SCALE); d[i * 4 + 1] = H(lut[i * 3 + 1] * OD_SCALE); d[i * 4 + 2] = H(lut[i * 3 + 2] * OD_SCALE); d[i * 4 + 3] = H(1); }
    const t = new THREE.DataTexture(d, LUT_W, LUT_H, THREE.RGBAFormat, THREE.HalfFloatType);
    t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; return t;
  })();
  function odAt(h, mu, out) {     // CPU bilinear lookup of the LUT (meters)
    const fu = U.clamp((mu - MU_MIN) / (1 - MU_MIN) * LUT_W - 0.5, 0, LUT_W - 1.001), fv = U.clamp(Math.sqrt(U.clamp(h / (Rt - Rg), 0, 1)) * LUT_H - 0.5, 0, LUT_H - 1.001);
    const i = fu | 0, j = fv | 0, tu = fu - i, tv = fv - j;
    for (let c = 0; c < 3; c++) {
      const a = lut[(j * LUT_W + i) * 3 + c], b = lut[(j * LUT_W + i + 1) * 3 + c], e = lut[((j + 1) * LUT_W + i) * 3 + c], f = lut[((j + 1) * LUT_W + i + 1) * 3 + c];
      out[c] = (a * (1 - tu) + b * tu) * (1 - tv) + (e * (1 - tu) + f * tu) * tv;
    }
    return out;
  }
  const _od = [0, 0, 0];
  function transmittance(h, mu, bMe, out) {
    odAt(h, mu, _od);
    for (let c = 0; c < 3; c++) out[c] = Math.exp(-(BR[c] * _od[0] + bMe * _od[1] + BO[c] * _od[2]));
    return out;
  }

  // ---------------------------------------------------------------- noise textures (clouds 2D, fog 3D)
  function tileNoise2(N, periods, seed) { // tileable value-noise fbm, returns Float32Array N*N in [0,1]
    const out = new Float32Array(N * N); let norm = 0;
    periods.forEach((P, o) => {
      const r = U.rng(seed + o * 101), g = new Float32Array(P * P); for (let i = 0; i < g.length; i++) g[i] = r();
      const amp = Math.pow(0.55, o); norm += amp;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const fx = x / N * P, fy = y / N * P, ix = Math.floor(fx), iy = Math.floor(fy); let tx = fx - ix, ty = fy - iy;
        tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
        const a = g[(iy % P) * P + ix % P], b = g[(iy % P) * P + (ix + 1) % P], c = g[((iy + 1) % P) * P + ix % P], d = g[((iy + 1) % P) * P + (ix + 1) % P];
        out[y * N + x] += amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
      }
    });
    for (let i = 0; i < out.length; i++) out[i] /= norm;
    return out;
  }
  const cloudTex = (() => {
    const N = 256; const a = tileNoise2(N, [4, 8, 16, 32, 64], 11), b = tileNoise2(N, [16, 32, 64, 128], 77), c = tileNoise2(N, [3, 6, 24, 96], 313);
    const d = new Uint8Array(N * N * 4);
    const stretch = (v) => U.clamp((v - 0.5) * 1.9 + 0.5, 0, 1);
    for (let i = 0; i < N * N; i++) { d[i * 4] = stretch(a[i]) * 255; d[i * 4 + 1] = stretch(b[i]) * 255; d[i * 4 + 2] = stretch(c[i]) * 255; d[i * 4 + 3] = 255; }
    const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true; return t;
  })();
  const fogNoise = (() => {
    const N = 48; const d = new Uint8Array(N * N * N); const periods = [4, 8, 16]; let norm = 0; const acc = new Float32Array(N * N * N);
    periods.forEach((P, o) => {
      const r = U.rng(900 + o * 17), g = new Float32Array(P * P * P); for (let i = 0; i < g.length; i++) g[i] = r();
      const amp = Math.pow(0.5, o); norm += amp; const s = (v) => v * v * (3 - 2 * v);
      const G = (x, y, z) => g[((z % P) * P + (y % P)) * P + (x % P)];
      for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const fx = x / N * P, fy = y / N * P, fz = z / N * P, ix = fx | 0, iy = fy | 0, iz = fz | 0, tx = s(fx - ix), ty = s(fy - iy), tz = s(fz - iz);
        const c00 = G(ix, iy, iz) * (1 - tx) + G(ix + 1, iy, iz) * tx, c10 = G(ix, iy + 1, iz) * (1 - tx) + G(ix + 1, iy + 1, iz) * tx;
        const c01 = G(ix, iy, iz + 1) * (1 - tx) + G(ix + 1, iy, iz + 1) * tx, c11 = G(ix, iy + 1, iz + 1) * (1 - tx) + G(ix + 1, iy + 1, iz + 1) * tx;
        acc[(z * N + y) * N + x] += amp * ((c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz);
      }
    });
    for (let i = 0; i < acc.length; i++) d[i] = U.clamp(((acc[i] / norm) - 0.5) * 1.8 + 0.5, 0, 1) * 255;
    const t = new THREE.Data3DTexture(d, N, N, N); t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.minFilter = t.magFilter = THREE.LinearFilter; t.unpackAlignment = 1; t.needsUpdate = true; return t;
  })();

  // ---------------------------------------------------------------- marine-layer reach map
  // For every 400 m cell: the lowest "ridge height" the fog must overtop to get there from the open Pacific
  // (a minimax path, so it pours through the Golden Gate and the San Bruno Gap first) and the distance travelled
  // over land/bay along that path. The shader compares both against today's fog-top and advance distance.
  const FM = 256, CELL = WORLD.SIZE / FM;
  const fogMapData = new Uint16Array(FM * FM * 4);
  const fogMap = new THREE.DataTexture(fogMapData, FM, FM, THREE.RGBAFormat, THREE.HalfFloatType);
  fogMap.minFilter = fogMap.magFilter = THREE.LinearFilter; fogMap.wrapS = fogMap.wrapT = THREE.ClampToEdgeWrapping;
  let fogMapReady = false;
  (function defaultFogMap() {   // before the terrain loads: ocean west of the coast only
    const H = THREE.DataUtils.toHalfFloat;
    for (let j = 0; j < FM; j++) for (let i = 0; i < FM; i++) { const k = (j * FM + i) * 4; const x = WORLD.X0 + (i + 0.5) * CELL; fogMapData[k] = H(x < -34000 ? 0 : 2000); fogMapData[k + 1] = H(x < -34000 ? 0 : 200); fogMapData[k + 2] = H(0.3); fogMapData[k + 3] = H(1); }
    fogMap.needsUpdate = true;
  })();
  function rebuildFogMap() {
    if (typeof Terrain === 'undefined' || !Terrain.h) return false;
    const N = FM, h = new Float32Array(N * N), water = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = WORLD.X0 + (i + 0.5) * CELL, z = WORLD.Z0 + (j + 0.5) * CELL; let m = -1e9;
      for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3], [0, 0]]) m = Math.max(m, Terrain.h(x + dx * CELL, z + dz * CELL));
      h[j * N + i] = Math.max(0, m); water[j * N + i] = m < 1.0 ? 1 : 0;
    }
    // open ocean = water connected to the west/south border after an 800 m erosion (cuts the Golden Gate so the Bay isn't "ocean")
    const er = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { let ok = water[j * N + i]; for (let dj = -2; dj <= 2 && ok; dj++) for (let di = -2; di <= 2 && ok; di++) { const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < N && b < N && !water[b * N + a]) ok = 0; } er[j * N + i] = ok; }
    const ocean = new Uint8Array(N * N), q = [];
    for (let j = 0; j < N; j++) { if (er[j * N]) { ocean[j * N] = 1; q.push(j * N); } }
    for (let i = 0; i < N; i++) { const k = (N - 1) * N + i; if (er[k] && !ocean[k]) { ocean[k] = 1; q.push(k); } }
    while (q.length) { const k = q.pop(), i = k % N, j = (k / N) | 0; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= N || b >= N) continue; const kk = b * N + a; if (er[kk] && !ocean[kk]) { ocean[kk] = 1; q.push(kk); } } }
    // dilate back 2 cells (within water) so the coastline is right
    for (let pass = 0; pass < 2; pass++) { const add = []; for (let k = 0; k < N * N; k++) { if (ocean[k] || !water[k]) continue; const i = k % N, j = (k / N) | 0; if ((i > 0 && ocean[k - 1]) || (i < N - 1 && ocean[k + 1]) || (j > 0 && ocean[k - N]) || (j < N - 1 && ocean[k + N])) add.push(k); } for (const k of add) ocean[k] = 1; }
    // lexicographic Dijkstra: minimise (barrier height, then distance travelled off the open ocean)
    const bar = new Float32Array(N * N).fill(1e9), dist = new Float32Array(N * N).fill(1e9);
    const heap = []; const push = (k) => { heap.push(k); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (less(heap[c], heap[p])) { [heap[c], heap[p]] = [heap[p], heap[c]]; c = p; } else break; } };
    const less = (a, b) => bar[a] < bar[b] - 0.5 || (Math.abs(bar[a] - bar[b]) <= 0.5 && dist[a] < dist[b]);
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === c) break; [heap[c], heap[m]] = [heap[m], heap[c]]; c = m; } } return top; };
    for (let k = 0; k < N * N; k++) if (ocean[k]) { bar[k] = 0; dist[k] = 0; push(k); }
    const done = new Uint8Array(N * N);
    while (heap.length) {
      const k = pop(); if (done[k]) continue; done[k] = 1; const i = k % N, j = (k / N) | 0;
      for (const [di, dj, w] of [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414]]) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= N || b >= N) continue; const kk = b * N + a; if (done[kk]) continue;
        const nb = Math.max(bar[k], h[kk]), nd = dist[k] + (ocean[kk] ? 0 : w * CELL);
        if (nb < bar[kk] - 0.5 || (Math.abs(nb - bar[kk]) <= 0.5 && nd < dist[kk])) { bar[kk] = nb; dist[kk] = nd; push(kk); }
      }
    }
    const H = THREE.DataUtils.toHalfFloat;
    const urb = new Float32Array(N * N);
    if (Terrain.urbanAt) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { let u = 0; for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3], [0, 0]]) u += Terrain.urbanAt(WORLD.X0 + (i + 0.5 + dx) * CELL, WORLD.Z0 + (j + 0.5 + dz) * CELL) || 0; urb[j * N + i] = u / 5; }
    // blur the glow ~1.2 km so it lights the underside of the fog around each town
    const ub = new Float32Array(N * N); for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { let s2 = 0, n2 = 0; for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= N || b >= N) continue; s2 += urb[b * N + a]; n2++; } ub[j * N + i] = s2 / n2; }
    for (let k = 0; k < N * N; k++) { fogMapData[k * 4] = H(Math.min(bar[k], 4000)); fogMapData[k * 4 + 1] = H(Math.min(dist[k] / 1000, 400)); fogMapData[k * 4 + 2] = H(Math.min(1, ub[k] * 1.6)); fogMapData[k * 4 + 3] = H(h[k]); }
    fogMap.needsUpdate = true; fogMapReady = true; return true;
  }

  // ---------------------------------------------------------------- weather (deterministic per date) + marine-layer schedule
  const weather = { kind: 'auto', fog: 0.6, clouds: 0.2, cirrus: 0.3, haze: 2.2, ymd: '' };
  const debug = {};            // e.g. Sky.debug.fogDens = 0 to switch the marine layer off while tuning
  function dailyWeather(ymd) {
    const r = U.rng(U.hashStr('bayline-wx-' + ymd)); const m = +ymd.slice(4, 6);
    const season = [0.35, 0.3, 0.35, 0.45, 0.65, 0.85, 0.95, 0.95, 0.7, 0.5, 0.35, 0.35][m - 1];   // marine layer by month
    const fog = U.clamp(season * (0.35 + r() * 1.0), 0, 1);
    const wet = [0.55, 0.5, 0.4, 0.25, 0.15, 0.08, 0.05, 0.05, 0.1, 0.2, 0.4, 0.5][m - 1];
    const clouds = U.clamp(0.08 + r() * 0.35 + (r() < wet ? 0.35 : 0), 0, 0.85);
    const cirrus = U.clamp(r() * 0.9 - 0.15, 0, 0.8);
    const haze = 1.3 + r() * 2.2 + (m >= 6 && m <= 10 ? 0.6 : 0);
    return { fog, clouds, cirrus, haze };
  }
  // fog-top altitude (m) and inland advance (m) through the day: deep and far at night, burns off by late morning,
  // sits offshore in the afternoon, pours back over the ridge and through the gaps from late afternoon
  function fogSchedule(sec, strength) {
    // (hour, top m, reach m): deep overnight and in the morning, burnt back at midday, then the classic summer evening
    // influx pours through the Golden Gate as a low river of fog (~150-200 m: the bridge towers stand out of it) that
    // deepens again after dark
    const h = sec / 3600; const key = [[0, 470, 16000], [5, 480, 17000], [8, 420, 13000], [10, 330, 4000], [11.5, 260, 400], [15, 220, 0], [17, 140, 4500], [19, 170, 11000], [21.5, 360, 15000], [24, 470, 16000]];
    let i = 0; while (i < key.length - 2 && h > key[i + 1][0]) i++;
    const a = key[i], b = key[i + 1], t = U.smooth(0, 1, (h - a[0]) / (b[0] - a[0]));
    const top = U.lerp(a[1], b[1], t) * (0.55 + 0.6 * strength), dist = U.lerp(a[2], b[2], t) * (0.25 + 0.95 * strength);
    return { top, dist };
  }

  // ---------------------------------------------------------------- uniforms + GLSL
  const uniforms = {
    uSkyLUT: { value: lutTex }, uSkyTex: { value: null }, uSkySunDir: { value: new THREE.Vector3(0, 1, 0) }, uSkyMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uSkySunColor: { value: new THREE.Vector3(3, 3, 3) }, uSkyAmbient: { value: new THREE.Vector3(0.3, 0.35, 0.45) }, uSkyGlow: { value: new THREE.Vector3(0, 0, 0) },
    uSkyBMs: { value: MIE_BASE * 2 }, uSkyBMe: { value: MIE_BASE * 2 / 0.9 }, uSkyGain: { value: SKY_GAIN }, uSkyNight: U.uNight, uSkyTime: U.uTime, uSkyCamH: { value: 2 },
    uSkySunE: { value: SUN_E }, uSkyMoon: { value: 0 },
    uCloudTex: { value: cloudTex }, uCloudCover: { value: 0.2 }, uCirrus: { value: 0.3 }, uCloudOfs: { value: new THREE.Vector2() },
    uFogMap: { value: fogMap }, uFogNoise: { value: fogNoise }, uFogTop: { value: 400 }, uFogDist: { value: 8000 }, uFogDens: { value: 1 }, uFogOfs: { value: new THREE.Vector3() },
    uWorld: { value: new THREE.Vector4(WORLD.X0, WORLD.Z0, WORLD.SIZE, 0) },
  };
  const glsl = /* glsl */`
#ifndef BAYLINE_SKY
#define BAYLINE_SKY
uniform sampler2D uSkyLUT; uniform sampler2D uSkyTex;
uniform vec3 uSkySunDir, uSkyMoonDir, uSkySunColor, uSkyAmbient, uSkyGlow;
uniform float uSkyBMs, uSkyBMe, uSkyGain, uSkyNight, uSkyTime, uSkyCamH, uSkySunE, uSkyMoon;
#define SKY_RG 6360e3
#define SKY_RT 6420e3
#define SKY_HR 8000.0
#define SKY_HM 1200.0
const vec3 SKY_BR = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const vec3 SKY_BO = vec3(0.650e-6, 1.881e-6, 0.085e-6);
vec3 skyOD(float h, float mu) {
  float v = sqrt(clamp(h / (SKY_RT - SKY_RG), 0.0, 1.0)); float u = (mu + 0.2) / 1.2;
  return texture2D(uSkyLUT, vec2(u, v)).rgb * 1e4;
}
vec3 skySunTrans(float h, float mu) { vec3 o = skyOD(h, mu); return exp(-(SKY_BR * o.x + uSkyBMe * o.y + SKY_BO * o.z)); }
float skyPhaseR(float mu) { return 0.0596831 * (1.0 + mu * mu); }
float skyPhaseHG(float mu, float g) { float g2 = g * g; return 0.0795775 * (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5); }
float skyPhaseM(float mu) { const float g = 0.76; float g2 = g * g; return 0.1193662 * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5)); }
vec2 skyEquirectUV(vec3 d) { float y = clamp(d.y, -1.0, 1.0); return vec2(atan(d.x, -d.z) * 0.1591549 + 0.5, 0.5 + 0.5 * sign(y) * sqrt(abs(y))); }
vec3 skyEquirectDir(vec2 uv) { float y = (uv.y - 0.5) * 2.0; y = sign(y) * y * y; float c = sqrt(max(1.0 - y * y, 0.0)); float ph = (uv.x - 0.5) * 6.2831853; return vec3(sin(ph) * c, y, -cos(ph) * c); }
// sky radiance (scene units, no sun disk) toward dir, as seen from the current camera: one texture fetch
vec3 skyRadiance(vec3 dir) { return texture2D(uSkyTex, skyEquirectUV(normalize(dir))).rgb; }
#endif
`;
  const glslFx = /* glsl */`
#ifndef BAYLINE_SKYFX
#define BAYLINE_SKYFX
uniform sampler2D uCloudTex; uniform float uCloudCover, uCirrus; uniform vec2 uCloudOfs;
uniform sampler2D uFogMap; uniform highp sampler3D uFogNoise; uniform float uFogTop, uFogDist, uFogDens; uniform vec3 uFogOfs; uniform vec4 uWorld;
vec2 skyRaySph(vec3 ro, vec3 rd, float r) { float b = dot(ro, rd); float c = dot(ro, ro) - r * r; float d = b * b - c; if (d < 0.0) return vec2(-1.0); d = sqrt(d); return vec2(-b - d, -b + d); }
// single scattering from altitude h0 along rd to space (or the ground); T = transmittance of the ray
vec3 skyScatter(float h0, vec3 rd, vec3 sd, out vec3 T, out float hitGround) {
  vec3 ro = vec3(0.0, SKY_RG + max(h0, 1.0), 0.0);
  vec2 ta = skyRaySph(ro, rd, SKY_RT); hitGround = 0.0;
  if (ta.y <= 0.0) { T = vec3(1.0); return vec3(0.0); }
  float t0 = max(ta.x, 0.0), t1 = ta.y;
  vec2 tg = skyRaySph(ro, rd, SKY_RG); if (tg.x > 0.0) { t1 = tg.x; hitGround = 1.0; }
  float L = t1 - t0; vec3 sR = vec3(0.0), sM = vec3(0.0), od = vec3(0.0);
  const int N = 24;
  for (int i = 0; i < N; i++) {
    float a0 = float(i) / float(N), a1 = float(i + 1) / float(N);
    float ta0 = t0 + L * a0 * a0, ta1 = t0 + L * a1 * a1, dt = ta1 - ta0, tm = 0.5 * (ta0 + ta1);
    vec3 p = ro + rd * tm; float r = length(p); float h = r - SKY_RG;
    vec3 dd = vec3(exp(-h / SKY_HR), exp(-h / SKY_HM), max(0.0, 1.0 - abs(h - 25000.0) / 15000.0)) * dt;
    vec3 odm = od + 0.5 * dd; od += dd;
    vec3 os = skyOD(h, dot(p, sd) / r);
    vec3 att = exp(-(SKY_BR * (odm.x + os.x) + uSkyBMe * (odm.y + os.y) + SKY_BO * (odm.z + os.z)));
    sR += dd.x * att; sM += dd.y * att;
  }
  T = exp(-(SKY_BR * od.x + uSkyBMe * od.y + SKY_BO * od.z));
  float mu = dot(rd, sd);
  return uSkySunE * (sR * SKY_BR * skyPhaseR(mu) + sM * uSkyBMs * skyPhaseM(mu));
}
// aerial perspective over a finite path (flat-earth exponential integrals); returns in-scatter in scene units
vec3 skyAerial(float h0, vec3 rd, float dist, out vec3 T) {
  h0 = max(h0, 0.0); float dy = rd.y; float h1 = max(h0 + dist * dy, 0.0);
  float fR, fM;
  if (abs(dy) < 1e-4) { fR = dist * exp(-h0 / SKY_HR); fM = dist * exp(-h0 / SKY_HM); }
  else { fR = SKY_HR * (exp(-h0 / SKY_HR) - exp(-(h0 + dist * dy) / SKY_HR)) / dy; fM = SKY_HM * (exp(-h0 / SKY_HM) - exp(-(h0 + dist * dy) / SKY_HM)) / dy; }
  fR = max(fR, 0.0); fM = max(fM, 0.0);
  vec3 tau = SKY_BR * fR + uSkyBMe * fM; T = exp(-tau);
  float mu = dot(rd, uSkySunDir);
  vec3 Ts = skySunTrans(0.5 * (h0 + h1), uSkySunDir.y);
  vec3 sc = SKY_BR * fR * skyPhaseR(mu) + uSkyBMs * fM * skyPhaseM(mu);
  vec3 ins = uSkySunE * uSkyGain * Ts * sc * (1.0 - T) / max(tau, vec3(1e-6));
  // multiple scattering / skylight fill + night light pollution
  ins += (uSkyAmbient * 0.3 + uSkyGlow * uSkyNight * 0.5) * (1.0 - T);
  return ins;
}
// ---- cloud deck (cumulus ~1.6-2.4 km) and cirrus (9 km)
float skyCloudDensH(vec2 xz, float h01) {       // h01: 0 at the cloud base, 1 at the tops
  if (uCloudCover <= 0.001) return 0.0;
  vec2 p = xz / 11000.0 + uCloudOfs;
  float n = texture2D(uCloudTex, p).r * 0.6 + texture2D(uCloudTex, p * 3.3 + vec2(0.37, 0.71)).g * 0.3 + texture2D(uCloudTex, p * 9.1 + vec2(0.61, 0.13)).b * 0.1;
  float c = (1.0 - uCloudCover) * 0.9 + h01 * 0.11;
  return smoothstep(c, c + 0.26, n);
}
float skyCloudDens(vec2 xz) { return skyCloudDensH(xz, 0.35); }
float skyCirrus(vec2 xz) {
  if (uCirrus <= 0.001) return 0.0;
  vec2 p = vec2(xz.x / 42000.0, xz.y / 13000.0) + uCloudOfs * 0.7;
  float n = texture2D(uCloudTex, p).b * 0.7 + texture2D(uCloudTex, p * vec2(5.0, 2.0) + 0.13).g * 0.3;
  return smoothstep(0.52, 0.9, n) * uCirrus;
}
// ---- marine layer: where it can reach (map) x height profile x 3D noise
float skyFogReach(vec2 xz) {
  vec2 uv = (xz - uWorld.xy) / uWorld.z;
  vec4 m = texture2D(uFogMap, uv);
  float over = smoothstep(-60.0, 90.0, uFogTop - m.r);
  float adv = 1.0 - smoothstep(uFogDist - 3500.0, uFogDist + 500.0, m.g * 1000.0);
  float edge = step(uv.x, 0.0) + step(uv.y, 0.0);            // beyond the west/south border: open ocean
  return clamp(max(over * adv, edge), 0.0, 1.0);
}
float skyFogGlow(vec2 xz) { return texture2D(uFogMap, (xz - uWorld.xy) / uWorld.z).b; }
float skyFogDensity(vec3 p) {
  if (uFogDens <= 0.0) return 0.0;
  float reach = skyFogReach(p.xz);
  if (reach <= 0.002) return 0.0;
  float n = texture(uFogNoise, p * vec3(1.0 / 2600.0, 1.0 / 700.0, 1.0 / 2600.0) + uFogOfs).r;
  float n2 = texture(uFogNoise, p * vec3(1.0 / 650.0, 1.0 / 200.0, 1.0 / 650.0) + uFogOfs * 2.3).r;
  float top = uFogTop * (0.78 + 0.34 * n) + (n2 - 0.5) * 60.0;
  float v = 1.0 - smoothstep(top - 140.0, top + 25.0, p.y);
  return uFogDens * reach * v * clamp(0.25 + 1.05 * n * (0.7 + 0.6 * n2), 0.0, 1.6);
}
#endif
`;

  // ---------------------------------------------------------------- baked sky (equirect, for the dome, reflections and env map)
  const BAKE_W = 512, BAKE_H = 256;
  const bakeRT = new THREE.WebGLRenderTarget(BAKE_W, BAKE_H, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
  bakeRT.texture.wrapS = THREE.RepeatWrapping; bakeRT.texture.wrapT = THREE.ClampToEdgeWrapping; bakeRT.texture.minFilter = THREE.LinearFilter; bakeRT.texture.generateMipmaps = false;
  uniforms.uSkyTex.value = bakeRT.texture;
  const fsGeo = new THREE.BufferGeometry(); fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const fsScene = new THREE.Scene(), fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bakeMat = new THREE.ShaderMaterial({
    uniforms, depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: glsl + glslFx + /* glsl */`
      varying vec2 vUv;
      void main() {
        vec3 d = skyEquirectDir(vUv);
        vec3 T; float g;
        vec3 col = skyScatter(uSkyCamH, d, uSkySunDir, T, g) * uSkyGain;
        // ground seen below the horizon from altitude: dark earth lit by the sun, through the atmosphere
        if (g > 0.5) { vec3 Ts = skySunTrans(0.0, uSkySunDir.y); col += T * 0.09 * (uSkySunE * uSkyGain * 0.12 * Ts * max(uSkySunDir.y, 0.0) + uSkyAmbient * 0.35); }
        // night: moonlit deep-blue base + orange light pollution hugging the horizon (the Bay never gets truly dark)
        float up = max(d.y, 0.0);
        vec3 nightBase = mix(vec3(0.0065, 0.0105, 0.022), vec3(0.0025, 0.0045, 0.011), pow(up, 0.5)) * (0.55 + 0.9 * uSkyMoon);
        col += nightBase * uSkyNight;
        col += uSkyGlow * uSkyNight * exp(-up * 9.0) * (d.y > -0.05 ? 1.0 : 0.6);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const fsQuad = new THREE.Mesh(fsGeo, bakeMat); fsQuad.frustumCulled = false; fsScene.add(fsQuad);
  function bake() {
    const prev = R.getRenderTarget(); const xr = R.xr.enabled; R.xr.enabled = false;
    R.setRenderTarget(bakeRT); R.render(fsScene, fsCam); R.setRenderTarget(prev); R.xr.enabled = xr;
  }

  // ---------------------------------------------------------------- sky dome + environment-map sky
  const domeMat = new THREE.ShaderMaterial({
    uniforms: Object.assign({ uSunDisk: { value: 1 }, uDomeScale: { value: 1 } }, uniforms), side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: glsl + /* glsl */`
      uniform float uSunDisk, uDomeScale; varying vec3 vDir;
      float hsh(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = skyRadiance(d) * uDomeScale;
        float mu = dot(d, uSkySunDir);
        // sun disk with limb darkening, reddened by the atmosphere
        if (uSunDisk > 0.0 && mu > 0.99997) {
          float r = clamp((1.0 - mu) / 1.37e-5, 0.0, 1.0);          // 0.3 deg angular radius
          float disk = smoothstep(1.0, 0.92, r) * (0.6 + 0.4 * sqrt(max(1.0 - r * r, 0.0)));
          vec3 Ts = skySunTrans(uSkyCamH, uSkySunDir.y);
          col += Ts * uSkySunE * uSkyGain * 900.0 * disk * step(-0.02, d.y);
        }
        // moon
        float mm = dot(d, uSkyMoonDir);
        col += vec3(0.82, 0.86, 0.94) * smoothstep(0.999982, 0.999988, mm) * 1.6 * smoothstep(0.15, 0.6, uSkyNight) * uSkyMoon;
        col += vec3(0.5, 0.56, 0.7) * pow(max(mm, 0.0), 1800.0) * 0.08 * uSkyNight * uSkyMoon;   // moon halo
        // stars (twinkle; fade into the horizon haze and the city glow)
        if (uSkyNight > 0.02 && d.y > 0.0) {
          vec3 g = floor(d * 420.0); float s = hsh(g); float tw = 0.7 + 0.3 * sin(uSkyTime * 3.0 + s * 80.0);
          col += vec3(0.85, 0.9, 1.0) * smoothstep(0.9962, 1.0, s) * uSkyNight * tw * smoothstep(0.04, 0.35, d.y) * 0.22;
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  Env.sky.material = domeMat;
  const envScene = new THREE.Scene();
  // env map: same sky, ambient kept at the tuned level (built directly: clone() would try to copy the render-target texture uniform)
  const envMat = new THREE.ShaderMaterial({ uniforms: Object.assign({ uSunDisk: { value: 0 }, uDomeScale: { value: 0.68 } }, uniforms), vertexShader: domeMat.vertexShader, fragmentShader: domeMat.fragmentShader,
    side: domeMat.side, depthWrite: domeMat.depthWrite, fog: false, toneMapped: domeMat.toneMapped });
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), envMat); envSky.scale.setScalar(100); envScene.add(envSky);

  // ---------------------------------------------------------------- per-frame update
  const sunLight = { color: new THREE.Color(1, 1, 1), intensity: 3 };
  const ambient = new THREE.Color(0.3, 0.35, 0.45);
  const Ts = [1, 1, 1], _tmp = [0, 0, 0];
  let bakeKey = '', frame = 0, lastBakeT = -1;
  // CPU sky radiance for a direction (same model, fewer samples) -> ambient light colour
  function cpuScatter(h0, dx, dy, dz, sd, bMs, bMe, out) {
    const ro = [0, Rg + Math.max(h0, 1), 0]; const b = ro[1] * dy; const cT = ro[1] * ro[1] - Rt * Rt; const tTop = -b + Math.sqrt(b * b - cT);
    let t1 = tTop; const cG = ro[1] * ro[1] - Rg * Rg; const dg = b * b - cG; if (dy < 0 && dg > 0 && -b - Math.sqrt(dg) > 0) t1 = -b - Math.sqrt(dg);
    const N = 16; let sR = [0, 0, 0], sM = [0, 0, 0], oR = 0, oM = 0, oO = 0;
    for (let i = 0; i < N; i++) {
      const a0 = i / N, a1 = (i + 1) / N, ta0 = t1 * a0 * a0, ta1 = t1 * a1 * a1, dt = ta1 - ta0, tm = 0.5 * (ta0 + ta1);
      const px = dx * tm, py = ro[1] + dy * tm, pz = dz * tm, r = Math.hypot(px, py, pz), h = r - Rg;
      const dR = Math.exp(-h / HR) * dt, dM = Math.exp(-h / HM) * dt, dO = Math.max(0, 1 - Math.abs(h - 25000) / 15000) * dt;
      const mR = oR + dR / 2, mM = oM + dM / 2, mO = oO + dO / 2; oR += dR; oM += dM; oO += dO;
      odAt(h, (px * sd.x + py * sd.y + pz * sd.z) / r, _od);
      for (let c = 0; c < 3; c++) { const att = Math.exp(-(BR[c] * (mR + _od[0]) + bMe * (mM + _od[1]) + BO[c] * (mO + _od[2]))); sR[c] += dR * att; sM[c] += dM * att; }
    }
    const mu = dx * sd.x + dy * sd.y + dz * sd.z; const pR = 0.0596831 * (1 + mu * mu); const g = 0.76, g2 = g * g; const pM = 0.1193662 * ((1 - g2) * (1 + mu * mu)) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * mu, 1.5));
    for (let c = 0; c < 3; c++) out[c] = SUN_E * (sR[c] * BR[c] * pR + sM[c] * bMs * pM) * SKY_GAIN;
    return out;
  }
  const _a = [0, 0, 0], _b = [0, 0, 0], _c = [0, 0, 0];
  function update(dt, camPos) {
    frame++;
    const st = Env.state; const sd = Env.sunDir;
    // daily weather + override
    const ymd = Env.serviceDay().ymd;
    if (ymd !== weather.ymd) { Object.assign(weather, dailyWeather(ymd), { ymd }); }
    const kind = st.weather || 'auto'; let wFog = weather.fog, wClouds = weather.clouds, wCirrus = weather.cirrus, wHaze = weather.haze;
    if (kind === 'clear') { wFog = 0; wClouds = 0.05; wCirrus = 0.15; wHaze = 1.2; }
    else if (kind === 'fog') { wFog = 1; wHaze = Math.max(wHaze, 2.5); }
    else if (kind === 'cloudy') { wClouds = 0.72; wCirrus = 0.5; wHaze = Math.max(wHaze, 2.6); }
    else if (kind === 'haze') { wHaze = 5; }
    weather.kind = kind; st.wx = { fog: wFog, clouds: wClouds, cirrus: wCirrus, haze: wHaze };
    const bMs = MIE_BASE * wHaze, bMe = bMs / 0.9;
    uniforms.uSkyBMs.value = bMs; uniforms.uSkyBMe.value = bMe;
    uniforms.uSkySunDir.value.copy(sd); uniforms.uSkyMoonDir.value.copy(st.moonDir || sd);
    const camH = Math.max(1, camPos.y); uniforms.uSkyCamH.value = camH;
    // sun irradiance at the camera (reddened near the horizon), for the DirectionalLight and in shaders
    transmittance(Math.min(camH, 3000), sd.y, bMe, Ts);
    const up = U.smooth(-0.035, 0.03, sd.y);
    const SUN_SCENE = 3.1;   // scene-unit irradiance of the overhead sun (matches the old tuning)
    const lum = 0.2126 * Ts[0] + 0.7152 * Ts[1] + 0.0722 * Ts[2];
    const mx = Math.max(Ts[0], Ts[1], Ts[2], 1e-6);
    sunLight.color.setRGB(Ts[0] / mx, Ts[1] / mx, Ts[2] / mx);
    sunLight.intensity = SUN_SCENE * up * Math.min(1, lum / 0.82) * (0.95 + 0.05 * wHaze / 2.2);
    uniforms.uSkySunColor.value.set(Ts[0] * SUN_SCENE * up, Ts[1] * SUN_SCENE * up, Ts[2] * SUN_SCENE * up);
    // sky fill: average of zenith + four horizon directions from the model
    cpuScatter(camH, 0, 1, 0, sd, bMs, bMe, _a);
    let hx = [0, 0, 0]; for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { cpuScatter(camH, x * 0.94, 0.34, z * 0.94, sd, bMs, bMe, _b); for (let c = 0; c < 3; c++) hx[c] += _b[c] / 4; }
    const night = st.night; const moonUp = U.smooth(-0.05, 0.3, (st.moonDir || sd).y) * (st.moonPhase !== undefined ? st.moonPhase : 0.7);
    uniforms.uSkyMoon.value = moonUp;
    ambient.setRGB(_a[0] * 0.4 + hx[0] * 0.6 + night * 0.012, _a[1] * 0.4 + hx[1] * 0.6 + night * 0.017, _a[2] * 0.4 + hx[2] * 0.6 + night * 0.03);
    uniforms.uSkyAmbient.value.set(ambient.r, ambient.g, ambient.b);
    // city glow (sodium + LED) at night; stronger under the marine layer
    const glow = 1 + wFog * 0.8;
    uniforms.uSkyGlow.value.set(0.055 * glow, 0.034 * glow, 0.018 * glow);
    // clouds & wind drift (from the WNW, ~6 m/s, like the sea breeze)
    uniforms.uCloudCover.value = wClouds; uniforms.uCirrus.value = wCirrus;
    const tw = Env.time.sec + (+ymd.slice(6, 8)) * 86400;
    uniforms.uCloudOfs.value.set(tw * 6 / 11000 * 0.8, tw * 6 / 11000 * 0.35);
    // marine layer
    const fs = fogSchedule(Env.time.sec, wFog);
    uniforms.uFogTop.value = fs.top; uniforms.uFogDist.value = fs.dist; uniforms.uFogDens.value = wFog > 0.02 ? 0.4 + 0.8 * wFog : 0;
    uniforms.uFogOfs.value.set(tw * 3.2 / 2600, tw * 0.15 / 700, tw * 1.1 / 2600);
    if (debug.fogDens !== undefined) uniforms.uFogDens.value = debug.fogDens;
    if (debug.clouds !== undefined) uniforms.uCloudCover.value = debug.clouds;
    if (!fogMapReady && frame % 30 === 1) { try { if (typeof Terrain !== 'undefined' && Terrain.h(-29560, -31710) > 150) rebuildFogMap(); } catch (e) { fogMapReady = true; } }
    // re-bake the sky when the sun, weather or camera altitude bucket changed (cheap: 512x256 pass)
    const key = [Math.round(sd.x * 800), Math.round(sd.y * 800), Math.round(sd.z * 800), Math.round(wHaze * 10), Math.round(Math.log2(camH + 1) * 4), Math.round(night * 40), Math.round(moonUp * 20)].join('/');
    if (key !== bakeKey) { bakeKey = key; bake(); }
  }
  return {
    uniforms, glsl, glslFx, update, rebuildFogMap, sunLight, ambient, weather, envScene, domeMat, debug,
    transmittance: (h, mu, out = [0, 0, 0]) => transmittance(h, mu, uniforms.uSkyBMe.value, out),
    get fogMapReady() { return fogMapReady; }, WORLD, SKY_GAIN,
  };
})();
