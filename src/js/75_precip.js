// Precip: rain and snow around the camera, drops on the windshield, lightning. Instanced streaks (rain) or flakes
// (snow) fill a box that travels with the camera; each drop falls with the real wind and is stretched along its
// motion relative to the camera, so rain slants toward you at speed. From the cockpit the drops run over the
// glass instead (a canvas overlay), and thunderstorms flash. Driven by the live weather where you fly (Open-Meteo
// precipitation and WMO weather code) or by the weather picker (K: rain, storm, snow; #w=rain).
//   Precip.update(dt)      per frame          Precip.state   { kind: 'none' | 'rain' | 'snow', rate: 0..1, storm }
const Precip = (() => {
  const MAX = 16000, BOX = new THREE.Vector3(64, 44, 64);
  let mesh = null, mat = null, time = 0, flashEl = null, flashT = 0, nextBolt = 8, drops = null;
  const state = { kind: 'none', rate: 0, storm: false };
  const camVel = new THREE.Vector3(), lastCam = new THREE.Vector3(), rainVel = new THREE.Vector3(), app = new THREE.Vector3(), wind = new THREE.Vector3();
  let haveLast = false;

  function build() {
    const base = new THREE.PlaneGeometry(1, 1); base.translate(0, 0.5, 0);      // x: -0.5..0.5 across, y: 0..1 along (head at 0)
    const g = new THREE.InstancedBufferGeometry(); g.index = base.index; g.setAttribute('position', base.attributes.position);
    const seed = new Float32Array(MAX * 4); for (let i = 0; i < MAX * 4; i++) seed[i] = Math.random();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4)); g.instanceCount = 0;
    mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,        // (quads are built facing the camera in the shader: either winding)
      uniforms: { uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() }, uApp: { value: new THREE.Vector3() }, uBox: { value: BOX.clone() },
        uTime: { value: 0 }, uLen: { value: 0.03 }, uWidth: { value: 0.012 }, uNear: { value: 1.2 }, uSnow: { value: 0 }, uAlpha: { value: 0.3 }, uColor: { value: new THREE.Color() } },
      vertexShader: `#include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 aSeed; uniform vec3 uCam, uVel, uApp, uBox; uniform float uTime, uLen, uWidth, uNear, uSnow; varying float vA; varying vec2 vUv;
        void main() {
          vec3 wp = aSeed.xyz * uBox + uVel * uTime * (0.85 + 0.3 * aSeed.w);
          if (uSnow > 0.5) wp.xz += vec2(sin(uTime * 1.1 + aSeed.w * 40.0), cos(uTime * 0.9 + aSeed.w * 23.0)) * 0.6;
          vec3 rel = mod(wp - uCam + 0.5 * uBox, uBox) - 0.5 * uBox, p = uCam + rel;
          vec3 dir = uApp; float sp = length(dir); dir = sp > 0.01 ? dir / sp : vec3(0.0, -1.0, 0.0);
          vec3 toCam = normalize(cameraPosition - p);
          float L = uSnow > 0.5 ? uWidth : clamp(sp * uLen, 0.06, 5.0);
          vec3 side = normalize(cross(dir, toCam) + vec3(1e-4)) * uWidth;
          vec3 v = p + side * position.x * 2.0 - dir * L * position.y;
          if (uSnow > 0.5) { vec3 up = normalize(cross(toCam, side)); v = p + side * position.x * 2.0 + up * uWidth * (position.y - 0.5) * 2.0; }
          float d = length(rel);
          vA = smoothstep(uNear, uNear * 1.8, d) * (1.0 - smoothstep(uBox.x * 0.28, uBox.x * 0.5, d)) * (0.55 + 0.45 * aSeed.w);
          vUv = vec2(position.x + 0.5, position.y);
          gl_Position = projectionMatrix * viewMatrix * vec4(v, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `#include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uAlpha, uSnow; uniform vec3 uColor; varying float vA; varying vec2 vUv;
        void main() {
          #include <logdepthbuf_fragment>
          float a = uSnow > 0.5 ? 1.0 - smoothstep(0.25, 0.5, length(vUv - 0.5)) : (1.0 - abs(vUv.x - 0.5) * 2.0) * smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.7, 1.0, vUv.y));
          gl_FragColor = vec4(uColor, a * vA * uAlpha);
        }`,
    });
    mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.renderOrder = 6; mesh.layers.enable(1);
    Env.scene.add(mesh);
    flashEl = document.createElement('div'); flashEl.id = 'wflash';
    flashEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;background:#dfe6ff;opacity:0;mix-blend-mode:screen;z-index:3;transition:none';
    document.body.appendChild(flashEl);
  }

  // what is falling: the picker wins, else the live weather while flying or away from the Bay
  function decide() {
    const kind = Env.state && Env.state.weather || 'auto';
    if (kind === 'rain') return { kind: 'rain', rate: 0.6, storm: false };
    if (kind === 'storm') return { kind: 'rain', rate: 1, storm: true };
    if (kind === 'snow') return { kind: 'snow', rate: 0.7, storm: false };
    if (kind !== 'auto' || typeof Weather === 'undefined' || !Weather.now) return { kind: 'none', rate: 0, storm: false };
    const flying = typeof Flight !== 'undefined' && Flight.active, away = typeof Globe !== 'undefined' && !Globe.frame.bay;
    if (!flying && !away) return { kind: 'none', rate: 0, storm: false };
    const w = Weather.now, c = w.code, mm = w.precip || 0;
    const snow = (c >= 71 && c <= 77) || c === 85 || c === 86, rainy = (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95 || mm > 0.05;
    if (!snow && !rainy) return { kind: 'none', rate: 0, storm: false };
    const byCode = { 51: 0.15, 53: 0.25, 55: 0.35, 56: 0.25, 57: 0.4, 61: 0.35, 63: 0.6, 65: 0.9, 66: 0.4, 67: 0.8, 80: 0.45, 81: 0.7, 82: 1, 71: 0.35, 73: 0.6, 75: 0.9, 77: 0.3, 85: 0.5, 86: 0.9, 95: 0.85, 96: 0.95, 99: 1 }[c];
    const rate = U.clamp(Math.max(byCode || 0, Math.log10(1 + mm) * 0.9), 0.12, 1);
    // above the cloud base it is not raining on you
    const cam = Env.camera.position; if (w.base && cam.y > w.base + 150) return { kind: 'none', rate: 0, storm: false };
    return { kind: snow ? 'snow' : 'rain', rate, storm: c >= 95 };
  }

  // drops on the windshield (cockpit view only): they bead and trickle when slow, streak up and outward at speed
  function windshield(dt, on, rate, kt) {
    if (!drops) {
      const cv = document.createElement('canvas'); cv.id = 'wdrops'; cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
      document.body.appendChild(cv); drops = { cv, g: cv.getContext('2d'), list: [], w: 0, h: 0 };
    }
    const D = drops, dpr = Math.min(2, window.devicePixelRatio || 1), W = innerWidth, H = innerHeight;
    if (!on) { if (D.list.length || D.cv.style.display !== 'none') { D.list.length = 0; D.cv.style.display = 'none'; } return; }
    D.cv.style.display = '';
    if (D.w !== W || D.h !== H) { D.w = W; D.h = H; D.cv.width = W * dpr; D.cv.height = H * dpr; }
    const g = D.g, fast = U.smooth(25, 90, kt), top = H * 0.62;
    // new drops: more with more rain and more speed
    let n = rate * (6 + kt * 0.35) * dt * 12; while (n > 0) { if (Math.random() < n) D.list.push({ x: Math.random() * W, y: Math.random() * top, r: 1.2 + Math.random() * 2.8, a: 0, life: 2 + Math.random() * 5 }); n -= 1; }
    if (D.list.length > 420) D.list.splice(0, D.list.length - 420);
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H * 0.36;
    for (const d of D.list) {
      d.a += dt; d.life -= dt;
      // airflow: outward from a point ahead and up the glass, faster with speed; gravity when slow
      const ox = d.x - cx, oy = d.y - cy, k = fast * (0.6 + kt / 120) * 60;
      const vx = ox / (Math.hypot(ox, oy) + 40) * k, vy = oy / (Math.hypot(ox, oy) + 40) * k - fast * 40 + (1 - fast) * (Math.random() < 0.02 ? 60 : 3);
      const px = d.x, py = d.y; d.x += vx * dt; d.y += vy * dt;
      const fade = Math.min(1, d.a * 6) * Math.min(1, d.life);
      if (fast > 0.3) { g.strokeStyle = `rgba(210,225,240,${0.22 * fade})`; g.lineWidth = d.r * 0.7; g.beginPath(); g.moveTo(px - vx * 0.04, py - vy * 0.04); g.lineTo(d.x, d.y); g.stroke(); }
      else {
        const gr = g.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.3, d.r * 0.1, d.x, d.y, d.r);
        gr.addColorStop(0, `rgba(255,255,255,${0.55 * fade})`); gr.addColorStop(0.45, `rgba(180,195,210,${0.12 * fade})`); gr.addColorStop(1, `rgba(20,25,30,${0.35 * fade})`);
        g.fillStyle = gr; g.beginPath(); g.arc(d.x, d.y, d.r, 0, 7); g.fill();
      }
    }
    D.list = D.list.filter(d => d.life > 0 && d.y > -20 && d.y < top + 20 && d.x > -20 && d.x < W + 20);
  }

  function update(dt) {
    if (!Env.scene || !Env.camera) return;
    if (!mesh) build();
    const want = decide();
    // ease in and out
    state.kind = want.kind !== 'none' ? want.kind : state.rate > 0.01 ? state.kind : 'none';
    state.rate += ((want.kind !== 'none' ? want.rate : 0) - state.rate) * Math.min(1, dt * 0.6); state.storm = want.storm;
    const cam = Env.camera.position, flying = typeof Flight !== 'undefined' && Flight.active, pm = typeof Player !== 'undefined' ? Player.mode : '';
    const inTrain = !flying && (pm === 'onboard' || pm === 'cab');                // (the drops start beyond the glass)
    // the camera's own motion (for the slant of the streaks); a frame rebase or a teleport is not motion
    if (haveLast && dt > 0) { const jump = lastCam.distanceTo(cam); if (jump < 250) camVel.lerp(app.copy(cam).sub(lastCam).divideScalar(dt), Math.min(1, dt * 6)); else camVel.set(0, 0, 0); }
    lastCam.copy(cam); haveLast = true; time += dt;
    const on = state.rate > 0.01;
    mesh.visible = on;
    if (on) {
      const snow = state.kind === 'snow';
      if (typeof Weather !== 'undefined' && Weather.now) Weather.windAt(cam.y, wind); else wind.set(0, 0, 0);
      rainVel.set(wind.x, snow ? -1.3 : -8.5, wind.z);
      app.copy(rainVel).sub(camVel);
      const U2 = mat.uniforms, night = U.uNight ? U.uNight.value : 0, cockpit = typeof Flight !== 'undefined' && Flight.active && Flight.cam.mode === 'cockpit';
      U2.uCam.value.copy(cam); U2.uVel.value.copy(rainVel); U2.uApp.value.copy(app); U2.uTime.value = time;
      U2.uBox.value.copy(BOX).multiplyScalar(snow ? 0.5 : 1);                         // (snow: a smaller, denser box)
      U2.uSnow.value = snow ? 1 : 0; U2.uWidth.value = snow ? 0.05 : 0.016; U2.uLen.value = 1 / 22; U2.uNear.value = cockpit ? 7 : inTrain ? (pm === 'cab' ? 4.5 : 3.2) : 1.1;
      U2.uAlpha.value = (snow ? 0.85 : 0.6) * (0.55 + 0.45 * state.rate);
      const amb = typeof Sky !== 'undefined' && Sky.uniforms ? Sky.uniforms.uSkyAmbient.value : null;   // lit by the sky: grey by day, dim at night
      const gl = (snow ? 0.1 : 0.05) * night;                                        // (city glow at night)
      if (amb && snow) { const l = (0.3 * amb.x + 0.59 * amb.y + 0.11 * amb.z) * 3.4 + 0.04 + gl; U2.uColor.value.setRGB(l, l, l * 1.03); }     // (flakes: white, lit by the sky)
      else if (amb) U2.uColor.value.setRGB(amb.x * 2.4 + 0.03 + gl, amb.y * 2.4 + 0.03 + gl * 0.95, amb.z * 2.4 + 0.035 + gl * 0.9); else U2.uColor.value.setRGB(0.62 - 0.52 * night, 0.66 - 0.55 * night, 0.72 - 0.58 * night);
      mesh.geometry.instanceCount = Math.floor(MAX * (snow ? 0.45 : 1) * state.rate);
      if (debug.red) { U2.uColor.value.setRGB(3, 0, 0); U2.uAlpha.value = 1; U2.uWidth.value = 0.15; }
    }
    // the windshield
    // the windshield: the aircraft's from its cockpit, the train's from its cab
    const glass = state.kind === 'rain' && ((flying && Flight.cam.mode === 'cockpit') || (!flying && pm === 'cab'));
    let kt = 0; if (flying && Flight.ac) kt = Flight.ac.out.tas / 0.514444; else if (pm === 'cab' && Player.focusTrain) { const tr = Player.focusTrain(); kt = tr ? Math.abs(tr.v || 0) / 0.514444 : 0; }
    windshield(dt, glass && on, state.rate, kt);
    // lightning: a flash across the sky, the thunder a few seconds later
    if (flashEl) {
      if (state.storm && on) { nextBolt -= dt; if (nextBolt <= 0) { nextBolt = 6 + Math.random() * 16; flashT = 0.45; const dist = 1 + Math.random() * 6; setTimeout(() => { if (typeof FSound !== 'undefined' && FSound.thunder) FSound.thunder(dist); }, dist * 900); } }
      if (flashT > 0) { flashT -= dt; const k = flashT > 0.3 ? 1 : flashT > 0.2 ? 0.2 : flashT > 0.1 ? 0.7 : Math.max(0, flashT) * 3; flashEl.style.opacity = String(0.32 * k * (0.4 + 0.6 * (U.uNight ? U.uNight.value : 0))); }
      else if (flashEl.style.opacity !== '0') flashEl.style.opacity = '0';
    }
  }
  const debug = {};
  return { update, state, debug };
})();
