#!/usr/bin/env python3
"""Replacement set for imagery tiles whose JPEG scan ended early with visible damage in the last 16 px MCU (Pillow 10.1's
encoder; tools/metro_world/scan_corrupt.py + mcu_damage.py -> data/raw/tiles/fix_jpeg_targets.json: corner damage > 20
levels or a green corner). Every target is re-made from its source exactly as the pipeline made it, with the checked
OpenCV encoder (tools/tiles/common.jpeg_bytes):
  L9: Real-ESRGAN of the L7 parent's cached NAIP fetch (tools/sr_tiles.py)
  L8 (1024 px): the mosaic of its four L9 children where they all exist (fixed ones first), else Real-ESRGAN of the L7
      parent's fetch (tools/sr_l8.py); L8 still at 512 px: the crop of the L7 parent's fetch (tools/tiles/imagery.bake_L7)
  L7: the L7 fetch; L5 / L6: the direct fetch or the mosaic of their children (the mode files say which); L0-L4: mosaics
then every mosaic parent of a re-made tile, up the chain, kept when it changed (> 4 levels in a 16 px block).
Pre-Metro tiles are re-made with the old no-data fill, Bayline Metro tiles with the bay-water fill (run once per kind).
Output: data/raw/tiles/fix_jpeg/tiles/img/L/x_y.jpg + manifest_<kind>.json (path, old_sha256, new_sha256, bytes, px).
Nothing under data/pub is written. Uses the GPU (one job at a time).

  python3 tools/metro_world/fix_jpeg.py pre ; python3 tools/metro_world/fix_jpeg.py new ; python3 tools/metro_world/fix_jpeg.py merge
"""
import hashlib, json, os, sys
import numpy as np

KIND = sys.argv[1] if len(sys.argv) > 1 else 'new'
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, 'tools'))
os.environ.setdefault('BAYLINE_STAGE', 'bart3')
if KIND == 'pre':
    os.environ['BAYLINE_FILL'] = 'old'
import cv2                                            # noqa: E402
from PIL import Image                                 # noqa: E402
from tools.tiles import common as C, imagery as I     # noqa: E402
if KIND == 'pre':
    I.FILL_LOCAL = False

STAGE = os.path.join(C.WORK, 'fix_jpeg')
OUT = os.path.join(STAGE, 'tiles', 'img')


def outp(L, x, y):
    return os.path.join(OUT, str(L), f'{x}_{y}.jpg')


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


def px_of(p):
    with Image.open(p) as im:
        return im.size[0]


def block_jump(a_path, b_path):
    a = np.asarray(Image.open(a_path).convert('RGB').resize((512, 512))).astype(np.float32)
    b = np.asarray(Image.open(b_path).convert('RGB').resize((512, 512))).astype(np.float32)
    return float(np.abs(a - b).reshape(32, 16, 32, 16, 3).mean((1, 3)).max())


