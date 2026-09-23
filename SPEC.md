# Bayline — engineering spec (read this before writing code)

Bayline is an unofficial, browser-based simulator of the Peninsula commuter rail corridor
(San Francisco 4th & King → San Jose Diridon → Tamien, plus the South County line to Gilroy),
with the real timetable, real station locations, real terrain and real towns around the line.
It ships as ONE self-contained HTML file (like `../example_katmai_project_deploy`), built by
`build.py` from `src/`. It is hosted at https://bayline.sheltie.scottylabs.org with a tiny
multiplayer relay. "Caltrain" is a trademark: never use its name or logo in visible branding,
liveries or signage. Station names (real place names) are fine. Credits say "Unofficial.
Not affiliated with Caltrain or the Peninsula Corridor Joint Powers Board."

Quality bar: this is meant to be a showpiece. Cohesive, artful, detailed, fast.

## Project layout and file ownership

```
build.py                 concatenates everything into dist/bayline.html (owner: lead)
src/head.html            page markup + CSS + UI shell (owner: lead)
src/js/00_util.js        U: helpers (read-only for everyone)
src/js/01_geo.js         Geo: projection (read-only)
src/js/02_data.js        Data: embedded blob loader (read-only)
src/js/1x_*.js           engine core: env/sky, terrain, water (lead)
src/js/2x_*.js           track, catenary, stations (lead)
src/js/30_towns.js       Towns (towns agent)
src/js/40_trainkit.js    TrainKit (trains agent)
src/js/45_*.js           train simulation / timetable / driving (lead)
src/js/50_landmarks.js   Landmarks + Depots (landmarks agent)
src/js/55_*.js 6x ...    player, missions, UI (lead)
src/js/60_life.js        Life: people, traffic, aircraft, trees, birds (life agent)
src/js/70_sound.js       Sound (audio agent)
src/js/80_net.js         Net client (net agent)       server/  relay + container files (net agent)
src/js/90_main.js        boot (lead)
tools/                   data pipeline + tools/shot.mjs (screenshots)
data/raw/                downloads (gitignored)    data/baked/  compact outputs embedded by build.py
preview/<name>.html      standalone preview page per module (each agent owns its own)
notes/<name>.md          each agent's API notes, integration notes, known limits
```
Only edit files you own. If you need something from another module, write it in your notes file.

## Code conventions

- Plain scripts, no ES modules. build.py wraps ALL of `src/js/*.js` (sorted by file name) in one
  function scope, so each file declares one top-level `const Name = (() => { ...; return {...}; })();`
  and must not assume `window` globals other than `THREE`, `U`, `Geo`, `Data`. Keep private helpers inside
  your IIFE (name collisions are fatal in the shared scope).
- three.js **r158 UMD build** (`vendor/three.min.js`, global `THREE`). No addons are available
  (no OrbitControls, no GLTFLoader, no BufferGeometryUtils): use `U.mergeGeometries`, `U.place`, `U.tint`,
  or write your own. `THREE.SRGBColorSpace` output; renderer uses ACESFilmic tone mapping,
  `logarithmicDepthBuffer: true` (near plane 0.05 m, far 120 km), and `scene.environment` is a
  PMREM sky map set by the engine, so MeshStandardMaterial gets reflections automatically.
- No external assets, fonts or network requests at runtime (except the engine's Google Fonts link and the
  multiplayer socket). Textures: procedural canvas textures via `U.canvasTexture` (≤ 1024², shared).
- Shared uniforms for custom shaders: `U.uNight` (0 day → 1 night), `U.uTime` (seconds), `U.uWind`.
  For standard materials, expose `setNight(n)` / update functions that set emissive intensities.
- Everything must survive `dispose()`-free long sessions: build geometry once, reuse, instance.

## Coordinates, units, time

