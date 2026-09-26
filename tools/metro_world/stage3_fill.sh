#!/bin/sh
# Bayline Metro world, stage 3 fill: the L7 tiles whose NAIP fetch was a band dropout at 03:50-04:13 (before the
# bandIds bypass): imagery + masks (add-only: only the missing tiles are made), then the index.
cd "$(dirname "$0")/../.." || exit 1
L=data/raw/tiles/logs_bart; P=$L/stage3.log
export BAYLINE_STAGE=bart3
for step in imagery masks index; do
  echo "== fill $step $(date)" >> $P
  python3 tools/bake_tiles.py $step --workers 3 --cpu 2 >> $L/bake_stage3_fill.log 2>&1 || echo "!! fill $step failed $(date)" >> $P
done
echo "== fill done $(date)" >> $P
