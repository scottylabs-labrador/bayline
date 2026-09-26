# Bayline

An unofficial, browser-based, photoreal replica of the Bay Area's railways: the San Francisco Peninsula
commuter line (124 km from 4th & King to Gilroy, all 31 stations) and all five lines of the regional metro
(**Bayline Metro**: 50 stations from Antioch to SFO, through the tube under the Bay), each on its **real
timetable, running live**, over real aerial photography on real terrain, with every real building and tree
along the lines, landmarks, road and air traffic, and trains you can ride, walk through and drive.

**Play: https://bayline.sheltie.scottylabs.org** · **Trailer: https://bayline.sheltie.scottylabs.org/data/v2/trailer/bayline_trailer.mp4**

> Unofficial fan project. Not affiliated with, endorsed by or connected to Caltrain, the Peninsula
> Corridor Joint Powers Board, or the San Francisco Bay Area Rapid Transit District. "Bayline",
> "Bayline Metro" and their liveries are our own; station names are real place names.

## What you can do

- **Ride**: pick any real departure from a station's board, wait on the platform, and step aboard
  when the doors open. Walk the whole train, including both decks and the gangways between cars.
  Sit by a window, listen to the stop announcements, and get off anywhere.
- **Drive**: take the cab of a scheduled train. Keep to the timetable, obey speed limits and
  signals (PTC will stop you if you don't), and stop on the mark at every platform. You are
  scored on punctuality, stopping accuracy and ride comfort, and an autopilot can drive for you.
- **Ride and drive the metro (Bayline Metro)**: all 50 stations, from the deep Market Street subway and the
  stacked levels under Oakland to the aerials of the East Bay and the median stations of the freeways, each
  built from its real layout with its entrances, escalators, departure boards and crowds. Pick a station on the
  system map or search it on the title card, wait on the platform as the next real train pulls in, step aboard
  and ride through the Transbay Tube; or take the cab and drive under wayside ATC (automatic, or by hand with the
  speed codes supervising you), stopping on the berth at every station. The Antioch diesel shuttle and the
  airport cable train run too, and a live mode places the trains where the operator's real-time feed says they
  are right now.
- **Explore**: fly the whole Bay Area, drop to street level in any town, follow any train, or park
  a trackside camera and watch the line run.
- **Missions**: drive runs (the Bullet, the Peninsula Local, South County diesel, the Four
  Tunnels), commuter challenges ("9 AM meeting at 22nd Street") and landmark tours.
- **Fly (Bayline Flight)**: take off from any of the world's 28,000 airports in a real aircraft type
  (Cessna 172, A320neo, 737-800, 787-9, 747-400, A380, Concorde, King Air 350, Twin Otter, DC-3,
  Extra 330, F-16C, and the H125 helicopter) over real terrain and imagery, in the real weather, among
  the real aircraft flying there right now (live ADS-B; click one on the map to fly alongside it).
  Start on the runway, on an 8 nm final or in the air; fly by hand with fly-by-wire assistance (or
  raw), pick a field on the world map to fly there direct, or let the autopilot capture the runway,
  autoland and roll out. Buildings and the big landmarks are solid: land the helicopter on a rooftop,
  fly under the Golden Gate's deck (not into it). Challenges: famous approaches (Innsbruck, Gibraltar,
  Maho Beach, Madeira, Lukla), under the Golden Gate, a gate course around San Francisco, an engine
  failure after takeoff, and helicopter landings inside the Salesforce Tower's crown and on top of the
  Golden Gate's south tower, or sit back on a guided helicopter tour of San Francisco. The tower clears
  you for takeoff and landing with the live wind; it rains, snows and storms where the real weather
  says so (or press K), with drops on the windshield, lightning, tyre smoke on touchdown and contrails
  at cruise altitude. `L` while flying copies a link that puts a friend in your aircraft, right there;
  every flight can be replayed.
- **Multiplayer (optional)**: see other people's trains, and other people riding and walking,
  live. There is no chat or free text; callsigns like "Engineer Heron 17" are assigned by the
  server.

The world is a deterministic function of the Pacific-time clock, so everyone sees the same trains
in the same places. You can also jump to morning rush, midday, golden hour or night, and speed
time up.

## Controls

