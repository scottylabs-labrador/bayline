// MetroTube (Bayline Metro, infra workstream): everything underground on the metro, for MetroTrack's chunks. Inert
// unless #metro=1. Sections (research: notes/bart/infra.md):
//   bored  circular 5.18 m (SF / Oakland subways; bolted steel rings 0.76 m on Market St), horseshoe 5.33 m (Berkeley Hills)
//   tube   the Transbay Tube: a 5.18 m bore per track, track 0.20 m toward the outer wall, walkway 0.76 m wide at +0.71 m
//          on the gallery side, gallery doors every ~100 m (one per section), fluorescent fixtures every 15.24 m
//   cutcover / portal  box cells 4.7 x 5.3 m with a centre wall between paired tracks; a board-formed headwall at the
//          mouth where the tunnel meets daylight
// Every section has a walkway on the inner side (toward the other track: cross passages, gallery doors) with a handrail,
// its light line above the walkway (lit by the TUNNEL material's own fixture lighting), cables on brackets on the outer
// wall, and the third rail on the outer side. Tunnel pieces ≤ 200 m become Under cells with portals between them (and
// to daylight at the mouths, 'auto' to whatever lies beyond a chunk end or a station face), so the camera in a tunnel
// only draws what it can see, and no daylight reaches in beyond the mouth's ramp.
//   MetroTube.body(ctx, run, a, b)   MetroTube.finish(ctx, group)   MetroTube.commitCells(ch)   MetroTube.dropCells(ch)
const MetroTube = (() => {
  if (!(typeof MetroTrack !== 'undefined' && MetroTrack.enabled)) return { body() {}, finish() {}, commitCells() {}, dropCells() {}, init() {} };
  const MT = MetroTrack, DIM = MT.DIM, PAL = MT.PAL;
  let MATS = null, TRACKS = null;
  const F = {}, F2 = {};
  const CELL = 200;                                    // max cell length (m)
  const TB = 0.52;                                     // trackbed (DF slab) top below top of rail
  const WALK = 0.71, WALKW = 0.78;                     // walkway top above rail, width
  const UNDER = MT.UNDERGROUND;

  // ------------------------------------------------------------------ section kinds and their parameters
  // kind: 'bore' (circle), 'shoe' (horseshoe), 'box'; ring: steel rings (Market St); lamp spacing
  function sectionOf(type, x, z) {
    const ll = Geo.w2ll(x, z);
    // San Francisco's subways between the stations are twin bores (Market St: bolted steel rings; Mission St: Calweld
    // bores), whatever the OSM-derived structure code says; the stations themselves are the STATIONS workstream's boxes
    if (type === 'cutcover' && ll.lon < -122.392 && ll.lon > -122.45 && ll.lat > 37.728 && ll.lat < 37.796) type = 'bored';
    if (type === 'tube') return { kind: 'bore', R: 2.59, off: 0.2, lamp: 15.24, lining: PAL.lining, name: 'tube', doors: 100.5 };
    if (type === 'bored') {
      if (ll.lon > -122.24 && ll.lat > 37.83 && ll.lat < 37.89) return { kind: 'shoe', R: 2.665, spring: 1.95, off: 0, lamp: 7.62, lining: PAL.lining, name: 'hills', doors: 305 };
      const market = ll.lon < -122.395 && ll.lon > -122.42 && ll.lat > 37.772 && ll.lat < 37.795;
      return { kind: 'bore', R: 2.59, off: 0.1, lamp: 15.24, lining: market ? PAL.steelRing : PAL.lining, ring: market, name: market ? 'market' : 'bore', doors: 305 };
    }
    return { kind: 'box', W: 4.7, H: 5.3, lamp: 15.24, lining: PAL.concrete, name: 'box', doors: 85 };
  }
  // the nearest parallel track within 22 m (twin bores 15-20 m apart): its side, for walkway / third rail orientation
  function innerSide(R, s) { const nb = MT.nbrAt(R, s); return nb ? Math.sign(nb) : -1; }

  // ------------------------------------------------------------------ profiles (level frame, around one track at lateral L)
  // o = +1: outer side is +l (right). Profiles traverse the interior counter-clockwise, so normals face into the tunnel.
  const mirrorAbout = (prof, L) => prof.map(([l, h]) => [2 * L - l, h]).reverse();
  function boreProfile(sec, L, o) {
    const R = sec.R, lc = L - sec.off * o;                         // bore centre shifted toward the inner side
    const hc = sec.kind === 'shoe' ? sec.spring : 1.49;            // circle centre / arch springline height
    const out = { arc: [], floor: null, walkTop: null, walkFace: null, hc, lc, R, wallAt: null };
    const edge = 1.84;                                               // walkway edge from the track centre
    if (sec.kind === 'bore') {
      const aF = Math.atan2(-TB - hc, Math.sqrt(Math.max(0.01, R * R - (TB + hc) ** 2))), yW = WALK - hc, aW = Math.PI - Math.asin(U.clamp(yW / R, -1, 1));
      const n = 22; for (let k = 0; k <= n; k++) { const a = aF + (aW - aF) * k / n; out.arc.push([lc + Math.cos(a) * R, hc + Math.sin(a) * R]); }
      const footO = lc + Math.cos(aF) * R, wallI = lc + Math.cos(aW) * R;
      out.floor = [[L - edge, -TB], [footO, -TB]]; out.walkTop = [[wallI, WALK], [L - edge, WALK]]; out.walkFace = [[L - edge, WALK], [L - edge, -TB + 0.02]];
      out.wallAt = (h) => lc - Math.sqrt(Math.max(0, R * R - (h - hc) ** 2));   // inner wall lateral at height h (o = +1)
      out.outerAt = (h) => lc + Math.sqrt(Math.max(0, R * R - (h - hc) ** 2));
      out.crown = hc + R;
    } else {  // horseshoe: vertical walls to the springline, a semicircular arch over
      const wO = lc + R, wI = lc - R;
      out.arc.push([wO, -TB]); out.arc.push([wO, hc]);
      const n = 18; for (let k = 1; k < n; k++) { const a = k / n * Math.PI; out.arc.push([lc + Math.cos(a) * R, hc + Math.sin(a) * R]); }
      out.arc.push([wI, hc]); out.arc.push([wI, WALK]);
      out.floor = [[L - edge, -TB], [wO, -TB]]; out.walkTop = [[wI, WALK], [L - edge, WALK]]; out.walkFace = [[L - edge, WALK], [L - edge, -TB + 0.02]];
      out.wallAt = (h) => h < hc ? wI : lc - Math.sqrt(Math.max(0, R * R - (h - hc) ** 2));
      out.outerAt = (h) => h < hc ? wO : lc + Math.sqrt(Math.max(0, R * R - (h - hc) ** 2));
      out.crown = hc + R;
    }
    if (o < 0) {                                                     // mirror to the other side
      for (const k of ['arc', 'floor', 'walkTop', 'walkFace']) out[k] = mirrorAbout(out[k], L);
      const wa = out.wallAt, oa = out.outerAt; out.wallAt = (h) => 2 * L - wa(h); out.outerAt = (h) => 2 * L - oa(h);
    }
    return out;
  }
  // a box cell: outer wall at L + 2.45 o, inner wall at L - wi o (the centre wall face of a pair, or 2.25 for one track)
  function boxProfile(sec, L, o, wi) {
    const wo = 2.01, top = -TB + sec.H, ch = 0.35, edge = 1.84;          // (2.01 m track to wall [WSX 2-5c/d])
    const oW = L + wo, iW = L - wi;
    const p = { arc: [[oW, -TB], [oW, top - ch], [oW - ch, top], [iW + ch, top], [iW, top - ch], [iW, WALK]], floor: [[L - edge, -TB], [oW, -TB]],
      walkTop: [[iW, WALK], [L - edge, WALK]], walkFace: [[L - edge, WALK], [L - edge, -TB + 0.02]], crown: top, flatArc: true };
    p.wallAt = () => iW; p.outerAt = () => oW;
    if (o < 0) { for (const k of ['arc', 'floor', 'walkTop', 'walkFace']) p[k] = mirrorAbout(p[k], L); p.wallAt = () => 2 * L - iW; p.outerAt = () => 2 * L - oW; }
    return p;
  }

  // ------------------------------------------------------------------ building one cell's geometry
  // tracks: [{ L (lateral in my level frame), o (outer side) }] of the section; ss: sample positions on my track
  function buildCell(ctx, cell, sec, tracksL, ss) {
    const gb = cell.tgb, pair = tracksL.length > 1;
    const rows = ctx.rowsAt(ctx, ss, 0, 0, false, (row, Fr) => { row.top = Fr.y + 6; row.gnd = Fr.y - TB; });
    for (const tk of tracksL) {
      const L = tk.L, o = tk.o;
      const wi = pair ? Math.max(1.9, Math.abs(tracksL[1].L - tracksL[0].L) / 2 - 0.3) : 2.25;
      const P = sec.kind === 'box' ? boxProfile(sec, L, o, wi) : boreProfile(sec, L, o);
      // light line above the walkway (inner side): fixture lateral just off the wall, 2.35 m above rail
      const hF = sec.kind === 'box' ? 2.6 : 2.3, latF = P.wallAt(hF) + o * 0.14;      // (the inner wall is on the -o side: step back toward +o)
      gb.fix = [latF, hF, sec.lamp, 0.0];
      gb.wear = 0.8;
      gb.sweep(rows, P.arc, sec.lining, { flat: !!P.flatArc });
      gb.sweep(rows, P.floor, PAL.concreteDark); gb.sweep(rows, P.walkTop, PAL.concrete); gb.sweep(rows, P.walkFace, PAL.concreteDark);
      // walkway handrail on the wall side, cable trough cover lines, cables on the outer wall
      const hr = WALK + 1.0, hrL = P.wallAt(hr) - (-o) * 0.1;
      gb.sweep(ctx.rowsAt(ctx, ss, hrL, hr, false), [[-0.022, -0.022], [-0.022, 0.022], [0.022, 0.022], [0.022, -0.022]], PAL.railing, { closed: true });
      for (const [h, r] of [[1.235, 0.034], [1.435, 0.027], [1.605, 0.027], [1.78, 0.038]]) {
        const cl = P.outerAt(h) - o * (0.14 + r); gb.sweep(ctx.rowsAt(ctx, ss, cl, h, false), [[-r, 0], [0, r], [r, 0], [0, -r]], PAL.cable, { closed: true, flat: false });
      }
      // brackets, handrail posts, lamps, doors, blue light stations along the cell
      for (let s = Math.ceil(ss[0] / 1.52) * 1.52; s < ss[ss.length - 1]; s += 1.52) {
        MT.frameAt(ctx.R, s, F); setRef(gb, ctx, F); gb.s = s;
        const T = [F.tx, F.ty, F.tz], Lv = [F.lx, F.ly, F.lz], Uv = [F.vx, F.vy, F.vz];
        const at = (lat, h) => [F.x + F.lx * lat + F.vx * h - ctx.ox, F.y + F.ly * lat + F.vy * h, F.z + F.lz * lat + F.vz * h - ctx.oz];
        // cable rack: a slim channel post on the outer wall with an arm under each cable
        const bl = P.outerAt(1.5) - o * 0.03, c = at(bl, 1.52); gb.box(c[0], c[1], c[2], T, Uv, Lv, 0.02, 0.36, 0.022, PAL.galvDark);
        for (const hh of [1.2, 1.4, 1.57, 1.74]) { const al = P.outerAt(hh) - o * 0.13, a2 = at(al, hh); gb.box(a2[0], a2[1], a2[2], T, Uv, Lv, 0.018, 0.012, 0.11, PAL.galvDark); }
        if (Math.round(s / 1.52) % 2 === 0) { const pl = P.wallAt(WALK + 0.5) - (-o) * 0.1, pc = at(pl, WALK + 0.5); gb.box(pc[0], pc[1], pc[2], T, Uv, Lv, 0.02, 0.5, 0.02, PAL.railing); }
      }
      for (let s = Math.ceil(ss[0] / sec.lamp) * sec.lamp; s < ss[ss.length - 1]; s += sec.lamp) {
        MT.frameAt(ctx.R, s, F); setRef(gb, ctx, F); gb.s = s;
        const T = [F.tx, F.ty, F.tz], Lv = [F.lx, F.ly, F.lz], Uv = [F.vx, F.vy, F.vz];
        const wl = P.wallAt(hF) + o * 0.06, c = [F.x + F.lx * wl + F.vx * hF - ctx.ox, F.y + F.ly * wl + F.vy * hF, F.z + F.lz * wl + F.vz * hF - ctx.oz];
        gb.box(c[0], c[1], c[2], T, Uv, Lv, 0.62, 0.07, 0.07, PAL.lampHousing);
        const e = [c[0] + F.lx * o * 0.072, c[1] - 0.005, c[2] + F.lz * o * 0.072]; gb.box(e[0], e[1], e[2], T, Uv, Lv, 0.58, 0.045, 0.004, PAL.lamp);
      }
      // doors into the gallery / cross passages (grey steel in a concrete frame) and blue light stations
      for (let s = Math.ceil((ss[0] - 12) / sec.doors) * sec.doors + 12; s < ss[ss.length - 1]; s += sec.doors) {
        MT.frameAt(ctx.R, s, F); setRef(gb, ctx, F); gb.s = s;
        const T = [F.tx, F.ty, F.tz], Lv = [F.lx, F.ly, F.lz], Uv = [F.vx, F.vy, F.vz];
        const h0 = WALK, wl = P.wallAt(h0 + 1.05) + o * 0.02, c = [F.x + F.lx * wl + F.vx * (h0 + 1.05) - ctx.ox, F.y + F.ly * wl + F.vy * (h0 + 1.05), F.z + F.lz * wl + F.vz * (h0 + 1.05) - ctx.oz];
        gb.box(c[0], c[1], c[2], T, Uv, Lv, 0.62, 1.12, 0.05, PAL.concreteLight);
        gb.box(c[0] + F.lx * o * 0.03, c[1] - 0.04, c[2] + F.lz * o * 0.03, T, Uv, Lv, 0.48, 1.04, 0.03, PAL.doorYellow);   // bright yellow [FIRE]
        const sg = [c[0] + F.lx * o * 0.04, c[1] + 1.32, c[2] + F.lz * o * 0.04]; gb.box(sg[0], sg[1], sg[2], T, Uv, Lv, 0.28, 0.09, 0.02, PAL.exitSign);
        // blue light station 6 m on: grey box, blue lamp above
        MT.frameAt(ctx.R, s + 6, F); setRef(gb, ctx, F); gb.s = s + 6;
        const T2 = [F.tx, F.ty, F.tz], L2 = [F.lx, F.ly, F.lz], U2 = [F.vx, F.vy, F.vz]; const wb = P.wallAt(h0 + 1.2) + o * 0.12;
        const b = [F.x + F.lx * wb + F.vx * (h0 + 1.2) - ctx.ox, F.y + F.ly * wb + F.vy * (h0 + 1.2), F.z + F.lz * wb + F.vz * (h0 + 1.2) - ctx.oz];
        gb.box(b[0], b[1], b[2], T2, U2, L2, 0.25, 0.32, 0.12, PAL.steelPaint);
        gb.box(b[0], b[1] + 0.55, b[2], T2, U2, L2, 0.07, 0.09, 0.07, PAL.blueLamp);
      }
    }
    gb.wear = 0.5;
  }
  function setRef(gb, ctx, F) { gb.ref = { o: [F.x - ctx.ox, F.y, F.z - ctx.oz], r: [F.lx, F.ly, F.lz], u: [F.vx, F.vy, F.vz], t: [F.tx, F.ty, F.tz] }; }

  // ------------------------------------------------------------------ portal headwall at a tunnel mouth
  // (own openings from the section; a neighbouring tunnel crossing the wall's plane, e.g. the other bore of an unpaired
  // twin portal, gets its opening too, so no headwall ever closes the tunnel beside it)
  function headwall(ctx, s, dir, secs, lo, hi, crown, own = [ctx.R]) {
    const gb = ctx.B.infra; MT.frameAt(ctx.R, s, F);
    const T = [F.tx * dir, 0, F.tz * dir]; const tl = Math.hypot(T[0], T[2]) || 1; T[0] /= tl; T[2] /= tl;
    const Lv = [F.lx, 0, F.lz];
    let x0 = lo - 3.2, x1 = hi + 3.2; const ybot = -TB - 1.2;
    const holes = secs.map(sc => { const pts = sc.arc.concat([sc.floor[0]]); return { pts, x0: Math.min(...pts.map(p => p[0])), x1: Math.max(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), y1: Math.max(...pts.map(p => p[1])) }; });
    { const Fh = Object.assign({}, F); for (const h of faceHoles(Fh, [lo - 3.2, hi + 3.2])) { if (own.some(Q => Q.id === h.id)) continue; if (h.x1 < x0 - 0.5 || h.x0 > x1 + 0.5) continue; holes.push(h); }
      for (let merged = true; merged;) { merged = false;
        for (let i = 0; i < holes.length && !merged; i++) for (let j = i + 1; j < holes.length && !merged; j++) { const A = holes[i], B = holes[j];
          if (A.x0 < B.x1 + 0.15 && B.x0 < A.x1 + 0.15 && A.y0 < B.y1 + 0.15 && B.y0 < A.y1 + 0.15) {
            const u0 = Math.min(A.x0, B.x0), u1 = Math.max(A.x1, B.x1), v0 = Math.min(A.y0, B.y0), v1 = Math.max(A.y1, B.y1);
            holes[i] = { x0: u0, x1: u1, y0: v0, y1: v1, pts: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] }; holes.splice(j, 1); merged = true; } } }
      for (const h of holes) { x0 = Math.min(x0, h.x0 - 0.4); x1 = Math.max(x1, h.x1 + 0.4); } }
    let gTop = -1e9; for (const l of [x0, (x0 + x1) / 2, x1]) gTop = Math.max(gTop, MT.groundAt(F.x + F.lx * l + T[0] * 3, F.z + F.lz * l + T[2] * 3) - F.y);
    const top = Math.max(crown + 1.2, Math.min(gTop + 0.9, crown + 9));
    // wall face as an extruded shape with the tunnel openings as holes (x = lateral, y = up, z = outward)
    const yb2 = Math.min(ybot, ...holes.map(h => h.y0 - 0.4)), top2 = Math.max(top, ...holes.map(h => h.y1 + 0.4));
    const shape = new THREE.Shape(); shape.moveTo(x0, yb2); shape.lineTo(x1, yb2); shape.lineTo(x1, top2); shape.lineTo(x0, top2); shape.closePath();
    for (const h of holes) { const hole = new THREE.Path(), pts = h.pts; const cw = THREE.ShapeUtils.isClockWise(pts.map(p => new THREE.Vector2(p[0], p[1])));
      const P2 = cw ? pts : pts.slice().reverse(); P2.forEach((p, i) => i ? hole.lineTo(p[0], p[1]) : hole.moveTo(p[0], p[1])); hole.closePath(); shape.holes.push(hole); }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.8, bevelEnabled: false, curveSegments: 4 });
    const m4 = new THREE.Matrix4().makeBasis(new THREE.Vector3(Lv[0], 0, Lv[2]), new THREE.Vector3(0, 1, 0), new THREE.Vector3(T[0], 0, T[2]));
    m4.setPosition(F.x - ctx.ox - T[0] * 0.4, F.y, F.z - ctx.oz - T[2] * 0.4);
    gb.top = F.y + top2; gb.gnd = F.y + yb2; gb.wear = 0.9; appendGeo(gb, geo, m4, PAL.concreteWarm); geo.dispose();
    // coping and a fence along the top
    const cc = [F.x + F.lx * (x0 + x1) / 2 - ctx.ox, F.y + top2 + 0.1, F.z + F.lz * (x0 + x1) / 2 - ctx.oz];
    gb.box(cc[0], cc[1], cc[2], T, [0, 1, 0], Lv, 0.55, 0.1, (x1 - x0) / 2 + 0.1, PAL.concreteLight);
    const fp = []; for (let k = 0; k <= 8; k++) { const l = x0 + (x1 - x0) * k / 8; fp.push([F.x + F.lx * l - ctx.ox, F.y + top2 + 0.2, F.z + F.lz * l - ctx.oz]); }
    MetroGuide.fenceRun(ctx, fp, 1.5);
    gb.top = 1e4; gb.gnd = -1e4; gb.wear = 0.5;
  }
  // ------------------------------------------------------------------ outer shell near a mouth (outdoor mesh)
  function shell(ctx, sec, tl, wi, a, b) {
    const gb = ctx.B.infra, ss = ctx.sampleS(ctx.R, a, b, 6, 1.5), rows = ctx.rowsAt(ctx, ss, 0, 0, false), yb = -TB - 0.8;
    if (sec.kind === 'box') {
      let L0 = 1e9, L1 = -1e9; for (const t of tl) { const oW = t.L + 2.01 * t.o, iW = t.L - wi * t.o; L0 = Math.min(L0, oW, iW); L1 = Math.max(L1, oW, iW); }
      const yt = -TB + sec.H + 0.45; L0 -= 0.45; L1 += 0.45;
      gb.wear = 0.7; gb.sweep(rows, [[L0, yb], [L0, yt], [L1, yt], [L1, yb]], PAL.concrete); gb.wear = 0.5; return;
    }
    for (const t of tl) {                                   // bores: an outer ring 0.35 m out, down to the ground on both sides
      const bp = boreProfile(sec, t.L, t.o), R = bp.R + 0.35, pts = [[bp.lc - R, yb]];
      for (let k = 0; k <= 16; k++) { const ang = Math.PI - k / 16 * Math.PI; pts.push([bp.lc + Math.cos(ang) * R, bp.hc + Math.sin(ang) * R]); }
      pts.push([bp.lc + R, yb]);
      gb.wear = 0.7; gb.sweep(rows, pts, PAL.concrete, { flat: false }); gb.wear = 0.5;
    }
  }
  // ------------------------------------------------------------------ bulkhead where a box meets bores
  // A 0.3 m wall across the box at s: per track, the opening is its bore's profile clipped to its box cell (so twin bores
  // never merge across the centre wall); the wall reaches past both sections so neither shows a gap around the other.
  function clipPoly(poly, x0, y0, x1, y1) {           // Sutherland-Hodgman against an axis-aligned rectangle
    let out = poly;
    for (const [ax, lim, keepGreater] of [[0, x0, true], [0, x1, false], [1, y0, true], [1, y1, false]]) {
      const inp = out; out = []; if (!inp.length) break;
      const inside = (p) => keepGreater ? p[ax] >= lim : p[ax] <= lim;
      for (let i = 0; i < inp.length; i++) {
        const a = inp[i], b = inp[(i + 1) % inp.length], ia = inside(a), ib = inside(b);
        if (ia) out.push(a);
        if (ia !== ib) { const t = (lim - a[ax]) / (b[ax] - a[ax]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      }
    }
    return out;
  }
  function bulkhead(ctx, cell, s, secN, tl, wi) {
    const gb = cell.tgb, sec = cell.sec; MT.frameAt(ctx.R, s, F);
    const top = -TB + sec.H; let L0 = 1e9, L1 = -1e9, H1 = top;
    const shape = new THREE.Shape(), holes = [];
    for (const t of tl) {
      const oW = t.L + 2.01 * t.o, iW = t.L - wi * t.o, bx0 = Math.min(oW, iW) + 0.02, bx1 = Math.max(oW, iW) - 0.02;
      const bp = boreProfile(secN, t.L, t.o), pts = bp.arc.concat([bp.floor[0]]);
      for (const q of pts) { L0 = Math.min(L0, q[0]); L1 = Math.max(L1, q[0]); H1 = Math.max(H1, q[1]); }
      L0 = Math.min(L0, bx0); L1 = Math.max(L1, bx1);
      const hole = clipPoly(pts, bx0, -TB + 0.02, bx1, top - 0.02); if (hole.length >= 3) holes.push(hole);
    }
    const x0 = L0 - 0.6, x1 = L1 + 0.6, y0 = -TB - 0.4, y1 = H1 + 0.6;
    shape.moveTo(x0, y0); shape.lineTo(x1, y0); shape.lineTo(x1, y1); shape.lineTo(x0, y1); shape.closePath();
    for (const h of holes) { const cw = THREE.ShapeUtils.isClockWise(h.map(p => new THREE.Vector2(p[0], p[1]))); const P2 = cw ? h : h.slice().reverse();
      const path = new THREE.Path(); P2.forEach((p, i) => i ? path.lineTo(p[0], p[1]) : path.moveTo(p[0], p[1])); path.closePath(); shape.holes.push(path); }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false, curveSegments: 4 });
    const T = new THREE.Vector3(F.tx, 0, F.tz).normalize();
    const m4 = new THREE.Matrix4().makeBasis(new THREE.Vector3(F.lx, 0, F.lz), new THREE.Vector3(0, 1, 0), T);
    m4.setPosition(F.x - ctx.ox - T.x * 0.15, F.y, F.z - ctx.oz - T.z * 0.15);
    setRef(gb, ctx, F); gb.s = s; gb.wear = 0.8; appendGeo(gb, geo, m4, sec.lining); geo.dispose(); gb.wear = 0.5;
  }
  // (a mirroring placement, e.g. a basis of lateral, up and the forward tangent, reverses the winding: flipped back here)
  function appendGeo(gb, geo, m4, C) {
    const g = geo.index ? geo.toNonIndexed() : geo; const p = g.attributes.position; g.computeVertexNormals(); const n = g.attributes.normal;
    const v = new THREE.Vector3(), nn = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(m4), flip = m4.determinant() < 0;
    for (let i = 0; i < p.count; i += 3) { const ids = []; for (let k = 0; k < 3; k++) { v.fromBufferAttribute(p, i + k).applyMatrix4(m4); nn.fromBufferAttribute(n, i + k).applyMatrix3(nm).normalize(); ids.push(gb.v(v.x, v.y, v.z, nn.x, nn.y, nn.z, C)); } if (flip) gb.i3(ids[0], ids[2], ids[1]); else gb.i3(ids[0], ids[1], ids[2]); }
    if (g !== geo) g.dispose();
  }

  // ------------------------------------------------------------------ crossover chambers
  // Underground junction clusters whose tracks run side by side (crossovers, pocket tracks, the legs of a wye leaving
  // a turnout): per level of the cluster (tracks within 3 m in height; the Oakland Wye stacks two), the track along
  // which the others run beside it the longest builds one wide cut-and-cover chamber (walls 2.01 m outside the outer
  // tracks, 5.3 m high), with end walls around the tunnels that continue; every other track's tunnel inside it is culled.
  let CHB = null, prepDone = false, prepIt = null;
  function chambers() { if (!prepDone) { if (!prepIt) prepIt = chambersGen(); for (;;) { if (prepIt.next().done) break; } prepDone = true; } return CHB; }
  // one slice of the chamber precompute (the body jobs call this until it is done, a key per step)
  function prepStep() { if (prepDone) return; if (!prepIt) prepIt = chambersGen(); if (prepIt.next().done) prepDone = true; }
  function* chambersGen() {
    CHB = []; const byKey = new Map(); let n = 0;
    for (const R of TRACKS) { for (const z of MetroGuide.zonesOf(R)) if (z[2]) { let l = byKey.get(z[2]); if (!l) byKey.set(z[2], l = []); l.push({ R, z }); } if (++n % 25 === 0) yield; }
    yield;
    for (const [key, list] of byKey) {
      yield;
      const lv = [];
      for (const e of list) { MT.frameAt(e.R, U.clamp((e.z[0] + e.z[1]) / 2, 0, e.R.len), F); e.y = F.y;
        let g = lv.find(g => Math.abs(g.y - e.y) < 3); if (!g) lv.push(g = { y: e.y, list: [] }); g.list.push(e); }
      for (let li = 0; li < lv.length; li++) {
        const g = lv[li], set = new Set(g.list.map(e => e.R)); let best = null;
        for (const own of g.list.slice().sort((a, b) => a.R.id < b.R.id ? -1 : 1)) {
          // (only an underground track can own a chamber)
          const R = own.R; MT.frameAt(R, U.clamp((own.z[0] + own.z[1]) / 2, 0, R.len), F); if (F.struct < 6 && !R.runs.some(r => UNDER.has(r.type) && r.s1 > own.z[0] - 60 && r.s0 < own.z[1] + 60)) continue;
          const p = MT.pairAt(R, U.clamp((own.z[0] + own.z[1]) / 2, 0, R.len)), partner = p ? p.R2 : null;
          const r = alongside(R, own.z, set, partner); if (r && (!best || r[1] - r[0] > best.b - best.a)) best = { R, a: r[0], b: r[1], partner };
          yield;
        }
        if (!best || best.b - best.a < 12) continue;
        const c = { key, lvl: li, R: best.R, s0: Math.max(0, best.a - 6), s1: Math.min(best.R.len, best.b + 6), tracks: set, partner: best.partner };
        // (a world bbox for quick rejects in inChamber)
        let bx0 = 1e9, bz0 = 1e9, bx1 = -1e9, bz1 = -1e9; for (let q = c.s0; ; q = Math.min(c.s1, q + 5)) { MT.frameAt(c.R, q, F); bx0 = Math.min(bx0, F.x); bx1 = Math.max(bx1, F.x); bz0 = Math.min(bz0, F.z); bz1 = Math.max(bz1, F.z); if (q >= c.s1) break; }
        c.bb = [bx0 - 25, bz0 - 25, bx1 + 25, bz1 + 25];
        CHB.push(c);
      }
    }
  }
  // along R around its junction zone: the s-range where another track of the set runs beside it (within 12 m, the same
  // level, roughly parallel, abreast rather than behind or ahead), underground and outside stations
  function alongside(R, z, set, partner) {
    const lo = Math.max(0, z[0] - 60), hi = Math.min(R.len, z[1] + 60); let a = null, b = null;
    for (let q = lo; q <= hi; q += 2) {
      MT.frameAt(R, q, F); if (F.struct < 6 || MT.inStation(R, q, 3)) { if (a !== null) break; continue; }
      let near = false;
      for (const o of MT.net.nearAll(F.x, F.z, 12)) {
        const Q = MT.trackOf(o.track); if (!Q || Q === R || Q === partner || !set.has(Q)) continue;
        MT.frameAt(Q, o.s, F2); if (Math.abs(F2.y - F.y) >= 3 || Math.abs(F.tx * F2.tx + F.tz * F2.tz) < 0.8) continue;
        if (Math.abs((F2.x - F.x) * F.tx + (F2.z - F.z) * F.tz) > 3) continue;
        near = true; break;
      }
      if (near) { if (a === null) a = q; b = q; } else if (a !== null && q - b > 6) break;
    }
    return a === null ? null : [a, b];
  }
  // is a point (world) inside a chamber other than one owned by R?  (projection onto the owner, span + 1.9 m)
  function inChamber(R, x, y, z) {
    for (const c of chambers()) {
      if (c.R === R || !c.tracks.has(R) || x < c.bb[0] || x > c.bb[2] || z < c.bb[1] || z > c.bb[3]) continue;
      const t = c.R.t, st = t.step, i0 = Math.max(0, Math.floor(c.s0 / st)), i1 = Math.min(t.X.length - 2, Math.ceil(c.s1 / st));
      let bd = 1e9, bs = 0, bl = 0, by = 0, ba = 0;
      for (let i = i0; i <= i1; i++) { const ax = t.X[i], az = t.Z[i], dx = t.X[i + 1] - ax, dz = t.Z[i + 1] - az, L2 = dx * dx + dz * dz || 1e-9, u = ((x - ax) * dx + (z - az) * dz) / L2;
        if (u < -0.05 && i === i0 || u > 1.05 && i === i1) continue; const u2 = U.clamp(u, 0, 1), d = (ax + dx * u2 - x) ** 2 + (az + dz * u2 - z) ** 2;
        if (d < bd) { bd = d; bs = (i + u2) * st; bl = ((x - ax) * -dz + (z - az) * dx) / Math.sqrt(L2); by = t.Y[i] + (t.Y[i + 1] - t.Y[i]) * u2; ba = (u - u2) * Math.sqrt(L2); } }
      // (beyond the chamber's axis: past an end, or around the outside of a bend, the point is not abreast of it)
      if (bd > 400 || bs < c.s0 || bs > c.s1 || Math.abs(y - by) > 4 || Math.abs(ba) > 1.5) continue;
      const sp = spanAt(c.R, bs); if (bl > sp[0] - 1.0 && bl < sp[1] + 1.0) return c;
    }
    return null;
  }
  const chamberOf = (R, s) => { for (const c of chambers()) if (c.R === R && s > c.s0 - 0.5 && s < c.s1 + 0.5) return c; return null; };
  // lateral span of every track near the owner at s (level frame of the owner)
  const _Fs = {}, _Fq = {};
  // (each track where it crosses the owner's cross-section plane at s: two Newton steps from its nearest point, so a
  // track diverging at an angle counts at its true lateral there; tracks that end short of the plane are left out)
  function spanAt(R, s, out) {
    MT.frameAt(R, s, _Fs); let lo = 0, hi = 0; if (out) out.length = 0;
    for (const o of MT.net.nearAll(_Fs.x, _Fs.z, 13)) {
      const Q = o.track; let sq = o.s, ok = true;
      for (let k = 0; k < 2; k++) { MT.frameAt(Q, sq, _Fq); const al = (_Fq.x - _Fs.x) * _Fs.tx + (_Fq.z - _Fs.z) * _Fs.tz, c = _Fq.tx * _Fs.tx + _Fq.tz * _Fs.tz;
        if (Math.abs(al) < 0.05) break; if (Math.abs(c) < 0.3) { ok = false; break; } const n = sq - al / c, len = Q.length || (Q.t && Q.t.length) || 1e9; sq = U.clamp(n, 0, len); if (Math.abs(n - sq) > 1) { ok = false; break; } }
      if (!ok) continue; MT.frameAt(Q, sq, _Fq); if (Math.abs(_Fq.y - _Fs.y) > 3) continue;
      const l = (_Fq.x - _Fs.x) * _Fs.lx + (_Fq.z - _Fs.z) * _Fs.lz; if (Math.abs(l) > 16) continue; lo = Math.min(lo, l); hi = Math.max(hi, l);
      if (out) out.push({ id: Q.id, l, dy: _Fq.y - _Fs.y }); }
    return [lo, hi];
  }
  // the openings in a chamber's end wall at frame F (the owner's, at the face): one per underground track crossing the
  // face's plane (found on the track: a sign change of its distance along the owner's tangent, then bisection), its
  // tunnel section at its lateral and height, widened by the crossing angle
  function faceHoles(F, sp) {
    const hs = [];
    for (const o of MT.net.nearAll(F.x, F.z, 16)) {
      const Q = MT.trackOf(o.track); if (!Q) continue;
      const al = (sq) => { MT.frameAt(Q, sq, _Fq); return (_Fq.x - F.x) * F.tx + (_Fq.z - F.z) * F.tz; };
      const qa = Math.max(0, o.s - 24), qb = Math.min(Q.len, o.s + 24); let lo = null, hi = null, alo = 0, pS = qa, pA = al(qa);
      for (let sq = qa + 2; ; sq = Math.min(qb, sq + 2)) { const aa = al(sq); if ((aa >= 0) !== (pA >= 0)) { lo = pS; hi = sq; alo = pA; break; } pS = sq; pA = aa; if (sq >= qb) break; }
      if (lo === null) continue;
      for (let k = 0; k < 8; k++) { const m = (lo + hi) / 2, am = al(m); if ((am >= 0) === (alo >= 0)) { lo = m; alo = am; } else hi = m; }
      MT.frameAt(Q, (lo + hi) / 2, _Fq); const dy = _Fq.y - F.y; if (Math.abs(dy) > 3 || _Fq.struct < 6) continue;
      const L = (_Fq.x - F.x) * F.lx + (_Fq.z - F.z) * F.lz; if (L < sp[0] - 4 || L > sp[1] + 4) continue;
      const cth = Math.max(0.5, Math.abs(F.tx * _Fq.tx + F.tz * _Fq.tz));
      const sec = sectionOf(MT.STRUCT[_Fq.struct] || 'cutcover', _Fq.x, _Fq.z), prof = sec.kind === 'box' ? boxProfile(sec, L, 1, 2.25) : boreProfile(sec, L, 1);
      const pts = prof.arc.concat([prof.floor[0]]).map(p => [L + (p[0] - L) / cth, p[1] + dy]);
      hs.push({ id: Q.id, s: (lo + hi) / 2, L, dy, cth, pts, x0: Math.min(...pts.map(p => p[0])), x1: Math.max(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), y1: Math.max(...pts.map(p => p[1])) });
    }
    return hs;
  }
  function* buildChamber(ctx, chb, a, b) {
    const R = ctx.R, id = 'tc:' + chb.key + ':' + (chb.lvl || 0) + ':' + R.id + ':' + a.toFixed(0);
    const cell = { id, s0: a, s1: b, sec: { kind: 'box', H: 5.3, lamp: 15.24, lining: PAL.concrete }, tl: [{ L: 0, o: 1 }], tgb: new MT.TGB(), R, zone: [chb.key], chamber: true };
    const gb = cell.tgb, ss = ctx.sampleS(R, a, b, 1.0, 0.8), top = -TB + 5.3;
    // (the floor follows the lowest track of the row; a higher track runs on a concrete bench up to its own trackbed;
    // the light line follows the left wall)
    const rows = [], spans = [], trk = [];
    let nr = 0;
    for (const q of ss) { if (++nr % 30 === 0) yield; MT.frameAt(R, q, F); const tr = []; const sp = spanAt(R, q, tr); spans.push(sp); const Lw = sp[0] - 2.01, Rw = sp[1] + 2.01;
      const fl = -TB + Math.min(0, ...tr.map(t => t.dy)); trk.push({ tr, fl });
      rows.push({ s: q, o: [F.x - ctx.ox, F.y, F.z - ctx.oz], c: [F.x - ctx.ox, F.y, F.z - ctx.oz], r: [F.lx, F.ly, F.lz], u: [F.vx, F.vy, F.vz], t: [F.tx, F.ty, F.tz], fix: [Lw + 0.14, 2.6, 15.24, 0],
        prof: [[Lw + 0.35, fl], [Rw - 0.35, fl], [Rw, fl + 0.3], [Rw, top - 0.35], [Rw - 0.35, top], [Lw + 0.35, top], [Lw, top - 0.35], [Lw, fl + 0.3], [Lw + 0.35, fl]],
        col: [PAL.concreteDark, PAL.concrete, PAL.concrete, PAL.concrete, PAL.concrete, PAL.concrete, PAL.concrete, PAL.concrete] }); }
    gb.wear = 0.8;
    yield; sweepVarT(gb, rows); yield;
    { const ids = new Set(); for (const t of trk) for (const e of t.tr) ids.add(e.id);
      for (const tid of ids) { let run = [];
        const flush = () => { if (run.length > 1) sweepVarT(gb, run); run = []; };
        rows.forEach((row, i) => { const e = trk[i].tr.find(x => x.id === tid), fl = trk[i].fl;
          if (!e || e.dy - TB < fl + 0.15) { flush(); return; }
          const tp = e.dy - TB; run.push(Object.assign({}, row, { prof: [[e.l - 1.45, fl], [e.l - 1.45, tp], [e.l + 1.45, tp], [e.l + 1.45, fl]], col: [PAL.concrete, PAL.concreteDark, PAL.concrete] })); });
        flush(); } }
    // lamps along the left wall
    for (let q = Math.ceil(a / 15.24) * 15.24; q < b; q += 15.24) { MT.frameAt(R, q, F); setRef(gb, ctx, F); gb.s = q; const sp = spanAt(R, q), wl = sp[0] - 2.01 + 0.06;
      const c = [F.x + F.lx * wl + F.vx * 2.6 - ctx.ox, F.y + 2.6, F.z + F.lz * wl + F.vz * 2.6 - ctx.oz]; const T = [F.tx, F.ty, F.tz], Lv = [F.lx, F.ly, F.lz], Uv = [F.vx, F.vy, F.vz];
      gb.box(c[0], c[1], c[2], T, Uv, Lv, 0.62, 0.07, 0.07, PAL.lampHousing); gb.box(c[0] + F.lx * 0.072, c[1] - 0.005, c[2] + F.lz * 0.072, T, Uv, Lv, 0.58, 0.045, 0.004, PAL.lamp); }
    // end walls with the continuing tunnels as holes
    yield;
    for (const [q, dir] of [[a, -1], [b, 1]]) {
      const isEnd = (dir < 0 && Math.abs(q - chb.s0) < 0.6) || (dir > 0 && Math.abs(q - chb.s1) < 0.6); if (!isEnd) continue;
      MT.frameAt(R, q, F); const sp = spanAt(R, q), Lw = sp[0] - 2.01, Rw = sp[1] + 2.01;
      const hs = faceHoles(F, sp);
      for (let merged = true; merged;) { merged = false;
        for (let i = 0; i < hs.length && !merged; i++) for (let j = i + 1; j < hs.length && !merged; j++) { const A = hs[i], B = hs[j];
          if (A.x0 < B.x1 + 0.15 && B.x0 < A.x1 + 0.15 && A.y0 < B.y1 + 0.15 && B.y0 < A.y1 + 0.15) {
            const x0 = Math.min(A.x0, B.x0), x1 = Math.max(A.x1, B.x1), y0 = Math.min(A.y0, B.y0), y1 = Math.max(A.y1, B.y1);
            hs[i] = { x0, x1, y0, y1, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }; hs.splice(j, 1); merged = true; } } }
      let X0 = Lw, X1 = Rw, Y0 = -TB - 0.1, Y1 = top + 0.1; for (const h of hs) { X0 = Math.min(X0, h.x0 - 0.3); X1 = Math.max(X1, h.x1 + 0.3); Y0 = Math.min(Y0, h.y0 - 0.3); Y1 = Math.max(Y1, h.y1 + 0.3); }
      const shape = new THREE.Shape(); shape.moveTo(X0, Y0); shape.lineTo(X1, Y0); shape.lineTo(X1, Y1); shape.lineTo(X0, Y1); shape.closePath();
      for (const h of hs) { const hole = new THREE.Path(), pts = h.pts, cw = THREE.ShapeUtils.isClockWise(pts.map(p => new THREE.Vector2(p[0], p[1])));
        (cw ? pts : pts.slice().reverse()).forEach((p, i) => i ? hole.lineTo(p[0], p[1]) : hole.moveTo(p[0], p[1])); hole.closePath(); shape.holes.push(hole); }
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.4, bevelEnabled: false, curveSegments: 4 });
      MT.frameAt(R, q, F); const Tn = [F.tx * dir, 0, F.tz * dir], tl = Math.hypot(Tn[0], Tn[2]) || 1; Tn[0] /= tl; Tn[2] /= tl;
      const m4 = new THREE.Matrix4().makeBasis(new THREE.Vector3(F.lx, 0, F.lz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(Tn[0], 0, Tn[2]));
      m4.setPosition(F.x - ctx.ox, F.y, F.z - ctx.oz); setRef(gb, ctx, F); gb.s = q; gb.fix = [Lw + 0.14, 2.6, 15.24, 0]; appendGeo(gb, geo, m4, PAL.concrete); geo.dispose(); yield;
    }
    gb.wear = 0.5;
    // Under cell over the whole chamber
    const pts = [], day = []; let hw = 0; for (let k = 0; k < ss.length; k += Math.max(1, Math.floor(ss.length / 20))) { const q = ss[k]; MT.frameAt(R, q, F); const sp = spans[k]; const mid = (sp[0] + sp[1]) / 2; pts.push([F.x + F.lx * mid, F.y, F.z + F.lz * mid]); day.push(0); hw = Math.max(hw, (sp[1] - sp[0]) / 2 + 2.6); }
    MT.frameAt(R, b, F); { const sp = spans[spans.length - 1], mid = (sp[0] + sp[1]) / 2; pts.push([F.x + F.lx * mid, F.y, F.z + F.lz * mid]); day.push(0); }
    // (1 m past each end, so the end walls lie inside the volume)
    { const ext = (e0, others) => { const e1 = others.find(q => Math.hypot(q[0] - e0[0], q[2] - e0[2]) > 0.5); if (!e1) return null; const n = Math.hypot(e0[0] - e1[0], e0[2] - e1[2]);
        return [e0[0] + (e0[0] - e1[0]) / n, e0[1], e0[2] + (e0[2] - e1[2]) / n]; };
      const pa = ext(pts[0], pts.slice(1)), pb = ext(pts[pts.length - 1], pts.slice(0, -1).reverse());
      if (pa) { pts.unshift(pa); day.unshift(0); } if (pb) { pts.push(pb); day.push(0); } }
    cell.strip = { pts, half: hw, below: TB + 1.2, above: top + 0.6, day }; cell.lo = spans[0][0]; cell.hi = spans[0][1]; cell.crown = top; cell.mid = 0;
    return cell;
  }
  // sweepVar for the tunnel builder (sets the reference frame per row)
  function sweepVarT(gb, rows) {
    if (rows.length < 2) return; const np = rows[0].prof.length; let prev = -1;
    for (let i = 0; i < rows.length; i++) {
      const R0 = rows[i], o = R0.o, r = R0.r, u = R0.u, pr = R0.prof; gb.s = R0.s; gb.onRow(R0); if (R0.fix) gb.fix = R0.fix; const base = gb.count;
      for (let k = 0; k < np - 1; k++) { const A = pr[k], B = pr[k + 1]; let nl = -(B[1] - A[1]), nu = B[0] - A[0]; const L = Math.hypot(nl, nu) || 1; nl /= L; nu /= L;
        const nx = r[0] * nl + u[0] * nu, ny = r[1] * nl + u[1] * nu, nz = r[2] * nl + u[2] * nu, C = R0.col[k];
        gb.v(o[0] + r[0] * A[0] + u[0] * A[1], o[1] + r[1] * A[0] + u[1] * A[1], o[2] + r[2] * A[0] + u[2] * A[1], nx, ny, nz, C);
        gb.v(o[0] + r[0] * B[0] + u[0] * B[1], o[1] + r[1] * B[0] + u[1] * B[1], o[2] + r[2] * B[0] + u[2] * B[1], nx, ny, nz, C); }
      if (prev >= 0) for (let k = 0; k < np - 1; k++) { const a0 = prev + 2 * k, a1 = base + 2 * k; gb.i6(a0, a0 + 1, a1, a0 + 1, a1 + 1, a1); }
      prev = base;
    }
  }

  // ------------------------------------------------------------------ body: one underground run piece of a chunk
  // distance (m) from s to the nearest tunnel mouth on this track (a boundary with a non-underground, non-station run)
  function mouths(R) {
    if (R.mouths) return R.mouths; const out = [];
    for (let k = 0; k < R.runs.length; k++) { const r = R.runs[k]; if (!UNDER.has(r.type)) continue;
      const prev = R.runs[k - 1], next = R.runs[k + 1];
      if (prev && !UNDER.has(prev.type) && !MT.inStation(R, r.s0, 3)) out.push({ s: r.s0, dir: -1 });
      if (next && !UNDER.has(next.type) && !MT.inStation(R, r.s1, 3)) out.push({ s: r.s1, dir: 1 }); }
    return (R.mouths = out);
  }
  const dayOf = (R, s) => { let d = 1e9; for (const m of mouths(R)) d = Math.min(d, Math.abs(s - m.s)); return d > 60 ? 0 : Math.exp(-d / 9); };
  // (generators: the chunk job yields after every cell and every heavy step, so no frame carries more than a few ms)
  function* body(ctx, run, a, b) {
    const R = ctx.R; ctx.B.tcells = ctx.B.tcells || [];
    while (!prepDone) { ctx.ch.stage = 'tube:prep'; prepStep(); yield; }        // (the global chambers, computed in slices first)
    MT.frameAt(R, (a + b) / 2, F); const sec = sectionOf(run.type === 'portal' ? 'cutcover' : run.type, F.x, F.z);
    // chambers owned by this track inside [a, b]: build them, and the normal section only outside them
    const mine = chambers().filter(c => c.R === R && c.s1 > a && c.s0 < b).sort((x, y) => x.s0 - y.s0);
    if (mine.length) {
      let cur = a;
      for (const c of mine) { const ca = Math.max(a, c.s0), cb = Math.min(b, c.s1); if (ca > cur + 0.5) yield* body1(ctx, run, sec, cur, ca); ctx.ch.stage = 'tube:chamber'; ctx.B.tcells.push(yield* buildChamber(ctx, c, ca, cb)); yield; cur = cb; }
      if (b > cur + 0.5) yield* body1(ctx, run, sec, cur, b);
      return;
    }
    yield* body1(ctx, run, sec, a, b);
  }
  function* body1(ctx, run, sec, a, b) {
    const R = ctx.R;
    // pieces of [a, b] outside any chamber (another track's) that swallows this track; where a piece meets a chamber,
    // its end is found to a few cm (bisection) and reaches 0.3 m into the chamber's end wall, so no gap shows
    ctx.ch.stage = 'tube:pieces'; const ins = (q) => { MT.frameAt(R, q, F); return !!inChamber(R, F.x, F.y, F.z); };
    const edge = (qIn, qOut) => { for (let k = 0; k < 7; k++) { const m = (qIn + qOut) / 2; if (ins(m)) qIn = m; else qOut = m; } return qOut + (qIn - qOut > 0 ? 0.3 : -0.3); };
    const pieces = []; { let cur = null, prevQ = null, prevIn = false;
      for (let q = a; ; q = Math.min(b, q + 2)) { const inside = ins(q);
        if (!inside) { if (!cur) cur = [prevIn ? Math.max(a, edge(prevQ, q)) : q, q]; else cur[1] = q; }
        else if (cur) { cur[1] = Math.min(b, edge(q, cur[1])); pieces.push(cur); cur = null; }
        prevQ = q; prevIn = inside; if (q >= b) break; }
      if (cur) pieces.push(cur); }
    yield;
    for (const [pa, pb] of pieces) if (pb - pa > 0.5) yield* body2(ctx, run, sec, pa, pb);
  }
  function* body2(ctx, run, sec, a, b) {
    const R = ctx.R;
    for (const [q0, q1] of MetroGuide.ownedRanges(ctx, a, b)) {
      const n = Math.max(1, Math.ceil((q1 - q0) / CELL));
      for (let k = 0; k < n; k++) {
        const s0 = q0 + (q1 - q0) * k / n, s1 = q0 + (q1 - q0) * (k + 1) / n;
        const inJ = MetroGuide.zonesOf(R).some(z => z[1] > s0 && z[0] < s1);
        const ss = ctx.sampleS(R, s0, s1, inJ ? 1.0 : sec.kind === 'box' ? 8 : 6, inJ ? 0.8 : 1.5);          // (fine rows at junctions)
        // the tracks of this section (mine at 0 and my pair's), each with its outer side
        const p = MT.pairAt(R, (s0 + s1) / 2); const tl = [];
        if (p) { const o = p.lat > 0 ? -1 : 1; tl.push({ L: 0, o }, { L: p.lat, o: -o }); } else tl.push({ L: 0, o: -innerSide(R, (s0 + s1) / 2) });
        const id = 'tn:' + R.id + ':' + ctx.ch.k + ':' + s0.toFixed(0);
        const cell = { id, s0, s1, sec, tl, tgb: new MT.TGB(), R };
        // (built in pieces of ~50 m that share their boundary rows, a step each)
        ctx.ch.stage = 'tube:cell'; for (let i0 = 0; i0 < ss.length - 1;) { let i1 = i0 + 1; while (i1 < ss.length - 1 && ss[i1] - ss[i0] < 25) i1++; buildCell(ctx, cell, sec, tl, ss.slice(i0, i1 + 1)); i0 = i1; yield; }
        MetroGuide.midRails(ctx, cell.tgb, R, s0, s1, tl.map(t => t.L));
        ctx.ch.stage = 'tube:strip';
        // where this box meets a bored section (the Oakland box and the Tube, a portal box and the Berkeley Hills
        // bores): a bulkhead across the box with the bores' openings
        if (sec.kind === 'box') {
          const k = R.runs.indexOf(run);
          for (const [sEnd, nb] of [[s1, R.runs[k + 1]], [s0, R.runs[k - 1]]]) {
            if (!nb || !UNDER.has(nb.type) || Math.abs(sEnd - (nb === R.runs[k + 1] ? run.s1 : run.s0)) > 0.6) continue;
            MT.frameAt(R, sEnd, F); const secN = sectionOf(nb.type === 'portal' ? 'cutcover' : nb.type, F.x, F.z);
            if (secN.kind !== 'box') bulkhead(ctx, cell, sEnd, secN, tl, p ? Math.max(1.9, Math.abs(p.lat) / 2 - 0.3) : 2.25);
          }
        }

        // Under cell: a strip along the section centre, per-point floor / ceiling / daylight
        const lo = Math.min(...tl.map(t => t.L)), hi = Math.max(...tl.map(t => t.L)), mid = (lo + hi) / 2;
        const crown = sec.kind === 'box' ? -TB + sec.H : sec.kind === 'shoe' ? sec.spring + sec.R : 1.49 + sec.R;
        const pts = [], day = []; for (let s = s0; ; s = Math.min(s1, s + 10)) { MT.frameAt(R, s, F); pts.push([F.x + F.lx * mid, F.y, F.z + F.lz * mid]); day.push(dayOf(R, s)); if (s >= s1) break; }
        cell.strip = { pts, half: (hi - lo) / 2 + 3.0, below: TB + 1.2, above: crown + 0.6, day };
        cell.lo = lo; cell.hi = hi; cell.crown = crown; cell.mid = mid;
        // junctions: drop what lies inside another track's tunnel (the union of the tunnels remains: an opening in the
        // centre wall where a crossover passes, the split nose of a wye); the cluster's cells then show together
        const zs = MetroGuide.zonesOf(R).filter(z => z[1] > s0 && z[0] < s1);
        if (zs.length) { ctx.ch.stage = 'tube:cull'; cell.zone = zs.map(z => z[2]).filter(Boolean); if (!cell.zone.length) cell.zone = null; yield* cullInside(ctx, cell, p ? [R, p.R2] : [R]); }
        ctx.ch.stage = 'tube:head';
        ctx.B.tcells.push(cell);
        // mouths in this cell: a headwall facing out
        for (const m of mouths(R)) if (m.s >= s0 - 0.5 && m.s <= s1 + 0.5 && m.s >= ctx.s0 && m.s < ctx.s1) {
          const secs = tl.map(t => sec.kind === 'box' ? boxProfile(sec, t.L, t.o, p ? Math.max(1.9, Math.abs(p.lat) / 2 - 0.3) : 2.25) : boreProfile(sec, t.L, t.o));
          headwall(ctx, m.s, m.dir, secs, lo, hi, crown, p ? [R, p.R2] : [R]); cell.mouth = m;
          // the outside of the tunnel for 80 m in from the mouth: where the ground does not cover it (or the terrain is
          // cut open over the mouth) it reads as a concrete portal structure instead of a see-through lining
          const ia = m.dir < 0 ? m.s : Math.max(s0, m.s - 80), ib = m.dir < 0 ? Math.min(s1, m.s + 80) : m.s;
          if (ib - ia > 1) shell(ctx, sec, tl, p ? Math.max(1.9, Math.abs(p.lat) / 2 - 0.3) : 2.25, ia, ib);
          yield;
        }
      }
    }
  }
  // envelope of a tunnel around a track: |lateral| < 2.3 m and top of rail - 0.6 .. + 4.7 m
  // (the other tracks' segments are bucketed in a 6 m grid, so each vertex tests only the few segments near it; the
  // vertices are processed in batches between yields)
  function* cullInside(ctx, cell, own) {
    const gb = cell.tgb, P = gb.pos, I = gb.idx; if (!I.length) return;
    // other underground tracks near this cell, as polylines (x, z, y) around it
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const q of cell.strip.pts) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); }
    const mid = cell.strip.pts[Math.floor(cell.strip.pts.length / 2)], reach = Math.hypot(x1 - x0, z1 - z0) / 2 + 25;
    const GS = 6, grid = new Map(), seg = [];          // seg: [ax, az, ay, bx, bz, by, underground]
    for (const q of MT.net.nearAll(mid[0], mid[2], reach)) {
      const Q = MT.trackOf(q.track); if (!Q || own.includes(Q)) continue;
      const t = Q.t, st = t.step, i0 = Math.max(0, Math.floor((q.s - reach - 30) / st)), i1 = Math.min(t.X.length - 1, Math.ceil((q.s + reach + 30) / st));
      for (let i = i0; i < i1; i++) { if (t.ST[i] < 6 && t.ST[i + 1] < 6) continue; const k = seg.length; seg.push([t.X[i], t.Z[i], t.Y[i], t.X[i + 1], t.Z[i + 1], t.Y[i + 1]]);
        const gx0 = Math.floor((Math.min(t.X[i], t.X[i + 1]) - 2.3) / GS), gx1 = Math.floor((Math.max(t.X[i], t.X[i + 1]) + 2.3) / GS);
        const gz0 = Math.floor((Math.min(t.Z[i], t.Z[i + 1]) - 2.3) / GS), gz1 = Math.floor((Math.max(t.Z[i], t.Z[i + 1]) + 2.3) / GS);
        for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) { const key = gx * 100003 + gz; let l = grid.get(key); if (!l) grid.set(key, l = []); l.push(k); } }
    }
    if (!seg.length) return;
    // a vertex is inside if it lies within another tunnel's envelope; a triangle goes only when all three are inside
    // (the straddlers stay, so no holes open along the intersection; they poke at most one row, 1 m, into the other)
    const ox = ctx.ox, oz = ctx.oz, nv = P.length / 3, ins = new Uint8Array(nv);
    for (let v = 0; v < nv; v++) {
      const x = P[v * 3] + ox, y = P[v * 3 + 1], z = P[v * 3 + 2] + oz, l = grid.get(Math.floor(x / GS) * 100003 + Math.floor(z / GS));
      if (l) for (const k of l) {
        const e = seg[k], ax = e[0], az = e[1], dx = e[3] - ax, dz = e[4] - az, L2 = dx * dx + dz * dz || 1e-9;
        const u = U.clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1), d = (ax + dx * u - x) ** 2 + (az + dz * u - z) ** 2;
        if (d >= 2.15 * 2.15) continue; const by = e[2] + (e[5] - e[2]) * u;
        if (y > by - 0.5 && y < by + 4.5) { ins[v] = 1; break; }
      }
      if ((v & 8191) === 8191) yield;
    }
    const out = new Uint32Array(I.length); let no = 0; for (let k = 0; k < I.length; k += 3) if (!(ins[I[k]] && ins[I[k + 1]] && ins[I[k + 2]])) { out[no++] = I[k]; out[no++] = I[k + 1]; out[no++] = I[k + 2]; }
    gb.setIdx(out.subarray(0, no));
  }
  // after the body job: one mesh per cell (so portal visibility can hide it), outdoor meshes registered with Under
  function* finish(ctx, g) {
    for (const c of ctx.B.tcells || []) {
      const geo = c.tgb.geometry(); c.tgb = null; if (!geo) continue;
      const m = new THREE.Mesh(geo, MATS.tunnel); m.castShadow = false; m.receiveShadow = true; m.matrixAutoUpdate = false; m.updateMatrix(); g.add(m); c.mesh = m;
      yield;
    }
    ctx.ch.pendingCells = ctx.B.tcells || [];
  }
  function quadAt(R, s, c, Ff = F2) {
    MT.frameAt(R, s, Ff); const l0 = c.lo - 2.9, l1 = c.hi + 2.9, h0 = -TB - 1.1, h1 = c.crown + 0.5;
    const P = (l, h) => [Ff.x + Ff.lx * l + Ff.vx * h, Ff.y + Ff.ly * l + Ff.vy * h, Ff.z + Ff.lz * l + Ff.vz * h];
    return [P(l0, h0), P(l1, h0), P(l1, h1), P(l0, h1)];
  }
  function commitCells(ch) {
    if (typeof Under === 'undefined' || !Under.enabled) return;
    const cells = ch.pendingCells || []; ch.cellIds = []; ch.portalIds = [];
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      Under.addCell({ id: c.id, kind: 'tunnel', strip: c.strip, ambient: 0.09, group: c.mesh || null, zone: c.zone || null, terrain: !!c.mouth || c.strip.pts.some((p, k) => c.strip.day[k] > 0.01) });
      ch.cellIds.push(c.id);
    }
    // portals: consecutive cells of this chunk, and at each cell end: the next cell ('auto'), a station face ('auto'),
    // or daylight at a mouth (null)
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i], R = c.R;
      for (const [s, dir] of [[c.s0, -1], [c.s1, 1]]) {
        const nb = cells.find(o => o !== c && o.R === R && Math.abs((dir > 0 ? o.s0 : o.s1) - s) < 0.6);
        const pid = 'pt:' + c.id + ':' + (dir > 0 ? 'b' : 'a');
        if (nb) { if (dir > 0) { Under.addPortal({ id: pid, a: c.id, b: nb.id, quad: quadAt(R, s, c) }); ch.portalIds.push(pid); } continue; }
        const isMouth = c.mouth && Math.abs(c.mouth.s - s) < 1.0;
        if (isMouth) { Under.addPortal({ id: pid, a: c.id, b: null, quad: quadAt(R, s, c) }); ch.portalIds.push(pid); continue; }
        // the probe 3 m past the face (extrapolated along the tangent past a track's end, where the next track begins)
        const sp = s + dir * 3, sc = U.clamp(sp, 0, R.len), over = (sp - sc) * 1; MT.frameAt(R, sc, F2);
        const pr = [F2.x + F2.lx * c.mid + F2.tx * over, F2.y + 1.5 + F2.ty * over, F2.z + F2.lz * c.mid + F2.tz * over];
        Under.addPortal({ id: pid, a: c.id, b: 'auto', dead: true, quad: quadAt(R, s, c), probe: pr }); ch.portalIds.push(pid);
      }
    }
    ch.pendingCells = null;
  }
  function dropCells(ch) {
    if (typeof Under === 'undefined' || !Under.enabled) return;
    for (const id of ch.portalIds || []) Under.remove(id); for (const id of ch.cellIds || []) Under.remove(id); ch.cellIds = []; ch.portalIds = [];
  }
  // the fixture line that lights a track's own geometry (rails, plinths, third rail) in an underground run
  function fixFor(R, s, type) {
    MT.frameAt(R, s, F); const sec = sectionOf(type === 'portal' ? 'cutcover' : type, F.x, F.z);
    const p = MT.pairAt(R, s), o = p ? (p.lat > 0 ? -1 : 1) : -innerSide(R, s);
    const P = sec.kind === 'box' ? boxProfile(sec, 0, o, p ? Math.max(1.9, Math.abs(p.lat) / 2 - 0.3) : 2.25) : boreProfile(sec, 0, o);
    const hF = sec.kind === 'box' ? 2.6 : 2.3; return [P.wallAt(hF) + o * 0.14, hF, sec.lamp, 0];
  }
  function init(o) { MATS = o.MATS; TRACKS = o.TRACKS; }
  return { init, body, finish, commitCells, dropCells, sectionOf, boreProfile, boxProfile, fixFor, chambers, inChamber, spanAt, faceHoles };
})();
if (typeof window !== 'undefined') (window.__baylineMods = window.__baylineMods || {}).MetroTube = MetroTube;   // debug handle
