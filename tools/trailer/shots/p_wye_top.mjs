// P24, night: the Oakland Wye from above: the line from the Transbay Tube comes down off the West Oakland aerial and
// splits, one pair of tracks for Richmond/Concord and one for Lake Merritt/Fremont, each dropping into its own trench
// and portal. A drone 120 m up to the southwest, looking down 30 degrees at the split, 40 degrees; two trains' lit
// strings pass each other on the approach (the timetable's meeting point there). A slow eased descent toward it.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const FOV = 40, H = 120, BACK = 230, AZ = 211;
export default {
  hash: '#auto&t=21:50&q=ultra&w=clear', warm: 50, frames: 120,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 21 * 3600 + 50 * 60);
    let X = M.crossings('M2', 35100, 35430, 21 * 3600 + 52 * 60, 23 * 3600, { step: 30, gap: 6 })[0];
    if (!X) X = M.crossings('M2', 35100, 35430, 19 * 3600 + 40 * 60, 21 * 3600, { step: 30, gap: 5 })[0]; if (!X) return 'no crossing';
    const sp = C.ll(37.79949, -122.27981, 0), g = C.ground(sp.x, sp.z), a = ${AZ} * Math.PI / 180;
    // the look point: between the meeting point and the split; the drone back along the south-southwest, looking down 30 degrees
    const N = B.MetroSim.net, F = {}; N.frame(N.byId['M2'], X.s, F); const q = { x: (sp.x + F.x) / 2 + 40 * Math.sin(121 * Math.PI / 180), y: g + 6, z: (sp.z + F.z) / 2 - 40 * Math.cos(121 * Math.PI / 180) };
    const c0 = { x: q.x + Math.sin(a) * ${BACK}, y: g + ${H}, z: q.z - Math.cos(a) * ${BACK} }, c1 = { x: q.x + Math.sin(a) * (${BACK} - 25), y: g + ${H} - 14, z: q.z - Math.cos(a) * (${BACK} - 25) };
    window.__P = { c0, c1, q }; C.put(c0, q); window.__X = X; window.__dep = { t: X.t - 2.4 };
    return JSON.stringify(X); }`,
  prime: `() => { window.__bayline.Env.setClock(window.__dep.t); __cine.put(window.__P.c0, window.__P.q); return window.__X.a.line + ' / ' + window.__X.b.line + ' at s ' + window.__X.s; }`,
  before: `(t) => { window.__bayline.Env.camera.fov = ${FOV}; }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 4), p = C.mix(P.c0, P.c1, k); C.put(p, P.q); C.aim(cam, p, P.q, ${FOV}, 0); }`,
};
