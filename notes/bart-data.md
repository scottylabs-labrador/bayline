# Bayline Metro data: format spec (the contract)

Owner: data workstream (`bart-data`). Version: **v0** (2026-09-26, M1). This file is authoritative for everything
under `data/pub/v2/metro/` and for the runtime loader `src/js/21_metronet.js` (`MetroNet`). Consumers should use
`MetroNet` rather than parse the files; the files may change shape between versions, the API will not (additions only).

## Files

| path (under `DATA` = `data/pub/v2/`) | what | size (v0) |
|---|---|---|
| `metro/network.json` | tracks (metadata), junctions, stations, lines, patterns (track paths + stops) | ~0.3 MB |
| `metro/tracks.bin` | zlib; per-track sample arrays (positions + attribute planes) | ~1.1 MB |
| `metro/timetable.json` | services (calendars), every trip with per-leg stop times, consist lengths, bus bridges | ~1.3 MB |

Built by `tools/metro/` (see "Rebuilding"). Raw inputs are cached under `data/raw/metro/` (shared).

## Frame and conventions

- **Bay frame** (identical to `Geo.ll2w`, the tiles and the Globe): `x = (lon + 122.10) * 88542.2` (east),
  `z = -(lat - 37.40) * 110985.1` (south), `y` = metres above sea level (NAVD88, like `Terrain.h`). Metres everywhere.
  The frame is linear in lon/lat: at Antioch/Pittsburg (lat 38.0) east-west distances in the frame are ~0.9 % longer
  than on the ground. Everything in the game shares that stretch, so it is consistent; running times come from the
  timetable, not from distances.
- **Track position**: `(trackId, s)`. `s` = metres of plan (horizontal) arc length from the track's first sample,
  `0 <= s <= length`. Samples are uniform: sample `i` is at `s = i * step`, `step <= 5 m`.
- **y is top of rail** at the track centreline (mid-way between the rails), after cant.
- **Right** = right-hand side when facing `+s`: in plan, `right = (-dz, dx)` for a unit direction `(dx, dz)`.
  `lat > 0` means right of `+s`. Curvature > 0 = the track turns right as `s` increases.
- **Cant** (superelevation) in metres of rail-head height difference over `RAIL_CC = 1.75 m`; **> 0: the right rail is
  lower** (the track banks to the right, i.e. into a right-hand curve). `bank = asin(cant / 1.75)`.
- **Gauge**: BART 1.676 m (5 ft 6 in) between the rails' inner faces (rail centres ~1.749 m apart); eBART (DMU) and the
  airport connector 1.435 m (`tracks[].gauge`).
