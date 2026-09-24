// the H125 settles onto the top of the Golden Gate's south tower, the camera circling at golden hour
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=18:25&q=ultra&w=clear&flyat=h125,37.81401,-122.47789,262,205,0,0,1', warm: 45, frames: 270,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, C = __cine, w = C.ll(37.81401, -122.47789, 262), h = 205 * Math.PI / 180; B.Env.setClock(18 * 3600 + 25 * 60);
    F.ac.place({ x: w.x, y: 262, z: w.z, hdg: h, pitch: 0, fpa: 0, speed: 0, gear: 1, flaps: 0, thr: 1 }); F.fcs.airStart(0); F.heliAirStart();
    Object.assign(F.fcs.ap, { on: true, alt: null, spd: 0, nav: null, holdFn: () => B.Globe.ll2w(37.81401, -122.47789) }); F.fcs.att = null; return 1; }`,
  before: `(t) => { const K = window.__bayline.Flight.input.keys; if (t > 1.5) K.add('KeyS'); }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(), a = 3.9 + t * 0.09, r = 55 - t * 1.2; C.aim(cam, { x: P.p.x + Math.sin(a) * r, y: 236 + 14 - t * 0.6, z: P.p.z + Math.cos(a) * r }, { x: P.p.x, y: P.p.y - 3, z: P.p.z }, 46, 0); }`,
};
