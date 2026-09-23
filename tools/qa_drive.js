// QA: a scripted human driver that only uses keyboard events (the real input path).
// Injected with tools/shot.mjs --eval. Results land in window.__qa.
(() => {
  const B = window.__bayline; const G = B.Game;
  const key = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true })); };
  const m = G.missionList().find(m => m.id === (window.__qaMission || 'short')); G.startMission(m);
  B.Env.time.scale = window.__qaScale || 4;
  const qa = window.__qa = { events: [], samples: 0, maxV: 0, ptcWarn: 0, ptcEnf: 0 };
  const log = (s) => qa.events.push(B.Env.clockText(B.Env.time.sec) + ' ' + s);
  let lastGuide = '';
  const iv = setInterval(() => {
    const D = B.Sim.drive, r = G.run; if (!D || !r) { log('run finished'); clearInterval(iv); return; }
    const dm = G.dmi(); qa.samples++; qa.maxV = Math.max(qa.maxV, D.v);
    const gk = dm.guide.replace(/[0-9.:]+/g, '#'); if (gk !== lastGuide) { lastGuide = gk; log('guide: ' + dm.guide); }
    if (dm.ptc === 'warn') qa.ptcWarn++; if (dm.ptc === 'enforce') qa.ptcEnf++;
    const inf = G.stopInfo();
    if (r.state === 'dwell') {
      const dep = r.trip.stops[r.atK][2] + r.plan.dayOff;
      if (B.Env.time.sec >= dep - 2 && D.lever < 0.75) key('KeyW');     // W closes the doors and notches up
      return;
    }
    const lim = Math.min(dm.lim, dm.vAllow) - 2.5 * 0.44704;
    const need = inf ? D.v * D.v / (2 * Math.max(0.5, inf.togo - 1.5)) : 0;
    if (inf && inf.togo < 1400 && need > 0.42) { if (D.lever > -0.75) key('KeyS'); }
    else if (inf && inf.togo < 1400 && need > 0.3) { if (D.lever > -0.25) key('KeyS'); else if (D.lever < -0.5) key('KeyW'); }
    else if (D.v > lim) { if (D.lever > -0.25) key('KeyS'); }
    else if (D.v < lim - 1.5) { if (D.lever < 0.75) key('KeyW'); }
    else if (D.lever !== 0) key('KeyX');
    if (inf && inf.togo < 3 && D.v < 1.2 && D.lever > -1) key('KeyS');
  }, 60);
  return 'qa started: ' + m.title;
})()