| Key | Action |
|---|---|
| `1`–`8` | Cab · onboard · chase · trackside · helicopter · walk · fly · overview |
| `WASD` / arrows, mouse | Move and look (click to capture the mouse, `Esc` to release) |
| `E` | Board, step off, sit, stand |
| `B` / `M` / `J` / `H` | Departure board · live map · missions · help |
| `Tab` / `F` | Follow the next or the nearest train |
| `-` / `=` / `0` | Slow down / speed up time / back to live |
| **Driving:** `W`/`S` | Power and brake notches. `W` at departure closes the doors and departs; doors open themselves at the stop mark. `X` coast, `O` doors, `Q` reverser, `Space` horn, `G` bell, `Backspace` emergency, `R` release, `A` autopilot. On-screen buttons do the same. |
| `K` / `P` / `L` | Cycle the weather · photo mode (hide the interface) · copy a link to this view |
| **Metro:** `N` | The system map (click a station to go there). `B` on a metro platform: arrivals (click a train to ride it, Shift+click to drive it). |
| **Driving a metro train:** `W`/`S` | In automatic (ATO), `W` closes the doors and departs; in manual, `W`/`S` move the master controller (`S` takes over from ATO). `X` coast, `O` doors, `A` ATO on/off, `Q` change ends at a terminal, `Backspace` emergency, `R` release, `Space` horn. |

**Flying:** arrows pitch and roll (`↓` nose up) · `W`/`S` throttle (past 100 % = afterburner) · `A`/`D` rudder and
steering · `F`/`R` flaps · `G` gear · `Space` brakes, `B` parking brake · `T` reverse · `Z` speed brakes · `Y`
autopilot, `U` autothrottle, `I` approach (autoland) · `[` `]` `,` `.` `;` `'` heading / altitude / speed targets (or the
on-screen autopilot panel) · `C`, `1`–`5`, `Tab` cameras (cockpit, chase, orbit, tower, flyby) · `M` world map · `X`
handling (assisted, fly-by-wire, direct) · `Esc` menu. Gamepads and touch work too.

Link options (after `#`, joined with `&`): `fly=a320,KSFO,28R,final` starts a flight (type, airport, runway, `runway`|`final`|`air`), `t=17:30` sets the clock, `at=palo_alto` starts at a station
(`cam=orbit&dist=400` orbits it), `ll=37.8045,-122.4705,265,-0.78,-0.03` flies the camera to a viewpoint (lat, lon, altitude m, yaw,
pitch), `w=clear|fog|cloudy|haze` sets the weather, `q=ultra|high|medium|low` forces a
quality tier (the default adapts to your GPU; `q=ultraplus` asks for Ultra+ after the GPU test, `q=ultraplus!` skips
the test), `h9=0` / `mat=0` / `t2=0` turn off the lidar, ground-material and tree-height layers, `auto` skips the title screen,
`mst=EMBR` puts you on a metro platform (station codes), `mmap=1|geo|graph` opens the system map, `mlive=1` turns on
live mode, `metro=0` turns Bayline Metro off. Example (the Golden Gate towers in the evening fog
river): `https://bayline.sheltie.scottylabs.org/#auto&t=18:20&w=fog&ll=37.8045,-122.4705,265,-0.78,-0.03`.

## How it's built (v2: streamed photoreal)

A small page (three.js r158 + all code, ~1.5 MB) plus a streamed world: every piece of data is fetched
in parallel, on demand, around the camera, from `/data/v2/` on the same host.

- **Ground:** a chunked-LOD quadtree (L0 102 km … L9 200 m tiles) that drapes 0.6 m USDA NAIP aerial
  photography over high-resolution terrain (AWS Terrain Tiles), carved exactly to the railway profile.
  It sharpens progressively like a globe viewer, and masks drive water, night lights and landcover.
  The photography is sharpened on the GPU with Real-ESRGAN (PyTorch MPS on Apple silicon):
  - near the line (L9) to 0.2 m/px, so the ground stays crisp at street level;
  - every 400 m tile (L8) to 0.39 m/px, which also sharpens every photo roof.
  At eye level the photo gives way to synthesized asphalt, concrete, grass or soil (mipmapped detail
  textures tinted by the photo), and instanced grass grows wherever the photo shows lawn or golden summer fields.
  Beyond the corridor band, all of San Francisco (the Presidio, Golden Gate Park, the Sunset and Richmond), the
  Oakland/Emeryville/Alameda shore and Treasure Island have the same 0.39 m/px imagery, trees and buildings, and the
  Golden Gate and Marin Headlands have 0.8 m/px imagery. The Pacific breaks in lines of surf along Ocean Beach.
