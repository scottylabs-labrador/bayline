// P10 (promo v3, world montage, 2 bars = 4.03 s): 17:40 at Lake Merritt, a low camera (1.2 m) on the island edge, 32 mm,
// looking back along a departing train and across its track at the trackway wall: the last cars rush past, the tail
// clears the lens and the black tile circles and red arrows are revealed behind it, while the camera dollies 0.4 m/s
// against the train's direction.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
import { metroReady, metroStop, platSide, fp, stationBuilt, clearNear } from './_st.mjs';
const DAY = '2026-09-29', T0 = 17 * 3600 + 40 * 60, DUR = 6.0;
export default {
  hash: '#auto&t=17:40&q=ultra&w=clear', warm: 40, frames: 180, maxDsf: 1.5,
  setup: `async () => { ${cine}; ${metro}; const B = window.__bayline; if (!await (${metroReady})()) return 'metro not ready';
    await __m.day('${DAY}', ${T0}); const MS = B.MetroSim;
    // a departure whose far track stays empty while its doors close (no train at the other platform then)
    const other = (e) => MS.arrivals('LAKE', e.dep - 900, 200, { past: 3600, withLast: true }).filter(x => x.sid !== e.sid && x.arr < e.dep + 4 && x.dep > e.dep - 9);
    const ev = (${metroStop})('LAKE', ${T0}, { dep: true, minDwell: 15, filter: (e) => other(e).length === 0 }); if (!ev) return 'no train'; window.__ev = ev;
    const F = ev.F; __cine.put((${fp})(F, -70, 0, 3), (${fp})(F, -100, 0, 2)); return [ev.key, ev.sid, ev.line, Math.round(ev.dep)]; }`,
  prime: `async () => { const B = window.__bayline, ev = window.__ev; await (${stationBuilt})('LAKE');
    const F = ev.F, side = (${platSide})(F) || 1, th = 0.33, c = Math.cos(th), sn = Math.sin(th), L = ev.cars * 21.3, aC = -47;
    // 1.4 m in from the edge, 47 m back from the head's stop mark; looking back along the track, 19 degrees across it
    // toward the trackway wall; dollying 2.4 m back along the platform (against the train)
    const off = side * (1.62 + 1.4), P0 = (${fp})(F, aC, off, 0.99 + 1.2), P1 = (${fp})(F, aC - 2.4, off, 0.99 + 1.2);
    const q = (p) => ({ x: p.x - F.tx * c * 30 - F.rx * side * sn * 30, y: p.y + 0.2, z: p.z - F.tz * c * 30 - F.rz * side * sn * 30 });
    window.__s = { p0: P0, p1: P1, q0: q(P0), q1: q(P1) };
    // the clock: the tail passes the camera 2.2 s into the shot (the head then aC + L m past its mark)
    const MS = B.MetroSim, o = {}, target = ev.ps + aC + L; let lo = ev.dep, hi = ev.dep + 90;
    for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; MS.legState(ev.leg, m, o); if (o.ps < target) lo = m; else hi = m; }
    const t0 = hi - 2.2; B.Env.setClock(t0); B.Env.time.scale = 1; __m.focus(ev.key);
    B.StationCrowds.after = () => (${clearNear})(B.Env.camera.position, 1.0);       // (after the crowd moves: no one at the lens)
    return { side, cars: ev.cars, t0: +t0.toFixed(1), dep: ev.dep, cell: B.Under.cellAt(P0.x, P0.y, P0.z) }; }`,
  before: `(t) => { const C = __cine, s = window.__s, k = Math.min(1, t / ${DUR}); C.put(C.mix(s.p0, s.p1, k), C.mix(s.q0, s.q1, k)); }`,
  // (a steady dolly: linear, no ease)
  cam: `(t, cam) => { const C = __cine, s = window.__s, k = Math.min(1, t / ${DUR}), p = C.mix(s.p0, s.p1, k); C.aim(cam, p, C.mix(s.q0, s.q1, k), 40.5, 0); }`,
};
