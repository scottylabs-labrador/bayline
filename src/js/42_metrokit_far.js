// MetroKit: far detail. LOD1 (one mesh per car: the section with windows, doors and the scheme, nose, trucks) and
// LOD2 (a banded prism) for the D/E cars, built once per design; and the far batch: every distant train of the whole
// system in a few instanced draws (one per car design) plus instanced billboard lamps (GL points never draw in this
// pipeline), for the sim's trains beyond the consist pool.
(() => {
  const K = MetroKit._k, { MB, fnorm, tr, rotY, mul } = K;
  const { clamp } = U;

  // ------------------------------------------------------------------------------------------ LOD meshes (FOTF)
  function fotfLod(d, level) {
    const F = K.FOTF, isD = d.type === 'D', E = new MB(), P = d.profile, { bodyAt, tAtY } = K.fotfProfile;
    const alu = isD ? 'aluD' : 'aluE';
    // a coarse section: skirt, floor line, vertical side, eaves, roof (right half), mirrored
    const ys = level === 1 ? [0.62, 0.99, 1.675, F.WIN_Y0, F.WIN_Y1, 2.95, 3.3, 3.62, 3.8] : [0.62, 1.0, 1.85, 2.88, 3.5];
    const sec = ys.map(y => bodyAt(P, 0, tAtY(P, y), 1, 0)).map(b => [b.p[1], b.p[2], b.n[1], b.n[2]]);
    sec.push([F.ROOF, 0, 1, 0]);
    const xR = -F.BODY, xF = isD ? F.NOSE_XC + 0.25 : F.BODY;
    // side cells: windows dark ('lodWin'), door leaves, the rest aluminium / roof
    const wins = isD ? F.WIN_D : F.WIN_E, xs = new Set([xR, xF]);
    if (level === 1) { for (const w of wins) { xs.add(w - F.WIN_W / 2); xs.add(w + F.WIN_W / 2); } for (const dc of F.DOORS) { xs.add(dc - F.LEAF); xs.add(dc + F.LEAF); } if (isD) { xs.add(9.2); xs.add(9.76); } }
    const X = [...xs].sort((a, b) => a - b);
    const cellPal = (xm, ym) => {
      if (ym > 2.97) return 'roof';
      if (level === 1) {
        if (ym > F.WIN_Y0 && ym < F.WIN_Y1 && (wins.some(w => Math.abs(xm - w) < F.WIN_W / 2) || (isD && xm > 9.2 && xm < 9.76))) return 'lodWin';
        if (F.DOORS.some(dc => Math.abs(xm - dc) < F.LEAF) && ym > 0.99 && ym < 2.95) return 'aluDoor';
      } else if (ym > 1.85 && ym < 2.88) return 'lodWin';
      return alu;
    };
    for (const s of [1, -1]) for (let i = 0; i < X.length - 1; i++) for (let j = 0; j < sec.length - 1; j++) {
      const xa = X[i], xb = X[i + 1], A = sec[j], B = sec[j + 1];
      E.pal(cellPal((xa + xb) / 2, (A[0] + B[0]) / 2));
      const v0 = E.v(xa, A[0], s * A[1], 0, A[2], s * A[3]), v1 = E.v(xb, A[0], s * A[1], 0, A[2], s * A[3]), v2 = E.v(xb, B[0], s * B[1], 0, B[2], s * B[3]), v3 = E.v(xa, B[0], s * B[1], 0, B[2], s * B[3]);
      E.quadA(v0, v1, v2, v3);
    }
    // ends: flat caps (blue); the D nose: a raked cap with the black mask, white lower part, lamps
    const cap = (x, e, pal) => { E.pal(pal); const pts = []; for (const q of sec) pts.push([q[1], q[0]]); for (let i = sec.length - 2; i >= 0; i--) pts.push([-sec[i][1], sec[i][0]]);
      E.shape(pts, [], (z, y) => ({ p: [x, y, z], n: [e, 0, 0] })); };
    cap(xR, -1, 'blue');
    if (!isD) cap(xF, 1, 'blue');
    else {
      const x = xF;
      cap(x - 0.004, 1, 'cap');
      E.pal('mask'); E.shape([[-1.27, 2.05], [1.27, 2.05], [1.27, 3.35], [0.9, 3.55], [-0.9, 3.55], [-1.27, 3.35]], [], (z, y) => ({ p: [x + 0.004, y, z], n: [1, 0, 0] }));
      for (const s of [1, -1]) { E.pal('headLamp'); E.box(x, 1.62, s * 1.12 - 0.09, x + 0.03, 1.98, s * 1.12 + 0.09); E.pal('tailLamp'); E.box(x, 0.9, s * 1.1 - 0.12, x + 0.03, 1.08, s * 1.1 + 0.12); }
      E.pal('topBar'); E.box(x - 0.1, 3.66, -0.47, x + 0.02, 3.75, 0.47);
      E.pal('bumper'); E.box(x, 1.07, -0.87, x + 0.1, 1.26, 0.87);
      // the fillet between the side and the face (one flat bevel)
      for (const s of [1, -1]) { E.pal('cap'); E.q4(...(s > 0 ? [[F.NOSE_XC + 0.25, 0.62, 1.505], [x, 0.62, 1.35], [x, 3.3, 1.35], [F.NOSE_XC + 0.25, 3.3, 1.505]] : [[x, 0.62, -1.35], [F.NOSE_XC + 0.25, 0.62, -1.505], [F.NOSE_XC + 0.25, 3.3, -1.505], [x, 3.3, -1.35]])); }
    }
    // underside and trucks
    E.pal('frame'); E.box(-8.9, 0.36, -1.35, 8.9, 0.62, 1.35, 'Y');
    for (const bx of [F.TRUCK, -F.TRUCK]) {
      E.pal('frame'); E.box(bx - 1.55, 0.2, -1.2, bx + 1.55, 0.85, 1.2);
      if (level === 1) { E.pal('wheel'); for (const a of [-1, 1]) E.cyl([bx + a * F.WB / 2, F.WR, -0.95], [bx + a * F.WB / 2, F.WR, 0.95], F.WR, F.WR, 10); }
    }
    return E.geometry();
  }
  K.fotfLod = fotfLod;

  // ------------------------------------------------------------------------------------------ billboards (lamps)
  // Instanced camera-facing quads with a soft glow; one draw for all lamps of a batch. Instance attributes:
  // iPos (xyz world, w size in m), iCol (rgb, a unused). Works with the logarithmic depth buffer and the earth bend.
  function glowMaterial() {
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: true,
      uniforms: { uMinPx: { value: 2.5 }, uRes: { value: new THREE.Vector2(1600, 900) } },
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 iPos; attribute vec4 iCol; varying vec2 vQ; varying vec3 vC; uniform float uMinPx; uniform vec2 uRes;
        void main() {
          vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
          if ( ! isOrthographic ) mv = blBend( mv );
          // keep at least uMinPx pixels so far lamps still read; fade the extra size in the colour
          float d = max(-mv.z, 1.0), px = iPos.w / d * projectionMatrix[1][1] * uRes.y * 0.5;
          float grow = max(1.0, uMinPx / max(px, 1e-4));
          mv.xy += position.xy * iPos.w * grow;
          vQ = position.xy * 2.0; vC = iCol.rgb / grow;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec2 vQ; varying vec3 vC;
        void main() {
          #include <logdepthbuf_fragment>
          float r = length(vQ); if (r > 1.0) discard;
          float a = exp(-r * r * 6.0) + 0.35 * exp(-r * r * 40.0);
          gl_FragColor = vec4(vC * a, 1.0);
        }`,
    });
  }
  function makeGlow(max) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4), col = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    pos.setUsage(THREE.DynamicDrawUsage); col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', pos); g.setAttribute('iCol', col); g.instanceCount = 0;
    const m = new THREE.Mesh(g, glowMaterial()); m.frustumCulled = false; m.renderOrder = 3;
    return { mesh: m, pos, col, n: 0, max };
  }
  K.makeGlow = makeGlow;

  // ------------------------------------------------------------------------------------------ far batch
  // const far = MetroKit.createFarBatch(scene, { maxCars: 1200, maxLamps: 600 })
  // per frame: far.begin(); far.addCar(kind, type, matrix4 | {x,y,z,yaw,pitch}, flip); far.addLamp(x, y, z, 'head'|'tail'); far.end(night)
  // kind 'bart' types 'D' | 'E'; 'dmu' / 'apm' types as their builders define. Cars use each design's LOD2 geometry.
  function createFarBatch(scene, o = {}) {
    const maxCars = o.maxCars || 1200, S = K.carUniforms();
    S.mkAge.value = 0.4; S.mkSign.value = null; S.mkAtlas.value = K.decalAtlas ? K.decalAtlas(K.atlasRes()) : null;
    const mat = K.palMaterial('lod', S), meshes = new Map(), glow = makeGlow(o.maxLamps || 600);
    scene.add(glow.mesh);
    // (on a quality change the batch drops its instanced meshes, rebuilt lazily from the new designs, and takes the
    // new atlas, so nothing of the old quality stays alive)
    // per design with a baked atlas: its own material (the atlas) sharing the batch's other uniforms (lamps, night)
    const bakedMats = new Map();
    const matFor = (d, bake) => { let m = bakedMats.get(d); if (!m) { m = K.palMaterial('lod', Object.assign({}, S, { mkBake: { value: bake.tex } })); bakedMats.set(d, m); } return m; };
    const reg = { atlas: S.mkAtlas.value, designs: new Set(), reset() {
      for (const m of meshes.values()) { scene.remove(m); m.dispose(); } meshes.clear(); reg.designs.clear();
      for (const m of bakedMats.values()) m.dispose(); bakedMats.clear();
      S.mkAtlas.value = reg.atlas = K.decalAtlas ? K.decalAtlas(K.atlasRes()) : null; } };
    if (K.farBatches) K.farBatches.add(reg);
    const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YZX'), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
    // the design's baked LOD 2 when its atlas exists (asked for here, upgraded in begin() once it arrives), else the
    // plain one; flipped cars use a turned copy of the geometry (kept on the design)
    function meshFor(kind, type, flip) {
      const key = kind + ':' + type + (flip ? ':f' : '');
      let m = meshes.get(key); if (m) return m;
      const d = K.getDesign(kind, type), b = K.builders[kind]; reg.designs.add(d);
      const bake = b.lodBaked && K.requestBake ? K.requestBake(d, null) : null;
      let geo, mt = mat;
      if (bake) { if (!d.lodb2) d.lodb2 = b.lodBaked(d, 2, bake); geo = d.lodb2; mt = matFor(d, bake); }
      else { if (!d.lod2) d.lod2 = b.lod(d, 2); geo = d.lod2; }
      if (flip) { const fk = bake ? 'lodb2f' : 'lod2f'; if (!d[fk]) d[fk] = geo.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI)); geo = d[fk]; }
      m = new THREE.InstancedMesh(geo, mt, maxCars); m.count = 0; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false;
      m.userData.n = 0; m.userData.d = d; m.userData.baked = !!bake; scene.add(m); meshes.set(key, m); return m;
    }
    const SIGN_AT = { bart: { D: [10.27, 3.13, -0.83] } }, _c = new THREE.Color(), AMBER = new THREE.Color(1.0, 0.62, 0.12), _sp = new THREE.Vector3();
    const api = {
      begin() {
        for (const [key, m] of meshes) {
          if (!m.userData.baked && m.userData.d.bake) { scene.remove(m); m.dispose(); meshes.delete(key); continue; }     // (its bake arrived)
          m.userData.n = 0;
        }
        glow.n = 0;
      },
      // color (optional, the line's): the car's front LED sign glows in it (a line-colour hint on distant trains)
      addCar(kind, type, pose, flip = false, color) {
        const m = meshFor(kind, type, flip); if (m.userData.n >= maxCars) return;
        if (pose.isMatrix4) _m.copy(pose); else { _e.set(pose.roll || 0, pose.yaw || 0, pose.pitch || 0, 'YZX'); _q.setFromEuler(_e); _m.compose(_p.set(pose.x, pose.y, pose.z), _q, _s); }
        _m.toArray(m.instanceMatrix.array, m.userData.n * 16); m.userData.n++;
        const sa = color && SIGN_AT[kind] && SIGN_AT[kind][type];
        if (sa && glow.n < glow.max) {
          _sp.set(flip ? -sa[0] : sa[0], sa[1], flip ? -sa[2] : sa[2]).applyMatrix4(_m); _c.set(color).lerp(AMBER, 0.35);
          const i = glow.n++, P = glow.pos.array, C = glow.col.array;
          P[i * 4] = _sp.x; P[i * 4 + 1] = _sp.y; P[i * 4 + 2] = _sp.z; P[i * 4 + 3] = 0.9; C[i * 4] = _c.r * 1.6; C[i * 4 + 1] = _c.g * 1.6; C[i * 4 + 2] = _c.b * 1.6;
        }
      },
      addLamp(x, y, z, kind = 'head', size) {
        if (glow.n >= glow.max) return; const i = glow.n++, P = glow.pos.array, C = glow.col.array;
        P[i * 4] = x; P[i * 4 + 1] = y; P[i * 4 + 2] = z; P[i * 4 + 3] = size || (kind === 'head' ? 1.4 : 1.0);
        if (kind === 'head') { C[i * 4] = 3.2; C[i * 4 + 1] = 3.0; C[i * 4 + 2] = 2.6; } else if (kind === 'tail') { C[i * 4] = 2.8; C[i * 4 + 1] = 0.12; C[i * 4 + 2] = 0.08; } else { C[i * 4] = 1.6; C[i * 4 + 1] = 1.2; C[i * 4 + 2] = 0.7; }
      },
      end(night = 0, res) {
        for (const m of meshes.values()) { m.count = m.userData.n; m.instanceMatrix.needsUpdate = true; m.visible = m.count > 0; }
        const lv = S.mkLv.value; lv[K.G.interior] = 0.6 + 0.4 * night; lv[K.G.head] = 8 + 14 * night; lv[K.G.tail] = 3 + 7 * night; lv[K.G.bar] = 2; S.mkNight.value = night;
        glow.mesh.geometry.instanceCount = glow.n; glow.pos.needsUpdate = true; glow.col.needsUpdate = true; glow.mesh.visible = glow.n > 0;
        if (res) glow.mesh.material.uniforms.uRes.value.copy(res);
      },
      dispose() { for (const m of meshes.values()) { scene.remove(m); m.dispose(); } for (const m of bakedMats.values()) m.dispose(); scene.remove(glow.mesh); glow.mesh.geometry.dispose(); glow.mesh.material.dispose(); mat.dispose(); if (K.farBatches) K.farBatches.delete(reg); },
      meshes, glow,
    };
    return api;
  }
  K.createFarBatch = createFarBatch;
})();
