// a northbound express through a San Mateo grade crossing at ~78 mph in the last sun: gates down, lights flashing; the
// camera at the roadside pans with the cab until the double-deckers stream past broadside (60 fps: slow motion or blur)
import { cine, passClock } from './_lib.mjs';
const SX = 29235;
export default {
  hash: '#auto&t=18:44&q=ultra&w=clear&at=san_mateo', warm: 40, frames: 480, fps: 60,
  setup: `async () => { ${cine}; window.__dep = (${passClock})(${SX}, 0, 18 * 3600 + 44 * 60, 4.2, 25); return window.__dep; }`,
  prime: `() => { const B = window.__bayline, d = window.__dep; B.Env.setClock(d.t); B.Player.setFocus(d.key);
    const F = {}; B.Track.frame(${SX}, F); const lat = B.Track.lane(${SX}, 0), side = Math.sign(lat) || 1, o = lat + side * 6.5;
    window.__cp = { x: F.x + F.rx * o, y: F.y + 1.6, z: F.z + F.rz * o }; return d.v; }`,
  before: `(t) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key); if (tr) C.put(window.__cp, C.trainPose(tr, -1).p); }`,
  cam: `(t, cam) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key); if (!tr) return;
    const u = tr.s - ${SX}, g = u > 18 ? u : 18 * Math.exp((u - 18) / 18), F = {}; B.Track.frame(${SX} + g, F); const lat = B.Track.lane(${SX} + g, 0);
    C.aim(cam, window.__cp, { x: F.x + F.rx * lat, y: F.y + 2.4, z: F.z + F.rz * lat }, 44, 0); }`,
};
