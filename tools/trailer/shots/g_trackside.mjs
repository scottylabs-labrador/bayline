// late morning: a northbound express through a San Mateo grade crossing at speed, gates down, the camera at the
// roadside panning with the cab as the double-deckers stream past (120 fps: slow motion)
import { cine, passClock } from './_lib.mjs';
const SX = 29235;
export default {
  hash: '#auto&t=11:20&q=ultraplus!&w=clear&at=san_mateo', warm: 45, frames: 540, fps: 120, maxDsf: 1.5,
  setup: `async () => { ${cine}; window.__dep = (${passClock})(${SX}, 0, 11 * 3600 + 20 * 60, 2.2, 25); return window.__dep; }`,
  prime: `() => { const B = window.__bayline, d = window.__dep; B.Env.setClock(d.t); B.Player.setFocus(d.key);
    const F = {}; B.Track.frame(${SX}, F); const lat = B.Track.lane(${SX}, 0), side = Math.sign(lat) || 1, o = lat + side * 6.5;
    window.__cp = { x: F.x + F.rx * o, y: F.y + 1.6, z: F.z + F.rz * o }; return d.v; }`,
  before: `(t) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key); if (tr) C.put(window.__cp, C.trainPose(tr, -1).p); }`,
  cam: `(t, cam) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key); if (!tr) return;
    const u = tr.s - ${SX}, g = u > 18 ? u : 18 * Math.exp((u - 18) / 18), F = {}; B.Track.frame(${SX} + g, F); const lat = B.Track.lane(${SX} + g, 0);
    C.aim(cam, window.__cp, { x: F.x + F.rx * lat, y: F.y + 2.4, z: F.z + F.rz * lat }, 44, 0); }`,
};
