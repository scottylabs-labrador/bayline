#!/bin/sh
# Bayline Metro failure isolation (M3 gate item 4). Every metro part is broken on purpose (#metrofail=..., 18_metro.js)
# at a view full of metro; each run must end with the metro off, exactly one console warning ("Bayline Metro is off for
# this session: ..."), no page or console errors, nothing metro left in the scene, and the game running (frames advancing).
# Also: time to the first frame with the metro on vs off (the metro loads after the first frame).
# Usage: [PORT=8136] sh tools/qa_metro_isolation.sh [page] [outdir]     page defaults to sim.html; one headless Chrome at a time
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
PAGE=${1:-sim.html}; OUT=${2:-/tmp/bayline-metro-isolation}; mkdir -p "$OUT"
BASE="http://localhost:${PORT:-8136}/$PAGE"
VIEW='t=10:30&ll=37.8062,-122.2940,420,1.9,-0.34'           # West Oakland: the aerial guideway, the station, trains
STATE='new Promise(r=>setTimeout(r,26000)).then(()=>{const B=__bayline,M=B.Metro,S=B.MetroSim,T=B.MetroTrack,ST=B.MetroStations,f0=B.Env.renderer.info.render.frame;
  return new Promise(r=>setTimeout(r,1500)).then(()=>JSON.stringify({on:M.on,failed:M.failed&&M.failed.where,running:S?S.running.length:0,
  track:!!(T&&T.group&&T.group.parent),stations:!!(ST&&ST.group&&ST.group.parent),frames:B.Env.renderer.info.render.frame-f0,ff:Math.round(window.__baylineFirstFrameMs||0),mode:B.Player.mode}))})'
fails=0
run() {   # name, hash, expect ("off" | "on")
  name=$1; h=$2; want=$3
  python3 tools/wd.py 150 node tools/shot.mjs "$BASE#auto&$h" "$OUT/$name.png" --gpu --w 1280 --h 800 --wait 300 --eval "$STATE" > "$OUT/$name.log" 2>&1
  st=$(grep '^\[eval\]' "$OUT/$name.log" | tail -1 | cut -c8-)
  nw=$(grep -c 'Bayline Metro is off' "$OUT/$name.log"); ne=$(grep -cE '^\[console\.error\]|^\[pageerror\]' "$OUT/$name.log")
  ok=1
  case "$want" in
    off) echo "$st" | grep -q '"on":false' || ok=0; echo "$st" | grep -q '"track":false,"stations":false' || ok=0; [ "$nw" = 1 ] || ok=0;;
    on)  echo "$st" | grep -q '"on":true' || ok=0; [ "$nw" = 0 ] || ok=0;;
    none) echo "$st" | grep -q '"on":false' || ok=0; [ "$nw" = 0 ] || ok=0;;
  esac
  [ "$ne" = 0 ] || ok=0; echo "$st" | grep -qE '"frames":[1-9]' || ok=0
  [ $ok = 1 ] && r=PASS || { r=FAIL; fails=$((fails+1)); }
  echo "$r $name  warnings=$nw errors=$ne  $st"
}
run metro_off     "metro=0&$VIEW" none
run metro_on      "metro=1&$VIEW" on
for f in net tracks tt build stations kit sim ground under; do run "fail_$f" "metro=1&metrofail=$f&$VIEW" off; done
echo "== $fails failed; screenshots and logs in $OUT"
[ $fails = 0 ]
