#!/bin/sh
# Bayline Metro world, stage 2: the whole north strip at L6 + L7 (no tile of the strip left to the Globe's ~1.9 m/px).
# Starts once the NAIP prefetch is done and the stage-1 tree retry has started (it must keep the stage-1 coverage).
cd "$(dirname "$0")/../.." || exit 1
L=data/raw/tiles/logs_bart; P=$L/stage2.log
while pgrep -f prefetch_stage2.py >/dev/null; do sleep 30; done
until grep -q "== trees retry" $L/stage1_post.log 2>/dev/null; do sleep 30; done
sleep 60
echo "== coverage bart2 $(date)" >> $P
rm -f data/raw/tiles/coverage.json
BAYLINE_STAGE=bart2 python3 tools/bake_tiles.py coverage >> $L/bake_stage2.log 2>&1 && cp data/raw/tiles/coverage.json data/raw/tiles/coverage_bart2.json
export BAYLINE_STAGE=bart2
for step in terrarium heights imagery; do
  echo "== $step $(date)" >> $P
  nice -n 10 python3 tools/bake_tiles.py $step --workers 6 --cpu 3 >> $L/bake_stage2.log 2>&1 || echo "!! $step failed $(date)" >> $P
done
echo "== masks $(date)" >> $P
nice -n 10 python3 tools/bake_tiles.py masks --workers 4 --cpu 3 >> $L/bake_stage2.log 2>&1 || echo "!! masks failed" >> $P
echo "== index $(date)" >> $P
nice -n 10 python3 tools/bake_tiles.py index >> $L/bake_stage2.log 2>&1 || echo "!! index failed" >> $P
echo "== done $(date)" >> $P
