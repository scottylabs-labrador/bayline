// Page-side helpers for the metro station shots (STATIONS): metro stop events and the frame of their stopping point,
// the platform's side, points in that frame, the time a train's head reaches a mark, people placed by hand (riders on
// escalators, a lone rider), the station's own build state. Every export is a function source string (a shot's setup /
// prime / before / cam runs it in the page); trains are found by timetable (SIM's _metro.mjs: pin the day with __m.day).

// wait until the metro network, its timetable and the stations are ready
export const metroReady = `async () => { const B = window.__bayline; for (let i = 0; i < 600; i++) { if (B.MetroSim && B.MetroSim.ready && B.MetroStations && B.MetroStations.ready) return true; await new Promise(r => setTimeout(r, 200)); } return false; }`;

// the next metro stop event at station sid at or after clock `after` (s); opt: { plat: '2' (platform code), line,
// kind ('bart'), dep: true (by departure time), minDwell, last: true (a terminating train too), filter(e) }
// -> { key, arr, dep, k, sid, line, cars, ps, F, leg } where F is the frame of the head's stopping mark (x, y (rail),
// z, tx, tz along the direction of travel, rx, rz to its right) and leg the timetable leg (not serialisable: keep it in
// window, return a summary)
export const metroStop = `(sid, after, opt = {}) => { const B = window.__bayline, MS = B.MetroSim;
  const L = MS.arrivals(sid, after - 900, 400, { past: 3600, withLast: !!opt.last });
  const ok = (e) => (opt.last || !e.last) && e.leg.kind === (opt.kind || 'bart') && (!opt.plat || String(e.sid).split('-').pop() === String(opt.plat)) && (!opt.line || e.leg.line === opt.line)
    && (opt.dep ? e.dep : e.arr) >= after && (!opt.minDwell || e.dep - e.arr >= opt.minDwell) && (!opt.key || (e.leg.chainKey || e.plan.key) === opt.key) && (!opt.filter || opt.filter(e));
  const ev = L.find(ok); if (!ev) return null; const l = ev.leg, s = l.stops[ev.k], F = {}; l.path.at(s.ps, F);
  return { key: l.chainKey || ev.plan.key, arr: ev.arr, dep: ev.last ? ev.arr + 150 : ev.dep, k: ev.k, sid: ev.sid, line: l.line, cars: l.cars, ps: s.ps, last: !!ev.last,
    F: { x: F.x, y: F.y, z: F.z, tx: F.tx, tz: F.tz, rx: F.rx, rz: F.rz }, leg: l }; }`;

// the clock time at which the head of the event's train is d m short of its stopping mark (d > 0), before it stops
export const headAt = `(ev, d) => { const MS = window.__bayline.MetroSim, o = {}, target = ev.ps - d; let a = ev.arr - 240, b = ev.arr;
  for (let i = 0; i < 48; i++) { const m = (a + b) / 2; MS.legState(ev.leg, m, o); if (o.ps < target) a = m; else b = m; } return b; }`;

// which side of the track (in the frame F: +1 = F's right) the platform is on, from the built station's walk floors
// (call once the station is built: after the warm-up)
// (sampled 8 to 40 m back from the mark: the mark itself may lie a metre or two past the platform's end)
export const platSide = `(F) => { const B = window.__bayline, M = B.MetroStations, yP = F.y + 0.99; let best = 0, bs = 0;
  for (const sd of [1, -1]) { let n = 0; for (const a of [8, 20, 40]) for (const d of [2.4, 3.2, 4.0]) { const x = F.x - F.tx * a + F.rx * sd * d, z = F.z - F.tz * a + F.rz * sd * d, h = M.floorAt(x, yP + 0.5, z); if (h !== null && Math.abs(h - yP) < 0.35) n++; }
    if (n > bs) { bs = n; best = sd; } }
  return best; }`;

// a point in a stop frame: a m along the direction of travel, b m to its right, h m over the rail
export const fp = `(F, a, b, h) => ({ x: F.x + F.tx * a + F.rx * b, y: F.y + h, z: F.z + F.tz * a + F.rz * b })`;

// the yaw (GB.at / people convention: facing (cos yaw, -sin yaw)) of a world direction (dx, dz)
export const yawOf = `(dx, dz) => Math.atan2(-dz, dx)`;

