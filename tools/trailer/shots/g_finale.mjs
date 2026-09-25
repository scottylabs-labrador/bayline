// the finale, rail and flight in one frame: golden hour beside the tracks at San Bruno. A southbound train races toward
// and past the camera (up on a lineside pole's height), then the view lifts to a 747, just off SFO 28R, climbing out
// right over the line toward the sunset (60 fps: slow motion). The jet is placed so it crosses the line as the train does.
import { cine, flyReady, rwy, passClock } from './_lib.mjs';
const LEAD = 4.4, V = 172 * 0.5144, GAM = 6.5 * Math.PI / 180, HX = 140;
export default {
  hash: '#auto&t=18:30&q=ultraplus!&w=clear&fly=b744,KSFO,28R,runway', warm: 50, frames: 450, fps: 60,
  setup: `async () => { ${cine}; await (${flyReady})(); const B = window.__bayline, e = (${rwy})('KSFO', '28R'), Fr = {};
    let prev = null, sX = null; const s0 = B.Track.byId.south_sf.s, s1 = B.Track.byId.broadway.s;
    for (let s = s0; s <= s1; s += 4) { B.Track.frame(s, Fr); const dx = Fr.x - e.x, dz = Fr.z - e.z, along = dx * e.ux + dz * e.uz, side = dx * e.uz - dz * e.ux;
      if (along > 3000) { if (prev !== null && Math.sign(side) !== Math.sign(prev)) { sX = s; break; } prev = side; } }
    window.__e = e; window.__sX = sX; if (sX === null) return 'no crossing';
    window.__dep = (${passClock})(sX, 1, 18 * 3600 + 30 * 60, ${LEAD}, 20); return { sX: Math.round(sX), dep: window.__dep }; }`,
  prime: `() => { const B = window.__bayline, F = B.Flight, C = __cine, e = window.__e, d = window.__dep, sX = window.__sX; if (!d) return 'no train';
    B.Env.setClock(d.t); B.Player.setFocus(d.key);
    const Fr = {}; B.Track.frame(sX, Fr); const gX = C.ground(Fr.x, Fr.z), dist = ${V} * ${LEAD}, h = e.hdg * Math.PI / 180;
    const along = (Fr.x - e.x) * e.ux + (Fr.z - e.z) * e.uz, cx = e.x + e.ux * along, cz = e.z + e.uz * along;     /* the centreline point over the track */
    const x0 = cx - e.ux * dist, z0 = cz - e.uz * dist, y0 = gX + ${HX} - Math.tan(${GAM}) * dist;
    F.ac.place({ x: x0, y: y0, z: z0, hdg: h, pitch: 11 * Math.PI / 180, fpa: ${GAM}, speed: ${V}, gear: 0, flaps: 1, thr: 1 }); F.fcs.airStart(${GAM});
    Object.assign(F.fcs.ap, { on: false }); F.ac.ctl.thr = 1; F.ac.ctl.gear = 0;
    /* the camera: 70 m up the line from the crossing (where the train comes from), 13 m to the side, 9 m up */
    const sc = sX - 70, Fc = {}; B.Track.frame(sc, Fc); const lat = B.Track.lane(sc, 1), side = lat >= 0 ? 1 : -1, o = lat + side * 13;
    window.__camP = { x: Fc.x + Fc.rx * o, y: C.ground(Fc.x + Fc.rx * o, Fc.z + Fc.rz * o) + 9, z: Fc.z + Fc.rz * o };
    return { along: Math.round(along), gX: Math.round(gX), lat: +lat.toFixed(1) }; }`,
  before: `(t) => { const B = window.__bayline, F = B.Flight; F.ac.ctl.thr = 1; F.ac.ctl.gear = 0; __cine.put(window.__camP, __cine.acPose().p); }`,
  cam: `(t, cam) => { const C = __cine, B = window.__bayline, tr = B.Sim.trainByKey(window.__dep.key), A = C.acPose().p;
    const T = tr ? C.trainPose(tr, -1).p : A, w = C.ease((t - 1.6) / 2.4), q = C.mix({ x: T.x, y: T.y + 0.5, z: T.z }, { x: A.x, y: A.y, z: A.z }, w);
    C.aim(cam, window.__camP, q, 54 - 8 * w, 0); }`,
};
