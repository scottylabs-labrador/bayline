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
  function teleport(st, gtfs) {
    const id = st.id || st;
    let sp = null;
    if (typeof MetroStations !== 'undefined' && MetroStations.spawnPoint) {          // (platforms are keyed by their code: '1', '2' ...)
      const S = MetroSim.net.stationById[id], pf = S && gtfs ? (S.platforms || []).find(p => p.gtfs === gtfs) : null;
      try { sp = MetroStations.spawnPoint(id, pf ? (pf.code || String(gtfs).split('-')[1]) : undefined); } catch (e) { sp = null; } }
    if (!sp) sp = platformSpot(id, gtfs);
    if (!sp) return false;
    Player.setMode('walk', { pos: sp });
    return true;
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
  function update(dt) { if (on() && !strips) buildStrips(); }

  return { floorAt, blocked, platformSpot, teleport, tunnelCam, trackside, endOfLine, walkPrompt, walkAction, toPeninsula, toMetro, nearPeninsulaXfer, netState, update, XFER };
})();
