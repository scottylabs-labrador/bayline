#!/usr/bin/env python3
"""Bayline multiplayer presence relay.

A deliberately tiny, single-process asyncio WebSocket relay. The train world is deterministic
from the wall clock (every client computes the scheduled trains itself), so the relay only
carries a few dozen bytes of presence per player: what mode they are in, which trip/car they
ride or where their own train is, and where they stand.

Design for "can never be overwhelmed":
  * Hard caps on connections (total and per IP), message size, message rate, idle time.
  * Connections over a cap are accepted and immediately closed with a clear code (4001 "full",
    4003 per-IP) so the client can say "world is full, riding solo", but only REJECT_RATE times per
    second; during a connection storm everything beyond that budget gets a plain HTTP 503/429
    before any WebSocket work happens (nginx in front also rate-limits handshakes per IP).
  * Clients cannot send text of any kind (no chat, no names). Names are callsigns derived from a
    server-assigned random id, so there is nothing to moderate.
  * Every tick (1 Hz) the server encodes ONE binary snapshot of at most 64 players and writes the
    same bytes to every connection: O(players) work per tick with a fixed ceiling. Slow consumers
    whose socket buffer is backing up are skipped, and dropped if they stay slow.
  * No persistence, no per-message allocation beyond parsing one tiny JSON array.

Protocol (v1)
  client -> server (text frames, JSON arrays, <= 200 bytes):
      [1, mode, trip, s, car, x, y, z, yaw, speed]   presence state
          mode  int 0..9  (0 menu, 1 walk, 2 ride, 3 drive, 4 fly, 5 map, 6 cab, 7 air: flying an aircraft; then
                trip = aircraft type id, s = (lat+90)*1000, x = lon*1000, y = altitude/2, z = pitch/roll packed;
                8 mride: riding a Bayline Metro car, 9 mdrive: driving a metro train. Clients before hello v2 show
                modes they don't know as 'menu', i.e. they simply don't draw those players)
          trip  str  ^[A-Za-z0-9_-]{0,12}$  (GTFS trip id or "" when not on a scheduled train)
          s     float track position in meters from 4th & King (-1000..250000)
          car   int  -1..31 (-1 = not in a car)
          x,y,z float position (car-local when riding, world otherwise; |x|,|z| <= 250000, -1000 <= y <= 10000)
          yaw   float radians
          speed float m/s (-200..200)
      [2, t]                                          ping; t = client clock (ms)
  server -> client:
      text  {"t":"hi","v":1,"id":..,"name":..,"color":..,"hz":..,"max":..}   once, on connect
      text  {"t":"po","c":t}                                               pong
      binary snapshot, little-endian:
          header  u8 type=1 | u32 server_ms | u16 online | u8 n
          n x record: u16 id | u8 mode | u8 car (255 = none) | f32 s | f32 x | f32 y | f32 z |
                      i16 yaw*10000 | i16 speed*100 | u8 tripLen | tripLen bytes (ASCII)
  close codes: 4001 full, 4003 too many from your network, 4004 origin not allowed,
               4008 rate limit, 4009 bad data, 4010 idle
  HTTP GET /stats -> JSON counters, GET /healthz -> "ok"

Run: python3 mp.py   (config via MP_* environment variables, see CFG below)
Requires: websockets==16.0
"""
import asyncio
import json
import logging
import math
import os
import random
import re
import signal
import struct
import time
from http import HTTPStatus

from websockets.asyncio.server import broadcast, serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Response


def _env_bool(name, default=False):
    return os.environ.get(name, "1" if default else "0").strip().lower() in ("1", "true", "yes", "on")


