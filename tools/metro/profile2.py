"""Metro vertical profile v2 (M2): structure classification + a joint, constrained least-squares solve of the top-of-rail
height of every track sample in the system, and the profile validator.

Unknowns: y at every published sample (5 m) of every track. Terms (weights in brackets):
  open track (grade / median / trench / embankment): y = lidar trackbed + 0.25 m            [1; 0.15 on terrarium]
  aerial / bridge:  y >= ground envelope (+-6 m) + clearance (5.5 m interior, tapering to 1 m at the run ends;
                    more over roads 7.2, freeways 7.6, railways 8.0, creeks 3.5)   + weak pull to ground + 8.5 m [0.01]
  cut-and-cover:    y <= ground - cover (7.5 m interior, 0 at the portal face)     + weak pull to ground - 11 m [0.005]
  bored tunnel:     y <= ground - 12 m (no pull: straight grades between fixed points)
  immersed tube:    y <= bay floor - 7 m; research anchors (deepest point)
  smoothness:       second differences                                               [lambda: 400 main, 60 service]
  junctions:        all tracks meeting at a junction share y there                     [1e4]
  parallel tracks:  mains 2-8 m apart, parallel, same OSM layer and structure class: equal y   [20]
  platforms:        every track along a station platform level shares y, and the platform is level   [1e3, 50]
  stacked levels:   12th St / 19th St upper (layer -2) >= lower (layer -3) + 7.5 m
  anchors:          researched rail heights (stations, tube)                           [200]
Inequalities (grade <= 4 %, vertical curve radius >= 1000 m, clearance, cover) are enforced with an active set of stiff
penalties, re-solving until none is violated. Everything is logged; notes/bart-data.md documents the constants.
"""
import collections, json, math, os, sys, time
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spl
from scipy.spatial import cKDTree
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from metro.common import MPH, RAW, curvature, log, w2ll, ll2w     # noqa: E402
from metro import dem as DEM                                      # noqa: E402

STRUCT_NAMES = ['grade', 'aerial', 'bridge', 'embankment', 'trench', 'median', 'portal', 'cutcover', 'bored', 'tube']
S = {n: i for i, n in enumerate(STRUCT_NAMES)}
UNDER = {S['cutcover'], S['bored'], S['tube'], S['portal']}
OPEN = {S['grade'], S['median'], S['trench'], S['embankment']}
AER = {S['aerial'], S['bridge']}

G_MAX = 0.040
R_V_MIN = 1000.0              # m, minimum vertical curve radius enforced (main line); validator reports < 1500 m
TOR_ABOVE_BED = 0.25          # top of rail above the lidar bare-earth trackbed (ballast top / slab)
AER_CLEAR = 5.5               # rail above the ground envelope, interior of aerial runs
AER_TARGET = 8.5
CC_COVER = 7.5                # rail below ground, interior of cut-and-cover runs
CC_TARGET = 11.0
BORED_COVER = 12.0
TUBE_COVER = 7.0
SEP_RAIL = 5.6               # m rail-to-rail where one track crosses over / is stacked above another (car 3.2 m + clearance + thin deck)
OFFS = np.array([-24, -16, -10, -6, -3, 0, 3, 6, 10, 16, 24], np.float64)
C0 = 5                        # index of offset 0

BERKELEY_HILLS = (37.845, -122.245, 37.880, -122.186)
TRANSBAY = (37.795, -122.392, 37.815, -122.300)

ROAD_CLEAR = {'motorway': 7.6, 'motorway_link': 7.4, 'trunk': 7.4, 'trunk_link': 7.2, 'primary': 7.2, 'primary_link': 7.2,
              'secondary': 7.2, 'secondary_link': 7.2, 'tertiary': 7.0, 'tertiary_link': 7.0, 'residential': 7.0,
              'unclassified': 7.0, 'living_street': 6.5, 'service': 6.5, 'pedestrian': 5.8, 'footway': 5.8, 'cycleway': 5.8, 'path': 5.8}


def in_box(lat, lon, box):
    la0, lo0, la1, lo1 = box
    return (lat >= la0) & (lat <= la1) & (lon >= lo0) & (lon <= lo1)


def rle(code):
    out = []
    a = 0
    for i in range(1, len(code) + 1):
        if i == len(code) or code[i] != code[a]:
            out.append((a, i, int(code[a])))
            a = i
    return out


# ====================================================================== roads (OSM) near the tracks
class Roads:
    def __init__(self, path=os.path.join(RAW, 'osm', 'roads_osm.json')):
        self.ok = os.path.exists(path)
        pts, dirs, cls, bridge, kind = [], [], [], [], []
        if self.ok:
            E = json.load(open(path))['elements']
            for e in E:
                if e['type'] != 'way' or not e.get('geometry'):
                    continue
                t = e.get('tags', {})
                if 'highway' in t:
                    k, c = 'road', t['highway']
                elif 'waterway' in t or t.get('natural') == 'water':
                    k, c = 'water', t.get('waterway') or 'water'
                elif 'railway' in t:
                    k, c = 'rail', t['railway']
                else:
                    continue
                g = e['geometry']
                x, z = ll2w(np.array([q['lat'] for q in g]), np.array([q['lon'] for q in g]))
                br = t.get('bridge') not in (None, 'no') or (t.get('layer') not in (None, '0') and str(t.get('layer', '0')).lstrip('-').isdigit() and int(t.get('layer')) > 0)
                tun = t.get('tunnel') not in (None, 'no') or (str(t.get('layer', '0')).lstrip('-').isdigit() and int(t.get('layer', '0')) < 0)
                for a in range(len(x) - 1):
                    dx, dz = x[a + 1] - x[a], z[a + 1] - z[a]
                    L = math.hypot(dx, dz)
                    if L < 1e-6:
                        continue
                    n = max(1, int(L / 4.0))
                    for q in range(n):
                        f = (q + 0.5) / n
                        pts.append((x[a] + dx * f, z[a] + dz * f))
                        dirs.append((dx / L, dz / L))
                        cls.append(c)
                        kind.append(k)
                        bridge.append(1 if br else (-1 if tun else 0))
        self.P = np.array(pts) if pts else np.zeros((0, 2))
        self.D = np.array(dirs) if dirs else np.zeros((0, 2))
        self.cls = np.array(cls)
        self.kind = np.array(kind)
        self.bridge = np.array(bridge, np.int8)
        self.kd = cKDTree(self.P) if len(self.P) else None
        log(f'roads near tracks: {len(self.P)} points' + ('' if self.ok else ' (roads_osm.json missing: no medians / crossings)'))


