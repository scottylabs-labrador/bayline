# Sound (audio agent notes)

Everything is synthesized at runtime with the Web Audio API. There are no audio files, no network access,
and no per-frame node creation. Station announcements use the browser's `speechSynthesis`.

## Files

| File | What |
|---|---|
| `src/js/70_sound.js` | `Sound` module (one top-level `const Sound = (() => {...})()`, no globals besides `window` audio APIs) |
| `preview/sound.html` | interactive preview (buttons/sliders for every sound, level meter) + offline self-test |
| `notes/sound.md` | this file |

Self-test: `node tools/shot.mjs "file://$PWD/preview/sound.html#selftest" /tmp/sound.png --gpu --wait 20000`
(the log ends with `SELFTEST DONE n/m passed`, also in `window.__selftest`).

## API

```
Sound.init() -> bool          call inside a user gesture (click / keydown). Idempotent; a later call resumes a suspended context.
Sound.setMuted(bool)          fades out, cancels speech, suspends the AudioContext after 250 ms (no CPU while muted)
Sound.setVolume(0..1)         master level, default 0.8 (also used as the speech volume)
Sound.muted  Sound.volume  Sound.ready       getters; ready = context exists and is running
Sound.train({ kind, speed, accel, power, onboard, inCab, tunnel, doorsOpen, curve, dist })   every frame
Sound.horn(on)  Sound.bell(on)               level-triggered; pass the held state every frame or on change
Sound.doorChime()                            one-shot door-closing warning
Sound.announce(text) -> Promise              chime, then speech; queued, never overlapping; resolves when finished
Sound.crossings([{ dist, active }])          every frame; the three nearest active crossings ring
Sound.passby({ dist, speed, kind, horn })    every frame for the nearest other moving train; pass null when none
Sound.ambience({ city, bay, wind, rain, night, crowd })   0..1 each; every frame or on change
```
All calls are no-ops before `init()`. `announce` then resolves immediately.

Extensions beyond SPEC (all optional): `dist` in `train()`, `horn` in `passby()`, `crowd` in `ambience()`, the
getters above, `Sound._engine` (the live engine: `.master` GainNode for meters, `.state`), and
`Sound._createEngine(ctx, { seed, speech, live })`, which builds an engine on any (Offline)AudioContext for tests.

### `train()` fields

| Field | Unit | Meaning |
|---|---|---|
| `kind` | `'emu'` / `'diesel'` | traction sound set. Switching crossfades (about 0.3 s) |
| `speed` | m/s | absolute value is used |
| `power` | −1..1 | traction effort (+) or braking (−). EMU: load drives the motor song, − = regen. Diesel: notch = ceil(power·8); − above 3 m/s = dynamic-brake fans |
| `accel` | m/s² | used only when `power` is omitted: `power = clamp(accel / 0.9, −1, 1)` |
| `onboard` | bool | listener inside a passenger car |
| `inCab` | bool | listener in the driving cab (implies onboard) |
| `tunnel` | 0..1 | how far inside a tunnel: reverb, louder roar, ambience ducked. Ramp it over the first ~30 m past a portal |
| `doorsOpen` | bool | the edges play the open/close hiss. Onboard, open doors let the platform ambience in |
| `curve` | 0..1 | curve tightness; flange squeal from 0.3, full at 0.85, only at 1.5–24 m/s. Suggest `clamp(120 / radius_m, 0, 1)` |
| `dist` | m | outside only: listener distance to the nearest car (0 = right beside it). Attenuation plus air absorption |

If `train()` isn't called for 0.6 s, the train fades out (and a held horn is released). When the player walks
away, simply stop calling it.

## Driving it from the game (lead)

```js
startButton.onclick = () => { Sound.init(); /* ... */ };          // must be inside the gesture
muteKey = () => Sound.setMuted(!Sound.muted);

// every frame
const t = focusTrain;            // the train the player is on, or the nearest one within ~400 m when on foot
if (t) Sound.train({
  kind: t.kind, speed: Math.abs(t.speed), power: t.throttle - t.brake,   // or accel: t.accel
  onboard: mode === 'ride' || mode === 'cab', inCab: mode === 'cab',
  tunnel: tunnelFactor(t.s), doorsOpen: t.doorT > 0.05, curve: clamp(120 / radiusAt(t.s), 0, 1),
  dist: onboard ? 0 : distToConsist(camera, t),
});
Sound.horn(driving && input.horn);                  // or an AI focus train sounding for a crossing
Sound.bell(t && t.kind === 'diesel' && (departing || nearCrossing));
Sound.crossings(crossingsWithin900m);               // reuse one array of { dist, active: gatesDown }
Sound.passby(other ? { dist, speed: Math.abs(other.speed), kind: other.kind, horn: other.horning } : null);
Sound.ambience({ city, bay, wind, rain, night: U.uNight.value, crowd: onPlatform ? waitingCrowd01 : 0 });

// events
Sound.doorChime();                                  // ~2-3 s before the doors start closing
Sound.announce('Next stop: Palo Alto.');            // on departure, only while onboard
Sound.announce('Now arriving: Palo Alto. Doors will open on the right.');
```
Suggested ambience inputs: `city` = urban density at the camera; `bay` = 1 within ~300 m of the shoreline, fading
to 0 by ~2 km (gulls fire above 0.25); `wind` = 0.2 baseline, more on bridges and at open marshes;
`crowd` = 0.3–1 on busy platforms. `tunnel` also ducks the ambience automatically.
Per-frame cost of `train + crossings + passby + ambience` together: about 9 µs. The calls don't allocate.

