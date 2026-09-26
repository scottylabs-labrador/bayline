# Bayline Metro: STATIONS workstream status

Owner: stations workstream (branch `bart-stations`, worktree `.worktrees/bart-stations`, dev port 8135).
Files owned: `src/js/26_metrostations.js`, `src/js/27_*.js` (station kit, heroes, signage), `preview/metrostations.html`,
`tools/fetch_metro_stations.py` (station micro-geometry from OSM), `data/pub/v2/metrostations/` (my data),
`notes/bart/stations.md`, `notes/bart/shots/stations/`.

## Status (2026-09-26 00:45)

- Started. Codebase read (25_stations, 30_towns, 60_life, 55_player, 90_main, env/gfx/post). Station research for all
  50 stations running (web). Station micro-geometry (stairs, escalators, elevators, entrances, canopies/roofs,
  footbridges, fare gates) being fetched from OSM for all stations (`data/raw/metrostations/`).
- Next: the parametric kit + lighting model in a preview, then MetroNet integration as soon as the data spec lands.

## Planned public API (draft; finalised at M1)

- `MetroStations.init()`, `MetroStations.update(dt, camPos)`: streaming build per station (≤ 1.5 km), time-sliced.
- `MetroStations.setBoard(stationId, platformKey, rows)`: live departures for the platform next-train displays
  (SIM writes; `rows = [{ line: 'yellow', dest: 'SFO / Millbrae', cars: 10, min: 3 }, ...]`).
- `MetroStations.floorAt(x, y, z)`: walkable floor height at (x, z) for feet near height y (multi-level stations),
  `MetroStations.blocked(x0, z0, x1, z1, y)`: wall test for walk mode.
- `MetroStations.list`, `byId`, `spawnPoint(id, platformKey)`, `crowdZones(id)`.

## Requests

### To INFRA: the Under API (draft of 2026-09-26 00:40), from a subway-station point of view

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
