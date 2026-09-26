#!/usr/bin/env python3
"""GPU super-resolution of the near-track aerial imagery (Apple GPU via PyTorch MPS; CUDA or CPU also work).

For every L7 tile (800 m) near the railway, take the cached NAIP fetch (2048 px, server-resampled from the
native 0.6 m), restore the native 0.6 m sampling, run Real-ESRGAN (general x4v3, SRVGGNetCompact) on the GPU,
and cut 1024-px L9 tiles (200 m, 0.195 m/px) into data/pub/v2/tiles/img/9/. The same colour balance as the
rest of the pyramid is applied first (tools/tiles/imagery.balance), and every L7 input is padded with real
pixels from its neighbours so there are no seams between tiles. Finally level 9 is added to tiles/index.json.

    python3 tools/sr_tiles.py --test 49 55      # one L7 tile (Palo Alto station) -> /tmp/sr_test_*.png comparisons
    python3 tools/sr_tiles.py                   # the whole corridor (resumable; existing L9 tiles are skipped)
    python3 tools/sr_tiles.py --band 300 --station 600 --q 84

Model weights (BSD-3, xinntao/Real-ESRGAN) are cached in data/raw/models/.
"""
import argparse, io, json, math, os, sys, time, struct, zlib
import numpy as np
import cv2
from PIL import Image
import torch
import torch.nn as nn
import torch.nn.functional as Fnn

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
from tools.tiles import common as C          # noqa: E402
from tools.tiles import imagery as IM         # noqa: E402
from tools.tiles import fetch as FE           # noqa: E402

MODELS = os.path.join(ROOT, 'data', 'raw', 'models')
URL = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth'


# ------------------------------------------------------------------ model (Real-ESRGAN SRVGGNetCompact)
class SRVGGNetCompact(nn.Module):
    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4):
        super().__init__()
        self.upscale = upscale
        body = [nn.Conv2d(num_in_ch, num_feat, 3, 1, 1), nn.PReLU(num_parameters=num_feat)]
        for _ in range(num_conv):
            body += [nn.Conv2d(num_feat, num_feat, 3, 1, 1), nn.PReLU(num_parameters=num_feat)]
        body += [nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1)]
        self.body = nn.ModuleList(body)
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        return out + Fnn.interpolate(x, scale_factor=self.upscale, mode='nearest')


def load_model(device):
    p = os.path.join(MODELS, 'realesr-general-x4v3.pth')
    if not os.path.exists(p):
        os.makedirs(MODELS, exist_ok=True)
        import urllib.request
        urllib.request.urlretrieve(URL, p)
    sd = torch.load(p, map_location='cpu')
    sd = sd.get('params_ema', sd.get('params', sd))
    m = SRVGGNetCompact()
    m.load_state_dict(sd, strict=True)
    m.eval()
    dt = torch.float16 if device.type in ('mps', 'cuda') else torch.float32
    return m.to(device=device, dtype=dt), dt


@torch.no_grad()
def upscale4(model, dtype, device, img01, patch=384, pad=16):
    """img01: HxWx3 float32 0..1 -> (4H)x(4W)x3 float32 0..1, processed in overlapping patches."""
    H, W, _ = img01.shape
    out = np.zeros((H * 4, W * 4, 3), np.float32)
    t = torch.from_numpy(np.ascontiguousarray(img01.transpose(2, 0, 1)))[None]
    for y0 in range(0, H, patch):
        for x0 in range(0, W, patch):
            y1, x1 = min(H, y0 + patch), min(W, x0 + patch)
            ya, xa = max(0, y0 - pad), max(0, x0 - pad)
            yb, xb = min(H, y1 + pad), min(W, x1 + pad)
            tin = t[:, :, ya:yb, xa:xb].to(device=device, dtype=dtype)
            r = model(tin).float().clamp_(0, 1).cpu().numpy()[0].transpose(1, 2, 0)
            oy, ox = (y0 - ya) * 4, (x0 - xa) * 4
            out[y0 * 4:y1 * 4, x0 * 4:x1 * 4] = r[oy:oy + (y1 - y0) * 4, ox:ox + (x1 - x0) * 4]
    return out


