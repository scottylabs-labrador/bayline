// P13, golden hour: the Antioch shuttle (the two-unit diesel) comes down the freeway median out of the setting sun,
// its headlights on, traffic streaming both ways beside it, the median tracks and the palms converging to the glowing
// horizon. A drone 13 m over the eastbound lanes' inside edge, 100 mm, looking west along the line: tele compression
// stacks the lanes and the light; a slow drift down toward the approaching train.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const S = 8750, SIDE = 8, H = 13, FOV = 11.6, PITCH = -2.2;
export default {
  hash: '#auto&t=18:30&q=ultra&w=clear', warm: 50, frames: 210,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 18 * 3600 + 30 * 60); const N = B.MetroSim.net, F = {}, T = N.byId['E1'];
    N.frame(T, ${S}, F); const c0 = { x: F.x + F.rx * ${SIDE}, z: F.z + F.rz * ${SIDE} }; c0.y = C.ground(c0.x, c0.z) + ${H};
    const hd = Math.atan2(-F.tx, F.tz), q = { x: c0.x + Math.sin(hd) * 1000, z: c0.z - Math.cos(hd) * 1000 }; q.y = c0.y + Math.tan(${PITCH} * Math.PI / 180) * 1000;
    window.__P = { c0, c1: { x: c0.x, y: c0.y - 1.5, z: c0.z }, q };
    C.put(c0, q);
    // the eastbound train (to Antioch) reaches 260 m short of the camera 5 s into the shot: it comes from ~390 m to ~200 m
    window.__dep = M.pass({ track: 'E1', s: ${S} - 260 }, { kind: 'dmu', heading: 100, tol: 50 }, 18 * 3600 + 33 * 60, 5.0, { focus: true });
    return window.__dep; }`,
  prime: `() => { const B = window.__bayline; __cine.put(window.__P.c0, window.__P.q); B.Env.setClock(window.__dep.t); B.MetroSim.setFocus(window.__dep.key); return window.__dep.line + ' to ' + window.__dep.dest + ' ' + window.__dep.v + ' m/s'; }`,
  before: `(t) => { const B = window.__bayline; B.Env.camera.fov = ${FOV}; B.MetroSim.setFocus(window.__dep.key); }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 7); const p = C.mix(P.c0, P.c1, k); C.put(p, P.q); C.aim(cam, p, P.q, ${FOV}, 0); }`,
};
