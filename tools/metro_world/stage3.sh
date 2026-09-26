#!/bin/sh
# Bayline Metro world, stage 3: L7 over the East Bay hills inside the old square (after stage 2).
cd "$(dirname "$0")/../.." || exit 1
L=data/raw/tiles/logs_bart; P=$L/stage3.log
until grep -q "== done" $L/stage2.log 2>/dev/null; do sleep 30; done
echo "== coverage bart3 $(date)" >> $P
rm -f data/raw/tiles/coverage.json
BAYLINE_STAGE=bart3 python3 tools/bake_tiles.py coverage >> $L/bake_stage3.log 2>&1 && cp data/raw/tiles/coverage.json data/raw/tiles/coverage_bart3.json
export BAYLINE_STAGE=bart3
for step in terrarium heights imagery; do
  echo "== $step $(date)" >> $P
  nice -n 10 python3 tools/bake_tiles.py $step --workers 6 --cpu 3 >> $L/bake_stage3.log 2>&1 || echo "!! $step failed $(date)" >> $P
done
echo "== masks $(date)" >> $P
nice -n 10 python3 tools/bake_tiles.py masks --workers 4 --cpu 3 >> $L/bake_stage3.log 2>&1 || echo "!! masks failed" >> $P
echo "== index $(date)" >> $P
nice -n 10 python3 tools/bake_tiles.py index >> $L/bake_stage3.log 2>&1 || echo "!! index failed" >> $P
echo "== done $(date)" >> $P
