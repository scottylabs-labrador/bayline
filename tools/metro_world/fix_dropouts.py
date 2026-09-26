#!/usr/bin/env python3
"""Repair NAIP band dropouts (tools/metro_world/naip_dropouts.py found them): re-fetch every flagged raw response (the
RGB fetch now validates and retries), keep the ones whose content really changed, and re-bake what was made from them:

  * tiles that are NOT published yet (Bayline Metro, made after data/raw/tiles/coverage_pre_bart.json): img (L7 + its L8
    children), masks, tree crowns, and the coarser mosaics above them, in place; their L9 super-resolved children are
    deleted so tools/sr_tiles.py makes them again;
  * published (pre-Metro) tiles: fixed copies go to data/raw/tiles/fix_dropouts/<same relative path> for the lead
    (they are never overwritten here).

  BAYLINE_STAGE=... python3 tools/metro_world/fix_dropouts.py        (report: data/raw/tiles/fix_dropouts/report.json)
"""
import io, json, math, os, shutil, sys, time
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles import common as C, fetch, imagery as I, masks as M, trees as TR, heights as H   # noqa: E402

STAGE = os.path.join(C.WORK, 'fix_dropouts')
REF = os.path.getmtime(os.path.join(C.WORK, 'coverage_pre_bart.json'))


def parse(path):
    """raw file -> (bbox (w, s, e, n), px, band)"""
    f = os.path.basename(path)[:-4]
    w, s, e, n, px, band = f.split('_')
    num = lambda v: float(v.replace('m', '-'))
    return (num(w), num(s), num(e), num(n)), int(px), band


def tile_of_bbox(bb):
    w, s, e, n = bb
    x0 = (w - C.LON0) * C.MLON; x1 = (e - C.LON0) * C.MLON
    L = int(round(math.log2(C.SIZE / (x1 - x0))))
    z0 = -(n - C.LAT0) * C.MLAT
    return L, int(round((x0 - C.X0) / C.T(L))), int(round((z0 - C.Z0) / C.T(L)))


def small(b, mode):
    im = Image.open(io.BytesIO(b)); im.draft(mode, (256, 256)); return np.asarray(im.convert(mode).resize((256, 256))).astype(np.float32)


def quadrants(bb, px, band, dest):
    """The box as four quarter-size requests (a different request pattern on the server), each validated, stitched
    and written to the cache path the whole-box request would have used. -> JPEG bytes or None."""
    w, s, e, n = bb; mx, my = (w + e) / 2, (s + n) / 2; h = px // 2
    out = Image.new('RGB', (px, px))
    try:
        for (qx, qy, qb) in ((0, 0, (w, my, mx, n)), (1, 0, (mx, my, e, n)), (0, 1, (w, s, mx, my)), (1, 1, (mx, s, e, my))):
            b = fetch.naip(qb, h, band, timeout=45)
            out.paste(Image.open(io.BytesIO(b)).convert('RGB').resize((h, h)), (qx * h, qy * h))
    except Exception as ex:
        print('quadrants failed', os.path.basename(dest), ex, flush=True)
        return None
    data = C.jpeg_bytes(np.asarray(out.convert('RGB')), 92)            # (checked encode: see common.jpeg_bytes)
    if not fetch._rgb_ok(data):
        return None
    C.write_atomic(dest, data)
    print('stitched from quadrants', os.path.basename(dest), flush=True)
    return data


def is_new(p):
    return os.path.exists(p) and os.path.getmtime(p) >= REF


