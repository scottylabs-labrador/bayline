"""Ground heights for the metro profile: USGS 3DEP 1 m bare-earth lidar (the world bake's L8 cache in
data/raw/lidar3dep/8/, 1.5625 m samples with an 8-sample margin, NaN = no data; see tools/tiles/lidar.py), falling back
to AWS terrarium z15 (tools/metro/elev.py) where the lidar has no data (open water, gaps).

Bare earth keeps the railway bed (ballast, the floor of open cuts, freeway medians) but not bridges or aerial
guideways, and not the ground over tunnels' interiors of course: exactly what the profile solver needs.
"""
import os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tiles import common as C                 # noqa: E402
from metro import elev                         # noqa: E402

M = 8
NV = 257
NF = NV + 2 * M
S9 = C.T(9) / 128.0                            # 1.5625 m
T8 = C.T(8)
CACHE = os.path.join(C.RAW, 'lidar3dep', '8')
_tiles = {}


def _tile(tx, ty):
    k = (tx, ty)
    if k in _tiles:
        return _tiles[k]
    p = os.path.join(CACHE, f'{tx}_{ty}.npz')
    a = None
    if os.path.exists(p):
        try:
            a = np.load(p)['h'].astype(np.float32)
            if a.shape != (NF, NF):
                a = None
        except Exception:
            a = None
    _tiles[k] = a
    return a


def lidar(x, z):
    """Bilinear lidar height at world (x, z) (arrays); NaN where not available."""
    x = np.asarray(x, np.float64)
    z = np.asarray(z, np.float64)
    out = np.full(x.shape, np.nan, np.float32)
    tx = np.floor((x - C.X0) / T8).astype(np.int64)
    ty = np.floor((z - C.Z0) / T8).astype(np.int64)
    key = tx * 100003 + ty
    for k in np.unique(key):
        m = key == k
        a = _tile(int(tx[m][0]), int(ty[m][0]))
        if a is None:
            continue
        x0 = C.X0 + int(tx[m][0]) * T8
        z0 = C.Z0 + int(ty[m][0]) * T8
        u = (x[m] - x0) / S9 + M
        v = (z[m] - z0) / S9 + M
        i = np.clip(np.floor(u).astype(np.int64), 0, NF - 2)
        j = np.clip(np.floor(v).astype(np.int64), 0, NF - 2)
        fu = (u - i).astype(np.float32)
        fv = (v - j).astype(np.float32)
        h = (a[j, i] * (1 - fu) + a[j, i + 1] * fu) * (1 - fv) + (a[j + 1, i] * (1 - fu) + a[j + 1, i + 1] * fu) * fv
        out[m] = h
    return out


def ground(x, z):
    """(height, source) with source 1 = lidar, 0 = terrarium fallback. Over open water the 3DEP surface is often the
    hydro-flattened water level (~0 m) rather than the bed: where terrarium says bay floor (< -1 m) and the lidar says
    ~sea level, the terrarium bathymetry wins (source 0)."""
    x = np.asarray(x, np.float64); z = np.asarray(z, np.float64)
    h = lidar(x, z).astype(np.float64)
    t = elev.ground(x, z).astype(np.float64)
    water = np.isfinite(h) & (t < -1.0) & (h > -0.8) & (h < 1.5)
    bad = ~np.isfinite(h) | water
    src = (~bad).astype(np.uint8)
    h[bad] = t[bad]
    return h, src