- Meters. World axes: **+X east, −Z north (+Z south), +Y up**, `y` = meters above sea level.
- `Geo.ll2w(lat, lon) → {x, z}` and `Geo.w2ll(x, z) → {lat, lon}`:
  `x = (lon + 122.10) * 88542.2`, `z = -(lat - 37.40) * 110985.1`.
  4th & King ≈ (−26111, −41775); Gilroy ≈ (47210, 43896). The world spans ~100 × 100 km.
- Keep geometry vertex coordinates LOCAL (small numbers) and place objects with `position`,
  so float32 precision stays sub-millimeter even 60 km from the origin.
- Sim time = seconds since local midnight (America/Los_Angeles). Real timetable from GTFS.
- Car-local frame for rolling stock: origin at car center, `y = 0` at top of rail;
  **+X toward the front of the consist, +Y up, +Z to the right** (right when facing +X).

## Art direction

Stylized realism with a warm California light. Think a high-end architectural model brought to life:
clean silhouettes, believable proportions, restrained palettes, lots of small true-to-life details
(signs, lights, railings, windows, equipment) rather than noisy textures.
- Palette anchors: golden summer hills #c9a45c, live-oak green #4d5b2e, redwood #3b4a2a, bay water
  #3d6f86 → #6ca2b5, salt ponds #b86a6a / #c79a4f / #7d9e62, stucco #e8dcc4, terracotta roofs #b5654a,
  Mission Revival cream #efe3c8, steel grey #8b9098, sky #9cc6e6.
- Trains: our own "Bayline" livery (no real logos): brushed silver/white body, charcoal window band,
  signal-red nose and door accents, amber LED destination signs.
- Night must be beautiful: lit windows, streetlights, station lamps, headlights, city glow.
- Materials: MeshStandardMaterial (roughness/metalness set thoughtfully) or MeshLambertMaterial for
  large count background items; vertex colors to merge many colored parts into one draw call.

## Performance budgets (60 fps target on an M1/M2 laptop, graceful on older machines)

- Whole scene target: ≤ 1,500 draw calls worst case, ≤ 3 M triangles visible.
- Use InstancedMesh for anything repeated > 20 times. Merge static parts by material.
- Provide LOD where it matters (trains, landmarks): full detail near, simple far.
- Nothing may allocate per frame in hot loops (reuse vectors/matrices).

## Screenshots / testing

`node tools/shot.mjs <page.html> <out.png> [--w 1400 --h 900 --wait 3000 --eval "js" --eval2 "js" --gpu]`
drives headless Chrome over DevTools, prints console errors, and saves a PNG. Use `--gpu` for speed.
Look at your screenshots (Read the PNG) and iterate until they look genuinely great.

## Module contracts

### TrainKit (src/js/40_trainkit.js) — trains agent
```
TrainKit.createConsist(kind, opts) -> Consist      kind: 'emu' | 'diesel'
  'emu'    = 7-car double-deck electric multiple unit in the Bayline livery (modern Stadler-KISS-like
             bilevel EMU: cab cars at both ends, 2 bike cars, wide walk-through gangways at the
             intermediate level over the bogies, level-ish boarding doors in the low-floor section).
  'diesel' = diesel-electric locomotive (MP36-like) at the south end + 5 bilevel coaches with a cab car
             at the north end (South County service).
  opts: { seed, name }
Consist {
  kind, cars: Car[], length                    // total coupler-to-coupler length (m)
  setDestination(text)                          // amber LED signs on both cab ends + car sides
  setDoors(side, t)                             // side: 'left' | 'right' | 'both' | 'none'; t: 0 closed..1 open
  setLights({ head, tail, interior, cab })      // 0..1 each (headlights/marker lights, interior glow)
  setNight(n)                                   // 0..1, drives window glow/emissives
  setPantograph(t)                              // emu: 0 down..1 up
  setDisplay({ route, nextStop, destination, clock })   // interior passenger screens (shared canvas)
  setCab({ speedMph, limitMph, throttle, brake, signal, nextStop, distFt, clock, ptc }) // cab desk
  setInteriorVisible(bool)                      // build/show interiors only when the camera is near/inside
  setLOD(level)                                 // 0 = full exterior, 1 = simplified, 2 = far box
  update(dt)                                    // wheel spin (set consist.speed m/s first), door anim
  speed                                         // m/s, set by the sim each frame
}
Car {
  group                    // THREE.Group, car-local frame (see above). Caller adds to scene and sets pose.
  index, type, length, width, height
  bogieOffsets: [xFront, xRear]                 // bogie pivot x positions (car frame)
  floorRegions: [{x0,x1,z0,z1,y,name}]          // walkable axis-aligned rectangles, y = floor height
  ramps: [{x0,x1,z0,z1,y0,y1}]                  // stairs: floor height goes y0 at x0 -> y1 at x1
  gangways: { front: {x,z0,z1,y}, rear: {...} } // where the walkable area continues into the next car
  seats: [{ x,y,z, yaw }]                       // eye position of a seated passenger; yaw 0 faces +X
  doors: [{ x, side, width, sillY }]            // side +1 = right (+Z), -1 = left (-Z)
  cabEye: [x,y,z] | null                        // driver's eye (front cab faces +X, rear cab faces -X)
}
```

