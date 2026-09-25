// just after liftoff over the Bay: the A320 climbing away, the camera tucked in below and behind its left wing as the
// gear folds up into the bays and the doors close
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=16:10&q=ultraplus!&w=clear&flyat=a320,37.6180,-122.3780,90,298,158,2,1', warm: 45, frames: 240, fps: 60,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, C = __cine, w = C.ll(37.6180, -122.3780, 90), h = 298 * Math.PI / 180; B.Env.setClock(16 * 3600 + 10 * 60);
    F.ac.place({ x: w.x, y: 90, z: w.z, hdg: h, pitch: 9 * Math.PI / 180, fpa: 6 * Math.PI / 180, speed: 158 * 0.5144, gear: 1, flaps: 2, thr: 1 }); F.fcs.airStart(6 * Math.PI / 180);
    Object.assign(F.fcs.ap, { on: false }); F.ac.ctl.thr = 1; return 1; }`,
  before: `(t) => { const F = window.__bayline.Flight; F.ac.ctl.thr = 1; if (t > 0.6) F.ac.ctl.gear = 0; }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(), k = C.ease(t / 4); C.aim(cam, C.rel(P, -26 - 6 * k, -14, -7 + 1.5 * k), C.rel(P, 2, -1, -1.5), 40, 0); }`,
};
