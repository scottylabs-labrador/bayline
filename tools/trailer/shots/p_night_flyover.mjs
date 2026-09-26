// P20 (89.2-96.7 s, WORLD): night, low over Oakland toward the Bay Bridge: the West Oakland aerial runs away from the
// camera to the Tube portal, its trains strings of light, the Bay Bridge's lights and San Francisco beyond; a slow
// glide west-north-west from West Oakland station toward the Tube portal, 32 m north of the aerial and ~22 m above
// its deck, so the trains ahead show their lit windows. The clock is found in the timetable: the time when this camera path sees the most
// trains in frame (both ways preferred), so the shot works on any service day.
import { cine, moveLL } from './_lib.mjs';
import { metroReady, metroFramed, hideMapDots } from './_world.mjs';
const DUR = 11.3;
const P = [[37.80488, -122.29431, 36], [37.80737, -122.30274, 34]];          // 32 m north of the aerial from West Oakland station on, ~22 m above its deck
const Q = [[37.80700, -122.30250, -35], [37.80850, -122.31050, -35]];        // the aerial ~700 m ahead (pitch ~ -6 deg): the Tube portal, the Bay Bridge beyond
export default {
  maxDsf: 1.5,
  hash: '#auto&t=21:00&q=ultraplus!&w=clear&ll=37.80488,-122.29431,40,-1.33,-0.10', warm: 50, frames: 340, settle: 2500,
  setup: `async () => { ${cine}; ${moveLL(P, Q)}; return 1; }`,
  prime: `async () => { const ok = await (${metroReady})(90000); if (!ok) return 'no metro timetable';
    window.__mvReset(); const r = (${metroFramed})(20 * 3600 + 30 * 60, 22 * 3600 + 30 * 60, 4, [1.5, 4, 6.5, 9, 11], ${DUR}, 30, 150, 1100);
    window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return JSON.stringify(r); }`,
  before: `(t) => { const m = window.__mv(t / ${DUR}); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { ${hideMapDots}; const m = window.__mv(t / ${DUR}); __cine.aim(cam, m.p, m.q, 30, 0); }`,
};
