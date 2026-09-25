// golden hour over Palo Alto at rooftop height, into the sun: glowing crowns, long shadows, the haze over the hills
import { cine, moveLL, sunLook } from './_lib.mjs';
export default {
  hash: '#auto&t=18:25&q=ultraplus!&w=clear&ll=37.44470,-122.16150,25,-1.95,-0.05', warm: 50, frames: 240,
  setup: `async () => { ${cine}; ${moveLL([[37.44440, -122.16060, 24], [37.44500, -122.16240, 30]], [[37.44470, -122.16150, 25]])}; return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(18 * 3600 + 25 * 60); window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, (${sunLook})(m.p, 0.12, -0.05)); return 1; }`,
  before: `(t) => { const m = window.__mv(t / 8); __cine.put(m.p, (${sunLook})(m.p, 0.12, -0.05)); }`,
  cam: `(t, cam) => { const m = window.__mv(t / 8); __cine.aim(cam, m.p, (${sunLook})(m.p, 0.12 - 0.04 * t / 8, -0.05), 46, 0); }`,
};
