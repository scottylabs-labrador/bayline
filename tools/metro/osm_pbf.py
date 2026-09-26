#!/usr/bin/env python3
"""Roads, waterways and other railways near the metro tracks, from the local Geofabrik NorCal PBF (the public Overpass
servers time out on this corridor query) -> data/raw/metro/osm/roads_osm.json in Overpass JSON shape.

    python3 tools/metro/osm_pbf.py            # needs data/pub/v2/metro/tracks.bin (any version) for the corridor

pyosmium: pip install --target data/raw/metro/pylib osmium   (the tool adds that directory to sys.path)
Map data (c) OpenStreetMap contributors, ODbL 1.0.
"""
import json, os, sys, time
import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from metro.common import RAW, ROOT, ll2w, log          # noqa: E402

LIB = os.path.join(RAW, 'pylib')
if os.path.isdir(LIB) and LIB not in sys.path:
    sys.path.insert(0, LIB)
import osmium                                         # noqa: E402

PBF = next(p for p in (os.path.join(ROOT, 'data/raw/osm_pbf/norcal-latest.osm.pbf'), os.path.join(ROOT, 'data/raw/osm/norcal-latest.osm.pbf')) if os.path.exists(p))
OUT = os.path.join(RAW, 'osm', 'roads_osm.json')
R = 60.0
HW = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
      'residential', 'unclassified', 'living_street', 'service', 'pedestrian', 'footway', 'cycleway', 'path', 'steps'}
KEEP_TAGS = ('highway', 'name', 'ref', 'bridge', 'tunnel', 'layer', 'lanes', 'oneway', 'waterway', 'natural', 'railway', 'gauge', 'operator', 'service', 'covered')


def corridor_tree():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from metro.validate import load_net
    net = load_net()
    pts = np.concatenate([t['P'][:, [0, 2]] for t in net['tracks']])
    return cKDTree(pts[::2])


def main():
    kd = corridor_tree()
    lat0, lat1, lon0, lon1 = 37.30, 38.08, -122.56, -121.70
    out = []
    t0 = time.time()
    n = 0
    fp = osmium.FileProcessor(PBF).with_locations().with_filter(osmium.filter.KeyFilter('highway', 'waterway', 'railway', 'natural'))
    for o in fp:
        if not o.is_way():
            continue
        t = o.tags
        hw = t.get('highway'); ww = t.get('waterway'); rw = t.get('railway'); nat = t.get('natural')
        if not ((hw in HW) or (ww in ('river', 'stream', 'canal', 'ditch', 'drain')) or (rw in ('rail', 'light_rail', 'tram', 'subway', 'narrow_gauge')) or nat == 'water'):
            continue
        try:
            ll = [(nd.location.lat, nd.location.lon) for nd in o.nodes]
        except osmium.InvalidLocationError:
            continue
        if not ll:
            continue
        la = np.array([p[0] for p in ll]); lo = np.array([p[1] for p in ll])
        if la.max() < lat0 or la.min() > lat1 or lo.max() < lon0 or lo.min() > lon1:
            continue
        x, z = ll2w(la, lo)
        # densify long segments a little so a way crossing the corridor between far-apart nodes is caught
        px, pz = [x[0]], [z[0]]
        for i in range(1, len(x)):
            L = float(np.hypot(x[i] - x[i - 1], z[i] - z[i - 1]))
            k = max(1, int(L / 30.0))
            for q in range(1, k + 1):
                px.append(x[i - 1] + (x[i] - x[i - 1]) * q / k); pz.append(z[i - 1] + (z[i] - z[i - 1]) * q / k)
        d, _ = kd.query(np.stack([px, pz], 1), distance_upper_bound=R)
        if not np.isfinite(d).any():
            continue
        tags = {k: t.get(k) for k in KEEP_TAGS if t.get(k) is not None}
        out.append({'type': 'way', 'id': o.id, 'tags': tags, 'geometry': [{'lat': round(a, 7), 'lon': round(b, 7)} for a, b in ll]})
        n += 1
    json.dump({'source': os.path.basename(PBF), 'generated': time.strftime('%Y-%m-%dT%H:%M:%S'), 'elements': out}, open(OUT, 'w'))
    log(f'{n} ways within {R:.0f} m of the tracks -> {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB, {time.time() - t0:.0f} s)')


if __name__ == '__main__':
    main()
