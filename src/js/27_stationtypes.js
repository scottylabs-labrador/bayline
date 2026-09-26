// StationTypes: the station generator. From a MetroStations plan (spine + tracks + platform faces in station
// coordinates u along, v right, y absolute) it builds a whole station as a time-sliced generator:
//   platforms (island or side: coping, tactile band, cantilevered edge over the refuge recess), trackways (plinths
//   and the depressed undercar trench), the structure by archetype (subway box / aerial deck on bents / at-grade on
//   fill / freeway median / open trench), canopies by era, vertical circulation to the concourse, fare gates,
//   entrances, furniture, signs and departure boards, and the lights (analytic line lights per zone).
// Everything is merged per zone into a few meshes; walk metadata (floors, walls) and Under cells come out alongside.
const StationTypes = (() => {
  const { K, GB, lin, LightSet, stationMat, glowMat, glassMat, interiorEnv } = StationKit;
  const SP = StationParts;
  const PH = StationKit.PLAT_H, EDGE = StationKit.EDGE;
  const REC = 0.9, LIP = 0.3;                    // under-platform refuge recess depth, cantilever lip thickness
  const COP = 0.30, TAC = 0.91;                  // coping band, tactile band outer edge (from the platform edge)

  // ------------------------------------------------------------------------------------------------ styles (palettes)
  // each entry: [colour, pattern kind, parameter]
  const STYLE = {
    // 1970s subway (Market St, Oakland, Berkeley, Mission): terrazzo-ish floors, tiled track walls, dark ceilings
    sub70: { floor: [0x9b958b, K.TERRAZZO, 3.0], coping: [0xc8c4bb, K.COPING], tactile: [0xd0a320, K.TACTILE], edgeFace: [0x6d6a64, K.CONCRETE],
      wallLow: [0x5c5a57, K.CONCRETE, 0], wall: [0xc9b89a, K.TILE, 0.108], wallUp: [0x8a8277, K.CONCRETE, 0], ceil: [0x3a3936, K.COFFER, 1.5], trackbed: [0x5a5854, K.CONCRETE, 0],
      col: [0xb2aa9b, K.CONCRETE, 0], light: [1.0, 0.9, 0.76], lightI: 1.5, amb: [0.2, 0.19, 0.17], ceilH: 4.6, accent: 0x7a3b2a },
    // 1970s aerial / at grade: exposed precast concrete, brushed concrete platforms, painted steel
    air70: { floor: [0xa9a397, K.CONCRETE, 3.0], coping: [0xc8c4bb, K.COPING], tactile: [0xd0a320, K.TACTILE], edgeFace: [0x8e8a82, K.CONCRETE],
      deck: [0xb5afa3, K.CONCRETE, 0], canopy: [0xd8d6d0, K.CONCRETE, 0], canopyUnder: [0xc3c0b8, K.PANEL, 1.2], steel: [0x3f464d, K.PAINT], col: [0xb9b3a7, K.FLUTED, 0.12],
      trackbed: [0x77736c, K.CONCRETE, 0], light: [1.0, 0.93, 0.8], lightI: 0.55, amb: [0.03, 0.03, 0.03], accent: 0x7a3b2a },
    // 1990s-2000s extensions: granite, glass, steel canopies
    mod: { floor: [0x8f8c87, K.GRANITE, 0.6], coping: [0xd2cfc8, K.COPING], tactile: [0xd6a818, K.TACTILE], edgeFace: [0x76736e, K.CONCRETE],
      wallLow: [0x6a6863, K.CONCRETE, 0], wall: [0xb9b6ae, K.PANEL, 1.2], wallUp: [0x9d9a93, K.CONCRETE, 0], ceil: [0xcfcdc7, K.PANEL, 0.6], deck: [0xbcb7ad, K.CONCRETE, 0],
      canopy: [0xd9dcdf, K.CORRUG, 0.25], canopyUnder: [0xe3e5e7, K.PANEL, 0.3], steel: [0x5e6f7c, K.PAINT], col: [0x6f7d88, K.PAINT, 0], trackbed: [0x6c6964, K.CONCRETE, 0],
      light: [0.95, 0.96, 1.0], lightI: 1.4, amb: [0.2, 0.2, 0.21], ceilH: 4.8, accent: 0x1aa3b8 },
    // 2010s-2020s: white steel, glass, LED
    new: { floor: [0xa3a19c, K.GRANITE, 0.9], coping: [0xdcd9d2, K.COPING], tactile: [0xd8ab14, K.TACTILE], edgeFace: [0x7b7874, K.CONCRETE],
      wallLow: [0x6f6d68, K.CONCRETE, 0], wall: [0xe6e5e1, K.PANEL, 1.5], wallUp: [0xd4d2cd, K.CONCRETE, 0], ceil: [0xeeeeea, K.PANEL, 0.3], deck: [0xc4c0b6, K.CONCRETE, 0],
      canopy: [0xe9ebec, K.CORRUG, 0.2], canopyUnder: [0xf0f0ee, K.WOOD, 0.1], steel: [0xe8e9ea, K.PAINT], col: [0xe8e9ea, K.PAINT, 0], trackbed: [0x6f6c67, K.CONCRETE, 0],
      light: [0.96, 0.98, 1.0], lightI: 1.6, amb: [0.22, 0.22, 0.23], ceilH: 5.0, accent: 0x1aa3b8 },
  };
  const ERA = { EMBR: '1970s', MONT: '1970s', POWL: '1970s', CIVC: '1970s', '16TH': '1970s', '24TH': '1970s', GLEN: '1970s', BALB: '1970s', DALY: '1970s',
    COLM: '1990s', SSAN: '2000s', SBRN: '2000s', SFIA: '2000s', MLBR: '2000s', WOAK: '1970s', '12TH': '1970s', '19TH': '1970s', MCAR: '1970s', ASHB: '1970s', DBRK: '1970s',
    NBRK: '1970s', PLZA: '1970s', DELN: '1970s', RICH: '1970s', ROCK: '1970s', ORIN: '1970s', LAFY: '1970s', WCRK: '1970s', PHIL: '1970s', CONC: '1970s', NCON: '1990s',
    PITT: '1990s', PCTR: '2010s', ANTC: '2010s', LAKE: '1970s', FTVL: '1970s', COLS: '1970s', SANL: '1970s', BAYF: '1970s', HAYW: '1970s', SHAY: '1970s', UCTY: '1970s',
    FRMT: '1970s', WARM: '2010s', MLPT: '2020s', BERY: '2020s', CAST: '1990s', WDUB: '2010s', DUBL: '1990s', OAKL: '2010s' };
  function styleFor(st) {
    const era = ERA[st.id] || '1970s'; const under = st.type === 'subway';
    if (era === '1970s') return under ? STYLE.sub70 : STYLE.air70;
    if (era === '1990s' || era === '2000s') return STYLE.mod;
    return STYLE.new;
  }

  // ------------------------------------------------------------------------------------------------ zones
  // a zone = one lighting environment (a Under cell for subway levels): buckets for structure (always drawn while
  // the station is loaded) and detail (near only), and its light set
  class Zone {
    constructor(name, opts = {}) {
      this.name = name; this.under = !!opts.under; this.sky = opts.under ? 0 : 1;
      this.m = { sk: new GB(), glass: new GB(), glow: new GB() };
      this.d = { sk: new GB(), glass: new GB(), glow: new GB() };
      for (const b of [this.m, this.d]) { b.metal = b.sk; b.dark = b.sk; b.sk.sky = this.sky; b.glass.sky = this.sky; }
      this.lights = new LightSet([], opts.amb || [0, 0, 0]);
      this.signs = []; this.boards = [];
    }
  }

  // ------------------------------------------------------------------------------------------------ build
  function* build(st, C) {
    const plan = st.plan, OX = plan.cx, OZ = plan.cz;
    const S = styleFor(st);
    const type = st.type || 'surface';
    const under = type === 'subway';
    const root = new THREE.Group(); root.name = 'metro-' + st.id; root.position.set(OX, 0, OZ);
    const near = new THREE.Group(); near.name = 'near'; root.add(near);
    const walk = { floors: [], walls: [] };
    // local spine frames
    const FR = plan.spine.map(s => ({ u: s.u, x: s.x - OX, z: s.z - OZ, tx: s.tx, tz: s.tz }));
    const DU = C.DU, U0 = plan.spine[0].u;
    const frameAt = (u) => { const f = U.clamp((u - U0) / DU, 0, FR.length - 1.0001); const i = Math.floor(f), k = f - i; const a = FR[i], b = FR[i + 1];
      let tx = a.tx + (b.tx - a.tx) * k, tz = a.tz + (b.tz - a.tz) * k; const l = Math.hypot(tx, tz) || 1; return { u, x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, tx: tx / l, tz: tz / l }; };
    const frames = (ua, ub, step = DU) => { const out = [frameAt(ua)]; for (const f of FR) if (f.u > ua + 0.05 && f.u < ub - 0.05) out.push(f); out.push(frameAt(ub)); void step; return out; };
    const L2 = (u, v) => { const f = frameAt(u); return [f.x - f.tz * v, f.z + f.tx * v]; };        // local (x, z) of (u, v)
    const yawAt = (u) => { const f = frameAt(u); return Math.atan2(-f.tz, f.tx); };               // local +X along +u, +Z to +v
    const place = (g, u, v, y, yawAdd = 0) => { const [x, z] = L2(u, v); g.push(); g.at(x, y, z, yawAt(u) + yawAdd); return g; };
    const tv = (t, u) => C.trackV(plan, t, u);
    const W2 = (x, z) => [x + OX, z + OZ];                                                        // local -> world xz
    yield;

    // ---------------------------------------------------------------- platform faces -> platforms
    const faces = plan.plats.map(p => ({ p, e: (u) => tv(p.t, u) + p.sideV * EDGE }));
    const plats = []; const used = new Set();
    for (let i = 0; i < faces.length; i++) {
      if (used.has(i)) continue; const A = faces[i];
      let pair = -1;
      for (let j = 0; j < faces.length; j++) {
        if (j === i || used.has(j)) continue; const B = faces[j];
        if (A.p.sideV === B.p.sideV || A.p.t === B.p.t) continue;
        const um = (Math.max(A.p.u0, B.p.u0) + Math.min(A.p.u1, B.p.u1)) / 2;
        const ea = A.e(um), eb = B.e(um); const gap = (eb - ea) * A.p.sideV;       // A extends toward +sideV
        if (gap > 2.5 && gap < 26 && Math.abs(A.p.yRail - B.p.yRail) < 2.5) { pair = j; break; }
      }
      if (pair >= 0) {
        const B = faces[pair]; used.add(i); used.add(pair);
        const Lf = A.p.sideV > 0 ? A : B, Rf = A.p.sideV > 0 ? B : A;      // left face extends +v, right face extends -v
        const u0 = Math.min(A.p.u0, B.p.u0), u1 = Math.max(A.p.u1, B.p.u1);
        plats.push({ kind: 'island', u0, u1, eL: Lf.e, eR: Rf.e, y: (A.p.yRail + B.p.yRail) / 2 + PH, keys: [Lf.p.key, Rf.p.key], faces: [Lf, Rf], tracks: [Lf.p.t, Rf.p.t] });
      } else {
        used.add(i); const w = under ? 5.2 : 6.5;
        const e = A.e; const sv = A.p.sideV;
        plats.push({ kind: 'side', u0: A.p.u0, u1: A.p.u1, eL: sv > 0 ? e : (u) => e(u) - w, eR: sv > 0 ? (u) => e(u) + w : e, y: A.p.yRail + PH, keys: [A.p.key], faces: [A], sideV: sv, tracks: [A.p.t] });
      }
    }
    const yRail = plan.yRail, yT = plats.length ? plats[0].y : yRail + PH;
    const pu0 = Math.min(...plats.map(p => p.u0)), pu1 = Math.max(...plats.map(p => p.u1));
    const Lp = pu1 - pu0, uc = (pu0 + pu1) / 2;
    // station envelope across: outermost track centre +- clearance
    const allT = plan.tracks;
    const vMinAt = (u) => Math.min(...allT.map(t => tv(t, u)), ...plats.map(p => p.eL(u)));
    const vMaxAt = (u) => Math.max(...allT.map(t => tv(t, u)), ...plats.map(p => p.eR(u)));
    const tracksOut = (u, side) => side < 0 ? Math.min(...allT.map(t => tv(t, u))) : Math.max(...allT.map(t => tv(t, u)));
    const platOut = (u, side) => side < 0 ? Math.min(...plats.map(p => p.eL(u))) : Math.max(...plats.map(p => p.eR(u)));
    // the wall line (subway) / deck edge (aerial): past the outer track by 2.3 m, or past a side platform's back
    const edgeV = (u, side) => side < 0 ? Math.min(tracksOut(u, -1) - 2.3, platOut(u, -1) - (plats.some(p => p.kind === 'side' && p.sideV > 0 && Math.abs(p.eL(u) - platOut(u, -1)) < 0.1) ? 0 : 0))
      : Math.max(tracksOut(u, 1) + 2.3, platOut(u, 1));
    const boxU0 = pu0 - (under ? 14 : 8), boxU1 = pu1 + (under ? 14 : 8);

    // zones
    const zP = new Zone('plat', { under, amb: under ? S.amb : [0, 0, 0] });
    const zones = [zP];
    const gm = zP.m.sk, gd = zP.d.sk;
    yield;

    // ---------------------------------------------------------------- platforms (sweeps with per-face materials)
    const M = (spec, extra) => Object.assign({ col: lin(spec[0]), kind: spec[1], prm: spec[2] || 0 }, extra || {});
    const covered = (u) => under ? 0 : (u > pu0 + 8 && u < pu1 - 8 ? 0.45 : 1);     // sky under the canopy (aerial/surface)
    for (const p of plats) {
      const yP = p.y, yLip = yP - LIP, yTB = yP - PH - 0.6;
      const fr = frames(p.u0, p.u1);
      const mEdge = M(S.edgeFace), mCop = M(S.coping), mTac = M(S.tactile), mFloor = M(S.floor), mRec = M(S.trackbed);
      gm.sweep(fr, (i, f) => {
        const a = p.eL(f.u), b = p.eR(f.u); const sky = covered(f.u); const skyO = under ? 0 : Math.min(1, sky + 0.3);
        const P = [];
        const leftEdge = p.kind === 'island' || p.sideV < 0, rightEdge = p.kind === 'island' || p.sideV > 0;
        if (leftEdge) { P.push([a + REC, yTB, yTB, Object.assign({}, mRec, { sky: skyO * 0.5 })], [a + REC, yLip, yLip, Object.assign({}, mRec, { sky: skyO * 0.3 })], [a, yLip, yLip, Object.assign({}, mEdge, { sky: skyO })], [a, yP, null, Object.assign({}, mCop, { sky })], [a + COP, yP, null, Object.assign({}, mTac, { sky })], [a + TAC, yP, null, Object.assign({}, mFloor, { sky })]); }
        else P.push([a, yP - 1.2, null, Object.assign({}, mEdge, { sky })], [a, yP, null, Object.assign({}, mFloor, { sky })]);
        if (rightEdge) P.push([b - TAC, yP, null, Object.assign({}, mTac, { sky })], [b - COP, yP, null, Object.assign({}, mCop, { sky })], [b, yP, yP, Object.assign({}, mEdge, { sky: skyO })], [b, yLip, yLip, Object.assign({}, mRec, { sky: skyO * 0.3 })], [b - REC, yLip, yLip, Object.assign({}, mRec, { sky: skyO * 0.5 })], [b - REC, yTB, yTB]);
        else P.push([b, yP, null, Object.assign({}, mEdge, { sky })], [b, yP - 1.2]);
        return P;
      });
      // tactile surface coordinate: the dome grid anchors to v; fine. End caps of the platform (vertical faces)
      for (const [ue, dir] of [[p.u0, -1], [p.u1, 1]]) {
        const f = frameAt(ue); const a = p.eL(ue), b = p.eR(ue);
        const g = gm; g.mat(S.edgeFace[0], K.CONCRETE, 0);
        const pa = [f.x - f.tz * a, f.z + f.tx * a], pb = [f.x - f.tz * b, f.z + f.tx * b];
        const yb = yP - PH - 0.6;
        if (dir > 0) g.quad([pa[0], yb, pa[1]], [pb[0], yb, pb[1]], [pb[0], yP, pb[1]], [pa[0], yP, pa[1]], [a, yb, b, yb, b, yP, a, yP]);
        else g.quad([pb[0], yb, pb[1]], [pa[0], yb, pa[1]], [pa[0], yP, pa[1]], [pb[0], yP, pb[1]], [b, yb, a, yb, a, yP, b, yP]);
      }
      // walk: floor strips + edge walls (you cannot step off the edge in walk mode)
      for (let i = 0; i + 1 < fr.length; i++) {
        const f0 = fr[i], f1 = fr[i + 1]; const a0 = p.eL(f0.u), b0 = p.eR(f0.u), a1 = p.eL(f1.u), b1 = p.eR(f1.u);
        const q = [[f0.x - f0.tz * a0, f0.z + f0.tx * a0], [f1.x - f1.tz * a1, f1.z + f1.tx * a1], [f1.x - f1.tz * b1, f1.z + f1.tx * b1], [f0.x - f0.tz * b0, f0.z + f0.tx * b0]];
        addFloor(walk, q.map(([x, z]) => W2(x, z)), yP);
        for (const [e0, e1] of [[q[0], q[1]], [q[3], q[2]]]) addWall(walk, W2(...e0), W2(...e1), yP - 2, yP + 3);
      }
      for (const ue of [p.u0, p.u1]) { const f = frameAt(ue); const a = p.eL(ue), b = p.eR(ue); addWall(walk, W2(f.x - f.tz * a, f.z + f.tx * a), W2(f.x - f.tz * b, f.z + f.tx * b), yP - 2, yP + 3); }
      yield;
    }

    // ---------------------------------------------------------------- trackways
    for (const t of allT) {
      const fr = frames(boxU0, boxU1); const yR = (u) => yRail;       // (one rail height per station: see plan.spread)
      const mTB = M(S.trackbed), mPl = M([0x8f8b84, K.CONCRETE, 0]), mTr = M([0x4a4845, K.CONCRETE, 0]);
      gm.sweep(fr, (i, f) => {
        const v = tv(t, f.u), y = yR(f.u); const yTB = y - 0.6, yPl = y - 0.2, yTr = y - 0.95; const sky = under ? 0 : 0.9;
        return [[v - 2.05, yTB, null, Object.assign({}, mTB, { sky })], [v - 1.12, yTB, null, Object.assign({}, mPl, { sky })], [v - 1.12, yPl, null, Object.assign({}, mPl, { sky })], [v - 0.62, yPl, null, Object.assign({}, mPl, { sky: sky * 0.6 })],
          [v - 0.62, yTr, null, Object.assign({}, mTr, { sky: sky * 0.4 })], [v + 0.62, yTr, null, Object.assign({}, mPl, { sky: sky * 0.6 })], [v + 0.62, yPl, null, Object.assign({}, mPl, { sky })], [v + 1.12, yPl, null, Object.assign({}, mPl, { sky })],
          [v + 1.12, yTB, null, Object.assign({}, mTB, { sky })], [v + 2.05, yTB]];
      });
      // walk: the trackbed (you can end up there; it is a floor, not a void)
      const f0 = frameAt(boxU0), f1 = frameAt(boxU1); void f0; void f1;
      yield;
    }

    // ---------------------------------------------------------------- structure by archetype
    const struct = { zones, S, plan, st, plats, yT, yRail, pu0, pu1, uc, Lp, boxU0, boxU1, edgeV, tracksOut, platOut, frames, frameAt, L2, yawAt, place, tv, W2, walk, M, OX, OZ, under, near, root, C };
    if (under) yield* subwayBox(struct);
    else if (type === 'aerial') yield* aerialDeck(struct);
    else yield* atGrade(struct, type);
    yield;
    // ---------------------------------------------------------------- platform furniture, signs, boards
    yield* furnish(struct);

    // ---------------------------------------------------------------- finalise: meshes per zone
    const env = under ? interiorEnv(C.renderer) : null;
    const res = { root, near, walk, cells: [], portals: [], cuts: [], boards: [], limits: [boxU0, boxU1], update: null };
    const shared = sharedMats();
    const atlas = MetroSigns.stationAtlas(st);
    const signMat = new THREE.MeshStandardMaterial({ map: atlas.tex, emissiveMap: atlas.tex, emissive: 0xffffff, emissiveIntensity: under ? 0.9 : 0.25, roughness: 0.35, metalness: 0.0 });
    const matsToTick = [];
    for (const z of zones) {
      const mat = stationMat({ env, envK: under ? 0.9 : 1.0, rough: 0.8 }); mat.userData.sk.uLightK.value = 1; matsToTick.push({ mat, z });
      const mk = (g, m, parent, shadow) => { const geo = g.build(); if (!geo) return null; const mesh = new THREE.Mesh(geo, m); mesh.castShadow = shadow && !z.under; mesh.receiveShadow = true; parent.add(mesh); if (m === mat) z.lights.bind(mesh, root); return mesh; };
      mk(z.m.sk, mat, root, true); mk(z.d.sk, mat, near, true);
      const gl1 = mk(z.m.glass, shared.glass, root, false), gl2 = mk(z.d.glass, shared.glass, near, false); for (const g of [gl1, gl2]) if (g) g.renderOrder = 2;
      mk(z.m.glow, shared.glow, root, false); mk(z.d.glow, shared.glow, near, false);
      if (z.signs.length) { const geo = signGeometry(z.signs, atlas.rect); const m = new THREE.Mesh(geo, signMat); m.receiveShadow = true; near.add(m); }
      for (const b of z.boards) { const bd = MetroSigns.newBoard(st, b.key); const m = new THREE.Mesh(b.geo, new THREE.MeshBasicMaterial({ map: bd.tex, toneMapped: false })); m.material.color.setScalar(1.6); near.add(m); res.boards.push(bd); }
      yield;
    }
    if (struct.esc && struct.esc.length) { const m = SP.escSteps(struct.esc); if (m) { near.add(m); zP.lights.bind(m, root); } }
    // Under cells (subway): the platform level box footprint
    if (under && struct.cellPoly) res.cells.push({ under: { id: `st:${st.id}:plat`, kind: 'station', poly: struct.cellPoly.map(([x, z]) => W2(x, z)), floor: yRail - 1.2, ceil: struct.ceilY + 1, ambient: S.amb, group: root } });
    indexWalk(walk);
    // per-frame: light intensity follows the exposure underground (lit 24/7, the same at noon and midnight)
    res.update = (dt, camPos, night) => {
      const expo = (typeof Env !== 'undefined' && Env.state.exposure) || 1;
      const underK = (typeof Under !== 'undefined' && Under.fixesExposure) ? 1 : 1.0 / expo;
      for (const { mat, z } of matsToTick) mat.userData.sk.uLightK.value = z.under ? underK : (0.25 + 0.75 * night);
      signMat.emissiveIntensity = under ? 0.9 * underK : 0.18 + 0.7 * night;
      shared.glow.userData.k.value = under ? 5 * underK : 1.5 + 4 * night;
    };
    return res;
  }

  // ------------------------------------------------------------------------------------------------ subway box
  function* subwayBox(T) {
    const { zones, S, yT, yRail, boxU0, boxU1, frames, frameAt, edgeV, M, plats, pu0, pu1, walk, W2, tv, plan } = T;
    const z = zones[0], g = z.m.sk;
    const yTB = yRail - 0.6, ceilY = yT + (S.ceilH || 4.6), wallT = 0.5;
    T.ceilY = ceilY;
    const fr = frames(boxU0, boxU1);
    const mLow = M(S.wallLow), mWall = M(S.wall), mUp = M(S.wallUp), mCeil = M(S.ceil);
    // side walls: profile bottom -> top (left wall faces +v: traverse top -> bottom; right wall faces -v: bottom -> top)
    const wallProf = (v, side) => {
      const P = [[v, yTB, yTB, mLow], [v, yT + 0.2, yT + 0.2, mWall], [v, ceilY - 0.9, ceilY - 0.9, mUp], [v, ceilY, ceilY]];
      if (side < 0) { const R = P.slice().reverse(); return R.map((p, k) => [p[0], p[1], p[2], R[k + 1] ? R[k + 1][3] : undefined]); }
      return P;
    };
    g.sweep(fr, (i, f) => wallProf(edgeV(f.u, -1), -1));
    g.sweep(fr, (i, f) => wallProf(edgeV(f.u, 1), 1));
    // ceiling: left -> right traversal gives an upward normal; we need it facing down -> flip
    g.sweep(fr, (i, f) => [[edgeV(f.u, -1), ceilY, null, mCeil], [edgeV(f.u, 1), ceilY]], true);
    // slab over the box (outside, for the view down an entrance and to close the box)
    g.sweep(fr, (i, f) => [[edgeV(f.u, -1) - wallT, ceilY + 0.8, null, M([0x77746e, K.CONCRETE])], [edgeV(f.u, 1) + wallT, ceilY + 0.8]]);
    // end walls with tunnel openings around each track (the tunnels themselves are INFRA's)
    for (const [ue, dir] of [[boxU0, -1], [boxU1, 1]]) {
      const f = frameAt(ue); const vl = edgeV(ue, -1), vr = edgeV(ue, 1);
      const holes = plan.tracks.map(t => { const v = tv(t, ue); return [v - 2.2, v + 2.2]; }).sort((a, b) => a[0] - b[0]);
      const P = (v, y) => [f.x - f.tz * v, y, f.z + f.tx * v];
      g.mat(S.wallUp[0], K.CONCRETE, 0);
      const band = (va, vb, ya, yb) => { if (vb - va < 0.01 || yb - ya < 0.01) return; const q = [P(va, ya), P(vb, ya), P(vb, yb), P(va, yb)];
        if (dir > 0) g.quad(q[1], q[0], q[3], q[2], [vb, ya, va, ya, va, yb, vb, yb]); else g.quad(q[0], q[1], q[2], q[3], [va, ya, vb, ya, vb, yb, va, yb]); };
      let v = vl; for (const [a, b] of holes) { band(v, a, yTB, ceilY); band(a, b, yRail + 4.3, ceilY); v = b; } band(v, vr, yTB, ceilY);
      // tunnel mouth frame: dark reveal inside each opening
      g.mat(0x2a2927, K.CONCRETE, 0);
      for (const [a, b] of holes) { const d = -dir * 0.0; void d; const q = [P(a, yRail + 4.3), P(b, yRail + 4.3)]; void q; }
      addWall(walk, W2(...P(vl, 0).filter((_, k) => k !== 1)), W2(...P(vr, 0).filter((_, k) => k !== 1)), yTB, ceilY);
    }
    // walls for walk mode along both sides
    for (let i = 0; i + 1 < fr.length; i++) for (const side of [-1, 1]) {
      const f0 = fr[i], f1 = fr[i + 1]; const v0 = edgeV(f0.u, side), v1 = edgeV(f1.u, side);
      addWall(walk, W2(f0.x - f0.tz * v0, f0.z + f0.tx * v0), W2(f1.x - f1.tz * v1, f1.z + f1.tx * v1), yTB, ceilY);
    }
    // cell footprint (station-local)
    const poly = []; for (const f of fr) { const v = edgeV(f.u, -1) - wallT; poly.push([f.x - f.tz * v, f.z + f.tx * v]); }
    for (let i = fr.length - 1; i >= 0; i--) { const f = fr[i]; const v = edgeV(f.u, 1) + wallT; poly.push([f.x - f.tz * v, f.z + f.tx * v]); }
    T.cellPoly = poly;
    // lights: continuous troughs over each platform edge + wall wash coves along both track walls
    const LC = S.light, I = S.lightI;
    for (const p of plats) {
      const um0 = p.u0 + 3, um1 = p.u1 - 3; const f0 = frameAt(um0), f1 = frameAt(um1);
      const vs = p.kind === 'island' ? [p.eL((um0 + um1) / 2) + 1.4, p.eR((um0 + um1) / 2) - 1.4] : [(p.eL(uc(T)) + p.eR(uc(T))) / 2];
      for (const v of vs) {
        z.lights.add({ a: [f0.x - f0.tz * v, ceilY - 0.2, f0.z + f0.tx * v], b: [f1.x - f1.tz * v, ceilY - 0.2, f1.z + f1.tx * v], color: [LC[0] * I, LC[1] * I, LC[2] * I], range: 26, radius: 0.12, dir: [0, -1, 0], focus: 1 });
        // the fixture itself: a long lit trough (segmented along the spine)
        const fr2 = frames(um0, um1);
        z.m.glow.mat(LC.map(c => c * 0.95)); z.m.glow.sweep(fr2, (i, f) => [[v - 0.14, ceilY - 0.12], [v + 0.14, ceilY - 0.12]], true);
        z.m.sk.sweep(fr2, (i, f) => [[v - 0.2, ceilY, null, M([0x3b3a37, K.PAINT])], [v - 0.2, ceilY - 0.14, null, M([0x3b3a37, K.PAINT])], [v - 0.14, ceilY - 0.12], [v + 0.14, ceilY - 0.12, null, M([0x3b3a37, K.PAINT])], [v + 0.2, ceilY - 0.14, null, M([0x3b3a37, K.PAINT])], [v + 0.2, ceilY]]);
      }
    }
    for (const side of [-1, 1]) {
      const f0 = frameAt(pu0), f1 = frameAt(pu1); const v = edgeV(T.uc, side) - side * 0.35;
      z.lights.add({ a: [f0.x - f0.tz * v, ceilY - 1.1, f0.z + f0.tx * v], b: [f1.x - f1.tz * v, ceilY - 1.1, f1.z + f1.tx * v], color: LC.map(c => c * I * 0.55), range: 18, radius: 0.1, dir: [-side * 0.3, 0.2, 0], focus: 0 });
    }
    yield;
  }
  const uc = (T) => T.uc;

  // ------------------------------------------------------------------------------------------------ aerial deck
  function* aerialDeck(T) {
    const { zones, S, yT, yRail, boxU0, boxU1, frames, frameAt, edgeV, M, plats, pu0, pu1, walk, W2 } = T;
    const z = zones[0], g = z.m.sk;
    const deckTop = yRail - 0.6, deckBot = deckTop - 1.9;
    const fr = frames(boxU0, boxU1);
    const mDeck = M(S.deck), mFascia = M([0xc9c4b9, K.CONCRETE, 0]);
    // deck: top (trackbed level, outside the tracks) is covered by the trackway sweeps; here: fascia + soffit + parapet
    g.sweep(fr, (i, f) => {
      const vl = edgeV(f.u, -1), vr = edgeV(f.u, 1);
      return [[vl + 0.1, deckTop + 1.05, null, Object.assign({}, mFascia, { sky: 1 })], [vl - 0.25, deckTop + 1.05, null, Object.assign({}, mFascia, { sky: 1 })], [vl - 0.25, deckBot + 0.3, null, Object.assign({}, mFascia, { sky: 0.8 })],
        [vl + 1.2, deckBot, null, Object.assign({}, mDeck, { sky: 0.45 })], [vr - 1.2, deckBot, null, Object.assign({}, mFascia, { sky: 0.8 })], [vr + 0.25, deckBot + 0.3, null, Object.assign({}, mFascia, { sky: 1 })], [vr + 0.25, deckTop + 1.05, null, Object.assign({}, mFascia, { sky: 1 })], [vr - 0.1, deckTop + 1.05]];
    }, true);
    // parapet inner faces
    for (const side of [-1, 1]) g.sweep(fr, (i, f) => { const v = side < 0 ? edgeV(f.u, -1) + 0.1 : edgeV(f.u, 1) - 0.1; return side < 0 ? [[v, deckTop + 1.05, null, M(S.deck, { sky: 1 })], [v, deckTop]] : [[v, deckTop, null, M(S.deck, { sky: 1 })], [v, deckTop + 1.05]]; });
    // bents every ~24 m: two tapered columns and a cap beam under the deck, down to the ground
    const ground = (u, v) => { const f = frameAt(u); const [x, zz] = [f.x - f.tz * v, f.z + f.tx * v]; return Terrain.h(x + T.OX, zz + T.OZ); };
    for (let u = boxU0 + 6; u <= boxU1 - 6; u += 24) {
      const vl = edgeV(u, -1), vr = edgeV(u, 1); const vc = (vl + vr) / 2, half = (vr - vl) / 2;
      for (const v of [vc - half * 0.55, vc + half * 0.55]) {
        const gy = ground(u, v) - 0.5; const h = deckBot - 1.2 - gy; if (h < 0.5) continue;
        T.place(g, u, v, gy); g.mat(S.col[0], S.col[1], S.col[2]); g.cyl(0, 0, 0, 0.7, 0.62, h, 20, false); g.pop();
      }
      T.place(g, u, vc, deckBot - 1.25); g.mat(S.deck[0], K.CONCRETE, 0); g.box(-0.9, 0, -half * 0.8, 0.9, 1.25, half * 0.8); g.pop();
    }
    // canopy over the platform(s)
    for (const p of plats) yield* canopy(T, p, deckTop);
    // windscreens / railings on side platforms' backs
    for (const p of plats) if (p.kind === 'side') {
      const fr2 = frames(p.u0, p.u1); const back = (u) => p.sideV > 0 ? p.eR(u) : p.eL(u);
      z.d.sk.mat(S.steel[0], K.PAINT);
      for (let i = 0; i < fr2.length; i += 3) { const f = fr2[i]; const v = back(f.u); T.place(z.d.sk, f.u, v, p.y); z.d.sk.cbox(0, 0, 0, 0.08, 2.4, 0.08); z.d.sk.pop(); }
      z.d.glass.sweep(fr2, (i, f) => [[back(f.u), p.y + 0.1], [back(f.u), p.y + 2.3]]);
      z.d.glass.sweep(fr2, (i, f) => [[back(f.u), p.y + 0.1], [back(f.u), p.y + 2.3]], true);
    }
    yield;
  }
  // a canopy along a platform: style by era. 1970s: a precast concrete folded-plate/"gull-wing" roof on central
  // columns; modern: a steel butterfly roof with standing-seam cladding and a timber-look soffit.
  function* canopy(T, p, deckTop) {
    const { zones, S, frames, M } = T; const z = zones[0], g = z.m.sk;
    const u0 = p.u0 + 6, u1 = p.u1 - 6; const fr = frames(u0, u1);
    const yP = p.y; const island = p.kind === 'island';
    const c = (u) => (p.eL(u) + p.eR(u)) / 2, half = (u) => (p.eR(u) - p.eL(u)) / 2;
    const era = ERA[T.st.id] || '1970s';
    const h0 = yP + 3.6;
    if (era === '1970s') {
      // gull-wing: low at the centre spine, rising to the edges, thick fascia; underside panels
      const mTop = M(S.canopy, { sky: 1 }), mUnd = M(S.canopyUnder, { sky: 0.35 }), mFas = M([0xbfbab0, K.CONCRETE], { sky: 0.9 });
      g.sweep(fr, (i, f) => { const cc = c(f.u), w = half(f.u) + (island ? 1.1 : 0.8);
        return [[cc - w, h0 + 0.85, null, mFas], [cc - w, h0 + 1.25, null, mTop], [cc, h0 + 0.35, null, mTop], [cc + w, h0 + 1.25, null, mFas], [cc + w, h0 + 0.85, null, mUnd], [cc, h0 - 0.05, null, mUnd], [cc - w, h0 + 0.85]]; }, true);
      // central columns every 9 m (or along the back of a side platform)
      for (let u = u0 + 3; u <= u1; u += 9) { const v = island ? c(u) : (p.sideV > 0 ? p.eR(u) - 0.6 : p.eL(u) + 0.6); T.place(g, u, v, yP); g.mat(S.col[0], S.col[1], S.col[2]); g.cbox(0, 0, 0, 0.55, h0 - yP + 0.2, 0.35); g.pop(); }
    } else {
      // butterfly: two planes sloping to a central gutter, steel beams on round columns
      const mTop = M(S.canopy, { sky: 1 }), mUnd = M(S.canopyUnder, { sky: 0.4 }), mFas = M(S.steel, { sky: 0.9 });
      g.sweep(fr, (i, f) => { const cc = c(f.u), w = half(f.u) + 1.3;
        return [[cc - w, h0 + 1.0, null, mFas], [cc - w, h0 + 1.15, null, mTop], [cc, h0 + 0.55, null, mTop], [cc + w, h0 + 1.15, null, mFas], [cc + w, h0 + 1.0, null, mUnd], [cc, h0 + 0.4, null, mUnd], [cc - w, h0 + 1.0]]; }, true);
      for (let u = u0 + 4; u <= u1; u += 12) { const v = island ? c(u) : (p.sideV > 0 ? p.eR(u) - 0.5 : p.eL(u) + 0.5); T.place(g, u, v, yP); g.mat(S.col[0], K.PAINT, 0); g.cyl(0, 0, 0, 0.16, 0.16, h0 - yP + 0.45, 14, false); g.pop(); }
    }
    // light strips under the canopy (both sides of the spine) + their line lights
    const LC = S.light, I = S.lightI;
    for (const off of island ? [-1, 1] : [0]) {
      const v = (u) => c(u) + off * half(u) * 0.55; const f0 = T.frameAt(u0 + 2), f1 = T.frameAt(u1 - 2);
      const y = era === '1970s' ? h0 + 0.1 + Math.abs(off) * half((u0 + u1) / 2) * 0.55 * (0.9 / (half((u0 + u1) / 2) + 1.1)) : h0 + 0.42 + 0.35 * Math.abs(off) * 0.55;
      z.m.glow.mat(LC); z.m.glow.sweep(frames(u0 + 2, u1 - 2), (i, f) => [[v(f.u) - 0.09, y - 0.03], [v(f.u) + 0.09, y - 0.03]], true);
      z.lights.add({ a: [f0.x - f0.tz * v(u0 + 2), y - 0.05, f0.z + f0.tx * v(u0 + 2)], b: [f1.x - f1.tz * v(u1 - 2), y - 0.05, f1.z + f1.tx * v(u1 - 2)], color: LC.map(k => k * I), range: 22, radius: 0.08, dir: [0, -1, 0], focus: 1 });
    }
    yield;
  }

  // ------------------------------------------------------------------------------------------------ at grade / median / trench
  function* atGrade(T, type) {
    const { zones, S, yRail, boxU0, boxU1, frames, frameAt, edgeV, M, plats } = T;
    const z = zones[0], g = z.m.sk;
    const fr = frames(boxU0, boxU1);
    const yTB = yRail - 0.6;
    // ballast shoulders beyond the trackbed out to the station edges, fading into the ground
    const mBal = M([0x8a847a, K.BALLAST, 0], { sky: 1 });
    g.sweep(fr, (i, f) => { const vl = edgeV(f.u, -1), vr = edgeV(f.u, 1); return [[vl - 1.5, yTB - 0.7, null, mBal], [vl, yTB, null, mBal], [vl + 0.3, yTB]]; });
    g.sweep(fr, (i, f) => { const vl = edgeV(f.u, -1), vr = edgeV(f.u, 1); return [[vr - 0.3, yTB, null, mBal], [vr, yTB, null, mBal], [vr + 1.5, yTB - 0.7]]; });
    if (type === 'trench') {
      const mRW = M([0xa29d93, K.BOARDFORM, 0.15], { sky: 0.8 });
      for (const side of [-1, 1]) g.sweep(fr, (i, f) => { const v = edgeV(f.u, side) + side * 0.5; const top = Math.max(yTB + 2, Terrain.h(f.x - f.tz * v + T.OX, f.z + f.tx * v + T.OZ) + 1.1);
        return side < 0 ? [[v, top, top, mRW], [v, yTB, yTB]] : [[v, yTB, yTB, mRW], [v, top, top]]; });
    }
    if (type === 'median') {
      // concrete barriers (the freeway lanes are the world's) on both sides of the station envelope
      const mBar = M([0xb9b4a9, K.CONCRETE, 0], { sky: 1 });
      for (const side of [-1, 1]) g.sweep(fr, (i, f) => { const v = edgeV(f.u, side) + side * 1.2; return side < 0 ? [[v + 0.3, yTB + 1.07, null, mBar], [v - 0.3, yTB + 1.07, null, mBar], [v - 0.4, yTB]].reverse().map((p, k, R) => [p[0], p[1], null, R[k + 1] ? mBar : undefined]) : [[v - 0.4, yTB, null, mBar], [v - 0.3, yTB + 1.07, null, mBar], [v + 0.3, yTB + 1.07]]; });
    }
    for (const p of plats) yield* canopy(T, p, yTB);
    yield;
  }

  // ------------------------------------------------------------------------------------------------ furniture, signs, boards
  function* furnish(T) {
    const { zones, S, plats, place, frameAt, under } = T;
    const z = zones[0], gd = z.d.sk, B = z.d;
    for (const p of plats) {
      const island = p.kind === 'island';
      const cv = (u) => (p.eL(u) + p.eR(u)) / 2;
      const backV = (u) => island ? cv(u) : (p.sideV > 0 ? p.eR(u) - 0.7 : p.eL(u) + 0.7);
      const faceYaw = island ? 0 : (p.sideV > 0 ? Math.PI : 0);      // bench seat faces -Z locally: toward the track
      const L = p.u1 - p.u0;
      // benches (back to back on islands) and bins
      for (let u = p.u0 + 18; u < p.u1 - 14; u += 32) {
        if (island) { place(gd, u, cv(u) - 0.3, p.y, 0); SP.bench(B, 2.4, under ? 'stone' : 'steel'); gd.pop(); place(gd, u, cv(u) + 0.3, p.y, Math.PI); SP.bench(B, 2.4, under ? 'stone' : 'steel'); gd.pop(); }
        else { place(gd, u, backV(u) + (p.sideV > 0 ? -0.3 : 0.3), p.y, faceYaw); SP.bench(B, 2.4, 'steel'); gd.pop(); }
        place(gd, u + 4.5, island ? cv(u) : backV(u), p.y, 0); SP.bins(B); gd.pop();
      }
      // hanging name signs (double-sided) every ~36 m, platform direction panels, maps
      for (let u = p.u0 + 10; u < p.u1 - 5; u += 36) {
        const f = frameAt(u); const v = island ? cv(u) : backV(u); const y = p.y + 3.05;
        z.signs.push({ u, v, y, yaw: T.yawAt(u), w: 3.2, h: 0.4, region: 'nameS', both: true, f, T });
        // hanger rods
        place(gd, u, v, y + 0.2, 0); gd.mat(0x2a2c2e, K.PAINT); gd.cbox(-1.3, 0, 0, 0.03, (under ? T.ceilY - y - 0.2 : 0.9), 0.03); gd.cbox(1.3, 0, 0, 0.03, (under ? T.ceilY - y - 0.2 : 0.9), 0.03); gd.pop();
      }
      // departure boards (hanging, facing each platform edge) every ~70 m
      let bi = 0;
      for (let u = p.u0 + 45; u < p.u1 - 20; u += 70) {
        const v = island ? cv(u) : backV(u); const y = p.y + 2.7;
        for (const [k, side] of (island ? [[0, -1], [1, 1]] : [[0, p.sideV > 0 ? -1 : 1]])) {
          const key = p.keys[Math.min(k, p.keys.length - 1)];
          z.boards.push({ key: key + (bi ? '' : ''), geo: boardGeo(T, u, v + side * 0.08, y, side), u, v });
        }
        place(gd, u, v, y + 0.4, 0); gd.mat(0x1c1d1f, K.PAINT); gd.cbox(0, -0.42, 0, 1.9, 0.62, 0.14); gd.cbox(-0.8, 0.2, 0, 0.04, 0.9, 0.04); gd.cbox(0.8, 0.2, 0, 0.04, 0.9, 0.04); gd.pop();
        bi++;
      }
      // platform number / direction panels near the middle (wall-less islands: on a totem)
      const um = (p.u0 + p.u1) / 2 - 8;
      p.keys.forEach((key, k) => { const side = island ? (k === 0 ? -1 : 1) : (p.sideV > 0 ? -1 : 1); const v = (island ? cv(um) : backV(um)) + side * 0.12;
        z.signs.push({ u: um, v, y: p.y + 2.25, yaw: T.yawAt(um) + (side > 0 ? Math.PI : 0), w: 3.2, h: 0.4, region: 'p' + Math.min(4, Number(key) || (k + 1)), both: false, T });
      });
      place(gd, um, island ? cv(um) : backV(um), p.y, 0); gd.mat(0x1c1d1f, K.PAINT); gd.cbox(0, 0, 0, 3.3, 2.05, 0.2); gd.pop();
      // system map + info totems
      const u2 = um + 30; const v2 = island ? cv(u2) : backV(u2);
      place(gd, u2, v2, p.y, 0); gd.mat(0x1c1d1f, K.PAINT); gd.cbox(0, 0, 0, 2.5, 2.2, 0.16); gd.pop();
      z.signs.push({ u: u2, v: v2 - 0.09, y: p.y + 1.35, yaw: T.yawAt(u2), w: 2.4, h: 1.0, region: 'map', both: false, T });
      z.signs.push({ u: u2, v: v2 + 0.09, y: p.y + 1.35, yaw: T.yawAt(u2) + Math.PI, w: 2.4, h: 1.0, region: 'map', both: false, T });
      yield;
    }
    // big name panels on the track walls (subway): every 25 m on both walls, facing the platform
    if (under) for (const side of [-1, 1]) for (let u = T.pu0 + 12; u < T.pu1 - 8; u += 25) {
      const v = T.edgeV(u, side) - side * 0.03;
      z.signs.push({ u, v, y: T.yT + 1.9, yaw: T.yawAt(u) + (side < 0 ? Math.PI : 0), w: 6.4, h: 1.2, region: 'name', both: false, T });
    }
  }
  // board geometry: a panel in station-local coords facing -side (toward the platform edge at that side)
  function boardGeo(T, u, v, y, side) {
    const [x, z] = T.L2(u, v); const yaw = T.yawAt(u) + (side < 0 ? Math.PI : 0);
    const g = new THREE.PlaneGeometry(1.8, 0.45); g.rotateY(Math.PI / 2 + Math.PI); g.rotateY(yaw - Math.PI / 2); g.translate(x, y, z);
    return g;
  }
  // signs -> one geometry with UVs into the station atlas
  function signGeometry(list, rect) {
    const pos = [], nor = [], uv = [], idx = []; let n = 0;
    for (const s of list) {
      const [x, z] = s.T.L2(s.u, s.v); const r = rect[s.region] || rect.nameS;
      const faces = s.both ? [s.yaw, s.yaw + Math.PI] : [s.yaw];
      for (const yaw of faces) {
        // plane facing local +Z rotated by yaw (three's rotation.y convention); its normal: (sin yaw, 0, cos yaw)
        const c = Math.cos(yaw), sn = Math.sin(yaw); const ax = c, az = -sn;        // local +X axis
        const nx = sn, nz = c; const hw = s.w / 2, hh = s.h / 2; const off = s.both ? 0.02 : 0.004;
        const cx = x + nx * off, cz = z + nz * off;
        const P = [[cx - ax * hw, s.y - hh, cz - az * hw], [cx + ax * hw, s.y - hh, cz + az * hw], [cx + ax * hw, s.y + hh, cz + az * hw], [cx - ax * hw, s.y + hh, cz - az * hw]];
        const UVs = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
        for (let k = 0; k < 4; k++) { pos.push(...P[k]); nor.push(nx, 0, nz); uv.push(...UVs[k]); }
        idx.push(n, n + 1, n + 2, n, n + 2, n + 3); n += 4;
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    g.computeBoundingSphere(); return g;
  }
  let SHARED = null;
  function sharedMats() {
    if (SHARED) return SHARED;
    SHARED = { glass: glassMat(), glow: glowMat(5) };
    for (const m of Object.values(SHARED)) m.userData.shared = true;
    return SHARED;
  }

  // ------------------------------------------------------------------------------------------------ walk metadata
  function addFloor(W, q, y, y2) {   // q: 4 world [x, z] corners; y (flat) or a plane through 3 corners with heights
    const poly = []; let bx0 = 1e18, bx1 = -1e18, bz0 = 1e18, bz1 = -1e18;
    for (const [x, z] of q) { poly.push(x, z); bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
    W.floors.push({ poly, a: y, gx: 0, gz: 0, x0: q[0][0], z0: q[0][1], bx0, bx1, bz0, bz1 });
  }
  // sloped floor: corners with heights [[x, z, y], ...] (a plane through the first three)
  function addSlope(W, q) {
    const [p0, p1, p2] = q; const ax = p1[0] - p0[0], az = p1[1] - p0[1], ay = p1[2] - p0[2], bx = p2[0] - p0[0], bz = p2[1] - p0[1], by = p2[2] - p0[2];
    const det = ax * bz - az * bx; if (Math.abs(det) < 1e-9) return;
    const gx = (ay * bz - az * by) / det, gz = (ax * by - ay * bx) / det;
    const poly = []; let bx0 = 1e18, bx1 = -1e18, bz0 = 1e18, bz1 = -1e18;
    for (const [x, z] of q) { poly.push(x, z); bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
    W.floors.push({ poly, a: p0[2], gx, gz, x0: p0[0], z0: p0[1], bx0, bx1, bz0, bz1 });
  }
  function addWall(W, a, b, y0, y1) { W.walls.push({ x0: a[0], z0: a[1], x1: b[0], z1: b[1], y0, y1 }); }
  function indexWalk(W) { W.nFloors = W.floors.length; W.nWalls = W.walls.length; }

  return { build, STYLE, ERA, styleFor, Zone, addFloor, addSlope, addWall };
})();
