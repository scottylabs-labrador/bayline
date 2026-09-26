"""Shared helpers for the Bayline Metro (BART) data bake. See notes/bart-data.md for the output format.

Frame: the game's Bay frame (01_geo.js): x = (lon + 122.10) * 88542.2 east, z = -(lat - 37.40) * 110985.1 south,
y = metres above sea level (NAVD88, like Terrain.h). Linear in lon/lat, so it matches the tiles and the Globe.
"""
import csv, json, math, os, sys, time, zlib
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
ROOT = os.path.dirname(TOOLS)
RAW = os.path.join(ROOT, 'data', 'raw', 'metro')
# bakes write to the STAGING dir (metro-next); only tools/metro/promote.py writes the live metro/ that the servers publish
# (production reads it: never bake into it directly). METRO_PUB overrides the staging dir.
PUB = os.environ.get('METRO_PUB') or os.path.join(ROOT, 'data', 'pub', 'v2', 'metro-next')
PUB_DIR = os.path.basename(PUB.rstrip('/'))                                            # 'metro' or 'metro-next' (relative to DATA)
GTFS_DIR = os.path.join(RAW, 'gtfs')
OSM_JSON = os.path.join(RAW, 'osm', 'bart_osm.json')

LAT0, LON0, MLAT, MLON = 37.40, -122.10, 110985.1, 88542.2
GAUGE = 1.676                  # BART broad gauge, m (rail centre to rail centre ~ 1.676 + 0.07)
GAUGE_STD = 1.435              # eBART (Stadler GTW 2/6 DMU units) and the airport connector guideway (cable, nominal)
RAIL_CC = 1.676 + 0.0727       # rail centre-to-centre for 1676 mm gauge (gauge is measured at the inner faces)
MPH = 0.44704


def ll2w(lat, lon):
    return (np.asarray(lon, np.float64) - LON0) * MLON, -(np.asarray(lat, np.float64) - LAT0) * MLAT


def w2ll(x, z):
    return LAT0 - np.asarray(z, np.float64) / MLAT, LON0 + np.asarray(x, np.float64) / MLON


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def gtfs(name):
    return list(csv.DictReader(open(os.path.join(GTFS_DIR, name), encoding='utf-8-sig')))


def tsec(t):
    h, m, s = map(int, t.strip().split(':'))
    return h * 3600 + m * 60 + s


def write_json(path, obj, compact=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        if compact:
            json.dump(obj, f, separators=(',', ':'))
        else:
            json.dump(obj, f, indent=1)
    os.replace(tmp, path)
    return os.path.getsize(path)


def write_bin(path, data, compress=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(zlib.compress(data, 9) if compress else data)
    os.replace(tmp, path)
    return os.path.getsize(path)


# ------------------------------------------------------------------ polyline helpers
def cumlen(p):
    d = np.hypot(np.diff(p[:, 0]), np.diff(p[:, 1]))
    return np.concatenate([[0.0], np.cumsum(d)])


def resample(p, step_max=5.0):
    """Uniform resample of a polyline (N,2+) by plan arc length. Returns (pts, step)."""
    s = cumlen(p)
    L = s[-1]
    n = max(2, int(math.ceil(L / step_max)) + 1)
    t = np.linspace(0.0, L, n)
    out = np.stack([np.interp(t, s, p[:, k]) for k in range(p.shape[1])], 1)
    return out, (L / (n - 1) if n > 1 else 0.0)


def smooth_fixed_ends(a, sigma, axis_len=None):
    """Gaussian smoothing of a 1-D array that keeps both end values exactly (reflect the residual)."""
    from scipy import ndimage
    if sigma <= 0 or len(a) < 5:
        return a.copy()
    n = len(a)
    # detrend by the chord so end-preserving reflection is well-behaved
    lin = np.linspace(a[0], a[-1], n)
    r = a - lin
    rr = np.concatenate([-r[1:][::-1], r, -r[:-1][::-1]])      # odd reflection keeps r(0)=r(n-1)=0
    sm = ndimage.gaussian_filter1d(rr, sigma, mode='nearest')[n - 1:2 * n - 1]
    return sm + lin


def curvature(x, z, step, win=3):
    """Signed curvature (1/m, + = turning left/north-of-east... i.e. counter-clockwise seen from above with z south)
    from a uniformly sampled polyline, using points +-win samples apart."""
    n = len(x)
    k = np.zeros(n)
    if n < 2 * win + 1:
        return k
    i = np.arange(win, n - win)
    ax, az = x[i - win], z[i - win]
    bx, bz = x[i], z[i]
    cx, cz = x[i + win], z[i + win]
    # circumscribed-circle curvature: 2*cross / (|ab||bc||ca|)
    abx, abz = bx - ax, bz - az
    bcx, bcz = cx - bx, cz - bz
    cax, caz = ax - cx, az - cz
    cr = abx * bcz - abz * bcx
    den = np.hypot(abx, abz) * np.hypot(bcx, bcz) * np.hypot(cax, caz) + 1e-9
    k[i] = 2 * cr / den
    k[:win] = k[win]
    k[n - win:] = k[n - win - 1]
    return k


def poly_project(p, x, z):
    """Closest point on polyline p (N,2) to (x, z): (distance, arc length s along p, segment index, t)."""
    a = p[:-1]
    b = p[1:]
    ab = b - a
    L2 = (ab ** 2).sum(1) + 1e-12
    t = np.clip(((x - a[:, 0]) * ab[:, 0] + (z - a[:, 1]) * ab[:, 1]) / L2, 0, 1)
    qx = a[:, 0] + ab[:, 0] * t
    qz = a[:, 1] + ab[:, 1] * t
    d = np.hypot(qx - x, qz - z)
    k = int(np.argmin(d))
    s = cumlen(p)
    return float(d[k]), float(s[k] + t[k] * math.sqrt(L2[k])), k, float(t[k])


def write_hashed(pub_dir, stem, data, keep_hours=48):
    """Content-addressed binary: <pub_dir>/<stem>.<sha256[:10]>.bin (zlib). Also keeps <stem>.bin (legacy name) and
    deletes older <stem>.*.bin files after keep_hours (clients mid-session keep resolving the previous name).
    Returns the file name."""
    import hashlib, glob
    z = zlib.compress(data, 9)
    h = hashlib.sha256(z).hexdigest()[:10]
    name = f'{stem}.{h}.bin'
    os.makedirs(pub_dir, exist_ok=True)
    for fn in (name, f'{stem}.bin'):
        tmp = os.path.join(pub_dir, fn + '.tmp')
        with open(tmp, 'wb') as f:
            f.write(z)
        os.replace(tmp, os.path.join(pub_dir, fn))
    now = time.time()
    for old in glob.glob(os.path.join(pub_dir, f'{stem}.*.bin')):
        if os.path.basename(old) != name and now - os.path.getmtime(old) > keep_hours * 3600:
            os.remove(old)
    return name
