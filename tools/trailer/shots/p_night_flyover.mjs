// P20 (89.2-96.7 s, WORLD): night over West Oakland toward the Bay Bridge: the aerial runs away from the camera to the
// Tube portal, its trains strings of lit windows in the lower third, the Bay Bridge's lights and San Francisco on the
// horizon; a slow glide west-north-west (310 m in 11.3 s) at ~85 m over the Port side of West Oakland, ~80 m north of
// the aerial (the trains' lit north sides in view), ~75 mm tilted down ~6.5 deg so the aerial and its trains are the leading
// line (from 85 m the street-lamp glare is points and the pools a faint glow: 32025b9, 16f4cb4). The service day is pinned (2026-09-29) and the clock found in its timetable: the
// time when this camera path has a train big enough to read in frame at every tap (and both ways, if it can).
import { cine, moveLL } from './_lib.mjs';
import { mDay } from './_metro.mjs';
import { metroReady, metroFramed, hideMapDots } from './_world.mjs';
const DUR = 11.3, FOV = 26;
const P = [[37.80737, -122.29978, 85], [37.80792, -122.30318, 83]];          // ~80 m north of the aerial west of West Oakland station, ~85 m up (310 m)
const Q = [[37.80800, -122.30700, 5], [37.80850, -122.31050, 5]];            // the aerial ~700 m ahead (pitch ~ -6.5 deg): the Tube portal, the Bay Bridge on the horizon inside the band
export default {
  maxDsf: 1.5,
  hash: '#auto&t=21:00&q=ultraplus!&w=clear&ll=37.80737,-122.29978,90,-1.33,-0.13', warm: 50, frames: 340, settle: 2500,
  setup: `async () => { await (${mDay})('2026-09-29'); ${cine}; ${moveLL(P, Q)}; return 1; }`,
  prime: `async () => { const ok = await (${metroReady})(90000); if (!ok) return 'no metro timetable';
    window.__mvReset(); const r = (${metroFramed})(20 * 3600, 23 * 3600 + 50 * 60, 2, [1, 3.5, 6, 8.5, 10.8], ${DUR}, ${FOV}, 280, 480, 0.8, 4, 0.5);   // (280-480 m ahead: the lower-left third, off the edge)
    window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return JSON.stringify(Object.assign(r || {}, { day: window.__bayline.Env.serviceDay().ymd })); }`,
  before: `(t) => { const m = window.__mv(t / ${DUR}); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { ${hideMapDots}; const m = window.__mv(t / ${DUR}); __cine.aim(cam, m.p, m.q, ${FOV}, 0); }`,
};
