# Net: multiplayer presence (net agent notes)

Optional shared world. The train world is deterministic from the wall clock, so every client already
computes every scheduled train. The relay only carries tiny presence records, and it is capped so it
can never be overwhelmed.

## Files

| File | What |
|---|---|
| `server/mp.py` | asyncio WebSocket relay (websockets 16.0), 127.0.0.1:8765, also `GET /stats`, `/healthz` |
| `server/test_load.py` | load + abuse test (starts its own relay on a free port) |
| `server/nginx.conf` | full nginx config: static game, `/ws` and `/mp/stats` proxy, real-IP, rate limits |
| `server/entrypoint.sh` | starts the relay as user `mp` (restarts it if it exits), then `exec nginx` as PID 1 |
| `server/Dockerfile.draft` | one alpine image: build stage runs `build.py`, final stage = nginx + relay |
| `server/requirements.txt` | `websockets==16.0` |
| `src/js/80_net.js` | `Net` client |
| `preview/net.html` | 2D preview: connects, optional bot train, draws everyone on the corridor |

## Protocol v1

Client → server, text frames, JSON arrays, ≤ 200 bytes (the client module builds these; you never do):
- `[1, mode, trip, s, car, x, y, z, yaw, speed]` presence
- `[2, t]` ping (client clock, ms) → server replies `{"t":"po","c":t}`

Server → client:
- `{"t":"hi","v":1,"id","name","color","hz","max"}` once on connect
- binary snapshot at `hz` (1 Hz), identical bytes for everyone, little-endian:
  header `u8 type=1 | u32 server_ms | u16 online | u8 n`, then `n` records of
  `u16 id | u8 mode | u8 car (255 = none) | f32 s | f32 x | f32 y | f32 z | i16 yaw·10⁴ | i16 speed·100 | u8 tripLen | trip`.
  25 bytes + trip per player, at most 64 players (most recently active) → ≤ ~1.8 KB per tick.
- Close codes: 4001 full, 4003 too many from your network, 4004 origin, 4008 rate limit, 4009 bad data, 4010 idle.

Names: callsigns derived from the random server-assigned id (`Net.callsign(id)`, same tables as the server),
e.g. "Engineer Heron 17"; color `Net.colorOf(id)`. Clients cannot send any text, so there is nothing to moderate.

## Limits (env vars, defaults)

