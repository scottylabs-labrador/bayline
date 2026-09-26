# Bayline Metro trains (MetroKit) — status

Workstream: trains · branch `bart-trains` · worktree `.worktrees/bart-trains` · dev port 8133.
Owner files: `src/js/41_metrokit.js`, `src/js/42_*.js`, `preview/metro.html`, `notes/bart/trains.md`, `notes/bart/shots/trains/`.

## Status

- 2026-09-26 (promo, lead's brief "Aquarius"): **P17 p_rain_glass** (approved), the **P16 cab look** for SIM's
  p_tube_cab (`_metrolook.mjs` cabLook) and a **climax hero, p_nose_hero**; MetroKit's shot look (`MetroKit.look`),
  its cinema glass, per-car clear glazing that mirrors the car's interior, and fixes found on the way (below, "Promo").
- 2026-09-26 (M3.2, lead's promo item): **per-car LOD by apparent distance**. The 110 m LOD 0 radius now uses the
  distance x tan(fov / 2) / tan(27.5 deg) of the camera that last drew the cars (never more than the real distance, so
  game views are unchanged; the same rule as MetroSim's). In **capture mode** (`__bayline.capture.on`) every car within
  an apparent 600 m draws LOD 0, including cars in consists the sim put at LOD 1 (LOD 2 stays). Checked on a 10-car
  train (preview, `c._applyLod` with a test camera): 300 m at 55 deg: all LOD 1; 300 m at 11.4 deg (120 mm): all
  LOD 0; 700 m at 11.4 deg: LOD 1; capture at 500 m: LOD 0, at 700 m: LOD 1; a LOD 2 request stays LOD 2.
- 2026-09-26 (M3 polish round): **baked LODs** for all three vehicles: each design's full-detail exterior and its
  window impression are rendered once into an atlas and mapped onto new LOD 1 / LOD 2 meshes (~1.1k triangles, one
  draw per car): on Low (where LOD 1 is drawn at every distance) and for every car beyond 110 m the car now looks like
  the real one, day and night, with its doors opening; the far batch uses the baked LOD 2. **Per-car LOD** by camera
  distance (a long train or one seen from the air no longer draws every car at full detail). **Program prewarm**
  (`MetroKit.precompile`, automatic after boot). **Night windows**: far panes reflect the lit cabin; the people
  mover's panes are real openings with a white lining inside. Quality changes rebuild live trains (fixes a TypeError).
- 2026-09-26 (session 1, iteration 3): interior impression v2 in the exterior glass (the lit cabin, passengers by
  load, far windows showing the scene, a D-cab view), matching the real interior when it is built (A/B checked);
  collector shoes on infra's published contact rail, driven per truck from `MetroTrack.thirdRail` (checked in game
  against infra's build); body sway on the air springs; detailed trucks; GTW nose raked and repainted; ASCII-only
  sources. `bart` merged (62c83db).
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
c.setInteriorVisible(bool)                   // true: interiors allowed for a focus train (see "M3 gate"); the kit
                                             // draws them for the car nearest the camera and its neighbours only,
                                             // automatically within 45 m (c.intAuto = false turns that off)
car.setInteriorVisible(bool)                 // (direct, per car; builds the interior lazily, cached per design)
MetroKit.stats()                             // GPU memory estimate and counts (consists, cars, LOD0, interiors, draws,
                                             // triangles, shadow-caster triangles, MB incl. baked atlases)
MetroKit.precompile(scene, camera)           // compile every MetroKit program now (runs by itself after boot)
MetroKit.setRenderer(r)                      // the renderer for the bakes (default Env.renderer; previews pass theirs)
MetroKit.bakesSettled()                      // promise: every requested atlas is baked (previews, tests)
MetroKit.setWet(w | null)                    // force wetness 0..1 (null: follow MetroTrack.uWet, the rain)
c.setLoad(f)                                 // 0 empty .. 1 crush: passengers seen through the windows (default 0.3)
c.sway = true                                 // body sway on the air springs (default on; false = rigid body): roll
                                             // 0.07 rad per g of unbalanced lateral acceleration (v^2 k + g sin(bank), k
                                             // from the bogie tangents in poseOnTrack), pitch 0.02 rad/g under braking /
                                             // traction, track-excited rock and bounce tied to distance run; applied on
                                             // top of the group's pose in update(), bogies counter-transformed so they
                                             // stay on the rails; cameras attached to the car (cabEye, seats) ride along
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

## M3 gate (lead's items, 2026-09-26)

1. **Performance.** 10-car train at LOD0 exterior: **20 draw calls** (body + glass per car), 386k triangles; +1
   draw per car while its doors are open and its interior is not drawn (the doorway impression). Interiors: only the
   car nearest the camera and its neighbours (at most 3 cars, +2 draws / +33k triangles each), decided by MetroKit every
   update from the render camera; `setInteriorVisible(true)` from the sim only extends that to a focus train beyond
   45 m. Far trains: the sim's `createFarBatch` (one instanced draw per car design + one for all lamps). **Low tier:**
   cars never draw the full exterior (LOD 1, 1.1k triangles per car; the car you ride in keeps its interior).
   GPU time for the train (preview, 1600x900, render + gl.finish): 3/4 view 0.6 ms, side 0.2 ms, inside 0.7 ms.
2. **Phones / memory.** Low and Medium: 1024 px decal atlas (5.3 MB instead of 21.3 MB with mips), half-size
   passenger/cab screens (1.3 MB per consist with an interior instead of 5.3 MB). A quality change rebuilds live
   consists on the new designs and frees the old buffers, atlas and far-batch meshes (`setQuality`; checked:
   High 36 MB -> Low 14.8 MB -> High 36 MB on the same consist). `MetroKit.stats()` reports it. Measured with
   `MetroKit.stats()` in game at EMBR 17:30 (6-car train at the platform, interiors of 3 cars):

   | profile | MetroKit GPU memory | of which geometry / atlas / screens |
   |---|---|---|
   | desktop High, on the platform | 36.2 MB | 9.5 / 21.3 / 5.3 |
   | desktop High, riding (inside car 2) | 36.2 MB | 9.5 / 21.3 / 5.3 |
   | phone (--mobile, DPR 2) Medium, platform | 19.9 MB (now 15.9: half screens) | 9.2 / 5.3 / 5.3 -> 1.3 |
   | phone Medium, riding | 19.9 MB (now 15.9) | 9.2 / 5.3 / 5.3 -> 1.3 |
   | phone Low, platform | 14.8 MB | 8.0 (upper bound: the unused LOD0 buffers are never uploaded) / 5.3 / 1.3 |

3. **Clean console.** No MetroKit messages at EMBR, WOAK (D/E, with LOD0 + interiors forced), ANTC (GTW DMU) and
   OAKL (Cable Liner) with `#q=high`, nor in the preview's 20 views. (The only warning seen: Under's "camera is
   underground ... no cell claims it" at EMBR, infra's.)
4. **See-through open doors** (lead's RICH 17:40 check): fixed. At RICH the car nearest the player draws its
   interior (blue seats, far windows showing the outdoors), the cars further along with open doors draw the doorway
   impression; the player beside car 4 of 6 gets cars 3-5's interiors and doorway impressions on 1-2 and 6.

## Promo (lead's brief, 2026-09-26)

Shot modules (tools/trailer/shots/), contact sheets in `notes/bart/shots/promo/`. All three follow the same train, the
Yellow Line to Antioch through the Tube after 21:40 on 2026-09-29 (`__m.day` pins the date; SIM's `_metro.mjs`).
- **P17 `p_rain_glass`** (72.9-77.0 s): night rain, car 4, the left window, 0.28 m from the glass, 24 deg, a slow
  push; starts 2.8 s after our car clears the Oakland portal (M2 s 32010; trench, then the aerial at 32230), 180 frames
  at 30 fps, `w=rain`, fixed exposure. The glass is MetroKit's cinema glass (below). Road traffic is not deterministic
  between runs: tail-light bokeh showed in 3 of 5 previews (the lead: fine).
- **P16 `p_tube_cab`** is SIM's module; TRAINS' part is `_metrolook.mjs` `cabLook(key, o)`, awaited at the end of its
  prime: exposure 1.5 (no eye adaptation), screens 1.9, cab light 0.03, windscreen reflections at physical strength,
  and a pre-roll in capture mode (below). BART-like screens face the driver, so a near-vertical windscreen cannot show
  them: it mirrors the cab behind the driver (the door window onto the lit saloon, the desk lit by its screens).
- **Climax hero `p_nose_hero`**: West Oakland, platform 2, the same train pulling out: 90 mm, 13 m ahead of the stopped
  nose, 2.55 m right of the track, 1.5 m above the rail, panning with the nose (eased, capped at ~26 deg), 780 frames at
  120 fps; the cab dark, lamps at 0.7 and their glow billboards at 0.45 so the pods keep their shape in the bloom.

MetroKit for shots (`src/js/42_metrokit_cine.js`):
- `MetroKit.look({ lcd, refl, cab, lamps, glow, cinema })`, `look(null)` resets: screen gain, interior reflections,
  the cab light, lamp levels, glow billboards, and the cinema glass settings (bokeh radius, highlight gain/threshold,
  drop lens field, beads, fresh rain, focus, cabin reflection, tint).
- **Cinema glass** (only with `look({ cinema })`): the glazing of the car the camera is in draws last, from the frame
  grabbed just before it (colour + depth blitted from the post pipeline's MSAA target with three's own framebuffer
  handles, mipmapped): the outside through a 96-tap disc gather whose taps count by their own thin-lens blur circle
  (focused on the glass), bright taps weighted (bokeh), the spiral turned per pixel; rain on the glass in focus (beads,
  fresh drops popping in with the rain, a few big drops, runners going down and back in stick-slip steps with trails
  that are thin cylindrical lenses); each drop a lens with a sharp inverted image of the outside, a dark rim, a highlight;
  the glass's own defocus away from the focus; the cabin mirrored in the inner surface, soft. Writes depth. 4K cost is
  high (offline only).
- `MetroKit.viewHint(p, fov)`: the camera for the next frame, from a shot's `before` hook (MetroKit chooses interiors,
  levels of detail and the cinema glass by the camera the cars were last drawn with; capture places its camera after
  the runtime updates). Shots also pre-roll a few frames in capture mode at the end of `prime` and leave capture mode
  on, so the game's own loop never draws the free camera (clamped above trenches and water) before the first frame.
- Game-side (all views): per-car clear glazing (interior built) mirrors the car's own interior seen from inside (the
  saloon's shell; in the D cab the console, desk, seat, the back wall and door window); the cab's display panel
  reclines 0.52 rad (`K.CAB_PANEL`, shared by the model, the screens' light and the reflections); the cab follows its own
  light level and is lit by its screens; the cab ceiling light has its own group; the cab door has its cab-side face;
  underground, the tunnel's ambient reaches a car's inside only through its windows (x `mkIndoor.x`, like the sky's);
  per-car LOD by apparent distance under a long lens, LOD 0 within an apparent 600 m in capture mode (M3.2).

## M3 polish round (lead's items, 2026-09-26)

1. **Low / LOD 1 look.** A per-design atlas baked from the full model (`42_metrokit_bake.js`): five orthographic views
   (sides, roof, ends at 1.6x), 4x MSAA, mipmapped sRGB, alpha = material code (paint, metal, a window onto the lit
   cabin, a far pane). The LOD meshes (`builders[kind].lodBaked`): a coarse section shell with the door portals open
   behind skinned leaves, the noses as fillet rings and faces, skirt cards (trucks and equipment as the side views
   saw them); per car on top: numbers and door lamps copied from the full model, lamp discs, the LED signs (the
   consist's destination). The GTW's three bodies stay on their bones (the LOD articulates). The windows show the
   cabin as a rider on the platform sees it, lit by its own light (plus a daylight term by day); on Low the doorway
   impression fills open doors. A/B at 10 / 40 / 150 m, day and night: `shots/trains/m3_lod_ab_day.jpg`,
   `m3_lod_ab_night.jpg` (top LOD 0, bottom baked LOD 1); 12TH on Low before / after: `m3_low_12th_before_after.jpg`;
   GTW and Cable Liner: `m3_gtw_apm_lod.jpg`. Costs: D 1136 / E 1056 triangles at LOD 1, one draw; atlas 1030 x ~800
   (36 texels/m on Medium+, where LOD 1 starts at 110 m; 48 on Low): 2.5-4 MB per design; a bake ~10 ms after the
   first (programs compiled with a target bound and kept alive). Low's LOD material is satin (no anisotropic spread
   there), so bodies read silver in tunnels too.
2. **Far trains from the air** (`m3_aerial.jpg`, Concord at 300 / 1000 m, day and night): silver trains with the blue
   ends and dark gaps between cars, lit windows and lamp glows at night; never boxes. The far batch draws the baked
   LOD 2 per design; `far.addCar(kind, type, pose, flip, color)` takes an optional line colour and makes the cab car's
   front sign glow in it (request to SIM below). Open: at ~1 km at night the window strips are sub-pixel (only the
   lamps show).
3. **People mover at night** (`m3_apm_night.jpg`): its panes were drawn over an opaque black band, so with the cabin
   built the clear glass showed black; the panes are openings now, with a white lining inside (sill, head strip,
   pillars) as in the photos, and the impression has per-pane windows. Every design's far panes now reflect the lit
   cabin (~14 %, a second bounce through the shell), which is what lights them at night.
4. **Budgets.** Per-car LOD: MacArthur from 110 m up, a 5-car train at 128-176 m went from 10 draws + 5 shadow draws /
   405k triangles to 5 + 5 / 11k (lead's probe: 1 call / 186k per car before, 3 calls / 11k after). No per-frame
   allocations added (the bake is one-time; LOD and interior policies reuse vectors).
5. **Prewarm** (lead's hitch item). `MetroKit.precompile(scene, camera)` compiles every MetroKit program (body,
   glazing, clear glass, doorway, interior, Low LOD, far batch, lamps, bake) on a hidden D-E-D prototype with
   `compileAsync` against the game's scene and a bound render target (the post pipeline draws into one, so the
   programs match), sliced over a few frames, and keeps the materials referenced so the programs stay compiled; it
   starts itself once the game has drawn ~60 frames and the metro is on. MetroKit's programs: 8 (+ the clear glass
   and lamp shaders, which aren't MetroKit-keyed); designs share them. Cold EMBR arrival (`#auto&metro=1&t=17:31&mst=EMBR`,
   q=high): before, MetroKit compiled when the first train came near (frames of 1408 ms and 670 ms: lod x2, ext + int);
   after, all 8 compile at boot in one 76 ms frame, none at the arrival (total programs after 75 s: 85 before, 92 after,
   the difference being the bake and doorway programs compiled up front).

## Costs (measured in preview/metro.html#view=exterior&cars=10&measure=1, consist only, no shadows)

| | draw calls | triangles |
|---|---|---|
| 10-car train, LOD0 exterior | 20 (body + glass per car) | 386k (D 42.1k, E 36.3k per car at quality 2; the trucks are 6.4k of it) |
| + doorway impression (doors open, interior not drawn) | +1 per car | +12 per car |
| car beyond 110 m or on Low: baked LOD 1 | 1 per car | D 1.1k, E 1.1k, GTW unit ~1k, Cable Liner car ~0.3k |
| + interior of one car | +2 | +33k |
| 10-car train, LOD1 | 10 | 10.9k |
| 10-car train, LOD2 | 10 | 1.0k |
| far batch (all far trains) | 1 per car design + 1 for all lamps | 72-152 per car |

Build times (M2, first use, then cached): D exterior 95 ms, E 38 ms; interiors 21-36 ms; GTW unit 65 ms; APM cars 22 ms.

Render time (preview, 1600 x 900, sun shadows on, `#gpu=1`: render + gl.finish, median of 40, with minus without the
train): 10-car train exterior 3/4 view 0.6 ms (0.3 before the interior impression v2: the glass fragments now ray-cast
the cabin; the 3/4 view has the most window area), side view 0.2 ms, inside a car (interior of that car built) 0.4 ms.
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

- **it3** (`it3_*.jpg`): windows compared with the Lake Merritt 2026 photo (lit cabin seen from the platform: bright
  ceiling bands at the window tops, grey walls, dark far windows, lime priority seats, poles) and the Millbrae 2026
  photo (by day: dark tinted glass, the light bands and the far windows brighter than the cabin). The impression now
  draws the cabin's convex section with the 0.5 m LED bands in the sloped ceiling, the far wall's windows (the scene's
  environment through a second pane), reveals, doors with windows, ads and screens, the lime end walls with the end
  door, seat backs/cushions (blue, lime priority), benches, partitions, poles, rails and passengers; it is shaded with
  the real interior's light model, so `it3_imap_ab.jpg` (top: impression, bottom: real interior of car 1) match in
  layout and brightness day and night. Bug found on the way: the mirrored ceiling plane had the wrong offset (a false
  second light band). Shoes: under the coverboard on the rail side, free and tilted on the other (in game, infra's
  build). Trucks: swan-neck frames, bellows, dampers, brake blocks, cables (`it3_shoes_truck.jpg`). GTW compared with
  Stadler's rendering: raked windscreen, blue wrapping the lower corners of the white cab front, bigger lamp clusters.

## Known issues / open problems

- From ~1 km at night the far trains' window strips are sub-pixel; only the lamp glows show. A per-car window glow in
  the far batch (and a per-consist one for pool cars at LOD 2) would carry them; not done yet.
- The people mover seen close with its cabin built is darker than its impression at night (the clear glass doesn't
  model the far panes' reflection); the switch happens at 45 m.
- The first bake still costs ~120 ms (the driver's first draw with the new programs), once per session.

- The glass ray-cast costs ~0.3 ms more for a close 10-car 3/4 view (fragment-bound; rows are culled by the ray's x
  span). If it shows in profiles: skip passengers beyond ~80 m or drop to the old flat impression at LOD0 > 100 m.
- The Cable Liner's big panes show the dark outside through the far glass at night (physically right, but the real
  cabins read brighter in photos: the far glass mirrors the lit interior more than modelled).

- The D car's front is close to the reference in the head-on view but still simpler in 3/4 views (corner pillars'
  recessed panels, the chin's curvature).
- The DMU and APM interiors are simple (no cabs); the GTW nose is closer to Stadler's rendering but still rounder.
- Headlight pods are ovals rather than the real teardrops; the corner pillars lack their recessed panels.

## Requests for other workstreams

- SIM (small, optional): pass the line colour to the far batch, `kitFar.addCar(kind, type, FK, flip, lineColor(tr.line))`
  in `farKit`, so the lead cab car's front sign glows in it on distant trains (the line-colour hint the lead asked for
  from the air). Nothing else changes: `setLOD` / `setInteriorVisible` keep their meaning (MetroKit refines both per
  car by camera distance), and `MetroKit.precompile` runs by itself.

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
