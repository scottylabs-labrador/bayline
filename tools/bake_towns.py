#!/usr/bin/env python3
"""data/raw/osm/*.json (OpenStreetMap, ODbL) -> data/baked/towns.bin (zlib) for src/js/30_towns.js.

Binary layout (little endian), everything tiled on a 1 km world grid (Geo projection, see SPEC):

  header:  'BLT2' | u32 tileCount | tileCount x (i16 tx, i16 tz, u32 offset, u32 length)
  tile:    origin = (tx*1000, tz*1000) world meters. Coordinates are int16 in 0.1 m units relative to
           the tile origin; vertex lists are delta-coded (first vertex absolute, then deltas).
    u16 nB, u16 nR, u16 nA, u16 nT, u16 nI, u16 pad
    buildings  (nB): u8 kind, u8 roof, u16 height*4, u16 minH*4, u16 wallRGB565, u16 roofRGB565, u16 nV, i16 xy[nV*2]
    roads      (nR): u8 cls, u8 flags, u8 lanes, u8 width*4, u16 nV, i16 xy[nV*2], [u8 bridgeOff*4 x nV if flags&2]
                     flags: 1 oneway, 2 bridge, 4 downtown core, 8 urban, (flags>>4)&3 layer
    areas      (nA): u8 kind, u8 pad, u16 nV, i16 xy[nV*2]
    trees      (nT): i16 x, i16 z, u8 kind, u8 size
    inters     (nI): i16 x, i16 z, u8 n, u8 flags, then n x (u8 angle256, u8 halfWidth*4)
"""
import glob, json, math, os, re, struct, sys, zlib
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, 'data/raw/osm'); OUT = os.path.join(ROOT, 'data/baked/towns.bin')
corr = json.load(open(os.path.join(ROOT, 'data/baked/corridor.json')))
LAT0, LON0, MLAT, MLON = corr['lat0'], corr['lon0'], corr['mPerDegLat'], corr['mPerDegLon']
TILE = 1000.0
def W(lat, lon): return ((lon - LON0) * MLON, -(lat - LAT0) * MLAT)

# ---------------------------------------------------------------- helpers
def dp(pts, tol):
    """Douglas-Peucker on [(x,z)] (open polyline)."""
    if len(pts) < 3: return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True; stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop(); ax, az = pts[a]; bx, bz = pts[b]; dx, dz = bx - ax, bz - az; L2 = dx * dx + dz * dz
        best, bi = -1, -1
        for i in range(a + 1, b):
            px, pz = pts[i]
            if L2 < 1e-9: d = math.hypot(px - ax, pz - az)
            else:
                t = max(0, min(1, ((px - ax) * dx + (pz - az) * dz) / L2)); d = math.hypot(px - (ax + t * dx), pz - (az + t * dz))
            if d > best: best, bi = d, i
        if best > tol: keep[bi] = True; stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]