| Var | Default | Meaning |
|---|---|---|
| `MP_MAX_CONN` | 150 | players connected at once |
| `MP_MAX_PER_IP` | 3 | per client IP (real IP restored by nginx from Traefik's X-Forwarded-For) |
| `MP_MAX_MSG` | 200 | bytes per inbound frame (bigger → close 1009) |
| `MP_MSG_RATE` / `MP_MSG_BURST` | 4 / 8 | token bucket per client; > 40 drops in 10 s → close 4008 |
| `MP_IDLE_S` | 45 | no message for this long → close 4010 (client heartbeats every 15 s) |
| `MP_TICK_HZ` | 1 | snapshot rate |
| `MP_SNAPSHOT_MAX` | 64 | players per snapshot |
| `MP_REJECT_RATE` / `MP_REJECT_BURST` | 20 / 40 | polite over-cap closes per second; beyond → HTTP 503/429 |
| `MP_SLOW_BYTES` | 65536 | skip a client whose send buffer is above this; > 10 slow ticks → dropped |
| `MP_ORIGINS` | – | extra allowed origins (comma list). Always allowed: the public site, `http://localhost:*`, `http://127.0.0.1:*` |
| `MP_ALLOW_NULL_ORIGIN` | 0 | allow `file://` pages (local testing only) |

nginx in front adds: 20 handshakes/min per IP (burst 10), 4 concurrent `/ws` sockets per IP, 400 total,
30 `/mp/stats` requests/min per IP. Rate-limit log lines are at `notice` so a storm doesn't flood logs.

Campus NAT caveat: if many students ever share one public IP, raise `MP_MAX_PER_IP` and nginx's `limit_conn ws_ip`.

## Measured

Local (M-series Mac, `python3 server/test_load.py`):
- 300 clients vs cap 150 plus six abusers: 150 held (146 honest + 4 abusers), 40 refused with 4001 and 114 with
  HTTP 503 (reject budget), every abuser got its exact code (flood 4008, oversize 1009, garbage/NaN 4009,
  bad origin 403, idle 4010, same IP ×5 → 3 ok + 2×4003). Relay CPU 2.0% mean / 6.8% peak at ~300 msgs/s,
  RSS 33 → 36 MB, snapshot 1,800 B, `/stats` p50 1.8 ms, ping p50 2.4 ms.
- Storm, 1,000 clients vs cap 150: still 150 held, 40 × 4001 + 814 × HTTP 503, CPU 2.4% mean / 26.5% peak
  during the one-second burst, RSS peak 47 MB, `/stats` max 3.7 ms. ALL PASS.
- Two headless browser tabs through the preview page: each saw the other's callsign and live position.

Container (built once on the Sheltie host in /tmp with a placeholder page, then removed):
- Image 92.6 MB; `nginx -t` passes at build; whole container ~20 MB RAM (relay 25 MB RSS as user `mp`).
- `/healthz` 200; index served from the pre-gzipped file; `/mp/stats` proxied.
- Real IP from X-Forwarded-For works: same IP ×5 → 3 accepted, 1 × 4003 (relay), 1 × 503 (nginx).
  25 rapid handshakes from one IP → 21 refused by nginx (429/503) before reaching Python. Bad origin → 403.
- Relay restart loop verified locally (the in-container kill test was invalid: `pkill -f` matched its own shell).

## Integrating in the game (lead)

```js
// boot, after the start screen (optional feature; file:// pages stay solo automatically)
Net.connect();                       // same-origin wss://<host>/ws
Net.onStatus(st => ui.setNetText(st.text));   // 'Online · 12 riders', 'World is full, riding solo', 'Offline, riding solo'

// every frame (cheap; the module throttles to ≤ 2 Hz and only sends on meaningful change)
Net.setState({
  mode: 'ride',          // 'menu' | 'walk' | 'ride' | 'drive' | 'fly' | 'map' | 'cab'
  trip: '141',           // GTFS trip id when on a scheduled train, '' otherwise
  s: trainHeadS,         // meters from 4th & King along the route (SF → Tamien → Gilroy)
  car: 3,                // car index the player is in, -1 if none
  x, y, z,               // ride/drive/cab: CAR-LOCAL position; walk/fly/map/menu: WORLD position
  yaw,                   // ride/drive/cab: car-local heading; otherwise world heading (radians)
  speed,                 // m/s, SIGNED: + means s increasing (southbound), − northbound
});

// every frame, render others (allocation-free; same array each call, ≤ 64 entries)
for (const o of Net.others()) {
  // o: { id, name, color, mode, modeName, trip, s, car, x, y, z, yaw, speed, age }
  if (o.modeName === 'ride') { /* find the scheduled train for o.trip; avatar at car o.car, local (o.x,o.y,o.z) */ }
  else if (o.modeName === 'drive' || o.modeName === 'cab') {
    /* o.trip '' = player-driven extra train: draw a consist whose front is at o.s, direction sign(o.speed);
       if o.trip is set they took over that scheduled trip */ }
  else { /* walk / fly: avatar or drone at world (o.x,o.y,o.z), heading o.yaw */ }
  // label: o.name in o.color; map: dot at the corresponding position
}
```
Interpolation: values tween snapshot to snapshot (one tick of latency); after a late snapshot `s` keeps
advancing at `speed` for up to 2 s. Changing trip/car/mode jumps instead of sliding. Tabs hidden for
60 s disconnect (players count stays honest) and reconnect when visible.

## Container / deploy notes (for the lead)

- `server/Dockerfile.draft` expects the repo root as build context and `python3 build.py` to write
  `dist/bayline.html`. Move it to `./Dockerfile` if you like. Add a `.dockerignore` with at least
  `data/raw`, `.git`, `dist` (rebuilt inside), `**/__pycache__`.
- Coolify: build pack Dockerfile, port 80, health check `/healthz`, domain
  `https://bayline.sheltie.scottylabs.org` (Traefik passes WebSocket upgrades as is). Memory limit ~160 MB is ample.
- If the public origin changes, set `MP_ORIGINS` (or edit `PUBLIC_ORIGIN` in mp.py).
