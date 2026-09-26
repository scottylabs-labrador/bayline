# Bayline Metro trains (MetroKit) — status

Workstream: trains · branch `bart-trains` · worktree `.worktrees/bart-trains` · dev port 8133.
Owner files: `src/js/41_metrokit.js`, `src/js/42_*.js`, `preview/metro.html`, `notes/bart/trains.md`, `notes/bart/shots/trains/`.

## Status

- 2026-09-26 (session 1, later): the Antioch DMU (GTW 2/6-like, articulated on bones) and the airport people mover
  (Cable Liner-like) exist; lamp glow billboards; the D-car cab rebuilt after the 2014 mock-up; the body's cant line
  lowered to 2.9 m after the Lake Merritt photo; interior brighter, teardrop straps, ad frames; standing spots.
- 2026-09-26 (session 1): MetroKit v1 on `bart-trains`: Fleet of the Future-type D/E cars (exterior, plug doors on
  bones, trucks with yaw + spinning wheelsets, collector shoes, couplers, decals with per-car numbers, LED signs behind
  the glass, interior-mapped windows), interiors (saloon: seats, poles, straps, partitions, screens, signs, end walls;
  D-car cab: console, ATC + status screens, controller on a bone, seat), LOD1/LOD2, far batch with billboard lamps.
  Next: DMU (GTW 2/6), people mover, night glow billboards on near trains, nose/interior polish, in-game QA.

## Numbers for stations (authoritative; MetroKit geometry uses exactly these)

