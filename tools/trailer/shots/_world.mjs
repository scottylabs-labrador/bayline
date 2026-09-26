// Shared page-side helpers for the world workstream's promo shots (p_dawn_bay, p_night_flyover, p_embr_rise,
// p_bay_night). Self-contained: they read Bayline Metro's timetable (MetroSim) directly, so a shot finds its trains by
// the timetable of whatever service day the capture runs on, never by luck.

// wait until the metro timetable is loaded (MetroNet + MetroSim); resolves false after `ms` without it
export const metroReady = `(ms = 60000) => new Promise(r => { const t0 = performance.now(); const f = () => { const M = window.__bayline.MetroSim;
  if (M && M.ready && M.plans && M.plans.length) r(true); else if (performance.now() - t0 > ms) r(false); else setTimeout(f, 250); }; f(); })`;

// the metro trains at clock time t: [{ key, lead, line, x, y, z, st (structure code of the head: 0 grade, 1 aerial, 2 bridge,
// 3 embankment, 4 trench, 5 median, 6.. underground), stName, tx, tz, len, v }]
// (a pure function of the timetable: nothing is advanced)
export const metroAt = `(t) => { const M = window.__bayline.MetroSim, LS = {}, F = {}, out = [];
  for (const p of M.plans) { if (p.tStart > t) break; if (p.tEnd < t) continue; const l = M.legAt(p, t); if (!l) continue;
    M.legState(l, t, LS); l.path.at(LS.ps, F); const len = l.cars * M.PERF[l.kind].carLen;
    out.push({ key: p.key, lead: l.lead, line: l.line, x: F.x, y: F.y, z: F.z, st: F.struct, stName: F.st, tx: F.tx, tz: F.tz, len, v: LS.v }); }
  return out; }`;

// the clock time in [t0, t1] (step s) at which a shot of `dur` seconds sees the most trains in a corridor: a polyline
// of [lat, lon] (heads within `r` m of it, on one of the structure codes `sts`), sampled at `taps` seconds into the
// shot; trains going both ways earn a bonus. Sets the clock there; returns { t, score, both }
export const metroBest = `(t0, t1, step, taps, line, r, sts) => { const C = __cine, M = window.__bayline.MetroSim, at = (${metroAt});
  const P = line.map(([la, lo]) => C.ll(la, lo, 0));
  const near = (x, z) => { for (let i = 0; i + 1 < P.length; i++) { const a = P[i], b = P[i + 1], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
    const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2)); if (Math.hypot(x - a.x - dx * u, z - a.z - dz * u) < r) return true; } return false; };
  let best = null;
  for (let t = t0; t <= t1; t += step) { let n = 0; const dirs = new Set(), keys = new Set();
    for (const dt of taps) for (const tr of at(t + dt)) if (sts.includes(tr.st) && near(tr.x, tr.z)) { n++; dirs.add(tr.lead); keys.add(tr.key); }
    const score = n + (dirs.size > 1 ? taps.length : 0) + keys.size;
    if (!best || score > best.score) best = { t, score, both: dirs.size > 1, trains: keys.size }; }
  if (best) { window.__bayline.Env.setClock(best.t); window.__bayline.Env.time.scale = 1; }
  return best; }`;

// the clock time in [t0, t1] (step s) with the most metro trains out in the open (not in a tunnel or under a lid)
// inside a box [lat0, lon0, lat1, lon1]; sets the clock there; returns { t, n }
export const metroBusiest = `(t0, t1, step, box) => { const C = __cine, at = (${metroAt});
  const a = C.ll(box[0], box[1], 0), b = C.ll(box[2], box[3], 0), x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
  let best = null;
  for (let t = t0; t <= t1; t += step) { let n = 0; for (const tr of at(t)) if (tr.st < 6 && tr.x > x0 && tr.x < x1 && tr.z > z0 && tr.z < z1) n++;
    if (!best || n > best.n) best = { t, n }; }
  if (best) { window.__bayline.Env.setClock(best.t); window.__bayline.Env.time.scale = 1; }
  return best; }`;

