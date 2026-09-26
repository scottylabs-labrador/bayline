#!/usr/bin/env python3
"""Find PUBLISHED (pre-Metro) imagery tiles that carry NAIP band-dropout squares: their raw NAIP responses were bad on
Sep 23 and have since been re-fetched clean (tools/metro_world/fix_dropouts.py), so the published tile is compared with
the same tile rendered from the clean raw exactly as the pipeline renders it. A dropout block shows as a large jump in
one channel over a rectangular block; ordinary re-fetch noise is a few levels.

  python3 tools/metro_world/find_published_dropouts.py   -> data/raw/tiles/published_dropouts_v2.json [[L, x, y, maxdiff]]
"""
import json, os, sys
import numpy as np
from PIL import Image
import concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles import common as C, imagery as I   # noqa: E402
import fix_dropouts as FD                      # noqa: E402  (parse, tile_of_bbox)

REF = os.path.getmtime(os.path.join(C.WORK, 'coverage_pre_bart.json'))


def block_jump(a, b, G=16):
    """max over GxG blocks of the per-channel mean |a-b| (a, b float HxWx3 0..255, same size)"""
    n = a.shape[0] // G
    d = np.abs(a[:n * G, :n * G] - b[:n * G, :n * G]).reshape(G, n, G, n, 3).mean((1, 3))
    return float(d.max())


def check(p):
    bb, px, band = FD.parse(p)
    L, tx, ty = FD.tile_of_bbox(bb)
    pub = C.path('img', L, tx, ty, 'jpg')
    if not os.path.exists(pub) or os.path.getmtime(pub) >= REF:
        return None                                  # (not a published tile)
    try:
        d = I.load_hires(L, tx, ty)                  # (reads the clean raw from the cache)
    except Exception:
        return None
    new = I._down(d['rgb'], C.IMG) * 255.0
    old = np.asarray(Image.open(pub).convert('RGB').resize((C.IMG, C.IMG))).astype(np.float32)
    return (L, tx, ty, round(block_jump(new, old), 1))


def main():
    cands = []
    for pxd in os.listdir(os.path.join(C.RAW, 'naip_aar0', 'rgb')):
        d = os.path.join(C.RAW, 'naip_aar0', 'rgb', pxd)
        for f in os.listdir(d):
            p = os.path.join(d, f)
            if os.path.getmtime(p) >= REF:
                cands.append(p)
    print(len(cands), 'raw RGB responses written since the pre-Metro snapshot', flush=True)
    out = []
    with cf.ThreadPoolExecutor(3) as ex:
        for r in ex.map(check, cands):
            if r and r[3] > 30:
                out.append(list(r))
    out.sort()
    json.dump(out, open(os.path.join(C.WORK, 'published_dropouts_v2.json'), 'w'))
    print(len(out), 'published tiles differ blockwise by > 30 levels from their clean raw:', out, flush=True)


if __name__ == '__main__':
    main()
