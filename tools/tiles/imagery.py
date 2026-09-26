"""Imagery tiles (SPEC_v2: tiles/img/L/tx_ty.jpg, L0-L8, 512x512 JPEG, north up, pixel centres at (u+0.5)/512).

Source: USDA NAIP 0.6 m (via USGS The National Map NAIPPlus ImageServer exportImage, EPSG:4326 bbox = the tile).
  L7 tiles with L8 children: RGB 2048 px (0.39 m/px) -> 1024 -> four 512 L8 tiles, and -> 512 for L7.
  other L7 tiles:            RGB 1024 px -> 512.
  NIR (band 4) is fetched at 1024 for every L7 tile (masks, NDVI tree detection).
  L6 / L5: mosaic of the four children when they all exist, else a direct 1024 px fetch (+ 512 NIR).
  L4..L0: mosaic of children.
NAIP no-data (open ocean, parts of the Bay) is pure black: replaced by a constant water colour with a feathered edge.
One global colour transform (haze/black point, white point, warm balance, gentle S-curve, +saturation) for every tile.
"""
import io, os
import numpy as np
from PIL import Image
import cv2
from . import fetch
from .common import IMG, bbox_ll, path, write_atomic, exists, children, log, WORK

JPEG_Q = 87

# ------------------------------------------------------------------ colour
BAL = dict(black=(58.0, 68.0, 74.0), white=(226.0, 224.0, 230.0), gain=(1.035, 1.0, 0.925),
           gamma=1.04, contrast=0.12, sat=1.14, lift=0.012)
WATER_RAW = np.array([96.0, 110.0, 112.0], np.float32)    # typical NAIP Bay water, raw DN
# Bayline Metro bakes: the no-data fill is the median NAIP water along the no-data edges of the new tiles (San Pablo and
# Suisun Bays, measured: 132 144 147): uniform open water that matches the photographed shallows (the older fill was
# ~1 stop darker and showed as flat dark rectangles from the air). Tiles baked before keep WATER_RAW.
WATER_BAY = np.array([130.0, 143.0, 146.0], np.float32)


def balance(rgb):
    """float32 HxWx3 raw DN (0..255) -> float32 0..1 balanced."""
    b = np.array(BAL['black'], np.float32); w = np.array(BAL['white'], np.float32)
    x = (rgb - b) / (w - b)
    x = x * np.array(BAL['gain'], np.float32)
    x = np.clip(x, 0.0, 1.2)
    x = np.power(x, BAL['gamma'])
    # gentle S-curve around 0.45
    c = BAL['contrast']
    x = x + c * (x - 0.45) * (1.0 - np.abs(x - 0.45) / 0.55).clip(0, 1)
    # saturation around luma
    Y = (0.2126 * x[..., 0] + 0.7152 * x[..., 1] + 0.0722 * x[..., 2])[..., None]
    x = Y + (x - Y) * BAL['sat']
    x = x + BAL['lift']
    return np.clip(x, 0.0, 1.0)


def to_u8(x):
    return np.clip(x * 255.0 + 0.5, 0, 255).astype(np.uint8)


# ------------------------------------------------------------------ decode / no-data
def _dec_rgb(b):
    return np.asarray(Image.open(io.BytesIO(b)).convert('RGB'))


def _dec_gray(b):
    return np.asarray(Image.open(io.BytesIO(b)).convert('L'))


def nodata_mask(rgb_u8):
    m = rgb_u8.max(axis=2) < 12
    if not m.any():
        return m
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    m = cv2.dilate(m, np.ones((5, 5), np.uint8))
    return m.astype(bool)


FILL_LOCAL = True        # (Bayline Metro bakes: the local water colour; tiles baked before used WATER_RAW everywhere)


def _ring_colour(rgb, nd):
    """median raw colour of the valid water along the no-data edge, or None"""
    k = max(5, int(round(rgb.shape[0] / 26))) | 1
    ring = cv2.dilate(nd.astype(np.uint8), np.ones((k, k), np.uint8)).astype(bool) & ~nd
    if ring.sum() <= 400:
        return None
    v = rgb[ring]; lum = v.mean(1)
    v = v[(lum < np.percentile(lum, 70)) & (lum > 25)]            # (water, not a bright beach, glint or the black edge)
    return np.median(v, axis=0).astype(np.float32) if len(v) > 200 else None


