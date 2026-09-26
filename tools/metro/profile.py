"""Structure classification, vertical profile, civil speed limits and cant for the metro tracks.

v0 (M1): structure from OSM tags (tunnel/bridge/cutting/embankment) + zones (Transbay Tube, Berkeley Hills Tunnel);
heights = ground (terrarium z15) + a per-structure target offset, then a 4 % grade clamp and smoothing. Replaced by
the constrained solve in M2 (see notes/bart-data.md, "Vertical profile").
"""
import math
import numpy as np
from scipy import ndimage
from metro.common import MPH, curvature, log, w2ll

STRUCT_NAMES = ['grade', 'aerial', 'bridge', 'embankment', 'trench', 'median', 'portal', 'cutcover', 'bored', 'tube']
S = {n: i for i, n in enumerate(STRUCT_NAMES)}
UNDERGROUND = {S['cutcover'], S['bored'], S['tube']}

G_MAX = 0.04                  # BART design maximum grade (4 %)
A_LAT = 1.40                  # m/s^2 total lateral (cant + unbalanced), ~ Ea+Eu = 9 in
VMAX = {'bart': 70 * MPH, 'ebart': 70 * MPH, 'oac': 31 * MPH}
V_SERVICE = {'yard': 10 * MPH, 'crossover': 27 * MPH, 'siding': 27 * MPH, 'spur': 15 * MPH}
RAIL_CC = 1.75                # m, rail head centres (for cant)


def in_box(lat, lon, box):
    la0, lo0, la1, lo1 = box
    return (lat >= la0) & (lat <= la1) & (lon >= lo0) & (lon <= lo1)


BERKELEY_HILLS = (37.845, -122.245, 37.880, -122.186)       # Rockridge east portal .. Orinda west portal
TRANSBAY = (37.795, -122.392, 37.815, -122.300)


def classify(tr, g):
    p = tr['pub']
    n = len(p['s'])
    code = np.zeros(n, np.uint8)
    lat, lon = w2ll(p['x'], p['z'])
    for i, t in enumerate(p['tags']):
        tun = t.get('tunnel') in ('yes', 'building_passage', 'avalanche_protector') or t.get('location') == 'underground'
        br = t.get('bridge') not in (None, 'no')
        if tun:
            code[i] = S['cutcover']
        elif br:
            code[i] = S['aerial']
        elif t.get('cutting') in ('yes', 'hollow'):
            code[i] = S['trench']
        elif t.get('embankment') == 'yes':
            code[i] = S['embankment']
        else:
            code[i] = S['grade']
    und = code == S['cutcover']
    code[und & in_box(lat, lon, BERKELEY_HILLS)] = S['bored']
    code[und & in_box(lat, lon, TRANSBAY) & (g < -1.0)] = S['tube']
    # tube run: extend the tube code over the whole contiguous underground run that touches water
    # short bridges (< 90 m) over water/creeks/roads outside long aerial runs: 'bridge'
    runs = rle(code)
    for a, b, c in runs:
        if c == S['aerial'] and (p['s'][b - 1] - p['s'][a]) < 90:
            code[a:b] = S['bridge']
    # portals: 35 m of the underground run next to open air
    runs = rle(code)
    k = max(1, int(round(35 / p['step'])))
    for idx, (a, b, c) in enumerate(runs):
        if c in UNDERGROUND and c != S['tube']:
            if idx > 0 and runs[idx - 1][2] not in UNDERGROUND:
                code[a:min(b, a + k)] = S['portal']
            if idx < len(runs) - 1 and runs[idx + 1][2] not in UNDERGROUND:
                code[max(a, b - k):b] = S['portal']
    return code


def rle(code):
    out = []
    a = 0
    for i in range(1, len(code) + 1):
        if i == len(code) or code[i] != code[a]:
            out.append((a, i, int(code[a])))
            a = i
    return out


def solve(tracks, G, elev):
    for tr in tracks:
        p = tr['pub']
        x, z, step = p['x'], p['z'], p['step']
        g = elev.ground(x, z).astype(np.float64)
        code = classify(tr, g)
        tgt = g + 0.5
        tgt = np.where(code == S['aerial'], g + 10.0, tgt)
        tgt = np.where(code == S['bridge'], g + 5.0, tgt)
        tgt = np.where(code == S['embankment'], g + 2.0, tgt)
        tgt = np.where(code == S['trench'], g - 6.0, tgt)
        tgt = np.where(code == S['portal'], g - 4.0, tgt)
        tgt = np.where(code == S['cutcover'], g - 13.0, tgt)
        tgt = np.where(code == S['bored'], g - 30.0, tgt)
        tgt = np.where(code == S['tube'], np.minimum(g - 6.0, -8.0), tgt)
        y = ndimage.gaussian_filter1d(tgt, max(1.0, 25.0 / step), mode='nearest')
        gm = G_MAX * step
        for _ in range(4):
            for i in range(1, len(y)):
                if y[i] > y[i - 1] + gm: y[i] = y[i - 1] + gm
                elif y[i] < y[i - 1] - gm: y[i] = y[i - 1] - gm
            for i in range(len(y) - 2, -1, -1):
                if y[i] > y[i + 1] + gm: y[i] = y[i + 1] + gm
                elif y[i] < y[i + 1] - gm: y[i] = y[i + 1] - gm
        y = ndimage.gaussian_filter1d(y, max(1.0, 10.0 / step), mode='nearest')
        # curvature -> speed limits, cant
        win = max(1, int(round(15.0 / step)))
        kap = curvature(x, z, step, win)
        kap = ndimage.gaussian_filter1d(kap, max(1.0, 10.0 / step), mode='nearest')
        R = 1.0 / np.maximum(np.abs(kap), 1e-6)
        vmax = VMAX.get(tr['sys'], 70 * MPH)
        if tr['service'] in V_SERVICE:
            vmax = min(vmax, V_SERVICE[tr['service']])
        v = np.minimum(vmax, np.sqrt(A_LAT * R))
        # speed limits change in 5 mph steps and hold over the whole curve (min over +-60 m)
        v = ndimage.minimum_filter1d(v, max(1, int(round(120.0 / step))), mode='nearest')
        v = np.floor(v / MPH / 5.0) * 5.0 * MPH
        v = np.maximum(v, 10 * MPH)
        cant = np.clip(RAIL_CC * v * v / (9.81 * R) - 0.075, 0.0, 0.15) * np.sign(kap)   # + = outer rail on the left (curve to the right)
        cant = ndimage.gaussian_filter1d(cant, max(1.0, 20.0 / step), mode='nearest')
        depth = np.where(np.isin(code, list(UNDERGROUND) + [S['portal']]), g - y, np.where(np.isin(code, [S['aerial'], S['bridge']]), y - g, 0.0))
        p.update(y=y, g=g, struct=code, vlim=v, cant=cant, depth=np.clip(depth, 0, 255), curv=kap)
        # structure segments [s0, s1, name]
        segs = []
        for a, b, c in rle(code):
            s0 = float(p['s'][a]); s1 = float(p['s'][min(b, len(p['s']) - 1)])
            segs.append([round(s0, 1), round(s1, 1), STRUCT_NAMES[c]])
        p['segments'] = segs
    log('profile v0 solved for', len(tracks), 'tracks')
