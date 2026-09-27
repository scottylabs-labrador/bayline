// Blank sign backs a walker can see (stations QA; run offline: `node tools/metro_offline.mjs eval tools/metro_sign_backs.js
// '{"ids": [...]}'`, or in the page as a metro_shots evalFile). Every station built; in its sign meshes (the atlas
// material) a one-sided sign's back that is one plain navy quad as large as its face (UVs in the atlas' navy corner) is
// looked at from walk floors (the metro's, and the Peninsula's platforms) 2 to 20 m behind it, straight and up to 75
// degrees aside: eye 1.6 m over the floor, a clear line of sight (no other opaque mesh, nor another sign, in front of
// it). A back with the wordmark (M3.5) is navy bands around the wordmark: none of them is as large as the face.
// Returns { stations, backs (blank backs), exposed, byRegion, by, list: [{ id, region, u, v, y, w, from }] }.
async (B, a) => {
  const M = B.MetroStations, ids = a.ids && a.ids.length ? a.ids : M.list.map(s => s.id);
  const AW = 2048, AH = 1024, R = { name: [0, 0, 1024, 192], nameS: [1024, 0, 1024, 128], frieze: [0, 192, 2048, 128], p1: [0, 320, 1024, 128], p2: [1024, 320, 1024, 128], p3: [0, 448, 1024, 128], p4: [1024, 448, 1024, 128],
    exit: [0, 576, 512, 128], gates: [512, 576, 512, 128], esc: [1024, 576, 512, 128], elev: [1536, 576, 512, 128], word: [0, 704, 1024, 128], totem: [1024, 704, 256, 320], map: [1280, 704, 768, 320], info: [0, 832, 1024, 192] };
  // (the atlas is drawn with flipY: v = 1 - y / AH)
  const regionOf = (u0, u1, v0, v1) => { for (const [k, [x, y, w, h]] of Object.entries(R)) { if (Math.abs(x / AW - u0) > 0.004 || Math.abs((x + w) / AW - u1) > 0.004) continue;
    if (Math.abs(1 - (y + h) / AH - v0) < 0.004 && Math.abs(1 - y / AH - v1) < 0.004) return k; } return '?'; };
  const out = [], by = {}, byRegion = {}; let nBack = 0, nSt = 0;
  for (const id of ids) {
    const st = M.byId[id]; if (!st) continue; const r = await M.shot(id); if (r.state !== 'built' || !st.root) continue; nSt++;
    const root = st.root; root.updateMatrixWorld(true);
    const occ = [], signs = [];
    root.traverse(o => { if (!o.isMesh || o.isInstancedMesh || !o.material || Array.isArray(o.material)) return; const m = o.material;
      if (m.map && m.emissiveMap === m.map) signs.push(o); if (m.transparent && (m.opacity === undefined || m.opacity < 0.9)) return; occ.push(o); });
    const saved = occ.map(m => m.material.side); for (const m of occ) m.material.side = THREE.DoubleSide;
    const rc = new THREE.Raycaster(), pl = st.plan;
    for (const sm of signs) { const g = sm.geometry, P = g.attributes.position, N = g.attributes.normal, UV = g.attributes.uv; if (!P || !UV) continue;
      let face = null;
      for (let q = 0; q + 3 < P.count; q += 4) {
        let u0 = 1, u1 = 0, v0 = 1, v1 = 0; for (let k = 0; k < 4; k++) { const u = UV.getX(q + k), v = UV.getY(q + k); u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
        const w = Math.hypot(P.getX(q + 1) - P.getX(q), P.getZ(q + 1) - P.getZ(q)), h = Math.abs(P.getY(q + 2) - P.getY(q + 1));
        // a face (the wordmark of a back, MetroSigns' region 'back' at x 1408..1664 px, is not one)
        if (u1 - u0 > 0.01 || v1 - v0 > 0.01) { if (!(Math.abs(u0 - 1408 / AW) < 0.004 && Math.abs(u1 - 1664 / AW) < 0.004)) face = { w, h, region: regionOf(u0, u1, v0, v1) }; continue; }
        // a navy quad: a blank back only when it is as large as the face before it (a band around the wordmark is not)
        if (!face || w * h < 0.9 * face.w * face.h) continue;
        const fr = face; face = null; nBack++;
        const c = new THREE.Vector3(); for (let k = 0; k < 4; k++) c.add(new THREE.Vector3(P.getX(q + k), P.getY(q + k), P.getZ(q + k))); c.multiplyScalar(0.25).applyMatrix4(sm.matrixWorld);
        const n = new THREE.Vector3(N.getX(q), N.getY(q), N.getZ(q)).transformDirection(sm.matrixWorld); n.y = 0; if (n.lengthSq() < 1e-6) continue; n.normalize();
        let seen = null;
        for (const ang of [0, 0.5, -0.5, 1.0, -1.0, 1.3, -1.3]) { const cs = Math.cos(ang), sn = Math.sin(ang), dx = n.x * cs - n.z * sn, dz = n.z * cs + n.x * sn;
          for (const d of [2, 3.5, 5, 7, 9.5, 12, 15, 20]) { const x = c.x + dx * d, z = c.z + dz * d, fm = M.floorAt(x, c.y, z), fp = B.Stations && B.Stations.platformY ? B.Stations.platformY(x, z) : null;
            const f = fm !== null && (fp === null || fm >= fp) ? fm : fp; if (f === null || c.y - f < 0.8 || c.y - f > 7) continue;
            const eye = new THREE.Vector3(x, f + 1.6, z), dir = c.clone().sub(eye), L = dir.length(); dir.divideScalar(L); rc.set(eye, dir); rc.far = L + 0.1;
            if (!rc.intersectObjects(occ, false).some(hh => hh.distance < L - 0.02)) { seen = { d, ang, floor: +f.toFixed(2), peninsula: f !== fm }; break; } }
          if (seen) break; }
        if (!seen) continue;
        const dx0 = c.x - pl.cx, dz0 = c.z - pl.cz;
        by[id] = (by[id] || 0) + 1; byRegion[fr.region] = (byRegion[fr.region] || 0) + 1;
        out.push({ id, region: fr.region, u: +(dx0 * pl.tx + dz0 * pl.tz).toFixed(1), v: +(-dx0 * pl.tz + dz0 * pl.tx).toFixed(1), y: +c.y.toFixed(2), w: +fr.w.toFixed(2), from: seen }); } }
    occ.forEach((m, i) => { m.material.side = saved[i]; });
  }
  return { stations: nSt, backs: nBack, exposed: out.length, byRegion, by, list: out.slice(0, a.max || 200) };
}
