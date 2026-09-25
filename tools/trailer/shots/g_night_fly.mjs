// night over downtown San Francisco: a slow glide between the towers at 180 m, every window a lit room
import { cine, moveLL } from './_lib.mjs';
export default {
  maxDsf: 1.5,
  hash: '#auto&t=21:10&q=ultraplus!&w=clear&ll=37.7860,-122.4060,200,1.0,-0.2', warm: 50, frames: 240,
  setup: `async () => { ${cine}; ${moveLL([[37.78430, -122.40900, 175], [37.78620, -122.40480, 170], [37.78790, -122.40050, 165]], [[37.79000, -122.39700, 90], [37.79150, -122.39300, 80], [37.79250, -122.38900, 70]])}; return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(21 * 3600 + 10 * 60); window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return 1; }`,
  before: `(t) => { const m = window.__mv(t / 8); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { const m = window.__mv(t / 8); __cine.aim(cam, m.p, m.q, 48, 0); }`,
};
