// FVfx: effects around the aircraft. Tyre smoke where the wheels touch (the tyres spin up in a puff of rubber),
// contrails behind jet engines in the cold high air (they drift with the wind and spread as they age), and the
// landing lights' beams, which show in rain, fog and at night.
//   FVfx.update(dt, Flight)   per frame while flying      FVfx.touchdown(x, y, z, vel, sink)      FVfx.attach(model, type)
//   FVfx.clear()
const FVfx = (() => {
  const V3 = THREE.Vector3;
  const logV = `#include <common>\n#include <logdepthbuf_pars_vertex>\n`, logF = `#include <common>\n#include <logdepthbuf_pars_fragment>\n`;
  // ---------------------------------------------------------------- smoke puffs (one Points cloud)
  const NP = 600;
  let smoke = null; const puffs = [], dbg = {};
  function buildSmoke() {             // camera-facing quads, one instance per puff (GL points do not draw in this pipeline)
    const g = new THREE.InstancedBufferGeometry(), q = new THREE.PlaneGeometry(1, 1); g.index = q.index; g.setAttribute('position', q.attributes.position);
    g.setAttribute('aC', new THREE.InstancedBufferAttribute(new Float32Array(NP * 3), 3));
    g.setAttribute('aSA', new THREE.InstancedBufferAttribute(new Float32Array(NP * 2), 2));
    g.instanceCount = 0;
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(0.8, 0.8, 0.8) } },
      vertexShader: logV + `attribute vec3 aC; attribute vec2 aSA; varying float vA; varying vec2 vUv;
        void main() { vec4 mv = viewMatrix * vec4(aC, 1.0); mv.xy += position.xy * aSA.x; gl_Position = projectionMatrix * mv; vA = aSA.y; vUv = position.xy;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: logF + `uniform vec3 uColor; varying float vA; varying vec2 vUv;
        void main() {
          #include <logdepthbuf_fragment>
          float r = length(vUv); if (r > 0.5) discard;
          float a = smoothstep(0.5, 0.08, r) * vA; gl_FragColor = vec4(uColor * (0.92 + 0.16 * vUv.y), a); }`,
    });
    smoke = new THREE.Mesh(g, m); smoke.frustumCulled = false; smoke.renderOrder = 5; smoke.layers.enable(1); Env.scene.add(smoke);
  }
  function touchdown(x, y, z, vel, sink) {
    if (!smoke) buildSmoke();
    const n = Math.round(6 + Math.min(10, sink / 40));
    for (let i = 0; i < n && puffs.length < NP; i++) {
      const s = Math.random();
      puffs.push({ p: new V3(x + (Math.random() - 0.5) * 1.2, y + 0.3, z + (Math.random() - 0.5) * 1.2),
        v: new V3(vel.x * (0.15 + 0.2 * s) + (Math.random() - 0.5) * 3, 0.6 + Math.random() * 1.2, vel.z * (0.15 + 0.2 * s) + (Math.random() - 0.5) * 3),
        age: -i * 0.03, life: 2.2 + Math.random() * 1.6, s0: 0.8 + Math.random() * 0.6, s1: 5 + Math.random() * 4 });
    }
  }
  function updateSmoke(dt, wind) {
    if (!smoke) return;
    const C = smoke.geometry.attributes.aC, SA = smoke.geometry.attributes.aSA;
    for (let i = puffs.length - 1; i >= 0; i--) { const q = puffs[i]; q.age += dt; if (q.age > q.life) { puffs.splice(i, 1); continue; }
      if (q.age < 0) continue; const drag = Math.exp(-dt * 1.4); q.v.multiplyScalar(drag).addScaledVector(wind, 1 - drag); q.p.addScaledVector(q.v, dt); }
    let k = 0;
    for (const q of puffs) { if (q.age < 0) continue; const t = q.age / q.life; C.setXYZ(k, q.p.x, q.p.y, q.p.z); SA.setXY(k, q.s0 + (q.s1 - q.s0) * Math.sqrt(t), (dbg.red ? 1 : 0.7) * Math.min(1, q.age * 8) * (1 - t) * (1 - t)); k++; }
    smoke.geometry.instanceCount = k; C.needsUpdate = SA.needsUpdate = true;
    const amb = typeof Sky !== 'undefined' && Sky.uniforms ? Sky.uniforms.uSkyAmbient.value : null, sun = typeof Sky !== 'undefined' && Sky.sunLight ? Sky.sunLight.intensity : 1;
    if (amb) smoke.material.uniforms.uColor.value.setRGB(amb.x * 1.6 + sun * 0.12, amb.y * 1.6 + sun * 0.12, amb.z * 1.6 + sun * 0.12);
    if (dbg.red) smoke.material.uniforms.uColor.value.setRGB(4, 0, 0);
  }

  // ---------------------------------------------------------------- contrails: a ribbon per engine
  const TR_MAX = 260, TR_DT = 0.25;
  let trails = [], trailT = 0, trailMat = null;
  function trailMaterial() {
    if (trailMat) return trailMat;
    trailMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: logV + `attribute float aA; varying float vA; varying float vS;
        void main() { vA = aA; vS = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: logF + `uniform vec3 uColor; varying float vA; varying float vS;
        void main() {
          #include <logdepthbuf_fragment>
          float e = 1.0 - pow(abs(vS * 2.0 - 1.0), 2.0); gl_FragColor = vec4(uColor, vA * e); }`,
    });
    return trailMat;
  }
  function trailMesh() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TR_MAX * 2 * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(TR_MAX * 2 * 2), 2));
    g.setAttribute('aA', new THREE.BufferAttribute(new Float32Array(TR_MAX * 2), 1));
    const idx = []; for (let i = 0; i < TR_MAX - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } g.setIndex(idx);
    const m = new THREE.Mesh(g, trailMaterial()); m.frustumCulled = false; m.renderOrder = 4; m.layers.enable(1); Env.scene.add(m);
    return m;
  }
  const tmp = new V3(), side = new V3(), toCam = new V3(), dir = new V3();
  function updateTrails(dt, F, wind) {
    const ac = F.ac, T = F.type, jets = T.model.engines.filter(e => e.type === 'fan' || e.type === 'jet');
    // persistent contrails where the air is cold enough (roughly below -40 C: ~8 km in the standard atmosphere)
    const on = jets.length && ac.pos.y > 7900 && !ac.out.onGround && F.model;
    if (on && trails.length !== jets.length) { clearTrails(); trails = jets.map(e => ({ e, pts: [], mesh: trailMesh() })); }
    trailT += dt;
    if (on) {
      // the head follows the nozzle every frame; a fixed point is left behind every TR_DT
      F.model.root.updateMatrixWorld(true); const drop = trailT >= TR_DT; if (drop) trailT = 0;
      for (const tr of trails) { const e = tr.e; tmp.set(e.x - (e.len || 3) - 1, -e.z, e.y).applyMatrix4(F.model.root.matrixWorld);
        if (!tr.head) tr.head = { p: tmp.clone(), age: 0 }; tr.head.p.copy(tmp);
        if (drop) { tr.pts.push({ p: tmp.clone(), age: 0 }); if (tr.pts.length > TR_MAX - 1) tr.pts.shift(); } }
    } else for (const tr of trails) tr.head = null;
    if (!trails.length) return;
    const cam = Env.camera.position, amb = typeof Sky !== 'undefined' && Sky.uniforms ? Sky.uniforms.uSkyAmbient.value : null, sun = typeof Sky !== 'undefined' && Sky.sunLight ? Sky.sunLight.intensity : 1;
    if (amb) trailMat.uniforms.uColor.value.setRGB(amb.x * 2.2 + sun * 0.46, amb.y * 2.2 + sun * 0.46, amb.z * 2.2 + sun * 0.47);   // (as bright as a sunlit cloud)
    if (dbg.red) trailMat.uniforms.uColor.value.setRGB(5, 0, 0);
    let any = false;
    for (const tr of trails) {
      for (const q of tr.pts) { q.age += dt; q.p.addScaledVector(wind, dt); }
      while (tr.pts.length && tr.pts[0].age > TR_MAX * TR_DT) tr.pts.shift();
      const L = tr.head ? tr.pts.concat([tr.head]) : tr.pts;
      const n = L.length, g = tr.mesh.geometry, P = g.attributes.position, UVs = g.attributes.uv, A = g.attributes.aA;
      for (let i = 0; i < n; i++) {
        const q = L[i], nb = L[Math.min(n - 1, i + 1)], pb = L[Math.max(0, i - 1)];
        dir.copy(nb.p).sub(pb.p); if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0); dir.normalize();
        toCam.copy(cam).sub(q.p).normalize(); side.crossVectors(dir, toCam).normalize();
        const w = 0.8 + 11 * Math.sqrt(q.age / (TR_MAX * TR_DT)), young = U.smooth(0.03, 0.4, q.age), old = 1 - U.smooth(0.6, 1, q.age / (TR_MAX * TR_DT));
        const a = (dbg.red ? 1 : 0.78) * young * old * (i === n - 1 ? 0 : 1);
        P.setXYZ(i * 2, q.p.x + side.x * w, q.p.y + side.y * w, q.p.z + side.z * w); P.setXYZ(i * 2 + 1, q.p.x - side.x * w, q.p.y - side.y * w, q.p.z - side.z * w);
        UVs.setXY(i * 2, i / TR_MAX, 0); UVs.setXY(i * 2 + 1, i / TR_MAX, 1); A.setX(i * 2, a); A.setX(i * 2 + 1, a);
      }
      g.setDrawRange(0, Math.max(0, (n - 1) * 6)); P.needsUpdate = UVs.needsUpdate = A.needsUpdate = true;
      if (n) any = true;
    }
    if (!on && !any) clearTrails();
  }
  function clearTrails() { for (const tr of trails) { Env.scene.remove(tr.mesh); tr.mesh.geometry.dispose(); } trails = []; }

  // ---------------------------------------------------------------- landing-light beams (cones on the aircraft)
  let beams = null;
  function attach(model, type) {
    beams = null; if (!model || !model.lamps || !model.lamps.landL) return;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
      uniforms: { uI: { value: 0 } },
      vertexShader: logV + `varying float vL; varying vec3 vN; varying vec3 vV;
        void main() { vL = uv.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: logF + `uniform float uI; varying float vL; varying vec3 vN; varying vec3 vV;
        void main() {
          #include <logdepthbuf_fragment>
          float edge = pow(abs(dot(vN, vV)), 1.5); gl_FragColor = vec4(vec3(1.0, 0.96, 0.88) * uI * edge * vL * vL, 1.0); }`,
    });
    const L = type.model.kind === 'ga' || type.fdm.heli ? 34 : 70, R = type.model.kind === 'ga' || type.fdm.heli ? 5 : 9;
    const geo = new THREE.CylinderGeometry(0.25, R, L, 20, 1, true); geo.translate(0, -L / 2, 0); geo.rotateZ(Math.PI / 2);   // apex at the lamp, opening forward (+x)
    beams = [];
    for (const k of ['landL', 'landR']) {
      const m = new THREE.Mesh(geo, mat); m.position.copy(model.lamps[k].position); m.rotation.z = -3 * Math.PI / 180; m.renderOrder = 7; m.frustumCulled = false;
      model.root.add(m); beams.push(m);
    }
    beams.mat = mat;
  }
  function updateBeams(F) {
    if (!beams || !F.model) return;
    const lit = F.model.lamps.landL.visible, night = U.uNight ? U.uNight.value : 0;
    const wet = typeof Precip !== 'undefined' ? Precip.state.rate : 0, fog = Env.state && Env.state.wx ? Env.state.wx.fog || 0 : 0;
    const I = lit ? Math.min(0.5, 0.05 + night * 0.16 + wet * 0.22 + fog * 0.1) * (F.cam.mode === 'cockpit' ? 0.5 : 1) : 0;
    beams.mat.uniforms.uI.value = I; for (const b of beams) b.visible = I > 0.005;
  }

  function update(dt, F) {
    if (!F || !F.ac) return;
    const wind = F.wind || tmp.set(0, 0, 0);
    updateSmoke(dt, wind); updateTrails(dt, F, wind); updateBeams(F);
  }
  function clear() { puffs.length = 0; if (smoke) smoke.geometry.instanceCount = 0; clearTrails(); beams = null; }
  // the frame moves: carry the smoke and the trails with it
  function initFrameHook() {
    if (typeof Globe === 'undefined') return;
    Globe.onFrame((f, o) => {
      const cv = (p) => { const lat = o.lat0 - p.z / o.mlat, lon = o.lon0 + p.x / o.mlon; p.x = (lon - f.lon0) * f.mlon; p.z = -(lat - f.lat0) * f.mlat; };
      for (const q of puffs) cv(q.p); for (const tr of trails) for (const q of tr.pts) cv(q.p);
    });
  }
  let hooked = false;
  return { update(dt, F) { if (!hooked) { hooked = true; initFrameHook(); } update(dt, F); }, touchdown, attach, clear, get puffs() { return puffs.length; }, get smoke() { return smoke; }, get trails() { return trails.map(t => ({ n: t.pts.length, draw: t.mesh.geometry.drawRange.count, inScene: !!t.mesh.parent, p0: t.pts[0] && t.pts[0].p, a: t.mesh.geometry.attributes.aA.array[2] })); }, dbg };
})();
