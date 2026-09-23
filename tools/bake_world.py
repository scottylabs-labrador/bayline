#!/usr/bin/env python3
"""Bake the world: terrain heightmap + land masks (data/baked/terrain.bin) and the railway
alignment with its features (data/baked/track.bin + data/baked/track.json).

Inputs: data/raw/dem (Terrarium z11 tiles), data/raw/rail/rail.json (OSM), data/baked/corridor.json (GTFS).
"""
import json, math, os, struct, zlib, sys
import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import dem

LAT0, LON0, MLAT, MLON = 37.40, -122.10, 110985.1, 88542.2
def ll2w(lat, lon): return (np.asarray(lon) - LON0) * MLON, -(np.asarray(lat) - LAT0) * MLAT
def w2ll(x, z): return LAT0 - np.asarray(z) / MLAT, LON0 + np.asarray(x) / MLON

# ------------------------------------------------------------------ terrain grid
N, S = 1600, 64.0
X0, Z0 = -45056.0, -49152.0
gx = X0 + np.arange(N) * S; gz = Z0 + np.arange(N) * S
GX, GZ = np.meshgrid(gx, gz)                      # [row=z, col=x]
lat, lon = w2ll(GX, GZ)
H = dem.sample(lat, lon).astype(np.float32)
H = np.maximum(H, -25.0)
H[np.isnan(H)] = 0
print('terrain grid', H.shape, 'range', H.min(), H.max())

def hsample(x, z):
    """Bilinear sample of the (current) grid at world coords (arrays ok)."""
    fx = (np.asarray(x) - X0) / S; fz = (np.asarray(z) - Z0) / S
    fx = np.clip(fx, 0, N - 1.001); fz = np.clip(fz, 0, N - 1.001)
    i = np.floor(fx).astype(int); j = np.floor(fz).astype(int); tx = fx - i; tz = fz - j
    return (H[j, i] * (1 - tx) * (1 - tz) + H[j, i + 1] * tx * (1 - tz) + H[j + 1, i] * (1 - tx) * tz + H[j + 1, i + 1] * tx * tz)

# ------------------------------------------------------------------ railway alignment
cor = json.load(open(os.path.join(ROOT, 'data/baked/corridor.json')))
osm = json.load(open(os.path.join(ROOT, 'data/raw/rail/rail.json')))['elements']

def to_w(pts): x, z = ll2w([p[0] for p in pts], [p[1] for p in pts]); return np.stack([x, z], 1)
main = to_w(cor['mainline']['pts']); south = to_w(cor['southCounty']['pts'])
# join: mainline SF->Tamien, then the South County shape from the point nearest the mainline end
d = np.hypot(*(south - main[-1]).T); k = int(np.argmin(d))
guide = np.concatenate([main, south[k + 1:]], 0)

def resample(poly, step):
    seg = np.hypot(*np.diff(poly, axis=0).T); s = np.concatenate([[0], np.cumsum(seg)])
    t = np.arange(0, s[-1], step); t = np.append(t, s[-1]) if s[-1] - t[-1] > step * 0.3 else t
    return np.stack([np.interp(t, s, poly[:, 0]), np.interp(t, s, poly[:, 1])], 1), t

def tangents(p):
    t = np.gradient(p, axis=0); n = np.hypot(*t.T)[:, None]; return t / np.maximum(n, 1e-9)

# OSM main-line track segments (both operators' main tracks; sidings separately for extra tracks)
tracks = []; sidings = []
for e in osm:
    if e['type'] != 'way': continue
    t = e.get('tags', {})
    if t.get('railway') != 'rail': continue
    g = e.get('geometry') or []
    if len(g) < 2: continue
    pw = to_w([(q['lat'], q['lon']) for q in g])
    if t.get('usage') == 'main' and not t.get('service'): tracks.append((pw, t))
    elif t.get('service') in ('siding',) : sidings.append((pw, t))
segs = []; seg_meta = []
for pw, t in tracks:
    for a, b in zip(pw[:-1], pw[1:]):
        segs.append((a[0], a[1], b[0], b[1])); seg_meta.append(t)
