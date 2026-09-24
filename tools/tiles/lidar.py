"""Lidar detail heights (tiles/h9/L/tx_ty.bin, L8 3.125 m and L9 1.5625 m spacing), same 129x129 encoding as tiles/h.

Source: USGS 3DEP bare-earth DEM, 1 m lidar where available (best available elsewhere), via the 3DEPElevation
ImageServer exportImage in EPSG:4326 (the Bayline frame is linear in lon/lat, so a tile is an exact lon/lat box and
pixel centres can sit exactly on the tile vertices). Public domain (USGS).

Detail transfer, not replacement: the existing L7 surface (tiles/h/7, 6.25 m, carved along the track, with the Bay's
bathymetry) stays the ground truth at large scales, so everything already built on it (track bed, platforms, roads,
towns, bridges, runways) keeps its heights. Only the lidar's fine relief is added on top:
    h = L7(x) + w(x) * (lidar(x) - lowpass_L7(lidar)(x))
where lowpass_L7 is the lidar seen through the L7 grid (box-averaged to 6.25 m, bilinear back up), and w fades the
detail out on the track bed and station zones (modelled geometry), over water and where the lidar has no data.
L8 tiles are fetched once at 1.5625 m with a margin (so filters are identical across tile edges); their four L9
children are cut from the same grid, and the L8 tile itself is the [1 2 1]-smoothed detail at every second sample.
"""
import io, os, threading, zlib
import numpy as np
import cv2
from PIL import Image
from scipy.spatial import cKDTree
from . import fetch
from .common import HN, T, bounds, w2ll, ll2w, track, path, write_atomic, log, RAW, PUB as PUB_TILES
from . import heights as H_

URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
CACHE = os.path.join(RAW, 'lidar3dep')
M = 8                          # margin samples around the L8 vertex grid
NV = 257                       # L8 tile vertices per side at 1.5625 m (two L9 tiles of 129 sharing an edge)
NF = NV + 2 * M                # fetched samples per side
STEP9 = T(9) / 128.0           # 1.5625 m
NODATA = -9999.0
QS = 64.0                      # h9 quantisation: q = round((h - o) * QS), 1/64 m steps (1/16 m would terrace the
                               # shading of gentle slopes at 1.56 m spacing), o = a per-L8-tile offset (index row), so
                               # every tile from the Golden Gate channel to Mt Hamilton fits (and the MED codec's raw
                               # first sample stays < 2^15: (h - o) < 512 m)


# ------------------------------------------------------------------ fetch
def _url(tx, ty):
    x0, z0, _, _ = bounds(8, tx, ty)
    # pixel centres at x0 + (i - M) * STEP9, i = 0..NF-1: the bbox reaches half a sample beyond them
    xa = x0 - (M + 0.5) * STEP9; xb = x0 + (NV - 1 + M + 0.5) * STEP9
    za = z0 - (M + 0.5) * STEP9; zb = z0 + (NV - 1 + M + 0.5) * STEP9
    lat_n, lon_w = w2ll(xa, za); lat_s, lon_e = w2ll(xb, zb)
    return (f'{URL}?bbox={lon_w:.9f},{lat_s:.9f},{lon_e:.9f},{lat_n:.9f}&bboxSR=4326&imageSR=4326&size={NF},{NF}'
            f'&format=tiff&pixelType=F32&noData={NODATA:.0f}&interpolation=RSP_BilinearInterpolation&adjustAspectRatio=false&f=image')


def cache_path(tx, ty):
    return os.path.join(CACHE, '8', f'{tx}_{ty}.npz')


def fetch_l8(tx, ty):
    """Lidar samples (NF x NF float32, NaN = no data) around L8 tile (tx, ty); cached as compressed npz."""
    p = cache_path(tx, ty)
    if os.path.exists(p):
        try:
            return np.load(p)['h']
        except Exception:
            os.remove(p)
    tmp = os.path.join(CACHE, 'tmp', f'{tx}_{ty}_{threading.get_ident()}.tif')
    raw = fetch.get_cached(_url(tx, ty), tmp, min_bytes=1000, timeout=120,
                           validate=lambda r: r.headers.get('content-type', '').startswith('image/'))
    a = np.asarray(Image.open(io.BytesIO(raw)), np.float32)
    try:
        os.remove(tmp)
    except OSError:
        pass
    if a.shape != (NF, NF):
        raise IOError(f'lidar {tx},{ty}: shape {a.shape}')
    a = np.where(a <= NODATA + 1, np.nan, a).astype(np.float32)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    np.savez_compressed(p + '.tmp.npz', h=a)
    os.replace(p + '.tmp.npz', p)
    return a