CFG = {
    "HOST": os.environ.get("MP_HOST", "127.0.0.1"),
    "PORT": int(os.environ.get("MP_PORT", "8765")),
    "MAX_CONN": int(os.environ.get("MP_MAX_CONN", "150")),          # players connected at once
    "MAX_PER_IP": int(os.environ.get("MP_MAX_PER_IP", "3")),        # per client IP (after the proxy)
    "MAX_MSG": int(os.environ.get("MP_MAX_MSG", "200")),            # bytes per inbound frame
    "MSG_RATE": float(os.environ.get("MP_MSG_RATE", "4")),          # sustained inbound msgs/s per client
    "MSG_BURST": float(os.environ.get("MP_MSG_BURST", "8")),
    "IDLE_S": float(os.environ.get("MP_IDLE_S", "45")),
    "TICK_HZ": float(os.environ.get("MP_TICK_HZ", "1")),
    "SNAPSHOT_MAX": int(os.environ.get("MP_SNAPSHOT_MAX", "64")),
    "SLOW_BYTES": int(os.environ.get("MP_SLOW_BYTES", str(64 * 1024))),  # skip a client whose send buffer exceeds this
    "REJECT_RATE": float(os.environ.get("MP_REJECT_RATE", "20")),   # polite accept-then-close rejections per second;
    "REJECT_BURST": float(os.environ.get("MP_REJECT_BURST", "40")), # beyond that, over-limit handshakes get a cheap HTTP 503/429
    "ALLOW_NULL_ORIGIN": _env_bool("MP_ALLOW_NULL_ORIGIN"),        # file:// pages (local testing only)
    "ALLOW_NO_ORIGIN": _env_bool("MP_ALLOW_NO_ORIGIN"),            # non-browser clients (tests only)
    "EXTRA_ORIGINS": [o.strip() for o in os.environ.get("MP_ORIGINS", "").split(",") if o.strip()],
}
PUBLIC_ORIGIN = "https://bayline.sheltie.scottylabs.org"
LOCAL_ORIGIN_RE = re.compile(r"http://(localhost|127\.0\.0\.1)(:\d{1,5})?")
TRIP_RE = re.compile(r"[A-Za-z0-9_\-]{0,12}")

log = logging.getLogger("bayline-mp")

# ---- callsigns: MUST match the tables in src/js/80_net.js -------------------------------------
ROLES = ["Conductor", "Engineer", "Dispatcher", "Signalman", "Brakeman", "Navigator", "Rider", "Commuter"]
WORDS = ["Juniper", "Heron", "Poppy", "Redwood", "Pelican", "Sequoia", "Manzanita", "Quail",
         "Egret", "Coyote", "Willow", "Sycamore", "Tule", "Sparrow", "Buckeye", "Marina",
         "Cypress", "Plover", "Madrone", "Otter", "Bayleaf", "Kestrel", "Sage", "Tamarack",
         "Lupine", "Avocet", "Laurel", "Falcon", "Toyon", "Condor", "Yarrow", "Starling"]
COLORS = ["#e4572e", "#f3a712", "#29b6a4", "#4c8bf5", "#a560e8", "#e84393", "#7ac74f", "#f06543",
          "#2ec4b6", "#ffbf46", "#5c80bc", "#d65db1", "#56c596", "#ff7f51", "#3d9be9", "#c3d350"]


def callsign(pid):
    return f"{ROLES[pid % len(ROLES)]} {WORDS[(pid // 8) % len(WORDS)]} {(pid * 37) % 100}"


def color_of(pid):
    return COLORS[(pid * 7) % len(COLORS)]


# ---- state -----------------------------------------------------------------------------------
class Player:
    __slots__ = ("ws", "id", "ip", "mode", "car", "s", "x", "y", "z", "yaw", "speed", "trip",
                 "has_state", "last_msg", "last_state", "tokens", "tok_t", "drops", "drop_t0",
                 "strikes", "slow_ticks")

    def __init__(self, ws, pid, ip, now):
        self.ws, self.id, self.ip = ws, pid, ip
        self.mode = self.car = 0
        self.s = self.x = self.y = self.z = self.yaw = self.speed = 0.0
        self.trip = b""
        self.has_state = False
        self.last_msg = self.last_state = now
        self.tokens, self.tok_t = CFG["MSG_BURST"], now
        self.drops, self.drop_t0, self.strikes, self.slow_ticks = 0, now, 0, 0


