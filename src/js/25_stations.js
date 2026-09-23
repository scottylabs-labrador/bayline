// Stations v2: the real Peninsula stations. Platforms fitted to the running lanes (coping stones, truncated-dome
// tactile strips, expansion joints, end ramps, mini-high boarding blocks), canopies and shelters (from OSM
// building=roof / amenity=shelter where mapped), historic depots placed on their OSM footprints, underpass
// entrances and pedestrian crossings from OSM, and the full kit of platform furniture (benches, bins, ticket
// machines, card validators, help points, maps, bike racks and lockers, CCTV, clocks, LED lighting with night
// light pools, dot-matrix departure boards, name signs, stop marks, fences). Built lazily, nearest station first,
// after the fine terrain under it has streamed in (Terrain.ensure); details hidden beyond ~900 m.
// Gameplay API is unchanged: init, update, list, nearest, spawnPoint, platformY, platLat, PH, group, people.
const Stations = (() => {
  const group = new THREE.Group(); group.name = 'stations';
  const F = {}, F2 = {};
  const list = [];          // per station: { id, name, idx, s, plats:[{s0,s1,side,w}], platFor, stop:[sNB, sSB], door:[sideNB, sideSB], obj, boards… }
  const PH = 0.25;          // platform top above top of rail (m)
  const EDGE = 1.72;        // lane centre -> platform edge
  const COP = 0.30, TAC = 0.91;   // coping band, tactile warning strip (m from the platform edge)
  const RAMP = 7.0;         // end ramps (m)
  const MH = 0.31;          // mini-high block above the platform top (≈ 22" above rail)
  // Real station character. canopy: 'long' (continuous canopies) | 'shelters'; n: shelters per platform;
  // under: fraction(s) along the platform with an underpass entrance; xing: at-grade pedestrian crossing at the
  // platform 'start' | 'end' | 'both'; midFence: fence between the tracks; depot: Depots style (by-name lookup).
  const CFG = {
    san_francisco: { canopy: 'shelters', n: 3, midFence: false, depot: 'terminal', big: 1 },
    '22nd_street': { canopy: 'shelters', n: 2, midFence: false },
    bayshore: { canopy: 'shelters', n: 2 },
    south_sf: { canopy: 'long', under: [0.5], big: 1 },
    san_bruno: { canopy: 'long' },
    place_MLBR: { canopy: 'long', big: 1, depot: 'modern' },
    broadway: { canopy: 'shelters', n: 1, xing: 'both' },
    burlingame: { canopy: 'shelters', n: 2, xing: 'end', depot: 'mission' },
    san_mateo: { canopy: 'shelters', n: 2, xing: 'both', depot: 'mission' },
    hayward_park: { canopy: 'shelters', n: 2 },
    hillsdale: { canopy: 'long', under: [0.5], big: 1 },
    belmont: { canopy: 'long', under: [0.5] },
    san_carlos: { canopy: 'shelters', n: 2, depot: 'stone' },
    redwood_city: { canopy: 'long', xing: 'end', big: 1, depot: 'modern' },
    menlo_park: { canopy: 'shelters', n: 2, xing: 'both', depot: 'victorian' },
    palo_alto: { canopy: 'shelters', n: 3, under: [0.55], big: 1, depot: 'streamline' },
    stanford: { canopy: 'shelters', n: 1 },
    california_ave: { canopy: 'shelters', n: 2, under: [0.5] },
    san_antonio: { canopy: 'shelters', n: 2, xing: 'end' },
    mountain_view: { canopy: 'long', xing: 'start', big: 1, depot: 'modern' },
    sunnyvale: { canopy: 'shelters', n: 3, xing: 'end', depot: 'mission' },
    lawrence: { canopy: 'shelters', n: 2, under: [0.5] },
    santa_clara: { canopy: 'shelters', n: 2, under: [0.5], depot: 'victorian' },
    college_park: { canopy: 'shelters', n: 1, midFence: false },
    sj_diridon: { canopy: 'long', under: [0.45], big: 1, depot: 'diridon' },
    tamien: { canopy: 'shelters', n: 2, under: [0.5] },
    capitol: { canopy: 'shelters', n: 1 },
    blossom_hill: { canopy: 'shelters', n: 1 },
    morgan_hill: { canopy: 'shelters', n: 1, depot: 'mission' },
    san_martin: { canopy: 'shelters', n: 1 },
    gilroy: { canopy: 'shelters', n: 1, depot: 'mission' },
  };
  const cfg = (st) => Object.assign({ canopy: 'shelters', n: 2, midFence: true, under: null, xing: null, depot: null, big: 0 }, CFG[st.id] || {});
  let OSM = null, osmReady = null;          // baked OSM details per station (data/pub/v2/stations/osm.json)
  const M = {};

  // ---------- materials ----------
  function mats() {
    // platform concrete: coping band, truncated-dome tactile strip, expansion joints, wear (attribute aPl =
    // along-platform metres, metres from the track edge, surface kind 0 top / 1 face / 2 plain concrete)
    M.plat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    M.plat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aPl; varying vec3 vPl; varying vec3 vWp;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPl = aPl; vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vPl; varying vec3 vWp; float gDome; float gJ;
          float pH(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
          float pN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(pH(i), pH(i + vec2(1, 0)), f.x), mix(pH(i + vec2(0, 1)), pH(i + vec2(1, 1)), f.x), f.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            float along = vPl.x, ed = vPl.y, kind = vPl.z;
            float fw = max(fwidth(along), fwidth(ed));
            float n1 = pN(vWp.xz * 0.31), n2 = pN(vWp.xz * 2.3), n3 = pH(floor(vWp.xz * 37.0));
            vec3 conc = vec3(0.60, 0.585, 0.55) * (0.88 + 0.14 * n1 + 0.05 * n2);
            vec3 col; gDome = 0.0; gJ = 0.0;
            if (kind > 1.5) {                       // plain concrete (mini-high sides, stair cheeks)
              col = conc * 0.93;
            } else if (kind > 0.5) {                // vertical faces: darker, weathered at the bottom
              col = vec3(0.50, 0.49, 0.47) * (0.8 + 0.2 * n2);
            } else {
              float cop = 1.0 - smoothstep(COPx - 0.004, COPx + fw, ed);
              float tac = smoothstep(COPx - 0.004, COPx + fw, ed) * (1.0 - smoothstep(TACx - 0.004, TACx + fw, ed));
              col = conc;
              col = mix(col, vec3(0.71, 0.70, 0.675) * (0.95 + 0.08 * n2), cop);
              // truncated domes on a 60 mm grid; they fade to a flat tint when they get smaller than a pixel
              vec2 g = vec2(along, ed - COPx) / 0.0605; vec2 c = fract(g) - 0.5; float r = length(c);
              float near = 1.0 - smoothstep(0.004, 0.018, fw);
              gDome = (1.0 - smoothstep(0.16, 0.2, r)) * tac * near;
              vec3 yel = vec3(0.80, 0.585, 0.085) * (0.9 + 0.1 * n1) * (1.0 - 0.1 * smoothstep(0.7, 0.2, ed));
              col = mix(col, yel * mix(0.9, 0.84 + 0.2 * gDome, near), tac);
              // transverse expansion joints every 3 m, saw-cut lines between the bands
              float jt = 1.0 - smoothstep(0.0, 0.01 + fw * 1.5, abs(fract(along / 3.0 + 0.5) - 0.5) * 3.0);
              float jl = 1.0 - smoothstep(0.0, 0.006 + fw, abs(ed - TACx - 0.02));
              gJ = max(jt * (1.0 - tac), jl);
              col *= 1.0 - 0.3 * gJ;
              // wear: darker, oil-stained strip where people stand at the edge; gum spots
              col *= 1.0 - 0.07 * smoothstep(2.4, 1.0, ed) * n1 * (1.0 - tac);
              col = mix(col, vec3(0.2, 0.2, 0.19), step(0.9983, n3) * (1.0 - tac) * (1.0 - cop) * 0.55);
            }
            diffuseColor.rgb = col;
          }`.replace(/COPx/g, COP.toFixed(3)).replace(/TACx/g, TAC.toFixed(3)))
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {   // bump the domes and joints (screen-space derivative bump mapping)
            float hb = gDome * 0.004 - gJ * 0.003;
            vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition); float hx = dFdx(hb), hy = dFdy(hb);
            vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx); float det = dot(dpx, r1);
            if (abs(det) > 1e-12) normal = normalize(abs(det) * normal - sign(det) * (hx * r1 + hy * r2) * 60.0);
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.62, gDome);`);
    };
    M.steel = new THREE.MeshStandardMaterial({ color: 0x2c3035, roughness: 0.5, metalness: 0.55 });           // painted steel
    M.galv = new THREE.MeshStandardMaterial({ color: 0xaeb3b8, roughness: 0.35, metalness: 0.85 });          // stainless / galvanised rails
    M.roof = new THREE.MeshStandardMaterial({ color: 0xdadcde, roughness: 0.42, metalness: 0.45, side: THREE.DoubleSide, envMapIntensity: 0.7 });
    M.glass = new THREE.MeshStandardMaterial({ color: 0xa9c6cf, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.2 });
    M.props = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 });
    M.lamp = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, emissive: 0xfff2dc, emissiveIntensity: 0, roughness: 0.4 });
    M.blue = new THREE.MeshStandardMaterial({ color: 0x0c2f6b, emissive: 0x3d8bff, emissiveIntensity: 0.4, roughness: 0.3 });
    M.fence = new THREE.MeshStandardMaterial({ color: 0x25282c, roughness: 0.55, metalness: 0.5, side: THREE.DoubleSide, alphaTest: 0.5,
      map: U.canvasTexture(64, 64, (c, w, h) => { c.clearRect(0, 0, w, h); c.fillStyle = '#fff'; for (let i = 0; i < 4; i++) c.fillRect(i * 16 + 6, 0, 4, h); c.fillRect(0, 0, w, 5); c.fillRect(0, h - 5, w, 5); }, { repeat: true, srgb: false }) });
    M.fence.map.wrapS = M.fence.map.wrapT = THREE.RepeatWrapping;
    M.dark = new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.9 });
    M.pool = new THREE.MeshBasicMaterial({ color: 0xffe0b2, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      map: U.canvasTexture(128, 128, (c) => { const g = c.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.45, 'rgba(255,255,255,0.4)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, 128, 128); }) });
    M.stopTex = U.canvasTexture(128, 160, (c, w, h) => { c.fillStyle = '#f2c230'; c.fillRect(0, 0, w, h); c.strokeStyle = '#111'; c.lineWidth = 8; c.strokeRect(4, 4, w - 8, h - 8);
      c.fillStyle = '#111'; c.font = '800 40px Barlow Condensed, sans-serif'; c.textAlign = 'center'; c.fillText('STOP', w / 2, 58); c.fillRect(22, 78, w - 44, 26); c.fillStyle = '#f2c230'; c.fillRect(30, 84, 18, 12); c.fillRect(56, 84, 18, 12); c.fillRect(82, 84, 18, 12);
      c.fillStyle = '#111'; c.font = '700 30px Barlow Condensed, sans-serif'; c.fillText('7 CAR', w / 2, 140); });
    M.stop = new THREE.MeshStandardMaterial({ map: M.stopTex, roughness: 0.5, emissive: 0xffffff, emissiveMap: M.stopTex, emissiveIntensity: 0.05, side: THREE.DoubleSide });
    M.underTex = U.canvasTexture(256, 64, (c, w, h) => { c.fillStyle = '#23272d'; c.fillRect(0, 0, w, h); c.fillStyle = '#d7263d'; c.fillRect(0, 0, 10, h);
      c.fillStyle = '#f4f2ec'; c.font = '600 30px "Barlow Condensed", sans-serif'; c.textBaseline = 'middle'; c.fillText('⇣  Underpass · Exit', 24, h / 2 + 2); });
    M.under = new THREE.MeshStandardMaterial({ map: M.underTex, roughness: 0.5, emissive: 0xffffff, emissiveMap: M.underTex, emissiveIntensity: 0 });
    M.clockTex = U.canvasTexture(128, 128, (c) => { c.fillStyle = '#f4f3ef'; c.beginPath(); c.arc(64, 64, 62, 0, 7); c.fill(); c.strokeStyle = '#111'; c.lineWidth = 6; c.stroke();
      c.fillStyle = '#111'; for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; c.fillRect(64 + Math.sin(a) * 50 - 2, 64 - Math.cos(a) * 50 - 5, 4, 10); }
      c.lineCap = 'round'; c.lineWidth = 7; c.beginPath(); c.moveTo(64, 64); c.lineTo(64 + 28, 64 - 16); c.stroke(); c.lineWidth = 4; c.beginPath(); c.moveTo(64, 64); c.lineTo(64 - 8, 64 - 46); c.stroke(); });
    M.clock = new THREE.MeshStandardMaterial({ map: M.clockTex, roughness: 0.4, emissive: 0xffffff, emissiveMap: M.clockTex, emissiveIntensity: 0 });
  }

  // ---------- platform layout from OSM platforms + lanes (gameplay; unchanged) ----------
  function layout(st) {
    const around = Track.feat.platforms.filter(p => p.s1 > st.s - 260 && p.s0 < st.s + 260);
    const plats = [];
    const lN = Track.lane(st.s, 0), lS = Track.lane(st.s, 1);
    const single = Math.abs(lS - lN) < 1.0;
    let sMin = 1e9, sMax = -1e9;
    for (const p of around) {
      const sm = (p.s0 + p.s1) / 2; const a = Track.lane(sm, 0), b = Track.lane(sm, 1);
      let side;
      if (single) side = p.off >= a ? 'R' : 'L';
      else if (p.off > b + 0.4) side = 'R'; else if (p.off < a - 0.4) side = 'L';
      else side = (b - a > 2 * EDGE + 2.4) ? 'I' : (p.off > (a + b) / 2 ? 'R' : 'L');
      let s0 = p.s0, s1 = Math.max(p.s1, p.s0 + 60);
      if (s1 - s0 < 120) { const m = (s0 + s1) / 2; s0 = m - 90; s1 = m + 90; }       // short OSM pieces -> a usable platform
      // width: area centreline -> twice the distance to its inner edge; line (edge) -> 4.5 m
      const inner = side === 'R' ? b + EDGE : side === 'L' ? a - EDGE : 0;
      let w = p.closed ? U.clamp(2 * Math.abs(p.off - inner), 3.4, 6.5) : U.clamp(Math.abs(p.off - inner) > 2.5 ? Math.abs(p.off - inner) : 4.5, 3.4, 6);
      if (Math.abs(p.off - inner) > 14) continue;                                          // belongs to another line (BART etc.)
      if (plats.some(q => q.side === side && q.s0 < s1 && s0 < q.s1)) { const q = plats.find(q => q.side === side && q.s0 < s1 && s0 < q.s1); q.s0 = Math.min(q.s0, s0); q.s1 = Math.max(q.s1, s1); continue; }
      plats.push({ s0, s1, side, w, ref: p.ref || '' });
    }
    if (!plats.length) { // no OSM platform: island if the tracks spread, else two side platforms
      const s0 = st.s - 100, s1 = st.s + 100;
      if (single) plats.push({ s0, s1, side: st.off >= lN ? 'R' : 'L', w: 4.5 });
      else if (lS - lN > 2 * EDGE + 2.4) plats.push({ s0, s1, side: 'I', w: 0 });
      else { plats.push({ s0, s1, side: 'L', w: 4.5 }, { s0, s1, side: 'R', w: 4.5 }); }
    }
    if (!single && !plats.some(p => p.side === 'I')) { // make sure both directions have a platform
      if (!plats.some(p => p.side === 'R')) { const q = plats[0]; plats.push({ s0: q.s0, s1: q.s1, side: 'R', w: 4.5 }); }
      if (!plats.some(p => p.side === 'L')) { const q = plats[0]; plats.push({ s0: q.s0, s1: q.s1, side: 'L', w: 4.5 }); }
    }
    if (st.id === 'san_francisco') for (const p of plats) { p.s0 = Math.max(0, p.s0); p.s1 = Math.max(p.s1, 225); }
    if (st.id === 'gilroy') for (const p of plats) { p.s0 = Math.min(p.s0, Track.length - 215); }
    for (const p of plats) { p.s0 = Math.max(0, p.s0); p.s1 = Math.min(Track.length - 1, p.s1); sMin = Math.min(sMin, p.s0); sMax = Math.max(sMax, p.s1); }
    // stop points (train head) and door sides per direction
    const pick = (dir) => plats.find(p => p.side === 'I') || plats.find(p => p.side === (dir ? 'R' : 'L')) || plats[0];
    const pN = pick(0), pS = pick(1);
    const doorSide = (p, dir) => { if (p.side === 'I') return dir ? -1 : 1; return p.side === 'R' ? 1 : -1; };
    st.plats = plats; st.sMin = sMin; st.sMax = sMax;
    st.platFor = [pN, pS];
    // head-of-train stop marks; at the terminals the whole train must fit on the track
    st.stop = [Math.min(Math.max(6, pN.s0 + 10), Track.length - 200), Math.max(Math.min(Track.length - 6, pS.s1 - 10), 200)];
    st.door = [doorSide(pN, 0), doorSide(pS, 1)];
  }
  // lateral extent of a platform at s: [latInner, latOuter]
  function platLat(p, s) {
    const a = Track.lane(s, 0), b = Track.lane(s, 1);
    if (p.side === 'R') return [b + EDGE, b + EDGE + p.w];
    if (p.side === 'L') return [a - EDGE, a - EDGE - p.w];
    return [a + EDGE, b - EDGE];
  }

  // ---------- small geometry kit (every part carries a colour attribute so parts of one material merge) ----------
  const tintc = (g, c) => U.tint(g, c);
  const bx = (w, h, d, x, y, z, c, ry = 0, rx = 0, rz = 0) => tintc(U.place(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz), c);
  const cy = (r0, r1, h, x, y, z, c, seg = 10, rx = 0, rz = 0) => tintc(U.place(new THREE.CylinderGeometry(r0, r1, h, seg), x, y, z, rx, 0, rz), c);
  const pl = (w, h, x, y, z, c, ry = 0, rx = 0) => tintc(U.place(new THREE.PlaneGeometry(w, h), x, y, z, rx, ry, 0), c);
  const merge = (arr) => U.mergeGeometries(arr);
  // Prototypes in a local frame: +X along the platform, +Z away from the track (back), y = 0 on the platform top.
  const PROTO = {};
  function protos() {
    const GREY = 0x4a525a, DARK = 0x23272c, STEEL = 0x2c3035, LIGHT = 0xc9cdd1;
    // bench: perforated steel seat and back on three cast legs
    const bench = [];
    bench.push(bx(1.8, 0.05, 0.42, 0, 0.44, 0.02, 0x3e4a54), bx(1.8, 0.36, 0.05, 0, 0.66, 0.22, 0x3e4a54, 0, -0.18));
    for (const x of [-0.8, 0, 0.8]) bench.push(bx(0.06, 0.44, 0.38, x, 0.22, 0.04, STEEL), bx(0.06, 0.42, 0.05, x, 0.64, 0.23, STEEL, 0, -0.18));
    for (const x of [-0.9, 0.9]) bench.push(bx(0.05, 0.05, 0.36, x, 0.62, 0.02, STEEL));
    PROTO.bench = merge(bench);
    // trash + recycling pair
    PROTO.bins = merge([cy(0.27, 0.25, 0.92, -0.33, 0.46, 0, 0x2b3137, 14), cy(0.29, 0.29, 0.08, -0.33, 0.96, 0, 0x1c2024, 14),
      cy(0.27, 0.25, 0.92, 0.33, 0.46, 0, 0x2d6aa3, 14), cy(0.29, 0.29, 0.08, 0.33, 0.96, 0, 0x234f78, 14)]);
    // card validator pedestal (generic: grey post, blue reader, small screen)
    PROTO.validator = merge([bx(0.14, 1.0, 0.12, 0, 0.5, 0, 0x8e949a), bx(0.26, 0.34, 0.14, 0, 1.12, 0, 0x2a2e33),
      bx(0.2, 0.2, 0.012, 0, 1.16, -0.075, 0x2a78cf), bx(0.12, 0.06, 0.012, 0, 1.25, -0.075, 0x0c0e10), bx(0.3, 0.03, 0.26, 0, 0.015, 0, 0x55595e)]);
    // ticket vending machine: light grey cabinet, dark screen, red header band
    PROTO.tvm = merge([bx(0.86, 1.82, 0.5, 0, 0.91, 0, LIGHT), bx(0.86, 0.16, 0.52, 0, 1.76, 0, 0xc4312a), bx(0.44, 0.34, 0.02, -0.12, 1.3, -0.26, 0x0c1216),
      bx(0.2, 0.26, 0.02, 0.26, 1.28, -0.26, 0x2b2f34), bx(0.3, 0.1, 0.03, -0.12, 0.95, -0.26, 0x1b1e21), bx(0.5, 0.2, 0.06, -0.1, 0.6, -0.27, 0x9aa0a6), bx(0.9, 0.05, 0.54, 0, 0.025, 0, 0x55595e)]);
    // help point: dark post, speaker box, blue beacon (beacon separate: emissive)
    PROTO.help = merge([bx(0.12, 2.3, 0.12, 0, 1.15, 0, DARK), bx(0.3, 0.5, 0.16, 0, 1.35, -0.07, 0x1d4f9c), bx(0.18, 0.1, 0.02, 0, 1.48, -0.16, 0xe8e8e8), cy(0.09, 0.09, 0.05, 0, 1.2, -0.16, 0xd8312a, 12, Math.PI / 2)]);
    PROTO.helpBeacon = merge([cy(0.07, 0.07, 0.16, 0, 2.38, 0, 0xffffff, 12)]);
    // map / timetable case: framed double panel on posts
    PROTO.mapcase = merge([bx(0.08, 2.2, 0.08, -0.62, 1.1, 0, DARK), bx(0.08, 2.2, 0.08, 0.62, 1.1, 0, DARK), bx(1.2, 1.5, 0.07, 0, 1.3, 0, 0x2a2e33),
      bx(1.08, 1.36, 0.075, 0, 1.3, 0, 0xe9e6de), bx(1.2, 0.18, 0.09, 0, 2.12, 0, 0xc4312a)]);
    // leaning rail
    PROTO.lean = merge([cy(0.035, 0.035, 1.0, -0.8, 0.5, 0, 0xaeb3b8, 8), cy(0.035, 0.035, 1.0, 0.8, 0.5, 0, 0xaeb3b8, 8), cy(0.04, 0.04, 1.8, 0, 1.0, 0, 0xaeb3b8, 8, 0, Math.PI / 2)]);
    // light pole: tapered pole, short arm toward the track, LED head (head is separate: emissive)
    PROTO.pole = merge([cy(0.07, 0.1, 5.3, 0, 2.65, 0, STEEL, 10), bx(0.05, 0.05, 0.75, 0, 5.2, -0.36, STEEL), cy(0.16, 0.2, 0.25, 0, 0.12, 0, STEEL, 10), bx(0.16, 0.22, 0.12, 0, 3.1, 0.07, 0x3b4046)]);
    PROTO.poleHead = merge([bx(0.62, 0.07, 0.26, 0, 5.18, -0.78, 0xffffff)]);
    // CCTV mast
    PROTO.cctv = merge([cy(0.05, 0.06, 3.6, 0, 1.8, 0, STEEL, 8), bx(0.1, 0.1, 0.3, 0, 3.55, -0.12, 0xdfe1e3, 0, 0.35), cy(0.05, 0.05, 0.06, 0, 3.52, -0.28, 0x111111, 10, Math.PI / 2 - 0.35)]);
    // bike rack (5 inverted U) and a bank of 6 bike lockers
    const rack = []; for (let i = 0; i < 5; i++) { const x = (i - 2) * 0.9; rack.push(cy(0.03, 0.03, 0.82, x, 0.41, -0.3, 0xaeb3b8, 8), cy(0.03, 0.03, 0.82, x, 0.41, 0.3, 0xaeb3b8, 8), cy(0.03, 0.03, 0.6, x, 0.82, 0, 0xaeb3b8, 8, Math.PI / 2)); }
    PROTO.rack = merge(rack);
    const lock = []; for (let i = 0; i < 6; i++) { const x = (i - 2.5) * 0.82; lock.push(bx(0.8, 1.25, 1.9, x, 0.625, 0, 0xb9b4a6), bx(0.02, 1.1, 0.02, x + 0.4, 0.62, -0.96, 0x5b5850), bx(0.5, 0.35, 0.01, x, 0.9, -0.955, 0x6f6a5f)); }
    lock.push(bx(6 * 0.82 + 0.1, 0.08, 2.0, 0, 1.29, 0, 0x8d897d));
    PROTO.lockers = merge(lock);
    // name sign on two posts (board face is added per station with its own texture)
    PROTO.signPosts = merge([bx(0.08, 2.75, 0.08, -1.15, 1.37, 0, STEEL), bx(0.08, 2.75, 0.08, 1.15, 1.37, 0, STEEL), bx(2.5, 0.52, 0.07, 0, 2.52, 0, 0x1c1f23)]);
    // departure board mount (face added per board)
    PROTO.vmsPost = merge([cy(0.06, 0.07, 2.5, 0, 1.25, 0, STEEL, 10), bx(2.2, 0.66, 0.14, 0, 2.78, 0, 0x16181b), bx(2.26, 0.05, 0.2, 0, 3.13, 0, 0x2a2e33)]);
    // clock on a post (faces added per station)
    PROTO.clockPost = merge([cy(0.06, 0.08, 3.1, 0, 1.55, 0, STEEL, 10), cy(0.34, 0.34, 0.12, 0, 3.25, 0, 0x1c1f23, 24, Math.PI / 2)]);
    // stop-mark post
    PROTO.stopPost = merge([bx(0.07, 1.9, 0.07, 0, 0.95, 0, STEEL), bx(0.5, 0.62, 0.03, 0, 1.75, 0.03, 0x1c1f23)]);
    // pedestrian-crossing warning mast: post, two red lamps with hoods, crossbuck plate
    PROTO.xingMast = merge([cy(0.06, 0.07, 2.6, 0, 1.3, 0, 0xdfe1e3, 8), bx(0.8, 0.1, 0.06, 0, 2.2, 0, 0x2a2e33), cy(0.11, 0.11, 0.06, -0.32, 2.2, -0.05, 0x1a1a1a, 12, Math.PI / 2), cy(0.11, 0.11, 0.06, 0.32, 2.2, -0.05, 0x1a1a1a, 12, Math.PI / 2),
      bx(1.0, 0.1, 0.02, 0, 2.45, 0, 0xf2f2ee, 0, 0, Math.PI / 4), bx(1.0, 0.1, 0.02, 0, 2.45, 0, 0xf2f2ee, 0, 0, -Math.PI / 4)]);
    PROTO.xingLamp = merge([cy(0.085, 0.085, 0.02, -0.32, 2.2, -0.085, 0xffffff, 12, Math.PI / 2), cy(0.085, 0.085, 0.02, 0.32, 2.2, -0.085, 0xffffff, 12, Math.PI / 2)]);
    // modern shelter, 6 m x 2.6 m: steel frame, sloped metal roof, glass back and ends, bench, map panel, light strip
    const S = { steel: [], roof: [], glass: [], props: [], lamp: [] };
    for (const x of [-2.85, 0, 2.85]) S.steel.push(bx(0.11, 2.72, 0.11, x, 1.36, 2.45, STEEL));
    for (const x of [-2.85, 2.85]) S.steel.push(bx(0.11, 2.86, 0.11, x, 1.43, 0.25, STEEL));
    S.steel.push(bx(5.9, 0.12, 0.12, 0, 2.8, 0.25, STEEL), bx(5.9, 0.1, 0.1, 0, 2.7, 2.45, STEEL), bx(5.9, 0.06, 0.06, 0, 0.25, 2.45, STEEL));
    S.roof.push(bx(6.5, 0.11, 3.2, 0, 2.86, 1.3, 0xd9dbdd, 0, -0.06));
    S.steel.push(bx(6.52, 0.24, 0.05, 0, 2.92, -0.27, 0x1d2025, 0, -0.06));   // fascia
    S.glass.push(pl(5.6, 2.2, 0, 1.4, 2.45, 0xffffff), pl(2.1, 2.2, -2.85, 1.4, 1.35, 0xffffff, Math.PI / 2), pl(2.1, 2.2, 2.85, 1.4, 1.35, 0xffffff, Math.PI / 2));
    S.props.push(U.place(PROTO.bench, 0, 0, 2.02, 0, Math.PI, 0), bx(1.0, 1.3, 0.05, 2.1, 1.35, 2.4, 0xe9e6de), bx(1.1, 1.4, 0.04, 2.1, 1.35, 2.42, 0x2a2e33));
    S.lamp.push(bx(4.6, 0.04, 0.14, 0, 2.72, 1.0, 0xffffff, 0, -0.06));
    PROTO.shelter = { steel: merge(S.steel), roof: merge(S.roof), glass: merge(S.glass), props: merge(S.props), lamp: merge(S.lamp) };
    // underpass entrance: stair treads descending into a dark well, cheek walls (railings/canopy added separately)
    const st = [];
    for (let i = 0; i < 9; i++) st.push(bx(1.6, 0.17, 0.3, 0, -0.1 - i * 0.17, -2.1 + i * 0.3 + 0.15, 0x8e8b84));
    PROTO.stairs = merge(st);
  }
  const put = (arr, proto, x, y, z, yaw) => { arr.push(U.place(proto, x, y, z, 0, yaw, 0)); };

  // ---------- station-local frames ----------
  let OX = 0, OZ = 0;                                   // origin of the station being built (world)
  const Q = {};
  // point on platform p at along-track s, `ed` metres in from edge `which` (0: inner/NB edge; 1: the SB edge of an
  // island). Returns [x, yTop, z, yaw (+X along the platform, +Z pointing in from that edge), width, railY, dirSign]
  function atPlat(p, s, ed, which = 0, out = []) {
    Track.frame(s, Q); const [li, lo] = platLat(p, s); const sg = Math.sign(lo - li) || 1;
    const inward = which ? -sg : sg, lat = (which ? lo : li) + inward * ed;
    out[0] = Q.x + Q.rx * lat - OX; out[1] = Q.y + PH; out[2] = Q.z + Q.rz * lat - OZ;
    out[3] = Math.atan2(-Q.dz, Q.dx) + (inward > 0 ? 0 : Math.PI);
    out[4] = Math.abs(lo - li); out[5] = Q.y; out[6] = inward > 0 ? 1 : -1; return out;
  }
  const keepPl = (g) => { for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'aPl') g.deleteAttribute(k); return g; };
  // a box on the platform in local frame units, tagged for the platform shader (top faces get the edge bands)
  function platBox(w, h, d, x, y, z, fr, alongBase, topKind = 0) {
    const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z);
    const P = g.attributes.position, Nn = g.attributes.normal, a = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) { a[i * 3] = alongBase + fr[6] * P.getX(i); a[i * 3 + 1] = Math.max(0, P.getZ(i)); a[i * 3 + 2] = Nn.getY(i) > 0.7 ? topKind : 2; }
    g.setAttribute('aPl', new THREE.BufferAttribute(a, 3));
    return keepPl(U.place(g, fr[0], fr[1], fr[2], 0, fr[3], 0));
  }

  // ---------- platform body: coping + tactile + concrete top, track face, outer wall, end ramps / caps ----------
  function platformGeo(st, p) {
    const ramp0 = p.s0 > 20 && st.id !== 'san_francisco', ramp1 = p.s1 < Track.length - 20 && st.id !== 'gilroy';
    const a = ramp0 ? p.s0 - RAMP : p.s0, b = ramp1 ? p.s1 + RAMP : p.s1;
    const ss = new Set(); for (let s = a; s < b; s += 2.5) ss.add(+s.toFixed(3)); ss.add(b); ss.add(p.s0); ss.add(p.s1);
    const H = p.hole || null; if (H) { ss.add(H.s0); ss.add(H.s1); for (const v of [...ss]) if (v > H.s0 && v < H.s1) ss.delete(v); }
    const rows = [...ss].sort((x, y) => x - y);
    const island = p.side === 'I';
    if (H) { H.k0 = 5; H.k1 = island ? 7 : 6; }
    const pos = [], apl = [], idx = []; let K = 0, sgAll = 1;
    const rowCols = [];
    rows.forEach((s, i) => {
      Track.frame(s, F); const [li, lo] = platLat(p, s); const sg = Math.sign(lo - li) || 1; sgAll = sg; const w = Math.abs(lo - li);
      const t = s < p.s0 ? (s - a) / RAMP : s > p.s1 ? 1 - (s - p.s1) / RAMP : 1;
      const yT = F.y + U.lerp(0.03, PH, U.clamp(t, 0, 1)), yB = F.y - 0.42, along = s - p.s0;
      const cols = []; const C = (lat, y, ed, kind) => cols.push([lat, y, ed, kind]);
      if (island) {
        const m = (li + lo) / 2;
        C(li, yB, 0, 1); C(li, yT, 0, 1); C(li, yT, 0, 0); C(li + COP, yT, COP, 0); C(li + TAC, yT, TAC, 0);
        if (H) { C(li + H.ed0, yT, Math.min(H.ed0, w - H.ed0), 0); C(m, yT, w / 2, 0); C(li + H.ed1, yT, Math.min(H.ed1, w - H.ed1), 0); } else C(m, yT, w / 2, 0);
        C(lo - TAC, yT, TAC, 0); C(lo - COP, yT, COP, 0); C(lo, yT, 0, 0); C(lo, yT, 0, 1); C(lo, yB, 0, 1);
      } else {
        const lg = lo + sg * 0.05; const yG = Math.min(Terrain.h(F.x + F.rx * lg, F.z + F.rz * lg) - 0.08, yT - 0.05);
        C(li, yB, 0, 1); C(li, yT, 0, 1); C(li, yT, 0, 0); C(li + sg * COP, yT, COP, 0); C(li + sg * TAC, yT, TAC, 0);
        if (H) { C(li + sg * H.ed0, yT, H.ed0, 0); C(li + sg * H.ed1, yT, H.ed1, 0); }
        C(lo, yT, w, 0); C(lo, yT, w, 1); C(lo, yG, w, 1);
      }
      K = cols.length; rowCols.push(cols.map(([lat, y]) => [F.x + F.rx * lat - OX, y, F.z + F.rz * lat - OZ]));
      for (const [lat, y, ed, kind] of cols) { pos.push(F.x + F.rx * lat - OX, y, F.z + F.rz * lat - OZ); apl.push(along, ed, kind); }
      if (i > 0) for (let k = 0; k < K - 1; k++) {
        if (H && rows[i - 1] >= H.s0 - 1e-3 && s <= H.s1 + 1e-3 && k >= H.k0 && k < H.k1) continue;     // the stairwell
        const a0 = (i - 1) * K + k, a1 = a0 + 1, b0 = a0 + K, b1 = b0 + 1;
        if (sg > 0 || island) idx.push(a0, a1, b0, a1, b1, b0); else idx.push(a0, b0, a1, a1, b0, b1);
      }
    });
    // end caps where there is no ramp (terminal ends): fan over the cross-section, facing out along the track
    const cap = (ri, dirOut) => {
      const base = pos.length / 3; const cols = rowCols[ri]; for (const v of cols) { pos.push(v[0], v[1], v[2]); apl.push(0, 0, 2); }
      const tri = []; for (let k = 1; k < cols.length - 1; k++) tri.push(base, base + k, base + k + 1);
      Track.frame(rows[ri], F); const want = [F.dx * dirOut, F.dz * dirOut];
      const A = cols[0], B = cols[Math.floor(cols.length / 2)], Cc = cols[cols.length - 1];
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = Cc[0] - A[0], vy = Cc[1] - A[1], vz = Cc[2] - A[2];
      const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
      if (nx * want[0] + nz * want[1] < 0) for (let k = 0; k < tri.length; k += 3) { const tmp = tri[k + 1]; tri[k + 1] = tri[k + 2]; tri[k + 2] = tmp; }
      idx.push(...tri);
    };
    if (!ramp0) cap(0, -1); if (!ramp1) cap(rows.length - 1, 1);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aPl', new THREE.Float32BufferAttribute(apl, 3)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }

  // ---------- mini-high boarding block (+ ramp and handrails) near car 2 of the arriving train ----------
  function miniHigh(st, p, dir, B) {
    const which = p.side === 'I' && dir === 1 ? 1 : 0;
    const sM = U.clamp(st.stop[dir] - (dir ? 1 : -1) * 38, p.s0 + 12, p.s1 - 12);
    const fr = atPlat(p, sM, 0, which); const w = fr[4]; if (w < 3.4) return;
    const D = p.side === 'I' ? Math.min(2.3, w / 2 - 0.5) : Math.min(2.3, w - 1.1); const RL = MH * 12;   // 1:12 ramp
    const along0 = sM - p.s0;
    B.plat.push(platBox(5.0, MH, D, 0, MH / 2, D / 2, fr, along0));
    // ramp wedge rising toward the block (on the -X side)
    const rg = new THREE.BoxGeometry(RL, MH, D - 0.95); rg.translate(-2.5 - RL / 2, MH / 2, 0.95 + (D - 0.95) / 2);
    const P = rg.attributes.position; for (let i = 0; i < P.count; i++) if (P.getY(i) > 0.01) P.setY(i, Math.max(0.005, MH * (P.getX(i) + 2.5 + RL) / RL));
    rg.computeVertexNormals();
    const a = new Float32Array(P.count * 3); for (let i = 0; i < P.count; i++) { a[i * 3] = along0 + fr[6] * P.getX(i); a[i * 3 + 1] = P.getZ(i) + 1.5; a[i * 3 + 2] = rg.attributes.normal.getY(i) > 0.5 ? 0 : 2; }
    rg.setAttribute('aPl', new THREE.BufferAttribute(a, 3)); B.plat.push(keepPl(U.place(rg, fr[0], fr[1], fr[2], 0, fr[3], 0)));
    // handrails: back edge along block + ramp, inner side of the ramp, far end of the block
    const toW = (arr) => arr.map(g => U.place(g, fr[0], fr[1], fr[2], 0, fr[3], 0));
    const rails = [];
    const rl = (x0, y0, x1, y1, z) => { const L = Math.hypot(x1 - x0, y1 - y0), ang = Math.atan2(y1 - y0, x1 - x0);
      rails.push(tintc(U.place(new THREE.CylinderGeometry(0.022, 0.022, L, 8), (x0 + x1) / 2, (y0 + y1) / 2, z, 0, 0, ang + Math.PI / 2), 0xaeb3b8)); };
    for (const z of [D - 0.04, 0.97]) {
      rl(-2.5 - RL, 0.9, -2.5, MH + 0.9, z); rl(-2.5 - RL, 0.45, -2.5, MH + 0.45, z);
      if (z > 1) { rl(-2.5, MH + 0.9, 2.5, MH + 0.9, z); rl(-2.5, MH + 0.45, 2.5, MH + 0.45, z); }
      for (let x = -2.5 - RL; x <= 2.51; x += 1.45) { if (z < 1 && x > -2.5) break; const yb = x < -2.5 ? MH * (x + 2.5 + RL) / RL : MH; rails.push(tintc(U.place(new THREE.CylinderGeometry(0.024, 0.024, 0.92, 8), x, yb + 0.46, z), 0xaeb3b8)); }
    }
    rails.push(tintc(U.place(new THREE.CylinderGeometry(0.022, 0.022, D - 0.95, 8), 2.5, MH + 0.9, (0.95 + D) / 2, Math.PI / 2, 0, 0), 0xaeb3b8));
    B.galv.push(...toW(rails));
    // walkable record: block [sM-2.5, sM+2.5] at +MH, ramp on the local -X side rising toward the block
    const rampLow = sM - fr[6] * (2.5 + RL), rampHigh = sM - fr[6] * 2.5;
    (p.mh || (p.mh = [])).push({ b0: sM - 2.5, b1: sM + 2.5, rampLow, rampHigh, ed1: D, rampEd0: 0.95, which });
  }

  // ---------- fences: alpha-tested picket panels with posts and rails ----------
  function fenceRun(pts, h, B) {  // pts: [[x, yBase, z], ...] station-local, one post every ~2.5 m
    if (pts.length < 2) return;
    const pos = [], uv = [], idx = []; let u = 0;
    pts.forEach((p, i) => {
      if (i > 0) u += Math.hypot(p[0] - pts[i - 1][0], p[2] - pts[i - 1][2]) / 0.6;
      pos.push(p[0], p[1], p[2], p[0], p[1] + h, p[2]); uv.push(u, 0, u, 1);
      if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      B.steel.push(bx(0.06, h + 0.06, 0.06, p[0], p[1] + h / 2, p[2], 0x2c3035));
      if (i > 0) { const q = pts[i - 1]; const L = Math.hypot(p[0] - q[0], p[2] - q[2]); const yaw = Math.atan2(-(p[2] - q[2]), p[0] - q[0]);
        B.steel.push(bx(L, 0.05, 0.05, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2 + h, (p[2] + q[2]) / 2, 0x2c3035, yaw)); }
    });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    B.fence.push(g);
  }
  function outerFence(st, p, B, gaps) {
    if (p.side === 'I') return;
    let run = []; const flush = () => { fenceRun(run, 1.07, B); run = []; };
    for (let s = p.s0 + 1.5; s <= p.s1 - 1.5; s += 2.5) {
      if (gaps.some(([a, b]) => s > a && s < b)) { flush(); continue; }
      const f2 = atPlat(p, s, fr0w(p, s) - 0.07, 0); run.push([f2[0], f2[1], f2[2]]);
    }
    flush();
  }
  function midFence(st, B, xings) {
    const c = cfg(st); if (!c.midFence) return;
    const sides = new Set(st.plats.map(p => p.side)); if (sides.has('I') || !(sides.has('L') && sides.has('R'))) return;
    if (Math.abs(Track.lane(st.s, 1) - Track.lane(st.s, 0)) < 3.4) return;
    const blocked = (s) => xings.some(x => Math.abs(x - s) < 5) || Track.feat.crossings.some(c => Math.abs(c.s - s) < 9);
    let run = []; const flush = () => { fenceRun(run, 1.25, B); run = []; };
    for (let s = st.sMin - 22; s <= st.sMax + 22; s += 2.5) {
      if (blocked(s)) { flush(); continue; }
      Track.frame(s, F); const lat = (Track.lane(s, 0) + Track.lane(s, 1)) / 2;
      run.push([F.x + F.rx * lat - OX, F.y - 0.3, F.z + F.rz * lat - OZ]);
    }
    flush();
  }

  // ---------- shelters and canopies ----------
  function shelter(p, s, which, B, depthMax) {
    const fr0 = atPlat(p, s, 0, which); const w = fr0[4];
    const room = p.side === 'I' ? w / 2 - 0.15 : w - 0.3;
    const front = Math.max(TAC + 1.25, room - 2.75); const depth = room - front; if (depth < 1.5) return false;
    const sz = Math.min(1, depth / 2.75);
    const fr = atPlat(p, s, front, which);
    for (const k of ['steel', 'roof', 'glass', 'props', 'lamp']) B[k === 'steel' ? 'steelB' : k].push(U.place(PROTO.shelter[k], fr[0], fr[1], fr[2], 0, fr[3], 0, 1, 1, sz));
    // shelter name panel on the fascia
    B.signs.push([fr[0], fr[1] + 2.93, fr[2], fr[3], -0.3 * sz, 2.2, 0.26]);
    const pc = atPlat(p, s, front + 1.1 * sz, which); B.pools.push([pc[0], pc[1] + 0.02, pc[2], 3.6]);
    return true;
  }
  function longCanopy(st, p, B) {
    const L = p.s1 - p.s0; const Lc = Math.min(L * 0.72, 170); const mid = (p.s0 + p.s1) / 2; const a = mid - Lc / 2, b = mid + Lc / 2;
    const island = p.side === 'I'; const pos = [], idx = []; let n = 0;
    for (let s = a; s <= b + 0.01; s += 2.5) {
      Track.frame(s, F); const [li, lo] = platLat(p, s); const sg = Math.sign(lo - li) || 1; const w = Math.abs(lo - li); const y = F.y + PH;
      const Pp = (lat, yy) => pos.push(F.x + F.rx * lat - OX, yy, F.z + F.rz * lat - OZ);
      if (island) { const m = (li + lo) / 2; Pp(li + 0.5, y + 4.05); Pp(li + 0.5, y + 4.2); Pp(m, y + 3.75); Pp(lo - 0.5, y + 4.2); Pp(lo - 0.5, y + 4.05); Pp(m, y + 3.6); Pp(li + 0.5, y + 4.05); }
      else { const e0 = li + sg * 0.55, e1 = lo + sg * 0.35; Pp(e0, y + 3.95); Pp(e0, y + 4.12); Pp(e1, y + 3.78); Pp(e1, y + 3.62); Pp(e0, y + 3.95); }
      const K = island ? 7 : 5;
      if (n > 0) for (let k = 0; k < K - 1; k++) { const q0 = (n - 1) * K + k, q1 = q0 + 1, r0 = q0 + K, r1 = r0 + 1; idx.push(q0, q1, r0, q1, r1, r0); }
      n++;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    B.roofRaw.push(g);
    // columns, beams, light strips, pools every 8 m
    for (let s = a + 4; s < b; s += 8) {
      const fr = island ? atPlat(p, s, fr0w(p, s) / 2, 0) : atPlat(p, s, Math.max(TAC + 1.4, fr0w(p, s) * 0.62), 0);
      B.steelB.push(bx(0.24, 3.7, 0.24, fr[0], fr[1] + 1.85, fr[2], 0x33373c, fr[3]));
      const f2 = atPlat(p, s, island ? fr0w(p, s) / 2 : fr0w(p, s) * 0.5, 0);
      B.lamp.push(bx(0.2, 0.05, island ? fr0w(p, s) - 1.6 : fr0w(p, s) - 1.2, f2[0], f2[1] + (island ? 3.6 : 3.7), f2[2], 0xffffff, f2[3]));
      B.pools.push([f2[0], f2[1] + 0.02, f2[2], 4.6]);
    }
    return [a, b];
  }
  const fr0w = (p, s) => { const [li, lo] = platLat(p, s); return Math.abs(lo - li); };

  // ---------- OSM geometry (canopies mapped as building=roof / amenity=shelter, station buildings) ----------
  const toLocal = (ring) => ring.map(([la, lo]) => { const w = Geo.ll2w(la, lo); return [w.x - OX, w.z - OZ]; });
  function pca(pts) {
    let cx = 0, cz = 0; for (const [x, z] of pts) { cx += x; cz += z; } cx /= pts.length; cz /= pts.length;
    let sxx = 0, szz = 0, sxz = 0; for (const [x, z] of pts) { const dx = x - cx, dz = z - cz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz); const ux = Math.cos(ang), uz = Math.sin(ang);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const [x, z] of pts) { const u = (x - cx) * ux + (z - cz) * uz, v = -(x - cx) * uz + (z - cz) * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    return { cx, cz, ux, uz, u0, u1, v0, v1, len: u1 - u0, wid: v1 - v0 };
  }
  function area(pts) { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a / 2); }
  function platOf(st, x, z, margin = 0.6, sPad = 0) {
    const n = Track.nearest(x + OX, z + OZ, 60); if (!n) return null;
    for (const p of st.plats) { if (n.s < p.s0 - sPad || n.s > p.s1 + sPad) continue; const [li, lo] = platLat(p, n.s); if (n.lat > Math.min(li, lo) - margin && n.lat < Math.max(li, lo) + margin) return { p, s: n.s, lat: n.lat }; }
    return null;
  }
  function groundAt(st, x, z) { const y = platformY(x + OX, z + OZ, st); return y !== null ? y : Terrain.h(x + OX, z + OZ); }
  function osmRoof(st, r, B) {
    const pts = toLocal(r.ring); if (pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length < 3) return null; const A = area(pts); if (A < 4 || A > 6000) return null;
    const k = pca(pts); const gy = groundAt(st, k.cx, k.cz);
    const hTop = parseFloat(r.height) || (r.shelter ? 2.9 : 4.0); const hMin = parseFloat(r.min_height) || Math.max(2.4, hTop - 0.35);
    const shape = new THREE.Shape(); pts.forEach(([x, z], i) => i ? shape.lineTo(x, -z) : shape.moveTo(x, -z));
    const slab = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.12, Math.min(0.35, hTop - hMin)), bevelEnabled: false }); slab.rotateX(-Math.PI / 2); slab.translate(0, gy + hMin, 0);
    B.roofRaw.push(slab);
    // columns along the long axis (one row if narrow, two if wide), with light strips and pools
    const rowsV = k.wid > 6 ? [k.v0 + 0.8, k.v1 - 0.8] : [(k.v0 + k.v1) / 2];
    const nC = Math.max(2, Math.round(k.len / 7) + 1);
    for (let i = 0; i < nC; i++) {
      const u = k.u0 + 0.6 + (k.len - 1.2) * i / (nC - 1);
      for (const v of rowsV) { const x = k.cx + k.ux * u - k.uz * v, z = k.cz + k.uz * u + k.ux * v; const yb = groundAt(st, x, z);
        B.steelB.push(bx(0.18, gy + hMin - yb, 0.18, x, (yb + gy + hMin) / 2, z, 0x33373c)); }
      if (i < nC - 1) { const u2 = u + (k.len - 1.2) / (nC - 1) / 2; const x = k.cx + k.ux * u2, z = k.cz + k.uz * u2;
        B.lamp.push(bx(0.2, 0.05, Math.max(0.6, k.wid - 1.0), x, gy + hMin - 0.05, z, 0xffffff, Math.atan2(-k.uz, k.ux))); B.pools.push([x, groundAt(st, x, z) + 0.03, z, Math.min(5.5, 2 + k.wid * 0.6)]); }
    }
    return k;
  }
  function osmDepot(st, polys, B, root) {
    let best = null, ba = 0; for (const d of polys) { const pts = toLocal(d.ring); const A = area(pts); const c = pca(pts); if (Math.hypot(c.cx, c.cz) < 220 && A > ba && A < 9000) { ba = A; best = { d, pts, c }; } }
    if (!best) return null;
    return best;
  }

  // ---------- underpass stairwell: holes in the platform (see platformGeo), walls, treads, parapets, canopy ----------
  function planHoles(st, c) {
    const O = OSM && OSM[st.id]; const spots = [];
    if (O && O.tunnels) for (const t of O.tunnels) for (const e of [t.pts[0], t.pts[t.pts.length - 1]]) {
      const w = Geo.ll2w(e[0], e[1]); const n = Track.nearest(w.x, w.z, 60); if (!n) continue;
      for (const p of st.plats) { if (n.s < p.s0 + 5 || n.s > p.s1 - 5) continue; const [li, lo] = platLat(p, n.s); if (n.lat >= Math.min(li, lo) - 0.5 && n.lat <= Math.max(li, lo) + 0.5) spots.push([p, n.s]); }
    }
    if (!spots.length && c.under) for (const f of c.under) for (const p of st.plats) spots.push([p, p.s0 + (p.s1 - p.s0) * f]);
    for (const [p, s0] of spots) {
      if (p.hole) continue; const w = fr0w(p, s0);
      const zc = p.side === 'I' ? w / 2 : Math.max(TAC + 1.3, (TAC + w) / 2); if (zc + 1.2 > (p.side === 'I' ? w - TAC - 0.3 : w - 0.2)) continue;
      const s = U.clamp(s0, p.s0 + 6, p.s1 - 6); const mid = (p.s0 + p.s1) / 2;
      p.hole = { s0: s - 3, s1: s + 3, ed0: zc - 0.95, ed1: zc + 0.95, zc, open: s > mid ? -1 : 1 };   // open end faces the platform middle
    }
  }
  function underpassParts(st, p, B) {
    const H = p.hole; if (!H) return;
    const sC = (H.s0 + H.s1) / 2; const fr = atPlat(p, sC, H.zc, 0); const al = sC - p.s0;
    const openX = -H.open * fr[6];           // local x of the open end (+1 or -1)
    const DEP = 2.4;
    // below-surface walls and a dark floor
    for (const dz of [-0.95, 0.95]) B.plat.push(platBox(6.0, DEP, 0.12, 0, -DEP / 2, dz + Math.sign(dz) * 0.06, fr, al, 2));
    B.plat.push(platBox(0.12, DEP, 1.9, -openX * 3.06, -DEP / 2, 0, fr, al, 2));
    B.dark.push(U.place(new THREE.PlaneGeometry(6, 1.9).rotateX(-Math.PI / 2), fr[0], fr[1] - DEP + 0.02, fr[2], 0, fr[3], 0));
    // treads descending from the open end
    const tr = []; for (let i = 0; i < 14; i++) tr.push(bx(0.3, 0.17, 1.86, openX * (2.85 - i * 0.3), -0.085 - i * 0.17, 0, 0x8e8b84));
    B.props.push(...tr.map(g => U.place(g, fr[0], fr[1], fr[2], 0, fr[3], 0)));
    // parapets on the long sides and the closed end, stainless handrails on top
    for (const dz of [-1.04, 1.04]) B.plat.push(platBox(6.0, 0.95, 0.18, 0, 0.475, dz, fr, al, 2));
    B.plat.push(platBox(0.18, 0.95, 2.26, -openX * 3.09, 0.475, 0, fr, al, 2));
    for (const dz of [-1.04, 1.04]) B.galv.push(U.place(tintc(U.place(new THREE.CylinderGeometry(0.03, 0.03, 6.0, 8), 0, 1.02, dz, 0, 0, Math.PI / 2), 0xaeb3b8), fr[0], fr[1], fr[2], 0, fr[3], 0));
    // canopy over the stair on four posts, sign on its fascia
    for (const dx of [-2.9, 2.9]) for (const dz of [-1.2, 1.2]) B.steel.push(U.place(bx(0.1, 2.95, 0.1, dx, 1.47, dz, 0x2c3035), fr[0], fr[1], fr[2], 0, fr[3], 0));
    B.roofRaw.push(U.place(new THREE.BoxGeometry(6.8, 0.12, 2.9), fr[0], fr[1] + 3.0, fr[2], 0, fr[3], 0));
    B.under.push([fr[0], fr[1], fr[2], fr[3], openX]);
    B.pools.push([fr[0], fr[1] + 0.03, fr[2], 3.4]);
  }

  // ---------- at-grade pedestrian crossing: panel over the tracks, tactile bands, warning masts ----------
  function pedXing(st, sx, B) {
    if (sx < 5 || sx > Track.length - 5) return;
    Track.frame(sx, F); const l0 = Math.min(Track.lane(sx, 0), Track.lane(sx, 1)) - 2.4, l1 = Math.max(Track.lane(sx, 0), Track.lane(sx, 1)) + 2.4;
    const yaw = Math.atan2(-F.dz, F.dx), cL = (l0 + l1) / 2;
    B.props.push(bx(2.6, 0.2, l1 - l0, F.x + F.rx * cL - OX, F.y - 0.095, F.z + F.rz * cL - OZ, 0x3a3b3d, yaw));
    for (const [e, flip] of [[l0 - 0.7, 0], [l1 + 0.7, Math.PI]]) {
      const x = F.x + F.rx * e - OX, z = F.z + F.rz * e - OZ, y = Math.max(F.y, Terrain.h(x + OX, z + OZ));
      B.props.push(bx(2.6, 0.06, 1.0, x, y - 0.01, z, 0xc99a1a, yaw));
      const mx = F.x + F.rx * (e + (flip ? 0.9 : -0.9)) - OX, mz = F.z + F.rz * (e + (flip ? 0.9 : -0.9)) - OZ;
      const my = Math.max(F.y - 0.2, Terrain.h(mx + OX, mz + OZ));
      put(B.steel, PROTO.xingMast, mx + F.dx * 1.6, my, mz + F.dz * 1.6, yaw + flip);
      put(B.xlamp, PROTO.xingLamp, mx + F.dx * 1.6, my, mz + F.dz * 1.6, yaw + flip);
    }
  }

  // ---------- furniture: real OSM positions where mapped, a considered procedural layout elsewhere ----------
  function facingTrackYaw(x, z) { const n = Track.nearest(x + OX, z + OZ, 80); if (!n) return 0; Track.frame(n.s, F); return Math.atan2(-F.dz, F.dx) + (n.lat >= 0 ? 0 : Math.PI); }
  function furnish(st, c, B, occupied) {
    const O = (OSM && OSM[st.id]) || null; const osmPts = (O && O.points) || {};
    const used = new Set();
    const OSMMAP = { bench: [PROTO.bench, 'props'], bin: [PROTO.bins, 'props'], tvm: [PROTO.tvm, 'props'], validator: [PROTO.validator, 'props'],
      help: [PROTO.help, 'props'], info: [PROTO.mapcase, 'props'], cctv: [PROTO.cctv, 'steel'], bikepark: [PROTO.rack, 'galv'] };
    for (const kind in OSMMAP) {
      const L0 = osmPts[kind]; if (!L0 || !L0.length) continue;
      const L = L0.filter(rec => { const w = Geo.ll2w(rec[0], rec[1]); return !!platOf(st, w.x - OX, w.z - OZ, 0.8, 2); }); if (!L.length) continue; used.add(kind);
      for (const rec of L) {
        const w = Geo.ll2w(rec[0], rec[1]); const x = w.x - OX, z = w.z - OZ; if (!platOf(st, x, z, 0.8, 2)) continue;   // station furniture only
        const y = groundAt(st, x, z); const [proto, bucket] = OSMMAP[kind];
        put(B[bucket], proto, x, y, z, facingTrackYaw(x, z));
        if (kind === 'help') put(B.blue, PROTO.helpBeacon, x, y, z, 0);
      }
    }
    const free = (p, s, ed0, ed1, pad = 0.4) => !occupied.some(o => o.p === p && s > o.s0 - pad && s < o.s1 + pad && ed1 > o.ed0 - pad && ed0 < o.ed1 + pad);
    const take = (p, s0, s1, ed0, ed1) => occupied.push({ p, s0, s1, ed0, ed1 });
    let clockDone = false, lockersDone = false;
    for (const p of st.plats) {
      const L = p.s1 - p.s0, mid = (p.s0 + p.s1) / 2, isl = p.side === 'I';
      const edBack = (s) => isl ? fr0w(p, s) / 2 : fr0w(p, s) - 0.55;       // furniture line (back of the platform / centre of islands)
      // light poles every 20 m (long canopies bring their own lights)
      for (let s = p.s0 + 9; s < p.s1 - 4; s += 20) {
        if (p.canopy && s > p.canopy[0] - 2 && s < p.canopy[1] + 2) continue;
        const ed = isl ? fr0w(p, s) / 2 : fr0w(p, s) - 0.45; if (!free(p, s, ed - 0.2, ed + 0.2, 0.3)) continue;
        const fr = atPlat(p, s, ed, 0); put(B.steel, PROTO.pole, fr[0], fr[1], fr[2], fr[3]); put(B.lamp, PROTO.poleHead, fr[0], fr[1], fr[2], fr[3]);
        if (isl) { put(B.lamp, PROTO.poleHead, fr[0], fr[1], fr[2], fr[3] + Math.PI); }
        const pp = atPlat(p, s, isl ? ed : ed - 0.78, 0); B.pools.push([pp[0], pp[1] + 0.025, pp[2], 6.2]);
        take(p, s - 0.4, s + 0.4, ed - 0.3, ed + 0.3);
      }
      // name signs every ~45 m (double sided)
      for (let s = p.s0 + 24; s < p.s1 - 10; s += 45) {
        const ed = isl ? fr0w(p, s) / 2 : fr0w(p, s) - 1.25; if (!free(p, s, ed - 0.2, ed + 0.2)) continue;
        const fr = atPlat(p, s, ed, 0); put(B.steel, PROTO.signPosts, fr[0], fr[1], fr[2], fr[3]); B.signs.push([fr[0], fr[1] + 2.52, fr[2], fr[3], -0.04, 2.4, 0.44]);
        take(p, s - 1.3, s + 1.3, ed - 0.2, ed + 0.2);
      }
      // open-air benches with bins, facing the track
      if (!used.has('bench')) for (let s = p.s0 + 16; s < p.s1 - 12; s += 31) {
        const ed = isl ? fr0w(p, s) / 2 - 0.1 : edBack(s) - 0.25; if (ed < TAC + 1.0 || !free(p, s, ed - 0.45, ed + 0.5)) continue;
        const fr = atPlat(p, s, ed, 0); put(B.props, PROTO.bench, fr[0], fr[1], fr[2], fr[3]);
        if (isl) { const f2 = atPlat(p, s, fr0w(p, s) / 2 + 0.1, 0); put(B.props, PROTO.bench, f2[0], f2[1], f2[2], f2[3] + Math.PI); }
        if (!used.has('bin')) { const fb = atPlat(p, s + 2.3, ed + 0.05, 0); put(B.props, PROTO.bins, fb[0], fb[1], fb[2], fb[3]); }
        take(p, s - 1.2, s + 3.0, ed - 0.5, ed + 0.6);
      }
      // card validators at the ends and the middle entrance
      if (!used.has('validator')) for (const s of [p.s0 + 5, mid + 6, p.s1 - 5]) {
        const ed = isl ? fr0w(p, s) / 2 + 0.7 : edBack(s) - 0.1; if (!free(p, s, ed - 0.3, ed + 0.3)) continue;
        const fr = atPlat(p, s, ed, 0); put(B.props, PROTO.validator, fr[0], fr[1], fr[2], fr[3]); take(p, s - 0.4, s + 0.4, ed - 0.3, ed + 0.3);
      }
      // ticket machines near the middle (two at the big stations)
      if (!used.has('tvm')) for (let k = 0; k < (c.big ? 2 : 1); k++) {
        const s = mid - 5 - k * 1.1; const ed = isl ? fr0w(p, s) / 2 + 0.5 : edBack(s) + 0.05; if (!free(p, s, ed - 0.35, ed + 0.35)) continue;
        const fr = atPlat(p, s, ed, 0); put(B.props, PROTO.tvm, fr[0], fr[1], fr[2], fr[3]); take(p, s - 0.55, s + 0.55, ed - 0.35, ed + 0.35);
      }
      // help point, map case, leaning rails, CCTV
      const one = (kind, proto, bucket, s, dEd, beacon) => { if (used.has(kind)) return; const ed = (isl ? fr0w(p, s) / 2 : edBack(s)) + dEd; if (!free(p, s, ed - 0.3, ed + 0.3)) return;
        const fr = atPlat(p, s, ed, 0); put(B[bucket], proto, fr[0], fr[1], fr[2], fr[3]); if (beacon) put(B.blue, PROTO.helpBeacon, fr[0], fr[1], fr[2], fr[3]); take(p, s - 0.7, s + 0.7, ed - 0.3, ed + 0.3); };
      one('help', PROTO.help, 'props', mid + 13, 0.1, true);
      one('info', PROTO.mapcase, 'props', mid - 12, 0.1);
      if (L > 120) { one('lean', PROTO.lean, 'galv', mid + 34, -0.35); one('lean2', PROTO.lean, 'galv', mid - 38, -0.35); }
      if (!used.has('cctv')) for (const s of [p.s0 + 28, p.s1 - 28]) { const ed = isl ? fr0w(p, s) / 2 : fr0w(p, s) - 0.3; if (!free(p, s, ed - 0.2, ed + 0.2)) continue; const fr = atPlat(p, s, ed, 0); put(B.steel, PROTO.cctv, fr[0], fr[1], fr[2], fr[3]); }
      // one platform clock per station
      if (!clockDone) { const s = mid + 20; const ed = isl ? fr0w(p, s) / 2 : fr0w(p, s) - 0.9; if (free(p, s, ed - 0.4, ed + 0.4)) { const fr = atPlat(p, s, ed, 0); put(B.steel, PROTO.clockPost, fr[0], fr[1], fr[2], fr[3]); B.clocks.push(fr); clockDone = true; take(p, s - 0.5, s + 0.5, ed - 0.4, ed + 0.4); } }
      // bike lockers and racks on the ground just outside a side platform
      if (!lockersDone && !isl && !used.has('bikepark')) {
        const s = mid - 30; Track.frame(s, F); const [li, lo] = platLat(p, s); const sg = Math.sign(lo - li) || 1;
        const lat = lo + sg * 2.4; const x = F.x + F.rx * lat - OX, z = F.z + F.rz * lat - OZ, y = Terrain.h(x + OX, z + OZ);
        if (y > F.y - 2.5) { const yaw = Math.atan2(-F.dz, F.dx) + (sg > 0 ? 0 : Math.PI); put(B.props, PROTO.lockers, x, y, z, yaw);
          const x2 = F.x + F.rx * lat - OX + F.dx * 7, z2 = F.z + F.rz * lat - OZ + F.dz * 7; put(B.galv, PROTO.rack, x2, Terrain.h(x2 + OX, z2 + OZ), z2, yaw); lockersDone = true; }
      }
    }
  }

  // ---------- signs, departure boards, stop marks, clock faces ----------
  const signTex = new Map();
  function nameSignTex(name) {
    if (signTex.has(name)) return signTex.get(name);
    const t = U.canvasTexture(1024, 192, (c, w, h) => {
      c.fillStyle = '#20242a'; c.fillRect(0, 0, w, h); c.fillStyle = '#d7263d'; c.fillRect(0, 0, 26, h); c.fillStyle = '#2c3138'; c.fillRect(26, h - 10, w - 26, 10);
      let size = 118; c.font = `600 ${size}px "Barlow Condensed", "Arial Narrow", sans-serif`; while (c.measureText(name).width > w - 110 && size > 60) { size -= 4; c.font = `600 ${size}px "Barlow Condensed", "Arial Narrow", sans-serif`; }
      c.fillStyle = '#f4f2ec'; c.textBaseline = 'middle'; c.fillText(name, 62, h / 2 + 4);
    }, { aniso: 8 });
    signTex.set(name, t); return t;
  }
  function signMesh(st, list) {
    if (!list.length) return null;
    const g = [];
    for (const [x, y, z, yaw, dz, w, h] of list) {
      const a = new THREE.PlaneGeometry(w, h); a.rotateY(Math.PI); a.translate(0, 0, dz - 0.004); g.push(U.place(a, x, y, z, 0, yaw, 0));
      const b2 = new THREE.PlaneGeometry(w, h); b2.translate(0, 0, dz + 0.074); g.push(U.place(b2, x, y, z, 0, yaw, 0));
    }
    const m = new THREE.MeshStandardMaterial({ map: nameSignTex(st.name), roughness: 0.45, metalness: 0.1, emissive: 0xffffff, emissiveMap: nameSignTex(st.name), emissiveIntensity: 0 });
    st.signMat = m; return new THREE.Mesh(merge(g), m);
  }
  // dot-matrix LED board: text rasterised at LED resolution, then drawn as round amber pixels
  const LED = { W: 128, H: 32, c: null };
  function ledCanvas() { if (!LED.c) { LED.c = document.createElement('canvas'); LED.c.width = LED.W; LED.c.height = LED.H; LED.x = LED.c.getContext('2d', { willReadFrequently: true }); } return LED.x; }
  function drawBoard(b, st, now) {
    const deps = Sim.nextDepartures(st.idx, b.dirs, now, 3);
    const key = deps.map(d => d.trip.id + ':' + Math.max(0, Math.round((d.t - now) / 60))).join('|') + ':' + Math.floor(now / 60);
    if (key === b.last) return; b.last = key;
    const x = ledCanvas(); const W = LED.W, H = LED.H;
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.fillStyle = '#fff'; x.textBaseline = 'top'; x.font = '8px monospace';
    const t = Env.clockText(now).replace(' ', '').toLowerCase();
    x.fillText(st.name.toUpperCase().slice(0, 18), 1, 0); x.textAlign = 'right'; x.fillText(t, W - 1, 0); x.textAlign = 'left';
    if (!deps.length) x.fillText('NO MORE TRAINS TODAY', 1, 12);
    deps.slice(0, 3).forEach((d, i) => {
      const y = 8 + i * 8; const mins = Math.max(0, Math.round((d.t - now) / 60));
      const dest = ((Track.stations[d.trip.stops[d.trip.stops.length - 1][0]] || {}).name || d.trip.head).replace(' Diridon', '').replace('San Francisco', 'SF').toUpperCase().slice(0, 11);
      x.fillText(Sim.routeShort(d.trip).slice(0, 3) + ' ' + d.trip.id, 1, y); x.fillText(dest, 36, y); x.textAlign = 'right'; x.fillText(mins <= 0 ? 'NOW' : mins + 'm', W - 1, y); x.textAlign = 'left';
    });
    const px = x.getImageData(0, 0, W, H).data;
    const c = b.tex.userData.ctx, cw = b.tex.image.width, chh = b.tex.image.height, sx = cw / W, sy = chh / H, r = Math.min(sx, sy) * 0.36;
    c.fillStyle = '#050505'; c.fillRect(0, 0, cw, chh);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const on = px[(j * W + i) * 4] > 90; const red = j >= 8 && i < 14 && deps[Math.floor((j - 8) / 8)] && Sim.routeShort(deps[Math.floor((j - 8) / 8)].trip).startsWith('EXP');
      c.fillStyle = on ? (red ? '#ff5a2a' : '#ffb21e') : '#241505';
      c.beginPath(); c.arc((i + 0.5) * sx, (j + 0.5) * sy, on ? r : r * 0.8, 0, 6.2832); c.fill();
    }
    b.tex.needsUpdate = true;
  }
  function boardsFor(st, p, B) {
    const L = p.s1 - p.s0; const at = L > 170 ? [p.s0 + L * 0.34, p.s0 + L * 0.68] : [(p.s0 + p.s1) / 2 + 9];
    const single = Math.abs(Track.lane(st.s, 1) - Track.lane(st.s, 0)) < 1;
    for (const s of at) {
      const isl = p.side === 'I'; const ed = isl ? fr0w(p, s) / 2 : Math.min(fr0w(p, s) - 1.4, Math.max(TAC + 1.2, fr0w(p, s) * 0.55));
      const fr = atPlat(p, s, ed, 0); put(B.steel, PROTO.vmsPost, fr[0], fr[1], fr[2], fr[3]);
      const tex = U.canvasTexture(512, 128, (c) => { c.fillStyle = '#050505'; c.fillRect(0, 0, 512, 128); }); tex.anisotropy = 8;
      const mat = new THREE.MeshBasicMaterial({ map: tex }); mat.color.setRGB(1.7, 1.7, 1.7);
      const g1 = new THREE.PlaneGeometry(2.06, 0.52); g1.rotateY(Math.PI); g1.translate(0, 2.78, -0.072);
      const g2 = new THREE.PlaneGeometry(2.06, 0.52); g2.translate(0, 2.78, 0.072);
      const mesh = new THREE.Mesh(merge([g1, g2]), mat); mesh.position.set(fr[0], fr[1], fr[2]); mesh.rotation.y = fr[3];
      B.vms.push(mesh);
      st.boards.push({ tex, dirs: isl || single ? [0, 1] : p.side === 'R' ? [1] : [0], last: '' });
    }
  }
  function stopMarks(st, B) {
    for (const dir of [0, 1]) {
      const p = st.platFor[dir]; if (!p) continue; const sS = st.stop[dir]; Track.frame(sS, F);
      const lat = Track.lane(sS, dir) + st.door[dir] * (EDGE + 0.45);
      const x = F.x + F.rx * lat - OX, z = F.z + F.rz * lat - OZ, y = F.y + PH, yaw = Math.atan2(-F.dz, F.dx) + (dir ? Math.PI / 2 : -Math.PI / 2);
      put(B.steel, PROTO.stopPost, x, y, z, yaw);
      const a = new THREE.PlaneGeometry(0.46, 0.58); a.rotateY(Math.PI); a.translate(0, 1.75, 0.012); B.stops.push(U.place(a, x, y, z, 0, yaw, 0));
    }
  }

  // ---------- depot: on its real OSM footprint when mapped, else beside the outer platform ----------
  function depot(st, c, root) {
    if (typeof Depots === 'undefined') return;
    const polys = (OSM && OSM[st.id] && OSM[st.id].depot) || [];
    let best = null, ba = 0;
    for (const d of polys) { const pts = toLocal(d.ring); const A = area(pts); const k = pca(pts); if (A > 60 && A < 12000 && A > ba && platOf(st, k.cx, k.cz, 70, 60)) { ba = A; best = { pts, k }; } }
    const style = c.depot || (best ? 'small' : null); if (!style) return;
    let d; try { d = Depots.build(style, { name: st.name, seed: U.hashStr(st.id) }); } catch (e) { if (style !== 'small') try { d = Depots.build('small', { name: st.name, seed: U.hashStr(st.id) }); } catch (e2) {} }
    if (!d) return;
    d.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    if (best) {
      const k = best.k; let yaw = Math.atan2(-k.uz, k.ux);
      const n = Track.nearest(k.cx + OX, k.cz + OZ, 400);
      if (n) { Track.frame(n.s, F); const tx = F.x + F.rx * n.lat - (k.cx + OX), tz = F.z + F.rz * n.lat - (k.cz + OZ);   // toward the track
        const mzx = -Math.sin(yaw), mzz = -Math.cos(yaw); if (mzx * (F.x - (k.cx + OX)) + mzz * (F.z - (k.cz + OZ)) < 0) yaw += Math.PI; void tx; void tz; }
      let gy = 1e9; for (const [x, z] of best.pts) gy = Math.min(gy, Terrain.h(x + OX, z + OZ));
      d.position.set(k.cx, gy, k.cz); d.rotation.y = yaw;
    } else {
      const side = st.plats.some(p => p.side === 'L') ? 'L' : st.plats.some(p => p.side === 'R') ? 'R' : 'L';
      const p = st.plats.find(q => q.side === side) || st.plats[0];
      const s = U.clamp(st.s, p.s0 + 25, p.s1 - 25); Track.frame(s, F); const [li, lo] = platLat(p, s); const sg = Math.sign(lo - li) || (side === 'L' ? -1 : 1);
      const box = new THREE.Box3().setFromObject(d); const depth = box.max.z - box.min.z;
      const lat = lo + sg * (depth / 2 + 3.5); const gx = F.x + F.rx * lat, gz = F.z + F.rz * lat;
      d.position.set(gx - OX, Math.max(F.y + PH - 0.1, Terrain.h(gx, gz)), gz - OZ);
      d.rotation.y = Math.atan2(-F.dz, F.dx) + (sg > 0 ? 0 : Math.PI);
    }
    root.add(d); st.depot = d;
  }

  // ---------- assembly ----------
  function buildStation(st) {
    const c = cfg(st); Track.frame(st.s, F); OX = F.x; OZ = F.z;
    const root = new THREE.Group(); root.position.set(OX, 0, OZ); root.name = st.id;
    const base = new THREE.Group(), detail = new THREE.Group(), glow = new THREE.Group(); root.add(base, detail, glow);
    const B = { plat: [], steel: [], steelB: [], galv: [], roofRaw: [], roof: [], glass: [], props: [], lamp: [], blue: [], fence: [], dark: [], signs: [], vms: [], stops: [], clocks: [], under: [], pools: [], xlamp: [] };
    const occupied = []; st.boards = [];
    for (const p of st.plats) { p.mh = []; p.hole = null; p.canopy = null; }
    const O = (OSM && OSM[st.id]) || null;
    planHoles(st, c);
    for (const p of st.plats) B.plat.push(platformGeo(st, p));
    for (const p of st.plats) { if (p.hole) { underpassParts(st, p, B); occupied.push({ p, s0: p.hole.s0 - 1, s1: p.hole.s1 + 1, ed0: p.hole.ed0 - 0.4, ed1: p.hole.ed1 + 0.4 }); } }
    // mini-high blocks for the direction(s) each platform serves
    for (const dir of [0, 1]) { const p = st.platFor[dir]; if (!p || (p.side !== 'I' && st.platFor[1 - dir] === p && dir === 0)) continue; miniHigh(st, p, dir, B); }
    for (const p of st.plats) for (const m of p.mh || []) occupied.push({ p, s0: Math.min(m.b0, m.rampLow) - 0.5, s1: Math.max(m.b1, m.rampLow) + 0.5, ed0: m.which ? fr0w(p, m.b0) - m.ed1 - 0.3 : 0, ed1: m.which ? fr0w(p, m.b0) : m.ed1 + 0.4 });
    // canopies: mapped OSM roofs first; platforms they don't cover get the station's style
    const covered = new Set();
    if (O && O.roof) for (const r of O.roof) {
      const pts = toLocal(r.ring); const k0 = pca(pts); if (area(pts) > 3500 || !platOf(st, k0.cx, k0.cz, 7, 12)) continue;
      const k = osmRoof(st, r, B); if (!k) continue;
      const n = Track.nearest(k.cx + OX, k.cz + OZ, 40); if (!n) continue;
      for (const p of st.plats) { if (n.s < p.s0 - 5 || n.s > p.s1 + 5) continue; const [li, lo] = platLat(p, n.s); if (n.lat > Math.min(li, lo) - 3 && n.lat < Math.max(li, lo) + 3) { covered.add(p); occupied.push({ p, s0: n.s - k.len / 2, s1: n.s + k.len / 2, ed0: 0, ed1: 0.01 }); } }
    }
    for (const p of st.plats) {
      if (covered.has(p)) continue;
      if (c.canopy === 'long') { p.canopy = longCanopy(st, p, B); continue; }
      const L = p.s1 - p.s0; const n = Math.max(1, Math.min(c.n, Math.floor(L / 55)));
      let at = (n === 1 ? [0.5] : n === 2 ? [0.38, 0.62] : [0.27, 0.5, 0.73]).map(f => p.s0 + L * f);
      const mapped = ((O && O.points && O.points.shelter) || []).map(rec => { const w = Geo.ll2w(rec[0], rec[1]); return platOf(st, w.x - OX, w.z - OZ, 1.5, 0); }).filter(q => q && q.p === p).map(q => q.s);
      if (mapped.length) at = mapped;
      for (const s of at) {
        if (p.hole && s > p.hole.s0 - 5 && s < p.hole.s1 + 5) continue;
        const sides = p.side === 'I' ? [0, 1] : [0];
        for (const wh of sides) if (shelter(p, s, wh, B)) occupied.push({ p, s0: s - 3.4, s1: s + 3.4, ed0: TAC + 1.0, ed1: 99 });
      }
    }
    // fences with gaps where people come and go (the middle entrance, under/overpasses)
    const xings = [];
    if (O && O.points && O.points.pedxing) for (const rec of O.points.pedxing) {
      const w = Geo.ll2w(rec[0], rec[1]); const n = Track.nearest(w.x, w.z, 12); if (!n) continue;
      const l0 = Math.min(Track.lane(n.s, 0), Track.lane(n.s, 1)) - 2.5, l1 = Math.max(Track.lane(n.s, 0), Track.lane(n.s, 1)) + 2.5;
      if (n.lat < l0 || n.lat > l1 || n.s < st.sMin - 70 || n.s > st.sMax + 70) continue;
      if (Track.feat.crossings.some(c2 => Math.abs(c2.s - n.s) < 15)) continue;     // a road crossing (TrackGeo draws those)
      if (!xings.some(q => Math.abs(q - n.s) < 12)) xings.push(n.s);
    }
    if (!xings.length && c.xing) { if (c.xing !== 'end') xings.push(st.sMin - RAMP - 2.5); if (c.xing !== 'start') xings.push(st.sMax + RAMP + 2.5); }
    for (const p of st.plats) { const mid = (p.s0 + p.s1) / 2; outerFence(st, p, B, [[mid - 4, mid + 4], ...(p.hole ? [[p.hole.s0 - 2, p.hole.s1 + 2]] : [])]); }
    midFence(st, B, xings);
    for (const sx of xings) if (sx < st.sMin - 2 || sx > st.sMax + 2) pedXing(st, sx, B);
    furnish(st, c, B, occupied);
    for (const p of st.plats) boardsFor(st, p, B);
    stopMarks(st, B);
    depot(st, c, root);
    // ---- merge buckets into a handful of meshes ----
    const mk = (arr, mat, grp, cast = true, recv = true) => { if (!arr.length) return null; const m = new THREE.Mesh(merge(arr), mat); m.castShadow = cast; m.receiveShadow = recv; grp.add(m); return m; };
    mk(B.plat, M.plat, base, false, true);
    mk(B.roofRaw.map(g => { for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); if (!g.attributes.normal) g.computeVertexNormals(); return g; })
      .concat(B.roof.map(g => { for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); return g; })), M.roof, base, true, true);
    mk(B.steelB, M.steel, base);
    mk(B.fence, M.fence, base, false, true);
    mk(B.dark, M.dark, base, false, false);
    const gl = mk(B.glass, M.glass, base, false, false); if (gl) gl.renderOrder = 3;
    mk(B.steel, M.steel, detail); mk(B.galv, M.galv, detail); mk(B.props, M.props, detail);
    mk(B.lamp, M.lamp, detail, false, false); mk(B.blue, M.blue, detail, false, false);
    if (B.xlamp.length) { const m = new THREE.Mesh(merge(B.xlamp), new THREE.MeshStandardMaterial({ color: 0x3a0503, emissive: 0xff2a1a, emissiveIntensity: 0 })); detail.add(m); st.xlampMat = m.material; }
    if (B.stops.length) detail.add(new THREE.Mesh(merge(B.stops), M.stop));
    for (const m of B.vms) detail.add(m);
    const sm = signMesh(st, B.signs); if (sm) detail.add(sm);
    if (B.under.length) { const g = []; for (const [x, y, z, yaw, ox] of B.under) { const a = new THREE.PlaneGeometry(2.4, 0.42); a.rotateY(ox > 0 ? Math.PI / 2 : -Math.PI / 2); a.translate(ox * 3.42, 2.98, 0); g.push(U.place(a, x, y, z, 0, yaw, 0)); } detail.add(new THREE.Mesh(merge(g), M.under)); }
    if (B.clocks.length) { const g = []; for (const fr of B.clocks) { const a = new THREE.CircleGeometry(0.3, 28); a.translate(0, 3.25, 0.07); const b2 = new THREE.CircleGeometry(0.3, 28); b2.rotateY(Math.PI); b2.translate(0, 3.25, -0.07); g.push(U.place(a, fr[0], fr[1], fr[2], 0, fr[3], 0), U.place(b2, fr[0], fr[1], fr[2], 0, fr[3], 0)); } detail.add(new THREE.Mesh(merge(g), M.clock)); }
    if (B.pools.length) { const pg = []; for (const [x, y, z, r] of B.pools) { const g = new THREE.PlaneGeometry(r * 2, r * 2); g.rotateX(-Math.PI / 2); g.translate(x, y, z); pg.push(g); } const pm = new THREE.Mesh(merge(pg), M.pool); pm.renderOrder = 2; glow.add(pm); }
    st.obj = root; st.base = base; st.detail = detail; st.glow = glow; root.visible = false;
    group.add(root);
  }

  // ---------- crowds on platforms near the camera (gameplay; unchanged apart from avoiding blocks/holes) ----------
  let people = null; const crowd = []; let crowdStation = null;
  const RIDERS = { san_francisco: 1, '22nd_street': 0.13, bayshore: 0.03, south_sf: 0.04, san_bruno: 0.06, place_MLBR: 0.38, broadway: 0.01, burlingame: 0.11,
    san_mateo: 0.27, hayward_park: 0.04, hillsdale: 0.22, belmont: 0.08, san_carlos: 0.13, redwood_city: 0.31, menlo_park: 0.13, palo_alto: 0.6, stanford: 0.01,
    california_ave: 0.1, san_antonio: 0.085, mountain_view: 0.38, sunnyvale: 0.29, lawrence: 0.08, santa_clara: 0.13, college_park: 0.01, sj_diridon: 0.34,
    tamien: 0.05, capitol: 0.01, blossom_hill: 0.012, morgan_hill: 0.015, san_martin: 0.004, gilroy: 0.015 };
  function setupCrowd() { if (typeof Life === 'undefined' || !Life.createPeople) return; try { people = Life.createPeople(220); Env.scene.add(people.mesh); people.count = 0; } catch (e) { console.warn('people', e); people = null; } }
  function blocked(p, s, lat) {
    const [li, lo] = platLat(p, s); const sg = Math.sign(lo - li) || 1; const ed = (lat - li) * sg;
    if (p.hole && s > p.hole.s0 - 0.8 && s < p.hole.s1 + 0.8 && ed > p.hole.ed0 - 0.6 && ed < p.hole.ed1 + 0.6) return true;
    for (const m of p.mh || []) { const a = Math.min(m.b0, m.rampLow), b = Math.max(m.b1, m.rampLow); const w = Math.abs(lo - li); const e = m.which ? w - ed : ed; if (s > a - 0.5 && s < b + 0.5 && e < m.ed1 + 0.5) return true; }
    return false;
  }
  function spawnCrowd(st) {
    crowd.length = 0; crowdStation = st; if (!people) return; people.mesh.position.set(st.x, 0, st.z); people.mesh.updateMatrixWorld();
    const r = U.rng(U.hashStr(st.id) + Math.floor(Env.time.sec / 900));
    const hour = Env.time.sec / 3600; const busy = (hour > 6.5 && hour < 9.5) || (hour > 16 && hour < 19.5) ? 1 : hour > 5 && hour < 23 ? 0.55 : 0.15;
    // typical weekday boardings relative to 4th & King: the terminal and Palo Alto fill up at the peaks, halts stay quiet
    const rider = RIDERS[st.id] !== undefined ? RIDERS[st.id] : 0.05;
    const n = Math.min(200, Math.round((8 + r() * 10) * busy * (1 + 14 * rider)));
    for (let i = 0, tries = 0; i < n && tries < n * 4; tries++) {
      // people bunch toward the middle of a platform (entrances, shelters, where the train's doors will be)
      const p = st.plats[Math.floor(r() * st.plats.length)]; const s = U.lerp(p.s0 + 12, p.s1 - 12, U.clamp(0.5 + (r() - 0.5) * (0.35 + r() * 0.75), 0, 1));
      const [li, lo] = platLat(p, s); const w = Math.abs(lo - li); const sg = Math.sign(lo - li) || 1;
      const lat = p.side === 'I' ? U.lerp(li + 1.2, lo - 1.2, r()) : li + sg * U.lerp(1.1, Math.max(1.3, w - 0.5), r());
      if (blocked(p, s, lat)) continue; i++;
      Track.frame(s, F); const x = F.x + F.rx * lat, z = F.z + F.rz * lat;
      const face = Math.atan2(F.dx, F.dz) + (lat > (Track.lane(s, 0) + Track.lane(s, 1)) / 2 ? Math.PI / 2 : -Math.PI / 2) + (r() - 0.5) * 1.6;
      crowd.push({ x, y: F.y + PH, z, yaw: face, mode: r() < 0.12 ? 1 : 0, phase: r() * 10, ph: r() * 6.283, p, s, lat, tx: x, tz: z, v: 0, state: 'wait', dir: p.side === 'I' ? (lat > (Track.lane(s, 0) + Track.lane(s, 1)) / 2 ? 1 : 0) : p.side === 'R' ? 1 : 0, wander: r() < 0.12 });
    }
  }
  // trains: [{ s (head), dir, len, stopped, doorsOpen, stationIdx, doorWorld: [{x,z}] }]
  function updateCrowd(dt, camPos, trains) {
    if (!people) return;
    const st = nearest(camPos, 700);
    if (st !== crowdStation) { if (st) spawnCrowd(st); else { crowd.length = 0; crowdStation = null; } }
    if (!st) { people.count = 0; return; }
    let k = 0;
    for (const c of crowd) {
      if (c.state === 'gone') continue;
      if (c.state === 'wait') {
        for (const tr of trains) { if (tr.doorsOpen && tr.stationIdx === st.idx && (tr.dir === c.dir || st.plats.length === 1) && tr.doorWorld && tr.doorWorld.length) {
          let best = null, bd = 1e9; for (const d of tr.doorWorld) { const dd = (d.x - c.x) ** 2 + (d.z - c.z) ** 2; if (dd < bd) { bd = dd; best = d; } }
          if (best && bd < 60 * 60) { c.state = 'board'; c.tx = best.x; c.tz = best.z; c.mode = 1; break; } } }
        if (c.wander && c.state === 'wait') { c.phase += dt; if (Math.hypot(c.tx - c.x, c.tz - c.z) < 0.3) { const s2 = U.clamp(c.s + (Math.random() - 0.5) * 30, c.p.s0 + 8, c.p.s1 - 8); if (!blocked(c.p, s2, c.lat)) { Track.frame(s2, F); c.s = s2; c.tx = F.x + F.rx * c.lat; c.tz = F.z + F.rz * c.lat; } } }
      }
      if (c.state === 'board' || c.wander) {
        const dx = c.tx - c.x, dz = c.tz - c.z, d = Math.hypot(dx, dz);
        if (d > 0.25) { const sp = Math.min(d, 1.35 * dt); c.x += dx / d * sp; c.z += dz / d * sp; c.yaw = Math.atan2(dx, dz); c.mode = 1; }
        else if (c.state === 'board') { c.state = 'gone'; continue; }
        else c.mode = 0;
      }
      people.set(k++, c.x - st.x, c.y, c.z - st.z, Math.atan2(-Math.cos(c.yaw), Math.sin(c.yaw)), c.mode, c.ph, c.mode === 1 ? 1.35 : undefined);
    }
    people.count = k; people.update && people.update(dt);
  }

  function nearest(pos, maxD) { let best = null, bd = maxD; for (const st of list) { const d = Math.hypot(st.x - pos.x, st.z - pos.z); if (d < bd) { bd = d; best = st; } } return best; }

  // ---------- lazy build: nearest unbuilt station first, after its fine terrain has loaded ----------
  const buildQueue = [];
  function init() {
    mats(); protos(); Env.scene.add(group);
    for (const st of Track.stations) {
      const o = st; layout(o); Track.frame(o.s, F); o.x = F.x; o.z = F.z; o.y = F.y; o.boards = o.boards || []; list.push(o);
    }
    osmReady = (typeof Stream !== 'undefined' ? Stream.json('stations/osm.json', 3) : Promise.reject(new Error('no stream')))
      .then(j => { OSM = j.stations || null; }, () => { OSM = null; });
    setupCrowd();
  }
  let boardT = 0, clockT = 0;
  function drawClock() {
    const c = M.clockTex.userData.ctx; const t = Env.time.sec; const hr = (t / 3600) % 12, mi = (t / 60) % 60;
    c.clearRect(0, 0, 128, 128); c.fillStyle = '#f4f3ef'; c.beginPath(); c.arc(64, 64, 62, 0, 7); c.fill(); c.strokeStyle = '#111'; c.lineWidth = 6; c.stroke();
    c.fillStyle = '#111'; for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; c.save(); c.translate(64, 64); c.rotate(a); c.fillRect(-2, -55, 4, 11); c.restore(); }
    c.lineCap = 'round'; c.strokeStyle = '#111';
    const ha = hr / 12 * Math.PI * 2, ma = mi / 60 * Math.PI * 2;
    c.lineWidth = 7; c.beginPath(); c.moveTo(64, 64); c.lineTo(64 + Math.sin(ha) * 30, 64 - Math.cos(ha) * 30); c.stroke();
    c.lineWidth = 4; c.beginPath(); c.moveTo(64, 64); c.lineTo(64 + Math.sin(ma) * 46, 64 - Math.cos(ma) * 46); c.stroke();
    c.fillStyle = '#c4312a'; c.beginPath(); c.arc(64, 64, 4, 0, 7); c.fill();
    M.clockTex.needsUpdate = true;
  }
  function update(dt, camPos, trains) {
    const night = U.uNight.value;
    const alt = Math.max(0, camPos.y - Terrain.h(camPos.x, camPos.z));
    // schedule builds
    const R = alt > 800 ? 14000 : 6500;
    if (!update.pending) {
      let best = null, bd = R;
      for (const st of list) { if (st.obj || st._pending) continue; const d = Math.hypot(st.x - camPos.x, st.z - camPos.z); if (d < bd) { bd = d; best = st; } }
      if (best) {
        best._pending = true; update.pending = true;
        const r = Math.max(260, (best.sMax - best.sMin) / 2 + 140);
        Promise.all([osmReady, Terrain.ensure(best.x - r, best.z - r, best.x + r, best.z + r, 1)]).then(() => buildQueue.push(best), () => buildQueue.push(best)).finally(() => { update.pending = false; });
      }
    }
    if (buildQueue.length) { const st = buildQueue.shift(); try { buildStation(st); } catch (e) { console.error('station', st.id, e); st.obj = new THREE.Group(); } }
    for (const st of list) {
      if (!st.obj || !st.detail) continue;
      const d = Math.hypot(st.x - camPos.x, st.z - camPos.z);
      const eff = d - Math.max(0, camPos.y - st.y) * 0.3;
      st.obj.visible = eff < 5500 || (alt > 1500 && d < 14000);
      if (!st.obj.visible) continue;
      st.detail.visible = Math.hypot(d, alt) < 950;
      st.glow.visible = night > 0.05 && d < 3500;
      if (st.signMat) st.signMat.emissiveIntensity = 0.55 * night;
      if (st.xlampMat) { const on = trains.some(tr => Math.abs(tr.s - st.s) < 520 && tr.v > 1) && (Math.floor(U.uTime.value * 1.8) % 2 === 0); st.xlampMat.emissiveIntensity = on ? 2.2 : 0; }
    }
    M.lamp.emissiveIntensity = 0.15 + 2.6 * night; M.pool.opacity = 0.34 * night; M.blue.emissiveIntensity = 0.5 + 2.0 * night;
    M.stop.emissiveIntensity = 0.05 + 0.3 * night; M.under.emissiveIntensity = 0.45 * night; M.clock.emissiveIntensity = 0.35 * night;
    clockT -= dt; if (clockT <= 0) { clockT = 5; drawClock(); }
    boardT -= dt;
    if (boardT <= 0) { boardT = 2; const now = Env.time.sec; for (const st of list) { if (!st.obj || !st.detail || !st.detail.visible) continue; if (Math.hypot(st.x - camPos.x, st.z - camPos.z) > 900) continue; for (const b of st.boards) drawBoard(b, st, now); } }
    updateCrowd(dt, camPos, trains);
  }
  // world position on a platform for spawning the player: station st, direction dir
  function spawnPoint(st, dir, out = {}) {
    const p = st.platFor[dir]; let s = U.clamp(st.s, p.s0 + 20, p.s1 - 20);
    Track.frame(s, F); const [li, lo] = platLat(p, s);
    const lat = p.side === 'I' ? (li + lo) / 2 + (dir ? -1 : 1) * Math.max(0, Math.abs(lo - li) / 2 - 1.6) : li + Math.sign(lo - li) * 1.6;
    if (blocked(p, s, lat)) { s = U.clamp(s + 12, p.s0 + 10, p.s1 - 10); Track.frame(s, F); }
    out.x = F.x + F.rx * lat; out.z = F.z + F.rz * lat; out.y = F.y + PH; out.yaw = Math.atan2(F.dx, F.dz) + (lat > (Track.lane(s, 0) + Track.lane(s, 1)) / 2 ? Math.PI / 2 : -Math.PI / 2); out.s = s; return out;
  }
  // walkable height at world (x,z): platform tops, end ramps, mini-high blocks and their ramps, stairwells; else null
  function platformY(x, z, near) {
    const st = near || nearest({ x, z }, 700); if (!st) return null;
    const r = Track.nearest(x, z, 60); if (!r) return null;
    for (const p of st.plats) {
      if (r.s < p.s0 - RAMP - 0.5 || r.s > p.s1 + RAMP + 0.5) continue;
      const [li, lo] = platLat(p, r.s); const a = Math.min(li, lo), b = Math.max(li, lo);
      if (r.lat < a - 0.05 || r.lat > b + 0.05) continue;
      const ry = Track.yAt(r.s);
      if (r.s < p.s0 || r.s > p.s1) { const t = r.s < p.s0 ? 1 - (p.s0 - r.s) / RAMP : 1 - (r.s - p.s1) / RAMP; if (t < 0) continue; return ry + U.lerp(0.03, PH, t); }
      const sg = Math.sign(lo - li) || 1; const ed = (r.lat - li) * sg; const w = Math.abs(lo - li);
      const H = p.hole;
      if (H && r.s > H.s0 && r.s < H.s1 && ed > H.ed0 && ed < H.ed1) { const u = H.open > 0 ? (r.s - H.s0) / 6 : (H.s1 - r.s) / 6; return ry + PH - U.clamp(u * 1.35, 0, 1) * 2.38; }
      for (const m of p.mh || []) {
        const e = m.which ? w - ed : ed; if (e > m.ed1) continue;
        if (r.s >= m.b0 && r.s <= m.b1) return ry + PH + MH;
        const lo2 = Math.min(m.rampLow, m.rampHigh), hi2 = Math.max(m.rampLow, m.rampHigh);
        if (r.s >= lo2 && r.s <= hi2 && e >= m.rampEd0) return ry + PH + MH * (1 - Math.abs(r.s - m.rampHigh) / Math.abs(m.rampHigh - m.rampLow));
      }
      return ry + PH;
    }
    return null;
  }
  return { init, update, list, nearest, spawnPoint, platformY, platLat, PH, group, get people() { return people; } };
})();
