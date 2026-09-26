# Bayline Metro: the whole BART system, unofficially (master plan)

The owner's brief (2026-09-26): implement **the entire BART system** (every line, station, the real schedule,
the trains) at a standard *well above* the Peninsula rail and flight sim: "push the limits of what is possible
across graphics, detail, realism, environmental quality, and cohesion ... implementing novel solutions", fitting
into the existing world with **no regressions** to Peninsula rail, Bayline Flight or the world, rewriting world
code where that makes the whole game better. Creative, daring, ambitious. The lead (the main session) plans,
integrates, reviews, QAs and deploys. Workstream agents build. This file is the contract between them.

## 0. Non-negotiables

- **No trademarks.** Same policy as the Peninsula line ("Unofficial. Not affiliated with ..."): no BART logo,
  wordmark or the district's name on anything rendered in game. The in-game brand is **Bayline Metro**, in the
  same spirit as "Bayline Air" for the aircraft. Lines are named by colour and terminals ("Yellow Line, Antioch –
  SFO/Millbrae"). Real station names, real line colours, real timetable (public GTFS), real alignments (OSM) are
  fine. README/credits get "Unofficial. Not affiliated with the San Francisco Bay Area Rapid Transit District."
- **No regressions.** Peninsula rail (drive, PTC, signals, ride, boarding), flight (all types, autoland,
  missions), multiplayer, graphics tiers, and frame time on the existing hero views must be unchanged or
  better. `tools/qa_all.sh`, `qa_drive.js`, `qa_ptc.js`, `qa_signal.js` and `qa_flight.js` must still pass.
- **Everything streams.** Nothing BART-related may block the first frame or load the whole system up front.
  Build geometry per chunk around the camera and drop it behind; far LODs must be nearly free.
- **Every quality tier works.** Low stays usable on integrated GPUs; Ultra/Ultra+ get the richest detail.
- **Accuracy is part of the quality.** Alignments within ~1–2 m of the real track (checked against the NAIP
  photo and lidar), correct station configurations (island vs side, levels, which tracks), real headways.
  Where a fact isn't public, pick a plausible value and log it in your notes as an assumption.

## 1. The real system (facts to build on; verify and extend)

- 50 stations, ~131 route-miles (~211 km), broad gauge **1,676 mm (5 ft 6 in)**, **1,000 V DC third rail**,
  automatic train control (ATO with an operator; wayside ATC speed codes). Platforms ~213 m (700 ft) for
  10-car trains, platform edge at car-floor height (level boarding).
- Lines in 2026 (from GTFS `routes.txt`, use its colours): Yellow (Antioch – SFO/Millbrae), Orange (Richmond –
  Berryessa), Blue (Dublin/Pleasanton – Daly City), Red (Richmond – Millbrae/SFO), Green (Berryessa – Daly City),
  plus the Coliseum – Oakland Airport automated connector (cable-hauled people mover), and the Antioch –
  Pittsburg/Bay Point diesel/hybrid service (Stadler FLIRT DMUs, cross-platform transfer at Pittsburg/Bay Point).
  Evening/weekend patterns differ; GTFS is the truth.
- Fleet: **Fleet of the Future** D-cars (cab) and E-cars (no cab), three door pairs per side, ~3.2 m wide.
  Research exact dimensions, door spacing, seating, interior colours, displays, cab layout, lighting, bogies,
  third-rail shoes, and the look of the front end. (Legacy A/B/C cars are retired; optional as a heritage
  special.)
- Signature places: the **Transbay Tube** (immersed tube under the Bay, ~5.8 km, deepest ~41 m below the
  surface); the **Market Street subway** (BART on the lowest level, Muni Metro above, concourse on top);
  **Oakland 12th St / 19th St** (two-level stations); the **Berkeley Hills Tunnel** (~5.2 km) between Rockridge
  and Orinda; median running in **SR-24**, **I-580** and **SR-4**; long **aerial guideways** (West Oakland,
  Fruitvale – Hayward – Fremont, Walnut Creek – Concord, El Cerrito); the **Oakland Wye**; **Millbrae**,
  shared with the Peninsula line; **SFO** inside the airport; **Milpitas/Berryessa** (2020 era).

## 2. Architecture and data contract

Canonical station keys are BART's four-letter abbreviations (EMBR, MONT, POWL, CIVC, 16TH, 24TH, GLEN, BALB,
DALY, COLM, SSAN, SBRN, SFIA, MLBR, WOAK, 12TH, 19TH, MCAR, ASHB, DBRK, NBRK, PLZA, DELN, RICH, ROCK, ORIN,
LAFY, WCRK, PHIL, CONC, NCON, PITT, PCTR, ANTC, LAKE, FTVL, COLS, SANL, BAYF, HAYW, SHAY, UCTY, FRMT, WARM,
MLPT, BERY, CAST, WDUB, DUBL, OAKL). World coordinates are the existing Bay frame (x east, z south, metres,
`Globe`/`Geo`); heights are metres above sea level like `Terrain.h`.

