# Towns: real streets, buildings and neighbourhoods along the line

`src/js/30_towns.js` (the `Towns` module) streams 1 km tiles of real OpenStreetMap streets, downtown buildings, parks,
parking lots and mapped trees around the camera. It fills the rest with procedural houses, shops, apartments, yards,
street trees and streetlights, each in the style of its region. Riding the line or walking out of any of the 31
stations puts you on that town's real street grid, among its real downtown buildings.

Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright). **The credits screen must
say "Map data © OpenStreetMap contributors".**

## Files

| file | what |
|---|---|
| `tools/fetch_osm.py` | Gets the OSM data. `--pbf` (recommended) downloads Geofabrik's NorCal extract (650 MB, about 45 s), filters it with pyosmium (about 4 min), writes `data/raw/osm/{roads,bld,misc}_pbf.json`, then deletes the PBF unless `--keep-pbf`. Without `--pbf` it runs the same selection as about 110 Overpass queries (slow, rate-limited, resumable). Needs `pip install osmium` for `--pbf`. |
| `tools/bake_towns.py` | Reads `data/raw/osm/*.json` and writes `data/baked/towns.bin`. It simplifies, classifies, tiles and delta-codes the data. About 7 s. |
| `data/baked/towns.bin` | **3.15 MB** zlib (5.2 MB raw), 1048 tiles. Contents: 81.7k buildings, 56k road pieces, 23.7k intersections, 3.9k areas, 8k mapped trees. |
| `src/js/30_towns.js` | Runtime (about 97 KB source). |
| `preview/towns.html` | Standalone preview. It can use the lead's terrain (`#terrain=1`). |

Selection: motorways and trunks within 6.5 km of the tracks, primary and secondary roads 3.2 km, tertiary 2.6 km, residential
1.6 km. Buildings are included within 800–900 m of every station, in the SoMa, Mission Bay and downtown San Jose cores, and
**within 170 m of the tracks along the whole line**, so the view from the train is real everywhere. Parks, parking,
plazas and service alleys are included within 600–900 m of stations. Mapped trees are included within 700 m of stations.

## API

```js
await Towns.init({
  ll2w: Geo.ll2w,
  groundY: (x, z) => Terrain.h(x, z),   // MUST be the height the terrain renders
  trackDist: (x, z) => metres to the nearest track centreline (anything >= 30 is fine when far),
  stationList: corridor.stations,        // [{lat, lon}] or [{x, z}]
  keepOut: (x, z) => bool,               // optional: no OSM building / house / infill centred here (landmarks, depots)
  isWater: (x, z) => bool,               // optional: Terrain.isWater keeps infill houses off the water
});
scene.add(Towns.group);
// every frame:
Towns.update(camera.position, { night, time, camPos: camera.position, budgetMs: 4 });
Terrain.setTownFade(Towns.stats.detailR - 300, Towns.stats.detailR + 300, 1);   // real streets take over from the fabric
// traffic (life agent):
Life.createTraffic(Towns.roadsNear(x, z, 1500), ...)  // [{ pts: Float32Array xyz world, cls, lanes, oneway, speed m/s, width, urban, bridge }]
Towns.buildingsAt(x, z, r)   // [{ x, z, height, minHeight, kind: 'house'|'commercial'|..., pts: Float32Array xz world }]
Towns.idle()                 // true when nothing is left to stream (loading screen / teleports)
Towns.stats                  // { tiles, queue, buildings, houses, trees, lights, groundTris, lastBuildMs, detailR, roadR }
Towns.regionOf(z)            // 0 SF, 1 north Peninsula, 2 mid Peninsula, 3 South Bay, 4 San José, 5 South County
Towns.materials              // { roadMat, bldMat, houseMat, treeMat, glowMat, poleMat, poolMat }
```

Road classes in `roadsNear` (`cls`) are: 0 motorway, 1 motorway link, 2 trunk, 3 trunk link, 4 primary, 5 primary link,
6 secondary, 7 secondary link, 8 tertiary, 9 tertiary link, 10 residential, 11 unclassified, 12 living street. Heights
already include the road lift and bridge decks.

## How it streams

- **Tiles and levels.** Tiles are 1 km, loaded within `ROAD_R` 3.4 km. Each tile has a level:
  - 0: roads, parks and parking only;
  - 1 (within 2.6 km): adds buildings, houses as simple boxes with roofs, low-poly trees, lights and yards;
  - 2 "hi" (within 1.3 km): adds sidewalks, curbs, crosswalks, parapets, rooftop units and detailed house models.
- **Altitude.** All radii grow with the camera's height above the ground.
- **Time slicing.** Work runs as generators, nearest tile first, within `budgetMs` (4 ms by default). Rebuilt meshes are
  swapped in only when complete, so upgrades never leave holes.
- **Distance swaps.** Trees switch to full-poly within 300 m. Lamp posts show within 850 m, lamp light pools within
  1.5 km at night, and the glow sprites at any distance at night.
- **Draw calls per tile.** About 8–12: ground, buildings, 1–9 house variants, up to 4 tree kinds, poles, glows, pools and yards.

