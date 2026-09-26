# Bayline Metro: INFRA workstream status

Owner: infra workstream. Branch `bart-infra`, worktree `.worktrees/bart-infra`, dev port 8134.
Files owned: `src/js/23_metrotrack.js`, `src/js/24_metro*.js`, `preview/metrotrack.html`, `notes/bart/infra.md`,
`notes/bart/shots/infra/`, plus small, clearly marked hooks in `10_env.js`, `12_terrain.js`, `13_gfx.js`, `14_post.js`,
`90_main.js` (underground support). Everything is behind `#metro=1`.

## Status

- 2026-09-26 00:40: started. Read the engine (env, terrain, post, trackgeo, main loop). Research running.

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
  // after my tunnel); unresolved 'auto' portals count as outdoors (safe: nothing is culled through them).
Under.addCut({ id, poly: [[x, z], ...], below: y })   // terrain above y inside poly is not drawn (request 7: `below` =
  // the well/trench floor; up to 256 vertices; no limit on the count, 64 alive at once is fine)
Under.remove(id)          // a cell (and every portal that names it), a portal or a cut
Under.cellAt(x, y, z)     // -> id | null (request 2): the cell whose poly contains (x, z) with floor <= y <= ceil
Under.keep(obj)           // top-level objects that must keep drawing while the outdoor world is culled (metro trains)
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

### Modelling choices from this (infra)
- Walkway on the **inner** side (toward the other track: gallery doors, cross passages), third rail on the **outer**
  side (field side) outside stations; in stations the third rail is on the side away from the platform.
- Bore profiles: circular 5.18 m (SF/Oakland/Tube, steel rings on Market St), horseshoe 5.33 m (Berkeley Hills),
  box cells 4.7 x 5.3 m (cut-and-cover). Lights: fluorescent every 15.24 m (Tube, SF/Oakland subways), LED every 7.62 m
  (Berkeley Hills).

## Costs

(to be measured: High tier, same views with `metro=0` vs `metro=1`)

## Preview

(to come) `preview/metrotrack.html`, in-game `#auto&metro=1&...`

## Open problems

## Requests for other workstreams

- DATA: per-segment structure types and portal positions (tunnel=yes spans from OSM), the Transbay Tube profile,
  a `side` for the third rail if known (else I derive it: BART's contact rail is on the side away from platforms).
- WORLD: where BART runs at grade or in trenches, the terrain should be carved to the bed (like the Peninsula
  carve); until then I cut the terrain at runtime (Under.addCut) and build retaining walls/embankments to meet it.
