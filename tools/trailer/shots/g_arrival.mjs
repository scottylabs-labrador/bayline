// mid-morning at San Carlos: a southbound train glides in and stops just short of the camera, the doors open
import { cine, passClock } from './_lib.mjs';
export default {
  hash: '#auto&t=09:40&q=ultraplus!&w=clear&at=san_carlos', warm: 45, frames: 300,
  setup: `async () => { ${cine}; const B = window.__bayline, st = B.Stations.list[B.Track.byId.san_carlos.idx]; window.__st = st;
    window.__dep = (${passClock})(st.stop[1], 1, 9 * 3600 + 40 * 60, 7.5); return window.__dep; }`,
  prime: `() => { const B = window.__bayline, st = window.__st, d = window.__dep; B.Env.setClock(d.t); B.Player.setFocus(d.key);
    const sC = st.stop[1] + 9, F = {}; B.Track.frame(sC, F); const o = B.Track.lane(sC, 1) + st.door[1] * (1.72 + 1.1);
    window.__sC = sC; window.__cp = { x: F.x + F.rx * o, y: F.y + B.Stations.PH + 1.2, z: F.z + F.rz * o }; return d.trip; }`,
  before: `(t) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key); if (tr) C.put(window.__cp, C.trainPose(tr, -1).p); }`,
  cam: `(t, cam) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key), sC = window.__sC;
    const sq = tr ? Math.min(tr.s - 12, sC - 34) : sC - 34, F = {}; B.Track.frame(sq, F); const lat = B.Track.lane(sq, 1);
    C.aim(cam, window.__cp, { x: F.x + F.rx * lat, y: F.y + 2.3, z: F.z + F.rz * lat }, 50, 0); }`,
};
