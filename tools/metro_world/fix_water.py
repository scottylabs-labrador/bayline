#!/usr/bin/env python3
"""Bay water in the north strip's imagery: one smooth tone field instead of NAIP's patchwork.

NAIP bay water is a patchwork (acquisition dates, turbidity, sun glint, haze), and in the shallows the terrain's water
shading keeps most of the photo's colour (shallow = photo x 0.55): San Pablo Bay showed tile-to-tile seams, a hazy patch
and a hard line where the strip meets the Globe's bay water at lat 38.07; Sausalito a pale glint wedge.

1. A tone field over the strip and the 1.6 km of the old square south of its edge (lat 37.8285 .. 38.0736), 100 m cells:
   the median colour (linear RGB) of each cell's open-water pixels in the L7 imagery (water mask > 0.6, ground 0.5 m
   or more below sea level, not glint (sRGB luminance < 0.45) nor no-data black), holes filled from the neighbours, smoothed (Gaussian, 600 m). Toward the strip's north edge it
   blends into the Globe's bay tone (the last 4 km), so the two meet without a line; the old square's water sets it at
   the south end, so the change fades into what is there.
2. Every imagery tile over that area (L2-L9) is re-toned where it is open water (the terrain shader's mask weight,
   smoothstep(0.45, 0.6, m.r), x the ground below sea level (0 .. -0.5 m ramp: marshes and lakes stay as they are);
   L8/L9 read their L7 ancestor's mask and heights; not the open ocean west of lon -122.53 below lat
   37.91): col = mix(photo, field, k x 0.85), glint (luminance over 0.45) replaced fully. In the old square's band the
   weight fades out over the 1.6 km (glint excepted: it goes to the band's far edge), so its older tiles keep their water.
3. Richardson Bay (BAY_BOXES): a low-tide NAIP pass shows its north part as pale mudflats with straight edges, and the
   mask calls it land; where the ground there is below sea level it becomes water in the imagery and the masks (m tiles).
Output: data/raw/tiles/fix_water/tiles/img/L/x_y.jpg + manifest.json (path, old_sha256, new_sha256, bytes, px), or with
--test an overlay tree for the dev server (dtest/v2, #data=./dtest/v2/).

  python3 tools/metro_world/fix_water.py [--test] [--levels 2-9]
"""
import hashlib, io, json, os, sys, zlib
import numpy as np
import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles import common as C   # noqa: E402

STAGE = os.path.join(C.WORK, 'fix_water')
GLOBE = np.array([0.29, 0.35, 0.34], np.float32)                   # the Globe's bay tone (15_globe.js), linear
BAND = 1600.0                                                        # m of the old square re-toned (fading out)
ZS = C.Z0 + BAND                                                     # south end of the field (world z)
ZN = C.Z0 - C.SIZE / 4                                               # the strip's north edge (lat 38.0736)
CELL = 100.0
GLINT = 0.45
Q = {8: 86, 9: 84}
# bays whose water the mask misses (a low-tide NAIP pass of pale mudflats with straight edges), made water where the
# ground is below sea level, in the imagery AND the masks: Richardson Bay (lat0, lon0, lat1, lon1)
BAY_BOXES = [(37.858, -122.535, 37.900, -122.465)]


def in_boxes(X, Z):
    lon = -122.10 + X / 88542.2; lat = 37.40 - Z / 110985.1
    r = np.zeros_like(X, dtype=np.float32)
    for (a0, o0, a1, o1) in BAY_BOXES:
        r = np.maximum(r, ((lat >= a0) & (lat <= a1) & (lon >= o0) & (lon <= o1)).astype(np.float32))
    return r


def tile_in_boxes(L, x, y):
    T = C.SIZE / (1 << L)
    for (a0, o0, a1, o1) in BAY_BOXES:
        za, zb = (37.40 - a1) * 110985.1, (37.40 - a0) * 110985.1; xa, xb = (o0 + 122.10) * 88542.2, (o1 + 122.10) * 88542.2
        if C.Z0 + y * T < zb and C.Z0 + (y + 1) * T > za and C.X0 + x * T < xb and C.X0 + (x + 1) * T > xa:
            return True
    return False


