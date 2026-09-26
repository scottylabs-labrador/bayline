#!/usr/bin/env python3
"""Replacement files for PUBLISHED imagery tiles that show NAIP band-dropout squares (found by scanning the published
tiles: data/raw/tiles/published_dropouts.json). Nothing under data/pub is written: the fixed tiles go to
data/raw/tiles/fix_dropouts/tiles/img/L/x_y.jpg (+ a before/after sheet), for the lead to publish over the broken ones
(and purge from the CDN) if they want. Uses the GPU (run it when no other super-resolution job is running).

  python3 tools/metro_world/fix_published.py
Each tile is made the way the pipeline made it: L9 = Real-ESRGAN of the L7 parent's 2048 px fetch (tools/sr_tiles.py);
L8 = the same at 0.39 m/px (tools/sr_l8.py), or the mosaic of its four L9 children where all exist; L7 = the L7 fetch;
L6 and coarser = the mosaic of the (fixed) children, or a direct fetch where the tile was fetched directly.
"""
import io, json, os, sys
import numpy as np
import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tools.tiles import common as C, imagery as I, fetch   # noqa: E402
import importlib.util   # noqa: E402
_spec = importlib.util.spec_from_file_location('sr', os.path.join(ROOT, 'tools', 'sr_tiles.py')); SR = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(SR)

OUT = os.path.join(C.WORK, 'fix_dropouts', 'tiles', 'img')
REF = os.path.getmtime(os.path.join(C.WORK, 'coverage_pre_bart.json'))      # files older than this are the published ones


def outp(L, x, y):
    return os.path.join(OUT, str(L), f'{x}_{y}.jpg')


def save(p, x01, q):
    im = Image.fromarray(np.clip(x01 * 255 + 0.5, 0, 255).astype(np.uint8)); buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=q, optimize=True, subsampling=2); C.write_atomic(p, buf.getvalue())


