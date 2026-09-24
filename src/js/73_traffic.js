// Traffic: the real aircraft flying around you right now (ADS-B via adsb.lol, ODbL; proxied by our nginx because
// adsb.lol sends no CORS headers). Every few seconds the aircraft within ~60 nm arrive with position, altitude, speed,
// track and climb rate; between reports each is dead-reckoned and eased onto the new fix, so they fly smoothly. Drawn
// as instanced models picked by ICAO type code (A320 family, 737 / 757 / regional jets, twin wide-bodies, four-engine
// jumbos, light aircraft, fighters), scaled to the real type's length, with nav / strobe / beacon / landing lights and
// callsign labels close by. On the ground they sit on the runway or apron at the right height.
//   Traffic.update(dt)   per frame      Traffic.enabled = true | false      Traffic.count, Traffic.nearest(pos)
const Traffic = (() => {
  const D = Math.PI / 180, KT = 0.514444, FT = 0.3048, NM = 1852;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const group = new THREE.Group(); group.name = 'traffic';
  const targets = new Map();
  let enabled = true, pollT = 0, busy = false, fails = 0, meshes = null, lights = null, labels = [], inited = false, lastCount = 0;
  // ICAO type designator -> [model class, length in metres]
  const TYPES = {
    A318: ['a320', 31.4], A319: ['a320', 33.8], A320: ['a320', 37.6], A321: ['a320', 44.5], A19N: ['a320', 33.8], A20N: ['a320', 37.6], A21N: ['a320', 44.5], BCS1: ['a320', 35], BCS3: ['a320', 38.7],
    B736: ['b738', 31.2], B737: ['b738', 33.6], B738: ['b738', 39.5], B739: ['b738', 42.1], B37M: ['b738', 35.6], B38M: ['b738', 39.5], B39M: ['b738', 42.2], B3XM: ['b738', 43.8], B733: ['b738', 33.4], B734: ['b738', 36.4], B735: ['b738', 31],
    B752: ['b738', 47.3], B753: ['b738', 54.4], B712: ['b738', 37.8], MD82: ['b738', 45], MD83: ['b738', 45], MD88: ['b738', 45], MD90: ['b738', 46.5],
    CRJ2: ['b738', 26.8], CRJ7: ['b738', 32.3], CRJ9: ['b738', 36.4], CRJX: ['b738', 39.1], E135: ['b738', 26.3], E145: ['b738', 29.9], E170: ['b738', 29.9], E75L: ['b738', 31.7], E75S: ['b738', 31.7], E190: ['b738', 36.2], E195: ['b738', 38.7], E290: ['b738', 36.3], E295: ['b738', 41.5],
    AT43: ['dhc6', 22.7], AT45: ['dhc6', 22.7], AT72: ['dhc6', 27.2], AT75: ['dhc6', 27.2], AT76: ['dhc6', 27.2], DH8A: ['dhc6', 22.3], DH8B: ['dhc6', 22.3], DH8C: ['dhc6', 25.7], DH8D: ['dhc6', 32.8], DHC6: ['dhc6', 15.8], SF34: ['b350', 19.7], B190: ['b350', 17.6],
    BE20: ['b350', 13.3], BE30: ['b350', 14.2], B350: ['b350', 14.2], BE9L: ['b350', 10.8], PC12: ['b350', 14.4], C208: ['dhc6', 11.5], DC3: ['dc3', 19.7], CONC: ['conc', 61.7], AS50: ['h125', 10.9], AS55: ['h125', 11.4], EC30: ['h125', 10.8], EC35: ['h125', 10.2], EC45: ['h125', 10.2], B06: ['h125', 9.5], B407: ['h125', 10.6], R44: ['h125', 8.9], R22: ['h125', 8.8], S76: ['h125', 13.2], A139: ['h125', 13.8], E300: ['e330', 6.95], E330: ['e330', 6.95], EXTR: ['e330', 6.95], PTS2: ['e330', 5.7],
    B788: ['b789', 56.7], B789: ['b789', 62.8], B78X: ['b789', 68.3], B762: ['b789', 48.5], B763: ['b789', 54.9], B764: ['b789', 61.4], B772: ['b789', 63.7], B77L: ['b789', 63.7], B773: ['b789', 73.9], B77W: ['b789', 73.9], B778: ['b789', 70.9], B779: ['b789', 76.7],
    A306: ['b789', 54.1], A310: ['b789', 46.7], A332: ['b789', 58.8], A333: ['b789', 63.7], A338: ['b789', 58.8], A339: ['b789', 63.7], A359: ['b789', 66.8], A35K: ['b789', 73.8], MD11: ['b789', 61.6], DC10: ['b789', 55.5], IL96: ['b789', 55.3],
    B741: ['b744', 70.6], B742: ['b744', 70.6], B743: ['b744', 70.6], B744: ['b744', 70.6], B748: ['b744', 76.3], B74S: ['b744', 56.3], A388: ['a388', 72.7], A342: ['b744', 59.4], A343: ['b744', 63.7], A345: ['b744', 67.9], A346: ['b744', 75.4], A124: ['b744', 69.1], C5M: ['b744', 75.3], IL76: ['b744', 46.6],
    F16: ['f16', 15.1], F18: ['f16', 17.1], F18S: ['f16', 18.3], F35: ['f16', 15.7], F15: ['f16', 19.4], F22: ['f16', 18.9], EUFI: ['f16', 15.9], RFAL: ['f16', 15.3], GRIF: ['f16', 14.1], A10: ['f16', 16.3], T38: ['f16', 14.1], HAWK: ['f16', 11.9], M346: ['f16', 11.5],
  };
  const LEN = { a320: 37.57, b738: 39.5, b789: 62.8, b744: 70.6, c172: 8.28, f16: 15.06, a388: 72.72, conc: 61.66, b350: 14.22, dhc6: 15.77, dc3: 19.66, e330: 6.95, h125: 10.93 };
  function classify(t, cat) {
    if (t === 'TWR' || t === 'GND' || t === 'GRND' || t === 'SERV' || t === 'EMER' || (!t && !cat)) return null;   // ground stations and vehicles
    const e = TYPES[t]; if (e) return { cls: e[0], scale: e[1] / LEN[e[0]] };
    if (cat === 'A1' || cat === 'B1' || cat === 'B4') return { cls: 'c172', scale: 1.05 };
    if (cat === 'A2') return { cls: 'c172', scale: 1.7 };
    if (cat === 'A3') return { cls: 'a320', scale: 1 };
    if (cat === 'A4') return { cls: 'b738', scale: 1.15 };
    if (cat === 'A5') return { cls: 'b789', scale: 1.05 };
    if (cat === 'A6') return { cls: 'f16', scale: 1 };
    if (cat === 'A7') return { cls: 'h125', scale: 1 };                                            // rotorcraft
    if (cat === 'B2' || cat === 'C1' || cat === 'C2' || cat === 'C3') return null;                 // balloons, vehicles
    return { cls: /^[A-Z]\d{2}/.test(t || '') ? 'c172' : 'a320', scale: 1 };
  }

  // ---------------------------------------------------------------- data
  const where = () => { const p = typeof Flight !== 'undefined' && Flight.active ? Flight.ac.pos : Env.camera.position; return Globe.w2ll(p.x, p.z); };
  async function poll() {
    busy = true;
    try {
      const ll = where(), alt = (typeof Flight !== 'undefined' && Flight.active ? Flight.ac.pos.y : Env.camera.position.y);
      const nm = alt > 6000 ? 120 : alt > 2000 ? 80 : 60;
      const la = (Math.round(ll.lat * 10) / 10).toFixed(1), lo = (Math.round(ll.lon * 10) / 10).toFixed(1);
      const r = await fetch(`./adsb/point/${la}/${lo}/${nm}`, { credentials: 'omit' });
      if (!r.ok) throw new Error('adsb ' + r.status);
      const j = await r.json(); ingest(j.ac || [], performance.now()); fails = 0;
    } catch (e) { fails++; }
    finally { busy = false; }
  }
  function ingest(list, now) {
    const seen = new Set();
    const qnh = typeof Weather !== 'undefined' && Weather.now ? Weather.now.qnh : 1013.25;
    for (const a of list) {
      if (a.lat === undefined || a.lon === undefined || (a.seen_pos || 0) > 30) continue;
      const hex = a.hex; seen.add(hex);
      const ground = a.alt_baro === 'ground';
      const cls = classify(a.t, a.category); if (!cls) continue;
      const altM = ground ? null : (typeof a.alt_baro === 'number' ? a.alt_baro * FT + (a.alt_baro < 18000 ? (qnh - 1013.25) * 8.3 : 0) : typeof a.alt_geom === 'number' ? a.alt_geom * FT : null);
      if (!ground && altM === null) continue;
      const fixT = now - (a.seen_pos || 0) * 1000;
      let t = targets.get(hex);
      const fix = { lat: a.lat, lon: a.lon, alt: altM, ground, trk: (a.track !== undefined ? a.track : a.true_heading || 0) * D, gs: (a.gs || 0) * KT, vs: ((a.baro_rate !== undefined ? a.baro_rate : a.geom_rate) || 0) * FT / 60, t: fixT };
      if (!t) {
        t = { hex, cs: (a.flight || '').trim(), type: a.t || '', reg: a.r || '', cls: cls.cls, scale: cls.scale, fix, off: new THREE.Vector3(), trkRate: 0, pos: new THREE.Vector3(), q: new THREE.Quaternion(), hdg: fix.trk, bank: 0, pitch: 0, seen: now, phase: Math.random() * 10, label: null };
        targets.set(hex, t); predict(t, now, t.pos);
      } else {
        // ease from where we were drawing it to the new fix over a couple of seconds
        const was = t.pos.clone(); t.fix = fix; predict(t, now, t.pos); t.off.copy(was).sub(t.pos); if (t.off.length() > 3000) t.off.set(0, 0, 0);
        const dtr = ((fix.trk - (t.lastTrk ?? fix.trk) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI, dtt = (fixT - (t.lastFixT ?? fixT)) / 1000;
        if (dtt > 0.5) t.trkRate = clamp(dtr / dtt, -0.1, 0.1);
        t.cs = (a.flight || t.cs).trim(); t.seen = now;
      }
      t.lastTrk = fix.trk; t.lastFixT = fixT; t.onGround = ground;
    }
    for (const [hex, t] of targets) if (!t.player && !seen.has(hex) && now - t.seen > 30000) { removeLabel(t); targets.delete(hex); }
  }
  // dead reckoning from the last fix (great-circle-free: short distances), in the current frame
  function predict(t, now, out) {
    const f = t.fix, dt = clamp((now - f.t) / 1000, 0, 25);
    const trk = f.trk + t.trkRate * dt * 0.5, dn = Math.cos(trk) * f.gs * dt, de = Math.sin(trk) * f.gs * dt;
    const lat = f.lat + dn / 111132, lon = f.lon + de / (111320 * Math.cos(f.lat * D));
    const w = Globe.ll2w(lat, lon); out.x = w.x; out.z = w.z;
    if (f.ground) out.y = null; else out.y = f.alt + f.vs * Math.min(dt, 8);
    return out;
  }

  // ---------------------------------------------------------------- drawing
  // instanced meshes per class, made once ACModel has built the models in the background: the far model, and a detailed
  // one within NEAR metres (gear up in the air, gear down on the ground)
  const NEAR = 2500;
  let liteMat = null;
  const mkMesh = (geo) => { const m = new THREE.InstancedMesh(geo, liteMat, 160); m.count = 0; m.frustumCulled = false; m.castShadow = true; m.receiveShadow = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.layers.enable(1); group.add(m); return m; };
  function meshFor(c, lod) {
    const k = c + '|' + lod; if (meshes[k]) return meshes[k];
    const g = ACModel.lite(AIRCRAFT.byId[c], lod, true); return g ? (meshes[k] = mkMesh(g.clone())) : null;
  }
  function initMeshes() {
    meshes = {};
    liteMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15 });
    // lights: instanced camera-facing glows (nav, strobes, beacons, landing), curved like the world
    const N = 160 * 7, geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)); geo.setIndex([0, 1, 2, 0, 2, 3]);
    const aP = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4), aC = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    aP.setUsage(THREE.DynamicDrawUsage); aC.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('aP', aP); geo.setAttribute('aC', aC); geo.instanceCount = 0;
    const lm = new THREE.ShaderMaterial({ uniforms: { uNight: U.uNight }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      vertexShader: `#include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 aP; attribute vec4 aC; uniform float uNight; varying vec2 vUv; varying vec3 vCol;
        void main() {
          vec4 mv = blBend(viewMatrix * vec4(aP.xyz, 1.0));
          float size = max(aP.w, -mv.z * 0.0014), I = aC.a * clamp(aP.w / size, 0.1, 1.0) * (0.25 + 0.75 * uNight);
          mv.xy += position.xy * size; gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
          vUv = position.xy; vCol = aC.rgb * I; if (I < 0.005) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
        }`,
      fragmentShader: `#include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec2 vUv; varying vec3 vCol;
        void main() {
          #include <logdepthbuf_fragment>
          float r = length(vUv); float a = exp(-r * r * 5.0) + 0.3 * exp(-r * r * 1.2); if (a < 0.01) discard; gl_FragColor = vec4(vCol * a * 1.4, 1.0); }` });
    lights = new THREE.Mesh(geo, lm); lights.frustumCulled = false; lights.renderOrder = 7; lights.layers.enable(1); group.add(lights);
    Env.scene.add(group);
  }
  const photo = () => typeof document !== 'undefined' && document.body.classList.contains('photo');
  function labelSprite(t) {
    const c = document.createElement('canvas'); c.width = 320; c.height = 64; const g = c.getContext('2d');
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, sizeAttenuation: false }));
    s.scale.set(0.16, 0.032, 1); s.renderOrder = 20; s.layers.enable(1); s.userData = { c, g, tex, text: '' }; group.add(s); return s;
  }
  function removeLabel(t) { if (t.label) { group.remove(t.label); t.label.material.map.dispose(); t.label.material.dispose(); t.label = null; } }
  const m4 = new THREE.Matrix4(), sc = new THREE.Vector3(), tv = new THREE.Vector3(), tq = new THREE.Quaternion(), qFix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  function draw(dt, now) {
    const counts = new Map();
    const cam = Env.camera.position, aP = lights.geometry.attributes.aP, aC = lights.geometry.attributes.aC; let nl = 0;
    const near = [];
    for (const t of targets.values()) {
      predict(t, now, tv); t.off.multiplyScalar(Math.exp(-dt / 1.6));
      t.pos.set(tv.x + t.off.x, (tv.y === null ? null : tv.y + t.off.y), tv.z + t.off.z);
      const spec = AIRCRAFT.byId[t.cls].fdm;
      if (t.pos.y === null || t.onGround) { const gy = typeof Player !== 'undefined' ? Player.groundAt(t.pos.x, t.pos.z) : 0; t.pos.y = gy + spec.cgHeight * t.scale; }
      else { const gy = typeof Player !== 'undefined' ? Player.groundAt(t.pos.x, t.pos.z) : 0; if (t.pos.y < gy + spec.cgHeight * t.scale) t.pos.y = gy + spec.cgHeight * t.scale; }
      const d = t.pos.distanceTo(cam); if (d > 160000) continue;
      if (typeof Flight !== 'undefined' && Flight.active && Flight.ac && t.pos.distanceTo(Flight.ac.pos) < 25) continue;   // (the player's own transponder, if it ever shows up)
      // attitude: track, a flight-path pitch, bank from the turn rate
      const f = t.fix, gam = f.ground || f.gs < 20 ? 0 : Math.atan2(f.vs, Math.max(f.gs, 1));
      t.hdg += ((((f.trk + t.trkRate * 2) - t.hdg + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * Math.min(1, dt * 1.5);
      const bankT = f.ground ? 0 : clamp(Math.atan(f.gs * t.trkRate / 9.81), -0.55, 0.55); t.bank += (bankT - t.bank) * Math.min(1, dt * 1.2);
      t.pitch += ((f.ground ? 0 : gam + 2.5 * D) - t.pitch) * Math.min(1, dt);
      if (t.player) { t.hdg = f.trk; t.pitch = t.mpPitch; t.bank = t.mpRoll; }
      FDM.attitude(tq, t.hdg, t.pitch, t.bank); tq.multiply(qFix);
      const m = (d < NEAR && meshFor(t.cls, f.ground || t.onGround ? 'gear' : 'near')) || meshFor(t.cls, 'far'), n = m ? counts.get(m) || 0 : 0;
      if (m && n < 160) { sc.setScalar(t.scale); m4.compose(t.pos, tq, sc); m.setMatrixAt(n, m4); counts.set(m, n + 1); }
      // lights (world positions from the model's tips)
      if (nl + 7 <= aP.count && d < 80000) {
        const mdl = AIRCRAFT.byId[t.cls].model, Lh = mdl.L * t.scale, ph = now / 1000 + t.phase;
        const span = (mdl.wing ? mdl.wing.span : mdl.htail ? mdl.htail.span : 1.5) * t.scale, wx = mdl.wing ? -mdl.wing.span * 0.3 : -Lh * 0.62;   // wing tips (a helicopter: the stabiliser's)
        const put = (lx, ly, lz, r, g, b, I, size) => { tv.set(lx, ly, lz).multiplyScalar(1).applyQuaternion(tq).add(t.pos); aP.setXYZW(nl, tv.x, tv.y, tv.z, size); aC.setXYZW(nl, r, g, b, I); nl++; };
        put(wx, 0, -span, 1, 0.08, 0.04, 1.4, 0.9);
        put(wx, 0, span, 0.1, 1, 0.3, 1.4, 0.9);
        put(-Lh * 0.5, 0.3, 0, 1, 1, 1, 0.9, 0.7);
        const strobe = (ph % 1.3) < 0.06 || ((ph % 1.3) > 0.16 && (ph % 1.3) < 0.2) ? 5 : 0; if (strobe && !f.ground) { put(wx, 0, -span, 1, 1, 1, strobe, 2.4); put(wx, 0, span, 1, 1, 1, strobe, 2.4); }
        if ((ph % 1.1) < 0.12) put(0, 2 * t.scale, 0, 1, 0.08, 0.03, 3, 1.4);
        const alt = t.pos.y - (typeof Player !== 'undefined' ? Player.groundAt(t.pos.x, t.pos.z) : 0);
        if (!f.ground && alt < 3000 && nl < aP.count) put(mdl.L * 0.35, -1, 0, 1, 0.95, 0.85, 4, 3.2);
      }
      if (d < 7000) near.push({ t, d });
    }
    for (const k in meshes) { const m = meshes[k]; m.count = counts.get(m) || 0; m.visible = m.count > 0; m.instanceMatrix.needsUpdate = true; }
    lights.geometry.instanceCount = nl; aP.needsUpdate = true; aC.needsUpdate = true;
    // callsign labels on the closest few
    near.sort((a, b) => a.d - b.d); const keep = new Set(photo() ? [] : near.slice(0, 10).map(n => n.t));   // (photo mode: no labels)
    for (const t of targets.values()) if (!keep.has(t) && t.label) removeLabel(t);
    for (const { t, d } of near.slice(0, keep.size)) {
      if (!t.label) t.label = labelSprite(t);
      const altFt = t.onGround ? 'GND' : Math.round(t.pos.y / FT / 100) * 100 + ' ft';
      const txt = `${t.cs || t.reg || t.hex.toUpperCase()}  ${t.type}  ${altFt}  ${Math.round(t.fix.gs / KT)} kt`;
      const L = t.label, u = L.userData;
      if (u.text !== txt) { u.text = txt; const g = u.g; g.clearRect(0, 0, 320, 64); g.fillStyle = 'rgba(10,12,16,.72)'; g.beginPath(); g.roundRect(2, 10, 316, 44, 12); g.fill();
        g.fillStyle = t.player || '#f3efe6'; g.font = '600 22px "IBM Plex Mono", monospace'; g.textBaseline = 'middle'; g.fillText(txt, 14, 33, 296); u.tex.needsUpdate = true; }
      const mdl = AIRCRAFT.byId[t.cls].model; L.position.copy(t.pos); L.position.y += (mdl.fus.h || mdl.fus.d || 2) * t.scale + 6 + d * 0.01; L.material.opacity = clamp(1.4 - d / 7000, 0, 1);
    }
  }
  // other Bayline players flying: decoded from the relay's presence ('air' mode) into targets drawn like traffic
  function players(now) {
    if (typeof Net === 'undefined') return;
    const seen = new Set();
    for (const o of Net.others()) {
      if (o.modeName !== 'air' || !AIRCRAFT.byId[o.trip]) continue;
      const key = 'mp' + o.id; seen.add(key);
      const lat = o.s / 1000 - 90, lon = o.x / 1000, alt = o.y * 2, pitch = (Math.floor(o.z / 400) / 2 - 90) * D, roll = ((o.z % 400) - 180) * D;
      let t = targets.get(key);
      const fix = { lat, lon, alt, ground: false, trk: o.yaw, gs: o.speed, vs: 0, t: now };
      if (!t) { t = { hex: key, cs: o.name, type: AIRCRAFT.byId[o.trip].short, reg: '', cls: o.trip, scale: 1, fix, off: new THREE.Vector3(), trkRate: 0, pos: new THREE.Vector3(), q: new THREE.Quaternion(), hdg: o.yaw, bank: roll, pitch, seen: now, phase: Math.random() * 10, label: null, player: o.color }; targets.set(key, t); }
      t.fix = fix; t.seen = now; t.mpPitch = pitch; t.mpRoll = roll; t.onGround = alt - (typeof Player !== 'undefined' ? Player.groundAt(Globe.ll2w(lat, lon).x, Globe.ll2w(lat, lon).z) : 0) < AIRCRAFT.byId[o.trip].fdm.cgHeight + 1;
    }
    for (const [k, t] of targets) if (t.player && !seen.has(k)) { removeLabel(t); targets.delete(k); }
  }
  function update(dt) {
    if (!enabled || typeof Globe === 'undefined' || typeof ACModel === 'undefined') { group.visible = false; return; }
    players(performance.now());
    if (!inited) { inited = true; try { initMeshes(); } catch (e) { console.error('traffic', e); enabled = false; return; } }
    group.visible = true;
    pollT -= dt;
    if (pollT <= 0 && !busy && !document.hidden) { pollT = fails > 3 ? 30 : 5; poll(); }
    draw(dt, performance.now());
    // Bayline's scripted arrivals and departures step aside while the real ones are here
    if (typeof World !== 'undefined' && World.air && World.air.group) World.air.group.visible = targets.size < 3;
    lastCount = targets.size;
  }
  function nearest(p, r = 20000) { let best = null, bd = r; for (const t of targets.values()) { const d = t.pos.distanceTo(p); if (d < bd) { bd = d; best = t; } } return best ? { t: best, d: bd } : null; }
  return { update, nearest, get count() { return lastCount; }, get enabled() { return enabled; }, set enabled(v) { enabled = !!v; if (!v) { group.visible = false; } }, targets, group };
})();
