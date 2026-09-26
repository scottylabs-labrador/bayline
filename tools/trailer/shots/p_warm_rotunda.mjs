// P12 (promo v3, world montage, 2 bars): blue hour at Warm Springs: low beside the entrance rotunda (1.2 m, 50 mm), the
// glass drum and its glowing art glass on the left third, the station on the right two-thirds, and a train running
// through behind it, its lit windows streaking past (the fastest pass behind the drum between 19:15 and 19:45).
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
import { metroReady, stationBuilt, clearLine, offRoad } from './_st.mjs';
const DAY = '2026-09-29', T0 = 19 * 3600 + 15 * 60, DUR = 4.0;
export default {
  hash: '#auto&t=19:24&q=ultra&w=clear', warm: 40, frames: 120, maxDsf: 1.5,
  setup: `async () => { ${cine}; ${metro}; const B = window.__bayline; if (!await (${metroReady})()) return 'metro not ready';
    await __m.day('${DAY}', ${T0} + 540); const st = B.MetroStations.byId.WARM;
    __cine.put({ x: st.x + 60, y: 30, z: st.z }, { x: st.x, y: 20, z: st.z }); return 'ok'; }`,
  prime: `async () => { const B = window.__bayline, MS = B.MetroSim, st = B.MetroStations.byId.WARM; await (${stationBuilt})('WARM');
    const R = st.res && st.res.info && st.res.info.rotunda; if (!R) return 'no rotunda';
    const [cx, cz] = R.c, [fx, fz] = R.foot, [tx, tz] = R.top; let dx = fx - tx, dz = fz - tz; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    // the camera: away from the station, as far round to the right as a clear line of sight allows
    const g = R.gy, D0 = R.R + 33, dirAt = (a) => [dx * Math.cos(a) - dz * Math.sin(a), dz * Math.cos(a) + dx * Math.sin(a)];
    // (clear of buildings on the line of sight, and of roads and their traffic at the camera and just in front of it)
    // (and no building nearer than the drum inside the frame: the drum on the left third, 22 degrees each side)
    const inView = (a) => { const [ox, oz] = dirAt(a), cam = { x: cx + ox * D0, z: cz + oz * D0 }, f = [-ox, -oz], r = [-f[1], f[0]], aim = { x: cx + r[0] * 7.5, z: cz + r[1] * 7.5 };
      const vx = aim.x - cam.x, vz = aim.z - cam.z, vl = Math.hypot(vx, vz), dD = Math.hypot(cx - cam.x, cz - cam.z) - R.R;
      for (const b of (B.Towns && B.Towns.buildingsAt ? B.Towns.buildingsAt(cam.x, cam.z, 60) : [])) { const P = b.pts;
        for (let i = 0; i < P.length; i += 2) { const px = P[i] - cam.x, pz = P[i + 1] - cam.z, d = Math.hypot(px, pz); if (d > dD) continue;
          const ang = Math.acos(Math.max(-1, Math.min(1, (px * vx + pz * vz) / (d * vl || 1)))); if (ang < 0.4) return false; } }
      return true; };
    const ok = (a) => { const [ox, oz] = dirAt(a); return (${clearLine})({ x: cx + ox * (D0 + 2), z: cz + oz * (D0 + 2) }, { x: cx + ox * (R.R + 1), z: cz + oz * (R.R + 1) })
      && [D0, D0 - 5, D0 - 10].every(d => (${offRoad})(cx + ox * d, cz + oz * d, 2.5)) && inView(a); };
    const A = [0.45, 0.3, 0.6, 0.38, 0.52, 0.22, 0.75, 0.15, 0.9, 0.05, -0.1, 1.05].find(ok) ?? 0.3;
    const [ox, oz] = dirAt(A), cam = { x: cx + ox * D0, y: g + 1.25, z: cz + oz * D0 };
    // the view: the drum on the left third (aim 7.5 m right of it at its distance: a 50 mm frame is ~30 m wide there)
    const fwd = [-ox, -oz], right = [-fwd[1], fwd[0]], aimAt = { x: cx + right[0] * 7.5, z: cz + right[1] * 7.5 };
    // the fastest pass of a train head across the view's centre line behind the drum
    const vx = aimAt.x - cam.x, vz = aimAt.z - cam.z, vl = Math.hypot(vx, vz), ux = vx / vl, uz = vz / vl, o = {};
    let best = null;
    for (const e of MS.arrivals('WARM', ${T0}, 60, { withLast: true })) { if (e.arr > ${T0} + 1800) break; const L = e.leg, P = L.path;
      // where the view's centre line crosses this leg's path (sampled 40..140 m out)
      let hit = null; for (let d = 40; d <= 140 && !hit; d += 2) { const x = cam.x + ux * d, z = cam.z + uz * d, pr = P.project(x, z, Math.max(0, L.stops[e.k].ps - 400), L.stops[e.k].ps + 400); if (pr.d < 1.5) hit = pr.ps; }
      if (hit === null) continue;
      for (const [a0, a1] of [[e.arr - 150, e.arr], [e.dep, e.dep + 150]]) { let a = a0, b = a1; MS.legState(L, a, o); const s0 = o.ps; MS.legState(L, b, o); const s1 = o.ps;
        if (!((s0 - hit) * (s1 - hit) < 0)) continue; for (let i = 0; i < 48; i++) { const m = (a + b) / 2; MS.legState(L, m, o); if ((o.ps - hit) * (s0 - hit) > 0) a = m; else b = m; }
        MS.legState(L, b, o); if (!best || o.v > best.v) best = { t: b, v: o.v, key: L.chainKey || e.plan.key }; } }
    if (!best) return 'no pass';
    window.__s = { p0: cam, p1: { x: cam.x - right[0] * 1.2, y: cam.y + 0.05, z: cam.z - right[1] * 1.2 }, q: { x: aimAt.x, y: g + 7.3, z: aimAt.z } };
    B.Env.setClock(best.t - 1.6); B.Env.time.scale = 1; __m.focus(best.key);
    return { a: A, v: +best.v.toFixed(1), t: Math.round(best.t) }; }`,
  before: `(t) => { const C = __cine, s = window.__s, k = C.ease(t / ${DUR}); C.put(C.mix(s.p0, s.p1, k), s.q); }`,
  cam: `(t, cam) => { const C = __cine, s = window.__s, k = C.ease(t / ${DUR}); C.aim(cam, C.mix(s.p0, s.p1, k), s.q, 27, 0); }`,
};
