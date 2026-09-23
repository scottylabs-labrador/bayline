#!/usr/bin/env python3
"""Bayline v2 photoreal tile pyramid -> data/pub/v2/tiles/ (see SPEC_v2.md and notes/tiles.md).

  python3 tools/bake_tiles.py all [--region pa] [--workers 10]      # everything, resumable
  python3 tools/bake_tiles.py coverage | osm | terrarium | heights | imagery | masks | trees | index [--region pa]
  --force-coarse   re-derive L0-L4 (and L5/L6 mosaics) from children even if they exist (after a --region run)

Every raw download is cached under data/raw/ (naip/, terrarium/, osm_pbf/), every product is written
atomically, and existing products are skipped, so the bake can be interrupted (Ctrl-C) and re-run.
Sources: USDA NAIP via USGS The National Map (public domain), AWS Terrain Tiles, OpenStreetMap (ODbL).
"""
import argparse, json, os, signal, sys, time, traceback
import concurrent.futures as cf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tiles import common as C
from tiles import fetch

MODE_FILE = os.path.join(C.WORK, 'img_mode.json')


def scope(L, region):
    f = C.region_filter(region)
    return [(tx, ty) for (tx, ty) in C.level_tiles(L) if f(L, tx, ty)]


def run_pool(fn, items, workers, label, kind='thread'):
    """Run fn(item) over items; logs progress; returns list of results (exceptions logged)."""
    if not items:
        return []
    t0 = time.time()
    Ex = cf.ThreadPoolExecutor if kind == 'thread' else cf.ProcessPoolExecutor
    done = 0; errs = 0; res = []
    ex = Ex(max_workers=workers)
    try:
        futs = {ex.submit(fn, it): it for it in items}
        for fu in cf.as_completed(futs):
            done += 1
            try:
                res.append(fu.result())
            except Exception as e:
                errs += 1
                C.log(f'{label}: ERROR on {futs[fu]}: {e!r}')
                if errs < 4:
                    traceback.print_exc()
            if done % 25 == 0 or done == len(items):
                el = time.time() - t0
                C.log(f'{label}: {done}/{len(items)}  ({errs} errors)  {el:.0f}s elapsed, ~{el / done * (len(items) - done):.0f}s left  net={fetch.stats()}')
    except KeyboardInterrupt:
        fetch.STOP.set()
        ex.shutdown(wait=False, cancel_futures=True)
        raise
    ex.shutdown(wait=True)
    return res


# ------------------------------------------------------------------ steps
def step_coverage(a):
    cov = C.coverage()
    for L in range(9):
        C.log(f'L{L}: {len(C.level_tiles(L))} tiles')
    return cov


def step_osm(a):
    from tiles import osmdata
    if os.path.exists(osmdata.OUT) and not a.force:
        C.log('osm extract exists:', osmdata.OUT)
        return
    osmdata.extract()


ZMAP = {8: 8, 0: 8, 1: 9, 2: 10, 3: 11, 4: 12, 5: 13, 6: 15, 7: 15}


def step_terrarium(a):
    from tiles import heights as H
    need = set()
    for L in range(0, 8):
        tiles = scope(L, a.region)
        if L <= 4 and not a.region:
            continue          # decimated from L5
        need |= H.terrarium_tiles_for(L, tiles, ZMAP[L])
    need = sorted(need)
    C.log(f'terrarium tiles needed: {len(need)}')
    run_pool(lambda k: fetch.terrarium(*k) and None, need, 24, 'terrarium')


def _heights_direct(L, tx, ty):
    from tiles import heights as H
    import numpy as np
    p = C.path('h', L, tx, ty, 'bin')
    X, Z = H.grid(L, tx, ty)
    lat, lon = C.w2ll(X, Z)
    Hh = H.sample(ZMAP[L], lat, lon).astype(np.float32)
    H.carve(Hh, X, Z)
    C.write_atomic(p, H.encode(Hh))
    return 'direct'


def step_heights(a):
    from tiles import heights as H
    for L in (7, 6, 5):
        items = scope(L, a.region)
        run_pool(lambda t, L=L: H.bake_tile(L, *t, force=a.force), items, a.workers, f'heights L{L}')
    for L in (4, 3, 2, 1, 0):
        items = scope(L, a.region)
        if a.region:
            todo = [t for t in items if not os.path.exists(C.path('h', L, *t, 'bin'))]
            run_pool(lambda t, L=L: _heights_direct(L, *t), todo, a.workers, f'heights L{L} (direct, region)')
        else:
            run_pool(lambda t, L=L: H.bake_tile(L, *t, force=a.force or a.force_coarse), items, a.workers, f'heights L{L}')


def _load_mode():
    try:
        return json.load(open(MODE_FILE))
    except Exception:
        return {}


def _save_mode(m):
    os.makedirs(os.path.dirname(MODE_FILE), exist_ok=True)
    tmp = MODE_FILE + '.tmp'
    json.dump(m, open(tmp, 'w'))
    os.replace(tmp, MODE_FILE)


