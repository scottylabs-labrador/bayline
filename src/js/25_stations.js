// Stations: platforms fitted to the running lanes, canopies, name signs, lamps, benches, live departure
// boards (real timetable), historic/modern depot buildings (Depots.build), and waiting crowds.
const Stations = (() => {
  const group = new THREE.Group(); group.name = 'stations';
  const F = {}, F2 = {};
  const list = [];          // per station: { id, name, idx, s, plats:[{s0,s1,side,lat0,lat1,dirs}], stop:[sNB, sSB], door:[sideNB, sideSB], obj }
  const PH = 0.25;          // platform top above top of rail (m)
  const EDGE = 1.72;        // lane centre -> platform edge
  // depot styles per station (Depots.build styles; unknown styles fall back to 'modern')
  const DEPOT = {
    san_francisco: 'terminal', '22nd_street': 'shelter', bayshore: 'shelter', south_sf: 'modern', san_bruno: 'modern', place_MLBR: 'modern',
    broadway: 'mission', burlingame: 'mission', san_mateo: 'mission', hayward_park: 'modern', hillsdale: 'modern', belmont: 'modern',
    san_carlos: 'stone', redwood_city: 'modern', menlo_park: 'victorian', palo_alto: 'streamline', stanford: 'shelter', california_ave: 'shelter',
    san_antonio: 'shelter', mountain_view: 'modern', sunnyvale: 'mission', lawrence: 'modern', santa_clara: 'victorian', college_park: 'shelter',
    sj_diridon: 'diridon', tamien: 'modern', capitol: 'shelter', blossom_hill: 'shelter', morgan_hill: 'mission', san_martin: 'shelter', gilroy: 'mission',
  };
  const M = {};
  function mats() {
    M.plat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    M.plat.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vW;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW = (modelMatrix * vec4(transformed,1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vW; float ph(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }')
        .replace('#include <color_fragment>', `#include <color_fragment>
          { vec2 g = vW.xz; float fw = fwidth(g.x) + fwidth(g.y); float j = (step(0.965, fract(g.x * 0.5)) + step(0.965, fract(g.y * 0.5))) * (1.0 - smoothstep(0.02, 0.06, fw)); float sp = mix(ph(floor(g * 7.0)), 0.5, smoothstep(0.03, 0.1, fw)) * 0.06;
            diffuseColor.rgb *= (1.0 - 0.07 * clamp(j, 0.0, 1.0)) * (0.97 + sp); }`);
    };
    M.steel = new THREE.MeshStandardMaterial({ color: 0x3b3f45, roughness: 0.45, metalness: 0.7 });
    M.roof = new THREE.MeshStandardMaterial({ color: 0xe4ddd2, roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide, envMapIntensity: 0.6 });
    M.glass = new THREE.MeshStandardMaterial({ color: 0x9fc0cf, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
    M.props = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 });
    M.lampOn = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffe2b0, emissiveIntensity: 0, roughness: 0.4 });
    M.pool = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      map: U.canvasTexture(128, 128, (c, w, h) => { const g = c.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, w, h); }) });
  }

  // ---------- platform layout from OSM platforms + lanes ----------
  function layout(st) {
    const around = Track.feat.platforms.filter(p => p.s1 > st.s - 260 && p.s0 < st.s + 260);
    const plats = [];
    const lN = Track.lane(st.s, 0), lS = Track.lane(st.s, 1);
    const single = Math.abs(lS - lN) < 1.0;
    let sMin = 1e9, sMax = -1e9;
    for (const p of around) {
      const sm = (p.s0 + p.s1) / 2; const a = Track.lane(sm, 0), b = Track.lane(sm, 1);
      let side;
      if (single) side = p.off >= a ? 'R' : 'L';
      else if (p.off > b + 0.4) side = 'R'; else if (p.off < a - 0.4) side = 'L';
      else side = (b - a > 2 * EDGE + 2.4) ? 'I' : (p.off > (a + b) / 2 ? 'R' : 'L');
      let s0 = p.s0, s1 = Math.max(p.s1, p.s0 + 60);
      if (s1 - s0 < 120) { const m = (s0 + s1) / 2; s0 = m - 90; s1 = m + 90; }       // short OSM pieces -> a usable platform
      // width: area centreline -> twice the distance to its inner edge; line (edge) -> 4.5 m
      const inner = side === 'R' ? b + EDGE : side === 'L' ? a - EDGE : 0;
      let w = p.closed ? U.clamp(2 * Math.abs(p.off - inner), 3.4, 6.5) : U.clamp(Math.abs(p.off - inner) > 2.5 ? Math.abs(p.off - inner) : 4.5, 3.4, 6);
      if (Math.abs(p.off - inner) > 14) continue;                                          // belongs to another line (BART etc.)
      if (plats.some(q => q.side === side && q.s0 < s1 && s0 < q.s1)) { const q = plats.find(q => q.side === side && q.s0 < s1 && s0 < q.s1); q.s0 = Math.min(q.s0, s0); q.s1 = Math.max(q.s1, s1); continue; }
      plats.push({ s0, s1, side, w, ref: p.ref || '' });
    }
    if (!plats.length) { // no OSM platform: island if the tracks spread, else two side platforms
      const s0 = st.s - 100, s1 = st.s + 100;
      if (single) plats.push({ s0, s1, side: st.off >= lN ? 'R' : 'L', w: 4.5 });
      else if (lS - lN > 2 * EDGE + 2.4) plats.push({ s0, s1, side: 'I', w: 0 });
      else { plats.push({ s0, s1, side: 'L', w: 4.5 }, { s0, s1, side: 'R', w: 4.5 }); }
    }
    if (!single && !plats.some(p => p.side === 'I')) { // make sure both directions have a platform
      if (!plats.some(p => p.side === 'R')) { const q = plats[0]; plats.push({ s0: q.s0, s1: q.s1, side: 'R', w: 4.5 }); }
      if (!plats.some(p => p.side === 'L')) { const q = plats[0]; plats.push({ s0: q.s0, s1: q.s1, side: 'L', w: 4.5 }); }
    }
    if (st.id === 'san_francisco') for (const p of plats) { p.s0 = Math.max(0, p.s0); p.s1 = Math.max(p.s1, 225); }
    if (st.id === 'gilroy') for (const p of plats) { p.s0 = Math.min(p.s0, Track.length - 215); }
    for (const p of plats) { p.s0 = Math.max(0, p.s0); p.s1 = Math.min(Track.length - 1, p.s1); sMin = Math.min(sMin, p.s0); sMax = Math.max(sMax, p.s1); }
    // stop points (train head) and door sides per direction
    const pick = (dir) => plats.find(p => p.side === 'I') || plats.find(p => p.side === (dir ? 'R' : 'L')) || plats[0];
    const pN = pick(0), pS = pick(1);
    const doorSide = (p, dir) => { if (p.side === 'I') return dir ? -1 : 1; return p.side === 'R' ? 1 : -1; };
    st.plats = plats; st.sMin = sMin; st.sMax = sMax;
    st.platFor = [pN, pS];
    // head-of-train stop marks; at the terminals the whole train must fit on the track
    st.stop = [Math.min(Math.max(6, pN.s0 + 10), Track.length - 200), Math.max(Math.min(Track.length - 6, pS.s1 - 10), 200)];
    st.door = [doorSide(pN, 0), doorSide(pS, 1)];
  }
  // lateral extent of a platform at s: [latInner, latOuter]
  function platLat(p, s) {
    const a = Track.lane(s, 0), b = Track.lane(s, 1);
    if (p.side === 'R') return [b + EDGE, b + EDGE + p.w];
    if (p.side === 'L') return [a - EDGE, a - EDGE - p.w];
    return [a + EDGE, b - EDGE];
  }

  // ---------- geometry ----------
  function platformGeo(st, p, ox, oz) {
    const pos = [], col = [], idx = []; const ss = []; for (let s = p.s0; s < p.s1; s += 5) ss.push(s); ss.push(p.s1);
    const conc = [0.66, 0.62, 0.56], yel = [0.93, 0.74, 0.16], white = [0.9, 0.89, 0.85], edge = [0.52, 0.5, 0.46], apron = [0.47, 0.45, 0.41];
    ss.forEach((s, i) => {
      Track.frame(s, F); const [li, lo] = platLat(p, s); const sg = Math.sign(lo - li) || 1; const y = F.y + PH;
      // profile: face bottom (inner), top inner edge, yellow tactile strip, white line, top, outer edge, face bottom (outer)
      const prof = p.side === 'I'
        ? [[li, y - PH - 0.25, edge], [li, y, conc], [li + 0.6, y, yel], [li + 0.65, y, conc], [lo - 0.65, y, conc], [lo - 0.6, y, yel], [lo, y, conc], [lo, y - PH - 0.25, edge]]
        : [[li, y - PH - 0.25, edge], [li, y, conc], [li + sg * 0.6, y, yel], [li + sg * 0.65, y, white], [li + sg * 0.75, y, conc], [lo, y, conc], [lo + sg * 0.25, y - 0.28, edge],
           [lo + sg * 4.0, Math.min(Terrain.h(F.x + F.rx * (lo + sg * 4), F.z + F.rz * (lo + sg * 4)) - 0.05, y - 0.3), apron]];
      for (const [lat, yy, c] of prof) { pos.push(F.x + F.rx * lat - ox, yy, F.z + F.rz * lat - oz); col.push(...c); }
      if (i > 0) { const K = prof.length; for (let k = 0; k < K - 1; k++) { const a0 = (i - 1) * K + k, a1 = a0 + 1, b0 = a0 + K, b1 = b0 + 1; if (sg > 0 || p.side === 'I') idx.push(a0, a1, b0, a1, b1, b0); else idx.push(a0, b0, a1, a1, b0, b1); } }
    });
    // end caps
    const K = 8, last = ss.length - 1;
    const cap = (i, flip) => { for (let k = 1; k < K - 2; k++) { const a = i * K, b = i * K + k, c = i * K + k + 1; if (flip) idx.push(a, c, b); else idx.push(a, b, c); } };
    cap(0, true); cap(last, false);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }

  const signTex = new Map();
  function nameSignTex(name) {
    if (signTex.has(name)) return signTex.get(name);
    const t = U.canvasTexture(512, 96, (c, w, h) => {
      c.fillStyle = '#23272d'; c.fillRect(0, 0, w, h); c.fillStyle = '#d7263d'; c.fillRect(0, 0, 14, h);
      c.fillStyle = '#f4f2ec'; c.font = '600 54px "Barlow Condensed", "Arial Narrow", sans-serif'; c.textBaseline = 'middle'; c.fillText(name, 34, h / 2 + 3);
    });
    signTex.set(name, t); return t;
  }
  function buildStation(st) {
    const root = new THREE.Group(); Track.frame(st.s, F); const ox = F.x, oz = F.z; root.position.set(ox, 0, oz); root.name = st.id;
    const geos = st.plats.map(p => platformGeo(st, p, ox, oz));
    const plat = new THREE.Mesh(U.mergeGeometries(geos), M.plat); plat.receiveShadow = true; plat.castShadow = false; root.add(plat);
    // canopies, lamps, signs, benches along each platform
    const steel = [], roof = [], props = [], lampHeads = [], pools = [];
    const signs = [];
    for (const p of st.plats) {
      const len = p.s1 - p.s0; const mid = (p.s0 + p.s1) / 2;
      const canopyLen = Math.min(len * 0.45, 70);
      for (let s = p.s0 + 6; s < p.s1 - 4; s += 2.5) {
        Track.frame(s, F); const [li, lo] = platLat(p, s); const sg = Math.sign(lo - li) || 1; const w = Math.abs(lo - li); const y = F.y + PH;
        const yaw = Math.atan2(F.dx, F.dz); const at = (lat) => [F.x + F.rx * lat - ox, F.z + F.rz * lat - oz];
        const k = Math.round((s - p.s0) / 2.5);
        const inCanopy = Math.abs(s - mid) < canopyLen / 2;
        const cLat = p.side === 'I' ? (li + lo) / 2 : li + sg * Math.min(w * 0.55, 3.2);
        if (inCanopy) {
          if (k % 4 === 0) { const [x, z] = at(cLat); steel.push(U.place(new THREE.BoxGeometry(0.16, 3.5, 0.16), x, y + 1.75, z, 0, yaw)); }
          const [x, z] = at(cLat);
          if (k % 4 === 2) { lampHeads.push(U.place(new THREE.BoxGeometry(0.9, 0.06, 0.3), x, y + 3.24, z, 0, yaw + Math.PI / 2)); pools.push([x, y + 0.02, z, 4.2]); }
          if (k % 8 === 4) { const [bx, bz] = at(cLat + sg * 0.9); props.push(U.tint(U.place(new THREE.BoxGeometry(0.45, 0.07, 1.8), bx, y + 0.45, bz, 0, yaw), 0x6b4a2e), U.tint(U.place(new THREE.BoxGeometry(0.06, 0.45, 1.6), bx + 0, y + 0.22, bz, 0, yaw), 0x3b3f45)); }
        } else if (k % 10 === 5) {
          const [x, z] = at(p.side === 'I' ? (li + lo) / 2 : li + sg * Math.min(w - 0.6, 2.6));
          steel.push(U.place(new THREE.CylinderGeometry(0.06, 0.08, 4.6, 8), x, y + 2.3, z));
          lampHeads.push(U.place(new THREE.BoxGeometry(0.5, 0.12, 0.22), x, y + 4.6, z, 0, yaw)); pools.push([x, y + 0.02, z, 5.5]);
        }
        if (k % 18 === 9 || (k === 3)) { // station name signs, both faces
          const [x, z] = at(p.side === 'I' ? (li + lo) / 2 : li + sg * Math.min(w - 0.4, 3.0));
          signs.push([x, y + 2.4, z, yaw]);
          steel.push(U.place(new THREE.BoxGeometry(0.08, 2.6, 0.08), x, y + 1.3, z - 0, 0, yaw));
        }
        if (k % 22 === 11) { const [x, z] = at(p.side === 'I' ? (li + lo) / 2 + 0.8 : li + sg * Math.min(w - 0.5, 2.4)); props.push(U.tint(U.place(new THREE.BoxGeometry(0.5, 1.5, 0.35), x, y + 0.75, z, 0, yaw), 0x2a2d33), U.tint(U.place(new THREE.BoxGeometry(0.4, 0.3, 0.02), x, y + 1.25, z, 0, yaw), 0x3f8fd1)); }
      }
    }
    // canopy roofs: one continuous, gently sloped ribbon (with a fascia) per platform
    for (const p of st.plats) {
      const len = p.s1 - p.s0; const mid = (p.s0 + p.s1) / 2; const cl = Math.min(len * 0.45, 70);
      const a = Math.max(p.s0 + 6, mid - cl / 2), b = Math.min(p.s1 - 4, mid + cl / 2); if (b - a < 8) continue;
      const pos = [], idx = []; let n = 0;
      for (let s = a; s <= b + 0.01; s += 2.5) {
        Track.frame(s, F); const [li, lo] = platLat(p, s); const sg = Math.sign(lo - li) || 1; const w = Math.abs(lo - li); const y = F.y + PH;
        const e0 = p.side === 'I' ? li + 0.3 : li + sg * 0.25, e1 = p.side === 'I' ? lo - 0.3 : li + sg * Math.min(w - 0.2, 5.4);
        const y0 = y + 3.55, y1 = p.side === 'I' ? y0 : y + 3.2;
        const P = (lat, yy) => pos.push(F.x + F.rx * lat - ox, yy, F.z + F.rz * lat - oz);
        P(e0, y0 - 0.35); P(e0, y0); P(p.side === 'I' ? (e0 + e1) / 2 : e1, p.side === 'I' ? y0 + 0.35 : y1); P(e1, y1); P(e1, y1 - 0.3);
        if (n > 0) for (let k = 0; k < 4; k++) { const q0 = (n - 1) * 5 + k, q1 = q0 + 1, r0 = q0 + 5, r1 = r0 + 1; idx.push(q0, q1, r0, q1, r1, r0); }
        n++;
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); roof.push(g);
    }
    if (steel.length) { const m = new THREE.Mesh(U.mergeGeometries(steel), M.steel); m.castShadow = true; root.add(m); }
    if (roof.length) { const m = new THREE.Mesh(U.mergeGeometries(roof), M.roof); m.castShadow = true; m.receiveShadow = true; root.add(m); }
    if (props.length) { const m = new THREE.Mesh(U.mergeGeometries(props), M.props); m.castShadow = true; root.add(m); }
    let lamps = null; if (lampHeads.length) { lamps = new THREE.Mesh(U.mergeGeometries(lampHeads), M.lampOn); root.add(lamps); }
    if (pools.length) { const pg = []; for (const [x, y, z, r] of pools) { const g = new THREE.PlaneGeometry(r * 2, r * 2); g.rotateX(-Math.PI / 2); g.translate(x, y, z); pg.push(g); } const pm = new THREE.Mesh(U.mergeGeometries(pg), M.pool); pm.renderOrder = 2; root.add(pm); }
    if (signs.length) {
      const sm = new THREE.MeshStandardMaterial({ map: nameSignTex(st.name), roughness: 0.5, emissive: 0xffffff, emissiveMap: nameSignTex(st.name), emissiveIntensity: 0 });
      st.signMat = sm; const sg = [];
      for (const [x, y, z, yaw] of signs) { const g = new THREE.PlaneGeometry(2.4, 0.45); const g2 = g.clone(); g2.rotateY(Math.PI); sg.push(U.place(g, x, y, z, 0, yaw + Math.PI / 2 + 0.0001), U.place(g2, x, y, z, 0, yaw + Math.PI / 2)); }
      const m = new THREE.Mesh(U.mergeGeometries(sg), sm); root.add(m);
      for (const [x, y, z, yaw] of signs) { const f = U.place(new THREE.BoxGeometry(2.5, 0.5, 0.04), x, y, z, 0, yaw + Math.PI / 2); const mm = new THREE.Mesh(f, M.steel); root.add(mm); mm.position.y -= 0.0; mm.scale.set(1, 1, 1); mm.translateZ(0); }
    }
    // stop-mark boards: where the head of the train must stop, facing the arriving driver
    if (!M.stopTex) M.stopTex = U.canvasTexture(128, 160, (c, w, h) => { c.fillStyle = '#f2c230'; c.fillRect(0, 0, w, h); c.strokeStyle = '#111'; c.lineWidth = 8; c.strokeRect(4, 4, w - 8, h - 8);
      c.fillStyle = '#111'; c.font = '800 40px Barlow Condensed, sans-serif'; c.textAlign = 'center'; c.fillText('STOP', w / 2, 58); c.fillRect(22, 78, w - 44, 26); c.fillStyle = '#f2c230'; c.fillRect(30, 84, 18, 12); c.fillRect(56, 84, 18, 12); c.fillRect(82, 84, 18, 12);
      c.fillStyle = '#111'; c.font = '700 30px Barlow Condensed, sans-serif'; c.fillText('7 CAR', w / 2, 140); });
    for (const dir of [0, 1]) {
      const p = st.platFor[dir]; if (!p) continue; const sS = st.stop[dir]; Track.frame(sS, F);
      const lat = Track.lane(sS, dir) + st.door[dir] * (EDGE + 0.45);
      const g = new THREE.Group(); g.position.set(F.x + F.rx * lat - ox, F.y + PH, F.z + F.rz * lat - oz);
      g.rotation.y = Math.atan2(F.dx, F.dz) + (dir ? Math.PI : 0);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.9, 0.07), M.steel); post.position.y = 0.95; g.add(post);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.58), new THREE.MeshStandardMaterial({ map: M.stopTex, roughness: 0.5, emissive: 0xffffff, emissiveMap: M.stopTex, emissiveIntensity: 0.05 }));
      board.position.set(0, 1.75, 0.04); g.add(board); const back = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.58), M.steel); back.position.set(0, 1.75, 0.035); back.rotation.y = Math.PI; g.add(back);
      root.add(g);
    }
    // departure boards (one per platform, near the middle)
    st.boards = [];
    for (const p of st.plats) {
      const s = (p.s0 + p.s1) / 2 + 12; Track.frame(s, F); const [li, lo] = platLat(p, s); const sg = Math.sign(lo - li) || 1;
      const lat = p.side === 'I' ? (li + lo) / 2 : li + sg * Math.min(Math.abs(lo - li) - 0.6, 2.8);
      const x = F.x + F.rx * lat - ox, z = F.z + F.rz * lat - oz, y = F.y + PH;
      const tex = U.canvasTexture(512, 160, () => {}); tex.anisotropy = 8;
      const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      const board = new THREE.Group(); board.position.set(x, y + 2.75, z); board.rotation.y = Math.atan2(F.dx, F.dz) + Math.PI / 2; root.add(board);
      const housing = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.78, 0.18), M.steel); board.add(housing);
      const f1 = new THREE.Mesh(new THREE.PlaneGeometry(2.16, 0.66), mat); f1.position.z = 0.095; board.add(f1);
      const f2 = new THREE.Mesh(new THREE.PlaneGeometry(2.16, 0.66), mat); f2.position.z = -0.095; f2.rotation.y = Math.PI; board.add(f2);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.4, 0.1), M.steel); post.position.y = -1.5; board.add(post);
      st.boards.push({ tex, dirs: p.side === 'I' ? [0, 1] : p.side === 'R' ? (Math.abs(Track.lane(st.s, 1) - Track.lane(st.s, 0)) < 1 ? [0, 1] : [1]) : (Math.abs(Track.lane(st.s, 1) - Track.lane(st.s, 0)) < 1 ? [0, 1] : [0]), last: '' });
    }
    // depot building beside the outermost platform (or the side with more room)
    const style = DEPOT[st.id] || 'shelter';
    if (style !== 'shelter' && typeof Depots !== 'undefined') {
      try {
        const side = st.plats.some(p => p.side === 'L') ? 'L' : st.plats.some(p => p.side === 'R') ? 'R' : 'L';
        const p = st.plats.find(q => q.side === side) || st.plats[0];
        const s = U.clamp(st.s, p.s0 + 25, p.s1 - 25); Track.frame(s, F); const [li, lo] = platLat(p, s); const sg = Math.sign(lo - li) || (side === 'L' ? -1 : 1);
        const d = Depots.build(style, { name: st.name, seed: U.hashStr(st.id) });
        const box = new THREE.Box3().setFromObject(d); const depth = box.max.z - box.min.z;
        const lat = lo + sg * (depth / 2 + 3);
        const gx = F.x + F.rx * lat, gz = F.z + F.rz * lat;
        d.position.set(gx - ox, Math.max(F.y + PH - 0.1, Terrain.h(gx, gz)), gz - oz);
        // depot long axis +X parallel to the track, track side = -Z
        const yaw = Math.atan2(-F.dz, F.dx); d.rotation.y = yaw + (sg > 0 ? 0 : Math.PI);
        d.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        root.add(d); st.depot = d;
      } catch (e) { console.warn('depot', st.id, e); }
    }
    st.lamps = lamps; st.obj = root; root.visible = false;
    group.add(root);
  }

  // ---------- departure boards (live) ----------
  function drawBoard(b, st, now) {
    const deps = Sim.nextDepartures(st.idx, b.dirs, now, 3);
    const key = deps.map(d => d.trip.id + ':' + Math.max(0, Math.round((d.t - now) / 60))).join('|') + (U.uNight.value > 0.5 ? 'n' : 'd');
    if (key === b.last) return; b.last = key;
    const c = b.tex.userData.ctx, w = 512, h = 160;
    c.fillStyle = '#0b0c0e'; c.fillRect(0, 0, w, h);
    c.font = '600 22px "IBM Plex Mono", monospace'; c.textBaseline = 'middle';
    c.fillStyle = '#6d7178'; c.fillText(st.name.toUpperCase(), 14, 18); c.textAlign = 'right'; c.fillText(Env.clockText(now), w - 14, 18); c.textAlign = 'left';
    c.fillStyle = '#2a2d31'; c.fillRect(10, 32, w - 20, 2);
    if (!deps.length) { c.fillStyle = '#ffb000'; c.font = '600 26px "IBM Plex Mono", monospace'; c.fillText('NO MORE TRAINS TODAY', 14, 90); }
    deps.forEach((d, i) => {
      const y = 58 + i * 38; const mins = Math.max(0, Math.round((d.t - now) / 60));
      c.fillStyle = '#ffb000'; c.font = '600 26px "IBM Plex Mono", monospace';
      c.fillText(Env.clockText(d.t).replace(' ', '').toLowerCase().padStart(7, ' '), 12, y);
      c.fillStyle = d.trip.route.startsWith('Express') ? '#ff5a3c' : d.trip.route.startsWith('Limited') ? '#ffd24a' : '#ffb000';
      c.font = '600 20px "IBM Plex Mono", monospace'; c.fillText(Sim.routeShort(d.trip), 134, y);
      c.fillStyle = '#ffb000'; c.font = '600 24px "IBM Plex Mono", monospace';
      const dest = (Track.stations[d.trip.stops[d.trip.stops.length - 1][0]] || {}).name || d.trip.head;
      c.fillText(dest.replace(' Diridon', '').slice(0, 15), 214, y);
      c.textAlign = 'right'; c.fillText(mins <= 0 ? 'NOW' : mins + ' min', w - 12, y); c.textAlign = 'left';
    });
    b.tex.needsUpdate = true;
  }

  // ---------- crowds on platforms near the camera ----------
  let people = null; const crowd = []; let crowdStation = null;
  function setupCrowd() { if (typeof Life === 'undefined' || !Life.createPeople) return; try { people = Life.createPeople(220); Env.scene.add(people.mesh); people.count = 0; } catch (e) { console.warn('people', e); people = null; } }
  function spawnCrowd(st) {
    crowd.length = 0; crowdStation = st; if (!people) return; people.mesh.position.set(st.x, 0, st.z); people.mesh.updateMatrixWorld();
    const r = U.rng(U.hashStr(st.id) + Math.floor(Env.time.sec / 900));
    const hour = Env.time.sec / 3600; const busy = (hour > 6.5 && hour < 9.5) || (hour > 16 && hour < 19.5) ? 1 : hour > 5 && hour < 23 ? 0.55 : 0.15;
    const big = ['san_francisco', 'sj_diridon', 'place_MLBR', 'palo_alto', 'mountain_view', 'redwood_city', 'hillsdale', 'sunnyvale', 'san_mateo', '22nd_street'].includes(st.id) ? 1.8 : 1;
    const n = Math.min(200, Math.round((10 + r() * 24) * busy * big));
    for (let i = 0; i < n; i++) {
      const p = st.plats[Math.floor(r() * st.plats.length)]; const s = U.lerp(p.s0 + 12, p.s1 - 12, r());
      const [li, lo] = platLat(p, s); const w = Math.abs(lo - li); const sg = Math.sign(lo - li) || 1;
      const lat = p.side === 'I' ? U.lerp(li + 1.2, lo - 1.2, r()) : li + sg * U.lerp(1.1, Math.max(1.3, w - 0.5), r());
      Track.frame(s, F); const x = F.x + F.rx * lat, z = F.z + F.rz * lat;
      const face = Math.atan2(F.dx, F.dz) + (lat > (Track.lane(s, 0) + Track.lane(s, 1)) / 2 ? Math.PI / 2 : -Math.PI / 2) + (r() - 0.5) * 1.6;
      crowd.push({ x, y: F.y + PH, z, yaw: face, mode: r() < 0.12 ? 1 : 0, phase: r() * 10, ph: r() * 6.283, p, s, lat, tx: x, tz: z, v: 0, state: 'wait', dir: p.side === 'I' ? (lat > (Track.lane(s, 0) + Track.lane(s, 1)) / 2 ? 1 : 0) : p.side === 'R' ? 1 : 0, wander: r() < 0.12 });
    }
  }
  // trains: [{ s (head), dir, len, stopped, doorsOpen, stationIdx, doorWorld: [{x,z}] }]
  function updateCrowd(dt, camPos, trains) {
    if (!people) return;
    const st = nearest(camPos, 700);
    if (st !== crowdStation) { if (st) spawnCrowd(st); else { crowd.length = 0; crowdStation = null; } }
    if (!st) { people.count = 0; return; }
    let k = 0;
    for (const c of crowd) {
      if (c.state === 'gone') continue;
      if (c.state === 'wait') {
        for (const tr of trains) { if (tr.doorsOpen && tr.stationIdx === st.idx && (tr.dir === c.dir || st.plats.length === 1) && tr.doorWorld && tr.doorWorld.length) {
          let best = null, bd = 1e9; for (const d of tr.doorWorld) { const dd = (d.x - c.x) ** 2 + (d.z - c.z) ** 2; if (dd < bd) { bd = dd; best = d; } }
          if (best && bd < 60 * 60) { c.state = 'board'; c.tx = best.x; c.tz = best.z; c.mode = 1; break; } } }
        if (c.wander && c.state === 'wait') { c.phase += dt; if (Math.hypot(c.tx - c.x, c.tz - c.z) < 0.3) { const s2 = U.clamp(c.s + (Math.random() - 0.5) * 30, c.p.s0 + 8, c.p.s1 - 8); Track.frame(s2, F); c.s = s2; c.tx = F.x + F.rx * c.lat; c.tz = F.z + F.rz * c.lat; } }
      }
      if (c.state === 'board' || c.wander) {
        const dx = c.tx - c.x, dz = c.tz - c.z, d = Math.hypot(dx, dz);
        if (d > 0.25) { const sp = Math.min(d, 1.35 * dt); c.x += dx / d * sp; c.z += dz / d * sp; c.yaw = Math.atan2(dx, dz); c.mode = 1; }
        else if (c.state === 'board') { c.state = 'gone'; continue; }
        else c.mode = 0;
      }
      people.set(k++, c.x - st.x, c.y, c.z - st.z, Math.atan2(-Math.cos(c.yaw), Math.sin(c.yaw)), c.mode, c.ph, c.mode === 1 ? 1.35 : undefined);
    }
    people.count = k; people.update && people.update(dt);
  }

  function nearest(pos, maxD) { let best = null, bd = maxD; for (const st of list) { const d = Math.hypot(st.x - pos.x, st.z - pos.z); if (d < bd) { bd = d; best = st; } } return best; }

  function init() {
    mats(); Env.scene.add(group);
    for (const st of Track.stations) {
      const o = st; layout(o); Track.frame(o.s, F); o.x = F.x; o.z = F.z; o.y = F.y; list.push(o);
    }
    // geometry waits for the fine terrain around each station (layout/stop marks above are available immediately)
    for (const st of list) {
      const r = Math.max(260, (st.sMax - st.sMin) / 2 + 120);
      Terrain.ensure(st.x - r, st.z - r, st.x + r, st.z + r, 1).then(() => { try { buildStation(st); } catch (e) { console.error('station', st.id, e); } });
    }
    setupCrowd();
  }
  let boardT = 0;
  function update(dt, camPos, trains) {
    const night = U.uNight.value;
    for (const st of list) {
      if (!st.obj) continue;
      const d = Math.hypot(st.x - camPos.x, st.z - camPos.z) - Math.max(0, camPos.y - st.y) * 0.3;
      st.obj.visible = d < 5000 || camPos.y - st.y > 1500 && d < 12000;
      if (!st.obj.visible) continue;
      if (st.signMat) st.signMat.emissiveIntensity = 0.25 * night;
    }
    M.lampOn.emissiveIntensity = 0.1 + 2.4 * night; M.pool.opacity = 0.32 * night;
    boardT -= dt;
    if (boardT <= 0) { boardT = 2; const now = Env.time.sec; for (const st of list) { if (!st.obj || !st.obj.visible) continue; if (Math.hypot(st.x - camPos.x, st.z - camPos.z) > 900) continue; for (const b of st.boards) drawBoard(b, st, now); } }
    updateCrowd(dt, camPos, trains);
  }
  // world position on a platform for spawning the player: station st, direction dir
  function spawnPoint(st, dir, out = {}) {
    const p = st.platFor[dir]; const s = U.clamp(st.s, p.s0 + 20, p.s1 - 20); Track.frame(s, F); const [li, lo] = platLat(p, s);
    const lat = p.side === 'I' ? (li + lo) / 2 + (dir ? -1 : 1) * Math.max(0, Math.abs(lo - li) / 2 - 1.6) : li + Math.sign(lo - li) * 1.6;
    out.x = F.x + F.rx * lat; out.z = F.z + F.rz * lat; out.y = F.y + PH; out.yaw = Math.atan2(F.dx, F.dz) + (lat > (Track.lane(s, 0) + Track.lane(s, 1)) / 2 ? Math.PI / 2 : -Math.PI / 2); out.s = s; return out;
  }
  // walkable platform height at world (x,z), or null
  function platformY(x, z, near) {
    const st = near || nearest({ x, z }, 700); if (!st) return null;
    const r = Track.nearest(x, z, 60); if (!r) return null;
    for (const p of st.plats) {
      if (r.s < p.s0 - 0.5 || r.s > p.s1 + 0.5) continue; const [li, lo] = platLat(p, r.s); const a = Math.min(li, lo), b = Math.max(li, lo);
      if (r.lat >= a - 0.05 && r.lat <= b + 0.05) return Track.yAt(r.s) + PH;
    }
    return null;
  }
  return { init, update, list, nearest, spawnPoint, platformY, platLat, PH, group, get people() { return people; } };
})();
