#!/usr/bin/env python3
"""Replacement files for PUBLISHED (pre-Metro) imagery tiles with NAIP band-dropout squares.

Input: data/raw/tiles/published_dropouts_v2.json (tools/metro_world/find_published_dropouts.py: published tiles whose
raw NAIP response was bad on Sep 23; the raw has since been re-fetched clean). Nothing under data/pub is written. For
each flagged tile, the tile and everything made from the same bad response is rebuilt exactly as the pipeline built it:
  L7 flagged: img/7 (512 px from its fetch), its published L8 children (1024 px: Real-ESRGAN of the L7 fetch like
  tools/sr_l8.py, or the mosaic of their four L9 children), its published L9 grandchildren (1024 px: Real-ESRGAN like
  tools/sr_tiles.py); L5 / L6 flagged (direct fetches): the tile itself; then every mosaic ancestor up to L0 (the
  pre-Metro mode file says which were mosaics), from the fixed children.
A rebuilt file is kept only if it really differs from the published one (a block jump > 12 levels); the result goes to
data/raw/tiles/fix_dropouts/tiles/img/L/x_y.jpg with manifest.json (path, old_sha256, new_sha256, bytes, px) and a
before / after sheet. Uses the GPU (one job at a time).

  BAYLINE_STAGE=bart3 python3 tools/metro_world/fix_published.py
"""
import hashlib, io, json, os, sys
import numpy as np
import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, 'tools')); sys.path.insert(0, HERE)
os.environ['BAYLINE_FILL'] = 'old'                             # (published tiles were baked with the old no-data fill)
from tools.tiles import common as C, imagery as I, fetch   # noqa: E402
I.FILL_LOCAL = False
import importlib.util   # noqa: E402
_spec = importlib.util.spec_from_file_location('sr', os.path.join(ROOT, 'tools', 'sr_tiles.py')); SR = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(SR)

STAGE = os.path.join(C.WORK, 'fix_dropouts')
OUT = os.path.join(STAGE, 'tiles', 'img')
REF = os.path.getmtime(os.path.join(C.WORK, 'coverage_pre_bart.json'))      # older files = the published ones
PRE = json.load(open(os.path.join(C.WORK, 'coverage_pre_bart.json')))
PRE_SETS = {int(L): {tuple(t) for t in PRE[L]} for L in ('6', '7', '8')}
MODE = json.load(open(os.path.join(C.WORK, 'img_mode_pre_bart.json')))


def outp(L, x, y):
    return os.path.join(OUT, str(L), f'{x}_{y}.jpg')


def published(L, x, y):
    p = C.path('img', L, x, y, 'jpg')
    return p if os.path.exists(p) and os.path.getmtime(p) < REF else None


def cur(L, x, y):
    """the staged version if any, else the published one"""
    return outp(L, x, y) if os.path.exists(outp(L, x, y)) else C.path('img', L, x, y, 'jpg')


def save(p, x01, q):
    C.ensure_dir(p)
    im = Image.fromarray(np.clip(x01 * 255 + 0.5, 0, 255).astype(np.uint8)); buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=q, optimize=True, subsampling=2); C.write_atomic(p, buf.getvalue())


