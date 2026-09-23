// TrainKit — Bayline rolling stock (trains agent). See notes/trains.md for the full API and conventions.
//   'emu'    : 7-car double-deck EMU (Stadler-KISS-like), cab cars both ends, 2 bike cars, 1 restroom car.
//   'diesel' : MP36-like diesel-electric loco (car 0, south end) + 4 bilevel coaches + bilevel cab car (north end).
// Car-local frame: origin at car center, y = 0 at top of rail, +X toward the consist front, +Y up, +Z right.
// Geometry is built once per car design and shared by every consist. Per-consist state (lights, doors,
// signs, screens) lives in small materials, canvases and instance matrices, so dozens of trains are cheap.
// Every opaque part of a car (body, bogies, interior, lamps) uses ONE MeshStandardMaterial whose maps are a
// 64x1 "PBR palette": each part's UVs point at one texel (albedo, roughness/metalness, light-group weights).
const TrainKit = (() => {
  const { clamp, lerp, smooth } = U;
  const V3 = THREE.Vector3;

  // ------------------------------------------------------------------------------------------ palette
  // em = weights of the four light groups [interior lights, head lamps, tail/marker lamps, interior ambient].
  // win = 1 for far-LOD window panes that glow warm at night.
  const PAL = [], PI = Object.create(null), PALN = 64;
  const IN = [0, 0, 0, 1];
  function pal(name, hex, rough, metal, em, win) { PI[name] = PAL.length; PAL.push({ hex, rough, metal, em: em || [0, 0, 0, 0], win: win || 0 }); }
  // exterior
  pal('body', '#e3e6e9', 0.3, 0.62);     // brushed stainless / white
  pal('bodyLo', '#a9aeb4', 0.42, 0.55);  // lower skirt
  pal('band', '#24282e', 0.24, 0.3);     // charcoal window band
  pal('red', '#c4122f', 0.3, 0.05);      // signal red
  pal('redDk', '#86101f', 0.45, 0.05);
  pal('black', '#0c0d0f', 0.6, 0.15);
  pal('rubber', '#17191c', 0.92, 0);
  pal('frame', '#2a2d32', 0.55, 0.5);    // bogies, underframe
  pal('frameLt', '#474b52', 0.5, 0.5);
  pal('steel', '#83888f', 0.35, 0.85);
  pal('wheel', '#6a6661', 0.38, 0.85);
  pal('rust', '#5d4838', 0.85, 0.25);
  pal('roof', '#9ca1a7', 0.55, 0.45);
  pal('roofDk', '#5d6269', 0.6, 0.4);
  pal('grille', '#31353b', 0.7, 0.45);
  pal('insul', '#7a3a2b', 0.3, 0.0);     // glazed ceramic insulators
  pal('copper', '#b87840', 0.32, 1);
  pal('brass', '#c9a24a', 0.3, 1);
  pal('chrome', '#d5d9dd', 0.16, 1);
  pal('yellow', '#e2b01c', 0.45, 0.05);
  pal('white', '#f2f2ef', 0.5, 0.0);
  pal('headLamp', '#f7f3e6', 0.1, 0.2, [0, 1, 0, 0]);
  pal('tailLamp', '#d3111e', 0.15, 0.1, [0, 0, 1, 0]);
  pal('lampRim', '#15171a', 0.3, 0.6);
  pal('lodGlass', '#1b242b', 0.1, 0.4, null, 1);
  pal('glassDk', '#11171c', 0.08, 0.5);
  // interior
  pal('floor', '#55595f', 0.85, 0, IN);
  pal('floorLt', '#7b7f85', 0.8, 0.1, IN);
  pal('stepEdge', '#e0ad1a', 0.6, 0, IN);
  pal('wall', '#eae8e3', 0.6, 0, IN);
  pal('panel', '#cdd0d3', 0.5, 0.1, IN);
  pal('panelDk', '#8d9298', 0.5, 0.25, IN);
  pal('ceiling', '#f3f2ee', 0.7, 0, IN);
  pal('light', '#fffaf0', 0.3, 0, [1.6, 0, 0, 1]);
  pal('seat', '#2c4c63', 0.9, 0, IN);     // moquette, bay blue
  pal('seatAlt', '#3f6d88', 0.9, 0, IN);
  pal('seatShell', '#b8bdc3', 0.45, 0.1, IN);
  pal('seatDk', '#33373d', 0.6, 0.2, IN);
  pal('headrest', '#b1162f', 0.8, 0, IN);
  pal('pole', '#c9ced3', 0.22, 1, IN);
  pal('table', '#a59b8d', 0.45, 0, IN);
  pal('bikeRack', '#c4122f', 0.35, 0.2, IN);
  pal('tire', '#1c1d1f', 0.9, 0, IN);
  pal('bikeFrame', '#ececec', 0.35, 0.3, IN);  // tinted per bike instance
  pal('wc', '#dddad3', 0.35, 0.05, IN);
  pal('btnGreen', '#35d46e', 0.3, 0, [1.3, 0, 0, 1]);
  pal('btnYellow', '#f2c230', 0.3, 0, [1.3, 0, 0, 1]);
  pal('btnRed', '#e0303c', 0.3, 0, [1.1, 0, 0, 1]);
  pal('desk', '#2a2d31', 0.6, 0.2, IN);
  pal('deskLt', '#4b5057', 0.5, 0.25, IN);
  pal('cabSeat', '#1e2125', 0.8, 0, IN);
  pal('screenOff', '#07090b', 0.2, 0.3, IN);
  pal('bellowsIn', '#3f4247', 0.9, 0, IN);
  pal('wood', '#8a6a48', 0.55, 0, IN);
  pal('blueSign', '#1f5fa8', 0.5, 0, [0.6, 0, 0, 1]);
  if (PAL.length > PALN) throw new Error('TrainKit palette overflow');
  const palU = name => { const i = PI[name]; if (i === undefined) throw new Error('TrainKit: unknown palette entry ' + name); return (i + 0.5) / PALN; };

  let palTexs = null;
  function palTextures() {
    if (palTexs) return palTexs;
    const mk = (fill, cs) => {
      const d = new Uint8Array(PALN * 4); PAL.forEach((p, i) => fill(p, d, i * 4));
      const t = new THREE.DataTexture(d, PALN, 1); t.colorSpace = cs; t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false; t.needsUpdate = true; return t;
    };
    palTexs = {
      albedo: mk((p, d, o) => { const h = parseInt(p.hex.slice(1), 16); d[o] = h >> 16; d[o + 1] = (h >> 8) & 255; d[o + 2] = h & 255; d[o + 3] = 255; }, THREE.SRGBColorSpace),
      orm: mk((p, d, o) => { d[o] = p.win * 255; d[o + 1] = Math.round(p.rough * 255); d[o + 2] = Math.round(p.metal * 255); d[o + 3] = 255; }, THREE.NoColorSpace),
      em: mk((p, d, o) => { for (let k = 0; k < 4; k++) d[o + k] = Math.round(clamp(p.em[k] / 2, 0, 1) * 255); }, THREE.NoColorSpace),
    };
    return palTexs;
  }
  // One per car: uLv = (interior lights, head lamps, tail lamps, interior ambient), uWin = lit-window glow.
  function palMaterial() {
    const t = palTextures();
    const m = new THREE.MeshStandardMaterial({ map: t.albedo, roughnessMap: t.orm, metalnessMap: t.orm, emissiveMap: t.em,
      emissive: 0xffffff, roughness: 1, metalness: 1 });
    const lv = { value: new THREE.Vector4(0, 0, 0, 0.2) }, win = { value: 0 };
    m.userData.lv = lv.value; m.userData.win = win;
    m.onBeforeCompile = sh => {
      sh.uniforms.uLv = lv; sh.uniforms.uWin = win;
      sh.fragmentShader = 'uniform vec4 uLv;\nuniform float uWin;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>',
        'vec4 tkEm = texture2D( emissiveMap, vEmissiveMapUv ) * 2.0;\n' +
        'totalEmissiveRadiance = diffuseColor.rgb * ( dot( tkEm.rgb, uLv.rgb ) + tkEm.a * uLv.w * vec3( 1.0, 0.9, 0.76 ) ) + vec3( 1.0, 0.68, 0.38 ) * texture2D( roughnessMap, vRoughnessMapUv ).r * uWin;');
    };
    m.customProgramCacheKey = () => 'tk-pal-2';
    return m;
  }

  // ------------------------------------------------------------------------------------------ geometry helpers
  const UBOX = new THREE.BoxGeometry(1, 1, 1);
  const _cyl = {}, ucyl = seg => _cyl[seg] || (_cyl[seg] = new THREE.CylinderGeometry(0.5, 0.5, 1, seg, 1));
  const _cone = {}, ucone = (seg, top) => _cone[seg + ':' + top] || (_cone[seg + ':' + top] = new THREE.CylinderGeometry(top * 0.5, 0.5, 1, seg, 1));
  const UTORUS = new THREE.TorusGeometry(0.5, 0.06, 5, 18);
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _eu = new THREE.Euler(), _p3 = new V3(), _s3 = new V3(), _d3 = new V3(), _Y = new V3(0, 1, 0);

  function setPal(g, name) {
    const u = palU(name), n = g.attributes.position.count, uv = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) { uv[2 * k] = u; uv[2 * k + 1] = 0.5; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    return g;
  }
  function xform(g, px, py, pz, q, sx, sy, sz) { const c = g.clone(); _m4.compose(_p3.set(px, py, pz), q, _s3.set(sx, sy, sz)); c.applyMatrix4(_m4); return c; }
  const uniq = a => { a.sort((p, q) => p - q); const o = []; for (const v of a) if (!o.length || v - o[o.length - 1] > 1e-4) o.push(v); return o; };

  // Collects palette-mapped parts; geo() merges them into one BufferGeometry.
  class Parts {
    constructor() { this.g = []; }
    push(g, name) { this.g.push(name ? setPal(g, name) : g); return this; }
    box(name, x0, y0, z0, x1, y1, z1) {
      return this.push(xform(UBOX, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, _q.identity(), Math.abs(x1 - x0) || 1e-3, Math.abs(y1 - y0) || 1e-3, Math.abs(z1 - z0) || 1e-3), name);
    }
    boxR(name, cx, cy, cz, sx, sy, sz, rx = 0, ry = 0, rz = 0) { _q.setFromEuler(_eu.set(rx, ry, rz)); return this.push(xform(UBOX, cx, cy, cz, _q, sx, sy, sz), name); }
    rod(name, ax, ay, az, bx, by, bz, r, seg = 8, top = 1) {
      _d3.set(bx - ax, by - ay, bz - az); const len = _d3.length(); if (len < 1e-5) return this;
      _q.setFromUnitVectors(_Y, _d3.multiplyScalar(1 / len));
      return this.push(xform(top === 1 ? ucyl(seg) : ucone(seg, top), (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, _q, 2 * r, len, 2 * r), name);
    }
    cyl(name, cx, cy, cz, r, len, axis = 'y', seg = 12) {
      const h = len / 2, ax = axis === 'x' ? h : 0, ay = axis === 'y' ? h : 0, az = axis === 'z' ? h : 0;
      return this.rod(name, cx - ax, cy - ay, cz - az, cx + ax, cy + ay, cz + az, r, seg);
    }
    // torus of radius r (tube = 0.12 r), axis along local Z before rotation
    torus(name, cx, cy, cz, r, rx = 0, ry = 0, rz = 0) { _q.setFromEuler(_eu.set(rx, ry, rz)); return this.push(xform(UTORUS, cx, cy, cz, _q, 2 * r, 2 * r, 2 * r), name); }
    geo() { const g = U.mergeGeometries(this.g); this.g = []; return g; }
  }

  // Non-indexed triangle soup with explicit normals and per-vertex uv (palette or custom).
  class Tri {
    constructor() { this.p = []; this.n = []; this.t = []; }
    v(x, y, z, nx, ny, nz, u, w) { this.p.push(x, y, z); this.n.push(nx, ny, nz); this.t.push(u, w); }
    // a,b,c,d counter-clockwise seen from the front; uvs: palette name or [[u,v]x4]
    quad(pal, a, b, c, d, n, uvs) {
      if (!n) n = fnorm(a, b, c);
      const u = typeof pal === 'string' ? palU(pal) : 0;
      const T = uvs || [[u, 0.5], [u, 0.5], [u, 0.5], [u, 0.5]];
      this.v(a[0], a[1], a[2], n[0], n[1], n[2], T[0][0], T[0][1]); this.v(b[0], b[1], b[2], n[0], n[1], n[2], T[1][0], T[1][1]); this.v(c[0], c[1], c[2], n[0], n[1], n[2], T[2][0], T[2][1]);
      this.v(a[0], a[1], a[2], n[0], n[1], n[2], T[0][0], T[0][1]); this.v(c[0], c[1], c[2], n[0], n[1], n[2], T[2][0], T[2][1]); this.v(d[0], d[1], d[2], n[0], n[1], n[2], T[3][0], T[3][1]);
    }
    tri(pal, a, b, c, na, nb, nc) {
      const u = palU(pal); if (!na) na = nb = nc = fnorm(a, b, c);
      this.v(a[0], a[1], a[2], na[0], na[1], na[2], u, 0.5); this.v(b[0], b[1], b[2], nb[0], nb[1], nb[2], u, 0.5); this.v(c[0], c[1], c[2], nc[0], nc[1], nc[2], u, 0.5);
    }
    // horizontal rectangle, facing up (up=true) or down
    hq(pal, x0, x1, z0, z1, y, up = true) {
      if (up) this.quad(pal, [x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], [0, 1, 0]);
      else this.quad(pal, [x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, -1, 0]);
    }
    // rectangle in plane x = const, normal s*X
    xq(pal, x, z0, z1, y0, y1, s) {
      if (s > 0) this.quad(pal, [x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1], [1, 0, 0]);
      else this.quad(pal, [x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0], [-1, 0, 0]);
    }
    // rectangle in plane z = const, normal s*Z
    zq(pal, z, x0, x1, y0, y1, s) {
      if (s > 0) this.quad(pal, [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, 1]);
      else this.quad(pal, [x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z], [0, 0, -1]);
    }
    // axis-aligned slab with separate palettes for top / bottom / sides (sides: null to skip)
    slab(x0, x1, z0, z1, yb, yt, top, bot, side) {
      if (top) this.hq(top, x0, x1, z0, z1, yt, true);
      if (bot) this.hq(bot, x0, x1, z0, z1, yb, false);
      if (side) { this.xq(side, x1, z0, z1, yb, yt, 1); this.xq(side, x0, z0, z1, yb, yt, -1); this.zq(side, z1, x0, x1, yb, yt, 1); this.zq(side, z0, x0, x1, yb, yt, -1); }
    }
    geo() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.n), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.t), 2));
      return g;
    }
  }
  function fnorm(a, b, c) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  }

  // Flat wall on a grid: rectangle [u0,u1]x[v0,v1] in (x,y) mapped to 3D by map(u,v); holes are skipped,
  // every remaining cell takes colorAt(um, vm). Cells of equal color are merged vertically.
  // n = outward normal (constant for flat walls) or a function (u,v) -> normal.
  function wallGrid(T, u0, u1, v0, v1, holes, colorAt, map, n, us = [], vs = []) {
    const inRange = (v, a, b) => v >= a - 1e-6 && v <= b + 1e-6;
    const U_ = uniq([u0, u1, ...us, ...holes.flatMap(h => [h.x0, h.x1])].filter(v => inRange(v, u0, u1)));
    const V_ = uniq([v0, v1, ...vs, ...holes.flatMap(h => [h.y0, h.y1])].filter(v => inRange(v, v0, v1)));
    const emit = (ua, ub, va, vb, pal) => {
      let a = map(ua, va), b = map(ub, va), c = map(ub, vb), d = map(ua, vb);
      const nn = typeof n === 'function' ? n((ua + ub) / 2, (va + vb) / 2) : n;
      const f = fnorm(a, b, c); if (f[0] * nn[0] + f[1] * nn[1] + f[2] * nn[2] < 0) { const t = a; a = b; b = t; const t2 = c; c = d; d = t2; }
      T.quad(pal, a, b, c, d, nn);
    };
    for (let i = 0; i < U_.length - 1; i++) {
      const ua = U_[i], ub = U_[i + 1], um = (ua + ub) / 2; let run = -1, runPal = null;
      for (let j = 0; j < V_.length; j++) {
        let p = null;
        if (j < V_.length - 1) {
          const vm = (V_[j] + V_[j + 1]) / 2;
          const hole = holes.some(h => um > h.x0 && um < h.x1 && vm > h.y0 && vm < h.y1);
          p = hole ? null : colorAt(um, vm);
        }
        if (p !== runPal) { if (runPal) emit(ua, ub, V_[run], V_[j], runPal); run = j; runPal = p; }
      }
    }
  }
  // Extrude a 2D profile [[z,y],...] along x in [x0,x1]; normals point away from (zc,yc); smooth below 40 deg.
  function extrudeX(T, prof, x0, x1, palOf, zc = 0, yc = 2.2) {
    const m = [];
    for (let i = 0; i < prof.length - 1; i++) {
      const [za, ya] = prof[i], [zb, yb] = prof[i + 1]; let nz = yb - ya, ny = -(zb - za); const l = Math.hypot(nz, ny) || 1; nz /= l; ny /= l;
      if (nz * ((za + zb) / 2 - zc) + ny * ((ya + yb) / 2 - yc) < 0) { nz = -nz; ny = -ny; }
      m.push([nz, ny]);
    }
    const sm = (a, b) => { if (!a || !b || a[0] * b[0] + a[1] * b[1] < 0.766) return null; const z = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(z, y); return [z / l, y / l]; };
    for (let i = 0; i < prof.length - 1; i++) {
      const [za, ya] = prof[i], [zb, yb] = prof[i + 1]; if (Math.hypot(zb - za, yb - ya) < 1e-6) continue;
      const na = sm(m[i - 1], m[i]) || m[i], nb = sm(m[i], m[i + 1]) || m[i];
      let A = [x0, ya, za], B = [x1, ya, za], C = [x1, yb, zb], D = [x0, yb, zb];
      const f = fnorm(A, B, C), pal = palOf(i, (ya + yb) / 2, (za + zb) / 2);
      if (!pal) continue;
      const u = palU(pal);
      if (f[1] * m[i][1] + f[2] * m[i][0] >= 0) {
        T.v(...A, 0, na[1], na[0], u, 0.5); T.v(...B, 0, na[1], na[0], u, 0.5); T.v(...C, 0, nb[1], nb[0], u, 0.5);
        T.v(...A, 0, na[1], na[0], u, 0.5); T.v(...C, 0, nb[1], nb[0], u, 0.5); T.v(...D, 0, nb[1], nb[0], u, 0.5);
      } else {
        T.v(...A, 0, na[1], na[0], u, 0.5); T.v(...D, 0, nb[1], nb[0], u, 0.5); T.v(...C, 0, nb[1], nb[0], u, 0.5);
        T.v(...A, 0, na[1], na[0], u, 0.5); T.v(...C, 0, nb[1], nb[0], u, 0.5); T.v(...B, 0, na[1], na[0], u, 0.5);
      }
    }
  }
  // Flat cap in plane x = xc filling a closed profile polygon [[z,y],...] (convex-ish), with an optional
  // rectangular hole {z0,z1,y0,y1}. Uses THREE.ShapeGeometry (earcut) then maps into place.
  function capX(parts, prof, xc, s, pal, hole) {
    const sh = new THREE.Shape(prof.map(([z, y]) => new THREE.Vector2(z, y)));
    if (hole) { const h = new THREE.Path(); h.moveTo(hole.z0, hole.y0); h.lineTo(hole.z1, hole.y0); h.lineTo(hole.z1, hole.y1); h.lineTo(hole.z0, hole.y1); h.lineTo(hole.z0, hole.y0); sh.holes.push(h); }
    const g = new THREE.ShapeGeometry(sh, 1);
    // shape lies in XY (x = our z, y = our y) with normal +Z. Rotate so shape-x -> -Z*s ... map explicitly:
    const pos = g.attributes.position, nor = g.attributes.normal;
    for (let i = 0; i < pos.count; i++) { const z = pos.getX(i), y = pos.getY(i); pos.setXYZ(i, xc, y, z); nor.setXYZ(i, s, 0, 0); }
    // winding: shape was CCW in (z,y) seen from +Z_shape; after mapping (z->Z, y->Y) seen from +X it is mirrored.
    if (s > 0) { const idx = g.index.array; for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } }
    parts.push(g, pal);
  }

  // ------------------------------------------------------------------------------------------ shared textures
  let _card = null, _glowTex = null, _atlas = null;
  const ATL = Object.create(null);   // decal atlas cells: name -> [u0, v0, u1, v1]
  // Emissive card for exterior window glass: a lit interior impression (ceiling strip, warm glow, seat backs).
  function windowCard() {
    if (_card) return _card;
    _card = U.canvasTexture(128, 128, (g, w, h) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      const gr = g.createLinearGradient(0, 0, 0, h * 0.9);
      gr.addColorStop(0, '#fff3d6'); gr.addColorStop(0.12, '#ffd9a0'); gr.addColorStop(0.5, '#c98a4a'); gr.addColorStop(0.9, '#6a4424');
      g.fillStyle = gr; g.fillRect(0, 0, w, h * 0.9);
      g.fillStyle = '#fffaf0'; g.fillRect(0, 4, w, 6);
      g.fillStyle = 'rgba(40,24,12,0.85)';
      for (let x = -8; x < w; x += 34) { g.beginPath(); g.roundRect ? g.roundRect(x, h * 0.5, 26, h * 0.4, 8) : g.rect(x, h * 0.5, 26, h * 0.4); g.fill(); }
      g.fillStyle = 'rgba(30,18,10,0.5)'; g.fillRect(0, h * 0.62, w, 3);
      g.fillStyle = '#000'; g.fillRect(0, h * 0.9, w, h * 0.1);   // v < 0.1 stays black (dark cab glass)
    });
    return _card;
  }
  function glowTex() {
    if (_glowTex) return _glowTex;
    _glowTex = U.canvasTexture(64, 64, (g, w, h) => {
      const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.18, 'rgba(255,255,255,0.75)'); r.addColorStop(0.45, 'rgba(255,255,255,0.18)'); r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, w, h);
    });
    return _glowTex;
  }
  const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  const NUMCH = 'BL0123456789- ';
  function decalAtlas() {
    if (_atlas) return _atlas;
    const W = 1024, H = 1024;
    _atlas = U.canvasTexture(W, H, g => {
      g.clearRect(0, 0, W, H);
      const cell = (name, x, y, w, h, draw) => { g.save(); g.translate(x, y); g.beginPath(); g.rect(0, 0, w, h); g.clip(); draw(w, h); g.restore(); ATL[name] = [(x + 1) / W, 1 - (y + h - 1) / H, (x + w - 1) / W, 1 - (y + 1) / H]; };
      const mark = (x, y, s, ink) => {   // Bayline mark: red roundel with a white bay wave and a rail line
        g.save(); g.translate(x, y); g.fillStyle = '#c4122f'; g.beginPath(); g.arc(0, 0, s, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#fff'; g.lineWidth = s * 0.16; g.lineCap = 'round';
        g.beginPath(); g.moveTo(-s * 0.62, s * 0.12); g.bezierCurveTo(-s * 0.3, -s * 0.28, 0, s * 0.42, s * 0.62, -s * 0.12); g.stroke();
        g.lineWidth = s * 0.1; g.beginPath(); g.moveTo(-s * 0.55, s * 0.46); g.lineTo(s * 0.55, s * 0.46); g.stroke();
        g.restore(); void ink;
      };
      const word = (ink) => (w, h) => {
        mark(h * 0.5, h * 0.5, h * 0.4, ink);
        g.fillStyle = ink; g.font = `italic 800 ${Math.round(h * 0.62)}px ${FONT}`; g.textBaseline = 'middle';
        g.fillText('BAYLINE', h * 1.05, h * 0.54);
      };
      cell('word', 0, 0, 640, 128, word('#23272d'));
      cell('wordW', 0, 128, 640, 128, word('#f4f4f2'));
      // glyphs for car numbers (charcoal), 64x96 cells
      for (let i = 0; i < NUMCH.length; i++) cell('g' + NUMCH[i], i * 64, 256, 64, 96, (w, h) => {
        g.fillStyle = '#23272d'; g.font = `700 ${Math.round(h * 0.86)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(NUMCH[i], w / 2, h * 0.54);
      });
      for (let i = 0; i < NUMCH.length; i++) cell('w' + NUMCH[i], i * 64, 352, 64, 96, (w, h) => {
        g.fillStyle = '#f4f4f2'; g.font = `700 ${Math.round(h * 0.86)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(NUMCH[i], w / 2, h * 0.54);
      });
      const sq = (bg) => (w, h) => { g.fillStyle = bg; g.beginPath(); g.roundRect ? g.roundRect(4, 4, w - 8, h - 8, 14) : g.rect(4, 4, w - 8, h - 8); g.fill(); g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round'; };
      cell('bike', 0, 448, 128, 128, (w, h) => {
        sq('#1f5fa8')(w, h);
        g.beginPath(); g.arc(34, 80, 20, 0, 7); g.stroke(); g.beginPath(); g.arc(94, 80, 20, 0, 7); g.stroke();
        g.beginPath(); g.moveTo(34, 80); g.lineTo(54, 50); g.lineTo(84, 50); g.lineTo(94, 80); g.moveTo(54, 50); g.lineTo(64, 80); g.lineTo(84, 50); g.moveTo(64, 80); g.lineTo(34, 80);
        g.moveTo(50, 40); g.lineTo(60, 40); g.moveTo(84, 50); g.lineTo(80, 36); g.lineTo(90, 34); g.stroke();
      });
      cell('wheelchair', 128, 448, 128, 128, (w, h) => {
        sq('#1f5fa8')(w, h);
        g.beginPath(); g.arc(58, 28, 9, 0, 7); g.fill();
        g.beginPath(); g.moveTo(56, 42); g.lineTo(56, 72); g.lineTo(82, 72); g.lineTo(92, 96); g.moveTo(56, 56); g.lineTo(78, 56); g.stroke();
        g.beginPath(); g.arc(58, 84, 22, 0.3, 5.6); g.stroke();
      });
      cell('wc', 256, 448, 128, 128, (w, h) => {
        sq('#1f5fa8')(w, h); g.font = `800 52px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('WC', 64, 58);
        g.font = `600 17px ${FONT}`; g.fillText('ACCESSIBLE', 64, 98);
      });
      cell('quiet', 384, 448, 128, 128, (w, h) => {
        sq('#3d6f86')(w, h); g.font = `800 30px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('QUIET', 64, 52); g.fillText('CAR', 64, 84);
      });
      cell('bikecar', 512, 448, 512, 96, (w, h) => {
        g.fillStyle = '#c4122f'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = `italic 800 64px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText('BIKE CAR', w / 2, h * 0.54);
      });
      cell('clear', 0, 592, 512, 48, (w, h) => {
        g.fillStyle = '#f2c230'; g.fillRect(0, 0, w, h); g.fillStyle = '#1b1b1b'; g.font = `800 28px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('STAND CLEAR OF THE DOORS', w / 2, h * 0.54);
      });
      cell('emerg', 512, 560, 256, 80, (w, h) => {
        g.fillStyle = '#c4122f'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = `800 26px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('EMERGENCY', w / 2, 26); g.font = `600 20px ${FONT}`; g.fillText('INTERCOM  ·  EXIT', w / 2, 58);
      });
      cell('upper', 768, 560, 256, 80, (w, h) => {
        g.fillStyle = '#23272d'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = `700 28px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('↑ UPPER LEVEL', w / 2, h / 2 + 1);
      });
      cell('priority', 0, 640, 512, 80, (w, h) => {
        g.fillStyle = '#1f5fa8'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = `700 30px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('PRIORITY SEATING', w / 2, h / 2 + 1);
      });
      cell('unofficial', 512, 640, 512, 80, (w, h) => {
        g.fillStyle = '#23272d'; g.font = `600 22px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('BAYLINE · PENINSULA CORRIDOR · BUILT FOR THE BAY', w / 2, h / 2);
      });
    }, { aniso: 8 });
    return _atlas;
  }
  let _atlasMat = null, _glowMat = null;
  const atlasMat = () => _atlasMat || (_atlasMat = new THREE.MeshStandardMaterial({ map: decalAtlas(), transparent: true, depthWrite: false, roughness: 0.35, metalness: 0.1, alphaTest: 0.02 }));
  const glowMat = () => _glowMat || (_glowMat = new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: true, map: glowTex(), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, vertexColors: true, toneMapped: false }));

  // Decal quads (atlas UVs). Plane z = zc facing s*Z, or x = xc facing s*X. Positioned by center + size.
  function decalZ(T, name, cx, cy, zc, w, h, s) {
    const [u0, v0, u1, v1] = ATL[name]; const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    if (s > 0) T.quad(null, [x0, y0, zc], [x1, y0, zc], [x1, y1, zc], [x0, y1, zc], [0, 0, 1], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
    else T.quad(null, [x1, y0, zc], [x0, y0, zc], [x0, y1, zc], [x1, y1, zc], [0, 0, -1], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
  }
  function decalX(T, name, xc, cy, cz, w, h, s) {
    const [u0, v0, u1, v1] = ATL[name]; const z0 = cz - w / 2, z1 = cz + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    if (s > 0) T.quad(null, [xc, y0, z1], [xc, y0, z0], [xc, y1, z0], [xc, y1, z1], [1, 0, 0], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
    else T.quad(null, [xc, y0, z0], [xc, y0, z1], [xc, y1, z1], [xc, y1, z0], [-1, 0, 0], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
  }
  // Text of glyph decals along a car side (reads left-to-right for a viewer facing that side).
  function numberZ(T, text, cx, cy, zc, gh, s, white) {
    const gw = gh * 0.58, n = text.length, x0 = cx - (n * gw) / 2;
    for (let i = 0; i < n; i++) {
      const ch = NUMCH.includes(text[i]) ? text[i] : ' '; if (ch === ' ') continue;
      const k = s > 0 ? i : n - 1 - i;   // viewer on +Z reads toward +X; on -Z toward -X
      decalZ(T, (white ? 'w' : 'g') + ch, x0 + (k + 0.5) * gw, cy, zc, gw * 1.02, gh, s);
    }
  }

  // ------------------------------------------------------------------------------------------ shared part builders
  // Orient a triangle so its geometric normal agrees with n, then emit it with that (flat) normal.
  function triFacing(T, pal, a, b, c, n) { const f = fnorm(a, b, c); if (f[0] * n[0] + f[1] * n[1] + f[2] * n[2] < 0) T.tri(pal, a, c, b, n, n, n); else T.tri(pal, a, b, c, n, n, n); }

  // Wheelset for instancing: origin at the axle center, axle along Z. Bolt pattern makes the spin visible.
  function wheelsetGeo(r) {
    const X = new Parts(), g = 0.7525;
    for (const s of [-1, 1]) {
      X.cyl('wheel', 0, 0, s * g, r, 0.13, 'z', 22);
      X.cyl('steel', 0, 0, s * (g - 0.075), r + 0.028, 0.022, 'z', 22);
      X.cyl('rust', 0, 0, s * (g + 0.066), r * 0.8, 0.008, 'z', 18);
      X.cyl('steel', 0, 0, s * (g + 0.07), 0.13, 0.03, 'z', 12);
      for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3, rr = r * 0.52;
        X.box('frameLt', Math.cos(a) * rr - 0.035, Math.sin(a) * rr - 0.035, s * (g + 0.07) - 0.008, Math.cos(a) * rr + 0.035, Math.sin(a) * rr + 0.035, s * (g + 0.07) + 0.012); }
      X.cyl('steel', 0, 0, s * 0.34, r * 0.66, 0.07, 'z', 18);   // brake disc
    }
    X.cyl('steel', 0, 0, 0, 0.085, 2 * g + 0.34, 'z', 10);
    return X.geo();
  }
  // Two-axle bogie frame (static, part of the car's exterior mesh). wb = wheelbase, r = wheel radius.
  function bogie(X, bx, wb, r, motor, heavy) {
    const fy0 = r + 0.06, fy1 = r + 0.36, zf = heavy ? 1.08 : 0.98;
    for (const s of [-1, 1]) {
      X.box('frame', bx - wb / 2 - 0.35, fy0, s * zf - 0.075, bx + wb / 2 + 0.35, fy1, s * zf + 0.075);
      X.box('frameLt', bx - wb / 2 + 0.3, fy0 + 0.04, s * (zf + 0.08) - 0.01, bx + wb / 2 - 0.3, fy1 - 0.04, s * (zf + 0.08) + 0.01);
      if (!heavy) X.cyl('rubber', bx, fy1 + 0.12, s * zf, 0.25, 0.22, 'y', 14);
      else X.cyl('steel', bx, fy1 + 0.1, s * zf, 0.16, 0.2, 'y', 10);
      for (const a of [-1, 1]) {
        const ax = bx + a * wb / 2;
        X.box('frame', ax - 0.2, r - 0.14, s * zf - 0.1, ax + 0.2, r + 0.12, s * zf + 0.1);
        X.cyl('steel', ax, r + 0.2, s * zf, 0.085, 0.18, 'y', 8);
        X.rod('frameLt', ax - a * 0.3, r + 0.16, s * (zf + 0.1), ax - a * 0.95, r + 0.42, s * (zf + 0.1), 0.035, 6);
        X.box('frameLt', ax - a * 0.62 - 0.09, r - 0.1, s * (zf - 0.2) - 0.07, ax - a * 0.62 + 0.09, r + 0.14, s * (zf - 0.2) + 0.07);  // brake unit
      }
    }
    X.box('frame', bx - 0.32, fy0 + 0.02, -zf, bx + 0.32, fy1 - 0.02, zf);
    X.box('frame', bx - 1.0, fy1 + 0.2, -0.3, bx + 1.0, fy1 + 0.3, 0.3);
    if (motor) for (const a of [-1, 1]) X.box('frameLt', bx + a * wb / 2 - a * 0.62 - 0.28, r - 0.2, -0.55, bx + a * wb / 2 - a * 0.62 + 0.28, r + 0.22, 0.45);
  }
  // Two-leaf plug door leaf for instancing: x in [-w/2, w/2], y in [0, h], outer face at z = 0 facing +Z.
  function doorLeafGeo(w, h, win, pal = 'red') {
    const X = new Parts(), hw = w / 2, [wx0, wx1, wy0, wy1] = win;
    const skin = (p, z0, z1) => {
      X.box(p, -hw, 0, z0, hw, wy0, z1); X.box(p, -hw, wy1, z0, hw, h, z1);
      X.box(p, -hw, wy0, z0, wx0, wy1, z1); X.box(p, wx1, wy0, z0, hw, wy1, z1);
    };
    skin(pal, -0.024, 0); skin('panelDk', -0.05, -0.024);
    X.box('rubber', hw - 0.018, 0, -0.05, hw + 0.01, h, 0.003); X.box('rubber', -hw - 0.01, 0, -0.05, -hw + 0.018, h, 0.003);
    X.box('rubber', wx0 - 0.02, wy0 - 0.02, -0.03, wx1 + 0.02, wy0, 0.002); X.box('rubber', wx0 - 0.02, wy1, -0.03, wx1 + 0.02, wy1 + 0.02, 0.002);
    X.cyl('lampRim', 0, 1.1, 0.002, 0.058, 0.01, 'z', 16); X.cyl('btnGreen', 0, 1.1, 0.008, 0.042, 0.01, 'z', 16);
    X.cyl('btnGreen', 0, 1.1, -0.055, 0.042, 0.01, 'z', 16);
    return X.geo();
  }
  function doorGlassGeo(win) {
    const T = new Tri(), [x0, x1, y0, y1] = win;
    T.quad(null, [x0, y0, -0.012], [x1, y0, -0.012], [x1, y1, -0.012], [x0, y1, -0.012], [0, 0, 1], [[0.2, 0.2], [0.8, 0.2], [0.8, 0.95], [0.2, 0.95]]);
    return T.geo();
  }
  // Rounded-rectangle loop in (z,y): half width hw, y from y0 to y1, corner radius rc.
  function rrLoop(hw, y0, y1, rc, seg = 3) {
    const pts = [], c = [[hw - rc, y1 - rc, 0], [-(hw - rc), y1 - rc, Math.PI / 2], [-(hw - rc), y0 + rc, Math.PI], [hw - rc, y0 + rc, 1.5 * Math.PI]];
    for (const [cz, cy, a0] of c) for (let k = 0; k <= seg; k++) { const a = a0 + (k / seg) * Math.PI / 2; pts.push([cz + rc * Math.cos(a), cy + rc * Math.sin(a)]); }
    return pts;
  }
  // Gangway bellows between x0 (body end) and x1 (coupler plane). Outer skin into X (exterior), inner into Tin.
  function bellows(Tout, Tin, x0, x1, hw, y0, y1, ihw, iy0, iy1) {
    const folds = 4, xs = []; for (let i = 0; i <= folds * 2; i++) xs.push(lerp(x0, x1, i / (folds * 2)));
    const ring = (k, inner) => { const d = (k % 2 ? 0.05 : 0); return inner ? rrLoop(ihw - d, iy0 + d * 0.5, iy1 - d, 0.18) : rrLoop(hw + d, y0 - d * 0.5, y1 + d, 0.3); };
    for (const inner of [false, true]) {
      const T = inner ? Tin : Tout; if (!T) continue;
      for (let i = 0; i < xs.length - 1; i++) {
        const A = ring(i, inner), B = ring(i + 1, inner);
        for (let j = 0; j < A.length; j++) {
          const j2 = (j + 1) % A.length;
          const a = [xs[i], A[j][1], A[j][0]], b = [xs[i + 1], B[j][1], B[j][0]], c = [xs[i + 1], B[j2][1], B[j2][0]], d = [xs[i], A[j2][1], A[j2][0]];
          const mz = (A[j][0] + A[j2][0]) / 2, my = (A[j][1] + A[j2][1]) / 2 - (inner ? (iy0 + iy1) / 2 : (y0 + y1) / 2);
          const want = inner ? [0, -my, -mz] : [0, my, mz];
          const f = fnorm(a, b, c); const pal = inner ? 'bellowsIn' : 'rubber';
          if (f[1] * want[1] + f[2] * want[2] >= 0) T.quad(pal, a, b, c, d, f); else T.quad(pal, a, d, c, b, [-f[0], -f[1], -f[2]]);
        }
      }
    }
  }

  // Single-arm pantograph, local origin at the base hinge (on the roof), head above x = PD.
  const PA = 1.55, PB = 1.62, PD = 0.05, PANTO_UP = 5.9, PANTO_HINGE = 0.25;
  const _pantoGeos = [];
  function pantoGeo(t) {
    const k = Math.round(clamp(t, 0, 1) * 20); if (_pantoGeos[k]) return _pantoGeos[k];
    const hTarget = lerp(0.26, PANTO_UP - (E.TOP + PANTO_HINGE), k / 20);
    const at = th => { const kx = -PA * Math.cos(th), ky = PA * Math.sin(th), ps = Math.acos(clamp((PD - kx) / PB, -1, 1)); return { kx, ky, hy: ky + PB * Math.sin(ps) }; };
    let lo = 0, hi = 1.3; for (let i = 0; i < 32; i++) { const m = (lo + hi) / 2; if (at(m).hy < hTarget) lo = m; else hi = m; }
    const { kx, ky, hy } = at(lo), X = new Parts();
    X.rod('frameLt', 0, 0, -0.26, kx, ky, -0.04, 0.04, 8); X.rod('frameLt', 0, 0, 0.26, kx, ky, 0.04, 0.04, 8);
    X.rod('steel', 0.18, -0.02, 0, kx + 0.12, ky - 0.05, 0, 0.018, 6);
    X.cyl('frame', kx, ky, 0, 0.06, 0.2, 'z', 10);
    X.rod('frameLt', kx, ky, -0.03, PD, hy, -0.3, 0.024, 6); X.rod('frameLt', kx, ky, 0.03, PD, hy, 0.3, 0.024, 6);
    X.rod('frameLt', kx, ky, 0, PD, hy - 0.02, 0, 0.016, 6);
    X.box('frameLt', PD - 0.05, hy - 0.03, -0.72, PD + 0.05, hy + 0.03, 0.72);
    for (const s of [-1, 1]) {
      X.box('copper', PD + s * 0.13 - 0.03, hy + 0.06, -0.62, PD + s * 0.13 + 0.03, hy + 0.1, 0.62);
      X.box('frameLt', PD + s * 0.13 - 0.02, hy + 0.02, -0.66, PD + s * 0.13 + 0.02, hy + 0.06, 0.66);
      X.rod('frameLt', PD, hy + 0.08, s * 0.62, PD, hy + 0.02, s * 0.84, 0.02, 6);
      X.rod('frameLt', PD, hy + 0.02, s * 0.84, PD, hy - 0.12, s * 0.98, 0.02, 6);
    }
    return (_pantoGeos[k] = X.geo());
  }
  function pantoBase(X, hx) {  // static base + insulators; hinge at (hx, TOP + PANTO_HINGE)
    const y = E.TOP;
    for (const dx of [-0.35, 0.35]) for (const s of [-1, 1]) { X.cyl('insul', hx + dx, y + 0.09, s * 0.42, 0.075, 0.18, 'y', 10); X.cyl('insul', hx + dx, y + 0.05, s * 0.42, 0.1, 0.03, 'y', 10); }
    X.box('frame', hx - 0.55, y + 0.18, -0.5, hx + 0.55, y + 0.24, 0.5);
    X.box('frameLt', hx - 0.1, y + 0.2, -0.3, hx + 0.1, PANTO_HINGE + y + 0.03, 0.3);
    X.box('frame', hx - 0.95, y + 0.2, -0.12, hx - 0.45, y + 0.34, 0.12);   // drive cylinder
    X.rod('copper', hx - 0.5, y + 0.3, 0.2, hx - 2.4, y + 0.3, 0.2, 0.02, 6);   // roof conductor
    X.cyl('insul', hx - 2.4, y + 0.16, 0.2, 0.06, 0.26, 'y', 10);
    X.box('roofDk', hx - 3.1, y + 0.02, -0.35, hx - 2.55, y + 0.42, 0.35);   // main breaker
  }

  // ------------------------------------------------------------------------------------------ EMU geometry
  const E = { W: 1.45, WI: 1.38, RY: 4.0, TOP: 4.55, BOT: 0.30, BOTE: 1.05, YL: 0.62, YM: 1.32, YU: 2.62, YUB: 2.48,
    DOORW: 1.30, DOORTOP: 2.46, CEILE: 3.95, CEILU: 4.41, YCAB: 1.75, WR: 0.46, WB: 2.5, GW: 0.62, GTOP: 3.40 };
  const ROOF_ARC = [0, 22.5, 45, 67.5, 90].map(a => [0.90 + 0.55 * Math.cos(a * Math.PI / 180), 4.0 + 0.55 * Math.sin(a * Math.PI / 180)]);
  const IROOF_ARC = [0, 30, 60, 90].map(a => [0.95 + 0.43 * Math.cos(a * Math.PI / 180), 3.98 + 0.43 * Math.sin(a * Math.PI / 180)]);
  const emuSection = bot => [[-E.W, bot], ...ROOF_ARC.map(([z, y]) => [-z, y]), ...ROOF_ARC.slice().reverse(), [E.W, bot]];
  const emuRoof = () => [...ROOF_ARC, ...ROOF_ARC.slice().reverse().map(([z, y]) => [-z, y])];
  const emuIRoof = () => [...IROOF_ARC, ...IROOF_ARC.slice().reverse().map(([z, y]) => [-z, y])];

  function emuPlan(type) {
    const cab = type === 'cab', L = cab ? 26.6 : 25.0, o = cab ? -0.9 : 0;
    return { type, cab, L, o, xA: -L / 2 + 0.25, xB: cab ? 10.6 : L / 2 - 0.25,
      ddA: o - 8.0, ddB: o + 8.0, lowA: o - 5.6, lowB: o + 5.6, stA: o - 8.7, stB: o + 8.7,
      doors: [o - 6.8, o + 6.8], stairF: [o + 3.0, o + 5.6], stairR: [o - 5.6, o - 3.0],
      bogies: cab ? [10.2, -11.3] : [10.4, -10.4], cabBack: 9.9, n0: 10.6, tip: 13.2 };
  }
  function emuOpenings(p) {
    const win = [], doors = [];
    const row = (a, b, n, y0, y1, gap = 0.26) => { const w = (b - a - (n - 1) * gap) / n; for (let i = 0; i < n; i++) win.push({ x0: a + i * (w + gap), x1: a + i * (w + gap) + w, y0, y1 }); };
    row(p.lowA + 0.28, p.lowB - 0.28, 5, 1.05, 2.18);
    row(p.ddA + 0.22, p.ddB - 0.22, 7, 3.02, 3.90);
    const endRow = (a, b) => row(a, b, Math.max(1, Math.round((b - a) / 1.75)), 1.72, 3.02);
    endRow(p.xA + 0.4, p.stA - 0.25);
    endRow(p.stB + 0.25, (p.cab ? p.cabBack : p.xB) - 0.4);
    if (p.cab) win.push({ x0: 10.0, x1: 10.5, y0: 2.6, y1: 3.45 });
    for (const dc of p.doors) doors.push({ x0: dc - E.DOORW / 2, x1: dc + E.DOORW / 2, y0: E.YL, y1: E.DOORTOP });
    return { win, doors };
  }

  // Cab nose: stacked rounded-rectangle outlines. Local x = 0 at the nose root (car x = n0).
  const NOSE_Y = [1.05, 1.17, 1.4, 1.62, 1.85, 2.08, 2.3, 2.38, 2.44, 2.75, 3.05, 3.35, 3.6, 3.75, 3.9, 4.0, 4.21, 4.389, 4.508, 4.55];
  function noseShape(y) {
    const w = y <= 4.0 ? E.W : 0.90 + Math.sqrt(Math.max(0, 0.3025 - (y - 4.0) * (y - 4.0)));
    let xf;
    if (y <= 2.38) { const t = (y - 1.75) / 0.85; xf = 2.6 - 0.22 * t * t; }
    else if (y <= 3.75) xf = 2.479 - 1.179 * Math.pow((y - 2.38) / 1.37, 1.1);
    else { const s = (y - 3.75) / 0.8; xf = 1.30 * Math.sqrt(Math.max(0, 1 - s * s)); }
    return { xf, w, r: Math.min(0.98 * w, xf, 0.75) };
  }
  function noseRow(y) {
    const { xf, w, r } = noseShape(y), pts = [[0, -w]];
    for (let k = 0; k <= 6; k++) { const a = -Math.PI / 2 + (k / 6) * Math.PI / 2; pts.push([xf - r + r * Math.cos(a), -(w - r) + r * Math.sin(a)]); }
    pts.push([xf, 0]);
    for (let k = 0; k <= 6; k++) { const a = (k / 6) * Math.PI / 2; pts.push([xf - r + r * Math.cos(a), (w - r) + r * Math.sin(a)]); }
    pts.push([0, w]);
    return pts;
  }
  function noseX(y, z) { const { xf, w, r } = noseShape(y), dz = Math.abs(z) - (w - r); return dz <= 0 ? xf : xf - r + Math.sqrt(Math.max(0, r * r - dz * dz)); }
  function noseCell(y, j) {
    const side = j === 0 || j === 15, edge = j === 1 || j === 14;
    if (y < 1.17) return 'red';
    if (y < 2.30) return side ? 'body' : 'red';
    if (y < 2.44) return 'band';
    if (y < 3.75) { if (side) return (y > 2.6 && y < 3.6) ? 'glass' : 'band'; return edge ? 'band' : 'glass'; }
    if (y < 3.9) return side ? 'body' : 'band';
    return 'body';
  }
  function buildNose(T, G, n0) {
    const R = NOSE_Y.length, J = 17, P = [], N = [];
    for (let r = 0; r < R; r++) { const row = noseRow(NOSE_Y[r]); for (let j = 0; j < J; j++) { P.push([n0 + row[j][0], NOSE_Y[r], row[j][1]]); N.push([0, 0, 0]); } }
    const id = (r, j) => r * J + j;
    const acc = (ids, p, q, s) => {
      const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = s[0] - p[0], vy = s[1] - p[1], vz = s[2] - p[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; for (const i of ids) { N[i][0] += nx; N[i][1] += ny; N[i][2] += nz; }
    };
    for (let r = 0; r < R - 1; r++) for (let j = 0; j < J - 1; j++) {
      const ia = id(r, j), ib = id(r + 1, j), ic = id(r + 1, j + 1), idd = id(r, j + 1);
      acc([ia, ib, ic], P[ia], P[ib], P[ic]); acc([ia, ic, idd], P[ia], P[ic], P[idd]);
    }
    for (const n of N) { const l = Math.hypot(n[0], n[1], n[2]); if (l < 1e-9) { n[0] = 0; n[1] = 1; n[2] = 0; } else { n[0] /= l; n[1] /= l; n[2] /= l; } }
    for (let r = 0; r < R - 1; r++) for (let j = 0; j < J - 1; j++) {
      const yc = (NOSE_Y[r] + NOSE_Y[r + 1]) / 2, kind = noseCell(yc, j);
      const ia = id(r, j), ib = id(r + 1, j), ic = id(r + 1, j + 1), idd = id(r, j + 1);
      let k2 = kind;
      if (kind === 'glass') { if (G) { G.quad(null, P[ia], P[ib], P[ic], P[idd], N[ia], [[0.5, 0.03], [0.5, 0.03], [0.5, 0.03], [0.5, 0.03]]); continue; } k2 = 'glassDk'; }
      T.tri(k2, P[ia], P[ib], P[ic], N[ia], N[ib], N[ic]); T.tri(k2, P[ia], P[ic], P[idd], N[ia], N[ic], N[idd]);
    }
    const c = [n0 + 1.2, NOSE_Y[0], 0];
    for (let j = 0; j < J - 1; j++) triFacing(T, 'frame', c, P[id(0, j)], P[id(0, j + 1)], [0, -1, 0]);
    return { P, N, R, J, id };
  }
  // Inner skin of the cab nose (seen from the driver's seat): offset inward, glass cells left open.
  function buildNoseInner(T, n0) {
    const { P, N, R, J, id } = buildNose(new Tri(), new Tri(), n0), o = 0.06;
    const Q = P.map((p, i) => [p[0] - N[i][0] * o, p[1] - N[i][1] * o, p[2] - N[i][2] * o]), M = N.map(n => [-n[0], -n[1], -n[2]]);
    for (let r = 0; r < R - 1; r++) for (let j = 0; j < J - 1; j++) {
      const y0 = NOSE_Y[r], y1 = NOSE_Y[r + 1], yc = (y0 + y1) / 2; if (y1 <= E.YCAB - 0.05) continue;
      if (noseCell(yc, j) === 'glass') continue;
      const pal = yc < 2.44 ? 'desk' : yc < 3.75 ? 'deskLt' : 'ceiling';
      const ia = id(r, j), ib = id(r + 1, j), ic = id(r + 1, j + 1), idd = id(r, j + 1);
      T.tri(pal, Q[ia], Q[ic], Q[ib], M[ia], M[ic], M[ib]); T.tri(pal, Q[ia], Q[idd], Q[ic], M[ia], M[idd], M[ic]);
    }
  }

  // Seats: facing bays (1.8 m) of 2+2 seats. Returns [{x, z, yaw, y(floor)}] seat-cushion centers + tables.
  const AISLE_Z = [0.535, 1.005];
  function bays(out, tables, x0, x1, y, zs, table = true) {
    const n = Math.floor((x1 - x0 + 0.05) / 1.8); if (n < 1) return;
    const start = (x0 + x1) / 2 - n * 0.9;
    for (let i = 0; i < n; i++) {
      const bx = start + i * 1.8;
      for (const z of zs) { out.push({ x: bx + 0.32, z, yaw: 0, y }); out.push({ x: bx + 1.48, z, yaw: Math.PI, y }); }
      if (table) for (const s of [-1, 1]) if (zs.some(z => z * s > 0.9)) tables.push({ x: bx + 0.9, z: s * 1.05, y });
    }
  }
  function emuSeatLayout(p) {
    const S = [], Tb = [], o = p.o, L = E.YL, Uy = E.YU, M = E.YM, both = [...AISLE_Z, ...AISLE_Z.map(z => -z)];
    const left = AISLE_Z.map(z => -z), right = AISLE_Z;
    if (p.type === 'bike') { bays(S, Tb, p.stairF[0], p.stairF[1], L, left, false); bays(S, Tb, p.stairR[0], p.stairR[1], L, right, false); }
    else if (p.type === 'wc') { bays(S, Tb, o - 3.0, o + 1.0, L, both); bays(S, Tb, o + 1.0, o + 3.0, L, [1.005]); bays(S, Tb, p.stairF[0], p.stairF[1], L, left); bays(S, Tb, p.stairR[0], p.stairR[1], L, right); }
    else { bays(S, Tb, o - 3.0, o + 3.0, L, both); bays(S, Tb, p.stairF[0], p.stairF[1], L, left); bays(S, Tb, p.stairR[0], p.stairR[1], L, right); }
    bays(S, Tb, o - 3.0, o + 3.0, Uy, both);
    bays(S, Tb, o + 3.0, p.ddB, Uy, left); bays(S, Tb, p.stairF[1], p.ddB, Uy, right);
    bays(S, Tb, p.ddA, o - 3.0, Uy, right); bays(S, Tb, p.ddA, p.stairR[0], Uy, left);
    bays(S, Tb, p.xA + 0.2, p.stA - 0.1, M, both);
    bays(S, Tb, p.stB + 0.1, (p.cab ? p.cabBack : p.xB - 0.9), M, both);
    return { seats: S, tables: Tb };
  }
  function emuWalk(p) {
    const R = [], ramps = [], wi = E.WI - 0.1, sF = p.stairF, sR = p.stairR;
    const add = (name, x0, x1, z0, z1, y) => R.push({ name, x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0, z1, y });
    for (const [lvl, y] of [['lower', E.YL], ['upper', E.YU]]) {
      add(lvl, sR[1], sF[0], -wi, wi, y);
      add(lvl, sF[0], sF[1], -wi, 0.15, y); add(lvl, sR[0], sR[1], -0.15, wi, y);
      if (lvl === 'upper') { add(lvl, sF[1], p.ddB, -wi, wi, y); add(lvl, p.ddA, sR[0], -wi, wi, y); }
    }
    add('vestF', sF[1], p.ddB, -1.40, 1.40, E.YL); add('vestR', p.ddA, sR[0], -1.40, 1.40, E.YL);
    ramps.push({ x0: sF[0], x1: sF[1], z0: 0.25, z1: 1.25, y0: E.YU, y1: E.YL }, { x0: sR[0], x1: sR[1], z0: -1.25, z1: -0.25, y0: E.YL, y1: E.YU });
    ramps.push({ x0: p.ddB, x1: p.stB, z0: -0.55, z1: 0.55, y0: E.YL, y1: E.YM }, { x0: p.stA, x1: p.ddA, z0: -0.55, z1: 0.55, y0: E.YM, y1: E.YL });
    add('endR', p.xA + 0.08, p.stA, -wi, wi, E.YM);
    add('gangR', -p.L / 2, p.xA + 0.08, -0.55, 0.55, E.YM);
    const gangways = { rear: { x: -p.L / 2, z0: -0.55, z1: 0.55, y: E.YM }, front: null };
    if (p.cab) {
      add('endF', p.stB, p.cabBack - 0.5, -wi, wi, E.YM);
      ramps.push({ x0: p.cabBack - 0.5, x1: p.cabBack + 0.05, z0: -0.35, z1: 0.35, y0: E.YM, y1: E.YCAB });
      add('cab', p.cabBack + 0.05, p.n0 + 1.55, -1.05, 1.05, E.YCAB);
    } else {
      add('endF', p.stB, p.xB - 0.08, -wi, wi, E.YM);
      add('gangF', p.xB - 0.08, p.L / 2, -0.55, 0.55, E.YM);
      gangways.front = { x: p.L / 2, z0: -0.55, z1: 0.55, y: E.YM };
    }
    return { floorRegions: R, ramps, gangways };
  }

  // Exterior + inner shell of one EMU car design (shared across consists).
  function emuDesign(type, panto) {
    const p = emuPlan(type), { win, doors } = emuOpenings(p), W = E.W, WI = E.WI;
    const X = new Parts(), T = new Tri(), G = new Tri(), S = new Tri();
    const sideColor = (x, y) => {
      if (p.cab && x > p.cabBack - 0.05) return y < 1.17 ? 'red' : (y > 2.30 && y < 3.75) ? 'band' : 'body';
      if (x > p.ddA && x < p.ddB) return y < 0.50 ? 'bodyLo' : y < 0.62 ? 'red' : y < 0.95 ? 'body' : y < 2.28 ? 'band' : y < 2.94 ? 'body' : 'band';
      return y < 1.17 ? 'red' : y < 1.62 ? 'body' : y < 3.12 ? 'band' : 'body';
    };
    const inColor = (x, y) => (x > p.ddA && x < p.ddB) ? (y < 0.95 ? 'panel' : y < 2.47 ? 'wall' : y < 2.63 ? 'panelDk' : y < 2.95 ? 'panel' : 'wall') : (y < 1.65 ? 'panel' : 'wall');
    const cut = [{ x0: p.xA - 1, x1: p.ddA, y0: 0, y1: E.BOTE }, { x0: p.ddB, x1: p.xB + 1, y0: 0, y1: E.BOTE }];
    const icut = [{ x0: p.xA - 1, x1: p.ddA, y0: 0, y1: E.YM }, { x0: p.ddB, x1: p.xB + 1, y0: 0, y1: E.YM }, { x0: p.ddA, x1: p.ddB, y0: 0, y1: E.YL }];
    if (p.cab) icut.push({ x0: p.cabBack, x1: p.xB + 1, y0: 0, y1: E.YCAB });
    const xs = [p.ddA, p.ddB, p.cabBack - 0.05], ys = [0.50, 0.62, 0.95, 1.17, 1.62, 2.28, 2.30, 2.94, 3.12, 3.75];
    const zr = (s, a, b) => [Math.min(s * a, s * b), Math.max(s * a, s * b)];
    for (const s of [-1, 1]) {
      wallGrid(T, p.xA, p.xB, E.BOT, E.RY, [...win, ...doors, ...cut], sideColor, (u, v) => [u, v, s * W], [0, 0, s], xs, ys);
      wallGrid(T, p.xA, p.xB, E.BOT, E.RY, [...win, ...doors, ...icut], inColor, (u, v) => [u, v, s * WI], [0, 0, -s], xs, [0.95, 1.65, 2.47, 2.63, 2.95]);
      const [z0, z1] = zr(s, WI, W);
      for (const h of [...win, ...doors]) {
        T.hq('panelDk', h.x0, h.x1, z0, z1, h.y0, true); T.hq('panelDk', h.x0, h.x1, z0, z1, h.y1, false);
        T.xq('panelDk', h.x0, z0, z1, h.y0, h.y1, 1); T.xq('panelDk', h.x1, z0, z1, h.y0, h.y1, -1);
      }
      for (const h of win) {
        const z = s * (W - 0.014), cab = h.y0 === 2.6, uv = cab ? [[0.5, 0.03], [0.5, 0.03], [0.5, 0.03], [0.5, 0.03]] : [[0, 0.1], [1, 0.1], [1, 1], [0, 1]];
        if (s > 0) G.quad(null, [h.x0, h.y0, z], [h.x1, h.y0, z], [h.x1, h.y1, z], [h.x0, h.y1, z], [0, 0, 1], uv);
        else G.quad(null, [h.x1, h.y0, z], [h.x0, h.y0, z], [h.x0, h.y1, z], [h.x1, h.y1, z], [0, 0, -1], uv);
      }
      for (const dc of p.doors) {
        const [a, b] = zr(s, W - 0.07, W); T.hq('stepEdge', dc - 0.65, dc + 0.65, a, b, E.YL + 0.003, true);
        const [c, d] = zr(s, W - 0.02, W + 0.12); X.box('frame', dc - 0.66, 0.40, c, dc + 0.66, 0.45, d);
        const [e, f] = zr(s, W + 0.1, W + 0.125); X.box('stepEdge', dc - 0.66, 0.40, e, dc + 0.66, 0.452, f);
      }
      // side LED sign on the belt, near the rear door; bezel behind it
      const sx0 = p.lowA + 0.5, sx1 = sx0 + 1.5, sy0 = 2.50, sy1 = 2.69, sz = s * (W + 0.008);
      const [bz0, bz1] = zr(s, W - 0.01, W + 0.006); X.box('black', sx0 - 0.04, sy0 - 0.04, bz0, sx1 + 0.04, sy1 + 0.04, bz1);
      if (s > 0) S.quad(null, [sx0, sy0, sz], [sx1, sy0, sz], [sx1, sy1, sz], [sx0, sy1, sz], [0, 0, 1], [[0, 0.5], [1, 0.5], [1, 1], [0, 1]]);
      else S.quad(null, [sx1, sy0, sz], [sx0, sy0, sz], [sx0, sy1, sz], [sx1, sy1, sz], [0, 0, -1], [[0, 0.5], [1, 0.5], [1, 1], [0, 1]]);
    }
    extrudeX(T, emuRoof(), p.xA, p.xB, (i, y) => y > 4.54 ? 'roof' : 'body');
    extrudeX(T, emuIRoof(), p.ddA, p.ddB, () => 'ceiling', 0, 6);
    for (const z of [-0.59, 0.59]) T.hq('light', p.ddA + 0.4, p.ddB - 0.4, z - 0.07, z + 0.07, E.CEILU - 0.012, false);
    T.hq('frame', p.ddA, p.ddB, -W, W, E.BOT, false);
    T.hq('frame', p.xA, p.ddA, -W, W, E.BOTE, false);
    T.hq('frame', p.ddB, p.cab ? p.n0 : p.xB, -W, W, E.BOTE, false);
    T.xq('bodyLo', p.ddA, -W, W, E.BOT, E.BOTE, -1); T.xq('bodyLo', p.ddB, -W, W, E.BOT, E.BOTE, 1);
    // gangway ends: outer cap with opening, inner wall, tunnel, bellows, floor plate
    const gh = { z0: -E.GW, z1: E.GW, y0: E.YM, y1: E.GTOP };
    const ends = p.cab ? [[p.xA, -1]] : [[p.xA, -1], [p.xB, 1]];
    for (const [xe, s] of ends) {
      capX(X, emuSection(E.BOTE), xe, s, 'body', gh);
      const xi = xe - s * 0.07;
      wallGrid(T, -WI, WI, E.YM, E.CEILE, [{ x0: -E.GW, x1: E.GW, y0: E.YM, y1: E.GTOP }], (u, v) => v < 1.65 ? 'panel' : 'wall', (u, v) => [xi, v, u], [-s, 0, 0]);
      const xa = Math.min(xi, xe), xb = Math.max(xi, xe);
      T.hq('floorLt', xa, xb, -E.GW, E.GW, E.YM + 0.004, true); T.hq('panelDk', xa, xb, -E.GW, E.GW, E.GTOP, false);
      T.zq('panelDk', -E.GW, xa, xb, E.YM, E.GTOP, 1); T.zq('panelDk', E.GW, xa, xb, E.YM, E.GTOP, -1);
      const xc = s * p.L / 2;
      bellows(T, T, xe, xc, 0.86, 1.12, 3.62, 0.70, E.YM, 3.46);
      T.hq('floorLt', Math.min(xe, xc), Math.max(xe, xc), -0.66, 0.66, E.YM + 0.004, true);
      X.rod('frame', xe - s * 0.4, 0.87, 0, xc, 0.87, 0, 0.09, 8);
    }
    // inner floors, upper-deck slab (with stair wells), end-zone floors + steps, ceilings, partitions
    const sF = p.stairF, sR = p.stairR;
    T.hq('floor', p.ddA, p.ddB, -WI, WI, E.YL, true);
    const slab = (x0, x1, z0, z1) => T.slab(x0, x1, z0, z1, E.YUB, E.YU, 'floor', 'ceiling', 'panel');
    slab(p.ddA, sR[0], -WI, WI); slab(sR[0], sR[1], -0.2, WI); slab(sR[1], sF[0], -WI, WI); slab(sF[0], sF[1], -WI, 0.2); slab(sF[1], p.ddB, -WI, WI);
    for (const [z, a, b] of [[0.6, sF[0], sF[1]], [-0.6, sR[0], sR[1]]]) {
      T.hq('light', p.ddA + 0.2, a, z - 0.06, z + 0.06, E.YUB - 0.006, false); T.hq('light', b, p.ddB - 0.2, z - 0.06, z + 0.06, E.YUB - 0.006, false);
    }
    for (const [x, s] of [[p.ddB, 1], [p.ddA, -1]]) { T.xq('wall', x, -WI, WI, E.YUB, E.CEILU, s); T.xq('wall', x - s * 0.03, -WI, WI, E.YU, E.CEILU, -s); }
    const endZone = (xd, xst, xe, dir) => {
      const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
      T.hq('floor', lo(xst, xe), hi(xst, xe), -0.6, 0.6, E.YM, true);
      T.hq('floor', lo(xd, xe), hi(xd, xe), 0.6, WI, E.YM, true); T.hq('floor', lo(xd, xe), hi(xd, xe), -WI, -0.6, E.YM, true);
      T.xq('panel', xd, 0.6, WI, E.YL, E.YM, -dir); T.xq('panel', xd, -WI, -0.6, E.YL, E.YM, -dir);
      T.zq('panel', 0.6, lo(xd, xst), hi(xd, xst), E.YL, E.YM, -1); T.zq('panel', -0.6, lo(xd, xst), hi(xd, xst), E.YL, E.YM, 1);
      for (let i = 0; i < 4; i++) {
        const xf = xd + dir * i * 0.175, top = E.YL + (i + 1) * 0.175;
        T.hq('floor', lo(xf, xst), hi(xf, xst), -0.6, 0.6, top, true);
        T.xq('panel', xf, -0.6, 0.6, top - 0.175, top, -dir);
        T.hq('stepEdge', lo(xf, xf + dir * 0.05), hi(xf, xf + dir * 0.05), -0.6, 0.6, top + 0.002, true);
      }
      T.hq('ceiling', lo(xd, xe), hi(xd, xe), -WI, WI, E.CEILE, false);
      T.hq('light', lo(xd, xe) + 0.3, hi(xd, xe) - 0.3, -0.08, 0.08, E.CEILE - 0.006, false);
      // glass partition above the side blocks (frame here, pane in the interior glass)
      for (const s of [-1, 1]) { X.box('panelDk', xd - 0.02, E.YM, s > 0 ? 0.6 : -WI, xd + 0.02, E.YM + 0.06, s > 0 ? WI : -0.6); X.box('pole', xd - 0.02, E.YM + 1.05, s > 0 ? 0.6 : -WI, xd + 0.02, E.YM + 1.09, s > 0 ? WI : -0.6); }
    };
    endZone(p.ddB, p.stB, p.cab ? p.cabBack : p.xB - 0.07, 1);
    endZone(p.ddA, p.stA, p.xA + 0.07, -1);
    if (p.cab) {
      T.xq('wall', p.cabBack, -WI, WI, E.YM, E.CEILE, -1);
      X.box('panelDk', p.cabBack - 0.035, E.YM + 0.02, -0.36, p.cabBack, E.YM + 1.98, 0.36);
      X.box('pole', p.cabBack - 0.06, E.YM + 1.0, 0.22, p.cabBack - 0.035, E.YM + 1.04, 0.3);
      T.hq('floor', p.cabBack, p.n0 + 2.35, -WI, WI, E.YCAB, true);
      T.xq('panel', p.cabBack, -0.4, 0.4, E.YM, E.YCAB, -1);
      buildNose(T, G, p.n0);
    }
    // roof equipment
    const acUnit = (cx) => {
      X.box('roof', cx - 1.15, E.TOP - 0.02, -0.95, cx + 1.15, E.TOP + 0.3, 0.95);
      X.box('roofDk', cx - 1.1, E.TOP + 0.3, -0.9, cx + 1.1, E.TOP + 0.33, 0.9);
      for (const dx of [-0.55, 0.55]) X.cyl('grille', cx + dx, E.TOP + 0.335, 0, 0.34, 0.012, 'y', 18);
      for (const s of [-1, 1]) X.box('grille', cx - 0.9, E.TOP + 0.05, s * 0.955 - 0.005, cx + 0.9, E.TOP + 0.25, s * 0.955 + 0.005);
    };
    const endMid = [(p.xA + p.stA) / 2, ((p.cab ? p.cabBack : p.xB) + p.stB) / 2];
    acUnit(endMid[0]);
    if (panto) pantoBase(X, p.bogies[0] - PD); else if (!p.cab) acUnit(endMid[1]);
    if (p.cab) X.box('roof', p.stB + 0.2, E.TOP - 0.02, -0.8, p.cabBack - 0.1, E.TOP + 0.22, 0.8);
    for (const s of [-1, 1]) X.box('bodyLo', p.xA + 0.1, E.TOP - 0.05, s * 0.93 - 0.02, (p.cab ? p.n0 : p.xB) - 0.1, E.TOP + 0.02, s * 0.93 + 0.02);
    // bogies
    p.bogies.forEach((bx, i) => bogie(X, bx, E.WB, E.WR, (type === 'cab' && i === 0) || panto, false));
    // nose details (cab)
    let glow = null;
    if (p.cab) {
      const n0 = p.n0, lampY = 1.62;
      glow = { head: [], tail: [] };
      for (const s of [-1, 1]) {
        const zc = s * 0.80, xs0 = n0 + noseX(lampY, zc), dz = Math.abs(zc) - 0.70, ang = dz > 0 ? Math.asin(clamp(dz / 0.75, 0, 1)) : 0;
        X.boxR('band', xs0 - 0.01, lampY, zc, 0.06, 0.26, 0.52, 0, -s * ang, 0);
        const hz = s * 0.68, hx = n0 + noseX(lampY, hz), tz = s * 0.93, tx = n0 + noseX(lampY, tz);
        X.cyl('lampRim', hx + 0.012, lampY, hz, 0.085, 0.03, 'x', 16); X.cyl('headLamp', hx + 0.03, lampY, hz, 0.07, 0.02, 'x', 16);
        X.cyl('lampRim', tx + 0.012, lampY, tz, 0.065, 0.03, 'x', 14); X.cyl('tailLamp', tx + 0.026, lampY, tz, 0.052, 0.02, 'x', 14);
        glow.head.push([hx + 0.08, lampY, hz]); glow.tail.push([tx + 0.07, lampY, tz]);
        X.boxR('black', n0 + noseX(2.5, s * 0.32) + 0.02, 2.52, s * 0.32, 0.02, 0.03, 0.62, 0, 0, 0.72);   // wiper
      }
      const ty = 3.98, tx2 = n0 + noseX(ty, 0);
      X.cyl('lampRim', tx2 + 0.01, ty, 0, 0.08, 0.04, 'x', 16); X.cyl('headLamp', tx2 + 0.03, ty, 0, 0.065, 0.02, 'x', 16);
      glow.head.push([tx2 + 0.08, ty, 0]);
      X.boxR('frame', n0 + 2.14, 0.64, 0, 0.08, 0.82, 2.3, 0, 0, 0.21);
      X.box('red', n0 + 2.1, 1.0, -1.1, n0 + 2.3, 1.06, 1.1);
      X.rod('frame', n0 + 1.6, 0.87, 0, p.L / 2 - 0.12, 0.87, 0, 0.1, 10);
      X.box('frame', p.L / 2 - 0.2, 0.72, -0.2, p.L / 2, 1.02, 0.2);
      for (const s of [-1, 1]) X.box('frameLt', n0 + 1.2, 0.30, s * 1.28 - 0.03, n0 + 2.05, 1.05, s * 1.28 + 0.03);
      // front LED destination sign along the top of the windscreen
      const zs = [], N = 8; for (let i = 0; i <= N; i++) zs.push(lerp(0.6, -0.6, i / N));
      for (let i = 0; i < N; i++) {
        const za = zs[i], zb = zs[i + 1], ya = 3.40, yb = 3.62;
        const P = (y, z) => [n0 + noseX(y, z) + 0.02, y, z];
        S.quad(null, P(ya, za), P(ya, zb), P(yb, zb), P(yb, za), null, [[i / N, 0.5], [(i + 1) / N, 0.5], [(i + 1) / N, 1], [i / N, 1]]);
      }
    }
    const ext = U.mergeGeometries([X.geo(), T.geo()]);
    const walk = emuWalk(p), lay = emuSeatLayout(p);
    const eye = y => y + 1.18;
    const seats = lay.seats.map(s => ({ x: s.x + Math.cos(s.yaw) * 0.12, y: eye(s.y), z: s.z, yaw: s.yaw }));
    const doorsMeta = []; for (const dc of p.doors) for (const s of [1, -1]) doorsMeta.push({ x: dc, side: s, width: E.DOORW, sillY: E.YL });
    const leaves = []; for (const dc of p.doors) for (const s of [1, -1]) for (const k of [-1, 1]) leaves.push({ dc, s, k });
    return {
      kind: 'emu', type, panto, plan: p, length: p.L, width: 2 * W, height: E.TOP, bogieOffsets: p.bogies.slice(),
      ext, glass: G.geo(), signs: S.geo(), glow, wheelR: E.WR,
      axles: p.bogies.flatMap(b => [b + E.WB / 2, b - E.WB / 2]),
      leaves, leafW: E.DOORW / 2, leafH: E.DOORTOP - E.YL, sillY: E.YL, bodyW: W,
      floorRegions: walk.floorRegions, ramps: walk.ramps, gangways: walk.gangways, seats, layout: lay,
      doors: doorsMeta, cabEye: p.cab ? [p.n0 + 0.85, E.YCAB + 1.22, 0.42] : null,
      pantoX: panto ? p.bogies[0] - PD : null, win, doorsOpen: doors, sideColor,
    };
  }

  // Far LODs of an EMU design: level 1 = windows as glowing panes, doors, nose, bogie blocks; level 2 = bands.
  function emuLod(d, level) {
    const p = d.plan, T = new Tri(), X = new Parts(), W = E.W;
    const holes = [{ x0: p.xA - 1, x1: p.ddA, y0: 0, y1: E.BOTE }, { x0: p.ddB, x1: p.xB + 1, y0: 0, y1: E.BOTE }];
    const inR = (hs, x, y) => hs.some(h => x > h.x0 && x < h.x1 && y > h.y0 && y < h.y1);
    let color, xs, ys;
    if (level === 1) {
      color = (x, y) => inR(d.win, x, y) ? 'lodGlass' : inR(d.doorsOpen, x, y) ? 'red' : d.sideColor(x, y);
      xs = [p.ddA, p.ddB, p.cabBack - 0.05, ...d.win.flatMap(h => [h.x0, h.x1]), ...d.doorsOpen.flatMap(h => [h.x0, h.x1])];
      ys = [0.5, 0.62, 0.95, 1.05, 1.17, 1.62, 1.72, 2.18, 2.28, 2.30, 2.46, 2.6, 2.94, 3.02, 3.12, 3.45, 3.75, 3.9];
    } else {
      color = (x, y) => { const c = d.sideColor(x, y); return c === 'band' ? 'lodGlass' : c === 'bodyLo' ? 'body' : c; };
      xs = [p.ddA, p.ddB, p.cabBack - 0.05]; ys = [0.62, 0.95, 1.17, 1.62, 2.28, 2.30, 2.94, 3.12, 3.75];
    }
    for (const s of [-1, 1]) wallGrid(T, p.xA, p.xB, E.BOT, E.RY, holes, color, (u, v) => [u, v, s * W], [0, 0, s], xs, ys);
    extrudeX(T, level === 1 ? emuRoof() : [[W, 4.0], [0.9, 4.55], [-0.9, 4.55], [-W, 4.0]], p.xA, p.xB, (i, y) => y > 4.54 ? 'roof' : 'body');
    T.hq('frame', p.ddA, p.ddB, -W, W, E.BOT, false);
    T.xq('bodyLo', p.ddA, -W, W, E.BOT, E.BOTE, -1); T.xq('bodyLo', p.ddB, -W, W, E.BOT, E.BOTE, 1);
    capX(X, emuSection(E.BOTE), p.xA, -1, 'body');
    if (!p.cab) capX(X, emuSection(E.BOTE), p.xB, 1, 'body');
    else {
      buildNose(T, null, p.n0);
      for (const h of d.glow.head) X.box('headLamp', h[0] - 0.1, h[1] - 0.07, h[2] - 0.08, h[0], h[1] + 0.07, h[2] + 0.08);
      for (const h of d.glow.tail) X.box('tailLamp', h[0] - 0.1, h[1] - 0.06, h[2] - 0.06, h[0], h[1] + 0.06, h[2] + 0.06);
    }
    for (const bx of p.bogies) {
      X.box('frame', bx - 1.75, 0.15, -1.1, bx + 1.75, 1.05, 1.1);
      if (level === 1) for (const a of [-1, 1]) X.cyl('wheel', bx + a * E.WB / 2, E.WR, 0, E.WR, 1.62, 'z', 10);
    }
    if (level === 1) {
      for (const bx of [(p.xA + p.stA) / 2]) X.box('roof', bx - 1.15, E.TOP - 0.02, -0.95, bx + 1.15, E.TOP + 0.3, 0.95);
      if (d.panto) X.box('frameLt', p.bogies[0] - 0.8, E.TOP, -0.7, p.bogies[0] + 0.2, E.TOP + 0.28, 0.7);
    }
    return U.mergeGeometries([X.geo(), T.geo()]);
  }

  // Per-car decals (atlas): wordmark, car number, pictograms. flags: { quiet }
  function emuDecals(d, number, flags) {
    decalAtlas();
    const p = d.plan, T = new Tri();
    for (const s of [-1, 1]) {
      const z = s * (E.W + 0.007);
      decalZ(T, 'word', p.o + 1.6, 2.61, z, 2.1, 0.42, s);
      numberZ(T, number, p.xA + 1.9, 1.39, z, 0.24, s);
      for (const dc of p.doors) {
        const icon = d.type === 'bike' ? 'bike' : d.type === 'cab' ? 'wheelchair' : d.type === 'wc' ? (dc > p.o ? 'wc' : 'wheelchair') : flags.quiet ? 'quiet' : null;
        if (icon) decalZ(T, icon, dc, 2.69, z, 0.36, 0.36, s);
      }
      if (d.type === 'bike') decalZ(T, 'bikecar', p.o - 1.6, 2.61, z, 1.5, 0.28, s);
    }
    if (p.cab) {
      let xm = 0; for (let y = 1.92; y <= 2.2; y += 0.02) xm = Math.max(xm, noseX(y, 0));
      decalX(T, 'wordW', p.n0 + xm + 0.012, 2.06, 0, 1.05, 0.21, 1);
    }
    return T.geo();
  }

  // Standard 2+2 seat (instanced): origin at floor level under the cushion center, facing +X.
  let _seatGeo = null;
  function seatGeo() {
    if (_seatGeo) return _seatGeo;
    const X = new Parts();
    X.box('seatDk', -0.14, 0, -0.05, 0.08, 0.36, 0.05);
    X.box('seatDk', -0.2, 0, -0.16, 0.16, 0.03, 0.16);
    X.box('seatShell', -0.25, 0.36, -0.232, 0.22, 0.42, 0.232);
    X.box('seat', -0.24, 0.42, -0.222, 0.21, 0.5, 0.222);
    X.boxR('seatShell', -0.3, 0.85, 0, 0.05, 0.84, 0.466, 0, 0, 0.1);
    X.boxR('seat', -0.255, 0.84, 0, 0.055, 0.76, 0.44, 0, 0, 0.1);
    X.boxR('headrest', -0.29, 1.19, 0, 0.05, 0.15, 0.405, 0, 0, 0.1);
    X.boxR('pole', -0.345, 1.24, 0, 0.028, 0.028, 0.2, 0, 0, 0.1);
    return (_seatGeo = X.geo());
  }
  // Bike (instanced, tinted by instanceColor): wheels in the x-y plane, origin at floor under the bottom bracket.
  let _bikeGeo = null;
  function bikeGeo() {
    if (_bikeGeo) return _bikeGeo;
    const X = new Parts(), R = [-0.52, 0.34], F = [0.52, 0.34], B = [0, 0.3], S = [-0.16, 0.8], H = [0.4, 0.84], Hb = [0.44, 0.7];
    X.torus('tire', R[0], R[1], 0, 0.34); X.torus('tire', F[0], F[1], 0, 0.34);
    for (const w of [R, F]) { X.cyl('steel', w[0], w[1], 0, 0.04, 0.1, 'z', 8); X.torus('steel', w[0], w[1], 0, 0.29); }
    const t = (a, b, r = 0.018) => X.rod('bikeFrame', a[0], a[1], 0, b[0], b[1], 0, r, 6);
    t(B, S); t(S, H); t(B, Hb, 0.022); t(H, Hb); t(B, R, 0.014); t(S, R, 0.013); t(Hb, F, 0.016);
    X.rod('steel', S[0], S[1], 0, -0.2, 0.9, 0, 0.012, 6); X.box('rubber', -0.33, 0.9, -0.06, -0.12, 0.94, 0.06);
    X.rod('steel', H[0], H[1], 0, 0.36, 1.0, 0, 0.014, 6); X.rod('rubber', 0.36, 1.0, -0.23, 0.36, 1.0, 0.23, 0.015, 6);
    X.cyl('frameLt', B[0], B[1], 0.05, 0.09, 0.02, 'z', 12); X.rod('frameLt', B[0], B[1], 0.07, 0.12, 0.18, 0.07, 0.012, 4);
    return (_bikeGeo = X.geo());
  }
  function mat4List(list, f) {   // list -> Float32Array of instance matrices via f(item) -> [x,y,z,yaw]
    const a = new Float32Array(list.length * 16), m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V3(1, 1, 1), pp = new V3();
    list.forEach((it, i) => { const [x, y, z, yaw] = f(it); q.setFromAxisAngle(_Y, yaw); m.compose(pp.set(x, y, z), q, s); m.toArray(a, i * 16); });
    return a;
  }
  // A PIS / cab screen quad facing +X or -X (s), UV rect r = [u0,v0,u1,v1] (reads correctly from the front).
  function screenX(T, xc, yc, zc, w, h, s, r = [0, 0, 1, 1], tilt = 0) {
    const [u0, v0, u1, v1] = r, dz = w / 2, dy = h / 2, tx = Math.sin(tilt) * dy * s;
    const A = [xc + tx, yc - dy * Math.cos(tilt), zc], Bt = [xc - tx, yc + dy * Math.cos(tilt), zc];
    if (s > 0) T.quad(null, [A[0], A[1], zc + dz], [A[0], A[1], zc - dz], [Bt[0], Bt[1], zc - dz], [Bt[0], Bt[1], zc + dz], null, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
    else T.quad(null, [A[0], A[1], zc - dz], [A[0], A[1], zc + dz], [Bt[0], Bt[1], zc + dz], [Bt[0], Bt[1], zc - dz], null, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
  }

  // Interior furniture of an EMU design (built lazily, once per design).
  function emuInterior(d) {
    if (d.int) return d.int;
    const p = d.plan, X = new Parts(), T = new Tri(), G = new Tri(), P = new Tri(), C = new Tri(), WI = E.WI;
    const sF = p.stairF, sR = p.stairR, lay = d.layout;
    // stairs to the upper deck (11 risers), balustrades, handrails
    const stair = (xBot, xTop, z0, z1) => {
      const n = 11, run = (xBot - xTop) / n, rise = (E.YU - E.YL) / n, zin = Math.abs(z0) < Math.abs(z1) ? z0 : z1, sz = Math.sign(z0 + z1);
      for (let i = 0; i < n; i++) {
        const xa = xBot - i * run, xb = xBot - (i + 1) * run, top = E.YL + (i + 1) * rise;
        X.box('panelDk', Math.min(xa, xb), E.YL, z0, Math.max(xa, xb), top, z1);
        T.hq('floor', Math.min(xa, xb), Math.max(xa, xb), z0, z1, top + 0.002, true);
        T.hq('stepEdge', Math.min(xa, xa - Math.sign(run) * 0.05), Math.max(xa, xa - Math.sign(run) * 0.05), z0, z1, top + 0.004, true);
      }
      X.rod('pole', xBot + Math.sign(run) * 0.1, E.YL + 0.95, zin - sz * 0.04, xTop - Math.sign(run) * 0.1, E.YU + 0.95, zin - sz * 0.04, 0.02);
      X.rod('pole', xBot + Math.sign(run) * 0.1, E.YL + 0.05, zin - sz * 0.04, xBot + Math.sign(run) * 0.1, E.YL + 0.95, zin - sz * 0.04, 0.02);
      X.rod('pole', xBot + Math.sign(run) * 0.1, E.YL + 0.95, zin - sz * 0.04, xBot + Math.sign(run) * 0.1, E.YUB, zin - sz * 0.04, 0.02);
      const zw = sz * (WI - 0.03);
      X.rod('pole', xBot, E.YL + 0.9, zw, xTop, E.YU + 0.9, zw, 0.018);
      // upper-deck balustrade: glass along the aisle side and across the well end
      const gx0 = Math.min(xBot, xTop), gx1 = Math.max(xBot, xTop);
      G.quad(null, [gx0, E.YU, zin], [gx1, E.YU, zin], [gx1, E.YU + 1.0, zin], [gx0, E.YU + 1.0, zin], [0, 0, 1], [[0.5, 0.03], [0.5, 0.03], [0.5, 0.03], [0.5, 0.03]]);
      X.rod('pole', gx0, E.YU + 1.02, zin, gx1, E.YU + 1.02, zin, 0.022);
      const xe = xBot; X.rod('pole', xe, E.YU + 1.02, zin, xe, E.YU + 1.02, sz * WI, 0.022);
      G.quad(null, [xe, E.YU, Math.min(zin, sz * WI)], [xe, E.YU, Math.max(zin, sz * WI)], [xe, E.YU + 1.0, Math.max(zin, sz * WI)], [xe, E.YU + 1.0, Math.min(zin, sz * WI)], [1, 0, 0], [[0.5, 0.03], [0.5, 0.03], [0.5, 0.03], [0.5, 0.03]]);
      X.rod('pole', gx0 + 0.02, E.YU, zin, gx0 + 0.02, E.YU + 1.02, zin, 0.022);
    };
    stair(sF[1], sF[0], 0.25, WI - 0.02);
    stair(sR[0], sR[1], -(WI - 0.02), -0.25);
    // vestibules: central poles, overhead rails, door buttons, screens
    for (const dc of p.doors) {
      X.rod('pole', dc, E.YL, 0, dc, E.YUB, 0, 0.022, 10);
      for (const s of [-1, 1]) {
        X.rod('pole', dc - 1.0, E.YUB - 0.12, s * 0.62, dc + 1.0, E.YUB - 0.12, s * 0.62, 0.016);
        for (const k of [-1, 1]) { X.cyl('lampRim', dc + k * 0.82, 1.55, s * (WI - 0.005), 0.05, 0.02, 'z', 14); X.cyl('btnGreen', dc + k * 0.82, 1.55, s * (WI - 0.015), 0.036, 0.012, 'z', 14); }
        X.box('btnRed', dc + 0.78, 1.92, s > 0 ? WI - 0.03 : -WI, dc + 0.9, 2.06, s > 0 ? WI : -WI + 0.03);
      }
      const xm = dc + (dc > p.o ? -0.95 : 0.95);
      X.box('black', xm - 0.035, 2.1, -0.42, xm + 0.035, 2.44, 0.42);
      screenX(P, xm + 0.036, 2.27, 0, 0.78, 0.29, 1); screenX(P, xm - 0.036, 2.27, 0, 0.78, 0.29, -1);
    }
    // upper deck end screens, end-zone screens above the gangways
    for (const [x, s] of [[p.ddB - 0.04, -1], [p.ddA + 0.04, 1]]) { X.box('black', x - 0.02, 3.52, -0.45, x + 0.02, 3.86, 0.45); screenX(P, x + s * 0.022, 3.69, 0, 0.82, 0.3, s); }
    const endsX = p.cab ? [[p.xA + 0.09, 1]] : [[p.xA + 0.09, 1], [p.xB - 0.09, -1]];
    for (const [x, s] of endsX) { X.box('black', x - 0.02, 3.5, -0.36, x + 0.02, 3.82, 0.36); screenX(P, x + s * 0.022, 3.66, 0, 0.64, 0.26, s); }
    // luggage racks in the end zones, partitions (glass) between vestibule steps and end-zone seating
    for (const [a, b] of [[p.xA + 0.3, p.stA - 0.2], [p.stB + 0.2, (p.cab ? p.cabBack : p.xB) - 0.3]]) for (const s of [-1, 1]) {
      X.box('pole', a, 3.2, s > 0 ? 1.0 : -WI, b, 3.225, s > 0 ? WI : -1.0);
      for (let x = a + 0.2; x < b; x += 1.2) X.box('panelDk', x - 0.02, 3.05, s > 0 ? WI - 0.03 : -WI, x + 0.02, 3.23, s > 0 ? WI : -WI + 0.03);
    }
    for (const [xd] of [[p.ddB], [p.ddA]]) for (const s of [-1, 1]) {
      const za = s > 0 ? 0.6 : -WI, zb = s > 0 ? WI : -0.6;
      G.quad(null, [xd, E.YM + 0.06, za], [xd, E.YM + 0.06, zb], [xd, E.YM + 1.05, zb], [xd, E.YM + 1.05, za], [1, 0, 0], [[0.5, 0.03], [0.5, 0.03], [0.5, 0.03], [0.5, 0.03]]);
      X.rod('pole', xd, E.YM, s * 0.6, xd, E.YM + 1.9, s * 0.6, 0.022);
    }
    // tables in facing bays
    for (const t of lay.tables) {
      const za = t.z > 0 ? 0.78 : -WI + 0.02, zb = t.z > 0 ? WI - 0.02 : -0.78;
      X.box('table', t.x - 0.3, t.y + 0.71, za, t.x + 0.3, t.y + 0.745, zb);
      X.box('seatDk', t.x - 0.04, t.y + 0.4, t.z > 0 ? WI - 0.08 : -WI + 0.02, t.x + 0.04, t.y + 0.71, t.z > 0 ? WI - 0.02 : -WI + 0.08);
    }
    // bike car: racks + bikes in the lower deck
    const bikes = [];
    if (d.type === 'bike') {
      for (const s of [-1, 1]) for (const rx of [p.o - 1.5, p.o + 1.5]) {
        for (const dx of [-0.75, 0.75]) { X.rod('bikeRack', rx + dx, E.YL, s * 1.33, rx + dx, E.YL + 1.25, s * 1.33, 0.025); X.rod('bikeRack', rx + dx, E.YL + 1.25, s * 1.33, rx + dx, E.YL + 1.25, s * 0.55, 0.025); }
        X.rod('bikeRack', rx - 0.75, E.YL + 1.25, s * 0.55, rx + 0.75, E.YL + 1.25, s * 0.55, 0.025);
        X.rod('bikeRack', rx - 0.75, E.YL + 0.62, s * 1.33, rx + 0.75, E.YL + 0.62, s * 1.33, 0.02);
        X.box('panelDk', rx - 0.9, E.YL, s > 0 ? 0.5 : -WI, rx + 0.9, E.YL + 0.05, s > 0 ? WI : -0.5);
        for (let k = 0; k < 4; k++) bikes.push({ x: rx + (k % 2 ? 0.06 : -0.06), y: E.YL + 0.05, z: s * (1.2 - k * 0.2), yaw: k % 2 ? Math.PI : 0 });
      }
      for (const s of [-1, 1]) X.box('seatShell', p.o - 0.25, E.YL + 0.45, s > 0 ? 1.05 : -WI, p.o + 0.25, E.YL + 0.5, s > 0 ? WI : -1.05);
    }
    // accessible restroom module (restroom car), lower deck front-left
    if (d.type === 'wc') {
      const x0 = p.o + 1.0, x1 = p.o + 3.0, z0 = -WI, z1 = 0.05, y0 = E.YL, y1 = E.YUB;
      X.box('wc', x0, y0, z1 - 0.06, x1, y1, z1); X.box('wc', x0, y0, z0, x0 + 0.06, y1, z1); X.box('wc', x1 - 0.06, y0, z0, x1, y1, z1);
      X.box('panelDk', x0 + 0.5, y0 + 0.02, z1, x0 + 1.5, y0 + 1.95, z1 + 0.03);
      X.box('blueSign', x0 + 1.55, y0 + 1.35, z1, x0 + 1.8, y0 + 1.6, z1 + 0.02);
      X.cyl('btnGreen', x0 + 1.65, y0 + 1.05, z1 + 0.02, 0.04, 0.02, 'z', 12);
    }
    // cab: inner nose skin, desk with screens, seat, back wall; the throttle/brake handle is a separate mesh
    let handle = null;
    if (p.cab) {
      const n0 = p.n0;
      buildNoseInner(T, n0);
      T.hq('ceiling', p.cabBack, n0 + 0.9, -WI, WI, 3.93, false);
      T.hq('light', p.cabBack + 0.2, n0 + 0.6, -0.1, 0.1, 3.925, false);
      T.xq('panel', p.cabBack + 0.02, -WI, WI, E.YCAB, 3.95, 1);
      X.box('desk', n0 + 1.3, E.YCAB, -1.2, n0 + 2.15, E.YCAB + 0.72, 1.2);
      X.boxR('deskLt', n0 + 1.52, E.YCAB + 0.8, 0.1, 0.5, 0.06, 2.3, 0, 0, 0.42);
      X.boxR('screenOff', n0 + 1.62, E.YCAB + 0.93, 0.4, 0.05, 0.34, 0.98, 0, 0, -0.55);
      screenX(C, n0 + 1.59, E.YCAB + 0.94, 0.16, 0.44, 0.3, -1, [0, 0, 0.5, 1], 0.55);
      screenX(C, n0 + 1.59, E.YCAB + 0.94, 0.64, 0.44, 0.3, -1, [0.5, 0, 1, 1], 0.55);
      for (let i = 0; i < 6; i++) X.cyl(i % 3 ? 'btnYellow' : 'btnGreen', n0 + 1.5, E.YCAB + 0.83, -0.75 + i * 0.07, 0.013, 0.015, 'y', 8);
      X.cyl('btnRed', n0 + 1.45, E.YCAB + 0.8, 1.02, 0.035, 0.03, 'y', 12);
      X.box('cabSeat', n0 + 0.55, E.YCAB, 0.3, n0 + 0.65, E.YCAB + 0.42, 0.54);
      X.box('cabSeat', n0 + 0.35, E.YCAB + 0.42, 0.16, n0 + 0.85, E.YCAB + 0.52, 0.68);
      X.boxR('cabSeat', n0 + 0.33, E.YCAB + 0.95, 0.42, 0.1, 0.85, 0.5, 0, 0, 0.12);
      for (const s of [-1, 1]) X.box('seatDk', n0 + 0.45, E.YCAB + 0.7, 0.42 + s * 0.28 - 0.03, n0 + 0.85, E.YCAB + 0.74, 0.42 + s * 0.28 + 0.03);
      X.box('cabSeat', n0 + 0.5, E.YCAB + 0.42, -0.72, n0 + 0.9, E.YCAB + 0.5, -0.3);
      X.box('band', n0 + 1.35, 3.62, -0.95, n0 + 1.42, 3.66, 0.95);
      X.box('frameLt', n0 + 1.25, E.YCAB + 0.72, -0.34, n0 + 1.45, E.YCAB + 0.78, -0.1);
      handle = { pivot: [n0 + 1.35, E.YCAB + 0.78, -0.22] };
    }
    const hg = new Parts();
    hg.rod('steel', 0, 0, 0, 0, 0.2, 0, 0.012, 6); hg.box('black', -0.03, 0.18, -0.05, 0.03, 0.24, 0.05); hg.box('frameLt', -0.06, -0.01, -0.03, 0.06, 0.02, 0.03);
    const bodies = lay.seats;
    d.int = {
      furn: U.mergeGeometries([X.geo(), T.geo()]), glass: G.geo(), pis: P.geo(), cab: C.geo(),
      seatMatrices: mat4List(bodies, s => [s.x, s.y, s.z, s.yaw]), seatCount: bodies.length,
      bikeMatrices: mat4List(bikes, b => [b.x, b.y, b.z, b.yaw]), bikeCount: bikes.length,
      handle, handleGeo: handle ? hg.geo() : null,
    };
    return d.int;
  }

  // ------------------------------------------------------------------------------------------ DIESEL: MP36-like locomotive
  // Car 0 of the diesel set; cab at +X (south). 21.0 m over couplers, 3.2 m wide, 4.7 m tall.
  const D = { L: 21.0, W: 1.6, DECK: 1.40, CABF: 1.95, WR: 0.508, WB: 2.74, TRK: 6.55,
    BW: 1.50, BTOP: 2.95, SL_Z: 1.12, SL_Y: 4.30, BR: 0.457, BWB: 2.59, BYL: 0.55, BYM: 1.12, BYU: 2.52, BYUB: 2.38, BDD: 7.1 };
  function locoDesign() {
    const X = new Parts(), T = new Tri(), G = new Tri(), S = new Tri(), W = D.W;
    const cab0 = 4.35, cab1 = 8.9, nose1 = 10.05, hood0 = -9.75, hz = 1.25, cz = 1.58;
    // frame, sills, walkway, fuel tank, reservoirs
    X.box('frame', -10.1, 1.12, -W, 10.1, D.DECK, W);
    for (const s of [-1, 1]) { X.box('red', -10.1, 1.17, s > 0 ? W : -W - 0.012, 10.1, 1.33, s > 0 ? W + 0.012 : -W); X.box('frameLt', -9.9, D.DECK, s * 1.42 - 0.12, 9.9, D.DECK + 0.012, s * 1.42 + 0.12); }
    X.box('frame', -3.9, 0.62, -1.3, 3.5, 1.12, 1.3); X.box('frame', -3.8, 0.5, -1.05, 3.4, 0.62, 1.05);
    X.box('frameLt', 3.5, 0.62, -1.3, 3.56, 1.1, 1.3); X.box('frameLt', -3.96, 0.62, -1.3, -3.9, 1.1, 1.3);
    X.cyl('steel', 1.2, 1.02, 1.31, 0.09, 0.05, 'z', 10);
    for (const s of [-1, 1]) X.cyl('frameLt', 0, 0.84, s * 1.43, 0.14, 5.6, 'x', 12);
    // trucks
    for (const bx of [D.TRK, -D.TRK]) bogie(X, bx, D.WB, D.WR, true, true);
    // long hood (sides with painted panel seams and grilles), roof, rear wall
    const seams = [-8, -6.2, -4.4, -2.6, -0.8, 1.0, 2.8];
    const hoodColor = (x, y) => {
      if (x < -6.8 && x > -9.4 && y > 3.0 && y < 4.1) return 'grille';
      if (x > -3.3 && x < -1.4 && y > 2.6 && y < 3.3) return 'grille';
      if (seams.some(sx => Math.abs(x - sx) < 0.02)) return 'bodyLo';
      return y < 2.05 ? 'body' : y < 2.2 ? 'red' : y < 3.35 ? 'body' : y < 3.75 ? 'band' : 'body';
    };
    const hxs = seams.flatMap(v => [v - 0.02, v + 0.02]).concat([-9.4, -6.8, -3.3, -1.4]);
    for (const s of [-1, 1]) wallGrid(T, hood0, cab0, D.DECK, 4.25, [], hoodColor, (u, v) => [u, v, s * hz], [0, 0, s], hxs, [2.05, 2.2, 2.6, 3.0, 3.3, 3.35, 3.75, 4.1]);
    const hoodRoof = [[hz, 4.25], [1.12, 4.38], [0.9, 4.42], [-0.9, 4.42], [-1.12, 4.38], [-hz, 4.25]];
    extrudeX(T, hoodRoof, hood0, cab0, () => 'roof');
    capX(X, [[-hz, D.DECK], [hz, D.DECK], ...hoodRoof], hood0, -1, 'body');
    // radiator section: raised fan deck with three fans, dynamic brake blister, exhausts
    X.box('body', -9.7, 4.25, -hz, -4.6, 4.52, hz); X.box('roofDk', -9.65, 4.52, -hz + 0.05, -4.65, 4.55, hz - 0.05);
    for (const fx of [-8.85, -7.2, -5.55]) {
      X.cyl('grille', fx, 4.555, 0, 0.66, 0.02, 'y', 24); X.cyl('frameLt', fx, 4.57, 0, 0.12, 0.03, 'y', 10);
      for (let k = 0; k < 4; k++) X.boxR('black', fx, 4.568, 0, 1.2, 0.012, 0.16, 0, k * Math.PI / 4 + 0.2, 0);
      X.torus('frameLt', fx, 4.57, 0, 0.66, Math.PI / 2, 0, 0);
    }
    X.box('body', 0.6, 4.42, -1.0, 3.6, 4.62, 1.0); X.cyl('grille', 2.1, 4.625, 0, 0.5, 0.02, 'y', 20);
    for (let k = 0; k < 4; k++) X.boxR('black', 2.1, 4.64, 0, 0.9, 0.012, 0.12, 0, k * Math.PI / 4, 0);
    X.box('black', -1.5, 4.42, -0.35, -0.9, 4.62, 0.35); X.box('black', -0.6, 4.42, -0.3, -0.1, 4.58, 0.3); X.box('black', -4.2, 4.42, 0.4, -3.8, 4.6, 0.8);
    X.box('roofDk', -3.4, 4.42, -0.9, -2.2, 4.5, 0.9);
    // cab: side walls with windows, front wall with windscreens, roof
    const cabWin = [{ x0: 6.05, x1: 7.2, y0: 2.95, y1: 3.88 }, { x0: 7.32, x1: 8.55, y0: 2.95, y1: 3.88 }];
    const cabColor = (x, y) => y < 2.05 ? 'red' : y < 2.85 ? 'body' : y < 3.98 ? 'band' : 'body';
    const cabIn = (x, y) => y < 2.6 ? 'panelDk' : 'panel';
    for (const s of [-1, 1]) {
      wallGrid(T, cab0, cab1, D.DECK, 4.3, cabWin, cabColor, (u, v) => [u, v, s * cz], [0, 0, s], [], [2.05, 2.85, 3.98]);
      wallGrid(T, cab0, cab1, D.CABF, 4.25, cabWin, cabIn, (u, v) => [u, v, s * (cz - 0.06)], [0, 0, -s]);
      for (const h of cabWin) { const z = s * (cz - 0.012);
        if (s > 0) G.quad(null, [h.x0, h.y0, z], [h.x1, h.y0, z], [h.x1, h.y1, z], [h.x0, h.y1, z], [0, 0, 1], [[0.5, 0.03], [0.5, 0.03], [0.5, 0.03], [0.5, 0.03]]);
        else G.quad(null, [h.x1, h.y0, z], [h.x0, h.y0, z], [h.x0, h.y1, z], [h.x1, h.y1, z], [0, 0, -1], [[0.5, 0.03], [0.5, 0.03], [0.5, 0.03], [0.5, 0.03]]);
        const [a, b] = [Math.min(s * cz, s * (cz - 0.06)), Math.max(s * cz, s * (cz - 0.06))];
        T.hq('panelDk', h.x0, h.x1, a, b, h.y0, true); T.hq('panelDk', h.x0, h.x1, a, b, h.y1, false); T.xq('panelDk', h.x0, a, b, h.y0, h.y1, 1); T.xq('panelDk', h.x1, a, b, h.y0, h.y1, -1); }
    }
    const fwin = [{ x0: -1.38, x1: -0.1, y0: 2.95, y1: 3.9 }, { x0: 0.1, x1: 1.38, y0: 2.95, y1: 3.9 }];
    wallGrid(T, -cz, cz, D.DECK, 4.3, [...fwin, { x0: -1.16, x1: 1.16, y0: 0, y1: 2.9 }], (u, v) => v < 2.9 ? 'red' : v < 3.98 ? 'band' : 'body', (u, v) => [cab1, v, u], [1, 0, 0], [], [2.9, 3.98]);
    wallGrid(T, -cz + 0.06, cz - 0.06, D.CABF, 4.25, fwin, () => 'panel', (u, v) => [cab1 - 0.06, v, u], [-1, 0, 0]);
    for (const h of fwin) { G.quad(null, [cab1 + 0.005, h.y0, h.x1], [cab1 + 0.005, h.y0, h.x0], [cab1 + 0.005, h.y1, h.x0], [cab1 + 0.005, h.y1, h.x1], [1, 0, 0], [[0.5, 0.03], [0.5, 0.03], [0.5, 0.03], [0.5, 0.03]]);
      T.hq('panelDk', cab1 - 0.06, cab1, h.x0, h.x1, h.y0, true); T.hq('panelDk', cab1 - 0.06, cab1, h.x0, h.x1, h.y1, false); }
    wallGrid(T, -cz, cz, D.DECK, 4.3, [{ x0: -hz, x1: hz, y0: 0, y1: 4.25 }], () => 'body', (u, v) => [cab0, v, u], [-1, 0, 0]);
    const cabRoof = [[cz, 4.3], [1.42, 4.47], [1.05, 4.56], [-1.05, 4.56], [-1.42, 4.47], [-cz, 4.3]];
    extrudeX(T, cabRoof, cab0, cab1, () => 'body', 0, 3.0);
    capX(X, [[-cz, 4.3], [cz, 4.3], [1.42, 4.47], [1.05, 4.56], [-1.05, 4.56], [-1.42, 4.47]], cab1, 1, 'body');
    T.hq('floor', cab0, cab1, -cz, cz, D.CABF, true); T.hq('ceiling', cab0, cab1, -cz, cz, 4.25, false);
    T.xq('panel', cab0 + 0.06, -cz, cz, D.CABF, 4.25, 1);
    // short nose, number boards, lights, pilots, couplers, handrails, horn, bell
    X.box('red', cab1, D.DECK, -1.16, nose1, 2.72, 1.16);
    X.boxR('red', (cab1 + nose1) / 2 - 0.02, 2.8, 0, nose1 - cab1 + 0.04, 0.22, 2.32, 0, 0, -0.14);
    X.box('band', nose1, 1.52, -0.36, nose1 + 0.012, 2.6, 0.36);
    X.box('band', cab1 + 0.1, 4.02, -1.3, cab1 + 0.14, 4.28, -0.5); X.box('band', cab1 + 0.1, 4.02, 0.5, cab1 + 0.14, 4.28, 1.3);
    for (const s of [-1, 1]) S.quad(null, ...(() => { const x = cab1 + 0.145, z0 = s * 0.55, z1 = s * 1.25, a = Math.min(z0, z1), b = Math.max(z0, z1);
      return [[x, 4.05, b], [x, 4.05, a], [x, 4.25, a], [x, 4.25, b]]; })(), [1, 0, 0], [[0, 0], [1, 0], [1, 0.5], [0, 0.5]]);
    const glow = { head: [], tail: [] };
    for (const s of [-1, 1]) {
      X.cyl('lampRim', nose1 + 0.01, 2.45, s * 0.2, 0.1, 0.04, 'x', 16); X.cyl('headLamp', nose1 + 0.03, 2.45, s * 0.2, 0.08, 0.02, 'x', 16); glow.head.push([nose1 + 0.1, 2.45, s * 0.2]);
      X.box('frameLt', 10.2, 1.12, s * 1.3 - 0.12, 10.36, 1.4, s * 1.3 + 0.12); X.cyl('headLamp', 10.37, 1.26, s * 1.3, 0.075, 0.03, 'x', 14); glow.head.push([10.45, 1.26, s * 1.3]);
      X.cyl('tailLamp', cab1 + 0.12, 4.18, s * 1.42, 0.05, 0.03, 'x', 12); glow.tail.push([cab1 + 0.18, 4.18, s * 1.42]);
    }
    for (const [x, dir] of [[10.1, 1], [-10.1, -1]]) {
      X.boxR('band', x + dir * 0.18, 0.72, 0, 0.1, 0.9, 3.0, 0, 0, dir * 0.35);
      X.box('yellow', Math.min(x, x + dir * 0.36), 1.1, -1.5, Math.max(x, x + dir * 0.36), 1.14, 1.5);
      X.rod('frame', x, 0.87, 0, x + dir * 0.36, 0.87, 0, 0.1, 8); X.box('frame', Math.min(x + dir * 0.3, x + dir * 0.45), 0.72, -0.2, Math.max(x + dir * 0.3, x + dir * 0.45), 1.02, 0.2);
      for (const s of [-1, 1]) { X.box('frame', x - 0.3, 0.55, s * 1.45 - 0.2, x + 0.3, 0.58, s * 1.45 + 0.2); X.box('frame', x - 0.3, 0.85, s * 1.45 - 0.2, x + 0.3, 0.88, s * 1.45 + 0.2); X.box('yellow', x - 0.3, 0.55, s * 1.62 - 0.01, x + 0.3, 1.12, s * 1.62); }
    }
    for (const s of [-1, 1]) {
      for (let x = -9.6; x <= 4.4; x += 1.75) X.rod('steel', x, D.DECK, s * 1.52, x, 2.45, s * 1.52, 0.02, 6);
      X.rod('steel', -9.6, 2.45, s * 1.52, 4.3, 2.45, s * 1.52, 0.022, 6); X.rod('steel', -9.6, 1.95, s * 1.52, 4.3, 1.95, s * 1.52, 0.016, 6);
    }
    for (const [dz, dir] of [[-0.2, 1], [0, 1], [0.2, 1], [-0.1, -1], [0.1, -1]]) X.rod('chrome', 6.15, 4.7, dz, 6.15 + dir * 0.42, 4.7, dz, 0.045, 10, 2.4);
    X.box('frameLt', 5.9, 4.56, -0.3, 6.4, 4.64, 0.3);
    X.cyl('brass', 8.2, 4.7, -0.9, 0.16, 0.22, 'y', 14); X.cyl('frameLt', 8.2, 4.58, -0.9, 0.04, 0.1, 'y', 6);
    X.box('frameLt', 5.1, 4.56, 0.8, 5.4, 4.64, 1.1); X.rod('black', 5.25, 4.64, 0.95, 5.25, 5.1, 0.95, 0.012, 4);
    const ext = U.mergeGeometries([X.geo(), T.geo()]);
    return {
      kind: 'diesel', type: 'loco', panto: false, length: D.L, width: 2 * W, height: 4.72, bogieOffsets: [D.TRK, -D.TRK],
      ext, glass: G.geo(), signs: S.geo(), glow, wheelR: D.WR, axles: [D.TRK + D.WB / 2, D.TRK - D.WB / 2, -D.TRK + D.WB / 2, -D.TRK - D.WB / 2],
      leaves: [], leafKey: 'none', sillY: D.DECK, bodyW: W,
      floorRegions: [{ name: 'cab', x0: cab0 + 0.15, x1: cab1 - 0.2, z0: -1.4, z1: 1.4, y: D.CABF }], ramps: [], gangways: { front: null, rear: null },
      seats: [{ x: 7.62, y: D.CABF + 1.2, z: 0.78, yaw: 0 }, { x: 7.62, y: D.CABF + 1.2, z: -0.8, yaw: 0 }], doors: [],
      cabEye: [7.55, D.CABF + 1.27, 0.76], pantoX: null,
      lodSpec: { cab0, cab1, nose1, hood0, hz, cz },
    };
  }

  // ------------------------------------------------------------------------------------------ DIESEL: bilevel coach / cab car
  // Bombardier-BiLevel-like: vertical lower sides, sloped (trapezoid) upper sides, end vestibules at the
  // intermediate level with side-by-side stairs up and down. 'cab' = coach with a control cab at +X.
  const BL = { L: 25.9, XE: 12.72, DD: 7.1, BOT: 0.40, BOTE: 1.0, W: 1.50, WI: 1.43, TOPV: 2.95, SZ: 1.12, SY: 4.30, ISZ: 1.06, ISY: 4.22,
    YL: 0.55, YM: 1.12, YU: 2.52, YUB: 2.38, UP0: 4.9, DN0: 6.1, CEILV: 3.9, BOG: 8.9, DOORC: 11.475, DOORW: 0.95, LEAFY: 0.45, DTOP: 2.95, GW: 0.45, GTOP: 3.05 };
  const blArc = [0, 30, 60, 90].map(a => [0.62 + 0.5 * Math.cos(a * Math.PI / 180), 4.30 + 0.5 * Math.sin(a * Math.PI / 180)]);
  const blSection = bot => [[-BL.W, bot], [-BL.W, BL.TOPV], ...blArc.map(([z, y]) => [-z, y]), ...blArc.slice().reverse(), [BL.W, BL.TOPV], [BL.W, bot]];
  const blRoof = () => [...blArc, ...blArc.slice().reverse().map(([z, y]) => [-z, y])];
  const blIRoof = () => [[BL.ISZ, BL.ISY], [0.85, 4.5], [0.5, 4.6], [-0.5, 4.6], [-0.85, 4.5], [-BL.ISZ, BL.ISY]];
  const slopeZ = (y, wBot, wTop, y0, y1) => wBot + (wTop - wBot) * (y - y0) / (y1 - y0);
  function blPlan(type) {
    const cab = type === 'cab';
    const doors = cab ? [-BL.DOORC] : [-BL.DOORC, BL.DOORC];
    return { type, cab, L: BL.L, xA: -BL.XE, xB: BL.XE, doors, bogies: [BL.BOG, -BL.BOG] };
  }
  function blOpenings(p) {
    const win = [], doors = [];
    const row = (a, b, n, y0, y1, gap = 0.3) => { const w = (b - a - (n - 1) * gap) / n; for (let i = 0; i < n; i++) win.push({ x0: a + i * (w + gap), x1: a + i * (w + gap) + w, y0, y1 }); };
    row(-6.85, 6.85, 6, 0.95, 2.05); row(-6.85, 6.85, 6, 3.1, 4.0);
    row(7.35, 10.55, 2, 1.85, 2.8); row(-10.55, -7.35, 2, 1.85, 2.8);
    for (const dc of p.doors) doors.push({ x0: dc - BL.DOORW / 2, x1: dc + BL.DOORW / 2, y0: BL.LEAFY, y1: BL.DTOP });
    return { win, doors };
  }
  function blSideColor(x, y) {
    if (Math.abs(x) < BL.DD) return y < 0.62 ? 'bodyLo' : y < 0.85 ? 'body' : y < 2.15 ? 'band' : y < 2.28 ? 'body' : y < 2.42 ? 'red' : y < 3.02 ? 'body' : y < 4.08 ? 'band' : 'body';
    return y < 1.12 ? 'bodyLo' : y < 1.6 ? 'body' : y < 1.72 ? 'red' : y < 1.78 ? 'body' : y < 2.88 ? 'band' : 'body';
  }
  function blLayout(p) {
    const S = [], Tb = [], both = [...AISLE_Z, ...AISLE_Z.map(z => -z)];
    bays(S, Tb, -BL.UP0, BL.UP0, BL.YL, both); bays(S, Tb, -BL.UP0, BL.UP0, BL.YU, both);
    bays(S, Tb, -9.15, -7.25, BL.YM, both);
    bays(S, Tb, 7.25, 9.15, BL.YM, p.cab ? AISLE_Z.map(z => -z) : both);
    return { seats: S, tables: Tb };
  }
  function blWalk(p) {
    const R = [], ramps = [], wi = BL.WI - 0.1;
    const add = (name, x0, x1, z0, z1, y) => R.push({ name, x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0, z1, y });
    add('lower', -BL.UP0, BL.UP0, -wi, wi, BL.YL); add('lower', BL.UP0, BL.DN0, -wi, -0.1, BL.YL); add('lower', -BL.DN0, -BL.UP0, 0.1, wi, BL.YL);
    add('upper', -BL.UP0, BL.UP0, -wi, wi, BL.YU);
    add('vestF', BL.DD, BL.XE - 0.08, -wi, wi, BL.YM); add('vestR', -BL.XE + 0.08, -BL.DD, -wi, wi, BL.YM);
    ramps.push({ x0: BL.UP0, x1: BL.DD, z0: 0.1, z1: 1.3, y0: BL.YU, y1: BL.YM }, { x0: BL.DN0, x1: BL.DD, z0: -1.3, z1: -0.1, y0: BL.YL, y1: BL.YM });
    ramps.push({ x0: -BL.DD, x1: -BL.UP0, z0: -1.3, z1: -0.1, y0: BL.YM, y1: BL.YU }, { x0: -BL.DD, x1: -BL.DN0, z0: 0.1, z1: 1.3, y0: BL.YM, y1: BL.YL });
    add('gangR', -BL.L / 2, -BL.XE + 0.08, -0.4, 0.4, BL.YM);
    const gangways = { rear: { x: -BL.L / 2, z0: -0.4, z1: 0.4, y: BL.YM }, front: null };
    if (p.cab) {
      R.find(r => r.name === 'vestF').x1 = 11.0;
      add('vestF', 11.0, BL.XE - 0.1, -wi, -0.1, BL.YM);
      ramps.push({ x0: 11.0, x1: 11.35, z0: 0.3, z1: 0.9, y0: BL.YM, y1: 1.45 });
      add('cab', 11.35, 12.55, 0.15, 1.33, 1.45);
    } else { add('gangF', BL.XE - 0.08, BL.L / 2, -0.4, 0.4, BL.YM); gangways.front = { x: BL.L / 2, z0: -0.4, z1: 0.4, y: BL.YM }; }
    return { floorRegions: R, ramps, gangways };
  }
  // Build the side (vertical + sloped parts) of a bilevel body. colorAt(x,y); holes in (x,y); z = +-w at the bottom.
  function blSide(T, xA, xB, bot, holes, colorAt, s, inner) {
    const w0 = inner ? BL.WI : BL.W, w1 = inner ? BL.ISZ : BL.SZ, y1 = inner ? BL.ISY : BL.SY, n = inner ? -s : s;
    wallGrid(T, xA, xB, bot, BL.TOPV, holes, colorAt, (u, v) => [u, v, s * w0], [0, 0, n], [BL.DD, -BL.DD], [0.62, 0.85, 1.12, 1.6, 1.72, 1.78, 2.15, 2.28, 2.42, 2.88]);
    const dz = w1 - w0, dy = y1 - BL.TOPV, l = Math.hypot(dz, dy);
    wallGrid(T, xA, xB, BL.TOPV, y1, holes, colorAt, (u, v) => [u, v, s * slopeZ(v, w0, w1, BL.TOPV, y1)], [0, (inner ? 1 : -1) * dz / l, n * dy / l], [BL.DD, -BL.DD], [3.02, 4.08]);
  }
  function blDesign(type) {
    const p = blPlan(type), { win, doors } = blOpenings(p), W = BL.W, WI = BL.WI;
    const X = new Parts(), T = new Tri(), G = new Tri(), S = new Tri();
    const cut = [{ x0: p.xA - 1, x1: -BL.DD, y0: 0, y1: BL.BOTE }, { x0: BL.DD, x1: p.xB + 1, y0: 0, y1: BL.BOTE }];
    const icut = [{ x0: p.xA - 1, x1: -BL.DD, y0: 0, y1: BL.YM }, { x0: BL.DD, x1: p.xB + 1, y0: 0, y1: BL.YM }, { x0: -BL.DD, x1: BL.DD, y0: 0, y1: BL.YL }];
    const inColor = (x, y) => y < (Math.abs(x) < BL.DD ? 0.85 : 1.6) ? 'panel' : (y > 2.36 && y < 2.54 && Math.abs(x) < BL.UP0) ? 'panelDk' : 'wall';
    const doorHoles = doors.map(h => ({ ...h, y0: 0 }));
    for (const s of [-1, 1]) {
      blSide(T, p.xA, p.xB, BL.BOT, [...win, ...doorHoles, ...cut], blSideColor, s, false);
      blSide(T, p.xA, p.xB, BL.BOT, [...win, ...doors, ...icut], inColor, s, true);
      for (const h of win) {
        const sl = h.y0 > 3, zo = y => s * (sl ? slopeZ(y, W, BL.SZ, BL.TOPV, BL.SY) : W), zi = y => s * (sl ? slopeZ(y, WI, BL.ISZ, BL.TOPV, BL.ISY) : WI);
        const a = [h.x0, h.y0, zo(h.y0) - s * 0.012], b = [h.x1, h.y0, zo(h.y0) - s * 0.012], c = [h.x1, h.y1, zo(h.y1) - s * 0.012], d = [h.x0, h.y1, zo(h.y1) - s * 0.012];
        if (s > 0) G.quad(null, a, b, c, d, null, [[0, 0.1], [1, 0.1], [1, 1], [0, 1]]); else G.quad(null, b, a, d, c, null, [[0, 0.1], [1, 0.1], [1, 1], [0, 1]]);
        T.quad('panelDk', [h.x0, h.y0, zi(h.y0)], [h.x1, h.y0, zi(h.y0)], [h.x1, h.y0, zo(h.y0)], [h.x0, h.y0, zo(h.y0)], [0, 1, 0]);
        T.quad('panelDk', [h.x0, h.y1, zo(h.y1)], [h.x1, h.y1, zo(h.y1)], [h.x1, h.y1, zi(h.y1)], [h.x0, h.y1, zi(h.y1)], [0, -1, 0]);
        T.quad('panelDk', [h.x0, h.y0, zo(h.y0)], [h.x0, h.y1, zo(h.y1)], [h.x0, h.y1, zi(h.y1)], [h.x0, h.y0, zi(h.y0)], [1, 0, 0]);
        T.quad('panelDk', [h.x1, h.y0, zi(h.y0)], [h.x1, h.y1, zi(h.y1)], [h.x1, h.y1, zo(h.y1)], [h.x1, h.y0, zo(h.y0)], [-1, 0, 0]);
      }
      for (const dc of p.doors) {   // door well: two steps down to the platform
        const z0 = Math.min(s * (W - 0.33), s * W), z1 = Math.max(s * (W - 0.33), s * W), zm = s * (W - 0.16);
        X.box('frame', dc - 0.5, BL.LEAFY - 0.05, z0, dc + 0.5, BL.BOTE, z1);
        X.box('floorLt', dc - 0.47, 0.78, Math.min(zm, s * (W - 0.33)), dc + 0.47, 0.8, Math.max(zm, s * (W - 0.33)));
        X.box('stepEdge', dc - 0.47, 0.8, Math.min(zm, zm + s * 0.04), dc + 0.47, 0.803, Math.max(zm, zm + s * 0.04));
        X.box('stepEdge', dc - 0.47, BL.YM, Math.min(s * (W - 0.34), s * (W - 0.3)), dc + 0.47, BL.YM + 0.004, Math.max(s * (W - 0.34), s * (W - 0.3)));
      }
      const sx0 = 7.45, sx1 = 8.85, sy0 = 2.42, sy1 = 2.6, sz = s * (W + 0.008);
      X.box('black', sx0 - 0.04, sy0 - 0.04, Math.min(s * (W - 0.01), s * (W + 0.006)), sx1 + 0.04, sy1 + 0.04, Math.max(s * (W - 0.01), s * (W + 0.006)));
      if (s > 0) S.quad(null, [sx0, sy0, sz], [sx1, sy0, sz], [sx1, sy1, sz], [sx0, sy1, sz], [0, 0, 1], [[0, 0.5], [1, 0.5], [1, 1], [0, 1]]);
      else S.quad(null, [sx1, sy0, sz], [sx0, sy0, sz], [sx0, sy1, sz], [sx1, sy1, sz], [0, 0, -1], [[0, 0.5], [1, 0.5], [1, 1], [0, 1]]);
    }
    extrudeX(T, blRoof(), p.xA, p.xB, (i, y) => y > 4.79 ? 'roof' : 'body', 0, 2.5);
    extrudeX(T, blIRoof(), -BL.DD, BL.DD, () => 'ceiling', 0, 7);
    for (const z of [-0.42, 0.42]) T.hq('light', -BL.DD + 0.3, BL.DD - 0.3, z - 0.06, z + 0.06, 4.59, false);
    T.hq('frame', -BL.DD, BL.DD, -W, W, BL.BOT, false); T.hq('frame', p.xA, -BL.DD, -W, W, BL.BOTE, false); T.hq('frame', BL.DD, p.xB, -W, W, BL.BOTE, false);
    T.xq('bodyLo', -BL.DD, -W, W, BL.BOT, BL.BOTE, -1); T.xq('bodyLo', BL.DD, -W, W, BL.BOT, BL.BOTE, 1);
    // inner floors, slab, stairs, vestibules, ceilings
    T.hq('floor', -BL.DD, BL.DD, -WI, WI, BL.YL, true);
    T.slab(-BL.UP0, BL.UP0, -WI, WI, BL.YUB, BL.YU, 'floor', 'ceiling', 'panel');
    for (const z of [-0.55, 0.55]) T.hq('light', -BL.UP0 + 0.2, BL.UP0 - 0.2, z - 0.06, z + 0.06, BL.YUB - 0.006, false);
    const stairs = (dir) => {  // dir +1 front end, -1 rear end (rotational symmetry)
      const zu = dir > 0 ? [0.05, WI] : [-WI, -0.05], zd = dir > 0 ? [-WI, -0.05] : [0.05, WI];
      const nu = 8, ru = (BL.DD - BL.UP0) / nu, hu = (BL.YU - BL.YM) / nu;
      for (let i = 0; i < nu; i++) { const xa = dir * (BL.DD - i * ru), xb = dir * (BL.DD - (i + 1) * ru), top = BL.YM + (i + 1) * hu;
        X.box('panelDk', Math.min(xa, xb), BL.YL, zu[0], Math.max(xa, xb), top, zu[1]); T.hq('floor', Math.min(xa, xb), Math.max(xa, xb), zu[0], zu[1], top + 0.002, true);
        T.hq('stepEdge', Math.min(xa, xa - dir * 0.05), Math.max(xa, xa - dir * 0.05), zu[0], zu[1], top + 0.004, true); }
      const nd = 3, rd = (BL.DD - BL.DN0) / nd, hd = (BL.YM - BL.YL) / nd;
      for (let i = 0; i < nd; i++) { const xa = dir * (BL.DD - i * rd), xb = dir * (BL.DD - (i + 1) * rd), top = BL.YM - (i + 1) * hd;
        X.box('panelDk', Math.min(xa, xb), BL.YL, zd[0], Math.max(xa, xb), top + hd, zd[1]);
        T.hq('stepEdge', Math.min(xb, xb + dir * 0.05), Math.max(xb, xb + dir * 0.05), zd[0], zd[1], top + hd + 0.003, true); }
      const zin = dir > 0 ? 0.05 : -0.05;
      X.rod('pole', dir * BL.DD, BL.YM + 0.9, zin, dir * BL.UP0, BL.YU + 0.9, zin, 0.02); X.rod('pole', dir * BL.DD, BL.YM + 0.9, -zin, dir * BL.DN0, BL.YL + 0.9, -zin, 0.02);
      X.rod('pole', dir * BL.UP0, BL.YU, -zin * 20, dir * BL.UP0, BL.YU + 1.0, -zin * 20, 0.022);
      X.rod('pole', dir * BL.UP0, BL.YU + 1.0, -zin * 20, dir * BL.UP0, BL.YU + 1.0, -dir * WI, 0.022);
      G.quad(null, [dir * BL.UP0, BL.YU, Math.min(-zin * 20, -dir * WI)], [dir * BL.UP0, BL.YU, Math.max(-zin * 20, -dir * WI)], [dir * BL.UP0, BL.YU + 1, Math.max(-zin * 20, -dir * WI)], [dir * BL.UP0, BL.YU + 1, Math.min(-zin * 20, -dir * WI)], [1, 0, 0], [[0.5, 0.03], [0.5, 0.03], [0.5, 0.03], [0.5, 0.03]]);
      const xv0 = Math.min(dir * BL.DD, dir * (BL.XE - 0.07)), xv1 = Math.max(dir * BL.DD, dir * (BL.XE - 0.07));
      T.hq('floor', xv0, xv1, -WI, WI, BL.YM, true);
      T.hq('ceiling', xv0, xv1, -WI, WI, BL.CEILV, false); T.hq('light', xv0 + 0.3, xv1 - 0.3, -0.08, 0.08, BL.CEILV - 0.006, false);
      T.xq('wall', dir * BL.DD, -WI, WI, BL.CEILV, 4.62, -dir);
    };
    stairs(1); stairs(-1);
    // gangway ends
    const gh = { z0: -BL.GW, z1: BL.GW, y0: BL.YM, y1: BL.GTOP };
    const ends = p.cab ? [[p.xA, -1]] : [[p.xA, -1], [p.xB, 1]];
    for (const [xe, s] of ends) {
      capX(X, blSection(BL.BOTE), xe, s, 'body', gh);
      const xi = xe - s * 0.07;
      wallGrid(T, -WI, WI, BL.YM, BL.CEILV, [{ x0: -BL.GW, x1: BL.GW, y0: BL.YM, y1: BL.GTOP }], (u, v) => v < 1.6 ? 'panel' : 'wall', (u, v) => [xi, v, u], [-s, 0, 0]);
      const xa = Math.min(xi, xe), xb = Math.max(xi, xe);
      T.hq('panelDk', xa, xb, -BL.GW, BL.GW, BL.GTOP, false); T.zq('panelDk', -BL.GW, xa, xb, BL.YM, BL.GTOP, 1); T.zq('panelDk', BL.GW, xa, xb, BL.YM, BL.GTOP, -1);
      const xc = s * BL.L / 2;
      bellows(T, T, xe, xc, 0.68, 1.02, 3.22, 0.52, BL.YM, 3.12);
      T.hq('floorLt', Math.min(xi, xc), Math.max(xi, xc), -0.5, 0.5, BL.YM + 0.004, true);
      X.rod('frame', xe - s * 0.4, 0.87, 0, xc, 0.87, 0, 0.1, 8); X.box('frame', Math.min(xc, xc - s * 0.15), 0.72, -0.2, Math.max(xc, xc - s * 0.15), 1.02, 0.2);
    }
    // cab car front: windscreen wall, lights, pilot, sign, horn
    let glow = null;
    if (p.cab) {
      const xf = p.xB, fwin = [{ x0: -1.25, x1: -0.12, y0: 2.05, y1: 2.85 }, { x0: 0.12, x1: 1.25, y0: 2.05, y1: 2.85 }];
      wallGrid(T, -W, W, BL.BOTE, BL.TOPV, fwin, (u, v) => v < 1.95 ? 'red' : 'band', (u, v) => [xf, v, u], [1, 0, 0], [], [1.95]);
      capX(X, [[-W, BL.TOPV], [W, BL.TOPV], ...blArc, ...blArc.slice().reverse().map(([z, y]) => [-z, y])], xf, 1, 'body');
      for (const h of fwin) { G.quad(null, [xf + 0.004, h.y0, h.x1], [xf + 0.004, h.y0, h.x0], [xf + 0.004, h.y1, h.x0], [xf + 0.004, h.y1, h.x1], [1, 0, 0], [[0.5, 0.03], [0.5, 0.03], [0.5, 0.03], [0.5, 0.03]]);
        T.hq('panelDk', xf - 0.07, xf, h.x0, h.x1, h.y0, true); T.hq('panelDk', xf - 0.07, xf, h.x0, h.x1, h.y1, false); }
      wallGrid(T, -WI, WI, BL.YM, BL.CEILV, fwin, (u, v) => v < 1.6 ? 'panel' : 'wall', (u, v) => [xf - 0.07, v, u], [-1, 0, 0]);
      glow = { head: [], tail: [] };
      for (const s of [-1, 1]) {
        X.box('band', xf, 1.42, s * 0.62 - 0.2, xf + 0.05, 1.68, s * 0.62 + 0.2);
        X.cyl('headLamp', xf + 0.06, 1.55, s * 0.55, 0.08, 0.02, 'x', 16); glow.head.push([xf + 0.12, 1.55, s * 0.55]);
        X.cyl('tailLamp', xf + 0.06, 1.55, s * 0.74, 0.055, 0.02, 'x', 14); glow.tail.push([xf + 0.12, 1.55, s * 0.74]);
        X.cyl('tailLamp', xf + 0.03, 4.25, s * 0.42, 0.05, 0.03, 'x', 12); glow.tail.push([xf + 0.1, 4.25, s * 0.42]);
        X.box('frameLt', xf + 0.05, 0.85, s * 1.22 - 0.1, xf + 0.25, 1.05, s * 1.22 + 0.1); X.cyl('headLamp', xf + 0.26, 0.95, s * 1.22, 0.07, 0.02, 'x', 14); glow.head.push([xf + 0.32, 0.95, s * 1.22]);
      }
      X.boxR('band', xf + 0.2, 0.62, 0, 0.1, 0.8, 2.9, 0, 0, 0.35);
      X.rod('frame', xf, 0.87, 0, BL.L / 2, 0.87, 0, 0.1, 8); X.box('frame', BL.L / 2 - 0.15, 0.72, -0.2, BL.L / 2, 1.02, 0.2);
      X.box('black', xf, 3.15, -0.7, xf + 0.02, 3.47, 0.7);
      S.quad(null, [xf + 0.025, 3.2, 0.64], [xf + 0.025, 3.2, -0.64], [xf + 0.025, 3.42, -0.64], [xf + 0.025, 3.42, 0.64], [1, 0, 0], [[0, 0.5], [1, 0.5], [1, 1], [0, 1]]);
      for (const [dz, dir] of [[-0.12, 1], [0.12, 1], [0, -1]]) X.rod('chrome', 11.3, 4.93, dz, 11.3 + dir * 0.36, 4.93, dz, 0.04, 10, 2.4);
      X.box('frameLt', 11.15, 4.78, -0.2, 11.45, 4.9, 0.2);
      X.boxR('black', xf + 0.01, 2.1, 0.7, 0.02, 0.5, 0.025, 0.9, 0, 0); X.boxR('black', xf + 0.01, 2.1, -0.7, 0.02, 0.5, 0.025, -0.9, 0, 0);
    }
    // roof: AC units over the vestibules
    for (const cx of [-10.0, 10.0]) { X.box('roof', cx - 1.1, 4.62, -0.6, cx + 1.1, 4.9, 0.6); X.cyl('grille', cx, 4.905, 0, 0.3, 0.01, 'y', 16); }
    p.bogies.forEach(bx => bogie(X, bx, D.BWB, D.BR, false, true));
    const walk = blWalk(p), lay = blLayout(p);
    const seats = lay.seats.map(s => ({ x: s.x + Math.cos(s.yaw) * 0.12, y: s.y + 1.18, z: s.z, yaw: s.yaw }));
    if (p.cab) seats.push({ x: 11.9, y: 1.45 + 1.18, z: 0.72, yaw: 0 });
    const doorsMeta = []; for (const dc of p.doors) for (const s of [1, -1]) doorsMeta.push({ x: dc, side: s, width: BL.DOORW, sillY: BL.YM });
    const leaves = []; for (const dc of p.doors) for (const s of [1, -1]) for (const k of [-1, 1]) leaves.push({ dc, s, k });
    return {
      kind: 'diesel', type, panto: false, plan: p, length: BL.L, width: 2 * W, height: 4.82, bogieOffsets: p.bogies.slice(),
      ext: U.mergeGeometries([X.geo(), T.geo()]), glass: G.geo(), signs: S.geo(), glow, wheelR: D.BR,
      axles: p.bogies.flatMap(b => [b + D.BWB / 2, b - D.BWB / 2]),
      leaves, leafKey: 'bilevel', leafW: BL.DOORW / 2, leafH: BL.DTOP - BL.LEAFY, leafWin: [-0.14, 0.14, 1.25, 2.2], sillY: BL.YM, leafY: BL.LEAFY, bodyW: W,
      floorRegions: walk.floorRegions, ramps: walk.ramps, gangways: walk.gangways, seats, layout: lay, doors: doorsMeta,
      cabEye: p.cab ? [11.9, 1.45 + 1.22, 0.72] : null, pantoX: null, win, doorsOpen: doors,
    };
  }
  function dslDesign(t) { return t === 'loco' ? locoDesign() : blDesign(t); }

  // Diesel LODs, decals and interiors
  function dslLod(d, level) {
    const X = new Parts(), T = new Tri();
    const lamps = () => { if (!d.glow) return; for (const h of d.glow.head) X.box('headLamp', h[0] - 0.1, h[1] - 0.08, h[2] - 0.08, h[0], h[1] + 0.08, h[2] + 0.08);
      for (const h of d.glow.tail) X.box('tailLamp', h[0] - 0.1, h[1] - 0.06, h[2] - 0.06, h[0], h[1] + 0.06, h[2] + 0.06); };
    if (d.type === 'loco') {
      const o = d.lodSpec;
      X.box('frame', -10.1, 1.12, -D.W, 10.1, D.DECK, D.W); X.box('frame', -3.9, 0.55, -1.3, 3.5, 1.12, 1.3);
      X.box('body', o.hood0, D.DECK, -o.hz, o.cab0, 4.35, o.hz); X.box('band', o.hood0 + 0.05, 3.35, -o.hz - 0.01, o.cab0, 3.75, o.hz + 0.01);
      X.box('body', -9.7, 4.35, -o.hz, -4.6, 4.55, o.hz);
      X.box('body', o.cab0, D.DECK, -o.cz, o.cab1, 4.45, o.cz); X.box('red', o.cab0 + 0.02, D.DECK, -o.cz - 0.01, o.cab1, 2.05, o.cz + 0.01);
      X.box('lodGlass', o.cab0 + 1.6, 2.95, -o.cz - 0.012, o.cab1 - 0.3, 3.88, o.cz + 0.012); X.box('lodGlass', o.cab1, 2.95, -1.38, o.cab1 + 0.012, 3.9, 1.38);
      X.box('red', o.cab1, D.DECK, -1.16, o.nose1, 2.85, 1.16);
      for (const bx of [D.TRK, -D.TRK]) X.box('frame', bx - 1.9, 0.1, -1.2, bx + 1.9, 1.12, 1.2);
      lamps(); return X.geo();
    }
    const p = d.plan, W = BL.W, holes = [{ x0: p.xA - 1, x1: -BL.DD, y0: 0, y1: BL.BOTE }, { x0: BL.DD, x1: p.xB + 1, y0: 0, y1: BL.BOTE }];
    const inR = (hs, x, y) => hs.some(h => x > h.x0 && x < h.x1 && y > h.y0 && y < h.y1);
    const color = level === 1 ? (x, y) => inR(d.win, x, y) ? 'lodGlass' : inR(d.doorsOpen, x, y) ? 'bodyLo' : blSideColor(x, y)
      : (x, y) => { const c = blSideColor(x, y); return c === 'band' ? 'lodGlass' : c; };
    for (const s of [-1, 1]) {
      wallGrid(T, p.xA, p.xB, BL.BOT, BL.TOPV, holes, color, (u, v) => [u, v, s * W], [0, 0, s], level === 1 ? [BL.DD, -BL.DD, ...d.win.flatMap(h => [h.x0, h.x1]), ...d.doorsOpen.flatMap(h => [h.x0, h.x1])] : [BL.DD, -BL.DD], [0.62, 0.85, 0.95, 1.12, 1.6, 1.72, 1.78, 1.85, 2.05, 2.15, 2.28, 2.42, 2.8, 2.88]);
      const dz = BL.SZ - W, dy = BL.SY - BL.TOPV, l = Math.hypot(dz, dy);
      wallGrid(T, p.xA, p.xB, BL.TOPV, BL.SY, [], color, (u, v) => [u, v, s * slopeZ(v, W, BL.SZ, BL.TOPV, BL.SY)], [0, -dz / l, s * dy / l], level === 1 ? [BL.DD, -BL.DD, ...d.win.flatMap(h => [h.x0, h.x1])] : [BL.DD, -BL.DD], [3.02, 3.1, 4.0, 4.08]);
    }
    extrudeX(T, level === 1 ? blRoof() : [[BL.SZ, BL.SY], [0.62, 4.8], [-0.62, 4.8], [-BL.SZ, BL.SY]], p.xA, p.xB, (i, y) => y > 4.79 ? 'roof' : 'body', 0, 2.5);
    T.hq('frame', -BL.DD, BL.DD, -W, W, BL.BOT, false); T.xq('bodyLo', -BL.DD, -W, W, BL.BOT, BL.BOTE, -1); T.xq('bodyLo', BL.DD, -W, W, BL.BOT, BL.BOTE, 1);
    capX(X, blSection(BL.BOTE), p.xA, -1, 'body'); capX(X, blSection(BL.BOTE), p.xB, 1, 'body');
    if (p.cab) { X.box('red', p.xB, BL.BOTE, -W, p.xB + 0.01, 1.95, W); X.box('lodGlass', p.xB, 2.05, -1.25, p.xB + 0.012, 2.85, 1.25); }
    for (const bx of p.bogies) X.box('frame', bx - 1.75, 0.12, -1.15, bx + 1.75, 1.0, 1.15);
    lamps();
    return U.mergeGeometries([X.geo(), T.geo()]);
  }
  function dslDecals(d, number) {
    decalAtlas();
    const T = new Tri();
    for (const s of [-1, 1]) {
      if (d.type === 'loco') {
        const o = d.lodSpec;
        decalZ(T, 'word', -2.4, 2.8, s * (o.hz + 0.007), 2.7, 0.54, s);
        numberZ(T, number, 7.25, 2.47, s * (o.cz + 0.007), 0.3, s);
      } else {
        decalZ(T, 'word', -8.7, 1.37, s * (BL.W + 0.007), 1.6, 0.32, s);
        numberZ(T, number, 8.7, 1.37, s * (BL.W + 0.007), 0.26, s);
        for (const dc of d.plan.doors) decalZ(T, 'wheelchair', dc + Math.sign(dc) * 0.78, 2.35, s * (BL.W + 0.007), 0.34, 0.34, s);
      }
    }
    if (d.type === 'cab') decalX(T, 'wordW', BL.XE + 0.008, 1.2, 0, 1.1, 0.22, 1);
    return T.geo();
  }
  function cabDesk(X, C, x0, x1, y, z0, z1, eyeZ) {   // desk facing +X with two screens in front of eyeZ; returns handle pivot
    X.box('desk', x0, y, z0, x1, y + 0.72, z1);
    X.boxR('deskLt', x0 + 0.2, y + 0.8, (z0 + z1) / 2, 0.42, 0.06, z1 - z0, 0, 0, 0.42);
    X.boxR('screenOff', x0 + 0.28, y + 0.92, eyeZ, 0.05, 0.32, 0.92, 0, 0, -0.55);
    screenX(C, x0 + 0.25, y + 0.93, eyeZ - 0.22, 0.42, 0.28, -1, [0, 0, 0.5, 1], 0.55);
    screenX(C, x0 + 0.25, y + 0.93, eyeZ + 0.22, 0.42, 0.28, -1, [0.5, 0, 1, 1], 0.55);
    for (let i = 0; i < 5; i++) X.cyl(i % 2 ? 'btnYellow' : 'btnGreen', x0 + 0.14, y + 0.83, z0 + 0.1 + i * 0.06, 0.013, 0.015, 'y', 8);
    X.cyl('btnRed', x0 + 0.12, y + 0.83, z1 - 0.1, 0.035, 0.03, 'y', 12);
    X.box('frameLt', x0 - 0.05, y + 0.72, eyeZ - 0.72, x0 + 0.15, y + 0.78, eyeZ - 0.5);
    return [x0 + 0.05, y + 0.78, eyeZ - 0.61];
  }
  function cabChair(X, x, y, z) {
    X.box('cabSeat', x - 0.05, y, z - 0.1, x + 0.05, y + 0.42, z + 0.1);
    X.box('cabSeat', x - 0.25, y + 0.42, z - 0.26, x + 0.25, y + 0.52, z + 0.26);
    X.boxR('cabSeat', x - 0.27, y + 0.95, z, 0.1, 0.85, 0.5, 0, 0, 0.12);
    for (const s of [-1, 1]) X.box('seatDk', x - 0.15, y + 0.7, z + s * 0.28 - 0.03, x + 0.25, y + 0.74, z + s * 0.28 + 0.03);
  }
  function dslInterior(d) {
    if (d.int) return d.int;
    const X = new Parts(), T = new Tri(), G = new Tri(), P = new Tri(), C = new Tri();
    let pivot = null, seatsL = [];
    if (d.type === 'loco') {
      pivot = cabDesk(X, C, 7.95, 8.8, D.CABF, 0.05, 1.5, 0.76);
      cabChair(X, 7.4, D.CABF, 0.76); cabChair(X, 7.4, D.CABF, -0.8);
      X.box('deskLt', 8.2, D.CABF, -1.5, 8.8, D.CABF + 0.8, -0.3);
      X.box('panelDk', 4.45, D.CABF, -0.4, 4.5, D.CABF + 1.95, 0.4);
      X.box('band', 8.62, 3.9, -1.4, 8.8, 3.95, 1.4);
      T.hq('light', 5.2, 8.2, -0.1, 0.1, 4.245, false);
    } else {
      const p = d.plan, WI = BL.WI;
      seatsL = d.layout.seats;
      for (const t of d.layout.tables) { const za = t.z > 0 ? 0.78 : -WI + 0.02, zb = t.z > 0 ? WI - 0.02 : -0.78; X.box('table', t.x - 0.3, t.y + 0.71, za, t.x + 0.3, t.y + 0.745, zb); }
      for (const dir of [1, -1]) {
        X.rod('pole', dir * 9.6, BL.YM, 0, dir * 9.6, BL.CEILV, 0, 0.022, 10);
        const xm = dir * (BL.XE - 0.09);
        if (!(p.cab && dir > 0)) { X.box('black', xm - 0.02, 3.35, -0.34, xm + 0.02, 3.65, 0.34); screenX(P, xm - dir * 0.022, 3.5, 0, 0.6, 0.24, -dir); }
        X.box('black', dir * BL.UP0 - 0.02, 3.8, -0.4, dir * BL.UP0 + 0.02, 4.1, 0.4); screenX(P, dir * BL.UP0 - dir * 0.022, 3.95, 0, 0.72, 0.26, -dir);
        for (const s of [-1, 1]) X.box('pole', dir > 0 ? 7.3 : -10.4, 3.25, s > 0 ? 1.0 : -WI, dir > 0 ? 10.4 : -7.3, 3.27, s > 0 ? WI : -1.0);
        for (const dc of p.doors) if (Math.sign(dc) === dir) for (const s of [-1, 1]) { X.rod('pole', dc - 0.55, BL.YM, s * (WI - 0.3), dc - 0.55, BL.YM + 1.9, s * (WI - 0.3), 0.02); X.rod('pole', dc + 0.55, BL.YM, s * (WI - 0.3), dc + 0.55, BL.YM + 1.9, s * (WI - 0.3), 0.02); }
      }
      if (p.cab) {
        const xf = BL.XE - 0.07;
        X.box('panelDk', 11.33, 1.45 - 0.33, 0.05, xf, 1.45, WI);
        X.box('panel', 11.3, 1.12, 0.03, 11.35, 3.1, 0.3); X.box('panel', 11.3, 1.12, 1.0, 11.35, 3.1, WI);
        X.box('panel', 11.35, 1.45, 0.03, xf, 3.1, 0.07);
        pivot = cabDesk(X, C, 12.12, xf, 1.45, 0.1, WI, 0.72);
        cabChair(X, 11.72, 1.45, 0.72);
        X.box('band', xf - 0.12, 2.95, 0.1, xf, 3.0, WI);
      }
    }
    const hg = new Parts();
    hg.rod('steel', 0, 0, 0, 0, 0.2, 0, 0.012, 6); hg.box('black', -0.03, 0.18, -0.05, 0.03, 0.24, 0.05); hg.box('frameLt', -0.06, -0.01, -0.03, 0.06, 0.02, 0.03);
    d.int = {
      furn: U.mergeGeometries([X.geo(), T.geo()]), glass: G.geo(), pis: P.geo(), cab: C.geo(),
      seatMatrices: mat4List(seatsL, s => [s.x, s.y, s.z, s.yaw]), seatCount: seatsL.length, bikeMatrices: new Float32Array(0), bikeCount: 0,
      handle: pivot ? { pivot } : null, handleGeo: pivot ? hg.geo() : null,
    };
    return d.int;
  }


  // ------------------------------------------------------------------------------------------ runtime: canvases
  const ROUTE_COLORS = { 'Local': '#3d6f86', 'Local Weekday': '#3d6f86', 'Local Weekend': '#3d6f86', 'Limited': '#c79a4f', 'Express': '#c4122f', 'South County': '#7d9e62' };
  const _led = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  // Amber dot-matrix text into a rect of ctx (cols x rows dots).
  function drawLed(ctx, text, x0, y0, w, h, cols, rows, color) {
    _led.width = cols; _led.height = rows; const g = _led.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000'; g.fillRect(0, 0, cols, rows); g.fillStyle = '#fff';
    g.font = `700 ${rows - 3}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`; g.textBaseline = 'middle';
    const tw = g.measureText(text).width, sc = Math.min(1, (cols - 4) / Math.max(1, tw));
    g.setTransform(sc, 0, 0, 1, (cols - tw * sc) / 2, 0); g.fillText(text, 0, rows / 2 + 0.5); g.setTransform(1, 0, 0, 1, 0, 0);
    const px = g.getImageData(0, 0, cols, rows).data, dx = w / cols, dy = h / rows, r = Math.min(dx, dy) * 0.36;
    ctx.fillStyle = '#050403'; ctx.fillRect(x0, y0, w, h);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const on = px[(j * cols + i) * 4] > 110;
      ctx.fillStyle = on ? color : '#1c1206';
      ctx.beginPath(); ctx.arc(x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dy, on ? r * 1.15 : r * 0.8, 0, 6.2832); ctx.fill();
    }
  }
  function fmtFt(ft) { if (!isFinite(ft)) return ''; return ft >= 5280 * 0.95 ? (ft / 5280).toFixed(1) + ' mi' : Math.round(ft).toLocaleString('en-US') + ' ft'; }
  function drawPis(g, W, H, s) {
    const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#0c1a28'); bg.addColorStop(1, '#122436');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const rc = ROUTE_COLORS[s.route] || '#3d6f86';
    g.fillStyle = rc; g.fillRect(0, 0, W, 50); g.fillStyle = '#c4122f'; g.fillRect(0, 50, W, 4);
    g.fillStyle = '#fff'; g.font = `800 30px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillText(String(s.route || 'Bayline').toUpperCase(), 16, 27);
    g.textAlign = 'right'; g.font = `700 30px ${FONT}`; g.fillText(s.clock || '', W - 16, 27);
    g.textAlign = 'left'; g.fillStyle = '#8fb4c9'; g.font = `600 22px ${FONT}`; g.fillText('NEXT STOP', 18, 84);
    g.fillStyle = '#fff'; g.font = `800 50px ${FONT}`;
    const ns = String(s.nextStop || ''), tw = g.measureText(ns).width; g.save(); g.translate(18, 132); g.scale(Math.min(1, (W - 36) / Math.max(tw, 1)), 1); g.fillText(ns, 0, 0); g.restore();
    g.fillStyle = '#c9d6df'; g.font = `600 26px ${FONT}`; g.fillText(s.destination ? 'to ' + s.destination : '', 18, 184);
    g.strokeStyle = '#3a5870'; g.lineWidth = 4; g.beginPath(); g.moveTo(18, 222); g.lineTo(W - 18, 222); g.stroke();
    for (let i = 0; i < 6; i++) { g.fillStyle = i === 1 ? '#f2c230' : '#6f93aa'; g.beginPath(); g.arc(30 + i * ((W - 60) / 5), 222, i === 1 ? 9 : 6, 0, 6.3); g.fill(); }
  }
  function drawCab(g, W, H, s) {
    g.fillStyle = '#05080b'; g.fillRect(0, 0, W, H);
    const hw = W / 2;
    // left: speedometer
    const cx = hw / 2, cy = H * 0.56, R = H * 0.4, a0 = Math.PI * 0.8, a1 = Math.PI * 2.2, max = 110;
    const ang = v => a0 + (a1 - a0) * clamp(v / max, 0, 1);
    g.lineWidth = 10; g.strokeStyle = '#1d2a33'; g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
    if (s.limitMph > 0) { g.strokeStyle = '#2f8f4e'; g.beginPath(); g.arc(cx, cy, R, a0, ang(s.limitMph)); g.stroke(); g.strokeStyle = '#d23a3a'; g.lineWidth = 16; g.beginPath(); g.arc(cx, cy, R, ang(s.limitMph) - 0.02, ang(s.limitMph) + 0.02); g.stroke(); }
    g.strokeStyle = '#9fb3c1'; g.lineWidth = 2; g.fillStyle = '#9fb3c1'; g.font = `600 15px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let v = 0; v <= max; v += 10) { const a = ang(v), c = Math.cos(a), sn = Math.sin(a); g.beginPath(); g.moveTo(cx + c * (R - 16), cy + sn * (R - 16)); g.lineTo(cx + c * (R - 4), cy + sn * (R - 4)); g.stroke(); if (v % 20 === 0) g.fillText(String(v), cx + c * (R - 32), cy + sn * (R - 32)); }
    const a = ang(Math.abs(s.speedMph || 0)); g.strokeStyle = '#f5f1e6'; g.lineWidth = 5; g.beginPath(); g.moveTo(cx - Math.cos(a) * 12, cy - Math.sin(a) * 12); g.lineTo(cx + Math.cos(a) * (R - 10), cy + Math.sin(a) * (R - 10)); g.stroke();
    g.fillStyle = '#f5f1e6'; g.font = `800 46px ${FONT}`; g.fillText(String(Math.round(Math.abs(s.speedMph || 0))), cx, cy + R * 0.42);
    g.font = `600 15px ${FONT}`; g.fillStyle = '#9fb3c1'; g.fillText('MPH', cx, cy + R * 0.7);
    const th = clamp(s.throttle || 0, 0, 1), br = clamp(s.brake || 0, 0, 1);
    g.textAlign = 'left'; g.font = `700 18px ${FONT}`;
    g.fillStyle = th > 0 ? '#3fc070' : br > 0 ? '#f2b132' : '#9fb3c1';
    g.fillText(th > 0 ? `POWER ${Math.round(th * 100)}%` : br > 0 ? `BRAKE ${Math.round(br * 100)}%` : 'COAST', 14, 22);
    g.textAlign = 'right'; g.fillStyle = '#d23a3a'; g.fillText(s.limitMph > 0 ? `LIMIT ${Math.round(s.limitMph)}` : '', hw - 14, 22);
    // right: signal, PTC, next stop, distance, clock
    g.strokeStyle = '#223440'; g.lineWidth = 2; g.beginPath(); g.moveTo(hw, 10); g.lineTo(hw, H - 10); g.stroke();
    const sig = String(s.signal || 'clear').toLowerCase(), sc = sig.startsWith('stop') || sig === 'red' ? '#e03a3a' : sig.startsWith('app') || sig === 'yellow' ? '#f2c230' : sig.startsWith('restr') ? '#e8e8e8' : '#3fd070';
    g.fillStyle = '#111a20'; g.beginPath(); g.arc(hw + 62, 70, 44, 0, 6.3); g.fill(); g.fillStyle = sc; g.beginPath(); g.arc(hw + 62, 70, 32, 0, 6.3); g.fill();
    g.textAlign = 'left'; g.fillStyle = '#9fb3c1'; g.font = `600 16px ${FONT}`; g.fillText('SIGNAL', hw + 120, 44);
    g.fillStyle = '#f5f1e6'; g.font = `800 26px ${FONT}`; g.fillText(sig.toUpperCase(), hw + 120, 76);
    const ptc = s.ptc === undefined ? 'active' : s.ptc === true ? 'active' : s.ptc === false ? 'cut out' : String(s.ptc).toLowerCase();
    const pc = ptc.startsWith('warn') ? '#f2b132' : ptc.startsWith('enf') || ptc.startsWith('pen') ? '#e03a3a' : ptc.startsWith('cut') ? '#707a82' : '#2f9b57';
    g.fillStyle = pc; g.fillRect(hw + 16, 128, hw - 32, 40); g.fillStyle = '#fff'; g.font = `800 22px ${FONT}`; g.textBaseline = 'middle'; g.fillText('PTC ' + ptc.toUpperCase(), hw + 30, 149);
    g.fillStyle = '#9fb3c1'; g.font = `600 16px ${FONT}`; g.fillText('NEXT STOP', hw + 18, 196);
    g.fillStyle = '#f5f1e6'; g.font = `800 28px ${FONT}`; g.fillText(String(s.nextStop || '—').slice(0, 22), hw + 18, 228);
    g.fillStyle = '#f2c230'; g.font = `700 26px ${FONT}`; g.fillText(s.distFt != null ? fmtFt(s.distFt) : '', hw + 18, 270);
    g.textAlign = 'right'; g.fillStyle = '#9fb3c1'; g.font = `700 24px ${FONT}`; g.fillText(s.clock || '', W - 18, 270);
  }

  // ------------------------------------------------------------------------------------------ runtime: designs
  const designs = Object.create(null);
  function getDesign(key) {
    if (designs[key]) return designs[key];
    const [kind, t] = key.split(':'); let d;
    if (kind === 'emu') d = emuDesign(t.replace('+P', ''), t.endsWith('+P'));
    else d = dslDesign(t);
    d.key = key; return (designs[key] = d);
  }
  const lodGeo = (d, lvl) => {
    const k = 'lod' + lvl; if (!d[k]) d[k] = d.kind === 'emu' ? emuLod(d, lvl) : dslLod(d, lvl); return d[k];
  };
  const _wheelGeos = {}, wheelGeo = r => _wheelGeos[r] || (_wheelGeos[r] = wheelsetGeo(r));
  const _leafGeos = {};
  function leafGeos(d) {
    const k = d.leafKey || 'emu';
    if (!_leafGeos[k]) _leafGeos[k] = d.kind === 'emu'
      ? { o: doorLeafGeo(E.DOORW / 2, E.DOORTOP - E.YL, [-0.2, 0.2, 0.78, 1.62]), g: doorGlassGeo([-0.2, 0.2, 0.78, 1.62]) }
      : { o: doorLeafGeo(d.leafW, d.leafH, d.leafWin, 'body'), g: doorGlassGeo(d.leafWin) };
    return _leafGeos[k];
  }
  const BIKE_TINTS = ['#c4122f', '#2b6f8f', '#e2b01c', '#2a2d33', '#e9e9e6', '#4d7a3a', '#d8662a', '#6b4c9a'];
  function flipMeta(d) {
    const g = d.gangways, fg = w => w ? { x: -w.x, z0: -w.z1, z1: -w.z0, y: w.y } : null;
    return {
      bogieOffsets: [-d.bogieOffsets[1], -d.bogieOffsets[0]],
      floorRegions: d.floorRegions.map(r => ({ name: r.name, x0: -r.x1, x1: -r.x0, z0: -r.z1, z1: -r.z0, y: r.y })),
      ramps: d.ramps.map(r => ({ x0: -r.x1, x1: -r.x0, z0: -r.z1, z1: -r.z0, y0: r.y1, y1: r.y0 })),
      gangways: { front: fg(g.rear), rear: fg(g.front) },
      seats: d.seats.map(s => ({ x: -s.x, y: s.y, z: -s.z, yaw: U.wrapAngle(s.yaw + Math.PI) })),
      doors: d.doors.map(o => ({ x: -o.x, side: -o.side, width: o.width, sillY: o.sillY })),
      cabEye: d.cabEye ? [-d.cabEye[0], d.cabEye[1], -d.cabEye[2]] : null,
    };
  }
  const copyMeta = d => ({
    bogieOffsets: d.bogieOffsets.slice(), floorRegions: d.floorRegions.map(r => ({ ...r })), ramps: d.ramps.map(r => ({ ...r })),
    gangways: { front: d.gangways.front ? { ...d.gangways.front } : null, rear: d.gangways.rear ? { ...d.gangways.rear } : null },
    seats: d.seats.map(s => ({ ...s })), doors: d.doors.map(o => ({ ...o })), cabEye: d.cabEye ? d.cabEye.slice() : null,
  });

  // ------------------------------------------------------------------------------------------ runtime: Car
  const _im = new THREE.Matrix4(), _iq = new THREE.Quaternion(), _ip = new V3(), _is = new V3(1, 1, 1), _ie = new THREE.Euler(), _Z = new V3(0, 0, 1);
  class Car {
    constructor(consist, index, d, flip, number, flags) {
      this.consist = consist; this.index = index; this.design = d; this.flip = flip; this.number = number;
      this.type = d.type; this.length = d.length; this.width = d.width; this.height = d.height;
      Object.assign(this, flip ? flipMeta(d) : copyMeta(d));
      this.group = new THREE.Group(); this.group.name = 'car' + index + ':' + d.key;
      this.group.rotation.order = 'YZX';
      const root = this.root = flip ? new THREE.Group() : this.group;
      if (flip) { root.rotation.y = Math.PI; this.group.add(root); }
      const mat = this.mat = palMaterial();
      this.ext = new THREE.Mesh(d.ext, mat); this.ext.name = 'body';
      this.glass = new THREE.Mesh(d.glass, consist.glassExt); this.glass.name = 'glass';
      this.decals = new THREE.Mesh(d.kind === 'emu' ? emuDecals(d, number, flags || {}) : dslDecals(d, number, flags || {}), atlasMat()); this.decals.name = 'decals';
      this.signs = d.signs.attributes.position.count ? new THREE.Mesh(d.signs, consist.signMat) : null;
      this.wheels = new THREE.InstancedMesh(wheelGeo(d.wheelR), mat, d.axles.length); this.wheels.name = 'wheels';
      const lg = d.leaves.length ? leafGeos(d) : null;
      this.doorsO = lg ? new THREE.InstancedMesh(lg.o, mat, d.leaves.length) : null;
      this.doorsG = lg ? new THREE.InstancedMesh(lg.g, consist.glassExt, d.leaves.length) : null;
      this.panto = null;
      if (d.pantoX != null) { this.panto = new THREE.Mesh(pantoGeo(0), mat); this.panto.position.set(d.pantoX, E.TOP + PANTO_HINGE, 0); this.pantoT = -1; }
      this.lod0 = [this.ext, this.glass, this.decals, this.wheels];
      for (const o of [this.signs, this.doorsO, this.doorsG, this.panto]) if (o) this.lod0.push(o);
      for (const o of this.lod0) root.add(o);
      this.lod1 = new THREE.Mesh(lodGeo(d, 1), mat); this.lod2 = new THREE.Mesh(lodGeo(d, 2), mat);
      this.lod1.visible = this.lod2.visible = false; root.add(this.lod1, this.lod2);
      this.glow = null;
      if (d.glow) {
        const pts = [...d.glow.head, ...d.glow.tail], g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
        g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pts.length * 3), 3));
        this.glow = new THREE.Points(g, glowMat()); this.glow.frustumCulled = false; this.glow.renderOrder = 2; root.add(this.glow);
        this.nHead = d.glow.head.length;
      }
      this.lod = 0; this.int = null; this.intVisible = false; this.wheelAng = 0; this.handle = null;
      this._updateWheels(); this._updateDoors([0, 0]);
      this.wheels.computeBoundingSphere(); this.wheels.boundingSphere.radius += 1;
      if (this.doorsO) { this.doorsO.computeBoundingSphere(); this.doorsO.boundingSphere.radius += 1.5; this.doorsG.boundingSphere = this.doorsO.boundingSphere; }
    }
    _updateWheels() {
      const d = this.design, a = this.wheelAng;
      _iq.setFromAxisAngle(_Z, a);
      for (let i = 0; i < d.axles.length; i++) { _im.compose(_ip.set(d.axles[i], d.wheelR, 0), _iq, _is); this.wheels.setMatrixAt(i, _im); }
      this.wheels.instanceMatrix.needsUpdate = true;
    }
    _updateDoors(dt) {
      if (!this.doorsO) return;
      const d = this.design, lw = d.leafW;
      for (let i = 0; i < d.leaves.length; i++) {
        const l = d.leaves[i], cs = this.flip ? -l.s : l.s, t = dt[cs > 0 ? 1 : 0];
        const out = smooth(0, 0.2, t) * 0.055, slide = smooth(0.15, 1, t) * (lw + 0.02);
        _iq.setFromAxisAngle(_Y, l.s > 0 ? 0 : Math.PI);
        _im.compose(_ip.set(l.dc + l.k * (lw / 2 + slide), d.leafY != null ? d.leafY : d.sillY, l.s * (d.bodyW + 0.004 + out)), _iq, _is);
        this.doorsO.setMatrixAt(i, _im); this.doorsG.setMatrixAt(i, _im);
      }
      this.doorsO.instanceMatrix.needsUpdate = true; this.doorsG.instanceMatrix.needsUpdate = true;
    }
    setPantograph(t) {
      if (!this.panto) return; const k = Math.round(clamp(t, 0, 1) * 20); if (k === this.pantoT) return;
      this.pantoT = k; this.panto.geometry = pantoGeo(k / 20);
    }
    buildInterior() {
      if (this.int) return this.int;
      const d = this.design, I = d.kind === 'emu' ? emuInterior(d) : dslInterior(d), c = this.consist, g = new THREE.Group();
      g.name = 'interior';
      g.add(new THREE.Mesh(I.furn, this.mat));
      if (I.seatCount) {
        I.seatAttr = I.seatAttr || new THREE.InstancedBufferAttribute(I.seatMatrices, 16);
        const m = new THREE.InstancedMesh(I.seatGeo || seatGeo(), this.mat, I.seatCount); m.instanceMatrix = I.seatAttr; m.computeBoundingSphere(); g.add(m);
      }
      if (I.bikeCount) {
        I.bikeAttr = I.bikeAttr || new THREE.InstancedBufferAttribute(I.bikeMatrices, 16);
        if (!I.bikeColor) { const a = new Float32Array(I.bikeCount * 3), col = new THREE.Color(), r = U.rng(7);
          for (let i = 0; i < I.bikeCount; i++) { col.set(BIKE_TINTS[Math.floor(r() * BIKE_TINTS.length)]); a.set([col.r, col.g, col.b], i * 3); } I.bikeColor = new THREE.InstancedBufferAttribute(a, 3); }
        const m = new THREE.InstancedMesh(bikeGeo(), this.mat, I.bikeCount); m.instanceMatrix = I.bikeAttr; m.instanceColor = I.bikeColor; m.computeBoundingSphere(); g.add(m);
      }
      if (I.glass.attributes.position.count) { const m = new THREE.Mesh(I.glass, c.glassIn); m.renderOrder = 1; g.add(m); }
      if (I.pis.attributes.position.count) g.add(new THREE.Mesh(I.pis, c._pisMaterial()));
      if (I.cab.attributes.position.count) g.add(new THREE.Mesh(I.cab, c._cabMaterial()));
      if (I.handle) { this.handle = new THREE.Mesh(I.handleGeo, this.mat); this.handle.position.set(...I.handle.pivot); g.add(this.handle); c._applyCabHandle(); }
      this.root.add(g); g.visible = false;
      return (this.int = g);
    }
    setInteriorVisible(v) {
      v = !!v; if (v === this.intVisible) return;
      if (v && !this.int) this.buildInterior();
      this.intVisible = v;
      if (this.int) this.int.visible = v && this.lod === 0;
      const gm = v ? this.consist.glassIn : this.consist.glassExt;
      this.glass.material = gm; if (this.doorsG) this.doorsG.material = gm;
      this.glass.renderOrder = v ? 1 : 0;
    }
    setLOD(level) {
      level = level | 0; if (level === this.lod) return; this.lod = level;
      for (const o of this.lod0) o.visible = level === 0;
      this.lod1.visible = level === 1; this.lod2.visible = level === 2;
      if (this.int) this.int.visible = this.intVisible && level === 0;
    }
  }

  // ------------------------------------------------------------------------------------------ runtime: Consist
  const EMU_SET = [['emu:cab', false], ['emu:bike+P', false], ['emu:coach', false], ['emu:wc', false], ['emu:coach', false, { quiet: true }], ['emu:bike+P', true], ['emu:cab', true]];
  const DSL_SET = [['dsl:loco', false], ['dsl:coach', false], ['dsl:coach', false], ['dsl:coach', false], ['dsl:coach', false], ['dsl:cab', true]];
  class Consist {
    constructor(kind, opts = {}) {
      if (kind !== 'emu' && kind !== 'diesel') throw new Error('TrainKit: unknown consist kind ' + kind);
      this.kind = kind; this.name = opts.name || ''; this.seed = (opts.seed >>> 0) || 0; this.speed = 0;
      this.night = 0; this.lights = { head: 1, tail: 1, interior: 1, cab: 1 }; this.lead = 'front';
      this.doorT = [0, 0]; this.doorGoal = [0, 0]; this.panto = 0; this.dest = ''; this._disp = null; this._cab = null; this._cabDrawn = 0;
      this.glassExt = new THREE.MeshStandardMaterial({ color: 0x1a2329, roughness: 0.07, metalness: 0.55, emissive: 0xffc88c, emissiveMap: windowCard(), emissiveIntensity: 0 });
      this.glassIn = new THREE.MeshStandardMaterial({ color: 0x2a3942, roughness: 0.04, metalness: 0.35, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false });
      this.signTex = U.canvasTexture(512, 128, g => { g.fillStyle = '#050403'; g.fillRect(0, 0, 512, 128); });
      this.signMat = new THREE.MeshBasicMaterial({ map: this.signTex, toneMapped: false });
      this.pisTex = null; this.pisMat = null; this.cabTex = null; this.cabMat = null;
      const set = kind === 'emu' ? EMU_SET : DSL_SET, s = this.seed;
      const nums = kind === 'emu' ? set.map((c, i) => 'BL ' + (301 + (s % 40) * 7 + i))
        : set.map((c, i) => i === 0 ? 'BL ' + (920 + (s % 8)) : i === set.length - 1 ? 'BL ' + (601 + (s % 30)) : 'BL ' + (401 + (s % 30) * 5 + i));
      this.cars = set.map(([key, flip, flags], i) => new Car(this, i, getDesign(key), flip, nums[i], flags));
      let off = 0; for (const c of this.cars) { c.offset = off + c.length / 2; off += c.length; }
      this.length = off;
      this.setDestination(kind === 'emu' ? 'BAYLINE' : 'SOUTH COUNTY');
      this._applyLights();
    }
    setLeadEnd(lead) { this.lead = lead === 'rear' ? 'rear' : 'front'; this._applyLights(); }
    setLights(o = {}) {
      for (const k of ['head', 'tail', 'interior', 'cab']) if (o[k] !== undefined) this.lights[k] = clamp(+o[k] || 0, 0, 1);
      if (o.lead) this.lead = o.lead === 'rear' ? 'rear' : 'front';
      this._applyLights();
    }
    setNight(n) { n = clamp(+n || 0, 0, 1); if (Math.abs(n - this.night) < 1e-3) return; this.night = n; this._applyLights(); }
    _applyLights() {
      const n = this.night, L = this.lights, cars = this.cars, first = cars[0], last = cars[cars.length - 1];
      const leadCar = this.lead === 'rear' ? last : first, trailCar = this.lead === 'rear' ? first : last;
      for (const c of cars) {
        const lv = c.mat.userData.lv, isLead = c === leadCar, isTrail = c === trailCar;
        lv.set(L.interior * (1.1 + 2.4 * n), isLead ? L.head * (2.4 + 4 * n) : 0, isTrail ? L.tail * (1.8 + 3 * n) : 0, L.interior * (0.1 + 0.9 * n));
        c.mat.userData.win.value = L.interior * n * 1.3;
        if (c.glow) {
          const col = c.glow.geometry.attributes.color, a = col.array, hs = isLead ? L.head * (0.35 + 0.65 * n) : 0, ts = isTrail ? L.tail * (0.25 + 0.75 * n) : 0;
          for (let i = 0; i < col.count; i++) { if (i < c.nHead) a.set([hs, hs * 0.96, hs * 0.86], i * 3); else a.set([ts, ts * 0.08, ts * 0.06], i * 3); }
          col.needsUpdate = true; c.glow.visible = hs + ts > 0.01;
        }
      }
      this.glassExt.emissiveIntensity = L.interior * n * 1.35;
      this.signMat.color.setScalar(0.75 + 0.25 * (1 - n * 0.3));
      if (this.cabMat) this.cabMat.color.setScalar(0.35 + 0.65 * L.cab);
    }
    setDestination(text) {
      text = String(text == null ? '' : text).toUpperCase(); if (text === this.dest) return; this.dest = text;
      const g = this.signTex.userData.ctx;
      drawLed(g, text, 0, 0, 512, 64, 128, 16, '#ffae1a');
      const num = this.cars[0].number.replace('BL ', '');
      drawLed(g, this.kind === 'diesel' ? num : text, 0, 64, 512, 64, 96, 16, this.kind === 'diesel' ? '#fff6e0' : '#ffae1a');
      this.signTex.needsUpdate = true;
    }
    setDoors(side, t) {
      t = clamp(+t || 0, 0, 1);
      if (side === 'none') { this.doorGoal[0] = this.doorGoal[1] = 0; return; }
      if (side === 'left' || side === 'both') this.doorGoal[0] = t;
      if (side === 'right' || side === 'both') this.doorGoal[1] = t;
    }
    setPantograph(t) { this.panto = clamp(+t || 0, 0, 1); for (const c of this.cars) c.setPantograph(this.panto); }
    _pisMaterial() {
      if (!this.pisMat) { this.pisTex = U.canvasTexture(512, 256, g => drawPis(g, 512, 256, this._disp || { route: 'Local', nextStop: '', destination: '', clock: '' })); this.pisMat = new THREE.MeshBasicMaterial({ map: this.pisTex, toneMapped: false }); this.pisMat.color.setScalar(0.85); }
      return this.pisMat;
    }
    _cabMaterial() {
      if (!this.cabMat) { this.cabTex = U.canvasTexture(1024, 320, g => drawCab(g, 1024, 320, this._cab || {})); this.cabMat = new THREE.MeshBasicMaterial({ map: this.cabTex, toneMapped: false }); this._applyLights(); }
      return this.cabMat;
    }
    setDisplay(o = {}) {
      const s = { route: o.route || '', nextStop: o.nextStop || '', destination: o.destination || '', clock: o.clock || '' };
      const k = s.route + '|' + s.nextStop + '|' + s.destination + '|' + s.clock; if (k === this._dispKey) return;
      this._dispKey = k; this._disp = s;
      if (this.pisTex) { drawPis(this.pisTex.userData.ctx, 512, 256, s); this.pisTex.needsUpdate = true; }
    }
    setCab(o = {}) {
      this._cab = Object.assign(this._cab || {}, o);
      this._applyCabHandle();
      if (!this.cabTex) return;
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const s = this._cab, k = [Math.round(Math.abs(s.speedMph || 0)), Math.round(s.limitMph || 0), Math.round((s.throttle || 0) * 20), Math.round((s.brake || 0) * 20), s.signal, s.nextStop, Math.round((s.distFt || 0) / 10), s.clock, s.ptc].join('|');
      if (k === this._cabKey || now - this._cabDrawn < 110) return;
      this._cabKey = k; this._cabDrawn = now; drawCab(this.cabTex.userData.ctx, 1024, 320, s); this.cabTex.needsUpdate = true;
    }
    _applyCabHandle() {
      const s = this._cab || {}, a = -((s.throttle || 0) - (s.brake || 0)) * 0.6;
      for (const c of this.cars) if (c.handle) c.handle.rotation.z = a;
    }
    setInteriorVisible(v) { for (const c of this.cars) c.setInteriorVisible(v); }
    setLOD(level) { for (const c of this.cars) c.setLOD(level); }
    update(dt) {
      dt = Math.min(Math.max(dt || 0, 0), 0.1);
      if (this.speed !== 0) for (const c of this.cars) {
        c.wheelAng = (c.wheelAng + (c.flip ? 1 : -1) * this.speed * dt / c.design.wheelR) % (Math.PI * 2);
        if (c.lod === 0) c._updateWheels();
      }
      const T = this.doorT, Gl = this.doorGoal; let moved = false;
      for (let k = 0; k < 2; k++) if (T[k] !== Gl[k]) { const st = dt / 2.4; T[k] = Math.abs(Gl[k] - T[k]) <= st ? Gl[k] : T[k] + Math.sign(Gl[k] - T[k]) * st; moved = true; }
      if (moved) for (const c of this.cars) c._updateDoors(T);
    }
  }

  function createConsist(kind, opts) { return new Consist(kind, opts); }
  // Optional helper: pose a car group from its front/rear bogie pivot points (world, top of rail), roll in radians.
  function poseCar(car, f, r, roll = 0) {
    const dx = f.x - r.x, dy = f.y - r.y, dz = f.z - r.z, h = Math.hypot(dx, dz) || 1e-9, len = Math.hypot(h, dy);
    const yaw = Math.atan2(-dz, dx), pitch = Math.atan2(dy, h), xm = (car.bogieOffsets[0] + car.bogieOffsets[1]) / 2;
    car.group.rotation.set(roll, yaw, pitch, 'YZX');
    car.group.position.set((f.x + r.x) / 2 - dx / len * xm, (f.y + r.y) / 2 - dy / len * xm, (f.z + r.z) / 2 - dz / len * xm);
  }
  return { createConsist, poseCar, PANTO_UP_Y: PANTO_UP, designs };
})();
