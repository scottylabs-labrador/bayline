#!/bin/sh
# the GPU queue (one job at a time): L9 for the tiles the dropout repair reset, then every L8 still at 512 px
cd "$(dirname "$0")/../.." || exit 1
L=data/raw/tiles/logs_bart; P=$L/gpu_chain.log
export BAYLINE_STAGE=bart3
echo "== sr_tiles $(date)" >> $P
nice -n 5 python3 tools/sr_tiles.py >> $L/sr_l9_chain.log 2>&1 || echo "!! sr_tiles failed" >> $P
echo "== sr_l8 $(date)" >> $P
nice -n 5 python3 tools/sr_l8.py >> $L/sr_l8_chain.log 2>&1 || echo "!! sr_l8 failed" >> $P
echo "== done $(date)" >> $P
