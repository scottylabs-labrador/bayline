#!/usr/bin/env python3
"""Replacement files for PUBLISHED (pre-Metro) imagery tiles whose JPEG came out truncated (Pillow 10.1 / libjpeg-turbo
3.0.0; Chrome draws the missing last MCUs as green 16 px squares): data/raw/tiles/scan_published.json `green_blocks`
(tools/metro_world/scan_final.py --published) plus the published L8 tiles that were mosaicked from a truncated L9 child.
Each is rebuilt exactly as the pipeline built it, now with the checked encoder (tools/tiles/common.jpeg_bytes):
  L9: Real-ESRGAN of its L7 parent's cached NAIP fetch (tools/sr_tiles.py);
  L8: the mosaic of its four L9 children where they all exist (staged ones first), else Real-ESRGAN of its L7 parent's
      fetch (tools/sr_l8.py).
Output: data/raw/tiles/fix_truncated/tiles/img/L/x_y.jpg + manifest.json (path, old_sha256, new_sha256, bytes, px) +
before_after.jpg. Nothing under data/pub is written. Uses the GPU (one job at a time).

  BAYLINE_STAGE=bart3 python3 tools/metro_world/fix_truncated_published.py
"""
import hashlib, io, json, os, sys
import numpy as np
import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, 'tools'))
os.environ['BAYLINE_FILL'] = 'old'                             # (published tiles were baked with the old no-data fill)
from tools.tiles import common as C, imagery as I   # noqa: E402
I.FILL_LOCAL = False
import importlib.util   # noqa: E402
_spec = importlib.util.spec_from_file_location('sr', os.path.join(ROOT, 'tools', 'sr_tiles.py')); SR = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(SR)

STAGE = os.path.join(C.WORK, 'fix_truncated')
OUT = os.path.join(STAGE, 'tiles', 'img')
REF = os.path.getmtime(os.path.join(C.WORK, 'coverage_pre_bart.json'))


def outp(L, x, y):
    return os.path.join(OUT, str(L), f'{x}_{y}.jpg')


def published(L, x, y):
    p = C.path('img', L, x, y, 'jpg')
    return p if os.path.exists(p) and os.path.getmtime(p) < REF else None


def cur(L, x, y):
    return outp(L, x, y) if os.path.exists(outp(L, x, y)) else C.path('img', L, x, y, 'jpg')


def load01(p, n=None):
    im = Image.open(p).convert('RGB')
    if n and im.size[0] != n:
        im = im.resize((n, n), Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0


def save(p, x01, q):
    C.ensure_dir(p); C.write_atomic(p, C.jpeg_bytes(np.clip(x01 * 255 + 0.5, 0, 255).astype(np.uint8), q))


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def green_at(p, x0, y0, n=8):
    a = np.asarray(Image.open(p).convert('RGB')).astype(np.int16)[y0:y0 + n, x0:x0 + n]
    return ((a[..., 1] - np.maximum(a[..., 0], a[..., 2])) >= 60).mean() >= 0.9


def main():
    import torch
    scan = json.load(open(os.path.join(C.WORK, 'scan_published.json')))
    trunc = sorted({(int(n.split('/')[0]), *map(int, n.split('/')[1][:-4].split('_'))) for n, _k in scan['green_blocks']})
    l9 = [(x, y) for (L, x, y) in trunc if L == 9 and published(9, x, y)]
    l8 = {(x, y) for (L, x, y) in trunc if L == 8 and published(8, x, y)}
    # published L8 mosaics that carry a truncated child's green corner (8 px at the child's bottom-right)
    for (x, y) in l9:
        px, py = x >> 1, y >> 1
        if published(8, px, py) and green_at(C.path('img', 8, px, py, 'jpg'), (x - px * 2) * 512 + 504, (y - py * 2) * 512 + 504):
            l8.add((px, py))
    print('L9', l9, 'L8', sorted(l8), flush=True)
    device = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
    model, dtype = SR.load_model(device); cache = {}
    made = []
    # L9 first (the L8 mosaics read them)
    by7 = {}
    for (x, y) in l9:
        by7.setdefault((x >> 2, y >> 2), set()).add((x, y))
    for (px, py), want in by7.items():
        old_path = C.path
        C.path = lambda prod, l, a, b, ext, _p=old_path: outp(l, a, b) if (prod, l) == ('img', 9) else _p(prod, l, a, b, ext)
        try:
            SR.bake_L7(model, dtype, device, px, py, want, 84, cache, force=True)
        finally:
            C.path = old_path
        made += [(9, x, y) for (x, y) in want]
    for (x, y) in sorted(l8):
        g9 = [(x * 2 + dx, y * 2 + dy) for dy in (0, 1) for dx in (0, 1)]
        if all(os.path.exists(C.path('img', 9, a, b, 'jpg')) for (a, b) in g9):
            can = np.zeros((2048, 2048, 3), np.float32)
            for (a, b) in g9:
                can[(b - y * 2) * 1024:(b - y * 2 + 1) * 1024, (a - x * 2) * 1024:(a - x * 2 + 1) * 1024] = load01(cur(9, a, b), 1024)
            save(outp(8, x, y), cv2.resize(can, (1024, 1024), interpolation=cv2.INTER_AREA), 86)
        else:
            px, py = x >> 1, y >> 1
            M = 96; can = SR.padded_input(px, py, M, cache)
            Nd = 1333; md = int(round(M * Nd / 2048))
            small = cv2.resize(can, (Nd + 2 * md, Nd + 2 * md), interpolation=cv2.INTER_AREA)
            big = SR.upscale4(model, dtype, device, small)
            core = big[4 * md:4 * md + 4 * Nd, 4 * md:4 * md + 4 * Nd]
            full = cv2.resize(core, (2048, 2048), interpolation=cv2.INTER_AREA)
            dx, dy = x - px * 2, y - py * 2
            save(outp(8, x, y), full[dy * 1024:(dy + 1) * 1024, dx * 1024:(dx + 1) * 1024], 86)
        made.append((8, x, y))
    man = []
    for (L, x, y) in sorted(set(made)):
        new, old = outp(L, x, y), published(L, x, y)
        a = np.asarray(Image.open(new).convert('RGB'))
        if C.jpeg_truncated(a):
            print('STILL TRUNCATED', L, x, y, flush=True); continue
        man.append({'path': f'tiles/img/{L}/{x}_{y}.jpg', 'old_sha256': sha(old), 'new_sha256': sha(new), 'bytes': os.path.getsize(new),
                    'px': Image.open(new).size[0], 'old_px': Image.open(old).size[0]})
    json.dump({'what': 'replacements for published imagery tiles whose JPEG was truncated (green 16 px squares in Chrome) and the '
                       'L8 mosaics made from them', 'staged_root': 'data/raw/tiles/fix_truncated', 'files': man},
              open(os.path.join(STAGE, 'manifest.json'), 'w'), indent=1)
    sheet = Image.new('RGB', (max(1, len(man)) * 256, 512))
    for i, m in enumerate(man):
        rel = m['path'][len('tiles/img/'):]
        sheet.paste(Image.open(os.path.join(C.PUB, 'img', rel)).convert('RGB').resize((256, 256)), (i * 256, 0))
        sheet.paste(Image.open(os.path.join(OUT, rel)).convert('RGB').resize((256, 256)), (i * 256, 256))
    sheet.save(os.path.join(STAGE, 'before_after.jpg'), quality=82)
    print(f'{len(man)} replacement files staged -> {STAGE}', flush=True)


if __name__ == '__main__':
    main()