# ------------------------------------------------------------------ inputs
def raw2048(tx, ty, allow_fetch):
    """Balanced 0..1 float image (2048 px over the L7 tile) from the NAIP cache (or None)."""
    bb = C.bbox_ll(7, tx, ty)
    w, s, e, n = bb
    key = f'{w:.7f}_{s:.7f}_{e:.7f}_{n:.7f}_2048_rgb'
    dest = os.path.join(C.RAW, 'naip_aar0', 'rgb', '2048', key.replace('-', 'm') + '.jpg')
    if not os.path.exists(dest) and not allow_fetch:
        return None
    b = open(dest, 'rb').read() if os.path.exists(dest) else FE.naip(bb, 2048, 'rgb')
    rgb = np.asarray(Image.open(io.BytesIO(b)).convert('RGB')).astype(np.float32)
    if rgb.shape[0] != 2048:
        rgb = cv2.resize(rgb, (2048, 2048), interpolation=cv2.INTER_AREA)
    nd = IM.nodata_mask(rgb.astype(np.uint8))
    rgb = IM.fill_nodata(rgb, nd)
    return IM.balance(rgb)


def padded_input(tx, ty, M, cache):
    """2048+2M canvas: the tile plus M px of real neighbour pixels (reflect where a neighbour is missing)."""
    def get(x, y):
        k = (x, y)
        if k not in cache:
            cache[k] = raw2048(x, y, allow_fetch=False)
        return cache[k]
    core = get(tx, ty)
    if core is None:
        core = raw2048(tx, ty, allow_fetch=True); cache[(tx, ty)] = core
    N = 2048
    can = cv2.copyMakeBorder(core, M, M, M, M, cv2.BORDER_REFLECT_101)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            nb = get(tx + dx, ty + dy)
            if nb is None:
                continue
            ys = slice(0, M) if dy < 0 else slice(M, M + N) if dy == 0 else slice(M + N, N + 2 * M)
            xs = slice(0, M) if dx < 0 else slice(M, M + N) if dx == 0 else slice(M + N, N + 2 * M)
            sy = slice(N - M, N) if dy < 0 else slice(0, N) if dy == 0 else slice(0, M)
            sx = slice(N - M, N) if dx < 0 else slice(0, N) if dx == 0 else slice(0, M)
            can[ys, xs] = nb[sy, sx]
    return can


def track_points():
    b = zlib.decompress(open(os.path.join(ROOT, 'data', 'baked', 'track.bin'), 'rb').read())
    n, step = struct.unpack('<If', b[4:12]); p = 12
    X = np.frombuffer(b, '<f4', n, p); p += 4 * n
    Z = np.frombuffer(b, '<f4', n, p)
    stations = json.load(open(os.path.join(ROOT, 'data', 'baked', 'track.json')))['stations']
    idx = [int(s['s'] / step) for s in stations]
    return np.stack([X, Z], 1).astype(np.float64), np.stack([X[idx], Z[idx]], 1).astype(np.float64)


# areas of interest that also get L9 (lat_s, lon_w, lat_n, lon_e): San Francisco's northeast quarter (downtown, SoMa,
# the Embarcadero, North Beach, the Wharf, the Marina, Crissy Field) and the landmark campuses, where people fly low
AOI9 = [
    (37.7650, -122.4760, 37.8120, -122.3850),
    (37.4230, -122.1770, 37.4340, -122.1590),     # Stanford Main Quad, Oval, Hoover Tower
    (37.3270, -121.8960, 37.3420, -121.8790),     # downtown San Jose
    (37.3920, -121.9790, 37.4070, -121.9650),     # Levi's Stadium, Great America
    (37.3300, -122.0160, 37.3400, -122.0030),     # Apple Park
    (37.4170, -122.0890, 37.4300, -122.0610),     # Googleplex, Shoreline, Bay View
]


