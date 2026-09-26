# Bayline Metro: SIM workstream status

Owner: sim workstream (branch `bart-sim`, worktree `.worktrees/bart-sim`, dev port 8136).
Files owned: `src/js/46_metrosim.js`, `src/js/47_metro*.js` (`metroatc`, `metroplay`, `metroui`, `metrosound`, `metrolive`),
`tools/qa_metro_*.js`, `notes/bart/sim.md`, `notes/bart/shots/sim/`, plus surgical integration edits in the shared files
(`55_player.js`, `66_ui.js`, `70_sound.js`, `80_net.js`, `90_main.js`, `tools/devserver.py`). Everything is behind `#metro=1`
(`MetroSim.enabled`; the lead flips `DEFAULT_ON` in `46_metrosim.js` to ship it by default; `#metro=0` forces it off).

## Status (2026-09-26 04:00)

On `bart` 1f54fd2 (M1 integration: MetroNet v0 + timetable, infra guideway + Under, stations for all 50, MetroKit v0)
plus the lead's QA list done (platform spawns, metro HUD at stations); MetroKit v1 (bart-trains) verified in a scratch
build. Latest round: platform spawns with an open view beside where the next train will stand, the views following
the next train due on that platform, MetroNet berth marks, MetroKit v1 PIS/VATC feeds, system-map labels that never
collide, live mode verified against the real feed. Earlier notes below still hold:

- **Timetable runtime** (`MetroSim`): every trip of the service day (today + yesterday's after-midnight trips), per
  pattern leg (EMU / the Antioch DMU / the airport cable train), split again at reversals (SFO); 1,059 trips planned
  on a weekday in ~0.3 s at boot; per frame ~0.4 ms for ~60 trains at 8 AM.
  - Schedule: the published minute-rounded times are smoothed per leg by a weighted isotonic regression (PAVA)
    against minimum run times + dwells: trains never leave an origin early, never run faster than they can.
    Measured over every leg of a weekday: 0 discontinuities, 0 samples over the (effective) limit, mean |deviation
    from the published times| 7.8 s, worst 73 s.
  - Kinematics: minimum-time profile per run (FOTF: 3.0 mph/s to ~25 mph then constant power, 70 mph max, ATO
    braking 2.5 mph/s), the tail rule (speed up only once the last car clears a restriction), capped (performance
    level) to fill the scheduled time; tabulated once per distinct run (LRU), evaluated by binary search.
  - Timetable-consistent limits: v0 curvature limits have spurious dips (e.g. 20–30 mph blips in the straight Mission
    St subway); where a run's minimum time exceeds the published time + 30 s, the dips on that run are lifted to the
    lowest floor that fits (2,037 runs on a weekday with v0 data). ATC uses the same floors.
  - Dwell by station (20 s standard, 30–35 s downtown/transfers, ×1.2 at the peaks), doors open 2.5 s after the stop,
    close 3.5 s before departure; door side from the stations' built platform (else the platform data), travel-relative.
  - Berths: the head stops on MetroNet's berth mark for its direction (`platforms[].berth['+' | '-']`, 2 m inside the
    leaving end) when the data has one, else 1 m inside the platform's leaving end; reversals stop at the path's
    reversal point.
  - Physical trains: legs that meet at a terminal on the same platform are one train (it waits and changes ends);
    reversals keep the train where it is (its tail becomes its head); a chain keeps one identity (`chainKey`) and one
    length, so you can stay aboard through a turnback. Other turns go via the tail track (the train leaves ~150 s
    after arriving, the next appears up to 4 min before departure). Platform conflicts are resolved at replan.
  - Drawing: the nearest 8 (High; 6 Medium, 4 Low) trains get exact-length pooled consists posed bogie by bogie on
    MetroNet (roll from cant), everything else is ONE instanced mesh (a car-shaped box with the line-colour stripe,
    lit windows at night), plus head/tail light points at night and line-colour map dots from the air.
- **ATC + drive game** (`MetroATC`): wayside speed codes (civil code = limit over the train + half a circuit ahead,
  floored to 5 mph; occupancy code counted in clear ~180 m circuits to the next train's tail on the tracks ahead,
  any line: 0 → stop, 6, 18, 27, 36, 50, 70 mph). ATO (default): W at departure closes the doors and starts; it
  drives to the code and makes a programmed stop on the berth (±0.1 m). MANUAL (S or A): master controller in 1/8
  notches, ATC supervision: overspeed alarm > code + 1 mph, ATC service brake if not braking within 2.5 s or
  > code + 4 mph (released under code − 2), penalty brake on passing a stop code (R to reset). Scoring: berth accuracy
  (< 0.5 m perfect), punctuality vs the published times, comfort, ATC interventions; results card; bests saved.
  Reversal at SFO: Q changes ends.
