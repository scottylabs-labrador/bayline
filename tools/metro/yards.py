"""Yards: the system's storage/maintenance yards from OSM (railway=yard / landuse=railway areas operated by BART), with the
tracks that lie inside each (network.json `yards[]`).
Map data (c) OpenStreetMap contributors, ODbL 1.0."""
import numpy as np
from metro.common import ll2w, log


def _inside(px, pz, poly):
    """Even-odd point-in-polygon for arrays px, pz against poly (N, 2)."""
    x = poly[:, 0]; z = poly[:, 1]
    inside = np.zeros(len(px), bool)
    j = len(poly) - 1
    for i in range(len(poly)):
        cond = ((z[i] > pz) != (z[j] > pz)) & (px < (x[j] - x[i]) * (pz - z[i]) / (z[j] - z[i] + 1e-12) + x[i])
        inside ^= cond
        j = i
    return inside


def build(E, tracks, stations):
    polys = []
    for e in E:
        t = e.get('tags', {})
        if e['type'] != 'way' or not e.get('geometry') or len(e['geometry']) < 4:
            continue
        op = (t.get('operator') or '') + ' ' + (t.get('name') or '')
        if not (t.get('railway') == 'yard' or t.get('landuse') == 'railway'):
            continue
        if 'BART' not in op and 'Rapid Transit' not in op and not (t.get('railway') == 'yard' and not t.get('operator')):
            continue
        g = e['geometry']
        if e['nodes'][0] != e['nodes'][-1]:
            continue
        X, Z = ll2w(np.array([q['lat'] for q in g]), np.array([q['lon'] for q in g]))
        polys.append(dict(osm=e['id'], name=t.get('name') or '', poly=np.stack([X, Z], 1)))
    yards = []
    for yp in polys:
        poly = yp['poly']
        area = 0.5 * abs(np.dot(poly[:-1, 0], poly[1:, 1]) - np.dot(poly[1:, 0], poly[:-1, 1]))
        members = []
        for tr in tracks:
            p = tr['pub']
            m = _inside(p['x'], p['z'], poly)
            if m.mean() > 0.5:
                members.append(tr['id'])
        if not members:
            continue
        cx, cz = float(poly[:, 0].mean()), float(poly[:, 1].mean())
        near = min(stations, key=lambda s: (s['x'] - cx) ** 2 + (s['z'] - cz) ** 2)['id'] if stations else ''
        name = yp['name'] or f'{near} yard'
        yid = name.replace('BART ', '').replace(' Yard', '').strip().lower().replace(' ', '_') or f'yard_{len(yards)}'
        yards.append(dict(id=yid, name=name, osm=yp['osm'], station=near, area=round(area), x=round(cx, 1), z=round(cz, 1),
                          polygon=[[round(float(a), 1), round(float(b), 1)] for a, b in poly], tracks=members))
    log(f'yards: {len(yards)} ' + ', '.join(f"{y['name']} ({len(y['tracks'])} tracks)" for y in yards))
    return yards
