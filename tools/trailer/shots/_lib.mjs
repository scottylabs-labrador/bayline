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
