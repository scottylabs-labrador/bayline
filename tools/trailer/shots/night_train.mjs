// night: a southbound train through lit San Mateo, the drone low alongside the lead car, slowly overtaken
import { cine, depClock } from './_lib.mjs';
export default {
  hash: '#auto&t=21:20&q=ultraplus!&w=clear&at=san_mateo', warm: 45, frames: 240,
  setup: `async () => { ${cine}; window.__dep = (${depClock})('san_mateo', 1, 21 * 3600 + 20 * 60, 12); return window.__dep; }`,
  prime: `() => { const B = window.__bayline; B.Env.setClock(window.__dep.t); B.Player.setFocus(window.__dep.key); B.Player.setMode('chase'); return window.__dep.trip; }`,
  before: `(t) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key); if (tr) { const P = C.trainPose(tr, -1); C.put(C.rel(P, 20, -15, 9), P.p); } }`,
  cam: `(t, cam) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key); if (!tr) return; const P = C.trainPose(tr, -1), k = C.ease(t / 8);
    C.aim(cam, C.rel(P, 22 - 26 * k, -15, 9 - 2 * k), C.rel(P, -6 - 10 * k, 0, -1), 50, 0); }`,
};
