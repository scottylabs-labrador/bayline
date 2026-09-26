// P24, night: over the West Oakland aerial where it comes down into the Oakland Wye: the guideway runs ahead and splits,
// one pair of tracks for Richmond/Concord and one for Lake Merritt/Fremont, each dropping into its trench and portal,
// with downtown Oakland's lit towers beyond. A drone 22 m over the guideway's south edge, 40 mm, looking down the
// line; two trains pass each other right ahead (the timetable's meeting point there), headlights and lit windows, one
// coming at us, one heading into the split. A slow eased push.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const FOV = 34, BACK = 190, SIDE = 13, H = 22;
export default {
  hash: '#auto&t=21:50&q=ultra&w=clear', warm: 50, frames: 120,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 21 * 3600 + 50 * 60);
    let X = M.crossings('M2', 35050, 35400, 21 * 3600 + 52 * 60, 23 * 3600, { step: 30, gap: 6 })[0];
    if (!X) X = M.crossings('M2', 35050, 35400, 19 * 3600 + 40 * 60, 21 * 3600, { step: 30, gap: 5 })[0]; if (!X) return 'no crossing';
    const N = B.MetroSim.net, F = {}, T = N.byId['M2']; N.frame(T, X.s - ${BACK}, F);
    const c0 = { x: F.x + F.rx * ${SIDE}, y: F.y + ${H}, z: F.z + F.rz * ${SIDE} }; N.frame(T, X.s - ${BACK} + 8, F); const c1 = { x: F.x + F.rx * ${SIDE}, y: F.y + ${H} - 1, z: F.z + F.rz * ${SIDE} };
    // the look: past the split (the embankment end) toward downtown, a little down
    const sp = C.ll(37.79949, -122.27981, 0), dx = sp.x - c0.x, dz = sp.z - c0.z, dl = Math.hypot(dx, dz), q = { x: c0.x + dx / dl * 600, y: C.ground(sp.x, sp.z) - 18, z: c0.z + dz / dl * 600 };
    window.__P = { c0, c1, q }; C.put(c0, q); window.__X = X; window.__dep = { t: X.t - 1.6 };
    return JSON.stringify(X); }`,
  prime: `() => { window.__bayline.Env.setClock(window.__dep.t); __cine.put(window.__P.c0, window.__P.q); return window.__X.a.line + ' / ' + window.__X.b.line + ' at s ' + window.__X.s; }`,
  before: `(t) => { window.__bayline.Env.camera.fov = ${FOV}; }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 4), p = C.mix(P.c0, P.c1, k); C.put(p, P.q); C.aim(cam, p, P.q, ${FOV}, 0); }`,
};
