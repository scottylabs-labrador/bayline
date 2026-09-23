#!/bin/sh
# Publish the streamed world data (data/pub/v2) to the Sheltie server volume that nginx serves at /data/v2/.
# Needs root SSH to the server (key auth). The server IP is read from ../.env (server_IP=...).
# Usage: sh tools/publish_data.sh [subpath]     e.g.  sh tools/publish_data.sh tiles/img/8
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
IP=$(grep -E '^server_IP=' "$ROOT/../.env" | cut -d= -f2 | tr -d "\"' ")
VOL=/var/lib/docker/volumes/z6wlz29del6zkzkurztm6f8b-bayline-data/_data
SUB=${1:-}
ssh -o BatchMode=yes "root@$IP" "mkdir -p $VOL/v2/$SUB"
rsync -az --partial --stats -e "ssh -o BatchMode=yes" "$ROOT/data/pub/v2/$SUB/" "root@$IP:$VOL/v2/$SUB/" | grep -E "Number of files transferred|Total transferred file size" || true
ssh -o BatchMode=yes "root@$IP" "chmod -R a+rX $VOL/v2"
echo "published data/pub/v2/$SUB -> $IP:$VOL/v2/$SUB"
