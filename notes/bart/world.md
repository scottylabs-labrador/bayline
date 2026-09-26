# World workstream status (bart-world)

Owner: world workstream. Branch `bart-world`, worktree `.worktrees/bart-world`, dev port 8132.
Scope: photoreal coverage (imagery L6-L9, heights, masks, trees t/t2, lidar h9, ground materials, OSM towns) along every
BART line; ground that meets the BART structures; world quality in the East Bay; verification; the publish list.

## Status

**Started 2026-09-26 00:30.** Stage 1 bake in progress (every BART corridor + the strip's L2-L5 roots).

| step (stage 1, `BAYLINE_STAGE=bart1`) | state |
|---|---|
| coverage: +992 L6, +1749 L7, +3003 L8 (502 / 811 / 1334 of them in the north strip), L2-L5 over the strip | done 00:42 |
| OSM extract v3 (bbox to lat 38.095) for masks / trees | done 00:46 |
| heights, imagery (NAIP, add-only) | done 01:18 (10 L6 tiles on the strip's top row retried 01:26) |
| masks, tree crowns (t), `tiles/index.json` (with `north`) | done 02:21 (strip crowns re-run 02:41: a negative-seed bug) |
| towns b2 (OSM extract with Caltrain + BART 3 km + the strip; bake) | done 02:40: 1692 new tiles + 127 replacing changed b tiles, 14.2 MB; 350 changed tiles held (pre-Metro lidar under them) |
| GPU: L9 (3594 new tiles in 453 L7 parents), then new L8 -> 1024 px | L9 running (1926 written 02:51) |
| lidar h9 (3002 L8 fetched), materials, t2 | lidar bake running (02:44), then materials, t2 |
| NAIP band dropouts (see below): re-fetch + re-bake of the affected new tiles | running |
| **stage 2** (`bart2`): the whole north strip at L6 + L7 (+522 L6, +3285 L7; NAIP prefetched 02:06-02:37) | imagery running (02:44), then masks, index |

Runtime (branch `bart-world`): north-strip support in Terrain / Globe / WorldTiles / Towns (b2) / Flora / UI map / flight
solids, committed; with the data not yet published everything renders exactly as before (checked: Marin from 2.5 km
is pixel-identical to the baseline). Towns knows the East Bay regions 6-9 (house styles, palettes, roof tiles, lawns),
used only by b2 tiles.

## The big finding: the world ends at lat 37.8429

The Bayline world square (X0 -45056, Z0 -49152, 102.4 km, SPEC_v2) ends at **lat 37.8429** (just north of the Golden
Gate and MacArthur). **16 of the 50 stations are outside it**: ROCK (37.8448, by 170 m), ASHB, DBRK, NBRK, PLZA, DELN,
RICH, ORIN, LAFY, WCRK, PHIL, CONC, NCON, PITT, PCTR, ANTC, i.e. the whole Richmond line north of MacArthur, the Berkeley
Hills tunnel and everything from Orinda to Antioch. Outside the square only the Globe draws (web-mercator USGS imagery
at ~1.9 m/px, 7 m DEM, OpenFreeMap boxes, no trees/lidar/towns), and `Terrain.h` there returns the clamped edge row.

**Decision (logged assumption, no owner input possible): extend the tile grid north with negative tile rows.**
The tile formulas stay exactly as they are (`x0 = X0 + tx*T`, `z0 = Z0 + ty*T`); the new "north strip" is the rows
`ty = -1 .. -(2^L/4)` at every level L >= 2, i.e. **Z in [-74752, -49152)** = lat 37.8429 .. **38.0736**, over the full
width of the square (lon -122.609 .. -121.452). Nothing existing changes meaning; new files are named like
`tiles/img/7/60_-3.jpg`. The strip's tile lists live under a new `north` key in each index (old clients never read
it, so data can be published before code without side effects):

- `tiles/index.json`: `north: { z0: -74752, complete: [2, 5], levels: { "6": [[x,y]...], "7": ..., "8": ..., "9": ... } }`
  (L2-L5 complete over the strip; L0/L1 have no strip tiles; the strip's quadtree roots are the four L2 tiles `(0..3, -1)`).
- `tiles/h9/index.json`: `l8n` (rows like `l8`), `tiles/mat/index.json` and `tiles/t2/index.json`: `north` (like `tiles`).
- Towns: new tiles go to a new layer `tiles/b2/` (see below).

Runtime changes this needs (small, surgical; listed so the lead/infra can review): `12_terrain.js` (tile keys with
negative rows, `exists`, strip roots, index merge, `detailTiles`), `15_globe.js` (the excluded "Bayline" area becomes
the square + strip, taken from `Terrain` at init, so the globe keeps drawing the strip if the data isn't there),
`61_flora.js` / `30_towns.js` (read the `north` / `b2` indexes), `74_worldtiles.js` (OpenFreeMap buildings keep
drawing in the strip wherever Towns has no tile), `66_ui.js` (map rows), `16_airports.js` (Buchanan Field is in the strip).

## Plan

1. **Coverage (tools/tiles/common.py, tools/tiles/metro.py).** BART corridors from the data workstream's
   `metro/network.json` when it exists, until then OSM (`data/raw/metro/osm/bart_osm.json`, railway=subway + eBART +
   the airport connector). Rules (in addition to everything that exists): L6 within 8 km of a BART track, L7 within
   3 km, **L8 within 1.2 km**, **L9 within 300 m of the track / 650 m of a station** (the Peninsula's rule); north strip:
   L2-L7 complete (no regression anywhere the globe drew before: L7 = 1.56 m/px beats the globe's ~1.9 m/px), L8/L9 by
   the BART rules and the AOIs.
2. **Bake, add-only** (`bake_tiles.py --add-only`): never rewrite an existing file (no re-mosaic of old L5/L6 when their
   children fill in, no rewrite of an old L7 when it gains L8 children, masks never re-pooled). Then GPU: `sr_tiles.py`
   (L9) and `sr_l8.py` (new L8 to 1024 px), one GPU job at a time.
3. **Lidar h9, materials, t2 trees, OSM towns (b2)** for the new tiles; new lidar tiles fade their detail toward the old
   h9 tiles at shared edges (the old ones faded toward "no lidar" there, so the seams stay exact).
4. **Ground meets BART** (after the data workstream's profile): a carve rule per structure type (at-grade, trench,
   median, embankment, portal); likely a runtime height filter fed by MetroNet rather than baked (so profile updates
   never require re-baking published tiles). The exact rule will be written here for infra.
5. **World quality** along SR-24, the Diablo foothills, Fremont/Hayward flats, Antioch: landcover, trees, materials,
   night lights, East Bay house styles.
6. **Verify**: screenshots day/dusk at >= 10 spots, `check_tiles.py`, index consistency, seams, registration.

## Budget (<= ~18 GB raw + published)

Measured 01:27 (stage 1 partial): raw +3.2 GB (NAIP cache 2.7 -> 4.8 GB, lidar 0.83 -> 1.5 GB, terrarium +0.23 GB,
OSM extract v3 0.16 GB); published +0.65 GB in 9.6k files (512 px L8 before the GPU pass). Estimate at the end of stage
1: ~2.2 GB published + ~3.5 GB raw; stage 2 adds ~0.45 GB published + ~2.3 GB raw. Total ~8.5 GB.

## Publish list

(exact list with sizes when stage 1 completes; index files last.) Safety for old clients (the page in production
before the Bayline Metro code ships):

| what | harmless to old clients? |
|---|---|
| new tiles in the square (`tiles/{img,h,m,t}/L/x_y` with y >= 0, `h9`, `mat`, `t2` tiles) and the square entries they add to `tiles/index.json` `levels`, `h9/index.json` `l8`, `mat` / `t2` `tiles` | yes: exactly how the SF and Oakland AOIs were added; old clients just get more detail along the BART corridors (Fremont, Hayward, Dublin, Colma ...) |
| strip tiles (negative rows: `x_-N`) | yes: old clients never request them |
| `north` / `l8n` keys in the indexes | yes: old clients never read them (checked: their tile-key collisions land out of range) |
| `tiles/b2/**` | yes: old clients never read b2 |
| **L8 imagery: publish only after the GPU pass** (`sr_l8.py` upgrades new L8 tiles from 512 to 1024 px in place, locally) | publishing a 512 px L8 file and then the 1024 px one would change a published file; wait for the "SR done" milestone |

Order: tile files first, then `tiles/h9/index.json`, `tiles/mat/index.json`, `tiles/t2/index.json`, `tiles/b2/index.json`,
and `tiles/index.json` last.

## Ground meets BART (the carve rule; `src/js/19_metroground.js`, `MetroGround`)

Runtime, not baked: with `#metro=1`, once MetroNet is loaded, a Terrain height filter (`Terrain.addHeightFilter`, a
small hook in `12_terrain.js`) reshapes every height tile of level >= 7 (L7 base 6.25 m, lidar L8 3.1 m / L9 1.56 m) along
MetroNet's CURRENT profile, so a new profile (M2 and later) never needs a re-bake of published tiles. `Terrain.h` /
`hBase` return the carved ground, so Towns roads, trees and people stand on it (Towns and Flora rebuild once when the
filter installs). `#mground=0` turns it off (QA). Cost measured at MacArthur: ~1.1 ms per carved tile (only tiles near
a ground-level BART track are touched). Rule, per track sample (MetroNet `ST` codes):

| structure | ground |
|---|---|
| grade (0), embankment (3), median (5) | **bed = top of rail - 0.85 m** within **2.4 m** of each track centreline; beyond, back to the natural ground on a **1:2** side slope (cut or fill), 1.5 .. 16 m wide |
| trench (4) | cut only, to **top of rail - 1.2 m** within **3.0 m** of each track centreline; the step up to the natural ground happens between 3.0 and 3.9 m: **infra's retaining walls stand there** (wall face at >= 3.0 m from the outer track's centreline, footing below rail - 1.2 m, top at or above the natural ground) |
| portal (6), cut-and-cover (7), bored (8), tube (9) | untouched: infra opens the ground with `Under.addCut` |
| aerial (1), bridge (2) | untouched (columns stand on the natural ground) |
| platforms of ground-level stations (platform structure grade / embankment / median / trench) | cut only, to the bed (rail - 0.85 m), from 1.2 m to 11 m from the track centreline on the platform side, over the platform length + 5 m |

Also in `MetroGround` (with `#metro=1`): a Towns drop filter (`Towns.addDrop`) removes, in the older `tiles/b` tiles,
what b2 already drops at bake time: OSM `building=train_station` footprints within 160 m of a BART station (8 stations
have one in old tiles: WOAK, GLEN, BALB, DALY, LAKE, FTVL, SBRN, SFIA), canopies / sheds / garages within 22 m and anything
within 7 m of an above-ground BART track. Stations: tell me if you need other kinds or radii.

For infra: at grade the ballast shoulder / sleeper ends can assume flat ground at rail - 0.85 m out to 2.4 m; in
medians the ground between the track and the barriers is the same bed plane (the freeway lanes stay where Towns draws
them); trench walls must cover the vertical step at 3.0-3.9 m. For stations: the ground under a ground-level
platform is at or below the bed. v0 profile vs the ground (main tracks, before the carve): grade rail-ground median
+0.5 m (p10 -0.1, p90 +2.0), embankment +1.1 m, trench -2.8 m, portal -5.4 m.

## Findings along the way

- **NAIP band dropouts (also in production).** Under load the USGS NAIPPlus ImageServer sometimes returns an image in
  which one band of a rectangular block is empty: magenta (no green), yellow (no blue) or cyan (no red) squares. 59 of
  today's RGB responses had them (repaired: re-fetched with a new fetch-time check that retries, affected new tiles
  re-baked before anything is published) and **15 of the Sep 23 responses too**, i.e. some *published* Peninsula / SF /
  East Bay tiles show coloured squares today (e.g. near Palo Alto 37.41,-122.13 and San Mateo 37.55,-122.33).
  `data/raw/tiles/fix_dropouts/report.json` lists them; fixing them means overwriting those published files (and
  purging them from the CDN), so it is the lead's call; I can produce the fixed files (incl. the 1024 px L8 via the GPU).
- **The Globe's bays** (visible across the old north edge and still north of 38.07): the Globe classified the
  sediment-brown bays as land and ran ocean surf through them (white speckles). `tiles/globe/baywater.png` (44 KB, from OSM
  bay / strait / water polygons, 1024 px over lon -123.3..-120.9, lat 36.4..38.8) now marks them in the Bay frame as calm
  bay water with one uniform tone (`15_globe.js`, cache key bayline-globe-v4); old clients never load it.

## Requests / notes for other workstreams

- **data**: I use `bart_osm.json` from your raw cache read-only for the corridor geometry until `metro/network.json`
  exists. Heights north of lat 37.8429 will only be valid in the client once the strip tiles + runtime are in.
- **infra**: I will touch `12_terrain.js` for the strip (keys/roots/index) in a self-contained way; please keep your
  terrain-opening work in separate functions so the merge stays trivial.
