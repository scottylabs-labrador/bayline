// the finale: twilight over the Bay Bridge's lights, then one continuous rise to 30 km, pulling back over the East Bay
// until the whole Bay glitters below and the curve of the Earth meets the last of the sunset (end card over the top)
import { cine } from './_lib.mjs';
const A = [37.7990, -122.3700], B = [37.8500, -122.0600], T0 = [37.7890, -122.3990], T1 = [37.6500, -124.2000];
const Y0 = 150, Y1 = 30000, DUR = 20;
const path = `(t) => { const C = __cine, k = C.ease(t / ${DUR}), kh = C.ease(Math.min(1, t / ${DUR * 0.92})), y = ${Y0} * Math.pow(${Y1 / Y0}, kh);
  const a = C.ll(${A}, 0), b = C.ll(${B}, 0), p = C.mix(a, b, Math.pow(k, 1.4)); p.y = y;
  const q0 = C.ll(${T0}, 60), q1 = C.ll(${T1}, 0), kq = C.ease(Math.min(1, t / ${DUR * 0.7})), q = C.mix(q0, q1, kq); return { p, q }; }`;
export default {
  hash: '#auto&t=19:24&q=ultraplus!&w=clear', warm: 50, frames: 600, settle: 2500,
  setup: `async () => { ${cine}; window.__path = ${path}; const P = window.__path(0); __cine.put(P.p, P.q); return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(19 * 3600 + 24 * 60); return 1; }`,
  before: `(t) => { const P = window.__path(t); __cine.put(P.p, P.q); }`,
  cam: `(t, cam) => { const P = window.__path(t), h = P.p.y; __cine.aim(cam, P.p, P.q, 50, 0);
    cam.far = Math.min(1.2e6, Math.sqrt(2 * 6371000 * h + 1e8) * 1.3 + 60000); cam.updateProjectionMatrix(); }`,
};
