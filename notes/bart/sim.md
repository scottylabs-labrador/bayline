# Bayline Metro: SIM workstream status

Owner: sim workstream (branch `bart-sim`, worktree `.worktrees/bart-sim`, dev port 8136).
Files owned: `src/js/46_metrosim.js`, `src/js/47_metro*.js`, `tools/qa_metro_*.js`, `notes/bart/sim.md`,
`notes/bart/shots/sim/`, plus surgical integration edits in the shared files (`55_player.js`, `62_game.js`,
`66_ui.js`, `70_sound.js`, `80_net.js`, `90_main.js`, `src/head.html`, `server/mp.py` docs only).

## Status

- 2026-09-26 00:40: started. Read the plan, the Peninsula sim/player/game/UI/sound/net code. Designing the runtime
  against the MetroNet contract in `notes/bart-plan.md` (the data spec `notes/bart-data.md` is not out yet).

## Plan (in order)

1. Timetable runtime (`46_metrosim.js`, `MetroSim`): trips of the service day, deterministic from the clock,
   minimum-time speed profiles against civil limits, schedule smoothing, dwell, turnbacks, legs per vehicle
   (BART cars, the Antioch DMU, the airport people mover), near consists pooled, far trains as one instanced batch.
2. ATC and the drive game (`47_metroatc.js`): speed codes, manual mode under ATC supervision, ATO, scoring.
3. Player integration (ride, cab, drive, walk, chase/trackside/heli/orbit on metro trains, the Millbrae transfer).
4. UI (`47_metroui.js`): system map (schematic + geographic), station picker, arrivals, train info, line filter.
5. Audio (`47_metrosound.js`), multiplayer modes, live mode (`47_metrolive.js`), QA scripts.

Everything is behind `#metro=1`.

## Interfaces agreed with other workstreams

### STATIONS: walking in multi-level stations (agreed 2026-09-26, answering the request in `stations.md`)

SIM calls, only when `#metro=1` and `MetroStations` exists (otherwise the Peninsula walk is byte-for-byte unchanged):

- `MetroStations.floorAt(x, y, z) -> number | null`: the walkable floor under the feet at (x, z) for feet near
  height `y` (world metres, same frame as `Terrain.h`). Among stacked levels, return the floor closest to `y` that is
  within about ±1.2 m (stairs and escalators are sloped floors, so a step is never more than ~0.3 m). `null` means
  "not on station floor metadata here" (outside the station, or no level near `y`).
- `MetroStations.blocked(x0, z0, x1, z1, y) -> bool`: true when the straight step (x0, z0) -> (x1, z1) at feet height
  `y` crosses a wall, a platform-edge barrier, a closed fare gate, a railing or a column.

What 55_player.js does with them (walk mode, `moveWalk` / `groundAt(x, z, y)`):

1. The ground under the walker is `floorAt(x, walk.y, z)` when it is a number, else the existing rule (Peninsula
   platform, airport, terrain). So standing in a subway concourse never snaps you up to the street.
2. A step is refused when `blocked(...)` is true, when the new floor is more than 0.6 m above the feet (same rule as
   today), or when the walker is below ground (feet more than 2 m under `Terrain.h`) and `floorAt` is `null` there
   (you cannot walk into the earth or off the end of a platform into a tunnel wall).
3. Below ground, the building-footprint collision and the water test are skipped (the Transbay Tube is under water,
   Market St is under buildings).
4. Stepping off a platform edge onto the track is allowed only if the metadata allows it (it should not: `blocked`).
   Falling uses the same gravity as today onto whatever `floorAt` returns below.
5. Entrances: at the top of a street stair `floorAt` meets the terrain height; beyond its polygon it returns `null`
   and the normal terrain rule takes over, so walking out to the street is seamless.

Cost: `floorAt` is called about 4 times per frame and `blocked` once per attempted step while walking; please keep
them cheap (a per-station spatial grid is plenty).

Also used: `MetroStations.spawnPoint(id, platformKey) -> { x, y, z, yaw }` (heading, same convention as
`Stations.spawnPoint`) for "go to this platform" from boards and the system map, and
`MetroStations.setBoard(stationId, platformKey, rows)` (SIM pushes every ~5 s for stations within ~1.5 km of the
camera; rows as in `stations.md`: `{ line, dest, cars, min }`, plus `color` (hex) and `trip` (id) if useful).
