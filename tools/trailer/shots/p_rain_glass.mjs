// P17 p_rain_glass (TRAINS): night rain, inside a car of an eastbound train as it climbs out of the Transbay Tube's
// Oakland portal: the window glass in focus, rain on it (beads, fresh drops, drops sliding back along the car at speed,
// each a small lens with a sharp inverted image of the lights), the lights of West Oakland out of focus behind it
// (bokeh), the lit cabin faintly mirrored in the pane. MetroKit's cinema glass (MetroKit.look({ cinema })): the car the
// camera is in draws its glazing from the grabbed frame with a thin-lens blur focused on the glass.
// Same train as P16 (the Antioch train through the Tube after 21:40, 2026-09-29), a few minutes later.
import { cine } from './_lib.mjs';
import { metro } from './_metro.mjs';
const DATE = '2026-09-29', AFTER = 21 * 3600 + 43 * 60;
const PORTAL_S = 32010;            // M2 (eastbound Tube track): the Oakland portal; trench, grade, then the aerial at 32230
const CAR = 4, SIDE = -1;          // the car we ride in (0 = the lead car), the side we look out of (-1: left of travel: north)
const LEAD = -2.8;                 // s before our car's middle passes the portal when the capture starts (< 0: after,
                                   // in the trench: the lights come into view as the train climbs to the aerial)
export default {
  hash: '#auto&t=21:43&q=ultra&w=rain&ll=37.8088,-122.3150,12,80,-0.05', warm: 50, frames: 180, fps: 30, maxDsf: 2,
  setup: `async () => { ${cine}; ${metro};
    const B0 = window.__bayline, t0 = performance.now();          // (the metro network and timetable load after boot)
    while (!(B0.MetroSim && B0.MetroSim.net && B0.MetroSim.net.byId && B0.MetroSim.net.byId.M2 && B0.MetroSim.plans && B0.MetroSim.plans.length) && performance.now() - t0 < 90000) await new Promise(r => setTimeout(r, 250));
    await __m.day('${DATE}', ${AFTER});
    const L = window.__bayline.MetroSim.PERF.bart.carLen;
    const d = __m.pass({ track: 'M2', s: ${PORTAL_S} + (${CAR} + 0.5) * L }, { heading: 97, tol: 45, kind: 'bart' }, ${AFTER}, ${LEAD}, { focus: true });
    if (!d) return 'no train';
    window.__dep = d;
    // the camera rig: our car's body frame (sway included), a seated rider's eye by the window, looking forward and out
    const V = THREE.Vector3, M4 = THREE.Matrix4, _b = new M4(), _w = new M4(), _i = new M4();
    window.__rig = (t) => {
      const B = window.__bayline, tr = __m.train(d.key), cs = tr && tr.entry && tr.entry.consist && tr.entry.consist.cars;
      if (!cs) { const P = __m.pose(d.key, ${CAR}); if (!P) return null; const e = __m.rel(P, 1.9, ${SIDE} * 1.2, 2.17); return { eye: e, at: __m.rel(P, 9, ${SIDE} * 9, 2.1), car: null }; }
      const car = cs[tr.lead === 0 ? ${CAR} : cs.length - 1 - ${CAR}]; car.root.updateMatrixWorld();
      _w.copy(car.root.matrixWorld); if (car.bm) _w.multiply(_b.fromArray(car.bm, 0));
      _i.copy(car.root.matrixWorld).invert();
      // travel direction and our side in the car's design frame
      const P = __m.pose(d.key, ${CAR}), f = new V(P.fwd.x, 0, P.fwd.z).transformDirection(_i), r = new V(P.right.x, 0, P.right.z).transformDirection(_i);
      const sx = Math.sign(f.x) || 1, sz = (Math.sign(r.z) || 1) * ${SIDE};
      // 0.28 m from the glass (at z 1.578), a little ahead of the first window's middle, the pair's mullion at the right
      // edge of the frame; a slow push toward the glass while the view turns a little forward
      const k = __cine.ease(t / 6), th = (34 + 4 * k) * Math.PI / 180, zc = 1.29 + 0.03 * k, a0 = 2.1;
      const eye = new V(sx * a0, 2.15, sz * zc).applyMatrix4(_w);
      const at = new V(sx * (a0 + 10 * Math.sin(th)), 2.15, sz * (zc + 10 * Math.cos(th))).applyMatrix4(_w);
      at.y = eye.y - 0.3;                                          // (level: the car's roll doesn't tilt the view)
      return { eye, at, car };
    };
    return d; }`,
  prime: `async () => { const B = window.__bayline, d = window.__dep; if (!d) return 'no train';
    B.Env.setClock(d.t); B.Env.time.scale = 1; __m.focus(d.key);
    if (B.Post) { B.Post.debug.ae = false; B.Post.debug.expo = 1.25; }
    B.MetroKit.look({ refl: 1, cinema: { bokeh: 0.055, gain: 8, thr: 0.8, lens: 0.3, beads: 0.75, fresh: 0.12, focus: 0, refl: 0.25, tint: 1.25 } });
    for (let i = 0; i < 40 && !(__m.train(d.key) && __m.train(d.key).entry); i++) await new Promise(r => setTimeout(r, 100));
    // a pre-roll in capture mode with the clock held: a few frames drawn from inside the car (MetroKit picks the car's
    // cinema glass by the camera; its programs compile), and capture mode left on, so the game's own loop never draws
    // the free camera (outside the car, clamped above the trench) before the first captured frame
    B.capture.cam = (t, c) => { const R = window.__rig(0); if (R) { __cine.aim(c, R.eye, R.at, 24, 0); c.near = 0.03; c.updateProjectionMatrix(); } };
    B.capture.on = true;
    for (let i = 0; i < 8; i++) { B.Env.setClock(d.t); __m.focus(d.key); const R = window.__rig(0); if (R) { __cine.put(R.eye, R.at); B.MetroKit.viewHint(R.eye, 24); } B.stepFrame(1); await new Promise(r => setTimeout(r, 30)); }
    B.Env.setClock(d.t);
    return JSON.stringify({ key: d.key, line: d.line, dest: d.dest, cars: d.cars, t: d.t, v: d.v }); }`,
  before: `(t) => { const B = window.__bayline, d = window.__dep; if (!d) return; __m.focus(d.key);
    // rain arrives on the glass once our car is out: a few old beads in the Tube, fresh drops and sliders outside
    const out = B.Env.time.sec - (d.t + ${LEAD}); B.MetroKit.look({ cinema: { fresh: 0.12 + 0.88 * __cine.ease((out - 0.2) / 2.2) } });
    const R = window.__rig(t); if (R) { __cine.put(R.eye, R.at); if (B.MetroKit.viewHint) B.MetroKit.viewHint(R.eye, 24); } }`,
  cam: `(t, cam) => { const R = window.__rig(t); if (!R) return; __cine.aim(cam, R.eye, R.at, 24, 0); if (cam.near > 0.03) { cam.near = 0.03; cam.updateProjectionMatrix(); } }`,
};
