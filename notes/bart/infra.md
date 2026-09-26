# Bayline Metro: INFRA workstream status

Owner: infra workstream. Branch `bart-infra`, worktree `.worktrees/bart-infra`, dev port 8134.
Files owned: `src/js/23_metrotrack.js`, `src/js/24_metro*.js`, `preview/metrotrack.html`, `notes/bart/infra.md`,
`notes/bart/shots/infra/`, plus small, clearly marked hooks in `10_env.js`, `12_terrain.js`, `13_gfx.js`, `14_post.js`,
`90_main.js` (underground support). Everything is behind `#metro=1`.

## Status

- **2026-09-26 05:00 — M2 progress** (all on `bart-infra`, merged with `bart` 23d1eb9):
  - **Junctions v1** (open air): within 45 m of every MetroNet junction, coincident rails are drawn once (the switch
    points), rail crossings get rail-bound manganese frog castings + guard rails (48 mm flangeway), switch machines stand
    at the points, and the third rail gaps wherever it would foul another track (76 mm end ramps; insulators follow).
  - **Underground junctions**: crossover chambers (a wide cut-and-cover box over each junction cluster where crossover or
    diverging tracks run within 12 m: Market/Mission St double crossovers, Embarcadero, Berkeley, Milpitas, SFO/Millbrae,
    Daly City tail), end walls with the continuing tunnels as openings; elsewhere (the Oakland Wye) tunnels are merged by
    dropping triangles inside other tunnels' envelopes; tunnels of one junction cluster are one visibility unit.
  - **Ground**: beds and trench walls follow the world workstream's MetroGround carve (ballast 2:1 slopes to the carved
    ground, walls at 3.05 m cover its 3.0-3.9 m step; no terrain cuts at grade when the carve is active).
  - **Right-of-way fences** at grade (2.13 m chain link + 3 barbed strands on outriggers), stochastic-transparency
    fabric; **tie LOD** (full ties ≤ 70 m, flat ties to 320 m), nearest-first instance budgets.
  - **Fine cut level** (0.25 m over 128 m around the camera) for the terrain cut test: sharp stair wells and portals.
  - **Draw calls**: the primary of a pair builds both girders and its partner's rails; far pieces self-hide under
    bodies. MacArthur (busiest view): all metro modules together 201 → 246 calls (+45); West Oakland +55.
  - EMBR platform bug fixed (Under never culls a top-level ancestor of a registered cell group).
- **2026-09-26 02:40 — M1 delivered on `bart-infra`** (merged with `bart` M1 integration):
  - `23_metrotrack.js` MetroTrack: streamed guideway over every MetroNet track (bart + ebart; the airport connector
    is left to its own module), three layers per track with their own chunk lengths (DETAIL 400 m ≤ 480 m, BODY 800 m
    ≤ 2.7 km, FAR 2 km ≤ 11 km, far pieces hide themselves where a body shows), time-sliced jobs (≤ 3.2 ms/frame),
    paired tracks (≤ 7.6 m apart) share structures, twin bores (≤ 22 m) know their inner side.
  - `24_metroguide.js`: 119RE rails canted 1:40 with a polished band (Catmull-Rom smooth curves), continuous DF plinths,
    third rail at 1.499 m / +171 mm with grey porcelain insulators and grey coverboard (outer side, away from platforms),
    ballast bed with 2:1 shoulders and a skirt to the ground + terrain cut, automatic retained cuts where at-grade track
    runs below the ground (portal approaches), trenches, freeway-median barriers + fences, **1970s aerials: twin slender
    box girders (1.22 m deep, 3.556 m decks, sunken walkway between) on 1.52 m hexagonal columns with hammerhead caps,
    elastomeric bearings, ~45 % of columns in seismic steel jackets**, modern single-box style (2003+), abutments, far
    silhouettes; instanced fasteners (914 mm), ties (762 mm), insulators (3.05 m) around the camera.
  - `24_metrotube.js`: Transbay Tube bores (5.18 m, walkway 0.76 m at +0.71 m on the gallery side, yellow gallery doors
    every ~100 m), SF/Oakland bores (Market St bolted steel rings), Berkeley Hills horseshoe (LEDs every 7.62 m),
    cut-and-cover box cells (walkway on the centre-wall side), fluorescent fixtures every 15.24 m lighting their own
    tunnel per fragment (the rails glint), handrails, cable racks, blue-light stations, portal headwalls with fences;
    every tunnel piece ≤ 200 m is an Under cell with portals (daylight at mouths, 'auto' to neighbours and stations).
  - `24_metrounder.js` Under + engine hooks (post, terrain, main): see the API below. Verified: Tube interior, Berkeley
    Hills tunnel, Mission St bore, the West Oakland aerial → portal → box → Tube sequence (exposure ramps 0.66 → 1.0,
    draw calls fall from ~254 outdoors to ~30 in the tunnel), EMBR/MONT/12TH/19TH/GLEN platforms with the stations'
    cells (**fixed the all-navy Embarcadero bug**: Under culled the `metrostations` root; it now never culls a top-level
    ancestor of a registered cell group, and accepts `ambient` as a number or `[r, g, b]`).
