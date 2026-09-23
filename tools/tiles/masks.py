"""Mask tiles (SPEC_v2: tiles/m/L/tx_ty.bin, L0-L7): 128x128 RGBA uint8, cell (i,j) centred at
X = x0 + (i+0.5)*T/128, Z = z0 + (j+0.5)*T/128 (row j = north->south), interleaved RGBA, row-major, zlib.

R water 0..255   NAIP NDWI/darkness at the imagery resolution, gated by height (sea level) or OSM inland water;
                 NAIP no-data over low ground; OSM salt ponds are NOT water (landcover 3).
G night lights   OSM streets by class + building footprints (commercial brighter) + parking/aprons, soft glow.
B canopy         fraction of tree canopy (NDVI + darkness + texture) in the cell.
A landcover      0 grass/natural, 1 farmland, 2 marsh, 3 salt pond, 4 beach/sand, 5 rock, 6 pavement/urban, 7 forest.
L7, L6, L5 are computed from their own imagery/NIR + OSM; L4..L0 are pooled from children.
"""
import os, zlib
import numpy as np
import cv2
from .common import MN, T, bounds, path, write_atomic, exists, children, log
from . import heights as H_
from . import imagery as I_
from .osmdata import (OSM, AREA_WATER, AREA_SALT, AREA_WETLAND, AREA_SAND, AREA_ROCK, AREA_FOREST, AREA_FARM, AREA_URBAN,
                      AREA_PARK, AREA_GRASS, AREA_PAVE, AREA_BAY, ROAD_ID)

LC_GRASS, LC_FARM, LC_MARSH, LC_SALT, LC_SAND, LC_ROCK, LC_URBAN, LC_FOREST = range(8)
_osm = None


def osm():
    global _osm
    if _osm is None:
        _osm = OSM()
    return _osm


# road light weights and half-widths (m)
ROAD_W = {'motorway': (0.85, 14), 'motorway_link': (0.7, 6), 'trunk': (0.85, 11), 'trunk_link': (0.65, 6), 'primary': (0.95, 9), 'primary_link': (0.7, 5),
          'secondary': (0.85, 8), 'secondary_link': (0.6, 5), 'tertiary': (0.72, 7), 'tertiary_link': (0.55, 4), 'residential': (0.5, 5),
          'unclassified': (0.4, 4), 'living_street': (0.45, 4), 'service': (0.22, 3), 'pedestrian': (0.35, 3), 'footway': (0.06, 1.5),
          'cycleway': (0.06, 1.5), 'path': (0.0, 1), 'track': (0.0, 1)}
ROAD_LIST = [None] * len(ROAD_ID)
for k, i in ROAD_ID.items():
    ROAD_LIST[i] = ROAD_W[k]


def _raster_ctx(L, tx, ty, n):
    x0, z0, x1, z1 = bounds(L, tx, ty)
    s = n / T(L)
    return x0, z0, x1, z1, s


def _to_px(xy, x0, z0, s, sub=16):
    """world xz -> int32 pixel coords with `sub` subpixel scale (cv2 shift=4)."""
    return np.round(np.stack([(xy[:, 0] - x0) * s, (xy[:, 1] - z0) * s], 1) * sub).astype(np.int32)


def raster_areas(L, tx, ty, n):
    """Per-class coverage rasters (dict class->float32 n x n) from OSM areas, supersampled 2x."""
    o = osm()
    x0, z0, x1, z1, s = _raster_ctx(L, tx, ty, n * 2)
    idx = o.rings_in(x0, z0, x1, z1)
    out = {}
    if not len(idx):
        return out
    by_area = {}
    for ri in idx:
        by_area.setdefault(int(o.ring_area[ri]), []).append(ri)
    for ai, rings in by_area.items():
        c = int(o.area_cls[ai])
        # include every ring of the area (inner rings may lie outside the bbox query)
        m = out.get(c)
        if m is None:
            m = out[c] = np.zeros((n * 2, n * 2), np.uint8)
        outer = [ _to_px(o.ring(r), x0, z0, s) for r in rings if not o.ring_inner[r] ]
        inner = [ _to_px(o.ring(r), x0, z0, s) for r in rings if o.ring_inner[r] ]
        if not outer:
            continue
        tmp = np.zeros_like(m)
        cv2.fillPoly(tmp, outer, 1, lineType=cv2.LINE_8, shift=4)
        if inner:
            cv2.fillPoly(tmp, inner, 0, lineType=cv2.LINE_8, shift=4)
        m |= tmp
    res = {}
    for c, m in out.items():
        res[c] = cv2.resize(m.astype(np.float32), (n, n), interpolation=cv2.INTER_AREA)
    return res