def ok(p):
    im = Image.open(p); im.draft('RGB', (im.size[0] // 2, im.size[1] // 2))
    return not fetch.rgb_dropout_array(np.asarray(im.convert('RGB')).astype(np.float32))


def clean_raw2048(tx, ty):
    """make sure the L7 tile's 2048 px fetch has no dropout (re-fetch, validated)"""
    bb = C.bbox_ll(7, tx, ty); w, s, e, n = bb
    key = f'{w:.7f}_{s:.7f}_{e:.7f}_{n:.7f}_2048_rgb'
    p = os.path.join(C.RAW, 'naip_aar0', 'rgb', '2048', key.replace('-', 'm') + '.jpg')
    if os.path.exists(p) and not fetch._rgb_ok(open(p, 'rb').read()):
        os.remove(p)
    fetch.naip(bb, 2048, 'rgb', timeout=45)


def sha(p):
    import hashlib
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def main():
    import torch
    mode = json.load(open(os.path.join(C.WORK, 'img_mode_pre_bart.json')))
    bad = [tuple(t) for t in json.load(open(os.path.join(C.WORK, 'published_dropouts.json')))]
    bad = [(int(L), *map(int, f[:-4].split('_'))) for (L, f) in bad]
    device = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
    model, dtype = SR.load_model(device)
    done = {}
    cache = {}
    for (L, x, y) in sorted(bad, key=lambda t: -t[0]):
        if L == 9:
            tx, ty = x >> 2, y >> 2; clean_raw2048(tx, ty)
            want = {(x, y)}
            tmp = C.path  # (sr_tiles writes into data/pub: redirect by baking into a scratch copy of the path function)
            C.path = lambda prod, l, a, b, ext, _t=tmp: outp(l, a, b) if (prod, l) == ('img', 9) else _t(prod, l, a, b, ext)
            try:
                SR.bake_L7(model, dtype, device, tx, ty, want, 84, cache, force=True)
            finally:
                C.path = tmp
        elif L == 8 and all(os.path.exists(C.path('img', 9, x * 2 + dx, y * 2 + dy, 'jpg')) and os.path.getmtime(C.path('img', 9, x * 2 + dx, y * 2 + dy, 'jpg')) < REF
                            for dy in (0, 1) for dx in (0, 1)):
            # (made from its four L9 children, like tools/sr_l8.py: the fixed ones where they were bad)
            can = np.zeros((2048, 2048, 3), np.float32)
            for dy in (0, 1):
                for dx in (0, 1):
                    kx, ky = x * 2 + dx, y * 2 + dy
                    src = outp(9, kx, ky) if os.path.exists(outp(9, kx, ky)) else C.path('img', 9, kx, ky, 'jpg')
                    can[dy * 1024:(dy + 1) * 1024, dx * 1024:(dx + 1) * 1024] = np.asarray(Image.open(src).convert('RGB')).astype(np.float32) / 255.0
            save(outp(8, x, y), cv2.resize(can, (1024, 1024), interpolation=cv2.INTER_AREA), 86)
        elif L == 8:
            tx, ty = x >> 1, y >> 1; clean_raw2048(tx, ty)
            M = 96; can = SR.padded_input(tx, ty, M, cache)
            Nd = 1333; md = int(round(M * Nd / 2048))
            small = cv2.resize(can, (Nd + 2 * md, Nd + 2 * md), interpolation=cv2.INTER_AREA)
            big = SR.upscale4(model, dtype, device, small)
            core = big[4 * md:4 * md + 4 * Nd, 4 * md:4 * md + 4 * Nd]
            full = cv2.resize(core, (2048, 2048), interpolation=cv2.INTER_AREA)
            dx, dy = x - tx * 2, y - ty * 2
            save(outp(8, x, y), full[dy * 1024:(dy + 1) * 1024, dx * 1024:(dx + 1) * 1024], 86)
        elif L == 7:
            clean_raw2048(x, y) if any(C.exists(*c) for c in C.children(7, x, y)) else None
            d = I.load_hires(7, x, y)
            q = outp(7, x, y); C.ensure_dir(q); I._save_jpg(q, I._down(d['rgb'], C.IMG))
        else:
            kids = C.children(L, x, y)
            if mode.get(f'{L}/{x}_{y}', 'mosaic') == 'mosaic' and all(os.path.exists(C.path('img', *c, 'jpg')) for c in kids):
                big = np.zeros((C.IMG * 2, C.IMG * 2, 3), np.float32)
                for (cl, cx, cy) in kids:
                    src = outp(cl, cx, cy) if os.path.exists(outp(cl, cx, cy)) else C.path('img', cl, cx, cy, 'jpg')
                    a = np.asarray(Image.open(src).convert('RGB').resize((C.IMG, C.IMG), Image.LANCZOS)).astype(np.float32) / 255.0
                    big[(cy - y * 2) * C.IMG:(cy - y * 2 + 1) * C.IMG, (cx - x * 2) * C.IMG:(cx - x * 2 + 1) * C.IMG] = a
                q = outp(L, x, y); C.ensure_dir(q); I._save_jpg(q, I._down(big, C.IMG))
            else:
                d = I.load_hires(L, x, y); q = outp(L, x, y); C.ensure_dir(q); I._save_jpg(q, I._down(d['rgb'], C.IMG))
        p = outp(L, x, y)
        done[f'{L}/{x}_{y}'] = bool(os.path.exists(p) and ok(p))
        print(L, x, y, 'fixed' if done[f'{L}/{x}_{y}'] else 'STILL BAD', flush=True)
    json.dump(done, open(os.path.join(C.WORK, 'fix_dropouts', 'published_fixed.json'), 'w'), indent=1)
    man = []
    for k, good in sorted(done.items()):
        L, xy = k.split('/'); x, y = map(int, xy.split('_'))
        new = outp(int(L), x, y); old = C.path('img', int(L), x, y, 'jpg')
        if good and os.path.exists(new):
            man.append({'path': f'tiles/img/{L}/{x}_{y}.jpg', 'old_sha256': sha(old), 'new_sha256': sha(new), 'bytes': os.path.getsize(new),
                        'px': Image.open(new).size[0], 'old_px': Image.open(old).size[0]})
    json.dump({'what': 'replacements for published imagery tiles with NAIP band-dropout squares (magenta / yellow / cyan)',
               'staged_root': os.path.relpath(os.path.join(C.WORK, 'fix_dropouts'), C.ROOT), 'files': man},
              open(os.path.join(C.WORK, 'fix_dropouts', 'manifest.json'), 'w'), indent=1)
    print('manifest:', len(man), 'files')
    # before / after sheet
    items = sorted(done)[:16]
    sheet = Image.new('RGB', (len(items) * 256, 512))
    for i, k in enumerate(items):
        L, xy = k.split('/'); x, y = map(int, xy.split('_'))
        sheet.paste(Image.open(C.path('img', int(L), x, y, 'jpg')).convert('RGB').resize((256, 256)), (i * 256, 0))
        if os.path.exists(outp(int(L), x, y)):
            sheet.paste(Image.open(outp(int(L), x, y)).convert('RGB').resize((256, 256)), (i * 256, 256))
    sheet.save(os.path.join(C.WORK, 'fix_dropouts', 'published_before_after.jpg'), quality=82)
    print(sum(done.values()), 'of', len(done), 'fixed ->', OUT)


if __name__ == '__main__':
    main()
