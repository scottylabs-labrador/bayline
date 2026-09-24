# Aircraft v2: procedural aircraft (design notes)

Branch `feat/aircraft-v2`. Every flyable type (and the live-traffic stand-ins) looks like the real type in chase,
flyby, close-up and cockpit views, animates from the flight state, and stays cheap as traffic. Types are named for
identification only: every aircraft wears the fictional Bayline Air scheme (no airline or manufacturer branding).
Flight dynamics (47_fdm.js, 47_fcs.js) are untouched; the model only reads the flight state
(`node tools/qa_flight.js` prints the same as on main).

## 1. Where it started (main, measured with preview/aircraft.html)

Right dimensions, but: a shading seam along the crown and keel, no wing-to-body or belly fairing, box pylons
through the wings, painted fan discs, stick-and-tyre gear, flat grey wings, cockpit windows painted from a
2048 x 512 mask (stair-stepped edges), a cockpit that was the fuselage from inside plus three black boxes; box
intakes on the F-16 and the Concorde. 13-16 draw calls, 12-14k triangles, 55-130 ms to build.

## 2. Architecture

The build concatenates src/js sorted by name into one scope; the new modules only define functions and refer to
each other at call time.

| module | global | role |
|---|---|---|
| 48_acgeo.js | ACGeo | geometry kit: mesh builder (explicit normals, `uv` for the part's texture, `uv1` in metres for the tiling panel-line map, a skin binding per vertex, a transform stack, mirroring, holes), parametric surfaces with finite-difference normals (no seams), airfoils, lathes, tubes, boxes, convex-polygon clipping, monotone splines, the rig, the per-material batches |
| 48_acframe.js | ACFrame | the fuselage as a function of station and section angle (superellipse sections, nose and tail lines per style, the 747's upper deck, the wing-body fairing, fighter / light-aircraft / helicopter shapes), cockpit panes cast from the pilots' eye, canopies; wings and tails with their moving panels; tip devices, flap-track fairings, struts, the F-16's LEX and ventral fins, dorsal fins |
| 48_aclivery.js | ACLivery | canvas textures cached per (type, quality): the livery (albedo, clearcoat/roughness/metalness, night-lit windows), wing / fin / nacelle atlases, the part palette, the shared panel-line and rivet normal tile; the livery's layout as one function (`scheme`) that also colours the traffic models |
| 48_acparts.js | ACParts | turbofans, propellers, jets and reheat, rotors, landing gear (stowing search, bay doors), lights |
| 48_accockpit.js | ACCockpit | cockpit interiors per style (airbus, boeing, ga, fighter, heli) around the live instrument canvas and FCU that 49_fhud.js draws |
| 48_acmodel.js | ACModel | assembly and animation. API unchanged (`build(type)` -> `{ root, update(ac, dt, env), dispose(), eye, panel, fcu, inside, parts, lamps, spot, type }`, `lite(type)`), plus `setQuality(level)`, `lite(type, lod[, ifReady])`, `stats` |

### One skinned mesh per material
Every moving part is a bone: control-surface panels, slats, flaps (Fowler: they rotate, slide aft and drop),
spoiler panels, the trimmable stabiliser, rudders, span stations of the wings (flex), fans, propeller hubs and
blades (feathering), reverser sleeves, gear legs, pistons, torque links, bogies, wheels, bay doors, the rotor head
and blades (coning), the Concorde's nose, the F-16's speed brakes. All geometry is merged per material (livery
skin, wings, fin, nacelles, the part palette, glass, canopy, discs, flame; inside: cabin, screens, FCU, panels,
engine display) into one SkinnedMesh each: 7-10 draw calls outside instead of ~56 on main.
- Precision: world coordinates reach ~150 km (float32 steps ~1.6 cm). `ACGeo.Rig` composes the bone matrices
  relative to the aircraft in double precision and writes the skinning matrices itself (`bindMode = 'detached'`,
  identity bind matrix); the model-view matrix stays the engine's precise one.
- Bounds: every skinned mesh gets the aircraft's bounding sphere (three.js would skin every vertex on the CPU).
- Renderer-agnostic: standard and physical materials, SkinnedMesh, canvas textures; no ShaderMaterial or
  onBeforeCompile anywhere in the aircraft.

### Quality levels
`ACModel.setQuality(level)` takes any string or number: low = 0, medium = 1, high = 2, ultra = 3, anything above
(ultraplus, ultra+, max, webgpu, or an unknown name) = 4; missing = high. 90_main.js calls it from applyTier with
the tier's name (one line); it applies to the next build (auto-tiering changes tiers mid-flight).

| | low | medium | high | ultra | max |
|---|---|---|---|---|---|
| fuselage rings x around | 70 x 28 | 100 x 36 | 150 x 56 | 190 x 72 | 260 x 96 |
| livery width (jets) | 2048 | 2048 | 4096 | 4096 | 8192 |
| panel-line normal tile | none | 512 | 1024 | 1024 | 2048 |
| A320 exterior triangles | 18k | 27k | 49k | 72k | 117k |
| A380 exterior triangles | 32k | 48k | 82k | 117k | 182k |

### Traffic
`lite(type, 'far')` (2-5k triangles: the silhouette, no moving surfaces or gear) and `lite(type, 'near' | 'gear')`
(the low-quality player model posed gear up / down, 9-32k triangles), each one merged vertex-coloured geometry
(livery layout and palette colours baked). All are built in the background a few ms per frame (`geometrySteps` is
a generator), far models first; 73_traffic.js draws the detailed model within 2.5 km.

## 3. Animation hooks (read-only)
surf.{elev, ail, rud}, ctl.trim, flapPos (+ each notch's slat angle), spoilerPos (speed brake, ground spoilers, roll
spoilers from the aileron), gearPos (doors open -> legs -> doors close; legs behind closed doors hidden),
legs[i].{comp, contact} (oleos, torque links, wheel spin, bogie tilt), ctl.steer, ctl.thr / ctl.rev (reversers,
propeller beta, cockpit levers), eng[i].n (fans, props, feathering, blur discs, reheat), rotor.{rpm, a1, b1, T}
(disc tilt, coning), out.{qbar, CL} (wing flex as a damped spring; the load factor as a fallback), droop.

## 4. Test plan and results
- preview/aircraft.html + tools/aircraft_review.py: every type x views, day / golden hour / night, main's models
  (dist/baseline) against the branch.
- The game (dist/lead.html): chase, flyby, cockpit, night, golden hour, live traffic near SFO; `dist/main.html`
  (main's code) for frame-cost comparisons.
- `node tools/qa_flight.js` (identical to main), `PORT=8125 sh tools/qa_all.sh`, no console errors.

## 5. Merge strategy
Touches 46_aircraft.js (model sub-objects only), 48_acmodel.js (rewritten, same API), new 48_acgeo.js,
48_acframe.js, 48_aclivery.js, 48_acparts.js, 48_accockpit.js, 73_traffic.js (a dozen lines), 90_main.js (one
line in applyTier), preview/aircraft.html, tools/aircraft_review.py, this note. None of Ultra+'s files.

## 6. Risks considered
- Draw calls with detail -> batches per material. Skinning jitter far out -> relative bone matrices. CPU skinning
  for bounds -> preset spheres. Build hitches -> cached textures, cached cockpit panes and gear stowing, traffic
  built in slices. Texture memory -> half-size ORM/emissive, 8192 only at the top level, released on type change.
- Cockpit near plane 0.04 m -> interior surfaces kept >= 0.3 m from the eye. The windscreens are real geometry,
  so from inside the openings are exact and the glareshield meets their base.
- FVfx and the flight code use the same fields as before (lamps.landL/R, root, eye, panel, fcu, inside).