def _neighbour_water(L, tx, ty, px):
    """for a tile with no data at all: the ring colour of the nearest neighbours (same level and size, from the fetch
    cache only, no downloads) that border the open water, or None"""
    import os
    from .common import RAW
    cols = []
    for R in (0, 1, 2, 3):
        for dy in range(-R, R + 1):
            for dx in range(-R, R + 1):
                if max(abs(dx), abs(dy)) != R:
                    continue
                w, s_, e, n = bbox_ll(L, tx + dx, ty + dy)
                key = f'{w:.7f}_{s_:.7f}_{e:.7f}_{n:.7f}_{px}_rgb'
                p = os.path.join(RAW, 'naip_aar0', 'rgb', str(px), key.replace('-', 'm') + '.jpg')
                if not os.path.exists(p):
                    continue
                im = Image.open(p); im.draft('RGB', (px // 4, px // 4))
                a = np.asarray(im.convert('RGB')).astype(np.float32)
                nd = nodata_mask(a.astype(np.uint8))
                if nd.any() and not nd.all():
                    c = _ring_colour(a, nd)
                    if c is not None:
                        cols.append(c)
        if len(cols) >= 3 or (cols and R >= 2):          # (the same neighbourhood for adjacent tiles: matching fills)
            return np.median(np.stack(cols), axis=0).astype(np.float32)
    return np.median(np.stack(cols), axis=0).astype(np.float32) if cols else None


def fill_nodata(rgb, nd, ref=None):
    """rgb float raw DN; nd bool. NAIP has no data over open water: filled with the colour of the real water around
    it (the median of the valid pixels in a ring along the no-data edge, which is open water), so a bay's fill matches
    its photographed water instead of standing out as a flat rectangle; WATER_RAW where there is no ring. Feathered
    into the valid pixels over ~12 px."""
    if not nd.any():
        return rgb
    out = rgb.copy()
    if ref is None:
        ref = WATER_RAW
    out[nd] = ref
    # feather: blend valid pixels near the no-data edge toward the water colour a little (hides JPEG fringes)
    dist = cv2.distanceTransform((~nd).astype(np.uint8), cv2.DIST_L2, 3)
    f = np.clip(1.0 - dist / 12.0, 0.0, 1.0)[..., None] * (~nd)[..., None]
    out = out * (1 - f * 0.6) + ref * (f * 0.6)
    return out


# ------------------------------------------------------------------ hi-res sources
def hires_px(L, tx, ty):
    if L == 7:
        return 2048 if any(exists(*c) for c in children(7, tx, ty)) else 1024
    return 1024


def load_hires(L, tx, ty):
    """(balanced float32 HxWx3 0..1 at 1024 px, nir uint8 at 1024 (L7) / 512 (L5, L6), nodata bool at 1024).
    For L7 with L8 children the RGB comes from the 2048 fetch (also returned as 'full' for the L8 split)."""
    px = hires_px(L, tx, ty)
    bb = bbox_ll(L, tx, ty)
    rgb = _dec_rgb(fetch.naip(bb, px, 'rgb')).astype(np.float32)
    if rgb.shape[0] != px:
        rgb = cv2.resize(rgb, (px, px), interpolation=cv2.INTER_AREA)
    nd = nodata_mask(rgb.astype(np.uint8))
    rgb = fill_nodata(rgb, nd, WATER_BAY if FILL_LOCAL else None)
    full = balance(rgb)
    nir_px = 1024 if L == 7 else 512
    nir = _dec_gray(fetch.naip(bb, nir_px, 'nir'))
    if nir.shape[0] != nir_px:
        nir = cv2.resize(nir, (nir_px, nir_px), interpolation=cv2.INTER_AREA)
    if px == 2048:
        f1024 = cv2.resize(full, (1024, 1024), interpolation=cv2.INTER_AREA)
        nd1024 = cv2.resize(nd.astype(np.uint8), (1024, 1024), interpolation=cv2.INTER_NEAREST).astype(bool)
    else:
        f1024 = full; nd1024 = nd
    return dict(full=full, rgb=f1024, nir=nir, nodata=nd1024, px=px)


def _save_jpg(p, x01):
    im = Image.fromarray(to_u8(x01))
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=JPEG_Q, optimize=True, subsampling=2)
    write_atomic(p, buf.getvalue())


def _down(x, n=IMG):
    """High-quality downsample float image to n x n (Lanczos via PIL on 16-bit per channel)."""
    if x.shape[0] == n:
        return x
    u = np.clip(x * 65535.0, 0, 65535).astype(np.uint16)
    chans = []
    for c in range(3):
        im = Image.fromarray(u[..., c], mode='I;16')
        im = im.convert('F').resize((n, n), Image.LANCZOS)
        chans.append(np.asarray(im, np.float32) / 65535.0)
    return np.clip(np.stack(chans, -1), 0.0, 1.0)


def load_tile(L, tx, ty):
    p = path('img', L, tx, ty, 'jpg')
    if not os.path.exists(p):
        return None
    return np.asarray(Image.open(p).convert('RGB')).astype(np.float32) / 255.0


# ------------------------------------------------------------------ bake
def bake_L7(tx, ty, force=False, add_only=True):
    """Bake img/7 and its img/8 children from one hi-res fetch. add_only: never rewrite a file that exists (an old L7
    tile that gains L8 children keeps its own image, and old L8 children, already super-resolved to 1024 px, stay)."""
    p7 = path('img', 7, tx, ty, 'jpg')
    kids = [c for c in children(7, tx, ty) if exists(*c)]
    todo = force or not os.path.exists(p7) or any(not os.path.exists(path('img', *c, 'jpg')) for c in kids)
    if not todo:
        return 'skip'
    keep = (lambda p: add_only and not force and os.path.exists(p))
    d = load_hires(7, tx, ty)
    if kids:
        f = d['full'] if d['px'] == 2048 else d['rgb']
        f1024 = _down(f, 1024) if f.shape[0] != 1024 else f
        for (cl, cx, cy) in kids:
            pk = path('img', cl, cx, cy, 'jpg')
            if keep(pk):
                continue
            dx = cx - tx * 2; dy = cy - ty * 2
            crop = f1024[dy * 512:(dy + 1) * 512, dx * 512:(dx + 1) * 512]
            _save_jpg(pk, crop)
    if not keep(p7):
        _save_jpg(p7, _down(d['rgb'], IMG))
    return 'ok'


def bake_direct(L, tx, ty, force=False):
    p = path('img', L, tx, ty, 'jpg')
    if os.path.exists(p) and not force:
        return 'skip'
    d = load_hires(L, tx, ty)
    _save_jpg(p, _down(d['rgb'], IMG))
    return 'ok'


def can_mosaic(L, tx, ty):
    return all(os.path.exists(path('img', *c, 'jpg')) for c in children(L, tx, ty))


def bake_mosaic(L, tx, ty, force=False):
    p = path('img', L, tx, ty, 'jpg')
    if os.path.exists(p) and not force:
        return 'skip'
    big = np.zeros((IMG * 2, IMG * 2, 3), np.float32)
    for (cl, cx, cy) in children(L, tx, ty):
        a = load_tile(cl, cx, cy)
        if a is None:
            raise RuntimeError(f'missing child img {cl}/{cx}_{cy}')
        dx = cx - tx * 2; dy = cy - ty * 2
        big[dy * IMG:(dy + 1) * IMG, dx * IMG:(dx + 1) * IMG] = a
    _save_jpg(p, _down(big, IMG))
    return 'ok'


def needs_direct(L, tx, ty):
    """L5/L6: fetch directly unless every child exists (then mosaic)."""
    return not all(exists(*c) for c in children(L, tx, ty))
