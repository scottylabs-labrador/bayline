# Bayline Metro: SIM workstream status

Owner: sim workstream (branch `bart-sim`, worktree `.worktrees/bart-sim`, dev port 8136).
Files owned: `src/js/46_metrosim.js`, `src/js/47_metro*.js` (`metroatc`, `metroplay`, `metroui`, `metrosound`, `metrolive`),
`tools/qa_metro_*.js`, `notes/bart/sim.md`, `notes/bart/shots/sim/`, plus surgical integration edits in the shared files
(`55_player.js`, `66_ui.js`, `70_sound.js`, `80_net.js`, `90_main.js`, `tools/devserver.py`). Everything is behind `#metro=1`
(`MetroSim.enabled`; the lead flips `DEFAULT_ON` in `46_metrosim.js` to ship it by default; `#metro=0` forces it off).

## Status (2026-09-26 07:30: M3 gate work, see "M3 gate items owned by SIM")

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
    Measured over every leg (M2 data, after the envelope fix): weekday 0 discontinuities, 0 samples over the
    (effective) limit, mean |deviation from the published times| 8.9 s, worst 130 s; Saturday 5.5 s, worst 121 s.
  - Kinematics: minimum-time profile per run (FOTF: 3.0 mph/s to ~25 mph then constant power, 70 mph max, ATO
    braking 2.5 mph/s), the tail rule (speed up only once the last car clears a restriction), capped (performance
    level) to fill the scheduled time; tabulated once per distinct run (LRU), evaluated by binary search.
  - Timetable-consistent limits: where a run's minimum time with MetroNet's codes exceeds the published time + 30 s,
    the restrictions on that run are lifted to the lowest floor that fits (M2: 1,493 of ~16,000 runs on a weekday,
    mostly GLEN↔24TH, the Oakland Wye and the Daly City–San Bruno runs). ATC uses the same floors, rounded up to the
    next code.
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

### `bart` 4781c87 merged (round 3: MetroKit GTW DMU + Cable Liner APM, per-vehicle platforms, third rail), smoke test

- All three vehicle kinds are MetroKit consists now (no placeholders): EMBR 5-car FOTF dwelling beside the walker;
  `mst=PITT-T&mplat=E10-T`: the 1-unit Antioch Shuttle GTW at the eBART face, doors open, "Press E to board: Antioch
  Shuttle to Antioch", passengers seated; `mst=OAKL`: the 3-car Cable Liner at the airport platform (y 10.8, on the
  stations' floor). Far trains use MetroKit's per-builder car designs (`consist()` specs: GTW units, APM end/mid cars).
- Missions: all seven start (drives in the cab incl. Airport Reversal; rides pick the GTW and the Cable Liner).
- Ride flow: BALB → Daly City boarded, rode, alighted (y 92.87), announcements as before.
- `mst=COLS&mplat=H10` (the connector's Coliseum platform): the walker ends in the parking lot at street level (y 3.82):
  there is no stations walk floor at the data's platform height (16.75 m, track H1.1) and the stations' `spawnPoint`
  for H10 is at street level; the runtime now ignores a spawn point more than 1.5 m off the data's platform height, holds
  the walker there for 15 s, then gravity wins. Request to STATIONS below.

### M2 data + `bart` 62c83db merged (MetroKit v1), 2026-09-26 ~03:40–04:40, sim.html on bart-sim (Saturday timetable)

What changed for M2: stops are berths (the runtime stops the head on `stops[].d`, i.e. `platforms[].berth`), the
ATC civil code is MetroNet's code per segment (6/18/27/36/50/70; no more 5 mph floors: a 27 mph segment shows 27, not
25), the 2026 consist lengths come straight from the timetable (Red 5 off-peak, Yellow 9, eBART in units).

- **Metro ride** (`qa_metro_ride.js`): BALB board → 5-car Red Line to Millbrae, car 3 → Daly City, doors left → stepped
  off onto the platform (y 92.87). "Five car Millbrae train now approaching platform 1." · "This is a Red Line train to
  Millbrae. The next station is Daly City." · "Now arriving at Daly City. Doors will open on the left."
