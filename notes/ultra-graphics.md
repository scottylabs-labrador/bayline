# Ultra graphics: how it works (branch feat/ultra-graphics)

What this branch adds, where it lives, and the switches for QA. Plan and design review: `ultra-graphics-plan.md`.

## Data layers (all additive: new directories with their own index; old clients never ask for them)

| layer | what | tools | size | client |
|---|---|---|---|---|
| `tiles/h9/{8,9}` + `index.json` | USGS 3DEP 1 m lidar relief on the base terrain: L8 3.1 m, L9 1.56 m | `tools/bake_lidar.py` (`tiles/lidar.py`) | 181 MB, 3955 + 13722 tiles | `12_terrain.js` (`#h9=0` off) |
| `tiles/mat/7` + `index.json` | ground material class per 1.56 m (lawn, dry grass, shrub, leaf litter, soil, gravel, asphalt, concrete, roof, sand, rock, water, marsh, salt pond, farmland) | `tools/bake_materials.py` (`tiles/materials.py`) | see report | `12_terrain.js`, `63_ground.js` (`#mat=0` off) |
| `tiles/t2/7` + `index.json` | the photo-detected trees with canopy-height-model heights + the crowns the photo misses | `tools/bake_trees2.py` (`tiles/trees2.py`, `tiles/chm.py`) | see report | `61_flora.js` (`#t2=0` off) |

Raw inputs (not published): `data/raw/lidar3dep/` (3DEP fetches as npz, 812 MB; `det/` pass-1 detail grids 510 MB,
`meta/` per-tile offsets), `data/raw/chm_meta/` (Meta/WRI canopy height, 9 z9 COGs, 2.7 GB).

Publish order (the client uses a layer only once its index exists):
`tiles/h9/8`, `tiles/h9/9`, `tiles/h9` · `tiles/mat/7`, `tiles/mat` · `tiles/t2/7`, `tiles/t2`
(`sh tools/publish_data.sh <subpath>` each; the last one of each group re-syncs the directory and adds `index.json`).

### Lidar (h9)
`h = L7 + w · (lidar − lidar seen through the L7 grid)`: the existing surface (track carve, station flats, bathymetry)
stays exact at large scales; only relief below ~12 m wavelength is added. `w` is 0 on the track bed (±12 m → 30 m),
platforms/stations, tunnels, water, lidar no-data, Towns road ribbons + walks (+1 m, 4 m ramp), Towns infill yards,
runways (+25 m), the Sign Hill letters, and toward L8 tiles without lidar. Every weight is an exact function of world
position and each lidar sample is taken from the fetch that owns it, so neighbouring tiles agree bit for bit (checked
on all 6241 L9 and 7271 L8 edges). Codec: as `tiles/h` with 1/64 m steps and a per-L8-tile offset (index row
`[x, y, childMask, o]`).

Client: `Terrain.h(x, z)` = finest loaded surface (L9 lidar near the camera); `Terrain.hBase(x, z)` = `h(x, z, 7)` =
the base surface. Towns, Landmarks and Life (`ctx.groundY`) build on `hBase`, and the lidar is suppressed exactly
there, so roads, buildings and bridge approaches are unchanged. Trees, grass, players, aircraft use `h`.
`ensure(rect, prio, maxL)`: rects ≤ 1 km also load the L8 lidar (default), Towns/Landmarks pass 7.

### Ground materials (mat)
Classified at the NAIP near-infrared resolution (0.78 m, `masks.compute_direct`: NDVI, NDWI, brightness, texture,
water, canopy) plus OSM areas, Towns roads/walks/footprints and the track, pooled 2×2 by majority and 3×3-majority
filtered. Shader (`12_terrain.js`): the four nearest class cells are blended bilinearly through a small noise warp into
weights for asphalt, concrete, grass, soil, dry grass, gravel, sand and leaf litter; they pick the eye-level surface
(detail textures `groundDetailTexture` + `groundDetail2Texture`, tinted by the photo) and the mid-range detail branch.
GroundCover places grass only on lawn, dry grass, shrub, marsh and farmland (sparse on leaf litter).

### Trees v2 (t2)
The NAIP crown detector (`tiles/t`) is kept (position, crown, species). Canopy heights come from the Meta/WRI 1 m
canopy height model (CC BY 4.0), in three steps (`tools/bake_trees2.py all`):
1. **register**: the photo and the model (built from other imagery) disagree by up to ~8 m, differently by region
   (SF/East Bay ~7 m east, the South Bay 1-3 m east and 3-7 m south). Per imagery tile, the shift that puts the most
   crowns on canopy (±20 m search) → `data/raw/chm_meta/shifts.json`; unsure tiles and hill tiles take the median of
   confident neighbours.
