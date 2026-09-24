"""Tree tiles v2 (tiles/t2/7/tx_ty.bin, same record layout as tiles/t, see trees.py): the crowns detected in the NAIP
photo (tiles/t), now with MEASURED heights, plus the trees that detector misses.

  * height: the canopy height model (Meta / WRI global 1 m CHM, CC BY 4.0; tools/tiles/chm.py) inside each crown
    (the maximum over the crown's inner 60 %: the treetop), instead of a height guessed from crown width per species; where the
    CHM shows nothing (young street trees, gaps) the old estimate stays.
  * extra crowns: local maxima of the CHM (>= 4 m, >= 3 m apart) with no detected crown nearby, i.e. dark conifers and
    summer-dry trees the NDVI mask misses. Radius from the CHM pixels assigned to the peak (nearest peak within 12 m);
    kept off buildings, paving and water (ground material classes, tiles/mat), roads and the track bed.
  * species of added trees: region / elevation / height rules (tall + hills -> redwood / eucalyptus; hills -> oak /
    pine; ...), deterministic per tile.
  * beyond the imagery tiles (the wooded hills around the corridor, the Santa Cruz Mountains): trees from the canopy
    height model alone (build_chm_only), so the forests there stand in 3D instead of lying flat in the photo.
"""
import os
import numpy as np
import cv2
from scipy import ndimage
from .common import T, bounds, path, write_atomic, w2ll
from . import trees as TR
from . import chm as CH
from . import materials as MT
from . import heights as H_

CHN = 640                        # CHM grid over an L7 tile: 1.25 m cells (the source is 1.19 m)
NO_TREE = {MT.ROOF, MT.ASPHALT, MT.CONCRETE, MT.WATER, MT.SALT, MT.GRAVEL}


def _kind_for(reg, elev, h, r, rng):
    if elev > 150 and h > 26 and reg in ('mid', 'north', 'sf'):
        return TR.KIND['redwood'] if rng.random() < 0.6 else TR.KIND['eucalyptus']
    if h > 30:
        return TR.KIND['eucalyptus'] if rng.random() < 0.55 else (TR.KIND['redwood'] if reg in ('mid', 'north', 'sf') else TR.KIND['pine'])
    if elev > 110:
        return TR.KIND['oak'] if rng.random() < 0.7 else TR.KIND['pine']
    if h < 9 and r < 3.0:
        return TR.KIND['street']
    return [TR.KIND['oak'], TR.KIND['street'], TR.KIND['sycamore'], TR.KIND['cypress'], TR.KIND['pine']][int(rng.random() * 5)]


