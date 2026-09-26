"""Ground heights for the metro bake: AWS terrarium z15 tiles (the same source and zoom as the world's tiles/h
L6-L7 heights and the Globe), cached in the shared data/raw/terrarium/ like tools/tiles/fetch.py.

    ground(x, z)            -> metres above sea level (bilinear), arrays ok (world coords)
    ensure_along(x, z, r)   -> download every tile within r metres of the points first (threaded)
"""
import io, math, os, sys, threading
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tiles import fetch as TF          # noqa: E402  (cached, polite downloader shared with the world bake)
from metro.common import w2ll, log     # noqa: E402

Z = 15
_tiles = {}
_lock = threading.Lock()


def _merc(lat, lon, z=Z):
    n = 2 ** z * 256.0
    px = (np.asarray(lon) + 180.0) / 360.0 * n
    lr = np.radians(np.asarray(lat))
    py = (1.0 - np.log(np.tan(lr) + 1.0 / np.cos(lr)) / math.pi) / 2.0 * n
    return px, py


def _load(tx, ty):
    k = (tx, ty)
    a = _tiles.get(k)
    if a is not None:
        return a
    try:
        raw = TF.terrarium(Z, tx, ty)
        im = np.asarray(Image.open(io.BytesIO(raw)).convert('RGB')).astype(np.float32)
        a = im[..., 0] * 256.0 + im[..., 1] + im[..., 2] / 256.0 - 32768.0
    except Exception as e:  # missing tile: sea level
        log('terrarium missing', Z, tx, ty, e)
        a = np.zeros((256, 256), np.float32)
    with _lock:
        _tiles[k] = a
    return a


def ensure_along(x, z, r=250.0, workers=8):
    lat, lon = w2ll(np.asarray(x), np.asarray(z))
    dlat = r / 110985.1
    dlon = r / 88000.0
    keys = set()
    for sl, so in ((0, 0), (dlat, dlon), (-dlat, -dlon), (dlat, -dlon), (-dlat, dlon)):
        px, py = _merc(lat + sl, lon + so)
        keys |= set(zip((px // 256).astype(int).tolist(), (py // 256).astype(int).tolist()))
    need = [k for k in keys if k not in _tiles]
    if need:
        log(f'terrarium z{Z}: {len(need)} tiles')
        with ThreadPoolExecutor(workers) as ex:
            list(ex.map(lambda k: _load(*k), need))


def _pix(gx, gy):
    """Values at integer global pixel coords (arrays)."""
    gx = np.asarray(gx, np.int64)
    gy = np.asarray(gy, np.int64)
    out = np.zeros(gx.shape, np.float32)
    tx = gx >> 8
    ty = gy >> 8
    key = tx * 1000003 + ty
    for k in np.unique(key):
        m = key == k
        a = _load(int(tx[m][0]), int(ty[m][0]))
        out[m] = a[gy[m] & 255, gx[m] & 255]
    return out


def ground(x, z):
    """Bilinear terrarium z15 height at world (x, z)."""
    x = np.asarray(x, np.float64)
    z = np.asarray(z, np.float64)
    lat, lon = w2ll(x, z)
    px, py = _merc(lat, lon)
    px = px - 0.5
    py = py - 0.5
    x0 = np.floor(px).astype(np.int64)
    y0 = np.floor(py).astype(np.int64)
    fx = (px - x0).astype(np.float32)
    fy = (py - y0).astype(np.float32)
    a = _pix(x0, y0)
    b = _pix(x0 + 1, y0)
    c = _pix(x0, y0 + 1)
    d = _pix(x0 + 1, y0 + 1)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
