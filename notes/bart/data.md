# Data workstream status (bart-data)

Owner: data workstream. Branch `bart-data`, worktree `.worktrees/bart-data`, dev port 8131.
Format spec (the contract): **`notes/bart-data.md`**. Outputs: `data/pub/v2/metro/` (shared, live for everyone).
Loader: `src/js/21_metronet.js` (`MetroNet`). Preview: `preview/metronet.html`.

## Status

**M2 data: PROMOTED to the shared `data/pub/v2/metro/` (2026-09-26 03:29, `tools/metro/promote.py`) — OK to publish.**
Compatibility, tested (Node, both loaders against the promoted files, 03:35): the **M1-era MetroNet (commit 3d9009f)
loads the promoted network.json fine**: it fetches `metro/tracks.bin` (kept, same bytes as `tracks.6f6a7a6c04.bin`),
reads 4 attribute planes at each track's `off` (the 5th plane and the 4-byte padding are skipped), and every v0 field
is unchanged (additions only). Results identical to the M2 loader (374 tracks, same frames/paths/platform heights).
Semantic changes the M1 code sees: stops are berths now, and there is a `PITT-T` station record; the current `bart`
code handles both (smoke-tested in the merged game with `#metro=1`). Same schema as v0 plus
additions (spec: notes/bart-data.md, M2 marked). Binary is content-addressed: `metro/tracks.6f6a7a6c04.bin`, named by
`network.json.tracksBin.path`; `metro/tracks.bin` holds the same bytes for the integration's current MetroNet (it reads
by per-track offset, so the new 5th plane is harmless). `21_metronet.js` on `bart-data` loads the hashed name
(+ `dir` / `#metrodir=` for staged bakes, `frame().third`, `track.TR`): please merge it.

