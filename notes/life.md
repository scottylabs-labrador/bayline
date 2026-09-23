# Life (src/js/60_life.js)

This module fills the world with people, road traffic, SFO/SJC air traffic, trees and birds. All of it is instanced. Animation runs in the vertex shaders: walk and sit cycles, wind sway, wing flaps, strobes. Each system costs a handful of draw calls and almost no CPU.

**Preview:** `preview/life.html`.

| Hash | Shows |
|---|---|
| `#show=people` | Platform crowd |
| `#show=people&close=1` | Seated passengers seen from about 1 m |
| `#show=people&lineup=1` | A row of people facing the camera, for close-ups. Extra keys: `n`, `mode=0\|1\|2` (stand, walk in place, sit), `kinds=commuter,office,…`, `seed=` or `seeds=77,79`, `yaw=` (1.5708 faces the camera), `sp=` (spacing, m). Aim with `cam=-1.5708,0.02,2.4&target=0,1.95,0` for 2.4 m, or `…,1.3&target=-0.5,2.4,0` for faces. |
| `#show=traffic` | Road traffic |
| `#show=air` | Planespotting at Coyote Point. It auto-seeks to the moment an arrival passes. |
| `#show=air&follow=N` | Chase aircraft N |
| `#show=trees` | Species gallery plus an oak savanna for the far LOD |
| `#show=birds` | Birds |
| `#show=all` | Everything together, around Millbrae station at real world coordinates |

Extra parameters:
- `night=1`
- `t=<sim seconds>`
- `speed=<x>`
- `n=<people>`
- `density=<cars/km/lane>`
- `wind=<0..1>`
- `target=x,y,z`, a local offset from the scene origin
- `cam=az,el,dist`

Controls: drag to orbit, shift- or right-drag to pan, wheel to zoom. `window.preview.stats()` returns fps, update ms, draw calls, triangles and the per-model triangle counts.

## Conventions (same as SPEC)

- **Units and axes:** meters; +X east, −Z north, +Y up.
- **yaw:** 0 faces +X. Positive yaw turns toward −Z (north), so facing = (cos yaw, 0, −sin yaw). This matches `Object3D.rotation.y`, and TrainKit seats use the same convention (yaw 0 faces +X).
- **Model frames:** +X forward, +Y up, +Z right.
- **Precision:** every set keeps an anchor as its mesh or group `position`. Instance coordinates are small, so float32 stays sub-millimeter anywhere in the 100 km world.
- **Shared uniforms:** the engine must update `U.uTime.value` (seconds), `U.uNight.value` (0..1) and `U.uWind.value` (0..1) every frame. All Life shaders read them.

## API

### People

`Life.createPeople(max, { seed }) -> people`

Draws one InstancedMesh (plus its shadow pass), with one skinned-looking pose per instance.

- **`people.mesh`**: add it to the scene, or to a car group.
  - Instance positions are in the mesh's local frame.
  - Set `mesh.position` to a nearby anchor, or parent the mesh to a `Car.group`.
- **`people.set(i, x, y, z, yaw, mode, phase?, speed?)`**
  - `(x, y, z)` is the floor point under the hips.
  - `mode`: 0 stand, 1 walk, 2 sit. Mode changes blend over about 0.25 s inside `update()`.
  - `speed`: walking speed in m/s (default about 1.35). It sets the gait frequency, so feet do not skate.
  - `phase`: optional gait phase offset.
  - `count` grows automatically to cover `i`.
