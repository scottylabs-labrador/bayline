# Bayline

An unofficial, browser-based, photoreal replica of the San Francisco Peninsula commuter rail line:
124 km from 4th & King to Gilroy, all 31 stations, the **real timetable running live**, real aerial
photography on real terrain, every real building and tree along the line, landmarks, road and air
traffic, and trains you can ride, walk through and drive.

**Play: https://bayline.sheltie.scottylabs.org**

> Unofficial fan project. Not affiliated with, endorsed by or connected to Caltrain or the
> Peninsula Corridor Joint Powers Board. "Bayline" and its livery are our own; station names are
> real place names.

## What you can do

- **Ride**: pick any real departure from a station's board, wait on the platform, and step aboard
  when the doors open. Walk the whole train, including both decks and the gangways between cars.
  Sit by a window, listen to the stop announcements, and get off anywhere.
- **Drive**: take the cab of a scheduled train. Keep to the timetable, obey speed limits and
  signals (PTC will stop you if you don't), and stop on the mark at every platform. You are
  scored on punctuality, stopping accuracy and ride comfort, and an autopilot can drive for you.
- **Explore**: fly the whole Bay Area, drop to street level in any town, follow any train, or park
  a trackside camera and watch the line run.
- **Missions**: drive runs (the Bullet, the Peninsula Local, South County diesel, the Four
  Tunnels), commuter challenges ("9 AM meeting at 22nd Street") and landmark tours.
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
| `K` / `P` | Cycle the weather · photo mode (hide the interface) |

Link options (after `#`, joined with `&`): `t=17:30` sets the clock, `at=palo_alto` starts at a station
(`cam=orbit&dist=400` orbits it), `ll=37.8045,-122.4705,265,-0.78,-0.03` flies the camera to a viewpoint (lat, lon, altitude m, yaw,
pitch), `w=clear|fog|cloudy|haze` sets the weather, `q=ultra|high|medium|low` forces a
quality tier (the default adapts to your GPU), `auto` skips the title screen. Example (the Golden Gate towers in the evening fog
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
- **Trees:** individual crowns detected in the imagery, so every tree stands where the photo shows it.
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

## Data and credits

- Timetable: the agency's public GTFS feed (via Trillium Transit), June 2026 edition.
- Track geometry, stations, platforms, crossings, signals, streets, buildings and parks:
  © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Terrain: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen; USGS 3DEP and others).
- Aerial imagery: USDA National Agriculture Imagery Program (NAIP), via USGS The National Map (public domain).
- three.js (MIT). Fonts: Barlow, Barlow Condensed and IBM Plex Mono (Google Fonts, OFL).

Code: MIT. Built as a ScottyLabs Sheltie example.
