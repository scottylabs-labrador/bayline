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
//   MetroStations.keepOut(x, z, what)         true inside a station's ground-level footprint (+ a margin for `what`:
//                                             'building' | 'house' | 'tree' | 'lamp' | 'grass' | 'car' | 'road'); the world's
//                                             placers ask it under #metro=1 (Towns via addDrop and ctx.keepOut, Flora,
//                                             GroundCover, Life parking and traffic). keepOutAny(x0, z0, x1, z1, what): quick reject.
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
  const stats = { built: 0, building: 0, jobsMs: 0, lastBuildMs: 0, tris: 0, calls: 0, koStations: 0, koZones: 0, koMs: 0, koCalls: 0 };
  const debug = { showAll: false }; const qa = { hidden: [] };

  // ------------------------------------------------------------------------------------------------ network access
  // everything goes through MetroNet (data workstream, 21_metronet.js); frames are reduced to the plan view here
  const N = {
    frame(id, s, out = {}) {
      const f = MetroNet.frame(id, s, out); if (!f) return null;
      const hl = Math.hypot(f.tx, f.tz) || 1; out.dx = f.tx / hl; out.dz = f.tz / hl; out.hrx = -out.dz; out.hrz = out.dx;
      out.structure = f.structName; return out;
    },
    stations: () => MetroNet.stations,
    lines: () => MetroNet.lines,
    trackLen(id) { const t = MetroNet.byId[id]; return t ? t.length : 0; },
    nearestOn(id, x, z) { const r = MetroNet.nearAll(x, z, 90, (t) => t.id === id); const q = r[0]; return q ? { s: q.s, d: q.dist, lat: q.lat } : null; },
  };

  // ------------------------------------------------------------------------------------------------ station plans
  // A plan puts a station into its own curvilinear frame: the SPINE runs along the station's tracks (the reference
  // track shifted to the middle of the station's tracks), sampled every DU m; u = metres along it (0 at the centre of
  // the platforms), v = metres to the right, y absolute. Every station track gets v(u), y(u) samples, every platform
  // its edges, and the archetype builders work in (u, v, y).
  const DU = 2;
  const F = {}, F2 = {};
  function makePlan(rec) {
    // the airport connector's platform at Coliseum is its own small station (a hero feature); a station that is only
    // connector (Oakland Airport) keeps its short platform
    const sysOf = (p) => { const t = MetroNet.byId[p.track]; return t ? t.sys : 'bart'; };
    let P = (rec.platforms || []).filter(p => p.track && MetroNet.byId[p.track]);
    const main = P.filter(p => sysOf(p) !== 'oac'); const oac = P.filter(p => sysOf(p) === 'oac');
    if (main.length) P = main;
    if (!P.length) return null;
    const isOac = !main.length;
    const ref = P[0]; const sc = (ref.s0 + ref.s1) / 2;
    if (!N.frame(ref.track, sc, F)) return null;
    const cx = F.x, cz = F.z, tx = F.dx, tz = F.dz;
    // tracks of the station: every platform's track (+ nearby tracks the data lists as serving the station later)
    const tids = [...new Set(P.map(p => p.track))];
    // lateral offsets of each track at the centre, relative to the reference track (right = +)
    const offs = {};
    for (const id of tids) { const n = N.nearestOn(id, cx, cz); if (!n) { offs[id] = 0; continue; } N.frame(id, n.s, F2); offs[id] = (F2.x - cx) * -tz + (F2.z - cz) * tx; }
    // the station length along the reference track: all platform extents mapped to u
    const halfL = Math.max(...P.map(p => (p.s1 - p.s0) / 2), isOac ? 22 : 107);
    const margin = isOac ? 15 : 40;
    const u0 = -halfL - margin, u1 = halfL + margin;
    const vShift = tids.length > 1 ? (Math.min(...Object.values(offs)) + Math.max(...Object.values(offs))) / 2 : 0;
    // spine samples: along the reference track, shifted by vShift to the station middle
    const spine = [];
    const sRefDir = 1;
    for (let u = u0; u <= u1 + 1e-6; u += DU) {
      const sw = sc + u * sRefDir, len = N.trackLen(ref.track) || 1e9, s = U.clamp(sw, 0, len), ex = sw - s;   // past a track end: extrapolate
      N.frame(ref.track, s, F);
      spine.push({ u, x: F.x + F.hrx * vShift + F.dx * ex, y: F.y + (F.grade || 0) * ex, z: F.z + F.hrz * vShift + F.dz * ex, tx: F.dx, tz: F.dz, grade: F.grade || 0, structure: F.structure });
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
    return { id: rec.id, spine, tracks, plats, u0, u1, halfL, yRail, spread, stacked, cx: spine[mid].x, cz: spine[mid].z, tx, tz, vShift, ref: ref.track, oac: oac.length && main.length ? oac : null, isOac };
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
    // the station meets the ground (bents, trench walls, entrances, footbridge supports): build it on the fine terrain,
    // as the Peninsula stations do (Terrain.ensure), with a time-out so a slow tile never blocks a station
    const r = 280; const cx = st.plan.cx, cz = st.plan.cz;
    const ready = typeof Terrain !== 'undefined' && Terrain.ensure ? Promise.race([Terrain.ensure(cx - r, cz - r, cx + r, cz + r, 1), new Promise(res => setTimeout(res, 20000))]) : Promise.resolve();
    // the streets under and around it (Towns decodes them on request): lobbies and bents keep clear of them
    const streets = () => new Promise(res => {
      if (typeof Towns === 'undefined' || !Towns.roadsNear) return res();
      let last = -1, same = 0, n = 0;
      const tick = () => { let c = 0; try { c = Towns.roadsNear(cx, cz, 320).length; } catch (e) {} same = c === last && c > 0 ? same + 1 : 0; last = c;
        if (same >= 2 || ++n > 24) { try { st.roads = Towns.roadsNear(cx, cz, 320); } catch (e) {} return res(); } setTimeout(tick, 250); };
      tick();
    });
    ready.catch(() => {}).then(streets).then(() => {
      const t0 = performance.now();
      jobs.push({ name: st.id, gen: StationTypes.build(st, ctx()), done: (res) => { st.state = 'built'; stats.building--; stats.built++; stats.lastBuildMs = performance.now() - t0; attach(st, res); },
        fail: (e) => { st.state = 'failed'; st.error = String(e && e.stack || e).slice(0, 400); stats.building--; } });
    });
  }
  function attach(st, res) {
    st.root = res.root; st.res = res; group.add(res.root);
    // Under: a station without cells (aerial, at grade) is outdoor world: hidden with it while the camera is underground
    // and no opening to the outdoors is in view; underground levels are cell groups (their visibility is Under's)
    if (typeof Under !== 'undefined' && Under.enabled && !(res.cells && res.cells.length)) Under.outdoor(res.root, true);
    st.walk = res.walk || null;
    for (const c of res.cells || []) if (typeof Under !== 'undefined' && Under.addCell) try { Under.addCell(c.under); } catch (e) { console.warn('Under.addCell', e); }
    for (const p of res.portals || []) if (typeof Under !== 'undefined' && Under.addPortal) try { Under.addPortal(p); } catch (e) { console.warn('Under.addPortal', e); }
    for (const c of res.cuts || []) if (typeof Under !== 'undefined' && Under.addCut) try { Under.addCut(c); } catch (e) { console.warn('Under.addCut', e); }
    for (const b of res.boards || []) st.boards.set(b.key, b);
    st.root.updateMatrixWorld(true);
    if (res.footprint && setFootprint(st, res.footprint)) {
      try { const cp = Env.camera.position; if (typeof World !== 'undefined' && World.traffic && Math.hypot(cp.x - st.x, cp.z - st.z) < 900) World.traffic.cx = 1e9; } catch (e) {}
    }
  }
  function drop(st) {
    if (!st.root) return;
    group.remove(st.root);
    st.root.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { for (const m of Array.isArray(o.material) ? o.material : [o.material]) { if (m.userData && m.userData.shared) continue; if (m.map && !(m.map.userData && m.map.userData.shared)) m.map.dispose(); m.dispose(); } } });
    if (typeof Under !== 'undefined' && Under.enabled && st.res) { for (const c of st.res.cells || []) try { Under.remove(c.under.id); } catch (e) {} for (const c of st.res.cuts || []) try { Under.remove(c.id); } catch (e) {}
      for (const p of st.res.portals || []) if (p.id) try { Under.remove(p.id); } catch (e) {} try { Under.outdoor(st.root, false); } catch (e) {} }
    if (typeof MetroSigns !== 'undefined') { MetroSigns.freeBoards(st); MetroSigns.releaseAtlas(st); }
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
    // the stations group stays drawn underground (Under hides the outdoor world there); visibility inside it is per cell
    // group (underground levels) and per outdoor station root (Under.outdoor)
    if (typeof Under !== 'undefined' && Under.enabled && Under.keep) Under.keep(group);
    const waitNet = MetroNet.load();
    initP = waitNet.then(() => {
      net = true; stationRecords(); indexStations(); ready = true;
      if (typeof MetroSigns !== 'undefined') MetroSigns.init(N.lines(), list);
      // keep-out zones: Towns drops OSM buildings standing in a station (Towns.addDrop, world workstream), the rest of
      // the world asks keepOut() itself; anything placed before now is placed again
      if (typeof Towns !== 'undefined' && Towns.addDrop) Towns.addDrop(dropBuilding);
      refreshWorld();
    })
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
      if (r && r.nears) { const nv = eff < NEAR_R; for (const g of r.nears) g.visible = nv; }
      if (r && r.update) r.update(dt, camPos, night);
    }
    if (typeof MetroSigns !== 'undefined') MetroSigns.update(dt, list);
    if (typeof StationCrowds !== 'undefined') StationCrowds.update(dt, camPos, list);
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
    // key: a platform code ('1') or a GTFS platform id ('M20-1')
    const k = String(key == null ? '' : key); const code = k.includes('-') ? k.split('-').pop() : k;
    const p = pl.plats.find(q => q.gtfs === k || q.key === code) || pl.plats[0]; const u = (p.u0 + p.u1) / 2 + 12;
    const S = spineAt(pl, u, {}); const v = trackV(pl, p.t, u) + p.sideV * (EDGE + 2.2);
    return { x: S.x + S.rx * v, y: p.yRail + PLAT_H, z: S.z + S.rz * v, yaw: Math.atan2(-S.rx * p.sideV, -S.rz * p.sideV) };
  }
  function limits(id) {
    const st = byId[id]; if (!st) return []; if (!st.plan) st.plan = makePlan(st.data); const pl = st.plan; if (!pl) return [];
    const L = st.res && st.res.limits ? st.res.limits : [pl.u0 + 28, pl.u1 - 28];
    return pl.tracks.map(t => { const i0 = Math.round((L[0] - pl.u0) / DU), i1 = Math.round((L[1] - pl.u0) / DU); const a = t.s[U.clamp(i0, 0, t.s.length - 1)], b = t.s[U.clamp(i1, 0, t.s.length - 1)]; return { track: t.id, s0: Math.min(a, b), s1: Math.max(a, b) }; });
  }
  function setBoard(id, key, rows) { const st = byId[id]; if (!st) return; if (typeof MetroSigns !== 'undefined') MetroSigns.setBoard(st, String(key), rows); }

  // ------------------------------------------------------------------------------------------------ keep-out zones
  // Ground-level station footprints for the world's placers: Towns buildings and infill houses, trees, street lamps,
  // grass, parked cars and moving traffic. The zones are StationTypes.footprint (the same plan the builders use), made
  // for a station the first time anything asks near it (~4 ms), so they exist before the station is ever built.
  //   keepOut(x, z, what, extra)         what: 'building' (default) | 'house' | 'tree' | 'lamp' | 'grass' | 'car' | 'road';
  //                                      extra: metres added to the margin (a road's half width); y: the height of the
  //                                      thing (a road or a car well below an embanked trackway passes under it)
  //   keepOutAny(x0, z0, x1, z1, what)   false when no zone (with its margin) can touch the box: skip the per-item tests
  //   dropBuilding(b, cx, cz)            a Towns.addDrop filter: OSM buildings standing in a footprint
  // Each zone kind keeps a margin per consumer (PAD); -1 = the zone does not apply to it (cars park and drive under a
  // deck or a footbridge, but not through a column, a lobby or a trackway; houses keep a yard's distance).
  const KIND = { deck: 0, track: 1, lobby: 2, plaza: 3, column: 4, bridge: 5, entrance: 6 };
  const PAD = {
    //          deck track lobby plaza column bridge entrance
    building: [1.5, 2.0, 2.0, 1.0, 0.8, 1.0, -1],
    house:    [4.0, 7.0, 8.0, 6.0, 4.0, 4.0, 5.0],
    tree:     [2.5, 3.0, 3.0, 1.5, 2.0, 2.0, 1.2],
    lamp:     [1.0, 2.0, 2.0, 0.5, 1.5, 1.0, 0.8],
    grass:    [-1, 0.3, 0.3, 0.0, 0.3, -1, 0.3],
    car:      [-1, 2.0, 2.5, 1.0, 1.2, -1, 1.2],
    road:     [-1, 0.5, 0.5, -1, 0.8, -1, -1],
  };
  const PADMAX = 12, KC = 40, SC = 1000, SREACH = 450;
  const kgrid = new Map(), kzones = [], kdone = new Set(), sgrid = new Map();
  const kkey = (i, j) => i * 100003 + j;
  function indexStations() {
    sgrid.clear();
    for (const st of list) { const i0 = Math.floor((st.x - SREACH) / SC), i1 = Math.floor((st.x + SREACH) / SC), j0 = Math.floor((st.z - SREACH) / SC), j1 = Math.floor((st.z + SREACH) / SC);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = kkey(i, j); let a = sgrid.get(k); if (!a) sgrid.set(k, a = []); a.push(st); } }
  }
  function footprintOf(st) {
    kdone.add(st.id); const t0 = performance.now();
    if (!st.plan) st.plan = makePlan(st.data);
    if (!st.plan || typeof StationTypes === 'undefined' || !StationTypes.footprint) return;
    let zs = []; try { zs = StationTypes.footprint(st, ctx()); } catch (e) { console.warn('metrostations footprint', st.id, e); return; }
    addZones(st, zs);
    stats.koStations++; stats.koZones = kzones.length; stats.koMs += performance.now() - t0;
  }
  // the built station's own footprint replaces the first one (made on whatever terrain had streamed then): returns
  // true when it moved by more than half a metre anywhere
  function setFootprint(st, zs) {
    const old = kzones.filter(Z => Z.st === st.id);
    const moved = old.length !== zs.length || zs.some((z, i) => z.pts.some(([x, zz]) => { const P = old[i] && old[i].P; return !P || Math.min(...[0, 1, 2, 3].map(k => Math.hypot(P[k * 2] - x, P[k * 2 + 1] - zz))) > 0.5; }));
    if (!moved) return false;
    const keep = kzones.filter(Z => Z.st !== st.id); kzones.length = 0; kgrid.clear();
    for (const Z of keep) indexZone(Z);
    kdone.add(st.id); addZones(st, zs);
    return true;
  }
  function indexZone(Z) {
    const idx = kzones.length; kzones.push(Z); const [x0, z0, x1, z1] = Z.bb;
    for (let i = Math.floor((x0 - PADMAX) / KC); i <= Math.floor((x1 + PADMAX) / KC); i++) for (let j = Math.floor((z0 - PADMAX) / KC); j <= Math.floor((z1 + PADMAX) / KC); j++) {
      const k = kkey(i, j); let a = kgrid.get(k); if (!a) kgrid.set(k, a = []); a.push(idx); }
  }
  function addZones(st, zs) {
    for (const z of zs) {
      const P = new Float64Array(8); let x0 = 1e18, z0 = 1e18, x1 = -1e18, z1 = -1e18;
      // counter-clockwise (x, z) order, so "inside" = left of every edge
      let area = 0; for (let i = 0; i < 4; i++) { const a = z.pts[i], b = z.pts[(i + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; }
      const pts = area < 0 ? z.pts.slice().reverse() : z.pts;
      pts.forEach(([x, zz], i) => { P[i * 2] = x; P[i * 2 + 1] = zz; x0 = Math.min(x0, x); z0 = Math.min(z0, zz); x1 = Math.max(x1, x); z1 = Math.max(z1, zz); });
      indexZone({ st: st.id, k: KIND[z.kind], kind: z.kind, P, bb: [x0, z0, x1, z1], under: z.under !== undefined ? z.under : -1e9 });
    }
  }
  // make the footprints of every station that could reach (x, z)
  function ensureNear(x, z) {
    const a = sgrid.get(kkey(Math.floor(x / SC), Math.floor(z / SC))); if (!a) return;
    for (const st of a) if (!kdone.has(st.id) && Math.abs(st.x - x) < SREACH && Math.abs(st.z - z) < SREACH) footprintOf(st);
  }
  // signed distance-ish test for a convex counter-clockwise quad: inside, or within m of it
  function nearQuad(P, x, z, m) {
    let inside = true, d2 = 1e18;
    for (let i = 0; i < 4; i++) {
      const ax = P[i * 2], az = P[i * 2 + 1], bx = P[((i + 1) & 3) * 2], bz = P[((i + 1) & 3) * 2 + 1];
      const ex = bx - ax, ez = bz - az; if ((ex * (z - az) - ez * (x - ax)) < 0) inside = false;
      if (m > 0) { const L2 = ex * ex + ez * ez || 1; const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2)); const dx = ax + ex * t - x, dz = az + ez * t - z; d2 = Math.min(d2, dx * dx + dz * dz); }
    }
    return inside || (m > 0 && d2 < m * m);
  }
  function keepOut(x, z, what = 'building', extra = 0, y) {
    if (!enabled || !ready) return false;
    const pads = PAD[what] || PAD.building;
    stats.koCalls++;
    ensureNear(x, z);
    const a = kgrid.get(kkey(Math.floor(x / KC), Math.floor(z / KC))); if (!a) return false;
    for (const i of a) { const Z = kzones[i]; let m = pads[Z.k]; if (m < 0 || (y !== undefined && y < Z.under)) continue; m += extra;
      if (x < Z.bb[0] - m || x > Z.bb[2] + m || z < Z.bb[1] - m || z > Z.bb[3] + m) continue;
      if (nearQuad(Z.P, x, z, m)) return true; }
    return false;
  }
  function keepOutAny(x0, z0, x1, z1, what = 'building') {
    if (!enabled || !ready) return false;
    const pads = PAD[what] || PAD.building;
    // stations whose reach touches the box get their footprints first
    const seen = new Set();
    for (let i = Math.floor((x0 - SREACH) / SC); i <= Math.floor((x1 + SREACH) / SC); i++) for (let j = Math.floor((z0 - SREACH) / SC); j <= Math.floor((z1 + SREACH) / SC); j++) {
      const a = sgrid.get(kkey(i, j)); if (!a) continue;
      for (const st of a) if (!seen.has(st) && (seen.add(st), true) && !kdone.has(st.id) && st.x > x0 - SREACH && st.x < x1 + SREACH && st.z > z0 - SREACH && st.z < z1 + SREACH) footprintOf(st);
    }
    for (const Z of kzones) { const m = pads[Z.k]; if (m < 0) continue; if (Z.bb[2] + m >= x0 && Z.bb[0] - m <= x1 && Z.bb[3] + m >= z0 && Z.bb[1] - m <= z1) return true; }
    return false;
  }
  // OSM buildings (Towns.addDrop: b.pts tile-local [x, z, ...], centroid given in world coordinates): dropped when the
  // centroid stands in a footprint, or the outline reaches into a lobby, trackway or column, or a lobby / column
  // stands inside the outline, or two corners stand under a deck
  const KIND_HARD = [false, true, true, false, true, false, false];
  function dropBuilding(b, cx, cz) {
    if (!enabled || !ready || !b || !b.pts) return false;
    if (keepOut(cx, cz, 'building')) return true;
    const P = b.pts, n = P.length / 2; if (n < 3) return false;
    let lx = 0, lz = 0; for (let i = 0; i < n; i++) { lx += P[i * 2]; lz += P[i * 2 + 1]; } const ox = cx - lx / n, oz = cz - lz / n;
    let bx0 = 1e18, bz0 = 1e18, bx1 = -1e18, bz1 = -1e18; for (let i = 0; i < n; i++) { const x = P[i * 2] + ox, z = P[i * 2 + 1] + oz; bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
    if (!keepOutAny(bx0, bz0, bx1, bz1, 'building')) return false;
    const W = []; for (let i = 0; i < n; i++) W.push(P[i * 2] + ox, P[i * 2 + 1] + oz);
    const cand = new Set();
    for (let i = Math.floor(bx0 / KC); i <= Math.floor(bx1 / KC); i++) for (let j = Math.floor(bz0 / KC); j <= Math.floor(bz1 / KC); j++) { const a = kgrid.get(kkey(i, j)); if (a) for (const k of a) cand.add(k); }
    for (const k of cand) {
      const Z = kzones[k]; if (Z.bb[2] < bx0 || Z.bb[0] > bx1 || Z.bb[3] < bz0 || Z.bb[1] > bz1) continue;
      if (KIND_HARD[Z.k]) {
        for (let i = 0; i < n; i++) if (nearQuad(Z.P, W[i * 2], W[i * 2 + 1], 0)) return true;
        const zx = (Z.P[0] + Z.P[2] + Z.P[4] + Z.P[6]) / 4, zz = (Z.P[1] + Z.P[3] + Z.P[5] + Z.P[7]) / 4; if (inPoly(W, zx, zz)) return true;
      } else if (Z.k === KIND.deck || Z.k === KIND.bridge) {
        let c = 0; for (let i = 0; i < n; i++) if (nearQuad(Z.P, W[i * 2], W[i * 2 + 1], 0)) c++; if (c >= 2) return true;
      }
    }
    return false;
  }
  // (QA) the zones near a point: [{ st, kind, pts: [x, z, ...] }]
  function keepOutZones(x, z, r = 400) { ensureNear(x, z); return kzones.filter(Z => Z.bb[2] > x - r && Z.bb[0] < x + r && Z.bb[3] > z - r && Z.bb[1] < z + r).map(Z => ({ st: Z.st, kind: Z.kind, under: Z.under > -1e8 ? +Z.under.toFixed(1) : undefined, pts: Array.from(Z.P, v => +v.toFixed(2)) })); }
  // once the stations are known: world pieces placed before (towns, trees, parked cars) are placed again with the
  // footprints. MetroGround (world) re-places Towns and Flora itself when it installs after us.
  function refreshWorld() {
    const groundLater = typeof MetroGround !== 'undefined' && !MetroGround.installed;
    if (!groundLater) {
      try { if (typeof Towns !== 'undefined' && Towns.dispose) Towns.dispose(); } catch (e) {}
      try { if (typeof Flora !== 'undefined' && Flora.dispose) Flora.dispose(); } catch (e) {}
    }
    try { if (typeof World !== 'undefined' && World.traffic && World.traffic.lanes && World.traffic.lanes.length) World.traffic.cx = 1e9; } catch (e) {}
  }

  // ------------------------------------------------------------------------------------------------ QA camera
  // MetroStations.shot(id, { u, v, h, yaw, pitch, fov }): capture-mode camera at station coordinates (u along the
  // platforms from their middle, v to the right, h above the platform top; yaw 0 looks along +u, + turns right),
  // waits for the station to build and the exposure to settle. Resolves with { state, tris, calls }.
  async function shot(id, o = {}) {
    const B = window.__bayline, st = byId[id]; if (!B || !st) return { error: 'no station ' + id };
    if (!st.plan) st.plan = makePlan(st.data); const pl = st.plan; if (!pl) return { error: 'no plan' };
    const yT = (pl.plats[0] ? pl.plats[0].yRail : pl.yRail) + PLAT_H;
    // cutaway: a clipping plane removes everything above y = o.cut (terrain, buildings, roofs) so a station can be seen whole
    // cutaway: a clipping plane removes everything above y = yT + o.cut, and (solo) every other object in the scene is
    // hidden, so a whole station can be looked at from outside. Each call resets what the previous one changed.
    for (const c of qa.hidden) c.visible = true; qa.hidden.length = 0;
    Env.renderer.clippingPlanes = o.cut !== undefined ? [new THREE.Plane(new THREE.Vector3(0, -1, 0), yT + o.cut)] : [];
    debug.showAll = !!(o.solo || o.cut !== undefined);
    const keep = (c) => c === group || c.isLight || c === Env.camera || c === Env.sky || (c.isObject3D && c.type === 'Object3D' && c.children.length === 0);
    B.capture.before = (o.solo || o.cut !== undefined) ? () => { for (const c of Env.scene.children) if (!keep(c) && c.visible) { c.visible = false; qa.hidden.push(c); } } : null;
    if (B.Post && B.Post.debug) B.Post.debug.shafts = !(st.type === 'subway' && (o.h ?? 1.65) < 30 && o.y === undefined);
    // the camera at (u, v): height o.y absolute, o.gh above the ground there (street level), else o.h above the platform
    // top; o.lobby: u measured from the ground-level lobby's entrance end (once built)
    const aim = (u) => {
      const S = spineAt(pl, u, {}); const px = S.x + S.rx * (o.v || 0), pz = S.z + S.rz * (o.v || 0);
      const py = o.y !== undefined ? o.y : o.gh !== undefined ? Terrain.h(px, pz) + o.gh : yT + (o.h ?? 1.65);
      const yaw = Math.atan2(S.tz, S.tx) + (o.yaw || 0), pitch = o.pitch || 0;
      const tx = px + Math.cos(yaw) * Math.cos(pitch) * 10, tz = pz + Math.sin(yaw) * Math.cos(pitch) * 10, ty = py + Math.sin(pitch) * 10;
      B.capture.cam = (t, c) => { c.position.set(px, py, pz); c.up.set(0, 1, 0); c.lookAt(tx, ty, tz); if (o.fov) { c.fov = o.fov; c.updateProjectionMatrix(); } c.near = 0.05; c.updateProjectionMatrix(); };
    };
    const cam = Env.camera; if (o.fov) { cam.fov = o.fov; cam.updateProjectionMatrix(); }
    document.body.classList.add('photo');
    B.capture.on = true; aim(o.u || 0);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 900 && st.state !== 'built' && st.state !== 'failed' && st.state !== 'nodata'; i++) { B.stepFrame(1); await sleep(20); }
    if (st.state !== 'built') return { state: st.state, error: st.error || null };
    if (o.lobby !== undefined && st.res && st.res.info && isFinite(st.res.info.cu0)) aim(st.res.info.cu0 + o.lobby);
    for (let i = 0; i < (o.settle || 70); i++) { B.stepFrame(1); await sleep(25); }
    let tris = 0; if (st.root) st.root.traverse(m => { if (m.isMesh && m.geometry.index) tris += m.geometry.index.count / 3 * (m.geometry.instanceCount || 1); });
    // perf: GPU cost (Post.profile, synced) and draw calls / triangles with the metro stations drawn and hidden
    let perf = null;
    if (o.perf && B.Post && B.Post.profile) {
      const meas = () => { B.stepFrame(1); const st1 = Object.assign({}, B.Post.stats); const pr = B.Post.profile(10); return { calls: st1.calls, tris: st1.triangles, gpu: pr && pr.total, scene: pr && pr.scene }; };
      const on = meas(); group.visible = false; const off = meas(); group.visible = true;
      perf = { on, off, dCalls: on.calls - off.calls, dTris: on.tris - off.tris, dGpu: +(on.gpu - off.gpu).toFixed(2), pct: +(100 * (on.gpu - off.gpu) / Math.max(0.1, off.gpu)).toFixed(1) };
    }
    return { state: st.state, tris: Math.round(tris), post: B.Post ? B.Post.stats : null, ms: stats.lastBuildMs | 0, spread: +pl.spread.toFixed(2), info: st.res ? st.res.info : null, perf };
  }

  const api = { init, update, setBoard, floorAt, blocked, spawnPoint, limits, list, byId, group, stats, get enabled() { return enabled; }, get ready() { return ready; },
    keepOut, keepOutAny, dropBuilding, keepOutZones, KEEPOUT_PAD: PAD,
    makePlan, spineAt, trackV, net: N, PLAT_H, EDGE, jobs, shot, debug };
  // hooks: ride along with the Peninsula stations' init/update (no edits to the shared main loop; inert without #metro=1)
  if (enabled && typeof Stations !== 'undefined') {
    const si = Stations.init, su = Stations.update;
    Stations.init = function (...a) { const r = si.apply(this, a); try { api.init(); } catch (e) { console.error('metrostations init', e); } return r; };
    Stations.update = function (dt, cp, tr) { su.call(this, dt, cp, tr); try { api.update(dt, cp); } catch (e) { if (!api._err) console.error('metrostations', e); api._err = (api._err || 0) + 1; } };
  }
  if (typeof window !== 'undefined') Object.assign(window.__baylineMods = window.__baylineMods || {}, { MetroStations: api });
  return api;
})();
