// MetroKit: baked LODs. A design's full-detail exterior (body, livery, decals, door seams, grilles, trucks) and the
// interior impression behind its windows are rendered once, orthographically, into an atlas (RGB: albedo, sRGB; A: a
// material code: 0 paint, 0.5 x metalness, 0.86 a far pane (the outside, shaded live), 1 a window onto the lit cabin,
// whose RGB is the cabin's radiance at its own light, half scale). The LOD 1 / LOD 2 meshes and the far batch map it
// (42_metrokit_fotf.js etc.: builders[kind].lodBaked), so a distant car or a Low-tier car looks like the real one for
// about a thousand triangles and one draw.
// Views: 0 side +Z, 1 side -Z, 2 top, 3 front (+X end), 4 rear (-X end); each an orthographic camera onto a rect of the
// atlas. The bake programs are compiled off the main thread when the driver can (compileAsync); cars that need a LOD
// before their design's bake exists get the plain LOD and are upgraded when it arrives.
(() => {
  const K = MetroKit._k, V3 = THREE.Vector3;
  let renderer = null;
  K.setRenderer = r => { renderer = r || null; };
  const R = () => renderer || (typeof Env !== 'undefined' && Env.renderer) || null;
  K.renderer = R;

  // ------------------------------------------------------------------------------------------ layout
  // pxm: texels per metre along the sides and roof; the end views (the D nose is what platforms look at) get 1.6 x
  function layout(d, pxm) {
    const g = d.ext; if (!g.boundingBox) g.computeBoundingBox(); const bb = g.boundingBox;
    const x0 = bb.min.x - 0.02, x1 = bb.max.x + 0.02, y0 = Math.max(bb.min.y, -0.05) - 0.02, y1 = bb.max.y + 0.02, z0 = bb.min.z - 0.02, z1 = bb.max.z + 0.02;
    const Lx = x1 - x0, Hy = y1 - y0, Wz = z1 - z0;
    const s = Math.min(pxm, 2048 / Lx), se = s * 1.6;
    const sw = Math.ceil(Lx * s), sh = Math.ceil(Hy * s), th = Math.ceil(Wz * s), ew = Math.ceil(Wz * se), eh = Math.ceil(Hy * se), pad = 4;
    const W = Math.max(sw, 2 * ew + pad), yE = 2 * (sh + pad) + th + pad, rects = [
      [0, 0, sw, sh], [0, sh + pad, sw, sh], [0, 2 * (sh + pad), sw, th], [0, yE, ew, eh], [ew + pad, yE, ew, eh]];
    return { x0, x1, y0, y1, z0, z1, W, H: yE + eh, rects, s };
  }
  // normalized coordinates (a: the camera's right, b: its up) of a design-space point in view v
  function ab(L, v, x, y, z) {
    const fx = (x - L.x0) / (L.x1 - L.x0), fy = (y - L.y0) / (L.y1 - L.y0), fz = (z - L.z0) / (L.z1 - L.z0);
    switch (v) { case 0: return [fx, fy]; case 1: return [1 - fx, fy]; case 2: return [fx, 1 - fz]; case 3: return [1 - fz, fy]; default: return [fz, fy]; }
  }
  function uv(L, v, x, y, z) { const q = ab(L, v, x, y, z), r = L.rects[v]; return [(r[0] + q[0] * r[2]) / L.W, (r[1] + q[1] * r[3]) / L.H]; }
  // the view that sees a surface with this normal best
  function viewFor(nx, ny, nz) { const ax = Math.abs(nx), az = Math.abs(nz); if (ax > az && ax > ny) return nx > 0 ? 3 : 4; if (ny > az) return 2; return nz >= 0 ? 0 : 1; }
  function camFor(L, v) {
    const cx = (L.x0 + L.x1) / 2, cy = (L.y0 + L.y1) / 2, cz = (L.z0 + L.z1) / 2, hx = (L.x1 - L.x0) / 2, hy = (L.y1 - L.y0) / 2, hz = (L.z1 - L.z0) / 2;
    const c = v <= 1 ? new THREE.OrthographicCamera(-hx, hx, hy, -hy, 0.1, 200) : v === 2 ? new THREE.OrthographicCamera(-hx, hx, hz, -hz, 0.1, 200) : new THREE.OrthographicCamera(-hz, hz, hy, -hy, 0.1, 200);
    if (v === 0) c.position.set(cx, cy, L.z1 + 20); else if (v === 1) c.position.set(cx, cy, L.z0 - 20);
    else if (v === 2) { c.position.set(cx, L.y1 + 20, cz); c.up.set(0, 0, -1); }
    else if (v === 3) c.position.set(L.x1 + 20, cy, cz); else c.position.set(L.x0 - 20, cy, cz);
    c.lookAt(cx, cy, cz); c.updateMatrixWorld(); c.updateProjectionMatrix(); return c;
  }

  // ------------------------------------------------------------------------------------------ the bake
  // per-design uniforms for the bake materials: a mid-life car at rest (doors shut), its cabin lit, a few passengers
  function bakeUniforms(d) {
    const S = K.carUniforms();
    S.mkWet = { value: 0 }; S.mkSpd = { value: 0 };
    S.mkAge.value = 0.3; S.mkSeed.value = 0.37; S.mkNight.value = 0;
    S.mkAtlas.value = K.decalAtlas ? K.decalAtlas(K.atlasRes()) : null;
    S.mkSign.value = K.blankTex(); S.mkLcd.value = K.blankTex(); S.mkSignRes.value.set(K.SIGN.W, K.SIGN.H);
    for (let i = 0; i < 6; i++) S.mkNum.value[i] = 99;
    S.mkCamO = { value: new V3() }; S.mkIntOn = { value: 1 };
    if (d.lamp) S.mkLamp.value.set(d.lamp[0], d.lamp[1], d.lamp[2], 0);
    K.imapUniforms(S, d);
    S.mkCab = { value: new THREE.Vector4(-d.length / 2, d.length / 2, 0, 0) }; if (d.cabBox) S.mkCab.value.copy(d.cabBox);
    S.mkHalfW.value = d.halfW || 1.47; S.mkFloorY.value = d.floorY || 0.991; S.mkCeilY.value = d.ceilY || 3.1;
    S.mkEnds.value.set(1, d.cabI || d.type === 'D' ? -1 : 1, 0, 0); S.mkLoad.value = 0.32;
    const all = (d.imap && d.imap.standAll) || [], st = S.mkStand.value;
    for (let i = 0; i < 8 && i < all.length; i++) st[i].set(all[(i * 5) % all.length][0], all[(i * 5) % all.length][1], 1.6 + 0.2 * ((i * 7) % 5) / 4, (i * 0.37) % 1);
    S.mkLv.value[K.G.interior] = 1;
    return S;
  }
  function rig(d) {
    const nb = d.bones.length, bones = []; for (let i = 0; i < nb; i++) bones.push(new THREE.Bone());
    const sk = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4())); sk.computeBoneTexture(); sk.update = function () {};
    const bm = sk.boneMatrices, I = new THREE.Matrix4(); for (let i = 0; i < nb; i++) I.toArray(bm, i * 16); sk.boneTexture.needsUpdate = true;
    return sk;
  }
  function sceneFor(d, S) {
    const sc = new THREE.Scene(), sk = rig(d), I = new THREE.Matrix4(), mats = [K.palMaterial('bake', S), K.glassMaterial(S, 'bake')];
    for (const [geo, mat] of [[d.ext, mats[0]], [d.glass, mats[1]]]) {
      if (!geo.attributes.position.count) continue;
      const m = new THREE.SkinnedMesh(geo, mat); m.bind(sk, I); m.bindMode = 'detached'; m.frustumCulled = false; sc.add(m);
    }
    return { sc, sk, mats };
  }
  const CLEAR = new THREE.Color(0.52, 0.54, 0.56), _prevCol = new THREE.Color();
  function bakeNow(d) {
    const r = R(); if (!r) return null;
    // (Low draws the baked LOD at every distance: 48 texels/m; the other tiers only beyond ~110 m: 36)
    const t0 = performance.now(), L = layout(d, K.Q() === 0 ? 48 : 36), S = bakeUniforms(d), { sc, sk, mats } = sceneFor(d, S), tS = performance.now(), tv = [];
    const rt = new THREE.WebGLRenderTarget(L.W, L.H, { samples: 4, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, stencilBuffer: false });
    rt.texture.colorSpace = THREE.SRGBColorSpace; rt.texture.anisotropy = 4;
    const prevRT = r.getRenderTarget(), prevAuto = r.autoClear, prevA = r.getClearAlpha(); r.getClearColor(_prevCol);
    try {
      r.autoClear = true; r.setClearColor(CLEAR, 0.44);
      for (let v = 0; v < 5; v++) {
        const q = L.rects[v]; rt.viewport.set(q[0], q[1], q[2], q[3]); rt.scissor.set(q[0], q[1], q[2], q[3]); rt.scissorTest = true;
        r.setRenderTarget(rt); r.render(sc, camFor(L, v)); tv.push(Math.round(performance.now() - t0));
      }
    } finally {
      rt.scissorTest = false; rt.viewport.set(0, 0, L.W, L.H); rt.scissor.set(0, 0, L.W, L.H);
      r.setRenderTarget(prevRT); r.autoClear = prevAuto; r.setClearColor(_prevCol, prevA);
    }
    for (const m of mats) m.dispose(); sk.dispose();
    d.bake = { tex: rt.texture, rt, L, uv: (v, x, y, z) => uv(L, v, x, y, z), viewFor, bytes: L.W * L.H * 4 * 4 / 3, ms: performance.now() - t0, prof: { setup: Math.round(tS - t0), views: tv } };
    return d.bake;
  }

  // ------------------------------------------------------------------------------------------ requests
  // requestBake(d, car): the bake when it exists; else null, and the car is told (car._onBaked()) when it is ready
  const waiting = new Map();                     // design -> Set(car)
  let state = 0;                                 // 0 programs not compiled, 1 compiling, 2 ready
  let keeper = null;                             // bake materials kept alive so their programs stay compiled
  function flush() {
    for (const [d, cars] of waiting) {
      waiting.delete(d);
      if (!d.bake) { try { bakeNow(d); } catch (e) { console.warn('MetroKit: bake failed for ' + d.key, e); d.bakeFailed = true; } }
      if (d.bake) for (const c of cars) if (c._onBaked) c._onBaked();
    }
  }
  K.requestBake = (d, car) => {
    if (d.bake) return d.bake;
    if (d.bakeFailed || !K.builders[d.kind] || !K.builders[d.kind].lodBaked) return null;
    const r = R(); if (!r) return null;
    let set = waiting.get(d); if (!set) { set = new Set(); waiting.set(d, set); } if (car) set.add(car);
    if (state === 2) { flush(); return d.bake || null; }
    if (state === 1) return null;
    state = 1;
    const S = bakeUniforms(d), { sc } = sceneFor(d, S); keeper = sc;
    // compiled with a render target bound: programs drawing into a target differ from the screen's (linear output)
    const tmp = new THREE.WebGLRenderTarget(4, 4, { samples: 4 }); tmp.texture.colorSpace = THREE.SRGBColorSpace;
    const prev = r.getRenderTarget(), cam = camFor(layout(d, 40), 0), done = () => { tmp.dispose(); state = 2; flush(); };
    r.setRenderTarget(tmp);
    let p = null; try { p = r.compileAsync ? r.compileAsync(sc, cam) : (r.compile(sc, cam), null); } finally { r.setRenderTarget(prev); }
    if (p) p.then(done, () => done()); else done();
    return null;
  };
  // (for previews and tests: resolves once every requested bake is done)
  K.bakesSettled = () => new Promise(res => { const tick = () => (state !== 1 && !waiting.size) ? res() : setTimeout(tick, 50); tick(); });
  K.bakeLayout = layout; K.bakeUV = uv; K.bakeViewFor = viewFor; K._bakeNow = bakeNow;
})();
