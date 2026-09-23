# Bayline

An unofficial, browser-based simulator of the San Francisco Peninsula commuter rail line:
124 km from 4th & King to Gilroy, all 31 stations, the **real timetable running live**, real
terrain, real towns and streets, landmarks, road and air traffic, and trains you can ride,
walk through and drive.

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
| **Driving:** `W`/`S` | Power and brake notches (`X` coast, `O` doors, `Space` horn, `G` bell, `Backspace` emergency, `R` release, `A` autopilot) |

## How it's built

One self-contained HTML file (three.js r158, all code and data inlined), plus a tiny WebSocket
relay for presence.

```
build.py            concatenates src/js/*.js + data/baked/* + three.js into dist/bayline.html
src/head.html       page shell, UI markup and CSS
src/js/             engine modules: env/sky, terrain, track, stations, towns, trains, sim,
                    landmarks, player, life (people, traffic, aircraft, birds), game, UI, sound, net
tools/              data pipeline (GTFS, DEM tiles, OSM rail/towns) and a headless screenshot tool
data/baked/         compact baked data embedded by build.py
server/             nginx config, multiplayer relay (mp.py), load test
```

Build and run locally:

```bash
python3 build.py                         # -> dist/bayline.html (open it directly; multiplayer is off on file://)
python3 -m http.server -d dist 8080      # or serve it
```

Rebuilding the data needs network access. The raw downloads land in `data/raw/`, which is gitignored.

```bash
python3 tools/bake_gtfs.py               # timetable + corridor from the GTFS feed
sh tools/fetch_dem.sh && python3 tools/fetch_rail.py && python3 tools/bake_world.py   # terrain + track
python3 tools/fetch_osm.py && python3 tools/bake_towns.py                             # towns
```

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

- `Dockerfile` has two stages. The first runs `build.py` to make the single HTML file. The final
  image runs nginx for the page, gzip, `/healthz` and the `/ws` proxy, plus the Python relay as an
  unprivileged user.
- In Sheltie: project **examples** → application **bayline**, build pack *Dockerfile*, port 80,
  health check `/healthz`, domain `https://bayline.sheltie.scottylabs.org`, with a memory limit.
- Every push to `main` redeploys automatically through a GitHub webhook.

## Data and credits

- Timetable: the agency's public GTFS feed (via Trillium Transit), June 2026 edition.
- Track geometry, stations, platforms, crossings, signals, streets, buildings and parks:
  © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Terrain: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen; USGS 3DEP and others).
- three.js (MIT). Fonts: Barlow, Barlow Condensed and IBM Plex Mono (Google Fonts, OFL).

Code: MIT. Built as a ScottyLabs Sheltie example.
