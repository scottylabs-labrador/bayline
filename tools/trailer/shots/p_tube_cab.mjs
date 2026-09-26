// P16, night: in the cab of an eastbound metro train deep in the Transbay Tube at full line speed, the tunnel lights
// streaming past, the desk and the train-control screen glowing in the lower third. The eye a touch right of the
// driver's seat, 50 degrees, pitched down 4 degrees (TRAINS' look: _metrolook.mjs cabLook, exposure and the screens'
// glow and reflections, when it is in the build; without it, the cab as the game draws it).
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
let cabLook = null; try { ({ cabLook } = await import('./_metrolook.mjs')); } catch (e) { /* (TRAINS' look not merged yet) */ }
const S = 27400, FOV = 50, PITCH = -4;
export default {
  hash: '#auto&t=21:35&q=ultra&w=clear', warm: 45, frames: 360,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 21 * 3600 + 35 * 60); const N = B.MetroSim.net, F = {};
    N.frame(N.byId['M2'], ${S} - 250, F); C.put({ x: F.x, y: F.y + 3, z: F.z }, { x: F.x + F.tx * 50, y: F.y + 3, z: F.z + F.tz * 50 });
    window.__dep = M.pass({ track: 'M2', s: ${S} }, { minV: 25 }, 21 * 3600 + 40 * 60, 2.0, { focus: true });
    return window.__dep; }`,
  prime: `async () => { const B = window.__bayline, d = window.__dep; B.Env.setClock(d.t); B.MetroSim.setFocus(d.key);
    for (let i = 0; i < 40 && !window.__m.cab(d.key); i++) await new Promise(r => setTimeout(r, 100));      // (the consist is posed on the next frames)
    ${cabLook ? `(${cabLook})(d.key);` : ''} return d.key + ' ' + d.line + ' to ' + d.dest + ' ' + d.v + ' m/s'; }`,
  before: `(t) => { const B = window.__bayline; B.Env.camera.fov = ${FOV}; B.MetroSim.setFocus(window.__dep.key); }`,
  cam: `(t, cam) => { const C = __cine, M = window.__m, c = M.cab(window.__dep.key, 0, 0, 0.1); if (!c) return;
    const f = c.fwd, h = Math.hypot(f.x, f.z) || 1, pt = Math.tan(${PITCH} * Math.PI / 180);
    const q = { x: c.p.x + f.x / h * 40, y: c.p.y + (f.y / h + pt) * 40, z: c.p.z + f.z / h * 40 };
    C.put(c.p, q); C.aim(cam, c.p, q, ${FOV}, 0); }`,
};
