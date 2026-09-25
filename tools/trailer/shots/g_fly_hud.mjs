// gameplay: the A320 over San Francisco in the late afternoon, the game's own chase camera and flight HUD, banking
// toward downtown
import { cine, flyReady } from './_lib.mjs';
export default {
  ui: true, css: '#strip, #streambar, #toast, #ftouch, #joy { display: none !important; }', maxDsf: 1.5,
  hash: '#auto&t=16:40&q=ultraplus!&w=clear&flyat=a320,37.7560,-122.4700,700,60,210,0,0', warm: 50, frames: 150,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight; B.Env.setClock(16 * 3600 + 40 * 60); B.FHud && B.FHud.setup && B.FHud.setup(false);
    Object.assign(F.fcs.ap, { on: true, alt: 700, hdg: 75 * Math.PI / 180, athr: true, spd: 210 }); F.cam.set('chase', true); return 1; }`,
};
