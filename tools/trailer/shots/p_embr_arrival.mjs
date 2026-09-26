// P03 (promo v3, bars 5-11): 07:50 at Embarcadero, low on the island near its end on a 40 mm lens, 0.75 m in from the
// edge: a train's lights come up the platform, it glides in past the camera and stops, its side running away along the
// edge as its doors open and the morning crowd steps up to them. The camera eases forward a metre.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
import { metroReady, metroStop, platSide, fp, stationBuilt, clearNear } from './_st.mjs';
const DAY = '2026-09-29', T0 = 7 * 3600 + 50 * 60, LEAD = 9.5, DUR = 12.0;   // capture starts LEAD s before the train stops
export default {
  hash: '#auto&t=07:50&q=ultra&w=clear', warm: 40, frames: 360, maxDsf: 1.5,
  setup: `async () => { ${cine}; ${metro}; const B = window.__bayline; if (!await (${metroReady})()) return 'metro not ready';
    await __m.day('${DAY}', ${T0});
    const ev = (${metroStop})('EMBR', ${T0}, { minDwell: 20 }); if (!ev) return 'no train'; window.__ev = ev;
    // the streaming camera on the island, a little ahead of where the head stops (the station builds round it)
    const F = ev.F; __cine.put({ x: F.x + F.tx * 8, y: F.y + 2.6, z: F.z + F.tz * 8 }, { x: F.x, y: F.y + 2, z: F.z });
    return [ev.key, ev.sid, ev.line, Math.round(ev.arr)]; }`,
  prime: `async () => { const B = window.__bayline, ev = window.__ev; await (${stationBuilt})('EMBR');
    const F = ev.F, side = (${platSide})(F) || 1, e = 1.62 + 0.75;     // (the edge is 1.62 m off the rail centre)
    // on the island 12 m from its end (the head stops at the end), low (0.8 m over the floor), 0.75 m in from the
    // edge, easing a metre toward the oncoming train; looking back along the edge, the track just inside the frame
    window.__s = { p0: (${fp})(F, -12, side * e, 0.99 + 0.8), p1: (${fp})(F, -13, side * e, 0.99 + 0.85),
      q0: (${fp})(F, -70, side * 0.2, 1.8), q1: (${fp})(F, -70, side * 0.5, 1.85) };
    B.Env.setClock(ev.arr - ${LEAD}); B.Env.time.scale = 1; __m.focus(ev.key);
    B.StationCrowds.after = () => (${clearNear})(B.Env.camera.position, 3.2);       // (after the crowd moves: no one near the lens)
    return side; }`,
  before: `(t) => { const C = __cine, s = window.__s, k = C.ease(t / ${DUR}); C.put(C.mix(s.p0, s.p1, k), C.mix(s.q0, s.q1, k)); }`,
  cam: `(t, cam) => { const C = __cine, s = window.__s, k = C.ease(t / ${DUR}), p = C.mix(s.p0, s.p1, k); C.aim(cam, p, C.mix(s.q0, s.q1, k), 33.4, 0); }`,
};
