# Data workstream status (bart-data)

Owner: data workstream. Branch `bart-data`, worktree `.worktrees/bart-data`, dev port 8131.
Format spec (the contract): **`notes/bart-data.md`**. Outputs: `data/pub/v2/metro/` (shared, live for everyone).
Loader: `src/js/21_metronet.js` (`MetroNet`). Preview: `preview/metronet.html`.

## Status

**Now (02:40): M2 in progress. What is live in `data/pub/v2/metro/` right now:** the 02:34 bake (M2 work in progress,
schema-compatible with v0: same fields plus additions). It already has the joint profile (island platforms level
across both tracks, grades <= 4 %, no junction steps), OSM platform extents on both faces, platform top 0.991 m,
berths, the curated station types (medians etc.). It is safe to publish, but not final. From now on my work-in-progress
bakes go to `data/pub/v2/metro-next/` (preview with `#metrodir=metro-next/`), and I will write here when M2 is ready.

**Content-addressed binary (lead request):** from the next bake, `network.json.tracksBin.path` names
`metro/tracks.<sha256[:10]>.bin`, and MetroNet loads exactly that name (21_metronet.js, commit after 02:40); `tracks.bin`
is still written too so the current integration keeps working until it merges this MetroNet. Old hashed files are
deleted after 48 h.

**M1 v0: READY (2026-09-26 00:50).** Everyone can build on it now:

- `data/pub/v2/metro/network.json` (0.3 MB) + `tracks.bin` (1.1 MB zlib): 374 physical tracks (57 main, 102
  crossovers, 177 yard, sidings/spurs; 511 km of track in total), 578 junctions, all 50 stations (+ the eBART
  transfer platform `PITT-T`), 7 lines, 34 GTFS patterns with exact track paths (per vehicle leg).
- `data/pub/v2/metro/timetable.json` (1.3 MB): all 3,762 train trips of every service in the Aug 2026 – Jan 2027 feed,
  per-leg stop times (eBART DMU leg split at Pittsburg/Bay Point), consist lengths (heuristic), bus bridges.
- `MetroNet` works in the game (through `Stream`) and in plain pages (`load({ base: '/data/v2/' })`).

## API (short; full in notes/bart-data.md)

```js
await MetroNet.load();                              // network + tracks
MetroNet.frame('M2', s, out)                        // x,y,z top of rail; tangent/right/up (banked); grade, cant, struct, vlim, cover
MetroNet.point(track, s, lat, up)                   // lateral/vertical offsets in the banked frame
MetroNet.nearest(x, z, r) / nearAll(x, z, r)        // {track, s, dist, lat}
MetroNet.pathFor('yellow', 1) / pathFor('red-S-0')  // {legs: [{length, stops[{station, d}], frame(d), locate(d)}]}
MetroNet.stationsNear(x, z, r) / stationById.EMBR   // platforms: {track, s0, s1, side, y, rail, gtfs}
MetroNet.inTunnelAt(x, y, z)                        // tunnel / underground station test
await MetroNet.loadTimetable(); MetroNet.tripsOn('20260928')
```

## How to preview

`python3 tools/devserver.py 8131` then http://localhost:8131/preview/metronet.html (map colour by structure, line, speed,
grade or class; hover any track; the bottom strip is the vertical profile of the selected pattern; `3D` button).

## Open problems (v0) → M2

- Vertical profile is rough (ground + structure offset + 4 % clamp). Tunnels/aerials/portals/Tube depths not researched.
- Freeway medians not detected yet (show as `grade`); portals are the last 35 m of each tunnel.
- Platform extents are s ± 106.7 m around the GTFS stop; platform sides from OSM geometry (a few `split` misfires).
- Consist lengths heuristic; station descriptions, ridership, levels: M2.
- Helper tracks at junctions are named `X-main.N` (ids may change: use `pathFor`/`stationById`, not literal ids).

## Assumptions

See the table in notes/bart-data.md (platform height, transfer timings, grades, speed limit model, consists).

## Requests for other workstreams

- **sim**: the timetable's `legs[k]` align with `patterns[pat].legs[k].stops`; a trip's DMU leg and EMU leg are separate
  vehicles. Include yesterday's trips after midnight (times > 86400).
- **infra**: `tracks[].structure` + per-sample `ST` codes drive guideway type; `cover` gives aerial clearance / tunnel
  cover; junctions give turnout points. Heights will change in M2 (don't bake them into caches).
- **stations**: `stations[].platforms[]` give track, s-range, side and rail height; `entrances[]` from GTFS + OSM.
- **world**: the corridor to cover = every track in network.json (bbox lat 37.36–38.02, lon −122.47 – −121.77).
