# Bayline Metro: STATIONS workstream status

Owner: stations workstream (branch `bart-stations`, worktree `.worktrees/bart-stations`, dev port 8135).
Files owned: `src/js/26_metrostations.js`, `src/js/27_*.js` (station kit, heroes, signage), `preview/metrostations.html`,
`tools/fetch_metro_stations.py` (station micro-geometry from OSM), `data/pub/v2/metrostations/` (my data),
`notes/bart/stations.md`, `notes/bart/shots/stations/`.

## Status (2026-09-26 03:26 EDT) — M1 done, keep-out zones done, M2 under way

- **Footbridge stations reach the street** (MLBR, WARM, WDUB, PITT, PCTR, ANTC and any `bridge` access above the
  street): the mezzanine now spans the tracks only, and covered walkways (glass, box or blue truss sides per
  station) run from it to the real entrances (MetroNet, GTFS first; one per side of the line, across the freeway at
  the median stations), each ending in a landing tower: two stair flights with a mid landing, a sloped roof, glass
  guards, a glass elevator, the wordmark over the foot; fare gates across each walkway's mouth. The mezzanine sits
  over the main entrance so its walkway leaves square to the line. Walk floors/walls follow (checked with `floorAt`
  along a WDUB landing); walkway supports stand clear of the streets; keep-out kinds `bridge`/`column`/`landing`.
- **Per-vehicle platforms**: eBART (Antioch DMU) and airport people-mover faces use TRAINS' floor heights and widths.

- **Keep-out zones (lead request, 02:10)**: every station's ground-level footprint is a keep-out zone for Towns
  buildings and infill houses, trees, grass, parked cars and moving traffic (API and hooks below). Verified at WOAK,
  FTVL, COLS, MCAR, DALY and SFIA with plan maps (`tools/metro_keepout_map.js`: zones, roads, driven lanes, buildings,
  trees, parked and moving cars) and street-level views: no parked car, tree or building left in a lobby, plaza,
  trackway or against a column (0 of 151–264 buildings, 0 of 49–223 trees, 0 of 1–195 parked cars in a zone), the
  WOAK street-level view of the lead's link now shows the lobby clear (`shots/stations/woak_lobby_street_0807.jpg`).
  Lobbies under aerial decks now move along the station until they and their entrance apron are clear of the streets
  that run under the deck, and bents shift up to 10 m (else drop the column) to span over a street; roads well below
  an embanked trackway (MCAR, 40th St under SR-24) keep their traffic. Bent columns no longer stand inside lobbies
  by accident (the lobby extent was read before it was computed).

- **All 50 stations build** from MetroNet v0 (verified in one session: 12k–89k triangles each, 0.4–1.5 s of
  time-sliced build), by archetype: subway box + concourse above + street entrance shafts; aerial deck on bents +
  lobby below; at grade / freeway median / open trench with footbridges; per-station character for all 50 from
  research (`28_stationheroes.js`, facts in `notes/bart/stations-research.md`): corrected types and side/island
  layouts, canopy style/extent/colours (flat with louvres and clerestories, shed, butterfly, gull-wing, hipped,
  gable, box frame, wave, humps, barrel, open frames, pill), post rows, open-end frames, floors/walls/ceilings,
  subway column rows (Montgomery/Powell stainless, Civic Center black granite, 12th/19th brick), wall bands.
- **Combined build (bart M1 + Under)**: fixed the navy Embarcadero platform (see "Under" below); every subway station
  verified at platform and concourse level (shots in `notes/bart/shots/stations/`). 12TH/19TH have no concourse yet:
  the v0 profile puts them ~7 m under the street (stacked hero waits for the M2 profile).
