// QA (Bayline Metro, M3 gate item 5): a phone (tools/shot.mjs --mobile: DPR 2, touch, a 390 x 844 screen) with the
// metro on. Frame rate and memory after streaming, then the metro by touch only (synthetic touch pointer events and
// taps, no keys): the HUD Metro button opens the system map, tapping Embarcadero selects it, "Go to the platform" puts
// the walker there, tapping the prompt boards the train once its doors open, the ride panel shows; then the on-screen
// driving buttons (ATO) drive a train. Results in window.__mob (JSON).
new Promise(r => { const f = () => window.__bayline && __bayline.MetroSim && __bayline.MetroSim.ready ? r() : setTimeout(f, 300); f(); }).then(async () => {
  const B = __bayline, sleep = (ms) => new Promise(r => setTimeout(r, ms)), res = { coarse: matchMedia('(pointer: coarse)').matches, dpr: devicePixelRatio, steps: [] };
  const step = (s, ok, x) => res.steps.push({ s, ok: !!ok, ...(x || {}) });
  const tapAt = (x, y, el) => { el = el || document.elementFromPoint(x, y); if (!el) return false;
    for (const t of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'touch', pointerId: 7, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y })); return true; };
  const tap = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return tapAt(r.left + r.width / 2, r.top + r.height / 2, el); };
  await sleep(window.__settle || 20000);
  const f0 = B.Env.renderer.info.render.frame; await sleep(5000); res.fps = +((B.Env.renderer.info.render.frame - f0) / 5).toFixed(1);
  const mem = () => performance.memory ? { usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576), totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576) } : null;
  const ri = B.Env.renderer.info; res.mem = mem(); res.gl = { geometries: ri.memory.geometries, textures: ri.memory.textures, calls: ri.render.calls, tris: ri.render.triangles };
  res.canvas = [B.Env.renderer.domElement.width, B.Env.renderer.domElement.height];
  // 1. the system map by touch
  tap(document.getElementById('hmetro')); await sleep(1500);
  step('HUD Metro button opens the map', B.MetroUI.mapOpen);
  const p = B.MetroUI.stationXY('EMBR'); if (p) tapAt(p.x, p.y, document.getElementById('msysc')); await sleep(800);
  const go = document.getElementById('mgo'); step('tapping Embarcadero selects it', !!go, { at: p });
  tap(go); await sleep(12000);
  step('Go to the platform: on the platform', B.Player.mode === 'walk' && B.Player.onMetroFloor(), { y: +B.Player.walk.y.toFixed(1) });
  // 2. board by tapping the prompt when a train's doors are open next to the walker
  let boarded = false;
  B.Env.time.scale = 3;                                          // (the next train in a minute or two, not five)
  for (let i = 0; i < 150 && !boarded; i++) {
    const tr = B.MetroSim.running.filter(t => t.entry && t.doorsOpen && t.stationId === 'EMBR' && t.dist < 400).sort((a, b) => a.dist - b.dist)[0];
    if (tr) { B.Env.time.scale = 1;
      const cars = tr.entry.consist.cars, car = cars[Math.floor(cars.length / 2)], side = tr.doorSide === 'right' ? 1 : -1, d = car.doors.find(x => x.side === side) || car.doors[0];
      const v = new THREE.Vector3(d.x, 1, d.side * (car.width / 2 + 0.6)); car.group.localToWorld(v); B.Player.walk.x = v.x; B.Player.walk.z = v.z;
      await sleep(600); const pr = document.getElementById('prompt');
      if (pr && !pr.hidden && /Tap to board/.test(pr.textContent)) { tap(pr); await sleep(800); boarded = B.Player.mode === 'onboard'; res.prompt = pr.textContent; }
    }
    if (!boarded) await sleep(1000);
  }
  B.Env.time.scale = 1;
  step('tapping the prompt boards the train', boarded, { prompt: res.prompt });
  await sleep(4000);
  step('ride panel shows', !document.getElementById('mride').hidden);
  // 3. drive by the on-screen buttons: a train from the map's train panel, ATO started with the Power button
  B.MetroUI.closeAll();
  const now = B.Env.time.sec, ev = B.MetroSim.arrivals('EMBR', now, 20).find(e => e.dep > now + 3 && e.leg.kind === 'bart' && e.k < e.leg.stops.length - 1);
  if (ev) B.MetroUI.drive(ev); await sleep(2500);
  const bar = document.getElementById('drivebar');
  step('drive bar shown with metro labels', bar && !bar.hidden && [...bar.querySelectorAll('button')].some(b => b.textContent === 'ATO'), { labels: bar ? [...bar.querySelectorAll('button:not([hidden])')].map(b => b.textContent) : null });
  const D = B.MetroSim.drive; if (D) { const dep = D.leg.stops[0]; B.Env.setClock(Math.max(B.Env.time.sec, (ev.dep || 0) - 2)); }
  await sleep(1500); tap([...bar.querySelectorAll('button')].find(b => b.dataset.k === 'KeyW')); await sleep(9000);
  step('Power button: the train moves', B.MetroSim.drive && B.MetroSim.drive.v > 1, { v: B.MetroSim.drive ? +B.MetroSim.drive.v.toFixed(1) : null });
  res.memEnd = mem(); res.metroOn = B.Metro.on;
  res.ok = res.steps.every(x => x.ok) && res.metroOn;
  window.__mob = res; return JSON.stringify(res);
});
