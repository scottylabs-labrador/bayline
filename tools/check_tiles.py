#!/usr/bin/env python3
"""Validate Bayline v2 tiles against SPEC_v2 and render contact sheets for review.

  python3 tools/check_tiles.py validate            # every file: size, decode, value ranges; summary per product/level
  python3 tools/check_tiles.py sheet L tx0 ty0 [w h] [--out file.png]   # mosaic of img/masks/hillshade/trees for a block
  python3 tools/check_tiles.py seams L tx ty       # 2x2 around a corner at L (and L+1) to eyeball tile seams
"""
import argparse, io, json, os, struct, sys, zlib
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tiles import common as C
from tiles import heights as H
from tiles import trees as TR

OUTDIR = os.path.join(C.WORK, 'sheets')


def validate(a):
    issues = []
    summary = {}
    for prod, ext in (('img', 'jpg'), ('h', 'bin'), ('m', 'bin'), ('t', 'bin')):
        for L in range(0, 9):
            d = os.path.join(C.PUB, prod, str(L))
            if not os.path.isdir(d):
                continue
            import re
            allf = [f for f in os.listdir(d) if f.endswith('.' + ext)]
            files = [f for f in allf if re.fullmatch(r'\d+_\d+\.' + ext, f)]
            for f in allf:
                if f not in files:
                    issues.append(f'{prod}/{L}/{f}: not a tile name (ignored; not written by the bake)')
            tot = 0; bad = 0; extra = {}
            for f in files:
                p = os.path.join(d, f)
                b = open(p, 'rb').read(); tot += len(b)
                tx, ty = map(int, f[:-len(ext) - 1].split('_'))
                if not C.exists(L, tx, ty):
                    issues.append(f'{prod}/{L}/{f}: tile not in coverage')
                try:
                    if prod == 'img':
                        im = Image.open(io.BytesIO(b)); im.load()
                        if im.size != (C.IMG, C.IMG) or im.mode != 'RGB':
                            raise ValueError(f'size/mode {im.size} {im.mode}')
                    elif prod == 'h':
                        hh = H.decode_fast(b)
                        extra.setdefault('hmin', []).append(float(hh.min())); extra.setdefault('hmax', []).append(float(hh.max()))
                        if hh.min() < -150 or hh.max() > 1500:
                            raise ValueError(f'height range {hh.min()} {hh.max()}')
                    elif prod == 'm':
                        m = np.frombuffer(zlib.decompress(b), np.uint8)
                        if m.size != C.MN * C.MN * 4:
                            raise ValueError(f'mask size {m.size}')
                        m = m.reshape(C.MN, C.MN, 4)
                        if m[..., 3].max() > 7:
                            raise ValueError(f'landcover class {m[..., 3].max()}')
                        extra.setdefault('water', []).append(float(m[..., 0].mean() / 255))
                    elif prod == 't':
                        arr = TR.decode(b)
                        if len(arr) and (arr['kind'].max() > 8):
                            raise ValueError('bad kind')
                        extra.setdefault('trees', []).append(len(arr))
                except Exception as e:
                    bad += 1; issues.append(f'{prod}/{L}/{f}: {e}')
            s = {'files': len(files), 'MB': round(tot / 1e6, 2), 'bad': bad}
            if 'hmin' in extra: s['h'] = [round(min(extra['hmin']), 1), round(max(extra['hmax']), 1)]
            if 'water' in extra: s['water_mean'] = round(float(np.mean(extra['water'])), 3)
            if 'trees' in extra: s['trees'] = int(sum(extra['trees']))
            summary[f'{prod}/{L}'] = s
    for k, v in summary.items():
        print(k, v)
    print(f'{len(issues)} issues')
    for i in issues[:40]:
        print('  ', i)
    tot = {p: round(sum(v['MB'] for k, v in summary.items() if k.startswith(p + '/')), 1) for p in ('img', 'h', 'm', 't')}
    print('total MB', tot, 'all', round(sum(tot.values()), 1))
    return summary, issues


def hillshade(hh, cell):
    gy, gx = np.gradient(hh, cell)
    nx, ny, nz = -gx, -gy, np.ones_like(hh)
    n = np.sqrt(nx * nx + ny * ny + nz * nz)
    l = np.array([-0.5, -0.6, 0.62]); l /= np.linalg.norm(l)
    return np.clip((nx * l[0] + ny * l[1] + nz * l[2]) / n, 0, 1)


