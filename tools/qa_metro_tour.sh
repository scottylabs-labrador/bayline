#!/bin/sh
# Bayline Metro clean console (M3 gate item 8): a player's tour of every metro station (the 50, the airport connector's
# two platforms, the Antioch shuttle's transfer platform and Antioch: tools/qa_metro_tour.js), then 10 minutes of #auto
# with the metro on, following trains (metro and Peninsula) through the camera views. FAILS on any page error or
# console error, on a metro failure (Metro.on false), or on a stop where the walker isn't on the platform.
# Usage: [PORT=8136] [DWELL=11000] [AUTO_MIN=10] sh tools/qa_metro_tour.sh [page] [outdir]     one headless Chrome at a time
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
PAGE=${1:-sim.html}; OUT=${2:-/tmp/bayline-metro-tour}; mkdir -p "$OUT"
BASE="http://localhost:${PORT:-8136}/$PAGE"; DWELL=${DWELL:-11000}; AUTO_MIN=${AUTO_MIN:-10}
fails=0
# 1. the station tour (about 55 stops x (DWELL + 0.7 s))
python3 tools/wd.py 2400 node tools/shot.mjs "$BASE#auto&metro=1&t=08:00" "$OUT/tour.png" --gpu --w 1280 --h 800 --wait 300 \
  --eval "window.__dwell=$DWELL;$(cat tools/qa_metro_tour.js)" > "$OUT/tour.log" 2>&1
grep '^\[eval\]' "$OUT/tour.log" | tail -1 | cut -c8- | python3 -c "
import sys, json
j = json.loads(sys.stdin.read() or '{}')
print('tour:', j.get('stops'), 'stops in', j.get('minutes'), 'min; metro on at the end:', j.get('metroOn'))
for o in j.get('bad', []): print('  BAD STOP', o)
" || true
grep -q '"bad":\[\]' "$OUT/tour.log" && grep -q '"metroOn":true' "$OUT/tour.log" || { echo "FAIL tour: a stop off the platform, or the metro went off"; fails=$((fails+1)); }
if grep -qE '^\[pageerror\]|^\[console\.error\]' "$OUT/tour.log"; then echo "FAIL tour: page or console errors:"; grep -E '^\[pageerror\]|^\[console\.error\]' "$OUT/tour.log" | sort | uniq -c | head -20; fails=$((fails+1)); else echo "PASS tour: no page or console errors"; fi
# 2. #auto with the metro on for AUTO_MIN minutes: every 45 s follow the next train (Tab) through a camera view
AUTO_MS=$((AUTO_MIN * 60000))
CYCLE="(()=>{const B=__bayline,K=(c)=>{window.dispatchEvent(new KeyboardEvent('keydown',{code:c,key:c,bubbles:true}));window.dispatchEvent(new KeyboardEvent('keyup',{code:c,key:c,bubbles:true}));};
  const views=['Digit3','Digit5','Digit4','Digit1','Digit8','Digit3'];let i=0;window.__cyc=setInterval(()=>{K('Tab');setTimeout(()=>K(views[i++%views.length]),800);},45000);
  return new Promise(r=>setTimeout(()=>{clearInterval(window.__cyc);r(JSON.stringify({metroOn:B.Metro.on,failed:B.Metro.failed,frames:B.Env.renderer.info.render.frame,running:B.MetroSim.running.length}));},$AUTO_MS));})()"
python3 tools/wd.py $((AUTO_MIN * 60 + 300)) node tools/shot.mjs "$BASE#auto&metro=1&t=17:30" "$OUT/auto.png" --gpu --w 1280 --h 800 --wait 300 --eval "$CYCLE" > "$OUT/auto.log" 2>&1
grep '^\[eval\]' "$OUT/auto.log" | tail -1 | cut -c1-300
grep -q '"metroOn":true' "$OUT/auto.log" || { echo "FAIL auto: the metro went off"; fails=$((fails+1)); }
if grep -qE '^\[pageerror\]|^\[console\.error\]' "$OUT/auto.log"; then echo "FAIL auto: page or console errors:"; grep -E '^\[pageerror\]|^\[console\.error\]' "$OUT/auto.log" | sort | uniq -c | head -20; fails=$((fails+1)); else echo "PASS auto: $AUTO_MIN min, no page or console errors"; fi
echo "== $fails failed ($OUT: tour.log, auto.log, screenshots)"
[ $fails = 0 ]