| quantity | value | source |
|---|---|---|
| **Car floor = door threshold height above top of rail** | **0.991 m (39 in)**, nominal (new wheels, empty car) | BART system facts: "nominal height from top of rail to floor 3 ft 3 in"; BART platforms are 39 in (991 mm) |
| **Body half-width at the door threshold** (car side, doors closed, flush plug doors) | **1.600 m** (carbody 126 in = 3.200 m) | BART: "Nominal width at carbody (at closed door panels) 126 in (130 in)" |
| half-width over the OPEN door leaves (micro-plug leaves slide outside the body, bottom edge ~2 cm above the floor) | 1.651 m (130 in / 2) | same |
| suggested platform edge from track centreline | 1.676 m (1.600 + 76 mm ADA max gap); the stations team's 1.68 m is fine | ADA 3 in max horizontal gap |
| platform top above top of rail | 0.991 m (same as the floor: level boarding) | |
| car length over coupler faces (D and E) | 21.336 m (70 ft); 10-car train 213.36 m (platforms 700 ft = 213.4 m) | BART |
| door centres along the car (both sides) | x = 0 and ±5.33 m from the car centre (car-local), 3 per side, same on D and E cars | photogrammetry (cross-ratios on a side-on photo of a 10-car train, 5 estimates 5.29–5.37 m) + BART 2014/2015 floor plans |
| door clear opening | 1.372 m (54 in) wide, ~1.93 m high | BART board presentation 2014 ("54 inch door opening") |
| **collector shoes (4 per car, both sides of both trucks)** | contact face **+0.171 m** above top of rail over lat **1.43–1.57 m** (centre 1.50; infra's rail head 1.461–1.537), shoe 0.38 m long with upturned ends; arm pivots on a longitudinal pin at lat 1.28 m / +0.228 m (inboard of the coverboard edge 1.339 m); everything under the coverboard stays below +0.232 m; nothing beyond lat 1.57 m | infra's published contact rail (notes/bart/infra.md "Third rail"); shoe envelope checked against it |
| shoe on the rail / free | the shoe over the rail rides its contact surface (ramp heights included); the other hangs tilted, its face ~+0.09 m (0.08 m below contact), so the 76 mm end ramps (down to +0.095 m) lift it on | per truck from `MetroTrack.thirdRail(track, s)` in `MetroKit.poseOnTrack` (LOD 0 cars) |

The "42 in (1.07 m)" figure the stations team found does not match any BART source I could find; BART's own
facts page and the platform standard both give 39 in. Always read `car.doors[i]` (x, side, width, sillY) from the
MetroKit metadata at runtime; `sillY` will be 0.991.

## API (MetroKit, `src/js/41_metrokit.js` + `42_metrokit_*.js`)

Modelled on TrainKit (notes/trains.md); same car-local frame and metadata conventions.

```js
const c = MetroKit.createConsist('bart' | 'dmu' | 'apm', { cars, seed, name, order, destination })
  // bart: exactly `cars` cars (2..12); default orders D-E..E-D, 7+ cars = two units cab to cab
  // (7 'DED DEED', 8 'DEED DEED', 9 'DEED DEEED', 10 'DEEED DEEED'); order: a string like 'DEED DEED' to override.
  // car 0's cab at the consist's +X end, the last car flipped (TrainKit convention)
c.cars, c.length (21.336 m per BART car), c.kind, c.speed (m/s, signed: + toward +X)
c.setDestination(text, lineColorHex) | c.setDestination({ line: 'yellow', color, text })   // front + side LED signs
c.setNextStop(text)                           // interior end-wall LED signs (also set by setDisplay)
c.setDoors('left' | 'right' | 'both' | 'none', t)   // consist frame, +Z = right; doors take 2.2 s to open, 2.8 s to close
c.openDoors(side); c.closeDoors(side)       // closeDoors plays the chime first: onEvent('chime', side), then closes
c.onEvent = (type, side, consist) => {}     // 'chime' | 'doors-opening' | 'doors-open' | 'doors-closing' | 'doors-closed'
c.setLights({ head, tail, interior, cab, signs, lead: 'front' | 'rear' }); c.setLeadEnd(lead)
    // lead cab: white headlights + markers + amber top bar; trailing cab: red tails + red top bar
c.setNight(n)                                // 0 day .. 1 night (early-outs when unchanged)
c.setDisplay({ line, color, lineName, destination, nextStop, arriving, doors: 'left'|'right', transfer, stops: [..], index, clock })
c.setCab({ speedMph, atcCodeMph | codeMph, targetMph, effort | notch, mode: 'ATO'|'MANUAL', doors, nextStop, distFt, clock,
           cars, destination, lineColor | color, alarm | atc: 'ok'|'warn'|'brake'|'penalty', handle })  // ~8 Hz redraw max
c.setInteriorVisible(bool) / car.setInteriorVisible(bool)   // builds the interior lazily (cached per design)
c.setLoad(f)                                 // 0 empty .. 1 crush: passengers seen through the windows (default 0.3)
c.setThirdRail(side, top = 0.171)            // previews without MetroTrack: contact rail on the consist's +Z (1) / -Z (-1)
                                             // side or none (0); poseOnTrack sets the shoes from MetroTrack by itself
c.setLOD(0|1|2) / car.setLOD(level)          // 0 full, 1 one mesh per car, 2 a banded prism (built lazily)
c.update(dt)                                  // doors, wheel spin, bone upload for LOD0 cars; no allocations
c.dispose()                                   // per-consist GPU resources (design geometry stays cached)
MetroKit.poseCar(car, F, R, roll)            // as TrainKit.poseCar
MetroKit.poseOnTrack(c, frame, dFront)       // frame(d, out) -> out {x, y, z, tx, ty, tz, bank}; d grows toward +X;
                                              // poses every car from its bogie pivots and yaws the bogies; with
                                              // MetroNet frames (out.track, out.s, out.sign, out.rx/rz) and MetroTrack in
                                              // the build it also puts each truck's shoe on the contact rail
car.setBogies(F, R)                           // bogie yaw from pivot frames (for callers that pose cars themselves)
MetroKit.createFarBatch(scene, { maxCars, maxLamps })  // every distant train in one instanced draw per car design:
  far.begin(); far.addCar('bart', 'D'|'E', matrix4 | {x,y,z,yaw,pitch,roll}, flip); far.addLamp(x, y, z, 'head'|'tail'); far.end(night)
MetroKit.setQuality('low'|'medium'|'high'|'ultra'|'max' | 0..4)   // applies to designs built afterwards
```

Per car (as TrainKit): `group` (rotation order YZX), `length`, `width`, `height`, `offset`, `number`, `bogieOffsets
[front, rear]` (±7.62), `floorRegions`, `ramps` ([]), `gangways` ({front, rear}: end doors, `emergency: true`), `seats`
(eye positions, yaw 0 = +X, + `color`), `doors [{x, side, width 1.36, sillY 0.991}]`, `cabEye` (D: [9.3, 2.26, 0.72]
unflipped) and `cabYaw`.

## Costs (measured in preview/metro.html#view=exterior&cars=10&measure=1, consist only, no shadows)

| | draw calls | triangles |
|---|---|---|
| 10-car train, LOD0 exterior | 20 (body + glass per car) | 306k (D 32.6k, E 29.2k per car at quality 2) |
| + interior of one car | +2 | +31-32k |
| 10-car train, LOD1 | 10 | 10.9k |
| 10-car train, LOD2 | 10 | 1.0k |
| far batch (all far trains) | 1 per car design + 1 for all lamps | 72-152 per car |

Build times (M2, first use, then cached): D exterior 95 ms, E 38 ms; interiors 21-36 ms; GTW unit 65 ms; APM cars 22 ms.

Render time (preview, 1600 x 900, sun shadows on, `#gpu=1`: render + gl.finish, median of 40, with minus without the
train): 10-car train exterior 3/4 view 0.3 ms, side view 0.2 ms, inside a car (interior of that car built) 0.6 ms.
DMU unit: 27k triangles, 2 draws (+1 glow at night); APM car: 4-6k triangles, 2 draws.

## Preview

`python3 tools/devserver.py 8133`, then `http://localhost:8133/preview/metro.html#view=<v>` with views exterior, nose,
front, cabside, side, doors, bogie, roof, ends, rear, interior, seated, cab, night-exterior, night-interior, night-nose,
lod, curve, dmu, apm. Options: `&cars=N`, `&order=DEED`, `&line=red&dest=Richmond`, `&meta=1` (walking metadata),
`&clean=1` (no HUD), `&q=0..4` (quality), `&measure=1` (costs to the console), `&night=1`, `&doors=1`.
In game: `#auto&metro=1&t=08:05&mst=WOAK`. Screenshots: `notes/bart/shots/trains/`.

## Research: Fleet of the Future (D and E cars), references and dimensions

Car-local frame (same as TrainKit): origin at the car centre on top of rail, +X toward the car's front (the cab end of a
D car; the "Y end" of an E car), +Y up, +Z to the right when facing +X. Metres.

