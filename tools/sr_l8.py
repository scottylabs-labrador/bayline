#!/usr/bin/env python3
"""Upgrade every L8 imagery tile (400 m) from 512 px to 1024 px (0.39 m/px) on the GPU.

Where all four L9 children exist (the super-resolved near-track band) the L8 tile is a high-quality downsample of
their 2048 px mosaic; everywhere else its L7 parent's cached 2048 px NAIP fetch is super-resolved with Real-ESRGAN
(tools/sr_tiles.py, Apple GPU via PyTorch MPS) and cut into its four L8 children. Photo roofs (towns) and low
aerial views read L8, so this sharpens every roof and street along the corridor. Resumable: tiles already at
1024 px are skipped.

    python3 tools/sr_l8.py            # all L8 tiles in tiles/index.json
"""
import io, json, os, sys, time
import numpy as np
import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
from tools.tiles import common as C          # noqa: E402
import importlib.util
spec = importlib.util.spec_from_file_location('sr', os.path.join(HERE, 'sr_tiles.py')); SR = importlib.util.module_from_spec(spec); spec.loader.exec_module(SR)
import torch                                  # noqa: E402


def is1024(p):
    try:
        with Image.open(p) as im:
            return im.size[0] >= 1024
    except Exception:
        return False


def save(p, x01, q):
    im = Image.fromarray(np.clip(x01 * 255 + 0.5, 0, 255).astype(np.uint8))
    buf = io.BytesIO(); im.save(buf, 'JPEG', quality=q, optimize=True, subsampling=2)
    C.write_atomic(p, buf.getvalue())


def main():
    q = 86
    idx = json.load(open(os.path.join(C.PUB, 'index.json')))
    # every L8 tile of the coverage (square + the Bayline Metro north strip) that exists at 512 px
    l8 = [tuple(t) for t in C.coverage()[8] if os.path.exists(C.path('img', 8, t[0], t[1], 'jpg'))]
    l9 = {(x, y) for L9d in [os.path.join(C.PUB, 'img', '9')] if os.path.isdir(L9d)
          for (x, y) in (map(int, f[:-4].split('_')) for f in os.listdir(L9d) if f.endswith('.jpg') and '_test' not in f)}
    todo = [t for t in l8 if not is1024(C.path('img', 8, t[0], t[1], 'jpg'))]
    todo.sort(key=lambda t: (-int(t[1] < 0), t[1], t[0]))                   # the north strip first
    print(f'{len(l8)} L8 tiles, {len(todo)} to upgrade', flush=True)
    # 1) mosaic from L9 children where all four exist (no GPU needed)
    mos = 0
    rest = []
    for (tx, ty) in todo:
        kids = [(tx * 2 + dx, ty * 2 + dy) for dy in (0, 1) for dx in (0, 1)]
        if all(k in l9 for k in kids):
            can = np.zeros((2048, 2048, 3), np.float32)
            for (kx, ky) in kids:
                im = np.asarray(Image.open(C.path('img', 9, kx, ky, 'jpg')).convert('RGB')).astype(np.float32) / 255.0
                oy, ox = (ky - ty * 2) * 1024, (kx - tx * 2) * 1024
                can[oy:oy + 1024, ox:ox + 1024] = im
            save(C.path('img', 8, tx, ty, 'jpg'), cv2.resize(can, (1024, 1024), interpolation=cv2.INTER_AREA), q); mos += 1
        else:
            rest.append((tx, ty))
    print(f'{mos} L8 tiles mosaicked from L9; {len(rest)} need GPU super-resolution', flush=True)
    # 2) GPU super-resolution per L7 parent
    device = torch.device('mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu')
    model, dtype = SR.load_model(device)
    parents = sorted({(x >> 1, y >> 1) for (x, y) in rest})
    want = set(rest); cache = {}; t0 = time.time(); made = 0
    for n, (px, py) in enumerate(parents):
        try:
            M = 96
            can = SR.padded_input(px, py, M, cache)
            Nd = 1333; md = int(round(M * Nd / 2048))
            small = cv2.resize(can, (Nd + 2 * md, Nd + 2 * md), interpolation=cv2.INTER_AREA)
            big = SR.upscale4(model, dtype, device, small)
            core = big[4 * md:4 * md + 4 * Nd, 4 * md:4 * md + 4 * Nd]
            full = cv2.resize(core, (2048, 2048), interpolation=cv2.INTER_AREA)          # 0.39 m/px over the L7 tile
            for dy in (0, 1):
                for dx in (0, 1):
                    k = (px * 2 + dx, py * 2 + dy)
                    if k in want:
                        save(C.path('img', 8, k[0], k[1], 'jpg'), full[dy * 1024:(dy + 1) * 1024, dx * 1024:(dx + 1) * 1024], q); made += 1
        except Exception as e:
            print(f'L7 {px}_{py} failed: {e}', flush=True)
        if len(cache) > 40:
            for k in list(cache.keys())[:len(cache) - 20]:
                del cache[k]
        if n % 20 == 0 or n == len(parents) - 1:
            el = time.time() - t0; print(f'{n + 1}/{len(parents)} L7 parents, {made} L8 written, {el:.0f}s, ~{el / (n + 1) * (len(parents) - n - 1):.0f}s left', flush=True)
    idx = json.load(open(os.path.join(C.PUB, 'index.json')))          # (re-read: other steps may have rewritten it meanwhile)
    idx['products']['img']['size8'] = 1024
    tmp = os.path.join(C.PUB, 'index.json.tmp'); json.dump(idx, open(tmp, 'w'), separators=(',', ':')); os.replace(tmp, os.path.join(C.PUB, 'index.json'))
    print('done', flush=True)


if __name__ == '__main__':
    main()
