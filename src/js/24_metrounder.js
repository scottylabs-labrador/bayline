// Under (Bayline Metro, infra workstream): the underground engine. Inert unless #metro=1 (Under.enabled).
//  - Cells (tunnel segments, station levels, entrance shafts) and portals (openings) between them and to the outdoors.
//  - Portal visibility: every frame, from the camera's cell (or, outdoors, through every opening in view), the chain of
//    openings is walked with a shrinking screen rectangle (classic portal culling). Cells nobody can see are not drawn,
//    and while no opening to the outdoors is in view the whole outdoor world (terrain, towns, trees, sky, ...) is skipped.
//  - The under map: a camera-centred, two-level clipmap (1 m over 1 km, 4 m over 4 km) of every underground volume,
//    rasterised on the GPU with MAX blending: per column the lowest floor and highest ceiling, the daylight that reaches
//    in (portal ramps, entrance-shaft ramps), the cells' ambient light, and terrain cut-outs. Every lit built-in material
//    reads it through a shared lighting-chunk patch (THREE.ShaderChunk, compiled only with #metro=1): inside a volume the
//    sun, moon, sky, ambient and environment reflections are scaled by the daylight there and the cell's ambient is
//    added, so a train in the Transbay Tube is never sunlit, whatever its material. The post pipeline reads it too (no
//    fog, aerial haze or cloud shadows underground) and the terrain drops fragments inside volumes and cuts.
//  - Exposure: underground the frame exposure blends to a fixed 1.0 (day and night) and eye adaptation may lift 2 EV.
// API + GLSL hook: notes/bart/infra.md ("Under").
//   Under.addCell({ id, poly | strip, floor, ceil, ambient, daylight, group })   Under.addPortal({ id, a, b, quad, probe })
//   Under.addCut({ id, poly, below })   Under.remove(id)   Under.cellAt(x, y, z)   Under.keep(obj)   Under.state
//   Under.update(camera) (per frame, after the camera is placed)   Under.preRender() / Under.postRender() (around draw)
const Under = (() => {
  const enabled = typeof Metro !== 'undefined' ? Metro.on : (() => { try { return new URLSearchParams(location.hash.slice(1)).get('metro') === '1'; } catch (e) { return false; } })();   // (the switch: 18_metro.js)
  const state = { cell: null, failsafe: null, depth: 0, outsideVisible: true, visible: new Set(), daylight: 1, exposure: 1.0, maxBoost: 4.0 };
  const stats = { cells: 0, portals: 0, cuts: 0, visCells: 0, mapDraws: 0, mapMs: 0, culled: 0, walk: 0, failsafe: null };
  if (!enabled) {
    const nop = () => {};
    return { enabled: false, state, stats, addCell: nop, addPortal: nop, addCut: nop, remove: nop, cellAt: () => null, cutAt: () => false, keep: nop, outdoor: nop, update: nop, preRender: nop, postRender: nop,
      dayAt: () => 1, cells: new Map(), debug: {} };
  }
  const R = Env.renderer;
  // developer diagnostics (#debug in the hash or ?dev in the query): a visitor's console stays clean
  const DEBUG = (() => { try { return /(^|&)debug(=|&|$)/.test(location.hash.slice(1)) || /(^|&|\?)dev(=|&|$)/.test(location.search); } catch (e) { return false; } })();
  const INTERIOR_EXPOSURE = 1.0, MAX_BOOST = 4.0;       // the contract with STATIONS (notes/bart/infra.md, "Exposure")
  const PAD = 6.5;                                        // max footprint dilation (m, level 1): bboxes include it
  const NONE = -1e5;                                      // "no value" sentinel in footprint attributes

  // ------------------------------------------------------------------ registry
  const cells = new Map(), portals = new Map(), cuts = new Map();
  const keepSet = new WeakSet();
  const GRID = 64, grid = new Map();                      // 64 m buckets -> Set of cell ids (bbox overlap)
  const gk = (i, j) => i * 100003 + j;
  // coarse counts (2 km cells) of everything registered, so "anything near the camera" is O(1): away from it the map,
  // the shaders' map reads and the terrain cut test are all off
  const CG2 = 2048, coarse = new Map();
  function coarseAdd(bb, k) { for (let i = Math.floor(bb[0] / CG2); i <= Math.floor(bb[2] / CG2); i++) for (let j = Math.floor(bb[1] / CG2); j <= Math.floor(bb[3] / CG2); j++) { const key = gk(i, j), v = (coarse.get(key) || 0) + k; if (v > 0) coarse.set(key, v); else coarse.delete(key); } }
  function anyNear(x, z) { const ci = Math.floor(x / CG2), cj = Math.floor(z / CG2); for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) if (coarse.has(gk(ci + a, cj + b))) return true; return false; }
  function gridAdd(c) { coarseAdd(c.bb, 1); for (let i = Math.floor(c.bb[0] / GRID); i <= Math.floor(c.bb[2] / GRID); i++) for (let j = Math.floor(c.bb[1] / GRID); j <= Math.floor(c.bb[3] / GRID); j++) { const k = gk(i, j); let s = grid.get(k); if (!s) grid.set(k, s = new Set()); s.add(c.id); } }
  function gridDel(c) { coarseAdd(c.bb, -1); for (let i = Math.floor(c.bb[0] / GRID); i <= Math.floor(c.bb[2] / GRID); i++) for (let j = Math.floor(c.bb[1] / GRID); j <= Math.floor(c.bb[3] / GRID); j++) { const s = grid.get(gk(i, j)); if (s) { s.delete(c.id); if (!s.size) grid.delete(gk(i, j)); } } }
  let dirty = true;

  function bboxOf(pts2) { let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const p of pts2) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; const z = p.length === 3 ? p[2] : p[1]; if (z < z0) z0 = z; if (z > z1) z1 = z; } return [x0, z0, x1, z1]; }
  // strip helper: per point floor/ceil (from the point's y and the strip's below/above) and daylight
  function stripRows(st) {
    const n = st.pts.length, below = st.below !== undefined ? st.below : 1.6, above = st.above !== undefined ? st.above : 6.5;
    const rows = [];
    // (aboveArr: a per-point ceiling above the point, e.g. a box under thin cover whose volume stops under the ground)
    for (let i = 0; i < n; i++) { const p = st.pts[i], ab = st.aboveArr && isFinite(st.aboveArr[i]) ? st.aboveArr[i] : above; rows.push({ x: p[0], y: p[1], z: p[2], floor: p[1] - below, ceil: p[1] + ab, day: st.day ? st.day[i] : 0 }); }
    return rows;
  }
  function addCell(o) {
    if (!o || !o.id) return;
    if (cells.has(o.id)) removeCell(o.id, true);
    // ambient: a number (hemisphere-light units) or an [r, g, b] (its luminance is used; the tint is the shared one)
    const amb = Array.isArray(o.ambient) ? 0.2126 * (+o.ambient[0] || 0) + 0.7152 * (+o.ambient[1] || 0) + 0.0722 * (+o.ambient[2] || 0) : (+o.ambient || 0);
    const c = { id: o.id, kind: o.kind || 'cell', poly: o.poly || null, strip: o.strip || null, floor: o.floor, ceil: o.ceil, ambient: isFinite(amb) ? amb : 0,
      daylight: o.daylight || null, group: o.group || null, terrain: o.terrain !== false, zone: o.zone ? [].concat(o.zone) : null, mesh: null };
    if (c.strip) { c.rows = stripRows(c.strip); c.half = c.strip.half || 3; const b = bboxOf(c.strip.pts); c.bb = [b[0] - c.half - PAD, b[1] - c.half - PAD, b[2] + c.half + PAD, b[3] + c.half + PAD];
      c.floor = Math.min(...c.rows.map(r => r.floor)); c.ceil = Math.max(...c.rows.map(r => r.ceil)); }
    else if (c.poly && c.poly.length >= 3) { const b = bboxOf(c.poly); c.bb = [b[0] - PAD, b[1] - PAD, b[2] + PAD, b[3] + PAD]; }
    else { if (DEBUG) console.warn('Under.addCell: a cell needs poly or strip', o.id); return; }
    if (!(isFinite(c.floor) && isFinite(c.ceil))) { if (DEBUG) console.warn('Under.addCell: floor/ceil', o.id); return; }
    c.mesh = footprintMesh(c, false); if (c.mesh) fpScene.add(c.mesh);
    cells.set(c.id, c); gridAdd(c);
    stats.cells = cells.size; dirty = true; cutList = null;
  }
  function removeCell(id, keepPortals) {
    const c = cells.get(id); if (!c) return false;
    gridDel(c); if (c.mesh) { fpScene.remove(c.mesh); c.mesh.geometry.dispose(); }
    cells.delete(id);
    if (!keepPortals) for (const [pid, p] of portals) if (p.a === id || p.b === id) portals.delete(pid);
    stats.cells = cells.size; stats.portals = portals.size; dirty = true; cutList = null; return true;
  }
  const V3 = (p) => new THREE.Vector3(p[0], p[1], p[2]);
  function addPortal(o) {
    if (!o || !o.quad || o.quad.length < 3) return;
    const id = o.id || ('pt:' + o.a + '>' + (o.b === null ? 'out' : o.b) + ':' + portals.size);
    if (portals.has(id)) remove(id);
    const q = o.quad.map(V3), c = new THREE.Vector3(); for (const v of q) c.add(v); c.multiplyScalar(1 / q.length);
    let r = 0; for (const v of q) r = Math.max(r, v.distanceTo(c));
    const p = { id, a: o.a, b: o.b === undefined ? null : o.b, quad: q, center: c, radius: r, probe: o.probe ? V3(o.probe) : null, rb: null, dead: !!o.dead };
    portals.set(id, p);
    stats.portals = portals.size;
  }
  function addCut(o) {
    if (!o || !o.id || !o.poly || o.poly.length < 3) return;
    if (cuts.has(o.id)) remove(o.id);
    const c = { id: o.id, poly: o.poly, below: +o.below, bb: bboxOf(o.poly) };
    c.mesh = footprintMesh(c, true); if (c.mesh) fpScene.add(c.mesh);
    cuts.set(c.id, c); coarseAdd(c.bb, 1); stats.cuts = cuts.size; dirty = true; cutList = null;
  }
  function remove(id) {
    if (cells.has(id)) return removeCell(id);
    if (portals.has(id)) { portals.delete(id); stats.portals = portals.size; return true; }
    if (cuts.has(id)) { const c = cuts.get(id); fpScene.remove(c.mesh); c.mesh.geometry.dispose(); coarseAdd(c.bb, -1); cuts.delete(id); stats.cuts = cuts.size; dirty = true; cutList = null; return true; }
    return false;
  }
  function keep(obj) { if (obj) { keepSet.add(obj); obj.userData.blUnderKeep = true; } return obj; }
  // objects deeper in a kept group that are nevertheless outdoors (a module's aerial guideway next to its tunnels): hidden
  // with the outdoor world while no opening to the outdoors is in view
  const outdoorSet = new Set();
  function outdoor(obj, on = true) { if (on) outdoorSet.add(obj); else outdoorSet.delete(obj); return obj; }

  // ------------------------------------------------------------------ point queries (CPU)
  function inPoly(poly, x, z) {
    let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j];
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) ins = !ins; }
    return ins;
  }
  // strip: nearest point on the centreline -> { d (lateral distance), t (row index + fraction) }
  // (beyond: metres past either end of the strip along its axis, 0 inside its length)
  function stripNear(c, x, z) {
    const R = c.rows, n = R.length; let bd = 1e18, bt = 0, beyond = 0;
    for (let i = 0; i + 1 < n; i++) { const a = R[i], b = R[i + 1], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
      const tr = ((x - a.x) * dx + (z - a.z) * dz) / L2, t = U.clamp(tr, 0, 1), px = a.x + dx * t - x, pz = a.z + dz * t - z, d = px * px + pz * pz;
      if (d < bd) { bd = d; bt = i + t; beyond = (i === 0 && tr < 0) ? -tr * Math.sqrt(L2) : (i === n - 2 && tr > 1) ? (tr - 1) * Math.sqrt(L2) : 0; } }
    return { d: Math.sqrt(bd), t: bt, beyond };
  }
  function rowAt(c, t) { const i = Math.min(c.rows.length - 2, Math.floor(t)), f = t - i, a = c.rows[i], b = c.rows[i + 1];
    return { floor: a.floor + (b.floor - a.floor) * f, ceil: a.ceil + (b.ceil - a.ceil) * f, day: a.day + (b.day - a.day) * f }; }
  const _near = new Set();
  function cellsNear(x, z) { _near.clear(); const s = grid.get(gk(Math.floor(x / GRID), Math.floor(z / GRID))); if (s) for (const id of s) _near.add(id); return _near; }
  // the cell containing (x, y, z) (the innermost/smallest if several), or null; pad widens every test (m)
  function cellAt(x, y, z, pad = 0) {
    let best = null, bestA = 1e18;
    for (const id of cellsNear(x, z)) {
      const c = cells.get(id); if (!c) continue;
      if (x < c.bb[0] - pad || x > c.bb[2] + pad || z < c.bb[1] - pad || z > c.bb[3] + pad) continue;
      if (c.strip) { const n = stripNear(c, x, z); if (n.d > c.half + pad || n.beyond > 0.05 + pad) continue; const r = rowAt(c, n.t); if (y < r.floor - 0.3 - pad || y > r.ceil + 0.3 + pad) continue; }
      else { if (y < c.floor - 0.3 - pad || y > c.ceil + 0.3 + pad) continue; if (!inPoly(c.poly, x, z)) continue; }
      const A = (c.bb[2] - c.bb[0]) * (c.bb[3] - c.bb[1]); if (A < bestA) { bestA = A; best = c.id; }
    }
    return best;
  }
  // is the ground at (x, z) cut away (a registered cut whose floor is below y, or an underground volume containing y)?
  // For modules that place things on the terrain (grass, trees, props): skip where this is true.
  function cutAt(x, z, y) {
    for (const c of cuts.values()) { if (x < c.bb[0] || x > c.bb[2] || z < c.bb[1] || z > c.bb[3]) continue; if (y > c.below && inPoly(c.poly, x, z)) return true; }
    return !!cellAt(x, y, z);
  }
  // daylight (0..1) at a point inside cell c (the same function the under map encodes)
  function dayAt(c, x, y, z) {
    if (!c) return 1;
    let d = 0;
    if (c.strip) d = rowAt(c, stripNear(c, x, z).t).day;
    if (c.daylight) { const [yb, yt] = c.daylight; if (yt > yb) d = Math.max(d, U.clamp((y - yb) / (yt - yb), 0, 1)); }
    return d;
  }

  // ------------------------------------------------------------------ the under map (GPU)
  // Atlas 2N x 2N (RGBA half float, linear): quadrant (0,0) level 0 map A, (1,0) level 0 map B, (0,1) level 1 A, (1,1) level 1 B.
  //   A = (ceil - refY, -(floor - refY), daylight along the cell (portal ramps), ambient)
  //   B = (-(yBot - refY), -(yTop - refY), -(cutBelow - refY), 0)       (entrance-shaft daylight ramp; terrain cut)
  // Everything is MAX-blended, so overlapping and stacked cells union correctly; empty columns hold -1e4.
  const N = 1024, LV = [{ texel: 1, half: 512, cx: 1e9, cz: 1e9, refY: 0, re: 176 }, { texel: 4, half: 2048, cx: 1e9, cz: 1e9, refY: 0, re: 704 }];
  // the fine level: 0.25 m over 128 m around the camera, only for the terrain's cut test (sharp edges at stair wells,
  // station entrances and portals up close); a separate 1024 x 512 target (A | B)
  const NF = 512, FL = { texel: 0.25, half: 64, cx: 1e9, cz: 1e9, refY: 0, re: 20 };
  const rtF = new THREE.WebGLRenderTarget(2 * NF, NF, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  const rt = new THREE.WebGLRenderTarget(2 * N, 2 * N, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsGeo = new THREE.BufferGeometry(); fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const clearMat = new THREE.ShaderMaterial({ uniforms: { uV: { value: new THREE.Vector4() } }, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: 'uniform vec4 uV; void main(){ gl_FragColor = uV; }' });
  const clearQuad = new THREE.Mesh(fsGeo, clearMat); clearQuad.frustumCulled = false; const clearScene = new THREE.Scene(); clearScene.add(clearQuad);
  const CLEAR_A = new THREE.Vector4(-1e4, -1e4, 0, 0), CLEAR_B = new THREE.Vector4(-1e4, -1e4, -1e4, 0);
  const fpMat = new THREE.ShaderMaterial({
    uniforms: { uXf: { value: new THREE.Vector4() }, uPass: { value: 0 }, uPad: { value: 1.5 } },
    depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    vertexShader: /* glsl */`
      attribute vec4 aA; attribute vec4 aB; attribute vec2 aE; uniform vec4 uXf; uniform float uPass; uniform float uPad; varying vec4 vV;
      float rel(float h, float none) { return h < -5.0e4 ? none : h - uXf.w; }
      void main() {
        if (uPass < 0.5) vV = vec4(rel(aA.x, -1.0e4), -rel(aA.y, 1.0e4), aA.z, aA.w);
        else vV = vec4(-rel(aB.x, 1.0e4), -rel(aB.y, 1.0e4), -rel(aB.z, 1.0e4), 0.0);
        vec2 p = position.xz + aE * uPad;
        gl_Position = vec4((p.x - uXf.x) * uXf.z, (p.y - uXf.y) * uXf.z, 0.0, 1.0);
      }`,
    fragmentShader: 'varying vec4 vV; void main(){ gl_FragColor = vV; }',
  });
  const fpScene = new THREE.Scene(); fpScene.matrixAutoUpdate = false;
  // footprint mesh of a cell or a cut: the polygon (triangulated) or strip, plus an outline band that the vertex shader
  // extrudes by the level's pad (aE = outward direction), so the union under MAX blending is the footprint dilated by
  // ~1.5 texels at every level. Attributes aA = (ceil, floor, day, ambient), aB = (yBot, yTop, cutBelow, 0)
  function footprintMesh(c, isCut) {
    const pos = [], A = [], B = [], E = [], idx = [];
    // (cuts are exact: no dilation, a hole exactly where it was asked for)
    const vtx = (x, z, a, b, ex = 0, ez = 0) => { pos.push(x, 0, z); A.push(a[0], a[1], a[2], a[3]); B.push(b[0], b[1], b[2], b[3]); E.push(isCut ? 0 : ex, isCut ? 0 : ez); return pos.length / 3 - 1; };
    const dl = c.daylight || null;
    const bOf = () => isCut ? [NONE, NONE, c.below, 0] : dl ? [dl[0], dl[1], NONE, 0] : [NONE, NONE, NONE, 0];
    const aOf = (row) => isCut ? [NONE, NONE, 0, 0] : row ? [row.ceil, row.floor, row.day, c.ambient] : [c.ceil, c.floor, 0, c.ambient];
    if (c.strip) {
      const R = c.rows, n = R.length; if (n < 2) return null;
      const w = c.half;
      for (let i = 0; i < n; i++) {
        const a = R[Math.max(0, i - 1)], b = R[Math.min(n - 1, i + 1)]; let dx = b.x - a.x, dz = b.z - a.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        const et = i === 0 ? -1 : i === n - 1 ? 1 : 0;                 // the end rows also extrude along the strip
        vtx(R[i].x - dz * w, R[i].z + dx * w, aOf(R[i]), bOf(), -dz + dx * et, dx + dz * et);
        vtx(R[i].x + dz * w, R[i].z - dx * w, aOf(R[i]), bOf(), dz + dx * et, -dx + dz * et);
        if (i > 0) { const k = 2 * i; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
      }
    } else {
      const P = c.poly, n = P.length, a = aOf(null), b = bOf();
      let tris; try { tris = THREE.ShapeUtils.triangulateShape(P.map(p => new THREE.Vector2(p[0], p[1])), []); } catch (e) { tris = []; }
      const base = pos.length / 3; for (const p of P) vtx(p[0], p[1], a, b); for (const t of tris) idx.push(base + t[0], base + t[1], base + t[2]);
      for (let i = 0; i < n; i++) {   // outline band (both sides, so the winding doesn't matter) and a square at each corner
        const p = P[i], q = P[(i + 1) % n]; let dx = q[0] - p[0], dz = q[1] - p[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        const k = pos.length / 3;
        vtx(p[0], p[1], a, b, dz, -dx); vtx(q[0], q[1], a, b, dz, -dx); vtx(q[0], q[1], a, b, -dz, dx); vtx(p[0], p[1], a, b, -dz, dx);
        idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
        const m = pos.length / 3; vtx(p[0], p[1], a, b, -1, -1); vtx(p[0], p[1], a, b, 1, -1); vtx(p[0], p[1], a, b, 1, 1); vtx(p[0], p[1], a, b, -1, 1);
        idx.push(m, m + 1, m + 2, m, m + 2, m + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aA', new THREE.Float32BufferAttribute(A, 4)); g.setAttribute('aB', new THREE.Float32BufferAttribute(B, 4));
    g.setAttribute('aE', new THREE.Float32BufferAttribute(E, 2)); g.setIndex(idx);
    const m = new THREE.Mesh(g, fpMat); m.frustumCulled = false; m.matrixAutoUpdate = false; m.userData.bb = c.bb; return m;
  }
  function drawMaps(cam) {
    const t0 = performance.now(), ac = R.autoClear, prevRT = R.getRenderTarget(); R.autoClear = false;
    for (let L = 0; L < 2; L++) {
      const q = LV[L];
      for (const m of fpScene.children) { const b = m.userData.bb; m.visible = !(b[2] < q.cx - q.half || b[0] > q.cx + q.half || b[3] < q.cz - q.half || b[1] > q.cz + q.half); }
      for (let pass = 0; pass < 2; pass++) {
        rt.viewport.set(pass * N, L * N, N, N); rt.scissor.set(pass * N, L * N, N, N); rt.scissorTest = true;
        R.setRenderTarget(rt);
        clearMat.uniforms.uV.value.copy(pass ? CLEAR_B : CLEAR_A); R.render(clearScene, orthoCam);
        fpMat.uniforms.uPass.value = pass; fpMat.uniforms.uPad.value = q.texel * 1.6; fpMat.uniforms.uXf.value.set(q.cx, q.cz, 1 / q.half, q.refY); R.render(fpScene, orthoCam);
        stats.mapDraws++;
      }
    }
    rt.scissorTest = false; rt.viewport.set(0, 0, 2 * N, 2 * N); rt.scissor.set(0, 0, 2 * N, 2 * N);
    { const q = FL; for (const m of fpScene.children) { const b = m.userData.bb; m.visible = !(b[2] < q.cx - q.half || b[0] > q.cx + q.half || b[3] < q.cz - q.half || b[1] > q.cz + q.half); }
      for (let pass = 0; pass < 2; pass++) {
        rtF.viewport.set(pass * NF, 0, NF, NF); rtF.scissor.set(pass * NF, 0, NF, NF); rtF.scissorTest = true; R.setRenderTarget(rtF);
        clearMat.uniforms.uV.value.copy(pass ? CLEAR_B : CLEAR_A); R.render(clearScene, orthoCam);
        fpMat.uniforms.uPass.value = pass; fpMat.uniforms.uPad.value = 0.4; fpMat.uniforms.uXf.value.set(q.cx, q.cz, 1 / q.half, q.refY); R.render(fpScene, orthoCam); }
      rtF.scissorTest = false; rtF.viewport.set(0, 0, 2 * NF, NF); rtF.scissor.set(0, 0, 2 * NF, NF); }
    R.setRenderTarget(prevRT); R.autoClear = ac;
    stats.mapMs = +(performance.now() - t0).toFixed(2);
  }

  // ------------------------------------------------------------------ shared uniforms + the lighting patch
  // (clone() returns the same object, so every material shares them: see 18_sunshade.js)
  // three.js refuses to clone render-target textures into built-in materials' uniforms (it nulls them), so every material
  // shares a plain placeholder texture instead, and after the first draw the placeholder is aliased to the render
  // target's GL texture (setTexture2D binds properties.__webglTexture; the placeholder never uploads: version stays 0)
  const mapTex = new THREE.Texture(); mapTex.name = 'under-map';
  function aliasMap() {
    const props = R.properties, src = props.get(rt.texture);
    if (!src.__webglTexture) return false;
    const dst = props.get(mapTex); dst.__webglTexture = src.__webglTexture; dst.__webglInit = true; dst.__version = mapTex.version;
    return true;
  }
  let aliased = false;
  const fineTex = new THREE.Texture(); fineTex.name = 'under-fine';
  function aliasFine() { const src = R.properties.get(rtF.texture); if (!src.__webglTexture) return false; const dst = R.properties.get(fineTex); dst.__webglTexture = src.__webglTexture; dst.__webglInit = true; dst.__version = fineTex.version; return true; }
  let aliasedF = false;
  const uFine = { value: fineTex }, uXfF = { value: new THREE.Vector4(0, 0, 1 / 64, 0) };
  const uMap = { value: mapTex }, uXf0 = { value: new THREE.Vector4(0, 0, 1 / 512, 0) }, uXf1 = { value: new THREE.Vector4(0, 0, 1 / 2048, 0) };
  const uK = { value: new THREE.Vector4(0, 0, 0, 0) }, uTint = { value: new THREE.Vector3(1.0, 0.95, 0.87) };
  for (const o of [mapTex, uXf0.value, uXf1.value, uK.value, uTint.value, fineTex, uXfF.value]) o.clone = function () { return this; };
  const UNI = { blUM: uMap, blUMXf0: uXf0, blUMXf1: uXf1, blUMK: uK, blUTint: uTint };
  const UNI_FINE = { blUMF: uFine, blUMXfF: uXfF };        // (the terrain's cut variant only: Terrain.cutUniforms)
  for (const id of ['standard', 'physical', 'lambert', 'phong', 'toon']) if (THREE.ShaderLib[id]) Object.assign(THREE.ShaderLib[id].uniforms, UNI);
  // GLSL shared by the lit materials, the terrain cut test and the post composite (uXf: (cx, cz, 1/(2 half) , refY))
  const GLSL = /* glsl */`
#ifndef BL_UNDER_DEF
#define BL_UNDER_DEF
uniform sampler2D blUM; uniform vec4 blUMXf0; uniform vec4 blUMXf1; uniform vec4 blUMK; uniform vec3 blUTint;
// view -> world, undoing the earth-curve bend of 00_util.js (it lowers view positions by K d² along world up)
vec3 blUnderWorld( vec3 vp ) {
  vec3 w = transpose( mat3( viewMatrix ) ) * ( vp - viewMatrix[ 3 ].xyz );
  float bv = dot( vp, viewMatrix[ 1 ].xyz );
  w.y += 7.848061e-8 * max( dot( vp, vp ) - bv * bv, 0.0 );
  return w;
}
// the two samples (map A, map B) of the finest level covering w.xz; false outside both levels
bool blUnderFetch( vec3 w, out vec4 a, out vec4 b, out float refY ) {
  vec2 uv = ( w.xz - blUMXf0.xy ) * blUMXf0.z * 0.5 + 0.5;
  if ( all( greaterThan( uv, vec2( 0.003 ) ) ) && all( lessThan( uv, vec2( 0.997 ) ) ) ) {
    a = texture2D( blUM, vec2( uv.x * 0.5, uv.y * 0.5 ) ); b = texture2D( blUM, vec2( 0.5 + uv.x * 0.5, uv.y * 0.5 ) ); refY = blUMXf0.w; return true; }
  uv = ( w.xz - blUMXf1.xy ) * blUMXf1.z * 0.5 + 0.5;
  if ( all( greaterThan( uv, vec2( 0.003 ) ) ) && all( lessThan( uv, vec2( 0.997 ) ) ) ) {
    a = texture2D( blUM, vec2( uv.x * 0.5, 0.5 + uv.y * 0.5 ) ); b = texture2D( blUM, vec2( 0.5 + uv.x * 0.5, 0.5 + uv.y * 0.5 ) ); refY = blUMXf1.w; return true; }
  return false;
}
// x: inside an underground volume (0..1), y: daylight (0..1, 1 outdoors), z: ambient (irradiance units), w: terrain cut (0/1)
vec4 blUnder( vec3 w ) {
  if ( blUMK.x < 0.5 ) return vec4( 0.0, 1.0, 0.0, 0.0 );
  if ( blUMK.y > 0.5 ) return vec4( 1.0, 0.0, 0.09, 0.0 );                    // fail-safe: underground with no cell
  vec4 a, b; float refY;
  if ( ! blUnderFetch( w, a, b, refY ) ) return vec4( 0.0, 1.0, 0.0, 0.0 );
  float y = w.y - refY;
  float cut = step( -b.b + 0.02, y );                                          // above the cut floor
  float ins = smoothstep( -a.g - 0.45, -a.g - 0.05, y ) * ( 1.0 - smoothstep( a.r + 0.05, a.r + 0.45, y ) );   // floor = -a.g, ceil = a.r
  if ( ins <= 0.0 ) return vec4( 0.0, 1.0, 0.0, cut );
  float yb = -b.r, yt = -b.g;
  float dv = yt > yb + 0.01 && yt < 5.0e3 ? clamp( ( y - yb ) / ( yt - yb ), 0.0, 1.0 ) : 0.0;
  float day = clamp( max( a.b, dv ), 0.0, 1.0 );
  return vec4( ins, mix( 1.0, day, ins ), a.a * ins, max( cut, ins ) );
}
#ifdef BL_CUT
uniform sampler2D blUMF; uniform vec4 blUMXfF;
// the terrain's cut test: the fine level (0.25 m) near the camera, the under map beyond
bool blUnderCut( vec3 w ) {
  vec2 uv = ( w.xz - blUMXfF.xy ) * blUMXfF.z * 0.5 + 0.5;
  if ( blUMK.x > 0.5 && all( greaterThan( uv, vec2( 0.004 ) ) ) && all( lessThan( uv, vec2( 0.996 ) ) ) ) {
    vec4 a = texture2D( blUMF, vec2( uv.x * 0.5, uv.y ) ), b = texture2D( blUMF, vec2( 0.5 + uv.x * 0.5, uv.y ) );
    float y = w.y - blUMXfF.w;
    if ( y > -b.b + 0.02 ) return true;                                            // above a cut floor
    return y > -a.g - 0.3 && y < a.r + 0.3;                                       // inside a volume
  }
  return blUnder( w ).w > 0.5;
}
#endif
#endif
`;
  THREE.ShaderChunk.lights_pars_begin += GLSL;
  {
    const LB = THREE.ShaderChunk.lights_fragment_begin;
    const DIR = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )', RECT = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )';
    if (LB.includes(DIR) && LB.includes(RECT)) {
      THREE.ShaderChunk.lights_fragment_begin = `vec3 blUW = blUnderWorld( - vViewPosition );
vec4 blU = blUnder( blUW );
` + LB.replace(DIR, `#if defined( RE_Direct )
vec3 blDD0 = reflectedLight.directDiffuse, blDS0 = reflectedLight.directSpecular;
#endif
` + DIR).replace(RECT, `#if defined( RE_Direct )
reflectedLight.directDiffuse = blDD0 + ( reflectedLight.directDiffuse - blDD0 ) * blU.y;
reflectedLight.directSpecular = blDS0 + ( reflectedLight.directSpecular - blDS0 ) * blU.y;
#endif
` + RECT);
      THREE.ShaderChunk.lights_fragment_end = `#if defined( RE_IndirectDiffuse )
	irradiance = irradiance * blU.y + blUTint * blU.z;
	iblIrradiance *= blU.y;
#endif
#if defined( RE_IndirectSpecular )
	radiance = radiance * blU.y + blUTint * ( blU.z * 0.12 );
	clearcoatRadiance *= blU.y;
#endif
` + THREE.ShaderChunk.lights_fragment_end;
    } else console.warn('Under: three.js lighting chunk changed; underground lighting patch not applied');
  }
  // the post pipeline (14_post.js) and the terrain (12_terrain.js) read the same map through Post.under / Terrain hooks
  if (typeof Post !== 'undefined' && Post.under) Post.under.attach({ glsl: GLSL, uniforms: UNI });

  // ------------------------------------------------------------------ terrain cut test
  // Terrain nodes over a cut or over a cell that meets the ground (terrain !== false) draw with the cut variant of the
  // terrain material (fragments inside volumes / above cut floors are discarded); every other node keeps today's program.
  let cutList = null, cutBox = null;
  function terrainNeedsCut(x0, z0, x1, z1) { try { return needsCut(x0, z0, x1, z1); } catch (e) { fail('terrain cut test', e); return false; } }
  function needsCut(x0, z0, x1, z1) {
    if (broken || !uK.value.x) return false;
    if (!cutList) { cutList = []; cutBox = [1e9, 1e9, -1e9, -1e9];
      for (const c of cuts.values()) cutList.push(c.bb); for (const c of cells.values()) if (c.terrain) cutList.push(c.bb);
      for (const b of cutList) { cutBox[0] = Math.min(cutBox[0], b[0]); cutBox[1] = Math.min(cutBox[1], b[1]); cutBox[2] = Math.max(cutBox[2], b[2]); cutBox[3] = Math.max(cutBox[3], b[3]); } }
    if (!cutList.length || cutBox[2] < x0 || cutBox[0] > x1 || cutBox[3] < z0 || cutBox[1] > z1) return false;
    for (const b of cutList) if (!(b[2] < x0 || b[0] > x1 || b[3] < z0 || b[1] > z1)) return true;
    return false;
  }
  if (typeof Terrain !== 'undefined') { Terrain.cutTest = terrainNeedsCut; Terrain.cutUniforms = UNI_FINE; }

  // ------------------------------------------------------------------ portal visibility
  const _v = new THREE.Vector3(), _pm = new THREE.Matrix4();
  const _pn = new THREE.Vector3(), _pa = new THREE.Vector3(), _pb = new THREE.Vector3();
  const rectOf = (p, cam) => {       // screen rect [x0, y0, x1, y1] (NDC) of a portal quad; null when behind; full when straddling
    // standing in the doorway (within ~1.5 m of the portal's plane, inside its extent): everything through it may show
    if (p.center.distanceToSquared(cam.position) < (p.radius + 1.5) ** 2) {
      _pa.subVectors(p.quad[1], p.quad[0]); _pb.subVectors(p.quad[p.quad.length - 1], p.quad[0]); _pn.crossVectors(_pa, _pb).normalize();
      if (Math.abs(_pn.dot(_pa.subVectors(cam.position, p.quad[0]))) < 1.5) return [-1, -1, 1, 1];
    }
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, behind = 0; const near = cam.near;
    const P = cam.projectionMatrix.elements;
    for (const q of p.quad) {
      _v.copy(q).applyMatrix4(cam.matrixWorldInverse);
      if (_v.z > -near) { behind++; continue; }
      const sx = (P[0] * _v.x + P[8] * _v.z) / -_v.z, sy = (P[5] * _v.y + P[9] * _v.z) / -_v.z;
      if (sx < x0) x0 = sx; if (sx > x1) x1 = sx; if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
    }
    if (behind === p.quad.length) return null;
    if (behind) return [-1, -1, 1, 1];
    return [x0, y0, x1, y1];
  };
  const isect = (a, b) => { const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]; return r[0] < r[2] && r[1] < r[3] ? r : null; };
  const contains = (a, b) => a && b[0] >= a[0] && b[1] >= a[1] && b[2] <= a[2] && b[3] <= a[3];
  const unionR = (a, b) => a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b.slice();
  const seen = new Map();
  const adj = new Map();                               // cell id -> portals touching it (rebuilt every frame: 'auto' ends move)
  const EMPTY = [];
  function other(p, cid) { const b = p.b === 'auto' ? p.rb : p.b; return p.a === cid ? b : p.a; }
  // cells sharing a zone key (the tunnels of one junction cluster, which open into each other without portals) are one
  // visibility unit: entering one enters all, with the same rectangle
  const zoneMembers = new Map();
  function enterZone(cid, rect, cam, depth) {
    const c = cells.get(cid); if (!c || !c.zone) return;
    for (const key of c.zone) { const zm = zoneMembers.get(key); if (!zm) continue;
      for (const o of zm) { if (o === cid) continue; const had = seen.get(o); if (had && contains(had, rect)) continue; seen.set(o, unionR(had, rect)); state.visible.add(o); if (depth < 24) walk(o, rect, cam, depth + 1); } }
  }
  // (a time budget: a walk that runs past 4 ms stops, and every cell within 300 m is drawn instead: a superset, never a hole)
  let visT0 = 0, visOver = false;
  function walk(cid, rect, cam, depth) {
    stats.walk++;
    if (visOver || ((stats.walk & 31) === 0 && performance.now() - visT0 > 4)) { visOver = true; return; }
    enterZone(cid, rect, cam, depth);
    for (const p of adj.get(cid) || EMPTY) {
      const o = other(p, cid); if (o === cid) continue;
      const pr = rectOf(p, cam); if (!pr) continue;
      const r = isect(rect, pr); if (!r) continue;
      if (o === null || !cells.has(o)) { if (!(p.dead && p.b === 'auto')) state.outsideVisible = true; continue; }
      const had = seen.get(o); if (had && contains(had, r)) continue;
      seen.set(o, unionR(had, r)); state.visible.add(o);
      if (depth < 24) walk(o, r, cam, depth + 1);
    }
  }
  const FULL = [-1, -1, 1, 1];
  function visibility(cam) {
    state.visible.clear(); seen.clear(); state.outsideVisible = false; stats.walk = 0; visT0 = performance.now(); visOver = false;
    for (const l of adj.values()) l.length = 0;
    for (const l of zoneMembers.values()) l.length = 0;
    for (const c of cells.values()) if (c.zone) for (const key of c.zone) { let l = zoneMembers.get(key); if (!l) zoneMembers.set(key, l = []); l.push(c.id); }
    const put = (id, p) => { if (id === null || id === undefined) return; let l = adj.get(id); if (!l) adj.set(id, l = []); l.push(p); };
    for (const p of portals.values()) {
      if (p.b === 'auto') p.rb = p.probe ? cellAt(p.probe.x, p.probe.y, p.probe.z, 0.5) : null;
      put(p.a, p); const b = p.b === 'auto' ? p.rb : p.b; if (b !== p.a) put(b, p);
    }
    const cp = cam.position;
    if (state.cell) { state.visible.add(state.cell); seen.set(state.cell, FULL); walk(state.cell, FULL, cam, 0); }
    else {
      // outdoors: every opening to the outdoors within 3 km and in view seeds a walk (what you see into from the street)
      state.outsideVisible = true;
      for (const p of portals.values()) {
        const b = p.b === 'auto' ? p.rb : p.b; if (p.dead && p.b === 'auto' && !b) continue;
        const inner = (b === null || !cells.has(b)) ? p.a : null;
        if (inner === null || !cells.has(inner)) continue;
        if (p.center.distanceToSquared(cp) > 9e6) continue;
        const r = rectOf(p, cam); if (!r) continue; const rr = isect(FULL, r); if (!rr) continue;
        const had = seen.get(inner); if (had && contains(had, rr)) continue;
        seen.set(inner, unionR(had, rr)); state.visible.add(inner); walk(inner, rr, cam, 0);
      }
    }
    if (visOver) { const cp2 = cam.position; for (const k of cells.values()) if (cp2.x > k.bb[0] - 300 && cp2.x < k.bb[2] + 300 && cp2.z > k.bb[1] - 300 && cp2.z < k.bb[3] + 300) state.visible.add(k.id); stats.visOver = (stats.visOver || 0) + 1; }
    stats.visCells = state.visible.size;
  }

  // ------------------------------------------------------------------ fail-safe
  // The camera well underground where no cell claims it (a cell is missing, or the data and a module's geometry
  // disagree): inside a metro tunnel / subway station envelope per MetroNet, or more than 3 m below the ground near the
  // metro's underground structures (never inside a registered cut; other modules' tunnels are not Under's business).
  // It still counts as underground: every lit material sees an unlit interior (map flag), the outdoor world is culled,
  // the cells around stay drawn, the interior exposure applies, and a warning names the place once, so a mismatch shows
  // as a dark interior rather than as a street seen from below. Returns a description, or null.
  // (the warning is for developers: only with #debug / ?dev, once per place, and only when the state has lasted 3 s at
  // the same spot, so spawning or teleporting before a module's cells register stays silent; state.failsafe and
  // stats.failsafe report it always)
  const _fsF = {}, fsWarned = new Set(); let fsAt = null, fsHit = null, fsSince = 0, fsPos = null;

  function failsafeAt(x, y, z) {
    if (typeof MetroNet === 'undefined' || !MetroNet.ready || !MetroNet.nearAll) return null;
    if (fsAt && Math.abs(fsAt[0] - x) + Math.abs(fsAt[1] - y) + Math.abs(fsAt[2] - z) < 0.5) return fsHit;       // (unchanged camera)
    let below = -1e9; try { const g = Terrain.h(x, z); if (isFinite(g)) below = g - y; } catch (e) {}
    let hit = null;
    // (open-trench, surface and aerial stations are outdoor places even where the data's track is cut-and-cover under
    // uncarved ground (San Bruno, Milpitas): near one, never)
    if (MetroNet.stationsNear) { const ns = MetroNet.stationsNear(x, z, 320)[0]; if (ns && ns.station.type !== 'subway') { fsAt = [x, y, z]; fsHit = null; return null; } }
    if (below > 1 && !cutAt(x, z, y)) {
      const t = MetroNet.inTunnelAt ? MetroNet.inTunnelAt(x, y, z) : null;
      if (t) hit = t.kind === 'station' ? 'station ' + (t.station && t.station.id) + ' (track ' + (t.track && t.track.id) + ' s ' + Math.round(t.s) + ')' : 'track ' + (t.track && t.track.id) + ' s ' + Math.round(t.s) + ' (' + t.struct + ')';
      if (!hit && below > 3) {
        const st = MetroNet.stationsNear ? MetroNet.stationsNear(x, z, 260).find(q => q.station.type === 'subway') : null;
        if (st) hit = 'near station ' + st.station.id;
        else for (const q of MetroNet.nearAll(x, z, 40)) { const F = MetroNet.frame(q.track, q.s, _fsF); if (F && MetroNet.UNDER[F.struct] && Math.abs(F.y - y) < 25) { hit = 'near track ' + q.track.id + ' s ' + Math.round(q.s) + ' (' + F.structName + ')'; break; } }
      }
      if (hit) hit += ', ' + below.toFixed(1) + ' m below the ground';
    }
    fsAt = [x, y, z]; fsHit = hit; return hit;
  }
  function failsafeNote(hit, x, y, z) {
    const now = performance.now();
    if (!hit) { fsPos = null; stats.failsafe = null; return; }
    if (!fsPos || Math.hypot(fsPos[0] - x, fsPos[2] - z) > 20) { fsPos = [x, y, z]; fsSince = now; return; }
    stats.failsafe = hit;
    if (!DEBUG || now - fsSince < 3000) return;
    const key = hit.replace(/ s \d+| \(.*$|, .*$/g, ''); if (fsWarned.has(key)) return; fsWarned.add(key);
    console.warn('Under (debug): the camera is underground at ' + [x, y, z].map(v => v.toFixed(1)).join(', ') + ' (' + hit + ') but no cell claims it; rendering it as underground (fail-safe). The cell for that place is missing, or the data and the geometry disagree.');
  }

  // ------------------------------------------------------------------ per frame
  let lastCam = new THREE.Vector3(1e9, 0, 0), wasNear = false, mapWait = 0, recentred = false;
  // (failure isolation: an exception anywhere in Under first resets it to "outdoors, nothing hidden, no map"; then the
  // metro switch (18_metro.js) is told, which turns the whole metro off for the session with its one warning; without
  // the switch Under just stays off)
  let broken = false;
  const hasSwitch = () => typeof Metro !== 'undefined' && !!Metro.fail;
  function fail(where, e) {
    broken = true; try { resetState(); } catch (e2) {}
    if (hasSwitch()) { try { Metro.fail('the underground engine (' + where + ')', e); } catch (e3) {} }
    else console.warn('Under: ' + where + ' failed; underground rendering off', e);
  }
  function resetState() {
    state.cell = null; state.failsafe = null; state.depth = 0; state.daylight = 1; state.outsideVisible = true; state.visible.clear();
    uK.value.x = 0; uK.value.y = 0; postRender();
    if (typeof Post !== 'undefined' && Post.under) { Post.under.on = false; Post.under.depth = 0; Post.under.outside = true; }
  }
  function update(cam) { if (broken) return; try { update1(cam); } catch (e) { fail('update', e); } }
  function update1(cam) {
    const cp = cam.position;
    // clipmap levels follow the camera (snapped to 8 texels so the map doesn't swim)
    for (const q of [...LV, FL]) {
      if (Math.abs(cp.x - q.cx) > q.re || Math.abs(cp.z - q.cz) > q.re || Math.abs(cp.y - q.refY) > 160) {
        const snap = q.texel * 8; q.cx = Math.round(cp.x / snap) * snap; q.cz = Math.round(cp.z / snap) * snap; q.refY = Math.round(cp.y / 32) * 32; dirty = true; recentred = true;
      }
    }
    const any = cells.size + cuts.size > 0 && anyNear(cp.x, cp.z);
    if (any && !wasNear) dirty = true; wasNear = any;
    // (registrations mark the map dirty many times while streaming: it is redrawn at most every 6th frame then, at
    // once when the clipmap moves or the camera comes near)
    const T0 = performance.now(); mapWait = Math.max(0, mapWait - 1);
    if (dirty && any && (mapWait === 0 || recentred)) { drawMaps(cam); dirty = false; recentred = false; mapWait = 6; if (!aliased) aliased = aliasMap(); if (!aliasedF) aliasedF = aliasFine(); }
    const T1 = performance.now();
    uXf0.value.set(LV[0].cx, LV[0].cz, 1 / LV[0].half, LV[0].refY); uXf1.value.set(LV[1].cx, LV[1].cz, 1 / LV[1].half, LV[1].refY);
    uXfF.value.set(FL.cx, FL.cz, 1 / FL.half, FL.refY);
    uK.value.x = any && aliased ? 1 : 0;
    // the camera's cell and how deep inside it is
    state.cell = any ? cellAt(cp.x, cp.y, cp.z) : null;
    const c = state.cell ? cells.get(state.cell) : null;
    state.failsafe = !c && any ? failsafeAt(cp.x, cp.y, cp.z) : null; failsafeNote(state.failsafe, cp.x, cp.y, cp.z);
    uK.value.y = state.failsafe ? 1 : 0;
    state.daylight = c ? dayAt(c, cp.x, cp.y, cp.z) : state.failsafe ? 0 : 1;
    const target = c || state.failsafe ? 1 - state.daylight : 0;
    state.depth = target;                                  // (the daylight ramps are already smooth along the cell)
    const T2 = performance.now();
    visibility(cam);
    const T3 = performance.now(); const tu = stats.tu || (stats.tu = [0, 0, 0]); tu[0] = T1 - T0; tu[1] = T2 - T1; tu[2] = T3 - T2;   // (QA: map / cell / visibility ms)
    if (state.failsafe) {                                  // no cell to walk from: the cells around stay, the outdoors goes
      state.outsideVisible = false; state.visible.clear();
      for (const k of cells.values()) if (cp.x > k.bb[0] - 300 && cp.x < k.bb[2] + 300 && cp.z > k.bb[1] - 300 && cp.z < k.bb[3] + 300) state.visible.add(k.id);
      stats.visCells = state.visible.size;
    }
    // exposure: blend to the fixed interior exposure (Env.update computed today's outdoor value this frame)
    if (typeof Env !== 'undefined') {
      Env.state.under = state.depth;
      if (state.depth > 0) { Env.state.exposure = U.lerp(Env.state.exposure, INTERIOR_EXPOSURE, state.depth); R.toneMappingExposure = Env.state.exposure * 0.93; }
    }
    if (typeof Post !== 'undefined' && Post.under) { Post.under.depth = state.depth; Post.under.outside = state.outsideVisible || !(state.cell || state.failsafe); Post.under.maxBoost = MAX_BOOST; Post.under.on = any; }
    lastCam.copy(cp);
  }
  // around the draw: hide cells nobody can see and, while no opening to the outdoors is in view, the outdoor world
  const hidden = [], anc = new Set();
  function preRender() { if (broken) return; try { preRender1(); } catch (e) { fail('preRender', e); } }
  function preRender1() {
    hidden.length = 0;
    if (!cells.size) return;
    const under = !!(state.cell || state.failsafe);
    for (const c of cells.values()) if (c.group) { const v = state.visible.has(c.id); if (c.group.visible && !v) { c.group.visible = false; hidden.push(c.group); } }
    if (under && !state.outsideVisible) {
      // never cull a top-level object that holds a registered cell's group (a module's station / tunnel root)
      anc.clear(); const scene = Env.scene;
      for (const c of cells.values()) { let o = c.group; while (o && o.parent && o.parent !== scene) o = o.parent; if (o && o.parent === scene) anc.add(o); }
      for (const o of scene.children) {
        if (!o.visible || o.isLight || o.isCamera || o.userData.blUnderKeep || keepSet.has(o) || anc.has(o)) continue;
        if (o.type === 'Object3D' && !o.children.length) continue;            // light targets
        o.visible = false; hidden.push(o);
      }
      for (const o of outdoorSet) if (o.visible) { o.visible = false; hidden.push(o); }
    }
    stats.culled = hidden.length;
  }
  function postRender() { for (const o of hidden) { try { o.visible = true; } catch (e) {} } hidden.length = 0; }

  const debug = {
    // read back the map at a world point (QA): { a: [...], b: [...] } of the finest level (stalls: debug only)
    sample(x, z, L = 0) {
      const q = LV[L], u = (x - q.cx) / q.half * 0.5 + 0.5, v = (z - q.cz) / q.half * 0.5 + 0.5; if (u < 0 || v < 0 || u > 1 || v > 1) return null;
      const px = Math.floor(u * N), py = Math.floor(v * N), out = [];
      for (const pass of [0, 1]) { const b = new Uint16Array(4); R.readRenderTargetPixels(rt, pass * N + px, L * N + py, 1, 1, b); out.push([...b].map(h => +THREE.DataUtils.fromHalfFloat(h).toFixed(2))); }
      return { a: out[0], b: out[1], refY: q.refY };
    },
    levels: LV, rt,
  };
  return { enabled: true, state, stats, addCell, addPortal, addCut, remove, cellAt, cutAt, keep, outdoor, update, preRender, postRender, cells, portals, cuts, debug, GLSL,
    dayAt: (x, y, z) => { const id = cellAt(x, y, z); return id ? dayAt(cells.get(id), x, y, z) : 1; },
    INTERIOR_EXPOSURE, MAX_BOOST, get dirty() { return dirty; }, invalidate() { dirty = true; } };
})();
if (typeof window !== 'undefined') (window.__baylineMods = window.__baylineMods || {}).Under = Under;   // debug handle (window.__bayline.Under)
