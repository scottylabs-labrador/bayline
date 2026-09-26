// P27 (113.0-130.1 s, WORLD): the whole Bay at night from 12 km, a slow orbit under the last title and into the end
// card: from over the ocean off Pacifica looking north-east across San Francisco, the Bay and the East Bay, round to
// over San Bruno looking north up the Bay to Richmond and San Pablo Bay (the north strip); the cities as fields of
// lights, the bridges as lines. The clock is the busiest evening minute of the timetable (most trains out in the open).
import { cine } from './_lib.mjs';
import { metroReady, metroBusiest, hideMapDots } from './_world.mjs';
const DUR = 25.0, CEN = [37.80000, -122.30000], R = 24000, H = 12000, TH0 = 235, TH1 = 188, AHEAD = 5000;
const path = `(t) => { const C = __cine, k = C.ease(t / ${DUR}), th = (${TH0} + (${TH1 - TH0}) * k) * Math.PI / 180, c = C.ll(${CEN}, 0);
  const p = { x: c.x + ${R} * Math.sin(th), y: ${H}, z: c.z - ${R} * Math.cos(th) };
  return { p, q: { x: c.x - ${AHEAD} * Math.sin(th), y: 0, z: c.z + ${AHEAD} * Math.cos(th) } }; }`;       // (a little beyond the centre: pitch ~ -22 deg)
export default {
  hash: '#auto&t=20:40&q=ultraplus!&w=clear&ll=37.69200,-122.53500,12000,1.05,-0.46', warm: 60, frames: 750, settle: 2500,
  setup: `async () => { ${cine}; window.__path = ${path}; const P = window.__path(0); __cine.put(P.p, P.q); return 1; }`,
  prime: `async () => { const ok = await (${metroReady})(90000); let r = null;
    if (ok) r = (${metroBusiest})(20 * 3600 + 15 * 60, 21 * 3600 + 30 * 60, 20, [37.45, -122.55, 38.08, -121.75]);
    const P = window.__path(0); __cine.put(P.p, P.q); return JSON.stringify(r); }`,
  before: `(t) => { const P = window.__path(t); __cine.put(P.p, P.q); }`,
  cam: `(t, cam) => { ${hideMapDots}; const P = window.__path(t), h = P.p.y; __cine.aim(cam, P.p, P.q, 40, 0);
    cam.far = Math.min(1.2e6, Math.sqrt(2 * 6371000 * h + 1e8) * 1.3 + 60000); cam.updateProjectionMatrix(); }`,
};
