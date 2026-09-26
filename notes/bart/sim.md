# Bayline Metro: SIM workstream status

Owner: sim workstream (branch `bart-sim`, worktree `.worktrees/bart-sim`, dev port 8136).
Files owned: `src/js/46_metrosim.js`, `src/js/47_metro*.js` (`metroatc`, `metroplay`, `metroui`, `metrosound`, `metrolive`),
`tools/qa_metro_*.js`, `notes/bart/sim.md`, `notes/bart/shots/sim/`, plus surgical integration edits in the shared files
(`55_player.js`, `66_ui.js`, `70_sound.js`, `80_net.js`, `90_main.js`, `tools/devserver.py`). Everything is behind `#metro=1`
(`MetroSim.enabled`; the lead flips `DEFAULT_ON` in `46_metrosim.js` to ship it by default; `#metro=0` forces it off).

## Status (2026-09-26 01:50)

Working on the real MetroNet v0 + timetable (merged from `bart`), with placeholder consists until MetroKit lands:

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
    close 3.5 s before departure; door side from the platform data (travel-relative).
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
- **Multiplayer**: presence modes `mride` (8, car-local) and `mdrive` (9, s = leg·100000 + head position); other
  riders are drawn in their metro car; others' driven trains override the scheduled position. Works with the
  current relay (see "Server change" below: until then metro players are sent as `walk` at their world position).
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

(first runs 2026-09-26 01:30, placeholder consists, MetroNet v0)
- ATO WOAK→EMBR through the Tube: no ATC interventions, on time; programmed stop fixed to ±0.1 m (was 2.6 m over).
- MANUAL driver WOAK→EMBR→MONT→POWL: stops 0.72 / 0.76 m from the berth, on time; 3 ATC brakes before the driver
  used the "next code" target (fixed in the script: it now brakes to `vAllow`). Re-run pending.

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
  - Stop marks: the runtime uses the platform extent's leaving end (−1 m) for the berth; M2 berth marks per train
    length will be used automatically if `platforms[].s0/s1` stay the platform extents (tell me if you add `berth`).
  - PITT-T has no station entry (no platform extent/side): fine, the runtime centres the train on the stop point there.
- **TRAINS**: see the API expectations above; the cab display fields; please keep `bogieOffsets` in car metadata.
- **STATIONS**: `floorAt`, `blocked`, `spawnPoint(id, gtfs)`, `setBoard(...)` as above.

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
