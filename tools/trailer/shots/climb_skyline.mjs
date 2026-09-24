// climbing out of SFO northbound at sunset, the San Francisco skyline ahead
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=18:50&q=ultra&w=clear&flyat=a320,37.6420,-122.3650,420,15,190,1,0', warm: 45, frames: 240,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, C = __cine, w = C.ll(37.6420, -122.3650, 420); B.Env.setClock(18 * 3600 + 50 * 60);
    F.ac.place({ x: w.x, y: 420, z: w.z, hdg: 12 * Math.PI / 180, pitch: 9 * Math.PI / 180, fpa: 6 * Math.PI / 180, speed: 185 * 0.5144, gear: 0, flaps: 1, thr: 0.95 }); F.fcs.airStart(6 * Math.PI / 180);
    Object.assign(F.fcs.ap, { on: true, alt: 1500, hdg: 12 * Math.PI / 180, vs: 9, athr: true, spd: 200, thrI: 0.9 }); return 1; }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(), k = C.ease(t / 8); C.aim(cam, C.rel(P, -70 + 30 * k, 26 - 8 * k, -12 + 4 * k), C.rel(P, 40, 0, 4), 44, 0); }`,
};
