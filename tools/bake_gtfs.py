#!/usr/bin/env python3
"""GTFS (data/raw/gtfs) -> data/baked/corridor.json (track centerline + stations, lat/lon)
and data/baked/timetable.json (compact trips for the runtime)."""
import csv, json, collections, math, os
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
G = os.path.join(ROOT, 'data/raw/gtfs'); OUT = os.path.join(ROOT, 'data/baked')
rd = lambda f: list(csv.DictReader(open(os.path.join(G, f), encoding='utf-8-sig')))
stops = rd('stops.txt'); trips = rd('trips.txt'); st = rd('stop_times.txt'); shapes = rd('shapes.txt')
routes = {r['route_id']: r['route_short_name'] for r in rd('routes.txt')}
cal = {c['service_id']: c for c in rd('calendar.txt')}
caldates = rd('calendar_dates.txt')

LAT0, LON0, MLAT, MLON = 37.40, -122.10, 110985.1, 88542.2
def w(lat, lon): return ((lon - LON0) * MLON, -(lat - LAT0) * MLAT)

parents = {s['stop_id']: s for s in stops if s['location_type'] == '1'}
plat2parent = {s['stop_id']: s['parent_station'] for s in stops if s['location_type'] in ('0', '')}
# shapes: mainline = longest shape; south county = longest shape reaching Gilroy
pts = collections.defaultdict(list)
for p in shapes: pts[p['shape_id']].append((int(p['shape_pt_sequence']), float(p['shape_pt_lat']), float(p['shape_pt_lon'])))
for k in pts: pts[k].sort()
def length(k): 
    a = [w(la, lo) for _, la, lo in pts[k]]; return sum(math.dist(a[i], a[i+1]) for i in range(len(a)-1))
gil = parents['gilroy']; sf = parents['san_francisco']
def reaches(k, s, tol=600):
    x, z = w(float(s['stop_lat']), float(s['stop_lon']))
    return min(math.dist((x, z), w(la, lo)) for _, la, lo in pts[k]) < tol
main = max((k for k in pts if reaches(k, sf)), key=length)
south = max((k for k in pts if reaches(k, gil)), key=length)
def oriented(k, start):
    p = [(la, lo) for _, la, lo in pts[k]]
    x, z = w(float(start['stop_lat']), float(start['stop_lon']))
    if math.dist(w(*p[-1]), (x, z)) < math.dist(w(*p[0]), (x, z)): p.reverse()
    return p
mainpts = oriented(main, sf)                   # SF -> Tamien (southbound order)
southpts = oriented(south, parents['sj_diridon'])  # Diridon -> Gilroy
stations = []
for sid, s in parents.items():
    stations.append({'id': sid, 'name': s['stop_name'].replace(' Caltrain Station', '').replace(' Station', '').replace('San Francisco Caltrain', 'San Francisco'),
                     'lat': float(s['stop_lat']), 'lon': float(s['stop_lon'])})
stations.sort(key=lambda s: -s['lat'] + (0 if s['lon'] < -121.7 else 0))
json.dump({'lat0': LAT0, 'lon0': LON0, 'mPerDegLat': MLAT, 'mPerDegLon': MLON,
           'mainline': {'shape': main, 'lengthApproxM': round(length(main)), 'pts': mainpts},
           'southCounty': {'shape': south, 'lengthApproxM': round(length(south)), 'pts': southpts},
           'stations': stations}, open(os.path.join(OUT, 'corridor.json'), 'w'), indent=0)

# ---- timetable ----
order = [s['id'] for s in sorted(stations, key=lambda s: (-(s['lat']) if s['lon'] < -121.85 else -s['lat']))]
sidx = {sid: i for i, sid in enumerate(order)}
def tsec(t): h, m, s = map(int, t.split(':')); return h*3600 + m*60 + s
bytrip = collections.defaultdict(list)
for r in st: bytrip[r['trip_id']].append(r)
svc_kind = {}
for sid, c in cal.items(): svc_kind[sid] = 'wkday' if c['monday'] == '1' else 'wkend'
special = collections.defaultdict(list)
for d in caldates:
    if d['exception_type'] == '1' and d['service_id'] not in cal: special[d['service_id']].append(d['date'])
out_trips = []
for t in trips:
    rows = sorted(bytrip[t['trip_id']], key=lambda r: int(r['stop_sequence']))
    stops_ = []
    for r in rows:
        par = plat2parent.get(r['stop_id'], r['stop_id'])
        if par not in sidx: continue
        stops_.append([sidx[par], tsec(r['arrival_time']), tsec(r['departure_time'])])
    kind = svc_kind.get(t['service_id'], 'special')
    out_trips.append({'id': t['trip_id'], 'route': routes[t['route_id']], 'svc': kind, 'dir': int(t['direction_id']),
                      'head': t['trip_headsign'], 'stops': stops_,
                      **({'dates': special[t['service_id']]} if kind == 'special' else {})})
out_trips.sort(key=lambda t: (t['svc'], t['stops'][0][2]))
json.dump({'stations': order, 'names': {s['id']: s['name'] for s in stations}, 'trips': out_trips,
           'feed': open(os.path.join(G, 'feed_info.txt')).read().strip().splitlines()[-1]},
          open(os.path.join(OUT, 'timetable.json'), 'w'), separators=(',', ':'))
print('main', main, round(length(main)), 'm;', 'south', south, round(length(south)), 'm;', len(stations), 'stations;', len(out_trips), 'trips')
print('station order:', [s for s in order])
print(collections.Counter((t['route'], t['svc']) for t in out_trips))
