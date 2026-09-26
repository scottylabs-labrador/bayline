// Platform-vs-track check (run in the page by tools/metro_shots.mjs: { "name", "evalFile": this file, "args": { "ids": [...] } };
// no build needed, plans only). For every platform of every station plan, sampled every 5 m along it: the platform's own
// track must lie at its edge distance, and a point 2.5 m into the platform body must be clear of every other track
// (> 2.5 m from its centreline), so a platform on the wrong side of its track (or over a neighbour) shows up.
// Returns [{ id, layout, plats: [{ key, gtfs, track, sideV, len, bodyHits, nearest }], flags }].
async (B, a) => {
  const M = B.MetroStations, MN = M.qa.metronet; const out = [];
  const ids = a.ids && a.ids.length ? a.ids : M.list.map(s => s.id);
  for (const id of ids) {
    const st = M.byId[id]; if (!st) { out.push({ id, err: 'no station' }); continue; }
    const pl = st.plan || (st.plan = M.makePlan(st.data)); if (!pl) { out.push({ id, err: 'no plan' }); continue; }
    const row = { id, layout: st.layout, plats: [], flags: [] };
    for (const p of pl.plats) {
      let hits = 0, n = 0, near = 1e9, nearT = '';
      for (let u = p.u0 + 2; u <= p.u1 - 2; u += 5) {
        const S = M.spineAt(pl, u, {}); const tv = M.trackV(pl, p.t, u);
        const vb = tv + p.sideV * (p.edge + 2.5); const x = S.x + S.rx * vb, z = S.z + S.rz * vb;
        n++;
        for (const q of MN.nearAll(x, z, 12)) { if (q.track.id === p.track) continue;
          if (q.dist < near) { near = q.dist; nearT = q.track.id; }
          if (q.dist < 2.5) { hits++; break; } }
      }
      row.plats.push({ key: p.key, gtfs: p.gtfs, track: p.track, sys: p.sys, sideV: p.sideV, len: +(p.u1 - p.u0).toFixed(0), bodyHits: `${hits}/${n}`, nearest: near < 1e8 ? `${nearT} ${near.toFixed(1)}` : '-' });
      if (hits) row.flags.push(`${p.gtfs || p.key}: body over ${nearT} at ${hits}/${n} samples`);
    }
    out.push(row);
  }
  return out;
}