# ====================================================================== sample table
class Samples:
    def __init__(self, tracks):
        self.tracks = tracks
        self.off = np.zeros(len(tracks) + 1, np.int64)
        for k, tr in enumerate(tracks):
            self.off[k + 1] = self.off[k] + len(tr['pub']['s'])
        N = int(self.off[-1])
        self.N = N
        self.x = np.concatenate([tr['pub']['x'] for tr in tracks])
        self.z = np.concatenate([tr['pub']['z'] for tr in tracks])
        self.s = np.concatenate([tr['pub']['s'] for tr in tracks])
        self.tk = np.concatenate([np.full(len(tr['pub']['s']), k) for k, tr in enumerate(tracks)])
        self.li = np.concatenate([np.arange(len(tr['pub']['s'])) for tr in tracks])
        self.step = np.array([tr['pub']['step'] for tr in tracks])
        # tangents
        tx, tz = np.zeros(N), np.zeros(N)
        for k, tr in enumerate(tracks):
            a, b = self.off[k], self.off[k + 1]
            dx = np.gradient(self.x[a:b]); dz = np.gradient(self.z[a:b]); L = np.hypot(dx, dz) + 1e-12
            tx[a:b] = dx / L; tz[a:b] = dz / L
        self.tx, self.tz = tx, tz
        # OSM flags
        tun = np.zeros(N, bool); br = np.zeros(N, bool); layer = np.zeros(N, np.int8); cut = np.zeros(N, bool); emb = np.zeros(N, bool)
        main = np.zeros(N, bool); sysn = np.empty(N, object)
        for k, tr in enumerate(tracks):
            a = self.off[k]
            for i, t in enumerate(tr['pub']['tags']):
                tun[a + i] = t.get('tunnel') in ('yes', 'building_passage') or t.get('location') == 'underground'
                br[a + i] = t.get('bridge') not in (None, 'no')
                try:
                    layer[a + i] = int(str(t.get('layer', '0')).split(';')[0])
                except ValueError:
                    layer[a + i] = 0
                cut[a + i] = t.get('cutting') in ('yes', 'hollow')
                emb[a + i] = t.get('embankment') == 'yes'
            main[a:self.off[k + 1]] = tr['service'] is None
            sysn[a:self.off[k + 1]] = tr['sys']
        self.tun, self.br, self.layer, self.cut, self.emb, self.main, self.sys = tun, br, layer, cut, emb, main, sysn
        self.kd = cKDTree(np.stack([self.x, self.z], 1))

    def g(self, k, i):
        return int(self.off[k] + i)


# ====================================================================== ground
def ground_table(Sm):
    rx, rz = -Sm.tz, Sm.tx
    H = np.zeros((Sm.N, len(OFFS)))
    SRC = np.zeros((Sm.N, len(OFFS)), np.uint8)
    for j, o in enumerate(OFFS):
        h, src = DEM.ground(Sm.x + rx * o, Sm.z + rz * o)
        H[:, j] = h; SRC[:, j] = src
    return H, SRC


# ====================================================================== classification
def classify(Sm, H, SRC, roads, zones=None):
    N = Sm.N
    lat, lon = w2ll(Sm.x, Sm.z)
    code = np.full(N, S['grade'], np.uint8)
    median = np.zeros(N, bool)
    if roads.kd is not None:
        rx, rz = -Sm.tz, Sm.tx
        lists = roads.kd.query_ball_point(np.stack([Sm.x, Sm.z], 1), 48.0)
        for g, l in enumerate(lists):
            if not l:
                continue
            l = np.array(l)
            mw = (roads.kind[l] == 'road') & np.isin(roads.cls[l], ['motorway', 'trunk']) & (roads.bridge[l] == 0)
            if not mw.any():
                continue
            q = l[mw]
            par = np.abs(roads.D[q, 0] * Sm.tx[g] + roads.D[q, 1] * Sm.tz[g]) > 0.93
            if not par.any():
                continue
            q = q[par]
            lo = (roads.P[q, 0] - Sm.x[g]) * rx[g] + (roads.P[q, 1] - Sm.z[g]) * rz[g]
            if (lo < -5).any() and (lo > 5).any() and (lo[lo < -5].max() > -45) and (lo[lo > 5].min() < 45):
                median[g] = True
    for k, tr in enumerate(Sm.tracks):
        a, b = Sm.off[k], Sm.off[k + 1]
        c = np.full(b - a, S['grade'], np.uint8)
        tun, br = Sm.tun[a:b], Sm.br[a:b]
        c[tun] = S['cutcover']
        c[br & ~tun] = S['aerial']
        la, lo = lat[a:b], lon[a:b]
        und = c == S['cutcover']
        c[und & in_box(la, lo, BERKELEY_HILLS)] = S['bored']
        c[und & in_box(la, lo, TRANSBAY) & (H[a:b, C0] < -1.0)] = S['tube']
        # tube: within each contiguous underground run that goes under water, everything between the first and the
        # last wet sample is the immersed tube (the terrarium bay floor is patchy near the shores)
        for (p, q, v) in rle(tun.astype(np.uint8)):
            if v and (c[p:q] == S['tube']).any() and (q - p) * Sm.step[k] > 2000:
                wet = np.where(c[p:q] == S['tube'])[0]
                c[p + wet[0]:p + wet[-1] + 1] = S['tube']
        # open-air subtypes from the lidar cross-section: trench (bed well below both sides), embankment (above both)
        op = c == S['grade']
        gc = H[a:b, C0]
        left = np.median(H[a:b, 0:3], 1); right = np.median(H[a:b, 8:11], 1)
        trench = op & (np.minimum(left, right) - gc > 3.0) & (SRC[a:b, C0] == 1)
        emb = op & (gc - np.maximum(left, right) > 2.0) & (SRC[a:b, C0] == 1)
        c[trench] = S['trench']; c[emb] = S['embankment']
        c[op & Sm.cut[a:b]] = S['trench']; c[op & Sm.emb[a:b]] = S['embankment']
        med = op & median[a:b]
        c[med] = S['median']
        # clean-up: runs of open subtypes shorter than 40 m take their neighbours' code
        L = Sm.step[k]
        for _ in range(2):
            runs = rle(c)
            for idx, (p, q, cc) in enumerate(runs):
                if cc in (S['trench'], S['embankment'], S['median'], S['grade']) and (q - p) * L < 40 and len(runs) > 1:
                    nb = runs[idx - 1][2] if idx > 0 else runs[idx + 1][2]
                    if nb in OPEN:
                        c[p:q] = nb
        # short aerial runs -> bridge
        for (p, q, cc) in rle(c):
            if cc == S['aerial'] and (q - p) * L < 90:
                c[p:q] = S['bridge']
        # portals: the ends of real tunnels (> 150 m) next to open air
        runs = rle(c)
        kk = max(1, int(round(40 / L)))
        for idx, (p, q, cc) in enumerate(runs):
            if cc in (S['cutcover'], S['bored']) and (q - p) * L > 150:
                if idx > 0 and runs[idx - 1][2] not in UNDER:
                    c[p:min(q, p + kk)] = S['portal']
                if idx < len(runs) - 1 and runs[idx + 1][2] not in UNDER:
                    c[max(p, q - kk):q] = S['portal']
        code[a:b] = c
    if zones:
        for (k, i0, i1, cc) in zones:
            code[Sm.off[k] + i0:Sm.off[k] + i1] = cc
    return code


