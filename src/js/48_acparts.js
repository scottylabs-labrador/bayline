// ACParts: the machinery of the procedural aircraft, built with ACGeo into the batches of 48_acmodel.js: turbofans
// (lathed nacelles per style with polished lips, flattened or chevroned where the type has them, 3D fans and
// spinners, translating reverser sleeves over cascades, core cowls and plugs, aerofoil pylons), propellers
// (twisted blades that feather and blur), fighter and Concorde jets (nozzles, intakes, reheat), the helicopter's
// rotors (coning, flapping with the cyclic), landing gear (struts, chrome oleos, torque links, bogies, tyres, hubs,
// doors, retraction and steering) and the lights (lens meshes plus glow sprites).
//   ACParts.build(type, ctx, env)    ctx from ACModel (B, rig, q, pal, H ...), env { wings, htails, fin, anim, lamps }
//   ACParts.lite(type, lod)          traffic geometry ('far' | 'near' | 'gear'): see 48_acmodel.js
// Axes: x forward, y up, z right; spec (46_aircraft.js) positions are FRD: P(x, y, z) converts.
const ACParts = (() => {
  const V3 = THREE.Vector3, Q4 = THREE.Quaternion, D = Math.PI / 180;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const P = (x, y, z) => new V3(x, -z, y);
  const X1 = new V3(1, 0, 0), Y1 = new V3(0, 1, 0), Z1 = new V3(0, 0, 1);
  const mat4 = (pos, q, s) => new THREE.Matrix4().compose(pos || new V3(), q || new Q4(), s || new V3(1, 1, 1));

  // the span bone a part hangs from: the flex bone at (or just inboard of) span |y| on that side
  function flexBone(env, y) {
    const ws = env.wings.find(w => w.side === (y >= 0 ? 1 : -1)); if (!ws || !ws.flex) return 0;
    const ys = ws.flex.ys, s = Math.abs(y); let k = 0; while (k + 1 < ys.length && ys[k + 1] <= s + 1e-6) k++;
    return ws.flex.bones[k];
  }

  // ---------------------------------------------------------------- turbofans
  // nacelle styles (fractions of the nacelle length aft of the lip, radii as fractions of the max radius):
  // fan face, max radius, reverser split, fan nozzle exit and radius, core cowl start / end radius, plug end;
  // blades; lip thickness; the CFM56's flattened lower lip; chevron count
  const FAN = {
    leap: { fan: 0.2, max: 0.3, rev: 0.47, exit: 0.7, rExit: 0.8, c0: 0.6, rc0: 0.6, c1: 0.92, rc1: 0.4, plug: 1.1, blades: 18, lip: 0.07, sweep: 0.12, spin: 'point' },
    cfm: { fan: 0.18, max: 0.28, rev: 0.42, exit: 0.6, rExit: 0.78, c0: 0.52, rc0: 0.58, c1: 0.9, rc1: 0.37, plug: 1.06, blades: 24, lip: 0.08, flat: 0.13, sweep: 0.06, spin: 'round' },
    chevron: { fan: 0.18, max: 0.3, rev: 0.5, exit: 0.72, rExit: 0.8, c0: 0.62, rc0: 0.58, c1: 0.93, rc1: 0.38, plug: 1.1, blades: 18, lip: 0.06, chev: 16, cchev: 12, sweep: 0.14, spin: 'point' },
    long: { fan: 0.16, max: 0.3, rev: 0.52, exit: 0.8, rExit: 0.74, c0: 0.72, rc0: 0.55, c1: 0.94, rc1: 0.36, plug: 1.08, blades: 24, lip: 0.07, sweep: 0.1, spin: 'round' },
  };
  function turbofan(e, idx, ctx, env) {
    const { B, rig, q, pal } = ctx, m = ctx.type.model, S = FAN[e.style] || FAN.leap;
    const R = e.d / 2, Ln = e.len, Rf = (e.fanD || e.d * 0.87) / 2, seg = ctx.far ? 8 : [14, 20, 32, 44, 60][q], far = ctx.far;
    const o = P(e.x, e.y, e.z), eb = rig.add(flexBone(env, e.y), o.x, o.y, o.z);
    const at = (p) => new V3().copy(p).add(o);        // (profiles are relative to the lip centre)
    // the profile, front (inside the duct, at the fan) round the lip and back along the cowl to the nozzle
    const Rd = Rf * 1.012, Ro = R * (0.955 - S.lip * 0.2), la = R * S.lip * 1.6, rc = (Rd + Ro) / 2, lb = (Ro - Rd) / 2;
    const xF = -S.fan * Ln, xE = -S.exit * Ln, xRev = -S.rev * Ln, xMax = -S.max * Ln, rE = S.rExit * R;
    const prof = [[xF, Rf * 1.004], [xF * 0.6, Rd * 0.992], [xF * 0.3, Rd * 0.985], [-la * 1.4, Rd * 0.99]];
    const lipA = [];
    for (let k = 0; k <= 8; k++) { const a = -Math.PI / 2 + Math.PI * k / 8; lipA.push([-la + la * Math.cos(a), rc + lb * Math.sin(a)]); }
    const iLip0 = prof.length; prof.push(...lipA); const iLip1 = prof.length - 1;
    const nOut = [8, 10, 14, 18, 22][q];
    for (let k = 1; k <= nOut; k++) {
      const x = -la + (xE + la) * k / nOut, u = (x + la) / (xE + la), um = (xMax + la) / (xE + la);
      const r = u < um ? Ro + (R - Ro) * Math.pow(Math.sin(Math.PI / 2 * u / um), 0.55) : R - (R - rE) * Math.pow((u - um) / (1 - um), 1.9);
      prof.push([x, r]);
    }
    const iExit = prof.length - 1;
    // split the outer cowl at the reverser: fan cowl (lip .. xRev) and the sleeve (xRev .. exit, and its inside)
    let iRev = iLip1 + 1; while (iRev < iExit && prof[iRev][0] > xRev) iRev++;
    const flat = S.flat || 0, fade = (k) => (k <= iLip1 ? 1 : Math.max(0, 1 - (k - iLip1) / Math.max(1, (iRev - iLip1) * 0.8)));
    const inletFade = (k) => (k < iLip0 ? clamp(k / iLip0, 0, 1) : 1);
    const mod = flat ? (k, ph) => 1 - flat * Math.pow(Math.max(0, -Math.cos(ph)), 2.4) * fade(k) * inletFade(k) : null;
    const nac = B.mb('nac'), parts = B.mb('parts');
    const uvCowl = (k, ph, s, p) => [ph / (Math.PI * 2), clamp(-p.x / Ln, 0, 1) * 0.75, -p.x, ph * R];     // (around, along: the atlas is laid out in these)
    const place = (mb, fn) => mb.at(mat4(o), fn);
    // inlet duct (dark liner), lip (polished), fan cowl (paint)
    parts.bind(eb); parts.pal = pal('inlet'); place(parts, () => parts.lathe(prof, seg, { range: [0, iLip0], mod }));
    parts.pal = pal('alu'); place(parts, () => parts.lathe(prof, seg, { range: [iLip0, iLip1], mod }));
    parts.pal = null; nac.bind(eb); place(nac, () => nac.lathe(prof, seg, { range: [iLip1, iRev], mod, uv: uvCowl }));
    // reverser sleeve: its own bone (slides aft), the outer cowl to the nozzle and its inner wall; chevrons
    const sb = rig.add(eb, o.x + xRev, o.y, o.z);
    const chev = S.chev || 0, tooth = (ph, n) => { const t = ((ph / (Math.PI * 2)) * n) % 1; return 1 - Math.abs(t * 2 - 1); };
    const sprof = prof.slice(iRev, iExit + 1);
    sprof.push(sprof[sprof.length - 1].slice()); sprof.push([xE + Ln * 0.02, rE * 0.965], [xRev + Ln * 0.04, R * 0.86]);
    const nS = sprof.length, iE = nS - 4;
    const xmod = chev ? (k, ph) => (k >= iE - 1 ? -Ln * 0.035 * tooth(ph, chev) * clamp(k - (iE - 1), 0, 1.6) : 0) : null;
    const smod = chev ? (k, ph) => (k >= iE ? 1 - 0.03 * tooth(ph, chev) : 1) : null;
    nac.bind(sb); place(nac, () => nac.lathe(sprof, seg, { range: [0, iE + 1], xmod, mod: smod, uv: uvCowl }));
    parts.bind(sb); parts.pal = pal('inlet'); place(parts, () => parts.lathe(sprof, seg, { range: [iE + 1, nS - 1], xmod, mod: smod }));
    // cascades under the sleeve (shown when it slides back), and the bypass duct's inner wall ahead of them
    parts.bind(eb); parts.pal = pal('cascade'); place(parts, () => parts.lathe([[xRev + 0.02, R * 0.86], [xRev - 0.34 * R, R * 0.86]], seg));
    // core cowl, core nozzle (hot), plug
    const x0 = -S.c0 * Ln, x1 = -S.c1 * Ln, r0 = S.rc0 * R, r1 = S.rc1 * R, xp = -S.plug * Ln;
    const core = [[x0 + 0.2, r0 * 0.96], [x0, r0], [lerp(x0, x1, 0.3), lerp(r0, r1, 0.2)], [lerp(x0, x1, 0.65), lerp(r0, r1, 0.55)], [x1, r1]];
    parts.pal = pal('gearGrey'); place(parts, () => parts.lathe(core, seg, { xmod: S.cchev ? (k, ph) => (k >= 3.5 ? -Ln * 0.02 * tooth(ph, S.cchev) * (k - 3.5) * 2 : 0) : null }));
    parts.pal = pal('exhaust'); place(parts, () => parts.lathe([[x1, r1], [x1, r1], [x1 + 0.04, r1 * 0.9], [x1 + 0.25, r1 * 0.72]], seg, { flip: false }));
    const plug = [[x1 + 0.3, r1 * 0.78], [x1 + 0.05, r1 * 0.72], [lerp(x1, xp, 0.45), r1 * 0.48], [lerp(x1, xp, 0.8), r1 * 0.2], [xp, 0.012]];
    parts.pal = pal('exhaustDark'); place(parts, () => parts.lathe(plug, seg));
    // the fan: blades, hub and spinner on their own bone; a blur disc fades in with N1
    const fb = rig.add(eb, o.x + xF, o.y, o.z);
    const nb = far ? 0 : S.blades, rH = Rf * 0.3, nr = [3, 4, 6, 7, 9][q], nc = [2, 3, 4, 5, 6][q];
    parts.bind(fb); parts.pal = pal('fan');
    if (far) { parts.pal = pal('fanDark'); place(parts, () => parts.lathe([[xF + 0.05, 0.001], [xF + 0.05, Rf]], seg)); }
    for (let k = 0; k < nb; k++) {
      const ph0 = k * Math.PI * 2 / nb, ch = Rf * (q < 1 ? 0.5 : 0.42) * (18 / nb) ** 0.6;
      const blade = (u, v, out, side2) => {
        const r = lerp(rH, Rf * 0.992, u), beta = lerp(34, 66, Math.pow(u, 0.8)) * D, c = ch * (0.8 + 0.35 * Math.sin(Math.PI * Math.min(1, u * 1.2)));
        const xLE = xF + Ln * 0.01 - S.sweep * Rf * u * u, ax = xLE - v * c * Math.cos(beta), arc = (v - 0.5) * c * Math.sin(beta);
        const tb = 0.012 * Rf * (1 - Math.pow(2 * v - 1, 2)) * (1.4 - u) * side2;
        const ang = ph0 + (arc + tb * Math.cos(beta)) / r, xx = ax + tb * Math.sin(beta);
        return out.set(o.x + xx, o.y + Math.cos(ang) * r, o.z + Math.sin(ang) * r);
      };
      parts.surface(ACGeo.linSpace(0, 1, nr), ACGeo.linSpace(0, 1, nc), (u, v, out) => blade(u, v, out, 1), { eu: 1e-4, ev: 1e-4 });
      parts.surface(ACGeo.linSpace(0, 1, nr), ACGeo.linSpace(0, 1, nc), (u, v, out) => blade(u, v, out, -1), { eu: 1e-4, ev: 1e-4, flip: true });
    }
    parts.pal = pal('fanDark'); place(parts, () => parts.lathe([[xF + 0.02, rH * 1.05], [xF - 0.25 * Rf, rH * 1.1], [xF - 0.5 * Rf, Rf * 1.0]], seg));
    const sp = S.spin === 'point' ? [[xF + Rf * 0.62, 0.004], [xF + Rf * 0.48, rH * 0.42], [xF + Rf * 0.25, rH * 0.82], [xF + 0.02, rH * 1.03]] : [[xF + Rf * 0.46, 0.004], [xF + Rf * 0.42, rH * 0.4], [xF + Rf * 0.28, rH * 0.8], [xF + 0.02, rH * 1.03]];
    nac.bind(fb); place(nac, () => nac.lathe(sp, seg, { uv: (k, ph, s) => [ph / (Math.PI * 2), 0.8 + 0.2 * clamp(k / (sp.length - 1), 0, 1), s, ph * rH] }));
    // pylon: aerofoil sections from the nacelle top up into the wing, the aft fairing along the wing's underside
    const ws = env.wings.find(w => w.side === (e.y >= 0 ? 1 : -1));
    if (ws && e.pylon !== undefined) pylon(e, o, R, Ln, S, ws, eb, ctx);
    // strake on the inboard side of the cowl (the vortex-control fin of the big fans)
    if (!far && m.kind === 'jet' && (e.style === 'leap' || e.style === 'cfm' || e.style === 'chevron')) {
      const zs = -Math.sign(e.y || 1), ang = zs * 38 * D, len2 = R * 0.9, hgt = R * 0.2;
      parts.bind(eb); parts.pal = pal('base');
      parts.at(mat4(new V3(o.x - R * 0.45, o.y + Math.cos(ang) * R * 0.95, o.z + Math.sin(ang) * R * 0.95), new Q4().setFromAxisAngle(X1, -ang)), () => {
        const a = parts.v(0, 0, 0, 0, 0, 1), b = parts.v(-len2, 0, 0, 0, 0, 1), c = parts.v(-len2 * 0.85, hgt, 0, 0, 0, 1);
        parts.tri(a, b, c); const a2 = parts.v(0, 0, 0, 0, 0, -1), b2 = parts.v(-len2, 0, 0, 0, 0, -1), c2 = parts.v(-len2 * 0.85, hgt, 0, 0, 0, -1); parts.tri(a2, c2, b2);
      });
    }
    parts.pal = null; nac.bind(0); parts.bind(0);
    // blur disc just ahead of the fan
    if (!ctx.lite) disc(ctx, env, fb, new V3(o.x + xF + 0.02, o.y, o.z), X1, Rf * 0.99, 'fan', idx);
    env.anim.push((ac, dt, st) => {
      const E = ac.eng[idx]; if (!E) return;
      const n = E.n || 0, b = rig.bone(fb);
      st['fan' + idx] = ((st['fan' + idx] || 0) + Math.min(n * 1.6, 1.25) * Math.PI * 2 * dt) % (Math.PI * 2);
      b.quaternion.setFromAxisAngle(X1, st['fan' + idx]);
      const s2 = rig.bone(sb), revT = ac.ctl.rev && ac.out.onGround ? 1 : 0;
      st['rev' + idx] = (st['rev' + idx] || 0) + clamp(revT - (st['rev' + idx] || 0), -dt / 1.6, dt / 1.6);
      s2.position.copy(s2.userData.rest).x -= R * 0.42 * st['rev' + idx];
      setDisc(env, 'fan', idx, 0.55 * sstep(0.35, 0.95, n));
    });
  }
  function pylon(e, o, R, Ln, S, ws, eb, ctx) {
    const nac = ctx.B.mb('nac'), span = Math.abs(e.y), fr = ws.frame(span, { cd: new V3(), ud: new V3() });
    const lower = (x) => { const xc = clamp((fr.lx - x) / fr.c, 0.001, 0.999), p = ws.P(span, ACGeo.qAt(xc, -1), new V3()); return p.y; };
    const w0 = R * 0.2, top = o.y + R * 0.9, xb0 = o.x - Ln * 0.2, xb1 = o.x - Ln * S.exit * 0.95;
    const xw0 = fr.lx + 0.1, xw1 = fr.lx - fr.c * (e.pylonAft || 0.62);
    // bottom line (on the nacelle), top line (in the wing): x ranges; sections at t (0 bottom .. 1.12 in the wing)
    const sec = (t, v, out) => {
      const tt = clamp(t, 0, 1.15), xf = lerp(xb0, xw0, Math.min(tt, 1)), xa = lerp(xb1, xw1, Math.pow(Math.min(tt, 1), 0.55));
      const x01 = (1 - Math.cos(2 * Math.PI * v)) / 2, xx = lerp(xf, xa, x01), sgn = v < 0.5 ? 1 : -1;
      const th = w0 * (1 - 0.35 * tt) * 2.2 * Math.sqrt(Math.max(0, x01)) * (1 - x01) * 1.4;
      const yb = top - R * 0.05, yt = lower(xx) + 0.12, y = lerp(yb, yt, tt);
      return out.set(xx, y, o.z + sgn * th);
    };
    nac.bind(eb); const pv = [0.5, 0.62];
    nac.surface(ACGeo.linSpace(0, 1.12, ctx.far ? 2 : [4, 5, 7, 8, 10][ctx.q]), ACGeo.linSpace(0, 1, ctx.far ? 5 : [8, 10, 14, 18, 22][ctx.q]), sec, { eu: 1e-4, ev: 1e-5, flip: true, uv: (t, v, i, j, p) => [pv[0], pv[1], p.x, p.y] });
    nac.bind(0);
  }

  // ---------------------------------------------------------------- blur discs (props, fans, rotors)
  function disc(ctx, env, bone, c, axis, r, kind, idx) {
    const mb = ctx.B.mb('disc'), q = new Q4().setFromUnitVectors(Z1, axis);
    mb.bind(bone);
    mb.at(mat4(c, q), () => {
      const n = 48, rings = [0, 0.25, 0.6, 0.92, 1];
      for (const face of [1, -1]) {
        const base = mb.count;
        for (const rr of rings) for (let k = 0; k <= n; k++) { const a = k / n * Math.PI * 2; mb.v(Math.cos(a) * r * rr, Math.sin(a) * r * rr, face * 0.004, 0, 0, face, 0.5 + 0.5 * rr * Math.cos(a), 0.5 + 0.5 * rr * Math.sin(a)); }
        for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < n; k++) { const a = base + i * (n + 1) + k, b = a + n + 1; face > 0 ? mb.quad(a, b, b + 1, a + 1) : mb.quad(a, a + 1, b + 1, b); }
      }
    });
    mb.bind(0);
    (env.discs || (env.discs = {}))[kind + idx] = 0;
  }
  function setDisc(env, kind, idx, a) { if (env.discs) env.discs[kind + idx] = a; }

  // ---------------------------------------------------------------- propellers
  function prop(e, idx, ctx, env) {
    const { B, rig, q, pal } = ctx, m = ctx.type.model, turbo = ctx.type.fdm.engines[idx] && ctx.type.fdm.engines[idx].type === 'turboprop';
    const o = P(e.x, e.y, e.z), R = e.d / 2, seg = [10, 14, 20, 26, 32][q];
    const parent = e.y ? flexBone(env, e.y) : 0, eb = rig.add(parent, o.x, o.y, o.z);
    const parts = B.mb('parts');
    // the nacelle (twins): a lathe from the spinner back under the wing, exhausts on its sides
    if (e.nacelle) {
      const nd = e.nacelle.d / 2, nl = e.nacelle.len, radial = e.nacelle.d > 1.2, x0 = -e.spinner * 0.35;
      const pr = radial ? [[x0, nd * 0.62], [x0 - 0.05, nd * 0.97], [x0 - 0.25, nd], [x0 - 0.9, nd * 0.98], [x0 - 1.05, nd * 0.93], [x0 - 1.1, nd * 0.9], [x0 - nl * 0.55, nd * 0.82], [x0 - nl * 0.85, nd * 0.55], [x0 - nl, nd * 0.08]]
        : [[x0, e.spinner * 0.52], [x0 - 0.12, nd * 0.78], [x0 - 0.4, nd * 0.97], [x0 - nl * 0.35, nd], [x0 - nl * 0.65, nd * 0.9], [x0 - nl * 0.88, nd * 0.55], [x0 - nl, nd * 0.12]];
      parts.bind(eb); parts.pal = e.nacelle.color ? pal('aluDull') : pal('base');
      parts.at(mat4(o, null, new V3(1, radial ? 1 : 1.12, 1)), () => parts.lathe(pr, seg));
      if (radial) {    // the engine face inside the cowl ring, cowl flaps behind
        parts.pal = pal('darkMetal'); parts.at(mat4(o), () => parts.lathe([[x0 - 0.02, nd * 0.62], [x0 - 0.2, nd * 0.6], [x0 - 0.25, nd * 0.3], [x0 - 0.2, 0.01]], seg, { flip: true }));
        parts.pal = pal('black'); parts.at(mat4(o), () => parts.lathe([[x0 - 1.1, nd * 0.9], [x0 - 1.1, nd * 0.9], [x0 - 1.12, nd * 0.86], [x0 - 1.4, nd * 0.85]], seg));
      } else {        // PT6: a chin intake and two exhaust stacks
        parts.pal = pal('black'); parts.at(mat4(new V3(o.x - 0.25, o.y - nd * 0.72, o.z), null, new V3(1, 0.5, 1)), () => parts.lathe([[0.02, nd * 0.34], [0.02, nd * 0.34], [0, nd * 0.3], [-0.3, nd * 0.2]], 12));
        parts.pal = pal('exhaust');
        for (const sd of [1, -1]) { const a = new V3(o.x - nl * 0.3, o.y + nd * 0.1, o.z + sd * nd * 0.85), b = a.clone().add(new V3(-0.35, 0.05, sd * 0.2)); parts.cyl(a, b, nd * 0.2, nd * 0.24, 12, false); }
      }
      parts.pal = null;
    }
    // hub bone (spins), blades (each on its own bone: pitch, feathering), spinner
    const hb = rig.add(eb, o.x, o.y, o.z), nb = e.blades, rs = e.spinner / 2, single = !e.y && m.kind !== 'jet';
    const sl = single ? Math.max(rs * 1.25, (m.nose - e.x) * 0.97) : rs * 1.25;          // (a single's spinner is its nose)
    const spin = [[sl, 0.004], [sl * 0.86, rs * 0.45], [sl * 0.56, rs * 0.85], [sl * 0.2, rs], [-rs * 0.15, rs * 0.98]];
    if (single && e.cowl) {         // the cowl's two air inlets beside the spinner and the exhaust stack below
      parts.bind(eb); parts.pal = pal('black');
      for (const sd of [1, -1]) parts.at(mat4(new V3(o.x - 0.06, o.y + rs * 0.35, o.z + sd * (rs + 0.13)), new Q4().setFromUnitVectors(X1, new V3(-1, 0, 0)), new V3(1, 0.7, 1.25)), () => parts.lathe([[0, 0.11], [0, 0.11], [0.02, 0.1], [0.12, 0.06], [0.12, 0.001]], 12, { flip: false }));
      parts.pal = pal('exhaust'); parts.cyl(new V3(o.x - 0.55, o.y - rs * 2.2, o.z + 0.12), new V3(o.x - 0.8, o.y - rs * 2.6, o.z + 0.16), 0.035, 0.04, 8, false);
      parts.pal = null;
    }
    parts.bind(hb); parts.pal = pal('spinner'); parts.at(mat4(o), () => parts.lathe(spin, seg));
    const blades = [], nr = [4, 5, 7, 9, 11][q], nc = [3, 3, 4, 5, 6][q];
    for (let k = 0; k < nb; k++) {
      const ph = k * Math.PI * 2 / nb, dir = new V3(0, Math.cos(ph), Math.sin(ph));
      const bb = rig.add(hb, o.x, o.y + dir.y * rs * 0.7, o.z + dir.z * rs * 0.7);
      parts.bind(bb);
      // blade section at radius r: chord, pitch angle from the rotation plane; tip stripe
      const r0 = rs * 0.75, bl = (u, v, out, s2) => {
        const r = lerp(r0, R, u), c = R * (0.065 + 0.075 * Math.sin(Math.PI * Math.min(1, 0.25 + u * 0.95))) * (u > 0.93 ? 1 - (u - 0.93) * 6 : 1);
        const pitch = Math.atan2(R * 0.75, Math.PI * Math.max(r, R * 0.2)) * 0.9, t2 = c * 0.07 * (1 - Math.pow(2 * v - 1, 2)) * s2;
        const cx = (v - 0.35) * c, ax = -cx * Math.sin(pitch) + t2 * Math.cos(pitch), tg = cx * Math.cos(pitch) + t2 * Math.sin(pitch);
        const tan = new V3(0, -Math.sin(ph), Math.cos(ph));
        return out.set(o.x + ax, o.y + dir.y * r + tan.y * tg, o.z + dir.z * r + tan.z * tg);
      };
      const tipU = 1 - 0.08 * 0.9;
      for (const [u0, u1, sw] of [[0, tipU, 'propBlack'], [tipU, 1, 'propTip']]) {
        parts.pal = pal(sw);
        const us = ACGeo.linSpace(u0, u1, u0 ? 1 : nr);
        parts.surface(us, ACGeo.linSpace(0, 1, nc), (u, v, out) => bl(u, v, out, 1), { eu: 1e-4, ev: 1e-4, flip: true });
        parts.surface(us, ACGeo.linSpace(0, 1, nc), (u, v, out) => bl(u, v, out, -1), { eu: 1e-4, ev: 1e-4 });
      }
      // root cuff
      parts.pal = pal('propBlack'); parts.cyl(new V3(o.x, o.y + dir.y * rs * 0.6, o.z + dir.z * rs * 0.6), new V3(o.x, o.y + dir.y * r0 * 1.12, o.z + dir.z * r0 * 1.12), R * 0.035, R * 0.028, 8, false);
      blades.push({ bone: bb, axis: dir.clone() });
    }
    parts.pal = null; parts.bind(0);
    if (!ctx.lite) disc(ctx, env, hb, new V3(o.x + 0.02, o.y, o.z), X1, R, 'prop', idx);
    env.anim.push((ac, dt, st) => {
      const E = ac.eng[idx]; if (!E) return;
      const n = E.n || 0, b = rig.bone(hb);
      // (a visual rate the eye accepts: the blades turn visibly at idle, then the disc takes over)
      st['prop' + idx] = ((st['prop' + idx] || 0) + Math.min(n * 30, 9) * dt) % (Math.PI * 2);
      b.quaternion.setFromAxisAngle(X1, st['prop' + idx]);
      const feather = turbo && n < 0.08 ? 70 : 0, beta = ac.ctl.rev && ac.out.onGround ? -18 : 0;
      st['pitch' + idx] = (st['pitch' + idx] || 0) + clamp(feather + beta - (st['pitch' + idx] || 0), -dt * 30, dt * 30);
      for (const bl of blades) rig.bone(bl.bone).quaternion.setFromAxisAngle(bl.axis, st['pitch' + idx] * D);
      setDisc(env, 'prop', idx, 0.3 * sstep(0.22, 0.6, n));
      for (const bl of blades) rig.bone(bl.bone).scale.setScalar(n > 0.62 ? 0.001 : 1);     // (the blades vanish into the disc)
    });
  }

  // ---------------------------------------------------------------- jets: the F-16's F110 and the Concorde's Olympus
  function jet(e, idx, ctx, env) {
    const { B, rig, q, pal } = ctx, m = ctx.type.model, seg = [12, 16, 24, 32, 40][q];
    const o = P(e.x, e.y, e.z), parts = B.mb('parts'), rN = (e.d || 1.2) / 2, eb = rig.add(0, o.x, o.y, o.z);
    parts.bind(eb);
    if (e.box) {
      // Concorde: each pair of engines in one nacelle under the wing (built with the inboard engine): a rounded box
      // whose top runs into the wing, the intakes raked back from the lower lip with a splitter between them, and
      // each engine's nozzle and reverser buckets at the back
      const [bl, bw, bh] = e.box, pairY = Math.sign(e.y) * (Math.abs(e.y) + bw / 2), first = Math.abs(e.y) < 4.5;
      if (first) {
        const cz = pairY, hw = bw * 0.98, hh = bh / 2, xF = o.x + bl - 0.6, xR = o.x - 0.55, yc = o.y, ramp = 1.2, nb = ctx.B.mb('nac'), ws = env.wings.find(w => w.side === Math.sign(e.y));
        const wingLow = (x) => { if (!ws) return yc + hh; const span = Math.abs(cz), fr = ws.frame(span, { cd: new V3(), ud: new V3() }), xc = clamp((fr.lx - x) / fr.c, 0.001, 0.999); return ws.P(span, ACGeo.qAt(xc, -1), new V3()).y; };
        const sec = (u, v, out, inset = 0) => {
          // (the mouth is raked: its lower lip reaches furthest forward)
          const a = v * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), xx = lerp(xF - ramp * ca, xR, u);
          const top = Math.max(yc + hh, wingLow(xx) + 0.2), bot = yc - hh, ym = (top + bot) / 2, hy = (top - bot) / 2 - inset, hz = hw - inset;
          return out.set(xx, ym + Math.sign(ca) * Math.pow(Math.abs(ca), 0.25) * hy, cz + Math.sign(sa) * Math.pow(Math.abs(sa), 0.25) * hz);
        };
        nb.bind(0);
        nb.surface(ACGeo.linSpace(0, 1, [6, 8, 12, 14, 18][q]), ACGeo.linSpace(0, 1, seg), (u, v, out) => sec(u, v, out), { eu: 1e-4, ev: 1e-4, uv: () => [0.5, 0.62] });
        // the intake mouths (dark), the splitter, the lip
        parts.bind(0); parts.pal = pal('inlet');
        parts.surface(ACGeo.linSpace(0, 0.18, 2), ACGeo.linSpace(0, 1, seg), (u, v, out) => sec(u, v, out, 0.07), { eu: 1e-4, ev: 1e-4, flip: true, uv: () => [0, 0] });
        parts.pal = pal('black'); parts.surface(ACGeo.linSpace(0, 1, 1), ACGeo.linSpace(0, 1, seg), (k, v, out) => sec(0.18, v, out, 0.07).lerp(sec(0.18, 0.25, new V3(), 0.07).setZ(cz), k), { eu: 1e-4, ev: 1e-4, uv: () => [0, 0] });
        parts.pal = pal('base'); const sp0 = sec(0, 0.5, new V3()); parts.box(sp0.x - 0.6, yc, cz, 1.2, bh * 0.92, 0.05);
        parts.pal = pal('aluDull'); parts.surface(ACGeo.linSpace(0, 1, 2), ACGeo.linSpace(0, 1, seg), (k, v, out) => sec(0, v, out, 0).lerp(sec(0, v, new V3(), 0.07), k), { eu: 1e-4, ev: 1e-4, flip: true, uv: () => [0, 0] });
        parts.pal = null;
      }
      // this engine's nozzle, its reverser buckets
      parts.bind(eb); parts.pal = pal('afterburner'); parts.at(mat4(o), () => parts.lathe([[0.1, rN * 0.9], [-0.6, rN * 0.88], [-0.9, rN * 0.82], [-0.9, rN * 0.82], [-0.8, rN * 0.7], [0.05, rN * 0.72]], seg));
      parts.pal = pal('exhaust'); for (const sd of [1, -1]) parts.at(mat4(new V3(o.x - 0.95, o.y + sd * rN * 0.45, o.z)), () => parts.lathe([[0.25, rN * 0.95], [-0.35, rN * 0.85]], seg, { a0: sd > 0 ? -Math.PI / 2 : Math.PI / 2, a1: sd > 0 ? Math.PI / 2 : Math.PI * 1.5 }));
      parts.pal = null;
    } else {
      // F-16: a convergent-divergent nozzle of petals, the afterburner liner inside
      parts.pal = pal('darkMetal'); parts.at(mat4(o), () => parts.lathe([[0.25, 0.62], [0, 0.6], [-0.5, 0.56], [-0.95, 0.5], [-0.95, 0.5], [-0.9, 0.44], [0, 0.46]], seg, { mod: (k, ph) => (k > 1 && k < 4 ? 1 + 0.02 * Math.cos(ph * 15) : 1) }));
      parts.pal = pal('afterburner'); parts.at(mat4(o), () => parts.lathe([[0, 0.46], [0.6, 0.44], [0.6, 0.44], [0.62, 0.001]], seg));
      if (e.intake) {       // the chin intake: a wide rounded mouth under the forebody, its duct running aft into the belly
        const H = ctx.H, x0 = e.intake.x, nb = ctx.B.mb('parts');
        const duct = (u, v, out, inset) => {
          const x = x0 - u * 3.6, s = H.nose - x, sc = H.sec(s), bot = sc.yc - sc.dn, a = v * Math.PI * 2;
          const hw = lerp(0.5, 0.64, Math.min(1, u * 1.5)) - inset, hh = lerp(0.3, 0.26, u) - inset * 0.8, cy = Math.min(bot + 0.12, -0.2) - hh + 0.08;
          const ca = Math.cos(a), sa = Math.sin(a), rx = Math.sign(sa) * Math.pow(Math.abs(sa), 0.7) * hw, ry = Math.sign(ca) * Math.pow(Math.abs(ca), 0.8) * hh;
          const rake = (1 - ca) * 0.5 * 0.28 * (u === 0 ? 1 : Math.max(0, 1 - u * 20));        // (the lower lip reaches forward)
          return out.set(x + rake, cy + ry, rx);
        };
        nb.bind(0); nb.pal = pal('base');
        nb.surface(ACGeo.linSpace(0, 1, [4, 6, 8, 10, 12][q]), ACGeo.linSpace(0, 1, seg), (u, v, out) => duct(u, v, out, 0), { eu: 1e-4, ev: 1e-4 });
        nb.pal = pal('alu'); nb.surface(ACGeo.linSpace(0, 1, 2), ACGeo.linSpace(0, 1, seg), (k, v, out) => { const a2 = duct(0, v, new V3(), 0), b2 = duct(0, v, new V3(), 0.04); return out.copy(a2).lerp(b2, k).add(new V3(0.02 * Math.sin(Math.PI * k), 0, 0)); }, { eu: 1e-4, ev: 1e-4, flip: true });
        nb.pal = pal('inlet'); nb.surface(ACGeo.linSpace(0, 0.45, 3), ACGeo.linSpace(0, 1, seg), (u, v, out) => duct(u, v, out, 0.04), { eu: 1e-4, ev: 1e-4, flip: true });
        nb.pal = pal('black'); nb.surface(ACGeo.linSpace(0, 1, 1), ACGeo.linSpace(0, 1, seg), (k, v, out) => duct(0.45, v, out, 0.04).lerp(duct(0.45, 0.25, new V3(), 0.5), k), { eu: 1e-4, ev: 1e-4 });
        nb.pal = null;
      }
      // the F-16's details: the nose pitot boom, the drag-chute housing at the fin's root, the split speed brakes
      // beside the nozzle (they open with the speed brake control)
      if (m.kind === 'fighter') {
        const H = ctx.H, vt = m.vtail, nb = ctx.B.mb('parts'); nb.bind(0);
        const tip = new V3(); H.pt(0.02, 0, tip); tip.y = H.sec(0.02).yc;
        nb.pal = pal('aluDull'); nb.cyl(new V3(tip.x - 0.05, tip.y, 0), new V3(tip.x + 0.55, tip.y, 0), 0.03, 0.012, 8, true);
        const hx0 = vt.x - vt.c0 * 0.55, hx1 = vt.x - vt.c0 - 0.75, hy = -vt.z + 0.05;
        nb.pal = pal('base'); nb.at(mat4(new V3(hx0, hy, 0), new Q4().setFromUnitVectors(X1, new V3(-1, 0, 0)), new V3(1, 1.3, 0.75)), () => nb.lathe([[0, 0.001], [0, 0.18], [0.3, 0.2], [hx0 - hx1 - 0.25, 0.19], [hx0 - hx1, 0.12], [hx0 - hx1, 0.001]], 12));
        const sbs = [];
        for (const sd of [1, -1]) for (const ud of [1, -1]) {
          const hx = o.x + 1.25, b2 = rig.add(0, hx, o.y + ud * 0.04, sd * 0.66);
          nb.bind(b2); nb.pal = pal('base');
          nb.box(hx - 0.55, o.y + ud * 0.2, sd * 0.66, 1.1, 0.34, 0.035);
          sbs.push({ bone: b2, ud, sd });
        }
        nb.bind(0); nb.pal = null;
        env.anim.push((ac) => { const k = clamp(ac.spoilerPos || 0, 0, 1) * 55 * D; for (const b2 of sbs) rig.bone(b2.bone).quaternion.setFromAxisAngle(Z1, -b2.ud * k).premultiply(new Q4().setFromAxisAngle(Y1, b2.sd * k * 0.25)); });
      }
    }
    parts.pal = null; parts.bind(0);
    // reheat: an additive flame on its own bone (scaled with the afterburner)
    const fb = rig.add(eb, o.x - (e.box ? 0.9 : 0.95), o.y, o.z);
    const fl = B.mb('flame'); fl.bind(fb);
    const L2 = e.box ? 7 : 5.2, r2 = rN * (e.box ? 0.85 : 0.8);
    fl.at(mat4(new V3(o.x - (e.box ? 0.9 : 0.95), o.y, o.z)), () => { for (let k = 0; k < 3; k++) fl.at(mat4(null, new Q4().setFromAxisAngle(X1, k * Math.PI / 3)), () => {
      const n = 10, base = fl.count; for (let i = 0; i <= n; i++) { const u = i / n, r = r2 * (1 - u) * (1 + 0.15 * Math.sin(u * 20)); fl.v(-u * L2, r, 0, 0, 0, 1, u, 0); fl.v(-u * L2, -r, 0, 0, 0, 1, u, 1); }
      for (let i = 0; i < n; i++) { const a = base + i * 2; fl.quad(a, a + 1, a + 3, a + 2); fl.quad(a, a + 2, a + 3, a + 1); } }); });
    fl.bind(0);
    env.anim.push((ac, dt, st) => {
      const E = ac.eng[idx]; if (!E) return;
      const ab = ac.ctl.thr > 1.001 ? clamp(((E.n || 0) - 0.95) * 20, 0, 1) : 0;
      st['ab' + idx] = (st['ab' + idx] || 0) + clamp(ab - (st['ab' + idx] || 0), -dt * 3, dt * 3);
      const k = st['ab' + idx], b = rig.bone(fb); b.scale.set(0.6 + 0.4 * k + 0.05 * Math.sin(st.t * 40 + idx), k > 0.01 ? 1 : 0.001, k > 0.01 ? 1 : 0.001);
      st.flame = Math.max(st.flame || 0, k);
    });
  }

  // ---------------------------------------------------------------- rotors (H125)
  function rotors(m, ctx, env) {
    const { B, rig, q, pal, H } = ctx, R = m.rotor, parts = B.mb('parts');
    const hubY = -R.z, top = H.crown, seg = [10, 14, 18, 24, 30][q];
    // engine cowling and mast fairing behind the rotor, the exhaust
    const nb = B.mb('body'); nb.bind(0);
    const cw = (u, v, out) => { const x = R.x + 0.5 - u * 2.6, a = v * Math.PI, w2 = 0.55 * Math.sin(Math.PI * Math.min(1, 0.15 + u * 0.95)) + 0.1, h2 = 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.1 + u * 0.95)), 0.8);
      return out.set(x, top - 0.2 + Math.sin(a) * h2, Math.cos(a) * w2); };
    nb.bind(0); const pb0 = B.mb('parts'); pb0.bind(0); pb0.pal = pal('base');
    pb0.surface(ACGeo.linSpace(0, 1, 10), ACGeo.linSpace(0, 1, 12), cw, { eu: 1e-4, ev: 1e-4, flip: true }); pb0.pal = null;
    parts.bind(0); parts.pal = pal('exhaust'); parts.cyl(new V3(R.x - 2.0, top + 0.12, 0.25), new V3(R.x - 2.5, top + 0.2, 0.45), 0.16, 0.2, 12, false);
    parts.pal = pal('gearGrey'); parts.cyl(new V3(R.x, top + 0.1, 0), new V3(R.x, hubY - 0.05, 0), 0.1, 0.09, 12);
    // hub (spins) and the blades (each on a bone that cones)
    const hb = rig.add(0, R.x, hubY, 0);
    parts.bind(hb); parts.pal = pal('darkMetal'); parts.cyl(new V3(R.x, hubY - 0.18, 0), new V3(R.x, hubY + 0.12, 0), 0.28, 0.2, 16);
    const blades = [];
    for (let k = 0; k < R.blades; k++) {
      const ph = k * Math.PI * 2 / R.blades, dir = new V3(Math.cos(ph), 0, Math.sin(ph)), tan = new V3(-Math.sin(ph), 0, Math.cos(ph));
      const bb = rig.add(hb, R.x + dir.x * 0.3, hubY, dir.z * 0.3);
      parts.bind(bb); parts.pal = pal('rotor');
      const bl = (u, v, out, s2) => { const r = lerp(0.35, R.R, u), c = R.chord * (u > 0.96 ? 0.8 : 1), tw = (8 - 10 * u) * D, t2 = c * 0.06 * (1 - Math.pow(2 * v - 1, 2)) * s2, cx = (v - 0.3) * c;
        return out.set(R.x + dir.x * r + tan.x * (cx * Math.cos(tw)), hubY + 0.02 - cx * Math.sin(tw) + t2, dir.z * r + tan.z * (cx * Math.cos(tw))); };
      parts.surface(ACGeo.linSpace(0, 1, [4, 6, 8, 10, 12][q]), ACGeo.linSpace(0, 1, 3), (u, v, o2) => bl(u, v, o2, 1), { eu: 1e-4, ev: 1e-4, flip: true });
      parts.surface(ACGeo.linSpace(0, 1, [4, 6, 8, 10, 12][q]), ACGeo.linSpace(0, 1, 3), (u, v, o2) => bl(u, v, o2, -1), { eu: 1e-4, ev: 1e-4 });
      parts.pal = pal('gearGrey'); parts.cyl(new V3(R.x + dir.x * 0.15, hubY, dir.z * 0.15), new V3(R.x + dir.x * 0.75, hubY + 0.02, dir.z * 0.75), 0.07, 0.05, 8);
      blades.push({ bone: bb, axis: tan.clone() });
    }
    parts.pal = null;
    if (!ctx.lite) disc(ctx, env, hb, new V3(R.x, hubY + 0.03, 0), Y1, R.R, 'rotor', 0);
    // tail rotor (left side of the boom), two blades
    const TR = m.tailRotor, tc = P(TR.x, TR.y, TR.z), tb = rig.add(0, tc.x, tc.y, tc.z);
    parts.bind(tb); parts.pal = pal('rotor');
    for (let k = 0; k < TR.blades; k++) parts.at(mat4(tc, new Q4().setFromAxisAngle(Z1, k * Math.PI * 2 / TR.blades)), () => parts.box(TR.R / 2 + 0.05, 0, 0, TR.R, 0.018, 0.16));
    parts.pal = pal('darkMetal'); parts.cyl(new V3(tc.x, tc.y, tc.z + 0.12), new V3(tc.x, tc.y, tc.z - 0.05), 0.07, 0.07, 10);
    parts.pal = null; parts.bind(0);
    if (!ctx.lite) disc(ctx, env, tb, new V3(tc.x, tc.y, tc.z - 0.02), Z1, TR.R, 'tail', 0);
    // skids
    if (m.skids) {
      const K = m.skids; parts.pal = pal('skid');
      for (const sd of [1, -1]) {
        const a = P(K.x0, sd * K.y, K.z), b = P(K.x1, sd * K.y, K.z); parts.cyl(a, b, 0.045, 0.045, 10, true);
        parts.cyl(a, a.clone().add(new V3(0.35, 0.28, 0)), 0.045, 0.04, 10, true);
        for (const cx of [K.x0 - 0.5, K.x1 + 0.55]) { const p0 = P(cx, sd * K.y, K.z), p1 = P(cx, sd * 0.62, K.z - 0.55), p2 = P(cx, sd * 0.45, K.z - 0.8);
          parts.cyl(p0, p1, 0.05, 0.05, 10, true); parts.cyl(p1, p2, 0.05, 0.05, 10, true); }
      }
      parts.pal = null;
    }
    env.anim.push((ac, dt, st) => {
      const rt = ac.rotor; if (!rt) return;
      const rpm = rt.rpm || 0, fast = sstep(0.35, 0.9, rpm);
      st.rotA = ((st.rotA || 0) + dt * Math.min(rpm * 26, 8.5)) % (Math.PI * 2);
      const hbB = rig.bone(hb); hbB.quaternion.setFromEuler(new THREE.Euler((rt.b1 || 0) * 1.4, 0, -(rt.a1 || 0) * 1.4, 'XZY')).multiply(new Q4().setFromAxisAngle(Y1, -st.rotA));
      const cone = (2.5 + 3 * clamp((rt.T || 0) / 16000, 0, 1.5)) * D * rpm;
      for (const b of blades) rig.bone(b.bone).quaternion.setFromAxisAngle(b.axis, -cone);
      rig.bone(tb).quaternion.setFromAxisAngle(Z1, st.rotA * 4.3);
      for (const b of blades) rig.bone(b.bone).scale.setScalar(fast > 0.85 ? 0.001 : 1);
      setDisc(env, 'rotor', 0, 0.2 * fast); setDisc(env, 'tail', 0, 0.28 * sstep(0.4, 1, rpm));
    });
  }

  // ---------------------------------------------------------------- landing gear
  // Each leg from the FDM's layout (x, y, z = the tyre's bottom at full extension, r = tyre radius): a strut from a
  // trunnion inside the airframe, the chrome piston that slides with the compression, torque links, the axle or
  // bogie, tyres and hubs; retraction about the trunnion (mains inward, nose gear forward, body gear per type).
  function gear(type, ctx, env) {
    const m = type.model, f = type.fdm, { B, rig, q, pal, H } = ctx, parts = B.mb('parts'), seg = [10, 14, 20, 24, 32][q];
    const legs = f.gear, retract = f.retract, jet = m.kind === 'jet';
    const out = [];
    legs.forEach((L, i) => {
      if (L.skid) return;
      const nose = !!L.nose, tail = !!L.tail, fixed = !retract || !!L.fixed;
      const wc = P(L.x, L.y, L.z - L.r), r = L.r, nW = L.wheels || 1;
      // the trunnion: in the wing (low-wing mains), in the fuselage (nose, body gear), under a high wing (struts)
      const s = m.nose - wc.x, sec = H.sec(clamp(s, 0, m.L));
      const keelY = sec.yc - sec.dn;
      const ws = env.wings.find(w => w.side === (L.y >= 0 ? 1 : -1));
      let topY;
      if (nose || tail || !ws || (m.wing && m.wing.high) || Math.abs(L.y) < (m.fus.d || m.fus.w || 2) * 0.45) topY = keelY + (tail ? 0.35 : 0.3);
      else { const fr = ws.frame(Math.abs(L.y), { cd: new V3(), ud: new V3() }); topY = fr.ly - 0.05; }
      if (m.kind === 'ga' && !tail && !nose && m.wing && m.wing.high) topY = keelY + 0.15;
      topY = Math.max(topY, wc.y + r * 1.6);
      // retraction: the nose and body gear fold forward (or aft) into the fuselage, the wing gear sideways into the
      // belly (the trunnion height inside the wing, the angle and the strut shortening chosen so the wheels stow in
      // the belly fairing), twins' mains forward into the nacelles
      const sd = L.y >= 0 ? 1 : -1, bodyGear = !nose && jet && Math.abs(L.y) < (m.fus.d || 2) * 0.45;
      const twin0 = nW === 2, bogie0 = nW >= 4, tw0 = r * (jet ? 0.62 : 0.55);
      let axis, ang, shorten = 0, sideways = false, S2 = null;
      if (nose && !tail) { axis = Z1.clone(); ang = (m.kind === 'fighter' || ctx.type.id === 'b350' ? -1 : 1) * 96 * D; }
      else if (bodyGear) { axis = Z1.clone(); ang = (m.gear && m.gear.bodyAft ? -1 : 1) * 92 * D; }
      else if (m.kind === 'ga' || ctx.type.id === 'b350' || ctx.type.id === 'dc3') { axis = Z1.clone(); ang = 88 * D; }
      else {
        axis = X1.clone(); sideways = true;
        const rc0 = (nose ? 0.055 : 0.085) * Math.sqrt(Math.max(0.3, r / 0.4)) * (jet ? 1.35 : 0.9);
        S2 = fixed ? { a: 88, sh: 0, lift: 0 } : stowSide(H, ctx.type.id + '/' + i, new V3(wc.x, topY, wc.z), wc, r, twin0 || bogie0 ? rc0 * 0.9 + tw0 + 0.03 : tw0 / 2, bogie0 ? r * 1.125 : 0, sd, keelY);
        topY += S2.lift; ang = sd * S2.a * D; shorten = S2.sh;
      }
      const top = new V3(wc.x, topY, wc.z), Ls = top.y - wc.y;
      const rc = (nose ? 0.055 : 0.085) * Math.sqrt(Math.max(0.3, r / 0.4)) * (jet ? 1.35 : 0.9), rp = rc * 0.7;
      // bones: the leg (retracts about the trunnion), the piston (slides; steers on the nose gear), the axles
      const legB = rig.add(0, top.x, top.y, top.z);
      const pisB = rig.add(legB, wc.x, wc.y + r * 0.1, wc.z);
      const style = m.gear;
      const bogie = nW >= 4, twin = nW === 2;
      // strut (upper cylinder), piston
      const gp = jet ? pal('gearPaint') : pal('gearGrey');
      parts.bind(legB); parts.pal = gp;
      const cylBot = wc.y + Ls * 0.34 + (bogie ? r * 0.3 : 0), spring = m.kind === 'ga' && !nose && !tail && fixed;
      const tw = r * (jet ? 0.62 : 0.55), gap = rc * 0.9 + tw / 2 + 0.03;
      if (!spring) parts.cyl(new V3(top.x, top.y + 0.2, top.z), new V3(top.x, cylBot, top.z), rc, rc * 1.05, seg, true);
      if (!fixed && !tail && !nose && jet) {     // side stay: a brace from the strut to the structure outboard / aft
        const b0 = new V3(top.x, lerp(top.y, cylBot, 0.55), top.z), b1 = new V3(top.x - 0.25, top.y + 0.1, top.z + Math.sign(L.y || 1) * Ls * 0.45);
        parts.cyl(b0, b1, rc * 0.4, rc * 0.4, 8, true);
      }
      if (m.kind === 'ga' && !nose && !tail && fixed) {   // spring steel leg: a flat, tapered blade from the belly edge out to the axle
        parts.bind(pisB); parts.pal = pal('gearGrey');
        const sd = Math.sign(L.y || 1), a0 = new V3(wc.x, keelY + 0.12, sd * Math.max(0.3, (m.fus.w || 1.1) * 0.36)), a1 = new V3(wc.x, wc.y + r * 0.15, wc.z - sd * (r * 0.35 + 0.02));
        const ax = a1.clone().sub(a0), len = ax.length(); ax.normalize();
        const side = new V3().crossVectors(ax, X1).normalize();
        parts.surface(ACGeo.linSpace(0, 1, 4), ACGeo.linSpace(0, 1, 10), (u, v, out) => { const w2 = lerp(0.075, 0.045, u), t2 = lerp(0.022, 0.016, u), a = v * Math.PI * 2;
          return out.copy(a0).addScaledVector(ax, u * len).addScaledVector(X1, Math.cos(a) * w2).addScaledVector(side, Math.sin(a) * t2); }, { eu: 1e-4, ev: 1e-4, flip: true });
      }
      parts.bind(pisB); parts.pal = pal('chrome');
      if (!spring) parts.cyl(new V3(wc.x, cylBot + 0.25, wc.z), new V3(wc.x, wc.y + r * 0.15, wc.z), rp, rp, seg, false);
      // torque links: two plates meeting at an apex in front of the strut (opening with the compression)
      parts.pal = gp;
      const linkUp = rig.add(legB, wc.x + rc * 1.2, cylBot + 0.02, wc.z), linkLo = rig.add(pisB, wc.x + rc * 1.2, wc.y + r * 0.25, wc.z);
      const apex0 = new V3(wc.x + rc * 1.2 + Math.max(0.12, Ls * 0.1), (cylBot + wc.y + r * 0.25) / 2, wc.z);
      parts.bind(linkUp); parts.cyl(new V3(wc.x + rc * 1.2, cylBot + 0.02, wc.z), apex0, rc * 0.28, rc * 0.28, 6, true);
      parts.bind(linkLo); parts.cyl(apex0, new V3(wc.x + rc * 1.2, wc.y + r * 0.25, wc.z), rc * 0.28, rc * 0.28, 6, true);
      // axle(s) and wheels
      const axles = [];
      if (bogie) {
        const beamB = rig.add(pisB, wc.x, wc.y, wc.z), nAx = style && style.body6 && Math.abs(L.y) < 3 ? 3 : 2, pitch = r * 2.25;
        parts.bind(beamB); parts.pal = gp;
        parts.cyl(new V3(wc.x + pitch * (nAx - 1) / 2 + r * 0.3, wc.y, wc.z), new V3(wc.x - pitch * (nAx - 1) / 2 - r * 0.3, wc.y, wc.z), rc * 0.6, rc * 0.6, seg, true);
        for (let k = 0; k < nAx; k++) { const ax = wc.x + pitch * ((nAx - 1) / 2 - k); axles.push({ c: new V3(ax, wc.y, wc.z), parent: beamB }); }
        out.push({ i, beamB, nAx });
        out[out.length - 1].bogie = true;
      } else axles.push({ c: wc.clone(), parent: pisB });
      for (const A of axles) {
        const ab = rig.add(A.parent, A.c.x, A.c.y, A.c.z); A.bone = ab;
        const zs = twin || bogie ? [-gap, gap] : [0];
        parts.bind(A.parent); parts.pal = gp; if (zs.length > 1) parts.cyl(new V3(A.c.x, A.c.y, A.c.z - gap - tw * 0.3), new V3(A.c.x, A.c.y, A.c.z + gap + tw * 0.3), rc * 0.45, rc * 0.45, 8, true);
        parts.bind(ab);
        for (const dz of zs) wheel(parts, pal, new V3(A.c.x, A.c.y, A.c.z + dz), r, tw, seg, dz >= 0 ? 1 : -1);
      }
      // wheel fairings on light aircraft
      if (m.gear && m.gear.pants && !tail) {
        parts.bind(pisB); parts.pal = pal('base');
        parts.at(mat4(new V3(wc.x - r * 0.15, wc.y + r * 0.05, wc.z), null, new V3(1, r * 1.25, tw * 1.25)), () => parts.lathe([[r * 1.6, 0.001], [r * 1.3, 0.55], [r * 0.4, 0.98], [-r * 1.2, 0.75], [-r * 2.1, 0.001]], seg, {}));
      }
      let stowed = null;
      const hasDoors = !fixed && (m.gear && m.gear.doors !== undefined ? !!m.gear.doors : jet || m.kind === 'fighter');
      if (sideways) { const Lh = top.y - wc.y - shorten; stowed = new V3(wc.x, top.y - Lh * Math.cos(S2.a * D), top.z - sd * Lh * Math.sin(S2.a * D)); }
      // doors: a leg door on the strut (the jets' mains), the bay doors over the stowed wheels (they open for the
      // transit), the nose gear's doors (the forward pair closes behind the wheels, the aft pair stays open with the leg)
      let doors = [];
      if (!fixed && jet && !nose && !bodyGear) {
        parts.bind(legB); parts.pal = pal('belly');
        const zO = sd * (rc + 0.04);
        parts.box(top.x, lerp(top.y, cylBot, 0.5), top.z + zO, Math.max(0.5, r * 1.5), (top.y - cylBot) * 0.9, 0.035);
      }
      if (hasDoors && stowed) doors = bellyDoors(ctx, stowed, r, bogie ? r * 1.125 * ((style && style.body6 && Math.abs(L.y) < 3) ? 2 : 1) : 0, sd);
      if (hasDoors && (nose || bodyGear)) doors = keelDoors(ctx, wc, r, nW, keelY, Ls, ang > 0 ? 1 : -1, nose ? 0 : L.y);
      parts.pal = null; parts.bind(0);
      out.push({ i, legB, pisB, linkUp, linkLo, axles, nose, fixed, axis, ang, r, doors, hide: hasDoors, shorten, steer: nose ? (L.steer || 0) : 0, Ls, apex0, cylBot, wc: wc.clone() });
    });
    // animation: retraction (doors open, leg moves, doors close), compression, torque links, steering, wheel spin
    const legs2 = out.filter(g => g.legB !== undefined);
    const bog = out.filter(g => g.bogie);
    env.gear = legs2;
    env.anim.push((ac, dt, st) => {
      const gp = ac.gearPos, legT = 1 - sstep(0.12, 0.88, gp), doorT = sstep(0, 0.12, gp) * (1 - sstep(0.88, 1, gp));
      st.doorT = Math.max(doorT, 0);
      const vgs = ac.out.gs || 0;
      for (const g of legs2) {
        const L = ac.legs[g.i], comp = L ? L.comp || 0 : 0, lb = rig.bone(g.legB), pb = rig.bone(g.pisB);
        lb.quaternion.setFromAxisAngle(g.axis, g.fixed ? 0 : g.ang * legT);
        lb.scale.setScalar(g.hide && gp < 0.004 ? 0.001 : 1);                      // (stowed behind closed doors)
        pb.position.copy(pb.userData.rest); pb.position.y += comp + g.shorten * sstep(0.1, 0.5, legT);
        if (g.nose) pb.quaternion.setFromAxisAngle(Y1, -(ac.ctl.steer || 0) * g.steer * (gp > 0.9 ? 1 : 0));
        // torque links: keep the apex joint as the piston rises (upper link pivots down, lower up)
        const a2 = Math.atan2(comp * 0.5, Math.max(0.05, g.apex0.x - g.wc.x));
        rig.bone(g.linkUp).quaternion.setFromAxisAngle(Z1, -a2 * 1.2); rig.bone(g.linkLo).quaternion.setFromAxisAngle(Z1, a2 * 1.2);
        const spin = L && L.contact ? vgs / g.r : 0;
        for (const A of g.axles) { const b = rig.bone(A.bone); A.ang = ((A.ang || 0) - spin * dt) % (Math.PI * 2); if (!(L && L.contact)) A.ang *= 0.995; b.quaternion.setFromAxisAngle(Z1, A.ang); }
        for (const d of g.doors) { const b = rig.bone(d.bone); b.quaternion.setFromAxisAngle(d.axis, d.ang * (d.open === 'down' ? sstep(0, 0.1, gp) : doorT)); }
      }
      for (const g of bog) {        // bogies: level on the ground, toe-up when unloaded
        const L = ac.legs[g.i], b = rig.bone(g.beamB); const tilt = L && L.contact ? 0 : 9 * D;
        g.tilt = (g.tilt || 0) + clamp(tilt - (g.tilt || 0), -dt * 0.3, dt * 0.3); b.quaternion.setFromAxisAngle(Z1, g.tilt);
      }
    });
  }
  // a tyre (rounded, with grooves), the hub, the brake; its axis along z; o = +1 / -1: the outboard face
  function wheel(mb, pal, c, r, w, seg, o) {
    const hw = w / 2, prof = [];
    const n = 10; for (let k = 0; k <= n; k++) { const a = -Math.PI / 2 + Math.PI * k / n, rr = r * (0.8 + 0.2 * Math.cos(a) * 0.9 + 0.02), z = hw * Math.sin(a); prof.push([z, rr]); }
    // tyre: profile in (z, r) about the z axis: lathe about x, rotated so x -> z
    const q = new Q4().setFromUnitVectors(X1, Z1);
    mb.pal = pal('rubber'); mb.at(mat4(c, q), () => {
      mb.lathe([[-hw * 0.98, r * 0.62], [-hw, r * 0.72], ...prof.slice(1, -1).map(([z, rr]) => [z, rr]), [hw, r * 0.72], [hw * 0.98, r * 0.62]].map(([z, rr]) => [-z, rr]), seg, {});
      mb.pal = pal('hub');
      mb.lathe([[hw * 0.97, r * 0.62], [hw * 0.97, r * 0.62], [hw * 0.9, r * 0.5], [hw * 0.9, r * 0.2], [hw * 1.02, r * 0.14], [hw * 1.02, 0.001]].map(([z, rr]) => [z, rr]), Math.max(8, seg >> 1), {});
      mb.lathe([[-hw * 0.97, r * 0.62], [-hw * 0.97, r * 0.62], [-hw * 0.9, r * 0.45], [-hw * 0.9, 0.001]].map(([z, rr]) => [z, rr]), Math.max(8, seg >> 1), { flip: true });
    });
    mb.pal = null;
  }
  // how a sideways-folding main leg stows its wheels in the belly: the trunnion's height inside the wing (0-0.45 m
  // above its lower surface), the fold angle (60-115 degrees) and the strut shortening (0-0.4 m) that put the wheels
  // inside the fuselage and its belly fairing, as low and as far inboard as they go; cached per type and leg
  const stowCache = new Map();
  function stowSide(H, key, top, wc, r, ext, half, sd, keelY) {
    if (stowCache.has(key)) return stowCache.get(key);
    let best = null;
    for (let lift = 0; lift <= 0.4501; lift += 0.15) for (let sh = 0; sh <= 0.4001; sh += 0.2) for (let a = 60; a <= 115.01; a += 5) {
      const th = a * D, L = top.y + lift - wc.y - sh, cy = top.y + lift - L * Math.cos(th), cz = top.z - sd * L * Math.sin(th);
      // the stowed wheels: a disc of radius r tilted by (90 - a) degrees, 'ext' thick along the axle
      const tilt = (90 - a) * D, ca = Math.cos(tilt), sa = Math.sin(tilt);
      let bad = sd * cz - r * 0.5 < 0.06 ? 20 : 0;            // (not across the centre line)
      for (const dx of [-half - r * 0.9, -half, 0, half, half + r * 0.9]) for (const dz of [-r * 0.9, 0, r * 0.9]) for (const dy of [-ext, ext]) {
        // a point on the tyre: across the disc (dz) and along the axle (dy), in the tilted frame
        const x = wc.x + dx, s = H.nose - x, py = cy + dy * ca, pz = cz + dz * ca + sd * dy * sa;
        if (s < 0 || s > H.L) { bad++; continue; }
        if (!H.inside(s, py - Math.abs(dz) * sa, pz)) bad++;
      }
      const score = bad + sh * 1.5 + lift * 1.2 + Math.max(0, cy - keelY) * 0.35 + Math.abs(cz) * 0.15;
      if (!best || score < best.score) best = { a, sh, lift, score };
    }
    stowCache.set(key, best); return best;
  }
  // a door as a patch of the fuselage skin (s, th), on its own bone at the hinge line, opening by ang about axis
  function hullDoor(ctx, poly, hinge, side, axis, ang, open) {
    const { rig, pal, H, B } = ctx, parts = B.mb('parts'), hp = hinge.clone(); if (side < 0) hp.z = -hp.z;
    const b = rig.add(0, hp.x, hp.y, hp.z);
    parts.bind(b); parts.pal = pal('belly'); parts.mirror = side < 0;
    ACFrame.paint(H, parts, [{ poly: ACGeo.ccw(poly) }], 0.012, 0.25);
    parts.mirror = false; parts.pal = null; parts.bind(0);
    return { bone: b, axis, ang, open };
  }
  // the main gear bay door under a stowed wheel set: hinged at its inboard edge, the outboard edge swinging down
  function bellyDoors(ctx, c, r, half, sd) {
    const H = ctx.H, s0 = H.nose - (c.x + half + r * 1.08), s1 = H.nose - (c.x - half - r * 1.08), sm = (s0 + s1) / 2;
    const thC = H.polar(sm, c.y - r * 0.6, Math.abs(c.z)).th, rad = Math.max(0.5, H.sec(sm).a), dth = (r * 1.1) / rad;
    const thIn = Math.min(Math.PI - 0.01, thC + dth), thOut = thC - dth;
    const hinge = new V3(); H.pt(sm, thIn, hinge);
    return [hullDoor(ctx, [[s0, thOut], [s1, thOut], [s1, thIn], [s0, thIn]], hinge, sd, X1.clone(), sd * 82 * D, 'transit')];
  }
  // doors along the keel for the nose gear and the body gear: the bay runs from the leg forward (or aft) over the
  // stowed wheels; hinged at the outer edges; the part over the wheels closes when the gear is down, the part at the
  // leg stays open
  function keelDoors(ctx, wc, r, nW, keelY, Ls, dir, y0) {
    const { H } = ctx, m = ctx.type.model, sW = m.nose - wc.x, sLeg = sW + dir * r * 0.5, sFar = sW - dir * (Ls + r * 1.15), sMid = sW - dir * r * 0.9;
    const doors = [], zc = Math.abs(y0), wid = r * (nW > 1 ? 2.3 : 1.4) + 0.1;
    for (const sd of zc ? [Math.sign(y0)] : [1, -1]) for (const [sa, sb, open] of [[sFar, sMid, 'transit'], [sMid, sLeg, 'down']]) {
      const s0 = Math.min(sa, sb), s1 = Math.max(sa, sb), rad = Math.max(0.5, H.sec((s0 + s1) / 2).a);
      if (zc) {   // a body gear bay: one door beside the keel, hinged outboard
        const thC = H.polar((s0 + s1) / 2, keelY + 0.05, zc).th, dth = wid / 2 / rad, thIn = Math.min(Math.PI - 0.005, thC + dth), thOut = thC - dth;
        const hinge = new V3(); H.pt((s0 + s1) / 2, thOut, hinge);
        doors.push(hullDoor(ctx, [[s0, thOut], [s1, thOut], [s1, thIn], [s0, thIn]], hinge, sd, new V3(-1, 0, 0), sd * 88 * D, open));
      } else {    // the nose bay: a pair of doors meeting on the keel, hinged at their outer edges
        const th0 = Math.PI - 0.004, th1 = Math.PI - Math.min(0.6, (wid / 2 + 0.05) / rad), hinge = new V3(); H.pt((s0 + s1) / 2, th1, hinge);
        doors.push(hullDoor(ctx, [[s0, th1], [s1, th1], [s1, th0], [s0, th0]], hinge, sd, new V3(-1, 0, 0), sd * 85 * D, open));
      }
    }
    return doors;
  }

  // ---------------------------------------------------------------- lights
  let glowTex = null;
  function glowTexture() {
    if (glowTex) return glowTex;
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.1, 'rgba(255,255,255,.9)'); gr.addColorStop(0.3, 'rgba(255,255,255,.2)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); glowTex = new THREE.CanvasTexture(c); glowTex.userData.shared = true; return glowTex;
  }
  function lamp(color, size) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    s.scale.setScalar(size); s.userData.base = size; s.visible = false; return s;
  }
  function lights(type, ctx, env) {
    const m = type.model, f = type.fdm, { B, rig, pal, H } = ctx, parts = B.mb('parts'), jet = m.kind === 'jet', L = env.lamps;
    const wings = env.wings, w = m.wing;
    const dome = (p, n, r, sw, bone) => { parts.bind(bone || 0); parts.pal = pal(sw); parts.at(mat4(p, new Q4().setFromUnitVectors(X1, n)), () => parts.lathe([[r * 0.7, 0.001], [r * 0.55, r * 0.6], [0, r]], 8)); parts.pal = null; parts.bind(0); };
    const tips = {};
    for (const ws of wings) {
      const P2 = ws.P(ws.span, 0.5, new V3()); P2.z *= ws.side; P2.x -= 0.1; P2.z += ws.side * 0.06;
      tips[ws.side] = { p: P2, bone: ws.flex ? ws.flex.bones[ws.flex.bones.length - 1] : 0 };
      dome(P2, new V3(0.3, 0, ws.side).normalize(), jet ? 0.09 : 0.05, ws.side > 0 ? 'lensGreen' : 'lensRed', tips[ws.side].bone);
    }
    const tipOf = (side) => tips[side] || (m.htail ? { p: P(m.htail.x - m.htail.c0 * 0.5, side * (m.htail.span + 0.05), m.htail.z), bone: 0 } : { p: new V3(0, 0, side), bone: 0 });
    const lz = w ? 1 : 0.5;
    const put = (k, lp, bone) => { L[k].position.copy(lp); L[k].userData.rest = lp.clone(); L[k].userData.bone = bone || 0; };
    L.navL = lamp(0xff2a1a, 0.9 * lz); put('navL', tipOf(-1).p, tipOf(-1).bone);
    L.navR = lamp(0x22ff66, 0.9 * lz); put('navR', tipOf(1).p, tipOf(1).bone);
    L.strobeL = lamp(0xffffff, 3.2); put('strobeL', tipOf(-1).p.clone().add(new V3(-0.25, 0, 0)), tipOf(-1).bone);
    L.strobeR = lamp(0xffffff, 3.2); put('strobeR', tipOf(1).p.clone().add(new V3(-0.25, 0, 0)), tipOf(1).bone);
    const tailP = jet ? new V3(m.nose - m.L - 0.12, H.sec(m.L).yc + 0.1, 0) : P(m.vtail.x - m.vtail.c0 - 0.05, 0, m.vtail.z - 0.05);
    L.tail = lamp(0xffffff, 0.8); put('tail', tailP); dome(tailP.clone().add(new V3(0.05, 0, 0)), new V3(-1, 0, 0), 0.05, 'lensClear');
    const sB = m.L * 0.47, sc = H.sec(sB), topP = new V3(m.nose - sB, sc.yc + sc.up + (sc.lobe || 0) + 0.03, 0), botP = new V3(m.nose - sB - 1.5, H.sec(sB + 1.5).yc - H.sec(sB + 1.5).dn - (H.sec(sB + 1.5).fk || 0) - 0.03, 0);
    L.beaconT = lamp(0xff1a0a, 1.6 * lz); put('beaconT', topP.clone().add(new V3(0, 0.08, 0))); dome(topP, Y1, 0.09, 'lensRed');
    L.beaconB = lamp(0xff1a0a, 1.6 * lz); put('beaconB', botP.clone().add(new V3(0, -0.08, 0))); dome(botP, new V3(0, -1, 0), 0.09, 'lensRed');
    // landing lights: jets in the wing roots (lower surface), GA in the wing leading edge, the helicopter under the nose
    let landP = [];
    if (w && wings.length) for (const ws of wings) { const y = jet ? Math.max(ws.y0 + 1.4, ws.span * 0.12) : ws.span * 0.45, p = ws.P(y, jet ? 0.53 : 0.5, new V3()); p.z *= ws.side; p.y -= 0.04; landP.push({ p, side: ws.side, bone: jet ? 0 : ws.flex ? ws.flex.bones[1] : 0 }); }
    else landP = [{ p: new V3(m.nose - 0.9, H.keel + 0.1, 0.3), side: 1 }, { p: new V3(m.nose - 0.9, H.keel + 0.1, -0.3), side: -1 }];
    const landSz = m.kind === 'ga' ? 1.1 : !w ? 1.0 : 2.4;
    for (const lp of landP) { const k = lp.side > 0 ? 'landR' : 'landL'; L[k] = lamp(0xfff4e0, landSz); put(k, lp.p, lp.bone); dome(lp.p, new V3(1, -0.2, 0).normalize(), jet ? 0.14 : 0.06, 'lensClear', lp.bone); }
    // taxi light on the nose gear leg (it moves with the leg)
    const ng = (env.gear || []).find(g => g.nose && !g.fixed);
    if (ng) { const tp = new V3(ng.wc.x + 0.12, ng.cylBot + 0.1, 0); L.taxi = lamp(0xfff1dc, 1.2); put('taxi', tp, ng.legB); dome(tp, X1, 0.07, 'lensClear', ng.legB); }
    // logo lights on the stabiliser, looking at the fin (their glow; the fin itself lights up in 48_acmodel)
    if (jet && m.htail) for (const sd of [1, -1]) { const lp = P(m.htail.x - m.htail.c0 * 0.35, sd * (m.htail.span * 0.55), m.htail.z - 0.12); const k = sd > 0 ? 'logoR' : 'logoL'; L[k] = lamp(0xfff4e8, 0.6); put(k, lp); }
    for (const k in L) L[k].visible = false;
    const spot = new THREE.SpotLight(0xfff1dc, 0, m.kind === 'ga' ? 420 : 900, 13 * D, 0.55, 1.4); spot.castShadow = false;
    spot.position.copy(P(m.nose - 3, 0, (jet ? m.fus.zc + 1 : 0.8))); spot.target.position.copy(P(m.nose + 200, 0, 40)); env.spot = spot;
    let beaconT = 0, strobeT = 0;
    const tmp = new V3();
    env.anim.push((ac, dt, st) => {
      beaconT += dt; strobeT += dt; const night = st.night;
      for (const k in L) { const l = L[k]; if (l.userData.bone) rig.apply(l.userData.bone, l.userData.rest, tmp) && l.position.copy(tmp); }
      const eng1 = ac.eng.some(e => e.n > 0.25), airborne = !ac.out.onGround;
      const lit = (o, on, k = 1) => { if (!o) return; o.visible = on; if (on) o.scale.setScalar(o.userData.base * k * (0.55 + 0.45 * night)); };
      lit(L.navL, true); lit(L.navR, true); lit(L.tail, true);
      const bOn = eng1 && (beaconT % 1.1) < 0.12; lit(L.beaconT, bOn); lit(L.beaconB, bOn && (beaconT % 1.1) < 0.1);
      const ph = strobeT % 1.25, sOn = (airborne || ac.out.gs > 20) && (ph < 0.05 || (jet && ph > 0.14 && ph < 0.19));
      lit(L.strobeL, sOn && !!w); lit(L.strobeR, sOn && !!w);
      const landOn = (ac.gearPos > 0.5 && ac.pos.y - ac.out.gnd < 3000) || (ac.out.gs > 25 && !airborne);
      // (from the cockpit the landing and taxi lights are not seen themselves, only what they light)
      lit(L.landL, landOn && !st.inside, 0.6 + night); lit(L.landR, landOn && !st.inside, 0.6 + night);
      lit(L.taxi, ac.gearPos > 0.95 && (ac.out.gs > 1 || landOn) && eng1 && !st.inside, 0.5 + night);
      lit(L.logoL, night > 0.3 && eng1, 1); lit(L.logoR, night > 0.3 && eng1, 1);
      spot.intensity = landOn ? 30000 * night * (m.kind === 'ga' ? 0.25 : 1) : 0;
    });
  }

  // ---------------------------------------------------------------- small parts (high quality and up)
  // pitot probes beside the nose, blade antennas on the crown and the belly, static wicks on the trailing edges of the
  // ailerons, elevators and rudder (on their bones, so they move with them)
  function smallParts(type, ctx, env) {
    const m = type.model, { B, pal, H, q } = ctx, parts = B.mb('parts'), jet = m.kind === 'jet';
    if (q < 2 || ctx.lite) return;
    const scale = clamp((m.fus.d || m.fus.w || 2) / 4, 0.3, 1.8), p = new V3(), a = new V3(), b = new V3();
    const normalAt = (s2, th, out) => { H.pt(s2 + 1e-3, th, a); H.pt(s2 - 1e-3, th, b); const ds = a.clone().sub(b); H.pt(s2, th + 1e-3, a); H.pt(s2, th - 1e-3, b); return out.crossVectors(ds, a.sub(b)).normalize(); };
    parts.bind(0);
    // pitot probes: an L of thin tube standing off the nose's side, pointing forward
    if (jet && H.noseSpec) {
      const sP = (m.fus.noseLen || 4) * 0.42, n = new V3();
      for (const sd of [1, -1]) for (const th of [1.75, 1.95]) {
        H.pt(sP + (th - 1.75) * 0.6, th, p); normalAt(sP, th, n); if (sd < 0) { p.z = -p.z; n.z = -n.z; }
        const tip = p.clone().addScaledVector(n, 0.13 * scale);
        parts.pal = pal('aluDull'); parts.cyl(p, tip, 0.012 * scale, 0.009 * scale, 6, false);
        parts.pal = pal('alu'); parts.cyl(tip.clone().add(new V3(-0.02, 0, 0)), tip.clone().add(new V3(0.16 * scale, 0, 0)), 0.01 * scale, 0.007 * scale, 6, true);
      }
    }
    // blade antennas: swept fins normal to the skin
    const blade = (s2, th, h, len) => {
      const n = new V3(); H.pt(s2, th, p); normalAt(s2, th, n);
      const aft = new V3(-1, 0, 0), side = new V3().crossVectors(n, aft).normalize(), t = 0.012 * scale;
      const pts = [p.clone().addScaledVector(aft, -len * 0.5), p.clone().addScaledVector(aft, len * 0.5), p.clone().addScaledVector(n, h).addScaledVector(aft, len * 0.75), p.clone().addScaledVector(n, h).addScaledVector(aft, len * 0.35)];
      parts.pal = pal('antenna');
      for (const sgn of [1, -1]) { const nn = side.clone().multiplyScalar(sgn); const ids = pts.map(v => { const w = v.clone().addScaledVector(nn, t); return parts.v(w.x, w.y, w.z, nn.x, nn.y, nn.z); }); if (sgn > 0) { parts.tri(ids[0], ids[1], ids[2]); parts.tri(ids[0], ids[2], ids[3]); } else { parts.tri(ids[0], ids[2], ids[1]); parts.tri(ids[0], ids[3], ids[2]); } }
    };
    if (jet) { blade(m.L * 0.3, 0.001, 0.26 * scale, 0.3 * scale); blade(m.L * 0.55, 0.001, 0.2 * scale, 0.26 * scale); blade(m.L * 0.42, Math.PI - 0.001, 0.22 * scale, 0.28 * scale); }
    else if (m.kind === 'ga') { blade(m.L * 0.45, 0.001, 0.22, 0.14); blade(m.L * 0.62, Math.PI - 0.001, 0.12, 0.1); }
    // static wicks: thin rods off the trailing edges of the ailerons, elevators and rudder, near their outer ends
    const wicks = (surf, kinds, n) => {
      for (const pn of surf.panels) {
        if (!kinds.includes(pn.kind)) continue;
        parts.bind(pn.bone); parts.pal = pal('black'); parts.mirror = surf.side < 0;
        for (let k = 0; k < n; k++) {
          const y = pn.y1 - (pn.y1 - pn.y0) * (0.06 + 0.22 * k), te = surf.P(y, 0, new V3());
          parts.cyl(te.clone().add(new V3(0.02, 0, 0)), te.clone().add(new V3(-0.16 * Math.sqrt(scale), 0, 0)), 0.006, 0.004, 5, true);
        }
        parts.mirror = false; parts.bind(0);
      }
    };
    if (jet || m.kind === 'fighter') { for (const ws of env.wings) wicks(ws, ['ail', 'elevon'], 3); for (const hs of env.htails) wicks(hs, ['elev'], 2); if (env.fin) wicks(env.fin, ['rud'], 3); }
    parts.pal = null;
  }

  // ---------------------------------------------------------------- everything for one aircraft
  function* steps(type, ctx, env) {
    const m = type.model;
    for (let i = 0; i < m.engines.length; i++) { const e = m.engines[i]; if (e.type === 'fan') turbofan(e, i, ctx, env); else if (e.type === 'prop') prop(e, i, ctx, env); else if (e.type === 'jet') jet(e, i, ctx, env); yield; }
    if (m.rotor) { rotors(m, ctx, env); yield; }
    if (!ctx.far) { gear(type, ctx, env); yield; }
    if (!ctx.lite) { lights(type, ctx, env); smallParts(type, ctx, env); }
  }
  function build(type, ctx, env) { const g = steps(type, ctx, env); while (!g.next().done); }
  return { build, steps, turbofan, prop, jet, rotors, gear, lights, wheel, lamp, flexBone };
})();
