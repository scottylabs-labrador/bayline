// A320 touchdown on SFO 28R at sunset: tyre smoke, 2x slow motion, the camera low beside the touchdown zone
import { cine, flyReady, rwy } from './_lib.mjs';
export default {
  hash: '#auto&t=18:55&q=ultra&w=clear&fly=a320,KSFO,28R,final', warm: 45, frames: 480, fps: 60,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, e = (${rwy})('KSFO', '28R'), D = Math.PI / 180; B.Env.setClock(18 * 3600 + 55 * 60);
    const d = 360, x = e.x - e.ux * (d - 300), z = e.z - e.uz * (d - 300), y = e.elev + Math.tan(3 * D) * d + F.type.fdm.cgHeight;
    F.ac.place({ x, y, z, hdg: e.hdg * D, pitch: 1.5 * D, fpa: -3 * D, speed: F.cfg.vapp * 0.5144, gear: 1, flaps: F.type.fdm.flaps.length - 1, thr: 0.45 }); F.fcs.airStart(-3 * D);
    F.armApproach(); Object.assign(F.fcs.ap, { gs: true, loc: true }); F.fcs.autoBrake = 0.45;
    const u = 420; window.__camP = { x: e.x + e.ux * u + e.uz * 58, y: e.elev + 1.3, z: e.z + e.uz * u - e.ux * 58 }; return 1; }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(); C.aim(cam, window.__camP, C.add(P.p, P.fwd, 4), 30, 0); }`,
};