| item | value | source / method |
|---|---|---|
| length over coupler faces | 21.336 m (70 ft), D and E | BART system facts |
| carbody (end wall to end wall) | 20.94 m (±10.47); D-car nose also at +10.47 (windscreen base, centreline) | photos (inter-car gap ~0.4 m), BART plans |
| width | 3.200 m max (126 in) at the door panels / belt; 1.651 m half-width over open door leaves | BART facts |
| height rail→roof | 3.864 m (12 ft 8-1/8 in) | BART facts |
| floor / threshold | 0.991 m (39 in) | BART facts, platform standard |
| interior width | 2.94 m at seat level | BART 2014/2015 floor plans (measured) |
| centre ceiling | ~2.16 m above the floor (legacy 6 ft 9 in + ~4 in) | BART "New Features" |
| doors | 3 per side, centres 0 and ±5.33 m, clear 1.36 m × ~1.94 m; micro-plug leaves 0.83 m wide slide OUTSIDE the body, pull in 19 mm (3/4 in) when closing | photogrammetry + plans + BART features page |
| door leaf window | 0.58 × 0.91 m, offset to the meeting edge (inner margin 0.045 m) | Lake Merritt 2026 photo |
| side windows | glass 0.87 × 0.85 m (0.97 × 0.95 with the black gasket), pairs with 0.11 m mullion; E car pairs centred ±2.66 and ±8.00 m; D car cab end: one window at +7.51 | plans + photos |
| cab | full width, 1.5–1.9 m deep (rear wall +8.46 operator side, +8.75 other side, +8.98 at the aisle door); operator on the RIGHT (+Z), destination sign behind the LEFT windscreen, centre emergency door | plans, photos (operator visible through the right-hand windscreen) |
| seats | E 54, D 47 (production); 20 in wide, 18 in cushion height, 27 in legroom; blue vinyl (Pantone 7706-ish) and lime priority seats (Pantone 390) | BART; BARTCHIVES |
| layout (final, 2015 "middle door configuration") | ends: 3 rows of 2+2 transverse seats facing the car centre + a longitudinal pair next to the end door; wheelchair areas both sides of the centre door; hanging straps at the centre door; "tripod" poles at the end doors; bike areas (lean bar + strap) one near each end door | BART board presentation June 2014; BARTCHIVES layout |
| trucks | 2 per car, 2 motored axles each (194 hp per axle), air springs; centres assumed ±7.62 m (50 ft), wheelbase 2.13 m, wheels 30 in (0.762 m) new | BART facts; centres/wheelbase ASSUMED |
| third-rail shoes | on both sides of each truck, top-contact paddle | photos; exact position ASSUMED (see requests) |
| propulsion | Bombardier MITRAC, regenerative braking, 1000 V DC third rail | railway-technology.com |
| exterior | brushed natural aluminium body (extrusions, double skin, huck bolts); white fibreglass cab cap with a black glazed mask (two windscreens + centre door); BART-blue (#1b86c8-ish) swoosh on the cab sides and 0.82 m blue bands at the E-car ends; white ribbed roof with the car number painted large at each end; thin dark belt line at floor+0.68 m | photos (Commons: 60+ photos reviewed) |
| lights | teardrop headlight pods (2 LED clusters each) below the windscreens; lower corner pods (red tail / white marker); top light bar amber when leading, red when trailing; red door-status lamps at the top of the window beside each door; exterior LED signs (line-colour square + terminal in amber) in the window beside the doors and behind the left windscreen | photos |
| interior | off-white molded walls, dark grey speckled floor (Marmoleum), lime end walls with an end door and an amber LED next-stop sign, two long LED light strips in the sloped ceiling, flat centre ceiling with diffusers and CCTV domes, overhead longitudinal grab rails with black hanging straps, stainless poles, 6 PIS screens (one per door per side) with a dynamic route map | photos, BART |
| cab | light grey console, two touch displays (VATC speed arc: ACTUAL / AUTHORIZED / COMMANDED, tractive-effort bar; status screen), keypad on brushed panel, red mushroom e-stop, T-handle master controller ("MANUAL CONTROL"), radio handset on the left wall, roller sun blind, dark navy pinstripe seat | 2014 cab mockup photo |
| ATC speed codes | 0, 6, 18, 27, 36, 50, 70, 80 mph | BARTCHIVES ATC page |

### eBART (Antioch–Pittsburg): it is a Stadler **GTW 2/6** DMU, not a FLIRT
Fleet 101–108; 2 low-floor aluminium end cars + a central steel power module (850 mm passage); length 40.89 m
(134 ft 1.8 in), width 2.946 m (9 ft 8 in), height 3.38 m (11.08 ft); 104 seats; 75 mph; standard gauge; up to 3 units
coupled; white/silver with blue swoosh ends like the FOTF. Floor ~0.61 m (ASSUMED, low-floor GTW). (BARTCHIVES eBART
page, Stadler fact sheet, Wikipedia.) MetroKit builds the GTW; `createConsist('dmu', {cars: n})` = n GTW units.

### Airport connector (Coliseum–OAK): Doppelmayr Cable Liner Shuttle
Four 3-car trains (113 passengers), cable-hauled on a steel truss guideway, 30 mph top; cars ASSUMED 9.3 m long,
2.7 m wide, 3.1 m tall; white with a full-height black glazing band and light-blue stripes; platform screen doors.

## Iteration log (screenshots in notes/bart/shots/trains/)

- **it1** (`it1_*.jpg`): nose compared with the head-on Dublin/Pleasanton 2016 photo: windscreens widened to the
  corner pillars (|z| 0.475-1.265), door window narrowed to 0.38 m, mask bottom 2.08 m, pods 1.52-2.13 m, bumper 1.07-1.27
  m, lower pods 0.86-1.12 m, white face ends at 0.87 m with the dark coupler pocket, coupler head at 0.8 m. Swoosh
  re-drawn from the El Cerrito 2021 photo (blue from the cab back to x 8.83 at the eaves / 9.70 at the skirt, white
  band behind tapering 0.58 -> 0.08 m). Aluminium brightened (albedo #dde0e3, metalness 0.88, roughness 0.34,
  anisotropic along the car); the NaN in the anisotropic tangent on faces normal to the car axis (the nose logo was
  black) is fixed. Interior compared with the March 2018 D-car interior photo (seats, poles, straps, light bands).
  Open: nose still reads flatter than the real cab; pods are ovals rather than teardrops; interior lacks the wall ad
  frames and the light-blue trim line; cab displays oversized.

- **it2** (`it2_*.jpg`, `it2_game_woak.jpg`): 3/4 view compared with the El Cerrito 2021 photo, the saloon with the
  March 2018 D-car interior photo, the cab with the 2014 cab mock-up. Cab now matches the mock-up's layout (L-desk,
  two displays VATC | status, keypad plate, e-stop, MANUAL CONTROL T-handle, sun blind); the body's white roof now
  starts right above the windows (cant 2.9 m); straps are teardrops; interior fill brighter (the ceiling reads white);
  nose ring palette bleeding fixed. In game (WOAK aerial, 10:30) the cars read as silver with the blue ends, passengers
  visible, window reflections of the street.

