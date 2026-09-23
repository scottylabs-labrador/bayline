// Flight: fly real aircraft types from any of the world's airports (see 46_aircraft.js, 47_fdm.js, 47_fcs.js,
// 48_acmodel.js; HUD, instruments and the setup panel in 49_fhud.js). Owns the aircraft, its physics, the flight
// controls (keyboard, gamepad, touch), the cameras (cockpit, chase, orbit, tower, flyby), warnings and callouts,
// landing scoring and crashes. The frame follows the aircraft around the planet (Globe rebase); over the Peninsula
// the aircraft flies over Bayline's own terrain, towns and trains.
//   Flight.start({ type, apt, rw, end, pos: 'runway' | 'final' | 'air', assist })   Flight.stop()
//   Flight.update(dt) -> true while flying (the main loop then skips the Bayline player camera)
const Flight = (() => {
  const D = Math.PI / 180, KT = 0.514444, FT = 0.3048, NM = 1852, G = 9.80665;
  const V3 = THREE.Vector3, Q4 = THREE.Quaternion;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v), lerp = (a, b, t) => a + (b - a) * t;
  const wrap = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
  const qFix = new Q4().setFromAxisAngle(new V3(1, 0, 0), -Math.PI / 2);      // model axes (x fwd, y up, z right) -> body FRD
  const qCam = new Q4().setFromAxisAngle(new V3(0, 1, 0), -Math.PI / 2);      // a camera looking down model +x

  let active = false, T = null, ac = null, fcs = null, model = null, cfg = null, loading = false;
  let paused = false, crashed = null, landed = null, airTime = 0, flightTime = 0, maxAgl = 0, gLast = null, gLastX = 0, gLastZ = 0;
  const E = {};                                                                  // euler of the aircraft (instruments)
  const wind = new V3(), gust = new V3();
  const env = { ground: groundFn, wind, pre: null };
  const gnd = { h: 0, water: false, soft: false };
  const prefs = (() => { try { return JSON.parse(localStorage.getItem('bl-flight') || '{}'); } catch (e) { return {}; } })();
  const savePrefs = () => { try { localStorage.setItem('bl-flight', JSON.stringify(prefs)); } catch (e) {} };

  // ---------------------------------------------------------------- the ground under a point (physics)
  function groundFn(x, z) {
    const ap = Airports.groundAt(x, z);
    if (Globe.inBayline(x, z)) {
      const t = Terrain.h(x, z), wtr = ap === null && Terrain.isWater(x, z);
      gnd.h = ap !== null ? Math.max(ap, t) : wtr ? Math.max(t, 0.3) : t; gnd.water = wtr && gnd.h < 1; gnd.soft = ap === null;
    } else {
      const h = Globe.h(x, z); gnd.h = ap !== null ? Math.max(ap, h) : Math.max(h, 0); gnd.water = ap === null && h <= 0.25; gnd.soft = ap === null;
    }
    return gnd;
  }

  // ---------------------------------------------------------------- start / stop
  function runwayChoice(a, want) {
    const rws = a.runways.filter(r => !r.approx && r.surf !== 2);
    const list = rws.length ? rws : a.runways;
    if (want) for (const rw of list) { if (rw.le === want) return { rw, end: 0 }; if (rw.he === want) return { rw, end: 1 }; }
    const rw = list.slice().sort((p, q) => q.L - p.L)[0];
    // into the wind when we know it, else the end facing most westerly (the common flow in mid-latitudes)
    const g = Airports.geom(a, rw), hd0 = g.hdg * D, from = Math.atan2(-wind.x, wind.z);   // direction the wind comes from
    const score = (h) => wind.lengthSq() > 1 ? -Math.cos(h - from) : Math.cos(h - 285 * D);
    return { rw, end: score(hd0 + Math.PI) > score(hd0) ? 1 : 0 };
  }
  async function start(c) {
    if (loading) return; loading = true;
    try {
      const type = AIRCRAFT.byId[c.type] || AIRCRAFT.byId.c172;
      const a = c.apt; if (!a) throw new Error('no airport');
      if (active) stop(true);
      // move the frame to the airport (the camera and everything else convert through lat/lon)
      const w0 = Globe.ll2w(a.lat, a.lon);
      if (Math.hypot(w0.x, w0.z) > 60000 || (Globe.frame.bay && !Globe.inBayline(w0.x, w0.z) && Math.hypot(w0.x, w0.z) > 140000)) Globe.setFrame(a.lat, a.lon);
      Env.setSolarLocation(a.lat, a.lon);
      if (c.time !== undefined && c.time !== null && c.time !== 'now') Env.setLocalClock(c.time * 3600);
      else if (c.time === 'now') Env.goLive();
      const { rw, end } = c.rw ? { rw: c.rw, end: c.end || 0 } : runwayChoice(a, c.rwIdent);
      const e0 = Airports.runwayEnd(a, rw, end);
      // tiles under the start point first (elevation for the physics, imagery follows): park the free camera there
      Player.fly.x = e0.x; Player.fly.y = e0.elev + 60; Player.fly.z = e0.z; if (Player.mode !== 'fly') Player.setMode('fly');
      await Promise.race([Globe.ensure(e0.x, e0.z, 13), new Promise(r => setTimeout(r, 6000))]);
      Airports.ensureBuilt(a);                                                   // its runways are the ground we stand on
      const e = Airports.runwayEnd(a, rw, end), g = Airports.geom(a, rw);      // (the frame may have moved meanwhile)
      const hdg = e.hdg * D, ux = e.ux, uz = e.uz;
      const pos = c.pos || 'runway';
      T = type; ac = FDM.create(T.fdm); fcs = FCS.create(ac, T); env.pre = fcs.pre;
      fcs.assist = c.assist || prefs.assist || 'full';
      const nF = T.fdm.flaps.length - 1, toFlap = T.id === 'c172' ? 1 : T.id === 'f16' ? 0 : Math.min(nF, T.id === 'a320' ? 2 : 3);
      const vref = AIRCRAFT.vref(T), vapp = vref + (T.fdm.retract ? 5 : 5);
      if (pos === 'runway') {
        const u0 = end ? g.len : 0, s = end ? -1 : 1, back = T.model.L * 0.55 + 12;
        const u = u0 + s * back, x = g.ax + g.ux * u, z = g.az + g.uz * u;
        const h = groundFn(x, z).h;
        ac.place({ x, y: h, z, hdg, onGround: true, flaps: toFlap, thr: 0 });
        ac.settle(env);
        ac.ctl.park = 1; ac.ctl.thr = 0;
      } else if (pos === 'final') {
        const d = (c.dist || 8) * NM, aimX = e.x + ux * 300, aimZ = e.z + uz * 300;
        const x = aimX - ux * d, z = aimZ - uz * d, h = e.elev + Math.tan(3 * D) * d + T.fdm.cgHeight;
        ac.place({ x, y: h, z, hdg, pitch: 2 * D, speed: vapp * KT, gear: 1, flaps: nF, thr: 0.45 });
        fcs.air = 5; fcs.law = 'flight'; fcs.gammaHold = -3 * D; fcs.wasAir = true;
        if (fcs.assist !== 'direct') { fcs.ap.athr = true; fcs.ap.spd = Math.round(vapp); fcs.ap.thrI = 0.45; }
        if (T.id === 'f16') ac.ctl.flaps = 1;
      } else {
        const d = (c.dist || 12) * 1000, agl = (T.fdm.retract ? 3000 : 2000) * FT;
        const x = e.x - ux * d, z = e.z - uz * d, h = Math.max(e.elev, groundFn(x, z).h) + agl;
        const spd = T.fdm.retract ? (T.id === 'f16' ? 300 : 220) : 100;
        ac.place({ x, y: h, z, hdg, speed: spd * KT, gear: 0, flaps: 0, thr: 0.6 });
        fcs.air = 5; fcs.law = 'flight'; fcs.gammaHold = 0; fcs.wasAir = true;
        if (fcs.assist !== 'direct') { fcs.ap.athr = true; fcs.ap.spd = spd; fcs.ap.thrI = 0.55; }
      }
      model = ACModel.build(T); Env.scene.add(model.root);
      cfg = { ...c, type: T.id, rw, end, apt: a, e, vref, vapp };
      active = true; paused = false; crashed = null; landed = null; airTime = 0; flightTime = 0; maxAgl = 0; gLast = null; warn.clear(); callout.reset();
      input.reset(); cam.mode = prefs.cam || 'chase'; cam.reset();
      FDM.euler(ac.q, E); placeModel(); updateCamera(0.016, true);
      prefs.type = T.id; prefs.apt = a.ident; savePrefs();
      if (typeof FHud !== 'undefined') FHud.show(true);
      UI.setStripOff(true);
      UI.setPlaceFn(placeLabel); UI.setSubFn(subLine);
      if (typeof Net !== 'undefined') {}
      const where = `${a.ident}${a.iata ? ' / ' + a.iata : ''} · ${a.name}`;
      UI.toast(pos === 'runway' ? `${T.name} on runway ${e.ident}, ${where}. Hold W for takeoff power (the parking brake lets go), ↓ to rotate at ${T.v.r} kt, G gear up. H: all keys` : pos === 'final' ? `${T.name} on an ${c.dist || 8} nm final to runway ${e.ident}, ${where}` : `${T.name} inbound to ${where}`, 7);
      emit('start', cfg);
    } finally { loading = false; }
  }
  function stop(keepCamera) {
    if (model) { Env.scene.remove(model.root); model.dispose(); model = null; }
    const was = active; active = false; ac = null; fcs = null;
    if (typeof FHud !== 'undefined') FHud.show(false);
    if (typeof FSound !== 'undefined') FSound.stop();
    Env.state.shadowTarget = null;
    UI.setStripOff(false); UI.setPlaceFn(null); UI.setSubFn(null);
    if (was && !keepCamera) { const p = Env.camera.position; Player.fly.x = p.x; Player.fly.y = p.y; Player.fly.z = p.z; Player.setMode('fly'); }
    if (was) emit('stop');
  }

  // ---------------------------------------------------------------- the frame moves: carry the aircraft and cameras over
  function initFrameHook() {
    Globe.onFrame((f, o) => {
      const cv = (p) => { const lat = o.lat0 - p.z / o.mlat, lon = o.lon0 + p.x / o.mlon; p.x = (lon - f.lon0) * f.mlon; p.z = -(lat - f.lat0) * f.mlat; };
      if (ac) { cv(ac.pos); placeModel(); }
      for (const p of [cam.pos, cam.tower, cam.flyby]) if (p) cv(p);
      if (cfg) { const e = Airports.runwayEnd(cfg.apt, cfg.rw, cfg.end); cfg.e = e; if (fcs && fcs.ap.rwy) setApproachRunway(fcs.ap.rwyApt, fcs.ap.rwyRw, fcs.ap.rwyEnd); }
    });
  }

  // ---------------------------------------------------------------- input
  const input = (() => {
    const keys = new Set(); let stick = { p: 0, r: 0, y: 0 }, trimHold = 0;
    const touch = { p: 0, r: 0, active: false, thr: null };
    const flightKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyF', 'KeyR', 'KeyG', 'KeyB', 'Space', 'KeyZ', 'KeyT',
      'KeyC', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'KeyY', 'KeyU', 'KeyI', 'BracketLeft', 'BracketRight', 'Comma', 'Period', 'Semicolon', 'Quote', 'PageUp', 'PageDown',
      'Equal', 'Minus', 'Home', 'End', 'KeyX', 'KeyN', 'Tab', 'KeyO', 'Backslash']);
    function down(e) {
      if (!active) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
      if (e.code === 'Escape') { if (typeof FHud !== 'undefined' && FHud.menuOpen()) FHud.menu(false); else { FHud.menu(true); } e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (!flightKeys.has(e.code)) return;                                    // H, M, P, L, K, V... go to the main handler
      e.preventDefault(); e.stopImmediatePropagation();
      if (typeof FHud !== 'undefined' && FHud.menuOpen()) return;
      keys.add(e.code);
      if (e.repeat) return;
      press(e.code, e);
    }
    function up(e) { keys.delete(e.code); if (active && flightKeys.has(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); } }
    function press(code, e) {
      const c = ac.ctl, nF = T.fdm.flaps.length - 1, A = fcs.ap, sh = e && e.shiftKey;
      switch (code) {
        case 'KeyF': c.flaps = Math.min(nF, Math.round(c.flaps) + 1); say('flaps', T.fdm.flaps[c.flaps].label); break;
        case 'KeyR': c.flaps = Math.max(0, Math.round(c.flaps) - 1); say('flaps', T.fdm.flaps[c.flaps].label); break;
        case 'KeyG': if (!T.fdm.retract) { UI.toast('Fixed landing gear'); break; } if (ac.out.onGround && c.gear > 0.5) { UI.toast('Weight on wheels: the gear stays down'); break; } c.gear = c.gear > 0.5 ? 0 : 1; say('gear', c.gear ? 'DOWN' : 'UP');
          if (T.id === 'f16') c.flaps = c.gear ? 1 : 0; break;
        case 'KeyB': c.park = c.park ? 0 : 1; say('park', c.park ? 'SET' : 'RELEASED'); break;
        case 'KeyZ': { const lv = [0, 0.5, 1]; const i = lv.findIndex(v => Math.abs(v - c.spoiler) < 0.1); c.spoiler = lv[(i + 1) % lv.length]; say('spoilers', c.spoiler ? (c.spoiler > 0.9 ? 'FULL' : 'HALF') : 'RETRACTED'); break; }
        case 'KeyC': cam.cycle(sh ? -1 : 1); break;
        case 'Digit1': cam.set('cockpit'); break; case 'Digit2': cam.set('chase'); break; case 'Digit3': cam.set('orbit'); break; case 'Digit4': cam.set('tower'); break; case 'Digit5': cam.set('flyby'); break;
        case 'KeyY': toggleAP(); break;
        case 'KeyU': A.athr = !A.athr; if (A.athr) { A.spd = Math.round(ac.out.cas / KT); A.thrI = c.thr; A.retard = false; } say('A/THR', A.athr ? 'ON' : 'OFF'); break;
        case 'KeyI': armApproach(); break;
        case 'BracketLeft': case 'BracketRight': { const d = (code === 'BracketLeft' ? -1 : 1) * (sh ? 1 : 5); A.hdg = ((Math.round((A.hdg === null ? E.hdg / D : A.hdg / D) + d) % 360 + 360) % 360) * D; say('HDG', Math.round(A.hdg / D).toString().padStart(3, '0')); break; }
        case 'Comma': case 'Period': { const d = (code === 'Comma' ? -1 : 1) * (sh ? 100 : 1000); const cur = A.alt === null ? Math.round(ac.pos.y / FT / 100) * 100 : A.alt / FT; A.alt = Math.max(0, Math.round((cur + d) / 100) * 100) * FT; say('ALT', Math.round(A.alt / FT) + ' ft'); break; }
        case 'Semicolon': case 'Quote': { const d = (code === 'Semicolon' ? -1 : 1) * (sh ? 1 : 5); A.spd = Math.max(40, Math.round((A.spd === null ? ac.out.cas / KT : A.spd) + d)); say('SPD', A.spd + ' kt'); break; }
        case 'KeyX': fcs.assist = fcs.assist === 'full' ? 'fbw' : fcs.assist === 'fbw' ? 'direct' : 'full'; prefs.assist = fcs.assist; savePrefs(); UI.toast({ full: 'Assisted handling: fly-by-wire with auto-flare', fbw: 'Fly-by-wire, you flare', direct: 'Direct control: the stick moves the surfaces (trim: Home / End)' }[fcs.assist], 4); break;
        case 'KeyO': ac.ctl.brake = 0; break;
        case 'Tab': cam.set(cam.mode === 'cockpit' ? 'chase' : 'cockpit'); break;
      }
    }
    // gamepad: left stick pitch / roll, right stick x rudder, triggers throttle, A gear, X / Y flaps, B brakes, LB / RB camera
    let padPrev = [];
    function pad(dt) {
      const gp = navigator.getGamepads ? [...navigator.getGamepads()].find(g => g && g.connected && g.axes.length >= 2) : null; if (!gp) return null;
      const dz = (v) => Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92;
      const b = gp.buttons.map(x => x.pressed), was = padPrev; padPrev = b;
      const edge = (i) => b[i] && !was[i];
      if (edge(0)) press('KeyG'); if (edge(2)) press('KeyF'); if (edge(3)) press('KeyR'); if (edge(4)) cam.cycle(-1); if (edge(5)) cam.cycle(1);
      if (edge(8)) press('KeyZ'); if (edge(9)) FHud.menu(!FHud.menuOpen()); if (edge(12)) press('KeyY'); if (edge(13)) press('KeyU');
      const rt = gp.buttons[7] ? gp.buttons[7].value : 0, lt = gp.buttons[6] ? gp.buttons[6].value : 0;
      if (rt > 0.05 || lt > 0.05) ac.ctl.thr = clamp(ac.ctl.thr + (rt - lt) * dt * 0.6, 0, T.fdm.engines[0].ab ? 1.1 : 1);
      return { p: dz(gp.axes[1]), r: dz(gp.axes[0]), y: gp.axes.length > 2 ? dz(gp.axes[2]) : 0, brake: !!b[1] };
    }
    function update(dt) {
      const k = (...c) => c.some(x => keys.has(x));
      const shift = keys.has('ShiftLeft') || keys.has('ShiftRight');
      const P = fcs.pil, c = ac.ctl;
      // trim (direct mode): Home / End, or Shift + up / down
      const trimIn = (k('Home') ? -1 : 0) + (k('End') ? 1 : 0);
      if (trimIn) c.trim = clamp(c.trim + trimIn * dt * 0.25, -1, 1);
      // keyboard stick: ramps toward the key, springs back when released (fine control from taps)
      const wantP = (k('ArrowDown') ? 1 : 0) - (k('ArrowUp') ? 1 : 0), wantR = (k('ArrowRight') ? 1 : 0) - (k('ArrowLeft') ? 1 : 0);
      const wantY = (k('KeyD', 'KeyE') ? 1 : 0) - (k('KeyA', 'KeyQ') ? 1 : 0);
      const toward = (v, w, up, dn) => w ? clamp(v + Math.sign(w - v) * Math.min(Math.abs(w - v), up * dt), -1, 1) : v - Math.sign(v) * Math.min(Math.abs(v), dn * dt);
      stick.p = toward(stick.p, wantP, 1.6, 4); stick.r = toward(stick.r, wantR, 2.4, 5); stick.y = toward(stick.y, wantY, 2, 4);
      let p = stick.p, r = stick.r, y = stick.y;
      const gp = pad(dt); if (gp) { if (Math.abs(gp.p) > Math.abs(p)) p = gp.p; if (Math.abs(gp.r) > Math.abs(r)) r = gp.r; if (Math.abs(gp.y) > Math.abs(y)) y = gp.y; }
      if (touch.active) { p = touch.p; r = touch.r; }
      P.pitch = p; P.roll = r; P.yaw = y;
      // pilot input takes the autopilot off
      if (fcs.ap.on && (Math.abs(p) > 0.45 || Math.abs(r) > 0.45)) { fcs.ap.on = false; fcs.ap.appr = false; warn.flash('AUTOPILOT OFF'); FSound && FSound.apOff(); }
      // throttle: W / S (or PageUp / PageDown, = / -) held; a throttle move takes the autothrottle off
      const tUp = k('KeyW', 'PageUp', 'Equal'), tDn = k('KeyS', 'PageDown', 'Minus');
      const tmax = T.fdm.engines.some(en => en.ab) ? 1.1 : 1;
      if (tUp && c.park && c.thr > 0.35 && ac.out.onGround) { c.park = 0; say('parking brake', 'RELEASED'); }
      if (tUp || tDn) { if (fcs.ap.athr) { fcs.ap.athr = false; say('A/THR', 'OFF'); } c.thr = clamp(c.thr + ((tUp ? 1 : 0) - (tDn ? 1 : 0)) * dt * (shift ? 1.5 : 0.45), 0, tmax); if (c.thr > 1 && c.thr < 1.02 && tUp) c.thr = 1.021; }
      if (touch.thr !== null) { c.thr = touch.thr * tmax; if (fcs.ap.athr) fcs.ap.athr = false; }
      c.rev = k('KeyT') && ac.out.onGround ? 1 : 0; if (c.rev) c.thr = 0;
      c.brake = k('Space') || (gp && gp.brake) ? 1 : (fcs.autoBrakeActive ? c.brake : 0);
    }
    function reset() { keys.clear(); stick = { p: 0, r: 0, y: 0 }; }
    window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true);
    window.addEventListener('blur', () => keys.clear());
    return { update, reset, keys, touch, press };
  })();
  function say(what, v) { if (typeof FHud !== 'undefined') FHud.note(what + ' ' + v); }
  function toggleAP() {
    const A = fcs.ap;
    if (A.on) { A.on = false; A.appr = false; warn.flash('AUTOPILOT OFF'); if (typeof FSound !== 'undefined') FSound.apOff(); return; }
    if (ac.out.onGround) { UI.toast('The autopilot engages in flight'); return; }
    A.on = true; if (A.hdg === null) A.hdg = Math.round(E.hdg / D) * D; if (A.alt === null) A.alt = Math.round(ac.pos.y / FT / 100) * 100 * FT;
    if (A.vs === null) A.vs = (T.fdm.retract ? 1800 : 600) * FT / 60;
    if (!A.athr && fcs.assist !== 'direct') { A.athr = true; A.spd = Math.round(ac.out.cas / KT); A.thrI = ac.ctl.thr; }
    say('AP', 'ON'); A.gs = A.loc = A.flare = A.retard = false;
  }
  // approach: the best-aligned runway ahead within 40 km (a synthetic ILS to its aiming point)
  function setApproachRunway(a, rw, end) {
    const e = Airports.runwayEnd(a, rw, end);
    fcs.ap.rwy = { x: e.x, z: e.z, ux: e.ux, uz: e.uz, elev: e.elev, aim: 300, ident: e.ident, apt: a.ident };
    fcs.ap.rwyApt = a; fcs.ap.rwyRw = rw; fcs.ap.rwyEnd = end;
  }
  function findApproach() {
    const ll = Globe.w2ll(ac.pos.x, ac.pos.z); let best = null, bs = -1e9;
    for (const n of Airports.near(ll.lat, ll.lon, 45000)) for (const rw of n.apt.runways) { if (rw.approx || rw.surf === 2) continue;
      for (const end of [0, 1]) { const e = Airports.runwayEnd(n.apt, rw, end); const dx = e.x - ac.pos.x, dz = e.z - ac.pos.z, d = Math.hypot(dx, dz);
        const brg = Math.atan2(dx, -dz), align = Math.cos(wrap(e.hdg * D - E.hdg)), toward = Math.cos(wrap(brg - E.hdg));
        const s = align * 2 + toward - d / 20000 + (rw.L > 1800 ? 0.3 : 0) + (T.fdm.retract && rw.L < 1200 ? -3 : 0);
        if (align > 0.3 && toward > 0.2 && s > bs) { bs = s; best = { a: n.apt, rw, end }; } } }
    return best;
  }
  function armApproach() {
    const A = fcs.ap;
    if (A.appr) { A.appr = false; A.gs = A.loc = false; say('APPR', 'OFF'); return; }
    const b = findApproach(); if (!b) { UI.toast('No runway ahead to approach (within 45 km, roughly aligned)'); return; }
    setApproachRunway(b.a, b.rw, b.end);
    if (!A.on) toggleAP();
    A.appr = true; A.gs = A.loc = A.flare = A.retard = false;
    if (fcs.assist !== 'direct') { A.athr = true; A.spd = Math.round(AIRCRAFT.vref(T, ac.mass) + 5); }
    UI.toast(`Approach armed: runway ${A.rwy.ident} at ${b.a.ident}. Set flaps (F) and gear (G); the autopilot captures the centreline, then the glide path, and lands`, 7);
  }

  // ---------------------------------------------------------------- cameras
  const cam = {
    mode: 'chase', yaw: 0, pitch: 0.12, dist: 0, zoom: 1, look: { yaw: 0, pitch: 0 }, pos: new V3(), tower: null, flyby: null, smoothYaw: null, smoothPitch: 0, fov: 60, towerApt: null,
    MODES: ['cockpit', 'chase', 'orbit', 'tower', 'flyby'],
    set(m) { this.mode = m; this.look.yaw = 0; this.look.pitch = m === 'cockpit' ? -0.06 : 0; if (m === 'tower') this.tower = null; if (m === 'flyby') this.flyby = null; prefs.cam = m; savePrefs(); FHud && FHud.note({ cockpit: 'Cockpit', chase: 'Chase', orbit: 'Orbit', tower: 'Tower', flyby: 'Flyby' }[m] + ' camera'); },
    cycle(d) { const i = this.MODES.indexOf(this.mode); this.set(this.MODES[(i + d + this.MODES.length) % this.MODES.length]); },
    reset() { this.yaw = 0; this.pitch = 0.12; this.zoom = 1; this.smoothYaw = null; this.tower = null; this.flyby = null; this.look.yaw = 0; this.look.pitch = this.mode === 'cockpit' ? -0.06 : 0; },
  };
  // mouse: drag to look / orbit, wheel to zoom
  (function mouse() {
    const c = Env.canvas; let drag = null;
    c.addEventListener('mousedown', (e) => { if (!active) return; drag = { x: e.clientX, y: e.clientY }; }, true);
    window.addEventListener('mouseup', () => { drag = null; });
    window.addEventListener('mousemove', (e) => { if (!active || !drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (cam.mode === 'cockpit') { cam.look.yaw = clamp(cam.look.yaw + dx * 0.004, -2.6, 2.6); cam.look.pitch = clamp(cam.look.pitch - dy * 0.004, -1.2, 1.2); }
      else { cam.yaw -= dx * 0.005; cam.pitch = clamp(cam.pitch + dy * 0.004, -0.6, 1.45); } });
    c.addEventListener('wheel', (e) => { if (!active) return; e.preventDefault(); e.stopImmediatePropagation(); cam.zoom = clamp(cam.zoom * (e.deltaY > 0 ? 1.12 : 0.89), 0.25, 8); }, { passive: false, capture: true });
    c.addEventListener('dblclick', () => { if (active) { cam.yaw = 0; cam.pitch = 0.12; cam.look.yaw = 0; cam.look.pitch = cam.mode === 'cockpit' ? -0.06 : 0; } });
  })();
  const tq = new Q4(), tq2 = new Q4(), tv = new V3(), tv2 = new V3(), tv3 = new V3(), qModel = new Q4();
  function placeModel() { if (!model || !ac) return; qModel.copy(ac.q).multiply(qFix); model.root.quaternion.copy(qModel); model.root.position.copy(ac.pos); model.root.updateMatrixWorld(true); }
  function updateCamera(dt, snap) {
    const c = Env.camera, m = T.model, size = Math.max(m.L, T.fdm.b);
    const k = 1 - Math.exp(-dt * 5);
    c.up.set(0, 1, 0);
    let fov = 60, near = 0.3;
    if (cam.mode === 'cockpit') {
      tv.copy(model.eye).applyQuaternion(qModel).add(ac.pos);
      // a little head motion: g-load and runway bumps
      const bump = ac.out.onGround ? Math.sin(flightTime * 37) * Math.min(1, ac.out.gs / 60) * 0.004 : 0;
      c.position.copy(tv); c.position.y += bump - clamp(ac.out.nz - 1, -1, 3) * 0.012;
      tq.setFromAxisAngle(tv2.set(0, 1, 0), -cam.look.yaw); tq2.setFromAxisAngle(tv3.set(1, 0, 0), cam.look.pitch);
      c.quaternion.copy(qModel).multiply(tq).multiply(qCam).multiply(tq2);
      fov = 62 / Math.sqrt(cam.zoom); near = 0.04;
    } else if (cam.mode === 'chase') {
      const hd = E.hdg; if (cam.smoothYaw === null || snap) cam.smoothYaw = hd;
      cam.smoothYaw += wrap(hd - cam.smoothYaw) * (1 - Math.exp(-dt * 3.2));
      cam.smoothPitch = lerp(cam.smoothPitch, clamp(E.pitch, -0.5, 0.5) * 0.5, 1 - Math.exp(-dt * 2.5));
      const dist = (size * 1.05 + 8) * cam.zoom, yaw = cam.smoothYaw + cam.yaw, pit = cam.pitch + cam.smoothPitch * 0.4;
      tv.set(-Math.sin(yaw) * Math.cos(pit), Math.sin(pit), Math.cos(yaw) * Math.cos(pit)).multiplyScalar(dist).add(ac.pos);
      const gy = groundFn(tv.x, tv.z).h + 1.5; if (tv.y < gy) tv.y = gy;
      c.position.copy(tv); tv2.copy(ac.pos); tv2.y += size * 0.08; c.lookAt(tv2);
    } else if (cam.mode === 'orbit') {
      const dist = (size * 1.3 + 10) * cam.zoom, yaw = cam.yaw, pit = cam.pitch;
      tv.set(Math.sin(yaw) * Math.cos(pit), Math.sin(pit), Math.cos(yaw) * Math.cos(pit)).multiplyScalar(dist).add(ac.pos);
      const gy = groundFn(tv.x, tv.z).h + 1.5; if (tv.y < gy) tv.y = gy;
      c.position.copy(tv); c.lookAt(ac.pos);
    } else if (cam.mode === 'tower') {
      if (!cam.tower || cam.tower.distanceTo(ac.pos) > 9000) {
        const ll = Globe.w2ll(ac.pos.x, ac.pos.z), n = Airports.nearest(ll.lat, ll.lon, null, 12000);
        if (n) { const a = n.apt, rw = a.runways.find(r => !r.approx) || a.runways[0], g = Airports.geom(a, rw); const mx = (g.ax + g.bx) / 2, mz = (g.az + g.bz) / 2;
          const side = ((ac.pos.x - mx) * -g.uz + (ac.pos.z - mz) * g.ux) > 0 ? 1 : -1; const off = Math.max(260, rw.W * 4);
          cam.tower = new V3(mx - g.uz * off * side, 0, mz + g.ux * off * side); cam.tower.y = groundFn(cam.tower.x, cam.tower.z).h + 32; }
        else { cam.tower = ac.pos.clone().add(tv.set(400, 0, 400)); cam.tower.y = groundFn(cam.tower.x, cam.tower.z).h + 40; }
      }
      c.position.copy(cam.tower); c.lookAt(ac.pos);
      const d = c.position.distanceTo(ac.pos); fov = clamp(2 * Math.atan(size * 1.6 / d) / D, 2, 60) / cam.zoom;
    } else {   // flyby: wait ahead of the aircraft, watch it pass, then move ahead again
      const v = ac.vel.length();
      if (!cam.flyby || tv.copy(ac.pos).sub(cam.flyby).dot(tv2.copy(ac.vel).normalize()) > size * 3 + 60 || cam.flyby.distanceTo(ac.pos) > 6000) {
        const ahead = Math.max(v * 4.5, size * 5), dir = tv2.copy(ac.vel).setY(0); if (dir.lengthSq() < 1) dir.set(Math.sin(E.hdg), 0, -Math.cos(E.hdg)); dir.normalize();
        const side = (Math.random() < 0.5 ? -1 : 1) * (size * 0.9 + 12);
        cam.flyby = ac.pos.clone().addScaledVector(dir, ahead).add(tv3.set(-dir.z * side, 0, dir.x * side));
        cam.flyby.y = Math.max(ac.pos.y + ac.vel.y * 4 + (Math.random() - 0.3) * size * 0.4, groundFn(cam.flyby.x, cam.flyby.z).h + 2.2);
      }
      c.position.copy(cam.flyby); c.lookAt(ac.pos);
      const d = c.position.distanceTo(ac.pos); fov = clamp(2 * Math.atan(size * 1.4 / d) / D, 8, 70) / Math.sqrt(cam.zoom);
    }
    if (c.aspect < 1) fov = Math.min(100, 2 * Math.atan(Math.tan(fov * D / 2) / Math.pow(c.aspect, 0.75)) / D);
    cam.fov = snap ? fov : lerp(cam.fov, fov, 1 - Math.exp(-dt * 6)); c.fov = cam.fov;
    c.near = near; c.far = clamp(Math.sqrt(2 * 6371000 * Math.max(c.position.y, 0) + 1e8) * 1.25 + 60000, 140000, 900000);
    c.updateProjectionMatrix(); c.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- warnings, callouts, events
  const warn = (() => {
    let list = [], flashT = 0, flashTxt = '';
    return { clear() { list = []; flashT = 0; }, set(l) { list = l; }, flash(t) { flashTxt = t; flashT = 3; }, get list() { return flashT > 0 ? [flashTxt, ...list] : list; }, tick(dt) { flashT -= dt; } };
  })();
  const callout = (() => {
    let said = new Set(), lastAgl = 1e9;
    const RA = [2500, 1000, 500, 400, 300, 200, 100, 50, 40, 30, 20, 10];
    return {
      reset() { said = new Set(); lastAgl = 1e9; },
      tick() {
        const agl = ac.out.agl / FT, desc = ac.out.vs < -0.5;
        if (ac.gearPos > 0.9 && desc && !ac.out.onGround) for (const h of RA) if (lastAgl > h && agl <= h && !said.has(h)) { said.add(h); if (typeof FSound !== 'undefined') FSound.say(h === 2500 ? 'twenty five hundred' : h === 1000 ? 'one thousand' : String(h)); if (h === 20 && fcs.ap.athr === false && ac.ctl.thr > 0.1 && T.fdm.fbw === 'airbus') FSound.say('retard'); }
        if (agl > 2600) said.clear();
        lastAgl = agl;
      },
    };
  })();
  let warnT = 0;
  function events(dt) {
    const o = ac.out; flightTime += dt;
    const touchEv = o.touch; o.touch = null;
    if (!o.onGround) { airTime += dt; maxAgl = Math.max(maxAgl, o.agl); }
    // crash
    if (o.crashed && !crashed) {
      crashed = { why: o.crashed, t: flightTime, vs: o.vs, gs: o.gs };
      const why = { water: 'You went into the water.', gear: 'The landing gear collapsed: touchdown far too hard.', wingtip: 'A wingtip hit the ground.', engine: 'An engine pod struck the ground.', prop: 'Prop strike.',
        tail: 'Heavy tail strike.', belly: 'Belly impact.', terrain: 'Controlled flight into terrain.', nose: 'Nose-first impact.' }[o.crashed] || 'Crashed.';
      if (typeof FSound !== 'undefined') FSound.crash();
      if (typeof FHud !== 'undefined') FHud.crash(why, crashed);
      emit('crash', crashed);
      return;
    }
    // touchdown: grade the landing
    if (touchEv && airTime > 6 && !landed && touchEv.main !== false) {
      const t = touchEv, fpm = -t.vy / FT * 60; landed = { fpm, t: flightTime };
      const ll = Globe.w2ll(ac.pos.x, ac.pos.z), n = Airports.nearest(ll.lat, ll.lon, null, 6000);
      let rwInfo = null;
      if (n) for (const rw of n.apt.runways) { if (rw.approx) continue; const g = Airports.geom(n.apt, rw); const px = t.x - g.ax, pz = t.z - g.az, u = px * g.ux + pz * g.uz, v = -px * g.uz + pz * g.ux;
        if (u > -30 && u < g.len + 30 && Math.abs(v) < rw.W / 2 + 15) { const fromLE = u, dirLE = g.ux * ac.vel.x + g.uz * ac.vel.z > 0; const past = dirLE ? fromLE - rw.da : g.len - fromLE - rw.db; rwInfo = { apt: n.apt, rw, past, off: v, W: rw.W, ident: dirLE ? rw.le : rw.he }; break; } }
      FDM.euler(ac.q, E);
      const cas = ac.out.cas / KT, vref = AIRCRAFT.vref(T, ac.mass);
      let score = 100; const lines = [];
      const grade = fpm < 120 ? ['Butter', 0] : fpm < 240 ? ['Smooth', 5] : fpm < 400 ? ['Firm', 15] : fpm < 600 ? ['Hard', 35] : ['Very hard', 55];
      score -= grade[1]; lines.push(`Sink rate <b>${Math.round(fpm)} fpm</b> · ${grade[0]}`);
      if (rwInfo) {
        const off = Math.abs(rwInfo.off); score -= clamp((off - 2) * 2.5, 0, 25); lines.push(`Centreline <b>${off.toFixed(1)} m</b> ${rwInfo.off > 0 ? 'right' : 'left'}`);
        const p = rwInfo.past; score -= p < 0 ? 30 : clamp((Math.abs(p - 350) - 150) / 20, 0, 20); lines.push(`Touchdown <b>${Math.round(p)} m</b> past the threshold of ${rwInfo.ident} ${p < 0 ? '(short!)' : p > 900 ? '(long)' : ''}`);
      } else { score -= 40; lines.push('Not on a runway'); }
      const dv = cas - vref; score -= clamp(Math.abs(dv - 3) - 7, 0, 15); lines.push(`Speed <b>${Math.round(cas)} kt</b> (Vref ${Math.round(vref)})`);
      const bank = Math.abs(E.roll) / D; score -= clamp((bank - 2) * 3, 0, 15); lines.push(`Bank <b>${bank.toFixed(1)}°</b> · pitch ${(E.pitch / D).toFixed(1)}°`);
      if (o.tailStrike) { score -= 30; lines.push('<span class="late">Tail strike</span>'); }
      score = Math.round(clamp(score, 0, 100));
      landed.score = score; landed.lines = lines; landed.rw = rwInfo;
      UI.toast(`${grade[0]} · ${Math.round(fpm)} fpm${rwInfo ? ' · ' + Math.abs(rwInfo.off).toFixed(1) + ' m off centre' : ''}`, 5);
      if (typeof FSound !== 'undefined') FSound.touch(fpm);
      emit('landed', landed);
    }
    if (landed && o.onGround && o.gs < 3 && !landed.shown && flightTime - landed.t > 3) {
      landed.shown = true;
      UI.showResult({ kicker: 'Landing report', title: landed.rw ? `${T.short} on ${landed.rw.ident} at ${landed.rw.apt.ident}` : `${T.short} down`, score: landed.score, grade: landed.score >= 90 ? 'Excellent' : landed.score >= 75 ? 'Good' : landed.score >= 55 ? 'Fair' : 'Rough', lines: landed.lines });
    }
    if (!o.onGround && landed && airTime > 0 && o.agl > 15) { landed = null; }    // a bounce or a go-around: grade the next touchdown
    if (o.onGround) airTime = o.gs < 30 ? 0 : airTime;
    // warnings
    warnT -= dt; if (warnT > 0) return; warnT = 0.2;
    const W = [], agl = o.agl / FT, vsF = o.vs / FT * 60, cas = o.cas / KT;
    const stallSoon = !o.onGround && (o.alpha > o.aS - 2 * D || o.stall > 0.25) && cas > 20;
    if (stallSoon) W.push('STALL');
    if (cas > (T.v.mo || 999) + 4 || o.mach > (T.v.mmo || 9) + 0.01) W.push('OVERSPEED');
    if (!o.onGround && agl < 2500 && airTime > 5) {
      const lim = agl < 1000 ? -1500 - agl * 1.2 : -3000;
      if (vsF < lim * 1.5) W.push('PULL UP'); else if (vsF < lim) W.push('SINK RATE');
      if (T.fdm.retract && ac.gearPos < 0.5 && agl < 500 && vsF < -200 && cas < 190) W.push('TOO LOW · GEAR');
      const bank = Math.abs(E.roll) / D; if (T.fdm.fbw !== 'fighter' && bank > 40) W.push('BANK ANGLE');
    }
    if (o.tailStrike) W.push('TAIL STRIKE');
    if (ac.ctl.park && ac.ctl.thr > 0.3 && o.onGround) W.push('PARKING BRAKE');
    if (ac.flapPos > 0.5 && cas > ((T.v.fe || [])[Math.round(ac.flapPos) - 1] || 999) + 5) W.push('FLAP OVERSPEED');
    warn.set(W);
    if (typeof FSound !== 'undefined') FSound.warnings(W);
  }

  // ---------------------------------------------------------------- labels for the HUD / UI
  function placeLabel(x, z) {
    const ll = Globe.w2ll(x, z), n = Airports.nearest(ll.lat, ll.lon, null, 60000);
    if (!n) return `${Math.abs(ll.lat).toFixed(2)}° ${ll.lat >= 0 ? 'N' : 'S'}  ${Math.abs(ll.lon).toFixed(2)}° ${ll.lon >= 0 ? 'E' : 'W'}`;
    const brg = (Airports.bearing(ll.lat, ll.lon, n.apt.lat, n.apt.lon) + 360) % 360;
    return n.d < 3000 ? `${n.apt.name} (${n.apt.ident})` : `${(n.d / NM).toFixed(1)} nm ${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(brg / 45) % 8]} to ${n.apt.ident} · ${n.apt.city || n.apt.name}`;
  }
  function subLine() { if (!ac) return ''; return `${T.name} · ${Math.round(ac.pos.y / FT).toLocaleString()} ft · ${Math.round(ac.out.gs / KT)} kt GS`; }

  // ---------------------------------------------------------------- per frame
  function update(dt) {
    if (!active || !ac) return false;
    dt = Math.min(dt, 0.05);
    const menu = typeof FHud !== 'undefined' && FHud.menuOpen();
    if (!crashed && !menu) {
      input.update(dt);
      // light turbulence that grows with wind and near the ground in the afternoon
      gust.set(Math.sin(flightTime * 0.7) + Math.sin(flightTime * 1.9 + 1), Math.sin(flightTime * 1.3 + 2) * 0.6, Math.cos(flightTime * 0.9)).multiplyScalar(0.35 + wind.length() * 0.12);
      env.wind = tv3.copy(wind).add(gust);
      // the ground under a parked or taxiing aircraft can change as finer terrain streams in or a runway is refitted:
      // carry the aircraft with it instead of letting the gear springs launch it
      if (ac.out.onGround && ac.out.gs < 40) { const gh = groundFn(ac.pos.x, ac.pos.z).h; if (gLast !== null && Math.abs(gh - gLast) > 0.08 && Math.hypot(ac.pos.x - gLastX, ac.pos.z - gLastZ) < 3) ac.pos.y += gh - gLast; }
      ac.step(dt, env);
      gLast = groundFn(ac.pos.x, ac.pos.z).h; gLastX = ac.pos.x; gLastZ = ac.pos.z;
      events(dt);
      FDM.euler(ac.q, E);
      callout.tick();
      for (const ev of fcs.events.splice(0)) UI.toast(ev, 3);
    }
    warn.tick(dt);
    Env.state.shadowTarget = ac.out.agl > 250 ? { pos: ac.pos, size: Math.max(30, Math.max(T.model.L, T.fdm.b) * 0.75) } : null;
    placeModel();
    model.update(ac, dt, { night: U.uNight.value, inside: cam.mode === 'cockpit' });
    updateCamera(dt, false);
    if (typeof FHud !== 'undefined') FHud.draw(api, dt);
    if (typeof FSound !== 'undefined') FSound.update(api, dt);
    return true;
  }
  const listeners = []; const on = (f) => listeners.push(f); const emit = (e, d) => { for (const f of listeners) f(e, d); };
  function restart() { if (cfg) start({ ...cfg, rw: cfg.rw, end: cfg.end }); }
  function init() { initFrameHook(); }
  // hash: #fly=a320,KSFO,28R,final
  function fromHash(s) {
    const [type, ident, rwy, pos] = String(s).split(',');
    return Airports.load().then(() => { const a = Airports.byIdent(ident || prefs.apt || 'KSFO'); if (!a) return; return start({ type, apt: a, rwIdent: rwy, pos: pos || 'runway' }); });
  }
  const api = {
    init, start, stop, update, restart, fromHash, on, input, cam, warn, prefs,
    get active() { return active; }, get loading() { return loading; }, get ac() { return ac; }, get fcs() { return fcs; }, get type() { return T; }, get model() { return model; }, get cfg() { return cfg; },
    get crashed() { return crashed; }, get landed() { return landed; }, get euler() { return E; }, get flightTime() { return flightTime; }, groundFn, armApproach, toggleAP, findApproach,
  };
  return api;
})();