// Bayline Metro's map dots (coloured squares over every train, drawn on top of everything from 350 m up: a map aid)
// are not part of a cinematic view: hidden, called from a shot's cam() (they are re-shown every frame by MetroSim)
export const hideMapDots = `(() => { const W = window; if (!W.__mdots && !((W.__mdotsTry = (W.__mdotsTry || 0) + 1) % 15 === 1)) return;
  if (!W.__mdots) W.__bayline.Env.scene.traverse(o => { if (o.isPoints && o.material && o.material.depthTest === false && o.renderOrder === 6) W.__mdots = o; });
  if (W.__mdots) W.__mdots.visible = false; })()`;

// the clock time in [t0, t1] (step s) at which the shot's own camera path sees the most metro trains in frame: the
// camera is window.__mv(k) (moveLL) or window.__path(t) ({ p, q }) evaluated at `taps` seconds of a shot of `dur`;
// a train counts at a tap when its head or middle is out in the open (structure < 6), dmin..dmax m from the camera and
// inside `frac` of the frame (vertical fov `fov` degrees, 16:9), nearer ones more; trains both ways and more trains earn
// a bonus. Sets
// the clock there; returns { t, score, trains, both }
export const metroFramed = `(t0, t1, step, taps, dur, fov, dmin, dmax, frac = 0.85) => { const M = window.__bayline.MetroSim, at = (${metroAt}), LS = {}, F = {};
  const pose = (tt) => window.__path ? window.__path(tt) : window.__mv(tt / dur);
  const cams = taps.map(tt => { const P = pose(tt), dx = P.q.x - P.p.x, dy = P.q.y - P.p.y, dz = P.q.z - P.p.z, l = Math.hypot(dx, dy, dz);
    const f = { x: dx / l, y: dy / l, z: dz / l }, rl = Math.hypot(f.x, f.z) || 1, r = { x: -f.z / rl, y: 0, z: f.x / rl }, u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
    return { p: P.p, f, r, u }; });
  const tv = Math.tan(fov * Math.PI / 360) * frac, th = tv * 16 / 9;
  const seen = (c, x, y, z) => { const dx = x - c.p.x, dy = y - c.p.y, dz = z - c.p.z, d = dx * c.f.x + dy * c.f.y + dz * c.f.z; if (d < dmin || d > dmax) return 0;
    return Math.abs((dx * c.r.x + dy * c.r.y + dz * c.r.z) / d) < th && Math.abs((dx * c.u.x + dy * c.u.y + dz * c.u.z) / d) < tv ? 1 + 2 * (1 - d / dmax) : 0; };   // (nearer trains weigh more)
  let best = null;
  for (let t = t0; t <= t1; t += step) { let n = 0; const dirs = new Set(), keys = new Set();
    taps.forEach((tt, i) => { const c = cams[i];
      for (const p of M.plans) { const tc = t + tt; if (p.tStart > tc) break; if (p.tEnd < tc) continue; const l = M.legAt(p, tc); if (!l) continue;
        M.legState(l, tc, LS); const len = l.cars * M.PERF[l.kind].carLen; let w = 0;
        for (const back of [0, len / 2]) { l.path.at(LS.ps - back, F); if (F.struct < 6) w = Math.max(w, seen(c, F.x, F.y + 2, F.z)); }
        if (w > 0) { n += w; dirs.add(l.lead); keys.add(p.key); } } });
    const score = n + (dirs.size > 1 ? taps.length : 0) + keys.size * 2;
    if (!best || score > best.score) best = { t, score, trains: keys.size, both: dirs.size > 1 }; }
  if (best) { window.__bayline.Env.setClock(best.t); window.__bayline.Env.time.scale = 1; }
  return best; }`;
