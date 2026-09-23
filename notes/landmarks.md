# Landmarks + Depots (`src/js/50_landmarks.js`)

The module builds 45 real Bay Area landmarks and 17 station-building styles, entirely from code.
Every landmark sits at its real position. The coordinates come from OpenStreetMap (Overpass), Nominatim or
Wikipedia; the sources are listed below.

Preview: `preview/landmarks.html`
- `#lm=<Name>` shows one landmark. `#lm=all` builds everything, with triangle counts in the HUD and console.
- `#sheet=1` adds a contact sheet of every landmark. `#depot=<style>` shows one station building.
- `#depot=sheet` shows all depots and `#depot=all` shows them in a row.
- `#night=1` switches to night. `#az= #el= #dist= #ty=` set the camera and `#hud=0` hides the HUD.
- The N key toggles night. Encode `&` inside a landmark name as `%26`.

## API

```js
const L = Landmarks.build(ctx[, { only: ['Golden Gate Bridge', ...] }]);
//   ctx = { ll2w, groundY(x,z), rng }   (extra fields ignored)
//   -> { group, list, update(dt, env) }
//   list[i] = { name, lat, lon, x, z, y, top, blurb, radius, tris }
//     y = ground at the anchor, top = highest point (m ASL) for labels, radius = rough footprint radius (m)
//   env = { night, time, camPos }   night 0..1; camPos is used for per-landmark distance culling
Landmarks.setNight(n, dt)   // drives the shared night materials (use it if you only use Depots)
Landmarks.names()           // landmark names

const g = Depots.build(style, { name, seed });   // THREE.Group; origin at ground centre, long axis +X, track side -Z
g.userData = { tris, style, footprint: { x0, x1, z0, z1, height } }
Depots.styles    // sf_4th_king millbrae burlingame san_mateo san_carlos redwood_city menlo_park palo_alto
                 // mountain_view sunnyvale santa_clara sj_diridon gilroy mission shelter small modern
Depots.resolve(style, name)   // the style actually used (see the alias rules below)
```

`Depots` is also a top-level const (`const Depots = Landmarks.Depots`).

### Night and animation
- `update(dt, env)` sets all night emissives:
  - Lit windows: the shared `window` material and every textured tower.
  - Lamp fixtures: the `lights` material.
  - Blinking red aviation beacons: the `beacon` material, 1.5 s cycle.
  - Floodlit structures: Coit Tower, the Ferry Building tower, the Transamerica spire, Hoover Tower, Chase Center, the Golden Gate towers, the Mission Santa Clara facade and the Shoreline tent.
  - The Salesforce Tower crown: its LED screen is redrawn every 0.1 s with three rotating shows.
- Every lamp and beacon also emits a constant-size `THREE.Points` sprite, visible at night only. Bridges, runways and towers therefore read as strings of light from kilometres away.
- The Bay Lights on the West Span use an additive `ShaderMaterial`:
  - It reads `U.uNight` and `U.uTime`, so the engine must advance `U.uTime`.
  - It includes the logdepthbuf and fog chunks.
  - Up close you see individual LED strands. Far away they blend into a shimmering curtain. It is invisible by day.
- Culling: each landmark group gets `visible = dist(camPos) < vis`, where `vis = clamp(800 + 130*height + 5*size, 2.5 km, 50 km)`. The loop has no per-frame allocations.

## Landmarks, positions, sources and triangle counts

Triangle counts come from the preview's full build: 141k triangles in total, about 5–8 draw calls per landmark.

