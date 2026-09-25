// Clement Street at sunset, walking pace into the sun: bay windows and cornices, parked cars, the low light down the block
import { cine, moveLL } from './_lib.mjs';
export default {
  maxDsf: 1.5,
  hash: '#auto&t=18:35&q=ultraplus!&w=clear&ll=37.78290,-122.46400,2,-1.57,0.05', warm: 50, frames: 240,
  setup: `async () => { ${cine}; ${moveLL([[37.78292, -122.46418, 2.4], [37.78297, -122.46478, 2.6]], [[37.78325, -122.47420, 7], [37.78327, -122.47480, 7]])}; return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(18 * 3600 + 35 * 60); window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return 1; }`,
  before: `(t) => { const m = window.__mv(t / 8, true); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { const m = window.__mv(t / 8, true); __cine.aim(cam, m.p, m.q, 52, 0); }`,
};
