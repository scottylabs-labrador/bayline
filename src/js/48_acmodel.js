// ACModel: procedural 3D aircraft from the parameters in 46_aircraft.js. A lofted fuselage (two-halved UVs so a
// side-view livery canvas reads correctly on both sides: windows, doors, cheatline, titles, registration), wings
// and tails lofted from NACA sections with washout, dihedral and sweep, hinged ailerons / flaps / spoilers /
// elevators / rudder, winglets, sharklets or raked tips, turbofan nacelles with spinning fans and translating
// reverser sleeves, propellers, afterburner flame, retracting and compressing landing gear with spinning wheels,
// nav / strobe / beacon / landing / taxi / logo lights and lit cabin windows at night. The cockpit view uses the
// same nose from inside (window openings cut by an alpha mask) plus a glare shield and a live instrument panel.
//   const m = ACModel.build(type)        m.root (Object3D, model axes x fwd, y up, z right, origin = CG)
//   m.update(ac, dt, { night, inside })  animate from the FDM state;  m.panel (canvas texture for instruments)
//   m.eye (model-space eye point), m.dispose()
// Fictional "Bayline Air" scheme; types are named for identification only.
const ACModel = (() => {
  const D = Math.PI / 180, V3 = THREE.Vector3;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const P = (x, y, z) => new V3(x, -z, y);                      // spec FRD (x fwd, y right, z down) -> model (x fwd, y up, z right)
  const hex = (c) => { const k = new THREE.Color(c); return [k.r, k.g, k.b]; };

  // ---------------------------------------------------------------- geometry builder
  class GB {
    constructor() { this.p = []; this.uv = []; this.c = []; this.i = []; }
    v(p, u, v, col) { this.p.push(p.x, p.y, p.z); this.uv.push(u, v); this.c.push(col[0], col[1], col[2]); return this.p.length / 3 - 1; }
    q(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
    t(a, b, c) { this.i.push(a, b, c); }
    get n() { return this.p.length / 3; }
    geo() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3)); g.setIndex(this.i); g.computeVertexNormals(); return g;
    }
  }
  function mirrorZ(g) {                                  // left from right: z -> -z, flip winding
    const m = g.clone(); const p = m.attributes.position; for (let i = 0; i < p.count; i++) p.setZ(i, -p.getZ(i));
    const idx = m.index.array; for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    m.computeVertexNormals(); return m;
  }

  // ---------------------------------------------------------------- airfoil sections
  // NACA 4-digit thickness (closed trailing edge) + a simple camber line; returns the open strip upper TE -> LE ->
  // lower TE for chord fractions [from, to] (cut sections get a flat face where they are cut)
  function yt(x, t) { return 5 * t * (0.2969 * Math.sqrt(Math.max(x, 0)) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4); }
  function yc(x, m) { const p = 0.4; return x < p ? m / (p * p) * (2 * p * x - x * x) : m / ((1 - p) ** 2) * ((1 - 2 * p) + 2 * p * x - x * x); }
  const NF = 14;
  const XS = Array.from({ length: NF + 1 }, (_, i) => (1 - Math.cos(Math.PI * i / NF)) / 2);
  function foil(t, m, from = 0, to = 1) {
    const xs = [from, ...XS.filter(x => x > from + 1e-3 && x < to - 1e-3), to];
    const up = xs.slice().reverse().map(x => [x, yc(x, m) + yt(x, t)]);
    const lo = xs.slice(from < 1e-3 ? 1 : 0).map(x => [x, yc(x, m) - yt(x, t)]);
    return up.concat(lo);        // length = 2 * xs.length - (from ? 0 : 1)
  }

  // loft a surface through sections { o: leading-edge point, c: chord, cd: unit aft, ud: unit thickness dir, t, m, v }
  // col(x) -> rgb by chord fraction; caps: close the first / last section; strip: open strip + a flat closing face
  function loft(gb, secs, from, to, col, capA, capB) {
    const loops = secs.map(s => foil(s.t, s.m || 0, from, to));
    const n = loops[0].length, base = [];
    secs.forEach((s, j) => {
      const b = gb.n; base.push(b);
      for (const [x, y] of loops[j]) gb.v(s.o.clone().addScaledVector(s.cd, x * s.c).addScaledVector(s.ud, y * s.c), x, s.v !== undefined ? s.v : j / (secs.length - 1), col(x, y));
    });
    for (let j = 0; j + 1 < secs.length; j++) for (let i = 0; i + 1 < n; i++) gb.q(base[j] + i, base[j + 1] + i, base[j + 1] + i + 1, base[j] + i + 1);
    // closing face (trailing edge or cut): its own vertices so the shading stays sharp
    const face = (k0, k1) => { const f0 = [], f1 = []; secs.forEach((s, j) => { const a = loops[j][k0], bq = loops[j][k1];
      f0.push(gb.v(s.o.clone().addScaledVector(s.cd, a[0] * s.c).addScaledVector(s.ud, a[1] * s.c), a[0], 0, col(a[0], 0)));
      f1.push(gb.v(s.o.clone().addScaledVector(s.cd, bq[0] * s.c).addScaledVector(s.ud, bq[1] * s.c), bq[0], 0, col(bq[0], 0))); });
      for (let j = 0; j + 1 < secs.length; j++) gb.q(f1[j], f1[j + 1], f0[j + 1], f0[j]); };
    face(0, n - 1);
    if (from > 1e-3) {}    // the front of a cut-off surface sits inside the wing's cutout
    const cap = (j, flip) => { const s = secs[j], L = loops[j]; const c0 = gb.n; for (const [x, y] of L) gb.v(s.o.clone().addScaledVector(s.cd, x * s.c).addScaledVector(s.ud, y * s.c), x, 1, col(x, y));
      for (let i = 1; i + 1 < n; i++) flip ? gb.t(c0, c0 + i + 1, c0 + i) : gb.t(c0, c0 + i, c0 + i + 1); };
    if (capA) cap(0, true); if (capB) cap(secs.length - 1, false);
  }

  // ---------------------------------------------------------------- a lifting surface (right side; mirrored for the left)
  // w: { x (LE at root), y0, span, c0, cK?, yK?, c1, sweep, dih, z, t, tt, twist, cam } plus surfaces [{ y0, y1, cf, kind }]
  // returns { fixed: geometry, parts: [{ geo, a, b (hinge, model), kind, y0, y1 }] }
  function surface(w, surfs, opt = {}) {
    const vert = !!opt.vertical, cam = w.cam !== undefined ? w.cam : (vert ? 0 : 0.018);
    const tanS = Math.tan(w.sweep * D), tanD = Math.tan((w.dih || 0) * D);
    const span = w.span, y0 = w.y0 || 0;
    const chord = (y) => w.yK ? (y < w.yK ? w.c0 + (w.cK - w.c0) * (y - y0) / (w.yK - y0) : w.cK + (w.c1 - w.cK) * (y - w.yK) / (span - w.yK)) : w.c0 + (w.c1 - w.c0) * (y - y0) / (span - y0);
    const rake = w.tip === 'raked' ? span - 0.12 * (span - y0) : 1e9;
    const leX = (y) => w.x - (Math.min(y, rake) - y0) * tanS - Math.max(0, y - rake) * Math.tan(Math.min(70, w.sweep + 22) * D);
    const flex = (y) => w.flex ? w.flex * ((y - y0) / (span - y0)) ** 2 : 0;
    const sec = (y, cf) => {
      const f = (y - y0) / Math.max(span - y0, 1e-3), inc = (w.twist || 0) * f * D, c = y > rake ? chord(rake) * (1 - 0.72 * (y - rake) / (span - rake)) : chord(y);
      let o, cd, ud;
      if (!vert) { o = new V3(leX(y), -w.z + (y - y0) * tanD + flex(y), y); cd = new V3(-Math.cos(inc), -Math.sin(inc), 0); ud = new V3(-Math.sin(inc), Math.cos(inc), 0); }
      else { o = new V3(leX(y), -w.z + y, 0); cd = new V3(-1, 0, 0); ud = new V3(0, 0, -1); }
      return { o, c, cd, ud, t: w.t + (w.tt - w.t) * f, m: cam, v: f };
    };
    // stations: the root, every surface edge, the kink, the tip
    const ys = new Set([y0, span]); if (w.yK) ys.add(w.yK); if (rake < span) ys.add(rake);
    for (const s of surfs) { ys.add(clamp(s.y0, y0, span)); ys.add(clamp(s.y1, y0, span)); }
    const Y = [...ys].sort((a, b) => a - b);
    const fine = []; for (let i = 0; i + 1 < Y.length; i++) { const n = Math.max(1, Math.ceil((Y[i + 1] - Y[i]) / Math.max(1.2, span / 14))); for (let k = 0; k < n; k++) fine.push(Y[i] + (Y[i + 1] - Y[i]) * k / n); } fine.push(span);
    const metal = hex(opt.metal || '#c9ced4'), paint = hex(opt.color || '#dfe3e8'), walk = hex(opt.edge || opt.color || '#dfe3e8');
    const colF = (x) => x < 0.07 && !opt.noMetal ? metal : x > 0.97 ? walk : paint;
    const gb = new GB(), parts = [];
    // panels between consecutive stations; cut where a surface runs
    for (let i = 0; i + 1 < fine.length; i++) {
      const ya = fine[i], yb = fine[i + 1], ym = (ya + yb) / 2;
      const s = surfs.find(q => ym > q.y0 && ym < q.y1);
      const to = s ? 1 - s.cf : 1;
      loft(gb, [sec(ya), sec(yb)], 0, to, colF, false, i + 2 === fine.length && !opt.openTip);
    }
    // surfaces: one hinged part per surface
    for (const s of surfs) {
      const ya = clamp(s.y0, y0, span), yb = clamp(s.y1, y0, span); if (yb - ya < 0.05) continue;
      const pg = new GB(); const st = [];
      for (const y of fine) if (y >= ya - 1e-6 && y <= yb + 1e-6) st.push(sec(y));
      if (st.length < 2) st.splice(0, st.length, sec(ya), sec(yb));
      loft(pg, st, 1 - s.cf, 1, () => s.kind === 'spoiler' ? paint : paint, true, true);
      const hinge = (q) => q.o.clone().addScaledVector(q.cd, (1 - s.cf) * q.c).addScaledVector(q.ud, yc(1 - s.cf, cam) * q.c);
      parts.push({ gb: pg, a: hinge(st[0]), b: hinge(st[st.length - 1]), kind: s.kind, cf: s.cf, c: (st[0].c + st[st.length - 1].c) / 2, cd: st[0].cd.clone(), ud: st[0].ud.clone() });
    }
    // spoiler panels: thin plates over the upper surface ahead of the flaps
    for (const sp of opt.spoilers || []) {
      const pg = new GB(); const st = []; for (const y of fine) if (y >= sp[0] - 1e-6 && y <= sp[1] + 1e-6) st.push(sec(y));
      if (st.length < 2) continue;
      const f0 = 0.58, f1 = 0.7, base = [];
      st.forEach(q => { const b = pg.n; base.push(b); for (let k = 0; k <= 4; k++) { const x = f0 + (f1 - f0) * k / 4; pg.v(q.o.clone().addScaledVector(q.cd, x * q.c).addScaledVector(q.ud, (yc(x, cam) + yt(x, q.t)) * q.c + 0.012), x, 0, paint); } });
      for (let j = 0; j + 1 < st.length; j++) for (let k = 0; k < 4; k++) pg.q(base[j] + k, base[j + 1] + k, base[j + 1] + k + 1, base[j] + k + 1);
      const hp = (q) => q.o.clone().addScaledVector(q.cd, f0 * q.c).addScaledVector(q.ud, (yc(f0, cam) + yt(f0, q.t)) * q.c + 0.012);
      parts.push({ gb: pg, a: hp(st[0]), b: hp(st[st.length - 1]), kind: 'spoiler', twoSided: true });
    }
    return { gb, parts, sec, leX, chord, span };
  }

  // ---------------------------------------------------------------- fuselage
  // returns { geo, section(s) -> { top, bot, hw } in model y / z, the canvas mapping }
  function fuselageProfile(m) {
    const F = m.fus, L = m.L, nose = m.nose;
    if (m.kind === 'jet') {
      const Rw = F.d / 2, Rh = F.h / 2, yc0 = -F.zc, NL = F.noseLen, TL = F.tailLen;
      return (s) => {
        let top = yc0 + Rh, bot = yc0 - Rh, hw = Rw;
        if (s < NL && F.pointy) {          // a needle nose (Concorde)
          const t = s / NL, k = Math.pow(t, 0.72), tip = yc0 - 0.05 * Rh;
          hw = Rw * k; top = tip + (yc0 + Rh - tip) * Math.pow(t, 0.62); bot = tip - (tip - (yc0 - Rh)) * Math.pow(t, 0.85);
        } else if (s < NL) {
          const t = s / NL, tip = yc0 - 0.18 * Rh;
          const kw = Math.pow(1 - Math.pow(1 - t, F.smoothNose ? 2.0 : 2.3), 0.5);
          hw = Rw * kw;
          top = tip + (yc0 + Rh - tip) * Math.pow(1 - Math.pow(1 - t, F.smoothNose ? 2.2 : 2.7), 0.55);
          bot = tip - (tip - (yc0 - Rh)) * Math.pow(1 - Math.pow(1 - t, 2.0), 0.5);
        } else if (s > L - TL) {
          const u = (s - (L - TL)) / TL;
          top = yc0 + Rh - 0.22 * Rh * u * u;
          bot = yc0 - Rh + (1.72 * Rh) * Math.pow(u, 1.45);
          hw = Rw * (1 - 0.87 * Math.pow(u, 1.25));
        }
        if (F.hump) {   // 747 upper deck
          const h = F.hump, x = nose - s, a = sstep(nose, h.x0 - 3.5, x) * (1 - sstep(h.x1 + 6, h.x1 - 2, x));
          const noseT = s < NL ? Math.pow(Math.min(1, s / NL), 0.8) : 1;
          top += h.h * a * noseT;
        }
        return { top, bot, hw };
      };
    }
    if (m.kind === 'ga') {
      const W = F.w / 2, H = F.h / 2, yc0 = -F.zc, C = F.cowl || 1.5, WS = F.ws || 0.8, CB = F.cabin || 3.9, roof = F.low ? 1.0 : 1.2;
      return (s) => {
        let hw = W, top = yc0 + H, bot = yc0 - H;
        if (s < 0.35) { const t = s / 0.35; hw = W * (0.3 + 0.62 * Math.sqrt(t)); top = yc0 + H * (0.1 + 0.55 * Math.sqrt(t)); bot = yc0 - H * (0.35 + 0.55 * Math.sqrt(t)); }
        else if (s < C) { const t = (s - 0.35) / (C - 0.35); hw = W * (0.92 + 0.08 * t); top = yc0 + H * (0.65 + 0.1 * t); bot = yc0 - H * (0.9 + 0.1 * t); }   // cowling / nose
        else if (s < C + WS) { const t = (s - C) / WS; top = yc0 + H * (0.75 + (roof - 0.75) * sstep(0, 1, t)); }   // windshield up to the roof or wing
        else if (s < CB) { top = yc0 + H * roof; }                                                               // cabin
        else { const u = (s - CB) / (L - CB); hw = W * (1 - (1 - F.tailW / F.w * 2) * Math.pow(u, 0.9)); top = yc0 + H * roof - (H * roof - (-F.tailZ + F.tailH / 2 - yc0)) * sstep(0, 0.55, u);
          bot = yc0 - H + (H + (-F.tailZ - F.tailH / 2) - yc0) * Math.pow(u, 0.7); }
        return { top, bot, hw };
      };
    }
    // fighter: radome, canopy fairing, intake trunk and the aft body to the nozzle
    const W = F.w / 2, H = F.h / 2, yc0 = -F.zc;
    return (s) => {
      let hw, top, bot;
      if (s < 3.2) { const t = s / 3.2, k = Math.pow(1 - Math.pow(1 - t, 2.2), 0.5); hw = 0.45 * k; top = yc0 + 0.02 + 0.43 * k; bot = yc0 + 0.02 - 0.43 * k; }
      else if (s < 6.2) { const t = (s - 3.2) / 3; hw = 0.45 + (W - 0.45) * sstep(0, 1, t); top = yc0 + 0.45 + 0.35 * sstep(0, 1, t); bot = yc0 - 0.43 - (H - 0.43) * sstep(0, 1, t); }
      else if (s < 11.5) { hw = W; top = yc0 + 0.8 - 0.1 * (s - 6.2) / 5.3; bot = yc0 - H; }
      else { const u = (s - 11.5) / (L - 11.5); hw = W - (W - 0.6) * sstep(0, 1, u); top = yc0 + 0.7 - 0.1 * u; bot = yc0 - H + (H - 0.55) * sstep(0, 1, u); }
      return { top, bot, hw };
    };
  }
  function fuselage(m) {
    const prof = fuselageProfile(m), L = m.L, nose = m.nose, NA = 44, NS = 96;
    const pow = m.kind === 'ga' ? 2.6 : m.kind === 'fighter' ? 2.2 : 2.0;      // superellipse: boxier small fuselages
    const gb = new GB(), white = [1, 1, 1];
    const ss = []; for (let i = 0; i <= NS; i++) { const t = i / NS; ss.push(L * (0.55 * t + 0.45 * (0.5 - 0.5 * Math.cos(Math.PI * t)))); }
    const pt = (s, th) => { const q = prof(s), yc0 = (q.top + q.bot) / 2, rh = (q.top - q.bot) / 2, c = Math.cos(th), sn = Math.sin(th);
      const ec = Math.sign(c) * Math.pow(Math.abs(c), 2 / pow), es = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / pow);
      return new V3(nose - s, yc0 + rh * ec, q.hw * es); };
    // two halves with their own UVs (see the header): right side v in [0.5, 1], left side v in [0, 0.5]
    for (const half of [0, 1]) {
      const b0 = gb.n;
      for (let i = 0; i <= NS; i++) for (let k = 0; k <= NA / 2; k++) {
        const th = half ? Math.PI * k / (NA / 2) : Math.PI + Math.PI * k / (NA / 2);    // right: top -> bottom; left: bottom -> top
        const s = ss[i], xn = s / L;
        const u = half ? 1 - xn : xn, v = half ? 0.5 + 0.5 * k / (NA / 2) : 0.5 * (1 - k / (NA / 2));
        gb.v(pt(s, th), u, v, white);
      }
      const R = NA / 2 + 1;
      for (let i = 0; i < NS; i++) for (let k = 0; k < NA / 2; k++) { const a = b0 + i * R + k; gb.q(a, a + R, a + R + 1, a + 1); }
    }
    const g = gb.geo();
    // make sure the faces point outward (winding from the parametrisation): flip if the nose-cone normal points inward
    return { geo: g, prof, pt };
  }

  // ---------------------------------------------------------------- livery (side-view canvas, both sides) and masks
  // cockpit window panes, defined from the pilot's seat: azimuth (0 ahead, + outward) and elevation ranges, degrees
  const PANES = {
    jet: [{ az: [-75, 36], el: [-19, 15], post: 0.06 }, { az: [40, 82], el: [-14, 13] }, { az: [86, 116], el: [-12, 11] }],
    ga: [{ az: [-80, 56], el: [-9, 34], post: 0.025 }, { az: [60, 128], el: [-30, 24] }, { az: [132, 165], el: [-20, 14] }],
    fighter: [{ az: [-180, 180], el: [-30, 90] }],
  };
  const MW = 2048, MH = 512;
  function windowMask(m, pt, eyeM) {       // Uint8Array MW x MH: 1 where a cockpit window is
    const L = m.L, out = new Uint8Array(MW * MH), panes = PANES[m.kind] || PANES.jet;
    const sE = m.nose - eyeM.x, sMax = sE + (m.kind === 'fighter' ? 1.4 : m.kind === 'ga' ? 2.2 : 1.6), sMin = m.kind === 'fighter' ? sE - 2.6 : 0;
    for (let py = 0; py < MH; py++) for (let px = 0; px < MW; px++) {
      const u = (px + 0.5) / MW, v = (py + 0.5) / MH, right = v >= 0.5, th = (right ? v - 0.5 : v) * 2 * Math.PI;
      const s = right ? (1 - u) * L : u * L; if (s > sMax || s < sMin) continue;
      const P = pt(s, right ? th : 2 * Math.PI - th), side = right ? 1 : -1;
      const dx = P.x - eyeM.x, dy = P.y - eyeM.y, dz = P.z - side * Math.abs(eyeM.z), lat = dz * side;
      const az = Math.atan2(lat, dx) / D, el = Math.atan2(dy, Math.hypot(dx, dz)) / D;
      for (const w of panes) if (az >= w.az[0] && az <= w.az[1] && el >= w.el[0] && el <= w.el[1] && (!w.post || Math.abs(P.z) > w.post)) { out[py * MW + px] = 1; break; }
    }
    return out;
  }
  function livery(type, m, prof, pt, eyeM) {
    const kind = m.kind, L = m.L, lv = m.livery;
    const W = kind === 'ga' ? 2048 : kind === 'fighter' ? 2048 : 4096, H = W / 4, ppm = W / L;
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const cv = mk(), g = cv.getContext('2d'), ce = document.createElement('canvas'); ce.width = W / 2; ce.height = H / 2; const ge = ce.getContext('2d');
    const cm = document.createElement('canvas'); cm.width = MW; cm.height = MH; const gm = cm.getContext('2d');
    const F = m.fus, yAxis = kind === 'jet' ? -F.zc : -(F.zc || 0);
    // canvas y for a model height at distance s from the nose (both sides): v = theta / pi / 2
    const vOf = (s, y) => { const q = prof(s), c = (q.top + q.bot) / 2, r = (q.top - q.bot) / 2; return Math.acos(clamp((y - c) / r, -1, 1)) / Math.PI * 0.5; };
    const X = (s, right) => right ? W - s * ppm : s * ppm;
    const Yc = (v, right) => (right ? 0.5 + v : v) * H;
    g.fillStyle = lv.base; g.fillRect(0, 0, W, H);
    ge.fillStyle = '#000'; ge.fillRect(0, 0, W / 2, H / 2);
    gm.fillStyle = '#fff'; gm.fillRect(0, 0, MW, MH);
    const both = (fn) => { fn(false); fn(true); };
    const rect = (ctx, s0, s1, v0, v1, right, sx = 1, sy = 1) => { const xa = X(s0, right) * sx, xb = X(s1, right) * sx; ctx.fillRect(Math.min(xa, xb), Yc(v0, right) * sy, Math.abs(xb - xa), (v1 - v0) * H * sy); };
    if (kind === 'jet') {
      const wn = m.windows, Rh = F.h / 2;
      // belly and cheatline
      both(r => { g.fillStyle = lv.belly || '#dde1e5'; rect(g, 0, L, 0.3, 0.5, r); g.fillStyle = lv.stripe; rect(g, F.noseLen * 0.8, L - F.tailLen * 0.5, 0.265, 0.285, r); g.fillStyle = lv.tail; rect(g, F.noseLen * 0.8, L - F.tailLen * 0.45, 0.288, 0.3, r); });
      // tail section in the tail colour sweeping up the aft fuselage
      both(r => { g.fillStyle = lv.tail; g.beginPath(); const s0 = L - F.tailLen * 0.85; g.moveTo(X(s0, r), Yc(0.3, r)); g.lineTo(X(L, r), Yc(0.0, r)); g.lineTo(X(L, r), Yc(0.5, r)); g.lineTo(X(s0 + 2, r), Yc(0.5, r)); g.closePath(); g.fill(); });
      // cabin windows (+ lit at night), doors
      const vw = vOf(L * 0.5, yAxis + (-wn.z)), wh = (wn.h || 0.34) / (Math.PI * Rh) * 0.5, ww = 0.24 * ppm;
      both(r => {
        for (let x = m.nose - wn.x0; x < m.nose - wn.x1; x += wn.pitch) {
          if (wn.doors && wn.doors.some(d => Math.abs((m.nose - d) - x) < 0.9)) continue;
          const cx = X(x, r), cy = Yc(vw, r);
          g.fillStyle = '#1c232c'; g.beginPath(); g.roundRect(cx - ww / 2, cy - wh * H / 2, ww, wh * H, ww * 0.45); g.fill();
          g.fillStyle = 'rgba(160,190,215,.25)'; g.fillRect(cx - ww / 2 + 2, cy - wh * H / 2 + 2, ww * 0.35, wh * H * 0.4);
          ge.fillStyle = '#ffd9a0'; ge.beginPath(); ge.roundRect(cx / 2 - ww / 4, cy / 2 - wh * H / 4, ww / 2, wh * H / 2, ww * 0.2); ge.fill();
        }
        for (const d of wn.doors || []) { const s = m.nose - d, v0 = vOf(s, yAxis + 1.25), v1 = vOf(s, yAxis - 0.75);
          g.strokeStyle = 'rgba(40,46,54,.55)'; g.lineWidth = 3; g.beginPath(); g.roundRect(X(s, r) - 0.5 * ppm, Yc(v0, r), 1.0 * ppm, (v1 - v0) * H, 0.15 * ppm); g.stroke();
          g.fillStyle = '#1c232c'; g.beginPath(); g.arc(X(s, r), Yc(vw, r), ww * 0.35, 0, 7); g.fill(); }
        if (wn.upper) for (let x = m.nose - wn.upper.x0; x < m.nose - wn.upper.x1; x += 0.508) {
          const vv = vOf(x, yAxis - wn.upper.z), cx = X(x, r), cy = Yc(vv, r);
          g.fillStyle = '#1c232c'; g.beginPath(); g.roundRect(cx - ww / 2, cy - wh * H * 0.45, ww, wh * H * 0.9, ww * 0.45); g.fill();
          ge.fillStyle = '#ffd9a0'; ge.fillRect(cx / 2 - ww / 4, cy / 2 - wh * H / 4, ww / 2, wh * H / 2); }
      });
      // titles and registration
      both(r => {
        const th = Math.min(0.95, F.h * 0.23);
        g.save(); g.fillStyle = lv.stripe; g.font = `700 ${Math.round(th * ppm)}px "Barlow Condensed", "Arial Narrow", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        const vt = vOf(L * 0.3, yAxis + (-wn.z) + th * 1.1);
        g.fillText('BAYLINE AIR', X(F.noseLen + L * 0.22, r), Yc(vt, r));
        g.fillStyle = '#6b7480'; g.font = `600 ${Math.round(0.36 * ppm)}px "Barlow Condensed", sans-serif`;
        g.fillText(lv.reg, X(L - F.tailLen * 0.62, r), Yc(vOf(L - F.tailLen * 0.62, yAxis + 0.2), r));
        g.restore();
      });
    } else if (kind === 'ga') {
      const s0 = 1.5;
      both(r => {
        g.fillStyle = lv.stripe; rect(g, 0.3, L - 0.3, 0.3, 0.335, r); g.fillStyle = lv.stripe2; rect(g, 0.3, L - 0.5, 0.345, 0.365, r);
        g.fillStyle = '#d8dde2'; rect(g, 0, 1.5, 0.36, 0.5, r);
        g.save(); g.fillStyle = '#26303a'; g.font = `700 ${Math.round(0.36 * ppm)}px "Barlow Condensed", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(lv.reg, X(L * 0.72, r), Yc(0.22, r)); g.restore();
      });
    } else {
      // fighter: two-tone grey, a darker canopy frame line, low-visibility numbers
      both(r => { g.fillStyle = lv.tail; rect(g, 0, L, 0, 0.22, r); g.fillStyle = lv.belly; rect(g, 0, L, 0.36, 0.5, r); g.fillStyle = '#3b4148'; rect(g, 0, 1.2, 0.0, 0.5, r);
        g.save(); g.fillStyle = '#5a626b'; g.font = `700 ${Math.round(0.3 * ppm)}px "Barlow Condensed", sans-serif`; g.textAlign = 'center'; g.fillText(lv.reg, X(L * 0.7, r), Yc(0.3, r)); g.restore(); });
    }
    // cockpit windows from the pilot's view: dark glass on the livery, see-through in the cockpit mask
    const wm = windowMask(m, pt, eyeM), sx = W / MW, sy = H / MH;
    const mimg = gm.getImageData(0, 0, MW, MH), md = mimg.data;
    for (let i = 0; i < wm.length; i++) {
      // soften the mask a little (3x3 average) so the alpha-tested edge is smooth, not stair-stepped
      if (!wm[i] && !wm[i - 1] && !wm[i + 1] && !wm[i - MW] && !wm[i + MW]) continue;
      let a = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) a += wm[i + dy * MW + dx] || 0;
      const val = 255 - Math.round(a / 9 * 255); md[i * 4] = md[i * 4 + 1] = md[i * 4 + 2] = val;
      if (wm[i] && kind !== 'fighter') { const px = i % MW, py = (i / MW) | 0; const edge = !wm[i - 2] || !wm[i + 2] || !wm[i - 2 * MW] || !wm[i + 2 * MW];
        g.fillStyle = edge ? '#2a3038' : '#10151b'; g.fillRect(Math.floor(px * sx), Math.floor(py * sy), Math.ceil(sx) + 1, Math.ceil(sy) + 1); }
    }
    gm.putImageData(mimg, 0, 0);
    // subtle panel lines
    g.globalAlpha = 0.06; g.strokeStyle = '#000'; g.lineWidth = 1;
    for (let s = 1; s < L; s += kind === 'ga' ? 0.8 : 2.1) { g.beginPath(); g.moveTo(s * ppm, 0); g.lineTo(s * ppm, H / 2); g.moveTo(W - s * ppm, H / 2); g.lineTo(W - s * ppm, H); g.stroke(); }
    g.globalAlpha = 1;
    const tex = (c, srgb) => { const t = new THREE.CanvasTexture(c); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; t.flipY = false; return t; };
    return { map: tex(cv, true), emissive: tex(ce, true), mask: tex(cm, false) };
  }
  function finTexture(m) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 512; const g = c.getContext('2d'); const lv = m.livery;
    g.fillStyle = lv.tail; g.fillRect(0, 0, 512, 512);
    if (m.kind !== 'fighter') {
      // a symmetric bay emblem: a white disc with three waves (reads the same from either side)
      g.save(); g.translate(230, 300); g.fillStyle = 'rgba(255,255,255,.95)'; g.beginPath(); g.arc(0, 0, 118, 0, 7); g.fill();
      g.strokeStyle = lv.tail; g.lineWidth = 17; g.lineCap = 'round';
      for (let k = -1; k <= 1; k++) { g.beginPath(); for (let x = -85; x <= 85; x += 5) { const y = k * 40 + Math.sin(x / 26) * 11; x === -85 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke(); }
      g.restore();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  }

  // ---------------------------------------------------------------- engines
  function lathe(profile, seg, x0, col) {        // profile [[x, r], ...] around the x axis, as a GB
    const gb = new GB();
    profile.forEach(([x, r], i) => { for (let k = 0; k <= seg; k++) { const a = k / seg * Math.PI * 2; gb.v(new V3(x0 + x, Math.cos(a) * r, Math.sin(a) * r), k / seg, i / (profile.length - 1), col(i, x, r)); } });
    for (let i = 0; i + 1 < profile.length; i++) for (let k = 0; k < seg; k++) { const a = i * (seg + 1) + k; gb.q(a, a + seg + 1, a + seg + 2, a + 1); }
    return gb;
  }
  function fanTexture(swirl) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
    g.fillStyle = '#15181c'; g.fillRect(0, 0, 256, 256); g.translate(128, 128);
    for (let i = 0; i < 22; i++) { g.rotate(Math.PI * 2 / 22); g.fillStyle = i % 2 ? '#4a5058' : '#3d434a'; g.beginPath(); g.moveTo(18, -3); g.quadraticCurveTo(80, -20, 126, -8); g.lineTo(126, 10); g.quadraticCurveTo(80, 0, 18, 6); g.fill(); }
    g.fillStyle = '#c9ccd0'; g.beginPath(); g.arc(0, 0, 30, 0, 7); g.fill();
    if (swirl) { g.strokeStyle = '#15181c'; g.lineWidth = 5; g.beginPath(); for (let a = 0; a < 3.2; a += 0.1) { const r = 3 + a * 8; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.stroke(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  // ---------------------------------------------------------------- materials
  function mats(m, lv) {
    const paint = new THREE.MeshPhysicalMaterial({ map: lv.map, emissiveMap: lv.emissive, emissive: 0x000000, roughness: 0.42, metalness: 0.05, clearcoat: 0.7, clearcoatRoughness: 0.22 });
    const wing = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.25 });
    const fin = new THREE.MeshPhysicalMaterial({ map: finTexture(m), roughness: 0.4, metalness: 0.05, clearcoat: 0.6, clearcoatRoughness: 0.25, emissive: 0x000000 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.3, metalness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.7, metalness: 0.2 });
    const tyre = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.92 });
    const grey = new THREE.MeshStandardMaterial({ color: 0x8f959c, roughness: 0.5, metalness: 0.5 });
    const nacelle = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.2 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x1a2530, roughness: 0.05, metalness: 0.1, transmission: 0, transparent: true, opacity: 0.35, clearcoat: 1, envMapIntensity: 1.5, depthWrite: false });
    return { paint, wing, fin, metal, dark, tyre, grey, nacelle, glass };
  }

  // ---------------------------------------------------------------- lights (sprites, one material)
  let lightTex = null;
  function glowTexture() {
    if (lightTex) return lightTex;
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, 'rgba(255,255,255,.85)'); gr.addColorStop(0.35, 'rgba(255,255,255,.18)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); lightTex = new THREE.CanvasTexture(c); return lightTex;
  }
  function lamp(color, size) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    s.scale.setScalar(size); s.userData.base = size; return s;
  }

  // ---------------------------------------------------------------- the whole aircraft
  function build(type) {
    const m = type.model, f = type.fdm, root = new THREE.Group(); root.name = 'aircraft-' + type.id;
    const eye = P(m.cockpit.x, m.cockpit.y, m.cockpit.z);
    const fz = fuselage(m); const lv = livery(type, m, fz.prof, fz.pt, eye); const M = mats(m, lv);
    const body = new THREE.Mesh(fz.geo, M.paint); body.castShadow = true; body.receiveShadow = true; root.add(body);
    const parts = { ail: [], flap: [], spoil: [], elev: [], rud: [], slat: [] }, spin = [], gearLegs = [], lamps = {};
    const addMesh = (gb, mat, parent = root, cast = true) => { const me = new THREE.Mesh(gb.geo ? gb.geo() : gb, mat); me.castShadow = cast; me.receiveShadow = true; parent.add(me); return me; };
    const wingCol = m.kind === 'fighter' ? m.livery.base : m.kind === 'ga' ? m.livery.base : '#d9dde2';

    // ---- wings
    const w = m.wing, surfs = [];
    if (w.flap) surfs.push({ y0: w.flap[0], y1: w.flap[1], cf: w.flap[2], kind: 'flap' });
    if (w.ail) surfs.push({ y0: w.ail[0], y1: w.ail[1], cf: w.ail[2], kind: 'ail' });
    const wr = surface(w, surfs, { color: wingCol, spoilers: w.spoil, metal: m.kind === 'jet' ? '#c4cad1' : wingCol, noMetal: m.kind !== 'jet' });
    const hingePart = (p, side, mat) => {
      const pivot = new THREE.Group(); const g = p.gb.geo(); const A = p.a.clone(), B = p.b.clone();
      let geo = g; if (side < 0) { geo = mirrorZ(g); A.z = -A.z; B.z = -B.z; }
      geo.translate(-A.x, -A.y, -A.z); pivot.position.copy(A);
      const me = new THREE.Mesh(geo, mat); me.castShadow = true; me.receiveShadow = true; if (p.twoSided) me.material = mat; pivot.add(me); root.add(pivot);
      return { pivot, axis: B.clone().sub(A).normalize(), side, kind: p.kind, base: pivot.position.clone(), c: p.c || 1, cd: p.cd ? p.cd.clone() : new V3(-1, 0, 0), ud: p.ud ? p.ud.clone() : new V3(0, 1, 0) };
    };
    for (const side of [1, -1]) {
      addMesh(side > 0 ? wr.gb.geo() : mirrorZ(wr.gb.geo()), M.wing);
      for (const p of wr.parts) { const h = hingePart(p, side, M.wing); (p.kind === 'flap' ? parts.flap : p.kind === 'ail' ? parts.ail : parts.spoil).push(h); }
    }
    // colour the wing vertex colours were set from the material colour; tips
    const tipSec = wr.sec(w.span);
    if (w.tip === 'sharklet' || w.tip === 'winglet') {
      const hgt = m.kind === 'jet' ? (w.tip === 'sharklet' ? 2.4 : 2.5) : 0.4;
      const secs = []; const o = tipSec.o, c = tipSec.c;
      for (let k = 0; k <= 6; k++) {
        const a = k / 6, bend = Math.min(1, a * 1.8), r = w.tip === 'sharklet' ? 0.9 : 0.35;
        const up = a < 0.5 ? r * Math.sin(bend * Math.PI / 2) * 0.9 : r * 0.9 + (a - 0.5) * 2 * (hgt - r * 0.9);
        const out = r * (1 - Math.cos(bend * Math.PI / 2)) + a * 0.35;
        const cant = bend * (Math.PI / 2 - 0.2);
        const cc = c * (1 - 0.62 * a);
        secs.push({ o: new V3(o.x - a * hgt * 0.75, o.y + up, o.z + out), c: cc, cd: new V3(-1, 0, 0), ud: new V3(0, Math.cos(cant), -Math.sin(cant)), t: 0.09, m: 0.01, v: a });
      }
      const gb = new GB(); loft(gb, secs, 0, 1, () => hex(m.livery.tail), false, true);
      for (const side of [1, -1]) addMesh(side > 0 ? gb.geo() : mirrorZ(gb.geo()), M.wing);
    }
    if (w.strut) {   // the C172 wing strut
      for (const side of [1, -1]) { const fh = (m.fus.h || 1.35) / 2, a = P(w.x - w.c0 * 0.45, side * ((m.fus.w || 1.1) / 2 - 0.05), fh * 0.65), b = P(w.x - w.c0 * 0.3, side * w.span * 0.52, w.z + 0.08); const len = a.distanceTo(b);
        const g = new THREE.CylinderGeometry(0.035, 0.045, len, 8); g.scale(1, 1, 2.2); const me = new THREE.Mesh(g, M.wing); me.position.copy(a).add(b).multiplyScalar(0.5); me.quaternion.setFromUnitVectors(new V3(0, 1, 0), b.clone().sub(a).normalize()); me.castShadow = true; root.add(me); }
    }
    if (w.lex) {     // F-16 leading-edge extensions: flat strakes blending the wing into the forebody
      for (const side of [1, -1]) { const gb = new GB(); const col = hex(m.livery.base);
        const pts = [P(4.6, side * 0.55, 0.05), P(1.3, side * 1.02, 0.25), P(1.3, side * 0.62, 0.25)];
        const a = gb.v(pts[0], 0, 0, col), b = gb.v(pts[1], 0, 0, col), c = gb.v(pts[2], 0, 0, col); side > 0 ? gb.t(a, b, c) : gb.t(a, c, b); side > 0 ? gb.t(a, c, b) : gb.t(a, b, c);
        addMesh(gb, M.wing); }
    }
    // ---- tails
    const ht = m.htail, hsurf = ht && !ht.allMoving ? [{ y0: ht.y0 || 0.4, y1: ht.span, cf: ht.elev, kind: 'elev' }] : [];
    const hr = ht ? surface({ ...ht, y0: ht.y0 || (m.kind === 'jet' ? m.fus.d * 0.18 : 0.2), tt: ht.t, twist: 0, cam: 0 }, hsurf, { color: m.kind === 'jet' ? (ht.color || '#dfe3e8') : wingCol, noMetal: m.kind !== 'jet' }) : null;
    if (ht) for (const side of [1, -1]) {
      if (ht.allMoving) { const pv = new THREE.Group(); const g = side > 0 ? hr.gb.geo() : mirrorZ(hr.gb.geo()); const hx = ht.x - ht.c0 * 0.35; g.translate(-hx, 0, 0); pv.position.set(hx, 0, 0); const me = new THREE.Mesh(g, M.wing); me.castShadow = true; pv.add(me); root.add(pv); parts.elev.push({ pivot: pv, axis: new V3(0, 0, 1), side: 1, kind: 'stab' }); }
      else { addMesh(side > 0 ? hr.gb.geo() : mirrorZ(hr.gb.geo()), M.wing); for (const p of hr.parts) parts.elev.push(hingePart(p, side, M.wing)); }
    }
    const vt = m.vtail;
    const vr = surface({ x: vt.x, y0: 0, span: vt.h, c0: vt.c0, c1: vt.c1, sweep: vt.sweep, z: vt.z, t: vt.t, tt: vt.t, cam: 0 }, [{ y0: vt.h * 0.06, y1: vt.h * 0.96, cf: vt.rud, kind: 'rud' }], { vertical: true, noMetal: true });
    addMesh(vr.gb.geo(), M.fin); for (const p of vr.parts) parts.rud.push(hingePart(p, 1, M.fin));
    if (vt.dorsal) {   // dorsal fin fillet
      const gb = new GB(); const col = [1, 1, 1];
      const a = gb.v(new V3(vt.x + vt.dorsal, -vt.z - 0.05, 0), 0.02, 0.02, col), b = gb.v(new V3(vt.x, -vt.z + vt.h * 0.22, 0), 0.02, 0.1, col), c = gb.v(new V3(vt.x - vt.c0 * 0.2, -vt.z - 0.05, 0), 0.02, 0.02, col);
      gb.t(a, b, c); gb.t(a, c, b); addMesh(gb, M.fin);
    }
    if (m.kind === 'fighter') {   // ventral fins
      for (const side of [1, -1]) { const g = new THREE.BoxGeometry(1.4, 0.55, 0.04); const me = new THREE.Mesh(g, M.wing); me.position.set(-4.6, -0.75, side * 0.62); me.rotation.x = side * 0.3; me.castShadow = true; root.add(me); }
    }

    // ---- engines
    const eng = [];
    for (const e of m.engines) {
      const grp = new THREE.Group(); grp.position.copy(P(e.x, e.y, e.z)); root.add(grp);
      if (e.type === 'fan') {
        const R = e.d / 2, Ln = e.len, lip = hex('#c5cbd2'), body = hex(m.livery.base), core = hex('#7d848c');
        const prof = [[0.02, R * 0.82], [0, R * 0.9], [0.03, R * 0.985], [0.14, R], [Ln * 0.35, R * 1.0], [Ln * 0.62, R * 0.93], [Ln * 0.72, R * 0.84]].map(([x, r]) => [-x, r]);
        const nac = lathe(prof, 36, 0, (i) => i <= 2 ? lip : body);
        if (e.style === 'chevron') { const pp = nac.p, seg = 36, last = prof.length - 1; for (let k = 0; k <= seg; k++) { const ix = (last * (seg + 1) + k) * 3; pp[ix] -= (k % 3 === 0 ? 0.25 : 0); } }
        const nm = addMesh(nac, M.nacelle, grp);
        // reverser sleeve (aft cowl) and the core with its plug
        const sleeve = lathe([[-Ln * 0.62, R * 0.935], [-Ln * 0.72, R * 0.845], [-Ln * 0.72, R * 0.8], [-Ln * 0.6, R * 0.86]], 36, 0, () => body);
        const sm = addMesh(sleeve, M.nacelle, grp);
        const coreGb = lathe([[-Ln * 0.66, R * 0.62], [-Ln * 0.8, R * 0.56], [-Ln * 0.95, R * 0.42], [-Ln * 0.97, R * 0.4]], 28, 0, () => core);
        addMesh(coreGb, M.grey, grp);
        const plug = lathe([[-Ln * 0.9, R * 0.33], [-Ln * 1.05, R * 0.22], [-Ln * 1.12, R * 0.02]], 20, 0, () => hex('#5f656c'));
        addMesh(plug, M.dark, grp);
        // inner inlet duct (dark) and the fan disc with spinner
        const duct = lathe([[0.02, R * 0.82], [-0.35, R * 0.8], [-0.55, R * 0.78]], 28, 0, () => hex('#2a2e33'));
        const dm = new THREE.Mesh(duct.geo(), new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.BackSide, roughness: 0.6 })); grp.add(dm);
        const fanMat = new THREE.MeshStandardMaterial({ map: fanTexture(true), roughness: 0.45, metalness: 0.6 });
        const fan = new THREE.Mesh(new THREE.CircleGeometry(R * 0.79, 40), fanMat); fan.rotation.y = Math.PI / 2; fan.position.x = -0.5; grp.add(fan);
        const spinner = new THREE.Mesh(new THREE.ConeGeometry(R * 0.2, R * 0.42, 24), M.metal); spinner.rotation.z = -Math.PI / 2; spinner.position.x = -0.5 + R * 0.21; grp.add(spinner);
        spin.push({ o: fan, axis: 'x', kind: 'fan', eng: eng.length });
        // pylon to the wing
        if (e.pylon) {
          const pl = new THREE.Mesh(new THREE.BoxGeometry(Ln * 0.95, e.pylon + R * 0.3, 0.32), M.nacelle.clone()); pl.material.vertexColors = false; pl.material.color.set(m.livery.base);
          pl.position.set(-Ln * 0.42, R + e.pylon * 0.5 - 0.1, 0); pl.castShadow = true; grp.add(pl);
        }
        eng.push({ grp, sleeve: sm, R, Ln });
      } else if (e.type === 'prop') {
        const hub = new THREE.Group(); hub.position.x = 0; grp.add(hub);
        if (e.nacelle) { const nd = e.nacelle.d / 2, nl = e.nacelle.len; const nb = lathe([[0, nd * 0.55], [-0.15, nd * 0.95], [-nl * 0.25, nd], [-nl * 0.7, nd * 0.85], [-nl, nd * 0.2]], 20, 0, (i) => i === 0 ? hex('#2b2f35') : hex(e.nacelle.color || m.livery.base)); addMesh(nb, M.nacelle, grp); }
        const sp = new THREE.Mesh(new THREE.ConeGeometry(e.spinner / 2, e.spinner * 1.1, 20), new THREE.MeshStandardMaterial({ color: m.livery.stripe, roughness: 0.35, metalness: 0.2 })); sp.rotation.z = -Math.PI / 2; sp.position.x = e.spinner * 0.45; hub.add(sp);
        const blades = new THREE.Group(); hub.add(blades);
        for (let k = 0; k < e.blades; k++) { const bg = new THREE.BoxGeometry(0.03, e.d / 2 - 0.1, 0.13); bg.translate(0, e.d / 4 + 0.05, 0); const b = new THREE.Mesh(bg, M.dark); b.rotation.x = k * Math.PI * 2 / e.blades; b.children.length; blades.add(b); }
        const disc = new THREE.Mesh(new THREE.CircleGeometry(e.d / 2, 40), new THREE.MeshBasicMaterial({ color: 0x202326, transparent: true, opacity: 0.0, depthWrite: false, side: THREE.DoubleSide }));
        disc.rotation.y = Math.PI / 2; hub.add(disc);
        spin.push({ o: blades, axis: 'x', kind: 'prop', eng: eng.length, disc });
        eng.push({ grp, hub });
      } else if (e.type === 'jet') {
        const nz = lathe([[0, 0.56], [-0.6, 0.52], [-1.1, 0.48], [-1.25, 0.5]], 28, 0, () => hex('#6e747b'));
        addMesh(nz, M.metal, grp);
        const inner = new THREE.Mesh(new THREE.CircleGeometry(0.44, 28), new THREE.MeshBasicMaterial({ color: 0x0b0c0e })); inner.rotation.y = -Math.PI / 2; inner.position.x = -0.7; grp.add(inner);
        // afterburner flame: additive cone with shock diamonds
        const fm = new THREE.ShaderMaterial({ uniforms: { uAB: { value: 0 }, uTime: U.uTime }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
          vertexShader: `varying vec2 vUv; #include <common>
            #include <logdepthbuf_pars_vertex>
            void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
            #include <logdepthbuf_vertex>
            }`.replace('varying vec2 vUv; #include <common>', 'varying vec2 vUv;\n#include <common>'),
          fragmentShader: `uniform float uAB; uniform float uTime; varying vec2 vUv;
            #include <logdepthbuf_pars_fragment>
            void main(){
              #include <logdepthbuf_fragment>
              float x = vUv.y; float core = pow(1.0 - x, 1.5);
              float diamonds = 0.55 + 0.45 * pow(abs(sin(x * 28.0 - uTime * 3.0)), 6.0) * (1.0 - x);
              vec3 c = mix(vec3(1.0, 0.45, 0.15), vec3(0.55, 0.65, 1.0), core * 0.8) * diamonds;
              float a = core * uAB * (0.8 + 0.2 * sin(uTime * 40.0 + x * 13.0));
              gl_FragColor = vec4(c * a * 2.2, 1.0); }` });
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.42, 4.6, 24, 8, true), fm); flame.rotation.z = Math.PI / 2; flame.position.x = -1.2 - 2.3; flame.visible = false; grp.add(flame);
        if (e.box) { const [bl, bw, bh] = e.box; const bx = new THREE.Mesh(new THREE.BoxGeometry(bl, bh, bw), M.wing); bx.position.set(bl / 2 - 0.6, 0.1, 0); bx.castShadow = true; grp.add(bx);
          const mouth = new THREE.Mesh(new THREE.PlaneGeometry(bw * 0.86, bh * 0.8), new THREE.MeshBasicMaterial({ color: 0x07080a })); mouth.position.set(bl - 0.58, 0.1, 0); mouth.rotation.y = Math.PI / 2; grp.add(mouth); }
        eng.push({ grp, flame, fm });
        if (e.intake) { const it = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.75, 0.95), M.wing); it.position.copy(P(e.intake.x - 1.2, 0, e.intake.z)).sub(grp.position); it.castShadow = true; grp.add(it);
          const mouth = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.7), new THREE.MeshBasicMaterial({ color: 0x07080a })); mouth.position.copy(it.position).add(new V3(1.31, 0, 0)); mouth.rotation.y = Math.PI / 2; grp.add(mouth); }
      }
    }
    if (m.canopy) {               // a bubble canopy on a light aircraft (aerobatic)
      const c = m.canopy, cg = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2); cg.scale(c.len / 2, c.h, c.w);
      const cn = new THREE.Mesh(cg, M.glass); cn.position.copy(P(c.x, 0, c.z)); cn.renderOrder = 3; root.add(cn);
    }
    if (m.kind === 'fighter') {   // bubble canopy
      const cg = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2); cg.scale(1.9, 0.62, 0.45);
      const cn = new THREE.Mesh(cg, M.glass); cn.position.copy(P(3.9, 0, -0.62)); cn.renderOrder = 3; root.add(cn);
    }
    if (m.kind === 'ga') {        // cowl-mounted exhaust, a tiny nose-gear fairing handled by the gear
    }

    // ---- landing gear
    const legsSpec = f.gear, gr = [];
    legsSpec.forEach((L, i) => {
      const pivot = new THREE.Group(), leg = new THREE.Group(); root.add(pivot); pivot.add(leg);
      const top = P(L.x, L.y, L.z - (m.kind === 'ga' ? 0.75 : Math.min(2.6, L.z * 0.62)));
      const wheelC = P(L.x, L.y, L.z - L.r);
      pivot.position.copy(top);
      const strutLen = top.y - wheelC.y;
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(L.nose ? 0.07 : 0.12, L.nose ? 0.07 : 0.12, strutLen * 0.7, 12), M.grey); strut.position.y = -strutLen * 0.35; leg.add(strut);
      const oleo = new THREE.Mesh(new THREE.CylinderGeometry(L.nose ? 0.05 : 0.085, L.nose ? 0.05 : 0.085, strutLen * 0.45, 12), M.metal); oleo.position.y = -strutLen * 0.7; leg.add(oleo);
      const wheels = new THREE.Group(); wheels.position.y = -strutLen; leg.add(wheels);
      const n = L.wheels || 1, tyreG = new THREE.CylinderGeometry(L.r, L.r, L.r * 0.62, 24); tyreG.rotateX(Math.PI / 2);
      const hubG = new THREE.CylinderGeometry(L.r * 0.55, L.r * 0.55, L.r * 0.64, 16); hubG.rotateX(Math.PI / 2);
      const spinners = [];
      const axles = n === 4 ? [[-0.75, -0.55], [-0.75, 0.55], [0.75, -0.55], [0.75, 0.55]] : n === 2 ? [[0, -0.42 * (L.nose ? 0.8 : 1)], [0, 0.42 * (L.nose ? 0.8 : 1)]] : [[0, 0]];
      if (n === 4) { const beam = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.14, 0.18), M.grey); wheels.add(beam); }
      for (const [ax, az] of axles) { const wg = new THREE.Group(); wg.position.set(ax * (L.r * 2.3), 0, az * L.r * 1.9); const t = new THREE.Mesh(tyreG, M.tyre), h = new THREE.Mesh(hubG, M.grey); t.castShadow = true; wg.add(t, h); wheels.add(wg); spinners.push(wg); }
      if (m.gear && m.gear.pants && !L.nose) { const pg = new THREE.SphereGeometry(1, 16, 10); pg.scale(0.55, 0.3, 0.14); const pm = new THREE.Mesh(pg, M.nacelle.clone()); pm.material.vertexColors = false; pm.material.color.set(m.livery.base); wheels.add(pm); }
      pivot.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      // retraction: mains fold inward (toward the centre line), the nose forward
      const foldAxis = L.nose ? new V3(0, 0, 1) : new V3(1, 0, 0), foldSign = L.nose ? 1 : (L.y > 0 ? 1 : -1);
      gr.push({ pivot, leg, wheels, spinners, strutLen, oleo, foldAxis, foldSign, nose: !!L.nose, r: L.r, rot: 0, fixed: !f.retract || !!L.fixed });
    });

    // ---- lights: nav (red left, green right), white tail, strobes, beacons, landing / taxi, logo
    const tipY = w.span, tipP = (side) => { const s = wr.sec(tipY); return new V3(s.o.x - s.c * 0.3, s.o.y + 0.05, side * (tipY + 0.1)); };
    lamps.navL = lamp(0xff2a1a, 0.9); lamps.navL.position.copy(tipP(-1));
    lamps.navR = lamp(0x22ff66, 0.9); lamps.navR.position.copy(tipP(1));
    lamps.tail = lamp(0xffffff, 0.8); lamps.tail.position.set(m.nose - m.L - 0.05, -(m.kind === 'jet' ? m.fus.zc : 0) + 0.35, 0);
    lamps.strobeL = lamp(0xffffff, 3.2); lamps.strobeL.position.copy(tipP(-1)); lamps.strobeR = lamp(0xffffff, 3.2); lamps.strobeR.position.copy(tipP(1));
    const topY = fz.prof(m.L * 0.45).top, botY = fz.prof(m.L * 0.45).bot;
    lamps.beaconT = lamp(0xff1a0a, 1.6); lamps.beaconT.position.set(m.nose - m.L * 0.45, topY + 0.15, 0);
    lamps.beaconB = lamp(0xff1a0a, 1.6); lamps.beaconB.position.set(m.nose - m.L * 0.42, botY - 0.15, 0);
    const landX = m.kind === 'ga' ? w.x - 0.05 : w.x - 1.2, landZ = m.kind === 'ga' ? 2.0 : Math.max(2.2, w.y0 + 1.2);
    lamps.landL = lamp(0xfff4e0, 2.4); lamps.landL.position.copy(P(landX, -landZ, (m.kind === 'ga' ? w.z : w.z + 0.2)));
    lamps.landR = lamp(0xfff4e0, 2.4); lamps.landR.position.copy(P(landX, landZ, (m.kind === 'ga' ? w.z : w.z + 0.2)));
    for (const k in lamps) { lamps[k].visible = false; root.add(lamps[k]); }
    const spot = new THREE.SpotLight(0xfff1dc, 0, m.kind === 'ga' ? 420 : 900, 13 * D, 0.55, 1.4); spot.castShadow = false;
    spot.position.copy(P(m.nose - 3, 0, (m.kind === 'jet' ? m.fus.zc + 1 : 0.8))); spot.target.position.copy(P(m.nose + 200, 0, 40)); root.add(spot, spot.target);

    // ---- cockpit: the nose from inside (window openings from the mask), glare shield and panel
    const inside = new THREE.Group(); inside.visible = false; root.add(inside);
    const shellMat = new THREE.MeshStandardMaterial({ color: m.kind === 'fighter' ? 0x2c3035 : 0x59616b, emissive: 0x1c2026, roughness: 0.9, side: THREE.BackSide, alphaMap: lv.mask, alphaTest: 0.5 });
    const shell = new THREE.Mesh(fz.geo, shellMat); inside.add(shell);
    const panelC = document.createElement('canvas'); panelC.width = 1024; panelC.height = 384;
    const panelT = new THREE.CanvasTexture(panelC); panelT.colorSpace = THREE.SRGBColorSpace; panelT.anisotropy = 8;
    // instrument panel below the glare shield: its top edge ~17 degrees below the eye line
    const pw = m.kind === 'jet' ? 1.75 : m.kind === 'ga' ? 1.15 : 0.8, ph = pw * 0.375;
    const pd = m.kind === 'jet' ? 0.86 : m.kind === 'ga' ? 0.72 : 0.62, drop = pd * Math.tan(17 * D) + ph * 0.5 * Math.cos(0.4);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), new THREE.MeshBasicMaterial({ map: panelT, toneMapped: false }));
    panel.position.copy(eye).add(new V3(pd, -drop, -m.cockpit.y * (m.kind === 'jet' ? 1 : 0.7)));
    panel.rotation.y = -Math.PI / 2; panel.rotateX(-0.4); inside.add(panel);
    const dark = new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.92 });
    const glare = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, pw * 1.08), dark);
    glare.position.copy(panel.position).add(new V3(0.1, ph * 0.5 * Math.cos(0.4) + 0.035, 0)); inside.add(glare);
    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, m.kind === 'jet' ? 0.5 : 0.25), dark); pedestal.position.copy(panel.position).add(new V3(-0.35, -ph * 0.6 - 0.25, 0)); inside.add(pedestal);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.05, pw * 1.3), new THREE.MeshStandardMaterial({ color: 0x24282d, roughness: 0.95 })); floor.position.copy(eye).add(new V3(0.2, -1.05, -m.cockpit.y)); inside.add(floor);

    const tmpQ = new THREE.Quaternion(), fanAng = [];
    let beaconT = 0, strobeT = 0, wheelAng = [];
    function update(ac, dt, env = {}) {
      const night = env.night || 0, s = ac.surf, fl = f.flaps, nF = fl.length - 1;
      // control surfaces
      const fp = clamp(ac.flapPos, 0, nF), fi = Math.min(Math.floor(fp), Math.max(0, nF - 1)), ft = nF ? fp - fi : 0;
      const flapDeg = nF ? fl[fi].deg + (fl[Math.min(fi + 1, nF)].deg - fl[fi].deg) * ft : 0;
      for (const p of parts.flap) {
        const ext = flapDeg / Math.max(1, fl[nF].deg);
        p.pivot.quaternion.setFromAxisAngle(p.axis, p.side * flapDeg * D * (m.kind === 'ga' ? 1 : 0.9));
        if (m.kind === 'jet') p.pivot.position.copy(p.base).addScaledVector(p.cd.clone().setZ(0), p.c * 0.12 * ext).addScaledVector(new V3(0, -1, 0), p.c * 0.02 * ext);
      }
      const ailDeg = -s.ail * f.maxAil / D;                    // right aileron: TE up for roll right
      const elevonDeg = w.elevon ? -(s.elev * f.maxElev + ac.ctl.trim * f.maxElev * 0.5) / D * 0.8 : 0;   // deltas: elevons move together for pitch
      for (const p of parts.ail) p.pivot.quaternion.setFromAxisAngle(p.axis, p.side * ((p.side > 0 ? ailDeg : -ailDeg) * 0.6 + elevonDeg) * D + (m.kind === 'fighter' ? p.side * flapDeg * D : 0));
      const rollSp = Math.max(0, Math.abs(s.ail) - 0.25) * 0.8;
      for (const p of parts.spoil) {
        const own = p.side > 0 ? (s.ail > 0 ? rollSp : 0) : (s.ail < 0 ? rollSp : 0);
        const a = Math.max(ac.spoilerPos, own) * 50 * D;
        p.pivot.quaternion.setFromAxisAngle(p.axis, -p.side * a);
      }
      for (const p of parts.elev) { if (p.kind === 'stab') p.pivot.quaternion.setFromAxisAngle(p.axis, -(s.elev * f.maxElev + ac.ctl.trim * f.maxElev * 0.5)); else p.pivot.quaternion.setFromAxisAngle(p.axis, -p.side * (s.elev * f.maxElev + ac.ctl.trim * f.maxElev * 0.5)); }
      for (const p of parts.rud) p.pivot.quaternion.setFromAxisAngle(p.axis, s.rud * f.maxRud);
      // gear: fold with the gear position, compress, spin, steer
      const gp = ac.gearPos, vgs = ac.out.gs;
      gr.forEach((g, i) => {
        const L = ac.legs[i]; const fold = g.fixed ? 0 : (1 - gp) * Math.PI / 2 * 0.98;
        g.pivot.quaternion.setFromAxisAngle(g.foldAxis, g.foldSign * fold);
        g.pivot.visible = g.fixed || gp > 0.02;
        g.wheels.position.y = -g.strutLen + (L ? L.comp : 0); g.oleo.position.y = -g.strutLen * 0.7 + (L ? L.comp * 0.5 : 0);
        if (g.nose) g.leg.rotation.y = -ac.ctl.steer * (f.gear[0].steer || 0);
        if (L && L.contact) wheelAng[i] = (wheelAng[i] || 0) - vgs * dt / g.r; else wheelAng[i] = (wheelAng[i] || 0) * 0.995;
        for (const w2 of g.spinners) w2.rotation.z = wheelAng[i];
      });
      // engines
      ac.eng.forEach((e, i) => {
        fanAng[i] = (fanAng[i] || 0) + (e.n * (type.fdm.engines[i].type === 'prop' ? 45 : 70)) * dt;
        const E = eng[i]; if (!E) return;
        if (E.sleeve) E.sleeve.position.x += ((ac.ctl.rev && ac.out.onGround ? -0.45 : 0) - E.sleeve.position.x) * Math.min(1, dt * 2);
        if (E.flame) { const ab = ac.ctl.thr > 1.001 ? clamp((e.n - 0.95) * 20, 0, 1) : 0; E.fm.uniforms.uAB.value = ab; E.flame.visible = ab > 0.01; E.flame.scale.set(1, 0.8 + 0.3 * ab, 1); }
      });
      for (const sp of spin) {
        const a = fanAng[sp.eng] || 0;
        if (sp.kind === 'fan') { if (sp.axis === 'x') sp.o.rotation.x = a; else sp.o.rotation.y = a; }
        else { sp.o.rotation.x = a; const n = ac.eng[sp.eng].n; sp.o.visible = n < 0.35; sp.disc.material.opacity = clamp((n - 0.22) * 1.4, 0, 0.32); }
      }
      // lights
      beaconT += dt; strobeT += dt;
      const eng1 = ac.eng.some(e => e.n > 0.25), airborne = !ac.out.onGround;
      const lit = (o, on, k = 1) => { o.visible = on; if (on) o.scale.setScalar(o.userData.base * k * (0.55 + 0.45 * night + (env.inside ? 0 : 0))); };
      lit(lamps.navL, true); lit(lamps.navR, true); lit(lamps.tail, true);
      const bOn = eng1 && (beaconT % 1.1) < 0.12; lit(lamps.beaconT, bOn); lit(lamps.beaconB, bOn && (beaconT % 1.1) < 0.1);
      const sOn = (airborne || ac.out.gs > 20) && ((strobeT % 1.25) < 0.05 || ((strobeT % 1.25) > 0.14 && (strobeT % 1.25) < 0.19));
      lit(lamps.strobeL, sOn); lit(lamps.strobeR, sOn);
      const landOn = (ac.gearPos > 0.5 && ac.pos.y - ac.out.gnd < 3000) || ac.out.gs > 25 && !airborne;
      lit(lamps.landL, landOn, 0.6 + night); lit(lamps.landR, landOn, 0.6 + night);
      spot.intensity = landOn ? 30000 * night * (m.kind === 'ga' ? 0.25 : 1) : 0;
      // cabin windows and the logo light at night
      M.paint.emissive.setScalar(night * (m.kind === 'jet' ? 0.9 : 0)); M.fin.emissive.setRGB(0.25 * night, 0.25 * night, 0.25 * night);
      inside.visible = !!env.inside; body.visible = !env.inside;
      if (env.inside) { panelT.needsUpdate = true; }
    }
    function dispose() { root.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { for (const k of ['map', 'emissiveMap', 'alphaMap']) if (o.material[k] && o.material[k] !== lightTex) o.material[k].dispose(); o.material.dispose(); } }); }
    U.global(root);
    return { root, update, dispose, eye, panel: { canvas: panelC, tex: panelT, w: pw, h: ph }, inside, parts, lamps, spot, type };
  }
  // a light single-mesh version for traffic (instanced): vertex-coloured fuselage, wings, tails and engines
  function lite(type) {
    const m = type.model, geos = [], col = hex(m.livery.base), tail = hex(m.livery.tail), belly = hex(m.livery.belly || '#d9dde2'), dark = [0.07, 0.08, 0.1];
    const fz = fuselage(m), g0 = fz.geo, pos = g0.attributes.position, cl = g0.attributes.color;
    const F = m.fus, L = m.L;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), s2 = m.nose - x, q = fz.prof(Math.max(0, Math.min(L, s2))), c = (q.top + q.bot) / 2, r = (q.top - q.bot) / 2 || 1, v = (y - c) / r;
      let k = col;
      if (m.kind === 'jet' && v < -0.35) k = belly;
      if (m.kind === 'jet' && s2 > L - F.tailLen * 0.8 && v > -0.6 + (s2 - (L - F.tailLen * 0.8)) / F.tailLen) k = tail;
      if (m.kind === 'jet' && Math.abs(v - 0.2) < 0.07 && s2 > F.noseLen && s2 < L - F.tailLen * 0.9) k = dark;
      if (s2 < (m.kind === 'jet' ? F.noseLen * 0.6 : 2) && s2 > (m.kind === 'jet' ? F.noseLen * 0.25 : 1.5) && v > 0.25 && v < 0.75) k = dark;
      cl.setXYZ(i, k[0], k[1], k[2]);
    }
    geos.push(g0);
    const w = m.wing, wc = m.kind === 'jet' ? '#d9dde2' : m.livery.base;
    const wr = surface(w, [], { color: wc, metal: '#c4cad1', noMetal: m.kind !== 'jet' }); const wg = wr.gb.geo(); geos.push(wg, mirrorZ(wg));
    const ht = m.htail; if (ht) { const hr = surface({ ...ht, y0: ht.y0 || (m.kind === 'jet' ? F.d * 0.18 : 0.2), tt: ht.t, twist: 0, cam: 0 }, [], { color: m.kind === 'jet' ? '#dfe3e8' : wc, noMetal: true });
    const hg = hr.gb.geo(); geos.push(hg, mirrorZ(hg)); }
    const vt = m.vtail, vr = surface({ x: vt.x, y0: 0, span: vt.h, c0: vt.c0, c1: vt.c1, sweep: vt.sweep, z: vt.z, t: vt.t, tt: vt.t, cam: 0 }, [], { vertical: true, noMetal: true, color: m.livery.tail });
    geos.push(vr.gb.geo());
    for (const e of m.engines) {
      if (e.type === 'fan') { const R = e.d / 2, Ln = e.len; const gb = lathe([[0.02, R * 0.82], [0, R * 0.9], [-0.14, R], [-Ln * 0.35, R], [-Ln * 0.62, R * 0.93], [-Ln * 0.72, R * 0.84], [-Ln * 0.95, R * 0.4], [-Ln * 1.1, 0.02]], 14, 0, (i) => i <= 1 ? [0.75, 0.77, 0.8] : i >= 6 ? [0.3, 0.32, 0.35] : col);
        const g = gb.geo(); const P2 = P(e.x, e.y, e.z); g.translate(P2.x, P2.y, P2.z); geos.push(g);
        const face = new GB(); const c0 = face.v(new V3(P2.x - 0.02, P2.y, P2.z), 0, 0, dark); for (let k = 0; k <= 14; k++) { const a = k / 14 * Math.PI * 2; face.v(new V3(P2.x - 0.02, P2.y + Math.cos(a) * R * 0.82, P2.z + Math.sin(a) * R * 0.82), 0, 0, dark); } for (let k = 1; k <= 14; k++) face.t(c0, k + 1, k); geos.push(face.geo()); }
    }
    const merged = U.mergeGeometries(geos.map(g => { const q = g.index ? g : g; for (const k of Object.keys(q.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) q.deleteAttribute(k); return q; }));
    merged.computeBoundingSphere(); return merged;
  }
  return { build, lite };
})();