### Landmarks (src/js/50_landmarks.js) — landmarks agent
```
Landmarks.build(ctx) -> { group, list: [{ name, lat, lon, x, z, y, blurb, radius }], update(dt, env) }
Depots.build(style, opts) -> THREE.Group      // historic/modern station buildings, origin at ground center,
                                               // long axis along +X (parallel to the track), track side = -Z
ctx = { ll2w, groundY(x,z), rng }              env = { night, time, camPos }
```

### Life (src/js/60_life.js) — life agent
```
Life.createPeople(max) -> People   (GPU-animated instanced low-poly humans, many outfits)
  people.mesh; people.set(i, x,y,z, yaw, mode, phase) mode 0 stand, 1 walk, 2 sit; people.count = n; people.update(dt)
Life.createTraffic(roads, opts) -> { group, update(dt, env) }   roads: [{pts:Float32Array xyz..., lanes, speed}]
Life.createAirTraffic(ctx) -> { group, update(dt, env) }       SFO + SJC arrivals/departures on real runways
Life.createTrees(kind, max) -> { mesh, add(x,y,z,scale,rot,tint), commit() }
       kinds: 'oak','redwood','eucalyptus','palm','sycamore','cypress','pine','street'
Life.createBirds(ctx) -> { group, update(dt, env) }             gulls over the bay, pelicans, crows in town
```

### Sound (src/js/70_sound.js) — audio agent
```
Sound.init()  (call from a user gesture)   Sound.setMuted(bool)   Sound.setVolume(0..1)
Sound.train({ kind, speed, accel, power, onboard, inCab, tunnel, doorsOpen, curve })   per frame
Sound.horn(on)  Sound.bell(on)  Sound.doorChime()  Sound.announce(text)  (chime + speechSynthesis)
Sound.crossings([{ dist, active }])  Sound.passby({ dist, speed, kind })  Sound.ambience({ city, bay, wind, rain, night })
```

### Net (src/js/80_net.js + server/) — net agent
```
Net.connect(url?)  Net.status -> { online, players, ping }   Net.setState(obj)  (throttled send)
Net.others() -> [{ id, name, color, mode, trip, s, car, x, y, z, yaw, speed }]
```

### Towns (src/js/30_towns.js) — towns agent
```
Towns.init(ctx) -> Promise                     loads data/baked/towns.bin
Towns.update(camPos, env)                      streams tiles in/out around the camera (time-sliced)
Towns.group                                    add to scene
Towns.roadsNear(x, z, r) -> polylines           (for traffic) ; Towns.buildingsAt(x,z) etc. as useful
ctx = { ll2w, groundY(x,z), trackDist(x,z) -> m to nearest track centerline, stationList }
```
