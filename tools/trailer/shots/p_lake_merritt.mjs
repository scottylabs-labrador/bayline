// P10 (promo v3, world montage, 2 bars): 17:40 at Lake Merritt, on the island beside a standing train on a 35 mm lens,
// looking diagonally across the empty far track at the trackway wall's big black tile circles and red arrows; the
// train's doors close on the left of the frame while the camera slides half a metre along the platform.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
import { metroReady, metroStop, platSide, fp, stationBuilt, clearNear } from './_st.mjs';
const DAY = '2026-09-29', T0 = 17 * 3600 + 40 * 60, DUR = 3.6;
export default {
  hash: '#auto&t=17:40&q=ultra&w=clear', warm: 40, frames: 108, maxDsf: 1.5,
  setup: `async () => { ${cine}; ${metro}; const B = window.__bayline; if (!await (${metroReady})()) return 'metro not ready';
    await __m.day('${DAY}', ${T0}); const MS = B.MetroSim;
    // a departure whose far track stays empty while its doors close (no train at the other platform then)
    const other = (e) => MS.arrivals('LAKE', e.dep - 900, 200, { past: 3600, withLast: true }).filter(x => x.sid !== e.sid && x.arr < e.dep + 4 && x.dep > e.dep - 9);
    const ev = (${metroStop})('LAKE', ${T0}, { dep: true, minDwell: 15, filter: (e) => other(e).length === 0 }); if (!ev) return 'no train'; window.__ev = ev;
    const F = ev.F; __cine.put((${fp})(F, -70, 0, 3), (${fp})(F, -100, 0, 2)); return [ev.key, ev.sid, ev.line, Math.round(ev.dep)]; }`,
  prime: `async () => { const B = window.__bayline, ev = window.__ev; await (${stationBuilt})('LAKE');
    const F = ev.F, side = (${platSide})(F) || 1, a = -0.55 * ev.cars * 21.3, c = Math.cos(0.3), s = Math.sin(0.3);
    // 1.8 m into the island from the train's edge, by the train's middle; looking back along the train, 17 degrees
    // across the island toward the far wall and its circles
    const p0 = (${fp})(F, a, side * 3.4, 0.99 + 1.6), p1 = (${fp})(F, a - 0.6, side * 3.4, 0.99 + 1.6);
    const q = (p) => ({ x: p.x - F.tx * c * 30 + F.rx * side * s * 30, y: p.y - 0.25, z: p.z - F.tz * c * 30 + F.rz * side * s * 30 });
    window.__s = { p0, p1, q0: q(p0), q1: q(p1) };
    B.Env.setClock(ev.dep - 4.6); B.Env.time.scale = 1; __m.focus(ev.key);
    B.StationCrowds.after = () => (${clearNear})(B.Env.camera.position, 1.0);       // (after the crowd moves: no one at the lens)
    return { side, cars: ev.cars, cell: B.Under.cellAt(p0.x, p0.y, p0.z) }; }`,
  before: `(t) => { const C = __cine, s = window.__s, k = C.ease(t / ${DUR}); C.put(C.mix(s.p0, s.p1, k), C.mix(s.q0, s.q1, k)); }`,
  cam: `(t, cam) => { const C = __cine, s = window.__s, k = C.ease(t / ${DUR}), p = C.mix(s.p0, s.p1, k); C.aim(cam, p, C.mix(s.q0, s.q1, k), 37.8, 0); }`,
};