- **`people.sitAtEye(i, ex, ey, ez, yaw)`**: seats person i from a seated-eye position, such as `car.seats[k]`. The seat is 0.46 m over the implied floor, whatever the person's height; the hip joint sits 4 cm above it (the cushion gives) and the shins angle forward until the feet reach the floor (short people and kids dangle).
- **`people.look(i, { kind, seed, override })`**: re-rolls one person's appearance.
  - Kinds: `commuter`, `office`, `student`, `tourist`, `cyclist`, `kid`, `senior`.
  - Each person is seeded by default.
  - The variety comes from:
    - ten skin tones, beards (stubble or full), glasses or sunglasses;
    - hair: buzz, short, shoulder-length, bun, curly, ponytail; greys for seniors;
    - headwear: ball cap, beanie (knit ribs, folded cuff), cycling helmet (vents), sun hat;
    - tops: tee, open jacket, hoodie (hood, drawstrings, pocket), tucked button-down (collar, placket, buttons), sweater (ribbed hem), blazer or vest (V front over a shirt);
    - bottoms: straight-leg trousers (belt, back pockets), shorts, A-line skirts and dresses (tights or bare legs, ankle or crew socks);
    - carry items: backpack, rolling luggage, shopping bag, phone (its screen glows at night), briefcase, bike being walked;
    - height, girth (with a belly), figure (waist, hips, bust), kids' head proportions and short sleeves.
- **Other members:**
  - `people.hide(i)`
  - `people.count` (get and set)
  - `people.heightOf(i)`
  - `people.max`
- **`people.update(dt)`**: call it every frame. It blends mode changes and refits the culling sphere after moves.
- **Seated hands:** seated people rest their forearms on their laps, palms down. Bags, luggage and bikes are stowed while seated; phones stay out.
- **Constants:** `Life.PERSON = { standEye 1.61, sitEye 1.22, seatHeight 0.46, height 1.72 }`. `Life.makeLook(seed, kind)` is exported; a look also carries `fem`, `beard`, `glasses`, `outer` and `style2 = [top style, figure, socks]`, and any of them can be forced through `look(i, { override })`.

#### How the people are built (v2)

- **One super geometry, one draw call (plus the shadow pass).** Every person is the same indexed mesh holding all variants; the vertex shader poses it and collapses hidden variants to a point before doing any posing work. Hair and headwear each share one skull shell that the shader reshapes: curly hair puffs the hair cap out, a helmet thickens and lengthens the hat shell, a beanie loosens it.
- **Anatomy:** lofted from superelliptic cross-section tables (`HEAD_T`, `TORSO_T`, `PELVIS_T`, `THIGH_T`, `SHIN_T`, `SHOE_T`, `UARM_T`, `FARM_T`, `HAND_T` at the top of the PEOPLE section, scale 1 = 1.72 m), about 7.5 heads tall, with smooth normals: a jaw and chin, brow and eye sockets, a nose, ears, a deltoid, calves, knee caps, tapered forearms, curled hands with thumbs, shoes with a heel, toe spring and a sole line. The skeleton is unchanged: hip (0, .9, 0), knee (0, .47, 0), ankle (0, .085, ±.093), shoulder (0, 1.4, ±.195), elbow (0, 1.12, ±.205), neck (0, 1.47, 0).
- **Attributes:** `aMeta` is (part, slot, style flag, occlusion + 2 × lod). Per instance: `aAnim`, `aBody` (girth, head scale, idle seed, short sleeves + 2 × beard + 8 × glasses), `aStyle` (hair, headwear, carry, bottom), `aStyle2` (top style, outer colour, figure, socks), `aCol0`, `aCol1`.
- **Painting instead of triangles:** eyes (white, iris, lid line), brows, lips, beards, glasses, sole bands, socks, belts, short sleeves, shorts hems, open jacket and blazer fronts with the shirt showing, plackets and buttons, hoodie pocket seams, knit ribs, back pockets, helmet vents and fingers are painted per fragment from the unposed model position. Details are skipped where a pixel is wider than about 1 cm, so small people cost little.
- **Shading:** `MeshStandardMaterial` with per-slot roughness (skin 0.52, hair 0.45, fabrics 0.6–0.9, hard-shell luggage and helmets 0.3, metal) and baked crease occlusion that darkens indirect light at the crotch, armpits and under the chin.
- **Motion:** the walk keeps the stance foot flat and on the ground (the pelvis dips at each heel strike), the swing foot toes down after push-off, the forward arm bends more; standing people shift their weight slowly from leg to leg (the free knee relaxes, the pelvis tilts), breathe, look around and tilt their heads; seated people rest their hands palms down; phone users look down at a lit screen.
- **Level of detail:** tiny details (nose, ears, thumbs, drawstrings, shirt collar, backpack straps and pocket, bag handles) are drawn only within about 26 m and never in the shadow pass. A full coarse-body LOD was built and measured, then removed: with one InstancedMesh, hidden geometry costs about as much as visible geometry, so the extra body made crowds slower, not faster.

