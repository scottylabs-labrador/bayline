#!/usr/bin/env python3
"""Lidar detail heights for the terrain: tiles/h9/{8,9}/tx_ty.bin + tiles/h9/index.json (see tools/tiles/lidar.py).

  python3 tools/bake_lidar.py fetch [--workers 6] [--limit N]    # USGS 3DEP downloads (cached in data/raw/lidar3dep/)
  python3 tools/bake_lidar.py bake  [--workers 8] [--force]       # detail transfer onto the L7 surface
  python3 tools/bake_lidar.py index                               # tiles/h9/index.json (publish it last)
  python3 tools/bake_lidar.py all

Coverage = every L8 tile of the imagery coverage (data/raw/tiles/coverage.json: the corridor, landmarks, San Francisco,
the East Bay shore, every BART corridor and the north strip). Additive: nothing under tiles/h (the existing L0-L7
heights) is touched, and clients without h9/index.json ignore the layer.
Add-only: the L8 tiles of the h9 index as it was before Bayline Metro (frozen in data/raw/lidar3dep/old_l8.json on the
first run) are never recomputed (their pass-1 detail grids are gone); new tiles fade their detail to zero toward them,
exactly as they faded toward "no lidar" there, so every shared edge still matches. North-strip rows go to `l8n`.
"""
import argparse, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tiles import common as C
from tiles import lidar as LD
from bake_tiles import run_pool


def l8_tiles(limit=0):
    t = [tuple(c) for c in C.coverage()[8]]
    return t[:limit] if limit else t


def new_l8_tiles(limit=0):
    old = LD.old_l8()
    t = [c for c in l8_tiles() if c not in old]
    return t[:limit] if limit else t


def step_fetch(a):
    tiles = [t for t in new_l8_tiles(a.limit) if not os.path.exists(LD.cache_path(*t))]
    tiles.sort(key=lambda t: (-int(t[1] < 0), t[1], t[0]))              # the north strip first
    C.log(f'lidar fetch: {len(tiles)} L8 tiles to download')
    run_pool(lambda t: LD.fetch_l8(*t).shape, tiles, a.workers, 'lidar fetch')


def _bake9(args):
    t, force = args
    return LD.bake_l9(t[0], t[1], force=force)


def _bake8(args):
    t, force = args
    return LD.bake_l8(t[0], t[1], force=force)


def step_bake(a):
    tiles = [t for t in new_l8_tiles(a.limit) if os.path.exists(LD.cache_path(*t))]
    C.log(f'lidar bake: {len(tiles)} L8 tiles (pass 1: L9 + detail, pass 2: L8)')
    res = run_pool(_bake9, [(t, a.force) for t in tiles], a.workers, 'lidar L9', kind='process')
    sd = [r[3]['det_sd'] for r in res if r and r[3]]
    if sd:
        import numpy as np
        C.log(f'detail sd: median {np.median(sd):.3f} m, p95 {np.percentile(sd, 95):.3f} m')
    run_pool(_bake8, [(t, a.force) for t in tiles], a.workers, 'lidar L8', kind='process')


def step_index(a):
    prev = {}
    try:
        prev = json.load(open(os.path.join(C.PUB, 'h9', 'index.json')))
    except Exception:
        pass
    old_rows = {(r[0], r[1]): r for r in (prev.get('l8') or []) + (prev.get('l8n') or [])}
    old = LD.old_l8()
    rows = []
    for (tx, ty) in l8_tiles(a.limit):
        if (tx, ty) in old:
            if (tx, ty) in old_rows:
                rows.append(old_rows[(tx, ty)])                  # exactly as published before
            continue
        if not (os.path.exists(LD.out_path(8, tx, ty)) and os.path.exists(LD.meta_path(tx, ty))):
            continue
        mask, o = json.load(open(LD.meta_path(tx, ty)))
        for dy in (0, 1):
            for dx in (0, 1):
                assert bool(mask & (1 << (dy * 2 + dx))) == os.path.exists(LD.out_path(9, tx * 2 + dx, ty * 2 + dy)), (tx, ty, mask)
        rows.append([tx, ty, mask, o])
    # every old row must survive
    have = {(r[0], r[1]) for r in rows}
    for k, r in old_rows.items():
        if k not in have:
            rows.append(r)
    sq = [r for r in rows if r[1] >= 0]; nt = [r for r in rows if r[1] < 0]
    out = {'version': 1, 'product': 'h9', 'levels': [8, 9], 'n': 129, 'path': 'tiles/h9/{L}/{x}_{y}.bin',
           'q': {'scale': LD.QS}, 'codec': 'as tiles/h (uint16 q, MED-predicted zigzag residuals, LE, zlib) with h = q / scale + o, o per l8 row',
           'l8': sq, 'l8row': ["x", "y", "childMask (bit dy*2+dx: that L9 child exists)", "o (m)"],
           'method': 'existing L7 surface + USGS 3DEP lidar detail (lidar minus its L7-scale low-pass), faded out on the track bed, station zones and water',
           'attribution': 'Elevation detail: USGS 3D Elevation Program (3DEP) 1 m lidar DEM (public domain).'}
    if nt:
        out['l8n'] = nt                                          # the north strip (negative rows): new clients only
    p = os.path.join(C.PUB, 'h9', 'index.json')
    C.write_atomic(p, json.dumps(out, separators=(',', ':')).encode())
    n9 = sum(bin(r[2]).count('1') for r in rows)
    C.log(f'h9 index: {len(sq)} L8 tiles (+ {len(nt)} in the north strip), {n9} L9 tiles -> {p}')


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
