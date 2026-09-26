// P06, late morning at MacArthur, the station in the freeway median: the camera starts at eye level on the west island
// platform, looking north along it, eases to the platform's end and cranes up to 60 m past the canopy, revealing the
// freeway lanes on both sides, trains both ways in the median and the Berkeley/Oakland hills beyond. The title BAYLINE sits over the
// first half (calm centre: the platform's vanishing point and the hills). Trains: a northbound and a southbound both in
// the stretch 300-750 m up the median when the crane is near the top (from their passages at both ends of it).
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
export default {
  hash: '#auto&t=10:55&q=ultra&w=clear', warm: 50, frames: 375,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline;
    await M.day('2026-09-29', 10 * 3600 + 55 * 60); const N = B.MetroSim.net, F = {};
    N.frame(N.byId['K1'], 161, F); const yP = 35.49, nx = -F.tx, nz = -F.tz;          // (K1 runs south: north is -t; the island's centre 6.15 m right of K1)
    const A = { x: F.x + F.rx * 6.15, z: F.z + F.rz * 6.15 };
    const P = (d, h, lat = 0) => ({ x: A.x + nx * d + F.rx * lat, y: yP + h, z: A.z + nz * d + F.rz * lat });
    window.__P = { P }; __cine.put(P(46, 1.7, 1.4), P(300, 2.2));
    // trains both ways: two trains passing each other within 150 m of the platform's middle, about halfway up the crane
    // trains both ways in view ahead when the crane is high: a northbound between 300 and 1,000 m up the median (running
    // away) and a southbound in the same stretch (coming at us) for at least 6 s around 9.6 s in; from the passages of
    // both directions at the two ends of the stretch (K3.2 s 1050 = 300 m, s 1500 = 750 m, then on)
    const a0 = 10 * 3600 + 55 * 60, a1 = 12 * 3600 + 30 * 60, L0 = M.passes({ track: 'K3.2', s: 1050 }, {}, a0, a1), L1 = M.passes({ track: 'K3.2', s: 1500 }, {}, a0, a1);
    const iv = (dir) => { const out = []; for (const p of L0) { if (Math.abs(((p.hdg - dir) % 360 + 540) % 360 - 180) > 40) continue; const q = L1.find(x => x.key === p.key); if (q) out.push([Math.min(p.tPass, q.tPass), Math.max(p.tPass, q.tPass), p]); } return out; };
    const Nb = iv(9), Sb = iv(189); let best = null;
    for (const n of Nb) for (const s2 of Sb) { const a = Math.max(n[0], s2[0]), b = Math.min(n[1], s2[1]); if (b - a < 6) continue; if (!best || a < best.a) best = { a, b, n: n[2], s: s2[2] }; }
    if (!best) return 'no pair in view';
    window.__dep = { t: (best.a + best.b) / 2 - 9.6, a: { line: best.n.line, dest: best.n.dest }, b: { line: best.s.line, dest: best.s.dest }, gap: +(best.b - best.a).toFixed(1) };
    return window.__dep; }`,
  prime: `() => { const P = window.__P.P; __cine.put(P(46, 1.7, 1.4), P(300, 2.2)); window.__bayline.Env.setClock(window.__dep.t); return window.__dep.a.line + ' / ' + window.__dep.b.line + ' gap ' + window.__dep.gap; }`,
  before: `(t) => { window.__bayline.Env.camera.fov = 37; }`,
  // the move: a slow dolly north along the platform to its end, then the crane up 58 m while easing on past the canopy's
  // north end (so its roof stays behind and below the frame); the look from level along the platform to the median
  // running north to the hills
  cam: `(t, cam) => { const C = __cine, P = window.__P.P, e = C.ease(Math.max(0, (t - 0.4) / 11.6));
    const cp = [P(46, 1.7, 1.4), P(80, 1.8, 1.0), P(110, 3.5, 0.4), P(126, 24), P(146, 58)], qp = [P(300, 2.2), P(330, 2.4), P(390, 1.5), P(560, -9), P(930, -15)];
    const p = C.spline(cp, e), q = C.spline(qp, e); C.put(p, q); C.aim(cam, p, q, 37, 0); }`,
};
