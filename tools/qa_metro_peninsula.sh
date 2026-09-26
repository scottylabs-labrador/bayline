#!/bin/sh
# The Peninsula line with Bayline Metro on (M3 gate item 2), in one command: the full Caltrain suite (qa_all.sh: views,
# keyboard drive, ride flow), PTC, signal protection, the flight FDM, and the HUD/boards/prompts at the Caltrain
# stations next to the metro (qa_peninsula_spots.js). Run it with METRO=1 and METRO=0 and compare.
# Usage: [PORT=8136] METRO=1 sh tools/qa_metro_peninsula.sh [page] [outdir]      one headless Chrome at a time
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
PAGE=${1:-sim.html}; OUT=${2:-/tmp/bayline-peninsula-metro${METRO:-}}; mkdir -p "$OUT"
BASE="http://localhost:${PORT:-8136}/$PAGE"; X=${XH:+&$XH}
MQ=""; [ "${METRO:-}" = 1 ] && MQ="&metro=1"; [ "${METRO:-}" = 0 ] && MQ="&metro=0"
fails=0
note() { echo "$1"; case "$1" in FAIL*) fails=$((fails+1));; esac; }
echo "== Peninsula with ${MQ:-the page default} ($PAGE) -> $OUT"
# 1. the Caltrain suite (qa_all.sh passes METRO through)
PORT=${PORT:-8136} METRO=${METRO:-} python3 tools/wd.py 1500 sh tools/qa_all.sh "$PAGE" "$OUT/all" > "$OUT/all.log" 2>&1
cat "$OUT/all.log" | cut -c1-300
grep -qE '\[pageerror\]|\[console\.error\]' "$OUT/all.log" && note "FAIL qa_all: page or console errors" || note "PASS qa_all: no page or console errors"
grep -q '"boarded":true' "$OUT/all.log" && note "PASS ride flow boards" || note "FAIL ride flow did not board"
grep -q 'drive_qa.*maxMph' "$OUT/all.log" && note "PASS keyboard drive ran" || note "FAIL keyboard drive"
# 2. PTC: a reckless driver into the 30 mph Diridon zone must be warned, enforced to a stop, released
python3 tools/wd.py 200 node tools/shot.mjs "$BASE#auto$MQ&t=08:00$X" "$OUT/ptc.png" --gpu --wait 90000 --eval "$(cat tools/qa_ptc.js)" --eval2 "JSON.stringify(window.__qa)" > "$OUT/ptc.log" 2>&1
grep '^\[eval\]' "$OUT/ptc.log" | tail -1 | cut -c1-400
grep -q 'PTC ENFORCE' "$OUT/ptc.log" && grep -q 'PTC OK at 0.0 mph' "$OUT/ptc.log" && ! grep -qE '\[pageerror\]|\[console\.error\]' "$OUT/ptc.log" && note "PASS PTC warn/enforce/release" || note "FAIL PTC"
# 3. signal: a reckless driver behind a parked train must be stopped before the red
python3 tools/wd.py 200 node tools/shot.mjs "$BASE#auto$MQ&t=08:00$X" "$OUT/signal.png" --gpu --wait 90000 --eval "$(cat tools/qa_signal.js)" --eval2 "JSON.stringify(window.__qa)" > "$OUT/signal.log" 2>&1
grep '^\[eval\]' "$OUT/signal.log" | tail -1 | cut -c1-400
grep -q '"passedRed":0' "$OUT/signal.log" && ! grep -qE '\[pageerror\]|\[console\.error\]' "$OUT/signal.log" && note "PASS signal: stopped before the red" || note "FAIL signal"
# 4. the Caltrain stations next to the metro: HUD, strip, prompt, B board
python3 tools/wd.py 200 node tools/shot.mjs "$BASE#auto$MQ&t=08:10&at=place_MLBR$X" "$OUT/spots.png" --gpu --wait 300 --eval "$(cat tools/qa_peninsula_spots.js)" > "$OUT/spots.log" 2>&1
grep '^\[eval\]' "$OUT/spots.log" | cut -c8- | python3 -c "
import sys, json
for line in sys.stdin:
  j=json.loads(line)
  for s in j['spots']: print(('PASS' if s.get('ok') else 'FAIL'), 'spot', s['id'], '|', s.get('where',''), '|', s.get('sub','')[:60], '|', s.get('prompt',''), '|', 'board' if s.get('penBoard') else 'NO BOARD', '|', ', '.join(s.get('bad',[])))
  print('spots: metro running' if j['metro'] else 'spots: metro not running', '·', j['fails'], 'failed')
" | while read -r l; do note "$l"; done
grep -q '"fails":0' "$OUT/spots.log" && ! grep -qE '\[pageerror\]|\[console\.error\]' "$OUT/spots.log" && note "PASS Peninsula stations: HUD, strip, prompt, board" || note "FAIL Peninsula stations"
# 5. the flight FDM (Node, no page)
python3 tools/wd.py 600 node tools/qa_flight.js > "$OUT/flight.log" 2>&1
tail -4 "$OUT/flight.log"
grep -q 'H125     landing: touchdown' "$OUT/flight.log" && ! grep -qi 'error' "$OUT/flight.log" && note "PASS flight FDM" || note "FAIL flight FDM"
echo "== $fails failed ($OUT)"
[ $fails = 0 ]