def aoi_L9():
    out = set(); T9 = C.T(9); n = 1 << 9
    for (la0, lo0, la1, lo1) in AOI9:
        xa, za = C.ll2w(la1, lo0); xb, zb = C.ll2w(la0, lo1)
        for ty in range(int((za - C.Z0) // T9), int((zb - C.Z0) // T9) + 1):
            for tx in range(int((xa - C.X0) // T9), int((xb - C.X0) // T9) + 1):
                if 0 <= tx < n and 0 <= ty < n and C.exists(7, tx >> 2, ty >> 2):
                    out.add((tx, ty))
    return out


def wanted_L9(band, station_r):
    """Set of (tx, ty) L9 tiles whose centre is within `band` m of the track or `station_r` m of a station, plus AOI9."""
    from scipy.spatial import cKDTree
    P, S = track_points()
    tree, stree = cKDTree(P), cKDTree(S)
    T9 = C.T(9); n = 1 << 9
    xs = C.X0 + (np.arange(n) + 0.5) * T9
    out = set()
    x0, x1 = P[:, 0].min() - band - T9, P[:, 0].max() + band + T9
    z0, z1 = P[:, 1].min() - band - T9, P[:, 1].max() + band + T9
    txs = [i for i in range(n) if x0 <= xs[i] <= x1]
    tys = [j for j in range(n) if z0 <= xs[j] - C.X0 + C.Z0 <= z1]
    zs = C.Z0 + (np.arange(n) + 0.5) * T9
    tys = [j for j in range(n) if z0 <= zs[j] <= z1]
    grid = np.array([(xs[i], zs[j]) for j in tys for i in txs])
    d, _ = tree.query(grid); ds, _ = stree.query(grid)
    k = 0
    for j in tys:
        for i in txs:
            if d[k] < band or ds[k] < station_r:
                out.add((i, j))
            k += 1
    return out


def wanted_L9_bart(band, station_r):
    """The Bayline Metro (BART) L9 band: tiles whose centre is within `band` m of a BART track or `station_r` m of a
    BART station (the Peninsula's rule), over the square and the north strip, where the L7 parent exists."""
    from scipy.spatial import cKDTree
    from tools.tiles import metro
    P = metro.points(); S = np.array([(x, z) for (_, _, x, z) in metro.stations()])
    tree, stree = cKDTree(P), cKDTree(S)
    T9 = C.T(9); n = 1 << 9
    rows = np.arange(-C.north_rows(9), n)
    xs = C.X0 + (np.arange(n) + 0.5) * T9; zs = C.Z0 + (rows + 0.5) * T9
    gx, gz = np.meshgrid(xs, zs); g = np.stack([gx.ravel(), gz.ravel()], 1)
    d, _ = tree.query(g, distance_upper_bound=band); ds, _ = stree.query(g, distance_upper_bound=station_r)
    ok = (d < band) | (ds < station_r)
    ix = np.tile(np.arange(n), len(rows))[ok]; iy = np.repeat(rows, n)[ok]
    return {(int(x), int(y)) for x, y in zip(ix, iy) if C.exists(7, int(x) >> 2, int(y) >> 2)}


# ------------------------------------------------------------------ bake
def bake_L7(model, dtype, device, tx, ty, want, q, cache, force=False):
    kids = [(tx * 4 + i, ty * 4 + j) for j in range(4) for i in range(4)]
    todo = [k for k in kids if k in want and (force or not os.path.exists(C.path('img', 9, k[0], k[1], 'jpg')))]
    if not todo:
        return 0
    M = 96                                            # margin at 2048-scale (≈37 m of real neighbour pixels)
    can = padded_input(tx, ty, M, cache)
    Nd = 1333                                          # 800 m at the native 0.6 m
    md = int(round(M * Nd / 2048))
    small = cv2.resize(can, (Nd + 2 * md, Nd + 2 * md), interpolation=cv2.INTER_AREA)
    big = upscale4(model, dtype, device, small)
    core = big[4 * md:4 * md + 4 * Nd, 4 * md:4 * md + 4 * Nd]
    full = cv2.resize(core, (4096, 4096), interpolation=cv2.INTER_AREA)   # 0.195 m/px
    for (ix, iy) in todo:
        i, j = ix - tx * 4, iy - ty * 4
        tile = full[j * 1024:(j + 1) * 1024, i * 1024:(i + 1) * 1024]
        im = Image.fromarray(np.clip(tile * 255 + 0.5, 0, 255).astype(np.uint8))
        buf = io.BytesIO(); im.save(buf, 'JPEG', quality=q, optimize=True, subsampling=2)
        C.write_atomic(C.path('img', 9, ix, iy, 'jpg'), buf.getvalue())
    return len(todo)


def update_index():
    p = os.path.join(C.PUB, 'index.json'); idx = json.load(open(p))
    d = os.path.join(C.PUB, 'img', '9')
    allt = sorted([list(map(int, f[:-4].split('_'))) for f in os.listdir(d) if f.endswith('.jpg') and '_test' not in f], key=lambda c: (c[1], c[0])) if os.path.isdir(d) else []
    lst = [t for t in allt if t[1] >= 0]; nl = [t for t in allt if t[1] < 0]
    old = {tuple(t) for t in idx.get('levels', {}).get('9', [])}
    assert old <= {tuple(t) for t in lst}, 'an L9 tile listed before is missing'
    idx.setdefault('levels', {})['9'] = lst
    if nl and idx.get('north'):
        idx['north'].setdefault('levels', {})['9'] = nl                  # the north strip: new clients only
    if 'products' in idx and 'img' in idx['products']:
        idx['products']['img']['levels'] = [0, 9]
        idx['products']['img']['size9'] = 1024
        idx['products']['img']['sr'] = 'L9: Real-ESRGAN general-x4v3 super-resolution of NAIP 0.6 m (GPU), 0.195 m/px, near the track'
    pres = idx.get('present')
    if isinstance(pres, dict) and 'img' in pres:
        pres['img']['9'] = len(lst)
    tmp = p + '.tmp'; json.dump(idx, open(tmp, 'w'), separators=(',', ':')); os.replace(tmp, p)
    return len(lst)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--test', nargs=2, type=int)
    ap.add_argument('--band', type=float, default=300)
    ap.add_argument('--station', type=float, default=650)
    ap.add_argument('--q', type=int, default=84)
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    device = torch.device('mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu')
    model, dtype = load_model(device)
    print(f'device {device} dtype {dtype}', flush=True)
    cache = {}
    if a.test:
        tx, ty = a.test
        can = padded_input(tx, ty, 96, cache)
        small = cv2.resize(can, (1333 + 124, 1333 + 124), interpolation=cv2.INTER_AREA)
        t0 = time.time(); big = upscale4(model, dtype, device, small); dt = time.time() - t0
        core = big[248:248 + 5332, 248:248 + 5332]; full = cv2.resize(core, (4096, 4096), interpolation=cv2.INTER_AREA)
        bic = cv2.resize(small[62:62 + 1333, 62:62 + 1333], (4096, 4096), interpolation=cv2.INTER_CUBIC)
        c = (slice(1500, 2012), slice(1500, 2012))
        side = np.concatenate([np.clip(bic[c], 0, 1), full[c]], 1)
        Image.fromarray((side * 255).astype(np.uint8)).save('/tmp/sr_test_side.png')
        print(f'SR {small.shape[0]}² -> {big.shape[0]}² in {dt:.2f}s; comparison /tmp/sr_test_side.png (left bicubic, right SR)')
        return
    want = wanted_L9(a.band, a.station) | aoi_L9()
    if C.north_enabled():                                                   # (Bayline Metro coverage stages)
        want |= wanted_L9_bart(a.band, a.station)
    L7s = sorted({(x >> 2, y >> 2) for (x, y) in want})
    print(f'{len(want)} L9 tiles wanted in {len(L7s)} L7 tiles', flush=True)
    t0 = time.time(); done = 0; made = 0
    for n, (tx, ty) in enumerate(L7s):
        try:
            made += bake_L7(model, dtype, device, tx, ty, want, a.q, cache, a.force)
        except Exception as e:
            print(f'L7 {tx}_{ty} failed: {e}', flush=True)
        done += 1
        if len(cache) > 40:            # keep memory bounded (neighbour cache)
            for k in list(cache.keys())[:len(cache) - 20]:
                del cache[k]
        if n % 10 == 0 or n == len(L7s) - 1:
            el = time.time() - t0; eta = el / done * (len(L7s) - done)
            print(f'{done}/{len(L7s)} L7 tiles, {made} L9 written, {el:.0f}s elapsed, ~{eta:.0f}s left', flush=True)
    print('index L9 tiles:', update_index(), flush=True)


if __name__ == '__main__':
    main()