# ====================================================================== targets and bounds
def run_distance(code, k, Sm, pred):
    """Distance (m) from each sample of track k to the nearest end of its run (runs of samples where pred(code))."""
    a, b = Sm.off[k], Sm.off[k + 1]
    c = code[a:b]
    m = np.array([pred(v) for v in c])
    d = np.full(b - a, 1e9)
    L = Sm.step[k]
    for (p, q, v) in rle(m.astype(np.uint8)):
        if v:
            idx = np.arange(p, q)
            d[p:q] = np.minimum(idx - p + 0.5, q - 0.5 - idx) * L
    return d


def crossings(Sm, code, roads):
    """Required rail height above the ground at each aerial sample from what passes underneath (roads, rails, creeks)."""
    need = np.zeros(Sm.N)
    if roads.kd is None:
        return need
    aer = np.isin(code, list(AER))
    idx = np.where(aer)[0]
    if not len(idx):
        return need
    lists = roads.kd.query_ball_point(np.stack([Sm.x[idx], Sm.z[idx]], 1), 7.0)
    for g, l in zip(idx, lists):
        if not l:
            continue
        l = np.array(l)
        cross = np.abs(roads.D[l, 0] * Sm.tx[g] + roads.D[l, 1] * Sm.tz[g]) < 0.8     # not parallel
        l = l[cross & (roads.bridge[l] <= 0)]                                           # under us (not a bridge above)
        if not len(l):
            continue
        r = 0.0
        for q in l:
            if roads.kind[q] == 'road':
                r = max(r, ROAD_CLEAR.get(roads.cls[q], 6.5))
            elif roads.kind[q] == 'rail':
                r = max(r, 8.0)
            else:
                r = max(r, 3.5)
        need[g] = r
    # spread each crossing +-6 m along the track (the road has width)
    out = need.copy()
    for k in range(len(Sm.tracks)):
        a, b = Sm.off[k], Sm.off[k + 1]
        w = max(1, int(round(6.0 / Sm.step[k])))
        out[a:b] = ndimage.maximum_filter1d(need[a:b], 2 * w + 1, mode='nearest')
    return out


# ====================================================================== the solve
class System:
    def __init__(self, N):
        self.N = N
        self.r, self.c, self.v, self.b, self.w = [], [], [], [], []
        self.m = 0

    def row(self, cols, vals, rhs, w):
        for cc, vv in zip(cols, vals):
            self.r.append(self.m); self.c.append(cc); self.v.append(vv)
        self.b.append(rhs); self.w.append(w)
        self.m += 1

    def rows_arrays(self, cols, vals, rhs, w):
        """Vectorized: cols/vals (M, K) arrays, rhs/w (M,)."""
        M, K = cols.shape
        rid = np.repeat(np.arange(self.m, self.m + M), K)
        self.r.extend(rid.tolist()); self.c.extend(cols.ravel().tolist()); self.v.extend(vals.ravel().tolist())
        self.b.extend(np.asarray(rhs, float).tolist()); self.w.extend(np.asarray(w, float).tolist())
        self.m += M

    def matrices(self):
        A = sp.csr_matrix((np.array(self.v), (np.array(self.r), np.array(self.c))), shape=(self.m, self.N))
        return A, np.array(self.b), np.array(self.w)


def interp_cols(Sm, k, s):
    """Global columns + weights for linear interpolation of track k at s."""
    n = Sm.off[k + 1] - Sm.off[k]
    f = np.clip(s / Sm.step[k], 0, n - 1.000001)
    i = int(f); a = f - i
    return [int(Sm.off[k] + i), int(Sm.off[k] + i + 1)], [1 - a, a]


