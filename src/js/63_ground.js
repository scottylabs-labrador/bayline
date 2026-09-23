// GroundCover: grass tufts around a low camera, only where the aerial photograph shows lawn or field (green or
// golden California grass), coloured by that photo, never on streets (rasterized from Towns.roadsNear). One instanced
// draw call; placement, grassiness and colour are resolved in the vertex shader from the terrain's own imagery
// textures, so tufts appear exactly where the ground photo is grassy and fade out before anyone can see an edge.
const GroundCover = (() => {
  const R = 34, CELL = 0.42;                          // reach (m) and grid spacing
  const N = Math.ceil(R * 2 / CELL);                  // cells per side
  const MAX = Math.floor(Math.PI * (R / CELL) * (R / CELL)) + 64;
  const group = new THREE.Group(); group.name = 'groundcover';
  let mesh = null, aPos = null, ready = false;
  const anchor = new THREE.Vector3(); let lastX = 1e9, lastZ = 1e9;
  const slots = [0, 1, 2, 3].map(() => ({ tex: null, x0: 0, z0: 0, size: 0 }));
  const uni = {
    uImg0: { value: null }, uImg1: { value: null }, uImg2: { value: null }, uImg3: { value: null },
    uImgR: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uTexel: { value: new THREE.Vector4(1, 1, 1, 1) },
    uCam: { value: new THREE.Vector3() }, uFade: { value: 1 }, uTime: U.uTime, uWind: U.uWind, uAnchor: { value: new THREE.Vector3() },
  };
  const hash = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

  function tuftGeometry() {
    // three crossed, slightly bent blade cards; uv.y = 0 at the root, 1 at the tips
    const pos = [], uv = [], idx = [];
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI / 3 + 0.2, c = Math.cos(a), s = Math.sin(a), w = 0.52;
      const b = pos.length / 3;
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const x = (u - 0.5) * w, y = v * 0.46, bend = v * v * 0.08;
        pos.push(x * c + bend * s, y, x * s - bend * c); uv.push(u, v);
      }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    return g;
  }
  function bladeTexture() {
    return U.canvasTexture(256, 256, (c, w, h) => {
      c.clearRect(0, 0, w, h); const r = U.rng(9);
      for (let i = 0; i < 70; i++) {
        const x = 8 + r() * (w - 16), ht = h * (0.4 + r() * 0.6), lean = (r() - 0.5) * 46, bw = 5 + r() * 7;
        const g = c.createLinearGradient(0, h, 0, h - ht); const t = 0.75 + r() * 0.25;
        g.addColorStop(0, `rgba(${Math.round(120 * t)},${Math.round(125 * t)},${Math.round(95 * t)},1)`); g.addColorStop(1, `rgba(${Math.round(245 * t)},${Math.round(240 * t)},${Math.round(215 * t)},1)`);
        c.fillStyle = g; c.beginPath(); c.moveTo(x - bw, h); c.quadraticCurveTo(x + lean * 0.4, h - ht * 0.6, x + lean, h - ht); c.quadraticCurveTo(x + lean * 0.4 + 1, h - ht * 0.6, x + bw, h); c.fill();
      }
    }, { srgb: true });
  }
  function makeMaterial() {
    const tex = bladeTexture(); tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.anisotropy = 4;
    const m = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.92, metalness: 0, envMapIntensity: 0.4 });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uni);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aTuft;                                   // x, y, z (anchor-relative), random
          uniform sampler2D uImg0; uniform sampler2D uImg1; uniform sampler2D uImg2; uniform sampler2D uImg3;
          uniform vec4 uImgR[4]; uniform vec4 uTexel; uniform vec3 uCam; uniform float uFade; uniform float uTime; uniform float uWind; uniform vec3 uAnchor;
          varying vec3 vTuftCol; varying float vTuftAO;
          vec3 gcPhoto(vec2 w, out float ok) {
            ok = 0.0; vec3 c = vec3(0.0);
            for (int i = 0; i < 4; i++) {
              vec2 uv = (w - uImgR[i].xy) / uImgR[i].z;
              if (uImgR[i].z > 0.0 && uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) {
                float lod = clamp(log2(3.0 / uTexel[i]), 0.0, 10.0);
                c = i == 0 ? textureLod(uImg0, uv, lod).rgb : i == 1 ? textureLod(uImg1, uv, lod).rgb : i == 2 ? textureLod(uImg2, uv, lod).rgb : textureLod(uImg3, uv, lod).rgb;
                ok = 1.0; break;
              }
            }
            return c;
          }`)
        .replace('#include <beginnormal_vertex>', `
          vec3 objectNormal = vec3(0.0, 1.0, 0.0);               // soft, sky-facing lighting for blades`)
        .replace('#include <begin_vertex>', `
          vec3 wBase = aTuft.xyz + uAnchor;
          float ok; vec3 lin = gcPhoto(wBase.xz, ok);             // linear (sRGB textures decode on sampling)
          vec3 ph = pow(max(lin, vec3(0.0)), vec3(1.0 / 2.2));    // perceptual values for classification
          float lum = dot(ph, vec3(0.299, 0.587, 0.114));
          float sat = (max(ph.r, max(ph.g, ph.b)) - min(ph.r, min(ph.g, ph.b))) / max(lum, 0.03);
          // lawns (green, incl. dry September lawns that read grey-green) and golden summer grass; not grey paving/roofs
          float greenish = smoothstep(-0.03, 0.02, ph.g - max(ph.r * 0.95, ph.b * 0.99)) * smoothstep(0.04, 0.1, sat);
          float golden = smoothstep(0.08, 0.2, sat) * step(ph.b * 1.08, ph.g) * smoothstep(0.64, 0.46, lum);
          float grassy = ok * max(greenish, golden * 0.9) * smoothstep(0.08, 0.15, lum) * (1.0 - smoothstep(0.58, 0.7, lum));
          float d = distance(wBase.xz, uCam.xz);
          float fade = smoothstep(${R.toFixed(1)}, ${(R * 0.62).toFixed(1)}, d) * uFade;
          // tufts shrink toward the edge of a grassy patch instead of stopping at a hard, sawtooth boundary
          float sc = smoothstep(0.38, 0.62, grassy + (fract(aTuft.w * 5.1) - 0.5) * 0.1) * fade * (0.7 + 0.6 * fract(aTuft.w * 7.3));
          float ang = aTuft.w * 6.2832;
          vec3 p = position; p.xz = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p.xz;
          float lawn = greenish * (1.0 - golden) * smoothstep(0.1, 0.25, sat);   // vivid, irrigated green = mowed lawn
          p *= vec3(sc * mix(1.0, 0.8, lawn), sc * (0.75 + 0.5 * fract(aTuft.w * 3.1)) * mix(1.0, 1.35, golden) * mix(1.0, 0.36, lawn), sc * mix(1.0, 0.8, lawn));
          float sway = uv.y * uv.y * (0.05 + 0.12 * uWind) * sin(uTime * (1.6 + uWind) + dot(wBase.xz, vec2(0.37, 0.21)) + aTuft.w * 4.0);
          p.x += sway; p.z += sway * 0.6;
          vec3 transformed = p + aTuft.xyz;
          vTuftCol = mix(lin, lin * vec3(1.08, 1.03, 0.82), golden) * (0.85 + 0.3 * fract(aTuft.w * 13.7));
          vTuftAO = mix(0.45, 1.0, uv.y);`)
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTuftCol; varying float vTuftAO;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          diffuseColor.rgb = vTuftCol * 2.6 * diffuseColor.rgb * vTuftAO;`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          normal = normalize(vNormal);                          // both faces lit like the ground (no flipped, dark backs)`);
    };
    m.customProgramCacheKey = () => 'bayline-groundcover-v1';
    return m;
  }

  function init() {
    const geo = tuftGeometry();
    aPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4); aPos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTuft', aPos);
    mesh = new THREE.InstancedMesh(geo, makeMaterial(), MAX); mesh.count = 0; mesh.frustumCulled = false;
    mesh.castShadow = false; mesh.receiveShadow = true; mesh.name = 'groundcover';
    const I = new THREE.Matrix4(); for (let i = 0; i < MAX; i++) mesh.setMatrixAt(i, I);   // identity: positions come from aTuft
    group.add(mesh); Env.scene.add(group); ready = true;
  }

  // roads within reach -> occupancy grid (1 m) so no grass pokes through streets and sidewalks
  const OG = Math.ceil(R * 2) + 4; const occ = new Uint8Array(OG * OG);
  function rasterRoads(cx, cz) {
    occ.fill(0); if (typeof Towns === 'undefined' || !Towns.roadsNear) return;
    let roads; try { roads = Towns.roadsNear(cx, cz, R + 30); } catch (e) { return; }
    const ox = cx - OG / 2, oz = cz - OG / 2;
    for (const rd of roads) {
      const P = rd.pts, half = (rd.width || (rd.lanes || 2) * 3.4) / 2 + 2.6;          // + sidewalk
      for (let i = 0; i + 5 < P.length; i += 3) {
        const x0 = P[i], z0 = P[i + 2], x1 = P[i + 3], z1 = P[i + 5];
        const L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(L / 0.8));
        for (let k = 0; k <= n; k++) {
          const t = k / n, x = x0 + (x1 - x0) * t - ox, z = z0 + (z1 - z0) * t - oz; const hr = Math.ceil(half);
          if (x < -hr || z < -hr || x > OG + hr || z > OG + hr) continue;
          for (let dz = -hr; dz <= hr; dz++) for (let dx = -hr; dx <= hr; dx++) {
            if (dx * dx + dz * dz > half * half) continue; const gx = Math.floor(x + dx), gz = Math.floor(z + dz);
            if (gx >= 0 && gz >= 0 && gx < OG && gz < OG) occ[gz * OG + gx] = 1;
          }
        }
      }
    }
  }
  // coarse height lattice (2 m) so each tuft sits on the ground without thousands of Terrain.h calls
  const HL = Math.ceil(R * 2 / 2) + 3; const hl = new Float32Array(HL * HL);
  function rebuild(cx, cz) {
    const gx0 = Math.floor((cx - R) / CELL), gz0 = Math.floor((cz - R) / CELL);
    anchor.set(Math.round(cx), 0, Math.round(cz)); group.position.copy(anchor); uni.uAnchor.value.copy(anchor);
    const hx0 = cx - R - 2, hz0 = cz - R - 2;
    for (let j = 0; j < HL; j++) for (let i = 0; i < HL; i++) hl[j * HL + i] = Terrain.h(hx0 + i * 2, hz0 + j * 2);
    rasterRoads(cx, cz); const ox = cx - OG / 2, oz = cz - OG / 2;
    const A = aPos.array; let n = 0; const R2 = R * R;
    for (let j = 0; j < N && n < MAX; j++) for (let i = 0; i < N && n < MAX; i++) {
      const gx = gx0 + i, gz = gz0 + j;
      const x = (gx + hash(gx, gz)) * CELL, z = (gz + hash(gz * 3 + 1, gx * 5 + 7)) * CELL;
      const dx = x - cx, dz = z - cz; if (dx * dx + dz * dz > R2) continue;
      const ocx = Math.floor(x - ox), ocz = Math.floor(z - oz); if (ocx >= 0 && ocz >= 0 && ocx < OG && ocz < OG && occ[ocz * OG + ocx]) continue;
      const fx = (x - hx0) / 2, fz = (z - hz0) / 2, ix = Math.min(HL - 2, Math.max(0, fx | 0)), iz = Math.min(HL - 2, Math.max(0, fz | 0)), tx = fx - ix, tz = fz - iz;
      const y = hl[iz * HL + ix] * (1 - tx) * (1 - tz) + hl[iz * HL + ix + 1] * tx * (1 - tz) + hl[(iz + 1) * HL + ix] * (1 - tx) * tz + hl[(iz + 1) * HL + ix + 1] * tx * tz;
      A[n * 4] = x - anchor.x; A[n * 4 + 1] = y - 0.03; A[n * 4 + 2] = z - anchor.z; A[n * 4 + 3] = hash(gx * 11 + 3, gz * 13 + 5); n++;
    }
    mesh.count = n; aPos.needsUpdate = true;
  }
  function bindImagery(cx, cz) {
    // up to four distinct imagery tiles around the camera (the terrain's finest), retained while in use
    const seen = []; const pts = [[0, 0], [-R, -R], [R, -R], [-R, R], [R, R], [0, -R], [0, R], [-R, 0], [R, 0]];
    for (const [dx, dz] of pts) { let im; try { im = Terrain.imagery(cx + dx, cz + dz); } catch (e) { im = null; } if (im && im.tex && !seen.some(s => s.tex === im.tex) && seen.length < 4) seen.push(im); }
    for (let i = 0; i < 4; i++) {
      const im = seen[i] || null, sl = slots[i];
      if ((im && im.tex) !== sl.tex) { if (sl.tex && Terrain.release) Terrain.release(sl.tex); if (im && Terrain.retain) Terrain.retain(im.tex); }
      sl.tex = im ? im.tex : null;
      uni['uImg' + i].value = im ? im.tex : null;
      uni.uImgR.value[i].set(im ? im.x0 : 0, im ? im.z0 : 0, im ? im.size : 0, 0);
      uni.uTexel.value.setComponent(i, im ? (im.texel || im.size / 512) : 1);
    }
    // an unbound sampler must still point at a valid texture
    for (let i = 0; i < 4; i++) if (!uni['uImg' + i].value) uni['uImg' + i].value = seen[0] ? seen[0].tex : null;
    return seen.length;
  }
  let lastBind = 0, lastRoadGen = -1;
  function update(camPos) {
    if (!ready) return;
    const alt = camPos.y - Terrain.h(camPos.x, camPos.z);
    const f = 1 - U.smooth(18, 34, alt); uni.uFade.value = f; uni.uCam.value.copy(camPos);
    mesh.visible = f > 0.01 && Terrain.tiled; if (!mesh.visible) return;
    const now = performance.now();
    // rebuild after moving, or when new road data streamed in (a teleport lands before the streets do, and grass
    // must never grow through them)
    const roadGen = typeof Towns !== 'undefined' && Towns.stats ? Towns.stats.roadGen : 0;
    if (Math.hypot(camPos.x - lastX, camPos.z - lastZ) > 5 || (roadGen !== lastRoadGen && now - lastBind > 400)) {
      lastX = camPos.x; lastZ = camPos.z; lastRoadGen = roadGen;
      if (!bindImagery(camPos.x, camPos.z)) { mesh.visible = false; return; }
      rebuild(camPos.x, camPos.z); lastBind = now;
    } else if (now - lastBind > 1500) { lastBind = now; bindImagery(camPos.x, camPos.z); }   // finer imagery may have streamed in
    if (!uni.uImg0.value) mesh.visible = false;
  }
  return { init, update, group, get count() { return mesh ? mesh.count : 0; } };
})();
