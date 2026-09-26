#!/bin/sh
# Bayline Metro world, stage 1 after the base bake: trees (t), tiles/index.json, towns b2, lidar h9, materials, t2.
cd "$(dirname "$0")/../.." || exit 1
export BAYLINE_STAGE=bart1
L=data/raw/tiles/logs_bart; P=$L/stage1_post.log
until grep -q "== done" $L/stage1_pipeline.log 2>/dev/null; do sleep 30; done
echo "== trees $(date)" >> $P
python3 tools/bake_tiles.py trees --cpu 5 >> $L/bake_stage1.log 2>&1 || echo "!! trees failed" >> $P
echo "== index $(date)" >> $P
python3 tools/bake_tiles.py index >> $L/bake_stage1.log 2>&1 || echo "!! index failed" >> $P
echo "== towns b2 $(date)" >> $P
while pgrep -f "fetch_osm.py --metro" >/dev/null; do sleep 30; done
test -f data/raw/osm/v3_points.pkl && python3 tools/bake_towns.py --metro >> $L/towns_b2.log 2>&1 || echo "!! towns b2 failed" >> $P
echo "== lidar bake $(date)" >> $P
python3 tools/bake_lidar.py bake --workers 5 >> $L/lidar_bake_stage1.log 2>&1 || echo "!! lidar bake failed" >> $P
python3 tools/bake_lidar.py index >> $L/lidar_bake_stage1.log 2>&1
echo "== materials $(date)" >> $P
python3 tools/bake_materials.py bake --workers 5 >> $L/mat_stage1.log 2>&1 || echo "!! materials failed" >> $P
python3 tools/bake_materials.py index >> $L/mat_stage1.log 2>&1
echo "== t2 $(date)" >> $P
python3 tools/bake_trees2.py register --workers 5 >> $L/t2_stage1.log 2>&1 || echo "!! t2 register failed" >> $P
python3 tools/bake_trees2.py bake --workers 5 >> $L/t2_stage1.log 2>&1 || echo "!! t2 bake failed" >> $P
python3 tools/bake_trees2.py index >> $L/t2_stage1.log 2>&1
echo "== done $(date)" >> $P
