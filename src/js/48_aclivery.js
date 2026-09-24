// ACLivery: the textures of the procedural aircraft, generated on canvases and cached per (type, quality):
//   the fuselage livery (albedo, roughness / metalness / clearcoat, night-lit cabin windows), the wing and fin
//   atlases, the nacelle map, the part palette (swatches of albedo + clearcoat / roughness / metalness that every
//   small part points its UVs at), and one shared tiling normal map of panel lines and rivet rows (sampled with
//   metre UVs, uv1, so the detail stays sharp up close on any size of aircraft).
// Every aircraft wears the fictional Bayline Air scheme: white over light grey, a navy / red cheatline sweeping up
// into the tail colour, the bay-wave emblem, BAYLINE AIR titles. No real airline or manufacturer marks.
//   const L = ACLivery.get(type, hull, q, planforms)  { fus, wing, fin, nac, pal, tile, uvBody, uvWing, uvFin, ... }
//   ACLivery.keep(type, q)     release every other type's textures (called when a new type is built)
//   ACLivery.pal(name)         [u, v] of a swatch;  ACLivery.color(name) its albedo (for the traffic models)
const ACLivery = (() => {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const cache = new Map();
  const FONT = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", sans-serif';
  const fontReady = () => { try { return !document.fonts || document.fonts.check('700 64px "Barlow Condensed"'); } catch (e) { return true; } };
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  function tex(c, srgb, o = {}) {
    const t = new THREE.CanvasTexture(c); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.flipY = false;
    t.anisotropy = o.aniso || 8; if (o.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
    if (o.nearest) { t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
    if (o.channel !== undefined) t.channel = o.channel;
    return t;
  }
  const rgb = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

  // ---------------------------------------------------------------- the part palette
  // name: [albedo, roughness, metalness, clearcoat]; the livery colours are filled in per type
  const SW = {
    base: [null, 0.36, 0, 1], tail: [null, 0.36, 0, 1], stripe: [null, 0.36, 0, 1], stripe2: [null, 0.36, 0, 1], belly: [null, 0.42, 0, 1],
    wingPaint: ['#d3d7dc', 0.44, 0.05, 0.6], gearPaint: ['#d7dadd', 0.46, 0.15, 0.35], gearGrey: ['#8a9097', 0.5, 0.35, 0],
    chrome: ['#e6e9ec', 0.06, 1, 0], alu: ['#c7ccd1', 0.2, 1, 0], aluDull: ['#a8adb2', 0.42, 0.9, 0], titanium: ['#8b9096', 0.28, 1, 0],
    darkMetal: ['#3f4348', 0.42, 0.8, 0], black: ['#0f1012', 0.55, 0, 0], frame: ['#141619', 0.4, 0, 0.5], rubber: ['#191a1b', 0.9, 0, 0],
    inlet: ['#2b2e32', 0.72, 0.25, 0], exhaust: ['#7a6e64', 0.48, 0.85, 0], exhaustDark: ['#2a2623', 0.68, 0.6, 0], brake: ['#303133', 0.66, 0.3, 0],
    hub: ['#8e949a', 0.36, 0.85, 0], wheelWell: ['#a9b0a6', 0.75, 0.05, 0], bayDark: ['#3a3d3a', 0.85, 0.05, 0],
    lensClear: ['#f4f7ff', 0.04, 0, 1], lensRed: ['#c8150c', 0.05, 0, 1], lensGreen: ['#0ea34a', 0.05, 0, 1], lensAmber: ['#e39a1c', 0.08, 0, 1],
    antenna: ['#2d3035', 0.5, 0.1, 0.3], radome: [null, 0.4, 0, 1], propBlack: ['#141516', 0.55, 0, 0.3], propTip: ['#f2c21b', 0.45, 0, 0.3],
    spinner: [null, 0.3, 0.1, 1], cascade: ['#1c1d1f', 0.7, 0.4, 0], fan: ['#7d838a', 0.24, 1, 0], fanDark: ['#26292d', 0.5, 0.6, 0],
    rotor: ['#23262a', 0.5, 0.1, 0.2], skid: ['#9aa0a6', 0.35, 0.85, 0], canopyFrame: ['#2e3238', 0.5, 0.2, 0.2], afterburner: ['#4a3b33', 0.5, 0.9, 0],
    // interiors
    cabinWall: ['#c9cdd1', 0.85, 0, 0], panelBoeing: ['#3d4146', 0.72, 0.05, 0], panelAirbus: ['#5a6771', 0.7, 0.05, 0], glareshield: ['#15171a', 0.92, 0, 0],
    seat: ['#27303d', 0.95, 0, 0], seatLeather: ['#2e2a27', 0.6, 0, 0.2], carpet: ['#2a2d31', 0.98, 0, 0], plastic: ['#9ea4ab', 0.6, 0, 0], knob: ['#0c0d0e', 0.4, 0, 0.4],
    lever: ['#d9dde1', 0.25, 0.9, 0], leverRed: ['#b3261e', 0.4, 0, 0.5], leverBlack: ['#1b1c1e', 0.4, 0, 0.3], screenOff: ['#07080a', 0.1, 0, 1], wood: ['#5b3b22', 0.5, 0, 0.6],
    gaPanel: ['#2a2b2d', 0.8, 0, 0], tan: ['#b9a88d', 0.9, 0, 0], yoke: ['#1f2023', 0.5, 0, 0.2], hudGlass: ['#7fb2a0', 0.05, 0, 1],
  };
  const NAMES = Object.keys(SW), PN = 16, PC = 4;          // 16 x 16 cells of 4 px
  const palUV = {}; NAMES.forEach((n, i) => { palUV[n] = [((i % PN) + 0.5) / PN, (Math.floor(i / PN) + 0.5) / PN]; });
  const pal = (name) => palUV[name] || palUV.base;
  const palName = (u, v) => NAMES[Math.min(NAMES.length - 1, Math.floor(v * PN) * PN + Math.floor(u * PN))] || 'base';
  function palette(lv) {
    const S = PN * PC, ca = canvas(S, S), co = canvas(S, S), ga = ca.getContext('2d'), go = co.getContext('2d');
    ga.fillStyle = '#808080'; ga.fillRect(0, 0, S, S); go.fillStyle = 'rgb(0,128,0)'; go.fillRect(0, 0, S, S);
    const liv = { base: lv.base, tail: lv.tail, stripe: lv.stripe, stripe2: lv.stripe2 || lv.stripe, belly: lv.belly || '#dfe2e6', radome: lv.radome || lv.base, spinner: lv.spinner || lv.stripe };
    NAMES.forEach((n, i) => {
      const [col, r, m, cc] = SW[n], x = (i % PN) * PC, y = Math.floor(i / PN) * PC;
      ga.fillStyle = col || liv[n] || '#ffffff'; ga.fillRect(x, y, PC, PC);
      go.fillStyle = `rgb(${Math.round(cc * 255)},${Math.round(r * 255)},${Math.round(m * 255)})`; go.fillRect(x, y, PC, PC);
    });
    return { map: tex(ca, true, { nearest: true }), orm: tex(co, false, { nearest: true }) };
  }
  const colorOf = (name, lv) => { const s = SW[name]; const liv = { base: lv.base, tail: lv.tail, stripe: lv.stripe, stripe2: lv.stripe2 || lv.stripe, belly: lv.belly || '#dfe2e6', radome: lv.base, spinner: lv.stripe }; return rgb((s && s[0]) || liv[name] || '#ffffff'); };

  // ---------------------------------------------------------------- the panel-line / rivet tile (shared)
  // A height field over 2 x 2 m: skin butt joints every 2 m, lap joints every metre, frame rivet rows every 0.5 m,
  // stringer rows every 0.25 m (faint); to a tangent-space normal map. One for every aircraft.
  const tiles = {};
  function tile(q) {
    const N = [0, 512, 1024, 1024, 2048][q]; if (!N) return null;
    if (tiles[N]) return tiles[N];
    const h = new Float32Array(N * N), k = N / 2;          // px per metre
    const line = (v, w) => Math.max(0, 1 - Math.abs(v) / w);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = i / k, y = j / k;      // metres in the tile
      const dxB = Math.min(x, 2 - x), dyL = Math.min(y % 1, 1 - (y % 1));
      let v = 0;
      v -= 0.9 * line(dxB * k, 1.3) + 0.7 * line(dyL * k, 1.1);               // joints: grooves
      const fx = (x % 0.5), dF = Math.min(fx, 0.5 - fx), ry = (y % 0.025) - 0.0125;
      const riv = (d) => Math.max(0, 1 - (d * k) * (d * k) / 2.2);
      v += 0.45 * riv(Math.hypot(dF, ry)) * (dF * k < 2.5 ? 1 : 0);          // frame rivets: domes
      const fy = (y % 0.25), dS = Math.min(fy, 0.25 - fy), rx = (x % 0.03) - 0.015;
      v += 0.22 * riv(Math.hypot(dS, rx)) * (dS * k < 2.5 ? 1 : 0);          // stringer rivets
      h[j * N + i] = v;
    }
    const c = canvas(N, N), g = c.getContext('2d'), img = g.createImageData(N, N), d = img.data, s = 2.2;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const hx = h[j * N + ((i + 1) % N)] - h[j * N + ((i + N - 1) % N)], hy = h[((j + 1) % N) * N + i] - h[((j + N - 1) % N) * N + i];
      let nx = -hx * s, ny = -hy * s, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const o = (j * N + i) * 4; d[o] = (nx * 0.5 + 0.5) * 255; d[o + 1] = (ny * 0.5 + 0.5) * 255; d[o + 2] = (nz * 0.5 + 0.5) * 255; d[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = tex(c, false, { repeat: true, channel: 1, aniso: 8 }); t.repeat.set(0.5, 0.5);      // (uv1 is in metres; one tile = 2 m)
    tiles[N] = t; t.userData.shared = true; return t;
  }

  // ---------------------------------------------------------------- the emblem: a disc with three bay waves
  function emblem(g, cx, cy, R, lv, o = {}) {
    g.save(); g.translate(cx, cy);
    g.fillStyle = o.disc || '#ffffff'; g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(0, 0, R * 0.9, 0, Math.PI * 2); g.clip();
    const cols = o.waves || [lv.stripe, lv.tail === lv.stripe ? '#2f6db3' : lv.tail, lv.stripe];
    for (let k = 0; k < 3; k++) {
      const y0 = R * (-0.18 + k * 0.36), amp = R * 0.13, th = R * (0.2 - k * 0.025);
      g.fillStyle = cols[k]; g.beginPath();
      for (let x = -R; x <= R; x += R / 24) g.lineTo(x, y0 + Math.sin(x / R * 3.1 + k * 0.9) * amp - th / 2);
      for (let x = R; x >= -R; x -= R / 24) g.lineTo(x, y0 + Math.sin(x / R * 3.1 + k * 0.9) * amp + th / 2);
      g.closePath(); g.fill();
    }
    g.restore();
  }

  // ---------------------------------------------------------------- the fuselage
  // Canvas layout (flipY off): rows 0 .. H/2 = the left side (crown at the top, keel at the middle), rows H/2 .. H =
  // the right side; x runs nose -> tail on the left side and tail -> nose on the right, so both read normally.
  // (a gutter of GUT rows between the two halves, filled with their edge rows: the left keel and the right crown
  // meet in the middle of the canvas, and filtering must not mix them)
  const GUT = 0.008, vOf = (th, right) => (right ? 0.5 + GUT : GUT) + (0.5 - 2 * GUT) * th / Math.PI;
  function uvBodyFor(H) {
    const L = H.L, P2 = Math.PI * 2;
    // (right: which half the vertex belongs to; on the keel and the crown lines both halves meet, and each must keep
    // its own side of the canvas)
    return (s, th, right) => ((right === undefined ? th <= Math.PI : right) ? [1 - s / L, vOf(Math.min(th, Math.PI), true)] : [s / L, vOf(Math.min(Math.PI, P2 - th), false)]);
  }
  function fillGutters(c) {
    const g = c.getContext('2d'), W = c.width, H = c.height, k = Math.max(1, Math.round(GUT * H));
    for (const [src, y0, y1] of [[k, 0, k], [H / 2 - k - 1, H / 2 - k, H / 2], [H / 2 + k, H / 2, H / 2 + k], [H - k - 1, H - k, H]])
      g.drawImage(c, 0, src, W, 1, 0, y0, W, y1 - y0);
  }
  // the livery's layout as heights along the fuselage (model y at station s): the canvas painter below and the
  // traffic models' vertex colours (colorAt) use the same design
  function scheme(type, H) {
    const m = type.model, F = m.fus, L = H.L, lv = m.livery, yc0 = H.yc0, Rh = H.Rh;
    if (H.kind === 'jet') {
      const NL = F.noseLen, TL = F.tailLen, wn = m.windows || {}, winY = -(wn.z || 0), wh = wn.h || 0.34, lineH = Math.max(0.1, F.h * 0.05);
      const sweep = (s) => { const s0 = L - TL * 1.25, u = clamp((s - s0) / (L - s0), 0, 1); return winY - wh * 1.35 + Rh * 1.25 * Math.pow(u, 1.6); };
      const bellyY = yc0 - Rh * 0.3, cl0 = NL * 0.55;
      const vt = m.vtail, sT0 = m.nose - vt.x - vt.c0 * 0.25;
      const tailBot = (s) => { const u = clamp((s - sT0) / (L - sT0), 0, 1); return H.crown - (H.crown - sweep(s) - lineH * 1.6) * Math.pow(u, 0.55) - 0.02; };
      const sW0 = wn.x0 !== undefined ? m.nose - wn.x0 : 1e9, sW1 = wn.x1 !== undefined ? m.nose - wn.x1 : -1e9;
      const colorAt = (s, y, near) => {
        if (s > sT0 && y > tailBot(s)) return lv.tail;
        if (s > cl0 + 0.6 && y < sweep(s) + lineH * 1.4 && y > sweep(s) + lineH * 0.55) return lv.tail;
        if (s > cl0 && y < sweep(s) && y > sweep(s) - lineH * 2.6) return lv.stripe;
        if (y < bellyY) return lv.belly || '#dfe2e6';
        if (near && s > sW0 && s < sW1 && Math.abs(y - winY) < wh * 0.42) return '#5a616a';
        return lv.base;
      };
      return { kind: 'jet', winY, wh, lineH, sweep, bellyY, cl0, sT0, tailBot, colorAt };
    }
    if (H.kind === 'ga' || H.kind === 'heli') {
      const colorAt = (s, y) => {
        if (H.kind === 'heli' && s < (F.pod || 4) + 1.5 && y > yc0 + F.h * 0.3) return lv.tail;
        if (s > 0.2 && s < L - 0.25 && y < yc0 - F.h * 0.02 && y > yc0 - F.h * 0.09) return lv.stripe;
        if (s > 0.3 && s < L - 0.35 && y < yc0 - F.h * 0.12 && y > yc0 - F.h * 0.155) return lv.stripe2 || lv.stripe;
        if (y < yc0 - F.h * 0.33) return lv.belly || '#e2e5e8';
        return lv.base;
      };
      return { kind: H.kind, colorAt };
    }
    return { kind: 'fighter', colorAt: (s, y) => (y > yc0 + 0.25 ? lv.tail : y < yc0 - 0.35 ? lv.belly : lv.base) };
  }
  function fuselage(type, H, q) {
    const m = type.model, lv = m.livery, L = H.L, kind = H.kind;
    const W = kind === 'jet' ? [2048, 2048, 4096, 4096, 8192][q] : [1024, 2048, 2048, 2048, 4096][q], Hc = W / 4, ppm = W / L;
    const ca = canvas(W, Hc), co = canvas(W / 2, Hc / 2), ce = canvas(W / 2, Hc / 2);
    const g = ca.getContext('2d'), go = co.getContext('2d'), ge = ce.getContext('2d');
    const bare = !!lv.bare;                   // polished metal (the DC-3)
    g.fillStyle = lv.base; g.fillRect(0, 0, W, Hc);
    go.fillStyle = bare ? 'rgb(90,70,255)' : 'rgb(255,92,0)'; go.fillRect(0, 0, W / 2, Hc / 2);    // clearcoat, roughness, metalness
    ge.fillStyle = '#000'; ge.fillRect(0, 0, W / 2, Hc / 2);
    // canvas coordinates: X(s, right), Y(th in 0..pi, right)
    const X = (s, r) => (r ? (1 - s / L) : s / L) * W, Yth = (th, r) => vOf(th, r) * Hc;
    const thAt = (s, y) => H.thAt(clamp(s, 0, L), y);
    const Y = (s, y, r) => Yth(thAt(s, y), r);
    const sides = [false, true];
    // a band between two heights (functions of s) over [s0, s1]
    const band = (ctx, sc, s0, s1, yTop, yBot, color, step = 0.25) => {
      for (const r of sides) {
        ctx.fillStyle = color; ctx.beginPath();
        for (let s = s0; s <= s1 + 1e-6; s += step) { const x = X(s, r) * sc, y = Y(s, yTop(s), r) * sc; s === s0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        for (let s = s1; s >= s0 - 1e-6; s -= step) ctx.lineTo(X(s, r) * sc, Y(s, yBot(s), r) * sc);
        ctx.closePath(); ctx.fill();
      }
    };
    const keel = () => -1e3, crown = () => 1e3;
    // arc length per radian of section angle at a station and height (for undistorted titles)
    const arcSpeed = (s, y) => { const th = thAt(s, y), a = new THREE.Vector3(), b = new THREE.Vector3(); H.pt(s, th - 0.01, a); H.pt(s, th + 0.01, b); return a.distanceTo(b) / 0.02; };
    const textAt = (ctx, sc, txt, s, y, hM, color, weight = 700, spacing = 0, italic = false) => {
      const sy = (Hc * (0.5 - 2 * GUT) / Math.PI) / arcSpeed(s, y) / ppm;      // vertical canvas px per horizontal px
      for (const r of sides) {
        ctx.save(); ctx.translate(X(s, r) * sc, Y(s, y, r) * sc); ctx.scale(1, sy);
        ctx.font = `${italic ? 'italic ' : ''}${weight} ${Math.round(hM * ppm * sc)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
        if (spacing && 'letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(spacing * ppm * sc)}px`;
        ctx.fillText(txt, 0, 0); ctx.restore();
      }
    };
    const yc0 = H.yc0, Rh = H.Rh;
    const draw = () => {
      g.fillStyle = lv.base; g.fillRect(0, 0, W, Hc);
      if (kind === 'jet') {
        const F = m.fus, NL = F.noseLen, TL = F.tailLen, wn = m.windows || {}, SC = scheme(type, H);
        const winY = SC.winY, sweep = SC.sweep, cl0 = SC.cl0, lineH = SC.lineH;
        // belly; the cheatline (a navy band, a thin line of the tail colour above it) from the nose sweeping up the
        // tail cone; the tail colour over the aft fuselage up to the fin
        band(g, 1, 0, L, () => SC.bellyY, keel, lv.belly || '#dfe2e6', 0.5);
        band(g, 1, cl0, L, (s) => sweep(s), (s) => sweep(s) - lineH * 2.6, lv.stripe, 0.25);
        band(g, 1, cl0 + 0.6, L, (s) => sweep(s) + lineH * 1.4, (s) => sweep(s) + lineH * 0.55, lv.tail, 0.25);
        band(g, 1, SC.sT0, L, crown, SC.tailBot, lv.tail, 0.2);
        // cabin windows (dark glass; lit at night), doors
        const ww = (wn.w || 0.24), wh = wn.h || 0.34, doors = (wn.doors || []).map(d => m.nose - d);
        const win = (s, y, w2, h2) => {
          for (const r of sides) {
            const x = X(s, r), yT = Y(s, y + h2 / 2, r), yB = Y(s, y - h2 / 2, r), w = w2 * ppm;
            g.fillStyle = '#1b222b'; g.beginPath(); g.roundRect(x - w / 2, yT, w, yB - yT, Math.min(w, yB - yT) * 0.42); g.fill();
            g.fillStyle = 'rgba(170,196,220,.22)'; g.beginPath(); g.roundRect(x - w / 2 + w * 0.12, yT + (yB - yT) * 0.1, w * 0.36, (yB - yT) * 0.38, w * 0.15); g.fill();
            go.fillStyle = 'rgb(255,20,0)'; go.beginPath(); go.roundRect((x - w / 2) / 2, yT / 2, w / 2, (yB - yT) / 2, 2); go.fill();
            ge.fillStyle = '#ffd7a0'; ge.beginPath(); ge.roundRect((x - w * 0.42) / 2, (yT + (yB - yT) * 0.08) / 2, w * 0.84 / 2, (yB - yT) * 0.84 / 2, 2); ge.fill();
          }
        };
        if (wn.x0 !== undefined) {
          for (let x = m.nose - wn.x0; x < m.nose - wn.x1; x += wn.pitch) { if (doors.some(d => Math.abs(d - x) < 0.95)) continue; win(x, winY, ww, wh); }
          if (wn.upper) for (let x = m.nose - wn.upper.x0; x < m.nose - wn.upper.x1; x += wn.upper.pitch || 0.53) { if (doors.some(d => Math.abs(d - x) < 0.8 && wn.upper.z > 0)) continue; win(x, -wn.upper.z, ww * 0.95, wh * 0.95); }
        }
        const doorH = Math.min(1.9, F.h * 0.46), doorW = Math.min(0.95, F.h * 0.22);
        for (const d of doors) {
          const top = winY + wh * 0.5 + 0.28, bot = top - doorH;
          for (const r of sides) {
            const x = X(d, r), yT = Y(d, top, r), yB = Y(d, bot, r), w = doorW * ppm;
            g.strokeStyle = 'rgba(36,42,50,.75)'; g.lineWidth = Math.max(1.5, ppm * 0.018); g.beginPath(); g.roundRect(x - w / 2, yT, w, yB - yT, w * 0.16); g.stroke();
            g.fillStyle = '#1b222b'; g.beginPath(); g.roundRect(x - ww * ppm * 0.4, Y(d, winY + 0.12, r), ww * ppm * 0.8, Y(d, winY - 0.14, r) - Y(d, winY + 0.12, r), 4); g.fill();
            g.strokeStyle = 'rgba(36,42,50,.5)'; g.lineWidth = Math.max(1, ppm * 0.012); g.beginPath(); g.moveTo(x + w * 0.28, Y(d, bot + doorH * 0.45, r)); g.lineTo(x + w * 0.28, Y(d, bot + doorH * 0.58, r)); g.stroke();
            ge.fillStyle = '#ffd7a0'; ge.fillRect((x - ww * ppm * 0.3) / 2, Y(d, winY + 0.1, r) / 2, ww * ppm * 0.3, (Y(d, winY - 0.12, r) - Y(d, winY + 0.1, r)) / 2);
          }
        }
        // cargo doors on the lower fuselage (outlines), the radome line, service panels
        g.strokeStyle = 'rgba(40,46,54,.35)'; g.lineWidth = Math.max(1, ppm * 0.012);
        for (const f of [0.3, 0.7]) { const s = L * f, top = yc0 - Rh * 0.3, bot = top - Math.min(1.25, F.h * 0.3);     // (cargo doors: right side)
          const w = Math.min(1.8, F.h * 0.44) * ppm; g.beginPath(); g.roundRect(X(s, true) - w / 2, Y(s, top, true), w, Y(s, bot, true) - Y(s, top, true), w * 0.06); g.stroke(); }
        for (const r of sides) { g.beginPath(); for (let th = 0.05; th < Math.PI - 0.05; th += 0.05) { const s = NL * 0.28; const x = X(s, r), y = Yth(th, r); th < 0.1 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke(); }
        // titles and the registration
        const tH = clamp(F.h * 0.21, 0.28, 1.35), tS = NL + (L - NL - TL) * 0.12 + tH * 3.2;
        textAt(g, 1, 'BAYLINE AIR', tS, winY + (wn.h || 0.34) * 0.5 + tH * 0.78, tH, lv.stripe, 700, tH * 0.06);
        textAt(g, 1, lv.reg, L - TL * 0.55, sweep(L - TL * 0.55) - lineH * 3.9, clamp(F.h * 0.07, 0.12, 0.42), '#5d6570', 600);
        // grime: exhaust and hydraulic streaks on the belly behind the wing, darkening toward the tail cone
        const grd = g.createLinearGradient(0, 0, W, 0);
        if (H.fair) for (const r of sides) {
          g.save(); g.globalAlpha = 0.07; g.fillStyle = '#4a4d52';
          const s0 = H.fair.s1 - 2, s1 = L - TL * 0.4;
          for (let k = 0; k < 7; k++) { const s = s0 + (s1 - s0) * k / 7; g.fillRect(X(s, r) - (r ? 3.5 * ppm : 0), Y(s, yc0 - Rh * 0.75, r), 3.5 * ppm, Y(s, yc0 - Rh * 0.98, r) - Y(s, yc0 - Rh * 0.75, r)); }
          g.restore();
        }
        void grd;
        // polished-metal liveries: slightly different panels
        if (bare) { for (const r of sides) for (let s = 0.4; s < L; s += 1.6) for (let th = 0.1; th < Math.PI; th += 0.5) { const v = 0.93 + ((Math.sin(s * 12.9 + th * 78.2) * 43758.5) % 1 + 1) % 1 * 0.1;
          go.fillStyle = `rgb(90,${Math.round(55 + v * 60)},255)`; go.fillRect(Math.min(X(s, r), X(s + 1.6, r)) / 2, Yth(th, r) / 2, 1.6 * ppm / 2, (Yth(th + 0.5, r) - Yth(th, r)) / 2);
          g.fillStyle = `rgba(${v > 0.98 ? '255,255,255' : '0,0,0'},${Math.abs(v - 0.98) * 0.5})`; g.fillRect(Math.min(X(s, r), X(s + 1.6, r)), Yth(th, r), 1.6 * ppm, Yth(th + 0.5, r) - Yth(th, r)); } }
      } else if (kind === 'ga' || kind === 'heli') {
        const F = m.fus, yc = yc0;
        // twin stripes along the side, a colour band on the belly, the registration aft
        band(g, 1, 0.2, L - 0.25, (s) => yc - F.h * 0.02, (s) => yc - F.h * 0.09, lv.stripe, 0.1);
        band(g, 1, 0.3, L - 0.35, (s) => yc - F.h * 0.12, (s) => yc - F.h * 0.155, lv.stripe2 || lv.stripe, 0.1);
        band(g, 1, 0, L, (s) => yc - F.h * 0.33, keel, lv.belly || '#e2e5e8', 0.2);
        if (kind === 'heli') band(g, 1, 0, (F.pod || 4) + 1.5, (s) => yc + F.h * 0.46, (s) => yc + F.h * 0.3, lv.tail, 0.1);
        const rs = kind === 'heli' ? (F.pod || 4) + 3.2 : L * 0.66;
        textAt(g, 1, lv.reg, rs, yc + F.h * 0.12, kind === 'heli' ? 0.3 : F.h * 0.2, '#26303a', 700);
      } else {
        // fighter: two-tone grey, darker spine, low-visibility markings
        band(g, 1, 0, L, crown, (s) => H.yc0 + 0.25, lv.tail, 0.25);
        band(g, 1, 0, L, (s) => H.yc0 - 0.35, keel, lv.belly, 0.25);
        textAt(g, 1, lv.reg, L * 0.72, H.yc0 + 0.05, 0.28, '#5a626b', 700);
        go.fillStyle = 'rgb(0,150,20)'; go.fillRect(0, 0, W / 2, Hc / 2);   // matte, no clearcoat
      }
    };
    const paint = () => { draw(); for (const c of [ca, co, ce]) fillGutters(c); };
    paint();
    const T = { map: tex(ca, true, { aniso: 8 }), orm: tex(co, false), emis: tex(ce, true) };
    if (!fontReady() && document.fonts && document.fonts.ready) document.fonts.ready.then(() => { try { paint(); T.map.needsUpdate = true; T.orm.needsUpdate = true; T.emis.needsUpdate = true; } catch (e) {} });
    return T;
  }

  // ---------------------------------------------------------------- wing atlas (planar, from above and below)
  // regions [u0, v0, du, dv]: the wing's upper and lower surfaces, the horizontal tail's (plain paint)
  const WING_R = { wu: [0, 0, 1, 0.48], wl: [0, 0.5, 1, 0.48], tu: [0, 0.98, 0.5, 0.02], tl: [0.5, 0.98, 0.5, 0.02] };
  // fin atlas: the fin's right and left sides (planar side views), the winglets' outboard and inboard faces
  const FIN_R = { r: [0, 0, 0.5, 0.75], l: [0.5, 0, 0.5, 0.75], wo: [0, 0.76, 0.5, 0.24], wi: [0.5, 0.76, 0.5, 0.24] };
  function wingAtlas(type, pf, q) {
    const m = type.model, lv = m.livery, S = [512, 1024, 2048, 2048, 4096][q], c = canvas(S, S), co = canvas(S / 2, S / 2), g = c.getContext('2d'), go = co.getContext('2d');
    const jet = m.kind === 'jet', paint = jet ? (lv.wing || '#d2d6db') : (m.kind === 'fighter' ? lv.base : lv.base);
    g.fillStyle = paint; g.fillRect(0, 0, S, S);
    go.fillStyle = m.kind === 'fighter' ? 'rgb(0,150,20)' : jet ? 'rgb(150,110,15)' : 'rgb(255,95,0)'; go.fillRect(0, 0, S / 2, S / 2);
    const R = WING_R, w = pf.wing;
    if (w && jet) {
      const toPx = (reg, zf, xf) => [(R[reg][0] + R[reg][2] * zf) * S, (R[reg][1] + R[reg][3] * xf) * S];
      // metallic leading edge (erosion strip), walkway on the upper root, fuel panels below, flap-track lines
      for (const reg of ['wu', 'wl']) {
        const n = 40; g.fillStyle = '#b9bec4'; go.fillStyle = 'rgb(60,70,230)'; g.beginPath(); go.beginPath();
        for (let i = 0; i <= n; i++) { const f = i / n, [x, y] = toPx(reg, f, w.leF(f)); i ? g.lineTo(x, y) : g.moveTo(x, y); i ? go.lineTo(x / 2, y / 2) : go.moveTo(x / 2, y / 2); }
        for (let i = n; i >= 0; i--) { const f = i / n, [x, y] = toPx(reg, f, w.leF(f) + w.cF(f) * 0.035); g.lineTo(x, y); go.lineTo(x / 2, y / 2); }
        g.fill(); go.fill();
      }
      g.strokeStyle = 'rgba(30,32,36,.75)'; g.lineWidth = Math.max(1, S / 700);
      const wk = (f0, f1, c0, c1) => { g.beginPath(); for (const [f, cc] of [[f0, c0], [f1, c0], [f1, c1], [f0, c1], [f0, c0]]) { const [x, y] = toPx('wu', f, w.leF(f) + w.cF(f) * cc); g.lineTo(x, y); } g.stroke(); };
      wk(0.0, 0.14, 0.16, 0.62);
      g.fillStyle = 'rgba(40,42,46,.18)'; for (let f = 0.12; f < 0.85; f += 0.09) { const [x, y] = toPx('wl', f, w.leF(f) + w.cF(f) * 0.42); g.beginPath(); g.ellipse(x, y, S * 0.006, S * 0.004, 0, 0, 7); g.fill(); }
      g.strokeStyle = 'rgba(40,44,50,.16)'; g.lineWidth = Math.max(1, S / 1400);
      for (const reg of ['wu', 'wl']) for (const cc of [0.16, 0.62]) { g.beginPath(); for (let i = 0; i <= 30; i++) { const f = i / 30, [x, y] = toPx(reg, f, w.leF(f) + w.cF(f) * cc); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); }
    }
    return { map: tex(c, true), orm: tex(co, false), R };
  }

  // ---------------------------------------------------------------- fin atlas (planar side views) + winglets
  function finAtlas(type, pf, q) {
    const m = type.model, lv = m.livery, S = [512, 1024, 1024, 2048, 2048][q], c = canvas(S, S), g = c.getContext('2d'), ce = canvas(S / 2, S / 2), ge = ce.getContext('2d');
    const kind = m.kind, col = kind === 'jet' ? lv.tail : lv.tail || lv.base;
    g.fillStyle = col; g.fillRect(0, 0, S, S);
    const f = pf.fin, R = FIN_R;
    // side view px: u along x (nose to the right on the right side), v down from the tip
    const toPx = (reg, xf, hf) => [(R[reg][0] + R[reg][2] * (reg === 'r' || reg === 'wo' ? xf : 1 - xf)) * S, (R[reg][1] + R[reg][3] * (1 - hf)) * S];
    if (kind === 'jet') {
      // the emblem centred on the fin, the colour carried down; a thin white trailing band
      for (const reg of ['r', 'l']) {
        const [cx, cy] = toPx(reg, f.emX, f.emH), rad = f.emR * R[reg][2] * S;
        emblem(g, cx, cy, rad, lv);
      }
    } else if (kind === 'ga' || kind === 'heli') {
      g.fillStyle = lv.base; g.fillRect(0, 0, S, S);
      for (const reg of ['r', 'l']) { const [x0, y0] = toPx(reg, 0, 0.62), [x1, y1] = toPx(reg, 1, 0.42); g.fillStyle = lv.stripe; g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0) * 0.5);
        g.fillStyle = lv.stripe2 || lv.tail; g.fillRect(Math.min(x0, x1), Math.min(y0, y1) + Math.abs(y1 - y0) * 0.62, Math.abs(x1 - x0), Math.abs(y1 - y0) * 0.22); }
    } else {
      for (const reg of ['r', 'l']) { const [cx, cy] = toPx(reg, 0.55, 0.55); g.save(); g.fillStyle = '#5c646d'; g.font = `700 ${Math.round(S * 0.05)}px ${FONT}`; g.textAlign = 'center'; g.fillText('BL', cx, cy); g.restore(); }
    }
    // winglets: the emblem on the outboard face
    if (kind === 'jet') { const [cx, cy] = toPx('wo', 0.5, 0.5); emblem(g, cx, cy, S * 0.07, lv); }
    // night: the logo lights wash the lower fin
    ge.drawImage(c, 0, 0, S / 2, S / 2);
    const gr = ge.createLinearGradient(0, 0, 0, S * 0.75 / 2); gr.addColorStop(0, 'rgba(0,0,0,.92)'); gr.addColorStop(0.55, 'rgba(0,0,0,.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    ge.fillStyle = gr; ge.fillRect(0, 0, S / 2, S * 0.75 / 2); ge.fillStyle = '#000'; ge.fillRect(0, S * 0.75 / 2, S / 2, S * 0.25 / 2);
    return { map: tex(c, true), emis: tex(ce, true), R };
  }

  // ---------------------------------------------------------------- nacelles and spinners
  // u = around (0..1), v = along the cowl (0 = the lip): a tail-colour band behind the lip, the emblem each side;
  // the spinner region (u 0..1, v .8..1) carries the white swirl
  function nacelleAtlas(type, q) {
    const m = type.model, lv = m.livery, S = [256, 512, 1024, 1024, 2048][q], c = canvas(S, S), g = c.getContext('2d');
    g.fillStyle = lv.nacelle || lv.base; g.fillRect(0, 0, S, S);
    if (m.kind === 'jet') {
      // v = 0.75 x (distance aft of the lip / nacelle length), u = the angle around from the top: a ring behind
      // the lip, and the emblem upright on each side (drawn rotated and scaled for the cowl's two scales)
      const fan = m.engines.find(e => e.type === 'fan'), C = fan ? Math.PI * fan.d : 7, Lz = fan ? fan.len / 0.75 : 5.5, rM = fan ? fan.d * 0.2 : 0.45;
      g.fillStyle = lv.tail; g.fillRect(0, S * 0.045, S, S * 0.05);
      for (const u of [0.25, 0.75]) { g.save(); g.translate(u * S, S * 0.3); g.rotate(-Math.PI / 2); g.scale(S / Lz / (S / C), 1); emblem(g, 0, 0, rM * S / C, lv); g.restore(); }
    }
    // the spinner: dark with a white spiral (the ground crew's rotation cue)
    g.fillStyle = lv.spinnerCol || '#2a2d31'; g.fillRect(0, S * 0.8, S, S * 0.2);
    g.strokeStyle = '#f2f2f2'; g.lineWidth = S * 0.02;
    g.beginPath(); for (let i = 0; i <= 40; i++) { const t = i / 40; g.lineTo(t * S * 0.5, S * (0.8 + 0.2 * t)); } g.stroke();
    return { map: tex(c, true) };
  }

  // ---------------------------------------------------------------- all of a type's textures (cached)
  function get(type, H, q, pf) {
    const key = type.id + '|' + q;
    let e = cache.get(key);
    if (!e) {
      const lv = type.model.livery;
      e = { key, fus: fuselage(type, H, q), wing: wingAtlas(type, pf, q), fin: finAtlas(type, pf, q), nac: nacelleAtlas(type, q), pal: palette(lv), tile: tile(q) };
      cache.set(key, e);
    }
    return e;
  }
  function keep(type, q) {
    const key = type.id + '|' + q;
    for (const [k, e] of cache) if (k !== key) {
      for (const part of ['fus', 'wing', 'fin', 'nac', 'pal']) for (const t of Object.values(e[part] || {})) if (t && t.isTexture) t.dispose();
      cache.delete(k);
    }
  }
  return { get, keep, pal, palName, colorOf, uvBodyFor, emblem, scheme, SW, NAMES, WING_R, FIN_R };
})();