def sheet(a):
    L, x0, y0, w, h = a.L, a.tx, a.ty, a.w, a.h
    S = 512
    img = Image.new('RGB', (w * S, h * S), (40, 40, 40))
    msk = Image.new('RGB', (w * S, h * S), (0, 0, 0))
    lit = Image.new('RGB', (w * S, h * S), (0, 0, 0))
    hs = Image.new('RGB', (w * S, h * S), (0, 0, 0))
    ov = None
    for j in range(h):
        for i in range(w):
            tx, ty = x0 + i, y0 + j
            p = C.path('img', L, tx, ty, 'jpg')
            if os.path.exists(p):
                img.paste(Image.open(p).convert('RGB'), (i * S, j * S))
            mp = C.path('m', min(L, 7), tx if L <= 7 else tx >> (L - 7), ty if L <= 7 else ty >> (L - 7), 'bin')
            if os.path.exists(mp) and L <= 7:
                m = np.frombuffer(zlib.decompress(open(mp, 'rb').read()), np.uint8).reshape(C.MN, C.MN, 4)
                pal = np.array([[196, 176, 108], [150, 170, 70], [90, 120, 90], [200, 100, 110], [235, 220, 170], [130, 120, 110], [150, 150, 150], [40, 90, 40]], np.uint8)
                lc = pal[m[..., 3]].astype(np.float32)
                wat = m[..., 0:1].astype(np.float32) / 255
                can = m[..., 2:3].astype(np.float32) / 255
                col = lc * (1 - wat) + np.array([40, 90, 200]) * wat
                col = col * (1 - can * 0.6) + np.array([20, 70, 20]) * can * 0.6
                msk.paste(Image.fromarray(col.clip(0, 255).astype(np.uint8)).resize((S, S), Image.NEAREST), (i * S, j * S))
                g = m[..., 1].astype(np.float32) / 255
                lit.paste(Image.fromarray((np.stack([g * 255, g * 190, g * 90], -1)).clip(0, 255).astype(np.uint8)).resize((S, S), Image.BILINEAR), (i * S, j * S))
            hp = C.path('h', min(L, 7), tx if L <= 7 else tx >> (L - 7), ty if L <= 7 else ty >> (L - 7), 'bin')
            if os.path.exists(hp) and L <= 7:
                hh = H.decode_fast(open(hp, 'rb').read())
                sh = hillshade(hh, C.T(L) / 128)
                el = np.clip((hh + 5) / 150, 0, 1)
                col = np.stack([sh * (150 + 100 * el), sh * (140 + 80 * el), sh * (120 + 40 * el)], -1)
                col[hh < 0.3] = [60, 100, 170]
                hs.paste(Image.fromarray(col.clip(0, 255).astype(np.uint8)).resize((S, S), Image.BILINEAR), (i * S, j * S))
    # tree overlay on imagery (L7 or L8)
    ov = img.copy(); dr = ImageDraw.Draw(ov)
    if L in (7, 8):
        for j in range(h):
            for i in range(w):
                tx, ty = x0 + i, y0 + j
                t7x, t7y = (tx, ty) if L == 7 else (tx >> 1, ty >> 1)
                tp = C.path('t', 7, t7x, t7y, 'bin')
                if not os.path.exists(tp):
                    continue
                arr = TR.decode(open(tp, 'rb').read())
                bx, bz, _, _ = C.bounds(7, t7x, t7y)
                px_per_m = S / C.T(L)
                ox, oz, _, _ = C.bounds(L, x0, y0)
                cols = [(200, 160, 60), (30, 90, 200), (160, 160, 220), (255, 90, 0), (200, 255, 120), (0, 160, 160), (0, 90, 40), (255, 255, 255), (255, 0, 160)]
                for t in arr:
                    X = bx + t['x'] / 65536 * C.T(7); Z = bz + t['z'] / 65536 * C.T(7)
                    u = (X - ox) * px_per_m; v = (Z - oz) * px_per_m
                    if u < -20 or v < -20 or u > w * S + 20 or v > h * S + 20:
                        continue
                    r = max(1.0, t['r'] / 10 * px_per_m)
                    dr.ellipse([u - r, v - r, u + r, v + r], outline=cols[t['kind']])
    # registration overlay: track centreline (red) and OSM roads (cyan) on the tree-overlay panel
    ox, oz, _, _ = C.bounds(L, x0, y0)
    ppm = S / C.T(L)
    tr = C.track()
    u = (tr['X'] - ox) * ppm; v = (tr['Z'] - oz) * ppm
    m = (u > -50) & (v > -50) & (u < w * S + 50) & (v < h * S + 50)
    if m.any():
        pts = list(zip(u[m].tolist(), v[m].tolist()))
        dr.line(pts, fill=(255, 40, 40), width=2)
    try:
        from tiles.osmdata import OSM
        o = OSM()
        x1 = ox + w * C.T(L); z1 = oz + h * C.T(L)
        for ri in o.roads_in(ox, oz, x1, z1):
            if o.road_cls[ri] > 12:
                continue
            q = o.road(ri)
            dr.line(list(zip(((q[:, 0] - ox) * ppm).tolist(), ((q[:, 1] - oz) * ppm).tolist())), fill=(0, 230, 255), width=1)
    except Exception as e:
        print('overlay: no OSM', e)
    os.makedirs(OUTDIR, exist_ok=True)
    out = a.out or os.path.join(OUTDIR, f'sheet_L{L}_{x0}_{y0}_{w}x{h}.png')
    W, Hh = w * S, h * S
    big = Image.new('RGB', (W * 2 + 10, Hh * 2 + 10), (20, 20, 20))
    big.paste(img, (0, 0)); big.paste(ov, (W + 10, 0)); big.paste(msk, (0, Hh + 10)); big.paste(hs if L <= 7 else lit, (W + 10, Hh + 10))
    if L <= 7:
        big2 = Image.new('RGB', (W, Hh))
        big2.paste(lit, (0, 0)); big2.save(out.replace('.png', '_lights.png'))
    scale = min(1.0, 3000 / big.size[0])
    if scale < 1:
        big = big.resize((int(big.size[0] * scale), int(big.size[1] * scale)), Image.LANCZOS)
    big.save(out)
    print(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['validate', 'sheet'])
    ap.add_argument('L', nargs='?', type=int)
    ap.add_argument('tx', nargs='?', type=int)
    ap.add_argument('ty', nargs='?', type=int)
    ap.add_argument('w', nargs='?', type=int, default=3)
    ap.add_argument('h', nargs='?', type=int, default=3)
    ap.add_argument('--out', default=None)
    a = ap.parse_args()
    if a.cmd == 'validate':
        validate(a)
    else:
        sheet(a)


if __name__ == '__main__':
    main()
