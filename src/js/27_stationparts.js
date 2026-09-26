// StationParts: the furniture and circulation of Bayline Metro stations, built into StationKit geometry buffers.
// Conventions: every part is emitted in the buffer's CURRENT transform (use gb.push().at(x, y, z, yaw) ... gb.pop()),
// in a local frame with +X along the run / platform, +Z to the right, +Y up. Dimensions follow the BART Facilities
// Standards where they give one (stairs 6 3/4 in risers x 12 in treads, handrails 2'10", escalators 48 in at 30°,
// TVMs 3'4" x 2'10 5/8" x 6'6", fare gate accessible aisle 3'6", ceilings >= 10 ft).
// B (the bucket set) = { sk: GB (station surfaces), metal: GB, glass: GB, glow: GB, dark: GB } chosen by the caller.
const StationParts = (() => {
  const { K, lin } = StationKit;
  const RISER = 0.1715, TREAD = 0.305, RAIL_H = 0.864;
  const C = {
    steel: lin(0xb7bcc0), steelDark: lin(0x5d6166), black: lin(0x141516), rubber: lin(0x1b1b1c), glassFrame: lin(0x9aa0a5),
    conc: lin(0xb3aea4), concDark: lin(0x8f8a82), tread: lin(0xa29d93), granite: lin(0x8b8986), navy: lin(0x16324f), teal: lin(0x1f9bb5),
    white: lin(0xf2f1ec), warm: lin(0xfff1d6), cool: lin(0xeaf2ff), yellow: lin(0xd7a915), paint: lin(0x2d3238), wood: lin(0x9a6a3e),
  };

  // ------------------------------------------------------------------------------------------------ stairs
  // A straight flight from (0, 0, 0) (foot of the first riser, centre of the width) rising toward +X to height H.
  // opts: { W width, cheeks: 'wall'|'stringer'|'none', wallH: cheek wall height above the nosing line, rails: bool,
  //         centreRail: bool, landingTop, landingBot (m), treadCol, wallCol, wallKind, soffit: bool }
  // Returns { run, n, rise } (run = horizontal length of the treads).
  function stairs(B, H, opts = {}) {
    const g = B.sk, W = opts.W ?? 1.8, hw = W / 2;
    const n = Math.max(1, Math.round(H / RISER)), r = H / n, run = (n - 1) * TREAD;   // n risers, n-1 treads (top landing is the upper floor)
    const tc = opts.treadCol || C.tread;
    // risers and treads (the top riser meets the upper floor)
    for (let i = 0; i < n; i++) {
      const x = i * TREAD, y0 = i * r, y1 = (i + 1) * r;
      g.mat(tc, K.CONCRETE, 0).quad([x, y0, -hw], [x, y0, hw], [x, y1, hw], [x, y1, -hw], [-hw, y0, hw, y0, hw, y1, -hw, y1]);   // riser faces -X
      if (i < n - 1) g.mat(tc, K.NOSING, 0).quad([x, y1, hw], [x + TREAD, y1, hw], [x + TREAD, y1, -hw], [x, y1, -hw], [-hw, 0, -hw, TREAD, hw, TREAD, hw, 0].map((v, k) => k % 2 ? v : v));
    }
    // soffit (sloped underside) from the foot to the top edge
    if (opts.soffit !== false) g.mat(opts.wallCol || C.concDark, K.CONCRETE, 0).quad([0, -0.25, -hw], [run + TREAD, H - 0.25, -hw], [run + TREAD, H - 0.25, hw], [0, -0.25, hw], [0, -hw, run, -hw, run, hw, 0, hw]);
    // cheeks
    const cheeks = opts.cheeks || 'stringer';
    for (const s of [-1, 1]) {
      const z = s * hw;
      if (cheeks === 'wall') {
        const wh = opts.wallH ?? 1.05, t = 0.2; const zi = z, zo = z + s * t;
        g.mat(opts.wallCol || C.conc, opts.wallKind ?? K.CONCRETE, opts.wallPrm ?? 0);
        // inner face (toward the stair), outer face, sloped top following the nosing line + wh
        const x0 = -0.3, x1 = run + TREAD + 0.3, yb0 = -0.3, yb1 = H - 0.3, yt0 = wh, yt1 = H + wh;
        const faceP = (zz) => g.quad([x0, yb0, zz], [x1, yb1, zz], [x1, yt1, zz], [x0, yt0, zz], [x0, yb0, x1, yb1, x1, yt1, x0, yt0]);   // faces +Z
        const faceN = (zz) => g.quad([x1, yb1, zz], [x0, yb0, zz], [x0, yt0, zz], [x1, yt1, zz], [-x1, yb1, -x0, yb0, -x0, yt0, -x1, yt1]); // faces -Z
        if (s > 0) { faceN(zi); faceP(zo); } else { faceP(zi); faceN(zo); }
        const zA = Math.min(zi, zo), zB = Math.max(zi, zo);
        g.quad([x0, yt0, zA], [x0, yt0, zB], [x1, yt1, zB], [x1, yt1, zA], [x0, zA, x0, zB, x1, zB, x1, zA]);
      } else if (cheeks === 'stringer') {
        B.metal.mat(C.paint, K.PAINT).push();
        const t = 0.06, d = 0.32; const L = Math.hypot(run + TREAD, H), ang = Math.atan2(H, run + TREAD);
        B.metal.translate(0, -0.1, z + s * t / 2).rotZ(ang); B.metal.box(0, -d, -t / 2, L, 0.05, t / 2); B.metal.pop();
      }
    }
    // handrails: stainless tube at 0.864 m above the nosings, extended 0.3 m past the ends, on posts
    if (opts.rails !== false) {
      const railZ = [-hw + 0.06, hw - 0.06]; if (opts.centreRail || W > 2.24) railZ.push(0);
      B.metal.mat(C.steel, K.STEEL);
      for (const z of railZ) {
        const p0 = [-0.3, RAIL_H, z], p1 = [0, RAIL_H, z], p2 = [run, H + RAIL_H, z], p3 = [run + 0.3, H + RAIL_H, z];
        B.metal.rail([p0, p1, p2, p3], 0.02, 8);
        if (cheeks !== 'wall' || Math.abs(z) < 0.1) for (let k = 0; k <= Math.max(1, Math.floor(run / 1.4)); k++) {
          const x = Math.min(run, k * 1.4); const yb = (x / Math.max(run, 1e-3)) * (H - r) + r; B.metal.tube([x, yb, z], [x, yb + RAIL_H - 0.02, z], 0.018, 6);
        }
        else for (let k = 0; k <= Math.max(1, Math.floor(run / 1.4)); k++) { const x = Math.min(run, k * 1.4), yb = (x / Math.max(run, 1e-3)) * (H - r) + r; B.metal.tube([x, yb + RAIL_H - 0.02, z], [x, yb + RAIL_H - 0.02, z + (z > 0 ? 0.07 : -0.07)], 0.012, 5); }
      }
    }
    return { run: run + TREAD, n, rise: r };
  }

  // ------------------------------------------------------------------------------------------------ escalators
  // An escalator from its lower comb plate at (0, 0, 0) rising toward +X to height H (dir +1 runs up, -1 down).
  // Static parts (truss cladding, balustrades, handrails, decks, comb plates, newels) go into the buckets; the moving
  // steps are returned as an instance record { x, y, z, yaw, H, speed } for the station's EscSteps batch.
  const ESC = { W: 1.0, OW: 1.62, ANG: Math.PI / 6, LF: 1.2, RB: 1.0, RT: 1.5, SPEED: 0.508, PITCH: 0.4 };
  function escRun(H) { const a = ESC.ANG; const li = (H - (ESC.RB + ESC.RT) * (1 - Math.cos(a))) / Math.sin(a); return ESC.LF + (ESC.RB + ESC.RT) * Math.sin(a) + li * Math.cos(a) + ESC.LF; }
  function escalator(B, H, opts = {}) {
    const a = ESC.ANG, run = escRun(H), hw = ESC.OW / 2, sw = ESC.W / 2;
    const glass = opts.glass !== false;
    // the nosing line y(x): flats, arcs, incline (for the handrail and balustrade tops)
    const xa = ESC.LF, xb = xa + ESC.RB * Math.sin(a), yb = ESC.RB * (1 - Math.cos(a));
    const li = (H - (ESC.RB + ESC.RT) * (1 - Math.cos(a))) / Math.sin(a), xc = xb + li * Math.cos(a), yc = yb + li * Math.sin(a), xd = xc + ESC.RT * Math.sin(a);
    const yAt = (x) => {
      if (x <= xa) return 0; if (x <= xb) { const t = x - xa; return ESC.RB - Math.sqrt(Math.max(0, ESC.RB * ESC.RB - t * t)); }
      if (x <= xc) return yb + (x - xb) * Math.tan(a); if (x <= xd) { const t = xd - x; return H - ESC.RT + Math.sqrt(Math.max(0, ESC.RT * ESC.RT - t * t)); } return H;
    };
    const xs = []; for (let x = -0.6; x <= run + 0.6 + 1e-6; x += 0.25) xs.push(Math.min(x, run + 0.6)); if (xs[xs.length - 1] < run + 0.6) xs.push(run + 0.6);
    const yl = (x) => yAt(U.clamp(x, 0, run));
    // truss cladding: the side panels and the underside, from floor level at the bottom pit to the top landing
    const g = B.metal; g.mat(opts.cladCol || C.steel, opts.cladKind ?? K.STEEL);
    const depth = 1.05;   // truss depth below the nosing line
    for (const s of [-1, 1]) {
      const z = s * hw;
      for (let i = 0; i + 1 < xs.length; i++) {
        const x0 = xs[i], x1 = xs[i + 1]; const t0 = yl(x0) + 0.02, t1 = yl(x1) + 0.02, b0 = Math.max(yl(x0) - depth, Math.min(0, yl(x0)) - 0.1) , b1 = Math.max(yl(x1) - depth, Math.min(0, yl(x1)) - 0.1);
        if (s > 0) g.quad([x0, b0, z], [x1, b1, z], [x1, t1, z], [x0, t0, z], [x0, b0, x1, b1, x1, t1, x0, t0]);
        else g.quad([x1, b1, z], [x0, b0, z], [x0, t0, z], [x1, t1, z], [-x1, b1, -x0, b0, -x0, t0, -x1, t1]);
      }
    }
    for (let i = 0; i + 1 < xs.length; i++) {   // soffit
      const x0 = xs[i], x1 = xs[i + 1]; const b0 = yl(x0) - depth, b1 = yl(x1) - depth; if (yl(x0) < 0.3 && yl(x1) < 0.3) continue;
      g.quad([x0, b0, -hw], [x1, b1, -hw], [x1, b1, hw], [x0, b0, hw], [x0, -hw, x1, -hw, x1, hw, x0, hw]);
    }
    // decks (outside the handrails) and inner skirt panels
    for (const s of [-1, 1]) {
      for (let i = 0; i + 1 < xs.length; i++) {
        const x0 = xs[i], x1 = xs[i + 1]; const y0 = yl(x0), y1 = yl(x1);
        g.mat(C.steel, K.STEEL);
        // deck: a strip from the balustrade to the outer edge at the balustrade top? (BART: low deck at ~0.95 m)
        const dz0 = s * (sw + 0.1), dz1 = s * hw; const dy0 = y0 + 0.97, dy1 = y1 + 0.97;
        { const zA = Math.min(dz0, dz1), zB = Math.max(dz0, dz1); g.quad([x0, dy0, zA], [x0, dy0, zB], [x1, dy1, zB], [x1, dy1, zA], [x0, zA, x0, zB, x1, zB, x1, zA]); }
        // skirt panel (vertical, stainless) beside the steps, from the step line up 0.25 m
        const zk = s * (sw + 0.02);
        if (s > 0) g.quad([x1, y1 - 0.05, zk], [x0, y0 - 0.05, zk], [x0, y0 + 0.28, zk], [x1, y1 + 0.28, zk], [-x1, 0, -x0, 0, -x0, 0.33, -x1, 0.33]);
        else g.quad([x0, y0 - 0.05, zk], [x1, y1 - 0.05, zk], [x1, y1 + 0.28, zk], [x0, y0 + 0.28, zk], [x0, 0, x1, 0, x1, 0.33, x0, 0.33]);
      }
    }
    // balustrades: glass (newer) or stainless panels (1970s), between skirt top and the handrail, both sides
    const bg = glass ? B.glass : B.metal; if (!glass) bg.mat(C.steel, K.STEEL);
    for (const s of [-1, 1]) {
      const z = s * (sw + 0.06);
      for (let i = 0; i + 1 < xs.length; i++) {
        const x0 = Math.max(0.15, xs[i]), x1 = Math.min(run - 0.15, xs[i + 1]); if (x1 <= x0) continue;
        const y0 = yl(x0), y1 = yl(x1);
        const q = [[x0, y0 + 0.28, z], [x1, y1 + 0.28, z], [x1, y1 + 0.93, z], [x0, y0 + 0.93, z]];
        bg.quad(q[0], q[1], q[2], q[3], [x0, y0, x1, y1, x1, y1 + 0.65, x0, y0 + 0.65]); bg.quad(q[1], q[0], q[3], q[2], [-x1, y1, -x0, y0, -x0, y0 + 0.65, -x1, y1 + 0.65]);
      }
    }
    // handrails (black rubber) along the balustrade tops, with newel returns at both ends
    B.dark.mat(C.rubber, K.PLAIN, 0.55);
    for (const s of [-1, 1]) {
      const z = s * (sw + 0.06); const pts = [];
      for (let x = 0.0; x <= run + 1e-6; x += 0.25) pts.push([x, yl(x) + 0.96, z]);
      pts.push([run, H + 0.96, z]);
      B.dark.rail(pts, 0.045, 6);
      // newels: half-loops at the ends
      for (const [xe, ye, sg] of [[0, 0.96, -1], [run, H + 0.96, 1]]) {
        const loop = []; for (let k = 0; k <= 6; k++) { const t = k / 6 * Math.PI; loop.push([xe + sg * Math.sin(t) * 0.42, ye - 0.42 + Math.cos(t) * 0.42, z]); }
        B.dark.rail(loop, 0.045, 6);
      }
    }
    // comb plates (aluminium, with yellow-lined edges) at both landings
    g.mat(C.steelDark, K.GRATING);
    g.box(-0.45, -0.005, -sw, 0.0, 0.02, sw, 'y-'); g.box(run, H - 0.005, -sw, run + 0.45, H + 0.02, sw, 'y-');
    B.sk.mat(C.yellow, K.PLAIN, 0.5); B.sk.box(-0.02, 0.02, -sw, 0.0, 0.03, sw, 'y-'); B.sk.box(run, H + 0.02, -sw, run + 0.02, H + 0.03, sw, 'y-');
    // landing floor plates (pit covers) beyond the combs
    g.mat(C.steel, K.GRATING); g.box(-1.6, -0.004, -hw, -0.45, 0.016, hw, 'y-'); g.box(run + 0.45, H - 0.004, -hw, run + 1.6, H + 0.016, hw, 'y-');
    return { run, yAt, H, dir: opts.dir ?? 1 };
  }
  // The moving steps of every escalator of a station: one instanced draw. Each escalator contributes ceil(pathLen / pitch)
  // steps; the vertex shader places each one on the path (flat, arc, incline, arc, flat) at s = phase + speed * t, with
  // its tread level, and sinks it under the comb plates at the ends.
  function stepGeometry() {
    const g = new StationKit.GB(); const w = ESC.W / 2, d = ESC.PITCH;
    // tread (grooved aluminium) with yellow demarcation along the sides and the front, and a riser dropping behind
    g.mat(lin(0x6e7275), K.GRATING); g.quad([0, 0, w - 0.05], [d - 0.03, 0, w - 0.05], [d - 0.03, 0, -w + 0.05], [0, 0, -w + 0.05], [0, 0, d, 0, d, 1, 0, 1]);
    g.mat(C.yellow, K.PLAIN, 0.6); g.quad([d - 0.03, 0, w], [d, 0, w], [d, 0, -w], [d - 0.03, 0, -w], [0, 0, 1, 0, 1, 1, 0, 1]);
    for (const s of [-1, 1]) g.quad(s > 0 ? [0, 0, w] : [0, 0, -w + 0.05], s > 0 ? [d - 0.03, 0, w] : [d - 0.03, 0, -w + 0.05], s > 0 ? [d - 0.03, 0, w - 0.05] : [d - 0.03, 0, -w], s > 0 ? [0, 0, w - 0.05] : [0, 0, -w], [0, 0, 1, 0, 1, 1, 0, 1]);
    g.mat(lin(0x3c3f42), K.GRATING); g.quad([0, -0.235, -w], [0, -0.235, w], [0, 0, w], [0, 0, -w], [0, 0, 1, 0, 1, 1, 0, 1]);   // riser faces -X
    g.mat(lin(0x2a2c2e), K.PLAIN, 0.6); for (const s of [-1, 1]) { const z = s * w; const q = [[0, 0, z], [d, 0, z], [0, -0.235, z]]; if (s > 0) g.quad(q[0], q[2], q[2], q[1], [0, 0, 0, 0, 0, 0, 0, 0]); else g.quad(q[0], q[1], q[2], q[2], [0, 0, 0, 0, 0, 0, 0, 0]); }
    return g.build();
  }
  const ESC_VERT = /* glsl */`
    attribute vec4 aE0; attribute vec4 aE1;   // aE0 = (x, y, z, yaw) of the lower comb; aE1 = (H, speed m/s signed, phase m, loop m)
    uniform float uEscT;
    vec3 escPath(float s, float H, out float along) {
      float A = 0.5235988, sa = sin(A), ca = cos(A), LF = ${ESC.LF.toFixed(3)}, RB = ${ESC.RB.toFixed(3)}, RT = ${ESC.RT.toFixed(3)};
      float li = (H - (RB + RT) * (1.0 - ca)) / sa;
      float l1 = LF, l2 = RB * A, l3 = li, l4 = RT * A;
      along = 0.0;
      if (s < l1) return vec3(s, 0.0, 0.0);
      s -= l1; if (s < l2) { float t = s / RB; return vec3(LF + RB * sin(t), RB * (1.0 - cos(t)), 0.0); }
      s -= l2; float xb = LF + RB * sa, yb = RB * (1.0 - ca);
      if (s < l3) return vec3(xb + s * ca, yb + s * sa, 0.0);
      s -= l3; float xc = xb + li * ca, yc = yb + li * sa;
      if (s < l4) { float t = A - s / RT; return vec3(xc + RT * (sa - sin(t)), H - RT * (1.0 - cos(t)), 0.0); }
      s -= l4; float xd = xc + RT * sa; return vec3(xd + s, H, 0.0);
    }
  `;
  function escStepMaterial() {
    const m = StationKit.stationMat({ rough: 0.5, metal: 0.6 });
    const inner = m.onBeforeCompile; const uT = U.uTime;
    m.onBeforeCompile = (sh) => {
      inner(sh); sh.uniforms.uEscT = uT;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + ESC_VERT)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          float escC = cos(aE0.w), escS = sin(aE0.w); objectNormal = vec3(objectNormal.x * escC + objectNormal.z * escS, objectNormal.y, -objectNormal.x * escS + objectNormal.z * escC);`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            float H = aE1.x, loopL = aE1.w; float s = mod(aE1.z + aE1.y * uEscT, loopL);
            float al; vec3 p = escPath(s, H, al);
            vec3 q = position; q.x += p.x; q.y += p.y;
            float total = loopL; float sink = smoothstep(0.0, 0.25, s) * (1.0 - smoothstep(total - 0.25, total, s));
            q.y -= (1.0 - sink) * 0.12;
            transformed = vec3(aE0.x + q.x * escC + q.z * escS, aE0.y + q.y, aE0.z - q.x * escS + q.z * escC);
          }`);
    };
    m.customProgramCacheKey = () => 'stkit-esc-v1';
    return m;
  }
  // records: [{ x, y, z, yaw, H, dir }] (station-local lower comb, yaw of the run) -> a Mesh (or null)
  function escSteps(records) {
    if (!records.length) return null;
    const base = stepGeometry(); const geo = new THREE.InstancedBufferGeometry();
    for (const k of ['position', 'normal', 'color', 'aSurf', 'aExt']) geo.setAttribute(k, base.getAttribute(k)); geo.setIndex(base.index);
    const e0 = [], e1 = [];
    for (const r of records) {
      const a = ESC.ANG; const li = (r.H - (ESC.RB + ESC.RT) * (1 - Math.cos(a))) / Math.sin(a);
      const path = ESC.LF * 2 + (ESC.RB + ESC.RT) * a + li; const n = Math.ceil(path / ESC.PITCH); const loop = n * ESC.PITCH;
      for (let i = 0; i < n; i++) { e0.push(r.x, r.y, r.z, r.yaw); e1.push(r.H, ESC.SPEED * (r.dir || 1), i * ESC.PITCH + (r.phase || 0), loop); }
    }
    geo.setAttribute('aE0', new THREE.InstancedBufferAttribute(new Float32Array(e0), 4));
    geo.setAttribute('aE1', new THREE.InstancedBufferAttribute(new Float32Array(e1), 4));
    geo.instanceCount = e0.length / 4;
    // bounds: all escalators (for culling)
    const bb = new THREE.Box3(); for (const r of records) { bb.expandByPoint(new THREE.Vector3(r.x - 25, r.y - 2, r.z - 25)); bb.expandByPoint(new THREE.Vector3(r.x + 25, r.y + r.H + 2, r.z + 25)); }
    geo.boundingBox = bb; geo.boundingSphere = bb.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(geo, escStepMaterial()); mesh.name = 'escsteps'; mesh.receiveShadow = true;
    return mesh;
  }

  // ------------------------------------------------------------------------------------------------ elevator
  // shaft centred at (0, y0, 0), doors facing -X. kind: 'glass' (free-standing, aerial/surface) | 'wall' (doors in a wall)
  function elevator(B, H, opts = {}) {
    const w = opts.w ?? 2.4, d = opts.d ?? 2.6, kind = opts.kind || 'glass';
    const g = B.metal;
    if (kind === 'glass') {
      g.mat(C.glassFrame, K.PAINT);
      for (const [x, z] of [[-d / 2, -w / 2], [-d / 2, w / 2], [d / 2, -w / 2], [d / 2, w / 2]]) g.cbox(x, 0, z, 0.12, H + 0.6, 0.12);
      for (let y = 0; y <= H + 0.6; y += Math.max(2.5, (H + 0.6) / Math.max(1, Math.round((H + 0.6) / 3)))) { g.box(-d / 2, y, -w / 2 - 0.05, d / 2, y + 0.1, -w / 2 + 0.05); g.box(-d / 2, y, w / 2 - 0.05, d / 2, y + 0.1, w / 2 + 0.05); g.box(d / 2 - 0.05, y, -w / 2, d / 2 + 0.05, y + 0.1, w / 2); }
      g.box(-d / 2 - 0.1, H + 0.6, -w / 2 - 0.1, d / 2 + 0.1, H + 1.1, w / 2 + 0.1);   // machine head
      B.glass.quad([-d / 2, 0, w / 2], [d / 2, 0, w / 2], [d / 2, H + 0.6, w / 2], [-d / 2, H + 0.6, w / 2], [0, 0, 1, 0, 1, 1, 0, 1]);
      B.glass.quad([d / 2, 0, -w / 2], [-d / 2, 0, -w / 2], [-d / 2, H + 0.6, -w / 2], [d / 2, H + 0.6, -w / 2], [0, 0, 1, 0, 1, 1, 0, 1]);
      B.glass.quad([d / 2, 0, w / 2], [d / 2, 0, -w / 2], [d / 2, H + 0.6, -w / 2], [d / 2, H + 0.6, w / 2], [0, 0, 1, 0, 1, 1, 0, 1]);
    }
    // door portal(s) on -X at the bottom and (opts.top) at the top: stainless frame + doors
    for (const yy of opts.levels || [0, H]) {
      g.mat(C.steel, K.STEEL);
      g.box(-d / 2 - 0.06, yy, -0.62, -d / 2 + 0.02, yy + 2.25, -0.55); g.box(-d / 2 - 0.06, yy, 0.55, -d / 2 + 0.02, yy + 2.25, 0.62); g.box(-d / 2 - 0.06, yy + 2.18, -0.62, -d / 2 + 0.02, yy + 2.3, 0.62);
      g.mat(lin(0xa7acb0), K.STEEL); g.box(-d / 2 - 0.03, yy, -0.55, -d / 2 + 0.0, yy + 2.18, 0.55);
      B.dark.mat(C.black, K.PLAIN, 0.4); B.dark.box(-d / 2 - 0.045, yy + 0.02, -0.004, -d / 2 - 0.03, yy + 2.16, 0.004);
      B.glow.mat(lin(0x6fd0ff)); B.glow.box(-d / 2 - 0.07, yy + 2.36, -0.25, -d / 2 - 0.05, yy + 2.46, 0.25);    // floor indicator
    }
  }

  // ------------------------------------------------------------------------------------------------ fare gates
  // An array of n aisles across Z starting at z = 0, passage along X (paid side +X). Cabinets are 0.24 m wide,
  // aisles 0.62 m (the last one accessible: 1.07 m). Glass swing barriers ~1.6 m tall in each aisle.
  function fareGates(B, n, opts = {}) {
    const cabW = 0.24, cabL = 1.9, cabH = 1.02, aw = 0.62, acc = 1.07;
    let z = 0; const zs = [];
    for (let i = 0; i <= n; i++) {
      B.metal.mat(C.steel, K.STEEL); B.metal.box(-cabL / 2, 0, z, cabL / 2, cabH, z + cabW);
      B.dark.mat(lin(0x1e2226), K.PLAIN, 0.3); B.dark.box(-cabL / 2 + 0.05, cabH, z + 0.01, cabL / 2 - 0.05, cabH + 0.015, z + cabW - 0.01);
      if (i < n) { // reader (blue, entry side -X), direction light strip
        B.glow.mat(lin(0x3aa6ff)); B.glow.box(-cabL / 2 + 0.12, cabH + 0.015, z + cabW - 0.2, -cabL / 2 + 0.34, cabH + 0.03, z + cabW - 0.03);
        B.glow.mat(lin(0x40e080)); B.glow.box(-cabL / 2 - 0.005, cabH - 0.18, z + 0.05, -cabL / 2, cabH - 0.1, z + cabW - 0.05);
      }
      zs.push(z + cabW); z += cabW + (i < n ? (i === n - 1 && opts.accessible !== false ? acc : aw) : 0);
    }
    // swing barriers: two leaves per aisle, closed, at the middle of the cabinets
    for (let i = 0; i < n; i++) {
      const z0 = zs[i], z1 = zs[i + 1] - cabW; const mid = (z0 + z1) / 2;
      for (const [za, zb] of [[z0 + 0.01, mid - 0.01], [mid + 0.01, z1 - 0.01]]) {
        B.glass.quad([0, 0.25, za], [0, 0.25, zb], [0, 1.62, zb], [0, 1.62, za], [0, 0, 1, 0, 1, 1, 0, 1]);
        B.glass.quad([0, 0.25, zb], [0, 0.25, za], [0, 1.62, za], [0, 1.62, zb], [0, 0, 1, 0, 1, 1, 0, 1]);
      }
    }
    return { width: z };
  }
  // ticket vending machine (Clipper): wall-mounted flush front facing -X at x = 0, bottom at y = 0, centred on z
  function tvm(B, opts = {}) {
    const w = 1.02, h = 1.98, d = 0.1;
    B.metal.mat(C.steel, K.STEEL); B.metal.box(-d, 0, -w / 2, 0, h, w / 2);
    B.sk.mat(C.navy, K.PAINT); B.sk.box(-d - 0.005, h - 0.32, -w / 2 + 0.02, -d, h - 0.02, w / 2 - 0.02);
    B.glow.mat(lin(0x9fd8ff)); B.glow.box(-d - 0.012, 1.18, -0.3, -d - 0.005, 1.56, 0.22);     // screen
    B.dark.mat(C.black, K.PLAIN, 0.3); B.dark.box(-d - 0.03, 0.95, -0.34, -d, 1.08, 0.3); B.dark.box(-d - 0.02, 0.45, -0.3, -d, 0.62, 0.3);
    B.glow.mat(lin(0x3aa6ff)); B.glow.box(-d - 0.02, 1.25, 0.27, -d - 0.005, 1.42, 0.43);   // card reader
  }
  // station agent booth: w x d at the origin (front -X), glass upper walls
  function agentBooth(B, opts = {}) {
    const w = opts.w ?? 3.2, d = opts.d ?? 2.4, h = 2.7;
    B.metal.mat(C.steel, K.STEEL); B.metal.box(-d / 2, 0, -w / 2, d / 2, 1.05, w / 2);
    B.sk.mat(C.navy, K.PAINT); B.sk.box(-d / 2 - 0.05, h, -w / 2 - 0.05, d / 2 + 0.05, h + 0.45, w / 2 + 0.05);
    B.metal.mat(C.glassFrame, K.PAINT);
    for (const [x, z] of [[-d / 2, -w / 2], [-d / 2, w / 2], [d / 2, -w / 2], [d / 2, w / 2]]) B.metal.cbox(x, 1.05, z, 0.07, h - 1.05, 0.07);
    const gq = (p0, p1) => { B.glass.quad([p0[0], 1.05, p0[1]], [p1[0], 1.05, p1[1]], [p1[0], h, p1[1]], [p0[0], h, p0[1]], [0, 0, 1, 0, 1, 1, 0, 1]); B.glass.quad([p1[0], 1.05, p1[1]], [p0[0], 1.05, p0[1]], [p0[0], h, p0[1]], [p1[0], h, p1[1]], [0, 0, 1, 0, 1, 1, 0, 1]); };
    gq([-d / 2, w / 2], [-d / 2, -w / 2]); gq([-d / 2, -w / 2], [d / 2, -w / 2]); gq([d / 2, w / 2], [-d / 2, w / 2]);
    B.sk.mat(lin(0x6d665c), K.WOOD, 0.1); B.sk.box(-d / 2 - 0.25, 1.05, -w / 2 + 0.2, -d / 2 + 0.3, 1.1, w / 2 - 0.2);   // counter
    B.glow.mat(C.warm); B.glow.box(-d / 2 + 0.2, h - 0.03, -w / 2 + 0.3, d / 2 - 0.2, h, w / 2 - 0.3);
  }

  // ------------------------------------------------------------------------------------------------ furniture
  // bench along X centred at the origin, seat facing -Z (back at +Z). style: 'steel' | 'wood' | 'stone'
  function bench(B, L = 2.4, style = 'steel') {
    if (style === 'stone') { B.sk.mat(C.granite, K.GRANITE, 0.6); B.sk.box(-L / 2, 0, -0.25, L / 2, 0.46, 0.25, 'y-'); return; }
    const seat = style === 'wood' ? B.sk : B.metal;
    if (style === 'wood') seat.mat(C.wood, K.WOOD, 0.09); else seat.mat(C.steel, K.STEEL);
    seat.box(-L / 2, 0.42, -0.24, L / 2, 0.47, 0.22); seat.push().translate(0, 0.47, 0.22).rotX(0.2); seat.box(-L / 2, 0.05, -0.03, L / 2, 0.45, 0.02); seat.pop();
    B.metal.mat(C.paint, K.PAINT);
    for (const x of [-L / 2 + 0.15, L / 2 - 0.15, ...(L > 2 ? [0] : [])]) { B.metal.box(x - 0.03, 0, -0.2, x + 0.03, 0.42, 0.18, 'y-'); B.metal.box(x - 0.03, 0.47, 0.16, x + 0.03, 0.9, 0.22); }
  }
  // round waste + recycling bins, centred
  function bins(B) {
    B.metal.mat(C.steel, K.STEEL); B.metal.cyl(-0.3, 0, 0, 0.26, 0.26, 0.95, 16); B.metal.cyl(0.3, 0, 0, 0.26, 0.26, 0.95, 16);
    B.sk.mat(C.navy, K.PAINT); B.sk.cyl(-0.3, 0.95, 0, 0.27, 0.2, 0.08, 16); B.sk.mat(lin(0x2f7fb8), K.PAINT); B.sk.cyl(0.3, 0.95, 0, 0.27, 0.2, 0.08, 16);
  }
  // column: shape 'round' | 'rect' | 'oct' | 'taper'; size = diameter / width, depth for rect; from y0 to y1
  function column(B, y0, y1, shape = 'round', size = 0.7, depth, col, kind) {
    const g = B.sk; g.mat(col || C.conc, kind ?? K.CONCRETE, 0);
    if (shape === 'rect') g.cbox(0, y0, 0, size, y1 - y0, depth ?? size, 'y-');
    else if (shape === 'oct') g.cyl(0, y0, 0, size / 2 / Math.cos(Math.PI / 8), size / 2 / Math.cos(Math.PI / 8), y1 - y0, 8, false);
    else if (shape === 'taper') g.cyl(0, y0, 0, size * 0.42, size * 0.58, y1 - y0, 20, false);
    else g.cyl(0, y0, 0, size / 2, size / 2, y1 - y0, 20, false);
  }
  // linear light fixture (trough) along X, length L, emissive bottom; returns the light record in local coords
  function trough(B, L, opts = {}) {
    const w = opts.w ?? 0.22, h = opts.h ?? 0.1;
    B.metal.mat(opts.col || lin(0xd9dad8), K.PAINT); B.metal.box(-L / 2, 0, -w / 2, L / 2, h, w / 2, '');
    B.glow.mat(opts.lamp || C.warm); B.glow.box(-L / 2 + 0.02, -0.004, -w / 2 + 0.03, L / 2 - 0.02, 0.0, w / 2 - 0.03);
  }
  // CCTV dome on a short arm (ceiling-mounted at y = 0 going down)
  function cctv(B) { B.metal.mat(C.white, K.PAINT); B.metal.cyl(0, -0.25, 0, 0.03, 0.03, 0.25, 6, false); B.dark.mat(C.black, K.PLAIN, 0.1); B.dark.cyl(0, -0.36, 0, 0.09, 0.11, 0.11, 12); }
  // speaker horn
  function speaker(B) { B.metal.mat(lin(0xcfd1cf), K.PAINT); B.metal.cyl(0, -0.3, 0, 0.13, 0.06, 0.22, 10); }
  // emergency call box / white courtesy phone on a wall (front -X)
  function callBox(B) { B.sk.mat(lin(0x1d4f9c), K.PAINT); B.sk.box(-0.14, 1.1, -0.18, 0, 1.55, 0.18); B.glow.mat(lin(0x6db4ff)); B.glow.box(-0.15, 1.5, -0.05, -0.14, 1.53, 0.05); }
  function fireCabinet(B) { B.sk.mat(lin(0xb2231f), K.PAINT); B.sk.box(-0.12, 0.9, -0.4, 0, 1.8, 0.4); B.glass.quad([-0.125, 1.0, 0.3], [-0.125, 1.0, -0.3], [-0.125, 1.7, -0.3], [-0.125, 1.7, 0.3], [0, 0, 1, 0, 1, 1, 0, 1]); }
  // railing along a local polyline (x, z) at base heights: posts every ~1.2 m, top rail, mid rails or glass infill
  function railing(B, pts, h = 1.07, infill = 'bars') {
    B.metal.mat(C.steel, K.STEEL);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0, z0] = pts[i], [x1, y1, z1] = pts[i + 1]; const L = Math.hypot(x1 - x0, z1 - z0); const n = Math.max(1, Math.round(L / 1.2));
      B.metal.tube([x0, y0 + h, z0], [x1, y1 + h, z1], 0.024, 8);
      for (let k = 0; k <= n; k++) { if (k === n && i + 2 < pts.length) continue; const t = k / n; const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, z = z0 + (z1 - z0) * t; B.metal.tube([x, y, z], [x, y + h, z], 0.02, 6); }
      if (infill === 'bars') for (const f of [0.35, 0.65]) B.metal.tube([x0, y0 + h * f, z0], [x1, y1 + h * f, z1], 0.012, 6);
      else if (infill === 'glass') { B.glass.quad([x0, y0 + 0.08, z0], [x1, y1 + 0.08, z1], [x1, y1 + h - 0.06, z1], [x0, y0 + h - 0.06, z0], [0, 0, 1, 0, 1, 1, 0, 1]); B.glass.quad([x1, y1 + 0.08, z1], [x0, y0 + 0.08, z0], [x0, y0 + h - 0.06, z0], [x1, y1 + h - 0.06, z1], [0, 0, 1, 0, 1, 1, 0, 1]); }
    }
  }

  return { C, RISER, TREAD, RAIL_H, ESC, escRun, stairs, escalator, escSteps, elevator, fareGates, tvm, agentBooth, bench, bins, column, trough, cctv, speaker, callBox, fireCabinet, railing };
})();
