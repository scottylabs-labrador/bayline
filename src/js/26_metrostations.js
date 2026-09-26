// MetroStations: all 50 Bayline Metro stations (stations workstream). Behind the #metro=1 flag.
//   MetroStations.init()                      after MetroNet is available (it waits for MetroNet.load() itself)
//   MetroStations.update(dt, camPos)          every frame: streaming (build within ~1.5 km, time-sliced), LOD, boards
//   MetroStations.setBoard(id, platformKey, rows)   live departures for the platform displays (SIM)
//        rows = [{ line: 'yellow'|..., color: '#ffff33', dest: 'SFO / Millbrae', cars: 10, min: 3 }]
//   MetroStations.floorAt(x, y, z)            walkable floor height for feet near y (null outside any station)
//   MetroStations.blocked(x0, z0, x1, z1, y)  true when a wall is between the two points at that height
//   MetroStations.spawnPoint(id, platformKey) { x, y, z, yaw } on a platform
//   MetroStations.list / byId                 station records { id, name, type, x, z, plan, built, ... }
//   MetroStations.limits(id)                  [{ track, s0, s1 }]: where station structure replaces the guideway (INFRA)
// Station geometry is generated from MetroNet (tracks, platforms, levels, entrances) by the archetype builders in
// 27_stationtypes.js, with hand-authored hero overrides (27_stationheroes.js) and the kit (27_stationkit.js,
// 27_stationparts.js, 27_stationsigns.js).
const MetroStations = (() => {
  const hash = new URLSearchParams(location.hash.slice(1));
  const enabled = hash.get('metro') === '1' || hash.has('metrostations');
  const group = new THREE.Group(); group.name = 'metrostations';
  const list = [], byId = {};
  let net = null, ready = false, initP = null;
  const PLAT_H = 0.991, EDGE = 1.676;
  const BUILD_R = 1500, DROP_R = 2100, NEAR_R = 320, FAR_R = 9000;
  const stats = { built: 0, building: 0, jobsMs: 0, lastBuildMs: 0, tris: 0, calls: 0 };

  // ------------------------------------------------------------------------------------------------ network access
  // MetroNet (data workstream) when present; else a small private reader of metro/network.json + metro/tracks.bin
  const NetLite = (() => {
    let J = null; const T = new Map();
    async function load() {
      J = await Stream.json('metro/network.json', 2);
      const bin = await Stream.bin(J.tracksBin && J.tracksBin.path ? J.tracksBin.path : 'metro/tracks.bin', 2);
      const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
      for (const t of J.tracks) {
        const n = t.n, pts = new Float32Array(n * 3);
        for (let i = 0; i < n * 3; i++) pts[i] = dv.getFloat32(t.off + i * 4, true);
        const meta = new Uint8Array(bin.buffer, bin.byteOffset + t.off + n * 12, n * 4);
        T.set(t.id, Object.assign({}, t, { pts, meta }));
      }
      return api;
    }
    function frame(id, s, out = {}) {
      const t = T.get(id); if (!t) return null;
      const n = t.n, st = t.step; const f = U.clamp(s / st, 0, n - 1.0001); const i = Math.floor(f), k = f - i; const P = t.pts;
      const x = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * k, y = P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * k, z = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * k;
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 2); let dx = P[i1 * 3] - P[i0 * 3], dz = P[i1 * 3 + 2] - P[i0 * 3 + 2]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      out.x = x; out.y = y; out.z = z; out.dx = dx; out.dz = dz; out.rx = -dz; out.rz = dx; out.grade = (P[i1 * 3 + 1] - P[i0 * 3 + 1]) / Math.max(1e-3, (i1 - i0) * st);
      out.structure = (J.structCodes || [])[t.meta[i * 4]] || 'grade';
      return out;
    }
    // nearest point on a track to (x, z): { s, d, lat } (lat > 0: to the right of the track direction)
    function nearestOn(id, x, z, s0 = 0, s1 = 1e9) {
      const t = T.get(id); if (!t) return null; const P = t.pts, st = t.step;
      let bi = -1, bd = 1e18; const a = Math.max(0, Math.floor(s0 / st)), b = Math.min(t.n - 2, Math.ceil(s1 / st));
      for (let i = a; i <= b; i++) { const dx = P[i * 3] - x, dz = P[i * 3 + 2] - z, d = dx * dx + dz * dz; if (d < bd) { bd = d; bi = i; } }
      if (bi < 0) return null;
      // refine on the two adjacent segments
      let best = null;
      for (const j of [bi - 1, bi]) { if (j < 0 || j >= t.n - 1) continue;
        const ax = P[j * 3], az = P[j * 3 + 2], bx = P[j * 3 + 3], bz = P[j * 3 + 5]; const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1;
        const u = U.clamp(((x - ax) * ex + (z - az) * ez) / L2, 0, 1); const px = ax + ex * u, pz = az + ez * u; const d = Math.hypot(x - px, z - pz);
        if (!best || d < best.d) { const L = Math.sqrt(L2); const lat = ((x - ax) * (-ez) + (z - az) * ex) / L * -1; best = { s: (j + u) * st, d, lat: -((x - ax) * ez - (z - az) * ex) / L }; void lat; } }
      return best;
    }
    const api = { load, frame, nearestOn, get stations() { return J ? J.stations : []; }, get lines() { return J ? J.lines : []; }, get tracks() { return J ? J.tracks : []; }, track: (id) => T.get(id), json: () => J };
    return api;
  })();
  // unified access used by everything below
  const N = {
    frame: (id, s, out) => (typeof MetroNet !== 'undefined' && MetroNet.frame ? MetroNet.frame(id, s, out) : NetLite.frame(id, s, out)),
    stations: () => (typeof MetroNet !== 'undefined' && MetroNet.stations ? MetroNet.stations : NetLite.stations),
    lines: () => (typeof MetroNet !== 'undefined' && MetroNet.lines ? MetroNet.lines : NetLite.lines),
    tracks: () => (typeof MetroNet !== 'undefined' && MetroNet.tracks ? MetroNet.tracks : NetLite.tracks),
    trackLen(id) { const t = (typeof MetroNet !== 'undefined' && MetroNet.byTrack) ? MetroNet.byTrack[id] : NetLite.track(id); return t ? (t.length || (t.n - 1) * t.step) : 0; },
    nearestOn(id, x, z, s0, s1) { return NetLite.nearestOn(id, x, z, s0, s1); },
  };

  // ------------------------------------------------------------------------------------------------ station plans
  // A plan puts a station into its own curvilinear frame: the SPINE runs along the station's tracks (the reference
  // track shifted to the middle of the station's tracks), sampled every DU m; u = metres along it (0 at the centre of
  // the platforms), v = metres to the right, y absolute. Every station track gets v(u), y(u) samples, every platform
  // its edges, and the archetype builders work in (u, v, y).
  const DU = 2;
  const F = {}, F2 = {};
  function makePlan(rec) {
    const P = (rec.platforms || []).filter(p => p.track);
    if (!P.length) return null;
    const ref = P[0]; const sc = (ref.s0 + ref.s1) / 2;
    if (!N.frame(ref.track, sc, F)) return null;
    const cx = F.x, cz = F.z, tx = F.dx, tz = F.dz;
    // tracks of the station: every platform's track (+ nearby tracks the data lists as serving the station later)
    const tids = [...new Set(P.map(p => p.track))];
    // lateral offsets of each track at the centre, relative to the reference track (right = +)
    const offs = {};
    for (const id of tids) { const n = N.nearestOn(id, cx, cz); offs[id] = n ? -n.lat : 0; }
    // the station length along the reference track: all platform extents mapped to u
    const halfL = Math.max(...P.map(p => (p.s1 - p.s0) / 2), 107);
    const margin = 40;
    const u0 = -halfL - margin, u1 = halfL + margin;
    const vShift = tids.length > 1 ? (Math.min(...Object.values(offs)) + Math.max(...Object.values(offs))) / 2 : 0;
    // spine samples: along the reference track, shifted by vShift to the station middle
    const spine = [];
    const sRefDir = 1;
    for (let u = u0; u <= u1 + 1e-6; u += DU) {
      const s = U.clamp(sc + u * sRefDir, 0, N.trackLen(ref.track) || 1e9);
      N.frame(ref.track, s, F);
      spine.push({ u, x: F.x + F.rx * vShift, y: F.y, z: F.z + F.rz * vShift, tx: F.dx, tz: F.dz, grade: F.grade || 0, structure: F.structure });
    }
    // per-track v(u), y(u): intersect the spine normal lines with each track
    const tracks = [];
    for (const id of tids) {
      const v = new Float32Array(spine.length), y = new Float32Array(spine.length), s = new Float32Array(spine.length);
      let ok = 0;
      for (let i = 0; i < spine.length; i++) {
        const sp = spine[i]; const n = N.nearestOn(id, sp.x, sp.z);
        if (!n) continue; N.frame(id, n.s, F2);
        // lateral position of the track point in the spine frame
        const rx = -sp.tz, rz = sp.tx; v[i] = (F2.x - sp.x) * rx + (F2.z - sp.z) * rz; y[i] = F2.y; s[i] = n.s; ok++;
      }
      tracks.push({ id, v, y, s, ok });
    }
    // station reference rail height: the mean of the platform tracks at the centre (the v0 profile can disagree by
    // metres between the two tracks of one station; stacked stations keep each track's own height)
    const mid = Math.floor(spine.length / 2);
    const stacked = rec.layout === 'stacked';
    const yRails = tracks.map(t => t.y[mid]);
    const yRail = yRails.reduce((a, b) => a + b, 0) / Math.max(1, yRails.length);
    const spread = Math.max(...yRails) - Math.min(...yRails);
    // platforms in spine coordinates: edge line v(u) = track v + side * EDGE
    const plats = P.map((p, k) => {
      const t = tracks.find(t => t.id === p.track); const sideR = p.side === 'right' ? 1 : -1;
      // is the track running along +u or -u? compare its tangent with the spine's at the centre
      N.frame(p.track, (p.s0 + p.s1) / 2, F2); const along = F2.dx * tx + F2.dz * tz >= 0 ? 1 : -1;
      const sideV = sideR * along;      // +1: the platform is on the +v side of its track
      // platform u-range: its s-range mapped through the track's s(u)
      let pu0 = 1e9, pu1 = -1e9; for (let i = 0; i < spine.length; i++) { const ss = t.s[i]; if (ss >= p.s0 - 1 && ss <= p.s1 + 1) { pu0 = Math.min(pu0, spine[i].u); pu1 = Math.max(pu1, spine[i].u); } }
      if (pu0 > pu1) { pu0 = -halfL; pu1 = halfL; }
      return { key: p.code || String(k + 1), gtfs: p.gtfs, track: p.track, sideV, u0: pu0, u1: pu1, t, yRail: stacked ? t.y[mid] : yRail, dataY: p.y, structure: p.structure };
    });
    return { id: rec.id, spine, tracks, plats, u0, u1, halfL, yRail, spread, stacked, cx: spine[mid].x, cz: spine[mid].z, tx, tz, vShift, ref: ref.track };
  }
  // spine interpolation: world point at (u, v, y) and the frame there
  function spineAt(plan, u, out = {}) {
    const S = plan.spine; const f = U.clamp((u - S[0].u) / DU, 0, S.length - 1.0001); const i = Math.floor(f), k = f - i; const a = S[i], b = S[i + 1];
    out.x = a.x + (b.x - a.x) * k; out.z = a.z + (b.z - a.z) * k; out.y = a.y + (b.y - a.y) * k;
    let tx = a.tx + (b.tx - a.tx) * k, tz = a.tz + (b.tz - a.tz) * k; const l = Math.hypot(tx, tz) || 1; out.tx = tx / l; out.tz = tz / l; out.rx = -out.tz; out.rz = out.tx;
    return out;
  }
  function trackV(plan, t, u) { const S = plan.spine; const f = U.clamp((u - S[0].u) / DU, 0, S.length - 1.0001); const i = Math.floor(f), k = f - i; return t.v[i] + (t.v[i + 1] - t.v[i]) * k; }

  // ------------------------------------------------------------------------------------------------ records
  function stationRecords() {
    for (const s of N.stations()) {
      if (byId[s.id]) continue;
      const w = (s.x !== undefined) ? { x: s.x, z: s.z } : Geo.ll2w(s.lat, s.lon);
      const r = { id: s.id, name: s.name, type: s.type, layout: s.layout, hero: !!s.hero, x: w.x, z: w.z, data: s, plan: null, state: 'idle', root: null, dist: 1e9,
        cells: [], lights: [], boards: new Map(), walk: null, lod: 0 };
      list.push(r); byId[s.id] = r;
    }
  }

  // ------------------------------------------------------------------------------------------------ jobs (time-sliced)
  const jobs = [];
  function runJobs(budgetMs) {
    const t0 = performance.now();
    while (jobs.length && performance.now() - t0 < budgetMs) {
      const j = jobs[0];
      try { const r = j.gen.next(); if (r.done) { jobs.shift(); j.done && j.done(r.value); } }
      catch (e) { console.error('metrostations job', j.name, e); jobs.shift(); j.fail && j.fail(e); }
    }
    stats.jobsMs = performance.now() - t0;
  }

  // ------------------------------------------------------------------------------------------------ build / drop
  function startBuild(st) {
    if (!st.plan) st.plan = makePlan(st.data);
    if (!st.plan) { st.state = 'nodata'; return; }
    st.state = 'building'; stats.building++;
    const t0 = performance.now();
    jobs.push({ name: st.id, gen: StationTypes.build(st, ctx()), done: (res) => { st.state = 'built'; stats.building--; stats.built++; stats.lastBuildMs = performance.now() - t0; attach(st, res); },
      fail: () => { st.state = 'failed'; stats.building--; } });
  }
  function attach(st, res) {
    st.root = res.root; st.res = res; group.add(res.root);
    st.walk = res.walk || null;
    for (const c of res.cells || []) if (typeof Under !== 'undefined' && Under.addCell) try { Under.addCell(c.under); } catch (e) { console.warn('Under.addCell', e); }
    for (const p of res.portals || []) if (typeof Under !== 'undefined' && Under.addPortal) try { Under.addPortal(p); } catch (e) { console.warn('Under.addPortal', e); }
    for (const c of res.cuts || []) if (typeof Under !== 'undefined' && Under.addCut) try { Under.addCut(c); } catch (e) { console.warn('Under.addCut', e); }
    for (const b of res.boards || []) st.boards.set(b.key, b);
    st.root.updateMatrixWorld(true);
  }
  function drop(st) {
    if (!st.root) return;
    group.remove(st.root);
    st.root.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { for (const m of Array.isArray(o.material) ? o.material : [o.material]) { if (m.userData && m.userData.shared) continue; if (m.map && !(m.map.userData && m.map.userData.shared)) m.map.dispose(); m.dispose(); } } });
    if (typeof Under !== 'undefined' && Under.remove && st.res) { for (const c of st.res.cells || []) try { Under.remove(c.under.id); } catch (e) {} for (const c of st.res.cuts || []) try { Under.remove(c.id); } catch (e) {} }
    st.root = null; st.res = null; st.walk = null; st.boards.clear(); st.state = 'idle'; stats.built--;
  }
  // build context shared with the type builders
  let CTX = null;
  function ctx() {
    if (CTX) return CTX;
    CTX = { PLAT_H, EDGE, DU, spineAt, trackV, N, lines: N.lines(), renderer: Env.renderer, stationsList: list };
    return CTX;
  }

  // ------------------------------------------------------------------------------------------------ init / update
  function init() {
    if (!enabled || initP) return initP;
    Env.scene.add(group);
    const waitNet = (typeof MetroNet !== 'undefined' && MetroNet.load) ? Promise.resolve(MetroNet.ready || MetroNet.load()) : NetLite.load();
    initP = waitNet.then(() => { net = true; stationRecords(); ready = true; if (typeof MetroSigns !== 'undefined') MetroSigns.init(N.lines(), list); })
      .catch(e => { console.warn('MetroStations: no network data', e); });
    return initP;
  }
  const _cam = new THREE.Vector3();
  function update(dt, camPos) {
    if (!enabled || !ready) return;
    const alt = Math.max(0, camPos.y - (typeof Terrain !== 'undefined' ? Terrain.h(camPos.x, camPos.z) : 0));
    // distances, build and drop decisions (nearest first; one new build at a time keeps the frame even)
    let want = null, wd = 1e18;
    for (const st of list) {
      st.dist = Math.hypot(st.x - camPos.x, st.z - camPos.z);
      const eff = Math.hypot(st.dist, alt * 0.8);
      if (st.state === 'idle' && eff < BUILD_R && eff < wd) { want = st; wd = eff; }
      if (st.state === 'built' && eff > DROP_R) drop(st);
    }
    if (want && stats.building === 0) startBuild(want);
    runJobs(3.0);
    // LOD and per-frame state
    const night = U.uNight.value;
    for (const st of list) {
      if (!st.root) continue;
      const eff = Math.hypot(st.dist, alt);
      st.root.visible = eff < FAR_R;
      const r = st.res;
      if (r && r.near) r.near.visible = eff < NEAR_R;
      if (r && r.update) r.update(dt, camPos, night);
    }
    if (typeof MetroSigns !== 'undefined') MetroSigns.update(dt, list);
  }

  // ------------------------------------------------------------------------------------------------ walk metadata
  // floors: { poly: [x0,z0, x1,z1, ...] world (convex, any winding), a, bx, bz, x0, z0 (plane y = a + bx (x-x0) + bz (z-z0)), y0, y1 }
  // walls:  { x0, z0, x1, z1, y0, y1 }
  function inPoly(P, x, z) { let c = false; for (let i = 0, n = P.length / 2, j = n - 1; i < n; j = i++) { const xi = P[i * 2], zi = P[i * 2 + 1], xj = P[j * 2], zj = P[j * 2 + 1]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; }
  function floorAt(x, y, z) {
    let best = null;
    for (const st of list) {
      const W = st.walk; if (!W || Math.abs(st.x - x) > 700 || Math.abs(st.z - z) > 700) continue;
      for (const f of W.floors) {
        if (x < f.bx0 || x > f.bx1 || z < f.bz0 || z > f.bz1) continue;
        if (!inPoly(f.poly, x, z)) continue;
        const h = f.a + f.gx * (x - f.x0) + f.gz * (z - f.z0);
        if (h > y + 0.62) continue;                     // too high to step onto
        if (best === null || h > best) best = h;        // the highest floor at or below the feet (+ a step)
      }
    }
    return best;
  }
  function segHit(ax, az, bx, bz, cx, cz, dx, dz) {
    const d = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx); if (Math.abs(d) < 1e-12) return false;
    const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / d, u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }
  function blocked(x0, z0, x1, z1, y) {
    for (const st of list) {
      const W = st.walk; if (!W || Math.abs(st.x - x0) > 700 || Math.abs(st.z - z0) > 700) continue;
      for (const w of W.walls) { if (y + 1.0 < w.y0 || y + 0.3 > w.y1) continue; if (segHit(x0, z0, x1, z1, w.x0, w.z0, w.x1, w.z1)) return true; }
    }
    return false;
  }
  function spawnPoint(id, key) {
    const st = byId[id]; if (!st) return null; if (!st.plan) st.plan = makePlan(st.data); const pl = st.plan; if (!pl) return null;
    const p = pl.plats.find(q => q.key === String(key)) || pl.plats[0]; const u = (p.u0 + p.u1) / 2 + 12;
    const S = spineAt(pl, u, {}); const v = trackV(pl, p.t, u) + p.sideV * (EDGE + 2.2);
    return { x: S.x + S.rx * v, y: p.yRail + PLAT_H, z: S.z + S.rz * v, yaw: Math.atan2(-S.rx * p.sideV, -S.rz * p.sideV) };
  }
  function limits(id) {
    const st = byId[id]; if (!st) return []; if (!st.plan) st.plan = makePlan(st.data); const pl = st.plan; if (!pl) return [];
    const L = st.res && st.res.limits ? st.res.limits : [pl.u0 + 28, pl.u1 - 28];
    return pl.tracks.map(t => { const i0 = Math.round((L[0] - pl.u0) / DU), i1 = Math.round((L[1] - pl.u0) / DU); const a = t.s[U.clamp(i0, 0, t.s.length - 1)], b = t.s[U.clamp(i1, 0, t.s.length - 1)]; return { track: t.id, s0: Math.min(a, b), s1: Math.max(a, b) }; });
  }
  function setBoard(id, key, rows) { const st = byId[id]; if (!st) return; if (typeof MetroSigns !== 'undefined') MetroSigns.setBoard(st, String(key), rows); }

  return { init, update, setBoard, floorAt, blocked, spawnPoint, limits, list, byId, group, stats, get enabled() { return enabled; }, get ready() { return ready; },
    makePlan, spineAt, trackV, net: N, PLAT_H, EDGE, jobs };
})();
