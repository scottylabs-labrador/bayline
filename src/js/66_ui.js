// UI: HUD, line strip, cab panel, departure board, live map, missions, results, help, toasts.
const UI = (() => {
  const $ = (id) => document.getElementById(id);
  const el = {};
  const TAG = { LOCAL: 'L', LIMITED: 'Lim', EXPRESS: 'E', 'S.COUNTY': 'SC' };
  let boardStation = 0;
  let toastT = 0;
  function init() {
    for (const id of ['drivebar', 'cnotch', 'csbar', 'callow', 'clim', 'cguide', 'hud', 'hclock', 'hwhere', 'hsub', 'hmode', 'hspeed', 'hdot', 'hnet', 'strip', 'stripc', 'toast', 'prompt', 'cab', 'cspeed', 'climit', 'cmeter', 'cnext', 'cdist', 'cdelta', 'csig', 'cpax', 'cscore',
      'crosshair', 'board', 'bkicker', 'btitle', 'bbody', 'mapov', 'mapc', 'missions', 'mlist', 'result', 'rkicker', 'rtitle', 'rscore', 'rbody', 'help', 'keys']) el[id] = $(id);
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeAll()));
    document.querySelectorAll('.overlay').forEach(o => o.addEventListener('mousedown', (e) => { if (e.target === o) closeAll(); }));
    // keys list
    const K = [['1', 'Cab view'], ['2', 'Onboard: walk the train'], ['3', 'Chase camera'], ['4', 'Trackside camera'], ['5', 'Helicopter'], ['6', 'Walk on the ground'], ['7', 'Fly anywhere'], ['8', 'Orbit / overview'],
      ['WASD / arrows', 'Move · look with mouse'], ['Shift', 'Run / fly faster'], ['E', 'Board · step off · sit · stand'], ['Tab', 'Follow the next train'], ['B', 'Departure board (nearest station)'], ['M', 'Live map'], ['J', 'Missions'],
      ['− / =', 'Slow down / speed up time'], ['0', 'Back to live time'], ['V', 'Mute / unmute'], ['P', 'Photo mode (hide the interface)'], ['K', 'Weather: auto · clear · fog · cloudy · haze'], ['Esc', 'Release mouse / close'],
      ['Driving: W / S', 'Power / brake notches (W also closes the doors)'], ['X', 'Coast (neutral)'], ['O', 'Doors open / close'], ['Space', 'Horn'], ['G', 'Bell'], ['Q', 'Reverser (when stopped)'], ['Backspace', 'Emergency brake (R to release)'], ['A', 'Autopilot']];
    el.keys.innerHTML = K.map(([k, v]) => `<div><span>${v}</span><kbd>${k}</kbd></div>`).join('');
    initMap();
    // touch joystick: drives the same WASD keys the keyboard does (walk, fly, onboard)
    const joy = $('joy'), knob = joy.firstElementChild; let jid = null;
    const setKeys = (dx, dy) => { const K = Player.keys; const t = 0.35;
      (dy < -t ? K.add('KeyW') : K.delete('KeyW')); (dy > t ? K.add('KeyS') : K.delete('KeyS')); (dx < -t ? K.add('KeyA') : K.delete('KeyA')); (dx > t ? K.add('KeyD') : K.delete('KeyD')); };
    const move = (e) => { const r = joy.getBoundingClientRect(); let dx = (e.clientX - r.left - r.width / 2) / (r.width / 2), dy = (e.clientY - r.top - r.height / 2) / (r.height / 2); const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; } knob.style.transform = `translate(${dx * 34}px,${dy * 34}px)`; setKeys(dx, dy); };
    joy.addEventListener('pointerdown', (e) => { jid = e.pointerId; joy.setPointerCapture(jid); move(e); });
    joy.addEventListener('pointermove', (e) => { if (e.pointerId === jid) move(e); });
    const end = () => { jid = null; knob.style.transform = ''; setKeys(0, 0); };
    joy.addEventListener('pointerup', end); joy.addEventListener('pointercancel', end);
    el.joy = joy; el.touch = matchMedia('(pointer: coarse)').matches;
    // on-screen driving controls (mouse / touch): taps send the same keys as the keyboard; hold buttons hold
    el.drivebar.querySelectorAll('button').forEach(b => {
      const k = b.dataset.k;
      const down = (e) => { e.preventDefault(); if (b.dataset.hold) { Player.keys.add(k); b.classList.add('on'); } else Game.driveKeys(k); };
      const up = () => { if (b.dataset.hold) { Player.keys.delete(k); b.classList.remove('on'); } };
      b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up); b.addEventListener('pointerleave', up);
    });
    el.strip.addEventListener('click', (e) => { const r = el.stripc.getBoundingClientRect(); const y = (e.clientY - r.top) / r.height; const s = U.clamp((y - 0.03) / 0.94, 0, 1) * Track.length; const st = Track.stationNear(s, 3000); if (st) openBoard(st.idx); });
  }
  function closeAll() { for (const id of ['board', 'mapov', 'missions', 'result', 'help']) el[id].hidden = true; }
  const anyOpen = () => ['board', 'mapov', 'missions', 'result', 'help'].some(id => !el[id].hidden);
  function toast(msg, t = 3.2) { el.toast.textContent = msg; el.toast.classList.add('show'); toastT = t; }

  // ---------- departure board ----------
  function openBoard(si) {
    closeAll(); boardStation = si; const st = Stations.list[si];
    el.bkicker.innerHTML = `<select id="bsel" style="background:transparent;color:var(--red);border:none;font:inherit;letter-spacing:inherit;text-transform:uppercase;cursor:pointer">${Stations.list.map((s, i) => `<option value="${i}" ${i === si ? 'selected' : ''} style="color:#111">${s.name}</option>`).join('')}</select> · Departures`;
    $('bsel').onchange = (e) => openBoard(+e.target.value);
    el.btitle.textContent = st.name;
    const now = Env.time.sec; const deps = Sim.departures(si, now, 16);
    el.bbody.innerHTML = deps.length ? deps.map((d, i) => {
      const rs = Sim.routeShort(d.trip); const last = d.trip.stops[d.trip.stops.length - 1][0]; const n = d.trip.stops.length - 1 - d.k;
      const mins = Math.round((d.t - now) / 60);
      return `<tr data-i="${i}" style="cursor:pointer"><td>${Env.clockText(d.t)}</td><td>${d.trip.id}</td><td><span class="tag ${TAG[rs] || 'L'}">${rs}</span></td><td>${Sim.TT.names[Sim.TT.stations[last]]}</td><td>${n} stop${n === 1 ? '' : 's'}</td><td style="color:var(--ink-dim)">${mins <= 0 ? 'now' : mins < 90 ? mins + ' min' : ''}</td></tr>`;
    }).join('') : `<tr><td colspan="6" style="color:var(--ink-dim)">No more departures today. Try the Time menu: morning rush starts around 5 AM.</td></tr>`;
    el.bbody.querySelectorAll('tr[data-i]').forEach(tr => tr.addEventListener('click', (e) => { const d = deps[+tr.dataset.i]; closeAll(); if (e.shiftKey) Game.startDrive(d.plan, { fromK: d.k }); else rideDeparture(d); }));
    el.board.hidden = false; Player.releaseLock();
  }
  function rideDeparture(d) {
    // appear on the right platform ~70 s before the train's departure (it arrives ~40 s before that)
    const now = Env.time.sec; if (d.t - now > 100 || d.t < now) Env.setClock(d.t - 75); Env.time.scale = 1;
    const st = Stations.list[d.trip.stops[d.k][0]]; Player.teleportToStation(st, d.dir);
    Player.setFocus(d.plan.key);
    toast(`Wait for the ${Sim.routeShort(d.trip).toLowerCase()} to ${Sim.TT.names[Sim.TT.stations[d.trip.stops[d.trip.stops.length - 1][0]]]}; press E at an open door to board`, 6);
  }

  // ---------- missions ----------
  function openMissions(filter) {
    closeAll();
    const L = Game.missionList().filter(m => !filter || m.kind === filter || filter === 'all');
    el.mlist.innerHTML = L.map((m, i) => `<button class="m" data-i="${i}"><b>${m.title}</b><small>${m.sub}</small><div style="margin-top:6px"><span class="tag ${m.kind === 'drive' ? 'E' : m.kind === 'commute' ? 'Lim' : 'SC'}">${m.kind.toUpperCase()}</span></div></button>`).join('')
      + `<button class="m" data-free="1"><b>Any train</b><small>Pick any departure from any station's board. Shift+click to drive it.</small></button>`;
    el.mlist.querySelectorAll('.m').forEach(b => b.addEventListener('click', () => { closeAll(); if (b.dataset.free) { const st = Stations.nearest(Env.camera.position, 1e9) || Stations.list[0]; openBoard(st.idx); return; } Game.startMission(L[+b.dataset.i]); }));
    el.missions.hidden = false; Player.releaseLock();
  }
  function showResult(r) {
    closeAll(); el.rkicker.textContent = r.kicker; el.rtitle.textContent = r.title; el.rscore.innerHTML = `${r.score}<span style="font-size:18px;color:var(--ink-dim);margin-left:12px">${r.grade}</span>`;
    el.rbody.innerHTML = r.lines.map(l => `<div>${l}</div>`).join(''); el.result.hidden = false; Player.releaseLock();
  }

  // ---------- live map ----------
  const map = { cx: 0, cz: 0, scale: 0.006, drag: null, pts: null };
  function initMap() {
    const c = el.mapc;
    c.addEventListener('wheel', (e) => { e.preventDefault(); const k = e.deltaY > 0 ? 0.85 : 1.18; const r = c.getBoundingClientRect(); const mx = (e.clientX - r.left) * devicePixelRatio, my = (e.clientY - r.top) * devicePixelRatio;
      const wx = map.cx + (mx - c.width / 2) / map.scale, wz = map.cz + (my - c.height / 2) / map.scale; map.scale = U.clamp(map.scale * k, 0.002, 0.5); map.cx = wx - (mx - c.width / 2) / map.scale; map.cz = wz - (my - c.height / 2) / map.scale; }, { passive: false });
    c.addEventListener('mousedown', (e) => { map.drag = { x: e.clientX, y: e.clientY, moved: 0 }; });
    window.addEventListener('mousemove', (e) => { if (!map.drag) return; const dx = e.clientX - map.drag.x, dy = e.clientY - map.drag.y; map.drag.moved += Math.abs(dx) + Math.abs(dy); map.drag.x = e.clientX; map.drag.y = e.clientY; map.cx -= dx * devicePixelRatio / map.scale; map.cz -= dy * devicePixelRatio / map.scale; });
    window.addEventListener('mouseup', (e) => { if (!map.drag) return; const click = map.drag.moved < 5; map.drag = null; if (click && !el.mapov.hidden) mapClick(e); });
  }
  // map imagery cache (its own ImageBitmaps; the terrain frees its copies after GPU upload)
  const mapCache = new Map(); let mapUse = 0;
  function mapImg(L, x, y, request) {
    const k = L + '/' + x + '_' + y; let e = mapCache.get(k);
    if (e) { e.used = ++mapUse; return e.img; }
    if (!request) return null;
    e = { img: null, used: ++mapUse }; mapCache.set(k, e);
    Stream.image('tiles/img/' + L + '/' + x + '_' + y + '.jpg', 1).then(b => { e.img = b; }, () => {});
    if (mapCache.size > 160) { const old = [...mapCache.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 40); for (const [kk, v] of old) { if (v.img && v.img.close) v.img.close(); mapCache.delete(kk); } }
    return null;
  }
  function w2m(x, z, c) { return [(x - map.cx) * map.scale + c.width / 2, (z - map.cz) * map.scale + c.height / 2]; }
  function mapClick(e) {
    const c = el.mapc, r = c.getBoundingClientRect(); const mx = (e.clientX - r.left) * devicePixelRatio, my = (e.clientY - r.top) * devicePixelRatio;
    let best = null, bd = 16 * devicePixelRatio;
    for (const tr of Sim.running) { const [x, y] = w2m(tr.x, tr.z, c); const d = Math.hypot(x - mx, y - my); if (d < bd) { bd = d; best = { tr }; } }
    for (const st of Stations.list) { const [x, y] = w2m(st.x, st.z, c); const d = Math.hypot(x - mx, y - my); if (d < bd * 0.8) { bd = d; best = { st }; } }
    if (!best) return;
    closeAll();
    if (best.tr) { Player.setFocus(best.tr.key); Player.setMode('chase'); toast('Following ' + Sim.destText(best.tr).replace(/\s+/g, ' ')); }
    else { Player.teleportToStation(best.st, 1); toast(best.st.name); }
  }
  function openMap() {
    closeAll(); el.mapov.hidden = false; Player.releaseLock();
    const c = el.mapc; const r = c.getBoundingClientRect(); c.width = r.width * devicePixelRatio; c.height = r.height * devicePixelRatio;
    const p = Env.camera.position; map.cx = p.x; map.cz = p.z; map.scale = Math.min(c.width / 36000, c.height / 30000);
    if (!map.pts) { map.pts = []; for (let s = 0; s < Track.length; s += 120) { const f = {}; Track.frame(s, f); map.pts.push([f.x, f.z]); } }
  }
  function drawMap() {
    const c = el.mapc, g = c.getContext('2d'); const W = c.width, H = c.height; const dpr = devicePixelRatio;
    g.fillStyle = '#10161d'; g.fillRect(0, 0, W, H);
    // satellite base map: the same NAIP tiles the terrain streams, at a level that fits the zoom
    const tiled = Terrain.tiled; let drewPhoto = false;
    if (tiled) {
      const T0 = Terrain.TILE; const pxPerM = map.scale; let L = 0;
      while (L < 8 && Terrain.tileSize(L) * pxPerM > 420) L++;
      const T = Terrain.tileSize(L), n = 1 << L;
      const wx0 = map.cx - W / 2 / pxPerM, wz0 = map.cz - H / 2 / pxPerM, wx1 = map.cx + W / 2 / pxPerM, wz1 = map.cz + H / 2 / pxPerM;
      const tx0 = Math.max(0, Math.floor((wx0 - T0.X0) / T)), tx1 = Math.min(n - 1, Math.floor((wx1 - T0.X0) / T)), ty0 = Math.max(0, Math.floor((wz0 - T0.Z0) / T)), ty1 = Math.min(n - 1, Math.floor((wz1 - T0.Z0) / T));
      g.imageSmoothingQuality = 'high';
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        // draw the finest cached image at or above this level
        let l = L, x = tx, y = ty, img = null;
        for (; l >= 0; l--, x >>= 1, y >>= 1) { const im = mapImg(l, x, y, l === L); if (im) { img = im; break; } }
        if (!img) continue; drewPhoto = true;
        const TL = Terrain.tileSize(l), s = T / TL, sx = (tx * T - x * TL) / TL * 512, sy = (ty * T - y * TL) / TL * 512;
        const [px, py] = w2m(T0.X0 + tx * T, T0.Z0 + ty * T, c);
        g.drawImage(img, sx, sy, 512 * s, 512 * s, Math.floor(px), Math.floor(py), Math.ceil(T * pxPerM) + 1, Math.ceil(T * pxPerM) + 1);
      }
      g.fillStyle = 'rgba(8,12,16,0.28)'; g.fillRect(0, 0, W, H);   // dim a little so the line and trains read
    }
    if (!drewPhoto) {
      const step = Math.max(6, Math.round(9 * dpr));
      for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
        const wx = map.cx + (x - W / 2) / map.scale, wz = map.cz + (y - H / 2) / map.scale;
        if (Terrain.isWater(wx, wz)) { g.fillStyle = '#16354a'; g.fillRect(x, y, step, step); }
        else { const u = Terrain.urbanAt(wx, wz); const h = Terrain.h(wx, wz); g.fillStyle = u > 0.3 ? `rgba(120,110,95,${0.25 + u * 0.25})` : `rgba(${80 + Math.min(h, 600) / 6},${90 + Math.min(h, 600) / 10},60,0.35)`; g.fillRect(x, y, step, step); }
      }
    }
    // line
    g.lineWidth = 3 * dpr; g.strokeStyle = '#e8e2d4'; g.beginPath(); map.pts.forEach(([x, z], i) => { const [a, b] = w2m(x, z, c); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke();
    // stations
    g.font = `${12 * dpr}px Barlow, sans-serif`; g.textBaseline = 'middle';
    for (const st of Stations.list) { const [x, y] = w2m(st.x, st.z, c); g.fillStyle = '#101418'; g.strokeStyle = '#e8e2d4'; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(x, y, 5 * dpr, 0, 7); g.fill(); g.stroke();
      if (map.scale > 0.004 || ['san_francisco', 'place_MLBR', 'hillsdale', 'redwood_city', 'palo_alto', 'mountain_view', 'sj_diridon', 'gilroy', 'san_mateo', 'sunnyvale', 'tamien', 'morgan_hill'].includes(st.id)) { g.fillStyle = '#c9c4b8'; g.fillText(st.name, x + 9 * dpr, y); } }
    // landmarks
    if (World.landmarks && map.scale > 0.01) { g.fillStyle = '#e9c46a'; for (const l of World.landmarks.list) { const [x, y] = w2m(l.x, l.z, c); g.fillRect(x - 2 * dpr, y - 2 * dpr, 4 * dpr, 4 * dpr); g.fillText(l.name, x + 6 * dpr, y); } }
    // trains
    for (const tr of Sim.running) { const [x, y] = w2m(tr.x, tr.z, c); g.fillStyle = tr.remote ? tr.remote.color : Sim.routeColor(tr.trip); g.beginPath(); g.arc(x, y, (tr.key === Player.focus ? 8 : 6) * dpr, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.font = `600 ${11 * dpr}px "IBM Plex Mono", monospace`; g.fillText((tr.dir ? '▼ ' : '▲ ') + tr.trip.id + (tr.driven ? ' (you)' : tr.remote ? ' ' + tr.remote.name : ''), x + 10 * dpr, y - 8 * dpr); g.font = `${12 * dpr}px Barlow, sans-serif`; }
    // players
    if (typeof Net !== 'undefined') for (const o of Net.others()) { if (o.modeName === 'ride' || o.modeName === 'drive' || o.modeName === 'cab') continue; const [x, y] = w2m(o.x, o.z, c); g.fillStyle = o.color; g.beginPath(); g.arc(x, y, 4 * dpr, 0, 7); g.fill(); g.fillText(o.name, x + 7 * dpr, y); }
    // you
    const p = Env.camera.position; const [x, y] = w2m(p.x, p.z, c); g.strokeStyle = '#ff5a3c'; g.lineWidth = 2.5 * dpr; g.beginPath(); g.arc(x, y, 9 * dpr, 0, 7); g.stroke(); g.fillStyle = '#ff5a3c'; g.fillText('You', x + 12 * dpr, y + 12 * dpr);
    // scale bar
    const km = map.scale * 1000; g.fillStyle = '#c9c4b8'; g.fillRect(20 * dpr, H - 24 * dpr, km * 5, 2 * dpr); g.fillText('5 km', 20 * dpr, H - 36 * dpr);
  }

  // ---------- line strip ----------
  function drawStrip() {
    const c = el.stripc; const r = c.getBoundingClientRect(); const dpr = devicePixelRatio;
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const g = c.getContext('2d'), W = c.width, H = c.height; g.clearRect(0, 0, W, H);
    const Y = (s) => (0.03 + 0.94 * s / Track.length) * H, X = 22 * dpr;
    g.strokeStyle = 'rgba(243,239,230,.35)'; g.lineWidth = 2 * dpr; g.beginPath(); g.moveTo(X, Y(0)); g.lineTo(X, Y(Track.length)); g.stroke();
    g.font = `${10.5 * dpr}px Barlow, sans-serif`; g.textBaseline = 'middle';
    let lastY = -1e9; const camS = (Track.nearest(Env.camera.position.x, Env.camera.position.z, 3000) || {}).s;
    for (const st of Stations.list) { const y = Y(st.s); g.fillStyle = 'rgba(243,239,230,.8)'; g.fillRect(X - 3 * dpr, y - 0.5 * dpr, 6 * dpr, 1.5 * dpr); if (y - lastY > 11 * dpr) { g.fillStyle = 'rgba(243,239,230,.55)'; g.fillText(st.name.replace(' San Francisco', ' SF'), X + 26 * dpr, y); lastY = y; } }
    for (const tr of Sim.running) { const y = Y(tr.s); const x = X + (tr.dir ? 8 : -8) * dpr; g.fillStyle = tr.remote ? tr.remote.color : Sim.routeColor(tr.trip); g.beginPath();
      if (tr.dir) { g.moveTo(x - 4 * dpr, y - 5 * dpr); g.lineTo(x + 4 * dpr, y - 5 * dpr); g.lineTo(x, y + 3 * dpr); } else { g.moveTo(x - 4 * dpr, y + 5 * dpr); g.lineTo(x + 4 * dpr, y + 5 * dpr); g.lineTo(x, y - 3 * dpr); } g.fill();
      if (tr.key === Player.focus) { g.strokeStyle = '#fff'; g.lineWidth = 1.5 * dpr; g.strokeRect(x - 6 * dpr, y - 7 * dpr, 12 * dpr, 12 * dpr); } }
    if (camS !== undefined) { const y = Y(camS); g.fillStyle = '#ff5a3c'; g.beginPath(); g.arc(X, y, 3.5 * dpr, 0, 7); g.fill(); }
  }

  // ---------- per frame ----------
  let slow = 0;
  function whereText() {
    const p = Env.camera.position; const n = Track.nearest(p.x, p.z, 4000);
    if (!n) { const st = Stations.nearest(p, 1e9); return st ? `${(Math.hypot(st.x - p.x, st.z - p.z) / 1000).toFixed(1)} km from ${st.name}` : ''; }
    const st = Track.stationNear(n.s, 400); if (st) return st.name;
    let a = null, b = null; for (const s of Stations.list) { if (s.s <= n.s) a = s; else { b = s; break; } }
    return a && b ? `Between ${a.name} and ${b.name}` : (a || b || {}).name || '';
  }
  function update(dt) {
    if (toastT > 0) { toastT -= dt; if (toastT <= 0) el.toast.classList.remove('show'); }
    slow -= dt; const tick = slow <= 0; if (tick) slow = 0.2;
    const t = Env.time.sec;
    if (tick) {
      const s = Math.floor(t % 60); el.hclock.innerHTML = Env.clockText(t).replace(' ', `<span style="font-size:15px;color:var(--ink-dim)">:${String(s).padStart(2, '0')} </span>`);
      el.hwhere.textContent = whereText();
      const tr = Player.focusTrain(); let sub = '';
      if (tr) { const ns = tr.plan && tr.seg ? tr.trip.stops[Sim.nextStopK(tr.plan, tr.seg)] : null; sub = `${Sim.routeShort(tr.trip)} ${tr.trip.id} → ${(Sim.TT.names[Sim.TT.stations[(tr.trip.stops[tr.trip.stops.length - 1] || [0])[0]]] || '')} · ${Math.round(tr.v / Sim.MPH)} mph${ns ? ' · next ' + Sim.TT.names[Sim.TT.stations[ns[0]]] : ''}`; }
      else sub = `${Sim.running.length} trains running · ${Env.serviceDay().kind === 'wkday' ? 'weekday' : 'weekend'} timetable`;
      el.hsub.textContent = sub;
      const names = { cab: 'Cab', onboard: 'Onboard', chase: 'Chase', trackside: 'Trackside', heli: 'Helicopter', walk: 'On foot', fly: 'Flying', orbit: 'Overview' };
      el.hmode.textContent = (Sim.drive ? 'Driving · ' : '') + (names[Player.mode] || Player.mode);
      el.hspeed.textContent = Env.time.live && Env.time.scale === 1 ? 'Live' : (Env.time.scale + '×');
      if (typeof Net !== 'undefined') { el.hnet.textContent = Net.status.text || 'Solo'; el.hdot.classList.toggle('on', !!Net.status.online); }
      drawStrip();
      // cab panel
      const D = Sim.drive; const showCab = !!D || Player.mode === 'onboard';   // riding in the cab: the desk displays say it all
      el.cab.hidden = !showCab; el.drivebar.hidden = !D; el.strip.hidden = !!D;
      if (showCab) {
        const trr = D ? Sim.trainByKey(D.plan.key) : tr; const v = D ? D.v : trr ? trr.v : 0; const s = D ? D.s : trr ? trr.s : 0;
        el.cspeed.textContent = Math.round(v / Sim.MPH); el.climit.textContent = 'limit ' + Math.round(Track.limit(s) / Sim.MPH);
        const lev = D ? D.lever : 0; el.cmeter.style.left = lev >= 0 ? '50%' : (50 + lev * 50) + '%'; el.cmeter.style.width = Math.abs(lev) * 50 + '%'; el.cmeter.style.background = lev >= 0 ? 'var(--green)' : 'var(--red)';
        const dm = D && Game.dmi ? Game.dmi() : null;
        el.cnotch.hidden = !dm; el.cguide.hidden = !dm;
        if (dm) {
          el.cnotch.textContent = dm.reverse ? 'R ' + dm.notch : dm.notch; el.cnotch.className = 'notch ' + (dm.notch === 'EB' ? 'eb' : dm.notch[0] === 'P' ? 'p' : dm.notch[0] === 'B' ? 'b' : '');
          const top = 90 * Sim.MPH; el.csbar.style.width = Math.min(100, v / top * 100) + '%'; el.callow.style.left = Math.min(99, dm.vAllow / top * 100) + '%'; el.clim.style.left = Math.min(99, dm.lim / top * 100) + '%';
          el.csbar.style.background = dm.ptc === 'enforce' ? '#ff5a4a' : dm.ptc === 'warn' ? '#ffc53d' : '#dfe6ee';
          el.cguide.textContent = dm.guide; el.cguide.className = 'guide' + (dm.ptc === 'enforce' || dm.guide.startsWith('EMERG') || dm.guide.startsWith('BRAKE NOW') ? ' alarm' : dm.ptc === 'warn' || dm.guide.startsWith('Start braking') ? ' warn' : '');
        }
        if (D && Game.run) {
          const inf = Game.stopInfo(); el.cnext.textContent = inf ? inf.name : '—';
          el.cdist.textContent = inf ? (inf.togo > 1000 ? (inf.togo / 1609.34).toFixed(1) + ' mi' : Math.round(inf.togo * 3.281) + ' ft') : '—';
          if (inf) { const late = t - inf.sched; el.cdelta.innerHTML = `<span class="${late > 60 ? 'late' : late < -120 ? 'early' : 'ontime'}">${Env.clockText(inf.sched)} (${late > 0 ? '+' : ''}${Math.round(late / 60)}m)</span>`; } else el.cdelta.textContent = '—';
          const sg = TrackGeo.nextSignal(s, D.dir); el.csig.innerHTML = sg ? `<span style="color:${['#ff5a4a', '#ffc53d', '#6fe39a'][sg.aspect]}">●</span> ${Math.round(sg.dist * 3.281)} ft` : '—';
          el.cpax.textContent = Game.run.pax; el.cscore.textContent = Math.round(Game.run.score) + (D.auto ? ' · AUTO' : '') + (D.penalty ? ' · PTC' : '') + (D.emergency ? ' · EMERG' : '') + (D.doors > 0 ? ' · DOORS' : '');
        } else if (trr && trr.plan && trr.seg) {
          const k = Sim.nextStopK(trr.plan, trr.seg); const ns = trr.trip.stops[k];
          el.cnext.textContent = ns ? Sim.TT.names[Sim.TT.stations[ns[0]]] : '—';
          const togo = ns ? Math.abs(Sim.stopS(ns[0], trr.dir) - trr.s) : 0; el.cdist.textContent = ns ? (togo > 1000 ? (togo / 1609.34).toFixed(1) + ' mi' : Math.round(togo * 3.281) + ' ft') : '—';
          el.cdelta.textContent = ns ? Env.clockText(ns[2] + trr.plan.dayOff) : '—';
          const sg = TrackGeo.nextSignal(trr.s, trr.dir); el.csig.innerHTML = sg ? `<span style="color:${['#ff5a4a', '#ffc53d', '#6fe39a'][sg.aspect]}">●</span>` : '—';
          el.cpax.textContent = '—'; el.cscore.textContent = Player.mode === 'onboard' ? `car ${Player.ob.car + 1}` : '—';
        }
      }
    }
    // prompt
    const pr = Player.prompt; if (pr !== el.prompt._t) { el.prompt._t = pr; el.prompt.innerHTML = pr; el.prompt.hidden = !pr; }
    el.crosshair.hidden = !(Player.mode === 'walk' || Player.mode === 'onboard' || Player.mode === 'fly');
    if (el.touch) el.joy.hidden = !(Player.mode === 'walk' || Player.mode === 'onboard' || Player.mode === 'fly') || anyOpen();
    if (!el.mapov.hidden) drawMap();
  }
  return { init, update, toast, openBoard, openMissions, openMap, showResult, closeAll, anyOpen, get boardStation() { return boardStation; } };
})();
