// the end card's background: blue hour over the Bay, San Francisco's skyline lighting up across the water, the Bay
// Bridge strung with lights; a slow rising pull-back (Ultra+ reflections)
import { cine, moveLL } from './_lib.mjs';
export default {
  hash: '#auto&t=19:38&q=ultraplus!&w=clear&ll=37.8050,-122.3650,260,-2.2,-0.1', warm: 50, frames: 360, settle: 1500,
  setup: `async () => { ${cine}; ${moveLL([[37.80350, -122.36900, 120], [37.80700, -122.36200, 210], [37.81100, -122.35400, 330]], [[37.79150, -122.39700, 90], [37.79150, -122.39800, 80]])}; return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(19 * 3600 + 38 * 60); window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return 1; }`,
  before: `(t) => { const m = window.__mv(t / 12); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { const m = window.__mv(t / 12); __cine.aim(cam, m.p, m.q, 44, 0); }`,
};
