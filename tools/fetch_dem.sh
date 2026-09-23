#!/bin/sh
# Terrarium elevation tiles (AWS Open Data "Terrain Tiles", Mapzen): zoom 11 covering the Peninsula, South Bay and Gilroy.
cd "$(dirname "$0")/../data/raw/dem"
for x in $(seq 326 333); do for y in $(seq 791 797); do
  [ -s "11_${x}_${y}.png" ] || curl -sf -m 60 -o "11_${x}_${y}.png" "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/11/${x}/${y}.png" || echo "fail $x $y"
done; done
ls | wc -l
