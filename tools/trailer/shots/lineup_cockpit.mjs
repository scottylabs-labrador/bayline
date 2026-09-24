// the A320 cockpit lined up on SFO 28R at golden hour: throttles up, the runway starts to move
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=18:40&q=ultra&w=clear&fly=a320,KSFO,28R,runway', warm: 40, frames: 180,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(18 * 3600 + 40 * 60); B.Flight.cam.set('cockpit', true); B.Flight.cam.look.pitch = -0.1; return 1; }`,
  before: `(t) => { const B = window.__bayline, K = B.Flight.input.keys; if (t > 0.8) K.add('KeyW'); if (B.Flight.ac.ctl.thr > 0.98) K.delete('KeyW'); }`,
};
