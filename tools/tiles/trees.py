"""Tree tiles (SPEC_v2: tiles/t/7/tx_ty.bin, L7 only).

zlib of: uint32 n (LE), then n x 8 bytes: uint16 x, uint16 z (tile-local, units of T7/65536 m = 800/65536 m, x east,
z south), uint8 crown radius (0.1 m), uint8 height (0.25 m), uint8 kind, uint8 tint.
kind: 0 oak, 1 redwood, 2 eucalyptus, 3 palm, 4 sycamore, 5 cypress, 6 pine, 7 street/deciduous, 8 fanpalm.
tint: 0 = darkest crown in the photo .. 255 = lightest (use it to pick a shade inside the species palette).

Crowns are detected in the 0.78 m NAIP imagery: NDVI + darkness + texture canopy mask, smoothed "treeness",
local maxima >= ~2.3 m apart, canopy pixels assigned to the nearest peak (crown area -> radius), intensity-weighted
centroid -> position (so rendered crowns sit on the photo's crowns). Species from OSM natural=tree tags nearby,
else region / elevation / crown colour and size rules (deterministic per tile).
"""
import os, struct, zlib
import numpy as np
import cv2
from scipy import ndimage
from .common import T, bounds, path, write_atomic, w2ll, track, exists, log
from . import imagery as I_
from . import masks as M_

KIND = dict(oak=0, redwood=1, eucalyptus=2, palm=3, sycamore=4, cypress=5, pine=6, street=7, fanpalm=8)
ALLO = {0: (1.25, 4.5), 1: (3.6, 9.0), 2: (2.4, 7.0), 3: (2.5, 7.0), 4: (1.9, 5.0), 5: (1.8, 5.0), 6: (2.2, 5.0), 7: (1.6, 4.0), 8: (3.5, 8.0)}

_track_kd = None


def _trk():
    global _track_kd
    if _track_kd is None:
        from scipy.spatial import cKDTree
        tr = track()
        _track_kd = cKDTree(np.stack([tr['X'], tr['Z']], 1))
    return _track_kd


def region_of(lat):
    if lat > 37.708: return 'sf'
    if lat > 37.50: return 'north'
    if lat > 37.415: return 'mid'
    if lat > 37.335: return 'southbay'
    if lat > 37.20: return 'sj'
    return 'county'


# base species mix per region for urban/suburban flatland crowns: (kind, weight)
MIX = {
    'sf': [(7, 34), (5, 14), (6, 12), (2, 12), (4, 10), (3, 8), (8, 4), (0, 6)],
    'north': [(7, 30), (0, 16), (1, 12), (2, 12), (6, 10), (4, 8), (5, 6), (3, 4), (8, 2)],
    'mid': [(0, 28), (7, 24), (1, 16), (4, 10), (6, 8), (2, 6), (5, 4), (3, 2), (8, 2)],
    'southbay': [(7, 36), (0, 16), (4, 12), (6, 10), (1, 6), (3, 8), (8, 6), (2, 4), (5, 2)],
    'sj': [(7, 34), (4, 12), (0, 12), (3, 12), (8, 10), (6, 10), (2, 5), (1, 3), (5, 2)],
    'county': [(0, 34), (7, 30), (2, 10), (4, 10), (6, 6), (8, 4), (3, 3), (1, 3)],
}
HILL = [(0, 60), (2, 12), (1, 10), (6, 8), (4, 5), (5, 5)]


def _pick(rng, mix):
    ks = np.array([k for k, _ in mix]); w = np.array([w for _, w in mix], np.float64)
    return int(ks[np.searchsorted(np.cumsum(w) / w.sum(), rng.random())])


