#!/bin/sh
# Bayline Metro world publish: the exact sequence, for the LEAD to run (the world workstream never deploys).
# Same server, volume and rsync as tools/publish_data.sh.
#
#   sh tools/metro_world/publish_world.sh tiles          1) every new tile file. rsync --ignore-existing: a file that is
#                                                           already on the server is never touched (add-only, enforced)
#   sh tools/metro_world/publish_world.sh indexes        2) the index files, tiles/index.json last
#   sh tools/metro_world/publish_world.sh fixes-check    the 49 dropout replacements: server sha256 == old_sha256 ?
#   sh tools/metro_world/publish_world.sh fixes          3) the 49 replacements (server), then the same files into the
#                                                           local data/pub (so a later publish_data.sh never reverts them)
#   sh tools/metro_world/publish_world.sh sr-check       later: the 1024 px L8 set, server sha256 == old_sha256 ?
#   sh tools/metro_world/publish_world.sh sr             later: the 1024 px L8 set (server, then local data/pub)
#   DRY=1 sh tools/metro_world/publish_world.sh <step>   rsync --dry-run: lists what would be sent, changes nothing
set -euf          # (-f: no pathname expansion, the rsync patterns below stay literal)
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ENV=""
for e in "$ROOT/../.env" "$ROOT/../../../.env"; do [ -f "$e" ] && ENV=$e && break; done
[ -n "$ENV" ] || { echo "no .env with server_IP found above $ROOT"; exit 1; }
IP=$(grep -E '^server_IP=' "$ENV" | cut -d= -f2 | tr -d "\"' ")
VOL=/var/lib/docker/volumes/z6wlz29del6zkzkurztm6f8b-bayline-data/_data
PUB="$ROOT/data/pub/v2"
SSH="ssh -o BatchMode=yes"
N=""; [ "${DRY:-0}" = "1" ] && N="--dry-run"
T=${TMPDIR:-/tmp}
RS="rsync -az $N --stats --exclude *.tmp --exclude *_test.* -e"

push_dir() {   # add-only: new files only
  [ -z "$N" ] && $SSH "root@$IP" "mkdir -p $VOL/v2/$1"
  $RS "$SSH" --ignore-existing "$PUB/$1/" "root@$IP:$VOL/v2/$1/" | grep -E "files transferred|Total transferred file size" | sed "s|^|  $1: |" || true
}
push_file() {  # one file, replacing the server copy
  $RS "$SSH" "$PUB/$1" "root@$IP:$VOL/v2/$1" | grep -E "files transferred" | sed "s|^|  $1: |" || true
}
shacheck() {   # $1 manifest.json, $2 old_sha256 | new_sha256: compare the server's files with the manifest
  python3 - "$1" "$2" > $T/bl_world_paths.txt <<'EOF'
import json, sys
for f in json.load(open(sys.argv[1]))['files']:
    print(f['path'], f[sys.argv[2]])
EOF
  cut -d' ' -f1 $T/bl_world_paths.txt | sed "s|^|$VOL/v2/|" | $SSH "root@$IP" "xargs sha256sum" | sed "s|$VOL/v2/||" | awk '{print $2, $1}' | sort > $T/bl_world_server.txt
  sort $T/bl_world_paths.txt > $T/bl_world_want.txt
  if cmp -s $T/bl_world_want.txt $T/bl_world_server.txt; then echo "  all $(wc -l < $T/bl_world_want.txt | tr -d ' ') server files match $2"
  else echo "  MISMATCH vs $2:"; diff $T/bl_world_want.txt $T/bl_world_server.txt | head -20; fi
  rm -f $T/bl_world_paths.txt $T/bl_world_server.txt $T/bl_world_want.txt
}
replace_set() {  # $1 staged root (contains tiles/...), $2 manifest: server first, then the local data/pub copy
  python3 - "$2" > $T/bl_world_files.txt <<'EOF'
import json, sys
for f in json.load(open(sys.argv[1]))['files']:
    print(f['path'])
EOF
  rsync -az $N --stats --files-from=$T/bl_world_files.txt -e "$SSH" "$1/" "root@$IP:$VOL/v2/" | grep -E "files transferred" || true
  if [ -z "$N" ]; then rsync -a --files-from=$T/bl_world_files.txt "$1/" "$PUB/"; echo "  local data/pub updated"; fi
  rm -f $T/bl_world_files.txt
}

case "${1:-}" in
  tiles)
    for d in img/2 img/3 img/4 img/5 img/6 img/7 img/8 img/9 h/2 h/3 h/4 h/5 h/6 h/7 m/2 m/3 m/4 m/5 m/6 m/7 t/7 h9/8 h9/9 mat/7 t2/7 b2/7; do
      push_dir "tiles/$d"
    done ;;
  indexes)
    for f in h9/index.json mat/index.json t2/index.json b2/index.json index.json; do push_file "tiles/$f"; done ;;
  fixes-check) shacheck "$ROOT/data/raw/tiles/fix_dropouts/manifest.json" old_sha256 ;;
  fixes)       replace_set "$ROOT/data/raw/tiles/fix_dropouts" "$ROOT/data/raw/tiles/fix_dropouts/manifest.json"
               [ -z "$N" ] && shacheck "$ROOT/data/raw/tiles/fix_dropouts/manifest.json" new_sha256 ;;
  sr-check)    shacheck "$ROOT/data/raw/tiles/sr_l8_stage/manifest.json" old_sha256 ;;
  sr)          replace_set "$ROOT/data/raw/tiles/sr_l8_stage" "$ROOT/data/raw/tiles/sr_l8_stage/manifest.json"
               [ -z "$N" ] && shacheck "$ROOT/data/raw/tiles/sr_l8_stage/manifest.json" new_sha256 ;;
  *) sed -n 2,16p "$0"; exit 1 ;;
esac
[ -z "$N" ] && $SSH "root@$IP" "chmod -R a+rX $VOL/v2/tiles"
echo "done: $1 ${N:+(dry run)}"
