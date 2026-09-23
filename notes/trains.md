# TrainKit — Bayline rolling stock (src/js/40_trainkit.js)

Preview: `preview/trains.html#view=<v>` (views: exterior, nose, side, doors, interior-lower, interior-upper,
gangway, bike, wc, cab, roof, diesel, diesel-rear, diesel-interior, diesel-lower, diesel-vestibule, diesel-cab,
night-exterior, night-interior, night-diesel, lod, plan, diesel-plan). Add `&meta=1` to draw the walking metadata:
floor regions (translucent), ramps (magenta), seats (green dots), doors (yellow bars) and the cab eye (red).
`#view=plan&meta=1&car=2` is a top-down x-ray of one car (shell hidden) for checking the metadata against the furniture.
Screenshot: `node tools/shot.mjs "file://$PWD/preview/trains.html#view=cab" /tmp/x.png --gpu`.

## API

```js
const c = TrainKit.createConsist('emu' | 'diesel', { seed, name });
c.kind, c.cars, c.length          // coupler-to-coupler (emu 178.2 m, diesel 150.5 m)
c.speed                           // m/s, SIGNED: + = moving toward +X (the car-0 end)
c.setDestination(text)            // amber LED dot-matrix: front cab signs + one side sign per car side
c.setDoors(side, t)               // 'left' | 'right' | 'both' | 'none', t 0..1 (car-local sides, +Z = right)
c.setLights({ head, tail, interior, cab, lead })   // levels 0..1; lead = 'front' | 'rear' (optional)
c.setLeadEnd('front' | 'rear')    // same as setLights({lead})
c.setNight(n)                     // 0 day .. 1 night: lit windows, lamp glow, interior brightness
c.setPantograph(t)                // emu only; 0 down .. 1 up (head at TrainKit.PANTO_UP_Y = 5.9 m above rail)
c.setDisplay({ route, nextStop, destination, clock })   // passenger screens (one canvas per consist)
c.setCab({ speedMph, limitMph, throttle, brake, signal, nextStop, distFt, clock, ptc })
      // signal: 'clear' | 'approach' | 'restricting' | 'stop' (any string; colour by prefix)
      // ptc: 'active' | 'warning' | 'enforcing' | 'cut out' (or true/false). Redraw is throttled to ~9 Hz
      // and only happens when a value changes, so calling it every frame is fine.
c.setInteriorVisible(bool)        // all cars; per car: c.cars[i].setInteriorVisible(bool) (recommended)
c.setLOD(level)                   // all cars; per car: c.cars[i].setLOD(0 | 1 | 2) (recommended)
c.update(dt)                      // wheel spin from c.speed, door animation. No allocations.
TrainKit.poseCar(car, front, rear, roll)   // optional helper, see "Posing" below
```

`setLights` sets these by `lead`: white head lamps (+ glow sprites) on the leading cab end, red tail and marker lamps
on the trailing cab end. Middle cars never show lamps. With `lead: 'front'`, car 0's +X cab leads.
With `'rear'`, the last car's cab leads, facing −X. The diesel follows the same rule: the loco's front is the car-0 end
(south), and the bilevel cab car's cab is the last car's −X end (north).

## Car object (per SPEC)

`car.group` is a self-contained `THREE.Group` with `rotation.order = 'YZX'`. Add it to the scene and pose it in world
space. The rear cab car (and EMU car 5) is the same shared design rotated 180°, using an inner child group, so never
reset `group.children`. The metadata below is already expressed in the car-local frame of `group`
(+X toward the consist front).

