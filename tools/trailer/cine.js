// Page-side helpers for trailer shots (installed as window.__cine by each shot's setup)
window.__cine = (() => {
  const B = window.__bayline;
  const ease = (k) => { k = Math.max(0, Math.min(1, k)); return k * k * (3 - 2 * k); };
  const ll = (lat, lon, y) => { const w = B.Globe.ll2w(lat, lon); return { x: w.x, y, z: w.z }; };
  const mix = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k });
  const add = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
  // Catmull-Rom through points (k in 0..1 over the whole path)
  function spline(P, k) {
    const n = P.length - 1, f = Math.max(0, Math.min(0.99999, k)) * n, i = Math.floor(f), u = f - i;
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[Math.min(n, i + 1)], p3 = P[Math.min(n, i + 2)];
    const c = (a, b, c2, d) => 0.5 * ((2 * b) + (-a + c2) * u + (2 * a - 5 * b + 4 * c2 - d) * u * u + (-a + 3 * b - 3 * c2 + d) * u * u * u);
    return { x: c(p0.x, p1.x, p2.x, p3.x), y: c(p0.y, p1.y, p2.y, p3.y), z: c(p0.z, p1.z, p2.z, p3.z) };
  }
  // the free camera (the player's, so streaming follows it) at p looking at q
  function put(p, q) { const P = B.Player; if (!(B.Flight && B.Flight.active) && P.mode !== 'fly') P.setMode('fly'); P.fly.x = p.x; P.fly.y = p.y; P.fly.z = p.z;
    const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z; P.look.yaw = Math.atan2(dx, -dz); P.look.pitch = Math.atan2(dy, Math.hypot(dx, dz)); }
  function aim(cam, p, q, fov, roll) { cam.position.set(p.x, p.y, p.z); cam.up.set(Math.sin(roll || 0), Math.cos(roll || 0), 0); cam.lookAt(q.x, q.y, q.z);
    if (fov && Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); } if (cam.near > 0.5) { cam.near = 0.5; cam.updateProjectionMatrix(); } }
  const ground = (x, z) => B.Player.groundAt ? B.Player.groundAt(x, z) : B.Terrain.h(x, z);

  // ---------------- trains
  const F = {};
  function trainPose(tr, carIdx) {        // a car's position (default the middle one) and the direction of travel
    const cs = tr && tr.entry && tr.entry.consist ? tr.entry.consist.cars : null;
    B.Track.frame(tr.s, F); const sg = tr.dir ? 1 : -1, l = Math.hypot(F.dx, F.dz) || 1, fwd = { x: F.dx / l * sg, y: 0, z: F.dz / l * sg };
    let p;
    if (cs && cs.length) { const i = carIdx === undefined ? Math.floor(cs.length / 2) : carIdx < 0 ? (tr.dir ? 0 : cs.length - 1) : (tr.dir ? carIdx : cs.length - 1 - carIdx); /* car 0 is the south end: it leads southbound */ const g = cs[Math.max(0, Math.min(cs.length - 1, i))].group.position; p = { x: g.x, y: g.y + 2, z: g.z }; }
    else p = { x: F.x, y: F.y + 2, z: F.z };
    return { p, fwd, right: { x: -fwd.z, y: 0, z: fwd.x }, v: tr.v };
  }
  function rel(pose, a, b, h) { return { x: pose.p.x + pose.fwd.x * a + pose.right.x * b, y: pose.p.y + h, z: pose.p.z + pose.fwd.z * a + pose.right.z * b }; }
  // the running train nearest a place (optionally: direction, minimum speed)
  function pickTrain(lat, lon, opt = {}) {
    const w = ll(lat, lon, 0); let best = null, bd = opt.within || 6000;
    for (const tr of B.Sim.running) { if (opt.dir !== undefined && tr.dir !== opt.dir) continue; if (opt.minV && tr.v < opt.minV) continue; if (tr.hidden) continue;
      B.Track.frame(tr.s, F); const d = Math.hypot(F.x - w.x, F.z - w.z); if (d < bd) { bd = d; best = tr; } }
    return best;
  }
  // ---------------- aircraft
  function acPose() {
    const F2 = B.Flight, a = F2.ac, E = F2.euler, h = E.hdg, cp = Math.cos(E.pitch);
    const fwd = { x: Math.sin(h) * cp, y: Math.sin(E.pitch), z: -Math.cos(h) * cp }, flat = { x: Math.sin(h), y: 0, z: -Math.cos(h) };
    return { p: { x: a.pos.x, y: a.pos.y, z: a.pos.z }, fwd: flat, dir: fwd, right: { x: Math.cos(h), y: 0, z: Math.sin(h) }, hdg: h, pitch: E.pitch, roll: E.roll, v: a.vel };
  }
  return { ease, ll, mix, add, spline, put, aim, ground, trainPose, rel, pickTrain, acPose };
})();
