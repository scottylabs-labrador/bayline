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

  // ------------------------------------------------------------------ crossover chambers
  // Underground junction clusters whose tracks run side by side (crossovers, pocket tracks): the lowest-id main track
  // builds one wide cut-and-cover chamber over the cluster (walls 2.01 m outside the outer tracks, 5.3 m high), with end
  // walls around the tunnels that continue; every other track's tunnel inside it is culled away.
  let CHB = null;
  function chambers() {
    if (CHB) return CHB; CHB = []; const net = MT.net, byKey = new Map();
    for (const R of TRACKS) for (const z of MetroGuide.zonesOf(R)) if (z[2]) { let l = byKey.get(z[2]); if (!l) byKey.set(z[2], l = []); l.push({ R, z }); }
    for (const [key, list] of byKey) {
      const mains = list.filter(e => e.R.cls === 'main').sort((a, b) => a.R.id < b.R.id ? -1 : 1); if (!mains.length) continue;
      const own = mains[0], R = own.R, set = new Set(list.map(e => e.R));
      const p = MT.pairAt(R, (own.z[0] + own.z[1]) / 2), partner = p ? p.R2 : null;
      // along the owner: where a crossover / diverging track of the cluster runs within 12 m, underground, outside stations
      const lo = Math.max(0, own.z[0] - 60), hi = Math.min(R.len, own.z[1] + 60); let a = null, b = null;
      for (let q = lo; q <= hi; q += 2) {
        MT.frameAt(R, q, F); if (F.struct < 6 || MT.inStation(R, q, 3)) { if (a !== null) break; continue; }
        let near = false;
        for (const o of net.nearAll(F.x, F.z, 12)) { const Q = MT.trackOf(o.track); if (!Q || Q === R || Q === partner || !set.has(Q)) continue; MT.frameAt(Q, o.s, F2); if (Math.abs(F2.y - F.y) < 3) { near = true; break; } }
        if (near) { if (a === null) a = q; b = q; } else if (a !== null && q - b > 6) break;
      }
      if (a === null || b - a < 12) continue;
      const s0 = Math.max(0, a - 6), s1 = Math.min(R.len, b + 6);
      CHB.push({ key, R, s0, s1, tracks: set, partner });
    }
    return CHB;
  }
  // is a point (world) inside a chamber other than one owned by R?  (projection onto the owner, span + 1.9 m)
  function inChamber(R, x, y, z) {
    for (const c of chambers()) {
      if (c.R === R || !c.tracks.has(R)) continue;
      const t = c.R.t, st = t.step, i0 = Math.max(0, Math.floor(c.s0 / st)), i1 = Math.min(t.X.length - 2, Math.ceil(c.s1 / st));
      let bd = 1e9, bs = 0, bl = 0, by = 0;
      for (let i = i0; i <= i1; i++) { const ax = t.X[i], az = t.Z[i], dx = t.X[i + 1] - ax, dz = t.Z[i + 1] - az, L2 = dx * dx + dz * dz || 1e-9, u = ((x - ax) * dx + (z - az) * dz) / L2;
        if (u < -0.05 && i === i0 || u > 1.05 && i === i1) continue; const u2 = U.clamp(u, 0, 1), d = (ax + dx * u2 - x) ** 2 + (az + dz * u2 - z) ** 2;
        if (d < bd) { bd = d; bs = (i + u2) * st; bl = ((x - ax) * -dz + (z - az) * dx) / Math.sqrt(L2); by = t.Y[i] + (t.Y[i + 1] - t.Y[i]) * u2; } }
      if (bd > 400 || bs < c.s0 || bs > c.s1 || Math.abs(y - by) > 4) continue;
      const sp = spanAt(c.R, bs); if (bl > sp[0] - 1.0 && bl < sp[1] + 1.0) return c;
    }
    return null;
  }
  const chamberOf = (R, s) => { for (const c of chambers()) if (c.R === R && s > c.s0 - 0.5 && s < c.s1 + 0.5) return c; return null; };
  // lateral span of every track near the owner at s (level frame of the owner)
  const _Fs = {}, _Fq = {};
  function spanAt(R, s) {
    MT.frameAt(R, s, _Fs); let lo = 0, hi = 0;
    for (const o of MT.net.nearAll(_Fs.x, _Fs.z, 13)) { MT.frameAt(o.track, o.s, _Fq); if (Math.abs(_Fq.y - _Fs.y) > 3) continue;
      const l = (_Fq.x - _Fs.x) * _Fs.lx + (_Fq.z - _Fs.z) * _Fs.lz; lo = Math.min(lo, l); hi = Math.max(hi, l); }
    return [lo, hi];
  }
  function buildChamber(ctx, chb, a, b) {
    const R = ctx.R, id = 'tc:' + chb.key + ':' + R.id + ':' + a.toFixed(0);
    const cell = { id, s0: a, s1: b, sec: { kind: 'box', H: 5.3, lamp: 15.24, lining: PAL.concrete }, tl: [{ L: 0, o: 1 }], tgb: new MT.TGB(), R, zone: [chb.key], chamber: true };
    const gb = cell.tgb, ss = ctx.sampleS(R, a, b, 1.0, 0.8), top = -TB + 5.3;
    const rows = [], spans = [];
    for (const q of ss) { MT.frameAt(R, q, F); const sp = spanAt(R, q); spans.push(sp); const Lw = sp[0] - 2.01, Rw = sp[1] + 2.01;
      rows.push({ s: q, o: [F.x - ctx.ox, F.y, F.z - ctx.oz], c: [F.x - ctx.ox, F.y, F.z - ctx.oz], r: [F.lx, F.ly, F.lz], u: [F.vx, F.vy, F.vz], t: [F.tx, F.ty, F.tz],
        prof: [[Lw + 0.35, -TB], [Rw - 0.35, -TB], [Rw, -TB + 0.3], [Rw, top - 0.35], [Rw - 0.35, top], [Lw + 0.35, top], [Lw, top - 0.35], [Lw, -TB + 0.3], [Lw + 0.35, -TB]],
        col: [PAL.concreteDark, PAL.concrete, PAL.concrete, PAL.concrete, PAL.concrete, PAL.concrete, PAL.concrete, PAL.concrete] }); }
    // light line on the left wall
    const lo0 = spans[0][0] - 2.01; gb.fix = [lo0 + 0.14, 2.6, 15.24, 0]; gb.wear = 0.8;
    // (TGB needs the reference per row: sweepVar calls gb.v directly, so set ref per row through onRow)
    for (const r0 of rows) r0.onRowRef = true;
    sweepVarT(gb, rows);
    // lamps along the left wall
    for (let q = Math.ceil(a / 15.24) * 15.24; q < b; q += 15.24) { MT.frameAt(R, q, F); setRef(gb, ctx, F); gb.s = q; const sp = spanAt(R, q), wl = sp[0] - 2.01 + 0.06;
      const c = [F.x + F.lx * wl + F.vx * 2.6 - ctx.ox, F.y + 2.6, F.z + F.lz * wl + F.vz * 2.6 - ctx.oz]; const T = [F.tx, F.ty, F.tz], Lv = [F.lx, F.ly, F.lz], Uv = [F.vx, F.vy, F.vz];
      gb.box(c[0], c[1], c[2], T, Uv, Lv, 0.62, 0.07, 0.07, PAL.lampHousing); gb.box(c[0] + F.lx * 0.072, c[1] - 0.005, c[2] + F.lz * 0.072, T, Uv, Lv, 0.58, 0.045, 0.004, PAL.lamp); }
    // end walls with the continuing tunnels as holes
    for (const [q, dir] of [[a, -1], [b, 1]]) {
      const isEnd = (dir < 0 && Math.abs(q - chb.s0) < 0.6) || (dir > 0 && Math.abs(q - chb.s1) < 0.6); if (!isEnd) continue;
      MT.frameAt(R, q, F); const sp = spanAt(R, q);
      const shape = new THREE.Shape(); const Lw = sp[0] - 2.01, Rw = sp[1] + 2.01; shape.moveTo(Lw, -TB - 0.1); shape.lineTo(Rw, -TB - 0.1); shape.lineTo(Rw, top + 0.1); shape.lineTo(Lw, top + 0.1); shape.closePath();
      // one opening per track crossing this face: its tunnel section (bore or box) at its lateral
      MT.frameAt(R, q + dir * 4, F2);
      const px = F2.x, pz = F2.z;
      for (const o of MT.net.nearAll(px, pz, 13)) { const Q = MT.trackOf(o.track); if (!Q) continue; MT.frameAt(Q, o.s, _Fq); if (Math.abs(_Fq.y - F.y) > 3) continue;
        const L = (_Fq.x - F.x) * F.lx + (_Fq.z - F.z) * F.lz, sec = sectionOf(MT.STRUCT[_Fq.struct] || 'cutcover', _Fq.x, _Fq.z), prof = sec.kind === 'box' ? boxProfile(sec, L, 1, 2.25) : boreProfile(sec, L, 1);
        const pts = prof.arc.concat([prof.floor[0]]); const hole = new THREE.Path(); const cw = THREE.ShapeUtils.isClockWise(pts.map(p => new THREE.Vector2(p[0], p[1])));
        (cw ? pts : pts.slice().reverse()).forEach((p, i) => i ? hole.lineTo(p[0], p[1]) : hole.moveTo(p[0], p[1])); hole.closePath(); shape.holes.push(hole); }
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.4, bevelEnabled: false, curveSegments: 4 });
      MT.frameAt(R, q, F); const Tn = [F.tx * dir, 0, F.tz * dir], tl = Math.hypot(Tn[0], Tn[2]) || 1; Tn[0] /= tl; Tn[2] /= tl;
      const m4 = new THREE.Matrix4().makeBasis(new THREE.Vector3(F.lx, 0, F.lz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(Tn[0], 0, Tn[2]));
      m4.setPosition(F.x - ctx.ox, F.y, F.z - ctx.oz); setRef(gb, ctx, F); appendGeo(gb, geo, m4, PAL.concrete); geo.dispose();
    }
    gb.wear = 0.5;
    // Under cell over the whole chamber
    const pts = [], day = []; let hw = 0; for (let k = 0; k < ss.length; k += Math.max(1, Math.floor(ss.length / 20))) { const q = ss[k]; MT.frameAt(R, q, F); const sp = spans[k]; const mid = (sp[0] + sp[1]) / 2; pts.push([F.x + F.lx * mid, F.y, F.z + F.lz * mid]); day.push(0); hw = Math.max(hw, (sp[1] - sp[0]) / 2 + 2.6); }
    MT.frameAt(R, b, F); { const sp = spans[spans.length - 1], mid = (sp[0] + sp[1]) / 2; pts.push([F.x + F.lx * mid, F.y, F.z + F.lz * mid]); day.push(0); }
    cell.strip = { pts, half: hw, below: TB + 1.2, above: top + 0.6, day }; cell.lo = spans[0][0]; cell.hi = spans[0][1]; cell.crown = top; cell.mid = 0;
    return cell;
  }
  // sweepVar for the tunnel builder (sets the reference frame per row)
  function sweepVarT(gb, rows) {
    if (rows.length < 2) return; const np = rows[0].prof.length; let prev = -1;
    for (let i = 0; i < rows.length; i++) {
      const R0 = rows[i], o = R0.o, r = R0.r, u = R0.u, pr = R0.prof; gb.s = R0.s; gb.onRow(R0); const base = gb.count;
      for (let k = 0; k < np - 1; k++) { const A = pr[k], B = pr[k + 1]; let nl = -(B[1] - A[1]), nu = B[0] - A[0]; const L = Math.hypot(nl, nu) || 1; nl /= L; nu /= L;
        const nx = r[0] * nl + u[0] * nu, ny = r[1] * nl + u[1] * nu, nz = r[2] * nl + u[2] * nu, C = R0.col[k];
        gb.v(o[0] + r[0] * A[0] + u[0] * A[1], o[1] + r[1] * A[0] + u[1] * A[1], o[2] + r[2] * A[0] + u[2] * A[1], nx, ny, nz, C);
        gb.v(o[0] + r[0] * B[0] + u[0] * B[1], o[1] + r[1] * B[0] + u[1] * B[1], o[2] + r[2] * B[0] + u[2] * B[1], nx, ny, nz, C); }
      if (prev >= 0) for (let k = 0; k < np - 1; k++) { const a0 = prev + 2 * k, a1 = base + 2 * k; gb.i.push(a0, a0 + 1, a1, a0 + 1, a1 + 1, a1); }
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
  function body(ctx, run, a, b) {
    const R = ctx.R; ctx.B.tcells = ctx.B.tcells || [];
    MT.frameAt(R, (a + b) / 2, F); const sec = sectionOf(run.type === 'portal' ? 'cutcover' : run.type, F.x, F.z);
    // chambers owned by this track inside [a, b]: build them, and the normal section only outside them
    const mine = chambers().filter(c => c.R === R && c.s1 > a && c.s0 < b).sort((x, y) => x.s0 - y.s0);
    if (mine.length) {
      let cur = a;
      for (const c of mine) { const ca = Math.max(a, c.s0), cb = Math.min(b, c.s1); if (ca > cur + 0.5) body1(ctx, run, sec, cur, ca); ctx.B.tcells.push(buildChamber(ctx, c, ca, cb)); cur = cb; }
      if (b > cur + 0.5) body1(ctx, run, sec, cur, b);
      return;
    }
    body1(ctx, run, sec, a, b);
  }
  function body1(ctx, run, sec, a, b) {
    const R = ctx.R;
    // pieces of [a, b] outside any chamber (another track's) that swallows this track
    const pieces = []; { let cur = null; for (let q = a; ; q = Math.min(b, q + 2)) { MT.frameAt(R, q, F); const inside = !!inChamber(R, F.x, F.y, F.z);
      if (!inside) { if (!cur) cur = [q, q]; else cur[1] = q; } else if (cur) { pieces.push(cur); cur = null; } if (q >= b) break; } if (cur) pieces.push(cur); }
    for (const [pa, pb] of pieces) if (pb - pa > 0.5) body2(ctx, run, sec, pa, pb);
  }
  function body2(ctx, run, sec, a, b) {
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
        buildCell(ctx, cell, sec, tl, ss);

        // Under cell: a strip along the section centre, per-point floor / ceiling / daylight
        const lo = Math.min(...tl.map(t => t.L)), hi = Math.max(...tl.map(t => t.L)), mid = (lo + hi) / 2;
        const crown = sec.kind === 'box' ? -TB + sec.H : sec.kind === 'shoe' ? sec.spring + sec.R : 1.49 + sec.R;
        const pts = [], day = []; for (let s = s0; ; s = Math.min(s1, s + 10)) { MT.frameAt(R, s, F); pts.push([F.x + F.lx * mid, F.y, F.z + F.lz * mid]); day.push(dayOf(R, s)); if (s >= s1) break; }
        cell.strip = { pts, half: (hi - lo) / 2 + 3.0, below: TB + 1.2, above: crown + 0.6, day };
        cell.lo = lo; cell.hi = hi; cell.crown = crown; cell.mid = mid;
        // junctions: drop what lies inside another track's tunnel (the union of the tunnels remains: an opening in the
        // centre wall where a crossover passes, the split nose of a wye); the cluster's cells then show together
        const zs = MetroGuide.zonesOf(R).filter(z => z[1] > s0 && z[0] < s1);
        if (zs.length) { cell.zone = zs.map(z => z[2]).filter(Boolean); if (!cell.zone.length) cell.zone = null; cullInside(ctx, cell, p ? [R, p.R2] : [R]); }
        ctx.B.tcells.push(cell);
        // mouths in this cell: a headwall facing out
        for (const m of mouths(R)) if (m.s >= s0 - 0.5 && m.s <= s1 + 0.5 && m.s >= ctx.s0 && m.s < ctx.s1) {
          const secs = tl.map(t => sec.kind === 'box' ? boxProfile(sec, t.L, t.o, p ? Math.max(1.9, Math.abs(p.lat) / 2 - 0.3) : 2.25) : boreProfile(sec, t.L, t.o));
          headwall(ctx, m.s, m.dir, secs, lo, hi, crown); cell.mouth = m;
        }
      }
    }
  }
  // envelope of a tunnel around a track: |lateral| < 2.3 m and top of rail - 0.6 .. + 4.7 m
  function cullInside(ctx, cell, own) {
    const gb = cell.tgb, P = gb.p, I = gb.i; if (!I.length) return;
    // other underground tracks near this cell, as polylines (x, z, y) around it
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const q of cell.strip.pts) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); }
    const envs = [];
    const mid = cell.strip.pts[Math.floor(cell.strip.pts.length / 2)], reach = Math.hypot(x1 - x0, z1 - z0) / 2 + 25;
    for (const q of MT.net.nearAll(mid[0], mid[2], reach)) {
      const Q = MT.trackOf(q.track); if (!Q || own.includes(Q)) continue;
      const t = Q.t, st = t.step, i0 = Math.max(0, Math.floor((q.s - reach - 30) / st)), i1 = Math.min(t.X.length - 1, Math.ceil((q.s + reach + 30) / st));
      const pts = []; for (let i = i0; i <= i1; i++) { const c = t.ST[i]; pts.push(t.X[i], t.Z[i], t.Y[i], c >= 6 ? 1 : 0); }
      if (pts.length >= 8) envs.push(pts);
    }
    if (!envs.length) return;
    // a vertex is inside if it lies within another tunnel's envelope; a triangle goes only when all three are inside
    // (the straddlers stay, so no holes open along the intersection; they poke at most one row, 1 m, into the other)
    const ox = ctx.ox, oz = ctx.oz, nv = P.length / 3, ins = new Uint8Array(nv);
    for (let v = 0; v < nv; v++) {
      const x = P[v * 3] + ox, y = P[v * 3 + 1], z = P[v * 3 + 2] + oz;
      for (const e of envs) {
        let bd = 1e9, by = 0, bu = 0;
        for (let i = 0; i + 4 < e.length; i += 4) {
          const ax = e[i], az = e[i + 1], dx = e[i + 4] - ax, dz = e[i + 5] - az, L2 = dx * dx + dz * dz || 1e-9;
          const u = U.clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1), d = (ax + dx * u - x) ** 2 + (az + dz * u - z) ** 2;
          if (d < bd) { bd = d; by = e[i + 2] + (e[i + 6] - e[i + 2]) * u; bu = e[i + 3]; }
        }
        if (bu && bd < 2.15 * 2.15 && y > by - 0.5 && y < by + 4.5) { ins[v] = 1; break; }
      }
    }
    const out = []; for (let k = 0; k < I.length; k += 3) if (!(ins[I[k]] && ins[I[k + 1]] && ins[I[k + 2]])) out.push(I[k], I[k + 1], I[k + 2]);
    gb.i = out;
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
  return { init, body, finish, commitCells, dropCells, sectionOf, boreProfile, boxProfile, fixFor };
})();
if (typeof window !== 'undefined') (window.__baylineMods = window.__baylineMods || {}).MetroTube = MetroTube;   // debug handle