- **Water:** open water sits at sea level while the bathymetry colours it; wind waves come from a tileable
  slope map (LEAN mapping), so the sun glitter widens with distance and gusts drift across the Bay.
- **Buildings:** every OpenStreetMap building near the line, across San Francisco and on the East Bay shore, streamed in 800 m
  tiles, with real heights and roof shapes, and roofs textured from the same photograph.
- **Trees:** individual crowns detected in the imagery, so every tree stands where the photo shows it, with its
  height measured by a 1 m canopy height model (Meta / WRI), plus the trees the photo misses; beyond the imagery
  tiles, the wooded hills (Woodside, Crystal Springs, the Santa Cruz Mountains) are planted from the same model.
- **Lidar ground:** USGS 3DEP 1 m bare-earth lidar adds the fine relief (street grades, terraced lots, levees, cut slopes,
  ravines) on top of the carved terrain, streamed at 1.6 m near the camera; roads, track and platforms keep their surface.
- **Ground materials:** every 1.6 m of ground is classified (lawn, dry grass, scrub, leaf litter, soil, gravel, asphalt,
  paving, roof, sand, marsh...) from the photo's near-infrared and OpenStreetMap, so up close the ground is drawn as what
  it is, and grass only grows where there is grass.
- **Facades:** each building gets its own window sizes, spacing and pairing, blinds and curtains, string courses,
  spandrels, a base and a cornice.
- **Graphics setting:** Auto, Low, Medium, High, Ultra and **Ultra+**. Ultra+ is offered when WebGPU is available and a
  quick GPU benchmark passes: WebGPU computes terrain shadows (hills shading valleys at sunrise and sunset, and
  everything in them) and sky visibility, a far shadow cascade lets buildings and trees cast shadows kilometres out,
  the lidar ground gets full-resolution meshes, and the frame is supersampled with dynamic resolution. The
  renderer stays WebGL2.
- **Light:** a physically based sky and atmosphere, the marine layer, and an HDR post pipeline
  (SSAO, aerial perspective, bloom, ACES grading). Building glass reflects the real sky.
- **Life on the Bay:** sailboats off Crissy Field and Coyote Point, ferries from the Ferry Building, container
  ships under the Golden Gate, and planes landing at SFO and SJC, all derived from the clock like the trains.
- **People and traffic:** passengers with modelled faces, clothes, hair and luggage, walking, waiting and
  sitting; platform crowds sized by each station's typical weekday boardings (4th & King fills up at the
  peaks), drawn with a clustered far body beyond 40 m; cars with lofted bodies near the camera and light
  models beyond, curbside parking on neighbourhood streets, and per-instance view culling (quality tiers also
  shrink the building radius on slower GPUs).
- **Sky:** the summer evening fog pours through the Golden Gate as a low river the bridge towers stand out
  of; the moon is a 0.52 deg sphere lit by the real sun direction, so its phase matches the date.
- **Railway:** the real timetable, PTC braking-curve supervision, signals driven by train occupancy,
  and working crossing gates.

```
build.py            src/head.html + src/js/*.js + three.js -> dist/index.html (no data inside)
src/js/             engine modules (stream, sky/post, terrain, track, stations, towns, trains, sim,
                    landmarks, player, life, flora, game, UI, sound, net)
tools/              data pipeline (GTFS, DEM, NAIP tiles, OSM towns/trees), dev server, screenshot + QA tools
data/baked/         small core inputs (track, timetable, 64 m fallback terrain)
data/pub/v2/        the published streamed world (gitignored; built by tools, published to the server)
server/             nginx config (static page, /data/ volume, /ws relay), multiplayer relay, load test
```

Run locally:

```bash
python3 build.py                  # -> dist/index.html
python3 tools/devserver.py        # http://localhost:8123/  (serves dist/ and data/pub/v2 with Range support)
```

Rebuild the world data. This needs network access; downloads are cached in `data/raw/`:

