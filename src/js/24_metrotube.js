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
      for (let s = Math.ceil(ss[0] / sec.doors) * sec.doors + 12; s < ss[ss.length - 1]; s += sec.doors) {
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
  function headwall(ctx, s, dir, secs, lo, hi, crown) {
    const gb = ctx.B.infra; MT.frameAt(ctx.R, s, F);
    const T = [F.tx * dir, 0, F.tz * dir]; const tl = Math.hypot(T[0], T[2]) || 1; T[0] /= tl; T[2] /= tl;
    const Lv = [F.lx, 0, F.lz];
    const x0 = lo - 3.2, x1 = hi + 3.2, ybot = -TB - 1.2;
    let gTop = -1e9; for (const l of [x0, (x0 + x1) / 2, x1]) gTop = Math.max(gTop, MT.groundAt(F.x + F.lx * l + T[0] * 3, F.z + F.lz * l + T[2] * 3) - F.y);
    const top = Math.max(crown + 1.2, Math.min(gTop + 0.9, crown + 9));
    // wall face as an extruded shape with the tunnel openings as holes (x = lateral, y = up, z = outward)
    const shape = new THREE.Shape(); shape.moveTo(x0, ybot); shape.lineTo(x1, ybot); shape.lineTo(x1, top); shape.lineTo(x0, top); shape.closePath();
    for (const sc of secs) { const hole = new THREE.Path(); const pts = sc.arc.concat([sc.floor[0]]); const cw = THREE.ShapeUtils.isClockWise(pts.map(p => new THREE.Vector2(p[0], p[1])));
      const P2 = cw ? pts : pts.slice().reverse(); P2.forEach((p, i) => i ? hole.lineTo(p[0], p[1]) : hole.moveTo(p[0], p[1])); hole.closePath(); shape.holes.push(hole); }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.8, bevelEnabled: false, curveSegments: 4 });
    const m4 = new THREE.Matrix4().makeBasis(new THREE.Vector3(Lv[0], 0, Lv[2]), new THREE.Vector3(0, 1, 0), new THREE.Vector3(T[0], 0, T[2]));
    m4.setPosition(F.x - ctx.ox - T[0] * 0.4, F.y, F.z - ctx.oz - T[2] * 0.4);
    gb.top = F.y + top; gb.gnd = F.y + ybot; gb.wear = 0.9; appendGeo(gb, geo, m4, PAL.concreteWarm); geo.dispose();
    // coping and a fence along the top
    const cc = [F.x + F.lx * (x0 + x1) / 2 - ctx.ox, F.y + top + 0.1, F.z + F.lz * (x0 + x1) / 2 - ctx.oz];
    gb.box(cc[0], cc[1], cc[2], T, [0, 1, 0], Lv, 0.55, 0.1, (x1 - x0) / 2 + 0.1, PAL.concreteLight);
    const fp = []; for (let k = 0; k <= 8; k++) { const l = x0 + (x1 - x0) * k / 8; fp.push([F.x + F.lx * l - ctx.ox, F.y + top + 0.2, F.z + F.lz * l - ctx.oz]); }
    MetroGuide.fenceRun(ctx, fp, 1.5);
    gb.top = 1e4; gb.gnd = -1e4; gb.wear = 0.5;
  }
  function appendGeo(gb, geo, m4, C) {
    const g = geo.index ? geo.toNonIndexed() : geo; const p = g.attributes.position; g.computeVertexNormals(); const n = g.attributes.normal;
    const v = new THREE.Vector3(), nn = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(m4);
    for (let i = 0; i < p.count; i += 3) { const ids = []; for (let k = 0; k < 3; k++) { v.fromBufferAttribute(p, i + k).applyMatrix4(m4); nn.fromBufferAttribute(n, i + k).applyMatrix3(nm).normalize(); ids.push(gb.v(v.x, v.y, v.z, nn.x, nn.y, nn.z, C)); } gb.i.push(ids[0], ids[1], ids[2]); }
    if (g !== geo) g.dispose();
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
  function body(ctx, run, a, b) {
    const R = ctx.R; ctx.B.tcells = ctx.B.tcells || [];
    MT.frameAt(R, (a + b) / 2, F); const sec = sectionOf(run.type === 'portal' ? 'cutcover' : run.type, F.x, F.z);
    for (const [q0, q1] of MetroGuide.ownedRanges(ctx, a, b)) {
      const n = Math.max(1, Math.ceil((q1 - q0) / CELL));
      for (let k = 0; k < n; k++) {
        const s0 = q0 + (q1 - q0) * k / n, s1 = q0 + (q1 - q0) * (k + 1) / n;
        const ss = ctx.sampleS(R, s0, s1, sec.kind === 'box' ? 8 : 6, 1.5);
        // the tracks of this section (mine at 0 and my pair's), each with its outer side
        const p = MT.pairAt(R, (s0 + s1) / 2); const tl = [];
        if (p) { const o = p.lat > 0 ? -1 : 1; tl.push({ L: 0, o }, { L: p.lat, o: -o }); } else tl.push({ L: 0, o: -innerSide(R, (s0 + s1) / 2) });
        const id = 'tn:' + R.id + ':' + ctx.ch.k + ':' + s0.toFixed(0);
        const cell = { id, s0, s1, sec, tl, tgb: new MT.TGB(), R };
        buildCell(ctx, cell, sec, tl, ss);
        // Under cell: a strip along the section centre, per-point floor / ceiling / daylight
        const lo = Math.min(...tl.map(t => t.L)), hi = Math.max(...tl.map(t => t.L)), mid = (lo + hi) / 2;
        const crown = sec.kind === 'box' ? -TB + sec.H : sec.kind === 'shoe' ? sec.spring + sec.R : 1.49 + sec.R;
        const pts = [], day = []; for (let s = s0; ; s = Math.min(s1, s + 10)) { MT.frameAt(R, s, F); pts.push([F.x + F.lx * mid, F.y, F.z + F.lz * mid]); day.push(dayOf(R, s)); if (s >= s1) break; }
        cell.strip = { pts, half: (hi - lo) / 2 + 3.0, below: TB + 1.2, above: crown + 0.6, day };
        cell.lo = lo; cell.hi = hi; cell.crown = crown; cell.mid = mid;
        ctx.B.tcells.push(cell);
        // mouths in this cell: a headwall facing out
        for (const m of mouths(R)) if (m.s >= s0 - 0.5 && m.s <= s1 + 0.5 && m.s >= ctx.s0 && m.s < ctx.s1) {
          const secs = tl.map(t => sec.kind === 'box' ? boxProfile(sec, t.L, t.o, p ? Math.max(1.9, Math.abs(p.lat) / 2 - 0.3) : 2.25) : boreProfile(sec, t.L, t.o));
          headwall(ctx, m.s, m.dir, secs, lo, hi, crown); cell.mouth = m;
        }
      }
    }
  }
  // after the body job: one mesh per cell (so portal visibility can hide it), outdoor meshes registered with Under
  function finish(ctx, g) {
    for (const c of ctx.B.tcells || []) {
      const geo = c.tgb.geometry(); if (!geo) continue;
      const m = new THREE.Mesh(geo, MATS.tunnel); m.castShadow = false; m.receiveShadow = true; m.matrixAutoUpdate = false; m.updateMatrix(); g.add(m); c.mesh = m;
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
      Under.addCell({ id: c.id, kind: 'tunnel', strip: c.strip, ambient: 0.09, group: c.mesh || null, terrain: !!c.mouth || c.strip.pts.some((p, k) => c.strip.day[k] > 0.01) });
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
        MT.frameAt(R, U.clamp(s + dir * 3, 0, R.len), F2); const pr = [F2.x + F2.lx * c.mid, F2.y + 1.5, F2.z + F2.lz * c.mid];
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
  return { init, body, finish, commitCells, dropCells, sectionOf, boreProfile, boxProfile, fixFor };
})();
if (typeof window !== 'undefined') (window.__baylineMods = window.__baylineMods || {}).MetroTube = MetroTube;   // debug handle