| Landmark | Anchor (lat, lon) | Tris | Source / notes |
|---|---|---:|---|
| Salesforce Tower | 37.789775, -122.396914 | 1,100 | OSM, h 326. The LED crown shows animated art at night. |
| Transamerica Pyramid | 37.795166, -122.402786 | 184 | OSM, h 260. Wings and floodlit spire. |
| 181 Fremont | 37.78975, -122.39535 | 620 | Exoskeleton braces, spire to 258 m. |
| Millennium Tower | 37.790405, -122.396187 | 152 | OSM, h 197. |
| 555 California Street | 37.79208, -122.40368 | 456 | Sawtooth tiers, dark granite. |
| One Rincon Hill | 37.78585, -122.39220 | 140 | |
| Oracle Park | 37.77830, -122.38975 | 2,640 | See the Oracle Park notes below. |
| Chase Center | 37.767888, -122.387421 | 1,740 | OSM, h 38. |
| Ferry Building | 37.79520, -122.39400 | 1,766 | OSM relation. 75 m clock tower, bay-side piers. |
| Coit Tower | 37.802377, -122.405834 | 648 | OSM, h 64 on Telegraph Hill. Floodlit. |
| Sutro Tower | 37.755241, -122.452903 | 1,524 | OSM, h 298. Three legs, platforms, crossbar, red and white masts. |
| Painted Ladies | 37.77622, -122.43279 | 812 | Nominatim. Seven houses on Steiner St facing west. |
| Alcatraz Island | 37.82672, -122.42276 | 992 | Adds its own rock so it works even without DEM. Cellhouse, lighthouse, water tower. |
| Cow Palace | 37.70676, -122.41880 | 348 | OSM building. |
| Bay Bridge (West Span) | 37.79819, -122.37786 | 11,520 | See the Bay Bridge notes below. |
| Bay Bridge (East Span) | 37.8152652, -122.3585059 | 15,920 | See the Bay Bridge notes below. |
| Golden Gate Bridge | 37.81976, -122.47856 | 9,140 | See the Golden Gate notes below. |
| San Mateo-Hayward Bridge | 37.5940, -122.2300 | 12,108 | OSM way. High-rise over the channel near the Peninsula (44 m deck), then an 8 m trestle. |
| Dumbarton Bridge | 37.5068, -122.1171 | 5,952 | OSM way. High-rise hump, about 30 m. |
| Sign Hill | 37.6633725, -122.4181018 | 396 | OSM node (NRHP 96000761); layout from Wikipedia. Three lines draped on `groundY`. |
| SFO | 37.615906, -122.383806 | 15,342 | See the airport notes below. |
| SJC | 37.3639, -121.9289 | 7,244 | See the airport notes below. |
| Oracle Towers | 37.5303, -122.2640 | 4,560 | Six glass cylinders at their OSM positions, heights 36–68 m. |
| Pulgas Water Temple | 37.483328, -122.317175 | 2,128 | OSM temple and reflecting pool. The pool runs at bearing 73°. |
| Hoover Tower | 37.427615, -122.166995 | 670 | OSM, h 87. Floodlit. |
| Main Quad & Memorial Church | 37.427524, -122.170249 | 702 | See the Stanford notes below. |
| Stanford Stadium | 37.43453, -122.16109 | 600 | OSM relation centre. |
| The Dish | 37.40856, -122.17939 | 1,750 | Estimate on the foothills. 46 m dish at 50° elevation. |
| El Palo Alto | 37.447285, -122.170124 | 666 | Nominatim. 33.5 m redwood beside the rail bridge over San Francisquito Creek. |
| Meta Headquarters | 37.4828, -122.1515 | 5,692 | See the Meta notes below. |
| Googleplex | 37.4220, -122.0820 | 4,386 | See the Google notes below. |
| Shoreline Amphitheatre | 37.426874, -122.080807 | 856 | OSM tent outline (h 18) with a star-shaped membrane. |
| Google Bay View | 37.4226, -122.0666 | 2,768 | OSM footprints. Two dragonscale canopies. |
| Hangar One | 37.412977, -122.053995 | 3,096 | OSM footprint, bearing 158°. See the Moffett notes below. |
| Hangars 2 and 3 | 37.4166, -122.0430 | 1,792 | OSM, bearing 158°. 329 × 90 × 52 m timber hangars. |
| NASA Ames Wind Tunnels | 37.4160, -122.0635 | 548 | OSM footprints of the 80×120 ft and 40×80 ft tunnels (h 55). The intake faces NW. |
| Apple Park | 37.33484, -122.00902 | 10,232 | See the Apple Park notes below. |
| Levi's Stadium | 37.40317, -121.96983 | 810 | OSM relation (h 59). Field axis 149°, suite tower on the west, video boards at the ends. |
| California's Great America | 37.3955, -121.9730 | 2,894 | See the Great America notes below. |
| Mission Santa Clara | 37.349308, -121.94158 | 434 | OSM footprint. Church axis 66°, facade faces WSW. Bell tower. |
| SAP Center | 37.332796, -121.901316 | 684 | OSM footprint (98 nodes), h 28.7. |
| Winchester Mystery House | 37.31829, -121.95120 | 2,036 | OSM relation bbox. The Queen Anne cluster is synthesized. |
| Lick Observatory | 37.3413889, -121.6427778 | 2,430 | OSM telescope nodes: James Lick refractor dome and the Shane dome. |
| Mount Umunhum Radar Tower | 37.160499, -121.897565 | 96 | OSM footprint, 26 m "Cube". |
| Gilroy Old City Hall | 37.007063, -121.568412 | 600 | OSM footprint. Clock tower with lit faces. |