### Trees

`Life.createTrees(kind, max, { lodDistance, farShadows }) -> trees`

Each set has two InstancedMeshes: near (detailed) and far (about 30–90 tris).

- **Kinds:**
  - `oak` (coast live oak), `redwood`, `eucalyptus` (blue gum), `palm` (Canary Island date palm), `fanpalm` (Mexican fan palm), `sycamore` (London plane), `cypress` (Monterey), `pine` (Monterey), `street`.
  - Aliases: `fan`, `plane`, `date`.
- **`trees.mesh`**: a Group. Add it to the scene.
- **`trees.add(x, y, z, scale = 1, rot?, tint?)`**
  - Takes world coordinates. The first `add` sets the anchor.
  - `scale` 1 is a typical specimen (oak 9.5 m, redwood 44 m, eucalyptus 36 m, palm 14 m, fan palm 23 m, sycamore 16 m, cypress 14 m, pine 22 m, street 7.5 m).
  - `rot` is random if omitted (deterministic from position).
  - `tint` is a brightness number or `[r, g, b]`.
- **`trees.commit()`**: call it after a batch of adds.
- **`trees.update(camPos)`**: call it every frame. It rebuckets near and far only after the camera moves more than 30 m. Without it, everything stays in the near LOD.
- **LOD distances (m):** oak 300, redwood 650, eucalyptus 520, palm 380, fan palm 450, sycamore 320, cypress 320, pine 380, street 240.
- **Other members:** `trees.clear()`, `trees.count`.
- **Look:**
  - Foliage uses soft "volume" normals, per-triangle color variation, height and crown AO, and flat vertex colors, all with one material.
  - Wind: the whole tree sways (quadratic in height) plus a crack-free leaf flutter, driven by `U.uWind`.

### Traffic

`Life.createTraffic(roads, { seed, density = 11, maxCars = 600, laneWidth = 3.5, typeWeights, lightPools = true }) -> traffic`

- **Road format:**
  ```
  { pts: Float32Array|number[]|[{x,y,z}] (world xyz), lanes (total, both directions), speed (m/s), oneway?, bus? }
  ```
  - Two-way roads put `lanes / 2` lanes on the right-hand side of each direction.
  - One-way lanes are centered on the polyline.
- **Vehicles:** sedans, SUVs, pickups, vans, city buses (only on roads under 20 m/s) and box trucks (more on fast roads). They have no logos, and paint follows the real color distribution (mostly white, black, greys and silver).
- **Motion:**
  - Intelligent-driver-model car following per lane gives spacing, speed variety and brake lights.
  - Cars scale in and out over 6 m at polyline ends and recycle to the start.
- **Draw calls:** 6, plus 6 flare meshes at night, plus 1 headlight-pool mesh.
- **`traffic.setRoads(roads)`**: re-streams to new roads with no GPU reallocation. Use it for tile streaming, for example with `Towns.roadsNear(x, z, 1500)` every few hundred meters.
- **`traffic.update(dt, env)`**: `env.night` is optional and falls back to `U.uNight`.
- **Other members:** `traffic.count`, `traffic.cars`, `traffic.lanes`.
- **Night:**
  - Emissive lamps.
  - Camera-facing additive flares: headlights are brighter seen from the front, tail lights from behind, and brake lights pulse.
  - Soft light pools on the road ahead.

### Air traffic

`Life.createAirTraffic({ ll2w = Geo.ll2w, groundY? }) -> air`

- **`air.update(dt, env)`**: `env.time` is sim seconds since local midnight. The schedule is a pure function of time, so every multiplayer client sees the same planes.
- **Runways:** from OpenStreetMap.
  - SFO 28L/28R (landings), 1L/1R (departures).
  - SJC 30L/30R.
  - PAO 31 and SQL 30 (general aviation).
  - Runway ends are exported as `Life.RUNWAYS`. Field elevation comes from `groundY` at both runway ends, clamped to no lower than the surveyed value minus 3 m.
