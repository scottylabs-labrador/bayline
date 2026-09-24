// a 747 at 35,000 ft at dusk, its four contrails stretching back toward the camera
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=18:58&q=ultra&w=clear&flyat=b744,37.62,-122.05,10700,95,480,0,0', warm: 50, frames: 210,
  setup: `async () => { ${cine}; const r = await (${flyReady})(); const F = window.__bayline.Flight; Object.assign(F.fcs.ap, { on: true, alt: 10700, hdg: 95 * Math.PI / 180 }); return r; }`,
  prime: `() => { const B = window.__bayline, F = B.Flight; B.Env.setClock(18 * 3600 + 58 * 60); Object.assign(F.fcs.ap, { on: true, alt: F.ac.pos.y, hdg: 95 * Math.PI / 180 }); return 1; }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(), k = C.ease(t / 7); C.aim(cam, C.rel(P, -120 + 40 * k, -55 + 10 * k, 22 - 6 * k), C.rel(P, 25, 0, 0), 44, 0); }`,
};
