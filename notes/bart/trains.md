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
| door centres along the car (both sides) | x = 0 and ±5.42 m from the car centre (car-local), 3 per side | BART 2014/2015 floor plans (measured, ±3 cm) |
| door clear opening | 1.372 m (54 in) wide, ~1.93 m high | BART board presentation 2014 ("54 inch door opening") |

The "42 in (1.07 m)" figure the stations team found does not match any BART source I could find; BART's own
facts page and the platform standard both give 39 in. Always read `car.doors[i]` (x, side, width, sillY) from the
MetroKit metadata at runtime; `sillY` will be 0.991.

## API
(to come; modelled on TrainKit, see notes/trains.md)

## Requests for other workstreams
(none yet)