- 2026-09-26 00:40: started.

## Plan (M1 → M2)

1. Research BART track and structure standards (dimensions below, with sources and assumptions).
2. `23_metrotrack.js` (`MetroTrack`): streamed guideway generator over MetroNet tracks: chunks ≤ 500 m per track,
   time-sliced jobs (≤ 3 ms/frame), three LOD rings (near full detail, mid simplified, far silhouette), merged
   materials. Rails (broad gauge 1,676 mm), direct fixation / ties on ballast, third rail with coverboard and
   insulators, aerial box girders + columns by era, parapets, walkways, retaining walls, trenches, medians, fences.
3. `24_metrotube.js`: bored tunnels, cut-and-cover boxes, the Transbay Tube (twin bores + gallery), portals,
   tunnel lights, walkways, cable trays, cross passages.
4. `24_metrounder.js` (`Under`): the underground engine: cells + portals, portal-based visibility, the
   "under map" (a camera-centred clipmap of underground volumes that every lit material reads so daylight never
   reaches inside a tunnel), terrain cut-outs at portals and entrances, underground exposure and post.

## APIs

### Underground cells, portals and cuts: `Under` (`src/js/24_metrounder.js`), M1 contract

Agreed with STATIONS (their 9 requests of 00:45, answered here; all accepted, notes inline). Every method is a no-op
unless `#metro=1` (`Under.enabled`).

```js
Under.addCell({
  id: 'st:MONT:plat',     // naming: stations 'st:<ID>:<level>' (plat, muni, conc, ent<k>), my tunnels 'tn:<track>:<k>',
                          // the Transbay Tube 'tb:<k>', portals 'pt:<...>' (ids are global: a second addCell with the same
                          // id replaces the first)
  poly: [[x, z], ...],    // footprint, world metres, any winding, simple polygon, up to 256 vertices
  // or strip: { pts: [[x, y, z], ...], half: m }   (a centreline strip: my tunnels)
  floor, ceil,            // world y (m ASL): lowest floor/track and highest ceiling of the cell (I pad both by 0.5 m)
  ambient: 0.8,           // average bounce light of the cell's fixtures, hemisphere-light units (see "Exposure" below);
                          // every lit material inside the cell's volume picks it up (trains, people, anything)
  daylight: [yBot, yTop], // optional (request 3): daylight 1 at yTop .. 0 at yBot inside this cell (entrance shafts)
  group,                  // optional Object3D: .visible follows portal visibility while the camera is underground
})
Under.addPortal({ id, a: cellId, b: cellId | null | 'auto', quad: [[x,y,z] x 4], probe: [x,y,z] })
  // any planar convex quad, any winding, any slope (request 8): horizontal slab openings, vertical tunnel faces and
  // sloped escalator wells all work (visibility projects the 4 corners, clipped to the near plane).
  // b: null = outdoors; 'auto' = whatever cell contains `probe` (resolved every frame, so a station can stream in
  // after my tunnel); an unresolved 'auto' portal counts as outdoors (safe) unless it has `dead: true` (then as closed:
  // my tunnel ends use that, since nothing is built beyond them).
Under.addCut({ id, poly: [[x, z], ...], below: y })   // terrain above y inside poly is not drawn (request 7: `below` =
  // the well/trench floor; up to 256 vertices; no limit on the count, 64 alive at once is fine)
Under.remove(id)          // a cell (and every portal that names it), a portal or a cut
Under.cellAt(x, y, z)     // -> id | null (request 2): the cell whose poly contains (x, z) with floor <= y <= ceil
Under.keep(obj)           // top-level objects that must keep drawing while the outdoor world is culled (metro trains);
                          // top-level ancestors of registered cell groups are kept automatically
Under.cutAt(x, z, y)      // true where the ground at (x, z) is cut away above y or y is inside a cell: modules that place
                          // things on the terrain (grass, trees, props) can skip those spots
// addCell also takes zone: key | [keys]: cells sharing a key are one visibility unit (tunnels of a junction cluster)
Under.state               // { cell, depth 0..1, outsideVisible, visible: Set<cellId>, daylight }
```

