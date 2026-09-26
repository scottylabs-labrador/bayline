// P24, night: the Oakland Wye from above, where the line from the Transbay Tube comes down off the West Oakland aerial
// and splits for Richmond/Concord and for Lake Merritt/Fremont, each pair dropping into its own trench and portal. Almost
// straight down from 170 m, a slow eased descent; two trains' light strings pass each other through the split.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const LAT = 37.79935, LON = -122.27905, FOV = 40;
export default {
  hash: '#auto&t=21:50&q=ultra&w=clear', warm: 50, frames: 105,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline, C = __cine;
    await M.day('2026-09-29', 21 * 3600 + 50 * 60);
    const g = C.ll(${LAT}, ${LON}, 0), gy = C.ground(g.x, g.z), T = M.track({ lat: 37.79949, lon: -122.27981 });
    // the frame's long side along the tracks (they run west-northwest to east-southeast here): 'up' in the frame is
    // square to them, so the lines cross the wide frame left to right
    const ux = -T.tz, uz = T.tx;
    window.__P = { c0: { x: g.x - ux * 12, y: gy + 175, z: g.z - uz * 12 }, c1: { x: g.x - ux * 6, y: gy + 150, z: g.z - uz * 6 }, g: { x: g.x, y: gy, z: g.z }, ux, uz };
    C.put(window.__P.c0, window.__P.g);
    window.__dep = M.meet({ lat: 37.79949, lon: -122.27981 }, { heading: 121, tol: 50 }, { heading: 301, tol: 50 }, 21 * 3600 + 52 * 60, 1.8, { gap: 7, mid: true });
    return window.__dep; }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(window.__dep.t); return window.__dep.a.line + ' / ' + window.__dep.b.line + ' gap ' + window.__dep.gap; }`,
  before: `(t) => { window.__bayline.Env.camera.fov = ${FOV}; }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 3.5), p = C.mix(P.c0, P.c1, k);
    // nearly straight down (the look point a few metres ahead along the tracks keeps 'up' defined), no roll
    const q = { x: P.g.x + P.ux * 3, y: P.g.y, z: P.g.z + P.uz * 3 }; C.put(p, q);
    cam.position.set(p.x, p.y, p.z); cam.up.set(P.ux, 0, P.uz); cam.lookAt(q.x, q.y, q.z); if (Math.abs(cam.fov - ${FOV}) > 1e-3) { cam.fov = ${FOV}; cam.updateProjectionMatrix(); } }`,
};
