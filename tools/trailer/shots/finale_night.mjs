// the finale: rising over the Bay Bridge's lights at night, the whole city ahead
import { cine } from './_lib.mjs';
const A = [37.7925, -122.3650, 140], Bq = [37.7880, -122.3560, 420], L = [37.7920, -122.4060, 90];
export default {
  hash: '#auto&t=21:45&q=ultra&w=clear', warm: 50, frames: 300,
  setup: `async () => { ${cine}; const C = __cine; C.put(C.ll(${A}), C.ll(${L})); return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(21 * 3600 + 45 * 60); return 1; }`,
  before: `(t) => { const C = __cine, k = C.ease(t / 10); C.put(C.mix(C.ll(${A}), C.ll(${Bq}), k), C.ll(${L})); }`,
  cam: `(t, cam) => { const C = __cine, k = C.ease(t / 10); C.aim(cam, C.mix(C.ll(${A}), C.ll(${Bq}), k), C.ll(${L}), 46 - 6 * k, 0); }`,
};
