// P14 alternative B (promo v3, world montage, 2 bars): 18:07 golden hour at Millbrae from the south-west: a drone 19 m
// up, 135 m south of the platforms and just west of the Caltrain tracks, 100 mm, looking north-east up the line: the
// Peninsula train pulls out toward us on the near tracks, the Red Line runs in beyond it, both stacked under the shared
// steel vault in the long light (SIM's meet on 2026-09-29).
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
import { metroReady, metroStop, stationBuilt } from './_st.mjs';
const DAY = '2026-09-29', T0 = 18 * 3600, DUR = 12.0;
export default {
  hash: '#auto&t=18:00&q=ultra&w=clear', warm: 45, frames: 360, maxDsf: 1.5,
  setup: `async () => { ${cine}; ${metro}; const B = window.__bayline; if (!await (${metroReady})()) return 'metro not ready';
    await __m.day('${DAY}', ${T0});
    const pr = __m.pair('MLBR', 'place_MLBR', ${T0}, 15, { margin: 30, into: 0, set: false }); if (!pr) return 'no pair'; window.__pr = pr;
    const ev = (${metroStop})('MLBR', pr.from - 120, { last: true, key: pr.metro.key }); if (!ev) return 'no metro stop'; window.__ev = ev;
    const F = ev.F; __cine.put({ x: F.x, y: F.y + 6, z: F.z }, { x: F.x - F.tx * 50, y: F.y + 4, z: F.z - F.tz * 50 });
    return { from: pr.from, to: pr.to, metro: pr.metro.key, pen: pr.pen.trip }; }`,
  prime: `async () => { const B = window.__bayline, ev = window.__ev, pr = window.__pr; await (${stationBuilt})('MLBR');
    const V = B.MetroStations.byId.MLBR.res.info.bridge, vault = V && V.vault; if (!vault) return 'no vault';
    // the Peninsula frame (s grows southward); the vault along the line
    const n = B.Track.nearest(ev.F.x, ev.F.z, 120); if (!n) return 'no Peninsula track';
    const G = {}, sOf = (x, z) => { const q = B.Track.nearest(x, z, 200); return q ? q.s : n.s; }, sA = sOf(...vault.a), sB = sOf(...vault.b), sN = Math.min(sA, sB), sS = Math.max(sA, sB);
    const P = B.Stations.list.find(q => q.id === 'place_MLBR'), pl = P && (P.plats.find(q => n.s > q.s0 - 120 && n.s < q.s1 + 120) || P.plats[0]);
    const sCam = (pl ? pl.s1 : sS + 90) + 135; B.Track.frame(sCam, G); const lanes = [B.Track.lane(sCam, 0), B.Track.lane(sCam, 1)];
    const latB = (ev.F.x - G.x) * G.rx + (ev.F.z - G.z) * G.rz, yP = G.y + (B.Stations.PH || 1.1), latC = Math.max(...lanes) + 10.5;
    const at = (s, lat, h) => { B.Track.frame(s, G); return { x: G.x + G.rx * lat, y: yP + h, z: G.z + G.rz * lat }; };
    // south-west of the station, 19 m up, 10 m west of the Caltrain tracks (clear of the lot and the trees in frame); a long lens north-east up the line: the Peninsula
    // on the near tracks, the Red Line beyond, both under the vault
    const latQ = Math.max(...lanes) * 0.55 + latB * 0.45;
    window.__s = { p0: at(sCam, latC, 19.0), p1: at(sCam - 3, latC, 18.8), q0: at((sN + sS) / 2, latQ, 5.2), q1: at((sN + sS) / 2, latQ, 5.1) };
    B.Env.setClock(pr.from - 14); B.Env.time.scale = 1; __m.focus(pr.metro.key); B.Player.setFocus && B.Player.setFocus(pr.pen.key);
    return { latC: +latC.toFixed(1), latB: +latB.toFixed(1), sN: Math.round(sN), sS: Math.round(sS), sCam: Math.round(sCam) }; }`,
  before: `(t) => { const C = __cine, s = window.__s, k = C.ease(t / ${DUR}); C.put(C.mix(s.p0, s.p1, k), C.mix(s.q0, s.q1, k)); }`,
  cam: `(t, cam) => { const C = __cine, s = window.__s, k = C.ease(t / ${DUR}); C.aim(cam, C.mix(s.p0, s.p1, k), C.mix(s.q0, s.q1, k), 13.7, 0); }`,
};
