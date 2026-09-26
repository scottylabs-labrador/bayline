// P06, late morning at MacArthur, the station in the freeway median: the crane starts at eye level at the south end of
// the west island platform, looking up the tracks, and rises and pulls back to 60 m, revealing the freeway lanes on
// both sides, trains both ways in the median and the Berkeley/Oakland hills beyond. The title BAYLINE sits over the
// first half (calm centre: the platform's vanishing point and the hills). Trains: two passing each other at the
// station (__m.crossings), about halfway up the crane.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
export default {
  hash: '#auto&t=10:55&q=ultra&w=clear', warm: 50, frames: 375,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline;
    await M.day('2026-09-29', 10 * 3600 + 55 * 60); const N = B.MetroSim.net, F = {};
    N.frame(N.byId['K1'], 161, F); const yP = 35.49, nx = -F.tx, nz = -F.tz;          // (K1 runs south: north is -t; the island's centre 6.15 m right of K1)
    const A = { x: F.x + F.rx * 6.15, z: F.z + F.rz * 6.15 };
    const P = (d, h, lat = 0) => ({ x: A.x + nx * d + F.rx * lat, y: yP + h, z: A.z + nz * d + F.rz * lat });
    window.__P = { P }; __cine.put(P(-98, 1.7), P(160, 2.2));
    // trains both ways: two trains passing each other within 150 m of the platform's middle, about halfway up the crane
    const X = M.crossings('K1', 20, 320, 11 * 3600, 11.75 * 3600, { step: 50, gap: 8 })[0]; if (!X) return 'no crossing';
    window.__dep = { t: X.t - 6.8, a: X.a, b: X.b, gap: X.gap, s: X.s };
    return window.__dep; }`,
  prime: `() => { const P = window.__P.P; __cine.put(P(-98, 1.7), P(160, 2.2)); window.__bayline.Env.setClock(window.__dep.t); return window.__dep.a.line + ' / ' + window.__dep.b.line + ' gap ' + window.__dep.gap; }`,
  before: `(t) => { window.__bayline.Env.camera.fov = 37; }`,
  // the crane: up 60 m and back 52 m, eased; the look tilts from level along the platform to 6 degrees down over the median
  cam: `(t, cam) => { const C = __cine, P = window.__P.P, e = C.ease(Math.max(0, (t - 0.6) / 11.4));
    const p = P(-98 - 52 * e, 1.7 + 60 * e), q = P(160 + 540 * e, 2.2 - 27 * e); C.put(p, q); C.aim(cam, p, q, 37, 0); }`,
};
