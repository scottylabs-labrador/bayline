#!/usr/bin/env python3
"""Scan every imagery tile made since the pre-Metro snapshot for NAIP band-dropout squares (tools/tiles/fetch.py rule).
-> data/raw/tiles/new_img_dropouts.json"""
import os, sys, json
import numpy as np
from PIL import Image
import concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles.fetch import rgb_dropout_array
from tiles import common as C
REF = os.path.getmtime(os.path.join(C.WORK, 'coverage_pre_bart.json'))
files = []
for L in range(0, 10):
    d = os.path.join(C.PUB, 'img', str(L))
    if os.path.isdir(d):
        files += [(L, os.path.join(d, f)) for f in os.listdir(d) if f.endswith('.jpg') and os.path.getmtime(os.path.join(d, f)) >= REF]
def one(t):
    im = Image.open(t[1]); im.draft('RGB', (im.size[0] // 2, im.size[1] // 2))
    return rgb_dropout_array(np.asarray(im.convert('RGB')).astype(np.float32))
bad = []
with cf.ThreadPoolExecutor(3) as ex:
    for t, r in zip(files, ex.map(one, files)):
        if r: bad.append([t[0], os.path.basename(t[1])])
json.dump(bad, open(os.path.join(C.WORK, 'new_img_dropouts.json'), 'w'))
print(len(files), 'new img tiles scanned;', len(bad), 'with dropout blocks:', bad[:40], flush=True)
