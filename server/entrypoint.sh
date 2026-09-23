#!/bin/sh
# Start the multiplayer relay as an unprivileged user (restarted if it ever exits), then run
# nginx in the foreground as PID 1 so the container stops cleanly with it.
set -eu
(
  while true; do
    su -p -s /bin/sh mp -c 'exec python3 -u /app/mp.py' || true
    echo "bayline: relay exited, restarting in 2 s" >&2
    sleep 2
  done
) &
exec nginx -g 'daemon off;'
