// MetroKit: Bayline Metro rolling stock (trains workstream). See notes/bart/trains.md for the API, the research behind
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
  // Low (0): cars never draw their full LOD 0 exterior (simple LOD geometry only; the car you ride in still gets its
  // interior), 1024 px decal atlas and half-size screens; Medium (1): 1024 px atlas, half-size screens. A change releases the designs and
  // atlases no live consist uses any more (consists built before keep theirs until they are disposed).
  function setQuality(level) {
    const q = typeof level === 'number' ? level : (level in QN ? QN[level] : (level ? 4 : 2)), nq = clamp(Math.round(q), 0, 4);
    if (nq === Q) return; Q = nq;
    for (const c of live) c._requalify();
    releaseUnused(true);
  }

  // ------------------------------------------------------------------------------------------ palette
  // Each part's vertices carry uv.x = the palette texel of its material. Channels (4 RGBA8 textures, 256 x 1):
  //   A: albedo (sRGB)                              B: roughness, metalness, clearcoat, pattern id
  //   C: emissive group (0 none, 1..7), emissive weight, anisotropy, grime susceptibility
  //   D: sheen / secondary colour (sRGB, pattern-specific), alpha = interior flag (receives the fake interior lighting)
  const PAT = { none: 0, aluE: 1, aluD: 2, aluDoor: 3, paint: 4, roof: 5, rubber: 6, grille: 7, louver: 8, tread: 9, floor: 10,
    vinyl: 11, fabric: 12, plastic: 13, cast: 14, wheel: 15, coil: 16, lens: 17, led: 18, lcd: 19, decal: 20, topbar: 21, pole: 22,
    wall: 23, ceil: 24, mask: 25, glow: 26, aluDmu: 27, paintDmu: 28, apmBody: 29, num: 30, lodwin: 31, baked: 32 };
  // emissive light groups (per-car levels in mkLv[8])
  const G = { none: 0, interior: 1, head: 2, tail: 3, marker: 4, bar: 5, doorR: 6, sign: 7, doorL: 8, cab: 9, idoorR: 10, idoorL: 11, headB: 12, tailB: 13 };
  const NLV = 16;
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
  pal('podSilver', '#c9ced3', 0.22, 0.35, { cc: 1, eg: G.head, ew: 0.05 });            // headlight housings behind their covers
  pal('headLamp', '#fbf8ef', 0.05, 0, { cc: 1, pat: PAT.lens, eg: G.head });
  pal('tailLamp', '#d0121c', 0.08, 0, { cc: 1, pat: PAT.lens, eg: G.tail });
  pal('headLampB', '#fbf8ef', 0.05, 0, { cc: 1, pat: PAT.lens, eg: G.headB });
  pal('tailLampB', '#d0121c', 0.08, 0, { cc: 1, pat: PAT.lens, eg: G.tailB });
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
  pal('baked', '#ffffff', 0.4, 0, { pat: PAT.baked });                            // LODs: colour + material code from the design's atlas
  // --- interior (inside = receives the fake interior lighting, dimmed sky light)
  const IN = { inside: true };
  pal('wallInt', '#e4e3de', 0.55, 0, { ...IN, pat: PAT.wall, gr: 0.2 });
  pal('wallInt2', '#d3d3cf', 0.5, 0, { ...IN, pat: PAT.plastic, gr: 0.2 });
  pal('lime', '#b8c43a', 0.5, 0, { ...IN, pat: PAT.plastic, gr: 0.15 });
  pal('ceil', '#e8e8e4', 0.6, 0, { ...IN, pat: PAT.ceil, gr: 0.1 });
  pal('lightStrip', '#fffdf5', 0.3, 0, { ...IN, eg: G.interior, ew: 3.2 });
  pal('floor', '#45484c', 0.62, 0, { ...IN, pat: PAT.floor, gr: 0.5 });              // dark grey resilient floor (photos)
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
  // a 1 x 1 texture for samplers with nothing to show yet
  let _blank = null;
  function blankTex() { if (!_blank) { _blank = new THREE.DataTexture(new Uint8Array([200, 202, 205, 110]), 1, 1); _blank.needsUpdate = true; } return _blank; }
  // world-wide state shared by every MetroKit material: wetness (0 dry .. 1 soaked; follows the rain, see setWet)
  const MKG = { mkWet: { value: 0 }, mkTimeG: U.uTime || { value: 0 } };
  function carUniforms() {
    return {
      mkWet: MKG.mkWet, mkTimeG: MKG.mkTimeG, mkSpd: { value: 0 },   // (mkSpd: the car's speed along its design +X)
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
      mkBake: { value: blankTex() },                       // the design's baked atlas (LODs)
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
    uniform float mkLv[16]; uniform float mkNight, mkAge, mkSeed, mkBar, mkHalfW, mkFloorY, mkCeilY, mkWet, mkTimeG, mkSpd;
    uniform vec4 mkIndoor, mkLamp;
    uniform sampler2D mkSign, mkLcd, mkAtlas, mkBake; uniform vec2 mkSignRes; uniform float mkNum[6];
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
      float fill = 0.36 + 0.1 * n.y + 0.42 * max(-n.y, 0.0);
      return e + fill;
    }
    // height field of a pattern (metres) for bump normals
    float mkHt(vec3 p, float pat) {
      if (pat == 1.0 || pat == 2.0 || pat == 3.0) {
        float h = -0.0012 * mkLine(p.y, 1.675, 0.028, 0.004);                               // belt groove
        h += 0.00035 * (mkV(vec2(p.x * 0.9, p.y * 2.2)) - 0.5);                              // oil-canning
        if (pat < 2.5) {
          // extrusion joints (floor line, cant rail), the end-frame seams, and a line of huck bolts along the cant rail
          h -= 0.0009 * (mkLine(p.y, 1.04, 0.006, 0.002) + mkLine(p.y, 2.955, 0.006, 0.002) + mkLine(abs(p.x), 9.58, 0.005, 0.002));
          vec2 hb = vec2(fract(p.x / 0.075) - 0.5, (p.y - 2.935) / 0.075);
          h += 0.0011 * (1.0 - smoothstep(0.1, 0.16, length(hb))) * step(abs(p.y - 2.935), 0.02);
        }
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
      #ifdef MK_BAKE
        if (mkPat == 30.0) discard;                             // (car numbers are per car: drawn over the baked LODs)
      #endif
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
        if (mkPat < 2.5) col *= 1.0 - 0.25 * fade * (mkLine(p.y, 1.04, 0.005, fw) + mkLine(p.y, 2.955, 0.005, fw) + mkLine(abs(p.x), 9.58, 0.004, fw));
        mkRough = mix(mkRough, 0.6, mkBelt); mkMetal = mix(mkMetal, 0.2, mkBelt); mkAniso *= 1.0 - mkBelt;
      } else if (mkPat == 4.0 || mkPat == 25.0 || mkPat == 28.0) {    // paint / gloss black: orange peel
        col *= 0.985 + 0.03 * mkV(p.xy * 31.0 + p.z * 23.0);
        mkCCR = 0.03 + 0.03 * mkV(p.zy * 13.0);
        // the GTW's cab front: white, the side's blue wrapping round the lower corners (its edge sweeps out as it rises)
        if (mkPat == 28.0) { float az = abs(p.z), eb = 0.7 + 0.38 * smoothstep(0.55, 1.95, p.y);
          float bl = smoothstep(-fw, fw, az - eb) * step(p.y, 2.0); col = mix(col, vec3(0.008, 0.33, 0.72), bl); }
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
        col *= 0.9 + 0.12 * s2; col = mix(col, vec3(0.3, 0.3, 0.3), step(0.955, s1) * 0.3 * fade);
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
      } else if (mkPat == 32.0) {                                // baked LOD: the full-detail look from the design's atlas
        // A: material code (0 paint, 0.5 x metalness for metal, 0.86 far pane, 1 window onto the lit cabin)
        vec4 bk = texture2D(mkBake, mkUv1);
        float code = bk.a, win = smoothstep(0.72, 0.8, code), cab = smoothstep(0.92, 0.97, code);
        float metal = clamp(code * 2.0, 0.0, 1.0) * (1.0 - win);
        col = mix(bk.rgb, vec3(0.016, 0.02, 0.022), win);
        mkMetal = metal * 0.92; mkRough = mix(mix(0.34, 0.33, metal), 0.05, win); mkAniso = metal * 0.6;
        #ifdef MK_LOD
          mkMetal *= 0.65; mkRough += 0.06 * metal;        // (no anisotropic spread on this material: less mirror, more satin)
        #endif
        mkCC = max(1.0 - metal, win); mkCCR = 0.035;
        // the cabin behind the glass (baked at its own light, half scale), a little daylight by day; far panes show the
        // outside through two tinted panes by day
        mkEm += bk.rgb * 2.0 * (cab * (mkLv[1] + 0.3 * (1.0 - mkNight)) + (win - cab) * mkLv[1]) + (win - cab) * vec3(0.12, 0.14, 0.16) * (1.0 - mkNight);
      } else if (mkPat == 31.0) {                                // far-LOD window: lit cabin impression (ceiling glow, seat backs)
        float yy = fract((p.y - 1.89) / 0.95), sb = step(yy, 0.35) * step(0.1, fract(p.x / 0.755 + 0.3));
        mkEmW *= (0.35 + 0.65 * smoothstep(0.55, 1.0, yy)) * (1.0 - 0.6 * sb);
        mkEmW *= 0.45 + 0.55 * mkNight;
        // the lit cabin's colour (not the dark glass albedo), about the LOD0 impression's average through the tint
        mkEm += vec3(0.46, 0.45, 0.41) * mkLv[1] * mkEmW; eg = 0.0;
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
      // ---------------- rain: a water film (glossy, a clear coat of its own) pooling on up-facing surfaces, trickles
      // running down the sides (swept back along the car at speed), porous parts darken
      if (mkWet > 0.002 && mkInside < 0.5) {
        float up = smoothstep(0.3, 0.9, mkN.y), run = clamp(abs(mkSpd) / 15.0, 0.0, 1.0);
        float tr = mkV(vec2((p.x + sign(mkSpd) * run * p.y * 2.5) * 9.0 + p.z * 3.0, p.y * 0.9 + mkTimeG * (0.2 + 0.8 * run)));
        float film = mkWet * clamp(0.4 + 0.6 * max(up, 0.6 * smoothstep(0.6, 0.9, tr)), 0.0, 1.0);
        mkRough = mix(mkRough, max(0.035, mkRough * 0.25), film); mkAniso *= 1.0 - film * 0.7;
        mkCC = max(mkCC, film * 0.85); mkCCR = mix(mkCCR, 0.025, film);
        col *= 1.0 - 0.18 * film * (1.0 - mkMetal) * (1.0 - smoothstep(0.6, 0.9, dot(col, vec3(0.333))));
      }
      // ---------------- bump from the pattern's height field (object space -> view space)
      if (mkPat > 0.5 && mkPat != 18.0 && mkPat != 19.0 && mkPat != 20.0 && mkPat != 30.0 && mkPat != 32.0 && fw < 0.03) {
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
    if (variant === 'lod') { m = new THREE.MeshStandardMaterial(P); m.defines = { MK_LOD: 1 }; }
    else if (variant === 'bake') { m = new THREE.MeshBasicMaterial({ toneMapped: false }); m.defines = { MK_BAKE: 1 }; }   // (unlit: albedo + code out; one program for screen and target)
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
      if (variant === 'bake') f = f.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n gl_FragColor = vec4(mkAlb, clamp(mkMetal, 0.0, 1.0) * 0.5);');
      if (variant !== 'lod' && variant !== 'bake') {
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
    // the triangles of the given palette entries, as flat vertex lists (for copying parts of a full model onto a LOD)
    extract(names) {
      const us = new Set(names.map(n => palU(n))), o = { P: [], N: [], T: [], T1: [], K: [] }, P = this.P, N = this.N, T = this.T, T1 = this.T1, B = this.K, I = this.I;
      for (let f = 0; f < I.length; f += 3) {
        if (!us.has(T[I[f] * 2]) || !us.has(T[I[f + 1] * 2]) || !us.has(T[I[f + 2] * 2])) continue;
        for (let k = 0; k < 3; k++) { const v = I[f + k]; o.P.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); o.N.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]); o.T.push(T[v * 2], T[v * 2 + 1]); o.T1.push(T1[v * 2], T1[v * 2 + 1]); o.K.push(B[v]); }
      }
      return o;
    }
    // append extracted triangles, pushed out along their normals by lift (and shifted by dx along x)
    paste(o, lift = 0, dx = 0) {
      if (!o) return this;
      const base = this.count, n = o.P.length / 3;
      for (let v = 0; v < n; v++) {
        this.P.push(o.P[v * 3] + o.N[v * 3] * lift + dx, o.P[v * 3 + 1] + o.N[v * 3 + 1] * lift, o.P[v * 3 + 2] + o.N[v * 3 + 2] * lift); this.N.push(o.N[v * 3], o.N[v * 3 + 1], o.N[v * 3 + 2]);
        this.T.push(o.T[v * 2], o.T[v * 2 + 1]); this.T1.push(o.T1[v * 2], o.T1[v * 2 + 1]); this.K.push(o.K[v]);
      }
      for (let v = 0; v < n; v++) this.I.push(base + v);
      return this;
    }
    // a plate / prism: outline (+ holes) in the x-y plane (current transform), extruded from z0 to z1: both caps and the
    // side walls (flat normals, outward)
    prism(outline, holes, z0, z1) {
      const za = Math.min(z0, z1), zb = Math.max(z0, z1);
      this.shape(outline, holes, (a, b) => ({ p: [a, b, zb], n: [0, 0, 1] }));
      this.shape(outline, holes, (a, b) => ({ p: [a, b, za], n: [0, 0, -1] }));
      const walls = (ring, outer) => {
        let ar = 0; for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; ar += p[0] * q[1] - q[0] * p[1]; }
        const sg = (ar > 0 ? 1 : -1) * (outer ? 1 : -1);
        for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length], dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy); if (L < 1e-9) continue;
          const nx = sg * dy / L, ny = -sg * dx / L;
          this.quadA(this.v(p[0], p[1], za, nx, ny, 0), this.v(q[0], q[1], za, nx, ny, 0), this.v(q[0], q[1], zb, nx, ny, 0), this.v(p[0], p[1], zb, nx, ny, 0)); }
      };
      walls(outline, true); for (const h of holes || []) walls(h, false);
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
  // Exterior glass. With the interior hidden it ray-casts an impression of the lit cabin behind it ("interior
  // mapping", per design in d.imap): the cabin's convex section (floor, side walls, sloped ceiling with its LED bands)
  // closed by the end walls; on the far wall its windows (the scene's environment seen through a second tinted pane,
  // plus a faint reflection of the cabin), doors with their windows, ads and passenger screens; seat rows (backs and
  // cushions), longitudinal benches, doorway partitions, grab poles and the overhead rails; seated and standing
  // passengers by the car's load; the D cab behind the windscreen. It is shaded like the real interior (the same
  // line-light model, daylight scaled by mkIndoor, dimmed underground through the Under hook) so nothing jumps when the
  // real interior is built; the glass then turns clear with the same tint (constant-colour blending keeps the
  // reflections at full strength).
  const GLASS_TINT = new THREE.Color(0.42, 0.47, 0.46);          // per pane (grey-green tinted glazing)
  const GLASS_FRAG_HEAD = `
    uniform vec3 mkCamO, mkTint; uniform float mkNight, mkIntOn, mkSeed, mkHalfW, mkFloorY, mkCeilY, mkLoad, mkWet, mkTimeG, mkSpd; uniform float mkLv[16];
    uniform vec4 mkIndoor, mkLamp, mkCab, mkCabI, mkRail, mkDoorWin, mkBand, mkEnds, mkCnt;
    uniform vec4 mkRows[40]; uniform float mkRowN, mkImDet; uniform vec2 mkDoorO;
    uniform vec4 mkSec[8]; uniform vec4 mkWin[16]; uniform vec4 mkDoor[4]; uniform vec4 mkPole[16]; uniform vec4 mkStand[8]; uniform vec4 mkPan[12];
    uniform vec4 mkSgnA[6]; uniform vec4 mkSgnB[6]; uniform sampler2D mkSign; uniform vec2 mkSignRes;
    varying vec3 mkP; varying vec3 mkN; varying vec2 mkUv; varying vec2 mkUv1; varying vec3 mkAx; varying vec3 mkAy; varying vec3 mkAz;
    const vec3 MK_WALL = vec3(0.776, 0.768, 0.730), MK_WALL2 = vec3(0.651, 0.651, 0.624), MK_CEIL = vec3(0.807, 0.807, 0.776);
    const vec3 MK_FLOOR = vec3(0.058, 0.064, 0.072), MK_BLUE = vec3(0.011, 0.136, 0.337), MK_LIME = vec3(0.451, 0.521, 0.011);
    const vec3 MK_SHELL = vec3(0.578, 0.604, 0.617), MK_POLE = vec3(0.56, 0.59, 0.62), MK_DOORI = vec3(0.60, 0.61, 0.60);
    float mkLitK, mkDayK, mkHitFar; vec3 mkDayA;
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
    float gH(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    vec3 mkToView(vec3 d) { return mkAx * d.x + mkAy * d.y + mkAz * d.z; }
    // raindrops on the glass (q: metres in the pane, x along the car or across the front, y up): beads that creep down
    // when the train stands and stream back along the car at speed (stretched, moving); returns the bead's surface
    // slope in the pane (xy) and its coverage (z), faded out where a bead would be smaller than a pixel
    vec3 mkDrop;
    // one layer of beads on a grid of cells cs (in flow space f); density: the share of cells with a bead
    vec3 mkBeads(vec2 f, vec2 cs, float density, float seed, vec2 flow) {
      vec2 id = floor(f / cs), fr = fract(f / cs) - 0.5;
      float h = gH(id + seed), h2 = gH(id.yx * 1.7 + seed * 0.37);
      if (h > density) return vec3(0.0);
      vec2 d = fr - (vec2(h2, gH(id * 1.3 + seed + 5.0)) - 0.5) * 0.4;
      float r = 0.1 + 0.26 * h2 * h2, l = length(d);
      if (l > r) return vec3(0.0);
      vec2 sl = d / r; sl = flow * sl.x - vec2(-flow.y, flow.x) * sl.y;     // back to pane axes
      return vec3(sl * (0.55 + 0.25 * h2), 1.0);
    }
    vec3 mkDrops(vec2 q, float v, float front) {
      if (mkWet < 0.01) return vec3(0.0);
      float run = front > 0.5 ? 0.0 : clamp(abs(v) / 12.0, 0.0, 1.0);
      vec2 flow = normalize(vec2(-sign(v) * run * 3.0, -1.0 + 0.7 * run));
      vec2 f = vec2(dot(q, flow), dot(q, vec2(-flow.y, flow.x)));
      vec2 cs = vec2(0.02 + 0.05 * run, 0.014);
      float px = length(fwidth(q)) / cs.y, vis = 1.0 - smoothstep(0.25, 0.8, px);
      if (vis <= 0.0) return vec3(0.0, 0.0, mkWet * 0.4);
      // fine beads (most of them creep slowly), a sparser layer of big drops that slide faster
      vec3 b = mkBeads(f + vec2(mkTimeG * (0.004 + 0.9 * run * run), 0.0), cs, mkWet * 0.42, 17.0, flow);
      if (b.z < 0.5) b = mkBeads(f + vec2(mkTimeG * (0.03 + 1.2 * run * run), 0.31), cs * 2.6, mkWet * 0.3, 41.0, flow);
      return vec3(b.xy * vis, b.z * vis + mkWet * 0.25 * (1.0 - vis));
    }
    float mkRB(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
    // the cabin's two LED line lights + multi-bounce fill (mkIntLight of the palette material)
    float mkIL(vec3 p, vec3 n) {
      float e = 0.0;
      for (int k = 0; k < 2; k++) {
        vec3 L = vec3(0.0, mkLamp.y, k == 0 ? mkLamp.x : -mkLamp.x) - vec3(0.0, p.y, p.z);
        float d = length(L) + 0.08; L /= d;
        e += max(dot(n, L), 0.0) * smoothstep(mkLamp.z + 0.8, mkLamp.z - 0.8, abs(p.x)) * 0.42 / d;
      }
      return e + 0.36 + 0.1 * n.y + 0.42 * max(-n.y, 0.0);
    }
    // radiance of an interior surface (albedo alb, car-space normal n): the cabin light (mkLitK) with contact shadows,
    // daylight (the scene's ambient/hemisphere/IBL irradiance x mkIndoor.x, x the Under daylight) and the tunnel ambient
    vec3 mkShade(vec3 p, vec3 n, vec3 alb) {
      float ao = 1.0 - 0.3 * exp(-max(p.y - mkFloorY, 0.0) * 7.0) * step(p.y, mkFloorY + 0.6);
      ao *= 1.0 - 0.18 * smoothstep(0.25, 0.0, mkHalfW - abs(p.z));
      #ifdef MK_BAKE
        return alb * (mkLitK * mkIL(p, n) * ao);                  // (the bake: the cabin's own light only)
      #else
      vec3 nv = normalize(mkToView(n)), e = ambientLightColor;
      #if NUM_HEMI_LIGHTS > 0
        e += getHemisphereLightIrradiance(hemisphereLights[0], nv);
      #endif
      #if defined(USE_ENVMAP) && defined(ENVMAP_TYPE_CUBE_UV)
        e += getIBLIrradiance(nv);
      #endif
      return alb * (mkLitK * mkIL(p, n) * ao + e * (mkIndoor.x * mkDayK * RECIPROCAL_PI) + mkDayA);
      #endif
    }
    // the outside seen through a far window (the scene's environment, sharp)
    vec3 mkOut(vec3 rd) {
      #ifdef MK_BAKE
        mkHitFar = 1.0; return vec3(0.0);                         // (the bake marks the outside; the LOD shades it live)
      #endif
      #if defined(USE_ENVMAP) && defined(ENVMAP_TYPE_CUBE_UV)
        vec3 wd = inverseTransformDirection(normalize(mkToView(rd)), viewMatrix);
        return textureCubeUV(envMap, wd, 0.0).rgb * envMapIntensity * mkDayK;
      #else
        return mix(vec3(0.5, 0.58, 0.66), vec3(0.01, 0.012, 0.02), mkNight) * mkDayK;
      #endif
    }
    // a far pane: the outside through it (tinted again) and a faint reflection of the lit cabin
    // the cabin as a pane at h (normal n, facing in) reflects it: the shell only (floor, walls with their window band
    // showing the outside, the ceiling with its lit bands), no furniture
    vec3 mkShellRefl(vec3 ro, vec3 rd) {
      float hw = mkHalfW, fy = mkFloorY, tH = 1e9, id = 1.0; vec3 nrm = vec3(0.0, 1.0, 0.0);
      if (rd.y < -1e-5) { tH = (fy - ro.y) / rd.y; id = 0.0; }
      if (abs(rd.z) > 1e-5) { float t = (sign(rd.z) * hw - ro.z) / rd.z; if (t > 0.0 && t < tH) { tH = t; id = 1.0; nrm = vec3(0.0, 0.0, -sign(rd.z)); } }
      for (int k = 0; k < 8; k++) { vec4 P = mkSec[k]; if (P.w < 0.0) break;
        float den = P.x * rd.z + P.y * rd.y; if (den < 1e-5) continue;
        float t = (P.z - P.x * ro.z - P.y * ro.y) / den; if (t > 0.0 && t < tH) { tH = t; id = 2.0; nrm = -vec3(0.0, P.y, P.x); } }
      if (abs(rd.x) > 1e-5) { float t = ((rd.x > 0.0 ? mkCab.y : mkCab.x) - ro.x) / rd.x; if (t > 0.0 && t < tH) { tH = t; id = 9.0; nrm = vec3(-sign(rd.x), 0.0, 0.0); } }
      vec3 h = ro + rd * tH;
      if (id == 2.0) { float az = abs(h.z); if (az > mkBand.x && az < mkBand.y) return vec3(1.0, 0.99, 0.95) * mkLitK * 3.2; return mkShade(h, nrm, MK_CEIL); }
      if (id == 1.0) { float y0 = mkCnt.x > 0.5 ? mkWin[0].z : fy + 0.85, y1 = mkCnt.x > 0.5 ? mkWin[0].w : fy + 1.85;
        if (h.y > y0 && h.y < y1) return mkOut(rd) * mkTint; return mkShade(h, nrm, MK_WALL); }
      return mkShade(h, nrm, id == 0.0 ? MK_FLOOR * 1.3 : MK_WALL2);
    }
    // a far pane at h: the outside through it (tinted again) and the lit cabin reflected in it (~14 %: it is what
    // lights these panes at night, when the outside is dark)
    vec3 mkFarPane(vec3 h, vec3 rd) {
      vec3 o = mkOut(rd) * mkTint;
      #ifdef MK_BAKE
        float far = mkHitFar;
      #endif
      vec3 rr = vec3(rd.x, rd.y, -rd.z), r = mkShellRefl(h + rr * 0.02, rr);
      #ifdef MK_BAKE
        mkHitFar = far > 0.5 ? far : mkHitFar;
      #endif
      return o + r * 0.14;
    }
    vec3 mkCloth(float h) {
      vec3 c = vec3(0.016, 0.017, 0.02);
      c = mix(c, vec3(0.02, 0.03, 0.08), step(0.3, h)); c = mix(c, vec3(0.1, 0.1, 0.1), step(0.48, h));
      c = mix(c, vec3(0.04, 0.08, 0.17), step(0.6, h)); c = mix(c, vec3(0.3, 0.035, 0.035), step(0.72, h));
      c = mix(c, vec3(0.08, 0.1, 0.04), step(0.8, h)); c = mix(c, vec3(0.42, 0.34, 0.22), step(0.87, h));
      c = mix(c, vec3(0.62, 0.62, 0.6), step(0.93, h)); c = mix(c, vec3(0.55, 0.3, 0.05), step(0.97, h));
      return c;
    }
    vec3 mkLegs(float h) { return h < 0.45 ? vec3(0.012, 0.013, 0.016) : (h < 0.8 ? vec3(0.03, 0.05, 0.1) : vec3(0.2, 0.17, 0.11)); }
    vec3 mkSkin(float h) { return mix(vec3(0.5, 0.31, 0.22), vec3(0.055, 0.032, 0.022), h * h); }
    vec3 mkHair(float h) { return h < 0.6 ? vec3(0.01, 0.008, 0.007) : (h < 0.85 ? vec3(0.07, 0.04, 0.018) : (h < 0.95 ? vec3(0.32, 0.24, 0.12) : vec3(0.35))); }
    // nearest entry of a sphere / an upright elliptic cylinder (radii along x and z, capped at y1); 1e9 when missed
    float mkSph(vec3 ro, vec3 rd, vec3 c, float r, inout vec3 n) {
      vec3 o = ro - c; float b = dot(o, rd), h = b * b - dot(o, o) + r * r; if (h < 0.0) return 1e9;
      float t = -b - sqrt(h); if (t <= 0.0) return 1e9; n = (o + rd * t) / r; return t;
    }
    float mkCylE(vec3 ro, vec3 rd, vec2 c, vec2 rad, float y0, float y1, inout vec3 n) {
      vec2 o = (ro.xz - c) / rad, d = rd.xz / rad; float a = dot(d, d); if (a < 1e-8) return 1e9;
      float b = dot(o, d), h = b * b - a * (dot(o, o) - 1.0); if (h < 0.0) return 1e9;
      float t = (-b - sqrt(h)) / a; if (t <= 0.0) return 1e9;
      float y = ro.y + rd.y * t;
      if (y > y1 && rd.y < 0.0) { float tc = (y1 - ro.y) / rd.y; vec2 q = (ro.xz + rd.xz * tc - c) / rad; if (dot(q, q) < 1.0) { n = vec3(0.0, 1.0, 0.0); return tc; } return 1e9; }
      if (y < y0 || y > y1) return 1e9;
      vec2 q = (o + d * t) / rad; n = normalize(vec3(q.x, 0.0, q.y)); return t;
    }
    // a passenger: body (elliptic cylinder from b.y to the shoulders) and head (centre hh above b); standing ones
    // show their trousers below the hips
    void mkPerson(vec3 ro, vec3 rd, vec3 b, float hh, vec2 rad, float key, float standing, inout float tB, inout vec3 cB, inout vec3 nB) {
      vec3 n = vec3(0.0, 1.0, 0.0);
      float t = mkSph(ro, rd, b + vec3(0.0, hh, 0.0), 0.1, n);
      if (t < tB) { tB = t; nB = n; float hk = gH(vec2(key, 2.3)); cB = n.y > (hk < 0.3 ? -0.25 : 0.3) ? mkHair(gH(vec2(key, 8.1))) : mkSkin(gH(vec2(key, 1.7))); }
      t = mkCylE(ro, rd, b.xz, rad, b.y, b.y + hh - 0.16, n);
      if (t < tB) { tB = t; nB = n; float y = ro.y + rd.y * t - b.y;
        cB = standing > 0.5 && y < hh - 0.7 ? mkLegs(gH(vec2(key, 4.4))) : mkCloth(gH(vec2(key, 3.9))); }
    }
    // the far side wall at h (z = +-halfW): doors, windows, ads / screens, the wall itself
    vec3 mkWall(vec3 h, vec3 n, vec3 rd) {
      float fy = mkFloorY, side = sign(h.z);
      for (int k = 0; k < 4; k++) { if (float(k) >= mkCnt.y) break; vec4 D = mkDoor[k]; float ax = abs(h.x - D.x);
        if (ax < D.y && h.y < D.z) {
          if (ax < 0.012) return mkShade(h, n, vec3(0.02));
          if (ax > mkDoorWin.x && ax < mkDoorWin.y && h.y > mkDoorWin.z && h.y < mkDoorWin.w) return mkFarPane(h, rd);
          return mkShade(h, n, MK_DOORI * (h.y < fy + 0.12 ? 0.5 : 1.0));
        }
        if (ax < D.y + 0.035 && h.y < D.z + 0.035) return mkShade(h, n, vec3(0.03));
      }
      if (mkCnt.x > 0.5) {
        for (int k = 0; k < 16; k++) { if (float(k) >= mkCnt.x) break; vec4 W = mkWin[k];
          float d = mkRB(h.xy - vec2(0.5 * (W.x + W.y), 0.5 * (W.z + W.w)), vec2(0.5 * (W.y - W.x), 0.5 * (W.w - W.z)), 0.09);
          if (d < 0.0) return mkFarPane(h, rd);
          if (d < 0.014) return mkShade(h, n, vec3(0.025));                  // gasket
          if (d < 0.065) return mkShade(h, n, MK_WALL2 * 0.82);             // the window reveal
        }
      } else {
        // no window list: a generic band of windows
        if (h.y > fy + 0.85 && h.y < fy + 1.85 && fract(h.x / 1.4 + 0.37) > 0.1) return mkFarPane(h, rd);
      }
      for (int k = 0; k < 12; k++) { if (float(k) >= mkCnt.w) break; vec4 A = mkPan[k]; if (A.z * side < 0.0) continue;
        vec2 b = A.w < 1.5 ? vec2(0.23, 0.345) : vec2(0.27, 0.155), q = h.xy - A.xy;
        if (abs(q.x) < b.x + 0.025 && abs(q.y) < b.y + 0.025) {
          if (abs(q.x) > b.x || abs(q.y) > b.y) return mkShade(h, n, A.w < 1.5 ? vec3(0.35) : vec3(0.015));
          if (A.w < 1.5) { float hh = gH(vec2(A.x * 3.1 + mkSeed, A.y));
            vec3 pc = 0.5 + 0.45 * cos(6.2831 * (hh + vec3(0.0, 0.33, 0.67)));
            pc = mix(pc * pc, vec3(0.75), 0.6 * step(0.55, fract(q.y / b.y * 1.3 + hh))); return mkShade(h, n, pc); }
          float v = q.y / b.y;
          return vec3(0.01, 0.015, 0.03) + (step(0.6, v) * vec3(0.25, 0.45, 0.9) + step(abs(v + 0.1), 0.05) * vec3(0.9, 0.75, 0.2) * step(abs(q.x), b.x * 0.8)) * mkLv[7] * 0.8;
        }
      }
      vec3 c = MK_WALL;
      if (h.y < fy + 0.2) c = vec3(0.42);
      c *= 1.0 - 0.9 * step(abs(h.y - fy - 0.87), 0.012);
      return mkShade(h, n, c);
    }
    // the D cab behind the windscreen / cab windows (mkCabI: back wall x, desk front x, desk top y, 1 = a cab)
    vec3 mkCabView(vec3 ro, vec3 rd) {
      float fy = mkFloorY, hw = mkHalfW - 0.12;
      if (mkCabI.w < 0.5) return mkShade(ro, vec3(sign(-rd.x), 0.0, 0.0), vec3(0.1));
      float keep = mkLitK; mkLitK = 0.12 * mkLv[9] * (1.0 - 0.85 * mkNight);        // the cab is dim (no ceiling bands on)
      float tH = 1e9, id = 0.0; vec3 n = vec3(0.0, 1.0, 0.0);
      if (rd.y < -1e-5) tH = (fy - ro.y) / rd.y;
      if (rd.y > 1e-5) { float t = (mkCeilY - 0.1 - ro.y) / rd.y; if (t < tH) { tH = t; id = 2.0; n = vec3(0.0, -1.0, 0.0); } }
      if (abs(rd.z) > 1e-5) { float t = (sign(rd.z) * hw - ro.z) / rd.z; if (t > 0.0 && t < tH) { tH = t; id = 1.0; n = vec3(0.0, 0.0, -sign(rd.z)); } }
      if (rd.x < -1e-5) { float t = (mkCabI.x - ro.x) / rd.x; if (t > 0.0 && t < tH) { tH = t; id = 9.0; n = vec3(1.0, 0.0, 0.0); } }
      if (rd.y < -1e-5) { float t = (mkCabI.z - ro.y) / rd.y; vec3 h = ro + rd * t; if (t > 0.0 && t < tH && h.x > mkCabI.y) { tH = t; id = 3.0; n = vec3(0.0, 1.0, 0.0); } }
      if (rd.x > 1e-5) { float t = (mkCabI.y - ro.x) / rd.x; vec3 h = ro + rd * t; if (t > 0.0 && t < tH && h.y < mkCabI.z) { tH = t; id = 4.0; n = vec3(-1.0, 0.0, 0.0); } }
      // the operator's seat (a dark box) and the cab back wall's door
      { vec3 b0 = vec3(mkCabI.x + 0.25, fy + 0.42, 0.44), b1 = vec3(mkCabI.x + 0.7, fy + 1.32, 1.0);
        vec3 ia = 1.0 / rd, t0 = (b0 - ro) * ia, t1 = (b1 - ro) * ia, tn = min(t0, t1), tf = max(t0, t1);
        float tN = max(max(tn.x, tn.y), tn.z), tF = min(min(tf.x, tf.y), tf.z);
        if (tN < tF && tN > 0.0 && tN < tH) { tH = tN; id = 5.0; n = tN == tn.x ? vec3(-sign(rd.x), 0.0, 0.0) : (tN == tn.y ? vec3(0.0, -sign(rd.y), 0.0) : vec3(0.0, 0.0, -sign(rd.z))); } }
      vec3 h = ro + rd * tH, c;
      if (id == 3.0) {
        c = mkShade(h, n, vec3(0.45));
        vec2 q = vec2(h.x - mkCabI.y - 0.3, h.z - 0.72);
        if (abs(q.x) < 0.12 && abs(abs(q.y) - 0.2) < 0.14) c = vec3(0.008) + vec3(0.04, 0.12, 0.1) * mkLv[7];
      } else if (id == 5.0) c = mkShade(h, n, vec3(0.012, 0.016, 0.035));
      else if (id == 9.0) c = abs(h.z) < 0.3 && h.y > fy + 1.0 && h.y < fy + 1.8 ? mkLitK * vec3(0.2) + keep * vec3(0.18) : mkShade(h, n, vec3(0.3));
      else if (id == 0.0) c = mkShade(h, n, vec3(0.06));
      else c = mkShade(h, n, id == 4.0 ? vec3(0.2) : vec3(0.32));
      mkLitK = keep;
      return c;
    }
    // what a ray from the glass sees inside the car (radiance before the near pane)
    vec3 mkInterior(vec3 ro, vec3 rd) {
      float hw = mkHalfW, fy = mkFloorY;
      if (ro.x > mkCab.y + 0.05) return mkCabView(ro, rd);
      if (ro.x < mkCab.x - 0.05) return mkShade(ro, vec3(sign(-rd.x), 0.0, 0.0), vec3(0.1));
      // ---- the shell: floor, side walls, the ceiling facets (a convex section), the end walls
      float tH = 1e9, id = 1.0; vec3 nrm = vec3(0.0, 1.0, 0.0);
      if (rd.y < -1e-5) { tH = (fy - ro.y) / rd.y; id = 0.0; }
      if (abs(rd.z) > 1e-5) { float t = (sign(rd.z) * hw - ro.z) / rd.z; if (t > 0.0 && t < tH) { tH = t; id = 1.0; nrm = vec3(0.0, 0.0, -sign(rd.z)); } }
      for (int k = 0; k < 8; k++) { vec4 P = mkSec[k]; if (P.w < 0.0) break;
        float den = P.x * rd.z + P.y * rd.y; if (den < 1e-5) continue;
        float t = (P.z - P.x * ro.z - P.y * ro.y) / den; if (t > 0.0 && t < tH) { tH = t; id = 2.0; nrm = -vec3(0.0, P.y, P.x); } }
      if (abs(rd.x) > 1e-5) { float t = ((rd.x > 0.0 ? mkCab.y : mkCab.x) - ro.x) / rd.x; if (t > 0.0 && t < tH) { tH = t; id = 9.0; nrm = vec3(-sign(rd.x), 0.0, 0.0); } }
      // ---- what stands in front of it (only rows within the ray's x span are tested)
      float tB = tH; vec3 cB = vec3(0.0), nB = nrm; float metal = 0.0;
      float xe = ro.x + rd.x * min(tH, 14.0), xlo = min(ro.x, xe) - 0.7, xhi = max(ro.x, xe) + 0.7;
      float pOcc = clamp(mkLoad * 1.35, 0.0, 0.95), nRows = mkImDet > 0.5 ? mkRowN : 0.0;
      for (int k = 0; k < 40; k++) {
        if (float(k) >= nRows) break;
        vec4 r = mkRows[k]; float code = abs(r.w), fc = sign(r.w);
        if (code < 2.5) {
          // transverse pair: back at x = r.x (fabric on its +fc side, grey shell behind), cushion 0.5 deep, two seats
          if (r.x < xlo || r.x > xhi) continue;
          vec3 sc = code > 1.5 ? MK_LIME : MK_BLUE;
          if (abs(rd.x) > 1e-5) { float t = (r.x - ro.x) / rd.x;
            if (t > 0.0 && t < tB) { vec3 h = ro + rd * t;
              if (h.z > r.y && h.z < r.z && h.y > fy + 0.1 && h.y < fy + 1.02) { tB = t; nB = vec3(-sign(rd.x), 0.0, 0.0); cB = rd.x * fc < 0.0 ? sc : MK_SHELL; metal = 0.0; } } }
          if (rd.y < -1e-5) { float t = (fy + 0.46 - ro.y) / rd.y;
            if (t > 0.0 && t < tB) { vec3 h = ro + rd * t; float dx = (h.x - r.x) * fc;
              if (dx > 0.0 && dx < 0.5 && h.z > r.y && h.z < r.z) { tB = t; nB = vec3(0.0, 1.0, 0.0); cB = sc; metal = 0.0; } } }
          for (int s = 0; s < 2; s++) {
            float zc = mix(r.y, r.z, 0.25 + 0.5 * float(s)), key = gH(vec2(r.x * 7.13 + mkSeed, zc * 3.1));
            if (key < pOcc) { float t0 = tB; mkPerson(ro, rd, vec3(r.x + fc * 0.24, fy + 0.46, zc), 0.72, vec2(0.13, 0.2), key, 0.0, tB, cB, nB); if (tB < t0) metal = 0.0; }
          }
        } else if (code < 4.5) {
          // longitudinal bench x in [r.x, r.y] on side fc: cushion |z| > 1.0, front, back cushion on the wall
          if (r.y < xlo || r.x > xhi) continue;
          vec3 sc = code > 3.5 ? MK_LIME : MK_BLUE;
          if (rd.y < -1e-5) { float t = (fy + 0.46 - ro.y) / rd.y;
            if (t > 0.0 && t < tB) { vec3 h = ro + rd * t; if (h.x > r.x && h.x < r.y && h.z * fc > mkHalfW - 0.47) { tB = t; nB = vec3(0.0, 1.0, 0.0); cB = sc; metal = 0.0; } } }
          if (abs(rd.z) > 1e-5) {
            float t = (fc * (mkHalfW - 0.47) - ro.z) / rd.z;
            if (t > 0.0 && t < tB) { vec3 h = ro + rd * t; if (h.x > r.x && h.x < r.y && h.y > fy + 0.1 && h.y < fy + 0.46) { tB = t; nB = vec3(0.0, 0.0, -fc); cB = MK_SHELL * 0.45; metal = 0.0; } }
            t = (fc * (mkHalfW - 0.07) - ro.z) / rd.z;
            if (t > 0.0 && t < tB) { vec3 h = ro + rd * t; if (h.x > r.x && h.x < r.y && h.y > fy + 0.5 && h.y < fy + 0.98) { tB = t; nB = vec3(0.0, 0.0, -fc); cB = sc; metal = 0.0; } }
          }
          float ns = r.y - r.x > 0.75 ? 2.0 : 1.0;
          for (int s = 0; s < 2; s++) { if (float(s) >= ns) break;
            float xc = r.x + (float(s) + 0.5) * (r.y - r.x) / ns, key = gH(vec2(xc * 5.7 + mkSeed, fc * 2.3));
            if (key < pOcc) { float t0 = tB; mkPerson(ro, rd, vec3(xc, fy + 0.46, fc * (mkHalfW - 0.3)), 0.72, vec2(0.2, 0.13), key, 0.0, tB, cB, nB); if (tB < t0) metal = 0.0; }
          }
        } else {
          // doorway partition at x = r.x spanning z in [r.y, r.z]
          if (r.x < xlo || r.x > xhi || abs(rd.x) < 1e-5) continue;
          float t = (r.x - ro.x) / rd.x;
          if (t > 0.0 && t < tB) { vec3 h = ro + rd * t; if (h.z > r.y && h.z < r.z && h.y > fy + 0.08 && h.y < fy + 1.84) { tB = t; nB = vec3(-sign(rd.x), 0.0, 0.0); cB = MK_WALL2; metal = 0.0; } }
        }
      }
      // standing passengers (mkStand: x, z, height, key), more of them the fuller the car
      float nSt = clamp(floor((mkLoad - 0.18) * 14.0), 0.0, 8.0) * mkImDet;
      for (int k = 0; k < 8; k++) { if (float(k) >= nSt) break; vec4 s = mkStand[k]; if (s.x < xlo || s.x > xhi) continue;
        float t0 = tB; mkPerson(ro, rd, vec3(s.x, fy, s.y), s.z - 0.12, fract(s.w * 7.0) < 0.5 ? vec2(0.2, 0.13) : vec2(0.13, 0.2), s.w, 1.0, tB, cB, nB); if (tB < t0) metal = 0.0; }
      // grab poles (x, z, radius, top) and the two overhead rails (y, |z|, radius)
      for (int k = 0; k < 16; k++) { if (float(k) >= mkCnt.z * mkImDet) break; vec4 q = mkPole[k]; if (q.x < xlo || q.x > xhi) continue;
        vec3 n = vec3(0.0); float t = mkCylE(ro, rd, q.xy, vec2(q.z), fy, q.w, n); if (t < tB) { tB = t; nB = n; cB = MK_POLE; metal = 1.0; } }
      if (mkRail.z > 0.0) for (int s = 0; s < 2; s++) {
        vec2 o = vec2(ro.y - mkRail.x, ro.z - (s == 0 ? mkRail.y : -mkRail.y)), d = rd.yz; float a = dot(d, d);
        if (a < 1e-8) continue;
        float b = dot(o, d), h = b * b - a * (dot(o, o) - mkRail.z * mkRail.z); if (h < 0.0) continue;
        float t = (-b - sqrt(h)) / a; float x = ro.x + rd.x * t;
        if (t > 0.0 && t < tB && x > mkCab.x + 0.9 && x < mkCab.y - 0.9) { tB = t; vec2 q = (o + d * t) / mkRail.z; nB = vec3(0.0, q.x, q.y); cB = MK_POLE; metal = 1.0; }
      }
      vec3 hp = ro + rd * tB;
      if (tB < tH) {
        vec3 c = mkShade(hp, nB, cB);
        if (metal > 0.5) c += mkLitK * 0.5 * pow(max(dot(reflect(rd, nB), normalize(vec3(0.0, 0.85, -sign(hp.z) * 0.5))), 0.0), 6.0);
        return c;
      }
      // ---- the shell's surfaces
      if (id == 0.0) return mkShade(hp, nrm, MK_FLOOR * (0.8 + 0.4 * gH(floor(hp.xz * 55.0))));
      if (id == 2.0) {
        float az = abs(hp.z);
        if (az > mkBand.x && az < mkBand.y) return vec3(1.0, 0.99, 0.95) * mkLitK * (3.2 + 0.6 * smoothstep(0.3, 0.0, abs(az - 0.5 * (mkBand.x + mkBand.y)) / (mkBand.y - mkBand.x)));
        vec3 c = az < mkBand.z || az > mkBand.y ? MK_CEIL : MK_WALL2;
        c *= 1.0 - 0.92 * step(abs(az - mkBand.z - 0.02), 0.012) * step(0.1, mkBand.z);
        return mkShade(hp, nrm, c);
      }
      if (id == 9.0) {
        if (mkCab.z > 0.5) return mkShade(hp, nrm, vec3(0.5));
        float nb = hp.x > 0.0 ? mkEnds.y : mkEnds.x, az = abs(hp.z);
        if (az < 0.38 && hp.y < fy + 1.95) {
          if (az < 0.24 && hp.y > fy + 0.95 && hp.y < fy + 1.8) return nb > 0.5 ? mkLitK * vec3(0.2, 0.2, 0.19) * mkTint * 2.0 : (nb < -0.5 ? vec3(0.004) : mkOut(rd) * mkTint);
          return mkShade(hp, nrm, az > 0.35 ? vec3(0.03) : vec3(0.45));
        }
        // the end walls are lime green (the cab bulkhead of a D car grey), the next-stop sign above the door dark
        if (az < 0.5 && hp.y > fy + 2.0) return mkShade(hp, nrm, vec3(0.02)) + vec3(0.3, 0.12, 0.02) * mkLv[7] * step(0.9, fract(hp.z * 11.0));
        return mkShade(hp, nrm, nb < -0.5 ? MK_WALL2 : vec3(0.479, 0.552, 0.041));
      }
      return mkWall(hp, nrm, rd);
    }`;
  // opening: false (the glazing), true (an open doorway: the cabin without glass) or 'bake' (unlit: the cabin as a viewer
  // on a platform 6 m away would see it by the cabin's own light, into the design's atlas; see 42_metrokit_bake.js)
  function glassMaterial(S, opening = false) {
    const bake = opening === 'bake';
    const m = bake ? new THREE.MeshBasicMaterial({ toneMapped: false }) : opening ? new THREE.MeshPhysicalMaterial({ color: 0x000000, roughness: 1, metalness: 0, specularIntensity: 0, envMapIntensity: 0 })
      : new THREE.MeshPhysicalMaterial({ color: 0x000000, roughness: 0.035, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.0 });
    if (bake) m.defines = { MK_BAKE: 1 }; else if (opening) m.defines = { MK_OPENING: 1 };
    m.userData.S = S;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, S);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + MK_VERT_HEAD)
        .replace('#include <skinning_vertex>', MK_VERT_BODY + '\n#include <skinning_vertex>');
      if (bake) {
        sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_pars_fragment>', '#include <clipping_planes_pars_fragment>' + GLASS_FRAG_HEAD)
          .replace('#include <opaque_fragment>', `#include <opaque_fragment>
            {
              mkDayK = 0.0; mkDayA = vec3(0.0); mkLitK = 1.0; mkHitFar = 0.0;
              vec3 n = normalize(mkN), eye = mkP + n * 5.0; eye.y = mkFloorY + 1.65;     // (a rider on the platform)
              vec3 rd = normalize(mkP - eye);
              vec3 inside = mkInterior(mkP + rd * 0.03, rd) * mkTint;
              gl_FragColor = vec4(min(inside * 0.5, vec3(1.0)), mkHitFar > 0.5 ? 0.86 : 1.0);
            }`);
        return;
      }
      // the impression is evaluated after the lights (it uses the scene's light uniforms and the Under daylight hook)
      sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_pars_fragment>', '#include <clipping_planes_pars_fragment>' + GLASS_FRAG_HEAD)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            // raindrops: each bead tilts the pane's normal (its reflection) and bends the view through it
            float front = step(0.5, abs(mkN.x));
            #ifdef MK_OPENING
              mkDrop = vec3(0.0);
            #else
              mkDrop = mkDrops(front > 0.5 ? vec2(mkP.z, mkP.y) : vec2(mkP.x, mkP.y), mkSpd, front);
            #endif
            vec3 T = front > 0.5 ? mkAz : mkAx;
            normal = normalize(normal + (T * mkDrop.x + mkAy * mkDrop.y) * 0.7);
          }`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          {
            mkDayK = 1.0; mkDayA = vec3(0.0); mkLitK = mkLv[1];
            #ifdef BL_UNDER_DEF
              { vec4 u = blUnder(blUnderWorld(-vViewPosition)); mkDayK = u.y; mkDayA = blUTint * u.z * RECIPROCAL_PI; }
            #endif
            vec3 rd = normalize(mkP - mkCamO);
            #ifdef MK_OPENING
              // an open doorway (no glass): the cabin as it is, only where that side's doors are open
              if ((mkP.z > 0.0 ? mkDoorO.y : mkDoorO.x) < 0.02) discard;
              totalEmissiveRadiance += mkInterior(mkP + rd * 0.01, rd) * mkIntOn;
            #else
            vec4 sg = mkSigns(mkP, rd);
            { float front = step(0.5, abs(mkN.x)); vec3 Tc = front > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
              rd = normalize(rd - (Tc * mkDrop.x + vec3(0.0, mkDrop.y, 0.0)) * 0.16); }
            vec3 inside = sg.a > 0.5 ? sg.rgb * 0.75 : mkInterior(mkP + rd * 0.03, rd) * mkTint;
            inside *= 1.0 - 0.25 * mkDrop.z;                                  // (water on the pane scatters a little)
            // the near pane's Fresnel: at grazing angles the reflection wins
            float cosT = abs(dot(normalize(vNormal), normalize(vViewPosition)));
            float F = 0.04 + 0.96 * pow(1.0 - cosT, 5.0);
            totalEmissiveRadiance += inside * (1.0 - F) * mkIntOn;
            #endif
          }`);
    };
    m.customProgramCacheKey = () => bake ? 'mk-glass-3-bake' : opening ? 'mk-glass-3-open' : 'mk-glass-3';
    return m;
  }
  // clear glass (interior built): dst x tint + the glass's own reflections at full strength (not scaled by an opacity)
  function glassClearMaterial() {
    const m = new THREE.MeshPhysicalMaterial({ color: 0x0b1011, roughness: 0.02, metalness: 0, side: THREE.DoubleSide, transparent: true, depthWrite: false, envMapIntensity: 1.0 });
    m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor; m.blendDst = THREE.ConstantColorFactor; m.blendColor.copy(GLASS_TINT);
    m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
    m.forceSinglePass = true; return m;
  }
  // per-car uniforms of the interior impression from the design's d.imap (see 42_metrokit_fotf.js for the fields)
  const V4 = a => new THREE.Vector4(a[0] || 0, a[1] || 0, a[2] || 0, a[3] || 0);
  function vecList(list, n, fill) { const out = []; for (let i = 0; i < n; i++) out.push(V4(list && list[i] ? list[i] : fill)); return out; }
  // the right half of the ceiling section as a polyline [[z, y], ...] from the wall top to the centreline -> outward
  // planes (nz, ny, d, 2) for both halves (the section must be convex: the slope flattens toward the centre)
  function sectionPlanes(sec, ceilY) {
    const P = [];
    if (sec && sec.length > 1) for (let i = 0; i < sec.length - 1; i++) {
      const [za, ya] = sec[i], [zb, yb] = sec[i + 1], dz = zb - za, dy = yb - ya, L = Math.hypot(dz, dy), nz = dy / L, ny = -dz / L;
      const dd = nz * za + ny * ya; P.push([nz, ny, dd, 2], [-nz, ny, dd, 2]);   // (the mirror of (za, ya) is (-za, ya): same d)
    } else P.push([0, 1, ceilY, 2]);
    return vecList(P.slice(0, 8), 8, [0, 0, 0, -1]);
  }
  function imapUniforms(S, d) {
    const M = d.imap || {}, rows = (M.rows || []).slice(0, 40);
    S.mkRows = { value: vecList(rows, 40, [1e4, 0, 0, 0]) }; S.mkRowN = { value: rows.length };
    S.mkSec = { value: sectionPlanes(M.sec, d.ceilY || 3.1) };
    S.mkWin = { value: vecList(M.win, 16, [0, 0, 0, 0]) };
    S.mkDoor = { value: vecList(M.doors, 4, [0, 0, 0, 0]) };
    S.mkPole = { value: vecList(M.poles, 16, [0, 0, 0, 0]) };
    S.mkPan = { value: vecList(M.panels, 12, [0, 0, 0, 0]) };
    S.mkStand = { value: vecList(M.stand, 8, [1e4, 0, 1.7, 0]) };
    S.mkCnt = { value: V4([Math.min(16, (M.win || []).length), Math.min(4, (M.doors || []).length), Math.min(16, (M.poles || []).length), Math.min(12, (M.panels || []).length)]) };
    S.mkDoorWin = { value: V4(M.doorWin || [0, 0, 0, 0]) };
    S.mkRail = { value: V4(M.rail || [0, 0, 0, 0]) };
    const lz = (S.mkLamp && S.mkLamp.value.x) || 0.6;
    S.mkBand = { value: V4(M.band || [lz - 0.06, lz + 0.06, 0, 0]) };
    S.mkCabI = { value: V4(M.cab || [0, 0, 0, 0]) };
    S.mkEnds = { value: new THREE.Vector4() };
    S.mkLoad = { value: 0.3 };
    S.mkTint = { value: GLASS_TINT };
    S.mkImDet = { value: 1 };
    S.mkDoorO = { value: new THREE.Vector2() };            // doors open (design -Z side, +Z side), for the doorway impression
  }
  // the doorway impression's quads (d.openings: [{ x, hw, y0, y1, z, side, bone }]), in the door portals behind the leaves
  function openingsGeometry(d) {
    if (d.openGeo !== undefined) return d.openGeo;
    if (!d.openings || !d.openings.length) return (d.openGeo = null);
    const E = new MB(); E.pal('glowDummy');
    for (const o of d.openings) { E.bone = o.bone || 0; const z = o.side * o.z;
      const A = [o.x - o.hw, o.y0, z], B = [o.x + o.hw, o.y0, z], C = [o.x + o.hw, o.y1, z], D = [o.x - o.hw, o.y1, z];
      if (o.side > 0) E.q4(A, B, C, D); else E.q4(B, A, D, C); }
    return (d.openGeo = E.geometry());
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
    if (!d.bogieList) d.bogieList = d.boneIdx.bogie.map((bi, k) => ({ bone: bi, pivot: d.bones[bi].pivot, axles: d.boneIdx.axlesOf[k] }));
    return (designs[key] = d);
  }

  // ------------------------------------------------------------------------------------------ runtime: Car
  const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _ax = new V3();
  const _one = new V3(1, 1, 1), _rpi = new THREE.Matrix4().makeRotationY(Math.PI);
  // a car farther than LOD0_R from the camera draws its LOD 1; the distance is the apparent one under a long lens (see
  // camLens), and in capture mode (trailer frames, where frame time doesn't matter) every car within LOD0_CAP of it
  // draws LOD 0
  const LOD0_R = 110, LOD0_CAP = 600, TAN_GAME = Math.tan(27.5 * Math.PI / 180);
  const _I4 = new THREE.Matrix4();
  // body sway: roll f 0.8 Hz / damping / rad per g of unbalanced lateral acceleration; pitch per g of longitudinal
  // acceleration; bounce; roll centre height; track excitation amplitudes at 70 mph (rad, rad, m)
  const SWAY = { fr: 0.8, zr: 0.3, kr: 0.07, fp: 1.1, zp: 0.35, kp: 0.02, fb: 1.3, zb: 0.3, hrc: 0.9, exR: 0.0022, exP: 0.0007, exB: 0.006 };
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
      S.mkCamO = { value: new V3() }; S.mkIntOn = { value: 1 };
      if (d.lamp) S.mkLamp.value.set(d.lamp[0], d.lamp[1], d.lamp[2], 0);
      imapUniforms(S, d);
      { // this car's standing passengers: 8 of the design's spots, shuffled per car, with heights and a colour key
        const all = (d.imap && d.imap.standAll) || [], st = S.mkStand.value, h = U.hashStr(number + ':' + index + ':st') % 100003;
        const idx = all.map((_, i) => i).sort((a, b) => U.hash2(a, h) - U.hash2(b, h));
        for (let i = 0; i < 8 && i < idx.length; i++) { const p = all[idx[i]]; st[i].set(p[0], p[1], 1.58 + 0.28 * U.hash2(i, h + 1), U.hash2(i + 9, h)); }
      }
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
      // (and the impression's detail: seats, passengers and poles only within ~90 m, where they cover pixels)
      this.glass.onBeforeRender = (r, scene, cam) => { _m.copy(self.root.matrixWorld).invert(); const o = S.mkCamO.value.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(_m);
        S.mkImDet.value = o.lengthSq() < 8100 ? 1 : 0; K.noteCamera(cam); };
      // lamp glow billboards (one instanced draw per lamp-carrying car, visible when lit at dusk / night / in tunnels)
      this.glow = null;
      if (d.lamps && d.lamps.length && K.makeGlow) {
        const gl = K.makeGlow(d.lamps.length); d.lamps.forEach((L, i) => { gl.pos.array.set([L.p[0], L.p[1], L.p[2], L.kind === 'bar' ? 0.9 : 0.55], i * 4); });
        gl.mesh.geometry.instanceCount = d.lamps.length; gl.pos.needsUpdate = true; gl.mesh.name = 'glow'; gl.mesh.visible = false; root.add(gl.mesh); this.glow = gl;
      }
      this.lod = 0; this.int = null; this.intVisible = false;
      // body sway on the secondary suspension (see _sway): roll / pitch / bounce and their rates, the base pose it rides on
      this.sw = { r: 0, vr: 0, p: 0, vp: 0, b: 0, vb: 0, has: false, bp: new V3(), br: new THREE.Euler(0, 0, 0, 'YZX'), W: new Float64Array(6) };
      this.swPh = U.hash2(this.index * 7 + 3, (U.hashStr(String(number)) % 9973)) * TAU; this.bogFix = new THREE.Matrix4(); this.swayOn = false;
      this._kappa = 0; this._bank = 0;
      if (!d.bogieList) d.bogieList = d.boneIdx.bogie.map((bi, k) => ({ bone: bi, pivot: d.bones[bi].pivot, axles: d.boneIdx.axlesOf[k] }));
      this.wheelAng = 0; this.yaw = d.bogieList.map(() => 0); this.doorPos = [0, 0]; this.wiperAng = [0, 0]; this.dirty = true;
      if (d.bodyList) { this.bodySt = d.bodyList.map(() => ({ yaw: 0, dx: 0, dz: 0 })); this.bodyM = d.bodyList.map(() => new THREE.Matrix4()); this.bogOff = d.bogieList.map(() => [0, 0]); }
      // collector shoes: height offset of each shoe's contact face from its modelled (on-rail) height; 0 = riding the rail
      this.shoeDy = d.shoes ? new Float32Array(d.shoes.length) : null; this.bogM = d.bogieList.map(() => new THREE.Matrix4());
      this.lv = S.mkLv.value;
      this._pose();
      if (Q === 0) this.setLOD(1);                             // (low tier: simple LOD geometry from the start)
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
        if (this.swayOn) _m.premultiply(this.bogFix);            // the body sways on its springs, the bogies stay on the track
        _m.toArray(bm, g.bone * 16); this.bogM[b].copy(_m);
        for (const ai of g.axles) { const ap = B[ai].pivot;
          _m2.makeTranslation(ap[0], ap[1], ap[2]).multiply(_m3.makeRotationZ(-this.wheelAng)); _m2.multiply(_m3.makeTranslation(-ap[0], -ap[1], -ap[2]));
          _m3.multiplyMatrices(_m, _m2); _m3.toArray(bm, ai * 16); } }
      // collector shoes: the arm turns about the longitudinal pin so the paddle drops by shoeDy (a free shoe hangs tilted)
      if (d.shoes) for (let i = 0; i < d.shoes.length; i++) { const S0 = d.shoes[i], pv = S0.pivot;
        const a = S0.side * Math.asin(clamp(-this.shoeDy[i] / S0.lever, -0.95, 0.95));
        _m.makeTranslation(pv[0], pv[1], pv[2]).multiply(_m2.makeRotationX(a)).multiply(_m3.makeTranslation(-pv[0], -pv[1], -pv[2]));
        _m.premultiply(this.bogM[S0.bogie]); _m.toArray(bm, S0.bone * 16); }
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
      this.dirty = false; this.doorDirty = false;
    }
    // Body sway: the body rides its air springs. It rolls outward under the unbalanced lateral acceleration
    // (v^2 k + g sin(bank): leaning into the curve when slow on cant), pitches under braking / traction, and rocks and
    // bounces on track irregularities tied to the distance run (so their frequency rises with speed). One lightly
    // damped spring per mode. Applied on top of the group's pose (whoever set it: poseOnTrack or the caller); the
    // bogies (and wheels, shoes) are counter-transformed so they stay on the track. LOD 0 only, no allocations.
    _sway(dt, v, aLong, odo, on) {
      const g = this.group, s = this.sw, W = s.W, P = g.position, Rr = g.rotation;
      if (!s.has || P.x !== W[0] || P.y !== W[1] || P.z !== W[2] || Rr.x !== W[3] || Rr.y !== W[4] || Rr.z !== W[5]) { s.bp.copy(P); s.br.copy(Rr); s.has = true; }
      if (!on || this.lod !== 0) {
        if (this.swayOn) { P.copy(s.bp); Rr.copy(s.br); this.swayOn = false; this.bogFix.identity(); this.dirty = true; s.r = s.vr = s.p = s.vp = s.b = s.vb = 0; }
        W[0] = P.x; W[1] = P.y; W[2] = P.z; W[3] = Rr.x; W[4] = Rr.y; W[5] = Rr.z; return;
      }
      const SW = SWAY, q = Math.min(1, Math.abs(v) / 31), ph = this.swPh;
      const aLat = v * v * this._kappa + 9.81 * Math.sin(this._bank);
      if (q === 0 && Math.abs(aLat) < 1e-4 && Math.abs(aLong) < 1e-3 && Math.abs(s.r) + Math.abs(s.p) + Math.abs(s.b) + Math.abs(s.vr) + Math.abs(s.vp) + Math.abs(s.vb) < 1e-5) {
        if (this.swayOn) { P.copy(s.bp); Rr.copy(s.br); this.swayOn = false; this.bogFix.identity(); this.dirty = true; }
        s.r = s.vr = s.p = s.vp = s.b = s.vb = 0; W[0] = P.x; W[1] = P.y; W[2] = P.z; W[3] = Rr.x; W[4] = Rr.y; W[5] = Rr.z; return;
      }
      const n1 = Math.sin(odo * 0.37 + ph) + 0.6 * Math.sin(odo * 0.93 + 2.1 * ph) + 0.35 * Math.sin(odo * 2.31 + 3.7 * ph);
      const n2 = Math.sin(odo * 0.51 + 1.3 * ph) + 0.5 * Math.sin(odo * 1.37 + 0.7 * ph);
      const n3 = Math.sin(odo * 0.83 + 2.9 * ph) + 0.5 * Math.sin(odo * 1.91 + 1.1 * ph);
      const rT = SW.kr * aLat / 9.81 + SW.exR * q * n1, pT = SW.kp * clamp(aLong, -3, 3) / 9.81 + SW.exP * q * n2, bT = SW.exB * q * n3;
      // springs (semi-implicit Euler, stable for these rates at dt <= 0.1)
      let w = TAU * SW.fr; s.vr += (-w * w * (s.r - rT) - 2 * SW.zr * w * s.vr) * dt; s.r += s.vr * dt;
      w = TAU * SW.fp; s.vp += (-w * w * (s.p - pT) - 2 * SW.zp * w * s.vp) * dt; s.p += s.vp * dt;
      w = TAU * SW.fb; s.vb += (-w * w * (s.b - bT) - 2 * SW.zb * w * s.vb) * dt; s.b += s.vb * dt;
      // the swayed pose: roll about the roll centre (hrc above the rails), pitch, bounce; in the base frame
      const r = s.r, hc = SW.hrc;
      _m.makeRotationFromEuler(s.br); _ax.set(0, hc * (1 - Math.cos(r)) + s.b, -hc * Math.sin(r)).applyMatrix4(_m);
      P.set(s.bp.x + _ax.x, s.bp.y + _ax.y, s.bp.z + _ax.z); Rr.set(s.br.x + r, s.br.y, s.br.z + s.p, 'YZX');
      W[0] = P.x; W[1] = P.y; W[2] = P.z; W[3] = Rr.x; W[4] = Rr.y; W[5] = Rr.z;
      // bogie fix = G'^-1 G (group space), conjugated into the design frame for a flipped car
      _q.setFromEuler(s.br); _m2.compose(s.bp, _q, _one); _q.setFromEuler(Rr); _m3.compose(P, _q, _one).invert(); _m3.multiply(_m2);
      if (this.flip) _m3.premultiply(_rpi).multiply(_rpi);
      this.bogFix.copy(_m3); this.swayOn = true; this.dirty = true;
    }
    // after a quality change: the same car on the new quality's design (same bones, metadata and layout; different
    // tessellation and resolutions), so the old design's buffers can be freed
    _requalify(atlas) {
      const d = getDesign(this.kind, this.type); if (d === this.design) return;
      this.design = d; this.ext.geometry = d.ext; this.glass.geometry = d.glass;
      for (const k of ['lodMesh1', 'lodMesh2']) if (this[k]) { this.root.remove(this[k]); this[k] = null; }
      this.lodBaked = false;
      if (this.int) { this.root.remove(this.int); this.int = null; }
      if (this.openMesh) { this.root.remove(this.openMesh); this.openMesh.material.dispose(); this.openMesh = null; }
      if (atlas) this.S.mkAtlas.value = atlas;
      const req = this.lodReq === undefined ? this.lod : this.lodReq, iv = this.intVisible; this.lod = -1; this.intVisible = false;
      this.setLOD(req); if (iv) this.setInteriorVisible(true);
    }
    // the doorway impression: drawn while doors are open on a LOD 0 car whose real interior is not shown
    _openings() {
      const open = this.doorPos[0] > 0.02 || this.doorPos[1] > 0.02, want = open && (this.lod === 0 || (this.lod === 1 && this.lodBaked)) && !(this.int && this.int.visible);
      if (want && !this.openMesh) {
        const geo = openingsGeometry(this.design); if (!geo) { this.openMesh = false; return; }
        const me = this.openMesh = new THREE.SkinnedMesh(geo, glassMaterial(this.S, true)); me.bind(this.skeleton, new THREE.Matrix4()); me.bindMode = 'detached';
        me.boundingSphere = this.design.sphere.clone(); me.name = 'doorways'; me.castShadow = false; me.receiveShadow = false;
        const S = this.S, self = this;
        me.onBeforeRender = (r, sc, cam) => { _m.copy(self.root.matrixWorld).invert(); S.mkCamO.value.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(_m); K.noteCamera(cam); };
        this.root.add(me);
      }
      if (this.openMesh) { this.openMesh.visible = want; this.S.mkDoorO.value.set(this.doorPos[0], this.doorPos[1]); }
    }
    setInteriorVisible(v) {
      v = !!v; if (v === this.intVisible) return; this.intVisible = v;
      if (v && !this.int && this.consist._buildInterior) this.consist._buildInterior(this);
      if (this.int) this.int.visible = v && (this.lod === 0 || Q === 0);
      this.glass.material = v && this.int ? this.matGlassClear : this.matGlass;
      this.glass.renderOrder = v ? 2 : 0;
    }
    setLOD(level) {
      level = clamp(level | 0, 0, 2); this.lodReq = level; if (Q === 0 && level === 0) level = 1;      // (low tier: simple LOD geometry only)
      if (level === this.lod) return; this.lod = level;
      if (level > 0 && !this['lodMesh' + level]) this._makeLod(level);
      this.ext.visible = this.glass.visible = level === 0;
      if (this.lodMesh1) this.lodMesh1.visible = level === 1;
      if (this.lodMesh2) this.lodMesh2.visible = level === 2;
      if (this.int) this.int.visible = this.intVisible && (level === 0 || Q === 0);
      if ((level === 0 || this.lodBaked) && this.dirty) this._pose();
    }
    // a LOD mesh: the design's baked LOD (the full-detail look from its atlas; skinned, so doors open) when the bake is
    // ready, else the plain one until the bake arrives (_onBaked swaps it)
    _makeLod(level) {
      const d = this.design, b = builders[d.kind], bake = b.lodBaked && K.requestBake ? K.requestBake(d, this) : null;
      let m;
      if (bake) {
        const key = 'lodb' + level; if (!d[key]) d[key] = b.lodBaked(d, level, bake);
        this.S.mkBake.value = bake.tex;
        const mat = Q === 0 ? (this.matLod || (this.matLod = palMaterial('lod', this.S))) : this.mat;
        m = new THREE.SkinnedMesh(d[key], mat); m.bind(this.skeleton, _I4); m.bindMode = 'detached'; m.boundingSphere = d.sphere.clone();
        this.lodBaked = true;
      } else {
        // (the plain LOD draws with the same material as the baked one: one program, no compile when it upgrades)
        const k = 'lod' + level;
        if (!d[k] && b.lod) d[k] = b.lod(d, level);
        if (!d[k]) return;
        const mat = Q === 0 ? (this.matLod || (this.matLod = palMaterial('lod', this.S))) : this.mat;
        m = new THREE.SkinnedMesh(d[k], mat); m.bind(this.skeleton, _I4); m.bindMode = 'detached'; m.boundingSphere = d.sphere.clone();
      }
      m.name = 'lod' + level; m.castShadow = level === 1; m.receiveShadow = level === 1;
      if (level === 1) m.onBeforeRender = (r, sc, cam) => K.noteCamera(cam);
      m.visible = this.lod === level; this.root.add(m); this['lodMesh' + level] = m;
    }
    _onBaked() {
      if (!live.has(this.consist)) return;
      for (const k of ['lodMesh1', 'lodMesh2']) if (this[k]) { this.root.remove(this[k]); this[k] = null; }
      const l = this.lod; this.lod = -1; this.setLOD(this.lodReq === undefined ? Math.max(0, l) : this.lodReq);
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
    if (m.standSpots) o.standSpots = m.standSpots.map(p => ({ ...p, x: -p.x, z: -p.z, yaw: U.wrapAngle(p.yaw + Math.PI) }));
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
      this.sway = opts.sway !== false; this.odo = 0; this._v0 = 0; this._aL = 0;       // body sway on (c.sway = false: rigid)
      this.signTex = makeSignTexture(); this.atlasTex = K.decalAtlas ? K.decalAtlas(K.atlasRes()) : null; this.lcdTex = null;
      this.intAllowed = false; this.intAuto = opts.intAuto !== false; live.add(this);
      this.glassClear = glassClearMaterial();
      // car list
      let order = opts.order || null;
      const n = clamp(opts.cars | 0 || (kind === 'bart' ? 10 : kind === 'dmu' ? 1 : 3), 1, 12);
      const spec = builders[kind].consist ? builders[kind].consist(n, order, this.seed) : defaultBartOrder(n, order);
      this.cars = spec.map((c, i) => new Car(this, i, getDesign(kind, c.type), c.flip, c.number || this.numberFor(c.type, i)));
      let off = 0; for (const c of this.cars) { c.offset = off + c.length / 2; off += c.length; }
      this.length = off;
      // interior impression: which ends have a lit neighbour beyond the end door (design space: .x the -X end, .y the
      // +X end; -1 marks the D car's cab side), and the passenger load
      const nc = this.cars.length;
      this.cars.forEach((c, i) => { const fwd = i > 0, back = i < nc - 1, e = c.S.mkEnds.value;
        e.set(c.flip ? +fwd : +back, c.flip ? +back : +fwd, 0, 0); if (c.type === 'D') e.y = -1; });
      this.setLoad(opts.load === undefined ? 0.3 : opts.load);
      this.setDestination(opts.destination || { line: 'yellow', text: 'Bayline Metro' });
      this._applyLights();
    }
    // without track data (previews): the contact rail along one side of the consist (+1 its +Z side, -1 the other, 0
    // none) at contact height top; poseOnTrack sets the shoes per truck from MetroTrack when it is in the build
    setThirdRail(side, top = 0.171) {
      for (const c of this.cars) { const d = c.design; if (!d.shoes) continue; const ds = side * (c.flip ? -1 : 1);
        d.shoes.forEach((S0, i) => { c.shoeDy[i] = side && S0.side === ds ? top - S0.top : S0.free; }); c.dirty = true; }
    }
    // passengers seen through the windows (0 empty .. 1 crush load); each car varies a little around it
    setLoad(f) { f = clamp(+f || 0, 0, 1); this.load = f; for (const c of this.cars) c.S.mkLoad.value = clamp(f * (0.75 + 0.5 * U.hash2(this.seed + 7, c.index * 13 + 5)), 0, 1); }
    _requalify() {
      const atlas = K.decalAtlas ? K.decalAtlas(K.atlasRes()) : null; this.atlasTex = atlas;
      if (this.lcdTex) { this.lcdTex.dispose(); this.lcdTex = null; this._lcd(); }
      for (const c of this.cars) c._requalify(atlas);
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
      const leadSide = this.lead === 'rear' ? -1 : 1;         // the consist's leading side (+X front / -X rear)
      for (const c of cars) {
        const lv = c.lv;
        // an end of a design (+1 = its +X end, -1 = its -X end) is exposed if it faces out of the consist; it then leads
        // or trails. (A cab car's lamps are at its +X end; the DMU carries lamps at both ends, the B lamps at -X.)
        const endState = e => { const side = e * (c.flip ? -1 : 1); if ((side > 0 && c !== first) || (side < 0 && c !== last)) return 0; return side === leadSide ? 1 : -1; };
        const A = endState(1), B = endState(-1);
        lv[G.interior] = L.interior * (0.8 + 0.2 * n);
        lv[G.head] = A > 0 ? L.head * (6 + 16 * n) : 0; lv[G.headB] = B > 0 ? L.head * (6 + 16 * n) : 0;
        lv[G.marker] = A > 0 ? L.head * (1.5 + 3 * n) : 0;
        lv[G.tail] = A < 0 ? L.tail * (3 + 7 * n) : 0; lv[G.tailB] = B < 0 ? L.tail * (3 + 7 * n) : 0;
        lv[G.bar] = A !== 0 ? (1.2 + 2.5 * n) : 0; c.S.mkBar.value = A < 0 ? 1 : 0;
        lv[G.sign] = L.signs * (0.8 + 0.4 * n);
        lv[G.cab] = L.cab;
        c.S.mkNight.value = n; c.S.mkIntOn.value = 1;
        if (c.glow) {                                   // billboard colours follow the lamps' state; they matter at dusk and night
          const C = c.glow.col.array, lamps = c.design.lamps, k = 0.25 + 0.75 * n; let any = false;
          lamps.forEach((Lm, i) => {
            const st = Lm.kind.endsWith('B') ? B : A, kind = Lm.kind.replace(/B$/, ''); let r = 0, g = 0, b = 0;
            if (kind === 'head' && st > 0) { r = 3.0 * L.head; g = 2.9 * L.head; b = 2.6 * L.head; }
            else if (kind === 'marker' && st > 0) { r = 1.6; g = 1.5; b = 1.3; }
            else if (kind === 'tail' && st < 0) { r = 2.6 * L.tail; g = 0.1; b = 0.06; }
            else if (kind === 'bar' && st !== 0) { if (st > 0) { r = 2.6; g = 1.1; b = 0.15; } else { r = 2.6; g = 0.1; b = 0.06; } }
            C[i * 4] = r * k; C[i * 4 + 1] = g * k; C[i * 4 + 2] = b * k; if (r + g + b > 0) any = true; });
          c.glow.col.needsUpdate = true; c.glow.mesh.visible = any && n > 0.04;
        }
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
    // Interiors: drawn for the car nearest the camera and its neighbours when that car is within 45 m, decided every
    // update (a walk along the train carries them with the player). That holds whatever the caller asks
    // (intAuto, the default); setInteriorVisible(true) keeps it on beyond 45 m for the car nearest the camera (a
    // focus train). With c.intAuto = false only setInteriorVisible(true) shows interiors. Other cars with open doors
    // show the doorway impression, so no car is ever see-through.
    setInteriorVisible(v) { this.intAllowed = !!v; this._applyInt(); }
    _applyInt() {
      let best = -1, bd = this.intAllowed ? 1e12 : 45 * 45; const p = (this.intAllowed || this.intAuto) ? camPos() : null;
      if (p) for (const c of this.cars) { const g = c.group.position, d = (g.x - p.x) ** 2 + (g.y - p.y) ** 2 + (g.z - p.z) ** 2; if (d < bd) { bd = d; best = c.index; } }
      for (const c of this.cars) c.setInteriorVisible(best >= 0 && Math.abs(c.index - best) <= 1);
    }
    // LOD: the caller's level for the whole consist (the sim decides by the head's distance), refined per car by its own
    // apparent distance to the camera (the real one under a long lens: see camLens): a car beyond ~110 m draws LOD 1 even
    // when its consist is at LOD 0 (a 10-car train is 213 m long, and from the air every car is that far). In capture
    // mode every car within 600 m draws LOD 0, also when the caller asked for LOD 1 (offline, frame time doesn't
    // matter). Re-evaluated every update (with hysteresis).
    setLOD(level) { this.lodReq = clamp(level | 0, 0, 2); this._applyLod(); }
    _lodLive() { return this.lodReq === 0 || (this.lodReq === 1 && capturing()); }
    _applyLod() {
      const base = this.lodReq === undefined ? 0 : this.lodReq, cap = capturing(), p = base === 0 || (cap && base === 1) ? camPos() : null;
      const k = p ? camLens() : 1, k2 = k * k, R = cap ? LOD0_CAP : LOD0_R;
      for (const c of this.cars) {
        let l = base;
        if (p) { const g = c.group.position, d2 = ((g.x - p.x) ** 2 + (g.y - p.y) ** 2 + (g.z - p.z) ** 2) * k2, r = c.lod === 0 ? R + 8 : R - 8; l = d2 > r * r ? 1 : 0; }
        c.setLOD(l);
      }
    }
    // free the per-consist GPU resources (shared design geometry stays cached)
    dispose() {
      for (const c of this.cars) { for (const m of [c.mat, c.matGlass, c.matInt, c.matLod, c.openMesh && c.openMesh.material]) if (m) m.dispose(); if (c.skeleton) c.skeleton.dispose(); if (c.group.parent) c.group.parent.remove(c.group); }
      this.signTex.dispose(); if (this.lcdTex) this.lcdTex.dispose(); this.glassClear.dispose();
      live.delete(this); releaseUnused();
    }
    _lcd() {
      if (!this.lcdTex && K.makeLcdTexture) {
        this.lcdTex = K.makeLcdTexture(Q <= 1 ? 0.5 : 1); for (const c of this.cars) c.S.mkLcd.value = this.lcdTex;
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
      MKG.mkWet.value = wetNow();
      if (this._lodLive()) this._applyLod();
      if (this.intAllowed || this.intAuto) this._applyInt();
      if (dt > 0) { const a = (this.speed - this._v0) / dt; this._aL += (clamp(a, -4, 4) - this._aL) * Math.min(1, dt / 0.25); this._v0 = this.speed; this.odo += Math.abs(this.speed) * dt; }
      for (const c of this.cars) {
        if (moved) { c.doorPos[0] = c.flip ? T[1] : T[0]; c.doorPos[1] = c.flip ? T[0] : T[1]; c.dirty = true; c.doorDirty = true; }
        if (spin !== 0) { c.wheelAng = (c.wheelAng + (c.flip ? -spin : spin)) % TAU; c.dirty = true; }
        if (dt > 0) c._sway(dt, this.speed, this._aL, this.odo, this.sway);
        c.S.mkSpd.value = c.flip ? -this.speed : this.speed;
        if (c.openMesh !== false) c._openings();
        // (a baked LOD 1 moves its doors, and an articulated unit's bodies follow the curves)
        if (c.lod === 0 ? c.dirty : (c.lod === 1 && c.lodBaked && (c.doorDirty || (c.bodyM && c.dirty)))) c._pose();
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
      car._kappa = U.wrapAngle(Math.atan2(-_F.tz, _F.tx) - Math.atan2(-_R.tz, _R.tx)) / (bf - br); car._bank = bank;
      const yF = Math.atan2(-_F.tz, _F.tx) - yawBody, yR = Math.atan2(-_R.tz, _R.tx) - yawBody;
      // bogie 0 of the design sits at +X; a flipped car's design +X is at its rear
      const a = U.wrapAngle(car.flip ? yR : yF), b = U.wrapAngle(car.flip ? yF : yR), nb = car.yaw.length;
      if (Math.abs(a - car.yaw[0]) > 1e-5 || Math.abs(b - car.yaw[nb - 1]) > 1e-5) { car.yaw[0] = a; car.yaw[nb - 1] = b; car.dirty = true; }
      if (car.design.artic) articulate(car, frame, dc, yawBody);
      if (car.shoeDy && car.lod === 0 && MT()) { shoesFromRail(car, _F, car.flip ? 1 : 0); shoesFromRail(car, _R, car.flip ? 0 : 1); }
    }
  }
  // Collector shoes from infra's contact rail under each truck (MetroTrack.thirdRail, notes/bart/infra.md "Third
  // rail"): the shoe over the rail rides its contact surface (end ramps included), the other hangs free. Needs frames
  // from MetroNet (they carry track and s); LOD 0 cars only (~2 us per truck).
  const MT = () => (typeof MetroTrack !== 'undefined' && MetroTrack.thirdRail) ? MetroTrack : null;
  function shoesFromRail(car, P, bogie) {
    const d = car.design; if (!P.track || P.s === undefined) return;
    const r = MetroTrack.thirdRail(P.track, P.s);
    let side = 0, top = 0;
    if (r) {
      // the rail's side in the car's design frame: the track's right (facing +s; path frames are flipped on reversed
      // segments) against the car's +Z (the group's, reversed on a flipped car)
      const sg = P.sign === undefined ? 1 : P.sign, rx = (P.rx || 0) * sg, rz = (P.rz || 0) * sg, yaw = car.group.rotation.y;
      side = Math.sign(r.side * (rx * Math.sin(yaw) + rz * Math.cos(yaw))) * (car.flip ? -1 : 1); top = r.top;
    }
    for (let i = 0; i < d.shoes.length; i++) { const S0 = d.shoes[i]; if (S0.bogie !== bogie) continue;
      const dy = S0.side === side ? top - S0.top : S0.free;
      if (Math.abs(dy - car.shoeDy[i]) > 5e-4) { car.shoeDy[i] = dy; car.dirty = true; } }
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
  // ------------------------------------------------------------------------------------------ resources
  const live = new Set(), farBatches = new Set();
  K.live = live; K.farBatches = farBatches;
  K.atlasRes = () => Q <= 1 ? 1024 : 2048;
  function disposeDesign(d) {
    for (const g of [d.ext, d.glass, d.lod1, d.lod2, d.lodb1, d.lodb2, d.lod2f, d.lodb2f]) if (g && g.dispose) g.dispose();
    if (d.bake) { d.bake.rt.dispose(); d.bake = null; }
    if (d.int) { for (const k of ['geo', 'glass']) if (d.int[k] && d.int[k].dispose) d.int[k].dispose(); }
  }
  function releaseUnused(qChanged) {
    if (qChanged) for (const f of farBatches) f.reset();
    const used = new Set(), atl = new Set();
    for (const c of live) { for (const car of c.cars) used.add(car.design); if (c.atlasTex) atl.add(c.atlasTex); }
    for (const f of farBatches) { for (const d of f.designs) used.add(d); if (f.atlas) atl.add(f.atlas); }
    for (const key of Object.keys(designs)) { const d = designs[key]; if (used.has(d) || key.endsWith(':q' + Q)) continue; disposeDesign(d); delete designs[key]; }
    if (K.releaseAtlases) { if (K.decalAtlas) atl.add(K.decalAtlas(K.atlasRes())); K.releaseAtlases(atl); }
  }
  // what MetroKit holds on the GPU (estimates from buffer and texture sizes) and how much it draws
  const geoBytes = g => { if (!g || !g.attributes) return 0; let b = g.index ? g.index.array.byteLength : 0; for (const k in g.attributes) b += g.attributes[k].array.byteLength; return b; };
  // (tris / casters: triangles of the visible meshes / of the visible shadow casters, per pass; draws: visible meshes)
  const triCount = g => g ? (g.index ? g.index.count : g.attributes.position.count) / 3 * (g.isInstancedBufferGeometry ? g.instanceCount : 1) : 0;
  function stats() {
    let geo = 0, lcd = 0, sign = 0, bones = 0, cars = 0, lod0 = 0, ints = 0, tris = 0, casters = 0, draws = 0;
    for (const key of Object.keys(designs)) { const d = designs[key]; geo += geoBytes(d.ext) + geoBytes(d.glass) + geoBytes(d.lod1) + geoBytes(d.lod2) + (d.int ? geoBytes(d.int.geo) + geoBytes(d.int.glass) : 0); }
    for (const c of live) { sign += SIGN.W * SIGN.H * 4; if (c.lcdTex) lcd += c.lcdTex.userData.bytes || 0;
      for (const car of c.cars) { cars++; if (car.lod === 0) lod0++; if (car.int && car.int.visible) ints++; const bt = car.skeleton && car.skeleton.boneTexture; if (bt) bones += bt.image.data.byteLength;
        if (car.group.visible) car.group.traverseVisible(o => { if (!o.isMesh) return; const n = triCount(o.geometry); draws++; tris += n; if (o.castShadow) casters += n; }); } }
    let bake = 0; for (const key of Object.keys(designs)) { const d = designs[key]; if (d.bake) bake += d.bake.bytes; geo += geoBytes(d.lodb1) + geoBytes(d.lodb2); }
    const atlas = (K.atlasBytes ? K.atlasBytes() : 0) + bake, MB = 1 / 1048576;
    return { quality: Q, consists: live.size, cars, lod0Cars: lod0, interiorsShown: ints, draws, ktris: Math.round(tris / 1000), kcasterTris: Math.round(casters / 1000), designs: Object.keys(designs).length,
      geometryMB: +(geo * MB).toFixed(1), atlasMB: +(atlas * MB).toFixed(1), bakedMB: +(bake * MB).toFixed(1), screensMB: +(lcd * MB).toFixed(1), signsMB: +(sign * MB).toFixed(2), bonesMB: +(bones * MB).toFixed(2),
      totalMB: +((geo + atlas + lcd + sign + bones) * MB).toFixed(1) };
  }
  // the camera's world position (the interior policy needs it): the camera the cars were last drawn with (their glass
  // or LOD mesh notes it; that is the view, also when a capture camera stands in for the player's), else Env's camera
  const _camW = new V3(); let _camT = -1e9, _camTan = TAN_GAME;
  function camPos() {
    if (performance.now() - _camT < 400) return _camW;
    const cam = typeof Env !== 'undefined' && Env.camera; if (cam) { _camTan = camTan(cam); return _camW.copy(cam.position); }
    return null;
  }
  K.noteCamera = cam => { _camW.setFromMatrixPosition(cam.matrixWorld); _camTan = camTan(cam); _camT = performance.now(); };
  // a long lens magnifies: distances for the level of detail are the apparent ones (the real distance x tan(fov / 2) /
  // tan(55 deg / 2), the game's view; never more than the real one, so nothing changes at the game's field of view).
  // A 120 mm trailer lens (vertical fov ~11 deg) makes a car 400 m away count as ~77 m. Same rule as MetroSim's
  function camTan(cam) { return cam && cam.isPerspectiveCamera ? Math.tan(cam.fov * Math.PI / 360) / (cam.zoom || 1) : TAN_GAME; }
  function camLens() { return Math.min(1, _camTan / TAN_GAME); }
  // capture mode (tools/capture.mjs: frames stepped offline by the harness)
  function capturing() { const B = typeof window !== 'undefined' && window.__bayline; return !!(B && B.capture && B.capture.on); }

  // wetness: an explicit value (setWet, previews), else infra's rain-driven wetness (MetroTrack.uWet: wets in ~40 s of
  // rain, dries in ~15 min), else dry
  let wetOverride = -1;
  function wetNow() {
    if (wetOverride >= 0) return wetOverride;
    if (typeof MetroTrack !== 'undefined' && MetroTrack.uWet) return MetroTrack.uWet.value || 0;
    return 0;
  }
  function setWet(w) { wetOverride = w === null || w === undefined || w < 0 ? -1 : clamp(+w, 0, 1); MKG.mkWet.value = wetNow(); }
  function createConsist(kind, opts) { return new Consist(kind, opts); }

  // ------------------------------------------------------------------------------------------ precompile
  // Every MetroKit program compiled before the first train shows (a compile on the frame a consist, an interior or a
  // doorway first appears is a visible hitch): a hidden prototype, a D-E-D consist at the current quality with an
  // interior, the glazing's impression and clear variants, a doorway impression, the Low LOD material and the far
  // batch's instanced one and the lamp billboards, compiled with compileAsync against the game's scene (its lights,
  // environment and fog) while a render target is bound (the post pipeline draws the scene into one), then its GPU
  // textures dropped; its materials stay referenced so their programs stay compiled. The bake programs are started too.
  // Sliced over a few frames (designs, interiors, compile). Runs by itself after boot when the metro is on; returns a
  // promise; MetroKit.precompile(scene, camera) to run it explicitly.
  let _pre = null; const _keep = [];
  function precompile(scene, camera) {
    if (_pre) return _pre;
    const r = K.renderer && K.renderer(), sc = scene || (typeof Env !== 'undefined' && Env.scene), cam = camera || (typeof Env !== 'undefined' && Env.camera);
    if (!r || !sc || !cam || !r.compileAsync) return Promise.resolve(null);
    const t0 = performance.now(), later = f => new Promise(res => setTimeout(() => res(f()), 0));
    _pre = (async () => {
      await later(() => { getDesign('bart', 'D'); });
      await later(() => { getDesign('bart', 'E'); });
      let c = null;
      await later(() => { c = new Consist('bart', { cars: 3, name: 'precompile' }); live.delete(c); });
      await later(() => { c._buildInterior(c.cars[0]); });
      await later(() => { c._buildInterior(c.cars[1]); });
      const g = new THREE.Group(), bind = (geo, mat, car) => { const m = new THREE.SkinnedMesh(geo, mat); m.bind(car.skeleton, _I4); m.bindMode = 'detached'; m.frustumCulled = false; g.add(m); _keep.push(mat); return m; };
      for (const car of c.cars) { g.add(car.group); _keep.push(car.mat, car.matGlass); if (car.int) { car.int.visible = true; car.int.traverse(o => { if (o.material) _keep.push(o.material); }); } }
      const car = c.cars[0], d = car.design;
      bind(d.glass, c.glassClear, car);                                             // the glazing with the interior built
      const og = openingsGeometry(d); if (og) bind(og, glassMaterial(car.S, true), car);   // a doorway impression
      bind(d.glass, palMaterial('lod', car.S), car);                                // the Low tier's LOD material (skinned)
      const im = new THREE.InstancedMesh(d.glass, palMaterial('lod', car.S), 1); im.frustumCulled = false; g.add(im); _keep.push(im.material);   // the far batch's
      if (K.makeGlow) { const gl = K.makeGlow(1); g.add(gl.mesh); _keep.push(gl.mesh.material); }
      if (K.requestBake) K.requestBake(d, null);                                   // (compiles the bake programs, bakes D)
      const tmp = new THREE.WebGLRenderTarget(4, 4), prev = r.getRenderTarget();
      r.setRenderTarget(tmp);
      let p = null; try { p = r.compileAsync(g, cam, sc); } finally { r.setRenderTarget(prev); }
      await p;
      tmp.dispose(); c.signTex.dispose(); if (c.lcdTex) c.lcdTex.dispose();
      for (const k of c.cars) { if (k.skeleton) k.skeleton.dispose(); if (k.group.parent) k.group.parent.remove(k.group); }
      const out = { ms: Math.round(performance.now() - t0), programs: r.info.programs.length };
      K.precompiled = out; return out;
    })().catch(e => { console.warn('MetroKit: precompile failed', e); return null; });
    return _pre;
  }
  // (after boot, once the renderer, the scene and the metro are up)
  if (typeof window !== 'undefined') setTimeout(function kick() {
    // (the game has drawn some frames: its scene, lights and pipeline are set up)
    if (typeof Env === 'undefined' || !Env.renderer || typeof MetroSim === 'undefined' || Env.renderer.info.render.frame < 60) { setTimeout(kick, 1000); return; }
    if (MetroSim.enabled === false) return;
    precompile();
  }, 1500);
  K.imapUniforms = imapUniforms; K.blankTex = blankTex;
  K.builders = builders; K.SIGN = SIGN; K.getDesign = getDesign; K.glassMaterial = glassMaterial; K.LINE_COLORS = LINE_COLORS; K.ledText = ledText;
  K.FONT = FONT; K.Consist = Consist; K.Car = Car;

  const createFarBatch = (scene, o) => K.createFarBatch(scene, o);
  return { _k: K, setQuality, setWet, stats, precompile, setRenderer: r => K.setRenderer && K.setRenderer(r), bakesSettled: () => K.bakesSettled ? K.bakesSettled() : Promise.resolve(), createConsist, poseCar, poseOnTrack, createFarBatch, LINE_COLORS, designs, get quality() { return Q; } };
})();
if (typeof window !== 'undefined') (window.__baylineMods = window.__baylineMods || {}).MetroKit = MetroKit;
