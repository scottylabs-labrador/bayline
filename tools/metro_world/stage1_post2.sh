#!/bin/sh
# Bayline Metro world, stage 1 after the base bake (continued with fewer workers: the shared machine was swapping):
# waits for the running tree step, then tiles/index.json, towns b2, lidar h9, materials, t2.
cd "$(dirname "$0")/../.." || exit 1
export BAYLINE_STAGE=bart1
L=data/raw/tiles/logs_bart; P=$L/stage1_post.log
while pgrep -f "bake_tiles.py trees" >/dev/null; do sleep 20; done
echo "== index $(date)" >> $P
nice -n 10 python3 tools/bake_tiles.py index >> $L/bake_stage1.log 2>&1 || echo "!! index failed" >> $P
echo "== towns b2 $(date)" >> $P
nice -n 10 python3 tools/bake_towns.py --metro >> $L/towns_b2.log 2>&1 || echo "!! towns b2 failed" >> $P
echo "== lidar bake $(date)" >> $P
nice -n 10 python3 tools/bake_lidar.py bake --workers 3 >> $L/lidar_bake_stage1.log 2>&1 || echo "!! lidar bake failed" >> $P
nice -n 10 python3 tools/bake_lidar.py index >> $L/lidar_bake_stage1.log 2>&1
echo "== materials $(date)" >> $P
nice -n 10 python3 tools/bake_materials.py bake --workers 3 >> $L/mat_stage1.log 2>&1 || echo "!! materials failed" >> $P
nice -n 10 python3 tools/bake_materials.py index >> $L/mat_stage1.log 2>&1
while pgrep -f "stage1_trees_retry" >/dev/null; do sleep 20; done
echo "== t2 $(date)" >> $P
nice -n 10 python3 tools/bake_trees2.py register --workers 3 >> $L/t2_stage1.log 2>&1 || echo "!! t2 register failed" >> $P
nice -n 10 python3 tools/bake_trees2.py bake --workers 3 >> $L/t2_stage1.log 2>&1 || echo "!! t2 bake failed" >> $P
nice -n 10 python3 tools/bake_trees2.py index >> $L/t2_stage1.log 2>&1
echo "== done $(date)" >> $P
