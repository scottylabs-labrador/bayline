#!/usr/bin/env python3
"""Fetch the OpenStreetMap data for Bayline's towns (buildings, streets, parks, parking, trees).

Data (c) OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright

Two ways to get the same data into data/raw/osm/*.json (Overpass "out geom" JSON, read by bake_towns.py):

  1. PBF extract (recommended; ~2 min, complete, deterministic):
       pip install osmium            # pyosmium
       python3 tools/fetch_osm.py --pbf
     downloads Geofabrik's NorCal extract (~650 MB, deleted afterwards unless --keep-pbf), keeps only what
     lies inside the corridor selection below, and writes roads_pbf.json, bld_pbf.json, misc_pbf.json.

  2. Overpass API (slow: ~110 queries; public servers rate-limit):
       python3 tools/fetch_osm.py            # fetch everything missing (cached per query)
       python3 tools/fetch_osm.py --list     # show the query plan
       python3 tools/fetch_osm.py --reverse --server=1 &   # a second fetcher on a mirror, from the other end

Selection (both paths): motorways/trunks within 6.5 km of the line, primary/secondary 3.2 km, tertiary 2.6 km,
residential streets 1.6 km; buildings, parks, parking, plazas within 800-900 m of each station (+ SoMa/Mission Bay
and downtown San Jose cores; the PBF path also keeps buildings within BAND_BLD m of the tracks); service lanes
and alleys within 600 m and mapped trees within 700 m of a station.
"""
import json, math, os, re, sys, time
import requests

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, 'data/raw/osm'); os.makedirs(RAW, exist_ok=True)
ENDPOINTS = ['https://overpass-api.de/api/interpreter',
             'https://overpass.kumi.systems/api/interpreter',
             'https://maps.mail.ru/osm/tools/overpass/api/interpreter']
UA = 'Bayline-rail-sim/1.0 (ScottyLabs student project; data pipeline)'

corr = json.load(open(os.path.join(ROOT, 'data/baked/corridor.json')))
LAT0, LON0, MLAT, MLON = corr['lat0'], corr['lon0'], corr['mPerDegLat'], corr['mPerDegLon']
def w(lat, lon): return ((lon - LON0) * MLON, -(lat - LAT0) * MLAT)

def resample(pts, step):
    """Polyline [(lat,lon)] -> points roughly every `step` meters (keeps both ends)."""
    out = [pts[0]]; acc = 0.0
    for a, b in zip(pts, pts[1:]):
        acc += math.dist(w(*a), w(*b))
        if acc >= step: out.append(b); acc = 0.0
    if out[-1] != pts[-1]: out.append(pts[-1])
    return out

MAIN = [tuple(p) for p in corr['mainline']['pts']]
SOUTH = [tuple(p) for p in corr['southCounty']['pts']]
STATIONS = corr['stations']

def chunks(line, n_m):
    """Split a polyline into pieces of about n_m meters (with 1 point overlap)."""
    pieces, cur, acc = [], [line[0]], 0.0
    for a, b in zip(line, line[1:]):
        cur.append(b); acc += math.dist(w(*a), w(*b))
        if acc >= n_m: pieces.append(cur); cur, acc = [b], 0.0
    if len(cur) > 1: pieces.append(cur)
    return pieces

def around_line(r, line):
    pts = resample(line, 600)
    return f"around:{r}," + ",".join(f"{la:.5f},{lo:.5f}" for la, lo in pts)

HW_MAJOR = 'motorway|motorway_link|trunk|trunk_link'
HW_ART = 'primary|primary_link|secondary|secondary_link'
HW_TER = 'tertiary|tertiary_link'
HW_MINOR = 'residential|unclassified|living_street'

