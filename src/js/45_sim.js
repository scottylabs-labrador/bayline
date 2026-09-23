// Train simulation. Every scheduled trip of the real timetable is a pure function of the clock:
// dwell / accelerate / cruise / brake between its real stops. Nearby trains get full TrainKit consists
// (pooled), distant ones are drawn as cheap instanced car bodies + a marker dot for aerial views.
// The player can take over a scheduled trip and drive it with physics (Sim.drive).
const Sim = (() => {
  let TT = null;
  const MPH = 0.44704, VMAX = 79 * MPH;
  const PERF = { emu: { a: 0.85, b: 0.75 }, diesel: { a: 0.45, b: 0.65 } };
  const BIG = new Set(['san_francisco', 'place_MLBR', 'hillsdale', 'redwood_city', 'palo_alto', 'mountain_view', 'sunnyvale', 'sj_diridon', '22nd_street', 'san_mateo']);
  let plans = [], dayKey = '', stationDeps = [];
  const running = [];            // train objects this frame
  const F = {}, F2 = {}, P1 = {}, P2 = {};
  let maxLen = 190;

  const routeShort = (trip) => ({ 'Local Weekday': 'LOCAL', 'Local Weekend': 'LOCAL', 'Limited': 'LIMITED', 'Express': 'EXPRESS', 'South County': 'S.COUNTY' }[trip.route] || trip.route.toUpperCase());
  const routeColor = (trip) => ({ 'Express': '#e0402f', 'Limited': '#5cc6cf', 'South County': '#f0c96b' }[trip.route] || '#e9e6de');
  const kindOf = (trip) => trip.route === 'South County' ? 'diesel' : 'emu';
  const dwellFor = (si) => BIG.has(TT.stations[si]) ? 52 : 34;

  function stopS(si, dir) { return Stations.list[si].stop[dir]; }
  function doorSide(si, dir) { return Stations.list[si].door[dir]; }

  // ---------- planning ----------
  function plan(trip, dayOff) {
    const kind = kindOf(trip), P = PERF[kind], dir = trip.dir; const k = 1 / (2 * P.a) + 1 / (2 * P.b);
    const st = trip.stops, segs = [];
    let s = stopS(st[0][0], dir), t = st[0][2] + dayOff;
    segs.push({ kind: 0, t0: t - 330, t1: t, s0: s, si: st[0][0], k: 0, first: true });
    for (let i = 1; i < st.length; i++) {
      const [si, arr] = st[i]; const last = i === st.length - 1; const dw = last ? 0 : dwellFor(si);
      const sB = stopS(si, dir); const D = Math.max(1, Math.abs(sB - s));
      let T = (arr + dayOff) - dw * 0.65 - t; if (T < 25) T = 25;
      let v; const disc = T * T - 4 * k * D;
      if (disc >= 0) v = (T - Math.sqrt(disc)) / (2 * k); else { v = Math.sqrt(D / k); T = 2 * Math.sqrt(k * D); }
      if (v > VMAX) { v = VMAX; T = D / v + v * k; }
      const ta = v / P.a, tb = v / P.b;
      segs.push({ kind: 1, t0: t, t1: t + T, s0: s, s1: sB, sgn: Math.sign(sB - s) || 1, D, v, a: P.a, b: P.b, ta, tc: T - tb, from: st[i - 1][0], to: si, k: i });
      t += T; s = sB;
      if (!last) { const tDep = Math.max(st[i][2] + dayOff + dw * 0.35, t + 20); segs.push({ kind: 0, t0: t, t1: tDep, s0: s, si, k: i }); t = tDep; }
      else { segs.push({ kind: 0, t0: t, t1: t + 240, s0: s, si, k: i, final: true }); t += 240; }
    }
    return { trip, dayOff, dir, kind, segs, tStart: segs[0].t0, tEnd: t, key: trip.id + (dayOff ? '@y' : ''), id: trip.id };
  }
  function ymdShift(ymd, days) { const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + days)); return { ymd: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`, wd: d.getUTCDay() }; }
  function tripsFor(ymd, wd) {
    const sp = TT.trips.filter(t => t.svc === 'special' && t.dates && t.dates.includes(ymd));
    if (sp.length) return sp;
    const kind = (wd === 0 || wd === 6) ? 'wkend' : 'wkday';
    return TT.trips.filter(t => t.svc === kind);
  }
  function replan() {
    const sd = Env.serviceDay(); if (sd.ymd === dayKey) return; dayKey = sd.ymd;
    const today = ymdShift(sd.ymd, 0), yest = ymdShift(sd.ymd, -1);
    plans = tripsFor(today.ymd, today.wd).map(t => plan(t, 0));
    for (const t of tripsFor(yest.ymd, yest.wd)) { const p = plan(t, -86400); if (p.tEnd > 0) plans.push(p); }
    plans.sort((a, b) => a.tStart - b.tStart);
    stationDeps = TT.stations.map(() => []);
    for (const p of plans) {
      const st = p.trip.stops;
      for (let i = 0; i < st.length - 1; i++) stationDeps[st[i][0]].push({ t: st[i][2] + p.dayOff, plan: p, trip: p.trip, k: i, dir: p.dir });
    }
    for (const l of stationDeps) l.sort((a, b) => a.t - b.t);
  }
  function nextDepartures(si, dirs, now, n = 3) {
    const out = []; const l = stationDeps[si] || [];
    for (const d of l) { if (d.t < now - 20 || !dirs.includes(d.dir)) continue; out.push(d); if (out.length >= n) break; }
    return out;
  }
  // all departures from station si after time t (for the board UI)
  function departures(si, now, n = 14) { return (stationDeps[si] || []).filter(d => d.t >= now - 60).slice(0, n); }
  function planById(id) { return plans.find(p => p.id === id && p.tEnd > Env.time.sec - 60) || plans.find(p => p.id === id); }

  // state of a plan at time t
  function stateAt(p, t, out) {
    const segs = p.segs; let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].t0 <= t) lo = m; else hi = m - 1; }
    const g = segs[lo]; out.seg = g; out.segIdx = lo;
    if (g.kind === 0) { out.s = g.s0; out.v = 0; out.a = 0; }
    else {
      const T = g.t1 - g.t0, tau = U.clamp(t - g.t0, 0, T); let d, v, a;
      if (tau < g.ta) { d = 0.5 * g.a * tau * tau; v = g.a * tau; a = g.a; }
      else if (tau < g.tc) { d = 0.5 * g.a * g.ta * g.ta + g.v * (tau - g.ta); v = g.v; a = 0; }
      else { const r = T - tau; d = g.D - 0.5 * g.b * r * r; v = g.b * r; a = -g.b; }
      out.s = g.s0 + g.sgn * d; out.v = v; out.a = a;
    }
    return out;
  }
  // next scheduled stop index k (in trip.stops) from a plan state
  function nextStopK(p, seg) { return seg.kind === 1 ? seg.k : (seg.final ? seg.k : seg.k + 1); }

  // ---------- consists ----------
  const pool = { emu: [], diesel: [] }; let poolCount = { emu: 0, diesel: 0 };
  const POOLMAX = { emu: 7, diesel: 3 };
  function makeConsist(kind) {
    let c;
    try { c = typeof TrainKit !== 'undefined' ? TrainKit.createConsist(kind, { seed: poolCount[kind] * 7 + (kind === 'emu' ? 1 : 2), name: kind }) : null; } catch (e) { console.error('TrainKit', kind, e); c = null; }
    if (!c) c = Fallback.create(kind);
    c.group = c.group || new THREE.Group();
    for (const car of c.cars) { car.group.rotation.order = 'YZX'; car.group.matrixAutoUpdate = true; Env.scene.add(car.group); car.group.visible = false; }
    maxLen = Math.max(maxLen, c.length);
    poolCount[kind]++;
    return { consist: c, kind, busy: false, key: '' };
  }
  function acquire(kind, key) {
    for (const e of pool[kind]) if (!e.busy && e.key === key) { e.busy = true; return e; }
    for (const e of pool[kind]) if (!e.busy) { e.busy = true; e.key = key; e.dest = ''; return e; }
    if (poolCount[kind] >= POOLMAX[kind]) return null;
    const e = makeConsist(kind); pool[kind].push(e); e.busy = true; e.key = key; return e;
  }
  function releaseAll() { for (const k in pool) for (const e of pool[k]) e.busy = false; }

  // pose every car of a consist: front coupler of car 0 at sFront (south end, +X = +s), on the lane of dir
  const _q = new THREE.Quaternion();
  function poseConsist(c, sFront, dir, out) {
    let sAcc = sFront;
    for (const car of c.cars) {
      const sc = sAcc - car.length / 2; sAcc -= car.length;
      const [bf, br] = car.bogieOffsets;
      const s1 = sc + bf, s2 = sc + br;
      Track.point(s1, Track.lane(s1, dir), P1); Track.point(s2, Track.lane(s2, dir), P2);
      const y1 = Track.yAt(s1), y2 = Track.yAt(s2);
      const dx = P1.x - P2.x, dz = P1.z - P2.z, dy = y1 - y2; const L = Math.hypot(dx, dz) || 1;
      const f = (0 - br) / (bf - br || 1);
      const g = car.group;
      g.position.set(P2.x + dx * f, y2 + dy * f, P2.z + dz * f);
      // superelevation from curvature (lean into curves, max ~3.5 deg)
      const cur = curvature(sc); const roll = U.clamp(cur * 900, -0.06, 0.06);
      g.rotation.set(roll, Math.atan2(-dz / L, dx / L), Math.atan2(dy, L));
    }
  }
  function curvature(s) { Track.frame(s - 20, F); const ax = F.dx, az = F.dz; Track.frame(s + 20, F2); const cr = ax * F2.dz - az * F2.dx; return cr / 40; }

  // ---------- fallback consist (until TrainKit loads) ----------
  const Fallback = (() => {
    const bodyM = new THREE.MeshStandardMaterial({ color: 0xd8dcdf, metalness: 0.6, roughness: 0.35 });
    const bandM = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.3 });
    const redM = new THREE.MeshStandardMaterial({ color: 0xc8312a, roughness: 0.5 });
    function create(kind) {
      const n = kind === 'emu' ? 7 : 6; const cars = [];
      for (let i = 0; i < n; i++) {
        const L = 26, g = new THREE.Group();
        const b = new THREE.Mesh(new THREE.BoxGeometry(L - 0.8, 4.3, 3.0), bodyM); b.position.y = 0.95 + 2.15; b.castShadow = true; g.add(b);
        const w = new THREE.Mesh(new THREE.BoxGeometry(L - 1.2, 0.9, 3.04), bandM); w.position.y = 3.3; g.add(w);
        if (i === 0 || i === n - 1) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.6, 3.8, 3.02), redM); r.position.set((i === 0 ? 1 : -1) * (L / 2 - 0.7), 2.9, 0); g.add(r); }
        cars.push({ group: g, index: i, type: 'coach', length: L, width: 3, height: 4.9, bogieOffsets: [9.5, -9.5], floorRegions: [{ x0: -12, x1: 12, z0: -1.3, z1: 1.3, y: 1.3, name: 'floor' }], ramps: [], gangways: {}, seats: [{ x: 3, y: 2.5, z: 0.9, yaw: 0 }], doors: [{ x: -6, side: 1, width: 1.3, sillY: 1.1 }, { x: -6, side: -1, width: 1.3, sillY: 1.1 }, { x: 6, side: 1, width: 1.3, sillY: 1.1 }, { x: 6, side: -1, width: 1.3, sillY: 1.1 }], cabEye: i === 0 ? [11.8, 3.2, 0.5] : i === n - 1 ? [-11.8, 3.2, -0.5] : null });
      }
      const noop = () => {};
      return { kind, cars, length: n * 26, speed: 0, setDestination: noop, setDoors: noop, setLights: noop, setNight: noop, setPantograph: noop, setDisplay: noop, setCab: noop, setInteriorVisible: noop, setLOD: noop, update: noop };
    }
    return { create };
  })();

  // ---------- far trains ----------
  let farMesh = null, dots = null; const FARMAX = 400;
  function initFar() {
    const g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0);
    farMesh = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: 0xcfd4d8, metalness: 0.5, roughness: 0.4, emissive: 0xffc98a, emissiveIntensity: 0 }), FARMAX);
    farMesh.frustumCulled = false; farMesh.castShadow = false; farMesh.count = 0; Env.scene.add(farMesh);
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(90 * 3), 3)); pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(90 * 3), 3));
    dots = new THREE.Points(pg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthWrite: false, transparent: true, opacity: 0.95, fog: false }));
    dots.frustumCulled = false; dots.renderOrder = 5; Env.scene.add(dots);
  }
  const _m4 = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _c = new THREE.Color();

  // ---------- player-driven train ----------
  let drive = null;
  function startDrive(p, opts = {}) {
    const t = Env.time.sec; const st = stateAt(p, t, {});
    drive = { plan: p, trip: p.trip, dir: p.dir, kind: p.kind, s: st.s, v: st.v, acc: 0, lever: 0, emergency: false, penalty: false, doors: 0, doorsTarget: 0,
      doorSideNow: 0, horn: false, bell: false, odometer: 0, key: 'drive', auto: !!opts.auto, jerk: 0, lastAcc: 0 };
    // settle state if we start mid-run: keep speed
    return drive;
  }
  function stopDrive() { drive = null; }
  function driveStep(dt) {
    const D = drive; if (!D) return;
    const P = D.kind === 'emu' ? { amax: 1.05, pw: 12.5, bmax: 1.0, em: 1.5 } : { amax: 0.55, pw: 5.8, bmax: 0.85, em: 1.3 };
    const v = D.v;
    const doorsClosed = D.doors < 0.01;
    // demanded tractive / braking acceleration from the master controller
    let tDem = (D.lever > 0 && !D.emergency && !D.penalty && doorsClosed) ? Math.min(P.amax, P.pw / Math.max(v, 1)) * D.lever : 0;
    if (D.reverse && v > 2.2) tDem = 0;                                // reverser: shunting speed only
    let bDem = D.lever < 0 ? -D.lever * P.bmax : 0;
    if (D.penalty) bDem = Math.max(bDem, P.bmax);
    if (!doorsClosed && v < 0.5) bDem = Math.max(bDem, 0.4);          // holding brake while doors are open
    // jerk limiter (traction electronics / brake valves ramp the effort), emergency applies fast
    const step = (cur, dem, r) => cur + U.clamp(dem - cur, -r * dt, r * dt);
    D.tract = (D.penalty || D.emergency) ? 0 : step(D.tract || 0, tDem, 0.8);   // PTC / emergency cut traction instantly
    D.brk = D.emergency ? step(D.brk || 0, P.em, 4.0) : step(D.brk || 0, bDem, 1.1);
    Track.frame(D.s, F); const grade = F.grade * (D.dir ? 1 : -1) * (D.reverse ? -1 : 1);
    const res = 0.006 + 0.00011 * v + 0.000042 * v * v;
    let vn = v + (D.tract - 9.81 * grade * 0.9 - res) * dt;
    vn -= D.brk * dt;
    if (vn < 0) vn = 0;
    const acc = (vn - v) / dt; const sm = D.accS === undefined ? acc : U.lerp(D.accS, acc, Math.min(1, dt * 5));
    D.jerk = Math.abs(sm - (D.accS === undefined ? sm : D.accS)) / dt; D.accS = sm; D.acc = sm;
    const ds = (v + vn) / 2 * dt; D.s += (D.dir ? 1 : -1) * (D.reverse ? -1 : 1) * ds; D.odometer += ds; D.v = vn;
    D.s = U.clamp(D.s, D.dir ? maxLen : 2, D.dir ? Track.length - 2 : Track.length - maxLen);
    const dt2 = dt / 2.8; D.doors = U.clamp(D.doors + (D.doorsTarget > D.doors ? dt2 : -dt2), 0, 1);
  }

  // ---------- per-frame ----------
  let focusKey = null;                 // plan key the player is riding/driving/following (always gets a consist)
  let camNear = null;
  const stTmp = {};
  function update(dt, camPos) {
    replan();
    const t = Env.time.sec;
    running.length = 0;
    // collect running plans (binary-search start, plans sorted by tStart)
    for (const p of plans) {
      if (p.tStart > t + 1) break;
      if (p.tEnd < t) continue;
      if (drive && p === drive.plan) continue;
      const o = stateAt(p, t, {});
      running.push({ plan: p, trip: p.trip, key: p.key, kind: p.kind, dir: p.dir, s: o.s, v: o.v, a: o.a, seg: o.seg, segIdx: o.segIdx, len: 0, driven: false });
    }
    if (drive) { let rem = Env.time.paused ? 0 : dt * Env.time.scale; while (rem > 1e-6) { const h = Math.min(rem, 0.05); driveStep(h); rem -= h; } running.push({ plan: drive.plan, trip: drive.trip, key: drive.plan.key, kind: drive.kind, dir: drive.dir, s: drive.s, v: drive.v, a: drive.acc, seg: null, len: 0, driven: true }); }
    // multiplayer: other drivers override their trip's position or run an extra train
    if (typeof Net !== 'undefined') {
      for (const o of Net.others()) {
        if (o.modeName !== 'drive' && o.modeName !== 'cab') continue;
        const dir = o.speed >= 0 ? 1 : 0;
        const tr = o.trip && running.find(r => r.trip.id === o.trip && !r.driven);
        if (tr) { tr.s = o.s; tr.v = Math.abs(o.speed); tr.remote = o; }
        else if (o.s > 0) { const p0 = planById(o.trip) || null; running.push({ plan: p0, trip: p0 ? p0.trip : { id: 'X' + o.id, route: 'Local Weekday', head: '', stops: [] }, key: 'net' + o.id, kind: 'emu', dir, s: o.s, v: Math.abs(o.speed), a: 0, seg: null, len: 0, remote: o }); }
      }
    }
    camNear = Track.nearest(camPos.x, camPos.z, 40);
    // distances; pick near trains for consists
    for (const tr of running) { Track.frame(tr.s, F); tr.x = F.x; tr.z = F.z; tr.y = F.y; tr.dist = Math.hypot(F.x - camPos.x, F.z - camPos.z, (F.y - camPos.y) * 0.5); }
    running.sort((a, b) => (b.key === focusKey) - (a.key === focusKey) || a.dist - b.dist);
    releaseAll();
    let farN = 0, dotN = 0; const dp = dots.geometry.attributes.position.array, dc = dots.geometry.attributes.color.array;
    const night = U.uNight.value;
    for (const tr of running) {
      const near = tr.key === focusKey || tr.dist < 3200;
      const e = near ? acquire(tr.kind, tr.key) : null;
      tr.entry = e;
      const len = e ? e.consist.length : (tr.kind === 'emu' ? 185 : 160); tr.len = len;
      const sFront = tr.dir ? tr.s : tr.s + len;          // car 0 = south end
      // hide AI trains overlapping the player-driven train (only possible if the player runs very late)
      if (drive && !tr.driven && tr.dir === drive.dir && Math.abs(tr.s - drive.s) < len + 30) { if (e) e.busy = false; tr.hidden = true; continue; }
      if (e) {
        const c = e.consist; poseConsist(c, sFront, tr.dir, null);
        for (const car of c.cars) car.group.visible = true;
        setupConsist(tr, e, dt, night);
      } else if (tr.dist < 30000 && farN + 8 < FARMAX) {
        // far: one box per car (26 m), following the curve
        const nCars = tr.kind === 'emu' ? 7 : 6;
        for (let i = 0; i < nCars; i++) {
          const sc = sFront - (i + 0.5) * (len / nCars); Track.point(sc, Track.lane(sc, tr.dir), P1); const yaw = Math.atan2(-P1.dz, P1.dx);
          _m4.compose(_p.set(P1.x, Track.yAt(sc) + 0.95, P1.z), _q.setFromEuler(_e.set(0, yaw, 0)), _s.set(len / nCars - 0.8, 3.9, 3.0));
          farMesh.setMatrixAt(farN++, _m4);
        }
      }
      if (dotN < 90) { dp[dotN * 3] = tr.x; dp[dotN * 3 + 1] = tr.y + 12; dp[dotN * 3 + 2] = tr.z; _c.set(tr.remote ? (tr.remote.color || '#ffffff') : routeColor(tr.trip)); dc[dotN * 3] = _c.r; dc[dotN * 3 + 1] = _c.g; dc[dotN * 3 + 2] = _c.b; dotN++; }
    }
    // hide unused consists
    for (const k in pool) for (const e of pool[k]) if (!e.busy) for (const car of e.consist.cars) car.group.visible = false;
    farMesh.count = farN; farMesh.instanceMatrix.needsUpdate = true; farMesh.material.emissiveIntensity = 0.55 * night;   // lit windows at night, seen from afar
    dots.geometry.setDrawRange(0, dotN); dots.geometry.attributes.position.needsUpdate = true; dots.geometry.attributes.color.needsUpdate = true;
    const alt = camPos.y - Terrain.h(camPos.x, camPos.z); dots.visible = alt > 350; dots.material.opacity = U.smooth(350, 1200, alt);
    for (let i = running.length - 1; i >= 0; i--) if (running[i].hidden) running.splice(i, 1);
    updateBeam();
  }

  function destText(tr) {
    const st = tr.trip.stops; if (!st.length) return 'NOT IN SERVICE';
    const last = TT.names[TT.stations[st[st.length - 1][0]]] || tr.trip.head;
    return routeShort(tr.trip) + '  ' + last.toUpperCase();
  }
  function setupConsist(tr, e, dt, night) {
    const c = e.consist; const t = Env.time.sec;
    const dest = destText(tr); if (e.dest !== dest) { c.setDestination(dest); e.dest = dest; }
    // doors
    let doorSide = 'none', doorT = 0;
    const seg = tr.seg;
    if (tr.driven) { if (drive.doors > 0) { doorSide = drive.doorSideNow > 0 ? 'right' : 'left'; doorT = drive.doors; } }
    else if (seg && seg.kind === 0) {
      const si = seg.si; const side = doorSide_(si, tr.dir);
      const openAt = seg.t0 + (seg.first ? 20 : 4), closeAt = seg.t1 - (seg.final ? -1e9 : 7);
      doorT = U.clamp(Math.min((t - openAt) / 2.6, (closeAt - t) / 2.6), 0, 1);
      if (seg.final && t > seg.t1 - 30) doorT = U.clamp((seg.t1 - 30 - t) / 2.6 + 1, 0, 1);
      doorSide = side > 0 ? 'right' : 'left';
      tr.stationIdx = si;
    }
    tr.doorsOpen = doorT > 0.6; tr.doorSide = doorSide;
    c.setDoors(doorT > 0 ? doorSide : 'none', doorT);
    // lights: 'head' end = direction of travel
    const lead = tr.dir ? 'front' : 'rear';
    c.setLights({ head: 1, tail: 1, interior: 0.35 + 0.65 * night, cab: 0.5, lead });
    if (c.setLeadEnd) c.setLeadEnd(lead);
    c.setNight(night);
    if (c.setPantograph) c.setPantograph(tr.kind === 'emu' ? 1 : 0);
    c.speed = tr.dir ? tr.v : -tr.v;
    const lod = tr.dist < 450 ? 0 : tr.dist < 1400 ? 1 : 2; if (e.lod !== lod) { c.setLOD(lod); e.lod = lod; }
    const inside = tr.key === focusKey && (Player.onboard() || Player.inCab());
    // interiors only when you're aboard, or standing right beside the train (lit glass reads better from afar)
    const span0 = Math.min(sFrontOf(tr), sFrontOf(tr) - tr.len), span1 = Math.max(sFrontOf(tr), sFrontOf(tr) - tr.len);
    const beside = camNear && camNear.dist < 14 && camNear.s > span0 - 8 && camNear.s < span1 + 8;
    const iv = inside || beside; if (e.iv !== iv) { c.setInteriorVisible(iv); e.iv = iv; }
    if (tr.key === focusKey || tr.dist < 300) {
      const ns = nextStopName(tr);
      c.setDisplay({ route: routeShort(tr.trip), nextStop: ns, destination: (TT.names[TT.stations[(tr.trip.stops[tr.trip.stops.length - 1] || [0])[0]]] || ''), clock: Env.clockText(t) });
    }
    // cab desk displays for the train you're in (TrainKit throttles the canvas redraw itself)
    if (tr.key === focusKey && (Player.inCab() || tr.driven)) {
      const D = tr.driven ? drive : null; const sig = TrackGeo.nextSignal(tr.s, tr.dir);
      let nsName = '', distFt = 0;
      if (D && typeof Game !== 'undefined' && Game.stopInfo) { const inf = Game.stopInfo(); if (inf) { nsName = inf.name; distFt = Math.max(0, inf.togo) * 3.281; } }
      else if (tr.plan && tr.seg) { const ns = tr.trip.stops[nextStopK(tr.plan, tr.seg)]; if (ns) { nsName = TT.names[TT.stations[ns[0]]]; distFt = Math.abs(stopS(ns[0], tr.dir) - tr.s) * 3.281; } }
      const over = tr.v - Track.limit(tr.s);
      c.setCab({ speedMph: tr.v / MPH, limitMph: Track.limit(tr.s) / MPH,
        throttle: D ? Math.max(0, D.lever) : U.clamp(tr.a / 0.85, 0, 1), brake: D ? Math.max(0, -D.lever) + (D.emergency ? 1 : 0) : U.clamp(-tr.a / 0.75, 0, 1),
        signal: sig ? ['stop', 'approach', 'clear'][sig.aspect] : 'clear', nextStop: nsName, distFt, clock: Env.clockText(t),
        ptc: D && D.penalty ? 'enforcing' : over > 1.3 ? 'warning' : 'active' });
    }
    c.update(dt);
    paxFor(e, tr, iv && (tr.key === focusKey || tr.dist < 60));
    // door world positions (for crowds walking to the doors)
    if (tr.doorsOpen && tr.dist < 700) {
      tr.doorWorld = [];
      const sideN = doorSide === 'right' ? 1 : -1;
      for (const car of c.cars) for (const d of car.doors) if (d.side === sideN) { _p.set(d.x, 0, d.side * (car.width / 2 + 0.3)); car.group.localToWorld(_p); tr.doorWorld.push({ x: _p.x, z: _p.z }); }
    } else tr.doorWorld = null;
  }
  const doorSide_ = (si, dir) => doorSide(si, dir);
  const sFrontOf = (tr) => tr.dir ? tr.s : tr.s + tr.len;   // car 0 (south end) coupler
  // seated passengers (Life people, one instanced set per car, parented to the car) for the train you're on / next to
  const KINDS = ['commuter', 'commuter', 'office', 'student', 'tourist', 'senior', 'kid', 'cyclist'];
  const _pw = new THREE.Vector3();
  function paxFor(e, tr, show) {
    if (typeof Life === 'undefined' || !Life.createPeople) return;
    const cars = e.consist.cars; const bucket = Math.floor(Env.time.sec / 1200), cp = Env.camera.position;
    for (let ci = 0; ci < cars.length; ci++) {
      const car = cars[ci];
      // only cars near the camera: from a platform the far cars' passengers are specks behind tinted glass
      let near = show; if (near) { car.group.getWorldPosition(_pw); near = (_pw.x - cp.x) ** 2 + (_pw.z - cp.z) ** 2 < 75 * 75; }
      if (!near) { if (car._pax) car._pax.mesh.visible = false; continue; }
      if (!car._pax) { if (!car.seats || !car.seats.length) continue; try { car._pax = Life.createPeople(Math.min(car.seats.length, 110)); } catch (err) { continue; } car._pax.mesh.frustumCulled = false; car.group.add(car._pax.mesh); car._paxKey = ''; }
      car._pax.mesh.visible = true;
      const key = tr.key + ':' + bucket;
      if (car._paxKey !== key) { car._paxKey = key; populate(car, tr, ci, bucket); }
    }
  }
  function populate(car, tr, ci, bucket) {
    const P = car._pax; const r = U.rng(U.hashStr(tr.trip.id + ':' + ci + ':' + bucket));
    const h = Env.time.sec / 3600; const peak = (h > 6.5 && h < 9.5) || (h > 16 && h < 19.5);
    const load = peak ? 0.55 : h > 22 || h < 6 ? 0.1 : 0.28;
    let k = 0; car._paxSeat = [];
    for (let si = 0; si < car.seats.length && k < P.max; si++) {
      const st = car.seats[si]; if (Math.abs(st.x) > 11.2 || car.type === 'loco') continue;
      if (r() >= load) continue;
      try { P.look(k, { kind: KINDS[Math.floor(r() * KINDS.length)], seed: Math.floor(r() * 1e6) }); } catch (err) {}
      P.sitAtEye(k, st.x, st.y, st.z, st.yaw); car._paxSeat[k] = si; k++;
    }
    P.count = k; P.update(0.1);
  }
  // hide the passenger sitting in (car, seat) so the player can take that seat
  function freeSeat(tr, ci, si) { const car = tr && tr.entry && tr.entry.consist.cars[ci]; if (!car || !car._pax || !car._paxSeat) return; const k = car._paxSeat.indexOf(si); if (k >= 0) { car._pax.hide(k); car._paxSeat[k] = -1; } }
  function nextStopName(tr) {
    if (!tr.plan) return '';
    if (tr.driven) return drive.nextName || '';
    const k = tr.seg ? nextStopK(tr.plan, tr.seg) : 0; const s = tr.trip.stops[k]; return s ? TT.names[TT.stations[s[0]]] : '';
  }

  // headlight beam for the train you're following (one real light, always in the scene to avoid shader recompiles)
  let beam = null; const _b1 = new THREE.Vector3(), _b2 = new THREE.Vector3();
  function initBeam() {
    beam = new THREE.SpotLight(0xfff0d8, 0, 260, 0.34, 0.65, 1.3); beam.castShadow = false;
    Env.scene.add(beam, beam.target);
  }
  function updateBeam() {
    const night = U.uNight.value; const tr = focusKey ? running.find(r => r.key === focusKey) : null;
    if (!tr || !tr.entry || night < 0.15) { beam.intensity = 0; return; }
    const cs = tr.entry.consist.cars; const car = tr.dir ? cs[0] : cs[cs.length - 1]; const sg = tr.dir ? 1 : -1;
    _b1.set(sg * car.length / 2, 1.1, 0); car.group.localToWorld(_b1); _b2.set(sg * (car.length / 2 + 60), 0.2, 0); car.group.localToWorld(_b2);
    beam.position.copy(_b1); beam.target.position.copy(_b2); beam.intensity = 2600 * U.smooth(0.15, 0.6, night);
  }
  async function init() {
    TT = await Data.json('timetable');
    initFar(); initBeam();
    replan();
  }
  // the consist entry for a key (for the player to attach to)
  function trainByKey(key) { return running.find(r => r.key === key) || null; }
  function nearestTrain(pos, maxD = 1e9, filter) { let best = null, bd = maxD; for (const tr of running) { if (filter && !filter(tr)) continue; const d = Math.hypot(tr.x - pos.x, tr.z - pos.z); if (d < bd) { bd = d; best = tr; } } return best; }

  return { init, update, stateAt, nextStopK, nextDepartures, departures, planById, routeShort, routeColor, kindOf, stopS, doorSide, trainByKey, nearestTrain,
    startDrive, stopDrive, get drive() { return drive; }, running, get plans() { return plans; }, get TT() { return TT; },
    setFocus(k) { focusKey = k; }, get focus() { return focusKey; }, get maxLen() { return maxLen; }, destText, MPH, freeSeat };
})();
