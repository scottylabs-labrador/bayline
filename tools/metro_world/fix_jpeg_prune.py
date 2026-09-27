#!/usr/bin/env python3
"""Keep in the JPEG replacement set only (a) the damaged tiles themselves and (b) mosaic parents whose change is local
(<= 1 % of the 16 px blocks differ by > 2 levels) and visible (a block > 8 levels): a parent that differs broadly was
built from older children and is left alone (its update is a separate decision). Rewrites manifest_<kind>.json and
removes the pruned staged files.
  python3 tools/metro_world/fix_jpeg_prune.py pre|new
"""
import json, os, sys
import numpy as np
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
W = os.path.join(ROOT, 'data', 'raw', 'tiles'); ST = os.path.join(W, 'fix_jpeg'); PUB = os.path.join(ROOT, 'data', 'pub', 'v2')
kind = sys.argv[1]
T = {tuple(t[:3]) for t in json.load(open(os.path.join(W, 'fix_jpeg_targets.json')))}
mp = os.path.join(ST, f'manifest_{kind}.json'); m = json.load(open(mp))
keep, drop = [], []
for f in m['files']:
    L = int(f['path'].split('/')[2]); x, y = map(int, f['path'].split('/')[3][:-4].split('_'))
    if (L, x, y) in T:
        keep.append(f); continue
    a = np.asarray(Image.open(os.path.join(PUB, f['path'])).convert('RGB').resize((512, 512))).astype(np.float32)
    b = np.asarray(Image.open(os.path.join(ST, f['path'])).convert('RGB').resize((512, 512))).astype(np.float32)
    d = np.abs(a - b).reshape(32, 16, 32, 16, 3).mean((1, 3)).max(-1)
    if (d > 2).mean() <= 0.01 and d.max() > 8:
        keep.append(f)
    else:
        drop.append(f['path']); os.remove(os.path.join(ST, f['path']))
m['files'] = keep; json.dump(m, open(mp, 'w'), indent=1)
print(kind, 'kept', len(keep), 'dropped', len(drop), drop[:20])
