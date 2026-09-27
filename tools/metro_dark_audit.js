// Large near-black station surfaces a walker can see (stations QA, M3.7; in the page as a metro_shots evalFile, one
// headless Chrome). For every station listed (default: all), walker views on every platform (a fifth, the middle and
// four fifths along it, on a spot with floor under it and no wall within 0.6 m; eye 1.65 m over the floor; looking along
// the platform both ways, 65 degrees) and on the concourse / mezzanine where there is one. Each view is drawn with the
// station alone (the shot's solo mode: no trains, people, tunnels or world around it), read back, and cut into a grid of
// cells; every cell darker than `dark` (mean sRGB luma) is traced into the station: when its first opaque hit is a station
// surface (the station material: not a sign, a departure board, a lamp or glass) of a finish that is not black by design
// (albedo luma >= 0.04, or a metal), the cell is "unlit". Unlit cells are grouped (4-neighbours) into regions; a region of
// at least `minArea` of the frame is a defect. Openings (a tunnel mouth, the street, the sky) are not station surfaces and
// never count; neither do black finishes (rubber, the boards' housings) nor the instanced escalator steps' own ray tests
// (a ray passes through the steps: their pixels count by the surface behind them, inside the escalator); other instanced
// meshes are traced with their instances; the station's crowd is moved off the camera's layer for the audit.
// Also a rider on every escalator (esc: false to skip): on its lower comb looking up the run at its head, and on its upper
// comb looking down it. (only: 'walk' | 'esc': just those views)
// Each region gets a class by its commonest surface (see cls below): 'unlit' is the defect (a lit finish drawn
// near-black), 'dark' a dark finish in shade (by design), 'track' the trackway / a lip's recess below a platform view,
// 'close' a camera within 1 m of the surface. Two runs, a halves split and the before/after numbers: notes/bart/stations.md
// (M3.7).
// args { ids, t: '12:00', grid: [48, 27], dark: 0.05, minArea: 0.004, frames: 16, first: 45, conc: true, esc: true, keepViews: 3,
//        views: [{ id, u, v, y, yaw }] (instead of the walker views: exactly these, station frame, y = the eye) }
// Returns { total: { stations, views, defects, unlitFrac }, stations: [{ id, views, defects, unlit, worst: [...] }] }.
async (B, a) => {
  const M = B.MetroStations, E = B.Env, THREE_ = THREE, sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const GX = (a.grid || [48, 27])[0], GY = (a.grid || [48, 27])[1], DARK = a.dark ?? 0.05, MINA = a.minArea ?? 0.004;
  const KN = ['PLAIN', 'TILE', 'TERRAZZO', 'CONCRETE', 'TACTILE', 'GRANITE', 'BRICK', 'PANEL', 'COFFER', 'NOSING', 'STEEL', 'PAINT', 'PAVING', 'COPING', 'RUBBER', 'PLASTER', 'WOOD', 'CORRUG', 'FLUTED', 'BOARDFORM', 'ASPHALT', 'GLASSBLOCK', 'MOSAIC', 'GRATING', 'BALLAST', 'HERRING', 'MARBLE', 'BUBBLE', 'CIRCLES'];
  if (a.t) { const [h, m] = a.t.split(':').map(Number); E.setClock(h * 3600 + m * 60); }
  const ids = a.views ? [...new Set(a.views.map(q => q.id))] : a.ids && a.ids.length ? a.ids : M.list.map(s => s.id);
  const segD = (px, pz, w) => { const ex = w.x1 - w.x0, ez = w.z1 - w.z0, l2 = ex * ex + ez * ez || 1e-9, t = Math.max(0, Math.min(1, ((px - w.x0) * ex + (pz - w.z0) * ez) / l2)); return Math.hypot(w.x0 + ex * t - px, w.z0 + ez * t - pz); };
  const out = [], tot = { stations: 0, views: 0, defects: 0, cells: 0, unlit: 0, classes: {} };
  for (const id of ids) {
    const st = M.byId[id]; if (!st) continue;
    const r0 = await M.shot(id, { u: 0, v: 0, h: 60, pitch: -1.2, settle: 2, solo: true });
    // (the station's crowd is in the stations' group, which solo keeps: people in dark clothes in front of a lit floor
    // would count as the floor; off the camera's layer for the audit)
    const crowd = B.StationCrowds && B.StationCrowds.people && B.StationCrowds.people.mesh; if (crowd) crowd.traverse(o => o.layers.set(7));
    if (r0.state !== 'built' || !st.res || !st.root) { out.push({ id, state: r0.state }); continue; }
    const R = st.res, pl = st.plan, W = st.walk;
    const uvOf = (x, z) => { const dx = x - pl.cx, dz = z - pl.cz; return [dx * pl.tx + dz * pl.tz, -dx * pl.tz + dz * pl.tx]; };
    const nearWall = (x, z, y, r) => W.walls.some(w => !(y + 1.0 < w.y0 || y + 0.3 > w.y1) && Math.min(Math.abs(w.x0 - x), Math.abs(w.x1 - x)) < 60 && segD(x, z, w) < r);
    const tangent = (u, v) => { const [x0, z0] = R.toWorld(u - 1, v), [x1, z1] = R.toWorld(u + 1, v), l = Math.hypot(x1 - x0, z1 - z0) || 1; return [(x1 - x0) / l, (z1 - z0) / l]; };
    // ---- the walker views
    const views = [];
    const spot = (level, u, vs, yF) => { for (const v of vs) { const [x, z] = R.toWorld(u, v), f = M.floorAt(x, yF + 0.3, z); if (f === null || Math.abs(f - yF) > 0.35 || nearWall(x, z, f, 0.6)) continue;
      const [tx, tz] = tangent(u, v); for (const s of [1, -1]) views.push({ id, level, u: +u.toFixed(1), v: +v.toFixed(2), x, z, y: f + 1.65, dx: s * tx, dz: s * tz }); return true; } return false; };
    // (given views: y the eye (or h over the plan's first platform), along +1 / -1 along the platform, or yaw absolute)
    if (a.views) for (const q of a.views.filter(q => q.id === id)) { const [x, z] = R.toWorld(q.u, q.v), [tx, tz] = tangent(q.u, q.v);
      const y = q.y !== undefined ? q.y : pl.plats[0].yRail + (pl.plats[0].ph || M.PLAT_H) + (q.h ?? 1.65), dx = q.yaw !== undefined ? Math.cos(q.yaw) : (q.along || 1) * tx, dz = q.yaw !== undefined ? Math.sin(q.yaw) : (q.along || 1) * tz;
      views.push({ id, level: q.level || 'given', u: q.u, v: q.v, x, z, y, dx, dz, given: true }); }
    else {
      if (a.only !== 'esc') R.crowd.plats.forEach((p, pi) => { for (const f of [0.2, 0.5, 0.8]) { const u = p.u0 + f * (p.u1 - p.u0), vm = (p.eL(u) + p.eR(u)) / 2;
        spot('p' + pi, u, [vm, vm - 1.8, vm + 1.8, p.eL(u) + 1.3, p.eR(u) - 1.3], p.y); } });
      const I = R.info || {};
      if (a.only !== 'esc' && a.conc !== false && isFinite(I.yCF) && isFinite(I.cu0) && isFinite(I.cu1)) for (const f of [0.3, 0.7]) spot('conc', I.cu0 + f * (I.cu1 - I.cu0), [0, -2, 2, -4, 4, -6, 6], I.yCF);
      // a rider on every escalator: on its lower comb looking up the run at its head, on its upper comb looking down
      if (a.esc !== false && a.only !== 'walk') (R.esc || []).forEach((e, k) => { const c = Math.cos(e.yaw), s = Math.sin(e.yaw), at = (x) => [e.x + c * x, e.z - s * x];
        const [x0, z0] = at(1.0), [x1, z1] = at(e.run), [x2, z2] = at(e.run - 1.0), [x3, z3] = at(0);
        const [u0, v0] = uvOf(x0, z0), [u2, v2] = uvOf(x2, z2);
        views.push({ id, level: 'esc' + k + 'up', u: +u0.toFixed(1), v: +v0.toFixed(2), x: x0, z: z0, y: e.y + 1.65, look: [x1, e.y + e.H + 1.2, z1] });
        views.push({ id, level: 'esc' + k + 'dn', u: +u2.toFixed(1), v: +v2.toFixed(2), x: x2, z: z2, y: e.y + e.H + 1.65, look: [x3, e.y + 0.6, z3] }); });
    }
    // ---- what the rays may hit: the station's opaque meshes (not the instanced steps)
    // (per view: the near-detail groups follow the camera; a hidden mesh is not drawn and must not catch a ray)
    const shown = (o) => { for (let q = o; q; q = q.parent) if (!q.visible) return false; return true; };
    // (instanced meshes (columns, furniture) are traced with their instances; only the escalator steps, placed by their
    // vertex shader, are not)
    const targetsNow = () => { st.root.updateMatrixWorld(true); const t = []; st.root.traverse(o => { if (!o.isMesh || o.name === 'escsteps') return; const m = o.material; if (!m || Array.isArray(m) || m.transparent || !shown(o)) return; t.push(o); }); return t; };
    const esc = (R.esc || []).map(e => ({ x: e.x, y: e.y, z: e.z, c: Math.cos(e.yaw), s: Math.sin(e.yaw), run: e.run, H: e.H }));
    const inEsc = (p) => esc.some(e => { const dx = p.x - e.x, dz = p.z - e.z, lx = dx * e.c - dz * e.s, lz = dx * e.s + dz * e.c; return lx > -2.5 && lx < e.run + 2.5 && Math.abs(lz) < 1.3 && p.y > e.y - 1.8 && p.y < e.y + e.H + 1.8; });
    const rc = new THREE_.Raycaster(), ndc = new THREE_.Vector2(), res1 = { id, views: views.length, defects: 0, classes: {}, unlit: 0, cells: 0, worst: [], byKey: {} };
    for (let k = 0; k < views.length; k++) {
      const V = views[k];
      const LK = V.look || [V.x + V.dx * 10, V.y - 0.2, V.z + V.dz * 10]; if (!V.dx) { const l = Math.hypot(LK[0] - V.x, LK[2] - V.z) || 1; V.dx = (LK[0] - V.x) / l; V.dz = (LK[2] - V.z) / l; }
      B.capture.cam = (t, c) => { c.position.set(V.x, V.y, V.z); c.up.set(0, 1, 0); c.lookAt(LK[0], LK[1], LK[2]); c.fov = 65; c.near = 0.05; c.updateProjectionMatrix(); };
      const nF = k === 0 ? (a.first || 45) : (a.frames || 16);
      for (let i = 0; i < nF; i++) { B.stepFrame(1); if (i % 8 === 7) await sleep(5); }
      B.stepFrame(1);
      const Rr = E.renderer, gl = Rr.getContext(); Rr.setRenderTarget(null);
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const cam = E.camera; cam.updateMatrixWorld(true); const targets = targetsNow();
      const cls = new Array(GX * GY).fill(0), hits = new Array(GX * GY).fill(null);
      let nDark = 0;
      for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
        const x0 = Math.floor(i * w / GX), x1 = Math.floor((i + 1) * w / GX), y0 = Math.floor(h - (j + 1) * h / GY), y1 = Math.floor(h - j * h / GY);
        let sum = 0, n = 0; for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const o = (y * w + x) * 4; sum += 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]; n++; }
        const L = sum / Math.max(1, n) / 255; if (L >= DARK) continue; nDark++;
        ndc.set((i + 0.5) / GX * 2 - 1, 1 - (j + 0.5) / GY * 2); rc.setFromCamera(ndc, cam); rc.far = 300;
        const hit = rc.intersectObjects(targets, false)[0]; if (!hit) { cls[j * GX + i] = 1; continue; }      // 1: nothing (an opening)
        const m = hit.object.material, g = hit.object.geometry, f = hit.face;
        if (!f) { cls[j * GX + i] = 2; continue; }
        if (!(m.userData && m.userData.sk)) { cls[j * GX + i] = m.map ? 3 : 2; continue; }                    // 2: lamp/other, 3: sign or board
        const C3 = g.attributes.color, S4 = g.attributes.aSurf; const kind = S4 ? Math.round(S4.getX(f.a)) : 0;
        const alb = C3 ? 0.2126 * C3.getX(f.a) + 0.7152 * C3.getY(f.a) + 0.0722 * C3.getZ(f.a) : 0.5;
        const metal = kind === 10 ? 1 : kind === 23 ? 0.8 : m.metalness;
        if (alb < 0.04 && metal < 0.5) { cls[j * GX + i] = 4; continue; }                                    // 4: black by design
        cls[j * GX + i] = 5;                                                                                   // 5: unlit
        const n3 = f.normal.clone().transformDirection(hit.object.matrixWorld);
        hits[j * GX + i] = { key: `${KN[kind] || kind}|${(hit.object.parent && hit.object.parent.name || '?').replace('zone-', '')}|m${metal.toFixed(1)}|${n3.dot(rc.ray.direction) > 0 ? 'back' : n3.y > 0.5 ? 'up' : n3.y < -0.5 ? 'down' : 'side'}|a${alb.toFixed(2)}`, p: hit.point.clone(), d: hit.distance };
      }
      // regions of unlit cells
      const seen = new Uint8Array(GX * GY); let unl = 0;
      for (let c0 = 0; c0 < GX * GY; c0++) { if (cls[c0] !== 5 || seen[c0]) continue;
        const q = [c0]; seen[c0] = 1; const cells = []; while (q.length) { const c = q.pop(); cells.push(c); const i = c % GX, j = (c / GX) | 0;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= GX || jj >= GY) continue; const cc = jj * GX + ii; if (cls[cc] === 5 && !seen[cc]) { seen[cc] = 1; q.push(cc); } } }
        unl += cells.length; const frac = cells.length / (GX * GY); if (frac < MINA) continue;
        const keys = {}; let nE = 0, ci = 0, cj = 0; for (const c of cells) { const H = hits[c]; keys[H.key] = (keys[H.key] || 0) + 1; if (inEsc(H.p)) nE++; ci += c % GX; cj += (c / GX) | 0; }
        ci /= cells.length; cj /= cells.length; let best = cells[0], bd = 1e9; for (const c of cells) { const dd = (c % GX - ci) ** 2 + (((c / GX) | 0) - cj) ** 2; if (dd < bd) { bd = dd; best = c; } }
        const H = hits[best], [hu, hv] = uvOf(H.p.x, H.p.z), top = Object.entries(keys).sort((x, y) => y[1] - x[1]);
        // the region's class, by its commonest surface: 'close' (the camera within 1 m of it: a spot against a post),
        // 'track' (a platform view's region below the walker's floor by > 0.25 m: the trackway, the recess under a lip),
        // 'unlit' (a finish of albedo >= 0.12, or a metal of that colour, drawn near-black: the defect), 'dark' (a dark
        // finish, albedo 0.04-0.12: near-black in shade, by design)
        const rAlb = +(/\|a([0-9.]+)$/.exec(top[0][0]) || [0, 0])[1];
        const rCls = H.d < 1.0 ? 'close' : V.level[0] === 'p' && H.p.y < V.y - 1.65 - 0.25 ? 'track' : rAlb >= 0.12 ? 'unlit' : 'dark';
        res1.defects++; res1.classes[rCls] = (res1.classes[rCls] || 0) + 1; for (const [kk, nn] of top) res1.byKey[kk] = (res1.byKey[kk] || 0) + nn;
        res1.worst.push({ view: k, level: V.level, cls: rCls, at: [V.u, V.v, +V.y.toFixed(2)], yaw: +Math.atan2(V.dz, V.dx).toFixed(3), frac: +frac.toFixed(3), esc: +(nE / cells.length).toFixed(2), key: top[0][0], keys: top.slice(0, 3).map(([kk, nn]) => kk + ':' + nn), hit: [+hu.toFixed(1), +hv.toFixed(1), +H.p.y.toFixed(2)], d: +H.d.toFixed(1) });
      }
      res1.unlit += unl; res1.cells += GX * GY;
      V.dark = +(nDark / (GX * GY)).toFixed(3); V.unlit = +(unl / (GX * GY)).toFixed(3);
    }
    res1.worst.sort((x, y) => y.frac - x.frac); res1.worst = res1.worst.slice(0, a.keepViews ?? 3 * 2);
    res1.unlitFrac = +(res1.unlit / Math.max(1, res1.cells)).toFixed(4); delete res1.unlit; delete res1.cells;
    res1.viewList = views.map(V => [V.level, V.u, V.v, +V.y.toFixed(2), +Math.atan2(V.dz, V.dx).toFixed(3), V.dark, V.unlit]);
    out.push(res1); tot.stations++; tot.views += views.length; tot.defects += res1.defects; tot.cells += views.length; tot.unlit += res1.unlitFrac * views.length;
    for (const [c, n] of Object.entries(res1.classes)) tot.classes[c] = (tot.classes[c] || 0) + n;
  }
  B.capture.before = null; if (M.debug) M.debug.showAll = false;
  { const crowd = B.StationCrowds && B.StationCrowds.people && B.StationCrowds.people.mesh; if (crowd) crowd.traverse(o => o.layers.set(0)); }
  return { total: { stations: tot.stations, views: tot.views, defects: tot.defects, classes: tot.classes, unlitFrac: +(tot.unlit / Math.max(1, tot.cells)).toFixed(4) }, stations: out };
}
