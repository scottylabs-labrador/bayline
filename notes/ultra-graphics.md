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

## Facades (`30_towns.js`, cache key `towns-bld-v4`)
Per-building seed → window width/height scale, column spacing, pairing; blinds and curtains; string courses,
spandrels, darker bases, cornices. Shader only, no data change.

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
