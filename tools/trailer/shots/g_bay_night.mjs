// night on the water off Treasure Island: San Francisco's skyline and the Bay Bridge lights reflected in the Bay
// (Ultra+ reflections), a slow low drift
import { cine, moveLL } from './_lib.mjs';
export default {
  hash: '#auto&t=21:00&q=ultraplus!&w=clear&ll=37.80800,-122.37800,14,-2.3,-0.03', warm: 50, frames: 240,
  setup: `async () => { ${cine}; ${moveLL([[37.80820, -122.37760, 12], [37.80700, -122.37960, 13]], [[37.79330, -122.39650, 70], [37.79300, -122.39700, 70]])}; return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(21 * 3600); window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return 1; }`,
  before: `(t) => { const m = window.__mv(t / 8); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { const m = window.__mv(t / 8); __cine.aim(cam, m.p, m.q, 40, 0); }`,
};