### Data (written by the data workstream under `data/pub/v2/metro/`, streamed at runtime)

`notes/bart-data.md` is the authoritative format spec. The data workstream publishes it first (a stub within the
first hour), then keeps it current. Minimum content:

- `metro/network.json`: `stations[]` (id, name, lat/lon, x/z, type `subway | aerial | surface | median | trench`,
  platform layout `island | side | stacked | split`, level heights, platform polygons/edges per track with
  s-ranges, entrances from OSM, notes, `hero` flag); `tracks[]` (id, polyline samples every ≤ 5 m as `[x, y, z]`
  top-of-rail, cumulative `s`, per-segment structure `bored | cutcover | tube | aerial | grade | trench | median |
  embankment | bridge | portal`, civil speed limits, links to next/prev tracks); `junctions[]`
  (turnouts/crossovers with the joined tracks and s); `lines[]` (id, colour, terminals, the ordered track path
  for each direction and pattern); `yards[]` (optional, storage tracks).
- `metro/timetable.json`: feed metadata, service calendars (weekday/Saturday/Sunday and exceptions), trips (line,
  direction, pattern, consist length in cars, stop sequence with arrival/departure seconds after midnight,
  including after-midnight trips).
- Vertical profile: solved from lidar/terrain + engineering constraints (max ~4 % grade, portal locations from
  OSM `tunnel=yes`, aerial clearances, known depths such as the Tube). Log every assumption.
- Runtime loader **`src/js/21_metronet.js`** (`MetroNet`) is owned by the data workstream: `load()`,
  `stations`, `byId`, `tracks`, `frame(trackId, s, out)` (position, tangent, up, cant, structure, speed limit),
  `nearest(x, z)`, `pathFor(line, dir, pattern)`, `stationsNear(x, z, r)`, `inTunnelAt(x, y, z)`.

### Runtime modules (numbered so `build.py` concatenates them in dependency order)

| file | owner | what |
|---|---|---|
| `21_metronet.js` | data | loader + queries (above) |
| `23_metrotrack.js`, `24_metrotube.js` … | infra | guideway, rails, third rail, ties/direct fixation, aerial box girders + columns, retaining walls, trenches, medians, fences, bored/cut-and-cover tunnels, the Transbay Tube, portals, junction geometry, chunked streaming + LOD |
| `26_metrostations.js`, `27_*` … | stations | station generator (subway/aerial/surface/median/trench archetypes) + hand-authored hero stations; platforms, canopies, mezzanines, escalators/stairs/elevators, fare gates, signage (Bayline Metro), lighting, walkable metadata |
| `41_metrokit.js`, `42_*` … | trains | Fleet of the Future D/E cars (exterior, interior, cab), the FLIRT DMU, the airport people mover; LODs; API modelled on `TrainKit` (see notes/trains.md) |
| `46_metrosim.js`, `47_metro*` … | sim | timetable-driven trains (deterministic from the clock), kinematics, ATC, dispatch, junctions, player ride/drive/walk integration, UI (system map, arrivals, station picker), audio, multiplayer modes, optional live mode |
| existing shared files (`55_player.js`, `62_game.js`, `66_ui.js`, `90_main.js`, `70_sound.js`, `80_net.js`, `src/head.html`) | sim | integration edits (keep them surgical) |
| engine files (`10_env.js`, `12_terrain.js`, `14_post.js`, `13_gfx.js`) | infra | underground support: terrain openings at portals/entrances, "underground" render state, local lighting |
| data pipeline for world coverage (`tools/tiles/*`, `tools/bake_*.py`, `tools/fetch_osm.py`) | world | extend the high-detail world along every BART corridor |

`MetroNet` must be usable in a plain preview page (like `preview/trains.html`) so each workstream can build
and screenshot its piece in isolation, then integrate.

## 3. Quality bar ("much better than the Peninsula line")

- **Trains:** proportions within a few cm of the real car; PBR with per-part materials, tangent-space detail
  (panel seams, rivet lines, grilles, gaskets), glass with real reflections, lit interiors that read from
  outside at night, LED destination and side signs showing line colour + terminal, animated doors with
  chimes, bogies that yaw on curves, third-rail shoes, underfloor equipment, couplers, pantograph-free roof
  detail, wear/grime variation per car, car numbers. Interiors walkable, with seats, stanchions, hand
  holds, next-stop displays, bike/wheelchair areas, lighting; a cab with working ATC display.
- **Infrastructure:** exact broad gauge, rail profile, fastenings, third rail with coverboard and insulators,
  contact ramps at gaps, aerial box girders with bearings and expansion joints, column shapes true to BART's
  1970s/2000s/2020 eras, tunnel liners with lights, walkways, cable trays, cross passages, the Tube's
  twin bores and gallery, portals blended into terrain, freeway medians with barriers and the freeway beside.
