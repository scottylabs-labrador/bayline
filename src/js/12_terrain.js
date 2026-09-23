// Terrain: 64 m heightmap (1600², baked from AWS Terrain Tiles, carved along the railway) + land masks,
// rendered as ONE instanced draw: a camera-centred quadtree of 32×32-quad chunks with skirts.
const Terrain = (() => {
  let N = 0, S = 64, X0 = 0, Z0 = 0, heights = null, mask = null;
  const G = 32;                       // quads per chunk side
  const ROOT = 131072;                // quadtree root size (m)
  const LEAF = 256;                   // smallest chunk (8 m vertex spacing)
  const MAXI = 1400;
  let mesh = null, texH = null, texM = null, material = null;
  const uniforms = {
    tH: { value: null }, tM: { value: null }, terr: { value: new THREE.Vector4() }, camXZ: { value: new THREE.Vector2() },
    townFade: { value: new THREE.Vector4(0, 0, 0, 0) }, night: U.uNight, time: U.uTime,
  };

  async function load(onProgress) {
    const u8 = await Data.bin('terrain');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    N = dv.getUint32(4, true); S = dv.getFloat32(8, true); X0 = dv.getFloat32(12, true); Z0 = dv.getFloat32(16, true);
    const sc = dv.getFloat32(20, true), off = dv.getFloat32(24, true);
    const lo = u8.subarray(28, 28 + N * N), hi = u8.subarray(28 + N * N, 28 + 2 * N * N);
    mask = u8.slice(28 + 2 * N * N, 28 + 2 * N * N + N * N * 4);
    heights = new Float32Array(N * N); const q = new Int32Array(N * N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i; const zz = lo[k] | (hi[k] << 8); const r = (zz >>> 1) ^ -(zz & 1);
        let a, b, c;
        if (j === 0 && i === 0) { q[k] = r; continue; }
        if (j === 0) { a = q[k - 1]; b = a; c = a; }
        else if (i === 0) { b = q[k - N]; a = b; c = b; }
        else { a = q[k - 1]; b = q[k - N]; c = q[k - N - 1]; }
        const mx = a > b ? a : b, mn = a < b ? a : b;
        q[k] = r + (c >= mx ? mn : (c <= mn ? mx : a + b - c));
      }
      if ((j & 127) === 0 && onProgress) onProgress(j / N);
    }
    for (let k = 0; k < N * N; k++) heights[k] = q[k] * sc + off;
    build();
  }

  // bilinear height at world (x,z)
  function h(x, z) {
    if (!heights) return 0;
    let fx = (x - X0) / S, fz = (z - Z0) / S;
    fx = fx < 0 ? 0 : fx > N - 1.001 ? N - 1.001 : fx; fz = fz < 0 ? 0 : fz > N - 1.001 ? N - 1.001 : fz;
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * N + i;
    return heights[k] * (1 - tx) * (1 - tz) + heights[k + 1] * tx * (1 - tz) + heights[k + N] * (1 - tx) * tz + heights[k + N + 1] * tx * tz;
  }
  function maskAt(x, z, ch) { // 0..1 nearest
    if (!mask) return 0; const i = U.clamp(Math.round((x - X0) / S), 0, N - 1), j = U.clamp(Math.round((z - Z0) / S), 0, N - 1);
    return mask[(j * N + i) * 4 + ch] / 255;
  }
  const isWater = (x, z) => maskAt(x, z, 0) > 0.5;
  const urbanAt = (x, z) => maskAt(x, z, 1);

  function build() {
    // height texture (half float, linear filtered everywhere)
    const hf = new Uint16Array(N * N); for (let k = 0; k < N * N; k++) hf[k] = THREE.DataUtils.toHalfFloat(heights[k]);
    texH = new THREE.DataTexture(hf, N, N, THREE.RedFormat, THREE.HalfFloatType);
    texH.minFilter = texH.magFilter = THREE.LinearFilter; texH.wrapS = texH.wrapT = THREE.ClampToEdgeWrapping; texH.needsUpdate = true;
    texM = new THREE.DataTexture(mask, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    texM.minFilter = texM.magFilter = THREE.LinearFilter; texM.needsUpdate = true;
    uniforms.tH.value = texH; uniforms.tM.value = texM; uniforms.terr.value.set(X0, Z0, (N - 1) * S, N);

    // chunk geometry: (G+1)² grid in [-0.5,0.5] plus a skirt ring (position.y = 1 flags skirt)
    const pos = [], idx = []; const V = G + 1;
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) pos.push(i / G - 0.5, 0, j / G - 0.5);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { const a = j * V + i, b = a + 1, c = a + V, d = c + 1; idx.push(a, c, b, b, c, d); }
    const ring = []; for (let i = 0; i < G; i++) ring.push(i); for (let j = 0; j < G; j++) ring.push(j * V + G);
    for (let i = G; i > 0; i--) ring.push(G * V + i); for (let j = G; j > 0; j--) ring.push(j * V);
    const base = pos.length / 3;
    for (const r of ring) pos.push(pos[r * 3], 1, pos[r * 3 + 2]);
    for (let k = 0; k < ring.length; k++) { const a = ring[k], b = ring[(k + 1) % ring.length], a2 = base + k, b2 = base + (k + 1) % ring.length; idx.push(a, b, a2, b, b2, a2); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0, envMapIntensity: 0.55 });
    material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tH; uniform vec4 terr; varying vec3 vW; varying vec2 vUV;
          vec2 tuv(vec2 w){ return (w - terr.xy) / terr.z * ((terr.w - 1.0) / terr.w) + 0.5 / terr.w; }`)
        .replace('#include <beginnormal_vertex>', `
          vec4 wq = instanceMatrix * vec4(position.x, 0.0, position.z, 1.0);
          vec2 uvq = tuv(wq.xz); float hq = texture2D(tH, uvq).r;
          float sclq = length(instanceMatrix[0].xyz);
          vec3 objectNormal = vec3(0.0, 1.0, 0.0);`)
        .replace('#include <begin_vertex>', `
          vec3 transformed = vec3(position.x, (hq - position.y * (4.0 + sclq * 0.012)) / sclq, position.z);
          vW = vec3(wq.x, hq, wq.z); vUV = uvq;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tH; uniform sampler2D tM; uniform vec4 terr; uniform vec2 camXZ; uniform vec4 townFade; uniform float night; uniform float time;
          varying vec3 vW; varying vec2 vUV;
          float hsh(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
          float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(hsh(i), hsh(i+vec2(1,0)), f.x), mix(hsh(i+vec2(0,1)), hsh(i+vec2(1,1)), f.x), f.y); }
          float fbm(vec2 p){ float a = 0.0, m = 0.5; for (int i = 0; i < 4; i++){ a += m * vn(p); p = p * 2.03 + 17.1; m *= 0.5; } return a; }
          vec3 terrN(vec2 uv){ float e = 1.0 / terr.w; float s2 = terr.z / (terr.w - 1.0) * 2.0;
            float l = texture2D(tH, uv - vec2(e,0)).r, r = texture2D(tH, uv + vec2(e,0)).r, d = texture2D(tH, uv - vec2(0,e)).r, u = texture2D(tH, uv + vec2(0,e)).r;
            return normalize(vec3(l - r, s2, d - u)); }
          vec3 gTerrN; float gWater; float gRough; vec3 gEmis;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            vec4 m = texture2D(tM, vUV);
            vec3 nW = terrN(vUV);
            vec2 p = vW.xz; float hgt = vW.y;
            float dcam = length(p - camXZ);
            // micro relief for close-up hills (bump only in shading)
            float det = smoothstep(2500.0, 300.0, dcam) * (1.0 - m.g) * (1.0 - m.r);
            if (det > 0.0) { float e = 3.0; float a = fbm(p * 0.06), b = fbm((p + vec2(e, 0.0)) * 0.06), c = fbm((p + vec2(0.0, e)) * 0.06);
              nW = normalize(nW + vec3(a - b, 0.0, a - c) * 2.2 * det); }
            float slope = 1.0 - nW.y;
            float n1 = fbm(p * 0.0011), n2 = vn(p * 0.013), n3 = vn(p * 0.09), n4 = hsh(floor(p * 0.5));
            // --- wild land: golden grass, oak woodland, chaparral, redwoods ---
            vec3 grassA = vec3(0.72, 0.58, 0.31), grassB = vec3(0.80, 0.68, 0.42), grassC = vec3(0.58, 0.52, 0.30);
            vec3 col = mix(grassA, grassB, smoothstep(0.3, 0.8, n1));
            col = mix(col, grassC, smoothstep(0.55, 0.9, n2) * 0.5);
            float northF = clamp(-nW.z * 2.2 + 0.25, 0.0, 1.0);
            float wood = smoothstep(0.52, 0.72, n1 * 0.55 + northF * 0.45 + slope * 0.9 + n2 * 0.25 - 0.15);
            vec3 oak = mix(vec3(0.20, 0.25, 0.12), vec3(0.30, 0.33, 0.16), n3);
            float speck = smoothstep(0.62, 0.9, vn(p * 0.35)) * smoothstep(0.35, 0.75, n1 + northF * 0.3);
            col = mix(col, oak, max(wood, speck * 0.8));
            float redw = smoothstep(180.0, 420.0, hgt) * smoothstep(-8000.0, -22000.0, p.x + p.y * 0.35) * smoothstep(0.35, 0.6, n1 + northF * 0.4);
            col = mix(col, mix(vec3(0.11, 0.17, 0.10), vec3(0.16, 0.22, 0.12), n3), redw);
            float chap = smoothstep(0.18, 0.35, slope) * (1.0 - northF) * 0.6;
            col = mix(col, vec3(0.42, 0.40, 0.25), chap);
            col = mix(col, vec3(0.56, 0.50, 0.42), smoothstep(0.55, 0.85, slope));   // rock on cliffs
            // --- farmland (South County) ---
            float farm = clamp(m.a * 2.0, 0.0, 1.0) * step(m.a, 0.51);
            if (farm > 0.01) {
              float ang = 0.62; mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)); vec2 fp = R * p;
              vec2 fc = floor(fp / vec2(260.0, 170.0)); float fh = hsh(fc);
              vec3 fcol = fh < 0.3 ? vec3(0.42, 0.52, 0.22) : fh < 0.55 ? vec3(0.62, 0.58, 0.34) : fh < 0.75 ? vec3(0.50, 0.40, 0.26) : vec3(0.33, 0.45, 0.20);
              float rows = 0.9 + 0.1 * sin(fp.x * (1.0 + fh * 2.0));
              vec2 ff = fract(fp / vec2(260.0, 170.0)); float edge = smoothstep(0.0, 0.02, ff.x) * smoothstep(0.0, 0.03, ff.y);
              col = mix(col, fcol * rows * mix(0.8, 1.0, edge), farm);
            }
            // --- urban fabric (far view; near the camera the real streets/buildings take over) ---
            float urb = m.g;
            float nearTown = smoothstep(townFade.y, townFade.x, dcam) * townFade.z;
            vec3 lights = vec3(0.0);
            if (urb > 0.02) {
              float ang = floor(vn(p * 0.00025) * 4.0) * 0.39; mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
              vec2 cp = R * p; vec2 cell = cp / vec2(118.0, 86.0); vec2 cf = fract(cell); vec2 ci = floor(cell);
              float st = 1.0 - smoothstep(0.035, 0.06, min(min(cf.x, 1.0 - cf.x), min(cf.y, 1.0 - cf.y)) );
              float lot = hsh(ci); vec2 lc = cell * vec2(4.0, 2.0); vec2 sub = fract(lc); float lh = hsh(floor(lc));
              float bld = step(0.16 + lh * 0.12, sub.x) * step(0.18 + lh * 0.1, sub.y) * step(0.14, 1.0 - sub.x) * step(0.16, 1.0 - sub.y);
              vec3 roof = lh < 0.28 ? vec3(0.60, 0.36, 0.27) : lh < 0.5 ? vec3(0.56, 0.55, 0.53) : lh < 0.7 ? vec3(0.72, 0.66, 0.56) : lh < 0.85 ? vec3(0.80, 0.79, 0.76) : vec3(0.38, 0.36, 0.35);
              roof *= 0.9 + 0.15 * hsh(floor(lc) + 3.1);
              vec3 yard = mix(vec3(0.30, 0.37, 0.19), vec3(0.42, 0.43, 0.27), n3);
              vec3 city = mix(yard, roof, bld * (0.55 + 0.4 * urb));
              city = mix(city, vec3(0.27, 0.27, 0.28), st);
              float tree = smoothstep(0.5, 0.78, vn(p * 0.07) * 0.8 + vn(p * 0.23) * 0.3) * 0.85; city = mix(city, mix(vec3(0.15, 0.22, 0.11), vec3(0.22, 0.28, 0.14), n3), tree * (1.0 - st * 0.8) * (1.0 - bld * 0.5));
              float farU = smoothstep(2200.0, 7000.0, dcam);   // average out sub-pixel lots in the distance (no shimmer)
              vec3 avgCity = mix(vec3(0.40, 0.40, 0.33), vec3(0.47, 0.44, 0.38), n1) * (0.92 + 0.12 * vn(p * 0.002));
              city = mix(city, avgCity, farU);
              vec3 near = mix(vec3(0.42, 0.44, 0.30), vec3(0.50, 0.49, 0.44), n3);    // under real towns: lawn/pavement mix
              city = mix(city, near, nearTown);
              col = mix(col, city, smoothstep(0.1, 0.45, urb));
              // night lights along streets
              float lp = smoothstep(0.93, 1.0, hsh(floor(cp / 22.0))) * st * (1.0 - nearTown);
              float glow = st * 0.07 * (1.0 - nearTown);
              lights = vec3(1.0, 0.72, 0.38) * (lp * 2.2 + glow) * night * smoothstep(0.2, 0.6, urb) * (0.7 + 0.3 * sin(time * 0.7 + lot * 30.0));
            }
            // --- baylands: marsh, salt ponds, beaches ---
            float marsh = step(0.7, m.a);
            col = mix(col, mix(vec3(0.34, 0.40, 0.22), vec3(0.45, 0.43, 0.28), n2), marsh * 0.9);
            float pond = m.b;
            vec3 pcol = vec3(0.0);
            if (pond > 0.01) {
              float ph = hsh(floor(p / 900.0));
              pcol = ph < 0.25 ? vec3(0.60, 0.40, 0.36) : ph < 0.45 ? vec3(0.66, 0.56, 0.38) : ph < 0.65 ? vec3(0.42, 0.52, 0.42) : ph < 0.8 ? vec3(0.54, 0.38, 0.33) : vec3(0.38, 0.47, 0.49);
              pcol *= 0.9 + 0.12 * vn(p * 0.01);
              col = mix(col, pcol, smoothstep(0.3, 0.7, pond));
            }
            float shore = smoothstep(0.08, 0.3, m.r) * (1.0 - smoothstep(0.35, 0.55, m.r)) * step(hgt, 4.0);
            col = mix(col, vec3(0.78, 0.72, 0.58), shore * 0.7);
            // --- water ---
            gWater = smoothstep(0.42, 0.58, m.r);
            float depth = clamp(-hgt, 0.0, 12.0);
            vec3 wcol = mix(vec3(0.20, 0.36, 0.38), vec3(0.08, 0.20, 0.27), smoothstep(0.0, 8.0, depth));
            wcol = mix(wcol, vec3(0.30, 0.34, 0.26), smoothstep(0.55, 0.45, m.r) * 0.5);
            col = mix(col, wcol, gWater);
            diffuseColor.rgb = col;
            gRough = mix(0.96, 0.06, gWater);
            // water wave normal
            if (gWater > 0.0) {
              vec2 wp = p * 0.08 + vec2(time * 0.35, time * 0.21);
              float wa = vn(wp), wb = vn(wp + vec2(0.35, 0.0)), wc = vn(wp + vec2(0.0, 0.35));
              vec2 wp2 = p * 0.021 - vec2(time * 0.12, -time * 0.08);
              float xa = vn(wp2), xb = vn(wp2 + vec2(0.4, 0.0)), xc = vn(wp2 + vec2(0.0, 0.4));
              float wf = smoothstep(4500.0, 600.0, dcam);
              vec3 wn = normalize(vec3(((wa - wb) * 0.5 * wf + (xa - xb) * 0.35 * (0.3 + 0.7 * wf)), 1.0, ((wa - wc) * 0.5 * wf + (xa - xc) * 0.35 * (0.3 + 0.7 * wf))));
              nW = normalize(mix(nW, wn, gWater));
            }
            gTerrN = nW; gEmis = lights;
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = gRough;`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(gTerrN, 0.0)).xyz);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += gEmis;`);
    };
    mesh = new THREE.InstancedMesh(geo, material, MAXI);
    mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false; mesh.count = 0;
    mesh.name = 'terrain';
    Env.scene.add(mesh);
  }

  // ---------- quadtree selection ----------
  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), box = new THREE.Box3(), mtx = new THREE.Matrix4();
  const lodFactor = { value: 2.3 };
  let lastKey = '';
  function update(cam) {
    if (!mesh) return;
    uniforms.camXZ.value.set(cam.position.x, cam.position.z);
    pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); frustum.setFromProjectionMatrix(pm);
    const cx = X0 + (N - 1) * S / 2, cz = Z0 + (N - 1) * S / 2;
    const cp = cam.position; let n = 0;
    const alt = Math.max(0, cp.y - h(cp.x, cp.z));
    const stack = [[cx, cz, ROOT]];
    while (stack.length) {
      const [x, z, size] = stack.pop();
      const half = size / 2;
      box.min.set(x - half, -40, z - half); box.max.set(x + half, 1400, z + half);
      if (!frustum.intersectsBox(box)) continue;
      const dx = Math.max(Math.abs(cp.x - x) - half, 0), dz = Math.max(Math.abs(cp.z - z) - half, 0);
      const d = Math.sqrt(dx * dx + dz * dz + alt * alt * 0.6);
      if (size > LEAF && d < size * lodFactor.value) {
        const q = size / 4; stack.push([x - q, z - q, size / 2], [x + q, z - q, size / 2], [x - q, z + q, size / 2], [x + q, z + q, size / 2]);
      } else if (n < MAXI) {
        mtx.makeScale(size, size, size); mtx.setPosition(x, 0, z); mesh.setMatrixAt(n++, mtx);
      }
    }
    mesh.count = n; mesh.instanceMatrix.needsUpdate = true;
  }
  function setTownFade(nearRadius, farRadius, strength) { uniforms.townFade.value.set(nearRadius, farRadius, strength, 0); }
  return { load, h, isWater, urbanAt, maskAt, update, setTownFade, get mesh() { return mesh; }, get info() { return { N, S, X0, Z0 }; }, lodFactor };
})();