def plan():
    q = []
    # --- roads, per ~15 km chunk of the line so each query stays small ---
    for name, line in (('main', MAIN), ('south', SOUTH)):
        for i, part in enumerate(chunks(line, 15000)):
            q.append((f'roads_major_{name}{i}', f'way["highway"~"^({HW_MAJOR})$"]({around_line(6500, part)});'))
            q.append((f'roads_art_{name}{i}', f'way["highway"~"^({HW_ART})$"]({around_line(3200, part)});'))
            q.append((f'roads_ter_{name}{i}', f'way["highway"~"^({HW_TER})$"]({around_line(2600, part)});'))
            q.append((f'roads_minor_{name}{i}', f'way["highway"~"^({HW_MINOR})$"]({around_line(1600, part)});'))
    # --- per-station: buildings, parks/plazas/parking, trees, service lanes/alleys ---
    for s in STATIONS:
        la, lo = s['lat'], s['lon']; sid = s['id']
        r = 900 if sid in ('san_francisco', '22nd_street', 'sj_diridon', 'palo_alto', 'mountain_view', 'redwood_city', 'san_mateo', 'burlingame') else 800
        q.append((f'bld_{sid}', f'way["building"](around:{r},{la},{lo});relation["building"](around:{r},{la},{lo});'))
        q.append((f'misc_{sid}', (f'way["leisure"~"^(park|playground|pitch|garden|dog_park|sports_centre)$"](around:{r},{la},{lo});'
                                   f'way["landuse"~"^(grass|recreation_ground|village_green|cemetery|allotments)$"](around:{r},{la},{lo});'
                                   f'way["amenity"="parking"](around:{r},{la},{lo});'
                                   f'way["highway"="pedestrian"]["area"="yes"](around:{r},{la},{lo});'
                                   f'way["place"="square"](around:{r},{la},{lo});'
                                   f'relation["leisure"="park"](around:{r},{la},{lo});'
                                   f'way["highway"~"^(service|pedestrian)$"]["service"!~"driveway|parking_aisle|drive-through"]["area"!="yes"](around:{min(r,600)},{la},{lo});'
                                   f'node["natural"="tree"](around:{min(r,700)},{la},{lo});way["natural"="tree_row"](around:{min(r,700)},{la},{lo});')))
    # --- dense cores: SoMa / Financial District / Mission Bay / Mission, and downtown San Jose ---
    for name, bb in (('sf_core_a', (37.7740, -122.4200, 37.8010, -122.3860)),
                     ('sf_core_b', (37.7580, -122.4250, 37.7740, -122.3840)),
                     ('sj_core', (37.3240, -121.9020, 37.3440, -121.8780))):
        b = f'{bb[0]},{bb[1]},{bb[2]},{bb[3]}'
        q.append((f'bld_{name}', f'way["building"]({b});relation["building"]({b});'))
        q.append((f'roads_minor_{name}', f'way["highway"~"^({HW_MINOR}|{HW_TER}|{HW_ART}|service|pedestrian)$"]["service"!~"driveway|parking_aisle|drive-through"]({b});'))
        q.append((f'area_{name}', f'way["leisure"~"^(park|playground|pitch|garden)$"]({b});way["amenity"="parking"]({b});relation["leisure"="park"]({b});'))
    return q

def fetch(name, body, timeout=240, prefer=0):
    path = os.path.join(RAW, name + '.json')
    if os.path.exists(path) and os.path.getsize(path) > 50: return 'cached'
    lock = path + '.lock'                  # lets several fetchers (one per server) share the plan
    try:
        if os.path.exists(lock) and time.time() - os.path.getmtime(lock) > 900: os.remove(lock)
        os.close(os.open(lock, os.O_CREAT | os.O_EXCL))
    except FileExistsError:
        return 'busy (another fetcher has it)'
    try:
        return _fetch(name, body, path, timeout, prefer)
    finally:
        try: os.remove(lock)
        except OSError: pass

def _fetch(name, body, path, timeout, prefer):
    query = f'[out:json][timeout:{timeout}];({body});out geom;'
    last = None
    # preferred server first; on 429/busy wait and retry it; fall back to the others after that
    others = [i for i in range(len(ENDPOINTS)) if i != prefer]
    order = [prefer, prefer, others[0], prefer, others[1], prefer, others[0], prefer]
    for attempt, ei in enumerate(order):
        ep = ENDPOINTS[ei]
        try:
            r = requests.post(ep, data={'data': query}, headers={'User-Agent': UA}, timeout=timeout + 60)
            if r.status_code != 200: raise RuntimeError(f'HTTP {r.status_code}')
            raw = r.content
            j = json.loads(raw)
            if 'remark' in j and 'runtime error' in j.get('remark', ''): raise RuntimeError(j['remark'][:200])
            open(path + '.part', 'wb').write(raw); os.replace(path + '.part', path)
            return f'{len(j.get("elements", []))} elements, {len(raw)/1e6:.1f} MB from {ep.split("/")[2]}'
        except Exception as e:  # noqa: BLE001
            last = e; wait = 12 + 6 * attempt
            print(f'   {name}: {type(e).__name__} {str(e)[:100]} on {ep.split("/")[2]}; retry in {wait}s', flush=True)
            time.sleep(wait)
    raise SystemExit(f'giving up on {name}: {last}')

