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
R_V_MIN = 800.0               # m, minimum vertical curve radius enforced (main line) ...
AV_MAX = 0.49                 # ... and at least v^2 / AV_MAX at the civil speed limit: vertical acceleration <= 0.05 g
TOR_ABOVE_BED = 0.25          # top of rail above the lidar bare-earth trackbed (ballast top / slab)
AER_CLEAR = 5.5               # rail above the ground envelope, interior of aerial runs
AER_TARGET = 8.5
CC_COVER = 7.5                # rail below ground, interior of cut-and-cover runs
FACE_COVER = 0.0              # required cover at an OSM tunnel start (grows 3 %/m inside). A box needs ~5-6 m, but OSM's
                              # tunnel tags often start at a lid or road bridge before the real portal (Millbrae, West
                              # Dublin) and some lidar predates construction (Fremont): 5 m there buried stations, so the
                              # approach is left to the lidar; the cover plane tells infra where a box would stick out
CC_TARGET = 11.0
BORED_COVER = 12.0
TUBE_COVER = 7.0
RAMP = 0.03                  # clearance / cover requirements grow at 3 % from a structure end (a 4 % track can meet them)
SF_BORES = 560.0             # m of twin compressed-air bores from the SF vent structure to the Embarcadero box
TUBE_GMAX = 0.03             # Transbay Tube grades: 3 % max (infra research)
OAC_GMAX = 0.065             # airport connector (cable-hauled): the lidar shows ~6 % from the aerial down to the Doolittle Dr underpass
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
    import hashlib
    key = hashlib.sha1(np.round(np.stack([Sm.x, Sm.z], 1), 2).tobytes()).hexdigest()[:16]
    cp = os.path.join(RAW, 'cache', f'ground_{key}.npz')
    if os.path.exists(cp):
        z_ = np.load(cp)
        return z_['H'], z_['SRC']
    H, SRC = _ground_table(Sm)
    os.makedirs(os.path.dirname(cp), exist_ok=True)
    np.savez_compressed(cp, H=H, SRC=SRC)
    return H, SRC


