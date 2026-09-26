#!/bin/sh
# the JPEG replacement set on the GPU, with the staged SR run paused meanwhile (one GPU job at a time)
cd "$(dirname "$0")/../.." || exit 1
L=data/raw/tiles/logs_bart; P=$L/gpu_chain.log
SRP=$(pgrep -f "python3 tools/sr_l8.py" | head -1)
[ -n "$SRP" ] && kill -STOP "$SRP"
trap '[ -n "$SRP" ] && kill -CONT "$SRP"' EXIT INT TERM
echo "== fix_jpeg (sr_l8 $SRP paused) $(date)" >> $P
rm -rf data/raw/tiles/fix_jpeg
python3 tools/metro_world/fix_jpeg.py pre > $L/fix_jpeg_pre.log 2>&1 || echo "!! fix_jpeg pre failed" >> $P
python3 tools/metro_world/fix_jpeg.py new > $L/fix_jpeg_new.log 2>&1 || echo "!! fix_jpeg new failed" >> $P
python3 tools/metro_world/fix_jpeg.py merge >> $L/fix_jpeg_new.log 2>&1
echo "== fix_jpeg done $(date)" >> $P
