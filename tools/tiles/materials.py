"""Ground material tiles (tiles/mat/7/tx_ty.bin): what the ground IS, per 1.5625 m cell, so the terrain can draw grass,
asphalt, gravel ... up close from a class instead of guessing from the photo's colour.

Layout: 512 x 512 uint8 class ids, cell (i, j) centred at X = x0 + (i + 0.5) * 1.5625, Z = z0 + (j + 0.5) * 1.5625 (row j
north -> south), row-major, zlib. L7 only (800 m tiles); the terrain samples a node's L7 ancestor. Index:
tiles/mat/index.json { version, product, n, cell, classes, tiles: [[tx, ty], ...] }.

Classes (MAT): 0 none (no data) | 1 lawn | 2 dry grass | 3 shrub / scrub | 4 ground under trees (leaf litter) |
5 bare soil | 6 gravel / ballast | 7 asphalt | 8 concrete / paving | 9 roof | 10 sand | 11 rock | 12 water | 13 marsh |
14 salt pond | 15 farmland

Classified at the NAIP near-infrared resolution (0.78 m) and pooled 2x2 by majority:
  * spectral: NDVI (vegetation, robust in shade), brightness, saturation / hue (dry golden grass, soil, grey paving),
    local texture (lawn vs scrub) — from the same per-pixel products the mask tiles use (masks.compute_direct);
  * geometry: water / canopy / landcover of the mask pipeline, OSM areas (farmland, wetland, sand, rock, parking,
    plazas, parks), the Towns street tiles (road carriageways -> asphalt, sidewalks -> paving, footprints -> roof) and
    the track (ballast);
  * then a 3x3 majority filter against speckle.
"""
import os, zlib
import numpy as np
import cv2
from .common import T, bounds, path, write_atomic, track
from . import masks as M_
from . import towns_dec as TD
from .osmdata import AREA_SALT, AREA_WETLAND, AREA_SAND, AREA_ROCK, AREA_FARM, AREA_PARK, AREA_GRASS, AREA_PAVE

N = 512
CELL = T(7) / N                    # 1.5625 m
NAMES = ['none', 'lawn', 'dry grass', 'shrub', 'leaf litter', 'soil', 'gravel', 'asphalt', 'concrete', 'roof', 'sand',
         'rock', 'water', 'marsh', 'salt pond', 'farmland']
(NONE, LAWN, DRY, SHRUB, LITTER, SOIL, GRAVEL, ASPHALT, CONCRETE, ROOF, SAND, ROCK, WATER, MARSH, SALT, FARM) = range(16)
BALLAST_HALF = 6.0                 # m either side of the track centreline


def _towns_masks(tx, ty, n):
    """Road carriageway, sidewalk and building-footprint rasters (n x n bool) over L7 tile (tx, ty) from the Towns tiles
    (this tile and its neighbours: roads and footprints cross tile edges)."""
    x0, z0, _, _ = bounds(7, tx, ty); s = n / T(7)
    px = lambda P: np.round((np.asarray(P, np.float64) - (x0, z0)) * s * 16).astype(np.int32)
    road = np.zeros((n, n), np.uint8); walk = np.zeros((n, n), np.uint8); roof = np.zeros((n, n), np.uint8)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            d = TD.decode(tx + dx, ty + dy)
            if d is None:
                continue
            for r in d['roads']:
                if len(r['pts']) < 2 or r['flags'] & 2:
                    continue
                cw = max(1, int(round(r['width'] * s)))
                ext = TD.road_extent(r, d['region'])
                if ext > r['width'] / 2 + 1.2:                                   # sidewalks (and verge) drawn by Towns
                    cv2.polylines(walk, [px(r['pts'])], False, 1, thickness=max(1, int(round(2 * ext * s))), lineType=cv2.LINE_8, shift=4)
                cv2.polylines(road, [px(r['pts'])], False, 1, thickness=cw, lineType=cv2.LINE_8, shift=4)
            for b in d['buildings']:
                if len(b['pts']) >= 3:
                    cv2.fillPoly(roof, [px(b['pts'])], 1, lineType=cv2.LINE_8, shift=4)
    return road.astype(bool), (walk.astype(bool) & ~road.astype(bool)), roof.astype(bool)


def _ballast(tx, ty, n):
    x0, z0, _, _ = bounds(7, tx, ty); s = n / T(7)
    tr = track(); X, Z = tr['X'], tr['Z']
    m = (X > x0 - 50) & (X < x0 + T(7) + 50) & (Z > z0 - 50) & (Z < z0 + T(7) + 50)
    out = np.zeros((n, n), np.uint8)
    if m.sum() >= 2:
        idx = np.nonzero(m)[0]
        runs = np.split(idx, np.nonzero(np.diff(idx) > 1)[0] + 1)          # contiguous stretches of the line in this tile
        for r in runs:
            if len(r) < 2:
                continue
            P = np.stack([(X[r] - x0) * s, (Z[r] - z0) * s], 1)
            cv2.polylines(out, [np.round(P * 16).astype(np.int32)], False, 1, thickness=max(1, int(round(2 * BALLAST_HALF * s))), lineType=cv2.LINE_8, shift=4)
    # Bayline Metro: every BART track on the ground (grade, embankment, trench, median, portal): ballast +-3.2 m per track
    for P, m in _bart_ground(x0, z0):
        for run in np.split(np.arange(len(m)), np.nonzero(np.diff(m.astype(int)) != 0)[0] + 1):
            if len(run) < 2 or not m[run[0]]:
                continue
            Q = np.stack([(P[run, 0] - x0) * s, (P[run, 2] - z0) * s], 1)
            cv2.polylines(out, [np.round(Q * 16).astype(np.int32)], False, 1, thickness=max(1, int(round(2 * BART_BALLAST_HALF * s))), lineType=cv2.LINE_8, shift=4)
    return out.astype(bool)


