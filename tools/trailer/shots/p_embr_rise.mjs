// P26 (106.9-113.0 s, WORLD): blue hour, the finale: at street level before Embarcadero's entrance A1 (Market & Drumm),
// its stairs going down and the lit Ferry Building tower beyond; then one continuous crane: up Market Street between the
// towers, tilting from the entrance to the tower, rising and pulling back over SoMa until the whole Bay lies ahead: the
// Bay Bridge, Yerba Buena, Oakland, Berkeley and Richmond up the East Bay shore, the hills against the last blue.
import { cine } from './_lib.mjs';
import { hideMapDots } from './_world.mjs';
const T = 19 * 3600 + 26 * 60, DUR = 9.2, H0 = 2.6, H1 = 2000, HOLD = 1.6;
const A = [37.79350, -122.39627];                  // Market St, 17 m south-west of entrance A1 (its stair opening faces here)
const AC = [37.79339, -122.39622];                 // the middle of Market St (the crane moves out to it as it starts to rise)
const B = [37.78610, -122.40800];                  // high over SoMa
const E = [37.79360, -122.39613];                  // entrance A1 (the built one, read from the station at prime if there)
const F = [37.79552, -122.39350];                  // the Ferry Building's clock tower
const Z = [37.82000, -122.30000];                  // across the Bay to Oakland / Emeryville (pitch ~ -11 deg at the end)
const path = `(t) => { const C = __cine; if (!window.__g0) { const a = C.ll(${A}, 0); window.__g0 = C.ground(a.x, a.z); }
  const u = Math.max(0, t - ${HOLD}) / (${DUR} - ${HOLD}), k = C.ease(u), h = ${H0} * Math.pow(${H1 / H0}, k);
  // out to the middle of Market St while below the cornices, straight up between the towers, then back over SoMa
  const a = C.ll(${A}, 0), ac = C.ll(${AC}, 0), b = C.ll(${B}, 0), s1 = C.ease(Math.min(1, k / 0.35)), s2 = C.ease(Math.max(0, (k - 0.7) / 0.3));
  const p = C.mix(C.mix(a, ac, s1), b, s2); p.y = window.__g0 + h;
  const push = Math.min(t, ${HOLD}) / ${HOLD} * 2.0; if (u <= 0) { const d = Math.hypot(window.__ent.x - a.x, window.__ent.z - a.z); p.x += (window.__ent.x - a.x) / d * push; p.z += (window.__ent.z - a.z) / d * push; }
  const e = { x: window.__ent.x, y: window.__g0 + 2.6, z: window.__ent.z }, f = C.ll(${F}, window.__g0 + 42), z = C.ll(${Z}, 0);
  const k1 = C.ease(Math.min(1, u / 0.3)), k2 = C.ease(Math.max(0, (u - 0.22) / 0.78));
  const q = C.mix(C.mix(e, f, k1), z, k2); return { p, q }; }`;
export default {
  maxDsf: 1.5,
  hash: '#auto&t=19:26&q=ultraplus!&w=clear&ll=37.79350,-122.39627,6,0.78,-0.02', warm: 55, frames: 276, settle: 2500,
  setup: `async () => { ${cine}; window.__g0 = null; window.__ent = __cine.ll(${E}, 0); window.__path = ${path}; const P = window.__path(0); __cine.put(P.p, P.q); return 1; }`,
  prime: `async () => { const B = window.__bayline; B.Env.setClock(${T}); B.Env.time.scale = 1; let st = null, t0 = performance.now();
    while (performance.now() - t0 < 60000) { const S = B.MetroStations; st = S && S.byId && S.byId.EMBR; if (st && st.state === 'built' && st.res) break; await new Promise(r => setTimeout(r, 400)); }
    const en = st && st.res && st.res.entrances ? st.res.entrances.find(x => /^A1 /.test(x.name || '')) : null; if (en) window.__ent = { x: en.wx, y: 0, z: en.wz };
    window.__g0 = null; const P = window.__path(0); __cine.put(P.p, P.q); return en ? 'A1 built' : 'A1 from GTFS'; }`,
  before: `(t) => { const P = window.__path(t); __cine.put(P.p, P.q); }`,
  cam: `(t, cam) => { ${hideMapDots}; const P = window.__path(t); __cine.aim(cam, P.p, P.q, 42, 0); cam.far = Math.max(cam.far, 120000); cam.updateProjectionMatrix(); }`,
};
