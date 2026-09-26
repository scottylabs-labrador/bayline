// P13, golden hour: the Antioch shuttle (the two-unit diesel) runs east along the freeway median toward Antioch, seen
// from the south across the traffic on a 100 mm lens, 30 m up, so the flat Delta country and the river beyond fill the
// back of the frame. The sun low in the west rakes across from the left. A slow push keeps the train crossing.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const S = 9150, OFF = 380, H = 30, FOV = 11.6;
export default {
  hash: '#auto&t=18:20&q=ultra&w=clear', warm: 50, frames: 210,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 18 * 3600 + 20 * 60); const N = B.MetroSim.net, F = {};
    N.frame(N.byId['E1'], ${S}, F);                                                   // (E1 runs east-southeast: its right side is south)
    const c0 = { x: F.x + F.rx * ${OFF}, z: F.z + F.rz * ${OFF} }; c0.y = C.ground(c0.x, c0.z) + ${H};
    const c1 = { x: F.x + F.rx * (${OFF} - 25), y: c0.y - 2, z: F.z + F.rz * (${OFF} - 25) };
    const q = { x: F.x - F.rx * 900, y: F.y + 12, z: F.z - F.rz * 900 };            // (over the train toward the river: a touch down)
    window.__P = { c0, c1, q };
    C.put(c0, window.__P.q);
    window.__dep = M.pass({ track: 'E1', s: ${S} }, { kind: 'dmu' }, 18 * 3600 + 24 * 60, 3.8, { focus: true });
    return window.__dep; }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(window.__dep.t); B.MetroSim.setFocus(window.__dep.key); return window.__dep.line + ' to ' + window.__dep.dest + ' ' + window.__dep.v + ' m/s'; }`,
  before: `(t) => { const B = window.__bayline; B.Env.camera.fov = ${FOV}; B.MetroSim.setFocus(window.__dep.key); }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 7); const p = C.mix(P.c0, P.c1, k); C.put(p, P.q); C.aim(cam, p, P.q, ${FOV}, 0); }`,
};