// the station built and its programs warm (the stepped build and its compile run in real time: wait for them)
export const stationBuilt = `async (id) => { const B = window.__bayline, M = B.MetroStations; for (let i = 0; i < 900; i++) { const st = M.byId[id];
  if (st && st.state === 'built' && st.root && st.root.userData.warm !== false) return true; B.stepFrame && B.stepFrame(1); await new Promise(r => setTimeout(r, 30)); } return false; }`;

// people by hand (after the crowd's update, i.e. from cam()): replace the crowd (keep = 0) or add to its instances.
// list: [{ x, y, z (world, the floor under the hips), yaw (facing (cos, -sin)), mode (0 stand, 1 walk), ph, speed }]
export const setPeople = `(list, keep) => { const B = window.__bayline, SC = B.StationCrowds; const P = SC && SC.people; if (!P) return 0;
  const o = P.mesh.position; let k = keep === undefined ? P.count : Math.min(keep, P.count);
  for (const q of list) P.set(k++, q.x - o.x, q.y, q.z - o.z, q.yaw, q.mode || 0, q.ph || 0, q.mode ? (q.speed || 1.2) : undefined);
  P.count = k; P.mesh.visible = true; if (P.update) P.update(0); return k; }`;          // (the LOD people pack their instances in update)

// no one walks through the lens: crowd instances within r m (horizontally) of the camera are hidden this frame
// (call it last in cam(): it edits the drawn instances of this frame, after the crowd and setPeople packed them)
// (keep: people placed by hand, [{ x, z }], never hidden)
export const clearNear = `(p, r = 0.9, keep = null) => { const B = window.__bayline, SC = B.StationCrowds, P = SC && SC.people; if (!P) return 0;
  const g = P.mesh, o = g.position, Ms = g.isInstancedMesh ? [g] : g.children.filter(c => c.isInstancedMesh), e = new THREE.Matrix4(), z0 = new THREE.Matrix4().makeScale(0, 0, 0); let n = 0;
  for (const m of Ms) { let hit = false; for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, e); const x = e.elements[12] + o.x, y = e.elements[13], z = e.elements[14] + o.z;
    if (Math.hypot(x - p.x, z - p.z) < r && Math.abs(y + 1 - p.y) < 2.2 && !(keep && keep.some(q => Math.abs(q.x - x) < 0.05 && Math.abs(q.z - z) < 0.05))) { m.setMatrixAt(i, z0); hit = true; n++; } }
    if (hit) m.instanceMatrix.needsUpdate = true; }
  return n; }`;

// a clear line of sight: no Towns building footprint on the segment a -> b (sampled every 1.5 m; pad m around each)
export const clearLine = `(a, b, pad = 1.5) => { const B = window.__bayline, T = B.Towns; if (!T || !T.buildingsAt) return true;
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, L = Math.hypot(b.x - a.x, b.z - a.z), bl = T.buildingsAt(mx, mz, L / 2 + 60);
  const inP = (P, x, z) => { let ins = false; const n = P.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = P[i * 2], zi = P[i * 2 + 1], xj = P[j * 2], zj = P[j * 2 + 1]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) ins = !ins; } return ins; };
  for (let d = 0; d <= L; d += 1.5) { const k = d / L, x = a.x + (b.x - a.x) * k, z = a.z + (b.z - a.z) * k;
    for (const g of bl) { for (const [ox, oz] of [[0, 0], [pad, 0], [-pad, 0], [0, pad], [0, -pad]]) if (inP(g.pts, x + ox, z + oz)) return false; } }
  return true; }`;

// a spot clear of the roads (Towns road ribbons, their half width + pad) and of the parked / moving traffic on them
export const offRoad = `(x, z, pad = 3) => { const B = window.__bayline, T = B.Towns; if (!T || !T.roadsNear) return true;
  for (const r of T.roadsNear(x, z, 40)) { const P = r.pts, hw = (r.width || 8) / 2 + pad;
    for (let i = 0; i + 3 < P.length; i += 3) { const ax = P[i], az = P[i + 2], bx = P[i + 3], bz = P[i + 5], ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)); if (Math.hypot(ax + ex * t - x, az + ez * t - z) < hw) return false; } }
  return true; }`;
