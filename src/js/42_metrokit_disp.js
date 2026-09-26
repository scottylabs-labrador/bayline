// MetroKit: displays and decals. The shared decal atlas (the Bayline Metro wordmark, car-number glyphs, pictograms,
// interior posters), the passenger LCD canvas (line strip map, next stop, clock) and the cab canvas (ATC speed display,
// status screen) that 41_metrokit.js binds per consist. No trademarks: the brand is "Bayline Metro" with its own mark.
(() => {
  const K = MetroKit._k, { clamp } = U;
  const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  const FONT_N = '"Arial Narrow", "Helvetica Neue", Arial, sans-serif';

  // ------------------------------------------------------------------------------------------ the mark
  // Bayline Metro mark: a rounded square in metro blue with a white "M" formed by two arches over a wave (the bay).
  function mark(g, x, y, s, fg = '#ffffff', bg = '#1b86c8') {
    g.save(); g.translate(x, y);
    g.fillStyle = bg; g.beginPath(); g.roundRect ? g.roundRect(0, 0, s, s, s * 0.2) : g.rect(0, 0, s, s); g.fill();
    g.strokeStyle = fg; g.lineWidth = s * 0.11; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(s * 0.2, s * 0.66); g.lineTo(s * 0.2, s * 0.42); g.arc(s * 0.35, s * 0.42, s * 0.15, Math.PI, 0); g.lineTo(s * 0.5, s * 0.62);
    g.moveTo(s * 0.5, s * 0.42); g.arc(s * 0.65, s * 0.42, s * 0.15, Math.PI, 0); g.lineTo(s * 0.8, s * 0.66); g.stroke();
    g.lineWidth = s * 0.07; g.beginPath(); g.moveTo(s * 0.16, s * 0.82); g.bezierCurveTo(s * 0.36, s * 0.72, s * 0.6, s * 0.92, s * 0.84, s * 0.8); g.stroke();
    g.restore();
  }
  // ------------------------------------------------------------------------------------------ decal atlas
  // 2048 x 2048, non-premultiplied RGBA; cells are named rects [u0, v0, u1, v1] (flipY = true: v = 1 at the top row)
  const ATL = Object.create(null); let _atlas = null;
  const DIG = '0123456789 XYL';                  // car-number glyphs (white on blue / black on white), 14 cells per row
  function decalAtlas() {
    if (_atlas) return _atlas;
    const W = 2048, H = 2048, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.clearRect(0, 0, W, H);
    const cell = (name, x, y, w, h, draw) => { g.save(); g.translate(x, y); g.beginPath(); g.rect(0, 0, w, h); g.clip(); draw(w, h); g.restore();
      ATL[name] = [(x + 1) / W, 1 - (y + h - 1) / H, (x + w - 1) / W, 1 - (y + 1) / H]; };
    // wordmark sticker (the door, the E-car end bands): white rounded plate, the mark, "BAYLINE METRO"
    cell('sticker', 0, 0, 256, 256, (w, h) => {                  // near-square plate: the mark over the two-line wordmark
      g.fillStyle = '#f6f7f7'; g.beginPath(); g.roundRect(6, 6, w - 12, h - 12, 26); g.fill();
      mark(g, 64, 22, 128); g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.font = `800 40px ${FONT}`;
      g.fillStyle = '#1d2227'; g.fillText('BAYLINE', w / 2, 196); g.fillStyle = '#1b86c8'; g.font = `800 34px ${FONT}`; g.fillText('METRO', w / 2, 232);
    });
    // nose wordmark (on the white cab door): no plate
    cell('noseMark', 512, 0, 512, 256, (w, h) => {
      mark(g, 16, 40, 176); g.fillStyle = '#1d2227'; g.font = `800 66px ${FONT}`; g.fillText('BAYLINE', 210, 118); g.fillStyle = '#1b86c8'; g.fillText('METRO', 210, 198);
    });
    // roof numbers are drawn from the glyph cells (black); side numbers white on blue
    for (let i = 0; i < DIG.length; i++) {
      cell('w' + DIG[i], i * 96, 256, 96, 144, (w, h) => { g.fillStyle = '#ffffff'; g.font = `700 ${Math.round(h * 0.82)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(DIG[i], w / 2, h * 0.56); });
      cell('k' + DIG[i], i * 96, 400, 96, 144, (w, h) => { g.fillStyle = '#16181b'; g.font = `800 ${Math.round(h * 0.9)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(DIG[i], w / 2, h * 0.56); });
    }
    const sq = (bg, r = 16) => (w, h) => { g.fillStyle = bg; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, r); g.fill(); };
    // pictograms
    cell('bike', 1024, 0, 192, 192, (w, h) => { sq('#4a9a3a')(w, h); g.strokeStyle = '#fff'; g.lineWidth = 11; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); g.arc(52, 120, 30, 0, 7); g.stroke(); g.beginPath(); g.arc(140, 120, 30, 0, 7); g.stroke();
      g.beginPath(); g.moveTo(52, 120); g.lineTo(82, 74); g.lineTo(126, 74); g.lineTo(140, 120); g.moveTo(82, 74); g.lineTo(96, 120); g.lineTo(126, 74); g.moveTo(96, 120); g.lineTo(52, 120);
      g.moveTo(72, 60); g.lineTo(92, 60); g.moveTo(126, 74); g.lineTo(120, 52); g.lineTo(136, 50); g.stroke(); });
    cell('wheelchair', 1216, 0, 192, 192, (w, h) => { sq('#1b5fb0')(w, h); g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 12; g.lineCap = 'round';
      g.beginPath(); g.arc(88, 40, 14, 0, 7); g.fill(); g.beginPath(); g.moveTo(84, 62); g.lineTo(84, 108); g.lineTo(124, 108); g.lineTo(140, 146); g.moveTo(84, 84); g.lineTo(116, 84); g.stroke();
      g.beginPath(); g.arc(88, 126, 34, 0.3, 5.6); g.stroke(); });
    cell('floorWheel', 1408, 0, 256, 256, (w, h) => { g.fillStyle = '#1b5fb0'; g.fillRect(0, 0, w, h); g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 16; g.lineCap = 'round';
      g.beginPath(); g.arc(118, 52, 18, 0, 7); g.fill(); g.beginPath(); g.moveTo(112, 82); g.lineTo(112, 144); g.lineTo(166, 144); g.lineTo(188, 196); g.moveTo(112, 110); g.lineTo(156, 110); g.stroke();
      g.beginPath(); g.arc(118, 168, 46, 0.3, 5.6); g.stroke(); });
    cell('priority', 1664, 0, 384, 128, (w, h) => { g.fillStyle = '#1b5fb0'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = `700 36px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('PRIORITY SEATING', w / 2, 44); g.font = `500 24px ${FONT}`; g.fillText('for seniors and people with disabilities', w / 2, 92); });
    cell('flag', 1664, 128, 192, 128, (w, h) => {        // the national flag (13 stripes, canton with stars)
      const x0 = 6, y0 = 6, fw = w - 12, fh = h - 12;
      for (let i = 0; i < 13; i++) { g.fillStyle = i % 2 ? '#ffffff' : '#b22234'; g.fillRect(x0, y0 + i * fh / 13, fw, fh / 13 + 0.5); }
      g.fillStyle = '#3c3b6e'; g.fillRect(x0, y0, fw * 0.4, fh * 7 / 13); g.fillStyle = '#ffffff';
      for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) { g.beginPath(); g.arc(x0 + fw * 0.4 * (c + 0.5) / 6, y0 + fh * 7 / 13 * (r + 0.5) / 5, 2.2, 0, 7); g.fill(); } });
    cell('emergency', 1400, 600, 384, 192, (w, h) => { g.fillStyle = '#c8202a'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = `800 40px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('EMERGENCY', w / 2, 52); g.font = `600 26px ${FONT}`; g.fillText('Door release \u00b7 Intercom', w / 2, 104); g.fillText('Use only in an emergency', w / 2, 146); });
    cell('standClear', 1408, 256, 640, 96, (w, h) => { g.fillStyle = '#f2c230'; g.fillRect(0, 0, w, h); g.fillStyle = '#1b1b1b'; g.font = `800 40px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('PLEASE STAND CLEAR OF THE DOORS', w / 2, h / 2 + 2); });
    cell('noLean', 1408, 352, 192, 192, (w, h) => { sq('#ffffff')(w, h); g.strokeStyle = '#c8202a'; g.lineWidth = 14; g.beginPath(); g.arc(96, 96, 70, 0, 7); g.stroke();
      g.fillStyle = '#1b1b1b'; g.beginPath(); g.arc(80, 58, 13, 0, 7); g.fill(); g.lineWidth = 12; g.strokeStyle = '#1b1b1b'; g.beginPath(); g.moveTo(84, 76); g.lineTo(104, 126); g.lineTo(94, 150); g.moveTo(100, 112); g.lineTo(128, 100); g.stroke();
      g.strokeStyle = '#c8202a'; g.lineWidth = 14; g.beginPath(); g.moveTo(46, 46); g.lineTo(146, 146); g.stroke(); });
    cell('unofficial', 1600, 352, 448, 64, (w, h) => { g.fillStyle = '#23272d'; g.font = `600 22px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('BAYLINE METRO \u00b7 UNOFFICIAL \u00b7 BUILT FOR THE BAY', w / 2, h / 2); });
    // interior posters (end walls): "Are you prepared?" style safety panels and a line map, and ad panels
    const poster = (name, x, y, w, h, fn) => cell(name, x, y, w, h, fn);
    poster('posterSafety', 0, 560, 320, 448, (w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.fillStyle = '#c8202a'; g.fillRect(0, 0, w, 64);
      g.fillStyle = '#fff'; g.font = `800 30px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('In an emergency', 18, 34);
      g.fillStyle = '#1b1b1b'; g.font = `700 26px ${FONT}`; g.fillText('Stay inside the car.', 18, 104); g.font = `500 21px ${FONT}`;
      ['Listen to the operator.', 'Use the intercom by', 'the door to talk to', 'the operator.', '', 'Walk between cars only', 'if told to.'].forEach((t, i) => g.fillText(t, 18, 150 + i * 32));
      mark(g, w - 84, h - 84, 64); });
    poster('posterMap', 320, 560, 512, 320, (w, h) => { g.fillStyle = '#f4f4f1'; g.fillRect(0, 0, w, h); drawStripMap(g, 10, 10, w - 20, h - 20); });
    const ads = [['#2b5d8a', 'Ride the Bay', 'Clipper-ready at every gate'], ['#7a3b8f', 'Night Market', 'Fridays at the waterfront'], ['#1f7a5a', 'Hike the Hills', 'Bayline to the trailheads'], ['#b6452c', 'Museum Late', 'First Thursdays, 6-10 pm']];
    ads.forEach(([bg, t1, t2], i) => poster('ad' + i, 832 + (i % 2) * 256, 560 + Math.floor(i / 2) * 384, 256, 384, (w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, bg); gr.addColorStop(1, '#101418'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.12)'; for (let k = 0; k < 6; k++) { g.beginPath(); g.arc(40 + k * 40, 150 + (k % 3) * 30, 50 + k * 6, 0, 7); g.fill(); }
      g.fillStyle = '#fff'; g.font = `800 34px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText(t1, 18, h - 96); g.font = `500 20px ${FONT}`; g.fillText(t2, 18, h - 62);
      mark(g, 18, 18, 44); }));
    // floor arrows / "keep clear" at doors, the car's plate by the end door
    cell('plate', 1600, 416, 256, 96, (w, h) => { g.fillStyle = '#d5d8da'; g.fillRect(0, 0, w, h); g.fillStyle = '#1b1b1b'; g.font = `700 22px ${FONT}`; g.textAlign = 'left'; g.fillText('BAYLINE METRO', 14, 34); g.font = `500 18px ${FONT}`; g.fillText('Built 2019 \u00b7 Car type D/E', 14, 66); });
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.premultiplyAlpha = false;
    t.userData.canvas = c; _atlas = t; return t;
  }
  // a stylised line strip map (station dots on a line), used on posters and the LCD
  function drawStripMap(g, x, y, w, h, st) {
    const stops = (st && st.stops) || ['Antioch', 'Pittsburg Center', 'Pittsburg/Bay Point', 'North Concord', 'Concord', 'Pleasant Hill', 'Walnut Creek', 'Lafayette', 'Orinda', 'Rockridge', 'MacArthur', '19th St', '12th St', 'West Oakland', 'Embarcadero', 'Montgomery', 'Powell', 'Civic Center', '16th St', '24th St', 'Glen Park', 'Balboa Park', 'Daly City', 'Colma', 'South SF', 'San Bruno', 'SF Airport'];
    const color = (st && st.color) || '#ffe400', cur = st && st.index !== undefined ? st.index : 11;
    g.save(); g.translate(x, y);
    const n = stops.length, x0 = 18, x1 = w - 18, yl = h * 0.42;
    g.lineCap = 'round'; g.strokeStyle = color; g.lineWidth = 10; g.beginPath(); g.moveTo(x0, yl); g.lineTo(x1, yl); g.stroke();
    if (cur >= 0) { g.strokeStyle = 'rgba(160,160,160,0.9)'; g.beginPath(); g.moveTo(x0, yl); g.lineTo(x0 + (x1 - x0) * cur / (n - 1), yl); g.stroke(); }
    g.font = `600 ${Math.max(9, Math.min(15, Math.floor(w / n * 0.62)))}px ${FONT_N}`;
    for (let i = 0; i < n; i++) {
      const px = x0 + (x1 - x0) * i / (n - 1);
      g.fillStyle = i === cur + 1 ? '#ffffff' : '#ffffff'; g.strokeStyle = '#222'; g.lineWidth = 2.5;
      g.beginPath(); g.arc(px, yl, i === cur + 1 ? 9 : 6, 0, 7); g.fill(); g.stroke();
      g.save(); g.translate(px, yl + 14); g.rotate(Math.PI / 3.2); g.fillStyle = i <= cur ? '#8a8f94' : '#1d2227'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(stops[i], 0, 0); g.restore();
    }
    g.restore();
  }

  // ------------------------------------------------------------------------------------------ passenger LCD canvas
  // 1024 x 512: left 60 %: "Next stop" + name + "Doors open on the right" + clock; right 40 % + bottom: the strip map.
  function drawPis(g, W, H, s) {
    g.fillStyle = '#f3f4f2'; g.fillRect(0, 0, W, H);
    const col = s.color || '#ffe400';
    g.fillStyle = col; g.fillRect(0, 0, W, 76);
    g.fillStyle = luminance(col) > 0.6 ? '#1b1d20' : '#ffffff'; g.font = `800 40px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillText((s.lineName || 'Yellow Line') + (s.destination ? '  to  ' + s.destination : ''), 24, 40);
    g.textAlign = 'right'; g.font = `700 38px ${FONT}`; g.fillText(s.clock || '', W - 24, 40);
    g.textAlign = 'left'; g.fillStyle = '#5b6168'; g.font = `600 30px ${FONT}`; g.fillText(s.arriving ? 'Arriving at' : 'Next stop', 28, 124);
    g.fillStyle = '#16181b'; g.font = `800 76px ${FONT}`;
    const ns = String(s.nextStop || ''), tw = g.measureText(ns).width; g.save(); g.translate(28, 196); g.scale(Math.min(1, (W - 56) / Math.max(tw, 1)), 1); g.fillText(ns, 0, 0); g.restore();
    if (s.doors) { g.fillStyle = '#1b86c8'; g.font = `700 30px ${FONT}`; g.fillText((s.doors === 'left' ? '\u25c0 ' : '') + 'Doors open on the ' + s.doors + (s.doors === 'right' ? ' \u25b6' : ''), 28, 262); }
    if (s.transfer) { g.fillStyle = '#5b6168'; g.font = `600 26px ${FONT}`; g.fillText('Transfer: ' + s.transfer, 28, 304); }
    g.fillStyle = '#1d2227'; g.fillRect(0, 330, W, 4);
    drawStripMap(g, 0, 336, W, H - 336, { stops: s.stops, color: col, index: s.index });
  }
  const luminance = hex => { const c = new THREE.Color(hex); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };

  // ------------------------------------------------------------------------------------------ cab canvas
  // 1024 x 512: left half the ATC speed display (speed arc, ACTUAL / AUTHORIZED / COMMANDED, tractive effort bar), right
  // half the train status screen (doors, brakes, mode, next stop, distance, clock).
  function drawCab(g, W, H, s) {
    g.fillStyle = '#05080c'; g.fillRect(0, 0, W, H);
    const hw = W / 2;
    // ---- ATC speed display
    const cx = hw * 0.5, cy = H * 0.52, R = H * 0.38, a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, max = 80;
    const ang = v => a0 + (a1 - a0) * clamp(v / max, 0, 1);
    g.lineWidth = 16; g.strokeStyle = '#18222b'; g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
    const auth = s.atcCodeMph != null ? s.atcCodeMph : 70, cmd = s.targetMph != null ? s.targetMph : auth, v = Math.abs(s.speedMph || 0);
    g.strokeStyle = '#1f9a4c'; g.beginPath(); g.arc(cx, cy, R, a0, ang(cmd)); g.stroke();
    if (auth > cmd) { g.strokeStyle = '#d6a52a'; g.beginPath(); g.arc(cx, cy, R, ang(cmd), ang(auth)); g.stroke(); }
    g.strokeStyle = '#e03a3a'; g.lineWidth = 22; g.beginPath(); g.arc(cx, cy, R, ang(auth) - 0.015, ang(auth) + 0.015); g.stroke();
    g.fillStyle = '#9fb3c1'; g.strokeStyle = '#9fb3c1'; g.lineWidth = 2; g.font = `600 17px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let k = 0; k <= max; k += 5) { const a = ang(k), c = Math.cos(a), sn = Math.sin(a); g.beginPath(); g.moveTo(cx + c * (R - (k % 10 ? 12 : 22)), cy + sn * (R - (k % 10 ? 12 : 22))); g.lineTo(cx + c * (R - 4), cy + sn * (R - 4)); g.stroke();
      if (k % 10 === 0) g.fillText(String(k), cx + c * (R - 40), cy + sn * (R - 40)); }
    const a = ang(v); g.strokeStyle = '#f5f1e6'; g.lineWidth = 6; g.beginPath(); g.moveTo(cx - Math.cos(a) * 16, cy - Math.sin(a) * 16); g.lineTo(cx + Math.cos(a) * (R - 12), cy + Math.sin(a) * (R - 12)); g.stroke();
    g.fillStyle = '#f5f1e6'; g.beginPath(); g.arc(cx, cy, 10, 0, 7); g.fill();
    g.font = `800 64px ${FONT}`; g.fillText(String(Math.round(v)), cx, cy + R * 0.45); g.font = `600 18px ${FONT}`; g.fillStyle = '#9fb3c1'; g.fillText('MPH', cx, cy + R * 0.72);
    // readouts
    g.textAlign = 'left'; g.font = `700 20px ${FONT}`;
    const row = (label, val, col, y) => { g.fillStyle = '#9fb3c1'; g.fillText(label, 16, y); g.fillStyle = col; g.textAlign = 'right'; g.fillText(val, hw - 18, y); g.textAlign = 'left'; };
    row('AUTHORIZED', String(Math.round(auth)), '#e8e0d0', 30); row('COMMANDED', String(Math.round(cmd)), '#6fd08f', 58);
    // tractive effort bar (right edge of the left half)
    const te = clamp(s.effort || 0, -1, 1), bx = hw - 40, by0 = 110, by1 = H - 40, mid = (by0 + by1) / 2;
    g.fillStyle = '#18222b'; g.fillRect(bx, by0, 20, by1 - by0); g.fillStyle = te >= 0 ? '#3fc070' : '#f2b132';
    if (te >= 0) g.fillRect(bx, mid - te * (mid - by0), 20, te * (mid - by0)); else g.fillRect(bx, mid, 20, -te * (by1 - mid));
    g.fillStyle = '#9fb3c1'; g.font = `600 14px ${FONT}`; g.textAlign = 'center'; g.fillText('P', bx + 10, by0 - 12); g.fillText('B', bx + 10, by1 + 14);
    // ---- status screen
    g.strokeStyle = '#223440'; g.lineWidth = 2; g.beginPath(); g.moveTo(hw, 12); g.lineTo(hw, H - 12); g.stroke();
    const mode = String(s.mode || 'ATO').toUpperCase(), doors = String(s.doors || 'closed').toLowerCase();
    g.textAlign = 'left'; g.fillStyle = '#9fb3c1'; g.font = `600 18px ${FONT}`; g.fillText('MODE', hw + 20, 30);
    g.fillStyle = mode === 'MANUAL' ? '#f2b132' : '#3fc0f0'; g.font = `800 30px ${FONT}`; g.fillText(mode, hw + 20, 62);
    g.fillStyle = '#9fb3c1'; g.font = `600 18px ${FONT}`; g.fillText('DOORS', hw + 220, 30);
    g.fillStyle = doors.startsWith('closed') ? '#3fc070' : '#e03a3a'; g.font = `800 30px ${FONT}`; g.fillText(doors.toUpperCase(), hw + 220, 62);
    // train schematic: cars as boxes with door status per car
    const n = s.cars || 10, cw = (hw - 40) / n;
    for (let i = 0; i < n; i++) { const x = hw + 20 + i * cw; g.fillStyle = '#16232d'; g.fillRect(x + 2, 92, cw - 4, 34); g.strokeStyle = '#3a5870'; g.strokeRect(x + 2, 92, cw - 4, 34);
      g.fillStyle = doors.startsWith('closed') ? '#2f8f4e' : '#c23a3a'; for (let k = 0; k < 3; k++) g.fillRect(x + 2 + (k + 0.5) * (cw - 4) / 3 - 3, 118, 6, 6); }
    g.fillStyle = '#9fb3c1'; g.font = `600 18px ${FONT}`; g.fillText('NEXT STOP', hw + 20, 166);
    g.fillStyle = '#f5f1e6'; g.font = `800 34px ${FONT}`; g.fillText(String(s.nextStop || '\u2014').slice(0, 24), hw + 20, 204);
    g.fillStyle = '#f2c230'; g.font = `700 30px ${FONT}`; g.fillText(s.distFt != null ? (s.distFt > 5000 ? (s.distFt / 5280).toFixed(1) + ' mi' : Math.round(s.distFt) + ' ft') : '', hw + 20, 246);
    g.fillStyle = '#9fb3c1'; g.font = `600 18px ${FONT}`; g.fillText('BRAKE', hw + 20, 296); g.fillText('LINE', hw + 220, 296);
    const br = clamp(s.brake || 0, 0, 1); g.fillStyle = '#18222b'; g.fillRect(hw + 20, 306, 170, 18); g.fillStyle = '#f2b132'; g.fillRect(hw + 20, 306, 170 * br, 18);
    g.fillStyle = s.lineColor || '#ffe400'; g.fillRect(hw + 220, 304, 22, 22); g.fillStyle = '#f5f1e6'; g.font = `700 22px ${FONT}`; g.fillText(String(s.destination || '').slice(0, 18), hw + 252, 316);
    g.textAlign = 'right'; g.fillStyle = '#9fb3c1'; g.font = `700 26px ${FONT}`; g.fillText(s.clock || '', W - 18, H - 26);
    g.textAlign = 'left'; g.fillStyle = s.alarm ? '#e03a3a' : '#3a5870'; g.font = `700 20px ${FONT}`; g.fillText(s.alarm || 'NO ALARMS', hw + 20, H - 26);
  }

  // ------------------------------------------------------------------------------------------ LCD texture (per consist)
  // 2048 x 512: [0, 1024) passenger screen, [1024, 2048) cab screens. uv rects for the geometry below.
  const LCD = { W: 2048, H: 512, pis: [0, 0, 0.5, 1], cab: [0.5, 0, 1, 1] };
  function makeLcdTexture() {
    const c = document.createElement('canvas'); c.width = LCD.W; c.height = LCD.H;
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.userData.canvas = c; t.userData.ctx = c.getContext('2d'); return t;
  }
  function updatePis(tex, s) { const g = tex.userData.ctx; g.save(); g.beginPath(); g.rect(0, 0, 1024, 512); g.clip(); drawPis(g, 1024, 512, s); g.restore(); tex.needsUpdate = true; }
  function updateCab(tex, s) { const g = tex.userData.ctx; g.save(); g.translate(1024, 0); g.beginPath(); g.rect(0, 0, 1024, 512); g.clip(); drawCab(g, 1024, 512, s); g.restore(); tex.needsUpdate = true; }

  Object.assign(K, { decalAtlas, ATL, DIG, mark, drawStripMap, drawPis, drawCab, LCD, makeLcdTexture, updatePis, updateCab });
})();
