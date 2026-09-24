// a Cessna threads under the Golden Gate's main span, heading out to sea: the camera low on the ocean side, off its
// track, watches it emerge under the deck and whip past (60 fps: slow motion or blur)
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=17:55&q=ultra&w=clear&flyat=c172,37.8199,-122.4750,35,265,105,0,1', warm: 45, frames: 480, fps: 60,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, C = __cine; B.Env.setClock(17 * 3600 + 55 * 60);
    const n = C.ll(37.8255026, -122.4792332, 0), s = C.ll(37.8140144, -122.477891, 0), dx = s.x - n.x, dz = s.z - n.z, L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const M = { x: (n.x + s.x) / 2, z: (n.z + s.z) / 2 }, wx = -uz, wz = ux;           /* w: perpendicular, pointing west (out to sea) */
    const west = wx < 0 ? 1 : -1, Wx = wx * west, Wz = wz * west, h = Math.atan2(Wx, -Wz);
    F.ac.place({ x: M.x - Wx * 100, y: 35, z: M.z - Wz * 100, hdg: h, pitch: 2 * Math.PI / 180, fpa: 0, speed: 105 * 0.5144, gear: 1, flaps: 0, thr: 0.75 }); F.fcs.airStart(0);
    Object.assign(F.fcs.ap, { on: true, alt: 35, hdg: h, athr: true, spd: 105, thrI: 0.75 });
    window.__camP = { x: M.x + Wx * 125 + ux * 26, y: 17, z: M.z + Wz * 125 + uz * 26 }; return Math.round(h * 180 / Math.PI); }`,
  before: `(t) => { const C = __cine; C.put(window.__camP, C.acPose().p); }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(); C.aim(cam, window.__camP, { x: P.p.x, y: P.p.y + 1, z: P.p.z }, 50, 0); }`,
};
