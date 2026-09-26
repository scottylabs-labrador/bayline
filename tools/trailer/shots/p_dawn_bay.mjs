// P01 (0.0-5.1 s, WORLD): 06:15 pre-dawn, high over the Bay east of Treasure Island looking south-west: Yerba Buena
// and the lit west span of the Bay Bridge leading to San Francisco's skyline, the city's lights against the last of the
// night, the sky brightening behind the camera; a slow lateral drift (captured ~1.5x the slot). Looking south-west
// with a 70 mm keeps the setting moon's glitter path (west, date-dependent) out of the frame.
import { cine, moveLL } from './_lib.mjs';
import { hideMapDots } from './_world.mjs';
const T = 6 * 3600 + 15 * 60, DUR = 7.8;
const P = [[37.82760, -122.35120, 600], [37.82640, -122.34960, 590]];          // over the Bay east of Treasure Island
const Q = [[37.79000, -122.40000, 170], [37.78930, -122.39880, 170]];          // downtown San Francisco (pitch ~ -4 deg: the horizon on the upper third)
export default {
  hash: '#auto&t=06:15&q=ultraplus!&w=clear&ll=37.82760,-122.35120,600,-2.34,-0.09', warm: 50, frames: 234, settle: 2500,
  setup: `async () => { ${cine}; ${moveLL(P, Q)}; return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(${T}); window.__bayline.Env.time.scale = 1; window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return 1; }`,
  before: `(t) => { const m = window.__mv(t / ${DUR}); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { ${hideMapDots}; const m = window.__mv(t / ${DUR}); __cine.aim(cam, m.p, m.q, 20, 0); }`,
};
