import { readFileSync } from 'node:fs';
export const cine = readFileSync(new URL('../cine.js', import.meta.url), 'utf8');
// page-side: the first departure from a station (id) in a direction after a clock time; sets the clock to it + off
export const depClock = `(sid, dir, after, off) => { const B = window.__bayline, si = B.Sim.TT.stations.indexOf(sid); const d = B.Sim.departures(si, after, 40).find(x => x.dir === dir && x.t >= after);
  if (!d) return null; B.Env.setClock(d.t + off); B.Env.time.scale = 1; return { t: d.t + off, key: d.plan.key, trip: d.trip.id }; }`;
// page-side: wait for the flight, hide nothing of the aircraft (exterior camera), assisted handling
export const flyReady = `async () => { const B = window.__bayline; while (!B.Flight.active) await new Promise(r => setTimeout(r, 200)); B.Flight.cam.set('chase', true); return B.Flight.type.id; }`;
// page-side: runway frame for an airport / runway ident: threshold point, unit direction, heading
export const rwy = `(ident, rwIdent) => { const B = window.__bayline, A = B.Airports, a = A.byIdent(ident); for (const rw of a.runways) for (const end of [0, 1]) { const e = A.runwayEnd(a, rw, end); if (e.ident === rwIdent) return e; } return null; }`;
// page-side: set the clock `lead` seconds before the first train in direction dir (0 north, 1 south) reaches track
// position sAt after a clock time, optionally only one going at least minV m/s there; returns { t, key, trip, v, tPass }
export const passClock = `(sAt, dir, after, lead, minV = 0) => { const B = window.__bayline, Sim = B.Sim, o = {}, sg = dir ? 1 : -1; let best = null;
  for (const p of Sim.plans) { if (p.dir !== dir || p.tEnd < after) continue; const f = t => (Sim.stateAt(p, t, o).s - sAt) * sg;
    let a = Math.max(p.tStart, after), b = p.tEnd; if (f(a) >= 0 || f(b) < 0) continue;
    for (let i = 0; i < 44; i++) { const m = (a + b) / 2; if (f(m) < 0) a = m; else b = m; }
    const v = Sim.stateAt(p, a, o).v; if (v < minV) continue; if (!best || b < best.tPass) best = { tPass: b, key: p.key, trip: p.id, v }; }
  if (!best) return null; B.Env.setClock(best.tPass - lead); B.Env.time.scale = 1; return { t: best.tPass - lead, key: best.key, trip: best.trip, v: Math.round(best.v), tPass: best.tPass }; }`;
// page-side: a camera move between points given as [lat, lon, height above the ground (m)] (ground sampled once, after
// the warm-up, so streamed terrain is in); window.__mv(k) -> { p, q } for k in 0..1 (eased), p/q along their own splines
export const moveLL = (P, Q) => `(() => { const C = __cine, B = window.__bayline; let cache = null;
  const pts = (L) => L.map(([la, lo, h]) => { const w = C.ll(la, lo, 0); return { x: w.x, y: C.ground(w.x, w.z) + h, z: w.z }; });
  window.__mv = (k, raw) => { if (!cache) cache = { p: pts(${JSON.stringify(P)}), q: pts(${JSON.stringify(Q)}) }; const e = raw ? k : C.ease(k);
    return { p: cache.p.length > 1 ? C.spline(cache.p, e) : cache.p[0], q: cache.q.length > 1 ? C.spline(cache.q, e) : cache.q[0] }; };
  window.__mvReset = () => { cache = null; }; return 1; })()`;
// page-side: start driving a train (autopilot on) from a station, the first departure in a direction after a clock
// time; lead = seconds before its departure to set the clock to; returns { key, trip, dep }
export const driveFrom = `(sid, dir, after, lead) => { const B = window.__bayline, si = B.Sim.TT.stations.indexOf(sid);
  const d = B.Sim.departures(si, after, 40).find(x => x.dir === dir && x.t >= after); if (!d) return null;
  const k0 = d.plan.trip.stops.findIndex(s => s[0] === si || s[0] === sid); if (k0 < 0) return 'no stop'; B.Game.startDrive(d.plan, { auto: true, fromK: k0 });
  B.Env.setClock(d.t - lead); B.Env.time.scale = 1; return { key: d.plan.key, trip: d.trip.id, dep: d.t }; }`;
// page-side: a flying start: drive (autopilot) the first train in a direction to pass track position sAt after a clock
// time (optionally only one that stops at needStop), from `lead` seconds before it gets there, at its timetable speed
export const driveMid = `(sAt, dir, after, lead, minV = 0, needStop = null) => { const B = window.__bayline, Sim = B.Sim, G = B.Game, o = {}, sg = dir ? 1 : -1; let best = null;
  for (const p of Sim.plans) { if (p.dir !== dir || p.tEnd < after) continue; if (needStop && !p.trip.stops.some(x => x[0] === needStop || x[0] === B.Sim.TT.stations.indexOf(needStop))) continue; const f = t => (Sim.stateAt(p, t, o).s - sAt) * sg;
    let a = Math.max(p.tStart, after), b = p.tEnd; if (f(a) >= 0 || f(b) < 0) continue;
    for (let i = 0; i < 44; i++) { const m = (a + b) / 2; if (f(m) < 0) a = m; else b = m; }
    const v = Sim.stateAt(p, a, o).v; if (v < minV) continue; if (!best || b < best.tPass) best = { p, tPass: b, v }; }
  if (!best) return null; const p = best.p, t = best.tPass - lead; B.Env.setClock(t); B.Env.time.scale = 1;
  const st = Sim.stateAt(p, t, {}); let k = 0; for (let i = 0; i < p.trip.stops.length - 1; i++) if (((Sim.stopS(p.trip.stops[i][0], p.dir) - st.s) * sg) <= 0) k = i;
  const run = G.startDrive(p, { auto: true, fromK: k }); B.Env.setClock(t); const D = Sim.drive;
  D.s = st.s; D.v = st.v; D.doors = 0; D.doorsTarget = 0; run.state = 'run'; run.atK = k; run.k = k + 1; run.departOK = true;
  return { key: p.key, trip: p.id, v: Math.round(st.v), k }; }`;
// page-side: a look target from p toward the sun's azimuth, turned by yawOff (radians) and tilted to pitch
export const sunLook = `(p, yawOff, pitch, dist = 1000) => { const s = window.__bayline.Env.sunDir, a = Math.atan2(s.x, -s.z) + yawOff;
  return { x: p.x + Math.sin(a) * dist, y: p.y + Math.tan(pitch) * dist, z: p.z - Math.cos(a) * dist }; }`;
