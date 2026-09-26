"""Where streets, railways and waterways cross each metro track (plan intersections of OSM ways with the published
centrelines), for infra's piers and the stations' lobbies/bents.

Per track, `crossings` = [[s, kind, class, rel, width, angle, name, dy], ...] sorted by s:
  s      metres along the track
  kind   'road' | 'rail' | 'water'
  class  OSM highway / railway / waterway value (motorway, primary, residential, footway, rail, light_rail, stream ...)
  rel    'under'  the crossing passes under the track: the track is aerial/bridge/embankment there (unless the way is a
                  bridge on a higher OSM layer than the track, e.g. the I-880 viaduct over the West Oakland aerial), or
                  the track is at grade and the way is a tunnel/culvert/underpass
         'over'   it passes over the track: the track is underground/trench/portal (unless the way is a tunnel on a
                  lower OSM layer, e.g. the Central Subway under Market Street), or the track is at grade and the way is
                  a bridge
         'level'  neither (at-grade; BART has no level crossings, so these are yard/service tracks or data gaps)
  width  metres across (OSM width, else lanes x 3.5 m + margins, else a per-class default), at right angles to the way
  angle  degrees between the way and the track (90 = square crossing)
  name   OSM name or ref ('' if none)
  dy     top of rail minus the bare-earth lidar ground at the crossing (m): for 'under' crossings the height of the rail
         above the road / water surface (the vertical room for the bridge deck and the clearance), for 'over' crossings
         negative (the rail below the street); null where there is no lidar
Map data (c) OpenStreetMap contributors, ODbL 1.0.
"""
import json, math, os
import numpy as np
from scipy.spatial import cKDTree
from metro.common import RAW, ll2w, log

DEFAULT_W = {'motorway': 16.0, 'motorway_link': 8.0, 'trunk': 16.0, 'trunk_link': 8.0, 'primary': 16.0, 'primary_link': 8.0,
             'secondary': 13.0, 'secondary_link': 7.0, 'tertiary': 11.0, 'tertiary_link': 7.0, 'residential': 10.0,
             'unclassified': 9.0, 'living_street': 7.0, 'service': 6.0, 'pedestrian': 6.0, 'footway': 3.0, 'cycleway': 3.0,
             'path': 2.5, 'steps': 2.5, 'rail': 5.0, 'light_rail': 7.0, 'tram': 7.0, 'subway': 5.0, 'narrow_gauge': 4.0,
             'river': 30.0, 'canal': 12.0, 'stream': 6.0, 'ditch': 3.0, 'drain': 3.0}
UNDER_STRUCT = {'aerial', 'bridge', 'embankment'}
OVER_STRUCT = {'cutcover', 'bored', 'tube', 'portal', 'trench'}


def _layer(t, default=0):
    try:
        return int(str(t.get('layer')).split(';')[0]) if t.get('layer') not in (None, '') else default
    except ValueError:
        return default


def _width(t, cls):
    w = t.get('width')
    if w:
        try:
            return float(str(w).split()[0])
        except ValueError:
            pass
    if t.get('lanes'):
        try:
            return float(str(t['lanes']).split(';')[0]) * 3.5 + 3.0
        except ValueError:
            pass
    return DEFAULT_W.get(cls, 6.0)