- **Player**: board any metro train at any platform (E at an open door), ride (seats, walking the car, next-stop
  panel, the car's next-stop strip, the line strip), cab view, drive, chase (underground: a camera that rides the bore
  ahead of the train), trackside spots along the real path (never in a tunnel), heli, orbit; end of the line puts you
  on the platform; the Millbrae transfer (E on the metro platform → Peninsula platform for the next departure; the
  metro board also lists Peninsula connections; the reverse via the metro board button); Tab/F follow metro trains.
  Walking uses `MetroStations.floorAt/blocked` when present, else a fallback platform floor from MetroNet extents.
  Going to a platform (`#mst=`, boards, the map, missions) puts you on the stations' platform floor, on its centreline,
  a quarter along from where the next train comes in, facing it; the views follow that train, and once it has left
  (while you stay on that platform and haven't picked another train) the next one due there.
- **UI** (`MetroUI`): title card "Bayline Metro" (opens the system map); system map (N): our own octilinear
  schematic with parallel strands per line, or geographic over the NAIP tiles, live trains (arrows in line colours),
  line filter, station search, click a station (next trains, go to platform, arrivals) or a train (follow, cab view,
  drive from the next stop); arrivals board (B at a metro station): per platform, an amber LED line + the next trains
  (line, destination, cars, minutes, time), Peninsula connections at Millbrae, bus bridges today; ride panel;
  driver's display (speed, ATC code box, speed bar with the code marker, mode, notch, doors, guidance, next code,
  schedule); HUD location/sub-line for metro trains; help keys.
- **Sound** (`MetroSound`, plugin of `Sound`): FOTF traction (gear whine ~48 Hz per m/s, 6·fe motor harmonic, IGBT
  inverter: async carrier + ±2 fe sidebands below ~16 mph, then synchronous 15/9/3 pulses; regen in reverse), aerial
  boom, the Tube's hollow roar + the engine's tunnel reverb, flange squeal scaled by curvature and boosted where the
  real system squeals (Civic Center–16th, Tube approaches, Oakland Wye, Glen Park–Daly City, SFO wye), a quiet cable
  train, a three-note door chime; announcements (speechSynthesis): onboard "This is a Yellow Line train to SFO
  Airport. The next station is Montgomery St." / "Now arriving at …, doors will open on the left. Transfer here …";
  platforms "The next Antioch train, a ten car Yellow Line train, arrives in two minutes on platform 2" / "Ten car
  Antioch train now approaching platform 2."
- **Multiplayer**: presence modes `mride` (8, car-local) and `mdrive` (9); the train is identified in the `trip` field
  (`<trip id>[y]-<leg>`, `MetroSim.netKey`) and `s` is the head's position along that leg; other riders are drawn in
  their metro car; others' driven trains override the scheduled position. A relay older than hello v2 gets `walk` at
  the player's world position instead (see "Server change").
- **Live mode** (`MetroLive`): "Live positions" chip on the system map or `#mlive=1`. GTFS-RT trip updates via
  `/bartrt/tripupdate` (protobuf decoded in-page) → per-trip predicted times → the trip is replanned (the train snaps
  to its real position; boards show real minutes). Fallback without the proxy: the public departures API (CORS
  allowed): minutes/platform/destination/length/delay per station → matched to scheduled trips → median delay + real
  train length. Only with the live clock, every 20 s while on.

## How to play / test

- Build: `BAYLINE_OUT=dist/sim.html python3 build.py`, serve `python3 tools/devserver.py 8136`.
- `http://localhost:8136/sim.html#metro=1` → title card → "Bayline Metro" (system map), or keys: **N** system map,
  **B** at a metro station = arrivals, **Tab/F** follow, **E** board/step off/sit, **1–8** views.
- Links: `#auto&metro=1&t=08:00&mst=EMBR` (on a platform), `&mdrive=<trip>&mfrom=WOAK[&manual]` (drive),
  `&mmap=1|geo` (map), `&mlive=1` (live mode).
