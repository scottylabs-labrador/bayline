# Bayline Flight: design and plan

Goal: fly real aircraft types from any airport in the world, over real terrain and imagery, with the
Bayline Peninsula (NAIP 0.2-0.4 m, every building and tree, live trains) as the high-detail showcase.

## Sources (verified 2026-09-23; all CORS-enabled unless noted)

| What | Source | Terms |
|---|---|---|
| Elevation | AWS Terrain Tiles, terrarium PNG z0-15 `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | open data; attribution list (USGS 3DEP, SRTM, GMTED, ETOPO1, ...) |
| Imagery, US | USGS National Map `basemap.nationalmap.gov/.../USGSImageryOnly/MapServer/tile/{z}/{y}/{x}` (NAIP) | public domain |
| Imagery, world | EOX Sentinel-2 cloudless 2025 `tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg` (10 m, real data to z14) | CC BY-NC-SA 4.0 (Bayline is non-commercial); attribution "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)" |
| Night lights | NASA GIBS VIIRS Black Marble (z0-8) | public domain |
| Airports, runways | OurAirports CSV (baked by tools/bake_airports.py) | public domain |
| Buildings, water, aeroways | OpenFreeMap vector tiles (OpenMapTiles schema) `tiles.openfreemap.org/planet` | free, no key, no limits; "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" |
| Live weather | Open-Meteo forecast API | free non-commercial; CC BY 4.0 |
| Live traffic | adsb.lol `/v2/point/{lat}/{lon}/{nm}` (no CORS: proxied + cached by our nginx) | ODbL; no key today |

## Architecture

**Frame.** Everything renders in a flat local frame: x = (lon - lon0)·mlon, z = -(lat - lat0)·mlat,
y = height. The Bay frame is Bayline's own (Geo: 37.40, -122.10), so all baked data stays valid. Flight
beyond ~150 km from the frame origin rebases the frame to the aircraft; Bayline content only renders in
the Bay frame. Globe tiles store vertices relative to their centre, so a rebase is a per-tile
position + scale update, no geometry rebuild.

**Curvature.** A global patch of three.js `project_vertex` bends every vertex down by d²/2R, d = horizontal
distance from the camera, computed in view space from the precise modelView product (no float32 jitter).
Depth/shadow passes stay unbent (shadow lookups use unbent world positions, so they stay consistent).
Physics stays flat. Fog and clouds in post add the same bend back when they evaluate heights.

**Globe (15_globe.js).** Chunked-LOD quadtree over web-mercator tiles around the camera (z0 to z14 near
the camera); 32×32-quad meshes with skirts; heights from terrarium (finest loaded ancestor, CPU-decoded,
also serving physics); imagery USGS inside the US (to z16), EOX elsewhere (to z14); water from
bathymetry + (later) OpenFreeMap water polygons; night lights from Black Marble. In the Bay frame the
globe discards fragments inside the Bayline square (Bayline terrain draws there).

**Airports (16_airports.js).** Baked OurAirports database (large/medium/small with runways): search,
nearest, runway geometry. Runways rendered near the aircraft with procedural markings (threshold, numbers
via canvas, centreline, touchdown zone, aiming point, edges), edge/threshold/end/centreline lights,
approach lights and PAPI (colour from the viewing angle). Terrain flattened under runways (render and
physics).

**Aircraft (46_aircraft.js + 47_fdm.js).** Real types with public-spec performance: C172, A320neo,
737-800, 787-9, 747-400, F-16C (then A380, Concorde, King Air 350, DC-3). Parametric procedural models
(lofted fuselage with livery canvas, airfoil wings with animated ailerons/flaps/spoilers/slats, tail with
elevator/rudder, engines/props, retracting gear, nav/strobe/beacon/landing/logo lights, lit cabin
windows). Six-degree-of-freedom FDM: ISA atmosphere, lift/drag/side force with stall and Mach drag rise,
stability and damping derivatives, flaps/gear/spoilers, piston/turboprop/turbofan/afterburner thrust,
spring-damper gear with brakes, steering and tyre friction, ground effect, wind; 240 Hz substeps.
Assisted handling (fly-by-wire style attitude hold, auto-rudder, auto-trim) by default; direct mode for
joysticks.

**Flight (48_flight.js).** Setup (aircraft, airport search, runway into wind, start: runway / 8 nm final
/ cruise), keyboard + gamepad + touch controls, cameras (cockpit, chase, orbit, tower, flyby), HUD
(attitude, speed/altitude tapes, heading, VSI, FPV, flaps/gear/throttle, ILS deviation, warnings),
autopilot (HDG/ALT/VS/SPD, approach), landing scoring (sink rate, centreline, touchdown zone), crash
detection, sounds.

## Status (2026-09-23, evening)

Phases 1-7 are done and live: thirteen types including the H125 helicopter, fourteen challenges (two for the
helicopter), a world map with direct-to and join-a-live-flight, OpenFreeMap buildings and airport surfaces, Black
Marble city lights, multiplayer aircraft, share links (`L`), replays, solid buildings and landmarks. Headless QA:
`node tools/qa_flight.js` (every type: takeoff, cruise, autoland; the helicopter: hover, dash, quick stop,
landing). Autoland touchdowns are 80-130 fpm (Concorde ~300), rolling out on the centre line.

Gotchas learned:
- The fixed-wing ground law must not engage in the flare (it did at 1.5 m AGL: bounce and balloon); the flight
  law now holds until the wheels touch.
- The flare needs flight-path-rate damping; a pure gain on the flight path overshoots into a balloon on heavies.
- Approach flaps must come out one notch at a time with the speed target following the next notch's limit,
  or they never deploy and the aircraft lands at 200 kt.
- Helicopter lateral trim: the tail rotor pushes the aircraft sideways; hold wings at the trim bank
  (atan(tail rotor thrust / weight)) and let the pedals null the sideslip, or it slides at 20+ kt.
- A bridge deck is a slab: solid only if the aircraft reaches it (CG + its height above the CG over the deck
  bottom), otherwise flying under it would be impossible.

Open ideas: Concorde's droop nose, rain on the windshield from Open-Meteo precipitation, volumetric clouds from the
real cloud layers, OpenFreeMap water polygons for exact coastlines, more helipads (OSM aeroway=helipad) as targets.

## Phases (each ends deployed and checked)

1. Curvature patch + Globe in the Bay frame (horizon beyond the Bayline square: Diablo, the Pacific,
   the Central Valley and Sierra from altitude).
2. Frame rebase + Bayline visibility; free-fly anywhere.
3. Airports bake + runway rendering.
4. FDM + aircraft models + flight mode (UI, controls, cameras, HUD) — "fly from any airport".
5. Autopilot/ILS, sounds, landing scoring.
6. Live weather (auto = real weather), live ADS-B traffic.
7. OpenFreeMap buildings/water/taxiways worldwide; volumetric clouds; more aircraft; missions.
