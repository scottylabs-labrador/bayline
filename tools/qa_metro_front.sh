#!/bin/sh
# Bayline Metro front door (M3 gate item 6), in one command: tools/qa_metro_front.js from the title card (no #auto) with
# the metro on at 1366x768 (strip, Bay-wide copy, the card fits, station search over names/codes/aliases, drive runs, a
# station chip starts on its platform, the HUD Metro pill opens the map with its non-affiliation line, help keys, no
# trademark in visible text), with #metro=0 (the old card and copy, no metro keys/pill/data), with no flag (the page's
# default: the #metro=0 checks before the flip, the metro checks after it), and on a phone (390 x 844, touch, metro on).
# Usage: [PORT=8136] [XH=metrodir=metro-next/] sh tools/qa_metro_front.sh [page] [outdir]     one headless Chrome at a time
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
PAGE=${1:-sim.html}; OUT=${2:-/tmp/bayline-metro-front}; mkdir -p "$OUT"
BASE="http://localhost:${PORT:-8136}/$PAGE"; X=${XH:+&$XH}
fails=0
for m in 1 0 default phone; do   # (default: no metro flag, the page's own default; phone: the metro on a 390 x 844 touch screen)
  h="metro=$m&"; sz="--w 1366 --h 768"; [ $m = default ] && h=""; [ $m = phone ] && { h="metro=1&"; sz="--mobile --w 390 --h 844"; }
  python3 tools/wd.py 200 node tools/shot.mjs "$BASE#${h}t=18:40$X" "$OUT/front_metro$m.png" --gpu $sz --wait 300 --eval "$(cat tools/qa_metro_front.js)" > "$OUT/front_metro$m.log" 2>&1
  grep '^\[eval\]' "$OUT/front_metro$m.log" | tail -1 | cut -c8- | python3 -c "
import sys, json
j = json.loads(sys.stdin.read() or '{\"checks\":{},\"fails\":1}')
tag = {'default': 'default (metro ' + ('on' if j.get('metro') else 'off') + ')', 'phone': 'phone (metro on)'}.get('$m', 'metro=$m')
for k, v in j['checks'].items(): print(('PASS' if v is True else 'FAIL'), tag, k, '' if v is True else '| ' + str(v))
" | while read -r l; do echo "$l"; done
  grep -q '"fails":0' "$OUT/front_metro$m.log" || { echo "FAIL metro=$m: a check failed or no result ($OUT/front_metro$m.log)"; fails=$((fails+1)); }
  if grep -qE '^\[pageerror\]|^\[console\.error\]|^\[eval error\]' "$OUT/front_metro$m.log"; then echo "FAIL metro=$m: page or console errors"; grep -E '^\[pageerror\]|^\[console\.error\]|^\[eval error\]' "$OUT/front_metro$m.log" | head -5 | cut -c1-300; fails=$((fails+1)); fi
done
echo "== $fails failed ($OUT)"
[ $fails = 0 ]
