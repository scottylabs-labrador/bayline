#!/bin/sh
# Bayline Metro world, stage 1 (bart1 coverage): heights, imagery, masks for every BART corridor + the strip's L2-L5.
# Add-only (nothing that exists is rewritten). Logs: data/raw/tiles/logs_bart/.
cd "$(dirname "$0")/../.." || exit 1
export BAYLINE_STAGE=bart1
L=data/raw/tiles/logs_bart
P=$L/stage1_pipeline.log
while pgrep -f "bake_tiles.py osm" >/dev/null; do sleep 10; done
test -f data/raw/tiles/osm_extract_v3.npz || { echo "no OSM extract" >> $P; exit 1; }
for step in terrarium heights imagery masks; do
  echo "== $step $(date)" >> $P
  python3 tools/bake_tiles.py $step --workers 10 --cpu 5 >> $L/bake_stage1.log 2>&1 || echo "!! $step failed $(date)" >> $P
done
echo "== done $(date)" >> $P
