// P01 alternative (WORLD): into the dawn. 06:50 on 2026-09-29 (civil dawn ~06:39, sunrise ~07:05): from ~240 m over the
// water off the northern Embarcadero (Piers 35-39), looking east across the Bay: the Bay Bridge's east span, its white
// self-anchored tower standing clear between Treasure Island and Yerba Buena right in front of the glow (the sun rises
// at azimuth ~91 deg, straight behind it), the Skyway running on to Oakland, the East Bay and the Oakland hills on the
// horizon, all dark silhouettes with their lights still on under a sky from deep blue to warm at the horizon, the water
// reflecting it. Backlit ground shows no surface texture. ~65 mm (vertical fov 20), a slow lateral drift north with a
// slight push (~130 m in 7.8 s). No aircraft: the live ADS-B traffic (a different sky on every capture day) is switched
// off and the simulated traffic hidden, so the gradient stays clean and the draft and the 4K capture match. (Off Rincon Hill, Yerba Buena hides the east span; from here the tower is clear.)
// The waning gibbous moon of the 29th is high in the south-west, behind the camera.
import { cine, moveLL } from './_lib.mjs';
import { mDay } from './_metro.mjs';
import { hideMapDots } from './_world.mjs';
const T = 6 * 3600 + 50 * 60, DUR = 7.8, FOV = 20;
const P = [[37.81450, -122.40000, 220], [37.81560, -122.39950, 220]];          // over the water north-east of Pier 39
const Q = [[37.81570, -122.35850, 215], [37.81660, -122.35800, 215]];          // just left of the tower, level (the horizon mid-frame)
export default {
  hash: '#auto&t=06:50&q=ultraplus!&w=clear&ll=37.81450,-122.40000,220,1.54,0.0', warm: 50, frames: 234, settle: 2500,
  setup: `async () => { await (${mDay})('2026-09-29'); ${cine}; ${moveLL(P, Q)}; const B = window.__bayline; if (B.Traffic) B.Traffic.enabled = false; return 1; }`,
  prime: `() => { window.__bayline.Env.setClock(${T}); window.__bayline.Env.time.scale = 1; window.__mvReset(); const m = window.__mv(0); __cine.put(m.p, m.q); return window.__bayline.Env.serviceDay().ymd; }`,
  before: `(t) => { const m = window.__mv(t / ${DUR}); __cine.put(m.p, m.q); }`,
  cam: `(t, cam) => { ${hideMapDots}; const W = window.__bayline.World; if (W && W.air && W.air.group) W.air.group.visible = false; const m = window.__mv(t / ${DUR}); __cine.aim(cam, m.p, m.q, ${FOV}, 0); }`,
};
