// F-16 at 500 knots, 40 m over the Bay: the camera on the water, the jet blasts past (2x slow motion)
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=17:40&q=ultra&w=clear&flyat=f16,37.6150,-122.2950,60,330,520,0,0', warm: 40, frames: 240, fps: 60,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, C = __cine, w = C.ll(37.6150, -122.2950, 60), h = 330 * Math.PI / 180; B.Env.setClock(17 * 3600 + 40 * 60);
    F.ac.place({ x: w.x, y: 60, z: w.z, hdg: h, pitch: 1 * Math.PI / 180, fpa: 0, speed: 520 * 0.5144, gear: 0, flaps: 0, thr: 1.1 }); F.fcs.airStart(0); F.ac.ctl.thr = 1.1;
    Object.assign(F.fcs.ap, { on: true, alt: 60, hdg: h, athr: false });
    const d = 380; window.__camP = { x: w.x + Math.sin(h) * d + Math.cos(h) * 42, y: 30, z: w.z - Math.cos(h) * d + Math.sin(h) * 42 }; return 1; }`,
  before: `(t) => { window.__bayline.Flight.ac.ctl.thr = 1.1; }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(); C.aim(cam, window.__camP, C.add(P.p, P.fwd, 8), 38, 0); }`,
};
