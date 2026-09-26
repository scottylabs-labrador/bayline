// Surfaces riders would see from behind (culled, so a hole) inside the stations: run in the page by
// tools/metro_shots.mjs: { "name", "evalFile": this file, "args": { "ids": [...], "rays": 72 } }. From viewpoints on
// every platform (every 25 m, eye height) and the concourse, rays in a ring (and tilted up and down) are cast against
// the station's own meshes with their materials made double-sided for the test; a first hit on a triangle's back
// (its winding normal facing away from the viewer) within 35 m is a surface wound the wrong way. The end walls that
// faced out of the box were found this way. Returns [{ id, views, rays, back: [{ zone, mesh, at: [u?], n }] }].
async (B, a) => {
  const M = B.MetroStations, out = [];
  const ids = a.ids && a.ids.length ? a.ids : M.list.map(s => s.id);
  const NR = a.rays || 24; const t0 = performance.now();
  for (const id of ids) {
    const st = M.byId[id]; if (!st) continue;
    const r = await M.shot(id, { u: 0, v: 0, h: 60, pitch: -1.2, settle: 4 });
    if (r.state !== 'built' || !st.res || !st.res.crowd) { out.push({ id, state: r.state }); continue; }
    const R = st.res, root = st.root; root.updateMatrixWorld(true);
    const meshes = []; root.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o.material && !Array.isArray(o.material)) meshes.push(o); });
    const saved = meshes.map(m => m.material.side); for (const m of meshes) m.material.side = THREE.DoubleSide;
    const views = [];
    for (const p of R.crowd.plats) for (let u = p.u0 + 15; u <= p.u1 - 15; u += (a.step || 45)) { const [x, z] = R.toWorld(u, (p.eL(u) + p.eR(u)) / 2); views.push([x, p.y + 1.65, z]); }
    const info = st.res.info; if (info && isFinite(info.yCF) && info.cu0 !== undefined) for (const u of [info.cu0 + 4, (info.cu0 + info.cu1) / 2, info.cu1 - 4]) { const [x, z] = R.toWorld(u, 0); views.push([x, info.yCF + 1.65, z]); }
    const rc = new THREE.Raycaster(); rc.far = 35; const bad = new Map(); let nr = 0; const n = new THREE.Vector3(), d = new THREE.Vector3();
    for (const [x, y, z] of views) for (let k = 0; k < NR; k++) for (const el of [-0.35, 0, 0.3]) {
      const az = (k / NR) * Math.PI * 2; d.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
      rc.set(new THREE.Vector3(x, y, z), d); nr++;
      const h = rc.intersectObjects(meshes, false)[0]; if (!h || !h.face) continue;
      n.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      if (n.dot(d) > 0.2) { const mt = h.object.material, kind = mt.map ? 'textured(sign/board)' : mt.userData && mt.userData.sk ? 'station' : mt.type; const key = (h.object.parent ? h.object.parent.name : '') + '/' + kind; const b = bad.get(key) || { zone: h.object.parent && h.object.parent.name, kind, n: 0, pts: [] }; b.n++; if (b.pts.length < 3) b.pts.push(h.point.toArray().map(v => +v.toFixed(1))); bad.set(key, b); }
    }
    meshes.forEach((m, i) => { m.material.side = saved[i]; });
    out.push({ id, ms: Math.round(performance.now() - t0), views: views.length, rays: nr, back: [...bad.values()].filter(b => b.n >= 3).sort((p, q) => q.n - p.n).slice(0, 6) });
  }
  return out;
}