## Mix

Measured in the offline self-test at the default volume of 0.8 (dBFS RMS, sample peak):

| Situation | RMS | Peak |
|---|---|---|
| EMU standing, onboard (HVAC, transformer hum) | −41 | 0.02 |
| EMU cruising 30 m/s, onboard lower deck | −24 | 0.30 |
| EMU in cab, 20 m/s | −26 | 0.26 |
| EMU departing, heard from the platform at 8 m | −23 | 0.33 |
| diesel notching up from idle at 10 m | −20 | 0.42 |
| onboard in a tunnel at 28 m/s (loudest normal state) | −17 | 0.60 |
| horn from 20 m, EMU / K5LA | −15 / −14.5 | 0.73 |
| EMU pass-by at 30 m/s with horn (closest 0.25 s) | −15 | 0.64 |
| crossing bell at 20 m | −26 | 0.21 |
| ambience beds | −33 … −39 | ≤ 0.14 |
| everything at once (tunnel, horn, bell, crossings, pass-by, all ambience) | −12 | 0.85 |

Master: buses → `preMix` → DynamicsCompressor limiter (threshold −6 dB, knee 4, ratio 20, attack 2 ms, release
150 ms) → master gain (= volume) → output. Nothing clips even in the worst case. While speech is playing,
train, world and reverb dip about 5 dB so the announcement stays intelligible; the dry horn is never ducked.

Listener perspective (set by `train()`; everything is smoothed, so switching views never clicks):

| Listener | train lowpass / gain | horn lowpass / gain | world (ambience, crossings, pass-bys) lowpass / gain |
|---|---|---|---|
| outside, distance d | 16500 − 18d Hz (≥ 1400) / (14/d)^1.1 | 15000 − 10d Hz (≥ 2500) / min(1, 25/d) | open / 1 |
| onboard | 1250 Hz / 0.85 (traction motors +25%, under the floor) | 1900 Hz / 0.5 | 700 Hz / 0.42 (doors open: 3200 Hz / 0.75) |
| in cab | 2600 Hz / 0.9 | 5200 Hz / 0.75 | 1500 Hz / 0.6 |
| tunnel (× the above) | train lowpass × 0.45 outside, gain × (1 + 0.6·tunnel), roar +70% | — | ambience × (1 − 0.92·tunnel) |

Tunnel reverb sends: train 0.55, horn 0.9, world 0.3 (× tunnel), return 0.75. Individual source gains (the knobs
to tune) are inline in `70_sound.js` next to each sound; the largest are rolling roar 0.33·(v/35)^1.5, horn
0.22 per chime EMU / 0.14 per chime diesel, crossing bell 0.42·(12/d)^1.15, and pass-by 0.6·(10/d)^1.1.

## What is modeled

- **EMU traction:** gear mesh (38 + 41v Hz), rotor slot harmonic (55 + 77v, 81v in regen), and a motor hum at
  2 × the electrical frequency fe = 5.4v. The inverter "song" follows synchronous PWM: 1 kHz below 3.2 m/s, then
  33, 21, 15 and 9 × fe. It rises, drops and rises again while accelerating, plays in reverse under regen, and
  fades above ~20 m/s where rolling noise takes over. 120/240 Hz transformer hum; an air compressor cycles on for
  7–14 s every 50–130 s at standstill and while running.
- **Diesel (EMD 16-645-like, MP36-class):** idle 255 → 904 rpm at notch 8, slewing +62/−48 rpm/s.
  - Firing tone at rpm/60 × 16, with once- and twice-per-revolution lope and a half-order bank tone.
  - Mechanical clatter, and exhaust roar that grows with load.
  - Turbo whistle at 700 + 2.7·rpm, above ~430 rpm only.
  - Dynamic-brake grid fans, and DC traction gear whine.
- **Rolling:**
  - Wheel/rail roar: band-passed at 260 + 27v Hz, rising as v^1.5.
  - Structure-borne rumble with a once-per-wheel-turn beat.
  - High hiss outside, and HVAC.
  - Rail joints: 4-hit bogie patterns (axles 2.6 m, bogies 17.2 m) every 45–205 m of welded rail, with 12%
    switch-clatter clusters.
  - Flange squeal: three intermittent partials at 2.95/4.38/6.12 kHz with vibrato.
