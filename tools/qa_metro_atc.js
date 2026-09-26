// QA (Bayline Metro, #metro=1): a reckless driver in MANUAL (full power, never brakes), keyboard only. ATC must sound
// the overspeed alarm, apply the ATC brake until the train is back under the code, and never let it pass a stop code.
// Results: window.__qa. Same invocation as qa_metro_drive.js.
new Promise(ok => { const f = () => window.__bayline && window.__bayline.MetroSim && window.__bayline.MetroSim.ready ? ok() : setTimeout(f, 250); f(); }).then(() => {
  const B = window.__bayline, M = B.MetroSim, A = B.MetroATC, MPH = 0.44704;
  const key = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true })); };
  const from = window.__qaFrom || 'CIVC', to = window.__qaTo || '16TH';
  const ev = M.arrivals(from, B.Env.time.sec + 60, 40).find(e => e.leg.kind === 'bart' && e.k < e.leg.stops.length - 1 && e.leg.stops[e.k + 1].st === to);
  if (!ev) return 'no train';
  A.start(ev.plan, { station: from, manual: true }); B.Env.time.scale = 3;
  const qa = window.__qa = { trip: ev.plan.trip.id, events: [], warn: 0, brake: 0, penalty: 0, maxOverMph: 0, tractionDuringBrake: 0 };
  const T = () => B.Env.clockText(B.Env.time.sec).replace(' ', '') + ':' + String(Math.floor(B.Env.time.sec % 60)).padStart(2, '0');
  let last = '';
  const iv = setInterval(() => {
    const D = M.drive, r = A.run; if (!D || !r) { clearInterval(iv); return; }
    const d = A.dmi(); if (!d) return;
    qa.maxOverMph = Math.max(qa.maxOverMph, (D.v - d.code) / MPH);
    if (d.atc !== last) { qa.events.push(`${T()} ATC ${d.atc.toUpperCase()} at ${(D.v / MPH).toFixed(1)} mph, code ${Math.round(d.code / MPH)}`); if (d.atc === 'warn') qa.warn++; if (d.atc === 'brake') qa.brake++; if (d.atc === 'penalty') qa.penalty++; last = d.atc; }
    if (d.atc === 'brake' && D.tract > 0.05) qa.tractionDuringBrake++;
    if (r.state === 'dwell') { const dep = D.leg.stops[r.atK].dep; if (B.Env.time.sec >= dep - 2 && D.lever < 1) key('KeyW'); return; }
    if (D.lever < 1) key('KeyW');
  }, 60);
  return 'reckless driver on ' + ev.plan.trip.id;
})
