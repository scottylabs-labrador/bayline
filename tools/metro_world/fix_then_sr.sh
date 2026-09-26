#!/bin/sh
# GPU queue: stage the published-dropout replacements, then resume the L8 super-resolution (full priority)
cd "$(dirname "$0")/../.." || exit 1
L=data/raw/tiles/logs_bart
export BAYLINE_STAGE=bart3
echo "== fix_published $(date)" >> $L/gpu_chain.log
python3 tools/metro_world/fix_published.py > $L/fix_published.log 2>&1 || echo "!! fix_published failed" >> $L/gpu_chain.log
echo "== sr_l8 $(date)" >> $L/gpu_chain.log
python3 tools/sr_l8.py >> $L/sr_l8_chain.log 2>&1 || echo "!! sr_l8 failed" >> $L/gpu_chain.log
echo "== done $(date)" >> $L/gpu_chain.log
