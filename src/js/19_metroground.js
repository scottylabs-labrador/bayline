// MetroGround: the ground meets the Bayline Metro (BART) track bed. World workstream; the rule is written out in
// notes/bart/world.md ("Ground meets BART") so the guideway, walls and stations can be built against it.
// With #metro=1, once MetroNet is loaded, a Terrain height filter reshapes every height tile of level >= 7 (the L7 base
// at 6.25 m, lidar L8 3.1 m and L9 1.56 m) along every BART track that runs on the ground, at runtime, from MetroNet's
// current profile (so a new profile never needs a re-bake of published tiles):
//   grade, embankment, median : ground = bed (top of rail - BED) within CORE m of each track centreline, then back to the
//                                natural ground on a 1:2 side slope (cut or fill), at most SLOPE_MAX m wide
//   trench                    : ground cut to top of rail - TRENCH_D within TRENCH_CORE m (never filled), a vertical step
//                                under the retaining wall (infra draws walls from TRENCH_CORE outward)
//   portal, cut-and-cover, bored, tube, aerial, bridge: untouched (infra cuts the openings with Under.addCut)
//   platforms of ground-level stations (grade / embankment / median / trench): ground cut to the bed from the track
//                                out to PLAT_W m on the platform side, over the platform's length + 5 m
// Towns (the new tiles/b2 already do this at bake time; the older tiles/b near the lines need it at runtime): OSM
// train_station buildings within 160 m of a BART station, canopies / sheds / garages within 22 m of an above-ground BART
// track, and anything centred within 7 m of one are dropped (the stations and guideway draw those themselves).
//   MetroGround.stats      { segments, platforms, tiles, ms, dropped }
//   MetroGround.carveAt(x, z, h)   the carved height for a natural height h (debug / QA)
const MetroGround = (() => {
  const BED = 0.85, CORE = 2.4, SLOPE = 2.0, SLOPE_MIN = 1.5, SLOPE_MAX = 16.0;
  const TRENCH_D = 1.2, TRENCH_CORE = 3.0, TRENCH_EDGE = 0.9;
  const PLAT_IN = 1.2, PLAT_W = 11.0, PLAT_EDGE = 1.5;
  const REACH = CORE + SLOPE_MAX + 1;                 // influence radius of a segment (m)
  const CELL = 100, grid = new Map();
  const ck = (cx, cz) => cx * 65536 + cz;
  // segments: ax, az, bx, bz, targetA, targetB, kind (0 bed, 1 trench cut, 2 platform cut), side (-1/0/1 for platforms)
  const SEG = 8; let S = new Float32Array(0), nS = 0;
  const stats = { segments: 0, platforms: 0, tiles: 0, ms: 0, dropped: 0 };
  const ABOVE = new Uint8Array(16); for (const k of [0, 1, 2, 3, 4, 5]) ABOVE[k] = 1;
  const fr = {};
  function dropBuilding(b, x, z) {
    let drop = false;
    if (b.kind === 6 && MetroNet.stationsNear(x, z, 160).length) drop = true;
    else {
      const n = MetroNet.nearest(x, z, 22);
      if (n) { MetroNet.frame(n.track, n.s, fr); drop = !!ABOVE[fr.struct] && (n.dist < 7 || b.kind === 5 || b.kind === 6 || b.kind === 7); }
    }
    if (drop) stats.dropped++;
    return drop;
  }
  let installed = false, bbox = null;

  function addSeg(ax, az, bx, bz, ta, tb, kind, side) {
    if (nS * SEG >= S.length) { const n2 = new Float32Array(Math.max(1024, S.length * 2)); n2.set(S); S = n2; }
    const o = nS * SEG; S[o] = ax; S[o + 1] = az; S[o + 2] = bx; S[o + 3] = bz; S[o + 4] = ta; S[o + 5] = tb; S[o + 6] = kind; S[o + 7] = side;
    const r = kind === 0 ? REACH : kind === 1 ? TRENCH_CORE + TRENCH_EDGE + 1 : PLAT_W + PLAT_EDGE + 1;
    const x0 = Math.floor((Math.min(ax, bx) - r) / CELL), x1 = Math.floor((Math.max(ax, bx) + r) / CELL);
    const z0 = Math.floor((Math.min(az, bz) - r) / CELL), z1 = Math.floor((Math.max(az, bz) + r) / CELL);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) { const k = ck(cx, cz); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(nS); }
    if (!bbox) bbox = [ax, az, ax, az];
    bbox[0] = Math.min(bbox[0], ax - r, bx - r); bbox[1] = Math.min(bbox[1], az - r, bz - r); bbox[2] = Math.max(bbox[2], ax + r, bx + r); bbox[3] = Math.max(bbox[3], az + r, bz + r);
    nS++;
  }
  function build() {
    for (const t of MetroNet.tracks) {
      const X = t.X, Y = t.Y, Z = t.Z, ST = t.ST;
      for (let i = 0; i + 1 < t.n; i++) {
        const s = ST[i];
        if (s === 0 || s === 3 || s === 5) addSeg(X[i], Z[i], X[i + 1], Z[i + 1], Y[i] - BED, Y[i + 1] - BED, 0, 0);
        else if (s === 4) addSeg(X[i], Z[i], X[i + 1], Z[i + 1], Y[i] - TRENCH_D, Y[i + 1] - TRENCH_D, 1, 0);
      }
    }
    // platforms of ground-level stations: a strip on the platform side of the track, over the platform's length
    const f = {};
    for (const st of MetroNet.stations || []) for (const p of st.platforms || []) {
      if (!['grade', 'embankment', 'median', 'trench'].includes(p.structure)) continue;
      const tr = MetroNet.byId[p.track]; if (!tr) continue;
      const side = p.side === 'left' ? -1 : 1, s0 = Math.max(0, Math.min(p.s0, p.s1) - 5), s1 = Math.min(tr.length, Math.max(p.s0, p.s1) + 5);
      let prev = null;
      for (let s = s0; s <= s1 + 0.01; s += Math.min(5, s1 - s0 || 5)) {
        MetroNet.frame(tr, Math.min(s, s1), f);
        const cur = [f.x, f.z, f.y - BED];
        if (prev) addSeg(prev[0], prev[1], cur[0], cur[1], prev[2], cur[2], 2, side);
        prev = cur; if (s >= s1) break;
      }
      stats.platforms++;
    }
    stats.segments = nS;
  }

  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // filter(L, x0, z0, T, h): see Terrain.addHeightFilter
  const tw = new Float32Array(129 * 129), tt = new Float32Array(129 * 129), tc = new Float32Array(129 * 129);
  function filter(L, x0, z0, T, h) {
    if (L < 7 || !nS) return false;
    if (bbox && (x0 > bbox[2] || x0 + T < bbox[0] || z0 > bbox[3] || z0 + T < bbox[1])) return false;
    const t0 = performance.now(), step = T / 128;
    const seen = new Set(), cand = [];
    for (let cz = Math.floor(z0 / CELL); cz <= Math.floor((z0 + T) / CELL); cz++) for (let cx = Math.floor(x0 / CELL); cx <= Math.floor((x0 + T) / CELL); cx++) {
      const a = grid.get(ck(cx, cz)); if (!a) continue;
      for (const k of a) if (!seen.has(k)) { seen.add(k); cand.push(k); }
    }
    if (!cand.length) return false;
    tw.fill(0); tc.fill(1e9);
    for (const k of cand) {
      const o = k * SEG, ax = S[o], az = S[o + 1], bx = S[o + 2], bz = S[o + 3], ta = S[o + 4], tb = S[o + 5], kind = S[o + 6], side = S[o + 7];
      const r = kind === 0 ? REACH : kind === 1 ? TRENCH_CORE + TRENCH_EDGE : PLAT_W + PLAT_EDGE;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - x0) / step)), i1 = Math.min(128, Math.ceil((Math.max(ax, bx) + r - x0) / step));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - r - z0) / step)), j1 = Math.min(128, Math.ceil((Math.max(az, bz) + r - z0) / step));
      if (i0 > i1 || j0 > j1) continue;
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, len = Math.sqrt(L2) || 1;
      for (let j = j0; j <= j1; j++) {
        const pz = z0 + j * step;
        for (let i = i0; i <= i1; i++) {
          const px = x0 + i * step, q = j * 129 + i;
          let u = L2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
          const ex = px - (ax + dx * u), ez = pz - (az + dz * u), d = Math.sqrt(ex * ex + ez * ez), tgt = ta + (tb - ta) * u;
          if (kind === 0) {
            const hn = h[q], wid = Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, SLOPE * Math.abs(hn - tgt)));
            const w = 1 - sstep(CORE, CORE + wid, d);
            if (w > tw[q]) { tw[q] = w; tt[q] = tgt; }
          } else if (kind === 1) {
            const w = 1 - sstep(TRENCH_CORE, TRENCH_CORE + TRENCH_EDGE, d);
            if (w > 0) { const hc = h[q] - Math.max(0, h[q] - tgt) * w; if (hc < tc[q]) tc[q] = hc; }
          } else {
            // platform strip: lateral offset on the platform's side (right of +s = (-dz, dx))
            const lat = ((px - ax) * -dz + (pz - az) * dx) / len * side;
            if (lat < PLAT_IN - PLAT_EDGE) continue;
            const w = (1 - sstep(PLAT_W, PLAT_W + PLAT_EDGE, lat)) * sstep(PLAT_IN - PLAT_EDGE, PLAT_IN, lat) * (1 - sstep(0.5, 3, Math.abs(d - Math.abs(lat))));
            if (w > 0) { const hc = h[q] - Math.max(0, h[q] - tgt) * w; if (hc < tc[q]) tc[q] = hc; }
          }
        }
      }
    }
    let changed = false;
    for (let q = 0; q < h.length; q++) {
      let v = h[q];
      if (tw[q] > 0) v += (tt[q] - v) * tw[q];
      if (tc[q] < v) v = tc[q];
      if (v !== h[q]) { h[q] = v; changed = true; }
    }
    stats.tiles++; stats.ms += performance.now() - t0;
    return changed;
  }
  // the carved height at one point for a natural height hn (the same rule as filter, without a grid)
  function carvePoint(x, z, hn) {
    const a = grid.get(ck(Math.floor(x / CELL), Math.floor(z / CELL))); if (!a) return hn;
    let w0 = 0, t0 = 0, cut = 1e9;
    for (const k of a) {
      const o = k * SEG, ax = S[o], az = S[o + 1], bx = S[o + 2], bz = S[o + 3], ta = S[o + 4], tb = S[o + 5], kind = S[o + 6], side = S[o + 7];
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, len = Math.sqrt(L2) || 1;
      let u = L2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = x - (ax + dx * u), ez = z - (az + dz * u), d = Math.sqrt(ex * ex + ez * ez), tgt = ta + (tb - ta) * u;
      if (kind === 0) {
        const w = 1 - sstep(CORE, CORE + Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, SLOPE * Math.abs(hn - tgt))), d);
        if (w > w0) { w0 = w; t0 = tgt; }
      } else if (kind === 1) {
        const w = 1 - sstep(TRENCH_CORE, TRENCH_CORE + TRENCH_EDGE, d);
        if (w > 0) cut = Math.min(cut, hn - Math.max(0, hn - tgt) * w);
      } else {
        const lat = ((x - ax) * -dz + (z - az) * dx) / len * side;
        if (lat < PLAT_IN - PLAT_EDGE) continue;
        const w = (1 - sstep(PLAT_W, PLAT_W + PLAT_EDGE, lat)) * sstep(PLAT_IN - PLAT_EDGE, PLAT_IN, lat) * (1 - sstep(0.5, 3, Math.abs(d - Math.abs(lat))));
        if (w > 0) cut = Math.min(cut, hn - Math.max(0, hn - tgt) * w);
      }
    }
    let v = hn; if (w0 > 0) v += (t0 - v) * w0; if (cut < v) v = cut;
    return v;
  }
  // the 800 m tiles (Towns / Flora tiles, SPEC_v2 L7) where the carve or the drop filters change anything
  function affected() {
    const T7 = 800, X0 = -45056, Z0 = -49152, keys = new Set();
    const mark = (x0, z0, x1, z1) => {
      for (let tz = Math.floor((z0 - Z0) / T7); tz <= Math.floor((z1 - Z0) / T7); tz++) for (let tx = Math.floor((x0 - X0) / T7); tx <= Math.floor((x1 - X0) / T7); tx++) keys.add(tx + ',' + tz);
    };
    for (let k = 0; k < nS; k++) {
      const o = k * SEG, r = S[o + 6] === 0 ? REACH : S[o + 6] === 1 ? TRENCH_CORE + TRENCH_EDGE : PLAT_W + PLAT_EDGE;
      mark(Math.min(S[o], S[o + 2]) - r, Math.min(S[o + 1], S[o + 3]) - r, Math.max(S[o], S[o + 2]) + r, Math.max(S[o + 1], S[o + 3]) + r);
    }
    for (const t of MetroNet.tracks) for (let i = 0; i < t.n; i += 4) if (ABOVE[t.ST[i]]) mark(t.X[i] - 22, t.Z[i] - 22, t.X[i] + 22, t.Z[i] + 22);
    for (const st of MetroNet.stations || []) mark(st.x - 160, st.z - 160, st.x + 160, st.z + 160);
    return [...keys].map(k => { const [tx, tz] = k.split(',').map(Number); return [X0 + tx * T7, Z0 + tz * T7, X0 + (tx + 1) * T7, Z0 + (tz + 1) * T7]; });
  }
  // trees in the way of a BART structure above ground (the new tree tiles keep 6.5 m + half a crown clear at bake time;
  // the older ones near the lines need it at runtime)
  function dropTree(x, z, r) {
    const n = MetroNet.nearest(x, z, 6.5 + r * 0.5 + 0.5);
    if (!n) return false;
    MetroNet.frame(n.track, n.s, fr);
    return !!ABOVE[fr.struct] && n.dist < 6.5 + r * 0.5;
  }
  // (debug / QA) carved height at a point for a given natural height
  function carveAt(x, z, hn) { const h = new Float32Array(129 * 129).fill(hn); const T = 12.8; filter(9, x - T / 2, z - T / 2, T, h); return h[64 * 129 + 64]; }

  function install() {
    if (installed || typeof MetroNet === 'undefined' || !MetroNet.tracks || !MetroNet.tracks.length || typeof Terrain === 'undefined' || !Terrain.addHeightFilter) return false;
    installed = true; build();
    const R = rects = affected(); stats.rects = R.length;
    // what already stands near the lines is re-placed there only (no dispose: nothing elsewhere reloads or goes black):
    // trees first, by the carve's height change under each (computed on the ground before the carve), and the drop filter
    try { if (typeof Flora !== 'undefined' && Flora.adjust) { Flora.addDrop(dropTree); stats.flora = Flora.adjust(R, (x, z) => { const hn = Terrain.h(x, z); return carvePoint(x, z, hn) - hn; }); } } catch (e) { console.warn('MetroGround flora', e); }
    // the terrain re-filters its loaded tiles in place (spread over frames), then the towns rebuild the touched tiles
    Promise.resolve(Terrain.addHeightFilter(filter, bbox)).then(() => {
      try { if (typeof Towns !== 'undefined' && Towns.refresh) { Towns.addDrop(dropBuilding); stats.towns = Towns.refresh(R); } } catch (e) { console.warn('MetroGround towns', e); }
    });
    console.log('MetroGround: carving', stats.segments, 'segments,', stats.platforms, 'platforms,', R.length, 'tiles re-placed');
    return true;
  }
  // self-start with #metro=1 (#mground=0 turns it off for QA): as soon as the terrain and MetroNet are there
  if (typeof location !== 'undefined' && (typeof Metro !== 'undefined' ? Metro.on : /(^|[#&])metro=1(&|$)/.test(location.hash)) && !/(^|[#&])mground=0(&|$)/.test(location.hash)) {   // (the switch: 18_metro.js)
    const t = setInterval(() => {
      if (typeof Terrain === 'undefined' || !Terrain.tiled || typeof MetroNet === 'undefined') return;
      if (!MetroNet.tracks || !MetroNet.tracks.length) { if (MetroNet.load) MetroNet.load().catch(() => {}); return; }
      if (install()) clearInterval(t);
    }, 400);
  }
  let rects = null;
  const api = { install, carveAt, carvePoint, stats, get installed() { return installed; }, get rects() { return rects; } };
  if (typeof window !== 'undefined') (window.__baylineMods ||= {}).MetroGround = api;
  return api;
})();