What M2 changes (details in notes/bart-data.md):
- **Vertical profile**: one exact QP (OSQP) over all 103k samples: lidar trackbed (USGS 3DEP 1 m, 610 new L8 tiles
  along BART incl. north of the square), hard grade <= 4 % (3 % Transbay Tube), vertical curves >= 800 m, equal
  heights at all 578 junctions, **every track of a station level equal and level along the platform (+15 m)**,
  grade separations from OSM layers (Wye, MacArthur flyover, 12th/19th), researched anchors (station depths, SF vent
  structure -85 ft, the 1965 Tube profile, the Berkeley Hills Tunnel's as-built 1.75 % / -0.3 % grades).
  Validator (every bake; `metro/validation.json`): platform rail mismatch 0, grade violations 0, vertical curves
  >= 800 m everywhere, junction steps 0. Remaining flags are explained below.
- **Structure**: medians from OSM freeways (116.8 km of `median`), trench/embankment from the lidar cross-section, OSM
  bridge extents trimmed where the lidar shows fill (135 samples -> `embankment`), the Tube by geometry (5.83 km
  immersed from the SF vent, 560 m of SF bores, the Oakland box), portals at real tunnel ends only.
- **Plan**: Transbay Tube track centres 8.03 m (OSM had 5.07).
- **Stations**: all 105 platforms from OSM platform geometry (both faces of an island share one extent), platform
  top 0.991 m, edge 1.616 m, berths per direction, curated type/layout per station with reasoning + sources, research
  (opened, architect, era, what riders recognise, sources), ridership (weekday exits CY2025/FY2026), PITT-T station.
- **Patterns**: stops are berths (front of train at the leaving platform end); legs start at the first platform's
  rear end. Terminal platform codes get distinct tracks where paths allow (Berryessa).
- **Speed limits**: curvature, capped by OSM maxspeed (BART civil codes: Wye 18 mph, Balboa Park / Daly City 36 ...),
  quantised to BART's ATC codes 6/18/27/36/50/70. **Third-rail side** per sample (new 5th plane).
- **Timetable**: 2026 train sizing (Red 10/5, Yellow 9-10, Green/Blue 6-8, Orange 5-6), eBART = Stadler GTW 2/6
  units (`cars` = units, 1 off-peak / 2 peak), realistic eBART transfer timing.

### What moved (station platform level, v0 -> M2, m above sea level)

| station | type (M2) | layout | rail M2 (m) | platform v0 -> M2 | moved (m) |
|---|---|---|---|---|---|
| ORIN | median | island | 155.0 | 198.4 -> 156.0 | -42.4 |
| CONC | aerial | island | 35.7 | 28.4 -> 36.7 | +8.3 |
| CIVC | subway | island | -4.8 | 4.3 -> -3.8 | -8.1 |
| MLPT | trench | side | 3.9 | 12.8 -> 4.9 | -7.9 |
| EMBR | subway | island | -16.5 | -8.1 -> -15.5 | -7.4 |
| MONT | subway | island | -9.0 | -0.9 -> -8.0 | -7.1 |
| NCON | trench | island | 31.0 | 38.8 -> 32.0 | -6.8 |
| GLEN | subway | island | 41.5 | 49.0 -> 42.5 | -6.5 |
| POWL | subway | island | -6.7 | 0.1 -> -5.7 | -5.8 |
| 19TH | subway | stacked | -11.7 (upper -9.4, lower -16.4) | -3.0 -> -8.4 | -5.4 |
| 12TH | subway | stacked | -7.1 (upper -3.8, lower -13.7) | 1.2 -> -2.8 | -4.0 |
| SANL | aerial | side | 21.7 | 26.5 -> 22.7 | -3.8 |
| HAYW | aerial | side | 36.3 | 40.9 -> 37.3 | -3.6 |
| OAKL | aerial | side | 10.4 | 7.9 -> 11.4 | +3.5 |
| PLZA | aerial | side | 22.0 | 26.3 -> 23.0 | -3.3 |
| DALY | aerial | split | 91.9 | 89.6 -> 92.9 | +3.3 |
| DELN | aerial | side | 26.6 | 30.8 -> 27.6 | -3.2 |
| WOAK | aerial | side | 11.1 | 15.3 -> 12.1 | -3.2 |
| PHIL | aerial | side | 33.4 | 37.6 -> 34.4 | -3.2 |
| FTVL | aerial | side | 17.9 | 22.0 -> 18.9 | -3.1 |
| BAYF | aerial | island | 16.8 | 20.8 -> 17.8 | -3.0 |
| UCTY | aerial | side | 19.8 | 23.6 -> 20.8 | -2.8 |
| WCRK | aerial | side | 60.0 | 63.8 -> 61.0 | -2.8 |
| SSAN | subway | island | 14.7 | 13.0 -> 15.7 | +2.7 |
| CAST | median | island | 59.0 | 57.6 -> 60.0 | +2.4 |
| RICH | surface | island | 16.1 | 14.9 -> 17.1 | +2.2 |
| BALB | trench | island | 61.7 | 64.8 -> 62.6 | -2.1 |
| NBRK | subway | island | 23.1 | 22.0 -> 24.1 | +2.1 |
| 16TH | subway | island | -3.3 | -0.5 -> -2.3 | -1.8 |
| LAKE | subway | island | -3.9 | -1.1 -> -2.9 | -1.8 |
| ANTC | median | side | 23.1 | 22.4 -> 24.1 | +1.7 |
| DBRK | subway | island | 46.1 | 45.5 -> 47.1 | +1.6 |
| COLM | trench | split | 47.4 | 49.8 -> 48.4 | -1.4 |
| LAFY | median | island | 114.3 | 114.0 -> 115.3 | +1.3 |
| PITT | median | island | 46.1 | 48.2 -> 47.1 | -1.1 |
| ROCK | median | island | 63.7 | 65.8 -> 64.7 | -1.1 |
| ASHB | subway | island | 26.0 | 25.9 -> 27.0 | +1.1 |
| SHAY | aerial | side | 12.3 | 12.2 -> 13.2 | +1.1 |
| DUBL | median | island | 109.7 | 109.8 -> 110.7 | +0.9 |
| SFIA | aerial | split | 11.4 | 13.3 -> 12.4 | -0.9 |
| MCAR | median | island | 34.6 | 34.9 -> 35.6 | +0.7 |
| SBRN | trench | island | 2.6 | 3.0 -> 3.6 | +0.6 |
| WARM | surface | island | 14.3 | 15.8 -> 15.3 | -0.5 |
| 24TH | subway | island | 9.2 | 10.7 -> 10.2 | -0.5 |
| PCTR | median | island | 17.0 | 18.3 -> 18.0 | -0.3 |
| BERY | aerial | island | 35.9 | 36.6 -> 36.9 | +0.3 |
| COLS | aerial | island | 14.4 | 15.2 -> 15.4 | +0.2 |
| FRMT | aerial | island | 22.8 | 23.7 -> 23.8 | +0.1 |
| MLBR | surface | side | 4.0 | 5.1 -> 5.0 | -0.1 |
| WDUB | median | island | 105.7 | 106.6 -> 106.7 | +0.1 |
| PITT-T | new | island | 34.2 | - -> 35.2 | - |

| structure | track km (M2) |
|---|---|
| aerial | 98.9 |
| bored | 11.5 |
| bridge | 8.9 |
| cutcover | 70.1 |
| embankment | 14.1 |
| grade | 168.6 |
| median | 116.8 |
| portal | 2.8 |
| trench | 8.0 |
| tube | 11.7 |


### Researched heights vs the solved profile (anchor = street/ground + rel; solved at the platform centre)

| station | rel | target | solved | delta |
|---|---|---|---|---|
| HAYW | +6.0 | 36.6 | 36.3 | -0.3 |
| BAYF | +6.0 | 16.2 | 16.8 | +0.6 |
| SANL | +6.0 | 21.3 | 21.7 | +0.4 |
| COLS | +9.7 | 13.8 | 13.7 | -0.0 |
| FTVL | +6.0 | 16.9 | 17.9 | +1.0 |
| LAKE | -14.0 | -3.9 | -3.9 | +0.0 |
| WOAK | +6.0 | 10.2 | 11.1 | +0.9 |
| EMBR | -20.0 | -16.6 | -16.5 | +0.1 |
| MONT | -18.6 | -9.1 | -9.0 | +0.0 |
| POWL | -18.2 | -6.7 | -6.7 | +0.1 |
| CIVC | -19.8 | -4.8 | -4.8 | +0.1 |
| 16TH | -13.1 | -3.3 | -3.3 | +0.0 |
| 24TH | -13.1 | 9.2 | 9.2 | +0.0 |
| GLEN | -11.6 | 41.4 | 41.5 | +0.1 |
| DALY | +6.0 | 86.4 | 91.9 | +5.5 |
| BERY | +9.7 | 35.9 | 35.9 | +0.0 |
| 12TH/upper | -17.0 | -3.9 | -3.8 | +0.1 |
| 12TH/lower | -27.0 | -13.9 | -13.7 | +0.2 |
| 19TH/upper | -17.0 | -9.4 | -9.4 | +0.1 |
| 19TH/lower | -27.0 | -19.5 | -16.4 | +3.0 |
| ASHB | -11.0 | 26.0 | 26.0 | +0.0 |
| DBRK | -11.0 | 46.1 | 46.1 | +0.0 |
| NBRK | -7.0 | 26.3 | 23.1 | -3.2 |
| PLZA | +6.0 | 20.5 | 22.0 | +1.4 |
| DELN | +6.0 | 25.4 | 26.6 | +1.2 |
| CONC | +6.0 | 37.1 | 35.7 | -1.4 |
| PHIL | +6.0 | 32.4 | 33.4 | +1.1 |
| WCRK | +6.0 | 59.9 | 60.0 | +0.1 |
| SSAN | -10.0 | 14.7 | 14.7 | -0.0 |
| SBRN | -8.6 | 2.6 | 2.6 | -0.0 |
| SFIA | +9.0 | 11.4 | 11.4 | -0.0 |

Misses > 1 m, explained: **19TH lower +3.0** (the K-line portal at 23rd St is 460 m north of the platform: at 4 % the
lower level can't be deeper than ~street-21 m); **DALY +5.5** (the anchor was a typical-aerial guess; the lidar and
the Colma / Balboa Park approaches decide); **NBRK -3.2** (north portal ~0.7 km away + Ohlone Greenway grades);
PLZA/DELN/PHIL/CONC within 1.5 m (anchors were typical values, except CONC's measured +6.96 m).

### Answers to requests

- **Stations**: (1) platform top 0.991 m: done. (2) Your depths are anchors (table above); Market St: MONT/POWL/CIVC/
  EMBR rails 18-20 m below the street, 12th St upper street-16.8 / lower street-26.7, 19th St upper street-17.1 /
  lower street-24.1 (see above). (3) Platform s-ranges: from the OSM platform geometry, both faces of an island share
  one extent; berths per direction in `platforms[].berth`. (4) Types/layouts: adopted your list (+ research A/B/C);
  SHAY/UCTY/FRMT are `aerial` with `platformStructure: "embankment"`; per-station reasoning in `stations[].note`.
- **Infra**: (1) Tube centres 8.03 m done; the Oakland box already has ~5.5 m in OSM; Market St and Mission St run in
  twin bores ~14 m / 9-10 m apart in OSM (kept); Berkeley Hills: kept OSM's ~20 m because sources disagree (15.2 m
  Wikipedia vs 30 m narrowing to 17 m at the portals, Rogers & Peck): tell me if you want 15.2 m and I'll move them.
  (2) Tube extent: done by geometry (tube 5.83 km, SF bores 560 m, Oakland box ~1.1 km to the portal near 7th St).
  (3) consistent platform ranges: done. (4) `median`: done. (5) third-rail side: 5th plane / `frame().third`
  (rule-based). (6) smoother profiles: hard 4 % + 800 m vertical curves; the West Oakland portal now descends a smooth
  4 % from the aerial through the trench into the portal.
- **Trains**: GTW 2/6 wording fixed; `cars` for eBART legs = GTW units.

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
