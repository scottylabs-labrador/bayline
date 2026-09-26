// StationCrowds: people in the Bayline Metro station nearest the camera (Life's instanced people, near/far LOD).
// How many: each station's real average weekday exits (BART ridership, Aug 2026) and the time of day (peaks, midday,
// evening, the night closure); where: along the platforms (most within a few metres of the edge, some on the benches,
// a few walking), in the concourse (walking between the entrances and the fare gates), riding the escalators (placed on
// the moving steps' path). When a metro train stands with its doors open, waiting passengers walk to the nearest door
// and board; a few alight and walk off toward the escalators.
const StationCrowds = (() => {
  const EXITS = { EMBR: 23388, MONT: 18382, POWL: 13405, CIVC: 11190, '16TH': 6679, '24TH': 6378, GLEN: 3704, BALB: 4615, DALY: 5803, COLM: 1966, SSAN: 1720, SBRN: 1837,
    SFIA: 6449, MLBR: 2518, WOAK: 4806, '12TH': 6103, '19TH': 6035, MCAR: 4843, LAKE: 3217, FTVL: 4484, COLS: 2911, SANL: 3987, BAYF: 3014, HAYW: 2611, SHAY: 1656,
    UCTY: 2358, FRMT: 2584, WARM: 1546, MLPT: 1719, BERY: 2050, CAST: 1521, WDUB: 1625, DUBL: 3851, OAKL: 500, ROCK: 3458, ORIN: 1650, LAFY: 2126, WCRK: 3542,
    PHIL: 3089, CONC: 3088, NCON: 778, PITT: 2738, PCTR: 500, ANTC: 2060, ASHB: 2439, DBRK: 7285, NBRK: 2175, PLZA: 2457, DELN: 4522, RICH: 2806 };
  const MAX = 240;
  let people = null, active = null, list = [], seed = 1;
  const KINDS = ['commuter', 'commuter', 'office', 'office', 'student', 'tourist', 'cyclist', 'senior', 'kid'];
  function ensure() {
    if (people || typeof Life === 'undefined' || !Life.createPeople) return !!people;
    try { people = Life.createPeople(MAX, { lod: true, seed: 71 }); people.count = 0; MetroStations.group.add(people.mesh);
      // (its shaders compile in the background before anyone is drawn: see MetroStations.attach)
      people.warm = false; MetroStations.warmUp(people.mesh, () => { people.warm = true; });
    } catch (e) { console.warn('station crowds', e); people = null; }
    return !!people;
  }
  // people present right now: exits/day -> a platform population (peaks x ~2.2, night closure)
  function population(id) {
    const ex = EXITS[id] || 2000; const h = (typeof Env !== 'undefined' ? Env.time.sec : 43200) / 3600;
    const f = h < 4.6 ? 0.02 : h < 6 ? 0.25 : h < 6.5 ? 0.5 : h < 9.5 ? 1.0 : h < 15.5 ? 0.45 : h < 19 ? 1.0 : h < 21 ? 0.4 : h < 23.9 ? 0.22 : 0.08;
    const k = typeof MetroStations !== 'undefined' && MetroStations.quality ? MetroStations.quality.crowd : 1;   // (quality: Low a quarter)
    return Math.round(U.clamp((8 + ex * 0.0085 * f) * k, 3, MAX - 30));
  }
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  function spawn(st) {
    list = []; active = st; const R = st.res; if (!R || !R.crowd) return;
    seed = (U.hashStr(st.id) + Math.floor((typeof Env !== 'undefined' ? Env.time.sec : 0) / 900)) % 2147483646 + 1;
    const C = R.crowd, N = population(st.id); const [ox, oz] = R.origin;
    people.mesh.position.set(ox, 0, oz); people.mesh.updateMatrixWorld();
    const plats = C.plats; if (!plats.length) return;
    const nPlat = C.conc ? Math.round(N * 0.8) : N;
    for (let i = 0, tries = 0; list.length < nPlat && tries < nPlat * 6; tries++) {
      const p = plats[Math.floor(rnd() * plats.length)];
      const u = U.lerp(p.u0 + 10, p.u1 - 10, U.clamp(0.5 + (rnd() - 0.5) * (0.45 + rnd() * 0.7), 0, 1));
      const a = p.eL(u), b = p.eR(u); const island = p.kind === 'island';
      // most people wait 1.3-3.5 m from an edge (the side their train comes in on)
      let side, v;
      if (island) { side = rnd() < 0.5 ? -1 : 1; const d = 1.3 + rnd() * rnd() * Math.max(0.5, (b - a) / 2 - 1.6); v = side < 0 ? a + d : b - d; }
      else { side = p.sideV > 0 ? -1 : 1; const d = 1.3 + rnd() * Math.max(0.5, (b - a) - 2.2); v = p.sideV > 0 ? a + d : b - d; }
      if (p.busy(u, v)) continue;
      const faceYaw = R.yawAt(u) + (side < 0 ? Math.PI / 2 : -Math.PI / 2);       // look toward the edge (the track): +pi/2 turns +u to -v
      const walker = rnd() < 0.14;
      list.push({ p, u, v, side, y: p.y, yaw: faceYaw + (rnd() - 0.5) * 1.2, mode: walker ? 1 : 0, speed: 0.9 + rnd() * 0.6, state: walker ? 'walk' : 'wait', tu: u, tv: v, ph: rnd() * 6.28, key: island ? p.keys[side < 0 ? 0 : 1] || p.keys[0] : p.keys[0] });
      void i;
    }
    // concourse walkers
    if (C.conc) for (let k = 0; k < N - nPlat; k++) {
      const c = C.conc; const u = U.lerp(c.u0, c.u1, rnd()); const v = U.lerp(c.vl(u) + 1, c.vr(u) - 1, rnd());
      if (c.holes.some(h => u > h.u0 - 1 && u < h.u1 + 1 && v > h.v0 - 1 && v < h.v1 + 1)) continue;
      const tu = U.lerp(c.u0, c.u1, rnd()), tv = U.lerp(c.vl(tu) + 1, c.vr(tu) - 1, rnd());
      list.push({ conc: c, u, v, y: c.y, yaw: 0, mode: 1, speed: 1.1 + rnd() * 0.5, state: 'walk', tu, tv, ph: rnd() * 6.28 });
    }
    for (let i = 0; i < list.length; i++) people.look(i, { kind: KINDS[Math.floor(rnd() * KINDS.length)], seed: U.hashStr(st.id) * 31 + i * 977 });
    people.count = list.length;
  }
  const _v = new THREE.Vector3();
  function trainDoors(st) {
    const out = []; if (typeof MetroSim === 'undefined' || !MetroSim.running) return out;
    for (const tr of MetroSim.running) {
      if (!tr.doorsOpen || !tr.entry || !tr.entry.consist || Math.hypot(tr.x - st.x, tr.z - st.z) > 450) continue;
      const side = tr.doorSide === 'right' ? 1 : -1;
      for (const car of tr.entry.consist.cars) { if (!car.group || !car.doors) continue; car.group.updateMatrixWorld();
        for (const d of car.doors) { if (d.side !== side) continue; _v.set(d.x, d.sillY || 1, d.side * (car.width / 2 + 0.3)); car.group.localToWorld(_v); out.push({ x: _v.x, z: _v.z, tr }); } }
    }
    return out;
  }
  let doorT = 0, doors = [];
  function update(dt, camPos, stations) {
    // the station whose platforms are nearest (within 350 m), built
    let best = null, bd = 350;
    for (const st of stations) { if (st.state !== 'built' || !st.res || !st.res.crowd) continue; const d = Math.hypot(st.x - camPos.x, st.z - camPos.z); if (d < bd) { bd = d; best = st; } }
    if (!best) { if (people) { people.count = 0; people.mesh.visible = false; } active = null; return; }
    if (!ensure()) return;
    people.mesh.visible = people.warm !== false && !!best.root && best.root.userData.warm !== false;
    if (best !== active || !list.length && population(best.id) > 3 && Math.random() < 0.01) spawn(best);
    const R = active.res; const [ox, oz] = R.origin;
    doorT -= dt; if (doorT <= 0) { doorT = 0.5; doors = trainDoors(active); }
    let k = 0;
    for (const c of list) {
      if (c.state === 'gone') continue;
      if (c.state === 'wait' && doors.length) {
        // board: the nearest open door on this side within 30 m
        let bdd = 30 * 30, bx = 0, bz = 0; const [wx, wz] = R.toWorld(c.u, c.v);
        for (const d of doors) { const dd = (d.x - wx) ** 2 + (d.z - wz) ** 2; if (dd < bdd) { bdd = dd; bx = d.x; bz = d.z; } }
        if (bdd < 30 * 30) { c.state = 'board'; c.bx = bx - ox; c.bz = bz - oz; c.mode = 1; }
      }
      let lx, lz;
      if (c.state === 'board') {
        const [x0, z0] = R.toLocal(c.u, c.v); const dx = c.bx - x0, dz = c.bz - z0, d = Math.hypot(dx, dz);
        if (d < 0.35) { c.state = 'gone'; continue; }
        const sp = Math.min(d, 1.4 * dt); const nx = x0 + dx / d * sp, nz = z0 + dz / d * sp;
        // back to (u, v) approximately: move along the local direction
        const f = R.yawAt(c.u); const tx = Math.cos(f), tz = -Math.sin(f); c.u += (dx / d * sp) * tx + (dz / d * sp) * tz; c.v += (dx / d * sp) * -tz + (dz / d * sp) * tx;
        lx = nx; lz = nz; c.yaw = Math.atan2(-dz, dx);
      } else if (c.state === 'walk') {
        const du = c.tu - c.u, dv = c.tv - c.v, d = Math.hypot(du, dv);
        if (d < 0.4) {       // a new target: along the platform (or across the concourse)
          if (c.conc) { c.tu = U.lerp(c.conc.u0, c.conc.u1, Math.random()); c.tv = U.lerp(c.conc.vl(c.tu) + 1, c.conc.vr(c.tu) - 1, Math.random()); }
          else { const p = c.p; c.tu = U.clamp(c.u + (Math.random() - 0.5) * 40, p.u0 + 6, p.u1 - 6); const a = p.eL(c.tu), b = p.eR(c.tu); c.tv = U.clamp(c.v, a + 1.2, b - 1.2); if (p.busy(c.tu, c.tv)) c.tu = c.u; if (Math.random() < 0.25) { c.state = 'wait'; c.mode = 0; } }
        } else { const sp = Math.min(d, c.speed * dt); c.u += du / d * sp; c.v += dv / d * sp; c.walkYaw = R.yawAt(c.u) + Math.atan2(-dv, du); }
        const L = R.toLocal(c.u, c.v); lx = L[0]; lz = L[1]; c.yaw = c.walkYaw !== undefined ? c.walkYaw : c.yaw;
      } else { const L = R.toLocal(c.u, c.v); lx = L[0]; lz = L[1]; if (Math.random() < dt * 0.01) { c.state = 'walk'; c.mode = 1; } }
      people.set(k++, lx, c.y, lz, c.yaw, c.state === 'wait' ? 0 : 1, c.ph, c.state === 'wait' ? undefined : c.speed);
    }
    people.count = k; people.update && people.update(dt);
  }
  const api = { update, population, EXITS, get people() { return people; }, get active() { return active; } };
  if (typeof window !== 'undefined') (window.__baylineMods = window.__baylineMods || {}).StationCrowds = api;   // (QA, trailer shots)
  return api;
})();