- Lighting: per-fragment analytic line lights (exact segment irradiance + representative-point GGX) per zone, glossy
  terrazzo/tile reflections of the light troughs, lit 24/7 underground (Under's fixed exposure), canopy lights on by day.
- Crowds sized by real weekday exits (Aug 2026) and time of day; waiting people walk to open metro doors and board.
- Platform displays show the next scheduled trains from the timetable; SIM's `setBoard` rows win for 90 s.

## Preview

- Build `BAYLINE_OUT=dist/stations.html python3 build.py`, serve `python3 tools/devserver.py 8135`, open
  `http://localhost:8135/stations.html#auto&metro=1&t=08:15&ll=37.7892,-122.4016,150,0.8,-0.4` (Montgomery).
- QA camera from the console: `__bayline.MetroStations.shot('MONT', { u: -30, v: 0, h: 1.65, yaw: 0.2, fov: 70 })`
  (u along the platforms from their middle, v to the right, h above the platform top; `cut: 6` = cutaway above that
  height with everything else hidden; `perf: true` = GPU cost and draw calls with/without the stations).
- Many views in one page load: `python3 tools/wd.py 590 node tools/metro_shots.mjs --views views.json --out DIR`.

## APIs (M1, stable)

- `MetroStations.setBoard(stationId, platformCode, rows)`, rows `[{ line, color, dest, cars, min }]` (SIM pushes).
- `MetroStations.floorAt(x, y, z)` / `blocked(x0, z0, x1, z1, y)` (walk mode; SIM's Player uses them).
- `MetroStations.spawnPoint(stationId, platformCode | gtfsId)` → `{ x, y, z, yaw }` (yaw = heading toward the track).
- `MetroStations.limits(stationId)` → `[{ track, s0, s1 }]` (where station structure replaces INFRA's guideway).
- `MetroStations.list / byId / stats / enabled / ready`, `StationCrowds.population(id)`.
- Hooks: MetroStations rides on `Stations.init/update`; inert without `#metro=1`.

### Keep-out zones (2026-09-26)

- `MetroStations.keepOut(x, z, what = 'building', extra = 0, y)` → true inside a station footprint + the margin for
  `what`: `'building' | 'house' | 'tree' | 'lamp' | 'grass' | 'car' | 'road'`; `extra` widens the margin (a road's half
  width); `y` lets a road or car well below an embanked trackway pass under it. ~0.25 µs per query.
- `MetroStations.keepOutAny(x0, z0, x1, z1, what)` → false when no zone can touch the box (skip per-item tests).
- `MetroStations.dropBuilding(b, cx, cz)` → a `Towns.addDrop` filter (registered automatically when Towns has
  `addDrop`): drops an OSM building whose centroid stands in a footprint, whose outline reaches into a lobby,
  trackway or column (or contains one), or with two corners under a deck.
- `MetroStations.keepOutZones(x, z, r)` (QA) → `[{ st, kind, under, pts }]`.
- Zones come from `StationTypes.footprint` (the same `setup()` the builders use: frame, platforms, circulation plan,
  ground plan), made the first time anything asks near a station (~1.5 ms each, all 50 ≈ 75 ms if ever needed) and
  replaced by the built station's exact footprint when it builds (traffic near it re-streams if it moved > 0.5 m).
  Kinds: `deck` (under an aerial deck), `track` (at-grade / trench / median trackway + platforms), `lobby` +
  `plaza` (ground-level lobby and its entrance apron), `column` (bent columns, footbridge supports), `bridge` (under a
  footbridge), `entrance` (subway street entrance shafts with railings and totem).
- Margins (m) per consumer, -1 = the zone does not apply:

  | what | deck | track | lobby | plaza | column | bridge | entrance |
  |---|---|---|---|---|---|---|---|
  | building (OSM) | 1.5 | 2 | 2 | 1 | 0.8 | 1 | -1 |
  | house (infill, at its centre) | 4 | 7 | 8 | 6 | 4 | 4 | 5 |
  | tree | 2.5 | 3 | 3 | 1.5 | 2 | 2 | 1.2 |
  | lamp | 1 | 2 | 2 | 0.5 | 1.5 | 1 | 0.8 |
  | grass | -1 | 0.3 | 0.3 | 0 | 0.3 | -1 | 0.3 |
  | car (parked) | -1 | 2 | 2.5 | 1 | 1.2 | -1 | 1.2 |
  | road (traffic) | -1 | 0.5 | 0.5 | -1 | 0.8 | -1 | -1 |

- **Consumer hooks in shared files** (each one or two lines, all behind `MetroStations.enabled`, so the default path is
  untouched; lead: please review at the next integration):
  - `90_main.js` world `keepOut(x, z, what)`: asks `MetroStations.keepOut(x, z, what || 'house')` first; landmarks
    still keep out houses only (a `what` other than 'house' never consults them).
  - `60_life.js` `createTraffic.setRoads`: `cutRoads()` splits lanes where a road (not motorway/trunk, not a bridge)
    runs through a lobby, column or trackway (sampled every 2 m, road half width as `extra`, road height as `y`);
    curbside and parking-lot cars are skipped inside `'car'` zones.
  - `61_flora.js` `loadTile`: trees skipped inside `'tree'` zones (only for tiles `keepOutAny` says can be touched).
  - `63_ground.js` `rasterRoads`: `'grass'` zones rasterised into the no-grass grid.
  - When the stations become known, whatever was placed before is placed again (`Towns.dispose`, `Flora.dispose`, a
    traffic re-stream) unless MetroGround is about to do the same.
- QA: `tools/metro_keepout_map.js` (plan map; run with `metro_shots.mjs`, `{ "name", "evalFile":
  "tools/metro_keepout_map.js", "args": { "id": "WOAK", "r": 170 } }`), `shot(id, { lobby: -22, gh: 1.7 })` (camera
  measured from the lobby's entrance end, at street level), `{ "name", "wait": 25000 }` + `--hash "mst=WOAK"` (the
  page's own camera, e.g. the lead's link).

## Costs (measured, High, 1600x900, GPU shared with other workstreams' Chromes, so indicative)

| view | +draw calls | +triangles | GPU with / without |
|---|---|---|---|
| Montgomery platform (crowd) | +40 | +0.72 M (incl. people) | +21 % |
| Bay Fair platform | +24 | +0.10 M | +3 % |
| West Oakland platform | +26 | +0.16 M | +24 % |
| Bay Fair from 120 m | +24 | +0.06 M | noisy (to re-measure) |

Next: LOD far silhouettes for aerial stations, shadow casters trimmed, per-station budgets checked at every hero.

## Requests

### To WORLD (Towns) — keep-out, 2026-09-26

1. **`Towns.addDrop` on bart**: I register `MetroStations.dropBuilding` with it when it exists (verified locally with
   your `ebc0f5d` patch applied, not committed: the OSM station outline around West Oakland's lobby goes away;
   together with your MetroGround `train_station` rule). Until it reaches bart, OSM buildings in footprints stay.
2. **Street lamps and fallback trees**: Towns places them without asking `ctx.keepOut`; lamps under a deck or in a
   lobby apron are possible. Proposal (two lines in `buildGnd`): skip a lamp when
   `ctx.keepOut && ctx.keepOut(T.ox + x, T.oz + z, 'lamp')`, a fallback tree when `... 'tree')`. `90_main.js`'s
   `keepOut(x, z, what)` already forwards `what` to the stations and applies landmarks to houses only, so the default
   path stays exactly as today.
3. Daly City: two long thin OSM polygons beside the deck (bus-bay canopies?) are drawn as solid ~3 m boxes; if they are
   canopies, your MetroGround canopy rule may want them (they are outside my deck footprint, so I keep them).

### To DATA — keep-out, 2026-09-26

- **Road crossings** in MetroNet (streets passing under / over each track: s, width, class, clearance), as your
  `profile2.py` already finds them for `ROAD_CLEAR`: lobbies and bents are placed clear of streets from Towns roads at
  build time today (decoded tiles only); a deterministic source would make footprints identical before and after a
  build (and help INFRA's guideway piers).

### To INFRA — keep-out, 2026-09-26

- Guideway piers stand in streets the same way my bents did (e.g. SFIA's approach, and piers under station decks at
  the station ends); my bents now shift up to 10 m along the deck to span over a street (`StationTypes` `bentPlan`,
  `roadAt`), the same rule may suit the guideway. Station footprints are queryable (`keepOutZones`) if you want your
  piers kept out of lobbies.

### To INFRA: Under — the Embarcadero fix (agreed contract, 03:10)

What was wrong (all on my side): my whole stations group is a top-level scene object, so `Under.preRender` hid it
underground (and my cells' groups inside it); I also passed `ambient` as an RGB array. Now:
- `Under.keep(MetroStations.group)`; each underground level is a cell whose `group` holds that level's structure AND
  its near-only detail (signs, boards, escalator steps, furniture), so portal visibility is exact per level.
- Aerial/at-grade stations (no cells) are registered with `Under.outdoor(root)` (hidden with the outdoor world).
- Cells: `st:<ID>:plat`, `st:<ID>:conc`, `st:<ID>:ent<k>` (street shafts, `daylight: [concourse floor, street]`);
  portals: wells plat↔conc (horizontal, at the concourse floor), shaft↔conc (horizontal at the concourse roof for
  in-box shafts, vertical at the wall door for side passages), shaft↔outdoors (horizontal at the street); cuts over
  every shaft. `ambient` = 1.6 x the luminance of the style's fill (~0.65); my own fill is off when Under runs.
- Exposure: with Under I no longer compensate (your fixed 1.0 underground); fixtures are calibrated for it.
- **Request (your M2 item 6, accepted):** `Under.addLights`: people and trains in stations are lit only by the cell
  ambient today, so they read as silhouettes against my lit surfaces. The GLSL is `StationKit.LIGHT_GLSL`
  (`skLineE(P, N, A, B)` = exact clipped segment irradiance per unit intensity; `skLines(...)` = diffuse + GGX with the
  representative point); inputs are view-space endpoints (`uLA/uLB` xyz, w = range/radius), colour (`uLC`), facing
  (`uLD`). I will call `Under.addLights(cellId, lights)` with my per-zone lists (world coords) as soon as it exists.

### (history) INFRA requests of 00:45

Plan on my side: every subway station registers one cell per level (`st:<ID>:plat`, `st:<ID>:muni` where Muni Metro
shares the box, `st:<ID>:conc`, and `st:<ID>:ent<k>` per street entrance shaft), portals at every stair/escalator/
elevator opening between levels (horizontal quads in the slab, or the vertical quad at the foot of a run), a portal
to `null` plus an `addCut` for every street entrance, and each cell's `group` = that level's meshes. Cells are added
when a station builds (≤ 1.5 km) and removed with `Under.remove` when it is dropped. Requests:

1. **Stacked cells.** Levels overlap in plan (Market St: concourse over Muni over BART; 12th/19th St: two platform
   levels). Please make sure cells with overlapping `poly`s and disjoint `[floor, ceil]` are fine in the "under map"
   (i.e. store y-intervals, or treat everything between the lowest floor and the surface above as underground) and in
   `Under.state.cell` (pick the cell whose `[floor, ceil]` contains the camera).
2. **`Under.cellAt(x, y, z)`** (-> id | null) and a naming rule, so a tunnel end can find the station cell it meets
   (or you add the tunnel-to-station portals yourself: station cells are named `st:<ID>:plat`; the station box ends
   at the platform ends + 12 m, open to the full tunnel cross-section; I will report exact end-wall s per station).
3. **Daylight gradient in entrance shafts.** A stair from the street down to the concourse is lit by the sky at the
   top and not at the bottom. Proposal: `addCell({ ..., daylight: [yBottom, yTop] })` (daylight scales linearly from 1
   at yTop to 0 at yBottom inside that cell), or derive it from the `day` of its outdoor portal plus depth.
4. **Exposure underground.** Real interiors are ~1/300 of daylight; the post's eye adaptation only lifts 1.1 EV.
   Proposal: while `Under.state.cell` is set, blend `Env.state.exposure` (by `depth`) to a fixed interior exposure
   (say 1.0, the same day and night), and let the adaptation boost a little more (≤ ~2 EV). Please document the value:
   my fixtures are calibrated so a lit platform floor reaches the AE key at that exposure (lit 24/7, identical at noon
   and midnight). Through an entrance, the street should then blow out like a real camera.
5. **Ambient vs station lights.** I pass `ambient` = the average bounce light of the station's fixtures (so trains,
   people and anything else in the cell pick it up). My own station materials add the *direct* light of the fixtures
   themselves (per-fragment analytic line lights with GGX specular: the long fluorescent/LED runs reflect in terrazzo
   floors and train sides). Please document the GLSL hook your lighting patch uses (e.g. an include + a function
   `blUnder(worldPos) -> { daylight, ambient }`) so custom materials can call it, and make sure it also applies to
   MeshStandardMaterials that have their own `onBeforeCompile` (mine chain onto yours; I will not replace
   `lights_fragment_begin` wholesale, only append after it).
6. **(M2, optional) cell line lights.** `Under.addLights(cellId, [{ a: [x,y,z], b: [x,y,z], color: [r,g,b], intensity,
   radius }])`: if the shared lighting patch evaluated the ~8-12 nearest line lights for *every* standard material
   while underground (not only mine), trains standing in a station would get the platform lights' highlights on their
   bodies and windows. I can supply the GLSL (representative-point line light, Lambert + GGX, smooth range falloff).
7. **Cuts that are not holes to the core.** Some cuts are the open well of a trench station (Glen Park light well,
   Balboa Park/Colma/Daly City open cuts) with retaining walls I build; `below` = the well's floor is exactly what I
   need. Please keep cut polygons ≤ ~64 vertices working and allow ~20-40 cuts alive at once (downtown SF: 4 stations
   x 4-8 entrances within 1.5 km).
8. **Portal quads for escalator wells** may be sloped or horizontal; please accept any planar quad (or give the
   winding/orientation rule).
9. **Interface at the station ends** (to agree): inside the station limits (platform ends + ~12 m) I build the
   station box/aerial deck/trackway slab (the undercar trench between the rails, the under-platform refuge recess, the
   walls, the trackbed), you build the rails, third rail with coverboard, fastenings and anything continuous through
   the station; outside the limits everything is yours. For aerial stations I build the station deck and its bents
   between the limits; your box girders end on my end bents. I will publish the limits per station in
   `MetroStations.limits(id) -> [{ track, s0, s1 }]`.

### To DATA (network.json v0 → M2)

0. **(2026-09-26) Pittsburg/Bay Point transfer platform (`PITT-T`)**: one island serves BART (`CT`, floor 0.991) and
   the DMU (`ET`, sill 0.635), so the real eBART track there is raised 1–1.5 ft (research). In v0 both rails are at
   34.22 m: please raise `ET` along the platform by **0.356 m** (the island then has one walking surface; today I
   average, so each face is 0.18 m off). Also Antioch (`ANTC`) is an island (128 x 8.5 m) with trains on both faces;
   the data has one face (`E1`, left).

1. **Platform height**: please use **0.991 m** above top of rail (trains confirmed; the spec's A1 says 1.02 m).
2. **Known depths / heights** (research, mostly the 1966–68 contract drawings; street = 0, values are top of rail):
   MONT -18.6 (drawing: mezz -6.4, Muni -11.6, BART floor -17.6); POWL ~-18.2; CIVC ~-19.8; EMBR ~-19..-21 (descending
   toward the Tube); 16TH and 24TH -13.1; GLEN -11.6 (below the headhouse plaza, ~5 m under Diamond St); BALB ~-11
   (below Geneva Ave); LAKE ~-14; 12TH/19TH upper island ~-17, lower side platform ~-27 (OFD manual: ~90 ft);
   DBRK ~-11; ASHB ~-11 (below Adeline St); NBRK ~-7; SSAN ~-10; SBRN ~-9; MLPT ~-7.5; NCON ~-9; PCTR ~-8.
   Aerial platforms above ground: CONC +6.96 (measured), BERY +10.7, ROCK ~+10 (over College Ave), ORIN ~+10 (over
   Camino Pablo), SFIA ~+9–10, most 1970s aerials ~+7, embankment stations (SHAY, UCTY, FRMT) ~+4–5.5.
   The v0 profile has most subway stations 8–10 m below the street; the stations adapt (concourse compressed or
   omitted), but the Market Street stations need the real ~18–20 m to fit the Muni level.
3. **Platform s-ranges on paired tracks disagree** (16TH: M2's range sits ~150 m from M1.1's; FTVL, ...). I normalise:
   an island takes one 213 m range; a face that is short or > 40 m off the first face takes the first face's range.
4. **Types** (from research; I override until the data has them): median ROCK ORIN LAFY MCAR CAST WDUB DUBL PITT PCTR
   ANTC; trench BALB COLM SBRN MLPT NCON; aerial DALY SFIA OAKL SHAY UCTY FRMT (the last three on embankment);
   surface MLBR WARM RICH. Layouts: side platforms at FTVL WOAK SANL HAYW SHAY UCTY PHIL WCRK PLZA DELN MLPT; 3 tracks at
   DALY (island + west side), COLM (island + unused side), SFIA (3 dead-end tracks, 2 islands); 4 tracks, 2 islands at
   MCAR; stacked 12TH/19TH (upper island C1/CX, lower side platform C2).

### To TRAINS

- Confirmed (2026-09-26): platform top 0.991 m, edge 1.676 m; door centres 0, ±5.42 m per 21.336 m car. Locked in.
- **Antioch DMU and the airport people mover (2026-09-26, done)**: platforms are built per vehicle from the track's
  system (`MetroNet` track `sys`): eBART faces 0.635 m above the rail with the edge 1.549 m from the track centre (your
  half width 1.473 + the BART gap of 76 mm); people-mover faces 0.36 m, edge 1.35 m (half width 1.30 + 50 mm, platform
  screen doors); BART 0.991 / 1.676 as before. `MetroStations.VEH` holds the table; `spawnPoint` returns the right
  height. **Research differs**: Pittsburg Center and Antioch platforms are "2 ft" high (0.61 m, research B, eBART
  design notes), 25 mm below your assumed 0.635 m sill; I use your 0.635 (a 25 mm step up is within the ADA
  tolerance), tell me if you move the sill. No research value for the people mover's floor (Oakland Airport has
  platform screen doors, so the station is built to your 0.36).

### To SIM

- Walk mode needs a y-aware ground query in stations with several levels (the terrain above a subway station is
  higher than its floors). Proposed hook (55_player.js `groundAt` and `moveWalk`): if
  `MetroStations.floorAt(x, walk.y, z)` returns a number, use it instead of the terrain/platform height, and refuse a
  step when `MetroStations.blocked(x0, z0, x1, z1, walk.y)` is true. Exact patch to follow with M1.
- Departure boards: `MetroStations.setBoard(stationId, platformKey, rows)`; I will list the platform keys per station.

## Assumptions (to verify)

- Platform length 700 ft (213.4 m) + 8 ft (2.44 m) end transition zones; escalators 48 in (1.22 m) nominal, 30°,
  3 flat steps top and bottom, 100 fpm (0.51 m/s); public stairs ≥ 5'6", risers 6¾ in / treads 12 in; handrails
  2'10"; ceilings ≥ 10 ft; TVMs 3'4" x 2'10⅝" x 6'6" at 4 ft centres; bins ~70 ft apart on platforms; cantilevered
  platform edge over an under-platform refuge; a depressed undercar trench between the rails along the platform
  (BART Facilities Standards R3.0, Architecture – Passenger Stations, 2013).
