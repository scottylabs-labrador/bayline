// P24, night: over the West Oakland aerial where it comes down into the Oakland Wye: the guideway runs ahead and splits,
// one pair of tracks for Richmond/Concord and one for Lake Merritt/Fremont, each dropping into its trench and portal,
// with downtown Oakland's lit towers beyond. A drone 16 m over the guideway, 50 mm, looking straight down the
// line; two trains pass each other 270 m ahead (the timetable's meeting point there), headlights and lit windows, one
// coming at us, one heading into the split (it comes from under us first). A slow eased push.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const FOV = 28, BACK = 270, SIDE = 4, H = 18;
export default {
  hash: '#auto&t=21:50&q=ultra&w=clear', warm: 50, frames: 120,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 21 * 3600 + 50 * 60);
    let X = M.crossings('M2', 35050, 35400, 21 * 3600 + 52 * 60, 23 * 3600, { step: 30, gap: 6 })[0];
    if (!X) X = M.crossings('M2', 35050, 35400, 19 * 3600 + 40 * 60, 21 * 3600, { step: 30, gap: 5 })[0]; if (!X) return 'no crossing';
    const N = B.MetroSim.net, F = {}, T = N.byId['M2']; N.frame(T, X.s - ${BACK}, F);
    const c0 = { x: F.x + F.rx * ${SIDE}, y: F.y + ${H}, z: F.z + F.rz * ${SIDE} }; N.frame(T, X.s - ${BACK} + 8, F); const c1 = { x: F.x + F.rx * ${SIDE}, y: F.y + ${H} - 1, z: F.z + F.rz * ${SIDE} };
    // the look: past the split (the embankment end) toward downtown, a little down
    // the look: straight down the guideway at the meeting point (the split just beyond it), a little down
    N.frame(T, X.s + 60, F); const a0 = Math.atan2(F.x - c0.x, -(F.z - c0.z)) - 10 * Math.PI / 180, dl = Math.hypot(F.x - c0.x, F.z - c0.z);   // (10 degrees left: the guideway up the middle)
    const q = { x: c0.x + Math.sin(a0) * 600, y: F.y + 1 - (c0.y - F.y) * 600 / dl * 0.55, z: c0.z - Math.cos(a0) * 600 };
    window.__P = { c0, c1, q }; C.put(c0, q); window.__X = X; window.__dep = { t: X.t - 2.2 };
    return JSON.stringify(X); }`,
  prime: `() => { window.__bayline.Env.setClock(window.__dep.t); __cine.put(window.__P.c0, window.__P.q); return window.__X.a.line + ' / ' + window.__X.b.line + ' at s ' + window.__X.s; }`,
  before: `(t) => { window.__bayline.Env.camera.fov = ${FOV}; }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 4), p = C.mix(P.c0, P.c1, k); C.put(p, P.q); C.aim(cam, p, P.q, ${FOV}, 0); }`,
};
