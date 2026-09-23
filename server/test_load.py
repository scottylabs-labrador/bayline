#!/usr/bin/env python3
"""Load and abuse test for the Bayline relay (server/mp.py).

Starts mp.py as a subprocess on a free port with test-friendly settings, then throws at it:
  * N honest clients (default 300 against a cap of 150), each from its own simulated IP
    (X-Real-IP, trusted only from loopback), sending presence at 2 Hz and a ping every 5 s;
  * a flooder (200 msgs/s)            -> must be closed with 4008;
  * an oversize sender (1 KB frame)   -> must be closed with 1009;
  * a garbage/NaN sender              -> must be closed with 4009;
  * a disallowed Origin               -> must be refused (HTTP 403);
  * five sockets from one IP          -> three accepted, two closed with 4003;
  * a silent client                   -> must be closed with 4010 after the idle timeout.
While all of that runs it samples the server's CPU and RSS and times GET /stats.

    python3 server/test_load.py [--clients 300] [--cap 150] [--seconds 25]
Requires: websockets==16.0, psutil
"""
import argparse
import asyncio
import json
import os
import random
import resource
import socket
import statistics
import struct
import subprocess
import sys
import time
import urllib.request

import psutil
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

HERE = os.path.dirname(os.path.abspath(__file__))
ORIGIN = "http://localhost:8099"


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


async def honest(url, ip, seconds, results, idx):
    """A well-behaved client: 2 Hz state, ping every 5 s. Records outcome and snapshots received."""
    rec = {"accepted": False, "close": None, "snaps": 0, "snap_bytes": [], "max_records": 0, "rtt": []}
    results[idx] = rec
    try:
        async with connect(url, origin=ORIGIN, additional_headers={"X-Real-IP": ip}, compression=None,
                           open_timeout=15, max_size=65536) as ws:
            end = time.monotonic() + seconds
            s = random.uniform(0, 78000)
            last_ping = 0

            async def reader():
              try:
                async for m in ws:
                    if isinstance(m, bytes):
                        rec["snaps"] += 1
                        rec["snap_bytes"].append(len(m))
                        _, _, _, n = struct.unpack_from("<BIHB", m, 0)
                        rec["max_records"] = max(rec["max_records"], n)
                    else:
                        d = json.loads(m)
                        if d.get("t") == "hi":
                            rec["accepted"] = True
                        elif d.get("t") == "po":
                            rec["rtt"].append(time.monotonic() * 1000 - d["c"])
              except ConnectionClosed as e:
                rec["close"] = e.rcvd.code if e.rcvd else None

            rt = asyncio.create_task(reader())
            while time.monotonic() < end and not rt.done():
                s += 17.0
                await ws.send(json.dumps([1, 2, "141", round(s, 1), 3, 1.2, 2.6, -0.4, 1.57, 22.1]))
                if time.monotonic() - last_ping > 5:
                    last_ping = time.monotonic()
                    await ws.send(json.dumps([2, time.monotonic() * 1000]))
                await asyncio.sleep(0.5)
            rt.cancel()
    except ConnectionClosed as e:
        rec["close"] = e.rcvd.code if e.rcvd else None
    except InvalidStatus as e:
        rec["close"] = "http%d" % e.response.status_code
    except Exception as e:  # noqa
        rec["close"] = type(e).__name__
    if rec["close"] is None and not rec["accepted"]:
        rec["close"] = "unknown"


async def abuser(kind, url, results):
    """Misbehaving clients. Each records the close code it got."""
    out = {"kind": kind, "close": None}
    results.append(out)
    ip = "10.66.%d.%d" % (random.randint(0, 255), random.randint(1, 254))
    origin = "https://evil.example" if kind == "origin" else ORIGIN
    try:
        async with connect(url, origin=origin, additional_headers={"X-Real-IP": ip}, compression=None,
                           open_timeout=15, max_size=65536) as ws:
            if kind == "flood":
                for _ in range(2000):
                    await ws.send('[1,2,"141",10,3,1,2,3,0.1,5]')
                    await asyncio.sleep(0.005)
            elif kind == "oversize":
                await ws.send("[" + "1," * 500 + "1]")
            elif kind == "garbage":
                for m in ["hello", "[1,2,\"141\",NaN,3,1,2,3,0,0]", "{\"t\":\"chat\",\"text\":\"hi\"}", "[1,99,\"141\",1,1,1,1,1,1,1]"]:
                    await ws.send(m); await asyncio.sleep(0.05)
            elif kind == "idle":
                pass
            await asyncio.wait_for(ws.wait_closed(), timeout=30)
            out["close"] = ws.close_code
    except ConnectionClosed as e:
        out["close"] = e.rcvd.code if e.rcvd else "closed"
    except InvalidStatus as e:
        out["close"] = "http%d" % e.response.status_code
    except asyncio.TimeoutError:
        out["close"] = "still-open"
    except Exception as e:  # noqa
        out["close"] = type(e).__name__


async def same_ip(url, results):
    out = {"kind": "same-ip x5", "codes": []}
    results.append(out)

    async def one():
        try:
            async with connect(url, origin=ORIGIN, additional_headers={"X-Real-IP": "10.9.9.9"}, compression=None,
                               open_timeout=15) as ws:
                m = await asyncio.wait_for(ws.recv(), 5)
                ok = json.loads(m).get("t") == "hi"
                await asyncio.sleep(6)
                out["codes"].append("ok" if ok else "?")
        except ConnectionClosed as e:
            out["codes"].append(e.rcvd.code if e.rcvd else "closed")
        except InvalidStatus as e:
            out["codes"].append("http%d" % e.response.status_code)
    await asyncio.gather(*[one() for _ in range(5)])