- **Kinematics bug found and fixed on M2**: the first M2 check showed trains 45–53 s off the published times (worst
  4 min) with 4,260 (Saturday) / 6,189 (weekday) runs needing lifted floors. Cause: the "restriction starts one sample
  early" pass in the run envelope ran backward and cascaded, so every run was capped at its slowest code from the
  start (GLEN→24TH at 18 mph for 2.3 km: 325 s for a 120 s run). Fixed (forward pass, one sample). After the fix, every
  leg at 1 s steps: **Saturday** 2.9 M samples, 0 jumps, 0 over the limit, max 70.0 mph, mean |deviation| 5.5 s, worst
  121 s, 0 early departures, 936 relaxed runs; **weekday** 4.0 M samples, 0 jumps, 0 over, mean 8.9 s, worst 130 s,
  1,493 relaxed runs. Minimum run + dwell vs the published gap over all 189 distinct BART station pairs: p10/p50/p90
  −96/−38/+14 s (most runs have slack). This bug also inflated the v0 "limit dips" list sent to DATA (see Requests).
- **Metro ATC, reckless driver** (`qa_metro_atc.js`): 25 WARN, 26 ATC BRAKE, 0 penalty, codes seen 70/50/36 (real
  codes), traction applied during an ATC brake in 4 samples (the frame the brake engages).
- **Cab** (MetroKit v1): VATC screen fed (AUTHORIZED 36 at West Oakland, COMMANDED, effort −0.5 holding, doors "open
  left", ATO), PIS fed (next Embarcadero, doors left, transfer "The ferries and the city light rail", 24 stops, index 9).
  Shot: `notes/bart/shots/sim/cab_vatc_metrokit.jpg`. The driver's display now shows the deviation from the plan
  ("8:07 AM (on time)") instead of the time left.
- **Platform spawns** on the merged stations: all six on the stations' floors (EMBR −15.51, MONT −8.02, WOAK 12.10,
  12TH −12.67 lower level, MCAR 35.61, MLBR 4.99), metro HUD and prompts; 12TH's lower level renders without its station
  box (request below). Follow-the-next-train: WOAK, the arriving Antioch train left, the views moved to the next train
  due there (Red to Richmond, dwelling at Embarcadero).
- **Metro manual drive** (`qa_metro_drive.js`, keyboard only, WOAK → Civic Center): Embarcadero 0.57 m from the berth
  ("Good stop", on time), Montgomery 0.66 m, Powell 0.71 m, Civic Center 0.66 m ("On the berth"), all on time, 0
  warnings / ATC brakes / penalties, max 67 mph, score 850. Re-run after the envelope fix: Embarcadero 0.67 m (one ATC
  overspeed brake on the approach: the scripted driver met an occupancy step behind the train ahead), Montgomery
  0.73 m, Powell 0.75 m, all on time, 0 penalties.
- **Metro ATC after the envelope fix**: 23 WARN, 22 ATC BRAKE, 0 penalty, codes 70/50/36/27, traction during an ATC
  brake in 2 samples.
- **Platform spawns after the envelope fix** (contact sheet `notes/bart/shots/sim/mst_platform_spawns.jpg`): EMBR, MONT
  and WOAK now show the dwelling MetroKit train beside the walker, with the view open up the platform (MONT between
  its column rows); MCAR, MLBR fine; 12TH lower level still without its station box (request below).
- **Missions**: all seven start: Under the Bay, Market Street (manual), Berkeley Hills and Airport Reversal in the cab
  ("You have the Red Line to Millbrae", through the SFO reversal), Commute at Embarcadero, the Cable Train (3-car
  Airport Connector) and the Antioch Shuttle ("1-unit") rides. (Airport Reversal found no train on the first try: the
  SBRN → SFO → MLBR trip is two legs; the search now follows the train through the reversal.)