- **Arrivals:**
  - Straight-in 3° approach from 24 km at about 150 kt.
  - Gear drops about 11 km out.
  - Flare and touchdown about 400 m in, then braking and rollout.
  - Exit toward the terminals (SFO left, SJC right), taxi, fade.
  - SFO lands side-by-side pairs on 28L/28R.
- **Departures:** hold, 36 s roll, rotation, gear up, climb-out turn on course, fade far away.
- **Traffic levels:**
  - SFO: about 48 arrivals and 50 departures per hour.
  - SJC is lighter.
  - Nights (23:00–05:00) are sparse.
  - Wide-bodies are 25% at SFO and 5% at SJC, with a variety of tail colors.
- **General aviation:** Cessnas fly closed touch-and-go circuits at PAO and SQL (about 245 m pattern, right traffic over the baylands).
- **Models:** narrow-body (737/A320-like), wide-body (787/A350-like) and Cessna.
- **Lights:** landing lights, gear taxi light, red and green nav lights, white tail light, double-flash strobes and a red beacon. They show both as emissive geometry and as flares.
  - Distant lights keep a minimum screen size, so arrivals over the bay read as a line of lights at night.
- **Draw calls:** 5 aircraft meshes plus 5 flare meshes. Frustum culling is disabled for them because they move across the map.
- **`air.positions()`**: returns `[{ field, type, x, y, z, heading, scale }]` for a minimap or camera. It allocates, so do not call it per frame.

### Birds

`Life.createBirds({ ll2w, groundY, spots? }) -> birds`

- **Defaults:** real spots from lat/lon.
  - Gulls circling over Mission Bay, the Ferry Building, Sierra Point, Millbrae bayfront, Coyote Point, Foster City, Redwood Shores, Redwood City port, the Palo Alto Baylands, Shoreline, Sunnyvale baylands and Alviso.
  - Brown pelican lines skimming the water along the shore.
  - Crows over downtowns.
  - Pigeons walking and pecking near SF, Palo Alto, Mountain View, Diridon, Millbrae, San Mateo and Redwood City stations. They sometimes flutter up.
- **Custom spots:** `ctx.spots = [{ kind: 'gull'|'pelican'|'crow'|'pigeon', x, y?, z, count, radius, height, length, heading }]`.
- **Behavior:** fully GPU-driven with glide/flap cycles, banked turns and folded wings on the ground. `birds.update()` is a no-op, and the draw cost is 4 draw calls.

### Misc

- `Life.stats()`: per-model triangle counts.
- `Life.TREE_KINDS`.

## Performance

Measured in `preview/life.html#show=all&n=600&density=20` with the real GPU on a MacBook, at 1400×900.

**Stress run:** 600 people, 500 cars, 1,990 trees, 18 aircraft and birds.
- Held 60 fps (vsync).
- 94 draw calls in total, including the preview's own props and the shadow pass.
- About 1.7 M triangles counted by `renderer.info`, including the shadow pass.
- CPU for all Life updates: 0.21 ms per frame.

**Per-model triangles:**

| Model | Triangles |
|---|---|
| Person (all variants packed) | 3,384 (2,101 vertices). Body 1,786; visible per person about 2,050–2,370 (tee, short hair and backpack 2,104; blazer and briefcase 2,064; hoodie, long hair and backpack 2,370). Hidden variants collapse to degenerate triangles. v1 was 1,986 packed, about 1,100–1,250 visible. |
| Oak (near / far) | 672 / 28 |
| Redwood | 777 / 45 |
| Eucalyptus | 932 / 28 |
| Canary palm | 1,224 / 90 |
| Fan palm | 584 / 38 |
| Sycamore | 576 / 40 |
| Cypress | 484 / 40 |
| Pine | 476 / 40 |
| Street tree | 340 / 36 |
| Car | about 500 |
| Box truck | 668 |
| Narrow-body | 1,106 |
| Wide-body | 1,186 |
| Cessna | 440 |

**Nothing allocates per frame.** The exceptions are `air.positions()`, and `setRoads()` / `add()` when you call them.

