import { cine } from './_lib.mjs';
const A = [37.8350, -122.4985, 340], Bp = [37.8305, -122.4905, 300], LA = [37.8199, -122.4786, 120], LB = [37.8110, -122.4590, 90];
export default {
  hash: '#auto&t=18:22&q=ultraplus!&w=fog', warm: 45, frames: 240,
  setup: `async () => { ${cine}; const C = __cine; C.put(C.ll(${A}), C.ll(${LA})); return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(18 * 3600 + 22 * 60); return 1; }`,
  before: `(t) => { const C = __cine, k = C.ease(t / 8); C.put(C.mix(C.ll(${A}), C.ll(${Bp}), k), C.ll(${LA})); }`,
  cam: `(t, cam) => { const C = __cine, k = C.ease(t / 8); C.aim(cam, C.mix(C.ll(${A}), C.ll(${Bp}), k), C.mix(C.ll(${LA}), C.ll(${LB}), k), 48, 0); }`,
};
