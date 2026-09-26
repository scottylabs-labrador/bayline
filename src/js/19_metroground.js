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
// Towns (tiles/b and tiles/b2 alike: b2 bakes only the Caltrain-era drops, so with the metro off every building is
// there): OSM train_station buildings within 160 m of a BART station, canopies / sheds within 22 m of an above-ground
// BART track, and anything centred within 7 m of one are dropped (the stations and guideway draw those themselves).
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
  // tunnel mouths (where a track goes between underground (portal, cut-and-cover, bored, tube) and the open air):
  // nothing may stand in front of one (INFRA: West Oakland, the Berkeley Hills east portal)
  const MOUTH_R = 30, CUT_R = 8, mouths = [];
  function nearMouth(x, z) { for (let i = 0; i < mouths.length; i += 2) { const dx = mouths[i] - x, dz = mouths[i + 1] - z; if (dx * dx + dz * dz < MOUTH_R * MOUTH_R) return true; } return false; }
  function dropBuilding(b, x, z) {
    let drop = false;
    if (b.kind === 6 && MetroNet.stationsNear(x, z, 160).length) drop = true;
    else if (nearMouth(x, z)) drop = true;
    else {
      const n = MetroNet.nearest(x, z, 22);
      // anything centred within 7 m of an above-ground track; canopies / sheds / roofs (5) and station buildings (6)
      // within 22 m (the guideway and stations draw their own); parking structures (7) only when in the way (7 m)
      if (n) { MetroNet.frame(n.track, n.s, fr);
        drop = (fr.struct === 4 || fr.struct === 6) ? n.dist < CUT_R                       // open cuts and portals: 8 m
          : !!ABOVE[fr.struct] && (n.dist < 7 || b.kind === 5 || b.kind === 6); }
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
    const UG = (c) => c >= 6 && c <= 9;
    for (const t of MetroNet.tracks) for (let i = 1; i < t.n; i++) if (UG(t.ST[i]) !== UG(t.ST[i - 1])) { const k = UG(t.ST[i]) ? i - 1 : i; mouths.push(t.X[k], t.Z[k]); }
    stats.mouths = mouths.length / 2;
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
    for (let i = 0; i < mouths.length; i += 2) mark(mouths[i] - MOUTH_R, mouths[i + 1] - MOUTH_R, mouths[i] + MOUTH_R, mouths[i + 1] + MOUTH_R);
    return [...keys].map(k => { const [tx, tz] = k.split(',').map(Number); return [X0 + tx * T7, Z0 + tz * T7, X0 + (tx + 1) * T7, Z0 + (tz + 1) * T7]; });
  }
  // trees in the way of a BART structure above ground (the new tree tiles keep 6.5 m + half a crown clear at bake time;
  // the older ones near the lines need it at runtime)
  // ground that the metro's openings cut away or that lies inside an underground volume (Under: portal approaches, open
  // cuts, a chamber or box whose volume reaches the surface): no tree, bush or grass stands there. Under.cutAt at the
  // ground, behind a box test over Under's cuts and cells (their boxes re-read when they change, at most every 0.5 s)
  // cached on a 100 m grid
  const cutCache = new Map(); let cutGen = -1, cutT = 0, cutBoxes = [];
  const underOn = () => typeof Under !== 'undefined' && Under.enabled && !!Under.cutAt && !!Under.stats;
  function boxes() {
    const g = Under.stats.cuts * 65536 + Under.stats.cells, now = performance.now();
    if (g !== cutGen || now - cutT > 500) {
      const B = [];
      for (const m of [Under.cuts, Under.cells]) if (m && m.values) for (const c of m.values()) if (c.bb) B.push(c.bb);
      if (g !== cutGen || B.length !== cutBoxes.length || B.some((b, i) => b !== cutBoxes[i])) cutCache.clear();
      cutGen = g; cutT = now; cutBoxes = B;
    }
    return cutBoxes;
  }
  function cutNear(x0, z0, x1, z1) {
    if (!underOn()) return false;
    for (const b of boxes()) if (b[0] < x1 && b[2] > x0 && b[1] < z1 && b[3] > z0) return true;
    return false;
  }
  function onCutGround(x, z) {
    if (!underOn()) return false;
    boxes();
    const gx = Math.floor(x / 100), gz = Math.floor(z / 100), k = gx * 4096 + gz;
    let near = cutCache.get(k);
    if (near === undefined) { near = cutNear(gx * 100, gz * 100, gx * 100 + 100, gz * 100 + 100); cutCache.set(k, near); }
    return near && !!Under.cutAt(x, z, Terrain.h(x, z) + 0.3);
  }
  // cuts and cells register as the metro builds near the camera, usually after the trees there loaded: every second the
  // boxes of the new ones are re-filtered (Flora.refreshIn: the drop filters on the loaded trees there, nothing reloads)
  const seenCuts = new Set();
  function watchCuts() {
    if (typeof Under === 'undefined' || !Under.enabled || typeof Flora === 'undefined' || !Flora.refreshIn) return;
    const R = [];
    for (const m of [Under.cuts, Under.cells]) if (m && m.entries) for (const [id, c] of m.entries()) {
      if (seenCuts.has(id)) continue; seenCuts.add(id);
      if (c.bb) R.push([c.bb[0] - 2, c.bb[1] - 2, c.bb[2] + 2, c.bb[3] + 2]);
    }
    if (R.length) Flora.refreshIn(R);
  }
  // road traffic never drives on a BART track at ground level or over an open trench (an OSM road drawn across it, e.g.
  // West Oakland): a keep-out in the shape of MetroStations' (Life's cutRoads cuts the lanes there). Trench: any road
  // point within its half width + 3 m of the track that is not a bridge (cutRoads passes bridges and major roads);
  // grade, embankment, median: the same, unless the road is 3 m or more above the rail
  const roadKeepOut = {
    keepOutAny(x0, z0, x1, z1) {                        // (the carve's 100 m grid of ground-level track segments)
      if (!installed) return false;
      const a = Math.floor((Math.min(x0, x1) - 12) / CELL), b = Math.floor((Math.max(x0, x1) + 12) / CELL);
      const c = Math.floor((Math.min(z0, z1) - 12) / CELL), d = Math.floor((Math.max(z0, z1) + 12) / CELL);
      if ((b - a + 1) * (d - c + 1) > 4096) return true;
      for (let cz = c; cz <= d; cz++) for (let cx = a; cx <= b; cx++) if (grid.has(ck(cx, cz))) return true;
      return false;
    },
    keepOut(x, z, kind, hw, y) {
      if (!installed || !grid.has(ck(Math.floor(x / CELL), Math.floor(z / CELL)))) return false;
      const n = MetroNet.nearest(x, z, (hw || 0) + 3.0);
      if (!n) return false;
      MetroNet.frame(n.track, n.s, fr);
      const st = fr.struct;
      if (st === 4) return true;
      return (st === 0 || st === 3 || st === 5) && !(y > fr.y + 3.0);
    },
  };
  function dropTree(x, z, r, shrub) {
    if (onCutGround(x, z)) return true;
    if (shrub) return false;                           // (bushes: only the cut; the clearance below is for trees)
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
      // road traffic reads the ground when its lanes stream (Towns.roadsNear): lanes streamed before the carve would float
      // over a lowered bed, so they stream again now
      try { if (typeof World !== 'undefined' && World.traffic) World.traffic.cx = 1e9; } catch (e) { /* no traffic */ }
    });
    watchCuts(); setInterval(() => { try { watchCuts(); } catch (e) { console.warn('MetroGround cuts', e); } }, 1000);
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
  const api = { install, carveAt, carvePoint, onCutGround, cutNear, roadKeepOut, stats, get installed() { return installed; }, get rects() { return rects; },
    // (QA handles: the modules this one works with, for headless checks)
    _dbg: { flora: () => (typeof Flora !== 'undefined' ? Flora : null), terrain: () => Terrain, world: () => (typeof World !== 'undefined' ? World : null), ground: () => (typeof GroundCover !== 'undefined' ? GroundCover : null) } };
  if (typeof window !== 'undefined') (window.__baylineMods ||= {}).MetroGround = api;
  return api;
})();