segs = np.array(segs)
print('osm main segments', len(segs), 'sidings', len(sidings))
CELL = 100.0
grid = {}
for i, (ax, az, bx, bz) in enumerate(segs):
    for cx in range(int(math.floor(min(ax, bx) / CELL)), int(math.floor(max(ax, bx) / CELL)) + 1):
        for cz in range(int(math.floor(min(az, bz) / CELL)), int(math.floor(max(az, bz) / CELL)) + 1):
            grid.setdefault((cx, cz), []).append(i)

def cross_offsets(p, tng, reach=26.0, segarr=segs, sgrid=grid):
    """Offsets t along the normal of p where parallel main tracks cross it."""
    nrm = np.array([-tng[1], tng[0]])   # left normal in the x-z plane
    cand = set()
    for cx in range(int(math.floor((p[0] - reach) / CELL)), int(math.floor((p[0] + reach) / CELL)) + 1):
        for cz in range(int(math.floor((p[1] - reach) / CELL)), int(math.floor((p[1] + reach) / CELL)) + 1):
            cand.update(sgrid.get((cx, cz), ()))
    out = []
    for i in cand:
        ax, az, bx, bz = segarr[i]; dx, dz = bx - ax, bz - az; L = math.hypot(dx, dz)
        if L < 1e-6: continue
        if abs((dx * tng[0] + dz * tng[1]) / L) < 0.9: continue
        den = nrm[0] * (-dz) - nrm[1] * (-dx)
        if abs(den) < 1e-9: continue
        rx, rz = ax - p[0], az - p[1]
        tt = (rx * (-dz) - rz * (-dx)) / den; u = (nrm[0] * rz - nrm[1] * rx) / den
        if 0 <= u <= 1 and abs(tt) <= reach: out.append(tt)
    return sorted(out)

line = guide
for it in range(3):
    pts, _ = resample(line, 10.0); tg = tangents(pts)
    mids = np.full(len(pts), np.nan)
    for i, (p, t) in enumerate(zip(pts, tg)):
        o = cross_offsets(p, t)
        if o: mids[i] = 0.5 * (o[0] + o[-1]) if (o[-1] - o[0]) < 16 else (o[0] if abs(o[0]) < abs(o[-1]) else o[-1])
    have = ~np.isnan(mids)
    print(f'snap pass {it}: {have.mean()*100:.1f}% of samples matched OSM tracks; mean |offset| {np.nanmean(np.abs(mids)):.2f} m')
    idx = np.arange(len(pts)); m = np.interp(idx, idx[have], mids[have])
    m = ndimage.gaussian_filter1d(m, 4.0)          # 40 m smoothing of the lateral correction
    nrm = np.stack([-tg[:, 1], tg[:, 0]], 1)
    line = pts + nrm * m[:, None]
    line[:, 0] = ndimage.gaussian_filter1d(line[:, 0], 1.5); line[:, 1] = ndimage.gaussian_filter1d(line[:, 1], 1.5)

STEP = 5.0
P, sarr = resample(line, STEP); T = tangents(P); NRM = np.stack([-T[:, 1], T[:, 0]], 1)
L = sarr[-1]; n = len(P)
print(f'final alignment: {L/1000:.2f} km, {n} samples at {STEP} m')

# track offsets (left-normal positive) per sample: detect main + sidings
alltracks = segs
ofs = []
sid_segs = []
for pw, t in sidings:
    for a, b in zip(pw[:-1], pw[1:]): sid_segs.append((a[0], a[1], b[0], b[1]))
sid_segs = np.array(sid_segs) if sid_segs else np.zeros((0, 4))
sgrid2 = {}
for i, (ax, az, bx, bz) in enumerate(sid_segs):
    for cx in range(int(math.floor(min(ax, bx) / CELL)), int(math.floor(max(ax, bx) / CELL)) + 1):
        for cz in range(int(math.floor(min(az, bz) / CELL)), int(math.floor(max(az, bz) / CELL)) + 1):
            sgrid2.setdefault((cx, cz), []).append(i)
