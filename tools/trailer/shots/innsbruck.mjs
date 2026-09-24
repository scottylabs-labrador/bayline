// A320 on final into Innsbruck, the Alps on both wings, low evening sun
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&q=ultra&w=clear&fly=a320,LOWI,26,final', warm: 60, frames: 240,
  setup: `async () => { ${cine}; const r = await (${flyReady})(); window.__bayline.Env.setLocalClock(17.6 * 3600); return r; }`,
  prime: `() => { const B = window.__bayline, F = B.Flight; B.Env.setLocalClock(17.6 * 3600); F.armApproach(); return 1; }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(), k = C.ease(t / 8); C.aim(cam, C.rel(P, -48 + 20 * k, -38 + 8 * k, 10), C.rel(P, 60, 0, -8), 50, 0); }`,
};
