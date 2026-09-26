#!/usr/bin/env python3
"""Final scan of every imagery tile made since the pre-Metro snapshot (the publish set): NAIP band-dropout squares
(tools/tiles/fetch.py rule), saturated-green 16 px blocks (a two-band dropout / encoder glitch), unreadable files and
pixel sizes per level. -> data/raw/tiles/scan_final.json
  python3 tools/metro_world/scan_final.py --published   the published (pre-Metro) files instead -> scan_published.json"""
import os, sys, json, collections
import numpy as np
from PIL import Image
import concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles.fetch import rgb_dropout_array   # noqa: E402
from tiles import common as C               # noqa: E402
REF = os.path.getmtime(os.path.join(C.WORK, 'coverage_pre_bart.json'))


def one(t):
    L, p = t
    try:
        im = Image.open(p); im.load(); px = im.size[0]
        a = np.asarray(im.convert('RGB')).astype(np.float32)
    except Exception as e:
        return ('unreadable', str(e), 0)
    small = a.reshape(a.shape[0] // 2, 2, a.shape[1] // 2, 2, 3).mean((1, 3))
    drop = rgb_dropout_array(small)
    n = a.shape[0] // 16
    g = ((a[..., 1] - a[..., 0] > 100) & (a[..., 1] - a[..., 2] > 100))[:n * 16, :n * 16].reshape(n, 16, n, 16).mean((1, 3))
    return ('ok', bool(drop), int((g > 0.9).sum()) + (1000 if C.jpeg_truncated(a.astype(np.uint8)) else 0), px)


def main():
    pub = '--published' in sys.argv
    files = []
    for L in range(0, 10):
        d = os.path.join(C.PUB, 'img', str(L))
        if os.path.isdir(d):
            files += [(L, os.path.join(d, f)) for f in os.listdir(d) if f.endswith('.jpg') and '_test' not in f
                      and (os.path.getmtime(os.path.join(d, f)) < REF if pub else os.path.getmtime(os.path.join(d, f)) >= REF)]
    # the files written since the previous full scan (data/raw/tiles/new_img_dropouts.json) first, then the rest
    prev = os.path.join(C.WORK, 'new_img_dropouts.json'); t_prev = os.path.getmtime(prev) if os.path.exists(prev) and not pub else 0
    files.sort(key=lambda t: (os.path.getmtime(t[1]) < t_prev, t[0], t[1]))
    n_recent = sum(os.path.getmtime(t[1]) >= t_prev for t in files)
    print(f'{len(files)} new imagery files, {n_recent} written since the previous full scan (first)', flush=True)
    bad, green, unread, sizes = [], [], [], collections.Counter()
    with cf.ThreadPoolExecutor(3) as ex:
        for i, ((L, p), r) in enumerate(zip(files, ex.map(one, files))):
            if i == n_recent - 1 or (i + 1) % 1000 == 0:
                print(f'{i + 1} scanned: dropout {bad} green {green} unreadable {unread}', flush=True)
            name = f'{L}/{os.path.basename(p)}'
            if r[0] != 'ok':
                unread.append(name); continue
            sizes[f'L{L} {r[3]}px'] += 1
            if r[1]:
                bad.append(name)
            if r[2]:
                green.append([name, r[2]])
    out = {'scanned': len(files), 'dropout': bad, 'green_blocks': green, 'unreadable': unread, 'sizes': dict(sorted(sizes.items()))}
    json.dump(out, open(os.path.join(C.WORK, 'scan_published.json' if pub else 'scan_final.json'), 'w'), indent=1)
    print(json.dumps(out)[:3000], flush=True)


if __name__ == '__main__':
    main()
