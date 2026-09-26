#!/usr/bin/env python3
"""Re-bake the NEW (unpublished) imagery tiles whose JPEG came out truncated (Pillow 10.1 / libjpeg-turbo 3.0.0: the scan
ends early, Chrome draws the missing MCUs as pure-green 16 px squares; tools/tiles/common.jpeg_bytes now checks every
encode). Input: data/raw/tiles/scan_final.json `green_blocks` (tools/metro_world/scan_final.py). Direct fetches (L5-L7)
are re-made from their cached NAIP fetch, then every new mosaic ancestor, bottom-up. L8 / L9 (GPU) are listed, not
re-made here (delete + tools/sr_l8.py / tools/sr_tiles.py). Published tiles are never touched.

  BAYLINE_STAGE=bart3 python3 tools/metro_world/fix_truncated.py
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles import common as C, imagery as I   # noqa: E402

REF = os.path.getmtime(os.path.join(C.WORK, 'coverage_pre_bart.json'))
MODE = json.load(open(os.path.join(C.WORK, 'img_mode.json')))


def is_new(p):
    return os.path.exists(p) and os.path.getmtime(p) >= REF


def main():
    scan = json.load(open(os.path.join(C.WORK, 'scan_final.json')))
    hits = []
    for name, _n in scan['green_blocks']:
        L, f = name.split('/'); x, y = map(int, f[:-4].split('_')); hits.append((int(L), x, y))
    made, gpu = [], []
    for (L, x, y) in sorted(hits):
        p = C.path('img', L, x, y, 'jpg')
        if not is_new(p):
            print('published tile, not touched here:', L, x, y); continue
        if L >= 8:
            gpu.append((L, x, y)); continue
        mode = 'fetch' if L == 7 else MODE.get(f'{L}/{x}_{y}', 'mosaic')
        if mode == 'mosaic':
            I.bake_mosaic(L, x, y, force=True)
        elif L == 7:
            d = I.load_hires(7, x, y)
            I._save_jpg(p, I._down(d['rgb'], C.IMG))
        else:
            I.bake_direct(L, x, y, force=True)
        made.append((L, x, y)); print('re-made', L, x, y, mode, flush=True)
    todo = {(L - 1, x >> 1, y >> 1) for (L, x, y) in made if L - 1 >= 1}
    n = 0
    while todo:
        L = max(t[0] for t in todo); level = [t for t in todo if t[0] == L]; todo -= set(level)
        for (L, x, y) in level:
            p = C.path('img', L, x, y, 'jpg')
            if not is_new(p) or MODE.get(f'{L}/{x}_{y}', 'mosaic') != 'mosaic' or not I.can_mosaic(L, x, y):
                continue
            I.bake_mosaic(L, x, y, force=True); n += 1; print('re-mosaicked', L, x, y, flush=True)
            if L - 1 >= 1:
                todo.add((L - 1, x >> 1, y >> 1))
    print(f're-made {len(made)} tiles, {n} mosaic parents; GPU tiles to re-make: {gpu}', flush=True)


if __name__ == '__main__':
    main()
