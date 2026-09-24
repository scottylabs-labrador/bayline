// SunShade (Ultra+ only): terrain sun shadows and sky visibility solved on WebGPU, and a far sun-shadow cascade.
//   SunShade.setQuality(q)         'ultraplus' switches it on, any other level off
//   SunShade.update(dt, camPos)    per frame (before render): far-cascade frustum, solver scheduling
//   SunShade.stats                 { on, solves, solveMs, readMs, skyReady, sunReady, err }
// Hills shade valleys at sunrise and sunset: the solver marches from every 100 m cell of the 102.4 km square toward the
// sun over the terrain's 64 m field and keeps S(x, z), the top of the terrain's shadow above that cell, so ANY point
// (terrain, building, tree, train) is in a hill's shadow iff its height is below S there; the penumbra grows with the
// distance to the occluding ridge. A second pass gives the terrain's sky visibility (ambient occlusion of valleys).
// Results are read back and uploaded as WebGL textures: the renderer stays WebGL2, WebGPU only computes.
// The far cascade (a second shadow-casting DirectionalLight with zero intensity, 2048², ±2.5 km) lets buildings, trees
// and trains cast shadows out to kilometres; the sun's near map (Env) keeps the detail up close.
// Shading: every lit built-in material's lighting chunk gets code under `NUM_DIR_LIGHT_SHADOWS > 1`, which only holds
// while the far cascade exists, i.e. in Ultra+. Default tiers compile exactly the shaders they did before.
const SunShade = (() => {
  const XS = 1024;                                  // solver output cells per side over the square (100 m each)
  const FAR = 2500;                                 // far cascade half-size (m)
  const FAR_EVERY = 6;                              // far map refresh: every 6th frame (it only matters beyond ~150 m)
  const stats = { on: false, solves: 0, solveMs: 0, readMs: 0, skyReady: false, sunReady: false, err: '' };
  const T = Terrain.TILE;

  // ---------------------------------------------------------------- shared uniforms (every lit built-in material)
  const tex = (data, fmt, type, fill) => { const t = new THREE.DataTexture(data, 1, 1, fmt, type); t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; return t; };
  const sunTex = tex(new Uint16Array([THREE.DataUtils.toHalfFloat(-6e4), 0]), THREE.RGFormat, THREE.HalfFloatType);
  const skyTex = tex(new Uint8Array([255]), THREE.RedFormat, THREE.UnsignedByteType);
  const xf = new THREE.Vector4(T.X0, T.Z0, 1 / T.SIZE, 0);            // world origin, 1/size, on (sun),
  const k = new THREE.Vector4(5.0, 0.0, 3.0, 0.0);                     // height bias (m), sky strength, min penumbra (m)
  // UniformsUtils.clone() gives each material its own copies; these must stay shared, so clone() returns the same object
  for (const o of [sunTex, skyTex, xf, k]) o.clone = function () { return this; };
  const UNI = { blTerrSun: { value: sunTex }, blTerrSky: { value: skyTex }, blTerrXf: { value: xf }, blTerrK: { value: k } };
  for (const id of ['standard', 'physical', 'lambert', 'phong', 'toon']) if (THREE.ShaderLib[id]) Object.assign(THREE.ShaderLib[id].uniforms, UNI);

  // ---------------------------------------------------------------- shader patch (inert unless two dir lights cast)
  THREE.ShaderChunk.lights_pars_begin += /* glsl */`
#if NUM_DIR_LIGHT_SHADOWS > 1
  #define BL_CASCADE
  uniform sampler2D blTerrSun; uniform sampler2D blTerrSky; uniform vec4 blTerrXf; uniform vec4 blTerrK;
  // view -> world, undoing the earth-curve bend of 00_util.js (it lowers view positions by K d² along world up)
  vec3 blWorldPos( vec3 vp ) {
    vec3 w = transpose( mat3( viewMatrix ) ) * ( vp - viewMatrix[ 3 ].xyz );
    float bv = dot( vp, viewMatrix[ 1 ].xyz );
    w.y += 7.848061e-8 * max( dot( vp, vp ) - bv * bv, 0.0 );
    return w;
  }
  vec2 blTerrUv( vec3 w ) { return ( w.xz - blTerrXf.xy ) * blTerrXf.z; }
  bool blTerrIn( vec2 uv ) { return all( greaterThanEqual( uv, vec2( 0.0 ) ) ) && all( lessThanEqual( uv, vec2( 1.0 ) ) ); }
  float blTerrainSun( vec3 w ) {                    // 1 lit .. 0 behind a hill (S = shadow top, y = occluder distance)
    vec2 uv = blTerrUv( w ); if ( blTerrXf.w < 0.5 || ! blTerrIn( uv ) ) return 1.0;
    vec2 s = texture2D( blTerrSun, uv ).rg; float pw = max( blTerrK.z, s.y * 0.0047 );
    return smoothstep( s.x - pw, s.x + pw, w.y + blTerrK.x );
  }
  float blTerrainSky( vec3 w ) {
    vec2 uv = blTerrUv( w ); if ( blTerrK.y <= 0.0 || ! blTerrIn( uv ) ) return 1.0;
    return mix( 1.0, texture2D( blTerrSky, uv ).r, blTerrK.y );
  }
#endif
`;
  const shadowCall = (i) => `getShadow( directionalShadowMap[ ${i} ], directionalLightShadows[ ${i} ].shadowMapSize, directionalLightShadows[ ${i} ].shadowBias, directionalLightShadows[ ${i} ].shadowRadius, vDirectionalShadowCoord[ ${i} ] )`;
  const DIR_OLD = `		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );`;
  const DIR_NEW = `		#if defined( BL_CASCADE ) && ( UNROLLED_LOOP_INDEX == 0 )
		{ float blS = 1.0;                                   // near map, blended into the far map toward its edge
		  if ( directLight.visible && receiveShadow ) {
			blS = ${shadowCall(0)};
			vec3 blC = vDirectionalShadowCoord[ 0 ].xyz / vDirectionalShadowCoord[ 0 ].w;
			vec2 blE = abs( blC.xy - 0.5 ) * 2.0;
			float blK = smoothstep( 0.78, 0.96, max( blE.x, blE.y ) );
			if ( blTerrK.w > 0.5 ) blK = blTerrK.w > 1.5 ? 1.0 : 0.0;   // (QA: 1 near map only, 2 far map only)
			if ( blK > 0.0 ) blS = mix( blS, ${shadowCall(1)}, blK );
		  }
		  directLight.color *= min( blS, blTerrainSun( blWorld ) );   // hills shade everything lit (also receiveShadow = false)
		}
		#elif ! defined( BL_CASCADE ) || ( UNROLLED_LOOP_INDEX != 1 )
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		#endif
		#if ! defined( BL_CASCADE ) || ( UNROLLED_LOOP_INDEX != 1 )
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		#endif`;
  const LB = THREE.ShaderChunk.lights_fragment_begin;
  if (LB.includes(DIR_OLD) && LB.includes('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )')) {
    THREE.ShaderChunk.lights_fragment_begin = LB.replace(DIR_OLD, DIR_NEW)
      .replace('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )', '#ifdef BL_CASCADE\n\tvec3 blWorld = blWorldPos( geometryPosition );\n#endif\n#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
    THREE.ShaderChunk.lights_fragment_end = `#ifdef BL_CASCADE
	{ float blSky = blTerrainSky( blWorld );
	#if defined( RE_IndirectDiffuse )
		irradiance *= blSky; iblIrradiance *= blSky;
	#endif
	#if defined( RE_IndirectSpecular )
		radiance *= mix( 1.0, blSky, 0.6 );
	#endif
	}
#endif
` + THREE.ShaderChunk.lights_fragment_end;
  } else { console.warn('sunshade: three.js lighting chunk changed; Ultra+ shading patch not applied'); stats.err = 'chunk'; }

  // ---------------------------------------------------------------- far cascade
  let on = false, far = null, farN = 99; const farAt = new THREE.Vector3(1e9, 0, 0);
  const focus = new THREE.Vector3(), camDir = new THREE.Vector3(), lx = new THREE.Vector3(), ly = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0);
  function farLight() {
    if (far) return far;
    far = new THREE.DirectionalLight(0xffffff, 0); far.name = 'sunshade:far-cascade';
    far.castShadow = true; far.shadow.mapSize.set(2048, 2048);   // 2.4 m texels: enough beyond the near map (±90 m+)
    far.shadow.autoUpdate = false;                    // re-rendered every FAR_EVERY frames (see update)
    Object.assign(far.shadow.camera, { left: -FAR, right: FAR, top: FAR, bottom: -FAR, near: 1, far: 12000 });
    return far;
  }
  function updateFar(camPos) {
    const sunDir = Env.sunDir, S = FAR;
    let ground = 0; try { ground = Terrain.h(camPos.x, camPos.z) || 0; } catch (e) {}
    Env.camera.getWorldDirection(camDir); const fl = Math.hypot(camDir.x, camDir.z) || 1;
    focus.set(camPos.x + camDir.x / fl * S * 0.55, ground, camPos.z + camDir.z / fl * S * 0.55);   // most of the box ahead
    lx.crossVectors(UPV, sunDir); if (lx.lengthSq() < 1e-6) lx.set(1, 0, 0); lx.normalize(); ly.crossVectors(sunDir, lx).normalize();
    const texel = 2 * S / far.shadow.mapSize.x, u = focus.dot(lx), v = focus.dot(ly);
    focus.addScaledVector(lx, Math.round(u / texel) * texel - u).addScaledVector(ly, Math.round(v / texel) * texel - v);
    const back = 4200, SC = far.shadow.camera;       // casters up to ~350 m tall and kilometres up-sun
    SC.near = 1; SC.far = back + 2600; SC.updateProjectionMatrix();
    far.position.copy(focus).addScaledVector(sunDir, back); far.target.position.copy(focus);
    far.shadow.normalBias = texel * 1.2; far.shadow.bias = -(0.05 + texel * 0.3) / (SC.far - SC.near);
  }

  // ---------------------------------------------------------------- WebGPU solver
  // Dispatched in row bands, one band per frame (a whole solve at once would stall WebGL for ~100 ms), then read back and
  // uploaded. Sun solves only while the sun is low (below ~20° hills cast almost no shadow the lighting doesn't already
  // have), when it has moved enough to shift distant shadow edges, and at most every 1.5 s (time-lapse).
  const SKY_WGSL = /* wgsl */`
    struct P { n: u32, steps: u32, cell: f32, tanEl: f32, dir: vec2f, t0: f32, grow: f32, outN: u32, outScale: f32, offX: f32, offY: f32, row0: u32, hMax: f32, pad0: u32, pad1: u32 };
    @group(0) @binding(0) var<storage, read> H: array<f32>;
    @group(0) @binding(1) var<storage, read_write> OUT: array<u32>;
    @group(0) @binding(2) var<uniform> p: P;
    fn hAt(q: vec2f) -> f32 {
      let m = f32(p.n - 1u); let c = clamp(q, vec2f(0.0), vec2f(m - 0.001));
      let i = vec2u(floor(c)); let f = c - floor(c); let k = i.y * p.n + i.x;
      return mix(mix(H[k], H[k + 1u], f.x), mix(H[k + p.n], H[k + p.n + 1u], f.x), f.y);
    }
    // sky visibility of a horizontal surface: mean over 16 azimuths of cos²(horizon elevation)
    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) id: vec3u) {
      let row = id.y + p.row0;
      if (id.x >= p.outN || row >= p.outN) { return; }
      let o = (vec2f(f32(id.x), f32(row)) + 0.5) * p.outScale + vec2f(p.offX, p.offY);
      let h0 = max(hAt(o), 0.0); var acc = 0.0;
      for (var a = 0u; a < 16u; a++) {
        let ang = f32(a) * 0.39269908; let dir = vec2f(cos(ang), sin(ang));
        var t = 1.0; var mx = 0.0;
        for (var k = 0u; k < p.steps; k++) {
          let q = o + dir * t;
          if (any(q < vec2f(0.0)) || any(q > vec2f(f32(p.n - 1u)))) { break; }
          let d = t * p.cell;
          if ((p.hMax - h0) / d < mx) { break; }             // nothing farther can be steeper
          mx = max(mx, (max(hAt(q), 0.0) - h0) / d);
          t = t * p.grow + 0.4;
        }
        acc += 1.0 / (1.0 + mx * mx);
      }
      OUT[row * p.outN + id.x] = pack4x8unorm(vec4f(acc / 16.0, 0.0, 0.0, 0.0));
    }`;
  const XSKY = 512, BAND = { sun: 128, sky: 64 }, SUN_MAX_EL = 20 * Math.PI / 180;
  let gpu = null, gpuP = null, job = null, want = null, last = { el: -9, az: -9, t: -1e9 };
  function writeParams(g, ub, xs, o, row0) {         // o: { steps, tanEl, dir: [x, z], t0, grow }
    const F = g.F, P = new ArrayBuffer(64), u32 = new Uint32Array(P), f32 = new Float32Array(P);
    u32[0] = F.N; u32[1] = o.steps; f32[2] = F.S; f32[3] = o.tanEl || 0; f32[4] = o.dir ? o.dir[0] : 0; f32[5] = o.dir ? o.dir[1] : 0; f32[6] = o.t0; f32[7] = o.grow;
    u32[8] = xs; f32[9] = (T.SIZE / xs) / F.S; f32[10] = (T.X0 - F.X0) / F.S; f32[11] = (T.Z0 - F.Z0) / F.S;   // (field samples sit at F.X0 + i F.S) u32[12] = row0; f32[13] = g.hMax;
    g.d.queue.writeBuffer(ub, 0, P);
  }
  function init() {
    if (gpuP) return gpuP;
    gpuP = (async () => {
      const F = Terrain.fallbackField; const d = await Gfx.device();
      if (!d || !F) { stats.err = !d ? 'no WebGPU device' : 'no height field'; return null; }
      let hMax = 0; for (let i = 0; i < F.heights.length; i++) if (F.heights[i] > hMax) hMax = F.heights[i];
      const hb = d.createBuffer({ size: F.heights.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); d.queue.writeBuffer(hb, 0, F.heights);
      const mk = async (code) => d.createComputePipelineAsync({ layout: 'auto', compute: { module: d.createShaderModule({ code }), entryPoint: 'main' } });
      const [sunPipe, skyPipe] = await Promise.all([mk(Gfx.SHADOW_WGSL), mk(SKY_WGSL)]);
      const buf = (size, usage) => d.createBuffer({ size, usage });
      const g = { d, F, hMax, hb, sunPipe, skyPipe,
        sunOut: buf(XS * XS * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC), sunRead: buf(XS * XS * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
        skyOut: buf(XSKY * XSKY * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC), skyRead: buf(XSKY * XSKY * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
        ubs: [0, 1, 2, 3, 4, 5, 6, 7, 8].map(() => buf(64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)) };
      g.bg = (pipe, out, ub) => d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: hb } }, { binding: 1, resource: { buffer: out } }, { binding: 2, resource: { buffer: ub } }] });
      d.lost.then(() => { if (gpu === g) { gpu = null; gpuP = null; job = null; stats.sunReady = stats.skyReady = false; xf.w = 0; k.y = 0; stats.err = 'WebGPU device lost'; } });
      gpu = g; return g;
    })().catch((e) => { stats.err = String(e && e.message || e); console.warn('sunshade: solver init failed', e); gpuP = null; return null; });
    return gpuP;
  }
  function startJob(kind) {
    const g = gpu; if (!g) return;
    const xs = kind === 'sun' ? XS : XSKY, band = BAND[kind];
    let o;
    if (kind === 'sun') { const sd = Env.sunDir, hl = Math.hypot(sd.x, sd.z) || 1; o = { steps: 128, tanEl: Math.max(sd.y, 0.002) / hl, dir: [sd.x / hl, sd.z / hl], t0: 1.5, grow: 1.03 }; }
    else o = { steps: 28, t0: 1, grow: 1.18 };
    job = { kind, g, xs, band, o, row: 0, t0: performance.now(), el: Env.state.sunEl, az: Env.state.sunAz, reading: false };
  }
  function stepJob() {                                // one band per frame; then the readback (async)
    const j = job, g = j.g; if (j.reading) return;
    if (j.row < j.xs) {
      const n = Math.min(j.band, j.xs - j.row), ub = g.ubs[(j.row / j.band) % g.ubs.length];
      writeParams(g, ub, j.xs, j.o, j.row);
      const enc = g.d.createCommandEncoder(), pass = enc.beginComputePass();
      pass.setPipeline(j.kind === 'sun' ? g.sunPipe : g.skyPipe); pass.setBindGroup(0, g.bg(j.kind === 'sun' ? g.sunPipe : g.skyPipe, j.kind === 'sun' ? g.sunOut : g.skyOut, ub));
      pass.dispatchWorkgroups(Math.ceil(j.xs / 8), Math.ceil(n / 8)); pass.end(); g.d.queue.submit([enc.finish()]);
      j.row += n; return;
    }
    j.reading = true;
    const out = j.kind === 'sun' ? g.sunOut : g.skyOut, rd = j.kind === 'sun' ? g.sunRead : g.skyRead, bytes = j.xs * j.xs * 4;
    const enc = g.d.createCommandEncoder(); enc.copyBufferToBuffer(out, 0, rd, 0, bytes); g.d.queue.submit([enc.finish()]);
    const t1 = performance.now();
    rd.mapAsync(GPUMapMode.READ).then(() => {
      const ab = rd.getMappedRange().slice(0); rd.unmap();
      if (job !== j) return;                          // (device lost / switched off meanwhile)
      if (j.kind === 'sun') { upload(sunTex, new Uint16Array(ab), XS, THREE.RGFormat, THREE.HalfFloatType); last = { el: j.el, az: j.az, t: performance.now() }; stats.solves++; stats.sunReady = true; }
      else { const u8 = new Uint8Array(ab), v = new Uint8Array(XSKY * XSKY); for (let i = 0; i < v.length; i++) v[i] = u8[i * 4]; upload(skyTex, v, XSKY, THREE.RedFormat, THREE.UnsignedByteType); stats.skyReady = true; k.y = 0.85; }
      stats.solveMs = Math.round(performance.now() - j.t0); stats.readMs = Math.round(performance.now() - t1); job = null;
    }, (e) => { if (job === j) job = null; stats.err = String(e && e.message || e); });
  }
  function upload(t, data, xs, fmt, type) { t.image = { data, width: xs, height: xs }; t.format = fmt; t.type = type; t.needsUpdate = true; }

  // ---------------------------------------------------------------- per frame
  function update(dt, camPos) {
    if (!on) return;
    const bay = typeof Globe === 'undefined' || Globe.frame.bay;
    far.castShadow = Env.sun.castShadow && bay;
    // the far map moves and re-renders together (its matrix only updates when it renders), every FAR_EVERY frames
    // or at once after a jump; in between, lookups use the last map, which still matches its own matrix
    if (far.castShadow && (++farN >= FAR_EVERY || camPos.distanceToSquared(farAt) > 150 * 150)) { farN = 0; farAt.copy(camPos); updateFar(camPos); far.shadow.needsUpdate = true; }
    Env.state.shadowReach = far.castShadow ? FAR * 1.2 : 0;
    const el = Env.state.sunEl, az = Env.state.sunAz, now = performance.now(), low = el < SUN_MAX_EL && Env.sun.castShadow;
    xf.w = bay && stats.sunReady && low ? 1 : 0;
    // re-solve when the sun moved enough to shift distant shadow edges (0.08° is ~7 m at 5 km)
    if (low && (Math.abs(el - last.el) > 0.0014 || Math.abs(U.wrapAngle(az - last.az)) * Math.cos(el) > 0.002) && now - last.t > 1500) want = 'sun';
    if (!gpu) { if (!gpuP) init(); return; }
    if (!job) { if (!stats.skyReady) startJob('sky'); else if (want) { want = null; startJob('sun'); } }
    if (job) try { stepJob(); } catch (e) { stats.err = String(e && e.message || e); job = null; }
  }
  function setQuality(q) {
    const want2 = q === 'ultraplus';
    if (want2 === on) return; on = want2; stats.on = on;
    if (on) { const f = farLight(); if (!f.parent) Env.scene.add(f, f.target); last = { el: -9, az: -9, t: -1e9 }; want = 'sun'; init(); }
    else { job = null; if (far) { far.castShadow = false; Env.scene.remove(far, far.target); } xf.w = 0; Env.state.shadowReach = 0; }
  }
  // QA: the solver's answer at a point (y: a height to test; default the terrain there)
  function sample(x, z, y) {
    const d = sunTex.image && sunTex.image.data; if (!stats.sunReady || !d || sunTex.image.width !== XS) return null;
    const u = Math.floor((x - T.X0) / T.SIZE * XS), v = Math.floor((z - T.Z0) / T.SIZE * XS); if (u < 0 || v < 0 || u >= XS || v >= XS) return null;
    const S = THREE.DataUtils.fromHalfFloat(d[(v * XS + u) * 2]), dist = THREE.DataUtils.fromHalfFloat(d[(v * XS + u) * 2 + 1]);
    const sd = skyTex.image, su = Math.floor(u * sd.width / XS), sv = Math.floor(v * sd.width / XS);
    const yy = y === undefined ? Terrain.h(x, z) : y, sky = sd.data ? sd.data[sv * sd.width + su] / 255 : 1;
    return { S, dist, y: yy, shadowed: yy + k.x < S, sky };
  }
  return { setQuality, update, stats, sample, get on() { return on; }, textures: { sun: sunTex, sky: skyTex }, uniforms: { xf, k } };
})();
