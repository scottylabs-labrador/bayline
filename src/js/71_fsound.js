// FSound: the aircraft, synthesised on Sound's audio context. Turbofans (broadband roar, fan whine at the blade-pass
// frequency, buzz-saw at high power, low rumble, afterburner), the piston single (firing pulses and prop buzz),
// wind over the airframe, wheels rolling, touchdown thump and tyre chirp, gear and flap motors, and the cockpit's
// voices: radio-altitude callouts, stall, overspeed clacker, "sink rate", "pull up", "bank angle", autopilot
// disconnect. Heard muffled from the cockpit, open from outside, with distance and Doppler for the tower and flyby
// cameras.
const FSound = (() => {
  let ctx = null, out = null, v = null, lastWarn = {}, gearWas = null, flapWas = null, apOffAt = 0;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  function noise(sec, color) {
    const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0); let l = 0, p = [0, 0, 0];
    for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1;
      if (color === 'brown') { l = (l + 0.02 * w) / 1.02; d[i] = l * 3.5; }
      else if (color === 'pink') { p[0] = 0.997 * p[0] + w * 0.029591; p[1] = 0.985 * p[1] + w * 0.032534; p[2] = 0.95 * p[2] + w * 0.048056; d[i] = (p[0] + p[1] + p[2] + w * 0.05) * 2.2; }
      else d[i] = w; }
    return b;
  }
  function ensure() {
    if (v) return true;
    if (typeof Sound === 'undefined' || !Sound._engine) return false;
    const E = Sound._engine; ctx = E.ctx; out = ctx.createGain(); out.gain.value = 1; out.connect(E.master);
    const G = (x = 0) => { const g = ctx.createGain(); g.gain.value = x; return g; };
    const F = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const src = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, Math.random() * buf.duration); return s; };
    const osc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; };
    const W = noise(2.5, 'white'), P = noise(3, 'pink'), B = noise(3, 'brown');
    // perspective: everything through a cabin low-pass (opened fully outside)
    const cabin = F('lowpass', 18000, 0.5), master = G(0); cabin.connect(master); master.connect(out);
    const n = {};
    n.roar = src(P); n.roarF = F('bandpass', 600, 0.6); n.roarG = G(0); n.roar.connect(n.roarF); n.roarF.connect(n.roarG); n.roarG.connect(cabin);
    n.whine = osc('triangle', 800); n.whine2 = osc('sine', 1600); n.whineF = F('bandpass', 1000, 3); n.whineG = G(0); n.whine.connect(n.whineF); n.whine2.connect(n.whineF); n.whineF.connect(n.whineG); n.whineG.connect(cabin);
    n.saw = osc('sawtooth', 90); n.sawF = F('lowpass', 1400, 0.8); n.sawG = G(0); n.saw.connect(n.sawF); n.sawF.connect(n.sawG); n.sawG.connect(cabin);
    n.rumble = src(B); n.rumbleF = F('lowpass', 160, 0.7); n.rumbleG = G(0); n.rumble.connect(n.rumbleF); n.rumbleF.connect(n.rumbleG); n.rumbleG.connect(cabin);
    n.ab = src(W); n.abF = F('bandpass', 220, 0.5); n.abG = G(0); n.ab.connect(n.abF); n.abF.connect(n.abG); n.abG.connect(cabin);
    // piston: a pulse train at the firing rate through a resonant low-pass, plus prop buzz
    n.pist = osc('sawtooth', 30); n.pistF = F('lowpass', 500, 2.5); n.pistG = G(0); n.pist.connect(n.pistF); n.pistF.connect(n.pistG); n.pistG.connect(cabin);
    n.prop = osc('square', 90); n.propF = F('bandpass', 180, 1.2); n.propG = G(0); n.prop.connect(n.propF); n.propF.connect(n.propG); n.propG.connect(cabin);
    // airflow and wheels
    n.wind = src(P); n.windF = F('bandpass', 700, 0.5); n.windG = G(0); n.wind.connect(n.windF); n.windF.connect(n.windG); n.windG.connect(master);
    n.roll = src(B); n.rollF = F('lowpass', 220, 1); n.rollG = G(0); n.roll.connect(n.rollF); n.rollF.connect(n.rollG); n.rollG.connect(master);
    n.motor = src(W); n.motorF = F('bandpass', 420, 4); n.motorG = G(0); n.motor.connect(n.motorF); n.motorF.connect(n.motorG); n.motorG.connect(cabin);
    // warning tones
    n.horn = osc('sawtooth', 1560); n.hornF = F('bandpass', 1600, 6); n.hornG = G(0); n.horn.connect(n.hornF); n.hornF.connect(n.hornG); n.hornG.connect(out);
    n.clack = osc('square', 11); n.clackF = F('highpass', 900, 0.7); n.clackG = G(0); n.clack.connect(n.clackF); n.clackF.connect(n.clackG); n.clackG.connect(out);
    v = { n, cabin, master, W, B, P };
    return true;
  }
  const ramp = (p, x, t = 0.08) => { if (Number.isFinite(x)) p.setTargetAtTime(x, ctx.currentTime, t); };
  const pc = new THREE.Vector3();
  function update(F, dt) {
    if (!ensure() || !F.ac || typeof Sound === 'undefined' || Sound.muted) { if (v) ramp(v.master.gain, 0, 0.1); return; }
    const ac = F.ac, o = ac.out, T = F.type, n = v.n, cam = Env.camera;
    const inside = F.cam.mode === 'cockpit';
    // distance and Doppler from the camera
    pc.copy(ac.pos).sub(cam.position); const d = pc.length(), vr = d > 1 ? ac.vel.dot(pc) / d : 0;   // + receding
    const dop = inside ? 1 : clamp(343 / (343 + vr), 0.6, 1.6);
    const distG = inside ? 1 : clamp(40 / Math.max(40, d), 0, 1) ** 1.1;
    ramp(v.master.gain, (inside ? 0.8 : 1) * distG, 0.1);
    ramp(v.cabin.frequency, inside ? (T.model.kind === 'ga' ? 1400 : 900) : clamp(18000 - d * 3, 1200, 18000), 0.2);
    const E = ac.eng, nAvg = E.reduce((s, e) => s + clamp((e.n - 0.2) / 0.8, 0, 1.05), 0) / E.length, on = E.some(e => e.n > 0.1), kind = T.fdm.engines[0].type;
    const count = Math.sqrt(E.length);
    if (kind === 'fan') {
      const fan = 0.22 + 0.78 * nAvg, rear = inside ? 1 : 0.6 + 0.4 * clamp(-pc.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(ac.q)) / Math.max(d, 1), -1, 1);
      ramp(n.roarF.frequency, (350 + 900 * fan) * dop); ramp(n.roarG.gain, 0.08 * count * fan * fan * (0.7 + 0.5 * rear));
      const bpf = (T.fdm.engines[0].fast ? 2600 : 1850) * fan;
      ramp(n.whine.frequency, bpf * dop, 0.05); ramp(n.whine2.frequency, bpf * 2 * dop, 0.05); ramp(n.whineF.frequency, bpf * 1.3 * dop); ramp(n.whineG.gain, 0.02 * count * fan * (inside ? 0.5 : 1.2 - 0.5 * rear));
      ramp(n.saw.frequency, (40 + 60 * fan) * dop); ramp(n.sawG.gain, 0.03 * count * clamp((nAvg - 0.75) * 4, 0, 1));
      ramp(n.rumbleG.gain, 0.12 * count * nAvg * nAvg); ramp(n.pistG.gain, 0); ramp(n.propG.gain, 0);
      const ab = ac.ctl.thr > 1.001 ? clamp((nAvg - 0.9) * 10, 0, 1) : 0; ramp(n.abG.gain, 0.35 * ab); ramp(n.abF.frequency, 180 + 90 * Math.random());
    } else {
      const rpm = 600 + 2100 * nAvg, fire = rpm / 30;
      ramp(n.pist.frequency, fire * dop, 0.04); ramp(n.pistF.frequency, 300 + rpm * 0.35); ramp(n.pistG.gain, on ? 0.09 + 0.1 * nAvg : 0);
      ramp(n.prop.frequency, fire * dop, 0.04); ramp(n.propF.frequency, fire * 2 * dop); ramp(n.propG.gain, on ? 0.02 + 0.06 * nAvg : 0);
      ramp(n.roarG.gain, 0.02 * nAvg); ramp(n.whineG.gain, 0); ramp(n.sawG.gain, 0); ramp(n.rumbleG.gain, 0.05 * nAvg); ramp(n.abG.gain, 0);
    }
    const tas = o.tas; ramp(n.windF.frequency, 300 + tas * 9); ramp(n.windG.gain, clamp((tas / 140) ** 2, 0, 1.2) * (inside ? 0.09 : 0.05) * (1 + (ac.gearPos > 0.5 ? 0.4 : 0) + ac.spoilerPos * 0.6));
    ramp(n.rollG.gain, o.onGround ? clamp(o.gs / 40, 0, 1) * (inside ? 0.22 : 0.12) : 0); ramp(n.rollF.frequency, 90 + o.gs * 4);
    // gear / flap motors and clunks
    const moving = (T.fdm.retract && ac.gearPos > 0.01 && ac.gearPos < 0.99) || Math.abs(ac.flapPos - ac.ctl.flaps) > 0.01;
    ramp(n.motorG.gain, moving ? (inside ? 0.05 : 0.02) : 0, 0.15);
    const gDown = ac.gearPos > 0.99, gUp = ac.gearPos < 0.01;
    if (gearWas !== null && ((gDown && gearWas !== 'down') || (gUp && gearWas !== 'up'))) thump(0.5, 70);
    gearWas = gDown ? 'down' : gUp ? 'up' : 'moving';
    // warnings
    const W = F.warn.list; const stall = W.includes('STALL'), over = W.includes('OVERSPEED');
    ramp(n.hornG.gain, stall && T.model.kind === 'ga' ? 0.05 : 0, 0.05);
    ramp(n.clackG.gain, over ? 0.06 : 0, 0.05);
    ramp(v.master.gain, v.master.gain.value, 0.1);
  }
  function warnings(list) {
    const now = performance.now() / 1000;
    const speakEvery = (key, text, every) => { if (!lastWarn[key] || now - lastWarn[key] > every) { lastWarn[key] = now; say(text); } };
    if (list.includes('PULL UP')) speakEvery('pull', 'pull up', 1.6);
    else if (list.includes('SINK RATE')) speakEvery('sink', 'sink rate', 2.5);
    if (list.includes('TOO LOW · GEAR')) speakEvery('gear', 'too low, gear', 3);
    if (list.includes('BANK ANGLE')) speakEvery('bank', 'bank angle', 3);
    if (list.includes('STALL') && Flight.type && Flight.type.model.kind !== 'ga') speakEvery('stall', 'stall', 1.5);
  }
  let voice = null;
  function say(text) {
    if (typeof Sound !== 'undefined' && Sound.muted) return;
    if (!('speechSynthesis' in window)) return;
    try {
      if (!voice) { const vs = speechSynthesis.getVoices(); voice = vs.find(x => /en[-_]US/i.test(x.lang) && /male|david|alex|fred|daniel/i.test(x.name)) || vs.find(x => /^en/i.test(x.lang)) || null; }
      if (speechSynthesis.speaking && /^\d/.test(text)) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text); if (voice) u.voice = voice; u.rate = 1.15; u.pitch = 0.8; u.volume = 0.9; speechSynthesis.speak(u);
    } catch (e) {}
  }
  function thump(gain, f) {
    if (!ensure()) return; const t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = v.B; const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = f * 2; const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    s.connect(lp); lp.connect(g); g.connect(out); s.start(t, Math.random()); s.stop(t + 0.6);
  }
  function touch(fpm) {
    if (!ensure()) return; thump(clamp(fpm / 500, 0.15, 1.2), 90);
    const t = ctx.currentTime; const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sawtooth'; o.frequency.setValueAtTime(1500, t); o.frequency.exponentialRampToValueAtTime(700, t + 0.25);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 3;
    g.gain.setValueAtTime(0.0, t); g.gain.linearRampToValueAtTime(0.05, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3); o.connect(bp); bp.connect(g); g.connect(out); o.start(t); o.stop(t + 0.35);
  }
  function crash() { if (!ensure()) return; thump(1.5, 60); setTimeout(() => thump(1.0, 120), 120); if (v) ramp(v.master.gain, 0, 0.6); }
  function apOff() {       // the "cavalry charge"
    if (!ensure()) return; const now2 = performance.now(); if (now2 - apOffAt < 1500) return; apOffAt = now2;
    const t = ctx.currentTime; [[1175, 0], [1397, 0.12], [1568, 0.24], [1175, 0.5], [1397, 0.62], [1568, 0.74]].forEach(([f, dt2]) => {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'triangle'; o.frequency.value = f; g.gain.setValueAtTime(0, t + dt2); g.gain.linearRampToValueAtTime(0.06, t + dt2 + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dt2 + 0.11);
      o.connect(g); g.connect(out); o.start(t + dt2); o.stop(t + dt2 + 0.14); });
  }
  function stop() { if (v) ramp(v.master.gain, 0, 0.2); if (v) { ramp(v.n.hornG.gain, 0); ramp(v.n.clackG.gain, 0); } gearWas = null; }
  return { update, warnings, say, touch, crash, apOff, stop };
})();
