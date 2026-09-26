// P11, golden hour: the airport connector's cable train glides along its guideway over Hegenberger Road. From the
// west-northwest, 12 m up and 230 m off, 85 mm, square to the guideway: the low sun behind us lights the car sides and
// the East Oakland flats with the hills beyond; an eased pan keeps the little three-car train a third in from the right.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const S = 2080, OFF = 230, FOV = 13.6;
export default {
  hash: '#auto&t=18:20&q=ultra&w=clear', warm: 50, frames: 195,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 18 * 3600 + 20 * 60); const N = B.MetroSim.net, F = {}, T = N.byId['H-main.2'];
    N.frame(T, ${S}, F); const side = F.rx < 0 ? 1 : -1;                              // (the camera on the guideway's west side: sun behind us)
    const c = { x: F.x + F.rx * ${OFF} * side, z: F.z + F.rz * ${OFF} * side }; c.y = Math.max(F.y + 2, C.ground(c.x, c.z) + 12);
    window.__P = { c, g: { x: F.x, y: F.y + 2.6, z: F.z }, T };
    C.put(c, window.__P.g);
    window.__dep = M.pass({ track: 'H-main.2', s: ${S} }, { kind: 'apm' }, 18 * 3600 + 24 * 60, 3.4, { focus: true });
    return window.__dep; }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(window.__dep.t); B.MetroSim.setFocus(window.__dep.key); return window.__dep.dest + ' ' + window.__dep.v + ' m/s'; }`,
  before: `(t) => { const B = window.__bayline; B.Env.camera.fov = ${FOV}; B.MetroSim.setFocus(window.__dep.key); }`,
  // the pan: aim at a point that trails the train's middle car toward the frame's right third (lead room ahead)
  cam: `(t, cam) => { const C = __cine, M = window.__m, P = window.__P, po = M.pose(window.__dep.key, 1); let q = P.g;
    if (po) { const k = C.ease(Math.min(1, t / 1.2)); q = { x: po.rail.x + po.fwd.x * 9, y: po.rail.y + 2.4, z: po.rail.z + po.fwd.z * 9 }; q = C.mix(P.g, q, k); window.__lastQ = q; }
    else if (window.__lastQ) q = window.__lastQ;
    C.put(P.c, q); C.aim(cam, P.c, q, ${FOV}, 0); }`,
};
