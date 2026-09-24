// golden hour: a southbound express at speed past San Mateo, the drone leading it over the tracks (clear of the
// lineside trees, above the catenary), nose and sunlit flank in frame as the train closes in
import { cine, passClock } from './_lib.mjs';
export default {
  hash: '#auto&t=17:40&q=ultra&w=clear&at=san_mateo', warm: 40, frames: 240,
  setup: `async () => { ${cine}; window.__dep = (${passClock})(29900, 1, 17 * 3600 + 35 * 60, 1.5, 22); return window.__dep; }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(window.__dep.t); B.Player.setFocus(window.__dep.key); B.Player.setMode('chase'); return window.__dep.v; }`,
  before: `(t) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key); if (tr) { const P = C.trainPose(tr, -1); C.put(C.rel(P, 44, 7, 16), P.p); } }`,
  cam: `(t, cam) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key); if (!tr) return; const P = C.trainPose(tr, -1), k = C.ease(t / 8);
    C.aim(cam, C.rel(P, 44 - 20 * k, 7 + 2.5 * k, 16 - 3 * k), C.rel(P, -10 - 8 * k, 0, -1), 42, 0); }`,
};
