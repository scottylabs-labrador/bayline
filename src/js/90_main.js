// Boot: load data, build the world, title card, main loop, keyboard, sound + multiplayer wiring.
const World = { landmarks: null, air: null, birds: null, traffic: null, started: false };
(async () => {
  const $ = (id) => document.getElementById(id);
  const loadbar = $('loadbar'), loadmsg = $('loadmsg');
  const hash = new URLSearchParams(location.hash.slice(1));
  let prog = 0; const step = (p, msg) => { prog = p; loadbar.style.width = (p * 100).toFixed(0) + '%'; if (msg) loadmsg.textContent = msg; return new Promise(r => setTimeout(r, 0)); };
  const safe = (name, f) => { try { return f(); } catch (e) { console.error(name, e); return null; } };
  const safeA = async (name, f) => { try { return await f(); } catch (e) { console.error(name, e); return null; } };
  try {
    if (hash.get('t')) { const [h, m] = hash.get('t').split(':').map(Number); Env.setClock(h * 3600 + (m || 0) * 60); } else Env.goLive();
    await step(0.04, 'Unfolding the Peninsula…');
    await Terrain.load((f) => { loadbar.style.width = (4 + f * 36).toFixed(0) + '%'; });
    await step(0.42, 'Laying 124 km of track…');
    await Track.load();
    await step(0.5, 'Building stations…');
    Stations.init();
    TrackGeo.init();
    await step(0.58, 'Reading the timetable…');
    await Sim.init();
    const keepOut = (x, z) => { const L = World.landmarks; if (!L) return false; for (const l of L.list) { const r = l.radius || 0; if (r > 0 && Math.abs(x - l.x) < r && Math.abs(z - l.z) < r && Math.hypot(x - l.x, z - l.z) < r) return true; } return false; };
    const ctx = { ll2w: Geo.ll2w, groundY: (x, z) => Terrain.h(x, z), trackDist: (x, z) => Track.dist(x, z), rng: U.rng(7), isWater: (x, z) => Terrain.isWater(x, z), keepOut,
      stationList: Stations.list.map(s => ({ id: s.id, name: s.name, x: s.x, z: s.z, s: s.s })) };
    if (typeof Towns !== 'undefined') { await step(0.64, 'Raising the towns…'); await safeA('towns', async () => { await Towns.init(ctx); Env.scene.add(Towns.group); }); }
    if (typeof Landmarks !== 'undefined') { await step(0.8, 'Placing landmarks…'); World.landmarks = safe('landmarks', () => { const L = Landmarks.stream ? Landmarks.stream(ctx) : Landmarks.build(ctx); Env.scene.add(L.group); return L; }); }
    if (typeof Life !== 'undefined') {
      await step(0.88, 'Waking up the Bay…');
      World.air = safe('air', () => { const a = Life.createAirTraffic && Life.createAirTraffic(ctx); if (a) Env.scene.add(a.group); return a; });
      World.birds = safe('birds', () => { const b = Life.createBirds && Life.createBirds(ctx); if (b) Env.scene.add(b.group); return b; });
      World.traffic = safe('traffic', () => { const t = Life.createTraffic && typeof Towns !== 'undefined' ? Life.createTraffic([], { maxCars: 420 }) : null; if (t) { Env.scene.add(t.group); t.cx = 1e9; t.cz = 1e9; t.tick = 0; t.retries = 0; } return t; });
    }
    if (typeof Flora !== 'undefined' && Flora.init) { await step(0.92, 'Planting every tree…'); await safeA('flora', async () => { await Flora.init(ctx); if (Flora.group) Env.scene.add(Flora.group); }); }
    safe('groundcover', () => { if (typeof GroundCover !== 'undefined') GroundCover.init(); });
    safe('boats', () => { if (typeof Boats !== 'undefined') Boats.init(); });
    safe('globe', () => { if (typeof Globe !== 'undefined') Globe.init(); });
    safe('airports', () => { if (typeof Airports !== 'undefined') { Airports.init(); Airports.load().then(() => Globe.invalidate()).catch(e => console.warn('airports', e)); } });
    UI.init(); Player.init();
    safe('flight', () => { if (typeof Flight !== 'undefined') { FHud.init(); Flight.init(); } });
    await step(0.96, 'Warming up…');
  } catch (e) { console.error(e); loadmsg.textContent = 'Something went wrong: ' + e.message; return; }

  // ---------- title / start ----------
  const title = $('title'), hud = $('hud');
  let started = false;
  function pickCinematic() {
    const pref = ['hillsdale', 'belmont', 'san_carlos', 'palo_alto', 'burlingame', 'menlo_park', 'sunnyvale'];
    let best = null, bd = 1e9;
    for (const tr of Sim.running) { if (tr.seg && tr.seg.kind === 0) continue; for (const id of pref) { const st = Track.byId[id]; const d = Math.abs(st.s - tr.s); if (d < bd) { bd = d; best = tr; } } }
    if (best) { Player.setFocus(best.key); Player.setMode('heli'); return; }
    const st = Stations.list[Track.byId.palo_alto.idx]; Player.setMode('orbit', { target: { x: st.x, y: st.y, z: st.z }, dist: 420 }); Player.orbit.pitch = 0.32;
  }
  // title-screen cinematics: helicopter on a real train, a slow drone orbit of a landmark, a trackside pass
  const HERO = ['Salesforce Tower', 'Golden Gate Bridge', 'Hoover Tower', "Levi's Stadium", 'Bay Bridge (West Span)', 'Oracle Park', 'Coit Tower', 'Apple Park', 'Transamerica Pyramid', 'Main Quad & Memorial Church',
    'Sutro Tower', 'Alcatraz Island', 'Ferry Building', 'Bay Bridge (East Span)', 'Painted Ladies'];
  let cineT = 14, cineI = 0;
  function nextShot() {
    cineI = (cineI + 1) % 3;
    if (cineI === 1 && World.landmarks) {
      const L = World.landmarks.list.filter(l => HERO.includes(l.name)); const l = L[Math.floor(Math.random() * L.length)];
      if (l) { Player.setMode('orbit', { target: { x: l.x, y: (l.y || Terrain.h(l.x, l.z)) + Math.min(120, (l.top || 60) * 0.45), z: l.z }, dist: Math.max(420, (l.radius || 150) * 3.2) }); Player.orbit.pitch = 0.22; Player.orbit.yaw = Math.random() * 6.28; return; }
    }
    if (cineI === 2) { const tr = Sim.running.filter(t => t.v > 8).sort((a, b) => a.dist - b.dist)[0]; if (tr) { Player.setFocus(tr.key); Player.setMode('trackside'); return; } }
    pickCinematic();
  }
  function cinematics(dt) { cineT -= dt; if (cineT <= 0) { cineT = 17; nextShot(); } if (Player.mode === 'orbit') Player.orbit.yaw += dt * 0.035; }
  // first frame state so the title card has something beautiful behind it
  Sim.update(0.016, Env.camera.position);
  pickCinematic();
  $('loading').style.opacity = 0; setTimeout(() => $('loading').remove(), 700);
  const chips = document.querySelectorAll('#timechips .chip[data-t]');
  chips.forEach(ch => ch.addEventListener('click', () => { chips.forEach(c => c.classList.remove('on')); ch.classList.add('on'); const v = ch.dataset.t; if (v === 'now') Env.goLive(); else { const [h, m] = v.split(':').map(Number); Env.setClock(h * 3600 + m * 60); Env.time.scale = 1; } Sim.update(0.016, Env.camera.position); if (!started) pickCinematic(); }));
  const wxc = document.querySelectorAll('#wxchips .chip[data-w]');
  wxc.forEach(ch => ch.addEventListener('click', () => { wxc.forEach(c => c.classList.remove('on')); ch.classList.add('on'); if (Env.state) Env.state.weather = ch.dataset.w; }));
  let wantNet = location.protocol.startsWith('http');
  const mpchip = $('mpchip'); const setMpText = () => { $('mptext').textContent = wantNet ? (typeof Net !== 'undefined' ? Net.status.text || 'Online' : 'Online') : 'Solo'; $('mpdot').classList.toggle('on', wantNet && typeof Net !== 'undefined' && Net.status.online); };
  mpchip.addEventListener('click', () => { wantNet = !wantNet; if (typeof Net !== 'undefined') { if (wantNet) Net.connect(); else Net.disconnect(); } setMpText(); });
  if (typeof Net !== 'undefined' && wantNet) { safe('net', () => { Net.onStatus(() => setMpText()); Net.connect(); }); }
  setMpText();
  function start(mode) {
    if (started) return; started = true; World.started = true;
    safe('sound', () => { if (typeof Sound !== 'undefined') Sound.init(); });
    title.style.opacity = 0; setTimeout(() => { title.hidden = true; }, 500); hud.hidden = false;
    if (mode === 'fly') { if (typeof Flight !== 'undefined' && !Flight.active && !Flight.loading) FHud.setup(true); }
    else if (mode === 'ride') { const near = Stations.nearest(Env.camera.position, 1e9) || Stations.list[0]; UI.openBoard(near.idx); UI.toast('Pick a departure to ride. The whole line runs live.', 5); }
    else if (mode === 'drive') { UI.openMissions('drive'); }
    else { if (Player.mode === 'heli') Player.setMode('chase'); UI.toast('Explore: 1–8 change the view · M map · B departures · J missions · H help', 7); }
  }
  document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => start(b.dataset.go)));
  if (hash.has('auto')) { start('explore'); } else title.hidden = false;
  if (['auto', 'clear', 'fog', 'cloudy', 'haze'].includes(hash.get('w')) && Env.state) { Env.state.weather = hash.get('w'); wxc.forEach(c => c.classList.toggle('on', c.dataset.w === hash.get('w'))); }   // #w=fog etc.
  if (hash.get('at')) { const st = Track.byId[hash.get('at')]; if (st) Player.teleportToStation(Stations.list[st.idx], +(hash.get('dir') || 1)); }
  if (hash.get('cam')) { const m = hash.get('cam'); const atSt = Track.byId[hash.get('at')]; if (m === 'orbit' && atSt) { const st = Stations.list[atSt.idx]; Player.setMode('orbit', { target: { x: st.x, y: st.y, z: st.z }, dist: +(hash.get('dist') || 300) }); } else Player.setMode(m); }
  if (hash.get('s')) { const f = {}; Track.frame(+hash.get('s'), f); Player.setMode('orbit', { target: { x: f.x, y: f.y, z: f.z }, dist: +(hash.get('dist') || 120) }); if (hash.get('yaw')) Player.orbit.yaw = +hash.get('yaw'); if (hash.get('pitch')) Player.orbit.pitch = +hash.get('pitch'); }
  if (hash.get('ll')) {   // #ll=lat,lon[,altitude m,yaw,pitch]: fly camera at a shared viewpoint
    const [la, lo, al, yw, pt] = hash.get('ll').split(',').map(Number);
    if (isFinite(la) && isFinite(lo)) { const w = Geo.ll2w(la, lo); Player.setMode('fly'); Player.fly.x = w.x; Player.fly.z = w.z; Player.fly.y = isFinite(al) ? al : Terrain.h(w.x, w.z) + 150;
      if (isFinite(yw)) Player.look.yaw = yw; if (isFinite(pt)) Player.look.pitch = pt; }
  }
  if (hash.get('drive')) { const p = Sim.planById(hash.get('drive')); if (p) Game.startDrive(p, { auto: hash.has('autopilot') }); }
  if (hash.get('fly') && typeof Flight !== 'undefined') { if (!started) start('explore'); Flight.fromHash(hash.get('fly')).catch(e => console.error('fly', e)); }
  const hfly = $('hfly'); if (hfly) hfly.addEventListener('click', () => { if (typeof Flight !== 'undefined') { if (Flight.active) FHud.menu(true); else FHud.setup(true); } });

  // ---------- keyboard ----------
  const scales = [1, 2, 5, 10, 30, 60, 120];
  window.addEventListener('keydown', (e) => {
    if (!started) { if (e.code === 'Enter') start('explore'); return; }
    if (e.repeat && !['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown'].includes(e.code)) return;
    const c = e.code;
    if (c === 'Escape') { UI.closeAll(); return; }
    if (c === 'KeyH') { const h = $('help'); const was = h.hidden; UI.closeAll(); h.hidden = !was; Player.releaseLock(); return; }
    if (c === 'KeyM') { const was = $('mapov').hidden; UI.closeAll(); if (was) UI.openMap(); return; }
    if (c === 'KeyJ') { const was = $('missions').hidden; UI.closeAll(); if (was) UI.openMissions('all'); return; }
    if (c === 'KeyB' && !Sim.drive) { const was = $('board').hidden; UI.closeAll(); if (was) { const st = Stations.nearest(Env.camera.position, 1e9); if (st) UI.openBoard(st.idx); } return; }
    if (UI.anyOpen()) return;
    if (Sim.drive && Game.driveKeys(c)) return;
    const views = { Digit1: 'cab', Digit2: 'onboard', Digit3: 'chase', Digit4: 'trackside', Digit5: 'heli', Digit6: 'walk', Digit7: 'fly', Digit8: 'orbit' };
    if (views[c]) { if (Sim.drive && (c === 'Digit6' || c === 'Digit7')) { UI.toast('You are driving: stay with your train'); return; } if (Game.mission && Game.mission.kind === 'tour' && c === 'Digit7') { UI.toast('No flying on the tour'); return; }
      if (c === 'Digit8') { const p = Env.camera.position; Player.setMode('orbit', { target: { x: p.x, y: Terrain.h(p.x, p.z), z: p.z }, dist: 600 }); } else Player.setMode(views[c]); return; }
    if (c === 'KeyE') { if (Player.interact()) return; }
    if (c === 'Tab') { e.preventDefault(); if (Sim.drive) return; const L = Sim.running.slice().sort((a, b) => a.dist - b.dist); if (!L.length) return; const i = L.findIndex(t => t.key === Player.focus); const nx = L[(i + 1) % L.length]; Player.setFocus(nx.key); if (!['chase', 'heli', 'trackside', 'cab'].includes(Player.mode)) Player.setMode('chase'); UI.toast('Following ' + Sim.destText(nx).replace(/\s+/g, ' ') + ' (' + nx.trip.id + ')'); return; }
    if (c === 'KeyF' && !Sim.drive) { const tr = Sim.nearestTrain(Env.camera.position, 1e9); if (tr) { Player.setFocus(tr.key); Player.setMode('chase'); } return; }
    if ((c === 'Minus' || c === 'Equal' || c === 'Digit0') && !Sim.drive) {
      if (c === 'Digit0') { Env.goLive(); UI.toast('Live time'); return; }
      let i = scales.indexOf(Env.time.scale); if (i < 0) i = 0; i = U.clamp(i + (c === 'Equal' ? 1 : -1), 0, scales.length - 1); Env.time.scale = scales[i]; if (scales[i] !== 1) Env.time.live = false; UI.toast('Time ×' + scales[i]); return; }
    if (c === 'KeyP') { document.body.classList.toggle('photo'); return; }
    if (c === 'KeyL') {   // copy a link to this exact view (clock, weather, camera)
      const cp = Env.camera.position, ll = Geo.w2ll(cp.x, cp.z), d = Env.camera.getWorldDirection(new THREE.Vector3());
      const sec = Env.time.sec, hh = String(Math.floor(sec / 3600)).padStart(2, '0'), mm = String(Math.floor(sec / 60) % 60).padStart(2, '0');
      const parts = ['auto', 't=' + hh + ':' + mm, 'll=' + [ll.lat.toFixed(5), ll.lon.toFixed(5), Math.round(cp.y), Math.atan2(d.x, -d.z).toFixed(2), Math.asin(U.clamp(d.y, -1, 1)).toFixed(2)].join(',')];
      if (Env.state.weather && Env.state.weather !== 'auto') parts.push('w=' + Env.state.weather);
      const url = location.origin + location.pathname + '#' + parts.join('&');
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => UI.toast('Link to this view copied'), () => UI.toast(url, 8));
      return;
    }
    if (c === 'KeyK' && Env.state) { const W = ['auto', 'clear', 'fog', 'cloudy', 'haze']; const i = (W.indexOf(Env.state.weather || 'auto') + 1) % W.length; Env.state.weather = W[i]; UI.toast('Weather: ' + ({ auto: "today's forecast", clear: 'clear skies', fog: 'the marine layer rolls in', cloudy: 'clouds', haze: 'hazy' })[W[i]]); return; }
    if (c === 'KeyV' && typeof Sound !== 'undefined') { Sound.setMuted(!Sound.muted); UI.toast(Sound.muted ? 'Sound off' : 'Sound on'); return; }
  });
  Game.on((ev, d) => { if (ev === 'toast') UI.toast(d, 4); if (ev === 'score' && d.msg) UI.toast((d.pts > 0 ? '+' : '') + Math.round(d.pts) + '  ' + d.msg, 2.6); if (ev === 'result') UI.showResult(d); });
  Player.on((ev, d) => { if (ev === 'toast') UI.toast(d, 4); if (ev === 'board') UI.toast('Welcome aboard: ' + Sim.destText(d.tr).replace(/\s+/g, ' ') + '. WASD to walk, E to sit.', 5); });

  // ---------- other players' avatars ----------
  const Avatars = (() => {
    const pool = []; const g = new THREE.Group(); Env.scene.add(g);
    const body = new THREE.CapsuleGeometry(0.28, 1.0, 4, 8); body.translate(0, 0.78, 0);
    function label(name, color) { const t = U.canvasTexture(256, 64, (c, w, h) => { c.fillStyle = 'rgba(12,14,18,.75)'; c.beginPath(); c.roundRect(4, 8, w - 8, h - 16, 16); c.fill(); c.fillStyle = color; c.beginPath(); c.arc(28, h / 2, 8, 0, 7); c.fill(); c.fillStyle = '#f3efe6'; c.font = '600 26px Barlow, sans-serif'; c.textBaseline = 'middle'; c.fillText(name, 46, h / 2 + 1); });
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: true, transparent: true })); s.scale.set(2.4, 0.6, 1); s.position.y = 2.3; return s; }
    function get(i, o) { let a = pool[i]; if (!a) { a = { root: new THREE.Group(), id: -1 }; a.mesh = new THREE.Mesh(body, new THREE.MeshStandardMaterial({ roughness: 0.6 })); a.root.add(a.mesh); g.add(a.root); pool[i] = a; }
      if (a.id !== o.id) { a.id = o.id; a.mesh.material.color.set(o.color); if (a.lab) a.root.remove(a.lab); a.lab = label(o.name, o.color); a.root.add(a.lab); } return a; }
    const v = new THREE.Vector3();
    function update() {
      let n = 0; if (typeof Net === 'undefined') return;
      for (const o of Net.others()) {
        if (o.modeName === 'drive' || o.modeName === 'cab' || o.modeName === 'menu' || o.modeName === 'map') continue;
        let x = o.x, y = o.y, z = o.z;
        if (o.modeName === 'ride') { const tr = Sim.running.find(r => r.trip.id === o.trip); if (!tr || !tr.entry) continue; const car = tr.entry.consist.cars[o.car]; if (!car) continue; v.set(o.x, o.y, o.z); car.group.localToWorld(v); x = v.x; y = v.y; z = v.z; }
        else if (o.modeName === 'fly') y -= 1.6; else if (o.modeName === 'walk') y -= 1.62;
        if (Math.hypot(x - Env.camera.position.x, z - Env.camera.position.z) > 1500) continue;
        const a = get(n++, o); a.root.visible = true; a.root.position.set(x, y, z); a.mesh.visible = o.modeName !== 'fly';
      }
      for (let i = n; i < pool.length; i++) pool[i].root.visible = false;
    }
    return { update };
  })();

  // ---------- sound per frame ----------
  let tunnelK = 0; const F = {};
  function soundFrame(dt) {
    if (typeof Sound === 'undefined' || !Sound.ready) return;
    const camP = Env.camera.position; const focus = Player.focusTrain(); const D = Sim.drive;
    const aboard = Player.onboard() || Player.inCab();
    let tr = aboard ? focus : null, dist = 0;
    if (!tr) { const n = Sim.nearestTrain(camP, 450); if (n) { tr = n; dist = Math.hypot(n.x - camP.x, n.z - camP.z); } }
    if (tr) {
      const inT = Track.inTunnel(tr.s); tunnelK = U.clamp(tunnelK + (inT ? dt : -dt) * 1.6, 0, 1);
      Track.frame(tr.s, F); const c1 = F.dx, c2 = F.dz; Track.frame(tr.s + 30, F); const curve = U.clamp(Math.abs(c1 * F.dz - c2 * F.dx) * 12, 0, 1);
      const power = tr.driven ? (D.lever > 0 ? D.lever : D.lever < 0 ? D.lever : 0) : U.clamp(tr.a / 0.8, -1, 1);
      Sound.train({ kind: tr.kind, speed: tr.v, accel: tr.a || 0, power, onboard: aboard, inCab: Player.inCab(), tunnel: aboard ? tunnelK : 0, doorsOpen: !!tr.doorsOpen, curve, dist });
    }
    // pass-by: nearest other train outside
    let pb = null, pd = 700;
    for (const t2 of Sim.running) { if (t2 === tr && aboard) continue; if (t2 === tr) continue; const d = Math.hypot(t2.x - camP.x, t2.z - camP.z); if (d < pd && t2.v > 2) { pd = d; pb = t2; } }
    if (pb) { let horn = false; for (const c of Track.feat.crossings) { const a = (c.s - pb.s) * (pb.dir ? 1 : -1); if (a > 20 && a < 320) { horn = true; break; } } Sound.passby({ dist: pd, speed: pb.v, kind: pb.kind, horn }); } else Sound.passby(null);
    Sound.crossings(TrackGeo.crossingsNear(camP, 700));
    const urb = Terrain.urbanAt(camP.x, camP.z); let bay = 0; for (const [dx, dz] of [[400, 0], [-400, 0], [0, 400], [0, -400], [0, 0]]) if (Terrain.isWater(camP.x + dx, camP.z + dz)) bay += 0.2;
    const alt = camP.y - Terrain.h(camP.x, camP.z);
    Sound.ambience({ city: urb * U.clamp(1 - alt / 400, 0, 1), bay: bay * U.clamp(1 - alt / 800, 0, 1), wind: U.clamp(0.15 + alt / 1500, 0, 1), rain: 0, night: U.uNight.value, crowd: Stations.nearest(camP, 120) ? 0.6 : 0 });
    const holdHorn = (D || Player.inCab()) && Player.down('Space'); Sound.horn(!!holdHorn);
    Sound.bell(!!((D || Player.inCab()) && Player.down('KeyG')));
  }

  // ---------- main loop ----------
  let last = performance.now(), fpsAcc = 0, fpsN = 0, calm = 0;
  const TIERS = [ { name: 'ultra', dpr: 2, lod: 4.8, post: 'high' }, { name: 'high', dpr: 1.5, lod: 4.2, post: 'high' }, { name: 'medium', dpr: 1.25, lod: 3.4, post: 'medium' }, { name: 'low', dpr: 1, lod: 2.6, post: 'low' } ];
  let tier = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 3 : 1;
  // #q=ultra|high|medium|low forces a quality tier and turns the automatic tiering off
  const qForced = TIERS.findIndex(t => t.name === hash.get('q')); if (qForced >= 0) tier = qForced;
  function applyTier() {
    const T = TIERS[tier]; Env.renderer.setPixelRatio(Math.min(T.dpr, devicePixelRatio)); Terrain.lodFactor.value = T.lod;
    if (typeof Post !== 'undefined' && Post.setQuality) safe('post', () => Post.setQuality(T.post));
    if (typeof Flora !== 'undefined' && Flora.setQuality) safe('flora', () => Flora.setQuality(T.post));
    if (typeof Towns !== 'undefined' && Towns.setQuality) safe('towns', () => Towns.setQuality(T.post));
    window.dispatchEvent(new Event('resize'));
  }
  applyTier();
  const sbar = document.getElementById('streambar');
  let sLast = -1;
  function streamUi() { const n = Stream.stats.active + Stream.stats.queued; if (n !== sLast) { sLast = n; sbar.style.opacity = n > 0 ? 1 : 0; sbar.style.width = Math.min(100, 12 + n * 1.5) + '%'; } }
  const envArg = { night: 0, time: 0, camPos: Env.camera.position };
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000; last = now; if (dt > 0.1) dt = 0.1; if (dt <= 0) return;
    // automatic quality tiers: resolution, terrain detail and post effects follow the frame time
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 2.5) { const avg = fpsAcc / fpsN; fpsAcc = 0; fpsN = 0;
      if (qForced >= 0) {} else if (avg > 0.026 && tier < TIERS.length - 1) { tier++; applyTier(); } else if (avg < 0.0135 && tier > 0) { calm++; if (calm >= 4) { calm = 0; tier--; applyTier(); } } else calm = 0; }
    streamUi();
    const camP = Env.camera.position;
    // the Bay's afternoon sea breeze: calm mornings, gusty 2–6 PM, easing at night (trees, flags, water)
    { const h = Env.time.sec / 3600; U.uWind.value = 0.18 + 0.5 * Math.exp(-((h - 16) ** 2) / 8) + 0.06 * Math.sin(U.uTime.value * 0.37) * Math.sin(U.uTime.value * 0.11); }
    Env.update(dt, camP);
    Sim.update(dt, camP);
    Game.update(Env.time.paused ? 0 : dt * Env.time.scale);
    if (!(typeof Flight !== 'undefined' && Flight.active && safeFrameR('flight', () => Flight.update(dt)))) Player.update(dt);
    // the frame follows the camera around the planet; outside the Bay only the planet-wide layer draws and updates
    if (typeof Globe !== 'undefined') safeFrame('rebase', () => { if (Globe.maybeRebase(Env.camera.position)) UI.toast(Globe.frame.bay ? 'Back over the Bay' : 'Leaving the Bay: the world beyond is live satellite imagery', 4); });
    const bay = typeof Globe === 'undefined' || Globe.frame.bay;
    if (typeof Globe !== 'undefined') { const ll = Globe.w2ll(Env.camera.position.x, Env.camera.position.z); Env.setSolarLocation(ll.lat, ll.lon); }
    Env.camera.layers.mask = bay ? 3 : 2;
    const cp = Env.camera.position; envArg.night = U.uNight.value; envArg.time = Env.time.sec; envArg.camPos = cp;
    if (bay) Terrain.update(Env.camera);
    if (typeof Globe !== 'undefined') safeFrame('globe', () => Globe.update(Env.camera));
    if (typeof Airports !== 'undefined') safeFrame('airports', () => Airports.update(Env.camera));
    if (typeof Weather !== 'undefined' && World.started) safeFrame('weather', () => Weather.update(dt));
    if (typeof Traffic !== 'undefined' && World.started) safeFrame('live-traffic', () => Traffic.update(dt));
    if (bay) { TrackGeo.update(cp, dt); TrackGeo.updateDynamic(dt, Sim.running, cp); Stations.update(dt, cp, Sim.running); }
    if (bay && typeof Towns !== 'undefined' && Towns.group) safeFrame('towns', () => { Towns.update(cp, envArg); const R = Towns.stats.detailR; if (R) Terrain.setTownFade(R - 300, R + 300, 1); });
    if (bay && World.landmarks && World.landmarks.update) safeFrame('landmarks', () => World.landmarks.update(dt, envArg));
    if (bay && World.air) safeFrame('air', () => World.air.update(dt, envArg));
    if (bay && World.birds) safeFrame('birds', () => World.birds.update(dt, envArg));
    if (bay && World.traffic) safeFrame('traffic', () => { const T = World.traffic; T.tick -= dt;
      const alt = cp.y - Terrain.h(cp.x, cp.z);
      if (T.tick <= 0) { T.tick = 1.2;
        // re-stream when the camera moved, and keep retrying while empty (street tiles stream in after boot)
        const moved = Math.hypot(cp.x - T.cx, cp.z - T.cz) > 650, empty = !T.lanes || !T.lanes.length;
        if (alt < 1500 && (moved || (empty && ++T.retries < 40)) && Towns.ready !== false) { if (moved) T.retries = 0; T.cx = cp.x; T.cz = cp.z; T.setRoads(Towns.roadsNear(cp.x, cp.z, 1500), { x: cp.x, z: cp.z }, Towns.areasNear ? Towns.areasNear(cp.x, cp.z, 500, 3) : []); } }
      T.group.visible = alt < 2500; if (T.group.visible) T.update(dt, envArg); });
    if (bay && typeof Flora !== 'undefined' && Flora.update) safeFrame('flora', () => Flora.update(cp, envArg));
    if (bay && typeof GroundCover !== 'undefined') safeFrame('groundcover', () => GroundCover.update(cp));
    if (bay && typeof Boats !== 'undefined') safeFrame('boats', () => Boats.update(dt, envArg));
    Avatars.update();
    if (!started) cinematics(dt);
    if (World.started) { UI.update(dt); soundFrame(dt); if (typeof Net !== 'undefined') Net.setState(Player.state()); }
    if (typeof Post !== 'undefined' && Post.render && Post.enabled !== false && !postBroken) { try { Post.render(dt); } catch (e) { postBroken = true; console.error('post', e); Env.renderer.setRenderTarget(null); Env.renderer.render(Env.scene, Env.camera); } }
    else Env.renderer.render(Env.scene, Env.camera);
  }
  let postBroken = false;
  const errs = {}; function safeFrame(name, f) { if (errs[name] > 3) return; try { f(); } catch (e) { errs[name] = (errs[name] || 0) + 1; console.error(name, e); } }
  function safeFrameR(name, f) { if (errs[name] > 20) return false; try { return f(); } catch (e) { errs[name] = (errs[name] || 0) + 1; console.error(name, e); return false; } }
  window.__bayline = { FMissions: typeof FMissions !== "undefined" ? FMissions : null, Env, Sim, Player, Track, Terrain, Stations, TrackGeo, Game, UI, World, start, Stream, Flight: typeof Flight !== 'undefined' ? Flight : null, Traffic: typeof Traffic !== 'undefined' ? Traffic : null, Weather: typeof Weather !== 'undefined' ? Weather : null, Sky: typeof Sky !== 'undefined' ? Sky : null, FHud: typeof FHud !== 'undefined' ? FHud : null, AIRCRAFT: typeof AIRCRAFT !== 'undefined' ? AIRCRAFT : null, FDM: typeof FDM !== 'undefined' ? FDM : null, ACModel: typeof ACModel !== 'undefined' ? ACModel : null, Globe: typeof Globe !== 'undefined' ? Globe : null, Airports: typeof Airports !== 'undefined' ? Airports : null, Sound: typeof Sound !== 'undefined' ? Sound : null, Net: typeof Net !== 'undefined' ? Net : null,
    Flora: typeof Flora !== 'undefined' ? Flora : null, GroundCover: typeof GroundCover !== 'undefined' ? GroundCover : null, Towns: typeof Towns !== 'undefined' ? Towns : null, Post: typeof Post !== 'undefined' ? Post : null };
  requestAnimationFrame(frame);
})();