cnt = np.zeros(n, np.int8); offs = np.zeros((n, 4), np.float32)
for i in range(0, n, 2):
    o = cross_offsets(P[i], T[i], 14.0) + (cross_offsets(P[i], T[i], 14.0, sid_segs, sgrid2) if len(sid_segs) else [])
    o = sorted(set(round(v, 1) for v in o))
    merged = []
    for v in o:
        if not merged or v - merged[-1] > 3.0: merged.append(v)
    merged = merged[:4]
    for j in (i, min(i + 1, n - 1)):
        cnt[j] = len(merged); offs[j, :len(merged)] = merged

# ------------------------------------------------------------------ features along s
def project(xz, maxd=40.0):
    d = np.hypot(P[:, 0] - xz[0], P[:, 1] - xz[1]); i = int(np.argmin(d))
    if d[i] > maxd: return None
    lat_off = float(np.dot(np.array(xz) - P[i], NRM[i]))
    return float(sarr[i]), lat_off, float(d[i])

def ranges_from_ways(pred, maxd=25.0):
    out = []
    for e in osm:
        if e['type'] != 'way': continue
        t = e.get('tags', {})
        if t.get('railway') != 'rail' or not pred(t): continue
        g = e.get('geometry') or []
        ss = [project(ll2w(q['lat'], q['lon']), maxd) for q in g]
        ss = [q[0] for q in ss if q]
        if len(ss) >= 2: out.append([min(ss), max(ss)])
    out.sort(); merged = []
    for a, b in out:
        if merged and a <= merged[-1][1] + 15: merged[-1][1] = max(merged[-1][1], b)
        else: merged.append([a, b])
    return merged

tunnels = [r for r in ranges_from_ways(lambda t: t.get('tunnel') in ('yes',) and t.get('usage') == 'main') if r[1] - r[0] > 40]
bridges = [r for r in ranges_from_ways(lambda t: bool(t.get('bridge')) and t.get('usage') == 'main') if r[1] - r[0] > 6]
electric = ranges_from_ways(lambda t: t.get('electrified') == 'contact_line' and t.get('usage') == 'main', 30)
print('tunnels', [(round(a), round(b - a)) for a, b in tunnels])
print('bridges', len(bridges), 'electrified', [(round(a), round(b)) for a, b in electric][:6], '...')

# ------------------------------------------------------------------ elevation profile
ground = hsample(P[:, 0], P[:, 1])
band = np.min(np.stack([hsample(P[:, 0] + NRM[:, 0] * o, P[:, 1] + NRM[:, 1] * o) for o in (-30, -15, 0, 15, 30)]), 0)
prof = np.minimum(ground, band + 2.0)
inside = lambda rs, s: any(a <= s <= b for a, b in rs)
# tunnels: straight grade between portals (use band min just outside)
for a, b in tunnels:
    i0 = max(0, int(a / STEP) - 4); i1 = min(n - 1, int(b / STEP) + 4)
    prof[i0:i1 + 1] = np.linspace(prof[i0], prof[i1], i1 - i0 + 1)
# bridges over streets/creeks: keep the track up (at least 6.5 m over the lowest ground under the span), ramp 250 m
lift = np.zeros(n)
for a, b in bridges:
    i0 = int(a / STEP); i1 = int(b / STEP) + 1
    need = max(0.0, (np.max(prof[max(0, i0 - 30):i1 + 30]) if b - a < 60 else np.max(prof[i0:i1 + 1])) - np.min(ground[i0:i1 + 1]))
    top = np.min(ground[i0:i1 + 1]) + (6.5 if b - a < 80 else 3.0)
    for i in range(max(0, i0 - 50), min(n, i1 + 50)):
        w = 1.0 if i0 <= i <= i1 else max(0.0, 1 - (min(abs(i - i0), abs(i - i1)) / 50.0))
        lift[i] = max(lift[i], (top - prof[i]) * w)
prof = prof + np.maximum(lift, 0)
prof = ndimage.gaussian_filter1d(prof, 20.0)        # ~100 m smoothing
G = 0.021                                           # max grade 2.1 %
for _ in range(3):
    for i in range(1, n): prof[i] = min(prof[i], prof[i - 1] + G * STEP) if prof[i] > prof[i - 1] else max(prof[i], prof[i - 1] - G * STEP)
    for i in range(n - 2, -1, -1): prof[i] = min(prof[i], prof[i + 1] + G * STEP) if prof[i] > prof[i + 1] else max(prof[i], prof[i + 1] - G * STEP)