def _ground_table(Sm):
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
    underpass = []
    for k, tr in enumerate(Sm.tracks):
        a, b = Sm.off[k], Sm.off[k + 1]
        c = np.full(b - a, S['grade'], np.uint8)
        tun, br = Sm.tun[a:b], Sm.br[a:b]
        c[tun] = S['cutcover']
        c[br & ~tun] = S['aerial']
        la, lo = lat[a:b], lon[a:b]
        und = c == S['cutcover']
        c[und & in_box(la, lo, BERKELEY_HILLS)] = S['bored']
        if tr.get('tube'):
            lo_, hi_, s_sf, s_oak = tr['tube']
            ss_ = Sm.s[a:b]
            c[tun & (ss_ >= lo_) & (ss_ <= hi_)] = S['tube']
            dsf = (ss_ - s_sf) * (1 if s_sf > s_oak else -1)           # > 0 on the SF side of the vent
            c[tun & (dsf > 0) & (dsf < SF_BORES)] = S['bored']
        else:
            c[und & in_box(la, lo, TRANSBAY) & (H[a:b, C0] < -1.0)] = S['tube']
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
        # open gaps < 60 m between two covered runs are covered too (station lids, OSM tag gaps)
        runs = rle(c)
        for idx, (p, q, cc) in enumerate(runs):
            if 0 < idx < len(runs) - 1 and cc in OPEN and (q - p) * L < 60 and runs[idx - 1][2] in (S['cutcover'], S['bored']) \
                    and runs[idx + 1][2] in (S['cutcover'], S['bored']):
                c[p:q] = S['cutcover']
        # OSM "tunnels" that are only a road bridge over open track: the bare-earth lidar has no deck, so the ground over
        # the run is no higher than the track bed either side (West Dublin: 100 m under the I-680 ramps; Millbrae Ave).
        # They stay open track; tracks[].crossings records the road passing over.
        runs = rle(c)
        w80 = max(1, int(round(80 / L)))
        for idx, (p, q, cc) in enumerate(runs):
            if cc != S['cutcover'] or not (0 < idx < len(runs) - 1) or (q - p) * L >= 250:
                continue
            (p0, q0, c0), (p1, q1, c1) = runs[idx - 1], runs[idx + 1]
            if c0 not in OPEN or c1 not in OPEN or (SRC[a + p:a + q, C0] == 1).mean() < 0.8:
                continue
            side0, side1 = gc[max(p0, p - w80):p], gc[q:min(q1, q + w80)]
            if len(side0) and len(side1) and np.median(gc[p:q]) < max(np.median(side0), np.median(side1)) + 1.0:
                c[p:q] = c0 if c0 == c1 else S['grade']
                underpass.append((tr['id'], round(p * L), round((q - p) * L)))
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
    if underpass:
        log(f'OSM tunnels that are road bridges over open track (no ground over them in the lidar): {underpass}')
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
        gmed = ndimage.median_filter(gc[a:b], size=9, mode='nearest') if b - a > 9 else gc[a:b]
        gsm = ndimage.gaussian_filter1d(gc[a:b], max(1.0, 10.0 / st_k), mode='nearest')     # street/ground over tunnels
        gbay = ndimage.gaussian_filter1d(gc[a:b], max(1.0, 80.0 / st_k), mode='nearest')    # bay floor over the tube
        for i in range(b - a):
            g = a + i; cc = int(c[i])
            if cc in OPEN:
                tgt[g] = gmed[i] + TOR_ABOVE_BED; wd[g] = 1.0 if lid[i] else 0.15
            elif cc in AER:
                clear = min(AER_CLEAR, 1.0 + d_aer[i] * RAMP)
                if cc == S['bridge']:
                    clear = min(clear, 3.0)
                lower[g] = max(gc[g] + clear, gc[g] + need[g])
                tgt[g] = gc[g] + AER_TARGET; wd[g] = 0.01
            elif cc == S['portal'] or cc == S['cutcover']:
                cover = min(CC_COVER, FACE_COVER + d_und[i] * RAMP)
                upper[g] = gsm[i] - cover
                tgt[g] = gsm[i] - min(CC_TARGET, FACE_COVER + d_und[i] * RAMP + 0.25); wd[g] = 0.005
            elif cc == S['bored']:
                upper[g] = gsm[i] - min(BORED_COVER, FACE_COVER + d_und[i] * RAMP)
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
        lam = 2000.0 if tr['service'] is None else 150.0
        i = np.arange(a + 1, b - 1)
        cols = np.stack([i - 1, i, i + 1], 1)
        vals = np.tile([1.0, -2.0, 1.0], (len(i), 1))
        sysm.rows_arrays(cols, vals, np.zeros(len(i)), np.full(len(i), lam))
    # ---- per-sample grade limits (Tube 3 %) and the Berkeley Hills Tunnel's as-built grades: 1.75 % rising from the
    # west portal to a summit 1.55 km (5,100 ft) inside the east portal, then 0.3 % falling to the east portal
    # (Rogers & Peck / geolith.com via research B; the Wikipedia infobox gives 1.2 % (2 % max))
    gmax = np.full(N, G_MAX)
    gmax[code == S['tube']] = TUBE_GMAX
    gmax[Sm.sys == 'oac'] = OAC_GMAX
    Sm.gmax = gmax
    # vertical curves: R >= 800 m and vertical acceleration <= 0.05 g at the civil speed limit (70 mph: R >= 2,000 m)
    rv = np.full(N, R_V_MIN)
    for k, tr in enumerate(tracks):
        a, b = Sm.off[k], Sm.off[k + 1]
        if b - a >= 3:
            v_ = plan_speed(tr)[0]
            rv[a:b] = np.maximum(R_V_MIN, v_ ** 2 / AV_MAX)
    Sm.rv = rv
    for k, tr in enumerate(tracks):
        a, b = Sm.off[k], Sm.off[k + 1]
        c = code[a:b]
        for (p_, q_, v_) in rle((c == S['bored']).astype(np.uint8)):
            if not v_ or (q_ - p_) * Sm.step[k] < 4000:
                continue
            lo_ = w2ll(Sm.x[a + p_], Sm.z[a + p_])[1]; hi_ = w2ll(Sm.x[a + q_ - 1], Sm.z[a + q_ - 1])[1]
            west_first = lo_ < hi_                     # the run's first sample is the west portal
            n_ = q_ - p_
            h_ = Sm.step[k]
            for j in range(n_ - 1):
                dist_w = (j + 0.5) * h_ if west_first else (n_ - 1.5 - j) * h_      # from the west portal
                dist_e = n_ * h_ - dist_w
                g_ = 0.0175 if dist_e > 1550.0 else -0.003
                slope = g_ if west_first else -g_                 # per +s
                g0 = int(a + p_ + j)
                sysm.row([g0, g0 + 1], [-1.0, 1.0], slope * h_, 2e3)
            log(f'  Berkeley Hills template on {tr["id"]}: {n_ * h_ / 1000:.2f} km bored run')
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
        mem = grp['members']                    # [(track id, s0, s1[, dy])]
        ks = [(tid[m[0]], m[1], m[2]) for m in mem if m[0] in tid and (len(m) < 4 or abs(m[3]) < 1e-9)]
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
    # researched station heights relative to the ground along the platform (street above a subway, ground below an
    # aerial): y(centre) = median lidar ground over the platform + rel
    anchors['resolved'] = []
    for an in anchors.get('rel', []):
        if an['track'] not in tid:
            continue
        k = tid[an['track']]
        a_, b_ = Sm.off[k], Sm.off[k + 1]
        i0 = int(max(0, an['s0'] / Sm.step[k])); i1 = int(min(b_ - a_ - 1, an['s1'] / Sm.step[k]))
        gref = float(np.median(gc[a_ + i0:a_ + i1 + 1]))
        yc = gref + an['rel']
        ca, va = interp_cols(Sm, k, 0.5 * (an['s0'] + an['s1']))
        sysm.row(ca, va, yc, an['w']); nan_ += 1
        anchors['resolved'].append(dict(an, ground=round(gref, 2), y=round(yc, 2)))
    log(f'system: {sysm.m} least-squares rows ({nj} junction, {npar} parallel, {nst} platform, {nan_} anchor couplings)')
    mode = os.environ.get('METRO_QP')
    if not mode:
        try:
            _osqp(); mode = 'osqp'                     # exact QP (~3-4 min); the fast penalty solver otherwise
        except ImportError:
            mode = 'ls'
    if mode == 'osqp':
        y = solve_qp(Sm, sysm, tracks, tid, junctions, platform_groups, sep, lower, upper, base)
    elif mode == 'as':
        y = solve_as(Sm, sysm, tracks, tid, junctions, platform_groups, sep, lower, upper, base)
    else:
        y = solve_ls(Sm, sysm, tracks, tid, junctions, platform_groups, sep, lower, upper, base)
    # OSM often tags a whole station or approach as bridge where only a street span is: aerial samples whose rail is
    # within 2.5 m of the lidar ground (fill under the track) become embankment, keeping runs >= 20 m
    refined = 0
    for k, tr in enumerate(tracks):
        a, b = Sm.off[k], Sm.off[k + 1]
        c = code[a:b]
        fill = np.isin(c, list(AER)) & (SRC[a:b, C0] == 1) & (y[a:b] - gc[a:b] < 2.5)
        for (p_, q_, v_) in rle(fill.astype(np.uint8)):
            if v_ and (q_ - p_) * Sm.step[k] >= 20:
                c[p_:q_] = S['embankment']; refined += q_ - p_
        code[a:b] = c
    log(f'aerial samples on lidar fill reclassified as embankment: {refined}')
    # open track the solution puts > 1 m below the ground next to a tunnel or a cutting is in a cut too (portal
    # approaches: the rail is ~5 m down at a tunnel face; the ground under a road bridge over a trench)
    cuts = 0
    for k, tr in enumerate(tracks):
        a, b = Sm.off[k], Sm.off[k + 1]
        c = code[a:b]
        low = np.isin(c, [S['grade'], S['median'], S['embankment']]) & (gc[a:b] - y[a:b] > 1.0)
        for _ in range(3):                             # a cut may reach a tunnel through a run that just became one
            ch = 0
            for (p_, q_, v_) in rle(low.astype(np.uint8)):
                if not v_:
                    continue
                nb = [c[p_ - 1] if p_ > 0 else -1, c[q_] if q_ < len(c) else -1]
                if any(v in UNDER or v == S['trench'] for v in nb):
                    c[p_:q_] = S['trench']; low[p_:q_] = False; ch += q_ - p_
            cuts += ch
            if not ch:
                break
        code[a:b] = c
    log(f'open samples below the ground next to a tunnel/cutting reclassified as trench: {cuts}')
    # write back
    for k, tr in enumerate(tracks):
        a, b = Sm.off[k], Sm.off[k + 1]
        p = tr['pub']
        p['y'] = y[a:b].copy(); p['g'] = gc[a:b].copy(); p['genv'] = genv[a:b].copy(); p['struct'] = code[a:b].copy()
        p['gsrc'] = SRC[a:b, C0].copy(); p['need'] = need[a:b].copy(); p['lower'] = lower[a:b].copy(); p['upper'] = upper[a:b].copy()
        p['H'] = H[a:b].copy()
    for an in anchors.get('resolved', []):
        k = tid[an['track']]
        ca, va = interp_cols(Sm, k, 0.5 * (an['s0'] + an['s1']))
        an['solved'] = round(float(sum(y[c_] * v_ for c_, v_ in zip(ca, va))), 2)
        an['delta'] = round(an['solved'] - an['y'], 2)
    log(f'profile v2 solved in {time.time() - t0:.0f} s')
    try:
        np.savez_compressed(os.path.join(RAW, 'cache', 'profile_debug.npz'), y=y, gc=gc, genv=genv, lower=lower, upper=upper, code=code,
                            tgt=tgt, wd=wd, need=need, x=Sm.x, z=Sm.z, s=Sm.s, tk=Sm.tk, off=Sm.off, layer=Sm.layer,
                            ids=np.array([t['id'] for t in tracks]), sep=np.array(sep if len(sep) else np.zeros((0, 2), int)))
    except Exception as e:
        log('debug dump failed', e)
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
    gm = Sm.gmax[gi] * step_g[gi]
    R0 = r
    rows.extend(np.repeat(np.arange(R0, R0 + len(gi)), 2).tolist()); cols.extend(np.stack([gi, gi + 1], 1).ravel().tolist())
    vals.extend(np.tile([-1.0, 1.0], len(gi)).tolist()); lo.extend((-gm).tolist()); hi.extend(gm.tolist()); r += len(gi)
    same2 = same[:-1] & same[1:] & Sm.main[1:-1]
    vi = np.where(same2)[0]
    km = step_g[vi + 1] ** 2 / Sm.rv[vi + 1]
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
        ks = [(tid[m[0]], m[1], m[2], (m[3] if len(m) > 3 else 0.0)) for m in grp['members'] if m[0] in tid]
        if not ks:
            continue
        k0, s0, s1, _ = ks[0]
        L0 = (Sm.off[k0 + 1] - Sm.off[k0] - 1) * Sm.step[k0]
        for ss in np.arange(max(0.0, s0 - 15.0), min(L0, s1 + 15.0) - 9.99, 5.0):          # level, 15 m beyond each end
            ca, va = interp_cols(Sm, k0, ss); cn, vn = interp_cols(Sm, k0, ss + 10.0)
            soft(ca + cn, va + [-v for v in vn], -0.02, 0.02, 2e4, 100.0, ('level', grp['station']))
        for ss in np.arange(s0, s1 + 0.1, 10.0):
            ca, va = interp_cols(Sm, k0, ss)
            f = (ss - s0) / max(1e-6, s1 - s0)
            for (k2, u0, u1, dy) in ks[1:]:                        # y(member) = y(reference) + dy
                cb, vb = interp_cols(Sm, k2, u0 + f * (u1 - u0))
                soft(ca + cb, va + [-v for v in vb], -dy - 0.01, -dy + 0.01, 2e4, 100.0, ('platform', grp['station']))
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
        ks = [(tid[m[0]], m[1], m[2], (m[3] if len(m) > 3 else 0.0)) for m in grp['members'] if m[0] in tid]
        if not ks:
            continue
        k0, s0, s1, _ = ks[0]
        for ss in np.arange(s0, s1 + 0.1, 10.0):
            ca, va = interp_cols(Sm, k0, ss)
            if ss + 10.0 <= s1:
                cn, vn = interp_cols(Sm, k0, ss + 10.0)
                iq(ca + cn, va + [-v for v in vn], -0.03, 0.03, 1e5, ('level', grp['station']))
            f = (ss - s0) / max(1e-6, s1 - s0)
            for (k2, u0, u1, dy) in ks[1:]:
                cb, vb = interp_cols(Sm, k2, u0 + f * (u1 - u0))
                eq.row(ca + cb, va + [-v for v in vb], -dy, 1e7)
    same = np.ones(N - 1, bool); same[Sm.off[1:-1] - 1] = False
    step_g = Sm.step[Sm.tk]
    gi = np.where(same)[0]
    n_ineq0 = ineq.m
    ineq.rows_arrays(np.stack([gi, gi + 1], 1), np.tile([-1.0, 1.0], (len(gi), 1)), np.zeros(len(gi)), np.full(len(gi), 1e7))
    L_ += (-Sm.gmax[gi] * step_g[gi]).tolist(); U_ += (Sm.gmax[gi] * step_g[gi]).tolist(); W_ += [1e7] * len(gi); TAG += [('grade',)] * len(gi)
    same2 = same[:-1] & same[1:] & Sm.main[1:-1]
    vi = np.where(same2)[0]
    km = step_g[vi + 1] ** 2 / Sm.rv[vi + 1]
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


