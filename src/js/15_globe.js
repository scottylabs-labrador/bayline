// Globe: the rest of the planet. Worldwide elevation (AWS Terrain Tiles, terrarium) and imagery (USGS NAIP inside
// the US, EOX Sentinel-2 cloudless elsewhere) stream as web-mercator tiles around the camera into a chunked-LOD
// quadtree, drawn in the current flat frame (the curvature is added by the shader bend, see BEND_GLSL). In the Bay
// frame the globe fills everything outside the Bayline square, whose own terrain is far more detailed; in any
// other frame it is the whole world.
//   Globe.frame                 { lat0, lon0, mlat, mlon, bay, id }: x = (lon - lon0) mlon, z = -(lat - lat0) mlat
//   Globe.ll2w(lat, lon) / w2ll(x, z)
//   Globe.setFrame(lat, lon)    rebase to a new origin (Bay frame when within reach of the Peninsula)
//   Globe.inBayline(x, z)       inside the area the Bayline terrain draws (the square, plus the north strip when
//                               its tiles are published: Terrain.area), in the Bay frame
//   Globe.inSquare(x, z)        inside the original Bayline square (102.4 km) of the Bay frame
//   Globe.h(x, z)               ground height (m, sea level clamps water) from the finest loaded elevation tile
//   Globe.ensure(x, z)          promise: full-detail elevation around a point (for spawning)
//   Globe.update(camera)        per frame
// Sources and terms: notes/flight.md.
const Globe = (() => {
  const DEG = Math.PI / 180, CIRC = 40075016.686, K = U.BEND_K;
  const N = 32, NV = (N + 1) * (N + 1);                 // quads per tile side, grid vertices
  const HZ_MAX = 14, SIZE = 256;                        // terrarium: finest zoom used, pixels per tile
  const BX0 = -45056, BZ0 = -49152, BS = 102400;        // the Bayline square (Bay frame)
  // the area the Bayline terrain draws and the globe leaves to it: the square, extended north over the Bayline Metro
  // strip when its tiles are published (set from Terrain.area at init; see notes/bart/world.md)
  const EX = [BX0, BZ0, BX0 + BS, BZ0 + BS];
  const group = new THREE.Group(); group.name = 'globe'; group.layers.enable(1);
  const stats = { nodes: 0, drawn: 0, hTiles: 0, iTiles: 0, loading: 0, built: 0, fails: 0 };

  // ------------------------------------------------------------------ frame
  function mPerDeg(lat) { const p = lat * DEG; return [111132.954 - 559.822 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p), 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p)]; }
  const frame = { lat0: Geo.LAT0, lon0: Geo.LON0, mlat: Geo.MLAT, mlon: Geo.MLON, bay: true, id: 0 };
  const ll2w = (lat, lon) => ({ x: (lon - frame.lon0) * frame.mlon, z: -(lat - frame.lat0) * frame.mlat });
  const w2ll = (x, z) => ({ lat: frame.lat0 - z / frame.mlat, lon: frame.lon0 + x / frame.mlon });
  const inBayline = (x, z) => frame.bay && x > EX[0] && x < EX[2] && z > EX[1] && z < EX[3];
  const inSquare = (x, z) => frame.bay && x > BX0 && x < BX0 + BS && z > BZ0 && z < BZ0 + BS;
  const frameListeners = [];
  function setFrame(lat, lon) {
    const bay = Math.hypot((lat - Geo.LAT0) * Geo.MLAT, (lon - Geo.LON0) * Geo.MLON) < 160000;
    const old = { ...frame };
    if (bay) Object.assign(frame, { lat0: Geo.LAT0, lon0: Geo.LON0, mlat: Geo.MLAT, mlon: Geo.MLON, bay: true });
    else { const [ma, mo] = mPerDeg(lat); Object.assign(frame, { lat0: lat, lon0: lon, mlat: ma, mlon: mo, bay: false }); }
    frame.id++;
    for (const f of frameListeners) f(frame, old);
    return frame;
  }
  const onFrame = (f) => frameListeners.push(f);
  // keep the anchor (camera or aircraft) near the frame origin: flat-frame distortion stays < ~1.5 %
  function maybeRebase(p) {
    const d = Math.hypot(p.x, p.z); if (!Number.isFinite(d)) return false;
    if (frame.bay) { if (d < 175000) return false; }
    else if (d < 150000) { const ll = w2ll(p.x, p.z); if (Math.hypot((ll.lat - Geo.LAT0) * Geo.MLAT, (ll.lon - Geo.LON0) * Geo.MLON) > 140000) return false; }
    const ll = w2ll(p.x, p.z); setFrame(ll.lat, ll.lon); return true;
  }

  // ------------------------------------------------------------------ web mercator
  const lonOf = (x, z) => x / 2 ** z * 360 - 180;
  const latOf = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) / DEG;
  const tx = (lon, z) => (lon + 180) / 360 * 2 ** z;
  const ty = (lat, z) => { const r = U.clamp(lat, -85.05, 85.05) * DEG; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
  const key = (z, x, y) => z * 1e10 + y * 1e5 + x;

  // imagery: USGS (public domain NAIP, to z16) inside the US, EOX Sentinel-2 cloudless 2025 (10 m, to z14) elsewhere
  const inUS = (lat, lon) => (lat > 24.3 && lat < 49.1 && lon > -125.2 && lon < -66.7) || (lat > 51.2 && lat < 71.5 && lon > -179.9 && lon < -129.9)
    || (lat > 18.8 && lat < 22.4 && lon > -160.4 && lon < -154.7) || (lat > 17.8 && lat < 18.6 && lon > -67.4 && lon < -65.2);
  const URL_USGS = (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`;
  const URL_EOX = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/${z}/${y}/${x}.jpg`;
  const URL_DEM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  // city lights at night: NASA GIBS VIIRS Black Marble (public domain), to z8
  const URL_NIGHT = (z, x, y) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/${z}/${y}/${x}.png`;

  // ------------------------------------------------------------------ fetch scheduler (its own lanes: other hosts)
  const Q = []; let active = 0; const MAXA = 12;
  function schedule(job) { Q.push(job); pump(); return job; }
  function pump() {
    while (active < MAXA && Q.length) {
      let bi = 0; for (let i = 1; i < Q.length; i++) if (Q[i].prio < Q[bi].prio) bi = i;
      const j = Q.splice(bi, 1)[0]; if (j.cancelled) continue;
      active++; stats.loading = active;
      j.run().catch(() => {}).finally(() => { active--; stats.loading = active; pump(); });
    }
  }
  async function fetchBlob(url) {
    for (let a = 0; a < 3; a++) {
      const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (r.status === 404) { const e = new Error('404'); e.notFound = true; throw e; }
      if (r.ok) return r.blob();
      await new Promise(res => setTimeout(res, 400 * (a + 1) * (a + 1)));
    }
    throw new Error('fetch failed ' + url);
  }

  // ------------------------------------------------------------------ elevation tiles (CPU, also for physics)
  const hrec = new Map(); let hctx = null;
  function heightRec(z, x, y) { return hrec.get(key(z, x, y)); }
  function needH(z, x, y, prio) {
    const k = key(z, x, y); let r = hrec.get(k);
    if (r) { r.used = frameNo; if (r.job && r.state === 1 && prio < r.job.prio) r.job.prio = prio; return r; }
    r = { z, x, y, state: 1, used: frameNo, h: null, mn: 0, mx: 0 }; hrec.set(k, r);
    r.job = schedule({ prio, run: async () => {
      try {
        const blob = await fetchBlob(URL_DEM(z, x, y));
        const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        if (!hctx) hctx = new OffscreenCanvas(SIZE, SIZE).getContext('2d', { willReadFrequently: true });
        hctx.clearRect(0, 0, SIZE, SIZE); hctx.drawImage(bmp, 0, 0); bmp.close && bmp.close();
        const px = hctx.getImageData(0, 0, SIZE, SIZE).data, h = new Float32Array(SIZE * SIZE); let mn = 1e9, mx = -1e9;
        for (let i = 0, j = 0; i < h.length; i++, j += 4) { const v = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768; h[i] = v; if (v < mn) mn = v; if (v > mx) mx = v; }
        r.h = h; r.mn = mn; r.mx = mx; r.state = 2; stats.hTiles++;
      } catch (e) { r.state = 3; stats.fails++; }
    } });
    return r;
  }
  // finest ready elevation tile at or above (z, x, y), at most HZ_MAX
  function bestH(z, x, y) {
    let zz = Math.min(z, HZ_MAX), xx = x >> (z - zz), yy = y >> (z - zz);
    for (; zz >= 0; zz--, xx >>= 1, yy >>= 1) { const r = hrec.get(key(zz, xx, yy)); if (r && r.state === 2) { r.used = frameNo; return r; } }
    return null;
  }
  // bilinear sample of a record at mercator-tile coordinates (fx, fy) of zoom r.z
  function sampleRec(r, fx, fy) {
    let u = (fx - r.x) * SIZE - 0.5, v = (fy - r.y) * SIZE - 0.5;
    u = u < 0 ? 0 : u > SIZE - 1.001 ? SIZE - 1.001 : u; v = v < 0 ? 0 : v > SIZE - 1.001 ? SIZE - 1.001 : v;
    const i = u | 0, j = v | 0, a = u - i, b = v - j, k = j * SIZE + i, H = r.h;
    return (H[k] * (1 - a) + H[k + 1] * a) * (1 - b) + (H[k + SIZE] * (1 - a) + H[k + SIZE + 1] * a) * b;
  }
  const seaClamp = (h) => h < 0 ? 0 : h;               // oceans (bathymetry) sit at sea level
  function hAt(lat, lon) {
    for (let z = HZ_MAX; z >= 0; z--) {
      const fx = tx(lon, z), fy = ty(lat, z); const r = hrec.get(key(z, Math.floor(fx), Math.floor(fy)));
      if (r && r.state === 2) { let v = sampleRec(r, fx, fy); if (v > 0 && typeof Airports !== 'undefined') { const F = Airports.runwaysIn(lat - 1e-4, lat + 1e-4, lon - 1e-4, lon + 1e-4); if (F) v = Airports.flattenH(F, lat, lon, v); } return seaClamp(v); }
    }
    return 0;
  }
  function h(x, z) { const ll = w2ll(x, z); return hAt(ll.lat, ll.lon); }
  function ensure(x, z, zoom = 13) {
    const ll = w2ll(x, z); const X = Math.floor(tx(ll.lon, zoom)), Y = Math.floor(ty(ll.lat, zoom));
    const r = needH(zoom, X, Y, -1);
    return new Promise((res) => { const t0 = performance.now(); const f = () => { if (r.state >= 2 || performance.now() - t0 > 15000) res(r.state === 2); else setTimeout(f, 60); }; f(); });
  }

  // ------------------------------------------------------------------ imagery tiles (GPU)
  const irec = new Map(); let maxAniso = 8; let actx = null, cctx = null;
  // how much of a bitmap is transparent (USGS leaves no-data areas, e.g. the ocean, transparent)
  function transparency(bmp) {
    if (!actx) actx = new OffscreenCanvas(16, 16).getContext('2d', { willReadFrequently: true });
    actx.clearRect(0, 0, 16, 16); actx.drawImage(bmp, 0, 0, 16, 16);
    const d = actx.getImageData(0, 0, 16, 16).data; let t = 0; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) t++;
    return t / 256;
  }
  async function eoxBitmap(z, x, y) {           // EOX for (z, x, y); beyond z14 the z14 ancestor, cropped and scaled
    const ez = Math.min(z, 14), d = z - ez, blob = await fetchBlob(URL_EOX(ez, x >> d, y >> d));
    const bmp = await createImageBitmap(blob); if (!d) return bmp;
    const s = SIZE >> d, sx = (x - ((x >> d) << d)) * s, sy = (y - ((y >> d) << d)) * s;
    const out = await createImageBitmap(bmp, sx, sy, s, s, { resizeWidth: SIZE, resizeHeight: SIZE, resizeQuality: 'high' }); bmp.close && bmp.close(); return out;
  }
  function needI(z, x, y, prio, us) {
    const k = key(z, x, y); let r = irec.get(k);
    if (r) { r.used = frameNo; if (r.job && r.state === 1 && prio < r.job.prio) r.job.prio = prio; return r; }
    r = { z, x, y, state: 1, used: frameNo, tex: null }; irec.set(k, r);
    r.job = schedule({ prio, run: async () => {
      let bmp = null;
      if (us && z <= 16) {
        try {
          const b = await createImageBitmap(await fetchBlob(URL_USGS(z, x, y)));
          const t = transparency(b);
          if (t > 0.97) { b.close && b.close(); }                    // no data here (ocean, border): Sentinel-2
          else if (t > 0.002) {                                      // coast: USGS over Sentinel-2
            try {
              const e = await eoxBitmap(z, x, y);
              if (!cctx) cctx = new OffscreenCanvas(SIZE, SIZE).getContext('2d');
              cctx.clearRect(0, 0, SIZE, SIZE); cctx.drawImage(e, 0, 0, SIZE, SIZE); cctx.drawImage(b, 0, 0, SIZE, SIZE);
              bmp = await createImageBitmap(cctx.canvas); e.close && e.close(); b.close && b.close(); r.src = 'mix';
            } catch (err) { bmp = b; r.src = 'usgs'; }
          } else { bmp = b; r.src = 'usgs'; }
        } catch (e) { bmp = null; }
      }
      if (!bmp) { try { bmp = await eoxBitmap(z, x, y); r.src = 'eox'; } catch (e) { bmp = null; } }
      if (!bmp) { r.state = 3; return; }
      const t = new THREE.Texture(bmp); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = maxAniso; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.onUpdate = () => { if (bmp.close) bmp.close(); t.onUpdate = null; };
      t.needsUpdate = true; r.tex = t; r.state = 2; stats.iTiles++;
    } });
    return r;
  }
  // night lights (only fetched once the sun is down)
  const nrec = new Map();
  function needN(z, x, y, prio) {
    const k = key(z, x, y); let r = nrec.get(k);
    if (r) { r.used = frameNo; return r; }
    r = { z, x, y, state: 1, used: frameNo, tex: null }; nrec.set(k, r);
    r.job = schedule({ prio: prio + 2, run: async () => {
      try { const bmp = await createImageBitmap(await fetchBlob(URL_NIGHT(z, x, y)));
        const t = new THREE.Texture(bmp); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        t.onUpdate = () => { if (bmp.close) bmp.close(); t.onUpdate = null; }; t.needsUpdate = true; r.tex = t; r.state = 2;
      } catch (e) { r.state = 3; }
    } });
    return r;
  }
  function bestN(z, x, y) { let zz = z, xx = x, yy = y; for (; zz >= 0; zz--, xx >>= 1, yy >>= 1) { const r = nrec.get(key(zz, xx, yy)); if (r && r.state === 2) { r.used = frameNo; return r; } } return null; }
  function bestI(z, x, y) {
    let zz = z, xx = x, yy = y;
    for (; zz >= 0; zz--, xx >>= 1, yy >>= 1) { const r = irec.get(key(zz, xx, yy)); if (r && r.state === 2) { r.used = frameNo; return r; } }
    return null;
  }

  // ------------------------------------------------------------------ shared index buffer (grid + skirts)
  let indexAttr = null;
  function makeIndex() {
    const idx = [], V = N + 1;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * V + i, b = a + 1, c = a + V, d = c + 1; idx.push(a, c, b, b, c, d); }
    const ring = []; for (let i = 0; i < N; i++) ring.push(i); for (let j = 0; j < N; j++) ring.push(j * V + N);
    for (let i = N; i > 0; i--) ring.push(N * V + i); for (let j = N; j > 0; j--) ring.push(j * V);
    for (let k = 0; k < ring.length; k++) { const a = ring[k], b = ring[(k + 1) % ring.length], a2 = NV + k, b2 = NV + (k + 1) % ring.length; idx.push(a, b, a2, b, b2, a2); }
    indexAttr = new THREE.Uint32BufferAttribute(idx, 1);
    return ring;
  }
  let RING = null;

  // ------------------------------------------------------------------ material
  const shared = { uExcl: { value: new THREE.Vector4(BX0, BZ0, BX0 + BS, BZ0 + BS) }, uExclOn: { value: 1 }, night: U.uNight,
    uWaveN: { value: null }, uWindW: U.uWind, uWaveT: U.uTime, uDebug: { value: 0 }, uGround: { value: null },
    uBayW: { value: null }, uBayR: { value: new THREE.Vector4(0, 0, 1, 1) }, uBayOn: { value: 0 } };
  // ---- inland / bay water around the Bayline area (tiles/globe/baywater.png, tools/metro_world/globe_water.py): the
  // sediment-brown bays north and east of it (San Pablo, Carquinez, Suisun, the Delta) fail the photo's water test, and the
  // ocean surf would run through them; in the Bay frame the raster marks them as calm bay water (world workstream)
  let bayInfo = null;
  function bayWater() {
    if (bayInfo || typeof Stream === 'undefined') return;
    bayInfo = { loading: true };
    Promise.all([Stream.json('tiles/globe/baywater.json', 3), Stream.image('tiles/globe/baywater.png', 3)]).then(([j, bmp]) => {
      const t = new THREE.Texture(bmp); t.flipY = false; t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
      bayInfo = { bbox: j.bbox }; shared.uBayW.value = t; bayFrame();
    }, () => {});
  }
  function bayFrame() {
    if (!bayInfo || !bayInfo.bbox || !shared.uBayW.value) { shared.uBayOn.value = 0; return; }
    const [w, s, e, n] = bayInfo.bbox, a = ll2w(n, w), b = ll2w(s, e);
    shared.uBayR.value.set(a.x, a.z, b.x, b.z); shared.uBayOn.value = frame.bay ? 1 : 0;
  }
  function makeMaterial() {
    if (!shared.uWaveN.value && Terrain.waveTexture) shared.uWaveN.value = Terrain.waveTexture();
    if (!shared.uGround.value && Terrain.groundDetail) shared.uGround.value = Terrain.groundDetail();
    const u = Object.assign({ iTex: { value: null }, iUV: { value: new THREE.Vector4(0, 0, 1, 1) }, iHas: { value: 0 }, iTexel: { value: 10 }, iEox: { value: 1 },
      nTex: { value: null }, nUV: { value: new THREE.Vector4(0, 0, 1, 1) }, nHas: { value: 0 } }, shared);
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0, envMapIntensity: 0.5 });
    m.userData.u = u; m.customProgramCacheKey = () => 'bayline-globe-v5';
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aH; varying vec3 vGW; varying vec2 vGUv; varying float vGH; varying vec3 vGN;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvGUv = uv; vGH = aH;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz; vGN = normalize(mat3(modelMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D iTex; uniform vec4 iUV; uniform float iHas; uniform vec4 uExcl; uniform float uExclOn; uniform float night; uniform float uDebug;
          uniform sampler2D uGround; uniform float iTexel; uniform float iEox; uniform sampler2D nTex; uniform vec4 nUV; uniform float nHas;
          uniform sampler2D uBayW; uniform vec4 uBayR; uniform float uBayOn;
          float gh1(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
          float gn1(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(gh1(i), gh1(i+vec2(1,0)), f.x), mix(gh1(i+vec2(0,1)), gh1(i+vec2(1,1)), f.x), f.y); }
          varying vec3 vGW; varying vec2 vGUv; varying float vGH; varying vec3 vGN; vec3 gGN; float gGRough; float gGWater;
          ${Terrain.WATER_GLSL ? Terrain.WATER_GLSL() : ''}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            if (uExclOn > 0.5 && vGW.x > uExcl.x && vGW.x < uExcl.z && vGW.z > uExcl.y && vGW.z < uExcl.w) discard;   // Bayline draws here
            float fwq = fwidth(vGW.x) + fwidth(vGW.z), depth = clamp(-vGH, 0.0, 30.0), fwDepth = fwidth(depth);
            vec3 col = iHas > 0.5 ? texture2D(iTex, iUV.xy + vGUv * iUV.zw).rgb : vec3(0.18, 0.2, 0.16);
            // Sentinel-2 mosaics are darker and cooler than the colour-balanced NAIP the Bayline square uses
            col = mix(col, pow(col, vec3(0.88)) * vec3(1.34, 1.3, 1.2), iEox);
            // water: at or below sea level (bathymetry) and water-coloured in the photo (polders stay land)
            vec3 pc = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
            float lum = dot(pc, vec3(0.299, 0.587, 0.114));
            float blu = smoothstep(-0.02, 0.06, pc.b - pc.r) * (1.0 - smoothstep(0.42, 0.62, lum));
            gGWater = (1.0 - smoothstep(-0.2, 0.6, vGH)) * max(blu, 1.0 - smoothstep(0.1, 0.22, lum));
            // open sea (the bathymetry well below sea level): hazy or glinting photo strips of the ocean are water too (a
            // bluish photo is enough; below-sea-level land is brown or white)
            gGWater = max(gGWater, smoothstep(-4.0, -12.0, vGH) * smoothstep(-0.05, 0.03, pc.b - pc.r));
            float bayK = 0.0;                           // mapped bay / inland water near sea level (Bay frame only)
            if (uBayOn > 0.5) { vec2 bq = (vGW.xz - uBayR.xy) / (uBayR.zw - uBayR.xy);
              if (bq.x > 0.0 && bq.x < 1.0 && bq.y > 0.0 && bq.y < 1.0) { bayK = smoothstep(0.35, 0.75, texture2D(uBayW, bq).r) * (1.0 - smoothstep(0.4, 2.5, vGH)); gGWater = max(gGWater, bayK); }
              // one bay-water tone (the balanced NAIP of the Bayline bays) instead of the imagery tiles' patchwork of
              // acquisition dates, kept a little of the photo's own variation (sediment plumes, channels)
              col = mix(col, vec3(0.29, 0.35, 0.34) * (0.85 + 0.3 * smoothstep(0.1, 0.45, lum)), bayK * 0.85);
              depth = mix(depth, min(depth, 2.5), bayK); }    // (the DEM tiles' bathymetry differs tile to tile: shallow bay tone)
            // non-bay water off the shore shades at least 15 m deep, like the Bayline terrain's ocean next to it (the surf
            // zone, above -0.5 m, keeps its own depth)
            depth = max(depth, 15.0 * (1.0 - bayK) * smoothstep(-0.5, -3.0, vGH));
            gGN = normalize(vGN); gGRough = 0.93;
            // close to the ground a Sentinel-2 pixel (5-10 m) covers many screen pixels: add real surface texture (grass,
            // soil, asphalt, concrete from the Bayline detail set) tinted by the photo, plus metre-scale variation,
            // fading in only as the image gets magnified
            vec2 q = vGW.xz; vec2 qdx = dFdx(q), qdy = dFdy(q);
            float mag = 1.0 - smoothstep(0.35, 1.2, fwq / max(iTexel, 0.5));
            if (mag > 0.01 && gGWater < 0.5) {
              vec4 gd = mix(textureGrad(uGround, q / 2.5, qdx / 2.5, qdy / 2.5), textureGrad(uGround, q / 7.3 + 0.37, qdx / 7.3, qdy / 7.3), 0.4) - 0.5;
              float sat = (max(pc.r, max(pc.g, pc.b)) - min(pc.r, min(pc.g, pc.b))) / max(lum, 0.03);
              float veg = smoothstep(-0.01, 0.04, pc.g - max(pc.r * 0.97, pc.b)), grey = 1.0 - smoothstep(0.1, 0.24, sat);
              float det = mix(mix(gd.g * 1.8, (lum < 0.3 ? gd.r * 1.8 : gd.a * 1.4), grey), gd.b * 1.9, veg * (1.0 - grey * 0.6));
              float fwn = fwq;
              float v1 = mix(0.5, gn1(q / 6.0), 1.0 - smoothstep(1.5, 5.0, fwn)), v2 = mix(0.5, gn1(q / 1.7 + 3.1), 1.0 - smoothstep(0.4, 1.5, fwn));
              col *= 1.0 + mag * (det + (v1 - 0.5) * 0.22 + (v2 - 0.5) * 0.14);
            }
            #ifdef BL_WATER
            if (gGWater > 0.0) blWater(vGW.xz, depth, gGWater, fwq, fwDepth, gGWater * (1.0 - bayK), 1.0, col, gGN, gGRough);
            #endif
            diffuseColor.rgb = col;
            if (uDebug > 0.5) diffuseColor.rgb = uDebug < 1.5 ? vec3(gGWater, clamp(vGH / 50.0, 0.0, 1.0), clamp(-vGH / 50.0, 0.0, 1.0)) : vec3(iUV.z < 0.99 ? 1.0 : 0.0, iHas, 0.0);
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          if (nHas > 0.5 && night > 0.02) {
            // city lights from VIIRS (~500 m pixels): a smooth glow from altitude, resolved into a jittered grid of
            // street lamps as the ground gets close
            vec3 nl = texture2D(nTex, nUV.xy + vGUv * nUV.zw).rgb;
            float lum = dot(nl, vec3(0.3, 0.55, 0.15)), L = clamp((lum - 0.05) / 0.85, 0.0, 1.0);   // above the dark land and blue snow
            float fwq2 = fwidth(vGW.x) + fwidth(vGW.z), fp = fwq2 / 34.0;
            vec2 cp = vGW.xz / 34.0, cell = floor(cp); vec2 f = fract(cp) - 0.5 - (vec2(gh1(cell), gh1(cell + 7.1)) - 0.5) * 0.7;
            float s0 = 0.045, sg = max(s0, fp * 0.45);                                  // energy-conserving lamp footprint
            float lamp = exp(-dot(f, f) / (2.0 * sg * sg)) * (s0 * s0) / (sg * sg) * step(1.0 - L * 0.85, gh1(cell + 3.3));
            vec3 warm = mix(vec3(1.0, 0.6, 0.28), vec3(1.0, 0.84, 0.62), gh1(cell + 1.7));
            vec3 glow = warm * pow(L, 1.4) * 0.075, pts = warm * (lamp * (0.6 + L) * 2.4 + L * 0.01);
            totalEmissiveRadiance += mix(pts, glow, smoothstep(0.35, 0.9, fp)) * night * (1.0 - gGWater);
          }`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gGRough;')
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(gGN, 0.0)).xyz);`)
        .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
          #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
            radiance *= 1.0 + gGWater;
          #endif`);
    };
    return m;
  }

  // ------------------------------------------------------------------ nodes
  const nodes = new Map(); let frameNo = 0;
  function nodeBounds(z, x, y) { return { lonW: lonOf(x, z), lonE: lonOf(x + 1, z), latN: latOf(y, z), latS: latOf(y + 1, z) }; }
  function getNode(z, x, y) {
    const k = key(z, x, y); let n = nodes.get(k);
    if (!n) {
      const b = nodeBounds(z, x, y);
      n = { k, z, x, y, ...b, lonC: (b.lonW + b.lonE) / 2, latC: latOf(y + 0.5, z), mesh: null, hKey: -1, iKey: -1, used: frameNo, built: 0 };
      nodes.set(k, n);
    }
    n.used = frameNo; return n;
  }
  // (re)build the grid of a node from the best elevation tile available
  function build(n, hr) {
    const V = N + 1, cx = (n.lonC - frame.lon0) * frame.mlon, cz = -(n.latC - frame.lat0) * frame.mlat;
    const sz = 2 ** n.z, geo = n.mesh ? n.mesh.geometry : new THREE.BufferGeometry();
    const pos = new Float32Array((NV + 4 * N) * 3), nrm = new Float32Array((NV + 4 * N) * 3), uv = new Float32Array((NV + 4 * N) * 2), wat = new Float32Array(NV + 4 * N);   // wat: raw height (bathymetry)
    const lats = new Float64Array(V); for (let j = 0; j < V; j++) lats[j] = latOf(n.y + j / N, n.z);
    const F = n.z >= 11 && typeof Airports !== 'undefined' ? Airports.runwaysIn(n.latS, n.latN, n.lonW, n.lonE) : null;   // flatten under runways
    let mn = 1e9, mx = -1e9;
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const k = j * V + i, lon = n.lonW + (n.lonE - n.lonW) * i / N, lat = lats[j];
      let hv = 0;
      if (hr) { const d = n.z - hr.z; const s = d >= 0 ? 1 / (1 << d) : (1 << -d); hv = sampleRec(hr, (n.x + i / N) * s, (n.y + j / N) * s); }
      if (F && hv > 0) hv = Airports.flattenH(F, lat, lon, hv);
      wat[k] = hv;
      const y = seaClamp(hv); if (y < mn) mn = y; if (y > mx) mx = y;
      pos[k * 3] = (lon - frame.lon0) * frame.mlon - cx; pos[k * 3 + 1] = y; pos[k * 3 + 2] = -(lat - frame.lat0) * frame.mlat - cz;
      uv[k * 2] = i / N; uv[k * 2 + 1] = j / N;
    }
    // normals from the grid (central differences in metres)
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const k = j * V + i, il = Math.max(i - 1, 0), ir = Math.min(i + 1, N), jd = Math.max(j - 1, 0), ju = Math.min(j + 1, N);
      const kl = j * V + il, kr = j * V + ir, kd = jd * V + i, ku = ju * V + i;
      const dx = pos[kr * 3] - pos[kl * 3], dhx = pos[kr * 3 + 1] - pos[kl * 3 + 1], dz = pos[ku * 3 + 2] - pos[kd * 3 + 2], dhz = pos[ku * 3 + 1] - pos[kd * 3 + 1];
      let nx = -dhx / (dx || 1), nz = -dhz / (dz || 1), ny = 1; const l = Math.hypot(nx, ny, nz); nrm[k * 3] = nx / l; nrm[k * 3 + 1] = ny / l; nrm[k * 3 + 2] = nz / l;
    }
    // skirts hide cracks between neighbours of different detail
    const tile = CIRC * Math.cos(n.latC * DEG) / sz, skirt = Math.min(2000, tile * 0.015 + 15);
    for (let r = 0; r < RING.length; r++) { const s = RING[r], d = NV + r;
      pos[d * 3] = pos[s * 3]; pos[d * 3 + 1] = pos[s * 3 + 1] - skirt; pos[d * 3 + 2] = pos[s * 3 + 2];
      nrm[d * 3] = nrm[s * 3]; nrm[d * 3 + 1] = nrm[s * 3 + 1]; nrm[d * 3 + 2] = nrm[s * 3 + 2]; uv[d * 2] = uv[s * 2]; uv[d * 2 + 1] = uv[s * 2 + 1]; wat[d] = wat[s]; }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setAttribute('aH', new THREE.BufferAttribute(wat, 1));
    geo.setIndex(indexAttr); geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (mn + mx) / 2, 0), tile * 0.9 + (mx - mn) + 100);
    if (!n.mesh) {
      n.mesh = new THREE.Mesh(geo, makeMaterial()); n.mesh.frustumCulled = false; n.mesh.receiveShadow = true; n.mesh.matrixAutoUpdate = false;
      n.mesh.renderOrder = -3; n.mesh.layers.enable(1); group.add(n.mesh);
    }
    n.mn = mn; n.mx = mx; n.hKey = hr ? key(hr.z, hr.x, hr.y) : -1; n.hZ = hr ? hr.z : -1;
    n.mlonB = frame.mlon; n.mlatB = frame.mlat; n.frameId = -1; place(n); stats.built++;
  }
  function place(n) {   // position (and stretch) a built node in the current frame
    if (n.frameId === frame.id) return;
    const m = n.mesh; m.position.set((n.lonC - frame.lon0) * frame.mlon, 0, -(n.latC - frame.lat0) * frame.mlat);
    m.scale.set(frame.mlon / n.mlonB, 1, frame.mlat / n.mlatB); m.updateMatrix(); n.frameId = frame.id;
  }
  function dispose(n) { if (n.mesh) { group.remove(n.mesh); n.mesh.geometry.dispose(); n.mesh.material.dispose(); n.mesh = null; } }

  // ------------------------------------------------------------------ per frame: select, stream, draw
  const lodK = { value: 1.25 };
  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), box = new THREE.Box3();
  let enabled = true, lastLeaves = [];
  function update(cam) {
    if (!enabled) { group.visible = false; return; }
    if (!indexAttr) RING = makeIndex();
    group.visible = true; frameNo++;
    shared.uExclOn.value = frame.bay ? 1 : 0;
    const cp = cam.position, cll = w2ll(cp.x, cp.z);
    const alt = Math.max(cp.y, 5);
    const viewR = Math.min(Math.sqrt(2 * 6371000 * (alt + 3000)) * 1.15 + 20000, 1200000);
    pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); frustum.setFromProjectionMatrix(pm);
    const leaves = []; const stack = [[0, 0, 0]]; const k = lodK.value;
    const zMaxAt = (lat, lon) => inUS(lat, lon) ? 16 : 14;
    while (stack.length) {
      const [z, x, y] = stack.pop();
      const lonW = lonOf(x, z), lonE = lonOf(x + 1, z), latN = latOf(y, z), latS = latOf(y + 1, z);
      // horizontal distance from the camera to the tile (frame metres; far tiles only need the order of magnitude)
      const clat = U.clamp(cll.lat, latS, latN), clon = U.clamp(cll.lon, lonW, lonE);
      const dxm = (clon - cll.lon) * frame.mlon * Math.cos(clat * DEG) / Math.cos(frame.lat0 * DEG), dzm = (clat - cll.lat) * frame.mlat;
      const dh = Math.hypot(dxm, dzm);
      if (dh > viewR) continue;
      const x0 = (lonW - frame.lon0) * frame.mlon, x1 = (lonE - frame.lon0) * frame.mlon, z0 = -(latN - frame.lat0) * frame.mlat, z1 = -(latS - frame.lat0) * frame.mlat;
      if (frame.bay && x0 >= EX[0] && x1 <= EX[2] && z0 >= EX[1] && z1 <= EX[3]) continue;   // wholly Bayline
      const hr = z >= 2 ? bestH(z, x, y) : null; const mn = hr ? seaClamp(hr.mn) : 0, mx = hr ? Math.max(seaClamp(hr.mx), 0) : 4500;
      const dv = Math.max(0, cp.y - mx, mn - cp.y), dist = Math.hypot(dh, dv) + 1;
      const latC = (latN + latS) / 2, size = CIRC * Math.cos(latC * DEG) / 2 ** z;
      // cull against the view (the box drops by the bend at its far side)
      if (z >= 3) {
        const far = Math.hypot(Math.max(Math.abs(x0 - cp.x), Math.abs(x1 - cp.x)), Math.max(Math.abs(z0 - cp.z), Math.abs(z1 - cp.z)));
        box.min.set(x0, mn - 60 - K * far * far, z0); box.max.set(x1, mx + 60, z1);
        if (!frustum.intersectsBox(box)) continue;
      }
      const zmax = zMaxAt(latC, (lonW + lonE) / 2);
      if (z < 3 || (z < zmax && size / dist > k)) { stack.push([z + 1, 2 * x, 2 * y], [z + 1, 2 * x + 1, 2 * y], [z + 1, 2 * x, 2 * y + 1], [z + 1, 2 * x + 1, 2 * y + 1]); continue; }
      leaves.push({ z, x, y, dist, size, latC, lonC: (lonW + lonE) / 2 });
    }
    // draw the leaves with the best data we have; ask for better
    let builds = 0; const buildBudget = 10;
    for (const n of lastLeaves) if (n.mesh) n.mesh.visible = false;
    const drawn = [];
    leaves.sort((a, b) => a.dist - b.dist);
    for (const L of leaves) {
      const n = getNode(L.z, L.x, L.y);
      const prio = L.dist / Math.max(L.size, 1) + L.z * 0.02;
      // elevation: the tile two levels up has 64 px across this node (>= 33 vertices)
      const hz = Math.max(0, Math.min(L.z - 2, HZ_MAX)); const d = L.z - hz;
      needH(hz, L.x >> d, L.y >> d, prio);
      const hr = bestH(L.z, L.x, L.y);
      const hk = hr ? key(hr.z, hr.x, hr.y) : -1;
      if ((!n.mesh || n.hKey !== hk) && (builds < buildBudget || !n.mesh)) { build(n, hr); builds++; }
      if (!n.mesh) continue;
      place(n);
      // imagery
      const us = inUS(L.latC, L.lonC), iz = Math.min(L.z, us ? 16 : 14);
      const id = L.z - iz; needI(iz, L.x >> id, L.y >> id, prio + 0.5, us);
      const ir = bestI(L.z, L.x, L.y); const u = n.mesh.material.userData.u;
      if (ir) { const dd = L.z - ir.z, s = 1 / (1 << dd); u.iTex.value = ir.tex; u.iUV.value.set((L.x - (ir.x << dd)) * s, (L.y - (ir.y << dd)) * s, s, s); u.iHas.value = 1; u.iTexel.value = L.size / 256 / s; u.iEox.value = ir.src === 'eox' ? 1 : 0; }
      else u.iHas.value = 0;
      // night lights once the sun is down
      if (U.uNight.value > 0.05) { const nz = Math.min(L.z, 8), nd = L.z - nz; needN(nz, L.x >> nd, L.y >> nd, prio);
        const nr = bestN(L.z, L.x, L.y); if (nr) { const dd = L.z - nr.z, s = 1 / (1 << dd); u.nTex.value = nr.tex; u.nUV.value.set((L.x - (nr.x << dd)) * s, (L.y - (nr.y << dd)) * s, s, s); u.nHas.value = 1; } else u.nHas.value = 0; }
      else u.nHas.value = 0;
      n.mesh.visible = true; drawn.push(n);
    }
    lastLeaves = drawn; stats.drawn = drawn.length; stats.nodes = nodes.size;
    // cancel stale queued requests, evict what has not been used for a while
    if ((frameNo & 31) === 0) evict();
  }
  function evict() {
    const old = (m, cap, free) => {
      if (m.size <= cap) return;
      const arr = [...m.values()].filter(r => r.state !== 1 && r.used < frameNo - 2).sort((a, b) => a.used - b.used);
      for (let i = 0; i < arr.length && m.size > cap; i++) { free(arr[i]); m.delete(arr[i].k !== undefined ? arr[i].k : key(arr[i].z, arr[i].x, arr[i].y)); }
    };
    old(nodes, 900, dispose);
    old(irec, 420, r => { if (r.tex) r.tex.dispose(); });
    old(hrec, 240, () => {});
    old(nrec, 120, r => { if (r.tex) r.tex.dispose(); });
    // queued requests for tiles nobody wants any more
    for (const [k2, r] of irec) if (r.state === 1 && r.used < frameNo - 120 && r.job) { r.job.cancelled = true; irec.delete(k2); }
    for (const [k2, r] of hrec) if (r.state === 1 && r.used < frameNo - 120 && r.job) { r.job.cancelled = true; hrec.delete(k2); }
  }
  function invalidate() { for (const n of nodes.values()) n.hKey = -2; }
  function init() {
    try { maxAniso = Math.min(8, Env.renderer.capabilities.getMaxAnisotropy()); } catch (e) {}
    if (typeof Terrain !== 'undefined' && Terrain.area) { const a = Terrain.area; EX[0] = a[0]; EX[1] = a[1]; EX[2] = a[2]; EX[3] = a[3]; shared.uExcl.value.set(a[0], a[1], a[2], a[3]); }
    bayWater(); onFrame(bayFrame);
    Env.scene.add(group);
  }
  return { init, update, group, stats, frame, debug: shared.uDebug, ll2w, w2ll, setFrame, onFrame, maybeRebase, invalidate, inBayline, inSquare, h, hAt, ensure, lodK,
    set enabled(v) { enabled = !!v; }, get enabled() { return enabled; }, tx, ty, lonOf, latOf, inUS };
})();
