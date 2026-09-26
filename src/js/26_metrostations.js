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
    ready.catch(() => {}).then(() => {
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

  // ------------------------------------------------------------------------------------------------ QA camera
  // MetroStations.shot(id, { u, v, h, yaw, pitch, fov }): capture-mode camera at station coordinates (u along the
  // platforms from their middle, v to the right, h above the platform top; yaw 0 looks along +u, + turns right),
  // waits for the station to build and the exposure to settle. Resolves with { state, tris, calls }.
  async function shot(id, o = {}) {
    const B = window.__bayline, st = byId[id]; if (!B || !st) return { error: 'no station ' + id };
    if (!st.plan) st.plan = makePlan(st.data); const pl = st.plan; if (!pl) return { error: 'no plan' };
    const S = spineAt(pl, o.u || 0, {}); const yT = (pl.plats[0] ? pl.plats[0].yRail : pl.yRail) + PLAT_H;
    const px = S.x + S.rx * (o.v || 0), pz = S.z + S.rz * (o.v || 0), py = o.y !== undefined ? o.y : yT + (o.h ?? 1.65);
    // cutaway: a clipping plane removes everything above y = o.cut (terrain, buildings, roofs) so a station can be seen whole
    // cutaway: a clipping plane removes everything above y = yT + o.cut, and (solo) every other object in the scene is
    // hidden, so a whole station can be looked at from outside. Each call resets what the previous one changed.
    for (const c of qa.hidden) c.visible = true; qa.hidden.length = 0;
    Env.renderer.clippingPlanes = o.cut !== undefined ? [new THREE.Plane(new THREE.Vector3(0, -1, 0), yT + o.cut)] : [];
    debug.showAll = !!(o.solo || o.cut !== undefined);
    const keep = (c) => c === group || c.isLight || c === Env.camera || c === Env.sky || (c.isObject3D && c.type === 'Object3D' && c.children.length === 0);
    B.capture.before = (o.solo || o.cut !== undefined) ? () => { for (const c of Env.scene.children) if (!keep(c) && c.visible) { c.visible = false; qa.hidden.push(c); } } : null;
    if (B.Post && B.Post.debug) B.Post.debug.shafts = !(st.type === 'subway' && (o.h ?? 1.65) < 30 && o.y === undefined);
    const yaw = Math.atan2(S.tz, S.tx) + (o.yaw || 0), pitch = o.pitch || 0;
    const tx = px + Math.cos(yaw) * Math.cos(pitch) * 10, tz = pz + Math.sin(yaw) * Math.cos(pitch) * 10, ty = py + Math.sin(pitch) * 10;
    const cam = Env.camera; if (o.fov) { cam.fov = o.fov; cam.updateProjectionMatrix(); }
    document.body.classList.add('photo');
    B.capture.on = true; B.capture.cam = (t, c) => { c.position.set(px, py, pz); c.up.set(0, 1, 0); c.lookAt(tx, ty, tz); if (o.fov) { c.fov = o.fov; c.updateProjectionMatrix(); } c.near = 0.05; c.updateProjectionMatrix(); };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 900 && st.state !== 'built' && st.state !== 'failed' && st.state !== 'nodata'; i++) { B.stepFrame(1); await sleep(20); }
    if (st.state !== 'built') return { state: st.state, error: st.error || null };
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
