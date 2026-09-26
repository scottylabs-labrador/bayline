// Bayline Metro sound (#metro=1 only), synthesized with Web Audio on the Sound engine's buses (70_sound.js plugin hook).
//   * Traction 'metro' (Fleet of the Future style: four 194 hp motors per car on IGBT inverters): the gear-mesh whine
//     that climbs with speed (the sound of the system at 70 mph), motor magnetic noise at 6 x the electrical frequency,
//     and the inverter song: an asynchronous carrier with its +-2 fe sidebands at low speed, then synchronous modes
//     that step down as the train accelerates, under regenerative braking in reverse.
//   * Structure: the aerial box girder's low boom, the Transbay Tube's hollow roar (plus the engine's tunnel reverb),
//     and the famous flange squeal where the real system squeals (Market St / Mission curves, the Tube approaches, the
//     Oakland Wye, Daly City and the Glen Park - Balboa Park reverse curves), scaled by the curvature under the train.
//   * The cable train to the airport ('cable'): a quiet hum, the haul rope singing over the sheaves.
//   * Door chime (descending three tones, then the doors), announcements with speechSynthesis (neutral voice):
//     onboard ("This is a Yellow Line train to SFO Airport. The next station is Montgomery Street.") and on platforms
//     ("Ten car Antioch train now approaching platform 2.").
const MetroSound = (() => {
  const on = () => typeof MetroSim !== 'undefined' && MetroSim.enabled && MetroSim.ready;
  const MPH = 0.44704;
  const st = { struct: 0, aerial: 0, tube: 0 };            // listener's train: structure layers (0..1), set every frame
  let chimeBuf = null, engine = null;

  // ---------------------------------------------------------------- the traction sets (Sound engine plugin)
  // (installed from 90_main at boot: 70_sound.js is later in the build, so Sound can't be touched while this file loads)
  let installed = false;
  function init() { if (installed || typeof Sound === 'undefined' || !Sound.plugin) return; installed = true; Sound.plugin(plugin); }
  function plugin(E) {
    engine = E; const X = E.ext; let m = null, c = null;
    function build() {
      m = {}; m.out = X.G(1); m.out.connect(X.trainBus);
      m.gear = X.O('sine', 60); m.gearG = X.G(0); X.chain(m.gear, m.gearG, m.out);
      m.gear2 = X.O('sine', 120); m.gear2G = X.G(0); X.chain(m.gear2, m.gear2G, m.out);
      m.mot = X.O('triangle', 40); m.motBP = X.F('bandpass', 300, 1.8); m.motG = X.G(0); X.chain(m.mot, m.motBP, m.motG, m.out);
      m.car = X.O('sine', 1150); m.sbA = X.O('sine', 1180); m.sbB = X.O('sine', 1120); m.carBP = X.F('bandpass', 1150, 1.2); m.carG = X.G(0);
      const sb = X.G(0.5); m.sbA.connect(sb); m.sbB.connect(sb); m.car.connect(m.carBP); sb.connect(m.carBP); X.chain(m.carBP, m.carG, m.out);
      m.aux = X.O('sine', 360); m.aux2 = X.O('sine', 720); m.auxG = X.G(0); const a2 = X.G(0.3); m.aux.connect(m.auxG); m.aux2.connect(a2); a2.connect(m.auxG); m.auxG.connect(m.out);
      m.boom = X.Loop(X.B.brown); m.boomLP = X.F('lowpass', 85, 0.9); m.boomG = X.G(0); X.chain(m.boom, m.boomLP, m.boomG, m.out);
      m.tube = X.Loop(X.B.pink); m.tubeBP = X.F('bandpass', 165, 2.6); m.tubeG = X.G(0); X.chain(m.tube, m.tubeBP, m.tubeG, m.out);
      m.gains = [m.gearG, m.gear2G, m.motG, m.carG, m.auxG, m.boomG, m.tubeG];
    }
    function metro(active, v, p, dt, S) {
      if (!active) { if (m) for (const g of m.gains) X.ramp(g.gain, 0, 0.25); return; }
      if (!m) build();
      const load = Math.min(1, Math.abs(p)), regen = p < -0.05, run = X.smooth(0.2, 2.2, v), fe = 5.7 * v;
      const inside = S.inCab ? 0.8 : S.onboard ? 1.2 : 1;
      // gear mesh (17-tooth pinion): the whine climbs with speed and stays loud at line speed
      X.ramp(m.gear.frequency, 30 + 48 * v, 0.04); X.ramp(m.gear2.frequency, 60 + 96 * v, 0.04);
      X.ramp(m.gearG.gain, 0.03 * run * (0.35 + 0.65 * load) * (0.6 + 0.4 * X.smooth(5, 30, v)) * inside, 0.1);
      X.ramp(m.gear2G.gain, 0.01 * run * (0.3 + 0.7 * load) * X.smooth(8, 28, v) * inside, 0.1);
      X.ramp(m.mot.frequency, 20 + 6 * fe, 0.04); X.ramp(m.motBP.frequency, 40 + 6 * fe, 0.05); X.ramp(m.motG.gain, 0.05 * run * (0.2 + 0.8 * load) * inside, 0.1);
      // inverter: async carrier below ~16 mph, then synchronous 15, 9 and 3 pulses
      let fc; if (v < 7) fc = 1150; else if (v < 13) fc = 15 * fe; else if (v < 21) fc = 9 * fe; else fc = 3 * fe;
      X.ramp(m.car.frequency, fc, 0.015); X.ramp(m.sbA.frequency, fc + 2 * fe, 0.015); X.ramp(m.sbB.frequency, Math.max(20, fc - 2 * fe), 0.015); X.ramp(m.carBP.frequency, fc, 0.03);
      X.ramp(m.carG.gain, 0.022 * (load > 0.03 ? load : 0) * (1 - X.smooth(24, 30, v)) * (regen ? 0.8 : 1) * inside, 0.05);
      X.ramp(m.auxG.gain, S.onboard ? 0.009 : 0.004, 0.3);
      // structure layers
      X.ramp(m.boomG.gain, 0.28 * st.aerial * Math.pow(Math.min(1, v / 30), 1.2) * (S.onboard ? 0.7 : 1), 0.2);
      X.ramp(m.tubeG.gain, 0.12 * st.tube * Math.pow(Math.min(1, v / 30), 1.4), 0.3);
    }
    function build2() {
      c = {}; c.out = X.G(1); c.out.connect(X.trainBus);
      c.hum = X.O('sine', 100); c.humG = X.G(0); X.chain(c.hum, c.humG, c.out);
      c.rope = X.Loop(X.B.pink); c.ropeBP = X.F('bandpass', 420, 4); c.ropeG = X.G(0); X.chain(c.rope, c.ropeBP, c.ropeG, c.out);
      c.sheave = X.O('triangle', 18); c.shG = X.G(0); X.chain(c.sheave, c.shG, c.out);
      c.gains = [c.humG, c.ropeG, c.shG];
    }
    function cable(active, v, p, dt, S) {
      if (!active) { if (c) for (const g of c.gains) X.ramp(g.gain, 0, 0.3); return; }
      if (!c) build2();
      X.ramp(c.humG.gain, 0.012, 0.3); X.ramp(c.ropeBP.frequency, 300 + 25 * v, 0.2); X.ramp(c.ropeG.gain, 0.05 * X.smooth(0.5, 8, v), 0.2);
      X.ramp(c.sheave.frequency, 8 + 3 * v, 0.2); X.ramp(c.shG.gain, 0.02 * X.smooth(1, 10, v), 0.2);
    }
    E.registerKind('metro', metro, { horn: [349.23, 440.0, 523.25] });     // (a three-note chord: our assumption for the new cars)
    E.registerKind('cable', cable, { horn: [659.3, 784.0] });
    // the door chime: three descending tones, E6 C#6 A5 (our own), bright and short
    const sr = X.sr, L = Math.floor(1.4 * sr), a = new Float32Array(L);
    [[1318.5, 0.02], [1108.7, 0.24], [880.0, 0.46]].forEach(([f, t]) => { const at = Math.floor(t * sr); X.partial(a, at, f, 0.8, 0.28, sr); X.partial(a, at, f * 2, 0.12, 0.12, sr); X.partial(a, at, f * 3.01, 0.05, 0.06, sr); });
    chimeBuf = X.mk([X.peakNorm(a, 0.7)]);
  }
  function doorChime() { if (!engine || !chimeBuf || !Sound.ready) return; const X = engine.ext; X.oneShot(chimeBuf, X.uiBus, 0.3); }

  // ---------------------------------------------------------------- where the real system squeals (station pairs)
  const SQUEAL = new Set(['CIVC|16TH', '16TH|24TH', 'EMBR|WOAK', 'WOAK|12TH', 'WOAK|LAKE', '12TH|LAKE', 'GLEN|BALB', 'BALB|DALY', 'DALY|COLM', 'MONT|EMBR', 'POWL|MONT', 'CIVC|POWL', 'ROCK|MCAR', 'SBRN|SFIA', 'SFIA|MLBR']);
  const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const hot = new Set([...SQUEAL].map(k => k.split('|')).map(([a, b]) => pairKey(a, b)));
  const F1 = {}, F2 = {};
  function curveAt(tr) {
    const P = tr.leg.path; P.at(tr.s - 20, F1); P.at(tr.s + 20, F2);
    const cr = Math.abs(F1.tx * F2.tz - F1.tz * F2.tx), R = cr > 1e-4 ? 40 / cr : 1e5;
    const S = tr.leg.stops, k = Math.max(1, Math.min(S.length - 1, tr.nextK || 1)), key = pairKey(S[k - 1].st, S[k].st);
    const base = U.clamp(120 / R, 0, 1);
    return hot.has(key) ? U.clamp(base * 1.6 + (R < 600 ? 0.35 : 0), 0, 1) : base * 0.6;
  }
  // how far into a tunnel (0..1, ramped) and the structure under the listener's train
  let tunnelK = 0, aerialK = 0, tubeK = 0;
  function structAt(tr) { tr.leg.path.at(tr.s - tr.len * 0.5, F1); return F1.struct; }

  // ---------------------------------------------------------------- per frame (from 90_main's sound frame)
  function train(tr, aboard, inCab, dist, dt) {
    if (typeof Sound === 'undefined' || !Sound.ready) return;
    const code = structAt(tr), under = code >= 6, tube = code === 9, aerial = code === 1 || code === 2;
    tunnelK = U.clamp(tunnelK + (under ? dt : -dt) * 1.4, 0, 1); aerialK = U.clamp(aerialK + (aerial ? dt : -dt) * 1.2, 0, 1); tubeK = U.clamp(tubeK + (tube ? dt : -dt) * 0.8, 0, 1);
    st.aerial = aerialK; st.tube = tubeK;
    const kind = tr.kind === 'dmu' ? 'diesel' : tr.kind === 'apm' ? 'cable' : 'metro';
    const P = MetroSim.PERF[tr.kind] || MetroSim.PERF.bart;
    const power = tr.driven && MetroSim.drive ? U.clamp(MetroSim.drive.lever, -1, 1) : U.clamp((tr.a || 0) / (tr.a >= 0 ? P.a0 : P.b), -1, 1);
    // the listener underground on a platform hears the station box too
    const camUnder = typeof Under !== 'undefined' && Under.state && Under.state.cell ? 1 : 0;
    Sound.train({ kind, speed: tr.v, power, onboard: aboard, inCab, tunnel: aboard ? tunnelK : Math.max(camUnder * 0.8, 0), doorsOpen: !!tr.doorsOpen, curve: curveAt(tr), dist });
  }

  // ---------------------------------------------------------------- announcements
  const said = new Set(); let lastSay = -1e9;
  function say(key, text, force) {
    if (said.has(key)) return; said.add(key); if (said.size > 4000) said.clear();
    if (!force && Env.time.sec - lastSay < 9 && Env.time.sec >= lastSay) return;
    lastSay = Env.time.sec; if (typeof Sound !== 'undefined' && Sound.announce) Sound.announce(text);
  }
  const XFER_TEXT = { MLBR: 'Transfer here for the Peninsula line.', MCAR: 'Transfer here between Richmond, Antioch and San Francisco trains.', '12TH': 'Transfer here between Richmond and San Francisco trains.',
    '19TH': 'Transfer here between Richmond and San Francisco trains.', BAYF: 'Transfer here for Dublin, Pleasanton and Berryessa trains.', COLS: 'Transfer here for the Oakland Airport.',
    PITT: 'Transfer here for Antioch.', BALB: 'Transfer here for Muni Metro.', EMBR: 'Transfer here for the ferries and Muni Metro.', SFIA: 'This station serves the airport.', WOAK: 'Transfer here for Oakland and East Bay trains.' };
  const lineWord = (tr) => MetroSim.lineName(tr.line).replace(' Line', '');
  function departure(tr, k) { if (!tr) return; const S = tr.leg.stops, ns = S[k]; if (!ns) return;
    say(tr.key + ':dep:' + k, `This is a ${lineWord(tr)} Line train to ${MetroSim.termName(tr)}. The next station is ${MetroSim.stName(ns.st)}.`, true); }
  function approaching(tr, k) { if (!tr) return; const S = tr.leg.stops, s = S[k]; if (!s) return; const last = k === S.length - 1 && !tr.leg.next;
    const side = MetroSim.stopSide(tr.leg, k) > 0 ? 'right' : 'left';                 // (as the passengers face)
    say(tr.key + ':app:' + k, last ? `Now arriving at ${MetroSim.stName(s.st)}. This is the last stop. Please take all your belongings.`
      : `Now arriving at ${MetroSim.stName(s.st)}.${side ? ' Doors will open on the ' + side + '.' : ''} ${XFER_TEXT[s.st] || ''}`.trim(), true); }
  function arrival(tr, k) { /* (the approach announcement covers it) */ }
  const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  // riding: announcements driven by the train's own timeline; on foot at a station: platform announcements
  const rideState = { key: '', k: -1, phase: '' };
  function update(dt) {
    if (!on() || typeof Player === 'undefined') return;
    const tr = Player.focusTrain(), aboard = tr && tr.metro && (Player.onboard() || Player.inCab());
    if (aboard && !tr.driven) {
      if (tr.phase === 'run' && (rideState.key !== tr.key || rideState.phase !== 'run' || rideState.k !== tr.nextK)) { if (rideState.phase !== 'run' && rideState.key === tr.key) departure(tr, tr.nextK); rideState.k = tr.nextK; }
      if (tr.phase === 'run') { const s = tr.leg.stops[tr.nextK]; if (s && s.ps - tr.s < 380 && tr.v > 2) approaching(tr, tr.nextK); }
      if ((tr.phase === 'dwell' || tr.phase === 'origin') && tr.dwellLeft < 6 && tr.dwellLeft > 3.5) { const key = tr.key + ':chime:' + tr.stopK + ':' + Math.floor(Env.time.sec / 600); if (!said.has(key)) { said.add(key); doorChime(); } }
      rideState.key = tr.key; rideState.phase = tr.phase;
    }
    else if (Player.mode === 'walk') platform();
  }
  function platform() {
    const p = Env.camera.position, ms = MetroSim.nearestStation(p, 170); if (!ms) return;
    const now = Env.time.sec;
    for (const ev of MetroSim.arrivals(ms.id, now, 8)) {
      const inf = MetroSim.eventInfo(ev), eta = ev.leg.stops[ev.k].tArr - now, plat = inf.platform || '';
      const who = `${NUM[inf.cars] || inf.cars} car ${inf.dest} train`;
      const cw = NUM[inf.cars] || String(inf.cars), art = /^(eight|eleven|8|11)/.test(cw) ? 'an' : 'a';
      if (eta > 100 && eta < 130) say(ev.plan.key + ':2m:' + ms.id, `The next ${inf.dest} train, ${art} ${cw} car ${MetroSim.lineName(inf.line)} train, arrives in two minutes${plat ? ' on platform ' + plat : ''}.`);
      if (eta > 14 && eta < 32) say(ev.plan.key + ':now:' + ms.id, `${who[0].toUpperCase() + who.slice(1)} now approaching${plat ? ' platform ' + plat : ''}.`);
    }
  }
  return { init, train, update, doorChime, departure, approaching, arrival, curveAt, get state() { return st; } };
})();
