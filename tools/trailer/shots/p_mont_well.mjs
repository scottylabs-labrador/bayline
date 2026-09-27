// P04 (promo v3, bars 5-11): 08:00 at Montgomery: the camera descends the inclined well on the middle stair of an
// escalator bank, 1.7 m over the nosings, on a 32 mm lens: riders stand on the escalators either side (going down
// ahead of us, coming up toward us), the platform and its tiled wall open up at the foot of the well.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
import { metroReady, stationBuilt, setPeople, clearNear } from './_st.mjs';
const DAY = '2026-09-29', T0 = 8 * 3600, DUR = 6.2;
export default {
  hash: '#auto&t=08:00&q=ultra&w=clear', warm: 40, frames: 186, maxDsf: 1.5,
  setup: `async () => { ${cine}; ${metro}; const B = window.__bayline; if (!await (${metroReady})()) return 'metro not ready';
    await __m.day('${DAY}', ${T0}); const st = B.MetroStations.byId.MONT;
    __cine.put({ x: st.x, y: -2, z: st.z }, { x: st.x + 10, y: -4, z: st.z }); return 'ok'; }`,
  prime: `async () => { const B = window.__bayline, M = B.MetroStations, st = M.byId.MONT; await (${stationBuilt})('MONT');
    const E = (st.res && st.res.esc) || []; if (E.length < 2) return 'no escalators';
    // a bank: two escalators with the same yaw, feet within 6 m (the stair between them); the one nearest the middle
    let bank = null, bd = 1e9;
    for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) { const a = E[i], b = E[j];
      if (Math.abs(Math.atan2(Math.sin(a.yaw - b.yaw), Math.cos(a.yaw - b.yaw))) > 0.05 || Math.hypot(a.x - b.x, a.z - b.z) > 6) continue;
      const d = Math.hypot((a.x + b.x) / 2 - st.x, (a.z + b.z) / 2 - st.z); if (d < bd) { bd = d; bank = [a, b]; } }
    if (!bank) return 'no bank'; const [a, b] = bank, H = a.H, run = a.run, dx = Math.cos(a.yaw), dz = -Math.sin(a.yaw), y0 = a.y;
    // the steps' surface along the run from the foot: flat, the incline (30 degrees), flat again at the head
    const x0 = 1.9, x1 = run - 2.0, stepY = (x) => y0 + H * Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const P = (x, h) => ({ x: mid.x + dx * x, y: stepY(x) + h, z: mid.z + dz * x });
    window.__s = { P, xa: run - 1.2, xb: run - 9.0, look: 13 };
    // riders: standing on each escalator, spaced 3 to 4 m, moving with the steps (0.508 m/s)
    const R = []; let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const e of bank) for (let x = 2.5 + rnd() * 2; x < e.run - 2; x += 3.1 + rnd() * 1.4) R.push({ e, x, ph: rnd() * 6 });
    window.__riders = { R, stepY, dx, dz };
    // (after the crowd moves each frame: the riders at the capture time, standing on the moving steps)
    B.StationCrowds.after = () => { const t = B.capture.t, W = window.__riders, L = [];
      for (const r of W.R) { const e = r.e; let xx = r.x + e.dir * 0.508 * t; const span = e.run - 3; xx = 1.5 + ((xx - 1.5) % span + span) % span;
        L.push({ x: e.x + W.dx * xx, y: e.y + (W.stepY(xx) - W.stepY(0)), z: e.z + W.dz * xx, yaw: e.dir > 0 ? e.yaw : e.yaw + Math.PI, mode: 0, ph: r.ph }); }
      (${setPeople})(L); (${clearNear})(B.Env.camera.position, 3.4, L); };   // (and none of the crowd within 3.4 m of the lens)
    B.Env.setClock(${T0} + 30); B.Env.time.scale = 1; return { H: +H.toFixed(1), run: +run.toFixed(1), riders: R.length }; }`,
  before: `(t) => { const C = __cine, s = window.__s, k = C.ease(t / ${DUR}), x = s.xa + (s.xb - s.xa) * k; C.put(s.P(x, 1.7), s.P(x - s.look, 1.0)); }`,
  cam: `(t, cam) => { const C = __cine, s = window.__s, k = C.ease(t / ${DUR}), x = s.xa + (s.xb - s.xa) * k; C.aim(cam, s.P(x, 1.7), s.P(x - s.look, 1.0), 40, 0); }`,
};