# ------------------------------------------------------------------ detail transfer
_kd = None
_zones = None


def _track_index():
    global _kd, _zones
    if _kd is None:
        tr = track()
        _kd = cKDTree(np.stack([tr['X'], tr['Z']], 1))
        zones = []
        feat = tr['feat']
        for pl in feat.get('platforms', []):
            zones.append((pl['s0'] - 15.0, pl['s1'] + 15.0, abs(pl['off']) + 11.0))
        for st in feat.get('stations', []):
            zones.append((st['s'] - 120.0, st['s'] + 120.0, max(14.0, abs(st.get('off', 0.0)) * 0.5 + 10.0)))
        _zones = zones
    return _kd, _zones


def keep_weight(X, Z):
    """1 = full lidar detail, 0 = none: the modelled track bed (+-12 m, fading out by 30 m), station and platform
    zones (flattened in the base surface), tunnels. X, Z: world coords (any shape)."""
    tr = track()
    kd, zones = _track_index()
    flat = np.stack([X.ravel(), Z.ravel()], 1)
    d, k = kd.query(flat, distance_upper_bound=200.0)
    w = np.ones(flat.shape[0], np.float32)
    ok = np.isfinite(d)
    if ok.any():
        idx = np.where(ok)[0]; kk = np.clip(k[idx], 0, tr['n'] - 1); dd = d[idx]
        wt = np.clip((dd - 12.0) / 18.0, 0.0, 1.0)
        s = kk * tr['step']
        lat = (flat[idx, 0] - tr['X'][kk]) * tr['rx'][kk] + (flat[idx, 1] - tr['Z'][kk]) * tr['rz'][kk]
        for (a, b, r) in zones:
            m = (s > a - 20.0) & (s < b + 20.0)
            if not m.any():
                continue
            ws = np.clip(np.maximum(a - s[m], s[m] - b) / 20.0, 0.0, 1.0)          # 0 inside the zone
            wl = np.clip((np.abs(lat[m]) - r) / 20.0, 0.0, 1.0)
            wt[m] = np.minimum(wt[m], np.maximum(ws, wl))
        wt[tr['tunnel'][kk]] = np.minimum(wt[tr['tunnel'][kk]], np.clip((dd[tr['tunnel'][kk]] - 30.0) / 30.0, 0, 1))
        w[idx] = wt
    return w.reshape(X.shape)


# ------------------------------------------------------------------ modelled ground: keep the base surface
# Towns builds its road ribbons (and the yards of its infill houses) on the L7 surface (Terrain.hBase); runways follow
# it too, and a few landmarks are draped on it. Lidar relief under those would poke through or leave them floating,
# so the detail is held at zero there and ramps in outside.
ROAD_MARGIN, ROAD_RAMP = 1.0, 4.0           # m beyond the widest ribbon Towns draws, then the ramp to full detail
RWY_MARGIN, RWY_RAMP = 25.0, 25.0
DRAPED = [(37.6633725, -122.4181018, 140.0, 30.0)]   # Sign Hill letters (50_landmarks.js): lat, lon, radius, ramp
EDGE_RAMP = 60.0                            # fade to zero toward L8 tiles without lidar (no step at the coverage edge)
_rwys = None


def _runways():
    """Runways inside the square (OurAirports, as 16_airports.js draws them): [(ax, az, bx, bz, half-width m)]."""
    global _rwys
    if _rwys is None:
        import json
        from .common import PUB as _P
        _rwys = []
        p = os.path.join(os.path.dirname(_P), 'air', 'airports.json')
        if os.path.exists(p):
            for a in json.load(open(p))['a']:
                for w in a[10]:
                    la, oa, lb, ob, wft, approx = w[2], w[3], w[4], w[5], w[9], w[14]
                    if approx or not (36.9 < la < 37.9 and -122.65 < oa < -121.4):
                        continue
                    A = ll2w(la, oa); B = ll2w(lb, ob)
                    _rwys.append((A[0], A[1], B[0], B[1], max(wft * 0.3048, 10.0) / 2))
    return _rwys


