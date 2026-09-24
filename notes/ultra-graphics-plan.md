# Ultra graphics: plan (branch feat/ultra-graphics)

Two asks from the user, in their order:
1. **Better data first**: USGS 1 m lidar terrain for the Bay (vs ~6 m today), ground detail that knows grass, asphalt,
   gravel etc. from the photos, and more varied building facades. These help every tier.
2. **An opt-in "Ultra+" tier on WebGPU** that is offered only when a quick benchmark passes, so the default tiers keep
   running on every machine.

Hard constraints: no regression for the default tiers (visual or frame time); everything new is additive and optional
(old clients ignore new data; new clients run without it); no data published, nothing pushed; small reviewable commits
that merge cleanly next to Agent B's aircraft branch (Agent B only adds one `setQuality` line to `applyTier` and accepts
`'ultraplus'` as a level).

---------------------------------------------------------------------------------------------------------------------
## 0. Where things stand (facts the design builds on)

* Terrain (`12_terrain.js`): a camera quadtree over the SPEC_v2 grid. Node = 64x64 quads (`G`), one mesh each.
  Heights exist L0–L7 (129² samples; L7 = 800 m tile, 6.25 m spacing), imagery L0–L9 (L9 = super-resolved, 0.2 m),
  masks L0–L7 (R water, G lights, B canopy, A landcover 0–7). L8/L9 nodes reuse L7 heights. Per-pixel normals come
  from the height texture. `h(x,z)` = bilinear on the finest loaded height tile; `ensure/hasDetail(rect)` gate every
  system that builds geometry on the ground (Towns, Flora, Stations, TrackGeo, Landmarks).
* Heights today: AWS terrarium z15 (3DEP-derived, resampled; blocky in hills), carved along the track
  (bed within 45 m, blend to 140 m, station zones flattened).
* Ground rendering: near a low camera the photo becomes a synthesized surface picked per pixel from the photo's own
  colour stats (veg / grey / lum) — wrong on dry golden grass, shadows, dark roofs; beyond that, detail by the 6.25 m
  landcover class. `groundDetailTexture` = R asphalt, G dirt, B grass, A concrete (2.5 m tile).
* Towns (`30_towns.js`): roads are raised ribbons (LIFT 0.22–0.40 m, curbs, walks, an outer curb dropping 0.5 m) on a
  per-tile height field sampled on the L7 grid; buildings sit at min ground + 0.02 with walls buried 1.2 m. Facades are
  a 17-layer texture array + one shader (`towns-bld-v3`): style/material/colour per building from `lookOf`, but every
  building of a style has identical windows.
* Tiers (`90_main.js`): ultra/high/medium/low = (dpr, terrain lod, post quality). Auto-tiering on frame time; `#q=`
  forces. Post (`14_post.js`) QUALITY high/medium/low: MSAA, SSAO samples, fog steps, bloom, shadow map size. One sun
  shadow map, ±90 m at street level growing to ±2.2 km with altitude. **Terrain casts no shadows at all**: hills never
  shade valleys at sunrise/sunset.
* Renderer: three.js r158 WebGL2, logarithmic depth, lots of `onBeforeCompile` GLSL. A WebGPU renderer port is not
  realistic (weeks, and r158's WebGPURenderer can't run these GLSL patches). WebGPU is available in headless Chrome
  here (`--gpu`: Apple metal-3, timestamp-query, shader-f16); with SwiftShader there is no adapter (fallback testable).

---------------------------------------------------------------------------------------------------------------------
## 1. Lidar terrain: `tiles/h9` (all tiers)

**Source.** USGS 3DEP bare-earth DEM (1 m lidar where available, best-available elsewhere), public domain, from the
3DEPElevation ImageServer `exportImage` in EPSG:4326 (the Bayline frame is linear in lon/lat, so pixel centres land
exactly on tile vertices). One request per L8 tile (273² F32 at 1.5625 m incl. an 8-sample margin), cached as npz in
`data/raw/lidar3dep/8/` (done: 3955/3955 tiles, 0 errors, 812 MB).