- Debug handles: `__bayline.MetroSim / MetroATC / MetroUI` (via `__baylineMods`), `window.MetroNet`.

## QA

- `tools/qa_metro_drive.js`: careful MANUAL driver (keyboard only) from West Oakland through the Tube and down Market St.
- `tools/qa_metro_atc.js`: reckless MANUAL driver (full power, never brakes): ATC must alarm, brake, never pass a stop code.
- `tools/qa_metro_ride.js`: arrivals board click → platform → board at a door (E) → ride → step off (E).
- Kinematics check (all legs, 1 s steps): 0 jumps, 0 overspeed samples, mean 7.8 s from the published times.
- Results: see "QA results" below (updated per milestone).

## QA results

### 2026-09-26 ~03:10–04:00 (sim.html on bart-sim 1d20226; the sim date is Saturday 9/26, so the Saturday timetable)

- **Platform spawns (the lead's list)**, `#auto&metro=1&t=08:07&mst=<ST>`: EMBR, MONT, WOAK, 12TH, MCAR, MLBR all put the
  walker on the stations' platform floor (`y` = `MetroStations.floorAt`: EMBR −15.46, MONT −8.05, WOAK 12.01 (aerial),
  12TH −3.33, MCAR 34.84, MLBR 4.91), `onMetroFloor` true, HUD "<Station> · Bayline Metro" + the focused metro train
  ("Red Line to Millbrae · 6 cars · 0 mph · at Embarcadero"), never a Peninsula train; prompts "Press E to board: …"
  beside an open door, "Press B for <station> trains", Millbrae adds "E transfer to the Peninsula line". First pass
  faced the escalator bank on the Market St island platforms; the spot picker now checks a 2 m corridor 16 m ahead for
  escalator/stair slopes below 5.2 m and walls, and stands beside where the next train will stop. Contact sheet:
  `notes/bart/shots/sim/mst_platform_spawns.jpg`.
- **Next-train follow**: WOAK 08:07, the dwelling Antioch train left; the views moved to the next train due on that
  platform (Red Line to Richmond, 55 mph, next West Oakland) without input.
- **Platform sides**: 105/105 platforms audited against the stations' geometry, 0 mismatches.
- **Live mode** (real clock 00:05 PT, `#auto&metro=1&mlive=1&mmap=1`, dev proxy): source GTFS-RT, 25 trips matched,
  24 of 27 running trains on predicted times, map chip "Live: 25 trains from real-time trip updates", no errors.
- **System map**: schematic, geographic (opens on the whole system when you're far from it) and train graph, no label
  collisions (`notes/bart/shots/sim/map_*.jpg`).
- **MetroKit v1** (bart-trains 7dd7d47 copied into a scratch build, not committed): consists, far batch (18–20 far
  trains through `createFarBatch`), ride flow boarded / rode / alighted on v1 car metadata; cab feeds below.
- **Kinematics** (Saturday, every leg, 1 s steps, 2.9 M samples): 0 position jumps, 0 samples over the effective limit,
  max 70.0 mph, mean |deviation| 6.3 s from the published times, worst 40 s, 0 early origin departures; 1,241 runs
  needed lifted v0 limit floors.

### 2026-09-26 ~02:40, on the M1 integration build (`bart` merged: infra guideway + Under, stations for all 50, world
north strip; placeholder consists until MetroKit is on `bart`):

- **Metro ride** (`qa_metro_ride.js`, Balboa Park board → Daly City): clicked a train on the arrivals board → on the
  platform → walked to an open door, E → aboard the 10-car Red Line to Millbrae (car 6) → rode → at Daly City the doors
  opened on the left → E at the door → on the stations workstream's platform floor (y 88.04). Announcements heard:
  "Ten car Millbrae train now approaching platform 1." · "This is a Red Line train to Millbrae. The next station is
  Daly City." · "Now arriving at Daly City. Doors will open on the left." · "The next Dublin / Pleasanton train, an eight
  car Blue Line train, arrives in two minutes on platform 2." No page errors.
- **Metro ATO** (WOAK → EMBR, through the Tube): no ATC intervention, on time, programmed stop on the berth.
- **Metro manual** (`qa_metro_drive.js`, earlier build): Embarcadero 0.54 m from the berth ("Good stop", "On time"),
  Montgomery 0.76 m; one ATC brake before the driver used the "next code" target (script fixed). M1 re-run: see below.
