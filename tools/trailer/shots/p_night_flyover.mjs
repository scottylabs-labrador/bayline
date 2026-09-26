// P20 (89.2-96.7 s, WORLD): night, low over Oakland toward the Bay Bridge: the West Oakland aerial runs away from the
// camera to the Tube portal, its trains strings of lit windows, the Bay Bridge's lights and San Francisco beyond; a slow
// glide west-north-west (310 m in 11.3 s) over the Port side of West Oakland toward the Tube portal, 30 m north of the
// aerial and ~22 m above its deck, so the trains coming out of the Tube pass below-left with their headlights and lit
// windows. The clock is found in the timetable: the time when this camera path has a train big enough to read in frame at
// every tap of the shot (and both ways, if it can), so the shot works on any service day.
import { cine, moveLL } from './_lib.mjs';
import { metroReady, metroFramed, hideMapDots } from './_world.mjs';
const DUR = 11.3;
const P = [[37.80690, -122.29990, 36], [37.80745, -122.30330, 34]];          // 30 m north of the aerial west of West Oakland station, ~22 m above its deck (310 m)
const Q = [[37.80800, -122.30700, -30], [37.80850, -122.31050, -30]];        // the aerial ~700 m ahead (pitch ~ -5 deg): the Tube portal, the Bay Bridge beyond
export default {
  maxDsf: 1.5,
  hash: '#auto&t=21:00&q=ultraplus!&w=clear&ll=37.80690,-122.29990,40,-1.33,-0.10', warm: 50, frames: 340, settle: 2500,
  setup: `async () => { ${cine}; ${moveLL(P, Q)}; return 1; }`,
  prime: `async () => { const ok = await (${metroReady})(90000); if (!ok) return 'no metro timetable';
    window.__mvReset(); const r = (${metroFramed})(20 * 3600, 23 * 3600 + 50 * 60, 2, [1, 3.5, 6, 8.5, 10.8], ${DUR}, 30, 60, 1100);
    window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return JSON.stringify(r); }`,
  before: `(t) => { const m = window.__mv(t / ${DUR}); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { ${hideMapDots}; const m = window.__mv(t / ${DUR}); __cine.aim(cam, m.p, m.q, 30, 0); }`,
};
