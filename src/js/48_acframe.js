// ACFrame: the airframe of the procedural aircraft: fuselage shapes, cockpit window panes, wings and tails with their
// moving surfaces, wingtip devices, flap-track fairings. Built with ACGeo into the batches of 48_acmodel.js.
//   const H = ACFrame.hull(type, q)       the fuselage as a function: H.sec(s), H.pt(s, th, out), H.hit(o, dir),
//                                         H.thAt(s, y) (section angle at a height), H.panes (cockpit windows)
//   ACFrame.buildHull(H, B, rig, ctx)     skin, cockpit glass and frames, APU exhaust into the batches
//   ACFrame.wing(spec, ctx)               both wings (or tails): skin, panels as bones, tips, fairings
// s = distance aft of the nose tip (m); th = section angle: 0 crown, pi/2 right side, pi keel, 3pi/2 left side.
// Model axes: x forward, y up, z right, origin = CG. Other modules are referenced at call time only.
const ACFrame = (() => {
  const V3 = THREE.Vector3, D = Math.PI / 180;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const sgnpow = (v, p) => (v < 0 ? -Math.pow(-v, p) : Math.pow(v, p));

  // ---------------------------------------------------------------- nose and tail shapes
  // Normalised profiles along the nose (t = s / noseLen): top and bottom lines from the tip height to the crown
  // and keel, half-width, the height of the widest line (0 keel .. 1 crown) and the upper superellipse exponent.
  // 'tip' is the nose tip's height as a fraction of the fuselage height. Tails (u = 0 .. 1 over tailLen): the top
  // line falls to 'top', the keel rises to 'bot', the half-width shrinks to 'w' (fractions of height / half-width).
  // Windscreen panes: corners as the captain sees them (azimuth deg, + outboard; elevation deg); 'post' = the
  // centre post's half-width (m); the first pane is the front one (its inboard edge follows the post).
  const NOSES = {
    airbus: { tip: 0.36, top: [[0, 0], [0.05, 0.19], [0.12, 0.31], [0.22, 0.44], [0.34, 0.57], [0.47, 0.72], [0.6, 0.85], [0.75, 0.95], [0.88, 0.99], [1, 1]],
      bot: [[0, 0], [0.05, 0.27], [0.12, 0.45], [0.25, 0.67], [0.42, 0.85], [0.6, 0.95], [0.8, 0.995], [1, 1]],
      wid: [[0, 0], [0.04, 0.3], [0.1, 0.47], [0.2, 0.64], [0.34, 0.8], [0.5, 0.91], [0.68, 0.975], [0.85, 0.997], [1, 1]],
      wy: [[0, 0.45], [0.3, 0.46], [0.7, 0.49], [1, 0.5]], eu: [[0, 2], [0.35, 2.15], [0.6, 2.2], [0.85, 2.05], [1, 2]],
      panes: [[[-27, -19], [30, -16], [32, 11], [-27, 13]], [[37, -15], [79, -12], [79, 11], [40, 12]], [[85, -11], [113, -9], [110, 8], [87, 10]]], post: 0.045 },
    b737: { tip: 0.4, top: [[0, 0], [0.06, 0.18], [0.14, 0.3], [0.26, 0.43], [0.38, 0.56], [0.5, 0.71], [0.62, 0.85], [0.76, 0.95], [0.9, 0.995], [1, 1]],
      bot: [[0, 0], [0.06, 0.25], [0.15, 0.44], [0.3, 0.68], [0.48, 0.86], [0.66, 0.96], [0.85, 0.997], [1, 1]],
      wid: [[0, 0], [0.05, 0.26], [0.12, 0.42], [0.24, 0.6], [0.38, 0.77], [0.55, 0.9], [0.72, 0.97], [0.88, 0.997], [1, 1]],
      wy: [[0, 0.46], [0.5, 0.48], [1, 0.5]], eu: [[0, 2], [0.4, 2.25], [0.62, 2.3], [0.85, 2.08], [1, 2]],
      panes: [[[-27, -19], [26, -17], [28, 12], [-27, 14]], [[32, -16], [66, -14], [67, 12], [34, 13]], [[72, -13], [106, -11], [103, 9], [74, 12]]], post: 0.04 },
    b787: { tip: 0.39, top: [[0, 0], [0.06, 0.21], [0.15, 0.36], [0.28, 0.52], [0.42, 0.68], [0.56, 0.82], [0.7, 0.92], [0.85, 0.985], [1, 1]],
      bot: [[0, 0], [0.06, 0.28], [0.15, 0.47], [0.3, 0.7], [0.48, 0.87], [0.68, 0.965], [0.86, 0.997], [1, 1]],
      wid: [[0, 0], [0.05, 0.32], [0.12, 0.5], [0.24, 0.68], [0.4, 0.84], [0.58, 0.94], [0.78, 0.99], [1, 1]],
      wy: [[0, 0.46], [0.5, 0.48], [1, 0.5]], eu: [[0, 2], [0.4, 2.1], [0.7, 2.08], [1, 2]],
      panes: [[[-27, -19], [38, -15], [41, 12], [-27, 14]], [[46, -14], [96, -11], [92, 10], [48, 12]]], post: 0.05 },
    b747: { tip: 0.3, top: [[0, 0], [0.06, 0.15], [0.15, 0.27], [0.28, 0.42], [0.42, 0.58], [0.56, 0.74], [0.7, 0.87], [0.85, 0.96], [1, 1]],
      bot: [[0, 0], [0.05, 0.3], [0.13, 0.5], [0.26, 0.72], [0.44, 0.88], [0.62, 0.965], [0.82, 0.997], [1, 1]],
      wid: [[0, 0], [0.05, 0.33], [0.12, 0.52], [0.25, 0.72], [0.42, 0.87], [0.6, 0.95], [0.8, 0.99], [1, 1]],
      wy: [[0, 0.42], [0.5, 0.46], [1, 0.5]], eu: [[0, 2], [1, 2]],
      panes: [[[-27, -19], [27, -17], [29, 12], [-27, 14]], [[33, -16], [67, -14], [67, 12], [35, 13]], [[73, -13], [104, -11], [101, 9], [75, 12]]], post: 0.045 },
    a380: { tip: 0.33, top: [[0, 0], [0.05, 0.2], [0.13, 0.34], [0.24, 0.47], [0.36, 0.6], [0.5, 0.74], [0.64, 0.86], [0.8, 0.96], [1, 1]],
      bot: [[0, 0], [0.05, 0.3], [0.12, 0.48], [0.25, 0.7], [0.42, 0.87], [0.6, 0.96], [0.8, 0.997], [1, 1]],
      wid: [[0, 0], [0.04, 0.33], [0.1, 0.52], [0.22, 0.71], [0.38, 0.86], [0.56, 0.95], [0.76, 0.99], [1, 1]],
      wy: [[0, 0.44], [0.5, 0.47], [1, 0.5]], eu: [[0, 2], [0.4, 2.12], [0.7, 2.1], [1, 2]],
      panes: [[[-27, -19], [30, -16], [32, 11], [-27, 13]], [[37, -15], [79, -12], [79, 11], [40, 12]], [[85, -11], [113, -9], [110, 8], [87, 10]]], post: 0.05 },
    concorde: { tip: 0.47, top: [[0, 0], [0.1, 0.18], [0.25, 0.37], [0.4, 0.53], [0.55, 0.68], [0.7, 0.83], [0.85, 0.95], [1, 1]],
      bot: [[0, 0], [0.1, 0.2], [0.25, 0.42], [0.45, 0.68], [0.65, 0.87], [0.85, 0.98], [1, 1]],
      wid: [[0, 0], [0.1, 0.2], [0.25, 0.42], [0.45, 0.66], [0.65, 0.85], [0.85, 0.97], [1, 1]],
      wy: [[0, 0.5], [1, 0.5]], eu: [[0, 2], [1, 2]],
      panes: [[[-22, -15], [18, -13], [19, 5], [-22, 7]], [[24, -12], [62, -10], [60, 7], [25, 8]]], post: 0.035 },
    bizprop: { tip: 0.42, top: [[0, 0], [0.08, 0.16], [0.2, 0.3], [0.35, 0.46], [0.5, 0.64], [0.64, 0.82], [0.8, 0.95], [1, 1]],
      bot: [[0, 0], [0.08, 0.25], [0.2, 0.45], [0.38, 0.7], [0.58, 0.88], [0.8, 0.98], [1, 1]],
      wid: [[0, 0], [0.08, 0.28], [0.2, 0.47], [0.36, 0.67], [0.55, 0.85], [0.75, 0.96], [1, 1]],
      wy: [[0, 0.46], [1, 0.5]], eu: [[0, 2], [0.5, 2.15], [1, 2]],
      panes: [[[-30, -21], [37, -17], [39, 14], [-30, 17]], [[43, -17], [88, -14], [86, 15], [45, 16]]], post: 0.03 },
    dc3: { tip: 0.43, top: [[0, 0], [0.06, 0.24], [0.15, 0.41], [0.28, 0.57], [0.42, 0.72], [0.56, 0.85], [0.72, 0.95], [0.86, 0.99], [1, 1]],
      bot: [[0, 0], [0.06, 0.32], [0.15, 0.52], [0.3, 0.74], [0.48, 0.9], [0.68, 0.975], [1, 1]],
      wid: [[0, 0], [0.05, 0.38], [0.13, 0.58], [0.26, 0.76], [0.42, 0.89], [0.62, 0.97], [0.82, 0.997], [1, 1]],
      wy: [[0, 0.48], [1, 0.5]], eu: [[0, 2], [0.5, 2.1], [1, 2]],
      panes: [[[-30, -15], [26, -13], [27, 11], [-30, 13]], [[31, -14], [66, -12], [66, 12], [33, 12]], [[70, -12], [98, -10], [96, 10], [72, 11]]], post: 0.04 },
  };
  const TAILS = {
    airbus: { top: [[0, 1], [0.4, 0.985], [0.75, 0.93], [1, 0.84]], bot: [[0, 0], [0.15, 0.06], [0.45, 0.33], [0.75, 0.6], [1, 0.73]], wid: [[0, 1], [0.3, 0.9], [0.6, 0.62], [0.85, 0.34], [1, 0.1]] },
    b737: { top: [[0, 1], [0.4, 0.985], [0.75, 0.94], [1, 0.87]], bot: [[0, 0], [0.15, 0.05], [0.45, 0.33], [0.75, 0.62], [1, 0.74]], wid: [[0, 1], [0.3, 0.9], [0.6, 0.62], [0.85, 0.33], [1, 0.07]] },
    b787: { top: [[0, 1], [0.4, 0.98], [0.75, 0.92], [1, 0.83]], bot: [[0, 0], [0.15, 0.05], [0.45, 0.31], [0.75, 0.58], [1, 0.7]], wid: [[0, 1], [0.3, 0.9], [0.6, 0.63], [0.85, 0.35], [1, 0.1]] },
    b747: { top: [[0, 1], [0.4, 0.98], [0.75, 0.9], [1, 0.8]], bot: [[0, 0], [0.15, 0.05], [0.45, 0.3], [0.75, 0.56], [1, 0.68]], wid: [[0, 1], [0.3, 0.9], [0.6, 0.63], [0.85, 0.35], [1, 0.09]] },
    a380: { top: [[0, 1], [0.4, 0.975], [0.75, 0.89], [1, 0.78]], bot: [[0, 0], [0.15, 0.05], [0.45, 0.3], [0.75, 0.55], [1, 0.66]], wid: [[0, 1], [0.3, 0.9], [0.6, 0.63], [0.85, 0.35], [1, 0.09]] },
    concorde: { top: [[0, 1], [0.5, 0.95], [1, 0.62]], bot: [[0, 0], [0.4, 0.12], [0.8, 0.4], [1, 0.5]], wid: [[0, 1], [0.4, 0.8], [0.8, 0.35], [1, 0.05]] },
    bizprop: { top: [[0, 1], [0.4, 0.97], [0.8, 0.86], [1, 0.8]], bot: [[0, 0], [0.2, 0.1], [0.5, 0.38], [0.8, 0.62], [1, 0.7]], wid: [[0, 1], [0.35, 0.85], [0.7, 0.5], [1, 0.12]] },
    dc3: { top: [[0, 1], [0.4, 0.96], [0.8, 0.8], [1, 0.72]], bot: [[0, 0], [0.2, 0.1], [0.5, 0.35], [0.8, 0.56], [1, 0.62]], wid: [[0, 1], [0.35, 0.82], [0.7, 0.45], [1, 0.06]] },
  };
  const STYLE_BY_ID = { a320: 'airbus', a388: 'a380', b738: 'b737', b789: 'b787', b744: 'b747', conc: 'concorde', b350: 'bizprop', dc3: 'dc3' };
  // light aircraft and the helicopter: windscreen (the first pane: its inboard edge on the centre line), door
  // windows, rear windows; the helicopter's chin windows. Same convention as the jets' panes.
  const LIGHT_PANES = {
    ga: { panes: [[[-45, -9], [52, -13], [55, 30], [-45, 33]], [[62, -34], [118, -30], [116, 26], [64, 29]], [[124, -24], [156, -20], [154, 17], [126, 20]]], post: 0.012 },
    heli: { panes: [[[-38, -44], [58, -38], [66, 44], [-38, 52]], [[74, -52], [116, -44], [116, 30], [78, 34]], [[-30, -78], [36, -70], [40, -52], [-30, -56]]], post: 0.03 },
  };
  const splines = new Map(), paneCache = new Map();
  const spl = (pts) => { let f = splines.get(pts); if (!f) { f = ACGeo.mono(pts); splines.set(pts, f); } return f; };

  // ---------------------------------------------------------------- the fuselage as a function
  // sec(s) -> { yc, up, dn, a, eu, ed, lobe, lobeK, fb, fk, th0 }: a superellipse per station: centre height yc,
  // half-heights up / down, half-width a, exponents; the 747's upper-deck lobe; the wing-body fairing bulge fb
  // (outward, peaking at the section angle th0) and keel drop fk.
  function hull(type, q) {
    const m = type.model, F = m.fus, L = m.L, kind = m.kind, nose = m.nose;
    const H = { type, m, L, nose, kind, q };
    const sec = { yc: 0, up: 1, dn: 1, a: 1, eu: 2, ed: 2, lobe: 0, lobeK: 3, fb: 0, fk: 0, th0: 2 };
    let fn;
    if (kind === 'jet') {
      const st = F.style || STYLE_BY_ID[type.id] || 'airbus', N = NOSES[st] || NOSES.airbus, T = TAILS[st] || TAILS.airbus;
      H.style = st; H.noseSpec = N;
      const Rw = F.d / 2, Rh = F.h / 2, yc0 = -F.zc, NL = F.noseLen, TL = F.tailLen, crown = yc0 + Rh, keel = yc0 - Rh;
      const tipY = keel + N.tip * F.h;
      const fTop = spl(N.top), fBot = spl(N.bot), fWid = spl(N.wid), fWy = spl(N.wy), fEu = spl(N.eu);
      const tTop = spl(T.top), tBot = spl(T.bot), tWid = spl(T.wid);
      // the wing-body fairing: along the wing root chord, sized to reach the wing root
      const w = m.wing, fair = w && !w.high ? (() => {
        const xLE = w.x, c0 = w.c0, s0 = nose - xLE - c0 * 0.18, s1 = nose - xLE + c0 * 1.3, yRoot = -w.z;
        const cth = clamp((yRoot - yc0) / Rh, -0.97, 0.97), th0 = Math.acos(cth), have = Rw * Math.sin(th0);
        const need = Math.max(0, (w.y0 || 0) + 0.06 - have);
        return { s0, s1, th0, out: need + Rw * (F.fair || 0.035), keel: Rh * (F.fairKeel !== undefined ? F.fairKeel : 0.05) };
      })() : null;
      H.fair = fair;
      const hump = F.hump;
      fn = (s) => {
        let top = crown, bot = keel, a = Rw, wy = 0.5, eu = 2;
        if (s < NL) {
          const t = Math.max(0, s) / NL;
          top = tipY + (crown - tipY) * fTop(t); bot = tipY - (tipY - keel) * fBot(t); a = Rw * fWid(t); wy = fWy(t); eu = fEu(t);
        } else if (s > L - TL) {
          const u = Math.min(1, (s - (L - TL)) / TL);
          top = keel + F.h * tTop(u); bot = keel + F.h * tBot(u); a = Rw * tWid(u);
        }
        const ym = bot + (top - bot) * wy;
        sec.yc = ym; sec.up = Math.max(1e-4, top - ym); sec.dn = Math.max(1e-4, ym - bot); sec.a = Math.max(1e-4, a); sec.eu = eu; sec.ed = 2;
        sec.lobe = 0; sec.fb = 0; sec.fk = 0;
        if (hump) {    // 747 upper deck: a lobe on the crown from the flight deck back to hump.x1, faired out behind
          const sEnd = nose - hump.x1;
          sec.lobe = hump.h * sstep(NL * 0.12, NL * 0.95, s) * (1 - sstep(sEnd - 1.5, sEnd + 7.5, s)); sec.lobeK = 2.4;
        }
        if (fair && s > fair.s0 - 3 && s < fair.s1 + 5) {
          const k = sstep(fair.s0 - 3, fair.s0 + 1.2, s) * (1 - sstep(fair.s1 - 1.5, fair.s1 + 5, s));
          sec.fb = fair.out * k; sec.fk = fair.keel * k; sec.th0 = fair.th0;
        }
        return sec;
      };
      H.eyeSpec = m.cockpit; H.crown = crown; H.keel = keel; H.yc0 = yc0; H.Rw = Rw; H.Rh = Rh;
    } else if (kind === 'ga') {
      // light aircraft: cowling, windshield, cabin (under a high wing, the roof rises to meet it), tail cone
      const W = F.w / 2, Hh = F.h / 2, yc0 = -F.zc, C = F.cowl || 1.5, WS = F.ws || 0.8, CB = F.cabin || 3.9;
      const w = m.wing, high = w && w.high, wingLo = high ? -w.z - (w.t || 0.15) * w.c0 * 0.42 : 0;
      const roof = high ? Math.max(yc0 + Hh, wingLo + 0.04) : yc0 + Hh * (F.low ? 1.02 : 1.12);
      const tailTop = -F.tailZ + F.tailH / 2, tailBot = -F.tailZ - F.tailH / 2, tailW = F.tailW / 2;
      // a single's cowling starts just behind its propeller (the spinner is the nose); a twin has a rounded nose
      const e0 = m.engines[0], single = e0 && e0.type === 'prop' && !e0.y, spin = single ? e0.spinner / 2 : 0;
      const sF = single ? Math.max(0, m.nose - e0.x - 0.02) : 0, axisY = single ? -e0.z : yc0 - Hh * 0.1, cowlTop = yc0 + Hh * (single ? 0.72 : 0.62);
      H.s0 = sF;
      fn = (s) => {
        let a = W, top = yc0 + Hh, bot = yc0 - Hh, e = 2.7;
        const fl = single ? 0.28 : 0.9;
        if (s < sF) { a = spin * 0.3; top = axisY + spin * 0.3; bot = axisY - spin * 0.3; }
        else if (s < sF + fl) { const t = (s - sF) / fl, k = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))); a = lerp(spin * 0.95, W * 0.93, k); top = lerp(axisY + spin * 0.95, cowlTop, k); bot = lerp(axisY - spin * 0.95, yc0 - Hh * 0.88, k); e = lerp(2.1, 2.6, t); }
        else if (s < C) { const t = (s - sF - fl) / Math.max(0.1, C - sF - fl); a = W * (0.93 + 0.07 * sstep(0, 1, t)); top = lerp(cowlTop, yc0 + Hh * 0.8, t); bot = yc0 - Hh * (0.88 + 0.12 * sstep(0, 1, t)); e = 2.7; }
        else if (s < C + WS) { const t = sstep(0, 1, (s - C) / WS); top = lerp(yc0 + Hh * 0.8, roof, t); }
        else if (s < CB) { top = roof; }
        else { const u = clamp((s - CB) / (L - CB), 0, 1); a = lerp(W, tailW, Math.pow(u, 0.85)); top = lerp(roof, tailTop, sstep(0, 0.62, u) * 0.85 + 0.15 * u); bot = lerp(yc0 - Hh, tailBot, Math.pow(u, 0.72)); e = lerp(2.7, 2.2, u); }
        const ym = (top + bot) / 2;
        sec.yc = ym; sec.up = Math.max(1e-4, top - ym); sec.dn = Math.max(1e-4, ym - bot); sec.a = Math.max(1e-4, a); sec.eu = e; sec.ed = e; sec.lobe = 0; sec.fb = 0; sec.fk = 0;
        return sec;
      };
      H.style = 'ga'; H.crown = roof; H.keel = yc0 - Hh; H.yc0 = yc0; H.Rw = W; H.Rh = Hh; H.ga = { C, WS, CB, roof, single, sF };
    } else if (kind === 'heli') {
      // the H125: a glazed nose bubble, the cabin under a flat roof, the rear fairing sweeping up into the slim tail
      // boom (heights in model y: the skids at -1.4, the rotor hub at +1.8)
      const W = F.w / 2, Hh = F.h / 2, yc0 = -F.zc, T2 = (pts) => ACGeo.mono(pts), Ln = L;
      const hTop = T2([[0, -0.2], [0.25, 0.32], [0.7, 0.72], [1.3, 0.97], [1.9, 1.07], [3.0, 1.1], [3.8, 1.07], [4.6, 0.94], [5.6, 0.7], [6.6, 0.66], [Ln, 0.56]]);
      const hBot = T2([[0, -0.2], [0.25, -0.5], [0.7, -0.72], [1.3, -0.8], [3.2, -0.8], [3.9, -0.7], [4.6, -0.28], [5.6, 0.24], [6.6, 0.27], [Ln, 0.32]]);
      const hA = T2([[0, 0], [0.25, 0.45], [0.7, 0.76], [1.3, 0.9], [1.9, 0.93], [3.4, 0.93], [4.0, 0.84], [4.8, 0.5], [5.6, 0.24], [6.6, 0.2], [Ln, 0.13]]);
      const hEu = T2([[0, 2], [1, 2.1], [3, 2.5], [4.5, 2.2], [6, 2], [Ln, 2]]), hEd = T2([[0, 2], [1, 2.5], [3, 3], [4.5, 2.4], [6, 2], [Ln, 2]]);
      fn = (s) => {
        const top = hTop(s), bot = hBot(s), ym = (top + bot) / 2;
        sec.yc = ym; sec.up = Math.max(1e-4, top - ym); sec.dn = Math.max(1e-4, ym - bot); sec.a = Math.max(1e-4, hA(s)); sec.eu = hEu(s); sec.ed = hEd(s); sec.lobe = 0; sec.fb = 0; sec.fk = 0;
        return sec;
      };
      H.style = 'heli'; H.crown = 1.1; H.keel = -0.8; H.yc0 = yc0; H.Rw = W; H.Rh = Hh;
    } else {
      // fighter (the F-16): the radome, the forebody under the canopy, the centre body blended with the wing and
      // the LEX (both built in wingDetails) over the chin intake's duct, the aft body tapering to the nozzle.
      // Heights in model y (the CG at 0), from the ground up: intake lip ~0.9 m, the shoulders, the canopy on top.
      const T2 = (pts) => ACGeo.mono(pts);
      const fTop = T2([[0, 0.15], [0.8, 0.36], [1.8, 0.47], [2.9, 0.54], [3.6, 0.58], [5, 0.64], [7, 0.64], [11, 0.55], [13, 0.48], [14.35, 0.44]]);
      const fBot = T2([[0, 0.15], [0.8, -0.06], [1.8, -0.15], [2.9, -0.19], [3.3, -0.2], [5, -0.3], [6.4, -0.62], [7.2, -0.74], [11, -0.75], [13, -0.72], [14.35, -0.72]]);
      const fA = T2([[0, 0], [0.8, 0.2], [1.8, 0.31], [2.9, 0.39], [3.6, 0.44], [5, 0.54], [6.5, 0.72], [8.5, 0.84], [10.5, 0.82], [12, 0.7], [13.2, 0.62], [14.35, 0.6]]);
      const fEu = T2([[0, 2], [3, 2], [5, 2.4], [8, 2.9], [11, 2.6], [13, 2.2], [14.35, 2]]), fEd = T2([[0, 2], [3, 2.1], [6, 2.8], [11, 3], [13.5, 2.2], [14.35, 2]]);
      H.s1 = 14.35;
      fn = (s) => {
        const top = fTop(s), bot = fBot(s), ym = (top + bot) / 2;
        sec.yc = ym; sec.up = Math.max(1e-4, top - ym); sec.dn = Math.max(1e-4, ym - bot); sec.a = Math.max(1e-4, fA(s)); sec.eu = fEu(s); sec.ed = fEd(s); sec.lobe = 0; sec.fb = 0; sec.fk = 0;
        return sec;
      };
      H.style = 'fighter'; H.crown = 0.64; H.keel = -0.75; H.yc0 = -0.05; H.Rw = 0.7; H.Rh = 0.7;
    }
    // a small cache of sections: a surface asks for the same station many times (every point of a ring, and the
    // derivatives either side)
    const cache = [], KEYS = ['yc', 'up', 'dn', 'a', 'eu', 'ed', 'lobe', 'lobeK', 'fb', 'fk', 'th0'];
    H.sec = (s) => {
      for (let i = 0; i < cache.length; i++) if (cache[i].s === s) return cache[i].v;
      const v = {}, r = fn(s); for (const k of KEYS) v[k] = r[k];
      cache.unshift({ s, v }); if (cache.length > 6) cache.pop();
      return v;
    };
    const fnc = H.sec;
    // a point on the surface; th in radians (0 crown, pi/2 right, pi keel)
    H.pt = (s, th, out) => {
      const q = fnc(clamp(s, 0, L)), c = Math.cos(th), sn = Math.sin(th), upper = c >= 0, pe = 2 / (upper ? q.eu : q.ed);
      let y = q.yc + (upper ? q.up : q.dn) * (pe === 1 ? c : sgnpow(c, pe)), z = q.a * (pe === 1 ? sn : sgnpow(sn, pe));
      if (q.lobe && upper) y += q.lobe * Math.pow(c, q.lobeK);
      if (q.fb) { const ang = Math.acos(clamp(c, -1, 1)), k = Math.exp(-Math.pow((ang - q.th0) / 0.42, 2)); z += Math.sign(sn) * q.fb * k * Math.abs(sn); }
      if (q.fk && !upper) y -= q.fk * Math.pow(-c, 1.5);
      return out.set(nose - s, y, z);
    };
    // the section angle (right side) where the surface is at height y: the section's height falls monotonically from
    // the crown to the keel
    H.thAt = (s, y) => {
      let lo = 0, hi = Math.PI; const p = new V3();
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; H.pt(s, mid, p); if (p.y > y) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    };
    // the section angle of a point's direction from the section centre, and whether the point is inside
    const tmp = new V3();
    H.polar = (s, y, z) => {
      const q = fnc(clamp(s, 0, L)), phi = Math.atan2(Math.abs(z), y - q.yc); let lo = 0, hi = Math.PI;
      for (let i = 0; i < 36; i++) { const mid = (lo + hi) / 2; H.pt(s, mid, tmp); const ph = Math.atan2(Math.abs(tmp.z), tmp.y - q.yc); if (ph < phi) lo = mid; else hi = mid; }
      const th = (lo + hi) / 2; H.pt(s, th, tmp);
      const inside = Math.hypot(y - q.yc, z) < Math.hypot(tmp.y - q.yc, tmp.z);
      return { th: z >= 0 ? th : 2 * Math.PI - th, inside };
    };
    // where a ray from inside the fuselage leaves it: { s, th, p }
    H.hit = (o, d) => {
      const p = new V3(); let t0 = 0, t1 = 0;
      for (let t = 0.1; t < 12; t += 0.1) { p.copy(o).addScaledVector(d, t); const s = nose - p.x; if (s < 0 || s > L || !H.polar(s, p.y, p.z).inside) { t1 = t; break; } t0 = t; }
      if (!t1) return null;
      for (let i = 0; i < 30; i++) { const t = (t0 + t1) / 2; p.copy(o).addScaledVector(d, t); const s = nose - p.x; if (s >= 0 && s <= L && H.polar(s, p.y, p.z).inside) t0 = t; else t1 = t; }
      p.copy(o).addScaledVector(d, (t0 + t1) / 2); const s = clamp(nose - p.x, 0, L);
      return { s, th: H.polar(s, p.y, p.z).th, p: p.clone() };
    };
    const E = m.cockpit;
    H.eye = new V3(E.x, -E.z, E.y);
    if (!paneCache.has(type.id)) paneCache.set(type.id, kind === 'jet' ? cockpitPanes(H, H.noseSpec) : kind === 'ga' && m.windows.style === 'ga' ? lightPanes(H) : kind === 'heli' ? heliPanes(H) : []);
    H.panes = paneCache.get(type.id);
    // a bubble canopy (fighters, the aerobatic single): its opening in the fuselage (for the cockpit shell)
    H.canopy = m.canopy ? { x: m.canopy.x, z: m.canopy.z, len: m.canopy.len, w: m.canopy.w, h: m.canopy.h, peak: 0.45 } : kind === 'fighter' ? { x: 3.35, z: -0.58, len: 3.6, w: 0.36, h: 0.62, peak: 0.42, tail: 0.3 } : null;
    if (H.canopy) {
      const c = H.canopy, sA = nose - (c.x + c.len * 0.47), sB = nose - (c.x - c.len * 0.47), t = 0.95;
      H.openings = [ACGeo.ccw([[sA, 0], [sB, 0], [sB, t], [sA, t]]), ACGeo.ccw([[sA, 2 * Math.PI - t], [sB, 2 * Math.PI - t], [sB, 2 * Math.PI], [sA, 2 * Math.PI]])];
    }
    return H;
  }

  // light aircraft: windscreen, door windows, rear or cabin windows, placed from the fuselage's landmarks
  // (cowl, windscreen, cabin): corners as (s, height fraction from the keel to the roof) -> (s, th)
  function lightPanes(H) {
    const g = H.ga, m = H.m, th = (s, f) => { const q = H.sec(s), bot = q.yc - q.dn, top = q.yc + q.up; return H.thAt(s, bot + (top - bot) * f); };
    const P = (pts) => ({ poly: ACGeo.ccw(pts.map(([s, f]) => [s, typeof f === 'number' && f > 1 ? f : th(s, f)])), front: false });
    const out = [], ws0 = g.C + 0.03, ws1 = g.C + g.WS - 0.03, post = 0.012 / Math.max(0.3, H.sec(ws1).a);
    // windscreen (to the corner posts), marked 'front' (its inboard edge on the centre line)
    out.push({ poly: ACGeo.ccw([[ws0, post], [ws0 + 0.12, th(ws0 + 0.12, 0.74)], [ws1, th(ws1, 0.84)], [ws1, post]]), front: true });
    const d0 = g.C + g.WS + 0.05, dl = Math.min(1.0, (g.CB - d0) * 0.45);
    out.push(P([[d0, 0.46], [d0 + dl, 0.46], [d0 + dl, 0.9], [d0, 0.88]]));
    if (g.CB - d0 > 3) {            // a long cabin (the Twin Otter): a row of square windows
      for (let s = d0 + dl + 0.5; s < g.CB - 0.5; s += 0.95) out.push(P([[s, 0.52], [s + 0.46, 0.52], [s + 0.46, 0.82], [s, 0.82]]));
    } else out.push(P([[d0 + dl + 0.1, 0.5], [g.CB + 0.35, 0.58], [g.CB + 0.25, 0.86], [d0 + dl + 0.1, 0.88]]));
    return out;
  }
  // the H125: a bubble of glass: the windscreen halves, chin windows, the door windows
  function heliPanes(H) {
    const d = D, P = (pts, front) => ({ poly: ACGeo.ccw(pts.map(([s, t]) => [s, t * d])), front });
    return [P([[0.14, 3], [0.55, 96], [1.9, 74], [2.03, 3]], true), P([[0.46, 110], [1.15, 101], [1.25, 150], [0.56, 167]]), P([[2.1, 48], [2.96, 48], [2.96, 110], [2.1, 112]]), P([[3.03, 50], [3.72, 54], [3.62, 100], [3.03, 108]])];
  }
  // cockpit window panes in (s, th) (right side; mirrored for the left): the captain's panes from their view angles,
  // cast onto the nose from the eye, and mirrored to the other side (the first officer's)
  function cockpitPanes(H, N) {
    if (!N || !N.panes) return [];
    const eye = H.eye.clone(); eye.z = -Math.abs(eye.z) || -0.5;       // the captain sits on the left
    const panes = [];
    N.panes.forEach((P, k) => {
      const pts = P.map(([az, el]) => {
        const a = az * D, e = el * D, d = new V3(Math.cos(e) * Math.cos(a), Math.sin(e), -Math.cos(e) * Math.sin(a)).normalize();   // + azimuth: outboard (left)
        const h = H.hit(eye, d); return h ? [h.s, h.th] : null;
      });
      if (pts.some(p => !p)) return;
      // (the captain's side is th in (pi, 2 pi): mirror to the right side, th -> 2 pi - th)
      let poly = pts.map(([s, th]) => [s, 2 * Math.PI - th]);
      if (k === 0) {       // the front pane's inboard edge runs along the centre post
        const s0 = poly[0][0], s3 = poly[3][0], r0 = H.sec(s0).a, r3 = H.sec(s3).a;
        poly[0] = [s0, N.post / Math.max(0.3, r0) + 0.004]; poly[3] = [s3, N.post / Math.max(0.3, r3) + 0.004];
      }
      panes.push({ poly: ACGeo.ccw(poly), front: k === 0 });
    });
    return panes;
  }

  // ---------------------------------------------------------------- building the fuselage
  // ctx: { B, rig, q, pal(name), uvBody(s, th) -> [u, v], tile (m), bone(s) -> bone index (the droop nose) }
  function buildHull(H, ctx) {
    const G = ACGeo, B = ctx.B, L = H.L, q = ctx.q;
    const mb = B.mb('body');
    const nAround = ctx.far ? 16 : [28, 36, 56, 72, 96][q], nAlong = ctx.far ? 26 : [70, 100, 150, 190, 260][q];
    // stations: denser at the nose and the tail cone, and at the fairing's ends
    const ss = [];
    const NL = H.m.fus.noseLen || 2, TL = H.m.fus.tailLen || 3;
    const brk = [0, NL * 0.08, NL * 0.3, NL, L - TL, L - TL * 0.25, L];
    if (H.fair) brk.push(H.fair.s0 - 3, H.fair.s0 + 1.2, H.fair.s1 - 1.5, H.fair.s1 + 5);
    const s0 = H.s0 || 0;
    for (const s of G.stations([s0, ...brk.filter(v => v > s0 && v <= L)], L / nAlong)) ss.push(s);
    // nose: extra rings very close to the tip (a smooth, round radome)
    ss.splice(1, 0, s0 + 0.004 * NL, s0 + 0.015 * NL, s0 + 0.035 * NL);
    ss.sort((a, b) => a - b);
    const sEnd = H.s1 || L;
    const S = [...new Set(ss.map(v => +Math.min(v, sEnd).toFixed(5)))].filter(v => v >= s0 && v <= sEnd);
    const tile = ctx.tile || 2;
    const arc = (s, th) => { const qd = H.sec(s); return th * (qd.a + qd.up) / 2; };
    const half = (right) => {
      const ths = []; for (let k = 0; k <= nAround / 2; k++) ths.push(right ? Math.PI * k / (nAround / 2) : Math.PI + Math.PI * k / (nAround / 2));
      mb.skin = ctx.skin || null; if (!ctx.skin) mb.bind(0);
      mb.surface(S, ths, (s, th, out) => H.pt(s, th, out), { eu: 2e-4, ev: 1e-4, pole: new V3(1, 0, 0),
        uv: (s, th) => { const [u, v] = ctx.uvBody(s, th); return [u, v, s / tile, arc(s, right ? th : 2 * Math.PI - th) / tile]; } });
    };
    half(true); half(false);
    mb.skin = null; mb.bind(0);
    // the aft end of an airliner: the APU exhaust in the tail cone
    if (H.m.engines.some(e => e.type === 'fan')) {
      const e0 = H.sec(L), pc = ctx.pal('exhaustDark'), rX = Math.min(e0.a, (e0.up + e0.dn) / 2) * 0.8;
      const pm = B.mb('parts'); pm.pal = pc; pm.bind(0);
      pm.cyl(new V3(H.nose - L + 0.02, e0.yc, 0), new V3(H.nose - L - 0.12, e0.yc, 0), rX * 0.95, rX * 0.9, 16, false);
      pm.pal = ctx.pal('black'); pm.cyl(new V3(H.nose - L - 0.02, e0.yc, 0), new V3(H.nose - L - 0.1, e0.yc, 0), rX * 0.8, rX * 0.8, 16, true);
      pm.pal = null;
    }
    // cockpit windows: glass slightly proud of the skin, dark frames around each pane
    if (H.panes.length) windscreen(H, ctx);
    if (H.canopy) canopy(H, ctx);
  }
  // a bubble canopy over the cockpit opening: a slender tinted bubble from the rails, peaking ahead of its middle and
  // fairing down into the spine behind; a frame along the rails and the rear bow
  function canopy(H, ctx) {
    const c = H.canopy, q = ctx.q, glass = ctx.B.mb('canopy'), fr = ctx.B.mb('parts'), n = H.nose, th0 = 0.95;
    const rail = (x) => { const p = new V3(); H.pt(ACGeo.clamp(n - x, 0, H.L), th0, p); return p; };
    const prof = (u) => { const pk = c.peak || 0.45, tl = c.tail || 0.4; return u < pk ? Math.sin(Math.PI / 2 * u / pk) ** 0.7 : 1 - (1 - tl) * Math.pow((u - pk) / (1 - pk), 1.6); };
    const P2 = (u, v, out) => {
      const x = c.x + c.len * (0.5 - u), r = rail(x), k = prof(u), top = r.y + (-c.z + c.h - r.y) * k, a = Math.PI * v, bulge = 0.04 * k;
      return out.set(x, r.y + (top - r.y) * Math.sin(a), -Math.cos(a) * (r.z + bulge * Math.sin(a) + (c.w - r.z) * 0.15 * k * Math.sin(a)));
    };
    glass.bind(0);
    glass.surface(ACGeo.linSpace(0, 1, [8, 12, 18, 24, 32][q]), ACGeo.linSpace(0, 1, [10, 14, 20, 28, 36][q]), P2, { eu: 1e-4, ev: 1e-4, flip: true, uv: (u, v) => [u, v] });
    fr.bind(0); fr.pal = ctx.pal('canopyFrame');
    const line = (pts, r) => { for (let k = 0; k + 1 < pts.length; k++) fr.cyl(pts[k], pts[k + 1], r, r, 6, false); };
    line(ACGeo.linSpace(0, 1, 12).map(v => P2(0.8, v, new V3())), 0.03);
    for (const v of [0, 1]) line(ACGeo.linSpace(0, 1, 12).map(u => P2(u, v, new V3())), 0.022);
    fr.pal = null;
  }
  // map a polygon in (s, th) onto the surface, subdivided by a grid, offset along the normal
  function paint(H, mb, polys, off, cell, uvFn) {
    const G = ACGeo, p = new V3(), a = new V3(), b = new V3(), n = new V3();
    const put = (s, th) => {
      H.pt(s, th, p); H.pt(s + 1e-3, th, a); H.pt(s - 1e-3, th, b); const ds = a.clone().sub(b); H.pt(s, th + 1e-3, a); H.pt(s, th - 1e-3, b);
      n.crossVectors(ds, a.sub(b)).normalize();      // (d/ds x d/dth is the outward normal on both sides)
      const o = p.clone().addScaledVector(n, off), t = uvFn ? uvFn(s, th) : [0, 0];
      return mb.v(o.x, o.y, o.z, n.x, n.y, n.z, t[0], t[1]);
    };
    for (const { poly, sub } of polys) {
      let s0 = 1e9, s1 = -1e9, t0 = 1e9, t1 = -1e9; for (const [s, th] of poly) { s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, th); t1 = Math.max(t1, th); }
      const ns = Math.max(1, Math.ceil((s1 - s0) / cell)), nt = Math.max(1, Math.ceil((t1 - t0) / (cell / Math.max(0.3, H.sec((s0 + s1) / 2).a))));
      for (let i = 0; i < ns; i++) for (let j = 0; j < nt; j++) {
        const c = [[s0 + (s1 - s0) * i / ns, t0 + (t1 - t0) * j / nt], [s0 + (s1 - s0) * (i + 1) / ns, t0 + (t1 - t0) * j / nt], [s0 + (s1 - s0) * (i + 1) / ns, t0 + (t1 - t0) * (j + 1) / nt], [s0 + (s1 - s0) * i / ns, t0 + (t1 - t0) * (j + 1) / nt]];
        let pieces = [G.clipIn(c, poly)].filter(Boolean);
        if (sub) pieces = pieces.flatMap(pc => G.clipOut(pc, sub));
        for (const pc of pieces) { const ids = pc.map(([s, th]) => put(s, th)); for (let k = 1; k + 1 < ids.length; k++) mb.tri(ids[0], ids[k], ids[k + 1]); }
      }
    }
  }
  // the panes' polygons in a metric frame (s, th * r) for offsetting
  function grow(H, poly, d) {
    const G = ACGeo, sm = poly.reduce((t, p) => t + p[0], 0) / poly.length, r = Math.max(0.3, H.sec(sm).a);
    return G.offsetPoly(poly.map(([s, th]) => [s, th * r]), d).map(([s, t]) => [s, t / r]);
  }
  const mirrorPoly = (poly) => ACGeo.ccw(poly.map(([s, th]) => [s, 2 * Math.PI - th]));
  function windscreen(H, ctx) {
    const B = ctx.B, glass = B.mb('glass'), frames = B.mb('parts');
    glass.bind(0); frames.bind(0); frames.pal = ctx.pal('frame');
    const cell = [0.12, 0.09, 0.06, 0.05, 0.04][ctx.q];
    const all = [];
    for (const P of H.panes) for (const poly of [P.poly, mirrorPoly(P.poly)]) all.push(poly);
    // glass: the pane itself; frames: a band around it (the rubber seal and the frame paint)
    paint(H, glass, all.map(poly => ({ poly })), ctx.far ? 0.03 : 0.004, ctx.far ? 1 : cell, (s, th) => [s / 3, th]);
    if (!ctx.far) paint(H, frames, all.map(poly => ({ poly: grow(H, poly, 0.028), sub: poly })), 0.006, cell);
    frames.pal = null;
    H.paneGlass = all;
  }

  // ---------------------------------------------------------------- lifting surfaces
  // A wing, a horizontal tail or a fin from its spec (46_aircraft.js), one side. ctx: { B, rig, q, side, jet,
  // mat ('wing' | 'fin'), vertical, flex: { ys, bones } (span bones, wings), bone (else), uv(p, upper) -> [u, v],
  // tile, rootIn (the root runs on inside the fuselage to this span), extraStations, noTip }
  // Returns the section functions and the panels: each moving surface is a bone with a hinge axis such that a
  // positive angle moves its trailing edge down (the fin's: to the right).
  function surface(w, ctx) {
    const G = ACGeo, q = ctx.q, side = ctx.side || 1, vert = !!ctx.vertical, mb = ctx.B.mb(ctx.mat || 'wing');
    const y0 = w.y0 || 0, span = w.span, tanS = Math.tan((w.sweep || 0) * D), tanD = Math.tan((w.dih || 0) * D);
    const cam = w.cam !== undefined ? w.cam : (vert ? 0 : ctx.jet ? 0.022 : 0.016), style = ctx.jet && !vert ? 'sc' : 'naca';
    const chord = (y) => {
      if (w.yK && y < w.yK) return w.c0 + (w.cK - w.c0) * (y - y0) / (w.yK - y0);
      if (w.yK) return w.cK + (w.c1 - w.cK) * (y - w.yK) / (span - w.yK);
      return w.c0 + (w.c1 - w.c0) * (y - y0) / (span - y0);
    };
    const rake = w.tip === 'raked' ? span - 0.13 * (span - y0) : 1e9;
    const ogee = w.ogee ? G.mono(w.ogee) : null;
    const xTipLE = w.x - (span - y0) * tanS;
    const leX = (y) => {
      if (ogee) return w.x + (xTipLE - w.x) * ogee(clamp((y - y0) / (span - y0), 0, 1));
      return w.x - (Math.min(y, rake) - y0) * tanS - Math.max(0, y - rake) * Math.tan(Math.min(72, (w.sweep || 0) + 24) * D);
    };
    const teRoot = w.x - w.c0, teTip = xTipLE - w.c1;
    const chordAt = (y) => {
      if (y > rake) { const cr = chord(rake), f = (y - rake) / (span - rake); return cr * (1 - 0.74 * Math.pow(f, 1.2)); }
      if (ogee) return leX(y) - (teRoot + (teTip - teRoot) * clamp((y - y0) / (span - y0), 0, 1));
      return chord(y);
    };
    const yRoot = ctx.rootIn !== undefined ? Math.min(ctx.rootIn, y0) : y0;
    const fr = { c: 1, t: 0.1, lx: 0, ly: 0, lz: 0, cd: new V3(), ud: new V3() };
    // section frame at span station y: leading-edge point, chord, unit aft, unit 'up' (twisted), thickness
    // (the last few stations are remembered: a surface asks for each one many times)
    const fcache = [];
    const frame = (y, out) => {
      for (let i = 0; i < fcache.length; i++) if (fcache[i].y === y) { const r = fcache[i].r; out.c = r.c; out.t = r.t; out.lx = r.lx; out.ly = r.ly; out.lz = r.lz; out.cd.copy(r.cd); out.ud.copy(r.ud); return out; }
      const r = frame0(y, { c: 1, t: 0.1, lx: 0, ly: 0, lz: 0, cd: new V3(), ud: new V3() });
      fcache.unshift({ y, r }); if (fcache.length > 6) fcache.pop();
      out.c = r.c; out.t = r.t; out.lx = r.lx; out.ly = r.ly; out.lz = r.lz; out.cd.copy(r.cd); out.ud.copy(r.ud); return out;
    };
    const frame0 = (y, out) => {
      const yy = clamp(y, yRoot, span), ye = Math.max(yy, y0), f = clamp((ye - y0) / Math.max(span - y0, 1e-3), 0, 1), inc = ((w.twist || 0) * f + (w.inc || 0)) * D;
      out.c = chordAt(ye); out.t = w.t + ((w.tt !== undefined ? w.tt : w.t) - w.t) * f; out.lx = leX(ye);
      if (!vert) { out.ly = -w.z + (yy - y0) * tanD; out.lz = yy; out.cd.set(-Math.cos(inc), -Math.sin(inc), 0); out.ud.set(-Math.sin(inc), Math.cos(inc), 0); }
      else { out.ly = -w.z + yy; out.lz = 0; out.cd.set(-1, 0, 0); out.ud.set(0, 0, 1); }
      return out;
    };
    // a point of the section loop (qq: 0 upper TE, 0.5 LE, 1 lower TE; the fin's 'upper' side is its right side)
    const P = (y, qq, out) => {
      frame(y, fr); const [x, yf] = G.foil(qq, fr.t, cam, style);
      return out.set(fr.lx + (fr.cd.x * x + fr.ud.x * yf) * fr.c, fr.ly + (fr.cd.y * x + fr.ud.y * yf) * fr.c, fr.lz + (fr.cd.z * x + fr.ud.z * yf) * fr.c);
    };
    const tile = ctx.tile || 2, tmp = new V3();
    const uvq = (p, qq) => { const t = ctx.uv ? ctx.uv(p, qq < 0.5) : [0, 0]; return vert ? [t[0], t[1], p.x / tile, p.y / tile] : [t[0], t[1], p.z / tile, p.x / tile]; };
    // every patch: us = span stations, vs = a loop or a helper parameter; outward normals are d/dspan x d/dv
    // for a wing (+z span) and the opposite for a fin (+y span), hence the flip
    const S = (us, vs, fn, flip, uvFn) => mb.surface(us, vs, fn, { eu: 1e-4, ev: 1e-5, flip: vert !== !!flip, uv: uvFn || ((y, v) => uvq(fn(y, v, tmp), 0.3)) });
    const loopUV = (y, qq) => uvq(P(y, qq, tmp), qq);

    // ---- where the moving surfaces are
    const cuts = [];
    const addCut = (a, b, cf, kind) => { const ya = clamp(a, yRoot, span), yb = clamp(b, yRoot, span); if (yb - ya > 0.05) cuts.push({ y0: ya, y1: yb, cf, kind }); };
    if (w.flap) {
      const [a, b, cf] = w.flap, splits = [a];
      if (w.yK && w.yK > a + 1 && w.yK < b - 1) splits.push(w.yK);
      splits.push(b);
      for (let i = 0; i + 1 < splits.length; i++) { const n = Math.max(1, Math.round((splits[i + 1] - splits[i]) / (ctx.jet ? 8 : 12))); for (let k = 0; k < n; k++) addCut(splits[i] + (splits[i + 1] - splits[i]) * k / n, splits[i] + (splits[i + 1] - splits[i]) * (k + 1) / n, cf, 'flap'); }
    }
    if (w.ail) { const [a, b, cf] = w.ail, n = w.elevon ? 3 : 1; for (let k = 0; k < n; k++) addCut(a + (b - a) * k / n, a + (b - a) * (k + 1) / n, cf, w.elevon ? 'elevon' : 'ail'); }
    if (w.elev) addCut(w.elevY0 !== undefined ? w.elevY0 : y0 + 0.05, span * 0.985, w.elev, 'elev');
    if (w.rud) { const n = w.rudSplit ? 2 : 1, a = span * 0.04, b = span * 0.97; for (let k = 0; k < n; k++) addCut(a + (b - a) * k / n, a + (b - a) * (k + 1) / n, w.rud, 'rud'); }
    cuts.sort((a, b) => a.y0 - b.y0);
    const cutAt = (y) => cuts.find(c => y > c.y0 + 1e-4 && y < c.y1 - 1e-4);
    const slats = [];
    if (w.slats && !vert) {
      const a = y0 + 0.3, b = span - Math.max(0.35, (span - y0) * 0.03), n = clamp(Math.round((b - a) / 3.4), 3, 8);
      for (let k = 0; k < n; k++) slats.push({ y0: a + (b - a) * k / n + 0.025, y1: a + (b - a) * (k + 1) / n - 0.025 });
    }
    const XS = 0.13, XS2 = 0.045;
    const slatAt = (y) => slats.find(s => y > s.y0 + 1e-4 && y < s.y1 - 1e-4);

    // ---- span stations
    const breaks = [yRoot, y0, span];
    if (w.yK) breaks.push(w.yK); if (rake < span) breaks.push(rake);
    for (const c of cuts) breaks.push(c.y0, c.y1); for (const s of slats) breaks.push(s.y0, s.y1);
    for (const y of ctx.extraStations || []) if (y > yRoot && y < span) breaks.push(y);
    if (ctx.flex) for (const y of ctx.flex.ys) if (y > yRoot && y < span) breaks.push(y);
    const Y = G.stations(breaks.filter(v => v >= yRoot && v <= span), Math.max(0.1, (span - yRoot) / (ctx.far ? 3 : [8, 12, 18, 24, 32][q])));
    const nq = ctx.far ? 4 : [7, 9, 12, 16, 22][q], baseQ = G.qList(0, 1, nq * 2);
    const between = (qa, qb) => { const o = [qa]; for (const v of baseQ) if (v > qa + 1e-4 && v < qb - 1e-4) o.push(v); o.push(qb); return o; };

    // ---- skin binding: span bones (wing flex) or one bone
    const flex = ctx.flex;
    const bindSkin = () => {
      if (flex) mb.skin = (x, y, z, out) => {
        const s = vert ? y : Math.abs(z), ys = flex.ys; let k = 0; while (k + 2 < ys.length && s > ys[k + 1]) k++;
        out[0] = flex.bones[k]; out[1] = flex.bones[k + 1]; out[2] = clamp((s - ys[k]) / (ys[k + 1] - ys[k]), 0, 1);
      }; else mb.bind(ctx.bone || 0);
    };
    const parentAt = (ya, yb) => { if (!flex) return ctx.bone || 0; const ym = (ya + yb) / 2; let k = 0; while (k + 1 < flex.ys.length && flex.ys[k + 1] <= ym) k++; return flex.bones[k]; };
    bindSkin(); mb.mirror = side < 0;

    // ---- the fixed skin, strip by strip (a strip keeps one cut-out configuration)
    const strips = [];
    for (let i = 0; i + 1 < Y.length; i++) {
      const ym = (Y[i] + Y[i + 1]) / 2, c = cutAt(ym), sl = slatAt(ym), key = (c ? c.cf + c.kind + c.y0 : '') + '|' + (sl ? sl.y0 : '');
      const last = strips[strips.length - 1];
      if (last && last.key === key) last.ys.push(Y[i + 1]); else strips.push({ key, ys: [Y[i], Y[i + 1]], cut: c, slat: sl });
    }
    const A = new V3(), Bv = new V3();
    for (const st of strips) {
      const xr = st.cut ? 1 - st.cut.cf : 1, qu = xr < 1 ? G.qAt(xr, 1) : 0, ql = xr < 1 ? G.qAt(xr, -1) : 1;
      if (!st.slat) S(st.ys, between(qu, ql), P, false, loopUV);
      else {
        const qs1 = G.qAt(XS, 1), qs2 = G.qAt(XS2, -1);
        S(st.ys, between(qu, qs1), P, false, loopUV);
        S(st.ys, between(qs2, ql), P, false, loopUV);
        // the fixed leading edge behind the slat: a rounded nose between the two cut points
        const nose = (y, k, out) => { P(y, qs1, A); P(y, qs2, Bv); const r = A.distanceTo(Bv) / 2, ang = Math.PI * k;
          return out.copy(A).lerp(Bv, 0.5).addScaledVector(fr.cd, -Math.sin(ang) * r * 0.9).addScaledVector(tmp.copy(A).sub(Bv).normalize(), Math.cos(ang) * r); };
        S(st.ys, G.linSpace(0, 1, 6), nose, false);
      }
      if (xr < 1) {        // the cove behind the fixed part, where the flap / aileron / rudder tucks in
        const cove = (y, k, out) => { P(y, qu, A); P(y, ql, Bv); return out.copy(A).lerp(Bv, k).addScaledVector(fr.cd, -Math.sin(Math.PI * k) * 0.3 * A.distanceTo(Bv)); };
        S(st.ys, G.linSpace(0, 1, 4), cove, true);
      }
    }
    // the tip: a rounded cap (a device, when the type has one, is built over it)
    if (!ctx.noTip) {
      const yT = span, ext = Math.max(0.02, (w.tt !== undefined ? w.tt : w.t) * chordAt(yT) * (vert ? 0.3 : 0.45));
      const cap = (k, qq, out) => { P(yT, qq, out); P(yT, 1 - qq, A); const a = k * Math.PI / 2; out.lerp(A.lerp(out, 0.5), 1 - Math.cos(a)); if (vert) out.y += Math.sin(a) * ext; else out.z += Math.sin(a) * ext; return out; };
      // (d/dk x d/dq: outward along the span, then over the top and the bottom; the fin's span is +y)
      mb.surface(G.linSpace(0, 1, 4), baseQ.filter(v => v <= 0.5 + 1e-9), cap, { eu: 1e-4, ev: 1e-5, flip: vert, uv: (k, qq) => uvq(cap(k, qq, tmp), qq) });
      mb.surface(G.linSpace(0, 1, 4), baseQ.filter(v => v >= 0.5 - 1e-9), cap, { eu: 1e-4, ev: 1e-5, flip: vert, uv: (k, qq) => uvq(cap(k, qq, tmp), qq) });
    }
    mb.skin = null; mb.mirror = false;

    // ---- moving panels
    const panels = [];
    const hingeAxis = (ha, hb, cd, ud) => {       // unit axis: positive rotation = trailing edge down (fin: right)
      const ax = hb.clone().sub(ha).normalize(), mv = new V3().crossVectors(ax, cd);
      if (vert ? mv.z < 0 : mv.dot(ud) > 0) ax.negate();
      return ax;
    };
    const mir = (v) => (side < 0 ? v.setZ(-v.z) : v);
    const endPlates = (ys, loopPts) => {           // flat ends of a panel, facing along the span
      for (const [y, dir] of [[ys[0], -1], [ys[ys.length - 1], 1]]) {
        const pts = loopPts(y), n = vert ? new V3(0, dir, 0) : new V3(0, 0, dir), c = pts.reduce((a, p) => a.add(p), new V3()).divideScalar(pts.length);
        const ci = mb.v(c.x, c.y, c.z, n.x, n.y, n.z, ...uvq(c, 0.3));
        const ids = pts.map(p => mb.v(p.x, p.y, p.z, n.x, n.y, n.z, ...uvq(p, 0.3)));
        for (let i = 0; i + 1 < ids.length; i++) {
          const e = new V3().crossVectors(pts[i].clone().sub(c), pts[i + 1].clone().sub(c)).dot(n);
          if (e >= 0) mb.tri(ci, ids[i], ids[i + 1]); else mb.tri(ci, ids[i + 1], ids[i]);
        }
      }
    };
    for (const c of cuts) {
      const ys = Y.filter(v => v >= c.y0 - 1e-6 && v <= c.y1 + 1e-6); if (ys.length < 2) continue;
      const xr = 1 - c.cf, qu = G.qAt(xr, 1), ql = G.qAt(xr, -1);
      const nose = (y, k, out) => { P(y, qu, A); P(y, ql, Bv); const r = A.distanceTo(Bv) / 2;
        return out.copy(A).lerp(Bv, 0.5).addScaledVector(fr.cd, -Math.sin(Math.PI * k) * r * 0.95).addScaledVector(tmp.copy(A).sub(Bv).normalize(), Math.cos(Math.PI * k) * r); };
      const hinge = (y) => { P(y, qu, A); P(y, ql, Bv); return A.clone().lerp(Bv, 0.5); };
      const ha = mir(hinge(ys[0])), hb = mir(hinge(ys[ys.length - 1]));
      const bone = ctx.rig.add(parentAt(c.y0, c.y1), (ha.x + hb.x) / 2, (ha.y + hb.y) / 2, (ha.z + hb.z) / 2);
      mb.bind(bone); mb.mirror = side < 0;
      S(ys, between(0, qu), P, false, loopUV);
      S(ys, between(ql, 1), P, false, loopUV);
      S(ys, G.linSpace(0, 1, 6), nose, false);
      endPlates(ys, (y) => [...between(0, qu).map(v => P(y, v, new V3())), ...G.linSpace(0, 1, 6).slice(1, -1).map(k => nose(y, k, new V3())), ...between(ql, 1).map(v => P(y, v, new V3()))]);
      mb.mirror = false;
      frame((c.y0 + c.y1) / 2, fr);
      const cd = mir(fr.cd.clone()), ud = mir(fr.ud.clone());
      panels.push({ kind: c.kind, bone, axis: hingeAxis(ha, hb, cd, ud), side, y0: c.y0, y1: c.y1, c: fr.c, cd, ud, idx: cuts.filter(o => o.kind === c.kind).indexOf(c) });
    }
    // spoilers: plates on the upper surface ahead of the flaps, hinged at their leading edge
    if (w.spoil && !vert) for (const [a, b] of w.spoil) {
      const n = clamp(Math.round((b - a) / 1.9), 2, 8);
      for (let k = 0; k < n; k++) {
        const ya = a + (b - a) * k / n + 0.02, yb = a + (b - a) * (k + 1) / n - 0.02;
        const ys = [ya, ...Y.filter(v => v > ya + 1e-3 && v < yb - 1e-3), yb];
        const c = cutAt((ya + yb) / 2), x1 = (c ? 1 - c.cf : 0.8) - 0.004, x0 = x1 - 0.15, q0 = G.qAt(x0, 1), q1 = G.qAt(x1, 1);
        const top = (y, qq, out) => { P(y, qq, out); return out.addScaledVector(fr.ud, 0.005); };
        const under = (y, qq, out) => { P(y, qq, out); return out.addScaledVector(fr.ud, -0.012); };
        const ha = mir(top(ya, q0, new V3())), hb = mir(top(yb, q0, new V3()));
        const bone = ctx.rig.add(parentAt(ya, yb), (ha.x + hb.x) / 2, (ha.y + hb.y) / 2, (ha.z + hb.z) / 2);
        mb.bind(bone); mb.mirror = side < 0;
        S(ys, G.linSpace(q1, q0, 4), top, false, loopUV);
        S(ys, G.linSpace(q1, q0, 3), under, true, loopUV);
        endPlates(ys, (y) => [...G.linSpace(q1, q0, 4).map(v => top(y, v, new V3())), ...G.linSpace(q0, q1, 3).map(v => under(y, v, new V3()))]);
        mb.mirror = false;
        frame((ya + yb) / 2, fr);
        const cd = mir(fr.cd.clone()), ud = mir(fr.ud.clone());
        panels.push({ kind: 'spoiler', bone, axis: hingeAxis(ha, hb, cd, ud), side, y0: ya, y1: yb, idx: k, n, c: fr.c });
      }
    }
    // slats: the leading edge; they swing forward and droop about a point behind them
    for (const sl of slats) {
      const ys = [sl.y0, ...Y.filter(v => v > sl.y0 + 1e-3 && v < sl.y1 - 1e-3), sl.y1];
      const qs1 = G.qAt(XS, 1), qs2 = G.qAt(XS2, -1);
      const back = (y, k, out) => { P(y, qs1, A); P(y, qs2, Bv); return out.copy(A).lerp(Bv, k); };
      const ha = mir(P(sl.y0, qs1, new V3())), hb = mir(P(sl.y1, qs1, new V3()));
      const bone = ctx.rig.add(parentAt(sl.y0, sl.y1), (ha.x + hb.x) / 2, (ha.y + hb.y) / 2, (ha.z + hb.z) / 2);
      mb.bind(bone); mb.mirror = side < 0;
      S(ys, between(qs1, qs2), P, false, loopUV);
      S(ys, G.linSpace(0, 1, 2), back, true);
      endPlates(ys, (y) => between(qs1, qs2).map(v => P(y, v, new V3())));
      mb.mirror = false;
      frame((sl.y0 + sl.y1) / 2, fr);
      const cd = mir(fr.cd.clone()), ud = mir(fr.ud.clone());
      panels.push({ kind: 'slat', bone, axis: hingeAxis(ha, hb, cd, ud), side, y0: sl.y0, y1: sl.y1, c: fr.c, cd, ud });
    }
    mb.bind(0);
    return { P, frame, chordAt, leX, span, y0, yRoot, panels, cuts, slats, Y, cutAt, side, w, fr, cam, style };
  }

  // ---------------------------------------------------------------- wingtip devices, flap-track fairings
  // Tip devices (per type): the A320's sharklet, the 737's blended winglet, the 747-400's canted winglet, the
  // A380's wingtip fence, small business-aircraft winglets, the F-16's launcher rail. Each is a loft of thin
  // sections along a path that leaves the tip horizontally and turns up (canted outboard); the first section is
  // the wing's own tip section, so the join is seamless. Painted in the tail colour (the fin atlas' winglet region).
  const TIPS = {
    sharklet: { h: 0.136, rb: 0.075, cant: 14, sweep: 58, top: 0.26, t: 0.1 },
    winglet: { h: 0.146, rb: 0.045, cant: 16, sweep: 52, top: 0.24, t: 0.1 },
    canted: { h: 0.057, rb: 0.01, cant: 29, sweep: 60, top: 0.3, t: 0.09 },
    bizjet: { h: 0.075, rb: 0.03, cant: 10, sweep: 45, top: 0.45, t: 0.1 },
  };
  function wingDetails(w, ws, ctx) {
    const G = ACGeo, side = ws.side, q = ctx.q, tipStyle = w.tip === 'winglet' && (w.span < 12) ? 'bizjet' : w.tip;
    const lastBone = ws.flex ? ws.flex.bones[ws.flex.bones.length - 1] : 0;
    // ---- the tip device
    const T = TIPS[tipStyle];
    if (T || tipStyle === 'fence') {
      const mb = ctx.B.mb('fin'); mb.bind(lastBone); mb.mirror = side < 0;
      const span = ws.span, fr0 = ws.frame(span, { cd: new V3(), ud: new V3() }), c0 = fr0.c, xLE0 = fr0.lx, y0t = fr0.ly;
      const R = ctx.FIN_R, uvF = (p, outboard) => { const reg = R[outboard ? 'wo' : 'wi']; return [reg[0] + reg[2] * clamp((xLE0 + 0.3 - p.x) / (c0 + 3.5), 0, 1), reg[1] + reg[3] * clamp(1 - (p.y - y0t + 1.2) / 5, 0, 1)]; };
      const buildDev = (H0, rb, cant, sweep, top, t, dir) => {      // dir: +1 up, -1 down (the fence's lower half)
        const ang = (90 - cant) * D, arcL = rb * ang, straight = Math.max(0.05, H0 - rb * Math.sin(ang)), total = arcL + straight;
        const path = (u, out) => {     // (y, z) offsets from the tip's leading edge and the tangent
          const d = u * total;
          if (d <= arcL) { const a = d / Math.max(rb, 1e-6); out.y = dir * rb * (1 - Math.cos(a)); out.z = rb * Math.sin(a); out.ty = dir * Math.sin(a); out.tz = Math.cos(a); }
          else { const k = d - arcL; out.y = dir * (rb * (1 - Math.cos(ang)) + k * Math.sin(ang)); out.z = rb * Math.sin(ang) + k * Math.cos(ang); out.ty = dir * Math.sin(ang); out.tz = Math.cos(ang); }
          return out;
        };
        const pp = { y: 0, z: 0, ty: 0, tz: 1 };
        const P2 = (u, qq, out) => {
          path(u, pp); const h = Math.abs(pp.y), k = sstep(0, 0.35, u);
          const c = lerp(c0, c0 * top, Math.pow(u, 0.85)), sweepX = h * Math.tan(sweep * D) * (dir > 0 ? 1 : 0.9) + (1 - k) * 0;
          const tw = ws.w.tt !== undefined ? ws.w.tt : ws.w.t, [xa, ya] = G.foil(qq, tw, ws.cam, ws.style), [xb, yb] = G.foil(qq, t, 0.004, 'naca');
          const x = lerp(xa, xb, k), yf = lerp(ya, yb, k);
          // section frame: aft, and 'up' turned with the path (the device's suction side faces inboard)
          const ux = 0, uy = dir > 0 ? pp.tz : pp.tz, uz = -pp.ty;
          const cdx = lerp(fr0.cd.x, -1, k), cdy = lerp(fr0.cd.y, 0, k);
          return out.set(xLE0 - sweepX + (cdx * x) * c + ux, y0t + pp.y + (cdy * x + uy * yf) * c, span + pp.z + (uz * yf) * c * (dir > 0 ? 1 : -1));
        };
        const nu = ctx.far ? 2 : [4, 6, 9, 12, 16][q], us = G.linSpace(0, 1, nu), nqq = ctx.far ? 3 : [6, 8, 11, 14, 18][q];
        const flipB = dir < 0;
        mb.surface(us, G.qList(0, 0.5, nqq), P2, { eu: 1e-4, ev: 1e-5, flip: flipB, uv: (u, qq) => uvF(P2(u, qq, new V3()), dir < 0) });
        mb.surface(us, G.qList(0.5, 1, nqq), P2, { eu: 1e-4, ev: 1e-5, flip: flipB, uv: (u, qq) => uvF(P2(u, qq, new V3()), dir > 0) });
        // rounded tip
        const cap = (k, qq, out) => { P2(1, qq, out); const o2 = P2(1, 1 - qq, new V3()); const a = k * Math.PI / 2; out.lerp(o2.lerp(out, 0.5), 1 - Math.cos(a)); path(1, pp); out.y += dir * Math.sin(a) * pp.ty * 0.04; out.z += Math.sin(a) * pp.tz * 0.04; return out; };
        mb.surface(G.linSpace(0, 1, 3), G.qList(0, 0.5, nqq), cap, { eu: 1e-4, ev: 1e-5, flip: flipB, uv: () => uvF(P2(1, 0.3, new V3()), true) });
        mb.surface(G.linSpace(0, 1, 3), G.qList(0.5, 1, nqq), cap, { eu: 1e-4, ev: 1e-5, flip: flipB, uv: () => uvF(P2(1, 0.3, new V3()), true) });
      };
      if (tipStyle === 'fence') {
        buildDev(1.3, 0.02, 0, 64, 0.22, 0.08, 1);
        buildDev(0.9, 0.02, 0, 55, 0.3, 0.08, -1);
      } else buildDev(T.h * span * (w.tipScale || 1), T.rb * span, T.cant, T.sweep, T.top, T.t, 1);
      mb.mirror = false; mb.bind(0);
    }
    if (w.tip === 'rail') {           // F-16: launcher rail along the tip with a slim instrumentation pod
      const mb = ctx.B.mb('parts'); mb.bind(lastBone); mb.pal = ctx.pal('base'); mb.mirror = side < 0;
      const fr0 = ws.frame(ws.span, { cd: new V3(), ud: new V3() });
      mb.box(fr0.lx - fr0.c * 0.5, fr0.ly, ws.span + 0.06, fr0.c * 1.05, 0.12, 0.12);
      mb.pal = ctx.pal('aluDull'); mb.cyl(new V3(fr0.lx + 0.9, fr0.ly - 0.13, ws.span + 0.06), new V3(fr0.lx - 2.1, fr0.ly - 0.13, ws.span + 0.06), 0.063, 0.063, 12, true);
      mb.pal = ctx.pal('base'); mb.cyl(new V3(fr0.lx + 1.25, fr0.ly - 0.13, ws.span + 0.06), new V3(fr0.lx + 0.9, fr0.ly - 0.13, ws.span + 0.06), 0.002, 0.063, 12, false);
      mb.pal = null; mb.mirror = false; mb.bind(0);
    }
    // ---- the F-16's leading-edge extension: a thin strake from under the canopy out to the wing root's leading
    // edge, blending the forebody into the wing; the ventral fins under the aft body
    if (w.lex) {
      const mb = ctx.B.mb('wing'), H = ctx.H, xF = 4.9, xW = ws.leX(ws.y0), yW = -w.z;
      mb.bind(0); mb.mirror = side < 0;
      const lex = (u, v, out) => {
        const x = lerp(xF, xW - 1.2, u), s = H.nose - x, side0 = H.sec(s).a * 0.9, reach = (ws.y0 + 0.15 - side0) * Math.pow(Math.sin(Math.PI / 2 * clamp(u * 1.25, 0, 1)), 1.3) + 0.02;
        const th2 = 0.018 + 0.06 * u, a = v * Math.PI * 2;
        return out.set(x, yW + 0.03 + Math.sin(a) * th2, side0 + reach * (0.5 - 0.5 * Math.cos(a)));
      };
      mb.surface(G.linSpace(0, 1, [6, 8, 12, 14, 18][q]), G.linSpace(0, 1, 12), lex, { eu: 1e-4, ev: 1e-4, flip: true, uv: (u, v, i, j, p) => ctx.uv(p, Math.sin(v * Math.PI * 2) >= 0) });
      const pm = ctx.B.mb('parts'); pm.bind(0); pm.pal = ctx.pal('base'); pm.mirror = side < 0;
      const vf = [[-3.1, -0.72], [-4.7, -0.72], [-4.95, -1.15], [-4.1, -1.12]].map(([x, y]) => new V3(x, y, 0.42));
      const cant = 16 * D, pv = vf[0].clone();
      pm.at(new THREE.Matrix4().makeTranslation(pv.x, pv.y, pv.z).multiply(new THREE.Matrix4().makeRotationX(-cant)).multiply(new THREE.Matrix4().makeTranslation(-pv.x, -pv.y, -pv.z)), () => {
        for (const sd of [1, -1]) { const n = new V3(0, 0, sd); const ids = vf.map(p => pm.v(p.x, p.y, p.z + sd * 0.015, n.x, n.y, n.z)); if (sd > 0) { pm.tri(ids[0], ids[1], ids[2]); pm.tri(ids[0], ids[2], ids[3]); } else { pm.tri(ids[0], ids[2], ids[1]); pm.tri(ids[0], ids[3], ids[2]); } }
      });
      pm.pal = null; pm.mirror = false; mb.mirror = false;
    }
    // ---- the wing strut of the high-wing types: a streamlined tube from the lower fuselage to mid-span
    if (w.strut && !ctx.far) {
      const mb = ctx.B.mb('parts'), H = ctx.H, yS = ws.span * 0.52, fr = ws.frame(yS, { cd: new V3(), ud: new V3() });
      const xT = fr.lx - fr.c * 0.3, top = ws.P(yS, ACGeo.qAt(0.3, -1), new V3()), sB = H.nose - xT, qb = H.sec(sB), bot = new V3(xT, qb.yc - qb.dn * 0.55, qb.a * 0.92);
      top.x = xT; top.z = yS; top.y += 0.02;
      const ax = top.clone().sub(bot), len = ax.length(); ax.normalize(); const side = new V3().crossVectors(ax, new V3(1, 0, 0)).normalize();
      const fb = ws.flex ? ws.flex.bones[0] : 0;
      mb.bind(fb); mb.pal = ctx.pal('base'); mb.mirror = side < 0 && false;
      for (const sd of [ws.side]) {
        mb.mirror = sd < 0;
        mb.surface(ACGeo.linSpace(0, 1, 6), ACGeo.linSpace(0, 1, 10), (u, v, out) => { const a = v * Math.PI * 2; return out.copy(bot).addScaledVector(ax, u * len).addScaledVector(new V3(1, 0, 0), Math.cos(a) * 0.075).addScaledVector(side, Math.sin(a) * 0.025); }, { eu: 1e-4, ev: 1e-4, flip: true });
      }
      mb.mirror = false; mb.pal = null; mb.bind(0);
    }
    // ---- flap-track fairings: canoes under the flaps; the aft part rides on the flap
    const nF = w.fairings || 0, flaps = ws.panels.filter(p => p.kind === 'flap');
    if (nF && flaps.length && !ctx.far) {
      const mb = ctx.B.mb('wing'), a = Math.min(...flaps.map(p => p.y0)), b = Math.max(...flaps.map(p => p.y1));
      const nu = [5, 6, 8, 10, 12][q], nv = [6, 8, 10, 12, 16][q];
      for (let k = 0; k < nF; k++) {
        const y = a + (b - a) * (k + 0.5) / nF, fr = ws.frame(y, { cd: new V3(), ud: new V3() }), c = fr.c;
        const flap = flaps.find(p => y >= p.y0 && y <= p.y1) || flaps[0];
        const lowY = (x) => ws.P(y, ACGeo.qAt(clamp(x, 0.001, 0.999), -1), new V3());
        const depth = c * 0.085, wd = c * 0.045, x0 = 0.5, x1 = 1.3, xh = 0.9;
        const body = (u, v, out) => {
          const xc = lerp(x0, x1, u), base = lowY(Math.min(xc, 0.999)), yb = base.y + (xc > 1 ? (xc - 1) * c * 0.1 : 0);
          const prof = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.05)), 0.55) * (1 - 0.35 * u), a2 = v * Math.PI * 2;
          const hh = depth * prof, ww = wd * Math.pow(Math.sin(Math.PI * Math.min(1, 0.05 + u)), 0.4);
          const x = fr.lx + fr.cd.x * xc * c;
          return out.set(x, yb + 0.06 - hh * 0.5 + Math.cos(a2) * (hh * 0.5 + 0.06), y + Math.sin(a2) * ww);
        };
        const uH = (xh - x0) / (x1 - x0);
        mb.mirror = side < 0;
        const fb = ws.flex ? ws.flex.bones[Math.max(0, ws.flex.ys.findIndex(v2 => v2 > y) - 1)] : 0;
        const uvz = (u, v, i, j, p) => [0.02, 0.49, p.x, p.y];
        mb.bind(fb); mb.surface(G.linSpace(0, uH, Math.ceil(nu * uH)), G.linSpace(0, 1, nv), body, { eu: 1e-4, ev: 1e-4, uv: uvz });
        mb.bind(flap.bone); mb.surface(G.linSpace(uH, 1, Math.ceil(nu * (1 - uH)) + 1), G.linSpace(0, 1, nv), body, { eu: 1e-4, ev: 1e-4, uv: uvz });
        mb.mirror = false; mb.bind(0);
      }
    }
  }
  // dorsal fin fillet ahead of the fin root, and the fin's tip cap
  function finDetails(vt, fs, ctx) {
    if (!vt.dorsal) return;
    const G = ACGeo, mb = ctx.B.mb('fin'), H = ctx.H, x0 = vt.x + vt.dorsal, x1 = vt.x - vt.c0 * 0.05, hTop = vt.h * 0.22, rootY = -vt.z;
    mb.bind(0);
    const crownAt = (x) => { const p = new V3(); H.pt(clamp(H.nose - x, 0, H.L), 0, p); return p.y; };
    const P2 = (u, v, out) => {
      const x = lerp(x0, x1, u), top = rootY + hTop * Math.pow(u, 1.4) + (u > 0.95 ? 0 : 0), base = crownAt(x) - 0.08, hgt = Math.max(0.01, top - base);
      const a = v * Math.PI * 2, wd = (vt.t * vt.c0 * 0.35) * Math.pow(Math.sin(Math.PI * Math.min(1, 0.02 + u * 0.98)), 0.3) * Math.min(1, u * 6 + 0.05);
      return out.set(x - (1 - Math.cos(a)) * 0.0, base + hgt * (0.5 + 0.5 * Math.cos(a)), Math.sin(a) * wd * Math.pow(Math.abs(Math.sin(a)), 0) * (0.5 + 0.5 * Math.cos(a) * 0 + 0.5));
    };
    mb.surface(G.linSpace(0, 1, [4, 6, 8, 10, 12][ctx.q]), G.linSpace(0, 1, 12), P2, { eu: 1e-4, ev: 1e-4, uv: (u, v, i, j, p) => ctx.uv(p, Math.sin(v * Math.PI * 2) >= 0) });
  }

  return { hull, buildHull, surface, wingDetails, finDetails, NOSES, TAILS, TIPS, paint, grow, mirrorPoly };
})();
