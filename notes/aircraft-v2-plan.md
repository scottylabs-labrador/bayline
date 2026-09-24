# Aircraft v2: realistic procedural aircraft (plan)

Branch `feat/aircraft-v2`. Goal: every flyable type (and the live-traffic stand-ins) looks like the real type in
chase, flyby, close-up and cockpit views, animates from the flight state, and still costs little as traffic. Types are
named for identification only: every aircraft wears the fictional Bayline Air scheme (no airline or manufacturer
branding). Flight dynamics (47_fdm.js, 47_fcs.js) are untouched; the model reads the flight state and never writes it.

## 1. Baseline (main, measured with preview/aircraft.html)

- The dimensions come from 46_aircraft.js and are right, but: a shading seam along the crown and keel (two
  fuselage halves, each with its own computed normals); no wing-to-body or belly fairing, so the low wing roots
  float beside the fuselage; box pylons through the wings; painted fan discs; stick-and-tyre landing gear; flat
  grey vertex-coloured wings; cockpit windows painted from a 2048x512 mask (stair-stepped edges from inside and
  out); a cockpit that is the fuselage seen from inside plus three black boxes; box intakes on the F-16 and the
  Concorde; a black sphere for the H125's cabin.
- Cost (3/4 view, 'high'): 13-16 draw calls, 12-14k triangles, build 55-130 ms.

## 2. Architecture

The build concatenates src/js sorted by file name into one scope. New modules only define functions; they refer to
each other at call time, so their load order does not matter (preview/aircraft.html loads them before
48_acmodel.js, as the build does for all but 48_acparts.js).

| module | global | role |
|---|---|---|
| 48_acgeo.js | ACGeo | geometry kit: a mesh builder with explicit normals, two UV sets and a skin binding per vertex, a transform stack and mirroring; parametric surfaces with analytic (finite-difference) normals, so there are no seams; airfoils; lathes, tubes, boxes; polygon clipping for window openings; the per-material batch that becomes one skinned mesh per material |
| 48_aclivery.js | ACLivery | textures, generated once and cached per (type, quality): the fuselage livery (albedo, roughness/metalness, night emissive), wing / fin / nacelle maps, the part palette, a shared tiling panel-line and rivet normal map; titles redrawn when the web font arrives; `release()` on type change |
| 48_acparts.js | ACParts | turbofans (lathed nacelles per style, inlet lips, 3D fans with spinners, chevrons, translating reverser sleeves and cascades, aerofoil pylons), propellers and rotors (twisted blades, blur discs, feathering, coning), landing gear (struts, oleos, torque links, braces, bogies, tyres, doors, retraction), lights |
| 48_accockpit.js | ACCockpit | cockpit interiors per style: the shell with exact window openings and depth, glare shield and autopilot panel (the FCU canvas), displays mapped onto the live instrument canvas, pedestal with moving levers, overhead, yokes or sidesticks, pedals, seats |
| 48_acmodel.js | ACModel | assembly and animation. API unchanged: `build(type)` -> `{ root, update(ac, dt, env), dispose(), eye, panel, fcu, inside, parts, lamps, spot, type }`; `lite(type, lod)` -> one merged vertex-coloured geometry; new `setQuality(level)` |

### One skinned mesh per material
Every moving part is a bone (a THREE.Bone under the aircraft root): control-surface panels, slats, flap
carriages and their fairings, spoilers, the rudder and elevators, fans, props, rotor heads, reverser sleeves,
each gear leg, piston, bogie and wheel, the doors, the Concorde's droop nose and visor, the wing span stations
for flex. All geometry is merged per material (fuselage livery, wing, fin, nacelle, parts palette, glass) into
one SkinnedMesh each, sharing one skeleton: ~6 draw calls outside (plus light glows), where one mesh per part
would have been 60-120. Rigid parts bind to one bone; the wing skin blends two span bones.
- **Precision**: world coordinates reach ~150 km, where float32 steps are 1.6 cm; three.js computes bone matrices
  in world space, so skinned vertices would jitter. The skeleton's `update()` is overridden to compute bone
  matrices relative to the aircraft root (in float64, in JS), and the meshes bind with an identity bind matrix
  ('detached'); the model-view matrix stays the usual precise one.