| field | meaning |
|---|---|
| `index, type, length, width, height` | type: emu `cab, bike, coach, wc`; diesel `loco, coach, cab` |
| `offset` | distance from the consist's +X coupler face (car-0 front) to this car's center |
| `number` | painted car number, e.g. `BL 324` |
| `bogieOffsets: [xFront, xRear]` | bogie pivot x in the car frame (not symmetric on cab cars) |
| `floorRegions: [{name,x0,x1,z0,z1,y}]` | walkable rectangles (already 0.1 m inside the walls) |
| `ramps: [{x0,x1,z0,z1,y0,y1}]` | x0 < x1 always; floor = lerp(y0, y1, (x - x0)/(x1 - x0)) |
| `gangways: {front, rear}` | `{x, z0, z1, y}` at the coupler plane (x = ±length/2); `null` on cab ends / loco |
| `seats: [{x,y,z,yaw}]` | seated EYE position (floor + 1.18 m), yaw 0 faces +X |
| `doors: [{x, side, width, sillY}]` | side +1 = +Z. sillY = inside floor at the doorway |
| `cabEye: [x,y,z] | null` | driver's eye; front cabs look +X, the rear cab car looks −X |

Walker rules that fit the data:
- Regions overlap in plan between decks (lower/upper). Choose the region or ramp whose floor height is closest to the
  walker's current foot height, and only accept steps of ≤ 0.45 m. Ramps (stairs) take priority where they overlap a
  region, and their ends meet the regions exactly.
- Crossing cars: `gangways.front` of car i joins `gangways.rear` of car i−1 (same y, same z range).
- Doors: step out through the doorway (z beyond ±width/2 of the body) onto the platform. Platforms sit 0.25 m above the
  rail. EMU `sillY` = 0.62: a yellow-edged fixed step at 0.43 sits under every door, so treat the doorway as a
  0.37 m step or a short ramp. Diesel coach `sillY` = 1.12 (vestibule); door-well steps (0.80, then 0.45) are
  modelled, so use a ramp down to the platform across the 0.35 m door well.

### Floor heights (m above top of rail)

| | lower deck | intermediate (end zones, gangways) | upper deck | cab floor |
|---|---|---|---|---|
| EMU | 0.62 (also vestibules and door sills) | 1.32 | 2.62 | 1.75 |
| Diesel bilevel | 0.55 | 1.12 (vestibules, doors, gangways) | 2.52 | 1.45 (cab car) |
| Loco | — | — | — | 1.95 (cab) |

