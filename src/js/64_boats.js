// Boats: the working, sailing Bay. Sailboats beating around the Crissy Field–Alcatraz waters and off Coyote Point,
// ferries shuttling from the Ferry Building to Oakland and Alameda, and container ships coming in under the Golden
// Gate to the Port of Oakland. Everything is a pure function of the clock (like the trains and planes), so every
// player sees the same boats. A few instanced draw calls; wakes are additive V-shaped decals.
const Boats = (() => {
  const group = new THREE.Group(); group.name = 'boats';
  const ll = (lat, lon) => Geo.ll2w(lat, lon);
  const F = {};
  let ready = false;
  const types = {};                    // name -> { mesh, list: [boat] }
  let wakeMesh = null;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qh = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1), ws = new THREE.Vector3(), XA = new THREE.Vector3(1, 0, 0);

  // ---------- geometry (vertex-coloured, local +X = bow, +Y up, +Z starboard) ----------
  function box(w, h, d, x, y, z, col) { return U.tint(U.place(new THREE.BoxGeometry(w, h, d), x, y, z), col); }
  function hull(L, B, D, col, deck) {
    // tapered mono-hull: a box with a pointed bow made from a scaled cylinder segment
    const g = [];
    const mid = new THREE.BoxGeometry(L * 0.72, D, B); mid.translate(-L * 0.14, D / 2 - D * 0.35, 0); g.push(U.tint(mid, col));
    const bow = new THREE.CylinderGeometry(B / 2, B / 2, D, 3, 1); bow.rotateY(Math.PI / 2); bow.scale(L * 0.36 / (B / 2) * 0.5, 1, 1); bow.translate(L * 0.22 + L * 0.09, D / 2 - D * 0.35, 0); g.push(U.tint(bow, col));   // prism edge points forward (+X)
    if (deck) { const dk = new THREE.BoxGeometry(L * 0.7, 0.06, B * 0.92); dk.translate(-L * 0.14, D * 0.66, 0); g.push(U.tint(dk, deck)); }
    return g;
  }
  function sailboat() {
    const g = hull(10, 3.2, 1.3, 0xf4f4f0, 0xb89a72);
    g.push(box(0.14, 13, 0.14, 0.6, 7.2, 0, 0xd8d8d8));                                            // mast
    g.push(box(4.2, 0.1, 0.1, -1.5, 1.6, 0, 0xc8c8c8));                                            // boom
    const main = new THREE.BufferGeometry();                                                        // mainsail: triangle, slightly curved
    main.setAttribute('position', new THREE.Float32BufferAttribute([0.5, 1.7, 0.05, 0.5, 13.2, 0.05, -3.5, 1.7, 0.35, 0.5, 1.7, -0.05, -3.5, 1.7, 0.25, 0.5, 13.2, -0.05], 3));
    main.setIndex([0, 1, 2, 3, 4, 5]); main.computeVertexNormals(); g.push(U.tint(main, 0xfbf8ef));
    const jib = new THREE.BufferGeometry();
    jib.setAttribute('position', new THREE.Float32BufferAttribute([0.8, 11.6, 0.05, 4.6, 1.1, 0.0, 0.8, 1.4, 0.4, 0.8, 11.6, -0.05, 0.8, 1.4, 0.3, 4.6, 1.1, -0.02], 3));
    jib.setIndex([0, 1, 2, 3, 4, 5]); jib.computeVertexNormals(); g.push(U.tint(jib, 0xf2efe6));
    return mergeAll(g);
  }
  function ferry() {
    const g = [];
    for (const z of [-3.6, 3.6]) g.push(...hull(40, 3.0, 2.6, 0xf2f3f4, null).map(x => x.translate(0, 0, z)));   // catamaran hulls
    g.push(box(34, 2.6, 10, -2, 3.3, 0, 0xf2f3f4));                    // main deck cabin
    g.push(box(33.4, 1.1, 10.1, -2, 3.4, 0, 0x1f3550));                // window band (lit at night via emissive map below)
    g.push(box(20, 2.2, 8, -4, 5.6, 0, 0xf2f3f4));                     // upper cabin
    g.push(box(19.4, 0.9, 8.1, -4, 5.8, 0, 0x1f3550));
    g.push(box(4, 1.6, 5, 5, 7.4, 0, 0xf2f3f4));                       // wheelhouse
    g.push(box(34.5, 0.3, 10.2, -2, 4.7, 0, 0x2d6ea8));                // blue stripe
    return mergeAll(g);
  }
  function containerShip() {
    const g = hull(290, 40, 18, 0x26303a, 0x6b2d28);
    g.push(box(250, 2.4, 40.4, -20, -2.6, 0, 0x8c2a24));               // red boot-top
    g.push(box(16, 26, 36, -120, 22, 0, 0xf1f1ec));                    // bridge/accommodation aft
    g.push(box(6, 8, 6, -126, 38, 0, 0x2a2a2a));                       // funnel
    const cols = [0x2f5d8a, 0xa8322d, 0xd9d4c7, 0x3e7d4a, 0xc98a2c, 0x6b6f76, 0x7e2f6b, 0x2c3e50];
    const r = U.rng(7);
    for (let bay = 0; bay < 17; bay++) for (let tier = 0; tier < 5; tier++) for (let row = 0; row < 3; row++) {
      if (r() < 0.12) continue;
      g.push(box(12, 2.6, 12.6, -95 + bay * 13.5, 10.5 + tier * 2.6, -13 + row * 13, cols[Math.floor(r() * cols.length)]));
    }
    return mergeAll(g);
  }
  function mergeAll(g) { for (const x of g) { if (!x.attributes.normal) x.computeVertexNormals(); if (x.attributes.uv) x.deleteAttribute('uv'); } return U.mergeGeometries(g); }

  // ---------- motion (pure functions of time) ----------
  const loops = [];      // sailboats: { cx, cz, rx, rz, w, ph, tack }
  const routes = [];     // ferries + ships: { pts: [{x,z}], cum, len, speed, dwell, period, offset, kind }
  function addRoute(kind, latlons, speed, dwell, count) {
    const pts = latlons.map(([a, b]) => ll(a, b)); const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const len = cum[cum.length - 1], leg = len / speed, period = 2 * (leg + dwell);
    for (let k = 0; k < count; k++) routes.push({ kind, pts, cum, len, speed, dwell, leg, period, offset: k * period / count });
  }
  function routePos(r, t, out) {
    // back and forth: dwell at A, run to B, dwell at B, run back
    let u = ((t + r.offset) % r.period + r.period) % r.period; let d, dir = 1, moving = 1;
    if (u < r.dwell) { d = 0; moving = 0; }
    else if (u < r.dwell + r.leg) { d = ease((u - r.dwell) / r.leg) * r.len; }
    else if (u < 2 * r.dwell + r.leg) { d = r.len; moving = 0; dir = -1; }
    else { d = (1 - ease((u - 2 * r.dwell - r.leg) / r.leg)) * r.len; dir = -1; }
    let i = 0; while (i < r.cum.length - 2 && r.cum[i + 1] < d) i++;
    const a = r.pts[i], b = r.pts[i + 1], t2 = (d - r.cum[i]) / Math.max(1e-6, r.cum[i + 1] - r.cum[i]);
    out.x = a.x + (b.x - a.x) * t2; out.z = a.z + (b.z - a.z) * t2;
    out.yaw = Math.atan2(-(b.z - a.z) * dir, (b.x - a.x) * dir); out.moving = moving;
    return out;
  }
  const ease = (x) => x < 0.08 ? x * x / 0.16 : x > 0.92 ? 1 - (1 - x) * (1 - x) / 0.16 : x;   // gentle speed-up/slow-down
  function init() {
    // sailboats: loops in open water (checked against the water mask)
    const spots = [[37.8105, -122.448, 700, 70], [37.815, -122.425, 600, 40], [37.806, -122.465, 450, 26], [37.585, -122.30, 800, 20], [37.62, -122.33, 700, 14], [37.535, -122.215, 600, 10]];
    const r = U.rng(42);
    for (const [la, lo, rad, n] of spots) {
      const c = ll(la, lo);
      for (let i = 0; i < n; i++) {
        const cx = c.x + (r() - 0.5) * rad * 1.6, cz = c.z + (r() - 0.5) * rad * 1.2;
        const rx = 90 + r() * 260, rz = 60 + r() * 180;
        let ok = true; for (let a = 0; a < 6.28; a += 0.5) if (!Terrain.isWater(cx + Math.cos(a) * (rx + 60), cz + Math.sin(a) * (rz + 60))) { ok = false; break; }
        if (ok && cz > -49000) loops.push({ cx, cz, rx, rz, w: (r() < 0.5 ? 1 : -1) * (2.6 + r() * 1.8) / Math.max(rx, rz), ph: r() * 6.28, tint: r() });
      }
    }
    // ferries (Ferry Building <-> Oakland Jack London Square, Alameda Main St, South San Francisco Oyster Point)
    addRoute('ferry', [[37.7955, -122.3920], [37.797, -122.37], [37.805, -122.34], [37.803, -122.315], [37.7953, -122.2815]], 14, 300, 2);
    addRoute('ferry', [[37.7955, -122.3920], [37.792, -122.37], [37.797, -122.33], [37.793, -122.305], [37.7908, -122.2945]], 13, 300, 1);
    addRoute('ferry', [[37.7955, -122.3920], [37.78, -122.378], [37.72, -122.36], [37.668, -122.37], [37.6645, -122.3805]], 14, 420, 1);
    // container ships: Golden Gate -> under the Bay Bridge (west span, between Treasure Island and Oakland) -> Port of Oakland
    addRoute('ship', [[37.815, -122.52], [37.8165, -122.478], [37.812, -122.43], [37.815, -122.39], [37.8135, -122.357], [37.805, -122.335], [37.799, -122.315]], 5.5, 3600, 2);
    const mk = (name, geo, n) => { const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1, envMapIntensity: 0.8 }), n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true; m.name = 'boats-' + name; group.add(m); types[name] = { mesh: m }; };
    mk('sail', sailboat(), loops.length); mk('ferry', ferry(), routes.filter(r => r.kind === 'ferry').length); mk('ship', containerShip(), routes.filter(r => r.kind === 'ship').length);
    // lit windows on ferries at night: an emissive copy of just the window bands is overkill; brighten the whole ferry a touch
    types.ferry.mesh.material.emissive = new THREE.Color(0xffd9a0); types.ferry.mesh.material.emissiveIntensity = 0;
    // wakes
    const wt = U.canvasTexture(128, 256, (c, w, h) => { c.clearRect(0, 0, w, h); const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.strokeStyle = g; c.lineWidth = 10; c.beginPath(); c.moveTo(w / 2, 0); c.lineTo(8, h); c.moveTo(w / 2, 0); c.lineTo(w - 8, h); c.stroke(); c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(w / 2 - 6, 0, 12, h * 0.8); });
    const wg = new THREE.PlaneGeometry(1, 1); wg.rotateX(-Math.PI / 2); wg.translate(0, 0, 0.5);   // origin at the stern, extends aft (+Z before yaw)
    wakeMesh = new THREE.InstancedMesh(wg, new THREE.MeshBasicMaterial({ map: wt, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55, fog: false }), loops.length + routes.length);
    wakeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); wakeMesh.frustumCulled = false; wakeMesh.renderOrder = 3; group.add(wakeMesh);
    Env.scene.add(group); ready = true;
  }
  const _o = {};
  function update(dt, env) {
    if (!ready) return;
    const t = env && env.time !== undefined ? env.time : Env.time.sec; const cam = env && env.camPos ? env.camPos : Env.camera.position;
    const far = 18000; let wi = 0;
    // sailboats
    const S = types.sail.mesh; let n = 0;
    for (const b of loops) {
      const a = b.ph + t * b.w; const x = b.cx + Math.cos(a) * b.rx, z = b.cz + Math.sin(a) * b.rz;
      if (Math.abs(x - cam.x) > far || Math.abs(z - cam.z) > far) continue;
      const dx = -Math.sin(a) * b.rx * Math.sign(b.w), dz = Math.cos(a) * b.rz * Math.sign(b.w); const yaw = Math.atan2(-dz, dx);
      const heel = 0.2 + 0.08 * Math.sin(t * 0.7 + b.ph) + 0.05 * U.uWind.value;                     // heel away from the westerly breeze
      const side = Math.sign(Math.sin(yaw)) || 1;
      e.set(0, yaw, 0); q.setFromEuler(e); qh.setFromAxisAngle(XA, heel * side); q.multiply(qh);
      p.set(x, Math.sin(t * 1.3 + b.ph) * 0.12, z); m4.compose(p, q, sc); S.setMatrixAt(n++, m4);
      wi = wake(wi, x, z, yaw, 9, 26);
    }
    S.count = n; S.instanceMatrix.needsUpdate = true;
    // ferries and ships
    for (const kind of ['ferry', 'ship']) {
      const M = types[kind].mesh; let k = 0;
      for (const r of routes) {
        if (r.kind !== kind) continue; routePos(r, t, _o);
        if (Math.abs(_o.x - cam.x) > far * 1.5 || Math.abs(_o.z - cam.z) > far * 1.5) continue;
        e.set(0, _o.yaw, 0); q.setFromEuler(e); p.set(_o.x, kind === 'ship' ? -1.5 : 0.1, _o.z); m4.compose(p, q, sc); M.setMatrixAt(k++, m4);
        if (_o.moving) wi = wake(wi, _o.x, _o.z, _o.yaw, kind === 'ship' ? 150 : 22, kind === 'ship' ? 520 : 150);
      }
      M.count = k; M.instanceMatrix.needsUpdate = true;
    }
    types.ferry.mesh.material.emissiveIntensity = 0.25 * U.uNight.value;
    wakeMesh.count = wi; wakeMesh.instanceMatrix.needsUpdate = true;
    group.visible = true;
  }
  function wake(i, x, z, yaw, stern, len) {
    if (!wakeMesh || i >= wakeMesh.instanceMatrix.count) return i;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // stern position: stern metres behind the centre (local -X); plane extends aft along local -X
    const sx = x - c * stern * 0.5, sz = z + s * stern * 0.5;
    e.set(0, yaw - Math.PI / 2, 0); q.setFromEuler(e); p.set(sx, 0.08, sz); m4.compose(p, q, ws.set(len * 0.45, 1, len)); wakeMesh.setMatrixAt(i, m4);   // plane's +Z points aft
    return i + 1;
  }
  return { init, update, group };
})();