def solve(tracks, junctions, platform_groups, anchors, roads, research_zones=None, y0=None):
    t0 = time.time()
    Sm = Samples(tracks)
    H, SRC = ground_table(Sm)
    log(f'profile v2: {Sm.N} samples, lidar coverage {SRC[:, C0].mean() * 100:.1f} % ({time.time() - t0:.0f} s)')
    code = classify(Sm, H, SRC, roads, research_zones)
    need = crossings(Sm, code, roads)
    gc = H[:, C0]
    genv = H[:, 3:8].max(1)                     # ground envelope within +-6 m
    N = Sm.N
    lower = np.full(N, -1e9); upper = np.full(N, 1e9)
    sysm = System(N)
    # ---- data terms and bounds
    tgt = np.full(N, np.nan); wd = np.zeros(N)
    for k, tr in enumerate(tracks):
        a, b = Sm.off[k], Sm.off[k + 1]
        c = code[a:b]
        d_aer = run_distance(code, k, Sm, lambda v: v in AER)
        d_und = run_distance(code, k, Sm, lambda v: v in UNDER)
        lid = SRC[a:b, C0] == 1
        st_k = Sm.step[k]
        gsm = ndimage.gaussian_filter1d(gc[a:b], max(1.0, 10.0 / st_k), mode='nearest')     # street/ground over tunnels
        gbay = ndimage.gaussian_filter1d(gc[a:b], max(1.0, 80.0 / st_k), mode='nearest')    # bay floor over the tube
        for i in range(b - a):
            g = a + i; cc = int(c[i])
            if cc in OPEN:
                tgt[g] = gc[g] + TOR_ABOVE_BED; wd[g] = 1.0 if lid[i] else 0.15
            elif cc in AER:
                clear = min(AER_CLEAR, 1.0 + d_aer[i] * 0.09)
                if cc == S['bridge']:
                    clear = min(clear, 3.0)
                lower[g] = max(genv[g] + clear, gc[g] + need[g]) if need[g] > 0 else genv[g] + clear
                tgt[g] = gc[g] + AER_TARGET; wd[g] = 0.01
            elif cc == S['portal'] or cc == S['cutcover']:
                cover = min(CC_COVER, d_und[i] * 0.12)
                upper[g] = gsm[i] - cover
                tgt[g] = gsm[i] - min(CC_TARGET, d_und[i] * 0.12 + 0.25); wd[g] = 0.005
            elif cc == S['bored']:
                upper[g] = gsm[i] - min(BORED_COVER, d_und[i] * 0.2)
            elif cc == S['tube']:
                upper[g] = min(gbay[i], -2.0) - TUBE_COVER
    m = np.isfinite(tgt) & (wd > 0)
    idx = np.where(m)[0]
    sysm.rows_arrays(idx[:, None], np.ones((len(idx), 1)), tgt[idx], wd[idx])
    # weak regulariser toward the initial guess (keeps pure-inequality stretches well posed)
    base = y0 if y0 is not None else np.where(np.isfinite(tgt), tgt, gc)
    allidx = np.arange(N)
    sysm.rows_arrays(allidx[:, None], np.ones((N, 1)), base, np.full(N, 1e-6))
    # ---- smoothness
    for k, tr in enumerate(tracks):
        a, b = Sm.off[k], Sm.off[k + 1]
        if b - a < 3:
            continue
        lam = 400.0 if tr['service'] is None else 60.0
        i = np.arange(a + 1, b - 1)
        cols = np.stack([i - 1, i, i + 1], 1)
        vals = np.tile([1.0, -2.0, 1.0], (len(i), 1))
        sysm.rows_arrays(cols, vals, np.zeros(len(i)), np.full(len(i), lam))
    # ---- junctions
    tid = {tr['id']: k for k, tr in enumerate(tracks)}
    nj = 0
    for j in junctions:
        mem = [(tid[t], s) for t, s in j['tracks'] if t in tid]
        for q in range(1, len(mem)):
            ca, va = interp_cols(Sm, *mem[0])
            cb, vb = interp_cols(Sm, *mem[q])
            sysm.row(ca + cb, va + [-v for v in vb], 0.0, 1e4); nj += 1
    # ---- parallel tracks (same structure class and layer)
    cls = np.where(np.isin(code, list(UNDER)), 2, np.where(np.isin(code, list(AER)), 1, 0))
    npar = 0
    mains = np.where(Sm.main)[0]
    lists = Sm.kd.query_ball_point(np.stack([Sm.x[mains], Sm.z[mains]], 1), 8.5)
    for g, l in zip(mains, lists):
        k = Sm.tk[g]
        best = {}
        for q in l:
            k2 = Sm.tk[q]
            if k2 == k or not Sm.main[q]:
                continue
            if abs(Sm.tx[g] * Sm.tx[q] + Sm.tz[g] * Sm.tz[q]) < 0.985:
                continue
            if Sm.layer[q] != Sm.layer[g] or cls[q] != cls[g]:
                continue
            dd = math.hypot(Sm.x[q] - Sm.x[g], Sm.z[q] - Sm.z[g])
            if dd < 2.2:
                continue
            if k2 not in best or dd < best[k2][0]:
                best[k2] = (dd, q)
        for k2, (dd, q) in best.items():
            if k2 < k:
                continue        # each pair once
            # project g onto track k2 near q
            a2, b2 = Sm.off[k2], Sm.off[k2 + 1]
            i2 = q - a2
            j0 = max(0, i2 - 1)
            best_s = None
            for jj in (j0, i2):
                if jj + 1 >= b2 - a2:
                    continue
                ax, az = Sm.x[a2 + jj], Sm.z[a2 + jj]; dx, dz = Sm.x[a2 + jj + 1] - ax, Sm.z[a2 + jj + 1] - az
                L2 = dx * dx + dz * dz + 1e-12
                u = min(1, max(0, ((Sm.x[g] - ax) * dx + (Sm.z[g] - az) * dz) / L2))
                best_s = (jj + u) * Sm.step[k2] if best_s is None else best_s
            if best_s is None:
                continue
            cb, vb = interp_cols(Sm, k2, best_s)
            sysm.row([int(g)] + cb, [1.0] + [-v for v in vb], 0.0, 20.0); npar += 1
    # ---- station platforms: one level per group, level along the platform
    nst = 0
    for grp in platform_groups:
        mem = grp['members']                    # [(track id, s0, s1)]
        ks = [(tid[t], s0, s1) for t, s0, s1 in mem if t in tid]
        if not ks:
            continue
        k0, s0, s1 = ks[0]
        for ss in np.arange(s0, s1 + 0.1, 10.0):
            ca, va = interp_cols(Sm, k0, ss)
            # level
            cn, vn = interp_cols(Sm, k0, min(s1, ss + 10.0))
            if ss + 10.0 <= s1:
                sysm.row(ca + cn, va + [-v for v in vn], 0.0, 50.0)
            for (k2, u0, u1) in ks[1:]:
                # matching position on k2: same fraction along the platform
                f = (ss - s0) / max(1e-6, s1 - s0)
                cb, vb = interp_cols(Sm, k2, u0 + f * (u1 - u0))
                sysm.row(ca + cb, va + [-v for v in vb], grp.get('dy', {}).get(k2, 0.0), 1e3); nst += 1
    # ---- grade separations: where two tracks overlap in plan (< 4 m) and OSM says one is on a higher layer (stacked
    # subway levels at 12th/19th St, flyovers), the higher one must clear the lower by SEP_MIN (rail to rail). Pairs
    # near a junction joining the two tracks are skipped (a turnout onto a bridge ramp is not a crossing).
    SEP_MIN = SEP_RAIL
    jpos = {}
    for j in junctions:
        mem = [(tid[t], s) for t, s in j['tracks'] if t in tid]
        for (ka, sa) in mem:
            for (kb, sb) in mem:
                if ka != kb:
                    jpos.setdefault((ka, kb), []).append((sa, sb))
    sep = []
    pairs = Sm.kd.query_pairs(4.0, output_type='ndarray')
    for g, q in pairs:
        k, k2 = Sm.tk[g], Sm.tk[q]
        if k == k2 or Sm.layer[g] == Sm.layer[q]:
            continue
        hi, lo = (g, q) if Sm.layer[g] > Sm.layer[q] else (q, g)
        kh, kl = Sm.tk[hi], Sm.tk[lo]
        sh, sl_ = Sm.s[hi], Sm.s[lo]
        if any(abs(sh - a_) < 250 and abs(sl_ - b_) < 250 for a_, b_ in jpos.get((kh, kl), [])):
            continue
        sep.append((int(hi), int(lo)))
    sep = sorted(set(sep))
    log(f'grade-separation pairs (layer difference, < 4 m apart): {len(sep)}')
    # ---- anchors (researched rail heights)
    nan_ = 0
    for an in anchors.get('points', []):
        if an['track'] not in tid:
            continue
        ca, va = interp_cols(Sm, tid[an['track']], an['s'])
        sysm.row(ca, va, an['y'], an.get('w', 200.0)); nan_ += 1
    log(f'system: {sysm.m} least-squares rows ({nj} junction, {npar} parallel, {nst} platform, {nan_} anchor couplings)')
    if os.environ.get('METRO_QP') == 'osqp':
        y = solve_qp(Sm, sysm, tracks, tid, junctions, platform_groups, sep, lower, upper, base)
    else:
        y = solve_as(Sm, sysm, tracks, tid, junctions, platform_groups, sep, lower, upper, base)
    # write back
    for k, tr in enumerate(tracks):
        a, b = Sm.off[k], Sm.off[k + 1]
        p = tr['pub']
        p['y'] = y[a:b].copy(); p['g'] = gc[a:b].copy(); p['genv'] = genv[a:b].copy(); p['struct'] = code[a:b].copy()
        p['gsrc'] = SRC[a:b, C0].copy(); p['need'] = need[a:b].copy(); p['lower'] = lower[a:b].copy(); p['upper'] = upper[a:b].copy()
        p['H'] = H[a:b].copy()
    log(f'profile v2 solved in {time.time() - t0:.0f} s')
    return Sm


