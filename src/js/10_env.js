// Renderer, scene, camera, time of day, sun & moon, lights, adaptive shadows, image-based lighting.
// The sky itself (physically based atmosphere, clouds, marine layer) lives in 11_sky.js and the render
// pipeline (HDR, SSAO, aerial perspective, bloom, grading) in 14_post.js; both plug in at runtime.
const Env = (() => {
  const canvas = document.getElementById('gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;      // only used when Post is off (Post tone-maps itself)
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 140000);
  scene.add(camera);

  // ---------- time ----------
  const LAT = 37.45, LON = -122.12;
  const time = { sec: 8 * 3600, date: new Date(), scale: 1, paused: false, live: true };
  function pacificParts(d) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
    const o = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value;
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: o.weekday };
  }
  function nowPacificSeconds() { const p = pacificParts(new Date()); return p.h * 3600 + p.mi * 60 + p.s + (Date.now() % 1000) / 1000; }
  function pacificOffsetHours(d) { // UTC offset of Pacific time on date d (−7 in DST, −8 otherwise)
    const p = pacificParts(d); const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s); return Math.round((asUTC - d.getTime()) / 3600000); }

  // ---------- sun position (NOAA approximation) ----------
  const sunDir = new THREE.Vector3(0, 1, 0), moonDir = new THREE.Vector3();
  function solar(simSec, date) {
    const p = pacificParts(date); const off = pacificOffsetHours(date);
    const doy = Math.floor((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(p.y, 0, 0)) / 864e5);
    const hourUTC = simSec / 3600 - off;
    const g = 2 * Math.PI / 365 * (doy - 1 + (hourUTC - 12) / 24);
    const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const tst = hourUTC * 60 + eqt + 4 * LON;             // true solar time, minutes
    const ha = (tst / 4 - 180) * U.DEG;                    // hour angle
    const lat = LAT * U.DEG;
    const cosZ = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
    const zen = Math.acos(U.clamp(cosZ, -1, 1)); const el = Math.PI / 2 - zen;
    let az = Math.acos(U.clamp((Math.sin(lat) * Math.cos(zen) - Math.sin(decl)) / (Math.cos(lat) * Math.sin(zen)), -1, 1));
    az = ha > 0 ? (az + Math.PI) % U.TAU : (3 * Math.PI - az) % U.TAU;   // from north, clockwise
    return { el, az };
  }
  function dirFromElAz(v, el, az) { v.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)); return v; }
  // moon: lags the sun ~50 min per day of lunar age; illuminated fraction from the synodic phase
  function moonAge(date) { const days = (date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 864e5; const a = days % 29.530588; return a < 0 ? a + 29.530588 : a; }

  // ---------- sky dome (material supplied by Sky) ----------
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicMaterial({ color: 0x86a9d4, side: THREE.BackSide, depthWrite: false, fog: false }));
  sky.scale.setScalar(120000); sky.frustumCulled = false; sky.renderOrder = -1000;
  scene.add(sky);

  // ---------- lights ----------
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  const SC = sun.shadow.camera; SC.left = -90; SC.right = 90; SC.top = 90; SC.bottom = -90; SC.near = 1; SC.far = 1200;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6a5a3a, 0.45); scene.add(hemi);
  const moon = new THREE.DirectionalLight(0x9fb4ff, 0.0); scene.add(moon, moon.target);
  scene.fog = null;       // aerial perspective + marine layer are done in post from depth (14_post.js)

  // ---------- image-based lighting (PMREM of the sky) ----------
  const pmrem = new THREE.PMREMGenerator(renderer);
  const fallbackEnv = new THREE.Scene(); fallbackEnv.add(new THREE.Mesh(new THREE.SphereGeometry(100, 16, 8), new THREE.MeshBasicMaterial({ color: 0x8fb0d8, side: THREE.BackSide })));
  let envRT = null, lastEnvKey = '';
  function refreshEnv(force) {
    const wx = state.wx || {};
    const key = Math.round(state.sunEl * 90 / Math.PI) + '/' + Math.round(state.sunAz * 18 / Math.PI) + '/' + Math.round(state.night * 12) + '/' + Math.round((wx.haze || 2) * 2) + '/' + Math.round((wx.clouds || 0) * 5);
    if (!force && key === lastEnvKey) return; lastEnvKey = key;
    const es = (typeof Sky !== 'undefined' && Sky.envScene) ? Sky.envScene : fallbackEnv;
    const rt = pmrem.fromScene(es, 0, 0.1, 200);
    if (envRT) envRT.dispose(); envRT = rt; scene.environment = rt.texture;
  }

  const state = { sunEl: 0.5, sunAz: 2, night: 0, weather: 'auto', fogDensity: 0, lightLevel: 1, exposure: 1, moonDir, moonPhase: 0.5, wx: null, shadowSize: 90 };
  const focus = new THREE.Vector3(), camDir = new THREE.Vector3(), lx = new THREE.Vector3(), ly = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0);
  function resize() {
    const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize); resize();

  // shadow frustum follows the camera: ±90 m at street level, growing with altitude to ±2.2 km for aerial views,
  // pushed ahead of the view direction, quantised in size and snapped to shadow texels in light space (no swimming)
  function updateShadows(camPos) {
    let ground = 0; try { if (typeof Terrain !== 'undefined' && Terrain.h) ground = Terrain.h(camPos.x, camPos.z) || 0; } catch (e) {}
    const alt = Math.max(0, camPos.y - ground);
    let size = U.clamp(90 + alt * 1.35, 90, 2200);
    size = Math.min(2200, 90 * Math.pow(1.35, Math.round(Math.log(size / 90) / Math.log(1.35))));
    state.shadowSize = size;
    camera.getWorldDirection(camDir); const fl = Math.hypot(camDir.x, camDir.z) || 1;
    const push = size * U.clamp(0.25 + alt / 900, 0.25, 0.6);
    focus.set(camPos.x + camDir.x / fl * push, ground, camPos.z + camDir.z / fl * push);
    // light basis exactly as three's lookAt builds it for the shadow camera
    lx.crossVectors(UPV, sunDir); if (lx.lengthSq() < 1e-6) lx.set(1, 0, 0); lx.normalize(); ly.crossVectors(sunDir, lx).normalize();
    const texel = (2 * size) / sun.shadow.mapSize.x;
    const u = focus.dot(lx), v = focus.dot(ly);
    focus.addScaledVector(lx, Math.round(u / texel) * texel - u).addScaledVector(ly, Math.round(v / texel) * texel - v);
    const back = size * 1.6 + 700;
    SC.left = -size; SC.right = size; SC.top = size; SC.bottom = -size; SC.near = 1; SC.far = back + size * 1.6 + 900;
    SC.updateProjectionMatrix();
    sun.position.copy(focus).addScaledVector(sunDir, back); sun.target.position.copy(focus);
    sun.shadow.normalBias = texel * 1.15;
    sun.shadow.bias = -(0.015 + texel * 0.25) / (SC.far - SC.near);
  }

  function update(dt, camPos) {
    // advance time
    if (!time.paused) {
      if (time.live && time.scale === 1) time.sec = nowPacificSeconds();
      else { time.sec += dt * time.scale; time.live = false; }
      if (time.sec >= 86400) { time.sec -= 86400; time.date = new Date(time.date.getTime() + 864e5); }
      if (time.sec < 0) { time.sec += 86400; time.date = new Date(time.date.getTime() - 864e5); }
    }
    const s = solar(time.sec, time.date); state.sunEl = s.el; state.sunAz = s.az;
    dirFromElAz(sunDir, s.el, s.az);
    const age = moonAge(time.date); state.moonPhase = (1 - Math.cos(age / 29.530588 * U.TAU)) / 2;
    const m = solar(((time.sec - age * 3000) % 86400 + 86400) % 86400, time.date); dirFromElAz(moonDir, m.el, m.az);
    const eDeg = s.el / U.DEG;
    state.night = U.smooth(4, -9, eDeg);
    U.uNight.value = state.night;
    const sunUp = U.smooth(-2, 6, eDeg);
    if (typeof Sky !== 'undefined') {
      Sky.update(dt, camPos);
      sun.color.copy(Sky.sunLight.color); sun.intensity = Sky.sunLight.intensity;
      const a = Sky.ambient, al = Math.max(1e-4, 0.2126 * a.r + 0.7152 * a.g + 0.0722 * a.b);
      hemi.color.setRGB(a.r / al, a.g / al, a.b / al).multiplyScalar(0.55).addScalar(0.45);
      hemi.groundColor.setRGB(0.54, 0.45, 0.32).multiplyScalar(0.35 + 0.65 * sunUp);
    } else {
      sun.color.setRGB(1, 0.96, 0.9); sun.intensity = 3.0 * sunUp;
      hemi.color.set(0xd8e4f2); hemi.groundColor.set(0x6a5a3a);
    }
    sun.castShadow = sunUp > 0.05;
    hemi.intensity = 0.16 + 0.3 * sunUp + 0.12 * state.night;
    const moonUp = U.smooth(-0.03, 0.2, moonDir.y);
    moon.intensity = 0.3 * state.night * moonUp * (0.25 + 0.75 * state.moonPhase);
    moon.position.copy(camPos).addScaledVector(moonDir, 600); moon.target.position.copy(camPos);
    // exposure: no clipped whites at noon, a touch brighter at golden hour, lights pop at night
    // (calibrated so a sunlit 18% grey reads mid-grey at noon; aerial photography albedos are ~0.1-0.25)
    const eDay = U.lerp(0.84, 0.66, U.smooth(6, 35, eDeg));
    const eTw = U.lerp(eDay, 1.2, U.smooth(3, -5, eDeg));
    state.exposure = U.lerp(eTw, 1.85, U.smooth(-5, -12, eDeg));
    renderer.toneMappingExposure = state.exposure * 0.93;
    if (sun.castShadow) updateShadows(camPos);
    sky.position.copy(camPos);
    U.uTime.value += dt;
    refreshEnv(false);
  }
  function setClock(sec, dateObj) { time.sec = sec; if (dateObj) time.date = dateObj; time.live = false; }
  function goLive() { time.live = true; time.scale = 1; time.date = new Date(); time.sec = nowPacificSeconds(); }
  function serviceDay() { // 'wkday' | 'wkend' and yyyymmdd for the sim date
    const p = pacificParts(time.date); const wd = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
    return { kind: (wd === 0 || wd === 6) ? 'wkend' : 'wkday', ymd: `${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}` };
  }
  function clockText(sec = time.sec) { const h = Math.floor(sec / 3600) % 24, m = Math.floor(sec / 60) % 60; const ap = h < 12 ? 'AM' : 'PM'; return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${ap}`; }
  return { renderer, scene, camera, canvas, sky, sun, hemi, moon, time, state, sunDir, moonDir, update, setClock, goLive, serviceDay, clockText, nowPacificSeconds, refreshEnv, shadowCam: SC };
})();
