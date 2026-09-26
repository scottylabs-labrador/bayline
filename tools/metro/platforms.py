"""Platforms: for every GTFS platform stop (A10-1, K30-4, ...) the track it serves, the platform's extent along that
track (s0..s1) and side, from the OSM platform geometry (areas, lines, platform edges); fallback: the station point
projected on the track +-106.7 m (700 ft). Berths: where the FRONT of a train stops, per direction of travel: the
platform end in that direction (BART berths trains at the leaving end; a 10-car train then fills the platform).

Map data (c) OpenStreetMap contributors, ODbL 1.0.
"""
import collections, math
import numpy as np
from metro.common import ll2w, log

PLAT_LEN = 213.4                  # 700 ft
EDGE_OFF = 1.616                  # track centre -> platform edge (33 in half gauge + 30 5/8 in; BART Facilities Standards)
PLAT_H = 0.991                    # platform edge above top of rail (39 in; BFS R3.2.3 Table 2)
BERTH_MARGIN = 2.0                # m between the platform end and the stopped train's front


def osm_features(E):
    feats = []
    for e in E:
        t = e.get('tags', {})
        if e['type'] != 'way' or not (t.get('railway') in ('platform', 'platform_edge') or t.get('public_transport') == 'platform'):
            continue
        op = t.get('operator', '') or ''
        if 'Muni' in op or 'Municipal' in op or 'Valley Transportation' in op or t.get('network') == 'Amtrak':
            continue
        g = e.get('geometry') or []
        if len(g) < 2:
            continue
        x, z = ll2w(np.array([q['lat'] for q in g]), np.array([q['lon'] for q in g]))
        P = []
        for i in range(len(x) - 1):
            L = math.hypot(x[i + 1] - x[i], z[i + 1] - z[i])
            n = max(1, int(L / 2.0))
            for k in range(n):
                P.append((x[i] + (x[i + 1] - x[i]) * k / n, z[i] + (z[i + 1] - z[i]) * k / n))
        P.append((x[-1], z[-1]))
        feats.append(dict(id=e['id'], P=np.array(P), tags=t, closed=e['nodes'][0] == e['nodes'][-1]))
    return feats


def extent_on_track(tr, cx, cz, feats, want_len=PLAT_LEN, maxlen=240.0):
    """(s0, s1, side, lateral, n_pts, source) of the platform along published track tr near the point (cx, cz)."""
    p = tr['pub']
    X, Z, st = p['x'], p['z'], p['step']
    dd = np.hypot(X - cx, Z - cz)
    idx = np.where(dd < 280)[0]
    if not len(idx):
        k = int(np.argmin(dd)); idx = np.arange(max(0, k - 50), min(len(X), k + 50))
    sx, sz = X[idx], Z[idx]
    gx = np.gradient(X)[idx]; gz = np.gradient(Z)[idx]; L = np.hypot(gx, gz) + 1e-12; gx /= L; gz /= L
    ss, lats = [], []
    for f in feats:
        FP = f['P']
        if np.hypot(FP[:, 0].mean() - cx, FP[:, 1].mean() - cz) > 400:
            continue
        for (fx, fz) in FP:
            q = np.hypot(sx - fx, sz - fz); k = int(q.argmin())
            if q[k] > 16:
                continue
            lat = (fx - sx[k]) * (-gz[k]) + (fz - sz[k]) * gx[k]
            along = (fx - sx[k]) * gx[k] + (fz - sz[k]) * gz[k]
            if 1.0 < abs(lat) < 14 and abs(along) < 6:
                ss.append(idx[k] * st + along); lats.append(lat)
    total = (len(X) - 1) * st
    if len(ss) >= 4:
        ss = np.array(ss); lats = np.array(lats)
        side = 1 if np.median(lats) > 0 else -1
        on = np.sign(lats) == side
        a, b = np.percentile(ss[on], 1), np.percentile(ss[on], 99)
        if b - a > maxlen:                   # platform + ramps / adjacent features: keep 700 ft around the densest part
            c = float(np.median(ss[on])); a, b = c - want_len / 2, c + want_len / 2
        return max(0.0, float(a)), min(total, float(b)), side, float(np.median(np.abs(lats[on]))), int(len(ss)), 'osm'
    # fallback: centred on the station point
    k = int(np.argmin(dd))
    c = k * st
    return max(0.0, c - want_len / 2), min(total, c + want_len / 2), 0, EDGE_OFF, 0, 'station'


