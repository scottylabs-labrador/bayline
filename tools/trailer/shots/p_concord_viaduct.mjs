// P08, golden hour (about 18:35, the sun a few degrees up): a metro train on the Concord aerial, Mt Diablo filling
// the sky behind it. A drone on the line from the mountain through the viaduct, a kilometre out and 95-130 m up (over
// the trees), on the longest lens that fits both: the train in the lower third, the summit (1,170 m, 15 km away) near
// the top, stacked by the compression; the low sun from behind-right lights both. The spot (viaduct point, distance,
// height) is scouted for a clear line to the train (__m.scout); a slow lateral drift gives a touch of parallax.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
export default {
  hash: '#auto&t=18:30&q=ultra&w=clear', warm: 55, frames: 300,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 18 * 3600 + 30 * 60); const N = B.MetroSim.net, F = {}, T = N.byId['C1'];
    const dia = C.ll(37.8816, -121.9142, 0), sm = { x: dia.x, y: 1173, z: dia.z }, cands = [];
    for (const s of [29500, 30300, 28700]) for (const [d, h] of [[900, 95], [1100, 110], [900, 130]]) { N.frame(T, s, F);
      const ux = dia.x - F.x, uz = dia.z - F.z, ul = Math.hypot(ux, uz), c = { x: F.x - ux / ul * d, z: F.z - uz / ul * d }; c.y = C.ground(c.x, c.z) + h;
      cands.push(Object.assign(c, { s, tr: { x: F.x, y: F.y + 2.4, z: F.z }, u: { x: ux / ul, z: uz / ul } })); }
    window.__S = { cands, sm, T }; C.put(cands[0], sm);
    return cands.length; }`,
  prime: `() => { const M = window.__m, S = window.__S, B = window.__bayline, C = __cine;
    let best = null; for (const c of S.cands) { const r = M.sight(c, M.trackPts(S.T, c.s, 70, 5, 2.2)); if (!best || r.clear > best.r.clear + 0.01) best = { c, r }; if (r.clear >= 0.99) break; }
    const c = best.c, el = (P) => Math.atan2(P.y - c.y, Math.hypot(P.x - c.x, P.z - c.z)), at = el(c.tr), as = el(S.sm);
    // the lens: the span train..summit over 62% of the 2.39:1 band (which is 74% of the frame); the aim: the train 19% up the band
    const span = as - at, vf = Math.min(16.4, Math.max(8.6, span / 0.62 / 0.74 * 180 / Math.PI)), band = vf * 0.74 * Math.PI / 180, aim = at + band * (0.5 - 0.19);
    const q = { x: c.x + c.u.x * 1000, y: c.y + Math.tan(aim) * 1000, z: c.z + c.u.z * 1000 }, px = -c.u.z, pz = c.u.x, dd = 16;
    window.__P = { vf, c0: { x: c.x - px * dd, y: c.y, z: c.z - pz * dd }, c1: { x: c.x + px * dd, y: c.y + 2, z: c.z + pz * dd }, q0: { x: q.x - px * dd, y: q.y, z: q.z - pz * dd }, q1: { x: q.x + px * dd, y: q.y + 2, z: q.z + pz * dd } };
    window.__dep = M.pass({ track: 'C1', s: c.s }, {}, 18 * 3600 + 33 * 60, 4.8, { focus: true });
    C.put(window.__P.c0, window.__P.q0); B.MetroSim.setFocus(window.__dep.key);
    return 's ' + c.s + ' clear ' + best.r.clear + ' ' + JSON.stringify(best.r.hits.slice(0, 2)) + ' lens ' + vf.toFixed(1) + ' deg | ' + window.__dep.line + ' to ' + window.__dep.dest + ' ' + window.__dep.v + ' m/s'; }`,
  before: `(t) => { const B = window.__bayline; B.Env.camera.fov = window.__P.vf; B.MetroSim.setFocus(window.__dep.key); }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 10); const p = C.mix(P.c0, P.c1, k), q = C.mix(P.q0, P.q1, k);
    C.put(p, q); C.aim(cam, p, q, P.vf, 0); }`,
};
