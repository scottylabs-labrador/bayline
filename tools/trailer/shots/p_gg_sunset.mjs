// PROMO P15: sunset: low over the Bay off Crissy Field, a slow push west toward the Golden Gate, the sun going down
// behind the bridge and its light on the water (Ultra+ reflections)
import { cine, moveLL } from './_lib.mjs';
import { mDay } from './_metro.mjs';
export default {
  hash: '#auto&t=18:44&q=ultraplus!&w=clear&ll=37.8098,-122.4480,45,4.95,-0.02', warm: 50, frames: 330,
  setup: `async () => { ${cine}; await (${mDay})('2026-09-29'); ${moveLL([[37.80980, -122.44800, 42], [37.81080, -122.45650, 38]], [[37.82060, -122.47880, 95], [37.82020, -122.47840, 80]])}; return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(18 * 3600 + 44 * 60); window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return 1; }`,
  before: `(t) => { const m = window.__mv(t / 11); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { const m = window.__mv(t / 11); __cine.aim(cam, m.p, m.q, 25, 0); }`,
};
