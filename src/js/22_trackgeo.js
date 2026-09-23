// Trackside world: ballast bed + embankments, rails, ties, overhead catenary, tunnels, bridges,
// level crossings (animated gates/flashers), signals, mileposts. Streamed in 400 m chunks around the camera.
const TrackGeo = (() => {
  const CH = 400, NEAR = 3600, FAR = 4600;
  const group = new THREE.Group(); group.name = 'trackgeo';
  const chunks = new Map();
  const GAUGE = 1.435;
  const M = {};
  function mats() {
    M.ballast = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 });
    M.ballast.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWp;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix * vec4(transformed,1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vWp; float bh(vec2 p){ p = fract(p*vec2(233.34,851.73)); p += dot(p,p+23.45); return fract(p.x*p.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        { float fw = fwidth(vWp.x) + fwidth(vWp.z); float g1 = mix(bh(floor(vWp.xz * 9.0)), 0.5, smoothstep(0.02, 0.09, fw)); float g2 = mix(bh(floor(vWp.xz * 2.3)), 0.5, smoothstep(0.1, 0.4, fw));
          diffuseColor.rgb *= 0.78 + g1 * 0.35 + g2 * 0.2; }`);
    };
    M.rail = new THREE.MeshStandardMaterial({ color: 0x6d625a, roughness: 0.45, metalness: 0.75 });
    M.railTop = new THREE.MeshStandardMaterial({ color: 0xd6d8dc, roughness: 0.22, metalness: 1.0 });
    M.tie = new THREE.MeshStandardMaterial({ color: 0x9a968e, roughness: 0.9 });
    M.steel = new THREE.MeshStandardMaterial({ color: 0x8f949b, roughness: 0.5, metalness: 0.6 });
    M.galv = new THREE.MeshStandardMaterial({ color: 0xa9adb2, roughness: 0.45, metalness: 0.7 });
    M.wire = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.4, metalness: 0.8 });
    M.concrete = new THREE.MeshStandardMaterial({ color: 0xb3ada2, roughness: 0.85 });
    M.tunnel = new THREE.MeshStandardMaterial({ color: 0x55504a, roughness: 0.95, side: THREE.DoubleSide, envMapIntensity: 0.15 });
    M.lamp = new THREE.MeshBasicMaterial({ color: 0xfff1c8 });
    M.dark = new THREE.MeshStandardMaterial({ color: 0x222326, roughness: 0.7 });
    M.asphalt = new THREE.MeshStandardMaterial({ color: 0x4b4a48, roughness: 0.92 });
    M.gate = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 });
    M.sign = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    M.red = new THREE.MeshBasicMaterial({ color: 0x220000 });
    M.redOn = new THREE.MeshBasicMaterial({ color: 0xff3020 });
  }

  // ---------- helpers ----------
  const F = {};
  function sampleRange(s0, s1, step) { const out = []; for (let s = s0; s < s1; s += step) out.push(s); out.push(s1); return out; }
  function bedSpan(s) {
    const o = Track.offsets(s); let lo = Math.min(Track.lane(s, 0), Track.lane(s, 1)), hi = Math.max(Track.lane(s, 0), Track.lane(s, 1));
    for (const v of o) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return [lo - 2.1, hi + 2.1];
  }
  // ribbon along s with a cross-section profile: prof(s) -> [[lat, dy, r,g,b], ...]
  function ribbon(ss, prof, yFn) {
    const pos = [], col = [], idx = []; let cols = 0;
    ss.forEach((s, i) => {
      Track.frame(s, F); const p = prof(s); if (i === 0) cols = p.length;
      for (const [lat, dy, r, g, b, abs] of p) {
        const x = F.x + F.rx * lat, z = F.z + F.rz * lat;
        const y = abs !== undefined ? abs : (yFn ? yFn(s, F) : F.y) + dy;
        pos.push(x, y, z); col.push(r, g, b);
      }
      if (i > 0) for (let k = 0; k < cols - 1; k++) { const a = (i - 1) * cols + k, b = a + 1, c = a + cols, d = c + 1; idx.push(a, b, c, b, d, c); }
    });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  function localize(geo, ox, oz) { geo.translate(-ox, 0, -oz); return geo; }

  // ---------- chunk build ----------
  function buildChunk(ci) {
    const s0 = ci * CH, s1 = Math.min(Track.length, s0 + CH); if (s0 >= Track.length) return null;
    const g = new THREE.Group(); Track.frame((s0 + s1) / 2, F); const ox = F.x, oz = F.z; g.position.set(ox, 0, oz);
    const ss = sampleRange(s0, s1, 5);
    const tun = (s) => Track.inTunnel(s), brg = (s) => Track.onBridge(s);
    // ballast + formation/embankment skirt meeting the terrain (constant 8-column profile)
    const bedGeo = ribbon(ss, (s) => {
      const [lo, hi] = bedSpan(s); Track.frame(s, F); const y = F.y;
      const bal = [0.47, 0.44, 0.40], grass = [0.55, 0.48, 0.30], dirt = [0.50, 0.43, 0.33], deck = [0.35, 0.34, 0.33];
      const mid = [[lo - 1.2, -0.95, ...bal], [lo, -0.36, ...bal], [hi, -0.36, ...bal], [hi + 1.2, -0.95, ...bal]];
      if (brg(s) || tun(s)) return [[lo - 1.25, -1.6, ...deck], [lo - 1.25, -1.6, ...deck], ...mid, [hi + 1.25, -1.6, ...deck], [hi + 1.25, -1.6, ...deck]];
      const tl = Math.min(Terrain.h(F.x + F.rx * (lo - 12), F.z + F.rz * (lo - 12)), y + 6), tr = Math.min(Terrain.h(F.x + F.rx * (hi + 12), F.z + F.rz * (hi + 12)), y + 6);
      return [[lo - 12, 0, ...grass, tl - 0.25], [lo - 4, 0, ...dirt, (tl + y - 1.0) / 2], ...mid, [hi + 4, 0, ...dirt, (tr + y - 1.0) / 2], [hi + 12, 0, ...grass, tr - 0.25]];
    });
    g.add(new THREE.Mesh(localize(bedGeo, ox, oz), M.ballast)).receiveShadow = true;
    // rails for each running lane (+ extra tracks)
    const railsHead = [], railsWeb = [];
    const lanesAt = (s) => { const L = [Track.lane(s, 1), Track.lane(s, 0)]; const o = Track.offsets(s); for (const v of o) if (L.every(q => Math.abs(q - v) > 1.8)) L.push(v); return L; };
    const maxLanes = 4;
    for (let li = 0; li < maxLanes; li++) {
      for (const side of [-1, 1]) {
        const ok = ss.map(s => lanesAt(s)[li] !== undefined);
        let runStart = -1;
        for (let i = 0; i <= ss.length; i++) {
          if (i < ss.length && ok[i]) { if (runStart < 0) runStart = i; continue; }
          if (runStart >= 0 && i - runStart >= 2) {
            const sub = ss.slice(runStart, i);
            railsHead.push(ribbon(sub, (s) => { const c = lanesAt(s)[li] + side * GAUGE / 2; return [[c - 0.036, 0, 1, 1, 1], [c + 0.036, 0, 1, 1, 1]]; }));
            railsWeb.push(ribbon(sub, (s) => { const c = lanesAt(s)[li] + side * GAUGE / 2; return [[c - 0.075, -0.17, 1, 1, 1], [c - 0.036, -0.04, 1, 1, 1], [c - 0.036, 0, 1, 1, 1], [c + 0.036, 0, 1, 1, 1], [c + 0.036, -0.04, 1, 1, 1], [c + 0.075, -0.17, 1, 1, 1]]; }));
          }
          runStart = -1;
        }
      }
    }
    if (railsHead.length) { const m = new THREE.Mesh(localize(U.mergeGeometries(railsHead), ox, oz), M.railTop); g.add(m); }
    if (railsWeb.length) { const m = new THREE.Mesh(localize(U.mergeGeometries(railsWeb), ox, oz), M.rail); m.castShadow = true; g.add(m); }
    // catenary
    const cat = [];
    if (Track.electric((s0 + s1) / 2)) buildCatenary(ss, cat, ox, oz);
    if (cat.length) { const m = new THREE.Mesh(U.mergeGeometries(cat.filter(x => x.m === 'galv').map(x => x.g)), M.galv); m.castShadow = true; g.add(m);
      const w = cat.filter(x => x.m === 'wire').map(x => x.g); if (w.length) g.add(new THREE.Mesh(U.mergeGeometries(w), M.wire)); }
    // tunnels
    for (const [a, b] of Track.feat.tunnels) if (b > s0 && a < s1) buildTunnel(Math.max(a, s0), Math.min(b, s1), a, b, g, ox, oz);
    // bridges
    for (const [a, b] of Track.feat.bridges) if (b > s0 && a < s1) buildBridge(Math.max(a, s0), Math.min(b, s1), g, ox, oz);
    // mileposts every mile
    const mp = [];
    for (let m = Math.ceil(s0 / 1609.34); m * 1609.34 < s1; m++) { const s = m * 1609.34; const [lo] = bedSpan(s); Track.frame(s, F);
      const x = F.x + F.rx * (lo - 0.8) - ox, z = F.z + F.rz * (lo - 0.8) - oz; mp.push(U.place(new THREE.BoxGeometry(0.08, 1.4, 0.08), x, F.y - 0.2, z)); mp.push(signPlate('MP ' + m, x, F.y + 0.55, z, Math.atan2(F.dx, F.dz), g)); }
    if (mp.length) g.add(new THREE.Mesh(U.mergeGeometries(mp.filter(q => q && q.isBufferGeometry)), M.steel));
    return g;
  }
  const plateTex = new Map();
  function signPlate(text, x, y, z, yaw, g) {
    let t = plateTex.get(text);
    if (!t) { t = U.canvasTexture(128, 64, (c, w, h) => { c.fillStyle = '#f4f1e8'; c.fillRect(0, 0, w, h); c.fillStyle = '#111'; c.font = 'bold 30px Barlow Condensed, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, w / 2, h / 2 + 2); }); plateTex.set(text, t); }
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.25), new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.rotation.y = yaw + Math.PI / 2; g.add(m); return null;
  }

  function buildCatenary(ss, out, ox, oz) {
    const SPAN = 58; const start = Math.ceil(ss[0] / SPAN) * SPAN;
    const lanes = (s) => [Track.lane(s, 1), Track.lane(s, 0)];
    const HCW = (typeof TrainKit !== 'undefined' && TrainKit.PANTO_UP_Y) || 5.9, HMW = HCW + 1.25;   // contact wire meets the raised pantograph
    for (let s = start; s <= ss[ss.length - 1]; s += SPAN) {
      if (Track.inTunnel(s)) continue;
      Track.frame(s, F); const [lo, hi] = bedSpan(s); const y = F.y; const yaw = Math.atan2(F.dx, F.dz);
      const L = lanes(s); const zig = (Math.round(s / SPAN) % 2 ? 0.2 : -0.2);
      const wide = hi - lo > 11;
      const posts = wide ? [lo - 0.6, hi + 0.6] : [lo - 0.6, hi + 0.6];
      for (const pl of posts) {
        const x = F.x + F.rx * pl - ox, z = F.z + F.rz * pl - oz;
        out.push({ m: 'galv', g: U.place(new THREE.BoxGeometry(0.3, 8.6, 0.3), x, y + 3.3, z, 0, yaw) });
        out.push({ m: 'galv', g: U.place(new THREE.BoxGeometry(0.6, 0.5, 0.6), x, y - 0.8, z, 0, yaw) });
      }
      if (wide) { // portal beam across all tracks
        const a = posts[0], b = posts[1], mid = (a + b) / 2;
        const x = F.x + F.rx * mid - ox, z = F.z + F.rz * mid - oz;
        const beam = new THREE.BoxGeometry(b - a + 0.4, 0.35, 0.35); beam.rotateY(yaw + Math.PI / 2); beam.translate(x, y + 7.6, z); out.push({ m: 'galv', g: beam });
      } else { // cantilevers from each post over its nearest track
        for (const [pl, lane] of [[posts[0], Math.min(...L)], [posts[1], Math.max(...L)]]) {
          const a = pl, b = lane + zig; const mid = (a + b) / 2, len = Math.abs(b - a) + 0.2;
          const x = F.x + F.rx * mid - ox, z = F.z + F.rz * mid - oz;
          const arm = new THREE.BoxGeometry(len, 0.08, 0.08); arm.rotateY(yaw + Math.PI / 2); arm.translate(x, y + HMW, z); out.push({ m: 'galv', g: arm });
          const arm2 = new THREE.BoxGeometry(len, 0.06, 0.06); arm2.rotateY(yaw + Math.PI / 2); arm2.translate(x, y + HCW + 0.25, z); out.push({ m: 'galv', g: arm2 });
          const ins = U.place(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 6), F.x + F.rx * (a + Math.sign(b - a) * 0.4) - ox, y + HMW - 0.1, F.z + F.rz * (a + Math.sign(b - a) * 0.4) - oz, 0, 0, Math.PI / 2);
          out.push({ m: 'galv', g: ins });
        }
      }
    }
    // wires: contact wire + messenger per running lane, zig-zagging between poles
    for (const dir of [0, 1]) {
      const pts = [], mpts = [];
      for (const s of ss) { Track.frame(s, F); const lane = Track.lane(s, dir); const ph = (s / SPAN) % 2; const zig = (ph < 1 ? -0.2 + 0.4 * ph : 0.2 - 0.4 * (ph - 1));
        if (Track.inTunnel(s)) continue;
        pts.push([F.x + F.rx * (lane + zig) - ox, F.y + HCW, F.z + F.rz * (lane + zig) - oz]);
        const sag = Math.sin(Math.PI * ((s % SPAN) / SPAN)) * 0.35;
        mpts.push([F.x + F.rx * lane - ox, F.y + HMW - sag, F.z + F.rz * lane - oz]); }
      if (pts.length > 1) { out.push({ m: 'wire', g: tube(pts, 0.012) }); out.push({ m: 'wire', g: tube(mpts, 0.01) }); }
    }
  }
  function tube(pts, r) { // thin square tube along points
    const pos = [], idx = []; const P = pts.map(p => new THREE.Vector3(...p));
    for (let i = 0; i < P.length; i++) { const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)]; const t = b.clone().sub(a).normalize();
      const sd = new THREE.Vector3(-t.z, 0, t.x).normalize(); const up = new THREE.Vector3(0, 1, 0);
      for (const [u, v] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) pos.push(P[i].x + sd.x * u * r, P[i].y + up.y * v * r, P[i].z + sd.z * u * r);
      if (i > 0) for (let k = 0; k < 4; k++) { const a0 = (i - 1) * 4 + k, a1 = (i - 1) * 4 + (k + 1) % 4, b0 = i * 4 + k, b1 = i * 4 + (k + 1) % 4; idx.push(a0, b0, a1, a1, b0, b1); } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
  }

  function buildTunnel(a, b, ta, tb, g, ox, oz) {
    const ss = sampleRange(a, b, 5); const pos = [], idx = []; const SEG = 14;
    ss.forEach((s, i) => { Track.frame(s, F); const [lo, hi] = bedSpan(s); const c = (lo + hi) / 2, w = (hi - lo) / 2 + 1.5, H = 7.2;
      for (let k = 0; k <= SEG; k++) { const t = k / SEG * Math.PI; const lat = c - Math.cos(t) * w, y = F.y - 1 + Math.sin(t) * H + (k === 0 || k === SEG ? 0 : 0);
        pos.push(F.x + F.rx * lat - ox, y, F.z + F.rz * lat - oz); }
      if (i > 0) for (let k = 0; k < SEG; k++) { const p0 = (i - 1) * (SEG + 1) + k, p1 = p0 + 1, q0 = p0 + SEG + 1, q1 = q0 + 1; idx.push(p0, q0, p1, p1, q0, q1); } });
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, M.tunnel); m.castShadow = true; m.receiveShadow = true; g.add(m);
    // lights every 25 m along both walls
    const lights = [];
    for (let s = Math.ceil(a / 25) * 25; s < b; s += 25) { Track.frame(s, F); const [lo, hi] = bedSpan(s);
      for (const lat of [lo - 1.1, hi + 1.1]) lights.push(U.place(new THREE.BoxGeometry(0.5, 0.12, 0.12), F.x + F.rx * lat - ox, F.y + 3.2, F.z + F.rz * lat - oz, 0, Math.atan2(F.dx, F.dz))); }
    if (lights.length) g.add(new THREE.Mesh(U.mergeGeometries(lights), M.lamp));
    // portals
    for (const [s, sgn] of [[ta, -1], [tb, 1]]) { if (s < a - 1 || s > b + 1) continue; Track.frame(s, F); const [lo, hi] = bedSpan(s); const c = (lo + hi) / 2, w = (hi - lo) / 2 + 1.5;
      const shape = new THREE.Shape(); shape.moveTo(-w - 5, -2); shape.lineTo(w + 5, -2); shape.lineTo(w + 5, 11); shape.lineTo(-w - 5, 11); shape.closePath();
      const hole = new THREE.Path(); hole.moveTo(-w, -1); for (let k = 0; k <= 16; k++) { const t = k / 16 * Math.PI; hole.lineTo(-Math.cos(t) * w, -1 + Math.sin(t) * 7.2); } hole.lineTo(w, -1); shape.holes.push(hole);
      const pg = new THREE.ExtrudeGeometry(shape, { depth: 1.2, bevelEnabled: false }); pg.translate(0, 0, -0.6);
      const mm = new THREE.Mesh(pg, M.concrete); mm.position.set(F.x + F.rx * c - ox, F.y - 0.8, F.z + F.rz * c - oz);
      mm.rotation.y = Math.atan2(F.dx, F.dz); mm.castShadow = true; mm.receiveShadow = true; g.add(mm); }
  }
  function buildBridge(a, b, g, ox, oz) {
    const ss = sampleRange(a, b, 5); const girders = [];
    girders.push(ribbon(ss, (s) => { const [lo] = bedSpan(s); return [[lo - 0.9, -2.4, 0.5, 0.5, 0.5], [lo - 0.9, 0.9, 0.55, 0.55, 0.55]]; }));
    girders.push(ribbon(ss, (s) => { const [, hi] = bedSpan(s); return [[hi + 0.9, 0.9, 0.55, 0.55, 0.55], [hi + 0.9, -2.4, 0.5, 0.5, 0.5]]; }));
    girders.push(ribbon(ss, (s) => { const [lo, hi] = bedSpan(s); return [[lo - 0.9, -2.4, 0.4, 0.4, 0.4], [hi + 0.9, -2.4, 0.4, 0.4, 0.4]].reverse(); }));
    const gg = localize(U.mergeGeometries(girders), ox, oz); const m = new THREE.Mesh(gg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide })); m.castShadow = true; g.add(m);
    const piers = [];
    for (let s = a + 10; s < b; s += 22) { Track.frame(s, F); const [lo, hi] = bedSpan(s); const ground = Terrain.h(F.x, F.z); const top = F.y - 2.4; const hgt = top - ground + 1;
      if (hgt < 1.5) continue; const c = (lo + hi) / 2; piers.push(U.place(new THREE.BoxGeometry(1.2, hgt, hi - lo + 1.2), F.x + F.rx * c - ox, ground + hgt / 2 - 1, F.z + F.rz * c - oz, 0, Math.atan2(F.dx, F.dz))); }
    if (piers.length) { const pm = new THREE.Mesh(U.mergeGeometries(piers), M.concrete); pm.castShadow = true; pm.receiveShadow = true; g.add(pm); }
  }

  // ---------- ties (sliding instanced window) ----------
  let ties = null, tieCenter = -1e9;
  function updateTies(camS, camDist) {
    if (camDist > 700) { if (ties) ties.visible = false; return; }
    if (ties) ties.visible = true;
    if (Math.abs(camS - tieCenter) < 60 && ties) return; tieCenter = camS;
    const R = 320, SP = 0.61; const cap = 6000;
    if (!ties) { const geo = new THREE.BoxGeometry(2.6, 0.2, 0.26); ties = new THREE.InstancedMesh(geo, M.tie, cap); ties.castShadow = false; ties.receiveShadow = true; ties.frustumCulled = false; group.add(ties); }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    let k = 0;
    for (let s = Math.max(0, camS - R); s < Math.min(Track.length, camS + R) && k < cap - 3; s += SP) {
      if (Track.onBridge(s) && false) continue;
      Track.frame(s, F); const yaw = Math.atan2(F.dx, F.dz) + Math.PI / 2;
      const L = [Track.lane(s, 1), Track.lane(s, 0)]; const o = Track.offsets(s); for (const v of o) if (L.every(q2 => Math.abs(q2 - v) > 1.8)) L.push(v);
      for (const lane of L) { if (k >= cap) break; p.set(F.x + F.rx * lane, F.y - 0.27, F.z + F.rz * lane); m4.compose(p, q.setFromEuler(e.set(0, yaw, 0)), one); ties.setMatrixAt(k++, m4); }
    }
    ties.count = k; ties.instanceMatrix.needsUpdate = true;
  }

  // ---------- crossings & signals (dynamic) ----------
  const crossings = [], signals = [];
  let crossGroup = null, sigGroup = null;
  function buildCrossings() {
    crossGroup = new THREE.Group(); group.add(crossGroup);
    const armGeo = (() => { const parts = []; for (let i = 0; i < 8; i++) parts.push(U.tint(U.place(new THREE.BoxGeometry(0.62, 0.12, 0.08), 0.35 + i * 0.62, 0, 0), i % 2 ? 0xd8202a : 0xf2f2f2)); return U.mergeGeometries(parts); })();
    const mastGeo = U.mergeGeometries([U.tint(new THREE.CylinderGeometry(0.09, 0.09, 4.2, 8).translate(0, 2.1, 0), 0xdfe0e2),
      U.tint(U.place(new THREE.BoxGeometry(1.25, 0.08, 0.04), 0, 3.6, 0, 0, 0, Math.PI / 4), 0xf5f5f0), U.tint(U.place(new THREE.BoxGeometry(1.25, 0.08, 0.04), 0, 3.6, 0, 0, 0, -Math.PI / 4), 0xf5f5f0),
      U.tint(U.place(new THREE.BoxGeometry(1.0, 0.1, 0.1), 0, 2.7, 0), 0x222222), U.tint(U.place(new THREE.BoxGeometry(0.5, 0.5, 0.3), 0, 0.9, 0.0), 0x3a3a3a)]);
    const lampGeo = new THREE.CircleGeometry(0.14, 12);
    for (const c of Track.feat.crossings) {
      Track.frame(c.s, F); const [lo, hi] = bedSpan(c.s); const yaw = Math.atan2(F.dx, F.dz);
      const obj = { s: c.s, arms: [], lamps: [], t: 0, active: false, x: F.x, z: F.z, root: null };
      // root frame: +Z along +s, +X = left of +s (so lateral offset lat maps to x = -lat)
      const root = new THREE.Group(); root.position.set(F.x, F.y - 0.4, F.z); root.rotation.y = yaw; crossGroup.add(root); obj.root = root;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(hi - lo + 3, 0.14, 7.5), M.asphalt); panel.position.set(-(lo + hi) / 2, 0.32, 0); panel.receiveShadow = true; root.add(panel);
      for (const [lat, along] of [[lo - 2.6, -4.6], [hi + 2.6, 4.6]]) {
        const m = new THREE.Group(); m.position.set(-lat, 0, along); m.rotation.y = Math.PI / 2; root.add(m); // mast-local +Z faces road traffic
        const mast = new THREE.Mesh(mastGeo, M.gate); mast.castShadow = true; m.add(mast);
        const pivot = new THREE.Group(); pivot.position.set(0, 1.1, 0.25); m.add(pivot);
        const arm = new THREE.Mesh(armGeo, M.gate); arm.castShadow = true; pivot.add(arm);
        pivot.rotation.y = along < 0 ? Math.PI : 0; obj.arms.push(pivot);
        const lm = M.red.clone(); obj.lamps.push(lm);
        const lm2 = M.red.clone(); obj.lamps.push(lm2);
        for (const [dx, mat] of [[-0.32, lm], [0.32, lm2]]) for (const zf of [0.07, -0.07]) { const l = new THREE.Mesh(lampGeo, mat); l.position.set(dx, 2.7, zf); if (zf < 0) l.rotation.y = Math.PI; m.add(l); }
      }
      root.visible = false; crossings.push(obj);
    }
  }
  function buildSignals() {
    sigGroup = new THREE.Group(); group.add(sigGroup);
    const mast = U.mergeGeometries([new THREE.CylinderGeometry(0.1, 0.12, 5.2, 8).translate(0, 2.6, 0), U.place(new THREE.BoxGeometry(0.45, 1.25, 0.3), 0, 4.9, 0)]);
    const lampG = new THREE.CircleGeometry(0.1, 10);
    const placed = [];
    for (const sg of Track.feat.signals) {
      const dir = sg.off >= 0 ? 1 : 0;
      if (placed.some(p => p.dir === dir && Math.abs(p.s - sg.s) < 60)) continue; placed.push({ s: sg.s, dir });
      Track.frame(sg.s, F); const [lo, hi] = bedSpan(sg.s); const lat = dir ? hi + 0.9 : lo - 0.9;
      const root = new THREE.Group(); root.position.set(F.x + F.rx * lat, F.y - 0.4, F.z + F.rz * lat);
      root.rotation.y = Math.atan2(F.dx, F.dz) + (dir ? Math.PI : 0); sigGroup.add(root);   // lamps face the approaching train
      const mm = new THREE.Mesh(mast, M.dark); mm.castShadow = true; root.add(mm);
      const lamps = [0xff2a1a, 0xffc020, 0x30ff70].map((c, i) => { const m = new THREE.Mesh(lampG, new THREE.MeshBasicMaterial({ color: 0x111111 })); m.position.set(0, 5.28 - i * 0.38, 0.16); m.userData.on = c; root.add(m); return m; });
      root.visible = false; signals.push({ s: sg.s, dir, lamps, state: -1, root, x: root.position.x, z: root.position.z });
    }
  }
  function updateDynamic(dt, trains, camPos) {
    const t = U.uTime.value; const blink = Math.floor(t * 1.9) % 2;
    for (const c of crossings) {
      const near = Math.abs(c.x - camPos.x) < 1600 && Math.abs(c.z - camPos.z) < 1600; c.root.visible = near;
      let act = false;
      for (const tr of trains) { const ahead = (c.s - tr.s) * (tr.dir ? 1 : -1); if (ahead > -(tr.len || 200) - 8 && ahead < Math.max(320, tr.v * 30)) { act = true; break; } }
      c.active = act; if (!near && !act && c.t === 0) continue;
      c.t = U.clamp(c.t + (act ? dt / 6 : -dt / 8), 0, 1);
      const down = U.smooth(0.2, 1, c.t);
      for (const a of c.arms) a.rotation.z = (1 - down) * 1.47;
      const on = act || c.t > 0.02;
      c.lamps[0].color.setHex(on && blink ? 0xff3020 : 0x2a0806); c.lamps[1].color.setHex(on && !blink ? 0xff3020 : 0x2a0806);
      c.lamps[2].color.setHex(on && blink ? 0xff3020 : 0x2a0806); c.lamps[3].color.setHex(on && !blink ? 0xff3020 : 0x2a0806);
    }
    for (const sg of signals) {
      const near = Math.abs(sg.x - camPos.x) < 1800 && Math.abs(sg.z - camPos.z) < 1800; sg.root.visible = near;   // state is computed for every signal (drivers read signals far ahead)
      let occ = 1e9;
      for (const tr of trains) { if (tr.dir !== sg.dir) continue; const beyond = (tr.s - sg.s) * (sg.dir ? 1 : -1); if (beyond > 4 && beyond < occ) occ = beyond; }
      const st = occ < 1500 ? 0 : occ < 3200 ? 1 : 2;
      if (st !== sg.state) { sg.state = st; sg.lamps.forEach((l, i) => l.material.color.setHex(i === st ? l.userData.on : 0x111111)); }
    }
  }
  // aspect a driver sees for the next signal ahead of s in direction dir: {dist, aspect 0 red..2 green}
  function nextSignal(s, dir) { let best = null, bd = 4000; for (const sg of signals) { if (sg.dir !== dir) continue; const d = (sg.s - s) * (dir ? 1 : -1); if (d > 0 && d < bd) { bd = d; best = sg; } } return best ? { dist: bd, aspect: best.state < 0 ? 2 : best.state, s: best.s } : null; }
  const _cn = []; function crossingsNear(pos, r) { _cn.length = 0; for (const c of crossings) { const d = Math.hypot(c.x - pos.x, c.z - pos.z); if (d < r) _cn.push({ dist: d, active: c.active }); } return _cn; }

  // ---------- far line (visible from the air) ----------
  const farPieces = [];
  function buildFar() {
    // far ribbon, split into ~2 km pieces (local coords for precision); hidden near the camera where the detailed bed is
    const ss = sampleRange(0, Track.length, 25); const per = 80;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    for (let start = 0; start < ss.length - 1; start += per) {
      const end = Math.min(ss.length - 1, start + per); const sub = ss.slice(start, end + 1);
      Track.frame(sub[Math.floor(sub.length / 2)], F); const ox = F.x, oz = F.z;
      const geo = localize(ribbon(sub, (s) => { const [lo, hi] = bedSpan(s); return [[lo - 1.5, -1.25, 0.42, 0.40, 0.37], [(lo + hi) / 2, -0.75, 0.33, 0.31, 0.29], [hi + 1.5, -1.25, 0.42, 0.40, 0.37]]; }), ox, oz);
      const m = new THREE.Mesh(geo, mat); m.position.set(ox, 0, oz); m.name = 'farline'; group.add(m);
      farPieces.push({ m, x: ox, z: oz, s0: sub[0], s1: sub[sub.length - 1] });
    }
  }
  function updateFar(camPos, camS, dist) {
    const alt = camPos.y - Terrain.h(camPos.x, camPos.z);
    for (const p of farPieces) p.m.visible = !(dist < NEAR && alt < 900 && p.s1 > camS - 700 && p.s0 < camS + 700);
  }

  function init() { mats(); Env.scene.add(group); buildFar(); buildCrossings(); buildSignals(); }
  let buildQueue = [];
  function update(camPos, dt) {
    const near = Track.nearest(camPos.x, camPos.z, 6000);
    if (!near) { updateTies(0, 1e9); updateFar(camPos, -1e9, 1e9); return; }
    const camS = near.s; const dist = Math.hypot(near.dist, Math.max(0, camPos.y - Track.yAt(camS)));
    const need = new Set();
    if (dist < NEAR) { const r = Math.max(600, NEAR - dist); for (let ci = Math.floor((camS - r) / CH); ci <= Math.floor((camS + r) / CH); ci++) if (ci >= 0) need.add(ci); }
    for (const ci of need) if (!chunks.has(ci) && !buildQueue.includes(ci)) buildQueue.push(ci);
    buildQueue.sort((a, b) => Math.abs(a * CH - camS) - Math.abs(b * CH - camS));
    const t0 = performance.now();
    // build only once the fine terrain under the chunk has streamed in, so embankments meet the real ground
    for (let qi = 0; qi < buildQueue.length && performance.now() - t0 < 6; ) {
      const ci = buildQueue[qi]; if (chunks.has(ci)) { buildQueue.splice(qi, 1); continue; }
      const bb = chunkBox(ci);
      if (!Terrain.hasDetail(bb[0], bb[1], bb[2], bb[3])) { if (!ensured.has(ci)) { ensured.add(ci); Terrain.ensure(bb[0], bb[1], bb[2], bb[3], 2); } qi++; continue; }
      buildQueue.splice(qi, 1); const g = buildChunk(ci); if (g) { group.add(g); chunks.set(ci, g); }
    }
    for (const [ci, g] of chunks) if (!need.has(ci) && Math.abs(ci * CH - camS) > FAR) { group.remove(g); g.traverse(o => { if (o.geometry) o.geometry.dispose(); }); chunks.delete(ci); }
    updateTies(camS, dist); updateFar(camPos, camS, dist);
  }
  const ensured = new Set();
  function chunkBox(ci) {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; const P = {};
    for (let s = ci * CH; s <= Math.min(Track.length, (ci + 1) * CH); s += 50) { Track.frame(s, P); x0 = Math.min(x0, P.x); x1 = Math.max(x1, P.x); z0 = Math.min(z0, P.z); z1 = Math.max(z1, P.z); }
    return [x0 - 40, z0 - 40, x1 + 40, z1 + 40];
  }
  function prebuild(s, radius) { for (let ci = Math.floor((s - radius) / CH); ci <= Math.floor((s + radius) / CH); ci++) if (ci >= 0 && !chunks.has(ci)) { const g = buildChunk(ci); if (g) { group.add(g); chunks.set(ci, g); } } }
  return { init, update, updateDynamic, crossingsNear, nextSignal, prebuild, group, bedSpan };
})();
