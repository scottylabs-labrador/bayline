#!/bin/sh
# second repair pass for the RGB dropouts that survived re-fetching (quadrant stitch), after the first pass finishes
cd "$(dirname "$0")/../.." || exit 1
L=data/raw/tiles/logs_bart
while pgrep -f "tools/metro_world/fix_dropouts.py" >/dev/null; do sleep 20; done
echo "== pass 2 $(date)" >> $L/fix_dropouts.log
nice -n 5 python3 tools/metro_world/fix_dropouts.py --rgb-only >> $L/fix_dropouts.log 2>&1
echo "== pass 2 done $(date)" >> $L/fix_dropouts.log