- **Stacked cells** (request 1): fine. The under map stores per column the lowest floor and highest ceiling of every
  cell over it (the slabs between stacked levels are solid, nothing draws there), the largest ambient, and the
  entrance daylight ramp; `Under.state.cell`/`cellAt` pick the cell by y exactly (CPU side, real polygons).
- **Tunnel-to-station portals** (request 2): I add them myself: each tunnel end gets `b: 'auto'` with a probe 2 m past
  the tunnel face. Station boxes ending at platform ends + 12 m, open to the full tunnel cross-section: agreed.
- **Station ends** (request 9): agreed. Inside `MetroStations.limits(id)` STATIONS builds the box / aerial deck and
  bents / trackway slab and undercar trench; I build rails, fastenings, third rail + coverboard + insulators through
  the station (third rail on the side away from the platform), and nothing else. My aerial girders end on your end
  bents (I stop girders at s0/s1 and skip my columns inside). Until `limits` exists I use MetroNet platform ranges
  + 12 m.

### GLSL hook (request 5)

When `#metro=1`, every lit built-in material (MeshStandard/Physical/Lambert/Phong, including ones with their own
`onBeforeCompile`, because the patch lives in `THREE.ShaderChunk`) gets, in `lights_pars_begin`:

```glsl
vec3 blUnderWorld(vec3 viewPos);   // view -> world position (undoes the earth-curve bend of 00_util.js)
vec4 blUnder(vec3 worldPos);       // x: inside an underground volume (0..1), y: daylight (0..1), z: ambient, w: 0
```

