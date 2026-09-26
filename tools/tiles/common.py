"""Shared constants and helpers for the Bayline v2 tile bake (see SPEC_v2.md, notes/tiles.md).

World square: X0=-45056, Z0=-49152, SIZE=102400 m; level L tile size T=SIZE/2**L; tile (L,tx,ty) covers
X in [X0+tx*T, X0+(tx+1)*T), Z in [Z0+ty*T, Z0+(ty+1)*T); ty grows south (+Z).
Local projection is linear in lon/lat, so every tile is an exact lon/lat rectangle.
"""
import json, math, os, re, struct, zlib
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
ROOT = os.path.dirname(TOOLS)
RAW = os.path.join(ROOT, 'data', 'raw')
PUB = os.path.join(ROOT, 'data', 'pub', 'v2', 'tiles')
WORK = os.path.join(RAW, 'tiles')          # intermediate products (full-res crops, NIR, per-tile caches)

X0, Z0, SIZE = -45056.0, -49152.0, 102400.0
LAT0, LON0, MLAT, MLON = 37.40, -122.10, 110985.1, 88542.2
MAXL_IMG, MAXL_H, MAXL_M = 8, 7, 7
HN = 129            # height samples per tile side
MN = 128            # mask cells per tile side
IMG = 512           # imagery pixels per tile side


def T(L):
    return SIZE / (1 << L)


def bounds(L, tx, ty):
    t = T(L)
    x0 = X0 + tx * t
    z0 = Z0 + ty * t
    return x0, z0, x0 + t, z0 + t


def w2ll(x, z):
    return LAT0 - np.asarray(z, np.float64) / MLAT, LON0 + np.asarray(x, np.float64) / MLON


def ll2w(lat, lon):
    return (np.asarray(lon, np.float64) - LON0) * MLON, -(np.asarray(lat, np.float64) - LAT0) * MLAT


def bbox_ll(L, tx, ty):
    """(lon_w, lat_s, lon_e, lat_n) of the tile."""
    x0, z0, x1, z1 = bounds(L, tx, ty)
    return LON0 + x0 / MLON, LAT0 - z1 / MLAT, LON0 + x1 / MLON, LAT0 - z0 / MLAT


def tile_of(L, x, z):
    t = T(L)
    return int(math.floor((x - X0) / t)), int(math.floor((z - Z0) / t))


def children(L, tx, ty):
    return [(L + 1, tx * 2 + dx, ty * 2 + dy) for dy in (0, 1) for dx in (0, 1)]


def parent(L, tx, ty):
    return (L - 1, tx >> 1, ty >> 1)


def path(product, L, tx, ty, ext):
    return os.path.join(PUB, product, str(L), f'{tx}_{ty}.{ext}')


def ensure_dir(p):
    os.makedirs(os.path.dirname(p), exist_ok=True)


