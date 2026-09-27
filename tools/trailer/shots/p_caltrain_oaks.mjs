// PROMO P07: late afternoon, a southbound Peninsula express through Atherton's oaks, long shadows, the drone low off
// its flank over the trees, slowly overtaken (derived from g_drone_train)
import { cine, passClock } from './_lib.mjs';
import { mDay } from './_metro.mjs';
export default {
  maxDsf: 1.5,     // 4K screenshots of this dense canopy wedge the headless GPU readback
  hash: '#auto&t=16:40&q=ultraplus!&w=clear&at=menlo_park', warm: 45, frames: 270,
  setup: `async () => { ${cine}; await (${mDay})('2026-09-29'); const B = window.__bayline; window.__dep = (${passClock})(B.Track.byId.menlo_park.s - 2200, 1, 16 * 3600 + 40 * 60, 2.0, 25); return window.__dep; }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(window.__dep.t); B.Player.setFocus(window.__dep.key); B.Player.setMode('chase'); return window.__dep.v; }`,
  before: `(t) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key); if (tr) { const P = C.trainPose(tr, -1); C.put(C.rel(P, 34, 30, 44), P.p); } }`,
  cam: `(t, cam) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key); if (!tr) return; const P = C.trainPose(tr, -1), k = C.ease(t / 9);
    C.aim(cam, C.rel(P, 34 - 36 * k, 30 - 4 * k, 44 - 8 * k), C.rel(P, -14 - 16 * k, 0, -1), 42, 0); }`,
};
