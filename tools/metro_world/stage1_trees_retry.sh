#!/bin/sh
# re-run the tree crown bake for tiles that failed (the north strip's negative-row seed bug, fixed in trees.py)
cd "$(dirname "$0")/../.." || exit 1
export BAYLINE_STAGE=bart1
L=data/raw/tiles/logs_bart
until grep -q "== index" $L/stage1_post.log 2>/dev/null; do sleep 20; done
echo "== trees retry $(date)" >> $L/stage1_post.log
python3 tools/bake_tiles.py trees --cpu 4 >> $L/trees_retry.log 2>&1
echo "== trees retry done $(date)" >> $L/stage1_post.log
