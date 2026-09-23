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
  const PART = { PELVIS: 0, TORSO: 1, HEAD: 2, LTHIGH: 3, LSHIN: 4, RTHIGH: 5, RSHIN: 6, LUARM: 7, LFARM: 8, RUARM: 9, RFARM: 10, ROOT: 11 };
  const SLOT = { SKIN: 0, TOP: 1, BOTTOM: 2, SHOES: 3, HAIR: 4, ACC: 5, HAT: 6, SHIN: 7, DARK: 8, SCREEN: 9, FOREARM: 10, METAL: 11, WHITE: 12, LIPS: 13, THIGH: 14, KNEE: 15 };
  // lathe around +Y with a (radius, y) profile, squashed front-to-back by sx
  function latheY(profile, seg, sx) { const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg); g.scale(sx, 1, 1); return g; }
  let personGeo = null;
  function buildPersonGeometry() {
    const parts = [];
    const add = (g, part, slot, flag = 0) => { g = prep(g, true); constAttr(g, 'aMeta', [part, slot, flag]); parts.push(g); };
    for (const sd of [-1, 1]) {
      const left = sd < 0, z = sd * 0.093;
      const thigh = left ? PART.LTHIGH : PART.RTHIGH, shin = left ? PART.LSHIN : PART.RSHIN;
      const uarm = left ? PART.LUARM : PART.RUARM, farm = left ? PART.LFARM : PART.RFARM;
      add(box(0.25, 0.075, 0.098, 0.052, 0.0375, z), shin, SLOT.SHOES);
      add(box(0.24, 0.02, 0.1, 0.05, 0.008, z), shin, SLOT.DARK);                        // sole
      add(cylY(0.043, 0.056, 0.065, 0.48, 6, 0, z), shin, SLOT.SHIN);
      add(sph(0.057, 6, 4, 0, 0.47, z), thigh, SLOT.KNEE);                                // knee
      add(cylY(0.056, 0.083, 0.46, 0.91, 7, 0, z), thigh, SLOT.THIGH);
      add(cylY(0.046, 0.053, 1.10, 1.40, 6, 0, sd * 0.203), uarm, SLOT.TOP);
      add(sph(0.045, 6, 4, 0, 1.12, sd * 0.205), uarm, SLOT.TOP);                         // elbow
      add(cylY(0.034, 0.043, 0.855, 1.13, 6, 0, sd * 0.208), farm, SLOT.FOREARM);
      add(sph(0.05, 5, 4, 0.006, 0.8, sd * 0.211, 0.52, 1.0, 0.36), farm, SLOT.SKIN);    // hand
      add(sph(0.058, 6, 4, 0, 1.36, sd * 0.174, 1, 0.95, 1.05), PART.TORSO, SLOT.TOP);  // shoulder
      add(quadX(0.026, 0.015, 0.1015, 1.614, sd * 0.035), PART.HEAD, SLOT.WHITE);      // eye white
      add(quadX(0.012, 0.015, 0.1025, 1.614, sd * 0.034), PART.HEAD, SLOT.DARK);       // iris
      add(quadX(0.034, 0.008, 0.0995, 1.638, sd * 0.037), PART.HEAD, SLOT.HAIR);       // brow
      add(box(0.012, 0.035, 0.022, 0.012, 1.595, sd * 0.081), PART.HEAD, SLOT.SKIN);    // ear
    }
    add(latheY([[0.001, 0.8], [0.13, 0.81], [0.158, 0.85], [0.165, 0.9], [0.158, 0.96], [0.146, 1.0]], 10, 0.72), PART.PELVIS, SLOT.BOTTOM);
    add(latheY([[0.22, 0.54], [0.2, 0.7], [0.18, 0.84], [0.168, 0.97]], 10, 0.82), PART.PELVIS, SLOT.BOTTOM, 42);   // skirt
    add(latheY([[0.142, 0.95], [0.15, 1.06], [0.168, 1.17], [0.184, 1.28], [0.18, 1.35], [0.152, 1.405], [0.1, 1.432], [0.05, 1.445]], 10, 0.64), PART.TORSO, SLOT.TOP);
    add(cylY(0.046, 0.05, 1.4, 1.52, 7, 0.008, 0), PART.TORSO, SLOT.SKIN);                    // neck
    add(sph(0.1, 10, 8, 0.012, 1.595, 0, 1.0, 1.13, 0.8), PART.HEAD, SLOT.SKIN);
    add(quadX(0.036, 0.007, 0.1062, 1.554, 0), PART.HEAD, SLOT.LIPS);                          // mouth
    add(box(0.022, 0.032, 0.02, 0.111, 1.585, 0, 0.35), PART.HEAD, SLOT.SKIN);                // nose
    // hair: 1 short, 2 long, 3 bun, 4 curly, 5 ponytail. Flag 16 = the shared cap (styles 1,2,3,5); the cap is
    // tilted back so the hairline sits on the forehead
    add(sph(0.106, 10, 5, 0, 1.598, 0, 1.03, 1.12, 0.86, Math.PI * 0.56, 0.6), PART.HEAD, SLOT.HAIR, 16);
    add(box(0.05, 0.3, 0.17, -0.07, 1.46, 0), PART.HEAD, SLOT.HAIR, 12);
    add(sph(0.048, 6, 4, -0.078, 1.695, 0), PART.HEAD, SLOT.HAIR, 13);
    add(sph(0.13, 10, 6, -0.035, 1.655, 0, 1.0, 0.95, 1.05), PART.HEAD, SLOT.HAIR, 14);
    add(seg3(v3(-0.095, 1.625, 0), v3(-0.14, 1.42, 0), 0.032, 0.02, 5), PART.HEAD, SLOT.HAIR, 15);
    // headwear: 1 cap, 2 beanie, 3 cycling helmet, 4 sun hat. Flag 25 = the shared crown (styles 1 and 4)
    add(sph(0.113, 10, 4, 0.002, 1.612, 0, 1.03, 0.94, 0.9, Math.PI * 0.5, 0.22), PART.HEAD, SLOT.HAT, 25);
    add(box(0.12, 0.012, 0.15, 0.118, 1.646, 0, -0.12), PART.HEAD, SLOT.HAT, 21);
    add(sph(0.115, 10, 5, 0, 1.604, 0, 1.03, 1.22, 0.9, Math.PI * 0.55, 0.45), PART.HEAD, SLOT.HAT, 22);
    add(sph(0.128, 10, 4, -0.014, 1.618, 0, 1.24, 0.9, 1.0, Math.PI * 0.5, 0.15), PART.HEAD, SLOT.HAT, 23);
    add(cylY(0.19, 0.19, 1.646, 1.656, 12, 0.004, 0, 1, 1, true), PART.HEAD, SLOT.HAT, 24);
    { const d = new THREE.CircleGeometry(0.19, 12); d.rotateX(-Math.PI / 2); d.translate(0.004, 1.656, 0); add(d, PART.HEAD, SLOT.HAT, 24);
      const u = new THREE.CircleGeometry(0.19, 12); u.rotateX(Math.PI / 2); u.translate(0.004, 1.646, 0); add(u, PART.HEAD, SLOT.HAT, 24); }
    // carried things (flag 31..36)
    add(box(0.15, 0.4, 0.27, -0.168, 1.17, 0), PART.TORSO, SLOT.ACC, 31);                     // backpack
    add(box(0.05, 0.16, 0.2, -0.26, 1.08, 0), PART.TORSO, SLOT.ACC, 31);
    add(box(0.02, 0.28, 0.035, -0.08, 1.24, -0.1), PART.TORSO, SLOT.ACC, 31);                // straps
    add(box(0.02, 0.28, 0.035, -0.08, 1.24, 0.1), PART.TORSO, SLOT.ACC, 31);
    { const g = new THREE.BoxGeometry(0.22, 0.52, 0.36); g.rotateZ(-0.35); g.translate(-0.42, 0.33, 0.3); add(g, PART.ROOT, SLOT.ACC, 32); }   // luggage
    add(seg3(v3(-0.35, 0.58, 0.3), v3(-0.02, 0.79, 0.27), 0.012, 0.012, 5), PART.ROOT, SLOT.METAL, 32);
    add(box(0.06, 0.06, 0.32, -0.36, 0.035, 0.3), PART.ROOT, SLOT.DARK, 32);
    add(box(0.1, 0.3, 0.3, 0.02, 0.97, -0.235), PART.PELVIS, SLOT.ACC, 33);                   // tote
    add(seg3(v3(0.0, 1.12, -0.225), v3(0.0, 1.4, -0.15), 0.01, 0.01, 4), PART.TORSO, SLOT.ACC, 33);
    add(box(0.012, 0.14, 0.07, 0.03, 0.79, 0.213), PART.RFARM, SLOT.DARK, 34);                // phone
    add(box(0.004, 0.126, 0.06, 0.0375, 0.79, 0.213), PART.RFARM, SLOT.SCREEN, 34);
    add(box(0.09, 0.3, 0.4, 0.0, 0.6, -0.26), PART.LFARM, SLOT.ACC, 35);                      // briefcase
    add(box(0.03, 0.03, 0.1, 0.0, 0.765, -0.24), PART.LFARM, SLOT.DARK, 35);
    { // bicycle walked on the right-hand side
      const zb = 0.52;
      for (const x of [-0.42, 0.62]) { const t = new THREE.TorusGeometry(0.33, 0.022, 3, 12); t.translate(x, 0.35, zb); add(t, PART.ROOT, SLOT.DARK, 36); }
      const bb = v3(0.08, 0.3, zb), head = v3(0.5, 0.74, zb), seat = v3(-0.06, 0.82, zb), rear = v3(-0.42, 0.35, zb), front = v3(0.62, 0.35, zb);
      for (const [a, b] of [[bb, head], [seat, v3(0.5, 0.8, zb)], [bb, seat], [bb, rear], [v3(-0.04, 0.77, zb), rear], [head, front], [head, v3(0.47, 0.97, zb)]])
        add(seg3(a, b, 0.018, 0.018, 4, true), PART.ROOT, SLOT.ACC, 36);
      add(seg3(v3(0.47, 0.97, zb - 0.22), v3(0.47, 0.97, zb + 0.22), 0.013, 0.013, 4), PART.ROOT, SLOT.METAL, 36);
      add(box(0.2, 0.04, 0.09, -0.08, 0.86, zb), PART.ROOT, SLOT.DARK, 36);
    }
    const g = U.mergeGeometries(parts);
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }

  const PEOPLE_VHEAD = `
    attribute vec3 aMeta;
    attribute vec4 aAnim;   // walk weight, sit weight, gait phase offset, gait frequency (Hz)
    attribute vec4 aBody;   // girth, head scale, idle seed, short sleeves (1)
    attribute vec4 aStyle;  // hair, headwear, carry, bottom
    attribute vec4 aCol0;   // skin, top, bottom, shoes (packed sRGB)
    attribute vec4 aCol1;   // hair, accessory, hat, tights
    varying vec3 vLifeCol;
    varying vec3 vLifeGlow;
    void lifePose(inout vec3 p, inout vec3 n) {
      float part = aMeta.x, slot = aMeta.y, flag = aMeta.z;
      float show = 1.0;
      if (flag > 9.5) {
        float grp = floor(flag / 10.0 + 0.01); float val = flag - grp * 10.0;
        float want = grp < 1.5 ? aStyle.x : grp < 2.5 ? aStyle.y : grp < 3.5 ? aStyle.z : aStyle.w;
        show = abs(want - val) < 0.5 ? 1.0 : 0.0;
        if (abs(flag - 16.0) < 0.5) show = (want > 0.5 && abs(want - 4.0) > 0.5) ? 1.0 : 0.0;       // shared hair cap
        if (abs(flag - 25.0) < 0.5) show = (abs(want - 1.0) < 0.5 || abs(want - 4.0) < 0.5) ? 1.0 : 0.0;  // shared hat crown
      }
      float t = uLifeTime;
      float walk = aAnim.x, sit = aAnim.y;
      float stand = clamp(1.0 - walk - sit, 0.0, 1.0);
      float ph = t * 6.2831853 * aAnim.w + aAnim.z;
      float sL = sin(ph), cL = cos(ph);
      float carry = aStyle.z;
      float seed = aBody.z;
      // legs: hip flexion swings the thigh forward, the knee flexes during the swing phase
      float sway = stand * 0.035 * sin(t * 0.43 + seed * 40.0);
      float hipL = 0.40 * sL * walk + sway, hipR = -0.40 * sL * walk - sway;
      float kneeL = walk * (0.08 + 0.9 * pow(max(0.0, cL), 1.6)) + 0.05 + stand * max(0.0, sway) * 2.0;
      float kneeR = walk * (0.08 + 0.9 * pow(max(0.0, -cL), 1.6)) + 0.05 + stand * max(0.0, -sway) * 2.0;
      hipL = mix(hipL, 1.5, sit); hipR = mix(hipR, 1.5, sit);
      kneeL = mix(kneeL, 1.5, sit); kneeR = mix(kneeR, 1.5, sit);
      // arms swing opposite to the legs
      float shL = -0.34 * sL * walk + 0.03, shR = 0.34 * sL * walk + 0.03;
      float elL = 0.16 + 0.24 * walk + 0.1 * walk * max(0.0, sL), elR = 0.16 + 0.24 * walk + 0.1 * walk * max(0.0, -sL);
      shL = mix(shL, 0.32, sit); shR = mix(shR, 0.32, sit);
      elL = mix(elL, 1.12, sit); elR = mix(elR, 1.12, sit);
      float headPitch = 0.04 * sit;
      float inL = 0.45 * sit, inR = 0.45 * sit;   // forearm turned in toward the lap / chest
      if (carry > 3.5 && carry < 4.5) { shR = mix(0.3, 0.22, sit); elR = 1.72; inR = 0.35; headPitch = 0.42; }  // phone
      else if (carry > 1.5 && carry < 2.5) { shR = -0.1 * (1.0 - sit); elR = 0.07 + sit; }                // pulling luggage
      else if (carry > 4.5 && carry < 5.5) { shL *= 0.3; elL = 0.05 + sit; }                              // briefcase
      else if (carry > 5.5) { shR = mix(0.55, 0.32, sit); elR = mix(0.42, 1.12, sit); inR = mix(-0.25, 0.45, sit); }  // bike handlebar
      float look = sin(t * 0.21 + seed * 17.0);
      float headYaw = 0.55 * sin(t * 0.37 + seed * 31.0) * smoothstep(0.25, 0.9, look) * (1.0 - 0.75 * walk);
      float lean = walk * 0.07 - sit * 0.05;
      float twist = walk * 0.1 * sL;
      float bob = walk * 0.022 * cos(2.0 * ph) + stand * 0.004 * sin(t * 1.7 + seed * 9.0);
      float drop = -0.44 * sit;
      float g = aBody.x;
      vec3 q = p;
      if (part < 1.5) { q.x *= g; q.z *= g; }
      if (flag > 30.5 && flag < 31.5) q.x -= (g - 1.0) * 0.1;
      if (abs(flag - 16.0) < 0.5 && aStyle.y > 0.5) { vec3 hc = vec3(0.0, 1.6, 0.0); q = hc + (q - hc) * vec3(0.96, 0.88, 0.96); }  // hair tucked under headwear
      if (flag > 41.5 && flag < 42.5) {   // skirt: the front follows the leading thigh, the back the trailing one
        vec3 hipJ = vec3(0.0, 0.9, 0.0);
        float a = smoothstep(-0.02, 0.12, q.x) * max(hipL, hipR) * 0.85 + smoothstep(0.02, -0.12, q.x) * min(hipL, hipR) * 0.6;
        mat3 Rs = lifeRotZ(a); q = Rs * (q - hipJ) + hipJ; n = Rs * n;
      }
      if (part > 2.5 && part < 6.5) {
        float sd = part < 4.5 ? -1.0 : 1.0;
        bool shin = (part > 3.5 && part < 4.5) || part > 5.5;
        float ha = sd < 0.0 ? hipL : hipR, ka = sd < 0.0 ? kneeL : kneeR;
        float gs = shin ? 1.0 + (g - 1.0) * 0.35 : 1.0 + (g - 1.0) * 0.8, lz = sd * 0.093;
        q.x *= gs; q.z = lz + (q.z - lz) * gs + sd * (g - 1.0) * 0.07;
        vec3 hipJ = vec3(0.0, 0.9, 0.0), kneeJ = vec3(0.0, 0.47, 0.0);
        if (shin) { mat3 K = lifeRotZ(-ka); q = K * (q - kneeJ) + kneeJ; n = K * n; }
        mat3 H = lifeRotZ(ha); q = H * (q - hipJ) + hipJ; n = H * n;
      }
      if (part > 6.5 && part < 10.5) {
        float sd = part < 8.5 ? -1.0 : 1.0;
        bool fore = (part > 7.5 && part < 8.5) || part > 9.5;
        float sa = sd < 0.0 ? shL : shR, ea = sd < 0.0 ? elL : elR;
        float wide = (g - 1.0) * 0.17, ga = 1.0 + (g - 1.0) * 0.5, az = sd * 0.205;
        q.x *= ga; q.z = az + (q.z - az) * ga + sd * wide;
        vec3 shJ = vec3(0.0, 1.4, sd * (0.195 + wide)), elJ = vec3(0.0, 1.12, sd * (0.205 + wide));
        if (fore) { mat3 E = lifeRotY(sd * (sd < 0.0 ? inL : inR)) * lifeRotZ(ea); q = E * (q - elJ) + elJ; n = E * n; }
        mat3 S = lifeRotZ(sa) * lifeRotX(-sd * (0.07 + (g - 1.0) * 0.3 - 0.05 * sit));
        q = S * (q - shJ) + shJ; n = S * n;
      }
      if (part > 1.5 && part < 2.5) {
        vec3 neck = vec3(0.0, 1.47, 0.0);
        q = neck + (q - neck) * aBody.y;
        mat3 Hd = lifeRotY(headYaw) * lifeRotZ(-headPitch);
        q = Hd * (q - neck) + neck; n = Hd * n;
      }
      if ((part > 0.5 && part < 2.5) || (part > 6.5 && part < 10.5)) {
        vec3 P0 = vec3(0.0, 0.95, 0.0);
        mat3 T = lifeRotY(twist) * lifeRotZ(-lean);
        q = T * (q - P0) + P0; n = T * n;
      }
      if (part < 0.5) { mat3 T0 = lifeRotY(-twist * 0.6); q = T0 * q; n = T0 * n; }
      if (part < 10.5) q.y += bob + drop;
      else if (flag > 35.5 && sit > 0.5) show = 0.0;
      if ((flag > 30.5 && flag < 31.5 || flag > 34.5 && flag < 35.5) && sit > 0.5) show = 0.0;   // backpack, briefcase set down when seated
      if (show < 0.5) q = vec3(0.0);
      p = q;
      // colors
      vec3 skin = lifeUnpack(aCol0.x), top = lifeUnpack(aCol0.y), bottom = lifeUnpack(aCol0.z), shoes = lifeUnpack(aCol0.w);
      vec3 c;
      if (slot < 0.5) c = skin;
      else if (slot < 1.5) c = top;
      else if (slot < 2.5) c = bottom;
      else if (slot < 3.5) c = shoes;
      else if (slot < 4.5) c = lifeUnpack(aCol1.x);
      else if (slot < 5.5) c = lifeUnpack(aCol1.y);
      else if (slot < 6.5) c = lifeUnpack(aCol1.z);
      else if (slot < 7.5) c = aStyle.w < 0.5 ? bottom : (aStyle.w < 1.5 ? skin : lifeUnpack(aCol1.w));
      else if (slot < 8.5) c = vec3(0.018);
      else if (slot < 9.5) c = vec3(0.06, 0.08, 0.12);
      else if (slot < 10.5) c = aBody.w > 0.5 ? skin : top;
      else if (slot < 11.5) c = vec3(0.5, 0.52, 0.55);
      else if (slot < 12.5) c = vec3(0.62, 0.6, 0.57);
      else if (slot < 13.5) c = skin * vec3(0.62, 0.42, 0.4);
      else if (slot < 14.5) c = aStyle.w > 1.5 ? lifeUnpack(aCol1.w) : bottom;
      else c = aStyle.w < 0.5 ? bottom : (aStyle.w < 1.5 ? skin : lifeUnpack(aCol1.w));
      c *= 0.8 + 0.2 * smoothstep(0.0, 0.7, position.y);
      vLifeCol = c;
      vLifeGlow = (slot > 8.5 && slot < 9.5) ? vec3(0.45, 0.62, 1.0) * (0.2 + 1.6 * uLifeNight) : vec3(0.0);
    }
  `;
  const PEOPLE_INJ = { vHead: PEOPLE_VHEAD, call: 'lifePose(lifeP, objectNormal);',
    fHead: 'varying vec3 vLifeCol; varying vec3 vLifeGlow;',
    fColor: 'diffuseColor.rgb *= vLifeCol;', fEmissive: 'totalEmissiveRadiance += vLifeGlow;' };
  let peopleMat = null, peopleDepth = null;

  // Appearance palettes (sRGB hex). The corridor is diverse; so are the crowds.
  const SKINS = [0xf3d2b8, 0xeac0a0, 0xe0b18e, 0xcf9d78, 0xba845e, 0x9f6a47, 0x875638, 0x6b422b, 0x52321f];
  const HAIRS = [0x1a1512, 0x241b16, 0x33251b, 0x46301f, 0x5e4128, 0x7a4526, 0x9f7746, 0xc8a466, 0x2a2826];
  const GREYS = [0x8e8a84, 0xb3aea6, 0xd8d3ca, 0x6d6964];
  const TOPS = {
    commuter: [0x1e2a44, 0x3a3f46, 0x15171a, 0xe9e6df, 0x3f5f8a, 0x4a5a3a, 0x6b2a33, 0x8a8f96, 0x2e5e6b, 0x7a5c3e, 0xb58a45],
    office: [0xf1f1ee, 0xcfdcea, 0x9aa4ae, 0x2b3242, 0x39404a, 0xe3d9c6, 0x5a6e8c, 0x1f1f22],
    student: [0x8c1515, 0x1f2a4a, 0x5f6368, 0x2f4a3a, 0x6a2c70, 0xdcd8cf, 0x1d1d1f, 0xb34a2a, 0x3b6ea8],
    tourist: [0xf2c84b, 0x3fb3b0, 0xe8735a, 0xffffff, 0x7fb4e0, 0xd4467a, 0x8bc34a, 0xf0e4c8],
    cyclist: [0xf07a1d, 0xc6e03c, 0x2b7de9, 0xe23b3b, 0x1b1b1d, 0x14a38b, 0xf5f5f5],
    kid: [0xe53935, 0xfdd835, 0x1e88e5, 0x43a047, 0xab47bc, 0xff7043, 0x26c6da],
    senior: [0xc9b89a, 0x8fa9c9, 0xa99ac2, 0x7d8b6f, 0xd9cfc0, 0x5c6f8a, 0x9e6b5a],
  };
  const BOTTOMS = [0x2f3f5c, 0x24314a, 0x3b4f6b, 0x1d1f23, 0x55595f, 0xb49d74, 0x6b5a45, 0x3a4a3a, 0x8a8479, 0x1b2233];
  const SKIRTS = [0x1f2433, 0x7a2b3a, 0x3a4f7a, 0xc9b28c, 0x2f2f2f, 0x5b6e57, 0xd7a3a0];
  const SHOES = [0xe9e6df, 0x1b1b1b, 0x5a3b26, 0x3b3f46, 0xd9d3c7, 0x8a2c2c, 0x2d4a73, 0xf2f2f2];
  const ACCS = [0x1d1f22, 0x2b3a55, 0x4a4f55, 0x7a2626, 0x3e4d34, 0x6b5238, 0x1f5d64, 0xa0a4a8, 0xc46a2c, 0x2a2a2d];
  const HATS = [0x1d2b44, 0x7a1f1f, 0x2d2d2d, 0xc9b27c, 0x3b5b3b, 0xe0ddd5, 0x8c1515, 0xd8c7a0];
  const KINDS = ['commuter', 'office', 'student', 'tourist', 'cyclist', 'kid', 'senior'];
  const KIND_W = [30, 18, 16, 12, 8, 8, 8];
  const CARRY_W = {  // none, backpack, luggage, tote, phone, briefcase, bike
    commuter: [14, 44, 0, 10, 26, 6, 0], office: [14, 22, 0, 10, 30, 24, 0], student: [8, 68, 0, 2, 22, 0, 0],
    tourist: [8, 30, 45, 5, 10, 2, 0], cyclist: [4, 14, 0, 0, 2, 0, 80], kid: [55, 40, 0, 0, 5, 0, 0], senior: [55, 5, 5, 30, 5, 0, 0] };

  function makeLook(seed, kind) {
    const r = U.rng(seed);
    if (!kind || !CARRY_W[kind]) kind = KINDS[wpick(r, KIND_W)];
    const kid = kind === 'kid', senior = kind === 'senior';
    let hair = wpick(r, senior ? [18, 45, 12, 14, 5, 6] : kid ? [2, 40, 26, 8, 12, 12] : [4, 34, 28, 9, 13, 12]);
    const hr = r(); let hat = 0;
    if (kind === 'cyclist') hat = hr < 0.75 ? 3 : 0;
    else if (kind === 'tourist') hat = hr < 0.25 ? 1 : hr < 0.42 ? 4 : 0;
    else if (senior) hat = hr < 0.16 ? 4 : hr < 0.24 ? 1 : 0;
    else hat = hr < 0.08 ? 1 : hr < 0.14 ? 2 : 0;
    if (hat && hair === 4) hair = 1;
    const carry = wpick(r, CARRY_W[kind]);
    const bottom = wpick(r, kind === 'tourist' || kind === 'cyclist' ? [45, 42, 13] : kid ? [45, 35, 20] : [70, 8, 22]);
    const hairCol = senior ? pick(r, GREYS) : (r() < 0.04 ? pick(r, [0x7a2a4a, 0x3a5a8a, 0xb8563a]) : pick(r, HAIRS));
    const skin = pick(r, SKINS), tights = r() < 0.45 ? pick(r, [0x1c1c20, 0x262833, 0x4a3d3a]) : skin;
    return {
      kind,
      height: kid ? lerp(0.56, 0.78, r()) : lerp(0.92, 1.07, (r() + r()) / 2),
      girth: kid ? lerp(0.86, 1.0, r()) : lerp(0.88, 1.24, r() * r() * 0.8 + r() * 0.2),
      head: kid ? lerp(1.18, 1.3, r()) : 1.0,
      sleeves: (kind === 'tourist' || kind === 'cyclist' || kid) ? (r() < 0.65 ? 1 : 0) : (r() < 0.28 ? 1 : 0),
      style: [hair, hat, carry, bottom],
      skin, top: pick(r, TOPS[kind]), bottom: bottom === 2 ? pick(r, SKIRTS) : pick(r, BOTTOMS),
      shoes: pick(r, SHOES), hair: hairCol, acc: pick(r, ACCS), hat: pick(r, HATS), tights,
      idle: r(),
    };
  }

  function createPeople(max = 256, opts = {}) {
    if (!personGeo) personGeo = buildPersonGeometry();
    if (!peopleMat) {
      peopleMat = lifeMaterial('people', new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.0 }), PEOPLE_INJ);
      peopleDepth = depthMaterial('people', PEOPLE_INJ);
    }
    const geo = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'aMeta']) geo.setAttribute(k, personGeo.attributes[k]);
    geo.setIndex(personGeo.index);
    geo.boundingSphere = personGeo.boundingSphere.clone(); geo.boundingBox = personGeo.boundingBox.clone();
    const mk = (n, dyn) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n); if (dyn) a.setUsage(THREE.DynamicDrawUsage); return a; };
    const aAnim = mk(4, true), aBody = mk(4), aStyle = mk(4), aCol0 = mk(4), aCol1 = mk(4);
    geo.setAttribute('aAnim', aAnim); geo.setAttribute('aBody', aBody); geo.setAttribute('aStyle', aStyle);
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
      aBody.setXYZW(i, L.girth, L.head, L.idle, L.sleeves);
      aStyle.setXYZW(i, L.style[0], L.style[1], L.style[2], L.style[3]);
      aCol0.setXYZW(i, L.skin, L.top, L.bottom, L.shoes);
      aCol1.setXYZW(i, L.hair, L.acc, L.hat, L.tights);
      aAnim.setZ(i, L.idle * TAU * 7.0);
      aAnim.setW(i, 0.95 / Math.sqrt(L.height));
      aBody.needsUpdate = aStyle.needsUpdate = aCol0.needsUpdate = aCol1.needsUpdate = true; animDirty = true;
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
      // Seat person i given the eye position of a seated passenger (e.g. TrainKit car.seats[k]):
      // the hips land on a seat surface 0.46 m above the implied floor whatever the person's height.
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
      const H = 16, leaf = [0x69893a, 0x779744, 0x5d7c33, 0x84a14c], P = [], F = [];
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
      const H = 7.5, leaf = [0x78984a, 0x86a652, 0x6c8c40, 0x91ad5a], P = [], F = [];
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
  // road vehicle models (+X forward, origin on the ground at the vehicle center)
  // ------------------------------------------------------------------------------------------
  const GLASS = 0x1b232b, TIRE = 0x161616, RIM = 0x8e9399, LAMP = 0xdfe6ea, TAIL = 0x6a0c0c, TRIM = 0x202225;
  function glassSides(poly, halfW, parts) { // side windows as thin extruded polygons flush on both flanks
    parts.push(vp(extrudeXY(poly, 0.02, halfW - 0.004), GLASS, { rough: 0.08, metal: 0.1 }));
    parts.push(vp(extrudeXY(poly, 0.02, -halfW - 0.016), GLASS, { rough: 0.08, metal: 0.1 }));
  }
  function glassOnSegment(x0, y0, x1, y1, halfW, parts, glow) {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy); const nx = dy / len, ny = -dx / len;
    const g = new THREE.BoxGeometry(len, 0.03, halfW * 2); g.rotateZ(Math.atan2(dy, dx)); g.translate((x0 + x1) / 2 + nx * 0.012, (y0 + y1) / 2 + ny * 0.012, 0);
    parts.push(vp(g, GLASS, { rough: 0.06, metal: 0.1, glow: glow || 0 }));
  }
  function wheels(parts, xs, r, halfTrack, w = 0.22) {
    for (const x of xs) for (const s of [-1, 1]) {
      const t = new THREE.CylinderGeometry(r, r, w, 12); t.rotateX(Math.PI / 2); t.translate(x, r, s * halfTrack); parts.push(vp(t, TIRE, { rough: 0.9 }));
      const h = new THREE.CylinderGeometry(r * 0.6, r * 0.6, w + 0.012, 10); h.rotateX(Math.PI / 2); h.translate(x, r, s * halfTrack); parts.push(vp(h, RIM, { rough: 0.3, metal: 0.8 }));
    }
  }
  function lights(parts, xf, xr, yf, yr, zf, zr, wf = 0.3, wr = 0.34) {
    for (const s of [-1, 1]) {
      parts.push(vp(box(0.05, 0.09, wf, xf, yf, s * zf), LAMP, { glow: 1, rough: 0.1 }));
      parts.push(vp(box(0.05, 0.08, wr, xr, yr, s * zr), TAIL, { glow: 2, rough: 0.2 }));
    }
  }
  const VEHICLES = {
    sedan() {
      const P = [], hw = 0.91;
      P.push(vp(extrudeXY([[-2.35, 0.3], [2.3, 0.3], [2.37, 0.5], [2.3, 0.72], [1.25, 0.86], [0.5, 1.36], [-0.85, 1.4], [-1.75, 0.97], [-2.33, 0.9], [-2.38, 0.52]], hw * 2, -hw), 0xffffff, { paint: 1, rough: 0.28, metal: 0.45 }));
      glassSides([[1.17, 0.9], [0.52, 1.32], [-0.83, 1.35], [-1.66, 0.97]], hw, P);
      glassOnSegment(1.24, 0.87, 0.51, 1.35, hw - 0.1, P); glassOnSegment(-0.86, 1.38, -1.74, 0.98, hw - 0.12, P);
      wheels(P, [1.42, -1.42], 0.34, 0.8); lights(P, 2.33, -2.36, 0.63, 0.8, 0.6, 0.58);
      P.push(vp(box(0.03, 0.12, 0.72, 2.36, 0.45, 0), TRIM, { rough: 0.5 }));
      P.push(vp(box(4.0, 0.02, 1.6, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 4.7 };
    },
    suv() {
      const P = [], hw = 0.965;
      P.push(vp(extrudeXY([[-2.42, 0.36], [2.36, 0.36], [2.43, 0.62], [2.36, 0.98], [1.5, 1.06], [0.95, 1.68], [-2.15, 1.72], [-2.4, 1.58], [-2.44, 0.62]], hw * 2, -hw), 0xffffff, { paint: 1, rough: 0.3, metal: 0.4 }));
      glassSides([[1.42, 1.1], [0.95, 1.62], [-2.05, 1.65], [-2.3, 1.52], [-2.31, 1.12]], hw, P);
      glassOnSegment(1.49, 1.08, 0.96, 1.66, hw - 0.1, P); glassOnSegment(-2.17, 1.7, -2.39, 1.57, hw - 0.14, P);
      wheels(P, [1.48, -1.5], 0.38, 0.85, 0.25); lights(P, 2.41, -2.43, 0.8, 1.2, 0.64, 0.66);
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
      wheels(P, [1.75, -1.85], 0.4, 0.86, 0.27); lights(P, 2.8, -2.82, 0.86, 0.92, 0.66, 0.7, 0.3, 0.22);
      P.push(vp(box(4.8, 0.02, 1.8, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 5.6 };
    },
    van() {
      const P = [], hw = 1.0;
      P.push(vp(extrudeXY([[-2.65, 0.36], [2.55, 0.36], [2.66, 0.75], [2.4, 1.2], [1.7, 1.98], [-2.6, 2.05], [-2.66, 0.75]], hw * 2, -hw), 0xffffff, { paint: 1, rough: 0.35, metal: 0.3 }));
      glassSides([[1.62, 1.28], [1.56, 1.88], [-1.8, 1.9], [-1.8, 1.28]], hw, P);
      glassOnSegment(2.38, 1.24, 1.71, 1.95, hw - 0.1, P);
      wheels(P, [1.8, -1.75], 0.37, 0.86, 0.24); lights(P, 2.62, -2.67, 0.9, 1.1, 0.68, 0.72);
      P.push(vp(box(4.6, 0.02, 1.8, 0, 0.03, 0), 0x1c1c1c, { rough: 1 }));
      return { geo: U.mergeGeometries(P), len: 5.3 };
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
  const CAR_PAINT = [[0xeceeef, 22], [0x16181b, 18], [0x6d7277, 15], [0xaeb3b8, 14], [0x2c4f82, 8], [0x9e1b1b, 7], [0x1f2c44, 4],
    [0x3c5a44, 2], [0xb9a98a, 2], [0xc46a2c, 1], [0x2a6f78, 2], [0x5b2a3a, 1], [0xd8c24a, 1], [0x3b3b41, 3]];
  const BUS_PAINT = [0x1f4e8c, 0xb32d2a, 0x2f7d4a, 0x1b7f86, 0x2a3b5c];
  const VEH_TYPES = ['sedan', 'suv', 'pickup', 'van', 'bus', 'truck'];
  const vehCache = {};
  const vehModel = t => vehCache[t] || (vehCache[t] = VEHICLES[t]());

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
    for (const t of VEH_TYPES) {
      const base = vehModel(t).geo; const geo = new THREE.BufferGeometry();
      for (const k of Object.keys(base.attributes)) geo.setAttribute(k, base.attributes[k]);
      if (!base.boundingSphere) base.computeBoundingSphere();
      geo.boundingSphere = base.boundingSphere.clone();
      const inst = new THREE.InstancedBufferAttribute(new Float32Array(maxCars * 4), 4); inst.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aInst', inst);
      const mesh = new THREE.InstancedMesh(geo, roadMat.m, maxCars); mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.customDepthMaterial = roadMat.d; mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'traffic-' + t; mesh.count = 0;
      mesh.boundingSphere = new THREE.Sphere(new V3(), 1);
      meshes[t] = { mesh, inst }; group.add(mesh);
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
      for (const t of VEH_TYPES) meshes[t].mesh.count = 0;
      for (const lane of lanes) {
        const want = Math.min(Math.round(lane.len / 1000 * density * lerp(0.7, 1.3, r())), maxCars - cars.length);
        if (want <= 0) continue;
        for (let k = 0; k < want; k++) {
          const wts = VEH_TYPES.map(t => (t === 'bus' && !lane.busOK) ? 0 : t === 'truck' ? typeW[t] * (lane.fast ? 1.6 : 0.6) : typeW[t]);
          const type = VEH_TYPES[wpick(r, wts)], M = meshes[type];
          const paint = type === 'bus' ? pick(r, BUS_PAINT) : CAR_PAINT[wpick(r, CAR_PAINT.map(c => c[1]))][0];
          const v0 = lane.speed * lerp(0.86, 1.1, r()) * (type === 'truck' || type === 'bus' ? 0.9 : 1);
          const car = { lane, s: 0, v: v0 * 0.85, v0, type, len: vehModel(type).len, brake: 0, seg: 0, slot: M.mesh.count++ };
          M.inst.setXYZW(car.slot, paint, 0, 0, r() * 10);
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
      for (const t of VEH_TYPES) { meshes[t].mesh.boundingSphere.copy(sphere); meshes[t].inst.needsUpdate = true; }
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
        for (let i = 0; i < cars.length; i++) {
          const c = cars[i], m = meshes[c.type], lane = c.lane;
          const fade = clamp(c.s / 6, 0, 1) * clamp((lane.len - c.s) / 6, 0, 1);
          if (fade <= 0) { m.mesh.setMatrixAt(c.slot, _zero); continue; }
          locate(lane, c.s, c);
          pointAt(lane, c.s + 2.5, ahead); pointAt(lane, c.s - 2.5, behind);
          const dx = ahead.x - behind.x, dz = ahead.z - behind.z, dy = ahead.y - behind.y;
          const yaw = Math.atan2(-dz, dx), pitch = Math.atan2(dy, Math.hypot(dx, dz));
          _e.set(0, yaw, pitch, 'YZX'); _q.setFromEuler(_e); _s.set(fade, fade, fade);
          _m.compose(pos, _q, _s); m.mesh.setMatrixAt(c.slot, _m);
          m.inst.setY(c.slot, c.brake);
          if (lit) {
            _v2.set(Math.cos(yaw), 0, -Math.sin(yaw)).multiplyScalar(c.len * 0.5 + 6).add(pos); _v2.y += 0.08;
            _q.setFromAxisAngle(_up, yaw); _s.set(11 * fade, 1, 5.5 * fade); _m.compose(_v2, _q, _s); pools.setMatrixAt(pi++, _m);
          }
        }
        for (const t of VEH_TYPES) { const M = meshes[t]; if (M.mesh.count) { M.mesh.instanceMatrix.needsUpdate = true; M.inst.needsUpdate = true; } }
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
    P.push(vp(box(0.5, 0.2, 0.4, (L0 + L1) * 0.45, R + 0.1, 0), 0x440000, { glow: 6 }));
    P.push(vp(box(0.5, 0.2, 0.4, (L0 + L1) * 0.45, -R - 0.1, 0), 0x440000, { glow: 6 }));
    // landing gear (collapsed in the shader when retracted)
    const gy = -R, gh = o.gearH - R;
    P.push(vp(box(0.25, gh, 0.25, L1 - 2.5, gy - gh / 2, 0), 0x7c8187, { gear: 1, metal: 0.6, rough: 0.4 }));
    { const w = new THREE.CylinderGeometry(0.45, 0.45, 0.5, 10); w.rotateX(Math.PI / 2); w.translate(L1 - 2.5, -o.gearH + 0.45, 0); P.push(vp(w, TIRE, { gear: 1, rough: 0.9 })); }
    P.push(vp(box(0.35, 0.3, 0.3, L1 - 2.3, gy - gh * 0.3, 0), 0xdddddd, { gear: 1, glow: 1 }));
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
      for (const s of [-1, 1]) P.push(vp(box(0.2, 0.15, 0.15, 1.1, 0.95, s * 5.5), s < 0 ? 0x550000 : 0x004400, { glow: s < 0 ? 2 : 3 }));
      P.push(vp(box(0.2, 0.15, 0.2, 1.8, 0.95, -1.3), 0xdddddd, { glow: 1 }));
      P.push(vp(box(0.2, 0.2, 0.2, -4.4, 1.75, 0), 0x440000, { glow: 6 }));
      return { geo: U.mergeGeometries(P), gearH: 1.15 };
    },
  };
  const planeCache = {}; const planeModel = t => planeCache[t] || (planeCache[t] = PLANES[t]());
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
        f.meshes[t] = { mesh, inst, cap: f.cap[i], gearH: planeModel(t).gearH }; f.list.push(f.meshes[t]); group.add(mesh);
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
        for (const k in fields) for (const m of fields[k].list) { m.mesh.instanceMatrix.needsUpdate = true; m.inst.needsUpdate = true; }
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
    const K = { gull: { L: 0.44, S: 0.7, body: 0xf4f4f2, wing: 0xb9bfc5, tip: 0x1a1a1a, bill: 0xe0b020 },
      pelican: { L: 1.15, S: 1.15, body: 0x8a7b68, wing: 0x6b5d4f, tip: 0x2a2520, bill: 0xb89a6a },
      crow: { L: 0.45, S: 0.46, body: 0x141416, wing: 0x18181b, tip: 0x0e0e10, bill: 0x111111 },
      pigeon: { L: 0.32, S: 0.33, body: 0x80838c, wing: 0x8e919a, tip: 0x3a3c42, bill: 0x2a2a2a } }[kind];
    const L = K.L, S = K.S;
    add(sph(1, 7, 5, 0, 0, 0, L * 0.5, L * 0.16, L * 0.16), K.body, 0, 0);
    add(sph(L * 0.11, 6, 4, L * 0.46, L * 0.06, 0), kind === 'pelican' ? 0xe8e0cc : K.body, 0, 0);
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
        pos = aB0.xyz + vec3(cos(ang) * aB0.w, fly * 2.4, -sin(ang) * aB0.w);
        yaw = ang - 1.5708;
        pitch = -0.45 * max(0.0, sin(t * 3.1 + ph * 7.0)) * (1.0 - fly) * step(0.4, fract(t * 0.2 + ph));
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
    TREE_KINDS: Object.keys(TREE_BUILDERS), PERSON: { standEye: 1.60, sitEye: 1.17, seatHeight: 0.46, height: 1.72 } };
})();