### Door x positions (car frame, both sides; unflipped design)
- EMU intermediate car (25.0 m): x = ±6.8, width 1.30. EMU cab car (26.6 m): x = −7.7 and +5.9.
- Diesel coach (25.9 m): x = ±11.475, width 0.95. Diesel cab car: rear end only (x = −11.475 before the flip, so
  +11.475 on the consist's last car). The loco has no passenger doors.
- The rear cab car and EMU car 5 are flipped, so their `doors` array is already negated. Always read `car.doors`.

### Consist composition
- EMU (car 0 at the south end): `cab, bike (pantograph), coach, wc (accessible restroom), coach (quiet car), bike
  (pantograph, flipped), cab (flipped)`. Lengths 26.6 + 5×25.0 + 26.6 = 178.2 m.
- Diesel: `loco (MP36-like, 21.0 m), coach ×4 (25.9 m), cab car (25.9 m, flipped)` = 150.5 m.

## Posing a car from two bogie points
Given world pivots `F` (front bogie) and `R` (rear bogie) on the track centerline at rail height:
```
fwd = normalize(F - R);  yaw = atan2(-fwd.z, fwd.x);  pitch = atan2(fwd.y, hypot(fwd.x, fwd.z))
center = (F + R)/2 - fwd * (bogieOffsets[0] + bogieOffsets[1]) / 2
group.position = center;  group.rotation.set(roll, yaw, pitch, 'YZX')
```
`TrainKit.poseCar(car, F, R, roll)` does exactly this without allocating. For a lead-positioned consist,
car i's bogie pivots are at `s_i = s_front - car.offset + bogieOffsets[k]` along the track (s increasing toward +X).

## Interiors and LOD
- `setInteriorVisible(true)` builds that car's interior on first use. Geometry is cached per design and shared, so
  later cars cost only a few `Mesh` objects. It also swaps the window glass from an opaque "lit window" material to
  clear tinted glass. Recommended: interior on for the car the camera is in and its two neighbours, or for any car
  within about 40 m of an outside camera.
- LOD 0 = full exterior. LOD 1 = one mesh per car (windows as warm-glowing panes at night, lamps still lit). LOD 2 =
  banded box, also one mesh. Suggested distances: LOD 0 < 150 m, LOD 1 < 600 m, LOD 2 beyond (or hide).
  Headlight glow sprites (THREE.Points) stay on at every LOD so trains read at night from far away.
- `setLOD` and `setInteriorVisible` only toggle `visible` and swap materials, so they are cheap to call every frame
  (both early-out when nothing changes).

### Measured cost per car (triangles, draw calls)
| car | LOD0 exterior | + interior | LOD1 | LOD2 |
|---|---|---|---|---|
| EMU cab | 8 calls / 12.2k | 6 / 12.9k | 1 / 2.0k | 1 / 0.8k |
| EMU bike | 8 / 12.2k | 5 / 28.1k (16 bikes) | 1 / 1.4k | 1 / 0.1k |
| EMU coach, wc | 7 / 11.5k | 4 / 12.2k | 1 / 1.3k | 1 / 0.1k |
| Loco | 6 / 8.5k | 3 / 0.5k | 1 / 0.2k | 1 / 0.2k |
| Bilevel coach | 7 / 11.1k | 3 / 9.9k | 1 / 1.0k | 1 / 0.15k |
| Bilevel cab | 8 / 9.8k | 5 / 9.8k | 1 / 1.1k | 1 / 0.3k |

A whole EMU is about 56 calls and 84k triangles at LOD 0 (exterior only), and 7 calls at LOD 1 or 2.
EMU interiors add 4–6 calls per car.

## Materials, lights, night
- All opaque parts of a car share one `MeshStandardMaterial` (per car, so lamp levels can differ) that reads a 64×1
  PBR palette texture. Every part's UVs point at one texel holding albedo, roughness, metalness and light-group
  weights. A small `onBeforeCompile` patch turns these into emissive: interior LED strips, head lamps, tail lamps,
  a warm "interior ambient" (so interiors look lit at night without real lights) and far-LOD lit windows.
  Every car shares one shader program (`customProgramCacheKey 'tk-pal-2'`).
- No THREE lights are created. If the engine wants a real headlight beam, add one SpotLight to the player's train
  at the lead cab: `car.cabEye` x + 1.8 m, y ≈ 1.6.
- Per consist: the window glass (exterior and interior variants), the LED sign canvas (512×128), and lazily the
  passenger-screen canvas (512×256) and cab-screen canvas (1024×320, created only when a cab interior is built).
- Wheel spin: `update(dt)` rotates wheelset instances by `speed·dt/r` (EMU r = 0.46, loco 0.508, bilevel 0.457).
  Doors take about 2.4 s to open (plug-out, then slide).

## Integration notes / requests
- Lead: call `c.setNight(env.night)` once per frame (it early-outs), `c.update(dt)` after setting `c.speed`.
- The catenary contact wire should sit at about 5.9 m above rail to meet the raised pantograph
  (`TrainKit.PANTO_UP_Y`). If the wire height differs, `setPantograph(t)` scales the head linearly between
  5.05 m (down) and 5.9 m (up).
- Sound: `setCab`'s throttle/brake also moves the desk handle mesh (it rotates about the car-local Z axis).
- Frustum culling works per mesh. Door and wheel instanced meshes carry padded bounding spheres, and glow Points
  have `frustumCulled = false`.

## Known limits
- Bogies don't yaw on curves (the body is posed from the pivots, so it's correct, but the frames stay parallel).
- Door leaves slide straight along the body (plug-out 5.5 cm); there's no curved glass.
- The diesel cab car has doors only at its rear vestibule (the cab occupies the front-right). The loco has no
  walkable engine room.
- Car numbers are drawn from a shared glyph atlas (`BL`, digits, `-`). Other characters render as blanks.
