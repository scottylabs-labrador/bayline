// Bayline Metro helpers for trailer / promo shots (page-side sources, in the style of _lib.mjs).
//
// The metro runtime (MetroSim, src/js/46_metrosim.js) is a pure function of the clock: every train is its timetable
// plan evaluated at Env.time.sec. So a shot finds its train by timetable (never by luck), sets the clock, and poses its
// camera from the train. Two ways to use these:
//   - in setup: `${metro}` installs window.__m once; then __m.pass(...), __m.pose(...) anywhere (before / cam hooks too)
//   - or the self-installing one-liners, like _lib's passClock: (${mPass})('WOAK', { heading: 90 }, 6.5 * 3600, 4)
//
// Places ("where"): a station id ('WOAK': its platforms' middle), { lat, lon }, { x, z } (world), or { track, s }.
// Filters ("f", all optional): { line: 'red' | ['red', 'yellow'], dest: 'Antioch' (the train's destination, a
//   substring), kind: 'bart' | 'dmu' | 'apm', heading: 90 (compass degrees of travel at the place; tol: 60),
//   minV: m/s at the place, stopping: true | false (it stops at that station), maxD: 45 (m from the place to the path),
//   not: key | [keys] (skip), date-independent }
// Clock: all times are seconds of the service day (06:30 = 6.5 * 3600). The timetable depends on the date (weekday or
// weekend) and the sun on the date: pin the date for the whole game with __m.day('2026-09-29') (or await (${mDay})('2026-09-29'))
// first, so the 4K capture finds the same trains (metro and Peninsula) as the preview, whatever day it runs.
//
// Metro train objects (MetroSim.running, __m.train(key)): { key, line, kind, cars, x, y, z (head), hx, hz (heading),
// s (head on its path), v, a, phase ('origin' | 'run' | 'dwell' | 'terminal'), stationId, doorsOpen, underground,
// leg: { path, stops }, entry: { consist: { cars: [{ group, cabEye, doors, ... }] } } (only when posed) }.

