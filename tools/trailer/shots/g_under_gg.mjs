// a Cessna comes in from the Pacific at golden hour and threads under the Golden Gate's main span, straight at a
// camera low on the Bay side, backlit by the sun, then roars overhead (60 fps: slow motion). (The camera stays inside
// the Bay: seen from the ocean side, the edge of the Bay terrain shows as a dark band.)
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=17:55&q=ultraplus!&w=clear&flyat=c172,37.8199,-122.4750,35,85,105,0,1', warm: 45, frames: 480, fps: 60,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, C = __cine; B.Env.setClock(17 * 3600 + 55 * 60);
    const n = C.ll(37.8255026, -122.4792332, 0), s = C.ll(37.8140144, -122.477891, 0), dx = s.x - n.x, dz = s.z - n.z, L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const M = { x: (n.x + s.x) / 2, z: (n.z + s.z) / 2 }, wx = -uz, wz = ux;           /* w: perpendicular, pointing west (out to sea) */
    const west = wx < 0 ? 1 : -1, Wx = wx * west, Wz = wz * west, h = Math.atan2(-Wx, Wz);      /* heading east, into the Bay */
    F.ac.place({ x: M.x + Wx * 260, y: 33, z: M.z + Wz * 260, hdg: h, pitch: 2 * Math.PI / 180, fpa: 0, speed: 105 * 0.5144, gear: 1, flaps: 0, thr: 0.75 }); F.fcs.airStart(0);
    Object.assign(F.fcs.ap, { on: true, alt: 33, hdg: h, athr: true, spd: 105, thrI: 0.75 });
    window.__camP = { x: M.x - Wx * 140 + ux * 22, y: 15, z: M.z - Wz * 140 + uz * 22 }; return Math.round(h * 180 / Math.PI); }`,
  before: `(t) => { const C = __cine; C.put(window.__camP, C.acPose().p); }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(); C.aim(cam, window.__camP, { x: P.p.x, y: P.p.y + 1, z: P.p.z }, 50, 0); }`,
};
