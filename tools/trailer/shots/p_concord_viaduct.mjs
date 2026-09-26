// P08, golden hour (18:35, the sun 5 degrees up): two metro trains meet on the Concord aerial at the station's north
// end, Mt Diablo filling the sky behind them. A drone 1.4 km to the northwest, 70 m up (over the trees), on the line
// from the mountain through the viaduct, 120 mm: the long lens stacks the 1,170 m summit (15 km away) right over the
// guideway; the low sun from behind-right lights both. A slow lateral drift gives a touch of parallax.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const S = 30000, D = 1400, H = 70, FOV = 9.65, AIM_UP = 0.9;
export default {
  hash: '#auto&t=18:28&q=ultra&w=clear', warm: 55, frames: 315,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 18 * 3600 + 28 * 60); const N = B.MetroSim.net, F = {};
    N.frame(N.byId['C1'], ${S}, F); const dia = C.ll(37.8816, -121.9142, 0);
    const ux = dia.x - F.x, uz = dia.z - F.z, ul = Math.hypot(ux, uz), bx = -ux / ul, bz = -uz / ul;     // (from the viaduct away from the mountain)
    const c = { x: F.x + bx * ${D}, z: F.z + bz * ${D} }; c.y = C.ground(c.x, c.z) + ${H};
    const px = -bz, pz = bx;                                                                          // (perpendicular: the drift)
    const q = { x: F.x - bx * 1000, z: F.z - bz * 1000 }; const dist = Math.hypot(q.x - c.x, q.z - c.z); q.y = c.y + Math.tan(${AIM_UP} * Math.PI / 180) * dist;
    window.__P = { c0: { x: c.x - px * 14, y: c.y, z: c.z - pz * 14 }, c1: { x: c.x + px * 14, y: c.y + 2, z: c.z + pz * 14 }, q0: { x: q.x - px * 14, y: q.y, z: q.z - pz * 14 }, q1: { x: q.x + px * 14, y: q.y + 2, z: q.z + pz * 14 } };
    C.put(window.__P.c0, window.__P.q0);
    // two trains meeting at the station's north end at 18:35 (the timetable's crossing there), the sun five degrees up
    const X = M.crossings('C1', ${S} - 150, ${S} + 150, 18 * 3600 + 30 * 60, 19 * 3600, { step: 50, gap: 6 })[0];
    window.__dep = X ? { t: X.t - 5.5, key: X.a.key, line: X.a.line, dest: X.a.dest, v: X.a.v, b: X.b } : M.pass({ track: 'C1', s: ${S} }, {}, 18 * 3600 + 30 * 60, 5.5, { focus: true });
    return window.__dep; }`,
  prime: `() => { const P = window.__P, B = window.__bayline; __cine.put(P.c0, P.q0); B.Env.setClock(window.__dep.t); B.MetroSim.setFocus(window.__dep.key); return window.__dep.line + ' to ' + window.__dep.dest + ' ' + window.__dep.v + ' m/s'; }`,
  before: `(t) => { const B = window.__bayline; B.Env.camera.fov = ${FOV}; B.MetroSim.setFocus(window.__dep.key); }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 10.5); const p = C.mix(P.c0, P.c1, k), q = C.mix(P.q0, P.q1, k);
    C.put(p, q); C.aim(cam, p, q, ${FOV}, 0); }`,
};