- **Bounds**: each mesh gets the aircraft's bounding sphere (three.js would otherwise skin every vertex on the CPU).
- **Renderer-agnostic**: skinning, standard / physical materials and texture channels work in WebGL2 and in
  three's node-material WebGPU renderer; no ShaderMaterial or onBeforeCompile in the aircraft.

### Materials and textures
- Fuselage: MeshPhysicalMaterial with clearcoat; livery albedo, roughness/metalness and night-emissive maps on
  `uv`; the tiling panel-line/rivet normal map on `uv1` (metres; `texture.channel = 1`), so the detail is sharp up
  close whatever the fuselage length. Wing, fin, nacelle: the same scheme with their own atlases.
- Parts palette: one small texture of swatches (albedo + roughness/metalness): chrome, aluminium, gear paint,
  rubber, dark metal, titanium fan, heat-tinted exhaust, lenses, interior plastics, livery colours. All small parts
  share one material; their UVs point at a swatch (nearest filtering, no mipmaps).
- Glass: dark, glossy, opaque from outside (cockpit panes are real geometry, framed); from inside a faint
  transparent layer.

### Quality levels
`ACModel.setQuality(level)` takes any string: low = 0, medium = 1, high = 2, ultra = 3; anything above ultra
(ultraplus, ultra+, max, epic, cinematic, webgpu, or any unknown name) = 4, the maximum; numbers 0-4; missing =
high. It applies to the next build (the auto-tiering changes tiers mid-flight and a rebuild would hitch), except
cheap runtime toggles (small-part shadows).

| | low | medium | high | ultra | max |
|---|---|---|---|---|---|
| fuselage stations x around | 70 x 28 | 100 x 36 | 150 x 56 | 190 x 72 | 260 x 96 |
| airfoil points per side | 10 | 13 | 18 | 22 | 28 |
| livery width (jets) | 2048 | 2048 | 4096 | 4096 | 8192 |
| panel-line normal tile | none | 512 | 1024 | 1024 | 2048 |
| fan | disc + few blades | blades | blades + OGVs | blades + OGVs | + finer |
| small parts (antennas, wicks, probes) | no | no | yes | yes | yes |
| gear | struts, wheels | + links | + braces, brakes, doors | same | finer |

Traffic: `lite(type, 'far')` (default, the kind the old lite had, ~2-4k triangles) and `lite(type, 'near')`
(the real silhouette at low tessellation with painted vertex colours and gear, ~10-20k). 73_traffic.js draws the
near model within ~2.5 km (gear down on the ground), the far one beyond.

