// P02, 06:30 West Oakland, before sunrise: an eastbound metro train's headlights come up out of the dark Transbay Tube
// portal and it rolls out of the mouth toward us. Low in the trench on the empty westbound track (none due during the
// shot), 40 mm, 0.9 m above the rail, a slow push from 60 to 50 m off the mouth. (The Tube's Oakland portal: track M2 at s
// 32004-32044, the trench to 32114; the westbound track M1.1 alongside, 5 m north.)
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const S_CAM = 32082, S_MOUTH = 32030, LEAD = 5.0, FOV = 28.4;
export default {
  hash: '#auto&t=06:25&q=ultra&w=clear', warm: 45, frames: 240,
  setup: `async () => { ${cine}; ${metro}; const M = window.__m, B = window.__bayline;
    await M.day('2026-09-29', 6 * 3600 + 25 * 60); const N = B.MetroSim.net, F = {}, T = N.byId['M2'];
    const at = (s, side, h) => { N.frame(T, s, F); return { x: F.x + F.rx * side, y: F.y + h, z: F.z + F.rz * side }; };
    // between the tracks, 3.7 m left of the eastbound one's centre (its train passes 2 m clear), eye 0.9 m above the rail
    // (the lamp post over the portal's far side then stands off the middle of the mouth); the look: the mouth's middle
    window.__P = { c0: at(${S_CAM} + 10, -3.7, 0.95), c1: at(${S_CAM}, -3.7, 0.9), q: at(${S_MOUTH}, -1.6, 2.6) }; __cine.put(window.__P.c0, window.__P.q);
    window.__dep = M.pass({ track: 'M2', s: ${S_CAM} }, { heading: 97 }, 6 * 3600 + 28 * 60, ${LEAD}, { focus: true });
    // (nothing may come down the westbound track at the camera during the shot)
    const wb = M.passes(window.__P.c1, { heading: 277 }, window.__dep.t - 5, window.__dep.t + 12); window.__dep.clear = !wb.length;
    return window.__dep; }`,
  prime: `() => { const B = window.__bayline, d = window.__dep; B.Env.setClock(d.t); B.MetroSim.setFocus(d.key); __cine.put(window.__P.c0, window.__P.q); return d.key + ' ' + d.line + ' to ' + d.dest + (d.clear ? ' (westbound track clear)' : ' WESTBOUND TRAIN DUE'); }`,
  before: `(t) => { const B = window.__bayline; B.MetroSim.setFocus(window.__dep.key); B.Env.camera.fov = ${FOV}; }`,
  cam: `(t, cam) => { const C = __cine, P = window.__P, k = C.ease(t / 8); const p = C.mix(P.c0, P.c1, k);
    C.put(p, P.q); C.aim(cam, p, P.q, ${FOV}, 0); }`,
};
