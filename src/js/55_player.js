// Player: cameras and movement. Views: cab, onboard (walk the train), chase, trackside, heli, walk (ground),
// fly, orbit. Walking inside a car uses TrainKit floor/ramp/gangway metadata in car-local coordinates, so
// you can walk the whole consist while it moves, sit in seats, and step on/off at platforms through open doors.
const Player = (() => {
  const cam = () => Env.camera;
  const keys = new Set(); let pointerLocked = false;
  const look = { yaw: 0, pitch: 0 };            // for walk / fly / onboard / cab
  const orbit = { yaw: 0.6, pitch: 0.35, dist: 60, tx: 0, ty: 0, tz: 0, rel: true };
  let mode = 'orbit';                            // cab | onboard | chase | trackside | heli | walk | fly | orbit
  let focus = null;                              // train key followed
  const walk = { x: 0, y: 0, z: 0, vy: 0 };      // world walking (feet)
  const ob = { key: null, car: 0, x: 0, y: 0, z: 0, seat: -1 };   // onboard (car-local feet position)
  const fly = { x: 0, y: 400, z: 0, speed: 60 };
  const ts = { x: 0, y: 0, z: 0, s: -1, fov: 40 };            // trackside camera spot
  const heli = { ang: 0 };
  let fovTarget = 60; const EYE = 1.62;
  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4(), UP = new THREE.Vector3(0, 1, 0);
  const F = {};
  let prompt = '', promptAction = null;
  const listeners = [];
  const on = (fn) => listeners.push(fn);
  const emit = (ev, data) => { for (const f of listeners) f(ev, data); };

  // ---------- input ----------
  function init() {
    const c = Env.canvas;
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'Tab', 'Backspace'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => keys.delete(e.code));
    window.addEventListener('blur', () => keys.clear());
    let drag = null;
    c.addEventListener('mousedown', (e) => {
      c.focus();
      if (needsLock() && !pointerLocked && e.button === 0) { try { c.requestPointerLock(); } catch (err) {} return; }
      drag = { x: e.clientX, y: e.clientY, b: e.button };
    });
    window.addEventListener('mouseup', () => { drag = null; });
    window.addEventListener('mousemove', (e) => {
      if (pointerLocked) { look.yaw += e.movementX * 0.0022; look.pitch = U.clamp(look.pitch - e.movementY * 0.0022, -1.45, 1.45); return; }
      if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
        if (needsLock()) { look.yaw += dx * 0.004; look.pitch = U.clamp(look.pitch - dy * 0.004, -1.45, 1.45); }
        else { orbit.yaw -= dx * 0.005; orbit.pitch = U.clamp(orbit.pitch + dy * 0.004, -0.2, 1.52); } }
    });
    document.addEventListener('pointerlockchange', () => { pointerLocked = document.pointerLockElement === c; emit('lock', pointerLocked); });
    c.addEventListener('wheel', (e) => { e.preventDefault();
      if (mode === 'fly') fly.speed = U.clamp(fly.speed * (e.deltaY > 0 ? 0.85 : 1.18), 3, 3000);
      else if (!needsLock()) orbit.dist = U.clamp(orbit.dist * (e.deltaY > 0 ? 1.12 : 0.89), 8, mode === 'orbit' ? 60000 : 900);
      else fovTarget = U.clamp(fovTarget + (e.deltaY > 0 ? 4 : -4), 20, 85);
    }, { passive: false });
    // touch: one finger rotates / looks, two fingers pinch-zoom
    let t0 = null, pinch = 0;
    c.addEventListener('touchstart', (e) => { if (e.touches.length === 1) t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY }; if (e.touches.length === 2) pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }, { passive: true });
    c.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && t0) { const dx = e.touches[0].clientX - t0.x, dy = e.touches[0].clientY - t0.y; t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (needsLock()) { look.yaw += dx * 0.005; look.pitch = U.clamp(look.pitch - dy * 0.005, -1.45, 1.45); } else { orbit.yaw -= dx * 0.006; orbit.pitch = U.clamp(orbit.pitch + dy * 0.005, -0.2, 1.52); } }
      if (e.touches.length === 2) { const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (pinch) orbit.dist = U.clamp(orbit.dist * pinch / d, 8, 60000); pinch = d; }
    }, { passive: true });
  }
  const needsLock = () => mode === 'walk' || mode === 'fly' || mode === 'onboard' || mode === 'cab';
  const down = (...codes) => codes.some(c => keys.has(c));
  function releaseLock() { if (pointerLocked) document.exitPointerLock(); }

  // ---------- helpers ----------
  function focusTrain() { return focus ? Sim.trainByKey(focus) : null; }
  function cars(tr) { return tr && tr.entry ? tr.entry.consist.cars : null; }
  function leadCar(tr) { const cs = cars(tr); if (!cs) return null; return tr.dir ? cs[0] : cs[cs.length - 1]; }
  function setFocus(key) { focus = key; Sim.setFocus(key); }
  function groundAt(x, z) { const p = Stations.platformY(x, z); const t = Terrain.h(x, z); return p !== null ? Math.max(p, t) : Math.max(t, Terrain.isWater(x, z) ? 0.3 : t); }

  function setMode(m, opts = {}) {
    const prev = mode;
    if (m === 'cab' || m === 'onboard' || m === 'chase' || m === 'trackside' || m === 'heli') {
      if (!focusTrain()) { const tr = Sim.nearestTrain(cam().position, 1e9); if (!tr) { emit('toast', 'No trains running right now: try Explore at another time'); return; } setFocus(tr.key); }
    }
    if (prev === 'onboard' && m !== 'onboard') ob.seat = -1;
    mode = m;
    if (m === 'cab') { look.yaw = 0; look.pitch = -0.04; fovTarget = 58; }
    if (m === 'onboard') enterTrain(opts.car, opts.door);
    if (m === 'chase') { orbit.rel = true; orbit.yaw = Math.PI + 0.35; orbit.pitch = 0.22; orbit.dist = 70; fovTarget = 55; }
    if (m === 'orbit') { orbit.rel = false; fovTarget = 55; if (opts.target) { setFocus(null); orbit.tx = opts.target.x; orbit.ty = opts.target.y; orbit.tz = opts.target.z; } if (opts.dist) orbit.dist = opts.dist; }
    if (m === 'trackside') { ts.s = -1; }
    if (m === 'heli') { heli.ang = Math.random() * 6; fovTarget = 40; }
    if (m === 'walk') { if (opts.pos) { walk.x = opts.pos.x; walk.z = opts.pos.z; walk.y = opts.pos.y; look.yaw = opts.pos.yaw !== undefined ? yawFromHeading(opts.pos.yaw) : look.yaw; look.pitch = 0; } else { const p = cam().position; walk.x = p.x; walk.z = p.z; walk.y = groundAt(p.x, p.z); } fovTarget = 68; }
    if (m === 'fly') { const p = cam().position; fly.x = p.x; fly.y = Math.max(p.y, groundAt(p.x, p.z) + 3); fly.z = p.z; const d = cam().getWorldDirection(tmpV); look.yaw = Math.atan2(d.x, -d.z); look.pitch = Math.asin(U.clamp(d.y, -1, 1)); fovTarget = 62; }
    if (!needsLock()) releaseLock();
    emit('mode', m);
  }
  // our look.yaw convention for world modes: 0 = north (-Z), increases clockwise (east = +PI/2)
  const yawFromHeading = (h) => Math.PI - h;   // heading from atan2(dx, dz) -> look yaw

  // ---------- onboard walking ----------
  function regionY(car, x, z, curY) {
    let best = null, bd = 0.55;
    for (const r of car.floorRegions) if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) { const d = Math.abs(r.y - curY); if (d < bd) { bd = d; best = r.y; } }
    for (const r of car.ramps) if (x >= Math.min(r.x0, r.x1) && x <= Math.max(r.x0, r.x1) && z >= r.z0 && z <= r.z1) { const y = U.lerp(r.y0, r.y1, U.clamp((x - r.x0) / (r.x1 - r.x0), 0, 1)); const d = Math.abs(y - curY); if (d < bd) { bd = d; best = y; } }
    return best;
  }
  function enterTrain(carIdx, door) {
    const tr = focusTrain(); const cs = cars(tr); if (!cs) return;
    ob.key = tr.key; ob.seat = -1;
    let ci = carIdx !== undefined ? carIdx : Math.floor(cs.length / 2); const car = cs[ci];
    if (door) { ob.car = ci; ob.x = door.x; ob.z = door.side * (car.width / 2 - 0.75); const y = lowestFloorNear(car, ob.x, ob.z); ob.y = y; look.yaw = door.side > 0 ? -Math.PI / 2 : Math.PI / 2; look.pitch = 0; }
    else {
      // start in a seat on the upper deck if there is one, else the middle of the car
      const seats = car.seats.slice().sort((a, b) => b.y - a.y); const s = seats[Math.floor(seats.length * 0.3)] || null;
      ob.car = ci;
      if (s) { sit(car, car.seats.indexOf(s)); }
      else { const r = car.floorRegions[0]; ob.x = (r.x0 + r.x1) / 2; ob.z = (r.z0 + r.z1) / 2; ob.y = r.y; }
    }
    fovTarget = 70;
  }
  function lowestFloorNear(car, x, z) { let best = null, bd = 1e9; for (const r of car.floorRegions) { const cx = U.clamp(x, r.x0, r.x1), cz = U.clamp(z, r.z0, r.z1); const d = Math.hypot(cx - x, cz - z) + r.y * 0.3; if (d < bd) { bd = d; best = r; } } if (best) { ob.x = U.clamp(x, best.x0 + 0.2, best.x1 - 0.2); ob.z = U.clamp(z, best.z0 + 0.2, best.z1 - 0.2); return best.y; } return 1.2; }
  function sit(car, i) { const s = car.seats[i]; if (!s) return; ob.seat = i; Sim.freeSeat(focusTrain(), ob.car, i); ob.x = s.x; ob.z = s.z; ob.y = s.y - EYE + 0.35;
    // look out of the window, angled a little toward the direction the seat faces
    const sz = Math.sign(s.z) || 1; const fwd = Math.cos(s.yaw) >= 0 ? 1 : -1; look.yaw = sz * Math.PI / 2 - sz * fwd * 0.4; look.pitch = -0.06; }
  function stand(car) { const s = car.seats[ob.seat]; ob.seat = -1; if (!s) return; // step into the aisle
    let best = null, bd = 1e9; for (const r of car.floorRegions) { const cx = U.clamp(s.x, r.x0 + 0.25, r.x1 - 0.25), cz = U.clamp(0, r.z0 + 0.25, r.z1 - 0.25); const d = Math.hypot(cx - s.x, cz - s.z) + Math.abs(r.y - (s.y - 1.2)) * 2; if (d < bd) { bd = d; best = [cx, r.y, cz]; } }
    if (best) { ob.x = best[0]; ob.y = best[1]; ob.z = best[2]; } }
  function moveOnboard(dt) {
    const tr = Sim.trainByKey(ob.key); const cs = cars(tr); if (!cs) return false;
    let car = cs[ob.car]; if (!car) { ob.car = 0; car = cs[0]; }
    if (ob.seat >= 0) return true;
    const sp = (down('ShiftLeft', 'ShiftRight') ? 3.2 : 1.45) * dt;
    let fx = 0, fz = 0; if (down('KeyW', 'ArrowUp')) fx += 1; if (down('KeyS', 'ArrowDown')) fx -= 1; if (down('KeyD', 'ArrowRight')) fz += 1; if (down('KeyA', 'ArrowLeft')) fz -= 1;
    if (!fx && !fz) return true;
    const n = Math.hypot(fx, fz); fx /= n; fz /= n;
    const c = Math.cos(look.yaw), s = Math.sin(look.yaw);
    const dx = (fx * c - fz * s) * sp, dz = (fx * s + fz * c) * sp;
    let nx = ob.x + dx, nz = ob.z + dz;
    let y = regionY(car, nx, nz, ob.y);
    if (y === null) { y = regionY(car, nx, ob.z, ob.y); if (y !== null) nz = ob.z; else { y = regionY(car, ob.x, nz, ob.y); if (y !== null) nx = ob.x; } }
    if (y !== null) { ob.x = nx; ob.z = nz; ob.y = U.lerp(ob.y, y, 0.5); }
    // gangways into the neighbouring cars
    const g = car.gangways || {};
    if (g.front && nx > g.front.x && nz > g.front.z0 - 0.1 && nz < g.front.z1 + 0.1 && ob.car > 0) { const prev = cs[ob.car - 1]; ob.car--; ob.x = nx - (car.length + prev.length) / 2; ob.z = nz; ob.y = prev.gangways && prev.gangways.rear ? prev.gangways.rear.y : ob.y; }
    else if (g.rear && nx < g.rear.x && nz > g.rear.z0 - 0.1 && nz < g.rear.z1 + 0.1 && ob.car < cs.length - 1) { const next = cs[ob.car + 1]; ob.car++; ob.x = nx + (car.length + next.length) / 2; ob.z = nz; ob.y = next.gangways && next.gangways.front ? next.gangways.front.y : ob.y; }
    return true;
  }
  // nearest open door to the onboard player (car-local), or to a world position
  function doorNearOnboard(tr) {
    const cs = cars(tr); if (!cs || !tr.doorsOpen) return null; const car = cs[ob.car]; const side = tr.doorSide === 'right' ? 1 : -1;
    let best = null, bd = 2.2; for (const d of car.doors) { if (d.side !== side) continue; const dd = Math.hypot(d.x - ob.x, (d.side * car.width / 2) - ob.z); if (dd < bd) { bd = dd; best = d; } }
    return best;
  }
  function doorNearWorld(pos) {
    let best = null, bd = 6.5;
    for (const tr of Sim.running) {
      if (!tr.doorsOpen || !tr.entry || Math.hypot(tr.x - pos.x, tr.z - pos.z) > 400) continue;
      const cs = tr.entry.consist.cars; const side = tr.doorSide === 'right' ? 1 : -1;
      cs.forEach((car, ci) => { for (const d of car.doors) { if (d.side !== side) continue; tmpV.set(d.x, d.sillY || 1, d.side * (car.width / 2 + 0.4)); car.group.localToWorld(tmpV); const dd = Math.hypot(tmpV.x - pos.x, tmpV.z - pos.z); if (dd < bd) { bd = dd; best = { tr, ci, d }; } } });
    }
    return best;
  }
  function alight(tr, d) {
    const car = cars(tr)[ob.car]; tmpV.set(d.x, 0, d.side * (car.width / 2 + 1.1)); car.group.localToWorld(tmpV);
    const y = groundAt(tmpV.x, tmpV.z); const hd = Math.atan2(tmpV.x - car.group.position.x, tmpV.z - car.group.position.z);
    // face away from the train
    const n = Track.nearest(tmpV.x, tmpV.z, 50); let face = 0; if (n) { Track.frame(n.s, F); face = Math.atan2(F.rx * Math.sign(n.lat || 1), F.rz * Math.sign(n.lat || 1)); }
    ob.key = null; setMode('walk', { pos: { x: tmpV.x, y, z: tmpV.z, yaw: face } });
    emit('alight', { tr });
  }
  function board(hit) { setFocus(hit.tr.key); mode = 'onboard'; enterTrain(hit.ci, hit.d); emit('mode', 'onboard'); emit('board', { tr: hit.tr }); }

  // ---------- world walking ----------
  function moveWalk(dt) {
    const run = down('ShiftLeft', 'ShiftRight'); const sp = (run ? 5.2 : 1.6) * dt;
    let fx = 0, fz = 0; if (down('KeyW', 'ArrowUp')) fx += 1; if (down('KeyS', 'ArrowDown')) fx -= 1; if (down('KeyD', 'ArrowRight')) fz += 1; if (down('KeyA', 'ArrowLeft')) fz -= 1;
    if (fx || fz) { const n = Math.hypot(fx, fz); fx /= n; fz /= n;
      const c = Math.sin(look.yaw), s = -Math.cos(look.yaw);       // forward (x,z)
      const nx = walk.x + (fx * c - fz * s) * sp, nz = walk.z + (fx * s + fz * c) * sp;
      const gy = groundAt(nx, nz); if (gy - walk.y < 0.6 && !Terrain.isWater(nx, nz)) { walk.x = nx; walk.z = nz; } }
    const gy = groundAt(walk.x, walk.z);
    if (walk.y > gy + 0.05) { walk.vy -= 9.81 * dt; walk.y = Math.max(gy, walk.y + walk.vy * dt); } else { walk.vy = 0; walk.y = U.lerp(walk.y, gy, Math.min(1, dt * 12)); }
    if (down('Space') && walk.vy === 0 && Math.abs(walk.y - gy) < 0.1) walk.vy = 3.8, walk.y += 0.02;
  }

  // ---------- per-frame camera ----------
  function lookQuat(yaw, pitch, out) { // car-frame look (yaw 0 = +X, +yaw toward +Z)
    tmpV.set(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
    tmpM.lookAt(tmpV2.set(0, 0, 0), tmpV, UP); return out.setFromRotationMatrix(tmpM);
  }
  function worldLook(yaw, pitch) { // world: yaw 0 = north (-Z), clockwise
    const c = cam(); tmpV.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    tmpV2.copy(c.position).add(tmpV); c.up.set(0, 1, 0); c.lookAt(tmpV2);
  }
  let camShake = 0;
  function update(dt) {
    const c = cam();
    prompt = ''; promptAction = null;
    if (focus && !Sim.trainByKey(focus)) {
      // focused train ended its run
      if (mode === 'onboard' || mode === 'cab') { const st = Stations.nearest(c.position, 800); if (st) { const sp = Stations.spawnPoint(st, 0, {}); setMode('walk', { pos: sp }); emit('toast', 'End of the line: everybody off at ' + st.name); } else setMode('fly'); }
      setFocus(null);
      if (mode === 'chase' || mode === 'trackside' || mode === 'heli') { const tr = Sim.nearestTrain(c.position, 1e9); if (tr) setFocus(tr.key); else setMode('orbit', {}); }
    }
    const tr = focusTrain();
    switch (mode) {
      case 'cab': {
        const car = leadCar(tr); if (!car || !car.cabEye) { setMode('chase'); break; }
        const rear = !tr.dir; const e = car.cabEye;
        tmpV.set(e[0], e[1], e[2]); car.group.updateMatrixWorld(); car.group.localToWorld(tmpV); c.position.copy(tmpV);
        look.yaw = U.clamp(look.yaw, -1.9, 1.9);
        lookQuat((rear ? Math.PI : 0) + look.yaw, look.pitch, tmpQ); c.quaternion.copy(car.group.quaternion).multiply(tmpQ);
        break;
      }
      case 'onboard': {
        if (!tr || ob.key !== tr.key) { setMode('orbit'); break; }
        moveOnboard(dt);
        const car = cars(tr)[ob.car]; car.group.updateMatrixWorld();
        const eye = ob.seat >= 0 ? car.seats[ob.seat].y : ob.y + EYE;
        tmpV.set(ob.x, eye, ob.z); car.group.localToWorld(tmpV); c.position.copy(tmpV);
        lookQuat(look.yaw, look.pitch, tmpQ); c.quaternion.copy(car.group.quaternion).multiply(tmpQ);
        // interactions
        const d = doorNearOnboard(tr);
        if (d && ob.seat < 0) { prompt = 'Press <kbd>E</kbd> to step off'; promptAction = () => alight(tr, d); }
        else if (ob.seat >= 0) { prompt = 'Press <kbd>E</kbd> to stand up'; promptAction = () => stand(car); }
        else { let bi = -1, bd = 1.3; car.seats.forEach((s, i) => { const dd = Math.hypot(s.x - ob.x, s.z - ob.z) + Math.abs(s.y - EYE + 0.35 - ob.y); if (dd < bd) { bd = dd; bi = i; } }); if (bi >= 0) { prompt = 'Press <kbd>E</kbd> to sit'; promptAction = () => sit(car, bi); } }
        break;
      }
      case 'chase': case 'orbit': {
        let tx = orbit.tx, ty = orbit.ty, tz = orbit.tz, base = 0;
        if (mode === 'chase') { const car = leadCar(tr); if (!car) { setMode('orbit'); break; }
          const cs = cars(tr); const mid = cs[Math.min(1, cs.length - 1)] && (tr.dir ? cs[1] : cs[cs.length - 2]) || car; const g = car.group;
          tx = U.lerp(g.position.x, mid.group.position.x, 0.5); ty = g.position.y + 2.5; tz = U.lerp(g.position.z, mid.group.position.z, 0.5);
          Track.frame(tr.s, F); base = Math.atan2(F.dx, -F.dz) + (tr.dir ? 0 : Math.PI); orbit.tx = tx; orbit.ty = ty; orbit.tz = tz; }
        else if (!orbit.rel) { // free orbit: WASD pans the target
          const sp = orbit.dist * 0.9 * dt; const cy = Math.sin(orbit.yaw), sy = Math.cos(orbit.yaw);
          if (down('KeyW', 'ArrowUp')) { orbit.tx -= cy * sp; orbit.tz -= sy * sp; } if (down('KeyS', 'ArrowDown')) { orbit.tx += cy * sp; orbit.tz += sy * sp; }
          if (down('KeyA', 'ArrowLeft')) { orbit.tx -= sy * sp; orbit.tz += cy * sp; } if (down('KeyD', 'ArrowRight')) { orbit.tx += sy * sp; orbit.tz -= cy * sp; }
          if (down('KeyQ')) orbit.yaw += dt * 0.8; if (down('KeyE')) orbit.yaw -= dt * 0.8;
          orbit.ty = U.lerp(orbit.ty, groundAt(orbit.tx, orbit.tz), Math.min(1, dt * 3)); tx = orbit.tx; ty = orbit.ty; tz = orbit.tz;
          if (focus && tr) { const car = leadCar(tr); if (car) { orbit.tx = U.lerp(orbit.tx, car.group.position.x, Math.min(1, dt * 4)); orbit.tz = U.lerp(orbit.tz, car.group.position.z, Math.min(1, dt * 4)); orbit.ty = car.group.position.y + 2; } }
        }
        const yaw = base + orbit.yaw, p = orbit.pitch, d = orbit.dist;
        let cx = tx + Math.sin(yaw) * Math.cos(p) * d, cz = tz + Math.cos(yaw) * Math.cos(p) * d, cy = ty + Math.sin(p) * d;
        const gy = groundAt(cx, cz) + 1.5; if (cy < gy) cy = gy;
        c.position.set(cx, cy, cz); c.up.set(0, 1, 0); c.lookAt(tx, ty, tz);
        break;
      }
      case 'trackside': {
        if (!tr) { setMode('orbit'); break; }
        const sgn = tr.dir ? 1 : -1; const passed = (tr.s - ts.s) * sgn;
        if (ts.s < 0 || passed > 260 || Math.abs(tr.s - ts.s) > 3000) pickTrackside(tr);
        c.position.set(ts.x, ts.y, ts.z);
        const car = leadCar(tr); const cs = cars(tr);
        if (car) { const aim = cs[Math.floor(cs.length / 2)] || car; const k = U.clamp(1 - Math.abs(tr.s - ts.s) / 500, 0, 1);
          tmpV.copy(car.group.position).lerp(aim.group.position, k * 0.7); tmpV.y += 2.2; c.up.set(0, 1, 0); c.lookAt(tmpV); }
        else { Track.frame(tr.s, F); c.lookAt(F.x, F.y + 2, F.z); }
        fovTarget = ts.fov;
        break;
      }
      case 'heli': {
        if (!tr) { setMode('orbit'); break; }
        const car = leadCar(tr); if (!car) break; heli.ang += dt * 0.05;
        const g = car.group.position; Track.frame(tr.s, F); const hd = Math.atan2(F.dx, F.dz) * 1 + (tr.dir ? 0 : Math.PI);
        const a = hd + 2.2 + Math.sin(heli.ang) * 0.8; const R = 160, H = 70 + Math.sin(heli.ang * 1.3) * 25;
        const tx = g.x + Math.sin(a) * R, tz = g.z + Math.cos(a) * R; const ty = Math.max(g.y + H, groundAt(tx, tz) + 40);
        c.position.lerp(tmpV.set(tx, ty, tz), Math.min(1, dt * 1.2)); if (c.position.distanceTo(tmpV) > 600) c.position.copy(tmpV);
        tmpV2.set(g.x + F.dx * 30 * (tr.dir ? 1 : -1), g.y + 2, g.z + F.dz * 30 * (tr.dir ? 1 : -1)); c.up.set(0, 1, 0); c.lookAt(tmpV2);
        break;
      }
      case 'walk': {
        moveWalk(dt);
        c.position.set(walk.x, walk.y + EYE, walk.z); worldLook(look.yaw, look.pitch);
        const hit = doorNearWorld(walk);
        if (hit) { prompt = 'Press <kbd>E</kbd> to board: ' + Sim.destText(hit.tr).replace(/\s+/g, ' '); promptAction = () => board(hit); }
        else { const st = Stations.nearest(walk, 140); if (st) { prompt = 'Press <kbd>B</kbd> for ' + st.name + ' departures'; } }
        break;
      }
      case 'fly': {
        const alt = fly.y - groundAt(fly.x, fly.z);
        const sp = fly.speed * (down('ShiftLeft', 'ShiftRight') ? 4 : 1) * U.clamp(0.4 + alt / 250, 0.4, 20) * dt;
        const cy = Math.cos(look.pitch);
        const fx = Math.sin(look.yaw) * cy, fy = Math.sin(look.pitch), fz = -Math.cos(look.yaw) * cy;
        const rx = Math.cos(look.yaw), rz = Math.sin(look.yaw);
        if (down('KeyW', 'ArrowUp')) { fly.x += fx * sp; fly.y += fy * sp; fly.z += fz * sp; }
        if (down('KeyS', 'ArrowDown')) { fly.x -= fx * sp; fly.y -= fy * sp; fly.z -= fz * sp; }
        if (down('KeyD', 'ArrowRight')) { fly.x += rx * sp; fly.z += rz * sp; } if (down('KeyA', 'ArrowLeft')) { fly.x -= rx * sp; fly.z -= rz * sp; }
        if (down('KeyE', 'Space')) fly.y += sp; if (down('KeyQ', 'ControlLeft')) fly.y -= sp;
        fly.x = U.clamp(fly.x, -52000, 52000); fly.z = U.clamp(fly.z, -52000, 52000); fly.y = U.clamp(fly.y, groundAt(fly.x, fly.z) + 1.8, 30000);
        c.position.set(fly.x, fly.y, fly.z); worldLook(look.yaw, look.pitch);
        break;
      }
    }
    c.fov = U.lerp(c.fov, fovTarget, Math.min(1, dt * 4)); c.updateProjectionMatrix();
    // near plane: tiny indoors, larger outdoors at altitude (log depth handles the rest)
    const alt = c.position.y - Terrain.h(c.position.x, c.position.z); c.near = mode === 'onboard' || mode === 'cab' ? 0.03 : alt > 500 ? 1 : 0.1; c.updateProjectionMatrix();
  }
  function pickTrackside(tr) {
    const sgn = tr.dir ? 1 : -1; const r = Math.random;
    const ahead = 420 + r() * 380; let s = U.clamp(tr.s + sgn * ahead, 50, Track.length - 50);
    // prefer interesting spots: crossings, bridges, stations nearby
    const feats = [...Track.feat.crossings.map(c => c.s), ...Track.stations.map(st => st.s)].filter(v => (v - tr.s) * sgn > 250 && (v - tr.s) * sgn < 1100);
    if (feats.length && r() < 0.6) s = feats[Math.floor(r() * feats.length)] + sgn * (20 + r() * 60);
    Track.frame(s, F); const [lo, hi] = TrackGeo.bedSpan(s);
    const side = r() < 0.5 ? -1 : 1; const lat = side < 0 ? lo - 7 - r() * 22 : hi + 7 + r() * 22;
    const x = F.x + F.rx * lat, z = F.z + F.rz * lat; const high = r() < 0.25;
    ts.x = x; ts.z = z; ts.y = Math.max(groundAt(x, z), F.y - 1) + (high ? 9 + r() * 20 : 1.6 + r() * 1.2); ts.s = s; ts.fov = high ? 38 : 28 + r() * 22;
  }
  function interact() { if (promptAction) { const f = promptAction; promptAction = null; f(); return true; } return false; }
  function teleportToStation(st, dir = 1) { const sp = Stations.spawnPoint(st, dir, {}); setMode('walk', { pos: sp }); }
  function state() {
    const tr = focusTrain(); const c = cam();
    if (mode === 'onboard' && tr) return { mode: 'ride', trip: tr.trip.id, s: tr.s, car: ob.car, x: ob.x, y: ob.y, z: ob.z, yaw: look.yaw, speed: tr.dir ? tr.v : -tr.v };
    if (mode === 'cab' && tr) return { mode: tr.driven ? 'drive' : 'cab', trip: tr.trip.id, s: tr.s, car: tr.dir ? 0 : 99, x: 0, y: 0, z: 0, yaw: 0, speed: tr.dir ? tr.v : -tr.v };
    if (Sim.drive) { const D = Sim.drive; return { mode: 'drive', trip: D.trip.id, s: D.s, car: -1, x: c.position.x, y: c.position.y, z: c.position.z, yaw: 0, speed: D.dir ? D.v : -D.v }; }
    return { mode: mode === 'walk' ? 'walk' : 'fly', trip: '', s: 0, car: -1, x: c.position.x, y: c.position.y, z: c.position.z, yaw: look.yaw, speed: 0 };
  }
  return { init, update, setMode, setFocus, interact, teleportToStation, focusTrain, state, on, releaseLock,
    get mode() { return mode; }, get focus() { return focus; }, get prompt() { return prompt; }, keys, down, orbit, look, walk, ob, fly,
    onboard: () => mode === 'onboard', inCab: () => mode === 'cab', leadCar, cars, groundAt };
})();
