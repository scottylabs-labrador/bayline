// P11, golden hour, low and long: the airport connector's guideway runs across the frame against the setting sun,
// the Bay's glitter and the Peninsula hills behind it, and the little three-car cable train glides along the beam in
// silhouette with a rim of light. 135 mm from 300 m east-northeast of the line near the airport, 9 m up (just over the
// parking lot's cars), looking straight into the low sun; a slow drift along the line.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const S = 300, D = 300, H = 9, AZ = 264, FOV = 8.6, PITCH = 0.25;
export default {
  hash: '#auto&t=18:40&q=ultra&w=clear', warm: 55, frames: 210,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 18 * 3600 + 40 * 60); const N = B.MetroSim.net, F = {}, T = N.byId['H-main.1'];
    N.frame(T, ${S}, F); const a = ${AZ} * Math.PI / 180, c0 = { x: F.x - Math.sin(a) * ${D}, z: F.z + Math.cos(a) * ${D} }; c0.y = C.ground(c0.x, c0.z) + ${H};
    const q = { x: c0.x + Math.sin(a) * 1000, y: c0.y + Math.tan(${PITCH} * Math.PI / 180) * 1000, z: c0.z - Math.cos(a) * 1000 };
    // the drift: 8 m along the line's direction (so the beam slides a little against the far hills)
    window.__P = { c0, c1: { x: c0.x + F.tx * 8, y: c0.y, z: c0.z + F.tz * 8 }, q, q1: { x: q.x + F.tx * 8, y: q.y, z: q.z + F.tz * 8 } };
    C.put(c0, q);
    window.__dep = M.pass({ track: 'H-main.1', s: ${S} }, { kind: 'apm' }, 18 * 3600 + 43 * 60, 3.5, { focus: true });
    return window.__dep; }`,
  prime: `() => { const B = window.__bayline; __cine.put(window.__P.c0, window.__P.q); B.Env.setClock(window.__dep.t); B.MetroSim.setFocus(window.__dep.key); return window.__dep.dest + ' ' + window.__dep.v + ' m/s'; }`,
  before: `(t) => { const B = window.__bayline; B.Env.camera.fov = ${FOV}; B.MetroSim.setFocus(window.__dep.key); }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 7); const p = C.mix(P.c0, P.c1, k), q = C.mix(P.q, P.q1, k); C.put(p, q); C.aim(cam, p, q, ${FOV}, 0); }`,
};