# ====================================================================== QP (OSQP)
def _osqp():
    try:
        import osqp
        return osqp
    except ImportError:
        lib = os.path.join(RAW, 'pylib')                  # pip install --target data/raw/metro/pylib osqp qdldl
        if os.path.isdir(lib) and lib not in sys.path:
            sys.path.insert(0, lib)
        import osqp
        return osqp


def solve_qp(Sm, sysm, tracks, tid, junctions, platform_groups, sep, lower, upper, base):
    """min ||W^1/2 (A y - b)||^2 + slack penalties. Hard: grades <= 4 %, vertical curves (mains) R >= R_V_MIN, junction
    equalities. Soft (slack variables, stiff penalties): platform equal level + level along the platform, grade
    separations (OSM layers), ground clearance / cover bounds. Slacks in use are reported (they mark data conflicts)."""
    osqp = _osqp()
    t0 = time.time()
    N = Sm.N
    A, bvec, w = sysm.matrices()
    Wm = sp.diags(w)
    P0 = (A.T @ Wm @ A).tocsc()
    q0 = -(A.T @ (w * bvec))
    rows, cols, vals, lo, hi = [], [], [], [], []
    slack_rho, slack_sig, slack_tag = [], [], []
    r = 0

    def add(cs, vs, l_, u_):
        nonlocal r
        rows.extend([r] * len(cs)); cols.extend(cs); vals.extend(vs); lo.append(l_); hi.append(u_); r += 1

    def soft(cs, vs, l_, u_, rho, sig, tag):
        """a.y in [l_, u_] softly: one slack per finite side."""
        if np.isfinite(l_):
            e = N + len(slack_rho); slack_rho.append(rho); slack_sig.append(sig); slack_tag.append(tag)
            add(cs + [e], vs + [1.0], l_, np.inf)
        if np.isfinite(u_):
            e = N + len(slack_rho); slack_rho.append(rho); slack_sig.append(sig); slack_tag.append(tag)
            add(cs + [e], vs + [-1.0], -np.inf, u_)

    # hard: grades + vertical curves (vectorised)
    same = np.ones(N - 1, bool); same[Sm.off[1:-1] - 1] = False
    step_g = Sm.step[Sm.tk]
    gi = np.where(same)[0]
    gm = G_MAX * step_g[gi]
    R0 = r
    rows.extend(np.repeat(np.arange(R0, R0 + len(gi)), 2).tolist()); cols.extend(np.stack([gi, gi + 1], 1).ravel().tolist())
    vals.extend(np.tile([-1.0, 1.0], len(gi)).tolist()); lo.extend((-gm).tolist()); hi.extend(gm.tolist()); r += len(gi)
    same2 = same[:-1] & same[1:] & Sm.main[1:-1]
    vi = np.where(same2)[0]
    km = step_g[vi + 1] ** 2 / R_V_MIN
    R0 = r
    rows.extend(np.repeat(np.arange(R0, R0 + len(vi)), 3).tolist()); cols.extend(np.stack([vi, vi + 1, vi + 2], 1).ravel().tolist())
    vals.extend(np.tile([1.0, -2.0, 1.0], len(vi)).tolist()); lo.extend((-km).tolist()); hi.extend(km.tolist()); r += len(vi)
    # hard: junctions
    for j in junctions:
        mem = [(tid[t], s_) for t, s_ in j['tracks'] if t in tid]
        for k_ in range(1, len(mem)):
            ca, va = interp_cols(Sm, *mem[0]); cb, vb = interp_cols(Sm, *mem[k_])
            add(ca + cb, va + [-v for v in vb], 0.0, 0.0)
    # soft (stiff): platforms
    for gidx, grp in enumerate(platform_groups):
        ks = [(tid[t], s0, s1) for t, s0, s1 in grp['members'] if t in tid]
        if not ks:
            continue
        k0, s0, s1 = ks[0]
        for ss in np.arange(s0, s1 + 0.1, 10.0):
            ca, va = interp_cols(Sm, k0, ss)
            if ss + 10.0 <= s1:
                cn, vn = interp_cols(Sm, k0, ss + 10.0)
                soft(ca + cn, va + [-v for v in vn], -0.03, 0.03, 2e4, 100.0, ('level', grp['station']))
            f = (ss - s0) / max(1e-6, s1 - s0)
            for (k2, u0, u1) in ks[1:]:
                cb, vb = interp_cols(Sm, k2, u0 + f * (u1 - u0))
                soft(ca + cb, va + [-v for v in vb], -0.01, 0.01, 2e4, 100.0, ('platform', grp['station']))
    # soft (stiff): grade separations
    for hi_, lo_ in sep:
        soft([hi_, lo_], [1.0, -1.0], SEP_RAIL, np.inf, 5e3, 50.0, ('sep', tracks[Sm.tk[hi_]]['id'], tracks[Sm.tk[lo_]]['id']))
    # soft: ground bounds
    for g in np.where(upper < 1e8)[0]:
        soft([int(g)], [1.0], -np.inf, float(upper[g]), 200.0, 20.0, ('cover', tracks[Sm.tk[g]]['id']))
    for g in np.where(lower > -1e8)[0]:
        soft([int(g)], [1.0], float(lower[g]), np.inf, 200.0, 20.0, ('clear', tracks[Sm.tk[g]]['id']))
    ns = len(slack_rho)
    for k_ in range(ns):
        add([N + k_], [1.0], 0.0, np.inf)
    M = N + ns
    Ac = sp.csc_matrix((vals, (rows, cols)), shape=(r, M))
    P = sp.block_diag([2 * P0, sp.diags(2 * np.array(slack_rho))]).tocsc()
    q = np.concatenate([2 * q0, np.array(slack_sig)])
    lo = np.array(lo); hi = np.array(hi)
    log(f'QP: {M} variables ({ns} slacks), {r} constraints, setup {time.time() - t0:.0f} s')
    if os.environ.get('METRO_QP_DUMP'):
        sp.save_npz(os.environ['METRO_QP_DUMP'] + '_P.npz', P); sp.save_npz(os.environ['METRO_QP_DUMP'] + '_A.npz', Ac)
        np.savez(os.environ['METRO_QP_DUMP'] + '_v.npz', q=q, lo=lo, hi=hi, base=base, N=N)
        log('QP dumped to', os.environ['METRO_QP_DUMP'])
    prob = osqp.OSQP()
    prob.setup(P, q, Ac, lo, hi, verbose=False, eps_abs=2e-4, eps_rel=1e-6, max_iter=80000, polish=True, adaptive_rho=True,
               scaling=15, check_termination=50)
    x0 = np.concatenate([base, np.zeros(ns)])
    prob.warm_start(x=x0)
    res = prob.solve()
    st = res.info.status
    log(f'QP status: {st}, iterations {res.info.iter}, polish {res.info.status_polish}, objective {res.info.obj_val:.1f}, {time.time() - t0:.0f} s')
    if res.x is None or 'infeasible' in str(st).lower():
        raise RuntimeError('profile QP failed: ' + str(st))
    v = res.x
    e = v[N:]
    used = collections.Counter()
    worst = {}
    for val, tag in zip(e, slack_tag):
        if val > 0.05:
            key = tag[0]
            used[key] += 1
            if key not in worst or val > worst[key][0]:
                worst[key] = (round(float(val), 2), tag)
    log('  soft constraints violated by > 5 cm: ' + (', '.join(f'{k} {n} (worst {worst[k]})' for k, n in used.items()) or 'none'))
    solve_qp.slack = [(float(val), tag) for val, tag in zip(e, slack_tag) if val > 0.05]
    return v[:N]