- **Frame cost** (`tools/qa_metro_perf.sh` views, 1440×900, real GPU, metro on/off interleaved three times so the other
  workstreams' Chromes hit both sides; medians): Embarcadero 08:00 from the air on 47.9 ms / off 69.9 ms (no measurable
  metro cost in the noise; +24 draw calls, +0.15 M triangles); MacArthur 17:30 on 83.7 / off 63.2 ms (ranges overlap:
  on 71–627, off 53–93; +117 draw calls and +0.95 M triangles, mostly the station and guideway geometry plus the near
  MetroKit consists); system map open 66.9 ms (46–75). The runtime's own CPU (`MetroSim.update`, ~40 trains, near
  consists + far batch + dots) is 0.5–1.0 ms a frame. Absolute frame times on this shared machine are not meaningful;
  please re-measure on an idle GPU before shipping (`PORT=… sh tools/qa_metro_perf.sh`).
- **Peninsula regression, metro OFF**: `qa_ptc.js` WARN at 80.9 → ENFORCE at 83.8 mph → stop → release; `qa_signal.js`
  stopped 1,454 m short of the red (0 passed); `qa_all.sh` views render, drive (74 mph, guidance, doors), ride boards;
  `qa_flight.js` every type takes off, cruises and autolands (same numbers as before). Frame times in this run are not
  comparable (another workstream's Chrome was on the GPU: pa_orbit 77.6 ms, sf_golden 30.9 ms).

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

## M3 gate items owned by SIM (status)

- **Item 2, the Peninsula with the metro on**: `PORT=<port> METRO=1 sh tools/qa_metro_peninsula.sh sim.html <out>` runs,
  in one command, `qa_all.sh` (views, keyboard drive, ride; `METRO=1|0` now appends `#metro=1|0` to every view), PTC,
  signal, the Caltrain stations next to the metro (`tools/qa_peninsula_spots.js`: at 4th & King, South SF, San Bruno,
  Millbrae, Hillsdale and Diridon: the HUD place is the Caltrain station, the sub-line a Peninsula train, the Peninsula
  strip shown, the Peninsula walk prompt (+ "transfer to the metro" at Millbrae), B opens the Peninsula board) and the
  flight FDM. Result: **0 failed with METRO=1 and 0 failed with METRO=0** (2026-09-26 06:00, bart-sim a1cc675+).
- **Item 4, boot and failure isolation**: see the next section. `tools/qa_metro_isolation.sh`: 11/11.
- **Item 5, phones**: touch features: the walk prompt is tappable on touch screens and worded for them ("Tap to board:
  …", "Tap for Embarcadero trains", "Tap to transfer to the metro"); the system map pans with one finger, pinch-zooms
  with two, picks with a bigger radius; the drive bar (on-screen driving buttons, already there for the Peninsula)
  reads ATO / Ends and hides the bell while driving a metro train; boards explain ride/drive by touch.
  `tools/qa_metro_mobile.sh`: shot.mjs `--mobile` (DPR 2, touch) 390×844, Low and Medium, GPU: map from the HUD pill,
  tap a station, "Go to the platform", tap the prompt for the arrivals board ("Tap for Embarcadero trains", the touch
  hint), tap a train on it (on its platform), tap the prompt to board, ride panel, drive bar Power (ATO): 9 steps.
- **Item 6, the front door** (approved v2): title card Bay-wide with the metro on (eyebrow, 3-line intro, one sentence on
  phones, Peninsula Ride/Drive cards name their line, credits folded behind "Data & credits" with the non-affiliation
  lines visible), a Bayline Metro strip (route-bundle icon, Ride / Drive / System map with inline station search over
  names, codes and aliases, and the drive runs); a HUD "Metro" pill; help keys; the map's "Unofficial. Not affiliated
  with the San Francisco Bay Area Rapid Transit District" line. Shots: `notes/bart/shots/sim/front_v2_*.jpg`.
  `tools/qa_metro_front.sh` (+ `qa_metro_front.js`), from the title card at 1366×768, no `#auto`: with the metro on,
  the strip, eyebrow, credits and non-affiliation lines, the card fits, Ride's search (19 names, codes and aliases,
  "no station"), Drive's runs, Back, a station chip starts on its platform with the HUD naming it, the HUD Metro pill
  opens the map with its line, help keys, no trademark in any visible text of the card, map or board; with `#metro=0`
  the old card, eyebrow, intro and credits, no metro keys, no pill, no metro data loaded; with no flag, whichever of the
  two the page's default gives.
- **Item 7, multiplayer**: `node tools/qa_metro_mp.mjs [page] [out]` (under tools/wd.py): a local relay (server/mp.py,
  modes 0..9, hello v2), one headless Chrome with two pages at Millbrae: A boards a metro train (mode 8), B walks the
  Peninsula platform (mode 1); each sees the other (B draws A in its own copy of the car); A drives (mode 9) and B's copy
  of the train follows A.
- **Item 8, clean console**: `sh tools/qa_metro_tour.sh [page] [out]`: a player's tour of every station (50 + the
  connector's COLS/OAKL platforms + the shuttle's PITT-T faces + ANTC), then 10 minutes of `#auto` with the metro on
  following trains through the camera views; fails on any page error, console error or metro failure.

