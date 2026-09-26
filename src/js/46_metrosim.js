// Bayline Metro: the timetable runtime, the metro counterpart of 45_sim.js (read that first).
//
// Every trip of the public timetable is a pure function of the clock, so every client sees the same trains:
//   1. Schedule. Published times are rounded to the minute. Each trip's times are smoothed by a weighted isotonic
//      regression (pool-adjacent-violators) against its minimum run times and dwells: no train runs faster than
//      it can, terminals depart on the minute, and rounding errors spread over the neighbouring runs.
//   2. Kinematics. Each run between two stops is a minimum-time speed profile under the civil speed limits with
//      the tail rule (a train speeds up only once its last car has cleared a restriction), traction limited by
//      power above ~25 mph, ATO braking, then capped (a lower performance level) to fill the scheduled time.
//      Tabulated once per distinct run and cached; evaluating a train is a binary search.
//   3. Legs. A trip splits where the vehicle changes (the Antioch DMU meets the BART train across the platform
//      at Pittsburg / Bay Point) and where it reverses (SFO). Legs that end and start at the same terminal are
//      linked into one physical train (turnbacks), so the train you watched arrive is the one that leaves.
//   4. Drawing. Trains near the camera (and the one you follow) get pooled MetroKit consists posed bogie by bogie
//      on MetroNet; everything else is one instanced batch (one draw call for the whole system), light points
//      for night views and map dots for aerial ones.
// The player can take over any trip and drive it (MetroSim.drive; ATC, scoring and guidance: 47_metroatc.js).
// Everything here is dormant unless Bayline Metro is enabled (#metro=1, see ENABLED below).
const MetroSim = (() => {
  const HASH = new URLSearchParams(location.hash.slice(1));
  const DEFAULT_ON = false;                                   // the lead flips this when Bayline Metro ships by default
  const enabled = HASH.has('metro') ? HASH.get('metro') !== '0' : DEFAULT_ON;
  const MPH = 0.44704, TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---------------------------------------------------------------- vehicles
  // BART Fleet of the Future: 3.0 mph/s initial acceleration (1.34 m/s², the district's design figure), four
  // 194 hp motors per car (constant power above ~25 mph), 70 mph operating maximum, ATO service braking ~2.5 mph/s,
  // full service 3 mph/s, emergency ~3.6 mph/s (80 -> 0 in 20-25 s). eBART DMU: 75 mph, gentler. Airport cable
  // train: 30 mph, smooth. Resistance: Davis-style per unit mass.
  const PERF = {
    bart: { vmax: 70 * MPH, a0: 1.34, pw: 14.8, b: 1.12, bFull: 1.34, bEm: 1.62, carLen: 21.34, minCars: 2, maxCars: 10, res: [0.006, 0.00012, 0.000048] },
    dmu:  { vmax: 75 * MPH, a0: 0.95, pw: 8.2,  b: 0.95, bFull: 1.1, bEm: 1.35, carLen: 40.9, minCars: 1, maxCars: 2, res: [0.007, 0.00013, 0.00005] },
    oak:  { vmax: 30 * MPH, a0: 0.75, pw: 30,   b: 0.72, bFull: 0.9, bEm: 1.2, carLen: 12.2, minCars: 3, maxCars: 3, res: [0.004, 0.0001, 0.00003] },
  };
  const resist = (P, v) => P.res[0] + P.res[1] * v + P.res[2] * v * v;
  const tractA = (P, v) => Math.min(P.a0, P.pw / Math.max(v, 0.5));

  // ---------------------------------------------------------------- data adapter (MetroNet + timetable)
  // Everything format-specific lives here, so the runtime below only sees: stations {id, name, x, z}, lines {id,
  // name, color, text}, trips {id, line, dir, pattern, svc, head, cars, bus, stops: [{sid, st, arr, dep}]} and paths.
  let MN = null, TT = null, ready = false, loading = null, loadError = null;
  const stations = [], stById = new Map(), lines = [], lineById = new Map(); let trips = [], services = {};
  const DEV = { base: HASH.get('metrodata') || null };
  const NAMES_SHORT = { 'San Francisco International Airport': 'SFO Airport', 'Millbrae (Caltrain Transfer Platform)': 'Millbrae',
    'Oakland International Airport Station': 'Oakland Airport', 'Pleasant Hill / Contra Costa Centre': 'Pleasant Hill',
    'Berryessa / North San Jose': 'Berryessa', 'Warm Springs / South Fremont': 'Warm Springs', 'Dublin / Pleasanton': 'Dublin / Pleasanton',
    'West Dublin / Pleasanton': 'West Dublin', '12th Street / Oakland City Center': '12th St Oakland', '19th Street Oakland': '19th St Oakland',
    'Civic Center / UN Plaza': 'Civic Center', '16th Street / Mission': '16th St Mission', '24th Street / Mission': '24th St Mission',
    'North Concord / Martinez': 'North Concord', 'Coliseum - OAC': 'Coliseum' };
  const LINE_NAMES = { yellow: 'Yellow', orange: 'Orange', green: 'Green', red: 'Red', blue: 'Blue', grey: 'Airport', beige: 'Airport', bus: 'Bus bridge' };
  const DMU_ST = new Set(['ANTC', 'PCTR']);                    // served by the diesel shuttle (a separate standard-gauge line)
  const XFER_DMU = 'PITT';                                     // cross-platform transfer DMU <-> BART
  async function loadData() {
    if (typeof MetroNet !== 'undefined' && MetroNet.load) { MN = MetroNet; await MN.load(DEV.base || undefined); }
    else throw new Error('MetroNet is not in this build');
    TT = MN.timetable ? await MN.timetable() : await Stream.json((DEV.base || 'metro/') + 'timetable.json', 2);
    // stations
    for (const s of MN.stations) { const o = { id: s.id, name: s.name, short: NAMES_SHORT[s.name] || s.name, x: s.x, z: s.z, y: s.y, src: s, lines: new Set(), idx: stations.length }; stations.push(o); stById.set(o.id, o); }
    // lines (from the network, else from the trips' colours)
    for (const l of (MN.lines || [])) { const o = { id: l.id, name: l.name || LINE_NAMES[l.id] || l.id, color: l.color || '#cccccc', text: l.text || '#000000', terminals: l.terminals || [], src: l }; lines.push(o); lineById.set(o.id, o); }
    services = TT.services || TT.calendar || {};
    trips = (TT.trips || []).map(normTrip).filter(Boolean);
    for (const t of trips) { if (!lineById.has(t.line)) { const o = { id: t.line, name: LINE_NAMES[t.line] || t.line, color: t.color || '#cccccc', text: '#000', terminals: [] }; lines.push(o); lineById.set(t.line, o); }
      if (!t.bus) for (const s of t.stops) { const st = stById.get(s.st); if (st) st.lines.add(t.line); } }
  }
  function normTrip(t) {
    const stops = (t.stops || []).map(s => Array.isArray(s) ? { sid: s[0], st: s[1], arr: s[2], dep: s[3] !== undefined ? s[3] : s[2] } : { sid: s.sid || s.stop || s.id, st: s.st || s.station, arr: s.arr, dep: s.dep !== undefined ? s.dep : s.arr });
    if (stops.length < 2) return null;
    return { id: String(t.id), route: t.route, line: t.line, color: t.color, dir: t.dir | 0, pattern: t.pattern || t.shape || (t.line + ':' + t.dir), svc: t.svc || t.service,
      head: t.head || t.headsign || '', cars: t.cars || 0, bus: !!t.bus, stops };
  }
  // service days: GTFS calendar + calendar_dates, resolved per date (yyyymmdd, weekday 0 = Sunday)
  function servicesOn(ymd, wd) {
    const out = new Set(), di = (wd + 6) % 7;
    for (const id in services) { const s = services[id]; let on = !!(s.days && s.days[di]) && ymd >= s.start && ymd <= s.end;
      if (s.remove && s.remove.includes(ymd)) on = false; if (s.add && s.add.includes(ymd)) on = true; if (on) out.add(id); }
    return out;
  }
  // MetroNet frame, normalised: x y z, unit tangent (tx ty tz) toward +s, cant (rad, + = right rail up), lim (m/s), st
  function netFrame(track, s, out) { MN.frame(track, s, out); if (out.lim === undefined) out.lim = out.limit !== undefined ? out.limit : PERF.bart.vmax; return out; }

  // ---------------------------------------------------------------- paths
  // A path is the ordered list of track pieces a train follows, measured from 0 (its start) to length.
  const F0 = {}, F1 = {}, F2 = {};
  class MPath {
    constructor(pieces, id) {
      this.id = id; this.pc = []; let L = 0;
      for (const p of pieces) { const len = Math.abs(p.s1 - p.s0); if (!(len > 1e-3)) continue; this.pc.push({ track: p.track, s0: p.s0, sg: p.s1 >= p.s0 ? 1 : -1, L0: L, len }); L += len; }
      this.length = L; this.xz = null; this._k = 0;
    }
    piece(ps) { const P = this.pc; let k = this._k; if (k >= P.length) k = 0;
      if (ps >= P[k].L0 && ps <= P[k].L0 + P[k].len) return k;
      let lo = 0, hi = P.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (P[m].L0 <= ps) lo = m; else hi = m - 1; } this._k = lo; return lo; }
    at(ps, out) {
      const p = this.pc[this.piece(ps)], s = p.s0 + p.sg * (clamp(ps, 0, this.length) - p.L0);
      netFrame(p.track, s, out);
      if (p.sg < 0) { out.tx = -out.tx; out.ty = -out.ty; out.tz = -out.tz; out.cant = -(out.cant || 0); }
      out.track = p.track; out.ts = s; out.tsg = p.sg; return out;
    }
    limitAt(ps) { if (ps < 0) ps = 0; else if (ps > this.length) ps = this.length; const p = this.pc[this.piece(ps)]; return MN.limitAt ? MN.limitAt(p.track, p.s0 + p.sg * (ps - p.L0)) : netFrame(p.track, p.s0 + p.sg * (ps - p.L0), F2).lim; }
    // coarse polyline (every 10 m) for projections: stops on the path, the map, nearest-point queries
    samples() { if (this.xz) return this.xz; const n = Math.max(2, Math.ceil(this.length / 10) + 1), a = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { this.at(Math.min(this.length, i * 10), F2); a[i * 2] = F2.x; a[i * 2 + 1] = F2.z; } return (this.xz = a); }
    project(x, z, from = 0, to = this.length) {   // path position nearest to (x, z) within [from, to]
      const a = this.samples(), n = a.length / 2; let best = -1, bd = 1e18;
      for (let i = Math.max(0, Math.floor(from / 10)); i < n && i * 10 <= to + 10; i++) { const d = (a[i * 2] - x) ** 2 + (a[i * 2 + 1] - z) ** 2; if (d < bd) { bd = d; best = i; } }
      if (best < 0) return { ps: from, d: 1e9 };
      let ps = best * 10; for (const h of [5, 2.5, 1.2, 0.6]) { let b2 = ps; for (const c of [ps - h, ps + h]) { if (c < from || c > to) continue; this.at(c, F2); const d = (F2.x - x) ** 2 + (F2.z - z) ** 2; if (d < bd) { bd = d; b2 = c; } } ps = b2; }
      return { ps, d: Math.sqrt(bd) };
    }
  }
  const pathCache = new Map();
  function pathFor(trip) {
    const key = trip.line + '|' + trip.dir + '|' + trip.pattern;
    if (pathCache.has(key)) return pathCache.get(key);
    let pieces = null;
    try { pieces = MN.pathFor(trip.line, trip.dir, trip.pattern, trip); } catch (e) { console.warn('metro pathFor', key, e); }
    if (pieces && !Array.isArray(pieces)) pieces = pieces.pieces || pieces.segs || pieces.tracks || null;
    const p = pieces && pieces.length ? new MPath(pieces.map(q => ({ track: q.track !== undefined ? q.track : q.id, s0: q.s0 !== undefined ? q.s0 : q.from, s1: q.s1 !== undefined ? q.s1 : q.to })), key) : null;
    pathCache.set(key, p); return p;
  }
  // where the head of the train stops for each stop of a trip on its path: the far end of the platform (trains pull
  // up to the front of the platform, whatever their length), from MetroNet's platform data when it has it
  const stopCache = new Map();
  function stopMarks(trip, path) {
    const key = path.id + '|' + trip.stops.map(s => s.sid).join(',');
    if (stopCache.has(key)) return stopCache.get(key);
    const out = []; let from = 0;
    for (let i = 0; i < trip.stops.length; i++) {
      const s = trip.stops[i], st = stById.get(s.st); let ps = null, side = 0, plen = 213;
      const pf = MN.platformFor ? MN.platformFor(s.sid, s.st, path, kindOfStop(trip, s)) : null;
      if (pf && pf.track !== undefined) { for (const p of path.pc) if (p.track === pf.track) { const a = p.L0 + (pf.s0 - p.s0) * p.sg, b = p.L0 + (pf.s1 - p.s0) * p.sg; if (Math.max(a, b) >= from - 5) { ps = Math.max(a, b) - 1.0; plen = Math.abs(b - a); side = pf.side ? (pf.side * p.sg) : 0; break; } } }
      if (ps === null && st) { const pr = path.project(st.x, st.z, from, Math.min(path.length, from + 60000)); plen = s.st === 'OAKL' || s.st === 'COLS_OAC' ? 46 : 213; ps = Math.min(path.length - 2, pr.ps + plen / 2 - 1.0); if (i === 0) ps = Math.max(ps, Math.min(path.length - 2, plen - 1)); }
      if (ps === null) ps = from;
      ps = clamp(ps, i ? from : 0, path.length - 0.5);
      out.push({ ps, side, plen }); from = ps + 1;   // (a stop listed twice, like a reversal, gets the next position)
    }
    stopCache.set(key, out); return out;
  }

  // ---------------------------------------------------------------- runs: minimum-time profiles, capped to fill a time
  // A run is tabulated at n+1 points ds apart: v[i] (m/s) and t[i] (s since departure). Between points the train
  // has constant acceleration, so evaluation is exact for the profile. Cached by (path, from, to, vehicle, length, T).
  const runCache = new Map(); let runCacheN = 0;
  function envelope(path, ps0, ps1, P, trainLen) {
    const D = Math.max(0.5, ps1 - ps0), n = clamp(Math.ceil(D / 10), 4, 700), ds = D / n;
    const lim = new Float32Array(n + 1);
    // raw civil limits along the run (plus a train length behind the start, for the tail rule)
    const back = Math.ceil(trainLen / ds), raw = new Float32Array(n + 1 + back);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.min(P.vmax, path.limitAt(ps0 + (i - back) * ds));
    // tail rule: the limit at head position i is the minimum over the train's length behind it (monotone deque)
    const dq = new Int32Array(raw.length); let h = 0, q = 0;
    for (let j = 0; j < raw.length; j++) {
      while (q > h && raw[dq[q - 1]] >= raw[j]) q--; dq[q++] = j;
      while (dq[h] < j - back) h++;
      if (j >= back) lim[j - back] = raw[dq[h]];
    }
    const vf = new Float32Array(n + 1); vf[0] = 0;
    for (let i = 0; i < n; i++) { const v = vf[i]; const a = tractA(P, v) - resist(P, v); let v2 = Math.sqrt(v * v + 2 * Math.max(0.05, a) * ds);
      if (v2 > v) { const vm = (v + v2) / 2, am = tractA(P, vm) - resist(P, vm); v2 = Math.sqrt(v * v + 2 * Math.max(0.05, am) * ds); }
      vf[i + 1] = Math.min(v2, lim[i + 1], lim[i]); }
    vf[n] = 0;
    for (let i = n - 1; i >= 0; i--) vf[i] = Math.min(vf[i], Math.sqrt(vf[i + 1] * vf[i + 1] + 2 * P.b * ds));
    vf[0] = 0;
    return { n, ds, D, v: vf };
  }
  function timeOf(E, cap, tOut) {
    const v = E.v, n = E.n, ds = E.ds; let t = 0; if (tOut) tOut[0] = 0;
    for (let i = 0; i < n; i++) { const a = Math.min(v[i], cap), b = Math.min(v[i + 1], cap); t += (a + b) > 1e-6 ? 2 * ds / (a + b) : 1e3; if (tOut) tOut[i + 1] = t; }
    return t;
  }
  const minRunCache = new Map();
  function minRun(path, ps0, ps1, kind, cars) {
    const key = path.id + '|' + ps0.toFixed(1) + '|' + ps1.toFixed(1) + '|' + kind + '|' + cars;
    let r = minRunCache.get(key); if (r !== undefined) return r;
    const P = PERF[kind], E = envelope(path, ps0, ps1, P, cars * P.carLen); r = timeOf(E, 1e9);
    minRunCache.set(key, r); return r;
  }
  function getRun(path, ps0, ps1, kind, cars, T) {
    const key = path.id + '|' + ps0.toFixed(1) + '|' + ps1.toFixed(1) + '|' + kind + '|' + cars + '|' + Math.round(T * 4);
    let R = runCache.get(key); if (R) { R.used = frameNo; return R; }
    const P = PERF[kind], E = envelope(path, ps0, ps1, P, cars * P.carLen), n = E.n;
    const tmin = timeOf(E, 1e9); let cap = 1e9, vpk = 0; for (let i = 0; i <= n; i++) vpk = Math.max(vpk, E.v[i]);
    if (T > tmin + 0.05) {
      // a lower performance level: cap the speed so the run takes T (never below half the line speed: a train with
      // lots of slack runs normally and waits at the next platform instead)
      const lo0 = Math.max(6, vpk * 0.5); let lo = lo0, hi = vpk;
      if (timeOf(E, lo) <= T) cap = lo;
      else { for (let k = 0; k < 26; k++) { const m = (lo + hi) / 2; if (timeOf(E, m) > T) lo = m; else hi = m; } cap = hi; }
    }
    const v = new Float32Array(n + 1), t = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) v[i] = Math.min(E.v[i], cap);
    timeOf({ v, n, ds: E.ds }, 1e9, t);
    R = { ps0, ps1, n, ds: E.ds, v, t, T: t[n], used: frameNo, key };
    runCache.set(key, R); runCacheN++;
    if (runCache.size > 2600) { const old = [...runCache.values()].sort((a, b) => a.used - b.used).slice(0, 800); for (const o of old) runCache.delete(o.key); }
    return R;
  }
  // position / speed / acceleration on a run at tau seconds after departure
  function runAt(R, tau, out) {
    const t = R.t, n = R.n; if (tau <= 0) { out.ps = R.ps0; out.v = 0; out.a = 0; return out; }
    if (tau >= t[n]) { out.ps = R.ps1; out.v = 0; out.a = 0; return out; }
    let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t[m] <= tau) lo = m; else hi = m - 1; }
    const v0 = R.v[lo], v1 = R.v[lo + 1], a = (v1 * v1 - v0 * v0) / (2 * R.ds), dt = tau - t[lo];
    let d = v0 * dt + 0.5 * a * dt * dt; if (d > R.ds) d = R.ds; if (d < 0) d = 0;
    out.ps = R.ps0 + lo * R.ds + d; out.v = Math.max(0, v0 + a * dt); out.a = a; return out;
  }

  // ---------------------------------------------------------------- schedule smoothing (weighted PAVA)
  // Given targets y[i] (published event times), weights w[i] and minimum spacings gap[i] (= run + dwell) between
  // consecutive events, find e[i] minimising sum w (e - y)^2 subject to e[i+1] >= e[i] + gap[i].
  function smoothTimes(y, w, gap) {
    const m = y.length, C = new Float64Array(m); for (let i = 1; i < m; i++) C[i] = C[i - 1] + gap[i - 1];
    const val = [], wt = [], cnt = [];
    for (let i = 0; i < m; i++) {
      val.push(y[i] - C[i]); wt.push(w[i]); cnt.push(1);
      while (val.length > 1 && val[val.length - 2] > val[val.length - 1]) {
        const b = val.pop(), wb = wt.pop(), cb = cnt.pop(), a = val.pop(), wa = wt.pop(), ca = cnt.pop();
        val.push((a * wa + b * wb) / (wa + wb)); wt.push(wa + wb); cnt.push(ca + cb);
      }
    }
    const out = new Float64Array(m); let k = 0; for (let j = 0; j < val.length; j++) for (let c = 0; c < cnt[j]; c++, k++) out[k] = val[j] + C[k];
    return out;
  }

  // ---------------------------------------------------------------- dwell and consist length (assumptions, see notes)
  const DWELL = { EMBR: 35, MONT: 32, POWL: 30, CIVC: 30, '12TH': 30, '19TH': 30, MCAR: 32, WOAK: 26, BAYF: 28, BALB: 26, DALY: 26, '16TH': 24, '24TH': 24, SFIA: 30, MLBR: 30, PITT: 30, COLS: 26, LAKE: 24, DBRK: 26, FTVL: 24, WCRK: 24 };
  function dwellAt(st, kind, t) {
    if (kind === 'oak') return 45;
    let d = DWELL[st] || 20; const h = (t % 86400) / 3600;
    if ((h > 6.8 && h < 9.3) || (h > 16.3 && h < 18.8)) d *= 1.2;
    return d;
  }
  // consist length when the timetable doesn't say: 10 cars at the peaks, 8 midday, 6 in the evening (assumption)
  function carsFor(trip, kind, t0, wd) {
    if (kind === 'oak') return 3; if (kind === 'dmu') return 2;
    if (trip.cars) return clamp(trip.cars, 2, 10);
    const h = (t0 % 86400) / 3600, wk = wd >= 1 && wd <= 5;
    if (h >= 20 || h < 5) return 6;
    if (wk && ((h >= 6.3 && h < 9.5) || (h >= 15.5 && h < 19))) return trip.line === 'green' || trip.line === 'orange' ? 9 : 10;
    return wk ? 8 : 8;
  }

  // ---------------------------------------------------------------- planning
  // plan = { key, trip, dayOff, legs[], tStart, tEnd }
  // leg  = { kind, path, cars, stops[{i, st, sid, ps, arr, dep, side}], runs[{k, t0, t1, T}], lead (0: car 0 leads),
  //          t0 (appears), t1 (vanishes), prev, next, id }
  let plans = [], dayKey = '', frameNo = 0, planById = new Map();
  let stopEvents = new Map();          // station id -> sorted [{t (dep or arr), arr, dep, plan, leg, k}] for boards
  function kindOfStop(trip, s) { if (trip.line === 'grey' || trip.line === 'beige' || s.st === 'OAKL' || s.st === 'COLS_OAC' || /^H\d/.test(s.sid)) return 'oak'; return DMU_ST.has(s.st) ? 'dmu' : 'bart'; }
  function splitLegs(trip) {
    // consecutive stops served by the same vehicle. At the DMU transfer (Pittsburg / Bay Point) one leg arrives and the
    // other departs; a stop listed twice in a row (SFO) is a reversal: the leg ends and the same train starts a new one
    const S = trip.stops, legs = []; let cur = null;
    for (let i = 0; i < S.length; i++) {
      const k = kindOfStop(trip, S[i]), rev = i > 0 && S[i - 1].st === S[i].st;
      if (!cur) { cur = { kind: k, idx: [i] }; legs.push(cur); continue; }
      if (rev) { cur = { kind: cur.kind, idx: [i], rev: true }; legs.push(cur); continue; }
      if (k !== cur.kind) {
        if (cur.kind === 'dmu' && S[i].st === XFER_DMU) { cur.idx.push(i); cur = { kind: 'bart', idx: [i], xfer: true }; legs.push(cur); continue; }
        if (k === 'dmu' && S[i - 1].st === XFER_DMU) { cur = { kind: 'dmu', idx: [i - 1, i], xfer: true }; legs.push(cur); continue; }
        cur = { kind: k, idx: [i] }; legs.push(cur); continue;
      }
      cur.idx.push(i);
    }
    return legs.filter(l => l.idx.length >= 2);
  }
  function planTrip(trip, dayOff, wd) {
    if (trip.bus) return null;
    const path = pathFor(trip); if (!path) return null;
    const marks = stopMarks(trip, path);
    const plan = { key: 'M:' + trip.id + (dayOff ? '@y' : ''), trip, dayOff, legs: [], tStart: 0, tEnd: 0, line: trip.line, id: trip.id };
    for (const pc of splitLegs(trip)) {
      const kind = pc.kind, idx = pc.idx;
      const cars = carsFor(trip, kind, trip.stops[idx[0]].dep + dayOff, wd);
      const stops = idx.map(i => { const s = trip.stops[i]; return { i, st: s.st, sid: s.sid, ps: marks[i].ps, side: marks[i].side, plen: marks[i].plen, arr: s.arr + dayOff, dep: s.dep + dayOff, tArr: 0, tDep: 0 }; });
      const leg = { kind, path, cars, stops, runs: [], lead: 0, rev: !!pc.rev, xfer: !!pc.xfer, t0: 0, t1: 0, prev: null, next: null, from: null, turn: null, sameTurn: false, plan, idx: plan.legs.length, chainKey: '' };
      plan.legs.push(leg);
    }
    if (!plan.legs.length) return null;
    // legs of one trip with the same vehicle are one train (a reversal): the new leg starts where the old one's tail is
    for (let i = 1; i < plan.legs.length; i++) { const a = plan.legs[i - 1], b = plan.legs[i]; if (a.kind === b.kind) { a.next = b; b.prev = a; b.cars = a.cars; alignStart(a, b); } }
    for (const l of plan.legs) timeLeg(l);
    plan.tStart = Math.min(...plan.legs.map(l => l.t0)); plan.tEnd = Math.max(...plan.legs.map(l => l.t1));
    return plan;
  }
  // a train that reverses (or turns back on the same platform) keeps standing where it is: its tail becomes its head
  function alignStart(a, b) {
    const sa = a.stops[a.stops.length - 1], P = PERF[a.kind];
    a.path.at(sa.ps - a.cars * P.carLen, F1);
    const s0 = b.stops[0], pr = b.path.project(F1.x, F1.z, Math.max(0, s0.ps - 400), Math.min(b.path.length, s0.ps + 400));
    if (pr.d < 25) s0.ps = Math.min(pr.ps, b.stops.length > 1 ? b.stops[1].ps - 5 : pr.ps);
  }
  // the leg's timeline: published targets smoothed against minimum runs and dwells (see smoothTimes)
  function timeLeg(l) {
    const S = l.stops, m = S.length, kind = l.kind, path = l.path;
    for (let j = 1; j < m; j++) if (S[j].ps < S[j - 1].ps + 1) S[j].ps = Math.min(path.length - 0.5, S[j - 1].ps + 1);
    const y = new Float64Array(m), w = new Float64Array(m), gap = new Float64Array(Math.max(1, m - 1)), dw = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const s = S[j], nominal = dwellAt(s.st, kind, s.dep);
      dw[j] = j === 0 || j === m - 1 ? 0 : Math.max(nominal, s.dep - s.arr);
      y[j] = j === m - 1 ? s.arr : s.dep; w[j] = j === 0 ? 30 : (s.dep - s.arr > 30 ? 4 : 1);
    }
    // the cross-platform transfer at Pittsburg / Bay Point: the published time is the BART train's. The DMU pulls in
    // about 4 minutes before the BART train leaves, and leaves about 3 minutes after the BART train arrives
    if (kind === 'dmu' && m > 1 && S[m - 1].st === XFER_DMU) { y[m - 1] = S[m - 1].arr - 240; w[m - 1] = 6; }
    if (kind === 'dmu' && S[0].st === XFER_DMU) y[0] = S[0].dep + 180;
    for (let j = 0; j < m - 1; j++) gap[j] = minRun(path, S[j].ps, S[j + 1].ps, kind, l.cars) + dw[j + 1];
    const e = smoothTimes(y, w, gap);
    for (let j = 0; j < m; j++) { S[j].tDep = e[j]; S[j].tArr = j === 0 ? e[j] : e[j] - dw[j]; }
    S[m - 1].tArr = e[m - 1]; S[m - 1].tDep = e[m - 1];
    l.runs = []; for (let j = 0; j < m - 1; j++) l.runs.push({ k: j, t0: S[j].tDep, t1: S[j + 1].tArr, T: S[j + 1].tArr - S[j].tDep, R: null });
    if (!l.prev) l.t0 = S[0].tDep - 240; else l.t0 = l.prev.stops[l.prev.stops.length - 1].tArr;
    l.t1 = l.next ? S[m - 1].tArr : S[m - 1].tArr + 150;
    if (l.prev) { l.t0 = Math.min(l.t0, S[0].tDep); }
  }
  function ymdShift(ymd, days) { const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + days)); return { ymd: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`, wd: d.getUTCDay() }; }
  function replan(force) {
    const sd = Env.serviceDay(); if (!force && sd.ymd === dayKey) return; dayKey = sd.ymd;
    const t0 = performance.now();
    const today = ymdShift(sd.ymd, 0), yest = ymdShift(sd.ymd, -1);
    const svT = servicesOn(today.ymd, today.wd), svY = servicesOn(yest.ymd, yest.wd);
    plans = []; planById = new Map(); busTrips = []; trainObjs.clear();
    for (const t of trips) {
      if (svT.has(t.svc)) { if (t.bus) busTrips.push({ trip: t, dayOff: 0 }); else { const p = planTrip(t, 0, today.wd); if (p) { plans.push(p); planById.set(p.key, p); } } }
      if (svY.has(t.svc) && t.stops[t.stops.length - 1].arr > 86400 - 600) { if (t.bus) busTrips.push({ trip: t, dayOff: -86400 }); else { const p = planTrip(t, -86400, yest.wd); if (p && p.tEnd > -60) { plans.push(p); planById.set(p.key, p); } } }
    }
    linkTurnbacks(); dispatchPlatforms();
    plans.sort((a, b) => a.tStart - b.tStart);
    buildEvents();
    stats.plans = plans.length; stats.replanMs = performance.now() - t0;
  }
  let busTrips = [];
  // turnbacks: a leg that ends at a station and a leg of the same vehicle that starts there soon after, heading the
  // other way, are the same train (terminals, the SFO wye, short turns). Same platform: the train simply waits and
  // changes ends. Different platform: it leaves for the tail track and the other appears from it.
  function linkTurnbacks() {
    const ends = new Map(), starts = new Map();
    for (const p of plans) for (const l of p.legs) {
      if (!l.next) { const s = l.stops[l.stops.length - 1]; const k = s.st + '|' + l.kind; if (!ends.has(k)) ends.set(k, []); ends.get(k).push(l); }
      if (!l.prev) { const s = l.stops[0]; const k = s.st + '|' + l.kind; if (!starts.has(k)) starts.set(k, []); starts.get(k).push(l); }
    }
    for (const [k, E] of ends) {
      const S = (starts.get(k) || []).slice().sort((a, b) => a.stops[0].tDep - b.stops[0].tDep); if (!S.length) continue;
      E.sort((a, b) => a.stops[a.stops.length - 1].tArr - b.stops[b.stops.length - 1].tArr);
      const used = new Set();
      for (const a of E) {
        const ta = a.stops[a.stops.length - 1].tArr, sida = a.stops[a.stops.length - 1].sid;
        let best = null;
        for (const b of S) { if (used.has(b) || b.plan === a.plan) continue; const tb = b.stops[0].tDep; if (tb < ta + 100) continue; if (tb > ta + 40 * 60) break;
          if (!best) best = b; if (b.stops[0].sid === sida) { if (best.stops[0].sid !== sida || tb < best.stops[0].tDep) best = b; break; } }
        if (!best) continue;
        if (best.stops[0].sid !== sida && best.stops[0].tDep > ta + 25 * 60) continue;
        used.add(best); a.turn = best; best.from = a; best.cars = a.cars;
        const same = !!sida && best.stops[0].sid === sida;
        a.sameTurn = best.sameTurn = same;
        if (same) { alignStart(a, best); timeLeg(best); a.t1 = best.stops[0].tDep; best.t0 = a.t1; }
        else { a.t1 = Math.min(a.t1, ta + 150); best.t0 = Math.max(best.t0, best.stops[0].tDep - 240); }
      }
    }
    // physical trains: leads and identities along the chains (a reversal or a same-platform turnback swaps the ends)
    const all = []; for (const p of plans) for (const l of p.legs) all.push(l);
    all.sort((a, b) => a.stops[0].tDep - b.stops[0].tDep);
    for (const l of all) {
      const pre = l.prev || (l.sameTurn ? l.from : null);
      if (pre) { l.lead = 1 - pre.lead; l.chainKey = pre.chainKey; l.cars = pre.cars; }
      else { l.lead = 0; l.chainKey = l.plan.key + (l.idx ? '#' + l.idx : ''); }
    }
  }
  // at most one train per platform at a time: terminal layovers end before the next train arrives there
  function dispatchPlatforms() {
    const byPlat = new Map();
    for (const p of plans) for (const l of p.legs) {
      const a = l.stops[l.stops.length - 1], b = l.stops[0];
      const addE = (sid, tIn, tOut, kind, leg) => { if (!sid) return; if (!byPlat.has(sid)) byPlat.set(sid, []); byPlat.get(sid).push({ tIn, tOut, kind, leg }); };
      addE(b.sid, l.t0, b.tDep, 'start', l); addE(a.sid, a.tArr, l.t1, 'end', l);
      for (let j = 1; j < l.stops.length - 1; j++) addE(l.stops[j].sid, l.stops[j].tArr - 25, l.stops[j].tDep + 10, 'mid', l);
    }
    for (const [sid, ev] of byPlat) {
      ev.sort((x, y) => x.tIn - y.tIn);
      for (let i = 0; i < ev.length - 1; i++) {
        const a = ev[i], b = ev[i + 1];
        if (a.tOut > b.tIn - 20 && a.leg !== b.leg && !(a.leg.turn === b.leg && a.leg.sameTurn)) {
          if (a.kind === 'end') a.leg.t1 = Math.max(a.leg.stops[a.leg.stops.length - 1].tArr + 30, b.tIn - 20);
          else if (b.kind === 'start') b.leg.t0 = Math.min(b.leg.stops[0].tDep - 45, Math.max(b.leg.t0, a.tOut + 20));
        }
      }
    }
    for (const p of plans) { p.tStart = Math.min(...p.legs.map(l => l.t0)); p.tEnd = Math.max(...p.legs.map(l => l.t1)); }
  }
  function buildEvents() {
    stopEvents = new Map();
    for (const p of plans) for (const l of p.legs) for (let k = 0; k < l.stops.length; k++) {
      const s = l.stops[k]; const last = k === l.stops.length - 1 && !l.next;
      if (!stopEvents.has(s.st)) stopEvents.set(s.st, []);
      stopEvents.get(s.st).push({ t: last ? s.tArr : s.tDep, arr: s.tArr, dep: s.tDep, pub: (last ? p.trip.stops[s.i].arr : p.trip.stops[s.i].dep) + p.dayOff, plan: p, leg: l, k, last, sid: s.sid });
    }
    for (const L of stopEvents.values()) L.sort((a, b) => a.t - b.t);
  }

  // ---------------------------------------------------------------- state of a plan at time t
  const RS = {};
  function legAt(p, t) { let best = null; for (const l of p.legs) if (t >= l.t0 && t <= l.t1) { best = l; } return best; }
  // fills o: ps (head position on the leg path), v, a, stopK (index of the stop the train is at, or -1), nextK, doorT, phase
  function legState(l, t, o) {
    const S = l.stops, m = S.length; o.leg = l; o.stopK = -1; o.doorT = 0; o.dwellLeft = 0; o.a = 0;
    if (t <= S[0].tDep) { o.ps = S[0].ps; o.v = 0; o.stopK = 0; o.nextK = 1; o.phase = 'origin';
      const open = (l.sameTurn && l.from) ? 1 : clamp((t - l.t0 - 8) / 2.5, 0, 1); o.doorT = Math.min(open, clamp((S[0].tDep - 4 - t) / 2.5, 0, 1)); o.dwellLeft = S[0].tDep - t; return o; }
    if (t >= S[m - 1].tArr) { o.ps = S[m - 1].ps; o.v = 0; o.stopK = m - 1; o.nextK = m - 1; o.phase = 'terminal';
      const opened = clamp((t - S[m - 1].tArr - 2.5) / 2.5, 0, 1); const shut = l.sameTurn ? 1 : clamp((S[m - 1].tArr + 75 - t) / 2.5, 0, 1);
      o.doorT = Math.min(opened, shut); if (l.sameTurn && l.turn) o.doorT = opened; return o; }
    // between: find the run (binary search on departure times)
    const R = l.runs; let lo = 0, hi = R.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (R[mid].t0 <= t) lo = mid; else hi = mid - 1; }
    const run = R[lo];
    if (t >= run.t1) {                                     // dwelling at stop k+1
      const k = lo + 1, s = S[k]; o.ps = s.ps; o.v = 0; o.stopK = k; o.nextK = k + 1; o.phase = 'dwell';
      o.doorT = Math.min(clamp((t - s.tArr - 2.5) / 2.5, 0, 1), clamp((s.tDep - 3.5 - t) / 2.5, 0, 1)); o.dwellLeft = s.tDep - t; return o;
    }
    if (!run.R) run.R = getRun(l.path, S[lo].ps, S[lo + 1].ps, l.kind, l.cars, run.T);
    runAt(run.R, t - run.t0, RS); o.ps = RS.ps; o.v = RS.v; o.a = RS.a; o.nextK = lo + 1; o.phase = 'run'; o.runK = lo;
    return o;
  }

  // ---------------------------------------------------------------- consists: MetroKit when present, else a placeholder
  const Placeholder = (() => {
    const mats = {};
    function mat(kind) {
      if (mats[kind]) return mats[kind];
      const body = new THREE.MeshStandardMaterial({ color: kind === 'dmu' ? 0xe8ecef : 0xdfe3e6, metalness: 0.55, roughness: 0.35 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x15181c, metalness: 0.2, roughness: 0.25, emissive: 0xffe2b0, emissiveIntensity: 0 });
      const stripe = new THREE.MeshStandardMaterial({ color: kind === 'oak' ? 0x8fa3ad : 0x2a6fb5, roughness: 0.45 });
      const under = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.8 });
      return (mats[kind] = { body, dark, stripe, under });
    }
    const geo = {};
    function carGeo(L, W, H, cab) {
      const k = L + '|' + W + '|' + H + '|' + cab; if (geo[k]) return geo[k];
      const g = { body: new THREE.BoxGeometry(L - 0.6, H - 1.05, W), win: new THREE.BoxGeometry(L - 1.4, 0.95, W + 0.04), stripe: new THREE.BoxGeometry(L - 0.8, 0.16, W + 0.03), under: new THREE.BoxGeometry(L - 4, 0.55, W - 0.5) };
      if (cab) { const n = new THREE.CylinderGeometry(H * 0.42, H * 0.48, W - 0.1, 16, 1, false, 0, Math.PI); n.rotateX(Math.PI / 2); n.rotateY(-Math.PI / 2); g.nose = n; }
      return (geo[k] = g);
    }
    function create(kind, opts = {}) {
      const n = kind === 'bart' ? (opts.cars || 10) : kind === 'dmu' ? 2 : 3;
      const L = kind === 'bart' ? 21.34 : kind === 'dmu' ? 40.9 : 12.2, W = kind === 'oak' ? 2.6 : 3.2, H = kind === 'oak' ? 3.0 : 3.35, FL = kind === 'oak' ? 0.35 : 0.99;
      const M = mat(kind), cars = []; let off = 0;
      for (let i = 0; i < n; i++) {
        const cab = i === 0 || i === n - 1, g = new THREE.Group(), inner = new THREE.Group(); g.add(inner); if (i === n - 1 && n > 1) inner.rotation.y = Math.PI;
        const G = carGeo(L, W, H, cab);
        const b = new THREE.Mesh(G.body, M.body); b.position.y = 1.05 + (H - 1.05) / 2; b.castShadow = true; inner.add(b);
        const w = new THREE.Mesh(G.win, M.dark); w.position.y = FL + 1.55; inner.add(w);
        const s = new THREE.Mesh(G.stripe, M.stripe); s.position.y = FL + 0.75; inner.add(s);
        const u = new THREE.Mesh(G.under, M.under); u.position.y = 0.55; inner.add(u);
        if (G.nose) { const nz = new THREE.Mesh(G.nose, M.body); nz.position.set(L / 2 - 0.35, 1.05 + (H - 1.05) * 0.45, 0); nz.scale.set(0.35, 1, 1); inner.add(nz); }
        const flip = i === n - 1 && n > 1 ? -1 : 1;
        const doorsX = kind === 'bart' ? [-7.0, 0, 7.0] : kind === 'dmu' ? [-12.5, 12.5] : [0];
        const doors = []; for (const x of doorsX) for (const side of [1, -1]) doors.push({ x: x * flip, side, width: 1.3, sillY: FL });
        const seats = []; for (let x = -9.5; x <= 9.5; x += 1.6) { if (doorsX.some(d => Math.abs(d - x) < 1.2)) continue; for (const z of [-1.0, 1.0]) seats.push({ x, y: FL + 1.18, z, yaw: x < 0 ? 0 : Math.PI }); }
        const car = { group: g, index: i, type: cab ? 'D' : 'E', length: L, width: W, height: H, offset: off + L / 2, number: 'BM ' + (1000 + i),
          bogieOffsets: [L / 2 - 3.2, -(L / 2 - 3.2)], floorRegions: [{ name: 'floor', x0: -L / 2 + (cab && flip > 0 ? 0.6 : 0.6), x1: L / 2 - (cab && flip > 0 ? 2.2 : 0.6), z0: -W / 2 + 0.25, z1: W / 2 - 0.25, y: FL }],
          ramps: [], gangways: { front: null, rear: null }, seats, doors, cabEye: cab ? (flip > 0 ? [L / 2 - 1.3, FL + 1.25, -0.55] : [-(L / 2 - 1.3), FL + 1.25, 0.55]) : null };
        g.rotation.order = 'YZX'; cars.push(car); off += L;
      }
      const noop = () => {};
      return { kind, cars, length: off, speed: 0, placeholder: true, setDestination: noop, setDoors: noop, setLights: noop, setLeadEnd: noop, setNight(nv) { M.dark.emissiveIntensity = 0.25 * nv; }, setDisplay: noop, setCab: noop,
        setInteriorVisible: noop, setLOD: noop, update: noop };
    }
    return { create };
  })();
  const pool = []; const POOLMAX = { bart: 8, dmu: 2, oak: 3 };
  function makeConsist(kind, cars, seed) {
    let c = null;
    if (typeof MetroKit !== 'undefined' && MetroKit.createConsist) { try { c = MetroKit.createConsist(kind, { cars, seed, name: 'metro' }); } catch (e) { console.error('MetroKit', kind, e); c = null; } }
    if (!c) c = Placeholder.create(kind, { cars });
    for (const car of c.cars) { car.group.rotation.order = 'YZX'; car.group.visible = false; Env.scene.add(car.group); }
    return { consist: c, kind, cap: c.cars.length, busy: false, key: '', dest: '', lod: -1, iv: null, shown: 0 };
  }
  function acquire(kind, key, cars) {
    for (const e of pool) if (!e.busy && e.key === key && e.kind === kind && e.cap >= cars) { e.busy = true; return e; }
    let spare = null; for (const e of pool) if (!e.busy && e.kind === kind && e.cap >= cars && (!spare || e.cap < spare.cap)) spare = e;
    if (spare) { spare.busy = true; spare.key = key; spare.dest = ''; spare.shown = -1; return spare; }
    if (pool.filter(e => e.kind === kind).length >= (POOLMAX[kind] || 4)) return null;
    const e = makeConsist(kind, kind === 'bart' ? 10 : cars, pool.length * 7 + 3); pool.push(e); e.busy = true; e.key = key; return e;
  }
  // which cars of a (up to) 10-car consist make an n-car train: both cab cars and the first n-2 middle cars
  const carSets = new Map();
  function carSet(cap, n) { const k = cap * 100 + n; if (carSets.has(k)) return carSets.get(k); const a = [];
    if (n >= cap) for (let i = 0; i < cap; i++) a.push(i); else { a.push(0); for (let i = 1; i <= n - 2; i++) a.push(i); a.push(cap - 1); } carSets.set(k, a); return a; }

  // pose a consist: head (front coupler of the leading car) at path position ps, cars trailing back along the path
  const PF = {}, PR = {};
  function poseConsist(e, path, ps, lead, nCars) {
    const cs = e.consist.cars, set = carSet(cs.length, nCars), order = set;
    const n = order.length; let acc = ps;
    for (let j = 0; j < n; j++) {
      const ci = lead === 0 ? order[j] : order[n - 1 - j], car = cs[ci];
      const L = car.length, c = acc - L / 2, sg = lead === 0 ? 1 : -1;     // +X of the car along travel (lead 0) or against it
      const bf = car.bogieOffsets[0], br = car.bogieOffsets[1];
      path.at(c + sg * bf, PF); path.at(c + sg * br, PR);
      const roll = ((PF.cant || 0) + (PR.cant || 0)) * 0.5 * sg;
      if (typeof TrainKit !== 'undefined' && TrainKit.poseCar) TrainKit.poseCar(car, PF, PR, roll);
      else { const dx = PF.x - PR.x, dy = PF.y - PR.y, dz = PF.z - PR.z, h = Math.hypot(dx, dz) || 1e-9, len = Math.hypot(h, dy), xm = (bf + br) / 2;
        car.group.rotation.set(roll, Math.atan2(-dz, dx), Math.atan2(dy, h), 'YZX'); car.group.position.set((PF.x + PR.x) / 2 - dx / len * xm, (PF.y + PR.y) / 2 - dy / len * xm, (PF.z + PR.z) / 2 - dz / len * xm); }
      if (car.setBogies) car.setBogies(PF, PR);
      car.group.visible = true; acc -= L;
    }
    if (set) for (let i = 0; i < cs.length; i++) if (!set.includes(i)) cs[i].group.visible = false;
    return acc;                                               // path position of the tail
  }

  // ---------------------------------------------------------------- far trains: one instanced batch + light points + dots
  let far = null, lights = null, dots = null; const FARMAX = 1600, LMAX = 800, DMAX = 400;
  function initFar() {
    const g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0);
    const m = new THREE.MeshStandardMaterial({ color: 0xdadfe3, metalness: 0.5, roughness: 0.4 });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = U.uNight;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vFarY;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvFarY = position.y;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFarY;\nuniform float uNight;')
        .replace('#include <color_fragment>', `
          #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
            float bStripe = smoothstep(0.30, 0.32, vFarY) * (1.0 - smoothstep(0.37, 0.39, vFarY));
            float bWin = smoothstep(0.45, 0.47, vFarY) * (1.0 - smoothstep(0.74, 0.76, vFarY));
            diffuseColor.rgb = mix(diffuseColor.rgb, vColor, bStripe);
            diffuseColor.rgb *= mix(1.0, 0.16, bWin);
            float bLit = bWin * uNight;
          #else
            float bLit = 0.0;
          #endif`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.86, 0.62) * bLit * 1.6;');
    };
    m.customProgramCacheKey = () => 'metro-far-1';
    far = new THREE.InstancedMesh(g, m, FARMAX); far.count = 0; far.frustumCulled = false; far.castShadow = false;
    far.setColorAt(0, new THREE.Color(1, 1, 1)); Env.scene.add(far);
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LMAX * 3), 3)); lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(LMAX * 3), 3));
    lights = new THREE.Points(lg, new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, vertexColors: true, depthWrite: false, transparent: true, opacity: 0.95, fog: false, blending: THREE.AdditiveBlending }));
    lights.frustumCulled = false; lights.renderOrder = 4; Env.scene.add(lights);
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DMAX * 3), 3)); dg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(DMAX * 3), 3));
    dots = new THREE.Points(dg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthWrite: false, depthTest: false, transparent: true, opacity: 0.95, fog: false }));
    dots.frustumCulled = false; dots.renderOrder = 6; Env.scene.add(dots);
  }
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YZX'), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

  // ---------------------------------------------------------------- per-frame
  const running = [];                       // train objects this frame (reused per key)
  const trainObjs = new Map();
  let focusKey = null, drive = null;
  const stats = { plans: 0, running: 0, consists: 0, far: 0, ms: 0, replanMs: 0, runs: 0 };
  const LS = {}, HF = {};
  function trainObj(key) { let o = trainObjs.get(key); if (!o) { o = { key, metro: true, v: 0, a: 0, s: 0, dir: 1, x: 0, y: 0, z: 0, hx: 1, hz: 0, dist: 1e9 }; trainObjs.set(key, o); } return o; }
  function lineColor(id) { const l = lineById.get(id); return l ? l.color : '#cccccc'; }
  function isUnder(st) { return st === 'bored' || st === 'cutcover' || st === 'tube' || st === 'subway' || st === 'tunnel' || st === 'underground'; }
  function update(dt, camPos) {
    if (!enabled || !ready) return;
    const T0 = performance.now(); frameNo++;
    replan();
    const t = Env.time.sec; running.length = 0;
    for (const p of plans) {
      if (p.tStart > t + 1) break; if (p.tEnd < t) continue;
      const l = legAt(p, t); if (!l) continue;
      if (drive && l.chainKey === drive.key) continue;
      legState(l, t, LS);
      const tr = trainObj(l.chainKey || p.key);
      if (tr._frame === frameNo) continue;                    // (a turnback shows once, as the leg that owns the platform)
      tr._frame = frameNo; fillTrain(tr, p, l, LS, t); running.push(tr);
    }
    if (drive) { const D = drive; driveStepAll(dt); const tr = trainObj(D.key); tr._frame = frameNo; fillDriven(tr, D, t); running.unshift(tr); }
    netOthers(t);
    // world position of every head + distance to the camera
    for (const tr of running) { tr.leg.path.at(tr.s, HF); tr.x = HF.x; tr.y = HF.y; tr.z = HF.z; const hl = Math.hypot(HF.tx, HF.tz) || 1; tr.hx = HF.tx / hl; tr.hz = HF.tz / hl;
      tr.underground = isUnder(HF.st || HF.struct); tr.dist = Math.hypot(HF.x - camPos.x, HF.z - camPos.z, (HF.y - camPos.y) * 0.5); tr.lim = HF.lim; }
    running.sort((a, b) => (b.key === focusKey) - (a.key === focusKey) || a.dist - b.dist);
    for (const e of pool) e.busy = false;
    const night = U.uNight.value, maxNear = nearBudget();
    let nNear = 0, fN = 0, lN = 0, dN = 0;
    const fp = far.instanceMatrix.array, lp = lights.geometry.attributes.position.array, lc = lights.geometry.attributes.color.array, dp = dots.geometry.attributes.position.array, dc = dots.geometry.attributes.color.array;
    const camUnder = typeof Terrain !== 'undefined' && camPos.y < Terrain.h(camPos.x, camPos.z) - 3;
    for (const tr of running) {
      const near = tr.key === focusKey || tr.driven || (nNear < maxNear && tr.dist < 2600);
      const e = near ? acquire(tr.kind, tr.key, tr.cars) : null; tr.entry = e;
      if (e) { nNear++; tr.tailS = poseConsist(e, tr.leg.path, tr.s, tr.lead, tr.cars); setupConsist(tr, e, dt, night); }
      else if (tr.dist < 60000 && !(camUnder && tr.underground)) {
        // far: one instance per car, posed at its centre along the path (cars beyond 12 km are merged in pairs)
        const P = PERF[tr.kind], pair = tr.dist > 12000 && tr.cars > 3 ? 2 : 1, n = Math.ceil(tr.cars / pair), L = P.carLen * pair;
        _c.set(lineColor(tr.line));
        for (let i = 0; i < n && fN < FARMAX; i++) {
          tr.leg.path.at(tr.s - (i + 0.5) * L, F1); const h = Math.hypot(F1.tx, F1.tz) || 1;
          _e.set(0, Math.atan2(-F1.tz, F1.tx), Math.atan2(F1.ty, h)); _q.setFromEuler(_e);
          _m4.compose(_p.set(F1.x, F1.y + 0.95, F1.z), _q, _s.set(L - 0.9, tr.kind === 'oak' ? 2.6 : 2.45, tr.kind === 'oak' ? 2.6 : 3.2));
          _m4.toArray(fp, fN * 16); far.setColorAt(fN, _c); fN++;
        }
        if (night > 0.05 && lN < LMAX - 2 && !tr.underground) {       // head and tail lamps, read as a line of light at night
          tr.leg.path.at(tr.s - tr.cars * P.carLen, F1);
          lp[lN * 3] = tr.x; lp[lN * 3 + 1] = tr.y + 1.4; lp[lN * 3 + 2] = tr.z; lc[lN * 3] = 1; lc[lN * 3 + 1] = 0.95; lc[lN * 3 + 2] = 0.85; lN++;
          lp[lN * 3] = F1.x; lp[lN * 3 + 1] = F1.y + 1.4; lp[lN * 3 + 2] = F1.z; lc[lN * 3] = 0.9; lc[lN * 3 + 1] = 0.08; lc[lN * 3 + 2] = 0.05; lN++;
        }
      }
      if (dN < DMAX) { dp[dN * 3] = tr.x; dp[dN * 3 + 1] = tr.y + 14; dp[dN * 3 + 2] = tr.z; _c.set(tr.remote ? (tr.remote.color || '#ffffff') : lineColor(tr.line)); dc[dN * 3] = _c.r; dc[dN * 3 + 1] = _c.g; dc[dN * 3 + 2] = _c.b; dN++; }
    }
    for (const e of pool) if (!e.busy && e.shown !== 0) { for (const car of e.consist.cars) car.group.visible = false; e.shown = 0; }
    far.count = fN; far.instanceMatrix.needsUpdate = true; if (far.instanceColor) far.instanceColor.needsUpdate = true;
    lights.geometry.setDrawRange(0, lN); lights.geometry.attributes.position.needsUpdate = true; lights.geometry.attributes.color.needsUpdate = true; lights.material.opacity = 0.95 * U.smooth(0.05, 0.5, night);
    dots.geometry.setDrawRange(0, dN); dots.geometry.attributes.position.needsUpdate = true; dots.geometry.attributes.color.needsUpdate = true;
    const alt = camPos.y - (typeof Terrain !== 'undefined' ? Terrain.h(camPos.x, camPos.z) : 0); dots.visible = alt > 350; dots.material.opacity = U.smooth(350, 1200, alt);
    stats.running = running.length; stats.consists = nNear; stats.far = fN; stats.runs = runCache.size;
    stats.ms = stats.ms * 0.95 + (performance.now() - T0) * 0.05;
  }
  let quality = 'high';
  function nearBudget() { return quality === 'low' ? 4 : quality === 'medium' ? 6 : 8; }
  function fillTrain(tr, p, l, S, t) {
    tr.plan = p; tr.trip = p.trip; tr.leg = l; tr.kind = l.kind; tr.cars = l.cars; tr.line = p.line;
    tr.s = S.ps; tr.v = S.v; tr.a = S.a; tr.phase = S.phase; tr.stopK = S.stopK; tr.nextK = S.nextK; tr.dwellLeft = S.dwellLeft;
    tr.lead = l.lead; tr.dir = l.lead === 0 ? 1 : 0; tr.driven = false; tr.remote = null;
    tr.len = l.cars * PERF[l.kind].carLen; tr.doorT = S.doorT;
    const st = S.stopK >= 0 ? l.stops[S.stopK] : null;
    tr.stationId = st ? st.st : null;
    // doors open on the platform side: travel-relative side from the platform data (default: right), then car-local
    const trav = st && st.side ? (st.side > 0 ? 1 : -1) : 1;
    tr.doorSide = (trav > 0) === (l.lead === 0) ? 'right' : 'left';
    tr.doorsOpen = S.doorT > 0.6;
  }

  function setupConsist(tr, e, dt, night) {
    const c = e.consist;
    const dest = destText(tr); if (e.dest !== dest) { c.setDestination(dest, lineColor(tr.line)); e.dest = dest; }
    c.setDoors(tr.doorT > 0 ? tr.doorSide : 'none', tr.doorT);
    const lead = tr.lead === 0 ? 'front' : 'rear';
    c.setLights({ head: 1, tail: 1, interior: 0.5 + 0.5 * night, cab: 0.5, lead }); if (c.setLeadEnd) c.setLeadEnd(lead);
    c.setNight(night);
    c.speed = tr.lead === 0 ? tr.v : -tr.v;
    const lod = tr.dist < 180 ? 0 : tr.dist < 700 ? 1 : 2; if (e.lod !== lod) { c.setLOD(lod); e.lod = lod; }
    const inside = tr.key === focusKey && typeof Player !== 'undefined' && (Player.onboard() || Player.inCab());
    const iv = inside || tr.dist < 60; if (e.iv !== iv) { c.setInteriorVisible(iv); e.iv = iv; }
    if (tr.key === focusKey || tr.dist < 250) c.setDisplay && c.setDisplay({ line: lineName(tr.line), color: lineColor(tr.line), nextStop: nextStopName(tr), destination: termName(tr), clock: Env.clockText(Env.time.sec) });
    if (tr.key === focusKey && typeof MetroATC !== 'undefined' && MetroATC.cabDisplay) { const cd = MetroATC.cabDisplay(tr); if (cd && c.setCab) c.setCab(cd); }
    c.update(dt); e.shown = 1;
    if (typeof MetroPax !== 'undefined') MetroPax.update(e, tr);
  }
  // names
  function lineName(id) { const l = lineById.get(id); return l ? l.name : id; }
  function stName(id) { const s = stById.get(id); return s ? s.short : id; }
  function termName(tr) { const l = tr.leg; let x = l; while (x.next) x = x.next; if (x.turn && x.sameTurn && !tr.driven && tr.phase === 'terminal') x = x.turn; const S = x.stops; return stName(S[S.length - 1].st); }
  function destText(tr) { return termName(tr).toUpperCase(); }
  function nextStopName(tr) { const S = tr.leg.stops; const k = tr.phase === 'terminal' ? -1 : tr.nextK; return k >= 0 && S[k] ? stName(S[k].st) : ''; }

  // ---------------------------------------------------------------- player-driven train (physics; ATC lives in 47_metroatc.js)
  function startDrive(plan, opts = {}) {
    const t = Env.time.sec; let l = legAt(plan, t) || plan.legs.find(x => x.kind !== 'dmu') || plan.legs[0];
    if (opts.leg !== undefined) l = plan.legs[opts.leg] || l;
    legState(l, t, LS);
    drive = { plan, leg: l, trip: plan.trip, key: l.chainKey || plan.key, kind: l.kind, cars: l.cars, s: LS.ps, v: LS.v, lever: 0, tract: 0, brk: 0, acc: 0, jerk: 0, emergency: false, penalty: false,
      doors: LS.doorT, doorsTarget: LS.doorT > 0.5 ? 1 : 0, doorSideNow: 'right', odometer: 0, auto: !!opts.auto, reverse: false, lead: l.lead, ato: opts.ato !== false, mode: 'ato', stopK: LS.stopK };
    // (the running list is rebuilt next frame from before any clock jump: put the driven train in right now)
    const tr = trainObj(drive.key); tr._frame = frameNo; fillDriven(tr, drive, t);
    for (let i = running.length - 1; i >= 0; i--) if (running[i].key === drive.key) running.splice(i, 1);
    running.unshift(tr); tr.leg.path.at(tr.s, HF); tr.x = HF.x; tr.y = HF.y; tr.z = HF.z; const hl = Math.hypot(HF.tx, HF.tz) || 1; tr.hx = HF.tx / hl; tr.hz = HF.tz / hl; tr.dist = 0;
    return drive;
  }
  function stopDrive() { drive = null; }
  function fillDriven(tr, D, t) {
    tr.plan = D.plan; tr.trip = D.trip; tr.leg = D.leg; tr.kind = D.kind; tr.cars = D.cars; tr.line = D.plan.line; tr.s = D.s; tr.v = D.v; tr.a = D.acc;
    tr.lead = D.lead; tr.dir = D.lead === 0 ? 1 : 0; tr.driven = true; tr.remote = null; tr.len = D.cars * PERF[D.kind].carLen; tr.doorT = D.doors;
    tr.phase = D.v > 0.05 ? 'run' : 'stopped'; tr.stopK = D.atK !== undefined ? D.atK : -1; tr.nextK = D.nextK !== undefined ? D.nextK : 1; tr.stationId = D.atSt || null;
    tr.doorSide = D.doorSideNow; tr.doorsOpen = D.doors > 0.6;
  }
  // physics of the driven train: traction / brake demand from the lever, jerk-limited, grade and resistance, doors
  function driveStep(D, h) {
    const P = PERF[D.kind], v = D.v, doorsClosed = D.doors < 0.01;
    let tDem = (D.lever > 0 && !D.emergency && !D.penalty && doorsClosed) ? tractA(P, v) * D.lever : 0;
    if (D.reverse && v > 2.2) tDem = 0;
    let bDem = D.lever < 0 ? -D.lever * P.bFull : 0;
    if (D.atcBrake) bDem = Math.max(bDem, D.atcBrake);
    if (D.penalty) bDem = Math.max(bDem, P.bFull);
    if (!doorsClosed && v < 0.5) bDem = Math.max(bDem, 0.5);
    const step = (cur, dem, r) => cur + clamp(dem - cur, -r * h, r * h);
    D.tract = (D.penalty || D.emergency) ? 0 : step(D.tract, tDem, 1.1);
    D.brk = D.emergency ? step(D.brk, P.bEm, 4.0) : step(D.brk, bDem, 1.4);
    D.leg.path.at(D.s, F0); const grade = (F0.ty || 0) * (D.reverse ? -1 : 1);
    let vn = v + (D.tract - 9.81 * grade - resist(P, v)) * h - D.brk * h; if (vn < 0) vn = 0;
    const acc = (vn - v) / h, sm = D.accS === undefined ? acc : D.accS + (acc - D.accS) * Math.min(1, h * 5);
    D.jerk = Math.abs(sm - (D.accS === undefined ? sm : D.accS)) / h; D.accS = sm; D.acc = sm;
    const ds = (v + vn) / 2 * h; D.s += (D.reverse ? -1 : 1) * ds; D.odometer += ds; D.v = vn;
    const L = D.leg.path.length; if (D.s > L - 0.3) { D.s = L - 0.3; D.v = 0; } if (D.s < D.cars * P.carLen) { D.s = Math.max(D.s, 0.5); }
    const r = h / 2.6; D.doors = clamp(D.doors + (D.doorsTarget > D.doors ? r : -r), 0, 1);
  }
  function driveStepAll(dt) {
    let rem = Env.time.paused ? 0 : dt * Env.time.scale;
    while (rem > 1e-6) { const h = Math.min(rem, 0.05); if (typeof MetroATC !== 'undefined' && MetroATC.supervise) MetroATC.supervise(drive, h); driveStep(drive, h); rem -= h; }
  }
  // change to the next leg of the same train (after a reversal: the cab moves to the other end)
  function driveNextLeg() {
    const D = drive; if (!D || !D.leg.next) return false;
    const nl = D.leg.next; D.leg = nl; D.lead = 1 - D.lead; D.s = nl.stops[0].ps; D.v = 0; D.lever = 0; nl.lead = D.lead;
    return true;
  }

  // ---------------------------------------------------------------- multiplayer: other people's driven metro trains
  function netOthers(t) {
    if (typeof Net === 'undefined') return;
    for (const o of Net.others()) {
      if (o.modeName !== 'mdrive') continue;
      const tr = running.find(r => r.trip && r.trip.id === o.trip && !r.driven);
      if (tr) { tr.s = o.s; tr.v = Math.abs(o.speed); tr.remote = o; }
    }
  }

  // ---------------------------------------------------------------- queries for the UI, the player and the boards
  // next trains at a station: [{ t, pub, plan, leg, k, line, color, dest, cars, sid, last, min }]
  function arrivals(stId, now, n = 12, opts = {}) {
    const L = stopEvents.get(stId) || [], out = [];
    for (const ev of L) { if (ev.t < now - (opts.past || 20)) continue; if (ev.last && !opts.withLast) continue; if (opts.filter && !opts.filter(ev)) continue;
      out.push(ev); if (out.length >= n) break; }
    return out;
  }
  function eventInfo(ev) {
    const l = ev.leg; let x = l; while (x.next) x = x.next;
    return { line: ev.plan.line, color: lineColor(ev.plan.line), lineName: lineName(ev.plan.line), dest: stName(x.stops[x.stops.length - 1].st), cars: l.cars, kind: l.kind, sid: ev.sid, platform: (ev.sid || '').split('-')[1] || '' };
  }
  function trainByKey(key) { return running.find(r => r.key === key) || running.find(r => r.plan && r.plan.key === key) || null; }
  function nearestTrain(pos, maxD = 1e9, filter) { let best = null, bd = maxD; for (const tr of running) { if (filter && !filter(tr)) continue; const d = Math.hypot(tr.x - pos.x, tr.z - pos.z); if (d < bd) { bd = d; best = tr; } } return best; }
  function nearestStation(pos, maxD = 1e9) { let best = null, bd = maxD; for (const s of stations) { const d = Math.hypot(s.x - pos.x, s.z - pos.z); if (d < bd) { bd = d; best = s; } } return best; }
  function planFor(tripId) { return planById.get('M:' + tripId) || planById.get('M:' + tripId + '@y') || null; }
  function freeSeat(tr, ci, si) { const car = tr && tr.entry && tr.entry.consist.cars[ci]; if (car && car._pax && car._paxSeat) { const k = car._paxSeat.indexOf(si); if (k >= 0) { car._pax.hide(k); car._paxSeat[k] = -1; } } }
  // live mode (47_metrolive.js): replace a trip's targets with predicted times and replan just that trip
  function applyLive(tripId, times) {
    const p = planFor(tripId); if (!p) return false;
    const trip = { ...p.trip, stops: p.trip.stops.map((s, i) => times[i] ? { ...s, arr: times[i].arr - p.dayOff, dep: times[i].dep - p.dayOff } : s) };
    const sd = Env.serviceDay(); const np = planTrip(trip, p.dayOff, ymdShift(sd.ymd, p.dayOff ? -1 : 0).wd); if (!np) return false;
    np.live = true; np.trip = p.trip; np.key = p.key;
    for (let i = 0; i < np.legs.length && i < p.legs.length; i++) { const a = p.legs[i], b = np.legs[i]; b.lead = a.lead; b.cars = a.cars; b.turn = a.turn; b.from = a.from; b.sameTurn = a.sameTurn; b.chainKey = a.chainKey;
      if (a.from && a.sameTurn) b.t0 = Math.min(b.t0, a.t0); if (a.turn) b.t1 = a.sameTurn ? Math.max(b.t1, a.t1) : b.t1; }
    const idx = plans.indexOf(p); if (idx >= 0) plans[idx] = np; planById.set(np.key, np);
    np.tStart = Math.min(...np.legs.map(l => l.t0)); np.tEnd = Math.max(...np.legs.map(l => l.t1));
    plans.sort((a, b) => a.tStart - b.tStart); return true;
  }

  async function init() {
    if (!enabled) return false;
    if (loading) return loading;
    loading = (async () => {
      try {
        await loadData(); initFar(); replan(true); ready = true;
        console.log(`MetroSim: ${stations.length} stations, ${lines.length} lines, ${trips.length} trips, ${plans.length} planned today (${stats.replanMs.toFixed(0)} ms)`);
      } catch (e) { loadError = e; console.error('MetroSim init', e); }
      return ready;
    })();
    return loading;
  }

  return { enabled, init, update, setQuality(q) { quality = q; }, get ready() { return ready; }, get error() { return loadError; }, running, trainByKey, nearestTrain, nearestStation, planFor, freeSeat, arrivals, eventInfo,
    owns: (k) => typeof k === 'string' && k.startsWith('M:'), setFocus(k) { focusKey = k; }, get focus() { return focusKey; },
    startDrive, stopDrive, driveNextLeg, get drive() { return drive; }, applyLive,
    stations, stById, lines, lineById, lineName, lineColor, stName, destText, termName, nextStopName, PERF, MPH,
    get plans() { return plans; }, get busTrips() { return busTrips; }, get stats() { return stats; }, get net() { return MN; },
    legState, legAt, getRun, runAt, smoothTimes, envelope, timeOf, MPath, servicesOn,
    replan: () => replan(true) };
})();