**Method: detail transfer, not replacement.** `h = L7(x) + w(x) * (lidar - lowpass_L7(lidar))`:
the existing L7 surface stays the ground truth at large scales (track carve, station flats, bathymetry, everything
already built on it), and only the lidar's fine relief (< ~12 m wavelengths: street grades, lot terraces, levees,
berms, ravines, cut slopes, hill texture) is added. `lowpass_L7` = the lidar as the L7 grid sees it (6.25 m box +
bilinear), so adding the residual never shifts the large-scale surface. Detail is clipped to ±12 m (blunders).

**Suppression weight w (0 = no detail)** — wherever modelled geometry sits on the base surface:
* track bed ±12 m → full at 30 m; tunnels; platform and station zones (existing zone list) — the carved bed stays exact;
* Towns road ribbons (decoded from `tiles/b`: width/2 + walks + 1 m, ramp 4 m; bridges skipped) — roads are drawn
  from the L7-grid height field, so the ground under them must stay the L7 surface or it pokes through;
* Towns infill cells (25 m cells where procedural houses/yards are drawn at +0.10 m);
* runways (OurAirports runways inside the square: half-width + 25 m, ramp 25 m);
* water (L7 mask, dilated), lidar no-data (dilated);
* the outer edge of the coverage (fade over 60 m where a neighbouring L8 tile has no lidar), so there is no step
  between lidar and non-lidar terrain.

**Format.** Same codec as `tiles/h` (129² uint16 q = round((h+200)*16), MED zigzag residuals, zlib), new product
directory (SPEC rule: formats never change in place):
* `tiles/h9/8/{x}_{y}.bin` — L8 (400 m, 3.125 m spacing): base + [1 2 1]-smoothed detail, every L8 imagery tile;
* `tiles/h9/9/{x}_{y}.bin` — L9 (200 m, 1.5625 m spacing), only children with detail > 5 cm;
* `tiles/h9/index.json` — `{version, product:'h9', levels:[8,9], l8:[[x,y,childMask]...], attribution, ...}`.
Budget: ~20k tiles, estimate 300–500 MB total (measure after the bake; if too big, quantise L9 to 1/32 m residuals
is NOT needed — drop L9 children below a detail threshold instead).

**Client (`12_terrain.js`).**
* Optional `tiles/h9/index.json` at load (404 → layer off; everything behaves exactly as today).
* Height levels: L0–L7 from `tiles/h`, L8–L9 from `tiles/h9` where present. `needHgt(L,x,y)` picks the path by level;
  the quadtree also refines to L9 where lidar exists but SR imagery doesn't (the node takes L8 imagery).
* `finest()` walks from the finest height level; `hInfo/hTC` unchanged (same 129² layout).
* **Two height queries**: `h(x,z)` = finest loaded (what the near terrain renders; player, flight, trees, grass,
  station furniture, parked cars); `hBase(x,z)` = `h(x,z,7)` = the base surface, which the lidar never changes under
  roads/track/stations. Towns, Landmarks and Life (`ctx.groundY`) switch to `hBase`, so every road ribbon, building,
  yard and bridge approach is bit-identical to today regardless of what has streamed.
* `ensure/hasDetail(rect)`: rects up to ~1 km also wait for the L8 lidar tiles (so trees are placed on the lidar
  surface, not on L7 then floating); larger rects stay at L7. Missing/404 tiles count as done (graceful).
* LRU caps grow (hgt 700 → 1100); L9 heights only requested for L9 nodes (≤ ~200 m from the camera).
* Ultra+: L8/L9 nodes use a 128x128-quad geometry, so vertices sit on the 1.56 m lidar samples.
* Attribution string in the title card footer.

---------------------------------------------------------------------------------------------------------------------
## 2. Ground materials: `tiles/mat` (all tiers)