players = {}      # id -> Player
ip_count = {}     # ip -> open connections
STATS = {"started": time.time(), "msgs": 0, "dropped": 0, "bad": 0, "rejected_full": 0, "rejected_ip": 0,
         "rejected_origin": 0, "rejected_http": 0, "closed_rate": 0, "closed_idle": 0, "closed_bad": 0,
         "closed_slow": 0, "skipped_slow": 0, "ticks": 0, "snapshot_bytes": 0, "accepted": 0}
_rates = {"msgs_per_s": 0.0, "dropped_per_s": 0.0}
_reject = {"tokens": 40.0, "t": time.monotonic()}
_T0 = time.monotonic()


def _now_ms():
    return int((time.monotonic() - _T0) * 1000) & 0xFFFFFFFF


def origin_ok(origin):
    if origin is None:
        return CFG["ALLOW_NO_ORIGIN"]
    if origin == PUBLIC_ORIGIN or origin in CFG["EXTRA_ORIGINS"]:
        return True
    if origin == "null":
        return CFG["ALLOW_NULL_ORIGIN"]
    return bool(LOCAL_ORIGIN_RE.fullmatch(origin))


def client_ip(conn, headers):
    """The proxy (nginx on loopback) passes the real client IP in X-Real-IP; trust it only from loopback."""
    peer = (conn.remote_address or ("?",))[0]
    if peer in ("127.0.0.1", "::1"):
        real = headers.get("X-Real-IP")
        if real and len(real) <= 45:
            return real.strip()
    return peer


def _json_response(status, obj):
    body = json.dumps(obj, separators=(",", ":")).encode()
    return Response(int(status), status.phrase, Headers([("Content-Type", "application/json"),
                                                          ("Content-Length", str(len(body))),
                                                          ("Cache-Control", "no-store")]), body)


def _text_response(status, text):
    body = text.encode()
    return Response(int(status), status.phrase, Headers([("Content-Type", "text/plain; charset=utf-8"),
                                                          ("Content-Length", str(len(body))),
                                                          ("Cache-Control", "no-store")]), body)


def stats_obj():
    return {"players": sum(1 for p in players.values() if p.has_state), "connections": len(players),
            "max_connections": CFG["MAX_CONN"], "uptime_s": int(time.time() - STATS["started"]),
            "msgs_per_s": round(_rates["msgs_per_s"], 1), "dropped_per_s": round(_rates["dropped_per_s"], 1),
            "tick_hz": CFG["TICK_HZ"], "snapshot_bytes": STATS["snapshot_bytes"],
            "totals": {k: v for k, v in STATS.items() if k not in ("started", "snapshot_bytes")}}


async def process_request(conn, request):
    path = request.path.split("?", 1)[0]
    if path in ("/stats", "/mp/stats"):
        return _json_response(HTTPStatus.OK, stats_obj())
    if path == "/healthz":
        return _text_response(HTTPStatus.OK, "ok\n")
    if path not in ("/", "/ws"):
        return _text_response(HTTPStatus.NOT_FOUND, "not found\n")
    if not origin_ok(request.headers.get("Origin")):
        STATS["rejected_origin"] += 1
        return _text_response(HTTPStatus.FORBIDDEN, "origin not allowed\n")
    # Over a limit: the handler will accept and close with a clear code (4001 full / 4003 per-IP) so the
    # client can explain it, but only REJECT_RATE times per second. During a storm everything beyond that
    # budget is refused at the HTTP layer, before any WebSocket work happens.
    ip = client_ip(conn, request.headers)
    full = len(players) >= CFG["MAX_CONN"]
    if full or ip_count.get(ip, 0) >= CFG["MAX_PER_IP"]:
        now = time.monotonic()
        _reject["tokens"] = min(CFG["REJECT_BURST"], _reject["tokens"] + (now - _reject["t"]) * CFG["REJECT_RATE"])
        _reject["t"] = now
        if _reject["tokens"] < 1.0:
            STATS["rejected_http"] += 1
            return _text_response(HTTPStatus.SERVICE_UNAVAILABLE if full else HTTPStatus.TOO_MANY_REQUESTS, "busy\n")
        _reject["tokens"] -= 1.0
    return None


