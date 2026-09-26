#!/bin/sh
# Bayline Metro on a phone (M3 gate item 5): tools/shot.mjs --mobile (DPR 2, touch) at 390 x 844 on Low and Medium with
# the metro on: frame rate, memory, and the metro by touch (map, platform, board by tapping the prompt, ride panel,
# the on-screen drive buttons): tools/qa_metro_mobile.js. Fails on a failed step, a page/console error or a metro failure.
# Usage: [PORT=8136] sh tools/qa_metro_mobile.sh [page] [outdir]     one headless Chrome at a time
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
PAGE=${1:-sim.html}; OUT=${2:-/tmp/bayline-metro-mobile}; mkdir -p "$OUT"
BASE="http://localhost:${PORT:-8136}/$PAGE"; X=${XH:+&$XH}   # XH=metrodir=metro-next/ adds to every URL
fails=0
for q in low medium; do
  python3 tools/wd.py 600 node tools/shot.mjs "$BASE#auto&metro=1&q=$q&t=08:03$X" "$OUT/phone_$q.png" --gpu --mobile --w 390 --h 844 --wait 300 --eval "$(cat tools/qa_metro_mobile.js)" > "$OUT/phone_$q.log" 2>&1
  grep '^\[eval\]' "$OUT/phone_$q.log" | tail -1 | cut -c8- | python3 -c "
import sys, json
j = json.loads(sys.stdin.read() or '{}')
print('$q: fps', j.get('fps'), '· canvas', j.get('canvas'), '· JS heap', j.get('mem'), '->', j.get('memEnd'), '· gl', j.get('gl'), '· coarse pointer', j.get('coarse'))
for s in j.get('steps', []): print('  ', 'PASS' if s['ok'] else 'FAIL', s['s'], {k: v for k, v in s.items() if k not in ('s', 'ok')} or '')
" || true
  grep -q '"metroOn":true,"ok":true}' "$OUT/phone_$q.log" && ! grep -qE '^\[pageerror\]|^\[console\.error\]' "$OUT/phone_$q.log" && echo "PASS phone $q" || { echo "FAIL phone $q"; grep -E '^\[pageerror\]|^\[console\.error\]' "$OUT/phone_$q.log" | head -5; fails=$((fails+1)); }
done
echo "== $fails failed ($OUT)"
[ $fails = 0 ]