def raster_lights(L, tx, ty, n):
    """Night-light intensity 0..1 (n x n) from roads + buildings."""
    o = osm()
    x0, z0, x1, z1, s = _raster_ctx(L, tx, ty, n * 2)
    pad = 30.0
    cell = T(L) / (n * 2)
    img = np.zeros((n * 2, n * 2), np.float32)
    for ri in o.roads_in(x0 - pad, z0 - pad, x1 + pad, z1 + pad):
        w, hw = ROAD_LIST[int(o.road_cls[ri])]
        if w <= 0:
            continue
        pts = _to_px(o.road(ri), x0, z0, s)
        th = max(1, int(round(2 * hw / cell)))
        cv2.polylines(img, [pts], False, float(w), thickness=th, lineType=cv2.LINE_AA, shift=4)
    # buildings: lit footprint density
    bimg = np.zeros_like(img)
    bi = o.buildings_in(x0, z0, x1, z1)
    if len(bi):
        polys = {}
        for i in bi:
            polys.setdefault(float(o.bld_w[i]), []).append(_to_px(o.bld(i), x0, z0, s))
        for w, ps in polys.items():
            cv2.fillPoly(bimg, ps, w * 0.35, lineType=cv2.LINE_8, shift=4)
    img = np.maximum(img, 0) + bimg
    img = cv2.resize(img, (n, n), interpolation=cv2.INTER_AREA)
    # glow: light spills a few tens of metres
    sig = max(0.6, 12.0 / (T(L) / n))
    glow = cv2.GaussianBlur(img, (0, 0), sig)
    return np.clip(img * 0.85 + glow * 0.9, 0, 1)


def veg_maps(rgb, nir):
    """NDVI-based vegetation + canopy maps at the NIR resolution. rgb float 0..1 (any size), nir uint8."""
    n = nir.shape[0]
    if rgb.shape[0] != n:
        rgb = cv2.resize(rgb, (n, n), interpolation=cv2.INTER_AREA)
    r = rgb[..., 0] * 255.0; g = rgb[..., 1] * 255.0; b = rgb[..., 2] * 255.0
    nr = nir.astype(np.float32)
    # NIR is raw DN; rgb is balanced -> approximate raw red for NDVI by inverting the black/white points roughly
    rr = r * (226 - 58) / 255.0 + 58
    ndvi = (nr - rr) / (nr + rr + 1e-3)
    gg = g * (224 - 68) / 255.0 + 68
    ndwi = (gg - nr) / (gg + nr + 1e-3)
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    # local texture (std of luminance in 5x5)
    m = cv2.blur(lum, (5, 5)); m2 = cv2.blur(lum * lum, (5, 5))
    tex = np.sqrt(np.clip(m2 - m * m, 0, None))
    return dict(ndvi=ndvi, ndwi=ndwi, lum=lum, tex=tex, rgb=rgb)


def canopy_mask(v, px_m):
    """Tree canopy boolean map: vegetated, darker than lawns, textured."""
    ndvi, lum, tex = v['ndvi'], v['lum'], v['tex']
    veg = ndvi > 0.10
    tree = veg & ((lum < 118) | (tex > 9.0)) & (ndvi > 0.13)
    tree |= (ndvi > 0.26) & (lum < 135)
    # remove specks smaller than ~6 m2
    k = max(1, int(round(1.6 / px_m)))
    tree = cv2.morphologyEx(tree.astype(np.uint8), cv2.MORPH_OPEN, np.ones((k, k), np.uint8)).astype(bool)
    return tree