def jpeg_block_err(a, b, G=16):
    """(max over GxG pixel blocks of the per-channel mean |a - b|, the number of blocks that decode pure green (green
    >= 80 above red and blue on >= 90 % of the pixels) where the source has < 50 % such pixels: how a missing MCU decodes)"""
    h, w = (a.shape[0] // G) * G, (a.shape[1] // G) * G
    a, b = a[:h, :w], b[:h, :w]
    d = np.abs(a.astype(np.int16) - b.astype(np.int16)).reshape(h // G, G, w // G, G, 3).mean((1, 3))
    def green(x):
        x = x.astype(np.int16)
        return ((x[..., 1] - np.maximum(x[..., 0], x[..., 2])) >= 80).reshape(h // G, G, w // G, G).mean((1, 3))
    ga, gb = green(a), green(b)
    return float(d.max()), int(((ga >= 0.9) & (gb < 0.5)).sum())


def jpeg_truncated(a, G=16):
    """does a decoded JPEG (HxWx3 uint8) show the signature of a truncated scan: its last MCU (bottom-right G x G block,
    the last one in scan order, always among the missing ones) decoded pure green (green >= 80 above red and blue)"""
    b = a[-G:, -G:].astype(np.int16)
    return bool(((b[..., 1] - np.maximum(b[..., 0], b[..., 2])) >= 80).mean() >= 0.9)


def jpeg_bytes(u8, q, subsampling=2, tries=6):
    """Checked JPEG encode of an HxWx3 uint8 array. Pillow 10.1 / libjpeg-turbo 3.0.0 sometimes (deterministically, for
    some inputs, optimize=True or not) writes a scan that ends early: the file still ends with EOI, macOS ImageIO shows it
    fine, but libjpeg-turbo decoders (Chrome) draw the missing last MCU(s) as pure green 16 px squares. The bytes are
    decoded and compared blockwise with the source; a gross block error re-encodes at the next lower quality."""
    import io
    from PIL import Image
    im = Image.fromarray(u8)
    for k in range(tries):
        buf = io.BytesIO(); im.save(buf, 'JPEG', quality=q - k, optimize=True, subsampling=subsampling); b = buf.getvalue()
        dec = np.asarray(Image.open(io.BytesIO(b)).convert('RGB'))
        if dec.shape == u8.shape:
            err, green = jpeg_block_err(dec, u8)
            if err < 50 and not green:
                return b
    raise RuntimeError(f'JPEG encode check failed {u8.shape} q={q}')


def write_atomic(p, data):
    ensure_dir(p)
    tmp = p + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, p)


# ------------------------------------------------------------------ track
def _find(*cands):
    for c in cands:
        if os.path.exists(c):
            return c
    raise FileNotFoundError(cands[0])


_TRACK = None


def track():
    """Track samples from track.bin: dict with X, Z, Y (float64), n, step, tunnels (s ranges), stations, platforms."""
    global _TRACK
    if _TRACK is not None:
        return _TRACK
    tb = _find(os.path.join(ROOT, 'data/baked/track.bin'), os.path.join(ROOT, 'data/pub/v2/core/track.bin'))
    tj = _find(os.path.join(ROOT, 'data/baked/track.json'), os.path.join(ROOT, 'data/pub/v2/core/track.json'))
    b = zlib.decompress(open(tb, 'rb').read())
    magic, n, step = struct.unpack('<4sIf', b[:12])
    assert magic == b'BLK1', magic
    p = 12
    X = np.frombuffer(b, '<f4', n, p).astype(np.float64); p += 4 * n
    Z = np.frombuffer(b, '<f4', n, p).astype(np.float64); p += 4 * n
    Y = np.frombuffer(b, '<f4', n, p).astype(np.float64); p += 4 * n
    feat = json.load(open(tj))
    # tangents / right normals (right of +s, like 20_track.js: rx=-dz, rz=dx)
    dx = np.gradient(X); dz = np.gradient(Z); L = np.hypot(dx, dz) + 1e-9
    dx /= L; dz /= L
    ntun = np.zeros(n, bool)
    for a, bb in feat['tunnels']:
        ntun[max(0, int(a / step) - 2):min(n, int(bb / step) + 3)] = True
    _TRACK = dict(X=X, Z=Z, Y=Y, n=n, step=float(step), rx=-dz, rz=dx, tunnel=ntun, feat=feat)
    return _TRACK


# ------------------------------------------------------------------ landmarks (parsed from the landmarks module)
_LM = None


def landmarks():
    """[(name, lat, lon, radius, [extra (lat,lon) points along bridges])]"""
    global _LM
    if _LM is not None:
        return _LM
    src = open(os.path.join(ROOT, 'src/js/50_landmarks.js'), encoding='utf-8').read()
    out = []
    for m in re.finditer(r"def\('((?:[^'\\]|\\.)+)',\s*([-0-9.]+),\s*([-0-9.]+),\s*([0-9.]+)", src):
        out.append([m.group(1).replace("\\'", "'"), float(m.group(2)), float(m.group(3)), float(m.group(4)), []])
    # bridge polylines (sampled) extend a landmark's footprint
    arrays = {}
    for m in re.finditer(r"const\s+(BB_EB|BB_WB|SMB|DUMB)\s*=\s*(\[\[.*?\]\]);", src, re.S):
        try:
            arrays[m.group(1)] = json.loads(m.group(2))
        except Exception:
            pass
    m = re.search(r"const BBW = \{(.*?)\};", src, re.S)
    if m:
        pts = [[float(a), float(b)] for a, b in re.findall(r"\[([-0-9.]+),\s*([-0-9.]+)\]", m.group(1))]
        arrays['BBW'] = pts
    extra = {'Bay Bridge (West Span)': arrays.get('BBW', []), 'Bay Bridge (East Span)': arrays.get('BB_EB', []) + arrays.get('BB_WB', []),
             'San Mateo-Hayward Bridge': arrays.get('SMB', []), 'Dumbarton Bridge': arrays.get('DUMB', []),
             'Golden Gate Bridge': [[37.8255026, -122.4792332], [37.8140144, -122.477891]]}
    for L in out:
        pts = extra.get(L[0], [])
        if len(pts) > 200:
            pts = pts[::max(1, len(pts) // 200)]
        L[4] = pts
    _LM = out
    return out


# ------------------------------------------------------------------ coverage
def _rect_dist(x0, z0, x1, z1, px, pz):
    dx = np.maximum(np.maximum(x0 - px, 0), px - x1)
    dz = np.maximum(np.maximum(z0 - pz, 0), pz - z1)
    return np.hypot(dx, dz)


def _level_tiles_near(L, cand, pts, r):
    """Subset of candidate tiles (list of (tx,ty)) within r metres of any point in pts (N,2)."""
    if not len(cand) or not len(pts):
        return set()
    t = T(L)
    cand = np.asarray(cand)
    x0 = X0 + cand[:, 0] * t; z0 = Z0 + cand[:, 1] * t
    keep = np.zeros(len(cand), bool)
    # chunk over points to bound memory
    for i in range(0, len(pts), 512):
        p = pts[i:i + 512]
        d = _rect_dist(x0[:, None], z0[:, None], x0[:, None] + t, z0[:, None] + t, p[None, :, 0], p[None, :, 1])
        keep |= (d <= r).any(1)
    return set(map(tuple, cand[keep].tolist()))


# areas of interest beyond the corridor bands: (lat_s, lon_w, lat_n, lon_e, finest level). All of San Francisco gets
# the 0.39 m/px L8 imagery (flyovers of the Presidio, Golden Gate Park, the Sunset and the waterfront), the Golden Gate
# and the south face of the Marin Headlands get L7, the East Bay shore and Treasure Island L8.
AOI = [
    (37.7030, -122.5160, 37.8125, -122.3550, 8),     # San Francisco
    (37.8050, -122.5400, 37.8429, -122.4600, 7),     # Golden Gate, Marin Headlands (world edge at 37.8429)
    (37.7600, -122.3350, 37.8429, -122.2150, 8),     # Oakland, Emeryville, Alameda: the far shore seen from SF and the bridge
    (37.8050, -122.3800, 37.8350, -122.3550, 8),     # Treasure Island and Yerba Buena
]


def _aoi_tiles(L, lvl_min):
    out = set()
    t = T(L)
    for (la0, lo0, la1, lo1, lv) in AOI:
        if lv < lvl_min:
            continue
        xa, za = ll2w(la1, lo0); xb, zb = ll2w(la0, lo1)
        for ty in range(int((za - Z0) // t), int((zb - Z0) // t) + 1):
            for tx in range(int((xa - X0) // t), int((xb - X0) // t) + 1):
                if 0 <= tx < (1 << L) and 0 <= ty < (1 << L):
                    out.add((tx, ty))
    return out


# ------------------------------------------------------------------ Bayline Metro: BART corridors and the north strip
# The world square ends at lat 37.8429; BART runs to 38.019 (Pittsburg / Bay Point). The grid is extended north with
# NEGATIVE tile rows (same formulas: z0 = Z0 + ty * T): the "north strip" is Z in [Z0 - 25600, Z0), i.e. rows
# ty = -1 .. -(2^L / 4) at every level L >= 2 (lat 37.8429 .. 38.0736, the full width of the square). L2-L5 are complete
# over the strip; L0/L1 have no strip tiles. Indexes list strip tiles under a separate `north` key (old clients ignore it).
NORTH_M = SIZE / 4.0                         # 25600 m
NORTH_Z0 = Z0 - NORTH_M                      # -74752
NORTH_COMPLETE = (2, 5)
# coverage stages (BAYLINE_STAGE when coverage.json is (re)computed): '' = the Peninsula-era coverage only,
# 'bart1' = + every BART corridor + the strip's L2-L5 roots, 'bart2' = + the whole strip at L6 and L7
BART_R6, BART_R7, BART_R8 = 8000.0, 3000.0, 1200.0


def north_rows(L):
    return (1 << L) >> 2 if L >= 2 else 0


def in_north(L, tx, ty):
    return L >= 2 and 0 <= tx < (1 << L) and -north_rows(L) <= ty < 0


def in_square(L, tx, ty):
    n = 1 << L
    return 0 <= tx < n and 0 <= ty < n


def north_tiles(L):
    n = 1 << L
    return [(x, y) for y in range(-north_rows(L), 0) for x in range(n)]


def _cand_near(L, pts, r, rows):
    """Tiles at level L (rows = iterable of ty) within r m of any point in pts (N,2): KD prefilter + exact rect distance."""
    from scipy.spatial import cKDTree
    t = T(L); n = 1 << L
    xs = X0 + (np.arange(n) + 0.5) * t
    rows = list(rows)
    zs = Z0 + (np.asarray(rows, np.float64) + 0.5) * t
    gx, gz = np.meshgrid(xs, zs)
    cen = np.stack([gx.ravel(), gz.ravel()], 1)
    kd = cKDTree(pts)
    d, _ = kd.query(cen, distance_upper_bound=r + t * 0.7072 + 1.0)
    ok = np.isfinite(d)
    ix = np.arange(n)[None, :].repeat(len(rows), 0).ravel()[ok]
    iy = np.asarray(rows)[:, None].repeat(n, 1).ravel()[ok]
    return _level_tiles_near(L, list(zip(ix.tolist(), iy.tolist())), pts, r)


def _coverage_bart(stage):
    """BART corridor tiles (square + strip) for the given stage: {6: set, 7: set, 8: set}."""
    from . import metro
    pts = metro.points()
    out = {}
    for L, r in ((6, BART_R6), (7, BART_R7), (8, BART_R8)):
        rows = range(-north_rows(L), 1 << L)
        out[L] = _cand_near(L, pts, r, rows)
    if stage in ('bart2', 'bart3'):
        out[6] |= set(north_tiles(6))
        out[7] |= set(north_tiles(7))
    if stage == 'bart3':             # the East Bay hills between the lines, inside the old square (Diablo foothills)
        T7 = T(7)
        for (la0, lo0, la1, lo1) in EAST_BAY_HILLS:
            xa, za = ll2w(la1, lo0); xb, zb = ll2w(la0, lo1)
            for ty in range(int((za - Z0) // T7), int((zb - Z0) // T7) + 1):
                for tx in range(int((xa - X0) // T7), int((xb - X0) // T7) + 1):
                    out[7].add((tx, ty)); out[6].add((tx >> 1, ty >> 1))
    return out


# stage 3: L7 over the hills between the BART lines inside the old square (Moraga, Canyon, Las Trampas, Danville, San
# Ramon, the Castro Valley and Sunol hills): the Diablo foothills seen from the Concord, Dublin and Fremont lines
EAST_BAY_HILLS = [(37.55, -122.25, 37.8429, -121.78)]


def compute_coverage():
    """Coverage for BAYLINE_STAGE (see above): {6: [...], 7: [...], 8: [...], 'north': [2, 5] or None}."""
    stage = os.environ.get('BAYLINE_STAGE', '')
    cov = _compute_coverage_peninsula()
    if not stage:
        cov['north'] = None
        return cov
    b = _coverage_bart(stage)
    L6 = set(cov[6]) | b[6]; L7 = set(cov[7]) | b[7]; L8 = set(cov[8]) | b[8]
    # monotonic: a recompute (next stage, or a new corridor source) never drops what an earlier stage listed
    for f in ('coverage_bart1.json', 'coverage_bart2.json', 'coverage_bart3.json'):
        pf = os.path.join(WORK, f)
        if os.path.exists(pf):
            j = json.load(open(pf))
            L6 |= {tuple(c) for c in j.get('6', [])}; L7 |= {tuple(c) for c in j.get('7', [])}; L8 |= {tuple(c) for c in j.get('8', [])}
    for (x, y) in L8:
        L7.add((x >> 1, y >> 1))
    for (x, y) in L7:
        L6.add((x >> 1, y >> 1))
    key = lambda c: (c[1], c[0])
    return {6: sorted(L6, key=key), 7: sorted(L7, key=key), 8: sorted(L8, key=key), 'north': list(NORTH_COMPLETE)}


def _compute_coverage_peninsula():
    """Sets of (tx,ty) for L6, L7, L8 per SPEC_v2 (with ancestor closure), plus the AOI list."""
    tr = track()
    pts = np.stack([tr['X'][::10], tr['Z'][::10]], 1)       # every 50 m
    lms = landmarks()
    lm_pts = np.array([ll2w(la, lo) for _, la, lo, _, _ in lms])
    br_pts = []
    for _, _, _, _, extra in lms:
        for la, lo in extra:
            br_pts.append(ll2w(la, lo))
    br_pts = np.array(br_pts) if br_pts else np.zeros((0, 2))
    n6 = 1 << 6
    all6 = [(x, y) for y in range(n6) for x in range(n6)]
    L6 = _level_tiles_near(6, all6, pts, 10000.0)
    # L7 candidates: children of L6-within-(10km+) plus near landmarks anywhere
    n7 = 1 << 7
    all7 = [(x, y) for y in range(n7) for x in range(n7)]
    L7 = _level_tiles_near(7, [c for c in all7 if (c[0] >> 1, c[1] >> 1) in L6], pts, 3000.0)
    L7 |= _level_tiles_near(7, all7, lm_pts, 1500.0)
    if len(br_pts):
        L7 |= _level_tiles_near(7, all7, br_pts, 700.0)
    n8 = 1 << 8
    cand8 = [(x * 2 + dx, y * 2 + dy) for (x, y) in L7 for dy in (0, 1) for dx in (0, 1)]
    L7 |= _aoi_tiles(7, 7)
    cand8 = [(x * 2 + dx, y * 2 + dy) for (x, y) in L7 for dy in (0, 1) for dx in (0, 1)]
    L8 = _level_tiles_near(8, cand8, pts, 1000.0) | _level_tiles_near(8, cand8, lm_pts, 600.0)
    L8 |= _aoi_tiles(8, 8)
    # closure: every tile's ancestors exist
    for (x, y) in L8:
        L7.add((x >> 1, y >> 1))
    for (x, y) in L7:
        L6.add((x >> 1, y >> 1))
    return {6: sorted(L6, key=lambda c: (c[1], c[0])), 7: sorted(L7, key=lambda c: (c[1], c[0])), 8: sorted(L8, key=lambda c: (c[1], c[0]))}


_COV = None


def coverage():
    global _COV
    if _COV is not None:
        return _COV
    cp = os.path.join(WORK, 'coverage.json')
    if os.path.exists(cp):
        j = json.load(open(cp))
        _COV = {int(k): [tuple(c) for c in v] for k, v in j.items() if k.isdigit()}
        _COV['north'] = j.get('north')
        return _COV
    cov = compute_coverage()
    os.makedirs(WORK, exist_ok=True)
    json.dump({str(k): ([list(c) for c in v] if isinstance(k, int) else v) for k, v in cov.items()}, open(cp, 'w'))
    _COV = cov
    return cov


def north_enabled():
    return bool(coverage().get('north'))


def level_tiles(L):
    """All tiles that exist at level L (L0-L5 complete over the square, L2-L5 over the north strip when enabled)."""
    if L <= 5:
        n = 1 << L
        sq = [(x, y) for y in range(n) for x in range(n)]
        return (north_tiles(L) + sq) if (L >= 2 and north_enabled()) else sq
    return coverage()[L]


def exists(L, tx, ty):
    if L < 0:
        return False
    if L <= 5:
        n = 1 << L
        return (0 <= tx < n and 0 <= ty < n) or (north_enabled() and in_north(L, tx, ty))
    s = _cov_sets().get(L)
    return s is not None and (tx, ty) in s


_COVS = None


def _cov_sets():
    global _COVS
    if _COVS is None:
        _COVS = {L: set(v) for L, v in coverage().items() if isinstance(L, int)}
    return _COVS


# ------------------------------------------------------------------ regions (for early test bakes)
REGIONS = {
    # Palo Alto station L7 block: tx 48-50, ty 54-56 (3x3 L7 tiles, 2.4 km square)
    'pa': (7, 48, 54, 50, 56),
    # Coyote Point / Burlingame shore (Bay water, marsh, SFO approach)
    'bay': (7, 30, 34, 32, 36),
    # Redwood City / Bair Island salt ponds and sloughs
    'ponds': (7, 44, 46, 46, 48),
}


def region_filter(name):
    """Return f(L,tx,ty)->bool keeping tiles that overlap the region (and all their ancestors)."""
    if not name:
        return lambda L, tx, ty: True
    L0_, ax, ay, bx, by = REGIONS[name]
    x0, z0, _, _ = bounds(L0_, ax, ay)
    _, _, x1, z1 = bounds(L0_, bx, by)

    def f(L, tx, ty):
        a, b, c, d = bounds(L, tx, ty)
        return a < x1 and c > x0 and b < z1 and d > z0
    return f


def log(*a):
    import sys, time
    print(time.strftime('%H:%M:%S'), *a, flush=True)
