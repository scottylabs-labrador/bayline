// a late-afternoon thunderstorm on final into SFO 28R: dark cloud, rain streaking past, landing lights on
// (lightning is timed to the music in the edit)
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=18:05&q=ultraplus!&w=storm&fly=a320,KSFO,28R,final', warm: 45, frames: 240,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight; B.Env.setClock(18 * 3600 + 5 * 60); B.Env.state.weather = 'storm'; if (B.Post) B.Post.debug.ae = false;   /* a storm should stay dark: no eye adaptation */ F.armApproach(); return 1; }`,
  cam: `(t, cam) => { const C = __cine, P = C.acPose(), k = C.ease(t / 8); C.aim(cam, C.rel(P, -30 + 12 * k, -17 + 5 * k, 4 - 2 * k), C.rel(P, 30, 0, -2), 50, 0); }`,
};
