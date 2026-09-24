// Landmarks + Depots: hand-built, real-world-placed landmarks of the Bay Area corridor and the
// station buildings the station builder uses. Everything is procedural (no assets).
// Contract: see SPEC.md ("Landmarks" section). Exposes `Landmarks` and `Depots`.
const Landmarks = (() => {
  const DEG = Math.PI / 180;

  // ------------------------------------------------------------------ materials (shared, lazy)
  let MAT = null;
  const night = { v: 0 };
  function materials() {
    if (MAT) return MAT;
    const std = o => new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: 0.85, metalness: 0 }, o));
    MAT = {
      solid: std({}),                                       // masonry, concrete, stucco, grass
      smooth: std({ roughness: 0.55 }),                     // painted wood, tile, smooth plaster
      paint: std({ roughness: 0.5, metalness: 0.25 }),      // painted steel (bridges, frames)
      metal: std({ roughness: 0.32, metalness: 0.8 }),      // bare / clad metal
      glass: std({ roughness: 0.06, metalness: 0.92 }),     // reflective curtain wall
      window: std({ roughness: 0.2, metalness: 0.5, emissive: new THREE.Color(1.0, 0.76, 0.48), emissiveIntensity: 0 }),
      lights: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      beacon: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      field: std({ roughness: 0.95 }),
      water: std({ roughness: 0.15, metalness: 0.35 }),
    };
    MAT.lights.userData.lightKey = true; MAT.beacon.userData.lightKey = true;
    return MAT;
  }
  let PTS = null;
  function pointsMaterial(key) {
    if (!PTS) {
      PTS = { lights: new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, toneMapped: false }),
              beacon: new THREE.PointsMaterial({ size: 3.4, sizeAttenuation: false, vertexColors: true, toneMapped: false }) };
      PTS.lights.visible = PTS.beacon.visible = false;
    }
    return PTS[key];
  }
  const extraMaterials = [];   // per-landmark textured materials that need night updates
  function trackMat(m, kind) { m.userData.nightKind = kind; extraMaterials.push(m); return m; }

  // ------------------------------------------------------------------ geometry kit
  // Parts are accumulated per material key with vertex colors, then merged into one mesh per key.
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(),
        _v2 = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _up = new THREE.Vector3(0, 1, 0);
  function prep(geo) {
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    return geo;
  }
  function xform(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')); _m4.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz)); geo.applyMatrix4(_m4); return geo;
  }
  class Kit {
    constructor() { this.parts = new Map(); this.tris = 0; }
    add(key, geo, color) {
      prep(geo); U.tint(geo, color);
      if (!this.parts.has(key)) this.parts.set(key, []);
      this.parts.get(key).push(geo); return this;
    }
    // Box with its BOTTOM at y; rotated about its own vertical axis by ry.
    box(k, c, w, h, d, x = 0, y = 0, z = 0, ry = 0) { return this.add(k, xform(new THREE.BoxGeometry(w, h, d), x, y + h / 2, z, 0, ry, 0), c); }
    // Box centered at (x,y,z) with full rotation.
    boxC(k, c, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) { return this.add(k, xform(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz), c); }
    cyl(k, c, rt, rb, h, x = 0, y = 0, z = 0, seg = 16, ry = 0, open = false) {
      return this.add(k, xform(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), x, y + h / 2, z, 0, ry, 0), c);
    }
    cylX(k, c, r, len, x, y, z, seg = 12, ry = 0) { // horizontal cylinder along local X, centered
      return this.add(k, xform(new THREE.CylinderGeometry(r, r, len, seg), x, y, z, 0, ry, Math.PI / 2), c);
    }
    sphere(k, c, r, x, y, z, ws = 16, hs = 10, ts = 0, tl = Math.PI, sy = 1) {
      return this.add(k, xform(new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, ts, tl), x, y, z, 0, 0, 0, 1, sy, 1), c);
    }
    dome(k, c, r, x, y, z, seg = 20, sy = 1) { return this.sphere(k, c, r, x, y, z, seg, Math.max(6, seg >> 1), 0, Math.PI / 2, sy); }
    cone(k, c, r, h, x, y, z, seg = 12, ry = 0) { return this.add(k, xform(new THREE.ConeGeometry(r, h, seg), x, y + h / 2, z, 0, ry, 0), c); }
    // Square pyramid: base w (x) by d (z), apex height h.
    pyramid(k, c, w, d, h, x, y, z, ry = 0) {
      const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1); g.rotateY(Math.PI / 4); g.translate(0, 0.5, 0);
      return this.add(k, xform(g, x, y, z, 0, ry, 0, w, h, d), c);
    }
    // Beam/strut between two points, square section s (or w x h).
    beam(k, c, a, b, s = 0.5, s2 = s) {
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz) || 1e-3;
      const g = new THREE.BoxGeometry(s, L, s2);
      _q.setFromUnitVectors(_up, _v2.set(dx / L, dy / L, dz / L)); _m4.compose(_v.set(a[0] + dx / 2, a[1] + dy / 2, a[2] + dz / 2), _q, _s.set(1, 1, 1));
      g.applyMatrix4(_m4); return this.add(k, g, c);
    }
    rod(k, c, a, b, r = 0.3, seg = 6) {
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz) || 1e-3;
      const g = new THREE.CylinderGeometry(r, r, L, seg, 1, true);
      _q.setFromUnitVectors(_up, _v2.set(dx / L, dy / L, dz / L)); _m4.compose(_v.set(a[0] + dx / 2, a[1] + dy / 2, a[2] + dz / 2), _q, _s.set(1, 1, 1));
      g.applyMatrix4(_m4); return this.add(k, g, c);
    }
    tube(k, c, pts, r = 0.4, radial = 6, segsPer = 1) {
      const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], p[1], p[2])), false, 'centripetal');
      return this.add(k, new THREE.TubeGeometry(curve, Math.max(2, (pts.length - 1) * segsPer), r, radial, false), c);
    }
    // Extrude a 2D polygon (x,y in the local XY plane) by depth along +Z, then transform.
    extrude(k, c, pts, depth, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, holes = null, bevel = 0) {
      const sh = new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1])));
      if (holes) for (const h of holes) sh.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p[0], p[1]))));
      const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 10 });
      return this.add(k, xform(g, x, y, z, rx, ry, rz), c);
    }
    // Plan polygon (x,z pairs) extruded upward from y0 to y0+h.
    prism(k, c, plan, h, x = 0, y0 = 0, z = 0, ry = 0) {
      const g = new THREE.ExtrudeGeometry(new THREE.Shape(plan.map(p => new THREE.Vector2(p[0], -p[1]))), { depth: h, bevelEnabled: false, curveSegments: 12 });
      g.rotateX(-Math.PI / 2); return this.add(k, xform(g, x, y0, z, 0, ry, 0), c);
    }
    lathe(k, c, prof, seg, x = 0, y = 0, z = 0, sx = 1, sz = 1) {
      return this.add(k, xform(new THREE.LatheGeometry(prof.map(p => new THREE.Vector2(p[0], p[1])), seg), x, y, z, 0, 0, 0, sx, 1, sz), c);
    }
    // Gable roof: ridge along local X (length L), span W across Z, height H, bottom at y.
    gable(k, c, L, W, H, x = 0, y = 0, z = 0, ry = 0, over = 0) {
      const g = new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-W / 2 - over, 0), new THREE.Vector2(W / 2 + over, 0), new THREE.Vector2(0, H)]),
        { depth: L, bevelEnabled: false });
      g.translate(0, 0, -L / 2); g.rotateY(Math.PI / 2); return this.add(k, xform(g, x, y, z, 0, ry, 0), c);
    }
    // Hip roof over an L (x) by W (z) rectangle.
    hip(k, c, L, W, H, x = 0, y = 0, z = 0, ry = 0) {
      const r = Math.max(0, (L - W) / 2), hl = L / 2, hw = W / 2;
      const P = [[-hl, 0, -hw], [hl, 0, -hw], [hl, 0, hw], [-hl, 0, hw], [-r, H, 0], [r, H, 0]];
      const T = [[0, 1, 5], [0, 5, 4], [1, 2, 5], [2, 3, 4], [2, 4, 5], [3, 0, 4]];
      return this.add(k, xform(polyGeo(P, T, [0, H * 0.3, 0]), x, y, z, 0, ry, 0), c);
    }
    // Barrel vault along X (half cylinder), radius R across Z, length L, bottom at y. sy squashes height.
    vault(k, c, L, R, x = 0, y = 0, z = 0, ry = 0, sy = 1, seg = 16) {
      const g = new THREE.CylinderGeometry(R, R, L, seg, 1, false, 0, Math.PI);
      g.rotateZ(Math.PI / 2); return this.add(k, xform(g, x, y, z, 0, ry, 0, 1, sy, 1), c);
    }
    // Grid of flush windows on a wall plane. The wall faces +Z (normal) in local coords before ry.
    windows(k, c, cols, rows, w, h, gapX, gapY, x0, y0, z, ry = 0, depth = 0.25, ox = 0, oz = 0) {
      for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
        const lx = x0 + q * (w + gapX), ly = y0 + r * (h + gapY);
        const cs = Math.cos(ry), sn = Math.sin(ry);
        this.boxC(k, c, w, h, depth, ox + lx * cs + z * sn, ly + h / 2, oz - lx * sn + z * cs, 0, ry, 0);
      }
      return this;
    }
    toGroup(group = new THREE.Group(), opts = {}) {
      const M = materials();
      for (const [key, geos] of this.parts) {
        const g = U.mergeGeometries(geos); g.computeBoundingSphere();
        const mat = typeof key === 'string' ? M[key] : key;
        const mesh = new THREE.Mesh(g, mat); mesh.name = opts.name ? opts.name + ':' + (typeof key === 'string' ? key : 'custom') : '';
        const isLight = mat.userData && mat.userData.lightKey;
        mesh.castShadow = !isLight && key !== 'glass' && key !== 'water' && opts.shadow !== false;
        mesh.receiveShadow = !isLight;
        this.tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
        group.add(mesh);
        if (key === 'lights' || key === 'beacon') {       // far-visible light points (constant pixel size, night only)
          const pp = [], pc = [];
          for (const gg of geos) { gg.computeBoundingBox(); const b = gg.boundingBox, c = gg.attributes.color; pp.push((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2); pc.push(c.getX(0), c.getY(0), c.getZ(0)); }
          const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3)); pg.setAttribute('color', new THREE.Float32BufferAttribute(pc, 3)); pg.computeBoundingSphere();
          const pts = new THREE.Points(pg, pointsMaterial(key)); pts.name = (opts.name || '') + ':' + key + '-points'; pts.renderOrder = -1; group.add(pts);
        }
      }
      this.parts.clear(); return group;
    }
  }

  // ------------------------------------------------------------------ procedural textures
  const texCache = new Map();
  // Office curtain-wall texture: one tile = cols x rows windows. day = map, night = emissiveMap.
  function officeTex(style = 'blue', seed = 1) {
    const key = style + seed; if (texCache.has(key)) return texCache.get(key);
    const R = U.rng(seed * 7919 + 13), cols = 8, rows = 8, S = 256;
    const pal = {
      blue: ['#3f5a74', '#58728c', '#b9c4cc'], white: ['#8ea2b3', '#a9b8c4', '#eef0ec'], dark: ['#23272c', '#343a41', '#5b3c35'],
      teal: ['#3d6a70', '#56868a', '#c9d2cf'], stone: ['#5b6c7c', '#71879a', '#d9d2c3'], green: ['#38584f', '#4f746a', '#c5cfc6'],
    }[style] || ['#3f5a74', '#58728c', '#b9c4cc'];
    const day = U.canvasTexture(S, S, (g) => {
      g.fillStyle = pal[2]; g.fillRect(0, 0, S, S);
      const cw = S / cols, ch = S / rows;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const t = R(); g.fillStyle = t < 0.5 ? pal[0] : pal[1];
        g.fillRect(c * cw + cw * 0.12, r * ch + ch * 0.14, cw * 0.76, ch * 0.72);
        g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(c * cw + cw * 0.12, r * ch + ch * 0.14, cw * 0.76, ch * 0.18);
      }
    }, { repeat: true });
    const R2 = U.rng(seed * 104729 + 7);
    const nightT = U.canvasTexture(S, S, (g) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
      const cw = S / cols, ch = S / rows;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const t = R2(); if (t > 0.42) continue;
        const warm = R2() < 0.6; g.fillStyle = warm ? `rgba(255,${200 + (R2() * 40 | 0)},${140 + (R2() * 60 | 0)},${0.55 + R2() * 0.45})` : `rgba(200,225,255,${0.5 + R2() * 0.4})`;
        g.fillRect(c * cw + cw * 0.12, r * ch + ch * 0.14, cw * 0.76, ch * 0.72);
      }
    }, { repeat: true });
    const out = { day, night: nightT }; texCache.set(key, out); return out;
  }
  // Material for a textured tower shell. repeatX/Y = how many texture tiles across/up.
  function towerMat(style, seed, repX, repY, opts = {}) {
    const t = officeTex(style, seed);
    const day = t.day.clone(); day.needsUpdate = true; day.repeat.set(repX, repY); day.wrapS = day.wrapT = THREE.RepeatWrapping;
    const ngt = t.night.clone(); ngt.needsUpdate = true; ngt.repeat.set(repX, repY); ngt.wrapS = ngt.wrapT = THREE.RepeatWrapping;
    const m = new THREE.MeshStandardMaterial({ map: day, emissiveMap: ngt, emissive: new THREE.Color(1, 0.88, 0.7), emissiveIntensity: 0,
      roughness: opts.roughness ?? 0.3, metalness: opts.metalness ?? 0.55 });
    return trackMat(m, 'windows');
  }
  // Text texture (signs, clock faces, letters)
  function textTex(lines, o = {}) {
    const W = o.w || 1024, H = o.h || 128;
    return U.canvasTexture(W, H, (g) => {
      g.fillStyle = o.bg || 'rgba(0,0,0,0)'; g.fillRect(0, 0, W, H);
      g.fillStyle = o.fg || '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const fs = o.size || H * 0.8; g.font = `${o.weight || 700} ${fs}px ${o.font || 'Helvetica, Arial, sans-serif'}`;
      const n = lines.length; lines.forEach((ln, i) => g.fillText(ln, W / 2, H * (i + 0.5) / n, W * 0.98));
    }, { aniso: 8 });
  }

  // ------------------------------------------------------------------ small helpers
  // Rotate a local offset (lx along +X, lz along +Z) by heading ry (radians about +Y).
  const rot = (lx, lz, ry) => { const c = Math.cos(ry), s = Math.sin(ry); return [lx * c + lz * s, -lx * s + lz * c]; };
  // Bearing (deg clockwise from north) -> rotation.y that points local +X along that bearing.
  const ryOf = bearing => (90 - bearing) * DEG;
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  // Loft: stack of horizontal cross-sections (arrays of [x,z]) with per-level y, returns an indexed
  // side-wall geometry with UVs (u = around, v = up) for window textures, optional cap.
  function loftGeo(sections, ys, uScale = 1, vScale = 1, cap = true) {
    const n = sections[0].length, L = sections.length, pos = [], uv = [], idx = [];
    for (let j = 0; j < L; j++) {
      const s = sections[j]; let acc = 0; const per = [];
      for (let i = 0; i <= n; i++) { const a = s[i % n], b = s[(i + 1) % n]; per.push(acc); if (i < n) acc += Math.hypot(b[0] - a[0], b[1] - a[1]); }
      for (let i = 0; i <= n; i++) { const p = s[i % n]; pos.push(p[0], ys[j], p[1]); uv.push(per[i] / uScale, ys[j] / vScale); }
    }
    for (let j = 0; j < L - 1; j++) for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1; idx.push(a, c, b, b, c, d);
    }
    if (cap) { // fan cap on top
      const top = sections[L - 1], cy = ys[L - 1]; let cx = 0, cz = 0; for (const p of top) { cx += p[0]; cz += p[1]; } cx /= n; cz /= n;
      const base = pos.length / 3; pos.push(cx, cy, cz); uv.push(0, 0);
      for (let i = 0; i <= n; i++) { const p = top[i % n]; pos.push(p[0], cy, p[1]); uv.push(0, 0); }
      for (let i = 0; i < n; i++) idx.push(base, base + 1 + i + 1, base + 1 + i);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  // Rounded rectangle outline (half extents a,b; corner radius r), counter-clockwise seen from above.
  function roundRect(a, b, r, segs = 5) {
    const out = [], cs = [[a - r, b - r, 0], [-(a - r), b - r, 90], [-(a - r), -(b - r), 180], [a - r, -(b - r), 270]];
    for (const [cx, cz, s] of cs) for (let i = 0; i <= segs; i++) { const t = (s + 90 * i / segs) * DEG; out.push([cx + r * Math.cos(t), cz + r * Math.sin(t)]); }
    return out;
  }
  const circle = (r, n = 24, ox = 0, oz = 0) => Array.from({ length: n }, (_, i) => [ox + r * Math.cos(i / n * Math.PI * 2), oz + r * Math.sin(i / n * Math.PI * 2)]);
  const scalePoly = (poly, s, sz = s) => poly.map(p => [p[0] * s, p[1] * sz]);
  // collision solids for the flight physics, in the landmark's own frame: footprint, top, and for slabs (decks, portals) a bottom
  const RB = (hx, hz, cx = 0, cz = 0) => [[cx - hx, cz - hz], [cx + hx, cz - hz], [cx + hx, cz + hz], [cx - hx, cz + hz]];
  const CIRC = (r, n = 12) => { const o = []; for (let i = 0; i < n; i++) o.push([Math.cos(i / n * 2 * Math.PI) * r, Math.sin(i / n * 2 * Math.PI) * r]); return o; };
  function meshFromGeo(geo, mat, name) { const m = new THREE.Mesh(geo, mat); m.name = name || ''; m.castShadow = true; m.receiveShadow = true; return m; }

  // Triangle soup with faces oriented away from `center`.
  function polyGeo(P, T, center) {
    const pos = [];
    for (const [a, b, c] of T) {
      const A = P[a], B = P[b], C = P[c];
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const mx = (A[0] + B[0] + C[0]) / 3 - center[0], my = (A[1] + B[1] + C[1]) / 3 - center[1], mz = (A[2] + B[2] + C[2]) / 3 - center[2];
      if (nx * mx + ny * my + nz * mz >= 0) pos.push(...A, ...B, ...C); else pos.push(...A, ...C, ...B);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
  }
  // Sloped annular sector (stadium seating): inner radius ri at height yi, outer ro at height yo,
  // angle a0..a1 (radians, measured from +X toward +Z), with front and back walls down to y=0.
  function annularSector(ri, ro, yi, yo, a0, a1, seg = 24) {
    const S = new Soup(), P = (r, a, y) => [r * Math.cos(a), y, r * Math.sin(a)];
    for (let i = 0; i < seg; i++) {
      const b0 = a0 + (a1 - a0) * i / seg, b1 = a0 + (a1 - a0) * (i + 1) / seg, bm = (b0 + b1) / 2, nx = Math.cos(bm), nz = Math.sin(bm);
      S.quad(P(ri, b0, yi), P(ri, b1, yi), P(ro, b1, yo), P(ro, b0, yo), [-nx * 0.02, 1, -nz * 0.02]);
      S.quad(P(ri, b0, 0), P(ri, b1, 0), P(ri, b1, yi), P(ri, b0, yi), [-nx, 0, -nz]);
      S.quad(P(ro, b0, 0), P(ro, b1, 0), P(ro, b1, yo), P(ro, b0, yo), [nx, 0, nz]);
    }
    for (const [a, sg] of [[a0, -1], [a1, 1]]) { const tx = -Math.sin(a) * sg * Math.sign(a1 - a0), tz = Math.cos(a) * sg * Math.sign(a1 - a0);
      S.quad(P(ri, a, 0), P(ro, a, 0), P(ro, a, yo), P(ri, a, yi), [tx, 0, tz]); }
    return S.geo();
  }
  // Double-sided flat ring-sector helper for decks/roofs: returns geometry.
  function ringSectorFlat(ri, ro, y, a0, a1, seg = 24) {
    const g = new THREE.RingGeometry(ri, ro, seg, 1, -a1, a1 - a0); g.rotateX(-Math.PI / 2); // XY ring -> XZ, facing up; angles measured toward +Z
    g.translate(0, y, 0); return g;
  }
  function seatedGroup(ctx, lat, lon, opts = {}) {
    const p = ctx.ll2w(lat, lon); const g = new THREE.Group();
    const y = opts.y !== undefined ? opts.y : ctx.groundY(p.x, p.z) + (opts.dy || 0);
    g.position.set(p.x, y, p.z); if (opts.bearing !== undefined) g.rotation.y = ryOf(opts.bearing);
    return g;
  }

  // ================================================================== SAN FRANCISCO
  const LM = []; // [{ name, lat, lon, blurb, radius, build(ctx) -> Group }]
  const def = (name, lat, lon, radius, blurb, build) => LM.push({ name, lat, lon, radius, blurb, build });

  // --- Salesforce Tower: rounded-square tower with gentle top taper and an open LED lattice crown.
  let crownTex = null;
  def('Salesforce Tower', 37.789775, -122.396914, 330, 'At 326 m the tallest building in San Francisco; its open crown becomes a nine-story LED artwork at night.', (ctx) => {
    const g = seatedGroup(ctx, 37.789775, -122.396914, { bearing: 110 });
    const base = roundRect(25.5, 25.5, 9, 6);
    const ys = [], secs = [];
    for (let i = 0; i <= 14; i++) {
      const y = 6 + i * (300 - 6) / 14; const t = (y - 6) / 294;
      const s = 1 - 0.04 * t - 0.16 * Math.pow(Math.max(0, (t - 0.55) / 0.45), 2);
      ys.push(y); secs.push(scalePoly(base, s));
    }
    const shell = loftGeo(secs, ys, 26, 30, true);
    g.add(meshFromGeo(shell, towerMat('white', 3, 1, 1), 'salesforce:shell'));
    const k = new Kit();
    // lobby + vertical white fins at the rounded corners
    k.prism('glass', 0x9fb4c4, scalePoly(base, 1.02), 6, 0, 0, 0);
    // crown: open lattice shell 300 -> 326 m (LED screen inside)
    const crownSecs = [scalePoly(base, 0.8), scalePoly(base, 0.785), scalePoly(base, 0.77)];
    const crown = loftGeo(crownSecs, [300, 313, 326], 6, 6, false);
    crownTex = U.canvasTexture(256, 128, () => {}, { repeat: true });
    const cm = new THREE.MeshStandardMaterial({ color: 0xe8ebee, roughness: 0.4, metalness: 0.3, side: THREE.DoubleSide, emissive: 0xdfe8ff, emissiveIntensity: 0,
      alphaMap: U.canvasTexture(64, 64, (c) => { c.fillStyle = '#000'; c.fillRect(0, 0, 64, 64); c.fillStyle = '#fff';
        for (let i = 0; i < 64; i += 16) { c.fillRect(i, 0, 4, 64); c.fillRect(0, i, 64, 3); } }, { repeat: true, srgb: false }),
      alphaTest: 0.5 });
    cm.alphaMap.repeat.set(0.55, 0.5);
    g.add(meshFromGeo(crown, trackMat(cm, 'crown'), 'salesforce:crown'));
    const inner = loftGeo([scalePoly(base, 0.72), scalePoly(base, 0.71)], [301, 324], 188.5 * 0.72, 23, false);
    const im = new THREE.MeshBasicMaterial({ map: crownTex, toneMapped: false, side: THREE.DoubleSide, color: 0x222222 });
    g.add(meshFromGeo(inner, trackMat(im, 'crownScreen'), 'salesforce:screen'));
    k.box('lights', 0xff3030, 1.2, 1.2, 1.2, 0, 326, 0);
    k.toGroup(g, { name: 'salesforce' });
    g.userData.solids = [{ pts: base, top: 170 }, { pts: scalePoly(base, 0.86), top: 300 }, { pts: scalePoly(base, 0.81), hole: scalePoly(base, 0.75), top: 326 }];   // (the crown is an open ring over the roof)
    return g;
  });

  // --- Transamerica Pyramid
  def('Transamerica Pyramid', 37.795166, -122.402786, 270, 'The 1972 pyramid, 260 m to the tip of its aluminum-clad spire, still defines the skyline.', (ctx) => {
    const g = seatedGroup(ctx, 37.795166, -122.402786, { bearing: 0 });
    const sq = s => [[s, s], [-s, s], [-s, -s], [s, -s]];
    const secs = [], ys = [];
    for (let i = 0; i <= 8; i++) { const y = 12 + i * (205 - 12) / 8; ys.push(y); secs.push(sq(26.5 - (y - 12) / 193 * 19)); }
    g.add(meshFromGeo(loftGeo(secs, ys, 7, 7, false), towerMat('white', 5, 1, 1, { metalness: 0.2, roughness: 0.6 }), 'transamerica:shell'));
    const k = new Kit();
    // base: sloped truss legs + recessed lobby
    k.prism('glass', 0x4b5d6a, sq(24), 12, 0, 0, 0);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) k.beam('smooth', 0xe9e6de, [sx * 27.5, 0, sz * 27.5], [sx * 26.2, 12.5, sz * 26.2], 2.2);
    k.prism('smooth', 0xe9e6de, sq(27), 1.2, 0, 12, 0);
    // wings: elevator (east) and stair (west) shafts, rising from ~y=88 to ~y=218
    for (const sgn of [1, -1]) {
      const pts = []; const y0 = 88, y1 = 218;
      const hw0 = 26.5 - (y0 - 12) / 193 * 19, hw1 = 26.5 - (y1 - 12) / 193 * 19;
      k.extrude('smooth', 0xe7e3da, [[hw0 - 4, y0], [hw0 + 5.5, y0 + 10], [hw1 + 3, y1], [hw1 - 1, y1]], 12, 0, 0, -6, 0, sgn > 0 ? 0 : Math.PI, 0);
    }
    // spire
    k.pyramid(floodWarm(), 0xe7e3da, 15, 15, 55, 0, 205, 0);
    k.box('lights', 0xfff3d0, 0.8, 0.8, 0.8, 0, 260, 0);
    k.toGroup(g, { name: 'transamerica' });
    g.userData.solids = [[27, 60], [21.8, 110], [16.9, 160], [12, 205], [4, 245]].map(([h, top]) => ({ pts: RB(h, h), top }));
    return g;
  });

  // --- A few signature SoMa/Rincon towers (the towns agent supplies the generic OSM skyline)
  def('181 Fremont', 37.78975, -122.39535, 250, 'A 245 m tower wrapped in a diagonal exoskeleton, finished in 2018.', (ctx) => {
    const g = seatedGroup(ctx, 37.78975, -122.39535, { bearing: 111 });
    const secs = [], ys = [];
    for (let i = 0; i <= 10; i++) { const y = i * 21; ys.push(y); const s = 17.5 - i * 0.55; secs.push([[s, s], [-s, s], [-s, -s], [s, -s]]); }
    g.add(meshFromGeo(loftGeo(secs, ys, 8.75, 8, true), towerMat('stone', 11, 1, 1), '181:shell'));
    const k = new Kit();
    // diagonal exoskeleton braces on all four faces
    for (let f = 0; f < 4; f++) {
      const ry = f * Math.PI / 2;
      for (let seg = 0; seg < 5; seg++) {
        const y0 = seg * 42, y1 = y0 + 42, s0 = 17.9 - (y0 / 21) * 0.55, s1 = 17.9 - (y1 / 21) * 0.55;
        const a = rot(-s0, s0, ry), b = rot(s1, s1, ry), c2 = rot(s0, s0, ry), d = rot(-s1, s1, ry);
        k.beam('smooth', 0xf2f2ee, [a[0], y0, a[1]], [b[0], y1, b[1]], 1.3); k.beam('smooth', 0xf2f2ee, [c2[0], y0, c2[1]], [d[0], y1, d[1]], 1.3);
      }
    }
    // sloped crown + spire
    k.extrude('glass', 0x9fb6c8, [[-12, 0], [12, 0], [12, 10], [-12, 26]], 24, 0, 210, -12);
    k.cyl('metal', 0xd8dde2, 0.35, 0.8, 22, -6, 236, 0, 8);
    k.box('lights', 0xff3020, 0.8, 0.8, 0.8, -6, 258, 0);
    k.toGroup(g, { name: '181fremont' });
    g.userData.solids = [{ pts: RB(17.9, 17.9), top: 210 }, { pts: RB(12, 12), top: 236 }];
    return g;
  });
  def('Millennium Tower', 37.790405, -122.396187, 200, 'The 197 m blue-glass residential tower on Mission Street.', (ctx) => {
    const g = seatedGroup(ctx, 37.790405, -122.396187, { bearing: 110 });
    const plan = [[22, -6], [18, 12], [4, 18], [-16, 16], [-22, 2], [-18, -14], [0, -18], [14, -16]];
    const secs = [], ys = [];
    for (let i = 0; i <= 9; i++) { ys.push(i * 21.8); secs.push(scalePoly(plan, i > 7 ? 0.9 : 1)); }
    g.add(meshFromGeo(loftGeo(secs, ys, 7, 7, true), towerMat('blue', 17, 1, 1), 'millennium:shell'));
    g.userData.solids = [{ pts: plan, top: 196 }];
    return g;
  });
  def('555 California Street', 37.79208, -122.40368, 240, 'The dark carnelian-granite Bank of America Center (1969), 237 m tall.', (ctx) => {
    const g = seatedGroup(ctx, 37.79208, -122.40368, { bearing: 90 });
    // sawtooth long faces
    const saw = (L, W, n) => { const p = []; for (let i = 0; i <= n; i++) { const x = -L + 2 * L * i / n; p.push([x, W + (i % 2 ? 2.5 : 0)]); } for (let i = n; i >= 0; i--) { const x = -L + 2 * L * i / n; p.push([x, -W - (i % 2 ? 2.5 : 0)]); } return p; };
    const k = new Kit();
    const tiers = [[0, 190, 34, 22], [190, 212, 30, 19], [212, 227, 24, 15], [227, 237, 16, 10]];
    for (const [y0, y1, L, W] of tiers) {
      const secs = [saw(L, W, 18), saw(L, W, 18)];
      g.add(meshFromGeo(loftGeo(secs, [y0, y1], 7, 6, true), towerMat('dark', 23, 1, 1, { metalness: 0.35, roughness: 0.45 }), '555:tier'));
    }
    k.toGroup(g, { name: '555' });
    g.userData.solids = tiers.map(([, y1, L, W]) => ({ pts: RB(L, W + 1.25), top: y1 }));
    return g;
  });
  def('One Rincon Hill', 37.78585, -122.39220, 200, 'The 188 m tower at the foot of the Bay Bridge, capped by a water-tank damper.', (ctx) => {
    const g = seatedGroup(ctx, 37.78585, -122.39220, { bearing: 45 });
    const secs = [], ys = [];
    const plan = [[14, 14], [-14, 14], [-14, -14], [14, -14]];
    for (let i = 0; i <= 8; i++) { ys.push(i * 22); secs.push(plan); }
    g.add(meshFromGeo(loftGeo(secs, ys, 7, 7, true), towerMat('teal', 29, 1, 1), 'rincon:shell'));
    const k = new Kit();
    for (let i = 0; i < 4; i++) { const a = rot(14.3, 0, i * Math.PI / 2); k.box('smooth', 0xe8ece9, 1.2, 176, 6, a[0], 0, a[1], i * Math.PI / 2); }
    k.box('glass', 0x7fa6ac, 20, 12, 20, 0, 176, 0);
    k.box('lights', 0xbfe6ff, 20.4, 1, 20.4, 0, 187, 0);
    k.toGroup(g, { name: 'rincon' });
    g.userData.solids = [{ pts: RB(14.5, 14.5), top: 188 }];
    return g;
  });

  // --- Oracle Park (home of the Giants). Local frame: origin at home plate, +X toward center field.
  def('Oracle Park', 37.77830, -122.38975, 180, 'Waterfront ballpark next to 4th & King: home runs to right field splash into McCovey Cove.', (ctx) => {
    const g = seatedGroup(ctx, 37.77802, -122.39020, { bearing: 70 });
    const k = new Kit();
    const fence = [[-45, 103], [-30, 108], [-15, 116], [0, 122], [12, 128], [22, 124], [35, 108], [45, 94]];
    const fencePt = a => { for (let i = 0; i < fence.length - 1; i++) { const [a0, d0] = fence[i], [a1, d1] = fence[i + 1]; if (a >= a0 && a <= a1) return d0 + (d1 - d0) * (a - a0) / (a1 - a0); } return 100; };
    // playing surface: grass wedge + foul ground
    const grass = [[0, 0]]; for (let a = -45; a <= 45; a += 3) grass.push([Math.cos(a * DEG) * fencePt(a), Math.sin(a * DEG) * fencePt(a)]);
    k.prism('field', 0x3f7a35, grass, 0.12, 0, 0, 0);
    const foul = []; for (let a = 45; a <= 315; a += 10) foul.push([Math.cos(a * DEG) * 24, Math.sin(a * DEG) * 24]);
    k.prism('field', 0x3f7a35, [[0, 0], ...foul], 0.1, 0, 0, 0);
    // infield dirt and mound, bases
    const d = 27.43; k.prism('field', 0xa0714a, [[-3, 0], [d * 0.72, -d * 0.72 - 2], [d * 1.45, 0], [d * 0.72, d * 0.72 + 2]], 0.16, 0, 0, 0);
    k.prism('field', 0x3f7a35, [[3.5, 0], [d * 0.707 - 1, -d * 0.707 + 1], [d * 1.414 - 3, 0], [d * 0.707 - 1, d * 0.707 - 1]], 0.2, 0, 0, 0);
    k.cyl('field', 0xa0714a, 2.7, 2.7, 0.3, 18.4, 0, 0, 16);
    for (const [x, z] of [[d * 0.707, -d * 0.707], [d * 1.414, 0], [d * 0.707, d * 0.707], [0, 0]]) k.box('smooth', 0xffffff, 0.5, 0.35, 0.5, x, 0, z, Math.PI / 4);
    // outfield walls (brick in right field along the cove), padded green elsewhere
    for (let a = -45; a < 45; a += 3) {
      const r0 = fencePt(a), r1 = fencePt(a + 3), p0 = [Math.cos(a * DEG) * r0, Math.sin(a * DEG) * r0], p1 = [Math.cos((a + 3) * DEG) * r1, Math.sin((a + 3) * DEG) * r1];
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      const h = a > 20 ? 7.6 : 3.2;
      k.box('solid', a > 20 ? 0x8f4a36 : 0x1e4a32, L + 0.3, h, 0.8, (p0[0] + p1[0]) / 2, 0, (p0[1] + p1[1]) / 2, -ang);
    }
    // seating bowl (dark green seats, concrete), lower + upper decks behind home plate
    k.add('solid', annularSector(26, 62, 2.5, 20, 42 * DEG, 318 * DEG, 40), 0x2f4a3b);
    k.add('solid', annularSector(58, 92, 26, 45, 58 * DEG, 302 * DEG, 36), 0x2c4638);
    k.add('solid', ringSectorFlat(60, 66, 22, 58 * DEG, 302 * DEG, 36), 0x8d8b86);  // club level fascia
    k.add('smooth', ringSectorFlat(88, 97, 49, 70 * DEG, 290 * DEG, 30), 0xd9d6cf);   // upper roof lip
    // left-field bleachers
    k.add('solid', annularSector(106, 128, 3, 14, -44 * DEG, -8 * DEG, 12), 0x2f4a3b);
    // brick outer wall + arcade (Willie Mays Plaza side)
    k.add('solid', annularSector(92, 97, 18, 18, 60 * DEG, 300 * DEG, 30), 0x8f4a36);
    // clock tower at the 3rd & King gate (behind home plate)
    const ct = rot(-104, 0, 0); k.box('solid', 0x8f4a36, 9, 34, 9, ct[0], 0, ct[1]); k.pyramid('smooth', 0x5d6b62, 10, 10, 7, ct[0], 34, ct[1]);
    k.box('lights', 0xfff4dc, 5, 5, 9.4, ct[0], 25, ct[1]);
    // giant Coke bottle and old-style glove in the left-field corner
    const cb = rot(116, -76, 0); k.lathe('smooth', 0x2c6e3f, [[0, 0], [3.4, 0], [3.8, 4], [3.8, 11], [3.0, 14], [2.2, 17], [1.4, 20.5], [1.5, 23], [0, 24.4]], 18, cb[0], 1, cb[1]);
    k.cyl('lights', 0xd8342d, 1.55, 1.55, 1.2, cb[0], 23, cb[1], 12);
    const gl = rot(96, -86, 0); k.sphere('solid', 0x7a4a2a, 5, gl[0], 5.5, gl[1], 14, 10, 0, Math.PI, 1.25); k.box('solid', 0x6a3d22, 3, 6, 4.5, gl[0] + 3, 0, gl[1] - 1);
    // scoreboard in center field
    const sb = rot(142, 8, 0); k.box('solid', 0x2b2f33, 4, 26, 32, sb[0], 0, sb[1], -8 * DEG); k.box('window', 0x1b2127, 0.6, 12, 29, sb[0] - 2.2, 12, sb[1], -8 * DEG);
    // light towers
    for (const a of [55, 100, 145, 215, 260, 305, -30]) {
      const r = a === -30 ? 130 : 95, x = Math.cos(a * DEG) * r, z = Math.sin(a * DEG) * r;
      k.cyl('paint', 0x9aa0a6, 0.7, 1.1, 58, x, 0, z, 8); k.box('paint', 0x6f757b, 9, 5, 2, x, 56, z, -a * DEG);
      k.box('lights', 0xfffaf0, 8.4, 4, 0.5, x - Math.cos(a * DEG) * 1.2, 56.5, z - Math.sin(a * DEG) * 1.2, -a * DEG);
    }
    k.toGroup(g, { name: 'oraclepark' });
    return g;
  });

  // --- Chase Center
  def('Chase Center', 37.767888, -122.387421, 90, 'The Warriors\' arena in Mission Bay, a pale sculpted drum opened in 2019.', (ctx) => {
    const g = seatedGroup(ctx, 37.767888, -122.387421, { bearing: 0 });
    const k = new Kit();
    k.lathe('glass', 0x7b95a6, [[0, 0], [70, 0], [70, 9], [0, 9]], 40, 0, 0, 0, 1, 0.84);
    k.lathe(floodMat(0xf3e6d8, 0.07, { roughness: 0.6, metalness: 0.1 }), 0xeee9df, [[66, 9], [72, 9], [73, 16], [71, 30], [66, 38], [40, 42], [0, 43], [0, 36], [62, 34], [66, 9]], 40, 0, 0, 0, 1, 0.84);
    for (let i = 0; i < 64; i++) { const a = i / 64 * Math.PI * 2; const r = 72.6; k.box('smooth', 0xf6f2ea, 0.8, 26, 2.5, Math.cos(a) * r, 9, Math.sin(a) * r * 0.84, -a + (i % 2 ? 0.35 : -0.35)); }
    k.box('lights', 0xffe7c2, 1, 1, 1, 0, 43.5, 0);
    k.toGroup(g, { name: 'chase' });
    return g;
  });

  // --- Ferry Building. Long axis NNW-SSE; facade (local +Z) faces the Embarcadero.
  def('Ferry Building', 37.79520, -122.39400, 110, 'The 1898 ferry terminal; its 75 m clock tower was modeled on the Giralda of Seville.', (ctx) => {
    const g = seatedGroup(ctx, 37.79520, -122.39400, { bearing: 147 });
    const k = new Kit(), stone = 0xd8cfbf, roof = 0x6f7a78;
    k.box('solid', stone, 200, 16, 30, 0, 0, 0);
    k.box('smooth', roof, 202, 1.4, 31, 0, 16, 0);
    k.hip('smooth', roof, 196, 26, 5, 0, 17.4, 0);
    // arched ground-floor windows (both long sides) + upper windows
    for (const side of [1, -1]) for (let i = 0; i < 26; i++) {
      const x = -93 + i * 7.45; k.box('window', 0x2a2f33, 3.4, 5.6, 0.4, x, 1, side * 15.05); k.box('window', 0x2a2f33, 3.2, 3.6, 0.4, x, 9, side * 15.05);
    }
    // clock tower
    const fl = floodWarm();
    k.box(fl, stone, 17, 44, 17, 0, 0, 4);
    k.box(fl, 0xe2dacb, 14, 10, 14, 0, 44, 4);
    for (let i = 0; i < 4; i++) { const r = rot(8.6, 0, i * Math.PI / 2); k.cylX('lights', 0xfff3dd, 3.2, 0.4, r[0], 37.5, r[1] + 4, 20, i * Math.PI / 2); }
    k.box(fl, stone, 11, 8, 11, 0, 54, 4);
    for (let i = 0; i < 4; i++) { const r = rot(5.6, 0, i * Math.PI / 2); k.box('window', 0x1e2226, 0.4, 5, 3, r[0], 55, r[1] + 4, i * Math.PI / 2); }
    k.box(fl, 0xe2dacb, 8, 5, 8, 0, 62, 4);
    k.pyramid('smooth', 0x7b8a86, 8.5, 8.5, 6, 0, 67, 4);
    k.cyl('metal', 0xcfcfcf, 0.12, 0.12, 5, 0, 73, 4, 6);
    // ferry piers on the bay side
    for (const x of [-60, 0, 60]) k.box('solid', 0x7f7a70, 14, 3, 40, x, -2, -35);
    k.toGroup(g, { name: 'ferrybuilding' });
    return g;
  });

  // --- Coit Tower on Telegraph Hill
  def('Coit Tower', 37.802377, -122.405834, 60, 'The 64 m fluted concrete tower (1933) on Telegraph Hill, floodlit at night.', (ctx) => {
    const g = seatedGroup(ctx, 37.802377, -122.405834, { bearing: 0 });
    const k = new Kit(), conc = 0xe9e3d3;
    k.box('solid', conc, 26, 8, 26, 0, -10, 0); k.box('solid', conc, 24, 9, 24, 0, -2, 0);
    const prof = []; for (let i = 0; i <= 32; i++) { const a = i / 32 * Math.PI * 2; prof.push([Math.cos(a) * (5.6 + (i % 2) * 0.35), Math.sin(a) * (5.6 + (i % 2) * 0.35)]); }
    const fl = floodWarm();
    k.prism(fl, conc, prof, 50, 0, 7, 0);
    k.cyl(fl, conc, 6.3, 6.1, 1.2, 0, 57, 0, 32);
    for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; k.box('window', 0x1d2124, 1.2, 4, 0.5, Math.cos(a) * 5.9, 52, Math.sin(a) * 5.9, -a + Math.PI / 2); }
    k.cyl(fl, conc, 5.8, 6.2, 5.8, 0, 58.2, 0, 32);
    // floodlights
    for (let i = 0; i < 4; i++) { const r = rot(10, 0, i * Math.PI / 2 + 0.4); k.box('lights', 0xfff1d6, 1, 0.6, 1, r[0], 7.2, r[1]); }
    k.toGroup(g, { name: 'coit' });
    g.userData.solids = [{ pts: RB(13, 13), top: 7 }, { pts: CIRC(6.2), top: 64 }];
    return g;
  });

  // --- Sutro Tower: three legs, two platforms and a crossbar top with red/white masts.
  def('Sutro Tower', 37.755241, -122.452903, 300, 'The 298 m three-legged TV and radio mast that rises out of the fog above Twin Peaks.', (ctx) => {
    const g = seatedGroup(ctx, 37.755241, -122.452903, { bearing: 20 });
    const k = new Kit(), red = 0xc2412e, white = 0xefefec;
    const legAt = (i, y) => { const r = 27 - 11 * Math.min(1, y / 240); const a = (i * 120 + 90) * DEG; return [Math.cos(a) * r, y, Math.sin(a) * r]; };
    for (let i = 0; i < 3; i++) {
      const nb = 12;
      for (let s = 0; s < nb; s++) {
        const y0 = s * 245 / nb, y1 = (s + 1) * 245 / nb;
        const col = (s % 2) ? white : red;
        k.beam('paint', col, legAt(i, y0), legAt(i, y1), 4.2 - 1.6 * y0 / 245);
      }
      // lattice zigzag along each leg face
      for (let s = 0; s < 18; s++) { const y0 = s * 13.6, y1 = y0 + 13.6; const a = legAt(i, y0), b = legAt((i + 1) % 3, y1);
        const m = lerp3(a, b, 0.5); k.beam('paint', 0xbdbcb8, a, [m[0] * 0.8, (y0 + y1) / 2, m[2] * 0.8], 0.45); }
    }
    for (const y of [105, 190, 245]) for (let i = 0; i < 3; i++) k.beam('paint', y === 245 ? red : white, legAt(i, y), legAt((i + 1) % 3, y), y === 245 ? 3.4 : 2.6);
    // top crossbar arms extending beyond the legs
    for (let i = 0; i < 3; i++) { const a = legAt(i, 245); const o = [a[0] * 1.9, 245, a[2] * 1.9]; k.beam('paint', red, a, o, 2.4);
      // masts
      for (let s = 0; s < 6; s++) { const y0 = 245 + s * 9, y1 = y0 + 9; k.beam('paint', s % 2 ? red : white, [a[0], y0, a[2]], [a[0], y1, a[2]], 1.6); }
      k.box('beacon', 0xff2a1a, 1.6, 1.6, 1.6, a[0], 299, a[2]); k.box('beacon', 0xff2a1a, 1.2, 1.2, 1.2, o[0], 246.5, o[2]);
    }
    k.box('solid', 0x8d8a82, 70, 3, 70, 0, -3, 0);
    k.toGroup(g, { name: 'sutro' });
    return g;
  });

  // --- Painted Ladies: seven Victorians on Steiner Street facing Alamo Square (west = local -Z).
  def('Painted Ladies', 37.77622, -122.43279, 40, 'The row of pastel 1890s Victorians on Steiner Street facing Alamo Square.', (ctx) => {
    const g = seatedGroup(ctx, 37.77622, -122.43279, { bearing: 0 });
    const k = new Kit();
    const cols = [0x9cc3d5, 0xc7b3d9, 0xf1dc9c, 0xb7d8b0, 0xf0b9a3, 0xf3ead5, 0xc9dce8];
    for (let i = 0; i < 7; i++) {
      const x = (i - 3) * 8.2, c = cols[i];
      k.box('smooth', c, 7.8, 11, 18, x, 0, 4);
      k.gable('smooth', 0x5b4a44, 18, 8.2, 5.5, x, 11, 4, Math.PI / 2, 0.3);
      k.box('smooth', c, 4.2, 9.5, 1.6, x - 1.2, 1.5, -5.6);                   // bay window
      k.box('window', 0x2d3238, 3.2, 3, 0.3, x - 1.2, 2.5, -6.45); k.box('window', 0x2d3238, 3.2, 3, 0.3, x - 1.2, 6.8, -6.45);
      k.box('window', 0x2d3238, 1.4, 3, 0.3, x + 2.6, 6.8, -5.05);
      k.box('smooth', 0xfaf7ef, 8.2, 0.5, 0.6, x, 10.8, -5.2); k.box('smooth', 0xfaf7ef, 1.8, 3.2, 1.8, x + 2.6, 0, -5.8);
      for (const cy of [1.5, 9.4]) k.box('smooth', 0xfaf7ef, 4.4, 0.4, 1.8, x - 1.2, cy, -5.6);
    }
    k.toGroup(g, { name: 'paintedladies' });
    return g;
  });

  // --- Alcatraz (rock only where the terrain lacks it; cellhouse, lighthouse, water tower)
  def('Alcatraz Island', 37.82672, -122.42276, 260, 'The former federal penitentiary on "The Rock" in the middle of the Bay.', (ctx) => {
    const p = ctx.ll2w(37.82672, -122.42276); const g0 = ctx.groundY(p.x, p.z);
    const top = Math.max(g0, 24);
    const g = seatedGroup(ctx, 37.82672, -122.42276, { bearing: 130, y: 0 });
    const k = new Kit();
    const isl = [[-240, 20], [-180, 70], [-40, 78], [120, 60], [230, 18], [210, -40], [80, -72], [-90, -66], [-220, -34]];
    k.prism('solid', 0x7f7a6e, isl, top + 8, 0, -8, 0);
    k.prism('solid', 0x8e8a77, scalePoly(isl, 0.78), 6, 0, top - 4, 0);
    k.box('solid', 0xd9d2c1, 150, 13, 30, 10, top + 2, 0);             // cellhouse
    k.box('smooth', 0x8b8f8e, 152, 1, 31, 10, top + 15, 0);
    k.windows('window', 0x303436, 30, 2, 2.4, 3.2, 2.3, 2.5, -62, top + 4, 15.1);
    k.cyl('solid', 0xece6d6, 2.6, 3.2, 26, 92, top + 2, 20, 10); k.cyl('lights', 0xfff5d8, 2.2, 2.2, 2.4, 92, top + 28, 20, 10);
    k.cyl('paint', 0xc9c5ba, 7, 7, 8, -150, top + 18, -20, 14); for (let i = 0; i < 4; i++) { const r = rot(6, 0, i * Math.PI / 2); k.beam('paint', 0x9b978c, [r[0] - 150, top, r[1] - 20], [r[0] - 150, top + 18, r[1] - 20], 0.6); }
    k.toGroup(g, { name: 'alcatraz' });
    return g;
  });

  // --- Cow Palace (near Bayshore station)
  def('Cow Palace', 37.70676, -122.41880, 110, 'The 1941 arena on the city line, home of rodeos, concerts and the Beatles in 1964.', (ctx) => {
    const g = seatedGroup(ctx, 37.70676, -122.41880, { bearing: 25 });
    const k = new Kit();
    k.box('solid', 0xd7cdb8, 170, 12, 106, 0, 0, 0);
    k.vault('smooth', 0x8d9492, 168, 53, 0, 12, 0, 0, 0.36, 24);
    k.windows('window', 0x2b3035, 20, 1, 3.5, 3, 4.6, 0, -78, 5, 53.1);
    k.toGroup(g, { name: 'cowpalace' });
    return g;
  });

  // ================================================================== BRIDGES
  // Polyline path helpers (lat/lon list -> local x,z relative to a world origin).
  function localPath(ctx, ll, ox, oz) { return ll.map(([la, lo]) => { const p = ctx.ll2w(la, lo); return [p.x - ox, p.z - oz]; }); }
  function arcLen(pts) { const s = [0]; for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return s; }
  function sampleAt(pts, S, s) {  // -> [x, z, dirx, dirz]
    s = Math.max(0, Math.min(S[S.length - 1], s)); let i = 1; while (i < S.length - 1 && S[i] < s) i++;
    const t = (s - S[i - 1]) / Math.max(1e-6, S[i] - S[i - 1]), a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
    return [a[0] + dx * t, a[1] + dz * t, dx / L, dz / L];
  }
  function projectOnPath(pts, S, x, z) {  // arc length of the closest point
    let best = 1e18, bs = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)), px = a[0] + dx * t - x, pz = a[1] + dz * t - z, d = px * px + pz * pz;
      if (d < best) { best = d; bs = S[i - 1] + t * Math.sqrt(L2); }
    }
    return bs;
  }
  // Deck ribbon + piers along a polyline. heightFn(s) -> deck top (m above water).
  function deckAlong(k, pts, heightFn, o) {
    const S = arcLen(pts), total = S[S.length - 1], step = o.step || 25, th = o.thick || 2.2;
    for (let s = 0; s < total - 0.01; s += step) {
      const s1 = Math.min(total, s + step), a = sampleAt(pts, S, s), b = sampleAt(pts, S, s1);
      const ya = heightFn(s), yb = heightFn(s1), mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, len = Math.hypot(b[0] - a[0], b[1] - a[1]) + 0.35;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), pitch = Math.atan2(yb - ya, len);
      k.boxC(o.key || 'solid', o.color || 0xb9b6ae, len, th, o.width, mx, (ya + yb) / 2 - th / 2, mz, 0, -ang, pitch);
      if (o.girder) k.boxC('solid', o.girder, len, o.girderH || 3, o.width * 0.55, mx, (ya + yb) / 2 - th - (o.girderH || 3) / 2, mz, 0, -ang, pitch);
      if (o.rail) for (const sd of [-1, 1]) {
        const ox = -Math.sin(ang) * sd * (o.width / 2 - 0.3), oz = Math.cos(ang) * sd * (o.width / 2 - 0.3);
        k.boxC('solid', 0xd9d6ce, len, 1.1, 0.35, mx + ox, (ya + yb) / 2 + 0.5, mz + oz, 0, -ang, pitch);
      }
    }
    const pstep = o.pierStep || 40;
    for (let s = (o.pierStart || pstep / 2); s < total - 5; s += pstep) {
      if (o.pierSkip && o.pierSkip(s)) continue;
      const a = sampleAt(pts, S, s), y = heightFn(s); if (y < 3) continue;
      const ang = Math.atan2(a[3], a[2]), n = o.pierCols || 2, top = y - th - (o.girder ? (o.girderH || 3) : 0);
      for (let c = 0; c < n; c++) {
        const off = n === 1 ? 0 : (c / (n - 1) - 0.5) * o.width * 0.72;
        const px = a[0] - Math.sin(ang) * off, pz = a[1] + Math.cos(ang) * off, pw = o.pierW ? o.pierW(y) : Math.max(1.4, y * 0.045);
        k.box('solid', o.pierColor || 0xb3afa6, pw, top + 8, n === 1 ? pw * 0.6 : pw, px, -8, pz, -ang);
      }
      if (n > 1) k.boxC('solid', o.pierColor || 0xb3afa6, 2.2, 1.6, o.width * 0.86, a[0], top - 0.8, a[1], 0, -ang, 0);
    }
    if (o.lamps) for (let s = 10; s < total; s += o.lamps) {
      const a = sampleAt(pts, S, s), y = heightFn(s), ang = Math.atan2(a[3], a[2]);
      for (const sd of [-1, 1]) {
        const off = sd * (o.width / 2 - 0.6), px = a[0] - Math.sin(ang) * off, pz = a[1] + Math.cos(ang) * off;
        k.box('lights', 0xffd9a0, 0.9, 0.35, 0.9, px, y + 9, pz);
      }
    }
    return total;
  }
  // Parabolic cable between (x0,y0) and (x1,y1) along local X, sagging to yLow.
  function cablePts(x0, y0, x1, y1, yLow, n, z) {
    const pts = [], lo = Math.min(yLow, Math.min(y0, y1) - 0.01);
    const d0 = Math.sqrt(Math.max(0, y0 - lo)), d1 = Math.sqrt(Math.max(0, y1 - lo)), ts = d0 / (d0 + d1 || 1), A = (y0 - lo) / (ts * ts || 1);
    for (let i = 0; i <= n; i++) { const t = i / n; pts.push([x0 + (x1 - x0) * t, lo + A * (t - ts) * (t - ts), z]); }
    return pts;
  }
  function cableY(pts, x) { for (let i = 1; i < pts.length; i++) if (pts[i][0] >= x) { const a = pts[i - 1], b = pts[i], t = (x - a[0]) / (b[0] - a[0] || 1); return a[1] + (b[1] - a[1]) * t; } return pts[pts.length - 1][1]; }
  // Thin vertical hanger: an open 3-sided prism (visible from every side, 6 triangles).
  function hanger(k, key, c, x, y0, y1, z, w = 0.35) {
    return k.add(key, xform(new THREE.CylinderGeometry(w, w, Math.max(0.1, y1 - y0), 3, 1, true), x, (y0 + y1) / 2, z), c);
  }
  // Alpha-tested truss side panels (one quad per segment, UV-mapped) instead of thousands of beams.
  const trussTexCache = {};
  function trussTex(kind) {
    if (trussTexCache[kind]) return trussTexCache[kind];
    const t = U.canvasTexture(128, 64, (g, W, H) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.strokeStyle = '#fff'; g.lineCap = 'square';
      g.lineWidth = 10; g.beginPath(); g.moveTo(0, 5); g.lineTo(W, 5); g.moveTo(0, H - 5); g.lineTo(W, H - 5); g.stroke();
      g.lineWidth = 8; g.beginPath();
      if (kind === 'x') { g.moveTo(0, 0); g.lineTo(W, H); g.moveTo(W, 0); g.lineTo(0, H); g.moveTo(1, 0); g.lineTo(1, H); g.moveTo(W - 1, 0); g.lineTo(W - 1, H); }
      else { g.moveTo(0, H); g.lineTo(W / 2, 0); g.lineTo(W, H); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.moveTo(1, 0); g.lineTo(1, H); }
      g.stroke();
    }, { repeat: true, srgb: false });
    trussTexCache[kind] = t; return t;
  }
  function trussMaterial(color, kind, emissive) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.3, alphaMap: trussTex(kind), alphaTest: 0.35, side: THREE.DoubleSide });
    if (emissive) { m.emissive = new THREE.Color(emissive); m.emissiveIntensity = 0; m.userData.floodK = 0.25; trackMat(m, 'flood'); }
    return m;
  }
  // runs: arrays of [x, yTop, z] points; each run becomes a strip of panels hanging down by h.
  function panelGeo(runs, h, panelLen) {
    const pos = [], uv = [], idx = [];
    for (const run of runs) {
      let u = 0;
      for (let i = 0; i < run.length - 1; i++) {
        const a = run[i], b = run[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), u1 = u + L / panelLen, o = pos.length / 3;
        pos.push(a[0], a[1], a[2], b[0], b[1], b[2], b[0], b[1] - h, b[2], a[0], a[1] - h, a[2]);
        uv.push(u, 1, u1, 1, u1, 0, u, 0); idx.push(o, o + 2, o + 1, o, o + 3, o + 2); u = u1;
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere(); return g;
  }
  let FW = null; const floodWarm = () => FW || (FW = floodMat(0xffd9a8, 0.2, { roughness: 0.8, metalness: 0 }));
  function floodMat(emissive, k = 0.3, base = {}) {
    const m = new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: 0.5, metalness: 0.2, emissive: new THREE.Color(emissive), emissiveIntensity: 0 }, base));
    m.userData.floodK = k; return trackMat(m, 'flood');
  }

  // Shimmering LED strands for the Bay Bridge suspenders ("The Bay Lights"): additive, night only.
  let bayLightsMat = null;
  function bayLightsMaterial() {
    if (bayLightsMat) return bayLightsMat;
    bayLightsMat = new THREE.ShaderMaterial({
      uniforms: Object.assign({ uNight: U.uNight, uTime: U.uTime }, THREE.UniformsLib.fog),
      vertexShader: `attribute vec2 aP; varying vec2 vP;
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        void main(){ vP = aP; vec4 mvPosition = blBend(modelViewMatrix * vec4(position,1.0)); gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }`,
      fragmentShader: `uniform float uNight; uniform float uTime; varying vec2 vP;
        #include <common>
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          float xi = vP.x, h = vP.y;
          float d = abs(fract(xi + 0.5) - 0.5), fw = max(fwidth(xi), 1e-4);
          float line = 1.0 - smoothstep(0.035, 0.035 + fw * 1.3, d);
          line = mix(line, 0.38, smoothstep(0.06, 0.3, fw));          // far away the strands merge into a glowing curtain
          float x = xi * 12.0 / 3200.0;
          float w1 = 0.5 + 0.5*sin(x*70.0 - uTime*0.8 + sin(h*3.0 + uTime*0.35)*2.0);
          float w2 = 0.5 + 0.5*sin(x*23.0 + uTime*0.5 - h*4.0);
          float fall = 0.5 + 0.5*sin(h*16.0 + uTime*2.0 + x*140.0);
          float cell = floor(xi) + floor(h*36.0 - uTime*2.5)*57.0;
          float sparkle = step(0.975, fract(sin(cell*12.9898)*43758.5453));
          float v = pow(w1*w2, 1.3)*0.95 + fall*0.10 + sparkle*0.8;
          float a = clamp(v, 0.0, 1.0) * line * smoothstep(0.3, 0.75, uNight);
          gl_FragColor = vec4(vec3(0.93,0.96,1.0)*a*2.2, 1.0);
          #include <fog_fragment>
        }`,
      extensions: { derivatives: true },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: true, toneMapped: false,
    });
    return bayLightsMat;
  }

  // --- San Francisco-Oakland Bay Bridge, West Span: two suspension bridges joined at the center
  // anchorage. Towers, anchorages and abutments are at their OpenStreetMap positions.
  const BBW = { abut: [37.7863573, -122.3905385], w1: [37.7883031, -122.3884509], ca: [37.7981898, -122.3778605], ybi: [37.8082033, -122.3671316],
    towers: [[37.7907532, -122.3858231], [37.795588, -122.3806477], [37.8007874, -122.3750797], [37.8056223, -122.3698997]] };
  // upper deck (westbound) top; lower deck (eastbound) 9.5 m below. 58 m clearance over the channels.
  function bbwGeom(ll2w) {
    const a = ll2w(...BBW.abut), b = ll2w(...BBW.ybi);
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const along = ll => { const p = ll2w(ll[0], ll[1]); return (p.x - a.x) * ux + (p.z - a.z) * uz; };
    const W1 = along(BBW.w1), CA = along(BBW.ca), T = BBW.towers.map(along), W7 = L;
    const deckY = x => x < W1 ? 30 + 32 * U.smooth(0, W1, x) : 62 + 8 * Math.sin(Math.PI * Math.min(1, (x - W1) / (W7 - W1)));
    return { a, dx, dz, ux, uz, W1, CA, T, W7, deckY, TD: 9.5 };
  }
  def('Bay Bridge (West Span)', 37.79819, -122.37786, 1800, 'Twin 1936 suspension bridges joined mid-bay at a concrete anchorage; at night tens of thousands of LEDs shimmer on its cables (The Bay Lights).', (ctx) => {
    const { a, dx, dz, W1, CA, T, W7, deckY } = bbwGeom(ctx.ll2w);
    const g = new THREE.Group(); g.position.set(a.x, 0, a.z); g.rotation.y = ryOf(Math.atan2(dx, -dz) / DEG);
    const k = new Kit(), steel = 0x9ea5a9, dark = 0x7a8286;
    const W = 20, TD = 9.5, LZ = 11.5;
    const top = [], bot = [];
    for (let x = 0; x < W7; x += 30) {
      const x1 = Math.min(W7, x + 30), y0 = deckY(x), y1 = deckY(x1), p = Math.atan2(y1 - y0, x1 - x);
      k.boxC('solid', 0xa9aaa6, x1 - x + 0.2, 1.2, W, (x + x1) / 2, (y0 + y1) / 2 - 0.6, 0, 0, 0, p);
      k.boxC('solid', 0x9d9e9a, x1 - x + 0.2, 1.0, W - 1, (x + x1) / 2, (y0 + y1) / 2 - TD - 0.5, 0, 0, 0, p);
    }
    for (let x = 0; x <= W7 + 0.1; x += W7 / 110) { top.push([x, deckY(x) + 1.4, W / 2]); bot.push([x, deckY(x) + 1.4, -W / 2]); }
    const truss = new THREE.Mesh(panelGeo([top, bot], TD + 3.2, 12), trussMaterial(0xa3aaae, 'warren')); truss.name = 'baybridge-west:truss'; truss.castShadow = true; g.add(truss);
    // Rincon Hill approach: column bents; tower and anchorage piers
    for (let x = 25; x < W1 - 20; x += 42) for (const sd of [-1, 1]) k.box('solid', 0xb9b4a8, 2.6, deckY(x) - TD - 1, 2.6, x, 0, sd * 8);
    for (const tx of T) k.box('solid', 0xa7a39a, 30, 14, 44, tx, -8, 0);
    k.box('solid', 0xb8b3a8, 46, deckY(W1) - 2 + 8, 40, W1, -8, 0);                 // SF anchorage (W1)
    k.box('solid', 0xc2bdb1, 64, 75, 48, CA, -8, 0); k.box('solid', 0xb2ada1, 50, 8, 40, CA, 67, 0);   // center anchorage (67 m)
    k.box('solid', 0xb8b3a8, 50, 64, 42, W7 - 10, -8, 0);                            // YBI anchorage
    // towers: two steel legs, stacked X-bracing above the deck, struts; beacons on top
    const TH = 160;
    for (const tx of T) {
      for (const sd of [-1, 1]) { k.box('paint', steel, 6.5, TH, 5, tx, 0, sd * LZ); k.box('paint', steel, 7.6, 3.5, 6.2, tx, TH - 3.5, sd * LZ); }
      const yd = deckY(tx) + 3;
      const levels = [yd, yd + (TH - yd) * 0.3, yd + (TH - yd) * 0.56, yd + (TH - yd) * 0.8, TH - 4];
      for (let i = 0; i < levels.length - 1; i++) {
        k.beam('paint', dark, [tx, levels[i], -LZ], [tx, levels[i + 1], LZ], 1.4); k.beam('paint', dark, [tx, levels[i], LZ], [tx, levels[i + 1], -LZ], 1.4);
        k.box('paint', steel, 4.4, 2.4, 2 * LZ, tx, levels[i + 1] - 1.2, 0);
      }
      k.box('paint', steel, 4.4, 3, 2 * LZ, tx, deckY(tx) - TD - 5, 0);
      for (const sd of [-1, 1]) k.box('beacon', 0xff2a1a, 1.4, 1.4, 1.4, tx, TH, sd * LZ);
    }
    // main cables, hangers and the LED strands
    const ledPos = [], ledP = [], ledIdx = [];
    const curtain = (cols, z) => { for (let i = 0; i < cols.length; i++) { const [x, y0, y1] = cols[i], o = ledPos.length / 3;   // LED sheet through the suspender cables
      ledPos.push(x, y0, z, x, y1, z); ledP.push(x / 12, 0, x / 12, 1); if (i > 0) ledIdx.push(o - 2, o, o + 1, o - 2, o + 1, o - 1); } };
    const spans = [[W1, deckY(W1) + 2, T[0], TH, 0], [T[0], TH, T[1], TH, 1], [T[1], TH, CA, 66, 0], [CA, 66, T[2], TH, 0], [T[2], TH, T[3], TH, 1], [T[3], TH, W7 - 10, deckY(W7) + 2, 0]];
    for (const sd of [-1, 1]) for (const [x0, y0, x1, y1, main] of spans) {
      const cp = cablePts(x0, y0, x1, y1, main ? deckY((x0 + x1) / 2) + 5 : Math.min(y0, y1) - 3, 22, sd * LZ);
      k.tube('paint', 0x8f969a, cp, 0.6, 5, 1);
      const cols = [];
      for (let x = Math.ceil((x0 + 6) / 12) * 12; x < x1 - 6; x += 12) {
        const yc = cableY(cp, x), yd = deckY(x) + 1.4; if (yc - yd < 1.5) continue;
        hanger(k, 'paint', 0x7c8286, x, yd, yc, sd * LZ, 0.2); cols.push([x, yd + 0.4, yc - 0.2]);
      }
      curtain(cols, sd * (LZ + 0.3));
    }
    for (let x = 20; x < W7; x += 45) for (const sd of [-1, 1]) k.box('lights', 0xffd9a0, 0.8, 0.3, 0.8, x, deckY(x) + 8.5, sd * (W / 2 - 1));
    k.toGroup(g, { name: 'baybridge-west' });
    { const sol = [];                                   // towers (legs, the braced frame between them above the deck), both decks with the truss, the anchorages
      for (const tx of T) { for (const sd of [-1, 1]) sol.push({ pts: RB(3.3, 2.6, tx, sd * LZ), top: TH }); sol.push({ pts: RB(2.3, LZ, tx, 0), bot: deckY(tx) + 3, top: TH }); }
      for (let x = 0; x < W7; x += 60) { const xc = Math.min(W7 - 30, x + 30); sol.push({ pts: RB(30, W / 2 + 0.5, xc, 0), bot: deckY(xc) - TD - 1.5, top: deckY(xc) + 1.2 }); }
      sol.push({ pts: RB(32, 24, CA, 0), top: 67 }, { pts: RB(23, 20, W1, 0), top: deckY(W1) - 2 }, { pts: RB(25, 21, W7 - 10, 0), top: 56 });
      g.userData.solids = sol; }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(ledPos, 3)); lg.setAttribute('aP', new THREE.Float32BufferAttribute(ledP, 2)); lg.setIndex(ledIdx);
    lg.computeBoundingSphere(); const leds = new THREE.Mesh(lg, bayLightsMaterial()); leds.name = 'baylights'; leds.renderOrder = 5; g.add(leds);
    g.userData.tris = k.tris + ledIdx.length / 3 + 220;
    return g;
  });

  // --- Bay Bridge East Span (2013): self-anchored suspension span with one 160 m tower between two
  // parallel decks, then the concrete Skyway descending to the Oakland touchdown.
  const BB_EB = [[37.811311,-122.363778],[37.81194,-122.363126],[37.812303,-122.362716],[37.812579,-122.362386],[37.812941,-122.361918],[37.813295,-122.361426],[37.813534,-122.36107],[37.813777,-122.360688],[37.814008,-122.360301],[37.817225,-122.354667],[37.817513,-122.354115],[37.817718,-122.353673],[37.817904,-122.353237],[37.818075,-122.352794],[37.818232,-122.352336],[37.818373,-122.351874],[37.818537,-122.35125],[37.818643,-122.350773],[37.818733,-122.350297],[37.820023,-122.341501],[37.821272,-122.332932],[37.821402,-122.331956],[37.821561,-122.330629],[37.821659,-122.329673],[37.821751,-122.328688],[37.821831,-122.327715]];
  const BB_WB = [[37.814388,-122.360446],[37.814466,-122.360312],[37.817525,-122.354958],[37.817674,-122.354682],[37.817816,-122.354404],[37.818018,-122.353977],[37.818144,-122.353689],[37.818324,-122.353245],[37.818436,-122.352947],[37.81854,-122.352644],[37.818687,-122.352181],[37.818774,-122.351873],[37.818857,-122.351558],[37.818968,-122.351083],[37.819035,-122.350764],[37.819094,-122.350443],[37.81917,-122.349956],[37.820404,-122.341524],[37.821589,-122.333408],[37.82172,-122.33243],[37.821801,-122.331781],[37.821914,-122.330798],[37.821981,-122.330144],[37.822045,-122.329489],[37.82213,-122.328504],[37.822189,-122.327757]];
  function bbeGeom(ll2w) {
    const o = ll2w(37.8152652, -122.3585059), eb = localPath({ ll2w }, BB_EB, o.x, o.z), wb = localPath({ ll2w }, BB_WB, o.x, o.z);
    const S = arcLen(eb), TOT = S[S.length - 1], Sw = arcLen(wb);
    const sT = projectOnPath(eb, S, 0, 0), sTw = projectOnPath(wb, Sw, 0, 0), sW2 = sT - 385, sE2 = sT + 180;
    const hFn = s => s < sW2 ? 42 + 6 * U.smooth(0, sW2, s) : s < sE2 + 80 ? 48 : Math.max(3, 48 - 40 * U.smooth(sE2 + 80, TOT - 250, s) - 5 * U.smooth(TOT - 250, TOT, s));
    const hW = s => hFn(s - sTw + sT);
    return { o, eb, wb, S, Sw, TOT, sT, sTw, sW2, sE2, hFn, hW };
  }
  def('Bay Bridge (East Span)', 37.8152652, -122.3585059, 1900, 'The 2013 East Span: a single 160 m tower carries two parallel decks, the world\'s longest self-anchored suspension span.', (ctx) => {
    const { o, eb, wb, S, Sw, sT, sTw, sW2, sE2, hFn, hW } = bbeGeom(ctx.ll2w);
    const g = new THREE.Group(); g.position.set(o.x, 0, o.z);
    const k = new Kit();
    const common = { width: 25, thick: 1.8, color: 0xd2cfc6, girder: 0xc9c5bb, girderH: 3.4, step: 30, pierStep: 160, pierCols: 1, pierW: y => 7 + y * 0.05, pierColor: 0xc9c5ba, lamps: 50, rail: true };
    deckAlong(k, eb, hFn, Object.assign({ pierStart: sE2, pierSkip: s => s < sE2 - 5 }, common));
    deckAlong(k, wb, hW, Object.assign({ pierStart: sE2 - sT + sTw, pierSkip: s => s < sE2 - sT + sTw - 5 }, common));
    // SAS piers at W2 (YBI side) and E2
    for (const [path, SS, s] of [[eb, S, sW2], [eb, S, sE2], [wb, Sw, sW2 - sT + sTw], [wb, Sw, sE2 - sT + sTw]]) { const p = sampleAt(path, SS, s); k.box('solid', 0xc9c5ba, 14, 44, 16, p[0], -6, p[1], -Math.atan2(p[3], p[2])); }
    // the tower: four tapered legs joined by shear-link struts, between the decks
    const t = sampleAt(eb, S, sT), ang = Math.atan2(t[3], t[2]);
    for (const [lx, lz] of [[-3.8, -4.5], [3.8, -4.5], [-3.8, 4.5], [3.8, 4.5]]) { const p = rot(lx, lz, -ang); k.cyl('paint', 0xd6d9db, 1.9, 2.6, 166, p[0], -6, p[1], 5); }
    for (let y = 30; y < 158; y += 14) k.box('paint', 0xc3c7ca, 9.5, 1.2, 11.5, 0, y, 0, -ang);
    k.box('paint', 0xd6d9db, 11, 4, 13, 0, 156, 0, -ang); k.box('beacon', 0xff2a1a, 1.6, 1.6, 1.6, 0, 160, 0);
    // main cable over the tower saddle to each deck's inner edge, with hangers
    for (const [path, SS, off] of [[eb, S, 0], [wb, Sw, sTw - sT]]) {
      const a0 = sW2 + off, a1 = sE2 + off, ts = (sT + off - a0) / (a1 - a0), pts = [];
      for (let i = 0; i <= 26; i++) {
        const u = i / 26, s = a0 + (a1 - a0) * u, p = sampleAt(path, SS, s), yd = (off ? hW(s) : hFn(s)) + 2;
        const y = u < ts ? yd + (156 - yd) * Math.pow(Math.min(1, 1 - (ts - u) / ts), 2.2) : yd + (156 - yd) * Math.pow(Math.min(1, (1 - u) / (1 - ts)), 2.2);
        const inward = Math.sign(-p[0] * -p[3] + -p[1] * p[2]) || 1;
        pts.push([p[0] - p[3] * inward * 11.5, y, p[1] + p[2] * inward * 11.5]);
      }
      k.tube('paint', 0xb1b6ba, pts, 0.8, 6, 2);
      for (let i = 1; i < pts.length - 1; i++) { const q = pts[i], s = a0 + (a1 - a0) * i / 26, yd = (off ? hW(s) : hFn(s)) + 0.8; if (q[1] - yd > 2.5) hanger(k, 'paint', 0x9aa0a4, q[0], yd, q[1], q[2], 0.22); }
    }
    k.toGroup(g, { name: 'baybridge-east' });
    return g;
  });

  // --- Golden Gate Bridge. Towers at their OSM positions (1280 m main span, 343 m side spans).
  function ggGeom(ll2w) {
    const n = ll2w(37.8255026, -122.4792332), s = ll2w(37.8140144, -122.477891);
    const dx = s.x - n.x, dz = s.z - n.z, MAIN = Math.hypot(dx, dz), NA = -343, SA = MAIN + 343;
    const dY = x => 70 + 5 * Math.sin(Math.PI * Math.min(1, Math.max(0, x / MAIN))) - (x < NA ? (NA - x) * 0.012 : 0);
    return { n, dx, dz, MAIN, NA, SA, dY };
  }
  def('Golden Gate Bridge', 37.81976, -122.47856, 1800, 'The 1937 International Orange suspension bridge; its towers rise 227 m above the Golden Gate strait.', (ctx) => {
    const { n, dx, dz, MAIN, NA, SA, dY } = ggGeom(ctx.ll2w);
    const g = new THREE.Group(); g.position.set(n.x, 0, n.z); g.rotation.y = ryOf(Math.atan2(dx, -dz) / DEG);
    const k = new Kit(), orange = 0xc0482f, TH = 227, LZ = 13.75, W = 27;
    const towerMatl = floodMat(0xff8a4a, 0.28, { roughness: 0.55, metalness: 0.25 });
    const top = [], bot = [];
    for (let x = NA - 280; x < SA + 330; x += 30) {
      const x1 = x + 30, y0 = dY(x), y1 = dY(x1), p = Math.atan2(y1 - y0, 30);
      k.boxC('solid', 0x8f8c86, 30.2, 1.0, W, x + 15, (y0 + y1) / 2 + 0.3, 0, 0, 0, p);
      for (const sd of [-1, 1]) k.boxC('paint', orange, 30.2, 1.2, 0.9, x + 15, (y0 + y1) / 2 + 1.3, sd * W / 2, 0, 0, p);
    }
    for (let x = NA; x <= SA + 0.1; x += 16) { top.push([x, dY(x) + 0.5, W / 2]); bot.push([x, dY(x) + 0.5, -W / 2]); }
    const truss = new THREE.Mesh(panelGeo([top, bot], 7.6, 7.6), trussMaterial(orange, 'warren')); truss.name = 'goldengate:truss'; truss.castShadow = true; g.add(truss);
    // approach viaduct piers (Marin side and over Fort Point / the Presidio)
    for (let x = NA - 260; x < NA - 10; x += 50) for (const sd of [-1, 1]) k.box('paint', orange, 2.6, dY(x) - 8, 2.6, x, -6, sd * 10);
    for (let x = SA + 30; x < SA + 330; x += 50) for (const sd of [-1, 1]) k.box('paint', orange, 2.6, dY(x) - 8, 2.6, x, -6, sd * 10);
    // Fort Point arch
    { const ax = SA + 95, pts = []; for (let i = 0; i <= 16; i++) { const u = i / 16; pts.push([ax - 55 + 110 * u, 20 + 42 * Math.sin(Math.PI * u), 0]); }
      for (const sd of [-1, 1]) k.tube('paint', orange, pts.map(p => [p[0], p[1], sd * 10]), 1.6, 6, 1); }
    // towers: stepped legs, four Art Deco portal struts above the deck, braced below
    const tk = new Kit();
    for (const tx of [0, MAIN]) {
      for (const sd of [-1, 1]) {
        tk.box('x', orange, 10, 75, 16.5, tx, -4, sd * LZ); tk.box('x', orange, 9, 48, 14, tx, 71, sd * LZ);
        tk.box('x', orange, 8, 40, 12, tx, 119, sd * LZ); tk.box('x', orange, 7.4, 33, 10.5, tx, 159, sd * LZ); tk.box('x', orange, 7, 35, 9.5, tx, 192, sd * LZ);
        for (const fz of [-1, 1]) tk.box('x', 0x9e3a26, 10.6, 150, 0.8, tx, 74, sd * LZ + fz * 3.1);     // vertical recess shadows
      }
      for (const [y, h] of [[118, 8], [157, 7], [190, 7], [219, 8]]) { tk.box('x', orange, 6.5, h, 2 * LZ, tx, y, 0); tk.box('x', 0x9e3a26, 6.8, h * 0.6, 2 * LZ - 12, tx, y + h * 0.2, 0); }
      tk.beam('x', orange, [tx, 8, -LZ], [tx, 58, LZ], 3); tk.beam('x', orange, [tx, 8, LZ], [tx, 58, -LZ], 3);
      k.add('solid', xform(new THREE.CylinderGeometry(1, 1, 10, 24), tx, -3, 0, 0, 0, 0, 34, 1, 22), 0x9a968c);   // pier / fender
      for (const sd of [-1, 1]) k.box('beacon', 0xff2a1a, 1.6, 1.6, 1.6, tx, TH, sd * LZ);
    }
    tk.parts.set(towerMatl, tk.parts.get('x')); tk.parts.delete('x'); tk.toGroup(g, { name: 'goldengate:towers' });
    // cables + hangers (every 15.2 m), anchorages
    for (const sd of [-1, 1]) {
      for (const [x0, y0, x1, y1, main] of [[NA, dY(NA) + 6, 0, TH - 2, 0], [0, TH - 2, MAIN, TH - 2, 1], [MAIN, TH - 2, SA, dY(SA) + 6, 0]]) {
        const cp = cablePts(x0, y0, x1, y1, main ? dY(MAIN / 2) + 3 : Math.min(y0, y1) - 4, main ? 32 : 12, sd * LZ);
        k.tube('paint', orange, cp, 0.46, 6, 1);
        for (let x = x0 + 15.2; x < x1 - 7; x += 15.2) { const yc = cableY(cp, x), yd = dY(x) + 1.4; if (yc - yd > 1.2) hanger(k, 'paint', orange, x, yd, yc, sd * LZ, 0.18); }
      }
      k.box('beacon', 0xff2a1a, 1, 1, 1, MAIN / 2, dY(MAIN / 2) + 4, sd * LZ);
    }
    k.box('solid', 0xa39e92, 50, dY(NA) + 16, 60, NA - 10, -8, 0); k.box('solid', 0xa39e92, 50, dY(SA) + 16, 60, SA + 10, -8, 0);
    for (let x = NA - 240; x < SA + 300; x += 50) for (const sd of [-1, 1]) k.box('lights', 0xffc070, 0.7, 0.4, 0.7, x, dY(x) + 7.5, sd * (W / 2 - 0.5));
    k.toGroup(g, { name: 'goldengate' });
    const sol = [];                                     // towers (legs; the portal struts from 118 m), the deck and truss, the anchorages
    for (const tx of [0, MAIN]) { for (const sd of [-1, 1]) sol.push({ pts: RB(5, 8.25, tx, sd * LZ), top: TH }); sol.push({ pts: RB(3.3, LZ, tx, 0), bot: 118, top: TH }); }
    for (let x = NA - 280; x < SA + 330; x += 60) sol.push({ pts: RB(30, W / 2 + 0.5, x + 30, 0), bot: dY(x + 30) - 7.6, top: dY(x + 30) + 1.5 });
    sol.push({ pts: RB(25, 30, NA - 10, 0), top: dY(NA) + 8 }, { pts: RB(25, 30, SA + 10, 0), top: dY(SA) + 8 });
    g.userData.solids = sol;
    return g;
  });

  // --- San Mateo-Hayward Bridge: high-rise over the channel at the Peninsula end, then a 7 km trestle.
  const SMB = [[37.572901,-122.263128],[37.588998,-122.245479],[37.589216,-122.245233],[37.589423,-122.244999],[37.589556,-122.244834],[37.589689,-122.244661],[37.589802,-122.24451],[37.589918,-122.244345],[37.590031,-122.244173],[37.590155,-122.243974],[37.590267,-122.243783],[37.590387,-122.243562],[37.590486,-122.243367],[37.59059,-122.243156],[37.590673,-122.242969],[37.590755,-122.242774],[37.590837,-122.242565],[37.590918,-122.242341],[37.590983,-122.242151],[37.591048,-122.241941],[37.591192,-122.241466],[37.591328,-122.24101],[37.592821,-122.235988],[37.593364,-122.23421],[37.593834,-122.232653],[37.602338,-122.204066],[37.608002,-122.185009],[37.612346,-122.170389],[37.616709,-122.155695]];
  function smbGeom(ll2w) {
    const o = ll2w(...SMB[0]), pts = localPath({ ll2w }, SMB, o.x, o.z), S = arcLen(pts);
    const hFn = s => s < 450 ? 5 + s / 450 * 22 : s < 950 ? 27 + (s - 450) / 500 * 17 : s < 1850 ? 44 : s < 2800 ? 44 - (s - 1850) / 950 * 36 : 8;
    return { o, pts, S, hFn };
  }
  def('San Mateo-Hayward Bridge', 37.5940, -122.2300, 5500, 'An 11 km crossing of the Bay: an orthotropic steel high-rise over the shipping channel, then a long low trestle to Hayward.', (ctx) => {
    const { o, pts, S, hFn } = smbGeom(ctx.ll2w);
    const g = new THREE.Group(); g.position.set(o.x, 0, o.z);
    const k = new Kit();
    deckAlong(k, pts, hFn, { width: 26, thick: 2.2, color: 0xb9b6ad, step: 60, pierStep: 42, pierCols: 2, pierColor: 0xaaa69c, pierSkip: s => s > 950 && s < 1850 && (s % 90) > 42 });
    for (let s = 950; s < 1850; s += 45) { const a = sampleAt(pts, S, s), b = sampleAt(pts, S, s + 45), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      k.boxC('paint', 0x5f7f96, 45.5, 3.6, 18, (a[0] + b[0]) / 2, 44 - 4, (a[1] + b[1]) / 2, 0, -ang, 0); }
    for (let s = 300; s < 3000; s += 90) { const a = sampleAt(pts, S, s), ang = Math.atan2(a[3], a[2]);
      for (const sd of [-1, 1]) k.box('lights', 0xffd9a0, 0.7, 0.3, 0.7, a[0] - Math.sin(ang) * sd * 12, hFn(s) + 8, a[1] + Math.cos(ang) * sd * 12); }
    k.toGroup(g, { name: 'sanmateobridge' });
    return g;
  });
  const DUMB = [[37.497936,-122.130011],[37.498366,-122.129447],[37.498768,-122.128941],[37.499163,-122.128405],[37.499516,-122.127902],[37.499869,-122.127379],[37.50676,-122.117138],[37.508776,-122.114143],[37.509179,-122.113566],[37.50959,-122.113013],[37.510027,-122.112454],[37.510512,-122.11185],[37.510998,-122.11129],[37.511483,-122.110755],[37.511975,-122.110239],[37.512467,-122.109739],[37.512967,-122.109256],[37.513487,-122.10879],[37.514072,-122.10834]];
  function dumbGeom(ll2w) {
    const o = ll2w(...DUMB[0]), pts = localPath({ ll2w }, DUMB, o.x, o.z), S = arcLen(pts), T = S[S.length - 1];
    const hFn = s => { const u = s / T; return 4 + 28 * Math.exp(-Math.pow((u - 0.55) / 0.22, 2)); };
    return { o, pts, S, hFn };
  }
  def('Dumbarton Bridge', 37.5068, -122.1171, 1400, 'The southernmost Bay crossing (1982), arching 26 m over the channel between Menlo Park and Newark.', (ctx) => {
    const { o, pts, hFn } = dumbGeom(ctx.ll2w);
    const g = new THREE.Group(); g.position.set(o.x, 0, o.z);
    const k = new Kit();
    deckAlong(k, pts, hFn, { width: 26, thick: 3.4, color: 0xc2beb4, step: 30, pierStep: 55, pierCols: 2, pierColor: 0xb8b3a8, lamps: 60, rail: true });
    k.toGroup(g, { name: 'dumbarton' });
    return g;
  });

  // Road decks of the modelled bridges: the driving surface at a world point (null off the decks), from the same
  // geometry the models are built from, so Towns lays the OSM bridge roads and their traffic on the decks (not on
  // its generic 6.5 m overpass ramps, which put Golden Gate traffic just above the water). dirx/dirz, the direction
  // of travel, picks the West Span's deck: westbound on top, eastbound 9.5 m below.
  let DECKS = null;
  function nearestOnPath(pts, S, x, z) {
    let best = 1e18, bs = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)), px = a[0] + dx * t - x, pz = a[1] + dz * t - z, d = px * px + pz * pz;
      if (d < best) { best = d; bs = S[i - 1] + t * Math.sqrt(L2); }
    }
    return { s: bs, d: Math.sqrt(best) };
  }
  function decks() {
    if (DECKS) return DECKS;
    const ll2w = Geo.ll2w, D = [];
    const axis = (o, ux, uz, a0, a1, hw, y) => { const xs = [o.x + ux * a0, o.x + ux * a1], zs = [o.z + uz * a0, o.z + uz * a1];
      D.push({ o, ux, uz, a0, a1, hw, y, minx: Math.min(...xs) - hw, maxx: Math.max(...xs) + hw, minz: Math.min(...zs) - hw, maxz: Math.max(...zs) + hw }); };
    const path = (o, pts, S, hw, y) => { let minx = 1e18, maxx = -1e18, minz = 1e18, maxz = -1e18;
      for (const p of pts) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]); }
      D.push({ o, pts, S, hw, y, minx: o.x + minx - hw, maxx: o.x + maxx + hw, minz: o.z + minz - hw, maxz: o.z + maxz + hw }); };
    { const g = ggGeom(ll2w); axis(g.n, g.dx / g.MAIN, g.dz / g.MAIN, g.NA - 280, g.SA + 330, 15, al => g.dY(al) + 0.8); }
    { const g = bbwGeom(ll2w); axis(g.a, g.ux, g.uz, 0, g.W7, 13, (al, fwd) => g.deckY(al) - (fwd > 0 ? g.TD : 0)); }
    { const g = bbeGeom(ll2w); path(g.o, g.eb, g.S, 14, g.hFn); path(g.o, g.wb, g.Sw, 14, g.hW); }
    { const g = smbGeom(ll2w); path(g.o, g.pts, g.S, 16, g.hFn); }
    { const g = dumbGeom(ll2w); path(g.o, g.pts, arcLen(g.pts), 16, g.hFn); }
    return (DECKS = D);
  }
  function deckAt(x, z, dirx, dirz) {
    let best = null, bd = 1e18;
    for (const e of decks()) {
      if (x < e.minx || x > e.maxx || z < e.minz || z > e.maxz) continue;
      if (e.pts) { const r = nearestOnPath(e.pts, e.S, x - e.o.x, z - e.o.z); if (r.d <= e.hw && r.d < bd) { bd = r.d; best = e.y(r.s); } continue; }
      const px = x - e.o.x, pz = z - e.o.z, al = px * e.ux + pz * e.uz, lat = Math.abs(pz * e.ux - px * e.uz);
      if (al < e.a0 || al > e.a1 || lat > e.hw || lat >= bd) continue;
      bd = lat; best = e.y(al, dirx === undefined ? 0 : dirx * e.ux + dirz * e.uz);
    }
    return best;
  }

  // ================================================================== shared builders (peninsula / south bay)
  // Triangle soup whose faces are oriented by a hint direction (robust winding for hand-built shells).
  class Soup {
    constructor() { this.p = []; }
    tri(a, b, c, h) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * h[0] + ny * h[1] + nz * h[2] < 0) this.p.push(...a, ...c, ...b); else this.p.push(...a, ...b, ...c);
    }
    quad(a, b, c, d, h) { this.tri(a, b, c, h); this.tri(a, c, d, h); }
    geo() { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.computeVertexNormals(); return g; }
  }
  // Seating bowl between two matching outlines (inner at yi, outer at yo) with front and back walls.
  function bowlSoup(inner, outer, yi, yo, closed = true, soup = new Soup()) {
    const n = inner.length, m = closed ? n : n - 1;
    let cx = 0, cz = 0; for (const p of inner) { cx += p[0]; cz += p[1]; } cx /= n; cz /= n;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % n, a = inner[i], b = inner[j], c = outer[j], d = outer[i];
      const nx = (a[0] + b[0]) / 2 - cx, nz = (a[1] + b[1]) / 2 - cz;
      soup.quad([a[0], yi, a[1]], [b[0], yi, b[1]], [c[0], yo, c[1]], [d[0], yo, d[1]], [-nx * 0.02, 1, -nz * 0.02]);
      soup.quad([a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], yi, b[1]], [a[0], yi, a[1]], [-nx, 0, -nz]);
      soup.quad([d[0], 0, d[1]], [c[0], 0, c[1]], [c[0], yo, c[1]], [d[0], yo, d[1]], [nx, 0, nz]);
    }
    return soup;
  }
  // Streamlined airship hangar shell (length L along X, width W, height H), catenary-like section.
  // endR > 0 rounds the ends into "orange peel" doors; 0 leaves open arch ends (caller adds doors).
  function hangarGeo(L, W, H, endR, nx = 28, nt = 18) {
    const pos = [], idx = [];
    for (let i = 0; i <= nx; i++) {
      const x = -L / 2 + L * i / nx, e = Math.max(0, Math.abs(x) - (L / 2 - endR)), s = endR > 0 ? Math.sqrt(Math.max(0, 1 - (e / endR) ** 2)) : 1;
      for (let j = 0; j <= nt; j++) { const th = Math.PI * j / nt; pos.push(x, H * Math.pow(Math.sin(th), 0.7) * Math.pow(s, 0.55), (W / 2) * Math.cos(th) * s); }
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j < nt; j++) { const a = i * (nt + 1) + j, b = a + 1, c = a + nt + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  function archProfile(W, H, n = 16) { const p = []; for (let j = 0; j <= n; j++) { const th = Math.PI * j / n; p.push([(W / 2) * Math.cos(th), H * Math.pow(Math.sin(th), 0.7)]); } return p; }
  // Height-field canopy over a rectangle (for tent / dragonscale roofs). hf(x,z) -> y. UV = plan / uvScale.
  function canopyGeo(w, d, nx, nz, hf, uvScale = 10) {
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) { const x = -w / 2 + w * i / nx, z = -d / 2 + d * j / nz; pos.push(x, hf(x, z), z); uv.push(x / uvScale, -z / uvScale); }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, e = c + 1; idx.push(a, c, b, b, c, e); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  // Coast redwood (stylized): tapering trunk + stacked irregular cones.
  function redwood(k, x, y, z, h, seed = 1) {
    const R = U.rng(seed);
    k.cyl('solid', 0x6a3b28, h * 0.008, h * 0.034, h * 0.93, x, y, z, 9);
    for (let i = 0; i < 11; i++) {
      const t = i / 10, yy = y + h * (0.22 + 0.7 * t), rr = h * (0.12 * (1 - t) * (0.8 + R() * 0.4) + 0.035);
      k.cone('solid', [0x3b4a2a, 0x34442a, 0x42532f][i % 3], rr, h * (0.17 - 0.05 * t), x + (R() - 0.5) * h * 0.03, yy, z + (R() - 0.5) * h * 0.03, 9, R() * 6);
    }
  }
  // Allow pre-colored geometry (with its own color attribute) to be merged into a Kit bucket.
  Kit.prototype.raw = function (key, geo) { for (const n of Object.keys(geo.attributes)) if (n !== 'position' && n !== 'normal' && n !== 'color') geo.deleteAttribute(n); if (!this.parts.has(key)) this.parts.set(key, []); this.parts.get(key).push(geo); return this; };
  // Generic narrow-body airliner (neutral livery), nose toward local +X, gear on the ground at y=0.
  let _jetGeo = null;
  function jetGeo() {
    if (_jetGeo) return _jetGeo;
    const k = new Kit(), wht = 0xf0f2f4, grey = 0xaeb4ba, tail = 0x2e5a7a, dk = 0x3a3f45;
    k.cylX('x', wht, 2.0, 30, 0, 3.4, 0, 12);
    k.add('x', xform(new THREE.SphereGeometry(2.0, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 15, 3.4, 0, 0, 0, -Math.PI / 2, 1, 2.0, 1), wht);
    k.add('x', xform(new THREE.SphereGeometry(2.0, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), -15, 3.6, 0, 0, 0, Math.PI / 2, 1, 3.2, 0.9), wht);
    for (const sd of [-1, 1]) {
      k.boxC('x', grey, 4.2, 0.35, 15, 0.5 - 3.3, 2.6, sd * 8.6, 0, -sd * 0.5, 0);
      k.boxC('x', grey, 2.4, 0.25, 5.4, -17.6, 4.2, sd * 3.1, 0, -sd * 0.55, 0);
      k.cylX('x', dk, 1.05, 4.2, 2.2, 1.7, sd * 5.4, 10);
      k.box('x', dk, 0.5, 1.5, 0.5, -1.5, 0, sd * 2.6);
    }
    k.boxC('x', tail, 4.6, 6.4, 0.4, -16.8, 7.6, 0, 0, 0, 0.55);
    k.box('x', dk, 0.4, 1.5, 0.4, 11, 0, 0);
    k.windows('x', 0x2b3036, 22, 1, 0.35, 0.45, 0.62, 0, -10.5, 3.9, 2.0, 0, 0.08);
    k.windows('x', 0x2b3036, 22, 1, 0.35, 0.45, 0.62, 0, -10.5, 3.9, 2.0, Math.PI, 0.08);
    _jetGeo = U.mergeGeometries(k.parts.get('x'));
    return _jetGeo;
  }
  function jetAt(k, key, x, y, z, ry, s = 1) { const g = jetGeo().clone(); xform(g, x, y, z, 0, ry, 0, s, s, s); return k.raw(key, g); }

  // Runway markings: one atlas of threshold/designation ends + one repeating centreline texture.
  const RWY_ENDS = ['28R', '10L', '28L', '10R', '19L', '1R', '19R', '1L', '30L', '12R', '30R', '12L'];
  let rwyTex = null;
  function runwayTextures() {
    if (rwyTex) return rwyTex;
    const CW = 85, H = 1024, pxm = H / 420;
    const ends = U.canvasTexture(1024, 1024, (g) => {
      g.fillStyle = '#3c3f42'; g.fillRect(0, 0, 1024, 1024);
      RWY_ENDS.forEach((d, i) => {
        const x0 = i * CW, widthM = i >= 8 ? 46 : 61, pw = CW / widthM, y = m => H - m * pxm, cx = x0 + CW / 2;
        g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(cx - 12 * pw, y(420), 24 * pw, 420 * pxm);          // rubber deposits
        g.fillStyle = '#eeeeea';
        g.fillRect(x0 + 1.2 * pw, 0, 0.9 * pw + 0.6, H); g.fillRect(x0 + CW - 2.1 * pw - 0.6, 0, 0.9 * pw + 0.6, H);   // edge lines
        const per = widthM > 50 ? 8 : 6;
        for (let s = 0; s < per; s++) for (const sd of [-1, 1]) {
          const off = 1.75 + s * 3.5; g.fillRect(cx + sd * (off + 0.875) * pw - 0.875 * pw, y(51.7), 1.75 * pw, 45.7 * pxm);
        }
        const txt = (t, m0, m1, wM) => { g.save(); g.font = 'bold 100px Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
          const tw = g.measureText(t).width, th = (m1 - m0) * pxm; g.translate(cx, (y(m0) + y(m1)) / 2); g.scale(wM * pw / tw, th / 72); g.fillText(t, 0, 4); g.restore(); };
        const num = d.replace(/[LRC]/, ''), let_ = d.replace(/[0-9]/g, '');
        if (let_) txt(let_, 58, 76, 5.5);
        txt(num, let_ ? 82 : 60, let_ ? 100 : 78, num.length * 6);
        for (let m = 120; m < 420; m += 60) g.fillRect(cx - 0.45 * pw - 0.5, y(m + 36), 0.9 * pw + 1, 36 * pxm);        // centreline dashes
        for (const sd of [-1, 1]) {
          for (let b = 0; b < 3; b++) g.fillRect(cx + sd * (11 + b * 2.6) * pw - (sd < 0 ? 1.8 * pw : 0), y(174.5), 1.8 * pw, 22.5 * pxm);   // TDZ bars
          g.fillRect(cx + sd * 11 * pw - (sd < 0 ? 9 * pw : 0), y(350), 9 * pw, 45.7 * pxm);                         // aiming point
        }
      });
    }, { aniso: 8 });
    const body = U.canvasTexture(128, 256, (g) => {
      g.fillStyle = '#3c3f42'; g.fillRect(0, 0, 128, 256);
      const R = U.rng(99); for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(${R() < 0.5 ? '0,0,0' : '255,255,255'},${0.03 + R() * 0.04})`; g.fillRect(R() * 128, R() * 256, 2 + R() * 10, 2 + R() * 18); }
      g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(40, 0, 48, 256);
      g.fillStyle = '#eeeeea'; g.fillRect(2.5, 0, 2, 256); g.fillRect(123.5, 0, 2, 256); g.fillRect(63, 256 - 0.6 * 256, 2, 0.6 * 256);
    }, { repeat: true, aniso: 8 });
    rwyTex = { ends, body }; return rwyTex;
  }
  // list: [[designation at end A, designation at end B, [latA,lonA], [latB,lonB], width m], ...]
  function runwayMeshes(ctx, list, ox, oz) {
    const T = runwayTextures(), E = { pos: [], uv: [], idx: [] }, B = { pos: [], uv: [], idx: [] }, LP = [], LC = [];
    const light = (p, r, g, b) => { LP.push(p[0], p[1] + 0.5, p[2]); LC.push(r, g, b); };
    const quad = (M, pts, uvs) => { const o = M.pos.length / 3; for (const p of pts) M.pos.push(p[0], p[1], p[2]); for (const t of uvs) M.uv.push(t[0], t[1]); M.idx.push(o, o + 1, o + 2, o, o + 2, o + 3); };
    for (const [dA, dB, A, Bp, w] of list) {
      const a = ctx.ll2w(A[0], A[1]), b = ctx.ll2w(Bp[0], Bp[1]);
      const ax = a.x - ox, az = a.z - oz, bx = b.x - ox, bz = b.z - oz, L = Math.hypot(bx - ax, bz - az), fx = (bx - ax) / L, fz = (bz - az) / L, rx = -fz, rz = fx;
      const P = (s, t) => { const x = ax + fx * s + rx * t, z = az + fz * s + rz * t; return [x, ctx.groundY(x + ox, z + oz) + 0.4, z]; };
      const cu = c => [(c * 85 + 0.5) / 1024, (c * 85 + 84.5) / 1024], EL = 420;
      { const [u0, u1] = cu(RWY_ENDS.indexOf(dA)); for (let i = 0; i < 2; i++) { const s0 = i * EL / 2, s1 = s0 + EL / 2; quad(E, [P(s0, -w / 2), P(s0, w / 2), P(s1, w / 2), P(s1, -w / 2)], [[u0, s0 / EL], [u1, s0 / EL], [u1, s1 / EL], [u0, s1 / EL]]); } }
      { const [u0, u1] = cu(RWY_ENDS.indexOf(dB)); for (let i = 0; i < 2; i++) { const s0 = i * EL / 2, s1 = s0 + EL / 2; quad(E, [P(L - s0, w / 2), P(L - s0, -w / 2), P(L - s1, -w / 2), P(L - s1, w / 2)], [[u0, s0 / EL], [u1, s0 / EL], [u1, s1 / EL], [u0, s1 / EL]]); } }
      for (let s0 = 0; s0 <= L; s0 += 60) for (const sd of [-1, 1]) light(P(s0, sd * (w / 2 + 1.5)), 1, 0.93, 0.8);   // edge lights
      for (let t = -w / 2; t <= w / 2; t += 4) { light(P(-2, t), 0.35, 1, 0.45); light(P(L + 2, t), 0.35, 1, 0.45); }  // threshold lights
      for (let s0 = 60; s0 < L - 60; s0 += 30) light(P(s0, 0), 0.9, 0.95, 1);                                          // centreline
      const n = Math.max(1, Math.round((L - 2 * EL) / 200));
      for (let i = 0; i < n; i++) { const s0 = EL + (L - 2 * EL) * i / n, s1 = EL + (L - 2 * EL) * (i + 1) / n, v0 = (s0 - EL) / 60, v1 = (s1 - EL) / 60;
        quad(B, [P(s0, -w / 2), P(s0, w / 2), P(s1, w / 2), P(s1, -w / 2)], [[0, v0], [1, v0], [1, v1], [0, v1]]); }
    }
    const mk = (M, map, name) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(M.pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(M.uv, 2));
      g.setIndex(M.idx); g.computeVertexNormals(); g.computeBoundingSphere(); const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map, roughness: 0.92 })); m.name = name; m.receiveShadow = true; return m; };
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(LP, 3)); lg.setAttribute('color', new THREE.Float32BufferAttribute(LC, 3)); lg.computeBoundingSphere();
    const pts = new THREE.Points(lg, pointsMaterial('lights')); pts.name = 'runway-lights'; pts.renderOrder = -1;
    return [mk(E, T.ends, 'runway-ends'), mk(B, T.body, 'runways'), pts];
  }
  // Hillside letters draped on the terrain. lines: [{ text, len, v (m upslope = toward -Z), u (m east) }]
  function drapedLetters(ctx, cx, cz, lines, depth, lift) {
    const rows = lines.length, W = 1024, RH = 128;
    const tex = U.canvasTexture(W, RH * rows, (g) => {
      g.clearRect(0, 0, W, RH * rows); g.fillStyle = '#f5f3ec'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = '900 104px "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif';
      lines.forEach((ln, i) => { const w = g.measureText(ln.text).width; g.save(); g.translate(W / 2, RH * (i + 0.5) + 4); g.scale((W * 0.985) / w, 1.12); g.fillText(ln.text, 0, 0); g.restore(); });
    }, { aniso: 8 });
    const pos = [], uv = [], idx = [];
    lines.forEach((ln, r) => {
      const nu = Math.max(4, Math.ceil(ln.len / 6)), nv = 3, v0 = 1 - (r + 1) / rows, v1 = 1 - r / rows, base = pos.length / 3;
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        const lx = (ln.u || 0) + (i / nu - 0.5) * ln.len, lz = -(ln.v + (j / nv - 0.5) * depth);
        pos.push(lx, ctx.groundY(cx + lx, cz + lz) + lift, lz); uv.push(i / nu, v0 + (v1 - v0) * j / nv);
      }
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = base + j * (nu + 1) + i, b = a + 1, d = a + nu + 1, e = d + 1; idx.push(a, b, e, a, e, d); }
    });
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals(); geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, roughness: 0.8 })); m.name = 'signhill:letters'; m.receiveShadow = true; return m;
  }
  // Rectangular stadium: rounded-rect bowl tiers around a field (+X = field long axis).
  function stadium(k, o) {
    const soup = new Soup();
    for (const t of o.tiers) {
      const inner = roundRect(t.hx, t.hz, t.r, 6), outer = roundRect(t.hx + t.dw, t.hz + t.dw, t.r + t.dw, 6);
      if (t.range) { const [i0, i1] = t.range; bowlSoup(inner.slice(i0, i1 + 1), outer.slice(i0, i1 + 1), t.yi, t.yo, false, soup); }
      else bowlSoup(inner, outer, t.yi, t.yo, true, soup);
    }
    k.add('solid', soup.geo(), o.seat || 0x6b6f73);
    k.prism('field', o.grass || 0x3f7a35, roundRect(o.fx + 6, o.fz + 6, 4, 3), 0.15, 0, 0, 0);
    if (o.lines) for (let i = -5; i <= 5; i++) k.box('field', 0xf4f4f0, 0.35, 0.18, o.fz * 2 - 2, i * o.fx / 5.5, 0.02, 0);
  }

  // ================================================================== PENINSULA
  // --- South San Francisco hillside sign (three lines of 15-20 m concrete letters, 1929).
  def('Sign Hill', 37.6633725, -122.4181018, 240, '"SOUTH SAN FRANCISCO THE INDUSTRIAL CITY": 15-20 m white concrete letters set on the south face of Sign Hill in 1929.', (ctx) => {
    const c = ctx.ll2w(37.6633725, -122.4181018); const g = new THREE.Group(); g.position.set(c.x, 0, c.z);
    g.add(drapedLetters(ctx, c.x, c.z, [{ text: 'SOUTH', len: 51, v: 30, u: -40 }, { text: 'SAN FRANCISCO', len: 148, v: 2, u: -10 }, { text: 'THE INDUSTRIAL CITY', len: 191, v: -26 }], 22, 2.4));
    return g;
  });

  // --- SFO: four runways with real markings, the 2016 control tower, terminals and parked jets.
  const SFO_RWY = [['28R', '10L', [37.61393, -122.35809], [37.62874, -122.3934], 61], ['28L', '10R', [37.61209, -122.35926], [37.62628, -122.39309], 61],
    ['19L', '1R', [37.62732, -122.36714], [37.60634, -122.38107], 61], ['19R', '1L', [37.6265, -122.37062], [37.60782, -122.383], 61]];
  const SFO_TERM = [{"h":20.0,"p":[[-392.9,-169.0],[-401.8,-175.2],[-368.2,-225.0],[-339.6,-251.1],[-292.3,-277.1],[-298.7,-293.2],[-293.5,-295.4],[-329.2,-409.6],[-334.4,-408.1],[-362.2,-422.6],[-369.0,-446.1],[-575.1,-554.4],[-578.7,-566.1],[-568.8,-585.1],[-557.1,-588.7],[-540.2,-579.9],[-532.3,-595.1],[-529.1,-593.5],[-537.0,-578.3],[-350.6,-480.2],[-324.6,-486.6],[-298.2,-536.9],[-291.2,-534.7],[-279.4,-557.3],[-261.1,-555.2],[-259.9,-551.7],[-289.4,-497.3],[-277.7,-491.1],[-290.4,-495.3],[-301.3,-474.5],[-269.8,-375.9],[-287.8,-342.0],[-275.6,-303.9],[-229.7,-310.6],[-181.7,-307.6],[-145.5,-298.1],[-103.6,-278.4],[-97.1,-290.4],[-101.8,-297.0],[-93.7,-312.3],[-97.6,-317.4],[-94.8,-322.9],[-89.4,-320.2],[-64.0,-367.8],[-53.7,-387.4],[-57.7,-392.8],[-55.3,-397.6],[-49.1,-394.5],[-42.6,-406.8],[-38.8,-402.1],[-36.0,-407.0],[-8.6,-392.7],[-10.9,-387.7],[-3.7,-387.0],[-16.8,-361.7],[-12.3,-359.2],[-14.9,-354.3],[-20.6,-354.4],[-35.1,-326.7],[-31.9,-325.0],[-39.5,-309.9],[-51.9,-311.7],[-62.5,-291.2],[-57.5,-288.5],[-59.8,-283.8],[-66.1,-284.0],[-107.5,-195.4],[-164.3,-225.6],[-186.8,-231.9],[-232.4,-235.2],[-263.1,-229.0],[-301.8,-210.1],[-323.4,-192.2],[-357.5,-150.0],[-363.4,-138.2],[-358.0,-135.4],[-362.0,-128.1],[-367.0,-130.7],[-379.8,-107.0],[-387.8,-113.8],[-390.9,-123.7],[-372.8,-158.3]]},{"h":25.0,"p":[[-583.4,-71.1],[-592.8,-102.5],[-568.3,-122.9],[-563.5,-135.9],[-631.4,-171.7],[-635.4,-164.0],[-649.7,-171.5],[-646.0,-179.4],[-701.7,-208.6],[-705.8,-201.0],[-719.9,-208.4],[-715.9,-216.1],[-757.9,-238.2],[-762.0,-230.6],[-769.7,-234.6],[-776.2,-238.1],[-772.1,-245.7],[-828.4,-275.3],[-832.4,-267.6],[-847.2,-275.4],[-846.2,-284.6],[-857.0,-290.3],[-850.5,-308.8],[-839.1,-324.5],[-828.2,-318.7],[-821.1,-324.9],[-812.0,-320.2],[-806.0,-317.0],[-810.2,-309.2],[-754.2,-279.8],[-749.9,-287.5],[-743.8,-284.3],[-735.8,-280.0],[-739.9,-272.2],[-711.9,-257.6],[-707.9,-265.4],[-695.4,-258.9],[-697.7,-250.1],[-641.6,-220.6],[-635.4,-227.3],[-623.3,-220.9],[-627.2,-212.9],[-585.4,-191.0],[-581.2,-198.7],[-572.7,-194.3],[-567.1,-191.3],[-571.3,-183.6],[-515.0,-154.0],[-509.6,-164.3],[-498.9,-158.8],[-504.5,-148.5],[-499.5,-142.5],[-492.0,-161.4],[-486.6,-158.6],[-488.5,-154.7],[-482.3,-142.3],[-440.3,-155.5],[-429.0,-118.9]]},{"h":25.0,"p":[[-351.3,130.0],[-337.8,173.1],[-393.4,190.3],[-402.5,208.6],[-394.6,212.8],[-401.8,226.5],[-409.7,222.3],[-439.4,278.4],[-431.9,283.4],[-438.9,296.5],[-446.8,292.4],[-476.7,348.6],[-468.7,352.8],[-475.1,365.0],[-483.9,362.4],[-513.4,417.9],[-505.7,422.7],[-513.1,436.7],[-521.6,432.9],[-543.3,474.5],[-535.3,478.7],[-542.9,492.9],[-573.5,480.4],[-593.2,466.4],[-585.7,452.1],[-577.5,456.4],[-555.5,414.4],[-563.5,410.2],[-559.7,402.9],[-556.0,396.1],[-548.0,400.3],[-518.7,345.1],[-526.5,340.3],[-519.1,326.2],[-511.0,330.4],[-507.3,323.6],[-496.2,302.3],[-504.2,298.1],[-496.9,284.2],[-488.8,288.4],[-483.7,279.1],[-475.9,264.3],[-483.9,260.1],[-461.5,217.4],[-464.1,212.3],[-488.7,210.7],[-499.5,175.9]]},{"h":20.0,"p":[[46.9,-64.7],[-4.3,33.9],[-32.2,19.8],[-8.3,-25.7],[-12.8,-28.0],[9.1,-68.4],[-19.0,-158.3],[-59.6,-179.3],[-43.3,-210.9],[10.9,-182.1],[10.8,-187.6],[28.3,-200.8],[45.6,-165.2],[89.4,-178.5],[114.2,-172.7],[123.2,-175.5],[121.4,-181.4],[124.1,-182.3],[128.6,-177.2],[160.7,-187.4],[177.5,-219.8],[173.6,-224.7],[175.1,-227.4],[180.2,-224.8],[191.2,-245.4],[185.6,-248.5],[195.2,-266.8],[228.7,-248.8],[233.8,-225.6],[240.4,-226.4],[240.9,-220.8],[234.4,-219.9],[235.8,-208.0],[248.9,-169.4],[253.9,-171.5],[256.3,-166.6],[250.7,-163.8],[264.6,-133.3],[247.1,-100.2],[235.7,-106.0],[238.6,-111.5],[220.0,-121.3],[217.2,-115.7],[212.0,-118.4],[215.0,-124.1],[194.0,-135.2],[190.9,-129.4],[185.9,-132.0],[188.9,-137.6],[172.2,-146.3],[140.9,-136.8],[142.2,-132.3],[129.5,-133.1],[109.8,-112.0],[66.5,-98.7],[73.6,-71.5],[72.8,-59.2],[49.4,-60.1]]},{"h":20.0,"p":[[74.9,-101.3],[75.3,-76.8],[72.3,-76.0],[75.3,-74.0],[75.6,-59.2],[49.6,-42.8],[43.6,-45.9],[25.0,-13.8],[21.5,-16.4],[-4.3,33.9],[9.1,40.5],[7.7,29.0],[39.6,-30.3],[44.2,-33.2],[49.7,-30.3],[54.9,-40.1],[80.9,-56.3],[79.8,-103.0]]},{"h":18.0,"p":[[-5.8,77.6],[13.3,87.7],[17.8,85.4],[57.0,106.0],[57.0,109.7],[59.9,107.5],[94.3,125.5],[95.4,129.9],[97.0,126.9],[122.3,144.8],[136.0,143.5],[147.1,121.4],[141.1,110.0],[130.3,104.8],[128.8,107.7],[100.1,92.8],[74.7,79.5],[76.3,76.4],[71.7,77.9],[32.9,57.4],[34.6,54.2],[-32.2,19.8],[-34.1,23.2],[-44.4,17.9],[-62.5,51.1]]}];
  const SJC_TERM = [{"h":14.0,"p":[[93.0,-447.2],[113.8,-423.5],[132.2,-439.5],[141.9,-428.4],[135.7,-423.0],[363.8,-162.1],[380.6,-176.6],[489.1,-52.5],[470.8,-36.6],[468.0,-39.8],[459.2,-32.1],[469.3,-20.5],[456.2,-9.2],[584.9,138.1],[590.6,133.1],[607.6,152.6],[601.4,157.9],[614.7,173.1],[620.9,167.6],[625.7,173.1],[622.4,176.0],[628.3,182.8],[625.2,185.5],[692.3,262.3],[685.8,267.9],[508.0,64.4],[508.3,58.8],[501.8,61.9],[498.9,58.5],[502.0,55.9],[469.4,18.6],[464.7,18.5],[467.0,16.5],[441.2,-13.0],[449.2,-19.9],[446.8,-22.1],[436.9,-13.5],[434.6,-16.1],[444.6,-24.7],[416.8,-56.5],[406.6,-47.7],[404.2,-50.4],[414.4,-59.2],[386.7,-91.0],[375.1,-83.6],[384.3,-93.7],[356.6,-125.3],[346.4,-116.5],[344.0,-119.2],[354.2,-128.1],[326.5,-159.8],[314.9,-152.5],[324.0,-162.5],[296.3,-194.1],[284.7,-186.9],[293.8,-196.8],[260.1,-235.4],[249.9,-226.5],[247.4,-229.3],[257.6,-238.1],[230.0,-269.7],[218.4,-262.5],[227.6,-272.5],[200.0,-304.1],[188.4,-296.9],[197.5,-306.9],[169.8,-338.5],[158.3,-331.4],[167.4,-341.3],[134.0,-379.6],[122.3,-372.7],[131.3,-382.6],[115.7,-400.5],[105.6,-391.8],[103.2,-394.6],[113.2,-403.3],[82.7,-438.3]]},{"h":14.0,"p":[[-5.3,-548.9],[3.4,-548.4],[8.2,-540.6],[20.5,-551.1],[30.3,-539.8],[33.9,-543.3],[58.0,-519.5],[81.6,-490.2],[67.1,-477.8],[93.0,-447.2],[72.4,-431.1],[70.5,-433.3],[80.0,-441.5],[46.0,-480.5],[36.2,-472.2],[34.2,-474.6],[43.9,-482.9],[27.8,-501.6],[22.0,-496.4],[4.2,-516.3],[9.9,-521.4],[-0.4,-533.1],[4.3,-537.1]]},{"h":14.0,"p":[[-276.8,-814.3],[-266.4,-823.3],[-269.3,-826.7],[-266.3,-829.4],[-263.3,-826.0],[-256.3,-832.0],[-232.0,-804.2],[-242.2,-795.3],[-186.8,-732.0],[-176.7,-740.8],[-148.1,-708.2],[-158.3,-699.4],[-152.7,-693.0],[-121.2,-690.8],[-112.4,-699.1],[-104.2,-689.8],[-93.9,-698.8],[-44.7,-646.3],[-29.6,-645.3],[-30.8,-630.5],[14.3,-574.8],[4.1,-565.9],[12.5,-556.4],[3.4,-548.4],[-14.5,-549.8],[-29.3,-566.7],[-55.6,-566.5],[-111.2,-630.1],[-107.3,-655.9],[-122.2,-672.9],[-121.6,-684.3],[-156.1,-686.3],[-163.6,-694.8],[-168.5,-690.5],[-256.9,-791.6],[-259.8,-789.0],[-262.6,-792.1],[-259.6,-794.7]]}];
  def('SFO', 37.615906, -122.383806, 2200, 'San Francisco International: four runways crossing on the Bay shore; the 67 m control tower (2016) glows at night.', (ctx) => {
    const c = ctx.ll2w(37.615906, -122.383806), gy = ctx.groundY(c.x, c.z); const g = new THREE.Group(); g.position.set(c.x, 0, c.z);
    for (const m of runwayMeshes(ctx, SFO_RWY, c.x, c.z)) g.add(m);
    const k = new Kit();
    // control tower: flared shaft on a 3-storey base, glass cab, antenna
    k.box('smooth', 0xd9dde0, 46, 14, 30, 0, gy, 0);
    k.lathe('smooth', 0xe6e8ea, [[0, 0], [8.5, 0], [7.6, 14], [5.6, 38], [5.2, 46], [7.8, 52], [10.2, 55], [0, 55]], 24, 0, gy + 14 - 14, 0);
    k.cyl('window', 0x3b4c58, 10.6, 10.0, 7, 0, gy + 55, 0, 24);
    k.cyl('smooth', 0xeceeee, 11.4, 10.8, 1.6, 0, gy + 62, 0, 24); k.cyl('smooth', 0xd0d4d6, 6, 9, 3, 0, gy + 63.6, 0, 24);
    k.cyl('metal', 0xc9c9c9, 0.25, 0.4, 8, 0, gy + 66.6, 0, 6); k.box('beacon', 0xff2a1a, 0.8, 0.8, 0.8, 0, gy + 74.6, 0);
    k.cyl('lights', 0x9fd4ff, 5.7, 5.3, 16, 0, gy + 34, 0, 20, 0, true);      // LED-lit shaft band (night)
    // terminals: OpenStreetMap footprints (T2, T3, International boarding areas A and G, boarding area C)
    for (const t of SFO_TERM) { k.prism('smooth', 0xd9dcde, t.p, t.h - 2, 0, gy, 0); k.prism('metal', 0xb3b9bf, scalePolyAbout(t.p, 0.995), 2, 0, gy + t.h - 2, 0); }
    // International Terminal main hall (spans the roadway between boarding areas A and G): gull-wing roof
    k.box('glass', 0x7f98a8, 86, 18, 250, -410, gy, 5); k.box('smooth', 0xd6d9dc, 92, 1.5, 256, -410, gy + 18, 5);
    const wing = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.7, side: THREE.DoubleSide });
    for (const sd of [-1, 1]) k.add(wing, xform(new THREE.CylinderGeometry(120, 120, 262, 10, 1, true, sd > 0 ? 0 : -0.39, 0.39), -410, gy + 19.5 + 120, 5, Math.PI / 2, 0, 0), 0xc8cdd1);
    // parked jets at the international piers (A and G) and T2 (neutral livery)
    for (const [x, z, r, sc] of [[-620, -250, 2.64, 1.5], [-700, -290, 2.64, 1.45], [-780, -330, 2.64, 1.5], [-540, -110, -0.5, 1.1], [-470, 250, -0.5, 1.45], [-520, 330, -0.5, 1.5], [-560, 420, -0.5, 1.4],
      [150, -260, 1.1, 1.05], [270, -190, 0.2, 1.05], [60, 150, 2.6, 1.0], [150, 170, 2.6, 1.05], [-230, -370, 2.2, 1.0]]) jetAt(k, 'smooth', x, gy, z, r, sc);
    k.toGroup(g, { name: 'sfo' });
    return g;
  });

  // --- San Jose Mineta International (SJC): parallel runways 12/30 beside the Guadalupe River, terminals A and B.
  const SJC_RWY = [['30L', '12R', [37.35099, -121.91707], [37.37374, -121.94201], 46], ['30R', '12L', [37.35225, -121.91526], [37.375, -121.94019], 46]];
  def('SJC', 37.3639, -121.9289, 1800, 'San Jose Mineta International: two parallel runways a few minutes from downtown, with Terminal B\'s long glass concourse.', (ctx) => {
    const c = ctx.ll2w(37.3639, -121.9289), gy = ctx.groundY(c.x, c.z); const g = new THREE.Group(); g.position.set(c.x, 0, c.z);
    for (const m of runwayMeshes(ctx, SJC_RWY, c.x, c.z)) g.add(m);
    const k = new Kit();
    for (const t of SJC_TERM) { k.prism('smooth', 0xdcdfe1, t.p, t.h - 1.5, 0, gy, 0); k.prism('metal', 0xaeb5bb, scalePolyAbout(t.p, 0.995), 1.5, 0, gy + t.h - 1.5, 0); }
    for (const [x, z, r] of [[150, -330, -0.85], [230, -240, -0.85], [330, -120, -0.85], [420, -10, -0.85], [-150, -700, 2.3], [-60, -620, 2.3]]) jetAt(k, 'smooth', x, gy, z, r, 1.0);
    k.toGroup(g, { name: 'sjc' });
    return g;
  });

  // --- Oracle headquarters, Redwood Shores: the "database cylinder" towers (OSM positions and heights).
  def('Oracle Towers', 37.5303, -122.2640, 260, 'Oracle\'s Redwood Shores headquarters: six glass cylinder towers around a lagoon, long said to resemble database icons.', (ctx) => {
    const c = ctx.ll2w(37.5303, -122.2640), gy = ctx.groundY(c.x, c.z); const g = new THREE.Group(); g.position.set(c.x, gy, c.z);
    const T = [[37.529559, -122.265878, 36], [37.53006, -122.265231, 48], [37.530602, -122.264382, 68], [37.530921, -122.263443, 60], [37.530678, -122.262453, 48], [37.529839, -122.261917, 41]];
    const geos = [], k = new Kit();
    T.forEach(([la, lo, h], i) => {
      const p = ctx.ll2w(la, lo), x = p.x - c.x, z = p.z - c.z, r = 21 + (i % 2) * 2;
      const secs = [], ys = []; for (let j = 0; j <= 4; j++) { ys.push(j * h / 4); secs.push(circle(r, 40, x, z)); }
      geos.push(loftGeo(secs, ys, (2 * Math.PI * r) / 10, 32, true));
      k.cyl('smooth', 0x2a4f55, r + 0.4, r + 0.4, 2.2, x, h - 2.2, z, 40);
      k.cyl('solid', 0xc9ccc9, r * 0.55, r * 0.6, 3.5, x, h, z, 20);
      k.cyl('smooth', 0xd7d9d6, r + 1.2, r + 1.2, 4, x, 0, z, 40);
    });
    g.add(meshFromGeo(U.mergeGeometries(geos), towerMat('teal', 41, 1, 1, { metalness: 0.6, roughness: 0.18 }), 'oracle:towers'));
    k.toGroup(g, { name: 'oracle' });
    return g;
  });

  // --- Pulgas Water Temple (1938): Corinthian ring temple at the end of the Hetch Hetchy aqueduct.
  const PULGAS_BEARING = 73;   // temple -> reflecting pool (OSM)
  def('Pulgas Water Temple', 37.483328, -122.317175, 90, 'A classical ring of Corinthian columns (1938) where Hetch Hetchy water from Yosemite arrives, with a long reflecting pool.', (ctx) => {
    const g = seatedGroup(ctx, 37.483328, -122.317175, { bearing: PULGAS_BEARING });
    const k = new Kit(), stone = 0xe8e0cc;
    k.cyl('solid', 0xd9d1bd, 11, 11.5, 1.4, 0, -0.2, 0, 32); k.cyl('solid', stone, 9.6, 9.6, 0.6, 0, 1.2, 0, 32);
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2, x = Math.cos(a) * 8, z = Math.sin(a) * 8;
      k.cyl('smooth', stone, 0.62, 0.62, 0.8, x, 1.8, z, 10); k.cyl('smooth', stone, 0.48, 0.55, 9.2, x, 2.6, z, 12); k.cyl('smooth', 0xe0d4b8, 0.78, 0.5, 1.1, x, 11.8, z, 10); }
    k.add('smooth', xform(new THREE.CylinderGeometry(9.2, 9.2, 2.6, 36, 1, true), 0, 14.2, 0), stone);
    k.add('smooth', xform(new THREE.CylinderGeometry(7.4, 7.4, 2.6, 36, 1, true), 0, 14.2, 0), 0xd8cfb8);
    k.add('smooth', ringSectorFlat(7.4, 9.6, 15.5, 0, Math.PI * 2, 36), 0xe3dac5);
    k.cyl('water', 0x3f6f7e, 5.5, 5.5, 0.3, 0, 1.3, 0, 24);
    // reflecting pool with stone curb, extending along local +X
    k.box('solid', 0xd4ccb8, 56, 0.6, 14, 38, 0, 0); k.box('water', 0x416f86, 52, 0.3, 10, 38, 0.4, 0);
    k.toGroup(g, { name: 'pulgas' });
    return g;
  });

  // --- Stanford: Hoover Tower, the Main Quad with Memorial Church, Stanford Stadium, the Dish.
  const QUAD_AXIS = 15.5;   // bearing of Palm Drive (Memorial Church -> the Oval), from OSM
  def('Hoover Tower', 37.427615, -122.166995, 90, 'The 87 m library tower (1941) of the Hoover Institution, with a carillon and an observation deck under its red-tile dome.', (ctx) => {
    const g = seatedGroup(ctx, 37.427615, -122.166995, { bearing: QUAD_AXIS + 90 });
    const k = new Kit(), tan = 0xdcc59c, tile = 0xb5654a;
    k.box('solid', tan, 34, 13, 30, 0, 0, 0); k.hip('smooth', tile, 35, 31, 4, 0, 13, 0);
    const fl = floodWarm();
    k.box(fl, tan, 15, 47, 15, 0, 13, 0);
    for (let f = 0; f < 4; f++) { const ry = f * Math.PI / 2; k.windows('window', 0x3a3530, 3, 1, 1.2, 30, 1.6, 0, -2.8, 17, 7.55, ry, 0.2); }
    k.box('solid', 0xe2cda6, 16.4, 1.2, 16.4, 0, 60, 0);
    k.box(fl, tan, 15.6, 11, 15.6, 0, 61.2, 0);
    for (let f = 0; f < 4; f++) { const ry = f * Math.PI / 2; k.windows('window', 0x2a2724, 3, 1, 2.6, 7, 1.6, 0, -4.2, 62.5, 7.85, ry, 0.3); }
    k.box('solid', 0xe2cda6, 16.6, 1.2, 16.6, 0, 72.2, 0); k.box('solid', tan, 12.5, 3, 12.5, 0, 73.4, 0);
    k.dome('smooth', tile, 6.8, 0, 76.4, 0, 16, 1.25); k.cyl('smooth', 0xe2cda6, 1.1, 1.3, 2.4, 0, 84.4, 0, 10); k.cone('metal', 0xd4b26a, 0.6, 1.6, 0, 86.8, 0 - 0, 8);
    k.toGroup(g, { name: 'hoover' });
    return g;
  });
  def('Main Quad & Memorial Church', 37.427524, -122.170249, 180, 'Stanford\'s sandstone Main Quad (1891) with Memorial Church and its golden mosaic facade at the head of Palm Drive.', (ctx) => {
    const g = seatedGroup(ctx, 37.427524, -122.170249, { bearing: QUAD_AXIS + 90 });   // OSM centre; local +Z = toward the church
    const k = new Kit(), sand = 0xd8c197, tile = 0xb5654a;
    // Inner Quad arcade ring (1 storey), outer quad (2-3 storeys), all under red tile
    const ring = (hx, hz, d, h, roofH, gapN, gapS) => {
      for (const sd of [-1, 1]) { k.box('solid', sand, d, h, 2 * hz + d, sd * (hx + d / 2), 0, 0); k.hip('smooth', tile, 2 * hz + d, d + 1, roofH, sd * (hx + d / 2), h, 0, Math.PI / 2); }
      for (const [sd, gap] of [[-1, gapN], [1, gapS]]) {
        const seg = (hx * 2 + d * 2 - gap) / 2;
        for (const s2 of [-1, 1]) { const x = s2 * (gap / 2 + seg / 2); k.box('solid', sand, seg, h, d, x, 0, sd * (hz + d / 2)); k.hip('smooth', tile, seg, d + 1, roofH, x, h, sd * (hz + d / 2)); }
      }
    };
    ring(88, 38, 13, 8, 3.2, 14, 36);
    ring(136, 86, 17, 14, 4.5, 30, 60);
    k.prism('field', 0xcdb88f, roundRect(88, 38, 2, 2), 0.1, 0, 0, 0);    // courtyard paving
    for (const [x, z] of [[-50, -15], [50, -15], [-50, 15], [50, 15], [0, -24]]) k.cyl('field', 0x7a8a4a, 6, 6, 0.3, x, 0, z, 16);
    // Memorial Church: nave toward +Z, facade on the Inner Quad's south side
    const cz = 38 + 13;
    k.box('solid', sand, 30, 16, 62, 0, 0, cz + 31); k.gable('smooth', tile, 62, 31, 9, 0, 16, cz + 31, Math.PI / 2, 0.5);
    k.box('solid', sand, 58, 15, 18, 0, 0, cz + 38); k.gable('smooth', tile, 58, 19, 8, 0, 15, cz + 38, 0, 0.5);
    k.box('solid', sand, 15, 10, 15, 0, 23, cz + 38); k.pyramid('smooth', tile, 16, 16, 7, 0, 33, cz + 38, Math.PI / 4);
    k.box('solid', sand, 34, 22, 3, 0, 0, cz - 0.5);
    k.gable('smooth', sand, 3, 34, 9, 0, 22, cz - 0.5, Math.PI / 2, 0);
    for (let i = -1; i <= 1; i++) k.box('window', 0x3a2f26, 4.2, 6.5, 0.4, i * 9, 0, cz - 2.1);
    k.toGroup(g, { name: 'mainquad' });
    // golden mosaic panel on the facade (textured quad, faces -Z toward the quad)
    const mos = U.canvasTexture(256, 160, (c2) => {
      const gr = c2.createLinearGradient(0, 0, 0, 160); gr.addColorStop(0, '#e2b64a'); gr.addColorStop(1, '#c8962d'); c2.fillStyle = gr; c2.fillRect(0, 0, 256, 160);
      const R = U.rng(7); for (let i = 0; i < 900; i++) { c2.fillStyle = `rgba(${R() < 0.5 ? '255,236,170' : '120,80,20'},0.25)`; c2.fillRect(R() * 256, R() * 160, 2, 2); }
      const figs = ['#7b2a2a', '#2c4a7a', '#e8e0d0', '#5a6a3a', '#7b2a2a', '#2c4a7a', '#e8e0d0'];
      figs.forEach((f, i) => { const x = 22 + i * 35; c2.fillStyle = f; c2.fillRect(x - 7, 70, 14, 60); c2.beginPath(); c2.arc(x, 60, 7, 0, Math.PI * 2); c2.fillStyle = '#e9cfa8'; c2.fill();
        c2.strokeStyle = '#fff0b0'; c2.lineWidth = 2; c2.beginPath(); c2.arc(x, 60, 11, 0, Math.PI * 2); c2.stroke(); });
      c2.fillStyle = '#7b2a2a'; c2.fillRect(118, 50, 20, 80); c2.beginPath(); c2.arc(128, 38, 10, 0, Math.PI * 2); c2.fillStyle = '#ecd2ab'; c2.fill();
    }, { aniso: 8 });
    const mg = new THREE.PlaneGeometry(30, 13); mg.rotateY(Math.PI); mg.translate(0, 14.5, cz - 2.05);
    const mm = new THREE.Mesh(mg, new THREE.MeshStandardMaterial({ map: mos, roughness: 0.35, metalness: 0.55 })); mm.name = 'memchu:mosaic'; g.add(mm);
    return g;
  });
  def('Stanford Stadium', 37.43453, -122.16109, 160, 'Home of Stanford football since 1921, rebuilt in 2006 as a 50,000-seat bowl.', (ctx) => {
    const g = seatedGroup(ctx, 37.43453, -122.16109, { bearing: QUAD_AXIS });
    const k = new Kit();
    stadium(k, { fx: 60, fz: 30, lines: true, seat: 0x8a2a2a, tiers: [{ hx: 66, hz: 36, r: 16, dw: 34, yi: 1.5, yo: 16 }] });
    k.add('solid', bowlSoup(roundRect(100, 70, 50, 6), roundRect(106, 76, 56, 6), 16, 14, true).geo(), 0x8d8a82);
    for (const sd of [-1, 1]) { k.box('solid', 0x3b3f44, 3, 12, 26, sd * 110, 14, 0); k.box('window', 0x20262c, 0.5, 9, 23, sd * 108.4, 15.5, 0); }
    k.box('solid', 0xd9d5cc, 90, 26, 12, 0, 0, -108); k.box('window', 0x3e5566, 86, 8, 0.4, 0, 16, -101.8);
    k.toGroup(g, { name: 'stanfordstadium' });
    return g;
  });
  def('The Dish', 37.40856, -122.17939, 90, 'Stanford\'s 46 m radio telescope (1966) on the foothills above the campus, ringed by a popular hiking loop.', (ctx) => {
    const g = seatedGroup(ctx, 37.40856, -122.17939, { bearing: 170 });
    const k = new Kit(), wht = 0xf2f2ee, f = 17.5, R = 23;
    k.box('solid', 0xd8d6d0, 12, 10, 12, 0, -1, 0); k.cyl('solid', 0xe4e2dc, 5.5, 6.5, 14, 0, 9, 0, 16);
    for (const sd of [-1, 1]) k.box('paint', wht, 2.2, 12, 2.2, 0, 21, sd * 9);
    k.box('paint', wht, 10, 3, 20, 0, 21, 0);
    const prof = [[0, -1.2]]; for (let i = 1; i <= 10; i++) { const r = R * i / 10; prof.push([r, r * r / (4 * f) - 1.2]); }
    prof.push([R, R * R / (4 * f) + 0.3]); for (let i = 10; i >= 0; i--) { const r = R * i / 10; prof.push([r * 0.999, r * r / (4 * f) + 0.3 + 0.001]); }
    const el = 50 * DEG;
    k.add('paint', xform(new THREE.LatheGeometry(prof.map(p => new THREE.Vector2(p[0], p[1])), 36), 0, 34, 0, 0, 0, -(Math.PI / 2 - el)), wht);
    // feed tripod
    const ax = [Math.sin(Math.PI / 2 - el), Math.cos(Math.PI / 2 - el)], focus = [ax[0] * f, 34 + ax[1] * f, 0];
    for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2; const rim = [Math.cos(a) * R * 0.8, Math.sin(a) * R * 0.8]; // rim point in dish plane (x', z)
      const px = rim[0] * Math.cos(Math.PI / 2 - el) * 1 + (R * R * 0.64 / (4 * f)) * ax[0], py = 34 - rim[0] * Math.sin(Math.PI / 2 - el) + (R * R * 0.64 / (4 * f)) * ax[1];
      k.rod('paint', 0xd9d9d4, [px, py, rim[1]], focus, 0.3, 5); }
    k.box('paint', 0xd0d0cc, 2, 2, 2, focus[0] - 1, focus[1] - 1, 0);
    k.box('lights', 0xff3a2a, 0.6, 0.6, 0.6, focus[0], focus[1] + 1.2, 0);
    k.toGroup(g, { name: 'dish' });
    return g;
  });
  def('El Palo Alto', 37.447285, -122.170124, 30, 'The ~1,000-year-old coast redwood beside the railroad bridge over San Francisquito Creek that gave Palo Alto its name.', (ctx) => {
    const g = seatedGroup(ctx, 37.447285, -122.170124, {});
    const k = new Kit(); redwood(k, 0, 0, 0, 33.5, 11); redwood(k, 3.2, 0, 1.6, 21, 12);
    k.toGroup(g, { name: 'elpaloalto' });
    return g;
  });

  // --- Meta (Menlo Park): the Gehry-designed MPK 20 with its 3.6 ha rooftop park, MPK 21, the entrance sign.
  const META_FOOT = { mpk20: { c: [37.481138, -122.153972], p: [[-172.9,-34.8],[-266.5,-11.8],[-235.7,80.1],[-167.5,60.0],[-148.4,61.2],[-148.2,65.1],[-80.8,63.9],[-80.8,69.2],[29.9,59.6],[29.4,52.0],[46.3,50.5],[46.0,46.1],[65.9,44.6],[65.8,40.2],[104.8,36.9],[105.5,44.9],[213.5,20.1],[211.1,3.4],[213.3,3.5],[212.8,-24.2],[206.9,-23.9],[206.4,-45.4],[203.3,-45.1],[202.6,-50.5],[181.0,-46.9],[175.0,-58.4],[161.9,-52.4],[163.1,-48.8],[97.9,-37.3],[95.2,-46.9],[63.0,-35.6],[57.6,-53.2],[-32.4,-26.0],[-32.7,-38.9],[-59.6,-41.3],[-137.2,-46.0],[-136.2,-30.1],[-155.6,-29.3],[-155.7,-40.8],[-173.1,-40.4]] }, mpk21: { c: [37.48087, -122.159196], p: [[-135.1,-75.0],[-94.2,-73.5],[-91.7,-87.1],[-69.7,-83.0],[-70.3,-79.3],[-61.8,-82.8],[-57.2,-70.9],[-52.9,-68.7],[-48.4,-78.5],[-27.6,-68.6],[-30.4,-62.7],[-21.1,-62.2],[-21.4,-55.8],[135.4,-50.6],[135.5,-56.6],[146.2,-56.2],[152.4,-53.9],[160.5,-36.9],[160.4,-29.9],[200.2,-28.5],[226.7,50.3],[168.1,53.2],[148.3,58.3],[133.8,58.3],[125.0,40.2],[79.7,47.4],[79.8,52.6],[-34.6,47.6],[-35.5,58.5],[-61.1,51.6],[-54.5,36.1],[-97.6,35.2],[-97.8,40.4],[-118.1,39.9],[-123.2,54.8],[-145.0,46.6],[-139.6,33.5],[-182.0,32.0],[-179.7,-25.8],[-197.8,-26.3],[-197.3,-44.5],[-199.9,-44.6],[-199.0,-93.1],[-138.4,-91.2],[-138.7,-83.3],[-134.8,-83.1]] } };
  def('Meta Headquarters', 37.4828, -122.1515, 420, 'Meta\'s Menlo Park campus by the Bay: MPK 20 hides a 9-acre rooftop park with trees and walking paths.', (ctx) => {
    const c = ctx.ll2w(37.4828, -122.1515), gy = ctx.groundY(c.x, c.z); const g = new THREE.Group(); g.position.set(c.x, gy, c.z);
    const k = new Kit(), R = U.rng(5);
    const roofBuilding = (plan, h) => {
      k.prism('glass', 0x6f8796, plan, h - 1.5, 0, 0, 0); k.prism('smooth', 0xd9dbd6, plan, 1.5, 0, h - 1.5, 0);
      k.prism('field', 0x5f7d3a, scalePolyAbout(plan, 0.96), 0.8, 0, h, 0);
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const [x, z] of plan) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      for (let i = 0; i < 140; i++) { const x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0); if (!pointInPoly(x, z, scalePolyAbout(plan, 0.9))) continue;
        const s = 3 + R() * 4; k.cone('solid', R() < 0.5 ? 0x4d5b2e : 0x3f5a30, s * 0.6, s * 1.6, x, h + 0.8, z, 7, R() * 6); }
    };
    const P = ll => { const p = ctx.ll2w(ll[0], ll[1]); return [p.x - c.x, p.z - c.z]; };
    for (const b of [META_FOOT.mpk20, META_FOOT.mpk21]) { const o = P(b.c); roofBuilding(b.p.map(q => [q[0] + o[0], q[1] + o[1]]), 22); }
    // East campus (1 Hacker Way) low buildings around Hacker Square + the entrance sign
    for (const [la, lo, w, d, h] of [[37.484259, -122.149682, 70, 45, 13], [37.485087, -122.148815, 70, 45, 13], [37.485664, -122.148086, 60, 50, 13], [37.485008, -122.147362, 60, 45, 13], [37.483815, -122.148867, 70, 40, 9], [37.483483, -122.149746, 60, 40, 9], [37.484431, -122.148182, 50, 35, 9], [37.485811, -122.146716, 60, 40, 9]]) {
      const p = P([la, lo]); k.box('smooth', 0xcfc8bb, w, h, d, p[0], 0, p[1], -38 * DEG); k.windows('window', 0x3a4a56, 8, 2, 4.5, 2.4, 3.2, 1.8, -w / 2 + 4, 2.2, d / 2 + 0.05, -38 * DEG, 0.2, p[0], p[1]);
    }
    const sp = P([37.48245, -122.14968]);
    k.box('smooth', 0xf2f3f4, 9, 5, 1.2, sp[0], 0.8, sp[1], -38 * DEG); k.box('solid', 0x9a9a96, 10, 0.8, 2.5, sp[0], 0, sp[1], -38 * DEG);
    k.toGroup(g, { name: 'meta' });
    const lem = U.canvasTexture(256, 128, (c2) => { c2.fillStyle = '#f2f3f4'; c2.fillRect(0, 0, 256, 128); c2.lineWidth = 16; const gr = c2.createLinearGradient(40, 0, 216, 0); gr.addColorStop(0, '#0a7cff'); gr.addColorStop(1, '#0052d4'); c2.strokeStyle = gr;
      c2.beginPath(); for (let i = 0; i <= 80; i++) { const t = i / 80 * Math.PI * 2, s = 1 + Math.sin(t) ** 2; c2.lineTo(128 + 85 * Math.cos(t) / s, 64 + 70 * Math.sin(t) * Math.cos(t) / s); } c2.closePath(); c2.stroke(); });
    for (const face of [1, -1]) { const pg = new THREE.PlaneGeometry(8.4, 4.2); if (face < 0) pg.rotateY(Math.PI); pg.translate(0, 3.3, face * 0.62); pg.rotateY(-38 * DEG); pg.translate(sp[0], 0, sp[1]);
      const pm = new THREE.Mesh(pg, new THREE.MeshStandardMaterial({ map: lem, roughness: 0.4 })); pm.name = 'meta:sign'; g.add(pm); }
    return g;
  });

  // --- Google: the Charleston East "dragonscale" canopy, classic Googleplex buildings, Shoreline tent.
  let dragonTex = null;
  function dragonscaleMaterial() {
    if (!dragonTex) dragonTex = U.canvasTexture(256, 256, (g) => {
      g.fillStyle = '#6f7f8f'; g.fillRect(0, 0, 256, 256); const R = U.rng(31);
      for (let row = -1; row < 17; row++) for (let col = -1; col < 17; col++) {
        const x = col * 16 + (row % 2 ? 8 : 0), y = row * 16, t = R();
        g.fillStyle = t < 0.33 ? '#9aa9b8' : t < 0.66 ? '#7e8ea2' : '#b7c1c9';
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + 8, y + 12); g.lineTo(x + 16, y); g.lineTo(x + 8, y - 4); g.closePath(); g.fill();
        g.strokeStyle = 'rgba(40,50,60,0.45)'; g.lineWidth = 1; g.stroke();
      }
    }, { repeat: true, aniso: 8 });
    return new THREE.MeshStandardMaterial({ map: dragonTex, roughness: 0.28, metalness: 0.65 });
  }
  const CE_FOOT = { c: [37.422049, -122.079598], p: [[-65.5,118.1],[-93.8,55.0],[-104.3,12.6],[-109.2,-56.5],[-46.1,-84.8],[-24.8,-90.2],[-3.6,-95.5],[65.5,-100.2],[93.7,-37.1],[104.3,5.4],[109.2,74.4],[46.1,102.5],[3.5,113.3]] };
  def('Googleplex', 37.4220, -122.0820, 450, 'Google\'s Mountain View home: the Googleplex and Charleston East, whose tent-like roof is clad in 50,000 silver "dragonscale" solar tiles.', (ctx) => {
    const c = ctx.ll2w(37.4220, -122.0820), gy = ctx.groundY(c.x, c.z); const g = new THREE.Group(); g.position.set(c.x, gy, c.z);
    const P = ll => { const p = ctx.ll2w(ll[0], ll[1]); return [p.x - c.x, p.z - c.z]; };
    const k = new Kit();
    // Charleston East: glass walls under a peaked canopy clipped to the real footprint
    const ce = P(CE_FOOT.c), cp = CE_FOOT.p;
    const peaks = [[-55, -45], [40, -50], [-45, 50], [50, 45], [0, 0]];
    const hf = (x, z) => { let h = 11; for (const [px, pz] of peaks) { const d = Math.hypot(x - px, z - pz) / 42; h += 13 * Math.max(0, 1 - d) ** 1.7; } return h; };
    g.add(clippedCanopy(cp, hf, 6, dragonscaleMaterial(), 'charlestoneast:roof', ce[0], ce[1]));
    k.prism('glass', 0x86a0ad, scalePolyAbout(cp, 0.94), 9, ce[0], 0, ce[1]);
    for (const [px, pz] of peaks) k.cyl('window', 0xd8e4ea, 4, 6, hf(px, pz) - 1.5, ce[0] + px, 0, ce[1] + pz, 10);
    // classic Googleplex (1600 Amphitheatre Pkwy): low white-and-glass buildings around a courtyard
    const gp = P([37.42200, -122.08440]);
    for (const [x, z, w, d, h] of [[-70, -40, 90, 40, 12], [60, -45, 80, 40, 12], [-80, 45, 70, 45, 12], [55, 50, 90, 40, 12], [0, 95, 110, 36, 9]]) {
      k.box('smooth', 0xeceae4, w, h, d, gp[0] + x, 0, gp[1] + z, 0.12); k.windows('window', 0x4b6272, Math.floor(w / 6), 2, 4.2, 3, 1.8, 2, -w / 2 + 3, 1.5, d / 2 + 0.05, 0.12, 0.2, gp[0] + x, gp[1] + z);
      k.box('smooth', [0x4285f4, 0xea4335, 0xfbbc05, 0x34a853][(x + z + 400) % 4 | 0], 3, h + 1, 3, gp[0] + x - w / 2 + 2, 0, gp[1] + z + d / 2 - 2, 0.12);
    }
    k.prism('field', 0x6d8f42, roundRect(40, 28, 10, 3), 0.2, gp[0], 0, gp[1]);
    k.toGroup(g, { name: 'googleplex' });
    return g;
  });
  const SHORE_FOOT = { c: [37.426789, -122.080758], p: [[-73.1,32.6],[-54.7,23.9],[-36.0,11.5],[-15.0,-11.7],[-5.3,-27.8],[-1.7,-38.9],[3.9,-62.9],[5.0,-82.2],[16.0,-53.8],[28.9,-36.2],[49.7,-22.7],[64.3,-17.8],[40.8,-5.7],[22.8,14.0],[13.4,29.7],[8.4,63.4],[-1.7,52.4],[-21.3,38.1],[-43.4,32.7]] };
  def('Shoreline Amphitheatre', 37.426874, -122.080807, 150, 'The 22,500-seat concert amphitheatre whose white peaked tent roof is a Mountain View landmark (1986).', (ctx) => {
    const g = seatedGroup(ctx, 37.426874, -122.080807, { bearing: 210 });   // local +X = toward the lawn
    const k = new Kit();
    // seating fan + lawn (open toward +X), stage house at -X
    const fan = (r0, r1, y0, y1, a0, a1, col) => k.add('solid', annularSector(r0, r1, y0, y1, a0, a1, 18), col);
    fan(18, 70, 0.5, 9, -65 * DEG, 65 * DEG, 0x4a4d52); fan(70, 150, 9, 22, -60 * DEG, 60 * DEG, 0x8fa24c);
    k.box('solid', 0x4b4f55, 26, 22, 44, -22, 0, 0);
    // tent: a star-shaped membrane (OSM outline) rising to a central mast
    const o = ctx.ll2w(37.426874, -122.080807), sc = ctx.ll2w(SHORE_FOOT.c[0], SHORE_FOOT.c[1]);
    const tent = starTent(SHORE_FOOT.p, 26, 7, 5); tent.rotateY(-ryOf(210)); tent.translate(...(() => { const r = rot(sc.x - o.x, sc.z - o.z, -ryOf(210)); return [r[0], 0, r[1]]; })());
    const tm = new THREE.Mesh(tent, new THREE.MeshStandardMaterial({ color: 0xf5f3ee, roughness: 0.7, side: THREE.DoubleSide, emissive: 0xffe6c8, emissiveIntensity: 0 }));
    tm.material.userData.floodK = 0.2; trackMat(tm.material, 'flood'); tm.name = 'shoreline:tent'; tm.castShadow = true; g.add(tm);
    { const r = rot(sc.x - o.x, sc.z - o.z, -ryOf(210)); k.cyl('paint', 0xd8d8d4, 0.6, 0.9, 29, r[0], 0, r[1], 8); k.box('beacon', 0xff2a1a, 0.6, 0.6, 0.6, r[0], 29, r[1]); }
    k.toGroup(g, { name: 'shoreline' });
    return g;
  });

  const BAYVIEW = [{ c: [37.421687, -122.066831], p: [[-65.3,30.5],[-66.0,-4.4],[-55.6,-46.9],[-37.9,-74.8],[-4.7,-76.5],[37.1,-65.4],[65.7,-47.6],[66.0,-17.2],[54.3,27.9],[39.1,56.8],[5.7,56.1],[-35.7,45.9]] }, { c: [37.423453, -122.066383], p: [[-105.2,-36.8],[-104.1,-66.1],[-76.1,-79.2],[-27.6,-92.5],[23.9,-96.9],[54.4,-94.7],[67.0,-66.6],[78.0,-18.8],[83.5,45.7],[96.8,49.5],[86.8,77.0],[69.2,70.0],[34.6,80.5],[-7.3,88.4],[-45.4,92.8],[-76.1,92.8],[-87.6,61.1],[-100.3,9.8]] }];
  def('Google Bay View', 37.4226, -122.0666, 220, 'Google\'s 2022 Bay View campus: two buildings under undulating canopies of silver dragonscale solar tiles beside Moffett Field.', (ctx) => {
    const c = ctx.ll2w(37.4226, -122.0666), gy = ctx.groundY(c.x, c.z); const g = new THREE.Group(); g.position.set(c.x, gy, c.z);
    const k = new Kit();
    BAYVIEW.forEach((b, i) => { const p = ctx.ll2w(b.c[0], b.c[1]), ox = p.x - c.x, oz = p.z - c.z;
      const pk = i ? [[-50, -40], [30, -45], [-40, 40], [45, 30]] : [[-25, -20], [25, 25]];
      const hf = (x, z) => { let h = 9; for (const [px, pz] of pk) { const d = Math.hypot(x - px, z - pz) / 38; h += 12 * Math.max(0, 1 - d) ** 1.6; } return h; };
      g.add(clippedCanopy(b.p, hf, 6, dragonscaleMaterial(), 'bayview:roof' + i, ox, oz));
      k.prism('glass', 0x86a0ad, scalePolyAbout(b.p, 0.94), 8, ox, 0, oz); });
    k.toGroup(g, { name: 'bayview' });
    return g;
  });

  // --- Moffett Field: Hangar One (1933) and the wooden Hangars 2 and 3 (1943), NASA Ames wind tunnels.
  def('Hangar One', 37.412977, -122.053995, 380, 'The 1933 airship hangar at Moffett Field: 345 m long and 60 m tall, big enough to hold six football fields. Restored and re-skinned in 2025.', (ctx) => {
    const g = seatedGroup(ctx, 37.412977, -122.053995, { bearing: 158 });
    const k = new Kit();
    k.add('metal', hangarGeo(345, 94, 59, 47, 30, 20), 0xb9c0c4);
    for (let i = -6; i <= 6; i++) { const x = i * 21; const pts = archProfile(94.6, 59.4, 18).map(([z, y]) => [x, y, z]); k.tube('paint', 0x8f989e, pts, 0.35, 4, 1); }
    k.box('smooth', 0xd6d8d6, 30, 12, 8, 0, 0, 50);
    k.box('beacon', 0xff2a1a, 1.2, 1.2, 1.2, 0, 59.5, 0);
    k.toGroup(g, { name: 'hangarone' });
    return g;
  });
  def('Hangars 2 and 3', 37.4166, -122.0430, 380, 'Two of the largest free-standing timber structures in the world, built in 1943 for Navy blimps.', (ctx) => {
    const c = ctx.ll2w(37.4166, -122.0430), gy = ctx.groundY(c.x, c.z); const g = new THREE.Group(); g.position.set(c.x, gy, c.z);
    const k = new Kit();
    for (const [la, lo] of [[37.416519, -122.044023], [37.416698, -122.042014]]) {
      const p = ctx.ll2w(la, lo), x0 = p.x - c.x, z0 = p.z - c.z, ry = ryOf(158);
      const geo = hangarGeo(329, 90, 52, 0, 18, 18); geo.rotateY(ry); geo.translate(x0, 0, z0); k.add('solid', geo, 0x8f8a7c);
      for (const sd of [-1, 1]) { const e = rot(sd * 164.5, 0, ry);
        k.extrude('solid', 0x7c776a, archProfile(90, 52, 16), 1.2, x0 + e[0], 0, z0 + e[1], 0, ry + Math.PI / 2, 0);
        for (let j = -2; j <= 2; j++) { const q = rot(sd * 165.3, j * 14, ry); k.box('smooth', 0x6f6a5e, 1, 44 - Math.abs(j) * 8, 13, x0 + q[0], 0, z0 + q[1], ry); } }
    }
    k.toGroup(g, { name: 'hangars23' });
    return g;
  });
  const NFAC = { ref: [37.4160, -122.0635],
    t4080: [[9.4,-30.3],[9.8,-38.8],[114.1,-39.5],[115.0,-2.3],[110.0,73.7],[81.9,73.9],[80.0,-3.0],[45.7,-3.1],[47.5,41.0],[51.0,40.5],[52.0,47.2],[53.9,81.0],[49.9,81.6],[53.3,135.3],[54.8,172.3],[69.7,172.4],[69.5,157.2],[80.7,135.0],[84.9,114.1],[109.3,114.2],[110.6,127.4],[112.0,137.0],[113.4,139.6],[120.4,150.7],[124.4,157.9],[124.0,227.1],[0.3,227.6],[0.7,171.6],[6.4,80.6],[-0.5,80.4],[-0.1,71.7],[2.8,71.8],[4.0,43.9],[4.4,40.2],[7.4,40.3],[7.9,24.6]],
    t80120: [[9.4,-30.3],[7.9,24.6],[-33.8,-17.6],[-37.2,-14.6],[-46.1,-23.5],[-69.2,-46.8],[-78.6,-56.4],[-82.6,-62.6],[-95.2,-69.1],[-101.4,-71.9],[-114.4,-72.7],[-141.9,-68.0],[-146.4,-71.9],[-150.0,-68.3],[-154.2,-72.3],[-155.0,-75.1],[-154.5,-78.2],[-66.4,-165.9],[-62.9,-165.8],[-60.1,-164.0],[-55.4,-158.6],[-58.8,-155.5],[-57.1,-153.6],[-61.7,-124.8],[-60.5,-112.6],[-54.5,-100.6],[-44.2,-90.0],[-3.1,-48.5],[-6.6,-44.7]] };
  def('NASA Ames Wind Tunnels', 37.4160, -122.0635, 260, 'The National Full-Scale Aerodynamics Complex: the 80-by-120-foot tunnel is the largest wind tunnel in the world.', (ctx) => {
    const g = seatedGroup(ctx, NFAC.ref[0], NFAC.ref[1], {});
    const k = new Kit();
    k.prism('smooth', 0xd9dad6, NFAC.t80120, 55, 0, 0, 0); k.prism('smooth', 0xc9cbc7, NFAC.t4080, 36, 0, 0, 0);
    k.prism('solid', 0xb9bbb7, scalePolyAbout(NFAC.t4080, 0.6), 18, 0, 36, 0);
    // intake mouth (dark screen) facing north-west
    const a = [-154.5, -78.2], b = [-66.4, -165.9], mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, L = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    k.box('solid', 0x2b3035, L - 8, 46, 1.5, mx + 1.5 * Math.sin(ang), 4, mz - 1.5 * Math.cos(ang), -ang);
    for (let i = 0; i < 12; i++) { const t = (i + 0.5) / 12 - 0.5; k.box('paint', 0x8c9196, 0.6, 46, 2, mx + Math.cos(ang) * t * (L - 8) + 2.4 * Math.sin(ang), 4, mz + Math.sin(ang) * t * (L - 8) - 2.4 * Math.cos(ang), -ang); }
    k.toGroup(g, { name: 'nfac' });
    return g;
  });

  // ================================================================== SOUTH BAY
  def('Apple Park', 37.33484, -122.00902, 520, 'Apple\'s 2017 "spaceship": a 460 m ring of curved glass around an orchard, with the Steve Jobs Theater on a hill nearby.', (ctx) => {
    const c = ctx.ll2w(37.33484, -122.00902), gy = ctx.groundY(c.x, c.z); const g = new THREE.Group(); g.position.set(c.x, gy, c.z);
    const k = new Kit(), N = 120, Ro = 231, Ri = 173, H = 23;
    const ringSoup = new Soup();
    for (let i = 0; i < N; i++) {
      const a0 = i / N * Math.PI * 2, a1 = (i + 1) / N * Math.PI * 2, c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      ringSoup.quad([Ro * c0, 0, Ro * s0], [Ro * c1, 0, Ro * s1], [Ro * c1, H, Ro * s1], [Ro * c0, H, Ro * s0], [c0 + c1, 0, s0 + s1]);
      ringSoup.quad([Ri * c0, 0, Ri * s0], [Ri * c1, 0, Ri * s1], [Ri * c1, H, Ri * s1], [Ri * c0, H, Ri * s0], [-(c0 + c1), 0, -(s0 + s1)]);
    }
    k.add('window', ringSoup.geo(), 0x8fa7b5);
    for (const y of [0.2, 5.8, 11.4, 17.0]) { k.add('smooth', ringSectorFlat(Ro - 1, Ro + 3.2, y + 4.4, 0, Math.PI * 2, N), 0xf1f1ee); k.add('smooth', ringSectorFlat(Ri - 3.2, Ri + 1, y + 4.4, 0, Math.PI * 2, N), 0xf1f1ee); }
    k.add('smooth', ringSectorFlat(Ri - 4, Ro + 4.5, H, 0, Math.PI * 2, N), 0xe9e9e6);
    k.add('solid', ringSectorFlat(Ri + 6, Ro - 6, H + 0.6, 0, Math.PI * 2, N), 0x2f3a48);        // solar roof
    k.add('smooth', xform(new THREE.CylinderGeometry(Ri + 6, Ri + 6, 0.6, N, 1, true), 0, H + 0.3, 0), 0xe9e9e6);
    k.add('smooth', xform(new THREE.CylinderGeometry(Ro - 6, Ro - 6, 0.6, N, 1, true), 0, H + 0.3, 0), 0xe9e9e6);
    k.cyl('field', 0x6f8f45, Ri - 4, Ri - 4, 0.3, 0, 0, 0, 64); k.cyl('water', 0x3f6e82, 22, 22, 0.35, 30, 0, -40, 24);
    const R = U.rng(17); for (let i = 0; i < 110; i++) { const a = R() * Math.PI * 2, r = 25 + R() * (Ri - 35), x = Math.cos(a) * r, z = Math.sin(a) * r; if (Math.hypot(x - 30, z + 40) < 26) continue; k.sphere('solid', R() < 0.5 ? 0x4d5b2e : 0x5d6d35, 2.6 + R() * 2.4, x, 3.5, z, 6, 4); k.cyl('solid', 0x5a4632, 0.25, 0.3, 2.2, x, 0, z, 5); }
    // Steve Jobs Theater: glass drum under a thin disc roof, on its hill
    const t = ctx.ll2w(37.330885, -122.007463), tx = t.x - c.x, tz = t.z - c.z, ty = ctx.groundY(t.x, t.z) - gy;
    k.cyl('glass', 0x9fb6c2, 20.6, 20.6, 6.2, tx, ty, tz, 48); k.cyl('smooth', 0xe7e8e6, 23, 23, 0.8, tx, ty + 6.2, tz, 48); k.cyl('lights', 0xfff1d8, 20.2, 20.2, 0.3, tx, ty + 5.9, tz, 32, 0, true);
    const v = ctx.ll2w(37.332845, -122.005366); k.box('glass', 0x9fb6c2, 70, 8, 29, v.x - c.x, ctx.groundY(v.x, v.z) - gy, v.z - c.z); k.box('smooth', 0xe0ddd5, 72, 0.8, 31, v.x - c.x, ctx.groundY(v.x, v.z) - gy + 8, v.z - c.z);
    k.toGroup(g, { name: 'applepark' });
    return g;
  });
  def('Levi\'s Stadium', 37.40317, -121.96983, 240, 'Home of the 49ers since 2014: a 68,500-seat stadium with a 9-storey suite tower and a green roof on its west side.', (ctx) => {
    const g = seatedGroup(ctx, 37.40317, -121.96983, { bearing: 149 });   // +X along the field (SSE), +Z = west (suite tower)
    const k = new Kit();
    stadium(k, { fx: 60, fz: 27, lines: true, seat: 0xa8322d, tiers: [{ hx: 66, hz: 34, r: 12, dw: 30, yi: 1.2, yo: 17 }, { hx: 98, hz: 66, r: 30, dw: 26, yi: 24, yo: 44, range: [0, 13] }] });
    // west suite tower (glass, green roof), east upper structure, video boards at both ends
    k.box('glass', 0x5d7686, 170, 50, 26, 0, 0, 82); k.box('smooth', 0xdad8d2, 174, 3, 30, 0, 50, 82); k.box('field', 0x6d8f42, 160, 0.8, 24, 0, 53, 82);
    for (let i = 0; i < 9; i++) k.box('smooth', 0xe8e6e0, 172, 0.6, 28, 0, 5 + i * 5, 82);
    k.box('paint', 0xb9bdc2, 180, 8, 6, 0, 44, -96);
    for (const sd of [-1, 1]) { k.box('paint', 0x5c6167, 6, 36, 60, sd * 118, 0, 0); k.box('window', 0x1c2328, 0.6, 16, 56, sd * 115, 18, 0); }
    for (const sd of [-1, 1]) for (let i = -3; i <= 3; i++) k.box('lights', 0xfffbef, 6, 1.4, 1.2, i * 24, 46, sd * (sd > 0 ? 96 : 99));
    k.toGroup(g, { name: 'levis' });
    return g;
  });
  const FLIGHT_DECK = [[116.6,-276.6],[119.5,-282.3],[137.8,-271.7],[167.3,-254.6],[171.3,-253.5],[175.7,-253.2],[180.1,-254.1],[182.9,-256.2],[184.7,-258.7],[185.9,-262.3],[186.4,-267.0],[185.5,-273.1],[184.1,-279.6],[189.3,-280.9],[194.3,-283.1],[197.4,-285.6],[199.4,-288.6],[200.8,-293.0],[200.7,-298.0],[198.6,-302.7],[194.7,-305.9],[189.5,-307.6],[183.7,-308.2],[178.5,-306.8],[174.9,-303.5],[172.4,-299.3],[171.5,-294.9],[171.3,-287.8],[168.0,-288.2],[165.7,-289.1],[164.2,-291.8],[162.6,-296.1],[160.8,-300.0],[157.9,-302.4],[153.4,-303.4],[143.5,-304.0],[117.7,-304.0],[112.5,-311.5],[109.3,-309.3],[95.2,-362.5],[96.1,-364.6],[95.3,-366.6],[94.1,-367.2],[96.6,-371.3],[95.8,-375.8],[44.6,-373.0],[39.5,-365.9],[35.9,-366.5],[29.0,-367.7],[24.6,-368.5],[11.4,-365.2],[13.5,-349.8],[17.4,-342.8],[31.0,-348.1],[30.6,-330.9],[30.8,-325.1],[31.7,-318.8],[35.8,-311.9],[39.9,-307.1],[43.7,-301.0],[45.7,-295.0],[51.8,-289.3],[56.8,-283.2],[63.8,-277.9],[72.0,-275.7],[79.9,-276.5],[87.8,-280.9],[91.8,-281.3],[95.1,-278.9],[101.6,-275.1],[106.1,-282.4]];
  def('California\'s Great America', 37.3955, -121.9730, 380, 'Amusement park beside Levi\'s Stadium: the 68 m Drop Tower, the Gold Striker wooden coaster and the double-deck Carousel Columbia.', (ctx) => {
    const g = seatedGroup(ctx, 37.3955, -121.9730, {});
    const k = new Kit(), P = (la, lo) => { const p = ctx.ll2w(la, lo), o = ctx.ll2w(37.3955, -121.9730); return [p.x - o.x, p.z - o.z]; };
    // Drop Tower (68 m) with its ring of seats
    const dt = P(37.3935497, -121.9716798);
    k.box('paint', 0x8e969d, 5, 68, 5, dt[0], 0, dt[1]); k.box('paint', 0xd33a2c, 6, 4, 6, dt[0], 68, dt[1]); k.cyl('paint', 0x2f6fb5, 5.4, 5.4, 2.6, dt[0], 22, dt[1], 16);
    k.box('beacon', 0xff2a1a, 0.8, 0.8, 0.8, dt[0], 72.2, dt[1]);
    for (let i = 0; i < 8; i++) k.box('lights', 0xffe6a0, 0.4, 60, 0.4, dt[0] + (i % 2 ? 2.6 : -2.6), 6, dt[1] + (i < 4 ? 2.6 : -2.6));
    // Flight Deck (inverted steel coaster, OSM layout) with synthetic heights
    const fd = FLIGHT_DECK.map(p => [p[0], p[1]]), S = arcLen(fd.concat([fd[0]])), T = S[S.length - 1];
    const fh = s => { const u = s / T; return u < 0.12 ? 6 + 26 * (u / 0.12) : 6 + 26 * Math.exp(-(u - 0.12) * 2.2) * (0.75 + 0.25 * Math.cos((u - 0.12) * 38)); };
    const track = []; for (let s = 0; s < T; s += 6) { const q = sampleAt(fd.concat([fd[0]]), S, s); track.push([q[0], fh(s), q[1]]); }
    k.tube('paint', 0x2a63b8, track, 0.7, 5, 1);
    for (let i = 0; i < track.length; i += 3) { const q = track[i]; k.box('paint', 0xe0a526, 1.1, q[1] + 1.5, 1.1, q[0] + 2.2, 0, q[2]); k.box('paint', 0xe0a526, 3, 0.8, 1.1, q[0] + 0.8, q[1] + 1.2, q[2]); }
    // Gold Striker: out-and-back wooden coaster (layout synthesized inside its OSM footprint)
    const gs0 = P(37.3975638, -121.9749), gs1 = P(37.395755, -121.9749), gs = [];
    for (let i = 0; i <= 40; i++) { const u = i / 40, x = gs0[0] + Math.sin(u * Math.PI * 2) * 34, z = gs0[1] + (gs1[1] - gs0[1]) * (0.5 - 0.5 * Math.cos(u * Math.PI * 2)); const h = u < 0.12 ? 4 + 29 * u / 0.12 : 4 + 29 * Math.abs(Math.cos((u - 0.12) * 11)) * Math.exp(-(u - 0.12) * 1.6); gs.push([x, h, z]); }
    k.tube('paint', 0x6b4a2b, gs, 0.6, 4, 1);
    const ws = new THREE.Mesh(panelGeo([gs.map(p => [p[0], p[1] - 0.6, p[2]])], 0, 5), trussMaterial(0xd8c8a4, 'x'));
    { const pos = ws.geometry.attributes.position; for (let i = 0; i < pos.count; i += 4) { pos.setY(i + 2, 0); pos.setY(i + 3, 0); } pos.needsUpdate = true; ws.geometry.computeVertexNormals(); }
    ws.name = 'goldstriker:structure'; ws.castShadow = true; g.add(ws);
    // Carousel Columbia: double-deck carousel with a domed crown
    const cc = P(37.397336, -121.974419);
    k.cyl('smooth', 0xf2e6c8, 11, 11, 6, cc[0], 0, cc[1], 24); k.cyl('smooth', 0xe8d9b4, 10, 10.5, 6, cc[0], 6, cc[1], 24);
    k.cone('smooth', 0xc8463a, 11.5, 5, cc[0], 12, cc[1], 24); k.dome('smooth', 0xd9b14a, 3.2, cc[0], 17, cc[1], 12, 1.4); k.cyl('lights', 0xffe2a0, 11.1, 11.1, 0.5, cc[0], 5.8, cc[1], 24, 0, true); k.cyl('lights', 0xffe2a0, 10.6, 10.6, 0.5, cc[0], 11.6, cc[1], 24, 0, true);
    k.toGroup(g, { name: 'greatamerica' });
    return g;
  });
  const MSC_FOOT = [[11.2,-36.1],[30.9,7.4],[26.6,9.3],[26.0,8.0],[-13.1,25.5],[-14.3,22.8],[-19.2,25.0],[-20.2,22.6],[-30.7,27.3],[-35.5,16.6],[-25.3,12.0],[-26.4,9.5],[-12.8,3.4],[17.1,-10.0],[15.3,-13.9],[19.1,-15.5],[16.1,-22.2],[14.7,-21.6],[8.6,-34.9]];
  def('Mission Santa Clara', 37.349308, -121.94158, 90, 'The eighth California mission (1777); the present church (1928) with its painted facade and bell tower stands at the heart of Santa Clara University.', (ctx) => {
    const c = ctx.ll2w(37.349308, -121.94158), gy = ctx.groundY(c.x, c.z); const g = new THREE.Group(); g.position.set(c.x, gy, c.z);
    const k = new Kit(), cream = 0xefe3c8, tile = 0xb5654a;
    k.prism('solid', cream, MSC_FOOT, 8, 0, 0, 0);
    // church nave (axis bearing 66, facade facing WSW) with gable roof, facade and bell tower
    const ry = ryOf(66), cx0 = -8, cz0 = 14, L = 48;
    const at = (lx, lz) => { const r = rot(lx, lz, ry); return [cx0 + r[0], cz0 + r[1]]; };
    let q = at(0, 0); k.box('solid', cream, L, 13, 15, q[0], 0, q[1], ry); k.gable('smooth', tile, L, 15.5, 5, q[0], 13, q[1], ry, 0.6);
    q = at(-L / 2 - 0.6, 0); k.box(floodWarm(), 0xf3e8d0, 1.6, 17, 17, q[0], 0, q[1], ry); k.extrude(floodWarm(), 0xf3e8d0, [[-8.5, 0], [8.5, 0], [6, 3.2], [3, 3.2], [0, 6], [-3, 3.2], [-6, 3.2]], 1.6, q[0], 17, q[1], 0, ry + Math.PI / 2, 0);
    q = at(-L / 2 - 1.5, 0); k.box('window', 0x3a2b22, 0.4, 5, 3, q[0], 0, q[1], ry); k.cyl('window', 0xe8c9a0, 1.1, 1.1, 0.3, q[0], 11, q[1], 12);
    for (const sz of [-1, 1]) { q = at(-L / 2 - 1.45, sz * 4.6); k.box('smooth', 0x9ab0c0, 0.3, 3.2, 1.2, q[0], 5.5, q[1], ry); k.box('smooth', 0xc97a5a, 0.3, 3.2, 1.2, q[0], 10.5, q[1], ry); }
    q = at(-L / 2 + 4, 10.5); k.box('solid', cream, 7, 20, 7, q[0], 0, q[1], ry); k.box('window', 0x2d2622, 7.2, 3, 3, q[0], 15, q[1], ry); k.box('solid', 0xf3e8d0, 7.6, 1, 7.6, q[0], 20, q[1], ry);
    k.box('solid', cream, 5.5, 4, 5.5, q[0], 21, q[1], ry); k.dome('smooth', 0xd9d0bd, 2.9, q[0], 25, q[1], 12, 1.2); k.cone('metal', 0x8a7a55, 0.25, 2.2, q[0], 28.3, q[1], 6);
    k.toGroup(g, { name: 'missionsantaclara' });
    return g;
  });
  const SAP_FOOT = [[57.0,-65.0],[68.8,-40.7],[70.8,-36.1],[72.5,-31.3],[74.1,-25.2],[75.0,-20.2],[75.7,-12.6],[75.6,-6.2],[74.8,1.3],[73.7,6.3],[72.3,11.2],[74.1,48.4],[23.9,66.6],[19.3,68.7],[14.6,70.5],[9.8,71.9],[4.8,72.9],[-0.2,73.6],[-5.2,73.9],[-11.5,73.7],[-16.5,73.2],[-21.4,72.4],[-26.3,71.1],[-29.9,70.0],[-55.1,61.0],[-57.0,44.2],[-59.4,38.3],[-60.5,34.6],[-61.5,30.9],[-70.9,30.6],[-64.5,19.4],[-72.1,10.5],[-61.3,-0.7],[-60.0,-5.6],[-61.1,-42.5],[-75.6,-51.3],[-66.3,-51.1],[-60.8,-68.1],[-53.3,-65.7],[-47.8,-72.7],[-12.1,-61.1],[-7.5,-63.1],[-9.6,-74.9],[20.8,-68.3],[25.8,-68.1],[30.8,-67.4],[34.5,-66.7],[39.4,-65.5],[43.0,-64.4]];
  def('SAP Center', 37.332796, -121.901316, 110, 'The "Shark Tank": San Jose\'s 17,500-seat arena (1993), home of the Sharks, a block from Diridon station.', (ctx) => {
    const g = seatedGroup(ctx, 37.332796, -121.901316, {});
    const k = new Kit();
    k.prism('glass', 0x6d8796, SAP_FOOT, 9, 0, 0, 0); k.prism('metal', 0xc8ccd0, scalePolyAbout(SAP_FOOT, 0.97), 19.7, 0, 9, 0);
    k.prism('smooth', 0x9aa0a6, scalePolyAbout(SAP_FOOT, 0.8), 3, 0, 28.7, 0);
    for (const [x, z] of [[74, 48], [-55, 61], [-60, -68], [57, -65]]) { k.pyramid('glass', 0x8fb0c2, 18, 18, 14, x * 0.93, 22, z * 0.93, Math.atan2(z, x)); k.box('lights', 0x6fb8ff, 0.8, 0.8, 0.8, x * 0.93, 36.2, z * 0.93); }
    k.box('lights', 0x39c0e8, 30, 1.2, 0.6, 0, 26, 74.2);
    k.toGroup(g, { name: 'sapcenter' });
    return g;
  });
  def('Winchester Mystery House', 37.31829, -121.95120, 70, 'Sarah Winchester\'s sprawling Queen Anne mansion, built without pause from 1886 to 1922: 160 rooms, stairs to nowhere.', (ctx) => {
    const g = seatedGroup(ctx, 37.31829, -121.95120, { bearing: 0 });
    const k = new Kit(), wall = 0xe9dca8, trim = 0x7d3b2a, roof = 0x8a3b2e, R = U.rng(1886);
    const wings = [[0, 0, 26, 12, 16], [-24, 8, 20, 9, 14], [22, -6, 18, 9, 14], [-8, -24, 16, 7, 10], [16, 22, 22, 7, 16], [-30, -18, 14, 7, 12], [34, 16, 16, 6, 10], [-10, 30, 18, 7, 12], [8, -38, 20, 7, 12]];
    for (const [x, z, h, n, w] of wings) { const ry = (R() < 0.5 ? 0 : Math.PI / 2) + (R() - 0.5) * 0.1, L = w + n * 1.5;
      k.box('smooth', wall, L, h * 0.6, w, x, 0, z, ry); k.gable('smooth', roof, L, w, h * 0.35, x, h * 0.6, z, ry, 0.5);
      for (let i = 0; i < 2; i++) { const o = rot((R() - 0.5) * L * 0.6, w / 2, ry); k.gable('smooth', roof, w * 0.35, 5, 3.5, x + o[0], h * 0.6 - 1, z + o[1], ry + Math.PI / 2, 0.3); }
      k.windows('window', 0x2d2a26, Math.max(2, (L / 4) | 0), 2, 1.1, 2, 2.6, 2.6, -L / 2 + 2, 1.5, w / 2 + 0.05, ry, 0.2, x, z);
      k.box('smooth', trim, L + 0.4, 0.5, w + 0.4, x, h * 0.6 - 0.5, z, ry); }
    for (const [x, z, r, h] of [[8, 6, 3.4, 24], [-18, -6, 2.8, 20], [26, 10, 2.5, 18], [-2, -30, 2.2, 16]]) {
      k.cyl('smooth', wall, r, r, h, x, 0, z, 8); k.cone('smooth', roof, r * 1.25, r * 2.6, x, h, z, 8); k.cyl('metal', 0x6d6a60, 0.08, 0.1, 2, x, h + r * 2.6, z, 5); }
    k.box('smooth', 0xf1ead6, 4, 3, 4, 0, 16, 0); k.dome('smooth', roof, 2.4, 0, 19, 0, 8, 1.1);
    k.toGroup(g, { name: 'winchester' });
    return g;
  });
  def('Lick Observatory', 37.3413889, -121.6427778, 600, 'On the 1,283 m summit of Mount Hamilton since 1888: the Great Lick Refractor dome and, further along the ridge, the Shane 3-meter telescope.', (ctx) => {
    const c = ctx.ll2w(37.3410993, -121.6429762), gy = ctx.groundY(c.x, c.z); const g = new THREE.Group(); g.position.set(c.x, gy, c.z);
    const k = new Kit(), wall = 0xf0ece2, dome = 0xd9dde0;
    const L = 78, ry = ryOf(8 - 90);    // main building runs north from the great dome (local -Z = north)
    k.cyl('solid', wall, 12, 12.4, 11, 0, 0, 0, 28); k.dome('metal', dome, 12.2, 0, 11, 0, 28, 1); k.box('solid', 0x3a3f44, 2.4, 12, 0.6, 0, 11.5, -11.9);
    k.box('solid', wall, 12, 8.5, L, 0, 0, -L / 2 - 8, 0); k.hip('smooth', 0x9a4a3a, 12.6, L, 2.5, 0, 8.5, -L / 2 - 8, Math.PI / 2);
    k.cyl('solid', wall, 5, 5, 9, 0, 0, -L - 8, 16); k.dome('metal', dome, 5, 0, 9, -L - 8, 16, 1);
    k.box('solid', wall, 30, 7, 10, 0, 0, -30); k.windows('window', 0x2d3136, 6, 1, 1.4, 2.4, 3, 0, -9, 2.5, 5.05, 0, 0.2, 0, -30);
    // Shane dome on the next knoll
    const sh = ctx.ll2w(37.3430314, -121.6371158), sx = sh.x - c.x, sz = sh.z - c.z, sy = ctx.groundY(sh.x, sh.z) - gy;
    k.cyl('solid', wall, 16, 16.5, 14, sx, sy, sz, 32); k.dome('metal', dome, 16.2, sx, sy + 14, sz, 32, 1); k.box('solid', wall, 34, 8, 22, sx + 20, sy, sz + 8);
    k.box('beacon', 0xff2a1a, 0.8, 0.8, 0.8, 0, 23.4, 0);
    k.toGroup(g, { name: 'lick' });
    return g;
  });
  def('Mount Umunhum Radar Tower', 37.160499, -121.897565, 60, '"The Cube": the five-storey concrete radar tower (1962) of the former Almaden Air Force Station, on the 1,063 m summit.', (ctx) => {
    const g = seatedGroup(ctx, 37.160499, -121.897565, {});
    const k = new Kit(), foot = [[-6.4, -8.9], [-9.9, 9.7], [9.7, 13.4], [13.2, -5.3]];
    k.prism('solid', 0xc9c4b8, foot, 26, 0, -2, 0); k.prism('solid', 0xb8b2a4, scalePolyAbout(foot, 1.03), 1.2, 0, 24, 0);
    for (let i = 0; i < 5; i++) k.prism('solid', 0xbdb7aa, scalePolyAbout(foot, 1.005), 0.4, 0, 4 + i * 4.6, 0);
    k.box('beacon', 0xff2a1a, 0.6, 0.6, 0.6, 1.6, 25.2, 2.2);
    k.toGroup(g, { name: 'umunhum' });
    return g;
  });
  def('Gilroy Old City Hall', 37.007063, -121.568412, 40, 'Gilroy\'s ornate Mission Revival city hall (1905), its clock tower a landmark of Monterey Street.', (ctx) => {
    const g = seatedGroup(ctx, 37.007063, -121.568412, {});
    const k = new Kit(), stucco = 0xe8d6b4, tile = 0xb5654a, foot = [[-12.0, 2.1], [1.2, -2.5], [-0.8, -8.1], [12.6, -12.8], [18.7, 5.1], [-7.8, 14.3]];
    k.prism('solid', stucco, foot, 11, 0, 0, 0); k.prism('smooth', tile, scalePolyAbout(foot, 1.02), 1.2, 0, 11, 0);
    const ry = ryOf(71);
    k.box('solid', stucco, 7, 22, 7, 12, 0, -6, ry); k.box('smooth', 0xf1e4c8, 7.8, 1, 7.8, 12, 22, -6, ry);
    for (let i = 0; i < 4; i++) { const r = rot(3.62, 0, ry + i * Math.PI / 2); k.cylX('lights', 0xfff1d0, 1.3, 0.2, 12 + r[0], 18, -6 + r[1], 16, ry + i * Math.PI / 2); }
    k.cyl('smooth', 0xefe0c0, 2.6, 3.2, 3.5, 12, 23, -6, 8); k.dome('smooth', tile, 2.8, 12, 26.5, -6, 10, 1.3); k.cone('metal', 0x8c7a4a, 0.2, 2.5, 12, 30, -6, 6);
    k.windows('window', 0x3a3028, 5, 2, 1.4, 2.4, 2.2, 2.6, -8, 1.8, 7.5, ry, 0.25, 3, 1);
    k.toGroup(g, { name: 'gilroycityhall' });
    return g;
  });

  // ------------------------------------------------------------------ polygon helpers
  function scalePolyAbout(poly, s) { let cx = 0, cz = 0; for (const p of poly) { cx += p[0]; cz += p[1]; } cx /= poly.length; cz /= poly.length; return poly.map(p => [cx + (p[0] - cx) * s, cz + (p[1] - cz) * s]); }
  function pointInPoly(x, z, poly) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; }
  // Height-field roof over a footprint polygon (grid cells outside the footprint are dropped).
  function clippedCanopy(poly, hf, cell, mat, name, ox = 0, oz = 0) {
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    x0 -= 3; z0 -= 3; x1 += 3; z1 += 3;
    const nx = Math.ceil((x1 - x0) / cell), nz = Math.ceil((z1 - z0) / cell), pos = [], uv = [], idx = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) { const x = x0 + i * cell, z = z0 + j * cell; pos.push(x + ox, hf(x, z), z + oz); uv.push(x / 9, -z / 9); }
    const big = scalePolyAbout(poly, 1.03);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      if (!pointInPoly(x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell, big)) continue;
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, e = c + 1; idx.push(a, c, b, b, c, e);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat); m.name = name; m.castShadow = true; m.receiveShadow = true; return m;
  }
  // Star-shaped tent membrane over a footprint (local coords about its centroid): peak hC, rim hR.
  function starTent(poly, hC, hR, rings = 5) {
    const N = 64, rim = [], per = [0];
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; per.push(per[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
    const P = per[per.length - 1];
    for (let k = 0; k < N; k++) { const s = k / N * P; let i = 0; while (per[i + 1] < s) i++; const a = poly[i], b = poly[(i + 1) % poly.length], t = (s - per[i]) / (per[i + 1] - per[i] || 1); rim.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    let cx = 0, cz = 0; for (const p of poly) { cx += p[0]; cz += p[1]; } cx /= poly.length; cz /= poly.length;
    const pos = [cx, hC, cz], idx = [];
    for (let r = 1; r <= rings; r++) { const f = r / rings; for (const q of rim) { const x = cx + (q[0] - cx) * f, z = cz + (q[1] - cz) * f; pos.push(x, hR + (hC - hR) * Math.pow(1 - f, 1.5) + 1.5 * Math.sin(Math.PI * f), z); } }
    for (let k = 0; k < N; k++) idx.push(0, 1 + (k + 1) % N, 1 + k);
    for (let r = 1; r < rings; r++) for (let k = 0; k < N; k++) { const a = 1 + (r - 1) * N + k, b = 1 + (r - 1) * N + (k + 1) % N, c = a + N, d = b + N; idx.push(a, b, d, a, d, c); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
  }

  // ================================================================== DEPOTS (station buildings)
  // Origin at ground centre, long axis +X (parallel to the track), track side = -Z.
  const signCache = new Map();
  function signMat(text, style) {
    const key = style + '|' + text; if (signCache.has(key)) return signCache.get(key);
    const modern = style === 'modern', t = U.canvasTexture(512, 96, (g) => {
      g.fillStyle = modern ? '#2b2f33' : '#f1e6c8'; g.fillRect(0, 0, 512, 96);
      g.strokeStyle = modern ? '#c23b2b' : '#3a3228'; g.lineWidth = modern ? 0 : 8; if (!modern) g.strokeRect(6, 6, 500, 84);
      if (modern) { g.fillStyle = '#c23b2b'; g.fillRect(0, 84, 512, 12); }
      g.fillStyle = modern ? '#f4f4f0' : '#2e2820'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `${modern ? 600 : 700} 58px ${modern ? 'Helvetica, Arial, sans-serif' : 'Georgia, "Times New Roman", serif'}`;
      g.fillText(text.toUpperCase(), 256, modern ? 44 : 50, 480);
    }, { aniso: 8 });
    const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0 });
    m.userData.floodK = modern ? 0.35 : 0.12; trackMat(m, 'flood');
    signCache.set(key, m); return m;
  }
  function signPlane(group, text, style, w, h, x, y, z, ry = 0) {
    const g = new THREE.PlaneGeometry(w, h); g.rotateY(ry); g.translate(x, y, z);
    const m = new THREE.Mesh(g, signMat(text, style)); m.name = 'depot:sign'; group.add(m); return m;
  }
  const DEPOT_NAMES = { sf_4th_king: 'San Francisco', millbrae: 'Millbrae', burlingame: 'Burlingame', san_mateo: 'San Mateo', san_carlos: 'San Carlos', redwood_city: 'Redwood City',
    menlo_park: 'Menlo Park', palo_alto: 'Palo Alto', mountain_view: 'Mountain View', sunnyvale: 'Sunnyvale', santa_clara: 'Santa Clara', sj_diridon: 'San Jose', gilroy: 'Gilroy', shelter: '', small: '' };
  // Reusable bits
  function arcade(k, col, n, span, h, x0, z, depth = 1.2) {           // row of round arches along X on a wall at z
    const r = (span - 1.1) / 2;
    for (let i = 0; i <= n; i++) k.box('solid', col, 1.1, h, depth, x0 + i * span, 0, z);
    for (let i = 0; i < n; i++) k.extrude('solid', col, archSpandrel(span - 1.1, 0.9), depth, x0 + (i + 0.5) * span, h, z - depth / 2);
    k.box('solid', col, n * span + 1.1, 0.5, depth + 0.1, x0 + n * span / 2, h + r + 0.9, z);
  }
  function archSpandrel(w, top) { const r = w / 2, H = r + top, p = [[-r, 0], [-r, H], [r, H], [r, 0]]; for (let i = 1; i < 12; i++) { const a = i / 12 * Math.PI; p.push([Math.cos(a) * r, Math.sin(a) * r]); } return p; }
  function missionGable(k, col, w, h, x, y, z, ry = 0) {             // curved Mission Revival parapet
    const p = [[-w / 2, 0]]; for (let i = 0; i <= 12; i++) { const t = i / 12, xx = -w / 2 + w * t; p.push([xx, h * (0.55 + 0.45 * Math.sin(Math.PI * t)) + (Math.abs(t - 0.5) < 0.12 ? h * 0.18 : 0)]); } p.push([w / 2, 0]);
    k.extrude('solid', col, p, 0.8, x, y, z - 0.4, 0, ry, 0);
  }
  function platformLamp(k, x, z, h = 4.2) { k.cyl('paint', 0x3a3f44, 0.07, 0.09, h, x, 0, z, 6); k.box('paint', 0x2f3337, 0.5, 0.18, 0.5, x, h, z); k.box('lights', 0xffe0b0, 0.4, 0.08, 0.4, x, h - 0.06, z); }
  function bench(k, x, z, ry = 0) { k.box('smooth', 0x6a4a32, 1.8, 0.08, 0.45, x, 0.45, z, ry); k.box('paint', 0x33373b, 0.08, 0.45, 0.4, x - 0.8, 0, z, ry); k.box('paint', 0x33373b, 0.08, 0.45, 0.4, x + 0.8, 0, z, ry); }
  function ticketMachine(k, x, z) { k.box('paint', 0x5c6167, 0.8, 1.7, 0.5, x, 0, z); k.box('window', 0x2a3a48, 0.5, 0.35, 0.05, x, 1.2, z - 0.27); k.box('paint', 0xc23b2b, 0.8, 0.12, 0.52, x, 1.7, z); }

  const DEPOT_BUILDERS = {
    sf_4th_king(k, grp, name) {                  // 1975 terminal: long, low, flat-roofed, glass concourse
      k.box('solid', 0xd8cdb6, 96, 7.5, 22, 0, 0, 0); k.box('smooth', 0xe9e2d3, 99, 1.6, 25, 0, 7.5, 0);
      k.box('glass', 0x6f8a9a, 60, 5.2, 0.4, -8, 0.6, 11.05); k.box('glass', 0x6f8a9a, 80, 3.6, 0.4, 0, 1.5, -11.05);
      k.box('paint', 0x3b4046, 30, 0.5, 8, -8, 4.2, 15); for (const x of [-22, -8, 6]) k.box('paint', 0x3b4046, 0.3, 4.2, 0.3, x, 0, 18.6);
      k.box('smooth', 0xcfc4ad, 18, 10, 18, 40, 0, 0); k.box('smooth', 0xe9e2d3, 19, 1, 19, 40, 10, 0);
      for (let i = 0; i < 7; i++) platformLamp(k, -42 + i * 14, -14);
      signPlane(grp, name, 'modern', 26, 2.4, -8, 8.3, 12.55); signPlane(grp, name, 'modern', 22, 2, 0, 8.3, -12.55, Math.PI);
    },
    millbrae(k, grp, name) {                     // 1999 intermodal station: glass hall under a big vaulted steel roof
      k.box('glass', 0x7d98a8, 64, 9, 26, 0, 0, 0); k.box('solid', 0xcfcac0, 64, 1, 26, 0, 9, 0);
      k.vault('metal', 0xb9c0c6, 76, 17, 0, 10, 0, 0, 0.42, 16);
      for (const sd of [-1, 1]) for (let i = -3; i <= 3; i++) k.box('paint', 0x9aa2a8, 0.5, 10, 0.5, i * 11, 0, sd * 13.5);
      k.box('solid', 0xb8b3a8, 20, 14, 12, 42, 0, 8); k.box('glass', 0x6f8a9a, 12, 12, 0.3, 42, 1, 1.9);
      for (let i = 0; i < 6; i++) platformLamp(k, -30 + i * 12, -16);
      signPlane(grp, name, 'modern', 16, 1.8, 0, 7, -13.2, Math.PI); signPlane(grp, name, 'modern', 16, 1.8, 0, 7, 13.2);
    },
    burlingame(k, grp, name) {                   // 1894: first Mission Revival building in California
      const st = 0xefe3c8, tile = 0xb5654a;
      k.box('solid', st, 34, 5.2, 10, 0, 0, 0); k.hip('smooth', tile, 36, 12.5, 3.6, 0, 5.2, 0);
      arcade(k, st, 7, 4.8, 3.4, -16.8, -7.2, 1); k.box('smooth', tile, 35, 0.4, 3.4, 0, 5.4, -6.6); k.gable('smooth', tile, 35, 3.6, 0.9, 0, 5.4, -6.6);
      for (const sd of [-1, 1]) { missionGable(k, st, 10.4, 3.4, sd * 17.2, 5.2, 0, Math.PI / 2); k.box('solid', st, 8, 4.6, 8, sd * 22, 0, 1); k.hip('smooth', tile, 9, 9, 2.6, sd * 22, 4.6, 1); }
      k.windows('window', 0x3a3026, 6, 1, 1.5, 2.4, 3.6, 0, -12.5, 1.2, 5.05, 0, 0.2);
      k.box('smooth', st, 3, 9.5, 3, -8, 0, 5.2); k.pyramid('smooth', tile, 3.6, 3.6, 2.2, -8, 9.5, 5.2);
      for (let i = 0; i < 5; i++) platformLamp(k, -18 + i * 9, -10);
      signPlane(grp, name, 'classic', 9, 1.4, 0, 4.45, -7.75, Math.PI);
    },
    san_mateo(k, grp, name) {                    // modern Mission-style station with a clock tower
      const st = 0xeadfc6, tile = 0xb5654a;
      k.box('solid', st, 22, 5, 9, 0, 0, 0); k.hip('smooth', tile, 23.5, 10.5, 3, 0, 5, 0);
      k.box('solid', st, 4.2, 14, 4.2, 12, 0, 1); k.hip('smooth', tile, 5, 5, 2.4, 12, 14, 1);
      for (let i = 0; i < 4; i++) { const r = rot(2.15, 0, i * Math.PI / 2); k.cylX('lights', 0xfff3dd, 1.2, 0.2, 12 + r[0], 11.6, 1 + r[1], 16, i * Math.PI / 2); }
      arcade(k, st, 4, 4.6, 3.2, -9.2, -6.4, 0.9); k.box('smooth', tile, 19, 0.4, 2.8, 0, 5.1, -5.8);
      k.windows('window', 0x3a3026, 4, 1, 1.6, 2.2, 3.2, 0, -7.2, 1.2, 4.55, 0, 0.2);
      for (let i = 0; i < 4; i++) platformLamp(k, -14 + i * 9, -9);
      signPlane(grp, name, 'classic', 8, 1.2, 0, 4.1, -6.9, Math.PI);
    },
    san_carlos(k, grp, name) {                   // 1888 Romanesque sandstone depot with a round turret
      const stone = 0x9c8a70, roof = 0x5a4a44;
      k.box('solid', stone, 26, 5, 9, 0, 0, 0); k.hip('smooth', roof, 29, 12, 4.4, 0, 5, 0);
      k.cyl('solid', stone, 3, 3.1, 8, 9.5, 0, -3.5, 16); k.cone('smooth', roof, 3.5, 5.5, 9.5, 8, -3.5, 16);
      k.box('solid', stone, 7, 5, 4, -6, 0, -5); k.gable('smooth', roof, 7.6, 4.8, 2.4, -6, 5, -5, Math.PI / 2, 0.3);
      for (const x of [-9, -3, 3]) { k.box('window', 0x2d2620, 1.6, 2.6, 0.3, x, 1.2, 4.55); k.box('window', 0x2d2620, 1.6, 2.6, 0.3, x, 1.2, -4.55); }
      k.box('window', 0x2d2620, 1.4, 2.4, 0.3, 9.5, 2.2, -6.55); k.box('smooth', 0x8a7a62, 26.4, 0.35, 9.4, 0, 4.1, 0);
      for (let i = 0; i < 4; i++) platformLamp(k, -13 + i * 9, -10);
      signPlane(grp, name, 'classic', 7, 1.1, -6, 4.3, -7.1, Math.PI);
    },
    redwood_city(k, grp, name) {                 // 1995 station: pavilion roof, clock tower, canopy
      const st = 0xe7dccb, roof = 0x6d4c3c;
      k.box('solid', st, 18, 5.5, 10, 0, 0, 0); k.hip('smooth', roof, 20, 12, 3.5, 0, 5.5, 0);
      k.box('solid', st, 4.6, 16, 4.6, -12, 0, 0); k.pyramid('smooth', roof, 5.6, 5.6, 3.2, -12, 16, 0);
      for (let i = 0; i < 4; i++) { const r = rot(2.35, 0, i * Math.PI / 2); k.cylX('lights', 0xfff3dd, 1.3, 0.2, -12 + r[0], 13, r[1], 16, i * Math.PI / 2); }
      k.box('paint', 0x4b5258, 40, 0.4, 6, 8, 4.2, -8); for (let i = 0; i < 6; i++) k.box('paint', 0x4b5258, 0.3, 4.2, 0.3, -10 + i * 7.5, 0, -10.5);
      k.windows('window', 0x33404a, 4, 1, 2, 2.5, 2.4, 0, -6.8, 1.2, -5.05, Math.PI, 0.2);
      for (let i = 0; i < 5; i++) platformLamp(k, -16 + i * 9, -12);
      signPlane(grp, name, 'modern', 9, 1.2, 0, 4.6, -5.1, Math.PI);
    },
    menlo_park(k, grp, name) {                   // 1867 Victorian depot: butter-yellow board-and-batten, brown trim
      const wall = 0xe9c86a, trim = 0x6b4a32, roof = 0x5c4436;
      k.box('smooth', wall, 20, 4.4, 7, 0, 0, 0); k.gable('smooth', roof, 22, 10, 2.6, 0, 4.4, 0, 0, 0.5);
      for (let i = 0; i < 21; i++) { k.box('smooth', trim, 0.12, 4.2, 0.1, -10 + i, 0.1, -3.56); k.box('smooth', trim, 0.12, 4.2, 0.1, -10 + i, 0.1, 3.56); }
      for (const sd of [-1, 1]) { k.box('smooth', trim, 0.3, 0.3, 10.2, sd * 11, 4.3, 0); for (const z of [-4.5, 4.5]) k.beam('smooth', trim, [sd * 10.05, 3.2, z * 0.78], [sd * 10.05, 4.3, z], 0.18); }
      k.box('smooth', wall, 7, 3.6, 5, 13, 0, 0.8); k.gable('smooth', roof, 8, 6.4, 1.8, 13, 3.6, 0.8, 0, 0.3);
      for (const x of [-6.5, -2, 2.5, 7]) { k.box('window', 0x2d2a24, 1.1, 2, 0.2, x, 1.2, -3.62); k.box('smooth', 0xf1ecde, 1.4, 0.2, 0.25, x, 3.3, -3.64); }
      k.box('window', 0x2d2a24, 1.2, 2.3, 0.2, 0, 0, 3.6);
      for (let i = 0; i < 4; i++) platformLamp(k, -12 + i * 8, -8, 3.8);
      signPlane(grp, name, 'classic', 7, 1, 0, 3.75, -3.72, Math.PI);
    },
    palo_alto(k, grp, name) {                    // 1941 Streamline Moderne: long white stucco, rounded ends, ribbon windows
      const wh = 0xf1eee6, tile = 0xb5654a;
      k.box('solid', wh, 44, 4.6, 12, 0, 0, 0); for (const sd of [-1, 1]) k.cyl('solid', wh, 6, 6, 4.6, sd * 22, 0, 0, 20);
      k.box('smooth', wh, 46, 0.5, 13, 0, 4.6, 0); for (const sd of [-1, 1]) k.cyl('smooth', wh, 6.5, 6.5, 0.5, sd * 22, 4.6, 0, 20);
      k.box('solid', wh, 16, 8, 13, 0, 0, 0); k.hip('smooth', tile, 17, 14, 2.4, 0, 8, 0);
      for (const sd of [-1, 1]) { k.box('window', 0x2f3a44, 30, 1.2, 0.2, 0, 2.4, sd * 6.05); k.box('window', 0x2f3a44, 12, 4, 0.2, 0, 3.2, sd * 6.6); }
      for (const y of [1.8, 3.8]) k.box('smooth', 0xd9d4c8, 44.2, 0.14, 12.2, 0, y, 0);
      k.box('paint', 0x5d646a, 60, 0.3, 5, 0, 3.8, -9); for (let i = 0; i < 9; i++) k.box('paint', 0x5d646a, 0.25, 3.8, 0.25, -28 + i * 7, 0, -11.2);
      for (let i = 0; i < 6; i++) platformLamp(k, -25 + i * 10, -13);
      signPlane(grp, name, 'classic', 9, 1.2, 0, 6.8, -6.7, Math.PI);
    },
    mountain_view(k, grp, name) {                // modern: small hip-roofed building + long canopy
      const st = 0xe4dccd, roof = 0x7b5a48;
      k.box('solid', st, 14, 4.2, 8, 0, 0, 2); k.hip('smooth', roof, 15.5, 9.5, 2.4, 0, 4.2, 2);
      k.box('paint', 0x7a8288, 46, 0.35, 5.5, 0, 3.9, -6); for (let i = 0; i < 7; i++) k.box('paint', 0x7a8288, 0.25, 3.9, 0.25, -21 + i * 7, 0, -8.4);
      for (let i = 0; i < 5; i++) { bench(k, -18 + i * 9, -6.5); } ticketMachine(k, 12, -3.4); ticketMachine(k, 13.2, -3.4);
      for (let i = 0; i < 6; i++) platformLamp(k, -22 + i * 9, -10);
      signPlane(grp, name, 'modern', 8, 1.1, 0, 3.4, -2.05, Math.PI);
    },
    sunnyvale(k, grp, name) {                    // replica 1904 Southern Pacific depot: buff and brown, hip roof, dormer
      const wall = 0xd9c48f, trim = 0x6b4f35, roof = 0x6a4b3a;
      k.box('smooth', wall, 26, 4.6, 8, 0, 0, 0); k.hip('smooth', roof, 29, 12, 3.6, 0, 4.6, 0);
      k.box('smooth', trim, 26.1, 1.1, 8.1, 0, 0, 0); k.box('smooth', trim, 26.2, 0.2, 8.2, 0, 1.2, 0);
      k.box('smooth', wall, 4, 2.2, 3, 0, 6, -3.4); k.gable('smooth', roof, 3.2, 4.6, 1.4, 0, 8.2, -3.4, Math.PI / 2, 0.2);
      for (const x of [-9, -5, 5, 9]) { k.box('window', 0x2d2a24, 1.2, 2.2, 0.2, x, 1.4, -4.06); k.box('window', 0x2d2a24, 1.2, 2.2, 0.2, x, 1.4, 4.06); }
      k.box('window', 0x2d2a24, 2.6, 1.3, 0.2, 0, 6.4, -4.95);
      for (let i = 0; i < 4; i++) platformLamp(k, -13 + i * 9, -10);
      signPlane(grp, name, 'classic', 8, 1.1, 0, 3.8, -4.12, Math.PI);
    },
    santa_clara(k, grp, name) {                  // 1863 depot (oldest operating in California) + freight house, SP colours
      const wall = 0xdcc389, trim = 0x6b4f35, roof = 0x5a4034;
      k.box('smooth', wall, 22, 4.6, 8, -8, 0, 0); k.gable('smooth', roof, 24, 11, 2.6, -8, 4.6, 0, 0, 0.6);
      k.box('smooth', 0xcfb57e, 22, 4.2, 9, 15, 0, 0); k.gable('smooth', roof, 23, 11, 2.2, 15, 4.2, 0, 0, 0.5);
      k.box('smooth', trim, 44, 1.1, 9.2, 4, 0, 0);
      for (const x of [-15, -11, -5, -1]) { k.box('window', 0x2d2a24, 1.2, 2.2, 0.2, x, 1.4, -4.06); k.box('window', 0x2d2a24, 1.2, 2.2, 0.2, x, 1.4, 4.06); }
      for (const x of [9, 15, 21]) k.box('smooth', 0x5a4636, 2.6, 3, 0.2, x, 0.2, -4.56);
      k.box('smooth', 0x8a7458, 20, 1.1, 3, 15, 0, -6);
      for (let i = 0; i < 5; i++) platformLamp(k, -18 + i * 9, -10);
      signPlane(grp, name, 'classic', 8, 1.1, -8, 3.8, -4.12, Math.PI);
    },
    sj_diridon(k, grp, name) {                   // 1935 Italian Renaissance Revival: brick, tall central waiting room, tile roofs
      const brick = 0xa8553d, trim = 0xe6dcc6, tile = 0xb5654a;
      k.box('solid', brick, 30, 13, 18, 0, 0, 0); k.hip('smooth', tile, 32, 20, 4, 0, 13, 0);
      for (const sd of [-1, 1]) { k.box('solid', brick, 26, 8.5, 14, sd * 28, 0, 0); k.hip('smooth', tile, 27.5, 15.5, 3, sd * 28, 8.5, 0); }
      for (const z of [-9.05, 9.05]) { for (let i = -1; i <= 1; i++) { k.box('window', 0x2d3238, 4, 7.5, 0.2, i * 8, 2.2, z); k.cylX('window', 0x2d3238, 2, 0.2, i * 8, 9.7, z, 12, Math.PI / 2); }
        k.box('smooth', trim, 30.2, 0.6, 0.3, 0, 12.2, z * 1.01); k.box('smooth', trim, 30.2, 2.2, 0.3, 0, 0, z * 1.01); }
      for (const sd of [-1, 1]) for (const z of [-7.05, 7.05]) k.windows('window', 0x2d3238, 5, 2, 1.6, 2.2, 3, 1.4, sd * 28 - 10, 1.2, z, 0, 0.2);
      k.box('paint', 0x4b5258, 70, 0.4, 6, 0, 4.5, -12); for (let i = 0; i < 11; i++) k.box('paint', 0x4b5258, 0.3, 4.5, 0.3, -34 + i * 6.8, 0, -14.7);
      for (let i = 0; i < 8; i++) platformLamp(k, -35 + i * 10, -17);
      signPlane(grp, name, 'classic', 14, 2, 0, 15.4, -10.2, Math.PI); signPlane(grp, name, 'classic', 14, 2, 0, 15.4, 10.2);
    },
    gilroy(k, grp, name) {                       // 1918 Mission Revival depot, two-storey centre block
      const st = 0xeadcc0, tile = 0xb5654a;
      k.box('solid', st, 14, 8.5, 10, 0, 0, 0); k.hip('smooth', tile, 15.5, 11.5, 3, 0, 8.5, 0);
      for (const sd of [-1, 1]) { k.box('solid', st, 16, 4.6, 9, sd * 15, 0, 0); k.hip('smooth', tile, 17, 10.5, 2.4, sd * 15, 4.6, 0); missionGable(k, st, 5, 2.2, sd * 7.05, 4.6, -4.6, 0); }
      for (const z of [-5.05, 5.05]) { k.windows('window', 0x33302a, 3, 2, 1.4, 2, 2.4, 2, -3.8, 1.2, z, 0, 0.2); }
      for (const sd of [-1, 1]) k.windows('window', 0x33302a, 3, 1, 1.4, 2, 3.2, 0, sd * 15 - 4.8, 1.2, -4.55, 0, 0.2);
      k.box('paint', 0x5a4b3c, 44, 0.3, 4, 0, 3.8, -6.5);
      for (let i = 0; i < 5; i++) platformLamp(k, -20 + i * 10, -10);
      signPlane(grp, name, 'classic', 7, 1, 0, 7.4, -5.12, Math.PI);
    },
    mission(k, grp, name) {                      // generic Mission Revival depot: stucco, red tile, arcade, curved parapet
      const st = 0xefe3c8, tile = 0xb5654a;
      k.box('solid', st, 20, 4.8, 8, 0, 0, 0); k.hip('smooth', tile, 21.5, 9.5, 2.8, 0, 4.8, 0);
      arcade(k, st, 4, 4.6, 3.2, -9.2, -5.4, 0.9); k.box('smooth', tile, 19, 0.4, 2.6, 0, 4.9, -4.9);
      missionGable(k, st, 7, 2.6, 0, 4.8, -4.4, 0);
      k.windows('window', 0x3a3026, 4, 1, 1.5, 2.2, 3.4, 0, -7.4, 1.2, 4.05, 0, 0.2);
      for (let i = 0; i < 4; i++) platformLamp(k, -13 + i * 8.7, -8);
      signPlane(grp, name, 'classic', 7, 1.1, 0, 3.9, -5.95, Math.PI);
    },
    shelter(k, grp, name) {                      // modern platform shelter: glass back, curved steel roof, bench, ticket machine
      k.box('paint', 0x4b5258, 0.2, 2.8, 0.2, -5.6, 0, 1); k.box('paint', 0x4b5258, 0.2, 2.8, 0.2, 5.6, 0, 1);
      k.box('glass', 0x9fb4c0, 11.4, 2.3, 0.08, 0, 0.3, 1.1); k.boxC('metal', 0xb9c0c6, 12.4, 0.16, 3.8, 0, 2.95, 0.3, -0.07, 0, 0); k.boxC('paint', 0x4b5258, 12.4, 0.3, 0.2, 0, 2.85, 1.15);
      bench(k, -2, 0.4); bench(k, 2, 0.4); ticketMachine(k, 4.4, 0.5);
      k.box('lights', 0xfff0d8, 9, 0.06, 0.3, 0, 2.72, 0.2);
      if (name) signPlane(grp, name, 'modern', 3.6, 0.55, -3.5, 2.35, 1.2, Math.PI);
    },
    small(k, grp, name) {                        // small stucco station building with a hip roof and canopy
      const st = 0xe8dfcf, roof = 0x8a5a44;
      k.box('solid', st, 9, 3.6, 5.5, 0, 0, 1); k.hip('smooth', roof, 10.5, 7, 2, 0, 3.6, 1);
      k.box('paint', 0x5d646a, 14, 0.25, 3.5, 0, 3.2, -3.2); for (const x of [-6.5, 0, 6.5]) k.box('paint', 0x5d646a, 0.2, 3.2, 0.2, x, 0, -4.8);
      k.box('window', 0x33404a, 3, 1.4, 0.1, -2, 1.3, -1.8); k.box('smooth', 0x5a4636, 1.1, 2.3, 0.1, 2.5, 0, -1.8);
      bench(k, -3, -3.6); ticketMachine(k, 5, -2.3); platformLamp(k, -8, -6); platformLamp(k, 8, -6);
      if (name) signPlane(grp, name, 'modern', 4.2, 0.6, 0, 2.9, -1.86, Math.PI);
    },
  };
  DEPOT_BUILDERS.modern = DEPOT_BUILDERS.mountain_view;
  // Generic style names (as used by the station builder) resolve to the real station's building when the
  // station name is known, otherwise to a representative style.
  const DEPOT_BY_NAME = { 'san francisco': 'sf_4th_king', millbrae: 'millbrae', burlingame: 'burlingame', 'san mateo': 'san_mateo', 'san carlos': 'san_carlos',
    'redwood city': 'redwood_city', 'menlo park': 'menlo_park', 'palo alto': 'palo_alto', 'mountain view': 'mountain_view', sunnyvale: 'sunnyvale',
    'santa clara': 'santa_clara', 'san jose diridon': 'sj_diridon', 'san jose': 'sj_diridon', gilroy: 'gilroy' };
  const DEPOT_ALIAS = { terminal: 'sf_4th_king', stone: 'san_carlos', victorian: 'menlo_park', streamline: 'palo_alto', diridon: 'sj_diridon', historic: 'mission' };
  function resolveDepotStyle(style, name) {
    if (DEPOT_BUILDERS[style] && !['mission', 'modern'].includes(style)) return style;
    const byName = name ? DEPOT_BY_NAME[String(name).toLowerCase().trim()] : null;
    return byName || (DEPOT_BUILDERS[style] ? style : DEPOT_ALIAS[style]) || 'modern';
  }
  const Depots = {
    styles: Object.keys(DEPOT_BUILDERS),
    resolve: resolveDepotStyle,
    build(style, opts = {}) {
      style = resolveDepotStyle(style, opts.name);
      const fn = DEPOT_BUILDERS[style];
      const grp = new THREE.Group(); grp.name = 'depot:' + style;
      const k = new Kit(); const name = opts.name !== undefined ? opts.name : (DEPOT_NAMES[style] || '');
      fn(k, grp, name, opts);
      k.toGroup(grp, { name: 'depot-' + style });
      grp.userData.tris = k.tris; grp.userData.style = style;
      const bb = new THREE.Box3().setFromObject(grp); grp.userData.footprint = { x0: bb.min.x, x1: bb.max.x, z0: bb.min.z, z1: bb.max.z, height: bb.max.y };
      return grp;
    },
  };

  // ================================================================== build / night / update
  let clock = 0, lastCrown = -1, crownMode = 0;
  function drawCrown(t) {
    if (!crownTex) return;
    const g = crownTex.userData.ctx, W = 256, H = 128; const mode = Math.floor(t / 24) % 3;
    g.fillStyle = '#05070c'; g.fillRect(0, 0, W, H);
    if (mode === 0) {            // slow waves rising around the crown
      for (let x = 0; x < W; x += 4) { const h = H * (0.5 + 0.35 * Math.sin(x * 0.05 + t * 0.9) + 0.12 * Math.sin(x * 0.13 - t * 1.7));
        const gr = g.createLinearGradient(0, H, 0, H - h); gr.addColorStop(0, 'rgba(120,200,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0.05)'); g.fillStyle = gr; g.fillRect(x, H - h, 3, h); }
    } else if (mode === 1) {     // falling light rain
      const R = U.rng(7); for (let i = 0; i < 90; i++) { const x = R() * W | 0, sp = 20 + R() * 40, y = ((R() * H + t * sp) % (H + 20)) - 20; g.fillStyle = `rgba(210,235,255,${0.4 + R() * 0.6})`; g.fillRect(x, y, 2, 14); }
    } else {                     // colour wash with twinkles
      const hue = (t * 12) % 360; const gr = g.createLinearGradient(0, 0, W, 0);
      gr.addColorStop(0, `hsl(${hue},70%,45%)`); gr.addColorStop(0.5, `hsl(${(hue + 60) % 360},70%,55%)`); gr.addColorStop(1, `hsl(${hue},70%,45%)`); g.fillStyle = gr; g.fillRect(0, 0, W, H);
      const R = U.rng((t * 4) | 0); for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(R() * W, R() * H, 2, 2); }
    }
    crownTex.needsUpdate = true;
  }
  function setNight(n, dt = 0) {
    const M = materials(); clock += dt;
    M.window.emissiveIntensity = 1.35 * n;
    M.lights.color.setScalar(0.42 + 0.95 * n);
    const blink = (clock % 1.5) < 0.75;
    M.beacon.color.setScalar(n > 0.25 ? (blink ? 1.4 : 0.12) : 0.75);
    if (PTS) { PTS.lights.visible = n > 0.2; PTS.lights.color.setScalar(U.clamp((n - 0.2) * 1.8, 0, 1.3)); PTS.beacon.visible = n > 0.2 && blink; }
    for (const m of extraMaterials) {
      const kind = m.userData.nightKind;
      if (kind === 'windows') m.emissiveIntensity = 1.1 * n;
      else if (kind === 'crown') m.emissiveIntensity = 0.22 * n;
      else if (kind === 'crownScreen') m.color.setScalar(0.13 + 0.87 * U.smooth(0.15, 0.6, n));
      else if (kind === 'flood') m.emissiveIntensity = n * (m.userData.floodK || 0.3) * 3;
    }
    if (n > 0.12 && clock - lastCrown > 0.1) { lastCrown = clock; drawCrown(clock); }
  }
  // build(ctx[, { only: [names] }]) -> { group, list, update(dt, env) }
  function build(ctx, opts = {}) {
    const root = new THREE.Group(); root.name = 'landmarks';
    const list = [], entries = [], box = new THREE.Box3(), only = opts.only ? new Set(opts.only) : null;
    let tris = 0;
    for (const L of LM) {
      if (only && !only.has(L.name)) continue;
      let grp;
      try { grp = L.build(ctx); } catch (e) { console.warn('[landmarks] build failed:', L.name, e); continue; }
      grp.name = 'lm:' + L.name;
      const p = ctx.ll2w(L.lat, L.lon), y = ctx.groundY(p.x, p.z);
      box.setFromObject(grp);
      const top = box.max.y, size = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
      let t = 0; grp.traverse(o => { if (o.isMesh) { const gg = o.geometry; t += (gg.index ? gg.index.count : gg.attributes.position.count) / 3; } });
      tris += t; grp.userData.tris = t;
      const vis = U.clamp(800 + 130 * Math.max(0, top - y) + 5 * size, 2500, 50000);
      root.add(grp);
      list.push({ name: L.name, lat: L.lat, lon: L.lon, x: p.x, z: p.z, y, top, blurb: L.blurb, radius: L.radius, tris: t });
      entries.push({ grp, x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2, vis2: vis * vis });
    }
    root.userData.tris = tris;
    return {
      group: root, list,
      update(dt, env) {
        const n = env && typeof env.night === 'number' ? env.night : U.uNight.value;
        setNight(n, dt || 0);
        if (env && env.camPos) { const cx = env.camPos.x, cz = env.camPos.z; for (const e of entries) { const dx = e.x - cx, dz = e.z - cz; e.grp.visible = dx * dx + dz * dz < e.vis2; } }
      },
    };
  }
  // stream(ctx): the catalog (names, positions, radii) is available at once; each landmark is built
  // lazily, nearest first, after the fine terrain under it has loaded (Terrain.ensure), so it sits exactly
  // on the high-resolution ground.
  function stream(ctx) {
    const root = new THREE.Group(); root.name = 'landmarks';
    const list = LM.map(L => { const p = ctx.ll2w(L.lat, L.lon); return { name: L.name, lat: L.lat, lon: L.lon, x: p.x, z: p.z, y: 0, top: 0, blurb: L.blurb, radius: L.radius || 150, _L: L, _state: 0 }; });
    const entries = [], box = new THREE.Box3(); let busy = false;
    function make(it) {
      let grp; try { grp = it._L.build(ctx); } catch (e) { console.warn('[landmarks] build failed:', it.name, e); it._state = 3; return; }
      grp.name = 'lm:' + it.name; const y = ctx.groundY(it.x, it.z); box.setFromObject(grp);
      const top = box.max.y, size = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
      const vis = U.clamp(800 + 130 * Math.max(0, top - y) + 5 * size, 2500, 50000);
      root.add(grp); it.y = y; it.top = top; it._state = 2;
      entries.push({ grp, x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2, vis2: vis * vis });
    }
    return {
      group: root, list,
      update(dt, env) {
        const n = env && typeof env.night === 'number' ? env.night : U.uNight.value;
        setNight(n, dt || 0);
        if (!env || !env.camPos) return;
        const cx = env.camPos.x, cz = env.camPos.z;
        if (!busy) {
          let best = null, bd = 60000; for (const it of list) if (it._state === 0) { const d = Math.hypot(it.x - cx, it.z - cz); if (d < bd) { bd = d; best = it; } }
          if (best) {
            busy = true; best._state = 1; const r = Math.max(350, best.radius * 1.6);
            const go = () => { try { make(best); } finally { busy = false; } };
            if (typeof Terrain !== 'undefined' && Terrain.ensure) Terrain.ensure(best.x - r, best.z - r, best.x + r, best.z + r, 4, 7).then(go, go); else go();
          }
        }
        for (const e of entries) { const dx = e.x - cx, dz = e.z - cz; e.grp.visible = dx * dx + dz * dz < e.vis2; }
      },
    };
  }
  return { build, stream, Depots, setNight, deckAt, names: () => LM.map(l => l.name) };
})();
const Depots = Landmarks.Depots;
