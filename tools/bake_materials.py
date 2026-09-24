#!/usr/bin/env python3
"""Ground material tiles: tiles/mat/7/tx_ty.bin + tiles/mat/index.json (see tools/tiles/materials.py).

  python3 tools/bake_materials.py bake [--workers 8] [--limit N] [--force]
  python3 tools/bake_materials.py index                  # publish it last
  python3 tools/bake_materials.py all

Coverage = every L7 tile of the imagery index. Additive: clients without tiles/mat/index.json never ask for it.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tiles import common as C
from tiles import materials as MT
from bake_tiles import run_pool


def l7_tiles(limit=0):
    t = [tuple(c) for c in json.load(open(os.path.join(C.PUB, 'index.json')))['levels']['7']]
    return t[:limit] if limit else t


def _bake(args):
    t, force = args
    return MT.bake_tile(t[0], t[1], force=force)


def step_bake(a):
    tiles = l7_tiles(a.limit)
    C.log(f'materials: {len(tiles)} L7 tiles')
    res = run_pool(_bake, [(t, a.force) for t in tiles], a.workers, 'materials', kind='process')
    tot = [0] * 16
    for r in res:
        if r and r[2] == 'ok':
            tot = [x + y for x, y in zip(tot, r[3])]
    s = sum(tot) or 1
    C.log('classes: ' + ', '.join(f'{MT.NAMES[i]} {100 * tot[i] / s:.1f}%' for i in range(16) if tot[i]))


def step_index(a):
    rows = [[tx, ty] for (tx, ty) in l7_tiles(a.limit) if os.path.exists(MT.out_path(tx, ty))]
    out = {'version': 1, 'product': 'mat', 'level': 7, 'n': MT.N, 'cell': MT.CELL, 'path': 'tiles/mat/7/{x}_{y}.bin',
           'layout': 'n x n uint8 class ids, cell (i,j) centred at x0+(i+0.5)*cell, z0+(j+0.5)*cell, row-major, zlib',
           'classes': MT.NAMES, 'tiles': rows,
           'attribution': 'Classified from USDA NAIP imagery (RGB + NIR) and OpenStreetMap (ODbL).'}
    p = os.path.join(C.PUB, 'mat', 'index.json')
    C.write_atomic(p, json.dumps(out, separators=(',', ':')).encode())
    C.log(f'mat index: {len(rows)} tiles -> {p}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('step', choices=['bake', 'index', 'all'])
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    if a.step in ('bake', 'all'):
        step_bake(a)
    if a.step in ('index', 'all'):
        step_index(a)
