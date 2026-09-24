// Concorde at Mach 2, 55,000 ft over the Pacific at sunset: the curve of the Earth, the dark sky above
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=19:02&q=ultra&w=clear&flyat=conc,37.55,-123.40,16800,265,1150,0,0', warm: 40, frames: 210,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight; B.Env.setClock(19 * 3600 + 2 * 60); Object.assign(F.fcs.ap, { on: true, alt: F.ac.pos.y, hdg: 265 * Math.PI / 180, athr: true, spd: F.fcs.ap.spd || 530, thrI: 0.8 }); return Math.round(F.ac.out.mach * 100) / 100; }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(), k = C.ease(t / 7); C.aim(cam, C.rel(P, 38 - 70 * k, -34 + 6 * k, 6 + 3 * k), C.rel(P, 4, 0, 0), 46, 0); }`,
};
