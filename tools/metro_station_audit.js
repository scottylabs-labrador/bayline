// Station audit (run in the page by tools/metro_shots.mjs: { "name", "evalFile": this file, "args": { "ids": ["EMBR", ...] } }).
// Builds each station (one at a time, camera parked over it) and reports its levels against the ground and the street,
// with flags for what does not fit: concourses above the street, entrances dropped, escalator rises out of range,
// bents too short or too tall, lobbies off the ground, footbridges that do not clear the tracks, landings dropped.
async (B, a) => {
  const M = B.MetroStations, out = [];
  const ids = a.ids && a.ids.length ? a.ids : M.list.map(s => s.id);
  for (const id of ids) {
    const st = M.byId[id]; if (!st) { out.push({ id, err: 'no station' }); continue; }
    const r = await M.shot(id, { u: 0, v: 0, h: 60, pitch: -1.2, settle: 4 });
    if (r.state !== 'built') { out.push({ id, state: r.state, err: r.error }); continue; }
    const i = st.res.info, pl = st.plan; const flags = [];
    const g0 = B.Terrain.h(pl.cx, pl.cz), D = i.street - i.yT;
    const row = { id, type: st.type, mode: i.mode, layout: st.data.layout, yT: +i.yT.toFixed(1), street: +i.street.toFixed(1), ground: +g0.toFixed(1), D: +D.toFixed(1), tris: r.tris };
    if (i.yCF !== undefined) row.yCF = +i.yCF.toFixed(1); if (i.yCC !== undefined) row.yCC = +i.yCC.toFixed(1); if (i.rise) row.rise = +i.rise.toFixed(1);
    row.plats = i.plats.map(p => `${p[0]}${p[3]}m:${p[4].map(g => g[0]).join('/') || '-'}`).join(' ');
    // (an island wider than any BART island is two faces paired across other tracks: MacArthur before the pairing fix)
    for (const p of i.plats) if (p[0] === 'island' && p[3] > 14) flags.push('island ' + p[3] + ' m wide');
    if (st.type === 'subway') {
      if (i.mode === 'ends') flags.push('no concourse (D ' + D.toFixed(1) + ')');
      if (i.yCC !== undefined && i.yCC > i.street - 0.9) flags.push('concourse ceiling above street-0.9');
      const nEnt = (st.data.entrances || []).length, built = (st.res.cells || []).filter(c => c.zone === 'ent').length;
      row.ent = `${built}/${nEnt}`; if (nEnt && !built && i.mode === 'above') flags.push('no entrance built');
      if (D > 30 || D < 3) flags.push('odd depth');
    } else {
      if (i.elevated) { const hAbove = i.yT - g0; row.above = +hAbove.toFixed(1); if (hAbove < 3) flags.push('aerial deck only ' + hAbove.toFixed(1) + ' m above ground'); if (hAbove > 25) flags.push('deck ' + hAbove.toFixed(1) + ' m up'); }
      if (i.mode === 'below' && i.yCF !== undefined && Math.abs(i.yCF - g0) > 2.5 && i.elevated) flags.push('lobby off the ground by ' + (i.yCF - g0).toFixed(1));
      if (i.underpass) { row.under = i.underpass; if (i.yCC - i.yCF < 2.6) flags.push('underpass lower than 2.6 m'); }
      if (i.mode === 'bridge') { row.landings = (i.landings || []).map(L => L.rise).join(','); if (!(i.landings || []).length && i.yCF - i.street > 1.5) flags.push('footbridge without landings'); }
      if (st.type === 'trench' && D < 2) flags.push('trench but platform not below street (D ' + D.toFixed(1) + ')');
    }
    if (i.rise && (i.rise < 1.5 || i.rise > 16)) flags.push('escalator rise ' + i.rise.toFixed(1));
    if (i.guard && i.guard.length) row.guard = i.guard;
    row.flags = flags; out.push(row);
  }
  return out;
}
