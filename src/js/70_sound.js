// Bayline sound. Every sound is synthesized at runtime with the Web Audio API (no audio files);
// station announcements use the browser's speechSynthesis. API and mix levels: notes/sound.md.
//
// Graph (long-lived nodes are created once, lazily, the first time a feature is used; only
// event sounds such as rail-joint clacks, chimes and horn blasts create short-lived nodes):
//
//   player's train ─ trainBus ─ trainLP (interior muffling / air absorption) ─ trainOut ─ duck ─┐
//   horn + bell ──── hornBus ── hornLP ─ hornOut ───────────────────────────────────────────────┤
//   world ────────── worldBus ─ worldLP ─ worldOut   (crossings, pass-bys, ambience) ─── duck ─┼─ preMix ─ limiter ─ master ─ out
//   chimes ───────── uiBus ─────────────────────────────────────────────────────────────────────┤
//   trainOut / hornOut / worldOut ── tunnel sends ── convolver (generated tunnel IR) ── duck ───┘
//   (duck dips train, world and reverb by ~5 dB while an announcement is being spoken)
const Sound = (() => {
  const SPEED_OF_SOUND = 343;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  function prng(seed) {
    let a = (seed >>> 0) || 1;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // ------------------------------------------------------------------ offline DSP for sample buffers
  // RBJ biquad applied in place to a Float32Array.
  function biq(x, type, f, q, sr, gainDb = 0) {
    const w0 = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, cw = Math.cos(w0), sw = Math.sin(w0), al = sw / (2 * q), A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'bandpass') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const x0 = x[i], y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x0; y2 = y1; y1 = y0; x[i] = y0; }
    return x;
  }
  const white = (n, r) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = r() * 2 - 1; return a; };
  function pink(n, r) { // Paul Kellet's refined pink filter
    const a = new Float32Array(n); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1; b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      a[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
    return a;
  }
  function brown(n, r, sr) { const a = new Float32Array(n); let l = 0; for (let i = 0; i < n; i++) { l = (l + 0.02 * (r() * 2 - 1)) / 1.02; a[i] = l * 3.5; } return biq(a, 'highpass', 16, 0.7, sr); }
  // Equal-power crossfade of the tail into the head so the buffer loops without a seam.
  function loopable(a, fade) {
    const n = a.length - fade, o = new Float32Array(n); o.set(a.subarray(0, n));
    for (let i = 0; i < fade; i++) { const t = (i + 0.5) / fade; o[i] = a[i] * Math.sin(t * Math.PI / 2) + a[n + i] * Math.cos(t * Math.PI / 2); }
    return o;
  }
  function peakNorm(a, peak) { let m = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; } if (m > 0) { const k = peak / m; for (let i = 0; i < a.length; i++) a[i] *= k; } return a; }
  // Add an exponentially decaying sine partial starting at sample `at` (recursive oscillator, no Math.sin per sample).
  // With wrap = true the tail folds around the buffer end, which makes rhythmic loops seamless (steady state of a periodic strike).
  function partial(a, at, f, amp, decaySec, sr, phase = 0, wrap = false) {
    const w = 2 * Math.PI * f / sr, k = 2 * Math.cos(w), d = Math.exp(-1 / (decaySec * sr)), L = a.length;
    const n = Math.floor(decaySec * 7 * sr);
    if (wrap && n > L) {
      // The tail wraps more than once: add the whole geometric series of wraps in one pass,
      // x[i] = Im(amp e^{i phase} (d e^{iw})^i / (1 - d^L e^{iwL})), exact and far cheaper than looping the tail.
      const dL = Math.pow(d, L), qr = 1 - dL * Math.cos(w * L), qi = dL * Math.sin(w * L), den = qr * qr + qi * qi;
      const cr = qr / den, ci = qi / den, rr = d * Math.cos(w), ri = d * Math.sin(w);
      let zr = amp * Math.cos(phase), zi = amp * Math.sin(phase), tr = zr * cr - zi * ci; zi = zr * ci + zi * cr; zr = tr;
      for (let i = 0, j = at % L; i < L; i++) { a[j] += zi; if (++j === L) j = 0; tr = zr * rr - zi * ri; zi = zr * ri + zi * rr; zr = tr; }
      return;
    }
    let s1 = Math.sin(phase - w), s2 = Math.sin(phase - 2 * w), g = amp;
    for (let i = 0; i < n; i++) {
      const s0 = k * s1 - s2; s2 = s1; s1 = s0; let j = at + i;
      if (j >= L) { if (!wrap) break; j %= L; }
      a[j] += g * s0; g *= d;
    }
  }
  function click(a, at, amp, len, r, wrap = false) { const L = a.length; for (let i = 0; i < len; i++) { let j = at + i; if (j >= L) { if (!wrap) break; j %= L; } a[j] += (r() * 2 - 1) * amp * (1 - i / len); } }

  // ------------------------------------------------------------------ engine (one per AudioContext)
  function createEngine(ctx, opts = {}) {
    const sr = ctx.sampleRate, r = prng(opts.seed || 20260923), live = opts.live !== false && !(ctx instanceof (window.OfflineAudioContext || Function));
    const speechOn = opts.speech !== false;
    const now = () => ctx.currentTime;
    const mk = (chs, rate = sr) => { const b = ctx.createBuffer(chs.length, chs[0].length, rate); chs.forEach((c, i) => b.copyToChannel(c, i)); return b; };

    // Always-needed noise beds (loopable) and the rail-joint impact.
    const B = {};
    { const f1 = Math.floor(sr * 0.05), f2 = Math.floor(sr * 0.1), f3 = Math.floor(sr * 0.2);
      B.white = mk([loopable(white(sr * 3 + f1, r), f1), loopable(white(sr * 3 + f1, r), f1)]);
      B.pink = mk([loopable(pink(sr * 4 + f2, r), f2), loopable(pink(sr * 4 + f2, r), f2)]);
      B.brown = mk([loopable(brown(sr * 5 + f3, r, sr), f3)]); }
    { // steel wheel over a rail joint: short broadband crack + ringing steel + low thump
      const n = Math.floor(0.3 * sr), a = new Float32Array(n);
      for (let i = 0; i < 0.012 * sr; i++) a[i] += (r() * 2 - 1) * Math.exp(-i / (0.0022 * sr));
      biq(a, 'bandpass', 2100, 0.7, sr);
      partial(a, 0, 1150, 0.3, 0.045, sr); partial(a, 0, 2480, 0.14, 0.03, sr); partial(a, 0, 3900, 0.06, 0.018, sr);
      partial(a, 0, 92, 0.55, 0.05, sr); partial(a, 0, 175, 0.22, 0.035, sr);
      B.clack = mk([peakNorm(a, 0.9)]); }

    // Lazily generated buffers.
    const GEN = {
      tunnelIR() { // concrete bore: dense early reflections, boomy 2 s tail
        const n = Math.floor(sr * 2.0), chs = [];
        for (let c = 0; c < 2; c++) {
          const a = new Float32Array(n), rr = prng(900 + c);
          [0.006, 0.011, 0.017, 0.024, 0.031, 0.043, 0.058, 0.074].forEach((t, k) => { a[Math.floor((t + c * 0.0013) * sr)] += (0.7 - k * 0.07) * (rr() < 0.5 ? -1 : 1); });
          for (let i = 0; i < n; i++) { const t = i / sr; a[i] += (rr() * 2 - 1) * 0.45 * Math.exp(-t / 0.42) * smooth(0, 0.02, t); }
          biq(a, 'lowpass', 2300, 0.5, sr); biq(a, 'highpass', 80, 0.7, sr); chs.push(a);
        }
        return mk(chs);
      },
      bellLoop() { // bronze locomotive bell on an air ringer, ~58 strikes/min; loop = two strikes
        const P = 1.04, L = Math.floor(2 * P * sr), a = new Float32Array(L), nominal = 870;
        const parts = [[0.25, 0.3, 3.0], [0.5, 0.42, 2.3], [0.6, 0.5, 1.8], [0.75, 0.2, 1.3], [1, 1, 1.7], [1.5, 0.26, 0.85], [2, 0.18, 0.55], [2.67, 0.08, 0.35]];
        for (let k = 0; k < 2; k++) {
          const at = Math.floor(k * P * sr), amp = k ? 0.88 : 1;
          for (const [ratio, amp2, dec] of parts) partial(a, at, nominal * ratio * (1 + (r() - 0.5) * 0.001), amp * amp2, dec, sr, r() * 6.283, true);
          click(a, at, 0.35, Math.floor(0.003 * sr), r, true);
        }
        return mk([peakNorm(biq(a, 'highpass', 140, 0.7, sr), 0.8)]);
      },
      crossLoop() { // electronic grade-crossing bell, ~2 strikes/s; loop = four strikes
        const P = 0.5, N = 4, L = Math.floor(P * N * sr), a = new Float32Array(L);
        for (let k = 0; k < N; k++) {
          const at = Math.floor(k * P * sr), amp = 0.9 + 0.1 * r();
          partial(a, at, 1210, amp, 0.3, sr, 0, true); partial(a, at, 2790, amp * 0.42, 0.18, sr, 0, true);
          partial(a, at, 4420, amp * 0.16, 0.1, sr, 0, true); partial(a, at, 645, amp * 0.22, 0.22, sr, 0, true);
          click(a, at, 0.5, Math.floor(0.002 * sr), r, true);
        }
        return mk([peakNorm(a, 0.8)]);
      },
      crickets() { // field crickets: 3-4 pulse chirps near 4.2-5.3 kHz, several insects, 4 s seamless stereo loop
        const Ls = 4, L = Math.floor(Ls * sr), ch = [new Float32Array(L), new Float32Array(L)];
        for (let c = 0; c < 7; c++) {
          const f = 4200 + r() * 1100, pan = 0.1 + r() * 0.8, nCh = Math.round(Ls / (0.42 + r() * 0.35)), P = Ls / nCh;
          const pulses = 3 + (r() < 0.4 ? 1 : 0), amp = 0.25 + r() * 0.6, off = r() * P, len = Math.floor(0.017 * sr);
          for (let k = 0; k < nCh; k++) for (let p = 0; p < pulses; p++) {
            const s0 = Math.floor((off + k * P + p * 0.031) * sr);
            for (let i = 0; i < len; i++) { const v = amp * Math.sin(Math.PI * i / len) * Math.sin(2 * Math.PI * f * i / sr); const j = (s0 + i) % L; ch[0][j] += v * (1 - pan); ch[1][j] += v * pan; }
          }
        }
        const m = Math.max(...ch.map(a => a.reduce((x, v) => Math.max(x, Math.abs(v)), 0))) || 1; ch.forEach(a => { for (let i = 0; i < L; i++) a[i] *= 0.5 / m; });
        return mk(ch);
      },
      babble() { // distant station crowd: many formant-filtered voices with syllable rhythm, 6 s stereo loop
        const sr = Math.round(ctx.sampleRate / 2);   // band-limited to 3 kHz, so half rate is plenty and halves the cost
        const Ls = 6, L = Math.floor(Ls * sr), out = [new Float32Array(L), new Float32Array(L)];
        const vowels = [[730, 1090], [270, 2290], [530, 1840], [660, 1720], [300, 870], [570, 840], [440, 1020], [490, 1350], [400, 1900]];
        for (let v = 0; v < 12; v++) {
          const f0base = (r() < 0.5 ? 108 : 195) * (0.85 + r() * 0.3), pan = 0.15 + r() * 0.7, vAmp = 0.35 + r() * 0.65;
          let pos = Math.floor(r() * sr * 0.6);
          while (pos < L) {
            if (r() < 0.22) { pos += Math.floor((0.25 + r() * 0.6) * sr); continue; }
            const dur = 0.11 + r() * 0.18, n = Math.floor(dur * sr), seg = new Float32Array(n), [F1, F2] = vowels[Math.floor(r() * vowels.length)];
            const f0a = f0base * (0.92 + r() * 0.16), f0b = f0a * (0.9 + r() * 0.2); let ph = 0;
            for (let i = 0; i < n; i++) { const t = i / n, f0 = f0a + (f0b - f0a) * t; ph += f0 / sr; ph -= Math.floor(ph);
              seg[i] = (2 * ph - 1) * smooth(0, 0.18, t) * (1 - smooth(0.7, 1, t)) + (r() * 2 - 1) * 0.05; }
            const a1 = biq(Float32Array.from(seg), 'bandpass', F1, 4, sr), a2 = biq(seg, 'bandpass', F2, 6, sr);
            for (let i = 0; i < n; i++) { const s = (a1[i] + 0.55 * a2[i]) * vAmp, j = (pos + i) % L; out[0][j] += s * (1 - pan); out[1][j] += s * pan; }
            pos += n + Math.floor(r() * 0.05 * sr);
          }
        }
        out.forEach(a => { biq(a, 'lowpass', 3000, 0.7, sr); biq(a, 'highpass', 120, 0.7, sr); });
        for (const a of out) { const d1 = Math.floor(0.023 * sr), d2 = Math.floor(0.041 * sr), c = Float32Array.from(a); for (let i = 0; i < L; i++) a[i] = c[i] + 0.35 * c[(i - d1 + L) % L] + 0.2 * c[(i - d2 + L) % L]; }
        const m = Math.max(...out.map(a => a.reduce((x, v) => Math.max(x, Math.abs(v)), 0))) || 1; out.forEach(a => { for (let i = 0; i < L; i++) a[i] *= 0.6 / m; });
        return mk(out, sr);
      },
      rain() { // steady hiss + individual drops, 3 s stereo loop
        const Ls = 3, L = Math.floor(Ls * sr), ch = [];
        for (let c = 0; c < 2; c++) {
          const a = biq(loopable(pink(L + 2400, r), 2400), 'highpass', 900, 0.7, sr); for (let i = 0; i < L; i++) a[i] *= 0.55;
          for (let k = 0; k < 520; k++) { const at = Math.floor(r() * L); partial(a, at, 1800 + r() * 4800, 0.15 + r() * 0.5, 0.004 + r() * 0.01, sr, 0, true); click(a, at, 0.25 * r(), 40, r, true); }
          ch.push(a);
        }
        const m = Math.max(...ch.map(a => a.reduce((x, v) => Math.max(x, Math.abs(v)), 0))) || 1; ch.forEach(a => { for (let i = 0; i < L; i++) a[i] *= 0.5 / m; });
        return mk(ch);
      },
      gull() { // western gull "kyow" series: gliding harsh tone through beak/syrinx formants; three variants
        const vars = [];
        for (let k = 0; k < 3; k++) {
          const calls = 2 + Math.floor(r() * 3), L = Math.floor((0.25 + calls * 0.36) * sr), a = new Float32Array(L);
          let t0 = 0.02;
          for (let c = 0; c < calls; c++) {
            const d = 0.2 + r() * 0.12, n = Math.floor(d * sr), s0 = Math.floor(t0 * sr), fA = 1250 + r() * 300, fB = 760 + r() * 160; let ph = 0;
            for (let i = 0; i < n && s0 + i < L; i++) { const t = i / n, f = fA + (fB - fA) * Math.pow(t, 0.7) + 60 * Math.sin(t * 40); ph += f / sr; ph -= Math.floor(ph);
              a[s0 + i] += ((2 * ph - 1) * 0.7 + (r() * 2 - 1) * 0.12) * smooth(0, 0.12, t) * (1 - smooth(0.65, 1, t)); }
            t0 += d + 0.1 + r() * 0.08;
          }
          const b = Float32Array.from(a); biq(a, 'bandpass', 2100, 2.2, sr); biq(b, 'bandpass', 3300, 3, sr);
          for (let i = 0; i < L; i++) a[i] += 0.5 * b[i];
          vars.push(mk([peakNorm(a, 0.7)]));
        }
        return vars;
      },
      doorChime() { // door-closing warning: alternating two-tone, three times
        const L = Math.floor(1.9 * sr), a = new Float32Array(L);
        for (let k = 0; k < 6; k++) { const f = k % 2 ? 830.6 : 987.8, at = Math.floor((0.02 + k * 0.26) * sr);
          partial(a, at, f, 0.8, 0.2, sr); partial(a, at, f * 2, 0.1, 0.09, sr); partial(a, at, f * 3.01, 0.04, 0.05, sr); }
        return mk([peakNorm(a, 0.7)]);
      },
      annChime() { // announcement "ding-dong": soft vibraphone-like major third, E5 -> C5
        const L = Math.floor(2.6 * sr), a = new Float32Array(L);
        [[659.26, 0.02], [523.25, 0.6]].forEach(([f, t]) => { const at = Math.floor(t * sr);
          partial(a, at, f, 0.8, 1.05, sr); partial(a, at, f * 2, 0.08, 0.45, sr); partial(a, at, f * 4, 0.1, 0.22, sr); partial(a, at, f * 0.5, 0.05, 0.9, sr); });
        return mk([peakNorm(a, 0.7), peakNorm(Float32Array.from(a), 0.7)]);
      },
      hissOpen() { return mk([doorHiss(true)]); },
      hissClose() { return mk([doorHiss(false)]); },
    };
    function doorHiss(open) { // pneumatic plug door: exhaust hiss, sliding rumble, lock clunk / seal thump
      const Ls = open ? 1.25 : 1.35, L = Math.floor(Ls * sr), a = new Float32Array(L), h = biq(white(L, r), 'bandpass', open ? 2900 : 3300, 0.9, sr), rum = biq(brown(L, r, sr), 'lowpass', 220, 0.7, sr);
      for (let i = 0; i < L; i++) { const t = i / sr;
        a[i] += h[i] * 0.7 * smooth(0, 0.02, t) * (t < (open ? 0.22 : 0.35) ? 1 : Math.exp(-(t - (open ? 0.22 : 0.35)) / 0.18));
        a[i] += rum[i] * 2.2 * smooth(0.05, 0.15, t) * (1 - smooth(open ? 0.75 : 0.85, open ? 1.0 : 1.05, t)); }
      const thunk = (t, amp) => { const at = Math.floor(t * sr); partial(a, at, 105, amp * 0.8, 0.05, sr); partial(a, at, 235, amp * 0.3, 0.03, sr); click(a, at, amp * 0.3, 90, r); };
      thunk(0.01, 0.45); thunk(open ? 0.98 : 1.06, open ? 0.6 : 1.0);
      return peakNorm(a, 0.7);
    }
    const bufs = {}; const buf = name => bufs[name] || (bufs[name] = GEN[name]());
    // Pre-generate the lazy buffers one at a time (called from idle callbacks after init) so first use never hitches a frame.
    const WARM = ['doorChime', 'annChime', 'hissOpen', 'hissClose', 'crossLoop', 'bellLoop', 'tunnelIR', 'crickets', 'rain', 'gull', 'babble'];
    function warmStep() { const n = WARM.find(k => !bufs[k]); if (n) buf(n); return WARM.some(k => !bufs[k]); }

    // Parameter smoothing with change detection (no zipper noise, few automation events).
    const lastSet = new WeakMap();
    function ramp(p, v, tc = 0.06) {
      if (!Number.isFinite(v)) return; const l = lastSet.get(p);
      if (l !== undefined && Math.abs(l - v) <= 1e-4 * (Math.abs(v) + 1e-3)) return;
      lastSet.set(p, v); p.setTargetAtTime(v, now(), tc);
    }
    const G = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const F = (type, f, q = 0.707, db = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; if (db) b.gain.value = db; return b; };
    const O = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; };
    const Loop = (b, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = b; s.loop = true; s.playbackRate.value = rate; s.start(0, r() * b.duration * 0.9); return s; };
    const chain = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; };
    function oneShot(b, dest, gain = 1, rate = 1, when = 0, pan = null) {
      const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rate;
      const g = G(gain); s.connect(g); let last = g;
      if (pan !== null && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); last = p; }
      last.connect(dest); s.start(Math.max(now(), when));
      s.onended = () => { try { s.disconnect(); g.disconnect(); if (last !== g) last.disconnect(); } catch (e) { /* already gone */ } };
      return s;
    }

    // ---- master section
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.knee.value = 4; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.15;
    const master = G(0.8), preMix = G(1), duck = G(1);
    chain(preMix, limiter, master, ctx.destination); duck.connect(preMix);
    const trainBus = G(1), trainLP = F('lowpass', 16000, 0.5), trainOut = G(1); chain(trainBus, trainLP, trainOut, duck);
    const hornBus = G(1), hornLP = F('lowpass', 12000, 0.5), hornOut = G(1); chain(hornBus, hornLP, hornOut, preMix);
    const worldBus = G(1), worldLP = F('lowpass', 18000, 0.5), worldOut = G(1); chain(worldBus, worldLP, worldOut, duck);
    const uiBus = G(1); uiBus.connect(preMix);
    let sends = null;
    function ensureSends() {
      if (sends) return sends;
      const conv = ctx.createConvolver(); conv.normalize = true; conv.buffer = buf('tunnelIR');
      const rIn = G(1), rOut = G(0.75); chain(rIn, conv, rOut, duck);
      sends = { train: G(0), horn: G(0), world: G(0) };
      trainOut.connect(sends.train); hornOut.connect(sends.horn); worldOut.connect(sends.world);
      sends.train.connect(rIn); sends.horn.connect(rIn); sends.world.connect(rIn);
      return sends;
    }

    // ---- listener / train state
    const S = { kind: 'emu', speed: 0, power: 0, onboard: false, inCab: false, tunnel: 0, doorsOpen: false, curve: 0, dist: 0, lastCall: -1, stale: true };

    // ---- EMU traction (lazy)
    let emu = null;
    function getEmu() {
      if (emu) return emu;
      const e = {}; e.out = G(1); e.out.connect(trainBus);
      e.gear = O('sine', 60); e.gearG = G(0); chain(e.gear, e.gearG, e.out);                    // gear mesh
      e.slot = O('triangle', 90); e.slotF = F('lowpass', 3800, 0.7); e.slotG = G(0); chain(e.slot, e.slotF, e.slotG, e.out); // rotor slot harmonic
      e.hum = O('sine', 30); e.humG = G(0); chain(e.hum, e.humG, e.out);                        // 2x electrical fundamental
      e.inv = O('sine', 1000); e.invSide = O('sine', 1100); e.invBP = F('bandpass', 1000, 1.6); e.invG = G(0);  // inverter carrier "song"
      const sg = G(0.35); e.inv.connect(e.invBP); e.invSide.connect(sg); sg.connect(e.invBP); chain(e.invBP, e.invG, e.out);
      e.mains = O('sine', 120); e.mains2 = O('sine', 240); e.mainsG = G(0); const m2 = G(0.4); e.mains.connect(e.mainsG); e.mains2.connect(m2); m2.connect(e.mainsG); e.mainsG.connect(e.out);
      e.comp = Loop(B.brown); e.compF = F('lowpass', 280, 0.8); e.compAM = G(0.5); e.compG = G(0);  // air compressor: chugging brown noise
      const lfo = O('sine', 11.5), lfoD = G(0.5); lfo.connect(lfoD); lfoD.connect(e.compAM.gain); chain(e.comp, e.compF, e.compAM, e.compG, e.out);
      e.compOn = false; e.compNext = now() + 15 + r() * 40; e.compEnd = 0;
      e.gains = [e.gearG, e.slotG, e.humG, e.invG, e.mainsG, e.compG];
      return (emu = e);
    }
    function updEmu(active, v, p) {
      if (!active) { if (emu) for (const g of emu.gains) ramp(g.gain, 0, 0.25); return; }
      const e = getEmu(), load = Math.min(1, Math.abs(p)), regen = p < -0.05, run = smooth(0.15, 2.2, v), fe = 5.4 * v;
      const inside = S.inCab ? 0.85 : S.onboard ? 1.25 : 1;   // traction motors sit under the passenger floor
      const lg = 0.22 + 0.78 * load;
      ramp(e.gear.frequency, 38 + 41 * v, 0.04); ramp(e.slot.frequency, 55 + (regen ? 81 : 77) * v, 0.04); ramp(e.hum.frequency, 24 + 2 * fe, 0.04);
      ramp(e.gearG.gain, 0.05 * run * lg * inside, 0.1);
      ramp(e.slotG.gain, 0.032 * run * lg * inside * (1 - 0.45 * smooth(24, 38, v)), 0.1);
      ramp(e.humG.gain, 0.06 * run * (0.25 + 0.75 * load) * inside, 0.1);
      // Synchronous-PWM "song": the carrier locks to a falling multiple of the motor frequency, so the pitch
      // rises, drops, rises again as the train accelerates (and plays in reverse while braking).
      let car; if (v < 3.2) car = 1000; else if (v < 7.5) car = 33 * fe; else if (v < 12) car = 21 * fe; else if (v < 17) car = 15 * fe; else car = 9 * fe;
      ramp(e.inv.frequency, car, 0.012); ramp(e.invSide.frequency, car + 2 * fe, 0.012); ramp(e.invBP.frequency, car, 0.03);
      ramp(e.invG.gain, 0.024 * (load > 0.03 ? load : 0) * (1 - smooth(19, 24, v)) * inside, 0.06);
      ramp(e.mainsG.gain, S.onboard ? 0.011 : 0.005, 0.3);
      const t = now();
      if (!e.compOn && t > e.compNext) { e.compOn = true; e.compEnd = t + 7 + r() * 7; }
      if (e.compOn && t > e.compEnd) { e.compOn = false; e.compNext = t + 50 + r() * 80; }
      ramp(e.compG.gain, e.compOn ? (S.onboard ? 0.03 : 0.055) : 0, 0.35);
    }

    // ---- Diesel: EMD 16-cylinder two-stroke (MP36-class), 8 notches (lazy)
    let dsl = null;
    function getDiesel() {
      if (dsl) return dsl;
      const d = { rpm: 255, load: 0 }; d.out = G(1); d.out.connect(trainBus);
      d.fire = O('sawtooth', 68); d.fireLP = F('lowpass', 400, 1.3); d.fireAM = G(0.55); d.fireG = G(0); chain(d.fire, d.fireLP, d.fireAM, d.fireG, d.out);
      d.crank = O('sine', 4.25); const cd = G(0.33); d.crank.connect(cd); cd.connect(d.fireAM.gain);           // once-per-revolution lope
      d.crank2 = O('triangle', 8.6); const cd2 = G(0.12); d.crank2.connect(cd2); cd2.connect(d.fireAM.gain);
      d.half = O('sine', 34); d.halfG = G(0); chain(d.half, d.halfG, d.out);                                   // bank imbalance
      d.mech = Loop(B.brown); d.mechBP = F('bandpass', 320, 0.9); d.mechAM = G(0.6); d.mechG = G(0); chain(d.mech, d.mechBP, d.mechAM, d.mechG, d.out);
      const md = G(0.4); d.crank.connect(md); md.connect(d.mechAM.gain);
      d.exh = Loop(B.pink); d.exhLP = F('lowpass', 700, 0.7); d.exhG = G(0); chain(d.exh, d.exhLP, d.exhG, d.out);          // exhaust roar
      d.turbo = O('sine', 1400); d.turboG = G(0); chain(d.turbo, d.turboG, d.out);                                           // turbo whistle
      d.turboN = Loop(B.white); d.turboBP = F('bandpass', 2700, 2.5); d.turboNG = G(0); chain(d.turboN, d.turboBP, d.turboNG, d.out);
      d.db = Loop(B.pink); d.dbBP = F('bandpass', 720, 0.7); d.dbG = G(0); chain(d.db, d.dbBP, d.dbG, d.out);             // dynamic-brake grid fans
      d.dbTone = O('triangle', 92); d.dbToneG = G(0); chain(d.dbTone, d.dbToneG, d.out);
      d.gear = O('sine', 60); d.gearG = G(0); chain(d.gear, d.gearG, d.out);                                                   // DC traction-motor gear whine
      d.gains = [d.fireG, d.halfG, d.mechG, d.exhG, d.turboG, d.turboNG, d.dbG, d.dbToneG, d.gearG];
      return (dsl = d);
    }
    function updDiesel(active, v, p, dt) {
      if (!active) { if (dsl) for (const g of dsl.gains) ramp(g.gain, 0, 0.3); return; }
      const d = getDiesel();
      const notch = p > 0.02 ? Math.min(8, 1 + Math.floor(p * 7.999)) : 0, target = 255 + notch * (904 - 255) / 8;
      d.rpm += clamp(target - d.rpm, -48 * dt, 62 * dt); d.load += (notch / 8 - d.load) * Math.min(1, dt * 1.2);
      const rpm = d.rpm, ff = rpm / 60 * 16, load = d.load, rpmN = (rpm - 255) / 649;
      const pers = S.inCab ? 0.75 : S.onboard ? 0.4 : 1;
      ramp(d.fire.frequency, ff, 0.05); ramp(d.half.frequency, ff / 2, 0.05); ramp(d.crank.frequency, rpm / 60, 0.05); ramp(d.crank2.frequency, rpm / 60 * 2.02, 0.05);
      ramp(d.fireLP.frequency, 200 + 760 * load + 360 * rpmN, 0.1);
      ramp(d.fireG.gain, (0.1 + 0.13 * load + 0.05 * rpmN) * pers, 0.1);
      ramp(d.halfG.gain, (0.05 + 0.04 * load) * pers, 0.1);
      ramp(d.mechG.gain, (0.035 + 0.03 * rpmN) * pers, 0.1);
      ramp(d.exhG.gain, (0.012 + 0.07 * load) * pers, 0.15); ramp(d.exhLP.frequency, 500 + 900 * load, 0.2);
      const tb = smooth(430, 880, rpm) * (0.35 + 0.65 * load);
      ramp(d.turbo.frequency, 700 + rpm * 2.7, 0.2); ramp(d.turboG.gain, 0.011 * tb * pers, 0.2); ramp(d.turboNG.gain, 0.02 * tb * pers, 0.2);
      const db = p < -0.05 ? Math.abs(p) * smooth(3, 11, v) : 0;
      ramp(d.dbG.gain, 0.07 * db * pers, 0.4); ramp(d.dbToneG.gain, 0.012 * db * pers, 0.4); ramp(d.dbTone.frequency, 88 + 10 * db, 0.5);
      ramp(d.gear.frequency, 32 + 36 * v, 0.05); ramp(d.gearG.gain, 0.018 * smooth(0.3, 3, v) * (0.3 + 0.7 * Math.abs(p)) * pers, 0.1);
    }

    // ---- Rolling: wheel/rail roar, structure-borne rumble, high hiss, HVAC; joints; flange squeal (lazy)
    let roll = null;
    function getRoll() {
      if (roll) return roll;
      const o = {};
      o.src = Loop(B.pink); o.bp = F('bandpass', 600, 0.55); o.g = G(0); chain(o.src, o.bp, o.g, trainBus);
      o.rum = Loop(B.brown); o.rumLP = F('lowpass', 170, 0.7); o.rumAM = G(0.92); o.rumG = G(0); chain(o.rum, o.rumLP, o.rumAM, o.rumG, trainBus);
      o.wheel = O('sine', 3); const wd = G(0.08); o.wheel.connect(wd); wd.connect(o.rumAM.gain);            // once-per-wheel-turn rhythm
      o.hiss = Loop(B.white); o.hissHP = F('highpass', 3200, 0.7); o.hissLP = F('lowpass', 7500, 0.7); o.hissG = G(0); chain(o.hiss, o.hissHP, o.hissLP, o.hissG, trainBus);
      o.hvac = Loop(B.pink); o.hvacF = F('bandpass', 380, 0.6); o.hvacG = G(0); chain(o.hvac, o.hvacF, o.hvacG, trainBus);
      o.clatter = G(1); o.clatter.connect(trainBus);
      o.traveled = 0; o.nextJoint = 30;
      return (roll = o);
    }
    function updRoll(v, tunnel) {
      const o = getRoll(), x = v / 35;
      ramp(o.bp.frequency, 260 + 27 * v, 0.1);
      ramp(o.g.gain, 0.33 * Math.pow(x, 1.5) * (S.onboard ? 0.75 : 1) * (1 + 0.7 * tunnel), 0.12);
      ramp(o.rumG.gain, 0.3 * Math.pow(x, 1.1) * (S.onboard ? 1.25 : 0.7) * (1 + 0.5 * tunnel), 0.12);
      ramp(o.hissG.gain, 0.022 * x * x * (S.onboard ? 0.15 : 1), 0.12);
      ramp(o.wheel.frequency, Math.max(0.5, v / (Math.PI * 0.86)), 0.1);
      ramp(o.hvacG.gain, S.onboard ? 0.045 : 0.022, 0.3);
    }
    function joints(dt) {
      if (!roll || S.stale) return;
      const v = S.speed, o = roll; o.traveled += v * dt;
      if (v < 1.5) { if (o.traveled > o.nextJoint) o.nextJoint = o.traveled + 20; return; }
      if (o.traveled < o.nextJoint) return;
      const a = 2.6 / v, b = 17.2 / v, base = now() + 0.02, lvl = Math.min(1, Math.pow(v / 28, 0.8)) * 0.4 * (S.onboard ? 0.9 : 1);
      const hits = b < 3 ? [[0, 1], [a, 0.85], [b, 0.55], [b + a, 0.5]] : [[0, 1], [a, 0.85]];
      for (const [t, amp] of hits) oneShot(B.clack, o.clatter, lvl * amp * (0.85 + 0.3 * r()), 0.88 + r() * 0.24, base + t);
      o.nextJoint = o.traveled + (r() < 0.12 ? 6 + r() * 10 : 45 + r() * 160);   // welded rail: joints and switches are occasional
    }
    let sq = null, sqTarget = 0, sqNext = 0;
    function updSqueal(v, curve) {
      const want = smooth(0.3, 0.85, curve) * smooth(1.5, 4, v) * (1 - smooth(16, 24, v));
      if (want < 0.001 && !sq) return;
      if (!sq) {
        const g = G(0), bp = F('bandpass', 4200, 1.1), lp = F('lowpass', 7000, 0.7);
        const tones = [2950, 4380, 6120].map((f, i) => { const o = O('sine', f), og = G([0.6, 0.35, 0.15][i]); o.connect(og); og.connect(bp); return o; });
        const vib = O('sine', 5.3), vibD = G(16); vib.connect(vibD); tones.forEach(o => vibD.connect(o.frequency));
        chain(bp, lp, g, trainBus); sq = { g, tones };
      }
      if (now() > sqNext) { sqTarget = r() < 0.65 ? 0.3 + 0.7 * r() : 0; sqNext = now() + 0.25 + r() * 1.1; }
      ramp(sq.g.gain, 0.05 * want * sqTarget, 0.12);
    }

    // ---- Horns. EMU: two-chime air horn (Eb4 + F#4). Diesel: 5-chime K5LA-style D# minor 6th chord.
    const HORN_EMU = [311.13, 369.99], HORN_K5LA = [311.13, 369.99, 415.3, 493.88, 622.25];
    function makeHorn(kind, dest) {
      const dz = kind === 'diesel', freqs = dz ? HORN_K5LA : HORN_EMU;
      const env = G(0), peq = F('peaking', dz ? 950 : 1200, 1.1, 4), lp = F('lowpass', dz ? 3100 : 3600, 0.75); chain(env, peq, lp, dest);
      const delays = dz ? [0, 0.018, 0.035, 0.012, 0.05] : [0, 0.015];
      const voices = freqs.map((f, i) => { const g = G(0), o1 = O('sawtooth', f * 0.94), o2 = O('sawtooth', f * 0.94 * 1.0035); o1.connect(g); o2.connect(g); g.connect(env); return { f, g, o1, o2, delay: delays[i] }; });
      const hs = Loop(B.white), hb = F('bandpass', 2600, 1.2), hg = G(0.02); chain(hs, hb, hg, env);
      const perVoice = dz ? 0.14 : 0.22; let on = false, mult = 1;
      return {
        start() { if (on) return; on = true; const t = now(); env.gain.cancelScheduledValues(t); env.gain.setTargetAtTime(1, t, 0.025);
          for (const v of voices) { const t0 = t + v.delay; v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(perVoice, t0, 0.03);
            v.o1.frequency.cancelScheduledValues(t); v.o2.frequency.cancelScheduledValues(t);
            v.o1.frequency.setTargetAtTime(v.f * mult, t0, 0.045); v.o2.frequency.setTargetAtTime(v.f * mult * 1.0035, t0, 0.045); } },
        stop() { if (!on) return; on = false; const t = now(); env.gain.setTargetAtTime(0, t, 0.07);
          for (const v of voices) { v.o1.frequency.setTargetAtTime(v.f * mult * 0.965, t, 0.12); v.o2.frequency.setTargetAtTime(v.f * mult * 0.965 * 1.0035, t, 0.12); } },
        setPitch(m) { mult = m; if (!on) return; for (const v of voices) { ramp(v.o1.frequency, v.f * m, 0.03); ramp(v.o2.frequency, v.f * m * 1.0035, 0.03); } },
        get on() { return on; },
        destroy(after = 0.9) { const t = now() + after; for (const v of voices) { v.o1.stop(t); v.o2.stop(t); } hs.stop(t); hs.onended = () => { try { env.disconnect(); } catch (e) { /* gone */ } }; },
      };
    }
    let horn = null;
    function hornFn(on) {
      if (on) {
        if (horn && horn.kind !== S.kind) { horn.h.stop(); horn.h.destroy(); horn = null; }
        if (!horn) horn = { kind: S.kind, h: makeHorn(S.kind, hornBus) };
        horn.h.start();
      } else if (horn) { const h = horn.h; horn = null; h.stop(); h.destroy(0.9); }
    }

    // ---- Locomotive bell (diesel). Each ringing gets its own gain, so a quick re-trigger never revives the
    // fading loop of the previous one (which would ring a second, out-of-step bell).
    let bell = null;
    function bellFn(on) {
      const t = now();
      if (on && !bell) {
        const s = ctx.createBufferSource(), g = G(0); s.buffer = buf('bellLoop'); s.loop = true; chain(s, g, hornBus); s.start(t);
        g.gain.setTargetAtTime(0.3, t, 0.005); bell = { s, g };
      } else if (!on && bell) {
        const { s, g } = bell; bell = null; g.gain.setTargetAtTime(0, t, 0.5); s.stop(t + 2.5);
        s.onended = () => { try { s.disconnect(); g.disconnect(); } catch (e) { /* already gone */ } };
      }
    }

    // ---- Doors
    function doorChime() { oneShot(buf('doorChime'), uiBus, 0.32); }
    // cab alerts (PTC warning / enforcement): short synthesized two-tone beeps on the UI bus
    function alertTone(kind) {
      const t0 = ctx.currentTime + 0.01; const hi = kind === 'enforce' ? 1320 : 1046, lo = kind === 'enforce' ? 880 : 784;
      for (let i = 0; i < (kind === 'enforce' ? 4 : 2); i++) for (const [f, dt] of [[hi, 0], [lo, 0.16]]) {
        const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'square'; o.frequency.value = f;
        const a = t0 + i * 0.36 + dt; g.gain.setValueAtTime(0, a); g.gain.linearRampToValueAtTime(0.09, a + 0.01); g.gain.setValueAtTime(0.09, a + 0.12); g.gain.linearRampToValueAtTime(0, a + 0.14);
        o.connect(g); g.connect(uiBus); o.start(a); o.stop(a + 0.16);
      }
    }
    function doorEdge(open) { oneShot(buf(open ? 'hissOpen' : 'hissClose'), S.onboard ? uiBus : trainBus, S.onboard ? 0.28 : 0.4); }

    // ---- Announcements: chime, then speech. Queued, never overlapping.
    const annQ = []; let annBusy = false, voiceCache = null, muted = false, volume = 0.8;
    function pickVoice() {
      if (voiceCache) return voiceCache;
      if (!('speechSynthesis' in window)) return null;
      const vs = speechSynthesis.getVoices(); if (!vs.length) return null;
      const en = vs.filter(v => /^en[-_]?US/i.test(v.lang)), anyEn = vs.filter(v => /^en/i.test(v.lang));
      const good = en.find(v => /(Premium|Enhanced|Natural|Neural)/i.test(v.name));
      if (good) return (voiceCache = good);
      for (const p of ['Samantha', 'Ava', 'Allison', 'Google US English', 'Microsoft Aria', 'Microsoft Jenny', 'Microsoft Guy', 'Microsoft Zira', 'Alex', 'Karen', 'Daniel', 'Serena', 'Moira']) {
        const v = anyEn.find(x => x.name.includes(p)); if (v) return (voiceCache = v);
      }
      return (voiceCache = en[0] || anyEn[0] || null);
    }
    if (live && 'speechSynthesis' in window && speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', () => { voiceCache = null; });
    function announce(text) { return new Promise(res => { annQ.push({ text: String(text || ''), res }); pump(); }); }
    function pump() {
      if (annBusy || !annQ.length) return;
      annBusy = true; const { text, res } = annQ.shift();
      const done = () => { annBusy = false; res(); pump(); };
      if (muted) { done(); return; }
      oneShot(buf('annChime'), uiBus, 0.45);
      if (!speechOn || !text || !('speechSynthesis' in window)) { setTimeout(done, speechOn ? 1500 : 30); return; }
      setTimeout(() => {
        if (muted) { done(); return; }
        let finished = false, to = 0; const fin = () => { if (!finished) { finished = true; clearTimeout(to); ramp(duck.gain, 1, 0.6); done(); } };
        try {
          const u = new SpeechSynthesisUtterance(text), v = pickVoice();
          if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
          u.rate = 0.96; u.pitch = 1.0; u.volume = clamp(volume, 0, 1); u.onend = fin; u.onerror = fin;
          to = setTimeout(fin, 4000 + text.length * 110); ramp(duck.gain, 0.55, 0.25); speechSynthesis.speak(u);
        } catch (e) { fin(); }
      }, 1250);
    }

    // ---- Grade crossings: up to three nearest active crossings, each a looping electronic bell
    const xv = [0, 1, 2].map(() => ({ src: null, g: null, lp: null, lastOn: -1 }));
    const xNear = [-1, -1, -1];   // distances of the three nearest active crossings (-1 = none); no per-frame allocation
    function crossings(list) {
      tick();
      xNear[0] = xNear[1] = xNear[2] = -1;
      if (Array.isArray(list)) for (let i = 0; i < list.length; i++) {
        const c = list[i]; if (!c || !c.active) continue;
        const d = Math.abs(+c.dist); if (!(d < 900)) continue;   // also rejects NaN
        if (xNear[2] >= 0 && d >= xNear[2]) continue;
        let k = 2; while (k > 0 && (xNear[k - 1] < 0 || d < xNear[k - 1])) { xNear[k] = xNear[k - 1]; k--; }
        xNear[k] = d;
      }
      for (let i = 0; i < 3; i++) {
        const v = xv[i], d = xNear[i];
        if (!v.g) { if (d < 0) continue; v.g = G(0); v.lp = F('lowpass', 12000, 0.6); chain(v.g, v.lp, worldBus); }
        if (d >= 0) {
          if (!v.src) { const s = ctx.createBufferSource(); s.buffer = buf('crossLoop'); s.loop = true; s.playbackRate.value = 0.97 + 0.03 * i; s.connect(v.g); s.start(now(), 0); v.src = s; }
          ramp(v.g.gain, 0.42 * Math.pow(Math.min(1, 12 / Math.max(12, d)), 1.15), 0.05);
          ramp(v.lp.frequency, clamp(13000 - d * 16, 1600, 13000), 0.1); v.lastOn = now();
        } else if (v.src) { ramp(v.g.gain, 0, 0.08); const s = v.src; v.src = null; s.stop(now() + 0.6); }
      }
    }

    // ---- Another train passing: rolling roar + motor/engine tone with Doppler, optional horn
    let pb = null; const pbLast = { dist: null, t: 0, vr: 0 };
    function buildPass() {
      const p = {}; p.out = G(0); p.lp = F('lowpass', 12000, 0.6); chain(p.out, p.lp, worldBus);
      p.n = Loop(B.pink); p.bp = F('bandpass', 700, 0.6); p.ng = G(0); chain(p.n, p.bp, p.ng, p.out);
      p.r = Loop(B.brown); p.rlp = F('lowpass', 220, 0.7); p.rg = G(0); chain(p.r, p.rlp, p.rg, p.out);
      p.t1 = O('sine', 600); p.t1g = G(0); chain(p.t1, p.t1g, p.out);
      p.t2 = O('triangle', 1200); p.t2g = G(0); chain(p.t2, p.t2g, p.out);
      p.saw = O('sawtooth', 120); p.sawLP = F('lowpass', 520, 1.2); p.sawG = G(0); chain(p.saw, p.sawLP, p.sawG, p.out);
      p.hornG = G(1); p.hornG.connect(p.out); p.horn = null; p.lastCall = now();
      return p;
    }
    function passby(p) {
      tick();
      if (!p || !Number.isFinite(+p.dist) || +p.dist > 1500) { if (pb) { ramp(pb.out.gain, 0, 0.3); if (pb.horn) { pb.horn.stop(); pb.horn.destroy(); pb.horn = null; } } pbLast.dist = null; return; }
      if (!pb) pb = buildPass();
      const t = now(), dist = +p.dist;
      if (pbLast.dist != null && t > pbLast.t + 1e-4) pbLast.vr = lerp(pbLast.vr, clamp((dist - pbLast.dist) / (t - pbLast.t), -90, 90), 0.3);
      if (pbLast.dist == null) pbLast.vr = 0;
      pbLast.dist = dist; pbLast.t = t;
      const sp = Math.abs(+p.speed || 0), dz = p.kind === 'diesel', dop = SPEED_OF_SOUND / (SPEED_OF_SOUND + pbLast.vr);
      ramp(pb.out.gain, 0.6 * Math.pow(Math.min(1, 10 / Math.max(10, dist)), 1.1) * (0.15 + 0.85 * smooth(0, 25, sp)), 0.05);
      ramp(pb.lp.frequency, clamp(15000 - dist * 14, 1500, 15000), 0.1);
      ramp(pb.bp.frequency, (280 + 26 * sp) * dop, 0.03);
      ramp(pb.ng.gain, 0.5 * Math.pow(sp / 35, 1.3), 0.05); ramp(pb.rg.gain, 0.35 * (sp / 35), 0.05);
      if (!dz) {
        ramp(pb.t1.frequency, (38 + 41 * sp) * dop, 0.03); ramp(pb.t2.frequency, (55 + 77 * sp) * dop, 0.03);
        ramp(pb.t1g.gain, 0.06 * smooth(0.5, 5, sp), 0.1); ramp(pb.t2g.gain, 0.035 * smooth(0.5, 5, sp), 0.1); ramp(pb.sawG.gain, 0, 0.1);
      } else {
        ramp(pb.saw.frequency, (400 + sp * 14) / 60 * 16 * dop, 0.05); ramp(pb.sawG.gain, 0.22, 0.1); ramp(pb.t1g.gain, 0, 0.1); ramp(pb.t2g.gain, 0, 0.1);
      }
      if (p.horn && !pb.horn) { pb.horn = makeHorn(dz ? 'diesel' : 'emu', pb.hornG); pb.horn.setPitch(dop); pb.horn.start(); }
      else if (!p.horn && pb.horn) { pb.horn.stop(); pb.horn.destroy(0.9); pb.horn = null; }
      if (pb.horn) pb.horn.setPitch(dop);
      pb.lastCall = t;
    }

    // ---- Ambience beds (lazy per layer) + gull events
    const AMB = { city: 0, bay: 0, wind: 0, rain: 0, night: 0, crowd: 0 }, amb = {};
    let gullNext = 0, modNext = 0;
    const AMB_BUILD = {
      city() { const o = {}; o.a = Loop(B.pink); o.lp = F('lowpass', 650, 0.6); o.g = G(0); chain(o.a, o.lp, o.g, worldBus);   // traffic bed
        o.b = Loop(B.brown); o.bp = F('bandpass', 280, 0.6); o.sw = G(0.5); o.g2 = G(0); chain(o.b, o.bp, o.sw, o.g2, worldBus); return o; },  // passing-car swells
      wind() { const o = {}; o.a = Loop(B.pink); o.bp = F('bandpass', 480, 0.9); o.gust = G(0.6); o.g = G(0); chain(o.a, o.bp, o.gust, o.g, worldBus);
        o.w = Loop(B.white); o.wbp = F('bandpass', 2300, 5); o.wg = G(0); chain(o.w, o.wbp, o.wg, o.gust); return o; },
      bay() { const o = {}; o.a = Loop(B.brown); o.lp = F('lowpass', 420, 0.7); o.am = G(0.6); o.g = G(0); chain(o.a, o.lp, o.am, o.g, worldBus);   // lapping water
        const lfo = O('sine', 0.23), d = G(0.4); lfo.connect(d); d.connect(o.am.gain); return o; },
      rain() { const o = {}; o.a = Loop(buf('rain')); o.g = G(0); chain(o.a, o.g, worldBus); return o; },
      night() { const o = {}; o.a = Loop(buf('crickets')); o.g = G(0); chain(o.a, o.g, worldBus); return o; },
      crowd() { const o = {}; o.a = Loop(buf('babble')); o.g = G(0); chain(o.a, o.g, worldBus); return o; },
    };
    function layer(name, level) { if (!amb[name]) { if (level < 0.001) return null; amb[name] = AMB_BUILD[name](); } return amb[name]; }
    function applyAmb() {
      const tduck = 1 - 0.92 * S.tunnelNow, w = Math.max(AMB.wind, AMB.bay * 0.4);
      let L;
      if ((L = layer('city', AMB.city))) { ramp(L.g.gain, 0.1 * AMB.city * tduck, 0.4); ramp(L.g2.gain, 0.09 * AMB.city * tduck, 0.4); }
      if ((L = layer('wind', w))) { ramp(L.g.gain, 0.14 * w * tduck, 0.5); ramp(L.wg.gain, 0.25 * w, 0.5); }
      if ((L = layer('bay', AMB.bay))) ramp(L.g.gain, 0.09 * AMB.bay * tduck, 0.5);
      if ((L = layer('rain', AMB.rain))) ramp(L.g.gain, 0.32 * AMB.rain * lerp(1, 0.55, S.tunnelNow), 0.6);
      if ((L = layer('night', AMB.night))) ramp(L.g.gain, 0.16 * AMB.night * (1 - 0.45 * AMB.city) * (1 - 0.8 * AMB.rain) * tduck, 0.8);
      if ((L = layer('crowd', AMB.crowd))) ramp(L.g.gain, 0.2 * AMB.crowd * tduck, 0.5);
    }
    function ambTick() {
      const t = now();
      if (t > modNext) { modNext = t + 0.8 + r() * 2.5;   // slow random swells: traffic passing, wind gusts
        if (amb.city) { ramp(amb.city.sw.gain, 0.25 + 0.75 * r(), 1.2); ramp(amb.city.bp.frequency, 200 + 160 * r(), 1.5); }
        if (amb.wind) { ramp(amb.wind.gust.gain, 0.35 + 0.65 * r(), 1.0 + r()); ramp(amb.wind.bp.frequency, 350 + 450 * r(), 1.5); } }
      if (AMB.bay > 0.25 && S.tunnelNow < 0.5 && t > gullNext) {
        if (gullNext > 0) { const vars = buf('gull'); oneShot(vars[Math.floor(r() * vars.length)], worldBus, (0.05 + 0.08 * r()) * AMB.bay, 0.92 + 0.16 * r(), 0, r() * 1.6 - 0.8); }
        gullNext = t + (4 + r() * 12) / (0.5 + AMB.bay);
      }
    }
    function ambience(a = {}) { tick(); for (const k in AMB) AMB[k] = clamp(+a[k] || 0, 0, 1); applyAmb(); }

    // ---- per-frame driver for the player's train
    function silenceTrain() { ramp(trainBus.gain, 0, 0.2); }
    function train(s = {}) {
      tick();
      const kind = s.kind === 'diesel' ? 'diesel' : 'emu';
      const v = Math.abs(+s.speed || 0), accel = +s.accel || 0;
      const power = s.power != null ? clamp(+s.power || 0, -1, 1) : clamp(accel / 0.9, -1, 1);
      const inCab = !!s.inCab, onboard = !!s.onboard || inCab;
      const tunnel = clamp(+s.tunnel || 0, 0, 1), curve = clamp(+s.curve || 0, 0, 1);
      const dist = onboard ? 0 : Math.max(0, s.dist != null ? +s.dist || 0 : 0);
      const doors = !!s.doorsOpen;
      if (doors !== S.doorsOpen && S.lastCall >= 0 && !S.stale) { S.onboard = onboard; doorEdge(doors); }
      if (S.stale) ramp(trainBus.gain, 1, 0.15);
      S.kind = kind; S.speed = v; S.power = power; S.onboard = onboard; S.inCab = inCab; S.tunnel = tunnel; S.curve = curve;
      S.dist = dist; S.doorsOpen = doors; S.lastCall = now(); S.stale = false;
      // listener perspective
      const distG = onboard ? 1 : Math.pow(Math.min(1, 14 / Math.max(14, dist)), 1.1);
      const outCut = clamp(16500 - dist * 18, 1400, 16500) * lerp(1, 0.45, tunnel);
      ramp(trainLP.frequency, inCab ? 2600 : onboard ? 1250 : outCut, 0.08);
      ramp(trainOut.gain, (inCab ? 0.9 : onboard ? 0.85 : 1) * distG * (1 + 0.6 * tunnel), 0.08);
      ramp(hornLP.frequency, inCab ? 5200 : onboard ? 1900 : clamp(15000 - dist * 10, 2500, 15000), 0.08);
      ramp(hornOut.gain, (inCab ? 0.75 : onboard ? 0.5 : 1) * (onboard ? 1 : Math.min(1, 25 / Math.max(25, dist))), 0.08);
      const leak = onboard && doors ? 1 : 0;   // open doors let the platform in
      ramp(worldLP.frequency, inCab ? 1500 : onboard ? lerp(700, 3200, leak) : 18000, 0.15);
      ramp(worldOut.gain, inCab ? 0.6 : onboard ? lerp(0.42, 0.75, leak) : 1, 0.15);
      if (tunnel > 0.001 || sends) { const sd = ensureSends(); ramp(sd.train.gain, 0.55 * tunnel, 0.15); ramp(sd.horn.gain, 0.9 * tunnel, 0.15); ramp(sd.world.gain, 0.3 * tunnel, 0.15); }
      if (Math.abs(S.tunnelNow - tunnel) > 0.01) { S.tunnelNow = tunnel; applyAmb(); }
      updEmu(kind === 'emu', v, power);
      updDiesel(kind === 'diesel', v, power, dtLast);
      updRoll(v, tunnel);
      updSqueal(v, curve);
    }
    S.tunnelNow = 0;

    // ---- time-based housekeeping (called from every API entry point and a rAF heartbeat)
    let lastTick = -1, dtLast = 1 / 60;
    function tick() {
      const t = now();
      if (lastTick >= 0 && t - lastTick < 0.008) return;
      dtLast = lastTick < 0 ? 1 / 60 : Math.min(0.25, t - lastTick); lastTick = t;
      if (!S.stale && t - S.lastCall > 0.6) { S.stale = true; silenceTrain(); if (horn) hornFn(false); }
      joints(dtLast);
      ambTick();
      if (pb && t - pb.lastCall > 0.5) { ramp(pb.out.gain, 0, 0.3); if (pb.horn) { pb.horn.stop(); pb.horn.destroy(); pb.horn = null; } pbLast.dist = null; }
      for (let i = 0; i < 3; i++) { const v = xv[i]; if (v.src && t - v.lastOn > 0.5) { ramp(v.g.gain, 0, 0.1); const s = v.src; v.src = null; s.stop(t + 0.6); } }
    }

    function setVolume(v) { volume = clamp(+v, 0, 1); if (!muted) ramp(master.gain, volume, 0.05); }
    function setMuted(m) {
      muted = !!m; ramp(master.gain, muted ? 0 : volume, 0.05);
      if (muted && 'speechSynthesis' in window && live) { try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
    }
    return {
      ctx, master, train, horn: hornFn, bell: bellFn, doorChime, alertTone, announce, crossings, passby, ambience, tick, setVolume, setMuted, warmStep,
      get state() { return S; },
    };
  }

  // ------------------------------------------------------------------ public singleton
  let E = null, muted = false, volume = 0.8, raf = 0, suspendTimer = 0;
  function init() {
    if (E) { if (!muted && E.ctx.state !== 'running') E.ctx.resume().catch(() => {}); return true; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
    let ctx; try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { return false; }
    E = createEngine(ctx, { speech: true, live: true });
    E.setVolume(volume); E.setMuted(muted);
    if (!muted) ctx.resume().catch(() => {});
    const beat = () => { if (E) E.tick(); raf = requestAnimationFrame(beat); }; raf = requestAnimationFrame(beat);
    const later = window.requestIdleCallback ? f => requestIdleCallback(f, { timeout: 4000 }) : f => setTimeout(f, 150);
    const warm = () => { if (E && E.warmStep()) later(warm); }; later(warm);
    document.addEventListener('visibilitychange', () => {
      if (!E) return;
      if (document.hidden) E.ctx.suspend().catch(() => {}); else if (!muted) E.ctx.resume().catch(() => {});
    });
    return true;
  }
  function setMuted(m) {
    muted = !!m; if (!E) return; E.setMuted(muted); clearTimeout(suspendTimer);
    if (muted) suspendTimer = setTimeout(() => { if (muted && E) E.ctx.suspend().catch(() => {}); }, 250);   // save CPU while muted
    else E.ctx.resume().catch(() => {});
  }
  function setVolume(v) { volume = clamp(+v || 0, 0, 1); if (E) E.setVolume(volume); }
  return {
    init, setMuted, setVolume,
    get muted() { return muted; }, get volume() { return volume; },
    get ready() { return !!E && E.ctx.state === 'running'; },
    train(s) { if (E) E.train(s); },
    horn(on) { if (E) E.horn(!!on); },
    bell(on) { if (E) E.bell(!!on); },
    doorChime() { if (E) E.doorChime(); },
    alert(kind) { if (E && E.alertTone && !muted) E.alertTone(kind || 'warn'); },
    announce(text) { return E ? E.announce(text) : Promise.resolve(); },
    crossings(list) { if (E) E.crossings(list); },
    passby(p) { if (E) E.passby(p); },
    ambience(a) { if (E) E.ambience(a); },
    _createEngine: createEngine,           // for tests: build an engine on any (Offline)AudioContext
    get _engine() { return E; },
  };
})();
