// QA (Bayline Metro, #metro=1): a careful human driver in MANUAL, keyboard events only (the real input path).
// Takes the next westbound train at West Oakland (override: window.__qaFrom / __qaTo / __qaStops) through the Transbay
// Tube and down Market Street: doors, departure on time, the ATC code, braking onto the berth. Results: window.__qa.
// node tools/shot.mjs "http://localhost:8136/sim.html#auto&metro=1&t=08:00" out.png --gpu --wait 120000 --eval "$(cat tools/qa_metro_drive.js)" --eval2 "JSON.stringify(window.__qa)"
new Promise(ok => { const f = () => window.__bayline && window.__bayline.MetroSim && window.__bayline.MetroSim.ready ? ok() : setTimeout(f, 250); f(); }).then(() => {
  const B = window.__bayline, M = B.MetroSim, A = B.MetroATC, MPH = 0.44704;
  const key = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true })); };
  const from = window.__qaFrom || 'WOAK', to = window.__qaTo || 'EMBR', maxStops = window.__qaStops || 4;
  const ev = M.arrivals(from, B.Env.time.sec + 60, 40).find(e => e.leg.kind === 'bart' && e.k < e.leg.stops.length - 1 && e.leg.stops[e.k + 1].st === to);
  if (!ev) return 'no train from ' + from + ' to ' + to;
  A.start(ev.plan, { station: from, manual: true });
  B.Env.time.scale = window.__qaScale || 3;
  const qa = window.__qa = { trip: ev.plan.trip.id, line: ev.plan.line, events: [], stops: [], maxMph: 0, warn: 0, atcBrake: 0, penalty: 0, samples: 0 };
  const T = () => B.Env.clockText(B.Env.time.sec).replace(' ', '') + ':' + String(Math.floor(B.Env.time.sec % 60)).padStart(2, '0');
  let lastGuide = '', lastAtc = 'ok', stopsDone = 0, lastK = -1;
  const iv = setInterval(() => {
    const D = M.drive, r = A.run; if (!D || !r) { qa.events.push(T() + ' run ended'); clearInterval(iv); return; }
    const d = A.dmi(); if (!d) return; qa.samples++; qa.maxMph = Math.max(qa.maxMph, D.v / MPH);
    const g = d.guide.replace(/[0-9.,:]+/g, '#'); if (g !== lastGuide) { lastGuide = g; qa.events.push(T() + ' ' + d.guide); }
    if (d.atc !== lastAtc) { if (d.atc === 'warn') qa.warn++; if (d.atc === 'brake') qa.atcBrake++; if (d.atc === 'penalty') qa.penalty++; lastAtc = d.atc; }
    if (r.atK !== lastK && r.state === 'dwell') { if (lastK >= 0) { const L = r.log.filter(l => l[2]).slice(-3).map(l => l[2]); qa.stops.push({ at: M.stName(D.leg.stops[r.atK].st), err: +(r.stats.errSum / Math.max(1, r.stats.stops)).toFixed(2), log: L }); stopsDone++; } lastK = r.atK; }
    if (stopsDone >= maxStops) { qa.events.push(T() + ' done after ' + stopsDone + ' stops, score ' + Math.round(r.score)); clearInterval(iv); return; }
    if (r.state === 'dwell') { const dep = D.leg.stops[r.atK].dep; if (B.Env.time.sec >= dep - 2 && D.lever < 0.75) key('KeyW'); return; }
    const inf = d.next, v = D.v, target = Math.min(d.code, d.vAllow) - 3 * MPH;
    const need = inf ? v * v / (2 * Math.max(0.3, inf.togo - 0.6)) : 0;
    if (inf && inf.togo < 1500 && need > 0.95) { if (D.lever > -0.875) key('KeyS'); }
    else if (inf && inf.togo < 1500 && need > 0.7) { if (D.lever > -0.5) key('KeyS'); else if (D.lever < -0.75) key('KeyW'); }
    else if (v > target) { if (D.lever > -0.25) key('KeyS'); }
    else if (v < target - 1.2) { if (D.lever < 0.75) key('KeyW'); }
    else if (D.lever !== 0) key('KeyX');
    if (inf && inf.togo < 1.2 && v < 1.0 && D.lever > -1) key('KeyS');
    if (inf && inf.togo > 1.2 && inf.togo < 25 && v < 0.3 && D.lever <= 0) key('KeyW');      // stopped short: creep
  }, 60);
  return 'manual driver on ' + ev.plan.line + ' ' + ev.plan.trip.id + ' from ' + from;
})
