// MetroKit: the glazing seen from inside, and the look of trailer shots.
//  - clearGlass(S): a car's clear glazing once its interior is built (per car). The glass's own reflections of the world
//    as before (physical material; constant-colour blending keeps them at full strength over the tinted view), plus,
//    seen from inside, the car's interior mirrored in the pane: in the saloon the lit shell (the ceiling's LED bands,
//    walls, the far windows), in a D cab the console (its two screens, the panel, the desk lit by them) in the
//    windscreen and cab windows. At night, with the outside dark, these reflections are what the windows show.
//  - look(o): shot settings (trailer / promo modules; all optional, look(null) resets):
//      lcd: the screens' brightness (1 = the game's), refl: the interior reflections' strength (1 = physical),
//      cab: the D cab's light level (0..1; -1 = the runtime's), cinema: { ... } or null (below).
//  - the cinema glass (shots only, look({ cinema })): the glazing of the car the camera is in becomes a lens-blurred
//    view of the outside with rain on the glass in focus. The frame drawn so far (colour and depth) is grabbed just
//    before this glass draws (it draws last); the outside is gathered over a disc whose size follows each sample's
//    depth (a thin lens focused at the glass: the outside's lights become bokeh balls, highlights weighted up); the
//    drops are lenses showing a sharp, inverted image of the outside; beads, fresh drops and drops sliding back along
//    the car at speed with their trails; the cabin mirrored in the inner surface, soft; the glazing's tint.
//    cinema: { bokeh: blur radius at infinity (share of the frame height), gain: highlight weight, thr: highlight
//    threshold (scene radiance), lens: a drop's field (share of the frame height), beads: old drops 0..1, fresh: new
//    rain 0..1 (drops arriving, sliding), focus: focus distance (m; 0 = the glass at the frame centre), refl: cabin
//    reflection gain, tint: extra gain on the view through the glass }.
(() => {
  const K = MetroKit._k, V3 = THREE.Vector3;
  const MKG = K.MKG, CP = K.CAB_PANEL;

  // ------------------------------------------------------------------------------------------ interior reflections
  // (appended after the glazing's GLASS_FRAG_HEAD; design-space rays)
  const REFL_HEAD = `
    uniform sampler2D mkLcd; uniform vec4 mkLcdCab; uniform float mkLcdGain, mkReflK, mkHalfL;
    ${K.SCREEN_GLOW}
    // the D cab as its glazing mirrors it (the nearest of): the display panel (its face with the two screens, the LCD
    // canvas; its back), the desk top lit by the screens, the left cabinet, the operator's seat, the back wall with the
    // cab door and its window onto the lit saloon, the ceiling with the cab light, the floor and side walls. Lit by the
    // cab light (mkLv[9]); mkCabI: back wall x, desk front x, desk top y, 1 (see 42_metrokit_int.js cab())
    float mkCabT; vec3 mkCabC;
    void mkCabHit(float t, vec3 c) { if (t > 0.0 && t < mkCabT) { mkCabT = t; mkCabC = c; } }
    vec3 mkCabRefl(vec3 ro, vec3 rd) {
      float fy = mkFloorY, dY = mkCabI.z, k = 0.3 * mkLv[9] + 0.004;          // (a surface's radiance per unit albedo)
      vec3 O = vec3(${CP.x.toFixed(3)}, dY + ${CP.dy.toFixed(3)}, ${CP.z.toFixed(3)}), ex = ${CP.glsl.ex}, ey = ${CP.glsl.ey};
      mkCabT = 1e9; mkCabC = vec3(0.0);
      vec3 ia = 1.0 / rd;
      // the display panel: its face (x_local -0.047: the screens in their bezels) or its back (x_local +0.02)
      { float den = dot(rd, ex);
        if (abs(den) > 1e-4) {
          float xl = den > 0.0 ? -0.047 : 0.02, t = dot(O + ex * xl - ro, ex) / den;
          vec3 l = ro + rd * t - O; float ly = dot(l, ey), lz = l.z;
          if (abs(ly) < 0.17 && abs(lz) < 0.58) {
            vec3 c = vec3(0.6) * k;
            if (den > 0.0) { float zc = lz < 0.0 ? -0.19 : 0.19, dz = lz - zc;
              if (abs(dz) < 0.13 && abs(ly) < 0.1) {
                float um = 0.5 * (mkLcdCab.x + mkLcdCab.z), u = (dz + 0.13) / 0.26;
                c = texture2D(mkLcd, vec2(lz < 0.0 ? mix(mkLcdCab.x, um, u) : mix(um, mkLcdCab.z, u), mix(mkLcdCab.y, mkLcdCab.w, (ly + 0.1) / 0.2))).rgb * 1.6 * mkLcdGain;
              } else if (abs(dz) < 0.155 && abs(ly) < 0.125) c = vec3(0.02) * k; }
            mkCabHit(t, c);
          } } }
      if (rd.y < -1e-4) {
        // the desk top (lit by the screens) and the left cabinet's top
        float t = (dY - ro.y) / rd.y; vec3 h = ro + rd * t;
        if (h.x > mkCabI.y && h.x < 10.08 && h.z > -0.02 && h.z < 1.38) mkCabHit(t, vec3(0.62) * (k + mkScreenGlow(h, vec3(0.0, 1.0, 0.0))));
        t = (fy + 0.95 - ro.y) / rd.y; h = ro + rd * t;
        if (h.x > 9.55 && h.x < 10.1 && h.z > -1.42 && h.z < -0.55) mkCabHit(t, vec3(0.62) * k);
        mkCabHit((fy - ro.y) / rd.y, vec3(0.06) * k);                                  // the floor
      } else if (rd.y > 1e-4) {
        float t = (3.05 - ro.y) / rd.y; vec3 h = ro + rd * t;                          // the ceiling and the cab light
        mkCabHit(t, h.x > 9.3 && h.x < 9.8 && abs(h.z) < 0.3 ? vec3(1.0, 0.99, 0.95) * 3.2 * mkLv[9] : vec3(0.7) * k);
      }
      // the operator's seat (a dark box with its back) at z 0.72
      { vec3 b0 = vec3(8.66, fy + 0.38, 0.47), b1 = vec3(9.14, fy + 1.42, 0.97), t0 = (b0 - ro) * ia, t1 = (b1 - ro) * ia, tn = min(t0, t1), tf = max(t0, t1);
        float tN = max(max(tn.x, tn.y), tn.z), tF = min(min(tf.x, tf.y), tf.z); if (tN < tF) mkCabHit(tN, vec3(0.02, 0.025, 0.05) * k); }
      // the back wall (x 8.985) with the cab door (|z| < 0.45) and its window onto the lit saloon
      if (rd.x < -1e-4) {
        float t = (8.985 - ro.x) / rd.x; vec3 h = ro + rd * t, c = vec3(0.62) * k;
        if (abs(h.z) < 0.45) c = abs(h.z) < 0.2 && h.y > fy + 1.1 && h.y < fy + 1.85 ? mkTint * mkInterior(h + rd * ((mkCab.y - 0.1 - h.x) / rd.x), rd) : vec3(0.55) * k;
        mkCabHit(t, c);
      }
      if (abs(rd.z) > 1e-4) { float t = (sign(rd.z) * 1.44 - ro.z) / rd.z; vec3 h = ro + rd * t;   // the side walls, their windows dark
        mkCabHit(t, h.x > 9.18 && h.x < 9.78 && h.y > 1.87 && h.y < 2.86 ? vec3(0.0) : vec3(0.62) * k); }
      return mkCabC;
    }
    // the car's interior mirrored in the pane at p (design space) seen from ro: the cab's console or the saloon's shell
    vec3 mkInsideRefl(vec3 ro, vec3 p, vec3 rd, vec3 n) {
      vec3 rr = reflect(rd, n);
      if (mkCabI.w > 0.5 && ro.x > mkCab.y) return mkCabRefl(p + rr * 0.01, rr);
      return mkShellRefl(p + rr * 0.02, rr);
    }
    float mkCamInside(vec3 ro) { return step(abs(ro.z), mkHalfW + 0.12) * step(abs(ro.x), mkHalfL) * step(mkFloorY - 0.3, ro.y) * step(ro.y, mkCeilY + 0.4); }`;

  function clearGlass(S) {
    const m = new THREE.MeshPhysicalMaterial({ color: 0x0b1011, roughness: 0.02, metalness: 0, side: THREE.DoubleSide, transparent: true, depthWrite: false, envMapIntensity: 1.0 });
    m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor; m.blendDst = THREE.ConstantColorFactor; m.blendColor.copy(K.GLASS_TINT);
    m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
    m.forceSinglePass = true; m.userData.S = S;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, S);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + K.MK_VERT_HEAD)
        .replace('#include <skinning_vertex>', K.MK_VERT_BODY + '\n#include <skinning_vertex>');
      sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_pars_fragment>', '#include <clipping_planes_pars_fragment>' + K.GLASS_FRAG_HEAD + REFL_HEAD)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          if (mkReflK > 0.001 && mkCamInside(mkCamO) > 0.5) {
            mkDayK = 1.0; mkDayA = vec3(0.0); mkLitK = mkLv[1];
            #ifdef BL_UNDER_DEF
              { vec4 u = blUnder(blUnderWorld(-vViewPosition)); mkDayK = u.y; mkDayA = blUTint * u.z * RECIPROCAL_PI * mkIndoor.x; }
            #endif
            vec3 rd = normalize(mkP - mkCamO), n = normalize(mkN); if (dot(n, rd) > 0.0) n = -n;     // (the inner face)
            float F = 0.04 + 0.96 * pow(1.0 - abs(dot(rd, n)), 5.0);
            totalEmissiveRadiance += mkInsideRefl(mkCamO, mkP, rd, n) * F * mkReflK;
          }`);
    };
    m.customProgramCacheKey = () => 'mk-glass-clear-1';
    return m;
  }

  // ------------------------------------------------------------------------------------------ the grab (cinema)
  // The frame drawn so far, copied (MSAA resolved) into a mipmapped colour texture and a depth texture right before the
  // cinema glass draws, once per render of the main camera. Uses three's own framebuffer handles and state cache, the
  // way three resolves its multisampled targets.
  const GU = {
    mkGrab: { value: null }, mkGrabD: { value: null }, mkGrabRes: { value: new THREE.Vector2(1, 1) }, mkGrabOK: { value: 0 }, mkGrabLogF: { value: 1 },
    mkCineA: { value: new THREE.Vector4(0.03, 6, 1.5, 0.12) }, mkCineB: { value: new THREE.Vector4(0.6, 0, 0, 0) },
    mkCineC: { value: new THREE.Vector4(1, 0, 0, 1) }, mkCineD: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
  let grabRT = null, grabId = -1, grabWarned = false;
  function grab(R, camera) {
    const main = typeof Env !== 'undefined' && Env.camera;
    const rt = R.getRenderTarget();
    if (!rt || (main && camera !== main)) { GU.mkGrabOK.value = 0; return; }
    const id = R.info.render.frame; if (id === grabId) return; grabId = id;
    const gl = R.getContext(), w = rt.width, h = rt.height;
    try {
      if (!grabRT || grabRT.width !== w || grabRT.height !== h) {
        if (grabRT) { grabRT.depthTexture.dispose(); grabRT.dispose(); }
        const dt = new THREE.DepthTexture(w, h, THREE.FloatType); dt.format = THREE.DepthFormat; dt.minFilter = dt.magFilter = THREE.NearestFilter;
        // (generateMipmaps: three then allocates the whole mip chain; the levels are filled here, after each copy)
        grabRT = new THREE.WebGLRenderTarget(w, h, { type: rt.texture.type, depthBuffer: true, stencilBuffer: false, depthTexture: dt, generateMipmaps: true,
          minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
        grabRT.texture.wrapS = grabRT.texture.wrapT = THREE.ClampToEdgeWrapping;
        R.setRenderTarget(grabRT); R.setRenderTarget(rt);        // (allocates its framebuffer and textures)
        GU.mkGrab.value = grabRT.texture; GU.mkGrabD.value = dt;
      }
      const P = R.properties, pr = P.get(rt), pg = P.get(grabRT), st = R.state;
      const src = pr.__webglMultisampledFramebuffer || pr.__webglFramebuffer, dst = pg.__webglFramebuffer;
      const sc = gl.isEnabled(gl.SCISSOR_TEST); if (sc) gl.disable(gl.SCISSOR_TEST);
      st.bindFramebuffer(gl.READ_FRAMEBUFFER, src); st.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      st.bindFramebuffer(gl.READ_FRAMEBUFFER, null); st.bindFramebuffer(gl.DRAW_FRAMEBUFFER, src);
      if (sc) gl.enable(gl.SCISSOR_TEST);
      st.bindTexture(gl.TEXTURE_2D, P.get(grabRT.texture).__webglTexture); gl.generateMipmap(gl.TEXTURE_2D); st.unbindTexture();
      GU.mkGrabRes.value.set(w, h); GU.mkGrabLogF.value = Math.log2(camera.far + 1); GU.mkGrabOK.value = 1;
    } catch (e) { GU.mkGrabOK.value = 0; if (!grabWarned) { grabWarned = true; console.warn('MetroKit: cinema grab failed', e); } }
  }

  // ------------------------------------------------------------------------------------------ the cinema glass
  const CINE_HEAD = `
    uniform sampler2D mkGrab, mkGrabD; uniform vec2 mkGrabRes; uniform float mkGrabOK, mkGrabLogF;
    uniform vec4 mkCineA, mkCineB, mkCineC, mkCineD;
    float rH(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    // three's logarithmic depth -> view distance
    float mkViewZ(float d) { return exp2(d * mkGrabLogF) - 1.0; }
    float mkS;                        // focus distance
    // the outside through the glass, out of focus: a disc gather (golden-angle spiral) of the grabbed frame at a mip
    // that fills the gaps between taps; each tap counts if its own blur circle (thin lens focused at mkS) reaches this
    // pixel and it lies beyond the glass; bright taps weigh more (bokeh), the rim a little more than the centre
    const int MK_NB = 96;
    vec3 mkBokeh(vec2 uv, float zg, float scale) {
      float rpx = mkCineA.x * mkGrabRes.y * scale;
      vec2 R = vec2(rpx) / mkGrabRes;
      float lod = clamp(log2(rpx * 2.2 / sqrt(float(MK_NB))), 0.0, 7.0);        // (a texel ~ the taps' spacing)
      vec3 acc = vec3(0.0); float ws = 0.0, rot = 6.2831853 * rH(floor(gl_FragCoord.xy) + 0.37);     // (the spiral turned per pixel)
      for (int i = 0; i < MK_NB; i++) {
        float fi = float(i) + 0.5, r = sqrt(fi / float(MK_NB)), a = fi * 2.3999632 + rot;
        vec2 tuv = uv + vec2(cos(a), sin(a)) * r * R;
        float z = mkViewZ(textureLod(mkGrabD, tuv, 0.0).r);
        float coc = clamp((z - mkS) / max(z, 1e-3), 0.0, 1.0);
        float w = smoothstep(r - 0.15, r + 0.02, coc) * step(zg + 0.04, z);
        vec3 c = textureLod(mkGrab, tuv, lod).rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        w *= 1.0 + mkCineA.y * smoothstep(mkCineA.z, mkCineA.z * 5.0, l) * (0.7 + 0.6 * r * r);
        acc += c * w; ws += w;
      }
      return ws > 1e-4 ? acc / ws : textureLod(mkGrab, uv, lod).rgb;
    }
    // ---- rain on the glass: q in metres in the pane (x along the car, y up); the result is the water surface's slope
    // in the pane (mkRN: 0 at a drop's middle, ~0.85 at its rim), a drop's coverage (mkRC), a trail's (mkRT), the drop's
    // radius (mkRR, m) for its defocus
    vec2 mkRN; float mkRC, mkRT, mkRR;
    // one drop in flow space (f: along, across), centre c, radius r (m), stretched st along the flow; pxm: metres per
    // pixel (anti-aliasing); keeps the drop with the largest coverage
    void rDrop(vec2 f, vec2 c, float r, float st, float pxm, vec2 flow) {
      vec2 d = (f - c) / vec2(r * st, r); float l = length(d), a = min(pxm / r, 0.9);
      float cov = 1.0 - smoothstep(1.0 - a, 1.0 + a, l);
      if (cov <= mkRC) return;
      mkRC = cov; mkRR = r;
      vec2 sl = d * 0.85 * (0.55 + 0.45 * l * l);                 // a flattened cap: steep near the rim
      mkRN = flow * sl.x + vec2(-flow.y, flow.x) * sl.y;          // back to pane axes
    }
    void mkRain(vec2 q, float pxm) {
      mkRN = vec2(0.0); mkRC = 0.0; mkRT = 0.0; mkRR = 0.001;
      float v = mkCineB.z, run = clamp(abs(v) / 14.0, 0.0, 1.0), t = mkCineC.z;
      vec2 flow = normalize(vec2(-sign(v) * run * 1.2, -1.0));          // (down, and back along the car at speed)
      vec2 f = vec2(dot(q, flow), dot(q, vec2(-flow.y, flow.x)));
      float st = 1.0 + 0.35 * run;
      // beads (old drops that cling): 3.2 mm cells
      { float cs = 0.0032; vec2 id = floor(f / cs), o = (id + 0.5) * cs; float h = rH(id + 3.1);
        if (h < mkCineB.x * 0.62) { vec2 j = vec2(rH(id + 7.7), rH(id + 11.3)) - 0.5;
          float r = mix(0.0003, 0.0011, pow(rH(id + 1.9), 2.0));
          rDrop(f, o + j * cs * 0.3, r, st * (0.85 + 0.3 * rH(id + 5.3)), pxm, flow); } }
      // fresh drops (arriving with the rain): 7 mm cells, a drop pops in when the rain's share passes its own hash
      { float cs = 0.0065; vec2 id = floor(f / cs), o = (id + 0.5) * cs; float h = rH(id + 13.7);
        if (h < mkCineB.y * 0.5) { vec2 j = vec2(rH(id + 17.1), rH(id + 19.9)) - 0.5;
          float r = mix(0.0009, 0.0022, rH(id + 23.3));
          rDrop(f, o + j * cs * 0.28, r, st, pxm, flow); } }
      // a few big drops: 12 mm cells
      { float cs = 0.012; vec2 id = floor(f / cs), o = (id + 0.5) * cs; float h = rH(id + 47.3);
        if (h < mkCineB.y * 0.22) { vec2 j = vec2(rH(id + 51.1), rH(id + 53.9)) - 0.5;
          float r = mix(0.0022, 0.0036, rH(id + 57.7));
          rDrop(f, o + j * cs * 0.16, r, st * 1.08, pxm, flow); } }
      // runners: columns across the flow (15 mm), one drop per 100 mm stretch running along at its own pace in stick-
      // slip steps, wavering; behind it a thin trail and a line of tiny beads left on the glass, fading
      { float wc = 0.015, P = 0.1, col = floor(f.y / wc), hc = rH(vec2(col, 29.1));
        float wob = 0.2 * wc * sin(f.x * 60.0 + hc * 6.28) * (0.4 + 0.6 * run);
        float y = f.y - (col + 0.5) * wc - wob;
        float seg = floor(f.x / P), hs = rH(vec2(col, seg) + 31.7);
        float sp = mix(0.015, 0.07, rH(vec2(col, 37.3))) * (0.5 + 0.9 * run);
        float ca = (seg + fract(hs + (t + 0.3 * sin(2.3 * t + 6.28 * hs)) * sp / P)) * P;   // (a lap of P per P / sp s)
        if (rH(vec2(col, seg) + 41.9) < mkCineB.y * 0.7) {
          float r = mix(0.0024, 0.0038, rH(vec2(col, seg) + 43.1));
          rDrop(vec2(f.x, y), vec2(ca, 0.0), r, st * (1.05 + 0.3 * run), pxm, flow);
          float back = ca - f.x, Lt = 0.08;
          if (back > r && back < Lt) {
            float fade = 1.0 - back / Lt, tw = r * 0.42 * fade;
            float tr = (1.0 - smoothstep(tw - pxm, tw + pxm, abs(y))) * fade;
            // the trail is a thin cylindrical lens across its width (drawn like a drop: a squeezed image, dark edges)
            if (tr > mkRC) { mkRC = tr * 0.85; mkRT = tr; mkRR = tw; mkRN = vec2(-flow.y, flow.x) * clamp(y / max(tw, 1e-5), -1.0, 1.0) * 0.7; }
            // tiny beads along the trail (fixed on the glass)
            float bs = 0.0026, bi = floor(f.x / bs), bx = (bi + 0.5) * bs + (rH(vec2(bi, col)) - 0.5) * bs * 0.4;
            float br = r * 0.3 * (0.5 + 0.5 * rH(vec2(bi, col + 3.0))) * fade;
            if (br > 0.00012) rDrop(vec2(f.x, y), vec2(bx, 0.0), br, 1.0, pxm, flow);
          }
        } }
    }`;
  // the cinema main (after the lights): the output replaces the material's colour; opaque
  const CINE_MAIN = `
    {
      vec3 ro = mkCamO, rdC = normalize(mkP - ro), n = normalize(mkN); if (dot(n, rdC) > 0.0) n = -n;
      vec2 suv = gl_FragCoord.xy / mkGrabRes;
      float zg = -vViewPosition.z;
      mkS = mkCineC.y > 0.0 ? mkCineC.y : mkCineD.x;
      float front = step(0.5, abs(mkN.x));
      vec2 q = front > 0.5 ? vec2(mkP.z, mkP.y) : vec2(mkP.x, mkP.y);
      float pxm = max(length(dFdx(q)), length(dFdy(q))) + 1e-6;
      // the glass's own defocus (it is in focus only at mkS): drops soften and fade where their blur circle outgrows them
      float cocG = mkCineA.x * mkGrabRes.y * abs(zg - mkS) / max(zg, 1e-3) * pxm;       // (metres on the glass)
      mkRain(q, pxm);
      float soft = clamp(mkRR / max(mkRR + cocG, 1e-5), 0.0, 1.0);
      vec3 col;
      if (mkGrabOK < 0.5) col = vec3(0.004);
      else {
        vec3 bg = mkBokeh(suv, zg, 1.0);
        // a drop: the outside through its lens, inverted and sharp; dark toward its rim (total internal reflection)
        mat2 J = mat2(dFdx(q), dFdy(q)); float det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
        vec2 sd = abs(det) > 1e-14 ? inverse(J) * mkRN : vec2(0.0); float sl = length(mkRN);
        vec2 sdir = length(sd) > 1e-9 ? normalize(sd) * sl : vec2(0.0);
        vec2 off = -sdir * mkCineA.w * vec2(mkGrabRes.y / mkGrabRes.x, 1.0);
        vec3 lens = textureLod(mkGrab, clamp(suv + off, vec2(0.001), vec2(0.999)), 0.6 + 3.0 * (1.0 - soft)).rgb;
        float rim = smoothstep(0.45, 0.85, sl);
        // the cabin's light caught on the drop's curve (a small highlight up and toward the aisle)
        vec3 dn = normalize(n * sqrt(max(1.0 - sl * sl, 0.0)) - (front > 0.5 ? vec3(0.0, mkRN.y, mkRN.x) : vec3(mkRN.x, mkRN.y, 0.0)));
        float sp = pow(max(dot(reflect(rdC, dn), normalize(vec3(0.0, 0.8, -sign(mkP.z) * 0.6))), 0.0), 40.0);
        vec3 dropC = lens * (1.0 - 0.82 * rim) * 1.08 + vec3(1.0, 0.98, 0.94) * sp * mkLv[1] * 0.35;
        float cov = mkRC * mix(0.35, 1.0, soft);
        col = mix(bg, dropC, cov);
        // a trail: a thin film, a slight wobble of the view
        if (mkRT > 0.0) col = mix(col, textureLod(mkGrab, suv - sdir * 0.004, 4.0).rgb * 0.92, mkRT * 0.35);
        col *= mkTint * mkCineC.w;
      }
      // the cabin mirrored in the inner surface (out of focus: a few rays spread)
      mkDayK = 1.0; mkDayA = vec3(0.0); mkLitK = mkLv[1];
      float F = 0.04 + 0.96 * pow(1.0 - abs(dot(rdC, n)), 5.0);
      vec3 rr = reflect(rdC, n), tt = normalize(cross(rr, vec3(0.0, 1.0, 0.0)) + 1e-4), bb = cross(rr, tt), refl = vec3(0.0);
      for (int k = 0; k < 8; k++) { float a = float(k) * 2.3999632, rr2 = sqrt((float(k) + 0.5) / 8.0) * 0.32; vec3 r2 = normalize(rr + (tt * cos(a) + bb * sin(a)) * rr2);
        refl += (mkCabI.w > 0.5 && ro.x > mkCab.y) ? mkCabRefl(mkP + r2 * 0.01, r2) : mkShellRefl(mkP + r2 * 0.02, r2); }
      col += refl * 0.125 * F * mkCineC.x * mkReflK;
      // (debug views: 1 the out-of-focus outside alone, 2 the rain's coverage, 3 the grabbed frame, 4 the reflection)
      if (mkCineD.y > 0.5) { if (mkCineD.y < 1.5) col = mkBokeh(suv, zg, 1.0); else if (mkCineD.y < 2.5) col = vec3(mkRC, mkRT, 0.0); else if (mkCineD.y < 3.5) col = textureLod(mkGrab, suv, 0.0).rgb; else col = refl * 0.125 * F; }
      gl_FragColor = vec4(col, 1.0);
    }`;
  function cinemaGlass(S) {
    const m = new THREE.MeshPhysicalMaterial({ color: 0x000000, roughness: 0.05, metalness: 0, side: THREE.DoubleSide, transparent: true, depthWrite: true, envMapIntensity: 1.0 });
    m.blending = THREE.NoBlending; m.forceSinglePass = true; m.userData.S = S;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, S, GU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + K.MK_VERT_HEAD)
        .replace('#include <skinning_vertex>', K.MK_VERT_BODY + '\n#include <skinning_vertex>');
      sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_pars_fragment>', '#include <clipping_planes_pars_fragment>' + K.GLASS_FRAG_HEAD + REFL_HEAD + CINE_HEAD)
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n' + CINE_MAIN);
    };
    m.onBeforeRender = (r, scene, cam) => grab(r, cam);
    m.customProgramCacheKey = () => 'mk-glass-cine-1';
    return m;
  }

  // ------------------------------------------------------------------------------------------ look
  const DEF = { bokeh: 0.03, gain: 6, thr: 1.5, lens: 0.12, beads: 0.6, fresh: 0, focus: 0, refl: 1, tint: 1, dbg: 0 };
  let cine = null;
  function applyCine() {
    const c = cine || DEF;
    GU.mkCineA.value.set(c.bokeh, c.gain, c.thr, c.lens); GU.mkCineB.value.x = c.beads; GU.mkCineB.value.y = c.fresh;
    GU.mkCineC.value.x = c.refl; GU.mkCineC.value.y = c.focus; GU.mkCineC.value.w = c.tint; GU.mkCineD.value.y = c.dbg || 0;
  }
  function look(o) {
    if (o === null) { MKG.mkLcdGain.value = 1; MKG.mkReflK.value = 1; K.lookCab = -1; cine = null; applyCine(); return look({}); }
    if (o.lcd !== undefined) MKG.mkLcdGain.value = Math.max(0, +o.lcd || 0);
    if (o.refl !== undefined) MKG.mkReflK.value = Math.max(0, +o.refl || 0);
    if (o.cab !== undefined) { K.lookCab = +o.cab; if (K.live) for (const c of K.live) if (c._applyLights) c._applyLights(); }
    if (o.cinema !== undefined) { cine = o.cinema ? Object.assign({}, DEF, cine || {}, o.cinema) : null; applyCine(); }
    return { lcd: MKG.mkLcdGain.value, refl: MKG.mkReflK.value, cab: K.lookCab === undefined ? -1 : K.lookCab, cinema: cine && Object.assign({}, cine) };
  }
  // per consist update: the car the camera is in (its interior drawn) gets the cinema glass while a cinema look is on
  const _inv = new THREE.Matrix4(), _c = new V3();
  function cineUpdate(consist) {
    let cam = null;
    for (const car of consist.cars) {
      let want = false;
      if (cine && car.intVisible && car.int && car.lod === 0) {
        if (!cam) cam = K.camPos(); if (!cam) break;
        car.root.updateMatrixWorld(); _c.copy(cam).applyMatrix4(_inv.copy(car.root.matrixWorld).invert());
        const d = car.design; want = Math.abs(_c.x) < d.length / 2 && Math.abs(_c.z) < (d.halfW || 1.47) + 0.1 && _c.y > (d.floorY || 1) - 0.3 && _c.y < (d.ceilY || 3.1) + 0.4;
      }
      const mat = want ? (car.matCine || (car.matCine = cinemaGlass(car.S))) : (car.intVisible && car.int ? car.matGlassClear : car.matGlass);
      if (car.glass.material !== mat) { car.glass.material = mat; car.glass.renderOrder = want ? 1e6 : car.intVisible ? 2 : 0; }
      if (want) {                                            // (the car's speed, the time, the focus at the frame centre)
        GU.mkCineB.value.z = car.S.mkSpd.value; GU.mkCineC.value.z = (MKG.mkTimeG && MKG.mkTimeG.value) || 0;
        if (!(cine.focus > 0)) GU.mkCineD.value.x = autoFocus(car);
      }
    }
  }
  // the view distance to the glass at the frame centre: the camera's forward ray against the side glass planes of the
  // car (design z = +-glassZ), else 0.5 m
  const _o = new V3(), _f = new V3();
  function autoFocus(car) {
    const cam = typeof Env !== 'undefined' && Env.camera; if (!cam) return 0.5;
    _inv.copy(car.root.matrixWorld).invert();
    _o.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(_inv);
    _f.set(0, 0, -1).transformDirection(cam.matrixWorld).transformDirection(_inv);
    const gz = glassZ(car.design);
    let best = 0.5;
    if (Math.abs(_f.z) > 1e-3) { const t = ((_f.z > 0 ? gz : -gz) - _o.z) / _f.z; if (t > 0.05 && t < 6) best = t; }
    return best;
  }

  // the side glazing's |z| at window height (from the design's glass mesh, once)
  function glassZ(d) {
    if (d.glassZ !== undefined) return d.glassZ;
    const P = d.glass && d.glass.attributes.position; let z = 0;
    if (P) for (let i = 0; i < P.count; i++) { const y = P.getY(i); if (y > 1.8 && y < 2.6 && Math.abs(P.getX(i)) < 8) z = Math.max(z, Math.abs(P.getZ(i))); }
    return (d.glassZ = z > 0.5 ? z : (d.halfW || 1.47) + 0.05);
  }
  applyCine();
  Object.assign(K, { clearGlass, cinemaGlass, cineUpdate, look, grab, cineUniforms: GU });
})();