def build(tracks, struct_names, path=os.path.join(RAW, 'osm', 'roads_osm.json')):
    if not os.path.exists(path):
        log('crossings: roads_osm.json missing (tools/metro/osm_pbf.py)')
        return
    E = json.load(open(path))['elements']
    allp = []
    own = []
    for k, tr in enumerate(tracks):
        p = tr['pub']
        allp.append(np.stack([p['x'], p['z']], 1)); own.append(np.full(len(p['x']), k))
    P = np.concatenate(allp); O = np.concatenate(own)
    starts = np.concatenate([[0], np.cumsum([len(a) for a in allp])])
    kd = cKDTree(P)
    out = [[] for _ in tracks]
    n = 0
    for e in E:
        t = e.get('tags', {})
        g = e.get('geometry') or []
        if len(g) < 2:
            continue
        if 'highway' in t:
            kind, cls = 'road', t['highway']
        elif 'railway' in t:
            kind, cls = 'rail', t['railway']
            op = t.get('operator') or ''
            if t.get('gauge') == '1676' or 'Rapid Transit' in op or op == 'BART' or cls in ('subway', 'funicular', 'monorail'):
                continue                                   # our own tracks (BART is the only subway here)
            if cls == 'light_rail' and not op and g[0]['lat'] > 37.98 and g[0]['lon'] > -121.96:
                continue                                   # eBART (tagged light_rail without an operator)
        elif 'waterway' in t:
            kind, cls = 'water', t['waterway']
        else:
            continue
        X, Z = ll2w(np.array([q['lat'] for q in g]), np.array([q['lon'] for q in g]))
        way_over = t.get('bridge') not in (None, 'no') or _layer(t) > 0
        way_under = t.get('tunnel') not in (None, 'no') or t.get('covered') == 'yes' or _layer(t) < 0
        lay = _layer(t, 1 if way_over else -1 if way_under else 0)
        for i in range(len(X) - 1):
            ax, az, bx, bz = X[i], Z[i], X[i + 1], Z[i + 1]
            L = math.hypot(bx - ax, bz - az)
            if L < 0.01:
                continue
            mid = ((ax + bx) / 2, (az + bz) / 2)
            cand = kd.query_ball_point(mid, L / 2 + 6.0)
            if not cand:
                continue
            seen = set()
            for c in cand:
                k = O[c]
                j = c - starts[k]
                for jj in (j - 1, j):
                    if jj < 0 or jj + 1 >= len(allp[k]) or (k, jj) in seen:
                        continue
                    seen.add((k, jj))
                    cx, cz = allp[k][jj]; dx, dz = allp[k][jj + 1] - allp[k][jj]
                    # segment intersection
                    den = (bx - ax) * dz - (bz - az) * dx
                    if abs(den) < 1e-9:
                        continue
                    u = ((cx - ax) * dz - (cz - az) * dx) / den          # along the way segment
                    v = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den   # along the track segment
                    if not (0 <= u <= 1 and 0 <= v <= 1):
                        continue
                    tr = tracks[k]
                    step = tr['pub']['step']
                    s = (jj + v) * step
                    ii = min(len(tr['pub']['struct']) - 1, jj + (1 if v > 0.5 else 0))
                    sname = struct_names[int(tr['pub']['struct'][ii])]
                    tags = tr['pub'].get('tags')
                    tlay = _layer(tags[ii] if tags is not None else {}, 1 if sname in UNDER_STRUCT else -1 if sname in OVER_STRUCT else 0)
                    if sname in OVER_STRUCT:            # track below ground: everything is above it but deeper tunnels
                        rel = 'under' if (way_under and lay < tlay) else 'over'
                    elif sname in UNDER_STRUCT:         # track elevated: everything passes under but higher bridges
                        rel = 'over' if (way_over and lay > tlay) else 'under'
                    elif way_over and not way_under:
                        rel = 'over'
                    elif way_under:
                        rel = 'under'
                    else:
                        rel = 'level'
                    ang = abs(math.degrees(math.atan2((bx - ax) * dz - (bz - az) * dx, (bx - ax) * dx + (bz - az) * dz)))
                    ang = 180 - ang if ang > 90 else ang
                    if kind == 'rail' and ang < 12:
                        continue                           # merging / parallel tracks, not a crossing
                    nm = t.get('name') or t.get('ref') or ''
                    pp = tr['pub']
                    dy = None
                    if 'y' in pp and 'g' in pp and (pp.get('gsrc') is None or pp['gsrc'][ii] == 1):
                        f_ = min(max(s / step, 0.0), len(pp['y']) - 1.000001); i0 = int(f_); a_ = f_ - i0
                        dy = round(float((pp['y'][i0] - pp['g'][i0]) * (1 - a_) + (pp['y'][i0 + 1] - pp['g'][i0 + 1]) * a_), 1)
                    out[k].append([round(s, 1), kind, cls, rel, round(_width(t, cls), 1), round(ang), nm, dy])
                    n += 1
    for k, tr in enumerate(tracks):
        lst = sorted(out[k], key=lambda r: r[0])
        # de-duplicate the same way crossing twice within 2 m (split OSM ways)
        ded = []
        for r in lst:
            if ded and abs(ded[-1][0] - r[0]) < 2.0 and ded[-1][2] == r[2] and ded[-1][6] == r[6]:
                continue
            ded.append(r)
        tr['crossings'] = ded
    log(f'crossings: {sum(len(t["crossings"]) for t in tracks)} ({n} raw intersections) on {sum(1 for t in tracks if t["crossings"])} tracks')