def sampler(proc, stop, samples):
    ps = psutil.Process(proc.pid)
    ps.cpu_percent(None)
    while not stop.is_set():
        time.sleep(0.5)
        try:
            samples.append((ps.cpu_percent(None), ps.memory_info().rss / 1e6))
        except psutil.Error:
            break


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clients", type=int, default=300)
    ap.add_argument("--cap", type=int, default=150)
    ap.add_argument("--seconds", type=int, default=25)
    a = ap.parse_args()
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    resource.setrlimit(resource.RLIMIT_NOFILE, (min(hard, 8192), hard))
    port = free_port()
    env = dict(os.environ, MP_PORT=str(port), MP_MAX_CONN=str(a.cap), MP_MAX_PER_IP="3", MP_IDLE_S="8")
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, "mp.py")], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    await asyncio.sleep(1.2)
    url = f"ws://127.0.0.1:{port}/ws"
    import threading
    stop = threading.Event(); samples = []
    th = threading.Thread(target=sampler, args=(proc, stop, samples), daemon=True); th.start()

    results = [None] * a.clients
    abuse = []
    # Phase 1: abusers alongside 100 honest clients (below the cap, so each abuser gets its specific code).
    first = min(100, a.clients)
    mk = lambda i: asyncio.create_task(honest(url, "10.1.%d.%d" % (i // 250, i % 250 + 1), a.seconds, results, i))
    tasks = [mk(i) for i in range(first)]
    tasks += [asyncio.create_task(abuser(k, url, abuse)) for k in ("flood", "oversize", "garbage", "origin", "idle")]
    tasks.append(asyncio.create_task(same_ip(url, abuse)))
    await asyncio.sleep(3)
    # Phase 2: everyone else at once (worst-case burst), which oversubscribes the cap.
    tasks += [mk(i) for i in range(first, a.clients)]

    # /stats latency under load
    lat = []
    for _ in range(10):
        await asyncio.sleep(1)
        t = time.perf_counter()
        body = await asyncio.to_thread(lambda: urllib.request.urlopen(f"http://127.0.0.1:{port}/stats", timeout=5).read())
        lat.append((time.perf_counter() - t) * 1000)
    stats_mid = json.loads(body)
    await asyncio.gather(*tasks, return_exceptions=True)
    stats_end = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/stats", timeout=5).read())
    stop.set(); th.join(2)
    proc.terminate()
    try:
        out, _ = proc.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill(); out = ""

    acc = [r for r in results if r and r["accepted"]]
    closes = {}
    for r in results:
        if r and not r["accepted"]:
            closes[r["close"]] = closes.get(r["close"], 0) + 1
    snaps = [r["snaps"] for r in acc]
    rtts = [x for r in acc for x in r["rtt"]]
    cpu = [c for c, _ in samples]; rss = [m for _, m in samples]
    print(f"honest clients: {a.clients} tried, {len(acc)} accepted (cap {a.cap}), refused: {closes}")
    print(f"snapshots per accepted client over {a.seconds}s: median {statistics.median(snaps) if snaps else 0}, "
          f"max records in a snapshot {max((r['max_records'] for r in acc), default=0)}, "
          f"snapshot size max {max((max(r['snap_bytes']) for r in acc if r['snap_bytes']), default=0)} B")
    if rtts:
        print(f"ping RTT under load: median {statistics.median(rtts):.1f} ms, p95 {sorted(rtts)[int(len(rtts)*.95)]:.1f} ms")
    print(f"/stats latency under load: median {statistics.median(lat):.1f} ms, max {max(lat):.1f} ms")
    print(f"server CPU: mean {statistics.mean(cpu):.1f}% peak {max(cpu):.1f}% | RSS: start {rss[0]:.1f} MB peak {max(rss):.1f} MB")
    for ab in abuse:
        print("abuser", ab)
    print("stats mid-run:", json.dumps(stats_mid))
    print("stats end:", json.dumps(stats_end))
    # assertions
    ok = True
    def check(cond, what):
        nonlocal ok
        print(("PASS " if cond else "FAIL ") + what); ok &= cond
    check(len(acc) <= a.cap, "never more than the cap accepted")
    check(len(acc) >= min(a.cap, a.clients) - 15, "about the cap accepted when oversubscribed (abusers hold a few slots)")
    check(all(k in (4001, "http503") for k in closes), "refused clients got 4001 full / HTTP 503 (storm budget)")
    byk = {x["kind"]: x for x in abuse}
    check(byk["flood"]["close"] == 4008, "flooder closed with 4008")
    check(byk["oversize"]["close"] == 1009, "oversize frame closed with 1009")
    check(byk["garbage"]["close"] == 4009, "garbage closed with 4009")
    check(byk["origin"]["close"] == "http403", "bad origin refused with 403")
    check(byk["idle"]["close"] == 4010, "idle client closed with 4010")
    codes = byk["same-ip x5"]["codes"]
    check(codes.count("ok") <= 3 and codes.count(4003) >= 2, f"per-IP cap holds ({codes})")
    check(max(rss) < 80, "server RSS stays under 80 MB")
    check(max((r['max_records'] for r in acc), default=0) <= 64, "snapshot never exceeds 64 players")
    print("RESULT:", "ALL PASS" if ok else "FAILURES")
    if out:
        print("server log tail:\n" + "\n".join(out.strip().splitlines()[-5:]))


if __name__ == "__main__":
    asyncio.run(main())