def _new_id():
    for _ in range(64):
        pid = random.randint(1, 65535)
        if pid not in players:
            return pid
    raise RuntimeError("no free id")


def _num(v, lo, hi):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError
    v = float(v)
    if not (lo <= v <= hi) or v != v:
        raise ValueError
    return v


def _reject_constant(_):
    raise ValueError("NaN/Infinity not allowed")


def apply_message(p, msg, now):
    """Validate one inbound frame. Returns a reply string or None. Raises ValueError when invalid."""
    if not isinstance(msg, str):
        raise ValueError("binary not accepted")
    data = json.loads(msg, parse_constant=_reject_constant)
    if not isinstance(data, list) or not data:
        raise ValueError
    kind = data[0]
    if kind == 1 and len(data) == 10:
        mode = int(_num(data[1], 0, 9))
        trip = data[2]
        if not isinstance(trip, str) or not TRIP_RE.fullmatch(trip):
            raise ValueError
        s = _num(data[3], -1000, 250000)
        car = int(_num(data[4], -1, 31))
        x = _num(data[5], -250000, 250000)
        y = _num(data[6], -1000, 10000)
        z = _num(data[7], -250000, 250000)
        yaw = math.remainder(_num(data[8], -100, 100), math.tau)
        speed = _num(data[9], -200, 200)
        p.mode, p.trip, p.s, p.car = mode, trip.encode("ascii"), s, (255 if car < 0 else car)
        p.x, p.y, p.z, p.yaw, p.speed = x, y, z, yaw, speed
        p.has_state, p.last_state = True, now
        return None
    if kind == 2 and len(data) == 2:
        t = _num(data[1], -1e15, 1e15)
        return '{"t":"po","c":%s}' % (repr(t) if t != int(t) else int(t))
    raise ValueError


_HDR = struct.Struct("<BIHB")
_REC = struct.Struct("<HBBffffhhB")


def encode_snapshot():
    active = [p for p in players.values() if p.has_state]
    if len(active) > CFG["SNAPSHOT_MAX"]:
        active.sort(key=lambda p: p.last_state, reverse=True)
        active = active[:CFG["SNAPSHOT_MAX"]]
    parts = [_HDR.pack(1, _now_ms(), min(len(players), 65535), len(active))]
    for p in active:
        parts.append(_REC.pack(p.id, p.mode, p.car, p.s, p.x, p.y, p.z,
                               max(-32767, min(32767, int(round(p.yaw * 10000)))),
                               max(-32767, min(32767, int(round(p.speed * 100)))), len(p.trip)))
        parts.append(p.trip)
    return b"".join(parts)


async def ticker():
    period = 1.0 / max(0.1, CFG["TICK_HZ"])
    nxt = time.monotonic()
    while True:
        nxt += period
        await asyncio.sleep(max(0.0, nxt - time.monotonic()))
        if not players:
            continue
        snap = encode_snapshot()
        STATS["ticks"] += 1
        STATS["snapshot_bytes"] = len(snap)
        targets = []
        for p in list(players.values()):
            tr = getattr(p.ws, "transport", None)
            if tr is None:
                continue
            if tr.get_write_buffer_size() > CFG["SLOW_BYTES"]:
                p.slow_ticks += 1
                STATS["skipped_slow"] += 1
                if p.slow_ticks > 10:
                    STATS["closed_slow"] += 1
                    tr.abort()
                continue
            p.slow_ticks = 0
            targets.append(p.ws)
        broadcast(targets, snap)


async def sweeper():
    """Once a second: drop idle clients and refresh the msg/s counters for /stats."""
    last_msgs, last_drop, last_t = 0, 0, time.monotonic()
    last_log = time.monotonic()
    while True:
        await asyncio.sleep(1.0)
        now = time.monotonic()
        for p in list(players.values()):
            if now - p.last_msg > CFG["IDLE_S"]:
                STATS["closed_idle"] += 1
                asyncio.ensure_future(p.ws.close(4010, "idle"))
                p.last_msg = now + 3600  # do not schedule twice
        dt = max(1e-3, now - last_t)
        _rates["msgs_per_s"] = 0.7 * _rates["msgs_per_s"] + 0.3 * (STATS["msgs"] - last_msgs) / dt
        _rates["dropped_per_s"] = 0.7 * _rates["dropped_per_s"] + 0.3 * (STATS["dropped"] - last_drop) / dt
        last_msgs, last_drop, last_t = STATS["msgs"], STATS["dropped"], now
        if now - last_log > 300 and players:
            last_log = now
            log.info("connections=%d players=%d msgs/s=%.1f snapshot=%dB", len(players),
                     sum(1 for p in players.values() if p.has_state), _rates["msgs_per_s"], STATS["snapshot_bytes"])


