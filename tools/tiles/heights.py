"""Height tiles (SPEC_v2: tiles/h/L/tx_ty.bin, L0-L7).

129x129 samples at X0+tx*T+i*T/128 (i = column, west->east; j = row, north->south), q = round((h+200)*16) as
uint16, row-major (i fastest). Stored as MED-predicted zigzag residuals, little-endian uint16 interleaved
(NOT split into byte planes), then zlib. Decoder (identical predictor to terrain.bin):
    r = (zz >>> 1) ^ -(zz & 1);  a = left, b = up, c = up-left;  row 0: pred = left;  col 0: pred = up;
    (0,0): pred = 0;  else pred = c >= max(a,b) ? min(a,b) : c <= min(a,b) ? max(a,b) : a + b - c;  q = r + pred.

Sources: AWS terrarium z15 (L6, L7; identical sampling function so shared vertices match exactly), z13 (L5),
L4..L0 decimated from L5 (exact vertex consistency L0-L5). Carved along the track like tools/bake_world.py,
with station platform zones flattened to bed level. Bathymetry kept.
"""
import io, math, os, threading, zlib
from collections import OrderedDict
import numpy as np
from PIL import Image
from scipy.spatial import cKDTree
from . import fetch
from .common import (HN, T, X0, Z0, bounds, w2ll, track, path, write_atomic, level_tiles, log, children)

# ------------------------------------------------------------------ terrarium sampler
_cache = OrderedDict()
_clock = threading.Lock()
CACHE_MAX = 900


def _tile(z, x, y):
    k = (z, x, y)
    with _clock:
        if k in _cache:
            _cache.move_to_end(k)
            return _cache[k]
    n = 1 << z
    if not (0 <= x < n and 0 <= y < n):
        a = np.zeros((256, 256), np.float32)
    else:
        try:
            b = fetch.terrarium(z, x, y)
            im = np.asarray(Image.open(io.BytesIO(b)).convert('RGB')).astype(np.float32)
            a = im[..., 0] * 256.0 + im[..., 1] + im[..., 2] / 256.0 - 32768.0
        except IOError:
            a = np.zeros((256, 256), np.float32)
    with _clock:
        _cache[k] = a
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)
    return a


def merc_px(z, lat, lon):
    n = (1 << z) * 256.0
    px = (np.asarray(lon) + 180.0) / 360.0 * n
    lr = np.radians(np.asarray(lat))
    py = (1.0 - np.log(np.tan(lr) + 1.0 / np.cos(lr)) / math.pi) / 2.0 * n
    return px, py