# ====================================================================== fast solver: penalty active set
def solve_as(Sm, sysm, tracks, tid, junctions, platform_groups, sep, lower, upper, base, maxit=60):
    """Same problem as solve_qp, solved by a penalty active-set method: equalities (junctions, platforms) always on;
    inequalities (grades, vertical curves, platform level, grade separations, ground bounds) get a stiff quadratic
    penalty toward their bound while active. Each round: add every violated constraint, release every active one the
    solution over-satisfies (its penalty no longer pushes), re-solve (sparse LU, ~1 s). Stiffness: grades/curves 1e6,
    equalities 1e6, separations/levels 1e5, ground bounds 1e3 (data terms are ~1)."""
    t0 = time.time()
    N = Sm.N
    A, bvec, w = sysm.matrices()
    # equalities -> extra LS rows
    eq = System(N)
    for j in junctions:
        mem = [(tid[t], s_) for t, s_ in j['tracks'] if t in tid]
        for k_ in range(1, len(mem)):
            ca, va = interp_cols(Sm, *mem[0]); cb, vb = interp_cols(Sm, *mem[k_])
            eq.row(ca + cb, va + [-v for v in vb], 0.0, 1e7)
    ineq = System(N)                     # rows a.y with bounds [l, u] and a stiffness
    L_, U_, W_, TAG = [], [], [], []

    def iq(cs, vs, l_, u_, wgt, tag):
        ineq.row(cs, vs, 0.0, wgt); L_.append(l_); U_.append(u_); W_.append(wgt); TAG.append(tag)

    for grp in platform_groups:
        ks = [(tid[t], s0, s1) for t, s0, s1 in grp['members'] if t in tid]
        if not ks:
            continue
        k0, s0, s1 = ks[0]
        for ss in np.arange(s0, s1 + 0.1, 10.0):
            ca, va = interp_cols(Sm, k0, ss)
            if ss + 10.0 <= s1:
                cn, vn = interp_cols(Sm, k0, ss + 10.0)
                iq(ca + cn, va + [-v for v in vn], -0.03, 0.03, 1e5, ('level', grp['station']))
            f = (ss - s0) / max(1e-6, s1 - s0)
            for (k2, u0, u1) in ks[1:]:
                cb, vb = interp_cols(Sm, k2, u0 + f * (u1 - u0))
                eq.row(ca + cb, va + [-v for v in vb], 0.0, 1e7)
    same = np.ones(N - 1, bool); same[Sm.off[1:-1] - 1] = False
    step_g = Sm.step[Sm.tk]
    gi = np.where(same)[0]
    n_ineq0 = ineq.m
    ineq.rows_arrays(np.stack([gi, gi + 1], 1), np.tile([-1.0, 1.0], (len(gi), 1)), np.zeros(len(gi)), np.full(len(gi), 1e7))
    L_ += (-G_MAX * step_g[gi]).tolist(); U_ += (G_MAX * step_g[gi]).tolist(); W_ += [1e7] * len(gi); TAG += [('grade',)] * len(gi)
    same2 = same[:-1] & same[1:] & Sm.main[1:-1]
    vi = np.where(same2)[0]
    km = step_g[vi + 1] ** 2 / R_V_MIN
    ineq.rows_arrays(np.stack([vi, vi + 1, vi + 2], 1), np.tile([1.0, -2.0, 1.0], (len(vi), 1)), np.zeros(len(vi)), np.full(len(vi), 1e7))
    L_ += (-km).tolist(); U_ += km.tolist(); W_ += [1e7] * len(vi); TAG += [('vcurve',)] * len(vi)
    for hi_, lo_ in sep:
        iq([hi_, lo_], [1.0, -1.0], SEP_RAIL, np.inf, 1e5, ('sep', tracks[Sm.tk[hi_]]['id'], tracks[Sm.tk[lo_]]['id']))
    iu = np.where(upper < 1e8)[0]; il = np.where(lower > -1e8)[0]
    ineq.rows_arrays(iu[:, None], np.ones((len(iu), 1)), np.zeros(len(iu)), np.full(len(iu), 1e3))
    L_ += [-np.inf] * len(iu); U_ += upper[iu].tolist(); W_ += [1e3] * len(iu); TAG += [('cover',)] * len(iu)
    ineq.rows_arrays(il[:, None], np.ones((len(il), 1)), np.zeros(len(il)), np.full(len(il), 1e3))
    L_ += lower[il].tolist(); U_ += [np.inf] * len(il); W_ += [1e3] * len(il); TAG += [('clear',)] * len(il)
    Aq, bq, wq = eq.matrices()
    C, _, _ = ineq.matrices()
    Lb = np.array(L_); Ub = np.array(U_); Wc = np.array(W_)
    N0 = (A.T @ sp.diags(w) @ A + Aq.T @ sp.diags(wq) @ Aq).tocsr()
    r0 = A.T @ (w * bvec) + Aq.T @ (wq * bq)
    act_lo = np.zeros(len(Lb), bool); act_hi = np.zeros(len(Lb), bool)
    CHAIN = np.array([t[0] in ('grade', 'vcurve') for t in TAG])
    sticky = np.zeros(len(Lb), bool)          # released once already: never released again
    y = spl.spsolve(N0.tocsc(), r0)
    log(f'active-set solve: {N} unknowns, {len(Lb)} inequalities, {eq.m} equalities, first solve {time.time() - t0:.0f} s')

    def resolve():
        act = act_lo | act_hi
        tgt = np.where(act_lo, Lb, Ub)
        Ca = C[act]; wa = Wc[act]
        Nm = (N0 + Ca.T @ sp.diags(wa) @ Ca).tocsc()
        return spl.spsolve(Nm, r0 + Ca.T @ (wa * tgt[act]))

    rounds = 0
    for phase in range(6):
        # phase A: add violated constraints until none (monotone)
        for it in range(80):
            cy = C @ y
            add_lo = (cy < Lb - 1e-3) & ~act_lo
            add_hi = (cy > Ub + 1e-3) & ~act_hi
            n_add = int(add_lo.sum() + add_hi.sum())
            if n_add == 0:
                break
            # grade / curve rows are consecutive per track: also pin neighbours that are within 90 % of the same bound
            # (a pinned ramp pushes its violation one sample along per round otherwise)
            near_lo = np.zeros_like(add_lo); near_hi = np.zeros_like(add_hi)
            for sh in (-2, -1, 1, 2):
                near_lo |= np.roll(add_lo, sh); near_hi |= np.roll(add_hi, sh)
            chain = CHAIN
            add_lo |= near_lo & chain & (cy < 0.9 * Lb) & np.isfinite(Lb) & ~act_lo
            add_hi |= near_hi & chain & (cy > 0.9 * Ub) & np.isfinite(Ub) & ~act_hi
            act_lo |= add_lo; act_hi |= add_hi
            act_hi &= ~act_lo                      # (never both)
            y = resolve(); rounds += 1
        # phase B: release over-satisfied, non-sticky constraints once
        cy = C @ y
        rel_lo = act_lo & ~sticky & (cy > Lb + 1e-4)
        rel_hi = act_hi & ~sticky & (cy < Ub - 1e-4)
        n_rel = int(rel_lo.sum() + rel_hi.sum())
        log(f'  phase {phase}: {int((act_lo | act_hi).sum())} active after {rounds} solves, releasing {n_rel} ({time.time() - t0:.0f} s)')
        if n_rel == 0:
            break
        sticky |= rel_lo | rel_hi
        act_lo &= ~rel_lo; act_hi &= ~rel_hi
        y = resolve(); rounds += 1
    cy = C @ y
    viol = np.maximum(Lb - cy, cy - Ub)
    used = collections.Counter(); worst = {}
    for k_ in np.where(viol > 0.05)[0]:
        key = TAG[k_][0]; used[key] += 1
        if key not in worst or viol[k_] > worst[key][0]:
            worst[key] = (round(float(viol[k_]), 2), TAG[k_])
    log('  constraints violated by > 5 cm: ' + (', '.join(f'{k} {n} (worst {worst[k]})' for k, n in used.items()) or 'none')
        + f'; solved in {time.time() - t0:.0f} s')
    return y


