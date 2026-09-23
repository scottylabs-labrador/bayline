// Render pipeline (atmosphere agent). Scene -> HDR (half-float, MSAA) target with a resolved (logarithmic) depth
// texture -> SSAO (half res, bilateral) -> marine-layer raymarch (half res) -> composite (AO, cloud shadows, aerial
// perspective, cloud deck, cirrus, fog) -> bloom mip chain -> ACES + grading + vignette + grain -> screen (+FXAA on low).
//   Post.render(dt)                         call instead of renderer.render(scene, camera)
//   Post.setQuality('high'|'medium'|'low')  Post.quality
//   Post.enabled = false                    plain renderer.render (with the renderer's own ACES tone mapping)
//   Post.stats                              { calls, triangles } of the last frame (all passes)
const Post = (() => {
  const R = Env.renderer, scene = Env.scene, camera = Env.camera;
  const QUALITY = {
    high:   { samples: 4, ao: 12, fogSteps: 16, fogScale: 0.5, bloom: 6, fxaa: false, shadow: 4096, grain: 0.016 },
    medium: { samples: 2, ao: 8,  fogSteps: 12, fogScale: 0.5, bloom: 5, fxaa: false, shadow: 2048, grain: 0.012 },
    low:    { samples: 0, ao: 0,  fogSteps: 8,  fogScale: 0.25, bloom: 4, fxaa: true, shadow: 2048, grain: 0.0 },
  };
  let quality = 'high', Q = QUALITY.high, enabled = true, W = 0, H = 0, frame = 0;
  const stats = { calls: 0, triangles: 0 };
  const debug = { ao: true, fog: true, bloom: true, clouds: true, msaa: true };   // per-pass switches (profiling)
  const sz = new THREE.Vector2();

  // ---------------------------------------------------------------- full-screen plumbing
  const fsGeo = new THREE.BufferGeometry(); fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const fsScene = new THREE.Scene(), fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(fsGeo); quad.frustumCulled = false; fsScene.add(quad);
  const VS = `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  function pass(mat, target) { quad.material = mat; R.setRenderTarget(target); R.render(fsScene, fsCam); }
  function mk(uniforms, frag, defines) { return new THREE.ShaderMaterial({ uniforms, vertexShader: VS, fragmentShader: frag, depthTest: false, depthWrite: false, toneMapped: false, defines: defines || {} }); }

  // camera-ray helpers shared by the passes (logarithmic depth: d = log2(1 + w) / log2(far + 1))
  const cam = {
    uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
    uLogC: { value: 1 }, uTexel: { value: new THREE.Vector2() }, uFocal: { value: 1 }, uTanHalf: { value: new THREE.Vector2(1, 1) },
  };
  const CAMGLSL = /* glsl */`
    uniform mat4 uProjInv, uCamWorld; uniform vec3 uCamPos; uniform float uLogC, uFocal; uniform vec2 uTexel, uTanHalf;
    float depthW(float d) { return exp2(d * uLogC) - 1.0; }
    vec3 viewRay(vec2 uv) { return vec3((uv * 2.0 - 1.0) * uTanHalf, -1.0); }      // symmetric perspective, z = -1
    vec3 viewPosAt(vec2 uv, float d) { return viewRay(uv) * depthW(d); }
    float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
    // the picture bends the world down by K d² (see BEND_GLSL): a level surface at height H is, along a camera ray,
    // the parabola ro.y + rd.y t + K |rd.xz|² t² = H. Returns the ray interval [tA, tB] below that surface
    // (tA < 0 < tB when the camera is below it; tA > tB when the ray never gets below it)
    vec2 blLevelHits(float roy, vec3 rd, float H) {
      float A = 7.848061e-8 * dot(rd.xz, rd.xz), b = rd.y, c = roy - H;
      if (A < 1e-16) { if (abs(b) < 1e-7) return c < 0.0 ? vec2(-1e9, 1e9) : vec2(1e9, -1e9); float t = -c / b; return b > 0.0 ? vec2(-1e9, t) : vec2(t, 1e9); }
      float disc = b * b - 4.0 * A * c;
      if (disc < 0.0) return vec2(1e9, -1e9);
      float q = -0.5 * (b + (b >= 0.0 ? 1.0 : -1.0) * sqrt(disc));
      float r1 = q / A, r2 = c / q;
      return vec2(min(r1, r2), max(r1, r2));
    }
    // unbent height of a point on a camera ray (what fog and cloud densities are defined on)
    float blUnbentY(vec3 p, vec3 ro) { vec2 d = p.xz - ro.xz; return p.y + 7.848061e-8 * dot(d, d); }
  `;

  // ---------------------------------------------------------------- targets
  let rtScene = null, rtAO = [null, null], rtFog = null, rtHDR = null, rtLDR = null, down = [], up = [];
  const HF = THREE.HalfFloatType;
  function mkRT(w, h, opts = {}) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), Object.assign({ type: HF, depthBuffer: false, stencilBuffer: false }, opts));
    rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter; rt.texture.generateMipmaps = false; rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping; return rt;
  }
  function disposeAll() { for (const rt of [rtScene, rtAO[0], rtAO[1], rtFog, rtHDR, rtLDR, ...down, ...up]) if (rt) { if (rt.depthTexture) rt.depthTexture.dispose(); rt.dispose(); } down = []; up = []; }
  function build(w, h) {
    disposeAll(); W = w; H = h;
    const maxS = R.capabilities.maxSamples || 4;
    let samples = debug.msaa ? Math.min(Q.samples, maxS) : 0; if (w * h > 4.6e6 && samples > 2) samples = 2;
    const dt = new THREE.DepthTexture(w, h, THREE.FloatType); dt.format = THREE.DepthFormat; dt.minFilter = dt.magFilter = THREE.NearestFilter;
    rtScene = mkRT(w, h, { depthBuffer: true, depthTexture: dt, samples });
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
    rtAO = [mkRT(hw, hh), mkRT(hw, hh)];
    rtFog = mkRT(Math.ceil(w * Q.fogScale), Math.ceil(h * Q.fogScale));
    rtHDR = mkRT(w, h);
    rtLDR = Q.fxaa ? mkRT(w, h, { type: THREE.UnsignedByteType }) : null;
    let bw = hw, bh = hh; for (let i = 0; i < Q.bloom; i++) { down.push(mkRT(bw, bh)); if (i < Q.bloom - 1) up.push(mkRT(bw, bh)); bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1); }
    cam.uTexel.value.set(1 / w, 1 / h);
  }

  // ---------------------------------------------------------------- passes
  const aoMat = mk(Object.assign({ tDepth: { value: null }, uSamples: { value: 12 }, uRadius: { value: 1.1 }, uStrength: { value: 1.25 } }, cam), CAMGLSL + /* glsl */`
    uniform sampler2D tDepth; uniform int uSamples; uniform float uRadius, uStrength; varying vec2 vUv;
    vec3 vp(vec2 uv) { return viewPosAt(uv, texture2D(tDepth, uv).r); }
    void main() {
      float d = texture2D(tDepth, vUv).r;
      if (d >= 0.99999) { gl_FragColor = vec4(1.0, d, 0.0, 1.0); return; }
      vec3 P = viewPosAt(vUv, d);
      vec2 tx = vec2(uTexel.x * 2.0, 0.0), ty = vec2(0.0, uTexel.y * 2.0);
      vec3 pr = vp(vUv + tx) - P, pl = P - vp(vUv - tx), pu = vp(vUv + ty) - P, pd = P - vp(vUv - ty);
      vec3 dx = abs(pr.z) < abs(pl.z) ? pr : pl, dy = abs(pu.z) < abs(pd.z) ? pu : pd;
      vec3 Nc = cross(dx, dy); float nl = length(Nc);
      if (!(nl > 1e-9)) { gl_FragColor = vec4(1.0, d, 0.0, 1.0); return; }        // degenerate / NaN guard
      vec3 N = Nc / nl;
      float w = -P.z; float rad = min(uRadius * (1.0 + w * 0.01), 7.0);
      float rpx = rad * uFocal / w;
      if (rpx < 1.2) { gl_FragColor = vec4(1.0, d, 0.0, 1.0); return; }
      rpx = min(rpx, 90.0);
      float ang = ign(gl_FragCoord.xy) * 6.2831853, occ = 0.0;
      for (int i = 0; i < 16; i++) {
        if (i >= uSamples) break;
        float f = (float(i) + 0.5) / float(uSamples); float r = sqrt(f) * rpx; ang += 2.3999632;
        vec2 suv = vUv + vec2(cos(ang), sin(ang)) * r * uTexel;
        vec3 v = vp(suv) - P; float dist = length(v);
        occ += max(dot(N, v / max(dist, 1e-4)) - 0.1, 0.0) * (1.0 - smoothstep(rad * 0.55, rad, dist));
      }
      float ao = 1.0 - uStrength * occ / float(uSamples); if (!(ao >= 0.0 && ao <= 1.0)) ao = 1.0;
      ao = mix(1.0, ao, 1.0 - smoothstep(500.0, 1400.0, w));
      gl_FragColor = vec4(clamp(ao, 0.0, 1.0), d, 0.0, 1.0);
    }`);
  const blurMat = mk(Object.assign({ tAO: { value: null }, uDir: { value: new THREE.Vector2() } }, cam), CAMGLSL + /* glsl */`
    uniform sampler2D tAO; uniform vec2 uDir; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tAO, vUv); float w0 = depthW(c.g); float s = c.r, ws = 1.0;
      for (int i = -3; i <= 3; i++) {
        if (i == 0) continue;
        vec4 t = texture2D(tAO, vUv + uDir * float(i));
        float k = exp(-abs(depthW(t.g) - w0) / (0.04 * w0 + 0.25)) * (1.0 - abs(float(i)) * 0.2);
        s += t.r * k; ws += k;
      }
      gl_FragColor = vec4(s / ws, c.g, 0.0, 1.0);
    }`);
  const fogMat = mk(Object.assign({ tDepth: { value: null }, uSteps: { value: 16 } }, cam, Sky.uniforms), Sky.glsl + Sky.glslFx + CAMGLSL + /* glsl */`
    uniform sampler2D tDepth; uniform int uSteps; varying vec2 vUv;
    void main() {
      if (uFogDens <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      float d = texture2D(tDepth, vUv).r;
      vec3 vr = viewRay(vUv); float tS = d >= 0.99999 ? 1e9 : depthW(d) * length(vr);
      vec3 rd = normalize(mat3(uCamWorld) * vr), ro = uCamPos;
      float topMax = uFogTop * 1.2 + 90.0;
      vec2 lh = blLevelHits(ro.y, rd, topMax);                // the curved layer top
      float t0 = max(0.0, lh.x), t1 = min(min(tS, 70000.0), lh.y);
      if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      float seg = t1 - t0, jit = ign(gl_FragCoord.xy);
      float probe = 0.0;                                   // cheap early-out: is there any fog along this ray?
      for (int k = 0; k < 6; k++) { float a = (float(k) + 0.5) / 6.0; probe = max(probe, skyFogReach((ro + rd * (t0 + seg * a * a)).xz)); }
      if (probe < 0.002 && skyFogReach((ro + rd * t0).xz) < 0.002) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      float mu = dot(rd, uSkySunDir);
      float phase = 0.3 + 3.4 * skyPhaseHG(mu, 0.62);
      // grazing rays cross kilometres of the layer's top: up to twice the steps there (the arcs of equal-distance
      // step boundaries otherwise show as rings on the fog top), and each step gets its own stratified jitter
      int ns = uSteps + int(float(uSteps) * clamp(1.0 - abs(rd.y) * 5.0, 0.0, 1.0));
      vec3 L = vec3(0.0); float T = 1.0; float N = float(ns);
      for (int i = 0; i < 40; i++) {
        if (i >= ns) break;
        float a0 = float(i) / N, a1 = float(i + 1) / N;
        float ta0 = t0 + seg * a0 * a0, ta1 = t0 + seg * a1 * a1, dt = ta1 - ta0;
        vec3 p = ro + rd * mix(ta0, ta1, fract(jit + float(i) * 0.618034));
        p.y = blUnbentY(p, ro);
        float dens = skyFogDensity(p);
        if (dens > 0.001) {
          float sig = dens * 0.0045; float Ts = exp(-sig * dt);
          float below = max(uFogTop - p.y, 0.0);
          // sun-side shading of the billows: density a little way toward the sun darkens the lee sides
          float occ = dens > 0.04 ? skyFogDensity(p + uSkySunDir * 70.0 + vec3(0.0, 25.0, 0.0)) : 0.0;
          float sunVis = exp(-below * 0.0045 * uFogDens * 0.3 / max(uSkySunDir.y + 0.1, 0.1)) * exp(-occ * 0.9);
          float gl = skyFogGlow(p.xz);
          float dark = uSkyNight * uSkyNight;                  // city glow only once it's really dark (twilight fog stays lavender)
          vec3 Ls = uSkySunColor * sunVis * phase * 0.3 + uSkyAmbient * (0.75 + 0.35 * sunVis) + (uSkyGlow * vec3(0.8, 0.9, 1.1) * (0.3 + 2.2 * gl) + vec3(0.004, 0.006, 0.011)) * dark * 2.0;
          L += T * (1.0 - Ts) * Ls; T *= Ts;
          if (T < 0.015) break;
        }
      }
      gl_FragColor = vec4(L, T);
    }`);
  const compMat = mk(Object.assign({
    tScene: { value: null }, tDepth: { value: null }, tAO: { value: null }, tFog: { value: null }, uUseAO: { value: 1 }, uAOHalf: { value: new THREE.Vector2() }, uFogTexel: { value: new THREE.Vector2() },
  }, cam, Sky.uniforms), Sky.glsl + Sky.glslFx + CAMGLSL + /* glsl */`
    uniform sampler2D tScene, tDepth, tAO, tFog; uniform float uUseAO; uniform vec2 uAOHalf, uFogTexel; varying vec2 vUv;
    float aoUp(vec2 uv, float d) {       // joint bilateral upsample of the half-res AO (depth stored in .g)
      vec2 hp = uv / uAOHalf - 0.5; vec2 f = fract(hp); vec2 b = (floor(hp) + 0.5) * uAOHalf;
      float w0 = depthW(d); float s = 0.0, ws = 0.0;
      for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
        vec2 o = vec2(float(i), float(j)); vec4 t = texture2D(tAO, b + o * uAOHalf);
        float wb = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
        float wd = 1.0 / (1e-3 + abs(depthW(t.g) - w0) / (0.03 * w0 + 0.15));
        s += t.r * wb * wd; ws += wb * wd;
      }
      return ws > 0.0 ? s / ws : 1.0;
    }
    void main() {
      vec3 col = texture2D(tScene, vUv).rgb;
      float d = texture2D(tDepth, vUv).r; bool sky = d >= 0.99999;
      vec3 vr = viewRay(vUv); float tS = sky ? 1e9 : depthW(d) * length(vr);
      vec3 rd = normalize(mat3(uCamWorld) * vr), ro = uCamPos;
      float mu = dot(rd, uSkySunDir);
      if (!sky) {
        if (uUseAO > 0.5) col *= aoUp(vUv, d);
        vec3 wp = ro + rd * tS;
        if (uSkySunDir.y > 0.02 && uCloudCover > 0.01) {       // moving cloud shadows on the land
          vec3 cp = wp + uSkySunDir * ((uCloudBase + 250.0 - wp.y) / uSkySunDir.y);
          col *= 1.0 - 0.55 * skyCloudDens(cp.xz) * smoothstep(0.02, 0.2, uSkySunDir.y);
        }
        vec3 T; vec3 ins = skyAerial(ro.y, rd, tS, T); col = col * T + ins;
      }
      // cumulus deck: three slices through the 1.6-2.3 km layer (domed tops, darker bases, silver lining)
      bool above = ro.y > uCloudBase + 500.0; vec4 cl = vec4(0.0);
      if (uCloudCover > 0.001) {
        for (int s = 0; s < 3; s++) {
          float si = above ? float(2 - s) : float(s);
          float H = uCloudBase + si * 330.0; vec2 ch = blLevelHits(ro.y, rd, H);
          float tc = ro.y < H ? ch.y : ch.x;                   // the deck curves down to the horizon
          if (tc <= 0.0 || tc >= tS || tc > 5e5) continue;
          vec3 cp = ro + rd * tc;
          float cd = skyCloudDensH(cp.xz, si * 0.5) * (1.0 - smoothstep(90000.0, 190000.0, tc));
          if (cd < 0.003) continue;
          float lit = 0.5 + 0.25 * si;
          vec3 cc = uSkySunColor * (0.2 * lit + skyPhaseHG(mu, 0.62) * (above ? 0.35 : 1.0) * (1.0 - cd * 0.65)) + uSkyAmbient * (0.7 + 0.35 * lit) + uSkyGlow * uSkyNight * 1.8;
          vec3 Tc; vec3 ic = skyAerial(ro.y, rd, tc, Tc); cc = cc * Tc + ic;
          float a = clamp(cd * 0.62, 0.0, 0.9);
          cl.rgb += (1.0 - cl.a) * a * cc; cl.a += (1.0 - cl.a) * a;
        }
      }
      vec2 ft = uFogTexel;
      vec4 fg = texture2D(tFog, vUv) * 0.4 + (texture2D(tFog, vUv + vec2(ft.x, ft.y)) + texture2D(tFog, vUv + vec2(-ft.x, ft.y)) + texture2D(tFog, vUv + vec2(ft.x, -ft.y)) + texture2D(tFog, vUv - ft)) * 0.15;
      if (above) { col = col * fg.a + fg.rgb; col = col * (1.0 - cl.a) + cl.rgb; }
      else {
        col = col * (1.0 - cl.a) + cl.rgb;
        // cirrus veil (only the sky)
        if (sky && rd.y > -0.05) {
          vec2 cih = blLevelHits(ro.y, rd, 9000.0); float tci = ro.y < 9000.0 ? cih.y : cih.x;
          if (tci > 0.0 && tci < 8e5) { vec3 cp = ro + rd * tci; float ci = skyCirrus(cp.xz) * smoothstep(-0.02, 0.1, rd.y) * (1.0 - smoothstep(2.5e5, 6e5, tci));
            vec3 cc = uSkySunColor * (0.16 + 0.8 * skyPhaseHG(mu, 0.6)) + uSkyAmbient * 0.8 + uSkyGlow * uSkyNight; col = mix(col, cc, ci * 0.55); }
        }
        col = col * fg.a + fg.rgb;
      }
      if (!(dot(col, vec3(1.0)) < 1e6)) col = vec3(0.0);    // NaN/Inf guard (comparisons with NaN are false)
      col = max(col, vec3(0.0));
      gl_FragColor = vec4(min(col, vec3(60000.0)), 1.0);
    }`);
  // bloom
  const brightMat = mk({ tSrc: { value: null }, uThreshold: { value: 1.0 }, uExposure: { value: 1 }, uTexel: { value: new THREE.Vector2() } }, /* glsl */`
    uniform sampler2D tSrc; uniform float uThreshold, uExposure; uniform vec2 uTexel; varying vec2 vUv;
    vec3 fetch(vec2 o) { vec3 c = texture2D(tSrc, vUv + o * uTexel).rgb; if (any(isnan(c))) c = vec3(0.0); return c / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)) * uExposure * 0.25); }   // Karis-style firefly tamer
    void main() {
      vec3 c = 0.25 * (fetch(vec2(-1.0, -1.0)) + fetch(vec2(1.0, -1.0)) + fetch(vec2(-1.0, 1.0)) + fetch(vec2(1.0, 1.0)));
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722)) * uExposure; float knee = uThreshold * 0.5;
      float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee); soft = soft * soft / (4.0 * knee + 1e-4);
      gl_FragColor = vec4(c * max(soft, l - uThreshold) / max(l, 1e-4), 1.0);
    }`);
  const downMat = mk({ tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, /* glsl */`
    uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
    vec3 s(float x, float y) { return texture2D(tSrc, vUv + vec2(x, y) * uTexel).rgb; }
    void main() {   // 13-tap (Jimenez 2014)
      vec3 a = s(-2.0, 2.0), b = s(0.0, 2.0), c = s(2.0, 2.0), d = s(-2.0, 0.0), e = s(0.0, 0.0), f = s(2.0, 0.0), g = s(-2.0, -2.0), h = s(0.0, -2.0), i = s(2.0, -2.0);
      vec3 j = s(-1.0, 1.0), k = s(1.0, 1.0), l = s(-1.0, -1.0), m = s(1.0, -1.0);
      vec3 r = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
      gl_FragColor = vec4(r, 1.0);
    }`);
  const upMat = mk({ tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 0.8 } }, /* glsl */`
    uniform sampler2D tSrc, tAdd; uniform vec2 uTexel; uniform float uMix; varying vec2 vUv;
    vec3 s(float x, float y) { return texture2D(tSrc, vUv + vec2(x, y) * uTexel).rgb; }
    void main() {   // 3x3 tent upsample of the coarser level + this level
      vec3 r = (s(-1.0, -1.0) + s(1.0, -1.0) + s(-1.0, 1.0) + s(1.0, 1.0)) + 2.0 * (s(0.0, -1.0) + s(0.0, 1.0) + s(-1.0, 0.0) + s(1.0, 0.0)) + 4.0 * s(0.0, 0.0);
      gl_FragColor = vec4(r / 16.0 * uMix + texture2D(tAdd, vUv).rgb, 1.0);
    }`);
  const finalMat = mk({
    tHDR: { value: null }, tBloom: { value: null }, uExposure: { value: 1 }, uBloom: { value: 0.06 }, uTime: U.uTime, uGrain: { value: 0.016 }, uVignette: { value: 0.22 },
    uTint: { value: new THREE.Vector3(1, 1, 1) }, uGrade: { value: 1 }, uSat: { value: 1.06 }, uNight: U.uNight,
  }, /* glsl */`
    uniform sampler2D tHDR, tBloom; uniform float uExposure, uBloom, uTime, uGrain, uVignette, uGrade, uSat, uNight; uniform vec3 uTint; varying vec2 vUv;
    vec3 RRTAndODTFit(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
    vec3 aces(vec3 c) {
      const mat3 I = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 O = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      c = I * (c / 0.6); c = RRTAndODTFit(c); return clamp(O * c, 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main() {
      vec3 c = texture2D(tHDR, vUv).rgb + texture2D(tBloom, vUv).rgb * uBloom;
      c = aces(c * uTint * uExposure);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = max(mix(vec3(l), c, uSat), 0.0);
      // split toning: cool shadows, warm highlights (night: deeper blue shadows)
      vec3 cool = mix(vec3(-0.010, 0.000, 0.016), vec3(-0.012, 0.002, 0.026), uNight), warm = vec3(0.014, 0.005, -0.012);
      c += (cool * (1.0 - smoothstep(0.0, 0.4, l)) + warm * smoothstep(0.45, 1.0, l)) * uGrade;
      vec2 q = vUv - 0.5; c *= 1.0 - uVignette * smoothstep(0.25, 0.85, length(q * vec2(1.0, 0.78)) * 1.35);
      c = toSRGB(clamp(c, 0.0, 1.0));
      c += (h12(gl_FragCoord.xy + fract(uTime * 7.31) * 173.0) - 0.5) * uGrain;
      gl_FragColor = vec4(c, 1.0);
    }`);
  const fxaaMat = mk({ tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, /* glsl */`
    uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
    float lu(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    void main() {   // FXAA 3.11-style (console quality)
      vec3 rgbNW = texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb, rgbNE = texture2D(tSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb;
      vec3 rgbSW = texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb, rgbSE = texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb, rgbM = texture2D(tSrc, vUv).rgb;
      float lNW = lu(rgbNW), lNE = lu(rgbNE), lSW = lu(rgbSW), lSE = lu(rgbSE), lM = lu(rgbM);
      float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
      float red = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
      float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
      dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
      vec3 A = 0.5 * (texture2D(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
      vec3 B = A * 0.5 + 0.25 * (texture2D(tSrc, vUv + dir * -0.5).rgb + texture2D(tSrc, vUv + dir * 0.5).rgb);
      float lB = lu(B); gl_FragColor = vec4((lB < lMin || lB > lMax) ? A : B, 1.0);
    }`);

  // ---------------------------------------------------------------- frame
  let failed = false;
  function render(dt) {
    if (!enabled || failed) { R.setRenderTarget(null); R.render(scene, camera); return; }
    try {
      R.getDrawingBufferSize(sz);
      if (sz.x !== W || sz.y !== H || !rtScene) build(sz.x, sz.y);
      frame++;
      const info = R.info; info.autoReset = false; info.reset();
      // 1. scene -> HDR MSAA target (resolved colour + log depth)
      R.setRenderTarget(rtScene); R.render(scene, camera);
      // camera uniforms (matrices are current after render)
      cam.uProjInv.value.copy(camera.projectionMatrixInverse); cam.uCamWorld.value.copy(camera.matrixWorld);
      cam.uCamPos.value.setFromMatrixPosition(camera.matrixWorld); cam.uLogC.value = Math.log2(camera.far + 1);
      cam.uFocal.value = 0.5 * H * camera.projectionMatrix.elements[5];
      cam.uTanHalf.value.set(1 / camera.projectionMatrix.elements[0], 1 / camera.projectionMatrix.elements[5]);
      const depth = rtScene.depthTexture;
      // 2. SSAO (half res) + bilateral blur
      const useAO = Q.ao > 0 && debug.ao;
      if (useAO) {
        aoMat.uniforms.tDepth.value = depth; aoMat.uniforms.uSamples.value = Q.ao; pass(aoMat, rtAO[0]);
        blurMat.uniforms.tAO.value = rtAO[0].texture; blurMat.uniforms.uDir.value.set(1 / rtAO[0].width, 0); pass(blurMat, rtAO[1]);
        blurMat.uniforms.tAO.value = rtAO[1].texture; blurMat.uniforms.uDir.value.set(0, 1 / rtAO[0].height); pass(blurMat, rtAO[0]);
      }
      // 3. marine layer raymarch (half res)
      fogMat.uniforms.tDepth.value = depth; fogMat.uniforms.uSteps.value = debug.fog ? Q.fogSteps : 0; pass(fogMat, rtFog);
      // 4. composite -> HDR
      compMat.uniforms.tScene.value = rtScene.texture; compMat.uniforms.tDepth.value = depth; compMat.uniforms.tAO.value = rtAO[0].texture;
      compMat.uniforms.tFog.value = rtFog.texture; compMat.uniforms.uUseAO.value = useAO ? 1 : 0; compMat.uniforms.uAOHalf.value.set(1 / rtAO[0].width, 1 / rtAO[0].height); compMat.uniforms.uFogTexel.value.set(1.2 / rtFog.width, 1.2 / rtFog.height);
      pass(compMat, rtHDR);
      // 5. bloom
      const exposure = Env.state.exposure || 1, night = U.uNight.value;
      brightMat.uniforms.tSrc.value = rtHDR.texture; brightMat.uniforms.uExposure.value = exposure; brightMat.uniforms.uTexel.value.set(1 / W, 1 / H);
      brightMat.uniforms.uThreshold.value = U.lerp(1.15, 0.8, night); pass(brightMat, down[0]);
      for (let i = 1; i < down.length; i++) { downMat.uniforms.tSrc.value = down[i - 1].texture; downMat.uniforms.uTexel.value.set(1 / down[i - 1].width, 1 / down[i - 1].height); pass(downMat, down[i]); }
      for (let i = up.length - 1; i >= 0; i--) {
        const src = i === up.length - 1 ? down[i + 1] : up[i + 1];
        upMat.uniforms.tSrc.value = src.texture; upMat.uniforms.tAdd.value = down[i].texture; upMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        pass(upMat, up[i]);
      }
      // 6. tone map + grade -> screen (or LDR for FXAA)
      const fu = finalMat.uniforms;
      fu.tHDR.value = rtHDR.texture; fu.tBloom.value = (up[0] || down[0]).texture; fu.uExposure.value = exposure;
      fu.uBloom.value = U.lerp(0.045, 0.11, night) / Math.max(1, down.length - 2); fu.uGrain.value = Q.grain;
      const eDeg = Env.state.sunEl / U.DEG, golden = U.smooth(22, 4, eDeg) * (1 - U.smooth(1, -6, eDeg));
      fu.uTint.value.set(1 + 0.03 * golden, 1, 1 - 0.035 * golden);
      if (Q.fxaa) { pass(finalMat, rtLDR); fxaaMat.uniforms.tSrc.value = rtLDR.texture; fxaaMat.uniforms.uTexel.value.set(1 / W, 1 / H); pass(fxaaMat, null); }
      else pass(finalMat, null);
      stats.calls = info.render.calls; stats.triangles = info.render.triangles;
    } catch (e) {
      console.error('Post failed, falling back to direct rendering', e); failed = true;
      R.info.autoReset = true; R.setRenderTarget(null); R.render(scene, camera);
    }
  }
  // GPU cost (ms) of the current view, synced with a 1-px readback: Post.profile(12) -> { scene, total, post, ao, fog }
  function profile(n = 12) {
    if (!rtScene || failed) return null;
    const gl = R.getContext(), px = new Uint8Array(4);
    const sync = () => { R.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    const time = (f) => { f(); sync(); const t0 = performance.now(); for (let i = 0; i < n; i++) f(); sync(); return (performance.now() - t0) / n; };
    const d = Object.assign({}, debug), r2 = (v) => Math.round(v * 100) / 100;
    const sceneOnly = time(() => { R.setRenderTarget(rtScene); R.render(scene, camera); });
    const all = time(() => render(0));
    debug.ao = false; const noAO = time(() => render(0)); debug.ao = d.ao;
    debug.fog = false; const noFog = time(() => render(0)); debug.fog = d.fog;
    return { scene: r2(sceneOnly), total: r2(all), post: r2(all - sceneOnly), ao: r2(all - noAO), fog: r2(all - noFog), w: W, h: H, quality };
  }
  function setQuality(q) {
    if (!QUALITY[q]) return; quality = q; Q = QUALITY[q]; W = H = 0;       // rebuild targets next frame
    const s = Env.sun.shadow; if (s.mapSize.x !== Q.shadow) { s.mapSize.set(Q.shadow, Q.shadow); if (s.map) { s.map.dispose(); s.map = null; } }
  }
  setQuality('high');
  return {
    render, setQuality, stats, debug, profile, rebuild() { W = H = 0; },
    get quality() { return quality; },
    get enabled() { return enabled && !failed; }, set enabled(v) { enabled = !!v; if (!enabled) R.info.autoReset = true; },
    get targets() { return { rtScene, rtHDR, rtFog, rtAO }; },
  };
})();
