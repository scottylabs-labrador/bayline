#!/usr/bin/env python3
"""Lidar detail heights for the terrain: tiles/h9/{8,9}/tx_ty.bin + tiles/h9/index.json (see tools/tiles/lidar.py).

  python3 tools/bake_lidar.py fetch [--workers 6] [--limit N]    # USGS 3DEP downloads (cached in data/raw/lidar3dep/)
  python3 tools/bake_lidar.py bake  [--workers 8] [--force]       # detail transfer onto the L7 surface
  python3 tools/bake_lidar.py index                               # tiles/h9/index.json (publish it last)
  python3 tools/bake_lidar.py all

Coverage = every L8 tile of the imagery index (the corridor, landmarks, San Francisco, the East Bay shore). Additive:
nothing under tiles/h (the existing L0-L7 heights) is touched, and clients without h9/index.json ignore the layer.
"""
import argparse, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tiles import common as C
from tiles import lidar as LD
from bake_tiles import run_pool


def l8_tiles(limit=0):
    idx = json.load(open(os.path.join(C.PUB, 'index.json')))
    t = [tuple(c) for c in idx['levels']['8']]
    return t[:limit] if limit else t


def step_fetch(a):
    tiles = [t for t in l8_tiles(a.limit) if not os.path.exists(LD.cache_path(*t))]
    C.log(f'lidar fetch: {len(tiles)} L8 tiles to download')
    run_pool(lambda t: LD.fetch_l8(*t).shape, tiles, a.workers, 'lidar fetch')


def _bake9(args):
    t, force = args
    return LD.bake_l9(t[0], t[1], force=force)


def _bake8(args):
    t, force = args
    return LD.bake_l8(t[0], t[1], force=force)


def step_bake(a):
    tiles = [t for t in l8_tiles(a.limit) if os.path.exists(LD.cache_path(*t))]
    C.log(f'lidar bake: {len(tiles)} L8 tiles (pass 1: L9 + detail, pass 2: L8)')
    res = run_pool(_bake9, [(t, a.force) for t in tiles], a.workers, 'lidar L9', kind='process')
    sd = [r[3]['det_sd'] for r in res if r and r[3]]
    if sd:
        import numpy as np
        C.log(f'detail sd: median {np.median(sd):.3f} m, p95 {np.percentile(sd, 95):.3f} m')
    run_pool(_bake8, [(t, a.force) for t in tiles], a.workers, 'lidar L8', kind='process')


def step_index(a):
    rows = []
    for (tx, ty) in l8_tiles(a.limit):
        if not (os.path.exists(LD.out_path(8, tx, ty)) and os.path.exists(LD.meta_path(tx, ty))):
            continue
        mask, o = json.load(open(LD.meta_path(tx, ty)))
        for dy in (0, 1):
            for dx in (0, 1):
                assert bool(mask & (1 << (dy * 2 + dx))) == os.path.exists(LD.out_path(9, tx * 2 + dx, ty * 2 + dy)), (tx, ty, mask)
        rows.append([tx, ty, mask, o])
    out = {'version': 1, 'product': 'h9', 'levels': [8, 9], 'n': 129, 'path': 'tiles/h9/{L}/{x}_{y}.bin',
           'q': {'scale': LD.QS}, 'codec': 'as tiles/h (uint16 q, MED-predicted zigzag residuals, LE, zlib) with h = q / scale + o, o per l8 row',
           'l8': rows, 'l8row': ["x", "y", "childMask (bit dy*2+dx: that L9 child exists)", "o (m)"],
           'method': 'existing L7 surface + USGS 3DEP lidar detail (lidar minus its L7-scale low-pass), faded out on the track bed, station zones and water',
           'attribution': 'Elevation detail: USGS 3D Elevation Program (3DEP) 1 m lidar DEM (public domain).'}
    p = os.path.join(C.PUB, 'h9', 'index.json')
    C.write_atomic(p, json.dumps(out, separators=(',', ':')).encode())
    n9 = sum(bin(r[2]).count('1') for r in rows)
    C.log(f'h9 index: {len(rows)} L8 tiles, {n9} L9 tiles -> {p}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('step', choices=['fetch', 'bake', 'index', 'all'])
    ap.add_argument('--workers', type=int, default=0)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    if a.step in ('fetch', 'all'):
        a.workers = a.workers or 6; step_fetch(a)
    if a.step in ('bake', 'all'):
        a.workers = a.workers or 8; step_bake(a)
    if a.step in ('index', 'all'):
        step_index(a)