def ring_simplify(ring, tol):
    """Closed ring (no repeated end point) -> simplified closed ring."""
    if len(ring) < 4: return ring
    # split at the two farthest points so DP works on a closed shape
    i0 = 0; far = max(range(len(ring)), key=lambda i: (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2)
    a = dp(ring[i0:far + 1], tol); b = dp(ring[far:] + [ring[0]], tol)
    out = a[:-1] + b[:-1]
    # drop nearly collinear / duplicate vertices
    res = []
    for p in out:
        if res and math.hypot(p[0] - res[-1][0], p[1] - res[-1][1]) < 0.25: continue
        res.append(p)
    return res if len(res) >= 3 else ring

def area(ring):
    s = 0
    for (x1, z1), (x2, z2) in zip(ring, ring[1:] + ring[:1]): s += x1 * z2 - x2 * z1
    return s / 2

def rgb565(c):
    if not c: return 0
    c = c.strip().lower()
    named = {'white': 'ffffff', 'black': '222222', 'grey': '888888', 'gray': '888888', 'red': 'aa4433', 'brown': '7a5a3c',
             'beige': 'd8c8a4', 'yellow': 'e2c86a', 'tan': 'c9ad84', 'blue': '5a78a0', 'green': '5f7f58', 'orange': 'c77a3c',
             'pink': 'd9a0a0', 'cream': 'efe3c8', 'silver': 'b8bcc2', 'darkgrey': '555555', 'darkgray': '555555',
             'lightgrey': 'c8c8c8', 'lightgray': 'c8c8c8', 'maroon': '6e2a2a', 'terracotta': 'b5654a', 'ivory': 'efe8d6'}
    if c in named: c = named[c]
    c = c.lstrip('#')
    if len(c) == 3: c = ''.join(ch * 2 for ch in c)
    if not re.fullmatch(r'[0-9a-f]{6}', c): return 0
    r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
    return v or 1

def num(v):
    if v is None: return None
    v = str(v).strip().lower().replace(',', '.')
    m = re.match(r'^([0-9.]+)\s*(m|ft|\')?', v)
    if not m: return None
    try: x = float(m.group(1))
    except ValueError: return None
    if m.group(2) in ('ft', "'"): x *= 0.3048
    return x

# ---------------------------------------------------------------- regions (for defaults)
def region_of(z):
    lat = LAT0 - z / MLAT
    if lat > 37.708: return 'sf'
    if lat > 37.50: return 'pen_n'
    if lat > 37.415: return 'pen_m'
    if lat > 37.335: return 'southbay'
    if lat > 37.20: return 'sj'
    return 'south'

# ---------------------------------------------------------------- load
def elements(*prefixes):
    files = sorted({f for pre in prefixes for f in glob.glob(os.path.join(RAW, pre + '*.json'))})
    for f in files:
        try: j = json.load(open(f))
        except Exception as e: print('skip', f, e); continue
        for e in j.get('elements', []): yield e

def way_pts(e):
    g = e.get('geometry') or []
    return [W(p['lat'], p['lon']) for p in g if p]

def join_rings(ways):
    """Join member way coordinate lists into closed rings."""
    rings, open_ = [], [list(w) for w in ways if len(w) >= 2]
    while open_:
        cur = open_.pop()
        changed = True
        while changed and not (len(cur) > 3 and math.dist(cur[0], cur[-1]) < 0.5):
            changed = False
            for i, w in enumerate(open_):
                if math.dist(cur[-1], w[0]) < 0.5: cur += w[1:]; open_.pop(i); changed = True; break
                if math.dist(cur[-1], w[-1]) < 0.5: cur += w[::-1][1:]; open_.pop(i); changed = True; break
                if math.dist(cur[0], w[-1]) < 0.5: cur = w[:-1] + cur; open_.pop(i); changed = True; break
                if math.dist(cur[0], w[0]) < 0.5: cur = w[::-1][:-1] + cur; open_.pop(i); changed = True; break
        if len(cur) > 3 and math.dist(cur[0], cur[-1]) < 0.5: rings.append(cur[:-1])
    return rings

def polygons(e):
    """Outer rings of a way or multipolygon relation, as [(x,z)] without repeated end point."""
    if e['type'] == 'way':
        p = way_pts(e)
        if len(p) >= 4 and math.dist(p[0], p[-1]) < 0.5: return [p[:-1]]
        return []
    if e['type'] == 'relation':
        outers = [[W(q['lat'], q['lon']) for q in m.get('geometry', []) if q] for m in e.get('members', [])
                  if m.get('type') == 'way' and m.get('role') in ('outer', '')]
        return join_rings(outers)
    return []

# ---------------------------------------------------------------- buildings
KIND = {'house': 0, 'detached': 0, 'semidetached_house': 0, 'terrace': 1, 'bungalow': 0, 'residential': 1, 'apartments': 1,
        'dormitory': 1, 'hotel': 2, 'commercial': 2, 'retail': 2, 'office': 2, 'supermarket': 2, 'kiosk': 2,
        'industrial': 3, 'warehouse': 3, 'manufacture': 3, 'hangar': 3, 'service': 3, 'storage_tank': 3,
        'school': 4, 'university': 4, 'college': 4, 'church': 4, 'civic': 4, 'public': 4, 'hospital': 4,
        'government': 4, 'fire_station': 4, 'library': 4, 'museum': 4, 'stadium': 4,
        'garage': 5, 'garages': 5, 'shed': 5, 'carport': 5, 'roof': 5, 'greenhouse': 5, 'hut': 5,
        'train_station': 6, 'transportation': 6, 'parking': 7}
ROOF = {'flat': 0, 'gabled': 1, 'hipped': 2, 'pyramidal': 3, 'skillion': 4, 'dome': 5, 'half-hipped': 2, 'mansard': 2,
        'round': 5, 'gambrel': 1, 'saltbox': 1}
buildings = {}
for e in elements('bld_'):
    key = (e['type'], e['id'])
    if key in buildings: continue
    t = e.get('tags', {})
    if t.get('building') in (None, 'no', 'construction', 'ruins', 'demolished'): continue
    for ring in polygons(e):
        if len(ring) < 3: continue
        a = abs(area(ring))
        if a < 12: continue
        ring = ring_simplify(ring, 0.35)
        if area(ring) < 0: ring = ring[::-1]            # CCW in (x,z) math orientation
        cx = sum(p[0] for p in ring) / len(ring); cz = sum(p[1] for p in ring) / len(ring)
        reg = region_of(cz)
        btype = t.get('building', 'yes'); kind = KIND.get(btype, 8)
        h = num(t.get('height')); lv = num(t.get('building:levels')); rl = num(t.get('roof:levels')) or 0
        mh = num(t.get('min_height')) or ((num(t.get('building:min_level')) or 0) * 3.2)
        if kind == 8:  # 'yes': guess from size and region
            if a < 25: kind = 5
            elif a < 260: kind = 0 if reg not in ('sf',) else 1
            elif a < 900: kind = 1 if reg in ('sf',) else 2
            else: kind = 2 if reg in ('sf', 'sj') else 3
        if h is None:
            if lv: h = lv * (3.1 if kind in (0, 1) else 3.8) + (1.8 if kind in (0,) else 0.8) + rl * 2.2
            else:
                h = {0: 6.2, 1: 10.5 if reg == 'sf' else 8.5, 2: 9.0 if reg in ('sf', 'sj') else 6.5, 3: 8.5, 4: 9.0,
                     5: 3.2, 6: 7.0, 7: 9.0}.get(kind, 7.0)
                if reg == 'sf' and kind in (0, 1): h = 9.5 if a < 200 else 12.0
                if kind == 0 and a > 220: h = 7.2
        h = max(2.5, min(h, 330.0)); mh = max(0.0, min(mh, h - 1))
        rs = t.get('roof:shape')
        roof = ROOF.get(rs, -1)
        if roof < 0:
            if kind in (0,) and a < 450 and reg != 'sf': roof = 2 if (int(e['id']) % 3) else 1
            elif kind == 5 and a < 60: roof = 1
            else: roof = 0
        buildings[key] = dict(ring=ring, cx=cx, cz=cz, kind=kind, roof=roof, h=h, mh=mh,
                              wall=rgb565(t.get('building:colour')), roofc=rgb565(t.get('roof:colour')))
print('buildings', len(buildings))

# ---------------------------------------------------------------- roads
CLS = {'motorway': 0, 'motorway_link': 1, 'trunk': 2, 'trunk_link': 3, 'primary': 4, 'primary_link': 5, 'secondary': 6,
       'secondary_link': 7, 'tertiary': 8, 'tertiary_link': 9, 'residential': 10, 'unclassified': 11, 'living_street': 12,
       'service': 13, 'pedestrian': 14}
DEF_LANES = {0: 3, 1: 1, 2: 2, 3: 1, 4: 4, 5: 1, 6: 3, 7: 1, 8: 2, 9: 1, 10: 2, 11: 2, 12: 1, 13: 1, 14: 1}
roads = {}
node_use = defaultdict(int)
def road_elements():
    seen = set()
    for pref in ('roads_', 'svc_', 'misc_'):
        for e in elements(pref):
            if e['type'] != 'way' or e['id'] in seen: continue
            seen.add(e['id']); yield e
for e in road_elements():
    t = e.get('tags', {}); c = CLS.get(t.get('highway'))
    if c is None: continue
    if t.get('area') == 'yes': continue
    if t.get('access') in ('private', 'no') and c >= 13: continue
    if c == 13 and t.get('service') in ('driveway', 'parking_aisle', 'drive-through'): continue
    pts = way_pts(e)
    if len(pts) < 2: continue
    nodes = e.get('nodes') or []
    oneway = t.get('oneway') in ('yes', '1', 'true') or c in (0, 1) and t.get('oneway') != 'no' or t.get('junction') == 'roundabout'
    lanes = None
    try: lanes = int(float(t.get('lanes', '').split(';')[0])) if t.get('lanes') else None
    except ValueError: lanes = None
    if lanes is None: lanes = DEF_LANES[c] if not (oneway and c in (4, 6, 8, 10)) else max(1, DEF_LANES[c] // 2)
    lanes = max(1, min(lanes, 8))
    lw = 3.6 if c <= 3 else 3.3 if c <= 9 else 3.0
    width = lanes * lw
    if c in (0, 2) : width += 3.0 + (1.2 if oneway else 0)       # shoulders
    elif c in (1, 3): width += 2.0
    elif c in (10, 11): width = max(width, 7.2) + (4.6 if region_of(pts[0][1]) != 'south' else 1.0)  # parking lanes
    elif c == 12: width = max(width, 6.0)
    elif c == 13: width = max(width, 4.2)
    elif c == 14: width = max(width, 5.0)
    elif c in (4, 6, 8): width += 1.0 + (2.4 if c in (6, 8) else 0)
    layer = 0
    try: layer = int(t.get('layer', '0'))
    except ValueError: layer = 0
    bridge = t.get('bridge') not in (None, 'no'); tunnel = t.get('tunnel') not in (None, 'no') or t.get('covered') == 'yes'
    if bridge and layer <= 0: layer = 1
    roads[e['id']] = dict(pts=pts, nodes=nodes, cls=c, oneway=oneway, lanes=lanes, width=min(width, 60), bridge=bridge,
                          tunnel=tunnel, layer=max(0, min(layer, 3)), name=t.get('name', ''), ref=t.get('ref', ''))
    for n in nodes: node_use[n] += 1
print('roads', len(roads))

# node positions & intersections
node_pos = {}
for r in roads.values():
    for n, p in zip(r['nodes'], r['pts']): node_pos[n] = p
ends = defaultdict(int)
for r in roads.values():
    if r['nodes']: ends[r['nodes'][0]] += 1; ends[r['nodes'][-1]] += 1
inter_nodes = {n for n, k in node_use.items() if k >= 2}

# ---------------------------------------------------------------- urban flag (road density) and station proximity
stations_w = [W(s['lat'], s['lon']) for s in corr['stations']]
dens = defaultdict(float)
for r in roads.values():
    if r['cls'] >= 10:
        for a, b in zip(r['pts'], r['pts'][1:]): dens[(int(a[0] // 250), int(a[1] // 250))] += math.dist(a, b)
def urban_at(x, z):
    k = (int(x // 250), int(z // 250)); s = 0
    for dx in (-1, 0, 1):
        for dz in (-1, 0, 1): s += dens.get((k[0] + dx, k[1] + dz), 0)
    return s > 2600 or min(math.dist((x, z), p) for p in stations_w) < 1500

# 'core' flag: downtown blocks (building footprint coverage > 28% over ~150 m) get wide sidewalks, tree wells, no verge
cover = defaultdict(float)
for bd in buildings.values(): cover[(int(bd['cx'] // 50), int(bd['cz'] // 50))] += abs(area(bd['ring']))
def core_at(x, z):
    k = (int(x // 50), int(z // 50)); s = 0
    for dx in (-1, 0, 1):
        for dz in (-1, 0, 1): s += cover.get((k[0] + dx, k[1] + dz), 0)
    return s > 0.28 * 150 * 150

# ---------------------------------------------------------------- areas
AREA_KIND = {'park': 0, 'garden': 0, 'village_green': 0, 'recreation_ground': 0, 'grass': 0, 'dog_park': 0,
             'pitch': 1, 'sports_centre': 1, 'playground': 2, 'parking': 3, 'pedestrian': 4, 'square': 4, 'cemetery': 5, 'allotments': 6}
areas = {}
for e in elements('area_', 'misc_'):
    key = (e['type'], e['id'])
    if key in areas: continue
    t = e.get('tags', {})
    k = None
    for tag in ('leisure', 'landuse', 'amenity', 'highway', 'place'):
        if tag == 'highway' and t.get('area') != 'yes': continue
        if t.get(tag) in AREA_KIND: k = AREA_KIND[t[tag]]; break
    if k is None: continue
    if k == 3 and t.get('parking') in ('underground', 'multi-storey', 'rooftop'): continue
    for ring in polygons(e):
        if abs(area(ring)) < 40: continue
        ring = ring_simplify(ring, 1.0)
        if area(ring) < 0: ring = ring[::-1]
        areas[key] = dict(ring=ring, kind=k, cx=sum(p[0] for p in ring) / len(ring), cz=sum(p[1] for p in ring) / len(ring))
print('areas', len(areas))

# ---------------------------------------------------------------- trees
trees = {}
for e in elements('tree_', 'misc_'):
    t = e.get('tags', {})
    if t.get('natural') not in ('tree', 'tree_row'): continue
    genus = (t.get('genus', '') + ' ' + t.get('species', '') + ' ' + t.get('taxon', '')).lower()
    kind = 0
    if any(g in genus for g in ('phoenix', 'washingtonia', 'syagrus', 'palm', 'trachycarpus')): kind = 1
    elif any(g in genus for g in ('sequoia', 'pinus', 'cedrus', 'cupressus', 'pine', 'redwood', 'cedar')) or t.get('leaf_type') == 'needleleaved': kind = 2
    elif 'eucalyptus' in genus: kind = 3
    size = 2 if kind == 1 else 1
    try:
        hh = num(t.get('height'));
        if hh: size = 0 if hh < 6 else 1 if hh < 12 else 2 if hh < 20 else 3
    except Exception: pass
    if e['type'] == 'node':
        trees[e['id']] = (*W(e['lat'], e['lon']), kind, size)
    elif e['type'] == 'way':
        pts = way_pts(e); acc = 0
        for a, b in zip(pts, pts[1:]):
            L = math.dist(a, b); d = 4.0 - acc
            while d <= L:
                trees[(e['id'], round(d, 1), a)] = (a[0] + (b[0] - a[0]) * d / L, a[1] + (b[1] - a[1]) * d / L, kind, size); d += 8
            acc = (acc + L) % 8
print('trees', len(trees))

# ---------------------------------------------------------------- tiling
tiles = defaultdict(lambda: dict(b=[], r=[], a=[], t=[], i=[]))
def tkey(x, z): return (int(math.floor(x / TILE)), int(math.floor(z / TILE)))

for b in buildings.values(): tiles[tkey(b['cx'], b['cz'])]['b'].append(b)
for a in areas.values(): tiles[tkey(a['cx'], a['cz'])]['a'].append(a)
for tr in trees.values(): tiles[tkey(tr[0], tr[1])]['t'].append(tr)

def split_polyline(pts):
    """Split a polyline of (x, z, off) at 1 km tile boundaries; returns [(tilekey, [pts...])]."""
    out = []; cur = [pts[0]]; ck = tkey(pts[0][0], pts[0][1])
    for a, b in zip(pts, pts[1:]):
        ts = []
        ax, az, ao = a; bx, bz, bo = b
        for k in range(int(math.floor(min(ax, bx) / TILE)) + 1, int(math.floor(max(ax, bx) / TILE)) + 1):
            if bx != ax: ts.append((k * TILE - ax) / (bx - ax))
        for k in range(int(math.floor(min(az, bz) / TILE)) + 1, int(math.floor(max(az, bz) / TILE)) + 1):
            if bz != az: ts.append((k * TILE - az) / (bz - az))
        for t in sorted(x for x in ts if 0 < x < 1):
            p = (ax + (bx - ax) * t, az + (bz - az) * t, ao + (bo - ao) * t)
            cur.append(p); out.append((ck, cur))
            ck = tkey(p[0] + (bx - ax) * 1e-6, p[1] + (bz - az) * 1e-6); cur = [p]
        cur.append(b)
    out.append((ck, cur))
    return [(k, c) for k, c in out if len(c) >= 2 and sum(math.dist(u[:2], v[:2]) for u, v in zip(c, c[1:])) > 0.3]

nroad_pieces = 0; ncore = 0
for rid, r in roads.items():
    if r['tunnel']: continue
    tol = 1.2 if r['cls'] <= 9 else 0.8
    pts = r['pts']
    # simplify but keep intersection vertices exactly
    keep_idx = [i for i, n in enumerate(r['nodes']) if n in inter_nodes] if r['nodes'] else []
    anchors = sorted(set([0, len(pts) - 1] + keep_idx))
    simp = []
    for i0, i1 in zip(anchors, anchors[1:]):
        seg = dp(pts[i0:i1 + 1], tol)
        simp += seg if not simp else seg[1:]
    mid = pts[len(pts) // 2]
    urban = urban_at(*mid)
    core = urban and r['cls'] >= 4 and (core_at(*mid) or core_at(*pts[0]) and core_at(*pts[-1]))
    flags = (1 if r['oneway'] else 0) | (2 if r['bridge'] else 0) | (4 if core else 0) | (8 if urban else 0) | (r['layer'] << 4)
    ncore += 1 if core else 0
    # bridge decks rise to layer * 6.5 m over the middle and meet the ground at both ends
    L = sum(math.dist(a, b) for a, b in zip(simp, simp[1:])) or 1.0
    ramp = max(8.0, min(L * 0.45, 70.0)); acc = 0.0; p3 = []
    for i, p in enumerate(simp):
        if i: acc += math.dist(simp[i - 1], p)
        off = (max(1, r['layer']) * 6.5 * min(1.0, acc / ramp, (L - acc) / ramp)) if r['bridge'] else 0.0
        p3.append((p[0], p[1], max(0.0, off)))
    for k, piece in split_polyline(p3):
        tiles[k]['r'].append(dict(pts=piece, cls=r['cls'], flags=flags, lanes=r['lanes'], width=r['width']))
        nroad_pieces += 1
print('road pieces', nroad_pieces, 'core roads', ncore)

# intersections with approach directions
ninter = 0
by_node = defaultdict(list)
for r in roads.values():
    if r['tunnel'] or not r['nodes']: continue
    for i, n in enumerate(r['nodes']):
        if n not in inter_nodes: continue
        p = r['pts'][i]
        for j in (i - 1, i + 1):
            if 0 <= j < len(r['pts']):
                q = r['pts'][j]
                by_node[n].append((math.atan2(q[1] - p[1], q[0] - p[0]), r['width'] / 2, r['cls']))
for n, apps in by_node.items():
    if len(apps) < 3: continue
    if any(c <= 3 for _, _, c in apps): continue           # no crosswalks on freeway ramps
    x, z = node_pos[n]
    urban = urban_at(x, z)
    flags = (8 if urban else 0) | (1 if max(c for _, _, c in apps) >= 10 and min(c for _, _, c in apps) >= 10 else 0)
    tiles[tkey(x, z)]['i'].append((x, z, flags, apps[:8])); ninter += 1
print('intersections', ninter)

# ---------------------------------------------------------------- encode
def q(v): return int(round(v * 10))
def enc_pts(pts, ox, oz):
    out = bytearray(); px = pz = 0
    for i, p in enumerate(pts):
        x, z = p[0], p[1]
        X, Z = q(x - ox), q(z - oz)
        dx, dz = (X, Z) if i == 0 else (X - px, Z - pz)
        dx = max(-32768, min(32767, dx)); dz = max(-32768, min(32767, dz))
        out += struct.pack('<hh', dx, dz); px, pz = (px + dx, pz + dz) if i else (dx, dz)
    return out

blobs = []
for (tx, tz), T in sorted(tiles.items()):
    ox, oz = tx * TILE, tz * TILE
    B = bytearray(struct.pack('<6H', min(len(T['b']), 65535), min(len(T['r']), 65535), len(T['a']), len(T['t']), len(T['i']), 0))
    for b in T['b'][:65535]:
        ring = b['ring']
        B += struct.pack('<BBHHHHH', b['kind'], b['roof'], min(65535, int(b['h'] * 4)), min(65535, int(b['mh'] * 4)), b['wall'], b['roofc'], len(ring))
        B += enc_pts(ring, ox, oz)
    for r in T['r'][:65535]:
        B += struct.pack('<BBBBH', r['cls'], r['flags'], r['lanes'], min(255, int(r['width'] * 4)), len(r['pts']))
        B += enc_pts(r['pts'], ox, oz)
        if r['flags'] & 2: B += bytes(min(255, int(round(p[2] * 4))) for p in r['pts'])
    for a in T['a']:
        B += struct.pack('<BBH', a['kind'], 0, len(a['ring'])) + enc_pts(a['ring'], ox, oz)
    for x, z, kind, size in T['t']:
        B += struct.pack('<hhBB', q(x - ox), q(z - oz), kind, size)
    for x, z, flags, apps in T['i']:
        B += struct.pack('<hhBB', q(x - ox), q(z - oz), len(apps), flags)
        for ang, hw, _c in apps: B += struct.pack('<BB', int(((ang % (2 * math.pi)) / (2 * math.pi)) * 256) & 255, min(255, int(hw * 4)))
    blobs.append((tx, tz, bytes(B)))

head = bytearray(b'BLT2' + struct.pack('<I', len(blobs)))
off = len(head) + 12 * len(blobs)
body = bytearray()
for tx, tz, b in blobs:
    head += struct.pack('<hhII', tx, tz, off + len(body), len(b)); body += b
raw = bytes(head + body)
z = zlib.compress(raw, 9)
open(OUT, 'wb').write(z)
print(f'tiles {len(blobs)}, raw {len(raw)/1e6:.2f} MB, zlib {len(z)/1e6:.2f} MB -> {OUT}')
