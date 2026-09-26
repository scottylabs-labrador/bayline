#!/usr/bin/env python3
"""Prefetch the NAIP downloads of stage 2 (every north-strip L7 tile not in the current coverage: 1024 px RGB + NIR,
the exact requests tools/tiles/imagery.load_hires makes), so the stage-2 bake finds them in data/raw/naip_aar0."""
import os, sys, time
import concurrent.futures as cf
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from tiles import common as C, fetch

have = set(C.coverage()[7])
todo = [t for t in C.north_tiles(7) if t not in have]
print(len(todo), 'strip L7 tiles to prefetch', flush=True)
t0 = time.time(); done = 0
def one(t):
    bb = C.bbox_ll(7, *t)
    fetch.naip(bb, 1024, 'rgb'); fetch.naip(bb, 1024, 'nir')
with cf.ThreadPoolExecutor(8) as ex:
    for f in cf.as_completed([ex.submit(one, t) for t in todo]):
        done += 1
        try: f.result()
        except Exception as e: print('ERROR', e, flush=True)
        if done % 100 == 0: print(done, f'{time.time() - t0:.0f}s', fetch.stats(), flush=True)
print('done', done, f'{time.time() - t0:.0f}s', fetch.stats(), flush=True)