def build(tx, ty):
    """-> (records array in trees.DT, stats) or None when the tile has no tree tile."""
    p = path('t', 7, tx, ty, 'bin')
    if not os.path.exists(p):
        return None
    old = TR.decode(open(p, 'rb').read()).copy()
    x0, z0, _, _ = bounds(7, tx, ty); TT = T(7); cs = TT / CHN
    chm = CH.window(x0, z0, TT, CHN)
    have = np.isfinite(chm)
    st = dict(old=len(old), measured=0, added=0, chm=bool(have.any()))
    if not have.any():
        return old, st
    chm = np.where(have, chm, 0.0).astype(np.float32)
    # 1. measured heights for the detected crowns
    X = old['x'].astype(np.float64) / 65536.0 * TT; Z = old['z'].astype(np.float64) / 65536.0 * TT
    R = old['r'].astype(np.float64) * 0.1
    for i in range(len(old)):
        rr = max(1.0, R[i] * 0.6) / cs
        ci, cj = X[i] / cs - 0.5, Z[i] / cs - 0.5
        i0, i1 = max(0, int(ci - rr)), min(CHN, int(ci + rr) + 2); j0, j1 = max(0, int(cj - rr)), min(CHN, int(cj + rr) + 2)
        if i0 >= i1 or j0 >= j1:
            continue
        blk = chm[j0:j1, i0:i1]
        yy, xx = np.mgrid[j0:j1, i0:i1]
        sel = (xx - ci) ** 2 + (yy - cj) ** 2 <= rr * rr
        v = blk[sel]
        if len(v) and v.max() >= 2.5:
            h = float(v.max())                                           # the treetop (the CHM smooths peaks: never p90)
            old['h'][i] = int(np.clip(round(h * 4.0), 8, 255)); st['measured'] += 1
    # 2. crowns the photo detector missed: CHM peaks >= 4 m, >= 3 m from each other and from detected crowns
    sm = cv2.GaussianBlur(chm, (0, 0), 1.0)
    peaks = (sm >= ndimage.maximum_filter(sm, size=5) - 1e-6) & (sm >= 4.0)
    py, px = np.nonzero(peaks)
    if len(px):
        from scipy.spatial import cKDTree
        PX, PZ = (px + 0.5) * cs, (py + 0.5) * cs
        keep = np.ones(len(px), bool)
        if len(old):
            kd = cKDTree(np.stack([X, Z], 1))
            d, j = kd.query(np.stack([PX, PZ], 1))
            keep &= d > np.maximum(3.0, R[np.minimum(j, len(R) - 1)] * 0.8)
        # ground material there: never on roofs, paving, gravel or water
        mat = MT.load(tx, ty)
        if mat is not None:
            mi = np.clip((PX / MT.CELL).astype(int), 0, MT.N - 1); mj = np.clip((PZ / MT.CELL).astype(int), 0, MT.N - 1)
            keep &= ~np.isin(mat[mj, mi], list(NO_TREE))
        # the track bed (same clearance as the photo detector)
        dtr, _ = TR._trk().query(np.stack([x0 + PX, z0 + PZ], 1), distance_upper_bound=200.0)
        keep &= ~(dtr < 12.0)
        py, px, PX, PZ = py[keep], px[keep], PX[keep], PZ[keep]
    if len(px):
        # crown extent: CHM pixels >= 2.5 m (and >= 45 % of the peak) assigned to the nearest new peak within 12 m
        markers = np.zeros((CHN, CHN), np.int32); markers[py, px] = np.arange(1, len(px) + 1)
        dist, (iy, ix) = ndimage.distance_transform_edt(markers == 0, return_indices=True)
        lab = markers[iy, ix]
        pk = sm[py, px]                                                   # (smoothed: crown extent)
        top = ndimage.maximum_filter(chm, size=3)[py, px]                 # (raw: the treetop's height)
        lab[(chm < 2.5) | (dist * cs > 12.0)] = 0
        lab[(lab > 0) & (chm < 0.45 * pk[np.maximum(lab - 1, 0)])] = 0
        area = np.bincount(lab.ravel(), minlength=len(px) + 1)[1:] * cs * cs
        r = np.clip(np.sqrt(area / np.pi), 1.3, 12.0)
        ok = area >= 6.0
        py, px, PX, PZ, r, pk, top = py[ok], px[ok], PX[ok], PZ[ok], r[ok], pk[ok], top[ok]
        rng = np.random.default_rng((tx * 91138233) ^ (ty * 2971215073 & 0xffffffff) ^ 0x7ee5)
        H7 = H_.load(7, tx, ty)
        lat, _ = w2ll(x0 + PX, z0 + PZ)
        add = np.zeros(len(px), dtype=TR.DT)
        for i in range(len(px)):
            elev = float(H7[min(128, int(PZ[i] / TT * 128)), min(128, int(PX[i] / TT * 128))]) if H7 is not None else 0.0
            add['kind'][i] = _kind_for(TR.region_of(lat[i]), elev, float(top[i]), float(r[i]), rng)
        add['x'] = np.clip(np.round(PX / TT * 65536.0), 0, 65535); add['z'] = np.clip(np.round(PZ / TT * 65536.0), 0, 65535)
        add['r'] = np.clip(np.round(r * 10.0), 13, 255); add['h'] = np.clip(np.round(top * 4.0), 16, 255)
        add['tint'] = rng.integers(40, 150, len(px))
        st['added'] = len(add)
        old = np.concatenate([old, add])
    return old, st


