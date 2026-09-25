// dusk: the A380 on final into SFO 28R over the Bay, gear and flaps down, landing lights blazing; the camera flies
// formation off its right wingtip and slowly drifts forward past the engines
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=19:05&q=ultraplus!&w=clear&fly=a388,KSFO,28R,final', warm: 50, frames: 240,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight; B.Env.setClock(19 * 3600 + 5 * 60); F.armApproach(); Object.assign(F.fcs.ap, { gs: true, loc: true }); return 1; }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(), k = C.ease(t / 8); C.aim(cam, C.rel(P, -34 + 30 * k, 58 - 8 * k, 6 - 2 * k), C.rel(P, 18 - 10 * k, 0, 0), 46, 0); }`,
};
