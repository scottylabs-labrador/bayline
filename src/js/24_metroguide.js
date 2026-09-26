// MetroGuide (Bayline Metro, infra workstream): the open-air guideway and everything on the track, for MetroTrack's
// chunks (23_metrotrack.js). Inert unless #metro=1.
//   body(ctx, run, a, b)   structures for s in [a, b] of one structure run: grade / embankment (ballast bed, cess, skirt
//                          to the ground, terrain cut), trench (U-section with retaining walls), median (bed between
//                          freeway barriers, fences), aerial / bridge (box girders per track, hammerhead columns, bearings,
//                          parapets, abutments), plus the underground builders' hand-off (24_metrotube.js)
//   detail(ctx)            generator: rails (119 lb profile, polished band), plinths, third rail + coverboard + brackets,
//                          cable troughs, walkway grating; yields between parts
//   far(ctx)               the silhouette of aerials / bridges / embankments (flight views)
//   updateInstances(cam)   fasteners, ties and third-rail insulators in a window that follows the camera
// Profiles are (lateral, up) polylines traversed clockwise (see GB.sweep). Heights are metres above top of rail at the
// track centreline; laterals are metres right of the track (+s facing), in the level frame for structures and the
// banked frame (cant) for everything that carries the rails.
const MetroGuide = (() => {
  if (!(typeof MetroTrack !== 'undefined' && MetroTrack.enabled)) return { body() {}, *detail() {}, far() {}, updateInstances() {}, init() {} };
  const MT = MetroTrack, DIM = MT.DIM, PAL = MT.PAL, GB = MT.GB;
  let MATS = null;
  const F = {}, F2 = {};

  // ------------------------------------------------------------------ profiles
  // 119 lb/yd class rail (ASSUMPTION: proportions of 115RE scaled to DIM.railH), open at the base (it sits on a plate)
  const RAIL = (() => { const H = DIM.railH, hw = DIM.railHead / 2, bw = DIM.railBase / 2, ww = DIM.railWeb / 2;
    return [[-bw, -H], [-bw, -H + 0.011], [-0.028, -H + 0.022], [-ww, -H + 0.04], [-ww, -0.052], [-hw + 0.001, -0.041], [-hw, -0.012], [-hw + 0.009, -0.002], [-0.012, 0.0],
            [0.012, 0.0], [hw - 0.009, -0.002], [hw, -0.012], [hw - 0.001, -0.041], [ww, -0.052], [ww, -H + 0.04], [0.028, -H + 0.022], [bw, -H + 0.011], [bw, -H]]; })();
  const RAILC = RAIL.slice(0, -1).map((p, j) => j === 8 ? PAL.railTop : (j === 7 || j === 9) ? PAL.railSide : (j === 6 || j === 10) ? PAL.railSide : PAL.railRust);
  // 1:40 inward cant [BFS 34 05 17]: the left rail (side -1) leans toward +l, the right rail toward -l (pivot: base centre)
  const railCanted = (side) => { const a = -side * Math.atan(DIM.railCant), c = Math.cos(a), sn = Math.sin(a), H = DIM.railH;
    return RAIL.map(([l, h]) => { const y = h + H; return [l * c - y * sn, l * sn + y * c - H]; }); };
  const RAILS = { '-1': railCanted(-1), '1': railCanted(1) };
  // third (contact) rail: a steel tee on its side-less web, head up; coverboard above on brackets
  const T3 = DIM.third;
  const CONTACT = [[-0.07, -0.13], [-0.07, -0.118], [-0.012, -0.108], [-0.012, -0.03], [-T3.w / 2, -0.02], [-T3.w / 2, 0.0], [T3.w / 2, 0.0], [T3.w / 2, -0.02], [0.012, -0.03], [0.012, -0.108], [0.07, -0.118], [0.07, -0.13]];
  const CONTACTC = CONTACT.slice(0, -1).map((p, j) => j === 5 ? PAL.thirdTop : PAL.thirdRail);

  const clampLat = (v) => U.clamp(v, -30, 30);
  // the track pair at s: { lo, hi } lateral range of the rails' centrelines in my level frame (0 and the partner's lat)
  function lanes(ctx, s) { const p = ctx.pairAt(ctx.R, s); return p ? { lo: Math.min(0, p.lat), hi: Math.max(0, p.lat), p } : { lo: 0, hi: 0, p: null }; }
  // shared structures (bed, walls, columns): built by the primary of a pair, or by an unpaired track
  function owns(ctx, s) { const p = ctx.pairAt(ctx.R, s); return !p || p.primary; }
  // s-ranges of [a, b] where I own the shared structure and am not inside a station's limits
  function ownedRanges(ctx, a, b, needOwn = true) {
    const out = []; let cur = null;
    for (let s = a; s <= b + 1e-6; s += Math.max(1, Math.min(5, (b - a) / 2))) {
      const ok = (!needOwn || owns(ctx, s)) && !ctx.inStation(ctx.R, s);
      if (ok) { if (!cur) cur = [s, s]; else cur[1] = s; } else if (cur) { out.push(cur); cur = null; }
      if (s >= b) break;
    }
    if (cur) { cur[1] = b; out.push(cur); }
    return out.filter(r => r[1] - r[0] > 0.5);
  }
  const addCut = (ctx, id, poly, below) => { if (typeof Under === 'undefined' || !Under.enabled) return; Under.addCut({ id, poly, below }); (ctx.ch.cutIds || (ctx.ch.cutIds = [])).push(id); };
  // ground relative to top of rail at a lateral offset (level frame), clamped
  function gRel(F, lat, lo = -40, hi = 12) { const x = F.x + F.lx * lat, z = F.z + F.lz * lat; return U.clamp(MT.groundAt(x, z) - F.y, lo, hi); }

  // the world workstream's MetroGround carves the terrain to the bed (rail - 0.85 m within 2.4 m of each track, then
  // 1:2 slopes; trenches cut to rail - 1.2 m within 3.0 m): notes/bart/world.md "Ground meets BART". When it is active the
  // bed needs no terrain cut and its slopes simply run down to the (carved) ground.
  const carved = () => typeof MetroGround !== 'undefined' && MetroGround.stats && MetroGround.stats.segments > 0;
  // ballast prism on carved ground: top at ~tie top, 0.305 m shoulders, 2:1 slopes down to the ground [BFS 34 05 17]
  function bedCarved(F, lo, hi) {
    const tie = DIM.tieLen / 2, top = -DIM.railH - 0.02, sh = DIM.ballastShoulder;
    const L = lo - tie, Rr = hi + tie, Ls = L - sh, Rs = Rr + sh;
    const toe = (edge, dir) => { let l = edge + dir * 1.3; for (let k = 0; k < 3; k++) { const g = gRel(F, l, -6, 3); l = edge + dir * Math.max(0.2, (top - g) * DIM.ballastSlope); } const g = gRel(F, l, -6, 3); return [l + dir * 0.15, Math.min(g - 0.08, top - 0.05)]; };
    const tl = toe(Ls, -1), tr = toe(Rs, 1);
    return { prof: [tl, [Ls, top - 0.02], [L, top], [Rr, top], [Rs, top - 0.02], tr], col: [PAL.ballast, PAL.ballast, PAL.ballast, PAL.ballast, PAL.ballast], toe: Math.min(tl[1], tr[1]) };
  }
  // cross-section of the ballast bed under both tracks of a pair (lo..hi), the cess and a skirt down (or up) to the ground
  // (fallback without MetroGround: the terrain is cut under it)
  function bedProfile(F, lo, hi, kind) {
    const tie = DIM.tieLen / 2, top = -0.235, sh = DIM.ballastShoulder, toe = -0.23 - DIM.tieH - DIM.ballastDepth;   // toe ≈ -0.76
    const L = lo - tie, Rr = hi + tie;
    const gl = gRel(F, L - 4.5), gr = gRel(F, Rr + 4.5);
    const cessL = L - sh - 0.9, cessR = Rr + sh + 0.9;
    // skirt: embankment slopes 1:2 down to the ground; at grade a short skirt tucks under the terrain (or climbs a cut slope)
    const slope = kind === 'embankment' ? 2.0 : 1.5;
    const outL = gl < toe ? cessL - Math.min(18, (toe - gl) * slope) - 0.6 : cessL - Math.min(6, Math.max(0.6, (gl - toe) * 1.2));
    const outR = gr < toe ? cessR + Math.min(18, (toe - gr) * slope) + 0.6 : cessR + Math.min(6, Math.max(0.6, (gr - toe) * 1.2));
    const yL = gl < toe ? gl - 0.25 : Math.min(gl + 0.25, toe + 3), yR = gr < toe ? gr - 0.25 : Math.min(gr + 0.25, toe + 3);
    return { prof: [[outL, yL], [cessL, toe], [L - sh - 0.2, toe + 0.05], [L - sh, top - 0.05], [L, top], [Rr, top], [Rr + sh, top - 0.05], [Rr + sh + 0.2, toe + 0.05], [cessR, toe], [outR, yR]],
      col: [PAL.soil, PAL.soil, PAL.ballast, PAL.ballast, PAL.ballast, PAL.ballast, PAL.ballast, PAL.soil, PAL.soil], cutL: L - sh - 0.5, cutR: Rr + sh + 0.5, toe };
  }
  function buildBed(ctx, a, b, kind) {
    const cv = carved();
    for (const [s0, s1] of ownedRanges(ctx, a, b)) {
      const ss = ctx.sampleS(ctx.R, s0, s1, 6, 2);
      const rows = []; const cutL = [], cutR = []; let below = 1e9;
      for (const s of ss) {
        MT.frameAt(ctx.R, s, F); const ln = lanes(ctx, s); const bp = cv ? bedCarved(F, ln.lo, ln.hi) : bedProfile(F, ln.lo, ln.hi, kind);
        if (cv) { rows.push({ s, o: [F.x - ctx.ox, F.y, F.z - ctx.oz], r: [F.lx, F.ly, F.lz], u: [F.vx, F.vy, F.vz], prof: bp.prof, col: bp.col, gnd: F.y + bp.toe }); continue; }
        rows.push({ s, o: [F.x - ctx.ox, F.y, F.z - ctx.oz], r: [F.lx, F.ly, F.lz], u: [F.vx, F.vy, F.vz], prof: bp.prof, col: bp.col, gnd: F.y + bp.toe });
        cutL.push([F.x + F.lx * bp.cutL, F.z + F.lz * bp.cutL]); cutR.push([F.x + F.lx * bp.cutR, F.z + F.lz * bp.cutR]); below = Math.min(below, F.y + bp.toe + 0.1);
      }
      sweepVar(ctx.B.infra, rows);
      if (!cv) addCut(ctx, 'mg:' + ctx.R.id + ':' + ctx.ch.k + ':' + s0.toFixed(0), cutL.concat(cutR.reverse()), below);
    }
  }
  // sweep with a per-row profile (same point count on every row): rows[i].prof, rows[i].col (per segment)
  function sweepVar(gb, rows) {
    if (rows.length < 2) return; const np = rows[0].prof.length;
    let prev = -1;
    for (let i = 0; i < rows.length; i++) {
      const R = rows[i], o = R.o, r = R.r, u = R.u, pr = R.prof; gb.s = R.s; gb.gnd = R.gnd !== undefined ? R.gnd : -1e4;
      const base = gb.count;
      for (let k = 0; k < np - 1; k++) {
        const A = pr[k], B = pr[k + 1]; let nl = -(B[1] - A[1]), nu = B[0] - A[0]; const L = Math.hypot(nl, nu) || 1; nl /= L; nu /= L;
        const nx = r[0] * nl + u[0] * nu, ny = r[1] * nl + u[1] * nu, nz = r[2] * nl + u[2] * nu, C = R.col[k];
        gb.v(o[0] + r[0] * A[0] + u[0] * A[1], o[1] + r[1] * A[0] + u[1] * A[1], o[2] + r[2] * A[0] + u[2] * A[1], nx, ny, nz, C);
        gb.v(o[0] + r[0] * B[0] + u[0] * B[1], o[1] + r[1] * B[0] + u[1] * B[1], o[2] + r[2] * B[0] + u[2] * B[1], nx, ny, nz, C);
      }
      if (prev >= 0) for (let k = 0; k < np - 1; k++) { const a0 = prev + 2 * k, a1 = base + 2 * k; gb.i.push(a0, a0 + 1, a1, a0 + 1, a1 + 1, a1); }
      prev = base;
    }
    gb.gnd = -1e4;
  }

  // ------------------------------------------------------------------ trench (retained cut, U-section)
  function buildTrench(ctx, a, b) {
    for (const [s0, s1] of ownedRanges(ctx, a, b)) {
      const ss = ctx.sampleS(ctx.R, s0, s1, 5, 2); const rows = []; const cutL = [], cutR = []; let below = 1e9;
      for (const s of ss) {
        MT.frameAt(ctx.R, s, F); const ln = lanes(ctx, s);
        const wl = ln.lo - 3.05, wr = ln.hi + 3.05, t = 0.6, fl = -0.72;             // inner wall faces (MetroGround steps at 3.0-3.9 m), thickness, floor (DF slab)
        const gl = gRel(F, wl - t - 0.5, -5, 14), gr = gRel(F, wr + t + 0.5, -5, 14);
        const tl = Math.max(gl + 0.35, 1.1), tr = Math.max(gr + 0.35, 1.1);                     // wall tops: coping just above the ground
        rows.push({ s, o: [F.x - ctx.ox, F.y, F.z - ctx.oz], r: [F.lx, F.ly, F.lz], u: [F.vx, F.vy, F.vz], gnd: F.y + fl, top: F.y + Math.min(tl, tr),
          prof: [[wl - t - 0.35, Math.min(gl, tl - 0.3) - 0.2], [wl - t - 0.15, tl - 0.05], [wl - t, tl], [wl + 0.12, tl], [wl + 0.05, tl - 0.12], [wl, tl - 0.3], [wl, fl + 0.25], [wl + 0.4, fl], [wr - 0.4, fl], [wr, fl + 0.25], [wr, tr - 0.3], [wr - 0.05, tr - 0.12], [wr - 0.12, tr], [wr + t, tr], [wr + t + 0.15, tr - 0.05], [wr + t + 0.35, Math.min(gr, tr - 0.3) - 0.2]],
          col: [PAL.soil, PAL.concreteLight, PAL.concreteLight, PAL.concreteLight, PAL.concrete, PAL.concrete, PAL.concreteDark, PAL.deckTop, PAL.concreteDark, PAL.concrete, PAL.concrete, PAL.concreteLight, PAL.concreteLight, PAL.concreteLight, PAL.soil] });
        cutL.push([F.x + F.lx * (wl - t - 0.1), F.z + F.lz * (wl - t - 0.1)]); cutR.push([F.x + F.lx * (wr + t + 0.1), F.z + F.lz * (wr + t + 0.1)]); below = Math.min(below, F.y + fl);
      }
      for (const R of rows) R.top = R.o[1] + 1.2;
      sweepVar(ctx.B.infra, rows);
      if (!carved()) addCut(ctx, 'mt:' + ctx.R.id + ':' + ctx.ch.k + ':' + s0.toFixed(0), cutL.concat(cutR.reverse()), below);
      // drainage grates in the floor gutter and wall weep holes every 6 m (small, near only: part of the body for now)
      for (let s = Math.ceil(s0 / 6) * 6; s < s1; s += 6) { MT.frameAt(ctx.R, s, F); const ln = lanes(ctx, s);
        for (const lat of [ln.lo - 3.05 + 0.02, ln.hi + 3.05 - 0.02]) ctx.B.infra.box(F.x + F.lx * lat - ctx.ox, F.y - 0.1, F.z + F.lz * lat - ctx.oz, [F.tx, F.ty, F.tz], [F.vx, F.vy, F.vz], [F.lx, F.ly, F.lz], 0.05, 0.05, 0.025, PAL.black, 4); }
    }
  }

  // ------------------------------------------------------------------ freeway median: bed between the barriers, fences
  // (the freeway lanes themselves are the world's roads). Barriers: concrete median barrier (single-slope, 0.97 m) at
  // ASSUMPTION ±(lane + 3.9 m); chain-link on top to 2.1 m; the bed between.
  function buildMedian(ctx, a, b) {
    buildBed(ctx, a, b, 'median');
    for (const [s0, s1] of ownedRanges(ctx, a, b)) {
      const ss = ctx.sampleS(ctx.R, s0, s1, 6, 2);
      for (const side of [-1, 1]) {
        const rows = ss.map(s => { MT.frameAt(ctx.R, s, F); const ln = lanes(ctx, s); const lat = side < 0 ? ln.lo - 3.9 : ln.hi + 3.9; const gy = gRel(F, lat, -3, 2);
          return { s, o: [F.x + F.lx * lat - ctx.ox, F.y + gy, F.z + F.lz * lat - ctx.oz], r: [F.lx, F.ly, F.lz], u: [F.vx, F.vy, F.vz], top: F.y + gy + 0.97, gnd: F.y + gy }; });
        // single-slope barrier: 0.61 m base, 0.24 m top, 0.97 m tall (both faces sloped)
        ctx.B.infra.sweep(rows, [[-0.305, -0.3], [-0.305, 0.05], [-0.12, 0.97], [0.12, 0.97], [0.305, 0.05], [0.305, -0.3]], PAL.concreteLight);
        const posts = []; for (const R of rows) posts.push(R);
        fenceRun(ctx, rows.map(R => [R.o[0], R.o[1] + 0.97, R.o[2]]), 1.15);
      }
    }
  }
  // chain-link fence along a polyline of foot points (chunk-local), height h: posts every ~3 m, top rail, fabric panels
  function fenceRun(ctx, pts, h) {
    if (pts.length < 2) return; const gb = ctx.B.infra, fb = ctx.B.fence || (ctx.B.fence = new FenceB());
    let dist = 0, next = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i > 0) { const q = pts[i - 1]; const d = Math.hypot(p[0] - q[0], p[2] - q[2]); fb.panel(q, p, dist, dist + d, h); dist += d; }
      if (dist >= next || i === pts.length - 1) { gb.cyl([p[0], p[1] - 0.1, p[2]], [p[0], p[1] + h + 0.05, p[2]], 0.03, 0.03, 6, PAL.fence, false, true); next = dist + 3.0; }
    }
    gb.top = 1e4; const top = []; for (const p of pts) top.push(p[0], p[1] + h, p[2]);
    tube(gb, top, 0.02, 4, PAL.fence);
  }
  function tube(gb, pts, r, n, C) {
    const m = pts.length / 3; if (m < 2) return; const b = gb.count;
    for (let i = 0; i < m; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(m - 1, i + 1); let wx = pts[i1 * 3] - pts[i0 * 3], wy = pts[i1 * 3 + 1] - pts[i0 * 3 + 1], wz = pts[i1 * 3 + 2] - pts[i0 * 3 + 2]; const L = Math.hypot(wx, wy, wz) || 1; wx /= L; wy /= L; wz /= L;
      let hx = 0, hy = 1, hz = 0; if (Math.abs(wy) > 0.9) { hx = 1; hy = 0; }
      let ux = hy * wz - hz * wy, uy = hz * wx - hx * wz, uz = hx * wy - hy * wx; const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      const vx = wy * uz - wz * uy, vy = wz * ux - wx * uz, vz = wx * uy - wy * ux;
      for (let k = 0; k <= n; k++) { const t = k / n * Math.PI * 2, co = Math.cos(t), si = Math.sin(t); const dx = ux * co + vx * si, dy = uy * co + vy * si, dz = uz * co + vz * si; gb.v(pts[i * 3] + dx * r, pts[i * 3 + 1] + dy * r, pts[i * 3 + 2] + dz * r, dx, dy, dz, C); }
      if (i > 0) for (let k = 0; k < n; k++) { const a0 = b + (i - 1) * (n + 1) + k, b0 = a0 + n + 1; gb.q(a0, a0 + 1, b0 + 1, b0); }
    }
  }
  class FenceB {
    constructor() { this.p = []; this.n = []; this.u = []; this.i = []; }
    panel(a, b, d0, d1, h) {
      const dx = b[0] - a[0], dz = b[2] - a[2]; const L = Math.hypot(dx, dz) || 1; const nx = -dz / L, nz = dx / L; const base = this.p.length / 3; const k = 1 / 0.058;
      this.p.push(a[0], a[1] + 0.03, a[2], b[0], b[1] + 0.03, b[2], b[0], b[1] + h - 0.03, b[2], a[0], a[1] + h - 0.03, a[2]);
      for (let q = 0; q < 4; q++) this.n.push(nx, 0, nz);
      this.u.push(d0 * k, 0, d1 * k, 0, d1 * k, h * k, d0 * k, h * k); this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    mesh(mat) { if (!this.i.length) return null; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2)); g.setIndex(this.i); g.computeBoundingSphere(); const m = new THREE.Mesh(g, mat); m.receiveShadow = true; m.castShadow = false; m.matrixAutoUpdate = false; return m; }
  }

  // ------------------------------------------------------------------ aerial guideway
  // ERA by location (BART's aerials were built in four campaigns): 1970s precast box girders on single hammerhead columns
  // (Fremont, Richmond, Concord lines, West Oakland); 1990s-2000s (Dublin, Pittsburg/Bay Point, SFO extension); 2017-2020
  // (Warm Springs, Milpitas/Berryessa). ASSUMPTION until the research lands: one girder style, era tweaks the columns.
  function eraAt(x, z) {
    const ll = Geo.w2ll(x, z);
    if (ll.lat < 37.52 && ll.lon > -121.96) return 2020;                 // Warm Springs, Milpitas, Berryessa
    if (ll.lon > -121.95 && ll.lat > 37.68 && ll.lat < 37.73) return 1997; // Dublin/Pleasanton (I-580)
    if (ll.lat > 37.99 && ll.lon > -121.99) return 1996;                   // Pittsburg/Bay Point (SR-4)
    if (ll.lat < 37.64 && ll.lon < -122.36) return 2003;                   // SFO / Millbrae
    return 1972;
  }
  const A = DIM.aerial;
  // girder cross-section around its own track (level frame): trapezoidal box, 1.22 m deep, 3.556 m deck with thin
  // cantilevered flange tips [CLEMONS]
  function girderProfile(hD) {
    const tw = A.girderTopW / 2, bw = A.girderBotW / 2, d = A.girderD, ft = A.flangeT;
    return [[-tw, hD - ft], [-tw, hD], [tw, hD], [tw, hD - ft], [tw - 0.52, hD - ft - 0.1], [bw, hD - d], [-bw, hD - d], [-tw + 0.52, hD - ft - 0.1]];
  }
  // modern (2003+) style: one box for both tracks with barriers (lo..hi = track laterals)
  function modernProfile(hD, lo, hi) {
    const L = lo - 1.95, R2 = hi + 1.95, d = 2.1;
    return [[L, hD - 0.3], [L, hD + 1.07], [L + 0.25, hD + 1.07], [L + 0.38, hD], [R2 - 0.38, hD], [R2 - 0.25, hD + 1.07], [R2, hD + 1.07], [R2, hD - 0.3], [R2 - 1.4, hD - 0.55], [R2 - 2.3, hD - d], [L + 2.3, hD - d], [L + 1.4, hD - 0.55]];
  }
  // column positions of an aerial run on a (primary) track: evenly spaced spans close to the typical span
  function spanJoints(run) {
    const len = run.s1 - run.s0; const era = run.era || 1972, sp = era >= 2003 ? 32 : A.spanTyp;
    const n = Math.max(1, Math.round(len / sp)); const L = len / n; const out = [];
    for (let k = 0; k <= n; k++) out.push(run.s0 + k * L); return out;
  }
  function runEra(ctx, run) { if (!run.era) { MT.frameAt(ctx.R, (run.s0 + run.s1) / 2, F2); run.era = eraAt(F2.x, F2.z); } return run.era; }
  function buildAerial(ctx, run, a, b, kind) {
    const R = ctx.R, gb = ctx.B.infra, hD = -A.deckBelowTOR, era = runEra(ctx, run);
    let joints = spanJoints(run);
    const p0 = ctx.pairAt(R, (a + b) / 2);
    if (p0 && !p0.primary) {               // follow the primary's joints (mapped onto my s)
      const R1 = p0.R2, runs1 = R1.runs.filter(r => r.type === run.type && r.s1 > p0.s2 - 800 && r.s0 < p0.s2 + 800);
      const js = []; for (const r1 of runs1) { r1.era = r1.era || era; for (const s1 of spanJoints(r1)) { MT.frameAt(R1, s1, F); const q = projectOn(R, F.x, F.z, (a + b) / 2); if (q !== null) js.push(q); } }
      if (js.length) joints = js.sort((x, y) => x - y);
    }
    const spans = []; for (let k = 0; k + 1 < joints.length; k++) { const s0 = Math.max(a, joints[k] + 0.025), s1 = Math.min(b, joints[k + 1] - 0.025); if (s1 - s0 > 0.3) spans.push([s0, s1, joints[k] >= a - 0.01, joints[k + 1] <= b + 0.01]); }
    if (era >= 2003) {
      // one wide box for both tracks, built by the primary (or an unpaired track)
      for (const [s0, s1, capA, capB] of spans) for (const [q0, q1] of ownedRanges(ctx, s0, s1)) {
        const ss = ctx.sampleS(R, q0, q1, 8, 2.5); const rows = []; let prof0 = null;
        for (const s of ss) { MT.frameAt(R, s, F); const ln = lanes(ctx, s); const pr = modernProfile(hD, ln.lo, ln.hi); prof0 = prof0 || pr;
          rows.push({ s, o: [F.x - ctx.ox, F.y, F.z - ctx.oz], r: [F.lx, F.ly, F.lz], u: [F.vx, F.vy, F.vz], t: [F.tx, F.ty, F.tz], prof: pr.concat([pr[0]]), col: pr.map((p, k) => k === 3 ? PAL.deckTop : k >= 7 ? PAL.precast : PAL.concreteLight) }); }
        gb.wear = 0.7; sweepVar(gb, rows.map(r0 => Object.assign(r0, { gnd: -1e4 })));
        if (capA) gb.capProfile(rows[0], rows[0].prof.slice(0, -1), PAL.precast, -1); if (capB) gb.capProfile(rows[rows.length - 1], rows[rows.length - 1].prof.slice(0, -1), PAL.precast, 1);
        gb.wear = 0.5;
      }
    } else {
      const prof = girderProfile(hD);
      // girders: the primary of a pair builds both (the partner's follows its interpolated offset), so a pair's aerial
      // is one draw call; an unpaired track builds its own
      for (const [s0, s1, capA, capB] of spans) {
        const subs = ownedRanges(ctx, s0, s1); if (!subs.length) continue;
        for (const [q0, q1] of subs) {
          const ss = ctx.sampleS(R, q0, q1, 8, 2.5);
          const pp = ctx.pairAt(R, (q0 + q1) / 2);
          for (const which of pp ? [0, 1] : [0]) {
            let lastLa = pp ? pp.lat : 0;
            const rows = ss.map(s => { MT.frameAt(R, s, F); const pq = which ? MT.pairAt(R, s) : null; const la = which ? (pq ? (lastLa = pq.lat) : lastLa) : 0;
              return { s, o: [F.x + F.lx * la - ctx.ox, F.y, F.z + F.lz * la - ctx.oz], r: [F.lx, F.ly, F.lz], u: [F.vx, F.vy, F.vz], t: [F.tx, F.ty, F.tz], top: F.y + hD, gnd: -1e4 }; });
            gb.wear = 0.75; gb.sweep(rows, prof, PAL.precast, { closed: true });
            if (capA && q0 === subs[0][0]) gb.capProfile(rows[0], prof, PAL.precast, -1);
            if (capB && q1 === subs[subs.length - 1][1]) gb.capProfile(rows[rows.length - 1], prof, PAL.precast, 1);
            // drainage channel on the girder centreline (a shallow dark groove between the plinths)
            gb.sweep(rows, [[-0.09, hD + 0.004], [0.09, hD + 0.004]], PAL.concreteDark);
          }
          // the sunken walkway between the two girders: a slab 0.25 m below the decks
          if (pp) {
            const rows = ctx.rowsAt(ctx, ss, 0, 0, false);
            const w0 = Math.min(0, pp.lat) + A.girderTopW / 2 + 0.01, w1 = Math.max(0, pp.lat) - A.girderTopW / 2 - 0.01;
            if (w1 - w0 > 0.2) { const yw = hD - A.walkDrop; gb.sweep(rows, [[w0, yw - 0.14], [w0, yw], [w1, yw], [w1, yw - 0.14]], PAL.concrete); }
          }
          gb.wear = 0.5;
        }
      }
    }
    // columns + caps + bearings (shared: the primary, or an unpaired track), footings on the ground; none in stations
    for (const sj of joints) {
      if (sj < a - 0.01 || sj > b + 0.01) continue; if (ctx.inStation(R, sj, 2)) continue;
      if (!owns(ctx, sj)) continue;
      column(ctx, sj, hD, kind, era);
    }
    // abutment where the aerial meets the ground at a run end (grade / embankment neighbours)
    for (const [se, dir] of [[run.s0, -1], [run.s1, 1]]) if (se >= a - 0.01 && se <= b + 0.01 && owns(ctx, se) && !ctx.inStation(R, se, 5)) abutment(ctx, se, dir, hD, era);
  }
  // s on track R nearest to world (x, z), searched around sHint (±1 km); null if farther than 12 m
  function projectOn(R, x, z, sHint) {
    const t = R.t, n = t.X.length, st = t.step; let i0 = Math.max(0, Math.floor((sHint - 1000) / st)), i1 = Math.min(n - 2, Math.ceil((sHint + 1000) / st));
    let bd = 144, bs = null;
    for (let i = i0; i <= i1; i++) { const ax = t.X[i], az = t.Z[i], dx = t.X[i + 1] - ax, dz = t.Z[i + 1] - az, L2 = dx * dx + dz * dz || 1e-9; const u = U.clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1); const d = (ax + dx * u - x) ** 2 + (az + dz * u - z) ** 2; if (d < bd) { bd = d; bs = (i + u) * st; } }
    return bs;
  }
  // a vertical prism along a closed horizontal profile (clockwise in (lateral, along)), from y0 to y1
  function prism(gb, cx, cz, Lv, T, prof, y0, y1, C) {
    const r = [-Lv[0], 0, -Lv[2]], u = [T[0], 0, T[2]];         // (r = up x along: the sweep's handedness)
    gb.sweep([{ o: [cx, y0, cz], r, u, s: gb.s }, { o: [cx, y1, cz], r, u, s: gb.s }], prof, C, { closed: true });
  }
  const HEX = (() => { const rr = A.colD / 2 / Math.cos(Math.PI / 6), out = []; for (let k = 0; k < 6; k++) { const a = Math.PI / 2 - k * Math.PI / 3; out.push([Math.cos(a) * rr, Math.sin(a) * rr]); } return out; })();
  function column(ctx, s, hD, kind, era) {
    const R = ctx.R, gb = ctx.B.infra; MT.frameAt(R, s, F); const ln = lanes(ctx, s);
    const mid = (ln.lo + ln.hi) / 2, half = (ln.hi - ln.lo) / 2;
    const T = [F.tx, 0, F.tz], Lv = [F.lx, 0, F.lz]; const tl = Math.hypot(T[0], T[2]) || 1; T[0] /= tl; T[2] /= tl;
    const cx = F.x + F.lx * mid - ctx.ox, cz = F.z + F.lz * mid - ctx.oz;
    const modern = era >= 2003, depth = modern ? 2.1 : A.girderD;
    const soffit = F.y + hD - depth - 0.06;                                             // girder bottom, bearing seat
    const ground = MT.groundAt(cx + ctx.ox, cz + ctx.oz);
    if (soffit - ground < 1.0) return;                                                 // too low for a column (fill instead)
    gb.s = s; gb.wear = 0.8;
    const P = (lat, y, along) => [cx + Lv[0] * lat + T[0] * along, y, cz + Lv[2] * lat + T[2] * along];
    // bearings: elastomeric pads under each web of each girder, both sides of the deck joint
    const girders = modern ? [0] : (half > 0.5 ? [ln.lo - mid, ln.hi - mid] : [0]);
    for (const gl of girders) for (const w of modern ? [-2.2, 2.2] : [-0.55, 0.55]) for (const dt of [-0.42, 0.42]) {
      const c = P(gl + w, soffit + 0.035, dt); gb.box(c[0], c[1], c[2], T, [0, 1, 0], Lv, 0.16, 0.035, 0.24, PAL.bearing);
    }
    // hammerhead cap: a T spanning both girders, deep over the column, tapering to its tips
    const capW = modern ? half + 2.6 : half + A.girderBotW / 2 + 0.6, capTop = soffit - 0.0, capD = modern ? 1.8 : A.capD, hl = (modern ? 2.2 : A.capL) / 2;
    const colR = A.colD / 2;
    gb.top = capTop; gb.gnd = ground;
    const capProf = modern ? [[-capW, capTop - capD * 0.6], [-capW, capTop], [capW, capTop], [capW, capTop - capD * 0.6], [capW - 0.8, capTop - capD], [-capW + 0.8, capTop - capD]]
      : [[-capW, capTop - capD * 0.45], [-capW, capTop], [capW, capTop], [capW, capTop - capD * 0.45], [colR + 0.35, capTop - capD], [-colR - 0.35, capTop - capD]];
    const rowsCap = [-hl, hl].map(al => ({ o: P(0, 0, al), r: Lv, u: [0, 1, 0], t: T, s }));
    gb.sweep(rowsCap, capProf, PAL.concrete, { closed: true }); gb.capProfile(rowsCap[0], capProf, PAL.concrete, -1); gb.capProfile(rowsCap[1], capProf, PAL.concrete, 1);
    // column: hexagonal 1.52 m (original) or a round-ended wall pier (modern); ~45 % of the originals carry a seismic
    // retrofit steel jacket (1.8-2.4 m) [FLOR]; footing mostly buried
    const top = capTop - capD + 0.05, bot = ground - 0.6;
    const hsh = U.hash2(Math.round((cx + ctx.ox) * 0.7), Math.round((cz + ctx.oz) * 0.7));
    if (modern) {
      const w = 1.1, d = 0.8; const rr = []; for (let k = 0; k < 16; k++) { const a = Math.PI / 2 - k / 16 * Math.PI * 2; const ex = Math.cos(a) >= 0 ? w - d : -(w - d); rr.push([ex + Math.cos(a) * d, Math.sin(a) * d]); }
      prism(gb, cx, cz, Lv, T, rr, bot, top, PAL.concreteLight);
    } else if (hsh < 0.45) {
      gb.cyl([cx, bot, cz], [cx, top - 0.05, cz], 0.98, 0.98, 28, PAL.jacket, false, false);
      gb.cyl([cx, top - 0.05, cz], [cx, top + 0.02, cz], 0.98, 0.9, 28, PAL.jacket, false, true);
    } else {
      prism(gb, cx, cz, Lv, T, HEX, bot, top, PAL.concreteLight);
    }
    gb.box(cx, ground - 0.35, cz, T, [0, 1, 0], Lv, 1.7, 0.45, 1.7, PAL.concreteDark, 4);
    gb.top = 1e4; gb.gnd = -1e4; gb.wear = 0.5;
  }
  function abutment(ctx, s, dir, hD, era) {
    const R = ctx.R, gb = ctx.B.infra; MT.frameAt(R, s, F); const ln = lanes(ctx, s);
    const T = [F.tx, 0, F.tz]; const tl = Math.hypot(T[0], T[2]) || 1; T[0] /= tl; T[2] /= tl; const Lv = [F.lx, 0, F.lz];
    const mid = (ln.lo + ln.hi) / 2, w = (ln.hi - ln.lo) / 2 + A.girderTopW / 2 + 0.4;
    const cx = F.x + F.lx * mid + T[0] * dir * 0.9 - ctx.ox, cz = F.z + F.lz * mid + T[2] * dir * 0.9 - ctx.oz;
    const g = MT.groundAt(cx + ctx.ox, cz + ctx.oz), top = F.y + hD - 0.02; if (top - g < 0.6) return;
    gb.top = top; gb.gnd = g;
    gb.box(cx, (top + g - 0.5) / 2, cz, T, [0, 1, 0], Lv, 0.9, (top - g + 0.5) / 2, w, PAL.concrete);
    gb.top = 1e4; gb.gnd = -1e4;
  }

  // ------------------------------------------------------------------ bridge (short spans): girders like the aerial
  function buildBridge(ctx, run, a, b) { buildAerial(ctx, run, a, b, 'bridge'); }

  // ------------------------------------------------------------------ body dispatch
  function body(ctx, run, a, b) {
    switch (run.type) {
      case 'aerial': return buildAerial(ctx, run, a, b, 'aerial');
      case 'bridge': return buildBridge(ctx, run, a, b);
      case 'trench': return buildTrench(ctx, a, b);
      case 'median': return buildMedian(ctx, a, b);
      default: {
        // at grade / on embankment, except where the track runs well below the ground on both sides (portal approaches,
        // cuttings): there a retained cut (U-section) holds the ground back instead of a skirt
        if (carved()) return buildBed(ctx, a, b, run.type === 'embankment' ? 'embankment' : 'grade');
        for (const [s0, s1, deep] of cutRanges(ctx, a, b)) { if (deep) buildTrench(ctx, s0, s1); else buildBed(ctx, s0, s1, run.type === 'embankment' ? 'embankment' : 'grade'); }
      }
    }
  }
  function cutRanges(ctx, a, b) {
    const out = []; let cur = null; const step = 5;
    for (let s = a; ; s = Math.min(b, s + step)) {
      MT.frameAt(ctx.R, s, F); const ln = lanes(ctx, s); const gl = gRel(F, ln.lo - 5.5, -20, 20), gr = gRel(F, ln.hi + 5.5, -20, 20);
      const deep = Math.min(gl, gr) > 0.55;                          // (the ballast toe is ~0.76 m below the rail)
      if (!cur || cur[2] !== deep) { if (cur) cur[1] = s; cur = [s, s, deep]; out.push(cur); } else cur[1] = s;
      if (s >= b) break;
    }
    // merge short flickers (< 15 m) into their neighbours
    for (let i = 0; i < out.length; i++) if (out.length > 1 && out[i][1] - out[i][0] < 15) { const j = i > 0 ? i - 1 : i + 1; out[j][0] = Math.min(out[j][0], out[i][0]); out[j][1] = Math.max(out[j][1], out[i][1]); out.splice(i, 1); i = -1; }
    return out;
  }

  // ------------------------------------------------------------------ detail layer: rails, plinths, third rail
  const DF = new Set(['aerial', 'bridge', 'trench', 'portal', 'cutcover', 'bored', 'tube']);
  function* detail(ctx) {
    const R = ctx.R, s0 = ctx.s0, s1 = ctx.s1;
    for (const run of R.runs) {
      if (run.s1 <= s0 || run.s0 >= s1) continue;
      const a = Math.max(run.s0, s0), b = Math.min(run.s1, s1); if (b - a < 0.05) continue;
      const under = MT.UNDERGROUND.has(run.type), gb = under ? ctx.B.tunnel : ctx.B.infra;
      if (under && typeof MetroTube !== 'undefined') gb.fix = MetroTube.fixFor(R, (a + b) / 2, run.type);
      // rails (banked frame), dense sampling for smooth curves
      const ss = ctx.sampleS(R, a, b, 6, 0.8);
      for (const side of [-1, 1]) { const rows = ctx.rowsAt(ctx, ss, side * DIM.railC, 0, true); gb.wear = 0.4; gb.sweep(rows, RAILS[side], RAILC); }
      // plinths (DF structures) under each rail, broken every 4.6 m for drainage; ties are instanced
      const PL = run.type === 'aerial' || run.type === 'bridge' ? 22.5 : 9.14;       // plinths break at deck joints / every 30 ft
      if (DF.has(run.type)) for (let q = Math.floor(a / PL) * PL; q < b; q += PL) {
        const q0 = Math.max(a, q + 0.04), q1 = Math.min(b, q + PL - 0.04); if (q1 - q0 < 0.4) continue;
        if (ctx.inStation(R, (q0 + q1) / 2, -12)) continue;                 // (stations build their own trackway)
        const pss = ctx.sampleS(R, q0, q1, 4.6, 1.2);
        for (const side of [-1, 1]) {
          const rows = ctx.rowsAt(ctx, pss, side * DIM.railC, 0, true), w = DIM.plinthW / 2, top = -DIM.railH - 0.04;
          gb.wear = 0.6; gb.sweep(rows, [[-w, top - 0.35], [-w, top - 0.02], [-w + 0.03, top], [w - 0.03, top], [w, top - 0.02], [w, top - 0.35]], PAL.plinth);
          const cap = [[-w, top - 0.3], [-w, top], [w, top], [w, top - 0.3]]; gb.capProfile(rows[0], cap, PAL.plinth, -1); gb.capProfile(rows[rows.length - 1], cap, PAL.plinth, 1);
        }
      }
      buildThird(ctx, gb, a, b);
      gb.wear = 0.5;
      yield;
    }
  }
  function buildThird(ctx, gb, a0, b0) {
    const R = ctx.R, s0 = Math.max(a0, 14), s1 = Math.min(b0, R.len - 14);
    if (s1 - s0 < 2) return;
    // split where the side changes
    const pieces = []; let cur = null;
    for (let s = s0; s <= s1 + 1e-6; s += 2) { const sd = ctx.thirdSide(R, Math.min(s, s1)); if (!cur || cur.side !== sd) { if (cur) pieces.push(cur); cur = { a: s, b: s, side: sd }; } else cur.b = Math.min(s, s1); if (s >= s1) break; }
    if (cur) pieces.push(cur);
    for (const pc of pieces) {
      if (pc.b - pc.a < 6) continue;
      const a = pc.a + (pc.a > s0 + 1 ? 3 : 0), b = pc.b - (pc.b < s1 - 1 ? 3 : 0); if (b - a < 1) continue;
      const ss = ctx.sampleS(R, a, b, 6, 1.0);
      const lat = pc.side * T3.lat;
      const rows = ctx.rowsAt(ctx, ss, lat, T3.top, true);
      // end approaches: the contact surface ramps down 7 cm over the last 1.5 m where the run starts/ends at a gap
      const ramp = (row) => { const e = Math.min(row.s - a, b - row.s); const k = U.clamp(e / 3.5, 0, 1); row.o[1] -= (1 - k) * 0.076; };   // end approach: 3 in over ~3.5 m
      if (a <= 14.5 || pc.a > s0 + 1) rows.forEach(ramp); else if (b >= R.len - 14.5 || pc.b < s1 - 1) rows.forEach(ramp);
      gb.wear = 0.5; gb.sweep(rows, CONTACT, CONTACTC);
      // coverboard: a fibreglass board above the rail (clearance for the shoe), carried by brackets every insulator
      // coverboard: fibreglass, light grey, ~8 cm over the contact surface, reaching past the rail toward the track (the
      // shoes slide under it) and turned down on the field side where its brackets hold it
      const cw = T3.coverW, ch = 0.08;
      gb.sweep(rows, pc.side > 0 ? [[-cw * 0.55, ch - 0.012], [-cw * 0.55, ch + 0.012], [cw * 0.45, ch + 0.012], [cw * 0.45, ch - 0.07]] : [[-cw * 0.45, ch - 0.07], [-cw * 0.45, ch + 0.012], [cw * 0.55, ch + 0.012], [cw * 0.55, ch - 0.012]], PAL.cover);
    }
  }

  // ------------------------------------------------------------------ far silhouettes
  // (built per SUB m piece of the far chunk; aT.w = the piece index, which the far material hides where bodies show)
  function far(ctx, SUB = 400) {
    const R = ctx.R, gb = ctx.B.infra, nsub = Math.ceil((ctx.s1 - ctx.s0) / SUB);
    for (let j = 0; j < nsub; j++) {
      const p0 = ctx.s0 + j * SUB, p1 = Math.min(ctx.s1, p0 + SUB); gb.lg = j;
      for (const run of R.runs) {
        if (run.s1 <= p0 || run.s0 >= p1) continue; if (!(run.type === 'aerial' || run.type === 'bridge' || run.type === 'embankment')) continue;
        const a = Math.max(run.s0, p0), b = Math.min(run.s1, p1);
        for (const [q0, q1] of ownedRanges(ctx, a, b)) {
          const ss = []; for (let s = q0; s < q1; s += 20) ss.push(s); ss.push(q1);
          if (ss.length < 2) continue;
          if (run.type === 'embankment') {
            const rows = ss.map(s => { MT.frameAt(R, s, F); const ln = lanes(ctx, s); const bp = bedProfile(F, ln.lo, ln.hi, 'embankment'); return { s, o: [F.x - ctx.ox, F.y, F.z - ctx.oz], r: [F.lx, F.ly, F.lz], u: [F.vx, F.vy, F.vz], prof: [bp.prof[0], bp.prof[3], bp.prof[6], bp.prof[9]], col: [PAL.soil, PAL.ballast, PAL.soil] }; });
            sweepVar(gb, rows); continue;
          }
          const hD = -A.deckBelowTOR, era = runEra(ctx, run), dd = era >= 2003 ? 2.1 : A.girderD;
          const rows = ss.map(s => { MT.frameAt(R, s, F); const ln = lanes(ctx, s); const l0 = ln.lo - A.girderTopW / 2, l1 = ln.hi + A.girderTopW / 2;
            return { s, o: [F.x - ctx.ox, F.y, F.z - ctx.oz], r: [F.lx, F.ly, F.lz], u: [F.vx, F.vy, F.vz], prof: [[l0, hD + 0.1], [l1, hD + 0.1], [l1 - 0.9, hD - dd], [l0 + 0.9, hD - dd], [l0, hD + 0.1]], col: [PAL.precast, PAL.precast, PAL.concreteDark, PAL.precast] }; });
          sweepVar(gb, rows);
          for (const sj of spanJoints(run)) { if (sj < q0 || sj > q1) continue; MT.frameAt(R, sj, F); const ln = lanes(ctx, sj); const mid = (ln.lo + ln.hi) / 2; const x = F.x + F.lx * mid, z = F.z + F.lz * mid; const g = MT.groundAt(x, z), top = F.y + hD - dd;
            if (top - g > 1) gb.box(x - ctx.ox, (top + g) / 2, z - ctx.oz, [F.tx, 0, F.tz], [0, 1, 0], [F.lx, 0, F.lz], 0.7, (top - g) / 2, 0.7, PAL.concreteLight, 12); }
        }
      }
    }
    gb.lg = -1;
  }

  // ------------------------------------------------------------------ instanced small parts around the camera
  // fastener pairs (DF), ties (ballast), third-rail insulators; rebuilt when the camera moves 12 m
  let inst = null; const lastC = new THREE.Vector3(1e9, 0, 0);
  const _m4 = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _flip = new THREE.Matrix4().makeRotationY(Math.PI);   // (field side: turned, not mirrored)
  function fastenerGeo(full) {
    const gb = new GB(); const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];   // local: x along track, y up, z right (x × y = z)
    for (const sd of [-1, 1]) {
      const rc = sd * DIM.railC, top = -DIM.railH;
      gb.box(0, top - 0.012, rc, X, Y, Z, 0.09, 0.012, 0.19, PAL.fastener);                 // steel baseplate
      gb.box(0, top - 0.027, rc, X, Y, Z, 0.1, 0.004, 0.2, PAL.pad);                       // elastomer pad
      if (full) {
        for (const bs of [-1, 1]) {
          const bz = rc + bs * 0.14; gb.cyl([0.05, top - 0.002, bz], [0.05, top + 0.022, bz], 0.018, 0.018, 6, PAL.clip, false, true); gb.cyl([-0.05, top - 0.002, bz], [-0.05, top + 0.022, bz], 0.018, 0.018, 6, PAL.clip, false, true);   // anchor bolts
          const cz = rc + bs * 0.085; gb.box(0, top + 0.012, cz, X, Y, Z, 0.035, 0.012, 0.028, PAL.clip);                                                                     // clip toe on the rail foot
        }
      }
    }
    return gb.geometry();
  }
  function tieGeo() {
    const gb = new GB(); const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1]; const top = -DIM.railH - 0.02, h = DIM.tieH, L = DIM.tieLen / 2;
    gb.box(0, top - h / 2, 0, X, Y, Z, DIM.tieW / 2 - 0.02, h / 2, L, PAL.concreteLight, 4);
    for (const sd of [-1, 1]) { const rc = sd * DIM.railC; gb.box(0, top + 0.004, rc, X, Y, Z, 0.09, 0.006, 0.09, PAL.pad); for (const bs of [-1, 1]) gb.box(0, top + 0.03, rc + bs * 0.1, X, Y, Z, 0.045, 0.03, 0.018, PAL.clip); }
    return gb.geometry();
  }
  // third-rail support (local: x along, y up, z outward/field side): light-grey porcelain insulator with sheds (229 mm)
  // from the tie top to the rail's base, a clamp on the rail foot, and the coverboard bracket rising on the field side;
  // on direct fixation a concrete pedestal lifts it from the deck [BFS 34 24 13]
  function insulGeo(df) {
    const gb = new GB(); const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
    const base = T3.top - T3.h - T3.insH, topI = T3.top - T3.h;       // -0.188 .. +0.041
    if (df) gb.box(0, (-A.deckBelowTOR + base) / 2, 0, X, Y, Z, 0.16, Math.max(0.01, (base + A.deckBelowTOR) / 2), 0.16, PAL.plinth, 4);
    gb.box(0, base + 0.01, 0, X, Y, Z, 0.09, 0.01, 0.09, PAL.fastener);
    gb.cyl([0, base + 0.02, 0], [0, topI - 0.03, 0], 0.055, 0.05, 10, PAL.insul, false, false);
    for (const f of [0.28, 0.5, 0.72]) { const y = base + 0.02 + (topI - base - 0.05) * f; gb.cyl([0, y - 0.012, 0], [0, y + 0.012, 0], 0.085, 0.075, 12, PAL.insul, true, true); }
    gb.box(0, topI - 0.015, 0, X, Y, Z, 0.07, 0.015, 0.085, PAL.fastener);
    const zb = 0.16; gb.box(0, (base + T3.top + 0.09) / 2, zb, X, Y, Z, 0.025, (T3.top + 0.09 - base) / 2, 0.01, PAL.galvDark);
    gb.box(0, T3.top + 0.085, zb - 0.05, X, Y, Z, 0.025, 0.008, 0.055, PAL.galvDark);
    return gb.geometry();
  }
  function ensureInst() {
    if (inst) return inst;
    const mk = (geo, max, shadow) => { const m = new THREE.InstancedMesh(geo, MATS.infra, max); m.count = 0; m.frustumCulled = false; m.castShadow = shadow; m.receiveShadow = true; MT.group.add(m); return m; };
    inst = { fastFull: mk(fastenerGeo(true), 2400, true), fast: mk(fastenerGeo(false), 5000, false), tie: mk(tieGeo(), 3000, true), ins: mk(insulGeo(false), 900, true), insDF: mk(insulGeo(true), 900, true) };
    return inst;
  }
  function place(mesh, k, R, s, lat, full) {
    MT.frameAt(R, s, F2);
    _x.set(F2.tx, F2.ty, F2.tz); _y.set(F2.ux, F2.uy, F2.uz); _z.set(F2.rx, F2.ry, F2.rz);
    _m4.makeBasis(_x, _y, _z); _m4.setPosition(F2.x + F2.rx * lat, F2.y + F2.ry * lat, F2.z + F2.rz * lat); mesh.setMatrixAt(k, _m4);
  }
  function updateInstances(cam, TRACKS) {
    if (!MATS) return;
    if (cam.distanceToSquared(lastC) < 144) return; lastC.copy(cam);
    const I = ensureInst(); let nF = 0, nFF = 0, nT = 0, nI = 0, nD = 0;
    const near = MT.net ? MT.net.nearAll(cam.x, cam.z, 190) : [];
    for (const q of near) {
      const R = MT.trackOf(q.track); if (!R) continue;
      MT.frameAt(R, q.s, F); if (Math.abs(F.y - cam.y) > 60) continue;
      const w = Math.sqrt(Math.max(0, 190 * 190 - q.dist * q.dist)); const a = Math.max(0, q.s - w), b = Math.min(R.len, q.s + w);
      for (const run of R.runs) {
        if (run.s1 <= a || run.s0 >= b) continue; const df = DF.has(run.type);
        const sp = df ? DIM.fastSpacing : DIM.tieSpacing;
        for (let s = Math.ceil(Math.max(a, run.s0) / sp) * sp; s < Math.min(b, run.s1); s += sp) {
          const dAlong = Math.abs(s - q.s), d = Math.hypot(dAlong, q.dist);
          if (df) { if (d < 45 && nFF < 2400) place(I.fastFull, nFF++, R, s, 0); else if (d < 190 && nF < 5000) place(I.fast, nF++, R, s, 0); }
          else if (nT < 3000) place(I.tie, nT++, R, s, 0);
        }
      }
      // insulators every T3.insulator m along the third rail (same side logic as the rail itself)
      for (let s = Math.ceil(Math.max(a, 14) / T3.insulator) * T3.insulator; s < Math.min(b, R.len - 14); s += T3.insulator) {
        if (Math.abs(s - q.s) > 150) continue;
        const run = R.runs.find(r => s >= r.s0 && s < r.s1), df = !!run && DF.has(run.type), mesh = df ? I.insDF : I.ins;
        const k = df ? nD++ : nI++; if (k >= 900) continue;
        const sd = MT.thirdSide(R, s); place(mesh, k, R, s, sd * T3.lat);
        if (sd < 0) { mesh.getMatrixAt(k, _m4); _m4.multiply(_flip); mesh.setMatrixAt(k, _m4); }
      }
    }
    I.fastFull.count = nFF; I.fast.count = nF; I.tie.count = nT; I.ins.count = Math.min(nI, 900); I.insDF.count = Math.min(nD, 900);
    for (const m of [I.fastFull, I.fast, I.tie, I.ins, I.insDF]) m.instanceMatrix.needsUpdate = true;
    MT.stats.inst = nFF + nF + nT + nI + nD;
  }

  function init(o) { MATS = o.MATS; }
  return { init, body, detail, far, updateInstances, lanes, owns, ownedRanges, sweepVar, fenceRun, tube, eraAt, spanJoints, RAIL, bedProfile };
})();
if (typeof window !== 'undefined') (window.__baylineMods = window.__baylineMods || {}).MetroGuide = MetroGuide;   // debug handle (window.__bayline.MetroGuide)
