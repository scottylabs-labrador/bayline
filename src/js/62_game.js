// Game layer: driving (station stops, schedule, stopping marks, PTC, signals, comfort, scoring),
// onboard announcements, and missions (drive runs, commuter challenges, landmark tours).
const Game = (() => {
  const F = {};
  let run = null;            // active drive run
  let mission = null;        // active mission (any kind)
  const listeners = []; const emit = (e, d) => listeners.forEach(f => f(e, d));
  const best = (() => { try { return JSON.parse(localStorage.getItem('bayline.best') || '{}'); } catch (e) { return {}; } })();
  function saveBest() { try { localStorage.setItem('bayline.best', JSON.stringify(best)); } catch (e) {} }
  const name = (si) => Sim.TT.names[Sim.TT.stations[si]];
  const MPH = 0.44704;

  // ---------------- drive runs ----------------
  function startDrive(plan, opts = {}) {
    // set the clock to shortly before the scheduled departure from the first stop of the run
    const k0 = opts.fromK || 0; const dep = plan.trip.stops[k0][2] + plan.dayOff;
    const now = Env.time.sec; if (now > dep - 20 || now < dep - 3600) Env.setClock(dep - 50);
    else Env.setClock(Math.max(now, dep - 90));
    Env.time.scale = 1;
    const D = Sim.startDrive(plan, { auto: !!opts.auto });
    D.s = Sim.stopS(plan.trip.stops[k0][0], plan.dir); D.v = 0;
    D.doorsTarget = 1; D.doors = 1; D.doorSideNow = Sim.doorSide(plan.trip.stops[k0][0], plan.dir);
    run = { plan, trip: plan.trip, dir: plan.dir, k0, k: k0 + 1, endK: opts.endK !== undefined ? opts.endK : plan.trip.stops.length - 1, atK: k0, dwellT: 0, score: 0, pax: 60 + Math.floor(Math.random() * 60),
      stats: { stops: 0, ontime: 0, perfect: 0, errSum: 0, overs: 0, maxOver: 0, reds: 0, emerg: 0, missed: 0, harsh: 0, dist: 0, t0: Env.time.sec }, over: 0, ptc: 0, lastSig: 2, log: [],
      state: 'dwell', departOK: false, title: opts.title || '', announced: {}, mission: opts.mission || null };
    Player.setFocus(plan.key); Player.setMode('cab');
    emit('toast', `You have the ${Sim.routeShort(plan.trip).toLowerCase()} ${plan.trip.id} to ${name(plan.trip.stops[run.endK][0])}. At departure time press W: the doors close and you're away.`);
    return run;
  }
  function endRun(completed) {
    if (!run) return;
    const r = run; run = null; Sim.stopDrive();
    const st = r.stats; const mins = (Env.time.sec - st.t0) / 60;
    const q = r.score / Math.max(220, (r.endK - r.k0) * 220); const grade = q >= 0.95 ? 'A+' : q >= 0.85 ? 'A' : q >= 0.7 ? 'B' : q >= 0.5 ? 'C' : q >= 0.3 ? 'D' : 'F';
    const key = r.trip.route + ':' + r.trip.stops[r.k0][0] + '>' + r.trip.stops[r.endK][0];
    const prev = best[key]; if (completed && (!prev || r.score > prev)) { best[key] = r.score; saveBest(); }
    emit('result', { kicker: completed ? 'Run complete' : 'Run ended', title: completed ? (grade.startsWith('A') ? 'Beautifully driven' : grade === 'B' ? 'Solid run' : 'You made it') : 'Off duty early',
      score: Math.round(r.score), grade, lines: [
        `${Sim.routeShort(r.trip)} ${r.trip.id} · ${name(r.trip.stops[r.k0][0])} → ${name(r.trip.stops[r.endK][0])} · ${(st.dist / 1609.34).toFixed(1)} mi in ${mins.toFixed(0)} min`,
        `Station stops: ${st.stops} · on time ${st.ontime} · perfect marks ${st.perfect}${st.stops ? ` · average error ${(st.errSum / st.stops).toFixed(1)} m` : ''}`,
        `Speeding: ${st.overs ? st.overs + ' warnings, worst +' + st.maxOver.toFixed(0) + ' mph' : 'none'} · red signals ${st.reds} · emergency stops ${st.emerg} · missed stops ${st.missed}`,
        prev ? `Best on this run: ${prev}` : 'First time on this run',
      ] });
    if (r.mission) finishMission(completed && r.score > 0);
  }
  function stopInfo() {
    if (!run) return null;
    const si = run.trip.stops[run.k] ? run.trip.stops[run.k][0] : null; if (si === null) return null;
    const target = Sim.stopS(si, run.dir); const D = Sim.drive; const togo = (target - D.s) * (run.dir ? 1 : -1);
    const sched = run.trip.stops[run.k][2] + run.plan.dayOff;
    return { si, name: name(si), target, togo, sched };
  }
  function lever(delta) { const D = Sim.drive; if (!D) return; D.lever = U.clamp(Math.round((D.lever + delta) * 8) / 8, -1, 1); }
  const depTime = () => run.trip.stops[run.atK][2] + run.plan.dayOff;
  function closeDoors(quiet) {
    const D = Sim.drive; if (!D || D.doorsTarget <= 0) return;
    D.doorsTarget = 0; Sound.doorChime && Sound.doorChime();
    if (!quiet && run.state === 'dwell' && Env.time.sec < depTime() - 8) add(-40, 'Doors closed before departure time');
  }
  function toggleDoors() {
    const D = Sim.drive; if (!D || !run) return;
    if (D.doorsTarget > 0) { closeDoors(); return; }
    if (D.v > 0.2) { emit('toast', 'Stop the train before opening the doors'); return; }
    if (run.state === 'dwell') { D.doorsTarget = 1; return; }
    const inf = stopInfo();
    if (!inf || Math.abs(inf.togo) > 25) { emit('toast', inf && inf.togo > 25 ? `Not at the platform yet: stop mark ${ft(inf.togo)} ahead` : inf ? `Overran the stop mark by ${ft(-inf.togo)}: Q to reverse` : 'No platform here'); return; }
    arrive(inf);
  }
  const ft = (m) => m > 1609 ? (m / 1609.34).toFixed(1) + ' mi' : Math.round(m * 3.281) + ' ft';
  function add(pts, msg) { if (!run) return; run.score += pts; run.log.push([Env.time.sec, pts, msg]); if (msg) emit('score', { pts, msg }); }
  function arrive(inf) {
    const D = Sim.drive; const err = Math.abs(inf.togo); const st = run.stats; st.stops++; st.errSum += err;
    if (err < 2) { add(120, 'Perfect stop'); st.perfect++; } else if (err < 5) add(70, 'Good stop'); else if (err < 12) add(30, 'Stop ' + err.toFixed(0) + ' m off the mark'); else add(0, 'Well off the mark');
    const delta = Env.time.sec - (inf.sched - 20);
    if (delta < 60) { add(100, delta < -60 ? 'Early: hold for the departure time' : 'On time'); st.ontime++; } else if (delta < 180) add(40, Math.round(delta / 60) + ' min late'); else add(-20, Math.round(delta / 60) + ' min late');
    D.doorsTarget = 1; D.doorSideNow = Sim.doorSide(inf.si, run.dir); D.reverse = false;
    run.state = 'dwell'; run.atK = run.k; run.dwellT = 0; run.stopT = 0;
    const off = Math.round(8 + Math.random() * 30 * (run.k === run.endK ? 3 : 1)), on = run.k === run.endK ? 0 : Math.round(6 + Math.random() * 34);
    run.pax = Math.max(0, run.pax - off) + on; emit('toast', `${inf.name}: ${off} off, ${on} on`);
    if (run.k >= run.endK) { setTimeout(() => endRun(true), 2500); }
    run.k++;
  }

  // ---------------- PTC: braking curves to limits, signals and the end of track ----------------
  const B_PTC = 0.55;   // m/s² curve PTC holds you to (a little under full service braking)
  function ptcTargets(D) {
    const out = []; const sg = D.dir ? 1 : -1; let prev = Track.limit(D.s);
    for (let a = 40; a <= 3600; a += 40) {
      const s2 = D.s + sg * a; if (s2 < 1 || s2 > Track.length - 1) { out.push({ dist: Math.max(0, a - 70), v: 0, why: 'end of track' }); break; }
      const l2 = Track.limit(s2); if (l2 < prev - 0.2) out.push({ dist: a - 40, v: l2, why: 'limit' }); prev = l2;
    }
    const sig = TrackGeo.nextSignal(D.s, D.dir);
    if (sig && sig.aspect === 0) out.push({ dist: Math.max(0, sig.dist - 25), v: 0, why: 'signal' });
    else if (sig && sig.aspect === 1) out.push({ dist: sig.dist, v: 30 * MPH, why: 'approach' });
    return out;
  }
  function ptcCurve(D) {
    let vAllow = Track.limit(D.s), tgt = null;
    for (const t of ptcTargets(D)) { const va = Math.sqrt(t.v * t.v + 2 * B_PTC * t.dist); if (va < vAllow) { vAllow = va; tgt = t; } }
    return { vAllow, tgt };
  }
  function autopilot(dt) {
    const D = Sim.drive; if (!D || !D.auto || !run) return;
    if (run.state === 'dwell') {
      if (D.doorsTarget > 0 && Env.time.sec > depTime() - 6) closeDoors(true);
      if (D.doors > 0) { D.lever = -0.5; return; }
    }
    D.reverse = false;
    const inf = stopInfo(); const lim = Track.limit(D.s) - 2.5 * MPH;
    let vt = Math.min(lim, (run.ptcC ? run.ptcC.vAllow : lim) - 1.5 * MPH);
    if (inf) { const d = inf.togo - 0.4; vt = Math.min(vt, d <= 0 ? 0 : Math.sqrt(2 * 0.5 * Math.max(0, d - D.v * 0.9)) + (d < 25 ? 0.25 : 0)); }
    for (let a = 100; a < 2400; a += 100) { const s2 = D.s + (D.dir ? a : -a); const l2 = Track.limit(s2) - 2.5 * MPH; vt = Math.min(vt, Math.sqrt(l2 * l2 + 2 * 0.45 * Math.max(0, a - D.v * 1.2))); }
    const sig = TrackGeo.nextSignal(D.s, D.dir); if (sig && sig.aspect === 0) vt = Math.min(vt, Math.sqrt(2 * 0.5 * Math.max(0, sig.dist - 30 - D.v)));
    const e = vt - D.v; const aDes = U.clamp(e * 0.5, -0.9, 0.9);
    const aMax = Math.min(D.kind === 'emu' ? 1.05 : 0.55, (D.kind === 'emu' ? 12.5 : 5.8) / Math.max(D.v, 1));
    D.lever = aDes > 0.04 ? U.clamp(aDes / aMax, 0, 1) : aDes < -0.04 ? U.clamp(aDes / (D.kind === 'emu' ? 1.0 : 0.85), -1, 0) : 0;
    if (inf && inf.togo < 0.6 && D.v < 2) D.lever = -1;
    if (inf && D.v < 0.05 && run.state !== 'dwell' && inf.togo < 14) arrive(inf);
  }
  function updateRun(dt) {
    const D = Sim.drive; if (!run || !D) return;
    const st = run.stats; st.dist = D.odometer;
    run.ptcC = ptcCurve(D);
    autopilot(dt);
    const inf = stopInfo();
    // traction interlock: power requested with doors open -> close them (the train moves once they're shut)
    if (D.lever > 0 && D.doorsTarget > 0 && run.state === 'dwell' && !D.auto) closeDoors();
    if (run.state === 'dwell') {
      run.dwellT += dt;
      if (D.doors < 0.01 && D.v > 0.5) {
        if (Env.time.sec < depTime() - 10) add(-60, 'Departed early');
        run.state = 'run'; run.stopT = 0;
        if (inf) Sound.announce && Sound.announce('Next stop: ' + inf.name + '.');
      }
    } else if (inf) {
      if (inf.togo < 350 && !run.announced[run.k]) { run.announced[run.k] = 1; Sound.announce && Sound.announce('Now approaching ' + inf.name + '.'); }
      // stopped at the platform: doors open by themselves after a moment (or press O)
      if (D.v < 0.05 && Math.abs(inf.togo) <= 25 && !D.emergency && !D.penalty) { run.stopT = (run.stopT || 0) + dt; if (run.stopT > 1.4) arrive(inf); }
      else run.stopT = 0;
      if (inf.togo < -80 && D.v > 3) { add(-150, 'Missed ' + inf.name); st.missed++; run.k++; if (run.k > run.endK) endRun(true); }
    }
    // civil speed limit (score) and PTC braking-curve supervision (safety)
    const lim = Track.limit(D.s), over = (D.v - lim) / MPH;
    if (over > 3) { run.over += dt; st.maxOver = Math.max(st.maxOver, over); if (run.over > 0.1 && run.over - dt <= 0.1) st.overs++; add(-dt * over * 2); }
    else run.over = 0;
    const P = run.ptc || (run.ptc = { state: 'ok', warnT: 0, stopT: 0 });
    const overBy = D.v - run.ptcC.vAllow;
    if (D.penalty) { P.state = 'enforce'; if (D.v < 0.05) { P.stopT += dt; if (P.stopT > 3) { D.penalty = false; P.state = 'ok'; emit('toast', 'PTC released: proceed per signals and limits'); } } }
    else if (overBy > 1.8 * MPH) {
      if (P.state !== 'warn') { P.state = 'warn'; P.warnT = 0; emit('toast', `PTC warning: slow to ${Math.round(run.ptcC.vAllow / MPH)} mph`); Sound.alert && Sound.alert('warn'); }
      P.warnT += dt; const braking = D.lever <= -0.25;
      if (overBy > 5 * MPH || (P.warnT > 5 && !braking)) { D.penalty = true; P.state = 'enforce'; P.stopT = 0; add(-150, 'PTC penalty brake'); Sound.alert && Sound.alert('enforce'); }
    } else { P.state = 'ok'; P.warnT = 0; }
    // signals
    const sig = TrackGeo.nextSignal(D.s, D.dir);
    if (sig) {
      if (run.sigSeen && run.sigSeen.s !== sig.s && run.sigSeen.aspect === 0 && run.sigSeen.dist < 60) { st.reds++; add(-300, 'Passed a red signal'); D.penalty = true; }
      if (sig.dist > 3) run.sigSeen = { s: sig.s, aspect: sig.aspect, dist: sig.dist };
      run.sigAhead = sig;
    }
    // comfort
    if (D.jerk > 1.3 && D.v > 1) { run.harshT = (run.harshT || 0) + dt; if (run.harshT > 0.4 && Env.time.sec - (run.lastHarsh || 0) > 4) { run.harshT = 0; run.lastHarsh = Env.time.sec; st.harsh++; add(-15, 'Rough ride'); } } else run.harshT = 0;
    if (D.emergency && !run.emWas) { st.emerg++; add(-100, 'Emergency brake'); } run.emWas = D.emergency;
  }
  // what the driver should do next (shown on the HUD)
  function guide() {
    const D = Sim.drive; if (!run || !D) return '';
    const t = Env.time.sec; const inf = stopInfo(); const P = run.ptc || {};
    if (D.emergency) return D.v > 0.1 ? 'EMERGENCY BRAKE: stopping' : 'Emergency brake applied · press R to release';
    if (D.penalty) return D.v > 0.1 ? 'PTC PENALTY BRAKE: stopping the train' : 'PTC penalty · releasing after a full stop';
    if (D.auto) return 'Autopilot is driving · press A to take over';
    if (run.state === 'dwell') {
      const left = depTime() - t;
      if (D.doorsTarget > 0) return left > 1 ? `Boarding · departs ${Env.clockText(depTime())} (in ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}) · O closes doors` : 'Time to go: O closes the doors, then W for power';
      if (D.doors > 0.01) return 'Doors closing…';
      return D.lever > 0 ? 'Power on · departing' : 'Doors closed · W (or ↑) for power';
    }
    if (D.reverse) return inf ? `REVERSE (max 5 mph) · stop mark ${inf.togo < 0 ? ft(-inf.togo) + ' behind you' : 'reached'} · Q for forward` : 'REVERSE · Q for forward';
    if (P.state === 'warn') return `PTC WARNING: brake to ${Math.round(run.ptcC.vAllow / MPH)} mph now`;
    if (inf) {
      if (D.v < 0.1 && inf.togo > 25) return `Stopped short · creep forward ${ft(inf.togo)} to the stop mark`;
      if (D.v < 0.1 && inf.togo < -25) return `Overran by ${ft(-inf.togo)} · Q for reverse, back up to the mark`;
      if (inf.togo < 900 && D.v > 0.5) { const need = D.v * D.v / (2 * Math.max(1, inf.togo)); return need > 0.5 ? `BRAKE NOW · stop mark in ${ft(inf.togo)}` : need > 0.3 ? `Start braking · stop mark in ${ft(inf.togo)}` : `Approaching ${inf.name} · stop mark in ${ft(inf.togo)}`; }
    }
    const tg = run.ptcC && run.ptcC.tgt;
    if (tg && tg.dist < 2500) return tg.why === 'signal' ? `Red signal ahead: stop within ${ft(tg.dist)}` : tg.why === 'approach' ? `Yellow signal: 30 mph at the next signal (${ft(tg.dist)})` : tg.why === 'end of track' ? `End of track in ${ft(tg.dist)}` : `Speed limit ${Math.round(tg.v / MPH)} mph in ${ft(tg.dist)}`;
    return inf ? `Next stop ${inf.name} · ${ft(Math.max(0, inf.togo))} · limit ${Math.round(Track.limit(D.s) / MPH)} mph` : '';
  }
  function notchText(l) { const n = Math.round(l * 8); return n > 0 ? 'P' + n : n < 0 ? 'B' + (-n) : 'N'; }
  function dmi() {
    const D = Sim.drive; if (!run || !D) return null;
    return { v: D.v, lim: Track.limit(D.s), vAllow: run.ptcC ? run.ptcC.vAllow : Track.limit(D.s), tgt: run.ptcC && run.ptcC.tgt, notch: D.emergency ? 'EB' : notchText(D.lever), lever: D.lever,
      ptc: D.penalty ? 'enforce' : (run.ptc && run.ptc.state) || 'ok', guide: guide(), reverse: !!D.reverse, auto: !!D.auto, doors: D.doors };
  }
  function driveKeys(code) {
    const D = Sim.drive; if (!D) return false;
    switch (code) {
      case 'KeyW': case 'ArrowUp': if (D.reverse && D.v > 0.1) return true; lever(0.125); return true;
      case 'KeyS': case 'ArrowDown': lever(-0.125); return true;
      case 'KeyX': D.lever = 0; return true;
      case 'Backspace': if (!D.emergency) { D.emergency = true; D.lever = -1; emit('toast', 'EMERGENCY BRAKE'); } else if (D.v < 0.05) { D.emergency = false; emit('toast', 'Emergency released'); } return true;
      case 'KeyR': if (D.v < 0.05) { D.emergency = false; D.penalty = false; if (run && run.ptc) run.ptc.state = 'ok'; emit('toast', 'Brakes released'); } return true;
      case 'KeyO': toggleDoors(); return true;
      case 'KeyQ': if (D.v > 0.05) { emit('toast', 'Stop before changing direction'); return true; } if (D.doors > 0) { emit('toast', 'Close the doors first'); return true; } D.reverse = !D.reverse; D.lever = Math.min(D.lever, 0); emit('toast', D.reverse ? 'Reverser: REVERSE (max 5 mph)' : 'Reverser: FORWARD'); return true;
      case 'KeyA': D.auto = !D.auto; emit('toast', D.auto ? 'Autopilot on: the train drives itself (A to take over)' : 'You have control'); return true;
    }
    return false;
  }

  // ---------------- onboard announcements (riding a scheduled train) ----------------
  let annKey = '', lastAnn = {};
  function updateRide() {
    const tr = Player.focusTrain(); if (!tr || tr.driven || !(Player.onboard() || Player.inCab())) return;
    const seg = tr.seg; if (!seg || !tr.plan) return;
    const k = Sim.nextStopK(tr.plan, seg); const s = tr.trip.stops[k]; if (!s) return;
    const key = tr.key + ':' + k;
    if (seg.kind === 1) {
      const left = seg.t1 - Env.time.sec;
      if (Env.time.sec - seg.t0 > 6 && !lastAnn[key + 'n']) { lastAnn[key + 'n'] = 1; Sound.announce && Sound.announce('Next stop: ' + name(s[0]) + '.'); emit('toast', 'Next stop: ' + name(s[0])); }
      if (left < 28 && !lastAnn[key + 'a']) { lastAnn[key + 'a'] = 1; Sound.announce && Sound.announce('Now arriving ' + name(s[0]) + (k === tr.trip.stops.length - 1 ? '. This is the last stop.' : '.')); }
    }
    if (seg.kind === 0 && !seg.final && Env.time.sec > seg.t1 - 9 && !lastAnn[key + 'c']) { lastAnn[key + 'c'] = 1; Sound.doorChime && Sound.doorChime(); }
  }

  // ---------------- missions ----------------
  function nextTripFrom(stId, filter, after) {
    const si = Sim.TT.stations.indexOf(stId); const t0 = after !== undefined ? after : Env.time.sec;
    const deps = Sim.departures(si, t0, 400).filter(d => d.t >= t0 + 30 && filter(d));
    if (deps.length) return deps[0];
    // wrap around: first matching after 5 AM
    const all = Sim.departures(si, 0, 400).filter(d => filter(d)); return all[0] || null;
  }
  const idx = (id) => Sim.TT.stations.indexOf(id);
  function missionList() {
    return [
      { id: 'bullet', kind: 'drive', title: 'The Bullet', sub: 'Next Express southbound from San Francisco. Few stops, lots of 79 mph.', pick: () => nextTripFrom('san_francisco', d => d.trip.route === 'Express' && d.dir === 1) || nextTripFrom('san_francisco', d => d.dir === 1) },
      { id: 'local_nb', kind: 'drive', title: 'Peninsula Local', sub: 'All-stops local from Palo Alto up to San Francisco. Hit every mark.', pick: () => nextTripFrom('palo_alto', d => d.trip.route.startsWith('Local') && d.dir === 0) },
      { id: 'short', kind: 'drive', title: 'Short Hop', sub: 'Mountain View → Sunnyvale → Lawrence. A quick lesson in braking.', pick: () => nextTripFrom('mountain_view', d => d.dir === 1 && d.trip.stops.some(s => s[0] === idx('lawrence'))), end: 'lawrence' },
      { id: 'county', kind: 'drive', title: 'South County Diesel', sub: 'San Jose to Gilroy through the orchards, single track, diesel power.', pick: () => nextTripFrom('sj_diridon', d => d.trip.route === 'South County' && d.dir === 1) || nextTripFrom('tamien', d => d.trip.route === 'South County' && d.dir === 1) },
      { id: 'tunnels', kind: 'drive', title: 'Four Tunnels', sub: 'Northbound from Bayshore under Potrero Hill into 4th & King.', pick: () => nextTripFrom('bayshore', d => d.dir === 0) || nextTripFrom('south_sf', d => d.dir === 0) },
      { id: 'commute', kind: 'commute', title: 'Commuter: 9 AM Meeting', sub: 'Mountain View to 22nd Street before 9:00 AM. Local or express? Choose wisely.', from: 'mountain_view', to: '22nd_street', start: 7 * 3600 + 58 * 60, deadline: 9 * 3600 },
      { id: 'gameday', kind: 'commute', title: 'Game Day', sub: 'San Jose Diridon to San Francisco before first pitch at 6:45 PM.', from: 'sj_diridon', to: 'san_francisco', start: 16 * 3600 + 52 * 60, deadline: 18 * 3600 + 45 * 60 },
      { id: 'tour', kind: 'tour', title: 'Landmark Tour', sub: 'Visit three landmarks by train and on foot: no flying.', count: 3 },
    ];
  }
  function startMission(m) {
    mission = null; if (run) endRun(false);
    if (m.kind === 'drive') {
      const d = m.pick(); if (!d) { emit('toast', 'No suitable train in the timetable today'); return; }
      const endK = m.end ? d.trip.stops.findIndex(s => s[0] === idx(m.end)) : undefined;
      mission = { m, kind: 'drive' }; startDrive(d.plan, { fromK: d.k, endK: endK > d.k ? endK : undefined, title: m.title, mission });
    } else if (m.kind === 'commute') {
      const today = Env.time.sec; Env.setClock(m.start); Env.time.scale = 1;
      const st = Stations.list[idx(m.from)]; Player.teleportToStation(st, m.to === 'san_francisco' || idx(m.to) < idx(m.from) ? 0 : 1);
      mission = { m, kind: 'commute', target: idx(m.to), deadline: m.deadline, done: false };
      emit('toast', `${m.title}: get to ${name(idx(m.to))} by ${Env.clockText(m.deadline)}. Press B for departures.`);
    } else if (m.kind === 'tour') {
      const L = (typeof Landmarks !== 'undefined' && World.landmarks) ? World.landmarks.list.filter(l => Track.dist(l.x, l.z) < 2500) : [];
      if (L.length < 3) { emit('toast', 'Landmarks are still loading'); return; }
      const r = U.rng(Date.now() & 0xffff); const pick = []; while (pick.length < m.count) { const l = L[Math.floor(r() * L.length)]; if (!pick.includes(l)) pick.push(l); }
      mission = { m, kind: 'tour', targets: pick.map(l => ({ l, done: false })), t0: Env.time.sec };
      const st = Stations.nearest({ x: pick[0].x, z: pick[0].z }, 1e9); Player.teleportToStation(st, 1);
      emit('toast', 'Tour: ' + pick.map(p => p.l.name).join(' · ') + '. Use M for the map.');
    }
    emit('mission', mission);
  }
  function finishMission(ok, extra) { if (!mission) return; const m = mission; mission = null; emit('missionDone', { m, ok, extra }); }
  function updateMission(dt) {
    if (!mission) return;
    const pos = Env.camera.position;
    if (mission.kind === 'commute') {
      const st = Stations.list[mission.target]; const d = Math.hypot(st.x - pos.x, st.z - pos.z);
      const t = Env.time.sec;
      if (d < 160 && (Player.mode === 'walk')) { const early = mission.deadline - t; finishMission(early >= 0, { early });
        emit('result', { kicker: 'Commute', title: early >= 0 ? 'Made it!' : 'Late…', score: Math.max(0, Math.round(500 + early / 2)), grade: early > 600 ? 'A' : early >= 0 ? 'B' : 'F',
          lines: [early >= 0 ? `Arrived with ${Math.round(early / 60)} min to spare.` : `Arrived ${Math.round(-early / 60)} min late.`] }); }
      else if (t > mission.deadline + 1800) { finishMission(false); emit('toast', 'Mission failed: too late'); }
    } else if (mission.kind === 'tour') {
      if (Player.mode === 'fly') { Player.setMode('walk'); emit('toast', 'No flying on the tour: ride the trains!'); }
      for (const tg of mission.targets) if (!tg.done && Math.hypot(tg.l.x - pos.x, tg.l.z - pos.z) < Math.max(160, tg.l.radius || 0)) { tg.done = true; emit('toast', 'Visited ' + tg.l.name + '!'); }
      if (mission.targets.every(t => t.done)) { const mins = (Env.time.sec - mission.t0) / 60; finishMission(true);
        emit('result', { kicker: 'Landmark tour', title: 'Tour complete', score: Math.max(100, Math.round(1500 - mins * 8)), grade: mins < 60 ? 'A' : mins < 120 ? 'B' : 'C', lines: [`Three landmarks in ${Math.round(mins)} minutes of Bay Area time.`] }); }
    }
  }
  function update(dt) { updateRun(dt); updateRide(); updateMission(dt); }
  return { update, startDrive, endRun, stopInfo, driveKeys, dmi, guide, missionList, startMission, on: (f) => listeners.push(f), get run() { return run; }, get mission() { return mission; }, best };
})();