# ---------------------------------------------------------------- PBF path
PBF_URL = 'https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf'
BIG = ('san_francisco', '22nd_street', 'sj_diridon', 'palo_alto', 'mountain_view', 'redwood_city', 'san_mateo', 'burlingame')
CORES = {'sf_core_a': (37.7740, -122.4200, 37.8010, -122.3860), 'sf_core_b': (37.7580, -122.4250, 37.7740, -122.3840),
         'sj_core': (37.3240, -121.9020, 37.3440, -121.8780)}
BAND_BLD = 170          # real buildings along the whole line, not just at stations
CELL = 25.0             # distance-raster resolution (m)

def pbf_extract(pbf):
    import numpy as np
    from scipy import ndimage
    import osmium
    t0 = time.time()
    # --- distance rasters: to the track centerlines, and to stations (big / other)
    x0, x1, z0, z1 = -44000.0, 60000.0, -52000.0, 53000.0
    NX, NZ = int((x1 - x0) / CELL), int((z1 - z0) / CELL)
    def raster(points):
        m = np.ones((NZ, NX), bool)
        for x, z in points:
            i, j = int((x - x0) / CELL), int((z - z0) / CELL)
            if 0 <= i < NX and 0 <= j < NZ: m[j, i] = False
        return ndimage.distance_transform_edt(m).astype(np.float32) * CELL
    line_pts = []
    for line in (MAIN, SOUTH):
        P = [w(*p) for p in line]
        for (ax, az), (bx, bz) in zip(P, P[1:]):
            n = max(1, int(math.hypot(bx - ax, bz - az) / (CELL * 0.5)))
            line_pts += [(ax + (bx - ax) * k / n, az + (bz - az) * k / n) for k in range(n)]
    d_line = raster(line_pts)
    d_big = raster([w(s['lat'], s['lon']) for s in STATIONS if s['id'] in BIG])
    d_oth = raster([w(s['lat'], s['lon']) for s in STATIONS if s['id'] not in BIG])
    print(f'rasters {NX}x{NZ} in {time.time()-t0:.0f}s', flush=True)
    def look(arr, lat, lon):
        x, z = w(lat, lon); i, j = int((x - x0) / CELL), int((z - z0) / CELL)
        return arr[j, i] if 0 <= i < NX and 0 <= j < NZ else 1e9
    def in_core(lat, lon):
        return any(b[0] <= lat <= b[2] and b[1] <= lon <= b[3] for b in CORES.values())
    def near_station(lat, lon, extra=0):
        return look(d_big, lat, lon) <= 900 + extra or look(d_oth, lat, lon) <= 800 + extra
    R_CLASS = {}
    for k in HW_MAJOR.split('|'): R_CLASS[k] = 6500
    for k in HW_ART.split('|'): R_CLASS[k] = 3200
    for k in HW_TER.split('|'): R_CLASS[k] = 2600
    for k in HW_MINOR.split('|'): R_CLASS[k] = 1600
    AREA_TAGS = {'leisure': {'park', 'playground', 'pitch', 'garden', 'dog_park', 'sports_centre'},
                 'landuse': {'grass', 'recreation_ground', 'village_green', 'cemetery', 'allotments'},
                 'amenity': {'parking'}, 'place': {'square'}}
    def is_area_feature(t):
        if any(t.get(k) in v for k, v in AREA_TAGS.items()): return True
        return t.get('highway') == 'pedestrian' and t.get('area') == 'yes'
    roads, blds, misc = [], [], []
    def geom(nodes):
        return [{'lat': round(n.lat, 7), 'lon': round(n.lon, 7)} for n in nodes]
    fp = (osmium.FileProcessor(pbf)
          .with_locations('sparse_mem_array')
          .with_areas(osmium.filter.KeyFilter('building', 'leisure', 'landuse', 'amenity', 'place', 'highway'))
          .with_filter(osmium.filter.KeyFilter('highway', 'building', 'leisure', 'landuse', 'amenity', 'natural', 'place')))
    n_seen = 0
    for o in fp:
        n_seen += 1
        if n_seen % 2_000_000 == 0: print(f'  {n_seen/1e6:.0f}M objects, {len(roads)} roads {len(blds)} buildings {len(misc)} misc, {time.time()-t0:.0f}s', flush=True)
        if o.is_node():
            if o.tags.get('natural') == 'tree':
                la, lo = o.location.lat, o.location.lon
                if look(d_big, la, lo) <= 700 or look(d_oth, la, lo) <= 700:
                    misc.append({'type': 'node', 'id': o.id, 'lat': round(la, 7), 'lon': round(lo, 7), 'tags': dict(o.tags)})
            continue
        if o.is_way():
            t = o.tags; hw = t.get('highway')
            try: nodes = list(o.nodes); first = nodes[0]; la, lo = first.lat, first.lon
            except (osmium.InvalidLocationError, IndexError): continue
            if hw and t.get('area') != 'yes':
                r = R_CLASS.get(hw)
                svc = hw in ('service', 'pedestrian') and not re.search('driveway|parking_aisle|drive-through', t.get('service', ''))
                if r is None and not svc: continue
                ok = False
                for n in nodes[::max(1, len(nodes) // 12)] + [nodes[-1]]:
                    if r is not None and look(d_line, n.lat, n.lon) <= r: ok = True; break
                    if (svc or r is not None) and (in_core(n.lat, n.lon) or (svc and near_station(n.lat, n.lon, -200))): ok = True; break
                if ok:
                    roads.append({'type': 'way', 'id': o.id, 'tags': dict(t), 'nodes': [n.ref for n in nodes], 'geometry': geom(nodes)})
                continue
            if t.get('natural') == 'tree_row':
                if look(d_big, la, lo) <= 700 or look(d_oth, la, lo) <= 700:
                    misc.append({'type': 'way', 'id': o.id, 'tags': dict(t), 'nodes': [n.ref for n in nodes], 'geometry': geom(nodes)})
            continue
        if o.is_area():
            t = o.tags; bld = t.get('building'); feat = is_area_feature(t)
            if not bld and not feat: continue
            try:
                rings = [geom(r) for r in o.outer_rings()]
            except osmium.InvalidLocationError: continue
            if not rings or not rings[0]: continue
            la, lo = rings[0][0]['lat'], rings[0][0]['lon']
            pts = [p for r in rings for p in r[::max(1, len(r) // 8)]]
            if bld:
                keep = any(near_station(p['lat'], p['lon']) or in_core(p['lat'], p['lon']) or look(d_line, p['lat'], p['lon']) <= BAND_BLD for p in pts)
            else:
                keep = any(near_station(p['lat'], p['lon']) or in_core(p['lat'], p['lon']) for p in pts)
            if not keep: continue
            if o.from_way():
                e = {'type': 'way', 'id': o.orig_id(), 'tags': dict(t), 'geometry': rings[0]}
            else:
                e = {'type': 'relation', 'id': o.orig_id(), 'tags': dict(t),
                     'members': [{'type': 'way', 'role': 'outer', 'geometry': r} for r in rings]}
            (blds if bld else misc).append(e)
    for name, els in (('roads_pbf', roads), ('bld_pbf', blds), ('misc_pbf', misc)):
        path = os.path.join(RAW, name + '.json')
        with open(path + '.part', 'w') as f: json.dump({'generator': 'bayline fetch_osm.py --pbf (Geofabrik NorCal)', 'copyright': '(c) OpenStreetMap contributors, ODbL 1.0', 'elements': els}, f, separators=(',', ':'))
        os.replace(path + '.part', path)
        print(f'{name}: {len(els)} elements, {os.path.getsize(path)/1e6:.1f} MB', flush=True)
    print(f'pbf extract done in {time.time()-t0:.0f}s')

if __name__ == '__main__':
    if '--pbf' in sys.argv:
        pbf = os.path.join(RAW, 'norcal-latest.osm.pbf')
        if not os.path.exists(pbf):
            print('downloading', PBF_URL, flush=True)
            with requests.get(PBF_URL, stream=True, headers={'User-Agent': UA}, timeout=120) as r:
                r.raise_for_status()
                with open(pbf + '.part', 'wb') as f:
                    for chunk in r.iter_content(1 << 20): f.write(chunk)
            os.replace(pbf + '.part', pbf)
        pbf_extract(pbf)
        if '--keep-pbf' not in sys.argv: os.remove(pbf)
        sys.exit()
    P = plan()
    if '--list' in sys.argv:
        for n, b in P: print(n, len(b))
        sys.exit()
    only = [a for a in sys.argv[1:] if not a.startswith('--')]
    prefer = next((int(a.split('=')[1]) for a in sys.argv if a.startswith('--server=')), 0)
    order = list(enumerate(P))
    if '--reverse' in sys.argv: order.reverse()
    t0 = time.time()
    for i, (n, b) in order:
        if only and not any(n.startswith(o) for o in only): continue
        res = fetch(n, b, prefer=prefer)
        print(f'[{i+1}/{len(P)}] {n}: {res}  ({time.time()-t0:.0f}s)', flush=True)
        if res != 'cached': time.sleep(2.5)
    print('done')
