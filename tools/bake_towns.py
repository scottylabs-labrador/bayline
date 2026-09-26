#!/usr/bin/env python3
"""Towns v2 bake: data/raw/osm/v2_*.pkl (OpenStreetMap, ODbL) -> data/pub/v2/tiles/b/ (streamed by src/js/30_towns.js).

    python3 tools/fetch_osm.py      # once: PBF -> pickles
    python3 tools/bake_towns.py     # ~2-4 min
    python3 tools/bake_towns.py --metro   # Bayline Metro: data/raw/osm/v3_*.pkl -> data/pub/v2/tiles/b2/ (see below)

--metro (notes/bart/world.md): the same bake over the BART corridors and the north strip (negative tile rows), with the
BART tracks (above ground) and stations added to the track / station rules and the East Bay regions 6-9
(tools/tiles/metro.py). tiles/b is never touched; tiles/b2 holds (a) every tile that tiles/b doesn't have and (b) tiles
of tiles/b whose content changed, unless a pre-Metro lidar tile (tiles/h9, frozen in data/raw/lidar3dep/old_l8.json)
lies under them (its detail was baked against the old roads). The client prefers b2 over b; old clients never read b2.

Tiling = SPEC_v2 level 7: 800 m tiles, origin X0=-45056, Z0=-49152; tile (tx, ty) covers
X in [X0+tx*800, X0+(tx+1)*800), Z in [Z0+ty*800, ...). Files:

  tiles/b/index.json            { version: 3, tile: 800, x0, z0, tiles: [[tx, ty, bytes, nBuildings, skyBytes], ...] }
  tiles/b/7/<tx>_<ty>.bin       zlib( tile )      full tile (buildings, roads, areas, trees, lamps, intersections, infill mask)
  tiles/b/7/<tx>_<ty>.sky.bin   zlib( tile )      same layout, only buildings >= SKY_H m (the far skyline), nothing else

Tile layout (little endian; coordinates int16 in 0.1 m units relative to the tile origin, vertex lists delta-coded):
  'BLT3' | u16 nB nR nA nT nI nL | u8 flags (1: infill mask follows) | u8 region | [128 B infill mask: 32x32 cells of 25 m, row-major, LSB first]
  building (nB): u8 kind, u8 roof, u16 h*4, u16 minH*4, u16 wall565, u16 roof565, u8 flags, u8 material, u8 levels, u8 frontEdge,
                 u16 nV, i16 xy[nV*2]
      flags: 1 photoRoof ok (low enough that the NAIP roof sits on the footprint), 2 storefront, 4 has front edge, 8 building:part,
             16 glassy (curtain wall), 32 victorian (SF residential), 64 historic
      material: 0 unknown, 1 brick, 2 stone, 3 concrete, 4 glass, 5 wood, 6 metal, 7 stucco/plaster
  road (nR):     u8 cls, u8 flags, u8 lanes, u8 width*4, u16 nV, i16 xy[nV*2], [u8 bridgeOff*4 x nV if flags&2]
                 flags: 1 oneway, 2 bridge, 4 downtown core, 8 urban, (flags>>4)&3 layer
  area (nA):     u8 kind, u8 pad, u16 nV, i16 xy[nV*2]      kinds: 0 park 1 pitch 2 playground 3 parking 4 plaza 5 cemetery 6 allotments
  tree (nT):     i16 x, i16 z, u8 kind, u8 size             (fallback trees; the vegetation module draws the real canopy)
  inter (nI):    i16 x, i16 z, u8 n, u8 flags, n x (u8 angle256, u8 halfWidth*4)
  lamp (nL):     i16 x, i16 z                               (OSM highway=street_lamp)
"""
import json, math, os, pickle, re, struct, sys, time, zlib
from collections import defaultdict
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
METRO = '--metro' in sys.argv
RAW = os.path.join(ROOT, 'data/raw/osm'); OUT = os.path.join(ROOT, 'data/pub/v2/tiles/b2' if METRO else 'data/pub/v2/tiles/b')
OLD_B = os.path.join(ROOT, 'data/pub/v2/tiles/b')
if METRO:
    sys.path.insert(0, HERE)
    from tiles import metro as MET
corr = json.load(open(os.path.join(ROOT, 'data/baked/corridor.json')))
LAT0, LON0, MLAT, MLON = corr['lat0'], corr['lon0'], corr['mPerDegLat'], corr['mPerDegLon']
X0, Z0, TILE = -45056.0, -49152.0, 800.0
SKY_H = 35.0                    # buildings at least this tall also go into the far skyline file
PHOTO_MAX_H = 22.0              # taller roofs lean in the orthophoto, so they keep a procedural roof
def W(lat, lon): return ((lon - LON0) * MLON, -(lat - LAT0) * MLAT)
def tkey(x, z): return (int(math.floor((x - X0) / TILE)), int(math.floor((z - Z0) / TILE)))
def torigin(tx, ty): return (X0 + tx * TILE, Z0 + ty * TILE)
t_start = time.time()
def log(*a): print(f'[{time.time() - t_start:6.1f}s]', *a, flush=True)

# ---------------------------------------------------------------- geometry helpers
def dp(pts, tol):
    if len(pts) < 3: return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True; stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop(); ax, az = pts[a]; bx, bz = pts[b]; dx, dz = bx - ax, bz - az; L2 = dx * dx + dz * dz
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, pz = pts[i]
            if L2 < 1e-9: d = math.hypot(px - ax, pz - az)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2)); d = math.hypot(px - (ax + t * dx), pz - (az + t * dz))
            if d > best: best, bi = d, i
        if best > tol: keep[bi] = True; stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]

