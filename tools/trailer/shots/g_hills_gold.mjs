// golden hour in the Woodside hills: low over the oak-studded ridges toward the setting sun, light shafts pouring
// through the canopy, the lidar terrain crisp to the horizon
import { cine, moveLL, sunLook } from './_lib.mjs';
export default {
  hash: '#auto&t=18:28&q=ultraplus!&w=clear&ll=37.4450,-122.2700,0,-1.2,-0.2', warm: 50, frames: 240,
  setup: `async () => { ${cine}; ${moveLL([[37.44700, -122.26500, 60], [37.44560, -122.26880, 52], [37.44420, -122.27260, 48]], [[37.44700, -122.26500, 60]])}; return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(18 * 3600 + 28 * 60); window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, (${sunLook})(m.p, -0.3, -0.06)); return 1; }`,
  before: `(t) => { const m = window.__mv(t / 8); __cine.put(m.p, (${sunLook})(m.p, -0.3 + 0.05 * t / 8, -0.06)); }`,
  cam: `(t, cam) => { const m = window.__mv(t / 8); __cine.aim(cam, m.p, (${sunLook})(m.p, -0.3 + 0.05 * t / 8, -0.06 - 0.02 * t / 8), 44, 0); }`,
};