async def handler(ws):
    ip = client_ip(ws, ws.request.headers)
    now = time.monotonic()
    # Admission is checked and recorded synchronously (no await in between), so it cannot race.
    if len(players) >= CFG["MAX_CONN"]:
        STATS["rejected_full"] += 1
        await ws.close(4001, "full")
        return
    if ip_count.get(ip, 0) >= CFG["MAX_PER_IP"]:
        STATS["rejected_ip"] += 1
        await ws.close(4003, "too many connections from your network")
        return
    p = Player(ws, _new_id(), ip, now)
    players[p.id] = p
    ip_count[ip] = ip_count.get(ip, 0) + 1
    STATS["accepted"] += 1
    rate, burst = CFG["MSG_RATE"], CFG["MSG_BURST"]
    try:
        await ws.send(json.dumps({"t": "hi", "v": 2, "id": p.id, "name": callsign(p.id), "color": color_of(p.id),
                                  "hz": CFG["TICK_HZ"], "max": CFG["MAX_CONN"]}, separators=(",", ":")))
        async for msg in ws:
            now = time.monotonic()
            p.last_msg = now
            # token bucket
            p.tokens = min(burst, p.tokens + (now - p.tok_t) * rate)
            p.tok_t = now
            if p.tokens < 1.0:
                STATS["dropped"] += 1
                if now - p.drop_t0 > 10.0:
                    p.drop_t0, p.drops = now, 0
                p.drops += 1
                if p.drops > 40:          # persistently flooding
                    STATS["closed_rate"] += 1
                    await ws.close(4008, "rate limit")
                    break
                continue
            p.tokens -= 1.0
            STATS["msgs"] += 1
            try:
                reply = apply_message(p, msg, now)
            except (ValueError, TypeError, OverflowError, json.JSONDecodeError):
                STATS["bad"] += 1
                p.strikes += 1
                if p.strikes >= 3:
                    STATS["closed_bad"] += 1
                    await ws.close(4009, "bad data")
                    break
                continue
            if reply is not None:
                await ws.send(reply)
    except ConnectionClosed:
        pass
    finally:
        players.pop(p.id, None)
        n = ip_count.get(ip, 1) - 1
        if n <= 0:
            ip_count.pop(ip, None)
        else:
            ip_count[ip] = n


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("websockets").setLevel(logging.WARNING)
    stop = asyncio.get_running_loop().create_future()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            asyncio.get_running_loop().add_signal_handler(sig, stop.set_result, None)
        except (NotImplementedError, RuntimeError):
            pass
    async with serve(handler, CFG["HOST"], CFG["PORT"],
                     process_request=process_request,
                     compression=None,              # tiny messages; deflate would cost memory per socket
                     max_size=CFG["MAX_MSG"],        # oversize frames close the socket (1009)
                     max_queue=4,                     # at most 4 unread inbound frames per client
                     write_limit=16 * 1024,
                     open_timeout=5, ping_interval=20, ping_timeout=20, close_timeout=3,
                     server_header=None):
        tasks = [asyncio.create_task(ticker()), asyncio.create_task(sweeper())]
        log.info("listening on %s:%d max_conn=%d per_ip=%d tick=%.1fHz", CFG["HOST"], CFG["PORT"],
                 CFG["MAX_CONN"], CFG["MAX_PER_IP"], CFG["TICK_HZ"])
        await stop
        for t in tasks:
            t.cancel()


if __name__ == "__main__":
    asyncio.run(main())
