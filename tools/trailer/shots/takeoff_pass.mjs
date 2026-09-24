// A320 takeoff from SFO 28R at golden hour: a low camera near the liftoff point, the jet thunders past and rotates (2x slow motion)
import { cine, flyReady, rwy } from './_lib.mjs';
export default {
  hash: '#auto&t=18:45&q=ultra&w=clear&fly=a320,KSFO,28R,runway', warm: 40, frames: 360, fps: 60,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, e = (${rwy})('KSFO', '28R'); B.Env.setClock(18 * 3600 + 45 * 60);
    const u = 880, x = e.x + e.ux * u, z = e.z + e.uz * u, h = F.groundFn(x, z).h; F.ac.place({ x, y: h, z, hdg: e.hdg * Math.PI / 180, onGround: true, flaps: 2, thr: 1, speed: 126 * 0.5144 });
    F.ac.ctl.park = 0; F.ac.ctl.thr = 1; F.fcs.ap.athr = false;
    const uc = 1230; window.__camP = { x: e.x + e.ux * uc - e.uz * 62, y: h + 1.6, z: e.z + e.uz * uc + e.ux * 62 }; return e.hdg; }`,
  before: `(t) => { const B = window.__bayline, F = B.Flight, K = F.input.keys; F.ac.ctl.thr = 1; if (F.ac.out.cas / 0.5144 > 142 && F.euler.pitch < 0.2) K.add('ArrowDown'); else K.delete('ArrowDown'); }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(); C.aim(cam, window.__camP, C.add(P.p, P.fwd, 6), 32, 0); }`,
};
