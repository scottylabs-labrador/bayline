// P12 (promo v3, world montage, 2 bars): dusk at Warm Springs: outside the entrance rotunda on a 50 mm lens, its
// coloured art glass glowing in the blue hour, the walkway rising from it to the station, and beyond, a train running in
// under the long canopy. The camera eases two metres toward the drum.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
import { metroReady, metroStop, stationBuilt, clearLine } from './_st.mjs';
const DAY = '2026-09-29', T0 = 19 * 3600 + 24 * 60, DUR = 4.0;
export default {
  hash: '#auto&t=19:24&q=ultra&w=clear', warm: 40, frames: 120, maxDsf: 1.5,
  setup: `async () => { ${cine}; ${metro}; const B = window.__bayline; if (!await (${metroReady})()) return 'metro not ready';
    await __m.day('${DAY}', ${T0}); const st = B.MetroStations.byId.WARM;
    const ev = (${metroStop})('WARM', ${T0} + 60, {}); if (!ev) return 'no train'; window.__ev = ev;
    __cine.put({ x: st.x + 60, y: 30, z: st.z }, { x: st.x, y: 20, z: st.z }); return [ev.key, ev.sid, ev.line, Math.round(ev.arr)]; }`,
  prime: `async () => { const B = window.__bayline, ev = window.__ev, st = B.MetroStations.byId.WARM; await (${stationBuilt})('WARM');
    const R = st.res && st.res.info && st.res.info.rotunda; if (!R) return 'no rotunda';
    const [cx, cz] = R.c, [fx, fz] = R.foot, [tx, tz] = R.top; let dx = fx - tx, dz = fz - tz; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    // outside the drum, away from the station, as near 30 degrees round as a clear line of sight allows (a building,
    // a garage, stands somewhere round it); looking past it toward the station and its platform
    const g = R.gy, D0 = R.R + 33;
    const dirAt = (a) => [dx * Math.cos(a) - dz * Math.sin(a), dz * Math.cos(a) + dx * Math.sin(a)];
    const A = [0.52, 0.35, 0.7, 0.18, 0.88, 0, 1.05, -0.18, 1.25, -0.35, -0.52, 1.45].find(a => { const [ox, oz] = dirAt(a); return (${clearLine})({ x: cx + ox * (D0 + 2), z: cz + oz * (D0 + 2) }, { x: cx + ox * (R.R + 1), z: cz + oz * (R.R + 1) }); }) ?? 0.52;
    const [ox, oz] = dirAt(A), P = (d, h) => ({ x: cx + ox * d, y: g + h, z: cz + oz * d });
    window.__s = { p0: P(D0, 1.7), p1: P(D0 - 2.5, 1.75), q: { x: cx - ox * 40, y: g + 8.0, z: cz - oz * 40 } };
    // the clock: the train 6 s from its stop at the first frame
    B.Env.setClock(ev.arr - 6); B.Env.time.scale = 1; __m.focus(ev.key); return { R: +R.R.toFixed(1), g: +R.gy.toFixed(1), a: A }; }`,
  before: `(t) => { const C = __cine, s = window.__s, k = C.ease(t / ${DUR}); C.put(C.mix(s.p0, s.p1, k), s.q); }`,
  cam: `(t, cam) => { const C = __cine, s = window.__s, k = C.ease(t / ${DUR}); C.aim(cam, C.mix(s.p0, s.p1, k), s.q, 27, 0); }`,
};
