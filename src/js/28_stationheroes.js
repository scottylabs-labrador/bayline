// StationHeroes: per-station character for all 50 Bayline Metro stations, from the research in
// notes/bart/stations-research.md. The generator (27_stationtypes.js) reads:
//   type      corrected station archetype (subway | aerial | surface | median | trench), where the data has not yet
//   access    'above' (concourse over the platforms) | 'below' (lobby under the tracks) | 'bridge' (footbridge/mezzanine
//             over the tracks) | 'ends'
//   canopy    { style, len (m, centred unless off), off (m along u), h (clear height), col / fascia / under colours,
//             louvre, posts: { shape, col, size, spacing, where: 'centre'|'back'|'both' } }
//   ends      what the open platform ends carry: 'beam' | 'T' | 'L' | 'poles' | 'pergola' | 'wall'
//   floor / tactile / wall / ceil / cWall / cFloor / cCeil  palette entries [colour, kind, parameter]
//   cols      platform-level columns in subway stations: { rows, across, along, shape, size, col, kind }
//   light     [r, g, b] lamp colour; lightI
//   feature   named hero features built by StationHeroes.build(name, T)
// Everything else falls back to the era defaults.
const StationHeroes = (() => {
  const K = StationKit.K;
  // palette shorthands
  const QUARRY = (c = 0x8c4a33) => [c, K.TILE, -0.2];                  // quarry tile 8 x 4 in, running bond
  const TERR = (c = 0x9b958b, s = 3.0) => [c, K.TERRAZZO, s];
  const CONC = (c = 0xa9a397, s = 3.0) => [c, K.CONCRETE, s];
  const BRICK = (c = 0x8a3b2a, g = 1) => [c, K.BRICK, g];
  const GRAN = (c = 0x8f8c87, s = 0.6) => [c, K.GRANITE, s];
  const TILE = (c, s = 0.108) => [c, K.TILE, s];
  const PAINT = (c) => [c, K.PAINT, 0];
  const PANEL = (c, s = 1.2) => [c, K.PANEL, s];
  const BOARD = (c = 0xa29d93, s = 0.14) => [c, K.BOARDFORM, s];
  const FLUTE = (c = 0xb9b3a7, s = 0.12) => [c, K.FLUTED, s];
  const HERR = (c = 0x7d3a2b) => [c, K.HERRING, 0.1];
  const MARB = (c = 0xd9d6cf) => [c, K.MARBLE, 0.9];

  const CFG = {
    // ---------------------------------------------------------------- San Francisco (Market St: Muni over BART)
    EMBR: { canopyEnt: true, layout: 'island', type: 'subway', access: 'above', muni: true, floor: TERR(0xb9b4aa, 3.0), wall: [0xe4e1da, K.CIRCLES, 3.2], wallUp: [0xd8d4cc, K.CIRCLES, 3.2], ceil: [0x4a4845, K.COFFER, 2.4],
      cFloor: TERR(0xa8a296), cWall: BOARD(0x9d968a, 0.2), cCeil: [0x5a5854, K.GRATING, 0], light: [1.0, 0.93, 0.82], feature: ['circles'], canyon: true, hero: 1 },
    MONT: { canopyEnt: true, layout: 'island', type: 'subway', access: 'above', muni: true, floor: HERR(0x7a3527), wall: [0xe8e6e0, K.PANEL, 1.6], wallUp: PAINT(0x3a3a3c), ceil: [0x8c8880, K.COFFER, 1.5], tread: 0xb0aba2,
      cols: { rows: 2, across: 5.7, along: 10.4, shape: 'round', size: 0.62, col: 0xd4d8db, kind: K.STEEL }, pendants: 'dome', benches: 'bullseye',
      cFloor: [0xd6ceb9, K.TERRAZZO, 4.0], cWall: [0xf1efe9, K.BUBBLE, 0.15], cCeil: [0xe8e4dc, K.COFFER, 1.2], hero: 1 },
    POWL: { canopyEnt: true, layout: 'island', type: 'subway', access: 'above', muni: true, floor: HERR(0x7d3a2b), wall: [0xe9dfc8, K.PANEL, 1.6], wallUp: PAINT(0xc2462f), ceil: [0x8c8880, K.COFFER, 1.5], tread: 0xb0aba2,
      cols: { rows: 2, across: 5.7, along: 10.4, shape: 'round', size: 0.62, col: 0xd4d8db, kind: K.STEEL }, pendants: 'dome', benches: 'bullseye',
      cFloor: [0xcfc8b8, K.TERRAZZO, 4.0], cWall: [0xf1efe9, K.BUBBLE, 0.15], cCeil: [0x2a2a2c, K.GRATING, 0], muniCol: 0xb3362a, hero: 1 },
    CIVC: { canopyEnt: true, layout: 'island', type: 'subway', access: 'above', muni: true, floor: MARB(0xdcdad4), wall: [0xe6e3dc, K.PANEL, 1.5], wallUp: PAINT(0x1c2c4a), ceil: [0xe9e7e2, K.PANEL, 0.15],
      cols: { rows: 1, across: 0, along: 12, shape: 'rect', size: 0.9, depth: 0.5, col: 0x1a1a1b, kind: K.GRANITE }, cFloor: MARB(0xd6d3cc), cWall: BRICK(0x6e6358, 1), cCeil: [0xe2e0dc, K.PANEL, 0.15], hero: 1 },
    '16TH': { layout: 'island', type: 'subway', access: 'above', floor: QUARRY(0x8e3e2c), wall: TILE(0xeceae4, 0.152), wallUp: CONC(0x9b958a, 0), ceil: [0x8a857c, K.CONCRETE, 2.0],
      cFloor: QUARRY(0x8e3e2c), cWall: [0xd9cfb8, K.CONCRETE, 0], cCeil: [0xb07a45, K.WOOD, 0.09], vault: 'ribs', mural: [0x2f5d8c, 0x7c8a3a, 0xa9b83e, 0x8a8d88], wellWall: [0xa39c8f, K.CIRCLES, 2.6], hero: 1 },
    '24TH': { layout: 'island', type: 'subway', access: 'above', floor: QUARRY(0x8e3e2c), wall: TILE(0xeceae4, 0.152), wallUp: CONC(0x9b958a, 0), ceil: [0x8a857c, K.CONCRETE, 2.0],
      cFloor: QUARRY(0x8e3e2c), cWall: [0xd9cfb8, K.CONCRETE, 0], cCeil: [0xb07a45, K.WOOD, 0.09], vault: 'ribs', mural: [0xd8b23a, 0x7a4a26, 0x5e3a22, 0x9a6b3c], wellWall: [0xa39c8f, K.CIRCLES, 2.6], hero: 1 },
    GLEN: { layout: 'island', type: 'subway', access: 'above', floor: [0x9a4a36, K.BRICK, 0], wall: BOARD(0x6d6760, 0.2), wallUp: BOARD(0x6d6760, 0.2), ceil: BOARD(0x5d5852, 0.2),
      cFloor: [0x9a4a36, K.BRICK, 0], cWall: BOARD(0x7a746c), daylight: true, arch: true, hero: 1 },
    BALB: { layout: 'island', type: 'trench', access: 'above', floor: [0x8e4636, K.BRICK, 0], wall: FLUTE(0xa8a298, 0.35), canopy: { style: 'flat', len: 90, fascia: 0x9d978d, under: 0x8a857c, posts: { shape: 'rect', col: 0x9d978d, size: 0.45, spacing: 12, where: 'centre' } }, conduit: true, hero: 1 },
    DALY: { layout: 'island', type: 'aerial', access: 'below', floor: CONC(0xa39d91), bands: 0x8c4a33, canopy: { style: 'flat', len: 110, fascia: 0x2b2b2d, under: 0x3a3a3c, beams: true, posts: { shape: 'rect', col: 0x2b2b2d, size: 0.35, spacing: 9, where: 'centre' } }, ends: 'poles', hero: 1 },
    COLM: { layout: 'island', type: 'trench', access: 'bridge', floor: GRAN(0x9d958c, 0.6), bands: 0xc98f86, canopy: { style: 'gull', len: 120, top: 0xf3f3f1, under: 0xeeeeea, fascia: 0xf3f3f1, posts: { shape: 'round', col: 0xd99a8e, size: 0.6, spacing: 12, where: 'centre', capital: 0xf0efea } } },
    // ---------------------------------------------------------------- Peninsula and SFO
    SSAN: { layout: 'island', type: 'subway', access: 'above', floor: CONC(0x9c9a95, 2.0), wall: [0xc9ccd0, K.FLUTED, 0.1], wallUp: [0xc9ccd0, K.FLUTED, 0.1], band: 0x6e2432, ceil: [0xdadcdf, K.PANEL, 0.6],
      cFloor: [0xe6e6e2, K.PANEL, 1.0], cWall: PANEL(0xf1f1ee, 1.2), cCeil: [0xa9895f, K.WOOD, 0.08], daylight: true, arches: 0x151515 },
    SBRN: { layout: 'island', type: 'trench', access: 'bridge', floor: CONC(0x8f8c87, 0.6), wall: BOARD(0x9a958c, 0.15), canopy: { style: 'barrel', len: 107, top: 0xe9ebec, under: 0xf2f2f0, fascia: 0xb3342b, posts: { shape: 'rect', col: 0xb3342b, size: 0.35, spacing: 9, where: 'back' } } },
    SFIA: { type: 'aerial', access: 'below', floor: TERR(0xb3b0aa, 4.0), ceil: PANEL(0x9a9d9f, 0.6), enclosed: true, canopy: { style: 'shed', len: 216, top: 0xa9adb0, under: 0x8e9194, fascia: 0x6f7377,
      posts: { shape: 'round', col: 0xaaa59c, size: 1.2, spacing: 18, where: 'centre', kind: K.BOARDFORM } }, feature: ['windPortal'], hero: 1 },
    MLBR: { type: 'surface', access: 'bridge', floor: GRAN(0xa3a098, 0.6), canopy: { style: 'flat', len: 150, top: 0xefe8d6, under: 0xf2ecdd, fascia: 0xe4dcc8, posts: { shape: 'round', col: 0xf2f0ea, size: 0.3, spacing: 10, where: 'centre' } },
      bridgeStyle: 'wings', hero: 1,
      // the shared intermodal hall over the Caltrain island and BART platform 3 (replaces the Caltrain-era depot hall with
      // the metro on): the Peninsula station it spans, and fallbacks in station v if that is not there
      sharedHall: { peninsula: 'place_MLBR', vWest: -20.5, vNB: -16.0, len: 84, rise: 5.2 } },
    // ---------------------------------------------------------------- Oakland core
    WOAK: { layout: 'side', type: 'aerial', access: 'below', floor: CONC(0x9a958c), deck: FLUTE(0xb9b3a7, 0.1), canopy: { style: 'hipped', len: 100, top: 0x55807e, under: 0x6d8f8b, fascia: 0x3f6f6d, posts: { shape: 'rect', col: 0x3f6f6d, size: 0.3, spacing: 9, where: 'back' } },
      windscreen: 0x35598c, ends: 'poles', poleCol: 0x3f6f6d, hero: 1 },
    '12TH': { type: 'subway', access: 'above', stacked: true, floor: [0xc8bca6, K.GRANITE, 0.4], wall: TILE(0xeae6dc, 0.2), band: 0xd0512b, wallUp: [0x6b2a22, K.BRICK, 1], ceil: [0xecebe7, K.COFFER, 2.4],
      cols: { rows: 1, across: 0, along: 12, shape: 'rect', size: 1.2, depth: 1.2, col: 0x6b2a22, kind: K.BRICK }, cFloor: [0xc8bca6, K.GRANITE, 0.4], cWall: [0x6b2a22, K.BRICK, 1], cCeil: [0xecebe7, K.COFFER, 2.4], hero: 1 },
    '19TH': { type: 'subway', access: 'above', stacked: true, floor: [0xc8bca6, K.GRANITE, 0.4], wall: TILE(0xeae6dc, 0.2), band: 0x2a4fa0, wallUp: [0x1f3570, K.BRICK, 1], ceil: [0xecebe7, K.COFFER, 2.4],
      cols: { rows: 1, across: 0, along: 12, shape: 'rect', size: 1.2, depth: 1.2, col: 0x1f3570, kind: K.BRICK }, cFloor: [0xc8bca6, K.GRANITE, 0.4], cWall: [0x1f3570, K.BRICK, 1], cCeil: [0xecebe7, K.COFFER, 2.4], hero: 1 },
    MCAR: { layout: 'island', type: 'median', access: 'below', floor: CONC(0xa8a296), grid: 0x8c3f2e, canopy: { style: 'box', len: 95, off: 40, top: 0x3a2a22, under: 0x3a2a22, fascia: 0x3a2a22, span: 'all', posts: { shape: 'rect', col: 0x3a2a22, size: 0.4, spacing: 12, where: 'both' } }, hero: 1 },
    LAKE: { layout: 'island', type: 'subway', access: 'above', floor: TERR(0x9d8a82, 3.0), wall: [0xe8e2d6, K.CONCRETE, 0], band: 0xb3342b, wallUp: [0x3a3634, K.CONCRETE, 0], ceil: [0x4a4744, K.COFFER, 2.0],
      cFloor: TERR(0x9d8a82), cWall: [0xb54a2a, K.MOSAIC, 0.03], skylights: true, bigCircles: true, hero: 1 },
    FTVL: { layout: 'side', type: 'aerial', access: 'below', floor: QUARRY(0x86412f), canopy: { style: 'shed', len: 100, top: 0x7a3f22, under: 0x5a3a2a, fascia: 0x3d2a20, tilt: true, posts: { shape: 'rect', col: 0x3d2a20, size: 0.3, spacing: 8, where: 'back' } },
      windscreen: 0x6b7a80, ends: 'wall', cCeil: [0xd96a1e, K.PANEL, 1.2], hero: 1 },
    COLS: { layout: 'island', type: 'aerial', access: 'below', floor: QUARRY(0x8a3a2a), canopy: { style: 'butterfly', len: 120, off: -25, top: 0x8f9396, under: 0xa2342a, fascia: 0x6f7377, posts: { shape: 'portal', col: 0xb5afa3, size: 0.6, spacing: 12, where: 'centre' } }, feature: ['oac'], hero: 1 },
    SANL: { layout: 'side', type: 'aerial', access: 'below', floor: CONC(0x9f9a90), canopy: { style: 'flat', len: 90, top: 0x7c8084, under: 0x8a8e92, fascia: 0xe4b21c, louvre: 0xe4b21c, posts: { shape: 'round', col: 0xc4302a, size: 0.35, spacing: 9, where: 'back' } }, windscreen: 0x2a5ab8, ends: 'beam' },
    BAYF: { layout: 'island', type: 'aerial', access: 'below', floor: CONC(0xa5a095), canopy: { style: 'flat', len: 105, top: 0xd9dad6, under: 0xc9cbc7, fascia: 0x9dc22e, louvre: 0x9dc22e, posts: { shape: 'round', col: 0xdadcd8, size: 0.4, spacing: 10, where: 'centre' } }, ends: 'T', endCol: 0x8fa38a, benches: 'drum' },
    HAYW: { layout: 'side', type: 'aerial', access: 'below', floor: QUARRY(0x5a3a2a), deck: FLUTE(0xb3ada1, 0.25), canopy: { style: 'flat', len: 88, top: 0xb7a98c, under: 0xc2b594, fascia: 0xa89a7c, clerestory: true, posts: { shape: 'rect', col: 0x3a3634, size: 0.3, spacing: 9, where: 'back' } }, windscreen: 0x1c1c1e, ends: 'L' },
    SHAY: { layout: 'side', type: 'aerial', access: 'below', floor: QUARRY(0x6a3a2a), deck: FLUTE(0xada79b, 0.2), canopy: { style: 'flat', len: 86, off: 22, top: 0x5a4a38, under: 0xc9a14a, underKind: K.WOOD, fascia: 0x5a4a38, posts: { shape: 'rect', col: 0x4a3c2e, size: 0.3, spacing: 7.5, where: 'back' } }, ends: 'L' },
    UCTY: { layout: 'side', type: 'aerial', access: 'below', floor: CONC(0xa09b91), canopy: { style: 'flat', len: 108, top: 0xf1f1ef, under: 0xf4f4f2, fascia: 0xf1f1ef, posts: { shape: 'rect', col: 0xe8c21a, size: 0.3, spacing: 9, where: 'back' } }, ends: 'beam' },
    FRMT: { layout: 'island', type: 'aerial', access: 'below', floor: CONC(0x9d988e), bands: 0x8c4a33, canopy: { style: 'shed', len: 91, off: 15, top: 0xb4502e, under: 0x5a3a2a, fascia: 0xc0552e, posts: { shape: 'rect', col: 0x6f7377, size: 0.35, spacing: 9, where: 'centre' } }, ends: 'pergola' },
    WARM: { layout: 'island', type: 'surface', access: 'bridge', floor: GRAN(0x9e9c97, 0.9), canopy: { style: 'flat', len: 132, top: 0x2d3a4c, under: 0xc79a58, underKind: K.WOOD, fascia: 0xf2f2f0, posts: { shape: 'round', col: 0x9c9a95, size: 0.9, spacing: 16, where: 'centre', kind: K.CONCRETE } }, bridgeCover: true, solar: true },
    MLPT: { layout: 'side', type: 'trench', access: 'bridge', floor: [0xdcd8d0, K.GRANITE, 0.9], wall: BOARD(0xb1aca2, 0.15), canopy: { style: 'shed', len: 131, top: 0x8ea58c, under: 0xe8e6e0, fascia: 0xb9bcbe, posts: { shape: 'round', col: 0xc9a14a, size: 0.8, spacing: 10, where: 'back', kind: K.MOSAIC } }, hero: 1 },
    BERY: { layout: 'island', type: 'aerial', access: 'below', floor: CONC(0xb1ada5, 1.5), canopy: { style: 'humps', len: 150, top: 0xa9c9a4, under: 0xf0f0ee, fascia: 0x8fb58a, posts: { shape: 'round', col: 0x8fb58a, size: 0.45, spacing: 12, where: 'centre' } }, hero: 1 },
    CAST: { layout: 'island', type: 'median', access: 'below', floor: CONC(0xa39e94), canopy: { style: 'gable', len: 110, top: 0x3e3a40, under: 0xb9a9b8, fascia: 0x8a6f8e, posts: { shape: 'round', col: 0xc8b89a, size: 0.55, spacing: 11, where: 'centre', rings: true } } },
    WDUB: { layout: 'island', type: 'median', access: 'bridge', floor: GRAN(0xa3a19c, 0.9), canopy: { style: 'flat', len: 98, top: 0xe8e9ea, under: 0xe0e1e2, fascia: 0xdfe1e3, posts: { shape: 'round', col: 0x5a5e62, size: 0.35, spacing: 12, where: 'centre' } }, ends: 'poles', bridgeStyle: 'box' },
    DUBL: { layout: 'island', type: 'median', access: 'below', floor: [0x9a4a36, K.GRANITE, 1.2], canopy: { style: 'wave', len: 112, top: 0xc9ced3, under: 0xd9dde1, fascia: 0xb9bec3, posts: { shape: 'round', col: 0xc9ced3, size: 0.3, spacing: 12, where: 'centre' } }, hero: 1 },
    OAKL: { type: 'aerial', access: 'below', floor: CONC(0xb1ada5), canopy: { style: 'pill', len: 58, top: 0xe4e6e8, under: 0xf2f3f4, fascia: 0xc9ced3, posts: { shape: 'round', col: 0xf2f3f4, size: 0.4, spacing: 12, where: 'back' } }, screenDoors: true },
    // ---------------------------------------------------------------- Contra Costa
    ROCK: { layout: 'island', type: 'median', access: 'below', floor: CONC(0x9e9a92), canopy: { style: 'frames', len: 55, off: -30, top: 0x6b3f25, under: 0x6b3f25, fascia: 0x6b3f25, frame: 0x7a4527, posts: { shape: 'rect', col: 0x7a4527, size: 0.35, spacing: 10, where: 'both' } }, hero: 1 },
    ORIN: { layout: 'island', type: 'median', access: 'below', floor: CONC(0xb7ad98), bands: 0x8c4a33, canopy: { style: 'shed', len: 70, top: 0x2a2826, under: 0x3a3632, fascia: 0x222020, posts: { shape: 'rect', col: 0x2a2826, size: 0.3, spacing: 10, where: 'centre' } }, ends: 'poles', hero: 1 },
    LAFY: { layout: 'island', type: 'median', access: 'below', floor: CONC(0xa7a197), canopy: { style: 'flat', len: 80, top: 0x4a3a2c, under: 0xb4824a, underKind: K.WOOD, fascia: 0x3e3226, posts: { shape: 'rect', col: 0x4a3a2c, size: 0.3, spacing: 9, where: 'centre' } }, ends: 'poles' },
    WCRK: { layout: 'side', type: 'aerial', access: 'below', floor: CONC(0x6f6c68), canopy: { style: 'flat', len: 85, top: 0x8a3a26, under: 0xd4d2cb, fascia: 0x4a3226, louvre: 0x4a3226, clerestory: true, posts: { shape: 'rect', col: 0x8a3a26, size: 0.3, spacing: 9, where: 'back' } }, ends: 'beam', hero: 1 },
    PHIL: { layout: 'side', type: 'aerial', access: 'below', floor: CONC(0x9f9a90), canopy: { style: 'flat', len: 88, top: 0x4a3a2c, under: 0x5a4636, fascia: 0xd06a28, louvre: 0x4a3226, posts: { shape: 'rect', col: 0xc0602a, size: 0.3, spacing: 9, where: 'back' } }, ends: 'poles', poleCol: 0xb0562a },
    CONC: { layout: 'island', type: 'aerial', access: 'below', floor: CONC(0xaaa498), canopy: { style: 'flat', len: 72, top: 0x6a4a36, under: 0xa4382a, underKind: K.CORRUG, fascia: 0x5a3e2a, louvre: 0x5a3e2a, posts: { shape: 'rect', col: 0xa9a397, size: 0.5, spacing: 12, where: 'centre', kind: K.BOARDFORM } }, ends: 'beam' },
    NCON: { layout: 'island', type: 'trench', access: 'bridge', floor: CONC(0xa39e94), bands: 0x9a4a36, canopy: { style: 'gable', len: 100, top: 0x3d6a4a, under: 0xf2f0ea, fascia: 0x3d6a4a, posts: { shape: 'round', col: 0x7a2a26, size: 0.4, spacing: 10, where: 'centre' } }, ends: 'T', endCol: 0x7a2a26 },
    PITT: { layout: 'island', type: 'median', access: 'bridge', floor: CONC(0xa39e94), canopy: { style: 'flat', len: 100, off: -55, top: 0xb9bdc0, under: 0xc9ccce, fascia: 0x6e2432, posts: { shape: 'round', col: 0x6e2432, size: 0.35, spacing: 10, where: 'centre' } }, ends: 'poles', bridgeStyle: 'box' },
    PCTR: { layout: 'island', type: 'median', access: 'bridge', floor: CONC(0xa8a398), canopy: { style: 'flat', len: 40, off: 30, top: 0x1f8a8a, under: 0xf2f2f0, fascia: 0x1f8a8a, posts: { shape: 'round', col: 0xf2f2f0, size: 0.25, spacing: 8, where: 'centre' } }, ends: 'T', endCol: 0xf2f2f0, hero: 0 },
    ANTC: { layout: 'island', type: 'median', access: 'bridge', floor: CONC(0xaaa59a), canopy: { style: 'flat', len: 55, top: 0xf2f2f0, under: 0xf5f5f3, fascia: 0x1f5fb8, posts: { shape: 'round', col: 0xf2f2f0, size: 0.22, spacing: 8, where: 'centre' } }, ends: 'poles', bridgeStyle: 'truss', bridgeCol: 0x1f5fb8, hero: 1 },
    // ---------------------------------------------------------------- Berkeley / Richmond
    ASHB: { layout: 'island', type: 'subway', access: 'above', floor: QUARRY(0x9a4a36), wall: [0xe2e2de, K.PANEL, 1.2], wallUp: [0xe2e2de, K.PANEL, 1.2], ceil: [0xd6d3cc, K.CONCRETE, 0], ribs: true, daylight: true },
    DBRK: { layout: 'island', type: 'subway', access: 'above', floor: TERR(0xd3ccbb, 3.0), wall: [0x7a3526, K.BRICK, 0], wallUp: [0xe6e2d9, K.CONCRETE, 0], ceil: [0xcac6be, K.COFFER, 1.4], cFloor: TERR(0xd6cfbe), cWall: [0x7a3526, K.BRICK, 0], cCeil: [0xece9e2, K.PANEL, 0.12], arches: 0xe9e6de, hero: 1 },
    NBRK: { layout: 'island', type: 'subway', access: 'above', floor: [0x8e3e2c, K.BRICK, 0], wall: FLUTE(0xc9ccc9, 0.2), band: 0xd0512b, wallUp: PAINT(0x151515), ceil: [0xf0efeb, K.COFFER, 2.0], cWall: [0x1f8a8a, K.MOSAIC, 0.03] },
    PLZA: { layout: 'side', type: 'aerial', access: 'below', floor: QUARRY(0x8a3a2a), deck: FLUTE(0xd2cdc2, 0.3), canopy: { style: 'flat', len: 110, top: 0xd2cdc2, under: 0x3a3836, underKind: K.CORRUG, fascia: 0xd2cdc2, slot: true, posts: { shape: 'rect', col: 0xd2cdc2, size: 0.4, spacing: 13, where: 'back' } }, ends: 'wall' },
    DELN: { layout: 'side', type: 'aerial', access: 'below', floor: [0xa4583c, K.TILE, 0.3], deck: FLUTE(0xd2cdc2, 0.3), canopy: { style: 'flat', len: 60, top: 0xd2cdc2, under: 0x3a3836, fascia: 0xd2cdc2, posts: { shape: 'rect', col: 0xd2cdc2, size: 0.4, spacing: 13, where: 'back' } }, ends: 'beam', towers: 0x46b6d6 },
    RICH: { layout: 'island', type: 'surface', access: 'below', floor: CONC(0xa39e94), canopy: { style: 'flat', len: 92, top: 0x3a3a3c, under: 0xc0552e, underKind: K.PAINT, fascia: 0x2e2e30, posts: { shape: 'rect', col: 0x8f8b84, size: 0.5, spacing: 10, where: 'centre' } }, ends: 'poles' },
  };
  // the airport connector's own station at Coliseum (a separate build beside the BART station, +13 m, a white capsule
  // roof over one track with platform screen doors): Oakland Airport's design
  CFG['COLS~OAC'] = Object.assign({}, CFG.OAKL, { canopy: Object.assign({}, CFG.OAKL.canopy, { len: 56 }) });
  function config(id) { return CFG[id] || {}; }
  // style palette override: the era default with this station's entries on top
  function style(id, base) {
    const c = CFG[id]; if (!c) return null;
    const S = Object.assign({}, base);
    for (const k of ['floor', 'wall', 'wallUp', 'wallLow', 'ceil', 'cFloor', 'cWall', 'cCeil', 'deck', 'light', 'tread']) if (c[k] !== undefined) S[k] = c[k];
    if (c.lightI) S.lightI = c.lightI;
    return S;
  }
  return { CFG, config, style };
})();
