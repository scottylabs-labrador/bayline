"""Bayline Metro (BART) geometry for the world bake: track centrelines, tunnels and stations in Bayline world metres.

Source, in order of preference:
  1. the data workstream's data/pub/v2/metro/network.json (tracks[].polyline [[x, y, z], ...] with per-segment
     structure; see notes/bart-data.md), once it exists;
  2. OpenStreetMap via the data workstream's Overpass cache data/raw/metro/osm/bart_osm.json (read only):
     railway=subway (the whole system: main lines, yards, sidings), the eBART extension (railway=light_rail, standard
     gauge, Pittsburg - Antioch) and the Coliseum - Oakland Airport connector (railway=funicular/monorail, operator BART).
     Lines under construction (Silicon Valley phase II) are left out.
Stations: GTFS stops.txt (location_type 1), the 50 stations of the 2026 system.

  lines()      -> [dict(xz=(n,2) float64, tunnel=bool, kind=str)]   polylines resampled every <= 25 m
  points()     -> (N,2) float64 world xz of every line sample (for distance-based coverage)
  stations()   -> [(id, name, x, z)]
  tree()       -> cKDTree over points() (+ .tunnel flags per sample)
Map data (c) OpenStreetMap contributors, ODbL 1.0.
"""
import csv, json, os
import numpy as np
from .common import ROOT, RAW, ll2w

OSM_JSON = os.path.join(RAW, 'metro', 'osm', 'bart_osm.json')
GTFS_STOPS = os.path.join(RAW, 'metro', 'gtfs', 'stops.txt')
NETWORK = os.path.join(ROOT, 'data', 'pub', 'v2', 'metro', 'network.json')
STEP = 25.0

_LINES = None
_STATIONS = None
_TREE = None


def _resample(xz, step=STEP):
    if len(xz) < 2:
        return xz
    seg = np.hypot(*np.diff(xz, axis=0).T)
    out = [xz[:1]]
    for i, L in enumerate(seg):
        n = max(1, int(np.ceil(L / step)))
        t = (np.arange(1, n + 1) / n)[:, None]
        out.append(xz[i] + (xz[i + 1] - xz[i]) * t)
    return np.concatenate(out, 0)


def _from_osm():
    d = json.load(open(OSM_JSON))
    out = []
    for e in d['elements']:
        if e['type'] != 'way' or 'geometry' not in e:
            continue
        t = e.get('tags', {})
        rw = t.get('railway')
        g = e['geometry']
        lat = np.array([p['lat'] for p in g]); lon = np.array([p['lon'] for p in g])
        op = (t.get('operator') or '') + ' ' + (t.get('name') or '')
        if rw == 'subway':
            kind = 'bart'
        elif rw == 'light_rail' and t.get('gauge') == '1435' and lat.min() > 37.98 and lon.min() > -121.95:
            kind = 'ebart'
        elif rw in ('funicular', 'monorail') and ('Rapid Transit' in op or 'BART' in op):
            kind = 'oak'
        else:
            continue
        x, z = ll2w(lat, lon)
        tun = t.get('tunnel') in ('yes', 'building_passage', 'culvert') or t.get('location') == 'underground'
        out.append(dict(xz=_resample(np.stack([x, z], 1)), tunnel=bool(tun), kind=kind, service=t.get('service')))
    return out


STRUCT = ['grade', 'aerial', 'bridge', 'embankment', 'trench', 'median', 'portal', 'cutcover', 'bored', 'tube']
UNDER = {6, 7, 8, 9}


def network_tracks():
    """The data workstream's tracks (metro/network.json + tracks.bin): [dict(id, sys, cls, step, P (n,3) x y z,
    struct (n,) uint8 codes, cover (n,) uint8)] (see notes/bart-data.md)."""
    import zlib
    net = json.load(open(NETWORK))
    buf = zlib.decompress(open(os.path.join(os.path.dirname(NETWORK), 'tracks.bin'), 'rb').read())
    out = []
    for h in net['tracks']:
        n, off = h['n'], h['off']
        P = np.frombuffer(buf, '<f4', n * 3, off).reshape(n, 3).astype(np.float64)
        A = np.frombuffer(buf, np.uint8, n * 4, off + n * 12)
        out.append(dict(id=h['id'], sys=h['sys'], cls=h['cls'], step=h['step'], P=P, struct=A[:n].copy(), cover=A[3 * n:].copy()))
    return out


def _from_network():
    out = []
    for t in network_tracks():
        xz = t['P'][:, [0, 2]]
        out.append(dict(xz=_resample(xz), tunnel=bool(np.isin(t['struct'], list(UNDER)).all()), kind=t['sys'], service=t['cls']))
    return out


def lines():
    global _LINES
    if _LINES is None:
        src = os.environ.get('BAYLINE_METRO_SRC', 'auto')
        if src == 'network' or (src == 'auto' and os.path.exists(NETWORK)):
            try:
                _LINES = _from_network()
            except Exception:
                _LINES = None
        if not _LINES:
            _LINES = _from_osm()
    return _LINES


def points():
    return np.concatenate([l['xz'] for l in lines()], 0)


def stations():
    global _STATIONS
    if _STATIONS is None:
        out = []
        for r in csv.DictReader(open(GTFS_STOPS)):
            if r.get('location_type') == '1':
                x, z = ll2w(float(r['stop_lat']), float(r['stop_lon']))
                out.append((r['stop_id'], r['stop_name'], float(x), float(z)))
        _STATIONS = out
    return _STATIONS


def tree():
    """(cKDTree over every line sample, bool tunnel flag per sample)"""
    global _TREE
    if _TREE is None:
        from scipy.spatial import cKDTree
        L = lines()
        P = np.concatenate([l['xz'] for l in L], 0)
        tun = np.concatenate([np.full(len(l['xz']), l['tunnel']) for l in L])
        _TREE = (cKDTree(P), tun)
    return _TREE
