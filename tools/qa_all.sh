#!/bin/sh
# Bayline QA suite: views, gameplay flows and frame cost. Needs the dev server (tools/devserver.py) running.
# Usage: [PORT=8123] [METRO=1|0] sh tools/qa_all.sh [page] [outdir]      page defaults to lead.html (tools/devbuild.sh output)
#   METRO=1 / METRO=0 appends #metro=1 / #metro=0 to every view (Bayline Metro on / off); unset: the page's default
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
PAGE=${1:-lead.html}; OUT=${2:-/tmp/bayline-qa}; mkdir -p "$OUT"
BASE="http://localhost:${PORT:-8123}/$PAGE"     # PORT=8124 sh tools/qa_all.sh ... against a second dev server
MQ=""; [ "${METRO:-}" = 1 ] && MQ="&metro=1"; [ "${METRO:-}" = 0 ] && MQ="&metro=0"
[ -n "$MQ" ] && echo "== with #${MQ#&}"
W='new Promise(r=>{const f=()=>window.__bayline&&window.__bayline.Sim.TT?r():setTimeout(f,200);f();}).then(()=>'
PERF='new Promise(r=>{const i=__bayline.Env.renderer.info;let n=0,t0=performance.now();function f(){n++;if(n<90)requestAnimationFrame(f);else r(JSON.stringify({ms:((performance.now()-t0)/n).toFixed(1),calls:i.render.calls,tris:i.render.triangles,stream:{req:Stream_stats()}}))}requestAnimationFrame(f)})'
PERF=$(echo "$PERF" | sed 's/Stream_stats()/0/')
shot() { name=$1; shift; node tools/shot.mjs "$@" "$OUT/$name.png" --gpu --w 1440 --h 900 2>&1 | grep -E "\[eval\]|error|Error" | sed "s/^/[$name] /" | cut -c1-400; }
echo "== views"
shot pa_orbit_morning "$BASE#auto$MQ&t=08:10&at=palo_alto&cam=orbit&dist=380" --wait 20000 --eval2 "$PERF"
shot pa_platform "$BASE#auto$MQ&t=17:35&at=palo_alto" --wait 20000 --eval2 "$PERF"
shot sf_golden "$BASE#auto$MQ&t=18:50&at=san_francisco&cam=orbit&dist=900" --wait 22000 --eval2 "$PERF"
shot hillsdale_noon "$BASE#auto$MQ&t=12:30&at=hillsdale&cam=orbit&dist=450" --wait 20000
shot sj_dusk "$BASE#auto$MQ&t=19:05&at=sj_diridon&cam=orbit&dist=420" --wait 20000
shot burlingame_night "$BASE#auto$MQ&t=21:15&at=burlingame" --wait 20000
shot gilroy_evening "$BASE#auto$MQ&t=18:10&at=gilroy&cam=orbit&dist=500" --wait 20000
shot sfo_flyover "$BASE#auto$MQ&t=09:30&cam=fly" --wait 22000 --eval "${W}{const P=__bayline.Player; P.fly.x=-24000; P.fly.z=-25500; P.fly.y=900; P.look.yaw=2.4; P.look.pitch=-0.3; return 1})" --eval2 "$PERF"
shot stanford_aerial "$BASE#auto$MQ&t=16:40&cam=fly" --wait 22000 --eval "${W}{const P=__bayline.Player; P.fly.x=-6500; P.fly.z=-2600; P.fly.y=450; P.look.yaw=3.6; P.look.pitch=-0.35; return 1})"
echo "== drive (keyboard only)"
shot drive_qa "$BASE#auto$MQ&t=08:00" --wait 80000 --eval "$(cat tools/qa_drive.js)" --eval2 "JSON.stringify({events: window.__qa.events, maxMph: Math.round(window.__qa.maxV/0.44704), run: __bayline.Game.run && {k: __bayline.Game.run.k, score: Math.round(__bayline.Game.run.score), log: __bayline.Game.run.log.filter(l=>l[2]).map(l=>l[2])}})"
echo "== ride flow"
shot ride_qa "$BASE#auto$MQ&t=08:00" --wait 50000 --eval "${W}{const B=__bayline; B.UI.openBoard(15); document.querySelector('#bbody tr[data-i]').click(); B.Env.time.scale=4; window.__rt=setInterval(()=>{const P=B.Player; if(P.mode==='walk'){const tr=B.Sim.running.find(t=>t.key===P.focus); if(tr&&tr.doorsOpen&&tr.doorWorld&&tr.doorWorld.length){const d=tr.doorWorld[Math.floor(tr.doorWorld.length/2)]; P.walk.x=d.x; P.walk.z=d.z; setTimeout(()=>{window.__boarded=P.interact();},300);}}},1000); return 1})" --eval2 "(()=>{const B=__bayline; clearInterval(window.__rt); const tr=B.Player.focusTrain(); return JSON.stringify({boarded:window.__boarded, mode:B.Player.mode, trip:tr&&tr.trip.id, v:tr&&Math.round(tr.v), car:B.Player.ob.car})})()"
echo "== done: $OUT"
