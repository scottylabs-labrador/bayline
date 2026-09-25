// an F-16 at 520 kt, 40 m over the Bay: the camera rides off its right wing, the water streaming past, then drops back
// as it lights the afterburner and pulls away
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=17:40&q=ultraplus!&w=clear&flyat=f16,37.6400,-122.2800,40,320,520,0,0', warm: 40, frames: 240, fps: 60,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, C = __cine, w = C.ll(37.6400, -122.2800, 40), h = 320 * Math.PI / 180; B.Env.setClock(17 * 3600 + 40 * 60);
    F.ac.place({ x: w.x, y: 40, z: w.z, hdg: h, pitch: 1 * Math.PI / 180, fpa: 0, speed: 520 * 0.5144, gear: 0, flaps: 0, thr: 0.95 }); F.fcs.airStart(0);
    Object.assign(F.fcs.ap, { on: true, alt: 40, hdg: h, athr: false }); return 1; }`,
  before: `(t) => { window.__bayline.Flight.ac.ctl.thr = t > 1.6 ? 1.1 : 0.95; }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(), k = C.ease((t - 1.2) / 2.5);
    C.aim(cam, C.rel(P, -9 - 40 * k, 13 + 4 * k, 2.5 + 2 * k), C.rel(P, 6 - 4 * k, 0, 0), 48 - 6 * k, 0); }`,
};
