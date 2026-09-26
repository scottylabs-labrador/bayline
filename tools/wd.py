#!/usr/bin/env python3
"""wd.py SECONDS cmd [args...]: run cmd in its own process group; on timeout (or if this watchdog is itself
interrupted) send SIGTERM to the whole group so shot.mjs / capture.mjs run their cleanup (kill Chrome, remove the
profile), then SIGKILL whatever is left after a grace period. Exit code: the command's, or 124 on timeout."""
import os, signal, subprocess, sys, time
secs = float(sys.argv[1]); cmd = sys.argv[2:]
p = subprocess.Popen(cmd, start_new_session=True)
def stop(code):
    try: os.killpg(p.pid, signal.SIGTERM)
    except ProcessLookupError: sys.exit(code)
    t = time.time()
    while time.time() - t < 8:
        if p.poll() is not None: break
        time.sleep(0.2)
    time.sleep(1.0)                      # (Chrome, in the same group, may outlive node for a moment)
    try: os.killpg(p.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    sys.exit(code)
for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(s, lambda *_: stop(130))
try: sys.exit(p.wait(timeout=secs))
except subprocess.TimeoutExpired: stop(124)
