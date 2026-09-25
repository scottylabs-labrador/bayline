// cold open: sunrise over the Woodside hills, the drone gliding low over the oaks toward the sun rising over the Bay;
// light shafts through the canopy, the Peninsula waking up below
import { cine, moveLL, sunLook } from './_lib.mjs';
export default {
  hash: '#auto&t=07:22&q=ultraplus!&w=clear&ll=37.4300,-122.2700,0,1.3,-0.1', warm: 45, frames: 270,
  setup: `async () => { ${cine}; ${moveLL([[37.43000, -122.27000, 95], [37.43120, -122.26780, 88], [37.43260, -122.26560, 82]], [[37.43000, -122.27000, 95]])}; return 1; }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(7 * 3600 + 22 * 60); window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, (${sunLook})(m.p, 0.28, -0.07)); return 1; }`,
  before: `(t) => { const m = window.__mv(t / 9); __cine.put(m.p, (${sunLook})(m.p, 0.28 - 0.06 * t / 9, -0.07)); }`,
  cam: `(t, cam) => { const m = window.__mv(t / 9); __cine.aim(cam, m.p, (${sunLook})(m.p, 0.28 - 0.06 * t / 9, -0.07 - 0.02 * t / 9), 42, 0); }`,
};
