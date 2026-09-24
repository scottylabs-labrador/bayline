"""Canopy height (m) around any Bayline world point, from Meta / World Resources Institute's global 1 m canopy height map
(Tolan et al. 2024, "Very high resolution canopy height maps from RGB imagery using self-supervised vision transformer
and convolutional decoder trained on aerial lidar"; CC BY 4.0; s3://dataforgood-fb-data/forests/v1/alsgedi_global_v6_float/).

The map is published as zoom-9 quadkey Cloud-Optimized GeoTIFFs in Web Mercator (EPSG:3857). The nine tiles over the
Bayline square are downloaded once to data/raw/chm_meta/<quadkey>.tif; windows are decoded tile by tile (tifffile, no
GDAL), so memory stays small.

  window(x0, z0, size_m, n) -> n x n float32 canopy height (m) on the Bayline grid (cell centres), NaN = no data
"""
import math, os, threading
import numpy as np
import tifffile
from .common import RAW, w2ll

DIR = os.path.join(RAW, 'chm_meta')
R_EARTH = 6378137.0
_open = {}
_lock = threading.Lock()


def _merc(lat, lon):
    return R_EARTH * np.radians(lon), R_EARTH * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


def _quadkey(tx, ty, z=9):
    s = ''
    for i in range(z, 0, -1):
        m = 1 << (i - 1)
        s += str((1 if tx & m else 0) + (2 if ty & m else 0))
    return s


class _Tile:
    def __init__(self, p):
        self.tf = tifffile.TiffFile(p)
        pg = self.tf.pages[0]; self.pg = pg
        tags = pg.tags
        sx, sy, _ = tags['ModelPixelScaleTag'].value
        tp = tags['ModelTiepointTag'].value            # (i, j, k, X, Y, Z): pixel (i, j) <-> map (X, Y)
        self.sx, self.sy = sx, sy
        self.X0 = tp[3] - tp[0] * sx; self.Y0 = tp[4] + tp[1] * sy
        self.W, self.H = pg.imagewidth, pg.imagelength
        # tiled or striped (these COGs are striped: full-width strips of rowsperstrip rows)
        self.tw = pg.tilewidth or self.W; self.th = pg.tilelength or pg.rowsperstrip
        self.nx = (self.W + self.tw - 1) // self.tw
        self.cache = {}
        self.fh_lock = threading.Lock()
        nd = tags.get('GDAL_NODATA')
        self.nodata = float(nd.value) if nd is not None else None

    def _block(self, bx, by):
        k = by * self.nx + bx
        b = self.cache.get(k)
        if b is None:
            off, cnt = self.pg.dataoffsets[k], self.pg.databytecounts[k]
            with self.fh_lock:
                fh = self.tf.filehandle; fh.seek(off); data = fh.read(cnt)
            seg, _, shape = self.pg.decode(data, k)
            b = np.asarray(seg).reshape(shape[-3], shape[-2]) if seg is not None and cnt else np.zeros((self.th, self.tw), np.uint8)
            if len(self.cache) > 2400:                   # ~150 MB: a few tiles' rows (bakes run tiles in row order)
                self.cache.clear()
            self.cache[k] = b
        return b

    def sample(self, X, Y):
        """nearest-pixel heights (m) at map coords (arrays); NaN outside this tile"""
        i = np.floor((X - self.X0) / self.sx).astype(np.int64); j = np.floor((self.Y0 - Y) / self.sy).astype(np.int64)
        out = np.full(X.shape, np.nan, np.float32)
        ok = (i >= 0) & (j >= 0) & (i < self.W) & (j < self.H)
        if not ok.any():
            return out
        ii, jj = i[ok], j[ok]; bx, by = ii // self.tw, jj // self.th
        vals = np.empty(ii.shape, np.float32)
        keys = by * self.nx + bx
        for key in np.unique(keys):
            sel = keys == key
            blk = self._block(int(key % self.nx), int(key // self.nx))
            vals[sel] = blk[jj[sel] - (key // self.nx) * self.th, ii[sel] - (key % self.nx) * self.tw]
        if self.nodata is not None:
            vals[vals == self.nodata] = np.nan
        out[ok] = vals
        return out


def _tile(qk):
    with _lock:
        t = _open.get(qk)
        if t is None:
            p = os.path.join(DIR, qk + '.tif')
            t = _open[qk] = _Tile(p) if os.path.exists(p) else False
        return t or None


def available():
    return os.path.isdir(DIR) and any(f.endswith('.tif') for f in os.listdir(DIR))


def at(X, Z):
    """Canopy height (m, NaN = no data) at Bayline world points (arrays of the same shape)."""
    lat, lon = w2ll(X, Z)
    mx, my = _merc(lat, lon)
    n = 1 << 9
    tx = np.floor((lon + 180.0) / 360.0 * n).astype(np.int64)
    ty = np.floor((1.0 - np.log(np.tan(np.radians(lat)) + 1.0 / np.cos(np.radians(lat))) / np.pi) / 2.0 * n).astype(np.int64)
    out = np.full(np.shape(X), np.nan, np.float32)
    for key in np.unique(ty * n + tx):
        sel = (ty * n + tx) == key
        t = _tile(_quadkey(int(key % n), int(key // n)))
        if t is not None:
            out[sel] = t.sample(mx[sel], my[sel])
    return out


def window(x0, z0, size_m, n):
    g = (np.arange(n) + 0.5) * (size_m / n)
    X, Z = np.meshgrid(x0 + g, z0 + g)
    return at(X, Z)
