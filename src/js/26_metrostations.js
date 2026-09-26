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
  const enabled = (typeof Metro !== 'undefined' ? Metro.on : hash.get('metro') === '1') || hash.has('metrostations');   // (the switch: 18_metro.js)
  const group = new THREE.Group(); group.name = 'metrostations';
  const list = [], byId = {};
  let net = null, ready = false, initP = null;
  const PLAT_H = 0.991, EDGE = 1.676;
  // platform top above the rail and edge offset from the track centre, per vehicle (TRAINS, 2026-09-26): BART cars
  // (floor 0.991, half width 1.60), the Antioch GTW DMU (sills 0.635 ASSUMED, half width 1.473), the airport people mover
  // (floor 0.36 ASSUMED, half width 1.30); edges leave the BART gap (76 mm, 3 in) or 50 mm where platform doors stand
  // minL: the shortest platform the data may give before it is taken as wrong; minHalf: the plan's least half length
  const VEH = { bart: { ph: PLAT_H, edge: EDGE, minL: 150, minHalf: 107 }, ebart: { ph: 0.635, edge: 1.549, minL: 110, minHalf: 62 }, oac: { ph: 0.36, edge: 1.35, minL: 30, minHalf: 22 } };
  const FAR_R = 9000;
  // quality (90_main's applyTier -> setQuality(tier name)): Low builds only the simple structure near the camera (no
  // animated escalator steps, the near detail within 150 m), a quarter of the crowd, 4 line lights per material, a
  // half-size sign atlas, and builds and keeps stations over shorter distances; Medium 60 % of the crowd and 8 lights.
  // A change of the detail level rebuilds the stations near the camera (nearest first).
  const QT = { ultraplus: { detail: 2, crowd: 1, lights: 12, atlas: 1, buildR: 1500, dropR: 2100, nearR: 320 }, ultra: { detail: 2, crowd: 1, lights: 12, atlas: 1, buildR: 1500, dropR: 2100, nearR: 320 },
    high: { detail: 2, crowd: 1, lights: 12, atlas: 1, buildR: 1500, dropR: 2100, nearR: 320 }, medium: { detail: 1, crowd: 0.6, lights: 8, atlas: 1, buildR: 1300, dropR: 1800, nearR: 250 },
    low: { detail: 0, crowd: 0.25, lights: 4, atlas: 0.5, buildR: 900, dropR: 1300, nearR: 150 } };
  const Q = Object.assign({ name: 'high' }, QT.high);
  function setQuality(name) {
    const q = QT[name] || QT.high; const redo = q.detail !== Q.detail || q.atlas !== Q.atlas; Object.assign(Q, q, { name: QT[name] ? name : 'high' });
    try { if (typeof StationKit !== 'undefined' && StationKit.setLightCap) StationKit.setLightCap(Q.lights); } catch (e) {}
    try { if (typeof MetroSigns !== 'undefined' && MetroSigns.setScale) MetroSigns.setScale(Q.atlas); } catch (e) {}
    if (redo) for (const st of list) { if (st.root) drop(st); }
    return Q;
  }
  const stats = { built: 0, building: 0, jobsMs: 0, lastBuildMs: 0, tris: 0, calls: 0, koStations: 0, koZones: 0, koMs: 0, koCalls: 0, maxStepMs: 0, maxStepAt: '', slowSteps: [], maxFrameMs: 0, slowFrames: [], maxFootMs: 0 };
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
  const F = {}, F2 = {}, F3 = {};
  function makePlan(rec) {
    // the airport connector's platform at Coliseum is its own small station (a hero feature); a station that is only
    // connector (Oakland Airport) keeps its short platform
    const sysOf = (p) => { const t = MetroNet.byId[p.track]; return t ? t.sys : 'bart'; };
    let P = (rec.platforms || []).filter(p => p.track && MetroNet.byId[p.track]);
    const main = P.filter(p => sysOf(p) !== 'oac'); const oac = P.filter(p => sysOf(p) === 'oac');
    if (main.length) P = main;
    if (!P.length) return null;
    const isOac = !main.length;
    const veh = (p) => VEH[sysOf(p)] || VEH.bart;
    const ref = P[0]; const sc = (ref.s0 + ref.s1) / 2;
    if (!N.frame(ref.track, sc, F)) return null;
    const cx = F.x, cz = F.z, tx = F.dx, tz = F.dz;
    // tracks of the station: every platform's track (+ nearby tracks the data lists as serving the station later)
    const tids = [...new Set(P.map(p => p.track))];
    // lateral offsets of each track at the centre, relative to the reference track (right = +)
    const offs = {};
    for (const id of tids) { const n = N.nearestOn(id, cx, cz); if (!n) { offs[id] = 0; continue; } N.frame(id, n.s, F2); offs[id] = (F2.x - cx) * -tz + (F2.z - cz) * tx; }
    // the station length along the reference track: all platform extents mapped to u
    const halfL = Math.max(...P.map(p => (p.s1 - p.s0) / 2), Math.max(...P.map(p => veh(p).minHalf)));
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
    // every other track beside the station (storage, pocket and through tracks a platform must keep clear of): its v
    // and rail height per spine sample (NaN where it is not beside the spine)
    const others = [];
    { const ids = new Set(tids), byT = new Map();
      for (let i = 0; i < spine.length; i++) { const sp = spine[i];
        for (const q of MetroNet.nearAll(sp.x, sp.z, 24)) { const id = q.track.id; if (ids.has(id)) continue;
          let o = byT.get(id); if (!o) { byT.set(id, o = { id, v: new Float32Array(spine.length).fill(NaN), y: new Float32Array(spine.length).fill(NaN) }); others.push(o); }
          MetroNet.frame(id, q.s, F3); o.v[i] = (F3.x - sp.x) * -sp.tz + (F3.z - sp.z) * sp.tx; o.y[i] = F3.y; } } }
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
      const V = veh(p);
      return { key: p.code || String(k + 1), gtfs: p.gtfs, track: p.track, sideV, u0: pu0, u1: pu1, t, yRail: stacked ? t.y[mid] : yRail, dataY: p.y, structure: p.structure,
        sys: sysOf(p), ph: V.ph, edge: V.edge, minL: V.minL };
    });
    return { id: rec.id, spine, tracks, others, plats, u0, u1, halfL, yRail, spread, stacked, cx: spine[mid].x, cz: spine[mid].z, tx, tz, vShift, ref: ref.track, oac: oac.length && main.length ? oac : null, isOac };
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
      // a BART station that also serves the airport connector (Coliseum): the connector's platform is its own
      // station build beside it, '<ID>~OAC' (spawns, boards and limits for those platforms are routed to it)
      const sysOf = (p) => { const t = MetroNet.byId[p.track]; return t ? t.sys : 'bart'; };
      const P = (s.platforms || []).filter(p => p.track && MetroNet.byId[p.track]), oac = P.filter(p => sysOf(p) === 'oac');
      if (oac.length && oac.length < P.length) {
        const f = MetroNet.frame(oac[0].track, (oac[0].s0 + oac[0].s1) / 2, {});
        const d = Object.assign({}, s, { id: s.id + '~OAC', platforms: oac, type: 'aerial', layout: 'side' });
        const sub = { id: d.id, name: s.name, type: 'aerial', layout: 'side', hero: true, x: f ? f.x : w.x, z: f ? f.z : w.z, data: d, plan: null, state: 'idle', root: null, dist: 1e9,
          cells: [], lights: [], boards: new Map(), walk: null, lod: 0, parent: r };
        list.push(sub); byId[sub.id] = sub; r.oacSub = sub; r.oacKeys = new Set(oac.flatMap(p => [p.gtfs, p.code, String(p.code)].filter(Boolean)));
      }
    }
  }
  // the record that holds a platform (the connector's sub-station for its platforms)
  const holder = (st, key) => st && st.oacSub && key != null && st.oacKeys.has(String(key)) ? st.oacSub : st;

  // ------------------------------------------------------------------------------------------------ jobs (time-sliced)
  const jobs = [];
  // (QA) the longest single step (a hitch shows here): stats.maxStepMs / maxStepAt, and the slowest frames' totals
  function runJobs(budgetMs) {
    const t0 = performance.now();
    while (jobs.length && performance.now() - t0 < budgetMs) {
      const j = jobs[0]; const s0 = performance.now();
      try { const r = j.gen.next(); if (r.done) { jobs.shift(); j.done && j.done(r.value); } }
      catch (e) { console.error('metrostations job', j.name, e); jobs.shift(); j.fail && j.fail(e); }
      const dt = performance.now() - s0, ph = j.st ? j.st._phase || '' : ''; if (dt > stats.maxStepMs) { stats.maxStepMs = +dt.toFixed(2); stats.maxStepAt = j.name + ':' + ph + ':' + (j.steps || 0); }
      j.steps = (j.steps || 0) + 1; if (dt > 12) stats.slowSteps.push([j.name, ph, j.steps, +dt.toFixed(1)]);
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
        if (same >= 2 || ++n > 24) { try { st.roads = Towns.roadsNear(cx, cz, 320); st.areas = Towns.areasNear ? Towns.areasNear(cx, cz, 200) : []; } catch (e) {} return res(); } setTimeout(tick, 250); };
      tick();
    });
    ready.catch(() => {}).then(streets).then(() => {
      const t0 = performance.now();
      // (attaching is a job of its own, in steps: Under's cells, portals and cuts, the footprint, the shader compile)
      jobs.push({ name: st.id, st, gen: StationTypes.build(st, ctx()), done: (res) => { jobs.unshift({ name: st.id + ':attach', st, gen: attachGen(st, res),
          done: () => { st.state = 'built'; stats.building--; stats.built++; stats.lastBuildMs = performance.now() - t0; }, fail: (e) => { st.state = 'failed'; st.error = String(e && e.stack || e).slice(0, 400); stats.building--; } }); },
        fail: (e) => { st.state = 'failed'; st.error = String(e && e.stack || e).slice(0, 400); stats.building--; } });
    });
  }
  // compile an object's shaders in the background for the pass that will draw it: Post draws the scene into its HDR
  // target (no tone mapping, linear output: other program keys than the screen's), so the programs are made with that
  // target bound; done() once they are linked (KHR_parallel_shader_compile), or at once without compileAsync
  function warmUp(obj, done) {
    const R = Env.renderer; if (!R || !R.compileAsync) { done(); return; }
    let prev = null;
    try {
      const rt = typeof Post !== 'undefined' && Post.enabled && Post.targets ? Post.targets.rtScene : null; prev = R.getRenderTarget();
      if (rt) R.setRenderTarget(rt);
      const pr = R.compileAsync(obj, Env.camera, Env.scene); R.setRenderTarget(prev); prev = null;
      // (a time-out in case a program never reports ready: the station must not stay hidden, nor its disposal wait)
      let fired = false; const once = () => { if (!fired) { fired = true; done(); } };
      pr.then(once, once); setTimeout(once, 8000);
    } catch (e) { if (prev !== null) try { R.setRenderTarget(prev); } catch (e2) {} done(); }
  }
  function* attachGen(st, res) {
    st._phase = 'att:root'; st.root = res.root; st.res = res; group.add(res.root);
    // shaders compile off the critical path (KHR_parallel_shader_compile) while the new station stays hidden; the
    // programs are shared by every station (one key per material kind), so after the first station this resolves at
    // once and no station ever compiles on the frame it appears (lead, M3 hitch budget)
    // (per root: a station dropped and rebuilt meanwhile has a new root; a dropped root is disposed only once its
    // compile has finished, or three's readiness poll reads a disposed material)
    const root = res.root; root.userData.warm = false;
    const live = () => st.res === res;                     // (dropped meanwhile: stop)
    // Under: a station without cells (aerial, at grade) is outdoor world: hidden with it while the camera is underground
    // and no opening to the outdoors is in view; underground levels are cell groups (their visibility is Under's)
    if (typeof Under !== 'undefined' && Under.enabled && !(res.cells && res.cells.length)) Under.outdoor(res.root, true);
    st.walk = res.walk || null;
    for (const b of res.boards || []) st.boards.set(b.key, b);
    st.root.updateMatrixWorld(true);
    yield; if (!live()) return; st._phase = 'att:cells';
    // (a few cells per step: each is a footprint mesh in Under's map)
    let nc = 0;
    for (const c of res.cells || []) { if (typeof Under !== 'undefined' && Under.addCell) try { Under.addCell(c.under); } catch (e) { console.warn('Under.addCell', e); }
      if (++nc % 4 === 0) { yield; if (!live()) return; } }
    yield; if (!live()) return; st._phase = 'att:portals';
    for (const p of res.portals || []) if (typeof Under !== 'undefined' && Under.addPortal) try { Under.addPortal(p); } catch (e) { console.warn('Under.addPortal', e); }
    for (const c of res.cuts || []) if (typeof Under !== 'undefined' && Under.addCut) try { Under.addCut(c); } catch (e) { console.warn('Under.addCut', e); }
    yield; if (!live()) return; st._phase = 'att:ground';
    attachGround(st, res);
    yield; if (!live()) return; st._phase = 'att:compile';
    // (one material per step: compile() prepares every material of what it is given synchronously, and a program
    // three has not seen yet costs its shader source and the driver calls: the first station of a session pays that)
    const parts = [], seen = new Set();
    root.traverse(o => { const m = o.material; if (!m || Array.isArray(m) || seen.has(m)) return; seen.add(m); parts.push(o); });
    let left = parts.length;
    const fin = () => { root.userData.warm = true; stats.warmed = (stats.warmed || 0) + 1; const f = root.userData.dropLater; if (f) { root.userData.dropLater = null; f(); } };
    if (!left) { fin(); return; }
    for (const c of parts) { warmUp(c, () => { if (--left === 0) fin(); }); yield; }
  }
  function attachGround(st, res) {
    if (res.footprint && res.footprint.pads) { const old = pads.filter(p => p.st === st.id); const nw = res.footprint.pads;
      if (old.length !== nw.length || nw.some((p, i) => Math.abs(p.y - old[i].y) > 0.05)) setPads(st, nw); }
    if (res.footprint && setFootprint(st, res.footprint)) {
      try { const cp = Env.camera.position; if (typeof World !== 'undefined' && World.traffic && Math.hypot(cp.x - st.x, cp.z - st.z) < 900) World.traffic.cx = 1e9; } catch (e) {}
    }
  }
  function drop(st) {
    if (!st.root) return;
    group.remove(st.root);
    const root = st.root, dispose = () => root.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { for (const m of Array.isArray(o.material) ? o.material : [o.material]) { if (m.userData && m.userData.shared) continue; if (m.map && !(m.map.userData && m.map.userData.shared)) m.map.dispose(); m.dispose(); } } });
    if (root.userData.warm === false) root.userData.dropLater = dispose; else dispose();
    if (typeof Under !== 'undefined' && Under.enabled && st.res) { for (const c of st.res.cells || []) try { Under.remove(c.under.id); } catch (e) {} for (const c of st.res.cuts || []) try { Under.remove(c.id); } catch (e) {}
      for (const p of st.res.portals || []) if (p.id) try { Under.remove(p.id); } catch (e) {} try { Under.outdoor(st.root, false); } catch (e) {} }
    if (typeof MetroSigns !== 'undefined') { MetroSigns.freeBoards(st); MetroSigns.releaseAtlas(st); }
    st.root = null; st.res = null; st.walk = null; st.boards.clear(); st.state = 'idle'; stats.built--;
  }
  // build context shared with the type builders
  let CTX = null;
  function ctx() {
    if (CTX) return CTX;
    CTX = { PLAT_H, EDGE, DU, spineAt, trackV, N, lines: N.lines(), renderer: Env.renderer, stationsList: list, q: Q };
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
      // (Flora's load path asks keepOut itself; its drop filter is what Flora.adjust re-applies to loaded tiles)
      if (typeof Flora !== 'undefined' && Flora.addDrop) Flora.addDrop((x, z) => keepOut(x, z, 'tree'));
      try { cutTownsGround(); } catch (e) { console.warn('metrostations: towns ground cut', e); }
      // the terrain filter for the ground pads (tiles under a pad re-grade as each station's footprint arrives); every
      // station's footprint is then made in the background, nearest first, one plan or footprint per frame (update)
      if (typeof Terrain !== 'undefined' && Terrain.addHeightFilter) { Terrain.addHeightFilter(padFilter, [1e9, 1e9, 1e9, 1e9]); padsLive = true; }
      footPending = true;
      // the underground stations' environment map (a small PMREM, ~20 ms once) while the page is idle, not mid-build
      // (and the geometry builder's hot paths, so the first station's big buckets are not built by cold code)
      const warm = () => { try { if (typeof StationKit !== 'undefined' && Env.renderer) StationKit.interiorEnv(Env.renderer); } catch (e) {}
        try { const g = new StationKit.GB(), fr = []; for (let i = 0; i < 600; i++) fr.push({ x: i, z: 0, tx: 1, tz: 0, u: i });
          for (let k = 0; k < 4; k++) g.sweep(fr, (i) => [[0, 0], [1, 0.2], [2, 0.1], [3, 0.4], [4, 0], [5, 0.3], [6, 0.1], [7, 0]]); const geo = g.build(); if (geo) geo.dispose(); } catch (e) {}
        try { if (typeof MetroSigns !== 'undefined' && MetroSigns.warm) MetroSigns.warm(); } catch (e) {} };
      if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(warm, { timeout: 8000 }); else setTimeout(warm, 3000);
      refreshWorld();
    })
      .catch(e => { console.warn('MetroStations: no network data', e); });
    return initP;
  }
  const _cam = new THREE.Vector3();
  function update(dt, camPos) {
    if (!enabled || !ready) return;
    const tU = performance.now(); try { update0(dt, camPos); } finally { const d = performance.now() - tU; if (d > stats.maxFrameMs) stats.maxFrameMs = +d.toFixed(2); if (d > 12) stats.slowFrames.push(+d.toFixed(1)); }
  }
  function update0(dt, camPos) {
    if (footPending) footStep(camPos);
    const alt = Math.max(0, camPos.y - (typeof Terrain !== 'undefined' ? Terrain.h(camPos.x, camPos.z) : 0));
    // distances, build and drop decisions (nearest first; one new build at a time keeps the frame even)
    let want = null, wd = 1e18;
    for (const st of list) {
      st.dist = Math.hypot(st.x - camPos.x, st.z - camPos.z);
      const eff = Math.hypot(st.dist, alt * 0.8);
      if (st.state === 'idle' && eff < Q.buildR && eff < wd) { want = st; wd = eff; }
      if (st.state === 'built' && eff > Q.dropR) drop(st);
    }
    if (want && stats.building === 0) startBuild(want);
    runJobs(3.0);
    // LOD and per-frame state
    const night = U.uNight.value;
    for (const st of list) {
      if (!st.root) continue;
      const eff = Math.hypot(st.dist, alt);
      st.root.visible = st.root.userData.warm !== false && eff < FAR_R;
      const r = st.res;
      if (r && r.nears) { const nv = eff < Q.nearR; for (const g of r.nears) g.visible = nv; }
      if (r && r.update) r.update(dt, camPos, night);
    }
    if (typeof MetroSigns !== 'undefined') MetroSigns.update(dt, list);
    if (typeof StationCrowds !== 'undefined') StationCrowds.update(dt, camPos, list);
    try { sharedBuildings(); } catch (e) { /* (cosmetic: never worth the metro) */ }
    try { updateFar(); } catch (e) { /* (cosmetic) */ }
  }
  // ------------------------------------------------------------------------------------------------ far silhouettes
  // Beyond the build radius an above-ground station is still a landmark (from the air the guideway reaches 11 km):
  // one instanced box set for all of them (one draw call): the canopy block over the platforms in the station's roof
  // colour and, for aerial stations, the deck slab under them. A station's boxes shrink to nothing while its real build
  // is on screen; underground stations have none. Filled in as the background pass makes each station's plan.
  let far = null; const _fm = new THREE.Matrix4(), _fq = new THREE.Quaternion(), _fs = new THREE.Vector3(), _fp = new THREE.Vector3(), _fy = new THREE.Vector3(0, 1, 0);
  function updateFar() {
    if (!far) {
      const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
      const mesh = new THREE.InstancedMesh(geo, mat, list.length * 2); mesh.name = 'metrostations-far'; mesh.count = 0; mesh.frustumCulled = false;
      mesh.castShadow = false; mesh.receiveShadow = true; group.add(mesh); far = { mesh, items: [], done: new Set() };
      // (outdoor world for Under: never drawn while the camera is underground; its shader compiled in the background)
      if (typeof Under !== 'undefined' && Under.enabled && Under.outdoor) try { Under.outdoor(mesh, true); } catch (e) {}
      warmUp(mesh, () => {});
    }
    const F = far, mesh = F.mesh;
    // new stations with a plan (one per frame)
    for (const st of list) {
      if (F.done.has(st.id) || !st.plan) continue; F.done.add(st.id);
      if (st.parent || st.type === 'subway' || !st.plan.plats.length) break;
      const pl = st.plan, p0 = pl.plats[0], yT = p0.yRail + (p0.ph || PLAT_H);
      const u0 = Math.min(...pl.plats.map(p => p.u0)), u1 = Math.max(...pl.plats.map(p => p.u1)), um = (u0 + u1) / 2;
      const vs = pl.tracks.map(t => trackV(pl, t, um)); const v0 = Math.min(...vs) - 7.5, v1 = Math.max(...vs) + 7.5;
      const H = typeof StationHeroes !== 'undefined' ? StationHeroes.config(st.id) : {}, C = H.canopy || {};
      const S = spineAt(pl, um + (C.off || 0), {}), vm = (v0 + v1) / 2, yaw = Math.atan2(-S.tz, S.tx);
      const add = (len, w, y, h, col) => { if (mesh.count >= list.length * 2) return; const i = mesh.count++;
        _fp.set(S.x + S.rx * vm, y, S.z + S.rz * vm); _fq.setFromAxisAngle(_fy, yaw); _fs.set(len, h, w); _fm.compose(_fp, _fq, _fs);
        mesh.setMatrixAt(i, _fm); mesh.setColorAt(i, new THREE.Color(col).convertSRGBToLinear()); F.items.push({ st, i, m: _fm.clone() }); };
      add(Math.min(u1 - u0, C.len || u1 - u0), v1 - v0 - 3, yT + 3.2, 0.7, C.top ?? 0x9a9690);
      if (st.type === 'aerial') add(u1 - u0 + 14, v1 - v0 - 1, yT - 2.1, 2.0, 0xb3aea5);
      mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      break;
    }
    // hidden while the real station is on screen
    let dirty = false;
    for (const it of F.items) { const show = !(it.st.root && it.st.root.userData.warm !== false) && it.st.dist < FAR_R;
      if (show === it.shown) continue; it.shown = show; mesh.setMatrixAt(it.i, show ? it.m : _fm.makeScale(0, 0, 0)); dirty = true; }
    if (dirty) mesh.instanceMatrix.needsUpdate = true;
  }
  // Millbrae is one intermodal building: the Caltrain-era depot's hall (Landmarks, 'depot:millbrae:hall', split off
  // only with the metro on) stands where BART's platform 3 and tracks are, so it is hidden while the BART station (which
  // draws the shared hall) is on screen, shown again when that station is dropped, and on a metro failure (teardown)
  let depotHall = null, depotLook = 0, depotTries = 0;
  function sharedBuildings() {
    if (!depotHall) {
      // (looked for only while BART Millbrae is built, every 2 s, and given up after 30 tries: no Peninsula depot)
      const mb = byId.MLBR; if (!mb || !mb.root) { depotTries = 0; return; } if (depotTries > 30) return;
      if (--depotLook > 0) return; depotLook = 120; depotTries++; if (typeof Env === 'undefined') return;
      Env.scene.traverse(o => { if (!depotHall && o.name === 'depot:millbrae:hall') depotHall = o; });
      if (!depotHall) return;
      if (typeof Metro !== 'undefined' && Metro.onTeardown) Metro.onTeardown(() => { if (depotHall) depotHall.visible = true; }); }
    const st = byId.MLBR, show = !(st && st.root && st.root.userData.warm !== false && st.root.parent);
    if (depotHall.visible !== show) depotHall.visible = show;
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
    const st = holder(byId[id], key); if (!st) return null; if (!st.plan) st.plan = makePlan(st.data); const pl = st.plan; if (!pl) return null;
    if (!kdone.has(st.id)) footprintOf(st);          // (the builders' setup corrects the platform sides the data guessed)
    // key: a platform code ('1') or a GTFS platform id ('M20-1')
    const k = String(key == null ? '' : key); const code = k.includes('-') ? k.split('-').pop() : k;
    const p = pl.plats.find(q => q.gtfs === k || q.key === code) || pl.plats[0]; const u = (p.u0 + p.u1) / 2 + 12;
    const S = spineAt(pl, u, {}); const v = trackV(pl, p.t, u) + p.sideV * ((p.edge || EDGE) + 2.2);
    return { x: S.x + S.rx * v, y: p.yRail + (p.ph || PLAT_H), z: S.z + S.rz * v, yaw: Math.atan2(-S.rx * p.sideV, -S.rz * p.sideV) };
  }
  function limits(id) {
    const st0 = byId[id]; if (!st0) return [];
    if (st0.oacSub && !String(id).includes('~')) return [...limits(id + '~OAC'), ...limits0(st0)];
    return limits0(st0);
  }
  function limits0(st) {
    if (!st.plan) st.plan = makePlan(st.data); const pl = st.plan; if (!pl) return [];
    const L = st.res && st.res.limits ? st.res.limits : [pl.u0 + 28, pl.u1 - 28];
    return pl.tracks.map(t => { const i0 = Math.round((L[0] - pl.u0) / DU), i1 = Math.round((L[1] - pl.u0) / DU); const a = t.s[U.clamp(i0, 0, t.s.length - 1)], b = t.s[U.clamp(i1, 0, t.s.length - 1)]; return { track: t.id, s0: Math.min(a, b), s1: Math.max(a, b) }; });
  }
  function setBoard(id, key, rows) { const st = holder(byId[id], key); if (!st) return; if (typeof MetroSigns !== 'undefined') MetroSigns.setBoard(st, String(key), rows); }

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
  const KIND = { deck: 0, track: 1, lobby: 2, plaza: 3, column: 4, bridge: 5, entrance: 6, landing: 7 };
  const PAD = {
    //          deck track lobby plaza column bridge entrance landing
    building: [1.5, 2.0, 2.0, 1.0, 0.8, 1.0, -1, 2.0],
    house:    [4.0, 7.0, 8.0, 6.0, 4.0, 4.0, 5.0, 6.0],
    tree:     [2.5, 3.0, 3.0, 1.5, 2.0, 2.0, 1.2, 2.0],
    lamp:     [1.0, 2.0, 2.0, 0.5, 1.5, 1.0, 0.8, 1.0],
    grass:    [-1, 0.3, 0.3, 0.0, 0.3, -1, 0.3, 0.3],
    car:      [-1, 2.0, 2.5, 1.0, 1.2, -1, 1.2, 1.5],
    road:     [-1, 0.5, 0.5, -1, 0.8, -1, 0.3, 0.5],
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
    addZones(st, zs); setPads(st, zs.pads || []);
    const dF = performance.now() - t0; stats.koStations++; stats.koZones = kzones.length; stats.koMs += dF; if (dF > stats.maxFootMs) stats.maxFootMs = +dF.toFixed(2);
  }
  // ------------------------------------------------------------------------------------------------ ground pads
  // Where a station meets the ground (the lobby under an aerial deck and its apron) the terrain is graded to its floor:
  // a Terrain height filter (fine levels, >= 7) flattens each pad and blends back to the natural ground over `blend` m.
  // A trench station's pads only carve (never raise) and only the detail levels (>= 8: the base the towns stand on
  // keeps its streets over the trench). The footprints of every station are made when the network loads, so the pads
  // exist before those tiles stream; tiles already loaded are re-graded in place (Terrain.addHeightFilter with a
  // one-shot filter for that pad: WORLD's in-place refilter; an older Terrain re-streams them through padFilter).
  const pads = [];
  function setPads(st, list) {
    for (let i = pads.length - 1; i >= 0; i--) if (pads[i].st === st.id) pads.splice(i, 1);
    for (const p of list) { const P = p.pts; let x0 = 1e18, z0 = 1e18, x1 = -1e18, z1 = -1e18; for (const [x, z] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      let area = 0; for (let i = 0; i < 4; i++) { const a = P[i], b = P[(i + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; }
      const Q = new Float64Array(8); (area < 0 ? P.slice().reverse() : P).forEach(([x, z], i) => { Q[i * 2] = x; Q[i * 2 + 1] = z; });
      const b = p.blend || 10, pad = { st: st.id, P: Q, y: p.y, blend: b, carve: !!p.carve, minL: p.minL || 7, bb: [x0 - b, z0 - b, x1 + b, z1 + b] };
      pads.push(pad); regrade(pad);
    }
  }
  function regrade(pad) {
    if (!padsLive || typeof Terrain === 'undefined' || !Terrain.addHeightFilter) return;
    const one = (L, x0, z0, T, h) => one.live ? applyPads([pad], L, x0, z0, T, h) : false; one.live = true;
    let P = null; try { P = Terrain.addHeightFilter(one, pad.bb); } catch (e) {}
    if (P && P.then) P.then(() => { one.live = false; }, () => { one.live = false; }); else one.live = false;
  }
  let padsLive = false, footPending = false;
  // one step of the background footprint pass: the nearest station without a footprint gets its plan, next frame its
  // footprint (each <= ~10 ms, so no frame stalls)
  function footStep(camPos) {
    let best = null, bd = 1e18;
    for (const st of list) { if (kdone.has(st.id)) continue; const d = (st.x - camPos.x) ** 2 + (st.z - camPos.z) ** 2; if (d < bd) { bd = d; best = st; } }
    // every station near the camera has its footprint: is anything the world placed before them standing in one?
    if (worldCheck && (!best || bd > CHECK_R * CHECK_R)) { if (worldStep(camPos)) return; }
    if (!best) { footPending = worldCheck; return; }
    if (!best.plan) { best.plan = makePlan(best.data); if (!best.plan) kdone.add(best.id); return; }
    footprintOf(best);
  }
  function padFilter(L, x0, z0, T, h) { return applyPads(pads, L, x0, z0, T, h); }
  function applyPads(list, L, x0, z0, T, h) {
    if (L < 7 || !list.length) return false;
    const hit = list.filter(p => L >= p.minL && !(p.bb[0] > x0 + T || p.bb[2] < x0 || p.bb[1] > z0 + T || p.bb[3] < z0)); if (!hit.length) return false;
    const step = T / 128; let changed = false;
    for (const p of hit) {
      const i0 = Math.max(0, Math.floor((p.bb[0] - x0) / step)), i1 = Math.min(128, Math.ceil((p.bb[2] - x0) / step));
      const j0 = Math.max(0, Math.floor((p.bb[1] - z0) / step)), j1 = Math.min(128, Math.ceil((p.bb[3] - z0) / step));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = x0 + i * step, z = z0 + j * step, q = j * 129 + i;
        let inside = true, d2 = 1e18;
        for (let k = 0; k < 4; k++) { const ax = p.P[k * 2], az = p.P[k * 2 + 1], bx = p.P[((k + 1) & 3) * 2], bz = p.P[((k + 1) & 3) * 2 + 1]; const ex = bx - ax, ez = bz - az;
          if (ex * (z - az) - ez * (x - ax) < 0) inside = false; const l2 = ex * ex + ez * ez || 1, t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)); const dx = ax + ex * t - x, dz = az + ez * t - z; d2 = Math.min(d2, dx * dx + dz * dz); }
        const d = inside ? 0 : Math.sqrt(d2); if (d >= p.blend) continue;
        const t = d / p.blend, w = 1 - t * t * (3 - 2 * t);
        const y = h[q] + (p.y - h[q]) * w; if (p.carve && y >= h[q]) continue;
        if (Math.abs(y - h[q]) > 1e-3) { h[q] = y; changed = true; }
      }
    }
    return changed;
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
      indexZone({ st: st.id, k: KIND[z.kind], kind: z.kind, P, bb: [x0, z0, x1, z1], under: z.under !== undefined ? z.under : -1e9, soft: !!z.soft });
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
  const KIND_HARD = [false, true, true, false, true, false, false, true];
  const dropped = [];
  function dropBuilding(b, cx, cz) { const r = dropBuilding0(b, cx, cz); if (r) { stats.dropped = (stats.dropped || 0) + 1; if (dropped.length < 400) dropped.push([+cx.toFixed(1), +cz.toFixed(1), b.kind, b.h]); } return r; }
  function dropBuilding0(b, cx, cz) {
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
      if (KIND_HARD[Z.k] && !Z.soft) {
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
  // Towns' ground (streets, sidewalks, plazas, lawns) honours Under's cuts the way the terrain does, so a street entrance
  // on a sidewalk is not paved over. (Chained onto Towns' material under #metro=1 with Under; WORLD/INFRA: please adopt
  // it in Towns or Under and this goes.)
  function cutTownsGround() {
    if (typeof Towns === 'undefined' || !Towns.materials || !Towns.materials.roadMat || typeof Under === 'undefined' || !Under.enabled) return;
    const m = Towns.materials.roadMat; if (m.userData.blCut) return; m.userData.blCut = true;
    const prev = m.onBeforeCompile, key = m.customProgramCacheKey ? m.customProgramCacheKey.bind(m) : null;
    // (the terrain's own test when Under shares it: the fine cut level near the camera, so the streets open exactly
    // where the ground does; the coarse under map's footprints are dilated and left a ragged band of bare ground
    // between an entrance's collar and the sidewalk)
    const fine = typeof Terrain !== 'undefined' && Terrain.cutUniforms;
    if (fine) m.defines = Object.assign({}, m.defines || {}, { BL_CUT: 1 });
    m.onBeforeCompile = function (sh, r) { if (prev) prev.call(this, sh, r);
      if (fine) Object.assign(sh.uniforms, Terrain.cutUniforms);
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', '#include <lights_fragment_begin>\n' + (fine ? 'if ( blUnderCut( blUW ) ) discard;' : 'if ( blU.w > 0.5 ) discard;')); };
    m.customProgramCacheKey = () => (key ? key() : '') + (fine ? '|blcut2' : '|blcut');
    m.needsUpdate = true;
  }
  // once the stations are known: world pieces placed before (towns, trees, parked cars) are placed again with the
  // footprints. MetroGround (world) re-places Towns and Flora itself when it installs after us.
  // Once every station near the camera has its footprint (worldStep, one station per frame), what the world placed
  // before stands re-placed around them: with WORLD's Towns.refresh(rects) the loaded Towns tiles there re-read and
  // rebuild in the background (the old meshes stay until the swap: nothing goes black), and Flora.adjust(rects, null)
  // re-applies the tree drops in place; both for every station with a footprint near the camera. Without them (older
  // Towns / Flora) only a station where an OSM building or a tree actually stands in a footprint costs one full re-place
  // (dispose). Traffic re-streams (cheap).
  const CHECK_R = 2500;
  let worldCheck = false, checkQ = null; const refresh = { towns: [], flora: [], ran: false, ms: 0 };
  function refreshWorld() {
    // (with the old dispose-only Towns, MetroGround's install re-places everything anyway; with Towns.refresh it only
    // refreshes its own carve, so the stations always re-place their own rects)
    const groundLater = typeof MetroGround !== 'undefined' && !MetroGround.installed && !(typeof Towns !== 'undefined' && Towns.refresh);
    if (!groundLater) { worldCheck = true; footPending = true; checkQ = null; }
    try { if (typeof World !== 'undefined' && World.traffic && World.traffic.lanes && World.traffic.lanes.length) World.traffic.cx = 1e9; } catch (e) {}
  }
  function worldStep(camPos) {
    const t0 = performance.now();
    if (!checkQ) { checkQ = list.filter(st => kdone.has(st.id) && Math.hypot(st.x - camPos.x, st.z - camPos.z) < CHECK_R); refresh.towns.length = refresh.flora.length = 0; return true; }
    const st = checkQ.pop();
    if (st) {
      let x0 = 1e18, z0 = 1e18, x1 = -1e18, z1 = -1e18;
      for (const Z of kzones) if (Z.st === st.id) { x0 = Math.min(x0, Z.bb[0]); z0 = Math.min(z0, Z.bb[1]); x1 = Math.max(x1, Z.bb[2]); z1 = Math.max(z1, Z.bb[3]); }
      if (x1 > x0) {
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = Math.max(x1 - x0, z1 - z0) / 2 + PADMAX, rect = [x0 - PADMAX, z0 - PADMAX, x1 + PADMAX, z1 + PADMAX];
        const hasT = typeof Towns !== 'undefined', hasF = typeof Flora !== 'undefined';
        try { if (hasT && (Towns.refresh || (Towns.buildingsAt && Towns.buildingsAt(cx, cz, r).some(b => dropBuilding0(b, b.x, b.z))))) refresh.towns.push(rect); } catch (e) {}
        try { if (hasF && (Flora.adjust || (Flora.treesNear && Flora.treesNear(cx, cz, r * 1.42).some(t => keepOut(t.x, t.z, 'tree'))))) refresh.flora.push(rect); } catch (e) {}
      }
      refresh.ms += performance.now() - t0;
      return true;
    }
    worldCheck = false; checkQ = null; refresh.ran = true;
    try { if (refresh.towns.length && typeof Towns !== 'undefined') { if (Towns.refresh) Towns.refresh(refresh.towns.slice()); else if (Towns.dispose) Towns.dispose(); } } catch (e) {}
    try { if (refresh.flora.length && typeof Flora !== 'undefined') { if (Flora.adjust) Flora.adjust(refresh.flora.slice(), null); else if (Flora.dispose) Flora.dispose(); } } catch (e) {}
    return false;
  }

  // ------------------------------------------------------------------------------------------------ QA camera
  // MetroStations.shot(id, { u, v, h, yaw, pitch, fov }): capture-mode camera at station coordinates (u along the
  // platforms from their middle, v to the right, h above the platform top; yaw 0 looks along +u, + turns right),
  // waits for the station to build and the exposure to settle. Resolves with { state, tris, calls }.
  async function shot(id, o = {}) {
    const B = window.__bayline, st = byId[id]; if (!B || !st) return { error: 'no station ' + id };
    if (!st.plan) st.plan = makePlan(st.data); const pl = st.plan; if (!pl) return { error: 'no plan' };
    const yT = pl.plats[0] ? pl.plats[0].yRail + (pl.plats[0].ph || PLAT_H) : pl.yRail + PLAT_H;
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
    const aim = (u, vOver, yTop) => {
      const vv = vOver !== undefined ? vOver : (o.v || 0);
      const S = spineAt(pl, u, {}); const px = S.x + S.rx * vv, pz = S.z + S.rz * vv;
      const py = o.y !== undefined ? o.y : o.gh !== undefined ? Terrain.h(px, pz) + o.gh : (yTop ?? yT) + (o.h ?? 1.65);
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
    // o.conc: at the concourse floor + o.h (the mezzanine above a subway, the lobby below a deck, a footbridge)
    if (o.conc && st.res && st.res.info && isFinite(st.res.info.yCF)) aim(o.u || 0, o.v || 0, st.res.info.yCF);
    // o.onPlat: k -> on platform k's middle line at o.u (station-local v from the built platform)
    const PK = o.onPlat !== undefined && st.res && st.res.crowd ? st.res.crowd.plats[Math.min(o.onPlat, st.res.crowd.plats.length - 1)] : null;
    if (PK) { const u = U.clamp(o.u || 0, PK.u0 + 2, PK.u1 - 2); aim(u, (PK.eL(u) + PK.eR(u)) / 2 + (o.dv || 0), PK.y); }
    // o.ent: k -> at street level o.back m in front of street entrance k (subway), looking at it
    const EK = o.ent !== undefined && st.res && st.res.entrances ? st.res.entrances[Math.min(o.ent, st.res.entrances.length - 1)] : null;
    if (EK) { const bk = o.back ?? 10, a = (o.yaw || 0.6); const px = EK.wx + Math.cos(a) * bk, pz = EK.wz + Math.sin(a) * bk, py = Terrain.h(px, pz) + (o.gh ?? 1.7);
      B.capture.cam = (t, c) => { c.position.set(px, py, pz); c.up.set(0, 1, 0); c.lookAt(EK.wx, o.lookDown ? Terrain.h(EK.wx, EK.wz) : py - 1.2, EK.wz); if (o.fov) { c.fov = o.fov; c.updateProjectionMatrix(); } c.near = 0.05; c.updateProjectionMatrix(); }; }
    // o.landing: k -> look back at footbridge landing k from o.back m beyond its foot, o.gh above the street
    const Lk = o.landing !== undefined && st.res && st.res.info && st.res.info.landings ? st.res.info.landings[o.landing] : null;
    if (Lk) { const bk = o.back ?? 14, sd = o.side ?? 0; const [dx, dz] = Lk.dir; const px = Lk.foot[0] + dx * bk + dz * sd, pz = Lk.foot[1] + dz * bk - dx * sd, py = Terrain.h(px, pz) + (o.gh ?? 1.7);
      const tx = Lk.top[0], tz = Lk.top[1], ty = Lk.gy + (o.lookUp ?? 4);
      B.capture.cam = (t, c) => { c.position.set(px, py, pz); c.up.set(0, 1, 0); c.lookAt(tx, ty, tz); if (o.fov) { c.fov = o.fov; c.updateProjectionMatrix(); } c.near = 0.05; c.updateProjectionMatrix(); }; }
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

  const api = { init, update, setBoard, floorAt, blocked, spawnPoint, limits, list, byId, group, stats, setQuality, quality: Q, warmUp, get enabled() { return enabled; }, get ready() { return ready; },
    keepOut, keepOutAny, dropBuilding, keepOutZones, KEEPOUT_PAD: PAD, get droppedBuildings() { return dropped; }, get worldRefresh() { return refresh; },
    makePlan, spineAt, trackV, net: N, PLAT_H, EDGE, VEH, jobs, shot, debug };
  // hooks: ride along with the Peninsula stations' init/update (no edits to the shared main loop; inert without #metro=1)
  if (enabled && typeof Stations !== 'undefined') {
    const si = Stations.init, su = Stations.update;
    Stations.init = function (...a) { const r = si.apply(this, a); try { api.init(); } catch (e) { console.error('metrostations init', e); } return r; };
    Stations.update = function (dt, cp, tr) { su.call(this, dt, cp, tr); try { api.update(dt, cp); } catch (e) { if (!api._err) console.error('metrostations', e); api._err = (api._err || 0) + 1; } };
  }
  if (typeof window !== 'undefined') Object.assign(window.__baylineMods = window.__baylineMods || {}, { MetroStations: api });
  // (QA handles to the kit, read lazily: those modules load after this one)
  api.qa = { get kit() { return StationKit; }, get parts() { return StationParts; }, get types() { return StationTypes; }, get metronet() { return MetroNet; }, get ctx() { return ctx(); } };
  return api;
})();