2. **bake** (row by row, so each model strip is decoded once): each crown's height = the model's treetop within the
   crown × 1.35 (the model under-reads tall and urban canopies; 0.70-0.75 of the crown allometry here); model peaks
   ≥ 4 m without a photo crown become trees (moved onto the photo by the shift), never on roof/paving/gravel/water
   classes or the track bed; L7 tiles under L6-only imagery with canopy (the hills: Woodside, Huddart, Crystal
   Springs, the Santa Cruz Mountains) get trees from the model alone.
3. **index**.
Not done: the SF Street Tree List (DataSF, ODC-PDDL) — the portal answered 403 to scripted requests from this machine;
download the CSV in a browser and merge like the model peaks (skip within 3 m of an existing crown, species map).

## Facades (`30_towns.js`, cache key `towns-bld-v6`)
Per-building seed → window width/height scale, column spacing, pairing; blinds and curtains; string courses,
spandrels, darker bases, cornices. Shader only, no data change.

## Round 2: shader and geometry work, no new data
Every round-2 change is client code. No data layer was added or changed, and `tiles/{h9,mat,t2}` are untouched.
- **GTAO** (`14_post.js`): ground-truth AO (Jimenez 2016 / XeGTAO) at half resolution, with 2 slices × 7 steps on
  high and 4 × 10 on Ultra+. The radius grows with distance, and there's a thin-occluder heuristic. Grass blades and
  leaf cards write scene alpha 0, and the composite keeps only a quarter of the AO on them. Sunlit pixels keep most of
  their light. QA: `Post.debug.showAO`.
- **Eye adaptation** (`14_post.js`): the centre-weighted log-average of the HDR frame (16×9 jittered grid → 1×1)
  is eased toward over about 1 s. Scenes darker than a sunlit street are lifted by up to 1.1 EV (1.3× at night).
  Only scenes over twice that bright are pulled down, by at most 15%. QA: `Post.aeRead()`, `Post.debug.ae`,
  `Post.debug.aeKey`, `Post.debug.expo`.
- **Light shafts** (`14_post.js`): a half-res march toward the sun's screen position measures the open-sky fraction.
  It uses 24 taps on high, 40 on Ultra+, 16 on medium, and none on low. Lit haze is added in front of surfaces, and
  the shadowed part of the glare is taken out of the sky. It runs only with the sun up and near the screen.
  QA: `Post.debug.shafts`, `Post.stats.shaftK`.
- **SSR** (Ultra+ only, `BL_SSR`): screen-space reflections on open water at sea level, with a Fresnel blend.
- **Interiors** (`30_towns.js`): interior mapping behind every window cell. The ray goes into a room one cell wide,
  one floor high and 3-6.5 m deep: back wall with furniture, floor, ceiling lamp, side walls, and shop shelving at
  street level. Blinds cover part of the room. Each room is lit or dark on its own at night.
- **Roofs and building geometry** (`30_towns.js`): procedural roof materials by class (membrane, gravel, bitumen,
  standing seam, shingles, clay barrel tile, slate), and near the camera the photo roofs keep only their ~3 m tone.
  Geometry at detail level 2: mitred cornices, storefront awnings, SF bay windows, stair bulkheads, SF wooden water
  tanks, and rooftop units on photo roofs.
- **Ground near the camera** (`12_terrain.js`): when the photo is magnified, per-material detail takes over at any
  camera height: asphalt patches and cracks, concrete slabs and joints, grass clumps, and a bump normal.
- **Ground from the air** (`12_terrain.js`): on photos of 1.5 m or coarser (L7+, the hills), magnification gets
  crisp, noise-wandered edges (one fetch). Natural land cover also gets grass mottling, tufts, shrubs and two-size
  crowns with shadows. The terrain noise uses an integer hash, because the float hash drew contour lines far from
  the origin.
- **Trees** (`61_flora.js`):
  - A repainted atlas: lobed clusters and depth-shaded leaves.
  - A normal atlas: painted per-leaf tilt and fold, plus normals derived for conifers, palms and barks. Both atlases
    upload from arrays with a pull-push fill, so there are no dark fringes, and start-up is 0.6 s.
  - Clump-aware lighting normals.
  - Chlorophyll-tinted translucency from the smooth crown normal, and two-sided sky light on leaves.
  - Cards outside the crown envelope are dropped, and grazing cards fade. This removes the pale discs over the line.
