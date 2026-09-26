#!/bin/sh
# Bayline Metro frame cost: the same viewpoints with #metro=1 and without (busy spots + the system map open).
# Usage: [PORT=8136] sh tools/qa_metro_perf.sh [page] [outdir]      page defaults to sim.html
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
PAGE=${1:-sim.html}; OUT=${2:-/tmp/bayline-metro-perf}; mkdir -p "$OUT"
BASE="http://localhost:${PORT:-8136}/$PAGE"
PERF='new Promise(r=>{const i=__bayline.Env.renderer.info;let n=0,t0=0,ms=[];function f(now){n++;if(n===30)t0=performance.now();if(n>30)ms.push(now);if(n<150)requestAnimationFrame(f);else{const M=__bayline.MetroSim;r(JSON.stringify({ms:((performance.now()-t0)/120).toFixed(1),calls:i.render.calls,tris:i.render.triangles,metro:M&&M.enabled&&M.ready?{run:M.stats.running,near:M.stats.consists,far:M.stats.far,cpu:M.stats.ms.toFixed(2)}:null}))}}requestAnimationFrame(f)})'
shot() { name=$1; shift; python3 tools/wd.py 150 node tools/shot.mjs "$@" "$OUT/$name.png" --gpu --w 1440 --h 900 2>&1 | grep -E "\[eval\]|pageerror" | tail -1 | sed "s/^/[$name] /" | cut -c1-300; }
EMBR='ll=37.7899,-122.3995,140,0.75,-0.42'; MCAR='ll=37.8262,-122.2688,110,0.35,-0.38'; GLEN='ll=37.7298,-122.4375,60,0.2,-0.25'
for v in "embr_0800:t=08:00&$EMBR" "mcar_1730:t=17:30&$MCAR" "glen_0815:t=08:15&$GLEN"; do
  n=${v%%:*}; h=${v#*:}
  shot "${n}_off" "$BASE#auto&$h" --wait 22000 --eval2 "$PERF"
  shot "${n}_on" "$BASE#auto&metro=1&$h" --wait 22000 --eval2 "$PERF"
done
shot map_open "$BASE#auto&metro=1&t=08:00&mmap=1&$EMBR" --wait 18000 --eval2 "$PERF"
shot map_geo "$BASE#auto&metro=1&t=08:00&mmap=geo&$EMBR" --wait 18000 --eval2 "$PERF"
