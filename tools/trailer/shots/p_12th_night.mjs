// P18 (promo v3, breakdown): 22:40, 12th St Oakland City Center's lower level on a 70 mm lens. One rider waits near the
// edge 12 m ahead, on the right third, turned toward the tunnel; the empty platform runs away on the left. The southbound
// train's headlights grow in the dark mouth and it runs in beside her. The camera holds, then eases forward half a metre.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
import { metroReady, metroStop, headAt, platSide, fp, yawOf, stationBuilt, setPeople } from './_st.mjs';
const DAY = '2026-09-29', T0 = 22 * 3600 + 40 * 60, DUR = 6.0;
export default {
  hash: '#auto&t=22:40&q=ultra&w=clear', warm: 40, frames: 180, maxDsf: 1.5,
  setup: `async () => { ${cine}; ${metro}; const B = window.__bayline; if (!await (${metroReady})()) return 'metro not ready';
    await __m.day('${DAY}', ${T0});
    const ev = (${metroStop})('12TH', ${T0}, { plat: '2' }); if (!ev) return 'no train'; window.__ev = ev;
    const F = ev.F; __cine.put((${fp})(F, -150, 0, 3), (${fp})(F, -220, 0, 2));
    return [ev.key, ev.sid, ev.line, Math.round(ev.arr)]; }`,
  prime: `async () => { const B = window.__bayline, ev = window.__ev; await (${stationBuilt})('12TH');
    const F = ev.F, side = (${platSide})(F) || 1, yF = 0.99;
    // the camera 150 m back from the stopping mark (63 m in from the tunnel end of the platform), 2.4 m in from the edge
    window.__s = { p0: (${fp})(F, -150, side * 4.2, yF + 1.5), p1: (${fp})(F, -150.5, side * 4.2, yF + 1.5),
      q: (${fp})(F, -226, side * 13, 2.4) };
    // the rider: 13 m ahead of the camera, 2.3 m from the edge, turned toward the tunnel and a little to the track
    const R = (${fp})(F, -163, side * 3.9, yF), dx = -F.tx * 0.85 - F.rx * side * 0.5, dz = -F.tz * 0.85 - F.rz * side * 0.5;
    // (as the train runs in beside him he turns from the tunnel toward the track, 3.4 to 4.6 s into the shot)
    const y0 = (${yawOf})(dx, dz), y1 = (${yawOf})(-F.tx * 0.25 - F.rx * side * 0.97, -F.tz * 0.25 - F.rz * side * 0.97);
    window.__rider = [{ x: R.x, y: R.y, z: R.z, yaw: y0, mode: 0 }]; window.__riderYaw = [y0, y0 + Math.atan2(Math.sin(y1 - y0), Math.cos(y1 - y0))];
    // the clock: the head 30 m inside the tunnel mouth (213 m back from the mark) at the first frame
    const t0 = (${headAt})(ev, 243); B.Env.setClock(t0); B.Env.time.scale = 1; __m.focus(ev.key);
    B.StationCrowds.after = () => { const k = Math.min(1, Math.max(0, (B.capture.t - 3.4) / 1.2)), e = k * k * (3 - 2 * k), Y = window.__riderYaw;
      window.__rider[0].yaw = Y[0] + (Y[1] - Y[0]) * e; (${setPeople})(window.__rider, 0); };                 // (the crowd replaced by him alone)
    // her look (an office worker, not the crowd's first draw), and a few frames so she stands still from the first one
    const PP = B.StationCrowds.people; if (PP && PP.look) PP.look(0, { kind: 'office', seed: 4242 });
    for (let i = 0; i < 24; i++) B.stepFrame(1); B.Env.setClock(t0);
    return { side, t0: Math.round(t0), arr: Math.round(ev.arr) }; }`,
  before: `(t) => { const C = __cine, s = window.__s, k = C.ease(Math.max(0, t - 2.5) / ${DUR - 2.5}); C.put(C.mix(s.p0, s.p1, k), s.q); }`,
  cam: `(t, cam) => { const C = __cine, s = window.__s, k = C.ease(Math.max(0, t - 2.5) / ${DUR - 2.5}); C.aim(cam, C.mix(s.p0, s.p1, k), s.q, 19.5, 0); }`,
};