- **Tunnel:** a generated 2 s concrete-bore impulse response (early reflections + 0.42 s decay, dark).
- **Horns** (held while pressed; 6% glide up on attack, 3.5% droop on release, breath noise):
  - EMU: two-chime Eb4 + F#4.
  - Diesel: 5-chime K5LA-style D#4 F#4 G#4 B4 D#5 (311/370/415/494/622 Hz), with per-chime valve delays.
- **Bell:** bronze partial set (hum, prime, tierce, quint, nominal 870 Hz, upper partials) struck ~58/min by an
  air ringer. The loop is the exact steady state of periodic strikes, so it has no seam. Stopping fades it out over ~1.5 s.
- **Doors:** 988/831 Hz warning chime × 3. Pneumatic exhaust hiss, sliding rumble, lock thunk / seal thump.
- **Announcements:** E5 → C5 chime, then speech 1.25 s later.
  - Voice: the first en-US voice named Premium/Enhanced/Natural/Neural; failing that, Samantha, Ava, Allison,
    Google US English, Aria, Jenny, …
  - Delivery: rate 0.96.
  - Timing: a timeout fallback so the queue never stalls.
- **Crossings:** electronic bell at 1210 Hz (+2790/4420/645 Hz partials), 2 strikes/s. Each crossing starts on a
  strike and has its own slightly different rate, so neighbours drift like the real thing.
- **Pass-by:**
  - Sound: roar and rumble, plus EMU motor tones or the diesel firing tone.
  - Doppler: from the rate of change of `dist`, f × 343/(343 + v_r).
  - Optional horn, also Doppler-shifted.
- **Ambience:**
  - City: traffic bed with passing-car swells.
  - Wind: gusts plus a faint whistle.
  - Bay: water swell, and western-gull calls every 4–16 s.
  - Rain: hiss plus individual drops.
  - Night: field crickets at 4.2–5.3 kHz, thinned by city and rain.
  - Crowd: station walla from 12 synthetic voices.

## Cost

- `init()` builds the noise beds in ~30 ms. After that, the other buffers are generated one per idle callback
  (11 steps, mostly 4–11 ms; rain 21 ms, crowd 37 ms), so first use later costs ~0 (measured 6.8 ms to start
  every feature at once).
- Long-lived nodes are created lazily per feature and reused forever (EMU ~20, diesel ~35, rolling ~20,
  ambience 3–10 per layer). Only event sounds create short-lived nodes, and they disconnect themselves when done:
  - joint clacks, every 45–205 m;
  - horn blasts;
  - chimes;
  - door hisses;
  - gulls.
- Parameter updates use `setTargetAtTime` with change detection, so steady states schedule no automation events.
- Offline render: 0.015–0.04 × real time for typical scenes, 0.08 × for everything at once (M-series, 48 kHz).
- Hidden tab → context suspended. Muted → suspended after 250 ms.

## Self-test (preview/sound.html#selftest)

28 scenarios rendered with an OfflineAudioContext. Every 50 ms the scenario drives the per-frame API through
`suspend()` / `resume()`. The analysis covers peak, RMS, NaN, clipping, the largest sample-to-sample jump
(discontinuity/click detector), an 8192-point averaged spectrum (centroid + spectral peaks), and a 0.25 s RMS
envelope.

Pass criteria:
- no NaN;
- peak < 0.99;
- the silent engine renders exact zeros;
- sound scenarios are louder than −70 dB;
- continuous scenarios have max jump ≤ 0.25;
- the stale-train fade tail is below −45 dB.

It then runs a live-singleton smoke test of every public call.

Current result: **28/28 pass, live API smoke ok.** Spot checks against the models:
- onboard EMU peaks at 346/1266/2367 Hz (hum, gear, slot at 30 m/s);
- horn peaks at 311/369 Hz (EMU) and 311/369/416/492/621 Hz (K5LA);
- bell partials at 521/867 Hz;
- crossing strikes every 0.5 s;
- pass-by envelope −46 → −15 → −41 dB, with a Doppler ratio of ~1.10 on approach;
- stale train fades to −83 dB.

## Known limits

- Speech comes from the OS/browser, so voice quality varies. It bypasses the Web Audio graph (no tunnel reverb or
  limiter on it). Volume changes don't affect a sentence already being spoken; mute cancels it. Some platforms
  have no voices: the chime plays and the queue continues via the timeout. Chrome can cut off very long
  utterances, so keep one sentence per `announce()` call.
- Only one focus train (`train()`) and one other train (`passby()`) are voiced at a time; up to three crossing
  bells ring together.
- No left/right positioning of world sounds. Pass-bys and crossings are centered; beds are stereo; gulls are
  randomly panned. Adding a `pan` field backed by a StereoPannerNode would be easy.
- Doppler is estimated from successive `dist` values, so update `passby()` every frame. A teleport causes a brief
  pitch swoop (smoothed, and clamped to ±90 m/s radial).
- The bell is kind-agnostic; the game decides when it rings (normally diesel only).
- The crowd is synthetic walla that reads as a distant crowd, not words.
- Headless Chrome can't produce audible output. The self-test verifies signals numerically. The mix was tuned
  from spectra and levels, so a listening pass on real speakers/headphones is still worthwhile.