- **Metro reckless** (`qa_metro_atc.js`): ATC WARN → BRAKE → OK cycles at every code (50/55/60/70 mph), never a stop
  code passed (0 penalties); traction now cut while the ATC brake is applied (was 267 samples before the fix).
- **Kinematics** (every leg of a weekday, 1 s steps): 0 position jumps, 0 samples over the effective limit, mean
  7.8 s / worst 73 s from the published times, no early departures.
- **Peninsula regression, metro OFF** (`qa_all.sh` on this build): all views render (pa_orbit 26.3 ms, pa_platform
  32.7, sf_golden 32.5, sfo_flyover 35.5 with other agents on the GPU); ride flow boards; `qa_ptc.js`: WARN →
  ENFORCE at 83.9 mph → stop → release; `qa_signal.js`: stopped before the red (0 passed); `qa_drive.js`: drives
  (73 mph max, guidance, doors) — and with metro ON the same drive made a perfect, on-time Sunnyvale stop.
  `node tools/qa_flight.js`: every type takes off, cruises and autolands (unchanged files).
- With metro OFF every metro path is guarded (`MetroSim.enabled`): no per-frame work, no DOM, no network; the shared
  files behave as before (reviewed line by line: Player focus/drive/heading/walk, UI panels, Game missions, Sound kinds,
  Net modes).

## Server change needed (lead deploys)

`server/mp.py` accepts modes 0..7. Metro presence needs 0..9 (8 `mride`: riding a metro car, x/y/z car-local, car = car
index; 9 `mdrive`: driving a metro train). Nothing else changes: the train identity is in the `trip` field and `s` is a
plain position, so the clamp (-1000..250000) and the float32 snapshot are fine.

