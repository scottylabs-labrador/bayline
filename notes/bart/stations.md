# Bayline Metro: STATIONS workstream status

Owner: stations workstream (branch `bart-stations`, worktree `.worktrees/bart-stations`, dev port 8135).
Files owned: `src/js/26_metrostations.js`, `src/js/27_*.js` (station kit, heroes, signage), `preview/metrostations.html`,
`notes/bart/stations.md`, `notes/bart/shots/stations/`.

## Status (2026-09-26 00:26)

- Started. Reading the codebase (25_stations, 30_towns, 60_life, 55_player, 90_main, gfx/env/post) and the other
  workstreams' specs. Plan and APIs below will be filled in as they land.

## Planned public API (draft; will be finalised at M1)

- `MetroStations.init()`, `MetroStations.update(dt, camPos)`: streaming build per station (≤ 1.5 km), time-sliced.
- `MetroStations.setBoard(stationId, platformKey, rows)`: live departures for the platform next-train displays
  (for the SIM workstream).
- `MetroStations.floorAt(x, y, z)`: walkable floor height under feet at (x, z) near height y (multi-level stations).
- `MetroStations.list`, `byId`, `spawnPoint(id, platformKey)`, `crowdZones(id)`.

## Requests

- (none yet)