- Direction ids follow GTFS: **0 = North, 1 = South** (BART's own `directions.txt`). Line ids: `yellow orange green red
  blue grey` (grey = the airport connector) and the pseudo line `ebart` (the Antioch DMU leg of Yellow trips).
- Station keys: BART's four-letter abbreviations (`EMBR`, `12TH`, … see bart-plan.md) plus the pseudo stop
  **`PITT-T`** (the Pittsburg/Bay Point transfer platform ~1 km east of the station, where Yellow EMUs and eBART DMUs
  meet cross-platform).

## network.json

```jsonc
{
  "version": 0, "format": "bayline-metro-network", "frame": "...", "generated": "...", "sources": ["..."],
  "structCodes": ["grade","aerial","bridge","embankment","trench","median","portal","cutcover","bored","tube"],
  "tracksBin": { "path": "metro/tracks.bin", "bytes": 1652000, "layout": "..." },
  "tracks": [ {
      "id": "M1.1",            // BART designation letter + track number where the track has platforms (A1, C2, K3.1, M2 ...);
                               // other tracks: '<letter>-main.N', '<letter>-xoN' (crossover), '-ydN' (yard), '-sdN' (siding), '-spN' (spur)
      "n": 4673, "step": 4.9993, "off": 123456,   // samples, spacing (m), byte offset of this track in tracks.bin (inflated)
      "sys": "bart" | "ebart" | "oac", "cls": "main" | "yard" | "crossover" | "siding" | "spur",
      "length": 23363.1, "gauge": 1.676, "station": "EMBR",   // nearest station (for naming/debug)
      "structure": [[s0, s1, "cutcover"], ...],                 // run-length structure (same as the per-sample codes)
      "prev": { "junction": "J12", "to": [["K-main.9", 111.14], ["K-main.12", 626.5]] } | null,   // what s = 0 connects to
      "next": { ... } | null                                     // what s = length connects to (null = buffer stop / end)
  } ],
  "junctions": [ { "id": "J12", "kind": "turnout" | "link" | "diamond", "x": .., "z": .., "osm": 6133371941,
                   "tracks": [["M1.1", 0.0], ["K-main.9", 111.14], ["K-main.12", 626.5]] } ],   // every track touching the point, at its s
  "stations": [ {
      "id": "EMBR", "name": "Embarcadero", "code": "M16", "lat": .., "lon": .., "x": .., "z": ..,
      "type": "subway" | "aerial" | "surface" | "median" | "trench",
      "layout": "island" | "side" | "stacked" | "split",
      "hero": true,                                        // hand-authored hero station candidate
      "levels": { "street": 3.5, "platform": -8.1 },       // m above sea level (v0: platform = rail + 1.02)
      "platforms": [ { "gtfs": "M16-1", "code": "1", "track": "M1.1", "s": 9471.2, "s0": 9364.5, "s1": 9577.9,
                       "side": "left" | "right",           // side of the track (facing +s) the platform edge is on
                       "y": -8.1, "rail": -9.1, "structure": "cutcover", "osmPts": 62 } ],
      "entrances": [ { "name": "A1 Market & Drumm Street (NE) Entrance / Exit", "lat": .., "lon": .., "x": .., "z": .., "src": "gtfs" | "osm" } ],
      "url": "https://www.bart.gov/stations/embr"         // data provenance only; never render
  } ],
  "lines": [ { "id": "yellow", "name": "Yellow Line", "colour": "#ffff33", "text": "#000000",
               "terminals": ["Antioch", "SFO / Millbrae"], "patterns": ["yellow-S-0", ...] } ],
  "patterns": [ {
      "id": "yellow-S-0",                    // <line>-<N|S>-<rank by trip count>
      "route": "1", "line": "yellow", "dir": 1, "trips": 241,
      "gtfs": ["E30-2", "E20-2", "C80-2", ...],             // GTFS platform stop sequence (the pattern's identity)
      "legs": [ {                                           // one vehicle run each: eBART DMU leg, then BART EMU leg
          "sys": "ebart", "vehicle": "dmu" | "emu" | "apm", "osmRelation": 8237283, "length": 13918.4,
          "path": [["E2", 13168.1, 0.0], ["E-main.1", 788.5, 38.2]],     // [track, s_from, s_to]; s_to < s_from = running toward -s
          "stops": [ { "station": "ANTC", "gtfs": "E30-2", "track": "E2", "s": 13168.1, "d": 0.0 },
                     { "station": "PITT-T", "gtfs": "C80-T", "track": "E-main.1", "s": 38.2, "d": 13918.4 } ]
          // d = distance along the leg path; "reverse": true on a stop where the train reverses (SFO)
      } ]
  } ]
}
```

Notes:
- **Tracks are physical tracks**: one centreline per track (both mains, pocket/tail tracks, crossovers, yard tracks),
  split where another main track diverges (so the Oakland Wye, MacArthur, Bay Fair, Daly City and SFO junction legs are
  separate tracks joined by junctions). Consecutive path segments always meet at a junction or reverse in place.
- **Stop positions** (`stops[].s`, platform `s`) in v0 are the track point nearest the station's GTFS coordinate (or
  the OSM `stop_position` of the matching route relation); platform ranges are `s ± 106.7 m` (700 ft). M2 replaces
  them with OSM platform extents and berth marks (10-car stop at the leaving end).

## tracks.bin

zlib (inflate first; `Stream.bin` does it). For each track, at byte `off` (from `tracks[]`), `n` samples:

```
f32 x, y, z   × n   (interleaved, little endian)          12·n bytes
u8  struct    × n   (index into structCodes)                n bytes
u8  vlimMph   × n   civil speed limit, mph                  n bytes
u8  cant      × n   (value - 128) · 2 mm, + = right rail lower
u8  cover     × n   m: ground above top of rail (underground/portal) or top of rail above ground (aerial/bridge), 0 otherwise
```

Decoder (what MetroNet does):

```js
const u8 = await Stream.bin('metro/tracks.bin'); const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
for (const h of net.tracks) {
  const P = new Float32Array(buf, h.off, h.n * 3), A = new Uint8Array(buf, h.off + h.n * 12, h.n * 4);
  const struct = A.subarray(0, h.n), vlimMph = A.subarray(h.n, 2 * h.n), cant = A.subarray(2 * h.n, 3 * h.n), cover = A.subarray(3 * h.n);
  // sample i: x = P[3i], y = P[3i+1], z = P[3i+2]; s = i * h.step; cant_m = (cant[i] - 128) * 0.002
}
```

Structure codes: `0 grade, 1 aerial, 2 bridge (short span < 90 m), 3 embankment, 4 trench (open cut), 5 median
(freeway median), 6 portal (the last ~35 m of a tunnel, transition), 7 cutcover (cut-and-cover box), 8 bored,
9 tube (Transbay immersed tube)`. `MetroNet.isUnderground(code)` is true for 6–9.

## timetable.json

```jsonc
{
  "version": 0, "format": "bayline-metro-timetable",
  "feed": { "publisher": "Bay Area Rapid Transit", "version": "72", "file": "google_transit_20260810-20270108_v02.zip",
            "calendarStart": "20260810", "calendarEnd": "20270110", "timezone": "America/Los_Angeles", "license": "..." },
  "services": { "2026_08_10-DX-MVS-Weekday-015": { "kind": "weekday" | "saturday" | "sunday" | "special",
                "days": [1,1,1,1,1,0,0],               // Mon..Sun
                "start": "20260810", "end": "20270108", "add": ["YYYYMMDD"], "remove": ["20260907", ...] } },
  "transfer": { "emuTransferToStation": 120, "dmuTransferAllowance": 180 },
  "consist": "how cars are chosen (heuristic v0)",
  "trips": [ { "id": "1965164", "svc": "2026_08_10-DX-MVS-Weekday-015", "line": "yellow", "dir": 1, "pat": "yellow-S-0",
               "head": "San Francisco International Airport", "cars": [2, 8],       // per leg
               "legs": [[arr0, dep0, arr1, dep1, ...], [...]] } ],               // seconds after the service day's midnight, aligned with patterns[pat].legs[k].stops
  "busBridge": [ { "id": .., "svc": .., "route": "BridgeA", "head": "Bus Bridge", "stops": ["A90-1", "A80-2"], "t": [arr, dep, ...] } ]
}
```

- A service runs on `ymd` if `ymd` is not in `remove` and (`ymd` in `add` or (`days[weekday]` and `start <= ymd <= end`)).
  `MetroNet.servicesOn(ymd)` / `tripsOn(ymd)` implement it. Times after midnight stay > 86400 (trips of the previous
  service day are still running after midnight: check yesterday's trips too, like `45_sim.js` does).
- The feed's weekend `-085` services are the bus-bridge weekends (Aug–Sep 2026; alternate weekends with `-015`).
- **eBART split**: every Yellow trip through Antioch has two legs: a DMU leg `ANTC–PCTR–PITT-T` and an EMU leg
  `PITT-T–PITT–…`. GTFS has one stop at Pittsburg/Bay Point; the transfer platform times are derived: southbound, the EMU
  leaves PITT-T 120 s before its PITT arrival and the DMU arrives at PITT-T 180 s before that; northbound, the EMU reaches
  PITT-T 120 s after leaving PITT and the DMU leaves 180 s after the EMU arrives (capped 240 s before its next stop).
- The airport connector (grey) runs its own short trips (every few minutes, 516 a day per direction on weekdays).

## MetroNet (src/js/21_metronet.js)

Loads through `Stream` in the game (priority 2) or `fetch(base + path)` in plain pages (`load({ base: '/data/v2/' })`).
No dependency on THREE or U.

```js
await MetroNet.load();                       // network.json + tracks.bin (≈ 1.4 MB over the wire)
MetroNet.tracks[i] / byId[id]                // {id, n, step, length, sys, cls, gauge, X, Y, Z (Float32Array), ST, VL, CV (Uint8Array), CA (Float32Array, m), bbox, prev, next, structure}
MetroNet.frame(track | id, s, out)           // {x,y,z, tx,ty,tz (unit 3D tangent along +s), rx,ry,rz (banked right), ux,uy,uz (banked up),
                                             //  grade, cant, bank, struct, structName, vlim (m/s), cover, s, track, i}
MetroNet.point(track, s, lat, up, out)       // a point lat m to the right and up m above top of rail, in the banked frame
MetroNet.nearest(x, z, maxR = 200, filter)   // {track, s, dist, lat} (lat > 0 right of +s) | null
MetroNet.nearAll(x, z, r = 50, filter)       // best projection per track within r, nearest first
MetroNet.stationsNear(x, z, r = 1000)        // [{station, dist}]
MetroNet.inTunnelAt(x, y, z)                 // {kind: 'tunnel' | 'station', track, s, struct, lat, station?} | null
MetroNet.pathFor('yellow-S-0')               // or pathFor('yellow', 1) (busiest pattern) / pathFor('yellow', 1, k | 'yellow-S-3')
  -> { id, line, dir, gtfs, trips, legs: [Leg] }
Leg: { sys, vehicle, length, stops: [{station, gtfs, track, s, d, reverse?}], segs: [{track, s0, s1, sign, d0, d1}],
       locate(d) -> {track, s, sign, seg}, frame(d, out) (tangent/right/cant flipped to the direction of travel), stopD(station) }
await MetroNet.loadTimetable();  MetroNet.servicesOn('20260928'); MetroNet.tripsOn('20260928'); MetroNet.trip(id)
MetroNet.stations / stationById / lines / lineById / patterns / junctions / STRUCT / isUnderground(code) / MPH / RAIL_CC
```

## Preview

`python3 tools/devserver.py 8131` → http://localhost:8131/preview/metronet.html. Map (drag, wheel), colour by structure /
line / speed / grade / class, hover for track id, s, y, grade, limit, cant, cover; the profile strip shows the selected
pattern leg (y, derived ground, structure colours, stations); `3D` shows the network with vertical exaggeration.
Hash options: `pat=yellow-S-0|1`, `c=struct|line|speed|grade|cls`, `ll=lat,lon,pxPerM`, `view=3d`, `cam=yaw,pitch,dist,x,z`.

## Rebuilding

```bash
python3 tools/metro/bake_network.py     # OSM + GTFS -> network.json, tracks.bin (fetches terrain tiles on first run)
python3 tools/metro/bake_timetable.py   # GTFS -> timetable.json (reads network.json)
```

Raw inputs (cached, shared): `data/raw/metro/google_transit_20260810-20270108_v02.zip` + `gtfs/`, `data/raw/metro/osm/bart_osm.json`
(Overpass query in `q_bart.overpassql`, OSM base 2026-09-26T04:24Z), terrarium z15 tiles in `data/raw/terrarium/15/`.

## Sources and terms

- **BART GTFS** (static feed Aug 10 2026 – Jan 8 2027, feed_version 72): https://www.bart.gov/schedules/developers.
  BART Developer License Agreement: free, non-exclusive; redistribution allowed; data "as is"; **BART trademarks and
  copyrighted materials (and confusingly similar variants) may not be used in association with the data** — consistent
  with the plan: nothing rendered carries the BART name or logo (in-game brand: Bayline Metro).
- **OpenStreetMap** (ODbL 1.0, © OpenStreetMap contributors): track centrelines, service tracks, platforms, entrances,
  tunnel/bridge tags, route relations (PTv2).
- **AWS Terrain Tiles** (terrarium z15; USGS 3DEP and others): ground heights for the profile.

## Known limitations (v0) → planned fixes

- Vertical profile is rough: ground + structure offsets, 4 % clamp, smoothing. Tunnel depths, portal positions, station
  levels, aerial heights and the Tube are not yet researched (M2: constrained solve with lidar and known depths).
- Structure comes from OSM `tunnel`/`bridge` tags only; freeway medians (SR-24, I-580, SR-4, I-980) are still `grade`.
- Speed limits = curvature only (1.4 m/s² total lateral, cap 70 mph); service tracks capped (yard 10, crossover 27 mph).
- Platform sides/layouts are inferred from OSM platform geometry (mostly right; a few stations are marked `split` where
  the inference failed, e.g. BERY, SHAY, SFIA). Levels, concourses, descriptions, ridership: M2.
- Consist lengths are a heuristic (see timetable `consist`).
- Track naming: helper tracks at junctions are `X-main.N`; names can change between versions (use `pathFor`, not ids).

## Assumptions log

| # | assumption | why / source |
|---|---|---|
| A1 | Platform length 213.4 m (700 ft), platform top 1.02 m above top of rail (level boarding) | bart-plan.md; height refined in M2 |
| A2 | eBART transfer: EMU PITT-T ↔ PITT 120 s, cross-platform allowance 180 s | GTFS has one Pittsburg/Bay Point stop; OSM stop_position "Pittsburg/Bay Point Transfer" ~0.9 km east |
| A3 | Max grade 4 % | BART design criteria (plan) |
| A4 | Speed limit from curvature with 1.4 m/s² (≈ 6 in cant + 3 in deficiency), cap 70 mph (BART max operating speed) | v0 heuristic |
| A5 | Consists: see timetable.json `consist` | no public per-trip data in GTFS |
