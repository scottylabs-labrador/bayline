// QA: red-signal protection. A phantom train is parked 1.8 km ahead of the player (same direction); the block
// signals behind it turn red. A reckless driver (full power, never brakes) must be stopped by PTC before the red.
new Promise(ok => { const f = () => window.__bayline && window.__bayline.Sim.TT ? ok() : setTimeout(f, 200); f(); }).then(() => {
  const B = window.__bayline, G = B.Game, MPH = 0.44704;
  const key = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true })); };
  const m = G.missionList().find(x => x.id === 'short'); G.startMission(m); B.Env.time.scale = 3;
  const D0 = B.Sim.drive; const sg = D0.dir ? 1 : -1; const phantom = { s: D0.s + sg * 2600, dir: D0.dir, v: 0, len: 185 };
  const orig = B.TrackGeo.updateDynamic; B.TrackGeo.updateDynamic = (dt, trains, cam) => orig(dt, trains.concat([phantom]), cam);
  const qa = window.__qa = { events: [], lastPtc: '', lastSig: '', passedRed: 0, minGap: 1e9 };
  const T = () => B.Env.clockText(B.Env.time.sec).replace(' ', '') + ':' + String(Math.floor(B.Env.time.sec % 60)).padStart(2, '0');
  const iv = setInterval(() => {
    const D = B.Sim.drive, r = G.run; if (!D || !r) { clearInterval(iv); return; }
    const dm = G.dmi(); const sig = B.TrackGeo.nextSignal(D.s, D.dir);
    const sk = sig ? ['RED', 'YELLOW', 'GREEN'][sig.aspect] : '-';
    if (sk !== qa.lastSig) { qa.events.push(`${T()} next signal ${sk}${sig ? ' in ' + Math.round(sig.dist) + ' m' : ''} at ${(D.v / MPH).toFixed(1)} mph`); qa.lastSig = sk; }
    if (dm.ptc !== qa.lastPtc) { qa.events.push(`${T()} PTC ${dm.ptc.toUpperCase()} at ${(D.v / MPH).toFixed(1)} mph, permitted ${(dm.vAllow / MPH).toFixed(1)}${dm.tgt ? ' (' + dm.tgt.why + ' in ' + Math.round(dm.tgt.dist) + ' m)' : ''}`); qa.lastPtc = dm.ptc; }
    qa.minGap = Math.min(qa.minGap, (phantom.s - D.s) * sg);
    qa.log = r.log.filter(l => l[2]).map(l => l[2]);
    if (r.state === 'dwell') { const dep = r.trip.stops[r.atK][2] + r.plan.dayOff; if (B.Env.time.sec >= dep - 2 && D.lever < 1) key('KeyW'); return; }
    if (D.lever < 1) key('KeyW');
  }, 60);
  return 'phantom train parked ' + Math.round(Math.abs(phantom.s - D0.s)) + ' m ahead';
})
