// Life: people, road traffic, aircraft, trees and birds for Bayline.
// Everything is instanced; animation runs in vertex shaders (walk cycles, wind sway, wing flaps),
// so hundreds of people, thousands of trees and dozens of vehicles cost a handful of draw calls.
//
// Conventions used throughout this file (see notes/life.md):
//   meters; +X east, -Z north, +Y up. yaw 0 faces +X, positive yaw turns toward -Z (north):
//   facing vector = (cos yaw, 0, -sin yaw). Local model frames: +X forward, +Y up, +Z right.
//   Shaders read U.uTime (seconds), U.uNight (0 day..1 night) and U.uWind (0..1).
//   Each set of instances lives under its own anchor (mesh/group position) so instance
//   coordinates stay small and float32 precision stays sub-millimeter anywhere in the world.
const Life = (() => {
  const TAU = Math.PI * 2, DEG = Math.PI / 180;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const V3 = THREE.Vector3;
  const _v = new V3(), _v2 = new V3(), _up = new V3(0, 1, 0), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YZX'),
    _s = new V3(), _m = new THREE.Matrix4(), _c = new THREE.Color(), _zero = new THREE.Matrix4().makeScale(0, 0, 0);

  // ------------------------------------------------------------------------------------------
  // Shared shader plumbing
  // ------------------------------------------------------------------------------------------
  const GLSL_COMMON = `
    uniform float uLifeTime;
    uniform float uLifeNight;
    uniform float uLifeWind;
    vec3 lifeUnpack(float f) {
      float r = floor(f / 65536.0); float rest = f - r * 65536.0;
      float g = floor(rest / 256.0); float b = rest - g * 256.0;
      return pow(vec3(r, g, b) / 255.0, vec3(2.2));
    }
    mat3 lifeRotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
    mat3 lifeRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
    mat3 lifeRotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
  `;
  const BEGIN_NORMAL = (call) => `
    vec3 objectNormal = vec3( normal );
    #ifdef USE_TANGENT
      vec3 objectTangent = vec3( tangent.xyz );
    #endif
    vec3 lifeP = position;
    ${call}
    #define LIFE_POSED
  `;
  const BEGIN_VERTEX = (call) => `
    #ifndef LIFE_POSED
      vec3 lifeP = position; vec3 objectNormal = vec3(0.0, 1.0, 0.0);
      ${call}
    #endif
    vec3 transformed = lifeP;
    #ifdef USE_ALPHAHASH
      vPosition = vec3( position );
    #endif
  `;
  // inj: { vHead, call (GLSL statement that edits lifeP / objectNormal), fHead, fColor, fAfter: [[chunk, code]], fEmissive }
  function lifeMaterial(key, mat, inj) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uLifeTime = U.uTime; sh.uniforms.uLifeNight = U.uNight; sh.uniforms.uLifeWind = U.uWind;
      let vs = sh.vertexShader, fs = sh.fragmentShader;
      vs = vs.replace('#include <common>', '#include <common>\n' + GLSL_COMMON + (inj.vHead || ''));
      if (vs.includes('#include <beginnormal_vertex>') && !vs.includes('#ifdef USE_DISPLACEMENTMAP\n\t\t#include <beginnormal_vertex>'))
        vs = vs.replace('#include <beginnormal_vertex>', BEGIN_NORMAL(inj.call || ''));
      vs = vs.replace('#include <begin_vertex>', BEGIN_VERTEX(inj.call || ''));
      if (inj.fHead) fs = fs.replace('#include <common>', '#include <common>\n' + inj.fHead);
      if (inj.fColor) fs = fs.replace('#include <color_fragment>', inj.fColor);
      for (const [chunk, code] of inj.fAfter || []) fs = fs.replace(chunk, chunk + '\n' + code);
      if (inj.fEmissive) fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + inj.fEmissive);
      sh.vertexShader = vs; sh.fragmentShader = fs;
    };
    mat.customProgramCacheKey = () => 'life-' + key;
    return mat;
  }
  function depthMaterial(key, inj, side) {
    const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: side || THREE.FrontSide });
    return lifeMaterial(key + '-depth', m, { vHead: inj.vHead, call: inj.call });
  }

  // ------------------------------------------------------------------------------------------
  // Geometry helpers (all parts are made non-indexed and uv-less so they merge cleanly)
  // ------------------------------------------------------------------------------------------
  function prep(geo, keepIndex) {
    const g = geo.index && !keepIndex ? geo.toNonIndexed() : geo;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    return g;
  }
  function constAttr(g, name, values) {
    const n = g.attributes.position.count, k = values.length, a = new Float32Array(n * k);
    for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) a[i * k + j] = values[j];
    g.setAttribute(name, new THREE.BufferAttribute(a, k));
    return g;
  }
  function cylY(r0, r1, y0, y1, seg, x = 0, z = 0, sx = 1, sz = 1, open = false) {
    const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, seg, 1, open);
    g.scale(sx, 1, sz); g.translate(x, (y0 + y1) / 2, z); return g;
  }
  // tapered cylinder between two points
  function seg3(a, b, r0, r1, n, open = false) {
    const d = new V3().subVectors(b, a); const len = d.length();
    const g = new THREE.CylinderGeometry(r1, r0, len, n, 1, open);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), d.normalize()));
    g.translate(a.x, a.y, a.z); return g;
  }
  const v3 = (x, y, z) => new V3(x, y, z);
  // a quad facing +X (face details: eyes, brows, mouth)
  function quadX(w, h, x, y, z) { const g = new THREE.PlaneGeometry(w, h); g.rotateY(Math.PI / 2); g.translate(x, y, z); return g; }
  function box(w, h, d, x, y, z, rz = 0, ry = 0, rx = 0) {
    const g = new THREE.BoxGeometry(w, h, d); if (rx) g.rotateX(rx); if (rz) g.rotateZ(rz); if (ry) g.rotateY(ry); g.translate(x, y, z); return g;
  }
  function sph(r, ws, hs, x, y, z, sx = 1, sy = 1, sz = 1, thetaLen = Math.PI, tiltZ = 0) {
    const g = new THREE.SphereGeometry(r, ws, hs, 0, TAU, 0, thetaLen);
    g.scale(sx, sy, sz); if (tiltZ) g.rotateZ(tiltZ); g.translate(x, y, z); return g;
  }
  function blob(r, x, y, z, sx, sy, sz, detail) { const g = new THREE.IcosahedronGeometry(r, detail); g.scale(sx, sy, sz); g.translate(x, y, z); return g; }
  // cylinder along +X from x0 (radius r0) to x1 (radius r1)
  function cylX(r0, r1, x0, x1, n, y = 0, z = 0, sy = 1, sz = 1) {
    const g = new THREE.CylinderGeometry(r1, r0, x1 - x0, n, 1, false);
    g.rotateZ(-Math.PI / 2); g.scale(1, sy, sz); g.translate((x0 + x1) / 2, y, z); return g;
  }
  // convex 8-corner slab (wings, fins, pylons): corners = [a0,a1,a2,a3 (one face), b0,b1,b2,b3 (opposite face)]
  function slab(c) {
    const center = new V3(); c.forEach(p => center.add(p)); center.multiplyScalar(1 / 8);
    const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    const pos = [];
    const ab = new V3(), ac = new V3(), nrm = new V3(), fc = new V3();
    for (const f of faces) {
      const p = f.map(i => c[i]);
      fc.set(0, 0, 0); p.forEach(q => fc.add(q)); fc.multiplyScalar(0.25);
      ab.subVectors(p[1], p[0]); ac.subVectors(p[2], p[0]); nrm.crossVectors(ab, ac);
      const flip = nrm.dot(fc.clone().sub(center)) < 0;
      const tri = flip ? [[0, 2, 1], [0, 3, 2]] : [[0, 1, 2], [0, 2, 3]];
      for (const t of tri) for (const i of t) pos.push(p[i].x, p[i].y, p[i].z);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
  }
  function extrudeXY(pts, depth, z0) {
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1])));
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: 1 });
    g.translate(0, 0, z0); return g;
  }
  const lin = hex => _c.setHex(hex).clone(); // THREE.Color converts the sRGB hex to linear working space

  const hash = (a, b) => U.hash2(a | 0, b | 0);
  function wpick(r, weights) { let s = 0; for (const w of weights) s += w; let x = r() * s; for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; } return weights.length - 1; }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];

  // ==========================================================================================
  // PEOPLE
  // ==========================================================================================
  // One InstancedMesh; every person is the same "super geometry" (all hair styles, hats, garments and
  // carried things), posed and dressed in the vertex shader from per-instance attributes. The anatomy is
  // lofted from superelliptic cross-sections (scale 1 = a 1.72 m adult, ~7.5 heads tall) with smooth
  // normals and baked crease occlusion. Eyes, brows, lips, beards, glasses, soles, socks, belts, buttons,
  // pockets, open jacket fronts and short sleeves are painted per fragment from the unposed model
  // position, so they stay crisp up close and cost no triangles.
  // Joints (model space, +X forward, +Y up, +Z right): hip (0, .9, 0), knee (0, .47, 0), ankle (0, .085, ±.093),
  // shoulder (0, 1.4, ±.195), elbow (0, 1.12, ±.205), neck (0, 1.47, 0), torso pivot (0, .95, 0).
  const PART = { PELVIS: 0, TORSO: 1, HEAD: 2, LTHIGH: 3, LSHIN: 4, RTHIGH: 5, RSHIN: 6, LUARM: 7, LFARM: 8, RUARM: 9, RFARM: 10, ROOT: 11, LFOOT: 12, RFOOT: 13 };
  const SLOT = { SKIN: 0, TOP: 1, BOTTOM: 2, SHOES: 3, HAIR: 4, ACC: 5, HAT: 6, SHIN: 7, DARK: 8, SCREEN: 9, FOREARM: 10, METAL: 11,
    WHITE: 12, THIGH: 14, OUTER: 17, SLEEVE: 18, COLLAR: 19, STRAP: 20 };

  // ---- loft helpers ----
  // superellipse ring point at angle th (0 = +X front): front / back half-depths, half-width, exponent p (2 = ellipse)
  function sep(th, rxF, rxB, rz, p) {
    const c = Math.cos(th), s = Math.sin(th), e = 2 / p;
    return [Math.sign(c) * Math.pow(Math.abs(c), e) * (c >= 0 ? rxF : rxB), Math.sign(s) * Math.pow(Math.abs(s), e) * rz];
  }
  // linear interpolation of a ring table [[y, ...params]] at y
  function tableAt(T, y) {
    if (y <= T[0][0]) return T[0].slice(1);
    for (let i = 1; i < T.length; i++) if (y <= T[i][0]) {
      const a = T[i - 1], b = T[i], t = (y - a[0]) / (b[0] - a[0]);
      return a.slice(1).map((v, k) => (v || 0) + ((b[k + 1] || 0) - (v || 0)) * t);
    }
    return T[T.length - 1].slice(1);
  }
  // indexed tube through rings of points (equal counts) with optional pole caps; turned outward by signed volume
  function loftPts(rings, capStart, capEnd) {
    const n = rings[0].length, pos = [], idx = [];
    for (const r of rings) for (const p of r) pos.push(p[0], p[1], p[2]);
    for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < n; i++) {
      const a = r * n + i, b = r * n + (i + 1) % n; idx.push(a, a + n, b, b, a + n, b + n);
    }
    if (capStart) { const ci = pos.length / 3; pos.push(capStart[0], capStart[1], capStart[2]); for (let i = 0; i < n; i++) idx.push(ci, i, (i + 1) % n); }
    if (capEnd) { const ci = pos.length / 3, b0 = (rings.length - 1) * n; pos.push(capEnd[0], capEnd[1], capEnd[2]); for (let i = 0; i < n; i++) idx.push(ci, b0 + (i + 1) % n, b0 + i); }
    let cx = 0, cy = 0, cz = 0; const nv = pos.length / 3;
    for (let i = 0; i < nv; i++) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; }
    cx /= nv; cy /= nv; cz /= nv;
    let vol = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ax = pos[a] - cx, ay = pos[a + 1] - cy, az = pos[a + 2] - cz, bx = pos[b] - cx, by = pos[b + 1] - cy, bz = pos[b + 2] - cz;
      const qx = pos[c] - cx, qy = pos[c + 1] - cy, qz = pos[c + 2] - cz;
      vol += ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
    }
    if (vol < 0) for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  // loft along +Y from a ring table [y, cx, rxF, rxB, rz, p, cz]; zc shifts the part sideways, zs signs cz; caps are pole offsets
  function loftY(T, n, capLo, capHi, zc = 0, zs = 1) {
    const rings = T.map(([y, cx, rxF, rxB, rz, p, cz]) => {
      const r = []; for (let i = 0; i < n; i++) { const [x, z] = sep(i / n * TAU, rxF, rxB, rz, p || 2); r.push([cx + x, y, zc + (cz || 0) * zs + z]); } return r;
    });
    const lo = T[0], hi = T[T.length - 1], lz = zc + (lo[6] || 0) * zs, hz = zc + (hi[6] || 0) * zs;
    return loftPts(rings, capLo ? [lo[1], lo[0] - capLo, lz] : null, capHi ? [hi[1], hi[0] + capHi, hz] : null);
  }
  // loft along +X (shoes, cap brim): rings [x, cy, ryUp, ryDown, rz, p] in the YZ plane
  function loftX(T, n, zc, capLo, capHi) {
    const rings = T.map(([x, cy, ryU, ryD, rz, p]) => {
      const r = []; for (let i = 0; i < n; i++) {
        const th = i / n * TAU, c = Math.cos(th), s = Math.sin(th), e = 2 / (p || 2);
        r.push([x, cy + Math.sign(c) * Math.pow(Math.abs(c), e) * (c >= 0 ? ryU : ryD), zc + Math.sign(s) * Math.pow(Math.abs(s), e) * rz]);
      } return r;
    });
    const a = T[0], b = T[T.length - 1];
    return loftPts(rings, capLo ? [a[0] - capLo, a[1], zc] : null, capHi ? [b[0] + capHi, b[1], zc] : null);
  }
  // round tube along a polyline (ponytail, hood roll, straps, thumbs, drawstrings)
  function tubePath(pts, radii, n) {
    const rings = [];
    for (let k = 0; k < pts.length; k++) {
      const p = new V3(...pts[k]), a = new V3(...pts[Math.max(0, k - 1)]), b = new V3(...pts[Math.min(pts.length - 1, k + 1)]);
      const t = b.sub(a).normalize(), up = Math.abs(t.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
      const s1 = new V3().crossVectors(t, up).normalize(), s2 = new V3().crossVectors(s1, t).normalize();
      const r = []; for (let i = 0; i < n; i++) { const th = i / n * TAU; const q = p.clone().addScaledVector(s1, Math.cos(th) * radii[k]).addScaledVector(s2, Math.sin(th) * radii[k]); r.push([q.x, q.y, q.z]); }
      rings.push(r);
    }
    return loftPts(rings, pts[0], pts[pts.length - 1]);
  }
  // closed cross-section profile [[r, y]] swept around +Y (x radii scaled by sx), e.g. a hat brim
  function revolve(profile, n, sx = 1, cx = 0) {
    const rings = profile.map(([r, y]) => { const q = []; for (let i = 0; i < n; i++) { const th = i / n * TAU; q.push([cx + Math.cos(th) * r * sx, y, Math.sin(th) * r]); } return q; });
    rings.push(rings[0]);
    return loftPts(rings, null, null);
  }

  // ---- anatomy (scale 1 = 1.72 m adult) ----
  const HEAD_T = [ // y, cx, rxF, rxB, rz, p  (chin .. crown; the face looks +X)
    [1.494, 0.030, 0.014, 0.012, 0.014, 2.0], [1.502, 0.027, 0.046, 0.030, 0.034, 2.0], [1.516, 0.018, 0.072, 0.047, 0.050, 2.1],
    [1.538, 0.008, 0.087, 0.064, 0.062, 2.2], [1.562, 0.002, 0.093, 0.080, 0.070, 2.3], [1.588, 0.000, 0.095, 0.092, 0.076, 2.35],
    [1.614, -0.002, 0.094, 0.099, 0.078, 2.35], [1.640, -0.004, 0.093, 0.101, 0.078, 2.3], [1.664, -0.005, 0.086, 0.097, 0.074, 2.2],
    [1.688, -0.006, 0.068, 0.081, 0.063, 2.1], [1.705, -0.006, 0.040, 0.050, 0.040, 2.0],
  ];
  const HEAD_TOP = 1.717, HEAD_C = [-0.002, 1.605, 0];
  function headPt(th, y, off = 0) {
    const [cx, rxF, rxB, rz, p] = tableAt(HEAD_T, y);
    let [x, z] = sep(th, rxF, rxB, rz, p);
    if (off === 0) { // eye sockets and the plane under the cheekbones
      const az = Math.abs(z), front = clamp((Math.cos(th) - 0.55) / 0.3, 0, 1);
      x -= front * 0.0045 * Math.exp(-(((y - 1.614) / 0.011) ** 2)) * Math.exp(-(((az - 0.033) / 0.018) ** 2));
      x -= front * 0.002 * Math.exp(-(((y - 1.578) / 0.012) ** 2)) * Math.exp(-(((az - 0.047) / 0.015) ** 2));
    }
    x += cx;
    if (off) { const dx = x - HEAD_C[0], dy = y - HEAD_C[1], dz = z - HEAD_C[2], L = Math.hypot(dx, dy, dz) || 1; return [x + dx / L * off, y + dy / L * off, z + dz / L * off]; }
    return [x, y, z];
  }
  // hair / hat shell over the skull: rings from the crown down to the boundary line(th); thickness off(th, t), t 0 crown .. 1 edge
  function skullShell(line, off, n = 16, nr = 6) {
    const rings = [];
    for (let k = 1; k <= nr; k++) {
      const t = k / nr, r = [];
      for (let i = 0; i < n; i++) { const th = i / n * TAU; r.push(headPt(th, lerp(HEAD_TOP - 0.004, line(th), Math.pow(t, 0.85)), off(th, t))); }
      rings.push(r);
    }
    return loftPts(rings, [-0.006, HEAD_TOP + off(0, 0), 0], null);
  }
  const backness = th => Math.abs(Math.atan2(Math.sin(th), Math.cos(th))) / Math.PI;   // 0 front .. 1 back
  function piece(K, a) { for (let i = 1; i < K.length; i++) if (a <= K[i][0]) { const t = (a - K[i - 1][0]) / (K[i][0] - K[i - 1][0]); return K[i - 1][1] + (K[i][1] - K[i - 1][1]) * t; } return K[K.length - 1][1]; }
  const HAIRLINE = [[0, 1.678], [0.12, 1.672], [0.24, 1.652], [0.36, 1.624], [0.44, 1.604], [0.5, 1.63], [0.62, 1.594], [0.78, 1.552], [1.0, 1.532]];
  const hairline = th => piece(HAIRLINE, backness(th));
  const TORSO_T = [ // y, cx, rxF, rxB, rz, p   (the top hangs over the waistband unless tucked in by the shader)
    [0.930, 0.000, 0.114, 0.130, 0.176, 2.2], [1.000, 0.002, 0.106, 0.116, 0.162, 2.2], [1.080, 0.006, 0.098, 0.096, 0.146, 2.25],
    [1.255, 0.013, 0.120, 0.104, 0.164, 2.5], [1.330, 0.010, 0.118, 0.104, 0.172, 2.7],
    [1.390, 0.002, 0.103, 0.098, 0.178, 3.0], [1.425, -0.006, 0.084, 0.086, 0.162, 3.2], [1.450, -0.010, 0.063, 0.068, 0.118, 2.6],
    [1.468, -0.012, 0.050, 0.054, 0.070, 2.0],
  ];
  function torsoPt(th, y, off = 0) {
    const [cx, rxF, rxB, rz, p] = tableAt(TORSO_T, y); const [x, z] = sep(th, rxF, rxB, rz, p);
    const L = Math.hypot(x, z) || 1; return [cx + x + x / L * off, y, z + z / L * off];
  }
  const PELVIS_T = [
    [0.795, -0.010, 0.030, 0.055, 0.050, 2.2], [0.840, -0.006, 0.060, 0.092, 0.120, 2.4], [0.900, -0.002, 0.088, 0.114, 0.162, 2.4],
    [0.950, 0.000, 0.100, 0.118, 0.162, 2.3], [1.012, 0.002, 0.101, 0.108, 0.154, 2.2],
  ];
  const NECK_T = [[1.430, -0.012, 0.050, 0.052, 0.053, 2.0], [1.500, -0.006, 0.046, 0.050, 0.048, 2.0], [1.560, 0.000, 0.049, 0.057, 0.051, 2.0]];
  const THIGH_T = [ // y, cx, rxF, rxB, rz, p, cz (cz: toward the midline); the knee is the bottom of the thigh
    [0.440, 0.012, 0.050, 0.046, 0.048, 2.0, 0.006], [0.490, 0.014, 0.057, 0.050, 0.054, 2.1, 0.006],
    [0.700, 0.002, 0.068, 0.072, 0.066, 2.0, 0.002], [0.820, 0.001, 0.086, 0.092, 0.079, 2.0, 0.0], [0.935, -0.002, 0.092, 0.098, 0.083, 2.0, -0.004],
  ];
  const SHIN_T = [
    [0.068, 0.000, 0.030, 0.034, 0.030, 2.0, 0.0], [0.130, 0.000, 0.032, 0.037, 0.033, 2.0, 0.0], [0.250, 0.004, 0.040, 0.055, 0.046, 2.0, 0.002],
    [0.350, 0.006, 0.046, 0.060, 0.051, 2.0, 0.003], [0.475, 0.010, 0.051, 0.048, 0.050, 2.0, 0.006],
  ];
  const SHOE_T = [ // x, cy, ryUp, ryDown, rz, p   heel .. toe (toe spring at the front)
    [-0.066, 0.046, 0.030, 0.040, 0.028, 2.2], [-0.048, 0.052, 0.044, 0.047, 0.038, 2.4], [-0.010, 0.054, 0.050, 0.049, 0.041, 2.6],
    [0.040, 0.044, 0.036, 0.040, 0.043, 2.6], [0.105, 0.033, 0.025, 0.029, 0.043, 2.6],
    [0.190, 0.029, 0.012, 0.016, 0.025, 2.0],
  ];
  const UARM_T = [ // around z = ±0.19, slanting out toward the elbow; the dome at the top is the deltoid
    [1.100, 0.000, 0.036, 0.038, 0.035, 2.0, 0.012], [1.200, 0.002, 0.042, 0.046, 0.042, 2.0, 0.008], [1.300, 0.004, 0.046, 0.048, 0.046, 2.0, 0.003],
    [1.365, 0.004, 0.045, 0.045, 0.045, 2.1, -0.002],
  ];
  const FARM_T = [ // wrist .. elbow; the wrist is wider front-to-back (palms face the thighs)
    [0.858, 0.004, 0.027, 0.027, 0.021, 2.0, 0.0], [0.960, 0.004, 0.034, 0.033, 0.028, 2.0, 0.0], [1.060, 0.002, 0.040, 0.042, 0.037, 2.0, -0.002],
    [1.135, 0.000, 0.041, 0.044, 0.040, 2.0, -0.004],
  ];
  const HAND_T = [ // fingertips .. wrist, flat across the palm
    [0.712, 0.013, 0.018, 0.016, 0.009, 2.0, -0.013], [0.752, 0.009, 0.033, 0.030, 0.013, 2.4, -0.007], [0.803, 0.006, 0.036, 0.032, 0.016, 2.5, -0.001],
    [0.865, 0.004, 0.028, 0.027, 0.019, 2.0, 0.0],
  ];

  // baked occlusion: creases (crotch, armpits, under the chin), a little darker toward the feet
  function occlusion(g, part) {
    const p = g.attributes.position, n = p.count, ao = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i); let a = 0.88 + 0.12 * sstep(0.0, 0.8, y);
      if (part !== PART.ROOT) {
        a -= 0.18 * Math.exp(-((x * x + (y - 0.79) ** 2 + z * z) / 0.0022));
        for (const sd of [-1, 1]) a -= 0.26 * Math.exp(-((x * x + (y - 1.33) ** 2 + (z - sd * 0.17) ** 2) / 0.0036));
        a -= 0.3 * Math.exp(-(((x - 0.02) ** 2 + (y - 1.49) ** 2 + z * z) / 0.0018));
        if (part === PART.LFOOT || part === PART.RFOOT) a *= 0.82 + 0.18 * sstep(0.0, 0.05, y);
      }
      ao[i] = clamp(a, 0.4, 1);
    }
    return ao;
  }

  let personGeo = null;
  function buildPersonGeometry() {
    const parts = [];
    // lod 1: small details drawn only near the camera (not beyond ~26 m, not in the shadow pass)
    const add = (g, part, slot, flag = 0, lod = 0) => {
      g = prep(g, true); const ao = occlusion(g, part), n = g.attributes.position.count, m = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { m[i * 4] = part; m[i * 4 + 1] = slot; m[i * 4 + 2] = flag; m[i * 4 + 3] = ao[i] + 2 * lod; }
      g.setAttribute('aMeta', new THREE.BufferAttribute(m, 4)); parts.push(g);
    };
    // ---- body ----
    add(loftY(PELVIS_T, 10, 0.015, 0), PART.PELVIS, SLOT.BOTTOM);
    add(loftY([[0.938, 0.0, 0.1, 0.114, 0.154, 2.2], ...TORSO_T], 12, -0.004, 0.006), PART.TORSO, SLOT.TOP);   // the hem turns inward so it meets the hips cleanly
    add(loftY(NECK_T, 10, 0, 0), PART.TORSO, SLOT.SKIN);
    { // head: skull and jaw, nose, ears
      const ys = [1.494, 1.516, 1.538, 1.562, 1.586, 1.606, 1.620, 1.640, 1.664, 1.688, 1.705];
      const rings = ys.map(y => { const r = []; for (let i = 0; i < 14; i++) r.push(headPt(i / 14 * TAU, y)); return r; });
      add(loftPts(rings, [0.03, 1.489, 0], [-0.006, HEAD_TOP, 0]), PART.HEAD, SLOT.SKIN);
      const NOSE_T = [[1.564, 0.090, 0.016, 0.012, 0.015, 2.0], [1.576, 0.089, 0.027, 0.012, 0.017, 2.0], [1.600, 0.087, 0.019, 0.009, 0.011, 2.0],
        [1.630, 0.080, 0.007, 0.004, 0.006, 2.0]];
      add(loftY(NOSE_T, 6, 0.004, 0.005), PART.HEAD, SLOT.SKIN, 0, 1);
      for (const sd of [-1, 1]) { const e = sph(1, 5, 3, 0, 0, 0, 0.016, 0.029, 0.009); e.rotateZ(0.12); e.translate(-0.008, 1.598, sd * 0.08); add(e, PART.HEAD, SLOT.SKIN, 0, 1); }
    }
    for (const sd of [-1, 1]) {
      const left = sd < 0, lz = sd * 0.093;
      const thigh = left ? PART.LTHIGH : PART.RTHIGH, shin = left ? PART.LSHIN : PART.RSHIN, foot = left ? PART.LFOOT : PART.RFOOT;
      const uarm = left ? PART.LUARM : PART.RUARM, farm = left ? PART.LFARM : PART.RFARM;
      add(loftY(THIGH_T, 10, 0.026, 0.012, lz, -sd), thigh, SLOT.THIGH);
      add(loftY(SHIN_T, 10, 0.01, 0.02, lz, -sd), shin, SLOT.SHIN);
      add(loftX(SHOE_T, 8, lz, 0.004, 0.006), foot, SLOT.SHOES);
      add(loftY(UARM_T, 8, 0.006, 0.034, sd * 0.19, sd), uarm, SLOT.SLEEVE);
      add(loftY(FARM_T, 8, 0.004, 0.018, sd * 0.208, sd), farm, SLOT.FOREARM);
      add(loftY(HAND_T, 8, 0.011, 0, sd * 0.211, sd), farm, SLOT.SKIN);
      add(tubePath([[0.022, 0.848, sd * 0.206], [0.044, 0.808, sd * 0.202], [0.054, 0.774, sd * 0.2]], [0.012, 0.0095, 0.0075], 5), farm, SLOT.SKIN, 0, 1);   // thumb
    }
    // ---- garments (group 5 = top style, group 4 = bottom) ----
    { // hoodie: the hood bunched behind the neck, drawstrings down the chest
      const path = []; for (let k = 0; k <= 8; k++) { const th = lerp(0.5, TAU - 0.5, k / 8); path.push([-0.014 + Math.cos(th) * 0.096, 1.458 + 0.014 * Math.cos(th), Math.sin(th) * 0.096]); }
      add(tubePath(path, path.map((_, k) => 0.02 + 0.016 * Math.sin(Math.PI * k / 8)), 5), PART.TORSO, SLOT.OUTER, 52);
      for (const sd of [-1, 1]) add(tubePath([1.446, 1.395, 1.335].map(y => torsoPt(sd * 0.2, y, 0.011)), [0.0032, 0.0032, 0.0032], 3), PART.TORSO, SLOT.WHITE, 52, 1);
    }
    { // shirt collar (button-downs, blazers, vests): a band standing around the neck base, open at the throat
      const n = 9, ring = (y, r, off) => { const q = []; for (let i = 0; i < n; i++) { const th = lerp(0.38, TAU - 0.38, i / (n - 1)); q.push([-0.01 + Math.cos(th) * (r + off) * 1.05, y, Math.sin(th) * (r + off)]); } return q; };
      const rings = [[1.44, 0.07], [1.466, 0.063], [1.492, 0.058]].map(([y, r]) => ring(y, r, 0.003).concat(ring(y, r, 0).reverse()));
      rings.push(ring(1.494, 0.0595, 0).concat(ring(1.494, 0.0595, 0).reverse()));
      add(loftPts(rings, null, null), PART.TORSO, SLOT.COLLAR, 53, 1);
    }
    // skirt / dress (flag 42): A-line from the waist to just above the knee; swings with the thighs in the shader
    add(loftY([[0.52, 0.012, 0.16, 0.16, 0.2, 2.0], [0.7, 0.008, 0.146, 0.152, 0.185, 2.1],
      [0.9, 0.0, 0.112, 0.13, 0.17, 2.2], [0.94, 0.0, 0.1, 0.112, 0.158, 2.2], [1.0, 0.002, 0.096, 0.104, 0.15, 2.2]], 12, 0, 0), PART.PELVIS, SLOT.BOTTOM, 42);
    // ---- hair (group 1): 1 short, 2 long, 3 bun, 4 curly, 5 ponytail; flag 16 = the cap shared by all (curly puffs it out in the shader) ----
    add(skullShell(hairline, (th, t) => 0.0022 + (0.006 + 0.007 * (1 - t) * (1 - 0.5 * backness(th))) * (1 - sstep(0.75, 1.0, t)), 14, 5), PART.HEAD, SLOT.HAIR, 16);
    { // long: a curtain around the back of the head, to the shoulders at the sides and further down the back
      const n = 7, K = 4, rings = [];
      const pts = (k, off) => { const q = []; for (let i = 0; i < n; i++) {
        const th = lerp(0.54 * Math.PI, 1.46 * Math.PI, i / (n - 1)), b = backness(th);
        const y = lerp(1.625, lerp(1.47, 1.35, sstep(0.55, 0.95, b)), k / K), kk = clamp((1.585 - y) / 0.2, 0, 1);
        const P = headPt(th, Math.max(y, 1.585), 0.013 - off);
        q.push([P[0] - 0.012 * kk, y, P[2] * (1 + 0.1 * kk)]);
      } return q; };
      for (let k = 0; k <= K; k++) rings.push(pts(k, 0).concat(pts(k, 0.013).reverse()));
      const last = pts(K, 0.0065).map(p => [p[0], p[1] - 0.004, p[2]]); rings.push(last.concat(last.slice().reverse()));
      add(loftPts(rings, null, null), PART.HEAD, SLOT.HAIR, 12);
    }
    add(sph(0.04, 7, 5, -0.078, 1.69, 0, 1.0, 0.85, 1.05), PART.HEAD, SLOT.HAIR, 13);   // bun
    add(tubePath([[-0.096, 1.648, 0], [-0.124, 1.604, 0], [-0.136, 1.54, 0], [-0.13, 1.47, 0], [-0.118, 1.43, 0]], [0.022, 0.026, 0.021, 0.013, 0.005], 6), PART.HEAD, SLOT.HAIR, 15);   // ponytail
    // ---- headwear (group 2): 1 cap, 2 beanie, 3 cycling helmet, 4 sun hat; flag 25 = the shell shared by all four (shaped per type in the shader) ----
    add(skullShell(th => lerp(1.646, 1.585, backness(th)), () => 0.016, 14, 4), PART.HEAD, SLOT.HAT, 25);
    add(loftX([[0.07, 1.656, 0.004, 0.004, 0.092, 6], [0.115, 1.648, 0.004, 0.004, 0.088, 6], [0.15, 1.64, 0.004, 0.004, 0.076, 6], [0.172, 1.632, 0.004, 0.004, 0.052, 6]], 10, 0, 0, 0.004), PART.HEAD, SLOT.HAT, 21);
    add(revolve([[0.118, 1.652], [0.2, 1.64], [0.212, 1.634], [0.2, 1.63], [0.118, 1.644]], 12, 1.14, -0.006), PART.HEAD, SLOT.HAT, 24);
    // ---- carried things (group 3): 1 backpack, 2 luggage, 3 shopping bag, 4 phone, 5 briefcase, 6 bike ----
    add(loftY([[1.02, -0.158, 0.05, 0.062, 0.128, 4], [1.08, -0.155, 0.058, 0.07, 0.138, 4], [1.26, -0.15, 0.06, 0.074, 0.142, 4], [1.38, -0.146, 0.054, 0.066, 0.13, 4]], 10, 0.018, 0.035), PART.TORSO, SLOT.ACC, 31);
    add(loftY([[1.06, -0.222, 0.012, 0.024, 0.1, 4], [1.2, -0.224, 0.012, 0.026, 0.108, 4]], 8, 0.008, 0.008), PART.TORSO, SLOT.STRAP, 31, 1);
    for (const sd of [-1, 1]) add(tubePath([[-0.1, 1.36, sd * 0.085], [-0.045, 1.474, sd * 0.098], [0.035, 1.466, sd * 0.108], [0.132, 1.33, sd * 0.1], [0.098, 1.13, sd * 0.112]], [0.011, 0.011, 0.011, 0.011, 0.011], 4), PART.TORSO, SLOT.STRAP, 31, 1);
    { const g = loftY([[0.1, 0, 0.1, 0.1, 0.16, 5], [0.62, 0, 0.1, 0.1, 0.16, 5]], 8, 0.012, 0.012); g.rotateZ(-0.35); g.translate(-0.42, 0.0, 0.3); add(g, PART.ROOT, SLOT.ACC, 32); }   // luggage
    add(seg3(v3(-0.235, 0.6, 0.3), v3(-0.03, 0.8, 0.262), 0.009, 0.009, 5), PART.ROOT, SLOT.METAL, 32);
    add(box(0.06, 0.06, 0.3, -0.37, 0.034, 0.3), PART.ROOT, SLOT.DARK, 32);
    add(loftY([[0.42, 0.0, 0.16, 0.16, 0.05, 3], [0.7, 0.0, 0.145, 0.145, 0.038, 3]], 8, 0.004, 0.002, -0.228), PART.LFARM, SLOT.ACC, 33);   // shopping bag
    for (const dx of [-0.07, 0.07]) add(tubePath([[dx, 0.7, -0.228], [dx * 0.4, 0.78, -0.222], [0.0, 0.8, -0.215]], [0.005, 0.005, 0.005], 4), PART.LFARM, SLOT.STRAP, 33, 1);
    add(box(0.009, 0.14, 0.068, 0.061, 0.775, 0.203), PART.RFARM, SLOT.DARK, 34);                 // phone
    add(box(0.003, 0.128, 0.06, 0.0665, 0.775, 0.203), PART.RFARM, SLOT.SCREEN, 34);
    add(loftY([[0.44, 0.0, 0.2, 0.2, 0.045, 6], [0.72, 0.0, 0.2, 0.2, 0.045, 6]], 8, 0.004, 0.004, -0.222), PART.LFARM, SLOT.ACC, 35);   // briefcase
    add(box(0.1, 0.03, 0.03, 0.0, 0.745, -0.217), PART.LFARM, SLOT.DARK, 35);
    { // bicycle walked on the right-hand side
      const zb = 0.52;
      for (const x of [-0.42, 0.62]) { const t = new THREE.TorusGeometry(0.33, 0.022, 3, 10); t.translate(x, 0.35, zb); add(t, PART.ROOT, SLOT.DARK, 36); }
      const bb = v3(0.08, 0.3, zb), head = v3(0.5, 0.74, zb), seat = v3(-0.06, 0.82, zb), rear = v3(-0.42, 0.35, zb), front = v3(0.62, 0.35, zb);
      for (const [a, b] of [[bb, head], [seat, v3(0.5, 0.8, zb)], [bb, seat], [bb, rear], [v3(-0.04, 0.77, zb), rear], [head, front], [head, v3(0.47, 0.97, zb)]])
        add(seg3(a, b, 0.018, 0.018, 3, true), PART.ROOT, SLOT.ACC, 36);
      add(seg3(v3(0.47, 0.97, zb - 0.22), v3(0.47, 0.97, zb + 0.22), 0.013, 0.013, 5), PART.ROOT, SLOT.METAL, 36);
      add(box(0.2, 0.04, 0.09, -0.08, 0.86, zb), PART.ROOT, SLOT.DARK, 36);
    }
    const g = U.mergeGeometries(parts);
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }

  const PEOPLE_VHEAD = `
    attribute vec4 aMeta;   // part, slot, style flag, baked occlusion
    attribute vec4 aAnim;   // walk weight, sit weight, gait phase offset, gait frequency (Hz)
    attribute vec4 aBody;   // girth, head scale, idle seed, short sleeves + 2 * beard (0-2) + 8 * glasses (0 none, 1 clear, 2 sun)
    attribute vec4 aStyle;  // hair, headwear, carry, bottom (0 trousers, 1 shorts, 2 skirt, 3 dress)
    attribute vec4 aStyle2; // top (0 tee 1 open jacket 2 hoodie 3 button-down 4 sweater 5 blazer 6 vest), outer colour, figure 0..1, socks (0 none 1 ankle 2 crew)
    attribute vec4 aCol0;   // skin, top, bottom, shoes (packed sRGB)
    attribute vec4 aCol1;   // hair, accessory, hat, tights
    varying vec3 vLifeCol;
    varying vec3 vLifeCol2;
    varying vec4 vLifeLoc;   // unposed model position, part
    varying vec4 vLifeMat;   // slot, roughness, metalness, occlusion
    varying vec4 vLifeTag;   // alternate-colour band y0..y1, top style, beard + 3 * glasses + 9 * headwear
    float lifeSq(float x) { return x * x; }
    vec3 lifeTube(vec3 q, vec3 axis, float want, inout vec3 n) {   // push a limb cross-section out to a fabric tube
      vec2 d = vec2(q.x - axis.x, q.z - axis.z); float r = length(d);
      if (r > 1e-4 && r < want) { vec2 nd = d / r; q.x = axis.x + nd.x * want; q.z = axis.z + nd.y * want; n = normalize(vec3(nd.x, n.y * 0.3, nd.y)); }
      return q;
    }
    void lifePose(inout vec3 p, inout vec3 n) {
      float part = aMeta.x, slot = aMeta.y, flag = aMeta.z;
      float topS = aStyle2.x, botS = aStyle.w, sit = aAnim.y;
      // small details (nose, ears, thumbs, straps, drawstrings, collar) only near the camera, never in the shadow pass
      float lodC = floor(aMeta.w * 0.5 + 0.01), ao = aMeta.w - 2.0 * lodC;
      if (lodC > 0.5) {
        #if defined( DEPTH_PACKING )
          bool near = false;
        #elif defined( USE_INSTANCING )
          bool near = -(modelViewMatrix * (instanceMatrix * vec4(0.0, 1.0, 0.0, 1.0))).z < 26.0;
        #else
          bool near = -(modelViewMatrix * vec4(0.0, 1.0, 0.0, 1.0)).z < 26.0;
        #endif
        if (!near) { p = vec3(0.0); return; }
      }
      // visibility first: hidden variants (and things set down when seated) collapse before any posing work
      if (flag > 9.5) {
        float grp = floor(flag / 10.0 + 0.01), val = flag - grp * 10.0;
        float want = grp < 1.5 ? aStyle.x : grp < 2.5 ? aStyle.y : grp < 3.5 ? aStyle.z : grp < 4.5 ? botS : topS;
        bool show = abs(want - val) < 0.5;
        if (abs(flag - 16.0) < 0.5 || abs(flag - 25.0) < 0.5) show = want > 0.5;                 // hair cap (all but bald), hat shell (any hat)
        else if (abs(flag - 42.0) < 0.5) show = want > 1.5;                                      // skirt, dress
        else if (abs(flag - 53.0) < 0.5) show = abs(want - 3.0) < 0.5 || want > 4.5;             // collar: button-down, blazer, vest
        if (sit > 0.5 && flag > 30.5 && flag < 36.5 && abs(flag - 34.0) > 0.5) show = false;   // bags, luggage and bikes are stowed when seated (phones stay out)
        if (!show) { p = vec3(0.0); return; }
      }
      #ifndef DEPTH_PACKING
        vLifeLoc = vec4(p, part);
      #endif
      float t = uLifeTime, walk = aAnim.x, stand = clamp(1.0 - walk - sit, 0.0, 1.0);
      float ph = t * 6.2831853 * aAnim.w + aAnim.z, sL = sin(ph);
      float seed = aBody.z, g = aBody.x, fig = aStyle2.z, carry = aStyle.z;
      float ws = stand * 0.024 * sin(t * 0.23 + seed * 40.0);   // idle: the weight shifts slowly from leg to leg
      float twist = walk * 0.1 * sL;
      bool jacket = abs(topS - 1.0) < 0.5 || abs(topS - 2.0) < 0.5 || abs(topS - 5.0) < 0.5;
      float bits = aBody.w, glasses = floor(bits / 8.0 + 0.01); bits -= glasses * 8.0;
      float beard = floor(bits / 2.0 + 0.01);
      bool shortS = bits - beard * 2.0 > 0.5 && !jacket;
      vec3 q = p;
      if (part < 1.5) {   // torso, pelvis and skirt: girth, figure (waist, hips, bust), belly, breathing
        float wy = exp(-lifeSq((q.y - 1.08) / 0.08)), hy = exp(-lifeSq((q.y - 0.9) / 0.09)), by = exp(-lifeSq((q.y - 1.265) / 0.06));
        q.x *= g * (1.0 - 0.05 * fig * wy + 0.05 * fig * hy); q.z *= g * (1.0 - 0.07 * fig * wy + 0.08 * fig * hy);
        if (part > 0.5 && slot > 0.5) {
          q.x += fig * 0.02 * by * smoothstep(-0.02, 0.06, q.x) * (1.0 - smoothstep(0.07, 0.13, abs(q.z)));
          q.x *= mix(1.0, 1.0 + 0.014 * sin(t * 1.5 + seed * 11.0) * (1.0 - 0.5 * walk), clamp(by + 0.4 * wy, 0.0, 1.0));   // breathing
          if (slot < 1.5 && abs(topS - 3.0) < 0.5 && p.y < 1.02) { q.x *= 0.84; q.z *= 0.84; }   // button-down tucked in
          if (jacket) { q.x *= 1.03; q.z *= 1.03; }                                            // outer layer
        }
        q.x += max(0.0, g - 1.0) * 0.25 * exp(-lifeSq((p.y - 1.07) / 0.09)) * smoothstep(0.0, 0.08, q.x);   // belly
        if (abs(flag - 42.0) < 0.5) {   // skirt: the front follows the leading thigh, the back the trailing one
          float hA = mix(0.42 * abs(sL) * walk, 1.5, sit), hB = mix(-0.42 * abs(sL) * walk, 1.5, sit);
          float a = smoothstep(-0.02, 0.12, q.x) * hA * 0.85 + smoothstep(0.02, -0.12, q.x) * hB * 0.6;
          vec3 hipJ = vec3(0.0, 0.9, 0.0); mat3 Rs = lifeRotZ(a); q = Rs * (q - hipJ) + hipJ; n = Rs * n;
        }
      } else if (part < 2.5) {   // head (kids have bigger heads); hair tucks under headwear
        vec3 hc = vec3(-0.004, 1.6, 0.0);
        if (abs(flag - 16.0) < 0.5) {
          if (abs(aStyle.x - 4.0) < 0.5) q += normalize(q - hc) * (0.016 + 0.006 * sin(q.x * 70.0 + 1.3) * sin(q.y * 60.0) * sin(q.z * 75.0));   // curly: a springy volume
          if (aStyle.y > 0.5) q = hc + (q - hc) * mix(vec3(1.0), vec3(0.93, 0.88, 0.93), smoothstep(1.585, 1.64, p.y));                     // tucked under headwear
        } else if (abs(flag - 25.0) < 0.5) {   // hat shell: cap and sun hat as built; a beanie sits a little looser; a helmet is thick and long at the back
          float bk = 0.5 - 0.5 * normalize((q - hc).xz + vec2(1e-4, 0.0)).x;
          if (abs(aStyle.y - 2.0) < 0.5) q += normalize(q - hc) * 0.004;
          else if (abs(aStyle.y - 3.0) < 0.5) q += normalize(q - hc) * (0.012 + 0.014 * bk) + vec3(-0.012 * bk, 0.0, 0.0);
        }
        float headPitch = carry > 3.5 && carry < 4.5 ? 0.4 : 0.05 * sit + 0.03 * stand * sin(t * 0.17 + seed * 3.0);
        float headYaw = 0.55 * sin(t * 0.37 + seed * 31.0) * smoothstep(0.25, 0.9, sin(t * 0.21 + seed * 17.0)) * (1.0 - 0.75 * walk);
        vec3 neck = vec3(0.0, 1.47, 0.0);
        q = neck + (q - neck) * aBody.y;
        mat3 Hd = lifeRotY(headYaw - twist * 0.7) * lifeRotZ(-headPitch) * lifeRotX(0.05 * stand * sin(t * 0.11 + seed * 13.0));
        q = Hd * (q - neck) + neck; n = Hd * n;
      } else if (part < 6.5 || part > 11.5) {   // legs: hip flexion swings the thigh, the knee folds in swing, the stance foot stays flat
        float sd = (part < 4.5 || abs(part - 12.0) < 0.5) ? -1.0 : 1.0;
        bool foot = part > 11.5, shin = abs(part - 4.0) < 0.5 || abs(part - 6.0) < 0.5 || foot;
        float cL = cos(ph);
        float ha = -sd * 0.42 * sL * walk;
        float ka = walk * (0.1 + 0.95 * pow(max(0.0, -sd * cL), 1.6)) + 0.04 + 5.0 * max(0.0, -sd * ws);
        #ifdef USE_INSTANCING
          float sc = length(instanceMatrix[0].xyz);
        #else
          float sc = 1.0;
        #endif
        // seated: thighs level, shins reach for the floor (the seat is 0.46 m high whatever the person's size)
        ha = mix(ha, 1.5, sit); ka = mix(ka, 1.5 - acos(clamp((0.46 / sc - 0.0754) / 0.385, 0.0, 1.0)), sit);
        float aa = -(ha - ka) - 0.4 * walk * max(0.0, ka - 0.14);
        float lz = sd * 0.093, gs = shin ? 1.0 + (g - 1.0) * 0.35 : 1.0 + (g - 1.0) * 0.8;
        if (!foot) {
          q.x *= gs; q.z = lz + (q.z - lz) * gs;
          if (botS < 0.5) q = lifeTube(q, vec3(shin ? 0.006 : 0.008, 0.0, lz), (shin ? mix(0.055, 0.058, smoothstep(0.1, 0.45, p.y)) : 0.062) * gs, n);   // trouser legs
        }
        q.z += sd * ((g - 1.0) * 0.07 + fig * 0.006);
        vec3 hipJ = vec3(0.0, 0.9, 0.0), kneeJ = vec3(0.0, 0.47, 0.0), ankJ = vec3(0.0, 0.085, 0.0);
        if (foot) { mat3 A = lifeRotZ(aa); q = A * (q - ankJ) + ankJ; n = A * n; }
        if (shin) { mat3 K = lifeRotZ(-ka); q = K * (q - kneeJ) + kneeJ; n = K * n; }
        mat3 H = lifeRotX(ws / 0.815) * lifeRotZ(ha); q = H * (q - hipJ) + hipJ; n = H * n;
      } else if (part < 10.5) {   // arms swing opposite to the legs; the forward arm bends a little more
        float sd = part < 8.5 ? -1.0 : 1.0;
        bool fore = abs(part - 8.0) < 0.5 || abs(part - 10.0) < 0.5;
        float sa = mix(sd * 0.34 * sL * walk + 0.03 * stand, 0.3, sit);
        float ea = mix(0.14 + 0.1 * fract(seed * 7.13) + 0.26 * walk + 0.14 * walk * max(0.0, sd * sL), 1.15, sit);
        float ia = 0.5 * sit, pa = mix(0.2, 0.9, sit);   // forearms turn in toward the lap; palms turn back, or down onto the lap
        if (sd > 0.0) {
          if (carry > 3.5 && carry < 4.5) { sa = mix(0.3, 0.22, sit); ea = 1.72; ia = 0.35; pa = 0.0; }             // phone
          else if (carry > 1.5 && carry < 2.5) { sa = -0.1 * (1.0 - sit); ea = 0.07 + sit; pa = mix(0.4, 0.9, sit); }  // pulling luggage
          else if (carry > 5.5) { sa = mix(0.55, 0.32, sit); ea = mix(0.42, 1.12, sit); ia = mix(-0.25, 0.45, sit); pa = 1.0; }   // bike
        } else if ((carry > 2.5 && carry < 3.5) || (carry > 4.5 && carry < 5.5)) { sa *= 0.3; ea = 0.05 + sit; pa = 0.9 * sit; }   // bag, briefcase
        float wide = (g - 1.0) * 0.17, ga = 1.0 + (g - 1.0) * 0.5, az = sd * 0.2;
        if (jacket && slot > 9.5) ga *= 1.08;   // sleeves of an outer layer
        if (fore && slot > 9.5 && !shortS) q = lifeTube(q, vec3(0.004, 0.0, sd * 0.208), 0.033, n);   // a sleeve ends in a cuff
        q.x *= ga; q.z = az + (q.z - az) * ga + sd * wide;
        vec3 shJ = vec3(0.0, 1.4, sd * (0.195 + wide)), elJ = vec3(0.0, 1.12, sd * (0.205 + wide));
        if (fore) { mat3 E = lifeRotY(sd * ia) * lifeRotZ(ea) * lifeRotY(sd * pa * 1.5708); q = E * (q - elJ) + elJ; n = E * n; }
        mat3 S = lifeRotZ(sa) * lifeRotX(-sd * (0.07 + (g - 1.0) * 0.3 - 0.05 * sit));
        q = S * (q - shJ) + shJ; n = S * n;
      }
      if (part > 0.5 && part < 10.5 && (part < 2.5 || part > 6.5)) {   // torso, head, arms: lean, twist, sway
        vec3 P0 = vec3(0.0, 0.95, 0.0);
        mat3 T = lifeRotY(twist) * lifeRotZ(0.06 * (sit - walk)) * lifeRotX(walk * 0.025 * sL + ws * 1.4);
        q = T * (q - P0) + P0; n = T * n;
      } else if (part < 0.5) { mat3 T0 = lifeRotY(-twist * 0.6) * lifeRotX(-ws * 1.2); vec3 P1 = vec3(0.0, 0.9, 0.0); q = T0 * (q - P1) + P1; n = T0 * n; }
      // the pelvis dips at each heel strike, drops onto the seat when sitting
      if (abs(part - 11.0) > 0.5) { q.y += -0.045 * walk * sL * sL + stand * 0.003 * sin(t * 1.7 + seed * 9.0) - 0.4 * sit; q.z += ws; }
      p = q;
      #ifndef DEPTH_PACKING
        // dressing: colour per slot, plus an alternate colour inside a height band (sole, socks, belt, short sleeves, shorts)
        bool skirt = botS > 1.5, shorts = abs(botS - 1.0) < 0.5;
        vec3 c = vec3(1.0), c2 = vec3(0.0); float y0 = -1.0, y1 = -1.0, rough = 0.86, metal = 0.0;
        if (slot < 0.5) { c = lifeUnpack(aCol0.x); c2 = lifeUnpack(aCol1.x); rough = 0.52; }                              // skin; brows and beard from the hair
        else if (slot < 1.5) {
          c2 = lifeUnpack(botS > 2.5 ? aCol0.z : aCol0.y);                                                              // shirt (a dress is all one colour)
          c = (jacket || abs(topS - 6.0) < 0.5) ? lifeUnpack(aStyle2.y) : c2;
          rough = abs(topS - 1.0) < 0.5 ? 0.6 : abs(topS - 5.0) < 0.5 ? 0.78 : 0.9;
        }
        else if (slot < 2.5) { c = lifeUnpack(aCol0.z); if (!skirt) { c2 = mix(lifeUnpack(aCol1.y), vec3(0.05, 0.035, 0.03), 0.7); y0 = 0.986; y1 = 1.013; } }
        else if (slot < 3.5) { c = lifeUnpack(aCol0.w); c2 = dot(c, vec3(0.33)) < 0.03 ? vec3(0.03) : vec3(0.78, 0.77, 0.74); y1 = 0.02; rough = 0.5; }
        else if (slot < 4.5) { c = lifeUnpack(aCol1.x); rough = 0.45; }
        else if (slot < 5.5) { c = lifeUnpack(aCol1.y); rough = abs(flag - 32.0) < 0.5 ? 0.32 : 0.68; }
        else if (slot < 6.5) { c = lifeUnpack(aCol1.z); rough = abs(flag - 23.0) < 0.5 ? 0.3 : 0.82; }
        else if (slot < 7.5 || (slot > 13.5 && slot < 14.5)) {   // shins and thighs: trousers, bare legs or tights
          bool bare = abs(aCol1.w - aCol0.x) < 0.5;
          c = shorts ? lifeUnpack(aCol0.x) : lifeUnpack(skirt ? aCol1.w : aCol0.z);
          rough = skirt ? (bare ? 0.52 : 0.42) : 0.88;
          if (slot > 7.5) { if (shorts) { c = lifeUnpack(aCol0.z); c2 = lifeUnpack(aCol0.x); y1 = 0.585; } }
          else { if (shorts) rough = 0.52; if (aStyle2.w > 0.5 && (shorts || (skirt && bare))) { c2 = aStyle2.w < 1.5 ? vec3(0.8, 0.79, 0.76) : vec3(0.03); y1 = aStyle2.w < 1.5 ? 0.112 : 0.2; } }
        }
        else if (slot < 8.5) { c = vec3(0.02); rough = 0.45; }
        else if (slot < 9.5) { c = vec3(0.04, 0.06, 0.09); rough = 0.15; }
        else if (slot < 10.5 || (slot > 17.5 && slot < 18.5)) {   // forearms and upper arms: sleeves or skin
          c = jacket ? lifeUnpack(aStyle2.y) : lifeUnpack(botS > 2.5 ? aCol0.z : aCol0.y);
          rough = abs(topS - 1.0) < 0.5 ? 0.6 : 0.88;
          if (shortS) { if (slot < 10.5) { c = lifeUnpack(aCol0.x); rough = 0.52; } else { c2 = lifeUnpack(aCol0.x); y1 = 1.285; } }
        }
        else if (slot < 11.5) { c = vec3(0.5, 0.52, 0.55); rough = 0.3; metal = 1.0; }
        else if (slot < 12.5) { c = vec3(0.72, 0.71, 0.68); }
        else if (slot < 17.5) { c = lifeUnpack(aStyle2.y); rough = 0.88; }
        else if (slot < 19.5) { c = lifeUnpack(botS > 2.5 ? aCol0.z : aCol0.y); }
        else { c = lifeUnpack(aCol1.y) * 0.55; rough = 0.62; }
        vLifeCol = c; vLifeCol2 = c2;
        vLifeTag = vec4(y0, y1, topS, beard + 3.0 * glasses + 9.0 * aStyle.y);
        vLifeMat = vec4(slot, rough, metal, ao);
      #endif
    }
  `;
  const PEOPLE_FHEAD = `
    uniform float uLifeNight;
    varying vec3 vLifeCol;
    varying vec3 vLifeCol2;
    varying vec4 vLifeLoc;
    varying vec4 vLifeMat;
    varying vec4 vLifeTag;
    float lifeSq(float x) { return x * x; }
    // the face, painted on the unposed head (adult scale, looking +X): beard, eyes, lids, brows, lips, glasses
    vec3 lifeFace(vec3 c, vec3 L, vec3 hairC, float bits) {
      float front = smoothstep(0.045, 0.075, L.x), az = abs(L.z);
      bits -= 9.0 * floor(bits / 9.0 + 0.01);
      float glasses = floor(bits / 3.0 + 0.01), beard = bits - glasses * 3.0;
      if (beard > 0.5) {
        float zone = smoothstep(1.585, 1.568, L.y) * smoothstep(-0.045, -0.012, L.x) * (1.0 - (1.0 - smoothstep(0.02, 0.032, az)) * smoothstep(1.553, 1.563, L.y));
        zone *= 1.0 - (1.0 - smoothstep(0.016, 0.024, az)) * (1.0 - smoothstep(0.003, 0.007, abs(L.y - 1.543)));   // not over the lips
        c = mix(c, hairC * 0.9, zone * (beard > 1.5 ? 0.88 : 0.32));
      }
      if (front > 0.0 && L.y > 1.53 && L.y < 1.65) {
        vec2 e = vec2((az - 0.032) / 0.0132, (L.y - 1.6145) / 0.0056);
        vec2 ir = vec2((az - 0.0315) / 0.0058, (L.y - 1.6146) / 0.0058);
        float eye = 1.0 - smoothstep(0.6, 1.0, dot(e, e)), iris = 1.0 - smoothstep(0.5, 1.0, dot(ir, ir));
        c = mix(c, mix(vec3(0.42, 0.4, 0.38), vec3(0.035, 0.022, 0.015), iris), eye * front);
        float lid = (1.0 - smoothstep(0.0012, 0.0026, abs(L.y - 1.6192))) * (1.0 - smoothstep(0.85, 1.2, abs(e.x)));
        float brow = (1.0 - smoothstep(0.0022, 0.004, abs(L.y - 1.639 - 0.0035 * (1.0 - lifeSq((az - 0.035) / 0.02))))) * (1.0 - smoothstep(0.016, 0.022, abs(az - 0.035)));
        float mouth = (1.0 - smoothstep(0.0, 0.0012, abs(L.y - 1.543))) * (1.0 - smoothstep(0.019, 0.025, az));
        float lips = 1.0 - smoothstep(0.5, 1.0, lifeSq(az / 0.024) + lifeSq((L.y - 1.5432) / 0.0082));
        c *= mix(vec3(1.0), vec3(0.87, 0.69, 0.66), lips * front);
        c = mix(c, c * 0.3, max(lid, mouth * 0.8) * front);
        c = mix(c, hairC * 0.85, brow * front * 0.85);
        if (glasses > 0.5) {
          vec2 gq = abs(vec2((az - 0.032) / 0.025, (L.y - 1.6135) / 0.0175));
          float d = max(gq.x, gq.y) * 0.75 + 0.25 * length(gq);
          if (glasses > 1.5) c = mix(c, vec3(0.012, 0.014, 0.018), (1.0 - smoothstep(0.92, 1.0, d)) * front);   // sunglasses
          float rim = max(1.0 - smoothstep(0.07, 0.14, abs(d - 1.0)), (1.0 - smoothstep(0.0015, 0.0028, abs(L.y - 1.6195))) * step(az, 0.009));
          c = mix(c, vec3(0.02), rim * front);
        }
      }
      if (glasses > 0.5) c = mix(c, vec3(0.02), (1.0 - smoothstep(0.0012, 0.0024, abs(L.y - 1.622))) * step(0.06, az) * step(-0.004, L.x) * step(L.x, 0.07));   // temple arms
      return c;
    }
  `;
  const PEOPLE_FCOLOR = `
    vec3 lc = vLifeCol;
    vec3 L = vLifeLoc.xyz; float lpart = vLifeLoc.w, lslot = vLifeMat.x;
    float bw = fwidth(L.y);   // model metres per pixel: details are painted only where they can resolve
    lc = mix(lc, vLifeCol2, smoothstep(vLifeTag.x - bw, vLifeTag.x + bw, L.y) * (1.0 - smoothstep(vLifeTag.y - bw, vLifeTag.y + bw, L.y)));
    float ts = vLifeTag.z;
    if (lslot > 0.5 && lslot < 1.5 && L.x > 0.0 && (abs(ts - 1.0) < 0.5 || ts > 4.5)) {   // open jacket / blazer / vest fronts show the shirt
      float hw = abs(ts - 1.0) < 0.5 ? mix(0.03, 0.055, smoothstep(1.0, 1.42, L.y)) : (L.y > 1.07 ? mix(0.003, 0.068, smoothstep(1.07, 1.43, L.y)) : (1.07 - L.y) * 0.35);
      float d = abs(L.z) - hw, m = 1.0 - smoothstep(-0.0012, 0.0012, d);
      lc = mix(lc, vLifeCol2 * (1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.012, -d))), m);   // the shirt, shadowed under the edge
      lc *= 1.0 - 0.28 * (1.0 - smoothstep(0.0, 0.0045, abs(d))) * (1.0 - m);           // lapel lip
      if (ts > 4.5) lc = mix(lc, vec3(0.03), 1.0 - smoothstep(0.004, 0.0055, length(vec2(L.z, L.y - 1.06))));   // blazer button
      if (bw < 0.006 && abs(ts - 1.0) > 0.5 && d < 0.0 && L.x > 0.05) {                   // shirt placket and buttons under a blazer or vest
        lc = mix(lc, lc * 0.84, (1.0 - smoothstep(0.0025, 0.004, abs(L.z))) * 0.6);
        lc = mix(lc, vec3(0.8, 0.78, 0.74), 1.0 - smoothstep(0.0026, 0.004, length(vec2(L.z, mod(L.y + 0.02, 0.09) - 0.045))));
      }
    } else if (bw < 0.01) {
      if (lslot < 0.5) {
        if (lpart > 1.5 && lpart < 2.5) lc = lifeFace(lc, L, vLifeCol2, vLifeTag.w);
        else if ((abs(lpart - 8.0) < 0.5 || abs(lpart - 10.0) < 0.5) && L.y < 0.785) {   // fingers
          float fx = fract((L.x + 0.012) / 0.02);
          lc *= 1.0 - 0.28 * (1.0 - smoothstep(0.0, 0.14, min(fx, 1.0 - fx))) * step(-0.026, L.x) * step(L.x, 0.036) * smoothstep(0.785, 0.77, L.y);
        }
      } else if (lslot > 3.5 && lslot < 4.5) {   // hair: strands flowing from the crown
        float a = L.z / (abs(L.x + 0.004) + abs(L.z) + 1e-4) * 110.0 + sin(L.y * 60.0) * 1.5;
        lc *= 1.0 + 0.12 * sin(a) * (1.0 - smoothstep(0.6, 1.4, fwidth(a)));
      } else if (lslot > 5.5 && lslot < 6.5) {   // headwear: knit ribs and a folded cuff on a beanie, vents on a helmet
        float hat = floor(vLifeTag.w / 9.0 + 0.01);
        if (abs(hat - 2.0) < 0.5) { lc *= 0.93 + 0.07 * sin((L.z + 0.3 * L.x) * 380.0); lc *= L.y < 1.62 - 0.03 * smoothstep(0.05, -0.08, L.x) ? 0.86 : 1.0; }
        else if (abs(hat - 3.0) < 0.5 && L.y > 1.64) lc = mix(lc, vec3(0.02), (1.0 - smoothstep(0.35, 0.55, abs(sin(L.z * 55.0)))) * smoothstep(-0.07, -0.02, L.x) * (1.0 - smoothstep(0.04, 0.07, L.x)));
      } else if (lslot > 0.5 && lslot < 1.5) {   // tops: button-down placket, hoodie pocket, ribbed necklines and hems
        if (abs(ts - 3.0) < 0.5 && L.x > 0.05 && L.y > 0.99 && bw < 0.006) {
          lc = mix(lc, lc * 0.84, (1.0 - smoothstep(0.0025, 0.004, abs(L.z))) * 0.6);
          lc = mix(lc, vec3(0.8, 0.78, 0.74), 1.0 - smoothstep(0.0026, 0.004, length(vec2(L.z, mod(L.y + 0.02, 0.09) - 0.045))));
        }
        if (abs(ts - 2.0) < 0.5 && L.x > 0.04) {
          float e = max(abs(L.z) - (0.095 - (L.y - 0.975) * 0.25), max(0.975 - L.y, L.y - 1.13));
          lc *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.003, abs(e)));
        }
        if ((ts < 0.5 || abs(ts - 4.0) < 0.5 || abs(ts - 2.0) < 0.5) && L.y > 1.452) lc *= 0.86;
        if (abs(ts - 4.0) < 0.5 && L.y < 1.0) lc *= 0.9 + 0.1 * step(0.5, fract((L.z + L.x) * 70.0));
      } else if (lslot > 1.5 && lslot < 2.5 && L.x < -0.04 && vLifeTag.y > 0.0) {   // back pockets on trousers and shorts
        float e = max(max(0.035 - abs(L.z), abs(L.z) - 0.115), max(0.875 - L.y, L.y - 0.955));
        lc *= 1.0 - 0.14 * (1.0 - smoothstep(0.0, 0.0025, abs(e)));
      }
    }
    diffuseColor.rgb *= lc * mix(1.0, vLifeMat.w, 0.45);
  `;
  const PEOPLE_INJ = { vHead: PEOPLE_VHEAD, call: 'lifePose(lifeP, objectNormal);', fHead: PEOPLE_FHEAD, fColor: PEOPLE_FCOLOR,
    fEmissive: 'if (abs(vLifeMat.x - 9.0) < 0.5) totalEmissiveRadiance += vec3(0.45, 0.62, 1.0) * (0.2 + 1.6 * uLifeNight);',
    fAfter: [['#include <roughnessmap_fragment>', 'roughnessFactor = vLifeMat.y;'], ['#include <metalnessmap_fragment>', 'metalnessFactor = vLifeMat.z;'],
      ['#include <aomap_fragment>', 'reflectedLight.indirectDiffuse *= vLifeMat.w; reflectedLight.indirectSpecular *= vLifeMat.w;']] };
  let peopleMat = null, peopleDepth = null;

  // Appearance palettes (sRGB hex): what people actually wear on the Peninsula, muted, with a few accents.
  const SKINS = [0xf1d2bd, 0xe8c1a4, 0xdcae8f, 0xcb9b78, 0xb98761, 0xa0704d, 0x8a5c3d, 0x6e4631, 0x563524, 0x3f271b];
  const HAIRS = [0x16110e, 0x1f1712, 0x2b1f17, 0x3b2a1e, 0x4d3524, 0x654630, 0x8a6a45, 0xb38f5e, 0xcfb487, 0x2a2624];
  const GREYS = [0x8e8a84, 0xafaaa3, 0xd3cec5, 0x6f6b66, 0xe4e0d8];
  const SHIRTS = {
    tee: [0xefede7, 0x1c1d20, 0x9a9da2, 0x243049, 0x4d5a3a, 0x6e2a33, 0xd8cdb8, 0x3a3d42, 0x2f4a3a, 0xb58b3c, 0x7da0c2, 0xc98f86, 0x8c3a26],
    shirt: [0xf4f2ec, 0xcfdcea, 0xe9e4d8, 0xb9c8da, 0x9aa7b8, 0xe6d7d7, 0xdfe8dd, 0x5f7896],
    sweater: [0x3b3f45, 0x6c5a47, 0x2a3348, 0x8d8a82, 0xcfc4ad, 0x5a2d2d, 0x3f4d3a, 0xa38a6a],
  };
  const OUTERS = [0x1b1c1e, 0x1f2a40, 0x4f5638, 0xa8895c, 0x7e8084, 0x333538, 0xa37d52, 0x4d6a8c, 0x2c3f33, 0x55222a, 0xd9d2c3, 0x2b2e33, 0x6b6f55];
  const BOTTOMS = [0x28354d, 0x2f4260, 0x3e5577, 0x6a84a6, 0x1a1b1e, 0x35373b, 0xa89272, 0x5a5c42, 0x252f45, 0x5e6166, 0xd6ccb8, 0x6b5a45];
  const SKIRTS = [0x1a1b1e, 0x1f2433, 0x5b2330, 0x3f4d3a, 0xa7855a, 0xc79a9a, 0x2f3d58, 0x6a5a7a, 0xe3dccd];
  const SHOES = [0xeceae6, 0x19191b, 0x5a3a24, 0x8b8f96, 0x2b3548, 0xa27c56, 0xd9d5cc, 0x3a3a3c, 0x7a2a2a];
  const ACCS = [0x1d1f22, 0x2b3a55, 0x4a4f55, 0x6b2a26, 0x3e4d34, 0x6b5238, 0x1f5d64, 0xa0a4a8, 0xb86a2c, 0x2a2a2d, 0xc9b99a];
  const HATS = [0x1d2b44, 0x6b1f1f, 0x2d2d2d, 0xc9b27c, 0x3b5b3b, 0xe0ddd5, 0x8c1515, 0xd8c7a0, 0x4a4f55];
  const BRIGHT = [0xf2c84b, 0x3fb3b0, 0xe8735a, 0xf6f6f2, 0x7fb4e0, 0xd4467a, 0x8bc34a, 0xf07a1d, 0x2b7de9, 0xe23b3b];
  const KINDS = ['commuter', 'office', 'student', 'tourist', 'cyclist', 'kid', 'senior'];
  const KIND_W = [30, 18, 16, 12, 8, 8, 8];
  const CARRY_W = {  // none, backpack, luggage, shopping bag, phone, briefcase, bike
    commuter: [14, 44, 0, 8, 28, 6, 0], office: [14, 22, 0, 8, 30, 26, 0], student: [8, 68, 0, 2, 22, 0, 0],
    tourist: [8, 30, 45, 5, 10, 2, 0], cyclist: [4, 14, 0, 0, 2, 0, 80], kid: [55, 40, 0, 0, 5, 0, 0], senior: [55, 5, 5, 30, 5, 0, 0] };
  const TOP_W = {    // tee, open jacket, hoodie, button-down, sweater, blazer, vest
    commuter: [22, 30, 16, 10, 14, 2, 6], office: [4, 12, 2, 36, 14, 18, 14], student: [30, 12, 40, 3, 12, 0, 3],
    tourist: [52, 24, 14, 5, 5, 0, 0], cyclist: [62, 30, 8, 0, 0, 0, 0], kid: [55, 15, 25, 0, 5, 0, 0], senior: [10, 32, 3, 20, 30, 4, 1] };

  function makeLook(seed, kind) {
    const r = U.rng(seed);
    if (!kind || !CARRY_W[kind]) kind = KINDS[wpick(r, KIND_W)];
    const kid = kind === 'kid', senior = kind === 'senior', fem = r() < 0.5;
    // hair: 0 bald/buzz, 1 short, 2 long, 3 bun, 4 curly, 5 ponytail
    let hair = fem ? wpick(r, [1, 14, 38, 12, 11, 24]) : wpick(r, senior ? [26, 62, 1, 6, 3, 2] : kid ? [2, 66, 6, 4, 14, 8] : [9, 64, 4, 3, 14, 6]);
    const hr = r(); let hat = 0;
    if (kind === 'cyclist') hat = hr < 0.75 ? 3 : 0;
    else if (kind === 'tourist') hat = hr < 0.25 ? 1 : hr < 0.4 ? 4 : 0;
    else if (senior) hat = hr < 0.14 ? 4 : hr < 0.22 ? 1 : 0;
    else hat = hr < 0.08 ? 1 : hr < 0.14 ? 2 : 0;
    if (hat && hair === 4) hair = 1;
    if (hat && hair === 3) hair = 5;
    const carry = wpick(r, CARRY_W[kind]);
    const topStyle = wpick(r, TOP_W[kind]);
    let bottom = fem ? wpick(r, kind === 'tourist' ? [40, 34, 14, 12] : kid ? [45, 25, 20, 10] : senior ? [62, 4, 20, 14] : [54, 8, 22, 16])
      : wpick(r, kind === 'tourist' || kind === 'cyclist' ? [45, 55, 0, 0] : kid ? [55, 45, 0, 0] : [86, 14, 0, 0]);
    if (bottom === 3 && (topStyle === 2 || topStyle === 3)) bottom = 2;
    const hairCol = senior ? pick(r, GREYS) : (r() < 0.04 ? pick(r, [0x7a2a4a, 0x3a5a8a, 0xb8563a]) : pick(r, HAIRS));
    const skin = pick(r, SKINS), tights = bottom >= 2 && r() < 0.45 ? pick(r, [0x1c1c20, 0x262833, 0x4a3d3a]) : skin;
    const bright = kind === 'tourist' || kind === 'kid' || kind === 'cyclist';
    const shirtPal = topStyle === 3 || topStyle >= 5 ? SHIRTS.shirt : topStyle === 4 ? SHIRTS.sweater : SHIRTS.tee;
    const top = bright && r() < 0.5 ? pick(r, BRIGHT) : pick(r, shirtPal);
    const outer = bright && r() < 0.35 ? pick(r, BRIGHT) : pick(r, OUTERS);
    const sleeves = topStyle === 0 ? (bright ? r() < 0.8 : r() < 0.55) : (bottom === 3 && r() < 0.5);
    const socks = (bottom === 1 || (bottom >= 2 && tights === skin)) ? (r() < 0.6 ? 1 : r() < 0.5 ? 2 : 0) : 0;
    const beard = !fem && !kid && r() < (senior ? 0.3 : 0.22) ? (r() < 0.45 ? 2 : 1) : 0;
    const glasses = kid ? (r() < 0.08 ? 1 : 0) : r() < (senior ? 0.55 : 0.28) ? (r() < 0.12 ? 2 : 1) : 0;
    return {
      kind, fem,
      height: kid ? lerp(0.56, 0.78, r()) : (fem ? lerp(0.9, 1.0, (r() + r()) / 2) : lerp(0.96, 1.08, (r() + r()) / 2)),
      girth: kid ? lerp(0.86, 1.0, r()) : lerp(0.88, 1.22, r() * r() * 0.8 + r() * 0.2),
      head: kid ? lerp(1.18, 1.3, r()) : 1.0,
      sleeves: sleeves ? 1 : 0, beard, glasses,
      style: [hair, hat, carry, bottom],
      style2: [topStyle, fem && !kid ? lerp(0.6, 1.0, r()) : lerp(0.0, 0.15, r()), socks],
      skin, top, bottom: bottom >= 2 ? pick(r, SKIRTS) : pick(r, BOTTOMS),
      shoes: pick(r, SHOES), hair: hairCol, acc: pick(r, ACCS), hat: pick(r, HATS), tights, outer,
      idle: r(),
    };
  }

  function createPeople(max = 256, opts = {}) {
    if (!personGeo) personGeo = buildPersonGeometry();
    if (!peopleMat) {
      peopleMat = lifeMaterial('people2', new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.0 }), PEOPLE_INJ);
      peopleDepth = depthMaterial('people2', PEOPLE_INJ);
    }
    const geo = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'aMeta']) geo.setAttribute(k, personGeo.attributes[k]);
    geo.setIndex(personGeo.index);
    geo.boundingSphere = personGeo.boundingSphere.clone(); geo.boundingBox = personGeo.boundingBox.clone();
    const mk = (n, dyn) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n); if (dyn) a.setUsage(THREE.DynamicDrawUsage); return a; };
    const aAnim = mk(4, true), aBody = mk(4), aStyle = mk(4), aStyle2 = mk(4), aCol0 = mk(4), aCol1 = mk(4);
    geo.setAttribute('aAnim', aAnim); geo.setAttribute('aBody', aBody); geo.setAttribute('aStyle', aStyle); geo.setAttribute('aStyle2', aStyle2);
    geo.setAttribute('aCol0', aCol0); geo.setAttribute('aCol1', aCol1);
    const mesh = new THREE.InstancedMesh(geo, peopleMat, max);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.customDepthMaterial = peopleDepth;
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.count = 0; mesh.name = 'people';
    const scale = new Float32Array(max).fill(1);
    const target = new Float32Array(max * 2), cur = new Float32Array(max * 2), known = new Uint8Array(max);
    const baseSeed = (opts.seed || 1) * 7919;
    let dirty = true, animDirty = true;

    function look(i, spec = {}) {
      const L = makeLook(spec.seed !== undefined ? spec.seed : baseSeed + i * 131, spec.kind);
      Object.assign(L, spec.override || {});
      scale[i] = L.height;
      aBody.setXYZW(i, L.girth, L.head, L.idle, (L.sleeves ? 1 : 0) + 2 * (L.beard | 0) + 8 * (L.glasses | 0));
      aStyle.setXYZW(i, L.style[0], L.style[1], L.style[2], L.style[3]);
      aStyle2.setXYZW(i, L.style2[0], L.outer, L.style2[1], L.style2[2]);
      aCol0.setXYZW(i, L.skin, L.top, L.bottom, L.shoes);
      aCol1.setXYZW(i, L.hair, L.acc, L.hat, L.tights);
      aAnim.setZ(i, L.idle * TAU * 7.0);
      aAnim.setW(i, 0.95 / Math.sqrt(L.height));
      aBody.needsUpdate = aStyle.needsUpdate = aStyle2.needsUpdate = aCol0.needsUpdate = aCol1.needsUpdate = true; animDirty = true;
      return L;
    }
    for (let i = 0; i < max; i++) look(i);

    const people = {
      mesh, max,
      get count() { return mesh.count; },
      set count(n) { mesh.count = clamp(n | 0, 0, max); dirty = true; },
      // Place person i. (x,y,z) is the floor point under the hips, in mesh-local coordinates (see notes).
      // mode: 0 stand, 1 walk, 2 sit. phase: gait phase offset (radians). speed: walking speed m/s.
      set(i, x, y, z, yaw = 0, mode = 0, phase, speed) {
        if (i < 0 || i >= max) return;
        const s = scale[i];
        _q.setFromAxisAngle(_up, yaw); _s.set(s, s, s); _v.set(x, y, z);
        _m.compose(_v, _q, _s); mesh.setMatrixAt(i, _m);
        mesh.instanceMatrix.needsUpdate = true;
        const w = mode === 1 ? 1 : 0, st = mode === 2 ? 1 : 0;
        target[i * 2] = w; target[i * 2 + 1] = st;
        if (!known[i]) { cur[i * 2] = w; cur[i * 2 + 1] = st; aAnim.setX(i, w); aAnim.setY(i, st); known[i] = 1; }
        if (phase !== undefined && phase !== null) aAnim.setZ(i, phase);
        if (speed !== undefined && speed !== null) aAnim.setW(i, 0.95 * clamp(speed / 1.35, 0.3, 2.2) / Math.sqrt(s));
        if (i >= mesh.count) mesh.count = i + 1;
        dirty = true; animDirty = true;
      },
      // Seat person i given the eye position of a seated passenger (e.g. TrainKit car.seats[k]): the hips land
      // on a seat surface 0.46 m above the implied floor whatever the person's height (the cushion gives a little).
      sitAtEye(i, ex, ey, ez, yaw = 0) {
        const s = scale[i]; const fx = Math.cos(yaw), fz = -Math.sin(yaw);
        this.set(i, ex - fx * 0.066 * s, ey - 0.718 - 0.46 * s, ez - fz * 0.066 * s, yaw, 2);
      },
      // current height scale of person i (1 = 1.72 m adult)
      heightOf(i) { return scale[i]; },
      // Change the look of person i: { kind: 'commuter'|'office'|'student'|'tourist'|'cyclist'|'kid'|'senior', seed, override }
      look,
      hide(i) { mesh.setMatrixAt(i, _zero); mesh.instanceMatrix.needsUpdate = true; },
      update(dt = 1 / 60) {
        if (animDirty) {
          const k = Math.min(1, dt * 4); let moving = false;
          for (let i = 0, n = mesh.count; i < n; i++) {
            const a = cur[i * 2], b = cur[i * 2 + 1], ta = target[i * 2], tb = target[i * 2 + 1];
            if (a !== ta || b !== tb) {
              let na = a + (ta - a) * k, nb = b + (tb - b) * k;
              if (Math.abs(na - ta) < 0.01) na = ta; if (Math.abs(nb - tb) < 0.01) nb = tb;
              cur[i * 2] = na; cur[i * 2 + 1] = nb; aAnim.setX(i, na); aAnim.setY(i, nb); moving = true;
            }
          }
          aAnim.needsUpdate = true; animDirty = moving;
        }
        if (dirty && mesh.count > 0) { mesh.computeBoundingSphere(); mesh.boundingSphere.radius += 1.5; dirty = false; }
      },
    };
    return people;
  }

  // ==========================================================================================
  // TREES
  // ==========================================================================================
  // One tree part: vertex colors (with per-triangle variation and height AO), aFlex (wind weight = height / H),
  // optional vertex jitter (organic silhouettes) and soft normals (foliage shades as one fluffy volume).
  //   o: { H, jitter, seed, vary, ao, soft (0..1), crown: [cx, cy, cz, R] }
  const _ta = new V3(), _tb = new V3(), _tf = new V3(), _tp = new V3(), _tc = new V3(), _tcr = new V3();
  function tp(geo, hex, o = {}) {
    const g = prep(geo); const pos = g.attributes.position; const n = pos.count;
    if (o.jitter) {
      const sd = (o.seed || 0) * 977;
      for (let i = 0; i < n; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const kx = Math.round(x * 53), ky = Math.round(y * 53), kz = Math.round(z * 53);
        pos.setXYZ(i, x + (hash(kx * 3 + kz + sd, ky) - 0.5) * o.jitter, y + (hash(ky * 5 + kx + sd, kz) - 0.5) * o.jitter * 0.8,
          z + (hash(kz * 7 + ky + sd, kx) - 0.5) * o.jitter);
      }
      g.computeVertexNormals();
    }
    g.computeBoundingBox(); const bb = g.boundingBox; bb.getCenter(_tc);
    const y0 = bb.min.y, y1 = bb.max.y;
    if (o.crown) _tcr.set(o.crown[0], o.crown[1], o.crown[2]); else _tcr.copy(_tc);
    const R = o.crown ? o.crown[3] : Math.max(1e-3, bb.max.distanceTo(bb.min) / 2);
    if (o.soft) {
      const nrm = g.attributes.normal;
      for (let i = 0; i < n; i++) {
        _tp.fromBufferAttribute(pos, i); _tf.fromBufferAttribute(nrm, i);
        _ta.subVectors(_tp, _tc).normalize(); _tb.subVectors(_tp, _tcr).normalize();
        _tf.multiplyScalar(1 - o.soft).addScaledVector(_ta, o.soft * 0.5).addScaledVector(_tb, o.soft * 0.5).normalize();
        nrm.setXYZ(i, _tf.x, _tf.y, _tf.z);
      }
    }
    const base = lin(hex), col = new Float32Array(n * 3), flex = new Float32Array(n);
    for (let i = 0; i < n; i += 3) {
      const fv = o.vary ? 1 + (hash(i * 7 + (o.seed || 0) * 131, 17) - 0.5) * o.vary : 1;
      for (let k = 0; k < 3 && i + k < n; k++) {
        const j = i + k; _tp.fromBufferAttribute(pos, j);
        let ao = o.ao !== undefined ? lerp(o.ao, 1, clamp((_tp.y - y0) / Math.max(1e-3, y1 - y0), 0, 1)) : 1;
        if (o.crown) ao *= lerp(0.62, 1.0, clamp(_tp.distanceTo(_tcr) / R, 0, 1));   // darker deep inside the crown
        col[j * 3] = base.r * ao * fv; col[j * 3 + 1] = base.g * ao * fv; col[j * 3 + 2] = base.b * ao * fv;
        flex[j] = clamp(_tp.y / (o.H || 10), 0, 1);
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aFlex', new THREE.BufferAttribute(flex, 1));
    return g;
  }
  // a frond / leaf strip: follows a drooping curve from base in direction (angle th, elevation el)
  function frond(len, width, th, el, droop, segs, fold) {
    const pos = [];
    const pts = [];
    let px = 0, py = 0, pz = 0; const ds = len / segs;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs, e = el - droop * u * u;
      pts.push({ x: px, y: py, z: pz, w: width * sstep(0, 0.18, u) * (1 - 0.75 * u * u) + 0.02 });
      px += Math.cos(e) * Math.cos(th) * ds; pz += Math.cos(e) * -Math.sin(th) * ds; py += Math.sin(e) * ds;
    }
    const sx = Math.sin(th), sz = Math.cos(th);   // side direction (perpendicular to th in the horizontal plane)
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[i + 1];
      const aL = [a.x - sx * a.w, a.y - fold * a.w, a.z - sz * a.w], aR = [a.x + sx * a.w, a.y - fold * a.w, a.z + sz * a.w], aC = [a.x, a.y, a.z];
      const bL = [b.x - sx * b.w, b.y - fold * b.w, b.z - sz * b.w], bR = [b.x + sx * b.w, b.y - fold * b.w, b.z + sz * b.w], bC = [b.x, b.y, b.z];
      pos.push(...aL, ...aC, ...bC, ...aL, ...bC, ...bL, ...aC, ...aR, ...bR, ...aC, ...bR, ...bC);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
  }
  function fan(radius, th, el, n) { // palm fan leaf: a pleated, slightly cupped half-disc facing outward along (th, el)
    const pos = []; const cx = Math.cos(th), cz = -Math.sin(th);
    const dir = new V3(Math.cos(el) * cx, Math.sin(el), Math.cos(el) * cz);
    const side = new V3(-cz, 0, cx); const upv = new V3().crossVectors(side, dir).normalize();
    const P = a => upv.clone().multiplyScalar(Math.cos(a) * radius).addScaledVector(side, Math.sin(a) * radius).addScaledVector(dir, radius * (0.15 + 0.35 * (1 - Math.cos(a))));
    for (let i = 0; i < n; i++) {
      const a0 = -1.35 + 2.7 * i / n, a1 = -1.35 + 2.7 * (i + 1) / n;
      const p0 = P(a0), p1 = P(a1), pm = P((a0 + a1) / 2).multiplyScalar(0.9).addScaledVector(dir, -0.08 * radius);
      pos.push(0, 0, 0, p0.x, p0.y, p0.z, pm.x, pm.y, pm.z, 0, 0, 0, pm.x, pm.y, pm.z, p1.x, p1.y, p1.z);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
  }
  const mergeT = parts => U.mergeGeometries(parts);
  // foliage mass made of jittered icosphere blobs with soft normals; blobs: [x, y, z, r, sx, sy, sz, detail]
  function foliage(P, blobs, cols, H, o = {}) {
    let cx = 0, cy = 0, cz = 0; for (const b of blobs) { cx += b[0]; cy += b[1]; cz += b[2]; }
    cx /= blobs.length; cy /= blobs.length; cz /= blobs.length;
    let R = 0; for (const b of blobs) R = Math.max(R, Math.hypot(b[0] - cx, b[1] - cy, b[2] - cz) + b[3]);
    blobs.forEach(([x, y, z, r, sx = 1, sy = 1, sz = 1, det = 1], i) => P.push(tp(blob(r, x, y, z, sx, sy, sz, det), cols[i % cols.length],
      { H, jitter: o.jitter ?? r * 0.28, ao: o.ao ?? 0.62, vary: o.vary ?? 0.22, seed: (o.seed || 0) + i * 7 + 1, soft: o.soft ?? 0.8, crown: [cx, cy, cz, R] })));
  }
  const limb = (a, b, r0, r1, n = 5) => seg3(v3(...a), v3(...b), r0, r1, n);
  const TREE_BUILDERS = {
    oak() {   // coast live oak: short trunk, heavy spreading limbs, broad low dome of dark olive foliage
      const H = 9.5, bark = 0x4a3d32, leaf = [0x45542a, 0x505f2f, 0x3c4924, 0x596937], P = [], F = [];
      P.push(tp(cylY(0.55, 0.34, 0, 2.2, 8), bark, { H, ao: 0.6 }));
      for (const [x, y, z] of [[4.0, 4.4, 1.4], [-3.6, 4.8, -1.8], [1.0, 5.0, -4.0], [-1.6, 4.2, 3.8], [1.2, 6.4, 0.6]])
        P.push(tp(limb([0, 1.9, 0], [x * 0.8, y - 0.6, z * 0.8], 0.28, 0.1), bark, { H }));
      foliage(P, [[0, 6.3, 0, 3.4, 1.15, 0.7, 1.15], [3.6, 5.0, 1.4, 2.7, 1.05, 0.72, 1.05], [-3.5, 5.2, -1.7, 2.8, 1.05, 0.7, 1.05], [1.1, 5.0, -3.9, 2.6, 1.05, 0.72, 1.05],
        [-1.7, 4.6, 3.7, 2.6, 1.05, 0.72, 1.05], [3.2, 6.7, -2.0, 2.1, 1, 0.78, 1, 0], [-2.9, 6.9, 1.8, 2.2, 1, 0.78, 1, 0], [5.2, 4.2, -1.3, 1.8, 1, 0.75, 1, 0],
        [-5.0, 4.3, 1.1, 1.8, 1, 0.75, 1, 0], [0.4, 7.7, 0.2, 2.0, 1, 0.75, 1, 0], [2.4, 3.9, 4.0, 1.7, 1, 0.75, 1, 0], [-2.2, 4.0, -4.2, 1.7, 1, 0.75, 1, 0]],
        leaf, H, { seed: 3, soft: 0.88, jitter: 0.55 });
      F.push(tp(cylY(0.5, 0.3, 0, 2.8, 4, 0, 0, 1, 1, true), bark, { H }));
      F.push(tp(blob(5.6, 0, 5.4, 0, 1.12, 0.58, 1.12, 0), leaf[0], { H, jitter: 1.0, ao: 0.6, vary: 0.18, soft: 0.9 }));
      return { near: mergeT(P), far: mergeT(F), H, lod: 300 };
    },
    redwood() {   // coast redwood: massive straight trunk, narrow ragged spire of drooping foliage sprays
      const H = 44, bark = 0x5c3223, leaf = [0x33502c, 0x3b4a2a, 0x2b4426, 0x415c36], P = [], F = [];
      P.push(tp(cylY(1.9, 1.15, 0, 2.5, 10), bark, { H, ao: 0.62 }));
      P.push(tp(cylY(1.15, 0.2, 2.5, 42, 9), bark, { H, ao: 0.78 }));
      const tiers = 17;
      for (let i = 0; i < tiers; i++) {
        const u = i / (tiers - 1), y = lerp(7.5, 41.5, u), r = lerp(5.0, 1.0, Math.pow(u, 0.85)) * lerp(0.8, 1.15, hash(i, 71)), h = lerp(5.0, 3.0, u);
        const g = new THREE.ConeGeometry(r, h, 8, 2, false); g.rotateY(i * 2.2);
        { const p = g.attributes.position; for (let j = 0; j < p.count; j++) { const yy = p.getY(j), a = Math.atan2(p.getZ(j), p.getX(j)); if (yy < h * 0.25) {
          const k = 1 + 0.3 * Math.sin(a * 3 + i * 1.3) * hash(i, 5); p.setX(j, p.getX(j) * k); p.setZ(j, p.getZ(j) * k); p.setY(j, yy - 0.6 * Math.max(0, k - 1) * h); } } }
        g.translate(Math.sin(i * 2.1) * 0.5, y, Math.cos(i * 1.7) * 0.5);
        P.push(tp(g, leaf[i % 4], { H, jitter: 0.6, ao: 0.45, vary: 0.24, seed: i + 3, soft: 0.5, crown: [0, 24, 0, 20] }));
      }
      const tip = new THREE.ConeGeometry(0.9, 4.2, 7, 1, false); tip.translate(0, 43, 0); P.push(tp(tip, leaf[1], { H, vary: 0.2 }));
      F.push(tp(cylY(1.4, 0.3, 0, 30, 5, 0, 0, 1, 1, true), bark, { H }));
      const fc = new THREE.ConeGeometry(4.6, 36, 7, 2, false); fc.translate(0, 25.5, 0); F.push(tp(fc, leaf[0], { H, ao: 0.55, jitter: 1.2, vary: 0.2, soft: 0.4 }));
      return { near: mergeT(P), far: mergeT(F), H, lod: 650 };
    },
    eucalyptus() {   // blue gum: tall tan forked trunk, open, ragged, drooping grey-green crown held high
      const H = 36, bark = 0xa89b7e, bark2 = 0x7f705b, leaf = [0x63745a, 0x708066, 0x5a6b52, 0x7b8972], P = [], F = [];
      const trunk = cylY(0.7, 0.3, 0, 16, 8); { const p = trunk.attributes.position; for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + Math.pow(p.getY(i) / 16, 1.5) * 0.7); }
      P.push(tp(trunk, bark, { H, ao: 0.5, vary: 0.3 }));
      const ends = [[3.4, 32, 1.0], [-2.8, 30, -1.3], [-1.2, 24.5, 3.0], [5.2, 26.5, -1.8], [0.6, 35, -0.4]];
      P.push(tp(limb([0.7, 15, 0], ends[0], 0.3, 0.1, 6), bark, { H, vary: 0.2 }));
      P.push(tp(limb([0.7, 15, 0], ends[1], 0.28, 0.09, 6), bark, { H, vary: 0.2 }));
      P.push(tp(limb([0.6, 12, 0], ends[2], 0.18, 0.07, 5), bark2, { H }));
      P.push(tp(limb([2.0, 23, 0.6], ends[3], 0.12, 0.05, 4), bark2, { H }));
      P.push(tp(limb([2.2, 25, 0.7], ends[4], 0.12, 0.05, 4), bark2, { H }));
      const blobs = []; const rr = U.rng(17);
      for (const [x, y, z] of ends) for (let k = 0; k < 5; k++) blobs.push([x + (rr() - 0.5) * 3.6, y - rr() * 4.5, z + (rr() - 0.5) * 3.6, lerp(0.9, 1.5, rr()), 1, lerp(1.5, 2.1, rr()), 1, k === 0 ? 1 : 0]);
      foliage(P, blobs, leaf, H, { seed: 11, ao: 0.55, jitter: 0.7, vary: 0.28, soft: 0.7 });
      F.push(tp(cylY(0.6, 0.2, 0, 26, 4, 0, 0, 1, 1, true), bark, { H }));
      F.push(tp(blob(4.6, 0.8, 29, 0, 1.0, 1.4, 1.0, 0), leaf[0], { H, jitter: 1.6, ao: 0.55, vary: 0.2, soft: 0.8 }));
      return { near: mergeT(P), far: mergeT(F), H, lod: 520 };
    },
    palm() {   // Canary Island date palm: stout pineapple-textured trunk, huge fountain of arching fronds
      const H = 14, bark = 0x76604a, P = [], F = [];
      const trunk = new THREE.CylinderGeometry(0.52, 0.62, 11.5, 12, 10); trunk.translate(0, 5.75, 0);
      { const p = trunk.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i), a = Math.atan2(p.getZ(i), p.getX(i)); const k = 1 + 0.07 * Math.sin(y * 7.5 + a * 3) * Math.sin(a * 6 + y * 3); p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k); } }
      P.push(tp(trunk, bark, { H, ao: 0.55, vary: 0.18, jitter: 0.03 }));
      P.push(tp(blob(1.15, 0, 11.7, 0, 1, 0.75, 1, 1), 0x6e6a3a, { H, vary: 0.2 }));
      const n = 44;
      for (let i = 0; i < n; i++) {
        const th = i * 2.39996, row = i % 4, el = [0.8, 0.42, 0.05, -0.3][row] + (hash(i, 3) - 0.5) * 0.3;
        const g = frond(6.4 - row * 0.2, 0.55, th, el, [1.8, 2.0, 1.9, 1.4][row], 5, 0.22); g.translate(0, 12.2 - row * 0.25, 0);
        P.push(tp(g, [0x587a2e, 0x628335, 0x6c8839, 0x768a3f][row], { H, vary: 0.16, seed: i }));
      }
      F.push(tp(cylY(0.58, 0.52, 0, 11.5, 5, 0, 0, 1, 1, true), bark, { H }));
      for (let i = 0; i < 10; i++) { const g = frond(6.6, 0.9, i * 0.628, [0.8, 0.05][i % 2], 1.3, 2, 0.1); g.translate(0, 12, 0); F.push(tp(g, 0x608234, { H })); }
      return { near: mergeT(P), far: mergeT(F), H, lod: 380, doubleSide: true };
    },
    fanpalm() {   // Mexican fan palm: very tall slender trunk, a ball of fan leaves over a skirt of dead fronds
      const H = 23, bark = 0x857462, P = [], F = [];
      const lean = (y) => 0.5 * Math.pow(y / 20.5, 2);
      const trunk = cylY(0.32, 0.22, 0, 20.6, 8); { const p = trunk.attributes.position; for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + lean(p.getY(i))); }
      P.push(tp(trunk, bark, { H, ao: 0.62, vary: 0.1 }));
      const skirt = new THREE.CylinderGeometry(0.72, 0.36, 1.8, 12, 3, true); skirt.translate(lean(19.9), 19.9, 0);
      P.push(tp(skirt, 0x6e5c47, { H, jitter: 0.14, vary: 0.35, ao: 0.5 }));
      const top = v3(lean(20.6), 20.9, 0);
      for (let i = 0; i < 24; i++) {
        const th = i * 2.39996, el = -0.6 + 1.85 * ((i * 0.618) % 1), L = 1.2 + 0.45 * hash(i, 4);
        const dir = v3(Math.cos(el) * Math.cos(th), Math.sin(el), -Math.cos(el) * Math.sin(th));
        const e = top.clone().addScaledVector(dir, L);
        P.push(tp(seg3(top, e, 0.03, 0.02, 3, true), 0x76803f, { H }));
        const g = fan(1.05, th, el + 0.15, 7); g.translate(e.x, e.y, e.z);
        P.push(tp(g, i % 3 ? 0x557636 : 0x628540, { H, vary: 0.16, seed: i }));
      }
      F.push(tp(cylY(0.3, 0.22, 0, 20.5, 4, 0, 0, 1, 1, true), bark, { H }));
      F.push(tp(blob(2.3, top.x, 21.2, 0, 1, 0.85, 1, 0), 0x58763a, { H, soft: 0.8 }));
      F.push(tp(cylY(0.75, 0.5, 17.6, 20.2, 5, top.x, 0, 1, 1, true), 0x8a7254, { H }));
      return { near: mergeT(P), far: mergeT(F), H, lod: 450, doubleSide: true };
    },
    sycamore() {   // London plane / sycamore: mottled pale trunk, broad rounded crown of fresh green
      const H = 16, leaf = [0x5e7a38, 0x6a8540, 0x546f32, 0x758f49], P = [], F = [];
      P.push(tp(cylY(0.42, 0.28, 0, 6.0, 9), 0xaca58a, { H, ao: 0.72, vary: 0.45 }));
      for (const [x, y, z] of [[2.4, 10.5, 1.0], [-2.2, 11, -1.1], [0.5, 12.5, 1.9], [-0.6, 12, -2.2]]) P.push(tp(limb([0, 5.5, 0], [x * 0.75, y - 1.2, z * 0.75], 0.2, 0.09), 0x9f9a80, { H, vary: 0.3 }));
      foliage(P, [[0, 12.3, 0, 3.6, 1, 0.82, 1], [2.9, 10.8, 1.1, 2.9, 1, 0.85, 1], [-2.9, 11.2, -1.1, 3.0, 1, 0.82, 1], [0.9, 13.6, -2.0, 2.4, 1, 0.85, 1],
        [-1.1, 10.2, 2.7, 2.5, 1, 0.85, 1], [2.2, 13.8, 2.0, 2.0, 1, 0.85, 1, 0], [-2.4, 13.6, 1.4, 2.0, 1, 0.85, 1, 0], [3.8, 9.2, -1.6, 1.8, 1, 0.85, 1, 0]], leaf, H, { seed: 21 });
      F.push(tp(cylY(0.4, 0.3, 0, 7, 5), 0xaca58a, { H }));
      F.push(tp(blob(4.8, 0, 11.4, 0, 1, 0.88, 1, 0), leaf[0], { H, jitter: 0.9, ao: 0.58, vary: 0.2, soft: 0.85 }));
      return { near: mergeT(P), far: mergeT(F), H, lod: 320 };
    },
    cypress() {   // Monterey cypress: gnarled limbs, wind-swept flat-topped plates of dark foliage
      const H = 14, bark = 0x5b4636, leaf = [0x2f4428, 0x364c2c, 0x2a3d25, 0x3c5230], P = [], F = [];
      P.push(tp(limb([0, 0, 0], [1.3, 5.5, 0.4], 0.6, 0.36, 8), bark, { H, ao: 0.55 }));
      P.push(tp(limb([0.3, 2.0, 0], [-2.6, 7.6, -0.7], 0.34, 0.16, 6), bark, { H }));
      P.push(tp(limb([0.7, 3.8, 0.2], [4.2, 9.2, 1.5], 0.3, 0.14, 6), bark, { H }));
      P.push(tp(limb([1.2, 5.2, 0.4], [1.8, 11.2, -0.8], 0.26, 0.12, 6), bark, { H }));
      foliage(P, [[1.4, 12.0, -0.4, 4.2, 1.25, 0.34, 1.0], [4.6, 10.1, 1.6, 3.2, 1.2, 0.38, 1.0], [-2.8, 8.9, -0.9, 3.4, 1.25, 0.4, 1.0], [0.3, 7.6, 1.8, 2.8, 1.2, 0.42, 1.0],
        [5.6, 12.4, -1.2, 2.4, 1.2, 0.36, 1.0, 0], [-1.2, 13.2, -1.7, 2.6, 1.3, 0.32, 1.0, 0], [-4.2, 10.6, 0.8, 2.0, 1.2, 0.4, 1.0, 0]], leaf, H, { seed: 31, jitter: 0.5, soft: 0.7, ao: 0.5 });
      F.push(tp(limb([0, 0, 0], [1, 7, 0], 0.5, 0.3, 5), bark, { H }));
      F.push(tp(blob(5.8, 1.0, 10.5, 0, 1.25, 0.42, 1.0, 0), leaf[0], { H, jitter: 0.8, ao: 0.5, soft: 0.8 }));
      return { near: mergeT(P), far: mergeT(F), H, lod: 320 };
    },
    pine() {   // Monterey pine: straight trunk, dense irregular dome of dark needles
      const H = 22, bark = 0x5a4332, leaf = [0x2c4428, 0x33502f, 0x2a3f29, 0x3a5634], P = [], F = [];
      P.push(tp(cylY(0.52, 0.16, 0, 20, 8), bark, { H, ao: 0.6 }));
      for (const [x, y, z] of [[2.6, 15, 1.1], [-2.4, 15.6, -1.2], [0.6, 13.2, -2.4], [-1.2, 12.6, 2.2]]) P.push(tp(limb([0, y - 3, 0], [x, y, z], 0.14, 0.06, 4), bark, { H }));
      foliage(P, [[0.4, 18.6, 0.3, 3.3, 1, 0.8, 1], [2.6, 15.8, 1.1, 2.8, 1, 0.72, 1], [-2.4, 16.3, -1.1, 2.9, 1, 0.75, 1], [0.6, 13.6, -2.2, 2.5, 1, 0.72, 1],
        [-1.1, 12.8, 2.1, 2.3, 1, 0.7, 1, 0], [1.2, 20.8, -0.5, 2.1, 1, 0.8, 1, 0], [3.2, 18.4, -1.6, 1.9, 1, 0.75, 1, 0]], leaf, H, { seed: 41, ao: 0.52 });
      F.push(tp(cylY(0.5, 0.2, 0, 18, 5), bark, { H }));
      F.push(tp(blob(4.6, 0.4, 16.6, 0, 1, 1.0, 1, 0), leaf[0], { H, jitter: 1.0, ao: 0.5, soft: 0.85 }));
      return { near: mergeT(P), far: mergeT(F), H, lod: 380 };
    },
    street() {   // small ornamental street tree (pear / crape myrtle / ash)
      const H = 7.5, leaf = [0x6a8744, 0x76934c, 0x5f7b3c, 0x81994f], P = [], F = [];
      P.push(tp(cylY(0.15, 0.1, 0, 2.9, 7), 0x66584a, { H, ao: 0.6 }));
      P.push(tp(limb([0, 2.5, 0], [0.9, 4.2, 0.4], 0.08, 0.04, 4), 0x66584a, { H }));
      P.push(tp(limb([0, 2.5, 0], [-0.8, 4.4, -0.5], 0.08, 0.04, 4), 0x66584a, { H }));
      foliage(P, [[0, 5.0, 0, 2.0, 1, 0.95, 1], [1.2, 4.6, 0.6, 1.5, 1, 0.9, 1, 1], [-1.1, 4.8, -0.7, 1.5, 1, 0.9, 1, 1], [0.3, 6.1, -0.4, 1.4, 1, 0.9, 1, 0], [-0.4, 4.3, 1.2, 1.3, 1, 0.9, 1, 0]], leaf, H, { seed: 51 });
      F.push(tp(cylY(0.15, 0.11, 0, 2.8, 4), 0x66584a, { H }));
      F.push(tp(blob(2.6, 0, 5.0, 0, 1, 0.92, 1, 0), leaf[0], { H, ao: 0.6, jitter: 0.4, soft: 0.85 }));
      return { near: mergeT(P), far: mergeT(F), H, lod: 240 };
    },
  };
  TREE_BUILDERS.fan = TREE_BUILDERS.fanpalm; TREE_BUILDERS.plane = TREE_BUILDERS.sycamore; TREE_BUILDERS.date = TREE_BUILDERS.palm;
  const treeCache = {}, treeMats = {};
  const TREE_VHEAD = `
    attribute float aFlex;
    void lifeWind(inout vec3 p, inout vec3 n) {
      #ifdef USE_INSTANCING
        vec3 ip = instanceMatrix[3].xyz; mat3 im = mat3(instanceMatrix);
      #else
        vec3 ip = vec3(0.0); mat3 im = mat3(1.0);
      #endif
      float sc = sqrt(max(1e-6, dot(im[0], im[0])));
      float ph = ip.x * 0.043 + ip.z * 0.031;
      float w = uLifeWind;
      float sway = (sin(uLifeTime * 0.85 + ph) * 0.65 + sin(uLifeTime * 1.9 + ph * 1.7) * 0.28 + sin(uLifeTime * 3.7 + ph * 2.3) * 0.07);
      vec3 dirL = transpose(im) * normalize(vec3(0.85, 0.0, 0.35)) / sc;
      float f = aFlex * aFlex;
      vec3 p0 = p;
      p += dirL * (sway * (0.05 + 0.45 * w) * f * (0.6 + 0.03 * p0.y));
      // leaf flutter: a continuous function of position so shared (flat-shaded) vertices never crack apart
      float tt = uLifeTime * (5.0 + 3.0 * w) + ph * 5.0;
      vec3 fl = vec3(sin(tt + p0.y * 1.7 + p0.z * 1.3), 0.6 * sin(tt * 0.9 + p0.x * 1.9 + p0.z * 1.1), sin(tt * 1.1 + p0.x * 1.5 + p0.y * 1.2));
      p += fl * (0.02 + 0.05 * w) * smoothstep(0.3, 0.5, aFlex) / sc;
    }
  `;
  const TREE_INJ = { vHead: TREE_VHEAD, call: 'lifeWind(lifeP, objectNormal);' };
  function treeSpec(kind) {
    const k = TREE_BUILDERS[kind] ? kind : 'street';
    if (!treeCache[k]) { const s = TREE_BUILDERS[k](); s.near.computeBoundingSphere(); s.far.computeBoundingSphere(); treeCache[k] = s; }
    if (!treeMats[k]) {
      const side = treeCache[k].doubleSide ? THREE.DoubleSide : THREE.FrontSide;
      treeMats[k] = {
        m: lifeMaterial('tree' + (side === THREE.DoubleSide ? '2' : '1'), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side }), TREE_INJ),
        d: depthMaterial('tree' + (side === THREE.DoubleSide ? '2' : '1'), TREE_INJ, side),
      };
    }
    return { spec: treeCache[k], mat: treeMats[k] };
  }

  function createTrees(kind = 'oak', max = 1024, opts = {}) {
    const { spec, mat } = treeSpec(kind);
    const near = new THREE.InstancedMesh(spec.near, mat.m, max), far = new THREE.InstancedMesh(spec.far, mat.m, max);
    for (const m of [near, far]) {
      m.customDepthMaterial = mat.d; m.receiveShadow = true; m.count = 0;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    }
    near.castShadow = true; far.castShadow = opts.farShadows || false;
    const group = new THREE.Group(); group.name = 'trees-' + kind; group.add(near, far);
    const M = new Float32Array(max * 16), C = new Float32Array(max * 3), X = new Float32Array(max * 3);
    const anchor = new V3(); let anchored = false, n = 0, split = false, dirty = true;
    const lodD = opts.lodDistance || spec.lod; const lastCam = new V3(1e9, 0, 0);
    function upload(target, idx) {
      const im = target.instanceMatrix.array, ic = target.instanceColor.array;
      for (let k = 0; k < idx.length; k++) { const i = idx[k]; im.set(M.subarray(i * 16, i * 16 + 16), k * 16); ic.set(C.subarray(i * 3, i * 3 + 3), k * 3); }
      target.count = idx.length;
      target.instanceMatrix.needsUpdate = true; target.instanceColor.needsUpdate = true;
      if (idx.length) { target.computeBoundingSphere(); target.boundingSphere.radius += 2; }
    }
    const set = {
      mesh: group, group, kind, max, near, far, height: spec.H,
      get count() { return n; },
      // world coords; scale ~1 = typical specimen; rot = yaw (random if omitted); tint = number (brightness) or [r,g,b]
      add(x, y, z, scale = 1, rot, tint) {
        if (n >= max) return -1;
        if (!anchored) { anchor.set(Math.round(x), Math.round(y), Math.round(z)); group.position.copy(anchor); anchored = true; }
        const h1 = hash(Math.round(x * 10), Math.round(z * 10)), h2 = hash(Math.round(z * 10) + 7, Math.round(x * 10));
        const ry = rot === undefined || rot === null ? h1 * TAU : rot;
        _q.setFromAxisAngle(_up, ry); _s.set(scale, scale * (0.9 + 0.2 * h2), scale); _v.set(x - anchor.x, y - anchor.y, z - anchor.z);
        _m.compose(_v, _q, _s); _m.toArray(M, n * 16);
        X[n * 3] = x; X[n * 3 + 1] = y; X[n * 3 + 2] = z;
        let r, g, b;
        if (Array.isArray(tint)) [r, g, b] = tint;
        else { const t = typeof tint === 'number' ? tint : 0.9 + 0.2 * h2; const hue = (h1 - 0.5) * 0.08; r = t * (1 + hue); g = t; b = t * (1 - hue * 0.5); }
        C[n * 3] = r; C[n * 3 + 1] = g; C[n * 3 + 2] = b;
        dirty = true;
        return n++;
      },
      // push changes to the GPU (call after a batch of add()); keeps the current near/far split if update() is used
      commit() { if (!split) { const idx = Array.from({ length: n }, (_, i) => i); upload(near, idx); far.count = 0; } else { lastCam.set(1e9, 0, 0); } dirty = false; },
      // optional per-frame LOD: trees within lodDistance of camPos use the detailed mesh, the rest the cheap one
      update(camPos) {
        if (!camPos || !n) return;
        if (!dirty && lastCam.distanceToSquared(camPos) < 900) return;
        split = true; lastCam.copy(camPos); dirty = false;
        const a = [], b = []; const d2 = lodD * lodD;
        for (let i = 0; i < n; i++) { const dx = X[i * 3] - camPos.x, dz = X[i * 3 + 2] - camPos.z; (dx * dx + dz * dz < d2 ? a : b).push(i); }
        upload(near, a); upload(far, b);
      },
      clear() { n = 0; near.count = far.count = 0; anchored = false; split = false; },
      setLODDistance(d) { opts.lodDistance = d; lastCam.set(1e9, 0, 0); },
    };
    return set;
  }

  // ==========================================================================================
  // VEHICLES (shared by traffic and aircraft): per-vertex base color, paint mask, glow class,
  // roughness/metalness; per-instance paint color and state.
  // ==========================================================================================
  function vp(geo, hex, o = {}) {
    const g = prep(geo); const c = lin(hex);
    constAttr(g, 'aCol', [c.r, c.g, c.b]); constAttr(g, 'aPaint', [o.paint || 0]); constAttr(g, 'aGlow', [o.glow || 0]);
    constAttr(g, 'aMat', [o.rough !== undefined ? o.rough : 0.6, o.metal || 0]); constAttr(g, 'aGear', [o.gear || 0]);
    return g;
  }
  const VEH_VHEAD = `
    attribute vec3 aCol; attribute float aPaint; attribute float aGlow; attribute vec2 aMat; attribute float aGear;
    attribute vec4 aInst;   // paint (packed sRGB), state A, state B, phase
    varying vec3 vLifeCol; varying vec3 vLifeGlow; varying vec2 vLifeMat;
    uniform float uLifeKind;  // 0 road vehicle, 1 aircraft
    void lifeVehicle(inout vec3 p, inout vec3 n) {
      vLifeCol = mix(aCol, lifeUnpack(aInst.x), aPaint);
      vLifeMat = aMat;
      float night = uLifeNight;
      vec3 gl = vec3(0.0);
      if (uLifeKind < 0.5) {
        if (aGlow > 0.5 && aGlow < 1.5) gl = vec3(1.0, 0.93, 0.8) * (0.12 + 5.0 * night);
        else if (aGlow > 1.5 && aGlow < 2.5) gl = vec3(1.0, 0.03, 0.015) * (0.05 + 1.6 * night + 3.0 * aInst.y);
        else if (aGlow > 2.5 && aGlow < 3.5) gl = vec3(1.0, 0.9, 0.72) * (1.4 * night);
        else if (aGlow > 3.5) gl = vec3(1.0, 0.55, 0.1) * (0.5 + 2.0 * night);
      } else {
        if (aGear > 0.5 && aInst.y < 0.5) p = vec3(0.0);
        float t = uLifeTime + aInst.w;
        float strobe = step(0.93, fract(t * 1.05)) + step(0.93, fract(t * 1.05 + 0.1));
        float beacon = step(0.86, fract(t * 0.95 + 0.5));
        if (aGlow > 0.5 && aGlow < 1.5) gl = vec3(1.0, 0.96, 0.88) * aInst.z * (2.0 + 12.0 * night);
        else if (aGlow > 1.5 && aGlow < 2.5) gl = vec3(1.0, 0.04, 0.02) * (0.5 + 5.0 * night);
        else if (aGlow > 2.5 && aGlow < 3.5) gl = vec3(0.05, 1.0, 0.25) * (0.5 + 5.0 * night);
        else if (aGlow > 3.5 && aGlow < 4.5) gl = vec3(1.0) * (0.4 + 4.0 * night);
        else if (aGlow > 4.5 && aGlow < 5.5) gl = vec3(1.0) * strobe * (6.0 + 20.0 * night);
        else if (aGlow > 5.5 && aGlow < 6.5) gl = vec3(1.0, 0.05, 0.02) * beacon * (2.0 + 8.0 * night);
        else if (aGlow > 6.5) gl = vec3(1.0, 0.9, 0.7) * (1.2 * night);
      }
      vLifeGlow = gl;
    }
  `;
  function vehicleMaterial(kind) {
    const inj = {
      vHead: VEH_VHEAD, call: 'lifeVehicle(lifeP, objectNormal);',
      fHead: 'varying vec3 vLifeCol; varying vec3 vLifeGlow; varying vec2 vLifeMat;',
      fColor: 'diffuseColor.rgb *= vLifeCol;',
      fAfter: [['#include <roughnessmap_fragment>', 'roughnessFactor = vLifeMat.x;'], ['#include <metalnessmap_fragment>', 'metalnessFactor = vLifeMat.y;']],
      fEmissive: 'totalEmissiveRadiance += vLifeGlow;',
    };
    const m = lifeMaterial('veh' + kind, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.2 }), inj);
    const orig = m.onBeforeCompile; m.onBeforeCompile = sh => { orig(sh); sh.uniforms.uLifeKind = { value: kind }; };
    const d = depthMaterial('veh' + kind, inj); const od = d.onBeforeCompile; d.onBeforeCompile = sh => { od(sh); sh.uniforms.uLifeKind = { value: kind }; };
    return { m, d };
  }
  let roadMat = null, airMat = null;

  // ------------------------------------------------------------------------------------------
  // Light flares: camera-facing additive glows for lamps (headlights, tail lights, aircraft nav,
  // strobes, beacons, landing lights). A flare mesh shares its vehicle mesh's instanceMatrix and
  // aInst buffers, so it costs one extra draw call and no extra CPU work. Distant lights keep a
  // minimum on-screen size, so arrivals over the bay read as a string of lights at night.
  // ------------------------------------------------------------------------------------------
  let lampSink = null;
  function lamp(p, kind, size) { if (lampSink) lampSink.push({ p, kind, size }); }
  function withLamps(build) { lampSink = []; const m = build(); m.lamps = lampSink; lampSink = null; return m; }
  function flareGeometry(lamps) {
    const n = lamps.length, P = new Float32Array(n * 12), C = new Float32Array(n * 8), K = new Float32Array(n * 4), S = new Float32Array(n * 4), idx = [];
    lamps.forEach((l, i) => {
      for (let c = 0; c < 4; c++) { P.set(l.p, (i * 4 + c) * 3); K[i * 4 + c] = l.kind; S[i * 4 + c] = l.size; }
      C.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8);
      idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));   // lamp centre, vehicle-local
    g.setAttribute('aCorner', new THREE.BufferAttribute(C, 2));
    g.setAttribute('aKind', new THREE.BufferAttribute(K, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(S, 1));
    g.setIndex(idx); return g;
  }
  const FLARE_VS = `
    #include <common>
    #include <logdepthbuf_pars_vertex>
    attribute vec2 aCorner; attribute float aKind; attribute float aSize; attribute vec4 aInst;
    uniform float uNight; uniform float uTime; uniform float uFamily;
    varying vec2 vUv; varying vec3 vCol;
    void main() {
      mat4 m = modelMatrix * instanceMatrix;
      vec4 wp = m * vec4(position, 1.0);
      vec3 fwd = normalize((m * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
      float scl = length(instanceMatrix[0].xyz);
      float face = dot(fwd, normalize(cameraPosition - wp.xyz));
      vec3 col = vec3(0.0); float I = 0.0;
      if (uFamily < 0.5) {
        if (aKind < 0.5) { col = vec3(1.0, 0.9, 0.72); I = (smoothstep(-0.15, 0.75, face) * 1.25 + 0.06) * uNight; }
        else { col = vec3(1.0, 0.07, 0.03); I = (smoothstep(0.15, -0.75, face) * 0.75 + 0.08) * (1.0 + 1.6 * aInst.y) * uNight; }
      } else {
        float t = uTime + aInst.w, lit = 0.25 + 0.75 * uNight;
        if (aKind < 0.5) { col = vec3(1.0, 0.95, 0.86); I = aInst.z * (0.5 + 1.6 * smoothstep(-0.2, 0.85, face)) * lit; }
        else if (aKind < 1.5) { col = vec3(1.0, 0.05, 0.03); I = 0.9 * lit; }
        else if (aKind < 2.5) { col = vec3(0.12, 1.0, 0.35); I = 0.9 * lit; }
        else if (aKind < 3.5) { col = vec3(1.0); I = 0.55 * uNight; }
        else if (aKind < 4.5) { col = vec3(1.0); I = (step(0.93, fract(t * 1.05)) + step(0.93, fract(t * 1.05 + 0.1))) * 2.2 * lit; }
        else if (aKind < 5.5) { col = vec3(1.0, 0.1, 0.04); I = step(0.86, fract(t * 0.95 + 0.5)) * 1.5 * lit; }
        else { col = vec3(1.0, 0.95, 0.86); I = step(0.5, aInst.y) * aInst.z * (0.2 + 1.2 * smoothstep(0.2, 0.9, face)) * lit; }
      }
      vec4 mv = viewMatrix * wp;
      float size = max(aSize * scl, -mv.z * 0.0024) * (0.55 + 0.45 * clamp(I, 0.0, 1.0));
      mv.xy += aCorner * size;
      gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
      vUv = aCorner; vCol = col * I * min(scl * 1.5, 1.0);
      if (I * scl < 0.004) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    }`;
  const FLARE_FS = `
    #include <common>
    #include <logdepthbuf_pars_fragment>
    varying vec2 vUv; varying vec3 vCol;
    void main() {
      #include <logdepthbuf_fragment>
      float d2 = dot(vUv, vUv);
      float a = (exp(-d2 * 12.0) * 1.2 + exp(-d2 * 4.0) * 0.22) * (1.0 - smoothstep(0.55, 1.0, d2));
      gl_FragColor = vec4(vCol * a, 1.0);
      #include <colorspace_fragment>
    }`;
  const flareMats = {};
  function flareMaterial(family) {
    return flareMats[family] || (flareMats[family] = new THREE.ShaderMaterial({
      uniforms: { uNight: U.uNight, uTime: U.uTime, uFamily: { value: family } }, vertexShader: FLARE_VS, fragmentShader: FLARE_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  }
  // a flare mesh riding on an existing vehicle InstancedMesh (shares its instance buffers)
  function flaresFor(vmesh, inst, lamps, family, cap) {
    const g = flareGeometry(lamps); g.setAttribute('aInst', inst);
    const f = new THREE.InstancedMesh(g, flareMaterial(family), cap);
    f.instanceMatrix = vmesh.instanceMatrix; f.count = 0; f.renderOrder = 3; f.name = vmesh.name + '-flares';
    f.position.copy(vmesh.position); f.frustumCulled = vmesh.frustumCulled; f.boundingSphere = vmesh.boundingSphere;
    return f;
  }

  // ------------------------------------------------------------------------------------------
  // road vehicle models (+X forward, origin on the ground at the vehicle center)
  // Cars, SUVs, pickups and vans are lofted: a side outline (roof/hood/trunk line, beltline, sill with wheel
  // arches) swept through a cross-section with tumblehome (the glasshouse leans in) and plan-view rounding at the
  // nose and tail, so bodies read as smooth pressed steel with real arches instead of extruded slabs.
  // ------------------------------------------------------------------------------------------
  const GLASS = 0x1b232b, TIRE = 0x161616, RIM = 0x9da3a9, LAMP = 0xdfe6ea, TAIL = 0x6a0c0c, TRIM = 0x202225, UNDER = 0x141414;
  // piecewise-linear outline lookup (points sorted by x)
  function outline(pts) {
    return (x) => {
      if (x <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
      return pts[pts.length - 1][1];
    };
  }
  // quads collected per surface kind, each kind one indexed geometry with shared vertices (smooth normals inside it)
  function surfaceSink() {
    const kinds = {};
    const get = (k) => kinds[k] || (kinds[k] = { pos: [], idx: [], map: new Map() });
    const vert = (S, key, p) => { let i = S.map.get(key); if (i === undefined) { i = S.pos.length / 3; S.pos.push(p[0], p[1], p[2]); S.map.set(key, i); } return i; };
    return {
      quad(k, ka, a, kb, b, kc, c, kd, d) { const S = get(k); const ia = vert(S, ka, a), ib = vert(S, kb, b), ic = vert(S, kc, c), id = vert(S, kd, d); S.idx.push(ia, ib, ic, ia, ic, id); },
      tri(k, ka, a, kb, b, kc, c) { const S = get(k); S.idx.push(vert(S, ka, a), vert(S, kb, b), vert(S, kc, c)); },
      geos() {
        const out = {};
        for (const k in kinds) { const S = kinds[k]; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(S.pos, 3)); g.setIndex(S.idx); g.computeVertexNormals(); out[k] = g; }
        return out;
      },
    };
  }
  // o: { x0, x1 (rear, front), hw, top: [[x,y]..], belt: y or [[x,y]..], sill, bumperLo, wheels: [x..], arch (radius), wheelR,
  //      tumble (glasshouse inset), endR (plan rounding length), noseW / tailW (width factor at the very ends), glassSlope }
  function loftBody(o, P, paintOpt) {
    const top = outline(o.top), belt = typeof o.belt === 'number' ? () => o.belt : outline(o.belt);
    const N = o.n || 26, sink = surfaceSink();
    const xs = []; for (let i = 0; i <= N; i++) { const t = i / N; xs.push(o.x0 + (o.x1 - o.x0) * (0.5 - 0.5 * Math.cos(Math.PI * t))); }   // denser at the ends
    // bottom outline: sill, rising in an arch over every wheel, bumpers at the ends
    const bot = (x) => {
      let y = o.sill;
      for (const wx of o.wheels) { const d = Math.abs(x - wx); if (d < o.arch) y = Math.max(y, o.wheelR + Math.sqrt(o.arch * o.arch - d * d) * 0.93); }
      const e = Math.min(x - o.x0, o.x1 - x); if (e < 0.35) y = Math.min(y, o.bumperLo + (o.sill - o.bumperLo) * (e / 0.35)) ;
      return y;
    };
    const width = (x) => {
      const er = o.endR || 0.5; let f = 1;
      const df = o.x1 - x, dr = x - o.x0;
      if (df < er) { const s = 1 - df / er; f = (o.noseW || 0.8) + (1 - (o.noseW || 0.8)) * Math.sqrt(Math.max(0, 1 - s * s)); }
      if (dr < er) { const s = 1 - dr / er; f = Math.min(f, (o.tailW || 0.84) + (1 - (o.tailW || 0.84)) * Math.sqrt(Math.max(0, 1 - s * s))); }
      return o.hw * f;
    };
    // cross-section (right side, bottom to top); the left side mirrors it
    const section = (x) => {
      const w = width(x), yb = bot(x), yt = top(x), ybe = Math.min(belt(x), yt), gh = yt - ybe;
      const tum = Math.min(o.tumble || 0.14, gh * 0.4), wr = w - tum;
      return [
        [w * 0.93, yb], [w * 0.995, yb + 0.07], [w, Math.min(yb + 0.2, ybe - 0.04)], [w, Math.max(ybe - 0.1, yb + 0.21)], [w * 0.99, ybe],    // body side
        [gh > 0.05 ? wr : w * 0.97, gh > 0.05 ? yt - 0.045 : ybe + 0.01],                                                           // glasshouse top edge
        [gh > 0.05 ? wr * 0.9 : w * 0.88, yt], [wr * 0.45, yt + 0.012], [0, yt + 0.015],                                            // roof / hood crown
      ];
    };
    const secs = xs.map(section), slope = xs.map((x, i) => { const a = xs[Math.max(0, i - 1)], b = xs[Math.min(N, i + 1)]; return (top(b) - top(a)) / Math.max(1e-3, b - a); });
    const ghOf = (i) => top(xs[i]) - Math.min(belt(xs[i]), top(xs[i]));
    const P3 = (i, j, s) => { const q = secs[i][j]; return [xs[i], q[1], q[0] * s]; };
    for (let i = 0; i < N; i++) for (const s of [1, -1]) {
      const K = (ii, j) => `${ii},${j},${s}`;
      const q = (k, j) => (s > 0 ? sink.quad(k, K(i, j), P3(i, j, s), K(i + 1, j), P3(i + 1, j, s), K(i + 1, j + 1), P3(i + 1, j + 1, s), K(i, j + 1), P3(i, j + 1, s))
                                 : sink.quad(k, K(i, j), P3(i, j, s), K(i, j + 1), P3(i, j + 1, s), K(i + 1, j + 1), P3(i + 1, j + 1, s), K(i + 1, j), P3(i + 1, j, s)));
      for (let j = 0; j < 4; j++) q('paint', j);                                                  // doors, fenders, sills
      const glassSide = ghOf(i) > 0.12 && ghOf(i + 1) > 0.12;
      q(glassSide ? 'glass' : 'paint', 4);                                                        // side windows (or hood/trunk edge)
      const glassTop = Math.abs(slope[i] + slope[i + 1]) * 0.5 > (o.glassSlope || 0.42) && glassSide;
      for (let j = 5; j < 8; j++) q(glassTop ? 'glass' : 'paint', j);                            // windshield / rear window, or roof, hood, trunk
    }
    // underside (dark, closes the arches) and the end faces
    for (let i = 0; i < N; i++) sink.quad('under', `u${i}a`, P3(i, 0, -1), `u${i + 1}a`, P3(i + 1, 0, -1), `u${i + 1}b`, P3(i + 1, 0, 1), `u${i}b`, P3(i, 0, 1));
    for (const [i, dir] of [[0, -1], [N, 1]]) {
      const ring = []; for (let j = 0; j < secs[i].length; j++) ring.push(P3(i, j, 1)); for (let j = secs[i].length - 1; j >= 0; j--) ring.push(P3(i, j, -1));
      const c = [xs[i] + dir * 0.012, ring.reduce((a, p) => a + p[1], 0) / ring.length, 0];
      for (let k = 0; k < ring.length; k++) { const a = ring[k], b = ring[(k + 1) % ring.length];
        if (dir > 0) sink.tri('cap', `c${i}`, c, `e${i},${k}`, a, `e${i},${(k + 1) % ring.length}`, b); else sink.tri('cap', `c${i}`, c, `e${i},${(k + 1) % ring.length}`, b, `e${i},${k}`, a); }
    }
    const G = sink.geos();
    if (G.paint) P.push(vp(G.paint, 0xffffff, paintOpt));
    if (G.cap) P.push(vp(G.cap, 0xffffff, paintOpt));
    if (G.glass) P.push(vp(G.glass, GLASS, { rough: 0.05, metal: 0.2 }));
    if (G.under) P.push(vp(G.under, UNDER, { rough: 1 }));
    return { top, bot, width, belt };
  }
  function glassSides(poly, halfW, parts) { // side windows as thin extruded polygons flush on both flanks
    parts.push(vp(extrudeXY(poly, 0.02, halfW - 0.004), GLASS, { rough: 0.08, metal: 0.1 }));
    parts.push(vp(extrudeXY(poly, 0.02, -halfW - 0.016), GLASS, { rough: 0.08, metal: 0.1 }));
  }
  function glassOnSegment(x0, y0, x1, y1, halfW, parts, glow) {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy); const nx = dy / len, ny = -dx / len;
    const g = new THREE.BoxGeometry(len, 0.03, halfW * 2); g.rotateZ(Math.atan2(dy, dx)); g.translate((x0 + x1) / 2 + nx * 0.012, (y0 + y1) / 2 + ny * 0.012, 0);
    parts.push(vp(g, GLASS, { rough: 0.06, metal: 0.1, glow: glow || 0 }));
  }
  // tyre with rounded shoulders and a sidewall bulge (lathe), a solid alloy rim with a darker recessed centre and hub
  const wheelCache = {};
  function wheelGeo(r, w) {
    const k = r + '/' + w; if (wheelCache[k]) return wheelCache[k];
    const tp = [[r * 0.64, w * 0.5], [r * 0.86, w * 0.52], [r * 0.97, w * 0.42], [r, w * 0.25], [r, -w * 0.25], [r * 0.97, -w * 0.42], [r * 0.86, -w * 0.52], [r * 0.64, -w * 0.5]];
    const tyre = new THREE.LatheGeometry(tp.map(([a, b]) => new THREE.Vector2(a, b)), 14); tyre.rotateX(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(r * 0.66, r * 0.66, w * 0.9, 14, 1); rim.rotateX(Math.PI / 2);
    const dish = new THREE.CylinderGeometry(r * 0.42, r * 0.42, w * 0.96, 10, 1); dish.rotateX(Math.PI / 2);
    const hub = new THREE.CylinderGeometry(r * 0.12, r * 0.12, w * 1.02, 6, 1); hub.rotateX(Math.PI / 2);
    return (wheelCache[k] = { tyre, rim, dish, hub });
  }
  function wheels(parts, xs, r, halfTrack, w = 0.22) {
    const W = wheelGeo(r, w);
    for (const x of xs) for (const s of [-1, 1]) {
      const at = (g) => { const c = g.clone(); c.translate(x, r, s * halfTrack); return c; };
      parts.push(vp(at(W.tyre), TIRE, { rough: 0.92 }));
      parts.push(vp(at(W.rim), RIM, { rough: 0.32, metal: 0.7 }));
      parts.push(vp(at(W.dish), 0x3a3d42, { rough: 0.5, metal: 0.5 }));
      parts.push(vp(at(W.hub), RIM, { rough: 0.3, metal: 0.7 }));
    }
  }
  function lights(parts, xf, xr, yf, yr, zf, zr, wf = 0.3, wr = 0.34) {
    for (const s of [-1, 1]) {
      lamp([xf + 0.03, yf, s * zf], 0, 0.6); lamp([xr - 0.03, yr, s * zr], 1, 0.45);
      parts.push(vp(box(0.06, 0.1, wf, xf - 0.015, yf, s * zf), LAMP, { glow: 1, rough: 0.1 }));
      parts.push(vp(box(0.06, 0.09, wr, xr + 0.015, yr, s * zr), TAIL, { glow: 2, rough: 0.2 }));
    }
  }
  const mirrors = (P, x, y, hw) => { for (const s of [-1, 1]) P.push(vp(box(0.1, 0.1, 0.16, x, y, s * (hw + 0.06)), TRIM, { rough: 0.4 })); };
  const PAINT = { paint: 1, rough: 0.26, metal: 0.5 };
  const VEHICLES = {
    sedan() {
      const P = [], hw = 0.905;
      loftBody({ x0: -2.36, x1: 2.37, hw, sill: 0.3, bumperLo: 0.24, wheels: [1.42, -1.42], arch: 0.43, wheelR: 0.34, tumble: 0.17, endR: 0.55, noseW: 0.76, tailW: 0.82,
        top: [[-2.36, 0.72], [-2.32, 0.92], [-2.1, 1.0], [-1.6, 1.03], [-1.05, 1.37], [-0.55, 1.44], [0.3, 1.45], [0.6, 1.41], [1.35, 0.98], [2.0, 0.86], [2.3, 0.77], [2.37, 0.6]],
        belt: [[-2.36, 1.0], [-1.6, 1.02], [1.35, 0.95], [2.37, 0.9]] }, P, PAINT);
      wheels(P, [1.42, -1.42], 0.34, 0.8); lights(P, 2.34, -2.34, 0.66, 0.86, 0.6, 0.62);
      P.push(vp(box(0.03, 0.14, 0.7, 2.37, 0.46, 0), TRIM, { rough: 0.5 })); mirrors(P, 1.2, 1.02, hw);
      P.push(vp(box(4.0, 0.02, 1.6, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 4.73 };
    },
    suv() {
      const P = [], hw = 0.965;
      loftBody({ x0: -2.43, x1: 2.43, hw, sill: 0.44, bumperLo: 0.34, wheels: [1.48, -1.5], arch: 0.47, wheelR: 0.38, tumble: 0.13, endR: 0.5, noseW: 0.8, tailW: 0.9,
        top: [[-2.43, 1.0], [-2.41, 1.52], [-2.3, 1.69], [-1.9, 1.73], [0.6, 1.73], [0.95, 1.66], [1.45, 1.12], [2.25, 1.02], [2.43, 0.85]],
        belt: [[-2.43, 1.18], [1.45, 1.1], [2.43, 1.05]] }, P, PAINT);
      wheels(P, [1.48, -1.5], 0.38, 0.85, 0.25); lights(P, 2.4, -2.41, 0.86, 1.2, 0.64, 0.68);
      P.push(vp(box(0.03, 0.26, 0.82, 2.44, 0.66, 0), TRIM, { rough: 0.5 })); mirrors(P, 1.3, 1.2, hw);
      P.push(vp(box(4.2, 0.02, 1.7, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 4.86 };
    },
    pickup() {
      const P = [], hw = 1.0;
      loftBody({ x0: -0.36, x1: 2.82, hw, sill: 0.48, bumperLo: 0.4, wheels: [1.75], arch: 0.5, wheelR: 0.4, tumble: 0.12, endR: 0.35, noseW: 0.86, tailW: 1.0,
        top: [[-0.36, 1.22], [-0.33, 1.78], [-0.2, 1.83], [1.15, 1.83], [1.72, 1.16], [2.6, 1.08], [2.82, 0.9]],
        belt: [[-0.36, 1.2], [1.72, 1.14], [2.82, 1.1]] }, P, PAINT);
      // cargo bed: side walls with an arch over the rear wheel, tailgate, floor
      const arch = []; for (let k = 0; k <= 10; k++) { const a = Math.PI - k * Math.PI / 10; arch.push([-1.85 + Math.cos(a) * 0.5, 0.4 + Math.sin(a) * 0.47]); }
      const side = [[-2.8, 0.52], [-2.35, 0.52], ...arch, [-0.4, 0.52], [-0.4, 1.14], [-2.8, 1.14]];
      P.push(vp(extrudeXY(side, 0.07, hw - 0.07), 0xffffff, PAINT)); P.push(vp(extrudeXY(side, 0.07, -hw), 0xffffff, PAINT));
      P.push(vp(box(0.07, 0.62, hw * 2, -2.8, 0.83, 0), 0xffffff, PAINT));
      P.push(vp(box(2.35, 0.05, hw * 2 - 0.14, -1.6, 0.62, 0), 0x2a2a2a, { rough: 0.9 }));
      P.push(vp(box(2.4, 0.2, hw * 1.7, -1.6, 0.5, 0), UNDER, { rough: 1 }));
      wheels(P, [1.75, -1.85], 0.4, 0.86, 0.27); lights(P, 2.8, -2.82, 0.9, 0.95, 0.66, 0.84, 0.3, 0.14);
      P.push(vp(box(0.05, 0.3, 0.9, 2.83, 0.78, 0), TRIM, { rough: 0.4, metal: 0.6 })); mirrors(P, 1.55, 1.25, hw);
      P.push(vp(box(4.8, 0.02, 1.8, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 5.62 };
    },
    van() {
      const P = [], hw = 1.0;
      loftBody({ x0: -2.66, x1: 2.66, hw, sill: 0.4, bumperLo: 0.32, wheels: [1.8, -1.75], arch: 0.46, wheelR: 0.37, tumble: 0.09, endR: 0.4, noseW: 0.82, tailW: 0.95, glassSlope: 0.6,
        top: [[-2.66, 1.0], [-2.64, 1.92], [-2.5, 2.04], [1.45, 2.05], [1.7, 1.96], [2.35, 1.3], [2.6, 1.12], [2.66, 0.9]],
        belt: [[-2.66, 1.28], [1.7, 1.26], [2.35, 1.22], [2.66, 1.1]] }, P, PAINT);
      wheels(P, [1.8, -1.75], 0.37, 0.86, 0.24); lights(P, 2.62, -2.64, 0.95, 1.15, 0.68, 0.74);
      P.push(vp(box(0.03, 0.2, 0.9, 2.67, 0.72, 0), TRIM, { rough: 0.5 })); mirrors(P, 1.9, 1.45, hw);
      P.push(vp(box(4.6, 0.02, 1.8, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 5.32 };
    },
    bus() {
      const P = [], hw = 1.275;
      P.push(vp(extrudeXY([[-6.1, 0.42], [6.0, 0.42], [6.1, 0.72], [6.08, 2.95], [5.9, 3.12], [-5.95, 3.12], [-6.1, 2.95]], hw * 2, -hw), 0xffffff, { paint: 1, rough: 0.4, metal: 0.2 }));
      P.push(vp(box(12.0, 0.9, hw * 2 + 0.01, 0, 2.7, 0), 0xeef0f2, { rough: 0.4, metal: 0.1 }));
      glassSides([[5.4, 1.35], [5.4, 2.5], [-5.6, 2.5], [-5.6, 1.35]], hw, P);
      P[P.length - 1] = vp(extrudeXY([[5.4, 1.35], [5.4, 2.5], [-5.6, 2.5], [-5.6, 1.35]], 0.02, -hw - 0.016), GLASS, { rough: 0.08, glow: 3 });
      P[P.length - 2] = vp(extrudeXY([[5.4, 1.35], [5.4, 2.5], [-5.6, 2.5], [-5.6, 1.35]], 0.02, hw - 0.004), GLASS, { rough: 0.08, glow: 3 });
      P.push(vp(box(0.03, 1.7, hw * 2 - 0.25, 6.1, 1.85, 0), GLASS, { rough: 0.06, glow: 3 }));
      P.push(vp(box(0.03, 0.22, 1.7, 6.1, 2.86, 0), 0x2a1a08, { glow: 4 }));
      wheels(P, [3.9, -3.4], 0.5, 1.05, 0.3); lights(P, 6.1, -6.12, 0.7, 0.9, 1.0, 1.05);
      P.push(vp(box(11.5, 0.02, 2.3, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 12.2 };
    },
    truck() {
      const P = [], hw = 1.22;
      P.push(vp(extrudeXY([[2.2, 0.48], [3.75, 0.48], [3.82, 0.9], [3.75, 1.5], [3.3, 2.5], [2.2, 2.55]], hw * 2, -hw), 0xffffff, { paint: 1, rough: 0.35, metal: 0.3 }));
      P.push(vp(box(6.0, 2.45, hw * 2 + 0.04, -0.9, 2.12, 0), 0xe9e9e6, { rough: 0.6 }));
      P.push(vp(box(7.4, 0.25, 1.9, -0.1, 0.62, 0), 0x2b2b2b, { rough: 0.8 }));
      glassSides([[3.7, 1.52], [3.28, 2.42], [2.5, 2.44], [2.5, 1.52]], hw, P);
      glassOnSegment(3.76, 1.52, 3.31, 2.46, hw - 0.1, P);
      wheels(P, [2.9, -1.6, -2.75], 0.48, 1.02, 0.3); lights(P, 3.8, -3.92, 0.95, 0.75, 0.9, 1.0);
      P.push(vp(box(7.0, 0.02, 2.2, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 7.6 };
    },
  };
  function wheelsLo(parts, xs, r, halfTrack, w = 0.22) {     // far LOD: plain cylinders
    for (const x of xs) for (const s of [-1, 1]) {
      const t = new THREE.CylinderGeometry(r, r, w, 10); t.rotateX(Math.PI / 2); t.translate(x, r, s * halfTrack); parts.push(vp(t, TIRE, { rough: 0.9 }));
      const h = new THREE.CylinderGeometry(r * 0.6, r * 0.6, w + 0.012, 8); h.rotateX(Math.PI / 2); h.translate(x, r, s * halfTrack); parts.push(vp(h, RIM, { rough: 0.3, metal: 0.8 }));
    }
  }
  // far LOD for the lofted types: the simple extruded bodies (a quarter of the triangles), swapped in beyond LOD_R
  const VEHICLES_LO = {
    sedan() {
      const P = [], hw = 0.91;
      P.push(vp(extrudeXY([[-2.35, 0.3], [2.3, 0.3], [2.37, 0.5], [2.3, 0.72], [1.25, 0.86], [0.5, 1.36], [-0.85, 1.4], [-1.75, 0.97], [-2.33, 0.9], [-2.38, 0.52]], hw * 2, -hw), 0xffffff, { paint: 1, rough: 0.28, metal: 0.45 }));
      glassSides([[1.17, 0.9], [0.52, 1.32], [-0.83, 1.35], [-1.66, 0.97]], hw, P);
      glassOnSegment(1.24, 0.87, 0.51, 1.35, hw - 0.1, P); glassOnSegment(-0.86, 1.38, -1.74, 0.98, hw - 0.12, P);
      wheelsLo(P, [1.42, -1.42], 0.34, 0.8); lights(P, 2.33, -2.36, 0.63, 0.8, 0.6, 0.58);
      P.push(vp(box(0.03, 0.12, 0.72, 2.36, 0.45, 0), TRIM, { rough: 0.5 }));
      P.push(vp(box(4.0, 0.02, 1.6, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 4.7 };
    },
    suv() {
      const P = [], hw = 0.965;
      P.push(vp(extrudeXY([[-2.42, 0.36], [2.36, 0.36], [2.43, 0.62], [2.36, 0.98], [1.5, 1.06], [0.95, 1.68], [-2.15, 1.72], [-2.4, 1.58], [-2.44, 0.62]], hw * 2, -hw), 0xffffff, { paint: 1, rough: 0.3, metal: 0.4 }));
      glassSides([[1.42, 1.1], [0.95, 1.62], [-2.05, 1.65], [-2.3, 1.52], [-2.31, 1.12]], hw, P);
      glassOnSegment(1.49, 1.08, 0.96, 1.66, hw - 0.1, P); glassOnSegment(-2.17, 1.7, -2.39, 1.57, hw - 0.14, P);
      wheelsLo(P, [1.48, -1.5], 0.38, 0.85, 0.25); lights(P, 2.41, -2.43, 0.8, 1.2, 0.64, 0.66);
      P.push(vp(box(0.03, 0.2, 0.8, 2.44, 0.6, 0), TRIM, { rough: 0.5 }));
      P.push(vp(box(4.2, 0.02, 1.7, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 4.85 };
    },
    pickup() {
      const P = [], hw = 1.0;
      P.push(vp(extrudeXY([[-0.35, 0.4], [2.75, 0.4], [2.82, 0.7], [2.72, 1.05], [1.7, 1.12], [1.18, 1.8], [-0.3, 1.83], [-0.35, 1.2]], hw * 2, -hw), 0xffffff, { paint: 1, rough: 0.32, metal: 0.4 }));
      P.push(vp(extrudeXY([[-2.8, 0.4], [-0.35, 0.4], [-0.35, 1.12], [-2.8, 1.12]], hw * 2, -hw), 0xffffff, { paint: 1, rough: 0.32, metal: 0.4 }));
      P.push(vp(box(2.3, 0.03, 1.76, -1.58, 1.12, 0), 0x2a2a2a, { rough: 0.9 }));
      glassSides([[1.62, 1.16], [1.16, 1.74], [-0.24, 1.76], [-0.26, 1.18]], hw, P);
      glassOnSegment(1.69, 1.14, 1.19, 1.78, hw - 0.1, P);
      wheelsLo(P, [1.75, -1.85], 0.4, 0.86, 0.27); lights(P, 2.8, -2.82, 0.86, 0.92, 0.66, 0.7, 0.3, 0.22);
      P.push(vp(box(4.8, 0.02, 1.8, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 5.6 };
    },
    van() {
      const P = [], hw = 1.0;
      P.push(vp(extrudeXY([[-2.65, 0.36], [2.55, 0.36], [2.66, 0.75], [2.4, 1.2], [1.7, 1.98], [-2.6, 2.05], [-2.66, 0.75]], hw * 2, -hw), 0xffffff, { paint: 1, rough: 0.35, metal: 0.3 }));
      glassSides([[1.62, 1.28], [1.56, 1.88], [-1.8, 1.9], [-1.8, 1.28]], hw, P);
      glassOnSegment(2.38, 1.24, 1.71, 1.95, hw - 0.1, P);
      wheelsLo(P, [1.8, -1.75], 0.37, 0.86, 0.24); lights(P, 2.62, -2.67, 0.9, 1.1, 0.68, 0.72);
      P.push(vp(box(4.6, 0.02, 1.8, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 5.3 };
    },
  };
  const CAR_PAINT = [[0xeceeef, 22], [0x16181b, 18], [0x6d7277, 15], [0xaeb3b8, 14], [0x2c4f82, 8], [0x9e1b1b, 7], [0x1f2c44, 4],
    [0x3c5a44, 2], [0xb9a98a, 2], [0xc46a2c, 1], [0x2a6f78, 2], [0x5b2a3a, 1], [0xd8c24a, 1], [0x3b3b41, 3]];
  const BUS_PAINT = [0x1f4e8c, 0xb32d2a, 0x2f7d4a, 0x1b7f86, 0x2a3b5c];
  const VEH_TYPES = ['sedan', 'suv', 'pickup', 'van', 'bus', 'truck'];
  const vehCache = {};
  const vehModel = t => vehCache[t] || (vehCache[t] = withLamps(VEHICLES[t]));
  const vehCacheLo = {};
  const vehModelLo = t => VEHICLES_LO[t] ? (vehCacheLo[t] || (vehCacheLo[t] = withLamps(VEHICLES_LO[t]))) : null;
  const VEH_LOD_R = 110;            // metres: detailed bodies inside, simple ones beyond

  function toPts(p) {
    if (p instanceof Float32Array || p instanceof Float64Array) return p;
    if (Array.isArray(p) && p.length && typeof p[0] === 'number') return Float64Array.from(p);
    const a = new Float64Array(p.length * 3); p.forEach((q, i) => { if (Array.isArray(q)) { a[i * 3] = q[0]; a[i * 3 + 1] = q[1]; a[i * 3 + 2] = q[2]; } else { a[i * 3] = q.x; a[i * 3 + 1] = q.y; a[i * 3 + 2] = q.z; } });
    return a;
  }
  function offsetLane(src, off, reverse, ax, ay, az) {
    const n = src.length / 3; const out = new Float32Array(n * 3);
    const P = i => { const k = reverse ? n - 1 - i : i; return [src[k * 3] - ax, src[k * 3 + 1] - ay, src[k * 3 + 2] - az]; };
    for (let i = 0; i < n; i++) {
      const p = P(i), a = P(Math.max(0, i - 1)), b = P(Math.min(n - 1, i + 1));
      let nx = 0, nz = 0, cnt = 0;
      const addSeg = (u, v) => { const dx = v[0] - u[0], dz = v[2] - u[2], l = Math.hypot(dx, dz); if (l > 1e-6) { nx += -dz / l; nz += dx / l; cnt++; } };
      if (i > 0) addSeg(a, p); if (i < n - 1) addSeg(p, b);
      const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
      let miter = 1;
      if (i > 0 && i < n - 1) { const dx = b[0] - p[0], dz = b[2] - p[2], L = Math.hypot(dx, dz) || 1; const d = nx * (-dz / L) + nz * (dx / L); miter = 1 / Math.max(0.5, d); }
      out[i * 3] = p[0] + nx * off * miter; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2] + nz * off * miter;
    }
    return out;
  }

  // roads: [{ pts: Float32Array|number[]|[{x,y,z}] (world xyz), lanes (total, both directions), speed (m/s), oneway, bus }]
  function createTraffic(roads = [], opts = {}) {
    if (!roadMat) roadMat = vehicleMaterial(0);
    const r = U.rng((opts.seed || 7) * 1013);
    const laneW = opts.laneWidth || 3.5, maxCars = opts.maxCars || 600, density = opts.density || 11;
    const typeW = Object.assign({ sedan: 46, suv: 30, pickup: 8, van: 7, bus: 3, truck: 6 }, opts.typeWeights || {});
    const group = new THREE.Group(); group.name = 'traffic';
    // one instanced mesh per vehicle type; each can hold every car so re-streaming roads never reallocates
    const meshes = {};
    // (near: the detailed model; far: its light LOD where one exists) - instances are packed every frame
    const mkMesh = (model, name) => {
      const base = model.geo; const geo = new THREE.BufferGeometry();
      for (const k of Object.keys(base.attributes)) geo.setAttribute(k, base.attributes[k]);
      if (!base.boundingSphere) base.computeBoundingSphere();
      geo.boundingSphere = base.boundingSphere.clone();
      const inst = new THREE.InstancedBufferAttribute(new Float32Array(maxCars * 4), 4); inst.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aInst', inst);
      const mesh = new THREE.InstancedMesh(geo, roadMat.m, maxCars); mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.customDepthMaterial = roadMat.d; mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = name; mesh.count = 0;
      mesh.boundingSphere = new THREE.Sphere(new V3(), 1);
      const flare = flaresFor(mesh, inst, model.lamps, 0, maxCars); flare.visible = false;
      group.add(mesh, flare);
      return { mesh, inst, flare };
    };
    for (const t of VEH_TYPES) {
      const M = mkMesh(vehModel(t), 'traffic-' + t), lo = vehModelLo(t);
      if (lo) M.lo = mkMesh(lo, 'traffic-' + t + '-far');
      meshes[t] = M;
    }
    // night: soft pools of headlight on the road ahead of each car (one additive instanced quad each)
    let pools = null;
    if (opts.lightPools !== false) {
      const tex = U.canvasTexture(64, 64, (ctx, w, h) => { const g = ctx.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
        g.addColorStop(0, 'rgba(255,240,210,0.9)'); g.addColorStop(0.5, 'rgba(255,225,180,0.35)'); g.addColorStop(1, 'rgba(255,220,170,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); });
      const pm = new THREE.MeshBasicMaterial({ map: tex, color: 0xffe2b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
      const pg = new THREE.PlaneGeometry(1, 1); pg.rotateX(-Math.PI / 2);
      pools = new THREE.InstancedMesh(pg, pm, maxCars); pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage); pools.frustumCulled = false; pools.name = 'traffic-lightpools';
      pools.renderOrder = 2; pools.count = 0; group.add(pools); pools.visible = false;
    }
    let lanes = [], cars = [];
    function setRoads(list) {
      const R = (list || []).map(rd => (rd && rd.pts ? { ...rd, pts: toPts(rd.pts) } : { pts: toPts(rd) })).filter(rd => rd.pts.length >= 6);
      let sx = 0, sy = 0, sz = 0, sn = 0;
      for (const rd of R) for (let i = 0; i < rd.pts.length; i += 3) { sx += rd.pts[i]; sy += rd.pts[i + 1]; sz += rd.pts[i + 2]; sn++; }
      const ax = Math.round(sx / Math.max(1, sn)), ay = Math.round(sy / Math.max(1, sn)), az = Math.round(sz / Math.max(1, sn));
      group.position.set(ax, ay, az); group.updateMatrixWorld();
      lanes = []; cars = [];
      const box3 = new THREE.Box3();
      for (const rd of R) {
        const total = Math.max(1, rd.lanes || 2), speed = rd.speed || 13.4, oneway = !!rd.oneway;
        const dirs = oneway ? [false] : [false, true], perDir = oneway ? total : Math.max(1, Math.round(total / 2));
        for (const rev of dirs) for (let j = 0; j < perDir; j++) {
          const off = oneway ? (j - (perDir - 1) / 2) * laneW : (j + 0.5) * laneW;
          const pts = offsetLane(rd.pts, off, rev, ax, ay, az); const n = pts.length / 3; const cum = new Float32Array(n);
          for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
          if (cum[n - 1] < 20) continue;
          for (let i = 0; i < n; i++) box3.expandByPoint(_v.set(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]));
          // fast outer lanes, slower curb lanes
          lanes.push({ pts, cum, len: cum[n - 1], speed: speed * (1 - 0.06 * (perDir - 1 - j) / Math.max(1, perDir - 1)), cars: [], fast: speed > 20, busOK: rd.bus !== false && speed < 20 });
        }
      }
      for (const t of VEH_TYPES) { meshes[t].mesh.count = 0; if (meshes[t].lo) meshes[t].lo.mesh.count = 0; }
      for (const lane of lanes) {
        const want = Math.min(Math.round(lane.len / 1000 * density * lerp(0.7, 1.3, r())), maxCars - cars.length);
        if (want <= 0) continue;
        for (let k = 0; k < want; k++) {
          const wts = VEH_TYPES.map(t => (t === 'bus' && !lane.busOK) ? 0 : t === 'truck' ? typeW[t] * (lane.fast ? 1.6 : 0.6) : typeW[t]);
          const type = VEH_TYPES[wpick(r, wts)], M = meshes[type];
          const paint = type === 'bus' ? pick(r, BUS_PAINT) : CAR_PAINT[wpick(r, CAR_PAINT.map(c => c[1]))][0];
          const v0 = lane.speed * lerp(0.86, 1.1, r()) * (type === 'truck' || type === 'bus' ? 0.9 : 1);
          const car = { lane, s: 0, v: v0 * 0.85, v0, type, len: vehModel(type).len, brake: 0, seg: 0, paint, phase: r() * 10 };
          cars.push(car); lane.cars.push(car);
        }
        // spread along the lane with irregular gaps; leader (largest s) first
        let s = lane.len * r();
        const gap = lane.len / lane.cars.length;
        for (const c of lane.cars) { c.s = ((s % lane.len) + lane.len) % lane.len; s -= gap * lerp(0.6, 1.4, r()); }
        lane.cars.sort((a, b) => b.s - a.s);
      }
      const sphere = box3.isEmpty() ? new THREE.Sphere(new V3(), 1) : box3.getBoundingSphere(new THREE.Sphere());
      sphere.radius += 12;
      for (const t of VEH_TYPES) { meshes[t].mesh.boundingSphere.copy(sphere); if (meshes[t].lo) meshes[t].lo.mesh.boundingSphere.copy(sphere); }
      traffic.update(0.001);
    }
    function locate(lane, s, car) { // position at distance s along lane (car.seg caches the segment)
      const cum = lane.cum, n = cum.length; let i = car.seg;
      if (i >= n - 1 || cum[i] > s) i = 0;
      while (i < n - 2 && cum[i + 1] < s) i++;
      car.seg = i;
      const t = clamp((s - cum[i]) / Math.max(1e-6, cum[i + 1] - cum[i]), 0, 1), p = lane.pts;
      return pos.set(lerp(p[i * 3], p[i * 3 + 3], t), lerp(p[i * 3 + 1], p[i * 3 + 4], t), lerp(p[i * 3 + 2], p[i * 3 + 5], t));
    }
    function pointAt(lane, s, out) {
      const cum = lane.cum; let lo = 0, hi = cum.length - 1; s = clamp(s, 0, lane.len);
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
      const t = (s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]), p = lane.pts;
      return out.set(lerp(p[lo * 3], p[hi * 3], t), lerp(p[lo * 3 + 1], p[hi * 3 + 1], t), lerp(p[lo * 3 + 2], p[hi * 3 + 2], t));
    }
    const ahead = new V3(), behind = new V3(), pos = new V3();
    const A = 1.6, B = 2.8, S0 = 2.5, T = 1.25, SQ = 2 * Math.sqrt(A * B);
    const traffic = {
      group, meshes, setRoads,
      get cars() { return cars; }, get lanes() { return lanes; }, get count() { return cars.length; },
      update(dt = 1 / 60, env = {}) {
        dt = Math.min(dt, 0.1);
        const night = env.night !== undefined ? env.night : U.uNight.value;
        const steps = dt > 0.05 ? 2 : 1, h = dt / steps;
        for (let st = 0; st < steps; st++) for (const lane of lanes) {
          const cs = lane.cars; const n = cs.length;
          for (let k = 0; k < n; k++) {  // intelligent driver model, following the car ahead in the same lane
            const c = cs[k], lead = k > 0 ? cs[k - 1] : null;
            const gap = lead ? lead.s - lead.len - c.s : 1e9, dv = lead ? c.v - lead.v : 0;
            const sStar = S0 + Math.max(0, c.v * T + c.v * dv / SQ);
            const vr = c.v / c.v0, sr = sStar / Math.max(gap, 0.5);
            const acc = clamp(A * (1 - vr * vr * vr * vr - sr * sr), -8, A);
            c.v = Math.max(0, c.v + acc * h); c.s += c.v * h;
            c.brake += ((acc < -1.2 ? 1 : 0) - c.brake) * Math.min(1, h * 6);
          }
          // cars that drove off the end re-enter at the start, behind the last car of the lane
          while (cs.length && cs[0].s > lane.len) {
            const c = cs.shift(); const last = cs.length ? cs[cs.length - 1] : null;
            c.s = Math.min(0, last ? last.s - c.len - 12 - r() * 30 : 0); c.v = c.v0 * 0.9; c.seg = 0; cs.push(c);
          }
        }
        let pi = 0; const lit = night > 0.05 && pools;
        // camera in the group's frame: detailed bodies within VEH_LOD_R, light ones beyond; cars that are fading
        // in or out at a lane end are simply not drawn, so neither mesh spends vertices on hidden instances
        const cp = env.camPos, lx = cp ? cp.x - group.position.x : 0, lz = cp ? cp.z - group.position.z : 0, lod2 = VEH_LOD_R * VEH_LOD_R;
        for (const t of VEH_TYPES) { const M = meshes[t]; M.n = 0; if (M.lo) M.lo.n = 0; }
        for (let i = 0; i < cars.length; i++) {
          const c = cars[i], M = meshes[c.type], lane = c.lane;
          const fade = clamp(c.s / 6, 0, 1) * clamp((lane.len - c.s) / 6, 0, 1);
          if (fade <= 0) continue;
          locate(lane, c.s, c);
          pointAt(lane, c.s + 2.5, ahead); pointAt(lane, c.s - 2.5, behind);
          const dx = ahead.x - behind.x, dz = ahead.z - behind.z, dy = ahead.y - behind.y;
          const yaw = Math.atan2(-dz, dx), pitch = Math.atan2(dy, Math.hypot(dx, dz));
          _e.set(0, yaw, pitch, 'YZX'); _q.setFromEuler(_e); _s.set(fade, fade, fade);
          const m = M.lo && cp && (pos.x - lx) ** 2 + (pos.z - lz) ** 2 > lod2 ? M.lo : M, k = m.n++;
          _m.compose(pos, _q, _s); m.mesh.setMatrixAt(k, _m);
          m.inst.setXYZW(k, c.paint, c.brake, 0, c.phase);
          if (lit) {
            _v2.set(Math.cos(yaw), 0, -Math.sin(yaw)).multiplyScalar(c.len * 0.5 + 6).add(pos); _v2.y += 0.08;
            _q.setFromAxisAngle(_up, yaw); _s.set(11 * fade, 1, 5.5 * fade); _m.compose(_v2, _q, _s); pools.setMatrixAt(pi++, _m);
          }
        }
        for (const t of VEH_TYPES) for (const m of meshes[t].lo ? [meshes[t], meshes[t].lo] : [meshes[t]]) {
          m.mesh.count = m.n; if (m.n) { m.mesh.instanceMatrix.needsUpdate = true; m.inst.needsUpdate = true; }
          m.flare.count = m.n; m.flare.visible = night > 0.03 && m.n > 0; }
        if (pools) { pools.visible = !!lit && pi > 0; pools.count = pi; if (lit) { pools.material.opacity = 0.5 * sstep(0.05, 0.6, night); pools.instanceMatrix.needsUpdate = true; } }
      },
    };
    setRoads(roads);
    return traffic;
  }

  // ==========================================================================================
  // AIRCRAFT
  // ==========================================================================================
  const WHITE = 0xf2f4f6, BELLY = 0xbfc4ca, WING = 0xc9ced4, DARKG = 0x2b2f35, ENG = 0xd9dde2;
  function airlinerGeo(o) {
    const P = []; const R = o.r, L0 = o.x0, L1 = o.x1;
    const fus = cylX(R, R, L0, L1, 14); { // belly shading by vertex height
      const g = vp(fus, WHITE, { rough: 0.35, metal: 0.2 }); const c = g.attributes.aCol, p = g.attributes.position; const b = lin(BELLY);
      for (let i = 0; i < p.count; i++) if (p.getY(i) < -0.35 * R) c.setXYZ(i, b.r, b.g, b.b);
      P.push(g); }
    { const n = sph(R, 14, 8, 0, 0, 0, 1, 1, 1, Math.PI / 2); n.rotateZ(-Math.PI / 2); n.scale(o.nose / R, 1, 1); n.translate(L1, 0, 0); P.push(vp(n, WHITE, { rough: 0.35, metal: 0.2 })); }
    { const t = cylX(R * 0.25, R, L0 - o.tail, L0, 14); const p = t.attributes.position;
      for (let i = 0; i < p.count; i++) { const x = p.getX(i); if (x < L0) p.setY(i, p.getY(i) + (L0 - x) / o.tail * R * 0.55); }
      t.computeVertexNormals(); P.push(vp(t, WHITE, { rough: 0.35, metal: 0.2 })); }
    // window band and cockpit windows
    const wy = R * 0.34, wz = Math.sqrt(R * R - wy * wy) + 0.01;
    for (const s of [-1, 1]) P.push(vp(box(L1 - L0 - 4, R * 0.14, 0.04, (L0 + L1) / 2 - 1, wy, s * wz), DARKG, { rough: 0.2, glow: 7 }));
    for (const s of [-1, 1]) P.push(vp(box(o.nose * 0.35, R * 0.22, 0.05, L1 + o.nose * 0.28, R * 0.4, s * R * 0.52, -0.25), DARKG, { rough: 0.1 }));
    // wings
    const y0 = -R * 0.55;
    for (const s of [-1, 1]) {
      const rl = v3(o.wx + o.chord * 0.5, y0, s * R * 0.8), rt = v3(o.wx - o.chord * 0.5, y0, s * R * 0.8);
      const tl = v3(o.wx - o.sweep + o.tipChord * 0.5, y0 + o.dih, s * o.span / 2), tt = v3(o.wx - o.sweep - o.tipChord * 0.5, y0 + o.dih, s * o.span / 2);
      const th = o.chord * 0.07, tt2 = o.tipChord * 0.06;
      P.push(vp(slab([rl.clone().setY(rl.y + th), rt.clone().setY(rt.y + th), tt.clone().setY(tt.y + tt2), tl.clone().setY(tl.y + tt2),
        rl.clone().setY(rl.y - th), rt.clone().setY(rt.y - th), tt.clone().setY(tt.y - tt2), tl.clone().setY(tl.y - tt2)]), WING, { rough: 0.4, metal: 0.4 }));
      // winglet
      const wl = v3(tl.x - 0.2, tl.y, tl.z), wt = v3(tt.x, tt.y, tt.z);
      P.push(vp(slab([wl, wt, v3(wt.x - 0.6, wt.y + o.winglet, wt.z), v3(wl.x - 0.9, wl.y + o.winglet, wl.z),
        v3(wl.x, wl.y, wl.z + s * 0.12), v3(wt.x, wt.y, wt.z + s * 0.12), v3(wt.x - 0.6, wt.y + o.winglet, wt.z + s * 0.1), v3(wl.x - 0.9, wl.y + o.winglet, wl.z + s * 0.1)]), WHITE, { paint: 1, rough: 0.35 }));
      // engines
      for (const ez of o.engines) {
        const f = (ez - R * 0.8) / (o.span / 2 - R * 0.8), le = lerp(rl.x, tl.x, f);   // wing leading edge at the engine station
        const x = le + o.el * 0.55, z = s * ez, y = y0 + o.dih * f - o.er * 0.95;
        P.push(vp(cylX(o.er * 0.92, o.er, x - o.el, x, 12, y, z), ENG, { rough: 0.3, metal: 0.4 }));
        P.push(vp(cylX(o.er * 0.8, o.er * 0.8, x - 0.02, x + 0.02, 12, y, z), 0x15171a, { rough: 0.6 }));
        P.push(vp(cylX(o.er * 0.35, o.er * 0.7, x - o.el - 1.2, x - o.el, 10, y, z), 0x4a4e55, { rough: 0.5, metal: 0.6 }));
        P.push(vp(box(o.el * 0.8, o.er * 0.9, 0.35, x - o.el * 0.45, y + o.er * 0.9, z), WING, { rough: 0.4 }));
      }
      // lights
      P.push(vp(box(0.3, 0.3, 0.3, tl.x - 0.3, tl.y + 0.1, tl.z + s * 0.1), s < 0 ? 0x550000 : 0x004400, { glow: s < 0 ? 2 : 3 }));
      P.push(vp(box(0.25, 0.25, 0.25, tt.x + 0.1, tt.y + 0.1, tt.z), 0xdddddd, { glow: 5 }));
      P.push(vp(box(0.4, 0.3, 0.3, o.wx + o.chord * 0.52, y0 - 0.1, s * (R + 1.2)), 0xdddddd, { glow: 1 }));
      lamp([tl.x - 0.3, tl.y + 0.1, tl.z + s * 0.3], s < 0 ? 1 : 2, 0.9); lamp([tt.x + 0.1, tt.y + 0.1, tt.z + s * 0.2], 4, 2.2);
      lamp([o.wx + o.chord * 0.56, y0 - 0.1, s * (R + 1.2)], 0, 1.1 * R);
    }
    // horizontal stabilizer + fin
    for (const s of [-1, 1]) {
      const hx = L0 - o.tail * 0.55, hy = R * 0.35;
      P.push(vp(slab([v3(hx + o.hChord * 0.5, hy + 0.15, s * R * 0.3), v3(hx - o.hChord * 0.5, hy + 0.15, s * R * 0.3), v3(hx - o.hSweep - o.hChord * 0.25, hy + 0.5, s * o.hSpan / 2), v3(hx - o.hSweep + o.hChord * 0.2, hy + 0.5, s * o.hSpan / 2),
        v3(hx + o.hChord * 0.5, hy - 0.15, s * R * 0.3), v3(hx - o.hChord * 0.5, hy - 0.15, s * R * 0.3), v3(hx - o.hSweep - o.hChord * 0.25, hy + 0.35, s * o.hSpan / 2), v3(hx - o.hSweep + o.hChord * 0.2, hy + 0.35, s * o.hSpan / 2)]), WHITE, { rough: 0.4 }));
    }
    const fx = L0 - o.tail * 0.35, fy = R * 0.6;
    P.push(vp(slab([v3(fx + o.fChord * 0.4, fy, -0.25), v3(fx - o.fChord * 0.6, fy + 0.3, -0.25), v3(fx - o.fChord * 0.6 - o.fSweep, fy + o.finH, -0.12), v3(fx - o.fSweep + 0.2, fy + o.finH, -0.12),
      v3(fx + o.fChord * 0.4, fy, 0.25), v3(fx - o.fChord * 0.6, fy + 0.3, 0.25), v3(fx - o.fChord * 0.6 - o.fSweep, fy + o.finH, 0.12), v3(fx - o.fSweep + 0.2, fy + o.finH, 0.12)]), WHITE, { paint: 1, rough: 0.35 }));
    P.push(vp(box(0.3, 0.3, 0.3, L0 - o.tail - 0.2, R * 0.55 + 0.2, 0), 0xdddddd, { glow: 4 }));
    lamp([L0 - o.tail - 0.4, R * 0.55 + 0.2, 0], 3, 0.9); lamp([(L0 + L1) * 0.45, R + 0.3, 0], 5, 1.4); lamp([(L0 + L1) * 0.45, -R - 0.3, 0], 5, 1.4);
    P.push(vp(box(0.5, 0.2, 0.4, (L0 + L1) * 0.45, R + 0.1, 0), 0x440000, { glow: 6 }));
    P.push(vp(box(0.5, 0.2, 0.4, (L0 + L1) * 0.45, -R - 0.1, 0), 0x440000, { glow: 6 }));
    // landing gear (collapsed in the shader when retracted)
    const gy = -R, gh = o.gearH - R;
    P.push(vp(box(0.25, gh, 0.25, L1 - 2.5, gy - gh / 2, 0), 0x7c8187, { gear: 1, metal: 0.6, rough: 0.4 }));
    { const w = new THREE.CylinderGeometry(0.45, 0.45, 0.5, 10); w.rotateX(Math.PI / 2); w.translate(L1 - 2.5, -o.gearH + 0.45, 0); P.push(vp(w, TIRE, { gear: 1, rough: 0.9 })); }
    P.push(vp(box(0.35, 0.3, 0.3, L1 - 2.3, gy - gh * 0.3, 0), 0xdddddd, { gear: 1, glow: 1 }));
    lamp([L1 - 2.1, gy - gh * 0.3, 0], 6, 1.6);
    for (const s of [-1, 1]) {
      const mx = o.wx - o.chord * 0.2, mz = s * R * 0.75;
      P.push(vp(box(0.35, gh, 0.35, mx, gy - gh / 2, mz), 0x7c8187, { gear: 1, metal: 0.6, rough: 0.4 }));
      for (const dx of o.wide ? [-1.4, 0, 1.4] : [-0.6, 0.6]) { const w = new THREE.CylinderGeometry(0.62, 0.62, 0.9, 10); w.rotateX(Math.PI / 2); w.translate(mx + dx, -o.gearH + 0.62, mz); P.push(vp(w, TIRE, { gear: 1, rough: 0.9 })); }
    }
    return U.mergeGeometries(P);
  }
  const PLANES = {
    narrow: () => ({ geo: airlinerGeo({ r: 1.98, x0: -13, x1: 15.5, nose: 3.2, tail: 6.5, wx: 0.5, chord: 6.2, tipChord: 1.6, sweep: 9.5, sweepAng: 25 * DEG, span: 35.8, dih: 1.4, winglet: 2.2,
      engines: [5.9], er: 1.02, el: 4.3, hChord: 3.2, hSweep: 3.2, hSpan: 13, fChord: 5.5, fSweep: 4.2, finH: 6.6, gearH: 3.45, wide: false }), gearH: 3.45 }),
    wide: () => ({ geo: airlinerGeo({ r: 3.1, x0: -24, x1: 29, nose: 5.2, tail: 11, wx: 2, chord: 11, tipChord: 2.6, sweep: 17, sweepAng: 31 * DEG, span: 61, dih: 2.5, winglet: 0.2,
      engines: [9.7], er: 1.75, el: 7, hChord: 5.2, hSweep: 6, hSpan: 21, fChord: 8.5, fSweep: 7, finH: 11.5, gearH: 5.2, wide: true }), gearH: 5.2 }),
    cessna: () => {
      const P = [];
      P.push(vp(cylX(0.62, 0.7, -0.6, 1.9, 8, 0.05), WHITE, { rough: 0.35 }));
      { const t = cylX(0.18, 0.62, -4.2, -0.6, 8, 0.05); const p = t.attributes.position; for (let i = 0; i < p.count; i++) if (p.getX(i) < -0.6) p.setY(i, p.getY(i) + (-0.6 - p.getX(i)) * 0.09); t.computeVertexNormals(); P.push(vp(t, WHITE, { rough: 0.35 })); }
      P.push(vp(cylX(0.55, 0.3, 1.9, 3.0, 8, -0.05), WHITE, { rough: 0.35 }));
      for (const s of [-1, 1]) P.push(vp(box(1.6, 0.35, 0.03, 0.9, 0.35, s * 0.66), DARKG, { rough: 0.1 }));
      P.push(vp(box(1.5, 0.12, 11, 1.0, 0.95, 0), WHITE, { rough: 0.4 }));
      P.push(vp(box(1.45, 0.02, 11, 1.0, 0.9, 0), 0xffffff, { paint: 1, rough: 0.4 }));
      for (const s of [-1, 1]) P.push(vp(seg3(v3(0.6, -0.45, s * 0.6), v3(1.1, 0.9, s * 2.6), 0.04, 0.04, 4), 0xbbbbbb, { rough: 0.5 }));
      P.push(vp(box(1.0, 0.07, 3.4, -3.9, 0.35, 0), WHITE, { rough: 0.4 }));
      P.push(vp(slab([v3(-3.2, 0.35, -0.06), v3(-4.3, 0.35, -0.06), v3(-4.5, 1.7, -0.04), v3(-3.9, 1.7, -0.04), v3(-3.2, 0.35, 0.06), v3(-4.3, 0.35, 0.06), v3(-4.5, 1.7, 0.04), v3(-3.9, 1.7, 0.04)]), WHITE, { paint: 1, rough: 0.4 }));
      P.push(vp(cylX(0.95, 0.95, 3.02, 3.05, 12, -0.05), 0x222222, { rough: 0.8 }));
      for (const [x, z] of [[2.2, 0], [0.4, -1.1], [0.4, 1.1]]) { const w = new THREE.CylinderGeometry(0.2, 0.2, 0.12, 8); w.rotateX(Math.PI / 2); w.translate(x, -0.95, z); P.push(vp(w, TIRE, { rough: 0.9 })); P.push(vp(seg3(v3(x, -0.95, z), v3(x * 0.8, -0.45, z * 0.5), 0.03, 0.03, 4), 0x999999, { rough: 0.5 })); }
      for (const s of [-1, 1]) { P.push(vp(box(0.2, 0.15, 0.15, 1.1, 0.95, s * 5.5), s < 0 ? 0x550000 : 0x004400, { glow: s < 0 ? 2 : 3 })); lamp([1.1, 0.95, s * 5.6], s < 0 ? 1 : 2, 0.45); }
      P.push(vp(box(0.2, 0.15, 0.2, 1.8, 0.95, -1.3), 0xdddddd, { glow: 1 })); lamp([1.95, 0.95, -1.3], 0, 0.9);
      P.push(vp(box(0.2, 0.2, 0.2, -4.4, 1.75, 0), 0x440000, { glow: 6 })); lamp([-4.4, 1.9, 0], 5, 0.6);
      return { geo: U.mergeGeometries(P), gearH: 1.15 };
    },
  };
  const planeCache = {}; const planeModel = t => planeCache[t] || (planeCache[t] = withLamps(PLANES[t]));
  const TAIL_COLORS = [0x1d3b75, 0xb3202a, 0x0f6f73, 0x203a5c, 0xe07a1f, 0x2a6ab0, 0x6a1f5c, 0x0b4f3a, 0x8a1c1c, 0x1f7a3f, 0x13294b, 0x3a3f8f, 0xd9a21b];

  // Runways (OpenStreetMap aeroway=runway geometry). start = where a landing aircraft crosses the
  // threshold / a departing aircraft begins its roll; end = far end. elev = field elevation (m).
  const RUNWAYS = {
    sfo28L: { start: [37.611712, -122.358362], end: [37.626281, -122.393094], elev: 4 },
    sfo28R: { start: [37.613522, -122.357127], end: [37.628738, -122.393396], elev: 4 },
    sfo01L: { start: [37.607825, -122.383004], end: [37.626502, -122.370619], elev: 4 },
    sfo01R: { start: [37.606343, -122.381069], end: [37.627324, -122.367139], elev: 4 },
    sjc30L: { start: [37.350985, -121.917069], end: [37.373735, -121.942006], elev: 18 },
    sjc30R: { start: [37.352255, -121.915256], end: [37.375000, -121.940191], elev: 18 },
    pao31: { start: [37.458517, -122.112479], end: [37.463717, -122.117634], elev: 2 },
    sql30: { start: [37.509216, -122.246547], end: [37.514481, -122.252505], elev: 2 },
  };
  // Build a flight template in runway-local coordinates: u along the runway from start, w to the right,
  // h above the field. Samples every 0.5 s: [t, u, w, h, yaw(local, + = right turn), pitch, roll, gear, lights, scale]
  function simTemplate(steps) {
    const S = []; let t = 0, u = 0, w = 0, h = 0, yaw = 0, pitch = 0, roll = 0, v = 0;
    const st = { gear: 1, lights: 1, scale: 1 };
    const push = () => S.push([t, u, w, h, yaw, pitch, roll, st.gear, st.lights, st.scale]);
    const dt = 0.5;
    for (const s of steps) {
      if (s.set) {
        Object.assign(st, s.set);
        if (s.at) { u = s.at.u ?? u; w = s.at.w ?? w; h = s.at.h ?? h; yaw = s.at.yaw ?? yaw; v = s.at.v ?? v; }
        if (!S.length) push();
        continue;
      }
      let dur = s.dur;
      if (s.untilU !== undefined) dur = Math.max(dt, (s.untilU - u) / Math.max(1, s.v1 ?? v));
      const n = Math.max(1, Math.round(dur / dt)); dur = n * dt;
      const v0 = v, v1 = s.v1 ?? v, p0 = pitch, p1 = s.pitch ?? pitch, r0 = roll, r1 = s.roll ?? 0, sc0 = st.scale, sc1 = s.scale ?? st.scale;
      for (let i = 0; i < n; i++) {
        const k = (i + 1) / n; v = lerp(v0, v1, k); pitch = lerp(p0, p1, sstep(0, 1, k)); roll = lerp(r0, r1, sstep(0, Math.min(1, 6 / dur), k));
        if (s.turn) yaw += s.turn * dt / dur;
        u += v * Math.cos(yaw) * dt; w += v * Math.sin(yaw) * dt;
        if (s.climb !== undefined) h += s.climb * dt;
        if (s.hTo !== undefined) h = lerp(s.hFrom, s.hTo, s.hEase ? sstep(0, 1, k) : k);
        st.scale = lerp(sc0, sc1, k);
        t += dt; push();
      }
      if (s.after) Object.assign(st, s.after);
    }
    return { S, dur: t };
  }
  // straight-in 3-degree approach from 24 km, flare, rollout, exit to the terminal side, fade on the taxiway
  function arrivalTemplate(exitU, exitSide) {
    const D0 = 24000, gs = Math.tan(3 * DEG), H0 = 15 + D0 * gs, H1 = 15 + 11000 * gs;
    return simTemplate([
      { set: { gear: 0, lights: 1, scale: 1 }, at: { u: -D0, w: 0, h: H0, yaw: 0, v: 80 } },
      { dur: (D0 - 11000) / 78, v1: 76, hFrom: H0, hTo: H1, pitch: 2.5 * DEG, after: { gear: 1 } },   // gear down ~11 km out
      { dur: 11000 / 73, v1: 70, hFrom: H1, hTo: 15, pitch: 2.8 * DEG },
      { dur: 420 / 69, v1: 68, hFrom: 15, hTo: 0, hEase: true, pitch: 5.5 * DEG },                    // flare, touchdown ~400 m in
      { dur: 3.5, v1: 60, pitch: 0 },
      { dur: (60 - 13) / 2.1, v1: 13 },                                                               // braking
      { untilU: exitU, v1: 12 },
      { dur: 9, v1: 9, turn: exitSide * Math.PI / 2 },
      { dur: 25, v1: 8 },
      { dur: 6, v1: 6, scale: 0 },
    ]);
  }
  // hold, roll, rotate at ~150 kt, climb out and turn on course, fade in the distance
  function departureTemplate(turnDeg) {
    return simTemplate([
      { set: { gear: 1, lights: 1, scale: 0 }, at: { u: 0, w: 0, h: 0, yaw: 0, v: 0 } },
      { dur: 5, v1: 0, scale: 1 },
      { dur: 10, v1: 0 },
      { dur: 36, v1: 76 },                                                // takeoff roll
      { dur: 4, v1: 80, pitch: 12 * DEG, climb: 3 },                      // rotate, lift off
      { dur: 6, v1: 84, climb: 11, after: { gear: 0 } },
      { dur: 24, v1: 88, climb: 12 },
      { dur: Math.abs(turnDeg) / 3, v1: 95, climb: 11, turn: turnDeg * DEG, roll: Math.sign(turnDeg) * 24 * DEG, pitch: 10 * DEG },
      { dur: 200, v1: 120, climb: 9, pitch: 8 * DEG, roll: 0 },
      { dur: 12, v1: 125, climb: 8, scale: 0 },
    ]);
  }
  function sampleTemplate(tpl, tau, out) {
    const S = tpl.S; const i = clamp(Math.floor(tau / 0.5), 0, S.length - 2); const a = S[i], b = S[i + 1];
    const k = clamp((tau - a[0]) / 0.5, 0, 1);
    for (let j = 0; j < 10; j++) out[j] = j === 7 || j === 8 ? (k < 0.5 ? a[j] : b[j]) : lerp(a[j], b[j], k);
    return out;
  }
  // closed racetrack circuit (touch-and-go pattern) for light aircraft: analytic, so it loops seamlessly.
  function gaPattern(L, side, time, out) {
    const a0 = -1150, a1 = L + 650, R = 420, S = a1 - a0, P = 2 * S + Math.PI * R * 2, v = 38;
    const tdU = 110, loU = 480, hPat = 245, hFin = 68, climb = 0.1, bank = Math.atan(v * v / (9.81 * R));
    const d = ((time * v) % P + P) % P;
    let u, w, yaw, h, pitch = 2 * DEG, roll = 0;
    if (d < S) {
      u = a0 + d; w = 0; yaw = 0;
      if (u < tdU) { h = hFin * (tdU - u) / (tdU - a0); pitch = lerp(4 * DEG, 0, sstep(0, 120, tdU - u)); }
      else if (u < loU) { h = 0; pitch = 0; }
      else { h = (u - loU) * climb; pitch = lerp(0, 8 * DEG, sstep(0, 60, u - loU)); }
    } else if (d < S + Math.PI * R) {
      const ang = (d - S) / R; u = a1 + Math.sin(ang) * R; w = R - Math.cos(ang) * R; yaw = ang;
      h = lerp((a1 - loU) * climb, hPat, sstep(0, 1, ang / Math.PI)); pitch = lerp(8 * DEG, 2 * DEG, ang / Math.PI);
      roll = bank * sstep(0, 0.6, ang) * sstep(Math.PI, Math.PI - 0.6, ang);
    } else if (d < 2 * S + Math.PI * R) {
      u = a1 - (d - S - Math.PI * R); w = 2 * R; yaw = Math.PI; h = hPat;
    } else {
      const ang = (d - 2 * S - Math.PI * R) / R; u = a0 - Math.sin(ang) * R; w = R + Math.cos(ang) * R; yaw = Math.PI + ang;
      h = lerp(hPat, hFin, sstep(0, 1, ang / Math.PI)); pitch = -1 * DEG;
      roll = bank * sstep(0, 0.6, ang) * sstep(Math.PI, Math.PI - 0.6, ang);
    }
    out[0] = time; out[1] = u; out[2] = w * side; out[3] = h; out[4] = yaw * side; out[5] = pitch; out[6] = roll * side;
    out[7] = 1; out[8] = 1; out[9] = 1;
    return out;
  }

  function createAirTraffic(ctx = {}) {
    if (!airMat) airMat = vehicleMaterial(1);
    const ll2w = ctx.ll2w || Geo.ll2w;
    const group = new THREE.Group(); group.name = 'air-traffic';
    const rws = {};
    for (const [id, d] of Object.entries(RUNWAYS)) {
      const a = ll2w(d.start[0], d.start[1]), b = ll2w(d.end[0], d.end[1]);
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
      // field elevation: terrain height at both runway ends when available (never below the surveyed value - 3 m)
      const g0 = ctx.groundY ? ctx.groundY(a.x, a.z) : d.elev, g1 = ctx.groundY ? ctx.groundY(b.x, b.z) : d.elev;
      const e0 = Number.isFinite(g0) ? Math.max(g0, d.elev - 3) : d.elev, e1 = Number.isFinite(g1) ? Math.max(g1, d.elev - 3) : d.elev;
      rws[id] = { id, x: a.x, z: a.z, dx: dx / L, dz: dz / L, L, e0, e1, yaw: Math.atan2(-dz, dx), end: { x: b.x, z: b.z } };
    }
    // airports: one instanced mesh per model type, anchored at the field so instance coordinates stay small
    const fields = {
      sfo: { rw: ['sfo28L', 'sfo28R', 'sfo01L', 'sfo01R'], types: ['narrow', 'wide'], cap: [16, 10] },
      sjc: { rw: ['sjc30L', 'sjc30R'], types: ['narrow', 'wide'], cap: [8, 4] },
      ga: { rw: ['pao31', 'sql30'], types: ['cessna'], cap: [6] },
    };
    for (const f of Object.values(fields)) {
      const r0 = rws[f.rw[0]]; f.anchor = new V3(Math.round(r0.x), Math.round(r0.e0), Math.round(r0.z));
      f.meshes = {}; f.list = [];
      f.types.forEach((t, i) => {
        const base = planeModel(t).geo; const geo = new THREE.BufferGeometry();
        for (const k of Object.keys(base.attributes)) geo.setAttribute(k, base.attributes[k]);
        if (!base.boundingSphere) base.computeBoundingSphere();
        geo.boundingSphere = base.boundingSphere.clone();
        const inst = new THREE.InstancedBufferAttribute(new Float32Array(f.cap[i] * 4), 4); inst.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('aInst', inst);
        const mesh = new THREE.InstancedMesh(geo, airMat.m, f.cap[i]); mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.customDepthMaterial = airMat.d; mesh.castShadow = true; mesh.frustumCulled = false; mesh.count = 0; mesh.position.copy(f.anchor); mesh.name = 'aircraft-' + t;
        const flare = flaresFor(mesh, inst, planeModel(t).lamps, 1, f.cap[i]);
        f.meshes[t] = { mesh, inst, flare, cap: f.cap[i], gearH: planeModel(t).gearH }; f.list.push(f.meshes[t]); group.add(mesh, flare);
      });
    }
    // West-flow operations (the usual configuration): SFO lands 28L/28R in pairs and departs 1L/1R,
    // SJC lands 30L/30R and departs 30L/30R. Landers exit toward the terminals (SFO left, SJC right).
    const flows = [
      { rw: 'sfo28L', field: 'sfo', every: 150, offset: 0, wide: 0.28, tpl: arrivalTemplate(2350, -1) },
      { rw: 'sfo28R', field: 'sfo', every: 150, offset: 21, pairJitter: 22, wide: 0.24, tpl: arrivalTemplate(2500, -1) },
      { rw: 'sfo01R', field: 'sfo', every: 140, offset: 35, wide: 0.22, tpl: departureTemplate(62) },
      { rw: 'sfo01L', field: 'sfo', every: 140, offset: 105, wide: 0.2, tpl: departureTemplate(78) },
      { rw: 'sjc30L', field: 'sjc', every: 420, offset: 60, wide: 0.05, tpl: arrivalTemplate(2300, 1) },
      { rw: 'sjc30R', field: 'sjc', every: 780, offset: 300, wide: 0.03, tpl: arrivalTemplate(2300, 1) },
      { rw: 'sjc30R', field: 'sjc', every: 380, offset: 200, wide: 0.05, tpl: departureTemplate(-55) },
      { rw: 'sjc30L', field: 'sjc', every: 900, offset: 520, wide: 0.04, tpl: departureTemplate(40) },
    ];
    flows.forEach((fl, i) => { fl.id = i + 1; });
    const ga = [{ rw: 'pao31', field: 'ga', n: 2, side: 1, colors: [0x1d3b75, 0xb3202a] }, { rw: 'sql30', field: 'ga', n: 2, side: 1, colors: [0x0f6f73, 0x8a5a1c] }];
    const activity = hr => (hr < 5 ? 0.06 : hr < 6 ? 0.45 : hr < 23 ? 0.95 : 0.3);
    const sample = new Float32Array(10);
    function place(m, f, rw, s, tailHex, phase) {
      if (m.mesh.count >= m.cap) return;
      const i = m.mesh.count++;
      const u = s[1], w = s[2], h = s[3], scale = s[9];
      const rx = -rw.dz, rz = rw.dx;     // right-hand perpendicular of the runway direction
      const elev = rw.e0 + (rw.e1 - rw.e0) * clamp(u / rw.L, 0, 1);
      _v.set(rw.x + rw.dx * u + rx * w - f.anchor.x, elev + h + m.gearH * scale - f.anchor.y, rw.z + rw.dz * u + rz * w - f.anchor.z);
      _e.set(s[6], rw.yaw - s[4], s[5], 'YZX'); _q.setFromEuler(_e); _s.set(scale, scale, scale);
      _m.compose(_v, _q, _s); m.mesh.setMatrixAt(i, _m);
      m.inst.setXYZW(i, tailHex, s[7], s[8], phase);
    }
    const air = {
      group, runways: rws,
      // env.time = sim seconds since local midnight (the schedule is a pure function of it: every client agrees)
      update(dt, env = {}) {
        const t = env.time !== undefined ? env.time : (Date.now() / 1000) % 86400;
        for (const k in fields) for (const m of fields[k].list) m.mesh.count = 0;
        for (const fl of flows) {
          const f = fields[fl.field], rw = rws[fl.rw], dur = fl.tpl.dur, I = fl.every;
          const k0 = Math.floor((t - dur - I - fl.offset) / I), k1 = Math.floor((t - fl.offset) / I) + 1;
          for (let k = k0; k <= k1; k++) {
            const hA = hash(k * 31 + fl.id * 7, fl.every), hB = hash(k * 17 + fl.id, fl.offset + 11), hC = hash(k * 13 + 5, fl.every + fl.id * 29);
            const start = k * I + fl.offset + (fl.pairJitter ? hB * fl.pairJitter : (hB - 0.5) * I * 0.35);
            const tau = t - start; if (tau < 0 || tau > dur) continue;
            const hr = ((start / 3600) % 24 + 24) % 24; if (hA > activity(hr)) continue;
            sampleTemplate(fl.tpl, tau, sample);
            place(f.meshes[hC < fl.wide ? 'wide' : 'narrow'], f, rw, sample, TAIL_COLORS[Math.floor(hash(k * 7 + fl.id, fl.every * 3) * TAIL_COLORS.length)], hB * 10);
          }
        }
        for (const g of ga) {
          const f = fields[g.field], rw = rws[g.rw];
          for (let j = 0; j < g.n; j++) { gaPattern(rw.L, g.side, t + j * 97.3, sample); place(f.meshes.cessna, f, rw, sample, g.colors[j % g.colors.length], j * 3.3); }
        }
        for (const k in fields) for (const m of fields[k].list) { m.mesh.instanceMatrix.needsUpdate = true; m.inst.needsUpdate = true; m.flare.count = m.mesh.count; }
      },
      // for UIs/minimaps/cameras: current aircraft (world coords); allocates, so not for per-frame hot paths
      positions() {
        const out = [];
        for (const k in fields) { const f = fields[k]; for (const t in f.meshes) { const m = f.meshes[t].mesh; for (let i = 0; i < m.count; i++) {
          m.getMatrixAt(i, _m); _m.decompose(_v, _q, _s); const p = _v.clone().add(f.anchor);
          const fwd = new V3(1, 0, 0).applyQuaternion(_q);
          out.push({ field: k, type: t, x: p.x, y: p.y, z: p.z, heading: Math.atan2(-fwd.z, fwd.x), scale: _s.x }); } } }
        return out;
      },
    };
    return air;
  }

  // ==========================================================================================
  // BIRDS (fully GPU-driven: orbiting gulls & crows, lines of pelicans, pigeons on the ground)
  // ==========================================================================================
  function birdGeo(kind) {
    const P = []; const add = (g, hex, side, span) => { g = prep(g); const c = lin(hex); constAttr(g, 'aBCol', [c.r, c.g, c.b]); constAttr(g, 'aWing', [side, span]); P.push(g); };
    const K = { gull: { L: 0.44, S: 0.7, bw: 0.15, body: 0xf4f4f2, head: 0xf6f6f4, wing: 0xb9bfc5, tip: 0x1a1a1a, bill: 0xe0b020 },
      pelican: { L: 1.15, S: 1.15, bw: 0.17, body: 0x8a7b68, head: 0xe8e0cc, wing: 0x6b5d4f, tip: 0x2a2520, bill: 0xb89a6a },
      crow: { L: 0.45, S: 0.46, bw: 0.15, body: 0x141416, head: 0x121214, wing: 0x18181b, tip: 0x0e0e10, bill: 0x111111 },
      pigeon: { L: 0.32, S: 0.33, bw: 0.22, body: 0x6b6e78, head: 0x4a4f5c, wing: 0x7c7f89, tip: 0x2e3036, bill: 0x2a2a2a } }[kind];
    const L = K.L, S = K.S;
    add(sph(1, 8, 6, 0, 0, 0, L * 0.42, L * K.bw, L * K.bw * 1.05), K.body, 0, 0);
    add(sph(L * 0.11, 6, 5, L * 0.42, L * 0.08, 0), K.head, 0, 0);
    { const b = new THREE.ConeGeometry(L * 0.035, kind === 'pelican' ? L * 0.45 : L * 0.14, 5); b.rotateZ(-Math.PI / 2); b.translate(L * (kind === 'pelican' ? 0.78 : 0.62), L * 0.04, 0); add(b, K.bill, 0, 0); }
    { const t = new THREE.ConeGeometry(L * 0.12, L * 0.3, 4); t.rotateZ(Math.PI / 2); t.scale(1, 0.3, 1); t.translate(-L * 0.55, 0, 0); add(t, K.wing, 0, 0); }
    for (const s of [-1, 1]) {
      const root = 0.05 * L, mid = S * 0.5, tip = S;
      const inner = new THREE.BufferGeometry(); inner.setAttribute('position', new THREE.Float32BufferAttribute([
        L * 0.12, 0, s * root, -L * 0.18, 0, s * root, -L * 0.22, 0, s * mid, L * 0.12, 0, s * root, -L * 0.22, 0, s * mid, L * 0.06, 0, s * mid], 3));
      inner.computeVertexNormals(); add(inner, K.wing, s, 0.5);
      const outer = new THREE.BufferGeometry(); outer.setAttribute('position', new THREE.Float32BufferAttribute([
        L * 0.06, 0, s * mid, -L * 0.22, 0, s * mid, -L * 0.28, 0, s * tip, L * 0.06, 0, s * mid, -L * 0.28, 0, s * tip, -L * 0.1, 0, s * tip * 0.97], 3));
      outer.computeVertexNormals(); add(outer, K.tip, s, 1.0);
    }
    const g = U.mergeGeometries(P);
    // record span fraction per vertex precisely from |z|
    const p = g.attributes.position, wa = g.attributes.aWing;
    for (let i = 0; i < p.count; i++) if (wa.getX(i) !== 0) wa.setY(i, Math.abs(p.getZ(i)) / S);
    return { geo: g, S };
  }
  const BIRD_VHEAD = `
    attribute vec3 aBCol; attribute vec2 aWing;
    attribute vec4 aB0;   // center x,y,z (mesh-local), radius
    attribute vec4 aB1;   // angular speed (orbit) or speed (line), phase, bob amplitude, flap Hz
    attribute vec4 aB2;   // mode (0 orbit, 1 line, 2 ground), heading (line), path length (line), scale
    varying vec3 vLifeCol;
    uniform float uBirdSpan;
    void lifeBird(inout vec3 p, inout vec3 n) {
      float t = uLifeTime, ph = aB1.y, mode = aB2.x;
      vec3 pos; float yaw = 0.0, pitch = 0.0, roll = 0.0, scl = aB2.w;
      float flapAmp, flapMean = 0.12, fly = 1.0;
      if (mode < 0.5) {
        float w = aB1.x, ang = ph + t * w, rr = aB0.w * (1.0 + 0.3 * sin(t * 0.11 + ph * 2.7));
        pos = aB0.xyz + vec3(cos(ang) * rr, aB1.z * sin(t * 0.5 + ph * 3.3), -sin(ang) * rr);
        vec2 v = vec2(-sin(ang), -cos(ang)) * sign(w);
        yaw = atan(-v.y, v.x); roll = -0.35 * sign(w);
        flapAmp = 0.55 * smoothstep(-0.3, 0.5, sin(t * 0.35 + ph * 4.1)) + 0.04;
      } else if (mode < 1.5) {
        float L = aB2.z, u = mod(t * aB1.x + ph, L);
        vec2 d = vec2(cos(aB2.y), -sin(aB2.y));
        pos = aB0.xyz + vec3(d.x * u, aB1.z * sin(t * 0.8 + ph), d.y * u);
        yaw = aB2.y; scl *= smoothstep(0.0, 40.0, u) * smoothstep(L, L - 40.0, u);
        flapAmp = 0.45 * smoothstep(0.6, 0.9, sin(t * 0.5 + ph * 0.7)) + 0.02;
      } else {
        float cyc = fract(t * 0.023 + ph * 0.137);
        fly = smoothstep(0.9, 0.92, cyc) * (1.0 - smoothstep(0.975, 1.0, cyc));
        float ang = ph * 5.0 + t * 0.12 / max(0.5, aB0.w);
        pos = aB0.xyz + vec3(cos(ang) * aB0.w, fly * 2.4 + 0.1 * scl * (1.0 - fly), -sin(ang) * aB0.w);   // standing on its legs
        yaw = ang + 1.5708;
        float peck = max(0.0, sin(t * 3.1 + ph * 7.0)) * step(0.4, fract(t * 0.2 + ph));
        pitch = (0.32 - 0.8 * peck) * (1.0 - fly);
        flapAmp = 0.9 * fly;
        flapMean = mix(0.0, 0.1, fly);
      }
      vec3 q = p;
      if (abs(aWing.x) > 0.5) {
        float s = aWing.x, span = aWing.y;
        if (mode > 1.5 && fly < 0.5) {       // folded along the body
          q.z = s * (0.06 + 0.05 * span) * uBirdSpan; q.x -= span * 0.12 * uBirdSpan; q.y += 0.02;
        } else {
          float a = flapMean + flapAmp * sin(t * 6.2831853 * aB1.w + ph * 3.0);
          float a2 = 0.35 * flapAmp * sin(t * 6.2831853 * aB1.w + ph * 3.0 - 0.9);
          vec3 root = vec3(0.0, 0.0, s * 0.02), mid = vec3(0.0, 0.0, s * 0.5 * uBirdSpan);
          if (span > 0.55) { mat3 R2 = lifeRotX(-s * a2); q = R2 * (q - mid) + mid; n = R2 * n; }
          mat3 R1 = lifeRotX(-s * a); q = R1 * (q - root) + root; n = R1 * n;
        }
      }
      mat3 O = lifeRotY(yaw) * lifeRotZ(pitch) * lifeRotX(roll);
      q = O * q * scl; n = O * n;
      p = q + pos;
      vLifeCol = aBCol;
    }
  `;
  const BIRD_INJ = { vHead: BIRD_VHEAD, call: 'lifeBird(lifeP, objectNormal);', fHead: 'varying vec3 vLifeCol;', fColor: 'diffuseColor.rgb *= vLifeCol;' };
  // Default bird life along the corridor. gulls/crows: [lat, lon, count, orbit radius m, height m];
  // pelicans: [lat, lon, count, path length m, height m, compass bearing deg]; pigeons: [lat, lon, count, radius m]
  const BIRD_SPOTS = {
    gulls: [[37.7745, -122.3872, 14, 70, 28], [37.7952, -122.3905, 10, 60, 30], [37.6705, -122.3830, 8, 90, 25], [37.5925, -122.3160, 10, 80, 22],
      [37.6010, -122.3760, 8, 80, 26], [37.5605, -122.2590, 8, 100, 30], [37.5360, -122.2380, 6, 70, 25], [37.5130, -122.2400, 6, 80, 24],
      [37.4870, -122.2090, 6, 70, 22], [37.4585, -122.1045, 10, 90, 26], [37.4330, -122.0840, 8, 80, 30], [37.4120, -122.0300, 6, 90, 28],
      [37.4310, -121.9680, 8, 100, 30]],
    pelicans: [[37.7680, -122.3845, 5, 1800, 2.5, 170], [37.5930, -122.3100, 7, 3000, 2.2, 135], [37.5700, -122.2560, 6, 3600, 2.5, 140],
      [37.4610, -122.1020, 7, 3200, 2.0, 315], [37.4400, -121.9900, 5, 3000, 2.0, 270]],
    crows: [[37.4432, -122.1640, 5, 45, 32], [37.3950, -122.0775, 4, 40, 30], [37.3297, -121.9030, 5, 50, 36], [37.4859, -122.2315, 4, 40, 30],
      [37.5682, -122.3239, 4, 40, 30], [37.5799, -122.3442, 4, 40, 28], [37.5080, -122.2602, 3, 35, 28], [37.4548, -122.1825, 4, 40, 30],
      [37.3789, -122.0315, 4, 45, 30], [37.3534, -121.9365, 3, 40, 30], [37.1296, -121.6506, 4, 50, 32], [37.0045, -121.5667, 4, 50, 30]],
    pigeons: [[37.7766, -122.3943, 14, 3], [37.4430, -122.1640, 10, 3], [37.3947, -122.0770, 8, 2.5], [37.3298, -121.9030, 12, 3],
      [37.5999, -122.3866, 8, 2.5], [37.5682, -122.3239, 8, 2.5], [37.4859, -122.2315, 8, 2.5]],
  };
  function createBirds(ctx = {}) {
    const ll2w = ctx.ll2w || Geo.ll2w, gy = ctx.groundY || (() => 0);
    const group = new THREE.Group(); group.name = 'birds';
    const specs = { gull: [], pelican: [], crow: [], pigeon: [] };
    const r = U.rng(4242);
    const spots = ctx.spots || null;
    const addOrbit = (kind, x, y, z, count, radius, height) => { for (let i = 0; i < count; i++) specs[kind].push([x + (r() - 0.5) * radius, y + height * lerp(0.6, 1.4, r()), z + (r() - 0.5) * radius, radius * lerp(0.4, 1.0, r()),
      (r() < 0.5 ? -1 : 1) * lerp(0.12, 0.3, r()), r() * TAU, lerp(1, 4, r()), kind === 'crow' ? lerp(3.2, 4.0, r()) : lerp(2.2, 2.9, r()), 0, 0, 0, lerp(0.9, 1.15, r())]); };
    const addLine = (kind, x, y, z, count, length, height, heading) => { for (let i = 0; i < count; i++) specs[kind].push([x - Math.cos(heading) * i * 3.2 + Math.sin(heading) * (i % 2 ? 2.5 : -2.5) * Math.ceil(i / 2), y + height, z + Math.sin(heading) * i * 3.2 + Math.cos(heading) * (i % 2 ? 2.5 : -2.5) * Math.ceil(i / 2),
      0, 11.5, i * 0.0, 0.3, 1.6, 1, heading, length, lerp(0.95, 1.1, r())]); };
    const addGround = (kind, x, y, z, count, radius) => { for (let i = 0; i < count; i++) specs[kind].push([x + (r() - 0.5) * radius * 3, y + 0.02, z + (r() - 0.5) * radius * 3, radius * lerp(0.4, 1.2, r()), 0, r() * TAU, 0, lerp(5, 7, r()), 2, 0, 0, lerp(0.9, 1.1, r())]); };
    if (spots) {
      for (const s of spots) {
        const kind = { gulls: 'gull', gull: 'gull', pelicans: 'pelican', pelican: 'pelican', crows: 'crow', crow: 'crow', pigeons: 'pigeon', pigeon: 'pigeon' }[s.kind] || 'gull';
        const y = s.y !== undefined ? s.y : gy(s.x, s.z);
        if (kind === 'pelican') addLine(kind, s.x, y, s.z, s.count || 6, s.length || 2500, s.height || 2, s.heading || 0);
        else if (kind === 'pigeon') addGround(kind, s.x, y, s.z, s.count || 8, s.radius || 3);
        else addOrbit(kind, s.x, y, s.z, s.count || 8, s.radius || 70, s.height || 28);
      }
    } else {
      for (const [la, lo, c, rad, h] of BIRD_SPOTS.gulls) { const w = ll2w(la, lo); addOrbit('gull', w.x, 0, w.z, c, rad, h); }
      for (const [la, lo, c, len, h, brg] of BIRD_SPOTS.pelicans) { const w = ll2w(la, lo); addLine('pelican', w.x, 0, w.z, c, len, h, (90 - brg) * DEG); }
      for (const [la, lo, c, rad, h] of BIRD_SPOTS.crows) { const w = ll2w(la, lo); addOrbit('crow', w.x, gy(w.x, w.z), w.z, c, rad, h); }
      for (const [la, lo, c, rad] of BIRD_SPOTS.pigeons) { const w = ll2w(la, lo); addGround('pigeon', w.x + 18, gy(w.x + 18, w.z + 6), w.z + 6, c, rad); }
    }
    let ax = 0, ay = 0, az = 0, cnt = 0;
    for (const k in specs) for (const s of specs[k]) { ax += s[0]; ay += s[1]; az += s[2]; cnt++; }
    const anchor = new V3(Math.round(ax / Math.max(1, cnt)), Math.round(ay / Math.max(1, cnt)), Math.round(az / Math.max(1, cnt)));
    group.position.copy(anchor);
    for (const kind of Object.keys(specs)) {
      const list = specs[kind]; if (!list.length) continue;
      const { geo: base, S } = birdGeo(kind);
      const geo = new THREE.InstancedBufferGeometry();
      for (const k of Object.keys(base.attributes)) geo.setAttribute(k, base.attributes[k]);
      const a0 = new Float32Array(list.length * 4), a1 = new Float32Array(list.length * 4), a2 = new Float32Array(list.length * 4);
      list.forEach((s, i) => { a0.set([s[0] - anchor.x, s[1] - anchor.y, s[2] - anchor.z, s[3]], i * 4); a1.set([s[4], s[5], s[6], s[7]], i * 4); a2.set([s[8], s[9], s[10], s[11]], i * 4); });
      geo.setAttribute('aB0', new THREE.InstancedBufferAttribute(a0, 4)); geo.setAttribute('aB1', new THREE.InstancedBufferAttribute(a1, 4)); geo.setAttribute('aB2', new THREE.InstancedBufferAttribute(a2, 4));
      geo.instanceCount = list.length;
      const mat = lifeMaterial('bird', new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide }), BIRD_INJ);
      const ob = mat.onBeforeCompile; mat.onBeforeCompile = sh => { ob(sh); sh.uniforms.uBirdSpan = { value: S }; };
      mat.customProgramCacheKey = () => 'life-bird';
      const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.name = 'birds-' + kind;
      group.add(mesh);
    }
    return { group, update() {}, count: cnt };
  }

  function stats() {
    const tri = g => (g.index ? g.index.count : g.attributes.position.count) / 3;
    const out = { person: personGeo ? tri(personGeo) : tri(personGeo = buildPersonGeometry()) };
    for (const k of Object.keys(TREE_BUILDERS)) { const s = treeSpec(k).spec; out['tree.' + k] = [tri(s.near), tri(s.far)]; }
    for (const t of VEH_TYPES) out['veh.' + t] = tri(vehModel(t).geo);
    for (const t of Object.keys(PLANES)) out['plane.' + t] = tri(planeModel(t).geo);
    return out;
  }

  return { createPeople, createTraffic, createAirTraffic, createTrees, createBirds, makeLook, RUNWAYS, stats,
    TREE_KINDS: Object.keys(TREE_BUILDERS), PERSON: { standEye: 1.61, sitEye: 1.22, seatHeight: 0.46, height: 1.72 } };
})();
