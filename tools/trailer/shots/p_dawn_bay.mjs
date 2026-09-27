// P01 (0.0-5.1 s, WORLD): pre-dawn, high over the Bay east of Treasure Island looking south-west: the lit west span of
// the Bay Bridge leading in from the left to San Francisco's skyline, the city's lights and their reflections filling the
// band, the sky over the city; a slow lateral drift (captured ~1.5x the slot). ~100 mm (vertical fov 14 deg) past
// Yerba Buena, which stays below the frame. Two variants for the draft: this one at 06:15 (still night) and
// p_dawn_bay_blue at 06:42 (civil dawn: deep blue over the city, the lights still on). The service day is pinned
// (2026-09-29: the moon waning gibbous, high in the south-west at dawn, well above the frame and its glitter well below).
import { cine, moveLL } from './_lib.mjs';
import { mDay } from './_metro.mjs';
import { hideMapDots } from './_world.mjs';
const DUR = 7.8, FOV = 14;
const P = [[37.82760, -122.35120, 600], [37.82640, -122.34960, 590]];          // over the Bay east of Treasure Island
const Q = [[37.79000, -122.40000, 190], [37.78930, -122.39880, 190]];          // downtown San Francisco (pitch ~ -3.9 deg: a fifth of the band sky, the reflections below the skyline)
const hhmm = (T) => String(Math.floor(T / 3600)).padStart(2, '0') + ':' + String(Math.floor(T / 60) % 60).padStart(2, '0');
export const dawnBay = (T) => ({
  hash: `#auto&t=${hhmm(T)}&q=ultraplus!&w=clear&ll=37.82760,-122.35120,600,-2.34,-0.05`, warm: 50, frames: 234, settle: 2500,
  setup: `async () => { await (${mDay})('2026-09-29'); ${cine}; ${moveLL(P, Q)}; return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(${T}); window.__bayline.Env.time.scale = 1; window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return window.__bayline.Env.serviceDay().ymd; }`,
  before: `(t) => { const m = window.__mv(t / ${DUR}); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { ${hideMapDots}; const m = window.__mv(t / ${DUR}); __cine.aim(cam, m.p, m.q, ${FOV}, 0); }`,
});
export default dawnBay(6 * 3600 + 15 * 60);
