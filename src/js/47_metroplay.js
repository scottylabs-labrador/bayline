// Bayline Metro: the player's side of the metro (#metro=1 only). Going to a platform, the camera modes on metro trains
// (a chase camera that rides along the bore underground, trackside spots along the real path), the end of the line,
// the walk prompts (boards, the Millbrae transfer to the Peninsula line and back) and the multiplayer presence of metro
// riders and drivers. The walkable platform floors come from MetroStations (stations workstream) when it is in the
// build; until then a simple fallback floor is derived from MetroNet's platform extents so ride/board/alight all work.
const MetroPlay = (() => {
  const on = () => typeof MetroSim !== 'undefined' && MetroSim.enabled && MetroSim.ready;
  const F = {}, F2 = {}, V = new THREE.Vector3(), V2 = new THREE.Vector3();
  const EDGE = 1.68, FLOOR = 0.991;                         // platform edge from the track centre, platform top above the rail

  // ---------------------------------------------------------------- platforms (MetroNet extents)
  // platform strips: { st, gtfs, track, s0, s1, side (+1 right of +s), w (width), y0/y1 (floor at s0/s1) }
  let strips = null; const grid = new Map(); const GC = 100;
  function buildStrips() {
    strips = [];
    const MN = MetroSim.net; if (!MN) return;
    for (const st of MN.stations) for (const p of st.platforms || []) {
      const t = MN.byId[p.track]; if (!t) continue;
      const island = st.layout === 'island' || st.layout === 'split';
      const w = p.gtfs && /^H/.test(p.gtfs) ? 3.0 : island ? 4.2 : 3.6;
      const o = { st: st.id, gtfs: p.gtfs, track: t, s0: Math.max(0, p.s0 - 1), s1: Math.min(t.length, p.s1 + 1), side: p.side === 'right' ? 1 : -1, w, idx: strips.length };
      strips.push(o);
      for (let s = o.s0; s <= o.s1; s += 20) { MN.frame(t, s, F); const k = Math.floor(F.x / GC) * 65536 + Math.floor(F.z / GC); if (!grid.has(k)) grid.set(k, new Set()); grid.get(k).add(o); }
    }
  }
  // the fallback floor under (x, z) for feet near y: on a platform strip (edge .. edge + width, platform ends + 1 m)
  function floorAt(x, y, z) {
    if (!on()) return null; if (!strips) buildStrips();
    const set = grid.get(Math.floor(x / GC) * 65536 + Math.floor(z / GC)); if (!set) return null;
    let best = null, bd = 1.6;
    for (const o of set) {
      const q = MetroSim.net.nearest(x, z, 12, (t) => t === o.track); if (!q || q.s < o.s0 || q.s > o.s1) continue;
      const lat = q.lat * o.side; if (lat < EDGE - 0.05 || lat > EDGE + o.w) continue;
      MetroSim.net.frame(o.track, q.s, F2); const fy = F2.y + FLOOR, d = Math.abs(fy - y);
      if (d < bd) { bd = d; best = fy; }
    }
    return best;
  }
  // stepping off a platform edge (toward the track) or off an elevated platform end is refused
  function blocked(x0, z0, x1, z1, y) {
    if (!on()) return false;
    const a = floorAt(x0, y, z0); if (a === null) return false;
    const b = floorAt(x1, y, z1); if (b !== null) return false;
    const g = typeof Terrain !== 'undefined' ? Terrain.h(x1, z1) : a;
    return Math.abs(g - a) > 0.8 || MetroSim.net.nearest(x1, z1, EDGE + 0.2) !== null;
  }
  // where to stand on a platform: the middle of its length, 2 m from the edge, facing the track
  function platformSpot(st, gtfs, out = {}) {
    const MN = MetroSim.net, S = MN.stationById[st.id || st]; if (!S || !S.platforms || !S.platforms.length) return null;
    const p = (gtfs && S.platforms.find(q => q.gtfs === gtfs)) || S.platforms[0], t = MN.byId[p.track]; if (!t) return null;
    const s = (p.s0 + p.s1) / 2 + 12, side = p.side === 'right' ? 1 : -1;
    MN.frame(t, s, F); const lat = side * (EDGE + 2.0);
    out.x = F.x + F.rx * lat; out.z = F.z + F.rz * lat; out.y = F.y + FLOOR;
    out.yaw = Math.atan2(-F.rx * side, -F.rz * side);        // heading toward the track (atan2(dx, dz) convention)
    out.station = S.id; out.gtfs = p.gtfs; return out;
  }
  // Going to a platform: the platform of the next train (or the one asked for), a quarter of the way along from the end
  // that train comes in at, on the platform's centreline (found by probing the stations' walkable floors across the
  // platform; the MetroNet extents when the station isn't built yet), facing up the platform toward the arriving train
  // and turned a little toward its track, so it pulls in alongside. The walker holds its height until the station's
  // floors exist (an aerial platform never drops you to the street), and the camera modes follow that train.
  function teleport(st, gtfs) {
    const id = st.id || st, MN = MetroSim.net, S = MN.stationById[id]; if (!S || !S.platforms || !S.platforms.length) return false;
    const now = Env.time.sec, next = nextAt(id, gtfs, now);
    const p = (gtfs && S.platforms.find(q => q.gtfs === gtfs)) || (next && S.platforms.find(q => q.gtfs === next.sid)) || S.platforms[0];
    const t = MN.byId[p.track]; if (!t) return false;
    // the next train's direction along this track (+1: toward +s); it enters at the other end
    let dirS = 1, sBerth = null;
    if (next && next.leg) { const q = next.leg.path.leg.locate(Math.max(0, next.leg.stops[next.k].ps - 5), {}); if (q.track === t) { dirS = q.sign; sBerth = q.s + 5 * q.sign; } }
    // a quarter of the way along the train as it will stand (from its tail): a quarter along the platform for a
    // full-length train, beside the rear of a shorter one (it stops with its head at the far end)
    const s0 = Math.max(0, p.s0), s1 = Math.min(t.length, p.s1), L = next ? next.leg.cars * (MetroSim.PERF[next.leg.kind] || MetroSim.PERF.bart).carLen : s1 - s0;
    const sQ0 = sBerth !== null ? U.clamp(sBerth - dirS * 0.75 * L, s0 + 5, s1 - 5) : dirS > 0 ? s0 + 0.25 * (s1 - s0) : s1 - 0.25 * (s1 - s0);
    // the side and height of the platform as the stations workstream built it (what is drawn), else MetroNet's data
    const side = MetroSim.platformSide(id, p.gtfs) || (p.side === 'right' ? 1 : -1);
    const spS = spawnFromStations(id, p.gtfs);
    const hasFloors = typeof MetroStations !== 'undefined' && MetroStations.floorAt;
    let sQ = sQ0, lat = 0, yPlat = spS ? spS.y : 0, ok = false;
    const pick = hasFloors ? pickSpot(t, sQ0, s0, s1, side, dirS, spS ? spS.y : null) : null;
    if (pick) { sQ = pick.s; lat = pick.lat; yPlat = pick.y; ok = true; }
    // the station hasn't streamed in yet (its floors appear within ~1.5 km of the camera): an estimate now, the platform's
    // centreline as soon as its floors exist (MetroPlay.update)
    if (!ok) { MN.frame(t, sQ0, F); sQ = sQ0; lat = side * (EDGE + ((S.layout === 'island' || S.layout === 'split') ? 2.1 : 1.8)); if (!spS) yPlat = F.y + FLOOR;
      pending = { t, s: sQ, s0, s1, dirS, side, y: yPlat, yKnown: !!spS, until: performance.now() + 15000 }; }
    MN.frame(t, sQ, F);
    const x = F.x + F.rx * lat, z = F.z + F.rz * lat;
    // heading: up the platform toward where the train comes from, 12 degrees toward its track
    const ax = -dirS * F.tx, az = -dirS * F.tz, tx = -side * F.rx, tz = -side * F.rz, k = Math.tan(12 * Math.PI / 180);
    const yaw = Math.atan2(ax + tx * k, az + tz * k);
    Player.setMode('walk', { pos: { x, y: yPlat, z, yaw } });
    Player.walk.y = yPlat; Player.walk.vy = 0; Player.walk.hold = performance.now() + 15000;   // (until the station's floors stream in)
    if (next) { const key = next.leg.chainKey || next.plan.key; Player.setFocus(key); watch = { key, st: id, gtfs: p.gtfs, dep: next.dep }; }
    return true;
  }
  // the next train on a platform: one still standing there (leaving in more than a few seconds) or on its way in
  function nextAt(id, gtfs, now) { return MetroSim.arrivals(id, now, 24).find(e => (!gtfs || e.sid === gtfs) && e.dep > now + 3) || null; }
  // standing on the platform you were sent to, the views keep following "the next train": once the focused one has
  // left (and you haven't picked another train or wandered off), the next one due on that platform takes over
  let watch = null;
  function watchPlatform() {
    const W = watch; if (Player.mode !== 'walk' || MetroSim.focus !== W.key) { watch = null; return; }
    const now = Env.time.sec; if (now < W.dep + 6 && now > W.dep - 7200) return;
    const st = MetroSim.nearestStation(Env.camera.position, 450); if (!st || st.id !== W.st) { watch = null; return; }
    const n = nextAt(W.st, W.gtfs, now); if (!n) { watch = null; return; }
    const key = n.leg.chainKey || n.plan.key; Player.setFocus(key); watch = { key, st: W.st, gtfs: W.gtfs, dep: n.dep };
  }
  // the spot: near the quarter point (sQ0), on the platform's centreline (or either side of it, never more than 5 m in
  // from the edge), where the view up the platform is open (walking is first-person): over a 2 m wide corridor 16 m
  // ahead, no escalator or stair slope below 5.2 m overhead (the concourse slab is higher) and no wall, column or
  // balustrade across the line of sight. Best of: open view > headroom only > just floor.
  function pickSpot(t, sQ0, s0, s1, side, dirS, yKnown) {
    const MN = MetroSim.net; let best = null, bs = -1;
    for (const ds of [0, 6, -6, 12, -12, 20, -20, 30, -30, 40, -40, 55, -55]) {
      const sq = U.clamp(sQ0 + ds * dirS, s0 + 5, s1 - 5), yP = yKnown !== null ? yKnown : MN.frame(t, sq, F2).y + FLOOR, r = probeAcross(t, sq, side, yP); if (!r) continue;
      for (const f of [0.5, 0.36, 0.64, 0.25, 0.75]) {
        const w = r.a + Math.min(f * (r.b - r.a), 5.0 + (f - 0.5) * 3), sc = spotClear(t, sq, side * w, dirS, yP);
        if (sc > bs) { bs = sc; best = { s: sq, lat: side * w, y: yP, score: sc }; }
        if (bs === 2) return best;
      }
    }
    return best;
  }
  function spotClear(t, s, lat, dirS, yP) {
    MetroSim.net.frame(t, s, F2); const fx = -dirS * F2.tx, fz = -dirS * F2.tz, h = Math.hypot(fx, fz) || 1, ux = fx / h, uz = fz / h;
    const x = F2.x + F2.rx * lat, z = F2.z + F2.rz * lat;
    for (const k of [0, 2, 4, 6, 9, 12, 16]) for (const l of [0, -1, 1]) {
      const o = MetroStations.floorAt(x + ux * k - uz * l, yP + 4.6, z + uz * k + ux * l);
      if (o === null) { if (l === 0) return 0; continue; }       // (off the floor beside the corridor: the platform edge)
      if (o > yP + 0.35) return 0;                              // an escalator or a stair overhead / ahead
    }
    const B = MetroStations.blocked;                            // (columns and walls across the 2 m corridor, not just the axis)
    if (B) for (const l of [0, -1, 1]) { const x0 = x - uz * l, z0 = z + ux * l; if (B(x0, z0, x0 + ux * 16, z0 + uz * 16, yP)) return 1; }
    return 2;
  }
  // across the platform at (track t, s): the stretch of station floor at height yP on the given side -> {a, b} (m from the track)
  function probeAcross(t, s, side, yP) {
    if (typeof MetroStations === 'undefined' || !MetroStations.floorAt) return null;
    MetroSim.net.frame(t, s, F2); let a = null, b = null;
    for (let w = EDGE - 0.2; w < EDGE + 16; w += 0.25) { const f = MetroStations.floorAt(F2.x + F2.rx * side * w, yP + 0.3, F2.z + F2.rz * side * w);
      const on = f !== null && Math.abs(f - yP) < 0.35; if (on && a === null) a = w; if (on) b = w; else if (a !== null) break; }
    return a !== null && b - a > 1.2 ? { a, b } : null;
  }
  let pending = null;
  function settleSpawn() {
    const P = pending; if (!P || Player.mode !== 'walk') { pending = null; return; }
    if (performance.now() > P.until) { pending = null; return; }
    if (!probeAcross(P.t, P.s, P.side, P.y)) return;                 // (not streamed in yet)
    const k = pickSpot(P.t, P.s, P.s0, P.s1, P.side, P.dirS, P.yKnown ? P.y : null); if (!k) return;
    MetroSim.net.frame(P.t, k.s, F2);
    Player.walk.x = F2.x + F2.rx * k.lat; Player.walk.z = F2.z + F2.rz * k.lat; Player.walk.y = k.y; pending = null;
  }
  // (the older helper: where the stations workstream would put you; kept for tools)
  function spawnFromStations(id, gtfs) {
    if (typeof MetroStations === 'undefined' || !MetroStations.spawnPoint) return null;
    const S = MetroSim.net.stationById[id], pf = S && gtfs ? (S.platforms || []).find(p => p.gtfs === gtfs) : null;
    try { return MetroStations.spawnPoint(id, pf ? (pf.code || String(gtfs).split('-')[1]) : undefined); } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- camera helpers
  // underground chase: the camera rides the bore ahead of the train looking back at the headlights (or behind the
  // tail, when the player has swung the chase camera around), 3 m up on the centreline
  const tc = { x: 0, y: 0, z: 0, init: false };
  function tunnelCam(tr, c, dt) {
    const path = tr.leg && tr.leg.path; if (!path) return false;
    const front = Math.cos(Player.orbit.yaw) < 0.2, d = U.clamp(Player.orbit.dist * 0.6, 18, 110);
    const ps = front ? tr.s + d : tr.s - tr.len - d;
    path.at(ps, F);
    const tx = F.x + (F.ux || 0) * 3.0, ty = F.y + (F.uy || 1) * 3.0, tz = F.z + (F.uz || 0) * 3.0;
    if (!tc.init || Math.hypot(tc.x - tx, tc.z - tz) > 60) { tc.x = tx; tc.y = ty; tc.z = tz; tc.init = true; }
    const k = Math.min(1, dt * 6); tc.x += (tx - tc.x) * k; tc.y += (ty - tc.y) * k; tc.z += (tz - tc.z) * k;
    c.position.set(tc.x, tc.y, tc.z); c.up.set(0, 1, 0);
    path.at(front ? tr.s - 10 : tr.s - tr.len + 10, F2); c.lookAt(F2.x, F2.y + 2.0, F2.z);
    return true;
  }
  // trackside: a spot 8-28 m beside the path, 400-800 m ahead, in the open (not in a tunnel), re-picked once passed
  const tsState = { key: '', s: -1 };
  function trackside(tr, ts) {
    const path = tr.leg && tr.leg.path; if (!path) return false;
    if (tsState.key !== tr.key || tr.s - tsState.s > 240 || tsState.s - tr.s > 2600 || tsState.path !== path) {
      const r = Math.random; let ok = false;
      for (let k = 0; k < 14 && !ok; k++) {
        const s = Math.min(path.length - 20, tr.s + 380 + r() * 700 + k * 150); path.at(s, F);
        if (MetroNet.isUnderground(F.struct)) continue;
        const side = r() < 0.5 ? -1 : 1, lat = side * (7 + r() * 20);
        const x = F.x + F.rx * lat, z = F.z + F.rz * lat, g = Terrain.h(x, z);
        if (Terrain.isWater(x, z)) continue;
        const aerial = F.y - g > 4;
        ts.x = x; ts.z = z; ts.y = (aerial ? g : Math.max(g, F.y - 1)) + (r() < 0.2 ? 8 + r() * 14 : 1.6 + r() * 1.2);
        ts.fov = aerial ? 46 : 30 + r() * 20; ts.s = s; ok = true; tsState.s = s;
      }
      if (!ok) return false;
      tsState.key = tr.key; tsState.path = path;
    }
    return true;
  }

  // ---------------------------------------------------------------- end of the line, prompts, transfers
  function endOfLine(pos) {
    if (!on()) return false;
    const st = MetroSim.nearestStation(pos, 1500); if (!st) return false;
    if (!teleport(st)) return false;
    if (typeof UI !== 'undefined') UI.toast('End of the line: everybody off at ' + st.short, 4);
    return true;
  }
  // the Millbrae intermodal station: metro platform <-> Peninsula platforms, one keypress apart
  const XFER = { metro: 'MLBR', peninsula: 'place_MLBR' };
  function nearPeninsulaXfer(pos) {
    if (typeof Stations === 'undefined') return null;
    const st = Stations.list.find(s => s.id === XFER.peninsula); if (!st) return null;
    return Math.hypot(st.x - pos.x, st.z - pos.z) < 260 ? st : null;
  }
  function walkPrompt(ms, pos) {
    if (ms.id === XFER.metro) return 'Press <kbd>B</kbd> for Millbrae trains · <kbd>E</kbd> transfer to the Peninsula line';
    return 'Press <kbd>B</kbd> for ' + ms.short + ' trains';
  }
  function walkAction(ms, pos) {
    if (ms.id === XFER.metro) return () => toPeninsula();
    return null;
  }
  function toPeninsula(dir) {
    const st = Stations.list.find(s => s.id === XFER.peninsula); if (!st) return false;
    // the next Peninsula departure decides the platform (northbound 0 / southbound 1)
    const si = Sim.TT.stations.indexOf(XFER.peninsula), deps = si >= 0 ? Sim.departures(si, Env.time.sec, 4) : [];
    const d = dir !== undefined ? dir : (deps[0] ? deps[0].dir : 1);
    Player.teleportToStation(st, d);
    if (typeof UI !== 'undefined') UI.toast('Millbrae: Peninsula line ' + (d ? 'southbound' : 'northbound') + ' platform' + (deps[0] ? ' · next ' + Sim.routeShort(deps[0].trip).toLowerCase() + ' at ' + Env.clockText(deps[0].t) : ''), 5);
    return true;
  }
  function toMetro(gtfs) {
    if (!on()) return false; const ok = teleport('MLBR', gtfs);
    if (ok && typeof UI !== 'undefined') UI.toast('Millbrae: metro platform · Press B for the next trains', 4);
    return ok;
  }

  // ---------------------------------------------------------------- multiplayer presence
  // modes: 'mride' (in a metro car: car-local position), 'mdrive' (driving); trip = MetroSim.netKey (trip + leg), s = head
  function netState(tr, mode, ob, look, c) {
    if (!tr) return { mode: 'walk', trip: '', s: 0, car: -1, x: c.position.x, y: c.position.y, z: c.position.z, yaw: look.yaw, speed: 0 };
    const key = MetroSim.netKey(tr), w = { wx: c.position.x, wy: c.position.y, wz: c.position.z };   // (world position: the fallback for an older relay)
    if (mode === 'onboard') return { mode: 'mride', trip: key, s: tr.s, car: ob.car, x: ob.x, y: ob.y, z: ob.z, yaw: look.yaw, speed: tr.v, ...w };
    return { mode: tr.driven ? 'mdrive' : 'mride', trip: key, s: tr.s, car: tr.dir ? 0 : 99, x: 0, y: 0, z: 0, yaw: 0, speed: tr.v, ...w };
  }
  function update(dt) { if (on() && !strips) buildStrips(); if (pending) settleSpawn(); if (watch) watchPlatform(); }

  return { floorAt, blocked, platformSpot, teleport, spawnFromStations, tunnelCam, trackside, endOfLine, walkPrompt, walkAction, toPeninsula, toMetro, nearPeninsulaXfer, netState, update, XFER };
})();
