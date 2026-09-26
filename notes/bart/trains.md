# Bayline Metro trains (MetroKit) — status

Workstream: trains · branch `bart-trains` · worktree `.worktrees/bart-trains` · dev port 8133.
Owner files: `src/js/41_metrokit.js`, `src/js/42_*.js`, `preview/metro.html`, `notes/bart/trains.md`, `notes/bart/shots/trains/`.

## Status
- 2026-09-26: started. Research (Fleet of the Future D/E cars, FLIRT DMU, Cable Liner) in progress.

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

The "42 in (1.07 m)" figure the stations team found does not match any BART source I could find; BART's own
facts page and the platform standard both give 39 in. Always read `car.doors[i]` (x, side, width, sillY) from the
MetroKit metadata at runtime; `sillY` will be 0.991.

## API
(to come; modelled on TrainKit, see notes/trains.md)

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

## Requests for other workstreams

- DATA: the Antioch vehicles are Stadler **GTW 2/6** (BARTCHIVES, Wikipedia "eBART"), not FLIRTs; please fix the
  wording in timetable `consist` / bart-data.md. I read `cars` for eBART as the number of GTW units (each ~40.9 m).
- INFRA: third-rail geometry for the collector shoes. I assume the contact surface at **y = +0.19 m** above top of rail
  and the contact rail centreline at **|z| = 1.45 m** from the track centreline (shoes on both sides of every truck,
  paddles ~0.3 m long). Please tell me your numbers and I'll move the shoes to match.
- SIM: consists will be `MetroKit.createConsist('bart' | 'dmu' | 'apm', { cars, order, seed })`; car metadata like
  TrainKit (floorRegions, seats, doors, cabEye, bogieOffsets). A pose helper will take MetroNet-style frames.
