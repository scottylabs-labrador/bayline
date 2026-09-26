// Bayline Metro: train control and the drive game (the metro counterpart of the Peninsula PTC drive in 62_game.js).
//
// Wayside ATC in the style of the real system: the line is cut into track circuits (~180 m) and each circuit carries a
// speed code. The code at the head of the train is the lower of
//   * the civil code: MetroNet's civil code there (M2 data: BART's codes 6/18/27/36/50/70 per segment; a run's
//     timetable-consistent floor rounds up to the next code), and
//   * the occupancy code: counted in clear circuits to the next obstruction (the tail of any train on the tracks ahead,
//     from any line, or the end of the track): 0 clear -> stop, 1 -> 6 mph, 2 -> 18, 3 -> 27, 4 -> 36, 5 -> 50, 6+ -> line
//     speed. (The real system's codes: 0, 6, 18, 27, 36, 50, 70, 80 mph.)
// ATO drives to the code and makes the programmed station stop at the berth mark. In MANUAL the player drives with the
// master controller and ATC supervises: an overspeed alarm above the code, an ATC service brake if the player doesn't
// react (or is far over), and a penalty (emergency) brake when a stop code is passed. Scoring: stopping accuracy at the
// berth, punctuality against the published times, comfort (jerk), ATC interventions.
const MetroATC = (() => {
  const MPH = 0.44704, BLOCK = 180, B_ATC = 0.9;
  const LADDER = [0, 6, 18, 27, 36, 50, 70].map(v => v * MPH);
  const on = () => typeof MetroSim !== 'undefined' && MetroSim.enabled && MetroSim.ready;
  let run = null;                                      // active drive run
  const F = {}, Q = {};
  const best = (() => { try { return JSON.parse(localStorage.getItem('bayline.metro.best') || '{}'); } catch (e) { return {}; } })();
  function saveBest() { try { localStorage.setItem('bayline.metro.best', JSON.stringify(best)); } catch (e) { /* private mode */ } }
  const toast = (m, t = 4) => { if (typeof UI !== 'undefined') UI.toast(m, t); };
  const ft = (m) => m > 1609 ? (m / 1609.34).toFixed(1) + ' mi' : Math.round(m * 3.281) + ' ft';

  // ---------------------------------------------------------------- occupancy index (per frame, only while driving)
  // track -> [[sMin, sMax], ...] of every other train's body
  const occ = new Map(); let occFrame = -1;
  function buildOcc(self) {
    occ.clear();
    for (const tr of MetroSim.running) {
      if (tr === self || !tr.leg || tr.driven) continue;
      const P = tr.leg.path; const n = Math.max(2, Math.ceil(tr.len / 40));
      for (let i = 0; i <= n; i++) {
        const ps = tr.s - tr.len * i / n; if (ps < -50 || ps > P.length + 50) continue;
        P.leg.locate(Math.max(0, Math.min(P.length, ps)), Q); const t = Q.track;
        let L = occ.get(t); if (!L) occ.set(t, L = []);
        L.push(Q.s);
      }
    }
  }
  function occupied(track, s, tol) { const L = occ.get(track); if (!L) return false; for (let i = 0; i < L.length; i++) if (Math.abs(L[i] - s) < tol) return true; return false; }
  // distance from the head to the first obstruction ahead on the path (m), up to `max`
  function obstruction(D, max = 2400) {
    const P = D.leg.path; let d = 0;
    for (d = 8; d <= max; d += 16) {
      const ps = D.s + d; if (ps > P.length) return { dist: P.length - D.s, why: 'end of track' };
      P.leg.locate(ps, Q); if (occupied(Q.track, Q.s, 24)) return { dist: d - 20, why: 'train ahead' };
    }
    return null;
  }
  // a civil speed as a wayside code: BART's train-control codes 6/18/27/36/50/70 (MetroNet's M2 limits already are
  // codes, so this is exact for them; a timetable floor rounds up to the next code), the DMU and the cable train in
  // 5 mph steps like their data
  const CODES = [6, 18, 27, 36, 50, 70].map(v => v * MPH);
  function asCode(v, kind, up) {
    if (kind !== 'bart') return Math.floor(v / MPH / 5 + 1e-6) * 5 * MPH;
    if (up) { for (const c of CODES) if (c >= v - 0.05) return c; return CODES[CODES.length - 1]; }
    let r = CODES[0]; for (const c of CODES) if (c <= v + 0.05) r = c; return r;
  }
  // the civil code at a path position for the driven leg: the data's code there, or the run's timetable floor (which
  // keeps the published times possible) when that is higher
  function civil(D, ps) { const S = D.leg.stops; let fl = 0; for (let k = 0; k < S.length - 1; k++) if (ps >= S[k].ps - 1 && ps <= S[k + 1].ps + 1) { fl = S[k].floor || 0; break; }
    const lim = D.leg.path.limitAt(ps); return fl > lim + 0.05 ? asCode(fl, D.kind, true) : asCode(lim, D.kind, false); }
  function codeFor(D) {
    if (occFrame !== MetroSim.stats.frame) { buildOcc(MetroSim.trainByKey(D.key)); occFrame = MetroSim.stats.frame; }
    // civil code: the lowest limit over the train's length and the circuit ahead (the tail rule, in circuits)
    const len = D.cars * MetroSim.PERF[D.kind].carLen; let cv = 1e9;
    for (let p = D.s - len; p <= D.s + BLOCK * 0.5; p += 20) cv = Math.min(cv, civil(D, p));
    const ob = obstruction(D); let oc = 1e9, clear = 99;
    if (ob) { clear = Math.max(0, Math.floor(ob.dist / BLOCK)); oc = LADDER[Math.min(LADDER.length - 1, clear)]; }
    const code = Math.min(cv, oc, MetroSim.PERF[D.kind].vmax);
    return { code, civil: cv, occ: oc, clear, ob };
  }
  // the next civil restriction ahead and the station stop, for ATO and the braking guidance
  // (as codes, and brought forward by the half circuit the code looks ahead)
  function targetsAhead(D, max = 2400) {
    const out = []; let prev = civil(D, D.s);
    for (let a = 20; a <= max; a += 20) { const l = civil(D, D.s + a); if (l < prev - 0.3) out.push({ dist: Math.max(0, a - 20 - BLOCK * 0.5 - 15), v: l, why: 'limit' }); prev = l; }
    return out;
  }

  // behind a train: the code steps down one rung each time the head crosses into the next circuit toward it; to stay
  // under the code, be at LADDER[k-1] by the time k clear circuits remain
  function occTargets(C, out) {
    out.length = 0; if (!C.ob) return out;
    const d = C.ob.dist, c = Math.min(LADDER.length - 1, Math.floor(d / BLOCK));
    for (let k = 1; k <= c; k++) out.push({ dist: Math.max(0, d - k * BLOCK - 10), v: LADDER[k - 1], why: 'train ahead' });
    out.push({ dist: Math.max(0, d - 30), v: 0, why: 'train ahead' });
    return out;
  }
  const OT = [];

  // ---------------------------------------------------------------- the drive run
  function nextStop(D) { const S = D.leg.stops; for (let k = 0; k < S.length; k++) if (S[k].ps > D.s + 4 && k > (run ? run.atK : -1)) return k; return -1; }
  function stopInfo() {
    if (!run) return null; const D = MetroSim.drive; if (!D) return null;
    const S = D.leg.stops, k = run.k; if (k < 0 || k >= S.length) return null;
    const s = S[k]; return { k, st: s.st, name: MetroSim.stName(s.st), target: s.ps, togo: s.ps - D.s, sched: s.arr, dep: s.dep, plen: s.plen || 213.4, last: k === S.length - 1 && !D.leg.next, rev: !!D.leg.next && k === S.length - 1 };
  }
  function start(plan, opts = {}) {
    if (!on()) return null;
    if (typeof Flight !== 'undefined' && Flight.active) Flight.stop(true);
    if (typeof Game !== 'undefined' && Game.run) Game.endRun(false, true);
    if (run) end(false, true);
    // the leg to drive: BART trains only (the DMU and the cable train are driven by their own crews/automation)
    const legs = plan.legs.filter(l => l.kind === 'bart'); if (!legs.length) { toast('That train is not one you can drive'); return null; }
    let L = legs[0], k0 = 0;
    if (opts.station) { for (const l of legs) { const k = l.stops.findIndex(s => s.st === opts.station); if (k >= 0 && k < l.stops.length - 1) { L = l; k0 = k; break; } } }
    const dep = L.stops[k0].dep, now = Env.time.sec;
    if (now > dep - 20 || now < dep - 3600) Env.setClock(Math.max(0, dep - 55)); else Env.setClock(Math.max(now, dep - 95));
    Env.time.scale = 1;
    const D = MetroSim.startDrive(plan, { leg: plan.legs.indexOf(L), auto: !!opts.auto });
    D.s = L.stops[k0].ps; D.v = 0; D.doors = 1; D.doorsTarget = 1; D.ato = opts.manual ? false : true; D.mode = D.ato ? 'ato' : 'manual';
    D.doorSideNow = doorSideAt(L, k0);
    run = { plan, trip: plan.trip, k0, k: k0 + 1, atK: k0, state: 'dwell', score: 0, dwellT: 0, stopT: 0, mission: opts.mission || null, title: opts.title || '',
      stats: { stops: 0, ontime: 0, perfect: 0, errSum: 0, overs: 0, atcBrakes: 0, penalties: 0, harsh: 0, dist: 0, t0: Env.time.sec, missed: 0 }, warnT: 0, atc: { state: 'ok' }, log: [], announced: {} };
    Player.setFocus(D.key); Player.setMode('cab');
    toast(`You have the ${MetroSim.lineName(L.line)} to ${MetroSim.stName(L.stops[L.stops.length - 1].st)}. ${D.ato ? 'ATO is on: at departure press W (doors close, the train goes).' : 'Manual: W for power once the doors are closed.'} A switches ATO / manual.`, 7);
    return run;
  }
  function doorSideAt(L, k) { const trav = MetroSim.stopSide(L, k); return (trav > 0) === (L.lead === 0) ? 'right' : 'left'; }
  function end(completed, quiet) {
    if (!run) return; const r = run; run = null; MetroSim.stopDrive();
    if (quiet) return;
    const st = r.stats, mins = (Env.time.sec - st.t0) / 60;
    const n = Math.max(1, st.stops), q = r.score / Math.max(250, n * 250);
    const grade = q >= 0.95 ? 'A+' : q >= 0.85 ? 'A' : q >= 0.7 ? 'B' : q >= 0.5 ? 'C' : q >= 0.3 ? 'D' : 'F';
    const key = r.trip.pat + ':' + r.k0;
    const prev = best[key]; if (completed && (!prev || r.score > prev)) { best[key] = Math.round(r.score); saveBest(); }
    if (typeof UI !== 'undefined') UI.showResult({ kicker: completed ? 'Metro run complete' : 'Run ended', title: completed ? (grade.startsWith('A') ? 'Right on the berth' : grade === 'B' ? 'Solid run' : 'You made it') : 'Off duty early',
      score: Math.round(r.score), grade, lines: [
        `${MetroSim.lineName(r.plan.line)} · ${(st.dist / 1609.34).toFixed(1)} mi in ${mins.toFixed(0)} min`,
        `Station stops: ${st.stops} · on time ${st.ontime} · on the berth ${st.perfect}${st.stops ? ` · average error ${(st.errSum / st.stops).toFixed(2)} m` : ''}`,
        `ATC: ${st.overs} overspeed alarms · ${st.atcBrakes} ATC brakes · ${st.penalties} penalty stops · rough rides ${st.harsh}`,
        prev ? `Best on this run: ${prev}` : 'First time on this run'] });
    if (r.mission && typeof MetroMissions !== 'undefined') MetroMissions.done(r.mission, completed && r.score > 0);
  }
  function add(pts, msg) { if (!run) return; run.score += pts; run.log.push([Env.time.sec, pts, msg]); if (msg) toast((pts > 0 ? '+' : '') + Math.round(pts) + '  ' + msg, 2.6); }
  function arrive(inf) {
    const D = MetroSim.drive, st = run.stats, err = Math.abs(inf.togo); st.stops++; st.errSum += err;
    if (err < 0.5) { add(150, 'On the berth'); st.perfect++; } else if (err < 1.5) add(100, 'Good stop'); else if (err < 4) add(50, 'Stop ' + err.toFixed(1) + ' m off the berth'); else add(10, 'Well off the berth');
    const late = Env.time.sec - inf.sched;
    if (late < 45 && late > -90) { add(100, 'On time'); st.ontime++; } else if (late >= 45 && late < 180) add(30, Math.round(late / 60) + ' min late'); else if (late >= 180) add(-30, Math.round(late / 60) + ' min late'); else add(40, 'Early: hold for the departure time');
    D.doorSideNow = doorSideAt(D.leg, inf.k); D.doorsTarget = 1; D.reverse = false;
    run.state = 'dwell'; run.atK = inf.k; run.dwellT = 0; run.stopT = 0;
    if (inf.last) setTimeout(() => end(true), 2500);
    else if (inf.rev) toast('End of this direction: press Q to change ends', 5);
    run.k = inf.k + 1;
    announceArrival(inf);
  }
  function announceArrival(inf) { if (typeof MetroSound !== 'undefined') MetroSound.arrival(MetroSim.drive && MetroSim.trainByKey(MetroSim.drive.key), inf.k); }
  const depTime = () => { const D = MetroSim.drive; return D.leg.stops[run.atK].dep; };
  function closeDoors(quiet) { const D = MetroSim.drive; if (!D || D.doorsTarget <= 0) return; D.doorsTarget = 0; if (typeof MetroSound !== 'undefined') MetroSound.doorChime(); if (!quiet && run.state === 'dwell' && Env.time.sec < depTime() - 10) add(-30, 'Doors closed before departure time'); }
  function toggleDoors() {
    const D = MetroSim.drive; if (!D || !run) return;
    if (D.doorsTarget > 0) { closeDoors(); return; }
    if (D.v > 0.2) { toast('Stop the train before opening the doors'); return; }
    if (run.state === 'dwell') { D.doorsTarget = 1; return; }
    const inf = stopInfo(); const tol = inf ? Math.max(3, (inf.plen - D.cars * MetroSim.PERF[D.kind].carLen)) : 0;
    if (!inf || inf.togo > tol || inf.togo < -3) { toast(inf ? (inf.togo > 0 ? `Not on the platform yet: berth ${ft(inf.togo)} ahead` : `Overran the berth by ${ft(-inf.togo)}: Q to reverse`) : 'No platform here'); return; }
    arrive(inf);
  }

  // ---------------------------------------------------------------- ATO: drive to the code and stop on the berth
  function ato(D, h, C) {
    if (run && run.state === 'dwell') {
      if (D.doors > 0.01 || D.doorsTarget > 0) { D.lever = -0.5; if (D.autoDepart && Env.time.sec > depTime() - 6) closeDoors(true); return; }
      if (!D.go && !D.autoDepart) { D.lever = -0.5; return; }            // doors shut: waits for the operator's start (W)
    }
    const inf = stopInfo(); let vt = C.code - 1.5 * MPH;
    for (const t of targetsAhead(D, 1600)) vt = Math.min(vt, Math.sqrt(Math.max(0, t.v - 1.5 * MPH) ** 2 + 2 * 0.75 * Math.max(0, t.dist - D.v * 1.6)));
    for (const t of occTargets(C, OT)) vt = Math.min(vt, Math.sqrt(Math.max(0, t.v - 1.5 * MPH) ** 2 + 2 * 0.75 * Math.max(0, t.dist - D.v * 1.6)));
    if (inf) { const d = inf.togo - 0.1; vt = Math.min(vt, d <= 0 ? 0 : Math.sqrt(2 * 0.9 * Math.max(0, d - D.v * 0.5)) + (d < 5 ? 0.15 : 0)); }
    D.commanded = Math.max(0, vt);
    const P = MetroSim.PERF[D.kind], e = vt - D.v, aDes = U.clamp(e * 0.55, -P.bFull, P.a0);
    const aMax = Math.min(P.a0, P.pw / Math.max(D.v, 0.5));
    let want = aDes > 0.04 ? U.clamp(aDes / aMax, 0, 1) : aDes < -0.04 ? U.clamp(aDes / P.bFull, -1, 0) : 0, rate = 1.2;
    // programmed station stop: brake exactly as hard as the remaining distance needs (feed-forward on v²/2d)
    if (inf && inf.togo < 400 && D.v > 0.3) { const d = Math.max(0.05, inf.togo - 0.05), aReq = D.v * D.v / (2 * d);
      if (aReq > 0.45) { want = -U.clamp(aReq * 1.02 / P.bFull, 0, 1); rate = 3; } }
    if (inf && inf.togo < 1.5 && inf.togo > 0.1 && D.v < 0.4) { want = 0.06; rate = 3; }       // creep the last metre
    D.lever += U.clamp(want - D.lever, -rate * h, rate * h);          // the ATO moves smoothly (no jerky notching)
    if (inf && inf.togo <= 0.1 && D.v < 1.2) D.lever = -1;
    if (inf && D.v < 0.05 && run && run.state !== 'dwell' && Math.abs(inf.togo) < 2.5) arrive(inf);
  }

  // ---------------------------------------------------------------- supervision (called by MetroSim at 20 Hz sub-steps)
  function supervise(D, h) {
    if (!run) { D.atcBrake = 0; return; }
    const C = codeFor(D); run.code = C;
    if (D.ato && !D.penalty && !D.emergency) ato(D, h, C);
    const over = D.v - C.code, A = run.atc;
    D.atcBrake = 0;
    if (D.ato && !D.penalty) { if (over > 3 * MPH) D.atcBrake = MetroSim.PERF[D.kind].bFull; A.state = 'ok'; return; }   // (ATO answers the code itself)
    if (D.penalty) { A.state = 'penalty'; if (D.v < 0.05) { A.stopT = (A.stopT || 0) + h; } return; }
    if (C.code < 0.5 && D.v > 2 * MPH && !D.ato) { D.penalty = true; A.state = 'penalty'; A.stopT = 0; run.stats.penalties++; add(-200, 'Passed a stop code: penalty brake'); if (typeof Sound !== 'undefined' && Sound.alert) Sound.alert('enforce'); return; }
    if (A.state === 'brake') { D.atcBrake = MetroSim.PERF[D.kind].bFull; if (D.v < C.code - 2 * MPH || D.v < 0.5) { A.state = 'ok'; toast('ATC brake released'); } return; }
    if (over > 1 * MPH) {
      if (A.state !== 'warn') { A.state = 'warn'; A.warnT = 0; run.stats.overs++; if (typeof Sound !== 'undefined' && Sound.alert) Sound.alert('warn'); }
      A.warnT += h; const braking = D.lever <= -0.25;
      if (over > 4 * MPH || (A.warnT > 2.5 && !braking)) { A.state = 'brake'; run.stats.atcBrakes++; add(-50, 'ATC overspeed brake'); if (typeof Sound !== 'undefined' && Sound.alert) Sound.alert('enforce'); }
    } else if (A.state === 'warn') A.state = 'ok';
  }

  // ---------------------------------------------------------------- per frame (game time)
  function update(dt) {
    const D = on() ? MetroSim.drive : null;
    if (!run || !D) { if (run && !D) run = null; return; }
    const st = run.stats; st.dist = D.odometer;
    D.nextK = run.k; D.atK = run.state === 'dwell' ? run.atK : -1;
    if (D.lever > 0 && D.doorsTarget > 0 && run.state === 'dwell' && !D.ato) closeDoors();
    const inf = stopInfo();
    if (run.state === 'dwell') {
      run.dwellT += dt;
      if (D.doors < 0.01 && D.v > 0.5) {
        if (Env.time.sec < depTime() - 10) add(-60, 'Departed early');
        run.state = 'run'; run.stopT = 0; D.go = false;
        if (typeof MetroSound !== 'undefined' && inf) MetroSound.departure(MetroSim.trainByKey(D.key), inf.k);
      }
    } else if (inf) {
      const tol = Math.max(3, inf.plen - D.cars * MetroSim.PERF[D.kind].carLen);
      if (D.v < 0.05 && inf.togo <= tol && inf.togo >= -3 && !D.emergency && !D.penalty && !D.ato) { run.stopT += dt; if (run.stopT > 1.4) arrive(inf); }
      else run.stopT = 0;
      if (inf.togo < -80 && D.v > 3) { add(-150, 'Ran through ' + inf.name); st.missed++; run.k++; if (run.k >= D.leg.stops.length && !D.leg.next) end(true); }
      if (inf.togo < 400 && !run.announced[inf.k] && D.v > 3) { run.announced[inf.k] = 1; if (typeof MetroSound !== 'undefined') MetroSound.approaching(MetroSim.trainByKey(D.key), inf.k); }
    }
    if (D.penalty && D.v < 0.05 && (run.atc.stopT || 0) > 3) { /* waits for R */ }
    if (D.jerk > 1.3 && D.v > 1 && !D.ato) { run.harshT = (run.harshT || 0) + dt; if (run.harshT > 0.4 && Env.time.sec - (run.lastHarsh || 0) > 4) { run.harshT = 0; run.lastHarsh = Env.time.sec; st.harsh++; add(-15, 'Rough ride'); } } else run.harshT = 0;
    if (D.emergency && !run.emWas) add(-100, 'Emergency brake'); run.emWas = D.emergency;
  }
  function lever(delta) { const D = MetroSim.drive; if (!D) return; D.lever = U.clamp(Math.round((D.lever + delta) * 8) / 8, -1, 1); }
  function driveKeys(code) {
    const D = on() ? MetroSim.drive : null; if (!D || !run) return false;
    switch (code) {
      case 'KeyW': case 'ArrowUp':
        if (D.ato) { if (run.state === 'dwell') { if (D.doorsTarget > 0) closeDoors(); D.go = true; toast('ATO: departing when the doors are closed'); } return true; }
        if (D.reverse && D.v > 0.1) return true; lever(0.125); return true;
      case 'KeyS': case 'ArrowDown': if (D.ato) { D.ato = false; D.mode = 'manual'; toast('Manual: ATC is supervising'); } lever(-0.125); return true;
      case 'KeyX': D.lever = 0; return true;
      case 'Backspace': if (!D.emergency) { D.emergency = true; D.lever = -1; toast('EMERGENCY BRAKE'); } else if (D.v < 0.05) { D.emergency = false; toast('Emergency released'); } return true;
      case 'KeyR': if (D.v < 0.05) { D.emergency = false; D.penalty = false; run.atc.state = 'ok'; toast('Brakes released'); } return true;
      case 'KeyO': toggleDoors(); return true;
      case 'KeyQ':
        if (D.v > 0.05) { toast('Stop before changing ends'); return true; }
        if (D.leg.next && run.atK === D.leg.stops.length - 1) { if (D.doorsTarget > 0 || D.doors > 0) { closeDoors(true); } MetroSim.driveNextLeg(); run.k = 1; run.atK = 0; run.state = 'dwell'; D.doorsTarget = 1; D.doorSideNow = doorSideAt(D.leg, 0); toast('Changed ends: the cab is now at the other end of the train'); Player.setMode('cab'); return true; }
        if (D.doors > 0) { toast('Close the doors first'); return true; }
        D.reverse = !D.reverse; D.lever = Math.min(D.lever, 0); toast(D.reverse ? 'Reverse: back up at walking pace (max 3 mph)' : 'Forward'); return true;
      case 'KeyA': D.ato = !D.ato; D.mode = D.ato ? 'ato' : 'manual'; toast(D.ato ? 'ATO on: the train drives itself (W starts it from a station)' : 'Manual: you drive, ATC supervises'); return true;
      case 'Space': return false;                     // horn: held key, read by the sound frame
    }
    return false;
  }
  // what the operator should do next
  function guide() {
    const D = MetroSim.drive; if (!run || !D) return '';
    const inf = stopInfo(), C = run.code || { code: 0 }, A = run.atc;
    if (D.emergency) return D.v > 0.1 ? 'EMERGENCY BRAKE: stopping' : 'Emergency brake applied · R to release';
    if (D.penalty) return D.v > 0.1 ? 'PENALTY BRAKE: stop code passed' : 'Penalty stop · R to reset ATC';
    if (A.state === 'brake') return `ATC BRAKE: over the ${Math.round(C.code / MPH)} mph code`;
    if (A.state === 'warn') return `OVERSPEED: brake to ${Math.round(C.code / MPH)} mph now`;
    if (run.state === 'dwell') {
      if (inf && inf.rev === undefined) {}
      const left = depTime() - Env.time.sec;
      if (D.leg.next && run.atK === D.leg.stops.length - 1) return 'Reversal: Q changes ends';
      if (D.doorsTarget > 0) return left > 1 ? `Boarding · departs ${Env.clockText(depTime())} (in ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')})${D.ato ? ' · W: close doors and go' : ' · O closes doors'}` : (D.ato ? 'Time to go: W closes the doors and starts ATO' : 'Time to go: O closes the doors, then W');
      if (D.doors > 0.01) return 'Doors closing…';
      return D.ato ? (D.go ? 'ATO departing…' : 'Doors closed · W to start') : 'Doors closed · W for power';
    }
    if (D.ato) return inf ? `ATO · next ${inf.name} · ${ft(Math.max(0, inf.togo))} · code ${Math.round(C.code / MPH)}` : 'ATO';
    if (D.reverse) return inf ? `REVERSE · berth ${inf.togo < 0 ? ft(-inf.togo) + ' behind' : 'reached'} · Q for forward` : 'REVERSE';
    if (inf) {
      if (D.v < 0.1 && inf.togo > 3) return `Stopped short · creep ${ft(inf.togo)} to the berth`;
      if (D.v < 0.1 && inf.togo < -3) return `Overran by ${ft(-inf.togo)} · Q to reverse`;
      if (inf.togo < 900 && D.v > 0.5) { const need = D.v * D.v / (2 * Math.max(1, inf.togo)); return need > 0.95 ? `BRAKE NOW · berth in ${ft(inf.togo)}` : need > 0.7 ? `Start braking · berth in ${ft(inf.togo)}` : `Approaching ${inf.name} · berth in ${ft(inf.togo)}`; }
    }
    if (C.ob && C.clear < 4) return `Train ahead: code ${Math.round(C.code / MPH)} mph (${C.clear} clear circuit${C.clear === 1 ? '' : 's'})`;
    const T = targetsAhead(D, 1500)[0]; if (T && T.v < C.code - 1) return `Code drops to ${Math.round(T.v / MPH)} mph in ${ft(T.dist)}`;
    return inf ? `Next ${inf.name} · ${ft(Math.max(0, inf.togo))} · code ${Math.round(C.code / MPH)} mph` : '';
  }
  function notchText(l) { const n = Math.round(l * 8); return n > 0 ? 'P' + n : n < 0 ? 'B' + (-n) : 'N'; }
  // driver's display (HUD panel and the cab screen)
  function dmi() {
    const D = on() ? MetroSim.drive : null; if (!run || !D) return null;
    const inf = stopInfo(), C = run.code || { code: 0, civil: 0 };
    // the next lower code ahead and the speed a service-brake curve allows now (what a careful operator drives to)
    let tgt = null, vAllow = C.code;
    for (const t of targetsAhead(D, 2000)) { const va = Math.sqrt(t.v * t.v + 2 * 0.8 * t.dist); if (va < vAllow) { vAllow = va; tgt = t; } }
    for (const t of occTargets(C, OT)) { const va = Math.sqrt(t.v * t.v + 2 * 0.8 * t.dist); if (va < vAllow) { vAllow = va; tgt = t; } }
    return { v: D.v, code: C.code, civil: C.civil, clear: C.clear, target: tgt, vAllow, mode: D.ato ? 'ATO' : 'MANUAL', notch: D.emergency ? 'EB' : notchText(D.lever), lever: D.lever,
      atc: D.penalty ? 'penalty' : run.atc.state, guide: guide(), reverse: !!D.reverse, doors: D.doors, next: inf, score: run.score, late: inf ? behind(D) : 0 };
  }
  // what the cab screen shows on any metro train you are in (driving or riding in the cab)
  function cabDisplay(tr) {
    const D = MetroSim.drive, d = D && tr.driven ? dmi() : null;
    const S = tr.leg.stops, k = d && d.next ? d.next.k : tr.nextK, ns = S[k];
    // (MetroKit's VATC screen: ACTUAL speedMph, AUTHORIZED atcCodeMph, COMMANDED targetMph, effort -1 brake .. 1 power)
    const code = d ? d.code / MPH : Math.min(70, tr.lim ? tr.lim / MPH : 70), cmd = D && tr.driven ? (D.ato ? (D.commanded || 0) : d.vAllow) / MPH : tr.v / MPH;
    const lever = D && tr.driven ? (D.emergency || D.penalty ? -1 : D.lever) : U.clamp((tr.a || 0) / 1.34, -1, 1);
    return { speedMph: tr.v / MPH, codeMph: code, atcCodeMph: Math.round(code), commandedMph: cmd, targetMph: Math.round(cmd), effort: lever, handle: lever, brake: Math.max(0, -lever),
      mode: d ? d.mode : 'ATO', notchText: d ? d.notch : '', doors: tr.doorT > 0.02 ? 'open ' + (tr.doorSide || '') : 'closed', cars: tr.cars,
      nextStop: ns ? MetroSim.stName(ns.st) : '', distFt: ns ? Math.max(0, ns.ps - tr.s) * 3.281 : 0, clock: Env.clockText(Env.time.sec), atc: d ? d.atc : 'ok',
      line: MetroSim.lineName(tr.line), color: MetroSim.lineColor(tr.line), lineColor: MetroSim.lineColor(tr.line), destination: MetroSim.termName(tr) };
  }
  // how far behind the timetable plan the driven train is (s, negative = early): at a stop, the planned departure
  // (never negative while boarding); between stops, the planned time at the train's position on that run's profile
  const RB = {};
  function behind(D) {
    const l = D.leg, S = l.stops, R = l.runs, now = Env.time.sec; if (!R || !R.length) return 0;
    let k = -1; for (let i = 0; i < R.length; i++) if (S[R[i].k].ps <= D.s + 0.5) k = i; if (k < 0) return 0;
    const run = R[k], a = S[run.k];
    if (D.s <= a.ps + 0.5) return Math.max(0, now - a.tDep);
    if (!run.R) run.R = MetroSim.getRun(l.path, a.ps, S[run.k + 1].ps, l.kind, l.cars, run.T, a.floor || 0);
    let lo = 0, hi = run.T; for (let it = 0; it < 28; it++) { const m = (lo + hi) / 2; MetroSim.runAt(run.R, m, RB); if (RB.ps < D.s) lo = m; else hi = m; }
    return now - (run.t0 + (lo + hi) / 2);
  }
  const api = { start, end, update, supervise, driveKeys, dmi, guide, stopInfo, cabDisplay, codeFor, behind, get run() { return run; }, best, LADDER, BLOCK };
  if (typeof window !== 'undefined') (window.__baylineMods = window.__baylineMods || {}).MetroATC = api;
  return api;
})();
