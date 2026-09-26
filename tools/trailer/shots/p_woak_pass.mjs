// P05, 07:08, the sun a degree up: two metro trains pass each other on the West Oakland aerial east of the station.
// Low in the empty lot south of the guideway, 70 mm, looking east-northeast up at the deck: the trains slide past each
// other against the sunrise sky with downtown Oakland's towers behind, the low sun raking in from the right. The
// meeting point and moment come from the timetable (__m.crossings); a slow push toward them.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const S_CAM = 34500, SIDE = 70, H = 2.5, FOV = 16.4, UP = 2.0, T_MEET = 3.8;
export default {
  hash: '#auto&t=07:02&q=ultra&w=clear', warm: 50, frames: 210,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 7 * 3600 + 2 * 60); const N = B.MetroSim.net, F = {}, T = N.byId['M2'];
    const X = M.crossings('M2', 34480, 34700, 7 * 3600 + 4 * 60, 7 * 3600 + 30 * 60, { step: 20, gap: 4 })[0]; if (!X) return 'no crossing';
    N.frame(T, ${S_CAM}, F); const c0 = { x: F.x + F.rx * ${SIDE}, z: F.z + F.rz * ${SIDE} }; c0.y = C.ground(c0.x, c0.z) + ${H};
    N.frame(T, X.s, F); const m = { x: F.x, y: F.y + 3.5, z: F.z }, d = Math.hypot(m.x - c0.x, m.z - c0.z);
    const q = { x: m.x, y: m.y + Math.tan(${UP} * Math.PI / 180) * d, z: m.z }, u = { x: (m.x - c0.x) / d, z: (m.z - c0.z) / d };
    window.__P = { c0, c1: { x: c0.x + u.x * 5, y: c0.y + 0.2, z: c0.z + u.z * 5 }, q };
    C.put(c0, q); window.__X = X; window.__dep = { t: X.t - ${T_MEET} };
    return JSON.stringify(X); }`,
  prime: `() => { __cine.put(window.__P.c0, window.__P.q); window.__bayline.Env.setClock(window.__dep.t); return window.__X.a.line + ' / ' + window.__X.b.line + ' at s ' + window.__X.s + ' gap ' + window.__X.gap; }`,
  before: `(t) => { window.__bayline.Env.camera.fov = ${FOV}; }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 7); const p = C.mix(P.c0, P.c1, k);
    C.put(p, P.q); C.aim(cam, p, P.q, ${FOV}, 0); }`,
};