```diff
-        mode = int(_num(data[1], 0, 7))
+        mode = int(_num(data[1], 0, 9))
```
and advertise it in the hello (the client sends 8/9 only to a relay that says v >= 2; to an older relay it sends
`walk` at the player's world position instead, so nobody gets closed with 4009):
```diff
-        await ws.send(json.dumps({"t": "hi", "v": 1, "id": p.id, ...
+        await ws.send(json.dumps({"t": "hi", "v": 2, "id": p.id, ...
```

Presence encoding (answering the lead, 2026-09-26 02:00): `trip` = `MetroSim.netKey(train)` = `<GTFS trip id>[y]-<leg
index>` (e.g. `1965631-1`, `1965118y-0`; `y` = the previous service day's trip still running after midnight; the leg
index counts the runtime's legs of that trip: vehicle legs split at reversals), at most 12 chars of `[A-Za-z0-9_-]`
(trip ids are 7 digits). Every client resolves it the same way from the timetable (`MetroSim.resolveNet`). `s` = the
head's position along that leg in metres (legs are < 100 km).

Old clients (main's 80_net.js) and modes 8/9: they don't break. `MODE_NAMES[mode] || 'menu'` turns 8/9 into `menu`;
main's avatars and Sim skip `menu`. One cosmetic effect on tabs still running the old page: main's live map
(66_ui.js drawMap) draws `menu` players as a dot at (x, z), and for metro players x/z are car-local, so a stray dot and
callsign appear near the world origin (Mountain View) until that tab reloads. The snapshot is shared by all clients and
clients don't announce a version, so the relay can't map it per client; I'd accept it (it disappears on reload).

## nginx for live mode (lead deploys)

In the `http` block (next to the adsb zone/cache):
```nginx
limit_req_zone $binary_remote_addr zone=bartrt:1m rate=12r/m;
proxy_cache_path /tmp/bartrt_cache levels=1 keys_zone=bartrtc:1m max_size=8m inactive=60s use_temp_path=off;
```
In the `server` block (next to `location ~ ^/adsb/...`):
```nginx
# Bayline Metro live mode: the operator's GTFS-Realtime trip updates (no CORS on the feed), one shared 10 s cache
location = /bartrt/tripupdate {
    limit_req zone=bartrt burst=6 nodelay;
    set $bart_host api.bart.gov;
    proxy_pass https://$bart_host/gtfsrt/tripupdate.aspx;
    proxy_ssl_server_name on;
    proxy_ssl_name api.bart.gov;
    proxy_set_header Host api.bart.gov;
    proxy_set_header User-Agent "Bayline (https://bayline.tkanz.com)";
    proxy_set_header Cookie "";
    proxy_hide_header Set-Cookie;
    proxy_ignore_headers Cache-Control Expires Set-Cookie Vary;
    proxy_cache bartrtc;
    proxy_cache_key bart_tripupdate;
    proxy_cache_valid 200 10s;
    proxy_cache_valid any 20s;
    proxy_cache_lock on;
    proxy_cache_lock_timeout 6s;
    proxy_cache_use_stale updating error timeout http_500 http_502 http_503 http_504;
    proxy_connect_timeout 4s;
    proxy_read_timeout 8s;
    default_type application/octet-stream;
    add_header Cache-Control "no-store" always;
    add_header X-Cache $upstream_cache_status always;
    add_header X-Content-Type-Options nosniff always;
}
```
(The existing `resolver` line already covers `$bart_host`.) Without it, live mode falls back to the public departures
API (`api.bart.gov/api/etd.aspx`, CORS `*`, public key), polled every 20 s by each client that turns Live on.
The data is © BART under its developer license (free, as-is; no BART marks in the game).

## Interfaces agreed with other workstreams

### STATIONS: walking in multi-level stations (agreed 2026-09-26, answering the request in `stations.md`)

SIM calls, only when `#metro=1` and `MetroStations` exists (otherwise the Peninsula walk is byte-for-byte unchanged):

- `MetroStations.floorAt(x, y, z) -> number | null`: the walkable floor under the feet at (x, z) for feet near
  height `y` (world metres, same frame as `Terrain.h`). Among stacked levels, return the floor closest to `y` that is
  within about ±1.2 m (stairs and escalators are sloped floors, so a step is never more than ~0.3 m). `null` means
  "not on station floor metadata here" (outside the station, or no level near `y`).
- `MetroStations.blocked(x0, z0, x1, z1, y) -> bool`: true when the straight step (x0, z0) -> (x1, z1) at feet height
  `y` crosses a wall, a platform-edge barrier, a closed fare gate, a railing or a column.

What 55_player.js does with them (walk mode, `moveWalk` / `groundAt(x, z, y)`):

1. The ground under the walker is `floorAt(x, walk.y, z)` when it is a number, else the existing rule (Peninsula
   platform, airport, terrain). So standing in a subway concourse never snaps you up to the street.
2. A step is refused when `blocked(...)` is true, when the new floor is more than 0.6 m above the feet (same rule as
   today), or when the walker is below ground (feet more than 2 m under `Terrain.h`) and `floorAt` is `null` there
   (you cannot walk into the earth or off the end of a platform into a tunnel wall). While a station streams in
   (no floor yet under an underground walker) the walker holds still instead of popping up to the street.
3. Below ground, the building-footprint collision and the water test are skipped (the Transbay Tube is under water,
   Market St is under buildings).
4. Stepping off a platform edge onto the track is allowed only if the metadata allows it (it should not: `blocked`).
   Falling uses the same gravity as today onto whatever `floorAt` returns below.
5. Entrances: at the top of a street stair `floorAt` meets the terrain height; beyond its polygon it returns `null`
   and the normal terrain rule takes over, so walking out to the street is seamless.

Cost: `floorAt` is called about 4 times per frame and `blocked` once per attempted step while walking; please keep
them cheap (a per-station spatial grid is plenty). Until `MetroStations` is in the build, `MetroPlay.floorAt/blocked`
provide platform strips from MetroNet's platform extents (edge 1.68 m, 3.6–4.2 m wide, top 0.991 m above the rail).

Going to a platform (`MetroPlay.teleport`, used by `#mst=`, boards, the system map, missions): the platform of the next
train there (or the one asked for), a quarter of the way along from the end that train comes in at, on the platform's
centreline (probing `floorAt` across the platform from the edge), at the stations' platform height, facing up the
platform toward the arriving train (12° toward its track) with the focus on that train. If the station hasn't streamed
in yet, the walker is placed on an estimate and held (no gravity, no walking) until its floors exist, then moved to
the centreline. The metro context (HUD, prompts, the Peninsula strip) follows `Player.onMetroFloor()` (standing on a
metro station floor), so the shared Millbrae platform reads as metro when you stand on the metro side.

Also used: `MetroStations.spawnPoint(id, platformGtfsId) -> { x, y, z, yaw }` (yaw = heading, `atan2(dx, dz)`, like
`Stations.spawnPoint`) for "go to this platform" from boards and the system map, and
`MetroStations.setBoard(stationId, platformCode, rows)`: SIM pushes every 5 s for stations within 1.5 km of the camera,
`platformCode` = the GTFS platform code ('1', '2', '3' …, the part after the dash in `M16-1`), rows (≤ 4, next first) =
`{ line, color, dest, cars, min, trip }`.

### TRAINS (MetroKit): what the runtime expects

- `MetroKit.createConsist(kind, { cars, seed, name })`, kind `'bart' | 'dmu' | 'apm'`, **exactly `cars` cars** in
  physical order, car 0 with its cab at the consist's +X end, the last car flipped (TrainKit convention). The pool
  keeps ≤ 9 BART consists (6/4 on Medium/Low) and recycles by length; `consist.dispose()` is called when one is
  dropped (optional).
- Per car (as TrainKit): `group`, `length`, `width`, `bogieOffsets [front, rear]`, `floorRegions`, `ramps`, `gangways`,
  `seats`, `doors [{x, side, width, sillY}]`, `cabEye`. Posing: `TrainKit.poseCar(car, F, R, roll)` with F/R the
  bogie-pivot frames from MetroNet (`x,y,z` + tangent); if a car has `setBogies(F, R)` it is called after posing with
  those frames (bogie yaw on curves).
- Per consist, called each frame for near trains: `setDestination(text, lineColorHex)`, `setDoors('left'|'right'|'none', t)`
  (car-local sides), `setLights({ head, tail, interior, cab, lead: 'front'|'rear' })`, `setLeadEnd`, `setNight(n)`,
  `speed` (signed, + toward +X), `update(dt)`, `setLOD(0|1|2)` (< 180 m / < 700 m / beyond), `setInteriorVisible(bool)`
  (focus train or < 60 m), `setDisplay({ line, color, nextStop, destination, clock })` (passenger screens),
  `setCab({ speedMph, codeMph, mode: 'ATO'|'MANUAL', notch, nextStop, distFt, clock, atc: 'ok'|'warn'|'brake'|'penalty',
  line, color, destination })` (the VATC display: ACTUAL = speedMph, AUTHORIZED = codeMph; COMMANDED can be added).

### INFRA

- `Under.keep(car.group)` for every metro car group when its consist is created (so trains draw while the outdoor
  world is culled underground); `Under.unkeep(group)` when a consist is dropped, if you add it.
- `Under.state.cell` is read by the sound (station/tunnel ambience).

## Requests for other workstreams

- **DATA**
  - v0 speed limits have spurious dips that make the timetable impossible on some runs (min run vs published): GLEN→24TH
    286 s vs 120 s, COLM→DALY 158 vs 120, EMBR→WOAK 386 vs 360, WOAK→EMBR 407 vs 360, PITT→NCON 404 vs 360,
    ASHB→DBRK 156 vs 120, NBRK→PLZA 154 vs 120, SBRN→SSAN 188 vs 120, 24TH→GLEN 184 vs 120, DALY→COLM 214 vs 180,
    FTVL→LAKE 264 vs 240, PHIL→CONC 343 vs 300. The runtime lifts dips per run to keep time; real limits will make that
    a no-op. (Example: GLEN→24TH has 20, 25, 30, 40 mph dips inside a straight subway.)
  - Reversal stops (SFO): the path reverses at the stop point (the station centre in v0), so a 10-car train stops with
    its head at mid-platform. Please put the reversal point at the platform's end (the bumper side) in M2 berth marks.
  - Stop marks: `platforms[].berth['+' | '-']` is used (2026-09-26 02:33 data) for the head's stop point; per-length
    marks (e.g. `berth: { '+': { 10: s, 8: s, … } }`) would be welcome if the real system stops shorter trains
    elsewhere (the runtime takes a number today; tell me before changing the shape).
  - PITT-T has no station entry (no platform extent/side): fine, the runtime centres the train on the stop point there.
  - Platform sides: resolved. Audit 2026-09-26 03:05 (`MetroStations.spawnPoint` vs `platforms[].side`, all 105
    platforms): 0 mismatches. The runtime still takes the side from the stations' geometry when it is in the build.
- **TRAINS**
  - MetroKit v1 (bart-trains 7dd7d47, tested in a scratch build, not committed here): the runtime now feeds the
    PIS (`setDisplay({ line, lineName, color, destination, nextStop, arriving, doors, transfer, stops, index, clock })`,
    redrawn only when the stop/phase/minute changes) and the VATC (`setCab({ speedMph, atcCodeMph, targetMph, effort,
    handle, brake, mode, doors, cars, nextStop, distFt, clock, atc, lineColor, destination })`; `effort` is always a
    number so your notch mapping never sees my notch text), uses `MetroKit.createFarBatch` when exported (else
    `_k.createFarBatch`) and passes the drawing-buffer size to `end(night, res)`; `dispose()` is called on dropped consists.
    `dmu` / `apm` still fall back to placeholders per kind (near and far) until their builders land.
  - MetroKit v0 is integrated: consists come from `MetroKit.createConsist(kind, { cars, seed, name })` (exact length),
    posed with `MetroKit.poseOnTrack` (bogie yaw; for a train led by its last car the frame function runs backwards
    along the path with the tangent and bank flipped), `setDestination({ line, color, text })`, `setNextStop`,
    `setDoors`, `setLights`, `setNight`, `setLOD(0|1)` (my LOD 2 is only used for placeholders: MetroKit's LOD 2 hides
    the car), `setInteriorVisible`, `speed`, `update`. Kinds MetroKit doesn't build yet (`dmu`, `apm` stubs) fall back
    to my placeholders automatically, per kind.
  - Far trains: when `MetroKit._k.createFarBatch` exists I route far trains through it (`begin / addCar(kind, 'D'|'E',
    {x,y,z,yaw,pitch}, flip) / addLamp / end(night)`), per kind, with my own instanced batch as the fallback. Please
    export it publicly (`MetroKit.createFarBatch`) when it lands; keep `42_metrokit_far.js` loading AFTER
    `42_metrokit_fotf.js` if it touches `K.builders.bart` at load (build.py sorts by name: `_far` < `_fotf`; in my scratch
    test that ordering threw a TypeError at load, which kills the whole app).
  - Please add `consist.dispose()` (geometry is shared; the per-consist sign canvas / textures / materials): the pool
    recycles consists of other lengths (6/8/10 cars) and drops them from the scene.
  - Cab display: `setCab({ speedMph, codeMph (AUTHORIZED), commandedMph, mode: 'ATO'|'MANUAL', notch, atc, nextStop,
    distFt, clock, line, color, destination })` would feed your VATC screen; I call it only if it exists.
- **STATIONS**: `floorAt`, `blocked`, `spawnPoint(id, gtfs)`, `setBoard(...)` as above. Small one: the airport
  connector platforms (COLS `H10`, OAKL `H40`) return a `spawnPoint` more than 14 m from their MetroNet track (H1.1 /
  H1.2), so the side audit can't place them (the cable train's doors use the data side there).

## Assumptions log

| # | assumption | why / source |
|---|---|---|
| S1 | FOTF performance: 3.0 mph/s initial (1.34 m/s²) to ~25 mph, then constant power (≈14.8 W/kg at the rail, four 194 hp motors per car), 70 mph max; ATO braking 2.5 mph/s, full service 3 mph/s, emergency 3.6 mph/s | BART design figures (3 mph/s), FOTF 80→0 in 20–25 s, motor ratings |
| S2 | Dwell 20 s (BART's "20-second station stops"), 24–35 s at downtown / transfer stations, ×1.2 at the weekday peaks | BART system facts; judgment |
| S3 | Trains stop with the head at the platform's leaving end whatever their length | common practice; BART platform signs; to verify |
| S4 | ATC: ~180 m circuits (≈2,300 circuits on ~420 km of track); occupancy ladder 0/6/18/27/36/50/70 by clear circuits; civil code = limit floored to 5 mph (the real system has fewer civil codes) | BART ATC facts (2,300 circuits; codes 0, 6, 18, 27, 36, 50, 70, 80) |
| S5 | Turnback pairing: first unclaimed departure of the same vehicle at the same station 100 s .. 40 min after arrival, same platform preferred; a physical train keeps its length along the chain | GTFS has no block ids |
| S6 | Door chime (three descending tones), horn chord (F4-A4-C5) and traction harmonics are our own synthesis modeled on the new cars' character, not recordings | no audio files allowed |
| S7 | Timetable-consistent limit floors per run (see Status) while v0 limits are rough | keeps the real schedule |
| S8 | Live mode: when both proxy and ETD fail, the timetable stays; ETD matching window ±5 min, median delay per trip | judgment |