def ring_simplify(ring, tol):
    if len(ring) >= 2 and math.dist(ring[0], ring[-1]) < 0.05: ring = ring[:-1]
    if len(ring) < 4: return ring
    far = max(range(len(ring)), key=lambda i: (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2)
    a = dp(ring[0:far + 1], tol); b = dp(ring[far:] + [ring[0]], tol)
    out = a[:-1] + b[:-1]; res = []
    for p in out:
        if res and math.hypot(p[0] - res[-1][0], p[1] - res[-1][1]) < 0.25: continue
        res.append(p)
    return res if len(res) >= 3 else ring

def area(ring):
    s = 0.0
    for (x1, z1), (x2, z2) in zip(ring, ring[1:] + ring[:1]): s += x1 * z2 - x2 * z1
    return s / 2

def centroid(ring):
    a = area(ring)
    if abs(a) < 1e-6: return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
    cx = cz = 0.0
    for (x1, z1), (x2, z2) in zip(ring, ring[1:] + ring[:1]):
        c = x1 * z2 - x2 * z1; cx += (x1 + x2) * c; cz += (z1 + z2) * c
    return (cx / (6 * a), cz / (6 * a))

def pip(x, z, ring):
    inside = False; n = len(ring); j = n - 1
    for i in range(n):
        xi, zi = ring[i]; xj, zj = ring[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi: inside = not inside
        j = i
    return inside

def rgb565(c):
    if not c: return 0
    c = str(c).strip().lower().split(';')[0]
    named = {'white': 'f2f0ea', 'black': '2a2a2a', 'grey': '8a8a8a', 'gray': '8a8a8a', 'red': 'a3483a', 'brown': '7a5a3c',
             'beige': 'd8c8a4', 'yellow': 'e2c86a', 'tan': 'c9ad84', 'blue': '5a78a0', 'green': '5f7f58', 'orange': 'c77a3c',
             'pink': 'd9a0a0', 'cream': 'efe3c8', 'silver': 'b8bcc2', 'darkgrey': '555555', 'darkgray': '555555', 'lightgrey': 'c8c8c8',
             'lightgray': 'c8c8c8', 'maroon': '6e2a2a', 'terracotta': 'b5654a', 'ivory': 'efe8d6', 'darkred': '7a2e26', 'navy': '2f3b5a',
             'olive': '6b6b3a', 'purple': '6e4a7a', 'teal': '3f7a78', 'gold': 'c9a24a', 'sandybrown': 'd6a466', 'lightblue': 'a8c4dc',
             'darkblue': '2f4668', 'lightyellow': 'efe6b8', 'darkgreen': '3f5a3a', 'lightgreen': 'a8c49a'}
    if c in named: c = named[c]
    c = c.lstrip('#')
    if len(c) == 3: c = ''.join(ch * 2 for ch in c)
    if not re.fullmatch(r'[0-9a-f]{6}', c): return 0
    r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
    return v or 1

def num(v):
    if v is None: return None
    v = str(v).strip().lower().replace(',', '.').split(';')[0]
    m = re.match(r'^([0-9.]+)\s*(m|ft|\'|feet)?', v)
    if not m: return None
    try: x = float(m.group(1))
    except ValueError: return None
    if m.group(2) in ('ft', "'", 'feet'): x *= 0.3048
    return x

def region_of(z, x=None):
    lat = LAT0 - z / MLAT
    if METRO and x is not None:
        r = MET.ebay_region(lat, LON0 + x / MLON)
        if r is not None: return r
    if lat > 37.708: return 0          # San Francisco
    if lat > 37.50: return 1           # north Peninsula
    if lat > 37.415: return 2          # mid Peninsula
    if lat > 37.335: return 3          # South Bay
    if lat > 37.20: return 4           # San Jose
    return 5                           # South County

# ---------------------------------------------------------------- context: track, stations, landmarks
def load_track():
    b = zlib.decompress(open(os.path.join(ROOT, 'data/baked/track.bin'), 'rb').read())
    n, step = struct.unpack_from('<If', b, 4); p = 12
    X = np.frombuffer(b, '<f4', n, p); p += 4 * n
    Z = np.frombuffer(b, '<f4', n, p)
    return np.stack([X, Z], 1).astype(np.float64)
TRACK = load_track()
if METRO:      # + the BART tracks where they are above ground (buildings stand over the subways and tunnels)
    _bp = []
    for _t in MET.network_tracks():
        _m = ~np.isin(_t['struct'], list(MET.UNDER))
        if _m.any(): _bp.append(_t['P'][_m][:, [0, 2]])
    TRACK = np.concatenate([TRACK] + _bp, 0)
    log('track points (Caltrain + BART above ground)', len(TRACK))
track_tree = cKDTree(TRACK)
def track_dist(pts):
    d, _ = track_tree.query(np.asarray(pts, np.float64).reshape(-1, 2), k=1)
    return d
stations_w = [W(s['lat'], s['lon']) for s in corr['stations']]
if METRO: stations_w += [(x, z) for (_i, _n, x, z) in MET.stations()]

def landmarks():
    src = open(os.path.join(ROOT, 'src/js/50_landmarks.js'), encoding='utf-8').read()
    return [(m.group(2), float(m.group(3)), float(m.group(4)), float(m.group(5)))
            for m in re.finditer(r"def\((['\"])(.+?)\1,\s*([0-9.+-]+),\s*([0-9.+-]+),\s*([0-9.]+)", src)]
# OSM buildings the landmark module models itself: drop footprints whose centroid is within this many metres of the
# landmark anchor (0 = don't drop anything; bridges, peaks and airports are handled separately).
LM_FOOT = {'Salesforce Tower': 45, 'Transamerica Pyramid': 40, '181 Fremont': 32, 'Millennium Tower': 35, '555 California Street': 55,
           'One Rincon Hill': 35, 'Oracle Park': 125, 'Chase Center': 85, 'Ferry Building': 95, 'Coit Tower': 25, 'Sutro Tower': 45,
           'Painted Ladies': 52, 'Alcatraz Island': 420, 'Cow Palace': 120, 'Oracle Towers': 210, 'Pulgas Water Temple': 30,
           'Hoover Tower': 25, 'Main Quad & Memorial Church': 115, 'Stanford Stadium': 115, 'The Dish': 45, 'Meta Headquarters': 320,
           'Googleplex': 380, 'Shoreline Amphitheatre': 120, 'Google Bay View': 210, 'Hangar One': 150, 'Hangars 2 and 3': 250,
           'NASA Ames Wind Tunnels': 250, 'Apple Park': 340, "Levi's Stadium": 150, "California's Great America": 350,
           'Mission Santa Clara': 60, 'SAP Center': 95, 'Winchester Mystery House': 60, 'Lick Observatory': 260,
           'Mount Umunhum Radar Tower': 45, 'Gilroy Old City Hall': 25}
LANDMARKS = [(name, *W(la, lo), LM_FOOT.get(name, 0 if r > 600 else min(r, 60))) for name, la, lo, r in landmarks()]
lm_names = [(n.lower(), x, z) for n, x, z, _r in LANDMARKS if len(n) > 6]
log('landmarks', len(LANDMARKS))

# ---------------------------------------------------------------- load OSM
def load(name): return pickle.load(open(os.path.join(RAW, name + '.pkl'), 'rb'))
_PFX = 'v3_' if METRO else 'v2_'
B_RAW, R_RAW, A_RAW, P_RAW = load(_PFX + 'buildings'), load(_PFX + 'roads'), load(_PFX + 'areas'), load(_PFX + 'points')
log('loaded', len(B_RAW), 'buildings', len(R_RAW), 'roads', len(A_RAW), 'areas', len(P_RAW), 'points')

# aerodromes the landmark module models (SFO, SJC): their terminals / towers are dropped
AIRPORT_ANCHORS = [W(37.615906, -122.383806), W(37.3639, -121.9289)]
aerodromes = []
for key, t, outers in A_RAW:
    if t.get('aeroway') != 'aerodrome': continue
    for r in outers:
        c = centroid(r)
        if any(math.dist(c, a) < 3500 for a in AIRPORT_ANCHORS) and abs(area(r)) > 1e6: aerodromes.append(r)
log('big aerodromes', len(aerodromes))

# ---------------------------------------------------------------- roads
CLS = {'motorway': 0, 'motorway_link': 1, 'trunk': 2, 'trunk_link': 3, 'primary': 4, 'primary_link': 5, 'secondary': 6,
       'secondary_link': 7, 'tertiary': 8, 'tertiary_link': 9, 'residential': 10, 'unclassified': 11, 'living_street': 12,
       'service': 13, 'pedestrian': 14}
DEF_LANES = {0: 3, 1: 1, 2: 2, 3: 1, 4: 4, 5: 1, 6: 3, 7: 1, 8: 2, 9: 1, 10: 2, 11: 2, 12: 1, 13: 1, 14: 1}
roads = {}; node_use = defaultdict(int)
for wid, t, refs, pts in R_RAW:
    c = CLS.get(t.get('highway'))
    if c is None or t.get('area') == 'yes': continue
    if t.get('access') in ('private', 'no') and c >= 13: continue
    if len(pts) < 2: continue
    oneway = t.get('oneway') in ('yes', '1', 'true') or (c in (0, 1) and t.get('oneway') != 'no') or t.get('junction') == 'roundabout'
    lanes = None
    try: lanes = int(float(t.get('lanes', '').split(';')[0])) if t.get('lanes') else None
    except ValueError: lanes = None
    if lanes is None: lanes = DEF_LANES[c] if not (oneway and c in (4, 6, 8, 10)) else max(1, DEF_LANES[c] // 2)
    lanes = max(1, min(lanes, 8))
    lw = 3.6 if c <= 3 else 3.3 if c <= 9 else 3.0
    width = lanes * lw
    if c in (0, 2): width += 3.0 + (1.2 if oneway else 0)
    elif c in (1, 3): width += 2.0
    elif c in (10, 11): width = max(width, 7.2) + (4.6 if region_of(pts[0][1], pts[0][0]) != 5 else 1.0)
    elif c == 12: width = max(width, 6.0)
    elif c == 13: width = max(width, 4.2)
    elif c == 14: width = max(width, 5.0)
    elif c in (4, 6, 8): width += 1.0 + (2.4 if c in (6, 8) else 0)
    layer = 0
    try: layer = int(t.get('layer', '0'))
    except ValueError: layer = 0
    bridge = t.get('bridge') not in (None, 'no'); tunnel = t.get('tunnel') not in (None, 'no') or t.get('covered') == 'yes'
    if bridge and layer <= 0: layer = 1
    roads[wid] = dict(pts=pts, nodes=refs, cls=c, oneway=oneway, lanes=lanes, width=min(width, 60), bridge=bridge, tunnel=tunnel,
                      layer=max(0, min(layer, 3)))
    for n in refs: node_use[n] += 1
inter_nodes = {n for n, k in node_use.items() if k >= 2}
log('roads', len(roads))

# road sample points (for front edges / storefront streets / urban density)
rs_pts, rs_cls, rs_hw = [], [], []
dens = defaultdict(float)
for r in roads.values():
    if r['tunnel']: continue
    P = r['pts']
    for a, b in zip(P, P[1:]):
        L = math.dist(a, b); n = max(1, int(L / 5))
        for k in range(n):
            rs_pts.append((a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n)); rs_cls.append(r['cls']); rs_hw.append(r['width'] / 2)
        if r['cls'] >= 10: dens[(int(a[0] // 250), int(a[1] // 250))] += L
rs_pts = np.array(rs_pts, np.float64) if rs_pts else np.zeros((1, 2)); rs_cls = np.array(rs_cls or [99], np.int16); rs_hw = np.array(rs_hw or [0], np.float32)
road_tree = cKDTree(rs_pts)
st_arr = np.array(stations_w)
def urban_at(x, z):
    k = (int(x // 250), int(z // 250)); s = 0.0
    for dx in (-1, 0, 1):
        for dz in (-1, 0, 1): s += dens.get((k[0] + dx, k[1] + dz), 0.0)
    return s > 2600 or float(np.min(np.hypot(st_arr[:, 0] - x, st_arr[:, 1] - z))) < 1500

# ---------------------------------------------------------------- buildings
KIND = {'house': 0, 'detached': 0, 'semidetached_house': 0, 'bungalow': 0, 'cabin': 0, 'farm': 0, 'terrace': 1, 'residential': 1,
        'apartments': 1, 'dormitory': 1, 'hotel': 2, 'commercial': 2, 'retail': 2, 'office': 2, 'supermarket': 2, 'kiosk': 2, 'bank': 2,
        'industrial': 3, 'warehouse': 3, 'manufacture': 3, 'hangar': 3, 'service': 3, 'storage_tank': 3, 'factory': 3, 'barn': 3,
        'farm_auxiliary': 3, 'school': 4, 'university': 4, 'college': 4, 'church': 4, 'cathedral': 4, 'chapel': 4, 'temple': 4, 'mosque': 4,
        'synagogue': 4, 'civic': 4, 'public': 4, 'hospital': 4, 'government': 4, 'fire_station': 4, 'library': 4, 'museum': 4,
        'stadium': 4, 'sports_hall': 4, 'garage': 5, 'garages': 5, 'shed': 5, 'carport': 5, 'roof': 5, 'greenhouse': 5, 'hut': 5,
        'train_station': 6, 'transportation': 6, 'parking': 7}
ROOF = {'flat': 0, 'gabled': 1, 'hipped': 2, 'pyramidal': 3, 'skillion': 4, 'dome': 5, 'half-hipped': 2, 'mansard': 2, 'round': 5,
        'gambrel': 1, 'saltbox': 1, 'side_hipped': 2, 'onion': 5, 'cone': 3}
MAT = {'brick': 1, 'stone': 2, 'sandstone': 2, 'limestone': 2, 'granite': 2, 'marble': 2, 'concrete': 3, 'cement_block': 3,
       'reinforced_concrete': 3, 'glass': 4, 'mirror': 4, 'wood': 5, 'timber_framing': 5, 'metal': 6, 'steel': 6, 'plaster': 7,
       'stucco': 7, 'render': 7, 'adobe': 7}

def building_kind(t, a, reg):
    btype = t.get('building') or t.get('building:part') or 'yes'
    if btype in ('yes', 'part'): btype = t.get('building:use') or 'yes'
    kind = KIND.get(btype, 8)
    if kind == 8:
        if t.get('shop') or t.get('office') or t.get('amenity') in ('restaurant', 'cafe', 'bank', 'fast_food', 'bar', 'pub', 'pharmacy', 'cinema'): kind = 2
        elif t.get('amenity') in ('school', 'place_of_worship', 'library', 'townhall', 'hospital', 'fire_station', 'police', 'community_centre'): kind = 4
        elif t.get('amenity') == 'parking': kind = 7
        elif a < 25: kind = 5
        elif a < 260: kind = 0 if reg != 0 else 1
        elif a < 900: kind = 1 if reg == 0 else 2
        else: kind = 2 if reg in (0, 4) else 3
    return kind

cand = []           # (key, tags, ring, holes-ignored, is_part)
for key, t, outers, _inners in B_RAW:
    bv = t.get('building') or t.get('building:part')
    if bv in (None, 'no', 'construction', 'ruins', 'demolished', 'razed', 'proposed', 'destroyed') : continue
    if t.get('location') == 'underground' or (t.get('layer', '0').lstrip('-').isdigit() and int(t.get('layer', '0')) < 0): continue
    is_part = 'building:part' in t and 'building' not in t
    for ring in outers:
        if len(ring) < 4: continue
        r = ring_simplify([tuple(p) for p in ring], 0.3)
        if len(r) < 3: continue
        a = area(r)
        if abs(a) < 10: continue
        if a < 0: r = r[::-1]
        cand.append((key, t, r, is_part))
log('building candidates', len(cand))

# building:part handling (Simple 3D Buildings): an outline whose area is >= 60% covered by its parts is replaced by the parts
parts = [(i, centroid(c[2]), abs(area(c[2]))) for i, c in enumerate(cand) if c[3]]
drop = set()
if parts:
    pc = np.array([p[1] for p in parts]); ptree = cKDTree(pc)
    for i, (key, t, r, is_part) in enumerate(cand):
        if is_part: continue
        xs = [p[0] for p in r]; zs = [p[1] for p in r]; cx, cz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
        rad = math.hypot(max(xs) - min(xs), max(zs) - min(zs)) / 2
        idx = ptree.query_ball_point((cx, cz), rad + 0.5)
        if not idx: continue
        cov = sum(parts[j][2] for j in idx if pip(parts[j][1][0], parts[j][1][1], r))
        if cov >= 0.6 * abs(area(r)): drop.add(i)
log('outlines replaced by parts', len(drop))

cents = np.array([centroid(c[2]) for c in cand]) if cand else np.zeros((0, 2))
tdist = track_tree.query(cents, k=1)[0] if len(cents) else np.zeros(0)
buildings = []; n_lm = n_air = n_track = n_depot = 0
for i, (key, t, ring, is_part) in enumerate(cand):
    if i in drop: continue
    cx, cz = cents[i]; td = tdist[i]; a = abs(area(ring)); reg = region_of(cz, cx)
    kind = building_kind(t, a, reg)
    # rail modules draw their own stations; nothing may straddle the tracks
    if td < 7 or (kind in (5, 6, 7) and td < 22): n_track += 1; continue
    if kind == 6 and any(math.dist((cx, cz), s) < 160 for s in stations_w): n_depot += 1; continue
    # landmark footprints and airport terminals
    lm = False
    for name, lx, lz, fr in LANDMARKS:
        if fr > 0 and abs(cx - lx) < fr and abs(cz - lz) < fr and math.hypot(cx - lx, cz - lz) < fr: lm = True; break
    nm = (t.get('name') or '').lower()
    if not lm and nm:
        for ln, lx, lz in lm_names:
            if ln in nm and math.hypot(cx - lx, cz - lz) < 400: lm = True; break
    if lm: n_lm += 1; continue
    if aerodromes and (t.get('aeroway') in ('terminal', 'tower', 'control_tower') or 'terminal' in nm) and any(pip(cx, cz, r) for r in aerodromes):
        n_air += 1; continue
    h = num(t.get('height')); lv = num(t.get('building:levels')); rl = num(t.get('roof:levels')) or 0
    mh = num(t.get('min_height'))
    if mh is None: mh = (num(t.get('building:min_level')) or 0) * 3.3
    if h is None:
        if lv: h = lv * (3.05 if kind in (0, 1) else 3.9) + (1.6 if kind == 0 else 0.8) + rl * 2.2
        else:
            h = {0: 6.2, 1: 10.5 if reg == 0 else 8.5, 2: 9.0 if reg in (0, 4) else 6.5, 3: 8.5, 4: 9.5, 5: 3.2, 6: 7.0, 7: 9.0}.get(kind, 7.0)
            if reg == 0 and kind in (0, 1): h = 9.5 if a < 200 else 12.0
            if kind == 0 and a > 240: h = 7.4
        if is_part and mh: h = max(h, mh + 3)
    h = max(2.4, min(h, 330.0)); mh = max(0.0, min(mh, h - 1.0))
    roof = ROOF.get(t.get('roof:shape'), -1)
    if roof < 0:
        if kind == 0 and a < 450 and reg != 0: roof = 2 if (zlib.crc32(key.encode()) % 100) < 64 else 1
        elif kind == 5 and a < 70: roof = 1
        elif kind in (1,) and a < 700 and reg not in (0,) and h < 14: roof = 2
        else: roof = 0
    mat = MAT.get((t.get('building:material') or '').lower(), 0)
    levels = int(min(255, round(lv))) if lv else 0
    flags = 0
    if h - (mh if is_part else 0) < PHOTO_MAX_H and h < PHOTO_MAX_H + 6: flags |= 1
    if is_part: flags |= 8
    if kind == 2 and h > 30: flags |= 16
    if mat == 4: flags |= 16
    if reg == 0 and kind in (0, 1) and h < 17: flags |= 32
    if t.get('historic'): flags |= 64
    buildings.append(dict(ring=ring, cx=cx, cz=cz, kind=kind, roof=roof, h=h, mh=mh, flags=flags, mat=mat, levels=levels,
                          wall=rgb565(t.get('building:colour')), roofc=rgb565(t.get('roof:colour')),
                          shop=bool(t.get('shop') or t.get('amenity') in ('restaurant', 'cafe', 'bank', 'fast_food', 'bar', 'pub', 'pharmacy')),
                          reg=reg, front=255, frontCls=99))
log(f'buildings kept {len(buildings)}  (landmarks -{n_lm}, airport terminals -{n_air}, track -{n_track}, depots -{n_depot})')

# ---------------------------------------------------------------- front edges (the wall that faces the nearest street)
mids, owners, norms = [], [], []
for bi, b in enumerate(buildings):
    R = b['ring']; n = len(R)
    for e in range(n):
        (ax, az), (bx, bz) = R[e], R[(e + 1) % n]; L = math.hypot(bx - ax, bz - az)
        if L < 2.5: continue
        mids.append(((ax + bx) / 2, (az + bz) / 2)); owners.append((bi, e, L)); norms.append(((bz - az) / L, -(bx - ax) / L))   # CCW -> outward (dz, -dx)
if mids:
    M = np.array(mids); N = np.array(norms)
    d, j = road_tree.query(M, k=1, distance_upper_bound=32.0)
    ok = np.isfinite(d)
    jj = np.where(ok, j, 0)
    to = rs_pts[jj] - M; tl = np.maximum(1e-6, np.hypot(to[:, 0], to[:, 1]))
    facing = (to[:, 0] * N[:, 0] + to[:, 1] * N[:, 1]) / tl
    # score: close, facing, and prefer bigger streets slightly; minus the road half width so wide streets aren't penalized
    edge_d = np.where(ok, d - rs_hw[jj], 1e9)
    score = np.where(ok & (facing > 0.45), edge_d - 2.0 * facing, 1e9)
    best = {}
    for k in range(len(owners)):
        if score[k] >= 1e8: continue
        bi, e, L = owners[k]
        if bi not in best or score[k] < best[bi][0]: best[bi] = (score[k], e, int(rs_cls[jj[k]]))
    for bi, (s, e, c) in best.items():
        b = buildings[bi]
        if e < 255: b['front'] = e; b['frontCls'] = c; b['flags'] |= 4
for b in buildings:          # storefronts: shops, and commercial buildings on real streets in town
    if b['front'] == 255: continue
    urban_street = b['frontCls'] <= 12 and b['frontCls'] >= 4
    if b['shop'] or (b['kind'] == 2 and urban_street) or (b['kind'] == 1 and b['reg'] == 0 and b['frontCls'] <= 9 and b['frontCls'] >= 4):
        b['flags'] |= 2
log('front edges', sum(1 for b in buildings if b['front'] != 255))

# ---------------------------------------------------------------- areas (drawn) + residential landuse (infill mask)
AREA_KIND = {'park': 0, 'garden': 0, 'village_green': 0, 'recreation_ground': 0, 'grass': 0, 'dog_park': 0, 'meadow': 0,
             'pitch': 1, 'sports_centre': 1, 'track': 1, 'stadium': 1, 'playground': 2, 'parking': 3, 'pedestrian': 4, 'square': 4,
             'cemetery': 5, 'allotments': 6, 'golf_course': 0}
areas = []; resid = []
for key, t, outers in A_RAW:
    if t.get('landuse') == 'residential':
        for r in outers:
            if len(r) >= 4: resid.append([tuple(p) for p in r])
        continue
    k = None
    for tag in ('leisure', 'landuse', 'amenity', 'highway', 'place'):
        if tag == 'highway' and t.get('area') != 'yes': continue
        if t.get(tag) in AREA_KIND: k = AREA_KIND[t[tag]]; break
    if k is None: continue
    if k == 3 and t.get('parking') in ('underground', 'multi-storey', 'rooftop'): continue
    for ring in outers:
        r = ring_simplify([tuple(p) for p in ring], 1.0)
        if len(r) < 3 or abs(area(r)) < 40: continue
        if area(r) < 0: r = r[::-1]
        c = centroid(r); areas.append(dict(ring=r, kind=k, cx=c[0], cz=c[1]))
log('areas', len(areas), 'residential landuse polygons', len(resid))

# infill mask: 25 m cells inside residential landuse, with no OSM building within ~20 m, and a street within 70 m
GX0, GZ0, GC = X0, (Z0 - 25600.0 if METRO else Z0), 25.0; GN = int(102400 / GC); GNZ = int((102400 + (25600 if METRO else 0)) / GC)
res_mask = np.zeros((GNZ, GN), bool)
for r in resid:
    xs = [p[0] for p in r]; zs = [p[1] for p in r]
    j0, j1 = max(0, int((min(zs) - GZ0) / GC)), min(GNZ - 1, int((max(zs) - GZ0) / GC))
    n = len(r)
    for j in range(j0, j1 + 1):
        pz = GZ0 + (j + 0.5) * GC; xsx = []
        for i in range(n):
            (ax, az), (bx, bz) = r[i], r[(i + 1) % n]
            if (az <= pz < bz) or (bz <= pz < az): xsx.append(ax + (bx - ax) * (pz - az) / (bz - az))
        xsx.sort()
        for m in range(0, len(xsx) - 1, 2):
            i0, i1 = max(0, int((xsx[m] - GX0) / GC + 0.5)), min(GN - 1, int((xsx[m + 1] - GX0) / GC - 0.5))
            if i1 >= i0: res_mask[j, i0:i1 + 1] = True
occ = np.zeros((GNZ, GN), bool)
for b in buildings:
    for x, z in b['ring'] + [(b['cx'], b['cz'])]:
        i, j = int((x - GX0) / GC), int((z - GZ0) / GC)
        if 0 <= i < GN and 0 <= j < GNZ: occ[j, i] = True
from scipy import ndimage
occ = ndimage.binary_dilation(occ, iterations=1)
street = np.zeros((GNZ, GN), bool)
res_cls = rs_cls >= 10
for (x, z) in rs_pts[res_cls[: len(rs_pts)]] if len(rs_pts) else []:
    i, j = int((x - GX0) / GC), int((z - GZ0) / GC)
    if 0 <= i < GN and 0 <= j < GNZ: street[j, i] = True
near_street = ndimage.distance_transform_edt(~street) * GC <= 70
infill = res_mask & ~occ & near_street
log('infill cells', int(infill.sum()), f'({infill.sum() * GC * GC / 1e6:.1f} km²)')

# ---------------------------------------------------------------- points: trees (fallback) and street lamps
trees, lamps = [], []
for nid, t, x, z in P_RAW:
    if t.get('highway') == 'street_lamp':
        if track_tree.query((x, z))[0] > 6: lamps.append((x, z))
        continue
    genus = (t.get('genus', '') + ' ' + t.get('species', '') + ' ' + t.get('taxon', '')).lower()
    kind = 0
    if any(g in genus for g in ('phoenix', 'washingtonia', 'syagrus', 'palm', 'trachycarpus')): kind = 1
    elif any(g in genus for g in ('sequoia', 'pinus', 'cedrus', 'cupressus', 'pine', 'redwood', 'cedar')) or t.get('leaf_type') == 'needleleaved': kind = 2
    elif 'eucalyptus' in genus: kind = 3
    size = 2 if kind == 1 else 1
    hh = num(t.get('height'))
    if hh: size = 0 if hh < 6 else 1 if hh < 12 else 2 if hh < 20 else 3
    trees.append((x, z, kind, size))
log('trees', len(trees), 'lamps', len(lamps))

# ---------------------------------------------------------------- tiling
tiles = defaultdict(lambda: dict(b=[], r=[], a=[], t=[], i=[], l=[]))
for b in buildings: tiles[tkey(b['cx'], b['cz'])]['b'].append(b)
for a in areas: tiles[tkey(a['cx'], a['cz'])]['a'].append(a)
for tr in trees: tiles[tkey(tr[0], tr[1])]['t'].append(tr)
for lp in lamps: tiles[tkey(*lp)]['l'].append(lp)

def split_polyline(pts):
    out = []; cur = [pts[0]]; ck = tkey(pts[0][0], pts[0][1])
    for a, b in zip(pts, pts[1:]):
        ax, az, ao = a; bx, bz, bo = b; ts = []
        for k in range(int(math.floor((min(ax, bx) - X0) / TILE)) + 1, int(math.floor((max(ax, bx) - X0) / TILE)) + 1):
            if bx != ax: ts.append((X0 + k * TILE - ax) / (bx - ax))
        for k in range(int(math.floor((min(az, bz) - Z0) / TILE)) + 1, int(math.floor((max(az, bz) - Z0) / TILE)) + 1):
            if bz != az: ts.append((Z0 + k * TILE - az) / (bz - az))
        for t in sorted(x for x in ts if 0 < x < 1):
            p = (ax + (bx - ax) * t, az + (bz - az) * t, ao + (bo - ao) * t)
            cur.append(p); out.append((ck, cur))
            ck = tkey(p[0] + (bx - ax) * 1e-6, p[1] + (bz - az) * 1e-6); cur = [p]
        cur.append(b)
    out.append((ck, cur))
    return [(k, c) for k, c in out if len(c) >= 2 and sum(math.dist(u[:2], v[:2]) for u, v in zip(c, c[1:])) > 0.3]

cover = defaultdict(float)
for b in buildings: cover[(int(b['cx'] // 50), int(b['cz'] // 50))] += abs(area(b['ring']))
def core_at(x, z):
    k = (int(x // 50), int(z // 50)); s = 0.0
    for dx in (-1, 0, 1):
        for dz in (-1, 0, 1): s += cover.get((k[0] + dx, k[1] + dz), 0.0)
    return s > 0.28 * 150 * 150

npieces = 0
for rid, r in roads.items():
    if r['tunnel']: continue
    tol = 1.2 if r['cls'] <= 9 else 0.8
    pts = r['pts']
    keep_idx = [i for i, n in enumerate(r['nodes']) if n in inter_nodes] if r['nodes'] else []
    anchors = sorted(set([0, len(pts) - 1] + keep_idx))
    simp = []
    for i0, i1 in zip(anchors, anchors[1:]):
        seg = dp([tuple(p) for p in pts[i0:i1 + 1]], tol)
        simp += seg if not simp else seg[1:]
    if len(simp) < 2: continue
    mid = pts[len(pts) // 2]
    urban = urban_at(*mid)
    core = urban and r['cls'] >= 4 and (core_at(*mid) or (core_at(*pts[0]) and core_at(*pts[-1])))
    flags = (1 if r['oneway'] else 0) | (2 if r['bridge'] else 0) | (4 if core else 0) | (8 if urban else 0) | (r['layer'] << 4)
    L = sum(math.dist(a, b) for a, b in zip(simp, simp[1:])) or 1.0
    ramp = max(8.0, min(L * 0.45, 70.0)); acc = 0.0; p3 = []
    for i, p in enumerate(simp):
        if i: acc += math.dist(simp[i - 1], p)
        off = (max(1, r['layer']) * 6.5 * min(1.0, acc / ramp, (L - acc) / ramp)) if r['bridge'] else 0.0
        p3.append((p[0], p[1], max(0.0, off)))
    for k, piece in split_polyline(p3):
        tiles[k]['r'].append(dict(pts=piece, cls=r['cls'], flags=flags, lanes=r['lanes'], width=r['width'])); npieces += 1
log('road pieces', npieces)

by_node = defaultdict(list); node_pos = {}
for r in roads.values():
    if r['tunnel'] or not r['nodes']: continue
    for i, n in enumerate(r['nodes']):
        if n not in inter_nodes: continue
        p = r['pts'][i]; node_pos[n] = p
        for j in (i - 1, i + 1):
            if 0 <= j < len(r['pts']):
                q = r['pts'][j]
                by_node[n].append((math.atan2(q[1] - p[1], q[0] - p[0]), r['width'] / 2, r['cls']))
ninter = 0
for n, apps in by_node.items():
    if len(apps) < 3 or any(c <= 3 for _, _, c in apps): continue
    x, z = node_pos[n]; urban = urban_at(x, z)
    flags = (8 if urban else 0) | (1 if max(c for _, _, c in apps) >= 10 and min(c for _, _, c in apps) >= 10 else 0)
    tiles[tkey(x, z)]['i'].append((x, z, flags, apps[:8])); ninter += 1
log('intersections', ninter)

# ---------------------------------------------------------------- encode
def q(v): return int(round(v * 10))
def enc_pts(pts, ox, oz):
    out = bytearray(); px = pz = 0
    for i, p in enumerate(pts):
        X, Z = q(p[0] - ox), q(p[1] - oz)
        dx, dz = (X, Z) if i == 0 else (X - px, Z - pz)
        dx = max(-32768, min(32767, dx)); dz = max(-32768, min(32767, dz))
        out += struct.pack('<hh', dx, dz); px, pz = (px + dx, pz + dz) if i else (dx, dz)
    return out

def enc_building(b, ox, oz):
    ring = b['ring']
    return struct.pack('<BBHHHHBBBBH', b['kind'], b['roof'], min(65535, int(b['h'] * 4)), min(65535, int(b['mh'] * 4)), b['wall'], b['roofc'],
                       b['flags'], b['mat'], b['levels'], b['front'] if b['front'] < 255 else 255, len(ring)) + enc_pts(ring, ox, oz)

def tile_blob(tx, ty, T, sky=False):
    ox, oz = torigin(tx, ty)
    B = T['b'] if not sky else [b for b in T['b'] if b['h'] >= SKY_H]
    if sky and not B: return None
    R = [] if sky else T['r']; A = [] if sky else T['a']; TR = [] if sky else T['t']; I = [] if sky else T['i']; LL = [] if sky else T['l']
    mask = None
    if not sky:
        i0, j0 = int(round((ox - GX0) / GC)), int(round((oz - GZ0) / GC))
        sub = infill[j0:j0 + 32, i0:i0 + 32]
        if sub.shape == (32, 32) and sub.any(): mask = np.packbits(sub.reshape(-1), bitorder='little').tobytes()
    out = bytearray(b'BLT3' + struct.pack('<6H', min(len(B), 65535), min(len(R), 65535), len(A), len(TR), len(I), len(LL)))
    out += struct.pack('<BB', 1 if mask else 0, region_of(oz + TILE / 2, ox + TILE / 2))
    if mask: out += mask
    for b in B[:65535]: out += enc_building(b, ox, oz)
    for r in R[:65535]:
        out += struct.pack('<BBBBH', r['cls'], r['flags'], r['lanes'], min(255, int(r['width'] * 4)), len(r['pts'])) + enc_pts(r['pts'], ox, oz)
        if r['flags'] & 2: out += bytes(min(255, int(round(p[2] * 4))) for p in r['pts'])
    for a in A: out += struct.pack('<BBH', a['kind'], 0, len(a['ring'])) + enc_pts(a['ring'], ox, oz)
    for x, z, kind, size in TR: out += struct.pack('<hhBB', q(x - ox), q(z - oz), kind, size)
    for x, z, flags, apps in I:
        out += struct.pack('<hhBB', q(x - ox), q(z - oz), len(apps), flags)
        for ang, hw, _c in apps: out += struct.pack('<BB', int(((ang % (2 * math.pi)) / (2 * math.pi)) * 256) & 255, min(255, int(hw * 4)))
    for x, z in LL: out += struct.pack('<hh', q(x - ox), q(z - oz))
    return zlib.compress(bytes(out), 9)

os.makedirs(os.path.join(OUT, '7'), exist_ok=True)
for f in os.listdir(os.path.join(OUT, '7')): os.remove(os.path.join(OUT, '7', f))
index = []; total = 0; total_sky = 0
if METRO:      # which tiles go to b2 (see the docstring)
    old_idx = {(t[0], t[1]) for t in json.load(open(os.path.join(OLD_B, 'index.json')))['tiles']}
    old_l8 = {tuple(t) for t in json.load(open(os.path.join(ROOT, 'data/raw/lidar3dep/old_l8.json')))}
    n_new = n_over = n_same = n_held = 0
for (tx, ty), T in sorted(tiles.items()):
    if not (T['b'] or T['r']): continue
    blob = tile_blob(tx, ty, T)
    if METRO and (tx, ty) in old_idx:
        oldp = os.path.join(OLD_B, '7', f'{tx}_{ty}.bin')
        if os.path.exists(oldp) and open(oldp, 'rb').read() == blob: n_same += 1; continue
        if any((2 * tx + dx, 2 * ty + dy) in old_l8 for dy in (0, 1) for dx in (0, 1)): n_held += 1; continue
        n_over += 1
    elif METRO: n_new += 1
    open(os.path.join(OUT, '7', f'{tx}_{ty}.bin'), 'wb').write(blob); total += len(blob)
    sky = tile_blob(tx, ty, T, sky=True); sb = 0
    if sky: open(os.path.join(OUT, '7', f'{tx}_{ty}.sky.bin'), 'wb').write(sky); sb = len(sky); total_sky += sb
    index.append([tx, ty, len(blob), len(T['b']), sb])
meta = {'version': 3, 'tile': TILE, 'x0': X0, 'z0': Z0, 'skyH': SKY_H, 'photoMaxH': PHOTO_MAX_H, 'attribution': '(c) OpenStreetMap contributors, ODbL 1.0'}
if METRO:
    meta['layer'] = 'b2: Bayline Metro towns (BART corridors, north strip); a b2 tile replaces the b tile with the same key'
    meta['regions'] = '0 SF, 1 north Peninsula, 2 mid Peninsula, 3 South Bay, 4 San Jose, 5 South County, 6 East Bay flats, 7 Hayward-Fremont-Milpitas, 8 Lamorinda-Walnut Creek-Concord-Tri-Valley, 9 Pittsburg-Antioch'
    log(f'b2: {n_new} new tiles, {n_over} replacing changed b tiles, {n_same} unchanged (left to b), {n_held} changed but held (pre-Metro lidar under them)')
json.dump(dict(meta, tiles=index), open(os.path.join(OUT, 'index.json'), 'w'), separators=(',', ':'))
log(f'tiles {len(index)}  {total / 1e6:.1f} MB  (+ skyline {total_sky / 1e6:.2f} MB in {sum(1 for t in index if t[4])} files)  -> {OUT}')
