// ACGeo: the geometry kit of the procedural aircraft (48_acframe / 48_acparts / 48_accockpit build with it,
// 48_acmodel assembles). A mesh builder with explicit normals, two UV sets (the part's own texture, and metres for
// the tiling panel-line detail) and a skin binding per vertex, so every part of an aircraft can be merged into one
// skinned mesh per material and still move (the bones are the moving parts). Parametric surfaces take their
// normals from the surface's own derivatives (finite differences), so there are no seams where two patches or the
// two halves of a fuselage meet. Plus airfoils, lathes, tubes, boxes, convex-polygon clipping (window openings)
// and the rig: bones whose matrices are computed relative to the aircraft (precise far from the world origin).
//   const mb = new ACGeo.MB(); mb.bind(bone); mb.pal = [u, v]; mb.push(matrix) ... mb.pop(); mb.mirror = true
//   mb.surface(us, vs, (u, v, out) => out.set(...), { uv, eu, ev, flip }); mb.lathe(profile, seg, opt)
//   const B = new ACGeo.Batch(); B.mb('body') ...; B.meshes(materials, rig, sphere) -> [SkinnedMesh]
//   const rig = new ACGeo.Rig(); const b = rig.add(parent, x, y, z); rig.bone(b).quaternion...; rig.update()
// Model axes: x forward, y up, z right; origin = the centre of gravity. Everything here is renderer-agnostic
// (standard attributes and SkinnedMesh only: no custom shaders).
const ACGeo = (() => {
  const V3 = THREE.Vector3;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sgnpow = (v, p) => (v < 0 ? -Math.pow(-v, p) : Math.pow(v, p));

  // ---------------------------------------------------------------- mesh builder
  class MB {
    constructor() {
      this.P = []; this.N = []; this.T = []; this.T1 = []; this.K = []; this.I = [];
      this.b0 = 0; this.skin = null; this.pal = null; this.mirror = false; this.flip = false;
      this.stack = []; this.M = null; this.NM = null; this._sk = [0, 0, 0];
    }
    get count() { return this.P.length / 3; }
    bind(bone) { this.b0 = bone; this.skin = null; return this; }
    // transform stack: positions by the matrix, normals by its normal matrix
    push(m) {
      this.stack.push([this.M, this.NM]);
      const cur = this.M ? new THREE.Matrix4().fromArray(this.M).multiply(m) : m.clone();
      this.M = cur.elements.slice(); this.NM = new THREE.Matrix3().getNormalMatrix(cur).elements.slice(); return this;
    }
    pop() { [this.M, this.NM] = this.stack.pop(); return this; }
    at(m, fn) { this.push(m); fn(this); this.pop(); return this; }
    v(x, y, z, nx, ny, nz, u = 0, v = 0, u1 = 0, v1 = 0) {
      const M = this.M;
      if (M) {
        const X = M[0] * x + M[4] * y + M[8] * z + M[12], Y = M[1] * x + M[5] * y + M[9] * z + M[13], Z = M[2] * x + M[6] * y + M[10] * z + M[14];
        const N = this.NM, a = N[0] * nx + N[3] * ny + N[6] * nz, b = N[1] * nx + N[4] * ny + N[7] * nz, c = N[2] * nx + N[5] * ny + N[8] * nz, l = Math.hypot(a, b, c) || 1;
        x = X; y = Y; z = Z; nx = a / l; ny = b / l; nz = c / l;
      }
      if (this.mirror) { z = -z; nz = -nz; }
      this.P.push(x, y, z); this.N.push(nx, ny, nz);
      if (this.pal) this.T.push(this.pal[0], this.pal[1]); else this.T.push(u, v);
      this.T1.push(u1, v1);
      if (this.skin) { this.skin(x, y, z, this._sk); this.K.push(this._sk[0], this._sk[1], this._sk[2]); } else this.K.push(this.b0, this.b0, 0);
      return this.P.length / 3 - 1;
    }
    tri(a, b, c) { if (this.mirror !== this.flip) this.I.push(a, c, b); else this.I.push(a, b, c); return this; }
    quad(a, b, c, d) { return this.tri(a, b, c).tri(a, c, d); }
    // a parametric surface over the parameter lists us x vs: P(u, v, out) sets the point; the normal is
    // dP/du x dP/dv (central differences), so neighbouring patches that share an edge also share its normals
    surface(us, vs, P, o = {}) {
      const p = new V3(), a = new V3(), b = new V3(), du = new V3(), dv = new V3(), n = new V3();
      const eu = o.eu || 1e-4, ev = o.ev || 1e-4, nv = vs.length, base = this.count, flip = !!o.flip;
      for (let i = 0; i < us.length; i++) for (let j = 0; j < nv; j++) {
        const u = us[i], v = vs[j];
        P(u, v, p);
        P(u + eu, v, a); P(u - eu, v, b); du.subVectors(a, b);
        P(u, v + ev, a); P(u, v - ev, b); dv.subVectors(a, b);
        n.crossVectors(du, dv);
        if (n.lengthSq() < 1e-24) {         // a pole (a nose tip, a cone's apex): look a little way along u
          const k = u + (i + 1 < us.length ? 1 : -1) * eu * 40; P(k, v + ev, a); P(k, v - ev, b); dv.subVectors(a, b); P(k + eu, v, a); P(k - eu, v, b); du.subVectors(a, b); n.crossVectors(du, dv);
          if (n.lengthSq() < 1e-24 && o.pole) n.copy(o.pole);
        }
        n.normalize(); if (flip) n.negate();
        if (o.uv) { const t = o.uv(u, v, i, j, p); this.v(p.x, p.y, p.z, n.x, n.y, n.z, t[0], t[1], t[2] || 0, t[3] || 0); }
        else this.v(p.x, p.y, p.z, n.x, n.y, n.z, u, v);
      }
      const f0 = this.flip; if (flip) this.flip = !this.flip;
      for (let i = 0; i + 1 < us.length; i++) for (let j = 0; j + 1 < nv; j++) {
        if (o.skip && o.skip((us[i] + us[i + 1]) / 2, (vs[j] + vs[j + 1]) / 2)) continue;       // (a hole: o.skip(u, v) at the quad's centre)
        const q = base + i * nv + j; this.quad(q, q + nv, q + nv + 1, q + 1);
      }
      this.flip = f0; return this;
    }
    // surface of revolution about x: prof [[x, r], ...] from front to back (outward normals; o.flip for inside
    // surfaces); a point repeated = a crease. o.range = [i0, i1] builds only those profile points, with normals from
    // the whole profile (so neighbouring pieces in other materials meet smoothly); o.a0 / o.a1 limit the sweep
    // (phi from +y toward +z); o.mod(k, phi) scales the radius and o.xmod(k, phi) shifts x (k = profile parameter);
    // o.uv(k, phi, arc) -> [u, v, u1, v1] (default: around, along, and metres)
    lathe(prof, seg, o = {}) {
      const runs = []; let run = [0];
      for (let i = 1; i < prof.length; i++) { const q = prof[i], p = prof[i - 1]; if (q[0] === p[0] && q[1] === p[1]) { runs.push(run); run = [i]; } else run.push(i); }
      runs.push(run);
      const a0 = o.a0 || 0, a1 = o.a1 === undefined ? Math.PI * 2 : o.a1, [i0, i1] = o.range || [0, prof.length - 1];
      let len = 0; const cum = [0]; for (let i = 1; i < prof.length; i++) { len += Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]); cum.push(len); }
      for (const r of runs) {
        if (r.length < 2) continue;
        const idx = r.filter(i => i >= i0 && i <= i1); if (idx.length < 2) continue;
        const pts = r.map(i => prof[i]), k0 = r[0];
        const at = (t) => { const i = clamp(Math.floor(t), 0, pts.length - 2), f = t - i; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]; };
        const arcAt = (t) => { const i = clamp(Math.floor(t), 0, pts.length - 2), f = t - i; return cum[k0 + i] + (cum[k0 + i + 1] - cum[k0 + i]) * f; };
        const us = idx.map(i => i - k0), vs = []; for (let k = 0; k <= seg; k++) vs.push(a0 + (a1 - a0) * k / seg);
        this.surface(us, vs, (t, ph, out) => {
          const [x, rr] = at(t), m = o.mod ? o.mod(t + k0, ph) : 1, dx = o.xmod ? o.xmod(t + k0, ph) : 0;
          out.set(x + dx, Math.cos(ph) * rr * m, Math.sin(ph) * rr * m);
        }, { eu: 1e-4, ev: 1e-4, flip: !!o.flip, pole: new V3(pts[0][0] > pts[pts.length - 1][0] ? 1 : -1, 0, 0),
          uv: (t, ph, i, j, p) => { const s = arcAt(t); if (o.uv) return o.uv(t + k0, ph, s, p); const rr = at(t)[1]; return [(ph - a0) / (a1 - a0), s / Math.max(len, 1e-6), s, ph * rr]; } });
      }
      return this;
    }
    // a cylinder / cone from a to b (radii ra, rb) with optional end caps
    cyl(a, b, ra, rb, seg, caps = true) {
      const d = new V3().subVectors(b, a), L = d.length(); if (L < 1e-6) return this;
      const m = new THREE.Matrix4().compose(a, new THREE.Quaternion().setFromUnitVectors(new V3(1, 0, 0), d.divideScalar(L)), new V3(1, 1, 1));
      const prof = caps ? [[L, 0], [L, rb], [L, rb], [0, ra], [0, ra], [0, 0]] : [[L, rb], [0, ra]];   // (front to back: outward normals)
      return this.at(m, () => this.lathe(prof, seg));
    }
    // an axis-aligned box (in the current transform), per-face UVs
    box(cx, cy, cz, sx, sy, sz) {
      const h = [sx / 2, sy / 2, sz / 2];
      // (normal, u axis, v axis) with u x v = normal: counter-clockwise from outside
      const F = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
        [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]]];
      for (const [n, a, b] of F) {
        const c = [cx + n[0] * h[0], cy + n[1] * h[1], cz + n[2] * h[2]];
        const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => this.v(c[0] + (a[0] * i + b[0] * j) * h[0], c[1] + (a[1] * i + b[1] * j) * h[1], c[2] + (a[2] * i + b[2] * j) * h[2], n[0], n[1], n[2], (i + 1) / 2, (j + 1) / 2));
        this.quad(q[0], q[1], q[2], q[3]);
      }
      return this;
    }
    // a rounded box: a superellipsoid (e = 2 an ellipsoid; 4-8 a cushion with soft edges), n segments around
    rbox(cx, cy, cz, sx, sy, sz, e = 5, n = 12) {
      const pe = 2 / e, sp = (v) => Math.sign(v) * Math.pow(Math.abs(v), pe), hx = sx / 2, hy = sy / 2, hz = sz / 2;
      const us = [], vs = []; for (let i = 0; i <= n; i++) us.push(-Math.PI / 2 + Math.PI * i / n); for (let j = 0; j <= 2 * n; j++) vs.push(Math.PI * 2 * j / (2 * n));
      return this.surface(us, vs, (u, v, out) => out.set(cx + hx * sp(Math.cos(u)) * sp(Math.cos(v)), cy + hy * sp(Math.sin(u)), cz + hz * sp(Math.cos(u)) * sp(Math.sin(v))), { eu: 1e-4, ev: 1e-4, flip: true, pole: new V3(0, 1, 0) });
    }
    // a flat polygon (convex or star-shaped around its first point) given in 3D, one normal
    poly(pts, n) { const i0 = pts.map(p => this.v(p.x, p.y, p.z, n.x, n.y, n.z)); for (let i = 1; i + 1 < i0.length; i++) this.tri(i0[0], i0[i], i0[i + 1]); return this; }
    geometry() {
      const n = this.count, g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.T, 2));
      g.setAttribute('uv1', new THREE.Float32BufferAttribute(this.T1, 2));
      const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), K = this.K;
      for (let i = 0; i < n; i++) { si[i * 4] = K[i * 3]; si[i * 4 + 1] = K[i * 3 + 1]; sw[i * 4] = 1 - K[i * 3 + 2]; sw[i * 4 + 1] = K[i * 3 + 2]; }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
      return g;
    }
    // a plain (unskinned) geometry with vertex colours from a palette lookup, for merged traffic models
    colored(colorOf) {
      const n = this.count, g = new THREE.BufferGeometry(), col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const c = colorOf(this.T[i * 2], this.T[i * 2 + 1], i); col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; }
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.T, 2)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
      return g;
    }
  }

  // ---------------------------------------------------------------- the rig: bones relative to the aircraft
  // Bones carry the moving parts. Their rest pose is a pure translation (the pivot point in model space); every
  // frame rig.update() composes each bone's local transform (its position, quaternion and scale, set by the
  // animation) with its parent's, in double precision, relative to the aircraft root, and writes the skinning
  // matrices (current x rest inverse) straight into the skeleton. three.js would otherwise compute them in world
  // space, where float32 steps are ~1.6 cm at 150 km from the origin and the whole aircraft would shimmer.
  class Rig {
    constructor() { this.bones = []; this.parent = []; this.rest = []; this.rel = []; this.skeleton = null; this.add(-1, 0, 0, 0); }
    add(parent, x, y, z) {
      const b = new THREE.Bone(), i = this.bones.length, rp = parent >= 0 ? this.rest[parent] : [0, 0, 0];
      b.position.set(x - rp[0], y - rp[1], z - rp[2]); b.userData.rest = b.position.clone();
      this.bones.push(b); this.parent.push(parent); this.rest.push([x, y, z]); this.rel.push(new THREE.Matrix4());
      return i;
    }
    bone(i) { return this.bones[i]; }
    // the rest point of a bone, and a point carried by it in the current pose (model space)
    restOf(i) { const r = this.rest[i]; return new V3(r[0], r[1], r[2]); }
    build() {
      const inv = this.rest.map(r => new THREE.Matrix4().makeTranslation(-r[0], -r[1], -r[2]));
      const sk = new THREE.Skeleton(this.bones, inv), rig = this;
      sk.update = function () { if (this.boneTexture !== null) this.boneTexture.needsUpdate = true; };   // (matrices come from rig.update)
      this.skeleton = sk; this.update(); return sk;
    }
    update() {
      const B = this.bones, R = this.rel, sk = this.skeleton, out = sk.boneMatrices, m = Rig._m;
      for (let i = 0; i < B.length; i++) {
        const b = B[i]; b.matrix.compose(b.position, b.quaternion, b.scale);
        const p = this.parent[i];
        if (p >= 0) R[i].multiplyMatrices(R[p], b.matrix); else R[i].copy(b.matrix);
        const r = this.rest[i]; m.copy(R[i]).multiply(Rig._t.makeTranslation(-r[0], -r[1], -r[2]));
        m.toArray(out, i * 16);
      }
      if (sk.boneTexture) sk.boneTexture.needsUpdate = true;
    }
    // a point attached to bone i (given in rest model space), in the current pose
    apply(i, p, out) { const r = this.rest[i]; return out.set(p.x - r[0], p.y - r[1], p.z - r[2]).applyMatrix4(this.rel[i]); }
  }
  Rig._m = new THREE.Matrix4(); Rig._t = new THREE.Matrix4();

  // ---------------------------------------------------------------- batches: one skinned mesh per material
  class Batch {
    constructor() { this.parts = {}; }
    mb(key) { return this.parts[key] || (this.parts[key] = new MB()); }
    meshes(mats, rig, sphere, opt = {}) {
      const out = [], I = new THREE.Matrix4();
      for (const key of Object.keys(this.parts)) {
        const mb = this.parts[key]; if (!mb.count || !mats[key]) continue;
        const me = new THREE.SkinnedMesh(mb.geometry(), mats[key]);
        me.bind(rig.skeleton, I); me.bindMode = 'detached'; me.name = key;
        me.boundingSphere = sphere.clone(); me.geometry.boundingSphere = sphere.clone();   // (three.js would skin every vertex on the CPU)
        me.castShadow = !(opt.noShadow || []).includes(key); me.receiveShadow = true;
        out.push(me);
      }
      return out;
    }
    get vertices() { let n = 0; for (const k in this.parts) n += this.parts[k].count; return n; }
  }

  // ---------------------------------------------------------------- airfoils
  // NACA 4-digit thickness (closed trailing edge) and a camber line (aft-loaded for 'sc', the supercritical-like
  // sections of the jets). The loop parameter q runs 0 (upper TE) -> 0.5 (LE) -> 1 (lower TE); x = (1 + cos 2 pi q) / 2
  // is cosine-spaced and the section is smooth through the leading edge.
  const yt = (x, t) => 5 * t * (0.2969 * Math.sqrt(Math.max(x, 0)) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
  function camber(x, m, style) {
    if (!m) return 0;
    if (style === 'sc') return m * 3.2 * x * (1 - x) * (0.25 + 1.15 * x) / 1.05;     // flat top, aft loading
    const p = 0.4; return x < p ? m / (p * p) * (2 * p * x - x * x) : m / ((1 - p) ** 2) * ((1 - 2 * p) + 2 * p * x - x * x);
  }
  // point on the section loop: [x, y] in chords
  function foil(q, t, m, style) {
    const x = (1 + Math.cos(2 * Math.PI * q)) / 2, up = q < 0.5 ? 1 : -1;
    return [x, camber(x, m, style) + up * yt(x, t)];
  }
  // q for a chord fraction on the upper (side 1) or lower (side -1) surface
  const qAt = (x, side) => { const a = Math.acos(clamp(2 * x - 1, -1, 1)) / (2 * Math.PI); return side > 0 ? a : 1 - a; };
  // cosine-spaced list of q between two loop positions (inclusive), n segments
  function qList(qa, qb, n) { const o = []; for (let i = 0; i <= n; i++) o.push(qa + (qb - qa) * i / n); return o; }

  // ---------------------------------------------------------------- convex polygon clipping (2D)
  // keep the part of poly on the left of a -> b (keep > 0) or on its right (keep < 0)
  function clipHalf(poly, ax, ay, bx, by, keep) {
    const out = [], n = poly.length, side = (p) => keep * ((bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax));
    for (let i = 0; i < n; i++) {
      const p = poly[i], q = poly[(i + 1) % n], sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
    return out;
  }
  const area2 = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return a; };
  // poly (convex) inside the convex polygon C (counter-clockwise)
  function clipIn(poly, C) { let o = poly; for (let i = 0; i < C.length && o.length; i++) { const a = C[i], b = C[(i + 1) % C.length]; o = clipHalf(o, a[0], a[1], b[0], b[1], 1); } return o.length > 2 ? o : null; }
  // poly (convex) minus the convex polygon C: up to C.length convex pieces
  function clipOut(poly, C) {
    const pieces = []; let rest = poly;
    for (let i = 0; i < C.length && rest.length > 2; i++) {
      const a = C[i], b = C[(i + 1) % C.length];
      const outside = clipHalf(rest, a[0], a[1], b[0], b[1], -1);
      if (outside.length > 2 && Math.abs(area2(outside)) > 1e-12) pieces.push(outside);
      rest = clipHalf(rest, a[0], a[1], b[0], b[1], 1);
    }
    return pieces;
  }
  const ccw = (C) => (area2(C) < 0 ? C.slice().reverse() : C);
  // a polygon grown or shrunk by d along its edge normals (convex, counter-clockwise)
  function offsetPoly(C, d) {
    const n = C.length, L = [];
    for (let i = 0; i < n; i++) { const a = C[i], b = C[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; L.push([a[0] + dy / l * d, a[1] - dx / l * d, dx / l, dy / l]); }
    const out = [];
    for (let i = 0; i < n; i++) {
      const A = L[(i + n - 1) % n], B = L[i], den = A[2] * B[3] - A[3] * B[2];
      if (Math.abs(den) < 1e-9) { out.push([B[0], B[1]]); continue; }
      const t = ((B[0] - A[0]) * B[3] - (B[1] - A[1]) * B[2]) / den; out.push([A[0] + A[2] * t, A[1] + A[3] * t]);
    }
    return out;
  }

  // ---------------------------------------------------------------- splines
  // monotone cubic (Fritsch-Carlson) through [[x, y], ...]: smooth, no overshoot; clamps outside the range
  function mono(pts) {
    const n = pts.length, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), d = [], m = [];
    for (let i = 0; i + 1 < n; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    m.push(d[0]); for (let i = 1; i + 1 < n; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : 3 * (d[i - 1] + d[i]) / ((2 * d[i] + d[i - 1]) / d[i - 1] + (d[i] + 2 * d[i - 1]) / d[i])); m.push(d[n - 2]);
    return (x) => {
      if (x <= xs[0]) return ys[0]; if (x >= xs[n - 1]) return ys[n - 1];
      let i = 0; while (i + 2 < n && x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }
  // n + 1 values from a to b, denser toward both ends (cosine) or toward a (k > 1)
  const cosSpace = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + (b - a) * (1 - Math.cos(Math.PI * i / n)) / 2);
  const linSpace = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + (b - a) * i / n);
  // merge sorted breakpoints into a parameter list with at most 'step' between samples
  function stations(breaks, step) {
    const b = [...new Set(breaks.map(v => +v.toFixed(5)))].sort((p, q) => p - q), out = [];
    for (let i = 0; i + 1 < b.length; i++) { const n = Math.max(1, Math.ceil((b[i + 1] - b[i]) / step - 1e-6)); for (let k = 0; k < n; k++) out.push(b[i] + (b[i + 1] - b[i]) * k / n); }
    out.push(b[b.length - 1]); return out;
  }

  return { MB, Rig, Batch, foil, camber, yt, qAt, qList, clipHalf, clipIn, clipOut, ccw, offsetPoly, area2, mono, cosSpace, linSpace, stations, clamp, sgnpow };
})();
