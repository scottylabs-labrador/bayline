// Bayline Metro live mode (#metro=1, opt-in: the "Live" chip on the system map, or #mlive=1). The timetable runtime is a
// pure function of the clock; live mode replaces the published times of the trains running now with the operator's
// real-time predictions, so every train snaps to where it really is (and the boards show the real minutes).
//   1. GTFS-Realtime trip updates, through a same-origin proxy (the feed has no CORS header): /bartrt/tripupdate
//      (nginx snippet in notes/bart/sim.md; tools/devserver.py mirrors it for local testing). Decoded with a minimal
//      protobuf reader below; matched by trip id and GTFS stop id.
//   2. Fallback when the proxy isn't there: the public real-time departures API (CORS enabled, the public key):
//      per-station minutes, platform, train length and delay, matched to the scheduled trips by platform, destination
//      and time; each trip gets the median delay of its matches and its real length.
// Only when the clock is live (real time); every 20 s while on; nothing is fetched while it is off.
const MetroLive = (() => {
  const PROXY = './bartrt/tripupdate', ETD = 'https://api.bart.gov/api/etd.aspx?cmd=etd&orig=ALL&json=y&key=MW9S-E7SL-26DU-VV8V';
  let on = false, timer = 0, busy = false, source = '', lastOk = 0, matched = 0, error = '';
  const listeners = [];

  // ---------------------------------------------------------------- protobuf (wire format), just enough for GTFS-RT
  function reader(u8, p = 0, end = u8.length) {
    return {
      p, end,
      more() { return this.p < this.end; },
      varint() { let x = 0, m = 1, b; do { b = u8[this.p++]; x += (b & 0x7f) * m; m *= 128; } while (b & 0x80 && this.p < this.end); return x; },
      tag() { const t = this.varint(); return [Math.floor(t / 8), t & 7]; },
      bytes() { const n = this.varint(), s = this.p; this.p += n; return [s, s + n]; },
      str() { const [a, b] = this.bytes(); return new TextDecoder().decode(u8.subarray(a, b)); },
      skip(w) { if (w === 0) this.varint(); else if (w === 1) this.p += 8; else if (w === 2) this.bytes(); else if (w === 5) this.p += 4; else throw new Error('pb wire ' + w); },
      sub() { const [a, b] = this.bytes(); return reader(u8, a, b); },
    };
  }
  const int32 = (x) => x > 0x7fffffff ? x - 0x100000000 * Math.ceil(x / 0x100000000) : x;   // negative int32 arrive as 64-bit varints
  function stopEvent(r) { const o = {}; while (r.more()) { const [f, w] = r.tag(); if (f === 1 && w === 0) o.delay = int32(r.varint()); else if (f === 2 && w === 0) o.time = r.varint(); else r.skip(w); } return o; }
  function decodeFeed(buf) {
    const u8 = new Uint8Array(buf), R = reader(u8), out = [];
    while (R.more()) {
      const [f, w] = R.tag(); if (f !== 2 || w !== 2) { R.skip(w); continue; }
      const E = R.sub();
      while (E.more()) {
        const [f2, w2] = E.tag(); if (f2 !== 3 || w2 !== 2) { E.skip(w2); continue; }
        const T = E.sub(), tu = { trip: '', stops: [] };
        while (T.more()) {
          const [f3, w3] = T.tag();
          if (f3 === 1 && w3 === 2) { const D = T.sub(); while (D.more()) { const [f4, w4] = D.tag(); if (f4 === 1 && w4 === 2) tu.trip = D.str(); else D.skip(w4); } }
          else if (f3 === 2 && w3 === 2) { const S = T.sub(), su = {}; while (S.more()) { const [f5, w5] = S.tag();
              if (f5 === 1 && w5 === 0) su.seq = S.varint(); else if (f5 === 2 && w5 === 2) su.arr = stopEvent(S.sub()); else if (f5 === 3 && w5 === 2) su.dep = stopEvent(S.sub()); else if (f5 === 4 && w5 === 2) su.stop = S.str(); else S.skip(w5); }
            tu.stops.push(su); }
          else T.skip(w3);
        }
        if (tu.trip && tu.stops.length) out.push(tu);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- applying predictions
  // absolute times (epoch s) -> seconds of today's Pacific service clock
  function clockOffset() { return Date.now() / 1000 - Env.nowPacificSeconds(); }
  function applyTripUpdates(list) {
    const off = clockOffset(); let n = 0;
    for (const tu of list) {
      const p = MetroSim.planFor(tu.trip); if (!p) continue;
      const legs = p.trip.legs.map(L => L.slice());                // scheduled [arr, dep, ...] per pattern leg (service-day s)
      const pat = MetroSim.net.patterns[p.trip.pat]; if (!pat) continue;
      let firstDelay = null, any = false;
      // (a stop listed on two legs, like the transfer platform, is matched on the first leg that hasn't used it yet)
      for (const su of tu.stops) {
        const ta = su.arr && su.arr.time ? su.arr.time - off : null, td = su.dep && su.dep.time ? su.dep.time - off : null;
        const dl = su.dep && su.dep.delay !== undefined ? su.dep.delay : su.arr && su.arr.delay !== undefined ? su.arr.delay : null;
        for (let k = 0; k < pat.legs.length; k++) { const i = pat.legs[k].stops.findIndex(s => s.gtfs === su.stop); if (i < 0) continue;
          const L = legs[k], sa = L[2 * i] + p.dayOff, sd = L[2 * i + 1] + p.dayOff;
          const a = ta !== null ? ta : dl !== null ? sa + dl : null, d = td !== null ? td : dl !== null ? sd + dl : a;
          if (a === null) continue; if (firstDelay === null) firstDelay = a - sa;
          L[2 * i] = a - p.dayOff; L[2 * i + 1] = Math.max(a, d) - p.dayOff; any = true; L.touched = L.touched || []; L.touched[i] = 1; break; }
      }
      if (!any) continue;
      // stops without a prediction: before the first one (already served) they carry its delay, so the train's past
      // stays consistent with where it is now; gaps carry the previous stop's delay
      let dl = firstDelay || 0;
      for (let k = 0; k < legs.length; k++) { const L = legs[k], O = p.trip.legs[k];
        for (let i = 0; i < L.length / 2; i++) { if (L.touched && L.touched[i]) { dl = L[2 * i] - O[2 * i]; continue; } L[2 * i] = O[2 * i] + dl; L[2 * i + 1] = O[2 * i + 1] + dl; } }
      if (MetroSim.applyLive(tu.trip, legs.map(L => Array.from(L, v => v + p.dayOff)))) n++;
    }
    return n;
  }
  // the ETD fallback: minutes per station/platform/destination -> the scheduled trips, by time; a median delay per trip
  function applyEtd(j) {
    const now = Env.time.sec, perTrip = new Map(), lengths = new Map();
    const stations = (j && j.root && j.root.station) || [];
    for (const S of stations) {
      const evs = MetroSim.arrivals(S.abbr, now - 600, 80, { past: 900 });
      for (const E of S.etd || []) for (const est of E.estimate || []) {
        const mins = est.minutes === 'Leaving' ? 0 : +est.minutes; if (!isFinite(mins)) continue;
        const pred = now + mins * 60, delay = +est.delay || 0, plat = String(est.platform || '');
        let best = null, bd = 300;
        for (const ev of evs) {
          if ((ev.sid || '').split('-')[1] !== plat) continue;
          const inf = MetroSim.eventInfo(ev); if (!destMatch(inf.dest, E.destination, E.abbreviation)) continue;
          const d = Math.abs(ev.pub + delay - pred); if (d < bd) { bd = d; best = ev; }
        }
        if (!best) continue;
        const id = best.plan.trip.id; if (!perTrip.has(id)) perTrip.set(id, []); perTrip.get(id).push(pred - best.pub);
        if (+est.length) lengths.set(id, +est.length);
      }
    }
    let n = 0;
    for (const [id, ds] of perTrip) {
      const p = MetroSim.planFor(id); if (!p) continue; ds.sort((a, b) => a - b); const dl = ds[ds.length >> 1];
      if (Math.abs(dl) < 20 && !lengths.has(id)) continue;
      const legs = p.trip.legs.map(L => L.map(v => v + dl + p.dayOff));
      if (MetroSim.applyLive(id, legs, lengths.get(id))) n++;
    }
    return n;
  }
  function destMatch(ours, name, abbr) { const a = ours.toLowerCase(), b = String(name || '').toLowerCase(); return a.includes(b.split(/[ /]/)[0]) || b.includes(a.split(/[ /]/)[0]) || (MetroSim.stById.get(abbr) && MetroSim.stName(abbr) === ours); }

  // ---------------------------------------------------------------- polling
  async function poll() {
    if (!on || busy || document.hidden) return; busy = true;
    try {
      if (!Env.time.live) { error = 'Live mode follows the real clock: press 0 for live time'; notify(); return; }
      let n = -1;
      if (source !== 'etd') {
        try { const r = await fetch(PROXY, { cache: 'no-store' });
          if (r.ok && !(r.headers.get('content-type') || '').startsWith('text/html')) { const list = decodeFeed(await r.arrayBuffer()); n = applyTripUpdates(list); source = 'gtfs-rt'; }
          else source = 'etd'; } catch (e) { source = 'etd'; }
      }
      if (source === 'etd') { const r = await fetch(ETD, { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); n = applyEtd(await r.json()); }
      matched = n; lastOk = performance.now(); error = '';
    } catch (e) { error = 'Live data unavailable (' + (e.message || e) + ')'; }
    finally { busy = false; notify(); }
  }
  function notify() { for (const f of listeners) try { f(status()); } catch (e) { /* UI */ } }
  function status() { return { on, source, matched, error, age: lastOk ? (performance.now() - lastOk) / 1000 : -1 }; }
  function setOn(v) {
    v = !!v; if (v === on) return; on = v; clearInterval(timer);
    if (on) { if (!Env.time.live) Env.goLive(); poll(); timer = setInterval(poll, 20000); }
    else { matched = 0; MetroSim.replan(); }                     // back to the pure timetable
    notify();
  }
  return { setOn, poll, status, onChange(f) { listeners.push(f); }, get on() { return on; }, decodeFeed, _applyEtd: applyEtd };
})();
