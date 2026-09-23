#!/usr/bin/env python3
"""Bake real station details from OpenStreetMap for Bayline's stations (25_stations.js).

One filtered pass over the Geofabrik NorCal PBF (data/raw/osm/norcal-latest.osm.pbf) keeps everything
mapped around each of the 31 stations that makes a station look like itself:
  depot     station buildings (building=train_station|transportation, railway=station + building …)
  roof      canopies (building=roof, covered platforms) and shelters mapped as areas
  points    benches, bins, ticket machines, validators, bike parking, lamps, CCTV, help points,
            information boards, clocks, elevators, pedestrian rail crossings, shelters as nodes
  tunnels   pedestrian underpasses (footway/steps/path with tunnel or layer < 0)
  bridges   pedestrian overpasses (footway/steps with bridge=yes)
  steps     stairways
  fences    fences/railings/walls within the station area
Output: data/pub/v2/stations/osm.json (lat/lon; the runtime projects with Geo and the track).

    pip install osmium
    python3 tools/bake_stations.py
"""
import json, math, os, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PBF = os.path.join(ROOT, 'data/raw/osm/norcal-latest.osm.pbf')
if not os.path.exists(PBF):
    PBF = os.path.join(ROOT, 'data/raw/osm_pbf/norcal-latest.osm.pbf')
OUT = os.path.join(ROOT, 'data/pub/v2/stations/osm.json')
R_M = 420.0                                   # capture radius around each station (m)

track = json.load(open(os.path.join(ROOT, 'data/baked/track.json')))
STATIONS = [(s['id'], s['lat'], s['lon']) for s in track['stations']]
DLAT = R_M / 110985.1
DLON = R_M / 88542.2


def which(lat, lon):
    """station id whose capture box contains (lat, lon), nearest first, or None."""
    best, bd = None, 1e18
    for sid, la, lo in STATIONS:
        if abs(lat - la) <= DLAT and abs(lon - lo) <= DLON:
            d = (lat - la) ** 2 + ((lon - lo) * 0.795) ** 2
            if d < bd: bd, best = d, sid
    return best


def rnd(v): return round(v, 7)


def num(s, default=None):
    if s is None: return default
    try:
        s = str(s).strip().lower().replace('m', '').replace("'", '').strip()
        return float(s.split(';')[0])
    except Exception:
        return default


POINT_KINDS = [
    ('bench', lambda t: t.get('amenity') == 'bench' or t.get('leisure') == 'picnic_table'),
    ('bin', lambda t: t.get('amenity') in ('waste_basket', 'recycling', 'waste_disposal')),
    ('tvm', lambda t: t.get('amenity') == 'vending_machine' and ('ticket' in t.get('vending', '') or 'public_transport' in t.get('vending', ''))),
    ('validator', lambda t: t.get('amenity') == 'ticket_validator' or t.get('vending') == 'fare_validator'),
    ('bikepark', lambda t: t.get('amenity') == 'bicycle_parking'),
    ('lamp', lambda t: t.get('highway') == 'street_lamp' or t.get('man_made') == 'street_lamp'),
    ('cctv', lambda t: t.get('man_made') == 'surveillance'),
    ('help', lambda t: t.get('emergency') == 'phone' or t.get('amenity') == 'emergency_phone'),
    ('info', lambda t: t.get('tourism') == 'information' and t.get('information') in ('board', 'map', 'terminal', 'office', None)),
    ('clock', lambda t: t.get('amenity') == 'clock'),
    ('elevator', lambda t: t.get('highway') == 'elevator'),
    ('pedxing', lambda t: t.get('railway') == 'crossing'),
    ('shelter', lambda t: t.get('amenity') == 'shelter' or t.get('shelter') == 'yes' or t.get('highway') == 'platform' and t.get('shelter') == 'yes'),
    ('toilets', lambda t: t.get('amenity') == 'toilets'),
    ('fountain', lambda t: t.get('amenity') == 'drinking_water'),
    ('post_box', lambda t: t.get('amenity') == 'post_box'),
]


def depot_like(t):
    b = t.get('building')
    if not b: return False
    if b in ('train_station', 'transportation', 'station'): return True
    if t.get('railway') in ('station', 'halt') or t.get('public_transport') == 'station': return True
    n = (t.get('name') or '').lower()
    return b not in ('roof', 'house', 'residential', 'apartments', 'garage', 'garages') and ('station' in n or 'depot' in n or 'caltrain' in n)