### Oracle Park
- Group origin is at home plate (37.77802, -122.39020). +X points toward center field at a bearing of 70°.
- Includes the outfield fence, the brick right-field wall on McCovey Cove, the seating bowl, the clock tower gate, the Coke bottle, the glove, the scoreboard and seven light towers.

### Bay Bridge
- West Span: towers, anchorages and abutment come from OSM nodes (tower height 160 m, center anchorage 67 m).
- The upper deck is 70 m at mid-bay, which gives 58 m of clearance.
- The trusses are alpha-tested panels.
- The Bay Lights curtain is on both sides.
- East Span: the SAS tower comes from OSM (h 160). The eastbound and westbound decks follow the OSM motorway geometry.
- The SAS is 385 + 180 m. The Skyway descends from 48 m to the Oakland touchdown.

### Golden Gate Bridge
- Both towers come from OSM leg nodes: 1,280 m main span, 343 m side spans, top at 227 m.
- The portal levels come from OSM `height` parts.
- Also modeled: the Fort Point arch and the approach viaducts. The towers are floodlit.

### Airports (SFO and SJC)
- SFO runways are the OSM centerlines: 28R/10L, 28L/10R, 19L/1R, 19R/1L, all 61 m wide.
- The SFO runways carry real markings: piano keys, letters and numbers, touchdown zone and aiming-point bars, centerline.
- SFO terminal footprints come from OSM: T2, T3, International boarding areas A and G, and boarding area C. The International Terminal main hall with its gull-wing roof is modeled by hand.
- SFO control tower: OSM, h 67. Twelve parked jets in a neutral livery.
- SJC runways are 30L/12R and 30R/12L, 46 m wide. Terminals A, B and F come from OSM.
- Both airports have edge, threshold and centerline lights at night.

### Stanford Main Quad
- Axis of 15.5° from OSM Palm Drive.
- Inner and outer quads with tile roofs.
- Memorial Church faces the Inner Quad and has a gold mosaic facade.

### Meta Headquarters
- OSM footprints for MPK 20 and MPK 21, with rooftop parks and about 140 trees.
- The East Campus buildings are included.
- The entrance sign shows a generic blue lemniscate and no text.

### Google
- Charleston East uses its OSM footprint under a clipped dragonscale canopy.
- Also includes the classic 1600 Amphitheatre buildings.

### Hangar One
- 345 × 94 × 59 m, with a catenary cross-section and orange-peel ends.
- Shown re-skinned: the restoration finished in 2025.

### Apple Park
- OSM bbox gives a ring of about 462 m. Floor canopies, a solar roof and an orchard.
- The ring's glass glows warm at night.
- Also includes the Steve Jobs Theater (OSM) and the Visitor Center (OSM).

### California's Great America
- Drop Tower (68 m) at its OSM node.
- The Flight Deck track comes from its 72-node OSM way; its heights are synthetic.
- Gold Striker is synthesized inside its OSM bbox and uses a wooden lattice structure.
- Carousel Columbia is at its OSM position.

