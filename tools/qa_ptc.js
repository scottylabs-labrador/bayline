// QA: a reckless driver (keyboard only, full power, never brakes) from Santa Clara into the 30 mph Diridon zone.
// Expected: PTC warns, then enforces a penalty brake to a stop, then releases; traction is cut while enforcing.
new Promise(ok => { const f = () => window.__bayline && window.__bayline.Sim.TT ? ok() : setTimeout(f, 200); f(); }).then(() => {
  const B = window.__bayline, G = B.Game, MPH = 0.44704;
  const key = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true })); };
  const si = B.Sim.TT.stations.indexOf('santa_clara');
  const d = B.Sim.departures(si, B.Env.time.sec, 300).find(x => x.dir === 1 && x.trip.stops.some(s => B.Sim.TT.stations[s[0]] === 'sj_diridon'));
  G.startDrive(d.plan, { fromK: d.k }); B.Env.time.scale = 3;
  const qa = window.__qa = { events: [], warn: 0, enf: 0, maxMph: 0, lastPtc: '', stoppedByPtc: 0, tractionDuringEnforce: 0 };
  const T = () => B.Env.clockText(B.Env.time.sec).replace(' ', '') + ':' + String(Math.floor(B.Env.time.sec % 60)).padStart(2, '0');
  const iv = setInterval(() => {
    const D = B.Sim.drive, r = G.run; if (!D || !r) { qa.events.push(T() + ' run ended'); clearInterval(iv); return; }
    const dm = G.dmi(); qa.maxMph = Math.max(qa.maxMph, D.v / MPH);
    if (dm.ptc !== qa.lastPtc) { qa.events.push(`${T()} PTC ${dm.ptc.toUpperCase()} at ${(D.v / MPH).toFixed(1)} mph, limit ${Math.round(dm.lim / MPH)}, permitted ${(dm.vAllow / MPH).toFixed(1)}, s=${Math.round(D.s)}${dm.tgt ? ' target ' + dm.tgt.why + ' in ' + Math.round(dm.tgt.dist) + ' m' : ''}`); qa.lastPtc = dm.ptc; }
    if (dm.ptc === 'warn') qa.warn++;
    if (dm.ptc === 'enforce') { qa.enf++; if (D.tract > 0.01) qa.tractionDuringEnforce++; if (D.v < 0.05) qa.stoppedByPtc++; }
    if (r.state === 'dwell') { const dep = r.trip.stops[r.atK][2] + r.plan.dayOff; if (B.Env.time.sec >= dep - 2 && D.lever < 1) key('KeyW'); return; }
    if (D.lever < 1) key('KeyW');                 // reckless: always full power, never brakes
  }, 60);
  return 'reckless driver on ' + d.trip.id + ' from Santa Clara';
})
