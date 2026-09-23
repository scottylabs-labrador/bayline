// Railway alignment: 5 m samples of the snapped centreline (x, z, top-of-rail y), per-sample track
// count/offsets, and the lanes each direction runs on. s = metres from 4th & King (0) to Gilroy.
// dir 1 = southbound (increasing s), dir 0 = northbound. Lateral offsets are "right of +s" positive
// (as baked); trains keep right, so southbound runs on the positive side, northbound on the negative.
const Track = (() => {
  let n = 0, STEP = 5, X = null, Z = null, Y = null, CNT = null, OFS = null, laneSB = null, laneNB = null;
  let feat = null; const stations = []; const byId = {};
  const grid = new Map(); const GC = 250;

  async function load() {
    const u8 = await Data.bin('track'); const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    n = dv.getUint32(4, true); STEP = dv.getFloat32(8, true); let p = 12;
    const f32 = (k) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = dv.getFloat32(p + i * 4, true); p += n * 4; return a; };
    X = f32(); Z = f32(); Y = f32();
    CNT = new Int8Array(u8.buffer.slice(u8.byteOffset + p, u8.byteOffset + p + n)); p += n;
    OFS = new Int8Array(u8.buffer.slice(u8.byteOffset + p, u8.byteOffset + p + n * 4));
    feat = await Data.json('track');
    // lanes
    const sb = new Float32Array(n), nb = new Float32Array(n);
    let lastS = 2.3, lastN = -2.3;
    for (let i = 0; i < n; i++) {
      const c = CNT[i];
      if (c >= 2) { lastS = OFS[i * 4 + c - 1] / 10; lastN = OFS[i * 4] / 10; }
      else if (c === 1) { lastS = lastN = OFS[i * 4] / 10; }
      sb[i] = lastS; nb[i] = lastN;
    }
    laneSB = gauss(sb, 24); laneNB = gauss(nb, 24);
    for (const st of feat.stations) { const o = { ...st, idx: stations.length }; stations.push(o); byId[st.id] = o; }
    for (let i = 0; i < n; i++) { const k = key(X[i], Z[i]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
  }
  function gauss(a, sig) {
    const r = Math.ceil(sig * 2.5), w = []; let ws = 0; for (let k = -r; k <= r; k++) { const v = Math.exp(-k * k / (2 * sig * sig)); w.push(v); ws += v; }
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) { let acc = 0; for (let k = -r; k <= r; k++) { const j = U.clamp(i + k, 0, a.length - 1); acc += a[j] * w[k + r]; } out[i] = acc / ws; }
    return out;
  }
  const key = (x, z) => Math.floor(x / GC) * 100000 + Math.floor(z / GC);

  function idxT(s) { const f = U.clamp(s / STEP, 0, n - 1.0001); const i = f | 0; return [i, f - i]; }
  const tmp = { x: 0, y: 0, z: 0 };
  // centreline point + tangent (unit in xz) + right normal (rx, rz)
  function frame(s, out) {
    const [i, t] = idxT(s);
    out.x = X[i] + (X[i + 1] - X[i]) * t; out.z = Z[i] + (Z[i + 1] - Z[i]) * t; out.y = Y[i] + (Y[i + 1] - Y[i]) * t;
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 2);
    let dx = X[i1] - X[i0], dz = Z[i1] - Z[i0]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    out.dx = dx; out.dz = dz; out.rx = -dz; out.rz = dx;   // right of +s (matches the baked offsets)
    out.grade = (Y[i1] - Y[i0]) / (STEP * (i1 - i0));
    return out;
  }
  // world point on the track at s with lateral offset (right positive)
  function point(s, lat, out = {}) { frame(s, out); out.x += out.rx * lat; out.z += out.rz * lat; return out; }
  function lane(s, dir) { const [i, t] = idxT(s); const a = dir ? laneSB : laneNB; return a[i] + (a[i + 1] - a[i]) * t; }
  function trackCount(s) { const [i] = idxT(s); return CNT[i]; }
  function offsets(s) { const [i] = idxT(s); const c = CNT[i]; const o = []; for (let k = 0; k < c; k++) o.push(OFS[i * 4 + k] / 10); return o; }
  function yAt(s) { const [i, t] = idxT(s); return Y[i] + (Y[i + 1] - Y[i]) * t; }
  // nearest centreline sample to (x,z)
  function nearest(x, z, maxR = 1500) {
    let best = -1, bd = maxR * maxR; const cx = Math.floor(x / GC), cz = Math.floor(z / GC); const R = Math.ceil(maxR / GC);
    for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) {
      const l = grid.get((cx + a) * 100000 + (cz + b)); if (!l) continue;
      for (const i of l) { const d = (X[i] - x) ** 2 + (Z[i] - z) ** 2; if (d < bd) { bd = d; best = i; } }
    }
    if (best < 0) return null;
    const fr = frame(best * STEP, {}); const lat = (x - fr.x) * fr.rx + (z - fr.z) * fr.rz;
    return { s: best * STEP, lat, dist: Math.sqrt(bd) };
  }
  function dist(x, z) { const r = nearest(x, z, 600); return r ? r.dist : 1e9; }
  const inRange = (ranges, s) => { for (const r of ranges) if (s >= r[0] && s <= r[1]) return true; return false; };
  function inTunnel(s) { return inRange(feat.tunnels, s); }
  function onBridge(s) { return inRange(feat.bridges, s); }
  function electric(s) { return inRange(feat.electric, s); }
  function stationNear(s, within = 400) { let best = null, bd = within; for (const st of stations) { const d = Math.abs(st.s - s); if (d < bd) { bd = d; best = st; } } return best; }
  // speed limit (m/s) at s for a direction — civil limits approximated from the real line
  const MPH = 0.44704;
  function limit(s) {
    if (s < 900) return 20 * MPH;                     // 4th & King throat
    if (s < 8600) return inTunnel(s) ? 45 * MPH : 55 * MPH;   // SF tunnels / Bayshore curves
    if (s > 74000 && s < 76600) return 30 * MPH;       // Diridon interlockings
    if (s > 78800 && s < 83000) return 50 * MPH;       // Tamien-Capitol curves (UP)
    if (s > 83000) return 79 * MPH * 0.9;             // South County (UP), diesel
    return 79 * MPH;
  }
  return { load, frame, point, lane, trackCount, offsets, yAt, nearest, dist, inTunnel, onBridge, electric, stationNear, limit, MPH,
    stations, byId, get feat() { return feat; }, get length() { return (n - 1) * STEP; }, get n() { return n; }, get step() { return STEP; },
    get X() { return X; }, get Z() { return Z; }, get Y() { return Y; } };
})();