## Integration notes (for the lead and other agents)

- **Engine loop:**
  - Set `U.uTime`, `U.uNight` and `U.uWind` each frame.
  - Call:
    - `people.update(dt)`
    - `traffic.update(dt, env)`
    - `air.update(dt, env)`, with `env.time` = sim time
    - `trees.update(camPos)` for every tree set
  - Birds need nothing.
- **Station crowds:**
  - Use one `createPeople(n)` per station area, with `mesh.position` at the station (for example the platform center at platform height).
  - Place waiting passengers in platform-local coordinates. Facing the track means yaw = the track bearing ± 90°.
  - Walkers call `set()` each frame with mode 1 and their speed.
  - When a train arrives, walk boarders to door positions (`car.doors`), then hide them.
- **Onboard passengers:**
  - Use one People set per car, with `people.mesh` added to `car.group`, which is the car-local frame.
  - Seat passengers with `people.sitAtEye(i, seat.x, seat.y, seat.z, seat.yaw)`. Standing passengers use `set(i, x, floorY, z, yaw, 0)` inside `car.floorRegions`.
  - That costs 7 draw calls for a 7-car consist.
  - Turn `people.mesh.castShadow` off inside cars if shadows are not needed there.
- **Towns:**
  - Please expose `Towns.roadsNear(x, z, r)` in the traffic format above. `pts` is world xyz with `y` on the road surface; add `lanes` and `speed` from the OSM `lanes`/`highway` class, and `oneway`.
  - Suggested speeds (m/s): motorway 29, trunk/primary 17, secondary 15, residential 11.
  - Re-call `traffic.setRoads(...)` when the camera moves more than about 500 m.
  - Towns can also use `createTrees('street'|'sycamore'|'palm'|'fanpalm')` for street trees. The lead can use `oak` (hills), `redwood` (Santa Cruz Mountains skyline), `eucalyptus` (windbreaks, Stanford, SF Presidio edge) and `cypress`/`pine` (coastal and park areas).
  - Keep sets regional (for example per town tile) so culling works.
- **Aircraft:**
  - Pass `groundY` so wheels meet the runway surface.
  - The terrain and water should flatten SFO to about 4 m and SJC to about 18 m.
  - Aircraft never leave their own flight paths, so they do not interact with other modules.
- **Birds:** pass `spots` from station platform coordinates if you want pigeons exactly on platforms. The defaults use station lat/lon plus a small offset.
- **Sound:** `air.positions()` can feed jet pass-by sounds if the audio agent wants them. Throttle it to about 2 Hz, because it allocates.

## Known limits

- **Traffic:**
  - Cars follow only their own lane. There are no lane changes, signals or intersection logic, so cars on crossing polylines pass through each other.
  - Vehicles scale in and out at dead-end polylines.
- **Aircraft:** they appear by scaling up at the runway hold point and vanish on the taxiway or about 25 km out. There are no ground ops at the gates.
- **People:**
  - The triangle count reported by `renderer.info` includes hidden variant geometry (3,384 per instance).
  - **Cost of the v2 people:** 200 people on the preview platform at 1920×1080 on the M2 cost about 3.5–4.8 ms of GPU per frame against 1.7–2.4 ms for v1, so roughly 2 ms more (the best of interleaved runs; the GPU was shared with other build agents, so single runs varied by ±50%). At 480×270 it was 3.6 vs 1.9 ms, so most of the cost is per vertex and per submitted triangle, not per pixel. `preview/life.html#show=people&n=200` is the benchmark scene.
  - Rigid limbs meet at the elbows, knees and the shirt hem, so up close (under about 1.5 m) you can see small jagged seams where two parts cross.
  - In `onboard` mode the camera can sit about 20 cm from a neighbour's head, where the low-poly ear and hair shells show.
  - People do not avoid each other; pathing is the engine's job.
  - A change of `speed` shifts the gait phase slightly.
- **Birds:** they do not cast shadows or avoid anything.
- **Flares:** they are depth-tested but not occlusion-queried, so a flare can peek over the edge of a nearer object by its radius.
