// MetroTrack (Bayline Metro, infra workstream): everything the metro trains run on and through, streamed around the
// camera from MetroNet (21_metronet.js). Inert unless #metro=1.
//   Track: broad gauge (1,676 mm) 119 lb rails with a polished running band, direct-fixation fasteners on concrete
//   plinths (aerials, tunnels) or concrete ties in ballast (at grade), the 1,000 V third rail on insulators under its
//   fibreglass coverboard, cable troughs, walkways, fences. Structures by type (24_metroguide.js: grade, embankment,
//   trench, freeway median, aerial box girders on hammerhead columns by era, bridges; 24_metrotube.js: cut-and-cover
//   boxes, bored tunnels, the Transbay Tube, portals, tunnel lights, and the underground cells for Under).
//   Streaming: every track is cut into CH m chunks; each chunk has up to three layers built by time-sliced jobs
//   (≤ BUDGET ms per frame): FAR (a nearly free silhouette of aerials/bridges/embankments, for the flight sim), BODY
//   (the structures, tunnels and bed) and DETAIL (rails, plinths, third rail, the small parts). Tiny repeated parts
//   (fasteners, insulators, ties) are instanced in a window that follows the camera. Paired tracks (the two mains of a
//   line, ≲ 7 m apart) share one structure, built by the chunk of the "primary" track.
// API: MetroTrack.enabled, init(), update(camPos, dt), group, stats, DIM, PAL, GB (geometry builder), frameAt(track, s, o),
//      pairAt(track, s) -> { t2, s2, lat } | null, limits(track) (station ranges: STATIONS builds the box/deck there).
const MetroTrack = (() => {
  const enabled = (() => { try { return new URLSearchParams(location.hash.slice(1)).get('metro') === '1'; } catch (e) { return false; } })();
  const group = new THREE.Group(); group.name = 'metro-infra';
  const stats = { chunks: 0, far: 0, body: 0, detail: 0, jobs: 0, buildMs: 0, tris: 0, inst: 0 };
  if (!enabled) return { enabled: false, init() {}, update() {}, group, stats };

  // ---------------------------------------------------------------- dimensions (metres; research: notes/bart/infra.md)
  const DIM = {
    gauge: 1.676,                 // 66 in between the rails' gauge lines (838 mm from the centreline) [BFS 34 05 17]
    railH: 0.1730, railHead: 0.0675, railBase: 0.1397, railWeb: 0.0143, railHeadD: 0.0476,   // 119RE [BFS 34 11 25]
    get railC() { return this.gauge / 2 + this.railHead / 2 - 0.016; },  // rail head centre (gauge measured 16 mm below the top)
    railCant: 1 / 40,             // rails canted inward 1:40
    fastSpacing: 0.914,           // Landis DF fasteners at 36 in on the original aerials and subways [CLEMONS]
    plinthW: 0.787, plinthH: 0.09, // continuous plinth under each rail, 31 in wide [CLEMONS]
    tieSpacing: 0.762, tieLen: 3.05, tieW: 0.28, tieH: 0.23,             // concrete ties at 30 in, ~10 ft long [BFS 34 11 31]
    ballastDepth: 0.305, ballastShoulder: 0.305, ballastSlope: 2.0,     // [BFS 34 05 17]
    // third rail: centre 1.499 m from the track centre, contact surface 171 mm above top of rail, light-grey porcelain
    // insulators (229 mm) every 3.05 m, light-grey fibreglass coverboard above [BFS 34 05 17, 34 24 13]
    third: { lat: 1.499, top: 0.171, w: 0.076, h: 0.13, coverH: 0.255, coverW: 0.29, insulator: 3.05, insH: 0.229 },
    // aerial guideway, original (1968-72): one trapezoidal precast box girder per track, 1.22 m deep, 3.556 m deck, 14 ft
    // centres (0.71 m gap with a sunken walkway), 1.52 m hexagonal columns with hammerhead caps, ~22 m spans [CLEMONS]
    aerial: { girderTopW: 3.556, girderBotW: 1.7, girderD: 1.22, flangeT: 0.2, spanTyp: 22.5, colD: 1.52, capD: 1.5, capL: 1.8,
              deckBelowTOR: 0.29, walkDrop: 0.25 },
    tunnel: { boreR: 2.59, walkH: 0.71, walkW: 0.76, lampSpacing: 15.24, lampH: 2.3 },
    fenceH: 2.13, barbed: 0.31,   // chain link + 3 barbed strands = 2.44 m [BFS 32 31 13]
  };

  // ---------------------------------------------------------------- palette: [r, g, b (linear), roughness, metalness, kind]
  // kinds (shader): 0 plain, 1 concrete, 2 rail side (rust), 3 rail head (polished band), 4 ballast, 5 lamp (always lit),
  //                 6 lamp (lit at night), 7 galvanised steel, 8 fibreglass, 9 rubber / plastic, 10 tunnel lining
  const _c = new THREE.Color();
  const P = (hex, rough, metal, kind) => { _c.setHex(hex); return [_c.r, _c.g, _c.b, rough, metal, kind]; };
  const PAL = {
    concrete: P(0xb5b0a6, 0.9, 0, 1), concreteLight: P(0xc3beb3, 0.88, 0, 1), concreteDark: P(0x8f8a82, 0.92, 0, 1), concreteWarm: P(0xb8ad9c, 0.9, 0, 1),
    precast: P(0xbdb8ae, 0.82, 0, 1), deckTop: P(0x9d9990, 0.93, 0, 1), plinth: P(0x9e9a92, 0.9, 0, 1), lining: P(0x9a968e, 0.93, 0, 10), liningDark: P(0x77736c, 0.95, 0, 10),
    railRust: P(0x5a4030, 0.78, 0.35, 2), railSide: P(0x6f6259, 0.55, 0.6, 2), railTop: P(0xd2d6db, 0.14, 1.0, 3),
    thirdRail: P(0x8d8e8f, 0.45, 0.8, 2), thirdTop: P(0xb4b6b8, 0.28, 0.95, 3), cover: P(0xa9adad, 0.62, 0, 8), insul: P(0xc4c6c4, 0.25, 0, 9),
    fastener: P(0x34373a, 0.6, 0.55, 0), pad: P(0x151515, 0.92, 0, 9), clip: P(0x2b2d2f, 0.5, 0.7, 0),
    galv: P(0xa2a7ab, 0.42, 0.85, 7), galvDark: P(0x7d8286, 0.5, 0.8, 7), steelPaint: P(0x5d6166, 0.55, 0.3, 0), railing: P(0x8a9096, 0.45, 0.7, 7),
    grate: P(0x4f5357, 0.55, 0.7, 7), cable: P(0x1c1d1f, 0.6, 0.0, 9), conduit: P(0x8b8f93, 0.45, 0.6, 7),
    ballast: P(0x9d978c, 0.95, 0, 4), soil: P(0x7a6a55, 0.95, 0, 1), asphalt: P(0x55534f, 0.92, 0, 1),
    lamp: P(0xfff1d6, 0.3, 0, 5), lampNight: P(0xffd9a8, 0.3, 0, 6), lampHousing: P(0x3a3c3f, 0.5, 0.4, 0),
    signBlue: P(0x1d4e89, 0.4, 0.1, 0), signWhite: P(0xe8e8e2, 0.45, 0, 0), yellow: P(0xd9ad22, 0.5, 0.05, 0), black: P(0x151617, 0.6, 0.1, 0),
    fence: P(0x8b9094, 0.45, 0.6, 7), bearing: P(0x202020, 0.8, 0, 9), steel: P(0x4a4d50, 0.55, 0.55, 0),
    steelRing: P(0x55595c, 0.62, 0.55, 11), exitSign: P(0x2fb35a, 0.4, 0, 5), blueLamp: P(0x3a6cff, 0.3, 0, 5),
    doorYellow: P(0xe0b21e, 0.5, 0.2, 0), jacket: P(0x9a9d9e, 0.5, 0.55, 7), blueSign: P(0x1f4f8f, 0.4, 0.1, 0),
    frog: P(0x6a5a50, 0.62, 0.6, 2), steelGreen: P(0x3b4a3e, 0.55, 0.35, 0), tie: P(0xa29e95, 0.9, 0, 1),
  };

  // ---------------------------------------------------------------- geometry builder
  // position, normal, colour (linear rgb), aM = (roughness, metalness, kind, wear), aT = (s, below the top edge, above the
  // ground, light group). `top` / `gnd` (heights, m) feed the rain-streak and base-grime terms; set them per part.
  class GB {
    constructor() { this.p = []; this.n = []; this.c = []; this.m = []; this.t = []; this.i = []; this.s = 0; this.top = 1e4; this.gnd = -1e4; this.lg = -1; this.wear = 0.5; }
    get count() { return this.p.length / 3; }
    v(x, y, z, nx, ny, nz, C) {
      this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(C[0], C[1], C[2]); this.m.push(C[3], C[4], C[5], this.wear);
      this.t.push(this.s, Math.max(0, this.top - y), Math.max(0, y - this.gnd), this.lg); return this.p.length / 3 - 1;
    }
    q(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
    tri(a, b, c) { this.i.push(a, b, c); }
    // planar quad a b c d (counter-clockwise seen from the outside), flat normal
    quad(a, b, c, d, C) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
      const i0 = this.v(a[0], a[1], a[2], nx, ny, nz, C), i1 = this.v(b[0], b[1], b[2], nx, ny, nz, C), i2 = this.v(c[0], c[1], c[2], nx, ny, nz, C), i3 = this.v(d[0], d[1], d[2], nx, ny, nz, C);
      this.q(i0, i1, i2, i3);
    }
    // oriented box: centre, unit axes ax (x), ay (y), az (z), half extents; faces: skip = bit set (1 -x, 2 +x, 4 -y, 8 +y, 16 -z, 32 +z)
    box(cx, cy, cz, ax, ay, az, hx, hy, hz, C, skip = 0) {
      const P = (sx, sy, sz) => [cx + ax[0] * sx * hx + ay[0] * sy * hy + az[0] * sz * hz, cy + ax[1] * sx * hx + ay[1] * sy * hy + az[1] * sz * hz, cz + ax[2] * sx * hx + ay[2] * sy * hy + az[2] * sz * hz];
      const f = (bit, a, b, c, d) => { if (!(skip & bit)) this.quad(a, b, c, d, C); };
      f(2, P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1)); f(1, P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), P(-1, -1, -1));
      f(8, P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1)); f(4, P(-1, -1, 1), P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1));
      f(32, P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)); f(16, P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1));
    }
    // cylinder / frustum from A to B, radius r0 at A and r1 at B, n sides, smooth sides, optional caps
    cyl(A, B, r0, r1, n, C, capA, capB) {
      let wx = B[0] - A[0], wy = B[1] - A[1], wz = B[2] - A[2]; const L = Math.hypot(wx, wy, wz) || 1; wx /= L; wy /= L; wz /= L;
      let hx = 0, hy = 1, hz = 0; if (Math.abs(wy) > 0.9) { hx = 1; hy = 0; }
      let ux = hy * wz - hz * wy, uy = hz * wx - hx * wz, uz = hx * wy - hy * wx; const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      const vx = wy * uz - wz * uy, vy = wz * ux - wx * uz, vz = wx * uy - wy * ux; const b = this.count, sl = (r0 - r1) / L;
      for (let k = 0; k <= n; k++) {
        const t = k / n * Math.PI * 2, co = Math.cos(t), si = Math.sin(t); const dx = ux * co + vx * si, dy = uy * co + vy * si, dz = uz * co + vz * si;
        let nx = dx + wx * sl, ny = dy + wy * sl, nz = dz + wz * sl; const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
        this.v(A[0] + dx * r0, A[1] + dy * r0, A[2] + dz * r0, nx, ny, nz, C); this.v(B[0] + dx * r1, B[1] + dy * r1, B[2] + dz * r1, nx, ny, nz, C);
      }
      for (let k = 0; k < n; k++) { const a0 = b + 2 * k; this.q(a0, a0 + 2, a0 + 3, a0 + 1); }
      const cap = (Pp, r, s) => { const c0 = this.v(Pp[0], Pp[1], Pp[2], wx * s, wy * s, wz * s, C), rb = this.count;
        for (let k = 0; k <= n; k++) { const t = k / n * Math.PI * 2, co = Math.cos(t), si = Math.sin(t); this.v(Pp[0] + (ux * co + vx * si) * r, Pp[1] + (uy * co + vy * si) * r, Pp[2] + (uz * co + vz * si) * r, wx * s, wy * s, wz * s, C); }
        for (let k = 0; k < n; k++) { if (s > 0) this.i.push(c0, rb + k, rb + k + 1); else this.i.push(c0, rb + k + 1, rb + k); } };
      if (capB) cap(B, r1, 1); if (capA) cap(A, r0, -1);
    }
    // sweep a cross-section along rows. rows[i] = { o: [x,y,z] origin, r: [x,y,z] lateral unit, u: [x,y,z] up unit, s }.
    // prof = [[l, h], ...] polyline in (lateral, up), traversed CLOCKWISE (outside on the left of the direction of travel:
    // a top face runs from -l to +l, a left face upward); C = colour (or per-segment array); flat (hard edges) or smooth
    // normals around the profile; closed joins the last point to the first; flip turns every face inside out.
    sweep(rows, prof, C, opt = {}) {
      const np = prof.length, flat = opt.flat !== false, closed = !!opt.closed, flip = !!opt.flip;
      if (rows.length < 2 || np < 2) return;
      const segs = closed ? np : np - 1;
      // per-segment 2D normals (outward = right of the segment direction for a CCW profile, flip to invert)
      const sn = []; for (let k = 0; k < segs; k++) { const a = prof[k], b = prof[(k + 1) % np]; let nl = -(b[1] - a[1]), nu = b[0] - a[0]; const L = Math.hypot(nl, nu) || 1; nl /= L; nu /= L; if (flip) { nl = -nl; nu = -nu; } sn.push([nl, nu]); }
      const pn = []; for (let k = 0; k < np; k++) { const a = sn[(k - 1 + segs) % segs] , b = sn[Math.min(k, segs - 1)]; let nl, nu; if (!closed && k === 0) { nl = b[0]; nu = b[1]; } else if (!closed && k === np - 1) { nl = a[0]; nu = a[1]; } else { nl = a[0] + b[0]; nu = a[1] + b[1]; } const L = Math.hypot(nl, nu) || 1; pn.push([nl / L, nu / L]); }
      const base = [];
      for (let i = 0; i < rows.length; i++) {
        const R = rows[i], o = R.o, r = R.r, u = R.u; this.s = R.s !== undefined ? R.s : this.s; this.onRow(R);
        if (R.top !== undefined) this.top = R.top; if (R.gnd !== undefined) this.gnd = R.gnd;
        const b0 = this.count; base.push(b0);
        if (flat) {
          for (let k = 0; k < segs; k++) {
            const a = prof[k], b = prof[(k + 1) % np], nn = sn[k], col = Array.isArray(C[0]) ? C[k] : C;
            const nx = r[0] * nn[0] + u[0] * nn[1], ny = r[1] * nn[0] + u[1] * nn[1], nz = r[2] * nn[0] + u[2] * nn[1];
            this.v(o[0] + r[0] * a[0] + u[0] * a[1], o[1] + r[1] * a[0] + u[1] * a[1], o[2] + r[2] * a[0] + u[2] * a[1], nx, ny, nz, col);
            this.v(o[0] + r[0] * b[0] + u[0] * b[1], o[1] + r[1] * b[0] + u[1] * b[1], o[2] + r[2] * b[0] + u[2] * b[1], nx, ny, nz, col);
          }
        } else {
          for (let k = 0; k < np; k++) {
            const a = prof[k], nn = pn[k], col = Array.isArray(C[0]) ? C[Math.min(k, C.length - 1)] : C;
            const nx = r[0] * nn[0] + u[0] * nn[1], ny = r[1] * nn[0] + u[1] * nn[1], nz = r[2] * nn[0] + u[2] * nn[1];
            this.v(o[0] + r[0] * a[0] + u[0] * a[1], o[1] + r[1] * a[0] + u[1] * a[1], o[2] + r[2] * a[0] + u[2] * a[1], nx, ny, nz, col);
          }
        }
        if (i > 0) {
          const p0 = base[i - 1], p1 = b0;
          if (flat) for (let k = 0; k < segs; k++) { const a0 = p0 + 2 * k, a1 = p1 + 2 * k; if (flip) this.i.push(a0, a1, a0 + 1, a0 + 1, a1, a1 + 1); else this.i.push(a0, a0 + 1, a1, a0 + 1, a1 + 1, a1); }
          else for (let k = 0; k < segs; k++) { const k1 = (k + 1) % np, a0 = p0 + k, a1 = p1 + k, b0 = p0 + k1, b1 = p1 + k1; if (flip) this.i.push(a0, a1, b0, b0, a1, b1); else this.i.push(a0, b0, a1, b0, b1, a1); }
        }
      }
      this.top = 1e4; this.gnd = -1e4;
    }
    // end cap of a sweep profile at a row (a fan; the profile must be convex-ish), facing dir (+1 = along +s)
    onRow(R) {}                   // (TGB: the track frame of this row)
    capProfile(R, prof, C, dir) {
      this.onRow(R);
      const o = R.o, r = R.r, u = R.u, t = R.t; const n = [t[0] * dir, t[1] * dir, t[2] * dir];
      let cl = 0, cu = 0; for (const p of prof) { cl += p[0]; cu += p[1]; } cl /= prof.length; cu /= prof.length;
      const c0 = this.v(o[0] + r[0] * cl + u[0] * cu, o[1] + r[1] * cl + u[1] * cu, o[2] + r[2] * cl + u[2] * cu, n[0], n[1], n[2], C);
      const b = this.count; for (const p of prof) this.v(o[0] + r[0] * p[0] + u[0] * p[1], o[1] + r[1] * p[0] + u[1] * p[1], o[2] + r[2] * p[0] + u[2] * p[1], n[0], n[1], n[2], C);
      for (let k = 0; k < prof.length; k++) { const a = b + k, bb = b + (k + 1) % prof.length; if (dir > 0) this.i.push(c0, a, bb); else this.i.push(c0, bb, a); }
    }
    geometry() {
      if (!this.i.length) return null;
      const g = new THREE.BufferGeometry(), nv = this.count;
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3)); g.setAttribute('aM', new THREE.Float32BufferAttribute(this.m, 4));
      g.setAttribute('aT', new THREE.Float32BufferAttribute(this.t, 4));
      g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
      g.computeBoundingSphere(); stats.tris += this.i.length / 3; return g;
    }
  }

  // tunnel geometry builder: also writes, per vertex, the track tangent (aTan), the vertex's lateral / height in the track
  // frame (aLH) and the fixture line lighting it (aFix = lateral, height, spacing, phase). Set .ref = { o, r, u, t } (the
  // track centreline frame, chunk-local) before emitting; sweep() sets it per row from row.c (centreline) when present.
  class TGB extends GB {
    constructor() { super(); this.tan = []; this.lh = []; this.fx = []; this.ref = null; this.fix = [0, 0, 0, 0]; }
    v(x, y, z, nx, ny, nz, C) {
      const k = super.v(x, y, z, nx, ny, nz, C), R = this.ref;
      if (R) { const dx = x - R.o[0], dy = y - R.o[1], dz = z - R.o[2]; this.tan.push(R.t[0], R.t[1], R.t[2]); this.lh.push(dx * R.r[0] + dy * R.r[1] + dz * R.r[2], dx * R.u[0] + dy * R.u[1] + dz * R.u[2], 0, 0); }
      else { this.tan.push(1, 0, 0); this.lh.push(0, 0, 0, 0); }
      this.fx.push(this.fix[0], this.fix[1], this.fix[2], this.fix[3]); return k;
    }
    onRow(R) { this.ref = { o: R.c || R.o, r: R.r, u: R.u, t: R.t || [1, 0, 0] }; }
    geometry() {
      const g = super.geometry(); if (!g) return null;
      g.setAttribute('aTan', new THREE.Float32BufferAttribute(this.tan, 3)); g.setAttribute('aLH', new THREE.Float32BufferAttribute(this.lh, 4)); g.setAttribute('aFix', new THREE.Float32BufferAttribute(this.fx, 4));
      return g;
    }
  }

  // ---------------------------------------------------------------- procedural textures
  // concrete detail (tileable grey-scale, mean 0.5): R fine pores + aggregate speckle, G mottling / trowel, B blotches
  // (efflorescence, patches), A board-form grain (vertical streak texture for form-finished faces)
  function detailPainter(N, seed) {
    const r = U.rng(seed), M = N - 1, C = [0, 1, 2, 3].map(() => new Float32Array(N * N).fill(0.5));
    const vnoise = (a, cells, amp) => { const g = new Float32Array(cells * cells); for (let i = 0; i < g.length; i++) g[i] = r() * 2 - 1;
      for (let y = 0; y < N; y++) { const fy = y * cells / N, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty), r0 = (y0 % cells) * cells, r1 = ((y0 + 1) % cells) * cells;
        for (let x = 0; x < N; x++) { const fx = x * cells / N, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx), c0 = x0 % cells, c1 = (x0 + 1) % cells;
          a[y * N + x] += amp * ((g[r0 + c0] * (1 - sx) + g[r0 + c1] * sx) * (1 - sy) + (g[r1 + c0] * (1 - sx) + g[r1 + c1] * sx) * sy); } } };
    const grain = (a, amp) => { for (let i = 0; i < N * N; i++) a[i] += (r() * 2 - 1) * amp; };
    const disc = (a, cx, cy, rad, v) => { const R2 = Math.ceil(rad + 1); for (let dy = -R2; dy <= R2; dy++) for (let dx = -R2; dx <= R2; dx++) { const d = Math.hypot(dx, dy), w = Math.min(1, Math.max(0, rad + 0.5 - d)); if (w > 0) { const o = ((cy + dy) & M) * N + ((cx + dx) & M); a[o] += (v - a[o]) * w; } } };
    const pack = (sd) => { const d = new Uint8Array(N * N * 4);
      for (let c = 0; c < 4; c++) { const a = C[c]; let m = 0, v = 0; for (let i = 0; i < N * N; i++) m += a[i]; m /= N * N; for (let i = 0; i < N * N; i++) v += (a[i] - m) ** 2; const k = sd[c] / Math.sqrt(v / (N * N) || 1);
        for (let i = 0; i < N * N; i++) d[i * 4 + c] = Math.max(0, Math.min(255, Math.round(((a[i] - m) * k + 0.5) * 255))); }
      const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.colorSpace = THREE.NoColorSpace; try { t.anisotropy = Math.min(8, Env.renderer.capabilities.getMaxAnisotropy()); } catch (e) {} t.needsUpdate = true; return t; };
    return { N, M, r, C, vnoise, grain, disc, pack };
  }
  let concTex = null, ballTex = null;
  function concreteTexture() {
    if (concTex) return concTex;
    const { N, r, C, vnoise, grain, disc, pack } = detailPainter(512, 3301);
    { const a = C[0]; vnoise(a, 32, 0.05); grain(a, 0.06); for (let i = 0; i < 9000; i++) disc(a, Math.floor(r() * N), Math.floor(r() * N), 0.3 + r() * 0.9, r() < 0.55 ? 0.28 : 0.68);
      for (let i = 0; i < 900; i++) disc(a, Math.floor(r() * N), Math.floor(r() * N), 0.6 + r() * 1.2, 0.12); }        // bug holes
    { const a = C[1]; vnoise(a, 3, 0.12); vnoise(a, 9, 0.07); vnoise(a, 27, 0.04); }
    { const a = C[2]; vnoise(a, 5, 0.1); vnoise(a, 14, 0.07); vnoise(a, 40, 0.03); }                                      // patchiness (no discs: they read as circles)
    { const a = C[3]; for (let x = 0; x < N; x++) { const v = (r() - 0.5) * 0.3, w = (r() - 0.5) * 0.12; for (let y = 0; y < N; y++) a[y * N + x] += v + w * Math.sin(y / N * 6.283 * 3 + x); } vnoise(a, 16, 0.04); }
    return (concTex = pack([0.09, 0.1, 0.1, 0.06]));
  }
  // ballast: packed angular stones (granite greys, dark trap rock, a few warm ones) drawn on a canvas, tileable, mipmapped
  function ballastTexture() {
    if (ballTex) return ballTex;
    const S = 512, rnd = U.rng(71117), cv = document.createElement('canvas'); cv.width = cv.height = S; const c = cv.getContext('2d');
    c.fillStyle = '#2b2925'; c.fillRect(0, 0, S, S);
    const stones = [];
    for (let k = 0; k < 1300; k++) {
      const rr = 8 + rnd() * 11, el = 0.6 + rnd() * 0.38, rot = rnd() * 6.283, nv = 5 + Math.floor(rnd() * 4), pts = [];
      for (let i = 0; i < nv; i++) { const a = i / nv * 6.283 + (rnd() - 0.5) * 0.7, q = rr * (0.75 + rnd() * 0.3), lx = Math.cos(a) * q, ly = Math.sin(a) * q * el; pts.push([lx * Math.cos(rot) - ly * Math.sin(rot), lx * Math.sin(rot) + ly * Math.cos(rot)]); }
      const t = rnd(); let b; if (t < 0.6) { const g = 120 + rnd() * 50; b = [g + rnd() * 8, g + rnd() * 5, g - 4 + rnd() * 6]; } else if (t < 0.86) { const g = 80 + rnd() * 34; b = [g, g + 2, g + 5]; } else if (t < 0.95) b = [148 + rnd() * 30, 126 + rnd() * 22, 100 + rnd() * 20]; else b = [180 + rnd() * 30, 176 + rnd() * 30, 168 + rnd() * 26];
      stones.push({ x: rnd() * S, y: rnd() * S, r: rr, pts, b });
    }
    const draw = (st, X, Y) => { const path = () => { c.beginPath(); st.pts.forEach((p, i) => i ? c.lineTo(X + p[0], Y + p[1]) : c.moveTo(X + p[0], Y + p[1])); c.closePath(); };
      path(); c.fillStyle = `rgb(${st.b[0] | 0},${st.b[1] | 0},${st.b[2] | 0})`; c.fill();
      const g = c.createRadialGradient(X - st.r * 0.3, Y - st.r * 0.3, st.r * 0.1, X, Y, st.r * 1.1); g.addColorStop(0, 'rgba(255,255,255,0.12)'); g.addColorStop(0.55, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.45)');
      path(); c.fillStyle = g; c.fill(); c.strokeStyle = 'rgba(18,16,14,0.55)'; c.lineWidth = 1.2; path(); c.stroke(); };
    for (const st of stones) for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) { const X = st.x + dx, Y = st.y + dy; if (X > -30 && X < S + 30 && Y > -30 && Y < S + 30) draw(st, X, Y); }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    try { t.anisotropy = Math.min(8, Env.renderer.capabilities.getMaxAnisotropy()); } catch (e) {}
    const d = c.getImageData(0, 0, S, S).data; let mr = 0, mg = 0, mb = 0; const lin = (v) => Math.pow(v / 255, 2.2); for (let i = 0; i < d.length; i += 64) { mr += lin(d[i]); mg += lin(d[i + 1]); mb += lin(d[i + 2]); }
    const n = d.length / 64; t.userData.mean = new THREE.Vector3(mr / n, mg / n, mb / n);
    return (ballTex = t);
  }

  // ---------------------------------------------------------------- materials
  // One lit material family for all infrastructure: vertex colour + per-vertex roughness/metalness/kind, procedural
  // weathering by kind (triplanar concrete detail, rain streaks below top edges, base grime, efflorescence, rust on rail
  // sides, a polished running band on rail heads, ballast stones), wet surfaces in rain, lamps. Tunnel geometry uses the
  // TUNNEL variant: its own fixtures light it per fragment (the periodic light line of each tunnel, evaluated with the
  // engine's own BRDF, so rails glint and the lining shows light pools), on top of the Under patch that removes daylight.
  const uWet = { value: 0 }, uLampK = { value: 1 };
  const MATS = {};
  function infraMaterial(kind) {
    const tunnel = kind === 'tunnel', far = kind === 'far';
    const u = { uConc: { value: concreteTexture() }, uBall: { value: ballastTexture() }, uBallMean: { value: ballastTexture().userData.mean }, uWet, uNight: U.uNight, uTime: U.uTime, uLampK };
    if (far) u.uHide = { value: 0 };
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, envMapIntensity: 0.9 });
    m.userData.u = u;
    m.customProgramCacheKey = () => 'bl-metro-' + kind;
    if (tunnel) m.defines = { BL_TUNNEL: 1 }; else if (far) m.defines = { BL_FAR: 1 };
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aM; attribute vec4 aT; varying vec4 vM; varying vec4 vT; varying vec3 vWp; varying vec3 vWn;
          #ifdef BL_FAR
          uniform float uHide;
          #endif
          #ifdef BL_TUNNEL
          attribute vec3 aTan; attribute vec4 aLH; attribute vec4 aFix; varying vec3 vTan; varying vec4 vLH; varying vec4 vFix;
          #endif`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vM = aM; vT = aT;
          #ifdef BL_TUNNEL
          vTan = aTan; vLH = aLH; vFix = aFix;
          #endif`)
        .replace('#include <fog_vertex>', `#include <fog_vertex>
          #ifdef BL_FAR
          { int m = int(uHide + 0.5), j = int(aT.w + 0.5); if (m > 0 && j >= 0 && j < 16 && ((m >> j) & 1) == 1) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
          #endif`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          { vec4 wq = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
              wq = instanceMatrix * wq;
            #endif
            vWp = (modelMatrix * wq).xyz; vWn = normalize(mat3(modelMatrix) * objectNormal); }`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uConc; uniform sampler2D uBall; uniform vec3 uBallMean; uniform float uWet; uniform float uNight; uniform float uTime; uniform float uLampK;
          varying vec4 vM; varying vec4 vT; varying vec3 vWp; varying vec3 vWn;
          #ifdef BL_TUNNEL
          varying vec3 vTan; varying vec4 vLH; varying vec4 vFix;
          #endif
          float mh1(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
          float mn3(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(mh1(i), mh1(i + vec3(1, 0, 0)), f.x), mix(mh1(i + vec3(0, 1, 0)), mh1(i + vec3(1, 1, 0)), f.x), f.y),
                       mix(mix(mh1(i + vec3(0, 0, 1)), mh1(i + vec3(1, 0, 1)), f.x), mix(mh1(i + vec3(0, 1, 1)), mh1(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
          float mn1(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(fract(sin(i * 12.9898) * 43758.5453), fract(sin((i + 1.0) * 12.9898) * 43758.5453), f); }
          float gKind; float gRough; float gMetal; vec3 gEmis; float gBump; vec3 gBumpN;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            vec3 col = diffuseColor.rgb; float kind = floor(vM.z + 0.5); gKind = kind; gRough = vM.x; gMetal = vM.y; gEmis = vec3(0.0); gBump = 0.0; gBumpN = vec3(0.0);
            vec3 an = abs(vWn); float fw = fwidth(vWp.x) + fwidth(vWp.y) + fwidth(vWp.z);
            float dcam = distance(vWp, cameraPosition);
            #ifndef BL_FAR
            if (kind == 1.0 || kind == 10.0) {                      // concrete
              vec3 w3 = pow(an, vec3(6.0)); w3 /= dot(w3, vec3(1.0));
              vec2 pX = vWp.zy / 1.9, pY = vWp.xz / 1.9, pZ = vWp.xy / 1.9;
              vec4 dX = texture2D(uConc, pX), dY = texture2D(uConc, pY), dZ = texture2D(uConc, pZ);
              vec4 d = dX * w3.x + dY * w3.y + dZ * w3.z - 0.5;
              vec4 dL = (texture2D(uConc, pX * 0.13 + 0.37) * w3.x + texture2D(uConc, pY * 0.13 + 0.37) * w3.y + texture2D(uConc, pZ * 0.13 + 0.37) * w3.z) - 0.5;
              float fine = (1.0 - smoothstep(0.03, 0.2, fw)) * (kind == 10.0 ? 0.45 : 1.0);
              col *= 1.0 + d.r * 0.5 * fine + dL.g * 0.5 + d.g * 0.22 + dL.b * 0.28;
              // rain streaks and run-off below top edges, on the steep faces (a 1D noise along the face, stretched down)
              float steep = 1.0 - smoothstep(0.35, 0.7, an.y);
              vec2 fd = normalize(vec2(-vWn.z, vWn.x) + vec2(1e-4)); float h = dot(vWp.xz, fd);
              float band = 1.0 - smoothstep(0.08, 0.4, fw * 3.0);
              float streak = (mn1(h * 3.1 + mn1(vWp.y * 0.6) * 1.5) * 0.65 + mn1(h * 11.0) * 0.35) * band + 0.5 * (1.0 - band);
              float below = vT.y; float run = exp(-below / 2.4) * smoothstep(0.02, 0.3, below);
              col *= 1.0 - steep * run * (0.1 + 0.34 * smoothstep(0.45, 0.85, streak)) * vM.w * 1.6;
              col = mix(col, col * vec3(0.93, 0.95, 0.88), steep * run * smoothstep(0.5, 0.9, streak) * 0.5);
              // base grime / splash and a little green where it stays damp
              float base = exp(-vT.z / 0.55) * (1.0 - an.y * 0.5);
              col *= 1.0 - 0.3 * base; col = mix(col, col * vec3(0.88, 0.94, 0.82), base * 0.4);
              // efflorescence and patches (bright blotches) on some faces
              col = mix(col, col * vec3(1.1, 1.08, 1.04), smoothstep(0.55, 0.8, dL.b + 0.5) * 0.35 * steep);
              gRough = clamp(vM.x + d.g * 0.2, 0.3, 1.0);
              gBump = d.r * fine;
              if (kind == 10.0) col *= 0.92;                        // tunnel lining: soot
            } else if (kind == 2.0) {                              // rail side / web / foot: rust
              float n = mn3(vWp * vec3(1.7, 6.0, 1.7)) * 0.6 + mn3(vWp * 9.0) * 0.4;
              col *= 0.8 + 0.45 * n; col = mix(col, col * vec3(1.15, 0.78, 0.55), smoothstep(0.55, 0.8, n) * 0.45);
              gRough = clamp(vM.x + (n - 0.5) * 0.25, 0.3, 0.95); gMetal = vM.y * (1.0 - 0.5 * smoothstep(0.5, 0.8, n));
            } else if (kind == 3.0) {                              // rail head: polished running band (ground / scuffed)
              float n = mn3(vWp * vec3(9.0, 40.0, 9.0));
              col *= 0.9 + 0.2 * n; gRough = clamp(vM.x + (n - 0.5) * 0.12, 0.06, 0.4);
            } else if (kind == 4.0) {                              // ballast stones (world-planar, two rotated scales)
              vec2 q = vWp.xz; vec2 uA = q / 1.25, uB = mat2(0.8, -0.6, 0.6, 0.8) * q / 1.41 + vec2(0.31, 0.77);
              float mm = smoothstep(0.35, 0.65, mn3(vec3(q * 0.35, 0.0)));
              vec3 tc = mix(texture2D(uBall, uA).rgb, texture2D(uBall, uB).rgb, mm) / uBallMean;
              col *= tc; float rust = smoothstep(0.35, 0.0, abs(abs(vT.w) - 0.87)) * step(0.0, vT.w);
              col *= 0.94 + 0.12 * mn3(vec3(q * 0.2, 1.0));
            } else if (kind == 11.0) {                             // bolted steel rings (Market St): a flange rib every 0.762 m
              float fs = fwidth(vT.x) + 1e-4, dr = abs(fract(vT.x / 0.762 + 0.5) - 0.5) * 0.762;
              float rib = 1.0 - smoothstep(0.018, 0.018 + fs * 1.5, dr), bolts = (1.0 - smoothstep(0.03, 0.03 + fs * 1.5, abs(dr - 0.09))) * step(0.5, fract(vT.y * 0.0 + dot(vWp, vec3(2.3, 2.9, 2.3))));
              float n = mn3(vWp * vec3(1.3, 3.0, 1.3)) * 0.6 + mn3(vWp * 7.0) * 0.4;
              col *= 0.78 + 0.35 * n; col = mix(col, col * vec3(1.12, 0.84, 0.66), smoothstep(0.6, 0.85, n) * 0.5);
              col *= 1.0 - 0.45 * rib * (1.0 - smoothstep(0.1, 0.4, fs * 8.0)); gBump = (rib * 0.8 + bolts * 0.2) * (1.0 - smoothstep(0.02, 0.1, fw));
              gRough = clamp(vM.x + (n - 0.5) * 0.2, 0.3, 0.95);
            } else if (kind == 7.0) {                              // galvanised: spangle and dulling
              float n = mn3(vWp * 4.0); col *= 0.88 + 0.24 * n; gRough = clamp(vM.x + (n - 0.5) * 0.2, 0.2, 0.8);
            } else if (kind == 8.0) {                              // fibreglass coverboard: weathered, dirtier low down
              float n = mn3(vWp * vec3(2.0, 8.0, 2.0)); col *= 0.85 + 0.25 * n; col *= 1.0 - 0.25 * exp(-vT.y / 0.08) * 0.0;
            }
            #endif
            if (kind == 5.0) { float lum = dot(col, vec3(0.2126, 0.7152, 0.0722)); gEmis = col * (lum > 0.5 ? 22.0 : 3.5) * uLampK; col *= 0.3; }   // lamps (always lit; coloured ones dimmer)
            else if (kind == 6.0) { gEmis = col * 7.0 * uNight; col *= mix(1.0, 0.3, uNight); }                // lit at night
            // wet: rain darkens and glosses what faces the sky
            float wetK = uWet * smoothstep(0.5, 0.9, an.y) * (kind == 1.0 || kind == 4.0 || kind == 8.0 ? 1.0 : 0.6);
            col *= 1.0 - 0.35 * wetK; gRough = mix(gRough, 0.08, wetK * 0.85);
            diffuseColor.rgb = col;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = gRough;`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
          metalnessFactor = gMetal;`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          #ifndef BL_FAR
          if (gBump != 0.0) { vec3 pos = -vViewPosition; vec3 sx = dFdx(pos), sy = dFdy(pos); float hx = dFdx(gBump) * 0.006, hy = dFdy(gBump) * 0.006;
            vec3 r1 = cross(sy, normal), r2 = cross(normal, sx); float det = dot(sx, r1); vec3 grad = sign(det) * (hx * r1 + hy * r2); normal = normalize(abs(det) * normal - grad); }
          #endif`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += gEmis;`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          #ifdef BL_TUNNEL
          // the tunnel's own light line: fixtures every vFix.z m (phase vFix.w) at (lateral vFix.x, height vFix.y) in the
          // track frame; this fragment is at (s = vT.x, lateral vLH.x, height vLH.y). The three nearest fixtures, lit with
          // the engine's BRDF (so the rails and wet floors catch them), a small sphere light each (roughness widened).
          if (vFix.z > 0.5) {
            vec3 T = normalize(vTan), Rt = normalize(cross(T, vec3(0.0, 1.0, 0.0))), Ut = cross(Rt, T);
            float k0 = floor((vT.x - vFix.w) / vFix.z + 0.5);
            for (int j = -1; j <= 1; j++) {
              float sk = vFix.w + (k0 + float(j)) * vFix.z;
              vec3 dW = T * (sk - vT.x) + Rt * (vFix.x - vLH.x) + Ut * (vFix.y - vLH.y);
              float d = length(dW); if (d > 26.0) continue;
              vec3 Lv = normalize((viewMatrix * vec4(dW / max(d, 1e-3), 0.0)).xyz);
              IncidentLight fl; fl.direction = Lv; fl.visible = true;
              float att = 1.0 / max(d * d, 0.35) * pow(clamp(1.0 - pow(d / 26.0, 4.0), 0.0, 1.0), 2.0);
              fl.color = vec3(1.0, 0.95, 0.86) * (2.6 * att * uLampK);      // ~7500 lm (LED retrofit): ~150 lux at 2 m
              RE_Direct(fl, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
            }
          }
          #endif`);
    };
    return m;
  }
  function fenceMaterial() {
    const tex = U.canvasTexture(128, 128, (c, w, h) => { c.clearRect(0, 0, w, h); c.strokeStyle = '#fff'; c.lineWidth = 6; c.lineCap = 'round';
      c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w / 2, 0); c.lineTo(w, h / 2); c.lineTo(w / 2, h); c.closePath(); c.stroke(); }, { repeat: true, aniso: 8, srgb: false });
    const m = new THREE.MeshStandardMaterial({ color: 0x8a8f93, roughness: 0.45, metalness: 0.6, alphaMap: tex, alphaTest: 0.5, side: THREE.DoubleSide, alphaToCoverage: true });
    m.customProgramCacheKey = () => 'bl-metro-fence';
    m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        { float fwu = fwidth(vAlphaMapUv.x) + fwidth(vAlphaMapUv.y); diffuseColor.a = mix(diffuseColor.a, 0.16, smoothstep(0.05, 0.25, fwu)); }`); };
    return m;
  }

  // ---------------------------------------------------------------- network access
  let net = null, ready = false;
  const TRACKS = [];                       // { t (MetroNet track), id, len, chunks: [], pair: Int32Array per bin, ... }
  const TI = new Map();                    // MetroNet track -> my record
  const F0 = {};
  // my frame: Catmull-Rom position between MetroNet samples (smooth rails on curves), tangent from its derivative, banked
  // right/up like MetroNet.frame (cant > 0: right rail lower). Also the unbanked (level) right/up for structures.
  function frameAt(T, s, o = {}) {
    const t = T.t || T, X = t.X, Y = t.Y, Z = t.Z, n = X.length, st = t.step;
    let f = s / st; if (f < 0) f = 0; if (f > n - 1.000001) f = n - 1.000001;
    const i = f | 0, a = f - i, i0 = i > 0 ? i - 1 : 0, i2 = i + 1, i3 = i + 2 < n ? i + 2 : n - 1;
    const cr = (p0, p1, p2, p3) => { const a2 = a * a, a3 = a2 * a; return 0.5 * (2 * p1 + (-p0 + p2) * a + (2 * p0 - 5 * p1 + 4 * p2 - p3) * a2 + (-p0 + 3 * p1 - 3 * p2 + p3) * a3); };
    const cd = (p0, p1, p2, p3) => 0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * a + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * a * a);
    o.x = cr(X[i0], X[i], X[i2], X[i3]); o.y = cr(Y[i0], Y[i], Y[i2], Y[i3]); o.z = cr(Z[i0], Z[i], Z[i2], Z[i3]);
    let tx = cd(X[i0], X[i], X[i2], X[i3]), ty = cd(Y[i0], Y[i], Y[i2], Y[i3]), tz = cd(Z[i0], Z[i], Z[i2], Z[i3]);
    const L = Math.hypot(tx, ty, tz) || 1; tx /= L; ty /= L; tz /= L;
    let ux = -tx * ty, uy = 1 - ty * ty, uz = -tz * ty; const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    let rx = ty * uz - tz * uy, ry = tz * ux - tx * uz, rz = tx * uy - ty * ux; const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const cant = t.CA ? t.CA[i] + (t.CA[i + 1 < n ? i + 1 : i] - t.CA[i]) * a : 0, bank = Math.asin(U.clamp(cant / 1.75, -0.2, 0.2)), cb = Math.cos(bank), sb = Math.sin(bank);
    o.tx = tx; o.ty = ty; o.tz = tz;
    o.lx = rx; o.ly = ry; o.lz = rz; o.vx = ux; o.vy = uy; o.vz = uz;                                  // level frame (structures)
    o.rx = rx * cb - ux * sb; o.ry = ry * cb - uy * sb; o.rz = rz * cb - uz * sb;                      // banked frame (track)
    o.ux = ux * cb + rx * sb; o.uy = uy * cb + ry * sb; o.uz = uz * cb + rz * sb;
    o.cant = cant; o.bank = bank; o.s = f * st; const k = a < 0.5 ? i : i + 1; o.struct = t.ST ? t.ST[k] : 0; o.cover = t.CV ? t.CV[k] : 0;
    return o;
  }
  const STRUCT = ['grade', 'aerial', 'bridge', 'embankment', 'trench', 'median', 'portal', 'cutcover', 'bored', 'tube'];
  const UNDERGROUND = new Set(['portal', 'cutcover', 'bored', 'tube']);
  // structure runs of a track: [{ s0, s1, type }] from the per-sample codes, short flickers (< 12 m) merged away
  function runsOf(t) {
    const out = []; const n = t.X.length, st = t.step;
    let cur = t.ST[0], s0 = 0;
    for (let i = 1; i <= n; i++) { const c = i < n ? t.ST[i] : -1; if (c !== cur) { out.push({ s0, s1: Math.min((i - 0.5) * st, t.length), type: STRUCT[cur] || 'grade' }); cur = c; s0 = (i - 0.5) * st; } }
    for (let k = 1; k < out.length - 1; k++) if (out[k].s1 - out[k].s0 < 12 && out[k - 1].type === out[k + 1].type) { out[k - 1].s1 = out[k + 1].s1; out.splice(k, 2); k--; }
    return out;
  }
  // pairing: per 10 m bin the nearest parallel track within 7.5 m (id, its s, lateral offset in my level frame, +right)
  const BIN = 10;
  function pairTracks() {
    const cell = 40, grid = new Map(), key = (i, j) => i * 100003 + j;
    for (const R of TRACKS) { const t = R.t; for (let i = 0; i < t.X.length; i += 2) { const k = key(Math.floor(t.X[i] / cell), Math.floor(t.Z[i] / cell)); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(R.k, i); } }
    for (const R of TRACKS) {
      const t = R.t, nb = Math.ceil(t.length / BIN) + 1; R.pairT = new Int16Array(nb).fill(-1); R.pairS = new Float32Array(nb); R.pairL = new Float32Array(nb); R.pairDy = new Float32Array(nb); R.nbrL = new Float32Array(nb);
      for (let b = 0; b < nb; b++) {
        const s = Math.min(t.length, b * BIN); frameAt(R, s, F0);
        const cx = Math.floor(F0.x / cell), cz = Math.floor(F0.z / cell); let best = -1, bl = 7.6, bs = 0, bdy = 0, nbl = 22.5;
        for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
          const l = grid.get(key(cx + a, cz + c)); if (!l) continue;
          for (let q = 0; q < l.length; q += 2) {
            const R2 = TRACKS[l[q]]; if (R2 === R) continue; const t2 = R2.t, j = l[q + 1];
            for (let jj = Math.max(0, j - 2); jj <= Math.min(t2.X.length - 2, j + 1); jj++) {
              const ax = t2.X[jj], az = t2.Z[jj], dx = t2.X[jj + 1] - ax, dz = t2.Z[jj + 1] - az, L2 = dx * dx + dz * dz || 1e-9;
              const uu = U.clamp(((F0.x - ax) * dx + (F0.z - az) * dz) / L2, 0, 1), px = ax + dx * uu, pz = az + dz * uu;
              const along = (px - F0.x) * F0.tx + (pz - F0.z) * F0.tz; if (Math.abs(along) > 1.5) continue;
              const par = Math.abs(dx * F0.tx + dz * F0.tz) / Math.sqrt(L2); if (par < 0.97) continue;
              const lat = (px - F0.x) * F0.lx + (pz - F0.z) * F0.lz;
              if (Math.abs(lat) > 2.5 && Math.abs(lat) < Math.abs(nbl)) nbl = lat;
              if (Math.abs(lat) < Math.abs(bl) && Math.abs(lat) > 2.5) { bl = lat; best = R2.k; bs = (jj + uu) * t2.step; bdy = (t2.Y[jj] + (t2.Y[jj + 1] - t2.Y[jj]) * uu) - F0.y; }
            }
          }
        }
        if (best >= 0) { R.pairT[b] = best; R.pairS[b] = bs; R.pairL[b] = bl; R.pairDy[b] = bdy; }
        R.nbrL[b] = Math.abs(nbl) < 22.5 ? nbl : 0;
      }
    }
    // primary: the lexically smaller id of a pair builds the shared structure
    for (const R of TRACKS) { R.primary = new Uint8Array(R.pairT.length); for (let b = 0; b < R.pairT.length; b++) { const p = R.pairT[b]; R.primary[b] = p < 0 || R.id < TRACKS[p].id ? 1 : 0; } }
  }
  // the nearest parallel track within 22 m (e.g. the other bore of a twin-bore tunnel): its lateral (+ right), or 0
  function nbrAt(R, s) { const b = U.clamp(Math.round(s / BIN), 0, R.nbrL.length - 1); return R.nbrL[b]; }
  function pairAt(R, s) { const b = U.clamp(Math.round(s / BIN), 0, R.pairT.length - 1); const p = R.pairT[b]; return p < 0 ? null : { R2: TRACKS[p], s2: R.pairS[b], lat: pairLatAt(R, s, p), dy: R.pairDy[b], primary: !!R.primary[b] }; }
  // the partner's lateral at s, interpolated between the 10 m bins (cm-accurate on smooth curves)
  function pairLatAt(R, s, p) { const f = U.clamp(s / BIN, 0, R.pairT.length - 1.001), i = Math.floor(f), a = f - i;
    const l0 = R.pairT[i] === p ? R.pairL[i] : null, l1 = R.pairT[i + 1] === p ? R.pairL[i + 1] : null;
    return l0 !== null && l1 !== null ? l0 + (l1 - l0) * a : l0 !== null ? l0 : l1 !== null ? l1 : R.pairL[Math.round(f)]; }
  // station ranges on a track (STATIONS builds the box / deck / trackway there; I build rails and third rail through)
  // (MetroStations.limits when STATIONS provides it; else the platform ranges, normalised like STATIONS does: v0 puts the
  // two faces of an island up to ~200 m apart, so every track of a station takes the first platform's range, projected)
  function stationRanges(R) {
    const out = [];
    if (typeof MetroStations !== 'undefined' && MetroStations.limits) { try { for (const st of net.stations) for (const l of MetroStations.limits(st.id) || []) if (l.track === R.id) out.push({ s0: l.s0, s1: l.s1, st, side: null }); } catch (e) {} }
    if (out.length) return out;
    for (const st of net.stations) {
      const pl = (st.platforms || []).filter(p => TRACKS.some(T => T.id === p.track)); if (!pl.length) continue;
      const ref = pl[0], Rr = TRACKS.find(T => T.id === ref.track), a0 = Math.min(ref.s0, ref.s1), a1 = Math.max(ref.s0, ref.s1);
      for (const p of pl) {
        if (p.track !== R.id) continue;
        let s0 = Math.min(p.s0, p.s1), s1 = Math.max(p.s0, p.s1);
        if (p !== ref && Rr) { frameAt(Rr, a0, F0); const q0 = projectS(R, F0.x, F0.z, p.s); frameAt(Rr, a1, F0); const q1 = projectS(R, F0.x, F0.z, p.s);
          if (q0 !== null && q1 !== null) { s0 = Math.min(q0, q1); s1 = Math.max(q0, q1); } }
        out.push({ s0: s0 - 12, s1: s1 + 12, st, side: p.side, type: st.type });
      }
    }
    return out;
  }
  // s on track R nearest to world (x, z), within ±600 m of sHint and 25 m of the track, or null
  function projectS(R, x, z, sHint) {
    const t = R.t, n = t.X.length, st = t.step; let bd = 625, bs = null;
    for (let i = Math.max(0, Math.floor((sHint - 600) / st)); i <= Math.min(n - 2, Math.ceil((sHint + 600) / st)); i++) {
      const ax = t.X[i], az = t.Z[i], dx = t.X[i + 1] - ax, dz = t.Z[i + 1] - az, L2 = dx * dx + dz * dz || 1e-9, u = U.clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
      const d = (ax + dx * u - x) ** 2 + (az + dz * u - z) ** 2; if (d < bd) { bd = d; bs = (i + u) * st; } }
    return bs;
  }
  function inStation(R, s, pad = 0) { for (const r of R.stations) if (s > r.s0 - pad && s < r.s1 + pad) return r; return null; }
  // third rail side (+1 right, -1 left) at s: away from the platform in stations, else the outside of a pair (the field
  // side), else right. BART alternates the side around crossovers; the data can override with a per-track array later.
  function thirdSide(R, s) {
    const st = inStation(R, s, 60); if (st && st.side) return st.side === 'right' ? -1 : 1;
    const nb = nbrAt(R, s); if (nb) return nb > 0 ? -1 : 1;
    return 1;
  }

  // ---------------------------------------------------------------- chunks, layers, jobs
  // Each layer cuts every track into its own chunk length: DETAIL 400 m (≤ 480 m away), BODY 800 m (≤ 2.7 km), FAR 2 km
  // (≤ 11 km; five 400 m sub-pieces that hide themselves, per mesh, where a BODY chunk is already drawn).
  const LAYERS = { detail: { CH: 400, R: 480, keep: 1.35 }, body: { CH: 800, R: 2700, keep: 1.25 }, far: { CH: 2000, R: 11000, keep: 1.12, SUB: 400 } };
  const R_DETAIL = LAYERS.detail.R, R_BODY = LAYERS.body.R, R_FAR = LAYERS.far.R, CH = LAYERS.detail.CH, BUDGET = 3.2;
  const grids = { detail: new Map(), body: new Map(), far: new Map() }, CG = 1000;
  const built = { detail: new Set(), body: new Set(), far: new Set() };          // chunks with a group or a job
  function planChunks() {
    for (const R of TRACKS) {
      R.L = {};
      for (const layer of ['detail', 'body', 'far']) {
        const LC = LAYERS[layer].CH, t = R.t, nch = Math.max(1, Math.ceil(t.length / LC)), arr = R.L[layer] = [];
        for (let k = 0; k < nch; k++) {
          const s0 = k * LC, s1 = Math.min(t.length, (k + 1) * LC);
          let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9, y0 = 1e9, y1 = -1e9;
          for (let s = s0; ; s = Math.min(s1, s + 25)) { frameAt(R, s, F0); x0 = Math.min(x0, F0.x); x1 = Math.max(x1, F0.x); z0 = Math.min(z0, F0.z); z1 = Math.max(z1, F0.z); y0 = Math.min(y0, F0.y); y1 = Math.max(y1, F0.y); if (s >= s1) break; }
          frameAt(R, (s0 + s1) / 2, F0);
          const ch = { R, layer, k, s0, s1, ox: Math.round(F0.x), oz: Math.round(F0.z), bb: [x0 - 30, y0 - 40, z0 - 30, x1 + 30, y1 + 15, z1 + 30], g: null, job: null, d: 1e9, failed: 0, cells: [], mask: 0 };
          arr.push(ch);
          const G = grids[layer];
          for (let i = Math.floor(ch.bb[0] / CG); i <= Math.floor(ch.bb[3] / CG); i++) for (let j = Math.floor(ch.bb[2] / CG); j <= Math.floor(ch.bb[5] / CG); j++) { const key = i * 100003 + j; let l = G.get(key); if (!l) G.set(key, l = []); l.push(ch); }
        }
      }
      R.chunks = R.L.detail;                                                      // (debug / legacy)
    }
  }
  const jobs = [];
  function runJobs() {
    const t0 = performance.now(); jobs.sort((a, b) => a.d - b.d);
    while (jobs.length && performance.now() - t0 < BUDGET) {
      const j = jobs[0]; let r;
      try { r = j.gen.next(); } catch (e) { console.error('metrotrack job', j.ch.layer, j.ch.R.id, j.ch.k, e); r = { done: true }; j.ch.failed++; j.ch.job = null; }
      if (r.done) jobs.shift();
    }
    stats.buildMs = +(performance.now() - t0).toFixed(2); stats.jobs = jobs.length;
  }
  function dropJob(ch) { for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].ch === ch) jobs.splice(i, 1); ch.job = null; if (!ch.g) built[ch.layer].delete(ch); }
  function disposeChunk(ch) {
    const g = ch.g; if (g) { group.remove(g);
      g.traverse(o => { if (o.geometry) { stats.tris -= (o.geometry.index ? o.geometry.index.count : 0) / 3; o.geometry.dispose(); } if (o.material && ch.layer === 'far') o.material.dispose(); if (typeof Under !== 'undefined' && Under.enabled) Under.outdoor(o, false); }); }
    ch.g = null;
    if (ch.layer === 'body') {
      if (typeof MetroTube !== 'undefined') MetroTube.dropCells(ch);
      if (typeof Under !== 'undefined' && Under.enabled) for (const id of ch.cutIds || []) Under.remove(id);
      ch.cutIds = [];
    }
    built[ch.layer].delete(ch);
  }
  // a layer's meshes: one group positioned at the chunk origin; builders fill GBs keyed by material
  function makeLayer(ch, name) { const g = new THREE.Group(); g.position.set(ch.ox, 0, ch.oz); g.name = 'metro-' + name + '-' + ch.R.id + '-' + ch.k; g.userData.ch = ch; return g; }
  function addMesh(g, gb, mat, opt = {}) {
    const geo = gb.geometry(); if (!geo) return null;
    if (gb.extra) for (const [name, arr, size] of gb.extra) geo.setAttribute(name, new THREE.Float32BufferAttribute(arr, size));
    const m = new THREE.Mesh(geo, mat); m.castShadow = opt.shadow !== false; m.receiveShadow = true; m.matrixAutoUpdate = false; m.updateMatrix(); g.add(m); return m;
  }
  // context handed to the structure builders
  function ctxFor(ch, layer) {
    return { ch, R: ch.R, layer, ox: ch.ox, oz: ch.oz, s0: ch.s0, s1: ch.s1, DIM, PAL, GB, frameAt, pairAt, inStation, thirdSide, rowsAt, sampleS, groundAt, net };
  }
  // sample positions along [s0, s1]: every `step` m on straights, denser on curves and vertical curves (smooth sweeps)
  function sampleS(R, s0, s1, step = 5, minStep = 1.2, force = []) {
    const out = [s0]; let s = s0; const fa = {}, fb = {};
    frameAt(R, s, fa);
    while (s < s1 - 1e-3) {
      let h = Math.min(step, s1 - s);
      for (let tries = 0; tries < 5; tries++) {
        frameAt(R, s + h, fb); const dth = Math.acos(U.clamp(fa.tx * fb.tx + fa.ty * fb.ty + fa.tz * fb.tz, -1, 1));
        if (dth < 0.0045 || h <= minStep) break; h = Math.max(minStep, h * 0.5);
      }
      for (const f of force) if (f > s + 0.05 && f < s + h - 0.05) h = f - s;
      s += h; if (s > s1) s = s1; out.push(s); frameAt(R, s, fa);
    }
    return out;
  }
  // rows for GB.sweep: origin at lateral `lat` (level frame) and height `dy` above top of rail, local to the chunk
  function rowsAt(ctx, ss, lat = 0, dy = 0, banked = false, extra) {
    const out = []; const F = {};
    for (const s of ss) {
      frameAt(ctx.R, s, F);
      const r = banked ? [F.rx, F.ry, F.rz] : [F.lx, F.ly, F.lz], u = banked ? [F.ux, F.uy, F.uz] : [F.vx, F.vy, F.vz];
      const row = { s, o: [F.x + r[0] * lat + u[0] * dy - ctx.ox, F.y + r[1] * lat + u[1] * dy, F.z + r[2] * lat + u[2] * dy - ctx.oz], c: [F.x - ctx.ox, F.y, F.z - ctx.oz], r, u, t: [F.tx, F.ty, F.tz], F: Object.assign({}, F) };
      if (extra) extra(row, F);
      out.push(row);
    }
    return out;
  }
  // the ground (base surface, like streets and landmarks) under a world point; NaN-safe
  function groundAt(x, z) { const h = Terrain.hBase ? Terrain.hBase(x, z) : Terrain.h(x, z); return isFinite(h) ? h : 0; }

  function* bodyJob(ch) {
    const g = makeLayer(ch, 'body'), ctx = ctxFor(ch, 'body');
    const B = { infra: new GB(), tunnel: new GB(), fence: null };
    ctx.B = B; ch.cells = [];
    for (const run of ch.R.runs) {
      if (run.s1 <= ch.s0 || run.s0 >= ch.s1) continue;
      const a = Math.max(run.s0, ch.s0), b = Math.min(run.s1, ch.s1);
      if (UNDERGROUND.has(run.type)) { if (typeof MetroTube !== 'undefined') MetroTube.body(ctx, run, a, b); }
      else if (typeof MetroGuide !== 'undefined') MetroGuide.body(ctx, run, a, b);
      yield;
    }
    const mi = addMesh(g, B.infra, MATS.infra); if (mi) outdoorMark(ch, mi);
    if (B.fence) { const fm = B.fence.mesh(MATS.fence); if (fm) { g.add(fm); outdoorMark(ch, fm); } }
    if (typeof MetroTube !== 'undefined') MetroTube.finish(ctx, g);
    ch.g = g; ch.job = null; g.visible = false; group.add(g);
    if (typeof MetroTube !== 'undefined') MetroTube.commitCells(ch);
  }
  // meshes of a chunk that are outdoors: hidden with the outdoor world when the camera is deep underground (Under)
  function outdoorMark(ch, m) { if (typeof Under !== 'undefined' && Under.enabled) { Under.outdoor(m, true); (ch.outdoor || (ch.outdoor = [])).push(m); } }
  function* detailJob(ch) {
    const g = makeLayer(ch, 'detail'), ctx = ctxFor(ch, 'detail');
    const B = { infra: new GB(), tunnel: new TGB() }; ctx.B = B;
    if (typeof MetroGuide !== 'undefined') { for (const step of MetroGuide.detail(ctx)) yield; }
    const mi = addMesh(g, B.infra, MATS.infra, { shadow: true }); if (mi) outdoorMark(ch, mi);
    if (B.tunnel.count) addMesh(g, B.tunnel, MATS.tunnel, { shadow: false });
    ch.g = g; ch.job = null; g.visible = false; group.add(g);
  }
  function* farJob(ch) {
    const g = makeLayer(ch, 'far'), ctx = ctxFor(ch, 'far'); const B = { infra: new GB() }; ctx.B = B;
    if (typeof MetroGuide !== 'undefined') MetroGuide.far(ctx, LAYERS.far.SUB);
    yield;
    const mat = infraMaterial('far'); ch.mat = mat;                              // (its own uHide mask; the program is shared)
    const m = addMesh(g, B.infra, mat, { shadow: false }); if (m) { m.castShadow = false; outdoorMark(ch, m); }
    ch.g = g; ch.job = null; g.visible = false; group.add(g);
  }

  // ---------------------------------------------------------------- per frame
  // QA camera: MetroTrack.shot(trackId, s, lat, up, target) places the camera in a track's level frame (lat right, up
  // above top of rail) looking at target = { ds, lat, up } in the same frame (or a world point [x, y, z]); applied every
  // frame after the player (works underground, where fly mode clamps to the ground). MetroTrack.shot(null) releases it.
  let dbgCam = null; const _dc = {};
  function shot(id, s, lat = 0, up = 1.7, tgt = { ds: 30, lat: 0, up: 1.5 }, fov) {
    if (id === null) { dbgCam = null; return; }
    let pos, look;
    if (Array.isArray(id)) { pos = id; look = Array.isArray(tgt) ? tgt : [id[0], id[1], id[2] - 10]; }          // world positions
    else {
      const R = TRACKS.find(r => r.id === id); if (!R) return 'no track ' + id;
      const at = (ss, la, uu) => { frameAt(R, ss, _dc); return [_dc.x + _dc.lx * la + _dc.vx * uu, _dc.y + _dc.ly * la + _dc.vy * uu, _dc.z + _dc.lz * la + _dc.vz * uu]; };
      pos = at(s, lat, up); look = Array.isArray(tgt) ? tgt : at(s + (tgt.ds || 0), tgt.lat || 0, tgt.up || 0);
    }
    dbgCam = { pos, look, fov: fov || 0 };
    // move the player's fly camera there too, so the terrain and the world stream for this spot (Terrain.update runs
    // before this override every frame)
    if (typeof Player !== 'undefined' && Player.fly) { if (Player.mode !== 'fly') Player.setMode('fly'); Player.fly.x = pos[0]; Player.fly.z = pos[2]; Player.fly.y = pos[1]; }
    return { pos: pos.map(v => +v.toFixed(1)), look: look.map(v => +v.toFixed(1)) };
  }
  function applyShot() {
    if (!dbgCam) return; const c = Env.camera;
    c.position.set(dbgCam.pos[0], dbgCam.pos[1], dbgCam.pos[2]); c.up.set(0, 1, 0); c.lookAt(dbgCam.look[0], dbgCam.look[1], dbgCam.look[2]);
    if (dbgCam.fov) { c.fov = dbgCam.fov; c.updateProjectionMatrix(); } c.near = 0.1; c.updateProjectionMatrix(); c.updateMatrixWorld();
  }
  const nearSets = { detail: new Set(), body: new Set(), far: new Set() };
  function chunkDist(ch, p) { const b = ch.bb; const dx = Math.max(b[0] - p.x, 0, p.x - b[3]), dy = Math.max(b[1] - p.y, 0, p.y - b[4]), dz = Math.max(b[2] - p.z, 0, p.z - b[5]); return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  function gather(layer, p) {
    const set = nearSets[layer]; set.clear(); const G = grids[layer], rr = Math.ceil(LAYERS[layer].R * LAYERS[layer].keep / CG), ci = Math.floor(p.x / CG), cj = Math.floor(p.z / CG);
    for (let a = -rr; a <= rr; a++) for (let b = -rr; b <= rr; b++) { const l = G.get((ci + a) * 100003 + (cj + b)); if (l) for (const ch of l) set.add(ch); }
    for (const ch of set) ch.d = chunkDist(ch, p);
    return set;
  }
  function schedule(ch, gen, dExtra) { ch.job = gen; built[ch.layer].add(ch); jobs.push({ gen, ch, d: ch.d + dExtra }); }
  function update(camPos, dt) {
    applyShot();
    if (!ready) return;
    // wetness follows the rain (dries slowly)
    const rain = typeof Precip !== 'undefined' && Precip.state && Precip.state.kind === 'rain' ? Precip.state.rate : 0;
    uWet.value = U.clamp(uWet.value + (rain > 0.05 ? dt / 40 : -dt / 900), 0, 1);
    let nFar = 0, nBody = 0, nDet = 0;
    // BODY: structures, tunnels, beds (after the fine terrain under them is in)
    for (const ch of gather('body', camPos)) {
      if (ch.failed > 2) continue; const d = ch.d;
      if (d < R_BODY && !ch.g && !ch.job) { const b = ch.bb;
        if (Terrain.hasDetail(b[0], b[2], b[3], b[5], 7)) schedule(ch, bodyJob(ch), 0); else if (!ch.ensured) { ch.ensured = true; Terrain.ensure(b[0], b[2], b[3], b[5], 2, 7); } }
      if (ch.g) { ch.g.visible = d < R_BODY * 1.08; if (ch.g.visible) nBody++; }
    }
    // DETAIL: rails, plinths, third rail
    for (const ch of gather('detail', camPos)) {
      if (ch.failed > 2) continue; const d = ch.d;
      if (d < R_DETAIL && !ch.g && !ch.job) schedule(ch, detailJob(ch), 60);
      if (ch.g) { ch.g.visible = d < R_DETAIL * 1.15; if (ch.g.visible) nDet++; }
    }
    // FAR: silhouettes of aerials, bridges, embankments; each 400 m piece hides where a body chunk shows
    const SUB = LAYERS.far.SUB, BC = LAYERS.body.CH;
    for (const ch of gather('far', camPos)) {
      if (ch.failed > 2 || !ch.R.hasSil[ch.k]) continue; const d = ch.d;
      if (d < R_FAR && d > R_BODY * 0.5 && !ch.g && !ch.job) schedule(ch, farJob(ch), 500 + d * 0.3);
      if (ch.g) {
        let mask = 0, nsub = Math.ceil((ch.s1 - ch.s0) / SUB);
        for (let j = 0; j < nsub; j++) { const sm = ch.s0 + (j + 0.5) * SUB, bc = ch.R.L.body[Math.min(ch.R.L.body.length - 1, Math.floor(sm / BC))]; if (bc && bc.g && bc.g.visible) mask |= 1 << j; }
        ch.g.visible = d < R_FAR && mask !== (1 << nsub) - 1;
        if (ch.mat) ch.mat.userData.u.uHide.value = mask;
        if (ch.g.visible) nFar++;
      }
    }
    for (const j of jobs) j.d = j.ch.d + (j.ch.layer === 'detail' ? 60 : j.ch.layer === 'far' ? 500 + j.ch.d * 0.3 : 0);
    // dispose what fell out of each ring (with some hysteresis)
    for (const layer of ['detail', 'body', 'far']) {
      const lim = LAYERS[layer].R * LAYERS[layer].keep, near = nearSets[layer];
      for (const ch of [...built[layer]]) { const d = near.has(ch) ? ch.d : 1e9; if (d > lim) { if (ch.job) dropJob(ch); disposeChunk(ch); if (layer === 'body') ch.ensured = false; } }
    }
    runJobs();
    if (typeof MetroGuide !== 'undefined' && MetroGuide.updateInstances) MetroGuide.updateInstances(camPos, TRACKS);
    stats.chunks = nearSets.body.size + nearSets.detail.size + nearSets.far.size; stats.far = nFar; stats.body = nBody; stats.detail = nDet;
  }

  async function init() {
    MATS.infra = infraMaterial('infra'); MATS.tunnel = infraMaterial('tunnel'); MATS.far = infraMaterial('far'); MATS.fence = fenceMaterial();
    Env.scene.add(group);
    if (typeof Under !== 'undefined') Under.keep(group);
    try { net = await MetroNet.load(); } catch (e) { console.warn('MetroTrack: no MetroNet data', e); return; }
    for (const t of net.tracks) {
      if (t.sys === 'oac') continue;                              // the airport connector is its own thing (later)
      if (t.cls === 'yard' && !/yd/.test(t.id)) continue;
      const R = { t, id: t.id, k: TRACKS.length, len: t.length, cls: t.cls, sys: t.sys };
      R.runs = runsOf(t); TRACKS.push(R); TI.set(t, R);
    }
    pairTracks();
    for (const R of TRACKS) { R.stations = stationRanges(R); R.hasSil = null; }
    planChunks();
    for (const R of TRACKS) { R.hasSil = R.L.far.map(ch => R.runs.some(r => r.s1 > ch.s0 && r.s0 < ch.s1 && (r.type === 'aerial' || r.type === 'bridge' || r.type === 'embankment'))); }
    if (typeof MetroGuide !== 'undefined' && MetroGuide.init) MetroGuide.init({ DIM, PAL, GB, MATS, group });
    if (typeof MetroTube !== 'undefined' && MetroTube.init) MetroTube.init({ DIM, PAL, GB, MATS, group, TRACKS });
    ready = true;
    console.log('MetroTrack: ' + TRACKS.length + ' tracks, ' + TRACKS.reduce((a, R) => a + R.L.body.length, 0) + ' body chunks');
  }
  return { enabled: true, init, update, group, stats, DIM, PAL, GB, TGB, MATS, frameAt, shot, pairAt, nbrAt, inStation, thirdSide, sampleS, rowsAt, groundAt, TRACKS, uWet, uLampK,
    get ready() { return ready; }, get net() { return net; }, jobs, CH, LAYERS, R_DETAIL, R_BODY, R_FAR, UNDERGROUND, STRUCT, trackOf: (t) => TI.get(t) };
})();
if (typeof window !== 'undefined') (window.__baylineMods = window.__baylineMods || {}).MetroTrack = MetroTrack;   // debug handle (window.__bayline.MetroTrack)