def sample(z, lat, lon):
    """Bilinear terrarium height at lat/lon arrays (pixel centres at +0.5, like tools/dem.py)."""
    px, py = merc_px(z, lat, lon)
    px = px - 0.5
    py = py - 0.5
    x0 = np.floor(px).astype(np.int64)
    y0 = np.floor(py).astype(np.int64)
    fx = (px - x0).astype(np.float32)
    fy = (py - y0).astype(np.float32)
    tx0, tx1 = int(x0.min()) // 256, int(x0.max() + 1) // 256
    ty0, ty1 = int(y0.min()) // 256, int(y0.max() + 1) // 256
    W = (tx1 - tx0 + 1) * 256
    H = (ty1 - ty0 + 1) * 256
    m = np.zeros((H, W), np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            m[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = _tile(z, tx, ty)
    xi = x0 - tx0 * 256
    yi = y0 - ty0 * 256
    return (m[yi, xi] * (1 - fx) * (1 - fy) + m[yi, xi + 1] * fx * (1 - fy)
            + m[yi + 1, xi] * (1 - fx) * fy + m[yi + 1, xi + 1] * fx * fy)


def terrarium_tiles_for(L, tiles, z):
    """Set of terrarium (z,x,y) tiles needed to sample the given tiles (for prefetching)."""
    need = set()
    for (tx, ty) in tiles:
        x0, z0, x1, z1 = bounds(L, tx, ty)
        lat_n, lon_w = w2ll(x0, z0)
        lat_s, lon_e = w2ll(x1, z1)
        pxa, pya = merc_px(z, lat_n, lon_w)
        pxb, pyb = merc_px(z, lat_s, lon_e)
        for yy in range(int(pya - 2) // 256, int(pyb + 2) // 256 + 1):
            for xx in range(int(pxa - 2) // 256, int(pxb + 2) // 256 + 1):
                need.add((z, xx, yy))
    return need


# ------------------------------------------------------------------ carve
_kd = None
_zones = None


def _carver():
    global _kd, _zones
    if _kd is None:
        tr = track()
        _kd = cKDTree(np.stack([tr['X'], tr['Z']], 1))
        zones = []
        feat = tr['feat']; step = tr['step']
        for p in feat.get('platforms', []):
            s0, s1, off = p['s0'], p['s1'], p['off']
            zones.append((s0 - 12.0, s1 + 12.0, abs(off) + 9.0))
        for st in feat.get('stations', []):
            zones.append((st['s'] - 110.0, st['s'] + 110.0, max(12.0, abs(st.get('off', 0.0)) * 0.5 + 8.0)))
        _zones = zones
    return _kd, _zones


def carve(H, X, Z):
    """Carve heights H (float32, any shape) at world coords X, Z (same shape) along the track, in place."""
    tr = track()
    kd, zones = _carver()
    flat = np.stack([X.ravel(), Z.ravel()], 1)
    d, k = kd.query(flat, distance_upper_bound=140.0)
    ok = np.isfinite(d)
    if not ok.any():
        return H
    Hf = H.reshape(-1)
    idx = np.where(ok)[0]
    kk = np.clip(k[idx], 0, tr['n'] - 1)
    dd = d[idx]
    bed = tr['Y'][kk] - 1.0
    tun = tr['tunnel'][kk]
    w = np.clip(1.0 - (dd - 45.0) / 95.0, 0.0, 1.0)
    h = Hf[idx].astype(np.float64)
    cut = (~tun) & (h > bed)
    h[cut] = h[cut] - (h[cut] - bed[cut]) * w[cut]
    fill = (~tun) & (h < bed) & (dd < 70.0)
    h[fill] = h[fill] + np.clip(bed[fill] - 1.5 - h[fill], 0, None) * (w[fill] * 0.6)
    # station / platform zones: flatten to bed level (cut fully, fill to 0.4 m below bed) with a 15 m soft edge
    s = kk * tr['step']
    lat = (flat[idx, 0] - tr['X'][kk]) * tr['rx'][kk] + (flat[idx, 1] - tr['Z'][kk]) * tr['rz'][kk]
    wz = np.zeros_like(h)
    for (a, b, r) in zones:
        m = (s > a - 15.0) & (s < b + 15.0)
        if not m.any():
            continue
        ws = np.clip(1.0 - np.maximum(a - s[m], s[m] - b) / 15.0, 0.0, 1.0)
        wl = np.clip(1.0 - (np.abs(lat[m]) - r) / 15.0, 0.0, 1.0)
        wz[m] = np.maximum(wz[m], np.minimum(ws, wl))
    wz[tun] = 0.0
    m = wz > 0
    if m.any():
        hi = m & (h > bed)
        h[hi] = h[hi] - (h[hi] - bed[hi]) * wz[hi]
        lo = m & (h < bed - 0.4)
        h[lo] = h[lo] + (bed[lo] - 0.4 - h[lo]) * wz[lo]
    Hf[idx] = h.astype(Hf.dtype)
    return H


# ------------------------------------------------------------------ encode / decode
def med_pred(q):
    """MED prediction array for int array q (129x129) exactly as the JS decoder computes it."""
    pred = np.zeros_like(q)
    pred[0, 1:] = q[0, :-1]
    pred[1:, 0] = q[:-1, 0]
    a = q[1:, :-1]; b = q[:-1, 1:]; c = q[:-1, :-1]
    mx = np.maximum(a, b); mn = np.minimum(a, b)
    p = np.where(c >= mx, mn, np.where(c <= mn, mx, a + b - c))
    pred[1:, 1:] = p
    return pred


def encode(H, scale=16.0, offset=200.0):
    """q = round((h + offset) * scale): tiles/h uses 1/16 m; tiles/h9 (lidar) 1/64 m (see its index.json)."""
    q = np.clip(np.round((H.astype(np.float64) + offset) * scale), 0, 65535).astype(np.int64)
    r = q - med_pred(q)
    assert r.min() >= -32768 and r.max() <= 32767, (r.min(), r.max())
    zz = ((r << 1) ^ (r >> 63)) & 0xFFFF
    return zlib.compress(zz.astype('<u2').tobytes(), 9)


def decode(blob):
    zz = np.frombuffer(zlib.decompress(blob), '<u2').astype(np.int64).reshape(HN, HN)
    r = (zz >> 1) ^ -(zz & 1)
    q = np.zeros((HN, HN), np.int64)
    for j in range(HN):
        for i in range(HN):
            if j == 0 and i == 0:
                q[j, i] = r[j, i]; continue
            if j == 0:
                a = b = c = q[j, i - 1]
            elif i == 0:
                a = b = c = q[j - 1, i]
            else:
                a = q[j, i - 1]; b = q[j - 1, i]; c = q[j - 1, i - 1]
            mx = max(a, b); mn = min(a, b)
            q[j, i] = r[j, i] + (mn if c >= mx else (mx if c <= mn else a + b - c))
    return q.astype(np.float32) / 16.0 - 200.0


try:
    from numba import njit

    @njit(cache=True)
    def _med_decode(r):
        n = r.shape[0]
        q = np.zeros((n, n), np.int64)
        for j in range(n):
            for i in range(n):
                if j == 0 and i == 0:
                    q[j, i] = r[j, i]
                    continue
                if j == 0:
                    a = q[j, i - 1]; b = a; c = a
                elif i == 0:
                    b = q[j - 1, i]; a = b; c = b
                else:
                    a = q[j, i - 1]; b = q[j - 1, i]; c = q[j - 1, i - 1]
                mx = a if a > b else b
                mn = a if a < b else b
                if c >= mx:
                    p = mn
                elif c <= mn:
                    p = mx
                else:
                    p = a + b - c
                q[j, i] = r[j, i] + p
        return q
except Exception:          # numba missing: slow pure-python fallback
    def _med_decode(r):
        n = r.shape[0]; q = np.zeros((n, n), np.int64)
        for j in range(n):
            for i in range(n):
                if j == 0 and i == 0:
                    q[j, i] = r[j, i]; continue
                if j == 0:
                    a = b = c = q[j, i - 1]
                elif i == 0:
                    a = b = c = q[j - 1, i]
                else:
                    a = q[j, i - 1]; b = q[j - 1, i]; c = q[j - 1, i - 1]
                mx = max(a, b); mn = min(a, b)
                q[j, i] = r[j, i] + (mn if c >= mx else (mx if c <= mn else a + b - c))
        return q


def decode_fast(blob, scale=16.0, offset=200.0):
    zz = np.frombuffer(zlib.decompress(blob), '<u2').astype(np.int64).reshape(HN, HN)
    r = (zz >> 1) ^ -(zz & 1)
    return _med_decode(r).astype(np.float32) / scale - offset


def load(L, tx, ty):
    """Decoded heights of an existing tile (float32 129x129), or None."""
    p = path('h', L, tx, ty, 'bin')
    if not os.path.exists(p):
        return None
    return decode_fast(open(p, 'rb').read())


# ------------------------------------------------------------------ bake
ZOOM = {7: 15, 6: 15, 5: 13}


def grid(L, tx, ty):
    x0, z0, x1, z1 = bounds(L, tx, ty)
    t = T(L)
    g = np.arange(HN, dtype=np.float64) * (t / (HN - 1))
    X, Z = np.meshgrid(x0 + g, z0 + g)          # [row j (z), col i (x)]
    return X, Z


def heights_for(L, tx, ty):
    X, Z = grid(L, tx, ty)
    lat, lon = w2ll(X, Z)
    H = sample(ZOOM[L], lat, lon).astype(np.float32)
    carve(H, X, Z)
    return H


def bake_tile(L, tx, ty, force=False):
    p = path('h', L, tx, ty, 'bin')
    if os.path.exists(p) and not force:
        return 'skip'
    if L >= 5:
        H = heights_for(L, tx, ty)
    else:
        # decimate the 4 children (exactly shared vertices)
        H = np.zeros((HN, HN), np.float32)
        half = (HN - 1) // 2
        for (cl, cx, cy) in children(L, tx, ty):
            ch = load(cl, cx, cy)
            if ch is None:
                raise RuntimeError(f'missing child heights {cl}/{cx}_{cy}')
            ox = (cx - tx * 2) * half
            oy = (cy - ty * 2) * half
            H[oy:oy + half + 1, ox:ox + half + 1] = ch[::2, ::2]
    write_atomic(p, encode(H))
    return 'ok'
