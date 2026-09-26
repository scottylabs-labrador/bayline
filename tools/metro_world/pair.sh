#!/bin/sh
# pair.sh NAME "lat,lon,alt,yaw,pitch" OUTDIR : the same view with metro off and on (one Chrome at a time), + a side-by-side
cd "$(dirname "$0")/../.." || exit 1
N=$1; LL=$2; O=$3; mkdir -p $O
for m in 0 1; do
  python3 tools/wd.py 170 node tools/shot.mjs "http://localhost:8132/world.html#auto&t=12:00&q=high&w=clear&metro=$m&ll=$LL" $O/${N}_m$m.png --gpu --w 1280 --h 720 --wait 55000 --eval2 "document.body.classList.add('photo'); new Promise(r => setTimeout(r, 400))" > /dev/null 2>&1
done
python3 -c "
from PIL import Image
a=Image.open('$O/${N}_m0.png').convert('RGB').resize((800,450)); b=Image.open('$O/${N}_m1.png').convert('RGB').resize((800,450))
W=Image.new('RGB',(1600,450)); W.paste(a,(0,0)); W.paste(b,(800,0)); W.save('$O/${N}_pair.jpg',quality=82)"
rm -f $O/${N}_m0.png $O/${N}_m1.png
