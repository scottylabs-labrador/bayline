// QA (Bayline Metro, #metro=1): the ride flow through the UI, keyboard only for the player's actions. Opens the
// arrivals board at a station (window.__qaSt, default Balboa Park), clicks the first train, walks to an open door when
// it arrives, presses E to board, rides to the next station, walks to the door and presses E to step off.
// Results: window.__qa (boarded, rode, alighted, announcements heard, errors).
new Promise(ok => { const f = () => window.__bayline && window.__bayline.MetroSim && window.__bayline.MetroSim.ready ? ok() : setTimeout(f, 250); f(); }).then(() => {
  const B = window.__bayline, M = B.MetroSim, P = B.Player, MUI = B.MetroUI;
  const key = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true })); };
  const qa = window.__qa = { steps: [], said: [], boarded: false, rode: false, alighted: false, stationsPassed: 0 };
  if (B.Sound) { const orig = B.Sound.announce; B.Sound.announce = (t) => { qa.said.push(t); return orig ? orig.call(B.Sound, t) : Promise.resolve(); }; }
  const T = () => B.Env.clockText(B.Env.time.sec);
  const st = window.__qaSt || 'BALB';
  MUI.openBoard(st);
  const row = document.querySelector('#mbp .mrow'); if (!row) return 'no board rows';
  row.click(); qa.steps.push(T() + ' clicked a train on the ' + st + ' board; mode ' + P.mode);
  B.Env.time.scale = 3;
  let phase = 'wait', key0 = P.focus, startK = -1;
  const doorPos = (tr) => { const cs = tr.entry.consist.cars, car = cs[Math.floor(cs.length / 2)], side = tr.doorSide === 'right' ? 1 : -1, d = car.doors.find(d => d.side === side);
    const v = new THREE.Vector3(d.x, 1, d.side * (car.width / 2 + 0.6)); car.group.localToWorld(v); return v; };
  const iv = setInterval(() => {
    const tr = M.trainByKey(key0);
    if (phase === 'wait' && P.mode === 'walk' && tr && tr.doorsOpen && tr.entry) { const v = doorPos(tr); P.walk.x = v.x; P.walk.z = v.z; phase = 'toboard'; return; }
    if (phase === 'toboard') { if (P.prompt.indexOf('board') >= 0) { key('KeyE'); } if (P.mode === 'onboard') { qa.boarded = true; phase = 'ride'; startK = tr ? tr.nextK : -1; qa.steps.push(T() + ' boarded ' + tr.line + ' to ' + M.termName(tr) + ' in car ' + (P.ob.car + 1)); } return; }
    if (phase === 'ride' && tr) { if (tr.phase === 'run') qa.rode = true;
      if (qa.rode && tr.phase === 'dwell' && tr.doorsOpen && tr.stopK >= 0) { qa.steps.push(T() + ' at ' + M.stName(tr.leg.stops[tr.stopK].st) + ', doors open'); phase = 'off'; } return; }
    if (phase === 'off' && tr) {
      // walk (car-local) to the nearest open door, then E
      const car = tr.entry.consist.cars[P.ob.car], side = tr.doorSide === 'right' ? 1 : -1, d = car.doors.filter(d => d.side === side).sort((a, b) => Math.abs(a.x - P.ob.x) - Math.abs(b.x - P.ob.x))[0];
      if (P.ob.seat >= 0) { key('KeyE'); return; }
      P.ob.x = d.x; P.ob.z = side * (car.width / 2 - 0.75);
      if (P.prompt.indexOf('step off') >= 0) key('KeyE');
      if (P.mode === 'walk') { qa.alighted = true; qa.steps.push(T() + ' stepped off onto the platform at y=' + P.walk.y.toFixed(2)); phase = 'done'; clearInterval(iv); }
    }
  }, 250);
  return 'ride flow started at ' + st;
})