def step_imagery(a):
    from tiles import imagery as I
    mode = _load_mode()
    # L7 (+ L8 children)
    items = scope(7, a.region)
    items.sort(key=lambda t: -int(any(C.exists(*c) for c in C.children(7, *t))))     # tiles with L8 first
    run_pool(lambda t: I.bake_L7(*t, force=a.force), items, a.workers, 'imagery L7+L8')
    for L in (6, 5, 4, 3, 2, 1, 0):
        items = scope(L, a.region)
        def one(t, L=L):
            k = f'{L}/{t[0]}_{t[1]}'
            want = 'mosaic' if (L <= 4 or not I.needs_direct(L, *t)) and I.can_mosaic(L, *t) else 'direct'
            p = C.path('img', L, *t, 'jpg')
            if os.path.exists(p) and mode.get(k, want) == want and not a.force:
                return None
            if want == 'mosaic':
                I.bake_mosaic(L, *t, force=True)
            else:
                I.bake_direct(L, *t, force=True)
            mode[k] = want
            return k
        run_pool(one, items, a.workers, f'imagery L{L}')
        _save_mode(mode)


def _mask_one(args):
    L, tx, ty, force, pooled = args
    from tiles import masks as M
    return M.bake_tile(L, tx, ty, force=force, pooled=pooled)


def step_masks(a):
    from tiles import masks as M
    mode = _load_mode()
    for L in (7, 6, 5, 4, 3, 2, 1, 0):
        items = scope(L, a.region)
        jobs = []
        for t in items:
            if L == 7:
                pooled = False
            else:
                kids = C.children(L, *t)
                pooled = all(C.exists(*c) for c in kids) and all(os.path.exists(C.path('m', *c, 'bin')) for c in kids)
            k = f'm{L}/{t[0]}_{t[1]}'
            want = 'pool' if pooled else 'direct'
            p = C.path('m', L, *t, 'bin')
            force = a.force or (os.path.exists(p) and mode.get(k, want) != want)
            if os.path.exists(p) and not force:
                continue
            mode[k] = want
            jobs.append((L, t[0], t[1], True, pooled))
        kind = 'process' if len(jobs) > 40 else 'thread'
        run_pool(_mask_one, jobs, a.cpu if kind == 'process' else min(a.workers, 6), f'masks L{L}', kind=kind)
        _save_mode(mode)


def _tree_one(t):
    from tiles import trees as TR
    return TR.bake_tile(*t)


def step_trees(a):
    items = [t for t in scope(7, a.region) if a.force or not os.path.exists(C.path('t', 7, *t, 'bin'))]
    kind = 'process' if len(items) > 40 else 'thread'
    res = run_pool(_tree_one, items, a.cpu if kind == 'process' else 6, 'trees L7', kind=kind)
    n = sum(r for r in res if isinstance(r, int))
    C.log(f'trees: {n} crowns in {len(items)} tiles')


def step_index(a):
    cov = C.coverage()
    def have(prod, L, ext):
        return sorted([list(t) for t in C.level_tiles(L) if os.path.exists(C.path(prod, L, *t, ext))], key=lambda c: (c[1], c[0]))
    idx = {
        'version': 2,
        'world': {'X0': C.X0, 'Z0': C.Z0, 'SIZE': C.SIZE, 'levels': 9},
        'levels': {str(L): [list(t) for t in cov[L]] for L in (6, 7, 8)},
        'products': {
            'img': {'levels': [0, 8], 'size': C.IMG, 'ext': 'jpg', 'path': 'tiles/img/{L}/{x}_{y}.jpg'},
            'h': {'levels': [0, 7], 'n': C.HN, 'path': 'tiles/h/{L}/{x}_{y}.bin', 'q': 'round((h+200)*16) uint16, MED zigzag residuals LE interleaved, zlib'},
            'm': {'levels': [0, 7], 'n': C.MN, 'path': 'tiles/m/{L}/{x}_{y}.bin', 'channels': 'R water, G night lights, B canopy, A landcover'},
            't': {'levels': [7, 7], 'path': 'tiles/t/7/{x}_{y}.bin', 'record': 'u16 x, u16 z, u8 r(0.1m), u8 h(0.25m), u8 kind, u8 tint'},
        },
        'present': {p: {str(L): len(have(p, L, e)) for L in range(0, 9)} for p, e in (('img', 'jpg'), ('h', 'bin'), ('m', 'bin'), ('t', 'bin'))},
        'attribution': 'Imagery: USDA NAIP via USGS The National Map (public domain). Elevation: AWS Terrain Tiles (Mapzen; USGS 3DEP, NOAA and others). Map data (c) OpenStreetMap contributors, ODbL.',
    }
    if a.region:
        idx['partial'] = a.region
    C.write_atomic(os.path.join(C.PUB, 'index.json'), json.dumps(idx, separators=(',', ':')).encode())
    C.log('index.json written;', {p: sum(v.values()) for p, v in idx['present'].items()})


STEPS = {'coverage': step_coverage, 'osm': step_osm, 'terrarium': step_terrarium, 'heights': step_heights, 'imagery': step_imagery,
         'masks': step_masks, 'trees': step_trees, 'index': step_index}
ALL = ['coverage', 'osm', 'terrarium', 'heights', 'imagery', 'masks', 'trees', 'index']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('step', choices=list(STEPS) + ['all'])
    ap.add_argument('--region', default=None, choices=[None] + list(C.REGIONS))
    ap.add_argument('--workers', type=int, default=10)
    ap.add_argument('--cpu', type=int, default=max(2, (os.cpu_count() or 4) - 1))
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--force-coarse', action='store_true')
    a = ap.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: (fetch.STOP.set(), sys.exit(1)))
    steps = ALL if a.step == 'all' else [a.step]
    try:
        for s in steps:
            C.log(f'==== {s} (region={a.region})')
            STEPS[s](a)
    except KeyboardInterrupt:
        fetch.STOP.set()
        C.log('interrupted; re-run to resume')
        sys.exit(130)


if __name__ == '__main__':
    main()