and at the top of `lights_fragment_begin` the locals `vec3 blUW` (world position) and `vec4 blU = blUnder(blUW)`, so
code appended after `#include <lights_fragment_begin>` can use them. The patch multiplies directional lights (sun,
moon), hemisphere, ambient/probe and IBL (diffuse and specular) by the daylight factor, and adds
`blU.z * UNDER_TINT` (neutral ~4000 K) to the indirect diffuse (and a little to the specular so metal isn't black).
Point/spot lights and emissive are untouched. Outside any cell, `blU = (0, 1, 0, 0)` and nothing changes.
(M2, request 6: `Under.addLights(cellId, [{ a, b, color, intensity, radius }])`, the nearest ~8-12 line lights
evaluated in the shared patch for fragments inside volumes: accepted, send the GLSL; I'll wire the uniform plumbing.)

### Exposure underground (request 4)

`Env.state.exposure` blends by `Under.state.depth` to a fixed **1.0** (same day and night); eye adaptation may lift
up to **×4 (2 EV)** underground (outdoors it stays 2.1 by day, 1.3 at night) and never darkens more than today. The AE
key is unchanged (0.1): a view whose centre-weighted log-average luminance is ~0.1 at exposure 1.0 (a platform with
albedo ~0.35 under ~0.9 units of irradiance) needs no adaptation. Street daylight seen from an entrance blows out.

### Third rail (contact rail) for TRAINS / SIM: `MetroTrack.thirdRail`, `MetroTrack.thirdRuns`

Exact values as built (research: BART Facilities Standards, see "Track, third rail" below). All offsets are in the
track's **banked** frame (`MetroTrack.frameAt(R, s)` / `MetroNet.frame(id, s)`: `rx,ry,rz` right, `ux,uy,uz` up),
measured from the track centreline at top-of-rail height:

| quantity | value |
|---|---|
| contact surface height above top of running rail | **+0.171 m** (6 3/4 in), top contact |
| contact rail centreline from the track centreline | **1.499 m** (4 ft 11 in; 0.660 m from the near gauge line) |
| contact rail head width | 0.076 m (the shoe's contact band: 1.461-1.537 m) |
| coverboard | underside +0.239 m, top +0.263 m above top of rail; spans 1.339 m (track side) to 1.630 m, where it turns down to +0.181 m |
| gaps | the rail stops 1.5 m short of every side change and every point where it would foul another track (turnouts, crossovers) and 14 m before track ends |
| end ramps | the last 3.5 m of every piece at a gap drop linearly by **76 mm** (to +0.095 m at the very end) |
| side | per piece, see below; **no contact rail on eBART** (standard gauge 1.435 m, DMUs) |

Side rule (the data's M2 third-rail plane, corrected in stations): in a station (and 60 m beyond each platform end)
the rail is on the side **away from the platform as STATIONS build it** (side platforms: between the tracks; islands:
outside); elsewhere the data's per-sample side (the field side of a double track, i.e. away from the other track);
without the plane, the same rules computed here. So at a side-platform station (West Oakland, Fruitvale, San Leandro,
Hayward, Walnut Creek, Pleasant Hill, El Cerrito, Union City, Milpitas ...) the rail changes sides twice, with a gap.

```js
MetroTrack.thirdRail(trackId, s)  // -> { side: +1 | -1, lat: ±1.499, top: 0.171 (less on an end ramp) } | null (no rail at s)
                                  //    side/lat: + = right of the track facing +s (a train running toward -s: flip)
MetroTrack.thirdRuns(trackId, s0, s1)   // -> [{ s0, s1, side, lat, top, rampA, rampB }] the rail pieces in [s0, s1];
                                  //    rampA / rampB: where the start ramp reaches full height / the end ramp begins (or null)
```
`thirdRail` costs ~2 µs (fine per shoe per frame). It is exactly what is drawn (one definition for the rail, its
insulators and these calls). Real BART cars carry a shoe on **both sides of both trucks** (4 per car) because the rail
changes sides: keep both, put the shoe that is over the rail on its contact surface, and let the other hang free a
little lower than the ramp ends (~+0.09 m) so the 76 mm ramps lift it on. Envelope for the shoe gear: paddle within
lat 1.43-1.57 m and below +0.239 m where it runs under the coverboard; nothing beyond 1.63 m below +0.19 m.

## Research: BART infrastructure facts (dimensions, sources, assumptions)

Sources: [NTSB] NTSB RAR-79-05 (1979 Transbay Tube fire report, Fig. 3 "Typical Section", App. B); [FM] BART Fire
Manual rev. 2016; [BFS] BART Facilities Standards; [W] Wikipedia; Geolith "Engineering Geology of BART 1964-75"
(snippets); FoundSF; SFMTA; ENR. Published figures don't reach cm accuracy: plan/profile come from MetroNet.

### Tunnels
- **Transbay Tube**: 57 steel-shell reinforced-concrete sections, 83-102 m (avg ~100 m); outside 14.63 x 7.32 m;
  immersed tube 19,113 ft (5.83 km) between the SF and Oakland ventilation structures; trench 18.3 m wide on 0.61 m
  gravel, 23-41 m below the water surface (max 41 m); not straight (36 straight sections, 15 curved in plan, 4 vertical,
  2 both); grades 3 % max, 0.3 % min [W, FM, Geolith].
  Section [NTSB Fig. 3]: bore ID **5.18 m** (17'0"); track centreline **0.20 m toward the outer wall** from the bore
  centre; **track centres 8.03 m** apart (bore centres 7.62 m); lining ~0.69 m; central gallery 2.44 m wide = exactly
  the gap between the two bore circles; upper gallery (exhaust duct) 2.30 m, lower gallery (walkway, carts,
  substations) 2.74 m; **walkway 0.76 m wide on the gallery side, top 0.71 m above rail**; third rail on the **outer**
  side (4x4 in steel/aluminium I-beam) on porcelain insulators every 3.05 m under a fibreglass cover board; 119 lb
  rail on direct fixation every 0.91 m. Gallery doors: 56 per bore, ~100 m apart (one per section), push-bar from the
  track side; exhaust dampers (1.83 x 0.91 m) above every third door. Fluorescent fixtures every 15.2 m (1979),
  being replaced by LEDs every 7.6 m (2025-26); bare concrete, grimy with brake dust. Seismic retrofit (2017-24): steel
  liner plates welded into 15 of the 57 sections.
  Ends: SF vent structure (caisson 37 x 21 m, 33 m high, ~137 m off the Ferry Building at Pier 2, tracks at -25.9 m),
  twin compressed-air bores to Embarcadero; Oakland vent/transition structure on 7th St in the Port, then ~1.08 km of
  box to the Oakland portal (MP 2.67, ASSUMPTION near 7th St & Maritime St) and the West Oakland aerial.
- **Standard BART bore**: 17 ft ID (5.18 m). **Market St**: twin tubes under Muni's twin tubes; **bolted steel rings
  0.76 m wide** (6 segments + key, flanged, grouted); Civic Center-16th St bored at 5.49 m (Calweld machines).
- **Berkeley Hills Tunnel**: twin bores 5.0-5.1 km, **15.2 m** between centres, finished diameter **5.33 m**
  (horseshoe: W8x40 steel sets every 1.22 m + concrete lining, drill-and-blast 1965-67), grade ~1.2-1.5 % rising to
  Orinda; the Hayward Fault ~300 m inside the west portal (creep narrows the bore); cross passages every 305 m;
  walkway one side; LED fixtures (2018) mostly here; west portal 37°51'05"N 122°14'17"W beside Chabot Rd at SR-24/SR-13,
  east portal ~0.5 km SW of Orinda station, essentially straight.
- **Oakland Wye**: under Broadway & 9th, seven interlinked tunnels at different levels (-6 m at the portals to -27 m at
  the lower platforms of 12th/19th St). Portals: M line near Washington & 5th, A line at 5th Ave & E 8th St, C line at
  23rd St & Northgate.
- **Cut-and-cover** (SFO/Millbrae): two cells ~**4.7 m wide x 5.3 m high** with a centre wall, ~11.5 m outside;
  cross passages every 76-91 m (sliding doors onto the other track); Colma portal at +47 m. Warm Springs: 2.0 km box
  under Fremont Central Park / Lake Elizabeth. Berryessa: 3.96 km retained cut + 244 m cut-and-cover; Dixon Landing
  retained cut 671 m long, ~6.7 m deep. Berkeley subway: cut-and-cover ~5 km.
- **Subway fittings**: continuous walkway on one side (a covered cable trough with hinged covers); cross-passage doors
  nominally every 305 m; **blue-light stations** (grey box under a blue lamp: phone, third-rail cut-off) at most 305 m
  apart; **milepost plates** blue with white numbers, 0.66 m tall, every 32.2 m underground (0.1 mi outdoors);
  standpipe hose outlets every 76-91 m (blue dot on the walkway, blue reflector opposite).
- **Portals** (ASSUMPTION): concrete U-section boat section rising 0 → 6-7 m over 150-250 m, then a board-formed
  headwall at the box entrance with fencing along the top.
- **Stations**: platforms 213.4 m + 2.4 m transitions; end walls ≥ 2.03 m from the track centre; Market St boxes 18.3 m
  wide (Embarcadero 15.2 m); aerial platforms ~9 m above grade.

### Track, third rail, aerials, open-air structures
Sources: [BFS] BART Facilities Standards R3.2 spec sections (34 05 17, 34 11 25/27/31/33/37/93, 34 24 13, 32 31 13);
[CLEMONS] R.E. Clemons (Bechtel), "Continuous-Welded Rail on BART Aerial Structures", TRR 1071 (1986); [FIRE] BART Fire
Manual 2016; [WSX] Warm Springs Extension SEIR ch. 2 (2003, PB typical sections); [FLOR] Fremont Line Operability
Retrofit IS/MND (2012); [TRID] A-Line North aerial retrofit abstract; [IJ] Interface Journal; [W] Wikipedia.
- **Track**: gauge 66 in (1,676 mm), gauge line 838 mm from the centreline; **119RE** CWR (h 173.0, base 139.7, head
  67.5, web 14.3, head depth 47.6 mm); rails canted **1:40** inward. Track centres **4.267 m** (14 ft) mainline, aerials,
  crossovers; **5.49 m** in twin-cell cut-and-cover and portals, **2.01 m** from track centreline to the (near) wall.
  45 % ballasted, 28 % aerial DF, 27 % subway DF.
- **Platforms**: edge 1.616 m from the track centreline, top 0.991 m above rail; islands 28-32 ft wide.
- **Direct fixation**: original aerials: Landis fasteners at **914 mm** on a continuous plinth **787 mm wide**
  (89-216 mm thick in a 76 mm recess); current standard 610-762 mm spacing, footprint ~380 x 190 mm, ≤ 100 mm high,
  plinth top canted 1:40. Top of rail ~0.29 m above the aerial deck.
- **Ballasted**: concrete ties at **762 mm**, ~3.05 m long, cast-iron shoulders + spring clips; each tie has a contact-rail
  bracket insert at one end, alternating ends tie to tie; ballast 305 mm under the tie, shoulder 305 mm (457 on curves
  ≤ 2,000 ft), side slope **2:1**, top at ~tie top; subballast 152 mm; a 0.76 m paved walkway beside the track.
- **Third rail**: 1,000 V DC, top contact, 4 shoes per car; centre **1.499 m** from the track centreline (660 mm from
  the near gauge line), **contact surface 171 mm above top of running rail**; steel I-beam with aluminium sides or
  stainless-capped aluminium, 9.14 m lengths; **light-grey porcelain insulators** (229 mm; 152 at dips/ramps) every
  **3.05 m**; **light-grey fibreglass coverboard** (ANSI 70), brackets ≤ 1.83 m; dip sections/ramps 76 mm lower;
  gaps < 55 ft bridged by the shoes; side: away from the platform at stations, alternating at grade, the outer edges
  on aerials (walkway between the tracks). (Modelled: the data's per-sample side, field side between stations; it
  changes sides at side-platform stations; no surveyed side data exists.)
- **Aerials, original (1968-72)**: **two precast post-tensioned trapezoidal box girders, one per track, 14 ft apart,
  each 1.22 m deep with a 3.556 m deck** (0.71 m gap between the decks), drainage channel on each girder centreline;
  simple spans 21.3-22.9 m (55-145 ft, avg 75 ft); **single 1.52 m hexagonal column with a T / hammerhead cap**
  (ASSUMPTION ~7 m x 1.5 m), heights 4.9-12.2 m (avg 9.1 m); elastomeric bearings, a deck joint at every pier; no
  parapets; ~90 % this type (others: straddle, two-column and C bents, pier walls). Seismic retrofit: steel column
  jackets 1.8-2.4 m diameter or fibre wrap, shear keys, seat extenders. Crossovers on aerials: special girders 6 in
  lower with timber ties. Aerial walkway: sunken between the tracks (~0.25 m below the deck, ~0.7 m wide), no handrail.
- **Later aerials**: Dublin/Pleasanton (1997) cast-in-place post-tensioned box girders; Warm Springs (2017) Paseo Padre:
  one 9.75 m four-cell box for both tracks on a two-column bent, U-trough bridges at Walnut Ave; Berryessa (2020):
  half in trenches up to 9 m deep, short aerials ≤ 5 m, the station aerial ~10.7 m up; SFO (2003) elevated station
  and wye; Pittsburg/Bay Point (1996) at grade in the SR-4 median.
- **Fences**: 2.13 m chain link (25 mm mesh, No. 9 galvanised) + 3 barbed strands = 2.44 m; yards 3.05 m; all at-grade
  track fenced. Freeway medians (ASSUMPTION): ballasted, Caltrans barriers 0.81-0.91 m + the fence, ~10 m trackway.
- **Turnouts**: No. 10 crossovers at 14 ft centres, rail-bound manganese frogs, 19'6" switch points, guard-rail
  flangeway 1-7/8 in, Alstom GM4000A switch machines; yards No. 8/10.
- **Train control**: cab signalling (no lineside block signals); train-control bungalows 12.5 x 7.8 m; mileposts blue
  with white text, 0.66 m tall, every 161 m outdoors and 32 m underground. Cross-passage doors and third-rail cut-off
  switches **yellow**. Concrete unpainted grey.

### Modelling choices from this (infra)
- Walkway on the **inner** side (toward the other track: gallery doors, cross passages), third rail on the **outer**
  side (field side) outside stations; in stations the third rail is on the side away from the platform.
- Bore profiles: circular 5.18 m (SF/Oakland/Tube, steel rings on Market St), horseshoe 5.33 m (Berkeley Hills),
  box cells 4.7 x 5.3 m (cut-and-cover). Lights: fluorescent every 15.24 m (Tube, SF/Oakland subways), LED every 7.62 m
  (Berkeley Hills).

## Costs (High tier, 1600x900, M2; GPU timings are noisy: six workstreams share the GPU)

| view | metro=0 | metro=1 | notes |
|---|---|---|---|
| West Oakland street level, looking along the aerial | 199 calls, scene 1.9 ms | 300 calls (+101), scene 3.3 ms | body 38, detail 9, far 31 chunks visible; before the layer refactor it was +116 (far 92) |
| Fruitvale aerial from 450 m | — | 160 calls total, 0.74 M tris | far layer: 123 pieces, cheap |
| Transbay Tube interior | (n/a) | 25 calls, 0.31 M tris | outdoor world culled by portal visibility |
| Berkeley Hills tunnel | (n/a) | 49 calls | |
| EMBR platform (with stations) | (n/a) | 40 calls | |

Build: jobs ≤ 3.2 ms per frame. Next: merge body chunks of paired tracks further, measure with a quiet GPU.

## Verified views (2026-09-26 05:30, High unless noted; shots in `notes/bart/shots/infra/`)

Transbay Tube (day, night, Low, Ultra), Embarcadero approach bore, Mission St bore + double-crossover chamber,
Embarcadero crossover chamber, Berkeley Hills tunnel, West Oakland aerial (deck, underside, street, night) and the
aerial → portal → box → Tube transition, Oakland Wye (usable; a gap remains at one box end), Orinda SR-24 median (day,
night), Pittsburg SR-4 median, Walnut Creek aerial, Fruitvale–Coliseum aerial from the air, Warm Springs at grade,
Milpitas portal approach, Berryessa (modern single-box aerial), Daly City crossovers, Millbrae beside the Caltrain
catenary, Concord at grade with the ROW fence, MacArthur median (5:30 PM), EMBR/MONT/12TH/19TH/GLEN platforms.

## Preview / QA

- In game (dev server on my worktree): `http://localhost:8134/infra.html#auto&metro=1&t=12:00&ll=...`; then
  `__bayline.MetroTrack.shot('M1.1', 8000, 0.3, 2.3, { ds: 60, lat: 0, up: 1.5 })` puts the camera on a track (works
  underground); `shotG(id, s, lat, h, target)` h m above the ground; `shot([x, y, z], null, 0, 0, [tx, ty, tz])` world. `__bayline.Under.state`, `.stats`, `.debug.sample(x, z)`; `__bayline.MetroTrack.stats`.
- Good spots: M1.1 s 1300 (West Oakland aerial), 3150 → 3485 (aerial → portal → box), 8000 (Tube); C1 5200 (Berkeley
  Hills tunnel); M1.1 14000 (Mission St bore); A1.1 7000 (Fruitvale–Coliseum aerial).
- Shots: `notes/bart/shots/infra/`.

## Open problems

- v0 data: the Tube tracks are 5.0 m apart (real 8.03 m), cut-and-cover pairs ~5.0 m (real 5.49 m), Berkeley Hills
  bores ~20 m (real 15.2 m); the tube run is 3.4 km (real 5.83 km immersed + 1.08 km Oakland box + 0.45 km SF bores);
  aerial/portal profiles are rough (e.g. 10 m drops over 80 m at the West Oakland portal) — builders adapt, but
  accuracy follows the data.
- Junctions: tracks overlap at turnouts/crossovers (no switch points, frogs or guard rails yet); third rail stops
  14 m before track ends. Next milestone.
- The Oakland Wye / tunnel junctions: diverging tunnels intersect each other's linings.
- Terrain cuts are rasterised at 1 m (0.5-1 m jaggies at cut edges, mostly under my skirts/walls); a finer cut level
  near the camera is planned.
- Freeway medians are typed `grade` in v0 (no barriers yet except where data says `median`).

## Requests for other workstreams

- **DATA**: (1) Transbay Tube track centres **8.03 m** (NTSB Fig. 3), twin-cell cut-and-cover and portals **5.49 m**
  (WSX), Berkeley Hills bores **15.2 m**; (2) the Tube's extent: SF vent structure (~137 m off the Ferry Building) to
  the Oakland vent structure on 7th St (5.83 km), then ~1.08 km of box to the Oakland portal (MP 2.67, ~7th &
  Maritime), the SF end as twin bores to Embarcadero; (3) consistent platform s-ranges on both faces of island
  platforms (I normalise like STATIONS meanwhile); (4) `median` for SR-24 / I-580 / SR-4 / I-980 sections; (5) if
  possible a per-sample third-rail side (BART alternates it at grade).
- **WORLD**: carve the terrain to the bed where BART is at grade / in trenches (I cut the terrain at runtime with
  `Under.addCut` meanwhile; carving removes the need and the edge jaggies); please keep lidar (h9) weight at 0 under
  the bed like the Peninsula line.
- **STATIONS**: (a) your cells work; Under now keeps your `metrostations` root drawing when the outdoors is culled
  (no `Under.keep` needed, but it doesn't hurt); (b) my tunnel ends add `'auto'` portals probing 3 m into your box
  at TOR + 1.5 m, so make `st:<ID>:plat` cover the trackway up to the box ends; (c) `ambient` accepted as a number or
  `[r, g, b]`.
- **WORLD (observation, 05:30)**: near BART the road traffic floats ~1 m above the road surface (Walnut Creek beside
  the aerial; the road crossing over the West Oakland portal box) — probably traffic lanes computed before MetroGround's
  carve re-shaped `hBase`, or roads crossing carved trenches (they need a deck there, the ground under them is cut).
  Shots: `notes/bart/shots/infra/woak_portal_night.jpg`.
- **TRAINS (06:10)**: collector shoes: contact surface **+0.171 m** above top of rail (not 0.19), contact rail centre
  **1.499 m** from the track centreline (not 1.45); shoes on both sides of every truck are right (4 per car). Side per
  segment: `MetroTrack.thirdRail(id, s)` / `thirdRuns(id, s0, s1)` (section "Third rail" above). eBART units: no shoes.
- **DATA (06:10)**: the M2 platform `side` fields point toward the other track at the stations your curated `layout`
  calls `side` (West Oakland: M1.1 and M2 both `left`, so both faces sit between tracks 4.2 m apart), and the third-rail
  plane follows them (rail under the platform edges). STATIONS correct the sides from the layout, and so do I for the
  contact rail within stations; please flip the sides (and the plane) there so everyone reads the same answer.
- **TRAINS / SIM**: metro trains in tunnels are lit by the under map's ambient only (tunnel fixtures light my own
  geometry); `Under.keep(car.group)` is already in 46_metrosim.js, good.
