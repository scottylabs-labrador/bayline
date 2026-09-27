// P22, night: a drone chase along the Fremont line's aerial between San Leandro and Bay Fair at line speed (60 mph),
// low off the lead car's left side (over the frontage road, not the warehouse roofs), pacing it and slowly falling back
// along the lit windows, looking ahead up the
// guideway into the East Bay's grid of lights. A deliberate 1.5 degree roll. 120 fps (the edit averages 4).
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const S = 15500, FOV = 46;
export default {
  hash: '#auto&t=21:25&q=ultra&w=clear', warm: 45, frames: 390, fps: 120,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 21 * 3600 + 25 * 60); const N = B.MetroSim.net, F = {};
    N.frame(N.byId['A1.1'], ${S}, F); C.put({ x: F.x + F.rx * 16, y: F.y + 10, z: F.z + F.rz * 16 }, { x: F.x - F.tx * 60, y: F.y, z: F.z - F.tz * 60 });
    window.__dep = M.pass({ track: 'A1.1', s: ${S} }, { heading: 131, minV: 22 }, 21 * 3600 + 28 * 60, 1.2, { focus: true });
    return window.__dep; }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(window.__dep.t); B.MetroSim.setFocus(window.__dep.key); return window.__dep.line + ' to ' + window.__dep.dest + ' ' + window.__dep.v + ' m/s'; }`,
  before: `(t) => { const B = window.__bayline, M = window.__m, C = __cine; B.Env.camera.fov = ${FOV}; B.MetroSim.setFocus(window.__dep.key);
    const P = M.pose(window.__dep.key, 0); if (P) C.put(M.rel(P, -4, -11, 7), M.rel(P, 120, -2, -2)); }`,
  // the drone: low off the lead car's left side, pacing it and slowly falling back along the train, looking ahead up
  // the guideway into the East Bay's lights; the lit windows stream past in the foreground; a 1.5 degree roll
  cam: `(t, cam) => { const C = __cine, M = window.__m, P = M.pose(window.__dep.key, 0); if (!P) return; const k = C.ease(t / 3.3);
    C.aim(cam, M.rel(P, -3 - 14 * k, -10.5 + 1.5 * k, 7.2 - 0.8 * k), M.rel(P, 140, -1.5, -3), ${FOV}, -0.026); }`,
};