def build(tracks, parents, plats, plat_pos, raw_to_s, E, curated):
    """-> {gtfs pid: platform dict}"""
    feats = osm_features(E)
    by_id = {t['id']: t for t in tracks}
    out = {}
    for pid, (ti, sraw) in plat_pos.items():
        tr = tracks[ti]
        if pid in ('C80-T', 'E10-T'):
            sid = 'PITT-T'
            cx, cz = tr['pub']['x'][0], tr['pub']['z'][0]
            s_hint = raw_to_s(tr, sraw)
            i = int(round(s_hint / tr['pub']['step']))
            cx, cz = tr['pub']['x'][min(i, len(tr['pub']['x']) - 1)], tr['pub']['z'][min(i, len(tr['pub']['z']) - 1)]
            want = 150.0
        else:
            sid = plats[pid]['parent_station']
            q = plats[pid]
            px, pz = ll2w(float(parents[sid]['stop_lat']), float(parents[sid]['stop_lon']))
            cx, cz = float(px), float(pz)
            want = PLAT_LEN
            if tr['sys'] == 'ebart':
                want = 130.0
            elif tr['sys'] == 'oac':
                want = 45.0
        s0, s1, side, lat, npts, src = extent_on_track(tr, cx, cz, feats, want, maxlen=want + 30)
        cfg = (curated.get(sid) or {}).get('platforms', {}).get(pid.split('-')[-1] if '-' in pid else pid, {})
        if cfg.get('side'):
            side = 1 if cfg['side'] == 'right' else -1
        if side == 0:
            # no OSM platform: side from the GTFS platform point relative to the track
            q = plats.get(pid)
            if q is not None:
                gx, gz = ll2w(float(q['stop_lat']), float(q['stop_lon']))
                p = tr['pub']; k = int(np.argmin(np.hypot(p['x'] - gx, p['z'] - gz)))
                k2 = min(len(p['x']) - 1, k + 1); k1 = max(0, k - 1)
                dx, dz = p['x'][k2] - p['x'][k1], p['z'][k2] - p['z'][k1]
                side = 1 if (float(gx) - p['x'][k]) * (-dz) + (float(gz) - p['z'][k]) * dx > 0 else -1
            else:
                side = 1
        out[pid] = dict(gtfs=pid, station=sid, track=tr['id'], ti=ti, s0=s0, s1=s1, side=side, edge=EDGE_OFF, osmLateral=lat,
                        osmPts=npts, src=src, code=(plats.get(pid) or {}).get('platform_code') or pid.split('-')[-1], sys=tr['sys'])
    n_osm = sum(1 for p in out.values() if p['src'] == 'osm')
    log(f'platforms: {len(out)} ({n_osm} from OSM platform geometry, {len(out) - n_osm} from the station point)')
    return out


def berth(pl, sign):
    """Front-of-train stop position on the platform's track for travel in direction sign (+1 = increasing s)."""
    return (pl['s1'] - BERTH_MARGIN) if sign > 0 else (pl['s0'] + BERTH_MARGIN)


def level_groups(platforms, curated):
    """Solver groups: per station, per level, per system: the tracks sharing a platform level with matched ranges.
    curated[station]['levels'] may split tracks into named levels (12th / 19th St), else one level per system."""
    by_st = collections.defaultdict(list)
    for p in platforms.values():
        by_st[p['station']].append(p)
    groups = []
    for sid, ps in by_st.items():
        lv_map = (curated.get(sid) or {}).get('levelOf', {})           # platform code -> level name
        levels = collections.defaultdict(list)
        for p in ps:
            levels[(p['sys'], lv_map.get(p['code'], 'main'))].append(p)
        for (sysn, lv), pls in levels.items():
            seen = collections.OrderedDict()
            for p in pls:
                if p['track'] not in seen:
                    seen[p['track']] = p
            groups.append(dict(station=sid, level=lv, sys=sysn, platforms=list(seen.values())))
    return groups