export const metro = `window.__m = window.__m || (() => {
  const B = window.__bayline, S = () => B.MetroSim, N = () => B.MetroSim.net;
  const D2R = Math.PI / 180, O = {}, F = {}, F2 = {};
  // ---------------- places
  function at(w) {
    if (typeof w === 'string') { const st = N().stationById[w]; if (!st) throw new Error('no metro station ' + w);
      const P = st.platforms || []; if (P.length) { let x = 0, z = 0, n = 0; for (const p of P) { const t = N().byId[p.track]; if (!t) continue; N().frame(t, ((p.s0 ?? p.s) + (p.s1 ?? p.s)) / 2, F); x += F.x; z += F.z; n++; } if (n) return { x: x / n, z: z / n, station: w }; }
      return { x: st.x, z: st.z, station: w }; }
    if (w && w.lat !== undefined) { const p = B.Globe.ll2w(w.lat, w.lon); return { x: p.x, z: p.z }; }
    if (w && w.track !== undefined) { N().frame(typeof w.track === 'string' ? N().byId[w.track] : w.track, w.s, F); return { x: F.x, z: F.z }; }
    return { x: w.x, z: w.z };
  }
  // the track nearest a place: { x, y (rail top), z, tx, ty, tz (unit, along +s), rx, rz (unit, right of +s), st (structure), track, s, dist }
  function track(w, r = 150, f) { const P = at(w), h = N().nearest(P.x, P.z, r, f); if (!h) return null; N().frame(h.track, h.s, F);
    return { x: F.x, y: F.y, z: F.z, tx: F.tx, ty: F.ty, tz: F.tz, rx: F.rx, rz: F.rz, st: F.structName, track: h.track.id, s: h.s, dist: h.dist }; }
  // ---------------- the timetable
  const head = (l) => { let x = l; while (x.next) x = x.next; return x; };
  function destOf(l) { try { return S().legDest(head(l)).dest || ''; } catch (e) { const L = head(l).stops; return S().stName(L[L.length - 1].st); } }
  function legOk(l, f) {
    if (f.line) { const L = [].concat(f.line); if (!L.includes(l.line)) return false; }
    if (f.kind && l.kind !== f.kind) return false;
    if (f.dest && !destOf(l).toLowerCase().includes(String(f.dest).toLowerCase())) return false;
    if (f.not) { const K = [].concat(f.not), k = l.chainKey || l.plan.key; if (K.includes(k)) return false; }
    return true;
  }
  const projC = new Map();
  function proj(l, P, maxD) {          // the leg's path position nearest the place, within the leg's own stretch
    const S0 = l.stops[0].ps, S1 = l.stops[l.stops.length - 1].ps, k = l.path.id + '|' + Math.round(S0) + '|' + Math.round(S1) + '|' + Math.round(P.x) + ',' + Math.round(P.z);
    let r = projC.get(k); if (r === undefined) { r = l.path.project(P.x, P.z, Math.max(0, S0 - 60), S1 + 60); projC.set(k, r); }
    return r && r.d <= maxD ? r : null;
  }
  // every passage of a train head past a place after a clock time: [{ tPass, key, trip, line, dest, kind, v, hdg, ps, plan, leg, stops }]
  function passes(w, f = {}, after = 0, until = after + 4 * 3600) {
    const P = at(w), maxD = f.maxD || (P.station ? 70 : 45), out = [], M = S();
    for (const p of M.plans) { if (p.tEnd < after || p.tStart > until) continue;
      for (const l of p.legs) { if (l.t1 < after || l.t0 > until || !legOk(l, f)) continue;
        const pr = proj(l, P, maxD); if (!pr) continue;
        const g = (t) => M.legState(l, t, O).ps - pr.ps;
        let a = Math.max(l.t0, after), b = l.t1; if (g(a) >= 0 || g(b) < 0) continue;
        for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (g(m) < 0) a = m; else b = m; }
        const tPass = b; if (tPass > until) continue;
        M.legState(l, tPass, O); const v = O.v; l.path.at(pr.ps, F); const hdg = (Math.atan2(F.tx, -F.tz) / D2R + 360) % 360;
        if (f.heading !== undefined) { const d = Math.abs(((hdg - f.heading) % 360 + 540) % 360 - 180); if (d > (f.tol || 60)) continue; }
        if (f.minV && v < f.minV) continue;
        const stops = P.station ? l.stops.some(s => s.st === P.station) : null;
        if (f.stopping !== undefined && P.station && stops !== !!f.stopping) continue;
        out.push({ tPass, key: l.chainKey || p.key, trip: p.trip.id, line: l.line, dest: destOf(l), kind: l.kind, cars: l.cars, v: +v.toFixed(1), hdg: Math.round(hdg), ps: pr.ps, stops, plan: p, leg: l });
      } }
    return out.sort((x, y) => x.tPass - y.tPass);
  }
  const brief = (c) => c && { key: c.key, trip: c.trip, line: c.line, dest: c.dest, kind: c.kind, cars: c.cars, v: c.v, hdg: c.hdg, tPass: +c.tPass.toFixed(2) };
  function setT(t) { B.Env.setClock(t); B.Env.time.scale = 1; }
  // the first train (matching f) to reach the place after a clock time; the clock is set 'lead' s before it gets there
  function pass(w, f = {}, after = B.Env.time.sec, lead = 0, opt = {}) {
    const L = passes(w, f, after, after + (opt.within || 3 * 3600)), c = L[opt.nth || 0]; if (!c) return null;
    if (opt.set !== false) setT(c.tPass - lead); if (opt.focus) focus(c.key);
    return Object.assign(brief(c), { t: +(c.tPass - lead).toFixed(2) });
  }
  // two trains past the place within gap s of each other (fa / fb: e.g. { heading: 90 } and { heading: 270 });
  // the clock is set 'lead' s before the first of them gets there (opt.mid: before the midpoint of their two passages)
  function meet(w, fa = {}, fb = {}, after = B.Env.time.sec, lead = 0, opt = {}) {
    const until = after + (opt.within || 4 * 3600), A = passes(w, fa, after, until), Bs = passes(w, fb, after, until), gap = opt.gap ?? 4;
    let best = null;
    for (const a of A) for (const b of Bs) { if (a.key === b.key) continue; const d = Math.abs(a.tPass - b.tPass); if (d > gap) continue;
      const t0 = opt.mid ? (a.tPass + b.tPass) / 2 : Math.min(a.tPass, b.tPass); if (!best || t0 < best.t0) best = { t0, a, b }; }
    if (!best) return null; if (opt.set !== false) setT(best.t0 - lead);
    return { t: +(best.t0 - lead).toFixed(2), a: brief(best.a), b: brief(best.b), gap: +Math.abs(best.a.tPass - best.b.tPass).toFixed(2) };
  }
  // where two trains pass each other along a stretch of track (both directions, any lines): samples the track every
  // step m from s0 to s1 and reports each pair of opposite passages less than gap s apart at a sample (at the line's
  // ~12-30 m/s that puts their meeting within ~step/2 of it): [{ t (their mid time), s, x, z, gap, a, b }], by time
  function crossings(track, s0, s1, after, until, opt = {}) {
    const T = typeof track === 'string' ? N().byId[track] : track, step = opt.step || 50, gap = opt.gap || 5, out = [], seen = new Set();
    for (let s = s0; s <= s1; s += step) {
      N().frame(T, s, F); const hd = (Math.atan2(F.tx, -F.tz) / D2R + 360) % 360, x = F.x, z = F.z;
      const L = passes({ x, z }, Object.assign({}, opt.f || {}), after, until), up = [], dn = [];
      for (const c of L) (Math.abs(((c.hdg - hd) % 360 + 540) % 360 - 180) < 90 ? up : dn).push(c);
      for (const a of up) for (const b of dn) { const d = Math.abs(a.tPass - b.tPass); if (d > gap) continue; const k = a.key + '|' + b.key; if (seen.has(k)) continue; seen.add(k);
        out.push({ t: +((a.tPass + b.tPass) / 2).toFixed(2), s, x, z, gap: +d.toFixed(2), a: brief(a), b: brief(b) }); }
    }
    return out.sort((p, q) => p.t - q.t);
  }
  // a train arriving at a station platform (platform: '2', a GTFS stop id 'M20-2', or null for any); the clock is set
  // 'lead' s before it stops (arr: head at its stop mark); returns { t, key, tArr, tDep, sid, line, dest, cars }
  function arrive(stId, plat, after = B.Env.time.sec, lead = 0, opt = {}, f = {}) {
    const M = S(), L = M.arrivals(stId, after, 60, { withLast: true });
    const ok = (e) => { if (e.arr < after) return false; if (plat && e.sid !== plat && (e.sid || '').split('-').pop() !== String(plat)) return false; return legOk(e.leg, f); };
    const e = L.filter(ok)[opt.nth || 0]; if (!e) return null;
    const key = e.leg.chainKey || e.plan.key; if (opt.set !== false) setT(e.arr - lead); if (opt.focus) focus(key);
    return { t: +(e.arr - lead).toFixed(2), key, trip: e.plan.trip.id, tArr: e.arr, tDep: e.dep, sid: e.sid, line: e.leg.line, dest: destOf(e.leg), cars: e.leg.cars, last: !!e.last };
  }
  // a departure from a station (the clock 'lead' s before the doors close and it leaves)
  function depart(stId, plat, after = B.Env.time.sec, lead = 0, opt = {}, f = {}) {
    const M = S(), L = M.arrivals(stId, after - 900, 80, {}).filter(e => !e.last && e.dep >= after && (!plat || e.sid === plat || (e.sid || '').split('-').pop() === String(plat)) && legOk(e.leg, f));
    const e = L[opt.nth || 0]; if (!e) return null; const key = e.leg.chainKey || e.plan.key;
    if (opt.set !== false) setT(e.dep - lead); if (opt.focus) focus(key);
    return { t: +(e.dep - lead).toFixed(2), key, trip: e.plan.trip.id, tArr: e.arr, tDep: e.dep, sid: e.sid, line: e.leg.line, dest: destOf(e.leg), cars: e.leg.cars };
  }
  // a metro train and a Peninsula train at an interchange (Millbrae) at the same time. Windows: the metro train standing
  // there (a terminating train until its turnback leaves), the Peninsula train's own dwell (its plan's stopped segment),
  // each widened by opt.margin s (e.g. 30: arriving and leaving count too). pairs() lists every overlap after a clock
  // time: [{ from, to, len, metro: { key, line, dest, sid, arr, dep }, pen: { key, trip, dir, arr, dep } }]
  function pairs(mSt, pSt, after = B.Env.time.sec, until = after + 6 * 3600, opt = {}, f = {}) {
    const M = S(), Sim = B.Sim, si = Sim.TT.stations.indexOf(pSt), mg = opt.margin || 0; if (si < 0) return [];
    const ev = M.arrivals(mSt, after - 1800, 200, { withLast: true }).filter(e => legOk(e.leg, f)), mw = [];
    for (let i = 0; i < ev.length; i++) { const e = ev[i];
      if (e.last) { const nx = ev.slice(i + 1).find(x => !x.last && x.k === 0 && x.sid === e.sid && x.dep - e.arr < 900); mw.push({ a: e.arr, b: nx ? nx.dep : e.arr + 150, e }); }
      else if (e.k === 0 && ev.slice(0, i).some(x => x.last && x.sid === e.sid && e.dep - x.arr < 900)) continue;   // (a turnback's departure: in the window above)
      else mw.push({ a: e.arr, b: e.dep, e }); }
    const pw = []; for (const p of Sim.plans) { if (p.tEnd < after - 600 || (opt.dir !== undefined && p.dir !== opt.dir)) continue;
      for (const g of p.segs) if (g.kind === 0 && g.si === si && !g.first && g.t1 > after - mg && g.t0 < until) pw.push({ a: g.t0, b: g.t1, p }); }
    const out = [];
    for (const m of mw) for (const q of pw) { const a = Math.max(m.a - mg, q.a - mg, after), b = Math.min(m.b + mg, q.b + mg, until); if (b <= a) continue;
      out.push({ from: +a.toFixed(2), to: +b.toFixed(2), len: +(b - a).toFixed(1), metro: { key: m.e.leg.chainKey || m.e.plan.key, line: m.e.leg.line, dest: destOf(m.e.leg), sid: m.e.sid, arr: m.a, dep: m.b },
        pen: { key: q.p.key, trip: q.p.trip.id, dir: q.p.dir, arr: q.a, dep: q.b } }); }
    return out.sort((x, y) => x.from - y.from);
  }
  // the first of those overlaps lasting at least minS s; the clock is set opt.into s into it. -> { t, from, to, len, metro, pen }
  function pair(mSt, pSt, after = B.Env.time.sec, minS = 20, opt = {}, f = {}) {
    const c = pairs(mSt, pSt, after, after + (opt.within || 6 * 3600), opt, f).find(x => x.len >= minS); if (!c) return null;
    const t = c.from + (opt.into || 0); if (opt.set !== false) setT(t); return Object.assign({ t: +t.toFixed(2) }, c);
  }
  // ---------------- trains
  const train = (k) => (typeof k === 'string' ? S().trainByKey(k) : k) || null;
  // keep a train fully built whatever its distance (and feed its cab screen / passenger displays): one at a time
  function focus(k) { S().setFocus(k); return k; }
  // the running metro train nearest a place (opt: within m, and the filters above: line, dest, kind, heading, minV)
  function pick(lat, lon, opt = {}) {
    const P = typeof lat === 'object' ? at(lat) : at({ lat, lon }); let best = null, bd = opt.within || 6000;
    for (const tr of S().running) { if (!legOk(tr.leg, opt)) continue; if (opt.minV && tr.v < opt.minV) continue;
      if (opt.heading !== undefined) { const h = (Math.atan2(tr.hx, -tr.hz) / D2R + 360) % 360, d = Math.abs(((h - opt.heading) % 360 + 540) % 360 - 180); if (d > (opt.tol || 60)) continue; }
      const d = Math.hypot(tr.x - P.x, tr.z - P.z); if (d < bd) { bd = d; best = tr; } }
    return best;
  }
  // a car's pose: p (the car's middle, 2 m above the rail: like __cine.trainPose), rail (the same at rail level), fwd
  // (unit, direction of travel), right, up, v, s. car: undefined = the middle car, 0 = the lead car, i = i-th from
  // the lead, -1 = the last car. From the posed consist when there is one, else from the path (always available)
  function pose(k, car) {
    const tr = train(k); if (!tr) return null; const n = tr.cars, L = S().PERF[tr.kind].carLen;
    const i = car === undefined ? Math.floor(n / 2) : car < 0 ? n + car : Math.min(n - 1, car);
    const sC = tr.s - (i + 0.5) * L; tr.leg.path.at(sC, F); const hl = Math.hypot(F.tx, F.tz) || 1;
    const fwd = { x: F.tx / hl, y: 0, z: F.tz / hl }, right = { x: -fwd.z, y: 0, z: fwd.x };
    let rail = { x: F.x, y: F.y, z: F.z };
    const cs = tr.entry && tr.entry.consist && tr.entry.consist.cars;
    if (cs && cs.length === n) { const g = cs[tr.lead === 0 ? i : n - 1 - i].group; if (g) { g.updateMatrixWorld(); rail = { x: g.position.x, y: g.position.y, z: g.position.z }; } }
    return { p: { x: rail.x, y: rail.y + 2, z: rail.z }, rail, fwd, right, up: { x: 0, y: 1, z: 0 }, pitch: Math.atan2(F.ty, hl), v: tr.v, s: sC, head: { x: tr.x, y: tr.y, z: tr.z }, tr };
  }
  // a point relative to a pose: a m ahead, b m right, h m up (like __cine.rel)
  const rel = (P, a, b, h) => ({ x: P.rail.x + P.fwd.x * a + P.right.x * b, y: P.rail.y + h, z: P.rail.z + P.fwd.z * a + P.right.z * b });
  // the path ahead of / behind a train: the point d m ahead of its head (negative: behind), at rail level + h
  function ahead(k, d, h = 0) { const tr = train(k); if (!tr) return null; tr.leg.path.at(tr.s + d, F2); return { x: F2.x, y: F2.y + h, z: F2.z, tx: F2.tx, tz: F2.tz }; }
  // the lead car's cab eye in the world (the cab ride view) and the direction it looks: { p, fwd, car } or null until posed
  function cab(k, dx = 0, dy = 0, dz = 0) {
    const tr = train(k), cs = tr && tr.entry && tr.entry.consist && tr.entry.consist.cars; if (!cs) return null;
    const car = cs[tr.lead === 0 ? 0 : cs.length - 1], e = car && car.cabEye; if (!e) return null; const rear = tr.lead !== 0;   // (dx forward, dy up, dz right, m)
    car.group.updateMatrixWorld(); const v = new THREE.Vector3(e[0] + (rear ? -0.22 - dx : 0.22 + dx), e[1] + 0.1 + dy, e[2] + (rear ? -dz : dz)).applyMatrix4(car.group.matrixWorld);
    const f = new THREE.Vector3(rear ? -1 : 1, 0, 0).transformDirection(car.group.matrixWorld);
    return { p: { x: v.x, y: v.y, z: v.z }, fwd: { x: f.x, y: f.y, z: f.z }, car };
  }
  // ---------------- location scouting: lines of sight through the loaded world
  // points along a track around s (targets for sight()): n points over +-half m, h m above the rail (a train's middle ~2.2)
  function trackPts(track, s, half = 60, n = 5, h = 2.2) { const T = typeof track === 'string' ? N().byId[track] : track, out = [];
    for (let i = 0; i < n; i++) { N().frame(T, s - half + 2 * half * i / Math.max(1, n - 1), F); out.push({ x: F.x, y: F.y + h, z: F.z }); } return out; }
  const SKIP = /^(flora-far|flora-shadow|streetlight-pools|streetlight-glow|skyline|metro-far|sky|water)/;
  let occl = null, occlT = 0;
  function occluders() {                  // the scene's solid meshes (not the terrain: sampled from its height function), cached 2 s
    if (occl && performance.now() - occlT < 2000) return occl; occl = []; occlT = performance.now();
    B.Env.scene.traverse(o => { if (o.name === 'terrain') return; if (!(o.isMesh || o.isInstancedMesh) || o.isPoints || o.isLine || o.isSprite) return;
      let v = true; for (let q = o; q; q = q.parent) { if (q.visible === false || SKIP.test(q.name || '') || q.name === 'terrain') { v = false; break; } } if (!v) return;
      if (o.isInstancedMesh && o.computeBoundingSphere) { try { o.computeBoundingSphere(); } catch (e) {} }     // (trees move between frames: a stale sphere misses them)
      occl.push(o); });
    return occl;
  }
  // the share of the targets visible from p (terrain and the loaded scene; hits within opt.near m of a target don't count)
  const _rc = { r: null };
  function sight(p, targets, opt = {}) {
    const rc = _rc.r || (_rc.r = new THREE.Raycaster()), objs = occluders(), near = opt.near ?? 8; let clear = 0; const hits = [];
    const o = new THREE.Vector3(p.x, p.y, p.z), dir = new THREE.Vector3();
    for (const q of targets) { const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z, d = Math.hypot(dx, dy, dz); let hit = null;
      for (let k = 1; k < 60 && !hit; k++) { const f = k / 60; if (d * (1 - f) < near) break; const x = p.x + dx * f, y = p.y + dy * f, z = p.z + dz * f; if (__cine.ground(x, z) > y) hit = { what: 'terrain', at: Math.round(d * f) }; }
      if (!hit) { dir.set(dx / d, dy / d, dz / d); rc.set(o, dir); rc.near = 0.3; rc.far = Math.max(1, d - near);
        const h = rc.intersectObjects(objs, false)[0]; if (h) hit = { what: h.object.name || h.object.type, at: Math.round(h.distance) }; }
      if (hit) hits.push(hit); else clear++; }
    return { clear: +(clear / targets.length).toFixed(2), hits };
  }
  // the first of the candidate camera positions (in order of preference) that sees at least opt.min of the targets;
  // else the one that sees the most. -> { p, i, clear, hits, tried }
  function scout(cands, targets, opt = {}) {
    const min = opt.min ?? 0.8; let best = null;
    for (let i = 0; i < cands.length; i++) { const r = sight(cands[i], targets, opt); if (r.clear >= min) return { p: cands[i], i, clear: r.clear, hits: r.hits, tried: i + 1 };
      if (!best || r.clear > best.clear) best = { p: cands[i], i, clear: r.clear, hits: r.hits }; }
    return Object.assign(best || {}, { tried: cands.length, short: true });
  }
  // ---------------- the service day
  // pin the date for the whole game (Env's date: the Peninsula and metro timetables' service day, weekday or weekend,
  // and the sun), keeping the clock; the metro replans now, the Peninsula on its next frame. ymd: '2026-09-29'
  // the metro loads after the page's first frame (a few seconds): wait for its network and timetable (day() does too)
  async function ready(ms = 60000) { const t0 = performance.now(); while (!(S() && S().ready && S().plans && S().plans.length)) { if (performance.now() - t0 > ms) throw new Error('the metro did not load'); await new Promise(r => setTimeout(r, 200)); } return true; }
  async function day(ymd, sec = B.Env.time.sec) {
    await ready();
    const [y, m, d] = ymd.split('-').map(Number); B.Env.setClock(sec, new Date(Date.UTC(y, m - 1, d, 19)));   // (19 UTC: noon in the Bay, that date)
    if (S() && S().replan) S().replan();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); await new Promise(r => setTimeout(r, 250));
    return B.Env.serviceDay();
  }
  return { ready, at, track, trackPts, sight, scout, passes, pass, meet, crossings, arrive, depart, pair, pairs, train, focus, pick, pose, rel, ahead, cab, day, destOf };
})();`;