def water_map(v, nodata, hgt, inland, salt, px_m):
    """Water probability 0..1 at image resolution."""
    ndwi, lum = v['ndwi'], v['lum']
    wet = (ndwi > 0.05) & (lum > 25) & (lum < 175) & (v['ndvi'] < 0.05)
    low = hgt < 2.5
    w = (wet & (low | inland)) | (nodata & (hgt < 3.0)) | (inland & (ndwi > -0.05))
    w &= ~salt
    k = max(1, int(round(3.0 / px_m)))
    w = cv2.morphologyEx(w.astype(np.uint8), cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    # drop tiny blobs (pools, shadows) away from inland water
    nlab, lab, stats, _ = cv2.connectedComponentsWithStats(w, connectivity=8)
    minpx = 600.0 / (px_m * px_m)
    keep = np.zeros(nlab, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= minpx
    w = keep[lab] | (inland & (w > 0))
    return w.astype(np.float32)


def heights_at(L, tx, ty, n):
    """Heights at n x n cell centres of the tile (from the baked height tile, falling back to ancestors)."""
    LL, ax, ay = L, tx, ty
    Hh = None
    while LL >= 0:
        Hh = H_.load(LL, ax, ay)
        if Hh is not None:
            break
        LL -= 1; ax >>= 1; ay >>= 1
    if Hh is None:
        return np.zeros((n, n), np.float32)
    # map cell centres of (L,tx,ty) into (LL,ax,ay) sample space
    f = 1 << (L - LL)
    u = ((tx - ax * f) + (np.arange(n) + 0.5) / n) / f * 128.0
    v = ((ty - ay * f) + (np.arange(n) + 0.5) / n) / f * 128.0
    return cv2.remap(Hh, *np.meshgrid(u.astype(np.float32), v.astype(np.float32)), interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def compute_direct(L, tx, ty):
    """Full mask (MN x MN x 4 uint8) + per-pixel products for trees, for L5-L7 from imagery + OSM."""
    d = I_.load_hires(L, tx, ty)
    nir = d['nir']; n_img = nir.shape[0]
    px_m = T(L) / n_img
    v = veg_maps(d['rgb'], nir)
    nd = cv2.resize(d['nodata'].astype(np.uint8), (n_img, n_img), interpolation=cv2.INTER_NEAREST).astype(bool)
    hgt = heights_at(L, tx, ty, n_img)
    areas = raster_areas(L, tx, ty, n_img)
    z = np.zeros((n_img, n_img), np.float32)
    inland = (areas.get(AREA_WATER, z) > 0.5)
    salt = (areas.get(AREA_SALT, z) > 0.5)
    water = water_map(v, nd, hgt, inland, salt, px_m)
    canopy = canopy_mask(v, px_m).astype(np.float32) * (1 - water)
    # landcover per image pixel, priority order
    lc = np.full((n_img, n_img), LC_GRASS, np.uint8)
    urban = np.maximum(areas.get(AREA_URBAN, z), areas.get(AREA_PAVE, z))
    lc[urban > 0.5] = LC_URBAN
    lc[areas.get(AREA_FARM, z) > 0.5] = LC_FARM
    lc[(areas.get(AREA_FOREST, z) > 0.5) | (cv2.blur(canopy, (9, 9)) > 0.6)] = LC_FOREST
    lc[areas.get(AREA_ROCK, z) > 0.5] = LC_ROCK
    lc[areas.get(AREA_SAND, z) > 0.5] = LC_SAND
    lc[areas.get(AREA_WETLAND, z) > 0.5] = LC_MARSH
    lc[salt | ((areas.get(AREA_SALT, z) > 0.3) & (v['ndwi'] > 0))] = LC_SALT
    # pool to MN
    k = n_img // MN
    R = water.reshape(MN, k, MN, k).mean((1, 3))
    B = canopy.reshape(MN, k, MN, k).mean((1, 3))
    lcb = lc.reshape(MN, k, MN, k).transpose(0, 2, 1, 3).reshape(MN, MN, k * k)
    if k > 1:
        cnt = np.stack([(lcb == c).sum(2) for c in range(8)], 2)
        A = cnt.argmax(2).astype(np.uint8)
    else:
        A = lc
    G = raster_lights(L, tx, ty, MN)
    G = G * (1 - R)                                   # no street lights on water
    out = np.zeros((MN, MN, 4), np.uint8)
    out[..., 0] = np.clip(np.round(R * 255), 0, 255)
    out[..., 1] = np.clip(np.round(G * 255), 0, 255)
    out[..., 2] = np.clip(np.round(B * 255), 0, 255)
    out[..., 3] = A
    return out, dict(v=v, canopy=canopy > 0.5, water=water, hgt=hgt, px_m=px_m, n=n_img, landcover=lc)


def pool_children(L, tx, ty):
    """Mask from four children (MN each): mean water/canopy, mean/max blend for lights, majority landcover."""
    big = np.zeros((MN * 2, MN * 2, 4), np.float32)
    for (cl, cx, cy) in children(L, tx, ty):
        m = load(cl, cx, cy)
        if m is None:
            raise RuntimeError(f'missing child mask {cl}/{cx}_{cy}')
        dx = cx - tx * 2; dy = cy - ty * 2
        big[dy * MN:(dy + 1) * MN, dx * MN:(dx + 1) * MN] = m
    b4 = big.reshape(MN, 2, MN, 2, 4)
    out = np.zeros((MN, MN, 4), np.uint8)
    out[..., 0] = np.round(b4[..., 0].mean((1, 3)))
    out[..., 1] = np.round(np.clip(b4[..., 1].mean((1, 3)) * 0.7 + b4[..., 1].max((1, 3)) * 0.45, 0, 255))
    out[..., 2] = np.round(b4[..., 2].mean((1, 3)))
    lcs = b4[..., 3].transpose(0, 2, 1, 3).reshape(MN, MN, 4).astype(np.int64)
    # majority of 4 (ties -> first)
    cnt = np.zeros((MN, MN, 8), np.int32)
    for k in range(4):
        np.add.at(cnt, (np.arange(MN)[:, None], np.arange(MN)[None, :], lcs[..., k]), 1)
    out[..., 3] = cnt.argmax(2)
    return out


def encode(m):
    return zlib.compress(np.ascontiguousarray(m, np.uint8).tobytes(), 9)


def load(L, tx, ty):
    p = path('m', L, tx, ty, 'bin')
    if not os.path.exists(p):
        return None
    return np.frombuffer(zlib.decompress(open(p, 'rb').read()), np.uint8).reshape(MN, MN, 4)


def bake_tile(L, tx, ty, force=False, pooled=None):
    p = path('m', L, tx, ty, 'bin')
    if os.path.exists(p) and not force:
        return 'skip'
    if pooled is None:
        pooled = L <= 4 or (L in (5, 6) and all(exists(*c) and os.path.exists(path('m', *c, 'bin')) for c in children(L, tx, ty)))
    if pooled:
        m = pool_children(L, tx, ty)
    else:
        m, _ = compute_direct(L, tx, ty)
    write_atomic(p, encode(m))
    return 'ok'
