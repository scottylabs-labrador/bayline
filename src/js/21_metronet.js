// MetroNet: the Bayline Metro network at runtime (every track, junction, station, line pattern and the timetable of the
// real system), loaded from DATA/metro/ (network.json + tracks.bin, timetable.json on demand). Format and field meanings:
// notes/bart-data.md (the contract). Frame: the Bay frame (x east, z south, y metres above sea level at top of rail).
// No dependencies (no THREE, no U): works in the game and in plain preview pages (preview/metronet.html).
//   await MetroNet.load({ base })            base defaults to the game's data root (Stream) or './data/v2/'
//   MetroNet.tracks / byId / stations / stationById / lines / patterns / junctions
//   MetroNet.frame(trackOrId, s, out)        -> out {x,y,z, tx,ty,tz, rx,ry,rz, ux,uy,uz, grade, cant, bank, curv, struct, structName, vlim, cover, s, track}
//   MetroNet.nearest(x, z, maxR, filter)     -> {track, s, dist, lat} | null      (lat > 0: right of +s)
//   MetroNet.pathFor(line, dir, pattern)     -> {id, line, dir, legs:[Leg]}       Leg: {length, segs, stops, frame(d,out), locate(d)}
//   MetroNet.stationsNear(x, z, r)           -> [{station, dist}] nearest first
//   MetroNet.inTunnelAt(x, y, z)             -> {kind:'tunnel'|'station', track, s, struct, station?} | null
//   await MetroNet.loadTimetable()           MetroNet.servicesOn(ymd) / tripsOn(ymd) / trip(id)
const MetroNet = (() => {
  const STRUCT = ['grade', 'aerial', 'bridge', 'embankment', 'trench', 'median', 'portal', 'cutcover', 'bored', 'tube'];
  const UNDER = new Uint8Array(16); UNDER[6] = 1; UNDER[7] = 1; UNDER[8] = 1; UNDER[9] = 1;   // portal + underground
  const MPH = 0.44704, RAIL_CC = 1.75;
  const tracks = [], byId = {}, stations = [], stationById = {}, lines = [], lineById = {}, patterns = {}, junctions = [];
  const GC = 200; const grid = new Map();                  // spatial grid: cell -> [track idx, sample idx, ...]
  let net = null, tt = null, ready = null, base = null;
  const gkey = (cx, cz) => cx * 65536 + cz;               // cx, cz in [-32768, 32767] cells

  // ---------------------------------------------------------------- loading
  function root(opts) {
    if (opts && opts.base) return opts.base;
    if (typeof Stream !== 'undefined' && Stream.base) return null;       // game: go through Stream
    return (typeof window !== 'undefined' && window.BAYLINE_DATA) || './data/v2/';
  }
  async function inflate(u8) {
    const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function getJSON(path, prio) {
    if (base === null) return Stream.json(path, prio);
    const r = await fetch(base + path); if (!r.ok) throw new Error('MetroNet: ' + r.status + ' ' + path); return r.json();
  }
  async function getBin(path, prio) {
    if (base === null) return Stream.bin(path, prio);
    const r = await fetch(base + path); if (!r.ok) throw new Error('MetroNet: ' + r.status + ' ' + path);
    const u8 = new Uint8Array(await r.arrayBuffer());
    return (u8.length > 2 && (u8[0] & 0x0f) === 8 && ((u8[0] << 8) | u8[1]) % 31 === 0) ? inflate(u8) : u8;
  }
  function load(opts = {}) {
    if (ready) return ready;
    base = root(opts);
    ready = (async () => {
      const prio = opts.prio ?? 2;
      const [j, bin] = await Promise.all([getJSON('metro/network.json', prio), getBin('metro/tracks.bin', prio)]);
      net = j; build(bin); return api;
    })();
    return ready;
  }
  function build(bin) {
    const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    for (const h of net.tracks) {
      const n = h.n, P = new Float32Array(buf, h.off, n * 3), A = new Uint8Array(buf, h.off + n * 12, n * 4);
      const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n), CA = new Float32Array(n);
      const ST = A.subarray(0, n), VL = A.subarray(n, 2 * n), CR = A.subarray(2 * n, 3 * n), CV = A.subarray(3 * n, 4 * n);
      for (let i = 0; i < n; i++) { X[i] = P[i * 3]; Y[i] = P[i * 3 + 1]; Z[i] = P[i * 3 + 2]; CA[i] = (CR[i] - 128) * 0.002; }
      const t = Object.assign({}, h, { idx: tracks.length, X, Y, Z, ST, VL, CA, CV });
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < n; i++) { if (X[i] < x0) x0 = X[i]; if (X[i] > x1) x1 = X[i]; if (Z[i] < z0) z0 = Z[i]; if (Z[i] > z1) z1 = Z[i]; }
      t.bbox = [x0, z0, x1, z1];
      tracks.push(t); byId[t.id] = t;
      let lastK = null, lastL = null;
      for (let i = 0; i < n; i++) {
        const k = gkey(Math.floor(X[i] / GC), Math.floor(Z[i] / GC));
        if (k !== lastK) { lastK = k; lastL = grid.get(k); if (!lastL) grid.set(k, lastL = []); }
        lastL.push(t.idx, i);
      }
    }
    for (const s of net.stations) { const o = Object.assign({ idx: stations.length }, s); stations.push(o); stationById[s.id] = o; }
    for (const l of net.lines) { lines.push(l); lineById[l.id] = l; }
    for (const p of net.patterns) patterns[p.id] = p;
    for (const j of net.junctions) junctions.push(j);
  }

  // ---------------------------------------------------------------- frames
  const T = (t) => typeof t === 'string' ? byId[t] : t;
  function frame(tr, s, out = {}) {
    const t = T(tr); const n = t.X.length, st = t.step;
    let f = s / st; if (f < 0) f = 0; if (f > n - 1.000001) f = n - 1.000001;
    const i = f | 0, a = f - i, X = t.X, Y = t.Y, Z = t.Z;
    out.x = X[i] + (X[i + 1] - X[i]) * a; out.y = Y[i] + (Y[i + 1] - Y[i]) * a; out.z = Z[i] + (Z[i + 1] - Z[i]) * a;
    // tangent: central differences over +-1 sample (blended between i and i+1 for continuity)
    const i0 = i > 0 ? i - 1 : 0, i2 = i + 2 < n ? i + 2 : n - 1;
    let tx = (X[i + 1] - X[i0]) * (1 - a) + (X[i2] - X[i]) * a, ty = (Y[i + 1] - Y[i0]) * (1 - a) + (Y[i2] - Y[i]) * a, tz = (Z[i + 1] - Z[i0]) * (1 - a) + (Z[i2] - Z[i]) * a;
    const L = Math.hypot(tx, ty, tz) || 1; tx /= L; ty /= L; tz /= L;
    const hl = Math.hypot(tx, tz) || 1;
    out.grade = ty / hl;
    // up0 = world up minus its tangent component; right0 = t x up0 ; bank by cant (+ = right rail lower)
    let ux = -tx * ty, uy = 1 - ty * ty, uz = -tz * ty; const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    let rx = ty * uz - tz * uy, ry = tz * ux - tx * uz, rz = tx * uy - ty * ux;
    const cant = t.CA[i] + (t.CA[i + 1] - t.CA[i]) * a, bank = Math.asin(Math.max(-1, Math.min(1, cant / RAIL_CC)));
    const cb = Math.cos(bank), sb = Math.sin(bank);
    out.ux = ux * cb + rx * sb; out.uy = uy * cb + ry * sb; out.uz = uz * cb + rz * sb;
    out.rx = rx * cb - ux * sb; out.ry = ry * cb - uy * sb; out.rz = rz * cb - uz * sb;
    out.tx = tx; out.ty = ty; out.tz = tz;
    out.cant = cant; out.bank = bank;
    const k = a < 0.5 ? i : i + 1;
    out.struct = t.ST[k]; out.structName = STRUCT[out.struct]; out.vlim = t.VL[k] * MPH; out.cover = t.CV[k];
    out.s = f * st; out.track = t; out.i = k;
    return out;
  }
  // point at lateral offset (m, + = right, along the banked right vector) and height above top of rail
  function point(tr, s, lat = 0, up = 0, out = {}) {
    const F = frame(tr, s, _F);
    out.x = F.x + F.rx * lat + F.ux * up; out.y = F.y + F.ry * lat + F.uy * up; out.z = F.z + F.rz * lat + F.uz * up;
    return out;
  }
  const _F = {};

  // ---------------------------------------------------------------- spatial queries
  // best projection per track within r of (x, z): [{track, s, dist, lat}] (lat > 0: right of +s)
  function nearAll(x, z, r = 50, filter = null) {
    const R = Math.ceil(r / GC), cx = Math.floor(x / GC), cz = Math.floor(z / GC), r2 = r * r;
    const best = new Map();
    for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) {
      const l = grid.get(gkey(cx + a, cz + b)); if (!l) continue;
      for (let q = 0; q < l.length; q += 2) {
        const t = tracks[l[q]]; if (filter && !filter(t)) continue;
        const i = l[q + 1], X = t.X, Z = t.Z;
        for (let j = i - 1; j <= i; j++) {                 // the two segments touching sample i
          if (j < 0 || j + 1 >= X.length) continue;
          const ax = X[j], az = Z[j], dx = X[j + 1] - ax, dz = Z[j + 1] - az, L2 = dx * dx + dz * dz || 1e-9;
          let u = ((x - ax) * dx + (z - az) * dz) / L2; u = u < 0 ? 0 : u > 1 ? 1 : u;
          const px = ax + dx * u, pz = az + dz * u, d = (px - x) ** 2 + (pz - z) ** 2;
          if (d > r2) continue;
          const o = best.get(t);
          if (!o || d < o.d2) { const L = Math.sqrt(L2); best.set(t, { track: t, s: (j + u) * t.step, d2: d, dist: Math.sqrt(d), lat: ((x - px) * (-dz) + (z - pz) * dx) / L }); }
        }
      }
    }
    return [...best.values()].sort((a, b) => a.d2 - b.d2);
  }
  function nearest(x, z, maxR = 200, filter = null) { return nearAll(x, z, maxR, filter)[0] || null; }
  function stationsNear(x, z, r = 1000) {
    const out = [];
    for (const s of stations) { const d = Math.hypot(s.x - x, s.z - z); if (d <= r) out.push({ station: s, dist: d }); }
    return out.sort((a, b) => a.dist - b.dist);
  }
  // inside a tunnel / portal / underground station box? (x, y, z world; y metres above sea level)
  function inTunnelAt(x, y, z) {
    for (const nr of nearAll(x, z, 12)) {
      const F = frame(nr.track, nr.s, _F2);
      if (UNDER[F.struct] && Math.abs(nr.lat) < 6.5 && y > F.y - 1.5 && y < F.y + 7.5) return { kind: 'tunnel', track: nr.track, s: nr.s, struct: F.structName, lat: nr.lat };
    }
    for (const st of stations) {
      if (st.type !== 'subway' || Math.abs(st.x - x) > 400 || Math.abs(st.z - z) > 400) continue;
      for (const p of st.platforms) {
        const t = byId[p.track]; if (!t) continue;
        const q = nearAll(x, z, 30, (t2) => t2 === t)[0]; if (!q || q.s < p.s0 - 10 || q.s > p.s1 + 10) continue;
        if (Math.abs(q.lat) < 22 && y > p.rail - 2 && y < p.rail + 14) return { kind: 'station', station: st, track: t, s: q.s, struct: 'station', lat: q.lat };
      }
    }
    return null;
  }
  const _F2 = {};

  // ---------------------------------------------------------------- paths
  class Leg {
    constructor(p, L) {
      this.pattern = p.id; this.sys = L.sys; this.vehicle = L.vehicle; this.length = L.length; this.stops = L.stops;
      let d = 0; this.segs = L.path.map(([id, s0, s1]) => { const g = { track: byId[id], s0, s1, sign: s1 >= s0 ? 1 : -1, d0: d, d1: d + Math.abs(s1 - s0) }; d = g.d1; return g; });
    }
    locate(d, out = {}) {                         // path distance -> {track, s, sign, seg}
      const S = this.segs; let lo = 0, hi = S.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m].d0 <= d) lo = m; else hi = m - 1; }
      const g = S[lo], u = Math.max(0, Math.min(g.d1 - g.d0, d - g.d0));
      out.track = g.track; out.s = g.s0 + g.sign * u; out.sign = g.sign; out.seg = lo; return out;
    }
    // frame at path distance d, oriented along the direction of travel (tangent/right flipped on reversed segments)
    frame(d, out = {}) {
      const q = this.locate(d, _L); frame(q.track, q.s, out);
      if (q.sign < 0) { out.tx = -out.tx; out.ty = -out.ty; out.tz = -out.tz; out.rx = -out.rx; out.ry = -out.ry; out.rz = -out.rz; out.grade = -out.grade; out.bank = -out.bank; out.cant = -out.cant; }
      out.d = d; out.sign = q.sign; return out;
    }
    stopD(station) { const s = this.stops.find(x => x.station === station); return s ? s.d : -1; }
  }
  const _L = {};
  const pathCache = new Map();
  function pathFor(line, dir, pattern) {
    let p = null;
    if (typeof line === 'string' && patterns[line] && dir === undefined) p = patterns[line];
    else if (typeof pattern === 'string') p = patterns[pattern];
    else {
      const L = lineById[line]; if (!L) return null;
      const cand = L.patterns.map(id => patterns[id]).filter(q => q.dir === dir).sort((a, b) => b.trips - a.trips);
      p = cand[pattern | 0] || null;
    }
    if (!p) return null;
    let r = pathCache.get(p.id);
    if (!r) { r = { id: p.id, line: p.line, dir: p.dir, gtfs: p.gtfs, trips: p.trips, legs: p.legs.map(L => new Leg(p, L)) }; pathCache.set(p.id, r); }
    return r;
  }

  // ---------------------------------------------------------------- timetable
  function loadTimetable(prio = 4) {
    if (!tt) tt = getJSON('metro/timetable.json', prio).then((j) => { const byTrip = {}; for (const t of j.trips) byTrip[t.id] = t; j.byTrip = byTrip; return j; });
    return tt;
  }
  let ttJ = null;
  async function timetable() { ttJ = await loadTimetable(); return ttJ; }
  function servicesOn(ymd) {                     // ymd 'YYYYMMDD' (service day, Pacific time); needs loadTimetable()
    if (!ttJ) return [];
    const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))); const wd = (d.getUTCDay() + 6) % 7;   // Mon = 0
    const out = [];
    for (const id in ttJ.services) {
      const s = ttJ.services[id];
      if (s.remove.includes(ymd)) continue;
      if (s.add.includes(ymd) || (s.days[wd] && ymd >= s.start && ymd <= s.end)) out.push(id);
    }
    return out;
  }
  function tripsOn(ymd) { if (!ttJ) return []; const sv = new Set(servicesOn(ymd)); return ttJ.trips.filter(t => sv.has(t.svc)); }
  function trip(id) { return ttJ ? ttJ.byTrip[id] : null; }

  const api = {
    load, loadTimetable: timetable, frame, point, nearest, nearAll, stationsNear, inTunnelAt, pathFor, servicesOn, tripsOn, trip,
    tracks, byId, stations, stationById, lines, lineById, patterns, junctions, STRUCT, UNDER, MPH, RAIL_CC,
    isUnderground: (code) => !!UNDER[code],
    get ready() { return !!net; }, get net() { return net; }, get timetableData() { return ttJ; },
  };
  return api;
})();
if (typeof window !== 'undefined') window.MetroNet = MetroNet;
