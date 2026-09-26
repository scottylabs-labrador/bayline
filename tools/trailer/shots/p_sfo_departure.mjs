// PROMO P09: golden hour at SFO 28R: a 787-9 on its takeoff roll into the low sun, the camera low beside the runway
// near rotation, rim-lit as it rotates and lifts off (60 fps: slow motion) (derived from g_takeoff_744)
import { cine, flyReady, rwy } from './_lib.mjs';
import { mDay } from './_metro.mjs';
export default {
  hash: '#auto&t=18:15&q=ultraplus!&w=clear&fly=b789,KSFO,28R,runway', warm: 45, frames: 390, fps: 60,
  setup: `async () => { ${cine}; await (${mDay})('2026-09-29'); return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, e = (${rwy})('KSFO', '28R'); B.Env.setClock(18 * 3600 + 15 * 60);
    const u = 1250, x = e.x + e.ux * u, z = e.z + e.uz * u, h = F.groundFn(x, z).h; F.ac.place({ x, y: h, z, hdg: e.hdg * Math.PI / 180, onGround: true, flaps: 2, thr: 1, speed: 138 * 0.5144 });
    F.ac.ctl.park = 0; F.ac.ctl.thr = 1; F.fcs.ap.athr = false;
    const uc = 1700; window.__camP = { x: e.x + e.ux * uc - e.uz * 75, y: h + 1.4, z: e.z + e.uz * uc + e.ux * 75 }; return e.hdg; }`,
  before: `(t) => { const B = window.__bayline, F = B.Flight, K = F.input.keys; F.ac.ctl.thr = 1; if (F.ac.out.cas / 0.5144 > 158 && F.euler.pitch < 0.19) K.add('ArrowDown'); else K.delete('ArrowDown'); }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(); C.aim(cam, window.__camP, C.add(P.p, P.fwd, 10), 30, 0); }`,
};
