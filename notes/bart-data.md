# Bayline Metro data: format spec (the contract)

Owner: data workstream (`bart-data`). Version: **M2b** (2026-09-26; v0 was M1). Changes since v0 are marked **(M2)**,
additions since the first M2 promotion **(M2b)** (all additive: an M1-era or M2 loader reads M2b files unchanged). This file is authoritative for everything
under `data/pub/v2/metro/` and for the runtime loader `src/js/21_metronet.js` (`MetroNet`). Consumers should use
`MetroNet` rather than parse the files; the files may change shape between versions, the API will not (additions only).

## Files

| path (under `DATA` = `data/pub/v2/`) | what | size (v0) |
|---|---|---|
| `metro/network.json` | tracks (metadata), junctions, stations, lines, patterns (track paths + stops), yards, constants | ~0.44 MB (100 kB gz) |
| `metro/crossings.json` **(M2b)** | streets / railways / waterways crossing each track (see "Crossings"); loaded on demand | ~0.24 MB (47 kB gz) |
| `metro/tracks.<sha256[:10]>.bin` **(M2)** | zlib; per-track sample arrays (positions + attribute planes). Content-addressed: the name comes from `network.json.tracksBin.path`; `tracks.bin` (same bytes) is kept for older loaders; old hashed files are removed after 48 h | ~1.1 MB |
| `metro/timetable.json` | services (calendars), every trip with per-leg stop times, consist lengths, bus bridges | ~1.35 MB |
| `metro/validation.json` **(M2)** | the profile validator's summary + findings + researched-height residuals (not loaded by the game) | ~15 kB |

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
  "tracksBin": { "path": "metro/tracks.6f6a7a6c04.bin", "bytes": 1748444, "layout": "..." },   // (M2) content-addressed name
  "constants": {                                           // (M2b) the numbers the geometry was built with (sources in "sources")
      "gauge": 1.676, "railCentres": 1.7435, "rail": "119 lb (119RE), canted 1:40",
      "platformEdge": 1.616,                               // track centre -> platform edge
      "platformHeight": { "bart": 0.991, "ebart": 0.635, "oac": 0.991 },   // platform top above top of rail, per system
      "platformLength": 213.4,
      "thirdRail": { "offset": 1.4986, "top": 0.1715, "note": "..." },    // contact rail centre from the track centre / contact surface above top of rail
      "cars": { "bartDE": 21.336, "gtwUnit": 40.89, "oacCar": null },   // m over couplers; null = not researched
      "sources": ["..."] },
  "tracks": [ {
      "id": "M1.1",            // BART designation letter + track number where the track has platforms (A1, C2, K3.1, M2 ...);
                               // other tracks: '<letter>-main.N', '<letter>-xoN' (crossover), '-ydN' (yard), '-sdN' (siding), '-spN' (spur)
      "n": 4673, "step": 4.9993, "off": 123456,   // samples, spacing (m), byte offset of this track in tracks.bin (inflated)
      "planes": 5,                                // (M2) attribute planes in tracks.bin (absent = 4)
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
      "type": "subway" | "aerial" | "surface" | "median" | "trench",       // (M2) curated per station, reasoning in "note"
      "layout": "island" | "side" | "stacked" | "split",                   // split = mixed (Daly City, Colma, SFO)
      "platformStructure": "embankment",                                   // (M2, optional) SHAY/UCTY/FRMT: "aerial" per BART but on fill
      "hero": true,
      "aliases": ["Embarcadero", "Ferry Building", "EMBR"],             // (M2b) names riders type (search); includes the 4-letter code
      "levels": { "street": 3.5, "rail": -16.5, "platform": -15.5,         // m above sea level; platform = rail + 0.991 (M2)
                  "byLevel": { "upper": {"rail": .., "platform": ..}, "lower": {..} } },   // (M2) stacked stations only
      "platforms": [ {
          "gtfs": "M16-1", "code": "1", "track": "M1.1", "level": "main" | "upper" | "lower",
          "s0": 10851.2, "s1": 11065.4, "s": 10958.3,       // (M2) extent along the track from the OSM platform geometry
          "side": "left" | "right",                          // side of the track (facing +s) the platform edge is on
          "edge": 1.616,                                     // (M2) track centre -> platform edge (m)
          "y": -15.5, "rail": -16.5,                         // platform top / top of rail at the platform centre
          "height": 0.991,                                   // (M2b) y - rail: 0.991 BART, 0.635 eBART (GTW floor), see constants
          "structure": "cutcover",
          "berth": { "+": 11063.4, "-": 10853.2 },           // (M2) front-of-train stop for travel toward +s / -s
          "src": "osm" | "station", "sys": "bart",
          "unused": true } ],                                // (M2b) only on GTFS platforms no trip in the feed uses (E30-1, Y10-3)
      "entrances": [ { "name": "A1 Market & Drumm Street (NE) Entrance / Exit", "lat": .., "lon": .., "x": .., "z": .., "src": "gtfs" | "osm" } ],
      "note": "why type/layout/levels are what they are", "src": ["A", "STW", ...],   // (M2) keys: tools/metro/stations_curated.py
      "research": { "opened": 1976, "architect": "...", "era": "...", "recognisable": "what a rider recognises",
                    "structure_notes": "...", "platformsDetail": "...", "entrances": "...", "sources": [urls] },   // (M2)
      "ridership": { "weekdayExits": 18924, "weekdayExitsFY2026": 20372, "source": "..." },                    // (M2)
      "url": "https://www.bart.gov/stations/embr"         // data provenance only; never render
  } ],
  "lines": [ { "id": "yellow", "name": "Yellow Line", "colour": "#ffff33", "text": "#000000",
               "terminals": ["Antioch", "SFO / Millbrae"], "patterns": ["yellow-S-0", ...] } ],
  "yards": [ { "id": "concord", "name": "BART Concord Yard", "osm": 31257952, "station": "CONC",   // (M2b) see "Yards"
               "area": 111157, "x": 6429.9, "z": -61839.6, "polygon": [[x, z], ...], "tracks": ["C-yd4", ...] } ],
  "patterns": [ {
      "id": "yellow-S-0",                    // <line>-<N|S>-<rank by trip count>
      "route": "1", "line": "yellow", "dir": 1, "trips": 241,
      "gtfs": ["E30-2", "E20-2", "C80-2", ...],             // GTFS platform stop sequence (the pattern's identity)
      "legs": [ {                                           // one vehicle run each: eBART DMU leg, then BART EMU leg
          "sys": "ebart", "vehicle": "dmu" | "emu" | "apm", "osmRelation": 8237283, "length": 13918.4,
          "path": [["E2", 13168.1, 0.0], ["E-main.1", 788.5, 38.2]],     // [track, s_from, s_to]; s_to < s_from = running toward -s
          "stops": [ { "station": "ANTC", "gtfs": "E30-2", "track": "E2", "s": 13046.0, "d": 124.0 },
                     { "station": "PITT-T", "gtfs": "E10-T", "track": "E-main.1", "s": 40.2, "d": 13918.4 } ]
          // d = distance along the leg path; "reverse": true on a stop where the train reverses (SFO)
      } ]
  } ]
}
```

Notes:
- **Tracks are physical tracks**: one centreline per track (both mains, pocket/tail tracks, crossovers, yard tracks),
  split where another main track diverges (so the Oakland Wye, MacArthur, Bay Fair, Daly City and SFO junction legs are
  separate tracks joined by junctions). Consecutive path segments always meet at a junction or reverse in place.
- **(M2) Stops are berths**: `stops[].s` / `d` is where the FRONT of the train stops: 2 m short of the platform end in
  the direction of travel (BART berths 10-car trains to fill the platform; shorter trains may stop there too). Each leg's
  path starts at the REAR end of its first platform, so the whole train stands on the path at its first stop (d of the
  first stop ~ platform length). At a reversal (SFO) the path turns at the berth; the train's other end becomes the
  front. `platforms[].berth` gives the same positions per direction.
- **(M2) PITT-T**: the eBART transfer platform is a station record (`id: "PITT-T"`, code `C80T`) with two faces:
  `C80-T` (BART side, track `CT`) and `E10-T` (eBART side, track `ET`). GTFS has neither; the ids are ours.
  **(M2b)** One island, one walking surface: both faces' platform tops are equal (y 35.01), so the eBART rail is
  0.356 m higher than the BART rail (0.991 − 0.635; the profile solver holds that offset as a hard equality).
- **(M2) Platform extents**: every platform comes from the OSM platform geometry (areas, lines, edges) projected on its
  track; both faces of an island share one extent. Sides from the same geometry. 107 platform records: 105 used +
  **(M2b)** the two GTFS platforms no scheduled trip uses, flagged `unused: true` (Antioch `E30-1` on `E2`, SFO `Y10-3`
  on `Y-main.5`), so stations can still model both faces.
- **(M2b) Platform sides** come from the NEAREST OSM platform feature on either side of the track (the far platform of
  a side-platform pair often has more OSM points: before M2b the side-platform stations FTVL SANL HAYW SHAY UCTY WCRK
  PHIL WOAK PLZA DELN MLPT had both faces pointing between the tracks; fixed).
- **(M2b) Which track a GTFS platform is on**: where every platform a station's trips use has its GTFS point clearly
  on one track (≤ 3 m from it and ≥ 3 m nearer than any other; 68 platforms at 34 stations), that track is the stop
  target, ahead of the OSM route relations' stop nodes. This moved Daly City's southbound through trains (M90-1) to
  the centre track and the terminating Blue/Green arrivals (M90-3) to the west side-platform track (as GTFS, research
  and the Aug 2026 operating change say), Berryessa's departures to the second face (S50-2 on S2), and Antioch's
  departures to E2 (E30-1, unused in the feed, is the other face).
- **(M2b) Platform heights per system**: `height` = platform top − top of rail: BART 0.991 m (39 in, BFS), eBART 0.635 m
  (level boarding with the Stadler GTW floor), airport connector 0.991 (assumed). `levels.platform` = the BART value.

## Crossings (M2b)

`metro/crossings.json` = `{ "format": "bayline-metro-crossings", "fields": [...], "tracks": { "<track id>": [[s, kind,
class, rel, width, angle, name, dy], ...] } }`: every OSM street, footpath, railway and waterway whose centreline
crosses the track in plan, sorted by `s` (tracks without any are absent). Not part of the boot download:
`await MetroNet.loadCrossings()` once, then `MetroNet.crossings(track, s0, s1)` returns them as objects (and
`tracks[i].crossings` holds the raw rows).

| field | meaning |
|---|---|
| `s` | metres along the track where the centrelines cross |
| `kind` | `road` (any OSM `highway`, incl. footways, cycleways, steps), `rail` (other railways: Caltrain/UP/Amtrak `rail`, VTA/Muni `light_rail`, `tram`), `water` (`waterway`) |
| `class` | the OSM value (`motorway`, `primary`, `residential`, `footway`, `rail`, `light_rail`, `stream`, `canal` ...) |
| `rel` | `under`: the way passes under the track (track aerial/bridge/embankment, or the way is a tunnel/culvert); `over`: it passes over (track underground/trench/portal, or the way is a bridge); `level`: neither (BART has no level crossings: yard/service areas or map gaps) |
| `width` | metres across the way (OSM `width`, else lanes × 3.5 m + 3 m, else a per-class default: motorway 16, residential 10, footway 3, rail 5, river 30 ...) |
| `angle` | degrees between the way and the track, 0–90 (90 = square) |
| `name` | OSM `name` or `ref` (`''` if none) |
| `dy` | top of rail minus the bare-earth lidar ground at the crossing (m; `null` without lidar): for `under` crossings the rail's height above the road/water surface (room for the deck + clearance), for `over` crossings negative (how far the rail is below the street) |

Our own tracks are excluded (BART gauge/operator, `subway`, eBART); railways within 12° of the track (parallel or
merging) are not crossings. `rel` compares OSM layers where both sides have one: a bridge on a higher layer than an
aerial track passes over it (I-880 at West Oakland, Hegenberger Rd), a tunnel on a lower layer than a subway passes
under it (the Central Subway under Market St); otherwise the track's structure decides. The same way crossing twice within 2 m (split OSM ways) is listed once. Use: piers/bents
must avoid `under` crossings (plus half their `width`), portals and lids line up with `over` ones.

## Yards (M2b)

`yards[]`: the storage/maintenance yards from OSM (`railway=yard` / `landuse=railway` areas operated by BART) with the
tracks lying (mostly) inside each polygon: Concord (46 tracks), Hayward (55), Daly City (28), Richmond (35) and the
eBART yard east of Antioch (1). `x, z` = the polygon's vertex centroid, `area` m², `station` = the nearest station,
`polygon` = the closed outline in the Bay frame. Yard tracks are `cls: "yard"` (`<letter>-ydN`), limited to 15 mph.

## tracks.<sha>.bin

zlib (inflate first; `Stream.bin` does it). For each track, at byte `off` (from `tracks[]`), `n` samples, `planes`
attribute planes (5 since M2; absent = 4):

```
f32 x, y, z   × n   (interleaved, little endian)          12·n bytes
u8  struct    × n   (index into structCodes)                n bytes
u8  vlimMph   × n   civil speed limit, mph                  n bytes
u8  cant      × n   (value - 128) · 2 mm, + = right rail lower
u8  cover     × n   m: ground above top of rail (underground/portal) or top of rail above ground (aerial/bridge), 0 otherwise
u8  third     × n   (M2) contact-rail side: 0 none (turnout gaps, eBART, connector), 1 left, 2 right (facing +s)
padding to a multiple of 4 bytes (so the next track's floats stay aligned)
```

Decoder (what MetroNet does):

```js
const u8 = await Stream.bin('metro/tracks.bin'); const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
for (const h of net.tracks) {
  const np = h.planes || 4, P = new Float32Array(buf, h.off, h.n * 3), A = new Uint8Array(buf, h.off + h.n * 12, h.n * np);
  const struct = A.subarray(0, h.n), vlimMph = A.subarray(h.n, 2 * h.n), cant = A.subarray(2 * h.n, 3 * h.n), cover = A.subarray(3 * h.n, 4 * h.n);
  const third = np > 4 ? A.subarray(4 * h.n, 5 * h.n) : null;
  // sample i: x = P[3i], y = P[3i+1], z = P[3i+2]; s = i * h.step; cant_m = (cant[i] - 128) * 0.002
}
```

Structure codes: `0 grade, 1 aerial, 2 bridge (short span < 90 m), 3 embankment, 4 trench (open cut), 5 median
(freeway median), 6 portal (the last ~40 m of a tunnel > 150 m, transition), 7 cutcover (cut-and-cover box), 8 bored,
9 tube (Transbay immersed tube)`. `MetroNet.isUnderground(code)` is true for 6–9.

**(M2) How structure is classified** (tools/metro/profile2.py `classify`):
- OSM `tunnel` → cutcover; the Berkeley Hills section → bored; the **Transbay Tube** by geometry: immersed `tube` for
  5.83 km from the SF vent structure (on the tracks ~137 m off the Ferry Building) toward Oakland, `bored` for the twin
  compressed-air bores from the SF vent to the Embarcadero box (560 m), the ~1.1 km Oakland box to the portal near 7th St
  stays `cutcover`. Open gaps < 60 m between covered runs are covered (station lids, OSM tag gaps).
- **(M2b)** OSM tunnels shorter than 250 m between open track whose lidar ground is no higher than the track bed either
  side are road bridges over open track, not tunnels (West Dublin's 100 m under the I-680 ramps, a Richmond yard lead):
  they keep the open structure; the road is in `crossings` as `over`.
- **(M2b)** after the solve, open track > 1 m below the lidar ground next to a tunnel or a cutting becomes `trench`
  (portal approaches in a U-section).
- OSM `bridge` → aerial (bridge if < 90 m), then refined by the lidar: aerial samples whose rail sits within 2.5 m of
  the bare-earth ground are on fill, not a viaduct → `embankment` (OSM often tags a whole station as bridge where only a
  street span is).
- Open track: `median` where OSM motorway/trunk carriageways run parallel on both sides within 45 m; `trench` where
  the lidar bed is > 3 m below the ground 16–24 m either side (or OSM `cutting`); `embankment` > 2 m above (or OSM).

**(M2) Vertical profile** (`profile2.solve`, OSQP; ~8 min; `METRO_QP=ls` = a fast approximate solver for iteration):
one quadratic program over every 5 m sample of every track (103k unknowns):
- data: open track follows the USGS 3DEP 1 m bare-earth lidar trackbed + 0.25 m (median-filtered over 45 m against
  overpass decks); aerial ≥ ground + 5.5 m (1 m at abutments growing 3 %/m) and ≥ ground + 7.0–8.0 m where OSM roads /
  rails cross under; cut-and-cover ≤ street − 7.5 m (ramping 3 %/m from portals), bored ≤ ground − 12 m, tube ≤ bay
  floor − 7 m; these bounds are soft (slack), everything below is hard;
- hard: grade ≤ 4 % (3 % in the Tube, 6.5 % on the cable-hauled airport connector, whose lidar shows ~6 % into the
  Doolittle Dr underpass), vertical curves on main tracks ≥ 800 m radius **and (M2b) ≤ 0.05 g vertical acceleration at
  the civil speed limit** (R ≥ v²/0.49: 2,000 m at 70 mph, 1,020 m at 50 mph), equal height at every junction,
  every track of a station level equal along the platform and level from 15 m before to 15 m after it;
- stiff (soft): grade separations ≥ 5.6 m rail-to-rail where OSM layers say one track crosses over another (Oakland Wye,
  MacArthur flyover, 12th/19th St two levels);
- anchors: researched station depths/heights (stations_curated.py, with sources), the SF vent structure (tracks at
  −85 ft), the 1965 Transbay Tube general profile (digitized), the Berkeley Hills Tunnel's as-built grades (1.75 % up
  from the west portal to a summit 1,550 m inside the east portal, −0.3 % after);
- plan fixes: Transbay Tube track centres 8.03 m (OSM draws 5.07 m); **(M2b)** island platforms where OSM draws the
  two tracks too close for any island (< 8.2 m centres: Ashby 4.6, North Berkeley 6.7, Downtown Berkeley 7.7, Glen Park
  7.7) are spread to BART's usual 11.1 m along the platform ±20 m with 150 m cosine tapers that stop short of
  junctions (San Bruno, 5.0 m with pocket-track turnouts at both platform ends, is left as mapped); inside tunnels ≥ 400 m long the OSM
  centreline is smoothed (Gaussian, σ 40 m; not within 220 m of a platform or 60 m of a junction, blended over 80 m,
  45 m in from the portals), which removes digitising kinks that would otherwise set speed limits (16 tracks, largest
  move 6.1 m).
The validator (printed on every bake, saved in `validation.json`) checks what the solver is asked to hold, so every
finding is a conflict between data sources: platform rail equality (inner 90 %), grades, vertical curves (800 m /
0.05 g at the limit), open track > 1 m below the robust (125 m median) lidar ground away from crossing streets,
aerial clearance ≥ 5 m (1 m + 3 %/m from an abutment), tunnel cover ≥ 6 m (ramping in 3 %/m from an OSM tunnel start;
covers < 60 m are lids/decks), junction steps, and researched heights missed by > 1 m (generic "aerial platform
+7 m" priors: > 5 m). Remaining findings are explained in notes/bart/data.md.

**(M2) Speed limits** (mph plane): curvature (**(M2b)** from a 15 m-smoothed copy of the centreline, so single-sample
kinks don't count; 1.4 m/s² with cant on main track, 0.65 m/s² on turnouts/crossovers/yards,
yards ≤ 15 mph) capped by OSM `maxspeed` (mapped from BART's civil speed codes: 18 mph through the Oakland Wye, 36 at
Balboa Park and Daly City, 27 on the curve south of Daly City, ...), quantised down to BART's train-control codes
6/18/27/36/50/70 mph. eBART: 75 mph max, airport connector 30 mph, 5 mph steps. Cant: equilibrium for the limit minus
75 mm deficiency, ≤ 150 mm, main track only.

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
  "consist": "how cars are chosen (M2: BART's 2026 train sizing, see below)",
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
- **(M2) Consists** (`cars`, per leg): BART's train sizing from 2026-07-20 (bart.gov, carried into the 10 Aug 2026
  schedule): Red 10 in the weekday peaks / 5 off-peak; Yellow 9, the 8 busiest AM and 6 busiest PM peak trains 10;
  Green 6, six AM-peak trains toward SF 8; Blue 6, five PM-peak trains toward the East Bay 8; Orange 6, four trains 5
  (the last four of the day, assumed). Weekends use the weekday off-peak lengths (not published). eBART: Stadler GTW 2/6
  units (40.9 m each; `cars` counts units): 2 in the weekday peaks, 1 otherwise. Airport connector: 3-car trains.

## MetroNet (src/js/21_metronet.js)

Loads through `Stream` in the game (priority 2) or `fetch(base + path)` in plain pages (`load({ base: '/data/v2/' })`).
No dependency on THREE or U.

```js
await MetroNet.load({ base, dir, prio });    // network.json, then the tracks binary it names (≈ 1.5 MB over the wire);
                                             // dir: 'metro/' (default) or a staged bake ('metro-next/', also #metrodir=)
MetroNet.tracks[i] / byId[id]                // {id, n, step, length, sys, cls, gauge, X, Y, Z (Float32Array), ST, VL, CV, TR (Uint8Array), CA (Float32Array, m), bbox, prev, next, structure}
MetroNet.frame(track | id, s, out)           // {x,y,z, tx,ty,tz (unit 3D tangent along +s), rx,ry,rz (banked right), ux,uy,uz (banked up),
                                             //  grade, cant, bank, struct, structName, vlim (m/s), cover, third (-1 left, +1 right, 0 none), s, track, i}
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
await MetroNet.loadCrossings();              // (M2b) crossings.json, on demand (resolves with [] per track on older data)
MetroNet.crossings(track | id, s0, s1)       // (M2b) [{s, kind, cls, rel, width, angle, name, dy}] (tracks[i].crossings raw)
MetroNet.constants / yards                   // (M2b) network.json constants / yards[] (null / [] with older files)
```

## Preview

`python3 tools/devserver.py 8131` → http://localhost:8131/preview/metronet.html. Map (drag, wheel), colour by structure /
line / speed / grade / class, hover for track id, s, y, grade, limit, cant, cover; the profile strip shows the selected
pattern leg (y, derived ground, structure colours, stations); `3D` shows the network with vertical exaggeration.
Hash options: `pat=yellow-S-0|1`, `c=struct|line|speed|grade|cls`, `ll=lat,lon,pxPerM`, `view=3d`, `cam=yaw,pitch,dist,x,z`.

## Rebuilding

```bash
python3 tools/metro/fetch.py            # GTFS + Overpass BART extract (cached)
python3 tools/metro/osm_pbf.py          # roads/waterways/rails within 60 m of the tracks from the NorCal PBF (needs pyosmium)
python3 tools/metro/bake_network.py     # -> network.json, tracks.<sha>.bin, crossings.json, validation.json   (METRO_PUB=<dir> to stage)
python3 tools/metro/bake_timetable.py   # -> timetable.json (reads network.json)
python3 tools/metro/validate.py overlay|profiles       # NAIP overlays / profile plots -> notes/bart/shots/data/
python3 tools/metro/whatmoved.py [new_dir] [old_dir]   # station level / structure changes between two bakes
python3 tools/metro/debugprof.py TRACK s0 s1 [step]    # inspect the last solve (bounds, targets, separations)
```

Extra Python packages (installed into `data/raw/metro/pylib`, which the tools add to `sys.path`):
`pip install --target data/raw/metro/pylib osqp qdldl osmium`. Lidar: the world bake's L8 cache in
`data/raw/lidar3dep/8/` (I added the ~610 L8 tiles along BART, north of the square too: negative `ty`).

## Sources and terms

- **BART GTFS** (static feed Aug 10 2026 – Jan 8 2027, feed_version 72): https://www.bart.gov/schedules/developers.
  BART Developer License Agreement: free, non-exclusive; redistribution allowed; data "as is"; **BART trademarks and
  copyrighted materials (and confusingly similar variants) may not be used in association with the data** — consistent
  with the plan: nothing rendered carries the BART name or logo (in-game brand: Bayline Metro).
- **OpenStreetMap** (ODbL 1.0, © OpenStreetMap contributors): track centrelines, service tracks, platforms, entrances,
  tunnel/bridge tags, route relations (PTv2).
- **AWS Terrain Tiles** (terrarium z15; USGS 3DEP and others): fallback ground and the Bay's bathymetry.
- **USGS 3DEP** 1 m bare-earth lidar (public domain) via the 3DEPElevation ImageServer (the world bake's cache).
- Research (sources listed per fact in `tools/metro/research/*.json`): Wikipedia, bart.gov (station pages, news, BART
  Facilities Standards R3.2.3, ridership reports, EIRs), NTSB RAR-79-05, Rogers & Peck / geolith.com (Engineering
  Geology of BART), VTA BART Silicon Valley documents, Architectural Record 1974, the stations workstream (1966-68
  contract drawings, Oakland Fire Dept manual).

## Known limitations (M2)

- Researched station depths the geometry cannot meet (≤ 4 % from the nearest portal) are reported, not forced:
  19th St lower level +3.0 m (the 23rd St portal is 460 m away), Daly City +5.5 m (plat anchor was a guess), North
  Berkeley −3.2 m. See validation.json `anchors`.
- Aerial heights come from clearance rules + the lidar at the ends, not surveyed decks; typical 1970s aerials come out
  6–10 m above ground (West Oakland approach ~22 ft per the EQS EA).
- The Oakland Wye's seven bores are solved as a consistent 3D arrangement from OSM topology + layers; the real levels
  may differ by a few metres.
- Berkeley Hills bore spacing: OSM ~20 m kept (sources say 15.2 m (Wikipedia) or 30 m narrowing to 17 m (Rogers & Peck)).
- Third-rail sides are rule-based (away from platforms, field side on double track), not surveyed.
- Crossings are plan intersections with OSM ways: widths are OSM or defaults, and a road on its own OSM bridge over an
  aerial track would read `over` (rare; checked none on mains). Footways/sidewalks drawn as separate ways are included.
- Yard track lists come from OSM polygons; storage tracks outside a yard polygon (tail/pocket tracks) are `cls` siding.
- eBART platform edge offset is BART's 1.616 m (not researched for the GTW); airport connector platform height 0.991 m
  and car length unknown (`oacCar: null`).
- San Bruno's two tracks stay 5.0 m apart as OSM maps them (pocket-track turnouts sit at both platform ends); the
  research says island, so a real island there needs the tracks ~11 m apart.
- Station architects are not identified in public sources for the 1996-2020 extension stations (Colma, South San
  Francisco, San Bruno, SFO, Millbrae, West Dublin, Warm Springs, Milpitas, Berryessa, eBART): `research.architect`
  is absent there.
- Consist rules approximate "busiest trains" by time of day; weekend lengths assumed.
- Track naming: helper tracks at junctions are `X-main.N`; names can change between versions (use `pathFor`, not ids).

## Assumptions log

| # | assumption | why / source |
|---|---|---|
| A1 | Platform 213.4 m (700 ft); platform edge 0.991 m above top of rail, 1.616 m from the track centre | BART Facilities Standards R3.2.3 Table 2 (39 in; gauge line + 30 5/8 in) |
| A2 | eBART transfer: EMU PITT-T ↔ PITT 120 s, cross-platform allowance 180 s | GTFS has one Pittsburg/Bay Point stop; the transfer platform is ~0.97 km east (EIR) |
| A3 | Max grade 4 % (3 % Tube); vertical curves ≥ 800 m | BART design (Garbutt via Wikipedia; Tube: Rogers & Peck); curve radius is our choice (no source) |
| A4 | Top of rail 0.25 m above the lidar bare-earth trackbed | rail 0.17 m + plate over ballast/slab |
| A5 | Aerial clearance ≥ 5.5 m (≥ 7.0–8.0 m over roads/rails); cut-and-cover cover ≥ 7.5 m | structure depth + legal road clearance |
| A6 | Grade separation ≥ 5.6 m rail to rail | car 3.9 m (12 ft 8 in) + clearance + thin deck |
| A7 | 1965 "MSL" = NGVD29; NAVD88 = +0.8 m in SF | NOAA datum offsets at the SF tide station |
| A8 | Consists as in the timetable `consist` text | bart.gov 2026 train sizing |
| A9 | Third rail away from platforms, field side on double track | BART practice (Tube: outer wall, NTSB) |
| A10 | Third rail: contact rail centre 1.4986 m from the track centre, contact surface 0.1715 m above top of rail | BFS R3.2.3 Table 2 (26 in outside the gauge line; 6 3/4 in) |
| A11 | eBART platform 0.635 m above top of rail; PITT-T platform tops equal across the island | GTW floor height (stations workstream); level cross-platform transfer |
| A12 | Crossing widths: OSM `width`, else lanes × 3.5 m + 3 m, else class defaults | OSM rarely maps carriageway width |
| A13 | Tunnel centrelines smoothed (σ 40 m) inside long tunnels only | OSM tunnel ways are hand-traced from portal to portal; the real alignments are designed curves |
| A14 | Vertical curves ≤ 0.05 g at the civil speed limit | usual rapid-transit comfort limit; BART's own criterion not found |
| A15 | Island track centres 11.1 m where OSM's are < 8.2 m | BART's measured island spacing elsewhere (Fremont, Bay Fair, Orinda, Castro Valley, West Dublin: 11.0-11.2 m) |
| A16 | GTFS platform points decide the platform track where they are unambiguous | the Aug 2026 feed reflects current platform use; OSM relations lag it (Daly City) |
| A17 | PITT-T platform 213 m (700 ft) | 2008 EIR (research B) and NAIP (~215 m); OSM's geometry was cut to 150 m in M2 |
