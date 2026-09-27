// PROMO P21: last light: the F-16 at 500 knots, 40 m over the Bay, afterburner lit, crosses the frame from left to right
// in silhouette against the western afterglow; the camera on the water east of its track, tracking it (60 fps)
import { cine, flyReady } from './_lib.mjs';
import { mDay } from './_metro.mjs';
export default {
  hash: '#auto&t=19:14&q=ultra&w=clear&flyat=f16,37.6150,-122.2950,45,330,520,0,0', warm: 40, frames: 240, fps: 60,
  setup: `async () => { ${cine}; await (${mDay})('2026-09-29'); return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, C = __cine, w = C.ll(37.6150, -122.2950, 45), h = 330 * Math.PI / 180; B.Env.setClock(19 * 3600 + 14 * 60);
    F.ac.place({ x: w.x, y: 45, z: w.z, hdg: h, pitch: 1 * Math.PI / 180, fpa: 0, speed: 520 * 0.5144, gear: 0, flaps: 0, thr: 1.1 }); F.fcs.airStart(0); F.ac.ctl.thr = 1.1;
    Object.assign(F.fcs.ap, { on: true, alt: 45, hdg: h, athr: false });
    /* the camera 170 m east of the track, 330 m ahead of the jet's start, 18 m over the water: looking west across the track */
    const d = 300, e = 105; window.__camP = { x: w.x + Math.sin(h) * d + Math.cos(h) * e, y: 18, z: w.z - Math.cos(h) * d + Math.sin(h) * e }; return 1; }`,
  before: `(t) => { const C = __cine; window.__bayline.Flight.ac.ctl.thr = 1.1; C.put(window.__camP, C.acPose().p); }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(); C.aim(cam, window.__camP, C.add(P.p, P.fwd, 4), 11, 0); }`,
};