def main():
    import osmium
    t0 = time.time()
    out = {sid: {'depot': [], 'roof': [], 'points': {}, 'tunnels': [], 'bridges': [], 'steps': [], 'fences': []} for sid, _, _ in STATIONS}
    keys = ('building', 'amenity', 'railway', 'public_transport', 'highway', 'barrier', 'man_made', 'tourism', 'emergency', 'leisure', 'shelter', 'covered')
    fp = (osmium.FileProcessor(PBF)
          .with_locations('sparse_mem_array')
          .with_areas(osmium.filter.KeyFilter('building', 'amenity'))
          .with_filter(osmium.filter.KeyFilter(*keys)))
    n_obj = 0
    for o in fp:
        n_obj += 1
        if n_obj % 500000 == 0:
            print(f'  {n_obj:,} objects, {time.time() - t0:.0f}s', flush=True)
        t = {tag.k: tag.v for tag in o.tags}
        if o.is_node():
            try: la, lo = o.location.lat, o.location.lon
            except osmium.InvalidLocationError: continue
            sid = which(la, lo)
            if not sid: continue
            for kind, test in POINT_KINDS:
                if test(t):
                    rec = [rnd(la), rnd(lo)]
                    extra = {}
                    if kind == 'bikepark':
                        extra = {k: t[k] for k in ('capacity', 'bicycle_parking', 'covered') if k in t}
                    if kind == 'shelter':
                        extra = {k: t[k] for k in ('shelter_type', 'bench', 'bin') if k in t}
                    if kind == 'pedxing':
                        extra = {k: t[k] for k in ('crossing', 'crossing:barrier', 'crossing:light', 'crossing:bell') if k in t}
                    if extra: rec.append(extra)
                    out[sid]['points'].setdefault(kind, []).append(rec)
                    break
        elif o.is_area():
            try:
                rings = []
                for outer in o.outer_rings():
                    rings.append([[rnd(n.lat), rnd(n.lon)] for n in outer])
            except osmium.InvalidLocationError:
                continue
            if not rings or len(rings[0]) < 4: continue
            ring = rings[0]
            cla = sum(p[0] for p in ring) / len(ring); clo = sum(p[1] for p in ring) / len(ring)
            sid = which(cla, clo)
            if not sid: continue
            base = {'ring': ring}
            for k in ('height', 'min_height', 'building:levels', 'roof:shape', 'roof:colour', 'building:colour', 'building:material', 'layer', 'name', 'level'):
                if k in t: base[k.replace('building:', '').replace(':', '_')] = t[k]
            b = t.get('building')
            if b == 'roof' or (b and t.get('covered') == 'yes' and t.get('railway') == 'platform'):
                out[sid]['roof'].append(base)
            elif t.get('amenity') == 'shelter' or t.get('shelter_type') == 'public_transport':
                base['shelter'] = 1; out[sid]['roof'].append(base)
            elif depot_like(t):
                base['building'] = b; out[sid]['depot'].append(base)
        elif o.is_way():
            if o.is_closed() and ('building' in t or t.get('amenity') == 'shelter'):
                continue                            # handled as an area
            try:
                pts = [[rnd(n.lat), rnd(n.lon)] for n in o.nodes]
            except osmium.InvalidLocationError:
                continue
            if len(pts) < 2: continue
            mid = pts[len(pts) // 2]
            sid = which(mid[0], mid[1]) or which(pts[0][0], pts[0][1]) or which(pts[-1][0], pts[-1][1])
            if not sid: continue
            hw = t.get('highway')
            layer = num(t.get('layer'), 0) or 0
            if hw in ('footway', 'path', 'steps', 'pedestrian', 'cycleway', 'corridor') and (t.get('tunnel') in ('yes', 'building_passage') or layer < 0):
                out[sid]['tunnels'].append({'pts': pts, 'hw': hw})
            elif hw in ('footway', 'path', 'steps', 'pedestrian', 'cycleway') and t.get('bridge') == 'yes':
                out[sid]['bridges'].append({'pts': pts, 'hw': hw, 'layer': layer})
            elif hw == 'steps':
                out[sid]['steps'].append({'pts': pts, 'incline': t.get('incline', '')})
            elif t.get('barrier') in ('fence', 'wall', 'railing', 'handrail', 'retaining_wall', 'guard_rail'):
                out[sid]['fences'].append({'pts': pts, 'barrier': t['barrier'], 'height': num(t.get('height')), 'fence_type': t.get('fence_type', '')})
    print(f'scanned {n_obj:,} objects in {time.time() - t0:.0f}s', flush=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump({'version': 1, 'radius_m': R_M, 'source': 'OpenStreetMap contributors, ODbL', 'stations': out}, open(OUT, 'w'), separators=(',', ':'))
    print('wrote', OUT, os.path.getsize(OUT), 'bytes')
    for sid, _, _ in STATIONS:
        d = out[sid]
        pts = {k: len(v) for k, v in d['points'].items()}
        print(f"{sid:16s} depot {len(d['depot'])}  roof {len(d['roof'])}  tunnels {len(d['tunnels'])}  bridges {len(d['bridges'])}  steps {len(d['steps'])}  fences {len(d['fences'])}  {pts}")


if __name__ == '__main__':
    main()