```bash
python3 tools/bake_gtfs.py && python3 tools/bake_world.py        # timetable, track, core terrain
python3 tools/bake_tiles.py                                        # NAIP imagery, heights, masks, trees -> data/pub/v2/tiles
python3 tools/sr_tiles.py                                          # GPU super-resolution of the near-track imagery (L9)
python3 tools/sr_l8.py                                             # GPU upgrade of every L8 tile to 1024 px
python3 tools/fetch_osm.py && python3 tools/bake_towns.py          # buildings and roads -> data/pub/v2/tiles/b
python3 tools/bake_lidar.py all                                    # USGS 3DEP lidar detail -> tiles/h9
python3 tools/bake_materials.py all                                # ground materials -> tiles/mat
python3 tools/bake_trees2.py all                                   # canopy heights + hill forests -> tiles/t2
sh tools/publish_data.sh                                           # rsync data/pub/v2 to the server volume
```

QA (all through real keyboard events, against the dev server):

- `sh tools/qa_all.sh` renders the key views with frame cost, runs a full scripted drive and the ride/boarding flow.
- `tools/qa_drive.js` is a careful driver: doors, departure on time, guidance, stopping on the mark.
- `tools/qa_ptc.js` is a reckless driver who never brakes. PTC must warn, enforce a penalty brake to a stop and
  release, both on overspeed and on the braking curve into a 30 mph restriction.
- `tools/qa_signal.js` parks a phantom train ahead. The block signals behind it go yellow and red, and PTC must
  stop the reckless driver before the red.

Run one with `node tools/shot.mjs "http://localhost:8123/#auto&t=08:00" out.png --gpu --wait 80000 --eval "$(cat tools/qa_ptc.js)" --eval2 "JSON.stringify(window.__qa)"`.

## Bayline Flight: how it works

- **The planet:** the flat local frame follows the aircraft (rebasing through latitude/longitude every ~150 km),
  Earth curvature is added in the vertex shader, and a web-mercator globe streams AWS terrain with USGS NAIP
  (US) or EOX Sentinel-2 cloudless (elsewhere) imagery, NASA VIIRS Black Marble city lights at night, and
  OpenFreeMap buildings, aprons and taxiways near the ground. Airports and runways come from OurAirports,
  drawn with markings, edge / approach lights and PAPIs, the terrain flattened under them.
- **Flight model (`47_fdm.js`):** six degrees of freedom at 240 Hz: ISA atmosphere, stability and control
  derivatives with a smooth stall, flaps / slats / spoilers / gear, ground effect, transonic and supersonic
  drag, piston / turboprop / turbofan / afterburning engines with per-engine moments, spring-damper gear
  with brakes and steering. `node tools/qa_flight.js` flies every type through takeoff, cruise and autoland.
- **Flight controls (`47_fcs.js`):** incremental nonlinear dynamic inversion fly-by-wire (rate command,
  flight-path and bank hold, protections, a flare damped by the flight-path rate), direct law, autopilot
  (HDG, ALT, V/S, great-circle direct-to, LOC + glide path to any runway, flare, retard, rollout along
  the centre line with autobrake) and autothrottle. The helicopter (a momentum-theory rotor with
  translational lift, vortex ring state, ground effect, power-limited torque, cyclic disc tilt and tail
  rotor) gets its own assisted laws: height hold on the collective, speed hold or a drift-free hover on
  release, and an autopilot with position hold.