def load01(p, n=None):
    im = Image.open(p).convert('RGB')
    if n and im.size[0] != n:
        im = im.resize((n, n), Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0


def jump(a_path, b_path):
    a = np.asarray(Image.open(a_path).convert('RGB').resize((512, 512))).astype(np.float32)
    b = np.asarray(Image.open(b_path).convert('RGB').resize((512, 512))).astype(np.float32)
    n = 32; d = np.abs(a - b).reshape(16, n, 16, n, 3).mean((1, 3))
    return float(d.max())


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def main():
    import torch
    device = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
    model, dtype = SR.load_model(device)
    flagged = [tuple(t[:3]) for t in json.load(open(os.path.join(C.WORK, 'published_dropouts_v2.json')))]
    made = []                    # (L, x, y) rebuilt into the staging dir
    cache = {}
    # 1) the flagged tiles and their L8 / L9 descendants
    for (L, x, y) in flagged:
        if L == 7:
            kids8 = [(8, cx, cy) for (_, cx, cy) in C.children(7, x, y) if (cx, cy) in PRE_SETS[8] and published(8, cx, cy)]
            d = I.load_hires(7, x, y)                         # (clean fetch, validated)
            save(outp(7, x, y), I._down(d['rgb'], C.IMG), 87); made.append((7, x, y))
            if kids8:
                # L9 grandchildren, exactly as tools/sr_tiles.py makes them
                want = {(gx, gy) for (_, cx, cy) in kids8 for gy in (cy * 2, cy * 2 + 1) for gx in (cx * 2, cx * 2 + 1) if published(9, gx, gy)}
                if want:
                    old_path = C.path
                    C.path = lambda prod, l, a, b, ext, _p=old_path: outp(l, a, b) if (prod, l) == ('img', 9) else _p(prod, l, a, b, ext)
                    try:
                        SR.bake_L7(model, dtype, device, x, y, want, 84, cache, force=True)
                    finally:
                        C.path = old_path
                    made += [(9, gx, gy) for (gx, gy) in want]
                # L8 children at 1024 px, as tools/sr_l8.py makes them
                M = 96; can = SR.padded_input(x, y, M, cache)
                Nd = 1333; md = int(round(M * Nd / 2048))
                small = cv2.resize(can, (Nd + 2 * md, Nd + 2 * md), interpolation=cv2.INTER_AREA)
                big = SR.upscale4(model, dtype, device, small)
                core = big[4 * md:4 * md + 4 * Nd, 4 * md:4 * md + 4 * Nd]
                full = cv2.resize(core, (2048, 2048), interpolation=cv2.INTER_AREA)
                for (_, cx, cy) in kids8:
                    g9 = [(cx * 2 + dx, cy * 2 + dy) for dy in (0, 1) for dx in (0, 1)]
                    if all(published(9, gx, gy) for (gx, gy) in g9):
                        c2 = np.zeros((2048, 2048, 3), np.float32)
                        for (gx, gy) in g9:
                            c2[(gy - cy * 2) * 1024:(gy - cy * 2 + 1) * 1024, (gx - cx * 2) * 1024:(gx - cx * 2 + 1) * 1024] = load01(cur(9, gx, gy), 1024)
                        save(outp(8, cx, cy), cv2.resize(c2, (1024, 1024), interpolation=cv2.INTER_AREA), 86)
                    else:
                        dx, dy = cx - x * 2, cy - y * 2
                        save(outp(8, cx, cy), full[dy * 1024:(dy + 1) * 1024, dx * 1024:(dx + 1) * 1024], 86)
                    made.append((8, cx, cy))
        else:
            d = I.load_hires(L, x, y)
            save(outp(L, x, y), I._down(d['rgb'], C.IMG), 87); made.append((L, x, y))
    # 2) the mosaic ancestors, bottom-up, from the fixed children
    todo = {(L - 1, x >> 1, y >> 1) for (L, x, y) in made if 1 <= L <= 7}          # (L7 / L8 are fetched, never mosaics)
    while todo:
        L = max(t[0] for t in todo); level = sorted(t for t in todo if t[0] == L); todo -= set(level)
        for (L, x, y) in level:
            if L > 6 or not published(L, x, y) or (L >= 5 and MODE.get(f'{L}/{x}_{y}', 'mosaic') != 'mosaic'):
                continue
            kids = C.children(L, x, y)
            if not all(os.path.exists(C.path('img', *c, 'jpg')) for c in kids):
                continue
            big = np.zeros((C.IMG * 2, C.IMG * 2, 3), np.float32)
            for (cl, cx, cy) in kids:
                big[(cy - y * 2) * C.IMG:(cy - y * 2 + 1) * C.IMG, (cx - x * 2) * C.IMG:(cx - x * 2 + 1) * C.IMG] = load01(cur(cl, cx, cy), C.IMG)
            save(outp(L, x, y), I._down(big, C.IMG), 87); made.append((L, x, y))
            if L >= 1:
                todo.add((L - 1, x >> 1, y >> 1))
    # 3) keep what really changed; manifest; sheet
    man, dropped = [], 0
    for (L, x, y) in sorted(set(made)):
        new, old = outp(L, x, y), published(L, x, y)
        if not old or not os.path.exists(new):
            continue
        j = jump(new, old)
        if j <= 12.0:
            os.remove(new); dropped += 1; continue
        man.append({'path': f'tiles/img/{L}/{x}_{y}.jpg', 'old_sha256': sha(old), 'new_sha256': sha(new), 'bytes': os.path.getsize(new),
                    'px': Image.open(new).size[0], 'old_px': Image.open(old).size[0], 'block_jump': round(j, 1)})
    os.makedirs(STAGE, exist_ok=True)
    json.dump({'what': 'replacements for published imagery tiles with NAIP band-dropout squares (magenta / yellow / cyan blocks)',
               'staged_root': 'data/raw/tiles/fix_dropouts', 'files': man}, open(os.path.join(STAGE, 'manifest.json'), 'w'), indent=1)
    items = man[:24]
    sheet = Image.new('RGB', (max(1, len(items)) * 160, 320))
    for i, m in enumerate(items):
        rel = m['path'][len('tiles/img/'):]
        sheet.paste(Image.open(os.path.join(C.PUB, 'img', rel)).convert('RGB').resize((160, 160)), (i * 160, 0))
        sheet.paste(Image.open(os.path.join(OUT, rel)).convert('RGB').resize((160, 160)), (i * 160, 160))
    sheet.save(os.path.join(STAGE, 'before_after.jpg'), quality=80)
    print(f'{len(man)} replacement files staged ({dropped} rebuilt but unchanged, dropped) -> {STAGE}', flush=True)


if __name__ == '__main__':
    main()
