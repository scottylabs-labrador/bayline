// MetroKit: the Antioch shuttle, a Stadler GTW 2/6-like articulated DMU (two low-floor aluminium end cars riding on a
// central steel power module). One MetroKit "car" = one whole GTW unit (40.89 m over couplers), with bones for the
// three bodies (articulated to follow curves), the three bogies, six wheelsets and the door leaves.
// Dimensions: BARTchives fleet page / Stadler fact sheet (length 134 ft 1.8 in, width 9 ft 8 in); the rest ASSUMED
// from photos and the GTW family (floor 0.635 m, roof 3.72 m + equipment, door and window positions): see trains.md.
(() => {
  const K = MetroKit._k, { MB, rrect, densify, fnorm, tr, rotY, rotZ, rotX, mul, M4, TAU } = K;
  const { clamp, lerp } = U;

  const D = {
    HL: 20.445, W: 1.473, FLOOR: 0.635, RAISED: 1.05, ROOF: 3.72, SKIRT: 0.32,
    JOINT: 2.675, MOD: 2.5, END0: 2.85, NOSE_XC: 19.55, NOSE_R: 0.34, CAB_BACK: 18.45,
    BOG_A: 16.9, WB: 2.1, WR: 0.375, GAUGE: 1.435,
    DOOR: 6.4, PORTAL: 0.65, LEAF: 0.66, LEAF_Y0: 0.625, LEAF_Y1: 2.62, WIN_Y0: 1.32, WIN_Y1: 2.42,
    WINS: [3.72, 8.55, 10.2, 11.85, 13.5, 15.2, 17.05],
  };
  K.GTW = D;
  // bones: 0 root, 1 body A (+X), 2 module, 3 body B; 4 bogie A, 5 module bogie, 6 bogie B; 7..12 wheelsets; 13..20 leaves
  const BONE = { bodyA: 1, mod: 2, bodyB: 3, bog: [4, 5, 6], axle: [7, 8, 9, 10, 11, 12], leaf: (e, s, k) => 13 + (e > 0 ? 0 : 4) + (s > 0 ? 0 : 2) + (k < 0 ? 0 : 1), N: 21 };

  function makeProfile(q) {
    const dense = [];
    for (let i = 0; i <= 30; i++) { const y = D.SKIRT + 0.25 * i / 30; dense.push([y, D.W - 0.06 * ((0.25 - (y - D.SKIRT)) / 0.25) ** 2]); }
    dense.push([2.4, D.W]);
    const YC = 2.4, B = D.ROOF - YC, e = 2 / 2.5;
    for (let i = 0; i <= 500; i++) { const th = (i / 500) * Math.PI / 2; dense.push([YC + B * Math.pow(Math.sin(th), e), D.W * Math.pow(Math.cos(th), e)]); }
    return K.fotfProfile.profileFrom(dense, q);
  }

  // ------------------------------------------------------------------------------------------ the unit
  function build(type, q) {
    K.decalAtlas();
    const { bodyAt, tAtY, sectionLoop } = K.fotfProfile, P = makeProfile(q), E = new MB(), G = new MB();
    const tCant = tAtY(P, 2.9);
    for (const e of [1, -1]) {                     // e = +1: end car A (+X), -1: end car B (mirrored)
      const body = e > 0 ? BONE.bodyA : BONE.bodyB; E.bone = body; G.bone = body;
      const xa = D.END0, xb = D.NOSE_XC;
      for (const s of [1, -1]) {
        const holes = D.WINS.map(xc => ({ x0: e * xc - 0.7, x1: e * xc + 0.7, t0: tAtY(P, D.WIN_Y0), t1: tAtY(P, D.WIN_Y1), r: 0.12 }));
        holes.push({ x0: e * D.DOOR - D.LEAF, x1: e * D.DOOR + D.LEAF, t0: tAtY(P, D.LEAF_Y0), t1: tAtY(P, D.LEAF_Y1), r: [0, 0, 0.05, 0.05] });
        const x0 = e > 0 ? xa : -xb, x1 = e > 0 ? xb : -xa;
        const inner = new MB(); inner.bone = body;
        K.sideGrid(E, P, s, x0, x1, 0, P.T, holes, (xm, tm) => tm > tCant ? 'roof' : 'aluDmu', 0, [], [tCant]);
        // window gaskets and glass
        for (const xc of D.WINS) {
          const o = K.rrXT(P, e * xc - 0.7, e * xc + 0.7, D.WIN_Y0, D.WIN_Y1, 0.12), gi = K.rrXT(P, e * xc - 0.66, e * xc + 0.66, D.WIN_Y0 + 0.04, D.WIN_Y1 - 0.04, 0.08);
          K.ring(E, P, s, o, gi, 0.003, -0.02, 'rubber'); K.fill(G, P, s, gi, -0.02, 'lensClear');
        }
        // the doorway (frame recess, jambs, threshold) and the two plug leaves on their bones
        doorway(E, G, P, s, e, body);
        // livery decals: the unit number on the blue, a mark on the module-side end
        numberRun(E, P, s, e * 18.35, 1.02, 0.17, [1, 2, 3]);
      }
      // the cab nose
      nose(E, G, P, e);
      // roof: an air-conditioning unit over each end car's saloon
      E.pal('roof'); E.bone = body;
      K.rbox(E, e * 7.4 - 1.3, D.ROOF - 0.05, -0.85, e * 7.4 + 1.3, D.ROOF + 0.27, 0.85, 0.08, 3);
      E.pal('grille'); for (const s of [1, -1]) E.box(e * 7.4 - 1.0, D.ROOF + 0.02, s * 0.855 - 0.004, e * 7.4 + 1.0, D.ROOF + 0.2, s * 0.855 + 0.004);
      // underframe skirts / equipment (low floor: little under the car except over the outer bogie)
      E.pal('frame'); E.box(e * 3.2, D.SKIRT, -1.35, e * 14.8, D.SKIRT + 0.05, 1.35, 'Y');
      E.pal('equip'); E.box(Math.min(e * 9.0, e * 12.5), 0.2, 0.3, Math.max(e * 9.0, e * 12.5), D.SKIRT, 1.2);
      // the articulation end: a flat end wall facing the module, with the bellows between
      E.pal('aluDmu'); capSection(E, P, e * D.END0, -e);
    }
    // ------------------------------------------------------------ the power module: steel box, louvres, roof radiators
    E.bone = BONE.mod; G.bone = BONE.mod;
    for (const s of [1, -1]) {
      K.sideGrid(E, P, s, -D.MOD, D.MOD, 0, P.T, [{ x0: -1.9, x1: 1.9, t0: tAtY(P, 1.1), t1: tAtY(P, 2.75), r: 0.04 }], (xm, tm) => tm > tCant ? 'roof' : 'moduleGrey', 0, [], [tCant]);
      // louvre panels in the recess
      E.pal('louver'); K.fill(E, P, s, K.rrXT(P, -1.9, 1.9, 1.1, 2.75, 0.04), -0.03, 'louver');
      E.pal('moduleGrey'); for (const x of [-0.65, 0.65]) { const a = bodyAt(P, x, tAtY(P, 1.1), s, 0), b = bodyAt(P, x, tAtY(P, 2.75), s, 0); E.box(x - 0.03, a.p[1], Math.min(a.p[2], a.p[2] - s * 0.04), x + 0.03, b.p[1], Math.max(a.p[2], a.p[2] - s * 0.04)); }
      decalOnSide(E, P, s, 0, 2.92, 0.36, 0.36, 'sticker');
    }
    capSection(E, P, D.MOD, 1); capSection(E, P, -D.MOD, -1);
    E.pal('roofDk' in K.PI ? 'roofDk' : 'frame');
    E.pal('grille'); K.rbox(E, -2.2, D.ROOF - 0.05, -0.9, 2.2, D.ROOF + 0.22, 0.9, 0.05, 2);
    E.pal('frameLt'); for (const z of [-0.3, 0.3]) E.cyl([0.6, D.ROOF + 0.2, z], [0.6, D.ROOF + 0.5, z], 0.07, 0.07, 12);
    E.pal('equip'); E.box(-2.3, 0.18, -1.3, 2.3, D.SKIRT + 0.1, 1.3);
    // bellows between the module and the end cars
    for (const e of [1, -1]) { E.bone = e > 0 ? BONE.bodyA : BONE.bodyB; E.pal('rubber'); const x0 = e * D.MOD, x1 = e * D.END0;
      E.box(Math.min(x0, x1), 0.7, -1.25, Math.max(x0, x1), 3.45, 1.25); }
    // bogies
    bogie(E, 0, D.BOG_A); bogie(E, 1, 0); bogie(E, 2, -D.BOG_A);
    return { ext: E.geometry(), glass: G.geometry(), P, tris: (E.I.length + G.I.length) / 3 };
  }
  function capSection(E, P, x, dir) {
    const { sectionLoop } = K.fotfProfile, L = sectionLoop(P), pts = L.map(p => [p.z, p.y]);
    E.shape(dir > 0 ? pts : pts.slice().reverse(), [], (z, y) => ({ p: [x, y, z], n: [dir, 0, 0] }));
  }
  function decalOnSide(E, P, s, xc, yc, w, h, cell) {
    const r = K.ATL[cell]; if (!r) return; const { bodyAt, tAtY } = K.fotfProfile; E.pal('decal');
    const t0 = tAtY(P, yc - h / 2), t1 = tAtY(P, yc + h / 2), base = E.count;
    for (let i = 0; i <= 2; i++) for (const [t, v] of [[t0, r[1]], [t1, r[3]]]) { const f = i / 2, xx = s > 0 ? xc - w / 2 + w * f : xc + w / 2 - w * f, b = bodyAt(P, xx, t, s, 0.003);
      E.v(b.p[0], b.p[1], b.p[2], b.n[0], b.n[1], b.n[2], r[0] + (r[2] - r[0]) * f, v, b.ty); }
    for (let i = 0; i < 2; i++) { const a = base + i * 2; E.quadA(a, a + 2, a + 3, a + 1); }
  }
  function numberRun(E, P, s, xc, yc, gh, slots) {
    const { bodyAt, tAtY } = K.fotfProfile; E.pal('numW'); const gw = gh * 0.6, n = slots.length, w = gw * n, t0 = tAtY(P, yc - gh / 2), t1 = tAtY(P, yc + gh / 2);
    for (let k = 0; k < n; k++) { const xa = s > 0 ? xc - w / 2 + k * gw : xc + w / 2 - k * gw, xb = s > 0 ? xa + gw : xa - gw;
      const c = [[xa, t0, slots[k] + 0.001, 0], [xb, t0, slots[k] + 0.999, 0], [xb, t1, slots[k] + 0.999, 1], [xa, t1, slots[k] + 0.001, 1]].map(([x, t, u, v]) => { const b = bodyAt(P, x, t, s, 0.003); return E.v(b.p[0], b.p[1], b.p[2], b.n[0], b.n[1], b.n[2], u, v, b.ty); });
      E.quadA(c[0], c[1], c[2], c[3]); }
  }
  function doorway(E, G, P, s, e, body) {
    const { bodyAt, tAtY } = K.fotfProfile, dc = e * D.DOOR, tL0 = tAtY(P, D.LEAF_Y0), tL1 = tAtY(P, D.LEAF_Y1);
    E.bone = body;
    const band = (x0, x1, t0, t1, pal) => { E.pal(pal); const pts = [[x0, t0], [x1, t0], [x1, t1], [x0, t1]].map(([x, t]) => bodyAt(P, x, t, s, -0.035));
      const id = pts.map(b => E.v(b.p[0], b.p[1], b.p[2], b.n[0], b.n[1], b.n[2], 0, 0, b.ty)); if (s > 0) E.quad(id[0], id[1], id[2], id[3]); else E.quad(id[0], id[3], id[2], id[1]); };
    band(dc - D.LEAF, dc - D.PORTAL, tL0, tL1, 'rubber'); band(dc + D.PORTAL, dc + D.LEAF, tL0, tL1, 'rubber'); band(dc - D.PORTAL, dc + D.PORTAL, tAtY(P, 2.58), tL1, 'rubber');
    E.pal('tread'); E.box(dc - D.PORTAL, D.FLOOR - 0.01, Math.min(s * D.W, s * (D.W - 0.14)), dc + D.PORTAL, D.FLOOR + 0.004, Math.max(s * D.W, s * (D.W - 0.14)));
    E.pal('yellow'); E.box(dc - D.PORTAL, D.FLOOR + 0.004, Math.min(s * D.W, s * (D.W - 0.05)), dc + D.PORTAL, D.FLOOR + 0.006, Math.max(s * D.W, s * (D.W - 0.05)));
    for (const k of [-1, 1]) {
      const bone = BONE.leaf(e, s, k); E.bone = bone; G.bone = bone;
      const a = k < 0 ? dc - D.LEAF : dc, b = k < 0 ? dc : dc + D.LEAF, gap = 0.004, t0 = tL0 + gap, t1 = tL1 - gap;
      const win = { x0: a + 0.12, x1: b - 0.12, t0: tAtY(P, 1.25), t1: tAtY(P, 2.42), r: 0.08 };
      K.sideGrid(E, P, s, a + gap, b - gap, t0, t1, [win], () => 'aluDoor', 0, [], []);
      const o = K.rrXT(P, a + 0.12, b - 0.12, 1.25, 2.42, 0.08), gi = K.rrXT(P, a + 0.15, b - 0.15, 1.28, 2.39, 0.05);
      K.ring(E, P, s, o, gi, 0.002, -0.018, 'rubber'); K.fill(G, P, s, gi, -0.018, 'lensClear');
      const inner = new MB(); inner.bone = bone; K.sideGrid(inner, P, s, a + gap, b - gap, t0, t1, [win], () => 'wallInt2', -0.035, [], []);
      for (let i = 0; i < inner.I.length; i += 3) { const tt = inner.I[i + 1]; inner.I[i + 1] = inner.I[i + 2]; inner.I[i + 2] = tt; } for (let i = 0; i < inner.N.length; i++) inner.N[i] = -inner.N[i]; E.append(inner);
      E.pal('keyGreen'); const pb = bodyAt(P, dc + k * 0.1, tAtY(P, 1.1), s, 0.004); E.box(pb.p[0] - 0.035, pb.p[1] - 0.035, pb.p[2] - 0.004, pb.p[0] + 0.035, pb.p[1] + 0.035, pb.p[2] + 0.004);
    }
    E.bone = body; G.bone = body;
  }
  // ------------------------------------------------------------------------------------------ the GTW nose
  // Section closed by a 0.34 m fillet into a raked face (the top 0.5 m behind the bottom), a wide black glazed band with
  // one big windscreen, white cap below with the blue swoosh wrapping the lower corners, lamp clusters, dark apron.
  function nose(E, G, P, e) {
    const { sectionLoop } = K.fotfProfile, L = sectionLoop(P), n = L.length, A = 7, R = D.NOSE_R, xs = D.NOSE_XC;
    // the GTW's raked cab: the windscreen leans back ~0.7 m from the waist to the roof, the chin juts a little
    const rake = y => -0.72 * clamp((y - 1.5) / 2.1, 0, 1) ** 1.15 + 0.06 * clamp((1.3 - y) / 0.7, 0, 1);
    const bulge = z => 0.12 * (1 - (z / 1.2) ** 2);
    const faceX = (y, z) => xs + R + rake(y) + bulge(z);
    const X = x => e * x, Z = z => e * z;                   // (end car B is the mirror image)
    E.bone = e > 0 ? BONE.bodyA : BONE.bodyB; G.bone = E.bone;
    const Pp = [], Nn = [];
    for (let i = 0; i < n; i++) for (let j = 0; j <= A; j++) {
      const a = (j / A) * Math.PI / 2, p = L[i], off = R * (1 - Math.cos(a)), w = 1 - Math.cos(a), y = p.y - p.ny * off, z = p.z - p.nz * off;
      Pp.push([X(xs + R * Math.sin(a) + w * (rake(y) + bulge(z))), y, Z(z)]); Nn.push([e * Math.sin(a), p.ny * Math.cos(a), e * p.nz * Math.cos(a)]);
    }
    E.gridQuads(Pp, Nn, n, A + 1, (i, j) => (L[i].y > 2.95 && j < 4) ? 'roof' : (L[i].y < 2.0 ? 'paintDmu' : 'cap'));
    const face = L.map(p => [p.z - p.nz * R, p.y - p.ny * R]);
    const fn = (y, z) => { const ex = 1e-3, dy = (faceX(y + ex, z) - faceX(y - ex, z)) / (2 * ex), dz = (faceX(y, z + ex) - faceX(y, z - ex)) / (2 * ex), l = Math.hypot(1, dy, dz); return [e / l, -dy / l, -e * dz / l]; };
    const at = (z, y, off = 0) => { const nn = fn(y, z); return { p: [X(faceX(y, z)) + nn[0] * off, y + nn[1] * off, Z(z) + nn[2] * off], n: nn }; };
    const ccw = poly => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return a > 0 ? poly : poly.slice().reverse(); };
    const cw = poly => ccw(poly).slice().reverse();
    const faceTop = z => { let best = 0; for (const [fz, fy] of face) if (Math.abs(fz - z) < 0.12 && fy > best) best = fy; return best; };
    // windscreen band: black glazing from 1.95 to near the top, one big windscreen inside it
    const band = []; for (let i = 0; i <= 30; i++) { const z = 1.12 - 2.24 * i / 30; band.push([z, 1.95 + 0.1 * (Math.abs(z) / 1.12) ** 3]); }
    for (let i = 0; i <= 40; i++) { const z = -1.12 + 2.24 * i / 40; band.push([z, Math.max(2.2, faceTop(z) - 0.14)]); }
    const ws = []; for (let i = 0; i <= 24; i++) { const z = 1.0 - 2.0 * i / 24; ws.push([z, 2.08 + 0.08 * (Math.abs(z) / 1.0) ** 3]); }
    for (let i = 0; i <= 30; i++) { const z = -1.0 + 2.0 * i / 30; ws.push([z, Math.max(2.3, faceTop(z) - 0.27)]); }
    const lampL = rrect(0.7, 1.18, 1.16, 1.42, 0.09, 4), lampR = rrect(-1.16, 1.18, -0.7, 1.42, 0.09, 4);
    const faceD = densify(face, 0.12).filter(q => q[1] > 0.5);
    E.pal('paintDmu'); E.shape(ccw(faceD), [cw(band), cw(lampL), cw(lampR)], (z, y) => at(z, y));
    E.pal('mask'); E.shape(ccw(band), [cw(ws)], (z, y) => at(z, y, 0.0015));
    G.pal('lensClear'); G.shape(ccw(ws), [], (z, y) => at(z, y, -0.012));
    // lamp clusters: black housings with a white head lamp and a red tail lamp each
    for (const s of [1, -1]) {
      // lamp clusters: a rounded black housing with two white head lamps (inboard) and a red tail lamp (outboard)
      const zc = s * 0.93, yc = 1.3, c = at(zc, yc, -0.02);
      E.pal('podBlack'); E.at(mul(tr(c.p[0], yc, c.p[2]), rotY(e > 0 ? 0 : Math.PI)), m => K.rbox(m, -0.03, -0.12, -0.225, 0.02, 0.12, 0.225, 0.05, 3));
      for (const dz of [-0.14, -0.02]) { E.pal(e > 0 ? 'headLamp' : 'headLampB'); E.at(mul(tr(c.p[0], yc, c.p[2] + e * s * dz), rotY(e > 0 ? 0 : Math.PI)), m => m.cyl([0.012, 0, 0], [0.03, 0, 0], 0.062, 0.058, 16)); }
      E.pal(e > 0 ? 'tailLamp' : 'tailLampB'); E.at(mul(tr(c.p[0], yc, c.p[2] + e * s * 0.13), rotY(e > 0 ? 0 : Math.PI)), m => m.cyl([0.012, 0, 0], [0.03, 0, 0], 0.048, 0.045, 14));
    }
    // dark apron under the face, anticlimbers, Scharfenberg coupler, destination sign behind the windscreen (in glass shader)
    // below the face: a black valance with the coupler pocket, slim anticlimber plates either side of it
    E.pal('frame'); E.box(Math.min(X(xs), X(xs + R + 0.12)), 0.3, -1.3, Math.max(X(xs), X(xs + R + 0.12)), 0.52, 1.3);
    E.pal('bumper'); for (const s of [1, -1]) K.rbox(E, Math.min(X(xs + R + 0.1), X(xs + R + 0.2)), 0.5, Math.min(s * 0.42, s * 0.95), Math.max(X(xs + R + 0.1), X(xs + R + 0.2)), 0.64, Math.max(s * 0.42, s * 0.95), 0.02, 2);
    E.pal('coupler'); E.cyl([X(xs + 0.2), 0.62, 0], [X(D.HL - 0.1), 0.62, 0], 0.06, 0.06, 10); E.box(Math.min(X(D.HL - 0.14), X(D.HL)), 0.48, -0.16, Math.max(X(D.HL - 0.14), X(D.HL)), 0.76, 0.16);
    E.pal('topBar'); { const c = at(0, faceTop(0) - 0.07, 0.01); E.box(c.p[0] - 0.02, c.p[1] - 0.03, -0.3, c.p[0] + 0.02, c.p[1] + 0.03, 0.3); }
  }
  // ------------------------------------------------------------------------------------------ bogies
  function bogie(E, k, bx) {
    E.bone = BONE.bog[k];
    const hb = D.WB / 2, zf = 1.0;
    for (const s of [1, -1]) {
      E.pal('frame'); E.box(bx - hb - 0.3, 0.45, s * zf - 0.07, bx + hb + 0.3, 0.7, s * zf + 0.07);
      E.pal('rubber'); E.cyl([bx, 0.7, s * zf], [bx, 0.86, s * zf], 0.2, 0.2, 14);
      for (const a of [-1, 1]) { E.pal('frameLt'); E.cyl([bx + a * hb, D.WR, s * (zf - 0.06)], [bx + a * hb, D.WR, s * (zf + 0.1)], 0.11, 0.11, 12);
        E.pal('coil'); E.cyl([bx + a * hb - 0.12, D.WR + 0.08, s * zf], [bx + a * hb - 0.12, 0.47, s * zf], 0.06, 0.06, 8); }
    }
    E.pal('frame'); E.box(bx - 0.25, 0.45, -zf, bx + 0.25, 0.65, zf);
    if (k === 1) { E.pal('frameLt'); for (const a of [-1, 1]) E.cyl([bx + a * 0.5, 0.42, -0.4], [bx + a * 0.5, 0.42, 0.4], 0.2, 0.2, 14); }
    for (const a of [1, -1]) {
      E.bone = BONE.axle[k * 2 + (a > 0 ? 0 : 1)]; const ax = bx + a * hb, g = D.GAUGE / 2;
      for (const s of [1, -1]) { E.pal('wheel'); E.at(mul(tr(ax, D.WR, 0), rotX(Math.PI / 2)), m => m.lathe([[0.07, -s * (g + 0.12)], [0.2, -s * (g + 0.11)], [D.WR, -s * (g + 0.115)], [D.WR, -s * (g + 0.01)], [D.WR + 0.028, -s * (g - 0.01)], [D.WR - 0.03, -s * (g - 0.03)], [0.1, -s * (g - 0.05)]].map(([r, z]) => [r, z]).slice(s > 0 ? 0 : 0), 18)); }
      E.pal('steel'); E.cyl([ax, D.WR, -(g + 0.06)], [ax, D.WR, g + 0.06], 0.075, 0.075, 10);
    }
    E.bone = 0;
  }

  // ------------------------------------------------------------------------------------------ LODs
  function lod(d, level) {
    const E = new MB(), P = d.profile, { bodyAt, tAtY } = K.fotfProfile;
    const ys = level === 1 ? [D.SKIRT, 0.6, D.WIN_Y0, D.WIN_Y1, 2.9, 3.4, 3.65] : [D.SKIRT, 1.2, 2.45, 3.4];
    const sec = ys.map(y => bodyAt(P, 0, tAtY(P, y), 1, 0)).map(b => [b.p[1], b.p[2], b.n[1], b.n[2]]); sec.push([D.ROOF, 0, 1, 0]);
    const xs = new Set([-D.NOSE_XC, -D.END0, -D.MOD, D.MOD, D.END0, D.NOSE_XC]);
    if (level === 1) for (const e of [1, -1]) { for (const w of D.WINS) { xs.add(e * w - 0.7); xs.add(e * w + 0.7); } xs.add(e * D.DOOR - D.LEAF); xs.add(e * D.DOOR + D.LEAF); }
    const X = [...xs].sort((a, b) => a - b);
    const cell = (xm, ym) => { const ax = Math.abs(xm);
      if (ym > 2.95) return 'roof'; if (ax < D.MOD) return 'moduleGrey'; if (ax < D.END0) return 'rubber';
      if (level === 1 && ym > D.WIN_Y0 && ym < D.WIN_Y1 && D.WINS.some(w => Math.abs(ax - w) < 0.7)) return 'lodWin';
      if (level === 2 && ym > 1.2 && ym < 2.45) return 'lodWin';
      return 'aluDmu'; };
    for (const s of [1, -1]) for (let i = 0; i < X.length - 1; i++) for (let j = 0; j < sec.length - 1; j++) {
      const xa = X[i], xb = X[i + 1], A = sec[j], B = sec[j + 1]; E.pal(cell((xa + xb) / 2, (A[0] + B[0]) / 2));
      const v0 = E.v(xa, A[0], s * A[1], 0, A[2], s * A[3]), v1 = E.v(xb, A[0], s * A[1], 0, A[2], s * A[3]), v2 = E.v(xb, B[0], s * B[1], 0, B[2], s * B[3]), v3 = E.v(xa, B[0], s * B[1], 0, B[2], s * B[3]);
      E.quadA(v0, v1, v2, v3);
    }
    for (const e of [1, -1]) {
      const pts = []; for (const q of sec) pts.push([q[1], q[0]]); for (let i = sec.length - 2; i >= 0; i--) pts.push([-sec[i][1], sec[i][0]]);
      E.pal('cap'); E.shape(pts, [], (z, y) => ({ p: [e * (D.NOSE_XC + 0.3), y, z], n: [e, 0, 0] }));
      E.pal('mask'); E.shape([[-1.1, 1.95], [1.1, 1.95], [1.1, 3.2], [-1.1, 3.2]], [], (z, y) => ({ p: [e * (D.NOSE_XC + 0.305), y, z], n: [e, 0, 0] }));
      for (const s of [1, -1]) { E.pal('headLamp'); E.box(e * (D.NOSE_XC + 0.3), 1.2, s * 0.96 - 0.1, e * (D.NOSE_XC + 0.33), 1.4, s * 0.96 + 0.1); }
      E.pal('frame'); E.box(e * D.BOG_A - 1.4, 0.15, -1.1, e * D.BOG_A + 1.4, 0.75, 1.1);
    }
    E.pal('frame'); E.box(-1.3, 0.15, -1.1, 1.3, 0.75, 1.1);
    return E.geometry();
  }

  // ------------------------------------------------------------------------------------------ interior (simple)
  function interior(d, q) {
    const E = new MB(), G = new MB(), P = d.profile, { bodyAt, tAtY } = K.fotfProfile, FY = D.FLOOR;
    for (const e of [1, -1]) {
      const body = e > 0 ? BONE.bodyA : BONE.bodyB; E.bone = body; G.bone = body;
      const x0 = e * D.END0, x1 = e * D.CAB_BACK, lo = Math.min(x0, x1), hi = Math.max(x0, x1);
      E.pal('floor'); E.q4([lo, FY, 1.35], [hi, FY, 1.35], [hi, FY, -1.35], [lo, FY, -1.35]);
      // inner walls (a flat lining at |z| 1.36 below the windows, the window reveals are open to the glass)
      for (const s of [1, -1]) { E.pal('wallInt'); E.q4(...(s > 0 ? [[lo, FY, 1.36], [lo, 1.3, 1.36], [hi, 1.3, 1.36], [hi, FY, 1.36]] : [[hi, FY, -1.36], [hi, 1.3, -1.36], [lo, 1.3, -1.36], [lo, FY, -1.36]]));
        E.pal('wallInt2'); E.q4(...(s > 0 ? [[lo, 2.45, 1.34], [lo, 2.95, 1.1], [hi, 2.95, 1.1], [hi, 2.45, 1.34]] : [[hi, 2.45, -1.34], [hi, 2.95, -1.1], [lo, 2.95, -1.1], [lo, 2.45, -1.34]])); }
      E.pal('ceil'); E.q4([lo, 3.0, -1.1], [lo, 3.0, 1.1], [hi, 3.0, 1.1], [hi, 3.0, -1.1]);
      E.pal('lightStrip'); for (const z of [-0.55, 0.55]) E.q4([lo + 0.3, 2.995, z - 0.06], [lo + 0.3, 2.995, z + 0.06], [hi - 0.3, 2.995, z + 0.06], [hi - 0.3, 2.995, z - 0.06]);
      // seats: facing bays (2 + 2) between the door and the cab, and at the module end
      const bays = [[e * 3.3, e * 5.2], [e * 8.0, e * 15.6]];
      for (const [a, b] of bays) { const la = Math.min(a, b), lb = Math.max(a, b), nb = Math.floor((lb - la) / 1.75);
        for (let i = 0; i < nb; i++) { const xb = la + 0.1 + i * 1.75;
          for (const s of [1, -1]) { E.at(mul(tr(xb, FY, s * 0.42), M4().makeScale(1, 1, s)), m => K.seatUnit(m, 2, 'seatBlue', q, { handle: -1 }));
            E.at(mul(tr(xb + 1.62, FY, s * 0.42), M4().makeScale(-1, 1, s)), m => K.seatUnit(m, 2, i === 0 ? 'seatLime' : 'seatBlue', q, { handle: -1 })); } } }
      // poles at the doorway, cab back wall
      E.pal('pole'); for (const s of [1, -1]) for (const k of [-1, 1]) E.cyl([e * D.DOOR + k * 0.75, FY, s * 0.95], [e * D.DOOR + k * 0.75, 2.95, s * 0.95], 0.017, 0.017, 10);
      E.pal('wallInt2'); E.q4(...(e > 0 ? [[x1, FY, 1.36], [x1, FY, -1.36], [x1, 3.0, -1.36], [x1, 3.0, 1.36]] : [[x1, FY, -1.36], [x1, FY, 1.36], [x1, 3.0, 1.36], [x1, 3.0, -1.36]]));
    }
    // the module passage
    E.bone = BONE.mod; E.pal('floorDecal'); E.q4([-D.END0, FY, 0.43], [D.END0, FY, 0.43], [D.END0, FY, -0.43], [-D.END0, FY, -0.43]);
    E.pal('wallInt2'); for (const s of [1, -1]) E.q4(...(s > 0 ? [[-D.END0, FY, 0.43], [-D.END0, 2.6, 0.43], [D.END0, 2.6, 0.43], [D.END0, FY, 0.43]] : [[D.END0, FY, -0.43], [D.END0, 2.6, -0.43], [-D.END0, 2.6, -0.43], [-D.END0, FY, -0.43]]));
    E.pal('ceil'); E.q4([-D.END0, 2.6, -0.43], [-D.END0, 2.6, 0.43], [D.END0, 2.6, 0.43], [D.END0, 2.6, -0.43]);
    return { geo: E.geometry(), glass: G.geometry(), tris: E.I.length / 3 };
  }

  // interior impression (see 42_metrokit_fotf.js for the fields): facing bays, the sloped cove, the LED strips,
  // the far wall's windows and doors, door poles, standing spots in the door vestibules
  function dmuImap() {
    const rows = [], win = [], stand = [], poles = [];
    for (const e of [1, -1]) {
      for (const [a, bb] of [[e * 3.3, e * 5.2], [e * 8.0, e * 15.6]]) { const la = Math.min(a, bb), lb = Math.max(a, bb), nb = Math.floor((lb - la) / 1.75);
        for (let i = 0; i < nb; i++) { const xb = la + 0.1 + i * 1.75;
          for (const s of [1, -1]) { const zr = s > 0 ? [0.42, 1.34] : [-1.34, -0.42]; rows.push([xb + 0.05, zr[0], zr[1], 1], [xb + 1.57, zr[0], zr[1], i === 0 ? -2 : -1]); } } }
      for (const xc of D.WINS) win.push([e * xc - 0.66, e * xc + 0.66, D.WIN_Y0 + 0.04, D.WIN_Y1 - 0.04]);
      for (const s of [1, -1]) for (const k of [-1, 1]) poles.push([e * D.DOOR + k * 0.75, s * 0.95, 0.017, 2.95]);
      for (const [dx, z] of [[-0.3, 0.45], [0.35, -0.5], [0.1, 0.0], [-0.45, -0.2]]) stand.push([e * D.DOOR + dx, z]);
    }
    return { rows: rows.slice(0, 40), sec: [[1.36, 2.45], [1.1, 2.95], [0, 3.0]], band: [0.49, 0.61, 0, 0], win: win.slice(0, 16),
      doors: [[D.DOOR, D.PORTAL, D.LEAF_Y1, 0], [-D.DOOR, D.PORTAL, D.LEAF_Y1, 0]], doorWin: [0.06, 0.58, 1.3, 2.35], poles, rail: [0, 0, 0, 0], panels: [], standAll: stand, cab: null };
  }

  // ------------------------------------------------------------------------------------------ registration
  K.builders.dmu = function (type, q) {
    const b = build(type, q), hb = D.WB / 2;
    const bones = []; for (let i = 0; i < BONE.N; i++) bones.push({ pivot: [0, 0, 0] });
    bones[BONE.bodyA].pivot = [D.BOG_A, 0, 0]; bones[BONE.bodyB].pivot = [-D.BOG_A, 0, 0]; bones[BONE.mod].pivot = [0, 0, 0];
    D.BOG_A && [[BONE.bog[0], D.BOG_A], [BONE.bog[1], 0], [BONE.bog[2], -D.BOG_A]].forEach(([bi, x]) => { bones[bi].pivot = [x, 0, 0]; });
    [[0, D.BOG_A + hb], [1, D.BOG_A - hb], [2, hb], [3, -hb], [4, -D.BOG_A + hb], [5, -D.BOG_A - hb]].forEach(([k, x]) => { bones[BONE.axle[k]].pivot = [x, D.WR, 0]; });
    const leaves = []; for (const e of [1, -1]) for (const s of [1, -1]) for (const k of [-1, 1]) leaves.push({ bone: BONE.leaf(e, s, k), side: s, k, body: e > 0 ? 0 : 2 });
    const doors = []; for (const e of [1, -1]) for (const s of [1, -1]) doors.push({ x: e * D.DOOR, side: s, width: 1.3, sillY: D.FLOOR });
    const seats = [], floorRegions = [];
    for (const e of [1, -1]) { const lo = Math.min(e * D.END0, e * D.CAB_BACK), hi = Math.max(e * D.END0, e * D.CAB_BACK);
      floorRegions.push({ name: e > 0 ? 'carA' : 'carB', x0: lo + 0.1, x1: hi - 0.1, z0: -1.25, z1: 1.25, y: D.FLOOR });
      for (const [a, bb] of [[e * 3.3, e * 5.2], [e * 8.0, e * 15.6]]) { const la = Math.min(a, bb), lb = Math.max(a, bb), nb = Math.floor((lb - la) / 1.75);
        for (let i = 0; i < nb; i++) { const xb = la + 0.1 + i * 1.75; for (const s of [1, -1]) for (const z of [0.72, 1.23]) { seats.push({ x: xb + 0.33, y: D.FLOOR + 1.2, z: s * z, yaw: 0 }); seats.push({ x: xb + 1.62 - 0.33, y: D.FLOOR + 1.2, z: s * z, yaw: Math.PI }); } } } }
    floorRegions.push({ name: 'module', x0: -D.END0, x1: D.END0, z0: -0.38, z1: 0.38, y: D.FLOOR });
    return {
      ext: b.ext, glass: b.glass, tris: b.tris, length: 2 * D.HL, width: 2 * D.W, height: D.ROOF + 0.3, profile: b.P,
      sphere: new THREE.Sphere(new THREE.Vector3(0, 1.9, 0), 21.2),
      bones, boneIdx: { bogie: [BONE.bog[0], BONE.bog[2]], axlesOf: [[BONE.axle[0], BONE.axle[1]], [BONE.axle[4], BONE.axle[5]]] },
      bogieList: [{ bone: BONE.bog[0], pivot: [D.BOG_A, 0, 0], axles: [BONE.axle[0], BONE.axle[1]] }, { bone: BONE.bog[1], pivot: [0, 0, 0], axles: [BONE.axle[2], BONE.axle[3]] }, { bone: BONE.bog[2], pivot: [-D.BOG_A, 0, 0], axles: [BONE.axle[4], BONE.axle[5]] }],
      bodyList: [{ bone: BONE.bodyA, pivot: [D.BOG_A, 0, 0] }, { bone: BONE.mod, pivot: [0, 0, 0] }, { bone: BONE.bodyB, pivot: [-D.BOG_A, 0, 0] }],
      artic: { joints: [D.JOINT, -D.JOINT], mid: 0, pivots: [D.BOG_A, -D.BOG_A] },
      leaves, wipers: [], plugOut: 0.03, slide: 0.66,
      meta: { bogieOffsets: [D.BOG_A, -D.BOG_A], doors, floorRegions, ramps: [], gangways: { front: null, rear: null }, seats, cabEye: [D.CAB_BACK + 0.9, D.FLOOR + 1.9, 0.55] },
      imap: dmuImap(), lamp: [0.55, 2.995, 17.6], halfW: 1.36, floorY: D.FLOOR, ceilY: 3.0, cabBox: new THREE.Vector4(-D.CAB_BACK, D.CAB_BACK, 1, 0),
      signs: [{ a: [0, D.NOSE_XC + 0.08, -0.95, -0.35], b: [2.84, 2.96, -1] }, { a: [0, -(D.NOSE_XC + 0.08), 0.35, 0.95], b: [2.84, 2.96, 1] }],
      lamps: [1, -1].flatMap(e => [1, -1].flatMap(s => [{ p: [e * (D.NOSE_XC + 0.44), 1.3, e * s * 0.85], kind: e > 0 ? 'head' : 'headB' }, { p: [e * (D.NOSE_XC + 0.42), 1.3, e * s * 1.06], kind: e > 0 ? 'tail' : 'tailB' }])),
    };
  };
  K.builders.dmu.interior = (d, q) => interior(d, q);
  K.builders.dmu.lod = (d, level) => lod(d, level);
  K.builders.dmu.consist = (n) => { const out = []; for (let i = 0; i < Math.max(1, n); i++) out.push({ type: 'GTW', flip: false, number: String(101 + i) }); return out; };
})();
