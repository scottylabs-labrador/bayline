// cold open: dawn on the water off the Embarcadero, the Bay Bridge in silhouette against the rising sun, its towers and
// the first light reflected in the Bay (Ultra+ screen-space reflections); a slow low truck
import { cine, moveLL } from './_lib.mjs';
export default {
  hash: '#auto&t=07:18&q=ultraplus!&w=clear&ll=37.7960,-122.3905,14,1.95,-0.04', warm: 45, frames: 240,
  setup: `async () => { ${cine}; ${moveLL([[37.79520, -122.39030, 9], [37.79640, -122.38930, 11]], [[37.78700, -122.37700, 70], [37.78820, -122.37550, 70]])}; return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(7 * 3600 + 18 * 60); window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return 1; }`,
  before: `(t) => { const m = window.__mv(t / 8); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { const m = window.__mv(t / 8); __cine.aim(cam, m.p, m.q, 38, 0); }`,
};