### M3 gate commands (SIM's items; `XH=metrodir=metro-next/` until DATA's M2b is promoted, then drop it)

Build and serve the candidate (`BAYLINE_OUT=dist/sim.html python3 build.py`, `python3 tools/devserver.py 8136`), then
from the repo root, one at a time (each script runs one headless Chrome at a time under `tools/wd.py`; `--gpu` inside):

```sh
PORT=8136 METRO=1 XH=metrodir=metro-next/ sh tools/qa_metro_peninsula.sh sim.html /tmp/g2on    # item 2, the metro on
PORT=8136 METRO=0 XH=metrodir=metro-next/ sh tools/qa_metro_peninsula.sh sim.html /tmp/g2off   # item 2, the same run with the metro off
PORT=8136 XH=metrodir=metro-next/ sh tools/qa_metro_isolation.sh sim.html /tmp/g4              # item 4 (11 cases, first frame on/off)
PORT=8136 XH=metrodir=metro-next/ sh tools/qa_metro_mobile.sh sim.html /tmp/g5                 # item 5 (phone Low + Medium)
PORT=8136 XH=metrodir=metro-next/ sh tools/qa_metro_front.sh sim.html /tmp/g6                  # item 6 (front door: on, #metro=0, default; first run pending)
XH=metrodir=metro-next/ python3 tools/wd.py 400 node tools/qa_metro_mp.mjs http://127.0.0.1:8136/sim.html /tmp/g7   # item 7
PORT=8136 XH=metrodir=metro-next/ sh tools/qa_metro_tour.sh sim.html /tmp/g8                   # item 8 (55 stops + 10 min #auto)
HEAP_VARIANTS='metro=0|metro=1' python3 tools/wd.py 400 node tools/qa_metro_heap.mjs http://127.0.0.1:8136/sim.html "at=palo_alto&t=08:03&q=low&metrodir=metro-next/" --mobile   # heap (drop HEAP_VARIANTS for per module)
```

Each prints PASS/FAIL lines and ends with `== N failed` (exit code 0 when N = 0); the MP script prints its 12 checks.
`XH` reaches every URL (qa_all.sh inside item 2 takes it too). **The flip** is one line, `const DEFAULT_ON = true;` in
`src/js/18_metro.js`; the commands force the metro with `#metro=1` / `#metro=0` where it matters, so they run the same
before and after the flip; item 6 also loads the page with no flag and checks whichever card the default gives (the
old card before the flip, the metro card after it).

### M3 results (2026-09-26)

**Merged build (bart-sim a3a132e = bart 87c32c7 merged, on metro-next), 09:08-09:52**, stopped at item 2 when the lead
started the M3 gate on the final candidate (bart acf077f + the flip; it contains every SIM commit up to c3948d3):
- Item 4: 11/11 (one warning each, no errors, frames advancing); first frame metro off 4969 ms / on 4961 ms.
- Millbrae depot hall (STATIONS' split: Landmarks' hall hidden while the BART station draws the shared hall): after an
  injected metro failure it is visible and in the scene. At `at=place_MLBR` it had not been hidden yet 45 s after the
  metro loaded (MLBR, the biggest station, still building under a loaded GPU), so the hidden → shown path is not yet
  observed; the follow-up check teleports to the MLBR platform and waits up to 150 s (run after the gate).