# ====================================================================== fast solver v2 (default)
def solve_ls(Sm, sysm, tracks, tid, junctions, platform_groups, sep, lower, upper, base, maxrounds=60):
    """Least squares + inequalities by a monotone penalty active set.
    Equalities as stiff LS rows: junctions (1e7), platform levels across tracks (1e6) and level along the platform
    (1e5). Inequalities: grade limits (1e7; 4 %, Tube 3 %), ground cover/clearance (1e3), grade separations (1e5).
    Vertical curves come from the smoothing term (validator reports radii < 1500 m). Each round adds every violated
    inequality (plus the neighbours of violated grades on the same side, which otherwise propagate one sample per
    round); a final round releases, once, the constraints the solution over-satisfies."""
    t0 = time.time()
    N = Sm.N
    A, bvec, w = sysm.matrices()
    eq = System(N)
    for j in junctions:
        mem = [(tid[t], s_) for t, s_ in j['tracks'] if t in tid]
        for k_ in range(1, len(mem)):
            ca, va = interp_cols(Sm, *mem[0]); cb, vb = interp_cols(Sm, *mem[k_])
            eq.row(ca + cb, va + [-v for v in vb], 0.0, 1e7)
    for grp in platform_groups:
        ks = [(tid[m[0]], m[1], m[2], (m[3] if len(m) > 3 else 0.0)) for m in grp['members'] if m[0] in tid]
        if not ks:
            continue
        k0, s0, s1, _ = ks[0]
        L0 = (Sm.off[k0 + 1] - Sm.off[k0] - 1) * Sm.step[k0]
        for ss in np.arange(max(0.0, s0 - 15.0), min(L0, s1 + 15.0) - 9.99, 5.0):          # level, 15 m beyond each end
            ca, va = interp_cols(Sm, k0, ss); cn, vn = interp_cols(Sm, k0, ss + 10.0)
            eq.row(ca + cn, va + [-v for v in vn], 0.0, 1e5)
        for ss in np.arange(s0, s1 + 0.1, 10.0):
            ca, va = interp_cols(Sm, k0, ss)
            f = (ss - s0) / max(1e-6, s1 - s0)
            for (k2, u0, u1, dy) in ks[1:]:
                cb, vb = interp_cols(Sm, k2, u0 + f * (u1 - u0))
                eq.row(ca + cb, va + [-v for v in vb], -dy, 1e6)
    Aq, bq, wq = eq.matrices()
    N0 = (A.T @ sp.diags(w) @ A + Aq.T @ sp.diags(wq) @ Aq).tocsr()
    r0 = A.T @ (w * bvec) + Aq.T @ (wq * bq)
    # inequality rows
    same = np.ones(N - 1, bool); same[Sm.off[1:-1] - 1] = False
    step_g = Sm.step[Sm.tk]
    gi = np.where(same)[0]
    gm = Sm.gmax[gi] * step_g[gi]
    rows = [np.repeat(np.arange(len(gi)), 2)]; cols = [np.stack([gi, gi + 1], 1).ravel()]; vals = [np.tile([-1.0, 1.0], len(gi))]
    L_ = [-gm]; U_ = [gm]; W_ = [np.full(len(gi), 1e7)]; K_ = [np.zeros(len(gi), np.int8)]
    m0 = len(gi)
    iu = np.where(upper < 1e8)[0]; il = np.where(lower > -1e8)[0]
    rows.append(m0 + np.arange(len(iu))); cols.append(iu); vals.append(np.ones(len(iu)))
    L_.append(np.full(len(iu), -np.inf)); U_.append(upper[iu]); W_.append(np.full(len(iu), 1e3)); K_.append(np.full(len(iu), 1, np.int8))
    m0 += len(iu)
    rows.append(m0 + np.arange(len(il))); cols.append(il); vals.append(np.ones(len(il)))
    L_.append(lower[il]); U_.append(np.full(len(il), np.inf)); W_.append(np.full(len(il), 1e3)); K_.append(np.full(len(il), 2, np.int8))
    m0 += len(il)
    sp_ = np.array(sep, int).reshape(-1, 2)
    rows.append(np.repeat(m0 + np.arange(len(sp_)), 2)); cols.append(sp_.ravel()); vals.append(np.tile([1.0, -1.0], len(sp_)))
    L_.append(np.full(len(sp_), SEP_RAIL)); U_.append(np.full(len(sp_), np.inf)); W_.append(np.full(len(sp_), 1e5)); K_.append(np.full(len(sp_), 3, np.int8))
    m0 += len(sp_)
    same2 = same[:-1] & same[1:] & Sm.main[1:-1]
    vi = np.where(same2)[0]
    km = step_g[vi + 1] ** 2 / Sm.rv[vi + 1]
    rows.append(np.repeat(m0 + np.arange(len(vi)), 3)); cols.append(np.stack([vi, vi + 1, vi + 2], 1).ravel()); vals.append(np.tile([1.0, -2.0, 1.0], len(vi)))
    L_.append(-km); U_.append(km); W_.append(np.full(len(vi), 1e7)); K_.append(np.full(len(vi), 4, np.int8))
    m0 += len(vi)
    C = sp.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(m0, N))
    Lb = np.concatenate(L_); Ub = np.concatenate(U_); Wc = np.concatenate(W_); KIND = np.concatenate(K_)
    is_grade = (KIND == 0) | (KIND == 4)
    act_lo = np.zeros(m0, bool); act_hi = np.zeros(m0, bool)

    def solve_act():
        act = act_lo | act_hi
        tgt = np.where(act_lo, Lb, Ub)
        Ca = C[act]; wa = Wc[act]
        return spl.spsolve((N0 + Ca.T @ sp.diags(wa) @ Ca).tocsc(), r0 + Ca.T @ (wa * tgt[act]))

    y = spl.spsolve(N0.tocsc(), r0)
    log(f'LS solve: {N} unknowns, {m0} inequalities ({len(gi)} grade, {len(vi)} vertical curve, {len(iu)} cover, {len(il)} clearance, {len(sp_)} separation), first solve {time.time() - t0:.0f} s')
    for rnd in range(maxrounds):
        cy = C @ y
        add_lo = (cy < Lb - 2e-3) & ~act_lo
        add_hi = (cy > Ub + 2e-3) & ~act_hi
        n_add = int(add_lo.sum() + add_hi.sum())
        if n_add == 0:
            break
        # anticipate grade chains: neighbours within 3 samples that are within 85 % of the same limit
        near_lo = np.zeros(m0, bool); near_hi = np.zeros(m0, bool)
        gl, gh = add_lo & is_grade, add_hi & is_grade
        for sh in (-3, -2, -1, 1, 2, 3):
            near_lo |= np.roll(gl, sh); near_hi |= np.roll(gh, sh)
        add_lo |= near_lo & is_grade & (cy < 0.85 * Lb) & ~act_lo
        add_hi |= near_hi & is_grade & (cy > 0.85 * Ub) & ~act_hi
        flip = (add_lo & act_hi) | (add_hi & act_lo)          # rows flipping sides are conflicts: freeze them where they are
        add_lo &= ~flip; add_hi &= ~flip
        if not (add_lo.any() or add_hi.any()):
            break
        act_lo |= add_lo; act_hi |= add_hi & ~act_lo
        y = solve_act()
        if rnd % 5 == 0:
            log(f'  round {rnd}: +{n_add} -> {int((act_lo | act_hi).sum())} active ({time.time() - t0:.0f} s)')
    # release over-satisfied once, then re-add anything that breaks
    cy = C @ y
    rel = (act_lo & (cy > Lb + 1e-4)) | (act_hi & (cy < Ub - 1e-4))
    if rel.any():
        act_lo &= ~rel; act_hi &= ~rel
        y = solve_act()
        for rnd in range(maxrounds):
            cy = C @ y
            add_lo = (cy < Lb - 2e-3) & ~act_lo
            add_hi = (cy > Ub + 2e-3) & ~act_hi
            if not (add_lo.any() or add_hi.any()):
                break
            act_lo |= add_lo; act_hi |= add_hi & ~act_lo
            y = solve_act()
    cy = C @ y
    viol = np.maximum(Lb - cy, cy - Ub)
    try:
        act = act_lo | act_hi
        # sample index per inequality row (grade rows: first sample; separations: upper track sample)
        samp = np.concatenate([gi, iu, il, sp_[:, 0] if len(sp_) else np.zeros(0, int), vi + 1])
        np.savez_compressed(os.path.join(RAW, 'cache', 'active_debug.npz'), act=act, kind=KIND, samp=samp, viol=viol, cy=cy, Lb=Lb, Ub=Ub)
    except Exception as e:
        log('active dump failed', e)
    names = ['grade', 'cover', 'clear', 'sep', 'vcurve']
    rep = []
    for kd in range(5):
        m = (KIND == kd) & (viol > 0.05)
        if m.any():
            rep.append(f'{names[kd]} {int(m.sum())} (worst {viol[m].max():.2f} m)')
    log('  inequalities violated by > 5 cm: ' + (', '.join(rep) or 'none') + f'; {int((act_lo | act_hi).sum())} active; solved in {time.time() - t0:.0f} s')
    return y


