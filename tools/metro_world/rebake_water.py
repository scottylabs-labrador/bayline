#!/usr/bin/env python3
"""Re-bake the NEW (unpublished) imagery tiles whose NAIP fetch has no-data areas (open water) with the Bayline Metro
fill (imagery.WATER_BAY): L7 (+ its L8 children at 512 px, for tools/sr_l8.py; their L9 children are removed for
tools/sr_tiles.py), L5 / L6 direct fetches, then the new mosaic parents. Published tiles are never touched.

  BAYLINE_STAGE=bart3 python3 tools/metro_world/rebake_water.py
"""
import json, os, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools')); sys.path.insert(0, HERE)
from tiles import common as C, imagery as I   # noqa: E402
import fix_dropouts as FD                      # noqa: E402

REF = os.path.getmtime(os.path.join(C.WORK, 'coverage_pre_bart.json'))
MODE = json.load(open(os.path.join(C.WORK, 'img_mode.json')))


def is_new(p):
    return os.path.exists(p) and os.path.getmtime(p) >= REF


def main():
    hits = set()
    for pxd in ('512', '1024', '2048'):
        d = os.path.join(C.RAW, 'naip_aar0', 'rgb', pxd)
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            p = os.path.join(d, f)
            try:
                bb, px, band = FD.parse(p)
                L, tx, ty = FD.tile_of_bbox(bb)
            except Exception:
                continue
            new_here = is_new(C.path('img', L, tx, ty, 'jpg')) or (L == 7 and any(is_new(C.path('img', *c, 'jpg')) for c in C.children(7, tx, ty)))
            if not new_here:
                continue
            im = Image.open(p); im.draft('RGB', (max(64, px // 8), max(64, px // 8)))
            if I.nodata_mask(np.asarray(im.convert('RGB'))).any():
                hits.add((L, tx, ty))
    print(len(hits), 'new tiles with no-data water', sorted(hits)[:20], flush=True)
    made = []
    for (L, x, y) in sorted(hits):
        if L == 7:
            kids = [c for c in C.children(7, x, y) if C.exists(*c)]
            for (_, cx, cy) in kids:
                p8 = C.path('img', 8, cx, cy, 'jpg')
                if os.path.exists(p8) and not is_new(p8):
                    continue                                   # (a published child: leave it)
                for dy in (0, 1):
                    for dx in (0, 1):
                        p9 = C.path('img', 9, cx * 2 + dx, cy * 2 + dy, 'jpg')
                        if is_new(p9):
                            os.remove(p9)
            # force-bake, but keep any published child untouched (add_only protects existing files; delete new ones first)
            for (_, cx, cy) in kids:
                p8 = C.path('img', 8, cx, cy, 'jpg')
                if is_new(p8):
                    os.remove(p8)
            p7 = C.path('img', 7, x, y, 'jpg')
            if is_new(p7):
                os.remove(p7)
            I.bake_L7(x, y, force=False, add_only=True)
            made.append((7, x, y))
        elif L in (5, 6):
            if MODE.get(f'{L}/{x}_{y}', 'direct') == 'direct':
                I.bake_direct(L, x, y, force=True); made.append((L, x, y))
    # new mosaic parents, bottom-up
    todo = {(L - 1, x >> 1, y >> 1) for (L, x, y) in made if L - 1 >= 2}
    n = 0
    while todo:
        L = max(t[0] for t in todo); level = [t for t in todo if t[0] == L]; todo -= set(level)
        for (L, x, y) in level:
            p = C.path('img', L, x, y, 'jpg')
            if L > 6 or not is_new(p) or MODE.get(f'{L}/{x}_{y}', 'mosaic') != 'mosaic' or not I.can_mosaic(L, x, y):
                continue
            I.bake_mosaic(L, x, y, force=True); n += 1
            if L - 1 >= 2:
                todo.add((L - 1, x >> 1, y >> 1))
    print(f're-baked {len(made)} tiles, {n} mosaic parents', flush=True)


if __name__ == '__main__':
    main()
