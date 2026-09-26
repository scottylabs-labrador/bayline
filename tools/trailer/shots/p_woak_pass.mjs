// P05, 07:08, the sun a degree up: two metro trains pass each other on the West Oakland aerial east of the station,
// seen from the west-southwest on a 120 mm lens, so the Lake Merritt and downtown Oakland towers stack up behind the
// guideway; the low sun rakes in from the right. Timed by timetable: the meeting point and moment come from
// __m.crossings (the timetable is periodic: trains always pass each other at the same spots).
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const AZ = 72, DIST = 640, H = 58, FOV0 = 9.65, FOV1 = 9.2, T_MEET = 3.6;
export default {
  hash: '#auto&t=07:02&q=ultra&w=clear', warm: 50, frames: 210,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 7 * 3600 + 2 * 60);
    const X = M.crossings('M2', 34350, 34850, 7 * 3600 + 5 * 60, 7 * 3600 + 25 * 60, { step: 40, gap: 4 })[0]; if (!X) return 'no crossing';
    const N = B.MetroSim.net, F = {}; N.frame(N.byId['M2'], X.s, F); const a = ${AZ} * Math.PI / 180;
    // a drone high enough to clear the warehouses in between; the aim a little over the trains so the towers fit above them
    const c = { x: F.x - Math.sin(a) * ${DIST}, z: F.z + Math.cos(a) * ${DIST} }; c.y = C.ground(c.x, c.z) + ${H};
    const q = { x: F.x, y: F.y + 3 + (c.y - F.y - 3) * 0.42, z: F.z };
    const side = { x: Math.cos(a), z: Math.sin(a) };     // (square to the view: the slow drift)
    window.__P = { q, c0: { x: c.x - side.x * 5, y: c.y, z: c.z - side.z * 5 }, c1: { x: c.x + side.x * 5, y: c.y + 1, z: c.z + side.z * 5 } };
    C.put(window.__P.c0, q); window.__X = X; window.__dep = { t: X.t - ${T_MEET} };
    return JSON.stringify(X); }`,
  prime: `() => { __cine.put(window.__P.c0, window.__P.q); window.__bayline.Env.setClock(window.__dep.t); return window.__X.a.line + ' / ' + window.__X.b.line + ' at s ' + window.__X.s; }`,
  before: `(t) => { window.__bayline.Env.camera.fov = ${FOV0}; }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 7); const p = C.mix(P.c0, P.c1, k);
    C.put(p, P.q); C.aim(cam, p, P.q, ${FOV0} + (${FOV1} - ${FOV0}) * k, 0); }`,
};
