// MetroKit: the Coliseum - Oakland Airport connector, a Doppelmayr Cable Liner-like cable-hauled people mover.
// Trains of 3 cars (end cars with the rounded glazed nose, a middle car), white bodies with a full-height black glazing
// band and five light-blue stripes low on the side, centre sliding doors, a haul-rope grip under each car.
// Dimensions ASSUMED from photos (see trains.md): car 9.3 m (end cars 10.1 m with the nose), width 2.6 m, roof 3.1 m
// above the running rails (standard gauge), floor 0.36 m, no driver's cab (automated).
(() => {
  const K = MetroKit._k, { MB, rrect, densify, fnorm, tr, rotY, rotZ, rotX, mul, M4, TAU } = K;
  const { clamp, lerp } = U;
  const A = { W: 1.3, FLOOR: 0.36, ROOF: 3.1, SKIRT: 0.22, LEN: 9.3, LEN_END: 10.1, NOSE_R: 0.45, BAND0: 1.28, BAND1: 2.78, DOOR_W: 0.8, WB: 1.6, WR: 0.25, GAUGE: 1.435 };
  K.APM = A;
  const BONE = { bog: [1, 2], axle: [3, 4, 5, 6], leaf: (s, k) => 7 + (s > 0 ? 0 : 2) + (k < 0 ? 0 : 1), N: 11 };

  function makeProfile(q) {
    const dense = [];
    for (let i = 0; i <= 20; i++) { const y = A.SKIRT + 0.3 * i / 20; dense.push([y, A.W - 0.08 * ((0.3 - (y - A.SKIRT)) / 0.3) ** 2]); }
    dense.push([2.55, A.W]);
    const YC = 2.55, B = A.ROOF - YC, e = 2 / 2.4;
    for (let i = 0; i <= 400; i++) { const th = (i / 400) * Math.PI / 2; dense.push([YC + B * Math.pow(Math.sin(th), e), A.W * Math.pow(Math.cos(th), e)]); }
    return K.fotfProfile.profileFrom(dense, q);
  }

  // type 'end' (nose at +X) or 'mid'
  function build(type, q) {
    K.decalAtlas(K.atlasRes());
    const { bodyAt, tAtY, sectionLoop } = K.fotfProfile, P = makeProfile(q), E = new MB(), G = new MB();
    const isEnd = type === 'end', L = isEnd ? A.LEN_END : A.LEN, xR = -A.LEN / 2 + 0.08, xF = isEnd ? A.LEN / 2 + 0.25 : A.LEN / 2 - 0.08;
    const tB0 = tAtY(P, A.BAND0), tB1 = tAtY(P, A.BAND1), tCant = tAtY(P, 2.95);
    E.bone = 0; G.bone = 0;
    for (const s of [1, -1]) {
      // the glazing band as one hole with glass panes behind thin mullions; the doors in the middle
      const panes = [], pitch = 1.52;
      for (let x = xR + 0.3; x + pitch <= xF - 0.2; x += pitch) { if (Math.abs(x + pitch / 2) < A.DOOR_W + 0.1) continue; panes.push([x + 0.03, x + pitch - 0.03]); }
      const holes = [{ x0: -A.DOOR_W, x1: A.DOOR_W, t0: tAtY(P, A.FLOOR + 0.02), t1: tAtY(P, 2.62), r: 0.05 }];
      const palAt = (xm, tm) => tm > tCant ? 'roof' : (tm > tB0 && tm < tB1 ? 'mask' : 'apmBody');
      K.sideGrid(E, P, s, xR, xF, 0, P.T, holes, palAt, 0, panes.flat(), [tB0, tB1, tCant]);
      for (const [a, b] of panes) { const o = K.rrXT(P, a + 0.05, b - 0.05, A.BAND0 + 0.08, A.BAND1 - 0.08, 0.06); K.fill(G, P, s, o, 0.002, 'lensClear'); }
      // centre door: two glazed sliding leaves on bones
      for (const k of [-1, 1]) { const bone = BONE.leaf(s, k); E.bone = bone; G.bone = bone;
        const x0 = k < 0 ? -A.DOOR_W : 0, x1 = k < 0 ? 0 : A.DOOR_W, gap = 0.004;
        K.sideGrid(E, P, s, x0 + gap, x1 - gap, tAtY(P, A.FLOOR + 0.03), tAtY(P, 2.6), [{ x0: x0 + 0.1, x1: x1 - 0.1, t0: tAtY(P, 0.95), t1: tAtY(P, 2.45), r: 0.05 }], () => 'mask', 0.004, [], []);
        K.fill(G, P, s, K.rrXT(P, x0 + 0.1, x1 - 0.1, 0.95, 2.45, 0.05), -0.004, 'lensClear');
        E.bone = 0; G.bone = 0; }
      // the logo sticker at the nose end, below the band
      if (isEnd) decal(E, P, s, (s > 0 ? 1 : 1) * (A.LEN / 2 - 0.7), 0.95, 0.3, 0.3, 'sticker');
    }
    // ends: a flat end with a gangway bellows (mid, and the end car's rear); the end car's nose
    capSection(E, P, xR, -1, 'apmBody');
    if (!isEnd) capSection(E, P, xF, 1, 'apmBody');
    else nose(E, G, P, xF);
    // underframe: skirts hide the running gear; the grip and two small bogies
    E.pal('frame'); E.box(xR + 0.3, A.SKIRT - 0.02, -1.1, xF - 0.4, A.SKIRT + 0.02, 1.1);
    E.pal('equip'); E.box(-0.6, 0.02, -0.25, 0.6, A.SKIRT, 0.25);
    E.pal('steel'); E.box(-0.15, -0.12, -0.08, 0.15, 0.05, 0.08);                  // the rope grip
    for (let b = 0; b < 2; b++) {
      const bx = b === 0 ? 3.1 : -3.1; E.bone = BONE.bog[b];
      E.pal('frame'); E.box(bx - 1.0, 0.18, -0.95, bx + 1.0, 0.3, 0.95);
      for (const a of [1, -1]) { E.bone = BONE.axle[b * 2 + (a > 0 ? 0 : 1)]; const ax = bx + a * A.WB / 2, g = A.GAUGE / 2;
        E.pal('wheel'); for (const s of [1, -1]) E.cyl([ax, A.WR, s * (g - 0.02)], [ax, A.WR, s * (g + 0.1)], A.WR, A.WR, 16);
        E.pal('steel'); E.cyl([ax, A.WR, -g], [ax, A.WR, g], 0.05, 0.05, 8); }
      E.bone = 0;
    }
    // roof: flush, a small equipment hatch
    E.pal('aluDull'); E.box(-1.0, A.ROOF - 0.01, -0.5, 1.0, A.ROOF + 0.03, 0.5);
    return { ext: E.geometry(), glass: G.geometry(), P, tris: (E.I.length + G.I.length) / 3, len: L, xR, xF };
  }
  function capSection(E, P, x, dir, pal) {
    const { sectionLoop } = K.fotfProfile, L = sectionLoop(P), pts = L.map(p => [p.z, p.y]);
    E.pal(pal); E.shape(dir > 0 ? pts : pts.slice().reverse(), [], (z, y) => ({ p: [x, y, z], n: [dir, 0, 0] }));
    E.pal('rubber'); E.box(Math.min(x, x + dir * 0.12), 0.45, -1.0, Math.max(x, x + dir * 0.12), 2.75, 1.0);
  }
  function decal(E, P, s, xc, yc, w, h, cell) {
    const r = K.ATL[cell]; if (!r) return; const { bodyAt, tAtY } = K.fotfProfile; E.pal('decal');
    const t0 = tAtY(P, yc - h / 2), t1 = tAtY(P, yc + h / 2), base = E.count;
    for (let i = 0; i <= 2; i++) for (const [t, v] of [[t0, r[1]], [t1, r[3]]]) { const f = i / 2, xx = s > 0 ? xc - w / 2 + w * f : xc + w / 2 - w * f, b = bodyAt(P, xx, t, s, 0.003);
      E.v(b.p[0], b.p[1], b.p[2], b.n[0], b.n[1], b.n[2], r[0] + (r[2] - r[0]) * f, v, b.ty); }
    for (let i = 0; i < 2; i++) { const a = base + i * 2; E.quadA(a, a + 2, a + 3, a + 1); }
  }
  // the nose: the section closed by a big rounded fillet; the glazing band wraps round the front, the lower front white
  // with the mark and two small round lamps
  function nose(E, G, P, xs) {
    const { sectionLoop, tAtY } = K.fotfProfile, L = sectionLoop(P), n = L.length, St = 9, R = A.NOSE_R;
    const Pp = [], Nn = [];
    for (let i = 0; i < n; i++) for (let j = 0; j <= St; j++) {
      const a = (j / St) * Math.PI / 2, p = L[i], off = R * (1 - Math.cos(a)), y = p.y - p.ny * off, z = p.z - p.nz * off;
      Pp.push([xs + R * Math.sin(a) * 1.4, y, z]); Nn.push([Math.sin(a), p.ny * Math.cos(a), p.nz * Math.cos(a)]);
    }
    E.gridQuads(Pp, Nn, n, St + 1, (i, j) => { const y = (L[i].y + L[i + 1].y) / 2; return y > A.BAND0 && y < A.BAND1 + 0.2 ? 'mask' : (y > 2.95 ? 'roof' : 'apmBody'); });
    const face = L.map(p => [p.z - p.nz * R, p.y - p.ny * R]), xf = xs + R * 1.4;
    const ccw = poly => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return a > 0 ? poly : poly.slice().reverse(); };
    // face: white below the band, glass above (the windscreen), a black strip on top
    const clip = (poly, c0, c1) => { let out = poly; for (const [c, above] of [[c0, true], [c1, false]]) { const res = []; for (let i = 0; i < out.length; i++) { const a = out[i], b = out[(i + 1) % out.length], ia = above ? a[1] >= c : a[1] <= c, ib = above ? b[1] >= c : b[1] <= c;
      if (ia) res.push(a); if (ia !== ib) { const t = (c - a[1]) / (b[1] - a[1]); res.push([a[0] + (b[0] - a[0]) * t, c]); } } out = res; } return out; };
    const fd = densify(face, 0.1);
    E.pal('apmBody'); E.shape(ccw(clip(fd, 0, A.BAND0)), [], (z, y) => ({ p: [xf, y, z], n: [1, 0, 0] }));
    E.pal('mask'); E.shape(ccw(clip(fd, A.BAND0, 9)), [], (z, y) => ({ p: [xf + 0.001, y, z], n: [1, 0, 0] }));
    G.pal('lensClear'); G.shape(ccw(clip(clip(fd, A.BAND0 + 0.06, 2.9), -9, 9).map(([z, y]) => [z * 0.94, y])), [], (z, y) => ({ p: [xf + 0.004, y, z], n: [1, 0, 0] }));
    for (const s of [1, -1]) { E.pal('podBlack'); E.cyl([xf, 0.72, s * 0.62], [xf + 0.015, 0.72, s * 0.62], 0.07, 0.07, 16); E.pal('headLamp'); E.cyl([xf + 0.01, 0.72, s * 0.62], [xf + 0.022, 0.72, s * 0.62], 0.05, 0.048, 16); }
    const r = K.ATL.noseMark; E.pal('decal'); { const x = xf + 0.003, yc = 0.95; const a = E.v(x, yc - 0.12, 0.24, 1, 0, 0, r[0], r[1]), b = E.v(x, yc - 0.12, -0.24, 1, 0, 0, r[2], r[1]), c = E.v(x, yc + 0.12, -0.24, 1, 0, 0, r[2], r[3]), d = E.v(x, yc + 0.12, 0.24, 1, 0, 0, r[0], r[3]); E.quadA(a, b, c, d); }
    E.pal('frame'); E.box(xs, A.SKIRT, -1.1, xf - 0.05, 0.4, 1.1);
  }
  function lod(d, level) {
    const E = new MB(), P = d.profile, { bodyAt, tAtY } = K.fotfProfile;
    const ys = level === 1 ? [A.SKIRT, 0.7, A.BAND0, A.BAND1, 2.95, 3.05] : [A.SKIRT, A.BAND0, A.BAND1, 3.0];
    const sec = ys.map(y => bodyAt(P, 0, tAtY(P, y), 1, 0)).map(b => [b.p[1], b.p[2], b.n[1], b.n[2]]); sec.push([A.ROOF, 0, 1, 0]);
    const x0 = -A.LEN / 2, x1 = d.type === 'end' ? A.LEN / 2 + 0.55 : A.LEN / 2;
    for (const s of [1, -1]) for (let j = 0; j < sec.length - 1; j++) { const Aa = sec[j], B = sec[j + 1], ym = (Aa[0] + B[0]) / 2; E.pal(ym > A.BAND0 && ym < A.BAND1 ? 'lodWin' : ym > 2.95 ? 'roof' : 'apmBody');
      const v0 = E.v(x0, Aa[0], s * Aa[1], 0, Aa[2], s * Aa[3]), v1 = E.v(x1, Aa[0], s * Aa[1], 0, Aa[2], s * Aa[3]), v2 = E.v(x1, B[0], s * B[1], 0, B[2], s * B[3]), v3 = E.v(x0, B[0], s * B[1], 0, B[2], s * B[3]); E.quadA(v0, v1, v2, v3); }
    for (const [x, e] of [[x0, -1], [x1, 1]]) { const pts = []; for (const q of sec) pts.push([q[1], q[0]]); for (let i = sec.length - 2; i >= 0; i--) pts.push([-sec[i][1], sec[i][0]]);
      E.pal(e > 0 && d.type === 'end' ? 'mask' : 'apmBody'); E.shape(pts, [], (z, y) => ({ p: [x, y, z], n: [e, 0, 0] })); }
    return E.geometry();
  }
  function interior(d, q) {
    const E = new MB(), G = new MB(), FY = A.FLOOR, x0 = -A.LEN / 2 + 0.2, x1 = A.LEN / 2 - (d.type === 'end' ? -0.1 : 0.2);
    E.pal('floor'); E.q4([x0, FY, 1.2], [x1, FY, 1.2], [x1, FY, -1.2], [x0, FY, -1.2]);
    E.pal('ceil'); E.q4([x0, 2.85, -1.1], [x0, 2.85, 1.1], [x1, 2.85, 1.1], [x1, 2.85, -1.1]);
    E.pal('lightStrip'); for (const z of [-0.6, 0.6]) E.q4([x0 + 0.3, 2.845, z - 0.05], [x0 + 0.3, 2.845, z + 0.05], [x1 - 0.3, 2.845, z + 0.05], [x1 - 0.3, 2.845, z - 0.05]);
    for (const s of [1, -1]) { E.pal('wallInt'); E.q4(...(s > 0 ? [[x0, FY, 1.22], [x0, 1.25, 1.22], [x1, 1.25, 1.22], [x1, FY, 1.22]] : [[x1, FY, -1.22], [x1, 1.25, -1.22], [x0, 1.25, -1.22], [x0, FY, -1.22]])); }
    // longitudinal seats along both walls away from the doors, poles by the doors
    for (const s of [1, -1]) for (const [a, b] of [[x0 + 0.2, -1.1], [1.1, x1 - 0.3]]) { if (b - a < 1.0) continue; const n = Math.floor((b - a) / 0.515), W = n * 0.515, xm = (a + b) / 2;
      E.at(mul(tr(xm - s * W / 2, FY, s * 1.15), rotY(s > 0 ? Math.PI / 2 : -Math.PI / 2)), m => K.seatUnit(m, n, 'seatBlue', q, {})); }
    E.pal('pole'); for (const x of [-0.95, 0.95]) for (const z of [-0.5, 0.5]) E.cyl([x, FY, z], [x, 2.85, z], 0.018, 0.018, 10);
    E.pal('pole'); for (const s of [1, -1]) E.cyl([x0 + 0.3, 2.3, s * 0.7], [x1 - 0.3, 2.3, s * 0.7], 0.016, 0.016, 8);
    return { geo: E.geometry(), glass: G.geometry(), tris: E.I.length / 3 };
  }

  K.builders.apm = function (type, q) {
    const b = build(type, q), hb = A.WB / 2;
    const bones = []; for (let i = 0; i < BONE.N; i++) bones.push({ pivot: [0, 0, 0] });
    bones[BONE.bog[0]].pivot = [3.1, 0, 0]; bones[BONE.bog[1]].pivot = [-3.1, 0, 0];
    [[0, 3.1 + hb], [1, 3.1 - hb], [2, -3.1 + hb], [3, -3.1 - hb]].forEach(([k, x]) => { bones[BONE.axle[k]].pivot = [x, A.WR, 0]; });
    const leaves = []; for (const s of [1, -1]) for (const k of [-1, 1]) leaves.push({ bone: BONE.leaf(s, k), side: s, k });
    const doors = [{ x: 0, side: 1, width: 1.6, sillY: A.FLOOR }, { x: 0, side: -1, width: 1.6, sillY: A.FLOOR }];
    const seats = []; for (const s of [1, -1]) for (const [a, bb] of [[-A.LEN / 2 + 0.4, -1.1], [1.1, A.LEN / 2 - 0.5]]) for (let x = a + 0.26; x < bb; x += 0.515) seats.push({ x, y: A.FLOOR + 1.2, z: s * 0.95, yaw: s > 0 ? -Math.PI / 2 : Math.PI / 2 });
    return {
      ext: b.ext, glass: b.glass, tris: b.tris, length: A.LEN + (type === 'end' ? 0.8 : 0), width: 2 * A.W, height: A.ROOF, profile: b.P,
      sphere: new THREE.Sphere(new THREE.Vector3(0.3, 1.6, 0), 6.0),
      bones, boneIdx: { bogie: [BONE.bog[0], BONE.bog[1]], axlesOf: [[BONE.axle[0], BONE.axle[1]], [BONE.axle[2], BONE.axle[3]]] },
      leaves, wipers: [], plugOut: 0.0, slide: 0.78,
      meta: { bogieOffsets: [3.1, -3.1], doors, floorRegions: [{ name: 'car', x0: -A.LEN / 2 + 0.3, x1: A.LEN / 2 - 0.3, z0: -1.1, z1: 1.1, y: A.FLOOR }], ramps: [], gangways: { front: null, rear: null }, seats, cabEye: null },
      imap: { rows: [[-A.LEN / 2 + 0.4, -1.1, 0, 3], [-A.LEN / 2 + 0.4, -1.1, 0, -3], [1.1, A.LEN / 2 - 0.5, 0, 3], [1.1, A.LEN / 2 - 0.5, 0, -3]], band: [0.55, 0.65, 0, 0],
        win: [[-A.LEN / 2 + 0.35, -0.95, A.BAND0 + 0.05, A.BAND1 - 0.08], [0.95, A.LEN / 2 - 0.35, A.BAND0 + 0.05, A.BAND1 - 0.08]], doors: [[0, 0.8, 2.3, 0]], doorWin: [0.05, 0.72, 1.2, 2.2],
        poles: [[-0.95, -0.5, 0.018, 2.85], [-0.95, 0.5, 0.018, 2.85], [0.95, -0.5, 0.018, 2.85], [0.95, 0.5, 0.018, 2.85]], rail: [2.3, 0.7, 0.016, 0], panels: [],
        standAll: [[-0.4, 0.3], [0.5, -0.25], [-2.2, 0.1], [2.4, -0.1], [0.1, 0.55], [-3.1, -0.2], [3.2, 0.25], [1.6, 0.4]], cab: null },
      openings: [1, -1].map(s => ({ x: 0, hw: A.DOOR_W, y0: A.FLOOR, y1: 2.58, z: A.W - 0.06, side: s, bone: 0 })),
      lamp: [0.6, 2.845, 4.4], halfW: 1.2, floorY: A.FLOOR, ceilY: 2.85, cabBox: new THREE.Vector4(-A.LEN / 2, A.LEN / 2 + 0.2, 1, 0), signs: [],
      lamps: type === 'end' ? [1, -1].map(s => ({ p: [A.LEN / 2 + 0.25 + A.NOSE_R * 1.4 + 0.03, 0.72, s * 0.62], kind: 'head' })) : [],
    };
  };
  K.builders.apm.interior = (d, q) => interior(d, q);
  K.builders.apm.lod = (d, level) => lod(d, level);
  K.builders.apm.consist = (n) => { n = Math.max(2, n || 3); const out = []; for (let i = 0; i < n; i++) out.push({ type: i === 0 || i === n - 1 ? 'end' : 'mid', flip: i === n - 1, number: String(21 + i) }); return out; };
})();