# ====================================================================== speed, cant, depth, segments
def plan_speed(tr):
    """Civil speed limit (m/s) per sample from the plan alone (curvature, OSM maxspeed, train-control codes) and the
    smoothed curvature it came from: (v, kap, R). Used by the profile (vertical curve radii) and by finish()."""
    p = tr['pub']
    x, z, step = p['x'], p['z'], p['step']
    # curvature for speed limits and cant from a 15 m-smoothed copy (single-node kinks in OSM are not curves), and
    # a restriction must be sustained: the limit is the 3rd-lowest curvature speed over 60 m, not the minimum
    sx = ndimage.gaussian_filter1d(x, max(1.0, 15.0 / step), mode='nearest')
    sz = ndimage.gaussian_filter1d(z, max(1.0, 15.0 / step), mode='nearest')
    win = max(1, int(round(20.0 / step)))
    kap = curvature(sx, sz, step, win)
    kap = ndimage.gaussian_filter1d(kap, max(1.0, 10.0 / step), mode='nearest')
    R = 1.0 / np.maximum(np.abs(kap), 1e-6)
    vmax = {'bart': 70 * MPH, 'ebart': 75 * MPH, 'oac': 30 * MPH}.get(tr['sys'], 70 * MPH)   # eBART 75 mph max, OAC 30 mph (research)
    # turnouts / crossovers / yards carry no cant: unbalanced lateral acceleration only
    a_lat = 1.40 if tr['service'] in (None, 'siding') else 0.65
    if tr['service'] == 'yard':
        vmax = min(vmax, 15 * MPH)
    v = np.minimum(vmax, np.sqrt(a_lat * R))
    # OSM maxspeed (mapped from BART's civil speed codes: 18 mph through the Oakland Wye, 36 at Balboa Park / Daly
    # City, 27 on the curve south of Daly City, ...) caps the geometric limit
    cap = np.full(len(v), np.inf)
    for i, t in enumerate(p['tags']):
        ms = t.get('maxspeed')
        if ms:
            try:
                val = float(str(ms).split()[0].split(';')[0])
                cap[i] = val * MPH if 'mph' in str(ms) else val / 3.6          # OSM: bare numbers are km/h
            except ValueError:
                pass
    v = np.minimum(v, cap)
    v = ndimage.minimum_filter1d(v, max(1, int(round(120.0 / step))), mode='nearest')
    if tr['sys'] == 'bart':        # BART's train control speed codes (mph)
        codes = np.array([6, 18, 27, 36, 50, 70]) * MPH
        v = np.array([codes[codes <= vv + 1e-6].max() if (codes <= vv + 1e-6).any() else codes[0] for vv in v])
    else:
        v = np.floor(v / MPH / 5.0) * 5.0 * MPH
        v = np.maximum(v, 10 * MPH)
    return v, kap, R


