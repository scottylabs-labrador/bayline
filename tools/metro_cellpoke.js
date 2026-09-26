// Under volumes against the ground and the roads round a station (run in the page by tools/metro_shots.mjs:
// { "name", "evalFile": this file, "args": { "ids": ["MLPT", "RICH"], "r": 300, "step": 1.5 } }).
// For each station: the camera goes over it, the station builds and the world streams; then a CPU copy of the fine
// cut test (Under.cellAt: y within [floor - 0.3, ceil + 0.3] of a cell) is run
//   - on a grid of the terrain's own height (points under a registered cut are skipped: those openings are meant), and
//   - along every Towns road centre line at road height (hBase + 0.25).
// A hit means the terrain / Towns ground would be discarded there (a hole in the ground or in a street).
// Returns [{ id, hits: { cellId: { n, maxEx, x, z, y } }, roadHits: {...}, nRoad, roads, cells }]: maxEx is how far
// over the cell's ceiling the sample stood (plain cells; strips report 0).
async (B, a) => {
  const M = B.MetroStations, U = B.Under, out = [];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (const id of a.ids || [a.id]) {
    const st = M.byId[id]; if (!st) { out.push({ id, error: 'no station' }); continue; }
    await M.shot(id, { u: 0, v: 0, h: 140, pitch: -1.5, settle: 30 });
    for (let i = 0; i < 200; i++) { B.stepFrame(1); await sleep(30); }
    const pl = st.plan, cx = pl.cx, cz = pl.cz, R = a.r || 300, step = a.step || 1.5;
    const hits = {}, roadHits = {};
    const rec = (H, key, x, z, y, ex) => { const h = H[key] || (H[key] = { n: 0, maxEx: -1e9, x: 0, z: 0, y: 0 }); h.n++; if (ex > h.maxEx) { h.maxEx = +ex.toFixed(2); h.x = +x.toFixed(1); h.z = +z.toFixed(1); h.y = +y.toFixed(2); } };
    const ceilOf = (cid) => { const c = U.cells.get(cid); return c && !c.strip ? c.ceil : null; };
    const underCut = (x, z, y) => { for (const c of U.cuts.values()) { if (x < c.bb[0] || x > c.bb[2] || z < c.bb[1] || z > c.bb[3]) continue; if (y > c.below) return true; } return false; };
    for (let x = cx - R; x <= cx + R; x += step) for (let z = cz - R; z <= cz + R; z += step) {
      const y = B.Terrain.h(x, z), cid = U.cellAt(x, y, z); if (!cid || underCut(x, z, y)) continue;
      const ce = ceilOf(cid); rec(hits, cid, x, z, y, ce !== null ? y - ce : 0);
    }
    const roads = B.Towns ? B.Towns.roadsNear(cx, cz, R) : []; let nRoad = 0;
    for (const rd of roads) { const P = rd.pts;
      for (let i = 0; i + 3 < P.length; i += 3) { const x0 = P[i], z0 = P[i + 2], x1 = P[i + 3], z1 = P[i + 5], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 1.5));
        for (let k = 0; k <= n; k++) { const x = x0 + (x1 - x0) * k / n, z = z0 + (z1 - z0) * k / n, y = B.Terrain.hBase(x, z) + 0.25; nRoad++;
          const cid = U.cellAt(x, y, z); if (!cid) continue; const ce = ceilOf(cid); rec(roadHits, cid + (rd.bridge ? ' (bridge)' : ''), x, z, y, ce !== null ? y - ce : 0); } } }
    let cells = 0; for (const c of U.cells.values()) if (!(c.bb[2] < cx - R || c.bb[0] > cx + R || c.bb[3] < cz - R || c.bb[1] > cz + R)) cells++;
    out.push({ id, hits, roadHits, nRoad, roads: roads.length, cells });
  }
  return out;
}
