// PROMO P23: night: gliding low beside the Bay Bridge's lit west span toward San Francisco, the traffic streaming on
// the deck and the skyline ahead
import { cine, moveLL } from './_lib.mjs';
import { mDay } from './_metro.mjs';
export default {
  maxDsf: 1.5,     // downtown at night: 4K readback can wedge (see the capture notes)
  hash: '#auto&t=21:05&q=ultra&w=clear&ll=37.7998,-122.3688,34,4.3,0.22', warm: 50, frames: 300,
  setup: `async () => { ${cine}; await (${mDay})('2026-09-29'); ${moveLL([[37.79980, -122.36880, 34], [37.79380, -122.37760, 30]], [[37.80520, -122.37560, 105], [37.79700, -122.38760, 115]])}; return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(21 * 3600 + 5 * 60); window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return 1; }`,
  before: `(t) => { const m = window.__mv(t / 10); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { const m = window.__mv(t / 10); __cine.aim(cam, m.p, m.q, 40, 0); }`,
};