def fix_mask(L, x, y):
    """the mask tile (L <= 7) with the boxes' below-sea-level ground made water, or None when unchanged"""
    p = C.path('m', L, x, y, 'bin')
    if L > 7 or not os.path.exists(p) or not tile_in_boxes(L, x, y):
        return None
    m = np.frombuffer(zlib.decompress(open(p, 'rb').read()), np.uint8).reshape(C.MN, C.MN, 4).copy()
    n = C.MN; T = C.SIZE / (1 << L); px = (np.arange(n) + 0.5) / n * T
    X = C.X0 + x * T + px[None, :].repeat(n, 0); Z = C.Z0 + y * T + px[:, None].repeat(n, 1)
    hh = height(L, x, y, n)
    if hh is None:
        return None
    wv = np.clip(255 * smooth(0.0, -0.3, hh) * in_boxes(X, Z) + 0.5, 0, 255).astype(np.uint8)
    new = np.maximum(m[..., 0], wv)
    if (new != m[..., 0]).sum() < 4:
        return None
    m[..., 0] = new
    return zlib.compress(m.tobytes(), 9)


def srgb2lin(a):
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def lin2srgb(a):
    a = np.clip(a, 0, 1)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * a ** (1 / 2.4) - 0.055)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)


def mask_raw(L, x, y):
    p = C.path('m', L, x, y, 'bin')
    if not os.path.exists(p):
        return None
    return np.frombuffer(zlib.decompress(open(p, 'rb').read()), np.uint8).reshape(C.MN, C.MN, 4)[..., 0].astype(np.float32) / 255


