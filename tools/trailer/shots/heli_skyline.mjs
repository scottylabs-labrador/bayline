// the H125 at golden hour over the Bay off the Embarcadero, heading for the backlit skyline; the camera trails low
// behind its left shoulder and slowly falls back
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=18:30&q=ultraplus!&w=clear&flyat=h125,37.8050,-122.3900,170,205,85,0,1', warm: 45, frames: 240,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, C = __cine, w = C.ll(37.8050, -122.3900, 170), h = 205 * Math.PI / 180; B.Env.setClock(18 * 3600 + 30 * 60);
    F.ac.place({ x: w.x, y: 170, z: w.z, hdg: h, pitch: -4 * Math.PI / 180, fpa: 0, speed: 85 * 0.5144, gear: 1, flaps: 0, thr: 1 }); F.fcs.airStart(0); F.heliAirStart();
    Object.assign(F.fcs.ap, { on: true, alt: 170, hdg: h, spd: 85, holdFn: null, nav: null }); F.fcs.att = null; return 1; }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(), k = C.ease(t / 8);
    C.aim(cam, C.rel(P, -22 - 16 * k, -13 + 4 * k, 2 + 5 * k), C.mix(C.rel(P, 0, 0, 0), C.rel(P, 140, 0, -35), 0.35), 42, 0); }`,
};
