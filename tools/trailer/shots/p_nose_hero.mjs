// Climax hero close-up (TRAINS): night at West Oakland, a D car's nose low and tight on a 90 mm lens as the Antioch
// train pulls out of the platform: standing, its headlights and top light bar blooming; then it starts, grows in the
// frame and slides past the camera at the platform's leaving end. Same train as P16 / P17 (2026-09-29), after them.
// The camera stands 13 m ahead of the stopped nose, 2.55 m right of the track (the platform side), 1.5 m above the
// rail (below the headlights), and pans with the nose, slowly and only so far (no whip).
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const DATE = '2026-09-29', AFTER = 21 * 3600 + 46 * 60;
const AHEAD = 13, SIDE = 2.55, HCAM = 1.5, FOV = 15.2;      // (90 mm: vertical fov 2 atan(12 / 90) = 15.2 deg)
const TILT = 1.5;                                            // deg above the nose: the lit top bar inside the 2.39 band
const LEAD = 1.2;                                            // s before the departure when the capture starts
export default {
  hash: '#auto&t=21:46&q=ultra&w=clear&ll=37.8038,-122.2931,14,280,-0.05', warm: 50, frames: 780, fps: 120,
  setup: `async () => { ${cine}; ${metro};
    const B0 = window.__bayline, t0 = performance.now();
    while (!(B0.MetroSim && B0.MetroSim.net && B0.MetroSim.plans && B0.MetroSim.plans.length) && performance.now() - t0 < 90000) await new Promise(r => setTimeout(r, 250));
    await __m.day('${DATE}', ${AFTER});
    const d = __m.depart('WOAK', '2', ${AFTER}, ${LEAD}, { focus: true }, { dest: 'Antioch', kind: 'bart' });
    if (!d) return 'no departure';
    window.__dep = d;
    // the nose of the lead car (live) and the camera (fixed where the train stands; set in prime)
    const L = B0.MetroSim.PERF.bart.carLen;
    window.__nose = (h) => { const P = __m.pose(d.key, 0); return P ? __m.rel(P, L / 2 - 0.15, 0, h) : null; };
    return d; }`,
  prime: `async () => { const B = window.__bayline, d = window.__dep; if (!d) return 'no departure';
    B.Env.setClock(d.t); B.Env.time.scale = 1; __m.focus(d.key);
    // (hold the clock for a few of the game's frames: the runtime poses the train where it stands at d.t; after the
    // warm-up it was a kilometre down the line)
    for (let i = 0; i < 12 || !(__m.train(d.key) && __m.train(d.key).entry); i++) { if (i > 60) break; B.Env.setClock(d.t); __m.focus(d.key); await new Promise(r => setTimeout(r, 60)); }
    const P = __m.pose(d.key, 0), L = B.MetroSim.PERF.bart.carLen;
    const cam = __m.rel(P, L / 2 + ${AHEAD}, ${SIDE}, ${HCAM}), nose0 = window.__nose(2.3);
    window.__hero = { cam, nose0, fwd: P.fwd, right: P.right };
    if (B.Post) { B.Post.debug.ae = false; B.Post.debug.expo = 1.25; }
    // the cab dark behind the windscreens (the driver's lights off), the lamps a touch under the game's (they are tuned
    // to read from far away) and their glow billboards softer, so the pods keep their shape inside the bloom
    B.MetroKit.look({ cab: 0.03, lamps: 0.7, glow: 0.45 });
    // pre-roll in capture mode with the clock held (MetroKit builds the lead car for this camera; the game's loop
    // doesn't draw the free camera before the first captured frame)
    const up = (q, r) => ({ x: q.x, y: q.y + r * Math.tan(${TILT} * Math.PI / 180), z: q.z });
    window.__hero.up = up;
    B.capture.cam = (t, c) => { __cine.aim(c, cam, up(nose0, Math.hypot(nose0.x - cam.x, nose0.z - cam.z)), ${FOV}, 0); };
    B.capture.on = true;
    for (let i = 0; i < 8; i++) { B.Env.setClock(d.t); __m.focus(d.key); __cine.put(cam, nose0); if (B.MetroKit.viewHint) B.MetroKit.viewHint(cam, ${FOV}); B.stepFrame(1); await new Promise(r => setTimeout(r, 30)); }
    B.Env.setClock(d.t);
    return JSON.stringify({ key: d.key, line: d.line, dest: d.dest, cars: d.cars, dep: d.tDep, t: d.t }); }`,
  before: `(t) => { const B = window.__bayline, d = window.__dep, H = window.__hero; if (!d || !H) return; __m.focus(d.key);
    __cine.put(H.cam, H.nose0); if (B.MetroKit.viewHint) B.MetroKit.viewHint(H.cam, ${FOV}); }`,
  // aim: the nose, followed with a lag and a cap on the pan (the view turns at most ~26 deg from the first framing),
  // a slow creep toward the track while the train stands
  cam: `(t, cam) => { const H = window.__hero; if (!H) return; const C = __cine;
    const n = window.__nose(2.3) || H.nose0, c = H.cam;
    const a0 = Math.atan2(H.nose0.x - c.x, H.nose0.z - c.z), a1 = Math.atan2(n.x - c.x, n.z - c.z);
    let da = ((a1 - a0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI; da = Math.sign(da) * Math.min(Math.abs(da), 0.46) * 0.92;
    const r = Math.hypot(n.x - c.x, n.z - c.z), aim = a0 + da, k = C.ease(t / 2.5);
    const p = { x: c.x - H.right.x * 0.25 * k, y: c.y, z: c.z - H.right.z * 0.25 * k };
    const q = H.up({ x: p.x + Math.sin(aim) * r, y: n.y - 0.1, z: p.z + Math.cos(aim) * r }, r);
    C.aim(cam, p, q, ${FOV}, 0); }`,
};