**What.** A per-L7-tile class map at 1.5625 m (512² uint8, cell-centred, aligned with the L9 height grid), classified
offline from NAIP RGB + NIR (NDVI, NDWI, brightness, saturation, local texture), OSM (roads with widths, buildings,
landuse areas), the track (ballast strip) and the existing water/canopy masks. Classes:
`0 none | 1 lawn | 2 dry grass | 3 shrub/scrub | 4 tree-shade ground (leaf litter) | 5 bare soil | 6 gravel/ballast |
7 asphalt | 8 concrete/paving | 9 roof | 10 sand | 11 rock | 12 water | 13 marsh | 14 salt pond | 15 farmland`.
Rules, in priority order: water (mask) → salt pond / marsh (OSM + spectrum) → roof (OSM footprints) → track ballast
(±2.6 m of each track, gravel) → road asphalt (towns roads, OSM widths) / sidewalk concrete (walk bands) →
vegetation by NDVI (lawn: smooth + bright green; dry grass: golden + low-mid NDVI; shrub: textured; leaf litter: under
canopy) → bare ground by colour (asphalt dark grey, concrete light grey, soil brown, sand pale near shore/beach areas,
rock grey-textured in rock areas) → OSM landuse overrides (farmland, pitch/golf/cemetery lawn, parking asphalt).
Then a 3x3 majority filter. Shadows: NDVI is a ratio, so vegetation survives shade; dark non-vegetated pixels take the
neighbourhood's non-shadow majority.

**Format.** `tiles/mat/7/{x}_{y}.bin` (zlib, 512² uint8) + `tiles/mat/index.json`. ~2066 tiles, est. 30–80 MB.

