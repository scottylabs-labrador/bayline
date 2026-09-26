#!/usr/bin/env python3
"""Bay water in the north strip's imagery: one tone, the one the Globe gives the bays beyond the Bayline tiles.

NAIP bay water is a patchwork (acquisition dates, turbidity, sun glint and haze, no-data fills), and in the shallows the
terrain's water shading keeps most of the photo's colour (shallow = photo x 0.55), so San Pablo Bay showed tile-to-tile
seams, a hazy patch and a hard line where the strip meets the Globe's bay water at lat 38.07, and Richardson Bay a pale
wedge. Every NEW imagery tile of the strip (tile rows y < 0, L2-L9) is re-toned where it is bay water, exactly like the
Globe's shader does it (15_globe.js):
  col = mix(photo, (0.29, 0.35, 0.34) * (0.85 + 0.3 * smoothstep(0.1, 0.45, lum)), k * 0.85)      (linear RGB)
with k = the tile's water mask (the terrain shader's smoothstep(0.45, 0.6, m.r); L8/L9 read their L7 ancestor's mask)
x not the open ocean (the strip's only ocean: west of lon -122.53 below lat 37.91, the Marin coast; the Globe's bay
raster at 210 m misses Richardson Bay and the sloughs, so it is not used) x a feather that fades the change in over the
1.6 km north of the old square's edge (lat 37.8429), whose older tiles keep their water.
Output: data/raw/tiles/fix_water/tiles/img/L/x_y.jpg + manifest.json (path, old_sha256, new_sha256, bytes, px), or with
--test an overlay tree for the dev server (dtest/v2: data/pub/v2 plus the re-toned files, #data=./dtest/v2/).

  python3 tools/metro_world/fix_water.py [--test] [--levels 2-7]
"""
import hashlib, io, json, os, sys, zlib
import numpy as np
import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles import common as C   # noqa: E402

REF = os.path.getmtime(os.path.join(C.WORK, 'coverage_pre_bart.json'))
STAGE = os.path.join(C.WORK, 'fix_water')
TONE = np.array([0.29, 0.35, 0.34], np.float32)
FEATHER = 1600.0                                                     # m north of the old square's edge (Z = Z0)
Q = {8: 86, 9: 84}


def srgb2lin(a):
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def lin2srgb(a):
    a = np.clip(a, 0, 1)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * a ** (1 / 2.4) - 0.055)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)


class Bay:
    def __init__(self):
        j = json.load(open(os.path.join(C.PUB, 'globe', 'baywater.json')))
        self.bb = j['bbox']; im = np.asarray(Image.open(os.path.join(C.PUB, 'globe', 'baywater.png')).convert('L')).astype(np.float32) / 255
        self.im = im                                                 # row 0 = north (lat bb[3])

    def at(self, X, Z):
        lon = -122.10 + X / 88542.2; lat = 37.40 - Z / 110985.1
        n = self.im.shape[0]
        u = (lon - self.bb[0]) / (self.bb[2] - self.bb[0]) * n - 0.5; v = (self.bb[3] - lat) / (self.bb[3] - self.bb[1]) * n - 0.5
        return cv2.remap(self.im, u.astype(np.float32), v.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)