prof = ndimage.gaussian_filter1d(prof, 6.0)
prof = np.maximum(prof, 1.2)                        # never below high tide near the bay
Y = prof.astype(np.float32) + 0.6                   # top of rail = bed + ballast/sleeper/rail height
print('profile: min', Y.min(), 'max', Y.max(), 'max grade', np.max(np.abs(np.diff(Y))) / STEP)

# ------------------------------------------------------------------ carve terrain around the trackbed
from scipy.spatial import cKDTree
tree = cKDTree(P)
dist, near = tree.query(np.stack([GX.ravel(), GZ.ravel()], 1), distance_upper_bound=140)
dist = dist.reshape(H.shape); near = near.reshape(H.shape)
ok = np.isfinite(dist)
ntun = np.zeros(n, bool)
for a, b in tunnels: ntun[max(0, int(a / STEP) - 2):min(n, int(b / STEP) + 3)] = True
bed = np.zeros_like(H); bed[ok] = Y[np.clip(near[ok], 0, n - 1)] - 1.0
tunnelcell = np.zeros_like(ok); tunnelcell[ok] = ntun[np.clip(near[ok], 0, n - 1)]
w = np.zeros_like(H); w[ok] = np.clip(1 - (dist[ok] - 45) / 95, 0, 1)    # full within 45 m, fades out by 140 m
cut = ok & ~tunnelcell & (H > bed)
H[cut] = H[cut] - (H[cut] - bed[cut]) * w[cut]
fill = ok & ~tunnelcell & (H < bed - 0.0) & (dist < 70)
H[fill] = H[fill] + (bed[fill] - 1.5 - H[fill]).clip(min=0) * (w[fill] * 0.6)
print('carved cells', int(cut.sum()), 'raised cells', int(fill.sum()))

# ------------------------------------------------------------------ masks
water_c = H < 0.15
lab, nl = ndimage.label(water_c)
seeds = [(37.60, -122.25), (37.49, -122.10), (37.70, -122.56), (37.80, -122.36), (37.46, -122.03)]
keep = set()
for la, lo in seeds:
    x, z = ll2w(la, lo); i = int(round((x - X0) / S)); j = int(round((z - Z0) / S))
    if 0 <= i < N and 0 <= j < N and lab[j, i]: keep.add(int(lab[j, i]))
water = np.isin(lab, list(keep))
# reservoirs/lakes: perfectly flat patches away from the baylands
mx = ndimage.maximum_filter(H, 5); mn = ndimage.minimum_filter(H, 5)
distbay = ndimage.distance_transform_edt(~water) * S
flat = (mx - mn < 0.25) & (H > 4) & ~((H < 7) & (distbay < 3500))
lab2, nl2 = ndimage.label(flat)
sizes = ndimage.sum(flat, lab2, range(1, nl2 + 1))
lakes = np.isin(lab2, [i + 1 for i, s_ in enumerate(sizes) if s_ >= 25])
lakes = ndimage.binary_dilation(lakes, iterations=1) & (H - ndimage.minimum_filter(H, 3) < 1.0)
ponds = (~water) & (H > -0.5) & (H < 2.3) & (distbay < 2600) & ((mx - mn) < 0.9)
ax_, az_ = ll2w(37.4265, -121.9745)
ponds &= np.hypot(GX - ax_, GZ - az_) > 800             # Alviso village is low but it is land
ponds &= (lon > -122.42) & (lat > 37.30) & (lat < 37.80)  # salt ponds only ring the Bay, not the ocean coast
wet = water | lakes
marsh = (~wet) & (~ponds) & (H < 3.2) & (distbay < 1500)
slope = np.hypot(*np.gradient(H, S))
urban = ((H < 110).astype(np.float32) * np.clip(1 - (slope - 0.05) / 0.07, 0, 1))
latg = lat
sf = (latg > 37.705) & (lon > -122.52)
urban[sf] = np.clip(1 - (H[sf] - 160) / 90, 0, 1)
urban *= np.clip(1 - (H - 70) / 90, 0.2, 1) * (H < 260)
south = latg < 3723.5e-2
towns = np.zeros_like(urban)
for (la, lo, r) in [(37.130, -121.652, 2600), (37.087, -121.604, 900), (37.005, -121.575, 3600), (37.235, -121.78, 1500)]:
    x, z = ll2w(la, lo); towns = np.maximum(towns, np.clip(1 - (np.hypot(GX - x, GZ - z) - r) / 900, 0, 1))
