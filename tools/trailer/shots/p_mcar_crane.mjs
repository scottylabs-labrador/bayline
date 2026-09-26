// P06, late morning at MacArthur, the station in the freeway median: the camera starts at eye level on the west island
// platform, looking north along it, eases to the platform's end and cranes up to 60 m past the canopy, revealing the
// freeway lanes on both sides, trains both ways in the median and the Berkeley/Oakland hills beyond. The title BAYLINE sits over the
// first half (calm centre: the platform's vanishing point and the hills). Trains: a northbound and a southbound in the
// median ahead when the crane is near the top (__m.meet 400 m up the line, their passages < 20 s apart).
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
export default {
  hash: '#auto&t=10:55&q=ultra&w=clear', warm: 50, frames: 375,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline;
    await M.day('2026-09-29', 10 * 3600 + 55 * 60); const N = B.MetroSim.net, F = {};
    N.frame(N.byId['K1'], 161, F); const yP = 35.49, nx = -F.tx, nz = -F.tz;          // (K1 runs south: north is -t; the island's centre 6.15 m right of K1)
    const A = { x: F.x + F.rx * 6.15, z: F.z + F.rz * 6.15 };
    const P = (d, h, lat = 0) => ({ x: A.x + nx * d + F.rx * lat, y: yP + h, z: A.z + nz * d + F.rz * lat });
    window.__P = { P }; __cine.put(P(52, 1.7), P(300, 2.2));
    // trains both ways: two trains passing each other within 150 m of the platform's middle, about halfway up the crane
    // a northbound and a southbound past the same point 400 m up the median less than 20 s apart: both in view ahead
    // when the crane is high (the midpoint of their passages 9.4 s in)
    const X = M.meet({ track: 'K3.2', s: 1150 }, { heading: 9, tol: 40 }, { heading: 189, tol: 40 }, 10 * 3600 + 58 * 60, 9.4, { gap: 20, mid: true, within: 3 * 3600 });
    if (!X) return 'no meeting'; window.__dep = X;
    return window.__dep; }`,
  prime: `() => { const P = window.__P.P; __cine.put(P(52, 1.7), P(300, 2.2)); window.__bayline.Env.setClock(window.__dep.t); return window.__dep.a.line + ' / ' + window.__dep.b.line + ' gap ' + window.__dep.gap; }`,
  before: `(t) => { window.__bayline.Env.camera.fov = 37; }`,
  // the move: a slow dolly north along the platform to its end, then the crane up 58 m while easing on past the canopy's
  // north end (so its roof stays behind and below the frame); the look from level along the platform to the median
  // running north to the hills
  cam: `(t, cam) => { const C = __cine, P = window.__P.P, e = C.ease(Math.max(0, (t - 0.4) / 11.6));
    const cp = [P(52, 1.7), P(84, 1.8), P(110, 3.5), P(126, 24), P(146, 58)], qp = [P(300, 2.2), P(330, 2.4), P(390, 1.5), P(560, -9), P(930, -15)];
    const p = C.spline(cp, e), q = C.spline(qp, e); C.put(p, q); C.aim(cam, p, q, 37, 0); }`,
};
