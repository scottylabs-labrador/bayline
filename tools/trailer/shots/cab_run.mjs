// from the cab of a southbound express at ~78 mph, golden hour: through a grade crossing and on past Hayward Park
import { cine, passClock } from './_lib.mjs';
export default {
  hash: '#auto&t=18:20&q=ultra&w=clear&at=san_mateo', warm: 40, frames: 300,
  setup: `async () => { ${cine}; window.__dep = (${passClock})(29235, 1, 18 * 3600 + 20 * 60, 2.5, 25); return window.__dep; }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(window.__dep.t); B.Player.setFocus(window.__dep.key); B.Player.setMode('cab'); return window.__dep.v; }`,
};