farm = np.zeros_like(urban)
farm[south] = ((1 - towns[south]) * (slope[south] < 0.05) * (H[south] < 160)).astype(np.float32)
urban[south] = urban[south] * towns[south]
# known open spaces on flat land
def zero_circle(la, lo, r):
    x, z = ll2w(la, lo); d = np.hypot(GX - x, GZ - z); urban[d < r] *= np.clip((d[d < r] - r * 0.7) / (r * 0.3), 0, 1)
for la, lo, r in [(37.6155, -122.382, 2300), (37.4155, -122.051, 1300), (37.431, -122.086, 800), (37.456, -122.105, 1100),
                  (37.590, -122.321, 450), (37.7694, -122.4862, 1300), (37.7700, -122.4600, 700), (37.7175, -122.4190, 650),
                  (37.7985, -122.4660, 1400), (37.7280, -122.4910, 900), (37.4300, -122.1700, 500), (37.3625, -121.9290, 1200),
                  (37.4050, -121.9690, 350), (37.2300, -121.7600, 2200), (37.3940, -122.0600, 500), (37.5300, -122.2500, 450)]:
    zero_circle(la, lo, r)
urban[wet | ponds | marsh] = 0
urban = ndimage.gaussian_filter(urban, 1.0)
def u8(a): return np.clip(np.round(a * 255), 0, 255).astype(np.uint8)
waterf = ndimage.gaussian_filter(wet.astype(np.float32), 0.7)
mask = np.stack([u8(waterf), u8(urban), u8(ndimage.gaussian_filter(ponds.astype(np.float32), 0.6)),
                 u8(np.maximum(farm, marsh.astype(np.float32) * 0.5 * 0) + marsh.astype(np.float32) * 0)], -1)