## Known issues / open problems

- The D car's front is close to the reference in the head-on view but still simpler in 3/4 views (corner pillars'
  recessed panels, the chin's curvature).
- The DMU and APM are first versions (simpler noses, simple interiors, no cabs).
- Headlight pods are ovals rather than the real teardrops; the corner pillars lack their recessed panels.

## Requests for other workstreams

- DATA: the Antioch vehicles are Stadler **GTW 2/6** (BARTCHIVES, Wikipedia "eBART"), not FLIRTs; please fix the
  wording in timetable `consist` / bart-data.md. I read `cars` for eBART as the number of GTW units (each ~40.9 m).
- INFRA: done (2026-09-26): shoes moved to your published contact rail (+0.171 m, lat 1.499 m; see "Numbers") and
  driven per truck from `MetroTrack.thirdRail(frame.track, frame.s)` inside `MetroKit.poseOnTrack` (the frames the sim
  passes carry MetroNet's track + s): the shoe over the rail rides it, ramps included, the other hangs free at ~+0.09 m.
  Nothing else needed from you; if the sim ever poses with frames without `track`/`s` the shoes keep their last state.
- LEAD: done in 62c83db (`MetroKit.setQuality` in applyTier), thanks.
- SIM: MetroKit is ready for all three kinds: `createConsist('bart' | 'dmu' | 'apm', { cars, seed })`. For 'dmu',
  `cars` = GTW units (each one MetroKit car of 40.89 m with articulated bodies; `c.cars.length === cars`); for 'apm',
  `cars` = cars (end, mid.., end). Please pose with `MetroKit.poseOnTrack` (it articulates the GTW and yaws bogies).
  Suggested: `MetroKit.createFarBatch(Env.scene)` for your far trains (real car silhouettes in one draw per design and
  billboard lamps that draw in this pipeline; GL points don't). Per-car `standSpots` [{x, y, z, yaw}] for standing
  passengers (feet on the floor), `seats` for seated ones (eye positions, like TrainKit). `consist.onEvent` fires
  'chime' / 'doors-opening' / 'doors-open' / 'doors-closing' / 'doors-closed' for the door sounds if you use
  `openDoors` / `closeDoors` (with `setDoors(side, t)` you drive the doors yourself and no chime event fires).
- STATIONS: the GTW's door sills are at 0.635 m above rail (ASSUMED: low-floor GTW), doors at x = ±6.4 m from the
  unit centre, 1.30 m clear; APM floor 0.36 m (ASSUMED), one 1.6 m door per car side at the car centre.
