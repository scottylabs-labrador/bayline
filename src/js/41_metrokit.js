// MetroKit — Bayline Metro rolling stock (trains workstream). See notes/bart/trains.md for the API, the research behind
// every dimension, and measured costs.
//   'bart' : "Fleet of the Future"-type D (cab) and E (no cab) cars, 2..10 cars in valid orders.
//   'dmu'  : the Antioch shuttle (Stadler GTW 2/6-like articulated DMU, 42_metrokit_dmu.js).
//   'apm'  : the airport connector (cable-hauled people mover, 42_metrokit_apm.js).
// Car-local frame (same as TrainKit): origin at the car centre on top of rail, +X toward the car's front (the cab end of
// a D car), +Y up, +Z to the right when facing +X. Metres. A flipped car (cab at the consist's rear) is the same design
// rotated 180 degrees inside car.group, and its metadata is already expressed in car.group's frame.
// Rendering: every car is ONE skinned mesh per material (body + running gear + doors + decals + signs in the palette
// material; glass in its own), with bones for the bogies (yaw), wheelsets (spin), door leaves (plug + slide) and wipers.
// Surface detail (brushed aluminium with anisotropic highlights, the paint scheme, seams, grilles, vinyl, floors, LED
// dot matrices, interior lighting) is procedural in one shared program; nothing needs per-car textures except the
// per-consist sign and screen canvases.
const MetroKit = (() => {
  const { clamp, lerp, smooth } = U;
  const V3 = THREE.Vector3;
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------------------------------------ quality
  // 0 low .. 4 max (same scale as ACModel.setQuality). Applies to designs built afterwards (designs are cached per level).
  let Q = 2;
  const QN = { low: 0, medium: 1, high: 2, ultra: 3 };
  function setQuality(level) { const q = typeof level === 'number' ? level : (level in QN ? QN[level] : (level ? 4 : 2)); Q = clamp(Math.round(q), 0, 4); }

  // ------------------------------------------------------------------------------------------ palette
  // Each part's vertices carry uv.x = the palette texel of its material. Channels (4 RGBA8 textures, 256 x 1):
  //   A: albedo (sRGB)                              B: roughness, metalness, clearcoat, pattern id
  //   C: emissive group (0 none, 1..7), emissive weight, anisotropy, grime susceptibility
  //   D: sheen / secondary colour (sRGB, pattern-specific), alpha = interior flag (receives the fake interior lighting)
  const PAT = { none: 0, aluE: 1, aluD: 2, aluDoor: 3, paint: 4, roof: 5, rubber: 6, grille: 7, louver: 8, tread: 9, floor: 10,
    vinyl: 11, fabric: 12, plastic: 13, cast: 14, wheel: 15, coil: 16, lens: 17, led: 18, lcd: 19, decal: 20, topbar: 21, pole: 22,
    wall: 23, ceil: 24, mask: 25, glow: 26, aluDmu: 27, paintDmu: 28, apmBody: 29, num: 30, lodwin: 31 };
  // emissive light groups (per-car levels in mkLv[8])
  const G = { none: 0, interior: 1, head: 2, tail: 3, marker: 4, bar: 5, doorR: 6, sign: 7, doorL: 8, cab: 9, idoorR: 10, idoorL: 11 };
  const NLV = 12;
  const PAL = [], PI = Object.create(null), PALN = 256;
  function pal(name, hex, rough, metal, o = {}) {
    PI[name] = PAL.length;
    PAL.push({ hex, rough, metal, cc: o.cc || 0, pat: o.pat || 0, eg: o.eg || 0, ew: o.ew === undefined ? (o.eg ? 1 : 0) : o.ew,
      an: o.an || 0, gr: o.gr === undefined ? 0.5 : o.gr, sec: o.sec || null, inside: !!o.inside });
  }
  // --- exterior
  pal('aluE', '#dde0e3', 0.34, 0.88, { pat: PAT.aluE, an: 0.7, gr: 0.8 });          // brushed aluminium body, E-car scheme
  pal('aluD', '#dde0e3', 0.34, 0.88, { pat: PAT.aluD, an: 0.7, gr: 0.8 });          // D-car scheme (cab swoosh)
  pal('aluDoor', '#dfe2e5', 0.32, 0.88, { pat: PAT.aluDoor, an: 0.7, gr: 0.7 });
  pal('aluDull', '#a7abaf', 0.42, 0.9, { an: 0.4, gr: 1 });
  pal('cap', '#eceeec', 0.26, 0, { cc: 1, pat: PAT.paint, gr: 0.55 });             // white fibreglass cab cap
  pal('capSide', '#eceeec', 0.26, 0, { cc: 1, pat: PAT.paint, gr: 0.6 });
  pal('blue', '#1a9ade', 0.3, 0, { cc: 1, pat: PAT.paint, gr: 0.5 });              // Bayline Metro blue
  pal('blueDk', '#15659e', 0.34, 0, { cc: 0.8, pat: PAT.paint, gr: 0.8 });
  pal('roof', '#e2e4e1', 0.46, 0.05, { cc: 0.3, pat: PAT.roof, gr: 1 });
  pal('mask', '#050607', 0.05, 0.1, { cc: 1, pat: PAT.mask, gr: 0.2 });           // black glazed mask of the cab front
  pal('rubber', '#15171a', 0.82, 0, { pat: PAT.rubber, gr: 0.4 });
  pal('seam', '#1a1c1f', 0.6, 0.2, { gr: 0.3 });
  pal('frame', '#2a2d31', 0.62, 0.35, { pat: PAT.cast, gr: 1 });                  // underframe, bogie frames
  pal('frameLt', '#474b52', 0.55, 0.4, { pat: PAT.cast, gr: 1 });
  pal('equip', '#3b3f45', 0.58, 0.3, { pat: PAT.cast, gr: 1 });                   // underfloor equipment cases
  pal('steel', '#8d9298', 0.34, 0.9, { an: 0.3, gr: 0.8 });
  pal('wheel', '#6f6a64', 0.38, 0.9, { pat: PAT.wheel, gr: 1 });
  pal('coil', '#353940', 0.5, 0.5, { pat: PAT.coil, gr: 1 });
  pal('beam', '#34332f', 0.7, 0.05, { gr: 1 });                                   // fibreglass shoe beam
  pal('shoe', '#5a5853', 0.45, 0.85, { gr: 1 });
  pal('copper', '#b87840', 0.32, 1, { gr: 0.4 });
  pal('yellow', '#e2b01c', 0.45, 0, { cc: 0.5, gr: 0.6 });
  pal('orange', '#e5661c', 0.4, 0, { cc: 0.6, gr: 0.5 });
  pal('coupler', '#6a6e72', 0.55, 0.15, { pat: PAT.cast, gr: 1 });
  pal('bumper', '#4b4f54', 0.5, 0.05, { cc: 0.3, pat: PAT.plastic, gr: 0.8 });
  pal('tread', '#a2a6aa', 0.35, 1, { pat: PAT.tread, gr: 0.9 });
  pal('grille', '#5e6268', 0.45, 0.8, { pat: PAT.grille, gr: 0.8 });
  pal('louver', '#3a3e44', 0.55, 0.5, { pat: PAT.louver, gr: 1 });
  pal('podBlack', '#0c0e10', 0.16, 0.2, { cc: 1, gr: 0.3 });
  pal('reflector', '#e2e6ea', 0.06, 1, { eg: G.head, ew: 0.08 });
  pal('headLamp', '#fbf8ef', 0.05, 0, { cc: 1, pat: PAT.lens, eg: G.head });
  pal('tailLamp', '#d0121c', 0.08, 0, { cc: 1, pat: PAT.lens, eg: G.tail });
  pal('markerLamp', '#f4f1e8', 0.08, 0, { cc: 1, pat: PAT.lens, eg: G.marker });
  pal('topBar', '#1a1614', 0.1, 0, { cc: 1, pat: PAT.topbar, eg: G.bar });
  pal('doorLampR', '#d8141e', 0.1, 0, { cc: 1, eg: G.doorR, ew: 2 });
  pal('doorLampL', '#d8141e', 0.1, 0, { cc: 1, eg: G.doorL, ew: 2 });
  pal('lensClear', '#dfe3e6', 0.04, 0, { cc: 1 });
  pal('chrome', '#dde1e5', 0.1, 1, { gr: 0.4 });
  pal('ledSign', '#000000', 0.2, 0, { cc: 1, pat: PAT.led, eg: G.sign });          // LED dot-matrix (sign canvas via uv1)
  pal('decal', '#ffffff', 0.3, 0, { cc: 1, pat: PAT.decal, gr: 0.5 });           // atlas decal (uv1), alpha-tested
  pal('numW', '#ffffff', 0.3, 0, { cc: 1, pat: PAT.num, sec: '#ffffff', gr: 0.5 });              // car-number glyphs (uv1 = slot + u, v)
  pal('numK', '#16181b', 0.4, 0, { cc: 0.3, pat: PAT.num, gr: 0.8 });
  pal('camDome', '#101214', 0.05, 0.2, { cc: 1 });
  pal('wiper', '#141517', 0.55, 0.3, { gr: 0.5 });
  pal('lodWin', '#141b1f', 0.08, 0.1, { cc: 1, pat: PAT.lodwin, eg: G.interior, ew: 0.9, gr: 0.2 });
  pal('glowDummy', '#000000', 1, 0, {});
  // --- interior (inside = receives the fake interior lighting, dimmed sky light)
  const IN = { inside: true };
  pal('wallInt', '#e4e3de', 0.55, 0, { ...IN, pat: PAT.wall, gr: 0.2 });
  pal('wallInt2', '#d3d3cf', 0.5, 0, { ...IN, pat: PAT.plastic, gr: 0.2 });
  pal('lime', '#b8c43a', 0.5, 0, { ...IN, pat: PAT.plastic, gr: 0.15 });
  pal('ceil', '#e8e8e4', 0.6, 0, { ...IN, pat: PAT.ceil, gr: 0.1 });
  pal('lightStrip', '#fffdf5', 0.3, 0, { ...IN, eg: G.interior, ew: 3.2 });
  pal('floor', '#56595d', 0.72, 0, { ...IN, pat: PAT.floor, gr: 0.5 });
  pal('floorDecal', '#e9eaea', 0.6, 0, { ...IN, pat: PAT.floor, gr: 0.4 });
  pal('seatBlue', '#1b679d', 0.42, 0, { ...IN, cc: 0.35, pat: PAT.vinyl, gr: 0.3 });
  pal('seatLime', '#b3bf1c', 0.42, 0, { ...IN, cc: 0.35, pat: PAT.vinyl, gr: 0.3 });
  pal('seatShell', '#c9ccce', 0.38, 0, { ...IN, cc: 0.4, pat: PAT.plastic, gr: 0.25 });
  pal('seatFrame', '#9ea3a8', 0.32, 0.9, { ...IN, an: 0.3, gr: 0.3 });
  pal('pole', '#c6cacf', 0.2, 1, { ...IN, pat: PAT.pole, an: 0.8, gr: 0.2 });
  pal('poleYellow', '#e8c21e', 0.4, 0, { ...IN, cc: 0.6, gr: 0.3 });
  pal('strap', '#18191b', 0.72, 0, { ...IN, pat: PAT.rubber, gr: 0.2 });
  pal('bezel', '#1a1c1f', 0.35, 0.2, { ...IN, cc: 0.5, gr: 0.2 });
  pal('lcd', '#000000', 0.08, 0, { ...IN, cc: 1, pat: PAT.lcd, eg: G.sign });
  pal('ledInt', '#000000', 0.2, 0, { ...IN, cc: 1, pat: PAT.led, eg: G.sign });
  pal('decalInt', '#ffffff', 0.35, 0, { ...IN, cc: 0.5, pat: PAT.decal, gr: 0.2 });
  pal('redInt', '#c8202a', 0.4, 0, { ...IN, cc: 0.4 });
  pal('blackInt', '#141517', 0.5, 0.1, { ...IN, gr: 0.2 });
  pal('grilleInt', '#b9bcbf', 0.45, 0.6, { ...IN, pat: PAT.grille, gr: 0.2 });
  pal('rubberInt', '#1c1e20', 0.8, 0, { ...IN, pat: PAT.rubber, gr: 0.3 });
  pal('treadInt', '#a4a8ac', 0.35, 1, { ...IN, pat: PAT.tread, gr: 0.5 });
  pal('yellowInt', '#e4b41c', 0.45, 0, { ...IN, cc: 0.4, gr: 0.3 });
  pal('lampIntR', '#ff2a2a', 0.2, 0, { ...IN, eg: G.idoorR, ew: 2 });
  pal('lampIntL', '#ff2a2a', 0.2, 0, { ...IN, eg: G.idoorL, ew: 2 });
  // cab
  pal('console', '#cfd2d4', 0.45, 0, { ...IN, cc: 0.3, pat: PAT.plastic, gr: 0.2 });
  pal('consoleDk', '#44484e', 0.5, 0.1, { ...IN, pat: PAT.plastic, gr: 0.2 });
  pal('brushed', '#b4b8bc', 0.3, 1, { ...IN, an: 0.8, gr: 0.2 });
  pal('cabSeat', '#1b2336', 0.9, 0, { ...IN, pat: PAT.fabric, sec: '#c9cdd6', gr: 0.2 });
  pal('keyGreen', '#1f8a45', 0.35, 0, { ...IN, cc: 0.6, eg: G.sign, ew: 0.25 });
  pal('keyRed', '#c2242a', 0.35, 0, { ...IN, cc: 0.6, eg: G.sign, ew: 0.25 });
  pal('keyAmber', '#e0a01e', 0.35, 0, { ...IN, cc: 0.6, eg: G.sign, ew: 0.25 });
  pal('mushroom', '#d51f26', 0.3, 0, { ...IN, cc: 0.8 });
  pal('handleBlack', '#111214', 0.4, 0.1, { ...IN, cc: 0.5 });
  pal('screenOff', '#060708', 0.08, 0, { ...IN, cc: 1 });
  // DMU / APM schemes (their own pattern ids)
  pal('aluDmu', '#d9dcdf', 0.36, 0.75, { pat: PAT.aluDmu, an: 0.4, gr: 0.8 });
  pal('moduleGrey', '#aeb3b8', 0.45, 0.5, { pat: PAT.cast, gr: 0.9 });
  pal('paintDmu', '#e6e8e8', 0.3, 0, { cc: 1, pat: PAT.paintDmu, gr: 0.7 });
  pal('apmBody', '#e9ebeb', 0.3, 0, { cc: 1, pat: PAT.apmBody, gr: 0.5 });
  if (PAL.length > PALN) throw new Error('MetroKit palette overflow');
  const palU = name => { const i = PI[name]; if (i === undefined) throw new Error('MetroKit: unknown palette entry ' + name); return (i + 0.5) / PALN; };

  let palTexs = null;
  function palTextures() {
    if (palTexs) return palTexs;
    const hex = (h, d, o) => { const v = parseInt(h.slice(1), 16); d[o] = v >> 16; d[o + 1] = (v >> 8) & 255; d[o + 2] = v & 255; };
    const mk = (fill, cs) => {
      const d = new Uint8Array(PALN * 4); PAL.forEach((p, i) => fill(p, d, i * 4));
      const t = new THREE.DataTexture(d, PALN, 1); t.colorSpace = cs; t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false; t.needsUpdate = true; return t;
    };
    const b = v => Math.round(clamp(v, 0, 1) * 255);
    palTexs = {
      A: mk((p, d, o) => { hex(p.hex, d, o); d[o + 3] = 255; }, THREE.SRGBColorSpace),
      B: mk((p, d, o) => { d[o] = b(p.rough); d[o + 1] = b(p.metal); d[o + 2] = b(p.cc); d[o + 3] = p.pat; }, THREE.NoColorSpace),
      C: mk((p, d, o) => { d[o] = p.eg; d[o + 1] = b(p.ew / 4); d[o + 2] = b(p.an); d[o + 3] = b(p.gr); }, THREE.NoColorSpace),
      D: mk((p, d, o) => { if (p.sec) hex(p.sec, d, o); d[o + 3] = p.inside ? 255 : 0; }, THREE.SRGBColorSpace),
    };
    return palTexs;
  }

  // ------------------------------------------------------------------------------------------ shared uniforms
  // Per-car uniforms live in small objects shared by that car's materials (S): lamp levels, night, age/grime, flags.
  // Per-consist textures (sign canvas, screens canvas) are uniforms too (T).
  function carUniforms() {
    return {
      mkLv: { value: new Float32Array(NLV) },             // light group levels (index = G.*)
      mkNight: { value: 0 },
      mkAge: { value: 0.3 },                               // 0 new .. 1 old and grimy
      mkSeed: { value: 0 },
      mkBar: { value: 0 },                                 // top light bar colour: 0 amber (lead), 1 red (trail)
      mkIndoor: { value: new THREE.Vector4(0.28, 0.35, 0, 0) },   // interior: sky-light scale, IBL scale
      mkSign: { value: null }, mkSignRes: { value: new THREE.Vector2(256, 64) },
      mkLcd: { value: null },
      mkAtlas: { value: null },
      mkNum: { value: new Float32Array(6) },               // car-number glyph indices (per car)
      mkHalfW: { value: 1.47 },                            // interior half width (fake lighting, AO)
      mkFloorY: { value: 0.991 },
      mkCeilY: { value: 3.15 },
      mkLamp: { value: new THREE.Vector4(0.83, 3.04, 9.8, 0) },   // interior light strips: |z|, y, half length along x
    };
  }

  // ------------------------------------------------------------------------------------------ the shader
  const MK_VERT_HEAD = `
    attribute vec2 mkt1;
    varying vec3 mkP; varying vec3 mkN; varying vec2 mkUv; varying vec2 mkUv1; varying vec3 mkAx; varying vec3 mkAy; varying vec3 mkAz;`;
  const MK_VERT_BODY = `
    mkP = transformed; mkN = objectNormal; mkUv = uv; mkUv1 = mkt1;
    { mat3 mkM = mat3(1.0);
      #ifdef USE_SKINNING
        mkM = mat3(skinMatrix);
      #endif
      #ifdef USE_INSTANCING
        mkM = mat3(instanceMatrix) * mkM;
      #endif
      mkAx = normalize(normalMatrix * (mkM * vec3(1.0, 0.0, 0.0))); mkAy = normalize(normalMatrix * (mkM * vec3(0.0, 1.0, 0.0)));
      mkAz = normalize(normalMatrix * (mkM * vec3(0.0, 0.0, 1.0))); }`;
  const MK_FRAG_HEAD = `
    uniform sampler2D mkPalA, mkPalB, mkPalC, mkPalD;
    uniform float mkLv[12]; uniform float mkNight, mkAge, mkSeed, mkBar, mkHalfW, mkFloorY, mkCeilY;
    uniform vec4 mkIndoor, mkLamp;
    uniform sampler2D mkSign, mkLcd, mkAtlas; uniform vec2 mkSignRes; uniform float mkNum[6];
    varying vec3 mkP; varying vec3 mkN; varying vec2 mkUv; varying vec2 mkUv1; varying vec3 mkAx; varying vec3 mkAy; varying vec3 mkAz;
    float mkRough, mkMetal, mkCC, mkCCR, mkAniso, mkPat, mkGrime, mkInside, mkEmW; vec3 mkEm; vec3 mkBump; vec3 mkAlb;
    float mkH(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    float mkV(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mkH(i), mkH(i + vec2(1.0, 0.0)), f.x), mix(mkH(i + vec2(0.0, 1.0)), mkH(i + vec2(1.0, 1.0)), f.x), f.y); }
    float mkF(vec2 p) { return 0.5 * mkV(p) + 0.25 * mkV(p * 2.07 + 7.1) + 0.125 * mkV(p * 4.11 + 3.3) + 0.0625 * mkV(p * 8.3 + 1.7); }
    // a groove profile: 1 at the centre of a line of width w at position c (anti-aliased by the pixel footprint fw)
    float mkLine(float x, float c, float w, float fw) { return 1.0 - smoothstep(w * 0.5, w * 0.5 + fw, abs(x - c)); }
    float mkRep(float x, float period, float w, float fw) { float d = abs(fract(x / period + 0.5) - 0.5) * period; return 1.0 - smoothstep(w * 0.5, w * 0.5 + fw, d); }
    float mkBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
    // BART-like scheme on the aluminium body: blue swoosh on the cab sides (D), blue end bands (both E ends, the D rear),
    // white pin stripe behind the swoosh, the dark belt line; returns 0 alu, 1 blue, 2 white; belt in mkBelt
    float mkBelt;
    float mkScheme(vec3 p, float isD, float fw) {
      float x = p.x, y = p.y, ax = abs(x);
      mkBelt = mkLine(y, 1.675, 0.028, fw);
      float r = 0.0;
      // end bands (E both ends; D only at -X): blue from |x| ~ 9.6 out, the inner edge bowing in a little at mid-height
      float bandEdge = 9.6 - 0.05 * sin(3.14159 * clamp((y - 0.62) / 2.4, 0.0, 1.0));
      if ((isD < 0.5 || x < 0.0) && ax > bandEdge) r = 1.0;
      if (isD > 0.5 && x > 0.0) {
        // the cab swoosh: blue from the cab back to a curve that sweeps forward toward the bottom (8.83 at the eaves,
        // 9.70 at the skirt), a white band behind it that tapers from 0.58 m at the top to 0.08 m at the bottom
        float t = clamp((3.0 - y) / 2.38, 0.0, 1.0);
        float xb = 8.83 + 0.87 * pow(t, 2.4), wb = 0.08 + 0.5 * pow(1.0 - t, 1.6);
        float blueA = smoothstep(-fw, fw, x - xb), whiteA = smoothstep(-fw, fw, x - (xb - wb)) * (1.0 - blueA);
        r = blueA > 0.5 ? 1.0 : (whiteA > 0.5 ? 2.0 : r);
      }
      return r;
    }
    // interior light: two long LED strips in the sloped ceiling (|z| = mkLamp.x, y = mkLamp.y, |x| < mkLamp.z) + bounce
    // two long LED line lights in the ceiling coves (|z| = mkLamp.x, y = mkLamp.y, |x| < mkLamp.z): irradiance from a
    // line source falls off as 1/d; plus the multi-bounce fill of a white cabin (floor bounce lights the ceiling)
    float mkIntLight(vec3 p, vec3 n) {
      float e = 0.0;
      for (int k = 0; k < 2; k++) {
        vec3 L = vec3(0.0, mkLamp.y, k == 0 ? mkLamp.x : -mkLamp.x) - vec3(0.0, p.y, p.z);
        float d = length(L) + 0.08; L /= d;
        float along = smoothstep(mkLamp.z + 0.8, mkLamp.z - 0.8, abs(p.x));
        e += max(dot(n, L), 0.0) * along * 0.42 / d;
      }
      float fill = 0.34 + 0.1 * n.y + 0.2 * max(-n.y, 0.0);
      return e + fill;
    }
    // height field of a pattern (metres) for bump normals
    float mkHt(vec3 p, float pat) {
      if (pat == 1.0 || pat == 2.0 || pat == 3.0) {
        float h = -0.0012 * mkLine(p.y, 1.675, 0.028, 0.004);                               // belt groove
        h += 0.00035 * (mkV(vec2(p.x * 0.9, p.y * 2.2)) - 0.5);                              // oil-canning
        return h;
      }
      if (pat == 5.0) return -0.0018 * mkRep(mkUv.y, 0.105, 0.012, 0.004);                   // roof ribs (arc length)
      if (pat == 7.0) { vec2 q = fract(p.xy * 110.0 + vec2(p.z * 110.0, 0.0)) - 0.5; return -0.0008 * (1.0 - smoothstep(0.22, 0.32, length(q))); }
      if (pat == 8.0) { float l = fract(p.y * 16.0); return 0.004 * (smoothstep(0.0, 0.5, l) - smoothstep(0.5, 1.0, l)); }
      if (pat == 9.0) { vec2 q = p.xz * 9.0; vec2 f = fract(q + vec2(floor(q.y) * 0.5, 0.0)) - 0.5; return 0.0012 * (1.0 - smoothstep(0.08, 0.22, abs(f.x * 0.6 + f.y * 0.9))); }
      if (pat == 11.0) return 0.0004 * mkV(p.xz * 60.0 + p.y * 40.0) - 0.0016 * mkLine(fract(p.y * 4.0), 0.5, 0.03, 0.02);
      if (pat == 12.0) return 0.0005 * sin(p.x * 400.0 + p.y * 400.0);
      if (pat == 13.0) return 0.0002 * mkH(floor((p.xy + p.zz) * 700.0));
      if (pat == 16.0) return 0.006 * sin(fract(p.y * 13.0) * 3.14159);
      if (pat == 23.0) return -0.0008 * mkRep(p.x, 1.215, 0.004, 0.002);
      if (pat == 24.0) return -0.0008 * mkRep(p.x, 0.61, 0.004, 0.002);
      if (pat == 27.0 || pat == 28.0) return -0.001 * mkRep(p.x, 1.6, 0.004, 0.002);
      return 0.0;
    }`;
  const MK_FRAG_COLOR = `
    {
      vec4 pa = texture2D(mkPalA, vec2(mkUv.x, 0.5)), pb = texture2D(mkPalB, vec2(mkUv.x, 0.5));
      vec4 pc = texture2D(mkPalC, vec2(mkUv.x, 0.5)), pd = texture2D(mkPalD, vec2(mkUv.x, 0.5));
      vec3 p = mkP; float fw = length(fwidth(p)) + 1e-5;
      vec3 col = pa.rgb; mkRough = pb.r; mkMetal = pb.g; mkCC = pb.b; mkCCR = 0.04; mkPat = floor(pb.a * 255.0 + 0.5);
      mkAniso = pc.b; mkInside = pd.a; mkEm = vec3(0.0); mkBump = vec3(0.0); mkGrime = 0.0;
      float eg = floor(pc.r * 255.0 + 0.5); mkEmW = pc.g * 4.0;
      float fade = 1.0 - smoothstep(0.004, 0.03, fw);          // fine detail fades before it aliases
      // ---------------- patterns (colour, roughness, metalness)
      if (mkPat >= 1.0 && mkPat <= 3.0) {                       // brushed aluminium body / doors
        float isD = mkPat == 2.0 ? 1.0 : 0.0;
        float sch = mkPat == 3.0 ? 0.0 : mkScheme(p, isD, fw);
        if (mkPat == 3.0) mkBelt = mkLine(p.y, 1.675, 0.028, fw);
        float st = mkV(vec2(p.x * 2.1 + p.z * 0.3, p.y * 260.0)) * 0.6 + mkV(vec2(p.x * 0.35, p.y * 37.0)) * 0.4;
        col *= 0.93 + 0.13 * mix(0.5, st, fade);
        col *= 0.96 + 0.07 * mkV(vec2(p.x * 0.23, p.y * 0.9) + mkSeed);          // sheet-to-sheet tone
        mkRough += (st - 0.5) * 0.12 * fade;
        if (sch > 0.5) {                                        // painted: non-metallic, clearcoated
          col = sch < 1.5 ? vec3(0.008, 0.33, 0.72) : vec3(0.86, 0.87, 0.87);
          mkMetal = 0.0; mkRough = 0.3; mkCC = 1.0; mkAniso = 0.0;
        }
        col = mix(col, vec3(0.03, 0.035, 0.04), mkBelt * 0.92);
        mkRough = mix(mkRough, 0.6, mkBelt); mkMetal = mix(mkMetal, 0.2, mkBelt); mkAniso *= 1.0 - mkBelt;
      } else if (mkPat == 4.0 || mkPat == 25.0 || mkPat == 28.0) {    // paint / gloss black: orange peel
        col *= 0.985 + 0.03 * mkV(p.xy * 31.0 + p.z * 23.0);
        mkCCR = 0.03 + 0.03 * mkV(p.zy * 13.0);
      } else if (mkPat == 5.0) {                                 // roof: white paint with ribs and dirt
        col *= 0.9 + 0.1 * mkF(p.xz * 0.7 + 3.0);
        col *= 1.0 - 0.25 * mkRep(mkUv.y, 0.105, 0.012, fw) * fade;
      } else if (mkPat == 6.0) {                                 // rubber
        col *= 0.9 + 0.2 * mkV(p.xy * 90.0 + p.z * 70.0) * fade;
      } else if (mkPat == 7.0) {                                 // perforated grille
        vec2 q = fract(p.xy * 110.0 + vec2(p.z * 110.0, 0.0)) - 0.5; float hole = 1.0 - smoothstep(0.22, 0.32, length(q));
        col *= mix(1.0, mix(0.08, 1.0, 1.0 - hole), fade); col *= mix(1.0, 0.45, 1.0 - fade);
      } else if (mkPat == 8.0) {                                 // louvers
        float l = fract(p.y * 16.0); col *= mix(0.55, 0.35 + 0.65 * smoothstep(0.05, 0.4, l) * smoothstep(1.0, 0.7, l), fade);
      } else if (mkPat == 9.0) {                                 // tread plate
        vec2 q = p.xz * 9.0; vec2 f = fract(q + vec2(floor(q.y) * 0.5, 0.0)) - 0.5;
        float ridge = 1.0 - smoothstep(0.08, 0.22, abs(f.x * 0.6 + f.y * 0.9)); col *= 0.85 + 0.25 * ridge * fade; mkRough -= 0.1 * ridge;
      } else if (mkPat == 10.0) {                                // speckled resilient floor (Marmoleum)
        float s1 = mkH(floor(p.xz * 190.0)), s2 = mkF(p.xz * 2.3);
        col *= 0.9 + 0.12 * s2; col = mix(col, vec3(0.5, 0.5, 0.49), step(0.955, s1) * 0.35 * fade);
        col = mix(col, vec3(0.14), step(s1, 0.04) * 0.35 * fade);
        mkRough -= 0.15 * smoothstep(0.4, 0.9, mkF(p.xz * 0.6 + 5.0));       // scuffed wear path glosses
      } else if (mkPat == 11.0) {                                // vinyl upholstery: grain + stitch lines
        col *= 0.93 + 0.1 * mkV(p.xz * 60.0 + p.y * 40.0) * fade;
        float stitch = mkLine(fract(p.y * 4.0), 0.5, 0.03, 0.02) * fade; col *= 1.0 - 0.3 * stitch;
        mkRough += 0.08 * mkV(p.xy * 11.0);
      } else if (mkPat == 12.0) {                                // cab seat: navy fabric with light pinstripes
        float pin = mkRep(p.x * 0.8 + p.y * 1.2 + p.z * 0.4, 0.035, 0.003, 0.002) * step(0.35, fract((p.y + p.x) * 9.0));
        col = mix(col, pd.rgb, pin * 0.55 * fade);
      } else if (mkPat == 13.0) {                                // textured plastic
        col *= 0.96 + 0.06 * mkH(floor((p.xy + p.zz) * 700.0)) * fade;
      } else if (mkPat == 14.0) {                                // cast / painted steel with grime
        col *= 0.85 + 0.3 * mkF(p.xy * 3.0 + p.z * 5.0);
      } else if (mkPat == 15.0) {                                // wheel: polished tread, rusty faces
        float tread = 1.0 - smoothstep(0.35, 0.65, abs(mkN.z));
        col = mix(col * vec3(0.95, 0.85, 0.75), vec3(0.72, 0.72, 0.74), tread); mkRough = mix(0.6, 0.18, tread); mkMetal = mix(0.5, 1.0, tread);
      } else if (mkPat == 16.0) {                                // coil spring
        col *= 0.35 + 0.65 * sin(fract(p.y * 13.0) * 3.14159);
      } else if (mkPat == 17.0) {                                // lamp lens: honeycomb LED cluster pattern in the emission
        vec2 q = (mkUv1 - 0.5) * 2.0; float r = length(q);
        float cells = 0.0;
        for (int i = 0; i < 7; i++) { float a = float(i) * 1.0472; vec2 c = i == 0 ? vec2(0.0) : vec2(cos(a), sin(a)) * 0.56;
          cells = max(cells, 1.0 - smoothstep(0.17, 0.26, length(q - c))); }
        mkEmW *= mix(0.35, 1.25, cells) * (1.0 - smoothstep(0.92, 1.0, r));
        col = mix(col * 0.85, col, cells);
      } else if (mkPat == 18.0) {                                // LED dot-matrix sign (sign canvas, uv1)
        vec2 cellUv = mkUv1 * mkSignRes; vec2 cid = floor(cellUv) + 0.5; vec2 f = fract(cellUv) - 0.5;
        vec3 led = texture2D(mkSign, cid / mkSignRes).rgb;
        float cell = fwidth(cellUv.x); float dot1 = 1.0 - smoothstep(0.26, 0.36 + cell, length(f));
        float near = 1.0 - smoothstep(0.35, 0.9, cell);                               // dots resolve up close, average far away
        vec3 e = led * mix(0.62, dot1 * 1.5, near);
        col = vec3(0.012) + led * 0.06; mkEm = e * 2.4; eg = 0.0;
      } else if (mkPat == 19.0) {                                // LCD screen (screen canvas, uv1): pixel grid up close
        vec3 s = texture2D(mkLcd, mkUv1).rgb;
        col = vec3(0.01); mkEm = s * 1.6; eg = 0.0;
      } else if (mkPat == 20.0) {                                // atlas decal (uv1, alpha tested)
        vec4 d = texture2D(mkAtlas, mkUv1);
        if (d.a < 0.5) discard;
        col = d.rgb; mkMetal = 0.0;
      } else if (mkPat == 30.0) {                                // car-number glyph: slot = floor(uv1.x), digit from mkNum
        float slot = floor(mkUv1.x), lu = fract(mkUv1.x); int si = int(slot);
        float dg = si == 0 ? mkNum[0] : si == 1 ? mkNum[1] : si == 2 ? mkNum[2] : si == 3 ? mkNum[3] : si == 4 ? mkNum[4] : mkNum[5];
        float row = pd.r > 0.5 ? 256.0 : 400.0;                  // white glyphs (secondary colour white) or black
        vec2 auv = vec2((dg * 96.0 + 2.0 + lu * 92.0) / 2048.0, 1.0 - (row + 2.0 + (1.0 - mkUv1.y) * 140.0) / 2048.0);
        vec4 d = texture2D(mkAtlas, auv);
        if (d.a < 0.5 || dg > 13.5) discard;
        col = d.rgb; mkMetal = 0.0;
      } else if (mkPat == 21.0) {                                // top light bar: LED segments, amber (lead) or red (trail)
        float seg = mkRep(p.z, 0.05, 0.034, fw);
        vec3 c = mix(vec3(1.0, 0.45, 0.04), vec3(1.0, 0.03, 0.02), mkBar);
        mkEm = c * seg * mkLv[5] * 3.0; col = mix(col, c * 0.25, seg * 0.6); eg = 0.0;
      } else if (mkPat == 22.0) {                                // stainless pole
        col *= 0.95 + 0.08 * mkV(vec2(atan(mkN.z, mkN.x) * 3.0, p.y * 180.0)) * fade;
      } else if (mkPat == 23.0) {                                // interior wall panels
        col *= 1.0 - 0.2 * mkRep(p.x, 1.215, 0.004, fw) * fade;
      } else if (mkPat == 24.0) {                                // ceiling panels
        col *= 1.0 - 0.18 * mkRep(p.x, 0.61, 0.004, fw) * fade;
      } else if (mkPat == 31.0) {                                // far-LOD window: lit cabin impression (ceiling glow, seat backs)
        float yy = fract((p.y - 1.89) / 0.95), sb = step(yy, 0.35) * step(0.1, fract(p.x / 0.755 + 0.3));
        mkEmW *= (0.35 + 0.65 * smoothstep(0.55, 1.0, yy)) * (1.0 - 0.6 * sb);
        mkEmW *= 0.25 + 0.75 * mkNight;
      } else if (mkPat == 27.0) {                                // DMU body: satin silver, the cab swoosh at both ends
        col *= 0.95 + 0.07 * mkV(vec2(p.x * 1.3, p.y * 60.0)) * fade;
        float ax = abs(p.x), t = clamp((3.0 - p.y) / 2.6, 0.0, 1.0);
        float xb = 16.95 + 1.9 * pow(t, 1.7), wb = 0.06 + 0.42 * pow(1.0 - t, 1.5);
        float blueA = smoothstep(-fw, fw, ax - xb), whiteA = smoothstep(-fw, fw, ax - (xb - wb)) * (1.0 - blueA);
        if (blueA > 0.5) { col = vec3(0.008, 0.33, 0.72); mkMetal = 0.0; mkRough = 0.3; mkCC = 1.0; mkAniso = 0.0; }
        else if (whiteA > 0.5) { col = vec3(0.86, 0.87, 0.87); mkMetal = 0.0; mkRough = 0.3; mkCC = 1.0; mkAniso = 0.0; }
        mkBelt = mkLine(p.y, 1.2, 0.025, fw); col = mix(col, vec3(0.05), mkBelt * 0.8);
      } else if (mkPat == 29.0) {                                // APM body: white, five light-blue stripes low on the side
        float yy = p.y - 0.62, band = step(0.0, yy) * step(yy, 0.62), st = step(0.5, fract(yy / 0.124));
        col = mix(col, vec3(0.13, 0.46, 0.78), band * st);
        col *= 0.985 + 0.03 * mkV(p.xy * 31.0 + p.z * 23.0);
      }
      // ---------------- emissive light groups
      if (eg > 0.5) {
        float lv = mkLv[int(eg)];
        mkEm += col * lv * mkEmW;
      }
      // ---------------- weathering by car age: dust low down, streaks under windows, grime on up-facing surfaces
      float gs = pc.a * (0.25 + 0.95 * mkAge);
      if (gs > 0.001 && mkInside < 0.5) {
        float y = p.y;
        #ifdef USE_SKINNING
          y = min(y, 1.4);
        #endif
        float blot = mkF(p.xz * 0.9 + vec2(p.y * 0.6, mkSeed));
        float low = smoothstep(1.35, 0.25, y);
        float streak = smoothstep(0.62, 0.95, mkV(vec2(p.x * 3.1 + p.z * 1.7 + mkSeed, p.y * 0.22))) * smoothstep(3.0, 1.6, y) * step(0.8, y);
        float up = smoothstep(0.55, 0.95, mkN.y);
        mkGrime = gs * clamp(0.1 * blot + 0.55 * low * (0.45 + 0.55 * blot) + 0.22 * streak + 0.3 * up * blot, 0.0, 0.85);
        vec3 dirt = mix(vec3(0.20, 0.18, 0.16), vec3(0.25, 0.16, 0.10), smoothstep(1.0, 0.3, y));
        col = mix(col, dirt * (0.55 + 0.9 * dot(col, vec3(0.333))), mkGrime);
        mkRough += mkGrime * 0.35; mkMetal -= mkGrime * 0.5; mkCC *= 1.0 - mkGrime * 0.8; mkAniso *= 1.0 - mkGrime;
      }
      // ---------------- bump from the pattern's height field (object space -> view space)
      if (mkPat > 0.5 && mkPat != 18.0 && mkPat != 19.0 && mkPat != 20.0 && mkPat != 30.0 && fw < 0.03) {
        float e = max(0.0008, fw * 0.5), h0 = mkHt(p, mkPat);
        vec3 g = vec3(mkHt(p + vec3(e, 0.0, 0.0), mkPat) - h0, mkHt(p + vec3(0.0, e, 0.0), mkPat) - h0, mkHt(p + vec3(0.0, 0.0, e), mkPat) - h0) / e;
        g *= 1.0 - smoothstep(0.004, 0.03, fw);
        mkBump = g.x * mkAx + g.y * mkAy + g.z * mkAz;
      }
      // ---------------- the fake interior light (only for interior parts): emissive = albedo x irradiance of the strips
      if (mkInside > 0.5) {
        float il = mkIntLight(p, normalize(mkN));
        // contact shadow near the floor and in the wall corners
        float ao = 1.0 - 0.3 * exp(-max(p.y - mkFloorY, 0.0) * 7.0) * step(p.y, mkFloorY + 0.6);
        ao *= 1.0 - 0.18 * smoothstep(0.25, 0.0, mkHalfW - abs(p.z));
        mkEm += col * il * mkLv[1] * ao;
      }
      mkAlb = col;
      diffuseColor.rgb = col;
    }`;
  // One material per car and variant: 'ext' (clearcoat + anisotropy, skinned), 'int' (interior, skinned), 'lod' (plain).
  let _tmpl = null;
  function palMaterial(variant, S) {
    const t = palTextures();
    const P = { roughness: 1, metalness: 1 };
    let m;
    if (variant === 'lod') m = new THREE.MeshStandardMaterial(P);
    else {
      m = new THREE.MeshPhysicalMaterial(P);
      m.clearcoat = 1; m.clearcoatRoughness = 0.04;
      if (variant === 'ext') { m.anisotropy = 0.0001; }       // enables the anisotropic GGX path; strength set per fragment
    }
    m.userData.S = S;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, S, { mkPalA: { value: t.A }, mkPalB: { value: t.B }, mkPalC: { value: t.C }, mkPalD: { value: t.D } });
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + MK_VERT_HEAD)
        .replace('#include <skinning_vertex>', MK_VERT_BODY + '\n#include <skinning_vertex>');
      let f = sh.fragmentShader.replace('#include <common>', '#include <common>' + MK_FRAG_HEAD)
        .replace('#include <map_fragment>', '#include <map_fragment>' + MK_FRAG_COLOR)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = clamp(mkRough, 0.03, 1.0);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = clamp(mkMetal, 0.0, 1.0);')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n normal = normalize(normal - (mkBump - dot(mkBump, normal) * normal));')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance = mkEm;')
        .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n if (mkInside > 0.5) { irradiance *= mkIndoor.x; iblIrradiance *= mkIndoor.x; radiance *= mkIndoor.y; }');
      if (variant !== 'lod') {
        f = f.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
          material.clearcoat = clamp(mkCC, 0.0, 1.0); material.clearcoatRoughness = max(mkCCR + mkGrime * 0.4, 0.03);
          #ifdef USE_ANISOTROPY
            { vec3 ta = mkAx - dot(mkAx, normal) * normal; float la = length(ta);
              if (la < 1e-3) { ta = mkAy - dot(mkAy, normal) * normal; la = max(length(ta), 1e-6); }   // (a face normal to the car's axis)
              ta /= la; vec3 tb = cross(normal, ta);
              material.anisotropy = clamp(mkAniso, 0.0, 0.95);
              material.alphaT = mix(pow2(material.roughness), 1.0, pow2(material.anisotropy));
              material.anisotropyT = ta; material.anisotropyB = tb; }
          #endif`);
      }
      sh.fragmentShader = f;
    };
    m.customProgramCacheKey = () => 'mk-pal-1-' + variant;
    return m;
  }

  // ------------------------------------------------------------------------------------------ mesh builder
  // Vertices: position, normal, uv (x: palette texel, y: a per-part scalar such as the profile arc length), uv1 (decal /
  // sign / screen coordinates), skinIndex (one bone). A transform stack places parts; mirror flips z.
  const _mA = new THREE.Matrix4(), _nA = new THREE.Matrix3(), _v = new V3(), _n = new V3();
  class MB {
    constructor() { this.P = []; this.N = []; this.T = []; this.T1 = []; this.K = []; this.I = []; this.bone = 0; this.u = 0.5 / PALN; this.ty = 0;
      this.stack = []; this.M = null; this.NM = null; this.flipW = false; }
    get count() { return this.P.length / 3; }
    pal(name) { this.u = palU(name); return this; }
    push(m) { this.stack.push([this.M, this.NM, this.flipW]); const c = this.M ? this.M.clone().multiply(m) : m.clone(); this.M = c; this.NM = new THREE.Matrix3().getNormalMatrix(c); this.flipW = c.determinant() < 0; return this; }
    pop() { [this.M, this.NM, this.flipW] = this.stack.pop(); return this; }
    at(m, fn) { this.push(m); fn(this); this.pop(); return this; }
    v(x, y, z, nx, ny, nz, u1 = 0, v1 = 0, ty) {
      if (this.M) { _v.set(x, y, z).applyMatrix4(this.M); _n.set(nx, ny, nz).applyMatrix3(this.NM).normalize(); x = _v.x; y = _v.y; z = _v.z; nx = _n.x; ny = _n.y; nz = _n.z; }
      this.P.push(x, y, z); this.N.push(nx, ny, nz); this.T.push(this.u, ty === undefined ? this.ty : ty); this.T1.push(u1, v1); this.K.push(this.bone);
      return this.P.length / 3 - 1;
    }
    tri(a, b, c) { if (this.flipW) this.I.push(a, c, b); else this.I.push(a, b, c); return this; }
    // triangle / quad whose winding follows the stored vertex normals (robust for procedurally ordered points)
    triA(a, b, c) { const P = this.P, N = this.N, f = fnorm([P[a * 3], P[a * 3 + 1], P[a * 3 + 2]], [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]]);
      const nx = N[a * 3] + N[b * 3] + N[c * 3], ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
      if (f[0] * nx + f[1] * ny + f[2] * nz >= 0) this.I.push(a, b, c); else this.I.push(a, c, b); return this; }
    quadA(a, b, c, d) { return this.triA(a, b, c).triA(a, c, d); }
    quad(a, b, c, d) { return this.tri(a, b, c).tri(a, c, d); }
    // quad from 4 points (counter-clockwise seen from the front), flat normal
    q4(A, B, C, D, uv) {
      const n = fnorm(A, B, C), u = uv || null;
      const a = this.v(A[0], A[1], A[2], n[0], n[1], n[2], u ? u[0][0] : 0, u ? u[0][1] : 0), b = this.v(B[0], B[1], B[2], n[0], n[1], n[2], u ? u[1][0] : 0, u ? u[1][1] : 0);
      const c = this.v(C[0], C[1], C[2], n[0], n[1], n[2], u ? u[2][0] : 0, u ? u[2][1] : 0), d = this.v(D[0], D[1], D[2], n[0], n[1], n[2], u ? u[3][0] : 0, u ? u[3][1] : 0);
      return this.quad(a, b, c, d);
    }
    // axis-aligned box (current transform), separate normals per face; skip: string of faces to omit ('xXyYzZ')
    box(x0, y0, z0, x1, y1, z1, skip = '') {
      const F = [['X', [1, 0, 0]], ['x', [-1, 0, 0]], ['Y', [0, 1, 0]], ['y', [0, -1, 0]], ['Z', [0, 0, 1]], ['z', [0, 0, -1]]];
      const lo = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], hi = [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)];
      for (const [k, n] of F) {
        if (skip.includes(k)) continue;
        const ax = n[0] ? 0 : n[1] ? 1 : 2, s = n[ax] > 0 ? hi[ax] : lo[ax], a = (ax + 1) % 3, b = (ax + 2) % 3;
        const pt = (i, j) => { const p = [0, 0, 0]; p[ax] = s; p[a] = i ? hi[a] : lo[a]; p[b] = j ? hi[b] : lo[b]; return p; };
        const P0 = pt(0, 0), P1 = pt(1, 0), P2 = pt(1, 1), P3 = pt(0, 1);
        const idx = [P0, P1, P2, P3].map(p => this.v(p[0], p[1], p[2], n[0], n[1], n[2]));
        const f = fnorm(P0, P1, P2); if (f[0] * n[0] + f[1] * n[1] + f[2] * n[2] >= 0) this.quad(idx[0], idx[1], idx[2], idx[3]); else this.quad(idx[0], idx[3], idx[2], idx[1]);
      }
      return this;
    }
    // cylinder / cone between points a and b (radii ra, rb), seg sides, optional caps; smooth sides
    cyl(a, b, ra, rb = ra, seg = 12, caps = true) {
      const d = new V3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), L = d.length(); if (L < 1e-6) return this;
      d.divideScalar(L);
      const t = Math.abs(d.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0), e1 = new V3().crossVectors(d, t).normalize(), e2 = new V3().crossVectors(d, e1);
      const slope = (ra - rb) / L, base = this.count;
      for (let k = 0; k <= seg; k++) {
        const ang = k / seg * TAU, c = Math.cos(ang), s = Math.sin(ang);
        const nx = e1.x * c + e2.x * s, ny = e1.y * c + e2.y * s, nz = e1.z * c + e2.z * s;
        const nn = new V3(nx + d.x * slope, ny + d.y * slope, nz + d.z * slope).normalize();
        this.v(a[0] + nx * ra, a[1] + ny * ra, a[2] + nz * ra, nn.x, nn.y, nn.z, k / seg, 0);
        this.v(b[0] + nx * rb, b[1] + ny * rb, b[2] + nz * rb, nn.x, nn.y, nn.z, k / seg, 1);
      }
      for (let k = 0; k < seg; k++) { const i = base + k * 2; this.quad(i, i + 2, i + 3, i + 1); }
      if (caps) for (const [p, r, sg] of [[a, ra, -1], [b, rb, 1]]) {
        if (r <= 0) continue;
        const c0 = this.v(p[0], p[1], p[2], d.x * sg, d.y * sg, d.z * sg, 0.5, 0.5), ring = [];
        for (let k = 0; k <= seg; k++) { const ang = k / seg * TAU, c = Math.cos(ang), s = Math.sin(ang);
          ring.push(this.v(p[0] + (e1.x * c + e2.x * s) * r, p[1] + (e1.y * c + e2.y * s) * r, p[2] + (e1.z * c + e2.z * s) * r, d.x * sg, d.y * sg, d.z * sg, 0.5 + c * 0.5, 0.5 + s * 0.5)); }
        for (let k = 0; k < seg; k++) { if (sg > 0) this.tri(c0, ring[k], ring[k + 1]); else this.tri(c0, ring[k + 1], ring[k]); }
      }
      return this;
    }
    // tube along a polyline (smooth, parallel-transported frames), radius r, seg sides; ends capped with a hemisphere-ish disc
    tube(pts, r, seg = 10, caps = true) {
      const n = pts.length; if (n < 2) return this;
      const P = pts.map(p => new V3(p[0], p[1], p[2])), Tn = [];
      for (let i = 0; i < n; i++) { const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)]; Tn.push(new V3().subVectors(b, a).normalize()); }
      let nrm = Math.abs(Tn[0].y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0); nrm = new V3().crossVectors(Tn[0], nrm).normalize();
      const base = this.count, ring = seg + 1;
      for (let i = 0; i < n; i++) {
        if (i > 0) { const ax = new V3().crossVectors(Tn[i - 1], Tn[i]); const s = ax.length(); if (s > 1e-6) { const ang = Math.asin(clamp(s, -1, 1)); nrm.applyAxisAngle(ax.normalize(), Tn[i - 1].dot(Tn[i]) < 0 ? Math.PI - ang : ang); } }
        const bin = new V3().crossVectors(Tn[i], nrm).normalize();
        for (let k = 0; k <= seg; k++) { const ang = k / seg * TAU, c = Math.cos(ang), s = Math.sin(ang);
          const nx = nrm.x * c + bin.x * s, ny = nrm.y * c + bin.y * s, nz = nrm.z * c + bin.z * s;
          this.v(P[i].x + nx * r, P[i].y + ny * r, P[i].z + nz * r, nx, ny, nz, k / seg, i / (n - 1)); }
      }
      for (let i = 0; i < n - 1; i++) for (let k = 0; k < seg; k++) { const a = base + i * ring + k; this.quad(a, a + ring, a + ring + 1, a + 1); }
      if (caps) for (const [i, sg] of [[0, -1], [n - 1, 1]]) {
        const t = Tn[i], c0 = this.v(P[i].x + t.x * r * 0.4 * sg, P[i].y + t.y * r * 0.4 * sg, P[i].z + t.z * r * 0.4 * sg, t.x * sg, t.y * sg, t.z * sg);
        const r0 = base + i * ring;
        for (let k = 0; k < seg; k++) { if (sg > 0) this.tri(c0, r0 + k, r0 + k + 1); else this.tri(c0, r0 + k + 1, r0 + k); }
      }
      return this;
    }
    // surface of revolution about the local Y axis: prof = [[r, y], ...] bottom to top (outward normals)
    lathe(prof, seg = 16, a0 = 0, a1 = TAU) {
      const base = this.count, m = prof.length;
      const nrm = []; for (let i = 0; i < m; i++) { const a = prof[Math.max(0, i - 1)], b = prof[Math.min(m - 1, i + 1)]; const dr = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dr, dy) || 1; nrm.push([dy / l, -dr / l]); }
      for (let i = 0; i < m; i++) for (let k = 0; k <= seg; k++) { const ang = a0 + (a1 - a0) * k / seg, c = Math.cos(ang), s = Math.sin(ang);
        this.v(prof[i][0] * c, prof[i][1], prof[i][0] * s, nrm[i][0] * c, nrm[i][1], nrm[i][0] * s, k / seg, i / (m - 1)); }
      for (let i = 0; i < m - 1; i++) for (let k = 0; k < seg; k++) { const a = base + i * (seg + 1) + k; this.quad(a, a + 1, a + seg + 2, a + seg + 1); }
      return this;
    }
    // parametric surface: P(u, v, out[3]) over us x vs; normals from central differences; o.flip, o.uv(u,v)->[u1,v1], o.ty(u,v)
    surface(us, vs, P, o = {}) {
      const p = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0], base = this.count, nv = vs.length, eu = o.eu || 1e-4, ev = o.ev || 1e-4;
      for (let i = 0; i < us.length; i++) for (let j = 0; j < nv; j++) {
        const u = us[i], v = vs[j]; P(u, v, p);
        P(u + eu, v, a); P(u - eu, v, b); const du = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        P(u, v + ev, a); P(u, v - ev, b); const dv = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        let nx = du[1] * dv[2] - du[2] * dv[1], ny = du[2] * dv[0] - du[0] * dv[2], nz = du[0] * dv[1] - du[1] * dv[0];
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l; if (o.flip) { nx = -nx; ny = -ny; nz = -nz; }
        const t1 = o.uv ? o.uv(u, v) : [u, v];
        this.v(p[0], p[1], p[2], nx, ny, nz, t1[0], t1[1], o.ty ? o.ty(u, v) : undefined);
      }
      for (let i = 0; i + 1 < us.length; i++) for (let j = 0; j + 1 < nv; j++) {
        if (o.skip && o.skip((us[i] + us[i + 1]) / 2, (vs[j] + vs[j + 1]) / 2)) continue;
        const q = base + i * nv + j; if (o.flip) this.quad(q, q + 1, q + nv + 1, q + nv); else this.quad(q, q + nv, q + nv + 1, q + 1);
      }
      return this;
    }
    // a flat-ish 2D shape (outline + holes, [[a, b], ...]) triangulated by earcut, mapped by map(a, b) -> {p:[x,y,z], n:[x,y,z]}
    shape(outline, holes, map, uvf) {
      const dd = a => (a.length > 2 && Math.hypot(a[0][0] - a[a.length - 1][0], a[0][1] - a[a.length - 1][1]) < 1e-9) ? a.slice(0, -1) : a;
      outline = dd(outline); holes = holes.map(dd);
      const tris = THREE.ShapeUtils.triangulateShape(outline.map(q => new THREE.Vector2(q[0], q[1])), holes.map(h => h.map(q => new THREE.Vector2(q[0], q[1]))));
      const all = outline.concat(...holes), idx = all.map(([a, b]) => { const r = map(a, b); const t = uvf ? uvf(a, b) : [0, 0]; return this.v(r.p[0], r.p[1], r.p[2], r.n[0], r.n[1], r.n[2], t[0], t[1], r.ty); });
      for (const [i, j, k] of tris) {
        // keep the winding consistent with the mapped normal
        const A = all[i], B = all[j], C = all[k];
        const r0 = map(A[0], A[1]).p, r1 = map(B[0], B[1]).p, r2 = map(C[0], C[1]).p, f = fnorm(r0, r1, r2), n = map((A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3).n;
        if (f[0] * n[0] + f[1] * n[1] + f[2] * n[2] >= 0) this.tri(idx[i], idx[j], idx[k]); else this.tri(idx[i], idx[k], idx[j]);
      }
      return this;
    }
    geometry() {
      const g = new THREE.BufferGeometry(), n = this.count;
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.T, 2));
      g.setAttribute('mkt1', new THREE.Float32BufferAttribute(this.T1, 2));
      const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { si[i * 4] = this.K[i]; sw[i * 4] = 1; }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
      return g;
    }
    // a grid of positions/normals (rows x cols, row-major arrays of [x, y, z]) emitted as quads whose palette entry comes
    // from palAt(i, j) (quad between rows i, i+1 and columns j, j+1); vertices are duplicated per quad so palettes never
    // blend across a quad, normals stay smooth
    gridQuads(Pp, Nn, rows, cols, palAt) {
      for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols - 1; j++) {
        this.pal(palAt(i, j)); const k = [i * cols + j, (i + 1) * cols + j, (i + 1) * cols + j + 1, i * cols + j + 1];
        const v = k.map(q => this.v(Pp[q][0], Pp[q][1], Pp[q][2], Nn[q][0], Nn[q][1], Nn[q][2]));
        this.quadA(v[0], v[1], v[2], v[3]);
      }
      return this;
    }
    // append another builder's content (same bone numbering)
    append(o) { const b = this.count; this.P.push(...o.P); this.N.push(...o.N); this.T.push(...o.T); this.T1.push(...o.T1); this.K.push(...o.K); for (const i of o.I) this.I.push(i + b); return this; }
  }
  function fnorm(a, b, c) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  }
  const M4 = () => new THREE.Matrix4();
  const tr = (x, y, z) => M4().makeTranslation(x, y, z);
  const rotY = (a) => M4().makeRotationY(a), rotZ = (a) => M4().makeRotationZ(a), rotX = (a) => M4().makeRotationX(a);
  const mul = (...ms) => ms.reduce((a, b) => a.multiply(b), M4());
  // rounded rectangle outline [[a, b], ...] counter-clockwise, corner radius r (or [r00, r10, r11, r01] per corner), k segments
  function rrect(a0, b0, a1, b1, r, k = 6) {
    const R = Array.isArray(r) ? r : [r, r, r, r], out = [];
    const C = [[a1 - R[1], b0 + R[1], -Math.PI / 2, R[1]], [a1 - R[2], b1 - R[2], 0, R[2]], [a0 + R[3], b1 - R[3], Math.PI / 2, R[3]], [a0 + R[0], b0 + R[0], Math.PI, R[0]]];
    for (const [ca, cb, s, rr] of C) {
      if (rr < 1e-5) { out.push([ca, cb]); continue; }
      for (let i = 0; i <= k; i++) { const ang = s + (i / k) * Math.PI / 2; out.push([ca + rr * Math.cos(ang), cb + rr * Math.sin(ang)]); }
    }
    return out;
  }
  // densify a closed outline so no edge is longer than step
  function densify(pts, step) {
    const out = [];
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / step));
      for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); }
    return out;
  }
  const rev = a => a.slice().reverse();


  const K = { Q: () => Q, PAT, G, PAL, PI, palU, pal, palTextures, carUniforms, palMaterial, MB, fnorm, M4, tr, rotY, rotZ, rotX, mul, rrect, densify, rev, TAU };

  // ------------------------------------------------------------------------------------------ sign canvas layout
  // One LED raster per consist (a texel per LED): rows 0-15 destination (front + side signs), rows 16-31 the interior
  // next-stop sign, rows 32-47 spare. uv rects [u0, v0, u1, v1] (flipY: row 0 at v = 1).
  const SIGN = { W: 192, H: 48, front: [0, 32 / 48, 1, 1], side: [0, 32 / 48, 1, 1], next: [0, 16 / 48, 1, 32 / 48], spare: [0, 0, 1, 16 / 48] };

  // ------------------------------------------------------------------------------------------ glass
  // Exterior glass. With the interior hidden it shows a ray-cast impression of the lit cabin behind it ("interior
  // mapping": floor, ceiling with its two light strips, far wall and windows, seat rows with occupants) with Fresnel
  // reflections of the environment on top; with the interior built it becomes clear, tinted glass.
  const GLASS_FRAG_HEAD = `
    uniform vec3 mkCamO; uniform float mkNight, mkIntOn, mkSeed, mkHalfW, mkFloorY, mkCeilY; uniform float mkLv[12];
    uniform vec4 mkRows[24]; uniform float mkRowN; uniform vec4 mkCab;
    uniform vec4 mkSgnA[6]; uniform vec4 mkSgnB[6]; uniform sampler2D mkSign; uniform vec2 mkSignRes;
    // LED signs behind the glass: plane (axis 0: x = c, 1: z = c), extent a0..a1 along the other horizontal axis,
    // y0..y1, u direction; returns the LED emission (rgb) and whether the ray hit a sign (a)
    vec4 mkSigns(vec3 ro, vec3 rd) {
      for (int k = 0; k < 6; k++) {
        vec4 A = mkSgnA[k], B = mkSgnB[k]; if (B.w < 0.5) continue;
        float den = A.x < 0.5 ? rd.x : rd.z; if (abs(den) < 1e-4) continue;
        float t = (A.y - (A.x < 0.5 ? ro.x : ro.z)) / den; if (t <= 0.0) continue;
        vec3 h = ro + rd * t; float al = A.x < 0.5 ? h.z : h.x;
        if (al < A.z || al > A.w || h.y < B.x || h.y > B.y) continue;
        float u = (al - A.z) / (A.w - A.z); if (B.z < 0.0) u = 1.0 - u;
        float v = (h.y - B.x) / (B.y - B.x);
        vec2 cellUv = vec2(u, 32.0 / 48.0 + v * 16.0 / 48.0) * mkSignRes; vec2 cid = floor(cellUv) + 0.5; vec2 f = fract(cellUv) - 0.5;
        vec3 led = texture2D(mkSign, cid / mkSignRes).rgb;
        float cell = fwidth(cellUv.x), dotm = 1.0 - smoothstep(0.26, 0.38 + cell, length(f)), near = 1.0 - smoothstep(0.35, 0.9, cell);
        return vec4(led * mix(0.62, dotm * 1.5, near) * 3.0 + vec3(0.004), 1.0);
      }
      return vec4(0.0);
    }
    varying vec3 mkP; varying vec3 mkN; varying vec2 mkUv; varying vec2 mkUv1; varying vec3 mkAx; varying vec3 mkAy; varying vec3 mkAz;
    float gH(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    // cast a ray from the glass into the cabin box; returns radiance of what it hits
    vec3 mkInterior(vec3 ro, vec3 rd, float lit) {
      float hw = mkHalfW, fy = mkFloorY, cy = mkCeilY;
      if (ro.x > mkCab.y + 0.05 || ro.x < mkCab.x - 0.05) { float sh = 0.04 + 0.1 * smoothstep(fy + 0.9, fy + 1.3, ro.y + rd.y); return vec3(sh) * (0.4 + lit) * (1.0 - 0.5 * mkNight); }
      float tHit = 1e9; int what = 0; vec3 nrm = vec3(0.0);
      if (rd.y < -1e-4) { float t = (fy - ro.y) / rd.y; if (t > 0.0 && t < tHit) { tHit = t; what = 1; nrm = vec3(0, 1, 0); } }
      if (rd.y > 1e-4) { float t = (cy - ro.y) / rd.y; if (t > 0.0 && t < tHit) { tHit = t; what = 2; nrm = vec3(0, -1, 0); } }
      if (abs(rd.z) > 1e-4) { float zw = rd.z > 0.0 ? hw : -hw; float t = (zw - ro.z) / rd.z; if (t > 0.02 && t < tHit) { tHit = t; what = 3; nrm = vec3(0, 0, -sign(rd.z)); } }
      if (abs(rd.x) > 1e-4) { float xw = rd.x > 0.0 ? mkCab.y : mkCab.x; float t = (xw - ro.x) / rd.x; if (t > 0.0 && t < tHit) { tHit = t; what = 4; nrm = vec3(-sign(rd.x), 0, 0); } }
      // seat rows: x planes (backs) spanning |z| in [zi, zo] below the back top; rows = (x, zInner, zOuter, facing)
      vec3 seatCol = vec3(0.0); float seatT = 1e9; float occ = 0.0; vec3 seatN = vec3(0.0);
      for (int k = 0; k < 24; k++) {
        if (float(k) >= mkRowN) break;
        vec4 r = mkRows[k];
        if (abs(rd.x) < 1e-4) continue;
        float t = (r.x - ro.x) / rd.x;
        if (t > 0.0 && t < tHit && t < seatT) {
          vec3 h = ro + rd * t;
          if (h.z > r.y && h.z < r.z && h.y < fy + 1.02 && h.y > fy + 0.05) {
            seatT = t; seatN = vec3(-sign(rd.x), 0, 0);
            float cell = floor((abs(h.z) - 0.44) / 0.51); float key = gH(vec2(r.x * 7.1 + mkSeed, cell + sign(h.z) * 3.0));
            occ = step(key, 0.3 + 0.2 * mkNight);
            seatCol = mix(vec3(0.05, 0.2, 0.36), vec3(0.42, 0.46, 0.08), step(0.85, gH(vec2(r.x, 3.0))));
            if (occ > 0.5 && h.y > fy + 0.62) seatCol = mix(vec3(0.1, 0.11, 0.14), vec3(0.3, 0.2, 0.15), gH(vec2(r.x * 3.0, cell)));
          }
        }
        // occupants' heads and shoulders above the backs, 0.2 m in front of them
        float tt = (r.x + r.w * 0.2 - ro.x) / rd.x;
        if (tt > 0.0 && tt < tHit && tt < seatT) { vec3 h = ro + rd * tt;
          if (h.z > r.y && h.z < r.z) { float cell = floor((abs(h.z) - 0.44) / 0.51); float key = gH(vec2(r.x * 7.1 + mkSeed, cell + sign(h.z) * 3.0));
            vec2 q = vec2((fract((abs(h.z) - 0.44) / 0.51) - 0.5) * 0.51, h.y - fy - 1.2);
            float headD = length(q * vec2(1.0, 0.85)), torso = step(abs(q.x), 0.19) * step(q.y, -0.16) * step(-0.62, q.y);
            if (key < 0.3 + 0.2 * mkNight && (headD < 0.11 || torso > 0.5)) { seatT = tt; seatN = vec3(-sign(rd.x), 0, 0);
              seatCol = headD < 0.11 ? mix(vec3(0.36, 0.24, 0.17), vec3(0.09, 0.07, 0.06), step(0.55, gH(vec2(cell, r.x)))) : mix(vec3(0.08, 0.09, 0.12), vec3(0.4, 0.14, 0.12), gH(vec2(r.x, cell * 1.7))); } } }
      }
      vec3 hit = ro + rd * min(tHit, seatT);
      vec3 base = vec3(0.0);
      if (seatT < tHit) base = seatCol;
      else if (what == 1) { base = vec3(0.30, 0.31, 0.33) * (0.9 + 0.2 * gH(floor(hit.xz * 40.0))); }
      else if (what == 2) { float strip = 1.0 - smoothstep(0.05, 0.09, abs(abs(hit.z) - 0.6)); base = mix(vec3(0.82, 0.82, 0.8), vec3(9.0) * lit, strip); }
      else if (what == 3) {
        // far wall: windows (the outside, dim sky) between y 1.89 and 2.84, panels elsewhere
        float wy = step(fy + 0.9, hit.y) * step(hit.y, fy + 1.85);
        float wx = step(0.18, fract(hit.x / 0.98 + 0.37));
        vec3 sky = mix(vec3(0.55, 0.62, 0.7), vec3(0.03, 0.035, 0.05), mkNight);
        base = mix(vec3(0.8, 0.8, 0.78), sky * (1.0 - 0.5 * lit), wy * wx);
        base = mix(base, vec3(0.72, 0.76, 0.2), step(hit.y, fy + 0.45) * 0.0);
      }
      else if (what == 4) { base = mix(vec3(0.72, 0.77, 0.22), vec3(0.8, 0.8, 0.78), mkCab.z); }
      // light: the cabin's own lighting (the same absolute level day and night: outdoors is what changes), plus a
      // little daylight through the far windows by day
      vec3 n = seatT < tHit ? seatN : nrm;
      float il = lit * 0.34 * (0.6 + 0.4 * smoothstep(fy, cy, hit.y));
      float day = (1.0 - mkNight) * 0.06;
      return base * (il + day);
    }`;
  function glassMaterial(S) {
    const m = new THREE.MeshPhysicalMaterial({ color: 0x000000, roughness: 0.035, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.0 });
    m.userData.S = S;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, S);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + MK_VERT_HEAD)
        .replace('#include <skinning_vertex>', MK_VERT_BODY + '\n#include <skinning_vertex>');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + GLASS_FRAG_HEAD)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            vec3 rd = normalize(mkP - mkCamO);
            float lit = mkLv[1];
            vec3 ro = mkP + rd * 0.03;
            vec4 sg = mkSigns(mkP, rd);
            vec3 inside = sg.a > 0.5 ? sg.rgb : mkInterior(ro, rd, lit);
            // tinted glass (grey-green) and a Fresnel term: at grazing angles the reflection wins
            float cosT = abs(dot(normalize(vNormal), normalize(vViewPosition)));
            float F = 0.04 + 0.96 * pow(1.0 - cosT, 5.0);
            totalEmissiveRadiance = inside * (sg.a > 0.5 ? vec3(0.75) : vec3(0.36, 0.42, 0.42)) * (1.0 - F) * mkIntOn;
          }`);
    };
    m.customProgramCacheKey = () => 'mk-glass-1';
    return m;
  }
  // clear glass (interior built): tinted, reflective, see-through
  function glassClearMaterial() {
    const m = new THREE.MeshPhysicalMaterial({ color: 0x1d2a2e, roughness: 0.02, metalness: 0, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.0 });
    m.forceSinglePass = true; return m;
  }

  // ------------------------------------------------------------------------------------------ designs
  const builders = {};                 // kind -> (type, q) => design (registered by the 42_* files)
  const designs = Object.create(null);
  function getDesign(kind, type) {
    const key = kind + ':' + type + ':q' + Q;
    if (designs[key]) return designs[key];
    const b = builders[kind]; if (!b) throw new Error('MetroKit: no builder for ' + kind);
    const t0 = performance.now(), d = b(type, Q);
    d.key = key; d.kind = kind; d.type = type; d.buildMs = performance.now() - t0;
    return (designs[key] = d);
  }

  // ------------------------------------------------------------------------------------------ runtime: Car
  const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _ax = new V3();
  class Car {
    constructor(consist, index, d, flip, number) {
      this.consist = consist; this.index = index; this.design = d; this.flip = flip; this.number = number;
      this.kind = d.kind; this.type = d.type; this.length = d.length; this.width = d.width; this.height = d.height;
      Object.assign(this, flip ? flipMeta(d.meta, d.length) : copyMeta(d.meta));
      this.group = new THREE.Group(); this.group.name = 'metrocar' + index + ':' + d.key; this.group.rotation.order = 'YZX';
      const root = this.root = flip ? new THREE.Group() : this.group;
      if (flip) { root.rotation.y = Math.PI; this.group.add(root); }
      const S = this.S = carUniforms();
      S.mkSeed.value = (U.hashStr(number + ':' + index) % 997) / 97;
      S.mkAge.value = consist.ageOf(index);
      S.mkSign.value = consist.signTex; S.mkSignRes.value.set(SIGN.W, SIGN.H);
      S.mkAtlas.value = consist.atlasTex; S.mkLcd.value = consist.lcdTex;
      { const DIG = K.DIG || '0123456789 XYL', txt = (String(number).padStart(4, ' ').slice(-4) + 'XY'); for (let i = 0; i < 6; i++) { const k = DIG.indexOf(txt[i]); S.mkNum.value[i] = k < 0 ? 99 : k; } }
      S.mkCamO = { value: new V3() }; S.mkIntOn = { value: 1 }; const rows = (d.rows || []).slice(0, 24); while (rows.length < 24) rows.push(new THREE.Vector4(1e4, 0, 0, 0));
      S.mkRows = { value: rows }; S.mkRowN = { value: d.rows ? Math.min(24, d.rows.length) : 0 };
      S.mkCab = { value: new THREE.Vector4(-d.length / 2, d.length / 2, 0, 0) };
      { const A = [], B = []; for (let i = 0; i < 6; i++) { const g = (d.signs || [])[i]; A.push(g ? new THREE.Vector4(...g.a) : new THREE.Vector4()); B.push(g ? new THREE.Vector4(...g.b, 1) : new THREE.Vector4(0, 0, 1, 0)); }
        S.mkSgnA = { value: A }; S.mkSgnB = { value: B }; }
      if (d.cabBox) S.mkCab.value.copy(d.cabBox);
      S.mkHalfW.value = d.halfW || 1.47; S.mkFloorY.value = d.floorY || 0.991; S.mkCeilY.value = d.ceilY || 3.1;
      this.mat = palMaterial('ext', S);
      this.matGlass = glassMaterial(S); this.matGlassClear = consist.glassClear;
      // skeleton: bones exist only for the renderer's bookkeeping; the matrices are written here (car-local)
      const nb = d.bones.length, bones = []; for (let i = 0; i < nb; i++) bones.push(new THREE.Bone());
      const sk = this.skeleton = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
      sk.computeBoneTexture(); sk.update = function () {};
      this.bm = sk.boneMatrices; for (let i = 0; i < nb; i++) _m.identity().toArray(this.bm, i * 16);
      const I = new THREE.Matrix4();
      const mk = (geo, mat, name) => { const me = new THREE.SkinnedMesh(geo, mat); me.bind(sk, I); me.bindMode = 'detached'; me.name = name;
        me.boundingSphere = d.sphere.clone(); me.frustumCulled = true; root.add(me); return me; };
      this.ext = mk(d.ext, this.mat, 'body'); this.ext.castShadow = true; this.ext.receiveShadow = true;
      this.glass = mk(d.glass, this.matGlass, 'glass'); this.glass.receiveShadow = false;
      // camera position in car space for the glass (interior mapping), computed just before the glass draws
      const self = this;
      this.glass.onBeforeRender = (r, scene, cam) => { _m.copy(self.root.matrixWorld).invert(); S.mkCamO.value.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(_m); };
      this.lod = 0; this.int = null; this.intVisible = false;
      if (!d.bogieList) d.bogieList = d.boneIdx.bogie.map((bi, k) => ({ bone: bi, pivot: d.bones[bi].pivot, axles: d.boneIdx.axlesOf[k] }));
      this.wheelAng = 0; this.yaw = d.bogieList.map(() => 0); this.doorPos = [0, 0]; this.wiperAng = [0, 0]; this.dirty = true;
      if (d.bodyList) { this.bodySt = d.bodyList.map(() => ({ yaw: 0, dx: 0, dz: 0 })); this.bodyM = d.bodyList.map(() => new THREE.Matrix4()); this.bogOff = d.bogieList.map(() => [0, 0]); }
      this.lv = S.mkLv.value;
      this._pose();
    }
    // write bone matrices (car-local) from the current state
    _pose() {
      const d = this.design, B = d.bones, bm = this.bm, BL = d.bogieList, BD = d.bodyList;
      // articulated bodies (bone matrices in the car frame): yaw about the pivot, then a lateral / longitudinal shift
      if (BD) for (let i = 0; i < BD.length; i++) { const b = BD[i], st = this.bodySt[i], pv = b.pivot;
        _m.makeTranslation(pv[0] + st.dx, pv[1], pv[2] + st.dz).multiply(_m2.makeRotationY(st.yaw)).multiply(_m3.makeTranslation(-pv[0], -pv[1], -pv[2]));
        _m.toArray(bm, b.bone * 16); this.bodyM[i].copy(_m); }
      // bogies: yaw about the pivot (plus the offset of an articulated unit's middle bogie), wheelsets spin inside them
      for (let b = 0; b < BL.length; b++) { const g = BL[b], pv = g.pivot, yaw = this.yaw[b], off = this.bogOff ? this.bogOff[b] : null;
        _m.makeTranslation(pv[0] + (off ? off[0] : 0), pv[1], pv[2] + (off ? off[1] : 0)).multiply(_m2.makeRotationY(yaw)).multiply(_m3.makeTranslation(-pv[0], -pv[1], -pv[2]));
        _m.toArray(bm, g.bone * 16);
        for (const ai of g.axles) { const ap = B[ai].pivot;
          _m2.makeTranslation(ap[0], ap[1], ap[2]).multiply(_m3.makeRotationZ(-this.wheelAng)); _m2.multiply(_m3.makeTranslation(-ap[0], -ap[1], -ap[2]));
          _m3.multiplyMatrices(_m, _m2); _m3.toArray(bm, ai * 16); } }
      // door leaves: plug out, then slide away from the door centre. doorPos[0] = design-left (-Z), [1] = design-right (+Z)
      for (const L of d.leaves) {
        const t = this.doorPos[L.side > 0 ? 1 : 0];
        const plug = smooth(0, 0.16, t) * (d.plugOut || 0.03), slide = smooth(0.1, 1, t) * (d.slide || 0.70);
        _m.makeTranslation(L.k * slide, 0, L.side * plug);
        if (L.body !== undefined && this.bodyM) _m.premultiply(this.bodyM[L.body]);
        _m.toArray(bm, L.bone * 16);
      }
      // wipers: rotate about the face normal at the pivot
      for (let w = 0; w < (d.wipers || []).length; w++) { const W = d.wipers[w], a = this.wiperAng[w];
        _ax.set(W.axis[0], W.axis[1], W.axis[2]);
        _m.makeTranslation(W.pivot[0], W.pivot[1], W.pivot[2]).multiply(_m2.makeRotationAxis(_ax, a)).multiply(_m3.makeTranslation(-W.pivot[0], -W.pivot[1], -W.pivot[2]));
        _m.toArray(bm, W.bone * 16); }
      if (d.boneIdx.handle !== undefined) { const hb = d.boneIdx.handle, pv = B[hb].pivot;
        _m.makeTranslation(pv[0], pv[1], pv[2]).multiply(_m2.makeRotationZ(-(this.handleA || 0) * 0.55)).multiply(_m3.makeTranslation(-pv[0], -pv[1], -pv[2])); _m.toArray(bm, hb * 16); }
      if (this.skeleton.boneTexture) this.skeleton.boneTexture.needsUpdate = true;
      this.dirty = false;
    }
    setInteriorVisible(v) {
      v = !!v; if (v === this.intVisible) return; this.intVisible = v;
      if (v && !this.int && this.consist._buildInterior) this.consist._buildInterior(this);
      if (this.int) this.int.visible = v && this.lod === 0;
      this.glass.material = v && this.int ? this.matGlassClear : this.matGlass;
      this.glass.renderOrder = v ? 2 : 0;
    }
    setLOD(level) {
      level = clamp(level | 0, 0, 2); if (level === this.lod) return; this.lod = level;
      if (level > 0 && !this['lodMesh' + level]) {
        const d = this.design, b = builders[d.kind], k = 'lod' + level;
        if (!d[k] && b.lod) d[k] = b.lod(d, level);
        if (d[k]) { if (!this.matLod) this.matLod = palMaterial('lod', this.S); const m = new THREE.Mesh(d[k], this.matLod); m.name = 'lod' + level; m.castShadow = level === 1; m.receiveShadow = level === 1; this.root.add(m); this['lodMesh' + level] = m; }
      }
      this.ext.visible = this.glass.visible = level === 0;
      if (this.lodMesh1) this.lodMesh1.visible = level === 1;
      if (this.lodMesh2) this.lodMesh2.visible = level === 2;
      if (this.int) this.int.visible = this.intVisible && level === 0;
      if (level === 0 && this.dirty) this._pose();
    }
    // bogie yaw from the two bogie-pivot frames (x, y, z, tx, tz), called after posing (TrainKit-style posing)
    setBogies(F, R) {
      const yawBody = Math.atan2(-(F.z - R.z), F.x - R.x);
      const yF = U.wrapAngle(Math.atan2(-(F.tz || 0), F.tx === undefined ? 1 : F.tx) - yawBody), yR = U.wrapAngle(Math.atan2(-(R.tz || 0), R.tx === undefined ? 1 : R.tx) - yawBody);
      const a = this.flip ? yR : yF, b = this.flip ? yF : yR;
      if (Math.abs(a - this.yaw[0]) > 1e-5 || Math.abs(b - this.yaw[1]) > 1e-5) { this.yaw[0] = a; this.yaw[1] = b; this.dirty = true; }
    }
  }
  function copyMeta(m) { return JSON.parse(JSON.stringify(m)); }
  function flipMeta(m, L) {
    const o = copyMeta(m), fg = w => w ? { x: -w.x, z0: -w.z1, z1: -w.z0, y: w.y, emergency: w.emergency } : null;
    o.bogieOffsets = [-m.bogieOffsets[1], -m.bogieOffsets[0]];
    o.floorRegions = m.floorRegions.map(r => ({ ...r, x0: -r.x1, x1: -r.x0, z0: -r.z1, z1: -r.z0 }));
    o.ramps = (m.ramps || []).map(r => ({ ...r, x0: -r.x1, x1: -r.x0, z0: -r.z1, z1: -r.z0, y0: r.y1, y1: r.y0 }));
    o.gangways = { front: fg(m.gangways.rear), rear: fg(m.gangways.front) };
    o.seats = m.seats.map(s => ({ ...s, x: -s.x, z: -s.z, yaw: U.wrapAngle(s.yaw + Math.PI) }));
    o.doors = m.doors.map(d => ({ ...d, x: -d.x, side: -d.side }));
    o.cabEye = m.cabEye ? [-m.cabEye[0], m.cabEye[1], -m.cabEye[2]] : null;
    o.cabYaw = m.cabEye ? Math.PI : 0;
    void L; return o;
  }

  // ------------------------------------------------------------------------------------------ runtime: Consist
  // Default orders (BART builds long trains from D-E..E-D sets, so 7..10 cars have two cab cars back to back mid-train).
  const ORDERS = { 2: 'DD', 3: 'DED', 4: 'DEED', 5: 'DEEED', 6: 'DEEEED', 7: 'DED DEED', 8: 'DEED DEED', 9: 'DEED DEEED', 10: 'DEEED DEEED' };
  const LINE_COLORS = { yellow: '#ffe400', orange: '#f7941d', green: '#4db848', red: '#ed1c24', blue: '#00a6e9', grey: '#b0bec7', ebart: '#ffe400', purple: '#8e5ba6' };
  class Consist {
    constructor(kind, opts = {}) {
      if (!builders[kind]) throw new Error('MetroKit: unknown consist kind ' + kind);
      this.kind = kind; this.name = opts.name || ''; this.seed = (opts.seed >>> 0) || 0; this.speed = 0;
      this.night = 0; this.lights = { head: 1, tail: 1, interior: 1, cab: 1, signs: 1 }; this.lead = 'front';
      this.doorT = [0, 0]; this.doorGoal = [0, 0]; this.dest = null; this.onEvent = null; this._chime = [-1, -1];
      this.signTex = makeSignTexture(); this.atlasTex = K.decalAtlas ? K.decalAtlas() : null; this.lcdTex = null;
      this.glassClear = glassClearMaterial();
      // car list
      let order = opts.order || null;
      const n = clamp(opts.cars | 0 || (kind === 'bart' ? 10 : kind === 'dmu' ? 1 : 3), 1, 12);
      const spec = builders[kind].consist ? builders[kind].consist(n, order, this.seed) : defaultBartOrder(n, order);
      this.cars = spec.map((c, i) => new Car(this, i, getDesign(kind, c.type), c.flip, c.number || this.numberFor(c.type, i)));
      let off = 0; for (const c of this.cars) { c.offset = off + c.length / 2; off += c.length; }
      this.length = off;
      this.setDestination(opts.destination || { line: 'yellow', text: 'Bayline Metro' });
      this._applyLights();
    }
    ageOf(i) { return 0.12 + 0.8 * ((U.hash2(this.seed * 31 + i, 17) + U.hash2(i, this.seed)) / 2); }
    numberFor(type, i) { const h = U.hash2(this.seed + 11, i * 7 + 3); return type === 'D' ? String(3001 + Math.floor(h * 310)) : String(4001 + Math.floor(h * 819)); }
    setLeadEnd(lead) { this.lead = lead === 'rear' ? 'rear' : 'front'; this._applyLights(); }
    setLights(o = {}) {
      for (const k of ['head', 'tail', 'interior', 'cab', 'signs']) if (o[k] !== undefined) this.lights[k] = clamp(+o[k] || 0, 0, 1);
      if (o.lead) this.lead = o.lead === 'rear' ? 'rear' : 'front';
      this._applyLights();
    }
    setNight(n) { n = clamp(+n || 0, 0, 1); if (Math.abs(n - this.night) < 1e-3) return; this.night = n; this._applyLights(); }
    _applyLights() {
      const n = this.night, L = this.lights, cars = this.cars, first = cars[0], last = cars[cars.length - 1];
      const leadCar = this.lead === 'rear' ? last : first, trailCar = this.lead === 'rear' ? first : last;
      for (const c of cars) {
        const lv = c.lv, isLead = c === leadCar, isTrail = c === trailCar;
        // which end of this car is the consist's leading end? lamps are on the design's +X (cab) end
        const cabLeads = isLead && ((this.lead === 'front') !== c.flip), cabTrails = isTrail && ((this.lead === 'front') === c.flip);
        lv[G.interior] = L.interior * (0.55 + 0.45 * n);
        lv[G.head] = cabLeads ? L.head * (6 + 16 * n) : 0;
        lv[G.marker] = cabLeads ? L.head * (1.5 + 3 * n) : 0;
        lv[G.tail] = cabTrails || (!c.design.meta.cabEye && (isTrail || isLead)) ? L.tail * (3 + 7 * n) : 0;
        lv[G.bar] = (cabLeads || cabTrails) ? (1.2 + 2.5 * n) : 0;
        c.S.mkBar.value = cabTrails ? 1 : 0;
        lv[G.sign] = L.signs * (0.8 + 0.4 * n);
        lv[G.cab] = L.cab;
        c.S.mkNight.value = n;
        c.S.mkIntOn.value = 1;
      }
      this._applyDoorLamps();
    }
    _applyDoorLamps() {
      for (const c of this.cars) {
        const l = c.flip ? this.doorT[1] : this.doorT[0], r = c.flip ? this.doorT[0] : this.doorT[1];
        const blink = 1;
        c.lv[G.doorR] = r > 0.02 ? 4 * blink : 0; c.lv[G.doorL] = l > 0.02 ? 4 * blink : 0;
        c.lv[G.idoorR] = c.lv[G.doorR]; c.lv[G.idoorL] = c.lv[G.doorL];
      }
    }
    // { line, color, text } or a string. The front and side signs show a line-colour square and the terminal.
    setDestination(o, color) {
      if (typeof o === 'string' || o == null) o = { text: o || '', color };
      const line = (o.line || '').toLowerCase(), col = o.color || LINE_COLORS[line] || '#ffe400', text = String(o.text || '');
      const key = col + '|' + text; if (key === this.dest) return; this.dest = key;
      drawSign(this.signTex, col, text, this._next || '');
    }
    setNextStop(text) { text = String(text || ''); if (text === this._next) return; this._next = text; const d = (this.dest || '|').split('|'); drawSign(this.signTex, d[0], d[1], text); }
    // TrainKit-compatible door control: side 'left' | 'right' | 'both' | 'none' (consist frame, +Z = right), t 0..1
    setDoors(side, t) {
      t = clamp(+t || 0, 0, 1);
      if (side === 'none') { this.doorGoal[0] = this.doorGoal[1] = 0; return; }
      if (side === 'left' || side === 'both') this.doorGoal[0] = t;
      if (side === 'right' || side === 'both') this.doorGoal[1] = t;
    }
    // event-style control: openDoors('right'); closeDoors() plays the chime (onEvent('chime', side)) then closes
    openDoors(side) { this.setDoors(side, 1); this._chime = [-1, -1]; }
    closeDoors(side = 'both') { for (const k of side === 'both' ? [0, 1] : [side === 'left' ? 0 : 1]) if (this.doorGoal[k] > 0 && this._chime[k] < 0) { this._chime[k] = 1.6; this._emit('chime', k ? 'right' : 'left'); } }
    _emit(type, info) { if (this.onEvent) try { this.onEvent(type, info, this); } catch (e) { console.error(e); } }
    setInteriorVisible(v) { for (const c of this.cars) c.setInteriorVisible(v); }
    setLOD(level) { for (const c of this.cars) c.setLOD(level); }
    // free the per-consist GPU resources (shared design geometry stays cached)
    dispose() {
      for (const c of this.cars) { for (const m of [c.mat, c.matGlass, c.matInt, c.matLod]) if (m) m.dispose(); if (c.skeleton) c.skeleton.dispose(); if (c.group.parent) c.group.parent.remove(c.group); }
      this.signTex.dispose(); if (this.lcdTex) this.lcdTex.dispose(); this.glassClear.dispose();
    }
    _lcd() {
      if (!this.lcdTex && K.makeLcdTexture) {
        this.lcdTex = K.makeLcdTexture(); for (const c of this.cars) c.S.mkLcd.value = this.lcdTex;
        K.updatePis(this.lcdTex, this._disp || { nextStop: '', destination: '' }); K.updateCab(this.lcdTex, this._cab || {});
      }
      return this.lcdTex;
    }
    _buildInterior(car) {
      const d = car.design, b = builders[d.kind];
      if (!b.interior) return;
      if (!d.int) { const t0 = performance.now(); d.int = b.interior(d, Q); d.int.buildMs = performance.now() - t0; }
      this._lcd();
      if (!car.matInt) car.matInt = palMaterial('int', car.S);
      const g = new THREE.Group(); g.name = 'interior';
      const I = new THREE.Matrix4();
      const me = new THREE.SkinnedMesh(d.int.geo, car.matInt); me.bind(car.skeleton, I); me.bindMode = 'detached'; me.boundingSphere = d.sphere.clone(); me.receiveShadow = true; me.castShadow = false; g.add(me);
      if (d.int.glass.attributes.position.count) { const gm = new THREE.SkinnedMesh(d.int.glass, this.glassClear); gm.bind(car.skeleton, I); gm.bindMode = 'detached'; gm.boundingSphere = d.sphere.clone(); gm.renderOrder = 2; g.add(gm); }
      car.root.add(g); g.visible = false; car.int = g;
    }
    // passenger screens + interior next-stop signs: { line, color, lineName, destination, nextStop, arriving, doors
    // ('left'|'right'), transfer, stops: [names], index (current stop index), clock }. Redraws only on change.
    setDisplay(o = {}) {
      const col = o.color || LINE_COLORS[(o.line || '').toLowerCase()] || '#ffe400';
      const s = Object.assign({}, o, { color: col, lineName: o.lineName || (o.line ? o.line[0].toUpperCase() + o.line.slice(1) + ' Line' : '') });
      const k = JSON.stringify(s); if (k === this._dispKey) return; this._dispKey = k; this._disp = s;
      if (o.nextStop !== undefined) this.setNextStop((o.arriving ? 'Arriving: ' : 'Next: ') + o.nextStop);
      if (this.lcdTex) K.updatePis(this.lcdTex, s);
    }
    // cab: { speedMph, atcCodeMph (authorized), targetMph (commanded), effort (-1 brake .. 1 power), mode ('ATO' |
    // 'MANUAL'), doors, nextStop, distFt, clock, cars, destination, lineColor, alarm, handle (-1..1) }. Redraws at ~8 Hz max.
    setCab(o = {}) {
      if (o.codeMph !== undefined && o.atcCodeMph === undefined) o.atcCodeMph = o.codeMph;
      if (o.notch !== undefined && o.effort === undefined) o.effort = Math.abs(o.notch) > 1 ? clamp(o.notch / 4, -1, 1) : o.notch;
      if (o.atc !== undefined && o.alarm === undefined) o.alarm = { warn: 'OVERSPEED', brake: 'ATC BRAKE', penalty: 'PENALTY BRAKE' }[o.atc] || '';
      if (o.color && !o.lineColor) o.lineColor = o.color;
      this._cab = Object.assign(this._cab || {}, o);
      const h = clamp(this._cab.handle !== undefined ? this._cab.handle : (this._cab.effort || 0), -1, 1);
      for (const c of this.cars) if (c.design.boneIdx.handle !== undefined && Math.abs((c.handleA || 0) - h) > 1e-3) { c.handleA = h; c.dirty = true; }
      if (!this.lcdTex) return;
      const now = performance.now(), s = this._cab;
      const key = [Math.round(Math.abs(s.speedMph || 0)), s.atcCodeMph, s.targetMph, Math.round((s.effort || 0) * 20), s.mode, s.doors, s.nextStop, Math.round((s.distFt || 0) / 20), s.clock, s.alarm].join('|');
      if (key === this._cabKey || now - (this._cabT || 0) < 120) return;
      this._cabKey = key; this._cabT = now; K.updateCab(this.lcdTex, s);
    }
    update(dt) {
      dt = clamp(dt || 0, 0, 0.1);
      // chimes then closing
      for (let k = 0; k < 2; k++) if (this._chime[k] >= 0) { this._chime[k] -= dt; if (this._chime[k] < 0) { this._chime[k] = -1; this.doorGoal[k] = 0; this._emit('doors-closing', k ? 'right' : 'left'); } }
      const T = this.doorT, Gl = this.doorGoal; let moved = false;
      for (let k = 0; k < 2; k++) if (T[k] !== Gl[k]) {
        const opening = Gl[k] > T[k], st = dt / (opening ? 2.2 : 2.8), was = T[k];
        T[k] = Math.abs(Gl[k] - T[k]) <= st ? Gl[k] : T[k] + Math.sign(Gl[k] - T[k]) * st; moved = true;
        if (was === 0 && T[k] > 0) this._emit('doors-opening', k ? 'right' : 'left');
        if (T[k] === 1 && was < 1) this._emit('doors-open', k ? 'right' : 'left');
        if (T[k] === 0 && was > 0) this._emit('doors-closed', k ? 'right' : 'left');
      }
      if (moved) this._applyDoorLamps();
      const spin = this.speed * dt / 0.381;
      for (const c of this.cars) {
        if (moved) { c.doorPos[0] = c.flip ? T[1] : T[0]; c.doorPos[1] = c.flip ? T[0] : T[1]; c.dirty = true; }
        if (spin !== 0) { c.wheelAng = (c.wheelAng + (c.flip ? -spin : spin)) % TAU; c.dirty = true; }
        if (c.dirty && c.lod === 0) c._pose();
      }
    }
  }
  function defaultBartOrder(n, order) {
    let o = (order || ORDERS[n] || ('D' + 'E'.repeat(Math.max(0, n - 2)) + 'D')).replace(/[^DEde ]/g, '').toUpperCase();
    // each unit (space-separated) runs D ... D: the first D faces forward, the last D is flipped
    const out = []; let idx = 0;
    for (const unit of o.split(' ').filter(Boolean)) {
      for (let i = 0; i < unit.length; i++) {
        const t = unit[i]; const flip = t === 'D' ? i > 0 : (idx % 2 === 1);
        out.push({ type: t, flip }); idx++;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ sign texture (LED raster)
  const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  let _tmpC = null;
  function makeSignTexture() {
    const c = document.createElement('canvas'); c.width = SIGN.W; c.height = SIGN.H;
    const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
    t.colorSpace = THREE.SRGBColorSpace; t.userData.canvas = c; t.userData.ctx = c.getContext('2d', { willReadFrequently: true });
    return t;
  }
  // render text into LED rows y0..y0+15: the font is drawn at 13 px and thresholded so every LED is on or off
  function ledText(g, text, x0, y0, w, color, align = 'center') {
    if (!_tmpC) { _tmpC = document.createElement('canvas'); }
    _tmpC.width = w; _tmpC.height = 16; const t = _tmpC.getContext('2d', { willReadFrequently: true });
    t.fillStyle = '#000'; t.fillRect(0, 0, w, 16); t.fillStyle = '#fff'; t.font = `700 13px ${FONT}`; t.textBaseline = 'middle';
    const tw = t.measureText(text).width, sc = Math.min(1, (w - 2) / Math.max(1, tw));
    const x = align === 'left' ? 1 : (w - tw * sc) / 2;
    t.setTransform(sc, 0, 0, 1, x, 0); t.fillText(text, 0, 8.5); t.setTransform(1, 0, 0, 1, 0, 0);
    const px = t.getImageData(0, 0, w, 16).data; g.fillStyle = color;
    for (let j = 0; j < 16; j++) for (let i = 0; i < w; i++) if (px[(j * w + i) * 4] > 100) g.fillRect(x0 + i, y0 + j, 1, 1);
  }
  function drawSign(tex, color, text, next) {
    const g = tex.userData.ctx; g.fillStyle = '#000'; g.fillRect(0, 0, SIGN.W, SIGN.H);
    // destination: a 12 x 12 line-colour square, then the terminal in amber
    g.fillStyle = color; g.fillRect(4, 2, 12, 12);
    ledText(g, text, 20, 0, SIGN.W - 22, '#ffa21a');
    // next stop (interior end signs)
    if (next) ledText(g, next, 0, 16, SIGN.W, '#ffa21a'); else ledText(g, text, 0, 16, SIGN.W, '#ffa21a');
    ledText(g, 'BAYLINE METRO', 0, 32, SIGN.W, '#ffa21a');
    tex.needsUpdate = true;
  }

  // ------------------------------------------------------------------------------------------ pose helpers
  // Pose a car from its front/rear bogie pivots (world, top of rail), roll in radians (TrainKit.poseCar semantics).
  function poseCar(car, f, r, roll = 0) {
    const dx = f.x - r.x, dy = f.y - r.y, dz = f.z - r.z, h = Math.hypot(dx, dz) || 1e-9, len = Math.hypot(h, dy);
    const yaw = Math.atan2(-dz, dx), pitch = Math.atan2(dy, h), xm = (car.bogieOffsets[0] + car.bogieOffsets[1]) / 2;
    car.group.rotation.set(roll, yaw, pitch, 'YZX');
    car.group.position.set((f.x + r.x) / 2 - dx / len * xm, (f.y + r.y) / 2 - dy / len * xm, (f.z + r.z) / 2 - dz / len * xm);
  }
  // Pose a whole consist along a track: frame(d, out) fills out {x, y, z, tx, tz, bank?} at distance d along the path
  // (d increasing toward the consist's front, car 0's +X coupler at dFront). Bogies yaw with the track under them.
  const _F = { x: 0, y: 0, z: 0, tx: 1, ty: 0, tz: 0, bank: 0 }, _R = { x: 0, y: 0, z: 0, tx: 1, ty: 0, tz: 0, bank: 0 };
  function poseOnTrack(c, frame, dFront) {
    let d = dFront;
    for (const car of c.cars) {
      const dc = d - car.length / 2; d -= car.length;
      const [bf, br] = car.bogieOffsets;
      frame(dc + bf, _F); frame(dc + br, _R); car._dc = dc;
      const bank = ((_F.bank || 0) + (_R.bank || 0)) / 2;
      poseCar(car, _F, _R, bank);
      const yawBody = Math.atan2(-(_F.z - _R.z), _F.x - _R.x);
      const yF = Math.atan2(-_F.tz, _F.tx) - yawBody, yR = Math.atan2(-_R.tz, _R.tx) - yawBody;
      // bogie 0 of the design sits at +X; a flipped car's design +X is at its rear
      const a = U.wrapAngle(car.flip ? yR : yF), b = U.wrapAngle(car.flip ? yF : yR), nb = car.yaw.length;
      if (Math.abs(a - car.yaw[0]) > 1e-5 || Math.abs(b - car.yaw[nb - 1]) > 1e-5) { car.yaw[0] = a; car.yaw[nb - 1] = b; car.dirty = true; }
      if (car.design.artic) articulate(car, frame, dc, yawBody);
    }
  }

  // Articulated units (the GTW): after the rigid pose from the outer bogies, the end bodies swing about their outer
  // bogies so the joints sit on the track, the middle body spans the two joints, and its bogie follows the track.
  const _J1 = { x: 0, y: 0, z: 0, tx: 1, ty: 0, tz: 0 }, _J2 = { x: 0, y: 0, z: 0, tx: 1, ty: 0, tz: 0 }, _JM = { x: 0, y: 0, z: 0, tx: 1, ty: 0, tz: 0 };
  function articulate(car, frame, dc, yawBody) {
    const A = car.design.artic, g = car.group, cy = Math.cos(yawBody), sy = Math.sin(yawBody), sg = car.flip ? -1 : 1;
    // design-frame joint positions (x) -> track distances; local (design) coordinates of the track points
    const toLocal = (P, out) => { const dx = P.x - g.position.x, dz = P.z - g.position.z; const lx = dx * cy - dz * sy, lz = dx * sy + dz * cy; out[0] = sg * lx; out[1] = sg * lz; return out; };
    frame(dc + sg * A.joints[0], _J1); frame(dc + sg * A.joints[1], _J2); frame(dc + sg * A.mid, _JM);
    const j1 = toLocal(_J1, [0, 0]), j2 = toLocal(_J2, [0, 0]), jm = toLocal(_JM, [0, 0]);
    const st = car.bodySt, pA = A.pivots[0], pB = A.pivots[1];
    st[0].yaw = Math.atan2(j1[1], pA - j1[0]); st[2].yaw = Math.atan2(-j2[1], j2[0] - pB);
    st[1].yaw = Math.atan2(-(j1[1] - j2[1]), j1[0] - j2[0]); st[1].dx = (j1[0] + j2[0]) / 2 - A.mid; st[1].dz = (j1[1] + j2[1]) / 2;
    const ym = U.wrapAngle(Math.atan2(-_JM.tz, _JM.tx) - yawBody); car.yaw[1] = car.flip ? ym : ym; car.bogOff[1][0] = jm[0] - A.mid; car.bogOff[1][1] = jm[1];
    car.dirty = true;
  }
  function createConsist(kind, opts) { return new Consist(kind, opts); }
  K.builders = builders; K.SIGN = SIGN; K.getDesign = getDesign; K.glassMaterial = glassMaterial; K.LINE_COLORS = LINE_COLORS; K.ledText = ledText;
  K.FONT = FONT; K.Consist = Consist; K.Car = Car;

  const createFarBatch = (scene, o) => K.createFarBatch(scene, o);
  return { _k: K, setQuality, createConsist, poseCar, poseOnTrack, createFarBatch, LINE_COLORS, designs, get quality() { return Q; } };
})();
if (typeof window !== 'undefined') (window.__baylineMods = window.__baylineMods || {}).MetroKit = MetroKit;
