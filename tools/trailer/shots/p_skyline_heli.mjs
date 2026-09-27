// PROMO P25: night: circling the Salesforce Tower's lit crown, the city grid and the Bay Bridge glowing below
// (derived from salesforce_night)
import { cine } from './_lib.mjs';
import { mDay } from './_metro.mjs';
const T = [37.789775, -122.396914];
export default {
  maxDsf: 1.5,     // 4K screenshots of this dense scene wedge the headless GPU readback
  hash: '#auto&t=21:35&q=ultraplus!&w=clear', warm: 45, frames: 240,
  setup: `async () => { ${cine}; await (${mDay})('2026-09-29'); const C = __cine, c = C.ll(${T}, 0); C.put({ x: c.x + 220, y: 380, z: c.z + 120 }, { x: c.x, y: 310, z: c.z }); return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(21 * 3600 + 35 * 60); return 1; }`,
  before: `(t) => { const C = __cine, c = C.ll(${T}, 0), a = 1.1 + t * 0.07; C.put({ x: c.x + Math.sin(a) * 230, y: 370, z: c.z + Math.cos(a) * 230 }, { x: c.x, y: 300, z: c.z }); }`,
  cam: `(t, cam) => { const C = __cine, c = C.ll(${T}, 0), a = 1.1 + t * 0.07; C.aim(cam, { x: c.x + Math.sin(a) * 230, y: 370, z: c.z + Math.cos(a) * 230 }, { x: c.x, y: 305, z: c.z }, 40, 0); }`,
};