def main():
    flagged = json.load(open(os.path.join(C.WORK, 'naip_dropouts.json')))
    if '--rgb-only' in sys.argv:                  # (the NIR check still flags clear water; RGB dropouts are unambiguous)
        flagged = [p for p in flagged if '/rgb/' in p]
    ref_t = os.path.getmtime(os.path.join(C.WORK, 'naip_dropouts.json'))
    import concurrent.futures as cf

    def one(p):
        """-> (p, bb, px, band, diff) | None. Re-fetches unless a previous run already did (newer than the scan)."""
        bb, px, band = parse(p)
        mode = 'RGB' if band == 'rgb' else 'L'
        if os.path.exists(p) and os.path.getmtime(p) > ref_t:
            return None                                  # re-fetched by an earlier run (its diff is unknown: re-bake anyway)
        old = open(p, 'rb').read() if os.path.exists(p) else None
        if old is not None:
            os.remove(p)
        try:
            new = fetch.naip(bb, px, band, timeout=45)
        except Exception as e:
            new = quadrants(bb, px, band, p) if band == 'rgb' else None     # the server keeps breaking this box: stitch
            if new is None:
                print('refetch failed', os.path.basename(p), e, flush=True)
                if old is not None:
                    open(p, 'wb').write(old)
                return None
        d = float(np.abs(small(old, mode) - small(new, mode)).mean()) if old is not None else 99.0
        return (p, bb, px, band, round(d, 1)) if d > 2.0 else None
    changed = []
    with cf.ThreadPoolExecutor(6) as ex:
        for r in ex.map(one, flagged):
            if r:
                changed.append(r)
    print(len(changed), 'of', len(flagged), 'responses really changed', flush=True)
    tiles = {}
    for (p, bb, px, band, d) in changed:
        L, tx, ty = tile_of_bbox(bb)
        tiles.setdefault((L, tx, ty), []).append((band, px, d))
    report = {'changed': [[os.path.basename(c[0]), c[4]] for c in changed], 'new': [], 'published': []}
    for (L, tx, ty), why in sorted(tiles.items()):
        img = C.path('img', L, tx, ty, 'jpg')
        rgb = any(b == 'rgb' for b, _, _ in why)
        if not os.path.exists(img):
            continue
        if is_new(img):
            # a Bayline Metro tile (not published): re-bake in place
            kids = [c for c in C.children(L, tx, ty) if C.exists(*c)] if L == 7 else []
            if L == 7:
                for c in kids:                                   # (512 px again from the fixed fetch; sr_l8 upgrades them)
                    pc = C.path('img', *c, 'jpg')
                    if os.path.exists(pc) and is_new(pc):
                        os.remove(pc)
                I.bake_L7(tx, ty, force=True, add_only=False) if rgb else None
                M.bake_tile(7, tx, ty, force=True, pooled=False)
                TR.bake_tile(tx, ty, force=True)
                for (cl, cx, cy) in kids:                        # L9 children made from the bad 2048 fetch
                    for dy in (0, 1):
                        for dx in (0, 1):
                            p9 = C.path('img', 9, cx * 2 + dx, cy * 2 + dy, 'jpg')
                            if os.path.exists(p9) and is_new(p9):
                                os.remove(p9)
            else:
                if rgb:
                    I.bake_direct(L, tx, ty, force=True)
                M.bake_tile(L, tx, ty, force=True, pooled=False)
            report['new'].append([L, tx, ty])
        else:
            # published (pre-Metro): reported only; their L8 children are 1024 px super-resolved copies, so a fix
            # needs the GPU pass too (see the report)
            report['published'].append([L, tx, ty, sorted({w[0] for w in why})])
    # the coarser mosaics above the re-baked new tiles (new ones only, and only those made by mosaic / pooling)
    mode = json.load(open(os.path.join(C.WORK, 'img_mode.json'))) if os.path.exists(os.path.join(C.WORK, 'img_mode.json')) else {}
    todo = {(L - 1, x >> 1, y >> 1) for (L, x, y) in report['new'] if L - 1 >= 2}
    done = set()
    while todo:
        L, x, y = max(todo); todo.discard((L, x, y))
        if (L, x, y) in done:
            continue
        done.add((L, x, y))
        p_img, p_m = C.path('img', L, x, y, 'jpg'), C.path('m', L, x, y, 'bin')
        if is_new(p_img) and mode.get(f'{L}/{x}_{y}', 'mosaic') == 'mosaic' and I.can_mosaic(L, x, y):
            I.bake_mosaic(L, x, y, force=True)
        if is_new(p_m) and mode.get(f'm{L}/{x}_{y}', 'pool') == 'pool' and all(os.path.exists(C.path('m', *c, 'bin')) for c in C.children(L, x, y)):
            M.bake_tile(L, x, y, force=True, pooled=True)
        report['remosaic'] = report.get('remosaic', []) + [[L, x, y]]
        if L - 1 >= 2:
            todo.add((L - 1, x >> 1, y >> 1))
    os.makedirs(STAGE, exist_ok=True)
    json.dump(report, open(os.path.join(STAGE, 'report.json'), 'w'), indent=1)
    print('re-baked new tiles:', len(report['new']), ' published tiles affected:', len(report['published']), flush=True)
    print('parents re-mosaicked:', len(report.get('remosaic', [])), flush=True)


if __name__ == '__main__':
    main()