// self-installing one-liners (page-side function sources), like _lib's passClock: usable without installing `metro`
const one = (name) => `(...a) => { ${metro}; return window.__m.${name}(...a); }`;
export const mPass = one('pass');        // (where, f, after, lead, opt) -> { t, key, trip, line, dest, v, hdg, tPass } | null
export const mMeet = one('meet');        // (where, fa, fb, after, lead, opt { gap, mid }) -> { t, a, b, gap } | null
export const mCross = one('crossings');  // (track, s0, s1, after, until, opt { step, gap, f }) -> [{ t, s, x, z, gap, a, b }]
export const mArrive = one('arrive');    // (stationId, platform, after, lead, opt, f) -> { t, key, tArr, tDep, sid, line, dest } | null
export const mDepart = one('depart');    // (stationId, platform, after, lead, opt, f) -> { t, key, tArr, tDep, ... } | null
export const mPair = one('pair');        // (metroStation, penStation, after, minOverlap, opt { into, dir, margin }, f) -> { t, from, to, len, metro, pen } | null
export const mPairs = one('pairs');      // (metroStation, penStation, after, until, opt { dir, margin }, f) -> [{ from, to, len, metro, pen }]
export const mPick = one('pick');        // (lat, lon, opt) -> train | null
export const mPose = one('pose');        // (train | key, car) -> { p, rail, fwd, right, up, v, s, head } | null
export const mTrack = one('track');      // (where, r) -> nearest track frame | null
export const mScout = one('scout');      // (candidate camera positions, target points, opt { min, near }) -> { p, i, clear, hits, tried }
export const mDay = one('day');          // (ymd) -> Promise<serviceDay> (waits for the metro to load first)
export const mReady = one('ready');      // () -> Promise (the metro's network and timetable loaded)