def build_chm_only(tx, ty):
    """Trees for an L7 tile outside the imagery coverage (the wooded hills around the corridor): canopy height model
    peaks only (>= 5 m, >= ~9 m apart), crown radius from the pixels assigned to each peak, species by region /
    elevation / height, off water (L6 mask). -> (records, stats) or None when the tile has (almost) no canopy."""
    from . import masks as M_
    x0, z0, _, _ = bounds(7, tx, ty); TT = T(7); cs = TT / CHN
    chm = CH.window(x0, z0, TT, CHN)
    have = np.isfinite(chm)
    if not have.any():
        return None
    chm = np.where(have, chm, 0.0).astype(np.float32)
    if (chm >= 3.0).mean() < 0.02:
        return None
    sm = cv2.GaussianBlur(chm, (0, 0), 1.0)
    peaks = (sm >= ndimage.maximum_filter(sm, size=7) - 1e-6) & (sm >= 5.0)
    py, px = np.nonzero(peaks)
    if not len(px):
        return None
    PX, PZ = (px + 0.5) * cs, (py + 0.5) * cs
    keep = np.ones(len(px), bool)
    m6 = M_.load(6, tx >> 1, ty >> 1)                                    # water: the L6 mask (6.25 -> 12.5 m cells)
    if m6 is not None:
        ci = np.clip(((tx & 1) * TT + PX) / (2 * TT) * m6.shape[1], 0, m6.shape[1] - 1).astype(int)
        cj = np.clip(((ty & 1) * TT + PZ) / (2 * TT) * m6.shape[0], 0, m6.shape[0] - 1).astype(int)
        keep &= m6[cj, ci, 0] < 128
    dtr, _ = TR._trk().query(np.stack([x0 + PX, z0 + PZ], 1), distance_upper_bound=200.0)
    keep &= ~(dtr < 12.0)
    py, px, PX, PZ = py[keep], px[keep], PX[keep], PZ[keep]
    if not len(px):
        return None
    markers = np.zeros((CHN, CHN), np.int32); markers[py, px] = np.arange(1, len(px) + 1)
    dist, (iy, ix) = ndimage.distance_transform_edt(markers == 0, return_indices=True)
    lab = markers[iy, ix]; pk = sm[py, px]; top = ndimage.maximum_filter(chm, size=3)[py, px]
    lab[(chm < 2.5) | (dist * cs > 12.0)] = 0
    lab[(lab > 0) & (chm < 0.45 * pk[np.maximum(lab - 1, 0)])] = 0
    area = np.bincount(lab.ravel(), minlength=len(px) + 1)[1:] * cs * cs
    ok = area >= 6.0
    PX, PZ, area, top = PX[ok], PZ[ok], area[ok], top[ok]
    r = np.clip(np.sqrt(area / np.pi), 1.3, 12.0)
    rng = np.random.default_rng((tx * 91138233) ^ (ty * 2971215073 & 0xffffffff) ^ 0x6c11)
    L6h = H_.load(6, tx >> 1, ty >> 1)
    lat, _ = w2ll(x0 + PX, z0 + PZ)
    out = np.zeros(len(PX), dtype=TR.DT)
    for i in range(len(PX)):
        elev = 0.0
        if L6h is not None:
            elev = float(L6h[min(128, int(((ty & 1) * TT + PZ[i]) / (2 * TT) * 128)), min(128, int(((tx & 1) * TT + PX[i]) / (2 * TT) * 128))])
        out['kind'][i] = _kind_for(TR.region_of(lat[i]), elev, float(top[i]), float(r[i]), rng)
    out['x'] = np.clip(np.round(PX / TT * 65536.0), 0, 65535); out['z'] = np.clip(np.round(PZ / TT * 65536.0), 0, 65535)
    out['r'] = np.clip(np.round(r * 10.0), 13, 255); out['h'] = np.clip(np.round(top * 4.0), 16, 255)
    out['tint'] = rng.integers(40, 150, len(PX))
    return out, dict(old=0, measured=0, added=len(out), chm=True, hills=1)


def out_path(tx, ty):
    return path('t2', 7, tx, ty, 'bin')


def bake_tile(tx, ty, force=False):
    p = out_path(tx, ty)
    if os.path.exists(p) and not force:
        return (tx, ty, 'skip', None)
    r = build(tx, ty) if os.path.exists(path('t', 7, tx, ty, 'bin')) else build_chm_only(tx, ty)
    if r is None:
        return (tx, ty, 'none', None)
    arr, st = r
    write_atomic(p, TR.encode(arr))
    return (tx, ty, 'ok', st)