Measured in the preview (headless Chrome with the M-series GPU, 1400×900, with the lead's terrain), at mid-day
including the shadow pass:

| where | towns draws | rendered tris |
|---|---|---|
| Palo Alto 400 m aerial | 113 | 1.30 M |
| SF 4th & King 500 m aerial | 91 | 1.81 M |
| San Mateo 380 m aerial | 118 | 1.29 M |
| University Ave, street level | 109 | 2.06 M |

- **Riding test** (800 m at 40 m/s, 4 ms budget): average 0.26 ms of towns work per frame. Occasional single steps
  take 9–15 ms (see known issues).
- **Cold start.** Loading a station with a 40 ms/frame budget takes about 1.2–2.2 s to idle. `init()` takes about 30 ms
  (inflate, index, and building house, tree and lamp templates).

## Look

- **Roads.**
  - The asphalt ribbons drape over the terrain: the road centre and edges are sampled on a 20 m height cache.
  - Lane markings are drawn in the shader: double yellow, dashed lanes and edge lines, faded at junctions.
  - Continental crosswalks at urban junctions. SF and downtown get them on every corner; suburban residential corners don't.
  - Curbs and concrete sidewalks with joints.
  - A grass verge on suburban tertiary and residential streets. Downtown streets get 3.8 m sidewalks and no verge
    (the baker's `core` flag, set where building coverage over 150 m is above 28%).
  - Sidewalks stop at cross-street curb lines.
  - Freeways get shoulders and median barriers. Bridges get parapets, deck edges and piers.
- **Areas.**
  - Parks, pitches, playgrounds, cemeteries and plazas.
  - Parking lots with stall lines aligned to the lot's oriented bounding box.
- **OSM buildings.**
  - Heights come from the height or levels tags, else defaults by kind and region.
  - Hipped, gabled, pyramid or skillion roofs on the oriented box. Flat roofs get parapets and rooftop units.
  - Shader facades: punched windows with frames and sills, SF bays, ribbon windows, curtain walls, and storefronts
    with sign bands.
  - Base grime and parapet coping.
  - Windows lit warm at night, some offices cool.
  - Palettes by region: SF pastels, Peninsula stucco and Mission cream, terracotta roofs on the mid-Peninsula and
    southward, SJ and South County sand tones.
- **Procedural fill, placed with a 2 m occupancy grid that includes the neighbouring tiles.**
  - Houses along real residential streets. Mix by region:
    - SF: row houses flush to the sidewalk;
    - Peninsula: ranch, two-story and bungalow;
    - Palo Alto, Mountain View and Sunnyvale: add Eichlers (low gable, glass ends, clerestory);
    - San José: bungalows;
    - Gilroy and Morgan Hill: ranch and two-story.
  - Shops (storefront, sign band, awning) and apartments along urban arterials.
  - A dominant-grid infill fills the superblocks the streets don't reach.
  - Lawns, driveways, yard trees, street trees, and streetlights along arterials and downtown streets.
- **Night.**
  - Lit windows.
  - Lamp glow sprites plus warm light pools on the pavement.
  - Everything is driven by `U.uNight`, so no per-frame work.

## Integration notes (for the lead)

1. **Heights.** `groundY` must match what the terrain draws (`Terrain.h`, bilinear on the same grid the vertex shader
   samples). Towns caches heights per tile on a 20 m grid when a tile is built. If the terrain heights change
   afterwards, call `Towns.dispose()` so the tiles rebuild.
2. **Lift above the ground.**
   - Roads sit 0.22–0.40 m above `groundY`, by class.
   - Sidewalks sit a further 0.15 m up.
   - Parks and parking sit 0.11–0.20 m up.
   - Lawns sit 0.10 m up.

   Don't add extra shader displacement to the terrain near towns.
3. **Terrain fade.** Call `Terrain.setTownFade(Towns.stats.detailR - 300, Towns.stats.detailR + 300, 1)` each frame. It
   hides the terrain's far "urban fabric" (roof blotches and fake streets) where the real town is.
4. **Track clearance.**
   - `trackDist` keeps houses 15 m or more and trees 7–9 m or more from the centreline, and keeps lamps off it.
   - OSM buildings with their centroid within 7 m of a track are dropped. So are station, canopy and parking
     structures within 22 m.
   - OSM `building=train_station` footprints within 160 m of a station are dropped, so the station module can draw its
     own depot there. If the depots or landmarks clash with anything else, pass `keepOut(x, z)`.
5. **Traffic.** Feed `Towns.roadsNear()` to `Life.createTraffic`. It decodes tiles on demand, so it works before the
   tiles have been built.
6. **Shadows.** Buildings, houses, trees and poles cast shadows. Ground meshes only receive them.
7. **Attribution.** Add "Map data © OpenStreetMap contributors (ODbL)" to the credits and to the About panel.

## Known issues / next steps

- Occasional single build steps of 9–15 ms (a large road ribbon or a big tile's building mesh). They could be split
  further if they hitch on slower machines.
- Real buildings only exist near stations, in the SF/SJ cores and in the 170 m band along the track. Everything else
  is procedural, which is believable but not the actual house on that lot.
- The infill uses one dominant grid angle per tile. Curvy subdivisions get some houses at odd angles to their street.
- House and shop models are generic. There are no recognisable storefronts or signage text.
- `towns.bin` could shrink about 30% with varint deltas instead of int16. The runtime format is versioned (`BLT2`),
  so this can be done later.
- The Overpass path of `fetch_osm.py` still works but takes more than an hour on public servers. Use `--pbf`.
