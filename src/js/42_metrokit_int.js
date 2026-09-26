// MetroKit: Fleet of the Future-type interiors (saloon + the D car's cab), built lazily per design the first time a car
// of that design shows its interior, as ONE skinned mesh in the palette material (plus one glass mesh). Layout and
// sources: notes/bart/trains.md. Car-local frame as in 41_metrokit.js.
(() => {
  const K = MetroKit._k, { MB, rrect, fnorm, tr, rotY, rotZ, rotX, mul, M4, TAU } = K;
  const { clamp, lerp } = U;
  const V3 = THREE.Vector3;

  // ------------------------------------------------------------------------------------------ rounded box
  // A box with rounded edges and corners (the classic "clamp and push out" construction on a subdivided cube):
  // n segments per face edge, radius r; current transform of mb applies.
  function rbox(mb, x0, y0, z0, x1, y1, z1, r, n = 4) {
    const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], h = [Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2];
    r = Math.min(r, h[0], h[1], h[2]); const hi = [h[0] - r, h[1] - r, h[2] - r];
    const F = [[0, 1, 2, 1], [0, 1, 2, -1], [1, 2, 0, 1], [1, 2, 0, -1], [2, 0, 1, 1], [2, 0, 1, -1]];   // axis, u axis, v axis, sign
    for (const [ax, ua, va, sg] of F) {
      const base = mb.count;
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
        const p = [0, 0, 0]; p[ax] = sg * h[ax]; p[ua] = -h[ua] + 2 * h[ua] * i / n; p[va] = -h[va] + 2 * h[va] * j / n;
        const q = [clamp(p[0], -hi[0], hi[0]), clamp(p[1], -hi[1], hi[1]), clamp(p[2], -hi[2], hi[2])];
        let d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]]; const l = Math.hypot(d[0], d[1], d[2]) || 1; d = [d[0] / l, d[1] / l, d[2] / l];
        mb.v(c[0] + q[0] + d[0] * r, c[1] + q[1] + d[1] * r, c[2] + q[2] + d[2] * r, d[0], d[1], d[2], i / n, j / n);
      }
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const a = base + i * (n + 1) + j; mb.quadA(a, a + n + 1, a + n + 2, a + 1); }
    }
    return mb;
  }
  // a flat panel (both faces) in a plane given by corner points A, B, C, D (counter-clockwise from the front)
  function panel2(mb, A, B, C, D) { mb.q4(A, B, C, D); mb.q4(D, C, B, A); return mb; }

  // ------------------------------------------------------------------------------------------ seats
  // A unit of n seats in local coordinates: origin on the floor at the unit's back-left corner; the seats face +X,
  // local z runs along the unit from 0 to n * 0.515; y up from the floor. col: 'seatBlue' | 'seatLime'.
  // handle: +1 / -1 / 0 = grab handle on the z-max / z-min end of the back (the aisle end), arm: armrest at the z-min end.
  const SW = 0.515;
  function seatUnit(mb, n, col, q, o = {}) {
    const W = n * SW, rn = q >= 3 ? 4 : q >= 1 ? 3 : 2, tilt = 0.17;
    // pan shell + cushions
    mb.pal('seatShell'); rbox(mb, 0.03, 0.375, 0.0, 0.53, 0.43, W, 0.02, rn);
    mb.pal(col); for (let i = 0; i < n; i++) rbox(mb, 0.07, 0.415, i * SW + 0.025, 0.51, 0.472, (i + 1) * SW - 0.025, 0.024, rn);
    // back shell and back cushions, reclined about the rear edge of the pan
    mb.at(mul(tr(0.05, 0.43, 0), rotZ(tilt)), m => {
      m.pal('seatShell'); rbox(m, -0.055, 0.0, 0.0, 0.0, 0.76, W, 0.02, rn);
      m.pal(col); for (let i = 0; i < n; i++) rbox(m, -0.005, 0.07, i * SW + 0.03, 0.04, 0.68, (i + 1) * SW - 0.03, 0.02, rn);
      // grab handle at the aisle end: a stainless loop over the shell's top corner
      if (o.handle) { const z = o.handle > 0 ? W - 0.05 : 0.05; m.pal('pole'); m.tube([[-0.03, 0.62, z], [-0.03, 0.8, z], [-0.03, 0.82, z - o.handle * 0.03], [-0.03, 0.82, z - o.handle * 0.18], [-0.03, 0.76, z - o.handle * 0.2]], 0.014, 8); }
    });
    // armrest (priority seats) at the z-min end
    if (o.arm) { mb.pal('pole'); mb.tube([[0.08, 0.43, o.arm < 0 ? 0.015 : W - 0.015], [0.1, 0.68, o.arm < 0 ? 0.015 : W - 0.015], [0.45, 0.68, o.arm < 0 ? 0.015 : W - 0.015], [0.48, 0.45, o.arm < 0 ? 0.015 : W - 0.015]], 0.013, 8, true); }
    // cantilever bracket under the pan
    mb.pal('seatFrame'); mb.box(0.18, 0.12, W - 0.08, 0.36, 0.375, W - 0.02);
  }

  // ------------------------------------------------------------------------------------------ the saloon
  function buildInterior(d, q) {
    const F = K.FOTF, P = d.profile, isD = d.type === 'D', FY = F.FLOOR, E = new MB(), G = new MB();
    const { bodyAt, tAtY } = K.fotfProfile;
    const IW = -0.125;                                        // inner wall offset from the outer skin
    const xEnd = F.BODY - 0.1, xR = -xEnd, xF = isD ? 8.46 : xEnd;
    E.bone = 0; G.bone = 0;
    // ---------------- floor
    E.pal('floor'); E.q4([xR, FY, 1.475], [xF + (isD ? 0.52 : 0), FY, 1.475], [xF + (isD ? 0.52 : 0), FY, -1.475], [xR, FY, -1.475]);
    // ---------------- side walls with windows and door portals
    const wins = isD ? F.WIN_D : F.WIN_E, tF = tAtY(P, FY), tTop = tAtY(P, 2.94);
    const winInner = xc => ({ x0: xc - F.WIN_W / 2 - 0.045, x1: xc + F.WIN_W / 2 + 0.045, t0: tAtY(P, F.WIN_Y0 - 0.045), t1: tAtY(P, F.WIN_Y1 + 0.045), r: F.WIN_R + 0.04 });
    for (const s of [1, -1]) {
      const holes = wins.filter(x => !isD || x < 8.4).map(winInner);
      for (const dc of F.DOORS) holes.push({ x0: dc - F.PORTAL, x1: dc + F.PORTAL, t0: tF - 0.01, t1: tAtY(P, F.PORTAL_TOP), r: [0, 0, 0.04, 0.04] });
      const inner = new MB(); inner.bone = 0;
      const palW = (xm, tm) => { const y = bodyAt(P, xm, tm, s, 0).p[1]; return y < FY + 0.2 ? 'grilleInt' : (Math.abs(y - 1.86) < 0.012 ? 'blackInt' : 'wallInt'); };
      K.sideGrid(inner, P, s, xR, isD ? 8.46 : xF, tF, tTop, holes, palW, IW, [], [tAtY(P, FY + 0.2), tAtY(P, 1.848), tAtY(P, 1.872)]);
      flipInto(E, inner);
      // window reveals: from the inner opening to the glass line
      for (const xc of wins) {
        if (isD && xc > 8.4) continue;
        const h = winInner(xc), o = K.rrXT(P, h.x0, h.x1, F.WIN_Y0 - 0.045, F.WIN_Y1 + 0.045, h.r), gi = K.rrXT(P, xc - F.WIN_W / 2 + F.GASKET, xc + F.WIN_W / 2 - F.GASKET, F.WIN_Y0 + F.GASKET, F.WIN_Y1 - F.GASKET, F.WIN_R - 0.045);
        const rv = new MB(); K.ring(rv, P, s, o, gi, IW, -0.024, 'wallInt2'); flipInto(E, rv);
      }
    }
    // ---------------- ceiling: centre panel, diffuser rim, LED light band, cove down to the wall
    const C = [[0, 3.14, 'ceil'], [0.5, 3.12, 'wallInt2'], [0.58, 3.1, 'lightStrip'], [1.08, 2.985, 'ceil'], [1.475, 2.94, null]];
    const cx0 = xR, cx1 = isD ? 8.46 : xF;
    for (const s of [1, -1]) for (let i = 0; i < C.length - 1; i++) {
      const [za, ya, pal] = C[i], [zb, yb] = C[i + 1]; E.pal(pal);
      const A = [cx0, ya, s * za], B = [cx1, ya, s * za], Cc = [cx1, yb, s * zb], D = [cx0, yb, s * zb];
      const n = fnorm(A, B, Cc); if (n[1] > 0) E.q4(D, Cc, B, A); else E.q4(A, B, Cc, D);
    }
    // air slots along the rim, CCTV domes, speakers
    E.pal('blackInt');
    for (const s of [1, -1]) E.box(cx0 + 0.3, 3.108, s * 0.52 - 0.012, cx1 - 0.3, 3.112, s * 0.52 + 0.012);
    for (const x of [-6.5, 0.9, 6.5]) { if (isD && x > 8) continue; E.pal('camDome'); E.at(mul(tr(x, 3.14, 0), rotX(Math.PI)), m => m.lathe([[0.001, 0], [0.05, 0.005], [0.058, 0.03], [0.05, 0.05], [0.0, 0.06]].map(([r, y]) => [r, y]), 14)); }
    for (const x of [-8.2, -3.3, 2.4, 7.4]) { if (isD && x > 7) continue; E.pal('grilleInt'); E.box(x - 0.14, 3.134, -0.14, x + 0.14, 3.139, 0.14); }
    // ---------------- overhead grab rails (both sides), brackets
    const railY = 2.88, railZ = 0.56, rx0 = xR + 0.9, rx1 = (isD ? 8.2 : xF - 0.9);
    E.pal('pole');
    for (const s of [1, -1]) {
      E.cyl([rx0, railY, s * railZ], [rx1, railY, s * railZ], 0.016, 0.016, 10);
      for (let x = rx0 + 0.3; x < rx1; x += 1.62) E.cyl([x, railY, s * railZ], [x, 3.115, s * railZ], 0.011, 0.011, 8, false);
    }
    // hanging straps: dense at the doorways, a few along the aisle
    const strapAt = (x, s) => { E.pal('strap'); E.box(x - 0.016, railY - 0.3, s * railZ - 0.004, x + 0.016, railY - 0.01, s * railZ + 0.004);
      E.tube(Array.from({ length: 11 }, (_, i) => { const a = i / 10 * TAU; return [x + Math.sin(a) * 0.075, railY - 0.3 - 0.075 + Math.cos(a) * 0.075, s * railZ]; }), 0.009, 6, false); };
    for (const dc of F.DOORS) for (const s of [1, -1]) for (const dx of (dc === 0 ? [-0.9, -0.62, -0.34, 0.34, 0.62, 0.9] : [-0.75, -0.45, 0.45, 0.75])) strapAt(dc + dx, s);
    // ---------------- doorway partitions, grab poles, lamps, intercoms, screens
    for (let di = 0; di < 3; di++) {
      const dc = F.DOORS[di];
      for (const s of [1, -1]) for (const k of [-1, 1]) {
        const x = dc + k * 0.715, z0 = s * 1.43, z1 = s * 0.93, ytop = FY + 1.88;
        E.pal('wallInt2'); E.shape(
          [[0, 0], [1, 0], [1, 0.82], [0.9, 0.97], [0.75, 1.0], [0, 1.0]].map(([u, v]) => [u, v]), [],
          (u, v) => ({ p: [x, FY + 0.06 + v * (ytop - FY - 0.06), lerp(z0, z1, u)], n: [k, 0, 0] }));
        E.shape([[0, 0], [0, 1.0], [0.75, 1.0], [0.9, 0.97], [1, 0.82], [1, 0]], [], (u, v) => ({ p: [x - k * 0.04, FY + 0.06 + v * (ytop - FY - 0.06), lerp(z0, z1, u)], n: [-k, 0, 0] }));
        E.pal('pole'); E.tube([[x - k * 0.02, FY + 0.02, z1 - s * 0.03], [x - k * 0.02, ytop - 0.1, z1 - s * 0.03], [x - k * 0.02, ytop + 0.25, s * (railZ + 0.12)], [x - k * 0.02, railY, s * railZ]], 0.017, 10);
        E.pal('seatFrame'); E.cyl([x - k * 0.02, FY, z1 - s * 0.03], [x - k * 0.02, FY + 0.02, z1 - s * 0.03], 0.04, 0.04, 12);
        // intercom on the partition's doorway face (one per doorway)
        if (k === 1) { E.pal('bezel'); E.box(x + 0.001, FY + 1.28, z1 + s * 0.12 - 0.07, x + 0.02, FY + 1.46, z1 + s * 0.12 + 0.07);
          E.pal('keyRed'); E.cyl([x + 0.02, FY + 1.33, z1 + s * 0.12], [x + 0.03, FY + 1.33, z1 + s * 0.12], 0.018, 0.018, 10); }
      }
      // red door lamps over the portal (inside), per side
      for (const s of [1, -1]) { E.pal(s > 0 ? 'lampIntR' : 'lampIntL'); E.box(dc - 0.06, FY + 1.955, s * 1.38 - 0.02, dc + 0.06, FY + 1.985, s * 1.38 + 0.02); }
      // passenger screen: one per doorway on the wall panel beside the portal, high up, tilted down; LCD via uv1
      for (const s of [1, -1]) {
        const xs = dc + s * 1.18, yc = 2.62, zc = s * 1.43, w = 0.54, h = 0.31, tilt = 0.18;
        E.at(mul(tr(xs, yc, zc), rotY(s > 0 ? Math.PI : 0), rotX(tilt)), m => {
          m.pal('bezel'); m.box(-w / 2 - 0.02, -h / 2 - 0.02, -0.05, w / 2 + 0.02, h / 2 + 0.02, 0.0);
          m.pal('lcd'); const L = K.LCD.pis; const a = m.v(-w / 2, -h / 2, 0.002, 0, 0, 1, L[0], L[1]), b = m.v(w / 2, -h / 2, 0.002, 0, 0, 1, L[2], L[1]), c = m.v(w / 2, h / 2, 0.002, 0, 0, 1, L[2], L[3]), e = m.v(-w / 2, h / 2, 0.002, 0, 0, 1, L[0], L[3]);
          m.quad(a, b, c, e);
        });
      }
    }
    // ---------------- tripod poles at doors 1 and 3 (aisle centre of the vestibule)
    for (const dc of [F.DOORS[0], F.DOORS[2]]) {
      const x = dc, yb = FY + 1.8;
      E.pal('pole'); E.cyl([x, FY + 0.03, 0], [x, yb, 0], 0.019, 0.019, 12);
      E.pal('seatFrame'); E.lathe([[0.06, FY], [0.045, FY + 0.03], [0.02, FY + 0.06]], 16);
      E.pal('pole'); E.tube([[x, yb - 0.1, 0], [x, yb + 0.05, 0.02], [x, railY - 0.08, railZ - 0.12], [x, railY, railZ]], 0.016, 10, false);
      E.tube([[x, yb - 0.1, 0], [x, yb + 0.05, -0.02], [x, railY - 0.08, -railZ + 0.12], [x, railY, -railZ]], 0.016, 10, false);
      E.cyl([x, yb - 0.05, 0], [x, 3.14, 0], 0.016, 0.016, 10, false);
      E.pal('poleYellow'); E.cyl([x, FY + 1.2, 0], [x, FY + 1.35, 0], 0.0205, 0.0205, 12);
    }
    // ---------------- seats (from the design's layout), with poles from the aisle-end handles to the rails
    for (const [kind, x0, x1, side, face, colName] of d.units) {
      const col = colName === 'lime' ? 'seatLime' : 'seatBlue';
      if (kind === 'T') {
        // back at x0 (face +1) or x1 (face -1); unit from the aisle edge (|z| 0.44) to the wall
        const xb = face > 0 ? x0 : x1, m = mul(tr(xb, FY, side * 0.44), M4().makeScale(face, 1, side));
        E.at(m, mm => seatUnit(mm, 2, col, q, { handle: -1 }));
        // pole from the handle up to the rail
        const hx = xb - face * 0.07, hz = side * 0.47;
        E.pal('pole'); E.tube([[hx, FY + 1.18, hz], [hx, FY + 1.6, hz], [hx, railY - 0.25, side * (railZ - 0.02)], [hx, railY, side * railZ]], 0.016, 10, false);
      } else {
        const n = kind === 'L1' ? 1 : 2, W = n * SW, xm = (x0 + x1) / 2;
        // longitudinal: back to the wall, facing the aisle; local z along the car
        const m = mul(tr(xm - side * W / 2, FY, side * 1.42), rotY(side > 0 ? Math.PI / 2 : -Math.PI / 2));
        const dNear = K.FOTF.DOORS.reduce((a, b) => Math.abs(b - xm) < Math.abs(a - xm) ? b : a), arm = colName === 'lime' ? (dNear < xm ? -1 : 1) * side : 0;
        E.at(m, mm => seatUnit(mm, n, col, q, { arm }));
        if (colName === 'lime') {         // priority seating plate above
          const r = K.ATL.priority; E.pal('decalInt'); E.at(mul(tr(xm, FY + 1.5, side * 1.462), rotY(side > 0 ? Math.PI : 0)), mm => {
            const a = mm.v(-0.2, -0.066, 0, 0, 0, 1, r[0], r[1]), b = mm.v(0.2, -0.066, 0, 0, 0, 1, r[2], r[1]), c = mm.v(0.2, 0.066, 0, 0, 0, 1, r[2], r[3]), e = mm.v(-0.2, 0.066, 0, 0, 0, 1, r[0], r[3]); mm.quad(a, b, c, e); });
        }
      }
    }
    // ---------------- bike areas (lean bar with a strap) and wheelchair areas (floor decals)
    for (const [x0, x1, s] of [[-4.6, -3.45, -1], [3.45, 4.6, 1]]) {
      E.pal('rubberInt'); E.cyl([x0 + 0.1, FY + 0.86, s * 1.39], [x1 - 0.1, FY + 0.86, s * 1.39], 0.035, 0.035, 12);
      E.pal('pole'); for (const x of [x0 + 0.15, x1 - 0.15]) E.cyl([x, FY + 0.86, s * 1.39], [x, FY + 0.86, s * 1.465], 0.014, 0.014, 8);
      E.pal('strap'); E.box((x0 + x1) / 2 - 0.02, FY + 0.5, s * 1.45 - 0.004, (x0 + x1) / 2 + 0.02, FY + 0.86, s * 1.45 + 0.004);
      const r = K.ATL.bike; E.pal('decalInt'); E.at(mul(tr((x0 + x1) / 2, FY + 1.62, s * 1.462), rotY(s > 0 ? Math.PI : 0)), mm => {
        const a = mm.v(-0.08, -0.08, 0, 0, 0, 1, r[0], r[1]), b = mm.v(0.08, -0.08, 0, 0, 0, 1, r[2], r[1]), c = mm.v(0.08, 0.08, 0, 0, 0, 1, r[2], r[3]), e = mm.v(-0.08, 0.08, 0, 0, 0, 1, r[0], r[3]); mm.quad(a, b, c, e); });
    }
    for (const [x, s] of [[-1.35, 1], [1.35, -1]]) {
      const r = K.ATL.floorWheel; E.pal('decalInt');
      const a = E.v(x - 0.45, FY + 0.002, s * 1.4, 0, 1, 0, r[0], r[1]), b = E.v(x + 0.45, FY + 0.002, s * 1.4, 0, 1, 0, r[2], r[1]), c = E.v(x + 0.45, FY + 0.002, s * 0.5, 0, 1, 0, r[2], r[3]), e = E.v(x - 0.45, FY + 0.002, s * 0.5, 0, 1, 0, r[0], r[3]);
      E.quadA(a, b, c, e);
    }
    // ---------------- end walls: rear (and front for E): lime panels, end door, LED sign, posters
    endWall(E, G, -1, xR, FY);
    if (!isD) endWall(E, G, 1, xF, FY); else cabWall(E, G, FY);
    if (isD) cab(E, G, d, q, FY);
    return { geo: E.geometry(), glass: G.geometry(), tris: (E.I.length + G.I.length) / 3 };
  }
  function flipInto(E, m) {
    for (let i = 0; i < m.I.length; i += 3) { const t = m.I[i + 1]; m.I[i + 1] = m.I[i + 2]; m.I[i + 2] = t; }
    for (let i = 0; i < m.N.length; i++) m.N[i] = -m.N[i];
    E.append(m);
  }
  function endWall(E, G, e, x, FY) {
    // e = +1 / -1: which end (the wall faces -e). Outline: the inner section (floor to the ceiling cove) with the door.
    const z0 = 1.475, top = 2.94;
    const outline = [[-z0, FY], [z0, FY], [z0, top], [1.08, 2.985], [0.58, 3.1], [0.5, 3.12], [0, 3.14], [-0.5, 3.12], [-0.58, 3.1], [-1.08, 2.985], [-z0, top]];
    const door = [[-0.4, FY], [0.4, FY], [0.4, FY + 1.97], [-0.4, FY + 1.97]];
    // lime wall with the door opening (earcut outline minus the door notch)
    const out = [[-z0, FY], [-0.4, FY], [-0.4, FY + 1.97], [0.4, FY + 1.97], [0.4, FY], [z0, FY], [z0, top], [1.08, 2.985], [0.58, 3.1], [0.5, 3.12], [0, 3.14], [-0.5, 3.12], [-0.58, 3.1], [-1.08, 2.985], [-z0, top]];
    E.pal('lime'); E.shape(out, [], (z, y) => ({ p: [x, y, z], n: [-e, 0, 0] }));
    // end door: grey leaf with a window, frame, handle
    const xd = x + e * 0.03;
    E.pal('wallInt2'); E.shape([[-0.39, FY + 0.005], [0.39, FY + 0.005], [0.39, FY + 1.965], [-0.39, FY + 1.965]], [[[-0.2, FY + 1.02], [-0.2, FY + 1.86], [0.2, FY + 1.86], [0.2, FY + 1.02]]], (z, y) => ({ p: [xd, y, z], n: [-e, 0, 0] }));
    E.pal('seatFrame'); E.box(xd - e * 0.03, FY + 1.0, 0.25, xd - e * 0.005, FY + 1.06, 0.34);
    E.pal('bezel'); for (const z of [-0.41, 0.41]) E.box(Math.min(x, xd) - 0.005, FY, z - 0.02, Math.max(x, xd) + 0.005, FY + 1.99, z + 0.02);
    E.box(Math.min(x, xd) - 0.005, FY + 1.97, -0.42, Math.max(x, xd) + 0.005, FY + 2.0, 0.42);
    G.pal('lensClear'); G.shape([[-0.2, FY + 1.02], [0.2, FY + 1.02], [0.2, FY + 1.86], [-0.2, FY + 1.86]], [], (z, y) => ({ p: [xd + e * 0.01, y, z], n: [-e, 0, 0] }));
    // the next-stop LED sign over the door (the consist's sign canvas, rows 16-31)
    const S = K.SIGN.next, sx = x - e * 0.012;
    E.pal('bezel'); E.box(Math.min(x, sx - e * 0.02), FY + 1.72 + 0.34, -0.56, Math.max(x, sx - e * 0.02), FY + 1.72 + 0.53, 0.56);
    E.pal('ledInt'); { const y0 = FY + 2.09, y1 = FY + 2.22, xx = sx - e * 0.021, zl = 0.52 * -e, zr = 0.52 * e;
      const a = E.v(xx, y0, zl, -e, 0, 0, 0, S[1]), b = E.v(xx, y0, zr, -e, 0, 0, 1, S[1]), c = E.v(xx, y1, zr, -e, 0, 0, 1, S[3]), dd = E.v(xx, y1, zl, -e, 0, 0, 0, S[3]); E.quadA(a, b, c, dd); }
    // posters either side of the door
    const post = (name, zc, yc, w, h) => { const r = K.ATL[name]; E.pal('decalInt'); const xx = x - e * 0.004, zl = zc - w / 2 * -e, zr = zc + w / 2 * -e;
      const a = E.v(xx, yc - h / 2, zl, -e, 0, 0, r[0], r[1]), b = E.v(xx, yc - h / 2, zr, -e, 0, 0, r[2], r[1]), c = E.v(xx, yc + h / 2, zr, -e, 0, 0, r[2], r[3]), dd = E.v(xx, yc + h / 2, zl, -e, 0, 0, r[0], r[3]); E.quadA(a, b, c, dd);
      E.pal('seatFrame'); E.box(xx - 0.008, yc - h / 2 - 0.02, Math.min(zl, zr) - 0.02, xx + 0.004, yc + h / 2 + 0.02, Math.max(zl, zr) + 0.02); };
    post('posterSafety', -0.85, FY + 1.3, 0.42, 0.59); post('posterMap', 0.88, FY + 1.35, 0.6, 0.375);
  }
  function cabWall(E, G, FY) {
    // the D car's cab back wall: x = 8.46 on the operator side (+Z), 8.75 on the other, the cab door at 8.98 in the aisle
    const top = 2.94;
    E.pal('lime');
    E.shape([[0.45, FY], [1.475, FY], [1.475, top], [1.08, 2.985], [0.58, 3.1], [0.5, 3.12], [0.45, 3.125]], [], (z, y) => ({ p: [8.46, y, z], n: [-1, 0, 0] }));
    E.shape([[-1.475, FY], [-0.45, FY], [-0.45, 3.125], [-0.5, 3.12], [-0.58, 3.1], [-1.08, 2.985], [-1.475, top]], [], (z, y) => ({ p: [8.75, y, z], n: [-1, 0, 0] }));
    // passage sides and the cab door
    E.pal('wallInt2');
    E.q4([8.46, FY, 0.45], [8.98, FY, 0.45], [8.98, 3.13, 0.45], [8.46, 3.13, 0.45]);
    E.q4([8.98, FY, -0.45], [8.75, FY, -0.45], [8.75, 3.13, -0.45], [8.98, 3.13, -0.45]);
    E.pal('ceil'); E.q4([8.46, 3.13, 0.45], [8.46, 3.13, -0.45], [8.98, 3.13, -0.45], [8.98, 3.13, 0.45]);
    E.pal('wallInt2'); E.shape([[-0.45, FY], [0.45, FY], [0.45, 3.13], [-0.45, 3.13]], [[[-0.2, FY + 1.1], [-0.2, FY + 1.85], [0.2, FY + 1.85], [0.2, FY + 1.1]]], (z, y) => ({ p: [8.98, y, z], n: [-1, 0, 0] }));
    G.pal('lensClear'); G.shape([[-0.2, FY + 1.1], [0.2, FY + 1.1], [0.2, FY + 1.85], [-0.2, FY + 1.85]], [], (z, y) => ({ p: [8.985, y, z], n: [-1, 0, 0] }));
    E.pal('seatFrame'); E.box(8.95, FY + 1.0, -0.36, 8.975, FY + 1.06, -0.27);
    // next-stop sign over the passage
    const S = K.SIGN.next; E.pal('bezel'); E.box(8.44, FY + 2.05, -0.5, 8.46, FY + 2.26, 0.5);
    E.pal('ledInt'); { const y0 = FY + 2.09, y1 = FY + 2.22, x = 8.438; const a = E.v(x, y0, 0.48, -1, 0, 0, 0, S[1]), b = E.v(x, y0, -0.48, -1, 0, 0, 1, S[1]), c = E.v(x, y1, -0.48, -1, 0, 0, 1, S[3]), dd = E.v(x, y1, 0.48, -1, 0, 0, 0, S[3]); E.quadA(a, b, c, dd); }
    const r = K.ATL.posterSafety; E.pal('decalInt'); { const x = 8.456, zc = -0.95, w = 0.42, h = 0.59, yc = FY + 1.3;
      const a = E.v(x, yc - h / 2, zc + w / 2, -1, 0, 0, r[0], r[1]), b = E.v(x, yc - h / 2, zc - w / 2, -1, 0, 0, r[2], r[1]), c = E.v(x, yc + h / 2, zc - w / 2, -1, 0, 0, r[2], r[3]), dd = E.v(x, yc + h / 2, zc + w / 2, -1, 0, 0, r[0], r[3]); E.quadA(a, b, c, dd); }
  }

  // ------------------------------------------------------------------------------------------ the cab
  // Full-width cab behind the nose: operator's console on the right (+Z) with the ATC display and the status screen
  // (the consist's LCD canvas), keypad, e-stop, the T-handle master controller (bone 21), radio handset on the right
  // wall; a cabinet on the left under the destination sign; the centre emergency door in the front mask.
  function cab(E, G, d, q, FY) {
    const x0 = 8.98, xw = 10.18, zR = 1.45;
    // floor, side walls (under the side windows), ceiling
    E.pal('floor'); E.q4([x0, FY + 0.001, zR], [xw + 0.2, FY + 0.001, zR], [xw + 0.2, FY + 0.001, -zR], [x0, FY + 0.001, -zR]);
    E.pal('ceil'); E.q4([x0, 3.05, -zR], [xw, 3.05, -zR], [xw, 3.05, zR], [x0, 3.05, zR]);
    E.pal('lightStrip'); E.q4([9.3, 3.045, -0.3], [9.8, 3.045, -0.3], [9.8, 3.045, 0.3], [9.3, 3.045, 0.3]);
    E.pal('wallInt2');
    for (const s of [1, -1]) {
      const z = s * 1.44;
      // the wall around the cab side window (opening 9.2..9.76, 1.89..2.84)
      E.shape([[x0, FY], [xw, FY], [xw, 3.05], [x0, 3.05]], [[[9.18, 1.87], [9.78, 1.87], [9.78, 2.86], [9.18, 2.86]]], (x, y) => ({ p: [x, y, z], n: [0, 0, -s] }));
      // the cab back wall seen from inside
    }
    E.shape([[-zR, FY], [zR, FY], [zR, 3.05], [-zR, 3.05]], [[[-0.45, FY], [0.45, FY], [0.45, 3.04], [-0.45, 3.04]]], (z, y) => ({ p: [x0 + 0.005, y, z], n: [1, 0, 0] }));
    // ---------- operator console (right): cabinet, desk, instrument panel tilted up under the windscreen
    const zc0 = 0.18, zc1 = 1.42, deskY = FY + 0.78;
    E.pal('console'); rbox(E, 9.55, FY, zc0, 10.12, deskY, zc1, 0.03, 3);
    E.pal('consoleDk'); rbox(E, 9.45, deskY - 0.02, zc0 - 0.02, 10.15, deskY + 0.03, zc1 + 0.01, 0.015, 3);
    // instrument panel (angled): two displays side by side, keypad between
    E.at(mul(tr(10.02, deskY + 0.25, (zc0 + zc1) / 2), rotZ(-0.72)), m => {
      m.pal('console'); rbox(m, -0.03, -0.24, -0.62, 0.03, 0.24, 0.62, 0.02, 3);
      const L = K.LCD.cab, scr = (zc, u0, u1) => { m.pal('bezel'); m.box(-0.04, -0.17, zc - 0.22, -0.029, 0.17, zc + 0.22);
        m.pal('lcd'); const a = m.v(-0.042, -0.155, zc - 0.205, -1, 0, 0, u0, L[1]), b = m.v(-0.042, -0.155, zc + 0.205, -1, 0, 0, u1, L[1]), c = m.v(-0.042, 0.155, zc + 0.205, -1, 0, 0, u1, L[3]), e = m.v(-0.042, 0.155, zc - 0.205, -1, 0, 0, u0, L[3]); m.quadA(a, b, c, e); };
      // the ATC display in front of the operator, the status screen to its left (toward the centre)
      scr(0.03, L[0], (L[0] + L[2]) / 2); scr(-0.47, (L[0] + L[2]) / 2, L[2]);
      m.pal('brushed'); m.box(-0.036, -0.2, 0.32, -0.03, 0.2, 0.58);
      for (let i = 0; i < 12; i++) { const r = i % 3, c = Math.floor(i / 3); m.pal(i === 11 ? 'keyRed' : i === 9 ? 'keyGreen' : 'consoleDk'); m.box(-0.046, -0.14 + c * 0.075, 0.36 + r * 0.07, -0.036, -0.09 + c * 0.075, 0.41 + r * 0.07); }
    });
    // e-stop mushroom, horn / door buttons on the desk, the T-handle controller on its bone
    E.pal('consoleDk'); E.cyl([9.72, deskY + 0.03, 1.2], [9.72, deskY + 0.06, 1.2], 0.05, 0.05, 16);
    E.pal('mushroom'); E.cyl([9.72, deskY + 0.06, 1.2], [9.72, deskY + 0.1, 1.2], 0.042, 0.035, 16);
    for (const [bz, pal] of [[0.95, 'keyGreen'], [1.02, 'keyAmber'], [0.62, 'keyGreen'], [0.55, 'keyRed']]) { E.pal('consoleDk'); E.box(9.6, deskY + 0.03, bz - 0.03, 9.66, deskY + 0.045, bz + 0.03); E.pal(pal); E.cyl([9.63, deskY + 0.045, bz], [9.63, deskY + 0.058, bz], 0.018, 0.018, 10); }
    E.pal('brushed'); E.box(9.5, deskY + 0.03, 0.26, 9.78, deskY + 0.05, 0.4);                     // controller quadrant plate
    E.pal('consoleDk'); E.box(9.52, deskY + 0.05, 0.325, 9.76, deskY + 0.056, 0.335);             // slot
    E.bone = 21;                                                                                   // (bone pivot at [9.64, deskY + 0.05, 0.33])
    E.pal('handleBlack'); E.cyl([9.64, deskY + 0.05, 0.33], [9.64, deskY + 0.2, 0.33], 0.012, 0.012, 8);
    E.pal('handleBlack'); rbox(E, 9.6, deskY + 0.19, 0.27, 9.68, deskY + 0.235, 0.39, 0.02, 3);
    E.bone = 0;
    // operator seat (navy pinstripe), pedestal
    { const sx = 9.12, sz = 0.72;
      E.pal('seatFrame'); E.cyl([sx, FY, sz], [sx, FY + 0.38, sz], 0.05, 0.05, 12); E.lathe([[0.26, FY], [0.24, FY + 0.03], [0.05, FY + 0.05]].map(([r, y]) => [r, y]), 18);
      E.at(tr(sx, 0, sz), m => { m.pal('cabSeat'); rbox(m, -0.24, FY + 0.38, -0.25, 0.24, FY + 0.5, 0.25, 0.05, 3);
        m.at(mul(tr(-0.24, FY + 0.5, 0), rotZ(0.14)), mm => { rbox(mm, -0.12, 0.0, -0.24, 0.0, 0.66, 0.24, 0.05, 3); rbox(mm, -0.1, 0.72, -0.14, 0.0, 0.92, 0.14, 0.04, 3); });
        m.pal('consoleDk'); for (const z of [-0.29, 0.29]) rbox(m, -0.18, FY + 0.72, z - 0.03, 0.2, FY + 0.76, z + 0.03, 0.015, 2); });
    }
    // left cabinet with the radio and the sign controller; foot rest; sun blinds
    E.pal('console'); rbox(E, 9.55, FY, -1.42, 10.1, FY + 0.95, -0.55, 0.03, 3);
    E.pal('consoleDk'); rbox(E, 9.6, FY + 0.95, -1.3, 9.85, FY + 1.02, -0.75, 0.015, 2);
    E.pal('handleBlack'); rbox(E, 9.64, FY + 1.02, -1.2, 9.74, FY + 1.06, -1.0, 0.012, 2);
    E.pal('brushed'); E.box(9.8, FY + 0.12, 0.3, 9.95, FY + 0.14, 1.1);
    for (const s of [1, -1]) { E.pal('bezel'); E.cyl([10.2, 3.02, s * 0.56], [10.2, 3.02, s * 1.18], 0.02, 0.02, 10); }
    // radio handset on the right wall
    E.pal('handleBlack'); rbox(E, 9.25, FY + 1.35, 1.38, 9.31, FY + 1.58, 1.43, 0.015, 2);
  }

  K.buildFotfInterior = buildInterior;
  K.rbox = rbox; K.seatUnit = seatUnit;
})();