- **Ultra+**: 16× anisotropic ground and the above at higher sample counts, on top of round 1's 2× render scale,
  terrain shadows and far cascade.
- **Probe**: a too-slow benchmark is cached for 1 day, not 30, and the chip stays clickable to re-test
  (`bayline.gfx.probe.v2`).

QA: `tools/qa_hero.py OUT --a URL --b URL [--hash q=high] [--views ...]` shoots gameplay-framed before/after pairs
(the cab from a paused train, photo mode) and writes `hero.jpg`, `hero_thumbs.jpg` and `pair_*.jpg`.

## Ultra+ (opt-in)
- `13_gfx.js`: preference (`localStorage bayline.gfx`), `Gfx.probe()` = WebGPU hardware adapter + WebGL limits + the
  terrain-shadow kernel as a benchmark while the page pauses drawing (M2: 8.5 ms; pass ≤ 1.4× that), cached 30 days
  per adapter + UA. Chip rows on the title card (`#gfxchips`) and in the help overlay (`#gfxchips2`).
- `90_main.js` tiers: `ultraplus` (render scale up to 2×, 8.3 MP cap; dynamic resolution 2× → 1× to hold ~30 fps;
  step-down to ultra when still slow at 1×), terrain lod 3.2 + 128² meshes for lidar nodes. Never chosen by Auto.
  `#q=ultraplus` (probe first), `#q=ultraplus!` (skip the probe, QA). Separate commit fixes the LOD numbers
  (they were inverted: ultra refined least).
- `18_sunshade.js`: WebGPU compute over the 64 m world field → per 100 m cell the top of the terrain's shadow toward
  the sun + occluder distance (penumbra), and sky visibility; banded one row block per frame, only while the sun is
  < 20°, read back into WebGL textures. A zero-intensity second sun light = far shadow cascade (2048², ±2.5 km, every
  6th frame). The lighting chunk patch compiles only when `NUM_DIR_LIGHT_SHADOWS > 1`, i.e. only in Ultra+.
  QA: `__bayline.SunShade.stats`, `.sample(x, z)`, `.uniforms.k.w` (1 near map only, 2 far map only).

## What runs where
WebGPU: the Ultra+ benchmark and the terrain sun/sky solver (compute only). WebGL2: all rendering, every tier.

## QA switches
`#h9=0` `#mat=0` `#t2=0` (layers off), `#q=ultraplus[!]`, `tools/qa_views.py OUT [--base URL] [--hash ...]`
(fixed views + frame cost), `tools/qa_views.py --compare A B sheet.jpg`.

## Trees for the rest of the world (plan, not in this branch)

The globe (`15_globe.js`, web-mercator tiles: AWS terrain + NAIP/EOX imagery) has no trees. Plan, in order of value:
1. **Source**: the same Meta/WRI canopy height map (global, 1 m, CC BY 4.0) as zoom-9 quadkey COGs on AWS; ESA
   WorldCover 2021 10 m (CC BY 4.0) as the land-cover prior (tree / shrub / built / water) where the CHM is thin.
2. **Bake, not stream the COGs** (each z9 COG is 0.1-0.6 GB, striped, no overviews; the browser can't range-read
   them usefully): a server-side job per z12 web-mercator tile (~9.8 km at the equator) derives a compact
   "forest tile": 256² cells of (canopy fraction, p50 and p90 height, dominant land-cover class) = ~50-150 KB zlib
   per tile, only where canopy > 2 %. Cache under `data/v2/world/trees/12/x/y.bin` (+ an index per z6 region), built
   lazily for regions people fly over (a request log → a bake queue), so the world never needs baking up front.
3. **Client**: near the camera (< ~3 km), a WorldTrees module places instances procedurally from each cell's canopy
   fraction and heights (blue-noise per cell, seeded by the cell id, so the forest is stable), with species by
   biome/latitude (WorldCover class + Köppen zone: conifer / broadleaf / palm / savanna shrub) using Flora's models and
   impostors; beyond that the imagery carries the canopy, as it does now. Density budgets per tier through
   Flora's instance caps (Ultra+ full density; low: 25 %).
4. **Checks**: trees never on water/built cells (WorldCover), on OSM runways (Airports already flattens them), or on
   the globe's own airport surfaces.
Effort: ~2-3 days (bake job + module + species rules + QA), bandwidth ~0.1-0.3 MB per 10 km of flight.
