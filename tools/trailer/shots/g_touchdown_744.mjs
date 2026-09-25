// sunset: the 747 touching down on SFO 28R, tyre smoke off the body gear, spoilers up and the reversers deploying;
// the camera low beside the touchdown zone (60 fps: slow motion)
import { cine, flyReady, rwy } from './_lib.mjs';
export default {
  hash: '#auto&t=18:58&q=ultraplus!&w=clear&fly=b744,KSFO,28R,final', warm: 50, frames: 480, fps: 60,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, e = (${rwy})('KSFO', '28R'), D = Math.PI / 180; B.Env.setClock(18 * 3600 + 58 * 60);
    const d = 380, x = e.x - e.ux * (d - 300), z = e.z - e.uz * (d - 300), y = e.elev + Math.tan(3 * D) * d + F.type.fdm.cgHeight;
    F.ac.place({ x, y, z, hdg: e.hdg * D, pitch: 2 * D, fpa: -3 * D, speed: F.cfg.vapp * 0.5144, gear: 1, flaps: F.type.fdm.flaps.length - 1, thr: 0.45 }); F.fcs.airStart(-3 * D);
    F.armApproach(); Object.assign(F.fcs.ap, { gs: true, loc: true }); F.fcs.autoBrake = 0.5;
    const u = 470; window.__camP = { x: e.x + e.ux * u + e.uz * 70, y: e.elev + 1.3, z: e.z + e.uz * u - e.ux * 70 }; return 1; }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(); C.aim(cam, window.__camP, C.add(P.p, P.fwd, 6), 30, 0); }`,
};