def finish(tracks, vcap=None):
    for tr in tracks:
        p = tr['pub']
        step = p['step']
        v, kap, R = plan_speed(tr)
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
def _run_dist(mask, st):
    """Distance (m) from each True sample to the nearest end of its run (1e9 outside runs)."""
    d = np.full(len(mask), 1e9)
    for (p_, q_, v_) in rle(mask.astype(np.uint8)):
        if v_:
            idx = np.arange(p_, q_); d[p_:q_] = np.minimum(idx - p_ + 0.5, q_ - 0.5 - idx) * st
    return d


def validate(tracks, stations, junctions, platform_groups):
    """Checks the lead asked for; returns (summary lines, report dict). Each finding: [track, s of the worst sample,
    worst value, number of samples]."""
    rep = {'platform_mismatch': [], 'grade': [], 'vcurve': [], 'buried_open': [], 'aerial_low': [], 'tunnel_shallow': [], 'junction': []}
    byid = {t['id']: t for t in tracks}

    def yat(tid, s):
        t = byid[tid]; p = t['pub']; f = np.clip(s / p['step'], 0, len(p['y']) - 1.000001); i = int(f); a = f - i
        return p['y'][i] * (1 - a) + p['y'][i + 1] * a

    def interior(mask, st, margin):
        d = np.zeros(len(mask))
        for a_, b_, c_ in rle(mask.astype(np.uint8)):
            if c_:
                ii = np.arange(a_, b_); d[a_:b_] = np.minimum(ii - a_, b_ - 1 - ii) * st
        return mask & (d > margin)

    for grp in platform_groups:
        mem = grp['members']
        if len(mem) < 2:
            continue
        worst = 0.0
        for f in np.linspace(0.05, 0.95, 10):
            ys = [yat(m[0], m[1] + f * (m[2] - m[1])) - (m[3] if len(m) > 3 else 0.0) for m in mem]
            worst = max(worst, max(ys) - min(ys))
        if worst > 0.05:
            rep['platform_mismatch'].append([grp['station'], round(float(worst), 2), [m[0] for m in mem]])
    for t in tracks:
        p = t['pub']; y = p['y']; st = p['step']; code = p['struct']
        if len(y) < 3:
            continue
        gr = np.diff(y) / st
        if t['service'] is None:
            lim = np.where(code[:-1] == S['tube'], TUBE_GMAX, OAC_GMAX if t['sys'] == 'oac' else G_MAX) + 0.001
            bad = np.where(np.abs(gr) > lim)[0]
            if len(bad):
                k = bad[int(np.abs(gr[bad]).argmax())]
                rep['grade'].append([t['id'], round(float(k * st), 1), round(float(gr[k]) * 100, 2), int(len(bad))])
            # vertical curves: R >= 800 m and <= 0.05 g at the civil speed limit (the solver's hard constraint)
            d2 = (y[:-2] - 2 * y[1:-1] + y[2:]) / st ** 2
            vl = p.get('vlim', np.full(len(y), 70 * MPH))[1:-1]
            rmin = np.maximum(R_V_MIN, vl ** 2 / AV_MAX)
            ratio = np.abs(d2) * rmin                  # > 1: tighter than allowed
            bad = np.where(ratio > 1.02)[0]
            if len(bad):
                k = bad[int(ratio[bad].argmax())]
                rep['vcurve'].append([t['id'], round(float((k + 1) * st), 1), round(float(1 / abs(d2[k])), 0), int(len(bad)), round(float(rmin[k]), 0)])
        g = p['g']; src = p.get('gsrc', np.ones(len(y)))
        grob = ndimage.median_filter(g, size=13, mode='nearest') if len(g) > 13 else g     # overpass decks kept in bare earth
        # the bare-earth lidar keeps some road decks: skip the track under every street/railway that crosses over it
        deck = np.zeros(len(y), bool)
        for c_ in t.get('crossings', []):
            if c_[3] == 'over' and c_[1] in ('road', 'rail'):
                half = 0.5 * c_[4] / max(0.3, math.sin(math.radians(c_[5]))) + 10.0
                deck[max(0, int((c_[0] - half) / st)):int((c_[0] + half) / st) + 2] = True
        op = interior(np.isin(code, list(OPEN)), st, 30.0) & (src == 1) & ~deck
        dep = np.where(op, grob - y, -1e9)
        bad = np.where(dep > 1.0)[0]
        if len(bad):
            k = bad[int(dep[bad].argmax())]
            rep['buried_open'].append([t['id'], round(float(k * st), 1), round(float(dep[k]), 2), int(len(bad))])
        # aerial clearance: 5 m, less near an abutment where the deck comes down to the fill (the solver's 1 m + 3 %/m)
        d_aer = _run_dist(code == S['aerial'], st)
        req = np.minimum(5.0, 1.0 + d_aer * RAMP) - 0.5
        cl = np.where(code == S['aerial'], y - g, 1e9)
        bad = np.where(cl < req)[0]
        if len(bad):
            k = bad[int((cl[bad] - req[bad]).argmin())]
            rep['aerial_low'].append([t['id'], round(float(k * st), 1), round(float(cl[k]), 2), int(len(bad))])
        # tunnel cover: ~6 m from top of rail to the street for a cut-and-cover box, ramping in from the OSM tunnel start
        # at 3 %/m like the solver (portal approaches / lids); flags what the solve could not meet
        und = np.isin(code, [S['portal'], S['cutcover'], S['bored'], S['tube']])
        d_und = _run_dist(und, st)
        req = np.minimum(6.0, FACE_COVER + d_und * RAMP) - 0.5
        gsm = ndimage.gaussian_filter1d(g, max(1.0, 10.0 / st), mode='nearest')
        cv = np.where(und, gsm - y, 1e9)
        bad = np.where(cv < req)[0]
        if len(bad):
            k = bad[int((cv[bad] - req[bad]).argmin())]
            rep['tunnel_shallow'].append([t['id'], round(float(k * st), 1), round(float(cv[k]), 2), int(len(bad))])
    for j in junctions:
        ys = [yat(t, s) for t, s in j['tracks'] if t in byid]
        if ys and max(ys) - min(ys) > 0.05:
            rep['junction'].append([j['id'], round(float(max(ys) - min(ys)), 2)])

    def line(name, key, fmt):
        L = rep[key]
        return f'  {name}: {len(L)}' + (f' (worst {fmt(L)})' if L else '')
    lines = ['profile validator:',
             line('platform rail mismatch > 5 cm (inner 90 %)', 'platform_mismatch', lambda L: max(L, key=lambda r: r[1])),
             line('main tracks with grade > 4 % (3 % in the Tube, 6.5 % on the airport connector)', 'grade', lambda L: max(L, key=lambda r: abs(r[2]))),
             line('main tracks with vertical curves under 800 m or over 0.05 g at the speed limit', 'vcurve', lambda L: min(L, key=lambda r: r[2] / r[4])),
             line('open track > 1 m below the lidar ground (not under a crossing street)', 'buried_open', lambda L: max(L, key=lambda r: r[2])),
             line('aerial track below 5 m clearance (less within 130 m of an abutment)', 'aerial_low', lambda L: min(L, key=lambda r: r[2])),
             line('tunnels with less than 6 m cover (ramping in 3 %/m from the tunnel start)', 'tunnel_shallow', lambda L: min(L, key=lambda r: r[2])),
             line('junction height mismatch > 5 cm', 'junction', lambda L: max(L, key=lambda r: r[1]))]
    return lines, rep