- Front / ride / drive / ATC on metro-next: search with M2b aliases, DATA's shuttle headsigns; ride Balboa Park → Daly
  City (doors left); manual drive Embarcadero 0.73 m, Montgomery 0.74, Powell 0.68, Civic Center 0.69, all on time, 0
  ATC brakes, 67 mph max; reckless ATC 25 warn / 24 brake / 0 penalty (codes 70/50/36).
- Item 5: phone Low and Medium 9/9 each (now with the arrivals board by touch: prompt tap "Tap for Embarcadero
  trains", touch hint, tap a train: on its platform).
- Item 7: 12/12. Item 8: 55 stops in 10.7 min, metro on, no page/console errors; 10 min `#auto`: metro on, 40 trains
  running, no errors.
- Item 2: not finished on this build (stopped); last full result 0 failed with METRO=1 and METRO=0 (a1cc675+).
- Item 6: `tools/qa_metro_front.sh` written after the stop was announced: first run pending (the lead's gate has its own
  front-door check).

**Before the merge (bart-sim 128b10a on metro-next)**: item 2 0 failed on/off (a1cc675+), item 4 11/11 (WORLD's
in-place terrain APIs; ground, buildings, trees natural, no black tiles: `notes/bart/shots/sim/isolation_faults.jpg`),
item 5 7/7 each, item 7 12/12, item 8 55 stops in 10.7 min + 10 min `#auto` clean.
- Heap (phone Low, Palo Alto, forced GC): metro off 51.4 MB, on 64.7 MB (+13.3): MetroSim 5.5, stations 2.7,
  guideway 1.9, MetroGround 1.0, the rest 2.2. (The earlier +75 MB was garbage not yet collected.)

## Metro switch and failure isolation (M3 gate item 4, `src/js/18_metro.js`)

- **The switch**: `Metro.on`. Every metro module reads it instead of the URL (one-line edits in `19_metroground.js`,
  `23_metrotrack.js`, `24_metrounder.js`, `26_metrostations.js`: their `enabled` line only; owners please keep them).
  **Ship = one line**: `const DEFAULT_ON = true;` in `18_metro.js`. `#metro=1` / `#metro=0` force it on / off.
- **Boot gate**: `Metro.arm()` (90_main.js, before boot) makes `MetroNet.load` / `loadTimetable` wait for
  `Metro.start()`, which runs right after the first frame is drawn. Measured (alternating, idle-ish GPU): first frame
  5.6 s off / 5.4 s on (medians of 3, noise ±1 s); the first metro request starts ~0.8-1.0 s after the first frame.
- **Failure isolation**: `Metro.fail(where, err)`: one `console.warn` ("Bayline Metro is off for this session: ... The
  rest of the game is unaffected."), `Metro.on` false for the session, then every teardown: MetroSim (consists, far
  batch, lights, dots), MetroUI (panels, overlays, the title card), MetroPlay (a player riding/following/driving a
  metro train or standing in a station below the street is put in the open air, flying), MetroATC, MetroLive, and the
  world (`tearDownWorld`): Under's cells/portals/cuts removed and its switch (`blUMK.x`) zeroed, `Terrain.cutTest` off,
  MetroTrack's and MetroStations' groups out of the scene, the stations' keep-outs off, every terrain tile a metro
  height filter touched reloaded (a no-op filter over each recorded rectangle), towns/trees/ground cover rebuilt.
  Guards: the main loop's metro calls (`Metro.guard`), MetroNet's loads (a failed load resolves to a promise that never
  settles, so callers stop quietly), `MetroTrack.init/update`, `MetroStations.init/update/floorAt/blocked/spawnPoint/
  setBoard`, `Terrain.addHeightFilter` and `Towns.addDrop` (proxied: inert when off, a throw fails), MetroKit calls
  (inside MetroSim's guard), MetroPlay/MetroUI entry points (`Metro.guardAll`).
- **Fault injection**: `#metrofail=net|tracks|tt|build|stations|kit|sim|ground|under` (comma-separated): net = a real
  404 on network.json, tracks = a corrupt tracks binary (parse error), tt = a real 404 on the timetable, the others a
  throw ~150 frames after that part starts. `tools/qa_metro_isolation.sh` runs all of them at West Oakland: 11/11 PASS
  (one warning, no console errors, nothing metro in the scene, frames advancing); shots:
  `notes/bart/shots/sim/isolation_faults.jpg`.
- Known side effect (world): `Towns.dispose()` (called by MetroGround and MetroStations when the metro data arrives,
  and by the teardown) makes rebuilt building tiles render black for ~20-40 s until their photo textures reload (repro
  with the metro off: `__bayline.Towns.dispose()`). With the gate the metro data arrives after the first frame, so a
  visitor may see this briefly near the lines; WORLD: please keep a tile's imagery across dispose (or rebuild in place).

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
  - Retracted: the v0 "limit dips" list (GLEN→24TH 286 s vs 120 s …) was mostly my envelope bug (see QA results); sorry
    for the noise. On M2 after the fix, the runs whose minimum time (+ 20 s dwell) still exceeds the published gap are
    few and small, the biggest: GLEN↔24TH 182 s vs 120 s (an 18 mph code ~640 m before 24TH and 27 mph ~1 km out of
    GLEN in the Mission St subway; with 70 everywhere it would be 115 s), WOAK→12TH 240 vs 180 (the Wye at 27/36),
    COLM↔DALY ~192 vs 180, SSAN↔SBRN ~195 vs 180. If the 18 mph code near 24th St isn't a real BART civil code, lifting
    it would close most of the GLEN↔24TH gap; the runtime lifts floors per run to keep the published times anyway.
  - Resolved by M2 (thanks): reversals turn at the berth; stops are berths (the runtime stops the head on
    `stops[].d` = `platforms[].berth`, and uses the berth marks when a stop point isn't one); PITT-T has a station
    record. Per-length berths (`{ '+': { 10: s, 5: s } }`) would still be welcome if BART stops short trains elsewhere
    (tell me before changing the shape: the runtime reads a number).
  - Platform sides: resolved. Audit 2026-09-26 03:05 (`MetroStations.spawnPoint` vs `platforms[].side`, all 105
    platforms): 0 mismatches. The runtime still takes the side from the stations' geometry when it is in the build.
- **TRAINS** (MetroKit v1 is on `bart` since 62c83db and merged here; all earlier requests are answered)
  - In use: `createConsist` (exact length), `poseOnTrack`, `setDestination({ line, color, text })`, `setNextStop`,
    `setDoors`, `setLights`, `setNight`, `setLOD(0|1|2)` (2 beyond 700 m when the builder has `lod()`),
    `setInteriorVisible`, `setDisplay` (PIS: line id, lineName, arriving, doors, transfer, stops, index, clock; redrawn
    only on change), `setCab` (VATC: `atcCodeMph`, `targetMph`, numeric `effort`/`handle`/`brake`, doors, cars, alarm
    via `atc`), `dispose()` on dropped consists, `createFarBatch` (+ `end(night, res)` with the drawing-buffer size),
    per-car `standSpots` for standees when present.
  - `dmu` / `apm`: still stubs on `bart`; the runtime falls back to placeholders per kind (near and far) and will use
    MetroKit's GTW and Cable Liner as soon as those builders are on `bart` (nothing to change here: `cars` = GTW units /
    APM cars as your notes say).
- **STATIONS / INFRA** (M2 data, merged `bart` 62c83db): `#auto&metro=1&t=08:07&mst=12TH` now spawns on the LOWER
  level (y −12.67, the next train's platform; `floorAt` agrees), and there the station box is missing: no walls or
  ceiling, the street and its cars are seen from below and the outdoor world is not culled (shot:
  `notes/bart/shots/sim/m2_12th_lower.jpg`). Probably the stacked-station rebuild for M2's levels (12TH upper −3.8 /
  lower −13.7 rail) and/or the Under cells for the lower level. The upper level and the other five stations are fine.
- **STATIONS**: the airport connector's Coliseum platform (`COLS` / `H10`, MetroNet track H1.1, platform top 16.75 m):
  no walk floor there and `spawnPoint('COLS', 'H10')` returns a street-level point (y 3.82), so `#mst=COLS&mplat=H10`
  and the Cable Train mission start in the parking lot (OAKL `H40` is fine).
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