- **Solid world:** OSM building footprints (the Bay's own tiles, OpenFreeMap elsewhere) and the hand-built
  landmarks' collision solids (towers, bridge decks with their clearance underneath) feed the ground under
  the aircraft: roofs to land on, walls to hit.
- **Aircraft (`48_acmodel.js`):** procedural models from each type's dimensions: lofted fuselages with a
  fictional Bayline Air livery, NACA-section wings with moving surfaces, engines, props, gear, lights,
  and cockpits whose windows are cut from the pilot's view.
- **Live data:** weather from Open-Meteo (wind aloft, clouds, visibility, temperature), traffic from adsb.lol
  (proxied and cached by this server's nginx, which is rate-limited per IP).

Aircraft types are named for identification only and wear a fictional scheme; nothing here is affiliated
with any manufacturer or airline. Not for real-world navigation.

## Bayline Metro: how it's built

- **The network (`21_metronet.js`, `tools/metro/`):** the operator's public GTFS (routes, patterns, every trip) joined
  to OpenStreetMap's track geometry: 374 physical tracks (511 km), 578 junctions and 107 platform faces. The vertical
  profile is one quadratic program over 103,000 samples: the USGS 3DEP lidar trackbed where the line runs in the open,
  hard grade limits (4 %, 3 % in the Transbay Tube), vertical curves of at least 800 m, level platforms, equal heights
  at every junction, OpenStreetMap's grade separations, and researched anchors (station depths, the 1965 Tube profile,
  the Berkeley Hills Tunnel's as-built grades). Speed limits follow curvature, capped by the civil speed codes, and are
  quantised to the ATC codes (6, 18, 27, 36, 50 and 70 mph). A validator checks every bake.
- **Guideway (`23_metrotrack.js`, `24_metroguide.js`, `24_metrotube.js`):** streamed in three layers and built in
  time slices: canted rails on direct-fixation plinths or ballast, the third rail with its coverboard and
  insulators, 1970s twin box-girder aerials on hexagonal columns (about half in seismic steel jackets) and later
  single boxes, junctions with frogs and switch machines, trenches, freeway medians, the immersed Transbay Tube
  with its gallery, bored and cut-and-cover tunnels and their portals.
- **Underground (`24_metrounder.js`):** a portal-visibility engine. Tunnels and stations are cells joined by portals;
  only the cells you can see through the portals are drawn, the outdoors is culled when it can't be seen, the
  terrain opens at stair wells and portals, and the exposure adapts as you go down.
- **Stations (`26_metrostations.js`, `27_station*.js`, `28_station*.js`):** all 50 generated from the platforms in
  the data and a curated layout per station (subway box, aerial deck, at grade, freeway median, open trench):
  mezzanines, escalators, stairs and elevators to the real entrances, fare gates, signage, live departure boards,
  crowds sized by real ridership, and the details riders know (Embarcadero's wall relief, Lake Merritt's tile
  circles, the relief concrete at 16th and 24th Streets, the Millbrae hall shared with the Peninsula line).
- **Trains (`41_metrokit.js`, `42_metrokit_*.js`):** cars built from the real dimensions: plug doors, trucks that yaw
  and spin, collector shoes on the third rail, lit interiors with passengers, a cab with a working ATC display, rain
  on the bodies and glass. Beyond 110 m a baked lightweight model stands in, and distant trains are one instanced
  draw per car type. The Antioch diesel units and the airport cable train have their own models.
- **Simulation (`46_metrosim.js`, `47_metro*.js`):** every trip of the service day on minimum-time run profiles fitted
  to the published times (within 10 s on average), trains that turn back and change ends, wayside ATC with speed
  codes and occupancy, automatic or manual driving with scoring, announcements (speech synthesis) and propulsion
  sound (Web Audio), the system map and arrivals boards, and live mode from the operator's GTFS-Realtime trip
  updates (proxied and cached by this server's nginx).
- **Safety net (`18_metro.js`):** the metro loads after the first frame and never holds up the game; if any part
  of it fails, it switches itself off for the session and everything else carries on.

## The trailer

Every shot in the trailer is real gameplay, rendered by the game itself and captured frame by frame in 4K.

- `tools/capture.mjs` runs the page in headless Chrome on the GPU in capture mode (`__bayline.capture`): a fixed
  time step, quality frozen at ultra, a scripted camera that the world's level of detail and streaming follow, and
  a settle step that waits for tiles before a frame is kept. The same shot renders the same frames every time.
- `tools/trailer/shots/*.mjs` stage the shots with the game's own systems: the real timetable picks the train
  (`passClock` finds the express that crosses a San Mateo grade crossing at 78 mph in the last sun), the
  autopilot flies the aircraft, and live ADS-B supplies the aircraft on the ground at SFO.
  `tools/trailer/preview.py` makes contact sheets and `capture_all.py` batch-captures (resumable).
- `tools/trailer/edit.py` with `edl.json` cuts it to the music: speed ramps into slow motion (the crossing pass is
  captured at 120 fps), lightning, impact jolts, animated title cards (`titles.mjs`, the site's own fonts), a
  2.2:1 letterbox, and the sound design, mixed and loudness-normalised to -14 LUFS.

The gameplay video (the title screen's trailer button plays it) is cut the same way, with gameplay shots that keep the
HUD (`ui: true` in a shot: driving from the cab, the departure board, flying with the flight HUD, the world map with
the flight's recorded track), a letterbox that opens for gameplay and closes for the cinematic acts, and one-line
captions (`cards_gameplay.mjs`). `make_edl_gameplay.py` times the cuts to the music's beat grid; `extend_music.py`
repeated 4 bars of it for the map scene. Captures ran on Ultra+ at 4K with a finer terrain LOD (`--lod 2.6`) and a
per-frame settle, and `capture_all.py EDL=...` captures only the frames the cuts use.

Music: "The Sound of Arrows" by Bonnie Grace, and sound effects, from Epidemic Sound.

## Multiplayer, safely

The relay only carries tiny presence records: mode, trip, position, speed. Everything else is
computed on each client from the timetable. Hard caps keep one small container from being
overwhelmed:

- 150 players at once, 3 per IP
- 200-byte messages at 4 per second (burst 8)
- one shared 1 Hz snapshot of at most 64 players
- idle kick after 45 s
- no free text

nginx adds per-IP handshake and socket limits in front of the relay. The details and load-test
results are in `notes/net.md`.

## Hosted on Sheltie

Live at **https://bayline.sheltie.scottylabs.org**, on Sheltie, ScottyLabs' self-hosted
deployment platform (Coolify). It's the "heavier" example next to
[katmai-sortie](https://github.com/scottylabs-labrador/katmai-sortie): one container with a static
game **and** a small realtime backend.

- `Dockerfile` has two stages. The first runs `build.py` to make the page. The final image runs nginx
  for the page, gzip, `/healthz`, the `/ws` proxy and `/data/`, plus the Python relay as an
  unprivileged user.
- The world data is not in the image. It lives in a Coolify persistent volume mounted at
  `/usr/share/nginx/html/data`, filled by `tools/publish_data.sh`, so code deploys stay small and fast.
- In Sheltie: project **examples** → application **bayline**, build pack *Dockerfile*, port 80,
  health check `/healthz`, domain `https://bayline.sheltie.scottylabs.org`, with a memory limit.
- Every push to `main` redeploys automatically through a GitHub webhook.

### Monitor

`monitor/` is a separate small app: a standard-library Python service that samples each deployment's
`/mp/stats` every 15 seconds, keeps the history in SQLite (raw samples for 14 days, hourly roll-ups
forever) and serves a dashboard showing who's online now, peaks, sessions and uptime. It builds from
`monitor/Dockerfile`, needs a persistent volume at `/data`, and is configured by environment variables
(`SITES`, `MONITOR_USER`, `MONITOR_PASSWORD`; see the top of `monitor/monitor.py`).

## Data and credits

- Timetable: the agency's public GTFS feed (via Trillium Transit), June 2026 edition.
- Bayline Metro timetable and live predictions: the regional operator's public GTFS and GTFS-Realtime feeds. Station
  facts (depths, layouts, opening years, ridership): public sources, cited per station in `notes/bart/stations-research.md`.
- Track geometry, stations, platforms, crossings, signals, streets, buildings and parks:
  © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Terrain: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen; USGS 3DEP and others).
- Aerial imagery: USDA National Agriculture Imagery Program (NAIP), via USGS The National Map (public domain).
- Lidar terrain detail: USGS 3D Elevation Program (3DEP) 1 m bare-earth DEM, via The National Map (public domain).
- Tree heights: Meta and World Resources Institute, *Global Canopy Height Map* (Tolan et al. 2024), CC BY 4.0,
  via AWS Open Data (`s3://dataforgood-fb-data/forests/v1/`).
- World elevation: AWS Terrain Tiles (USGS 3DEP, SRTM, GMTED2010, ETOPO1 and others). World imagery:
  EOxCloudless 2025 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2025, CC BY-NC-SA 4.0).
- Night lights: NASA GIBS / VIIRS Black Marble (public domain). Airports: [OurAirports](https://ourairports.com/data/) (public domain).
- Weather: [Open-Meteo](https://open-meteo.com) (CC BY 4.0). Live traffic: [adsb.lol](https://adsb.lol) (ODbL).
- World buildings and airport surfaces: [OpenFreeMap](https://openfreemap.org) © OpenMapTiles, data © OpenStreetMap contributors.
- three.js (MIT). Fonts: Barlow, Barlow Condensed and IBM Plex Mono (Google Fonts, OFL).

Code: MIT. Built as a ScottyLabs Sheltie example.
