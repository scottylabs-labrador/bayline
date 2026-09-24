// the same storm from the A320's cockpit: rain on the glass, the approach lights and runway ahead through the murk
import { cine, flyReady } from './_lib.mjs';
export default {
  hash: '#auto&t=18:05&q=ultra&w=storm&fly=a320,KSFO,28R,final', warm: 45, frames: 240,
  setup: `async () => { ${cine}; return (${flyReady})(); }`,
  prime: `() => { const B = window.__bayline, F = B.Flight; B.Env.setClock(18 * 3600 + 5 * 60); B.Env.state.weather = 'storm'; F.armApproach(); F.cam.set('cockpit', true); F.cam.look.pitch = -0.06; return 1; }`,
};
