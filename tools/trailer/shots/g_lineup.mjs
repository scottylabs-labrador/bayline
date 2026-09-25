// gameplay: lined up on SFO 28R in the A320's cockpit, the flight HUD up; throttles forward, the runway starts to move
import { cine, flyReady } from './_lib.mjs';
export default {
  ui: true, css: '#strip, #streambar, #toast, #ftouch, #joy { display: none !important; }',
  hash: '#auto&t=15:40&q=ultraplus!&w=clear&fly=a320,KSFO,28R,runway', warm: 45, frames: 150,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(15 * 3600 + 40 * 60); B.FHud && B.FHud.setup && B.FHud.setup(false); B.Flight.cam.set('cockpit', true); B.Flight.cam.look.pitch = -0.08; return 1; }`,
  before: `(t) => { const B = window.__bayline, K = B.Flight.input.keys; if (t > 0.3) K.add('KeyW'); if (B.Flight.ac.ctl.thr > 0.98) K.delete('KeyW'); }`,
};
