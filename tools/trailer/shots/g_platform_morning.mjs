// morning on the Palo Alto platform, on foot: facing the low sun down the line, light through the trees, commuters
// waiting as a northbound train comes in (the player's own walking camera, turning slowly)
import { cine, passClock } from './_lib.mjs';
export default {
  hash: '#auto&t=08:02&q=ultraplus!&w=clear&at=palo_alto', warm: 45, frames: 270,
  setup: `async () => { ${cine}; const B = window.__bayline, st = B.Stations.list[B.Track.byId.palo_alto.idx];
    window.__dep = (${passClock})(st.stop[0], 0, 8 * 3600 + 2 * 60, 13); return window.__dep; }`,
  prime: `() => { const B = window.__bayline, d = window.__dep, P = B.Player, s = B.Env.sunDir; B.Env.setClock(d.t); if (P.mode !== 'walk') P.setMode('walk');
    window.__yaw0 = Math.atan2(s.x, -s.z) + 0.42; P.look.yaw = window.__yaw0; P.look.pitch = 0.03; return { trip: d.trip, yaw: +window.__yaw0.toFixed(2) }; }`,
  before: `(t) => { const P = window.__bayline.Player; P.look.yaw = window.__yaw0 - 0.10 * __cine.ease(t / 9); P.look.pitch = 0.03; }`,
};
