// StationKit: the parametric kit Bayline Metro stations are built from (stations workstream).
//  - GB: a compact geometry buffer with a transform stack. Every vertex carries an albedo colour, a surface pattern
//    (kind, two surface coordinates in metres, a parameter) and "exterior" data (sky view factor, baked occlusion), so a
//    whole level of a station merges into a handful of meshes whose detail is drawn by the shader, not by textures.
//  - The station material: MeshStandardMaterial + procedural surfaces (glazed tile, terrazzo, precast and board-formed
//    concrete, granite, tactile domes, brick, metal panels, waffle coffers, stair nosings, brushed stainless...) with
//    derivative bump, and per-fragment ANALYTIC LINE LIGHTS: the exact irradiance integral of an isotropic segment
//    (clipped to the surface's hemisphere) for the diffuse, and a representative-point GGX for the specular, so the long
//    light troughs of a station fall off and reflect in polished floors as they do. Sky and sun are scaled by the
//    vertex sky factor (0 underground, partial under canopies and in stair wells).
//  - Light sets: per-cell lists of line lights in station-local metres, uploaded in view space right before drawing.
// All geometry is built in a station-local frame (the station root sits at (OX, 0, OZ) in the world, y absolute).
const StationKit = (() => {
  const PLAT_H = 0.991;              // platform top above top of rail (= car floor, level boarding; trains ws)
  const EDGE = 1.676;                // track centreline -> platform edge (car half-width 1.600 + 76 mm)
  const MAXL = 12;                   // line lights per material
  const TAU = Math.PI * 2;
  const _c = new THREE.Color();
  // linear [r, g, b] from an sRGB hex (three's colour management converts)
  const lin = (hex) => { _c.set(hex); return [_c.r, _c.g, _c.b]; };
  const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

  // surface pattern kinds (aSurf.x); the parameter (aSurf.w) is per kind
  const K = {
    PLAIN: 0,      // w: roughness override (0 = keep material roughness)
    TILE: 1,       // w: tile size m (negative: running bond, half size high)
    TERRAZZO: 2,   // w: panel size m (divider strips)
    CONCRETE: 3,   // w: panel/joint spacing m (0 = none)
    TACTILE: 4,    // w: unused (u along the edge, v in from the dome band start)
    GRANITE: 5,    // w: paver size m
    BRICK: 6,      // w: 1 glazed / 0 plain
    PANEL: 7,      // w: panel size m (metal ceiling / wall panels)
    COFFER: 8,     // w: coffer pitch m
    NOSING: 9,     // w: unused (v = distance from the tread's front edge)
    STEEL: 10,     // brushed stainless along u
    PAINT: 11,     // painted steel
    PAVING: 12,    // sidewalk / plaza concrete; w: joint spacing m
    COPING: 13,    // flamed granite edge coping
    RUBBER: 14,    // studded rubber (landings, elevator floors)
    PLASTER: 15,   // sprayed acoustic plaster
    WOOD: 16,      // w: plank width
    CORRUG: 17,    // corrugated/standing seam; w: rib pitch m
    FLUTED: 18,    // fluted concrete; w: flute pitch m
    BOARDFORM: 19, // board-formed concrete; w: board height m
    ASPHALT: 20,
    GLASSBLOCK: 21,
    MOSAIC: 22,    // small glass mosaic, w: tessera size m
    GRATING: 23,   // steel grating / drain
    BALLAST: 24,
  };

  // ------------------------------------------------------------------------------------------------ geometry buffer
  // position f32x3, normal i8x3 (normalised), color u8x3 (linear albedo), aSurf f32x4, aExt u8x4 (sky, ao, glow, spare)
  class GB {
    constructor() {
      this.cap = 1024; this.n = 0; this.alloc(this.cap);
      this.I = new Uint32Array(3072); this.ni = 0;
      this.M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];    // row-major 3x4 (x' = M0 x + M1 y + M2 z + M3 ...)
      this.stack = [];
      this.col = [0.5, 0.5, 0.5]; this.kind = 0; this.prm = 0; this.sky = 0; this.ao = 1; this.glow = 0;
      this.uo = 0; this.vo = 0;                            // surface-coordinate offsets
    }
    alloc(cap) {
      const o = this.P ? this : null;
      const P = new Float32Array(cap * 3), N = new Int8Array(cap * 3), C = new Uint8Array(cap * 3), S = new Float32Array(cap * 4), E = new Uint8Array(cap * 4);
      if (o) { P.set(o.P.subarray(0, o.n * 3)); N.set(o.N.subarray(0, o.n * 3)); C.set(o.C.subarray(0, o.n * 3)); S.set(o.S.subarray(0, o.n * 4)); E.set(o.E.subarray(0, o.n * 4)); }
      this.P = P; this.N = N; this.C = C; this.S = S; this.E = E; this.cap = cap;
    }
    // ---- state
    set(o) { if (o.col !== undefined) this.col = typeof o.col === 'number' ? lin(o.col) : o.col; if (o.kind !== undefined) this.kind = o.kind; if (o.prm !== undefined) this.prm = o.prm;
      if (o.sky !== undefined) this.sky = o.sky; if (o.ao !== undefined) this.ao = o.ao; if (o.glow !== undefined) this.glow = o.glow; return this; }
    mat(col, kind = 0, prm = 0) { this.col = typeof col === 'number' ? lin(col) : col; this.kind = kind; this.prm = prm; return this; }
    // ---- transform stack
    push() { this.stack.push(this.M.slice()); return this; }
    pop() { this.M = this.stack.pop(); return this; }
    translate(x, y, z) { const M = this.M; M[3] += M[0] * x + M[1] * y + M[2] * z; M[7] += M[4] * x + M[5] * y + M[6] * z; M[11] += M[8] * x + M[9] * y + M[10] * z; return this; }
    rotY(a) { // yaw: local +X turns toward -Z for positive a (three's rotation.y)
      const c = Math.cos(a), s = Math.sin(a), M = this.M;
      for (let r = 0; r < 3; r++) { const m0 = M[r * 4], m2 = M[r * 4 + 2]; M[r * 4] = m0 * c - m2 * s; M[r * 4 + 2] = m0 * s + m2 * c; }
      return this;
    }
    rotX(a) { const c = Math.cos(a), s = Math.sin(a), M = this.M; for (let r = 0; r < 3; r++) { const m1 = M[r * 4 + 1], m2 = M[r * 4 + 2]; M[r * 4 + 1] = m1 * c + m2 * s; M[r * 4 + 2] = -m1 * s + m2 * c; } return this; }
    rotZ(a) { const c = Math.cos(a), s = Math.sin(a), M = this.M; for (let r = 0; r < 3; r++) { const m0 = M[r * 4], m1 = M[r * 4 + 1]; M[r * 4] = m0 * c + m1 * s; M[r * 4 + 1] = -m0 * s + m1 * c; } return this; }
    at(x, y, z, yaw = 0) { this.translate(x, y, z); if (yaw) this.rotY(yaw); return this; }
    // ---- raw vertex (local coordinates, local normal)
    v(x, y, z, nx, ny, nz, pu, pv) {
      if (this.n >= this.cap) this.alloc(this.cap * 2);
      const M = this.M, i = this.n++;
      const X = M[0] * x + M[1] * y + M[2] * z + M[3], Y = M[4] * x + M[5] * y + M[6] * z + M[7], Z = M[8] * x + M[9] * y + M[10] * z + M[11];
      let NX = M[0] * nx + M[1] * ny + M[2] * nz, NY = M[4] * nx + M[5] * ny + M[6] * nz, NZ = M[8] * nx + M[9] * ny + M[10] * nz;
      const l = Math.hypot(NX, NY, NZ) || 1; NX /= l; NY /= l; NZ /= l;
      this.P[i * 3] = X; this.P[i * 3 + 1] = Y; this.P[i * 3 + 2] = Z;
      this.N[i * 3] = Math.round(NX * 127); this.N[i * 3 + 1] = Math.round(NY * 127); this.N[i * 3 + 2] = Math.round(NZ * 127);
      const c = this.col; this.C[i * 3] = c8(c[0]); this.C[i * 3 + 1] = c8(c[1]); this.C[i * 3 + 2] = c8(c[2]);
      this.S[i * 4] = this.kind; this.S[i * 4 + 1] = pu + this.uo; this.S[i * 4 + 2] = pv + this.vo; this.S[i * 4 + 3] = this.prm;
      this.E[i * 4] = c8(this.sky); this.E[i * 4 + 1] = c8(this.ao); this.E[i * 4 + 2] = c8(this.glow); this.E[i * 4 + 3] = 0;
      return i;
    }
    // world-space vertex (bypasses the transform), for sweeps that compute their own positions
    vw(X, Y, Z, NX, NY, NZ, pu, pv) {
      if (this.n >= this.cap) this.alloc(this.cap * 2);
      const i = this.n++; const l = Math.hypot(NX, NY, NZ) || 1;
      this.P[i * 3] = X; this.P[i * 3 + 1] = Y; this.P[i * 3 + 2] = Z;
      this.N[i * 3] = Math.round(NX / l * 127); this.N[i * 3 + 1] = Math.round(NY / l * 127); this.N[i * 3 + 2] = Math.round(NZ / l * 127);
      const c = this.col; this.C[i * 3] = c8(c[0]); this.C[i * 3 + 1] = c8(c[1]); this.C[i * 3 + 2] = c8(c[2]);
      this.S[i * 4] = this.kind; this.S[i * 4 + 1] = pu + this.uo; this.S[i * 4 + 2] = pv + this.vo; this.S[i * 4 + 3] = this.prm;
      this.E[i * 4] = c8(this.sky); this.E[i * 4 + 1] = c8(this.ao); this.E[i * 4 + 2] = c8(this.glow); this.E[i * 4 + 3] = 0;
      return i;
    }
    tri(a, b, c) { if (this.ni + 3 > this.I.length) { const J = new Uint32Array(this.I.length * 2); J.set(this.I); this.I = J; } this.I[this.ni++] = a; this.I[this.ni++] = b; this.I[this.ni++] = c; }
    // quad from 4 local points (counter-clockwise seen from the front); surface coords given per corner
    quad(p0, p1, p2, p3, uv) {
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2], bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const a = this.v(p0[0], p0[1], p0[2], nx, ny, nz, uv[0], uv[1]), b = this.v(p1[0], p1[1], p1[2], nx, ny, nz, uv[2], uv[3]);
      const c = this.v(p2[0], p2[1], p2[2], nx, ny, nz, uv[4], uv[5]), d = this.v(p3[0], p3[1], p3[2], nx, ny, nz, uv[6], uv[7]);
      this.tri(a, b, c); this.tri(a, c, d);
    }
    // axis-aligned (local) box from min corner to max corner; faces get metric surface coordinates.
    // skip: string of faces to omit: 'x-', 'x+', 'y-', 'y+', 'z-', 'z+' (e.g. 'y-' for a box standing on a floor)
    box(x0, y0, z0, x1, y1, z1, skip = '') {
      if (!skip.includes('y+')) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [x0, z1, x1, z1, x1, z0, x0, z0]);
      if (!skip.includes('y-')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, z0, x1, z0, x1, z1, x0, z1]);
      if (!skip.includes('z+')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, x1, y0, x1, y1, x0, y1]);
      if (!skip.includes('z-')) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [-x1, y0, -x0, y0, -x0, y1, -x1, y1]);
      if (!skip.includes('x+')) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [-z1, y0, -z0, y0, -z0, y1, -z1, y1]);
      if (!skip.includes('x-')) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [z0, y0, z1, y0, z1, y1, z0, y1]);
      return this;
    }
    // centred box helper: width (x), height (y, from y0 up), depth (z)
    cbox(cx, y0, cz, w, h, d, skip) { return this.box(cx - w / 2, y0, cz - d / 2, cx + w / 2, y0 + h, cz + d / 2, skip); }
    // cylinder along Y (r0 bottom, r1 top), seg sides, optional caps
    cyl(cx, y0, cz, r0, r1, h, seg = 12, caps = true) {
      const base = [];
      for (let i = 0; i <= seg; i++) {
        const a = i / seg * TAU, c = Math.cos(a), s = Math.sin(a); const u = a * (r0 + r1) / 2;
        const ny = (r0 - r1) / h;
        const i0 = this.v(cx + c * r0, y0, cz + s * r0, c, ny, s, u, y0), i1 = this.v(cx + c * r1, y0 + h, cz + s * r1, c, ny, s, u, y0 + h);
        base.push([i0, i1]);
      }
      for (let i = 0; i < seg; i++) { const [a, b] = base[i], [c, d] = base[i + 1]; this.tri(a, b, d); this.tri(a, d, c); }
      if (caps) for (const [yy, r, up] of [[y0 + h, r1, 1], [y0, r0, -1]]) {
        if (r <= 0) continue; const ctr = this.v(cx, yy, cz, 0, up, 0, cx, cz); const ring = [];
        for (let i = 0; i <= seg; i++) { const a = i / seg * TAU; ring.push(this.v(cx + Math.cos(a) * r, yy, cz + Math.sin(a) * r, 0, up, 0, cx + Math.cos(a) * r, cz + Math.sin(a) * r)); }
        for (let i = 0; i < seg; i++) { if (up > 0) this.tri(ctr, ring[i + 1], ring[i]); else this.tri(ctr, ring[i], ring[i + 1]); }
      }
      return this;
    }
    // a cylinder between two local points (pipes, handrails, struts)
    tube(a, b, r, seg = 8, caps = false) {
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz); if (L < 1e-6) return this;
      // basis: w along the tube, u/v perpendicular
      const w = [dx / L, dy / L, dz / L]; const t = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let u = [w[1] * t[2] - w[2] * t[1], w[2] * t[0] - w[0] * t[2], w[0] * t[1] - w[1] * t[0]]; const ul = Math.hypot(...u); u = u.map(x => x / ul);
      const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
      const ring = [];
      for (let i = 0; i <= seg; i++) {
        const ang = i / seg * TAU, c = Math.cos(ang), s = Math.sin(ang); const n = [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s];
        ring.push([this.v(a[0] + n[0] * r, a[1] + n[1] * r, a[2] + n[2] * r, n[0], n[1], n[2], 0, ang * r), this.v(b[0] + n[0] * r, b[1] + n[1] * r, b[2] + n[2] * r, n[0], n[1], n[2], L, ang * r)]);
      }
      for (let i = 0; i < seg; i++) { const [p, q] = ring[i], [r2, s2] = ring[i + 1]; this.tri(p, r2, s2); this.tri(p, s2, q); }
      if (caps) for (const [P, sg] of [[a, -1], [b, 1]]) { const c0 = this.v(P[0], P[1], P[2], w[0] * sg, w[1] * sg, w[2] * sg, 0, 0); const rr = [];
        for (let i = 0; i <= seg; i++) { const ang = i / seg * TAU, c = Math.cos(ang), s = Math.sin(ang); rr.push(this.v(P[0] + (u[0] * c + v[0] * s) * r, P[1] + (u[1] * c + v[1] * s) * r, P[2] + (u[2] * c + v[2] * s) * r, w[0] * sg, w[1] * sg, w[2] * sg, 0, 0)); }
        for (let i = 0; i < seg; i++) if (sg > 0) this.tri(c0, rr[i], rr[i + 1]); else this.tri(c0, rr[i + 1], rr[i]); }
      return this;
    }
    // polyline tube through local points (handrails with bends)
    rail(pts, r, seg = 8) { for (let i = 0; i + 1 < pts.length; i++) this.tube(pts[i], pts[i + 1], r, seg, false); return this; }
    // extruded prism: a closed polygon (local x, z) from y0 to y1 with top/bottom caps (ear-cut by THREE.ShapeUtils)
    prism(poly, y0, y1, caps = 'tb') {
      const n = poly.length; let area = 0; for (let i = 0, j = n - 1; i < n; j = i++) area += (poly[j][0] - poly[i][0]) * (poly[j][1] + poly[i][1]);
      const P = area > 0 ? poly.slice().reverse() : poly;   // orientation with outward side normals (edge e -> normal (-ez, ex))
      let run = 0;
      if (caps.includes('s') || !caps.includes('-s')) for (let i = 0; i < n; i++) {
        const a = P[i], b = P[(i + 1) % n]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        this.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [run, y0, run + L, y0, run + L, y1, run, y1]); run += L;
      }
      const tris = THREE.ShapeUtils.triangulateShape(P.map(p => new THREE.Vector2(p[0], p[1])), []);
      const up = (t) => { const a = P[t[0]], b = P[t[1]], c = P[t[2]]; return (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]) > 0; };  // normal.y of (b-a)x(c-a)
      if (caps.includes('t')) { const base = P.map(p => this.v(p[0], y1, p[1], 0, 1, 0, p[0], p[1])); for (const t of tris) if (up(t)) this.tri(base[t[0]], base[t[1]], base[t[2]]); else this.tri(base[t[0]], base[t[2]], base[t[1]]); }
      if (caps.includes('b')) { const base = P.map(p => this.v(p[0], y0, p[1], 0, -1, 0, p[0], p[1])); for (const t of tris) if (up(t)) this.tri(base[t[0]], base[t[2]], base[t[1]]); else this.tri(base[t[0]], base[t[1]], base[t[2]]); }
      return this;
    }
    // append a THREE.BufferGeometry (positions/normals, indexed or not) through the current transform;
    // surface coordinates from a planar projection ('xz', 'xy', 'zy') of the local positions
    geo(g, proj = 'xz') {
      const P = g.attributes.position, N = g.attributes.normal; const base = this.n;
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        const pu = proj === 'xy' ? x : proj === 'zy' ? z : x, pv = proj === 'xz' ? z : y;
        this.v(x, y, z, N ? N.getX(i) : 0, N ? N.getY(i) : 1, N ? N.getZ(i) : 0, pu, pv);
      }
      if (g.index) for (let i = 0; i < g.index.count; i += 3) this.tri(base + g.index.getX(i), base + g.index.getX(i + 1), base + g.index.getX(i + 2));
      else for (let i = 0; i < P.count; i += 3) this.tri(base + i, base + i + 1, base + i + 2);
      return this;
    }
    // sweep a cross-section along a list of frames (station-local): frames[i] = { x, z, tx, tz, u } (unit tangent),
    // prof(i) -> [[v, y, pv?], ...] cross-section points (v: metres to the RIGHT of the frame, y absolute).
    // Consecutive profile points form faces; normals from the geometry (flat across the profile, smooth along u).
    // flip reverses the facing. uScale: pu = u * uScale (surface coordinate along the sweep).
    sweep(frames, prof, flip = false) {
      let prev = null;
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i], rx = -f.tz, rz = f.tx; const P = prof(i, f); if (!P) { prev = null; continue; }
        const row = [];
        for (let k = 0; k < P.length; k++) {
          const [v, y, pvv] = P[k]; row.push([f.x + rx * v, y, f.z + rz * v, f.u, pvv !== undefined ? pvv : v]);
        }
        if (prev && prev.length === row.length) {
          for (let k = 0; k + 1 < row.length; k++) {
            const a = prev[k], b = prev[k + 1], c = row[k + 1], d = row[k];
            if (a[5] === 'skip' || b[5] === 'skip') continue;
            // face normal
            const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2], e2x = d[0] - a[0], e2y = d[1] - a[1], e2z = d[2] - a[2];
            let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x; if (flip) { nx = -nx; ny = -ny; nz = -nz; }
            if (Math.hypot(nx, ny, nz) < 1e-9) continue;
            const pva = P[k][2] !== undefined ? 1 : 0; void pva;
            const ia = this.vw(a[0], a[1], a[2], nx, ny, nz, a[3], a[4]), ib = this.vw(b[0], b[1], b[2], nx, ny, nz, b[3], b[4]);
            const ic = this.vw(c[0], c[1], c[2], nx, ny, nz, c[3], c[4]), id = this.vw(d[0], d[1], d[2], nx, ny, nz, d[3], d[4]);
            if (flip) { this.tri(ia, ic, ib); this.tri(ia, id, ic); } else { this.tri(ia, ib, ic); this.tri(ia, ic, id); }
          }
        }
        prev = row;
      }
      return this;
    }
    get empty() { return this.ni === 0; }
    build() {
      if (!this.ni) return null;
      const g = new THREE.BufferGeometry(), n = this.n;
      g.setAttribute('position', new THREE.BufferAttribute(this.P.slice(0, n * 3), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(this.N.slice(0, n * 3), 3, true));
      g.setAttribute('color', new THREE.BufferAttribute(this.C.slice(0, n * 3), 3, true));
      g.setAttribute('aSurf', new THREE.BufferAttribute(this.S.slice(0, n * 4), 4));
      g.setAttribute('aExt', new THREE.BufferAttribute(this.E.slice(0, n * 4), 4, true));
      g.setIndex(new THREE.BufferAttribute(n < 65536 ? new Uint16Array(this.I.subarray(0, this.ni)) : this.I.slice(0, this.ni), 1));
      g.computeBoundingSphere(); g.computeBoundingBox();
      return g;
    }
    get tris() { return this.ni / 3; }
  }
  const c8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

  // ------------------------------------------------------------------------------------------------ GLSL
  const PATTERN_GLSL = /* glsl */`
    varying vec4 vSurf; varying vec4 vExt; varying vec3 vSkWp;
    float gBump; float gRough; float gMetal; float gGlowK;
    float skH(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    float skN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(skH(i), skH(i + vec2(1, 0)), f.x), mix(skH(i + vec2(0, 1)), skH(i + vec2(1, 1)), f.x), f.y); }
    float skF(vec2 p) { return 0.55 * skN(p) + 0.3 * skN(p * 2.13 + 7.1) + 0.15 * skN(p * 4.37 + 3.3); }
    // distance (m) to the nearest grid line of a w x h grid, and the cell id
    vec3 skGrid(vec2 q, vec2 sz) { vec2 g = q / sz; vec2 f = fract(g); vec2 d = min(f, 1.0 - f) * sz; return vec3(min(d.x, d.y), floor(g)); }
    vec3 skPattern(vec3 col) {
      float k = floor(vSurf.x + 0.5); vec2 q = vSurf.yz; float w = vSurf.w;
      float fw = max(max(fwidth(q.x), fwidth(q.y)), 1e-5);
      gBump = 0.0; gRough = -1.0; gMetal = -1.0; gGlowK = 0.0;
      if (k < 0.5) { if (w > 0.0) gRough = w; return col; }
      if (k < 1.5) {                                        // glazed tile (stack bond; w < 0: running bond, brick-shaped)
        float s = abs(w); vec2 sz = w < 0.0 ? vec2(s, s * 0.5) : vec2(s);
        vec2 qq = q; if (w < 0.0) qq.x += step(1.0, mod(floor(q.y / sz.y), 2.0)) * sz.x * 0.5;
        vec3 g = skGrid(qq, sz); float gw = 0.0022;
        float grout = 1.0 - smoothstep(gw, gw + fw * 1.2, g.x);
        float v = skH(g.yz); col *= 0.94 + 0.1 * v; col *= 1.0 - 0.05 * skN(q * 0.7);
        col = mix(col, vec3(0.42, 0.41, 0.39), grout * (1.0 - smoothstep(0.004, 0.02, fw)) * 0.85);
        gRough = mix(0.14 + 0.08 * v, 0.85, grout); gBump = -grout * 0.0015 + 0.0004 * skN(q * 30.0);
        return col;
      }
      if (k < 2.5) {                                        // terrazzo: chips at two scales, brass divider strips every w m
        float c1 = skH(floor(q * 95.0)), c2 = skH(floor(q * 41.0 + 3.7));
        vec3 chip = mix(vec3(0.95, 0.93, 0.88), vec3(0.25, 0.24, 0.23), step(0.55, skH(floor(q * 95.0) + 11.0)));
        float near = 1.0 - smoothstep(0.003, 0.012, fw);
        col = mix(col, chip * (0.8 + 0.2 * c2), step(0.72, c1) * 0.55 * near + step(0.8, c1) * 0.2 * (1.0 - near));
        col *= 0.93 + 0.1 * skN(q * 0.9);
        if (w > 0.0) { vec3 g = skGrid(q, vec2(w)); float strip = 1.0 - smoothstep(0.003, 0.003 + fw, g.x); col = mix(col, vec3(0.55, 0.43, 0.22), strip * 0.8); gMetal = strip; }
        gRough = 0.2 + 0.12 * skN(q * 3.0); return col;
      }
      if (k < 3.5) {                                        // concrete: pores, trowel mottle, joints every w m
        float n = skF(q * 1.3); col *= 0.86 + 0.2 * n; col *= 1.0 - 0.08 * step(0.93, skH(floor(q * 60.0)));
        if (w > 0.0) { vec3 g = skGrid(q, vec2(w)); float j = 1.0 - smoothstep(0.004, 0.004 + fw * 1.4, g.x); col *= 1.0 - 0.35 * j; gBump = -j * 0.004; }
        gBump += (skN(q * 40.0) - 0.5) * 0.0006; gRough = 0.86; return col;
      }
      if (k < 4.5) {                                        // tactile warning: truncated domes on a 60 mm grid (q.y from the band edge)
        vec2 g = q / 0.0605; vec2 c = fract(g) - 0.5; float r = length(c);
        float near = 1.0 - smoothstep(0.004, 0.018, fw); float dome = (1.0 - smoothstep(0.17, 0.21, r)) * near;
        gBump = dome * 0.004; gRough = mix(0.55, 0.4, dome); col *= 0.92 + 0.12 * skN(q * 3.0) + 0.1 * dome; return col;
      }
      if (k < 5.5) {                                        // granite pavers: speckle, joints
        float sp = skH(floor(q * 180.0)); float near = 1.0 - smoothstep(0.002, 0.01, fw);
        col *= 0.9 + 0.2 * mix(0.5, sp, near) ; col = mix(col, col * 0.45, step(0.9, sp) * near * 0.6);
        vec3 g = skGrid(q, vec2(w > 0.0 ? w : 0.6)); float j = 1.0 - smoothstep(0.0025, 0.0025 + fw * 1.3, g.x);
        col *= 1.0 - 0.4 * j; col *= 0.95 + 0.1 * skH(g.yz); gBump = -j * 0.002; gRough = 0.45 + 0.15 * skN(q * 2.0); return col;
      }
      if (k < 6.5) {                                        // brick, running bond (w: 1 glazed)
        vec2 sz = vec2(0.203, 0.0677); vec2 qq = q; qq.x += step(1.0, mod(floor(q.y / sz.y), 2.0)) * sz.x * 0.5;
        vec3 g = skGrid(qq, sz); float m = 1.0 - smoothstep(0.004, 0.004 + fw, g.x);
        col *= 0.85 + 0.25 * skH(g.yz); col = mix(col, vec3(0.6, 0.58, 0.55), m); gBump = -m * 0.004;
        gRough = w > 0.5 ? mix(0.2, 0.8, m) : 0.85; return col;
      }
      if (k < 7.5) {                                        // metal panels (ceilings, cladding): joints, faint perforation
        float s = w > 0.0 ? w : 0.6; vec3 g = skGrid(q, vec2(s, s)); float j = 1.0 - smoothstep(0.003, 0.003 + fw, g.x);
        col *= 0.96 + 0.06 * skH(g.yz); col *= 1.0 - 0.45 * j; gBump = -j * 0.003; gRough = 0.5; return col;
      }
      if (k < 8.5) {                                        // waffle coffers: a shaded grid of recesses (rib shading + bump)
        float s = w > 0.0 ? w : 1.2; vec2 f = fract(q / s) - 0.5; vec2 a = abs(f) * 2.0;
        float rib = smoothstep(0.62, 0.8, max(a.x, a.y)); float cav = 1.0 - rib;
        col *= mix(0.72 + 0.2 * (1.0 - max(a.x, a.y)), 1.0, rib); gBump = rib * 0.06; gRough = 0.9; return col;
      }
      if (k < 9.5) {                                        // stair tread with a dark anti-slip nosing (q.y = metres from the nosing)
        float nos = 1.0 - smoothstep(0.075, 0.075 + fw, q.y); col = mix(col, vec3(0.08, 0.08, 0.08), nos);
        float grit = step(0.5, fract(q.x * 60.0)) * nos; gBump = -grit * 0.0007; gRough = mix(0.8, 0.95, nos); return col;
      }
      if (k < 10.5) {                                       // brushed stainless: streaks along u
        float s = skN(vec2(q.x * 3.0, q.y * 400.0)); col *= 0.9 + 0.12 * s; gRough = 0.28 + 0.1 * s; gMetal = 1.0; return col;
      }
      if (k < 11.5) { col *= 0.97 + 0.05 * skN(q * 8.0); gRough = 0.45; return col; }     // painted steel
      if (k < 12.5) {                                       // sidewalk concrete: scored joints, stains
        float s = w > 0.0 ? w : 1.5; vec3 g = skGrid(q, vec2(s)); float j = 1.0 - smoothstep(0.004, 0.004 + fw * 1.5, g.x);
        col *= 0.88 + 0.16 * skF(q * 0.8) + 0.05 * (skH(g.yz) - 0.5); col *= 1.0 - 0.3 * j; col *= 1.0 - 0.15 * step(0.985, skH(floor(q * 7.0))) * skN(q * 9.0);
        gBump = -j * 0.004; gRough = 0.88; return col;
      }
      if (k < 13.5) {                                       // flamed granite coping
        float sp = skH(floor(q * 220.0)); col *= 0.9 + 0.18 * sp; gBump = (sp - 0.5) * 0.0005; gRough = 0.7; return col;
      }
      if (k < 14.5) {                                       // studded rubber
        vec2 c = fract(q / 0.05) - 0.5; float st = 1.0 - smoothstep(0.25, 0.3, length(c)); gBump = st * 0.0015; gRough = 0.75; return col;
      }
      if (k < 15.5) { col *= 0.9 + 0.14 * skF(q * 3.0); gBump = (skN(q * 50.0) - 0.5) * 0.002; gRough = 0.95; return col; }  // sprayed plaster
      if (k < 16.5) {                                       // wood slats along u
        float s = w > 0.0 ? w : 0.09; float g = fract(q.y / s); float gap = 1.0 - smoothstep(0.04, 0.1, min(g, 1.0 - g));
        col *= 0.85 + 0.2 * skN(vec2(q.x * 2.0, floor(q.y / s) * 7.0 + q.y * 30.0)); col *= 1.0 - 0.5 * gap; gBump = -gap * 0.004; gRough = 0.6; return col;
      }
      if (k < 17.5) {                                       // corrugated / standing seam (ribs across v)
        float s = w > 0.0 ? w : 0.2; float ph = q.y / s * 6.2832; gBump = sin(ph) * s * 0.08; col *= 0.95 + 0.05 * sin(ph); gRough = 0.45; return col;
      }
      if (k < 18.5) {                                       // fluted concrete (vertical flutes across u)
        float s = w > 0.0 ? w : 0.15; float ph = fract(q.x / s); float fl = sqrt(max(0.0, 1.0 - pow(2.0 * ph - 1.0, 2.0)));
        gBump = -fl * s * 0.25; col *= 0.86 + 0.14 * fl + 0.08 * (skF(q * 1.5) - 0.5); gRough = 0.9; return col;
      }
      if (k < 19.5) {                                       // board-formed concrete: horizontal boards w m high, grain
        float s = w > 0.0 ? w : 0.14; float b = floor(q.y / s); float f = fract(q.y / s);
        float edge = 1.0 - smoothstep(0.0, 0.06, min(f, 1.0 - f));
        col *= 0.84 + 0.12 * skH(vec2(b, 1.0)) + 0.1 * skN(vec2(q.x * 1.3, b * 5.0 + q.y * 14.0)); col *= 1.0 - 0.12 * edge;
        gBump = -edge * 0.002 + (skN(vec2(q.x * 9.0, q.y * 120.0)) - 0.5) * 0.001; gRough = 0.92; return col;
      }
      if (k < 20.5) { col *= 0.8 + 0.3 * skF(q * 2.5); col *= 1.0 - 0.2 * step(0.97, skH(floor(q * 3.0))); gRough = 0.92; gBump = (skH(floor(q * 150.0)) - 0.5) * 0.0015; return col; }  // asphalt
      if (k < 21.5) { vec3 g = skGrid(q, vec2(0.2)); float j = 1.0 - smoothstep(0.006, 0.006 + fw, g.x); col = mix(col * (0.9 + 0.2 * skN(q * 13.0)), vec3(0.5), j); gRough = mix(0.1, 0.8, j); gBump = -j * 0.004; return col; }  // glass block
      if (k < 22.5) {                                       // glass mosaic: w m tesserae, strong variation
        float s = w > 0.0 ? w : 0.025; vec3 g = skGrid(q, vec2(s)); float gr = 1.0 - smoothstep(0.0012, 0.0012 + fw, g.x);
        float v = skH(g.yz); col *= 0.75 + 0.5 * v; col = mix(col, vec3(0.5, 0.49, 0.47), gr * (1.0 - smoothstep(0.003, 0.01, fw))); gRough = mix(0.08, 0.8, gr); return col;
      }
      if (k < 23.5) {                                       // grating
        vec2 f = fract(q / vec2(0.035, 0.1)); float bar = step(0.75, f.x) + step(0.9, f.y); col *= mix(0.15, 1.0, clamp(bar, 0.0, 1.0)); gRough = 0.5; gMetal = 0.8; return col;
      }
      if (k < 24.5) {                                       // ballast / trackbed gravel
        float s = skH(floor(q * 30.0)); col *= 0.6 + 0.6 * s; gBump = (s - 0.5) * 0.01; gRough = 0.95; return col;
      }
      return col;
    }
  `;
  const LIGHT_GLSL = /* glsl */`
    uniform vec4 uLA[${MAXL}]; uniform vec4 uLB[${MAXL}]; uniform vec4 uLC[${MAXL}]; uniform vec4 uLD[${MAXL}];
    uniform int uLN; uniform vec3 uAmb; uniform float uEnvSky; uniform float uLightK; uniform float uSkyK;
    // irradiance at P (normal N) from an isotropic line source A-B of unit intensity per metre:
    //   E = integral over the segment of max(0, N.(Q-P)) / |Q-P|^3 dl  (closed form; the segment is first clipped to the
    //   half-space in front of the surface so the part behind it does not subtract)
    float skLineE(vec3 P, vec3 N, vec3 A, vec3 B) {
      float dA = dot(N, A - P) - 0.004, dB = dot(N, B - P) - 0.004;
      if (dA <= 0.0 && dB <= 0.0) return 0.0;
      if (dA < 0.0) A = mix(A, B, dA / (dA - dB)); else if (dB < 0.0) B = mix(B, A, dB / (dB - dA));
      vec3 a = A - P, d = B - A;
      float aa = dot(d, d); if (aa < 1e-8) return 0.0;
      float bb = 2.0 * dot(a, d), cc = dot(a, a);
      float disc = max(4.0 * aa * cc - bb * bb, 1e-5 * aa);
      float al = dot(N, a), be = dot(N, d);
      float s0 = sqrt(max(cc, 1e-8)), s1 = sqrt(max(aa + bb + cc, 1e-8));
      float F1 = (2.0 * (2.0 * aa + bb) * al - 2.0 * (bb + 2.0 * cc) * be) / (disc * s1);
      float F0 = (2.0 * bb * al - 4.0 * cc * be) / (disc * s0);
      return max(0.0, (F1 - F0) * sqrt(aa));
    }
    void skLines(vec3 P, vec3 N, vec3 V, PhysicalMaterial material, inout ReflectedLight reflectedLight) {
      vec3 R = reflect(-V, N);
      for (int i = 0; i < ${MAXL}; i++) {
        if (i >= uLN) break;
        vec3 A = uLA[i].xyz, B = uLB[i].xyz; float range = uLA[i].w, rad = max(uLB[i].w, 0.01);
        vec3 col = uLC[i].rgb * uLightK;
        // closest point on the segment to P: range window + directional (troughs light downward, coves upward)
        vec3 d = B - A; float t0 = clamp(dot(P - A, d) / max(dot(d, d), 1e-6), 0.0, 1.0); vec3 Cp = A + d * t0;
        float dist = length(P - Cp); float win = 1.0 - smoothstep(range * 0.6, range, dist); if (win <= 0.0) continue;
        vec3 toP = (P - Cp) / max(dist, 1e-4); float dirk = uLD[i].w > 0.0 ? mix(uLD[i].w < 1.5 ? 0.12 : 0.0, 1.0, pow(clamp(dot(toP, uLD[i].xyz) * 0.5 + 0.5, 0.0, 1.0), 2.5)) : 1.0;
        float E = skLineE(P, N, A, B) * win * dirk;
        reflectedLight.directDiffuse += col * E * BRDF_Lambert(material.diffuseColor);
        // specular: representative point on the segment nearest the reflection ray, lobe widened by the tube radius
        vec3 a = A - P; float rd = dot(R, d);
        float t = clamp((dot(R, a) * rd - dot(a, d)) / max(dot(d, d) - rd * rd, 1e-5), 0.0, 1.0);
        vec3 Lp = a + d * t; float ld = length(Lp); vec3 L = Lp / max(ld, 1e-4);
        float NoL = max(dot(N, L), 0.0); if (NoL <= 0.0) continue;
        PhysicalMaterial m2 = material; float al0 = material.roughness * material.roughness;
        float al1 = clamp(al0 + rad / (2.0 * ld), 0.0, 1.0); m2.roughness = sqrt(al1);
        float norm = al0 / max(al1, 1e-4);
        reflectedLight.directSpecular += col * (3.1416 / max(ld, 0.25)) * NoL * norm * win * dirk * BRDF_GGX(L, V, N, m2);
      }
    }
  `;
  // patch MeshStandardMaterial: patterns, bump, sky scaling, line lights, ambient fill
  function patch(sh, u) {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aSurf; attribute vec4 aExt; varying vec4 vSurf; varying vec4 vExt; varying vec3 vSkWp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = aSurf; vExt = aExt; vSkWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PATTERN_GLSL)
      .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + LIGHT_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = skPattern(diffuseColor.rgb);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (gRough >= 0.0) roughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nif (gMetal >= 0.0) metalnessFactor = gMetal;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition); float hx = dFdx(gBump), hy = dFdy(gBump);
          vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx); float det = dot(dpx, r1);
          if (abs(det) > 1e-12) normal = normalize(abs(det) * normal - sign(det) * (hx * r1 + hy * r2));
        }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vExt.z * 6.0 * uLightK;')
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        {
          float sky = vExt.x * uSkyK, ao = vExt.y;
          reflectedLight.directDiffuse *= sky; reflectedLight.directSpecular *= sky;
          #if defined( RE_IndirectDiffuse )
            irradiance *= sky * ao;
            irradiance += uAmb * ao * uLightK;
            iblIrradiance *= mix(1.0, sky, uEnvSky) * ao;
          #endif
          #if defined( RE_IndirectSpecular )
            radiance *= mix(1.0, sky, uEnvSky) * mix(ao, 1.0, 0.5);
          #endif
          skLines(geometryPosition, geometryNormal, geometryViewDir, material, reflectedLight);
        }`);
  }
  function newLightUniforms() {
    const arr = () => Array.from({ length: MAXL }, () => new THREE.Vector4());
    return { uLA: { value: arr() }, uLB: { value: arr() }, uLC: { value: arr() }, uLD: { value: arr() }, uLN: { value: 0 },
      uAmb: { value: new THREE.Color(0, 0, 0) }, uEnvSky: { value: 1 }, uLightK: { value: 1 }, uSkyK: { value: 1 } };
  }
  // the station material. opts: { rough, metal, envK, env (interior env map), side, interior }
  function stationMat(opts = {}) {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: opts.rough ?? 0.8, metalness: opts.metal ?? 0, envMapIntensity: opts.envK ?? 1, side: opts.side || THREE.FrontSide });
    if (opts.env) m.envMap = opts.env;
    if (opts.transparent) { m.transparent = true; m.opacity = opts.opacity ?? 0.3; m.depthWrite = false; }
    const u = newLightUniforms(); u.uEnvSky.value = opts.env ? 0 : 1;
    m.userData.sk = u;
    m.onBeforeCompile = (sh) => patch(sh, u);
    m.customProgramCacheKey = () => 'stkit-v1' + (opts.transparent ? 't' : '');
    return m;
  }

  // ------------------------------------------------------------------------------------------------ light sets
  // A light set: line lights in station-local coordinates. { a:[x,y,z], b:[x,y,z], color:[r,g,b] (linear, per metre),
  // range, radius, dir:[x,y,z] (facing, e.g. [0,-1,0] for a downlight trough) and focus (0 omni, 1 mostly one side, 2 one side only) }.
  // bind(mesh) makes the mesh upload the set (view space) into its material right before it is drawn.
  const _m4 = new THREE.Matrix4(), _v = new THREE.Vector3(), _n3 = new THREE.Matrix3();
  class LightSet {
    constructor(lights = [], amb = [0, 0, 0]) { this.lights = lights.slice(0, MAXL); this.amb = amb; this.stamp = -1; this.k = 1; }
    add(l) { if (this.lights.length < MAXL) this.lights.push(l); return this; }
    upload(mat, root, camera) {
      const u = mat.userData.sk; if (!u) return;
      // view matrix of this camera x the station root's world matrix
      _m4.multiplyMatrices(camera.matrixWorldInverse, root.matrixWorld); _n3.setFromMatrix4(_m4);
      const L = this.lights; u.uLN.value = L.length;
      for (let i = 0; i < L.length; i++) {
        const l = L[i];
        _v.set(l.a[0], l.a[1], l.a[2]).applyMatrix4(_m4); u.uLA.value[i].set(_v.x, _v.y, _v.z, l.range || 30);
        _v.set(l.b[0], l.b[1], l.b[2]).applyMatrix4(_m4); u.uLB.value[i].set(_v.x, _v.y, _v.z, l.radius || 0.06);
        u.uLC.value[i].set(l.color[0], l.color[1], l.color[2], 0);
        if (l.dir) { _v.set(l.dir[0], l.dir[1], l.dir[2]).applyMatrix3(_n3).normalize(); u.uLD.value[i].set(_v.x, _v.y, _v.z, l.focus ?? 1); } else u.uLD.value[i].set(0, -1, 0, 0);
      }
      u.uAmb.value.setRGB(this.amb[0], this.amb[1], this.amb[2]);
    }
    bind(mesh, root) {
      const set = this; const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mesh.onBeforeRender = (r, s, camera) => { for (const m of mats) set.upload(m, root, camera); };
    }
  }
  // interior environment for underground materials: a warm-neutral room with bright ceiling strips (PMREM, cached)
  let envInterior = null;
  function interiorEnv(renderer) {
    if (envInterior) return envInterior;
    const sc = new THREE.Scene();
    const room = new THREE.Mesh(new THREE.BoxGeometry(20, 6, 60), new THREE.MeshBasicMaterial({ color: 0x3a3632, side: THREE.BackSide }));
    sc.add(room);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 60).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x2c2926 })); floor.position.y = -2.99; sc.add(floor);
    for (const x of [-5, 0, 5]) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 56), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.6, 5) })); s.position.set(x, 2.95, 0); sc.add(s); }
    const pm = new THREE.PMREMGenerator(renderer); envInterior = pm.fromScene(sc, 0.02).texture; pm.dispose();
    return envInterior;
  }

  // ------------------------------------------------------------------------------------------------ other materials
  // emissive fixtures (lamps, lit panels): vertex colour x intensity, bloom-friendly; intensity via uniform
  function glowMat(intensity = 6) {
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    m.userData.k = { value: intensity };
    m.onBeforeCompile = (sh) => { sh.uniforms.uGlowK = m.userData.k; sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uGlowK;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= uGlowK;'); };
    m.customProgramCacheKey = () => 'stkit-glow';
    return m;
  }
  function glassMat(opts = {}) {
    const m = new THREE.MeshStandardMaterial({ color: opts.color ?? 0xb9ccd2, roughness: opts.rough ?? 0.05, metalness: 0.1, transparent: true, opacity: opts.opacity ?? 0.2,
      depthWrite: false, side: THREE.DoubleSide, envMapIntensity: opts.envK ?? 1.1 });
    if (opts.env) m.envMap = opts.env;
    return m;
  }

  return { PLAT_H, EDGE, MAXL, K, GB, lin, mixc, scl, stationMat, glowMat, glassMat, LightSet, interiorEnv, PATTERN_GLSL, LIGHT_GLSL };
})();