def main():
    if KIND == 'merge':
        man = []
        for k in ('pre', 'new'):
            p = os.path.join(STAGE, f'manifest_{k}.json')
            if os.path.exists(p):
                man += json.load(open(p))['files']
        json.dump({'what': 'replacements for published imagery tiles whose JPEG scan ended early with visible damage in the last '
                           '16 px MCU (and the mosaic parents that carried it), re-made with the checked OpenCV encoder',
                   'staged_root': 'data/raw/tiles/fix_jpeg', 'files': sorted(man, key=lambda m: m['path'])},
                  open(os.path.join(STAGE, 'manifest.json'), 'w'), indent=1)
        print(len(man), 'files in data/raw/tiles/fix_jpeg/manifest.json'); return
    mode = json.load(open(os.path.join(C.WORK, 'img_mode_pre_bart.json' if KIND == 'pre' else 'img_mode.json')))
    T = [(L, x, y) for (L, x, y, k, dm, g) in json.load(open(os.path.join(C.WORK, 'fix_jpeg_targets.json'))) if k == KIND]
    print(KIND, len(T), 'targets', flush=True)
    made = set()
    need_gpu = [t for t in T if t[0] == 9] + [t for t in T if t[0] == 8 and px_of(C.path('img', 8, t[1], t[2], 'jpg')) >= 1024
                                               and not all(os.path.exists(C.path('img', 9, t[1] * 2 + dx, t[2] * 2 + dy, 'jpg')) for dy in (0, 1) for dx in (0, 1))]
    SR = model = dtype = device = None; cache = {}
    if need_gpu:
        import importlib.util, torch
        spec = importlib.util.spec_from_file_location('sr', os.path.join(ROOT, 'tools', 'sr_tiles.py')); SR = importlib.util.module_from_spec(spec); spec.loader.exec_module(SR)
        device = torch.device('mps' if torch.backends.mps.is_available() else 'cpu'); model, dtype = SR.load_model(device)
    # L9: Real-ESRGAN per L7 parent
    by7 = {}
    for (L, x, y) in T:
        if L == 9:
            by7.setdefault((x >> 2, y >> 2), set()).add((x, y))
    for n, ((px, py), want) in enumerate(sorted(by7.items())):
        old_path = C.path
        C.path = lambda prod, l, a, b, ext, _p=old_path: outp(l, a, b) if (prod, l) == ('img', 9) else _p(prod, l, a, b, ext)
        try:
            SR.bake_L7(model, dtype, device, px, py, want, 84, cache, force=True)
        finally:
            C.path = old_path
        made |= {(9, x, y) for (x, y) in want}
        if len(cache) > 30:
            cache.clear()
        print(f'L9 parents {n + 1}/{len(by7)}', flush=True)
    # L8
    for (L, x, y) in sorted(t for t in T if t[0] == 8):
        p = C.path('img', 8, x, y, 'jpg'); g9 = [(x * 2 + dx, y * 2 + dy) for dy in (0, 1) for dx in (0, 1)]
        if px_of(p) < 1024:                                           # (still the 512 px crop of the L7 fetch)
            d = I.load_hires(7, x >> 1, y >> 1); f = d['full'] if d['px'] == 2048 else d['rgb']
            f1024 = I._down(f, 1024) if f.shape[0] != 1024 else f
            dx, dy = x - (x >> 1) * 2, y - (y >> 1) * 2
            save(outp(8, x, y), f1024[dy * 512:(dy + 1) * 512, dx * 512:(dx + 1) * 512], I.JPEG_Q)
        elif all(os.path.exists(C.path('img', 9, a, b, 'jpg')) for (a, b) in g9):
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
        made.add((8, x, y))
    # L8 mosaic parents of re-made L9 tiles (1024 px L8 whose four L9 children all exist)
    for (L, x, y) in sorted(t for t in made if t[0] == 9):
        px, py = x >> 1, y >> 1; p8 = C.path('img', 8, px, py, 'jpg')
        g9 = [(px * 2 + dx, py * 2 + dy) for dy in (0, 1) for dx in (0, 1)]
        if (8, px, py) in made or not os.path.exists(p8) or px_of(p8) < 1024 or not all(os.path.exists(C.path('img', 9, a, b, 'jpg')) for (a, b) in g9):
            continue
        can = np.zeros((2048, 2048, 3), np.float32)
        for (a, b) in g9:
            can[(b - py * 2) * 1024:(b - py * 2 + 1) * 1024, (a - px * 2) * 1024:(a - px * 2 + 1) * 1024] = load01(cur(9, a, b), 1024)
        save(outp(8, px, py), cv2.resize(can, (1024, 1024), interpolation=cv2.INTER_AREA), 86); made.add((8, px, py))
    # L7 and below
    for (L, x, y) in sorted((t for t in T if t[0] <= 7), key=lambda t: -t[0]):
        m = 'fetch' if L == 7 else mode.get(f'{L}/{x}_{y}', 'mosaic' if L <= 4 else 'direct')
        if m in ('fetch', 'direct'):
            d = I.load_hires(L, x, y); save(outp(L, x, y), I._down(d['rgb'], C.IMG), I.JPEG_Q)
        else:
            big = np.zeros((C.IMG * 2, C.IMG * 2, 3), np.float32)
            for (cl, cx, cy) in C.children(L, x, y):
                big[(cy - y * 2) * C.IMG:(cy - y * 2 + 1) * C.IMG, (cx - x * 2) * C.IMG:(cx - x * 2 + 1) * C.IMG] = load01(cur(cl, cx, cy), C.IMG)
            save(outp(L, x, y), I._down(big, C.IMG), I.JPEG_Q)
        made.add((L, x, y))
    # mosaic parents up the chain (L6 and below), kept when they changed
    todo = {(L - 1, x >> 1, y >> 1) for (L, x, y) in made if 1 <= L <= 7}
    while todo:
        L = max(t[0] for t in todo); level = sorted(t for t in todo if t[0] == L); todo -= set(level)
        for (L, x, y) in level:
            p = C.path('img', L, x, y, 'jpg')
            if (L, x, y) in made or not os.path.exists(p) or (L >= 5 and mode.get(f'{L}/{x}_{y}', 'mosaic') != 'mosaic'):
                continue
            kids = C.children(L, x, y)
            if not all(os.path.exists(C.path('img', *c, 'jpg')) for c in kids):
                continue
            big = np.zeros((C.IMG * 2, C.IMG * 2, 3), np.float32)
            for (cl, cx, cy) in kids:
                big[(cy - y * 2) * C.IMG:(cy - y * 2 + 1) * C.IMG, (cx - x * 2) * C.IMG:(cx - x * 2 + 1) * C.IMG] = load01(cur(cl, cx, cy), C.IMG)
            save(outp(L, x, y), I._down(big, C.IMG), I.JPEG_Q)
            if block_jump(outp(L, x, y), p) <= 4.0:
                os.remove(outp(L, x, y)); continue
            made.add((L, x, y))
            if L >= 1:
                todo.add((L - 1, x >> 1, y >> 1))
    man = []
    for (L, x, y) in sorted(made):
        new, old = outp(L, x, y), C.path('img', L, x, y, 'jpg')
        if not os.path.exists(new):
            continue
        man.append({'path': f'tiles/img/{L}/{x}_{y}.jpg', 'old_sha256': sha(old), 'new_sha256': sha(new), 'bytes': os.path.getsize(new),
                    'px': px_of(new), 'old_px': px_of(old), 'block_jump': round(block_jump(new, old), 1)})
    json.dump({'kind': KIND, 'files': man}, open(os.path.join(STAGE, f'manifest_{KIND}.json'), 'w'), indent=1)
    print(f'{KIND}: {len(man)} files staged', flush=True)


if __name__ == '__main__':
    main()
