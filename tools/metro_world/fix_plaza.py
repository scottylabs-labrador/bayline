#!/usr/bin/env python3
"""Downtown San Francisco: hold the lidar detail (tiles/h9) at zero on paved ground, like under the streets.

Plazas and wide sidewalks that OSM does not map as streets or plaza areas draw as bare lidar ground, with bumps up to
~1 m (and pits: stairwells, planters) - STATIONS saw it at Market & Post (Montgomery St entrance A1). The h9 tiles are
the existing L7 surface + lidar detail; here the detail is multiplied by a weight that is 0 on paved ground (the ground
material tiles: asphalt, concrete, and roof - a plaza the classifier took for a roof; real roofs are under buildings
anyway) and ramps back to full over 3 m into unpaved ground (parks, trees), inside the downtown region (feathered over
100 m). Every term is a function of world position, so neighbouring tiles agree on their shared edges; tiles that do
not change are not written. Everything else of each tile stays bit-identical (decode + re-encode is lossless).
Output: data/raw/tiles/fix_plaza/tiles/h9/{8,9}/x_y.bin + manifest.json, or --test: the dev overlay (dtest/v2).

  python3 tools/metro_world/fix_plaza.py [--test]
"""
import hashlib, json, os, sys, zlib
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles import common as C, lidar as LD, heights as H_   # noqa: E402

STAGE = os.path.join(C.WORK, 'fix_plaza')
REGION = (37.770, -122.428, 37.808, -122.385)                       # lat0, lon0, lat1, lon1: Civic Center .. Embarcadero
FEATHER = 100.0
PAVED = (7, 8, 9)
RAMP = 3.0
STEP = LD.STEP9


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)


def region_w(X, Z):
    """1 inside the downtown region, 0 beyond it + FEATHER m"""
    xa, xb = (REGION[1] + 122.10) * 88542.2, (REGION[3] + 122.10) * 88542.2
    za, zb = (37.40 - REGION[2]) * 110985.1, (37.40 - REGION[0]) * 110985.1
    dx = np.maximum(np.maximum(xa - X, X - xb), 0); dz = np.maximum(np.maximum(za - Z, Z - zb), 0)
    return 1.0 - smooth(0.0, FEATHER, np.hypot(dx, dz))


def mat_mosaic(tx7, ty7):
    """3 x 3 L7 ground-material tiles around (tx7, ty7): 1536 x 1536 class ids (0 where missing)"""
    out = np.zeros((1536, 1536), np.uint8)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            p = os.path.join(C.PUB, 'mat', '7', f'{tx7 + dx}_{ty7 + dy}.bin')
            if os.path.exists(p):
                out[(dy + 1) * 512:(dy + 2) * 512, (dx + 1) * 512:(dx + 2) * 512] = np.frombuffer(zlib.decompress(open(p, 'rb').read()), np.uint8).reshape(512, 512)
    return out


def weight(tx8, ty8):
    """the detail weight on the L8 tile's 257 x 257 vertex grid"""
    tx7, ty7 = tx8 >> 1, ty8 >> 1
    mos = mat_mosaic(tx7, ty7)
    paved = np.isin(mos, PAVED)
    dist = cv2.distanceTransform((~paved).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE) * STEP   # m to the nearest paved cell
    wcell = smooth(0.0, RAMP, dist).astype(np.float32)                                                   # 0 on paved ground
    # vertex (i, j) of the L8 grid sits at a mat cell corner: sample the cell field there (bilinear between cell centres)
    ox = 512 + (tx8 - tx7 * 2) * 256; oy = 512 + (ty8 - ty7 * 2) * 256
    u = (ox + np.arange(257) - 0.5).astype(np.float32); v = (oy + np.arange(257) - 0.5).astype(np.float32)
    U, V = np.meshgrid(u, v)
    w = cv2.remap(wcell, U, V, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    x0, z0 = C.X0 + tx8 * 400.0, C.Z0 + ty8 * 400.0
    g = np.arange(257) * STEP; X, Z = np.meshgrid(x0 + g, z0 + g)
    r = region_w(X, Z)
    return 1.0 - r * (1.0 - w)


def main():
    test = '--test' in sys.argv
    out_root = os.path.join(ROOT, 'dtest', 'v2', 'tiles', 'h9') if test else os.path.join(STAGE, 'tiles', 'h9')
    guard = os.path.realpath(os.path.join(ROOT, 'dtest') if test else STAGE)
    idx = json.load(open(os.path.join(C.PUB, 'h9', 'index.json')))
    xa, xb = (REGION[1] + 122.10) * 88542.2 - FEATHER, (REGION[3] + 122.10) * 88542.2 + FEATHER
    za, zb = (37.40 - REGION[2]) * 110985.1 - FEATHER, (37.40 - REGION[0]) * 110985.1 + FEATHER
    man = []
    for (x, y, m, o) in idx['l8'] + idx.get('l8n', []):
        x0, z0 = C.X0 + x * 400.0, C.Z0 + y * 400.0
        if x0 > xb or x0 + 400 < xa or z0 > zb or z0 + 400 < za:
            continue
        base = LD._old7_on_grid(x, y)
        if base is None:
            continue
        w = weight(x, y)
        if w.min() > 0.999:
            continue
        jobs = [(8, x, y, base[::2, ::2], w[::2, ::2])]
        for b in range(4):
            if m & (1 << b):
                dx, dy = b & 1, b >> 1
                jobs.append((9, 2 * x + dx, 2 * y + dy, base[dy * 128:dy * 128 + 129, dx * 128:dx * 128 + 129], w[dy * 128:dy * 128 + 129, dx * 128:dx * 128 + 129]))
        for (L, a, b_, bs, ww) in jobs:
            p = os.path.join(C.PUB, 'h9', str(L), f'{a}_{b_}.bin')
            if not os.path.exists(p):
                continue
            old = open(p, 'rb').read()
            h = H_.decode_fast(old, LD.QS, -o)
            new_h = bs + (h - bs) * ww
            new = H_.encode(new_h.astype(np.float32), LD.QS, -o)
            if new == old:
                continue
            q = os.path.join(out_root, str(L), f'{a}_{b_}.bin'); C.ensure_dir(q)
            if not os.path.realpath(os.path.dirname(q)).startswith(guard + os.sep):
                raise SystemExit(f'{q} resolves outside {guard}: refusing to write there')
            C.write_atomic(q, new)
            man.append({'path': f'tiles/h9/{L}/{a}_{b_}.bin', 'old_sha256': hashlib.sha256(old).hexdigest(), 'new_sha256': hashlib.sha256(new).hexdigest(),
                        'bytes': len(new), 'max_change_m': round(float(np.abs(new_h - h).max()), 2)})
    if not test:
        json.dump({'what': 'downtown San Francisco h9 tiles with the lidar detail held at zero on paved ground (fix_plaza.py)',
                   'staged_root': 'data/raw/tiles/fix_plaza', 'files': man}, open(os.path.join(STAGE, 'manifest.json'), 'w'), indent=1)
    print(len(man), 'h9 tiles changed ->', out_root, 'max change m:', max([m_['max_change_m'] for m_ in man] or [0]), flush=True)


if __name__ == '__main__':
    main()