# ====================================================================== speed, cant, depth, segments
def finish(tracks, vcap=None):
    for tr in tracks:
        p = tr['pub']
        x, z, step = p['x'], p['z'], p['step']
        win = max(1, int(round(15.0 / step)))
        kap = curvature(x, z, step, win)
        kap = ndimage.gaussian_filter1d(kap, max(1.0, 10.0 / step), mode='nearest')
        R = 1.0 / np.maximum(np.abs(kap), 1e-6)
        vmax = {'bart': 70 * MPH, 'ebart': 70 * MPH, 'oac': 31 * MPH}.get(tr['sys'], 70 * MPH)
        # turnouts / crossovers / yards carry no cant: unbalanced lateral acceleration only
        a_lat = 1.40 if tr['service'] in (None, 'siding') else 0.65
        if tr['service'] == 'yard':
            vmax = min(vmax, 15 * MPH)
        v = np.minimum(vmax, np.sqrt(a_lat * R))
        v = ndimage.minimum_filter1d(v, max(1, int(round(120.0 / step))), mode='nearest')
        v = np.floor(v / MPH / 5.0) * 5.0 * MPH
        v = np.maximum(v, 10 * MPH)
        if vcap is not None:
            v = np.minimum(v, vcap(tr, p))
        cant = np.zeros_like(v)
        if tr['service'] in (None, 'siding'):
            cant = np.clip(1.75 * v * v / (9.81 * R) - 0.075, 0.0, 0.15) * np.sign(kap)
            cant = ndimage.gaussian_filter1d(cant, max(1.0, 20.0 / step), mode='nearest')
        code = p['struct']
        g = p['g']
        y = p['y']
        depth = np.where(np.isin(code, list(UNDER)), g - y, np.where(np.isin(code, list(AER)), y - g, 0.0))
        p.update(vlim=v, cant=cant, depth=np.clip(depth, 0, 255), curv=kap)
        segs = []
        for a, b, c in rle(code):
            s0 = float(p['s'][a]); s1 = float(p['s'][min(b, len(p['s']) - 1)])
            segs.append([round(s0, 1), round(s1, 1), STRUCT_NAMES[c]])
        p['segments'] = segs