Other sources:
- Wikipedia: Sign Hill (three lines: SOUTH 166 ft, SAN FRANCISCO 484 ft, THE INDUSTRIAL CITY 628 ft; letters 48–65 ft) and Hangar One (345 × 94 × 60 m, restoration completed Dec 2025).
- Overpass mirrors: overpass-api.de and overpass.private.coffee.

## Depot styles
- The station builder (`25_stations.js`) passes generic styles and the real station name. `Depots.resolve` maps them as follows:
  - If the station name has a dedicated building, that building is used. The dedicated buildings are:
    - San Francisco → sf_4th_king
    - Millbrae
    - Burlingame (1894, the first Mission Revival building)
    - San Mateo
    - San Carlos (1888 sandstone)
    - Redwood City
    - Menlo Park (1867 Victorian)
    - Palo Alto (1941 Streamline Moderne)
    - Mountain View
    - Sunnyvale
    - Santa Clara (1863)
    - San Jose Diridon (1935)
    - Gilroy
  - Otherwise these aliases apply: `terminal`→sf_4th_king, `stone`→san_carlos, `victorian`→menlo_park, `streamline`→palo_alto, `diridon`→sj_diridon.
  - `mission` and `modern` are generic builders.
  - Unknown styles fall back to `modern`.
- Each depot is 180–1,500 triangles. It has a name sign with `opts.name`, which becomes an emissive board at night, plus lit windows.
- Depots include a 3–5 m apron on the −Z (track) side with platform lamps, benches and ticket machines. `userData.footprint` gives the full bbox.
- No depot uses the "Caltrain" name or logo. Signs show place names only.

## Integration notes
- **Shared materials.** Depots use the same materials as Landmarks, so their night lighting only animates when `World.landmarks.update(dt, env)` runs, or when `Landmarks.setNight` is called.
- **Terrain assumptions.**
  - Most landmarks sit on `ctx.groundY` at their anchor.
  - Bridges use absolute deck heights, and their piers run down to y = −8.
  - The Sign Hill letters and the runway surfaces are draped on `groundY`, lifted 2.4 m and 0.4 m. If the rendered terrain LOD is coarser than `groundY`, letters or runways could clip. Flattening the terrain under SFO and SJC would help.
- **Towns overlap.** OSM buildings from the towns agent may duplicate these landmarks (SF towers, Oracle, SAP Center, and so on). Skip town buildings within about `list[i].radius` of a landmark anchor. The radius is a rough footprint and is large for bridges and airports, so for those use a smaller value or the actual building footprints.
- **Air traffic.** The SFO and SJC runway endpoints above are the OSM centerlines. The Life module can reuse them so planes land on the painted runways.
- **Missions and labels.** `list` holds `blurb` (one sentence) and `top` (label height). The UI minimap and Landmark Tour already read `list`.
- **Draw calls.** With everything visible, the landmarks cost about 250 draw calls. Distance culling usually leaves 30–80.
- **Custom shaders.** Only the Bay Lights material. It includes the logdepth and fog chunks and `extensions.derivatives`.

## Known issues and limits
- Some heights and orientations are estimates:
  - Gold Striker and Winchester layouts, Flight Deck track heights
  - SAS cable geometry
  - the Dish pointing
  - the Shoreline tent peaks
  - which way Memorial Church's crossing tower faces
- The Main Quad is simplified. There is no arcade detail, and the church has no rose window.
- The Bay Bridge West Span Rincon Hill approach is simplified. Its piers go to −8 and are not trimmed to terrain.
- The San Mateo-Hayward trestle uses a pier every 42 m (the real bents are closer together), to stay near 12k triangles.
- Station depot footprints are approximate. The station builder places depots from their bbox depth.

## Screenshots
Saved in `/tmp/lmshots/`:
- `sheet_day.png` and `sheet_night.png`: every landmark
- `depots_day.png`: every depot style
- `hero_sf_night.png`: skyline, Bay Lights and Coit Tower at night
- `gg_close.png`, `baylights2.png`, `oracle.png`, `apple.png`, `hangar1.png`, `sfo.png`