- **Stations:** every station recognisable to someone who rides it: layout, platform count/type, canopy
  style, materials (1970s concrete and tile, newer glass/steel), mezzanines, entrances where OSM puts them,
  escalators that move, signage, departure boards with real next trains, crowds sized by real ridership.
- **World:** the photoreal ground/lidar/buildings/trees coverage extended along every line so a BART ride
  from Antioch to SFO looks as good as the Peninsula. Terrain carved to the real alignment where at grade.
- **Sound:** propulsion whine that follows traction effort, wheel/rail noise by speed and structure (tunnel
  reverb, aerial boom, the famous curve squeal where the real system squeals), door chimes, announcements.
- **Novel:** portal-based visibility for underground (render only the cells you can see), a live mode that
  places trains from real-time predictions if the public feed allows it (via an nginx proxy, like `/adsb/`),
  anything else that makes someone say "how is this running in a browser?".

## 4. Performance budgets (measure; don't guess)

- Additive cost where BART is in view, **High tier**: ≤ +15 % median frame time vs the same view without it;
  ≤ +150 draw calls; nothing on Low beyond simple LOD geometry. When no BART is within ~3 km: ≈ 0 cost.
- A 10-car train at LOD0 exterior ≤ ~70 draw calls (instancing and merged meshes); interiors only for the car
  you're in and its neighbours; far trains are one instanced mesh per line-colour batch.
- Streaming: chunks ≤ ~1 km, built in time slices (≤ 4 ms per frame), with no hitch over 16 ms from BART code.
- Memory: ≤ ~250 MB extra GPU memory at Ultra near a hero station.

## 5. Workstreams, branches, worktrees, ports

Integration branch **`bart`** (from `main`). Each workstream has its own branch **`bart/<name>`** and git
worktree **`.worktrees/bart-<name>`**, with `data/pub` and `data/raw` symlinked to the main checkout (shared data,
so the data workstream's output is visible to all at once). Build with `BAYLINE_OUT=dist/<name>.html` and serve
your worktree with `python3 tools/devserver.py <port>`:

| workstream | branch | worktree | dev port |
|---|---|---|---|
| data (alignment, profile, stations meta, timetable, MetroNet) | `bart/data` | `.worktrees/bart-data` | 8131 |
| world (imagery/lidar/buildings/trees along every line, terrain carve) | `bart/world` | `.worktrees/bart-world` | 8132 |
| trains (MetroKit) | `bart/trains` | `.worktrees/bart-trains` | 8133 |
| infra (guideway, tunnels, Tube, portals, underground engine support) | `bart/infra` | `.worktrees/bart-infra` | 8134 |
| stations | `bart/stations` | `.worktrees/bart-stations` | 8135 |
| sim (timetable runtime, gameplay, UI, audio, integration) | `bart/sim` | `.worktrees/bart-sim` | 8136 |

Rules:
- Commit early and often to your branch. Never push, never touch `main`, never deploy: the lead merges into
  `bart`, runs QA, and ships to both servers. Merge `bart` into your branch when the lead says it moved
  (`git merge bart`) to pick up the other workstreams.
- Stay inside your files (table above). If you need a change in someone else's file, write the request in
  your status file; the lead routes it. Small, clearly-scoped hooks in shared files are OK if you say so.
- Status file: **`notes/bart/<name>.md`** (yours alone): what works, APIs, how to preview, open problems,
  assumptions, requests for other workstreams. Update it at every milestone; the lead reads these.
- Machine etiquette (one M2, 24 GB RAM, shared by everyone): one headless Chrome at a time per workstream,
  always run screenshots through `python3 tools/wd.py <seconds> <cmd…>` (kills hung captures), stop every
  server/process you start, keep raw downloads under `data/raw/` (it is shared; don't delete others' caches),
  disk is limited (~50 GB free): budget big downloads and delete temporary files.
- Visual QA is part of the job: screenshot your work at hero spots (day/night, near/far, Low/High/Ultra), look
  at the images critically, iterate. Keep the best evidence in `notes/bart/shots/<name>/` (small JPEGs).

## 6. Milestones

- **M1 (first hours):** data v0 (stations, track polylines with rough profile, timetable) + `MetroNet`;
  MetroKit D/E cars v1 in a preview page; guideway v1 in game for grade/aerial/tunnel; generic stations v1
  by type; trains running on the network from the timetable; world bake running. The lead integrates M1
  behind the `#metro=1` flag.
- **M2:** refined profile, Tube/tunnels/portals, hero stations, full interiors and cabs, ride/drive/walk,
  system map and arrivals, sounds, world coverage published; performance tuned; ship to production (still
  behind the flag if anything is rough).
- **M3:** polish, novel features, hero screenshots and a capture pass; enable by default; iterate.
