// ACCockpit: cockpit interiors for the procedural aircraft, per style: 'airbus' (sidesticks, six displays, the FCU),
// 'boeing' (yokes, the MCP), 'ga' (a six-pack panel, yokes, throttle and mixture), 'fighter' (a canopy, side-stick,
// HUD glass), 'heli' (the H125: cyclic, collective, the central console). The shell is the fuselage from inside with
// the window panes cut out exactly and given depth; the displays show the live instrument canvas that 49_fhud.js
// draws (m.panel: 1024 x 384, three 318 x 352 displays) and the autopilot panel (m.fcu, 1024 x 96); an engine
// display is drawn here. Levers, sticks, yokes and pedals move with the controls. Built with ACGeo into batches
// ('cabin', 'screens', 'fcu', 'panels') that 48_acmodel.js turns into skinned meshes shown only from inside.
//   const c = ACCockpit.build(type, ctx, env)  -> { group, panel, fcu, materials(T), attach(root, meshes), update(ac, dt, st), dispose() }
const ACCockpit = (() => {
  const V3 = THREE.Vector3, Q4 = THREE.Quaternion, D = Math.PI / 180;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const mat4 = (p, q, s) => new THREE.Matrix4().compose(p || new V3(), q || new Q4(), s || new V3(1, 1, 1));
  const X1 = new V3(1, 0, 0), Y1 = new V3(0, 1, 0), Z1 = new V3(0, 0, 1);
  const STYLE = { airbus: 'airbus', boeing: 'boeing', ga: 'ga', fighter: 'fighter', heli: 'heli' };

  // ---------------------------------------------------------------- panel textures (overhead, pedestal, consoles)
  // one atlas per style: grey panels ruled into modules with push-buttons, toggles, knobs and labels; the emissive
  // twin lights the labels at night
  const atlases = {};
  function panelAtlas(style, q) {
    const key = style + q; if (atlases[key]) return atlases[key];
    // (drawn at 1024 and scaled: 512 below 'high', the emissive twin at half size)
    const S = 1024, c = document.createElement('canvas'), e = document.createElement('canvas'); c.width = c.height = e.width = e.height = S;
    const g = c.getContext('2d'), ge = e.getContext('2d');
    const base = style === 'airbus' ? '#5d6a74' : style === 'boeing' ? '#40454b' : '#2c2e31';
    g.fillStyle = base; g.fillRect(0, 0, S, S); ge.fillStyle = '#000'; ge.fillRect(0, 0, S, S);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const module = (x, y, w, h) => {
      g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x, y, w, 2); g.fillRect(x, y, 2, h); g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(x, y + h - 2, w, 2); g.fillRect(x + w - 2, y, 2, h);
      const n = Math.max(1, Math.floor(w / 46));
      for (let r = 0; r < Math.floor(h / 52); r++) for (let k = 0; k < n; k++) {
        const bx = x + 10 + k * (w - 20) / n, by = y + 14 + r * 52, t = rnd();
        g.fillStyle = '#e8e8e2'; g.font = '600 9px "IBM Plex Mono", monospace'; g.fillText(['FUEL', 'HYD', 'ELEC', 'BLEED', 'PACK', 'APU', 'ENG', 'ANTI', 'WIPER', 'LT'][Math.floor(t * 10)], bx, by);
        ge.fillStyle = '#ffd9a0'; ge.font = g.font; ge.fillText(['FUEL', 'HYD', 'ELEC', 'BLEED', 'PACK', 'APU', 'ENG', 'ANTI', 'WIPER', 'LT'][Math.floor(t * 10)], bx, by);
        if (t < 0.45) { g.fillStyle = '#1a1b1d'; g.fillRect(bx, by + 5, 30, 22); g.fillStyle = t < 0.15 ? '#3fbf6a' : t < 0.3 ? '#e7e3d4' : '#b58a2a'; g.fillRect(bx + 3, by + 9, 24, 6); ge.fillStyle = g.fillStyle; ge.globalAlpha = 0.6; ge.fillRect(bx + 3, by + 9, 24, 6); ge.globalAlpha = 1; }
        else if (t < 0.8) { g.fillStyle = '#16171a'; g.beginPath(); g.arc(bx + 12, by + 16, 9, 0, 7); g.fill(); g.fillStyle = '#d9d9d4'; g.fillRect(bx + 11, by + 8, 2, 8); }
        else { g.fillStyle = '#bfc3c7'; g.fillRect(bx + 9, by + 6, 6, 18); g.fillStyle = '#1a1b1d'; g.fillRect(bx + 7, by + 20, 10, 6); }
      }
    };
    // overhead (top half), pedestal (bottom left), side consoles and GA panel (bottom right)
    for (let y = 8; y < 500; y += 124) for (let x = 8; x < S - 8; x += 204) module(x, y, 196, 118);
    for (let y = 520; y < S - 8; y += 124) for (let x = 8; x < 500; x += 244) module(x, y, 236, 118);
    g.fillStyle = '#26282b'; g.fillRect(512, 512, 512, 512);
    for (let y = 530; y < S - 8; y += 124) for (let x = 520; x < S - 8; x += 250) module(x, y, 242, 118);
    const scaled = (src, n) => { if (n === src.width) return src; const d = document.createElement('canvas'); d.width = d.height = n; d.getContext('2d').drawImage(src, 0, 0, n, n); return d; };
    const t = new THREE.CanvasTexture(scaled(c, q >= 2 ? 1024 : 512)), te = new THREE.CanvasTexture(scaled(e, q >= 2 ? 512 : 256));
    for (const x of [t, te]) { x.colorSpace = THREE.SRGBColorSpace; x.anisotropy = 8; x.flipY = false; }
    atlases[key] = { map: t, emis: te };
    t.userData.shared = te.userData.shared = true;
    return atlases[key];
  }

  // ---------------------------------------------------------------- the shell
  // the fuselage from inside around the cockpit: the surface between s0 and s1 minus the window panes (convex
  // polygons in (s, th)), offset inward by 'wall', normals inward; jambs give the openings their depth
  function shell(H, mb, s0, s1, panes, wall, q, uvFn) {
    const G = ACGeo, ns = Math.max(6, Math.ceil((s1 - s0) / [0.3, 0.2, 0.12, 0.1, 0.07][q])), nt = [24, 32, 48, 64, 80][q];
    const p = new V3(), a = new V3(), b = new V3(), n = new V3();
    const put = (s, th, off) => {
      H.pt(s, th, p); H.pt(s + 1e-3, th, a); H.pt(s - 1e-3, th, b); const ds = a.clone().sub(b); H.pt(s, th + 1e-3, a); H.pt(s, th - 1e-3, b);
      n.crossVectors(ds, a.sub(b)).normalize();
      const o = p.clone().addScaledVector(n, -off), t = uvFn(s, th);
      return mb.v(o.x, o.y, o.z, -n.x, -n.y, -n.z, t[0], t[1]);
    };
    const f0 = mb.flip; mb.flip = !mb.flip;          // (inward)
    for (let i = 0; i < ns; i++) for (let j = 0; j < nt; j++) {
      const sa = s0 + (s1 - s0) * i / ns, sb = s0 + (s1 - s0) * (i + 1) / ns, ta = Math.PI * 2 * j / nt, tb = Math.PI * 2 * (j + 1) / nt;
      let pieces = [[[sa, ta], [sb, ta], [sb, tb], [sa, tb]]];
      for (const P of panes) pieces = pieces.flatMap(pc => G.clipOut(pc, P));
      for (const pc of pieces) { const ids = pc.map(([s, th]) => put(s, th, wall)); for (let k = 1; k + 1 < ids.length; k++) mb.tri(ids[0], ids[k], ids[k + 1]); }
    }
    mb.flip = f0;
    // jambs: along every pane edge, from the skin to the inner face
    for (const P of panes) {
      const m2 = P.length;
      for (let k = 0; k < m2; k++) {
        const A = P[k], Bp = P[(k + 1) % m2], steps = Math.max(1, Math.ceil(Math.hypot(Bp[0] - A[0], (Bp[1] - A[1]) * 2) / 0.08));
        for (let i = 0; i < steps; i++) {
          const u0 = i / steps, u1 = (i + 1) / steps, s_0 = lerp(A[0], Bp[0], u0), t_0 = lerp(A[1], Bp[1], u0), s_1 = lerp(A[0], Bp[0], u1), t_1 = lerp(A[1], Bp[1], u1);
          const i0 = put(s_0, t_0, 0.005), i1 = put(s_1, t_1, 0.005), i2 = put(s_1, t_1, wall), i3 = put(s_0, t_0, wall);
          mb.quad(i0, i3, i2, i1); mb.quad(i0, i1, i2, i3);     // (both faces: the jamb is seen from either side of the opening)
        }
      }
    }
  }

  // ---------------------------------------------------------------- the engine / systems display (drawn here)
  function ewdCanvas() { const c = document.createElement('canvas'); c.width = c.height = 256; const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.flipY = false; return { c, t, g: c.getContext('2d') }; }
  function drawEWD(E, ac, type) {
    const g = E.g, n = ac.eng.length;
    g.fillStyle = '#05070a'; g.fillRect(0, 0, 256, 256);
    const cols = Math.min(n, 4), w = 256 / Math.max(2, cols);
    ac.eng.forEach((e, i) => {
      const cx = w * (i + 0.5) + (cols < 2 ? 64 : 0), cy = 70, r = Math.min(46, w * 0.42), v = clamp(e.n || 0, 0, 1.1);
      g.strokeStyle = '#d9dde0'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, r, Math.PI * 0.8, Math.PI * 2.2); g.stroke();
      g.strokeStyle = v > 1.0 ? '#ff5a3c' : '#34d27a'; g.lineWidth = 4; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(Math.PI * (0.8 + 1.4 * v / 1.1)) * r, cy + Math.sin(Math.PI * (0.8 + 1.4 * v / 1.1)) * r); g.stroke();
      g.fillStyle = '#34d27a'; g.font = '700 18px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.fillText((v * 100).toFixed(1), cx, cy + r + 18);
    });
    g.fillStyle = '#8fd0ff'; g.font = '600 15px "IBM Plex Mono", monospace'; g.textAlign = 'left';
    const f = type.fdm, fl = f.flaps[Math.round(clamp(ac.flapPos, 0, f.flaps.length - 1))];
    g.fillText('FLAP ' + (fl ? fl.label : '-'), 12, 170);
    g.fillText('GEAR ' + (ac.gearPos > 0.99 ? 'DN' : ac.gearPos < 0.01 ? 'UP' : 'TRANSIT'), 12, 192);
    g.fillStyle = ac.gearPos > 0.99 ? '#34d27a' : ac.gearPos < 0.01 ? '#5d6670' : '#ff5a3c';
    for (let k = 0; k < 3; k++) g.fillRect(150 + k * 32, 178, 26, 18);
    g.fillStyle = '#d9dde0'; g.fillText('SPD BRK ' + Math.round((ac.spoilerPos || 0) * 100) + '%', 12, 216);
    g.fillText('TRIM ' + ((ac.ctl.trim || 0) * 10).toFixed(1), 12, 238);
    E.t.needsUpdate = true;
  }

  // ---------------------------------------------------------------- build
  function build(type, ctx, env) {
    const m = type.model, H = ctx.H, q = ctx.q, pal = ctx.pal, B = ctx.B, rig = ctx.rig;
    const style = STYLE[m.cockpit.style] || (m.kind === 'ga' ? 'ga' : 'boeing');
    const E = H.eye.clone(), sE = m.nose - E.x;
    const cab = B.mb('cabin'), scr = B.mb('screens'), fcuB = B.mb('fcu'), pan = B.mb('panels');
    const group = new THREE.Group(); group.name = 'cockpit'; group.visible = false;
    // the instrument canvas (drawn by 49_fhud.js) and the autopilot panel
    const panelC = document.createElement('canvas'); panelC.width = 1024; panelC.height = 384;
    const panelT = new THREE.CanvasTexture(panelC); panelT.colorSpace = THREE.SRGBColorSpace; panelT.anisotropy = 8; panelT.flipY = false;
    let fcu = null;
    const ewd = ewdCanvas();
    const bones = {};
    const PA = panelAtlas(style, q);
    // UV helpers: a display region of the panel canvas (k = 0, 1, 2), an atlas region of the panels texture
    const reg = (k) => { const x0 = [18, 356, 684][k] / 1024, y0 = 16 / 384, w = 318 / 1024, h = 352 / 384; return (u, v) => [x0 + w * u, y0 + h * v]; };
    const area = (x0, y0, w, h) => (u, v) => [x0 + w * u, y0 + h * v];
    // a flat quad (panel face) centred at c, spanning ex (u) and ey (v), facing n, with uv mapping fn
    const quad = (mb, c, ex, ey, uvf) => {
      const n = new V3().crossVectors(ex, ey).normalize();
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => { const p = c.clone().addScaledVector(ex, a).addScaledVector(ey, b); const t = uvf((a + 1) / 2, (1 - b) / 2); return mb.v(p.x, p.y, p.z, n.x, n.y, n.z, t[0], t[1]); });
      mb.quad(pts[0], pts[1], pts[2], pts[3]);
    };
    const box = (mb, sw, c, sx, sy, sz, rot) => { mb.pal = pal(sw); if (rot) mb.at(mat4(c, rot), () => mb.box(0, 0, 0, sx, sy, sz)); else mb.box(c.x, c.y, c.z, sx, sy, sz); mb.pal = null; };
    // cockpit width at a station and height (the inner shell)
    const halfW = (s, y) => { const th = H.thAt(s, y), p = new V3(); H.pt(s, th, p); return Math.abs(p.z) - 0.06; };
    cab.bind(0); scr.bind(0); pan.bind(0); fcuB.bind(0);

    // ---- the shell with the windows cut out (jets: the nose panes; others: panes from their view angles)
    const panes = (H.paneGlass || []).slice().concat(H.openings || []);
    // (the shell starts ahead of every window, so its closing bulkhead never shows through one)
    const paneS = panes.length ? Math.min(...panes.map(P => Math.min(...P.map(p => p[0])))) : sE;
    const shellS0 = Math.max(0.05, Math.min(sE - (style === 'fighter' ? 1.6 : 2.2), paneS - 0.5)), shellS1 = sE + (style === 'ga' || style === 'heli' ? 1.2 : style === 'fighter' ? 1.0 : 1.6);
    {
      {
        cab.pal = pal(style === 'airbus' ? 'cabinWall' : style === 'boeing' ? 'cabinWall' : style === 'fighter' ? 'panelBoeing' : 'tan');
        const wall = style === 'ga' || style === 'heli' || style === 'fighter' ? 0.03 : 0.06;
        shell(H, cab, shellS0, shellS1, panes, wall, q, () => cab.pal);
        // a bulkhead closing the shell's front (the nose ahead of the cockpit), facing aft
        if (shellS0 > 0.05) {
          cab.pal = pal('black');
          const n = 32, c0 = H.sec(shellS0), ctr = new V3(m.nose - shellS0, c0.yc, 0), p = new V3(), nn = new V3(-1, 0, 0);
          const ids = []; for (let k = 0; k <= n; k++) { H.pt(shellS0, Math.PI * 2 * k / n, p); const d = p.clone().sub(ctr); p.addScaledVector(d.normalize(), -wall); ids.push(cab.v(p.x, p.y, p.z, nn.x, nn.y, nn.z)); }
          const ci = cab.v(ctr.x, ctr.y, ctr.z, nn.x, nn.y, nn.z);          // (dark: only ever glimpsed)
          for (let k = 0; k < n; k++) cab.tri(ci, ids[k + 1], ids[k]);
        }
        cab.pal = null;
        // the rear wall (a door in the middle) and the floor
        // (the rear wall reaches from the floor to the roof, or to the rails under a canopy)
        const sq = H.sec(shellS1), floorY = E.y - (style === 'ga' ? 0.95 : style === 'fighter' ? 0.75 : 1.12), rp = new V3(); H.pt(shellS1, 0.95, rp);
        const wallTop = H.canopy ? rp.y : sq.yc + sq.up + (sq.lobe || 0), wallH = Math.max(0.3, wallTop - floorY);
        const rb = new V3(m.nose - shellS1 + 0.02, floorY + wallH / 2, 0), hw = halfW(shellS1, floorY + wallH * 0.5);
        box(cab, 'cabinWall', rb, 0.04, wallH, hw * 2 + 0.1);
        if (m.kind === 'jet') { box(cab, 'plastic', rb.clone().add(new V3(0.03, -0.2, 0)), 0.02, 1.9, 0.8); box(cab, 'lever', rb.clone().add(new V3(0.05, -0.25, 0.3)), 0.03, 0.03, 0.12); }
        const fl = new V3(m.nose - (shellS0 + shellS1) / 2, E.y - (style === 'ga' ? 0.95 : style === 'fighter' ? 0.75 : 1.12), 0);
        box(cab, 'carpet', fl, shellS1 - shellS0, 0.03, Math.max(style === 'fighter' ? 0.6 : 1.2, halfW(sE, fl.y + 0.1) * 2 + 0.2));
      }
      // pane glass seen from inside: handled by 48_acmodel (the exterior glass turns into a faint reflection)
    }
    env.cockpitPanes = panes;
    // ---- per style
    const L = { thr: [], sticks: [], yokes: [], pedals: [], flap: null, spd: null, coll: null };
    if (m.kind === 'jet' && (style === 'airbus' || style === 'boeing')) airliner(style);
    else if (style === 'ga') light();
    else if (style === 'fighter') fighter();
    else if (style === 'heli') heli();

    function airliner(st) {
      const airbus = st === 'airbus', panelCol = airbus ? 'panelAirbus' : 'panelBoeing';
      // glare shield: a padded shelf from the windscreen base (about 20 degrees below the eye) back toward the
      // pilots, the FCU / MCP on its face; the main panel below it, tilted back, six displays
      // (the shelf's front edge meets the windscreen's base: the higher of the front pane's two lowest corners, so
      // the eye never looks down past it into the nose)
      let gxF = E.x + 1.02, gyF = E.y - 0.36;
      if (H.panes && H.panes[0]) {        // (the front pane's lower edge: the edge lowest on average; its higher end)
        const cs = H.panes[0].poly.map(([ps, pt]) => { const p = new V3(); H.pt(ps, pt, p); return p; });
        let best = 0; for (let k = 1; k < cs.length; k++) if (cs[k].y + cs[(k + 1) % cs.length].y < cs[best].y + cs[(best + 1) % cs.length].y) best = k;
        const e0 = cs[best], e1 = cs[(best + 1) % cs.length], lo = e0.y > e1.y ? e0 : e1;
        gxF = Math.min(lo.x - 0.02, E.x + 1.4); gyF = Math.min(lo.y - 0.01, E.y - 0.12);
      }
      // (its aft edge ~22 degrees below the eye line; the displays start under its lip, 30-40 degrees down)
      const gx = Math.min(E.x + 0.72, gxF - 0.25), gy = Math.max(E.y - 0.3, gyF - 0.02) > E.y - 0.22 ? gyF - 0.02 : Math.max(E.y - 0.3, gyF - 0.02), wHalf = Math.min(halfW(m.nose - gx, gy) - 0.03, 1.25);
      const shelf = (y0, y1, x0, x1, w2) => {
        const a2 = cab.v(x0, y0, -w2, 0, 1, 0), b2 = cab.v(x0, y0, w2, 0, 1, 0), c2 = cab.v(x1, y1, w2, 0, 1, 0), d2 = cab.v(x1, y1, -w2, 0, 1, 0);
        cab.quad(a2, b2, c2, d2);
      };
      cab.pal = pal('glareshield');
      shelf(gy, gyF, gx, gxF, wHalf); shelf(gyF, gyF - 0.02, gxF, gxF + 1.1, wHalf);      // (on into the nose, under the windscreen)
      cab.box(gx - 0.005, gy - 0.06, 0, 0.012, 0.12, wHalf * 2);                 // the face under the lip
      cab.pal = null;
      const fc = document.createElement('canvas'); fc.width = 1024; fc.height = 96; const ft = new THREE.CanvasTexture(fc); ft.colorSpace = THREE.SRGBColorSpace; ft.anisotropy = 8; ft.flipY = false;
      fcu = { canvas: fc, tex: ft };
      const fw = Math.min(0.6, wHalf * 0.55);
      quad(fcuB, new V3(gx - 0.013, gy - 0.055, 0), new V3(0, 0, fw), new V3(0, fw * 96 / 1024, 0), area(0, 0, 1, 1));
      const tilt = new Q4().setFromAxisAngle(Z1, 14 * D), py = gy - 0.34, px = gx + 0.08;
      const face = (y, z, w, h) => { const c = new V3(px, y, z), ex = new V3(0, 0, w / 2), ey = new V3(0, h / 2, 0).applyQuaternion(tilt); return { c, ex, ey }; };
      cab.pal = pal(panelCol); cab.at(mat4(new V3(px + 0.035, py, 0), tilt), () => cab.box(0, 0, 0, 0.05, 0.62, wHalf * 2)); cab.pal = null;
      const du = 0.2, gap = 0.035, zc = Math.abs(E.z);
      const scrs = [[-zc - du / 2 - gap / 2, reg(0)], [-zc + du / 2 + gap / 2, reg(1)], [zc - du / 2 - gap / 2, reg(1)], [zc + du / 2 + gap / 2, reg(0)]];
      for (const [z, uvf] of scrs) { const F2 = face(py + 0.08, z, du, du); quad(scr, F2.c.clone().add(new V3(-0.018, 0, 0)), F2.ex, F2.ey, uvf); box(cab, 'black', F2.c.clone().add(new V3(-0.002, 0, 0)), 0.02, du + 0.04, du + 0.04, tilt); }
      // centre: the engine display (drawn here)
      const Fc = face(py + 0.08, 0, du, du); quad(B.mb('ewd'), Fc.c.clone().add(new V3(-0.018, 0, 0)), Fc.ex, Fc.ey, (u, v) => [u, v]); B.mb('ewd').bind(0);
      box(cab, 'black', Fc.c.clone().add(new V3(-0.002, 0, 0)), 0.02, du + 0.04, du + 0.04, tilt);
      env.ewdMesh = true;
      // standby instruments beside the centre display
      box(cab, 'black', new V3(px - 0.012, py - 0.12, du * 0.9), 0.02, 0.08, 0.08, tilt);
      // pedestal: thrust levers, speed brake, flaps; MCDUs and radios on the aft part (panel texture)
      const pdY = py - 0.3, pdX0 = px - 0.1, pdX1 = E.x - 0.55, pw = 0.46;
      cab.pal = pal(panelCol);
      cab.at(mat4(new V3((pdX0 + pdX1) / 2, pdY - 0.25, 0)), () => cab.box(0, 0, 0, pdX0 - pdX1, 0.5, pw));
      cab.pal = null;
      quad(pan, new V3((pdX0 + pdX1) / 2, pdY + 0.002, 0), new V3(0, 0, pw / 2), new V3((pdX0 - pdX1) / 2, 0, 0), area(0.02, 0.52, 0.45, 0.46));
      // thrust levers (a quadrant, one per engine)
      const nE = type.fdm.engines.length, qx = lerp(pdX0, pdX1, 0.3), qy = pdY + 0.01;
      for (let k = 0; k < nE; k++) {
        const z = (k - (nE - 1) / 2) * 0.07, b = rig.add(0, qx, qy, z);
        cab.bind(b); cab.pal = pal('leverBlack'); cab.cyl(new V3(qx, qy, z), new V3(qx + 0.04, qy + 0.2, z), 0.012, 0.012, 8, false);
        cab.pal = pal(airbus ? 'plastic' : 'lever'); cab.box(qx + 0.045, qy + 0.21, z, 0.05, 0.04, 0.05);
        cab.pal = null; L.thr.push({ bone: b, k });
      }
      cab.bind(0);
      // flap lever (right) and speed brake (left)
      const fb = rig.add(0, lerp(pdX0, pdX1, 0.55), qy, pw * 0.36);
      cab.bind(fb); cab.pal = pal('lever'); cab.cyl(new V3(lerp(pdX0, pdX1, 0.55), qy, pw * 0.36), new V3(lerp(pdX0, pdX1, 0.55), qy + 0.14, pw * 0.36), 0.008, 0.008, 6, false); cab.box(lerp(pdX0, pdX1, 0.55), qy + 0.15, pw * 0.36, 0.05, 0.03, 0.05); L.flap = fb;
      const sb = rig.add(0, lerp(pdX0, pdX1, 0.4), qy, -pw * 0.38);
      cab.bind(sb); cab.pal = pal('plastic'); cab.cyl(new V3(lerp(pdX0, pdX1, 0.4), qy, -pw * 0.38), new V3(lerp(pdX0, pdX1, 0.4), qy + 0.12, -pw * 0.38), 0.008, 0.008, 6, false); cab.box(lerp(pdX0, pdX1, 0.4), qy + 0.13, -pw * 0.38, 0.06, 0.02, 0.04); L.spd = sb;
      cab.bind(0); cab.pal = null;
      // overhead panel: sloping up and back from the windscreen header
      const oh0 = new V3(E.x + 0.45, E.y + 0.34, 0), oh1 = new V3(E.x - 0.55, E.y + 0.62, 0), ohW = Math.min(0.62, halfW(m.nose - oh0.x, oh0.y) * 0.8);
      const ohC = oh0.clone().lerp(oh1, 0.5), ohE = oh1.clone().sub(oh0).multiplyScalar(0.5);
      quad(pan, ohC, new V3(0, 0, ohW), ohE, area(0.01, 0.01, 0.98, 0.47));
      box(cab, panelCol, ohC.clone().add(new V3(0, 0.03, 0)), ohE.length() * 2 + 0.06, 0.04, ohW * 2 + 0.06, new Q4().setFromUnitVectors(X1, ohE.clone().normalize().negate()));
      // side consoles with the sidesticks (Airbus) or control columns with yokes (Boeing), rudder pedals, seats
      for (const sd of [-1, 1]) {
        const z = sd * zc, seatX = E.x - 0.42;
        if (airbus) {
          const cz = sd * (zc + 0.42), cy = E.y - 0.62;
          box(cab, panelCol, new V3(E.x + 0.05, cy - 0.12, cz), 0.8, 0.25, 0.22);
          quad(pan, new V3(E.x + 0.05, cy + 0.006, cz), new V3(0, 0, 0.11), new V3(0.4, 0, 0), area(0.51, 0.52, 0.48, 0.2));
          const b = rig.add(0, E.x + 0.15, cy + 0.01, cz);
          cab.bind(b); cab.pal = pal('knob'); cab.cyl(new V3(E.x + 0.15, cy + 0.01, cz), new V3(E.x + 0.17, cy + 0.2, cz), 0.018, 0.022, 10, true);
          cab.box(E.x + 0.18, cy + 0.2, cz, 0.05, 0.03, 0.035); cab.pal = null; cab.bind(0);
          L.sticks.push({ bone: b, side: sd });
        } else {
          const cx = E.x + 0.5, cy0 = E.y - 1.1, cy1 = E.y - 0.36, b = rig.add(0, cx, cy0, z);
          cab.bind(b); cab.pal = pal('panelBoeing'); cab.cyl(new V3(cx, cy0, z), new V3(cx - 0.02, cy1, z), 0.03, 0.028, 10, true);
          const yb = rig.add(b, cx - 0.04, cy1, z); cab.bind(yb); cab.pal = pal('yoke');
          cab.box(cx - 0.05, cy1, z, 0.04, 0.05, 0.3); for (const s2 of [-1, 1]) cab.box(cx - 0.05, cy1 + 0.07, z + s2 * 0.14, 0.035, 0.14, 0.035);
          cab.pal = null; cab.bind(0); L.yokes.push({ col: b, yoke: yb, side: sd });
        }
        for (const s2 of [-1, 1]) { const pb = rig.add(0, E.x + 0.85, E.y - 1.05, z + s2 * 0.11); cab.bind(pb); cab.pal = pal('black'); cab.box(E.x + 0.85, E.y - 0.98, z + s2 * 0.11, 0.04, 0.16, 0.08); cab.pal = null; cab.bind(0); L.pedals.push({ bone: pb, s: s2 }); }
        seat(new V3(seatX, E.y - 1.12, z), sd);
      }
      // windshield wipers (outside): parked along the lower edge of each front pane (the edge furthest forward on the
      // sloping nose), a little above it and proud of the glass
      const fp = (H.panes || [])[0];
      if (fp) {
        const pm = B.mb('parts'); pm.pal = pal('black'); pm.bind(0);
        const P0 = fp.poly, Y0 = P0.map(([ps, pt]) => { const p = new V3(); H.pt(ps, pt, p); return p.y; }); let best = 0, bs = 1e9;
        for (let k = 0; k < P0.length; k++) { const sm = Y0[k] + Y0[(k + 1) % P0.length]; if (sm < bs) { bs = sm; best = k; } }
        const e0 = P0[best], e1 = P0[(best + 1) % P0.length], inb = e0[1] < e1[1] ? e0 : e1, outb = e0[1] < e1[1] ? e1 : e0;
        for (const sd of [1, -1]) {
          const a2 = new V3(), b2 = new V3(), n2 = new V3(); H.pt(inb[0] + 0.06, inb[1] + 0.03, a2); H.pt(outb[0] + 0.06, outb[1] - 0.25 * (outb[1] - inb[1]), b2);
          n2.set(a2.x, a2.y - H.sec(m.nose - a2.x).yc, a2.z).setX(0).normalize().multiplyScalar(0.025);
          if (sd < 0) { a2.z = -a2.z; b2.z = -b2.z; n2.z = -n2.z; }
          pm.cyl(a2.clone().add(n2), b2.clone().add(n2), 0.011, 0.008, 6, true);
        }
        pm.pal = null;
      }
    }
    // a crew seat: padded cushion and back (rounded), a headrest, armrests on the aisle side, the pedestal base
    function seat(p, sd) {
      const n = [6, 8, 10, 12, 14][q];
      cab.pal = pal('seat');
      cab.rbox(p.x + 0.05, p.y + 0.45, p.z, 0.5, 0.13, 0.5, 6, n);                                          // cushion
      cab.at(mat4(p.clone().add(new V3(-0.2, 0.86, 0)), new Q4().setFromAxisAngle(Z1, 10 * D)), () => cab.rbox(0, 0, 0, 0.13, 0.74, 0.48, 6, n));   // back
      cab.at(mat4(p.clone().add(new V3(-0.26, 1.32, 0)), new Q4().setFromAxisAngle(Z1, 10 * D)), () => cab.rbox(0, 0, 0, 0.11, 0.22, 0.3, 5, n));   // headrest
      for (const s2 of [-1, 1]) cab.rbox(p.x, p.y + 0.62, p.z + s2 * 0.27, 0.38, 0.05, 0.06, 4, n);
      cab.pal = pal('darkMetal'); cab.rbox(p.x, p.y + 0.2, p.z, 0.3, 0.4, 0.22, 8, n); cab.pal = null;
    }
    function light() {
      // a GA panel: the canvas is the panel face (gauges and the moving map), yokes, throttle / mixture, seats
      const px = E.x + 0.62, py = E.y - 0.34, wHalf = Math.min(halfW(m.nose - px, py) - 0.02, 0.7);
      const tilt = new Q4().setFromAxisAngle(Z1, 8 * D);
      cab.pal = pal('gaPanel'); cab.at(mat4(new V3(px + 0.03, py, 0), tilt), () => cab.box(0, 0, 0, 0.06, 0.42, wHalf * 2)); cab.pal = null;
      box(cab, 'glareshield', new V3(px + 0.02, py + 0.23, 0), 0.22, 0.04, wHalf * 2);
      const ww = Math.min(1.0, wHalf * 1.6);
      quad(scr, new V3(px - 0.012, py, 0), new V3(0, 0, ww / 2), new V3(0, ww / 2 * 0.375, 0).applyQuaternion(tilt), area(0, 0, 1, 1));
      for (const sd of [-1, 1]) {
        const z = sd * Math.max(0.25, Math.abs(E.z)), b = rig.add(0, px - 0.02, py - 0.05, z);
        cab.bind(b); cab.pal = pal('yoke'); cab.cyl(new V3(px - 0.02, py - 0.05, z), new V3(px - 0.2, py - 0.05, z), 0.012, 0.012, 8, false);
        const yb = rig.add(b, px - 0.2, py - 0.05, z); cab.bind(yb); cab.box(px - 0.21, py - 0.05, z, 0.03, 0.04, 0.24); for (const s2 of [-1, 1]) cab.box(px - 0.21, py + 0.01, z + s2 * 0.11, 0.03, 0.11, 0.03);
        cab.pal = null; cab.bind(0); L.yokes.push({ col: b, yoke: yb, side: sd, push: true });
        seat(new V3(E.x - 0.35, E.y - 0.95, z), sd);
      }
      const tb = rig.add(0, px - 0.05, py - 0.17, 0); cab.bind(tb); cab.pal = pal('knob'); cab.cyl(new V3(px - 0.05, py - 0.17, -0.02), new V3(px - 0.13, py - 0.17, -0.02), 0.006, 0.006, 6, false); cab.box(px - 0.14, py - 0.17, -0.02, 0.02, 0.035, 0.035);
      cab.pal = pal('leverRed'); cab.box(px - 0.1, py - 0.17, 0.05, 0.02, 0.03, 0.03); cab.pal = null; cab.bind(0); L.thr.push({ bone: tb, k: 0, push: true });
    }
    // a pilot under a bubble canopy: helmet, visor, shoulders (on a bone scaled away in the cockpit view)
    function pilot() {
      const pb = rig.add(0, E.x, E.y, E.z), pm = B.mb('parts'); bones.pilot = pb;
      pm.bind(pb); pm.pal = pal('seat'); pm.box(E.x - 0.12, E.y - 0.42, E.z, 0.3, 0.5, 0.46);
      pm.pal = pal('base'); pm.at(mat4(new V3(E.x - 0.04, E.y + 0.03, E.z), null, new V3(1.05, 1, 0.9)), () => pm.lathe([[0.15, 0.001], [0.13, 0.08], [0.02, 0.14], [-0.1, 0.12], [-0.15, 0.001]], 12));
      pm.pal = pal('black'); pm.at(mat4(new V3(E.x + 0.07, E.y + 0.02, E.z), null, new V3(0.6, 0.55, 1)), () => pm.lathe([[0.08, 0.001], [0.07, 0.08], [0.02, 0.1], [-0.02, 0.001]], 12));
      pm.pal = null; pm.bind(0);
    }
    function fighter() {
      pilot();
      // cockpit tub, instrument panel with two displays, the HUD combiner, side-stick and throttle, the seat (all
      // inside the canopy's line: seen from outside through it)
      const px = E.x + 0.56, py = E.y - 0.44, jet = m.kind === 'fighter';
      box(cab, 'panelBoeing', new V3(px + 0.05, py, 0), 0.08, 0.3, 0.56);
      box(cab, 'glareshield', new V3(px + 0.02, py + 0.17, 0), 0.22, 0.035, 0.52);
      if (jet) {
        quad(scr, new V3(px, py - 0.02, -0.14), new V3(0, 0, 0.1), new V3(0, 0.1, 0), reg(0));
        quad(scr, new V3(px, py - 0.02, 0.14), new V3(0, 0, 0.1), new V3(0, 0.1, 0), reg(1));
      } else quad(scr, new V3(px, py - 0.01, 0), new V3(0, 0, 0.26), new V3(0, 0.26 * 0.375, 0), area(0, 0, 1, 1));   // (an aerobatic single: its gauges)
      for (const sd of [-1, 1]) box(cab, 'panelBoeing', new V3(E.x - 0.1, E.y - 0.5, sd * 0.33), 0.9, 0.08, 0.14);
      box(cab, 'seat', new V3(E.x - 0.42, E.y - 0.3, 0), 0.12, 0.72, 0.42); box(cab, 'leverRed', new V3(E.x - 0.2, E.y - 0.68, 0), 0.08, 0.1, 0.12);
      if (jet) { const hudP = new V3(px - 0.02, py + 0.28, 0), hg = B.mb('canopy'); hg.bind(0); hg.at(mat4(hudP, new Q4().setFromAxisAngle(Z1, -25 * D)), () => hg.box(0, 0, 0, 0.005, 0.14, 0.16)); }
      const sb = rig.add(0, E.x + 0.05, E.y - 0.47, 0.33); cab.bind(sb); cab.pal = pal('knob'); cab.cyl(new V3(E.x + 0.05, E.y - 0.47, 0.33), new V3(E.x + 0.07, E.y - 0.33, 0.33), 0.016, 0.02, 8, true); cab.pal = null; cab.bind(0); L.sticks.push({ bone: sb, side: 1 });
      const tb = rig.add(0, E.x - 0.05, E.y - 0.47, -0.33); cab.bind(tb); cab.pal = pal('knob'); cab.box(E.x - 0.05, E.y - 0.4, -0.33, 0.08, 0.12, 0.05); cab.pal = null; cab.bind(0); L.thr.push({ bone: tb, k: 0, slide: true });
    }
    function heli() {
      // the H125: a central console (engine display and the PFD), cyclic, collective, pedals, the seats
      const px = E.x + 0.72, py = E.y - 0.42, cz = E.z - 0.42;
      box(cab, 'gaPanel', new V3(px, py, cz), 0.1, 0.36, 0.5);
      box(cab, 'glareshield', new V3(px - 0.02, py + 0.2, cz), 0.25, 0.04, 0.55);
      quad(scr, new V3(px - 0.052, py, cz - 0.12), new V3(0, 0, 0.11), new V3(0, 0.12, 0), reg(2));
      quad(scr, new V3(px - 0.052, py, cz + 0.12), new V3(0, 0, 0.11), new V3(0, 0.12, 0), reg(0));
      const cb = rig.add(0, E.x + 0.25, E.y - 1.0, E.z); cab.bind(cb); cab.pal = pal('knob'); cab.cyl(new V3(E.x + 0.25, E.y - 1.0, E.z), new V3(E.x + 0.2, E.y - 0.45, E.z), 0.015, 0.015, 8, true); cab.box(E.x + 0.2, E.y - 0.42, E.z, 0.04, 0.08, 0.035); cab.pal = null; cab.bind(0);
      L.sticks.push({ bone: cb, side: 1, cyclic: true });
      const lb = rig.add(0, E.x - 0.25, E.y - 0.85, E.z - 0.3); cab.bind(lb); cab.pal = pal('knob'); cab.cyl(new V3(E.x - 0.25, E.y - 0.85, E.z - 0.3), new V3(E.x + 0.25, E.y - 0.72, E.z - 0.3), 0.015, 0.015, 8, true); cab.pal = null; cab.bind(0); L.coll = lb;
      for (const sd of [1, -1]) seat(new V3(E.x - 0.32, E.y - 1.02, sd * Math.abs(E.z)), sd);
    }
    cab.bind(0);

    // ---- materials (shown only from inside), animation
    // (made once the textures exist: the cabin shares the part palette)
    const materials = {};
    // (the interior fills the view: below 'ultra' it is lit with the cheaper Lambert model, which has no sky
    // reflections, so it is lifted with a little of its own colour as emissive)
    function makeMaterials(T) {
      const rich = q >= 3;
      Object.assign(materials, {
        cabin: rich ? new THREE.MeshStandardMaterial({ map: T.pal.map, roughnessMap: T.pal.orm, metalnessMap: T.pal.orm, roughness: 1, metalness: 1, envMapIntensity: H.canopy ? 0.8 : 0.35 })
          : new THREE.MeshLambertMaterial({ map: T.pal.map, emissiveMap: T.pal.map, emissive: 0xffffff, emissiveIntensity: H.canopy ? 0.12 : 0.07 }),
        screens: new THREE.MeshBasicMaterial({ map: panelT, toneMapped: false }),
        fcu: new THREE.MeshBasicMaterial({ map: fcu ? fcu.tex : null, toneMapped: false }),
        panels: rich ? new THREE.MeshStandardMaterial({ map: PA.map, emissiveMap: PA.emis, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.7, metalness: 0.05, envMapIntensity: 0.35 })
          : new THREE.MeshLambertMaterial({ map: PA.map, emissiveMap: PA.emis, emissive: 0xffffff, emissiveIntensity: 0 }),
      });
      if (!fcu) materials.fcu.visible = false;
      if (env.ewdMesh) materials.ewd = new THREE.MeshBasicMaterial({ map: ewd.t, toneMapped: false });
      return materials;
    }
    const inMeshes = [];
    function attach(root, meshes) {
      for (const me of meshes) if (['cabin', 'screens', 'fcu', 'panels', 'ewd'].includes(me.name)) { root.remove(me); group.add(me); inMeshes.push(me); me.castShadow = false; }
      root.add(group);
    }
    let ewdT = 0;
    function update(ac, dt, st) {
      group.visible = st.inside || !!H.canopy;              // (under a bubble canopy the cockpit shows from outside)
      if (bones.pilot) rig.bone(bones.pilot).scale.setScalar(st.inside ? 0.001 : 1);
      if (!group.visible) return;
      const s = ac.surf;
      for (const t of L.thr) { const b = rig.bone(t.bone), th = clamp(ac.ctl.thr, 0, 1.1), rev = ac.ctl.rev ? 1 : 0;
        if (t.push) { b.position.copy(b.userData.rest); b.position.x += th * 0.06; } else if (t.slide) { b.position.copy(b.userData.rest); b.position.x += th * 0.1; }
        else b.quaternion.setFromAxisAngle(Z1, (20 - 45 * th + rev * 16) * D); }
      if (L.flap) rig.bone(L.flap).quaternion.setFromAxisAngle(Z1, (-15 + 40 * clamp(ac.flapPos / Math.max(1, type.fdm.flaps.length - 1), 0, 1)) * D);
      if (L.spd) rig.bone(L.spd).quaternion.setFromAxisAngle(Z1, (-5 + 35 * (ac.spoilerPos || 0)) * D);
      for (const k of L.sticks) rig.bone(k.bone).quaternion.setFromEuler(new THREE.Euler(s.ail * 0.3, 0, s.elev * 0.25, 'XYZ'));
      for (const y of L.yokes) { const c = rig.bone(y.col); if (y.push) { c.position.copy(c.userData.rest); c.position.x -= s.elev * 0.07; } else c.quaternion.setFromAxisAngle(Z1, s.elev * 10 * D); rig.bone(y.yoke).quaternion.setFromAxisAngle(X1, s.ail * 60 * D); }
      for (const p of L.pedals) { const b = rig.bone(p.bone); b.position.copy(b.userData.rest); b.position.x += s.rud * 0.05 * p.s; }
      if (L.coll) rig.bone(L.coll).quaternion.setFromAxisAngle(Z1, ((ac.ctl.coll || 0.4) - 0.4) * 20 * D);
      if (materials.panels) materials.panels.emissiveIntensity = st.night * 0.8;
      if (env.ewdMesh) { ewdT -= dt; if (ewdT <= 0) { ewdT = 0.1; drawEWD(ewd, ac, type); } }
    }
    function dispose() { panelT.dispose(); if (fcu) fcu.tex.dispose(); ewd.t.dispose(); for (const k in materials) materials[k].dispose(); }
    return { group, panel: { canvas: panelC, tex: panelT, w: 1, h: 0.375 }, fcu, materials: makeMaterials, attach, update, dispose, style };
  }

  return { build, drawEWD };
})();
