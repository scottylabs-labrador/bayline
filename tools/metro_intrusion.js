// Foreign geometry inside the stations (run in the page by tools/metro_shots.mjs: { "name", "evalFile": this file,
// "args": { "ids": [...] } }; the Millbrae depot standing over BART is what it would have caught). For each station:
// its platforms are sampled every 4 m along and 1.2 m across; each sample is tested against the OSM buildings Towns
// still draws there (polygon test) and against the Peninsula stations and landmarks (a vertical ray from 0.3 m to
// 4 m over the platform). Returns [{ id, towns: [...building ids/centroids], peninsula: [...object names], n }].
async (B, a) => {
  const M = B.MetroStations, out = [];
  const ids = a.ids && a.ids.length ? a.ids : M.list.map(s => s.id);
  const inPoly = (P, x, z) => { let c = false; for (let i = 0, n = P.length / 2, j = n - 1; i < n; j = i++) { const xi = P[i * 2], zi = P[i * 2 + 1], xj = P[j * 2], zj = P[j * 2 + 1]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
  const foreign = []; for (const c of B.Env.scene.children) if (/^(stations|landmarks)$/.test(c.name || '')) foreign.push(c);
  const rc = new THREE.Raycaster(); rc.params.Points.threshold = 0.1; rc.params.Line.threshold = 0.1; const up = new THREE.Vector3(0, 1, 0);
  for (const id of ids) {
    const st = M.byId[id]; if (!st) continue;
    const r = await M.shot(id, { u: 0, v: 0, h: 70, pitch: -1.3, settle: 4 });
    if (r.state !== 'built' || !st.res || !st.res.crowd) { out.push({ id, state: r.state }); continue; }
    const R = st.res, pts = [];
    for (const p of R.crowd.plats) for (let u = p.u0 + 1; u <= p.u1 - 1; u += 4) { const a0 = p.eL(u), b0 = p.eR(u); for (let v = a0 + 0.4; v <= b0 - 0.4; v += 1.2) { const [x, z] = R.toWorld(u, v); pts.push([x, p.y, z]); } }
    const cx = st.plan.cx, cz = st.plan.cz; const blds = B.Towns ? B.Towns.buildingsAt(cx, cz, 180) : [];
    const towns = new Set(), pen = new Set();
    for (const b of blds) { const P = b.pts; let x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18; for (let i = 0; i < P.length; i += 2) { x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); z0 = Math.min(z0, P[i + 1]); z1 = Math.max(z1, P[i + 1]); }
      if (pts.some(([x, , z]) => x > x0 && x < x1 && z > z0 && z < z1 && inPoly(P, x, z))) towns.add(`${b.kind} ${b.height}m @${b.x.toFixed(0)},${b.z.toFixed(0)}`); }
    const shown = (o) => { for (let q = o; q; q = q.parent) if (!q.visible) return false; return true; };
    for (const [x, y, z] of pts) { rc.set(new THREE.Vector3(x, y + 0.3, z), up); rc.far = 3.7; const h = rc.intersectObjects(foreign, true).find(q => shown(q.object)); if (h) pen.add(h.object.name || h.object.parent && h.object.parent.name || '?'); }
    out.push({ id, n: pts.length, towns: [...towns].slice(0, 8), peninsula: [...pen].slice(0, 8) });
  }
  return out.filter(o => o.state || (o.towns && o.towns.length) || (o.peninsula && o.peninsula.length)).concat([{ checked: out.length }]);
}
