// P05, 07:05, the sun just up: two metro trains pass each other on the West Oakland aerial, seen down the line on a
// 135 mm lens from a drone 22 m over the guideway west of the station: the tracks run away between the rooftops and
// street lamps toward downtown Oakland's towers on the horizon, everything compressed into the low gold light. One
// train comes at us, one runs away toward the towers; they meet ~350 m out (the timetable's meeting point there,
// __m.crossings). A slow eased creep forward.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const S_CAM = 32900, SIDE = -2.5, H = 22, FOV = 8.6, YAW = 2, PITCH = -1.2, T_MEET = 3.4;
export default {
  hash: '#auto&t=07:00&q=ultra&w=clear', warm: 50, frames: 210,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 7 * 3600);
    const X = M.crossings('M2', ${S_CAM} + 200, ${S_CAM} + 900, 7 * 3600 + 3 * 60, 7 * 3600 + 30 * 60, { step: 25, gap: 3 })[0]; if (!X) return 'no crossing';
    const N = B.MetroSim.net, F = {}, T = N.byId['M2']; N.frame(T, ${S_CAM}, F);
    const c0 = { x: F.x + F.rx * ${SIDE}, y: F.y + ${H}, z: F.z + F.rz * ${SIDE} }, hd = Math.atan2(F.tx, -F.tz) + ${YAW} * Math.PI / 180;
    const q = { x: c0.x + Math.sin(hd) * 1000, y: c0.y + Math.tan(${PITCH} * Math.PI / 180) * 1000, z: c0.z - Math.cos(hd) * 1000 };
    window.__P = { c0, c1: { x: c0.x + Math.sin(hd) * 6, y: c0.y - 0.5, z: c0.z - Math.cos(hd) * 6 }, q };
    C.put(c0, q); window.__X = X; window.__dep = { t: X.t - ${T_MEET} };
    return JSON.stringify(X); }`,
  prime: `() => { __cine.put(window.__P.c0, window.__P.q); window.__bayline.Env.setClock(window.__dep.t); return window.__X.a.line + ' / ' + window.__X.b.line + ' at s ' + window.__X.s + ' gap ' + window.__X.gap; }`,
  before: `(t) => { window.__bayline.Env.camera.fov = ${FOV}; }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 7); const p = C.mix(P.c0, P.c1, k);
    C.put(p, P.q); C.aim(cam, p, P.q, ${FOV}, 0); }`,
};
