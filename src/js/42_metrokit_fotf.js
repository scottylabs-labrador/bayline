// MetroKit: the Fleet of the Future-type D (cab) and E cars, exterior. Dimensions and sources: notes/bart/trains.md.
// Built once per (type, quality) and shared by every consist; see 41_metrokit.js for the kit.
(() => {
  const K = MetroKit._k, { MB, rrect, densify, fnorm, tr, rotY, rotZ, rotX, mul, M4, TAU } = K;
  const { clamp, lerp } = U;

  // ------------------------------------------------------------------------------------------ dimensions
  const F = {
    L: 21.336, HL: 10.668, BODY: 10.47, W: 1.6, FLOOR: 0.991, ROOF: 3.864, SKIRT: 0.62, CANT: 3.02, YC: 2.95, NSE: 3.0,
    DOORS: [-5.33, 0, 5.33], PORTAL: 0.68, PORTAL_TOP: 2.93, LEAF: 0.83, LEAF_Y0: 0.975, LEAF_Y1: 2.945, LEAF_T: 0.035,
    LWIN: 0.58, LWIN_M: 0.045, LWIN_Y0: 1.93, LWIN_Y1: 2.84,
    WIN_W: 0.97, WIN_Y0: 1.89, WIN_Y1: 2.84, WIN_R: 0.13, GASKET: 0.05,
    END_R: 0.10, NOSE_XC: 10.10, NOSE_R: 0.30,
    TRUCK: 7.62, WB: 2.13, WR: 0.381, GAUGE: 1.676,
    CAB_BACK: 8.46,
  };
  F.WIN_E = [-8.493, -7.511, -3.149, -2.167, 2.167, 3.149, 7.511, 8.493];
  F.WIN_D = [-8.493, -7.511, -3.149, -2.167, 2.167, 3.149, 7.511];
  K.FOTF = F;

  // ------------------------------------------------------------------------------------------ the body section
  // Right-hand half of the outer skin from the skirt's lower edge (t = 0) over the roof to the centreline (t = T):
  // a gentle tuck-under below the floor, vertical sides to 2.1 m, then a quarter superellipse (n = 3.2) to the roof top.
  // Sampled where the curve turns (adaptive), so flat parts cost nothing.
  function makeProfile(q) {
    const dense = [];
    for (let i = 0; i <= 60; i++) { const y = 0.62 + 0.38 * i / 60; dense.push([y, 1.6 - 0.095 * ((1.0 - y) / 0.38) ** 2]); }
    dense.push([1.55, 1.6]);
    // vertical side to YC, then a superellipse quadrant (the rounded eaves and a nearly flat, cambered roof)
    const YC = F.YC, B = F.ROOF - YC, e = 2 / F.NSE;
    for (let i = 0; i <= 600; i++) { const th = (i / 600) * Math.PI / 2; dense.push([YC + B * Math.pow(Math.sin(th), e), 1.6 * Math.pow(Math.cos(th), e)]); }
    // arc length and normals of the dense curve
    const n = dense.length, t = [0];
    for (let i = 1; i < n; i++) t.push(t[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
    const nrm = dense.map((p, i) => { const a = dense[Math.max(0, i - 1)], b = dense[Math.min(n - 1, i + 1)]; const dy = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dy, dz) || 1; return [-dz / l, dy / l]; });   // [ny, nz]
    nrm[n - 1] = [1, 0];
    const maxAng = [7, 4.5, 3, 2.2, 1.6][q] * Math.PI / 180, maxLen = 0.7;
    const S = { t: [0], y: [dense[0][0]], z: [dense[0][1]], ny: [nrm[0][0]], nz: [nrm[0][1]] };
    let last = 0;
    for (let i = 1; i < n; i++) {
      const a0 = Math.atan2(nrm[last][0], nrm[last][1]), a1 = Math.atan2(nrm[i][0], nrm[i][1]);
      if (i === n - 1 || Math.abs(a1 - a0) > maxAng || t[i] - t[last] > maxLen) { S.t.push(t[i]); S.y.push(dense[i][0]); S.z.push(dense[i][1]); S.ny.push(nrm[i][0]); S.nz.push(nrm[i][1]); last = i; }
    }
    S.z[S.z.length - 1] = 0; S.T = S.t[S.t.length - 1];
    S.dense = { t, p: dense, n: nrm };
    return S;
  }
  // point on the profile at arc length t (from the dense curve: exact enough for any t)
  function profAt(P, t, out) {
    const T = P.dense.t, n = T.length; t = clamp(t, 0, T[n - 1]);
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    const f = (t - T[lo]) / ((T[hi] - T[lo]) || 1), a = P.dense.p[lo], b = P.dense.p[hi], na = P.dense.n[lo], nb = P.dense.n[hi];
    out.y = a[0] + (b[0] - a[0]) * f; out.z = a[1] + (b[1] - a[1]) * f;
    let ny = na[0] + (nb[0] - na[0]) * f, nz = na[1] + (nb[1] - na[1]) * f; const l = Math.hypot(ny, nz) || 1; out.ny = ny / l; out.nz = nz / l;
    return out;
  }
  function tAtY(P, y) {            // (the side part only: y increases monotonically with t up to the roof top)
    const p = P.dense.p, T = P.dense.t; let lo = 0, hi = p.length - 1;
    if (y <= p[0][0]) return 0;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m][0] <= y) lo = m; else hi = m; }
    const f = (y - p[lo][0]) / ((p[hi][0] - p[lo][0]) || 1); return T[lo] + (T[hi] - T[lo]) * f;
  }
  const _pp = { y: 0, z: 0, ny: 0, nz: 0 };
  // body surface at (x, t) on side s (+1 right, -1 left), pushed out along the normal by off
  function bodyAt(P, x, t, s, off) { profAt(P, t, _pp); return { p: [x, _pp.y + _pp.ny * off, s * (_pp.z + _pp.nz * off)], n: [0, _pp.ny, s * _pp.nz], ty: t }; }

  // ------------------------------------------------------------------------------------------ gridded walls with rounded holes
  // A patch of the body surface over [xa, xb] x [ta, tb] on side s, offset off, with holes {x0, x1, t0, t1, r: [bl, br, tr, tl]}.
  // The grid's rows are the profile samples plus every hole's corner lines; each hole's rounded corners are closed with
  // fans from the corner point, so openings are exact whatever the grid. palAt(xm, tm) names the palette of a cell.
  function sideGrid(mb, P, s, xa, xb, ta, tb, holes, palAt, off = 0, extraX = [], extraT = []) {
    const R = h => Array.isArray(h.r) ? h.r : [h.r, h.r, h.r, h.r];
    const xs = new Set([xa, xb, ...extraX]), ts = new Set([ta, tb, ...extraT]);
    for (const t of P.t) if (t > ta && t < tb) ts.add(t);
    for (const h of holes) { const r = R(h); xs.add(h.x0); xs.add(h.x1); ts.add(h.t0); ts.add(h.t1);
      for (const [xr, tr_] of [[h.x0 + r[0], h.t0 + r[0]], [h.x1 - r[1], h.t0 + r[1]], [h.x1 - r[2], h.t1 - r[2]], [h.x0 + r[3], h.t1 - r[3]]]) { xs.add(xr); ts.add(tr_); } }
    const X = [...xs].filter(v => v >= xa - 1e-6 && v <= xb + 1e-6).sort((a, b) => a - b), T = [...ts].filter(v => v >= ta - 1e-6 && v <= tb + 1e-6).sort((a, b) => a - b);
    const ux = [], ut = []; for (const v of X) if (!ux.length || v - ux[ux.length - 1] > 1e-5) ux.push(v); for (const v of T) if (!ut.length || v - ut[ut.length - 1] > 1e-5) ut.push(v);
    // vertices are shared between cells of the same palette entry only (a vertex carries its cell's palette texel)
    const vid = new Map(), key = (i, j) => (mb.u * 256 * 4096 + i) * 4096 + j;
    const V = (i, j) => { const k = key(i, j); let id = vid.get(k); if (id === undefined) { const b = bodyAt(P, ux[i], ut[j], s, off); id = mb.v(b.p[0], b.p[1], b.p[2], b.n[0], b.n[1], b.n[2], ux[i], ut[j], b.ty); vid.set(k, id); } return id; };
    const quadW = (a, b, c, d) => { if (s > 0) mb.quad(a, b, c, d); else mb.quad(a, d, c, b); };
    const triW = (a, b, c) => { if (s > 0) mb.tri(a, b, c); else mb.tri(a, c, b); };
    for (let i = 0; i < ux.length - 1; i++) for (let j = 0; j < ut.length - 1; j++) {
      const xm = (ux[i] + ux[i + 1]) / 2, tm = (ut[j] + ut[j + 1]) / 2;
      let skip = false, corner = null;
      for (const h of holes) {
        if (xm < h.x0 || xm > h.x1 || tm < h.t0 || tm > h.t1) continue;
        const r = R(h);
        const cs = [[h.x0, h.t0, r[0], 1, 1], [h.x1, h.t0, r[1], -1, 1], [h.x1, h.t1, r[2], -1, -1], [h.x0, h.t1, r[3], 1, -1]];
        for (const [cx, ct, rr, dx, dt] of cs) if (rr > 1e-5 && (xm - cx) * dx < rr && (tm - ct) * dt < rr) corner = [cx, ct, rr, dx, dt];
        if (!corner) skip = true;
        break;
      }
      if (skip) continue;
      mb.pal(palAt(xm, tm));
      if (!corner) { quadW(V(i, j), V(i + 1, j), V(i + 1, j + 1), V(i, j + 1)); continue; }
      // corner fan: from the cell's outer corner along the arc (centre at cx + dx r, ct + dt r)
      const [cx, ct, rr, dx, dt] = corner, ccx = cx + dx * rr, cct = ct + dt * rr, k = 7;
      const ci = mb.v(...(b => [...b.p, ...b.n, cx, ct, b.ty])(bodyAt(P, cx, ct, s, off)));
      const a0 = Math.atan2(-dt, 0), a1 = Math.atan2(0, -dx);
      let prev = null;
      for (let q = 0; q <= k; q++) {
        let a = a0 + (((a1 - a0 + 3 * Math.PI) % TAU) - Math.PI) * q / k;
        const px = ccx + rr * Math.cos(a), pt = cct + rr * Math.sin(a), b = bodyAt(P, px, pt, s, off);
        const id = mb.v(b.p[0], b.p[1], b.p[2], b.n[0], b.n[1], b.n[2], px, pt, b.ty);
        if (prev !== null) mb.triA(ci, prev, id);
        prev = id;
      }
    }
  }
  // outline in (x, t) -> points; ring between two outlines of equal length (gaskets), mapped on the surface
  function ring(mb, P, s, outer, inner, offO, offI, pal, twoSided = false) {
    mb.pal(pal); const n = outer.length, base = mb.count;
    for (const [o, off] of [[outer, offO], [inner, offI]]) for (const [x, t] of o) { const b = bodyAt(P, x, t, s, off); mb.v(b.p[0], b.p[1], b.p[2], b.n[0], b.n[1], b.n[2], x, t, b.ty); }
    for (let i = 0; i < n; i++) { const i2 = (i + 1) % n, a = base + i, b = base + i2, c = base + n + i2, d = base + n + i;
      if (twoSided) { mb.quad(a, b, c, d); mb.quad(a, d, c, b); } else mb.quadA(a, b, c, d); }
  }
  // a closed outline in (x, t) filled (earcut), on the body surface at offset off (glass panes)
  function fill(mb, P, s, outline, off, pal, holes = []) {
    mb.pal(pal);
    mb.shape(outline, holes, (x, t) => bodyAt(P, x, t, s, off), (x, t) => [x, t]);
  }
  const rrXT = (P, x0, x1, y0, y1, r, k = 7) => { const t0 = tAtY(P, y0), t1 = tAtY(P, y1); return rrect(x0, t0, x1, t1, r, k); };

  // ------------------------------------------------------------------------------------------ bones
  // 0 body; 1, 2 bogies (+X, -X); 3..6 wheelsets (bogie 1: +, -; bogie 2: +, -); 7..18 door leaves; 19, 20 wipers
  const BONE = { body: 0, bogie: [1, 2], axle: [3, 4, 5, 6], leaf: (d, s, k) => 7 + d * 4 + (s > 0 ? 0 : 2) + (k < 0 ? 0 : 1), wiper: [19, 20], handle: 21, N: 22 };
  K.FOTF_BONE = BONE;


  // ------------------------------------------------------------------------------------------ decals
  // A decal quad on the body surface: centre (xc, yc), size w x h, standing off above the skin; reads left to right
  // for a viewer on that side. cell = atlas cell name. Subdivided along x so it follows curved skins.
  function decalSide(E, P, s, xc, yc, w, h, cell, off = 0.0025) {
    const r = K.ATL[cell]; if (!r) return;
    E.pal('decal'); const nx = 4, t0 = tAtY(P, yc - h / 2), t1 = tAtY(P, yc + h / 2), base = E.count;
    for (let i = 0; i <= nx; i++) for (const [t, v] of [[t0, r[1]], [t1, r[3]]]) {
      const f = i / nx, xx = s > 0 ? xc - w / 2 + w * f : xc + w / 2 - w * f, b = bodyAt(P, xx, t, s, off);
      E.v(b.p[0], b.p[1], b.p[2], b.n[0], b.n[1], b.n[2], r[0] + (r[2] - r[0]) * f, v, b.ty);
    }
    for (let i = 0; i < nx; i++) { const a = base + i * 2; E.quadA(a, a + 2, a + 3, a + 1); }
  }
  // car-number glyph run (per-car digits from the mkNum uniform): slots 0..n-1 left to right
  function numberSide(E, P, s, xc, yc, gh, slots, style, off = 0.0028) {
    const n = slots.length; E.pal(style === 'black' ? 'numK' : 'numW'); const gw = gh * 0.6, w = gw * n, t0 = tAtY(P, yc - gh / 2), t1 = tAtY(P, yc + gh / 2);
    for (let k = 0; k < n; k++) {
      const xa = s > 0 ? xc - w / 2 + k * gw : xc + w / 2 - k * gw, xb = s > 0 ? xa + gw : xa - gw, slot = slots[k];
      const c = [[xa, t0, slot + 0.001, 0], [xb, t0, slot + 0.999, 0], [xb, t1, slot + 0.999, 1], [xa, t1, slot + 0.001, 1]].map(([x, t, u, v]) => { const b = bodyAt(P, x, t, s, off); return E.v(b.p[0], b.p[1], b.p[2], b.n[0], b.n[1], b.n[2], u, v, b.ty); });
      E.quadA(c[0], c[1], c[2], c[3]);
    }
  }
  // flat decal on a plane: centre c, axes (right, up) unit vectors, normal n, size w x h, uv from an atlas cell or a glyph slot
  function decalPlane(E, c, right, up, n, w, h, uvq, pal) {
    E.pal(pal); const ids = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b], i) => E.v(c[0] + right[0] * a * w / 2 + up[0] * b * h / 2, c[1] + right[1] * a * w / 2 + up[1] * b * h / 2, c[2] + right[2] * a * w / 2 + up[2] * b * h / 2, n[0], n[1], n[2], uvq[i][0], uvq[i][1]));
    E.quadA(ids[0], ids[1], ids[2], ids[3]);
  }
  function carDecals(E, P, isD) {
    E.bone = 0;
    for (const s of [1, -1]) {
      // E-car ends (both), D rear: plate on the blue band at window height, number low on the band
      const ends = isD ? [-1] : [1, -1];
      // (the number carries the end letter: X at the -X end, Y at the +X end; the D car's cab is its Y end)
      for (const e of ends) { decalSide(E, P, s, e * 10.03, 2.27, 0.43, 0.43, 'sticker'); numberSide(E, P, s, e * 10.03, 0.99, 0.16, [0, 1, 2, 3, e > 0 ? 5 : 4], 'white'); }
      if (isD) { decalSide(E, P, s, 9.62, 1.27, 0.3, 0.2, 'flag'); numberSide(E, P, s, 9.6, 1.0, 0.15, [0, 1, 2, 3, 5], 'white'); }
      // priority / bike / wheelchair pictograms on the door leaves' neighbours (beside the doors, at eye height)
      decalSide(E, P, s, (s > 0 ? 1 : -1) * 5.33 + (s > 0 ? -0.85 : 0.85), 2.28, 0.12, 0.12, 'bike');
      decalSide(E, P, s, 0 + (s > 0 ? -0.85 : 0.85), 2.28, 0.12, 0.12, 'wheelchair');
    }
    // roof numbers: big black digits across the roof near each end, tops toward the end
    for (const e of isD ? [-1] : [1, -1]) {
      const gh = 0.62, gw = 0.4, n = 4, xc = e * 9.2, y = F.ROOF + 0.002;
      for (let k = 0; k < n; k++) {
        const zc = e * (-(n * gw) / 2 + (k + 0.5) * gw);    // reading direction: +Z at the +X end, -Z at the -X end
        const c = [xc, y - 0.004 * Math.abs(zc), zc], right = [0, 0, e], up = [e, 0, 0];
        decalPlane(E, c, right, up, [0, 1, 0], gw * 0.98, gh, [[k + 0.001, 0], [k + 0.999, 0], [k + 0.999, 1], [k + 0.001, 1]], 'numK');
      }
    }
    if (isD) {       // the nose mark on the white lower part of the cab door, and the front roof number
      const yc = 1.7, zc = 0, x = faceX(yc, 0) + 0.0025, r = K.ATL.noseMark;
      decalPlane(E, [x, yc, zc], [0, 0, -1], [0, 1, 0], [1, 0, 0], 0.48, 0.24, [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]], 'decal');
      const gh = 0.62, gw = 0.4, n = 4, xc = 9.0, y = F.ROOF + 0.002;
      for (let k = 0; k < n; k++) { const zc2 = -(n * gw) / 2 + (k + 0.5) * gw; decalPlane(E, [xc, y - 0.004 * Math.abs(zc2), zc2], [0, 0, 1], [1, 0, 0], [0, 1, 0], gw * 0.98, gh, [[k + 0.001, 0], [k + 0.999, 0], [k + 0.999, 1], [k + 0.001, 1]], 'numK'); }
    }
  }

  // ------------------------------------------------------------------------------------------ the design
  function buildFotf(type, q) {
    const isD = type === 'D', P = makeProfile(q), E = new MB(), G = new MB();   // E: palette (body etc.), G: glass
    K.decalAtlas();
    const alu = isD ? 'aluD' : 'aluE';
    const tCant = tAtY(P, F.CANT), tFloor = tAtY(P, F.FLOOR);
    const xFront = isD ? F.NOSE_XC : F.BODY - F.END_R, xRear = -(F.BODY - F.END_R);
    const wins = isD ? F.WIN_D : F.WIN_E;
    const palSide = (xm, tm) => tm > tCant ? 'roof' : alu;
    const leafHole = (dc) => ({ x0: dc - F.LEAF, x1: dc + F.LEAF, t0: tAtY(P, F.LEAF_Y0), t1: tAtY(P, F.LEAF_Y1), r: [0, 0, 0.03, 0.03] });
    for (const s of [1, -1]) {
      const holes = [];
      for (const xc of wins) holes.push({ x0: xc - F.WIN_W / 2, x1: xc + F.WIN_W / 2, t0: tAtY(P, F.WIN_Y0), t1: tAtY(P, F.WIN_Y1), r: F.WIN_R });
      for (const dc of F.DOORS) holes.push(leafHole(dc));
      if (isD) holes.push({ x0: 9.2, x1: 9.76, t0: tAtY(P, 1.89), t1: tAtY(P, 2.84), r: 0.11 });
      E.bone = 0;
      sideGrid(E, P, s, xRear, xFront, 0, P.T, holes, palSide, 0, [], [tCant]);
      // window gaskets + glass
      for (const xc of wins) {
        const o = rrXT(P, xc - F.WIN_W / 2, xc + F.WIN_W / 2, F.WIN_Y0, F.WIN_Y1, F.WIN_R);
        const gi = rrXT(P, xc - F.WIN_W / 2 + F.GASKET, xc + F.WIN_W / 2 - F.GASKET, F.WIN_Y0 + F.GASKET, F.WIN_Y1 - F.GASKET, F.WIN_R - 0.045);
        ring(E, P, s, o, gi, 0.003, -0.022, 'rubber');
        G.bone = 0; fill(G, P, s, gi, -0.022, 'lensClear');
      }
      if (isD) {
        const o = rrXT(P, 9.2, 9.76, 1.89, 2.84, 0.11), gi = rrXT(P, 9.2 + F.GASKET, 9.76 - F.GASKET, 1.89 + F.GASKET, 2.84 - F.GASKET, 0.07);
        ring(E, P, s, o, gi, 0.003, -0.022, 'rubber'); fill(G, P, s, gi, -0.022, 'lensClear');
      }
      // door frames (recessed behind the leaves), jambs, thresholds, and the leaves themselves
      for (let d = 0; d < 3; d++) doorway(E, G, P, s, F.DOORS[d], d);
      // exterior furniture on the side: speaker grilles, access panels, door lamps, side LED signs
      sideFurniture(E, P, s, isD);
    }
    // ends: E both, D the rear; D gets the nose
    endCap(E, G, P, -1, isD);
    if (isD) nose(E, G, P); else endCap(E, G, P, 1, false);
    underframe(E, P, isD);
    for (let b = 0; b < 2; b++) bogie(E, b);
    roofDetail(E, P, isD);
    carDecals(E, P, isD);
    const ext = E.geometry(), glass = G.geometry();
    return { ext, glass, P, tris: (E.I.length + G.I.length) / 3 };
  }

  // ------------------------------------------------------------------------------------------ doorway (one side)
  function doorway(E, G, P, s, dc, d) {
    const tL0 = tAtY(P, F.LEAF_Y0), tL1 = tAtY(P, F.LEAF_Y1), tP1 = tAtY(P, F.PORTAL_TOP), tF = tAtY(P, F.FLOOR);
    E.bone = 0;
    // the frame the leaves close against: the band between the leaf outline and the portal, recessed by the leaf thickness
    const recess = -F.LEAF_T;
    E.pal('frame');
    const band = (x0, x1, t0, t1, pal) => { E.pal(pal); const pts = [[x0, t0], [x1, t0], [x1, t1], [x0, t1]].map(([x, t]) => bodyAt(P, x, t, s, recess));
      const id = pts.map((b, i) => E.v(b.p[0], b.p[1], b.p[2], b.n[0], b.n[1], b.n[2], 0, 0, b.ty)); if (s > 0) E.quad(id[0], id[1], id[2], id[3]); else E.quad(id[0], id[3], id[2], id[1]); };
    band(dc - F.LEAF, dc - F.PORTAL, tL0, tL1, 'rubber'); band(dc + F.PORTAL, dc + F.LEAF, tL0, tL1, 'rubber');
    band(dc - F.PORTAL, dc + F.PORTAL, tP1, tL1, 'rubber'); band(dc - F.PORTAL, dc + F.PORTAL, tL0, tF, 'frame');
    // the leaf-thickness walls of the hole (seen when the leaves are open): top and sides
    const edge = (xa, ta, xb, tb, pal) => { E.pal(pal); const A = bodyAt(P, xa, ta, s, 0), B = bodyAt(P, xb, tb, s, 0), C = bodyAt(P, xb, tb, s, recess), D = bodyAt(P, xa, ta, s, recess);
      const n = fnorm(A.p, B.p, C.p); const ids = [A, B, C, D].map(b => E.v(b.p[0], b.p[1], b.p[2], n[0], n[1], n[2], 0, 0, b.ty)); E.quad(ids[0], ids[1], ids[2], ids[3]); E.quad(ids[0], ids[3], ids[2], ids[1]); };
    edge(dc - F.LEAF, tL0, dc - F.LEAF, tL1, 'rubber'); edge(dc + F.LEAF, tL0, dc + F.LEAF, tL1, 'rubber'); edge(dc - F.LEAF, tL1, dc + F.LEAF, tL1, 'rubber');
    // jambs: the portal's sides and head from the frame inward to the inner wall (0.10 m of wall), and the threshold
    const depth = -0.125;
    for (const [xa, xb, ta, tb] of [[dc - F.PORTAL, dc - F.PORTAL, tF, tP1], [dc + F.PORTAL, dc + F.PORTAL, tF, tP1], [dc - F.PORTAL, dc + F.PORTAL, tP1, tP1]]) {
      E.pal('wallInt2'); const A = bodyAt(P, xa, ta, s, recess), B = bodyAt(P, xb, tb, s, recess), C = bodyAt(P, xb, tb, s, depth), D = bodyAt(P, xa, ta, s, depth);
      const n = fnorm(A.p, B.p, C.p); const ids = [A, B, C, D].map(b => E.v(b.p[0], b.p[1], b.p[2], n[0], n[1], n[2], 0, 0, b.ty)); E.quad(ids[0], ids[1], ids[2], ids[3]); E.quad(ids[0], ids[3], ids[2], ids[1]);
    }
    // threshold: tread plate from the skin to the inner wall at floor level, a rubber gap-filler lip outboard
    E.pal('tread'); const zo = s * F.W, zi = s * (F.W - 0.16);
    E.box(dc - F.PORTAL, F.FLOOR - 0.012, Math.min(zo, zi), dc + F.PORTAL, F.FLOOR + 0.004, Math.max(zo, zi));
    E.pal('rubber'); E.box(dc - F.PORTAL, F.FLOOR - 0.03, Math.min(zo, zo + s * 0.018), dc + F.PORTAL, F.FLOOR, Math.max(zo, zo + s * 0.018));
    // the two leaves
    for (const k of [-1, 1]) leaf(E, G, P, s, dc, d, k);
  }
  // One plug-door leaf, built closed (flush with the skin), bound to its bone. k = -1: the leaf on the -X side of the
  // door centre (it slides toward -X), +1 the other. Meeting edges at dc.
  function leaf(E, G, P, s, dc, d, k) {
    const bone = BONE.leaf(d, s, k); E.bone = bone; G.bone = bone;
    const a = k < 0 ? dc - F.LEAF : dc, b = k < 0 ? dc : dc + F.LEAF, gap = 0.004;
    const t0 = tAtY(P, F.LEAF_Y0) + gap, t1 = tAtY(P, F.LEAF_Y1) - gap;
    const wx0 = k < 0 ? b - F.LWIN_M - F.LWIN : a + F.LWIN_M, wx1 = wx0 + F.LWIN;
    const win = { x0: wx0, x1: wx1, t0: tAtY(P, F.LWIN_Y0), t1: tAtY(P, F.LWIN_Y1), r: 0.1 };
    // outer skin (aluminium, belt line), window gasket, glass
    sideGrid(E, P, s, a + gap, b - gap, t0, t1, [win], () => 'aluDoor', 0, [], []);
    const o = rrXT(P, wx0, wx1, F.LWIN_Y0, F.LWIN_Y1, 0.1), gi = rrXT(P, wx0 + 0.04, wx1 - 0.04, F.LWIN_Y0 + 0.04, F.LWIN_Y1 - 0.04, 0.065);
    ring(E, P, s, o, gi, 0.002, -0.018, 'rubber');
    fill(G, P, s, gi, -0.018, 'lensClear');
    // inner skin (light grey panel) with the same window, seen from inside
    const inner = new MB(); inner.bone = bone;
    sideGrid(inner, P, s, a + gap, b - gap, t0, t1, [win], () => 'wallInt2', -F.LEAF_T, [], []);
    // flip the inner skin to face inward
    for (let i = 0; i < inner.I.length; i += 3) { const t = inner.I[i + 1]; inner.I[i + 1] = inner.I[i + 2]; inner.I[i + 2] = t; }
    for (let i = 0; i < inner.N.length; i++) inner.N[i] = -inner.N[i];
    E.append(inner);
    // window reveal (leaf thickness) and edges: the meeting edge carries a rubber nose, the others dark seals
    const gi2 = rrXT(P, wx0, wx1, F.LWIN_Y0, F.LWIN_Y1, 0.1);
    ring(E, P, s, gi2, gi2, -0.018, -F.LEAF_T, 'rubber', true);
    const side = (x, pal, nose) => {
      E.pal(pal); const A = bodyAt(P, x, t0, s, 0), B = bodyAt(P, x, t1, s, 0), C = bodyAt(P, x, t1, s, -F.LEAF_T), D = bodyAt(P, x, t0, s, -F.LEAF_T);
      const n = [x > dc - 1e-6 === (k > 0) ? -1 : 1, 0, 0];
      if (nose) { const push = (b, dx) => [b.p[0] + dx, b.p[1], b.p[2]]; const dx = (k < 0 ? 1 : -1) * 0.006;
        const ids = [push(A, dx), push(B, dx), push(C, dx), push(D, dx)].map(p => E.v(p[0], p[1], p[2], n[0], n[1], n[2])); E.quad(ids[0], ids[1], ids[2], ids[3]); E.quad(ids[0], ids[3], ids[2], ids[1]); }
      else { const ids = [A, B, C, D].map(bb => E.v(bb.p[0], bb.p[1], bb.p[2], n[0], n[1], n[2])); E.quad(ids[0], ids[1], ids[2], ids[3]); E.quad(ids[0], ids[3], ids[2], ids[1]); }
    };
    side(k < 0 ? b - gap : a + gap, 'rubber', true); side(k < 0 ? a + gap : b - gap, 'rubber', false);
    for (const t of [t0, t1]) { E.pal('rubber'); const A = bodyAt(P, a + gap, t, s, 0), B = bodyAt(P, b - gap, t, s, 0), C = bodyAt(P, b - gap, t, s, -F.LEAF_T), D = bodyAt(P, a + gap, t, s, -F.LEAF_T);
      const ids = [A, B, C, D].map(bb => E.v(bb.p[0], bb.p[1], bb.p[2], 0, t === t0 ? -1 : 1, 0)); E.quad(ids[0], ids[1], ids[2], ids[3]); E.quad(ids[0], ids[3], ids[2], ids[1]); }
    E.bone = 0; G.bone = 0;
  }

  // ------------------------------------------------------------------------------------------ side furniture
  function sideFurniture(E, P, s, isD) {
    E.bone = 0;
    const onSkin = (x0, x1, y0, y1, off, pal) => {       // a small panel standing `off` proud of the skin (flat patch following the surface)
      const t0 = tAtY(P, y0), t1 = tAtY(P, y1); E.pal(pal);
      const c = [[x0, t0], [x1, t0], [x1, t1], [x0, t1]].map(([x, t]) => bodyAt(P, x, t, s, off));
      const ids = c.map(b => E.v(b.p[0], b.p[1], b.p[2], b.n[0], b.n[1], b.n[2], 0, 0, b.ty)); if (s > 0) E.quad(ids[0], ids[1], ids[2], ids[3]); else E.quad(ids[0], ids[3], ids[2], ids[1]);
      // rim
      const c0 = [[x0, t0], [x1, t0], [x1, t1], [x0, t1]].map(([x, t]) => bodyAt(P, x, t, s, 0));
      for (let i = 0; i < 4; i++) { const i2 = (i + 1) % 4, A = c0[i], B = c0[i2], C = c[i2], D = c[i]; const n = fnorm(A.p, B.p, C.p);
        const ids2 = [A, B, C, D].map(b => E.v(b.p[0], b.p[1], b.p[2], n[0], n[1], n[2], 0, 0, b.ty)); E.quad(ids2[0], ids2[1], ids2[2], ids2[3]); E.quad(ids2[0], ids2[3], ids2[2], ids2[1]); }
    };
    // per window pair between two doors: a speaker grille under the window next to one door, a tall access panel next
    // to the other (rotationally symmetric along the car); both sit on the belt line level
    const pairs = [[-5.33, 0], [0, 5.33]];
    for (const [da, db] of pairs) {
      const ga = s > 0 ? db : da;          // grille next to this door
      const gx = ga + (ga > (da + db) / 2 ? -1 : 1) * 1.75;
      onSkin(gx - 0.26, gx + 0.26, F.FLOOR + 0.45, F.FLOOR + 0.82, 0.006, 'grille');
      const pa = s > 0 ? da : db, px = pa + (pa > (da + db) / 2 ? -1 : 1) * 1.05;
      onSkin(px - 0.2, px + 0.2, F.FLOOR + 0.02, F.FLOOR + 0.55, 0.004, 'aluDull');
      onSkin(px - 0.12, px + 0.12, F.FLOOR + 0.08, F.FLOOR + 0.47, 0.007, 'frame');
      onSkin(gx + (gx < (da + db) / 2 ? 0.34 : -0.44), gx + (gx < (da + db) / 2 ? 0.44 : -0.34), F.FLOOR + 0.5, F.FLOOR + 0.6, 0.005, 'aluDull');
    }
    // red door-status lamps above the window beside each door (both window sides of the door where a window exists)
    for (const dc of F.DOORS) for (const dir of [-1, 1]) {
      const wx = dc + dir * (F.PORTAL + 0.196 + 0.87 + 0.435 - 0.35);
      const ok = (isD ? F.WIN_D : F.WIN_E).some(w => Math.abs(w - (dc + dir * 2.167)) < 0.01 || Math.abs(w - (dc + dir * 2.181)) < 0.3);
      if (!ok) continue;
      const lx = dc + dir * 1.63;
      onSkin(lx - 0.035, lx + 0.035, 2.9, 2.935, 0.008, s > 0 ? 'doorLampR' : 'doorLampL');
    }
  }

  // ------------------------------------------------------------------------------------------ car ends
  // The section closed by a rounded edge (radius END_R) and a flat blue end wall with an end door, grab rungs, marker lamps.
  function sectionLoop(P) {           // right side up over the roof and down the left: [{y, z, ny, nz, u}]
    const L = [];
    for (let i = 0; i < P.t.length; i++) L.push({ y: P.y[i], z: P.z[i], ny: P.ny[i], nz: P.nz[i] });
    for (let i = P.t.length - 2; i >= 0; i--) L.push({ y: P.y[i], z: -P.z[i], ny: P.ny[i], nz: -P.nz[i] });
    return L;
  }
  function endCap(E, G, P, e, isD) {        // e = +1 / -1: which end
    E.bone = 0;
    const R = F.END_R, xs = e * (F.BODY - R), L = sectionLoop(P), n = L.length, A = 6;
    // fillet ring
    const base = E.count;
    for (let i = 0; i < n; i++) for (let j = 0; j <= A; j++) {
      const a = (j / A) * Math.PI / 2, off = R * (1 - Math.cos(a)), p = L[i];
      const nx = Math.sin(a) * e, sc = Math.cos(a);
      E.pal(p.y > F.CANT + 0.05 ? 'roof' : 'blue');
      E.v(xs + e * R * Math.sin(a), p.y - p.ny * off, p.z - p.nz * off, nx, p.ny * sc, p.nz * sc, 0, 0, 0);
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < A; j++) { const a = base + i * (A + 1) + j, b = a + A + 1; E.quadA(a, b, b + 1, a + 1); }
    // flat end wall inside the offset loop (earcut), closed at the bottom; hole for the end door window
    const face = L.map(p => [p.z - p.nz * R, p.y - p.ny * R]);
    const outline = densify(face, 0.25);
    const dwin = rrect(-0.2, 2.0, 0.2, 2.86, 0.08, 5);
    E.pal('blue');
    E.shape(e > 0 ? outline.slice().reverse() : outline, [e > 0 ? dwin : dwin.slice().reverse()], (z, y) => ({ p: [e * F.BODY, y, z], n: [e, 0, 0] }));
    // end door: seam lines, window gasket, glass; grab rungs; marker lamps; the step and the inter-car barrier flaps
    const x = e * (F.BODY + 0.002);
    E.pal('seam');
    for (const [z0, z1, y0, y1] of [[-0.41, -0.395, 0.99, 2.95], [0.395, 0.41, 0.99, 2.95], [-0.41, 0.41, 2.935, 2.95]]) E.box(x - 0.002, y0, z0, x + 0.002, y1, z1);
    E.pal('rubber'); E.box(x - 0.003, 1.97, -0.23, x + 0.004, 2.89, 0.23);
    G.bone = 0; G.pal('lensClear'); G.shape(dwin, [], (z, y) => ({ p: [e * (F.BODY - 0.012), y, z], n: [e, 0, 0] }));
    E.pal('chrome');
    for (const zs of [-1, 1]) for (let k = 0; k < 6; k++) { const y = 1.25 + k * 0.29, z = zs * 1.24;
      E.cyl([x, y, z - 0.1], [x + e * 0.055, y, z - 0.1], 0.012, 0.012, 6); E.cyl([x, y, z + 0.1], [x + e * 0.055, y, z + 0.1], 0.012, 0.012, 6);
      E.cyl([x + e * 0.055, y, z - 0.1], [x + e * 0.055, y, z + 0.1], 0.014, 0.014, 6); }
    for (const zs of [-1, 1]) { E.pal('podBlack'); E.cyl([x, 1.1, zs * 0.95], [x + e * 0.03, 1.1, zs * 0.95], 0.06, 0.06, 14);
      E.pal('tailLamp'); E.cyl([x + e * 0.03, 1.1, zs * 0.95], [x + e * 0.036, 1.1, zs * 0.95], 0.045, 0.045, 14); }
    // inter-car barrier flaps (rubber) at both outer corners, reaching into the gap
    E.pal('rubber');
    for (const zs of [-1, 1]) E.box(x, 1.05, zs * 1.38 - 0.012, x + e * 0.19, 2.75, zs * 1.38 + 0.012);
    // underframe end: headstock and anticlimber below the end wall
    E.pal('frame'); E.box(e * (F.BODY - 0.25), 0.62, -1.4, e * (F.BODY + 0.01), 0.76, 1.4);
    coupler(E, e, false);
  }
  // Dellner-type coupler: draft gear under the end, shank, head (face at +-HL), electrical head, DC warning plate (fronts)
  function coupler(E, e, front) {
    E.bone = 0; const y = 0.6, xf = e * F.HL;
    E.pal('frame'); E.box(e * (F.BODY - 0.9), y - 0.14, -0.22, e * (F.BODY - 0.15), y + 0.14, 0.22);
    E.pal('coupler'); E.cyl([e * (F.BODY - 0.2), y, 0], [xf - e * 0.12, y, 0], 0.07, 0.07, 10);
    E.box(xf - e * 0.13, y - 0.19, -0.17, xf, y + 0.19, 0.17);
    E.pal('frame'); E.cyl([xf - e * 0.02, y + 0.06, 0.07], [xf + e * 0.001, y + 0.06, 0.07], 0.055, 0.035, 12, false);
    E.pal('coupler'); E.cyl([xf - e * 0.1, y + 0.06, -0.08], [xf + e * 0.035, y + 0.06, -0.08], 0.03, 0.022, 10);
    E.pal('equip'); E.box(xf - e * 0.26, y - 0.36, -0.15, xf - e * 0.02, y - 0.2, 0.15);
    if (front) { E.pal('orange'); E.box(xf - e * 0.1, y - 0.34, -0.14, xf - e * 0.005, y - 0.22, 0.14);
      E.pal('yellow'); E.box(xf - e * 0.004, y - 0.33, -0.12, xf + e * 0.0005, y - 0.23, -0.06); E.box(xf - e * 0.004, y - 0.33, 0.06, xf + e * 0.0005, y - 0.23, 0.12); }
  }

  // ------------------------------------------------------------------------------------------ the D-car nose
  // The body section closed by a rounded edge of radius NOSE_R into a gently convex, raked front face.
  // D(y, z): x offset of the face (bulge in plan, rake back toward the top), blended into the fillet.
  const noseD = (y, z) => 0.07 * (1 - (z / 1.35) ** 2) - 0.05 * Math.max(0, y - 1.0);
  const faceX = (y, z) => F.NOSE_XC + F.NOSE_R + noseD(y, z);
  function faceN(y, z) { const e = 1e-3; const dy = (faceX(y + e, z) - faceX(y - e, z)) / (2 * e), dz = (faceX(y, z + e) - faceX(y, z - e)) / (2 * e); const l = Math.hypot(1, dy, dz); return [1 / l, -dy / l, -dz / l]; }
  const faceAt = (z, y, off = 0) => { const n = faceN(y, z); return { p: [faceX(y, z) + n[0] * off, y + n[1] * off, z + n[2] * off], n }; };
  // mask bottom edge (the black glazed band starts here), rising toward the sides
  const MASK_Y0 = 2.05, maskY0 = z => MASK_Y0;

  function nose(E, G, P) {
    E.bone = 0; G.bone = 0;
    const R = F.NOSE_R, xs = F.NOSE_XC, L = sectionLoop(P), n = L.length, A = 8;
    // fillet ring (blending the face deformation in with w = 1 - cos a)
    const base = E.count, ringPts = [];
    for (let i = 0; i < n; i++) for (let j = 0; j <= A; j++) {
      const a = (j / A) * Math.PI / 2, off = R * (1 - Math.cos(a)), p = L[i], w = 1 - Math.cos(a);
      const y = p.y - p.ny * off, z = p.z - p.nz * off;
      E.pal('cap');
      E.v(xs + R * Math.sin(a) + w * noseD(y, z), y, z, Math.sin(a), p.ny * Math.cos(a), p.nz * Math.cos(a), 0, 0, 0);
    }
    // normals of the ring from finite differences of its own grid (the deformation tilts them)
    const idx = (i, j) => base + i * (A + 1) + j;
    for (let i = 0; i < n; i++) for (let j = 0; j <= A; j++) {
      const P0 = mbP(E, idx(Math.min(n - 1, i + 1), j)), P1 = mbP(E, idx(Math.max(0, i - 1), j)), Q0 = mbP(E, idx(i, Math.min(A, j + 1))), Q1 = mbP(E, idx(i, Math.max(0, j - 1)));
      const du = [P0[0] - P1[0], P0[1] - P1[1], P0[2] - P1[2]], dv = [Q0[0] - Q1[0], Q0[1] - Q1[1], Q0[2] - Q1[2]];
      let nx = du[1] * dv[2] - du[2] * dv[1], ny = du[2] * dv[0] - du[0] * dv[2], nz = du[0] * dv[1] - du[1] * dv[0]; const l = Math.hypot(nx, ny, nz) || 1;
      const k = idx(i, j) * 3; const old = [E.N[k], E.N[k + 1], E.N[k + 2]]; if (nx * old[0] + ny * old[1] + nz * old[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      E.N[k] = nx / l; E.N[k + 1] = ny / l; E.N[k + 2] = nz / l;
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < A; j++) { const a = idx(i, j), b = idx(i + 1, j); E.quadA(a, b, b + 1, a + 1); }
    // the face: the inner offset loop, closed at the bottom
    const face = L.map(p => [p.z - p.nz * R, p.y - p.ny * R]);
    const yBot = face[0][1];
    makeFaceTop(face);
    const outline = densify(face, 0.12);           // (z, y), goes right side up, over, left side down: counter-clockwise seen from +X? check below
    // regions: mask (black) with holes for the windscreens and door window; white cap with holes for the mask, the
    // headlight pods and the dark recess under the bumper (the coupler pocket)
    const mask = maskOutline();
    const wsR = windscreen(1), wsL = windscreen(-1), dwin = rrect(-0.225, 2.09, 0.225, 3.24, 0.07, 5);
    const podR = podOutline(1), podL = podOutline(-1);
    const pocket = [[-0.86, yBot - 0.01], [0.86, yBot - 0.01], [0.86, 1.07], [-0.86, 1.07]];
    const ccw = poly => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return a > 0 ? poly : poly.slice().reverse(); };
    const cw = poly => ccw(poly).slice().reverse();
    // the face outline with the pocket cut into its bottom edge (a notch), so the white face ends at the pocket
    const dz = densify(face, 0.12), inPocket = q => Math.abs(q[0]) < 0.86 && q[1] < 1.07, out2 = [];
    for (let i = 0; i < dz.length; i++) {
      const q = dz[i], nx = dz[(i + 1) % dz.length];
      if (!inPocket(q)) out2.push(q);
      if (!inPocket(q) && inPocket(nx)) { const dir = Math.sign(nx[0] - q[0]) || 1; const zA = -dir * 0.86, zB = dir * 0.86;
        out2.push([zA, q[1]], [zA, 1.07], [zB, 1.07], [zB, q[1]]); }
    }
    E.pal('cap');
    E.shape(ccw(out2), [cw(mask), cw(podR), cw(podL)], (z, y) => faceAt(z, y));
    E.pal('mask');
    E.shape(ccw(densify(mask, 0.15)), [cw(wsR), cw(wsL), cw(dwin)], (z, y) => faceAt(z, y, 0.0005));
    // windscreens and door window glass, set 1.2 cm in; thin rubber edges
    for (const ws of [wsR, wsL, dwin]) {
      G.pal('lensClear'); G.shape(ccw(ws), [], (z, y) => faceAt(z, y, -0.012));
      E.pal('rubber');
      for (let i = 0; i < ws.length; i++) { const a = ws[i], b = ws[(i + 1) % ws.length]; const A1 = faceAt(a[0], a[1], 0.0005).p, B1 = faceAt(b[0], b[1], 0.0005).p, C1 = faceAt(b[0], b[1], -0.012).p, D1 = faceAt(a[0], a[1], -0.012).p;
        const nn = fnorm(A1, B1, C1); const ids = [A1, B1, C1, D1].map(p => E.v(p[0], p[1], p[2], nn[0], nn[1], nn[2])); E.quad(ids[0], ids[1], ids[2], ids[3]); E.quad(ids[0], ids[3], ids[2], ids[1]); }
    }
    // the coupler pocket: a dark box behind the notch
    { const x0 = faceX(0.9, 0) - 0.34, y0 = yBot - 0.01;
      E.pal('frame'); E.box(x0, y0, -0.86, x0 + 0.02, 1.07, 0.86);
      E.box(x0, 1.05, -0.86, faceX(1.07, 0), 1.07, 0.86);
      for (const zs of [-1, 1]) { const x1 = faceX(1.0, zs * 0.86); E.box(x0, y0, zs * 0.86 - 0.01, x1, 1.07, zs * 0.86 + 0.01); } }
    // headlight pods: recessed black bowls with two LED lamps each
    for (const s of [1, -1]) headPod(E, s);
    // centre door (white lower part) seams, the small hatch left of it
    E.pal('seam');
    const seamLine = (pts, w) => { for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], b = pts[i + 1], dz = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dz, dy) || 1, oz = -dy / l * w / 2, oy = dz / l * w / 2;
      const c = [[a[0] + oz, a[1] + oy], [b[0] + oz, b[1] + oy], [b[0] - oz, b[1] - oy], [a[0] - oz, a[1] - oy]].map(([z, y]) => faceAt(z, y, 0.0015));
      const ids = c.map(f => E.v(f.p[0], f.p[1], f.p[2], f.n[0], f.n[1], f.n[2])); E.quad(ids[0], ids[3], ids[2], ids[1]); E.quad(ids[0], ids[1], ids[2], ids[3]); } };
    for (const zs of [-1, 1]) seamLine([[zs * 0.495, 1.265], [zs * 0.495, MASK_Y0 + 0.01]], 0.013);
    seamLine([[0.6, 1.79], [0.73, 1.79], [0.73, 1.93], [0.6, 1.93], [0.6, 1.79]], 0.008);
    // bumper: a dark grey bar across the pocket's top, with a ridge
    { const bx = faceX(1.16, 0);
      E.pal('bumper'); E.box(bx - 0.2, 1.065, -0.87, bx + 0.07, 1.265, 0.87);
      E.pal('frame'); E.box(bx + 0.07, 1.15, -0.85, bx + 0.078, 1.19, 0.85); }
    // lower lamp pods (tail + marker) at the bottom corners: glossy black angled pods, flush with the face
    for (const s of [1, -1]) {
      const zc = s * 1.1, yc = 0.99, x = faceX(yc, zc);
      E.pal('podBlack');
      E.at(mul(tr(x - 0.03, yc, zc), rotY(-s * 0.18)), m => m.box(-0.03, -0.13, -0.18, 0.045, 0.13, 0.18));
      E.pal('tailLamp'); E.cyl([x + 0.012, yc, zc + s * 0.07], [x + 0.022, yc, zc + s * 0.07], 0.058, 0.055, 18);
      E.pal('markerLamp'); E.cyl([x + 0.01, yc - 0.02, zc - s * 0.08], [x + 0.018, yc - 0.02, zc - s * 0.08], 0.033, 0.031, 14);
    }
    // top light bar on the brow, camera dome
    const barY = 3.72, ca = Math.acos(clamp(1 - (F.ROOF - barY) / F.NOSE_R, -1, 1)), barX = F.NOSE_XC + F.NOSE_R * Math.sin(ca) + (1 - Math.cos(ca)) * noseD(barY, 0);
    E.at(mul(tr(barX, barY, 0), rotZ(-(Math.PI / 2 - ca) * 0.8)), m => {
      m.pal('frame'); m.box(-0.045, -0.06, -0.49, 0.012, 0.06, 0.49);
      m.pal('topBar'); m.box(0.0, -0.045, -0.47, 0.016, 0.045, 0.47); });
    E.pal('camDome'); { const f = faceAt(0.66, 3.44, 0.0); E.cyl([f.p[0] - 0.01, 3.44, 0.66], [f.p[0] + 0.025, 3.44, 0.66], 0.05, 0.042, 14); }
    for (const s of [1, -1]) wiper(E, s);
    signFront(E);
    // corner strip panels (two tall recessed covers on each front corner): outlined as seams on the fillet
    E.pal('seam');
    for (const s of [1, -1]) for (const [y0, y1] of [[1.08, 2.0], [2.12, 3.18]]) {
      const zc = s * (F.W - 0.02), xc = xs + 0.13;
      E.box(xc - 0.05, y0, zc - 0.003, xc + 0.05, y0 + 0.006, zc + 0.003); E.box(xc - 0.05, y1 - 0.006, zc - 0.003, xc + 0.05, y1, zc + 0.003);
    }
    coupler(E, 1, true);
    // cab floor edge and underframe front (obstacle deflector hidden behind the chin)
    E.pal('frame'); E.box(F.BODY - 0.6, 0.35, -0.9, F.BODY - 0.45, 0.6, 0.9);
  }
  function mbP(mb, i) { return [mb.P[i * 3], mb.P[i * 3 + 1], mb.P[i * 3 + 2]]; }
  // The face's upper boundary as a function of z (from the offset section loop), so the mask and the windscreens can
  // follow the cab's rounded top corners.
  let faceTopFn = null;
  function makeFaceTop(face) {
    const up = face.filter(([z, y]) => y > 2.2).sort((a, b) => a[0] - b[0]);
    faceTopFn = z => { if (z <= up[0][0]) return up[0][1]; if (z >= up[up.length - 1][0]) return up[up.length - 1][1];
      let lo = 0, hi = up.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (up[m][0] <= z) lo = m; else hi = m; }
      const f = (z - up[lo][0]) / ((up[hi][0] - up[lo][0]) || 1); return up[lo][1] + (up[hi][1] - up[lo][1]) * f; };
  }
  const maskTop = z => Math.min(3.5, faceTopFn(z) - 0.045);
  function maskOutline() {
    const pts = [], ZM = 1.27;
    for (let i = 0; i <= 24; i++) { const z = ZM - 2 * ZM * i / 24; pts.push([z, maskY0(z)]); }                 // bottom, right to left
    for (let i = 0; i <= 40; i++) { const z = -ZM + 2 * ZM * i / 40; pts.push([z, Math.max(maskY0(z) + 0.05, maskTop(z))]); }   // top, left to right
    return pts;
  }
  function windscreen(s) {
    // between the door frame (z = 0.535) and z = 1.2, above the mask bottom (+0.07), under the mask top (-0.08)
    const zi = 0.535, zo = 1.2, pts = [];
    const bot = z => maskY0(z) + 0.03, top = z => maskTop(z) - 0.08;
    const rb = 0.14;
    for (let i = 0; i <= 12; i++) { const z = zi + 0.04 + (zo - rb - zi - 0.04) * i / 12; pts.push([z, bot(z)]); }
    const cz = zo - rb, cy = bot(zo - rb) + rb;
    for (let i = 1; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * Math.PI / 2; pts.push([cz + rb * Math.cos(a), cy + rb * Math.sin(a)]); }
    const topAt = z => Math.max(top(z), cy + 0.02);
    for (let i = 0; i <= 16; i++) { const z = zo - (zo - zi - 0.05) * i / 16; pts.push([z, topAt(z)]); }
    pts.push([zi + 0.01, topAt(zi + 0.05) - 0.03], [zi, topAt(zi + 0.05) - 0.07], [zi, bot(zi) + 0.04], [zi + 0.012, bot(zi + 0.012) + 0.008]);
    return s > 0 ? pts : pts.map(([z, y]) => [-z, y]).reverse();
  }
  function podOutline(s) {
    // teardrop: a point at the bottom-inner corner, a full round top-outer part (z 0.93..1.29, y 1.52..2.13)
    const raw = [[0.955, 1.56], [1.03, 1.52], [1.16, 1.535], [1.255, 1.62], [1.29, 1.8], [1.285, 1.99], [1.235, 2.1], [1.14, 2.13], [1.04, 2.09], [0.97, 1.97], [0.935, 1.77]];
    let pts = raw; for (let it = 0; it < 3; it++) { const o = []; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); } pts = o; }
    return s > 0 ? pts : pts.map(([z, y]) => [-z, y]).reverse();
  }
  function headPod(E, s) {
    const out = podOutline(s), cz = s * 1.12, cy = 1.82, depth = 0.07;
    // bowl walls: from the outline on the face inward (shrinking), then the back plate
    E.pal('podBlack');
    const inner = out.map(([z, y]) => [cz + (z - cz) * 0.9, cy + (y - cy) * 0.93]);
    for (let i = 0; i < out.length; i++) { const i2 = (i + 1) % out.length;
      const A = faceAt(out[i][0], out[i][1]).p, B = faceAt(out[i2][0], out[i2][1]).p, C = faceAt(inner[i2][0], inner[i2][1], -depth).p, D = faceAt(inner[i][0], inner[i][1], -depth).p;
      const nn = fnorm(A, B, C); const ids = [A, B, C, D].map(p => E.v(p[0], p[1], p[2], nn[0], nn[1], nn[2])); E.quad(ids[0], ids[1], ids[2], ids[3]); E.quad(ids[0], ids[3], ids[2], ids[1]); }
    E.shape(inner.slice(), [], (z, y) => faceAt(z, y, -depth));
    E.shape(inner.slice().reverse(), [], (z, y) => faceAt(z, y, -depth));
    // two lamp modules (reflector cup + LED lens with the honeycomb cluster), upper slightly outboard
    for (const [lz, ly, r] of [[s * 1.175, 1.96, 0.075], [s * 1.08, 1.7, 0.068]]) {
      const f = faceAt(lz, ly, -depth + 0.005), x = f.p[0];
      E.pal('chrome'); E.cyl([x, ly, lz], [x + 0.03, ly, lz], r * 1.12, r * 1.0, 18);
      E.pal('headLamp'); E.cyl([x + 0.03, ly, lz], [x + 0.042, ly, lz], r * 0.92, r * 0.9, 18);
    }
    // clear outer cover over the pod (flush with the face) goes into the glass mesh: omitted (the bowl reads better)
  }
  function wiper(E, s) {
    // parked along the bottom of the windscreen, pivot near the outer lower corner; bone 19 (right) / 20 (left)
    E.bone = BONE.wiper[s > 0 ? 0 : 1];
    const pz = s * 0.93, py = MASK_Y0 + 0.1, f = faceAt(pz, py, 0.02);
    E.pal('wiper');
    E.cyl([f.p[0] - 0.02, py, pz], [f.p[0] + 0.015, py, pz], 0.022, 0.018, 10);
    // arm and blade toward the centre, rising slightly
    const tip = [-s * 0.16, 0.6];
    const g = faceAt(pz + tip[0], py + tip[1], 0.025);
    E.cyl([f.p[0] + 0.01, py, pz], g.p, 0.009, 0.007, 6, false);
    const h0 = faceAt(pz + tip[0] * 0.25, py + tip[1] * 0.25 - 0.02, 0.018).p, h1 = faceAt(pz + tip[0] * 1.35, py + tip[1] * 1.35 + 0.02, 0.018).p;
    E.cyl(h0, h1, 0.008, 0.008, 6);
    E.bone = 0;
  }
  // front destination sign (behind the left windscreen, top): LED module; uv1 maps into the sign canvas' front region
  function signFront(E) {
    const z0 = -1.02, z1 = -0.6, y0 = 3.06, y1 = 3.17, x = faceX(3.1, -0.8) - 0.05;
    E.pal('frame'); E.box(x - 0.04, y0 - 0.02, z0 - 0.02, x - 0.003, y1 + 0.02, z1 + 0.02);
    E.pal('ledSign');
    const a = E.v(x, y0, z1, 1, 0, 0, 0, K.SIGN.front[1]), b = E.v(x, y0, z0, 1, 0, 0, 1, K.SIGN.front[1]), c = E.v(x, y1, z0, 1, 0, 0, 1, K.SIGN.front[3]), d = E.v(x, y1, z1, 1, 0, 0, 0, K.SIGN.front[3]);
    E.quad(a, b, c, d);
  }

  // ------------------------------------------------------------------------------------------ underframe
  function underframe(E, P, isD) {
    E.bone = 0;
    const x0 = -(F.BODY - 0.1), x1 = isD ? F.NOSE_XC : F.BODY - 0.1;
    // skirt return lip and the underside of the floor
    E.pal('frame');
    for (const s of [1, -1]) { const z = s * 1.505; E.box(x0, 0.615, Math.min(z, s * 1.43), x1, 0.625, Math.max(z, s * 1.43)); E.box(x0, 0.62, s * 1.43 - 0.01, x1, 0.76, s * 1.43 + 0.01); }
    E.box(x0, 0.74, -1.43, x1, 0.76, 1.43, 'Y');
    // equipment between the trucks (the D car carries a little less); seeded per type so D and E differ
    const r = U.rng(isD ? 31 : 17), boxes = [];
    const lay = isD
      ? [[-5.9, -3.2, -1.32, 0.15, 0.33, 'equip'], [-2.9, -0.4, 0.1, 1.32, 0.36, 'equip'], [-0.2, 2.1, -1.32, -0.2, 0.40, 'equip'], [2.4, 4.9, -0.2, 1.32, 0.34, 'equip'], [5.1, 5.9, -1.3, -0.4, 0.42, 'frameLt']]
      : [[-5.9, -3.0, -1.32, 0.2, 0.32, 'equip'], [-2.7, -0.3, 0.05, 1.32, 0.35, 'equip'], [0.1, 2.3, -1.32, -0.25, 0.38, 'equip'], [2.6, 5.8, -0.1, 1.32, 0.33, 'equip']];
    for (const [a, b, c, d, y, pal] of lay) {
      E.pal(pal); E.box(a, y, c, b, 0.745, d);
      // louvered / finned outboard faces and a lid seam
      const zs = Math.abs(c) > Math.abs(d) ? c : d, s = Math.sign(zs);
      E.pal('louver'); E.box(a + 0.15, y + 0.06, zs - s * 0.004, a + (b - a) * 0.45, 0.68, zs + s * 0.003);
      E.pal('frameLt'); E.box(a + (b - a) * 0.55, y + 0.05, zs - s * 0.003, b - 0.12, y + 0.12, zs + s * 0.004);
      for (let k = 0; k < 3; k++) { const hx = lerp(a + 0.2, b - 0.2, (k + 0.5) / 3); E.box(hx - 0.05, 0.66, zs - s * 0.002, hx + 0.05, 0.7, zs + s * 0.012); }
      boxes.push([a, b]);
    }
    // air reservoirs and cable conduits
    E.pal('frameLt');
    E.cyl([-2.6, 0.54, -0.95], [-0.6, 0.54, -0.95], 0.15, 0.15, 14);
    E.cyl([3.2, 0.55, -0.9], [4.8, 0.55, -0.9], 0.13, 0.13, 14);
    E.pal('frame');
    for (const z of [-0.5, 0.35, 0.42]) E.cyl([x0 + 0.5, 0.7, z], [x1 - 0.5, 0.7, z], 0.035, 0.035, 6, false);
    // shoe-gear fuse boxes near each truck
    for (const bx of [F.TRUCK, -F.TRUCK]) for (const s of [1, -1]) { E.pal('equip'); E.box(bx - Math.sign(bx) * 1.9, 0.52, s * 1.05, bx - Math.sign(bx) * 1.55, 0.74, s * 1.3); }
    void r; void boxes; void P;
  }

  // ------------------------------------------------------------------------------------------ trucks
  // Modern outboard-bearing H-frame truck, built around its pivot at (+-TRUCK, 0, 0); bones 1/2 for the frame, 3..6
  // for the wheelsets (spin). Collector shoes on both sides.
  function bogie(E, b) {
    const bx = b === 0 ? F.TRUCK : -F.TRUCK, bone = BONE.bogie[b], WR = F.WR, hb = F.WB / 2;
    E.bone = bone;
    const zf = 1.08;
    for (const s of [1, -1]) {
      const z0 = s * zf - 0.08, z1 = s * zf + 0.08;
      // side frame: raised over the axle boxes, dipped in the middle for the air spring
      E.pal('frame');
      E.box(bx - hb - 0.32, 0.58, Math.min(z0, z1), bx - hb + 0.3, 0.82, Math.max(z0, z1));
      E.box(bx + hb - 0.3, 0.58, Math.min(z0, z1), bx + hb + 0.32, 0.82, Math.max(z0, z1));
      E.box(bx - hb + 0.3, 0.46, Math.min(z0, z1), bx + hb - 0.3, 0.7, Math.max(z0, z1));
      for (const k of [-1, 1]) { const x = bx + k * (hb - 0.3), x2 = bx + k * (hb - 0.62); const pts = [[x, 0.58, 0], [x2, 0.46, 0]];
        E.q4([pts[0][0], 0.82, z1 * 1], [pts[1][0], 0.7, z1], [pts[1][0], 0.7, z0], [pts[0][0], 0.82, z0]); }
      // air spring (secondary) on the frame's dip
      E.pal('rubber'); E.cyl([bx, 0.71, s * zf], [bx, 0.9, s * zf], 0.24, 0.24, 18);
      E.pal('frameLt'); E.cyl([bx, 0.9, s * zf], [bx, 0.93, s * zf], 0.26, 0.26, 18);
      for (const k of [-1, 1]) {
        const ax = bx + k * hb;
        // axle box (outboard), primary coil springs, vertical damper, speed sensor
        E.pal('frameLt'); E.cyl([ax, WR, s * (zf - 0.07)], [ax, WR, s * (zf + 0.13)], 0.125, 0.125, 16);
        E.pal('steel'); E.cyl([ax, WR, s * (zf + 0.13)], [ax, WR, s * (zf + 0.155)], 0.1, 0.09, 16);
        E.pal('coil'); for (const dx of [-0.13, 0.13]) E.cyl([ax + dx, WR + 0.08, s * zf], [ax + dx, 0.6, s * zf], 0.07, 0.07, 10);
        E.pal('frame'); E.cyl([ax + k * 0.22, WR - 0.02, s * (zf + 0.1)], [ax + k * 0.22, 0.72, s * (zf + 0.1)], 0.026, 0.026, 8);
        // tread brake unit on the outer side of each wheel
        E.pal('frameLt'); E.box(ax + k * 0.46, WR - 0.08, s * 0.74, ax + k * 0.64, WR + 0.12, s * 0.95);
        E.pal('frame'); E.box(ax + k * 0.37, WR - 0.14, s * 0.78, ax + k * 0.43, WR + 0.12, s * 0.92);
        // collector shoe gear: fibreglass beam between the axle boxes, paddle down to the contact rail
      }
      E.pal('beam'); E.box(bx - hb + 0.1, 0.3, s * 1.24, bx + hb - 0.1, 0.4, s * 1.3);
      E.box(bx - 0.08, 0.26, s * 1.3, bx + 0.08, 0.36, s * 1.46);
      E.pal('shoe'); E.box(bx - 0.18, 0.19, s * 1.38, bx + 0.18, 0.23, s * 1.52);
      E.pal('copper'); E.cyl([bx, 0.34, s * 1.27], [bx + 0.3, 0.6, s * 1.25], 0.012, 0.012, 5, false);
      // yaw damper
      E.pal('frame'); E.cyl([bx - 0.55, 0.78, s * 1.22], [bx + 0.35, 0.82, s * 1.26], 0.035, 0.035, 8);
    }
    // transom and traction motors (one per axle, inboard), gearboxes
    E.pal('frame'); E.box(bx - 0.28, 0.46, -zf, bx + 0.28, 0.66, zf);
    for (const k of [-1, 1]) {
      const mx = bx + k * 0.52;
      E.pal('frameLt'); E.cyl([mx, 0.47, -0.45], [mx, 0.47, 0.38], 0.23, 0.23, 18);
      E.pal('louver'); E.cyl([mx, 0.47, 0.38], [mx, 0.47, 0.42], 0.2, 0.18, 18);
      E.pal('frame'); E.box(bx + k * (hb - 0.28), WR - 0.2, 0.42, bx + k * (hb + 0.22), WR + 0.2, 0.66);
    }
    // wheelsets on their own bones (spin about the axle)
    for (const k of [1, -1]) {
      const ax = bx + k * hb, bone2 = BONE.axle[b * 2 + (k > 0 ? 0 : 1)];
      E.bone = bone2;
      wheelset(E, ax);
    }
    E.bone = 0;
  }
  function wheelset(E, ax) {
    const WR = F.WR, g = F.GAUGE / 2;
    for (const s of [1, -1]) {
      // wheel: tread (conical), flange inboard, dished web, hub; profile revolved about z
      const prof = [[0.075, s * (g + 0.14)], [0.2, s * (g + 0.12)], [WR - 0.035, s * (g + 0.125)], [WR, s * (g + 0.128)], [WR, s * (g + 0.02)], [WR + 0.03, s * (g - 0.005)], [WR + 0.028, s * (g - 0.03)], [WR - 0.04, s * (g - 0.035)], [0.22, s * (g - 0.02)], [0.12, s * (g - 0.06)], [0.075, s * (g - 0.06)]];
      E.pal('wheel');
      E.at(mul(tr(ax, WR, 0), rotX(Math.PI / 2)), m => {
        // lathe about local Y (= car Z after the rotation): [radius, y]
        const pr = prof.map(([r, z]) => [r, -z]);
        m.lathe(s > 0 ? pr : pr.slice().reverse(), 22);
      });
      // bolt circle on the outer face so the spin reads
      E.pal('steel');
      for (let i = 0; i < 6; i++) { const a = i * TAU / 6, r = 0.14; E.box(ax + Math.cos(a) * r - 0.018, WR + Math.sin(a) * r - 0.018, s * (g + 0.135), ax + Math.cos(a) * r + 0.018, WR + Math.sin(a) * r + 0.018, s * (g + 0.15)); }
    }
    E.pal('steel'); E.cyl([ax, WR, -(g + 0.07)], [ax, WR, g + 0.07], 0.085, 0.085, 12);
  }

  // ------------------------------------------------------------------------------------------ roof
  function roofDetail(E, P, isD) {
    E.bone = 0;
    // antennas near the ends, a couple of flush hatches (seams), rain strips above the doors
    const top = F.ROOF;
    E.pal('frame');
    for (const [x, z] of isD ? [[8.2, 0.35], [7.6, -0.3], [-9.0, 0.25]] : [[-9.0, 0.25], [9.0, -0.25]]) {
      E.cyl([x, top - 0.01, z], [x, top + 0.02, z], 0.07, 0.07, 12); E.cyl([x, top + 0.02, z], [x, top + 0.075, z], 0.035, 0.01, 10);
    }
    E.pal('aluDull');
    for (const x of [-4.5, 4.5]) { E.box(x - 0.6, top - 0.004, -0.515, x + 0.6, top + 0.0012, -0.505); E.box(x - 0.6, top - 0.004, 0.505, x + 0.6, top + 0.0012, 0.515);
      E.box(x - 0.6, top - 0.004, -0.515, x - 0.59, top + 0.0012, 0.515); E.box(x + 0.59, top - 0.004, -0.515, x + 0.6, top + 0.0012, 0.515); }
    // drip rails over the doorways (short aluminium strips at the cant)
    E.pal('aluDull');
    for (const dc of F.DOORS) for (const s of [1, -1]) { const b = bodyAt(P, dc, tAtY(P, 2.99), s, 0.006); E.box(dc - 0.9, b.p[1] - 0.008, b.p[2] - 0.008, dc + 0.9, b.p[1] + 0.008, b.p[2] + 0.008); }
  }

  // ------------------------------------------------------------------------------------------ seat layout (E 54, D 47)
  // Units of two seats: T = transverse (across the car from the wall inward, facing +X or -X), L = longitudinal (back to
  // the wall, facing the aisle), L1 = a single longitudinal seat. [kind, x0, x1, side (+1 = +Z), facing, colour]
  function seatLayout(type) {
    const U2 = [];
    const T = (x0, side, face, col = 'blue') => U2.push(['T', x0, x0 + 0.566, side, face, col]);
    const L = (x0, x1, side, col) => U2.push(['L', x0, x1, side, 0, col]);
    for (const s of [1, -1]) { T(-9.47, s, 1); T(-8.715, s, 1); T(-7.96, s, 1); }
    L(-7.17, -6.17, 1, 'blue'); L(-7.17, -6.17, -1, 'lime');
    // door 1 .. centre door
    L(-4.455, -3.443, 1, 'lime'); T(-3.236, 1, -1); T(-2.65, 1, 1);
    T(-2.66, -1, 1); L(-1.877, -0.866, -1, 'lime');
    // centre door .. door 3
    L(0.87, 1.889, 1, 'lime');
    if (type === 'E') { T(2.085, 1, -1); T(2.67, 1, 1); } else T(2.085, 1, -1);
    T(2.085, -1, -1); T(2.67, -1, 1); L(3.443, 4.455, -1, 'lime');
    if (type === 'E') {
      for (const s of [1, -1]) { T(7.394, s, -1); T(8.149, s, -1); T(8.904, s, -1); }
      L(6.17, 7.17, 1, 'lime'); L(6.17, 7.17, -1, 'blue');
    } else {
      U2.push(['L1', 6.19, 6.69, 1, 0, 'lime']); T(7.13, 1, -1); T(7.88, 1, -1);
      T(6.68, -1, -1); T(7.45, -1, -1); T(8.21, -1, -1);
    }
    return U2;
  }
  // seated eye positions (floor + 1.2 m), yaw 0 faces +X
  function seatsFrom(units) {
    const out = [], FY = F.FLOOR, eye = FY + 1.2;
    for (const [k, x0, x1, side, face, col] of units) {
      if (k === 'T') { const xc = face > 0 ? x0 + 0.33 : x1 - 0.33; for (const z of [0.72, 1.23]) out.push({ x: xc, y: eye, z: side * z, yaw: face > 0 ? 0 : Math.PI, color: col }); }
      else { const n = k === 'L1' ? 1 : 2; for (let i = 0; i < n; i++) out.push({ x: x0 + (i + 0.5) * (x1 - x0) / n, y: eye, z: side * 1.1, yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2, color: col }); }
    }
    return out;
  }
  K.fotfLayout = seatLayout; K.fotfSeats = seatsFrom;

  // ------------------------------------------------------------------------------------------ registration
  K.builders.bart = function (type, q) {
    const isD = type === 'D', b = buildFotf(type, q);
    const WR = F.WR, hb = F.WB / 2;
    const bones = [{ pivot: [0, 0, 0] }, { pivot: [F.TRUCK, 0, 0] }, { pivot: [-F.TRUCK, 0, 0] },
      { pivot: [F.TRUCK + hb, WR, 0] }, { pivot: [F.TRUCK - hb, WR, 0] }, { pivot: [-F.TRUCK + hb, WR, 0] }, { pivot: [-F.TRUCK - hb, WR, 0] }];
    const leaves = [];
    for (let d = 0; d < 3; d++) for (const s of [1, -1]) for (const k of [-1, 1]) { const bi = BONE.leaf(d, s, k); bones[bi] = { pivot: [F.DOORS[d], 1.9, s * F.W] }; leaves.push({ bone: bi, side: s, k }); }
    const wipers = [];
    for (const s of [1, -1]) { const bi = BONE.wiper[s > 0 ? 0 : 1], pz = s * 0.93, py = MASK_Y0 + 0.1, n = faceN(py, pz);
      bones[bi] = { pivot: [faceX(py, pz), py, pz] }; if (isD) wipers.push({ bone: bi, pivot: [faceX(py, pz), py, pz], axis: n }); }
    bones[BONE.handle] = { pivot: [9.64, F.FLOOR + 0.83, 0.33] };
    for (let i = 0; i < BONE.N; i++) if (!bones[i]) bones[i] = { pivot: [0, 0, 0] };
    const units = seatLayout(type), seats = seatsFrom(units);
    // interior-mapping seat rows (signed z ranges)
    const rows = [];
    for (const [k, x0, x1, side, face] of units) if (k === 'T') {
      const xb = face > 0 ? x0 + 0.05 : x1 - 0.05, zi = 0.44, zo = 1.45;
      rows.push(new THREE.Vector4(xb, side > 0 ? zi : -zo, side > 0 ? zo : -zi, face));
    }
    const doors = []; for (const dc of F.DOORS) for (const s of [1, -1]) doors.push({ x: dc, side: s, width: 1.36, sillY: F.FLOOR });
    const xEnd = F.BODY - 1.0, xCabDoor = 8.98;
    const floorRegions = [{ name: 'saloon', x0: -xEnd, x1: isD ? F.CAB_BACK : xEnd, z0: -1.37, z1: 1.37, y: F.FLOOR },
      { name: 'endR', x0: -(F.BODY - 0.23), x1: -xEnd, z0: -0.5, z1: 0.5, y: F.FLOOR }];
    if (!isD) floorRegions.push({ name: 'endF', x0: xEnd, x1: F.BODY - 0.23, z0: -0.5, z1: 0.5, y: F.FLOOR });
    else floorRegions.push({ name: 'cabDoor', x0: F.CAB_BACK, x1: xCabDoor, z0: -0.45, z1: 0.45, y: F.FLOOR }, { name: 'cab', x0: xCabDoor, x1: 9.85, z0: -1.25, z1: 1.25, y: F.FLOOR });
    const gangways = { rear: { x: -F.HL, z0: -0.38, z1: 0.38, y: F.FLOOR, emergency: true }, front: isD ? null : { x: F.HL, z0: -0.38, z1: 0.38, y: F.FLOOR, emergency: true } };
    const cabEye = isD ? [9.3, F.FLOOR + 1.27, 0.72] : null;
    return {
      ext: b.ext, glass: b.glass, tris: b.tris, length: F.L, width: 2 * F.W, height: F.ROOF, profile: b.P,
      sphere: new THREE.Sphere(new THREE.Vector3(0, 1.9, 0), 11.3),
      bones, boneIdx: { bogie: [1, 2], axlesOf: [[3, 4], [5, 6]], handle: isD ? BONE.handle : undefined }, leaves, wipers,
      meta: { bogieOffsets: [F.TRUCK, -F.TRUCK], doors, floorRegions, ramps: [], gangways, seats, cabEye },
      units, rows, halfW: 1.47, floorY: F.FLOOR, ceilY: 3.12,
      cabBox: new THREE.Vector4(-(F.BODY - 1.0), isD ? F.CAB_BACK : F.BODY - 1.0, 0, 0),
    };
  };

  K.builders.bart.interior = (d, q) => K.buildFotfInterior(d, q);
  K.builders.bart.lod = (d, level) => K.fotfLod(d, level);
  K.buildFotf = buildFotf; K.sideGrid = sideGrid; K.rrXT = rrXT; K.ring = ring; K.fill = fill;
  K.fotfProfile = { makeProfile, profAt, tAtY, bodyAt };
})();