# ====================================================================== validator
def validate(tracks, stations, junctions, platform_groups):
    """Checks the lead asked for; returns (summary lines, report dict)."""
    rep = {'platform_mismatch': [], 'grade': [], 'vcurve': [], 'buried_open': [], 'aerial_low': [], 'tunnel_shallow': [], 'junction': []}
    byid = {t['id']: t for t in tracks}

    def yat(tid, s):
        t = byid[tid]; p = t['pub']; f = np.clip(s / p['step'], 0, len(p['y']) - 1.000001); i = int(f); a = f - i
        return p['y'][i] * (1 - a) + p['y'][i + 1] * a

    for grp in platform_groups:
        mem = grp['members']
        if len(mem) < 2:
            continue
        worst = 0.0
        for f in np.linspace(0, 1, 11):
            ys = [yat(t, s0 + f * (s1 - s0)) - grp.get('dyid', {}).get(t, 0.0) for t, s0, s1 in mem]
            worst = max(worst, max(ys) - min(ys))
        if worst > 0.05:
            rep['platform_mismatch'].append([grp['station'], round(float(worst), 2), [m[0] for m in mem]])
    for t in tracks:
        p = t['pub']; y = p['y']; st = p['step']; code = p['struct']
        if len(y) < 3:
            continue
        gr = np.diff(y) / st
        if t['service'] is None:
            k = int(np.abs(gr).argmax())
            if abs(gr[k]) > G_MAX + 0.001:
                rep['grade'].append([t['id'], round(float(k * st), 1), round(float(gr[k]) * 100, 2)])
            d2 = (y[:-2] - 2 * y[1:-1] + y[2:]) / st ** 2
            bad = np.where(np.abs(d2) > 1 / 1500.0)[0]
            if len(bad):
                k = bad[int(np.abs(d2[bad]).argmax())]
                rep['vcurve'].append([t['id'], round(float((k + 1) * st), 1), round(float(1 / abs(d2[k])), 0), int(len(bad))])
        g = p['g']; ge = p['genv']
        op = np.isin(code, list(OPEN))
        bur = op & (y < g - 1.0)
        if bur.any():
            k = np.where(bur)[0]
            rep['buried_open'].append([t['id'], round(float(k[0] * st), 1), round(float((g - y)[k].max()), 2), int(len(k))])
        aer = np.isin(code, [S['aerial']])
        dist = np.zeros(len(y))
        for a_, b_, c_ in rle(aer.astype(np.uint8)):
            if c_:
                ii = np.arange(a_, b_); dist[a_:b_] = np.minimum(ii - a_, b_ - 1 - ii) * st
        low = aer & (dist > 60) & (y - ge < 5.0)
        if low.any():
            k = np.where(low)[0]
            rep['aerial_low'].append([t['id'], round(float(k[0] * st), 1), round(float((y - ge)[k].min()), 2), int(len(k))])
        und = np.isin(code, [S['cutcover'], S['bored'], S['tube']])
        dist = np.zeros(len(y))
        for a_, b_, c_ in rle(und.astype(np.uint8)):
            if c_:
                ii = np.arange(a_, b_); dist[a_:b_] = np.minimum(ii - a_, b_ - 1 - ii) * st
        sh = und & (dist > 80) & (g - y < 6.0)
        if sh.any():
            k = np.where(sh)[0]
            rep['tunnel_shallow'].append([t['id'], round(float(k[0] * st), 1), round(float((g - y)[k].min()), 2), int(len(k))])
    for j in junctions:
        ys = [yat(t, s) for t, s in j['tracks'] if t in byid]
        if ys and max(ys) - min(ys) > 0.05:
            rep['junction'].append([j['id'], round(float(max(ys) - min(ys)), 2)])
    lines = ['profile validator:',
             f"  platform rail mismatch > 5 cm: {len(rep['platform_mismatch'])}" + (f" (worst {max(rep['platform_mismatch'], key=lambda r: r[1])})" if rep['platform_mismatch'] else ''),
             f"  main tracks with grade > 4 %: {len(rep['grade'])}" + (f" (worst {max(rep['grade'], key=lambda r: abs(r[2]))})" if rep['grade'] else ''),
             f"  main tracks with vertical curve radius < 1500 m: {len(rep['vcurve'])}" + (f" (worst {min(rep['vcurve'], key=lambda r: r[2])})" if rep['vcurve'] else ''),
             f"  open track > 1 m below the lidar ground: {len(rep['buried_open'])}" + (f" (e.g. {rep['buried_open'][:3]})" if rep['buried_open'] else ''),
             f"  aerial interiors with < 5 m clearance: {len(rep['aerial_low'])}" + (f" (e.g. {rep['aerial_low'][:3]})" if rep['aerial_low'] else ''),
             f"  tunnel interiors with < 6 m cover: {len(rep['tunnel_shallow'])}" + (f" (e.g. {rep['tunnel_shallow'][:3]})" if rep['tunnel_shallow'] else ''),
             f"  junction height mismatch > 5 cm: {len(rep['junction'])}" + (f" (worst {max(rep['junction'], key=lambda r: r[1])})" if rep['junction'] else '')]
    return lines, rep
