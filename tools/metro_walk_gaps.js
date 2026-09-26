// Walkable width along every platform (run in the page by tools/metro_shots.mjs: { "name", "evalFile": this file,
// "args": { "ids": [...] (default: every station), "min": 0.9, "step": 0.5 } }). Builds each station in turn, then
// along each platform (every `step` m) finds the widest run across it that a walker can use: floor points farther than
// 0.25 m from every wall in the walk data at walking height (platform edges, furniture, balustrades, railings, columns).
// A slice whose widest run is under `min` m is a pinch; pinches are grouped into places and split by cause: 'furn' when
// the slice is open again without the furniture walls (benches, bins, totems, maps), else 'other' (openings, stairs).
// Returns { stations, places: [{ id, plat, u0, u1, width, withoutFurn, cause }], furn, other }.
async (B, a) => {
  const M = B.MetroStations, ids = a.ids && a.ids.length ? a.ids : M.list.map(s => s.id), MIN = a.min || 0.9, STEP = a.step || 0.5, R0 = 0.25;
  const places = []; let n = 0;
  const segD = (px, pz, w) => { const ex = w.x1 - w.x0, ez = w.z1 - w.z0, l2 = ex * ex + ez * ez || 1e-9, t = Math.max(0, Math.min(1, ((px - w.x0) * ex + (pz - w.z0) * ez) / l2)); return Math.hypot(w.x0 + ex * t - px, w.z0 + ez * t - pz); };
  for (const id of ids) {
    const st = M.byId[id]; if (!st) continue;
    const r = await M.shot(id, { u: 0, v: 0, h: 60, pitch: -1.2, settle: 4 }); if (r.state !== 'built' || !st.res || !st.walk) continue; n++;
    const R = st.res, W = st.walk;
    for (const [pi, p] of R.crowd.plats.entries()) {
      // the walls near this platform at walking height
      const y = p.y, near = W.walls.filter(w => !(y + 1.0 < w.y0 || y + 0.3 > w.y1));
      let run = null;
      const flush = () => { if (run) { delete run.uRaw; places.push(run); run = null; } };
      for (let u = p.u0 + 1; u <= p.u1 - 1; u += STEP) {
        const a0 = p.eL(u), b0 = p.eR(u); let best = 0, bestNF = 0, cur = 0, curNF = 0;
        for (let v = a0 + 0.05; v <= b0 - 0.05; v += 0.05) {
          const [x, z] = R.toWorld(u, v); let free = true, freeNF = true;
          for (const w of near) { if (Math.abs(w.x0 - x) > 8 && Math.abs(w.x1 - x) > 8) continue; if (segD(x, z, w) < R0) { if (w.tag === 'furn') free = false; else { free = false; freeNF = false; break; } } }
          cur = free ? cur + 0.05 : 0; curNF = freeNF ? curNF + 0.05 : 0; best = Math.max(best, cur); bestNF = Math.max(bestNF, curNF);
        }
        if (best < MIN) { const cause = bestNF >= MIN ? 'furn' : 'other';
          if (run && run.cause === cause && u - run.uRaw <= STEP + 1e-6) { run.uRaw = u; run.u1 = +u.toFixed(1); run.width = Math.min(run.width, +best.toFixed(2)); }
          else { flush(); run = { id, plat: pi, kind: p.kind, u0: +u.toFixed(1), u1: +u.toFixed(1), uRaw: u, width: +best.toFixed(2), withoutFurn: +bestNF.toFixed(2), cause }; } }
        else flush();
      }
      flush();
    }
  }
  return { stations: n, furn: places.filter(q => q.cause === 'furn').length, other: places.filter(q => q.cause === 'other').length, places: places.slice(0, 80) };
}