mask[..., 3] = u8(np.clip(farm, 0, 1)) // 2 + u8(marsh.astype(np.float32)) // 2 * 0 + (marsh.astype(np.uint8) * 1)
# channel A: 0..127 farmland amount, 128..255 flag marsh
mask[..., 3] = np.where(marsh, 200, u8(np.clip(farm, 0, 1)) // 2)
print('water %.1f%%  lakes %.2f%%  ponds %.2f%%  marsh %.2f%%  urban>0.5 %.1f%%' % (wet.mean() * 100, lakes.mean() * 100, ponds.mean() * 100, marsh.mean() * 100, (urban > 0.5).mean() * 100))
# water surfaces: flatten lakes to their median level, bay/ocean to 0
H[water] = np.minimum(H[water], -0.5)

# ------------------------------------------------------------------ encode terrain
q = np.round((H + 30.0) / 0.25).astype(np.int32)            # 0.25 m units, offset 30 m
a = np.zeros_like(q); b = np.zeros_like(q); c = np.zeros_like(q)
a[:, 1:] = q[:, :-1]; b[1:, :] = q[:-1, :]; c[1:, 1:] = q[:-1, :-1]
a[:, 0] = b[:, 0]; c[:, 0] = b[:, 0]; c[0, :] = a[0, :]; b[0, :] = a[0, :]
mxab = np.maximum(a, b); mnab = np.minimum(a, b)
pred = np.where(c >= mxab, mnab, np.where(c <= mnab, mxab, a + b - c)); pred[0, 0] = 0
res = (q - pred).astype(np.int32)
zz = ((res << 1) ^ (res >> 31)).astype(np.uint32)            # zigzag
lo_b = (zz & 0xFF).astype(np.uint8); hi_b = ((zz >> 8) & 0xFF).astype(np.uint8)
assert (zz < 65536).all()
hdr = struct.pack('<4sIffff', b'BLT1', N, S, X0, Z0, 0.25) + struct.pack('<f', -30.0)
blob = hdr + lo_b.tobytes() + hi_b.tobytes() + mask.tobytes()
comp = zlib.compress(blob, 9)
open(os.path.join(ROOT, 'data/baked/terrain.bin'), 'wb').write(comp)
print(f'terrain.bin: raw {len(blob)/1e6:.2f} MB -> {len(comp)/1e6:.2f} MB')

# ------------------------------------------------------------------ track outputs
stations = []
for st in cor['stations']:
    pr = project(ll2w(st['lat'], st['lon']), 200)
    stations.append({'id': st['id'], 'name': st['name'], 'lat': st['lat'], 'lon': st['lon'], 's': round(pr[0], 1), 'off': round(pr[1], 1)})
stations.sort(key=lambda s_: s_['s'])
plats = []
for e in osm:
    t = e.get('tags', {})
    if e['type'] != 'way' or not (t.get('railway') == 'platform' or t.get('public_transport') == 'platform'): continue
    g = e.get('geometry') or []
    pr = [project(ll2w(q['lat'], q['lon']), 45) for q in g]
    pr = [p for p in pr if p]
    if len(pr) < 2: continue
    ss = [p[0] for p in pr]; oo = [p[1] for p in pr]
    if max(ss) - min(ss) < 60: continue
    plats.append({'s0': round(min(ss), 1), 's1': round(max(ss), 1), 'off': round(float(np.median(oo)), 1), 'ref': t.get('ref'), 'closed': 'area' in t})
crossings = []
for e in osm:
    t = e.get('tags', {})
    if e['type'] == 'node' and t.get('railway') == 'level_crossing':
        pr = project(ll2w(e['lat'], e['lon']), 14)
        if pr and not inside(tunnels, pr[0]): crossings.append({'s': round(pr[0], 1), 'gates': t.get('crossing:barrier', 'full' if True else '')})
crossings.sort(key=lambda c_: c_['s']); cr2 = []
for c_ in crossings:
    if not cr2 or c_['s'] - cr2[-1]['s'] > 25: cr2.append(c_)
signals = []
for e in osm:
    t = e.get('tags', {})
    if e['type'] == 'node' and t.get('railway') == 'signal':
        pr = project(ll2w(e['lat'], e['lon']), 12)
        if pr: signals.append({'s': round(pr[0], 1), 'off': round(pr[1], 1), 'dir': t.get('railway:signal:direction', '')})
signals.sort(key=lambda x_: x_['s'])
tc = np.clip(cnt, 0, 4)
feat = {'length': round(float(L), 1), 'step': STEP, 'stations': stations, 'platforms': plats, 'tunnels': [[round(a, 1), round(b, 1)] for a, b in tunnels],
        'bridges': [[round(a, 1), round(b, 1)] for a, b in bridges], 'electric': [[round(a, 1), round(b, 1)] for a, b in electric],
        'crossings': cr2, 'signals': signals, 'attribution': 'Track geometry and features (c) OpenStreetMap contributors, ODbL. Timetable: Caltrain GTFS. Terrain: AWS Terrain Tiles (Mapzen/USGS).'}
json.dump(feat, open(os.path.join(ROOT, 'data/baked/track.json'), 'w'), separators=(',', ':'))
tb = struct.pack('<4sIf', b'BLK1', n, STEP) + P[:, 0].astype(np.float32).tobytes() + P[:, 1].astype(np.float32).tobytes() + Y.astype(np.float32).tobytes() \
     + tc.astype(np.int8).tobytes() + np.clip(np.round(offs * 10), -127, 127).astype(np.int8).tobytes()
open(os.path.join(ROOT, 'data/baked/track.bin'), 'wb').write(zlib.compress(tb, 9))
print('track.bin', len(zlib.compress(tb, 9)), 'bytes;', len(stations), 'stations;', len(plats), 'platforms;', len(cr2), 'crossings;', len(signals), 'signals')
print('stations s:', [(s_['id'], round(s_['s'])) for s_ in stations])
print('track count histogram:', np.bincount(tc.astype(int)))
