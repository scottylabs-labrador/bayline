#!/bin/sh
# Bayline Metro world, stage 1 GPU pass: L9 super-resolution along BART (sr_tiles), then every new L8 to 1024 px (sr_l8).
# Starts once the imagery step of stage1_base.sh is done (the 2048 px NAIP fetches it needs are cached then).
cd "$(dirname "$0")/../.." || exit 1
export BAYLINE_STAGE=bart1
L=data/raw/tiles/logs_bart; P=$L/stage1_gpu.log
until grep -q "== masks" $L/stage1_pipeline.log 2>/dev/null; do sleep 20; done
echo "== sr_tiles $(date)" >> $P
python3 tools/sr_tiles.py >> $L/sr_l9_stage1.log 2>&1 || echo "!! sr_tiles failed" >> $P
echo "== sr_l8 $(date)" >> $P
python3 tools/sr_l8.py >> $L/sr_l8_stage1.log 2>&1 || echo "!! sr_l8 failed" >> $P
echo "== done $(date)" >> $P