BART_BALLAST_HALF = 3.2
_BT = None


def _bart_ground(x0, z0):
    """[(P (n,3), on-the-ground mask)] of the BART tracks passing near this L7 tile (tools/tiles/metro.py network)."""
    global _BT
    if _BT is None:
        try:
            from . import metro
            _BT = [(t['P'], np.isin(t['struct'], [0, 3, 4, 5, 6])) for t in metro.network_tracks()]
        except Exception:
            _BT = []
    T7 = T(7)
    return [(P, m) for (P, m) in _BT if m.any() and P[:, 0].max() > x0 - 50 and P[:, 0].min() < x0 + T7 + 50
            and P[:, 2].max() > z0 - 50 and P[:, 2].min() < z0 + T7 + 50]


def classify(tx, ty):
    """-> N x N uint8 classes, or None when the tile has no imagery."""
    try:
        _, ex = M_.compute_direct(7, tx, ty)
    except Exception:
        return None
    v, n = ex['v'], ex['n']
    rgb = v['rgb']; ndvi = v['ndvi']; lum = v['lum']; tex = v['tex']
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b)
    sat = (mx - mn) / np.maximum(mx, 0.03)
    warm = r - b                                                            # soil / dry grass are warm, paving is grey
    areas = M_.raster_areas(7, tx, ty, n); z0 = np.zeros((n, n), np.float32)
    A = lambda k: areas.get(k, z0) > 0.5
    road, walk, roof = _towns_masks(tx, ty, n)
    ballast = _ballast(tx, ty, n)
    water = ex['water'] > 0.5; canopy = ex['canopy']
    nodata = cv2.resize(M_.I_.load_hires(7, tx, ty)['nodata'].astype(np.uint8), (n, n), interpolation=cv2.INTER_NEAREST).astype(bool)
    # vegetation strength: NDVI (a ratio, so it survives shade) or a clearly green photo
    green = (g - np.maximum(r * 0.96, b)) > 0.015
    veg = (ndvi > 0.10) | ((ndvi > 0.04) & green)
    dry = ~veg & (ndvi > -0.02) & (warm > 0.06) & (sat > 0.16) & (lum > 95)      # golden summer grass
    c = np.full((n, n), CONCRETE, np.uint8)
    # bare ground by colour
    c[(lum < 118) & (sat < 0.22)] = ASPHALT
    c[(warm > 0.05) & (sat > 0.14) & (lum >= 80)] = SOIL
    c[(lum >= 118) & (sat < 0.14)] = CONCRETE
    c[dry] = DRY
    c[veg] = np.where(tex[veg] > 22.0, SHRUB, LAWN)
    # under tree crowns (drawn in 3D by Flora): shaded leaf litter. The mask's canopy is generous (it also takes lawns),
    # so crowns must also look like crowns here: rough or dark
    c[veg & canopy & ((tex > 24.0) | (lum < 92))] = LITTER
    # land use
    farm = A(AREA_FARM); c[farm & (veg | dry)] = FARM; c[farm & ~veg & ~dry & (c == SOIL)] = FARM
    c[A(AREA_WETLAND) & ~water & (veg | dry)] = MARSH
    c[A(AREA_SAND) & ~veg] = SAND
    c[A(AREA_ROCK) & ~veg] = ROCK
    c[(A(AREA_PARK) | A(AREA_GRASS)) & (c == SOIL) & (lum > 90)] = DRY       # park dirt that is really parched lawn
    pave = A(AREA_PAVE) & ~veg; c[pave & (lum < 130)] = ASPHALT; c[pave & (lum >= 130)] = CONCRETE
    # modelled geometry
    c[ballast & ~veg] = GRAVEL
    c[walk & ~(veg & canopy)] = CONCRETE
    c[road] = ASPHALT
    c[roof] = ROOF
    salt = A(AREA_SALT)
    c[water] = WATER; c[water & salt] = SALT; c[salt & ~water & ~veg] = SALT
    c[nodata] = NONE
    # pool 2x2 (majority) to N, then a 3x3 majority filter
    k = n // N
    if k > 1:
        blocks = c.reshape(N, k, N, k).transpose(0, 2, 1, 3).reshape(N, N, k * k)
        cnt = np.stack([(blocks == i).sum(2) for i in range(16)], 2)
        c = cnt.argmax(2).astype(np.uint8)
    cnt = np.stack([cv2.boxFilter((c == i).astype(np.float32), -1, (3, 3), normalize=False, borderType=cv2.BORDER_REPLICATE) for i in range(16)], 2)
    best = cnt.argmax(2).astype(np.uint8)
    keep = cnt.max(2) < 5                                                     # no clear majority: keep the cell's own class
    return np.where(keep, c, best).astype(np.uint8)


def out_path(tx, ty):
    return path('mat', 7, tx, ty, 'bin')


def bake_tile(tx, ty, force=False):
    p = out_path(tx, ty)
    if os.path.exists(p) and not force:
        return (tx, ty, 'skip')
    c = classify(tx, ty)
    if c is None:
        return (tx, ty, 'none')
    write_atomic(p, zlib.compress(np.ascontiguousarray(c).tobytes(), 9))
    return (tx, ty, 'ok', np.bincount(c.ravel(), minlength=16).tolist())


def load(tx, ty):
    p = out_path(tx, ty)
    if not os.path.exists(p):
        return None
    return np.frombuffer(zlib.decompress(open(p, 'rb').read()), np.uint8).reshape(N, N)