### Geometry
- **Fuselage**: stations along x; each section a superellipse with separate upper and lower half-heights, width
  and exponent, a crown lobe (the 747's upper deck) and a belly-fairing bulge sized to enclose the wing root. Nose
  and tail profiles are monotone splines through per-style control points (airbus, b737, b787, b747, a380,
  concorde, bizprop, dc3). Tail cone ends in the APU exhaust.
- **Windscreen**: panes are polygons in (station, section angle) per nose style: dark glass geometry, framed.
  The cockpit shell is the same surface with the panes clipped out exactly (convex-polygon clipping), plus jambs.
- **Wings**: airfoil lofts (supercritical-like camber for jets) with twist, dihedral, sweep and kink; flaps split
  into inboard / outboard panels (Fowler: slide aft and rotate), ailerons, spoiler panels, slats (forward and
  down), flap-track fairings whose aft part rides with the flap, wingtip devices per type (A320 sharklet, 737
  blended winglet, 747 canted winglet, A380 wingtip fence, 787 raked tip, King Air winglet, F-16 rail); flex from
  the load factor through span bones (a damped spring, so landings bounce the tips).
- **Nacelles**: styles LEAP (short, wide inlet), CFM56 (flattened lower lip), GEnx (chevrons), long-duct
  (747/A380); polished lip, 3D fan, spinner with a swirl mark, reverser sleeve revealing cascades, core cowl,
  plug; aerofoil pylons with aft fairings. Props: twisted blades with root cuffs and tip stripes, blur discs,
  feathering; radial cowlings for the DC-3. Rotor: hub, coning with rotor thrust, tail rotor.
- **Gear**: per-type legs with trunnion, side brace, chrome oleo, torque links opening with compression, axles or
  bogies (tilting when unloaded), tyres with grooves, hubs and brakes, leg doors and bay doors that open only in
  transit; the 737's mains stay visible in the belly; forward-retracting nose gear with taxi lights.
- **Small parts** (high+): antennas, static wicks, pitot probes, wipers, APU exhaust, drain masts.

### Lights
Nav (red / green / white), strobes (Airbus double flash), beacons, landing, taxi, runway turn-off, logo lights on
the stabiliser washing the fin (emissive fin at night), wing lights, lit cabin windows. Lens meshes in the
palette plus additive glow sprites. `lamps.landL/landR` keep their meaning for FVfx's beams.

### Budgets (at 'high', measured)
- Draw calls outside: <= 12 plus light glows. Triangles: <= 150k narrow-body, <= 300k A380.
- Texture memory at high <= ~60 MB per type; generated once per (type, quality), released on type change.
- Build <= 400 ms first time, <= 200 ms with cached textures. Frame cost within the game's budget at 'high'.

## 3. Animation hooks (read-only)
surf.{elev, ail, rud}, flapPos (and the slat angle from the flap table), spoilerPos, gearPos (bay doors open ->
leg -> doors close), legs[i].{comp, contact} (oleo, torque links, wheel spin, bogie tilt), ctl.{steer, thr, rev,
trim, flaps}, eng[i].n (fans, props, reversers, feathering), rotor.{rpm, a1, b1} (+ coning), out.{nz (flex),
onGround, gs, cas}, the droop nose (Concorde).

## 4. Test plan
- preview/aircraft.html + tools/aircraft_review.py: every type x {34f, 34r, side, nose, engine, gear, tail, tip,
  cockpit}, day / golden / night; the baseline (main's files in dist/baseline) against the branch.
- In the game (dist/lead.html, port 8125): chase / cockpit / flyby / night; live traffic near SFO.
- `node tools/qa_flight.js` (FDM untouched: identical to main), `PORT=8125 sh tools/qa_all.sh`, no console errors.
- Frame cost: average frame time in chase view at the 'high' tier, main vs branch.

## 5. Merge strategy
Touches 46_aircraft.js (model sub-objects only), 48_acmodel.js (rewritten, same API), new 48_acgeo.js,
48_aclivery.js, 48_acparts.js, 48_accockpit.js, 73_traffic.js (a few lines: near/far LOD), 90_main.js (one line in
applyTier), preview/aircraft.html, tools/aircraft_review.py, this note. None of Ultra+'s files (12_terrain,
30_towns, 63_ground, 14_post, the tier list); the applyTier line is a one-line conflict at worst.

## 6. Adversarial review (and answers)
- *Detail multiplies draw calls* -> one skinned mesh per material; ~6 calls whatever the detail.
- *Skinning jitters far from the origin* -> root-relative bone matrices (above).
- *three.js skins every vertex on the CPU to compute bounds* -> preset bounding spheres.
- *Textures at 4096+ cost memory* -> roughness/emissive at half size, 8192 only at the maximum level, cached per
  type and released on type change; the panel detail is one shared tile.
- *Build hitch on flight start* -> typed-array texture work, caches, no per-pixel window masks.
- *Cockpit near plane 0.04 m* -> interior surfaces >= 0.3 m from the eye.
- *Traffic instancing* -> lite() stays one merged vertex-coloured geometry per LOD; instanced meshes per class.
- *FVfx and the flight code* -> same fields (eye, panel, fcu, inside, lamps, spot, parts, root); FVfx reads
  T.model.engines (x, y, z, len), which do not change.
- *Wing flex and attached parts disagree* -> they share the span bones; engines and panels are children.
- *WebGPU* -> no custom shaders in the aircraft; if a renderer lacks something, it falls back to static parts.
