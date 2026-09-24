// ACModel: procedural 3D aircraft from the parameters in 46_aircraft.js, assembled from the airframe (48_acframe),
// engines, propellers, rotors, landing gear and lights (48_acparts), the cockpit (48_accockpit) and the livery
// (48_aclivery), all built with the geometry kit (48_acgeo). Every part is merged into one skinned mesh per
// material (about six draw calls outside); the moving parts are bones driven from the flight state: flaps, slats,
// spoilers, ailerons, elevators and the trimmable stabiliser, rudders, wing flex from the lift, fans, propellers and
// rotors, reversers, the gear (doors, retraction, oleos, torque links, bogies, wheels, steering) and the Concorde's
// droop nose. The model only reads the flight state.
//   const m = ACModel.build(type)        m.root (Object3D, model axes x fwd, y up, z right, origin = CG)
//   m.update(ac, dt, { night, inside })  animate from the FDM state;  m.panel (canvas texture for instruments)
//   m.eye (model-space eye point), m.dispose()
//   ACModel.lite(type, lod)              one merged vertex-coloured geometry for instanced traffic: 'far' (default),
//                                        'near' (gear up) or 'gear' (near, gear down)
//   ACModel.setQuality(level)            'low' | 'medium' | 'high' | 'ultra' | anything above ('ultraplus' ...):
//                                        applies to the next build
// Fictional "Bayline Air" scheme; types are named for identification only.
const ACModel = (() => {
  const D = Math.PI / 180, V3 = THREE.Vector3, G9 = 9.80665;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---------------------------------------------------------------- quality
  // 0 low, 1 medium, 2 high, 3 ultra, 4 the maximum (Ultra+ / WebGPU-class): any name above ultra, or unknown
  let quality = 2;
  function level(x) {
    if (typeof x === 'number' && isFinite(x)) return clamp(Math.round(x), 0, 4);
    if (x && typeof x === 'object') x = x.name || x.level || x.quality;
    const s = String(x === undefined || x === null ? '' : x).trim().toLowerCase();
    if (!s) return 2;
    if (/^\d+(\.\d+)?$/.test(s)) return clamp(Math.round(+s), 0, 4);
    const known = { low: 0, lowest: 0, min: 0, minimum: 0, potato: 0, mobile: 0, lite: 0, med: 1, medium: 1, mid: 1, normal: 1, standard: 1, default: 2, high: 2, ultra: 3 };
    if (s in known) return known[s];
    if (/low|min|potato|mobile/.test(s)) return 0;
    if (/med|mid|normal/.test(s)) return 1;
    return 4;          // ultraplus, ultra+, max, epic, cinematic, webgpu, anything new: the top
  }
  function setQuality(x) { quality = level(x); return quality; }

  // ---------------------------------------------------------------- planforms (texture atlas mapping)
  function planforms(m) {
    const pf = {}, w = m.wing, v = m.vtail;
    if (w) {
      const y0 = w.y0 || 0, span = w.span, tanS = Math.tan((w.sweep || 0) * D);
      const chord = (y) => (w.yK ? (y < w.yK ? w.c0 + (w.cK - w.c0) * (y - y0) / (w.yK - y0) : w.cK + (w.c1 - w.cK) * (y - w.yK) / (span - w.yK)) : w.c0 + (w.c1 - w.c0) * (y - y0) / (span - y0));
      const le = (y) => w.x - (y - y0) * tanS;
      const zmin = Math.max(0, y0 - 1.2), zmax = span + 0.5, xmax = w.x + 0.3, xmin = Math.min(w.x - w.c0, le(span) - w.c1) - 0.3;
      pf.wing = { zmin, zmax, xmin, xmax, leF: (f) => (xmax - le(zmin + (zmax - zmin) * f)) / (xmax - xmin), cF: (f) => chord(clamp(zmin + (zmax - zmin) * f, y0, span)) / (xmax - xmin) };
    }
    if (v) {
      const tanS = Math.tan(v.sweep * D), xmax = v.x + 0.4, xmin = Math.min(v.x - v.c0, v.x - v.h * tanS - v.c1) - 0.6, ymin = -v.z - 0.9, ymax = -v.z + v.h + 0.3;
      const hE = 0.42, xLE = v.x - v.h * hE * tanS, c = v.c0 + (v.c1 - v.c0) * hE, xc = xLE - c * (1 - v.rud) * 0.5;
      pf.fin = { xmin, xmax, ymin, ymax, emX: (xc - xmin) / (xmax - xmin), emH: (-v.z + v.h * hE - ymin) / (ymax - ymin), emR: Math.min(c * (1 - v.rud) * 0.46, v.h * 0.2) / (xmax - xmin) };
    }
    return pf;
  }

  // ---------------------------------------------------------------- the geometry pass
  // Builds every part into batches with their bones; shared by build() (textured, skinned, animated) and lite()
  // (posed, baked and vertex-coloured for the traffic). opt.lite: no cockpit; opt.far: the coarse traffic LOD.
  // A generator: it yields between parts, so the traffic's detailed models can be built a few milliseconds per
  // frame in the background (see lite); geometry() runs it through.
  function geometry(type, q, opt) { const g = geometrySteps(type, q, opt); let r = g.next(); while (!r.done) r = g.next(); return r.value; }
  function* geometrySteps(type, q, opt = {}) {
    const m = type.model, jet = m.kind === 'jet';
    const H = ACFrame.hull(type, q), rig = new ACGeo.Rig(), B = new ACGeo.Batch(), pf = planforms(m);
    const WR = ACLivery.WING_R, FR = ACLivery.FIN_R;
    const ctx = { B, rig, q, pal: ACLivery.pal, tile: 1, jet, type, H, pf, far: !!opt.far, lite: !!opt.lite, uvBody: ACLivery.uvBodyFor(H), FIN_R: FR };
    const env = { wings: [], htails: [], fin: null, anim: [], lamps: {}, root: null, discs: null, gear: [] };
    // the fuselage (the Concorde's nose droops on its own bone, blended over half a metre)
    let droop = null;
    if (m.droop) {
      const hs = m.droop, p = new V3(); H.pt(hs, Math.PI, p);
      const b = rig.add(0, p.x, p.y, 0);
      droop = { bone: b, ang: 0 };
      ctx.skin = (x, y, z, out) => { const s = m.nose - x, k = clamp((hs + 0.25 - s) / 0.5, 0, 1); out[0] = 0; out[1] = b; out[2] = k; };
    }
    ACFrame.buildHull(H, ctx); ctx.skin = null;
    yield;
    // wings: span bones for the flex (also at every engine), the skin blended between them; panels hang from them
    const w = m.wing;
    const flexSet = (side) => {
      const n = opt.far ? 1 : [3, 4, 5, 6, 7][q], ys = [], bones = [], y0 = w.y0 || 0;
      const sts = []; for (let k = 0; k <= n; k++) sts.push(y0 + (w.span - y0) * k / n);
      for (const e of m.engines) if (Math.abs(e.y) > y0 + 0.3 && Math.abs(e.y) < w.span - 0.3) sts.push(Math.abs(e.y));
      sts.sort((a, b) => a - b);
      for (const y of sts) {
        if (ys.length && y - ys[ys.length - 1] < 0.3) continue;
        const k = (y - y0) / (w.span - y0), xLE = w.x - (y - y0) * Math.tan((w.sweep || 0) * D), c = w.c0 + (w.c1 - w.c0) * k;
        ys.push(y); bones.push(rig.add(0, xLE - c * 0.4, -w.z + (y - y0) * Math.tan((w.dih || 0) * D), side * y));
      }
      return { ys, bones, side };
    };
    const uvWing = (p, upper) => {
      const a = pf.wing, R = WR[upper ? 'wu' : 'wl'];
      return [R[0] + R[2] * clamp((Math.abs(p.z) - a.zmin) / (a.zmax - a.zmin), 0, 1), R[1] + R[3] * clamp((a.xmax - p.x) / (a.xmax - a.xmin), 0, 1)];
    };
    const plain = (spec) => ({ ...spec, flap: null, ail: null, spoil: null, slats: false, elev: 0, rud: 0 });   // (far LOD: no moving surfaces)
    if (w) for (const side of [1, -1]) {
      const flex = flexSet(side), engSt = m.engines.filter(e => Math.sign(e.y) === side).map(e => Math.abs(e.y));
      const ws = ACFrame.surface(opt.far ? plain(w) : w, { ...ctx, side, mat: 'wing', flex, uv: uvWing, rootIn: w.high ? 0 : Math.max(0, (w.y0 || 0) - 0.7), extraStations: engSt, noTip: !!(ACFrame.TIPS[w.tip] || w.tip === 'fence') });
      ws.flex = flex; env.wings.push(ws);
      ACFrame.wingDetails(w, ws, { ...ctx, side, flex, uv: uvWing });
      yield;
    }
    // horizontal tail: on the trimmable stabiliser (jets), all-moving (fighters), or fixed
    const ht = m.htail;
    let ths = 0;
    if (ht) {
      const y0 = ht.y0 || (jet ? m.fus.d * 0.16 : 0.18), pivot = new V3(ht.x - ht.c0 * 0.55, -ht.z, 0);
      const uvT = (p, upper) => { const R = WR[upper ? 'tu' : 'tl']; return [R[0] + R[2] * clamp(Math.abs(p.z) / (ht.span + 0.5), 0, 1), R[1] + R[3] * 0.5]; };
      if (!ht.allMoving && jet) ths = rig.add(0, pivot.x, pivot.y, 0);
      for (const side of [1, -1]) {
        const bone = ht.allMoving ? rig.add(0, pivot.x, pivot.y, side * y0) : ths;
        const spec = { ...ht, y0, tt: ht.t, twist: 0, cam: 0, elev: ht.allMoving ? 0 : ht.elev, flap: null, ail: null, spoil: null, slats: false };
        const hs = ACFrame.surface(opt.far ? plain(spec) : spec, { ...ctx, side, mat: 'wing', bone, uv: uvT, rootIn: Math.max(0, y0 - 0.35) });
        hs.bone = bone; env.htails.push(hs);
      }
    }
    // vertical tail (+ the dorsal fillet)
    const vt = m.vtail;
    const uvFin = (p, right) => { const a = pf.fin, R = FR[right ? 'r' : 'l']; const xf = clamp((p.x - a.xmin) / (a.xmax - a.xmin), 0, 1), hf = clamp((p.y - a.ymin) / (a.ymax - a.ymin), 0, 1); return [R[0] + R[2] * (right ? xf : 1 - xf), R[1] + R[3] * (1 - hf)]; };
    const finSpec = { x: vt.x, y0: 0, span: vt.h, c0: vt.c0, c1: vt.c1, sweep: vt.sweep, z: vt.z, t: vt.t, tt: vt.t, cam: 0, rud: !opt.far && vt.rud > 0.01 ? vt.rud : 0, rudSplit: vt.split };
    env.fin = ACFrame.surface(finSpec, { ...ctx, side: 1, mat: 'fin', vertical: true, bone: 0, uv: uvFin, rootIn: -Math.min(1.2, (m.fus.h || m.fus.d || 2) * 0.3) });
    ACFrame.finDetails(vt, env.fin, { ...ctx, uv: uvFin });
    yield;
    // engines, propellers, rotors, gear, lights; the cockpit
    yield* ACParts.steps(type, ctx, env);
    const cockpit = opt.lite ? null : ACCockpit.build(type, ctx, env);
    const parts = { ail: [], flap: [], spoil: [], elev: [], rud: [], slat: [], elevon: [] };
    for (const s of [...env.wings, ...env.htails, env.fin]) for (const p of s.panels) (parts[p.kind === 'spoiler' ? 'spoil' : p.kind] || (parts[p.kind] = [])).push(p);
    return { H, rig, B, pf, env, ctx, parts, ths, droop, cockpit };
  }

  // ---------------------------------------------------------------- materials
  function materials(T, m) {
    const tile = T.tile, ns = new THREE.Vector2(0.45, 0.45);
    const phys = (o) => new THREE.MeshPhysicalMaterial(Object.assign({ roughness: 1, metalness: 1, clearcoat: 1, clearcoatRoughness: 0.12 }, o));
    const matte = m.kind === 'fighter';
    const M = {
      body: phys({ map: T.fus.map, roughnessMap: T.fus.orm, metalnessMap: T.fus.orm, clearcoatMap: T.fus.orm, emissiveMap: T.fus.emis, emissive: 0xffffff, emissiveIntensity: 0, normalMap: tile, normalScale: ns }),
      wing: phys({ map: T.wing.map, roughnessMap: T.wing.orm, metalnessMap: T.wing.orm, clearcoatMap: T.wing.orm, normalMap: tile, normalScale: ns }),
      fin: phys({ map: T.fin.map, emissiveMap: T.fin.emis, emissive: 0xffffff, emissiveIntensity: 0, roughness: matte ? 0.6 : 0.36, metalness: 0.02, clearcoat: matte ? 0 : 1, normalMap: tile, normalScale: ns }),
      nac: phys({ map: T.nac.map, roughness: matte ? 0.6 : 0.34, metalness: 0.04, clearcoat: matte ? 0 : 1, normalMap: tile, normalScale: ns }),
      parts: phys({ map: T.pal.map, roughnessMap: T.pal.orm, metalnessMap: T.pal.orm, clearcoatMap: T.pal.orm, clearcoatRoughness: 0.15 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0x0b1015, roughness: 0.03, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.4 }),
      canopy: new THREE.MeshPhysicalMaterial({ color: m.kind === 'fighter' ? 0x4a3f22 : 0x8fa3b5, roughness: 0.04, metalness: 0.2, transparent: true, opacity: 0.34, depthWrite: false, envMapIntensity: 1.6, side: THREE.DoubleSide }),
      disc: new THREE.MeshBasicMaterial({ map: discTexture(), color: 0x2a2d31, transparent: true, opacity: 0, depthWrite: false }),
      flame: new THREE.MeshBasicMaterial({ map: flameTexture(), color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }),
    };
    if (!tile) for (const k of ['body', 'wing', 'fin', 'nac']) M[k].normalMap = null;
    return M;
  }
  // blur discs (props, fans, rotors: a soft ring with the tip stripe) and the reheat flame (shock diamonds)
  let discTex = null, flameTex = null;
  function discTexture() {
    if (discTex) return discTex;
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'), gr = g.createRadialGradient(128, 128, 8, 128, 128, 127);
    gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(0.3, 'rgba(255,255,255,.55)'); gr.addColorStop(0.88, 'rgba(255,255,255,.4)'); gr.addColorStop(0.92, 'rgba(255,220,120,.7)'); gr.addColorStop(0.97, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256); discTex = new THREE.CanvasTexture(c); discTex.colorSpace = THREE.SRGBColorSpace; return discTex;
  }
  function flameTexture() {
    if (flameTex) return flameTex;
    const c = document.createElement('canvas'); c.width = 256; c.height = 64; const g = c.getContext('2d'), img = g.createImageData(256, 64), d = img.data;
    for (let x = 0; x < 256; x++) { const u = x / 255, core = Math.pow(1 - u, 1.4), dia = 0.6 + 0.4 * Math.pow(Math.abs(Math.sin(u * 22)), 6) * (1 - u);
      for (let y = 0; y < 64; y++) { const v = Math.abs(y / 63 - 0.5) * 2, a = core * dia * Math.pow(1 - v, 1.5), o = (y * 256 + x) * 4;
        d[o] = 255; d[o + 1] = 140 + 100 * (1 - u); d[o + 2] = 60 + 190 * Math.max(0, 1 - u * 2.5); d[o + 3] = 255 * clamp(a, 0, 1); } }
    g.putImageData(img, 0, 0); flameTex = new THREE.CanvasTexture(c); flameTex.colorSpace = THREE.SRGBColorSpace; return flameTex;
  }

  // ---------------------------------------------------------------- the whole aircraft
  function build(type) {
    const q = quality, m = type.model, f = type.fdm, jet = m.kind === 'jet';
    const root = new THREE.Group(); root.name = 'aircraft-' + type.id;
    const G = geometry(type, q), { H, rig, B, env, parts, ths, droop, cockpit } = G;
    const T = ACLivery.get(type, H, q, G.pf); ACLivery.keep(type, q);
    const M = materials(T, m);
    if (cockpit) Object.assign(M, cockpit.materials(T));
    const size = Math.max(m.L, f.b || 0, m.rotor ? m.rotor.R * 2 : 0), sphere = new THREE.Sphere(new V3(0, 0, 0), size * 0.62 + 2);
    rig.build();
    const meshes = B.meshes(M, rig, sphere, { noShadow: ['glass', 'canopy', 'cabin', 'screens', 'fcu', 'panels', 'ewd', 'disc', 'flame'] });
    for (const me of meshes) { root.add(me); if (me.name === 'disc' || me.name === 'flame' || me.name === 'canopy') me.renderOrder = 4; }
    if (cockpit) cockpit.attach(root, meshes);
    for (const k in env.lamps) root.add(env.lamps[k]);
    if (env.spot) root.add(env.spot, env.spot.target);
    const stats = { vertices: B.vertices, bones: rig.bones.length, meshes: meshes.length, quality: q };

    // ---------------------------------------------------------------- animation
    const nF = f.flaps.length - 1, st = { flapDeg: 0, slatDeg: 0, flex: 0, flexV: 0, night: 0, inside: false, wasInside: false, t: 0 };
    const maxFlap = Math.max(1, ...f.flaps.map(x => x.deg)), maxSlat = Math.max(1, ...f.flaps.map(x => x.slat || 0));
    const tv = new V3(), w = m.wing, ht = m.htail;
    const tipFlex = w ? (w.flex !== undefined ? w.flex : jet ? (f.b || 30) * 0.018 : (f.b || 10) * 0.004) : 0;
    const rot = (p, ang) => { const b = rig.bone(p.bone); b.quaternion.setFromAxisAngle(p.axis, ang); return b; };
    function update(ac, dt, e = {}) {
      dt = Math.min(dt || 0, 0.1); st.t += dt; st.night = e.night || 0; st.inside = !!e.inside;
      const s = ac.surf, out = ac.out;
      // flaps and slats from the notch table (interpolated between notches); Fowler flaps slide aft and down
      const fp = clamp(ac.flapPos, 0, nF), fi = Math.min(Math.floor(fp), Math.max(0, nF - 1)), ft = nF ? fp - fi : 0, f0 = f.flaps[fi], f1 = f.flaps[Math.min(fi + 1, nF)];
      st.flapDeg = nF ? f0.deg + (f1.deg - f0.deg) * ft : 0; st.slatDeg = nF ? (f0.slat || 0) + ((f1.slat || 0) - (f0.slat || 0)) * ft : 0;
      const ext = st.flapDeg / maxFlap, sext = st.slatDeg / maxSlat;
      for (const p of parts.flap) {
        const b = rot(p, st.flapDeg * D * (jet ? 0.9 : 1));
        b.position.copy(b.userData.rest).addScaledVector(p.cd, p.c * (jet ? 0.16 : 0.06) * ext).addScaledVector(p.ud, -p.c * (jet ? 0.035 : 0.01) * ext);
      }
      for (const p of parts.slat) { const b = rot(p, -st.slatDeg * D); b.position.copy(b.userData.rest).addScaledVector(p.cd, -p.c * 0.075 * sext).addScaledVector(p.ud, -p.c * 0.02 * sext); }
      // ailerons (roll right: right aileron up), elevons (pitch and roll), spoilers (speed brake, ground, roll)
      const aDeg = s.ail * f.maxAil, de = s.elev * f.maxElev + (ac.ctl.trim || 0) * f.maxElev * 0.5;
      for (const p of parts.ail) rot(p, (p.side > 0 ? -aDeg : aDeg) * 0.85);
      for (const p of parts.elevon) rot(p, (p.side > 0 ? -aDeg : aDeg) * 0.7 - de * 0.8);
      const rollSp = Math.max(0, Math.abs(s.ail) - 0.2) * 0.9;
      for (const p of parts.spoil) {
        const outboard = p.idx >= Math.floor(p.n * 0.35), own = outboard && (p.side > 0 ? s.ail > 0 : s.ail < 0) ? rollSp * 35 : 0;
        rot(p, -Math.max(ac.spoilerPos * (out.onGround ? 50 : 38), own) * D);
      }
      // the stabiliser trims (jets), elevators, all-moving tails (+ roll), rudders
      if (ths) rig.bone(ths).quaternion.setFromAxisAngle(tv.set(0, 0, 1), -(ac.ctl.trim || 0) * 3.5 * D);
      for (const p of parts.elev) rot(p, -de);
      if (ht && ht.allMoving) for (const h of env.htails) rig.bone(h.bone).quaternion.setFromAxisAngle(tv.set(0, 0, 1), de * 0.9 + (h.side > 0 ? 1 : -1) * aDeg * 0.3);
      for (const p of parts.rud) rot(p, s.rud * f.maxRud);
      // wing flex: the tips rise with the lift (a damped spring, so gusts and touchdowns bounce them)
      if (w) {
        const lift = f.S ? (out.qbar || 0) * f.S * (out.CL || 0) / ((ac.mass || f.mass) * G9) : 1;
        const target = tipFlex * clamp(lift, -1, 3.5);
        st.flexV += ((target - st.flex) * 38 - st.flexV * 5.5) * dt; st.flex += st.flexV * dt;
        for (const ws of env.wings) {
          const fl = ws.flex, span0 = fl.ys[0], L2 = fl.ys[fl.ys.length - 1] - span0;
          fl.bones.forEach((bi, k) => {
            const u = (fl.ys[k] - span0) / L2, b = rig.bone(bi);
            b.position.copy(b.userData.rest); b.position.y += st.flex * u * u; b.quaternion.setFromAxisAngle(tv.set(1, 0, 0), -fl.side * Math.atan(2 * st.flex * u / L2));
          });
        }
      }
      // droop nose: 5 degrees to taxi and take off, 12.5 with the gear down to land, up above 250 kt
      if (droop) {
        const kt = out.cas / 0.514444, want = out.onGround ? (kt > 100 && ac.ctl.thr < 0.3 ? 12.5 : 5) : ac.gearPos > 0.5 ? 12.5 : kt < 250 ? 5 : 0;
        droop.ang += clamp(want - droop.ang, -dt * 2.5, dt * 2.5); rig.bone(droop.bone).quaternion.setFromAxisAngle(tv.set(0, 0, 1), -droop.ang * D);
      }
      for (const a of env.anim) a(ac, dt, st);
      if (env.discs) { let o = 0; for (const k in env.discs) o = Math.max(o, env.discs[k]); M.disc.opacity = o; M.disc.visible = o > 0.005; }
      M.flame.opacity = Math.min(1, st.flame || 0); M.flame.visible = (st.flame || 0) > 0.01; st.flame = 0;
      if (cockpit) cockpit.update(ac, dt, st);
      // from inside, the windows turn into a faint reflection (outside, the glass is dark and opaque)
      if (st.inside !== st.wasInside) {
        st.wasInside = st.inside; const g = M.glass;
        g.side = st.inside ? THREE.BackSide : THREE.FrontSide; g.transparent = st.inside; g.opacity = st.inside ? 0.07 : 1; g.depthWrite = !st.inside;
        g.color.set(st.inside ? 0x9fb4c8 : 0x0b1015); g.needsUpdate = true;
      }
      // night: cabin windows and the logo lights on the fin
      M.body.emissiveIntensity = st.night * (jet ? 1.1 : 0);
      M.fin.emissiveIntensity = st.night * (jet ? 0.55 : 0);
      rig.update();
    }
    function dispose() {
      for (const me of meshes) me.geometry.dispose();
      for (const k in M) if (M[k] && M[k].dispose) M[k].dispose();
      if (rig.skeleton) rig.skeleton.dispose();
      if (cockpit) cockpit.dispose();
      for (const k in env.lamps) { const l = env.lamps[k]; if (l.material) l.material.dispose(); }
    }
    env.root = root;
    U.global(root);
    return { root, update, dispose, eye: H.eye.clone(), panel: cockpit ? cockpit.panel : null, fcu: cockpit ? cockpit.fcu : null, inside: cockpit ? cockpit.group : new THREE.Group(),
      parts, lamps: env.lamps, spot: env.spot || null, type, stats };
  }

  // ---------------------------------------------------------------- traffic models
  // The same parts at the lowest detail (or coarser still for 'far'), posed (gear up, or down for 'gear'), the
  // skinning baked, every vertex coloured from the livery layout or its palette swatch, merged into one geometry.
  // lite(type, 'far') builds at once (a few ms); 'near' and 'gear' (one shared geometry pass, posed twice) are
  // built in the background, a few ms per frame: until they are ready lite(type, lod, true) returns null
  const liteCache = new Map(), liteJobs = new Map();
  function lite(type, lod = 'far', ifReady = false) {
    const key = type.id + '|' + lod;
    if (liteCache.has(key)) return ifReady ? liteCache.get(key) : liteCache.get(key).clone();
    if (lod === 'far' || !ifReady) {
      if (lod === 'far') liteCache.set(key, bakeLite(type, 'far', geometry(type, 0, { lite: true, far: true })));
      else { const G = geometry(type, 0, { lite: true }); liteCache.set(type.id + '|near', bakeLite(type, 'near', G)); liteCache.set(type.id + '|gear', bakeLite(type, 'gear', G)); }
      return ifReady ? liteCache.get(key) : liteCache.get(key).clone();
    }
    if (!liteJobs.has(type.id)) { liteJobs.set(type.id, { type, gen: geometrySteps(type, 0, { lite: true }) }); pump(); }
    return null;
  }
  let pumping = false;
  function pump() {
    if (pumping) return; pumping = true;
    const tick = () => {
      const t0 = performance.now();
      for (const [id, job] of liteJobs) {
        while (performance.now() - t0 < 4) { const r = job.gen.next(); if (r.done) { job.G = r.value; break; } }
        if (job.G) { liteCache.set(id + '|near', bakeLite(job.type, 'near', job.G)); liteCache.set(id + '|gear', bakeLite(job.type, 'gear', job.G)); liteJobs.delete(id); }
        break;          // (one job per frame)
      }
      if (liteJobs.size) (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : setTimeout)(tick); else pumping = false;
    };
    (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : setTimeout)(tick);
  }
  function bakeLite(type, lod, G) {
    const m = type.model, lv = m.livery, far = lod === 'far';
    const { rig, B, H, env } = G;
    if (!rig.skeleton) rig.build();
    // pose: the gear up unless 'gear'; everything else at rest
    const up = lod !== 'gear' && type.fdm.retract;
    for (const g of env.gear) if (!g.fixed) rig.bone(g.legB).quaternion.setFromAxisAngle(g.axis, up ? g.ang : 0);
    rig.update();
    const SC = ACLivery.scheme(type, H), mats = rig.skeleton.boneMatrices, c = new THREE.Color(), rgb = (hex) => { c.set(hex); return [c.r, c.g, c.b]; };
    const wingCol = rgb(m.kind === 'jet' ? (lv.wing || '#d2d6db') : lv.base), finCol = rgb(m.kind === 'jet' ? lv.tail : lv.tail || lv.base), nacCol = rgb(lv.nacelle || lv.base), glassCol = [0.05, 0.06, 0.08];
    const bm = [];                                 // bone matrices as Matrix4
    for (let i = 0; i < rig.bones.length; i++) bm.push(new THREE.Matrix4().fromArray(mats, i * 16));
    const geos = [], p = new V3(), n = new V3(), pa = new V3(), na = new V3(), pb = new V3(), nb = new V3();
    for (const key of Object.keys(B.parts)) {
      if (['disc', 'flame', 'cabin', 'screens', 'fcu', 'panels', 'ewd'].includes(key)) continue;
      const mb = B.parts[key], nv = mb.count; if (!nv) continue;
      const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
      for (let i = 0; i < nv; i++) {
        p.set(mb.P[i * 3], mb.P[i * 3 + 1], mb.P[i * 3 + 2]); n.set(mb.N[i * 3], mb.N[i * 3 + 1], mb.N[i * 3 + 2]);
        const b0 = mb.K[i * 3], b1 = mb.K[i * 3 + 1], wt = mb.K[i * 3 + 2];
        pa.copy(p).applyMatrix4(bm[b0]); na.copy(n).transformDirection(bm[b0]);
        if (wt > 0) { pb.copy(p).applyMatrix4(bm[b1]); nb.copy(n).transformDirection(bm[b1]); pa.lerp(pb, wt); na.lerp(nb, wt).normalize(); }
        pos[i * 3] = pa.x; pos[i * 3 + 1] = pa.y; pos[i * 3 + 2] = pa.z; nor[i * 3] = na.x; nor[i * 3 + 1] = na.y; nor[i * 3 + 2] = na.z;
        let k = key === 'wing' ? wingCol : key === 'fin' ? finCol : key === 'nac' ? nacCol : key === 'glass' ? glassCol : null;
        if (key === 'body') k = rgb(SC.colorAt(m.nose - p.x, p.y, !far));
        else if (key === 'parts' || !k) k = ACLivery.colorOf(ACLivery.palName(mb.T[i * 2], mb.T[i * 2 + 1]), lv);
        col[i * 3] = k[0]; col[i * 3 + 1] = k[1]; col[i * 3 + 2] = k[2];
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(mb.I.slice()); geos.push(g);
    }
    const merged = U.mergeGeometries(geos); merged.computeBoundingSphere();
    return merged;
  }
  return { build, lite, setQuality, level, geometry, get quality() { return quality; } };
})();