def mask_water(L, x, y, n):
    """the terrain's water weight over the tile at n x n px (the tile's own mask up to L7, else its L7 ancestor's crop)"""
    if L <= 7:
        p = C.path('m', L, x, y, 'bin')
        if not os.path.exists(p):
            return None
        m = np.frombuffer(zlib.decompress(open(p, 'rb').read()), np.uint8).reshape(C.MN, C.MN, 4)[..., 0].astype(np.float32) / 255
        w = cv2.resize(m, (n, n), interpolation=cv2.INTER_LINEAR)
    else:
        k = L - 7; ax, ay = x >> k, y >> k
        p = C.path('m', 7, ax, ay, 'bin')
        if not os.path.exists(p):
            return None
        m = np.frombuffer(zlib.decompress(open(p, 'rb').read()), np.uint8).reshape(C.MN, C.MN, 4)[..., 0].astype(np.float32) / 255
        f = 1 << k; s = C.MN / f; ox, oy = (x - ax * f) * s, (y - ay * f) * s
        M = np.float32([[s / n, 0, ox - 0.5 + 0.5 * s / n], [0, s / n, oy - 0.5 + 0.5 * s / n]])
        w = cv2.warpAffine(m, M, (n, n), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    return smooth(0.45, 0.6, w)


def retone(L, x, y, bay):
    p = C.path('img', L, x, y, 'jpg')
    a = np.asarray(Image.open(p).convert('RGB')); n = a.shape[0]
    wm = mask_water(L, x, y, n)
    if wm is None or wm.max() < 0.02:
        return None
    T = C.SIZE / (1 << L); px = (np.arange(n) + 0.5) / n * T
    X = C.X0 + x * T + px[None, :].repeat(n, 0); Z = C.Z0 + y * T + px[:, None].repeat(n, 1)
    lon = -122.10 + X / 88542.2; lat = 37.40 - Z / 110985.1
    ocean = smooth(-122.525, -122.535, lon) * smooth(37.915, 37.905, lat)
    k = wm * (1.0 - ocean) * np.clip((C.Z0 - Z) / FEATHER, 0, 1)
    if k.max() < 0.02:
        return None
    s = a.astype(np.float32) / 255; lin = srgb2lin(s)
    lum = (s * np.array([0.299, 0.587, 0.114], np.float32)).sum(-1)
    tgt = TONE[None, None, :] * (0.85 + 0.3 * smooth(0.1, 0.45, lum))[..., None]
    out = lin + (tgt - lin) * (k * 0.85)[..., None]
    u8 = np.clip(lin2srgb(out) * 255 + 0.5, 0, 255).astype(np.uint8)
    return C.jpeg_bytes(u8, Q.get(L, 87)), float(k.max()), float((k > 0.1).mean())


def main():
    test = '--test' in sys.argv
    lv = (2, 9)
    if '--levels' in sys.argv:
        a, b = sys.argv[sys.argv.index('--levels') + 1].split('-'); lv = (int(a), int(b))
    bay = Bay()
    out_root = os.path.join(ROOT, 'dtest', 'v2', 'tiles', 'img') if test else os.path.join(STAGE, 'tiles', 'img')
    man = []; n_seen = 0
    for L in range(lv[0], lv[1] + 1):
        d = os.path.join(C.PUB, 'img', str(L))
        for f in sorted(os.listdir(d)):
            if not f.endswith('.jpg') or '_test' in f:
                continue
            x, y = map(int, f[:-4].split('_'))
            if y >= 0:
                continue                                              # (the strip only)
            n_seen += 1
            r = retone(L, x, y, bay)
            if r is None:
                continue
            b, kmax, frac = r
            q = os.path.join(out_root, str(L), f); C.ensure_dir(q); C.write_atomic(q, b)
            old = C.path('img', L, x, y, 'jpg')
            man.append({'path': f'tiles/img/{L}/{f}', 'old_sha256': hashlib.sha256(open(old, 'rb').read()).hexdigest(),
                        'new_sha256': hashlib.sha256(b).hexdigest(), 'bytes': len(b), 'px': Image.open(io.BytesIO(b)).size[0],
                        'bay_max': round(kmax, 2), 'bay_frac': round(frac, 3)})
        print(f'L{L}: {sum(1 for m in man if m["path"].startswith(f"tiles/img/{L}/"))} re-toned', flush=True)
    if not test:
        json.dump({'what': 'north-strip imagery tiles with bay water re-toned to the Globe bay tone (fix_water.py)',
                   'staged_root': 'data/raw/tiles/fix_water', 'files': man}, open(os.path.join(STAGE, 'manifest.json'), 'w'), indent=1)
    print(f'{len(man)} of {n_seen} strip tiles re-toned -> {out_root}', flush=True)


if __name__ == '__main__':
    main()
