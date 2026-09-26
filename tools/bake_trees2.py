#!/usr/bin/env python3
"""Tree tiles v2 (tiles/t2/7/tx_ty.bin + tiles/t2/index.json): the photo-detected trees with measured canopy heights and
the crowns the photo detector misses (see tools/tiles/trees2.py). Needs data/raw/chm_meta (Meta / WRI canopy height,
CC BY 4.0) and, for the placement checks, tiles/mat (tools/bake_materials.py).

  python3 tools/bake_trees2.py register [--workers 6]      # photo <-> canopy model shift per imagery tile
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
    source is striped by rows, so neighbouring tiles reuse decoded rows). From the coverage (square + north strip)."""
    cov = C.coverage()
    s7 = {tuple(c) for c in cov[7]}
    hills = {(2 * x + dx, 2 * y + dy) for (x, y) in cov[6] for dy in (0, 1) for dx in (0, 1)} - s7
    t = sorted(s7 | hills, key=lambda c: (c[1], c[0]))
    return t[:limit] if limit else t


SHIFTS = os.path.join(C.RAW, 'chm_meta', 'shifts.json')


def _rows(tiles):
    """tiles grouped by row: one row per task, so a worker decodes each canopy-model strip once"""
    rows = {}
    for t in tiles:
        rows.setdefault(t[1], []).append(t)
    return [sorted(r) for _, r in sorted(rows.items())]


def _register_row(row):
    return [(t, T2.register(*t)) for t in row]


def step_register(a):
    old = json.load(open(SHIFTS)) if os.path.exists(SHIFTS) else {}
    # (add-only: tiles registered before keep their shift; only tiles with a t tile and no t2 tile yet are registered)
    tiles = [t for t in l7_tiles(a.limit) if os.path.exists(C.path('t', 7, t[0], t[1], 'bin')) and f'{t[0]}_{t[1]}' not in old
             and not os.path.exists(T2.out_path(*t))]
    C.log(f'trees v2: registering {len(tiles)} imagery tiles against the canopy model ({len(old)} registered before)')
    res = run_pool(_register_row, _rows(tiles), a.workers, 'register', kind='process')
    out = dict(old)
    out.update({f'{t[0]}_{t[1]}': r for row in res for (t, r) in row if r})
    C.write_atomic(SHIFTS, json.dumps(out).encode())
    q = [r for r in out.values() if r['q'] >= 3.0]
    import numpy as np
    C.log(f'registered {len(out)} tiles, {len(q)} confident; median shift dx {np.median([r["dx"] for r in q]):+.1f} m, dz {np.median([r["dz"] for r in q]):+.1f} m')


def shift_for(t, shifts, conf=3.0, reach=4):
    """own shift when confident, else the median of confident tiles within `reach` tiles (then any distance)"""
    own = shifts.get(f'{t[0]}_{t[1]}')
    if own and own['q'] >= conf:
        return (own['dx'], own['dz'])
    near = [(v['dx'], v['dz']) for k, v in shifts.items() if v['q'] >= conf and
            max(abs(int(k.split('_')[0]) - t[0]), abs(int(k.split('_')[1]) - t[1])) <= reach]
    if len(near) < 3:
        near = [(v['dx'], v['dz']) for v in shifts.values() if v['q'] >= conf]
    if not near:
        return (0.0, 0.0)
    import numpy as np
    return (float(np.median([n[0] for n in near])), float(np.median([n[1] for n in near])))


def _bake_row(args):
    row, force, shifts = args
    return [T2.bake_tile(t[0], t[1], force=force, shift=shifts[i]) for i, t in enumerate(row)]


def step_bake(a):
    tiles = l7_tiles(a.limit)
    shifts = json.load(open(SHIFTS)) if os.path.exists(SHIFTS) else {}
    C.log(f'trees v2: {len(tiles)} L7 tiles ({len(shifts)} registered)')
    rows = _rows(tiles)
    res = run_pool(_bake_row, [(r, a.force, [shift_for(t, shifts) for t in r]) for r in rows], a.workers, 'trees2', kind='process')
    st = [x[3] for row in res for x in row if x and x[3]]
    if st:
        C.log(f"trees: {sum(s['old'] for s in st)} detected, {sum(s['measured'] for s in st)} with measured heights, "
              f"{sum(s['added'] for s in st)} added from the canopy height model ({sum(1 for s in st if s['chm'])} tiles with CHM, "
              f"{sum(1 for s in st if s.get('hills'))} tiles of hill forest)")


def step_index(a):
    try:
        prev = json.load(open(os.path.join(C.PUB, 't2', 'index.json')))
    except Exception:
        prev = {}
    have = {(tx, ty) for (tx, ty) in l7_tiles(a.limit) if os.path.exists(T2.out_path(tx, ty))}
    have |= {tuple(t) for t in prev.get('tiles', []) + prev.get('north', [])}          # never drop a published row
    rows = [list(t) for t in sorted((t for t in have if t[1] >= 0), key=lambda c: (c[1], c[0]))]
    north = [list(t) for t in sorted((t for t in have if t[1] < 0), key=lambda c: (c[1], c[0]))]
    out = {'version': 1, 'product': 't2', 'level': 7, 'path': 'tiles/t2/7/{x}_{y}.bin', 'layout': 'as tiles/t (tools/tiles/trees.py)',
           'tiles': rows,
           'attribution': 'Tree heights: Meta and World Resources Institute, Global Canopy Height Map (CC BY 4.0). Crowns: USDA NAIP.'}
    if north:
        out['north'] = north                        # the Bayline Metro north strip (negative rows): new clients only
    p = os.path.join(C.PUB, 't2', 'index.json')
    C.write_atomic(p, json.dumps(out, separators=(',', ':')).encode())
    C.log(f't2 index: {len(rows)} tiles (+ {len(north)} in the north strip) -> {p}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('step', choices=['register', 'bake', 'index', 'all'])
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    if a.step in ('register', 'all'):
        step_register(a)
    if a.step in ('bake', 'all'):
        step_bake(a)
    if a.step in ('index', 'all'):
        step_index(a)