# ====================================================================== third rail side
def third_rail(tracks, junctions, platforms):
    """Per-sample contact (third) rail side: 1 = left, 2 = right (facing +s), 0 = none (gaps ~12 m either side of a
    turnout / crossing). Rules (BART practice; the Transbay Tube check: outer side, away from the gallery walkway):
      - along a platform: the side away from the platform edge (island stations -> outside, side-platform stations ->
        between the tracks), extended 60 m past each platform end, then
      - double track: the field side, away from the nearest parallel track within 8 m,
      - single track: the right side.
    Changes of side happen where these rules change (real BART changes sides at stations and turnouts too)."""
    from scipy.spatial import cKDTree
    allxz = np.concatenate([np.stack([t['pub']['x'], t['pub']['z']], 1) for t in tracks])
    owner = np.concatenate([np.full(len(t['pub']['x']), k) for k, t in enumerate(tracks)])
    kd = cKDTree(allxz)
    by_id = {t['id']: k for k, t in enumerate(tracks)}
    jpos = {}
    for j in junctions:
        for tid_, s_ in j['tracks']:
            jpos.setdefault(tid_, []).append(s_)
    plat_on = {}
    for pl in platforms.values():
        plat_on.setdefault(pl['track'], []).append((pl['s0'] - 60.0, pl['s1'] + 60.0, pl['side']))
    for k, tr in enumerate(tracks):
        p = tr['pub']
        n = len(p['x'])
        x, z = p['x'], p['z']
        gx = np.gradient(x); gz = np.gradient(z); L = np.hypot(gx, gz) + 1e-12; gx /= L; gz /= L
        side = np.full(n, 2, np.uint8)                        # right by default
        lists = kd.query_ball_point(np.stack([x, z], 1), 8.0)
        for i, lst in enumerate(lists):
            best = None
            for q in lst:
                if owner[q] == k:
                    continue
                lat = (allxz[q, 0] - x[i]) * (-gz[i]) + (allxz[q, 1] - z[i]) * gx[i]
                if abs(lat) > 2.5 and (best is None or abs(lat) < abs(best)):
                    best = lat
            if best is not None:
                side[i] = 1 if best > 0 else 2                 # neighbour on the right -> rail on the left (field side)
        for (a, b, sd) in plat_on.get(tr['id'], []):
            i0, i1 = max(0, int(a / p['step'])), min(n, int(b / p['step']) + 1)
            side[i0:i1] = 1 if sd > 0 else 2                   # platform on the right -> rail on the left
        for s_ in jpos.get(tr['id'], []):
            i0, i1 = max(0, int((s_ - 12.0) / p['step'])), min(n, int((s_ + 12.0) / p['step']) + 1)
            side[i0:i1] = 0
        if tr['sys'] != 'bart':
            side[:] = 0                                         # eBART diesel, cable-hauled connector: no contact rail
        p['third'] = side
