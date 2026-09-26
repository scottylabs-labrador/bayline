// MetroSigns: Bayline Metro's own sign system (no real agency marks anywhere).
//  - The mark: a navy rounded square holding two white arches (a bridge's cables, a lower-case m) over a teal wave line;
//    the wordmark "Bayline Metro" in Barlow Condensed. Station names, wayfinding and platform panels are navy with white
//    type and line-colour bullets (the line colours are the public GTFS ones); a thin teal rule underlines every panel.
//  - A texture atlas per station (2048 x 1024) holds its static signs; signs are lightbox panels (emissive).
//  - Departure boards: a dark LED panel per platform display, redrawn when SIM writes rows (setBoard) or the minute
//    changes; rows = [{ line, color, dest, cars, min }]. Without data from SIM a board shows the station and the time.
const MetroSigns = (() => {
  const NAVY = '#10263b', NAVY2 = '#0b1a29', TEAL = '#1aa3b8', WHITE = '#f4f4f1', DIM = 'rgba(244,244,241,0.62)';
  const FONT = '"Barlow Condensed", "Arial Narrow", sans-serif', FONTB = 'Barlow, "Helvetica Neue", Arial, sans-serif';
  let LINES = {}, stationLines = {}, platformDest = {};
  const shared = new Set();

  function init(lines, stations) {
    LINES = {}; for (const l of lines || []) LINES[l.id] = { id: l.id, name: l.name, color: l.colour || l.color || '#888', text: l.text || '#000', terminals: l.terminals || [] };
    // which lines stop at each station and where each platform's trains go (from MetroNet patterns)
    stationLines = {}; platformDest = {};
    const pats = (typeof MetroNet !== 'undefined' && MetroNet.patterns) ? MetroNet.patterns : {};
    for (const pid in pats) {
      const p = pats[pid]; const legs = p.legs || []; const last = legs.length ? legs[legs.length - 1].stops : []; const dest = last.length ? last[last.length - 1].station : null;
      for (const lg of legs) for (const s of lg.stops || []) {
        (stationLines[s.station] || (stationLines[s.station] = new Set())).add(p.line);
        const key = s.station + '|' + s.gtfs; const o = platformDest[key] || (platformDest[key] = new Map());
        if (dest && dest !== s.station) o.set(p.line + '>' + dest, { line: p.line, dest });
      }
    }
  }
  const lineColor = (id) => (LINES[id] ? LINES[id].color : '#888888');
  const stName = (id) => { const s = typeof MetroNet !== 'undefined' && MetroNet.stationById ? MetroNet.stationById[id] : null; return s ? s.name : id; };
  const short = (n) => n.replace('San Francisco International Airport', 'SFO Airport').replace('Oakland International Airport', 'Oakland Airport').replace(' / ', '/');
  function linesAt(stId) { const s = stationLines[stId]; if (!s) return []; const order = ['yellow', 'orange', 'green', 'red', 'blue', 'grey', 'ebart']; return [...s].sort((a, b) => order.indexOf(a) - order.indexOf(b)); }
  function destsFor(stId, gtfs) { const m = platformDest[stId + '|' + gtfs]; return m ? [...m.values()] : []; }

  // ------------------------------------------------------------------------------------------------ drawing helpers
  function mark(c, x, y, s) {   // the Bayline Metro mark, top-left (x, y), size s: two white arches (an m, a bridge) over a teal wave
    c.fillStyle = NAVY; c.beginPath(); c.roundRect(x, y, s, s, s * 0.22); c.fill();
    c.strokeStyle = WHITE; c.lineWidth = s * 0.1; c.lineCap = 'round'; c.lineJoin = 'round';
    const b = y + s * 0.64, top = y + s * 0.43, r = s * 0.15;
    c.beginPath(); c.moveTo(x + s * 0.2, b); c.lineTo(x + s * 0.2, top); c.arc(x + s * 0.35, top, r, Math.PI, 0); c.lineTo(x + s * 0.5, b);
    c.moveTo(x + s * 0.5, top); c.arc(x + s * 0.65, top, r, Math.PI, 0); c.lineTo(x + s * 0.8, b); c.stroke();
    c.strokeStyle = TEAL; c.lineWidth = s * 0.07; c.beginPath();
    for (let i = 0; i <= 24; i++) { const t = i / 24; const px = x + s * (0.16 + 0.68 * t), py = y + s * 0.8 + Math.sin(t * Math.PI * 2) * s * 0.035; if (i) c.lineTo(px, py); else c.moveTo(px, py); } c.stroke();
  }
  function wordmark(c, x, y, h, col = WHITE) {
    mark(c, x, y, h); c.fillStyle = col; c.textBaseline = 'middle';
    c.font = `700 ${h * 0.62}px ${FONT}`; c.fillText('Bayline', x + h * 1.22, y + h * 0.52);
    const w = c.measureText('Bayline').width; c.font = `500 ${h * 0.62}px ${FONT}`; c.fillStyle = col === WHITE ? '#9fdbe6' : col; c.fillText('Metro', x + h * 1.22 + w + h * 0.16, y + h * 0.52);
  }
  function bullet(c, x, y, r, lineId) {   // a line bullet: a filled circle in the line colour with a white ring
    c.fillStyle = lineColor(lineId); c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    c.lineWidth = r * 0.16; c.strokeStyle = 'rgba(255,255,255,0.9)'; c.stroke();
  }
  function fit(c, text, font, maxW, size, minSize = 10) { let s = size; c.font = font.replace('#', s); while (c.measureText(text).width > maxW && s > minSize) { s -= 2; c.font = font.replace('#', s); } return s; }
  function arrow(c, x, y, s, dir) {   // dir: 0 right, 1 up, 2 left, 3 down, 4 up-right
    c.save(); c.translate(x, y); c.rotate([0, -Math.PI / 2, Math.PI, Math.PI / 2, -Math.PI / 4][dir] || 0);
    c.fillStyle = WHITE; c.beginPath(); c.moveTo(-s * 0.45, -s * 0.1); c.lineTo(s * 0.1, -s * 0.1); c.lineTo(s * 0.1, -s * 0.34); c.lineTo(s * 0.5, 0); c.lineTo(s * 0.1, s * 0.34); c.lineTo(s * 0.1, s * 0.1); c.lineTo(-s * 0.45, s * 0.1); c.closePath(); c.fill(); c.restore();
  }
  function pict(c, x, y, s, kind) {   // simple white pictograms: 'esc', 'stairs', 'elev', 'exit', 'gates', 'train'
    c.save(); c.translate(x, y); c.strokeStyle = WHITE; c.fillStyle = WHITE; c.lineWidth = s * 0.09; c.lineCap = 'round'; c.lineJoin = 'round';
    if (kind === 'stairs' || kind === 'esc') { c.beginPath(); c.moveTo(-s * 0.45, s * 0.4); for (let i = 0; i < 4; i++) { c.lineTo(-s * 0.45 + (i + 1) * s * 0.22, s * 0.4 - i * s * 0.2); c.lineTo(-s * 0.45 + (i + 1) * s * 0.22, s * 0.4 - (i + 1) * s * 0.2); } c.stroke();
      if (kind === 'esc') { c.beginPath(); c.moveTo(-s * 0.48, s * 0.1); c.lineTo(s * 0.3, -s * 0.45); c.stroke(); } }
    else if (kind === 'elev') { c.strokeRect(-s * 0.36, -s * 0.46, s * 0.72, s * 0.92); c.beginPath(); c.moveTo(-s * 0.15, -s * 0.12); c.lineTo(0, -s * 0.3); c.lineTo(s * 0.15, -s * 0.12); c.moveTo(-s * 0.15, s * 0.12); c.lineTo(0, s * 0.3); c.lineTo(s * 0.15, s * 0.12); c.stroke(); }
    else if (kind === 'exit') { c.strokeRect(-s * 0.1, -s * 0.46, s * 0.5, s * 0.92); c.beginPath(); c.arc(-s * 0.3, -s * 0.28, s * 0.09, 0, 7); c.fill(); c.beginPath(); c.moveTo(-s * 0.32, -s * 0.15); c.lineTo(-s * 0.36, s * 0.12); c.lineTo(-s * 0.2, s * 0.44); c.moveTo(-s * 0.36, s * 0.12); c.lineTo(-s * 0.5, s * 0.44); c.moveTo(-s * 0.46, -s * 0.05); c.lineTo(-s * 0.18, -s * 0.02); c.stroke(); }
    else if (kind === 'gates') { for (const dx of [-0.36, 0, 0.36]) c.fillRect(dx * s - s * 0.05, -s * 0.1, s * 0.1, s * 0.5); c.beginPath(); c.moveTo(-s * 0.3, s * 0.05); c.lineTo(-s * 0.1, -s * 0.05); c.moveTo(s * 0.06, s * 0.05); c.lineTo(s * 0.26, -s * 0.05); c.stroke(); }
    else if (kind === 'train') { c.beginPath(); c.roundRect(-s * 0.36, -s * 0.46, s * 0.72, s * 0.78, s * 0.14); c.stroke(); c.fillRect(-s * 0.26, -s * 0.32, s * 0.52, s * 0.22); c.beginPath(); c.arc(-s * 0.18, s * 0.14, s * 0.06, 0, 7); c.arc(s * 0.18, s * 0.14, s * 0.06, 0, 7); c.fill(); c.beginPath(); c.moveTo(-s * 0.3, s * 0.46); c.lineTo(-s * 0.18, s * 0.32); c.moveTo(s * 0.3, s * 0.46); c.lineTo(s * 0.18, s * 0.32); c.stroke(); }
    c.restore();
  }
  function panel(c, x, y, w, h) { c.fillStyle = NAVY; c.fillRect(x, y, w, h); c.fillStyle = TEAL; c.fillRect(x, y + h - Math.max(3, h * 0.045), w, Math.max(3, h * 0.045)); }

  // ------------------------------------------------------------------------------------------------ station atlas
  // regions (pixels) -> UV rects. The layout is fixed so geometry can ask for a region by name.
  const AW = 2048, AH = 1024;
  const R = {
    name: [0, 0, 1024, 192],            // big name panel with mark and line bullets (6.4:1.2 m)
    nameS: [1024, 0, 1024, 128],        // hanging name sign (4 x 0.5 m)
    frieze: [0, 192, 2048, 128],        // trackway wall frieze (16 x 1 m), repeating name + mark
    p1: [0, 320, 1024, 128],            // platform direction panels (platform 1..4)
    p2: [1024, 320, 1024, 128],
    p3: [0, 448, 1024, 128],
    p4: [1024, 448, 1024, 128],
    exit: [0, 576, 512, 128],           // exit / street
    gates: [512, 576, 512, 128],        // fare gates / exit
    esc: [1024, 576, 512, 128],         // escalator + stairs to platforms
    elev: [1536, 576, 512, 128],        // elevator
    word: [0, 704, 1024, 128],          // wordmark panel (entrance canopies, totems)
    totem: [1024, 704, 256, 320],       // entrance totem face (0.8 x 1 m)
    map: [1280, 704, 768, 320],         // system map (2.4 x 1 m)
    info: [0, 832, 1024, 192],          // info panel (station name + lines + "Trains every few minutes")
  };
  const atlasCache = new Map();
  let SCALE = 1;                     // quality: Low draws the atlas at half size (the regions and UVs stay in AW x AH units)
  const setScale = (s) => { SCALE = s > 0 ? Math.min(1, s) : 1; };
  // (the atlas is drawn a few panels per step, so a station build never stalls a frame on it: stationAtlasGen; the
  // synchronous stationAtlas runs the same steps at once)
  function stationAtlas(st) { const g = stationAtlasGen(st); let r = g.next(); while (!r.done) r = g.next(); return r.value; }
  function* stationAtlasGen(st) {
    if (atlasCache.has(st.id)) return atlasCache.get(st.id);
    const cv = document.createElement('canvas'); cv.width = Math.round(AW * SCALE); cv.height = Math.round(AH * SCALE); const c = cv.getContext('2d');
    if (SCALE !== 1) c.scale(SCALE, SCALE);
    c.fillStyle = NAVY2; c.fillRect(0, 0, AW, AH);
    const name = st.name, lines = linesAt(st.id);
    // big name panel
    { const [x, y, w, h] = R.name; panel(c, x, y, w, h); mark(c, x + 26, y + 30, 120);
      const lw = lines.length * 70; const sz = fit(c, name, `600 #px ${FONT}`, w - 200 - lw, 112, 40); c.fillStyle = WHITE; c.textBaseline = 'middle'; c.fillText(name, x + 176, y + h * 0.5 + 4);
      lines.forEach((l, i) => bullet(c, x + w - 44 - (lines.length - 1 - i) * 66, y + h * 0.5, 26, l)); void sz; }
    // hanging name sign
    { const [x, y, w, h] = R.nameS; panel(c, x, y, w, h); mark(c, x + 18, y + 18, 88); fit(c, name, `600 #px ${FONT}`, w - 150, 84, 30); c.fillStyle = WHITE; c.textBaseline = 'middle'; c.fillText(name, x + 124, y + h * 0.5 + 3); }
    yield;
    // frieze: name, mark, name ... (tiles horizontally)
    { const [x, y, w, h] = R.frieze; c.fillStyle = NAVY; c.fillRect(x, y, w, h); c.fillStyle = TEAL; c.fillRect(x, y + h - 6, w, 6);
      const fs = fit(c, name.toUpperCase(), `600 #px ${FONT}`, w * 0.36, 86, 30); void fs;
      for (const cx of [w * 0.25, w * 0.75]) { mark(c, x + cx - c.measureText(name.toUpperCase()).width / 2 - 104, y + 24, 76); c.fillStyle = WHITE; c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillText(name.toUpperCase(), x + cx - c.measureText(name.toUpperCase()).width / 2, y + h / 2 + 2); } }
    yield;
    // platform direction panels
    const plats = (st.data && st.data.platforms) || [];
    ['p1', 'p2', 'p3', 'p4'].forEach((k, i) => {
      const [x, y, w, h] = R[k]; panel(c, x, y, w, h); const p = plats[i];
      c.fillStyle = TEAL; c.beginPath(); c.roundRect(x + 18, y + 18, 92, 92, 14); c.fill(); c.fillStyle = WHITE; c.font = `700 64px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(p ? (p.code || String(i + 1)) : String(i + 1), x + 64, y + 66); c.textAlign = 'left';
      const ds = p ? destsFor(st.id, p.gtfs) : []; const uniq = []; for (const d of ds) if (!uniq.some(q => q.dest === d.dest)) uniq.push(d);
      const txt = uniq.length ? uniq.map(d => short(stName(d.dest))).join(' · ') : 'Trains';
      c.fillStyle = DIM; c.font = `500 30px ${FONTB}`; c.fillText('Platform · Trains to', x + 136, y + 38);
      fit(c, txt, `600 #px ${FONT}`, w - 150 - uniq.length * 40, 56, 24); c.fillStyle = WHITE; c.fillText(txt, x + 136, y + 88);
      const ls = [...new Set(ds.map(d => d.line))]; ls.forEach((l, j) => bullet(c, x + w - 32 - j * 44, y + 64, 17, l));
    });
    yield;
    // wayfinding
    const way = (k, text, pic, dir) => { const [x, y, w, h] = R[k]; panel(c, x, y, w, h); pict(c, x + 64, y + 60, 84, pic); c.fillStyle = WHITE; c.textBaseline = 'middle'; fit(c, text, `600 #px ${FONT}`, w - 210, 58, 22); c.fillText(text, x + 122, y + 62); if (dir !== undefined) arrow(c, x + w - 58, y + 62, 72, dir); };
    way('exit', 'Street · Exit', 'exit', 1); way('gates', 'Fare gates', 'gates', 0); way('esc', 'Trains', 'esc', 3); way('elev', 'Elevator', 'elev', 0);
    // wordmark panel
    { const [x, y, w, h] = R.word; panel(c, x, y, w, h); wordmark(c, x + 30, y + 22, 84); }
    // totem face: mark + name stacked
    { const [x, y, w, h] = R.totem; c.fillStyle = NAVY; c.fillRect(x, y, w, h); mark(c, x + 48, y + 26, 160); c.fillStyle = WHITE; c.textAlign = 'center'; c.textBaseline = 'middle';
      const words = name.split(/\s+/); let yy = y + 226; const sz = fit(c, words.reduce((a, b) => a.length > b.length ? a : b, ''), `600 #px ${FONT}`, w - 24, 48, 20);
      c.font = `600 ${sz}px ${FONT}`; for (const wd of words.slice(0, 3)) { c.fillText(wd, x + w / 2, yy); yy += sz * 0.95; } c.textAlign = 'left'; }
    yield;
    // system map
    drawMap(c, R.map, st.id);
    yield;
    // info panel
    { const [x, y, w, h] = R.info; panel(c, x, y, w, h); mark(c, x + 24, y + 24, 72); c.fillStyle = WHITE; c.textBaseline = 'middle'; fit(c, name, `600 #px ${FONT}`, w - 150, 70, 26); c.fillText(name, x + 116, y + 60);
      c.fillStyle = DIM; c.font = `500 30px ${FONTB}`; c.fillText('Bayline Metro · unofficial', x + 116, y + 118);
      lines.forEach((l, i) => { bullet(c, x + 40 + i * 58, y + 160, 18, l); }); }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.generateMipmaps = true;
    const rect = {}; for (const k in R) { const [x, y, w, h] = R[k]; rect[k] = [x / AW, 1 - (y + h) / AH, (x + w) / AW, 1 - y / AH]; }
    const out = { tex, rect }; atlasCache.set(st.id, out);
    return out;
  }
  function releaseAtlas(st) { const a = atlasCache.get(st.id); if (a) { a.tex.dispose(); atlasCache.delete(st.id); } }

  // system map: stations at their real positions, lines drawn along pattern stop sequences, this station ringed
  let mapGeo = null, mapBase = null;
  function drawMap(c, R0, hereId) {
    const [x, y, w, h] = R0;
    if (!mapBase && typeof MetroNet !== 'undefined' && MetroNet.stations && MetroNet.stations.length) {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h; drawMap0(cv.getContext('2d'), [0, 0, w, h], null); mapBase = cv; }
    if (!mapBase) { drawMap0(c, R0, hereId); return; }
    c.drawImage(mapBase, x, y);
    const S = MetroNet.stationById[hereId] || (hereId && MetroNet.stationById[String(hereId).split('~')[0]]); if (!S || !mapGeo) return;
    const G = mapGeo, pad = 22, iw = w - pad * 2, ih = h - 44 - pad * 2; const k = Math.min(iw / (G.x1 - G.x0), ih / (G.z1 - G.z0));
    const X = x + pad + (S.x - G.x0) * k + (iw - (G.x1 - G.x0) * k) / 2, Y = y + 44 + pad + (S.z - G.z0) * k + (ih - (G.z1 - G.z0) * k) / 2;
    c.strokeStyle = '#d7263d'; c.lineWidth = 3; c.beginPath(); c.arc(X, Y, 9, 0, 7); c.stroke(); c.fillStyle = '#d7263d'; c.font = `700 18px ${FONTB}`; c.textBaseline = 'middle'; c.fillText('You are here', X + 12, Y - 10);
  }
  function drawMap0(c, [x, y, w, h], hereId) {
    c.fillStyle = '#f2f0ea'; c.fillRect(x, y, w, h); c.fillStyle = NAVY; c.fillRect(x, y, w, 44); wordmark(c, x + 12, y + 6, 32, WHITE);
    c.fillStyle = WHITE; c.font = `500 22px ${FONTB}`; c.textAlign = 'right'; c.textBaseline = 'middle'; c.fillText('System map', x + w - 14, y + 22); c.textAlign = 'left';
    if (typeof MetroNet === 'undefined' || !MetroNet.stations || !MetroNet.stations.length) return;
    if (!mapGeo) {
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const s of MetroNet.stations) { x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); z0 = Math.min(z0, s.z); z1 = Math.max(z1, s.z); }
      mapGeo = { x0, x1, z0, z1 };
    }
    const G = mapGeo, pad = 22, iw = w - pad * 2, ih = h - 44 - pad * 2; const k = Math.min(iw / (G.x1 - G.x0), ih / (G.z1 - G.z0));
    const px = (sx) => x + pad + (sx - G.x0) * k + (iw - (G.x1 - G.x0) * k) / 2, pz = (sz) => y + 44 + pad + (sz - G.z0) * k + (ih - (G.z1 - G.z0) * k) / 2;
    const pats = MetroNet.patterns || {}; const drawn = new Set(); const offs = { yellow: -2.2, orange: 2.2, green: 0, red: -1.1, blue: 1.1, grey: 0, ebart: 0 };
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const pid in pats) { const p = pats[pid]; if (drawn.has(p.line + p.dir)) continue; if (p.dir !== 1) continue; drawn.add(p.line + p.dir);
      c.strokeStyle = lineColor(p.line); c.lineWidth = 3.2; c.beginPath(); let first = true; const o = offs[p.line] || 0;
      for (const lg of p.legs || []) for (const s of lg.stops || []) { const S = MetroNet.stationById[s.station]; if (!S) continue; const X = px(S.x) + o, Y = pz(S.z) + o; if (first) { c.moveTo(X, Y); first = false; } else c.lineTo(X, Y); }
      c.stroke(); }
    for (const S of MetroNet.stations) { const X = px(S.x), Y = pz(S.z); c.fillStyle = '#fff'; c.strokeStyle = '#1b1b1b'; c.lineWidth = 1.6; c.beginPath(); c.arc(X, Y, 3.6, 0, 7); c.fill(); c.stroke();
      if (S.id === hereId) { c.strokeStyle = '#d7263d'; c.lineWidth = 3; c.beginPath(); c.arc(X, Y, 9, 0, 7); c.stroke(); c.fillStyle = '#d7263d'; c.font = `700 18px ${FONTB}`; c.fillText('You are here', X + 12, Y - 10); } }
  }

  // ------------------------------------------------------------------------------------------------ boards
  // board: { key, st, tex, ctx, rows, last, dirty }
  const boards = [];
  const BW = 768, BH = 192;
  function newBoard(st, key) {
    const cv = document.createElement('canvas'); cv.width = BW; cv.height = BH; const c = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const b = { key, st, tex, c, rows: null, last: '', dirty: true }; boards.push(b); drawBoard(b); return b;
  }
  function freeBoards(st) { for (let i = boards.length - 1; i >= 0; i--) if (boards[i].st === st) { boards[i].tex.dispose(); boards.splice(i, 1); } }
  function clockText() { const s = (typeof Env !== 'undefined' ? Env.time.sec : 0); const h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60; return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }
  function drawBoard(b) {
    const c = b.c; c.fillStyle = '#050608'; c.fillRect(0, 0, BW, BH);
    // header: platform number, clock
    c.fillStyle = '#10263b'; c.fillRect(0, 0, BW, 44); c.fillStyle = WHITE; c.font = `600 30px ${FONT}`; c.textBaseline = 'middle';
    c.fillText('Platform ' + b.key, 14, 23); c.textAlign = 'right'; c.fillText(clockText(), BW - 14, 23); c.textAlign = 'left';
    const ext = b.ext && performance.now() - b.ext < 90000;
    const rows = ext ? b.rows : (scheduledRows(b.st, b.key) || b.rows);
    if (!rows || !rows.length) {
      c.fillStyle = '#ffb21e'; c.font = `600 40px ${FONT}`; c.fillText(rows ? 'No trains scheduled' : b.st.name, 18, 92);
      c.fillStyle = 'rgba(255,178,30,0.65)'; c.font = `500 30px ${FONT}`; c.fillText(rows ? 'Check the system map' : 'Bayline Metro', 18, 146);
    } else {
      rows.slice(0, 3).forEach((r, i) => {
        const y = 70 + i * 46; const col = r.color || lineColor(r.line);
        c.fillStyle = col; c.beginPath(); c.arc(30, y, 14, 0, 7); c.fill();
        c.fillStyle = '#ffb21e'; c.font = `600 36px ${FONT}`; c.fillText(short(String(r.dest || '')).slice(0, 26), 56, y + 2);
        c.textAlign = 'right'; c.fillText(r.min <= 0 ? 'Arriving' : r.min + ' min', BW - 16, y + 2);
        if (r.cars) { c.fillStyle = 'rgba(255,178,30,0.7)'; c.font = `500 28px ${FONT}`; c.fillText(r.cars + ' car', BW - 150, y + 2); }
        c.textAlign = 'left';
      });
    }
    // LED screen texture: faint scanlines
    c.fillStyle = 'rgba(0,0,0,0.22)'; for (let y = 44; y < BH; y += 4) c.fillRect(0, y, BW, 1);
    b.tex.needsUpdate = true; b.dirty = false;
  }
  // rows pushed by SIM win for 90 s; otherwise the board shows the scheduled departures (the static timetable)
  function setBoard(st, key, rows) {
    const now = performance.now();
    for (const b of boards) if (b.st === st && (b.key === key || key === '*')) { b.rows = rows; b.ext = now; b.dirty = true; }
  }
  // ---------------------------------------------------------------- scheduled departures (fallback until SIM writes rows)
  let ttState = 0, depIndex = null, depDay = '';
  function ensureTimetable() {
    if (ttState || typeof MetroNet === 'undefined' || !MetroNet.loadTimetable) return;
    ttState = 1; MetroNet.loadTimetable().then(() => { ttState = 2; }, () => { ttState = 3; });
  }
  function ymdShift(ymd, days) { const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + days)); return d.toISOString().slice(0, 10).replace(/-/g, ''); }
  // gtfs platform id -> sorted [departure s (today's clock; yesterday's late trips shifted by -1 day), trip, leg index]
  function indexDepartures(ymd) {
    depIndex = new Map(); depDay = ymd;
    for (const [day, shift] of [[ymdShift(ymd, -1), -86400], [ymd, 0]]) {
      for (const t of MetroNet.tripsOn(day)) {
        const pat = MetroNet.patterns[t.pat]; if (!pat || !pat.legs) continue;
        pat.legs.forEach((leg, k) => { const times = t.legs && t.legs[k]; if (!times) return;
          leg.stops.forEach((s, i) => { if (i === leg.stops.length - 1 && k === pat.legs.length - 1) return;          // arriving at its terminus
            const dep = times[i * 2 + 1] + shift; if (!(dep > -3600)) return;
            let L = depIndex.get(s.gtfs); if (!L) depIndex.set(s.gtfs, L = []); L.push([dep, t, k]); }); });
      }
    }
    for (const L of depIndex.values()) L.sort((a, b) => a[0] - b[0]);
  }
  function scheduledRows(st, key) {
    if (ttState !== 2) { ensureTimetable(); return null; }
    const day = (typeof Env !== 'undefined' && Env.serviceDay) ? Env.serviceDay().ymd : '';
    if (!depIndex || depDay !== day) indexDepartures(day);
    const plat = ((st.data && st.data.platforms) || []).find(p => String(p.code) === String(key)); if (!plat) return [];
    const L = depIndex.get(plat.gtfs) || []; const now = (typeof Env !== 'undefined') ? Env.time.sec : 0;
    let lo = 0, hi = L.length; while (lo < hi) { const m = (lo + hi) >> 1; if (L[m][0] < now - 20) lo = m + 1; else hi = m; }
    const rows = [];
    for (let i = lo; i < L.length && rows.length < 3; i++) {
      const [dep, t, k] = L[i]; const pat = MetroNet.patterns[t.pat]; const lastLeg = pat.legs[pat.legs.length - 1]; const dest = lastLeg.stops[lastLeg.stops.length - 1].station;
      rows.push({ line: t.line, color: lineColor(t.line), dest: stName(dest), cars: (t.cars && t.cars[k]) || null, min: Math.max(0, Math.round((dep - now) / 60)) });
    }
    return rows;
  }
  let minute = -1, redrawI = 0;
  function update(dt) {
    const m = Math.floor((typeof Env !== 'undefined' ? Env.time.sec : 0) / 60);
    if (m !== minute || (ttState === 2 && !update.ttSeen)) { minute = m; if (ttState === 2) update.ttSeen = true; for (const b of boards) b.dirty = true; }
    if (boards.length) ensureTimetable();
    let n = 0; for (let k = 0; k < boards.length && n < 2; k++) { const b = boards[(redrawI + k) % boards.length]; if (b.dirty) { drawBoard(b); n++; } } redrawI = (redrawI + 1) % Math.max(1, boards.length);
  }

  return { stationAtlasGen, setScale, NAVY, TEAL, WHITE, init, stationAtlas, releaseAtlas, newBoard, freeBoards, setBoard, scheduledRows, update, linesAt, lineColor, destsFor, mark, wordmark, get lines() { return LINES; } };
})();