**Client.**
* Terrain: the node's class map (L7 ancestor, like masks) is sampled at 4 nearest texels with bilinear weights into a
  per-material weight vector (smooth 1.56 m boundaries, jittered by a small noise so edges aren't grid-aligned).
  That drives: the eye-level synthesized surface (replacing the photo-statistics guess), the mid-distance detail
  (replacing the 6.25 m landcover class), and roughness. A second detail texture adds gravel/ballast, dry grass/straw,
  sand and leaf litter patterns (the existing one has asphalt, dirt, grass, concrete).
* GroundCover: grass tufts only on lawn / dry grass / shrub / marsh / farmland classes (and their colour from the
  photo as now), never on asphalt, roofs, gravel.
* Without the layer (404 or old data): exactly today's behaviour.

---------------------------------------------------------------------------------------------------------------------
## 3. Facades (all tiers; `30_towns.js` only)

Everything keyed by the per-building `seed` already in `aWin` (no data format change), so buildings of one style differ:
* **Window parameters per building**: width 0.6–1.35x, height 0.85–1.15x, sill offset, and grouping (singles, pairs,
  triplets with a wider pier) by remapping the facade-cell uv before sampling the layer (gradients scaled to match, so
  mipmapping stays correct).
* **Horizontal articulation**: string courses / spandrel bands in a second colour for resid/office/civic; a distinct
  ground-floor plinth (darker/stone) on multi-storey buildings; a cornice/coping band at the eave.
* **Window life**: blinds at random heights, curtains in a few colours, interior depth variation by day, and warmer /
  cooler lit windows at night (per window, band-limited as now).
* **New layers**: `shingle` (Victorian/house wall material), `ribbon` (continuous office glazing), `arched`
  (civic/church), `industrial` (multi-pane steel sash) → `N = 21`, cache key `towns-bld-v4`.
* **Geometry**: bay windows on SF Victorian street fronts (angled 3-sided bays from the 2nd floor up), and cornice
  boxes on SF and downtown walk-ups; storefront awnings (seeded colours) on street-facing style-4 walls. Only for
  buildings with a known front edge; only at detail level 2 (≤ HI_R), so far tiles don't pay.
Cost: a handful of ALU ops per facade pixel and a few % more triangles near the camera.

---------------------------------------------------------------------------------------------------------------------
## 4. Ultra+ (opt-in, WebGPU-gated)

**What runs where (honest).** The renderer stays WebGL2 (the whole world is built on its GLSL). WebGPU runs:
(a) the eligibility benchmark and (b) a compute solver for terrain lighting — sun visibility (hill shadows with a
physically sized penumbra) and sky visibility (terrain ambient occlusion) over the whole 102 km square — whose results
are read back into WebGL textures. Everything else in Ultra+ is higher WebGL2 budgets.

**Tier.** `{ name: 'ultraplus', dpr: 2 (render scale, also on dpr-1 displays = supersampling), cap 8.3 MP, lod 6.0,
post: 'ultraplus' }`. `applyTier` keeps its shape; modules get `setQuality('ultraplus')`:
* Post: `ultraplus` = MSAA 4 (2 above 4.6 MP), SSAO 16 samples, fog 24 steps, bloom 7 levels, shadow 4096;
* Env: a **second (far) sun shadow cascade** (DirectionalLight, intensity 0, 4096², ±2.5 km) so buildings, trees and
  trains cast shadows out to 2.5 km (today: ~150 m at street level); cascade selection + terrain sun/sky visibility
  happen in one patched `lights_fragment_begin` that only compiles when `NUM_DIR_LIGHT_SHADOWS > 1` — i.e. only in
  Ultra+. Default tiers compile the exact same shaders as today;
* Terrain: lod 6.0, 128² quads for L8/L9 nodes, anisotropy 16;
* Towns: build radius x1.35, detail radius ~1000 m, shadow casters out to the far cascade;
* Flora: its highest instance budgets, shadow casters farther; GroundCover: reach 34 → 55 m.
Auto-tiering never enters Ultra+; when the user picks it, a watchdog drops to Ultra (with a toast) if the average frame
time stays above ~33 ms, or if the WebGPU device is lost and can't be recreated.

**Eligibility** (`Gfx.probe()`, cached in localStorage per adapter vendor/architecture + UA for 30 days):
1. `navigator.gpu` + a high-performance adapter that is not a fallback/software adapter (and not SwiftShader/llvmpipe);
2. WebGL2 limits: MAX_TEXTURE_SIZE ≥ 8192, MAX_SAMPLES ≥ 4;
3. **benchmark** (~0.3–1 s): the terrain-shadow kernel itself on a synthetic 1024² field x 192 steps, 3 timed runs
   after a warm-up (timestamp queries when available, else submit→onSubmittedWorkDone), pass if the median ≤ a
   threshold calibrated on this M2 (≈3x its time, so M1/M2-class and discrete GPUs pass, low-end integrated fail).
Result: `{ ok, reason, ms, adapter }` shown next to the option ("Ultra+ needs WebGPU", "GPU too slow for Ultra+").

**UI.** Title card: a "Graphics" chip row (Auto · Low · Medium · High · Ultra · Ultra+), Ultra+ disabled with a reason
when ineligible. In game: the same row in the help overlay (H). Choice persisted (`bayline.gfx`). Hash: `#q=ultraplus`
(runs the check; falls back to ultra with a warning), `#q=ultraplus!` (skip the benchmark, for QA). Title footer:
"Graphics: Ultra+ uses WebGPU for terrain lighting".

**Solver (`18_sunshade.js`, WebGPU compute).** Input: the world field Terrain already holds (1601² at 64 m) in a
storage buffer (10 MB, once). Kernels:
* sky visibility (once): 16 azimuths x 24 geometric steps to 12 km → mean cos²(horizon) → R8;
* sun shadow (when the sun moved > 0.05° or 12 s passed; ≤ 4 Hz in time-lapse): march toward the sun, 128 geometric
  steps from 1.5 texels to 30 km, `S = max_k(H(q_k) - t_k tan(el))` = the absolute height of the terrain-shadow
  volume's top above each texel, plus the occluder distance → penumbra half-height `w = max(2, 0.0047 t*)`.
  Any point (x, y, z) is in terrain shadow iff `y < S(x,z)`: one lookup serves terrain, buildings, trees and trains.
  Packed as RG16F, read back (mapAsync), uploaded as a WebGL texture.
* shading: `sun *= smoothstep(S - w - bias, S + w - bias, y)` with bias ~4 m (the 64 m field vs the rendered surface),
  `ambient *= mix(1, skyVis, 0.8)`; world position reconstructed from the view position (and un-bent: the earth-curve
  bend is applied in view space).
Uniforms are shared by all lit built-in materials through `ShaderLib` (value objects whose `clone()` returns themselves);
no ShaderMaterial in the project uses `lights: true` (checked), so no lit shader lacks them.

---------------------------------------------------------------------------------------------------------------------
## 5. Files touched

| file | change |
|---|---|
| `tools/tiles/lidar.py`, `tools/bake_lidar.py` | new: fetch + detail transfer + index |
| `tools/tiles/towns_dec.py` | new: decoder for `tiles/b` (roads, walks, infill mask) used by both bakes |
| `tools/tiles/materials.py`, `tools/bake_materials.py` | new: class maps + index |
| `src/js/12_terrain.js` | h9 levels, `hBase`, level-aware ensure, fine geometry, material maps + shader |
| `src/js/13_gfx.js` | new: capability probe, WebGPU benchmark, preference, UI rows |
| `src/js/18_sunshade.js` | new: far cascade, lighting chunk patch, WebGPU terrain-light solver |
| `src/js/14_post.js`, `61_flora.js`, `63_ground.js`, `30_towns.js` | `ultraplus` quality; materials in GroundCover; facades |
| `src/js/90_main.js` | TIERS + applyTier (+ user choice, watchdog), `ctx.groundY = hBase` |
| `src/head.html` | Graphics chip row, help overlay row, attribution |
| `notes/ultra-graphics.md` | how it works (for the next agent) |

## 6. Data layers and publishing (orchestrator)

Order matters: the client only uses a layer once its index exists, so publish tiles first, index last:
`sh tools/publish_data.sh tiles/h9/8` → `tiles/h9/9` → `tiles/h9` (re-syncs, adds index.json) → `tiles/mat/7` →
`tiles/mat`. Old clients never request these paths. Code can be deployed before or after the data.

## 7. Verification

* Fixed review views (before = `dist/base.html` built from main 0d94719, after = `dist/lead.html`), same hash/time:
  Belmont hills aerial, San Carlos platform (eye level), Alamo Square Victorians (street), Market St downtown (street),
  Stanford oval lawns (low), Hillsdale suburb (low aerial), golden-hour Peninsula looking at the hills (Ultra+ vs
  Ultra), trackside near Millbrae. Contact sheet per pair.
* `PORT=8124 sh tools/qa_all.sh`, `node tools/qa_flight.js`, zero console errors (all tiers, with and without the new
  layers, with and without WebGPU = SwiftShader run).
* Frame cost per tier (`Post.profile()` + 90-frame averages) at 3 views, before/after.
* Unit checks: bake seams (L8/L9 edge continuity < 1 cm), suppression (road samples == base), `h` vs rendered
  geometry, h9 absent → identical `h` to base.

## 8. Commits (small, each builds and runs)
1. lidar bake tooling  2. towns decoder + suppression  3. client h9 + hBase  4. materials bake  5. materials shader +
GroundCover  6. facades shader  7. facade geometry  8. Gfx probe/benchmark/UI  9. tiers + budgets  10. far cascade +
chunk patch  11. WebGPU solver  12. notes + review tooling.

---------------------------------------------------------------------------------------------------------------------
## 9. Adversarial review of this plan, and the revisions it forced

1. *"Towns on `hBase` while the terrain renders lidar: won't buildings float?"* Walls are buried 1.2 m below the lowest
   footprint sample, lidar detail is ±0.05–0.15 m typical (p95 well under 1 m), and the bare-earth DEM under buildings
   is a TIN-flattened pad anyway. Floating would need > 1.2 m of negative detail at a wall: rare, and checked in review
   views. Roads cannot float or sink: the detail is suppressed under every ribbon (+1 m, 4 m ramp), so the terrain there
   *is* the base surface. **Kept.**
2. *"`ensure()` at L8 for Towns' 800 m tiles means ~9 more requests per tile and slower street building."* Towns and
   Landmarks don't need lidar (they build on `hBase`). **Revised:** `ensure/hasDetail(rect, prio, maxL)`; Towns and
   Landmarks pass 7 (exactly today's requests); Flora/TrackGeo/Stations default to the L8 lidar for rects ≤ 1 km.
3. *"Draped meshes other than roads?"* Found: the Sign Hill letters (draped at +2.4 m on a real hillside) and the SFO
   runway-end markings. **Revised:** suppression also within 140 m of Sign Hill; runways are already covered.
4. *"LOD seams: L7 nodes (no detail) next to L8 nodes (lidar)."* Boundaries sit ≥ ~190 m from the camera where typical
   steps are < 1 px; skirts hide cracks. **Verify** in the Belmont-hills view; if ledges show, fade the L8 detail
   toward its node edges.
5. *"The tiers' terrain LOD is inverted."* `split = T/d > k`: a larger k refines *less*, yet ultra has k=4.8 and low
   2.6 — low-end devices get the most terrain nodes, ultra the fewest. **Revised:** fix the numbers, not the rule, so
   the default desktop tier (high, 4.2) is bit-identical: ultraplus 3.2, ultra 3.6, high 4.2, medium 4.8, low 5.6.
   Measure node counts / frame time before and after and report it as a separate commit.
6. *"Global shader patch = regression risk for every material."* The new code sits under
   `#if NUM_DIR_LIGHT_SHADOWS > 1`, which is true only while the Ultra+ far cascade exists; default tiers compile the
   same code as today. Loop bodies are wrapped in their own block (three's loop unrolling pastes bodies side by side).
   The uniforms reach every lit built-in material via `ShaderLib`; no `lights: true` ShaderMaterial exists (checked).
   Outside the Bay frame (Globe rebased) or off the square, the terrain lookups return "lit".
7. *"Readback + upload of a 1601² RG16F every 12 s may hitch."* **Revised:** the sun-shadow output is 1024² at 100 m
   (= the 102.4 km square exactly, 4 MB); the 64 m field is still the input. A near field (12.5 m, 12.8 km window from
   loaded tiles) is a follow-up if review shots show it's needed.
8. *"Is Ultra+ worth it on a Retina Mac where ultra already renders at dpr 2?"* The resolution is the same there; the
   gains are lighting (terrain shadows + sky visibility, shadows out to 2.5 km), geometry (lidar-resolution meshes,
   finer LOD) and ranges. On dpr-1 desktops Ultra+ also supersamples (2x per axis, 8.3 MP cap). Frame-time watchdog
   drops to ultra if it can't hold ~30 fps.
9. *"Benchmark at boot competes with loading."* It runs only after the title card is idle (and only if `navigator.gpu`
   exists), or on demand when Ultra+ is picked; results are cached per adapter + UA.
10. *"How do we prove the fallbacks?"* **Added** QA flags `#h9=0` / `#mat=0` (layers off → must match base exactly),
    SwiftShader runs (no WebGPU → Ultra+ disabled with a reason), and `#q=ultraplus!` to force it on for captures.
11. *"New data but old code / new code but no data?"* Old code never requests `tiles/h9|mat`. New code treats a
    missing index as "layer absent" and a missing tile (404) as "use the coarser level".
