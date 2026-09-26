// P11, golden hour: the airport connector's cable train glides over the Nimitz freeway at the Hegenberger
// interchange, the rush-hour traffic streaming below, the East Bay hills warm in the last sun. A drone 30 m up on the
// guideway's east side, 50 mm, looking north-northwest up the line; the little three-car train crosses the lanes
// through the middle of the frame, sunlit from the left. A slow eased drift toward it.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const S = 1300, SIDE = -70, H = 30, FOV = 22.9, YAW = -4;
export default {
  hash: '#auto&t=18:28&q=ultra&w=clear', warm: 50, frames: 180,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 18 * 3600 + 28 * 60); const N = B.MetroSim.net, F = {}, T = N.byId['H-main.2'];
    N.frame(T, ${S}, F); const c0 = { x: F.x + F.rx * ${SIDE}, z: F.z + F.rz * ${SIDE} }; c0.y = C.ground(c0.x, c0.z) + ${H};
    const hd = Math.atan2(F.tx, -F.tz) + (150 + ${YAW}) * Math.PI / 180, q = { x: c0.x + Math.sin(hd) * 300, z: c0.z - Math.cos(hd) * 300 }; q.y = c0.y - Math.tan(9 * Math.PI / 180) * 300;
    window.__P = { c0, c1: { x: c0.x + Math.sin(hd) * 6, y: c0.y - 1, z: c0.z - Math.cos(hd) * 6 }, q };
    C.put(c0, q);
    window.__dep = M.pass({ track: 'H-main.2', s: ${S} - 95 }, { kind: 'apm' }, 18 * 3600 + 31 * 60, 3.6, { focus: true });
    return window.__dep; }`,
  prime: `() => { const B = window.__bayline; __cine.put(window.__P.c0, window.__P.q); B.Env.setClock(window.__dep.t); B.MetroSim.setFocus(window.__dep.key); return window.__dep.dest + ' ' + window.__dep.v + ' m/s'; }`,
  before: `(t) => { const B = window.__bayline; B.Env.camera.fov = ${FOV}; B.MetroSim.setFocus(window.__dep.key); }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 6); const p = C.mix(P.c0, P.c1, k); C.put(p, P.q); C.aim(cam, p, P.q, ${FOV}, 0); }`,
};