def detect(tx, ty):
    """Returns structured array of trees for L7 tile (tx, ty)."""
    L = 7
    d = I_.load_hires(L, tx, ty)
    rgb, nir = d['rgb'], d['nir']
    n = nir.shape[0]
    px_m = T(L) / n
    v = M_.veg_maps(rgb, nir)
    can = M_.canopy_mask(v, px_m)
    x0, z0, x1, z1 = bounds(L, tx, ty)
    # exclusions: water, buildings, track corridor
    hgt = M_.heights_at(L, tx, ty, n)
    areas = M_.raster_areas(L, tx, ty, n)
    zz = np.zeros((n, n), np.float32)
    inland = areas.get(M_.AREA_WATER, zz) > 0.5
    salt = areas.get(M_.AREA_SALT, zz) > 0.5
    water = M_.water_map(v, d['nodata'] if d['nodata'].shape[0] == n else cv2.resize(d['nodata'].astype(np.uint8), (n, n), interpolation=cv2.INTER_NEAREST).astype(bool),
                         hgt, inland, salt, px_m, nir) > 0.5
    o = M_.osm()
    bld = np.zeros((n * 2, n * 2), np.uint8)
    s = (n * 2) / T(L)
    bi = o.buildings_in(x0, z0, x1, z1)
    if len(bi):
        cv2.fillPoly(bld, [M_._to_px(o.bld(i), x0, z0, s) for i in bi], 1, lineType=cv2.LINE_8, shift=4)
    bld = cv2.resize(bld, (n, n), interpolation=cv2.INTER_NEAREST).astype(bool)
    can &= ~water & ~bld
    if can.sum() < 10:
        return np.zeros(0, dtype=DT)
    ndvi = v['ndvi']; lum = v['lum']
    tness = np.clip((ndvi - 0.05) * 3.0, 0, 1) * np.clip(1.25 - lum / 200.0, 0.2, 1.2)
    tness = cv2.GaussianBlur(tness * can, (0, 0), 2.0)
    mx = ndimage.maximum_filter(tness, size=7)
    peaks = (tness >= mx - 1e-7) & can & (tness > 0.04)
    py, px = np.nonzero(peaks)
    if not len(px):
        return np.zeros(0, dtype=DT)
    # assign canopy pixels to nearest peak (within 14 m)
    markers = np.zeros((n, n), np.int32)
    markers[py, px] = np.arange(1, len(px) + 1)
    dist, (iy, ix) = ndimage.distance_transform_edt(markers == 0, return_indices=True)
    lab = markers[iy, ix]
    lab[~can | (dist * px_m > 14.0)] = 0
    cnt = np.bincount(lab.ravel(), minlength=len(px) + 1).astype(np.float64)
    W = tness + 1e-4
    sw = np.bincount(lab.ravel(), weights=W.ravel(), minlength=len(px) + 1)
    yy, xx = np.mgrid[0:n, 0:n]
    cx = np.bincount(lab.ravel(), weights=(xx * W).ravel(), minlength=len(px) + 1) / np.maximum(sw, 1e-9)
    cy = np.bincount(lab.ravel(), weights=(yy * W).ravel(), minlength=len(px) + 1) / np.maximum(sw, 1e-9)
    rsum = np.bincount(lab.ravel(), weights=v['rgb'][..., 0].ravel(), minlength=len(px) + 1)
    gsum = np.bincount(lab.ravel(), weights=v['rgb'][..., 1].ravel(), minlength=len(px) + 1)
    bsum = np.bincount(lab.ravel(), weights=v['rgb'][..., 2].ravel(), minlength=len(px) + 1)
    lsum = np.bincount(lab.ravel(), weights=lum.ravel(), minlength=len(px) + 1)
    k = np.arange(1, len(px) + 1)
    area = cnt[k] * px_m * px_m
    r = np.sqrt(area / np.pi)
    ok = r >= 1.3
    k = k[ok]; r = np.clip(r[ok], 1.3, 14.0)
    cxm = (cx[k] + 0.5) * px_m; czm = (cy[k] + 0.5) * px_m
    X = x0 + cxm; Z = z0 + czm
    c = cnt[k]
    mr = rsum[k] / c; mg = gsum[k] / c; mb = bsum[k] / c; ml = lsum[k] / c
    # track corridor clearance
    dtr, _ = _trk().query(np.stack([X, Z], 1), distance_upper_bound=200.0)
    keep = ~(dtr < 11.0 + r * 0.5)
    X, Z, r, mr, mg, mb, ml, cxm, czm = X[keep], Z[keep], r[keep], mr[keep], mg[keep], mb[keep], ml[keep], cxm[keep], czm[keep]
    if not len(X):
        return np.zeros(0, dtype=DT)
    # species
    rng = np.random.default_rng((tx * 73856093) ^ (ty * 19349663) ^ 0x5eed)
    lat, lon = w2ll(X, Z)
    elev = hgt[np.clip((czm / px_m).astype(int), 0, n - 1), np.clip((cxm / px_m).astype(int), 0, n - 1)]
    urban_lc = M_.raster_areas  # (unused; urban context from building density below)
    bd = cv2.blur(bld.astype(np.float32), (41, 41))
    bdens = bd[np.clip((czm / px_m).astype(int), 0, n - 1), np.clip((cxm / px_m).astype(int), 0, n - 1)]
    t_xy, t_k = o.trees_in(x0 - 5, z0 - 5, x1 + 5, z1 + 5)
    osm_kd = None
    if len(t_xy):
        from scipy.spatial import cKDTree
        osm_kd = cKDTree(t_xy)
    kinds = np.zeros(len(X), np.uint8)
    for i in range(len(X)):
        kd_ = 255
        if osm_kd is not None:
            dd, jj = osm_kd.query((X[i], Z[i]), distance_upper_bound=4.0 + r[i] * 0.5)
            if np.isfinite(dd) and t_k[jj] != 255:
                kd_ = int(t_k[jj])
        if kd_ == 255:
            reg = region_of(lat[i])
            sat = max(mr[i], mg[i], mb[i]) - min(mr[i], mg[i], mb[i])
            blueish = mb[i] > mg[i] * 0.93 and sat < 0.10
            dark = ml[i] < 62.0
            if elev[i] > 110 and bdens[i] < 0.08:
                mix = list(HILL)
                if reg in ('mid', 'north') and elev[i] > 180 and dark:
                    mix.append((1, 40))
            else:
                mix = list(MIX[reg])
                if bdens[i] < 0.02 and reg in ('mid', 'county', 'north'):
                    mix.append((0, 30))
            if blueish and r[i] > 3.5:
                mix.append((2, 55))
            if dark and 2.2 < r[i] < 6.5:
                mix.append((1, 18) if reg in ('mid', 'north', 'sf') else (6, 14))
            if r[i] < 2.8 and bdens[i] > 0.05 and reg in ('sj', 'southbay', 'sf'):
                mix.append((3, 10)); mix.append((8, 10))
            kd_ = _pick(rng, mix)
        kinds[i] = kd_
    a_b = np.array([ALLO[int(q)] for q in kinds])
    h = (a_b[:, 0] * r + a_b[:, 1]) * rng.uniform(0.86, 1.14, len(X))
    tint = np.clip((ml - 38.0) / (150.0 - 38.0), 0, 1) * 255.0
    out = np.zeros(len(X), dtype=DT)
    out['x'] = np.clip(np.round(cxm / T(L) * 65536.0), 0, 65535)
    out['z'] = np.clip(np.round(czm / T(L) * 65536.0), 0, 65535)
    out['r'] = np.clip(np.round(r * 10.0), 1, 255)
    out['h'] = np.clip(np.round(h * 4.0), 4, 255)
    out['kind'] = kinds
    out['tint'] = np.clip(np.round(tint), 0, 255)
    return out


DT = np.dtype([('x', '<u2'), ('z', '<u2'), ('r', 'u1'), ('h', 'u1'), ('kind', 'u1'), ('tint', 'u1')])


def encode(arr):
    return zlib.compress(struct.pack('<I', len(arr)) + arr.astype(DT).tobytes(), 9)


def decode(blob):
    b = zlib.decompress(blob)
    n = struct.unpack('<I', b[:4])[0]
    return np.frombuffer(b, DT, n, 4)


def bake_tile(tx, ty, force=False):
    p = path('t', 7, tx, ty, 'bin')
    if os.path.exists(p) and not force:
        return 'skip'
    arr = detect(tx, ty)
    write_atomic(p, encode(arr))
    return len(arr)
