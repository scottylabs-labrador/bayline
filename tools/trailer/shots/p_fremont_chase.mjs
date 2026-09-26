// P22, night: a drone chase along the Fremont line's aerial between San Leandro and Bay Fair at line speed, off the
// lead car's right shoulder, 9 m up, looking back along the train's lit windows and the guideway to the East Oakland
// grid of lights; the train slowly overtakes the drone. A deliberate 1.5 degree roll. 120 fps (the edit averages 4).
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const S = 15500, FOV = 44;
export default {
  hash: '#auto&t=21:25&q=ultra&w=clear', warm: 45, frames: 390, fps: 120,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 21 * 3600 + 25 * 60); const N = B.MetroSim.net, F = {};
    N.frame(N.byId['A1.1'], ${S}, F); C.put({ x: F.x + F.rx * 16, y: F.y + 10, z: F.z + F.rz * 16 }, { x: F.x - F.tx * 60, y: F.y, z: F.z - F.tz * 60 });
    window.__dep = M.pass({ track: 'A1.1', s: ${S} }, { heading: 131, minV: 22 }, 21 * 3600 + 28 * 60, 1.2, { focus: true });
    return window.__dep; }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(window.__dep.t); B.MetroSim.setFocus(window.__dep.key); return window.__dep.line + ' to ' + window.__dep.dest + ' ' + window.__dep.v + ' m/s'; }`,
  before: `(t) => { const B = window.__bayline, M = window.__m, C = __cine; B.Env.camera.fov = ${FOV}; B.MetroSim.setFocus(window.__dep.key);
    const P = M.pose(window.__dep.key, 0); if (P) C.put(M.rel(P, 14, 15, 10), M.rel(P, -40, 0, 1)); }`,
  // the drone: ahead of the lead car's nose and off its right, drifting back along the train (overtaken) and down a little
  cam: `(t, cam) => { const C = __cine, M = window.__m, P = M.pose(window.__dep.key, 0); if (!P) return; const k = C.ease(t / 3.3);
    C.aim(cam, M.rel(P, 16 - 22 * k, 15 - 2 * k, 9.5 - 1.5 * k), M.rel(P, -34 - 18 * k, -1, 1.2), ${FOV}, 0.026); }`,
};