def _seg_dist(X, Z, ax, az, bx, bz):
    """Distance from points (X, Z) to the segment a-b (exact)."""
    dx, dz = bx - ax, bz - az; L2 = dx * dx + dz * dz
    t = np.clip(((X - ax) * dx + (Z - az) * dz) / L2, 0.0, 1.0) if L2 > 1e-9 else 0.0
    return np.hypot(X - (ax + t * dx), Z - (az + t * dz))


def modelled_weight(tx, ty):
    """1 = lidar detail allowed, 0 = keep the base surface (Towns road ribbons and infill yards, runways, draped
    landmarks), on the NV x NV vertex grid of L8 tile (tx, ty). Every term is an exact function of world position
    (segment distances, cell-aligned masks), so two tiles agree on their shared edge to the last bit."""
    from . import towns_dec as TD
    x0, z0, _, _ = bounds(8, tx, ty)
    PADV = 8                                           # margin samples for the yard ramp (> ROAD_RAMP)
    g = np.arange(-PADV, NV + PADV) * STEP9
    X, Z = np.meshgrid(x0 + g, z0 + g); n = NV + 2 * PADV
    big = np.full((n, n), 1e9)                           # distance to the nearest ribbon edge (m, <= 0 inside)
    inf = np.zeros((n, n), bool)
    xa, za, xb, zb = x0 + g[0] - 40.0, z0 + g[0] - 40.0, x0 + g[-1] + 40.0, z0 + g[-1] + 40.0
    for ty7 in range(int((za - TD.Z0) // TD.TILE), int((zb - TD.Z0) // TD.TILE) + 1):
        for tx7 in range(int((xa - TD.X0) // TD.TILE), int((xb - TD.X0) // TD.TILE) + 1):
            d = TD.decode(tx7, ty7)
            if d is None:
                continue
            for r in d['roads']:
                P = r['pts']
                if r['flags'] & 2 or len(P) < 2:        # bridges: the ribbon is on the deck, not the ground
                    continue
                e = TD.road_extent(r, d['region']) + ROAD_MARGIN; rr = e + ROAD_RAMP
                for (ax, az), (bx, bz) in zip(P[:-1], P[1:]):
                    i_0 = max(0, int(np.floor((min(ax, bx) - rr - X[0, 0]) / STEP9))); i_1 = min(n, int(np.ceil((max(ax, bx) + rr - X[0, 0]) / STEP9)) + 1)
                    j_0 = max(0, int(np.floor((min(az, bz) - rr - Z[0, 0]) / STEP9))); j_1 = min(n, int(np.ceil((max(az, bz) + rr - Z[0, 0]) / STEP9)) + 1)
                    if i_0 >= i_1 or j_0 >= j_1:
                        continue
                    sub = _seg_dist(X[j_0:j_1, i_0:i_1], Z[j_0:j_1, i_0:i_1], ax, az, bx, bz) - e
                    np.minimum(big[j_0:j_1, i_0:i_1], sub, out=big[j_0:j_1, i_0:i_1])
            if d['infill'] is not None:                # 25 m cells, exactly 16 vertex spacings, world-aligned
                cx = np.floor((X - d['ox']) / 25.0).astype(int); cz = np.floor((Z - d['oz']) / 25.0).astype(int)
                ok = (cx >= 0) & (cx < 32) & (cz >= 0) & (cz < 32)
                inf[ok] |= d['infill'][cz[ok], cx[ok]]
    w = np.clip(big / ROAD_RAMP, 0.0, 1.0).astype(np.float32)
    if inf.any():                                     # (the ramp around yards: exact distance to the marked cells)
        dist = cv2.distanceTransform((~inf).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE) * STEP9
        w = np.minimum(w, np.clip(dist / ROAD_RAMP, 0.0, 1.0).astype(np.float32))
    w = w[PADV:PADV + NV, PADV:PADV + NV]; X = X[PADV:PADV + NV, PADV:PADV + NV]; Z = Z[PADV:PADV + NV, PADV:PADV + NV]
    for (ax, az, bx, bz, hw) in _runways():
        if max(ax, bx) + hw + 100 < x0 or min(ax, bx) - hw - 100 > x0 + 400 or max(az, bz) + hw + 100 < z0 or min(az, bz) - hw - 100 > z0 + 400:
            continue
        w = np.minimum(w, np.clip((_seg_dist(X, Z, ax, az, bx, bz) - hw - RWY_MARGIN) / RWY_RAMP, 0.0, 1.0).astype(np.float32))
    for (la, lo, rad, ramp) in DRAPED:
        cx, cz = ll2w(la, lo)
        w = np.minimum(w, np.clip((np.hypot(X - cx, Z - cz) - rad) / ramp, 0.0, 1.0).astype(np.float32))
    return w


_l8set = None


def edge_weight(tx, ty):
    """Fade the detail to zero toward any neighbouring L8 tile that gets no lidar (outside the imagery coverage)."""
    global _l8set
    if _l8set is None:
        import json
        _l8set = {tuple(t) for t in json.load(open(os.path.join(PUB_TILES, 'index.json')))['levels']['8']}
    x0, z0, _, _ = bounds(8, tx, ty)
    g = np.arange(NV) * STEP9
    X = (x0 + g)[None, :]; Z = (z0 + g)[:, None]
    w = np.ones((NV, NV), np.float32)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if (dx or dy) and (tx + dx, ty + dy) not in _l8set:
                a0, b0, a1, b1 = bounds(8, tx + dx, ty + dy)
                ddx = np.maximum(np.maximum(a0 - X, X - a1), 0.0); ddz = np.maximum(np.maximum(b0 - Z, Z - b1), 0.0)
                w = np.minimum(w, np.clip(np.hypot(ddx, ddz) / EDGE_RAMP, 0.0, 1.0).astype(np.float32))
    return w


def _lowpass_l7(a):
    """The lidar as the L7 grid sees it: box-average 4x4 (6.25 m) at every 4th sample, bilinear back up.
    a: (NF x NF) with the vertex grid at [M:M+NV]; returns the low-pass on the NV x NV vertex grid."""
    box = cv2.blur(a, (5, 5), borderType=cv2.BORDER_REPLICATE)            # ~6.25 m support (odd kernel, centred)
    v = box[M:M + NV:4, M:M + NV:4]                                      # 65 x 65 samples at the L7 vertices
    return _bilin_up4(v)


def _bilin_up4(v):
    """Exact bilinear upsampling x4 of a vertex grid (n -> 4n-3): the values between vertices are what a GPU's
    linear filter draws between them."""
    n = v.shape[0]; out_n = 4 * (n - 1) + 1
    t = np.arange(out_n) / 4.0
    i0 = np.minimum(np.floor(t).astype(int), n - 2); f = (t - i0).astype(np.float32)
    rows = v[i0, :] * (1 - f)[:, None] + v[i0 + 1, :] * f[:, None]
    return rows[:, i0] * (1 - f)[None, :] + rows[:, i0 + 1] * f[None, :]


def _old7_on_grid(tx8, ty8):
    """The existing L7 surface (bilinear through its 6.25 m vertices) at the L8 tile's 1.5625 m vertex grid."""
    tx7, ty7 = tx8 >> 1, ty8 >> 1
    H7 = H_.load(7, tx7, ty7)
    if H7 is None:
        return None
    ox, oy = (tx8 - tx7 * 2) * 64, (ty8 - ty7 * 2) * 64                  # this L8 tile = 65 L7 vertices from here
    return _bilin_up4(H7[oy:oy + 65, ox:ox + 65].astype(np.float32))


def water_weight(tx8, ty8):
    """Water fraction (0..1) on the NV x NV grid, from the L7 masks (R channel), slightly dilated (shores). Built on a
    3x3 mosaic of L7 mask tiles, so both sides of an L7 edge see the same cells (no seams in the detail there)."""
    from . import masks as M_
    tx7, ty7 = tx8 >> 1, ty8 >> 1
    mos = np.zeros((384, 384), np.float32); any_ = False
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            m = M_.load(7, tx7 + dx, ty7 + dy)
            if m is not None:
                mos[(dy + 1) * 128:(dy + 2) * 128, (dx + 1) * 128:(dx + 2) * 128] = m[..., 0].astype(np.float32) / 255.0; any_ = True
    if not any_:
        return np.zeros((NV, NV), np.float32)
    w = cv2.dilate(mos, np.ones((3, 3), np.uint8))
    # cell centres (i + 0.5) * 6.25 m; the L8 tile covers cells [ox, ox + 64) of the centre L7 tile (offset 128 in the mosaic)
    ox, oy = 128 + (tx8 - tx7 * 2) * 64, 128 + (ty8 - ty7 * 2) * 64
    u = (ox + np.arange(NV) * 0.25) - 0.5
    v = (oy + np.arange(NV) * 0.25) - 0.5
    mu, mv = np.meshgrid(u.astype(np.float32), v.astype(np.float32))
    return cv2.remap(w, mu, mv, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def mosaic_input(tx, ty):
    """The NF x NF lidar samples around L8 tile (tx, ty), each taken from the fetch of the tile that owns it (the one
    whose [x0, x0 + 400) x [z0, z0 + 400) holds it). Neighbouring ImageServer requests can disagree in their overlap
    (source selection / mosaicking), so this makes both sides of every tile edge compute from identical data."""
    a = fetch_l8(tx, ty).copy()
    gi = np.arange(NF) - M                                # sample index relative to this tile's first vertex
    d = np.floor_divide(gi, 256)                           # owner offset: -1 (margin before), 0 (own), 1 (edge + after)
    li = gi - 256 * d + M                                  # index into the owner's fetch
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if (dx or dy) and os.path.exists(cache_path(tx + dx, ty + dy)):
                nb = fetch_l8(tx + dx, ty + dy)
                r = np.nonzero(d == dy)[0]; c = np.nonzero(d == dx)[0]
                a[np.ix_(r, c)] = nb[np.ix_(li[r], li[c])]
    return a


def compute_l8(tx, ty):
    """-> (detail NV x NV float32, base NV x NV, stats) or None when the L7 base is missing. H9 = base + detail."""
    base = _old7_on_grid(tx, ty)
    if base is None:
        return None
    a = mosaic_input(tx, ty)
    nd = ~np.isfinite(a)
    fill = np.where(nd, np.nanmean(a) if (~nd).any() else 0.0, a).astype(np.float32)
    lp = _lowpass_l7(fill)
    det = fill[M:M + NV, M:M + NV] - lp
    x0, z0, _, _ = bounds(8, tx, ty)
    g = np.arange(NV, dtype=np.float64) * STEP9
    X, Z = np.meshgrid(x0 + g, z0 + g)
    w = keep_weight(X, Z) * (1.0 - np.clip(water_weight(tx, ty) * 1.5, 0, 1)) * modelled_weight(tx, ty) * edge_weight(tx, ty)
    # (dilated on the whole fetch, then cropped: identical on both sides of a tile edge; +-6 samples covers the
    # low-pass footprint, so the no-data fill never leaks into kept detail)
    ndv = cv2.dilate(nd.astype(np.uint8), np.ones((13, 13), np.uint8))[M:M + NV, M:M + NV].astype(bool)
    w = np.where(ndv, 0.0, w).astype(np.float32)
    det = (np.clip(det, -12.0, 12.0) * w).astype(np.float32)             # (clip: lidar blunders, pits, spikes)
    st = dict(nodata=float(nd[M:M + NV, M:M + NV].mean()), det_sd=float(det.std()), det_max=float(np.abs(det).max()),
              water=float((w < 0.05).mean()))
    return det, base, st


# ------------------------------------------------------------------ bake + index
def out_path(L, tx, ty):
    return path('h9', L, tx, ty, 'bin')


META = os.path.join(CACHE, 'meta')             # per-L8-tile [childMask, offset] (the index is built from these)
DET = os.path.join(CACHE, 'det')               # pass-1 detail grids (float16), read by pass 2 for the L8 tiles' rims


def meta_path(tx, ty):
    return os.path.join(META, f'{tx}_{ty}.json')


def det_path(tx, ty):
    return os.path.join(DET, f'{tx}_{ty}.npy')


def bake_l9(tx, ty, force=False):
    """Pass 1: the four tiles/h9/9 children of L8 tile (tx, ty) and its detail grid (for pass 2). Children with no
    lidar detail (open water, no data) are skipped: the renderer uses the L8 tile there. Returns (tx, ty, childmask,
    stats, offset); childmask -1 = no L7 base here (nothing written)."""
    import json
    pm = meta_path(tx, ty)
    if os.path.exists(pm) and os.path.exists(det_path(tx, ty)) and not force:
        mask, o = json.load(open(pm))
        return (tx, ty, mask, None, o)
    r = compute_l8(tx, ty)
    if r is None:
        return (tx, ty, -1, None, 0)
    det, base, st = r
    H9 = base + det
    lo, hi = float(H9.min()), float(H9.max())
    o = int(np.floor((lo - 16.0) / 8.0)) * 8                             # >= 16 m below every sample (L8 smoothing slack)
    if hi + 16.0 - o > 511.0:
        raise ValueError(f'h9 {tx},{ty}: relief {lo:.0f}..{hi:.0f} m exceeds one tile offset')
    mask = 0
    for dy in (0, 1):
        for dx in (0, 1):
            sl = np.s_[dy * 128:dy * 128 + HN, dx * 128:dx * 128 + HN]
            p9 = out_path(9, tx * 2 + dx, ty * 2 + dy)
            if np.abs(det[sl]).max() < 0.05:                                # nothing to add here
                if os.path.exists(p9):
                    os.remove(p9)
                continue
            write_atomic(p9, H_.encode(H9[sl], QS, -o))
            mask |= 1 << (dy * 2 + dx)
    os.makedirs(DET, exist_ok=True)
    np.save(det_path(tx, ty) + '.tmp.npy', det.astype(np.float16)); os.replace(det_path(tx, ty) + '.tmp.npy', det_path(tx, ty))
    write_atomic(pm, json.dumps([mask, o]).encode())
    return (tx, ty, mask, st, o)


def bake_l8(tx, ty, force=False):
    """Pass 2: tiles/h9/8 = base + the [1 2 1]-smoothed detail at every second sample. The smoothing at the tile's rim
    uses the neighbours' detail (from pass 1), so adjacent L8 tiles agree on their shared edge."""
    import json
    p8, pm = out_path(8, tx, ty), meta_path(tx, ty)
    if not os.path.exists(pm) or not os.path.exists(det_path(tx, ty)):
        return (tx, ty, 'missing')
    if os.path.exists(p8) and not force:
        return (tx, ty, 'skip')
    _, o = json.load(open(pm))
    base = _old7_on_grid(tx, ty)
    D = np.zeros((NV + 2, NV + 2), np.float32); have = np.zeros((NV + 2, NV + 2), bool)
    D[1:-1, 1:-1] = np.load(det_path(tx, ty)).astype(np.float32); have[1:-1, 1:-1] = True
    # rim: the neighbours' samples just beyond the shared edges (their column 1 is our column NV, 255 is our -1)
    idx = {-1: (0, 255), 0: (slice(1, NV + 1), slice(0, NV)), 1: (NV + 1, 1)}
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if not (dx or dy) or not os.path.exists(det_path(tx + dx, ty + dy)):
                continue
            nb = np.load(det_path(tx + dx, ty + dy)).astype(np.float32)
            (yd, ys), (xd, xs) = idx[dy], idx[dx]
            D[yd, xd] = nb[ys, xs]; have[yd, xd] = True
    for (sl, src) in ((np.s_[0, :], np.s_[1, :]), (np.s_[-1, :], np.s_[-2, :]), (np.s_[:, 0], np.s_[:, 1]), (np.s_[:, -1], np.s_[:, -2])):
        miss = ~have[sl]                                                  # no neighbour there: replicate (as before)
        if miss.any():
            v = D[sl]; v[miss] = D[src][miss]; D[sl] = v
    k = np.array([0.25, 0.5, 0.25], np.float32)
    ds = cv2.sepFilter2D(D, -1, k, k, borderType=cv2.BORDER_REPLICATE)[1:-1, 1:-1]
    H8 = base[::2, ::2] + ds[::2, ::2]
    write_atomic(p8, H_.encode(H8, QS, -o))
    return (tx, ty, 'ok')
