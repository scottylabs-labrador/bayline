#!/usr/bin/env python3
"""Tree tiles v2 (tiles/t2/7/tx_ty.bin + tiles/t2/index.json): the photo-detected trees with measured canopy heights and
the crowns the photo detector misses (see tools/tiles/trees2.py). Needs data/raw/chm_meta (Meta / WRI canopy height,
CC BY 4.0) and, for the placement checks, tiles/mat (tools/bake_materials.py).

  python3 tools/bake_trees2.py bake [--workers 6] [--limit N] [--force]
  python3 tools/bake_trees2.py index                    # publish it last
  python3 tools/bake_trees2.py all
Additive: tiles/t stays as it is; clients without tiles/t2/index.json never ask for t2.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tiles import common as C
from tiles import trees2 as T2
from bake_tiles import run_pool


def l7_tiles(limit=0):
    """the imagery L7 tiles (photo crowns + CHM) and the L7 tiles under L6-only imagery (CHM trees), in row order (the CHM
    source is striped by rows, so neighbouring tiles reuse decoded rows)"""
    lv = json.load(open(os.path.join(C.PUB, 'index.json')))['levels']
    s7 = {tuple(c) for c in lv['7']}
    hills = {(2 * x + dx, 2 * y + dy) for (x, y) in lv['6'] for dy in (0, 1) for dx in (0, 1)} - s7
    t = sorted(s7 | hills, key=lambda c: (c[1], c[0]))
    return t[:limit] if limit else t


def _bake(args):
    t, force = args
    return T2.bake_tile(t[0], t[1], force=force)


def step_bake(a):
    tiles = l7_tiles(a.limit)
    C.log(f'trees v2: {len(tiles)} L7 tiles')
    res = run_pool(_bake, [(t, a.force) for t in tiles], a.workers, 'trees2', kind='process')
    st = [r[3] for r in res if r and r[3]]
    if st:
        C.log(f"trees: {sum(s['old'] for s in st)} detected, {sum(s['measured'] for s in st)} with measured heights, "
              f"{sum(s['added'] for s in st)} added from the canopy height model ({sum(1 for s in st if s['chm'])} tiles with CHM, "
              f"{sum(1 for s in st if s.get('hills'))} tiles of hill forest)")


def step_index(a):
    rows = [[tx, ty] for (tx, ty) in l7_tiles(a.limit) if os.path.exists(T2.out_path(tx, ty))]
    out = {'version': 1, 'product': 't2', 'level': 7, 'path': 'tiles/t2/7/{x}_{y}.bin', 'layout': 'as tiles/t (tools/tiles/trees.py)',
           'tiles': rows,
           'attribution': 'Tree heights: Meta and World Resources Institute, Global Canopy Height Map (CC BY 4.0). Crowns: USDA NAIP.'}
    p = os.path.join(C.PUB, 't2', 'index.json')
    C.write_atomic(p, json.dumps(out, separators=(',', ':')).encode())
    C.log(f't2 index: {len(rows)} tiles -> {p}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('step', choices=['bake', 'index', 'all'])
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    if a.step in ('bake', 'all'):
        step_bake(a)
    if a.step in ('index', 'all'):
        step_index(a)
