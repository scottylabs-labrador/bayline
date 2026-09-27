// Road-traffic lane audit (world workstream, M3.7): page-side. At each site [name, x, z] of window.__SITES the camera flies
// over it, the towns there build in full detail, the traffic re-streams its lanes (setRoads, timed), and every lane point
// (every 4 m) within 600 m is compared with the drawn ground: the top of the towns ribbons (their ground meshes; the
// surface nearest the lane point in height, so a road under an overpass keeps its own), else the terrain; modelled bridge
// decks are skipped. Logs one 'AUDIT {site, n, above, below, maxDy, worst, lanes, msRoads, ...}' line per site.
//   node tools/shot.mjs '<page>#auto&t=12:00&w=clear&q=high' out.png --gpu --w 640 --h 400 --wait 200 \
//     --eval "window.__SITES = [[\"WCRK\", -2335.6, -56084.2]]; $(cat tools/metro_world/lane_audit.js)"
(async () => {
  const B = () => window.__bayline, sleep = ms => new Promise(r => setTimeout(r, ms));
  await new Promise(r => { const f = () => (B() && B().World && B().World.traffic && B().Towns && window.__towns && B().Player) ? r(1) : setTimeout(f, 400); f(); });
  await sleep(4000);
  const Ter = B().Terrain, Tw = B().Towns, T = B().World.traffic, P = B().Player, R = 600, out = [];
  const LM = typeof Landmarks !== 'undefined' ? Landmarks : (B().Landmarks || null);
  function surface(x0, z0, r) {
    const C = 4, cells = new Map(); let nt = 0;
    for (const t of window.__towns.tiles.values()) {
      if (!t.gndMesh || t.ox > x0 + r || t.ox + 800 < x0 - r || t.oz > z0 + r || t.oz + 800 < z0 - r) continue;
      const g = t.gndMesh.geometry, A = g.attributes.position.array, I = g.index ? g.index.array : null, n = I ? I.length / 3 : A.length / 9;
      for (let k = 0; k < n; k++) {
        const ia = I ? I[k * 3] : k * 3, ib = I ? I[k * 3 + 1] : k * 3 + 1, ic = I ? I[k * 3 + 2] : k * 3 + 2;
        const ax = A[ia * 3] + t.ox, ay = A[ia * 3 + 1], az = A[ia * 3 + 2] + t.oz, bx = A[ib * 3] + t.ox, by = A[ib * 3 + 1], bz = A[ib * 3 + 2] + t.oz, cx = A[ic * 3] + t.ox, cy = A[ic * 3 + 1], cz = A[ic * 3 + 2] + t.oz;
        const ar = (bx - ax) * (cz - az) - (cx - ax) * (bz - az); if (Math.abs(ar) < 0.05) continue;           // (vertical: curbs, parapets)
        if (Math.min(ax, bx, cx) > x0 + r || Math.max(ax, bx, cx) < x0 - r || Math.min(az, bz, cz) > z0 + r || Math.max(az, bz, cz) < z0 - r) continue;
        const tri = [ax, ay, az, bx, by, bz, cx, cy, cz, ar]; nt++;
        for (let gz = Math.floor(Math.min(az, bz, cz) / C); gz <= Math.floor(Math.max(az, bz, cz) / C); gz++) for (let gx = Math.floor(Math.min(ax, bx, cx) / C); gx <= Math.floor(Math.max(ax, bx, cx) / C); gx++) {
          const key = gx * 100003 + gz; let a = cells.get(key); if (!a) cells.set(key, a = []); a.push(tri); }
      }
    }
    // (the drawn surface nearest the lane point in height: a road under an overpass keeps its own ribbon)
    return { nt, at(x, z, py) { const a = cells.get(Math.floor(x / C) * 100003 + Math.floor(z / C)); if (!a) return null; let best = null;
      for (const t of a) { const [ax, ay, az, bx, by, bz, cx, cy, cz, ar] = t;
        const w1 = ((bx - x) * (cz - z) - (cx - x) * (bz - z)) / ar, w2 = ((cx - x) * (az - z) - (ax - x) * (cz - z)) / ar, w3 = 1 - w1 - w2;
        if (w1 < -1e-4 || w2 < -1e-4 || w3 < -1e-4) continue; const y = w1 * ay + w2 * by + w3 * cy; if (best === null || Math.abs(y - py) < Math.abs(best - py)) best = y; }
      return best; } };
  }
  for (const s of window.__SITES) {
    const [name, x, z] = s; const t0 = performance.now();
    P.setMode('fly'); P.fly.x = x; P.fly.z = z; P.fly.y = Ter.h(x, z) + 160; P.look.pitch = -1.1;
    // wait for the towns tiles around to be built in full detail and the heights under them loaded
    let last = -1, same = 0;
    for (let k = 0; k < 40; k++) { await sleep(900); P.fly.y = Ter.h(x, z) + 160; let c = 0;
      for (const t of window.__towns.tiles.values()) if (t.gndLvl === 2 && Math.hypot(t.ox + 400 - x, t.oz + 400 - z) < R + 600) c++;
      if (c === last && c > 0) { if (++same >= 3) break; } else same = 0; last = c; }
    const ts = performance.now(); T.setRoads(Tw.roadsNear(x, z, 1500), { x, z }, Tw.areasNear ? Tw.areasNear(x, z, 500, 3) : []); const msRoads = performance.now() - ts;
    const S = surface(x, z, R + 20), G = T.group.position;
    let n = 0, above = 0, below = 0, onRibbon = 0, offBr = 0, worst = [];
    for (const ln of T.lanes) { const Q = ln.pts, m = Q.length / 3;
      for (let i = 0; i + 1 < m; i++) {
        const ax = Q[i * 3] + G.x, ay = Q[i * 3 + 1] + G.y, az = Q[i * 3 + 2] + G.z, bx = Q[i * 3 + 3] + G.x, by = Q[i * 3 + 4] + G.y, bz = Q[i * 3 + 5] + G.z;
        const L = Math.hypot(bx - ax, bz - az), k = Math.max(1, Math.ceil(L / 4));
        for (let j = 0; j < k; j++) { const u = j / k, px = ax + (bx - ax) * u, py = ay + (by - ay) * u, pz = az + (bz - az) * u;
          if (Math.hypot(px - x, pz - z) > R) continue;
          if (LM && LM.deckAt && LM.deckAt(px, pz, (bx - ax) / (L || 1), (bz - az) / (L || 1)) !== null) continue;
          const rs = S.at(px, pz, py), ref = rs !== null ? rs : Ter.h(px, pz); if (rs !== null) onRibbon++;
          const dy = py - ref; n++; if (dy > 0.5) above++; else if (dy < -0.5) below++;
          if (Math.abs(dy) > 0.5) { if (ln.bridge) offBr++; worst.push([+dy.toFixed(2), +(37.40 - pz / 110985.1).toFixed(5), +(-122.10 + px / 88542.2).toFixed(5), rs !== null ? 'ribbon' : 'terrain', ln.bridge === undefined ? '?' : ln.bridge ? 'bridge' : 'road', ln.cls]); } } } }
    worst.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
    out.push({ site: name, n, above, below, offBridge: offBr, onRibbon, maxDy: worst.length ? worst[0][0] : 0, worst: worst.slice(0, 5), lanes: T.lanes.length, msRoads: +msRoads.toFixed(1), tris: S.nt, sec: +((performance.now() - t0) / 1000).toFixed(1) });
    console.log('AUDIT ' + JSON.stringify(out[out.length - 1]));
  }
  return 'done ' + out.length;
})()
