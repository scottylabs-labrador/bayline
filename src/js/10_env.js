// Renderer, scene, camera, sky, sun & moon, fog, image-based lighting, time of day.
const Env = (() => {
  const canvas = document.getElementById('gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
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

  // ---------- sky dome ----------
  const skyU = {
    sunDir: { value: sunDir }, moonDir: { value: moonDir }, zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
    sunGlow: { value: new THREE.Color() }, antiGlow: { value: new THREE.Color() }, night: U.uNight, time: U.uTime, sunDisk: { value: 1 }, ground: { value: new THREE.Color() }
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
    fragmentShader: `
      uniform vec3 sunDir, moonDir, zenith, horizon, sunGlow, antiGlow, ground; uniform float night, time, sunDisk; varying vec3 vDir;
      float h(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      void main(){
        vec3 d = normalize(vDir); float y = d.y;
        float t = pow(clamp(1.0 - max(y,0.0), 0.0, 1.0), 3.2);
        vec3 col = mix(zenith, horizon, t);
        float mu = dot(d, sunDir);
        col += sunGlow * (pow(max(mu,0.0), 6.0)*0.55 + pow(max(mu,0.0), 48.0)*0.9) * (0.35 + 0.65*t);
        col += antiGlow * pow(max(-mu,0.0), 3.0) * t * 0.6;                    // belt of Venus
        col += sunGlow * sunDisk * smoothstep(0.9995, 0.99975, mu) * 18.0;         // sun disk
        float mm = dot(d, moonDir); col += vec3(0.85,0.88,0.95) * smoothstep(0.99955, 0.9997, mm) * 2.0 * night;
        if (night > 0.02 && y > 0.0) {                                              // stars
          vec3 g = floor(d * 420.0); float s = h(g); float tw = 0.75 + 0.25*sin(time*3.0 + s*80.0);
          col += vec3(0.9,0.93,1.0) * smoothstep(0.9965, 1.0, s) * night * tw * smoothstep(0.0, 0.25, y) * 1.4;
        }
        if (y < 0.0) col = mix(horizon, ground, clamp(-y*6.0,0.0,1.0));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMat);
  sky.scale.setScalar(120000); sky.frustumCulled = false; sky.renderOrder = -1000;
  scene.add(sky);

  // ---------- lights ----------
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  const SC = sun.shadow.camera; SC.left = -90; SC.right = 90; SC.top = 90; SC.bottom = -90; SC.near = 1; SC.far = 1200;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6a5a3a, 0.6); scene.add(hemi);
  const moon = new THREE.DirectionalLight(0x9fb4ff, 0.0); scene.add(moon, moon.target);
  scene.fog = new THREE.FogExp2(0xbcd7ee, 1 / 60000);

  // ---------- image-based lighting (PMREM of the sky) ----------
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMat); envSky.scale.setScalar(100); envScene.add(envSky);
  let envRT = null, lastEnvKey = '';
  function refreshEnv(force) {
    const key = (Math.round(state.sunEl * 90 / Math.PI) + '/' + Math.round(state.sunAz * 18 / Math.PI) + '/' + Math.round(state.night * 12));
    if (!force && key === lastEnvKey) return; lastEnvKey = key;
    skyU.sunDisk.value = 0.0;
    const rt = pmrem.fromScene(envScene, 0, 0.1, 200);
    skyU.sunDisk.value = 1.0;
    if (envRT) envRT.dispose(); envRT = rt; scene.environment = rt.texture;
  }

  // ---------- palette over the day ----------
  const C = (h) => new THREE.Color(h);
  const keys = [ // sun elevation (deg) -> colors
    { e: -18, zen: C(0x05070d), hor: C(0x0b1220), glow: C(0x000000), anti: C(0x000000), sun: C(0x000000), ground: C(0x05060a) },
    { e: -8, zen: C(0x0b1428), hor: C(0x1d2a48), glow: C(0x3a2440), anti: C(0x10162a), sun: C(0x000000), ground: C(0x0b0d14) },
    { e: -2, zen: C(0x1d3566), hor: C(0x7a6a7a), glow: C(0xd06a3a), anti: C(0x4a4870), sun: C(0x000000), ground: C(0x1a1a22) },
    { e: 2, zen: C(0x2f5aa0), hor: C(0xe0a878), glow: C(0xff8a3c), anti: C(0x8a7ea0), sun: C(0xff9a50), ground: C(0x4a4038) },
    { e: 8, zen: C(0x3c70bd), hor: C(0xe9cfae), glow: C(0xffb870), anti: C(0x9aa6c4), sun: C(0xffc98f), ground: C(0x6a5d48) },
    { e: 20, zen: C(0x3d7cc9), hor: C(0xbfd6ea), glow: C(0xffe2b0), anti: C(0x9fb8d8), sun: C(0xfff1dc), ground: C(0x7a6c52) },
    { e: 60, zen: C(0x2f73c8), hor: C(0xb4d2ec), glow: C(0xfff0d0), anti: C(0x9fbadc), sun: C(0xffffff), ground: C(0x7d6f55) },
  ];
  const tmpC = new THREE.Color();
  function pal(field, eDeg, out) {
    let i = 0; while (i < keys.length - 2 && eDeg > keys[i + 1].e) i++;
    const a = keys[i], b = keys[i + 1]; const t = U.clamp((eDeg - a.e) / (b.e - a.e), 0, 1);
    return out.copy(a[field]).lerp(b[field], t);
  }

  const state = { sunEl: 0.5, sunAz: 2, night: 0, weather: 'clear', fogDensity: 1 / 60000, lightLevel: 1 };
  const focus = new THREE.Vector3();
  function resize() {
    const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize); resize();

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
    const m = solar((time.sec + 12.4 * 3600) % 86400, time.date); dirFromElAz(moonDir, Math.max(m.el, 0.35), m.az);
    const eDeg = s.el / U.DEG;
    state.night = U.smooth(4, -9, eDeg);
    U.uNight.value = state.night;
    pal('zen', eDeg, skyU.zenith.value); pal('hor', eDeg, skyU.horizon.value); pal('glow', eDeg, skyU.sunGlow.value);
    pal('anti', eDeg, skyU.antiGlow.value); pal('ground', eDeg, skyU.ground.value);
    // haze from weather
    const fogCol = pal('hor', eDeg, tmpC).clone();
    scene.fog.color.copy(fogCol);
    scene.fog.density = state.fogDensity * (1 + state.night * 0.4);
    // lights
    const sunUp = U.smooth(-2, 6, eDeg);
    sun.intensity = 3.4 * sunUp; pal('sun', eDeg, sun.color);
    focus.copy(camPos);
    sun.position.copy(focus).addScaledVector(sunDir, 600); sun.target.position.copy(focus);
    // stabilise shadow texels to reduce shimmering
    const texel = (SC.right - SC.left) / sun.shadow.mapSize.x;
    sun.position.x = Math.round(sun.position.x / texel) * texel; sun.position.z = Math.round(sun.position.z / texel) * texel;
    sun.target.position.x = Math.round(sun.target.position.x / texel) * texel; sun.target.position.z = Math.round(sun.target.position.z / texel) * texel;
    sun.castShadow = sunUp > 0.05;
    hemi.intensity = 0.22 + 0.38 * sunUp + 0.12 * state.night;
    hemi.color.copy(skyU.zenith.value).lerp(tmpC.set(0xfff4e6), 0.62); hemi.groundColor.copy(skyU.ground.value).lerp(tmpC.set(0x8a7250), 0.3);
    moon.intensity = 0.35 * state.night; moon.position.copy(focus).addScaledVector(moonDir, 600); moon.target.position.copy(focus);
    renderer.toneMappingExposure = 0.95 + state.night * 0.55;
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
  return { renderer, scene, camera, canvas, sky, sun, hemi, time, state, sunDir, update, setClock, goLive, serviceDay, clockText, nowPacificSeconds, refreshEnv, shadowCam: SC };
})();