def mask_water(L, x, y, n):
    """the terrain's water weight over the tile at n x n px (the tile's own mask up to L7, else its L7 ancestor's crop)"""
    if L <= 7:
        m = mask_raw(L, x, y)
        if m is None:
            return None
        w = cv2.resize(m, (n, n), interpolation=cv2.INTER_LINEAR)
    else:
        k = L - 7; ax, ay = x >> k, y >> k
        m = mask_raw(7, ax, ay)
        if m is None:
            return None
        f = 1 << k; s = C.MN / f; ox, oy = (x - ax * f) * s, (y - ay * f) * s
        M = np.float32([[s / n, 0, ox - 0.5 + 0.5 * s / n], [0, s / n, oy - 0.5 + 0.5 * s / n]])
        w = cv2.warpAffine(m, M, (n, n), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    return smooth(0.45, 0.6, w)


def height(L, x, y, n):
    """the base heights (m) over the tile at n x n px: tiles/h up to L7, the L7 ancestor's crop for L8 / L9"""
    from tiles import heights as H
    k = max(0, L - 7); ax, ay = x >> k, y >> k
    p = C.path('h', min(L, 7), ax, ay, 'bin')
    if not os.path.exists(p):
        return None
    hh = H.decode_fast(open(p, 'rb').read()).astype(np.float32); m = hh.shape[0]
    if k == 0:
        return cv2.resize(hh, (n, n), interpolation=cv2.INTER_LINEAR)
    f = 1 << k; s = (m - 1) / f; ox, oy = (x - ax * f) * s, (y - ay * f) * s
    M = np.float32([[s / n, 0, ox + 0.5 * s / n], [0, s / n, oy + 0.5 * s / n]])      # (vertex grid: corners at 0 and m-1)
    return cv2.warpAffine(hh, M, (n, n), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)


def ocean_at(X, Z):
    lon = -122.10 + X / 88542.2; lat = 37.40 - Z / 110985.1
    return smooth(-122.525, -122.535, lon) * smooth(37.915, 37.905, lat)


class Field:
    """the smooth water tone (linear RGB) over x in the square's width, z in [ZN, ZS]"""
    def __init__(self):
        cache = os.path.join(C.WORK, 'fix_water_field.npz')
        nx = int(C.SIZE / CELL); nz = int((ZS - ZN) / CELL)
        self.nx, self.nz = nx, nz
        if os.path.exists(cache):
            self.F = np.load(cache)['F']; return
        acc = np.zeros((nz, nx, 3), np.float32); have = np.zeros((nz, nx), bool)
        T = C.SIZE / 128; per = int(T / CELL)                       # 8 cells per L7 tile
        y0, y1 = int(np.floor((ZN - C.Z0) / T)), int(np.ceil((ZS - C.Z0) / T))
        for ty in range(y0, y1):
            for tx in range(128):
                p = C.path('img', 7, tx, ty, 'jpg')
                if not os.path.exists(p):
                    continue
                m = mask_raw(7, tx, ty)
                if m is None or m.max() < 0.6:
                    continue
                a = np.asarray(Image.open(p).convert('RGB')).astype(np.float32) / 255
                n = a.shape[0]; w = cv2.resize(m, (n, n), interpolation=cv2.INTER_LINEAR)
                lum = (a * np.array([0.299, 0.587, 0.114], np.float32)).sum(-1)
                hh = height(7, tx, ty, n)
                if hh is None:
                    continue
                ok = (w > 0.6) & (lum < GLINT) & (lum > 0.03) & (hh < -0.5)          # (open water: below sea level; not no-data black)
                lin = srgb2lin(a); c = n // per
                for j in range(per):
                    gz = int((C.Z0 + ty * T + j * CELL - ZN) / CELL)
                    if not (0 <= gz < nz):
                        continue
                    for i in range(per):
                        o = ok[j * c:(j + 1) * c, i * c:(i + 1) * c]
                        if o.mean() < 0.25:
                            continue
                        acc[gz, tx * per + i] = np.median(lin[j * c:(j + 1) * c, i * c:(i + 1) * c][o], 0); have[gz, tx * per + i] = True
            print(f'  field row {ty}: {int(have.sum())} water cells', flush=True)
        # fill the holes from the neighbours (normalized convolution at growing scales), then smooth
        filled = acc.copy(); got = have.copy(); hv = have.astype(np.float32)
        for s in (2, 4, 8, 16, 32, 64, 128):
            num = cv2.GaussianBlur(acc * hv[..., None], (0, 0), s); den = cv2.GaussianBlur(hv, (0, 0), s)
            hole = ~got & (den > 1e-4)
            filled[hole] = (num / np.maximum(den, 1e-6)[..., None])[hole]; got |= hole
        filled[~got] = GLOBE
        F = cv2.GaussianBlur(filled, (0, 0), 6)
        # the north end meets the Globe's bay tone (the last 4 km)
        zc = ZN + (np.arange(nz) + 0.5) * CELL
        t = smooth(ZN + 4000, ZN + 500, zc)[:, None, None]
        self.F = (F * (1 - t) + GLOBE[None, None, :] * t).astype(np.float32)
        np.savez_compressed(cache, F=self.F)

    def at(self, X, Z):
        u = ((X - C.X0) / CELL - 0.5).astype(np.float32); v = ((Z - ZN) / CELL - 0.5).astype(np.float32)
        return np.stack([cv2.remap(self.F[..., c], u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE) for c in range(3)], -1)


def retone(L, x, y, field):
    p = C.path('img', L, x, y, 'jpg')
    a = np.asarray(Image.open(p).convert('RGB')); n = a.shape[0]
    wm = mask_water(L, x, y, n)
    if wm is None or (wm.max() < 0.02 and not tile_in_boxes(L, x, y)):
        return None
    T = C.SIZE / (1 << L); px = (np.arange(n) + 0.5) / n * T
    X = C.X0 + x * T + px[None, :].repeat(n, 0); Z = C.Z0 + y * T + px[:, None].repeat(n, 1)
    s = a.astype(np.float32) / 255
    lum = (s * np.array([0.299, 0.587, 0.114], np.float32)).sum(-1)
    glint = smooth(GLINT - 0.05, GLINT + 0.1, lum)
    band = np.clip((ZS - Z) / BAND, 0, 1)                            # 1 in the strip, fading out in the square's band
    fade = np.where(Z > C.Z0, np.maximum(band, glint * (Z < ZS)), 1.0)
    hh = height(L, x, y, n)
    if hh is None:
        return None
    depth = np.maximum(smooth(0.0, -0.5, hh), glint * smooth(1.5, 0.5, hh))      # (open water; glint also on the shallow flats)
    if tile_in_boxes(L, x, y):
        wm = np.maximum(wm, smooth(0.0, -0.3, hh) * in_boxes(X, Z)); depth = np.maximum(depth, smooth(0.0, -0.3, hh) * in_boxes(X, Z))
    k = wm * depth * (1.0 - ocean_at(X, Z)) * fade           # (marsh and lakes stay)
    if k.max() < 0.02:
        return None
    lin = srgb2lin(s); tgt = field.at(X, Z)
    share = 0.85 + 0.15 * np.maximum(glint, smooth(0.04, 0.02, lum))      # (glint and no-data black: replaced fully)
    out = lin + (tgt - lin) * (k * share)[..., None]
    u8 = np.clip(lin2srgb(out) * 255 + 0.5, 0, 255).astype(np.uint8)
    return C.jpeg_bytes(u8, Q.get(L, 87)), float(k.max())


def safe(q, test):
    """never write through a link into data/pub: the output's real directory must be inside the staging / test tree"""
    root = os.path.realpath(os.path.join(ROOT, 'dtest') if test else STAGE)
    C.ensure_dir(q)
    if not os.path.realpath(os.path.dirname(q)).startswith(root + os.sep):
        raise SystemExit(f'{q} resolves outside {root}: refusing to write there')


def main():
    test = '--test' in sys.argv
    lv = (2, 9)
    if '--levels' in sys.argv:
        a, b = sys.argv[sys.argv.index('--levels') + 1].split('-'); lv = (int(a), int(b))
    bb = None                                                         # --bbox lat0,lon0,lat1,lon1 (tests)
    if '--bbox' in sys.argv:
        la0, lo0, la1, lo1 = map(float, sys.argv[sys.argv.index('--bbox') + 1].split(','))
        za, zb = sorted([(37.40 - la0) * 110985.1, (37.40 - la1) * 110985.1]); xa, xb = sorted([(lo0 + 122.10) * 88542.2, (lo1 + 122.10) * 88542.2])
        bb = (za, zb, xa, xb)
    field = Field(); print('field', field.F.shape, 'range', field.F.min((0, 1)).round(3), field.F.max((0, 1)).round(3), flush=True)
    out_root = os.path.join(ROOT, 'dtest', 'v2', 'tiles', 'img') if test else os.path.join(STAGE, 'tiles', 'img')
    man = []; n_seen = 0
    for L in range(lv[0], lv[1] + 1):
        d = os.path.join(C.PUB, 'img', str(L)); T = C.SIZE / (1 << L)
        for f in sorted(os.listdir(d)):
            if not f.endswith('.jpg') or '_test' in f:
                continue
            x, y = map(int, f[:-4].split('_'))
            if bb and not (bb[0] <= C.Z0 + (y + 1) * T and C.Z0 + y * T <= bb[1] and bb[2] <= C.X0 + (x + 1) * T and C.X0 + x * T <= bb[3]):
                continue
            if C.Z0 + y * T >= ZS:
                continue                                              # (the strip and the band south of its edge)
            n_seen += 1
            r = retone(L, x, y, field)
            if r is None:
                continue
            b, kmax = r
            q = os.path.join(out_root, str(L), f)
            safe(q, test)
            C.ensure_dir(q); C.write_atomic(q, b)
            old = C.path('img', L, x, y, 'jpg')
            man.append({'path': f'tiles/img/{L}/{f}', 'old_sha256': hashlib.sha256(open(old, 'rb').read()).hexdigest(),
                        'new_sha256': hashlib.sha256(b).hexdigest(), 'bytes': len(b), 'px': Image.open(io.BytesIO(b)).size[0],
                        'old_px': Image.open(old).size[0], 'k_max': round(kmax, 2)})
        for f in sorted(os.listdir(os.path.join(C.PUB, 'm', str(L)))) if L <= 7 else []:
            if not f.endswith('.bin'):
                continue
            x, y = map(int, f[:-4].split('_'))
            b = fix_mask(L, x, y)
            if b is None:
                continue
            q = os.path.join(out_root.replace(os.sep + 'img', os.sep + 'm'), str(L), f)
            safe(q, test)
            C.ensure_dir(q); C.write_atomic(q, b)
            old = C.path('m', L, x, y, 'bin')
            man.append({'path': f'tiles/m/{L}/{f}', 'old_sha256': hashlib.sha256(open(old, 'rb').read()).hexdigest(),
                        'new_sha256': hashlib.sha256(b).hexdigest(), 'bytes': len(b), 'px': C.MN, 'old_px': C.MN, 'k_max': 1.0})
        print(f'L{L}: {sum(1 for m in man if m["path"].startswith(f"tiles/img/{L}/"))} re-toned, '
              f'{sum(1 for m in man if m["path"].startswith(f"tiles/m/{L}/"))} masks', flush=True)
    if not test:
        json.dump({'what': 'imagery tiles of the north strip (and 1.6 km of the old square south of its edge) with their bay water '
                           're-toned to one smooth field (fix_water.py)', 'staged_root': 'data/raw/tiles/fix_water', 'files': man},
                  open(os.path.join(STAGE, f'manifest_L{lv[0]}-{lv[1]}.json'), 'w'), indent=1)
        # the set's manifest: every level range made so far
        allm = []
        for f in sorted(os.listdir(STAGE)):
            if f.startswith('manifest_L') and f.endswith('.json'):
                allm += json.load(open(os.path.join(STAGE, f)))['files']
        json.dump({'what': 'imagery tiles of the north strip (and 1.6 km of the old square south of its edge) with their bay water '
                           're-toned to one smooth field, plus the Richardson Bay masks (fix_water.py)', 'staged_root': 'data/raw/tiles/fix_water',
                   'files': sorted(allm, key=lambda m: m['path'])}, open(os.path.join(STAGE, 'manifest.json'), 'w'), indent=1)
    print(f'{len(man)} of {n_seen} tiles re-toned -> {out_root}', flush=True)


if __name__ == '__main__':
    main()
