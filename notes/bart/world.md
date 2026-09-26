# World workstream status (bart-world)

Owner: world workstream. Branch `bart-world`, worktree `.worktrees/bart-world`, dev port 8132.
Scope: photoreal coverage (imagery L6-L9, heights, masks, trees t/t2, lidar h9, ground materials, OSM towns) along every
BART line; ground that meets the BART structures; world quality in the East Bay; verification; the publish list.

## Status

**Started 2026-09-26 00:30.** Phase A (tooling + bake) in progress.

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

(measured sizes will be filled in as the bake runs)

## Publish list

(filled in when the bake completes; index files last)

## Requests / notes for other workstreams

- **data**: I use `bart_osm.json` from your raw cache read-only for the corridor geometry until `metro/network.json`
  exists. Heights north of lat 37.8429 will only be valid in the client once the strip tiles + runtime are in.
- **infra**: I will touch `12_terrain.js` for the strip (keys/roots/index) in a self-contained way; please keep your
  terrain-opening work in separate functions so the merge stays trivial.
