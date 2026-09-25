#!/bin/sh
# Start the multiplayer relay as an unprivileged user (restarted if it ever exits), then run
# nginx in the foreground as PID 1 so the container stops cleanly with it.
set -eu
# The share-card tags (og:url, og:image, og:video) are built with the Sheltie address; a deployment on another
# domain sets PUBLIC_URL (e.g. https://bayline.tkanz.com) so link previews point at that deployment instead.
if [ -n "${PUBLIC_URL:-}" ]; then
  html=/usr/share/nginx/html/index.html
  sed -i "s#https://bayline\.sheltie\.scottylabs\.org#${PUBLIC_URL%/}#g" "$html"
  gzip -9 -kf "$html"
fi
(
  while true; do
    su -p -s /bin/sh mp -c 'exec python3 -u /app/mp.py' || true
    echo "bayline: relay exited, restarting in 2 s" >&2
    sleep 2
  done
) &
exec nginx -g 'daemon off;'
