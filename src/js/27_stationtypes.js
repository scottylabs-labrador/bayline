// StationTypes: the station generator. From a MetroStations plan (spine + tracks + platform faces in station
// coordinates u along, v right, y absolute) it builds a whole station as a time-sliced generator:
//   platforms (island or side: coping, tactile band, cantilevered edge over the refuge recess), trackways (plinths
//   and the depressed undercar trench), the structure by archetype (subway box / aerial deck on bents / at grade /
//   freeway median / open trench), canopies by era, vertical circulation (escalator + stair groups, elevators) to a
//   concourse above (subway), below (aerial, embankment) or over a footbridge (at grade, median, trench), fare gate
//   arrays, the agent booth, ticket machines, street entrances (subway: stair shafts cut into the sidewalk), furniture,
//   signs, departure boards, and the lights (analytic line lights per zone).
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
    // 1970s subway (Market St, Oakland, Berkeley, Mission): terrazzo floors, tiled track walls, dark coffered ceilings
    sub70: { floor: [0x9b958b, K.TERRAZZO, 3.0], coping: [0xc8c4bb, K.COPING], tactile: [0xd0a320, K.TACTILE], edgeFace: [0x6d6a64, K.CONCRETE],
      wallLow: [0x77736c, K.CONCRETE, 0], wall: [0xc9b89a, K.TILE, 0.108], wallUp: [0x9a9286, K.CONCRETE, 0], ceil: [0x6b6760, K.COFFER, 1.5], trackbed: [0x5a5854, K.CONCRETE, 0],
      cFloor: [0x9d978c, K.TERRAZZO, 3.0], cWall: [0xd2c6ad, K.TILE, 0.108], cCeil: [0xa39d92, K.COFFER, 1.2], col: [0xb2aa9b, K.CONCRETE, 0],
      light: [1.0, 0.9, 0.76], lightI: 1.5, amb: [0.42, 0.39, 0.35], ceilH: 4.6, accent: 0x7a3b2a },
    // 1970s aerial / at grade: exposed precast concrete, brushed concrete platforms, painted steel
    air70: { floor: [0xa9a397, K.CONCRETE, 3.0], coping: [0xc8c4bb, K.COPING], tactile: [0xd0a320, K.TACTILE], edgeFace: [0x8e8a82, K.CONCRETE],
      deck: [0xb5afa3, K.CONCRETE, 0], canopy: [0xd8d6d0, K.CONCRETE, 0], canopyUnder: [0xc3c0b8, K.PANEL, 1.2], steel: [0x3f464d, K.PAINT], col: [0xb9b3a7, K.FLUTED, 0.12],
      cFloor: [0x8f8a80, K.CONCRETE, 2.0], cWall: [0xa59f94, K.BOARDFORM, 0.14], cCeil: [0xc9c5bd, K.PANEL, 1.2],
      trackbed: [0x77736c, K.CONCRETE, 0], light: [1.0, 0.93, 0.8], lightI: 0.55, amb: [0.03, 0.03, 0.03], accent: 0x7a3b2a },
    // 1990s-2000s extensions: granite, glass, steel canopies
    mod: { floor: [0x8f8c87, K.GRANITE, 0.6], coping: [0xd2cfc8, K.COPING], tactile: [0xd6a818, K.TACTILE], edgeFace: [0x76736e, K.CONCRETE],
      wallLow: [0x7a7873, K.CONCRETE, 0], wall: [0xb9b6ae, K.PANEL, 1.2], wallUp: [0x9d9a93, K.CONCRETE, 0], ceil: [0xcfcdc7, K.PANEL, 0.6], deck: [0xbcb7ad, K.CONCRETE, 0],
      cFloor: [0x8c8984, K.GRANITE, 0.6], cWall: [0xc3c0b8, K.PANEL, 1.2], cCeil: [0xd6d4ce, K.PANEL, 0.6],
      canopy: [0xd9dcdf, K.CORRUG, 0.25], canopyUnder: [0xe3e5e7, K.PANEL, 0.3], steel: [0x5e6f7c, K.PAINT], col: [0x6f7d88, K.PAINT, 0], trackbed: [0x6c6964, K.CONCRETE, 0],
      light: [0.95, 0.96, 1.0], lightI: 1.4, amb: [0.38, 0.38, 0.39], ceilH: 4.8, accent: 0x1aa3b8 },
    // 2010s-2020s: white steel, glass, LED
    new: { floor: [0xa3a19c, K.GRANITE, 0.9], coping: [0xdcd9d2, K.COPING], tactile: [0xd8ab14, K.TACTILE], edgeFace: [0x7b7874, K.CONCRETE],
      wallLow: [0x7f7d78, K.CONCRETE, 0], wall: [0xe6e5e1, K.PANEL, 1.5], wallUp: [0xd4d2cd, K.CONCRETE, 0], ceil: [0xeeeeea, K.PANEL, 0.3], deck: [0xc4c0b6, K.CONCRETE, 0],
      cFloor: [0x9e9c97, K.GRANITE, 0.9], cWall: [0xe8e7e3, K.PANEL, 1.5], cCeil: [0xf0f0ec, K.PANEL, 0.3],
      canopy: [0xe9ebec, K.CORRUG, 0.2], canopyUnder: [0xf0f0ee, K.WOOD, 0.1], steel: [0xe8e9ea, K.PAINT], col: [0xe8e9ea, K.PAINT, 0], trackbed: [0x6f6c67, K.CONCRETE, 0],
      light: [0.96, 0.98, 1.0], lightI: 1.6, amb: [0.4, 0.4, 0.41], ceilH: 5.0, accent: 0x1aa3b8 },
  };
  const ERA = { EMBR: '1970s', MONT: '1970s', POWL: '1970s', CIVC: '1970s', '16TH': '1970s', '24TH': '1970s', GLEN: '1970s', BALB: '1970s', DALY: '1970s',
    COLM: '1990s', SSAN: '2000s', SBRN: '2000s', SFIA: '2000s', MLBR: '2000s', WOAK: '1970s', '12TH': '1970s', '19TH': '1970s', MCAR: '1970s', ASHB: '1970s', DBRK: '1970s',
    NBRK: '1970s', PLZA: '1970s', DELN: '1970s', RICH: '1970s', ROCK: '1970s', ORIN: '1970s', LAFY: '1970s', WCRK: '1970s', PHIL: '1970s', CONC: '1970s', NCON: '1990s',
    PITT: '1990s', PCTR: '2010s', ANTC: '2010s', LAKE: '1970s', FTVL: '1970s', COLS: '1970s', SANL: '1970s', BAYF: '1970s', HAYW: '1970s', SHAY: '1970s', UCTY: '1970s',
    FRMT: '1970s', WARM: '2010s', MLPT: '2020s', BERY: '2020s', CAST: '1990s', WDUB: '2010s', DUBL: '1990s', OAKL: '2010s', 'COLS~OAC': '2010s' };
  function styleFor(st) {
    const era = ERA[st.id] || '1970s'; const under = st.type === 'subway';
    let S;
    if (era === '1970s') S = under ? STYLE.sub70 : STYLE.air70;
    else if (era === '1990s' || era === '2000s') S = STYLE.mod; else S = STYLE.new;
    const H = (typeof StationHeroes !== 'undefined' && StationHeroes.style) ? StationHeroes.style(st.id, S) : null;
    return H || S;
  }

  // ------------------------------------------------------------------------------------------------ zones
  // a zone = one lighting environment (a Under cell for subway levels): buckets for structure (always drawn while
  // the station is loaded) and detail (near only), and its light set
  class Zone {
    constructor(name, opts = {}) {
      this.name = name; this.under = !!opts.under; this.sky = opts.under ? 0 : 1;
      this.m = { sk: new GB(), glass: new GB(), glow: new GB() };
      this.d = { sk: new GB(), glass: new GB(), glow: new GB() };
      for (const b of [this.m, this.d]) { b.metal = b.sk; b.dark = b.sk; for (const g of [b.sk, b.glass, b.glow]) g.sky = this.sky; }
      this.lights = new LightSet([], opts.amb || [0, 0, 0]);
      this.signs = []; this.boards = [];
    }
  }

  // ------------------------------------------------------------------------------------------------ setup
  // Everything decided before any geometry: the station frame, the platforms (faces paired into islands or sides),
  // the structure lines (deck edge / wall line), the circulation plan (concourse mode, escalator groups, openings) and
  // what stands on the ground (lobby / concourse extents, bents, footbridge). build() and footprint() both start here,
  // so the keep-out zones handed to the world are exactly what gets built. Returns null for a station without platforms.
  function setup(st, C) {
    const plan = st.plan, OX = plan.cx, OZ = plan.cz;
    const S = styleFor(st);
    const H = (typeof StationHeroes !== 'undefined' ? StationHeroes.config(st.id) : null) || {};
    const type = H.type || st.type || 'surface';
    const under = type === 'subway';
    // local spine frames
    const FR = plan.spine.map(s => ({ u: s.u, x: s.x - OX, z: s.z - OZ, tx: s.tx, tz: s.tz }));
    const DU = C.DU, U0 = plan.spine[0].u;
    const frameAt = (u) => { const f = U.clamp((u - U0) / DU, 0, FR.length - 1.0001); const i = Math.floor(f), k = f - i; const a = FR[i], b = FR[i + 1];
      let tx = a.tx + (b.tx - a.tx) * k, tz = a.tz + (b.tz - a.tz) * k; const l = Math.hypot(tx, tz) || 1;
      const ex = (u - U0) < 0 ? (u - U0) : (u - U0) > (FR.length - 1) * DU ? (u - U0) - (FR.length - 1) * DU : 0;   // past the spine: extrapolate
      return { u, x: a.x + (b.x - a.x) * k + tx / l * ex, z: a.z + (b.z - a.z) * k + tz / l * ex, tx: tx / l, tz: tz / l }; };
    // frames between ua and ub, including exact rows at every cut position in `cuts`
    const frames = (ua, ub, cuts = []) => { const us = new Set([ua, ub]); for (const f of FR) if (f.u > ua + 0.05 && f.u < ub - 0.05) us.add(f.u); for (const c of cuts) if (c > ua + 0.01 && c < ub - 0.01) us.add(c);
      return [...us].sort((a, b) => a - b).map(frameAt); };
    const L2 = (u, v) => { const f = frameAt(u); return [f.x - f.tz * v, f.z + f.tx * v]; };        // local (x, z) of (u, v)
    const yawAt = (u) => { const f = frameAt(u); return Math.atan2(-f.tz, f.tx); };               // local +X along +u, +Z to +v
    const place = (g, u, v, y, yawAdd = 0) => { const [x, z] = L2(u, v); g.push(); g.at(x, y, z, yawAt(u) + yawAdd); return g; };
    // the same transform on every bucket of a set (parts that emit glass and glow as well as surfaces)
    const placeB = (B, u, v, y, yawAdd = 0) => { const [x, z] = L2(u, v); for (const g of new Set([B.sk, B.glass, B.glow])) { g.push(); g.at(x, y, z, yawAt(u) + yawAdd); } return B; };
    const popB = (B) => { for (const g of new Set([B.sk, B.glass, B.glow])) g.pop(); };
    const tv = (t, u) => C.trackV(plan, t, u);
    const W2 = (x, z) => [x + OX, z + OZ];                                                        // local -> world xz
    const WUV = (u, v) => W2(...L2(u, v));

    // ---------------------------------------------------------------- platform faces -> platforms
    // platform faces; a face whose range is short or far from the first face's (v0 data maps some GTFS stops onto the
    // wrong stretch of a track) takes the first face's range: both sides of a station are the same 213 m
    // (the least believable length is the vehicle's: 150 m for BART, 110 m for the Antioch DMU, 30 m for the people mover)
    const ref0 = plan.plats[0]; const minL = ref0.minL || 150;
    const refC = (ref0.u0 + ref0.u1) / 2, refL = plan.isOac ? Math.max(30, ref0.u1 - ref0.u0) : Math.min(216, Math.max(minL, ref0.u1 - ref0.u0));
    if (!plan.isOac) for (const p of plan.plats) { const c = (p.u0 + p.u1) / 2, l = p.u1 - p.u0; if (l < minL || Math.abs(c - refC) > 40) { p.u0 = refC - refL / 2; p.u1 = refC + refL / 2; } }
    // a known layout (research) corrects the sides the v0 data inferred: side platforms extend away from the other
    // track, island faces toward it
    if ((H.layout === 'side' || H.layout === 'island') && plan.plats.length >= 2 && new Set(plan.plats.map(q => q.t)).size === 2) {
      const um = (ref0.u0 + ref0.u1) / 2;
      for (const p of plan.plats) {
        const other = plan.plats.filter(q => q.t !== p.t); if (!other.length) continue;
        const dv = tv(other[0].t, um) - tv(p.t, um); if (Math.abs(dv) < 0.5) continue;
        p.sideV = (H.layout === 'side' ? -1 : 1) * Math.sign(dv);
      }
    }
    const faces = plan.plats.map(p => ({ p, e: (u) => tv(p.t, u) + p.sideV * (p.edge || EDGE) }));
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
        // one island, one length: both faces' ranges should agree; where the data disagree, trust the longer face
        // (a platform is ~213 m) centred where the two agree best
        const la = A.p.u1 - A.p.u0, lb = B.p.u1 - B.p.u0, ca = (A.p.u0 + A.p.u1) / 2, cb = (B.p.u0 + B.p.u1) / 2;
        const Lr = Math.min(216, Math.max(la, lb)); const cc = Math.abs(ca - cb) < 20 ? (ca + cb) / 2 : (la >= lb ? ca : cb);
        const u0 = cc - Lr / 2, u1 = cc + Lr / 2;
        // one walking surface: each face's rail + its vehicle's floor (a transfer island between BART and the DMU needs
        // the DMU's track raised by the difference, as at Pittsburg/Bay Point)
        const yA = A.p.yRail + (A.p.ph || PH), yB = B.p.yRail + (B.p.ph || PH);
        plats.push({ kind: 'island', u0, u1, eL: Lf.e, eR: Rf.e, y: (yA + yB) / 2, ph: ((A.p.ph || PH) + (B.p.ph || PH)) / 2, keys: [Lf.p.key, Rf.p.key], faces: [Lf, Rf], tracks: [Lf.p.t, Rf.p.t], holes: [] });
      } else {
        used.add(i); const w = under ? 5.2 : 6.5;
        const e = A.e; const sv = A.p.sideV;
        plats.push({ kind: 'side', u0: A.p.u0, u1: A.p.u1, eL: sv > 0 ? e : (u) => e(u) - w, eR: sv > 0 ? (u) => e(u) + w : e, y: A.p.yRail + (A.p.ph || PH), ph: A.p.ph || PH, keys: [A.p.key], faces: [A], sideV: sv, tracks: [A.p.t], holes: [] });
      }
    }
    if (!plats.length) return null;
    // levels (stacked stations, 12th and 19th St): platforms grouped by height, the top level first; each level has its
    // own box, cell and zone; a lower level's side platform reaches under the platforms above (room for the escalators)
    plats.sort((a, b) => b.y - a.y);
    const levels = [];
    for (const p of plats) { let L = levels.find(q => Math.abs(q.yT - p.y) < 2.5); if (!L) levels.push(L = { k: levels.length, yT: p.y, plats: [], tracks: [] });
      L.plats.push(p); for (const t of p.tracks) if (!L.tracks.includes(t)) L.tracks.push(t); p.level = L; }
    for (const L of levels.slice(1)) for (const p of L.plats) if (p.kind === 'side') {
      const up = levels[L.k - 1];
      if (p.sideV > 0) { const e = p.eL; const far = (u) => Math.max(...up.plats.map(q => q.eR(u))); p.eR = (u) => U.clamp(far(u), e(u) + 5.2, e(u) + 14); }
      else { const e = p.eR; const far = (u) => Math.min(...up.plats.map(q => q.eL(u))); p.eL = (u) => U.clamp(far(u), e(u) - 14, e(u) - 5.2); }
    }
    const yRail = plan.yRail, yT = plats[0].y;
    const pu0 = Math.min(...plats.map(p => p.u0)), pu1 = Math.max(...plats.map(p => p.u1));
    const Lp = pu1 - pu0, uc = (pu0 + pu1) / 2;
    const allT = plan.tracks;
    const tracksOut = (u, side) => side < 0 ? Math.min(...allT.map(t => tv(t, u))) : Math.max(...allT.map(t => tv(t, u)));
    const platOut = (u, side) => side < 0 ? Math.min(...plats.map(p => p.eL(u))) : Math.max(...plats.map(p => p.eR(u)));
    // the wall line (subway) / deck edge (aerial): past the outer track by 2.3 m, or past a side platform's back
    const edgeV = (u, side) => side < 0 ? Math.min(tracksOut(u, -1) - 2.3, platOut(u, -1)) : Math.max(tracksOut(u, 1) + 2.3, platOut(u, 1));
    const boxU0 = pu0 - (under ? 14 : 8), boxU1 = pu1 + (under ? 14 : 8);
    let street = (st.data.levels && isFinite(st.data.levels.street)) ? st.data.levels.street : (under ? yT + 12 : yT - 9);
    // (the ground at the station's centre, taken once: the lobby floor is set from it and the ground is then graded to
    // the floor, so a later reading must not move the floor)
    const groundC = st.groundC0 !== undefined ? st.groundC0 : (st.groundC0 = Terrain.h(OX, OZ));
    // the ground beside the station (median of samples 12 m past its edges): a trench's street is the ground along its
    // rim when the data's street level sits lower (M2: e.g. North Concord)
    const side = []; for (const du of [-40, 0, 40]) for (const sd of [-1, 1]) { const [x, z] = WUV(uc + du, edgeV(uc + du, sd) + sd * 12); side.push(Terrain.h(x, z)); }
    side.sort((a, b) => a - b); const groundSide = (side[2] + side[3]) / 2;
    if (type === 'trench' && groundSide > street) street = groundSide;

    const M = (spec, extra) => Object.assign({ col: lin(spec[0]), kind: spec[1], prm: spec[2] || 0 }, extra || {});
    // each track's own rail height along the station (the level boxes and trackbeds follow the data, never one mean)
    const trackY = (t, u) => { const Sp = plan.spine; const f = U.clamp((u - Sp[0].u) / DU, 0, Sp.length - 1.0001); const i = Math.floor(f), k = f - i; return t.y[i] + (t.y[i + 1] - t.y[i]) * k; };
    for (const L of levels) {
      L.yRail = L.tracks.reduce((a, t) => a + trackY(t, uc), 0) / Math.max(1, L.tracks.length);
      L.edgeV = (u, sd) => { const tv0 = L.tracks.map(t => tv(t, u)); const pv = sd < 0 ? Math.min(...L.plats.map(p => p.eL(u))) : Math.max(...L.plats.map(p => p.eR(u)));
        return sd < 0 ? Math.min(Math.min(...tv0) - 2.3, pv) : Math.max(Math.max(...tv0) + 2.3, pv); };
      L.ceilHoles = []; L.name = L.k === 0 ? 'plat' : 'plat' + (L.k + 1);
    }
    for (const L of levels.slice(1)) L.ceilY = levels[L.k - 1].yRail - 0.6 - 0.9;     // under the level above's trackbed slab
    const T = { H, S, plan, st, type, plats, levels, trackY, yT, yRail, pu0, pu1, uc, Lp, boxU0, boxU1, edgeV, tracksOut, platOut, frames, frameAt, L2, yawAt, place, placeB, popB, tv, W2, WUV, M, OX, OZ,
      allT, under, C, street, groundC, groundSide, esc: [], cells: [], portals: [], cuts: [], occupied: [], ceilY: yT + (S.ceilH || 4.6) };
    // streets under the station (the build hands them over from Towns): lobbies and bents keep clear of them
    T.roads = st.roads ? roadsUV(T, st.roads) : [];
    // ---------------------------------------------------------------- circulation plan (before any slab is built)
    planCirculation(T);
    groundPlan(T);
    return T;
  }
  // world roads ({ pts: [x, y, z, ...], width, lanes, bridge }) -> segments in station coordinates near the spine,
  // { u0, v0, u1, v1, hw } (hw: half the carriageway)
  function roadsUV(T, roads) {
    const out = [];
    for (const rd of roads) {
      if (rd.bridge) continue;
      const P = rd.pts, n = P.length / 3; const hw = (rd.width || Math.max(1, rd.lanes || 2) * 3.4) / 2;
      let prev = null;
      for (let i = 0; i < n; i++) {
        const uv = toUV(T, P[i * 3] - T.OX, P[i * 3 + 2] - T.OZ);
        if (prev && uv && (Math.abs(prev[1]) < 80 || Math.abs(uv[1]) < 80) && Math.max(prev[0], uv[0]) > T.boxU0 - 40 && Math.min(prev[0], uv[0]) < T.boxU1 + 40)
          out.push({ u0: prev[0], v0: prev[1], u1: uv[0], v1: uv[1], hw });
        prev = uv;
      }
    }
    return out;
  }
  // distance from (u, v) to a road segment's centreline
  function segDist(r, u, v) { const du = r.u1 - r.u0, dv = r.v1 - r.v0; const L2 = du * du + dv * dv || 1; const t = U.clamp(((u - r.u0) * du + (v - r.v0) * dv) / L2, 0, 1); return Math.hypot(r.u0 + du * t - u, r.v0 + dv * t - v); }
  const roadAt = (T, u, v, clear) => T.roads.some(r => segDist(r, u, v) < r.hw + clear);
  // does any carriageway (+ clear) reach into the rectangle [u0, u1] x [v0, v1]?
  function roadInRect(T, u0, u1, v0, v1, clear) {
    for (const r of T.roads) {
      const e = r.hw + clear; if (Math.max(r.u0, r.u1) < u0 - e || Math.min(r.u0, r.u1) > u1 + e || Math.max(r.v0, r.v1) < v0 - e || Math.min(r.v0, r.v1) > v1 + e) continue;
      const L = Math.hypot(r.u1 - r.u0, r.v1 - r.v0), m = Math.max(1, Math.ceil(L));
      for (let k = 0; k <= m; k++) { const t = k / m, u = r.u0 + (r.u1 - r.u0) * t, v = r.v0 + (r.v1 - r.v0) * t;
        const du = Math.max(u0 - u, 0, u - u1), dv = Math.max(v0 - v, 0, v - v1); if (du * du + dv * dv < e * e) return true; }
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------------ build
  function* build(st, C) {
    const root = new THREE.Group(); root.name = 'metro-' + st.id; root.position.set(st.plan.cx, 0, st.plan.cz);
    const near = new THREE.Group(); near.name = 'near'; root.add(near);
    const walk = { floors: [], walls: [] };
    const T = setup(st, C);
    if (!T) return { root, near, walk, cells: [], portals: [], cuts: [], boards: [] };
    // zones
    const zP = new Zone('plat', { under: T.under, amb: T.under ? T.S.amb : [0, 0, 0] });
    const zones = [zP];
    for (const L of T.levels) { L.zone = L.k === 0 ? zP : new Zone(L.name, { under: T.under, amb: T.under ? T.S.amb : [0, 0, 0] }); if (L.k) zones.push(L.zone); for (const p of L.plats) p.zone = L.zone; }
    const zoneOfTrack = (t) => (T.levels.find(L => L.tracks.includes(t)) || T.levels[0]).zone;
    Object.assign(T, { root, near, walk, zones, zP });
    const { H, S, type, under, plats, yT, yRail, pu0, pu1, uc, boxU0, boxU1, frames, frameAt, L2, yawAt, tv, W2, WUV, M, OX, OZ, allT, street } = T;
    yield;

    // ---------------------------------------------------------------- platforms (sweeps with per-face materials, openings)
    const covered = (u) => under ? 0 : (u > pu0 + 8 && u < pu1 - 8 ? 0.45 : 1);     // sky under the canopy (aerial/surface)
    for (const p of plats) {
      const yP = p.y, yLip = yP - LIP, yTB = yP - p.ph - 0.6;
      const cuts = []; for (const h of p.holes) cuts.push(h.u0, h.u1);
      const fr = frames(p.u0, p.u1, cuts);
      const mEdge = M(S.edgeFace), mCop = M(S.coping), mTac = M(S.tactile), mFloor = M(S.floor), mRec = M(S.trackbed);
      const holeAt = (u) => p.holes.filter(h => u > h.u0 + 1e-3 && u <= h.u1 + 1e-3);
      const hv = p.holes.map(h => h).sort((a, b) => a.v0 - b.v0);
      p.zone.m.sk.sweep(fr, (i, f) => {
        const a = p.eL(f.u), b = p.eR(f.u); const sky = covered(f.u); const skyO = under ? 0 : Math.min(1, sky + 0.3);
        const P = [];
        const leftEdge = p.kind === 'island' || p.sideV < 0, rightEdge = p.kind === 'island' || p.sideV > 0;
        const fl = Object.assign({}, mFloor, { sky });
        if (leftEdge) P.push([a + REC, yTB, yTB, Object.assign({}, mRec, { sky: skyO * 0.5 })], [a + REC, yLip, yLip, Object.assign({}, mRec, { sky: skyO * 0.3 })], [a, yLip, yLip, Object.assign({}, mEdge, { sky: skyO })], [a, yP, null, Object.assign({}, mCop, { sky })], [a + COP, yP, null, Object.assign({}, mTac, { sky })], [a + TAC, yP, null, fl]);
        else P.push([a, yP - 1.2, null, Object.assign({}, mEdge, { sky })], [a, yP, null, fl]);
        // openings: edge points of every hole on this platform (the faces between them are skipped inside the hole's u-range)
        const inside = holeAt(f.u);
        { const vs = []; for (const h of hv) vs.push(h.v0, h.v1); vs.sort((x, z) => x - z);
          const last = P[P.length - 1]; const lastV = last[0];
          // the segment ending at each hole edge takes 'skip' when an active hole covers it
          let prevV = lastV; for (const v of vs) { const m = (prevV + v) / 2; P[P.length - 1][3] = inside.some(h => m > h.v0 && m < h.v1) ? 'skip' : (P[P.length - 1][3] === 'skip' ? fl : P[P.length - 1][3]); P.push([v, yP, null, fl]); prevV = v; }
          // the segment after the last hole edge up to the next profile point is decided when that point is pushed below
          P[P.length - 1].holeTail = true; }
        const tailI = P.length - 1;
        if (rightEdge) P.push([b - TAC, yP, null, Object.assign({}, mTac, { sky })], [b - COP, yP, null, Object.assign({}, mCop, { sky })], [b, yP, yP, Object.assign({}, mEdge, { sky: skyO })], [b, yLip, yLip, Object.assign({}, mRec, { sky: skyO * 0.3 })], [b - REC, yLip, yLip, Object.assign({}, mRec, { sky: skyO * 0.5 })], [b - REC, yTB, yTB]);
        else P.push([b, yP, null, Object.assign({}, mEdge, { sky })], [b, yP - 1.2]);
        if (P[tailI].holeTail) { const m = (P[tailI][0] + P[tailI + 1][0]) / 2; P[tailI][3] = inside.some(h => m > h.v0 && m < h.v1) ? 'skip' : fl; }
        return P;
      });
      // platform end faces
      for (const [ue, dir] of [[p.u0, -1], [p.u1, 1]]) {
        const f = frameAt(ue); const a = p.eL(ue), b = p.eR(ue); const g = p.zone.m.sk; g.mat(S.edgeFace[0], K.CONCRETE, 0);
        const pa = [f.x - f.tz * a, f.z + f.tx * a], pb = [f.x - f.tz * b, f.z + f.tx * b]; const yb = yP - p.ph - 0.6;
        if (dir > 0) g.quad([pa[0], yb, pa[1]], [pb[0], yb, pb[1]], [pb[0], yP, pb[1]], [pa[0], yP, pa[1]], [a, yb, b, yb, b, yP, a, yP]);
        else g.quad([pb[0], yb, pb[1]], [pa[0], yb, pa[1]], [pa[0], yP, pa[1]], [pb[0], yP, pb[1]], [b, yb, a, yb, a, yP, b, yP]);
      }
      // walk: floor strips (minus the openings) + edge walls
      for (let i = 0; i + 1 < fr.length; i++) {
        const f0 = fr[i], f1 = fr[i + 1]; const um = (f0.u + f1.u) / 2; const inside = holeAt(f1.u);
        const spans = []; let v = -1e9; const a0 = p.eL(f0.u), b0 = p.eR(f0.u), a1 = p.eL(f1.u), b1 = p.eR(f1.u);
        const cutsV = inside.map(h => [h.v0, h.v1]).sort((x, y) => x[0] - y[0]);
        let lo = 0; void v; void um;
        const pieces = []; let start = null;
        // pieces across: [edge, hole0.v0], [hole0.v1, hole1.v0], ..., [holeN.v1, edge]
        let prevV = null;
        for (const [h0, h1] of cutsV) { pieces.push([prevV, h0]); prevV = h1; }
        pieces.push([prevV, null]); void lo; void start; void spans;
        for (const [pa, pb] of pieces) {
          const va0 = pa === null ? a0 : pa, va1 = pa === null ? a1 : pa, vb0 = pb === null ? b0 : pb, vb1 = pb === null ? b1 : pb;
          if (vb0 - va0 < 0.05) continue;
          addFloor(walk, [[f0.x - f0.tz * va0, f0.z + f0.tx * va0], [f1.x - f1.tz * va1, f1.z + f1.tx * va1], [f1.x - f1.tz * vb1, f1.z + f1.tx * vb1], [f0.x - f0.tz * vb0, f0.z + f0.tx * vb0]].map(([x, z]) => W2(x, z)), yP);
        }
        const q = [[f0.x - f0.tz * a0, f0.z + f0.tx * a0], [f1.x - f1.tz * a1, f1.z + f1.tx * a1], [f1.x - f1.tz * b1, f1.z + f1.tx * b1], [f0.x - f0.tz * b0, f0.z + f0.tx * b0]];
        for (const [e0, e1] of [[q[0], q[1]], [q[3], q[2]]]) addWall(walk, W2(...e0), W2(...e1), yP - 2, yP + 3);
      }
      for (const ue of [p.u0, p.u1]) { const f = frameAt(ue); const a = p.eL(ue), b = p.eR(ue); addWall(walk, W2(f.x - f.tz * a, f.z + f.tx * a), W2(f.x - f.tz * b, f.z + f.tx * b), yP - 2, yP + 3); }
      yield;
    }

    // ---------------------------------------------------------------- trackways
    for (const t of allT) {
      const fr = frames(boxU0, boxU1);
      const mTB = M(S.trackbed), mPl = M([0x8f8b84, K.CONCRETE, 0]), mTr = M([0x4a4845, K.CONCRETE, 0]);
      zoneOfTrack(t).m.sk.sweep(fr, (i, f) => {
        const v = tv(t, f.u), y = T.levels.length > 1 ? T.trackY(t, f.u) : yRail; const yTB = y - 0.6, yPl = y - 0.2, yTr = y - 0.95; const sky = under ? 0 : 0.9;
        return [[v - 2.05, yTB, null, Object.assign({}, mTB, { sky })], [v - 1.12, yTB, null, Object.assign({}, mPl, { sky })], [v - 1.12, yPl, null, Object.assign({}, mPl, { sky })], [v - 0.62, yPl, null, Object.assign({}, mPl, { sky: sky * 0.6 })],
          [v - 0.62, yTr, null, Object.assign({}, mTr, { sky: sky * 0.4 })], [v + 0.62, yTr, null, Object.assign({}, mPl, { sky: sky * 0.6 })], [v + 0.62, yPl, null, Object.assign({}, mPl, { sky })], [v + 1.12, yPl, null, Object.assign({}, mPl, { sky })],
          [v + 1.12, yTB, null, Object.assign({}, mTB, { sky })], [v + 2.05, yTB]];
      });
      yield;
    }

    // ---------------------------------------------------------------- structure by archetype
    if (under) yield* subwayBox(T);
    else if (T.elevated) yield* aerialDeck(T);
    else yield* atGrade(T, T.effType);
    // floor inlays: brick bands across the platform, quarry-tile grids
    yield* floorInlays(T);
    if (under && H.cols) yield* platformColumns(T);
    yield;
    // ---------------------------------------------------------------- circulation, concourse, entrances
    yield* buildCirculation(T);
    // ---------------------------------------------------------------- platform furniture, signs, boards
    yield* furnish(T);

    // ---------------------------------------------------------------- finalise: meshes per zone
    const env = under ? interiorEnv(C.renderer) : null;
    const res = { root, near, walk, cells: T.cells, portals: T.portals, cuts: T.cuts, boards: [], limits: [boxU0, boxU1], zones: {}, update: null, footprint: footprintT(T),
      info: { mode: T.mode, yT, yRail, yCF: T.yCF, yCC: T.yCC, ceilY: T.ceilY, rise: T.rise, street, cu0: T.cu0, cu1: T.cu1, gOff: T.gOff, elevated: T.elevated,
        landDbg: T.landDbg, landings: (T.landings || []).map(L => ({ foot: T.W2(...L.foot), top: T.W2(...L.top), dir: L.dir, rise: +L.rise.toFixed(2), gy: L.gy, segs: L.segs.length, name: L.name })), plats: plats.map(p => [p.kind, +p.u0.toFixed(1), +p.u1.toFixed(1), +(p.eR(uc) - p.eL(uc)).toFixed(2), (p.groups || []).map(g => [g.kinds.join('+'), +g.uFoot.toFixed(1), +g.uHead.toFixed(1), +g.vc.toFixed(1)])]),
        ceilHoles: (T.ceilHoles || []).map(h => [+h.u0.toFixed(1), +h.u1.toFixed(1), +h.v0.toFixed(1), +h.v1.toFixed(1)]), platHoles: plats.map(p => p.holes.map(h => [+h.u0.toFixed(1), +h.u1.toFixed(1), +h.v0.toFixed(1), +h.v1.toFixed(1)])) } };
    const shared = sharedMats();
    const atlas = MetroSigns.stationAtlas(st);
    const signMats = [];
    const matsToTick = [];
    for (const z of zones) {
      const mat = stationMat({ env: z.under ? env : null, envK: z.under ? 0.9 : 1.0, rough: 0.8 }); mat.userData.sk.uLightK.value = 1; matsToTick.push({ mat, z });
      // each zone: its group (a Under cell group for underground levels) holding its structure and, in a child group, its
      // near-only detail, so portal visibility and the near LOD act on the same subtree
      const grp = new THREE.Group(); grp.name = 'zone-' + z.name; root.add(grp); const grpN = new THREE.Group(); grpN.name = 'zone-' + z.name + '-near'; grp.add(grpN);
      res.zones[z.name] = { group: grp, near: grpN, under: z.under };
      const mk = (g, m, parent, shadow) => { const geo = g.build(); if (!geo) return null; const mesh = new THREE.Mesh(geo, m); mesh.castShadow = shadow && !z.under; mesh.receiveShadow = true; parent.add(mesh); if (m === mat) z.lights.bind(mesh, root); return mesh; };
      mk(z.m.sk, mat, grp, true); mk(z.d.sk, mat, grpN, true);
      const gl1 = mk(z.m.glass, shared.glass, grp, false), gl2 = mk(z.d.glass, shared.glass, grpN, false); for (const g of [gl1, gl2]) if (g) g.renderOrder = 2;
      mk(z.m.glow, shared.glow, grp, false); mk(z.d.glow, shared.glow, grpN, false);
      if (z.signs.length) { const sm = new THREE.MeshStandardMaterial({ map: atlas.tex, emissiveMap: atlas.tex, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.0 });
        signMats.push({ m: sm, z }); const geo = signGeometry(z.signs, atlas.rect); const m = new THREE.Mesh(geo, sm); m.receiveShadow = true; grpN.add(m); }
      for (const b of z.boards) { const bd = MetroSigns.newBoard(st, b.key); const m = new THREE.Mesh(b.geo, new THREE.MeshBasicMaterial({ map: bd.tex, toneMapped: false })); m.material.color.setScalar(1.6); grpN.add(m); res.boards.push(bd); b.mat = m.material; }
      yield;
    }
    if (T.esc.length) { const m = SP.escSteps(T.esc); if (m) { (T.levels.length > 1 ? near : res.zones.plat.near).add(m); zP.lights.bind(m, root); } }
    res.nears = Object.values(res.zones).map(z => z.near);
    res.entrances = (T.entrances || []).map(e => ({ wx: e.wx, wz: e.wz, name: e.name }));
    // (the street entrances share one zone: their cells get no group, or Under would hide every shaft whenever one of
    // them is out of sight; the shafts are cheap and stay drawn with the station)
    for (const c of T.cells) if (res.zones[c.zone] && c.zone !== 'ent') c.under.group = res.zones[c.zone].group;
    indexWalk(walk);
    // crowd zones (station-local via toLocal/toWorld): platforms with their faces and circulation, the concourse
    res.toWorld = (u, v) => WUV(u, v); res.toLocal = (u, v) => L2(u, v); res.yawAt = (u) => yawAt(u); res.origin = [OX, OZ];
    res.crowd = {
      plats: plats.map(p => ({ kind: p.kind, keys: p.keys, y: p.y, u0: p.u0, u1: p.u1, eL: p.eL, eR: p.eR, sideV: p.sideV, tracks: p.tracks.map(t => t.id),
        groups: (p.groups || []).map(g => ({ uFoot: g.uFoot, uHead: g.uHead, vc: g.vc, gw: g.gw, down: !!g.down })), busy: (u, v) => T.occupied.some(o => o.p === p && u > o.u0 - 0.6 && u < o.u1 + 0.6 && v > o.v0 - 0.6 && v < o.v1 + 0.6) })),
      conc: T.concZone || null,
    };
    // per-frame: light intensity follows the exposure underground (lit 24/7, the same at noon and midnight)
    const underOn = typeof Under !== 'undefined' && Under.enabled;
    // with Under: the cell ambient (bounce light) is Under's, for every material in the volume; mine would add it twice
    if (underOn) for (const { mat, z } of matsToTick) if (z.under) z.lights.amb = [0, 0, 0];
    res.update = (dt, camPos, night) => {
      const expo = (typeof Env !== 'undefined' && Env.state.exposure) || 1;
      const underK = underOn ? 1 : 1.0 / expo;           // Under fixes the exposure underground (1.0, day and night)
      for (const { mat, z } of matsToTick) mat.userData.sk.uLightK.value = z.under ? underK : (0.6 + 0.4 * night);
      for (const { m, z } of signMats) m.emissiveIntensity = z.under ? 0.9 * underK : 0.3 + 0.6 * night;
      shared.glow.userData.k.value = under ? 5 * underK : 2.5 + 3 * night;
      // without the Under module: hide the underground levels while the camera is up in the street, away from entrances
      if (under && !underOn && !MetroStations.debug.showAll) {
        const upTop = camPos.y > street - 0.8; let nearEnt = false; for (const e of T.entrances || []) if (Math.hypot(camPos.x - e.wx, camPos.z - e.wz) < 30) { nearEnt = true; break; }
        const vis = !upTop || nearEnt;
        for (const k in res.zones) if (res.zones[k].under) { res.zones[k].group.visible = vis; res.zones[k].near.visible = vis; }
      }
    };
    return res;
  }

  // ------------------------------------------------------------------------------------------------ circulation plan
  // Decides where the concourse is (above / below / bridge / none), its heights, and the escalator-stair groups on
  // each platform, and registers the openings they need in platform slabs (T.plats[].holes) and in the ceiling
  // (T.ceilHoles) before anything is built.
  function planCirculation(T) {
    const { plats, yT, under, type, street, S, groundC, Lp, uc } = T;
    let mode, H, yCF, yCC;
    const D = street - yT;
    const acc = T.H.access;
    // a lobby at ground level under the station needs the deck (rail - 2.5 m) over a hall: >= 6.2 m from the ground
    // under it to the platform top; lower (embankments, freeway medians at grade) the station is reached over a
    // footbridge, which is never below the street (trench stations: at street level)
    const hAbove = yT - groundC, lobbyFits = hAbove >= 6.2;
    const bridgeY = Math.max(yT + 6.2, D > 0 ? street + 0.2 : -1e9);
    T.hAbove = hAbove;
    if (!under && (acc === 'bridge' || (acc === 'below' && !lobbyFits))) { mode = 'bridge'; yCF = bridgeY; yCC = yCF + 3.2; }
    else if (acc === 'below' && !under) { mode = 'below'; yCF = Math.min(groundC + 0.15, yT - 4.5); yCC = Math.min(yT - plats[0].ph - 2.6, yCF + 4.2); }
    else if (under) {
      // the concourse roof stays under the lowest ground over it (streets slope; a roof poking through shows)
      const gMin = Math.min(street, minGround(T, T.pu0 + 12, T.pu1 - 12, (u) => T.edgeV(u, -1), (u) => T.edgeV(u, 1)) + 0.2);
      // deep (MetroNet M2 depths: Market St ~18-20 m, Mission/Lake Merritt ~13 m): the mezzanine sits just under the
      // street (a 1.3 m roof) and the long escalators climb to it from the platforms; the band between the platform
      // ceiling and the mezzanine floor is solid (Market Street's Muni level runs there), crossed by the escalator wells
      // (the depth that counts is under the lowest ground over the concourse: a street falling toward a portal)
      const Dg = gMin - yT;
      // the mezzanine (4 m) sits just under that ground, and never lower than 0.6 m over the platform ceiling
      if (Dg >= 8.2) { T.ceilY = yT + (Dg >= 12 ? (S.ceilH || 4.6) : 3.7); yCC = gMin - (Dg >= 12 ? 1.3 : 1.0); yCF = Math.max(T.ceilY + (Dg >= 12 ? 0.9 : 0.6), yCC - 4.0);
        yCC = Math.min(yCC, yCF + 4.5); mode = 'above'; }
      else { T.ceilY = Math.min(yT + (S.ceilH || 4.6), gMin - 0.8); mode = 'ends'; }
    } else if ((type === 'aerial' || (type !== 'median' && hAbove > 4.2)) && lobbyFits) { mode = 'below'; yCF = Math.min(groundC + 0.15, yT - 4.5); yCC = Math.min(yT - plats[0].ph - 2.6, yCF + 4.2); }
    else { mode = 'bridge'; yCF = bridgeY; yCC = yCF + 3.2; }
    T.mode = mode; T.yCF = yCF; T.yCC = yCC; H = mode === 'above' || mode === 'bridge' ? yCF - yT : mode === 'below' ? yT - yCF : 0; T.rise = H;
    T.ceilHoles = [];
    // one bank of escalators and stairs at uc + gOff (the station's config); a lobby under an aerial deck moves along
    // the station until neither it nor its entrance apron stands on a street that runs under the deck
    T.gOff = T.H.groupOff || 0;
    if (mode === 'below' && T.roads && T.roads.length && H >= 1.5) {
      const run = Math.max(SP.escRun(H), stairRun(H)) + 0.6;
      const vl = Math.min(T.edgeV(uc, -1), T.edgeV(T.pu0, -1), T.edgeV(T.pu1, -1)) - 1.6, vr = Math.max(T.edgeV(uc, 1), T.edgeV(T.pu0, 1), T.edgeV(T.pu1, 1)) + 1.6;
      const clearOf = (off) => { const ug = uc + off; const a = ug - 18, b = Math.max(ug + 18, ug + run / 2 + 10);
        if (ug - run / 2 < T.pu0 + 6 || ug + run / 2 > T.pu1 - 6) return false;
        return !roadInRect(T, a - 8, b, vl, vr, 1.0); };
      const best = [0, 8, -8, 16, -16, 24, -24, 32, -32, 40, -40, 50, -50, 60, -60].map(d => T.gOff + d).find(clearOf);
      if (best !== undefined) T.gOff = best;
    }
    // a footbridge mezzanine sits where its main walkway leaves square to the line: over the station's main entrance
    // (GTFS first, else the nearest usable one)
    if (mode === 'bridge' && T.H.groupOff === undefined && H >= 1.5) {
      const run = Math.max(SP.escRun(H), stairRun(H)) + 0.6; let best = null;
      for (const e of dedupeEntrances(T.st.data.entrances || [])) {
        const uv = toUV(T, e.x - T.OX, e.z - T.OZ); if (!uv) continue; const [ue, ve] = uv; const side = ve < 0 ? -1 : 1;
        const out = side * (ve - T.edgeV(ue, side)); if (out < 6 || out > 140 || Math.abs(ue - uc) > 150) continue;
        const score = (e.src === 'gtfs' ? 0 : 1000) + Math.abs(ue - uc); if (!best || score < best.score) best = { ue, score };
      }
      if (best) T.gOff = U.clamp(best.ue - run / 2 - uc, T.pu0 + 6 + run / 2 - uc, T.pu1 - 6 - run * 1.5 - uc);
    }
    if (mode === 'ends' || H < 1.5) return;
    // groups: at +-28 % of the platform length from the middle (big stations), or one at the middle (top level only; a
    // stacked station's lower levels climb to the level above, below)
    for (const p of T.levels[0].plats) {
      p.groups = [];
      const w = (u) => p.eR(u) - p.eL(u);
      // subway concourses: two banks (big stations); lobbies below and footbridges: one bank at the middle (or where
      // the station's config puts it)
      const gOff = T.gOff;
      const at = mode === 'above' && Lp > 150 ? [uc - Lp * 0.27, uc + Lp * 0.27] : [uc + gOff];
      for (const [k, ug] of at.entries()) {
        const width = w(ug); const avail = p.kind === 'island' ? width - 2 * (TAC + 1.0) : width - (TAC + 1.6);
        let kinds = avail >= 5.9 ? ['esc', 'stair', 'esc'] : avail >= 3.8 ? ['esc', 'stair'] : avail >= 2.0 ? ['stair'] : [];
        let widths = kinds.map(q => q === 'esc' ? SP.ESC.OW : 2.0);
        // a narrow island (M2 track spacing at some subway stations): one stair of what fits, >= 1.2 m, with tighter
        // clearance to the edges
        if (!kinds.length) { const tight = (p.kind === "island" ? width - 2 * 1.25 : width - 1.6); if (tight >= 0.6) { kinds = ["stair"]; widths = [U.clamp(tight, 1.2, 2.0)]; } }
        if (!kinds.length) continue;
        const gw = widths.reduce((a, b) => a + b, 0) + 0.25 * (kinds.length - 1);
        const vc = p.kind === 'island' ? (p.eL(ug) + p.eR(ug)) / 2 : (p.sideV > 0 ? p.eR(ug) - 0.4 - gw / 2 : p.eL(ug) + 0.4 + gw / 2);
        // runs rise (or fall) toward the middle of the station: the foot at ug, the head toward uc
        const dir = at.length > 1 ? (k === 0 ? 1 : -1) : 1;
        const run = Math.max(SP.escRun(H), stairRun(H)) + 0.6;
        const uFoot = ug - dir * run / 2, uHead = ug + dir * run / 2;
        const g = { p, kinds, widths, gw, vc, dir, run, uFoot, uHead, H, ug };
        p.groups.push(g);
        // openings: 'above' -> in the ceiling slab over the part of the run that needs headroom; 'below' / 'bridge' down ->
        // in the platform over the part of the run below the platform
        const u0 = Math.min(uFoot, uHead), u1 = Math.max(uFoot, uHead);
        if (mode === 'above' || mode === 'bridge') {
          const need = Math.max(0, (T.ceilY - yT) - 2.4);           // height at which the escalator reaches the ceiling
          const xs = SP.escRun(H) * U.clamp(need / H, 0, 1) * 0.85;
          const a = dir > 0 ? uFoot + xs : uHead, b = dir > 0 ? uHead : uFoot - xs;
          const hole = { u0: Math.min(a, b) - 0.3, u1: Math.max(a, b) + 0.3, v0: vc - gw / 2 - 0.35, v1: vc + gw / 2 + 0.35, g };
          // above the platform ceiling the run climbs in an inclined well; the mezzanine floor opens only where the well's
          // soffit (2.9 m over the nosing line) has reached it
          if (mode === 'above' && T.yCF - T.ceilY > 0.3) {
            const t = U.clamp((T.yCF - WELL_SOFFIT - yT) / H, 0, 1); const uOpen = uFoot + dir * SP.escRun(H) * t;
            hole.cu0 = dir > 0 ? Math.max(hole.u0, uOpen - 0.5) : hole.u0; hole.cu1 = dir > 0 ? hole.u1 : Math.min(hole.u1, uOpen + 0.5);
          } else { hole.cu0 = hole.u0; hole.cu1 = hole.u1; }
          T.ceilHoles.push(hole);
        } else {
          // going down from the platform: the head is at the platform (the foot at the concourse below)
          g.down = true; g.uFoot = ug + dir * run / 2; g.uHead = ug - dir * run / 2;   // head (platform level) at the outer end
          const headroom = 2.4; const xs = SP.escRun(H) * U.clamp(headroom / H, 0, 1) * 0.6;
          const a = g.uHead + (g.uFoot > g.uHead ? 1 : -1) * (1.6);    // leave the top landing + comb on the platform
          p.holes.push({ u0: Math.min(a, g.uFoot) - 0.2, u1: Math.max(a, g.uFoot) + 0.2, v0: vc - gw / 2 - 0.25, v1: vc + gw / 2 + 0.25, g }); void xs;
        }
      }
    }
    // stacked: banks from each lower platform up to the platform over it, two per platform rising toward the middle;
    // the lower box's ceiling opens over the climb, the upper platform where the run's soffit reaches its floor
    for (const L of T.levels.slice(1)) {
      const up = T.levels[L.k - 1]; const Hl = up.yT - L.yT; if (Hl < 1.5 || mode === 'ends') continue;
      for (const p of L.plats) {
        p.groups = [];
        const o = up.plats.map(q => ({ q, a: Math.max(p.eL(uc), q.eL(uc)), b: Math.min(p.eR(uc), q.eR(uc)) })).filter(x => x.b - x.a > 2.4).sort((x, y) => (y.b - y.a) - (x.b - x.a))[0];
        if (!o) continue;
        const avail = (o.b - o.a) - 2 * (TAC + 0.8);
        const kinds = avail >= 5.9 ? ['esc', 'stair', 'esc'] : avail >= 3.8 ? ['esc', 'stair'] : avail >= 1.6 ? ['stair'] : []; if (!kinds.length) continue;
        const widths = kinds.map(q => q === 'esc' ? SP.ESC.OW : Math.min(2.0, avail)); const gw = widths.reduce((x, y) => x + y, 0) + 0.25 * (kinds.length - 1);
        const vc = (o.a + o.b) / 2, run = Math.max(SP.escRun(Hl), stairRun(Hl)) + 0.6;
        for (const [k, ug] of [uc - 22, uc + 22].entries()) {
          const dir = k === 0 ? 1 : -1, uFoot = ug - dir * run / 2, uHead = ug + dir * run / 2;
          const g = { p, kinds, widths, gw, vc, dir, run, uFoot, uHead, H: Hl, ug, yFoot: L.yT, yUp: up.yT, upPlat: o.q };
          p.groups.push(g);
          const need = Math.max(0, (L.ceilY - L.yT) - 2.4), xs = SP.escRun(Hl) * U.clamp(need / Hl, 0, 1) * 0.85;
          const a0 = dir > 0 ? uFoot + xs : uHead, b0 = dir > 0 ? uHead : uFoot - xs;
          const hole = { u0: Math.min(a0, b0) - 0.3, u1: Math.max(a0, b0) + 0.3, v0: vc - gw / 2 - 0.35, v1: vc + gw / 2 + 0.35, g };
          const t = U.clamp((up.yT - 0.3 - WELL_SOFFIT - L.yT) / Hl, 0, 1), uOpen = uFoot + dir * SP.escRun(Hl) * t;
          hole.cu0 = dir > 0 ? Math.max(hole.u0, uOpen - 0.5) : hole.u0; hole.cu1 = dir > 0 ? hole.u1 : Math.min(hole.u1, uOpen + 0.5);
          L.ceilHoles.push(hole);
          o.q.holes.push({ u0: hole.cu0, u1: hole.cu1, v0: hole.v0 + 0.1, v1: hole.v1 - 0.1, g });
          T.occupied.push({ p: o.q, u0: hole.cu0 - 1.5, u1: hole.cu1 + 1.5, v0: hole.v0 - 0.4, v1: hole.v1 + 0.4 });
        }
      }
    }
  }
  // ------------------------------------------------------------------------------------------------ ground plan
  // What stands on the ground, decided once for build() and footprint(): the structure archetype (T.elevated: a deck
  // on bents), the concourse extents T.cu0..cu1 (the lobby under an aerial deck, the subway mezzanine), the footbridge
  // bank T.ub0..ub1, the bents with their columns (T.bents) and the street entrances (T.entPlan, subway).
  function groundPlan(T) {
    const { plats, mode, uc, pu0, pu1, type, under, yT, groundC } = T;
    T.elevated = !under && (type === 'aerial' || type === 'median' || mode === 'below') && yT - groundC > 4.2;
    T.effType = type === 'trench' && T.street - yT < 2.5 ? 'surface' : type;      // (M2: some "trench" platforms sit at street level)
    T.hasConc = mode !== 'ends' && T.rise >= 1.5;
    if (T.hasConc && mode === 'below') {
      const feet = []; for (const p of plats) for (const q of p.groups || []) feet.push(q.uFoot); const ug = uc + (T.gOff || 0);
      T.cu0 = Math.min(ug - 18, ...feet.map(u => u - 10)); T.cu1 = Math.max(ug + 18, ...feet.map(u => u + 10));
    } else if (T.hasConc && mode === 'above') { T.cu0 = pu0 + 12; T.cu1 = pu1 - 12; }
    else if (T.hasConc && mode === 'bridge') {
      const heads = []; for (const p of plats) for (const q of p.groups || []) heads.push(q.uHead);
      const hc = heads.length ? heads.reduce((a, b) => a + b, 0) / heads.length : uc; T.ub0 = hc - 7; T.ub1 = hc + 7;
      planBridge(T);
    }
    T.concHalf = T.cu1 !== undefined ? (T.cu1 - T.cu0) / 2 : 0;
    T.bents = T.elevated ? bentPlan(T) : [];
    T.entPlan = under && T.hasConc && mode === 'above' ? planEntrances(T, T.cu0, T.cu1) : [];
    if (under && mode === 'ends') {
      T.entPlan = planEndShafts(T);
      for (const P of T.entPlan) { const ua = Math.min(P.uTop, P.uBot), ub = Math.max(P.uTop, P.uBot);
        T.ceilHoles.push({ u0: ua - 0.25, u1: ub + 0.25, v0: P.ve - P.W / 2 - 0.3, v1: P.ve + P.W / 2 + 0.3, cu0: ua, cu1: ub });
        T.occupied.push({ p: P.p, u0: ua - 1.5, u1: ub + 1.5, v0: P.ve - P.W / 2 - 0.8, v1: P.ve + P.W / 2 + 0.8 }); }
    }
  }
  // bents every 24 m under an aerial deck: a cap beam and two columns; inside a ground-level lobby the columns stand
  // clear of the escalator wells and of the fare line, booth and ticket machines at its entrance end
  function bentPlan(T) {
    const { boxU0, boxU1, edgeV } = T; const out = [];
    const deckBot = T.yRail - 0.6 - 1.9;
    const inLobby = (u) => T.mode === 'below' && T.hasConc && u > T.cu0 - 1 && u < T.cu1 + 1;
    const colVs = (u) => { const vl = edgeV(u, -1), vr = edgeV(u, 1); const vc = (vl + vr) / 2, half = (vr - vl) / 2; return [vc - half * 0.55, vc + half * 0.55]; };
    // (a bent's cap beam would cross the escalators passing down through an opening in the platform)
    const underHole = (u) => T.plats.some(p => p.holes.some(h => u > h.u0 - 1.6 && u < h.u1 + 1.6));
    let last = -1e9;
    for (let u0 = boxU0 + 6; u0 <= boxU1 - 6; u0 += 24) {
      // a street under the deck: the bent moves (spans over it) up to 10 m, keeping 12 m from the one before
      let u = u0;
      if (T.roads && T.roads.length) {
        const clear = (uu) => uu - last >= 12 && uu >= boxU0 + 2 && uu <= boxU1 - 2 && !colVs(uu).some(v => roadAt(T, uu, v, 1.4)) && !underHole(uu);
        const d = [0, 2, -2, 4, -4, 6, -6, 8, -8, 10, -10].find(dd => clear(u0 + dd)); if (d !== undefined) u = u0 + d;
      } else if (underHole(u0)) {
        const d = [2, -2, 4, -4, 6, -6, 8, -8, 10, -10, 12, -12].find(dd => u0 + dd - last >= 12 && !underHole(u0 + dd)); if (d !== undefined) u = u0 + d;
      }
      if (underHole(u)) continue;
      const vl = edgeV(u, -1), vr = edgeV(u, 1); const vc = (vl + vr) / 2, half = (vr - vl) / 2;
      const cols = [];
      for (const v of [vc - half * 0.55, vc + half * 0.55]) {
        if (T.roads && T.roads.length && roadAt(T, u, v, 1.4)) continue;
        if (inLobby(u) && (u < T.cu0 + 10 || T.plats.some(p => p.holes.some(h => u > h.u0 - 2.5 && u < h.u1 + 2.5 && v > h.v0 - 1.3 && v < h.v1 + 1.3)))) continue;
        const [x, z] = T.WUV(u, v); const gy = Terrain.h(x, z) - 0.5; const h = deckBot - 1.2 - gy; if (h < 0.5 || h > 40) continue;
        cols.push({ v, gy, h });
      }
      out.push({ u, vc, half, cols }); last = u;
    }
    return out;
  }
  // ------------------------------------------------------------------------------------------------ footprint
  // The station's ground-level keep-out zones (world xz), from the same setup the builders use:
  //   [{ kind, pts: [[x, z] x 4], under? }] convex quads (under: a road or car below this height passes beneath); kinds:
  //   deck      under an aerial deck (no buildings, trees or lamps; cars may park and drive under it)
  //   track     an at-grade / trench / median trackway with its platforms and shoulders (nothing at all)
  //   lobby     a ground-level lobby and fare area; plaza: the apron at its entrance end
  //   column    a bent column or a footbridge support
  //   bridge    under a footbridge (like deck)
  //   entrance  a subway street entrance: the stair shaft, its railings and totem
  //   landing   a footbridge's landing tower (stairs and elevator down to an entrance)
  function footprint(st, C) { const T = setup(st, C); return T ? footprintT(T) : []; }
  function footprintT(T) {
    const out = [];
    const quad = (kind, u0, u1, v0, v1) => out.push({ kind, pts: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => T.WUV(u, v)) });
    const strip = (kind, u0, u1, vl, vr, step = 8) => { for (let u = u0; u < u1 - 1e-3; u += step) { const ub = Math.min(u1, u + step);
      out.push({ kind, pts: [[u, vl(u)], [ub, vl(ub)], [ub, vr(ub)], [u, vr(u)]].map(([a, b]) => T.WUV(a, b)) }); } };
    const { edgeV, boxU0, boxU1 } = T;
    if (T.under) {
      for (const P of T.entPlan) { const ua = Math.min(P.uTop, P.uBot), ub = Math.max(P.uTop, P.uBot); quad('entrance', ua - 0.4, ub + 0.4, P.ve - P.W / 2 - 0.5, P.ve + P.W / 2 + 1.2); }
    } else if (T.elevated) {
      strip('deck', boxU0, boxU1, (u) => edgeV(u, -1) - 0.4, (u) => edgeV(u, 1) + 0.4);
      for (const b of T.bents) for (const c of b.cols) quad('column', b.u - 0.8, b.u + 0.8, c.v - 0.8, c.v + 0.8);
      if (T.hasConc && T.mode === 'below' && Math.abs(T.yCF - T.groundC) < 2.5) {
        strip('lobby', T.cu0, T.cu1, (u) => edgeV(u, -1) - 1.6, (u) => edgeV(u, 1) + 1.6, 6);
        quad('plaza', T.cu0 - 8, T.cu0, edgeV(T.cu0, -1) - 1.6, edgeV(T.cu0, 1) + 1.6);
        // the ground is graded to the lobby floor under the lobby and its apron (MetroStations' height filter)
        const vl = Math.min(edgeV(T.cu0, -1), edgeV(T.cu1, -1), edgeV(T.uc, -1)) - 2.6, vr = Math.max(edgeV(T.cu0, 1), edgeV(T.cu1, 1), edgeV(T.uc, 1)) + 2.6;
        out.pads = [{ pts: [[T.cu0 - 9, vl], [T.cu1 + 1, vl], [T.cu1 + 1, vr], [T.cu0 - 9, vr]].map(([u, v]) => T.WUV(u, v)), y: T.yCF - 0.03, blend: 12 }];
      }
    } else {
      const m = T.type === 'median' ? 1.8 : 1.5; const n0 = out.length;
      strip('track', boxU0, boxU1, (u) => edgeV(u, -1) - m, (u) => edgeV(u, 1) + m);
      // a street well below the track bed passes under it (a station on an embankment or a freeway bridge)
      for (let i = n0; i < out.length; i++) out[i].under = T.yRail - 0.6 - 4.5;
      if (T.hasConc && T.mode === 'bridge') {
        strip('bridge', T.ub0 - 0.5, T.ub1 + 0.5, (u) => edgeV(u, -1) - 2.5, (u) => edgeV(u, 1) + 2.5, 15);
        for (const [u, v] of bridgeSupports(T)) quad('column', u - 0.4, u + 0.4, v - 0.4, v + 0.4);
        const W2 = T.W2, hw = WALK_W / 2 + 0.6;
        const box = (kind, a, b, h0, h1) => { const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
          out.push({ kind, pts: [[-h0, -h1], [len + h0, -h1], [len + h0, h1], [-h0, h1]].map(([x, z]) => W2(a[0] + ux * x - uz * z, a[1] + uz * x + ux * z)) }); };
        for (const L of T.landings || []) {
          for (const [a, b] of L.segs) box('bridge', a, b, 0.5, hw);
          for (const q of L.supports) box('column', [q[0] - Math.cos(q[2]) * 0.4, q[1] + Math.sin(q[2]) * 0.4], [q[0] + Math.cos(q[2]) * 0.4, q[1] - Math.sin(q[2]) * 0.4], 0, 0.4);
          box('landing', L.foot, L.top, 0.8, 1.9);                                 // the stair tower
          const ex = L.top[0] + L.dir[0] * 1.4 + L.dir[1] * 2.8, ez = L.top[1] + L.dir[1] * 1.4 - L.dir[0] * 2.8;   // the elevator beside its top
          box('landing', [ex - L.dir[0] * 1.5, ez - L.dir[1] * 1.5], [ex + L.dir[0] * 1.5, ez + L.dir[1] * 1.5], 0, 1.6);
        }
      }
    }
    return out;
  }
  // the cell ambient handed to Under: the fixtures' bounce light, a little generous so people and trains (which get no
  // direct light from the station's line lights until Under.addLights) read under the lights
  const ambOf = (S) => { const a = S.amb || [0.4, 0.4, 0.4]; return +(1.6 * (0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2])).toFixed(3); };
  const stairRun = (H) => { const n = Math.max(1, Math.round(H / SP.RISER)); const flights = Math.ceil(n / 16); return (n - flights) * SP.TREAD + (flights - 1) * 1.6 + 0.6; };

  // ------------------------------------------------------------------------------------------------ slabs with openings
  // a horizontal slab between vl(u) and vr(u) at height y over [ua, ub], skipping the holes { u0, u1, v0, v1 };
  // up: true = the upper face (a floor), false = the lower face (a ceiling)
  function slab(T, g, ua, ub, vl, vr, y, holes, mat, up = true) {
    const cuts = []; for (const h of holes) cuts.push(h.u0, h.u1);
    const fr = T.frames(ua, ub, cuts); const hs = holes.slice().sort((a, b) => a.v0 - b.v0);
    g.sweep(fr, (i, f) => {
      // every hole edge on every row (constant topology), sorted; a segment is skipped when an active hole covers it
      const a = vl(f.u), b = vr(f.u); const vs = [a]; for (const h of hs) vs.push(U.clamp(h.v0, a, b), U.clamp(h.v1, a, b)); vs.push(b); vs.sort((x, z) => x - z);
      const inside = hs.filter(h => f.u > h.u0 + 1e-3 && f.u <= h.u1 + 1e-3);
      return vs.map((v, k) => { if (k === vs.length - 1) return [v, y]; const m = (v + vs[k + 1]) / 2; return [v, y, null, inside.some(h => m > h.v0 && m < h.v1) ? 'skip' : mat]; });
    }, !up);
  }
  // the lowest ground over a station-local area (samples every ~8 m along u, three across)
  function minGround(T, u0, u1, vl, vr) {
    let m = 1e9; const n = Math.max(2, Math.ceil((u1 - u0) / 8));
    for (let i = 0; i <= n; i++) { const u = u0 + (u1 - u0) * i / n; for (const t of [0, 0.5, 1]) { const [x, z] = T.WUV(u, vl(u) + (vr(u) - vl(u)) * t); m = Math.min(m, Terrain.h(x, z)); } }
    return m;
  }
  // the inclined well of a run climbing from the platform ceiling to the mezzanine: side walls from the ceiling up to a
  // sloped soffit WELL_SOFFIT over the nosing line (capped at the mezzanine floor), the soffit, and the end walls
  const WELL_SOFFIT = 2.9;
  const soffitAt = (T, G, u) => (G.yFoot ?? T.yT) + G.H * U.clamp(((u - G.uFoot) * G.dir) / SP.escRun(G.H), 0, 1) + WELL_SOFFIT;
  function inclinedWell(T, g, h, mWall, mSoff, lv) {
    const ceilY = lv ? lv.ceilY : T.ceilY, yCF = lv ? lv.yTop : T.yCF; const G = h.g;
    if (!G || yCF - ceilY < 0.3) { holeRim(T, g, h, ceilY, yCF || ceilY + 0.8, mWall); return; }
    const top = (u) => Math.max(ceilY + 0.05, Math.min(yCF, soffitAt(T, G, u)));
    const fr = T.frames(h.u0, h.u1);
    g.sweep(fr, (i, f) => [[h.v0, top(f.u), top(f.u), mWall], [h.v0, ceilY, ceilY]]);
    g.sweep(fr, (i, f) => [[h.v1, ceilY, ceilY, mWall], [h.v1, top(f.u), top(f.u)]]);
    // the soffit over the part of the run below the mezzanine floor (facing down)
    const lo = G.dir > 0 ? h.u0 : h.cu1, hi = G.dir > 0 ? h.cu0 : h.u1;
    if (hi - lo > 0.2) {
      g.sweep(T.frames(lo, hi), (i, f) => [[h.v0, top(f.u), null, mSoff], [h.v1, top(f.u)]], true);
      // a light line along the soffit over the middle of the run
      const vc = (h.v0 + h.v1) / 2, LC = T.S.light, z = lv ? lv.zone : T.zones[0];
      z.m.glow.mat(LC); z.m.glow.sweep(T.frames(lo, hi), (i, f) => [[vc - 0.12, top(f.u) - 0.03], [vc + 0.12, top(f.u) - 0.03]], true);
      if (z.lights.lights.length < StationKit.MAXL) { const fa = T.frameAt(lo), fb = T.frameAt(hi);
        z.lights.add({ a: [fa.x - fa.tz * vc, top(lo) - 0.12, fa.z + fa.tx * vc], b: [fb.x - fb.tz * vc, top(hi) - 0.12, fb.z + fb.tx * vc], color: LC.map(c => c * T.S.lightI * 0.8), range: 14, radius: 0.1, dir: [0, -1, 0], focus: 1 }); }
    }
    // end walls: at the foot end from the ceiling to the soffit, at the head end up to the mezzanine floor
    const P = (u, v, y) => { const f = T.frameAt(u); return [f.x - f.tz * v, y, f.z + f.tx * v]; }; g.set(mWall);
    const endW = (u, y1, facePlus) => { const q = [P(u, h.v0, ceilY), P(u, h.v1, ceilY), P(u, h.v1, y1), P(u, h.v0, y1)];
      if (facePlus) g.quad(q[0], q[1], q[2], q[3], [h.v0, ceilY, h.v1, ceilY, h.v1, y1, h.v0, y1]); else g.quad(q[1], q[0], q[3], q[2], [h.v1, ceilY, h.v0, ceilY, h.v0, y1, h.v1, y1]); };
    if (G.dir > 0) { endW(h.u0, top(h.u0), true); endW(h.u1, yCF, false); } else { endW(h.u1, top(h.u1), false); endW(h.u0, yCF, true); }
  }
  // vertical faces around an opening (slab edges) from y0 to y1, inward facing
  function holeRim(T, g, h, y0, y1, mat) {
    const { frameAt } = T; g.set(mat);
    const P = (u, v, y) => { const f = frameAt(u); return [f.x - f.tz * v, y, f.z + f.tx * v]; };
    const q = (a, b) => g.quad(P(a[0], a[1], y0), P(b[0], b[1], y0), P(b[0], b[1], y1), P(a[0], a[1], y1), [0, y0, 1, y0, 1, y1, 0, y1]);
    // corners counter-clockwise seen from above, so the faces look into the opening
    const c = [[h.u0, h.v0], [h.u0, h.v1], [h.u1, h.v1], [h.u1, h.v0]];
    q(c[0], c[1]); q(c[1], c[2]); q(c[2], c[3]); q(c[3], c[0]);
  }

  // ------------------------------------------------------------------------------------------------ subway box
  // one box per level (stacked stations: the lower level's ceiling is the slab under the upper level's trackbed)
  function* subwayBox(T) { for (const L of T.levels) yield* subwayLevel(T, L); }
  function* subwayLevel(T, L) {
    const { S, boxU0, boxU1, frames, frameAt, M, pu0, pu1, walk, W2, tv } = T;
    const top = L.k === 0, z = L.zone, g = z.m.sk, plats = L.plats, edgeV = T.levels.length > 1 ? L.edgeV : T.edgeV;
    const yT = L.yT, yRail = T.levels.length > 1 ? L.yRail : T.yRail;
    const yTB = yRail - 0.6, ceilY = top ? T.ceilY : L.ceilY, wallT = 0.5;
    const ceilHoles = top ? T.ceilHoles : L.ceilHoles;
    const fr = frames(boxU0, boxU1);
    const mLow = M(S.wallLow), mWall = M(S.wall), mUp = M(S.wallUp), mCeil = M(S.ceil);
    // side walls (left wall faces +v: traverse top -> bottom; right wall faces -v: bottom -> top)
    const band = T.H.band !== undefined ? { col: lin(T.H.band), kind: K.PAINT, prm: 0 } : null;
    const wallProf = (v, side) => {
      const P = band ? [[v, yTB, yTB, mLow], [v, yT + 0.2, yT + 0.2, mWall], [v, yT + 2.55, yT + 2.55, band], [v, yT + 2.95, yT + 2.95, mWall], [v, ceilY - 0.9, ceilY - 0.9, mUp], [v, ceilY, ceilY]]
        : [[v, yTB, yTB, mLow], [v, yT + 0.2, yT + 0.2, mWall], [v, ceilY - 0.9, ceilY - 0.9, mUp], [v, ceilY, ceilY]];
      if (side < 0) { const R = P.slice().reverse(); return R.map((p, k) => [p[0], p[1], p[2], R[k + 1] ? R[k + 1][3] : undefined]); }
      return P;
    };
    g.sweep(fr, (i, f) => wallProf(edgeV(f.u, -1), -1));
    g.sweep(fr, (i, f) => wallProf(edgeV(f.u, 1), 1));
    // ceiling (with the escalator wells), its slab edge faces, and (without a concourse above) the roof slab
    slab(T, g, boxU0, boxU1, (u) => edgeV(u, -1), (u) => edgeV(u, 1), ceilY, ceilHoles, mCeil, false);
    for (const h of ceilHoles) inclinedWell(T, g, h, M(S.wall), M(S.ceil), top ? undefined : { ceilY, yTop: T.levels[L.k - 1].yT - 0.3, zone: z });
    if (top && T.mode === 'ends') slab(T, g, boxU0, boxU1, (u) => edgeV(u, -1) - wallT, (u) => edgeV(u, 1) + wallT, ceilY + 0.8, T.ceilHoles, M([0x77746e, K.CONCRETE]), true);
    // end walls with tunnel openings around each track (the tunnels themselves are INFRA's)
    for (const [ue, dir] of [[boxU0, -1], [boxU1, 1]]) {
      const f = frameAt(ue); const vl = edgeV(ue, -1), vr = edgeV(ue, 1);
      const holes = L.tracks.map(t => { const v = tv(t, ue); return [v - 2.2, v + 2.2]; }).sort((a, b) => a[0] - b[0]);
      const P = (v, y) => [f.x - f.tz * v, y, f.z + f.tx * v];
      g.mat(S.wallUp[0], K.CONCRETE, 0);
      const band = (va, vb, ya, yb) => { if (vb - va < 0.01 || yb - ya < 0.01) return; const q = [P(va, ya), P(vb, ya), P(vb, yb), P(va, yb)];
        if (dir > 0) g.quad(q[1], q[0], q[3], q[2], [vb, ya, va, ya, va, yb, vb, yb]); else g.quad(q[0], q[1], q[2], q[3], [va, ya, vb, ya, vb, yb, va, yb]); };
      let v = vl; for (const [a, b] of holes) { band(v, a, yTB, ceilY); band(a, b, yRail + 4.3, ceilY); v = b; } band(v, vr, yTB, ceilY);
      const pl = P(vl, 0), pr = P(vr, 0); addWall(walk, W2(pl[0], pl[2]), W2(pr[0], pr[2]), yTB, ceilY);
    }
    for (let i = 0; i + 1 < fr.length; i++) for (const side of [-1, 1]) {
      const f0 = fr[i], f1 = fr[i + 1]; const v0 = edgeV(f0.u, side), v1 = edgeV(f1.u, side);
      addWall(walk, W2(f0.x - f0.tz * v0, f0.z + f0.tx * v0), W2(f1.x - f1.tz * v1, f1.z + f1.tx * v1), yTB, ceilY);
    }
    const poly = []; for (const f of fr) { const v = edgeV(f.u, -1) - wallT; poly.push([f.x - f.tz * v, f.z + f.tx * v]); }
    for (let i = fr.length - 1; i >= 0; i--) { const f = fr[i]; const v = edgeV(f.u, 1) + wallT; poly.push([f.x - f.tz * v, f.z + f.tx * v]); }
    // (up to the mezzanine floor: the escalator wells above the platform ceiling belong to this level)
    const cellTop = !top ? ceilY + 0.3 : T.mode === 'above' ? Math.max(ceilY + 0.9, T.yCF) : Math.min(ceilY + 0.9, minGround(T, boxU0, boxU1, (u) => edgeV(u, -1), (u) => edgeV(u, 1)) - 0.5);
    T.cells.push({ zone: L.name, under: { id: `st:${T.st.id}:${L.name}`, kind: 'station', poly: poly.map(([x, zz]) => W2(x, zz)), floor: yRail - 1.2, ceil: cellTop, ambient: ambOf(S) } });
    // lights: continuous troughs over each platform (both edges of an island) + wall-wash coves along both track walls
    const LC = S.light, I = S.lightI; const trough = M([0x34332f, K.PAINT]);
    const pend = T.H.pendants === 'dome';
    for (const p of plats) {
      const um0 = p.u0 + 3, um1 = p.u1 - 3; const f0 = frameAt(um0), f1 = frameAt(um1); const umid = (um0 + um1) / 2;
      const vs = p.kind === 'island' ? [p.eL(umid) + 1.4, p.eR(umid) - 1.4] : [(p.eL(umid) + p.eR(umid)) / 2];
      if (pend && p.kind === 'island') {
        // rows of white dome pendants on stems (Montgomery, Powell): the fixtures; two long line lights stand in for them
        const cv0 = (p.eL(umid) + p.eR(umid)) / 2, off = Math.min(4.0, (p.eR(umid) - p.eL(umid)) / 2 - 1.3); const yL = ceilY - 1.15;
        for (const s of [-1, 1]) {
          z.lights.add({ a: [f0.x - f0.tz * (cv0 + s * off), yL, f0.z + f0.tx * (cv0 + s * off)], b: [f1.x - f1.tz * (cv0 + s * off), yL, f1.z + f1.tx * (cv0 + s * off)], color: [LC[0] * I * 0.9, LC[1] * I * 0.9, LC[2] * I * 0.9], range: 24, radius: 0.3, dir: [0, -1, 0], focus: 1 });
          for (let u = um0 + 2.6; u < um1; u += 5.2) {
            const vv = (p.eL(u) + p.eR(u)) / 2 + s * off;
            T.place(z.d.sk, u, vv, ceilY, 0); z.d.sk.mat(0x2a2a2c, K.PAINT); z.d.sk.cyl(0, -1.0, 0, 0.012, 0.012, 1.0, 6, false);
            z.d.sk.mat(0xf2f1ec, K.PLAIN, 0.35); z.d.sk.cyl(0, -1.28, 0, 0.36, 0.08, 0.28, 18, true); z.d.sk.pop();
            T.place(z.d.glow, u, vv, ceilY - 1.285, 0); z.d.glow.mat(LC); z.d.glow.cyl(0, -0.01, 0, 0.3, 0.3, 0.01, 18, true); z.d.glow.pop();
          }
        }
        continue;
      }
      for (const v of vs) {
        z.lights.add({ a: [f0.x - f0.tz * v, ceilY - 0.2, f0.z + f0.tx * v], b: [f1.x - f1.tz * v, ceilY - 0.2, f1.z + f1.tx * v], color: [LC[0] * I, LC[1] * I, LC[2] * I], range: 26, radius: 0.12, dir: [0, -1, 0], focus: 1 });
        const fr2 = frames(um0, um1);
        z.m.glow.mat(LC.map(c => c * 0.95)); z.m.glow.sweep(fr2, (i, f) => [[v - 0.14, ceilY - 0.12], [v + 0.14, ceilY - 0.12]], true);
        z.m.sk.sweep(fr2, (i, f) => [[v - 0.2, ceilY, null, trough], [v - 0.2, ceilY - 0.14, null, trough], [v - 0.14, ceilY - 0.12], [v + 0.14, ceilY - 0.12, null, trough], [v + 0.2, ceilY - 0.14, null, trough], [v + 0.2, ceilY]]);
      }
    }
    for (const side of [-1, 1]) {
      const f0 = frameAt(pu0), f1 = frameAt(pu1); const v = edgeV(T.uc, side) - side * 0.35;
      z.lights.add({ a: [f0.x - f0.tz * v, ceilY - 1.1, f0.z + f0.tx * v], b: [f1.x - f1.tz * v, ceilY - 1.1, f1.z + f1.tx * v], color: LC.map(c => c * I * 0.55), range: 18, radius: 0.1, dir: [-side * 0.3, 0.2, 0], focus: 0 });
    }
    // portals from this level up to the one above, at the openings of the runs climbing between them
    if (!top) for (const h of ceilHoles) { const q = [[h.cu0 ?? h.u0, h.v0], [h.cu1 ?? h.u1, h.v0], [h.cu1 ?? h.u1, h.v1], [h.cu0 ?? h.u0, h.v1]].map(([u, v]) => { const [x, zz] = T.WUV(u, v); return [x, ceilY + 0.15, zz]; });
      T.portals.push({ id: `st:${T.st.id}:lv${L.k}:${T.portals.length}`, a: `st:${T.st.id}:${L.name}`, b: `st:${T.st.id}:${T.levels[L.k - 1].name}`, quad: q, day: 0 }); }
    yield;
  }

  // ------------------------------------------------------------------------------------------------ aerial deck
  function* aerialDeck(T) {
    const { zones, S, yRail, boxU0, boxU1, frames, frameAt, edgeV, M, plats } = T;
    const z = zones[0], g = z.m.sk;
    const deckTop = yRail - 0.6, deckBot = deckTop - 1.9;
    const fr = frames(boxU0, boxU1);
    const mDeck = M(S.deck), mFascia = M([0xc9c4b9, K.CONCRETE, 0]);
    g.sweep(fr, (i, f) => {
      const vl = edgeV(f.u, -1), vr = edgeV(f.u, 1);
      return [[vl + 0.1, deckTop + 1.05, null, Object.assign({}, mFascia, { sky: 1 })], [vl - 0.25, deckTop + 1.05, null, Object.assign({}, mFascia, { sky: 1 })], [vl - 0.25, deckBot + 0.3, null, Object.assign({}, mFascia, { sky: 0.8 })],
        [vl + 1.2, deckBot, null, Object.assign({}, mDeck, { sky: 0.45 })], [vr - 1.2, deckBot, null, Object.assign({}, mFascia, { sky: 0.8 })], [vr + 0.25, deckBot + 0.3, null, Object.assign({}, mFascia, { sky: 1 })], [vr + 0.25, deckTop + 1.05, null, Object.assign({}, mFascia, { sky: 1 })], [vr - 0.1, deckTop + 1.05]];
    }, true);
    for (const side of [-1, 1]) g.sweep(fr, (i, f) => { const v = side < 0 ? edgeV(f.u, -1) + 0.1 : edgeV(f.u, 1) - 0.1; return side < 0 ? [[v, deckTop + 1.05, null, M(S.deck, { sky: 1 })], [v, deckTop]] : [[v, deckTop, null, M(S.deck, { sky: 1 })], [v, deckTop + 1.05]]; });
    for (const b of T.bents) {
      for (const c of b.cols) { T.place(g, b.u, c.v, c.gy); g.mat(S.col[0], S.col[1], S.col[2]); g.cyl(0, 0, 0, 0.7, 0.62, c.h, 20, false); g.pop(); }
      T.place(g, b.u, b.vc, deckBot - 1.25); g.mat(S.deck[0], K.CONCRETE, 0); g.box(-0.9, 0, -b.half * 0.8, 0.9, 1.25, b.half * 0.8); g.pop();
    }
    for (const p of plats) yield* canopy(T, p);
    for (const p of plats) if (p.kind === 'side') {
      const fr2 = frames(p.u0, p.u1); const back = (u) => p.sideV > 0 ? p.eR(u) : p.eL(u);
      z.d.sk.mat(S.steel[0], K.PAINT);
      for (let i = 0; i < fr2.length; i += 3) { const f = fr2[i]; T.place(z.d.sk, f.u, back(f.u), p.y); z.d.sk.cbox(0, 0, 0, 0.08, 2.4, 0.08); z.d.sk.pop(); }
      z.d.glass.sweep(fr2, (i, f) => [[back(f.u), p.y + 1.0], [back(f.u), p.y + 2.4]]);
      z.d.glass.sweep(fr2, (i, f) => [[back(f.u), p.y + 1.0], [back(f.u), p.y + 2.4]], true);
      // low concrete parapet under the windscreen, a tinted frame rail on top
      const mPar = M(T.H.deck || S.deck || [0xb5afa3, K.CONCRETE, 0], { sky: 1 });
      z.m.sk.sweep(fr2, (i, f) => { const v = back(f.u), s2 = p.sideV; return s2 > 0 ? [[v, p.y, p.y, mPar], [v, p.y + 1.0, p.y + 1.0, mPar], [v + 0.2, p.y + 1.0, null, mPar], [v + 0.2, p.y]] : [[v - 0.2, p.y, null, mPar], [v - 0.2, p.y + 1.0, null, mPar], [v, p.y + 1.0, p.y + 1.0, mPar], [v, p.y, p.y]]; });
      if (T.H.windscreen !== undefined) { const mF = { col: lin(T.H.windscreen), kind: K.PAINT, prm: 0, sky: 1 };
        z.d.sk.sweep(fr2, (i, f) => { const v = back(f.u); return [[v - 0.05, p.y + 2.4, null, mF], [v - 0.05, p.y + 2.5, null, mF], [v + 0.05, p.y + 2.5, null, mF], [v + 0.05, p.y + 2.4]]; }); }
    }
    yield;
  }
  // ------------------------------------------------------------------------------------------------ canopies
  // Canopy over a platform, by style (StationHeroes config or the era default). The roof is swept along the platform
  // from a cross-section (top and underside polylines across v) that may vary along u (hipped ends, waves, humps, pills).
  function defaultCanopy(T) {
    const era = ERA[T.st.id] || '1970s';
    if (era === '1970s') return { style: 'flat', len: 95, top: 0xcfccc5, under: 0xc3c0b8, fascia: 0x6b4a36, louvre: 0x4a3a2c, posts: { shape: 'rect', col: 0x4a3a2c, size: 0.3, spacing: 9, where: 'centre' } };
    if (era === '1990s' || era === '2000s') return { style: 'butterfly', len: 120, top: 0xd9dcdf, under: 0xe3e5e7, fascia: 0x5e6f7c, posts: { shape: 'round', col: 0x6f7d88, size: 0.32, spacing: 12, where: 'centre' } };
    return { style: 'flat', len: 140, top: 0xe9ebec, under: 0xf0f0ee, underKind: K.WOOD, fascia: 0xe9ebec, posts: { shape: 'round', col: 0xe8e9ea, size: 0.3, spacing: 12, where: 'centre' } };
  }
  function* canopy(T, p) {
    const { zones, S, frames, M } = T; const z = zones[0], g = z.m.sk, gd = z.d.sk;
    const C = (T.H.canopy) || defaultCanopy(T);
    const island = p.kind === 'island';
    const Lmax = p.u1 - p.u0 - 4, len = Math.min(C.len || Lmax, Lmax);
    let mid = (p.u0 + p.u1) / 2 + (C.off || 0); mid = U.clamp(mid, p.u0 + 2 + len / 2, p.u1 - 2 - len / 2);
    const u0 = mid - len / 2, u1 = mid + len / 2; p.canopy = [u0, u1];
    const yP = p.y, h = C.h || 3.5, eave = yP + h;
    // lateral extent: islands overhang both edges by ~1 m; side platforms from the back to 1 m over the edge;
    // 'all' spans every track of the station
    const back = (u) => p.sideV > 0 ? p.eR(u) : p.eL(u), edgeS = (u) => p.sideV > 0 ? p.eL(u) : p.eR(u);
    let vA, vB;
    if (C.span === 'all') { vA = (u) => T.edgeV(u, -1) + 0.2; vB = (u) => T.edgeV(u, 1) - 0.2; }
    else if (island) { vA = (u) => p.eL(u) - 1.0; vB = (u) => p.eR(u) + 1.0; }
    else { vA = (u) => Math.min(back(u) - 0.2 * p.sideV, edgeS(u) - 1.0 * p.sideV); vB = (u) => Math.max(back(u) - 0.2 * p.sideV, edgeS(u) - 1.0 * p.sideV); }
    const colTop = lin(C.top || 0xd8d6d0), colUnder = lin(C.under || 0xc3c0b8), colFas = lin(C.fascia || 0x6b6862);
    const mTop = { col: colTop, kind: C.style === 'gull' ? K.CONCRETE : K.CORRUG, prm: 0.22, sky: 1 };
    const mUnd = { col: colUnder, kind: C.underKind ?? (C.style === 'gull' ? K.PANEL : K.PANEL), prm: C.underKind === K.WOOD ? 0.09 : 1.2, sky: 0.55 };
    const mFas = { col: colFas, kind: K.PAINT, prm: 0, sky: 0.95 };
    const cuts = []; for (let k = 0; k <= 10; k++) cuts.push(u0 + len * k / 10);
    const fr = frames(u0, u1, cuts);
    const t01 = (u) => (u - u0) / len;
    // heights across the roof at parameter a in [0, 1] (0 = vA side, 1 = vB side), along u
    const style = C.style || 'flat';
    const hipK = (u) => { const hip = style === 'hipped' ? 4 : style === 'gable' ? 5 : 0; if (!hip) return 1; const d = Math.min(u - u0, u1 - u); return U.clamp(d / hip, 0, 1); };
    const top = (a, u) => {
      const w = 1;
      switch (style) {
        case 'butterfly': return eave + 0.9 - 0.55 * (1 - Math.abs(2 * a - 1));
        case 'gull': return eave + 0.95 - 0.8 * (1 - Math.abs(2 * a - 1));
        case 'shed': return eave + (C.tilt ? 0.25 + 0.5 * a : 0.4 + 0.35 * (1 - a));
        case 'hipped': return eave + 0.35 + 0.9 * (1 - Math.abs(2 * a - 1)) * hipK(u);
        case 'gable': return eave + 0.35 + 1.6 * (1 - Math.abs(2 * a - 1)) * hipK(u);
        case 'box': return eave + 1.5;
        case 'wave': return eave + 0.5 + 0.9 * (0.5 + 0.5 * Math.cos(t01(u) * Math.PI * 2 * 2.5)) * (0.6 + 0.4 * (1 - Math.abs(2 * a - 1)));
        case 'humps': return eave + 0.4 + 2.4 * Math.abs(Math.sin(t01(u) * Math.PI * 5)) * (1 - Math.pow(Math.abs(2 * a - 1), 2)) * (t01(u) > 0.15 && t01(u) < 0.85 ? 1 : 0.35);
        case 'barrel': return eave + 0.2 + 1.8 * Math.sqrt(Math.max(0, 1 - Math.pow(2 * a - 1, 2)));
        case 'pill': return eave + 0.45 + 0.35 * Math.sqrt(Math.max(0, 1 - Math.pow(2 * a - 1, 2)));
        case 'frames': return eave + 0.9;
        default: return eave + 0.45 + 0.08 * (1 - Math.abs(2 * a - 1)) * w;       // flat (a slight crown for drainage)
      }
    };
    const thick = style === 'box' ? 1.4 : style === 'gull' ? 0.45 : 0.28;
    const pillW = (u) => style === 'pill' ? Math.sqrt(Math.max(0.02, 1 - Math.pow(2 * t01(u) - 1, 2))) : 1;
    const NA = style === 'flat' || style === 'box' || style === 'frames' || style === 'shed' ? 2 : 8;
    const vAt = (a, u) => { const va = vA(u), vb = vB(u), c = (va + vb) / 2, hw = (vb - va) / 2 * pillW(u); return c - hw + a * 2 * hw; };
    if (style !== 'frames' || true) {
      // top surface (a from 0 to 1 = left to right: upward normals), underside (reversed), and the long edges' fascias
      g.sweep(fr, (i, f) => { const P = []; for (let k = 0; k <= NA; k++) { const a = k / NA; P.push([vAt(a, f.u), top(a, f.u), null, k < NA ? mTop : undefined]); } return P; });
      g.sweep(fr, (i, f) => { const P = []; for (let k = NA; k >= 0; k--) { const a = k / NA; P.push([vAt(a, f.u), top(a, f.u) - thick, null, k > 0 ? mUnd : undefined]); } return P; });
      for (const a of [0, 1]) g.sweep(fr, (i, f) => { const v = vAt(a, f.u), y1 = top(a, f.u), fd = style === 'box' ? thick : Math.max(thick, 0.55);
        return a === 0 ? [[v - 0.03, y1 + 0.05, y1, mFas], [v - 0.03, y1 - fd, y1 - fd]] : [[v + 0.03, y1 - fd, y1 - fd, mFas], [v + 0.03, y1 + 0.05, y1 + 0.05]]; });
      // end caps (vertical, across)
      for (const [ue, dir] of [[u0, -1], [u1, 1]]) {
        const f = T.frameAt(ue); const P = []; for (let k = 0; k <= NA; k++) { const a = k / NA; P.push([vAt(a, ue), top(a, ue)]); }
        const W = (v, y) => [f.x - f.tz * v, y, f.z + f.tx * v]; g.set(mFas);
        for (let k = 0; k < NA; k++) { const a0 = P[k], a1 = P[k + 1]; const q = [W(a0[0], a0[1] - thick), W(a1[0], a1[1] - thick), W(a1[0], a1[1]), W(a0[0], a0[1])];
          if (dir > 0) g.quad(q[1], q[0], q[3], q[2], [0, 0, 1, 0, 1, 1, 0, 1]); else g.quad(q[0], q[1], q[2], q[3], [0, 0, 1, 0, 1, 1, 0, 1]); }
      }
    }
    // louvre band hanging under the long track-side fascia(s) (vertical slats), clerestory glass under the roof
    if (C.louvre) {
      const mL = { col: lin(C.louvre), kind: K.FLUTED, prm: 0.12, sky: 0.8 };
      const sides = island || C.span === 'all' ? [0, 1] : [p.sideV > 0 ? 0 : 1];
      for (const a of sides) g.sweep(fr, (i, f) => { const v = vAt(a, f.u) + (a ? -0.08 : 0.08), y1 = top(a, f.u) - Math.max(thick, 0.55);
        return a === 0 ? [[v, y1, y1, mL], [v, y1 - 0.7, y1 - 0.7]] : [[v, y1 - 0.7, y1 - 0.7, mL], [v, y1, y1]]; });
    }
    if (C.clerestory) { const vb = (u) => p.sideV > 0 ? back(u) - 0.25 : back(u) + 0.25; z.m.glass.sweep(fr, (i, f) => [[vb(f.u), eave - 0.05], [vb(f.u), top(p.sideV > 0 ? 1 : 0, f.u) - thick]]); z.m.glass.sweep(fr, (i, f) => [[vb(f.u), eave - 0.05], [vb(f.u), top(p.sideV > 0 ? 1 : 0, f.u) - thick]], true); }
    // posts (and transverse beams under the roof at each post line)
    const PS = C.posts || { shape: 'rect', col: 0x4a3a2c, size: 0.3, spacing: 9, where: 'centre' };
    const where = PS.where || 'centre';
    const postV = (u) => { if (where === 'both') return [vA(u) + 0.6, vB(u) - 0.6]; if (where === 'back' || !island) return [p.sideV > 0 ? back(u) - 0.35 : island ? (p.eL(u) + p.eR(u)) / 2 : back(u) + 0.35]; return [(p.eL(u) + p.eR(u)) / 2]; };
    const spacing = PS.spacing || 9;
    for (let u = u0 + spacing / 2; u < u1; u += spacing) {
      if (inGroups(p, u, 0.8)) continue;
      for (const v of postV(u)) {
        const a = (v - vA(u)) / Math.max(0.1, vB(u) - vA(u)); const yTop = top(U.clamp(a, 0, 1), u) - thick;
        T.place(g, u, v, yP); g.mat(PS.col || 0x4a3a2c, PS.kind ?? K.PAINT, 0.12);
        if (PS.shape === 'round') { g.cyl(0, 0, 0, PS.size / 2, PS.size / 2, yTop - yP, 16, false); if (PS.rings) for (let y = 0.4; y < yTop - yP; y += 0.45) g.cyl(0, y, 0, PS.size / 2 + 0.03, PS.size / 2 + 0.03, 0.08, 16, false);
          if (PS.capital !== undefined) { g.mat(PS.capital, K.CONCRETE, 0); g.cbox(0, yTop - yP - 0.35, 0, PS.size + 0.3, 0.35, PS.size + 0.3); } }
        else if (PS.shape === 'portal') { g.cbox(0, 0, -1.6, PS.size, yTop - yP, PS.size * 0.8); g.cbox(0, 0, 1.6, PS.size, yTop - yP, PS.size * 0.8); }
        else g.cbox(0, 0, 0, PS.size, yTop - yP, PS.size * (PS.depth ? PS.depth / PS.size : 1.2));
        g.pop();
      }
      // transverse beam under the roof
      const va = vA(u), vb = vB(u); const yb = Math.min(top(0, u), top(1, u)) - thick;
      if (style !== 'gull' && style !== 'barrel' && style !== 'humps' && style !== 'wave') { T.place(g, u, (va + vb) / 2, yb - 0.3); g.mat(PS.col || 0x4a3a2c, K.PAINT, 0); g.cbox(0, 0, 0, 0.22, 0.3, vb - va - 0.1); g.pop(); }
      if (style === 'frames') {       // portal frames straddling the tracks, X-braced along the outer edges
        const vl = T.edgeV(u, -1) + 0.4, vr = T.edgeV(u, 1) - 0.4; T.place(g, u, 0, 0); g.pop();
        for (const v of [vl, vr]) { T.place(g, u, v, T.yRail - 0.6); g.mat(C.frame || 0x7a4527, K.PAINT, 0); g.cbox(0, 0, 0, 0.35, eave + 0.9 - (T.yRail - 0.6), 0.35); g.pop(); }
        T.place(g, u, (vl + vr) / 2, eave + 0.6); g.mat(C.frame || 0x7a4527, K.PAINT, 0); g.cbox(0, 0, 0, 0.35, 0.5, vr - vl); g.pop();
      }
    }
    // light strips under the roof + line lights
    const LC = S.light, I = S.lightI;
    const offs = island || C.span === 'all' ? [0.28, 0.72] : [0.5];
    for (const a of offs) {
      const v = (u) => vAt(a, u); const y = (u) => top(a, u) - thick - 0.04;
      z.m.glow.mat(LC); z.m.glow.sweep(fr, (i, f) => [[v(f.u) - 0.07, y(f.u)], [v(f.u) + 0.07, y(f.u)]], true);
      const f0 = T.frameAt(u0 + 1), f1 = T.frameAt(u1 - 1); const ym = y((u0 + u1) / 2);
      z.lights.add({ a: [f0.x - f0.tz * v(u0 + 1), ym, f0.z + f0.tx * v(u0 + 1)], b: [f1.x - f1.tz * v(u1 - 1), ym, f1.z + f1.tx * v(u1 - 1)], color: LC.map(k => k * I), range: 22, radius: 0.07, dir: [0, -1, 0], focus: 1 });
    }
    // open ends beyond the roof
    yield* platformEnds(T, p, u0, u1);
    void gd;
  }
  // what stands on the uncovered platform ends: a central beam on posts, T- or L-frames, light poles, pergola frames
  function* platformEnds(T, p, cu0, cu1) {
    const { zones, S } = T; const z = zones[0], g = z.m.sk; const kind = T.H.ends || 'poles'; const island = p.kind === 'island';
    const col = T.H.endCol || T.H.poleCol || (T.H.canopy && T.H.canopy.posts && T.H.canopy.posts.col) || 0x4a4f55;
    const cv = (u) => island ? (p.eL(u) + p.eR(u)) / 2 : (p.sideV > 0 ? p.eR(u) - 0.5 : p.eL(u) + 0.5);
    const LC = S.light, I = S.lightI * 0.8;
    for (const [a, b] of [[p.u0 + 2, cu0 - 1], [cu1 + 1, p.u1 - 2]]) {
      if (b - a < 6) continue;
      const lights = [];
      for (let u = a + 3; u <= b - 1; u += kind === 'poles' ? 12 : 9) {
        if (inGroups(p, u, 0.8)) continue; const v = cv(u);
        T.place(g, u, v, p.y); g.mat(col, K.PAINT, 0);
        if (kind === 'beam' || kind === 'pergola') { g.cbox(0, 0, 0, 0.25, 3.3, 0.25); }
        else if (kind === 'T') { g.cbox(0, 0, 0, 0.22, 3.4, 0.22); g.cbox(0, 3.3, 0, 0.18, 0.18, island ? (p.eR(u) - p.eL(u)) - 2 : 3); }
        else if (kind === 'L') { g.cbox(0, 0, 0, 0.22, 3.6, 0.22); g.cbox(0, 3.45, (p.sideV > 0 ? -1 : 1) * 1.4, 0.16, 0.16, 2.8); }
        else if (kind === 'wall') { g.pop(); continue; }
        else { g.cyl(0, 0, 0, 0.09, 0.12, 5.2, 10, false); g.cbox(0, 5.1, 0, 0.5, 0.18, 0.5); }
        g.pop(); lights.push(u);
      }
      if (kind === 'beam' || kind === 'pergola') { const fr = T.frames(a + 2, b - 1); g.mat(col, K.PAINT, 0); g.sweep(fr, (i, f) => { const v = cv(f.u); return [[v - 0.2, p.y + 3.3, null, { col: lin(col), kind: K.PAINT, sky: 0.9 }], [v - 0.2, p.y + 3.6, null, { col: lin(col), kind: K.PAINT, sky: 1 }], [v + 0.2, p.y + 3.6, null, { col: lin(col), kind: K.PAINT, sky: 0.9 }], [v + 0.2, p.y + 3.3], [v - 0.2, p.y + 3.3]]; }, true);
        z.m.glow.mat(LC); z.m.glow.sweep(fr, (i, f) => { const v = cv(f.u); return [[v - 0.12, p.y + 3.28], [v + 0.12, p.y + 3.28]]; }, true);
        if (kind === 'pergola') for (let u = a + 3; u <= b - 1; u += 9) { const va = p.eL(u) + 0.3, vb = p.eR(u) - 0.3; T.place(g, u, (va + vb) / 2, p.y + 3.6); g.mat(col, K.PAINT, 0); g.cbox(0, 0, 0, 0.2, 0.2, vb - va); g.pop(); } }
      if (lights.length) {
        const ya = p.y + (kind === 'poles' ? 5.1 : 3.3); const f0 = T.frameAt(lights[0]), f1 = T.frameAt(lights[lights.length - 1] + 0.01);
        const v0 = cv(lights[0]), v1 = cv(lights[lights.length - 1]);
        if (z.lights.lights.length < StationKit.MAXL) z.lights.add({ a: [f0.x - f0.tz * v0, ya, f0.z + f0.tx * v0], b: [f1.x - f1.tz * v1, ya, f1.z + f1.tx * v1], color: LC.map(k => k * I), range: 20, radius: 0.1, dir: [0, -1, 0], focus: 1 });
        if (kind === 'poles') for (const u of lights) { const [x, zz] = T.L2(u, cv(u)); z.m.glow.push().at(x, ya - 0.05, zz, 0); z.m.glow.mat(LC); z.m.glow.box(-0.22, -0.02, -0.22, 0.22, 0.0, 0.22); z.m.glow.pop(); }
      }
    }
    yield;
  }
  const inGroups = (p, u, pad) => (p.groups || []).some(g => u > Math.min(g.uFoot, g.uHead) - pad && u < Math.max(g.uFoot, g.uHead) + pad);

  // ------------------------------------------------------------------------------------------------ at grade / median / trench
  function* atGrade(T, type) {
    const { zones, yRail, boxU0, boxU1, frames, edgeV, M, plats } = T;
    const z = zones[0], g = z.m.sk;
    const fr = frames(boxU0, boxU1);
    const yTB = yRail - 0.6;
    const mBal = M([0x8a847a, K.BALLAST, 0], { sky: 1 });
    g.sweep(fr, (i, f) => { const vl = edgeV(f.u, -1); return [[vl - 1.5, yTB - 0.7, null, mBal], [vl, yTB, null, mBal], [vl + 0.3, yTB]]; });
    g.sweep(fr, (i, f) => { const vr = edgeV(f.u, 1); return [[vr - 0.3, yTB, null, mBal], [vr, yTB, null, mBal], [vr + 1.5, yTB - 0.7]]; });
    if (type === 'trench') {
      const mRW = M([0xa29d93, K.BOARDFORM, 0.15], { sky: 0.8 });
      for (const side of [-1, 1]) g.sweep(fr, (i, f) => { const v = edgeV(f.u, side) + side * 0.5; const top = U.clamp(Terrain.h(f.x - f.tz * v + T.OX, f.z + f.tx * v + T.OZ) + 1.1, yTB + 2, Math.max(yTB + 2.5, T.street + 1.2));
        return side < 0 ? [[v, top, top, mRW], [v, yTB, yTB]] : [[v, yTB, yTB, mRW], [v, top, top]]; });
    }
    if (type === 'median') {
      const mBar = M([0xb9b4a9, K.CONCRETE, 0], { sky: 1 });
      for (const side of [-1, 1]) g.sweep(fr, (i, f) => { const v = edgeV(f.u, side) + side * 1.2;
        return side < 0 ? [[v - 0.4, yTB, null, mBar], [v - 0.3, yTB + 1.07, null, mBar], [v + 0.3, yTB + 1.07, null, mBar], [v + 0.4, yTB]].reverse().map((p, k, R) => [p[0], p[1], null, R[k + 1] ? mBar : undefined])
          : [[v - 0.4, yTB, null, mBar], [v - 0.3, yTB + 1.07, null, mBar], [v + 0.3, yTB + 1.07, null, mBar], [v + 0.4, yTB]]; });
    }
    for (const p of plats) yield* canopy(T, p);
    yield;
  }

  // ------------------------------------------------------------------------------------------------ inlays and columns
  function* floorInlays(T) {
    const { plats, H, zones } = T;
    if (H.bands === undefined && H.grid === undefined) return;
    for (const p of plats) {
      const g = (p.zone || zones[0]).d.sk;
      const col = lin(H.bands !== undefined ? H.bands : H.grid);
      const mat = { col, kind: K.TILE, prm: -0.2, sky: T.under ? 0 : 0.8 };
      // bands across the platform every 6 m (and, for a grid, two longitudinal lines)
      for (let u = p.u0 + 3; u < p.u1 - 1; u += 6) {
        const a = p.eL(u) + TAC + 0.1, b = p.eR(u) - TAC - 0.1; if (b - a < 1) continue;
        const f = T.frameAt(u); const P = (v, du) => [f.x - f.tz * v + f.tx * du, p.y + 0.004, f.z + f.tx * v + f.tz * du]; g.set(mat);
        g.quad(P(a, -0.2), P(a, 0.2), P(b, 0.2), P(b, -0.2), [a, -0.2, a, 0.2, b, 0.2, b, -0.2]);
      }
      if (H.grid !== undefined || T.st.id === 'ORIN') {
        const fr = T.frames(p.u0 + 1, p.u1 - 1);
        for (const off of [TAC + 0.15, -(TAC + 0.15)]) g.sweep(fr, (i, f) => { const v = off > 0 ? p.eL(f.u) + off : p.eR(f.u) + off; return [[v - 0.15, p.y + 0.004, null, mat], [v + 0.15, p.y + 0.004]]; });
      }
      yield;
    }
  }
  function* platformColumns(T) {
    const { plats, H, zones, S } = T; const C = H.cols;
    for (const p of plats) {
      if (p.kind !== 'island') continue;
      const g = (p.zone || zones[0]).m.sk; const colTop = p.level && p.level.k ? p.level.ceilY : T.ceilY;
      for (let u = p.u0 + 6; u < p.u1 - 4; u += C.along) {
        if (inGroups(p, u, 1.2)) continue;
        const c = (p.eL(u) + p.eR(u)) / 2; const vs = C.rows === 2 ? [c - C.across / 2, c + C.across / 2] : [c];
        for (const v of vs) {
          T.place(g, u, v, p.y); g.mat(C.col, C.kind ?? K.CONCRETE, C.kind === K.BRICK ? 1 : 0.12);
          if (C.shape === 'round') { g.cyl(0, 0, 0, C.size / 2, C.size / 2, colTop - p.y, 24, false); g.mat(0x2a2a2a, K.PAINT); g.cyl(0, 0, 0, C.size / 2 + 0.02, C.size / 2 + 0.02, 0.12, 24, false); }
          else g.cbox(0, 0, 0, C.depth || C.size, colTop - p.y, C.size);
          g.pop();
          T.occupied.push({ p, u0: u - 0.8, u1: u + 0.8, v0: v - 0.8, v1: v + 0.8 });
        }
      }
      yield;
    }
    void S;
  }

  // ------------------------------------------------------------------------------------------------ circulation
  function* buildCirculation(T) {
    const { plats, mode, zones, S, M, frames, place } = T;
    if (mode === 'ends' || !T.rise || T.rise < 1.5) { yield* platformEndsAccess(T); return; }
    // the concourse zone
    const zC = new Zone('conc', { under: T.under, amb: T.under ? S.amb : [0.03, 0.03, 0.03] }); zones.push(zC); T.zC = zC;
    // escalator + stair groups on each platform (in its level's zone; a stacked station's lower banks climb to the
    // platform over them)
    for (const p of plats) for (const g of p.groups || []) {
      const zP = p.zone || zones[0];
      const B = zP.d; const up = !g.down;
      let v = g.vc - g.gw / 2;
      for (let k = 0; k < g.kinds.length; k++) {
        const w = g.widths[k]; const vcen = v + w / 2; v += w + 0.25;
        // the part runs from its foot (lower end) toward its head
        const uFoot = up ? g.uFoot : g.uFoot, dirRun = up ? g.dir : (g.uHead > g.uFoot ? 1 : -1);
        const yFoot = up ? p.y : T.yCF;
        const yaw = dirRun > 0 ? 0 : Math.PI;
        if (g.kinds[k] === 'esc') {
          const escUp = k === 0 ? 1 : -1;       // one up, one down
          T.placeB(zP.m, uFoot, vcen, yFoot, yaw); const e = SP.escalator(zP.m, g.H, { glass: T.S !== STYLE.sub70 && T.S !== STYLE.air70 }); T.popB(zP.m);
          const [lx, lz] = T.L2(uFoot, vcen); T.esc.push({ x: lx, y: yFoot, z: lz, yaw: T.yawAt(uFoot) + yaw, H: g.H, dir: escUp, phase: k * 0.13 });
          // walk: the escalator is a slope between its combs; its balustrades are walls
          slopeUV(T, uFoot, dirRun, vcen, 0.5, yFoot, g.H, e.run);
          wallsUV(T, uFoot, dirRun, vcen, SP.ESC.OW / 2, yFoot, e.run, g.H);
        } else {
          T.placeB(zP.m, uFoot, vcen, yFoot, yaw); const r = SP.stairs(zP.m, g.H, { W: w, cheeks: 'stringer', treadCol: lin(S.tread || 0xa39e95) }); T.popB(zP.m);
          slopeUV(T, uFoot, dirRun, vcen, w / 2 - 0.1, yFoot, g.H, r.run);
          wallsUV(T, uFoot, dirRun, vcen, w / 2, yFoot, r.run, g.H);
        }
      }
      // guard railings around the opening on the upper level (three sides; the head end is open)
      const u0 = Math.min(g.uFoot, g.uHead), u1 = Math.max(g.uFoot, g.uHead);
      const yUp = g.yUp ?? (up ? T.yCF : p.y); const hv0 = g.vc - g.gw / 2 - 0.3, hv1 = g.vc + g.gw / 2 + 0.3;
      // (the rail runs along the opening in the floor above: over a deep inclined well only its last part is open)
      const hTop = up ? (g.upPlat ? g.upPlat.holes : T.ceilHoles || []).find(h => h.g === g) : null;
      const uOpen = g.uHead, uClosed = up ? (hTop ? (g.dir > 0 ? (hTop.cu0 ?? hTop.u0) : (hTop.cu1 ?? hTop.u1)) : (g.dir > 0 ? u0 + 2 : u1 - 2)) : g.uFoot;
      const railPts = (vv) => { const pts = []; const ua = Math.min(uOpen, uClosed), ub = Math.max(uOpen, uClosed); for (let u = ua; u <= ub + 1e-6; u += 2) { const [x, z] = T.L2(Math.min(u, ub), vv); pts.push([x, yUp, z]); } return pts; };
      const zR = g.upPlat ? (g.upPlat.zone || zones[0]) : up ? zC : zP;
      SP.railing(zR.d, railPts(hv0), 1.07, 'glass'); SP.railing(zR.d, railPts(hv1), 1.07, 'glass');
      { const [x0, z0] = T.L2(uClosed, hv0), [x1, z1] = T.L2(uClosed, hv1); SP.railing(zR.d, [[x0, yUp, z0], [x1, yUp, z1]], 1.07, 'glass'); }
      for (const vv of [hv0, hv1]) { const a = T.WUV(Math.min(uOpen, uClosed), vv), b = T.WUV(Math.max(uOpen, uClosed), vv); addWall(T.walk, a, b, yUp - 0.5, yUp + 2.5); }
      addWall(T.walk, T.WUV(uClosed, hv0), T.WUV(uClosed, hv1), yUp - 0.5, yUp + 2.5);
      // direction signs over the group's foot
      zP.signs.push({ u: g.uFoot - (up ? g.dir : 0) * 1.5, v: g.vc, y: p.y + 2.9, yaw: T.yawAt(g.uFoot) + (g.dir > 0 ? Math.PI / 2 + Math.PI / 2 : 0), w: 2.4, h: 0.6, region: 'exit', both: false, T });
      T.occupied.push({ p, u0: u0 - 1.5, u1: u1 + 1.5, v0: g.vc - g.gw / 2 - 0.6, v1: g.vc + g.gw / 2 + 0.6 });
      yield;
    }
    if (mode === 'above') yield* subwayConcourse(T);
    else if (mode === 'below') yield* concourseBelow(T);
    else yield* footbridge(T);
  }
  // walk slope for a run: foot at (uFoot, v), rising dirRun along u by H over run (half width hw)
  function slopeUV(T, uFoot, dirRun, vc, hw, yFoot, H, run) {
    const ua = uFoot, ub = uFoot + dirRun * run;
    const c = [[ua, vc - hw, yFoot], [ub, vc - hw, yFoot + H], [ub, vc + hw, yFoot + H], [ua, vc + hw, yFoot]];
    addSlope(T.walk, c.map(([u, v, y]) => { const [x, z] = T.WUV(u, v); return [x, z, y]; }));
  }
  function wallsUV(T, uFoot, dirRun, vc, hw, yFoot, run, H) {
    for (const vv of [vc - hw, vc + hw]) addWall(T.walk, T.WUV(uFoot, vv), T.WUV(uFoot + dirRun * run, vv), yFoot - 1, yFoot + H + 2.5);
  }

  // ---------------------------------------------------------------- subway concourse (mezzanine above the platforms)
  function* subwayConcourse(T) {
    const { S, M, frames, frameAt, edgeV, zC, place, walk, W2, yCF, yCC, pu0, pu1, uc } = T;
    const g = zC.m.sk;
    const cu0 = T.cu0, cu1 = T.cu1;            // pu0 + 12 .. pu1 - 12 (groundPlan)
    const vl = (u) => edgeV(u, -1), vr = (u) => edgeV(u, 1);
    const holes = T.ceilHoles.map(h => ({ u0: h.cu0 ?? h.u0, u1: h.cu1 ?? h.u1, v0: h.v0, v1: h.v1 }));
    // entrances (planned in groundPlan): shafts inside the box footprint pass through the concourse ceiling and roof
    const roofHoles = T.entPlan.filter(e => e.inBox).map(e => ({ u0: Math.min(e.uTop, e.uBot) - 0.3, u1: Math.max(e.uTop, e.uBot) + 0.3, v0: e.ve - e.W / 2 - 0.25, v1: e.ve + e.W / 2 + 0.25 }));
    T.roofHoles = roofHoles;
    // floor (with the wells), ceiling, walls, end walls
    slab(T, g, cu0, cu1, vl, vr, yCF, holes, M(S.cFloor), true);
    const vault = T.H.vault === 'ribs' && !roofHoles.length && yCC - yCF > 3.2;
    if (vault) yield* vaultCeiling(T, g, cu0, cu1, vl, vr, yCC);
    else slab(T, g, cu0, cu1, vl, vr, yCC, roofHoles, M(S.cCeil), false);
    for (const h of roofHoles) holeRim(T, g, h, yCC, yCC + 0.9, M(S.cWall));
    if (T.H.mural) yield* tileMurals(T, zC, cu0, cu1, vl, vr, yCF);
    const fr = frames(cu0, cu1);
    const mW = M(S.cWall), mL = M(S.wallLow);
    g.sweep(fr, (i, f) => { const v = vl(f.u); return [[v, yCC, yCC, mW], [v, yCF + 0.15, yCF + 0.15, mL], [v, yCF, yCF]]; });
    g.sweep(fr, (i, f) => { const v = vr(f.u); return [[v, yCF, yCF, mL], [v, yCF + 0.15, yCF + 0.15, mW], [v, yCC, yCC]]; });
    for (const [ue, dir] of [[cu0, -1], [cu1, 1]]) {
      const f = frameAt(ue); const a = vl(ue), b = vr(ue); const P = (v, y) => [f.x - f.tz * v, y, f.z + f.tx * v]; g.set(mW);
      if (dir > 0) g.quad(P(b, yCF), P(a, yCF), P(a, yCC), P(b, yCC), [b, yCF, a, yCF, a, yCC, b, yCC]); else g.quad(P(a, yCF), P(b, yCF), P(b, yCC), P(a, yCC), [a, yCF, b, yCF, b, yCC, a, yCC]);
      addWall(walk, W2(...[P(a, 0)[0], P(a, 0)[2]]), W2(...[P(b, 0)[0], P(b, 0)[2]]), yCF - 1, yCC);
    }
    for (let i = 0; i + 1 < fr.length; i++) {
      const f0 = fr[i], f1 = fr[i + 1];
      for (const side of [-1, 1]) { const v0 = edgeV(f0.u, side), v1 = edgeV(f1.u, side); addWall(walk, W2(f0.x - f0.tz * v0, f0.z + f0.tx * v0), W2(f1.x - f1.tz * v1, f1.z + f1.tx * v1), yCF - 1, yCC); }
      // floor strips minus the wells
      const inside = holes.filter(h => f1.u > h.u0 && f0.u < h.u1);
      const vs = [[vl(f0.u), vr(f0.u)]]; for (const h of inside) { const out = []; for (const [a, b] of vs) { if (h.v1 <= a || h.v0 >= b) out.push([a, b]); else { if (h.v0 > a) out.push([a, h.v0]); if (h.v1 < b) out.push([h.v1, b]); } } vs.splice(0, vs.length, ...out); }
      for (const [a, b] of vs) addFloor(walk, [[f0.x - f0.tz * a, f0.z + f0.tx * a], [f1.x - f1.tz * a, f1.z + f1.tx * a], [f1.x - f1.tz * b, f1.z + f1.tx * b], [f0.x - f0.tz * b, f0.z + f0.tx * b]].map(([x, z]) => W2(x, z)), yCF);
    }
    // fare gate arrays between the paid middle (over the platform wells) and the unpaid ends, agent booths, TVMs
    const wells = T.ceilHoles.map(h => [h.u0, h.u1]);
    const paid0 = wells.length ? Math.min(...wells.map(w => w[0])) - 6 : uc - 20, paid1 = wells.length ? Math.max(...wells.map(w => w[1])) + 6 : uc + 20;
    for (const [ug, face] of [[Math.max(cu0 + 6, paid0), -1], [Math.min(cu1 - 6, paid1), 1]]) {
      const a = vl(ug), b = vr(ug); const width = b - a; const nG = U.clamp(Math.floor((width - 6) / 0.86), 4, 12);
      const arrW = nG * 0.86 + 0.6; const v0 = (a + b) / 2 - arrW / 2;
      // gates: local +X = paid side; face -1 -> paid side is +u
      T.placeB(zC.d, ug, v0, yCF, face < 0 ? 0 : Math.PI); SP.fareGates(zC.d, nG); T.popB(zC.d);
      // fixed barriers (glass) from the walls to the gate array
      for (const [va, vb] of [[a, v0], [v0 + arrW, b]]) { const [x0, z0] = T.L2(ug, va + 0.1), [x1, z1] = T.L2(ug, vb - 0.1); SP.railing(zC.d, [[x0, yCF, z0], [x1, yCF, z1]], 1.25, 'glass'); addWall(walk, W2(x0, z0), W2(x1, z1), yCF - 0.5, yCF + 2.5); }
      // gate cabinets as walls (aisles stay open in walk mode)
      // agent booth on the unpaid side next to the array
      T.placeB(zC.d, ug - face * 3.5, b - 2.4, yCF, 0); SP.agentBooth(zC.d, { w: 3.0, d: 2.2 }); T.popB(zC.d);
      // TVMs on the side wall in the unpaid area
      for (let k = 0; k < 4; k++) { const u = ug - face * (8 + k * 1.22); T.placeB(zC.d, u, a + 0.02, yCF, -Math.PI / 2); SP.tvm(zC.d); T.popB(zC.d); }
      zC.signs.push({ u: ug - face * 0.6, v: (a + b) / 2, y: yCF + 2.7, yaw: T.yawAt(ug) + (face < 0 ? Math.PI / 2 * 0 + Math.PI : 0), w: 2.8, h: 0.7, region: 'gates', both: true, T });
      yield;
    }
    T.concZone = { y: yCF, u0: cu0 + 2, u1: cu1 - 2, vl, vr, holes: holes.map(h => ({ u0: h.u0, u1: h.u1, v0: h.v0, v1: h.v1 })) };
    // lights: rows of troughs along the concourse ceiling
    const LC = S.light, I = S.lightI * 0.85; const f0 = frameAt(cu0 + 2), f1 = frameAt(cu1 - 2); const vm = (vl(uc) + vr(uc)) / 2, hw = (vr(uc) - vl(uc)) / 2;
    for (const off of [-0.5, 0, 0.5]) {
      const v = vm + off * hw;
      zC.lights.add({ a: [f0.x - f0.tz * v, yCC - 0.15, f0.z + f0.tx * v], b: [f1.x - f1.tz * v, yCC - 0.15, f1.z + f1.tx * v], color: LC.map(c => c * I), range: 20, radius: 0.1, dir: [0, -1, 0], focus: 1 });
      zC.m.glow.mat(LC); zC.m.glow.sweep(frames(cu0 + 2, cu1 - 2), (i, f) => [[v - 0.12, yCC - 0.06], [v + 0.12, yCC - 0.06]], true);
    }
    // name panels on the concourse walls, maps
    for (let u = cu0 + 10; u < cu1 - 8; u += 30) for (const side of [-1, 1]) { const v = edgeV(u, side) - side * 0.03; zC.signs.push({ u, v, y: yCF + 2.2, yaw: T.yawAt(u) + (side < 0 ? Math.PI : 0), w: 4.3, h: 0.8, region: 'name', both: false, T }); }
    { const u = uc + 3; zC.signs.push({ u, v: vl(u) + 0.03, y: yCF + 1.5, yaw: T.yawAt(u) + Math.PI, w: 2.4, h: 1.0, region: 'map', both: false, T }); }
    // cell: the concourse footprint
    const poly = []; for (const f of fr) { const v = vl(f.u) - 0.5; poly.push([f.x - f.tz * v, f.z + f.tx * v]); } for (let i = fr.length - 1; i >= 0; i--) { const f = fr[i]; const v = vr(f.u) + 0.5; poly.push([f.x - f.tz * v, f.z + f.tx * v]); }
    // (the cell stays half a metre under the lowest ground over it: the terrain drops fragments inside cell volumes)
    T.cells.push({ zone: 'conc', under: { id: `st:${T.st.id}:conc`, kind: 'station', poly: poly.map(([x, z]) => W2(x, z)), floor: yCF - 0.5, ceil: Math.min(yCC + 0.9, minGround(T, cu0, cu1, vl, vr) - 0.5), ambient: ambOf(S) } });
    for (const h of holes) { const q = [[h.u0, h.v0], [h.u1, h.v0], [h.u1, h.v1], [h.u0, h.v1]].map(([u, v]) => { const [x, z] = T.WUV(u, v); return [x, yCF, z]; }); T.portals.push({ a: `st:${T.st.id}:plat`, b: `st:${T.st.id}:conc`, quad: q, day: 0 }); }
    // roof slab over the concourse
    slab(T, g, cu0, cu1, (u) => vl(u) - 0.5, (u) => vr(u) + 0.5, yCC + 0.9, roofHoles, M([0x77746e, K.CONCRETE]), true);
    yield* streetEntrances(T, cu0, cu1);
  }

  // 16th/24th St: a segmental vault of wood slats between cream precast arch ribs on splayed brackets, lit along the ribs
  function* vaultCeiling(T, g, cu0, cu1, vl, vr, yCC) {
    const { S, M, frames, zC } = T; const rise = 1.1, spring = yCC - rise;
    const mS = M(S.cCeil), mR = M([0xd9cfb8, K.CONCRETE, 0]);
    const arc = (u, t) => { const a = vl(u), b = vr(u); return [a + (b - a) * t, spring + rise * Math.sin(Math.PI * t)]; };
    const N = 10;
    g.sweep(frames(cu0, cu1), (i, f) => { const P = []; for (let k = N; k >= 0; k--) { const [v, y] = arc(f.u, k / N); P.push([v, y, null, k > 0 ? mS : undefined]); } return P; });
    // ribs every 3.2 m: a deeper band under the vault, springing from splayed brackets on the walls
    for (let u = cu0 + 1.6; u < cu1 - 1; u += 3.2) {
      const fr = frames(u - 0.18, u + 0.18);
      // the rib's underside (facing down: traversed right to left) and its two faces across u
      g.sweep(fr, (i, f) => { const P = []; for (let k = N; k >= 0; k--) { const [v, y] = arc(f.u, k / N); P.push([v, y - 0.32, null, k > 0 ? mR : undefined]); } return P; });
      g.set(mR);
      for (const [uu, face] of [[u - 0.18, -1], [u + 0.18, 1]]) {
        const ff = T.frameAt(uu); const W3 = (v, y) => [ff.x - ff.tz * v, y, ff.z + ff.tx * v];
        for (let k = 0; k < N; k++) { const [v0, y0] = arc(uu, k / N), [v1, y1] = arc(uu, (k + 1) / N);
          const q = [W3(v0, y0 - 0.32), W3(v1, y1 - 0.32), W3(v1, y1), W3(v0, y0)];
          if (face > 0) g.quad(q[0], q[1], q[2], q[3], [v0, 0, v1, 0, v1, 0.32, v0, 0.32]); else g.quad(q[1], q[0], q[3], q[2], [v1, 0, v0, 0, v0, 0.32, v1, 0.32]); }
      }
      for (const side of [0, 1]) { const [v, y] = arc(u, side); T.place(g, u, v + (side ? -0.25 : 0.25), y - 0.9, 0); g.mat(0xd9cfb8, K.CONCRETE, 0); g.cbox(0, 0, 0, 0.36, 0.9, 0.5); g.pop(); }
    }
    const LC = S.light; const f0 = T.frameAt(cu0 + 1), f1 = T.frameAt(cu1 - 1);
    for (const t of [0.22, 0.78]) { const [va, ya] = arc(cu0 + 1, t), [vb, yb] = arc(cu1 - 1, t);
      zC.lights.add({ a: [f0.x - f0.tz * va, ya - 0.4, f0.z + f0.tx * va], b: [f1.x - f1.tz * vb, yb - 0.4, f1.z + f1.tx * vb], color: LC.map(c => c * 1.1), range: 18, radius: 0.1, dir: [0, -1, 0], focus: 0 }); }
    yield;
  }
  // Janet Bennett-style tile murals on the concourse walls: panels of small glazed tiles in the station's palette, laid in
  // flowing bands (a serpentine at 24th St)
  function* tileMurals(T, zC, cu0, cu1, vl, vr, yCF) {
    const pal = T.H.mural.map(c => lin(c)); const g = zC.d.sk;
    for (let u0 = cu0 + 6; u0 < cu1 - 8; u0 += 14) {
      for (const side of [-1, 1]) {
        for (let du = 0; du < 7.2; du += 0.6) for (let y = 0.9; y < 2.7; y += 0.6) {
          const u = u0 + du; const v = side < 0 ? vl(u) + 0.012 : vr(u) - 0.012; const f = T.frameAt(u);
          const k = Math.floor(pal.length * (0.5 + 0.5 * Math.sin(du * 0.55 + y * 1.3 + u0 * 0.7 + side))) % pal.length;
          g.mat(pal[k], K.MOSAIC, 0.05);
          const P = (uu, yy) => { const ff = T.frameAt(uu); const vv = side < 0 ? vl(uu) + 0.012 : vr(uu) - 0.012; return [ff.x - ff.tz * vv, yCF + yy, ff.z + ff.tx * vv]; };
          const q = [P(u, y), P(u + 0.6, y), P(u + 0.6, y + 0.6), P(u, y + 0.6)];
          if (side > 0) g.quad(q[1], q[0], q[3], q[2], [u + 0.6, y, u, y, u, y + 0.6, u + 0.6, y + 0.6]); else g.quad(q[0], q[1], q[2], q[3], [u, y, u + 0.6, y, u + 0.6, y + 0.6, u, y + 0.6]);
          void f; void v;
        }
      }
      yield;
    }
  }

  // ---------------------------------------------------------------- street entrances (subway)
  // Every entrance from the data (deduplicated) becomes a stair shaft on the sidewalk, running along the station
  // axis and descending toward the concourse; entrances beside the box get a short passage through its wall.
  // where each entrance goes: a stair shaft on the sidewalk running along the station axis toward the concourse
  function planEntrances(T, cu0, cu1) {
    const { st, edgeV, yCF, street } = T; const out = []; const W = 3.0;
    for (const e of dedupeEntrances(st.data.entrances || []).slice(0, 10)) {
      const uv = toUV(T, e.x - T.OX, e.z - T.OZ); if (!uv) continue;
      let [ue, ve] = uv; const inBox = ve > edgeV(ue, -1) + 1.8 && ve < edgeV(ue, 1) - 1.8;
      const dir = ue > T.uc ? -1 : 1;
      const gy = Terrain.h(...T.WUV(ue, ve)); const topY = Math.max(gy, street - 1.5); const riseE = topY - yCF; if (riseE < 1.5) continue;
      const runE = stairRun(riseE);
      let uTop = ue, uBot = ue + dir * runE;
      if (uBot < cu0 + 2 || uBot > cu1 - 2) { const shift = uBot < cu0 + 2 ? cu0 + 2 - uBot : cu1 - 2 - uBot; uTop += shift; uBot += shift; }
      // shafts that would overlap one already planned are dropped (duplicated corners, both sides of one exit)
      if (out.some(o => Math.abs(o.ve - ve) < W + 0.6 && Math.min(o.uTop, o.uBot) < Math.max(uTop, uBot) + 1 && Math.min(uTop, uBot) < Math.max(o.uTop, o.uBot) + 1)) continue;
      out.push({ e, ue, ve, dir, uTop, uBot, topY, riseE, runE, inBox, W });
    }
    return out;
  }
  // Every entrance becomes a stair shaft on the sidewalk, descending along the station axis to the concourse; entrances
  // beside the box get a short passage through its wall. Each is a Under cell with portals to the street and the concourse.
  function* streetEntrances(T, cu0, cu1) {
    const { st, S, M, walk, yCF, yCC } = T;
    T.entrances = [];
    const zE = new Zone('ent', { under: false, amb: [0.02, 0.02, 0.02] }); T.zones.push(zE);
    const g = zE.m.sk;
    let k = 0;
    for (const P of T.entPlan || []) {
      const { e, ve, dir, uTop, uBot, topY, riseE, runE, inBox, W } = P;
      // (a shallow station's end shafts land on the platform, pass the box roof and open into the platform's cell)
      const yCF = P.yBot ?? T.yCF, roofTop = P.roofY ?? (yCC + 0.9), link = P.link || 'conc';
      const yaw = dir > 0 ? 0 : Math.PI;
      T.placeB(zE.m, uBot, ve, yCF, yaw + Math.PI); SP.stairs(zE.m, riseE, { W, cheeks: 'wall', wallH: 1.1, wallCol: lin(S.cWall[0]), wallKind: S.cWall[1], wallPrm: S.cWall[2], treadCol: lin(0x9a968e) }); T.popB(zE.m);
      slopeUV(T, uBot, -dir, ve, W / 2 - 0.1, yCF, riseE, runE);
      wallsUV(T, uBot, -dir, ve, W / 2, yCF, runE, riseE);
      const ua = Math.min(uTop, uBot), ub = Math.max(uTop, uBot);
      // shaft walls above the stair cheeks up to the street, the sloped soffit over the lower part
      for (const side of [-1, 1]) {
        const vv = ve + side * (W / 2 + 0.2);
        g.sweep(T.frames(ua - 0.3, ub + 0.3), (i, f) => { const t = U.clamp((f.u - uBot) / (uTop - uBot), 0, 1); const yb = yCF + riseE * t + 1.1; const yt = Math.max(yb + 0.3, topY + 0.02);
          const mat = Object.assign(M(S.cWall), { sky: t });
          return side < 0 ? [[vv, yt, yt, mat], [vv, yb, yb]] : [[vv, yb, yb, mat], [vv, yt, yt]]; });
      }
      g.sweep(T.frames(ua, ub), (i, f) => { const t = U.clamp((f.u - uBot) / (uTop - uBot), 0, 1); const y = Math.min(yCF + riseE * t + 3.2, topY - 0.05);
        if (y >= topY - 0.1 || (inBox && y < roofTop)) return [[ve + W / 2 + 0.2, y, null, 'skip'], [ve - W / 2 - 0.2, y]];
        return [[ve + W / 2 + 0.2, y, null, Object.assign(M(S.cCeil), { sky: t * 0.5 })], [ve - W / 2 - 0.2, y]]; });
      // a paved collar around the opening, draped on the ground: the ground cut is a raster (~1 m texels near the
      // camera, 4 m beyond), so its edge is ragged and would show the void under the street
      { const hu0 = ua, hu1 = ub, hv0 = ve - W / 2 - 0.2, hv1 = ve + W / 2 + 0.2, o = 3.0; const mPave = Object.assign(M([0xa8a49c, K.PAVING, 1.5]), { sky: 1 });
        const gyAt = (u, v) => { const [x, z] = T.WUV(u, v); return Math.max(Terrain.h(x, z), topY - 0.6) + 0.035; };
        const band = (ua0, ua1, va0, va1) => { const nu = Math.max(1, Math.ceil((ua1 - ua0) / 1.5)), nv = Math.max(1, Math.ceil((va1 - va0) / 1.5));
          for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const u0 = ua0 + (ua1 - ua0) * i / nu, u1 = ua0 + (ua1 - ua0) * (i + 1) / nu, v0 = va0 + (va1 - va0) * j / nv, v1 = va0 + (va1 - va0) * (j + 1) / nv;
            const P = (u, v) => { const [x, z] = T.L2(u, v); return [x, gyAt(u, v), z]; }; g.set(mPave);
            g.quad(P(u0, v1), P(u1, v1), P(u1, v0), P(u0, v0), [u0, v1, u1, v1, u1, v0, u0, v0]); } };
        band(hu0 - o, hu1 + o, hv1, hv1 + o); band(hu0 - o, hu1 + o, hv0 - o, hv0);            // along both sides
        band(hu0 - o, hu0, hv0, hv1); band(hu1, hu1 + o, hv0, hv1); }                          // across both ends
      // street: railings on three sides (glass under a canopy), the totem at the head
      const canopyEnt = !!T.H.canopyEnt && !P.link;
      for (const vv of [ve - W / 2 - 0.3, ve + W / 2 + 0.3]) { const pts = [[uBot, vv], [uTop - dir * 0.2, vv]].map(([u, v]) => { const [x, z] = T.L2(u, v); return [x, topY, z]; }); SP.railing(zE.d, pts, 1.07, canopyEnt ? 'glass' : 'bars'); }
      { const [x0, z0] = T.L2(uBot - dir * 0.1, ve - W / 2 - 0.3), [x1, z1] = T.L2(uBot - dir * 0.1, ve + W / 2 + 0.3); SP.railing(zE.d, [[x0, topY, z0], [x1, topY, z1]], 1.07, canopyEnt ? 'glass' : 'bars'); }
      if (canopyEnt) {
        // downtown canopy (2018-27): a thin flat white roof on slender posts over the head of the stair, glass sides, a
        // roll-down gate housing over the mouth, a stainless pylon with the station name and a live-display strip
        const Lc = Math.min(runE, 7.5), uA = uTop - dir * 0.9, uB = uTop + dir * Lc, hw = W / 2 + 0.55, yR = topY + 3.05;
        const ua2 = Math.min(uA, uB), ub2 = Math.max(uA, uB);
        { const [x, z] = T.L2((ua2 + ub2) / 2, ve); const gg = zE.m.sk; gg.push().at(x, 0, z, T.yawAt(uTop)); gg.mat(0xf2f1ec, K.PAINT); gg.box(-(ub2 - ua2) / 2, yR, -hw, (ub2 - ua2) / 2, yR + 0.16, hw);
          gg.mat(0xb9bec3, K.STEEL); gg.box(-(ub2 - ua2) / 2 - 0.02, yR - 0.06, -hw - 0.02, (ub2 - ua2) / 2 + 0.02, yR, -hw + 0.1); gg.box(-(ub2 - ua2) / 2 - 0.02, yR - 0.06, hw - 0.1, (ub2 - ua2) / 2 + 0.02, yR, hw + 0.02);
          gg.pop(); }
        for (const uu of [uA + dir * 0.3, uB - dir * 0.2]) for (const sv of [-1, 1]) { const [x, z] = T.L2(uu, ve + sv * (W / 2 + 0.3)); zE.d.sk.push().at(x, topY, z, 0); zE.d.sk.mat(0xb9bec3, K.STEEL); zE.d.sk.cyl(0, 0, 0, 0.055, 0.055, yR - topY, 10, false); zE.d.sk.pop(); }
        { const [x, z] = T.L2(uTop - dir * 0.35, ve); zE.d.sk.push().at(x, 0, z, T.yawAt(uTop)); zE.d.sk.mat(0x8f959a, K.STEEL); zE.d.sk.box(-0.22, yR - 0.5, -W / 2 - 0.3, 0.22, yR - 0.02, W / 2 + 0.3); zE.d.sk.pop(); }
        zE.m.glow.mat(S.light); { const [x, z] = T.L2((ua2 + ub2) / 2, ve); zE.m.glow.push().at(x, 0, z, T.yawAt(uTop)); zE.m.glow.box(-(ub2 - ua2) / 2 + 0.4, yR - 0.035, -0.12, (ub2 - ua2) / 2 - 0.4, yR - 0.005, 0.12); zE.m.glow.pop(); }
        // the pylon beside the mouth, facing the sidewalk
        const pu = uTop - dir * 1.2, pv = ve + W / 2 + 0.95; const [px, pz] = T.L2(pu, pv);
        zE.d.sk.push().at(px, topY, pz, T.yawAt(uTop)); zE.d.sk.mat(0xc3c8cc, K.STEEL); zE.d.sk.cbox(0, 0, 0, 0.62, 3.9, 0.34); zE.d.sk.mat(0x10263b, K.PAINT); zE.d.sk.cbox(0, 3.9, 0, 0.66, 0.08, 0.38); zE.d.sk.pop();
        zE.m.glow.mat(lin(0xffb030)); zE.m.glow.push().at(px, topY, pz, T.yawAt(uTop)); for (const sd of [-1, 1]) zE.m.glow.box(-0.24, 1.55, sd * 0.172 - 0.004, 0.24, 1.95, sd * 0.172 + 0.004); zE.m.glow.pop();
        zE.signs.push({ u: pu, v: pv, y: topY + 3.2, yaw: T.yawAt(uTop) + Math.PI / 2, w: 0.56, h: 0.7, region: 'totem', both: true, T });
        zE.lights.add({ a: (() => { const [x, z] = T.L2(ua2 + 0.5, ve); return [x, yR - 0.1, z]; })(), b: (() => { const [x, z] = T.L2(ub2 - 0.5, ve); return [x, yR - 0.1, z]; })(), color: S.light.map(c => c * 0.7), range: 7, radius: 0.08, dir: [0, -1, 0], focus: 1 });
      } else {
        const [tx, tz] = T.L2(uTop + dir * 0.9, ve + W / 2 + 0.7); zE.d.sk.push().at(tx, topY, tz, T.yawAt(uTop) + (dir > 0 ? 0 : Math.PI)); zE.d.sk.mat(0x10263b, K.PAINT); zE.d.sk.cbox(0, 0, 0, 0.14, 3.2, 0.9); zE.d.sk.pop();
        zE.signs.push({ u: uTop + dir * 0.9, v: ve + W / 2 + 0.7, y: topY + 2.55, yaw: T.yawAt(uTop) + (dir > 0 ? -Math.PI / 2 : Math.PI / 2), w: 0.8, h: 1.0, region: 'totem', both: true, T });
      }
      zE.signs.push({ u: uBot + dir * 0.5, v: ve, y: yCF + 2.6, yaw: T.yawAt(uBot) + (dir > 0 ? Math.PI : 0), w: 2.0, h: 0.5, region: 'exit', both: false, T });
      let door = null;
      if (!inBox) { const r = yield* passage(T, zE, uBot, ve, dir, W); door = r; }
      const [ax, az] = T.L2(uBot, ve), [bx, bz] = T.L2(uTop, ve);
      zE.lights.add({ a: [ax, yCF + 3.0, az], b: [bx, topY - 0.2, bz], color: S.light.map(c => c * 0.8), range: 12, radius: 0.08, dir: [0, -1, 0], focus: 1 });
      // Under: the sidewalk cut, the shaft cell (and its passage), portals to the street and to the concourse
      const rect = (u0, u1, v0, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => T.WUV(u, v));
      // (the cut is raster, ~1 m texels, and the shaft cell's volume (dilated ~1.5 texels) drops the ground over the
      // opening too; the collar covers the ragged rim)
      const cutPoly = rect(ua - 0.2, ub + 0.2, ve - W / 2 - 0.35, ve + W / 2 + 0.35);
      const gOpen = minGround(T, ua - 1.2, ub + 1.2, () => ve - W / 2 - 1.3, () => ve + W / 2 + 1.3);
      T.cuts.push({ id: `st:${st.id}:cut${k}`, poly: rect(ua - 0.5, ub + 0.5, ve - W / 2 - 0.6, ve + W / 2 + 0.6), below: Math.min(topY, gOpen) - 0.3 });
      const id = `st:${st.id}:ent${k}`;
      // (the cell stops under the street: the terrain drops fragments inside cell volumes, and the top of the stair is
      // simply outdoors; the cut opens the ground over the shaft)
      // the shaft: its opening, from the bottom up into the street (the portal to the outdoors lies inside it); a passage
      // to the concourse wall is its own cell, kept under the ground (the terrain drops fragments inside cell volumes)
      T.cells.push({ zone: 'ent', under: { id, kind: 'shaft', poly: cutPoly, floor: (inBox ? roofTop - 0.9 : yCF) - 0.3, ceil: topY + 3, ambient: 0.05, daylight: [yCF, topY] } });
      if (door) { const vW = T.edgeV(uBot, door.side); const va = Math.min(vW, ve), vb = Math.max(vW, ve);
        const gP = minGround(T, door.u0, door.u1, () => va, () => vb);
        T.cells.push({ zone: 'ent', under: { id: id + 'p', kind: 'station', poly: rect(door.u0 - 0.2, door.u1 + 0.2, va - 0.2, vb + 0.2), floor: yCF - 0.3, ceil: Math.min(yCF + door.h + 0.6, gP - 0.6), ambient: 0.4 } });
        const vM = ve - door.side * (W / 2 + 0.2);
        T.portals.push({ id: `st:${st.id}:pe${k}p`, a: id, b: id + 'p', quad: [[door.u0, yCF], [door.u1, yCF], [door.u1, yCF + door.h], [door.u0, yCF + door.h]].map(([u, y]) => { const [x, z] = T.WUV(u, vM); return [x, y, z]; }) }); }
      const quad = (y) => cutPoly.map(([x, z]) => [x, y, z]);
      T.portals.push({ id: `st:${st.id}:pe${k}o`, a: id, b: null, quad: quad(topY + 0.05) });
      if (inBox) T.portals.push({ id: `st:${st.id}:pe${k}c`, a: id, b: `st:${st.id}:${link}`, quad: rect(ua, ub, ve - W / 2 - 0.2, ve + W / 2 + 0.2).map(([x, z]) => [x, roofTop - 0.5, z]) });
      else if (door) { const vW = T.edgeV(uBot, door.side); T.portals.push({ id: `st:${st.id}:pe${k}c`, a: id + 'p', b: `st:${st.id}:conc`, quad: [[door.u0, yCF], [door.u1, yCF], [door.u1, yCF + door.h], [door.u0, yCF + door.h]].map(([u, y]) => { const [x, z] = T.WUV(u, vW); return [x, y, z]; }) }); }
      const [wx, wz] = T.WUV(uTop, ve); T.entrances.push({ wx, wz, name: e ? e.name : '' });
      k++;
      yield;
    }
  }
  // convex hull of [x, z] points (Andrew's monotone chain)
  function hull(pts) {
    const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = []; for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    const up = []; for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    lo.pop(); up.pop(); return lo.concat(up);
  }
  // passage from a shaft outside the box to the concourse wall (at concourse level)
  function* passage(T, zE, uBot, ve, dir, W) {
    const { S, M, edgeV, yCF, yCC, walk } = T;
    const side = ve > 0 ? 1 : -1; const vWall = edgeV(uBot, side); const g = zE.m.sk;
    const u0 = uBot - 1.8, u1 = uBot + 1.8; const h = Math.min(3.0, yCC - yCF);
    const vA = Math.min(vWall, ve), vB = Math.max(vWall, ve);
    // floor, ceiling, side walls of the passage (running across v)
    const P = (u, v, y) => { const [x, z] = T.L2(u, v); return [x, y, z]; };
    g.set(M(S.cFloor)); g.quad(P(u0, vA, yCF), P(u0, vB, yCF), P(u1, vB, yCF), P(u1, vA, yCF), [vA, u0, vB, u0, vB, u1, vA, u1].map((x, i) => x));
    g.set(M(S.cCeil)); g.quad(P(u0, vB, yCF + h), P(u0, vA, yCF + h), P(u1, vA, yCF + h), P(u1, vB, yCF + h), [0, 0, 1, 0, 1, 1, 0, 1]);
    g.set(M(S.cWall)); g.quad(P(u0, vA, yCF), P(u0, vA, yCF + h), P(u0, vB, yCF + h), P(u0, vB, yCF), [vA, yCF, vA, yCF + h, vB, yCF + h, vB, yCF]); g.quad(P(u1, vB, yCF), P(u1, vB, yCF + h), P(u1, vA, yCF + h), P(u1, vA, yCF), [vB, yCF, vB, yCF + h, vA, yCF + h, vA, yCF]);
    const q = [[u0, vA], [u1, vA], [u1, vB], [u0, vB]].map(([u, v]) => T.WUV(u, v)); addFloor(walk, q, yCF);
    addWall(walk, T.WUV(u0, vA), T.WUV(u0, vB), yCF - 0.5, yCF + h); addWall(walk, T.WUV(u1, vA), T.WUV(u1, vB), yCF - 0.5, yCF + h);
    // open the concourse wall: remove the walk wall segments there (the drawn wall stays for now: a doorway panel)
    for (let i = walk.walls.length - 1; i >= 0; i--) { const w = walk.walls[i]; const mid = [(w.x0 + w.x1) / 2, (w.z0 + w.z1) / 2]; const uv = toUV(T, mid[0] - T.OX, mid[1] - T.OZ);
      if (uv && uv[0] > u0 && uv[0] < u1 && Math.abs(uv[1] - vWall) < 0.3 && w.y0 < yCF + 1 && w.y1 > yCF + 1) walk.walls.splice(i, 1); }
    T.doors = T.doors || []; T.doors.push({ u0, u1, side, y0: yCF, y1: yCF + h });
    yield;
    return { u0, u1, side, h };
  }
  function dedupeEntrances(list) {
    const out = [];
    for (const e of list) { if (!isFinite(e.x) || !isFinite(e.z)) continue; const dup = out.find(o => Math.hypot(o.x - e.x, o.z - e.z) < 14); if (dup) { if (e.src === 'gtfs' && dup.src !== 'gtfs') Object.assign(dup, e); continue; } out.push(Object.assign({}, e)); }
    return out;
  }
  // station-local (x, z) -> (u, v) by projection onto the spine
  function toUV(T, x, z) {
    const S = T.plan.spine; let best = -1, bd = 1e18;
    for (let i = 0; i < S.length; i++) { const f = T.frameAt(S[i].u); const d = (f.x - x) ** 2 + (f.z - z) ** 2; if (d < bd) { bd = d; best = i; } }
    if (best < 0) return null; const f = T.frameAt(S[best].u); const du = (x - f.x) * f.tx + (z - f.z) * f.tz, dv = (x - f.x) * -f.tz + (z - f.z) * f.tx;
    return [S[best].u + du, dv];
  }

  // ---------------------------------------------------------------- aerial: concourse at ground level under the deck
  function* concourseBelow(T) {
    const { S, M, frames, frameAt, edgeV, zC, walk, W2, yCF, uc, plats, place } = T;
    const g = zC.m.sk;
    const cu0 = T.cu0, cu1 = T.cu1;            // around the groups' feet (groundPlan)
    const vl = (u) => edgeV(u, -1) - 1.5, vr = (u) => edgeV(u, 1) + 1.5;
    const yTop = Math.min(T.yCC, yCF + 4.2);
    slab(T, g, cu0, cu1, vl, vr, yCF, [], Object.assign(M(S.cFloor), { sky: 0.3 }), true);
    slab(T, g, cu0, cu1, vl, vr, yTop, [], Object.assign(M(S.cCeil), { sky: 0.2 }), false);
    // glass curtain walls with mullions (outdoor zone: lit by the sky)
    const fr = frames(cu0, cu1);
    for (const side of [-1, 1]) {
      const v = (u) => side < 0 ? vl(u) : vr(u);
      zC.m.glass.sweep(fr, (i, f) => [[v(f.u), yCF + 0.1], [v(f.u), yTop - 0.1]], side < 0);
      zC.m.glass.sweep(fr, (i, f) => [[v(f.u), yCF + 0.1], [v(f.u), yTop - 0.1]], side > 0);
      for (let i = 0; i < fr.length; i += 1) { const f = fr[i]; place(g, f.u, v(f.u), yCF, 0); g.mat(S.steel ? S.steel[0] : 0x3f464d, K.PAINT); g.cbox(0, 0, 0, 0.1, yTop - yCF, 0.12); g.pop(); }
      for (let i = 0; i + 1 < fr.length; i++) { const f0 = fr[i], f1 = fr[i + 1]; addWall(walk, W2(f0.x - f0.tz * v(f0.u), f0.z + f0.tx * v(f0.u)), W2(f1.x - f1.tz * v(f1.u), f1.z + f1.tx * v(f1.u)), yCF - 0.5, yTop); }
    }
    for (const [ue] of [[cu0], [cu1]]) { const f = frameAt(ue); const a = vl(ue), b = vr(ue); const P = (vv, y) => [f.x - f.tz * vv, y, f.z + f.tx * vv];
      zC.m.glass.quad(P(a, yCF + 0.1), P(b, yCF + 0.1), P(b, yTop - 0.1), P(a, yTop - 0.1), [0, 0, 1, 0, 1, 1, 0, 1]); zC.m.glass.quad(P(b, yCF + 0.1), P(a, yCF + 0.1), P(a, yTop - 0.1), P(b, yTop - 0.1), [0, 0, 1, 0, 1, 1, 0, 1]); }
    for (let i = 0; i + 1 < fr.length; i++) { const f0 = fr[i], f1 = fr[i + 1]; const q = [[f0.u, vl(f0.u)], [f1.u, vl(f1.u)], [f1.u, vr(f1.u)], [f0.u, vr(f0.u)]].map(([u, v]) => T.WUV(u, v)); addFloor(walk, q, yCF); }
    T.concZone = { y: yCF, u0: cu0 + 1, u1: cu1 - 1, vl: (u) => vl(u) + 0.6, vr: (u) => vr(u) - 0.6, holes: [] };
    // fare gates across the concourse, booth, TVMs
    const ug = cu0 + 6; const a = vl(ug), b = vr(ug); const nG = U.clamp(Math.floor((b - a - 6) / 0.86), 4, 10); const arrW = nG * 0.86 + 0.6; const v0 = (a + b) / 2 - arrW / 2;
    T.placeB(zC.d, ug, v0, yCF, 0); SP.fareGates(zC.d, nG); T.popB(zC.d);
    for (const [va, vb] of [[a, v0], [v0 + arrW, b]]) { const [x0, z0] = T.L2(ug, va + 0.1), [x1, z1] = T.L2(ug, vb - 0.1); SP.railing(zC.d, [[x0, yCF, z0], [x1, yCF, z1]], 1.25, 'glass'); addWall(walk, W2(x0, z0), W2(x1, z1), yCF - 0.5, yCF + 2.5); }
    T.placeB(zC.d, ug - 3.5, b - 2.4, yCF, 0); SP.agentBooth(zC.d, { w: 3.0, d: 2.2 }); T.popB(zC.d);
    for (let k = 0; k < 3; k++) { T.placeB(zC.d, ug - 6 - k * 1.22, a + 0.4, yCF, -Math.PI / 2); SP.tvm(zC.d); T.popB(zC.d); }
    zC.signs.push({ u: ug - 0.6, v: (a + b) / 2, y: yCF + 2.7, yaw: T.yawAt(ug) + Math.PI, w: 2.8, h: 0.7, region: 'gates', both: true, T });
    // wordmark band over the entrance end + lights
    zC.signs.push({ u: cu0 - 0.08, v: (a + b) / 2, y: yTop - 0.6, yaw: T.yawAt(cu0) + Math.PI / 2, w: 6.0, h: 0.75, region: 'word', both: false, T });
    const LC = S.light; const f0 = frameAt(cu0 + 1), f1 = frameAt(cu1 - 1);
    for (const off of [-0.4, 0.4]) { const v = (vl(uc) + vr(uc)) / 2 + off * (vr(uc) - vl(uc)) / 2;
      zC.lights.add({ a: [f0.x - f0.tz * v, yTop - 0.1, f0.z + f0.tx * v], b: [f1.x - f1.tz * v, yTop - 0.1, f1.z + f1.tx * v], color: LC.map(c => c * 0.9), range: 16, radius: 0.08, dir: [0, -1, 0], focus: 1 });
      zC.m.glow.mat(LC); zC.m.glow.sweep(frames(cu0 + 1, cu1 - 1), (i, f) => [[v - 0.1, yTop - 0.05], [v + 0.1, yTop - 0.05]], true); }
    yield;
  }

  // ---------------------------------------------------------------- at grade / median: a footbridge over the tracks
  function* footbridge(T) {
    const { S, M, frames, frameAt, edgeV, zC, walk, W2, yCF, uc, place } = T;
    const g = zC.m.sk;
    const ub0 = T.ub0, ub1 = T.ub1, um = (ub0 + ub1) / 2;      // over the groups' heads (groundPlan)
    const vl = (u) => edgeV(u, -1) - 2, vr = (u) => edgeV(u, 1) + 2;
    const yTop = yCF + 3.2;
    slab(T, g, ub0, ub1, vl, vr, yCF, [], Object.assign(M(S.cFloor), { sky: 0.4 }), true);
    slab(T, g, ub0, ub1, vl, vr, yCF - 0.6, [], Object.assign(M(S.deck || S.cCeil), { sky: 0.6 }), false);
    slab(T, g, ub0 - 0.5, ub1 + 0.5, (u) => vl(u) - 0.5, (u) => vr(u) + 0.5, yTop, [], Object.assign(M(S.canopy || S.cCeil), { sky: 1 }), true);
    slab(T, g, ub0 - 0.5, ub1 + 0.5, (u) => vl(u) - 0.5, (u) => vr(u) + 0.5, yTop - 0.2, [], Object.assign(M(S.canopyUnder || S.cCeil), { sky: 0.3 }), false);
    // deck edge faces
    for (const side of [-1, 1]) g.sweep(frames(ub0, ub1), (i, f) => { const v = side < 0 ? vl(f.u) : vr(f.u); return side < 0 ? [[v, yCF, null, M(S.deck || S.cCeil, { sky: 0.8 })], [v, yCF - 0.6]] : [[v, yCF - 0.6, null, M(S.deck || S.cCeil, { sky: 0.8 })], [v, yCF]]; });
    const fr = frames(ub0, ub1);
    const glassWall = (P0, P1) => { zC.m.glass.quad([P0[0], yCF + 0.1, P0[1]], [P1[0], yCF + 0.1, P1[1]], [P1[0], yTop - 0.3, P1[1]], [P0[0], yTop - 0.3, P0[1]], [0, 0, 1, 0, 1, 1, 0, 1]);
      zC.m.glass.quad([P1[0], yCF + 0.1, P1[1]], [P0[0], yCF + 0.1, P0[1]], [P0[0], yTop - 0.3, P0[1]], [P1[0], yTop - 0.3, P1[1]], [0, 0, 1, 0, 1, 1, 0, 1]);
      addWall(walk, W2(...P0), W2(...P1), yCF - 0.5, yTop); };
    // glass ends, and glass sides with an opening where each walkway leaves
    for (const ue of [ub0, ub1]) glassWall(T.L2(ue, vl(ue)), T.L2(ue, vr(ue)));
    const WW = 3.6;
    for (const side of [-1, 1]) {
      const open = (T.landings || []).some(L => L.side === side);
      const vv = (u) => side < 0 ? vl(u) : vr(u);
      const spans = open ? [[ub0, um - WW / 2], [um + WW / 2, ub1]] : [[ub0, ub1]];
      for (const [a, b] of spans) { const fr2 = frames(a, b); for (let i = 0; i + 1 < fr2.length; i++) glassWall(T.L2(fr2[i].u, vv(fr2[i].u)), T.L2(fr2[i + 1].u, vv(fr2[i + 1].u))); }
      // mullions
      for (let u = ub0; u <= ub1 + 1e-6; u += 2.33) { if (open && Math.abs(u - um) < WW / 2) continue; place(g, u, vv(u), yCF, 0); g.mat(S.steel ? S.steel[0] : 0x3f464d, K.PAINT); g.cbox(0, 0, 0, 0.1, yTop - 0.2 - yCF, 0.1); g.pop(); }
    }
    for (let i = 0; i + 1 < fr.length; i++) { const f0 = fr[i], f1 = fr[i + 1]; const q = [[f0.u, vl(f0.u)], [f1.u, vl(f1.u)], [f1.u, vr(f1.u)], [f0.u, vr(f0.u)]].map(([u, v]) => T.WUV(u, v)); addFloor(walk, q, yCF); }
    // supports down to the ground at both sides
    for (const [u, v] of bridgeSupports(T)) { const [x, z] = T.L2(u, v); const gy = Math.min(Terrain.h(x + T.OX, z + T.OZ) - 0.3, yCF - 1.2); if (yCF - 0.6 - gy > 30) continue; place(g, u, v, gy); g.mat(S.col[0], S.col[1], S.col[2]); g.cbox(0, 0, 0, 0.6, yCF - 0.6 - gy, 0.6); g.pop(); }
    // fare gates across the mouth of each walkway (unpaid side outward)
    for (const L of T.landings || []) {
      const nG = 5, width = nG * 0.86 + 0.24 + 0.45; const vG = (L.side < 0 ? vl(um) : vr(um)) - L.side * 2.2;
      T.placeB(zC.d, L.side < 0 ? um + width / 2 : um - width / 2, vG, yCF, L.side < 0 ? -Math.PI / 2 : Math.PI / 2); SP.fareGates(zC.d, nG); T.popB(zC.d);
      zC.signs.push({ u: um, v: vG - L.side * 0.6, y: yCF + 2.7, yaw: T.yawAt(um) + (L.side < 0 ? 0 : Math.PI), w: 2.8, h: 0.7, region: 'gates', both: true, T });
    }
    const LC = S.light; const f0 = frameAt(ub0 + 1), f1 = frameAt(ub1 - 1); const v = (vl(uc) + vr(uc)) / 2;
    zC.lights.add({ a: [f0.x - f0.tz * v, yTop - 0.25, f0.z + f0.tx * v], b: [f1.x - f1.tz * v, yTop - 0.25, f1.z + f1.tx * v], color: LC.map(c => c * 0.8), range: 14, radius: 0.08, dir: [0, -1, 0], focus: 1 });
    yield;
    yield* walkways(T);
  }
  const bridgeSupports = (T) => { const vl = T.edgeV(T.uc, -1) - 2, vr = T.edgeV(T.uc, 1) + 2; const out = []; for (const v of [vl + 1, vr - 1]) for (const u of [T.ub0 + 1, T.ub1 - 1]) out.push([u, v]); return out; };

  // ------------------------------------------------------------------------------------------------ walkways and landing towers
  // A footbridge mezzanine over the tracks reaches the street by covered walkways to the station's real entrances
  // (MetroNet: GTFS first), one per side of the line (across the freeway lanes at a median station), each ending in a
  // landing tower: two stair flights down to the entrance and a glass elevator. Without a usable entrance a walkway
  // leaves the left side. A trench station's mezzanine at street level needs none.
  const WALK_W = 3.6;
  function planBridge(T) {
    T.landings = [];
    if (T.yCF - T.street < 1.5) return;
    const { edgeV, ub0, ub1 } = T; const um = (ub0 + ub1) / 2;
    const cands = [];
    for (const e of dedupeEntrances(T.st.data.entrances || [])) {
      const uv = toUV(T, e.x - T.OX, e.z - T.OZ); if (!uv) continue;
      const [ue, ve] = uv; const side = ve < 0 ? -1 : 1; const out = side * (ve - edgeV(ue, side));
      if (out < 6 || out > 140 || Math.abs(ue - um) > 150) continue;
      cands.push({ e, ue, ve, side, d: Math.hypot(ue - um, out), gtfs: e.src === 'gtfs' ? 1 : 0 });
    }
    const pick = [];
    for (const side of [-1, 1]) { const c = cands.filter(q => q.side === side).sort((a, b) => (b.gtfs - a.gtfs) || (a.d - b.d))[0]; if (c) pick.push(c); }
    T.landDbg = { um, cands: cands.map(c => [+c.ue.toFixed(1), +c.ve.toFixed(1), c.side]), skipped: [] };
    if (!pick.length) pick.push({ side: -1, ue: um, ve: edgeV(um, -1) - 24, fallback: true });
    for (const c of pick) {
      const vS = edgeV(um, c.side) + c.side * 2;
      const S = T.L2(um, vS), N0 = T.L2(um, vS + c.side * 6);
      const E = c.fallback ? T.L2(c.ue, c.ve) : [c.e.x - T.OX, c.e.z - T.OZ];
      // ground at the stair foot (the entrance) sets the rise; two flights with a 1.6 m landing
      let dx = E[0] - N0[0], dz = E[1] - N0[1], dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      // a turn of less than ~35 degrees needs no square-out stub
      const nx = N0[0] - S[0], nz = N0[1] - S[1], nl = Math.hypot(nx, nz) || 1; const straight = (dx * nx + dz * nz) / nl > 0.82;
      const A = straight ? S : N0;
      if (straight) { dx = E[0] - S[0]; dz = E[1] - S[1]; dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl; }
      const gy = Terrain.h(E[0] + T.OX, E[1] + T.OZ); const rise = T.yCF - gy; if (rise < -1.2 || rise > 25) { T.landDbg.skipped.push(['rise', +rise.toFixed(1)]); continue; }
      // (the ground at the entrance level with the walkway: it just ends there; a short rise: one flight)
      const flush = rise < 0.35, single = !flush && rise < 2.6;
      const n1 = flush ? 0 : single ? Math.max(1, Math.round(rise / SP.RISER)) : Math.max(1, Math.round(rise / 2 / SP.RISER));
      const n2 = flush || single ? 0 : Math.max(1, Math.round((rise - n1 * SP.RISER) / SP.RISER));
      const run = flush ? 0 : (n1 + n2) * SP.TREAD + (n2 ? 1.6 : 0);
      const toE = Math.hypot(E[0] - A[0], E[1] - A[1]);
      const Lw = Math.max(1.5, toE - run);
      const top = [A[0] + dx * Lw, A[1] + dz * Lw], foot = [top[0] + dx * run, top[1] + dz * run];
      const segs = straight ? [[S, top]] : [[S, N0], [N0, top]];
      // walkway supports every ~20 m (one near each end of a segment), moved up to 6 m to stand clear of a street
      const supports = [];
      for (const [a, b] of segs) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 1) continue; const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
        const nS = Math.max(1, Math.round(len / 20));
        for (let k = 1; k <= nS; k++) {
          const x0 = k === nS ? len - 0.6 : k * len / nS;
          const ok = (x) => { const uv = toUV(T, a[0] + ux * x, a[1] + uz * x); return !uv || !T.roads.length || !roadAt(T, uv[0], uv[1], 1.0); };
          const d = [0, 2, -2, 4, -4, 6, -6].find(dd => x0 + dd > 0.5 && x0 + dd < len - 0.3 && ok(x0 + dd)); if (d === undefined) continue;
          supports.push([a[0] + ux * (x0 + d), a[1] + uz * (x0 + d), segYaw(a, b)]);
        }
      }
      T.landings.push({ side: c.side, segs, top, foot, dir: [dx, dz], rise, gy, n1, n2, run, supports, flush, name: c.e ? c.e.name : '' });
    }
  }
  // the local frame of a segment: +X along it, +Z to its right; yaw for GB.at
  const segYaw = (a, b) => Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
  function* walkways(T) {
    const { S, M, zC, walk, W2, yCF } = T;
    const g = zC.m.sk, gd = zC.d.sk; const W = WALK_W, hw = W / 2, yRoof = yCF + 3.0;
    const style = T.H.bridgeStyle || 'glass', colB = lin(T.H.bridgeCol !== undefined ? T.H.bridgeCol : (S.steel ? S.steel[0] : 0x5e6f7c));
    const mDeck = M(S.deck || [0xb5afa3, K.CONCRETE, 0], { sky: 0.8 }), mFloor = M(S.cFloor, { sky: 0.5 });
    const LC = S.light;
    for (const L of T.landings || []) {
      // walkway segments: deck, floor, roof, sides (glass panels or a steel truss), lights; walk floors and walls
      for (const [a, b] of L.segs) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 0.3) continue; const yaw = segYaw(a, b);
        g.push().at(a[0], 0, a[1], yaw);
        g.set(mDeck); g.box(-0.3, yCF - 0.7, -hw - 0.2, len + 0.3, yCF, hw + 0.2, 'y+');
        g.set(mFloor); g.quad([-0.3, yCF + 0.003, hw + 0.2], [len + 0.3, yCF + 0.003, hw + 0.2], [len + 0.3, yCF + 0.003, -hw - 0.2], [-0.3, yCF + 0.003, -hw - 0.2], [0, 0, len, 0, len, W, 0, W]);
        g.set(M(S.canopy || S.cCeil, { sky: 1 })); g.box(-0.4, yRoof, -hw - 0.45, len + 0.4, yRoof + 0.22, hw + 0.45, 'y-');
        g.set(M(S.canopyUnder || S.cCeil, { sky: 0.4 })); g.quad([-0.4, yRoof, -hw - 0.45], [len + 0.4, yRoof, -hw - 0.45], [len + 0.4, yRoof, hw + 0.45], [-0.4, yRoof, hw + 0.45], [0, 0, len, 0, len, W, 0, W]);
        const nP = Math.max(1, Math.round(len / 3.0));
        if (style === 'truss') {
          // Warren truss sides: top and bottom chords, diagonals, verticals at the panel points
          g.mat(colB, K.PAINT);
          for (const z of [-hw - 0.12, hw + 0.12]) {
            g.box(-0.3, yCF - 0.1, z - 0.1, len + 0.3, yCF + 0.12, z + 0.1); g.box(-0.3, yRoof - 0.25, z - 0.1, len + 0.3, yRoof, z + 0.1);
            for (let k = 0; k < nP; k++) { const x0 = k * len / nP, x1 = (k + 1) * len / nP; g.tube(k % 2 ? [x0, yRoof - 0.2, z] : [x0, yCF + 0.1, z], k % 2 ? [x1, yCF + 0.1, z] : [x1, yRoof - 0.2, z], 0.08, 6); g.cbox(x0, yCF, z, 0.14, yRoof - yCF, 0.14); }
            g.cbox(len, yCF, z, 0.14, yRoof - yCF, 0.14);
          }
          for (const z of [-hw, hw]) zC.m.glass.quad([0, yCF + 1.1, z], [len, yCF + 1.1, z], [len, yCF + 2.4, z], [0, yCF + 2.4, z], [0, 0, 1, 0, 1, 1, 0, 1]);
        } else {
          g.mat(colB, K.PAINT);
          for (let k = 0; k <= nP; k++) { const x = k * len / nP; for (const z of [-hw - 0.05, hw + 0.05]) g.cbox(x, yCF, z, 0.1, yRoof - yCF, 0.1); }
          for (const z of [-hw - 0.05, hw + 0.05]) { g.box(0, yCF + 1.05, z - 0.04, len, yCF + 1.12, z + 0.04); if (style === 'box') g.box(0, yRoof - 0.9, z - 0.06, len, yRoof, z + 0.06); }
          for (const z of [-hw - 0.05, hw + 0.05]) { const y1 = style === 'box' ? yRoof - 0.9 : yCF + 2.4;
            zC.m.glass.quad([0, yCF + 0.05, z], [len, yCF + 0.05, z], [len, y1, z], [0, y1, z], [0, 0, 1, 0, 1, 1, 0, 1]); zC.m.glass.quad([len, yCF + 0.05, z], [0, yCF + 0.05, z], [0, y1, z], [len, y1, z], [0, 0, 1, 0, 1, 1, 0, 1]); }
        }
        // line light under the roof
        zC.m.glow.mat(LC); zC.m.glow.box(0.5, yRoof - 0.06, -0.1, len - 0.5, yRoof - 0.02, 0.1);
        g.pop();
        const ca = Math.cos(yaw), sa = Math.sin(yaw);     // local +X = (cos, -sin), +Z = (sin, cos)
        const P = (x, z) => [a[0] + x * ca + z * sa, a[1] - x * sa + z * ca];
        if (zC.lights.lights.length < StationKit.MAXL) { const p0 = P(0.5, 0), p1 = P(len - 0.5, 0); zC.lights.add({ a: [p0[0], yRoof - 0.1, p0[1]], b: [p1[0], yRoof - 0.1, p1[1]], color: LC.map(c => c * 0.7), range: 10, radius: 0.08, dir: [0, -1, 0], focus: 1 }); }
        addFloor(walk, [P(-0.3, -hw), P(len + 0.3, -hw), P(len + 0.3, hw), P(-0.3, hw)].map(q => W2(...q)), yCF);
        for (const z of [-hw, hw]) addWall(walk, W2(...P(-0.3, z)), W2(...P(len + 0.3, z)), yCF - 0.5, yRoof);
      }
      // supports (planned clear of the streets under the walkway)
      for (const q of L.supports) { const gyS = Math.min(Terrain.h(q[0] + T.OX, q[1] + T.OZ) - 0.3, yCF - 1.2); if (yCF - 0.7 - gyS > 30) continue;
        g.push().at(q[0], gyS, q[1], q[2]); g.mat(S.col[0], S.col[1], S.col[2]); g.cbox(0, 0, 0, 0.7, yCF - 0.7 - gyS, 0.7); g.pop(); }
      // corner pads where segments meet
      for (let i = 1; i < L.segs.length; i++) { const q = L.segs[i][0]; g.push().at(q[0], 0, q[1], segYaw(L.segs[i][0], L.segs[i][1])); g.set(mDeck); g.box(-hw - 0.2, yCF - 0.7, -hw - 0.2, hw + 0.2, yCF - 0.02, hw + 0.2, 'y+'); g.set(mFloor); g.quad([-hw - 0.2, yCF, hw + 0.2], [hw + 0.2, yCF, hw + 0.2], [hw + 0.2, yCF, -hw - 0.2], [-hw - 0.2, yCF, -hw - 0.2], [0, 0, W, 0, W, W, 0, W]); g.pop();
        addFloor(walk, [[q[0] - hw, q[1] - hw], [q[0] + hw, q[1] - hw], [q[0] + hw, q[1] + hw], [q[0] - hw, q[1] + hw]].map(p => W2(...p)), yCF); }
      // landing tower: two flights from the entrance (foot) up to the walkway (top), a mid landing, a roof, the elevator
      if (L.flush) { yield; continue; }
      const [dx, dz] = L.dir; const yawUp = Math.atan2(dz, -dx);      // stairs rise along local +X: from the foot back toward the top
      const two = L.n2 > 0, r1 = two ? L.n1 * SP.RISER : L.rise, r2 = L.rise - r1, run1 = L.n1 * SP.TREAD, run2 = L.n2 * SP.TREAD;
      const stairB = (x, y, H) => { const B = zC.m; for (const gg of new Set([B.sk, B.glass, B.glow])) { gg.push(); gg.at(L.foot[0], 0, L.foot[1], yawUp); gg.translate(x, y, 0); } SP.stairs(B, H, { W: 2.6, cheeks: 'stringer', treadCol: lin(S.tread || 0xa39e95) }); for (const gg of new Set([B.sk, B.glass, B.glow])) gg.pop(); };
      stairB(0, L.gy, r1);
      g.push().at(L.foot[0], 0, L.foot[1], yawUp); if (two) { g.set(mDeck); g.box(run1 - SP.TREAD, L.gy + r1 - 0.3, -1.4, run1 + 1.6, L.gy + r1, 1.4, ''); g.set(mFloor); g.quad([run1 - SP.TREAD, L.gy + r1 + 0.005, 1.4], [run1 + 1.6, L.gy + r1 + 0.005, 1.4], [run1 + 1.6, L.gy + r1 + 0.005, -1.4], [run1 - SP.TREAD, L.gy + r1 + 0.005, -1.4], [0, 0, 1.6, 0, 1.6, 2.8, 0, 2.8]);
      // posts under the mid landing, glass guards along the flights, a sloped roof over the tower
      g.mat(colB, K.PAINT); for (const z of [-1.3, 1.3]) g.cbox(run1 + 0.8, L.gy - 0.2, z, 0.2, r1 - 0.1, 0.2); }
      const runT = two ? run1 + 1.6 + run2 : run1;
      g.set(M(S.canopy || S.cCeil, { sky: 1 })); g.quad([-0.6, L.gy + 3.1, 1.9], [runT + 0.2, yCF + 3.1, 1.9], [runT + 0.2, yCF + 3.1, -1.9], [-0.6, L.gy + 3.1, -1.9], [0, 0, runT, 0, runT, 3.8, 0, 3.8]);
      g.set(M(S.canopyUnder || S.cCeil, { sky: 0.4 })); g.quad([-0.6, L.gy + 3.0, -1.9], [runT + 0.2, yCF + 3.0, -1.9], [runT + 0.2, yCF + 3.0, 1.9], [-0.6, L.gy + 3.0, 1.9], [0, 0, runT, 0, runT, 3.8, 0, 3.8]);
      g.mat(colB, K.PAINT); for (const x of [-0.5, runT + 0.1]) for (const z of [-1.8, 1.8]) { const yb = x < 0 ? L.gy : yCF; g.cbox(x, yb, z, 0.14, (x < 0 ? L.gy + 3.0 : yCF + 3.0) - yb, 0.14); }
      g.pop();
      if (two) stairB(run1 + 1.6, L.gy + r1, r2);
      // walk: the two flights and the mid landing
      const ca = Math.cos(yawUp), sa = Math.sin(yawUp); const PU = (x, z) => [L.foot[0] + x * ca + z * sa, L.foot[1] - x * sa + z * ca];
      addSlope(walk, [[0, -1.2, L.gy], [run1, -1.2, L.gy + r1], [run1, 1.2, L.gy + r1], [0, 1.2, L.gy]].map(([x, z, y]) => { const q = W2(...PU(x, z)); return [q[0], q[1], y]; }));
      if (two) { addFloor(walk, [PU(run1, -1.3), PU(run1 + 1.6, -1.3), PU(run1 + 1.6, 1.3), PU(run1, 1.3)].map(q => W2(...q)), L.gy + r1);
        addSlope(walk, [[run1 + 1.6, -1.2, L.gy + r1], [runT, -1.2, yCF], [runT, 1.2, yCF], [run1 + 1.6, 1.2, L.gy + r1]].map(([x, z, y]) => { const q = W2(...PU(x, z)); return [q[0], q[1], y]; })); }
      for (const z of [-1.3, 1.3]) addWall(walk, W2(...PU(-0.3, z)), W2(...PU(runT, z)), L.gy - 1, yCF + 2.5);
      for (const z of [-1.35, 1.35]) { const pts = (two ? [[0, L.gy + 0.05], [run1, L.gy + r1], [run1 + 1.6, L.gy + r1], [runT, yCF]] : [[0, L.gy + 0.05], [runT, yCF]]).map(([x, y]) => { const q = PU(x, z); return [q[0], y, q[1]]; }); SP.railing(zC.d, pts, 1.07, 'glass'); }
      // glass elevator beside the top of the stair, from the street to the walkway
      const ex = runT - 1.4, ez = 1.3 + 0.2 + 1.3; const eq = PU(ex, ez); const egy = Terrain.h(eq[0] + T.OX, eq[1] + T.OZ);
      if (yCF - egy > 1.5 && yCF - egy < 25) { const B = zC.m; for (const gg of new Set([B.sk, B.glass, B.glow])) { gg.push(); gg.at(eq[0], egy, eq[1], yawUp + Math.PI / 2); } SP.elevator(B, yCF - egy, { levels: [0, yCF - egy] }); for (const gg of new Set([B.sk, B.glass, B.glow])) gg.pop(); }
      // the entrance sign at the foot
      zC.signs.push({ u: 0, v: 0, y: L.gy + 2.6, yaw: Math.atan2(dx, dz), w: 1.6, h: 0.4, region: 'word', both: true, T: { L2: () => PU(-0.4, 0) } });
      yield;
    }
  }
  // shallow subway ('ends': too shallow for a mezzanine): stair shafts from the street straight down onto each
  // platform near its ends, rising outward, through the box roof (planned in groundPlan: T.entPlan)
  function* platformEndsAccess(T) {
    if (!T.under || !(T.entPlan || []).length) { yield; return; }
    yield* streetEntrances(T, 0, 0);
  }
  function planEndShafts(T) {
    const out = []; const { plats, street } = T;
    for (const p of plats) {
      const rise = street - p.y; if (rise < 1.5) continue;
      const runE = stairRun(rise);
      for (const end of [-1, 1]) {
        const uTop = end < 0 ? p.u0 + 3 : p.u1 - 3, dir = -end, uBot = uTop + dir * runE;
        if ((uBot - p.u0) * (p.u1 - uBot) < 0) continue;
        const ve = (p.eL(uBot) + p.eR(uBot)) / 2, W = U.clamp(Math.min(p.eR(uBot) - p.eL(uBot), p.eR(uTop) - p.eL(uTop)) - 2 * (p.kind === 'island' ? 1.4 : 1.0), 1.4, 3.0);
        out.push({ e: null, ue: uTop, ve, dir, uTop, uBot, topY: street, riseE: rise, runE, inBox: true, W, yBot: p.y, roofY: T.ceilY + 0.8, link: 'plat', p });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ furniture, signs, boards
  function* furnish(T) {
    const { zones, plats, place, frameAt, under } = T;
    const busy = (p, u, v, pad = 0.8) => T.occupied.some(o => o.p === p && u > o.u0 - pad && u < o.u1 + pad && v > o.v0 - pad && v < o.v1 + pad);
    for (const p of plats) {
      const z = p.zone || zones[0], gd = z.d.sk, B = z.d;
      const island = p.kind === 'island';
      const cv = (u) => (p.eL(u) + p.eR(u)) / 2;
      const backV = (u) => island ? cv(u) : (p.sideV > 0 ? p.eR(u) - 0.7 : p.eL(u) + 0.7);
      const faceYaw = island ? 0 : (p.sideV > 0 ? Math.PI : 0);
      for (let u = p.u0 + 18; u < p.u1 - 14; u += 32) {
        if (busy(p, u, cv(u), 2.5)) continue;
        if (T.H.benches === 'bullseye' || T.H.benches === 'drum') {
          // round benches: terrazzo "bullseyes" (Montgomery, Powell) or precast concrete drums (Bay Fair, Orinda)
          const bull = T.H.benches === 'bullseye'; const r = bull ? 0.8 : 0.5;
          place(gd, u, island ? cv(u) : backV(u) + (p.sideV > 0 ? -0.5 : 0.5), p.y, 0);
          if (bull) { gd.mat(0xcfc6b4, K.TERRAZZO, 0); gd.cyl(0, 0, 0, r, r, 0.46, 28, true); gd.mat(0x7a6f60, K.TERRAZZO, 0); gd.cyl(0, 0.46, 0, r * 0.62, r * 0.62, 0.006, 28, true); gd.mat(0xcfc6b4, K.TERRAZZO, 0); gd.cyl(0, 0.466, 0, r * 0.4, r * 0.4, 0.004, 28, true); }
          else { gd.mat(0xaaa59a, K.CONCRETE, 0); gd.cyl(0, 0, 0, r, r, 0.45, 22, true); }
          gd.pop();
        }
        else if (island) { place(gd, u, cv(u) - 0.3, p.y, 0); SP.bench(B, 2.4, under ? 'stone' : 'steel'); gd.pop(); place(gd, u, cv(u) + 0.3, p.y, Math.PI); SP.bench(B, 2.4, under ? 'stone' : 'steel'); gd.pop(); }
        else { place(gd, u, backV(u) + (p.sideV > 0 ? -0.3 : 0.3), p.y, faceYaw); SP.bench(B, 2.4, 'steel'); gd.pop(); }
        if (!busy(p, u + 4.5, cv(u), 1)) { place(gd, u + 4.5, island ? cv(u) : backV(u), p.y, 0); SP.bins(B); gd.pop(); }
        const [bx, bz] = T.L2(u, island ? cv(u) : backV(u)); void bx; void bz;
      }
      // platform screen doors (the airport connector): a glass wall on the edge with a door pair every car length
      if (T.H.screenDoors) for (const side of island ? [-1, 1] : [p.sideV > 0 ? -1 : 1]) {
        const edge = (u) => side < 0 ? p.eL(u) + 0.25 : p.eR(u) - 0.25, pitch = 9.7, dw = 1.8;
        for (let u = p.u0 + 1; u < p.u1 - 1; u += pitch) {
          const ua = u, ub = Math.min(p.u1 - 1, u + pitch), um = (ua + ub) / 2;
          for (const [a, b] of [[ua, um - dw / 2], [um + dw / 2, ub]]) { if (b - a < 0.2) continue; const fr2 = T.frames(a, b);
            B.glass.sweep(fr2, (i, f) => [[edge(f.u), p.y + 0.05], [edge(f.u), p.y + 2.25]]); B.glass.sweep(fr2, (i, f) => [[edge(f.u), p.y + 0.05], [edge(f.u), p.y + 2.25]], true); }
          // the door leaves (closed) in a stainless frame, the header with its lamp
          place(gd, um, edge(um), p.y, 0); gd.mat(0xb9bec3, K.STEEL); gd.cbox(0, 2.25, 0, dw + 0.3, 0.35, 0.18); for (const x of [-dw / 2 - 0.05, dw / 2 + 0.05]) gd.cbox(x, 0, 0, 0.1, 2.25, 0.16); gd.pop();
          T.placeB(B, um, edge(um), p.y, 0); B.glass.quad([-dw / 2, 0.05, 0], [dw / 2, 0.05, 0], [dw / 2, 2.2, 0], [-dw / 2, 2.2, 0], [0, 0, 1, 0, 1, 1, 0, 1]); B.glass.quad([dw / 2, 0.05, 0], [-dw / 2, 0.05, 0], [-dw / 2, 2.2, 0], [dw / 2, 2.2, 0], [0, 0, 1, 0, 1, 1, 0, 1]);
          B.glow.mat(lin(0x40e080)); B.glow.box(-0.15, 2.3, -0.1, 0.15, 2.36, 0.1); T.popB(B);
          const [x0, z0] = T.WUV(ua, edge(ua)), [x1, z1] = T.WUV(ub, edge(ub)); addWall(T.walk, [x0, z0], [x1, z1], p.y - 0.5, p.y + 2.3);
        }
      }
      const ceil = under ? (p.level && p.level.k ? p.level.ceilY : T.ceilY) : p.y + 4.4;
      for (let u = p.u0 + 10; u < p.u1 - 5; u += 36) {
        const v = island ? cv(u) : backV(u); if (busy(p, u, v, 1.5)) continue; const y = p.y + 3.05;
        z.signs.push({ u, v, y, yaw: T.yawAt(u), w: 3.2, h: 0.4, region: 'nameS', both: true, T });
        place(gd, u, v, y + 0.2, 0); gd.mat(0x2a2c2e, K.PAINT); gd.cbox(-1.3, 0, 0, 0.03, Math.max(0.2, ceil - y - 0.2), 0.03); gd.cbox(1.3, 0, 0, 0.03, Math.max(0.2, ceil - y - 0.2), 0.03); gd.pop();
      }
      // next-train displays: double-sided, hung across the platform over each face's half, readable along it
      for (let u = p.u0 + 45; u < p.u1 - 20; u += 70) {
        const y = p.y + 2.75;
        const spots = island ? [[p.keys[0], cv(u) - 1.7], [p.keys[1] || p.keys[0], cv(u) + 1.7]] : [[p.keys[0], (p.eL(u) + p.eR(u)) / 2]];
        for (const [key, v] of spots) {
          if (busy(p, u, v, 1.0)) continue;
          z.boards.push({ key, geo: boardGeo(T, u, v, y), u, v });
          place(gd, u, v, y, 0); gd.mat(0x1c1d1f, K.PAINT); gd.cbox(0, -0.29, 0, 0.12, 0.58, 1.95); gd.cbox(0, 0.29, -0.8, 0.04, Math.max(0.2, ceil - y - 0.29), 0.04); gd.cbox(0, 0.29, 0.8, 0.04, Math.max(0.2, ceil - y - 0.29), 0.04); gd.pop();
        }
      }
      let um = (p.u0 + p.u1) / 2 - 8; while (busy(p, um, cv(um), 2) && um > p.u0 + 10) um -= 6;
      p.keys.forEach((key, k) => { const side = island ? (k === 0 ? -1 : 1) : (p.sideV > 0 ? -1 : 1); const v = (island ? cv(um) : backV(um)) + side * 0.12;
        z.signs.push({ u: um, v, y: p.y + 2.25, yaw: T.yawAt(um) + (side > 0 ? Math.PI : 0), w: 3.2, h: 0.4, region: 'p' + Math.min(4, Number(key) || (k + 1)), both: false, T });
      });
      place(gd, um, island ? cv(um) : backV(um), p.y, 0); gd.mat(0x1c1d1f, K.PAINT); gd.cbox(0, 0, 0, 3.3, 2.05, 0.2); gd.pop();
      let u2 = um + 30; while (busy(p, u2, cv(u2), 2) && u2 < p.u1 - 10) u2 += 6; const v2 = island ? cv(u2) : backV(u2);
      place(gd, u2, v2, p.y, 0); gd.mat(0x1c1d1f, K.PAINT); gd.cbox(0, 0, 0, 2.5, 2.2, 0.16); gd.pop();
      z.signs.push({ u: u2, v: v2 - 0.09, y: p.y + 1.35, yaw: T.yawAt(u2), w: 2.4, h: 1.0, region: 'map', both: false, T });
      z.signs.push({ u: u2, v: v2 + 0.09, y: p.y + 1.35, yaw: T.yawAt(u2) + Math.PI, w: 2.4, h: 1.0, region: 'map', both: false, T });
      yield;
    }
    if (under) for (const L of T.levels) for (const side of [-1, 1]) for (let u = T.pu0 + 12; u < T.pu1 - 8; u += 25) {
      const v = (T.levels.length > 1 ? L.edgeV : T.edgeV)(u, side) - side * 0.03;
      L.zone.signs.push({ u, v, y: L.yT + 1.9, yaw: T.yawAt(u) + (side < 0 ? Math.PI : 0), w: 6.4, h: 1.2, region: 'name', both: false, T });
    }
  }
  // a display face on each side (normals +u and -u), 1.8 x 0.45 m, just proud of the housing
  function boardGeo(T, u, v, y) {
    const [x, z] = T.L2(u, v); const f = T.frameAt(u); const yaw = Math.atan2(f.tx, f.tz);
    const a = new THREE.PlaneGeometry(1.8, 0.45); a.translate(0, 0, 0.065); a.rotateY(yaw);
    const b = new THREE.PlaneGeometry(1.8, 0.45); b.translate(0, 0, 0.065); b.rotateY(yaw + Math.PI);
    const g = U.mergeGeometries([a, b]); g.translate(x, y, z);
    return g;
  }
  function signGeometry(list, rect) {
    const pos = [], nor = [], uv = [], idx = []; let n = 0;
    for (const s of list) {
      const [x, z] = s.T.L2(s.u, s.v); const r = rect[s.region] || rect.nameS;
      const faces = s.both ? [s.yaw, s.yaw + Math.PI] : [s.yaw];
      for (const yaw of faces) {
        const c = Math.cos(yaw), sn = Math.sin(yaw); const ax = c, az = -sn; const nx = sn, nz = c;
        const hw = s.w / 2, hh = s.h / 2; const off = s.both ? 0.02 : 0.004;
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
  function addFloor(W, q, y) {
    const poly = []; let bx0 = 1e18, bx1 = -1e18, bz0 = 1e18, bz1 = -1e18;
    for (const [x, z] of q) { poly.push(x, z); bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
    W.floors.push({ poly, a: y, gx: 0, gz: 0, x0: q[0][0], z0: q[0][1], bx0, bx1, bz0, bz1 });
  }
  function addSlope(W, q) {
    const [p0, p1, p2] = q; const ax = p1[0] - p0[0], az = p1[1] - p0[1], ay = p1[2] - p0[2], bx = p2[0] - p0[0], bz = p2[1] - p0[1], by = p2[2] - p0[2];
    const det = ax * bz - az * bx; if (Math.abs(det) < 1e-9) return;
    const gx = (ay * bz - az * by) / det, gz = (ax * by - ay * bx) / det;
    const poly = []; let bx0 = 1e18, bx1 = -1e18, bz0 = 1e18, bz1 = -1e18;
    for (const [x, z] of q) { poly.push(x, z); bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
    W.floors.push({ poly, a: p0[2], gx, gz, x0: p0[0], z0: p0[1], bx0, bx1, bz0, bz1, slope: true });
  }
  function addWall(W, a, b, y0, y1) { W.walls.push({ x0: a[0], z0: a[1], x1: b[0], z1: b[1], y0, y1 }); }
  function indexWalk(W) { W.nFloors = W.floors.length; W.nWalls = W.walls.length; }

  return { build, footprint, STYLE, ERA, styleFor, Zone, addFloor, addSlope, addWall };
})();
