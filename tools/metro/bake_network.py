#!/usr/bin/env python3
"""Bayline Metro network bake: OSM tracks + GTFS stations/patterns -> data/pub/v2/metro/{network.json, tracks.bin}.

    python3 tools/metro/fetch.py          # GTFS + OSM (Overpass) + terrain tiles, cached under data/raw/metro/
    python3 tools/metro/bake_network.py   # this file
    python3 tools/metro/bake_timetable.py # timetable.json (needs network.json for the pattern paths)

Format: notes/bart-data.md. Everything is in the game's Bay frame (x east, z south, y above sea level, metres).
Map data (c) OpenStreetMap contributors (ODbL); schedule data: BART GTFS (see notes/bart-data.md for terms).
"""
import collections, heapq, json, math, os, struct, sys
import numpy as np
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from metro.common import (PUB, PUB_DIR, write_hashed, RAW, ll2w, w2ll, log, gtfs, write_json, write_bin, cumlen, resample, smooth_fixed_ends,
                          curvature, MPH, poly_project)
from metro import osmgraph as OG
from metro import elev
from metro import profile as PR
from metro import profile2 as PR2
from metro import platforms as PL
from metro import stations_curated as SC
from metro import geomfix as GF
from metro import stations_meta as SM

STEP = 5.0                 # max sample spacing of the published polylines (m)
FINE = 1.0                 # working resolution
SMOOTH_SIGMA = 3.0         # m (at FINE): removes OSM node kinks, keeps curves (inward shift << 0.1 m)

LINES = {  # GTFS route_id -> (line id, direction id 0 = N, 1 = S)
    '1': ('yellow', 1), '2': ('yellow', 0), '3': ('orange', 0), '4': ('orange', 1), '5': ('green', 1), '6': ('green', 0),
    '7': ('red', 1), '8': ('red', 0), '11': ('blue', 1), '12': ('blue', 0), '19': ('grey', 0), '20': ('grey', 1),
}
LINE_META = {
    'yellow': dict(name='Yellow Line', colour='#ffff33', text='#000000', terminals=['Antioch', 'SFO / Millbrae']),
    'orange': dict(name='Orange Line', colour='#ff9933', text='#000000', terminals=['Richmond', 'Berryessa / North San Jose']),
    'green': dict(name='Green Line', colour='#339933', text='#ffffff', terminals=['Berryessa / North San Jose', 'Daly City']),
    'red': dict(name='Red Line', colour='#ff0000', text='#ffffff', terminals=['Richmond', 'Millbrae / SFO']),
    'blue': dict(name='Blue Line', colour='#0099cc', text='#ffffff', terminals=['Dublin / Pleasanton', 'Daly City']),
    'grey': dict(name='Airport Connector', colour='#b0bec7', text='#000000', terminals=['Coliseum', 'Oakland Airport']),
    'ebart': dict(name='Antioch Shuttle', colour='#ffff33', text='#000000', terminals=['Antioch', 'Pittsburg / Bay Point'],
                  note='eBART DMU leg of Yellow Line trips (cross-platform transfer at Pittsburg/Bay Point)'),
}
OSM_LINE = {'#ffe800': 'yellow', '#faa61a': 'orange', '#4db848': 'green', '#ed1c24': 'red', '#00aeef': 'blue', '#b0bdc6': 'grey'}


# ====================================================================== tracks
def build_tracks(G):
    """Split main strokes at main-line junctions, resample, attach per-sample attributes."""
    strokes = []
    for ch in G.strokes:
        nodes, xz, segway = G.stroke_geometry(ch)
        tags = [G.ways[w]['tags'] for w in segway]
        svc = collections.Counter(t.get('service') for t in tags).most_common(1)[0][0]
        sysn = G.ways[segway[0]]['sys']
        strokes.append(dict(nodes=nodes, xz=xz, segway=segway, service=svc, sys=sysn, chain=ch))
    # main strokes end at these vertices: split any main stroke passing through them
    main_end_at = collections.defaultdict(int)
    for st in strokes:
        if st['service'] is None:
            main_end_at[st['nodes'][0]] += 1
            main_end_at[st['nodes'][-1]] += 1
    out = []
    for st in strokes:
        cuts = [0]
        if st['service'] is None:
            for i in range(1, len(st['nodes']) - 1):
                if main_end_at.get(st['nodes'][i]) and st['nodes'][i] in G.vert:
                    cuts.append(i)
        cuts.append(len(st['nodes']) - 1)
        for a, b in zip(cuts[:-1], cuts[1:]):
            if b <= a:
                continue
            out.append(dict(nodes=st['nodes'][a:b + 1], xz=st['xz'][a:b + 1], segway=st['segway'][a:b], service=st['service'], sys=st['sys']))
    log(f'tracks after main-junction splits: {len(out)} ({sum(1 for t in out if t["service"] is None)} main)')
    return out


def densify(tr):
    """Fine (1 m) resample with smoothing; keeps a raw-s -> node map for vertices."""
    xz = tr['xz']
    s_raw = cumlen(xz)
    L = s_raw[-1]
    n = max(2, int(math.ceil(L / FINE)) + 1)
    t = np.linspace(0, L, n)
    fx = np.interp(t, s_raw, xz[:, 0])
    fz = np.interp(t, s_raw, xz[:, 1])
    seg = np.clip(np.searchsorted(s_raw, t, side='right') - 1, 0, len(xz) - 2)
    if L > 30:
        sig = SMOOTH_SIGMA / (L / (n - 1))
        fx = smooth_fixed_ends(fx, sig)
        fz = smooth_fixed_ends(fz, sig)
    s_new = cumlen(np.stack([fx, fz], 1))
    tr['fine'] = dict(x=fx, z=fz, s=s_new, raw=t, seg=seg)
    tr['s_raw_nodes'] = s_raw
    tr['length'] = float(s_new[-1])


def raw_to_s(tr, s_raw):
    f = tr['fine']
    return float(np.interp(s_raw, f['raw'], f['s']))



def project_track(tr, x, z, s_hint=None, win=400.0):
    """Nearest s on a published track polyline to (x, z) (optionally within +-win of s_hint)."""
    p = tr['pub']
    X, Z, st = p['x'], p['z'], p['step']
    a, b = 0, len(X) - 1
    if s_hint is not None:
        a = max(0, int((s_hint - win) / st)); b = min(len(X) - 1, int((s_hint + win) / st) + 1)
    px = np.stack([X[a:b + 1], Z[a:b + 1]], 1)
    d, s_at, k, t = poly_project(px, x, z)
    return a * st + s_at, d


def xz_at(tr, s):
    p = tr['pub']
    f = min(max(s / p['step'], 0), len(p['x']) - 1.000001); i = int(f); a = f - i
    return float(p['x'][i] * (1 - a) + p['x'][i + 1] * a), float(p['z'][i] * (1 - a) + p['z'][i + 1] * a)


def platform_groups(tracks, plat_pos, plats, raw_to_s):
    """Per station and level: the tracks sharing a platform level, as matched s-ranges. Level = OSM layer of the track
    at the platform (12th St / 19th St have two). Returns (groups, anchors)."""
    from metro.stations_meta import PLAT_LEN
    by_station = collections.defaultdict(list)
    for pid, (ti, sraw) in plat_pos.items():
        st = plats[pid]['parent_station'] if pid in plats else pid.split('-')[0]
        tr = tracks[ti]
        s = raw_to_s(tr, sraw)
        i = min(len(tr['pub']['tags']) - 1, int(round(s / tr['pub']['step'])))
        t = tr['pub']['tags'][i]
        try:
            layer = int(str(t.get('layer', '0')).split(';')[0])
        except ValueError:
            layer = 0
        by_station[st].append((pid, ti, s, layer))
    groups = []
    for st, mem in by_station.items():
        levels = collections.defaultdict(list)
        for m in mem:
            levels[m[3] if st in ('12TH', '19TH') else 0].append(m)
        for lv, ms in levels.items():
            seen = {}
            for pid, ti, s, layer in ms:
                seen.setdefault(ti, []).append(s)
            ks = list(seen.items())
            ti0, ss0 = ks[0]
            tr0 = tracks[ti0]
            c0 = float(np.mean(ss0))
            s0, s1 = max(0.0, c0 - PLAT_LEN / 2), min(tr0['length'], c0 + PLAT_LEN / 2)
            members = [(tr0['id'], s0, s1)]
            for ti, ss in ks[1:]:
                tr = tracks[ti]
                p0 = tr0['pub']; i0 = int(round(s0 / p0['step'])); i1 = min(len(p0['x']) - 1, int(round(s1 / p0['step'])))
                a_, _ = project_track(tr, p0['x'][i0], p0['z'][i0], float(np.mean(ss)))
                b_, _ = project_track(tr, p0['x'][i1], p0['z'][i1], float(np.mean(ss)))
                members.append((tr['id'], a_, b_))
            groups.append(dict(station=st, level=lv, members=members))
    anchors = {'points': []}
    return groups, anchors



def berth_leg(path, stops, platforms):
    """Stops at berths: the FRONT of the train stops at the platform end in the direction of travel (2 m short).
    The leg path starts at the rear end of its first platform (so the whole train stands on the path at d = 0 ...
    its first stop's d) and ends at the last berth. Reversal stops (SFO) turn at the berth. Returns (path, stops)
    with stops [{station, gtfs, track, s, d, reverse?, platform}]."""
    from metro.platforms import berth
    path = [list(p) for p in path]
    sign = lambda seg: 1 if seg[2] >= seg[1] else -1
    # first platform: extend back to its rear end
    pl = platforms.get(stops[0]['gtfs'])
    if pl and path and path[0][0] == pl['track']:
        sg = sign(path[0])
        rear = pl['s0'] if sg > 0 else pl['s1']
        if (path[0][2] - rear) * sg > 0:
            path[0][1] = rear
    # last platform: end at its berth
    pl = platforms.get(stops[-1]['gtfs'])
    if pl and path and path[-1][0] == pl['track']:
        sg = sign(path[-1])
        b = berth(pl, sg)
        if (b - path[-1][1]) * sg > 0:
            path[-1][2] = b
    # reversal stops: turn at the berth (arrival segment end == departure segment start)
    for i in range(len(path) - 1):
        a, c = path[i], path[i + 1]
        if a[0] == c[0] and sign(a) != sign(c):
            for stp in stops:
                pl = platforms.get(stp['gtfs'])
                if stp.get('reverse') and pl and pl['track'] == a[0]:
                    b = berth(pl, sign(a))
                    if (b - a[1]) * sign(a) > 0 and (c[2] - b) * sign(c) > 0:
                        a[2] = b; c[1] = b
    # stop positions along the path, in order
    cum = [0.0]
    for (_, a0, b0) in path:
        cum.append(cum[-1] + abs(b0 - a0))
    out = []
    k0 = 0
    for j, stp in enumerate(stops):
        pl = platforms.get(stp['gtfs'])
        tid = pl['track'] if pl else stp['track']
        best = None
        for k in range(k0, len(path)):
            t2, a0, b0 = path[k]
            if t2 != tid:
                continue
            sg = 1 if b0 >= a0 else -1
            target = berth(pl, sg) if pl else stp['s']
            lo_, hi_ = min(a0, b0), max(a0, b0)
            if lo_ - 0.6 <= target <= hi_ + 0.6:
                target = min(max(target, lo_), hi_)
                best = (k, target, cum[k] + abs(target - a0))
                break
            if j == 0 and k == 0:          # (first stop: the leg starts on its platform)
                best = (0, a0, 0.0)
                break
        if best is None:                    # fall back to the path-search position
            for k in range(k0, len(path)):
                t2, a0, b0 = path[k]
                if t2 == stp['track'] and min(a0, b0) - 0.6 <= stp['s'] <= max(a0, b0) + 0.6:
                    best = (k, stp['s'], cum[k] + abs(stp['s'] - a0)); break
        if best is None:
            best = (k0, stp['s'], -1.0)
        k, sv, d = best
        k0 = k
        o = dict(station=stp['station'], gtfs=stp['gtfs'], track=tid, s=round(float(sv), 2), d=round(float(d), 2))
        if stp.get('reverse'):
            o['reverse'] = True
            k0 = k + 1
        out.append(o)
    return path, out


# ====================================================================== naming
def name_tracks(tracks, st_codes):
    """Main tracks: BART designation letter (majority of the station codes along the track) + track number (GTFS
    platform code used there); others: '<LETTER>-<kind><n>'."""
    used = collections.Counter()
    for tr in tracks:
        letters = collections.Counter()
        nums = collections.Counter()
        for (code, num), s in tr.get('stops', {}).items():
            letters[code[0]] += 1
            nums[num] += 1
        if tr['service'] is None and letters:
            base = letters.most_common(1)[0][0] + (nums.most_common(1)[0][0] if nums else '')
        else:
            # nearest station code letter
            base = (tr.get('near_code') or 'X')[0] + '-' + {None: 'main', 'yard': 'yd', 'siding': 'sd', 'crossover': 'xo', 'spur': 'sp'}.get(tr['service'], 'tr')
        if tr['sys'] == 'ebart' and tr['service'] is None and not letters:
            base = 'E-main'
        used[base] += 1
        tr['base'] = base
    cnt = collections.Counter()
    for tr in tracks:
        b = tr['base']
        if used[b] == 1 and tr['service'] is None and '-' not in b:
            tr['id'] = b
        else:
            cnt[b] += 1
            tr['id'] = f'{b}.{cnt[b]}' if tr['service'] is None or '-' not in b else f'{b}{cnt[b]}'


# ====================================================================== movement graph (edges) for paths
class Mover:
    """Directed movement over the OSM edge graph. State: (edge, dir) with dir 0 = along stored order."""

    def __init__(self, G, edge_track):
        self.G = G
        self.et = edge_track
        self.nxt = collections.defaultdict(list)
        for v, lst in G.inc.items():
            dirs = {k: G.end_dir(*k) for k in lst}
            for a in lst:
                for b in lst:
                    if a == b:
                        continue
                    defl = math.acos(max(-1, min(1, float(np.dot(-dirs[a], dirs[b])))))
                    if defl < OG.MAX_DEFLECT:
                        # arriving on edge a at its end a[1] -> travelling dir: a[1]==1 means along stored order (dir 0)
                        arr_dir = 0 if a[1] == 1 else 1
                        dep_dir = 0 if b[1] == 0 else 1
                        self.nxt[(a[0], arr_dir)].append((b[0], dep_dir))

    def weight(self, eid, prefer):
        e = self.G.edges[eid]
        w = 1.0
        if not prefer.isdisjoint(e['segway']):
            w = 1.0
        elif e['service'] is None:
            w = 1.35
        elif e['service'] in ('crossover', 'siding'):
            w = 2.5
        else:
            w = 25.0
        return w

    def search(self, src, dst_set, prefer, maxcost=2.5e5):
        """Dijkstra. src: [(edge, dir, offset along stored order)]; dst_set: {edge: [(offset along stored order, tag)]}.
        Returns (cost, [(edge, dir)...], dst tag, dst offset, src offset) or None. dir 0 = along stored order."""
        pq = []
        best = {}
        cnt = 0
        for (eid, d, off) in src:
            L = self.G.edges[eid]['len']
            w = self.weight(eid, prefer)
            for (doff, tag) in dst_set.get(eid, []):
                ahead = (doff - off) if d == 0 else (off - doff)
                if ahead > 1.0:
                    cnt += 1
                    heapq.heappush(pq, (ahead * w, cnt, 'dst', ((eid, d),), (tag, doff, off)))
            rem = (L - off) if d == 0 else off
            cnt += 1
            heapq.heappush(pq, (rem * w, cnt, 'edge', ((eid, d),), off))
        while pq:
            c, _, kind, path, extra = heapq.heappop(pq)
            if c > maxcost:
                break
            if kind == 'dst':
                tag, doff, off0 = extra
                return (c, list(path), tag, doff, off0)
            eid, d = path[-1]
            if best.get((eid, d), 1e18) <= c:
                continue
            best[(eid, d)] = c
            for (nb, nd) in self.nxt.get((eid, d), []):
                L = self.G.edges[nb]['len']
                w = self.weight(nb, prefer)
                for (doff, tag) in dst_set.get(nb, []):
                    dist = doff if nd == 0 else (L - doff)
                    cnt += 1
                    heapq.heappush(pq, (c + dist * w, cnt, 'dst', path + ((nb, nd),), (tag, doff, extra)))
                if (nb, nd) in best:
                    continue
                cnt += 1
                heapq.heappush(pq, (c + L * w, cnt, 'edge', path + ((nb, nd),), extra))
        return None


# ====================================================================== main
def main():
    os.makedirs(PUB, exist_ok=True)
    d, E, byid = OG.load_osm()
    G = OG.Graph(E)
    tracks = build_tracks(G)
    for tr in tracks:
        densify(tr)
    GF.fix_tube_spacing(tracks)

    # edge -> (track index, s_raw start, s_raw end) (edges are whole within a track)
    node_track = collections.defaultdict(list)       # osm node -> [(track idx, raw s)]
    for ti, tr in enumerate(tracks):
        for k, (nid, s) in enumerate(zip(tr['nodes'], tr['s_raw_nodes'])):
            node_track[nid].append((ti, float(s), k))
    edge_track = {}
    for e in G.edges:
        a, b = e['nodes'][0], e['nodes'][1]
        found = None
        for (ti, s, k) in node_track[a]:
            tn = tracks[ti]['nodes']
            if k + 1 < len(tn) and tn[k + 1] == b:
                found = (ti, s, 0)
                break
            if k - 1 >= 0 and tn[k - 1] == b:
                found = (ti, s, 1)
                break
        if found is None:
            continue
        ti, s0, rev = found
        edge_track[e['id']] = (ti, s0, s0 + e['len'] if rev == 0 else s0 - e['len'], rev)
    log(f'edges mapped to tracks: {len(edge_track)}/{len(G.edges)}')

    # ---------------- stations (GTFS)
    stops = gtfs('stops.txt')
    parents = {s['stop_id']: s for s in stops if s['location_type'] == '1'}
    plats = {s['stop_id']: s for s in stops if s['location_type'] in ('0', '')}
    ents = [s for s in stops if s['location_type'] == '2']
    code_of = {}                                     # station key -> BART code letter+digits (A10 ...)
    for pid, p in plats.items():
        code_of[p['parent_station']] = pid.split('-')[0]
    code_of['COLS'] = 'A30'; code_of['OAKL'] = 'H40'; code_of['MLBR'] = 'W40'

    # all main-track points for projection
    def project_to_tracks(x, z, maxd=60.0, main_only=True, sysn=None):
        out = []
        for ti, tr in enumerate(tracks):
            if main_only and tr['service'] is not None:
                continue
            if sysn and tr['sys'] not in sysn:
                continue
            f = tr['fine']
            dx = f['x'] - x
            dz = f['z'] - z
            dd = dx * dx + dz * dz
            i = int(np.argmin(dd))
            if dd[i] <= maxd * maxd:
                out.append((math.sqrt(dd[i]), ti, float(f['s'][i]), i))
        out.sort()
        return out

    # ---------------- OSM route relations: stop positions per (line, dir)
    rels = [e for e in E if e['type'] == 'relation' and e.get('tags', {}).get('type') == 'route'
            and e['tags'].get('network') == 'BART']
    st_xy = {sid: tuple(map(float, ll2w(float(p['stop_lat']), float(p['stop_lon'])))) for sid, p in parents.items()}
    node_edge = {}                                   # osm node -> (edge id, offset along stored order)
    for e in G.edges:
        s_e = cumlen(e['xz'])
        for k, nid in enumerate(e['nodes']):
            node_edge.setdefault(nid, (e['id'], float(s_e[k])))

    def stop_station(nid):
        t = G.ntags.get(nid) or next((q.get('tags', {}) for q in [byid.get(('node', nid), {})]), {})
        if 'Transfer' in (t.get('name') or ''):
            return 'PITT-T'
        if nid not in G.xz:
            return None
        x, z = G.xz[nid]
        best = min(st_xy, key=lambda sid: (st_xy[sid][0] - x) ** 2 + (st_xy[sid][1] - z) ** 2)
        return best if math.hypot(st_xy[best][0] - x, st_xy[best][1] - z) < 400 else None

    rel_info = []
    for r in rels:
        t = r['tags']
        line = OSM_LINE.get((t.get('colour') or '').lower()) or ('yellow' if 'Yellow' in (t.get('name') or '') else None)
        ways = [m['ref'] for m in r['members'] if m['type'] == 'way' and m['role'] in ('', 'forward', 'backward')]
        stopn = [m['ref'] for m in r['members'] if m['type'] == 'node' and m['role'].startswith('stop')]
        seq = []
        for nid in stopn:
            sid = stop_station(nid)
            if sid and nid in node_edge:
                seq.append((sid, nid))
        rel_info.append(dict(id=r['id'], name=t.get('name'), line=line, ways=set(ways), stops=seq, route=t.get('route')))
    log(f'OSM route relations: {len(rel_info)}')

    # ---------------- GTFS patterns
    trips = gtfs('trips.txt')
    st_rows = collections.defaultdict(list)
    for r in gtfs('stop_times.txt'):
        st_rows[r['trip_id']].append(r)
    patterns = {}
    trip_pat = {}
    for t in trips:
        if t['route_id'] not in LINES:
            continue
        rows = sorted(st_rows[t['trip_id']], key=lambda r: int(r['stop_sequence']))
        seq = tuple(r['stop_id'] for r in rows)
        key = (t['route_id'], seq)
        if key not in patterns:
            line, dirn = LINES[t['route_id']]
            patterns[key] = dict(route=t['route_id'], line=line, dir=dirn, stops=list(seq), trips=0, shape=t['shape_id'])
        patterns[key]['trips'] += 1
        trip_pat[t['trip_id']] = key
    log(f'GTFS patterns: {len(patterns)}')

    def sys_of_stop(pid):
        c = pid[0]
        return 'ebart' if c == 'E' else ('oac' if c == 'H' else 'bart')

    # candidate platform tracks at each station: main tracks within 90 m of the station
    st_tracks = {}
    for sid, p in parents.items():
        x, z = st_xy[sid]
        sysn = {'oac'} if sid == 'OAKL' else None
        st_tracks[sid] = project_to_tracks(float(x), float(z), 90.0, True, sysn)

    mover = Mover(G, edge_track)

    def generic_targets(x, z, sysn, tag, r=45.0):
        tg = {}
        for e in G.edges:
            if e['service'] in ('yard',) or e['sys'] != sysn:
                continue
            dd, s_at, k, t = poly_project(e['xz'], x, z)
            if dd < r:
                tg.setdefault(e['id'], []).append((s_at, (tag, dd)))
        return tg

    def lcs(a, b):
        m = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
        for i in range(len(a)):
            for j in range(len(b)):
                m[i + 1][j + 1] = m[i][j] + 1 if a[i] == b[j] else max(m[i][j + 1], m[i + 1][j])
        return m[-1][-1]

    # split each GTFS pattern into legs by system: eBART (E stops + the Pittsburg/Bay Point transfer), BART, OAC
    def legs_of(pat):
        seq = pat['stops']
        out = []
        cur = None
        for pid in seq:
            sy = sys_of_stop(pid)
            st = plats[pid]['parent_station']
            if cur is None or cur['sys'] != sy:
                if cur is not None and cur['sys'] == 'ebart' and sy == 'bart':
                    cur['stops'].append(('PITT-T', 'E10-T'))          # DMU ends at the transfer platform (eBART face)
                    out.append(cur)
                    cur = dict(sys='bart', stops=[('PITT-T', 'C80-T')])   # EMU starts there (BART face)
                elif cur is not None and cur['sys'] == 'bart' and sy == 'ebart':
                    cur['stops'].append(('PITT-T', 'C80-T'))
                    out.append(cur)
                    cur = dict(sys='ebart', stops=[('PITT-T', 'E10-T')])
                elif cur is not None:
                    out.append(cur)
                    cur = dict(sys=sy, stops=[])
                else:
                    cur = dict(sys=sy, stops=[])
            cur['stops'].append((st, pid))
        out.append(cur)
        return out

    def targets_for(st, pid, sysn, rel):
        # exact: the matched relation's stop node at this station
        if rel:
            for (sid, nid) in rel['stops']:
                if sid == st:
                    eid, off = node_edge[nid]
                    if G.edges[eid]['sys'] == sysn:
                        return {eid: [(off, (st, 0.0))]}
        if st == 'PITT-T':
            x, z = G.xz[5319797505] if 5319797505 in G.xz else st_xy['PITT']
            return generic_targets(x, z, sysn, st, 120.0)
        q = plats.get(pid)
        if q is not None and sysn != 'bart':
            x, z = map(float, ll2w(float(q['stop_lat']), float(q['stop_lon'])))
            return generic_targets(x, z, sysn, st, 90.0)
        x, z = st_xy[st]
        return generic_targets(x, z, sysn, st, 45.0)

    pat_paths = {}
    fails = 0
    for key, pat in patterns.items():
        legs_out = []
        ok = True
        for leg in legs_of(pat):
            stn = [st for st, _ in leg['stops']]
            dedup = [x for i, x in enumerate(stn) if i == 0 or stn[i - 1] != x]
            cands = [ri for ri in rel_info if (ri['line'] == pat['line'] or leg['sys'] == 'ebart') and ri['stops']
                     and (leg['sys'] != 'ebart' or ri['route'] == 'light_rail') and (leg['sys'] != 'oac' or ri['route'] == 'monorail')]
            best = None
            if cands:
                sc = [(lcs(dedup, [a for a, _ in ri['stops']]), -abs(len(ri['stops']) - len(dedup)), ri['id'], ri) for ri in cands]
                sc.sort(reverse=True)
                if sc[0][0] >= min(2, len(dedup)):
                    best = sc[0][3]
            prefer = best['ways'] if best else set()
            st0, pid0 = leg['stops'][0]
            src = []
            for eid, lst in targets_for(st0, pid0, leg['sys'], best).items():
                for (off, tag) in lst:
                    src.append((eid, 0, off)); src.append((eid, 1, off))
            cur_src = src
            prev = st0
            parts = []
            for (st, pid) in leg['stops'][1:]:
                if st == prev:              # reversal in place (SFO)
                    if parts:
                        eid, dd = parts[-1]['path'][-1]
                        cur_src = [(eid, 1 - dd, parts[-1]['doff'])]
                        parts[-1]['reverse'] = True
                    continue
                res = mover.search(cur_src, targets_for(st, pid, leg['sys'], best), prefer)
                if res is None:
                    ok = False
                    log('  no path', pat['line'], pat['dir'], leg['sys'], prev, '->', st)
                    break
                cost, path, tag, doff, soff = res
                parts.append(dict(frm=prev, to=st, path=path, doff=doff, soff=soff, pid=pid, rel=best['id'] if best else None))
                eid, dd = path[-1]
                cur_src = [(eid, dd, doff)]
                prev = st
            if not ok:
                break
            legs_out.append(dict(sys=leg['sys'], parts=parts, first=leg['stops'][0], rel=best['id'] if best else None))
        if not ok:
            fails += 1
            continue
        pat_paths[key] = legs_out
    log(f'pattern paths: {len(pat_paths)} ok, {fails} failed')

    # ---------------- convert edge paths to track segments; platform code -> track
    def ts_of(eid, o):
        ti, a0, b0, rev = edge_track[eid]
        return ti, (a0 + o if rev == 0 else a0 - o)

    def leg_to_segments(leg):
        segs = []           # [track idx, s_raw0, s_raw1]
        stops_at = []       # (station, pid, track idx, s_raw, reverse)
        p0 = leg['parts'][0] if leg['parts'] else None
        if p0:
            ti, s0 = ts_of(p0['path'][0][0], p0['soff'])
            stops_at.append((leg['first'][0], leg['first'][1], ti, s0, False))
        for part in leg['parts']:
            for k, (eid, dd) in enumerate(part['path']):
                L = G.edges[eid]['len']
                o_start = part['soff'] if k == 0 else (0.0 if dd == 0 else L)
                o_end = part['doff'] if k == len(part['path']) - 1 else (L if dd == 0 else 0.0)
                ti, s0 = ts_of(eid, o_start)
                _, s1 = ts_of(eid, o_end)
                if abs(s1 - s0) < 1e-6:
                    continue
                if segs and segs[-1][0] == ti and abs(segs[-1][2] - s0) < 1.5 and (segs[-1][2] - segs[-1][1]) * (s1 - s0) > 0:
                    segs[-1][2] = s1
                else:
                    segs.append([ti, s0, s1])
            ti, se = ts_of(part['path'][-1][0], part['doff'])
            stops_at.append((part['to'], part['pid'], ti, se, bool(part.get('reverse'))))
        return segs, stops_at

    plat_track = collections.defaultdict(collections.Counter)
    pat_segs = {}
    for key, legs in pat_paths.items():
        out_legs = []
        for leg in legs:
            segs, stops_at = leg_to_segments(leg)
            out_legs.append(dict(sys=leg['sys'], segs=segs, stops=stops_at, rel=leg['rel']))
            for (st, pid, ti, s, rv) in stops_at:
                plat_track[pid][(ti, round(s / 25) * 25)] += patterns[key]['trips']
        pat_segs[key] = out_legs
    for tr in tracks:
        tr['stops'] = {}
    plat_pos = {}
    # per station: give distinct platform codes distinct tracks where the paths allow it (terminals such as Berryessa,
    # where arrivals and departures share a code but use either face of the island), maximising the trips served
    import itertools
    by_st_pid = collections.defaultdict(list)
    for pid in plat_track:
        by_st_pid[pid.split('-')[0]].append(pid)
    for code_, pids in by_st_pid.items():
        cands = {pid: [(ti_s, n) for ti_s, n in plat_track[pid].most_common(3)] for pid in pids}
        best, best_n = None, -1
        for combo in itertools.product(*[cands[pid] for pid in pids]):
            tis = [c[0][0] for c in combo]
            n = sum(c[1] for c in combo) + (10 ** 6 if len(set(tis)) == len(tis) else 0)
            if n > best_n:
                best, best_n = combo, n
        for pid, ((ti, s), _) in zip(pids, best):
            code, num = (pid.split('-') + [''])[:2] if '-' in pid else (pid, '1')
            tracks[ti]['stops'][(code, num)] = s
            plat_pos[pid] = (ti, s)
    # nearest station code for naming non-main tracks
    st_xy = {sid: tuple(map(float, ll2w(float(p['stop_lat']), float(p['stop_lon'])))) for sid, p in parents.items()}
    for tr in tracks:
        f = tr['fine']
        mx, mz = float(np.mean(f['x'])), float(np.mean(f['z']))
        best = min(parents, key=lambda sid: (st_xy[sid][0] - mx) ** 2 + (st_xy[sid][1] - mz) ** 2)
        tr['near_code'] = code_of.get(best, 'X')
        tr['near_station'] = best
    name_tracks(tracks, code_of)
    ids = [t['id'] for t in tracks]
    assert len(ids) == len(set(ids)), collections.Counter(ids).most_common(5)
    log('main tracks:', sorted(t['id'] for t in tracks if t['service'] is None))

    # ---------------- publish samples, attributes, profile
    elev.ensure_along(np.concatenate([t['fine']['x'][::50] for t in tracks]), np.concatenate([t['fine']['z'][::50] for t in tracks]), 300)
    out_tracks = []
    for ti, tr in enumerate(tracks):
        f = tr['fine']
        L = tr['length']
        n = max(2, int(math.ceil(L / STEP)) + 1)
        s = np.linspace(0, L, n)
        x = np.interp(s, f['s'], f['x'])
        z = np.interp(s, f['s'], f['z'])
        segi = np.interp(s, f['s'], f['seg']).astype(int)
        segi = np.clip(segi, 0, len(tr['segway']) - 1)
        wt = [G.ways[tr['segway'][k]]['tags'] for k in segi]
        tr['pub'] = dict(s=s, x=x, z=z, step=L / (n - 1), tags=wt)
        out_tracks.append(tr)
    # junctions: vertices where a track ends on another track (turnouts), both ends (links), diamonds
    vt = collections.defaultdict(list)       # vertex -> [(track idx, raw s, is_end, end which)]
    for ti, tr in enumerate(tracks):
        nd = tr['nodes']
        for k, nid in enumerate(nd):
            if nid in G.inc and len(G.inc[nid]) >= 2:
                vt[nid].append((ti, float(tr['s_raw_nodes'][k]), k in (0, len(nd) - 1), 0 if k == 0 else (1 if k == len(nd) - 1 else -1)))
    junctions = []
    links = collections.defaultdict(dict)    # track idx -> {'prev': [...], 'next': [...]}
    for nid, lst in vt.items():
        x, z = G.xz[nid]
        through = [q for q in lst if not q[2]]
        ends = [q for q in lst if q[2]]
        jid = f'J{len(junctions)}'
        ntag = G.ntags.get(nid, {})
        members = []
        for (ti, sr, is_end, which) in lst:
            members.append([tracks[ti]['id'], round(raw_to_s(tracks[ti], sr), 2)])
        kind = 'turnout' if through and ends else ('link' if len(ends) >= 2 else 'diamond')
        if len(through) >= 2 and not ends:
            kind = 'diamond'
        junctions.append(dict(id=jid, kind=kind, x=round(x, 2), z=round(z, 2), tracks=members, osm=nid,
                              **({'ref': ntag['ref']} if ntag.get('ref') else {})))
        for (ti, sr, is_end, which) in ends:
            others = [[tracks[t2]['id'], round(raw_to_s(tracks[t2], s2), 2)] for (t2, s2, e2, w2) in lst if t2 != ti]
            links[ti]['prev' if which == 0 else 'next'] = dict(junction=jid, to=others)
    log(f'junctions: {len(junctions)}', collections.Counter(j['kind'] for j in junctions))


    # ---------------- platforms (OSM extents), level groups, researched anchors, then the joint profile solve
    platforms = PL.build(tracks, parents, plats, plat_pos, raw_to_s, E, SC.C)
    by_tid = {t['id']: t for t in tracks}
    groups = []
    for g in PL.level_groups(platforms, SC.C):
        ref = g['platforms'][0]
        tr0 = by_tid[ref['track']]
        members = [(ref['track'], ref['s0'], ref['s1'])]
        for pl in g['platforms'][1:]:
            tr = by_tid[pl['track']]
            hint = 0.5 * (pl['s0'] + pl['s1'])
            a_, _ = project_track(tr, *xz_at(tr0, ref['s0']), s_hint=hint)
            b_, _ = project_track(tr, *xz_at(tr0, ref['s1']), s_hint=hint)
            members.append((pl['track'], a_, b_))
        groups.append(dict(station=g['station'], level=g['level'], sys=g['sys'], members=members))
    main_sys = {'PCTR': 'ebart', 'ANTC': 'ebart', 'OAKL': 'oac'}
    anchors = {'points': [], 'rel': []}
    for g in groups:
        if g['sys'] != main_sys.get(g['station'], 'bart'):
            continue
        for (lv, rel, w) in SC.anchors_for(g['station']):
            if lv is not None and lv != g['level']:
                continue
            t, s0, s1 = g['members'][0]
            anchors['rel'].append(dict(track=t, s0=min(s0, s1), s1=max(s0, s1), rel=rel, w=w, station=g['station'], level=g['level']))
    # Transbay Tube: tracks at -85 ft at the SF vent structure (Rogers & Peck / NTSB via research and infra notes) and the
    # 1965 general profile digitized by the engineering research (low confidence): 1965 MSL ~ NGVD29, NAVD88 = +0.8 m here
    eng = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'research', 'engineering.json')))
    prof_pts = eng['transbay_tube']['approx_profile_digitized']['points_distance_from_SF_vent_ft__track_elev_ft']
    for tr in tracks:
        if tr.get('tube'):
            lo_, hi_, s_sf, s_oak = tr['tube']
            sg = 1 if s_oak > s_sf else -1
            anchors['points'].append(dict(track=tr['id'], s=s_sf, y=-85 * 0.3048 + 0.8, w=300.0, why='SF vent structure: tracks at -85 ft'))
            for dist_ft, el_ft in prof_pts[1:]:
                sv = s_sf + sg * dist_ft * 0.3048
                if min(lo_, hi_) <= sv <= max(lo_, hi_):
                    anchors['points'].append(dict(track=tr['id'], s=sv, y=el_ft * 0.3048 + 0.8, w=40.0, why='1965 Transbay Tube general profile (digitized)'))
    log(f'platform level groups: {len(groups)}, height anchors: {len(anchors["rel"])} + {len(anchors["points"])} points')
    roads = PR2.Roads()
    PR2.solve(out_tracks, junctions, groups, anchors, roads)
    PR2.finish(out_tracks)
    PR2.third_rail(out_tracks, junctions, platforms)

    # ---------------- stations
    tn = byid.get(('node', 5319797505))
    extra = [('PITT-T', 'Pittsburg / Bay Point (eBART transfer platform)', tn['lat'], tn['lon'], '')] if tn else []
    code_of['PITT-T'] = 'C80T'
    stations = SM.build2(parents, plats, ents, tracks, platforms, E, code_of, SC.C, extra)
    vlines, vrep = PR2.validate(out_tracks, stations, junctions, groups)
    for ln in vlines:
        log(ln)
    anchor_rep = [dict(station=a['station'], level=a['level'], track=a['track'], target=a['y'], solved=a.get('solved'), delta=a.get('delta'),
                       ground=a['ground'], rel=a['rel'], w=a['w']) for a in anchors.get('resolved', [])]
    big = [a for a in anchor_rep if a['delta'] is not None and abs(a['delta']) > 1.0]
    log(f'  researched heights missed by > 1 m: {len(big)} ' + ', '.join(f"{a['station']}{'/' + a['level'] if a['level'] != 'main' else ''} {a['delta']:+.1f}" for a in big))
    write_json(os.path.join(PUB, 'validation.json'), dict(generated=__import__('time').strftime('%Y-%m-%dT%H:%M:%S'), summary=vlines, report=vrep,
                                                           anchors=anchor_rep), compact=False)

    # ---------------- lines + patterns
    lines = []
    pats_out = []
    VEH = {'bart': 'emu', 'ebart': 'dmu', 'oac': 'apm'}
    for key, legs in pat_segs.items():
        pat = patterns[key]
        lo = []
        for leg in legs:
            path = [[tracks[ti]['id'], raw_to_s(tracks[ti], a0), raw_to_s(tracks[ti], b0)] for ti, a0, b0 in leg['segs']]
            stops = [dict(station=sid, gtfs=pid, track=tracks[ti]['id'], s=raw_to_s(tracks[ti], sr), reverse=rv) for (sid, pid, ti, sr, rv) in leg['stops']]
            path, st = berth_leg(path, stops, platforms)
            cum = [0.0]
            for (_, a0, b0) in path:
                cum.append(cum[-1] + abs(b0 - a0))
            lo.append(dict(sys=leg['sys'], vehicle=VEH[leg['sys']], osmRelation=leg['rel'], length=round(cum[-1], 2),
                           path=[[t, round(a0, 2), round(b0, 2)] for t, a0, b0 in path], stops=st))
        pats_out.append(dict(id=None, route=pat['route'], line=pat['line'], dir=pat['dir'], gtfs=pat['stops'], trips=pat['trips'], legs=lo))
    # pattern ids: <line>-<N|S>-<k> by trip count
    by_ld = collections.defaultdict(list)
    for p in pats_out:
        by_ld[(p['line'], p['dir'])].append(p)
    for (line, dirn), lst in by_ld.items():
        lst.sort(key=lambda p: -p['trips'])
        for k, p in enumerate(lst):
            p['id'] = f"{line}-{'NS'[dirn]}-{k}"
    for line, meta in LINE_META.items():
        lines.append(dict(id=line, **meta, patterns=[p['id'] for p in pats_out if p['line'] == line]))

    # ---------------- write
    write_tracks(out_tracks, links, junctions, stations, lines, pats_out)


def write_tracks(tracks, links, junctions, stations, lines, pats):
    # tracks.bin: see notes/bart-data.md
    order = list(range(len(tracks)))
    head = []
    blobs = []
    off = 0
    for ti in order:
        tr = tracks[ti]
        p = tr['pub']
        n = len(p['s'])
        arr = np.zeros((n, 3), np.float32)
        arr[:, 0] = p['x']; arr[:, 1] = p['y']; arr[:, 2] = p['z']
        attr = np.zeros((n, 5), np.uint8)
        attr[:, 0] = p['struct']
        attr[:, 1] = np.clip(np.round(p['vlim'] / MPH), 0, 255).astype(np.uint8)          # mph
        attr[:, 2] = np.clip(np.round(p['cant'] * 1000 / 2) + 128, 0, 255).astype(np.uint8) # 2 mm units, 128 = 0
        attr[:, 3] = np.clip(np.round(p['depth']), 0, 255).astype(np.uint8)                 # cover (m) above tunnel crown / clearance
        attr[:, 4] = p.get('third', np.zeros(n, np.uint8))                                 # third rail: 0 none, 1 left, 2 right
        blob = arr.tobytes() + np.ascontiguousarray(attr.T).tobytes()      # xyz interleaved, then 5 attribute planes
        blob += b'\0' * ((-len(blob)) % 4)                                  # next track's floats stay 4-byte aligned
        head.append(dict(id=tr['id'], n=n, step=round(p['step'], 6), off=off, planes=5, sys=tr['sys'], cls=tr['service'] or 'main'))
        blobs.append(blob)
        off += len(blob)
    raw = b''.join(blobs)
    bin_name = write_hashed(PUB, 'tracks', raw)
    size_bin = os.path.getsize(os.path.join(PUB, bin_name))
    tr_meta = []
    for ti, h in zip(order, head):
        tr = tracks[ti]
        p = tr['pub']
        segs = p['segments']
        tr_meta.append(dict(**h, length=round(float(p['s'][-1]), 2), gauge=1.435 if tr['sys'] != 'bart' else 1.676,
                            station=tr.get('near_station'), structure=segs, prev=links[ti].get('prev'), next=links[ti].get('next')))
    net = dict(version=0, format='bayline-metro-network', frame='Bay frame: x=(lon+122.10)*88542.2 east, z=-(lat-37.40)*110985.1 south, y=m above sea level (top of rail)',
               generated=__import__('time').strftime('%Y-%m-%dT%H:%M:%S'), sources=SOURCES,
               structCodes=PR2.STRUCT_NAMES, tracksBin=dict(path=f'{PUB_DIR}/{bin_name}', bytes=len(raw), layout='per track at off: n*(f32 x, f32 y, f32 z) interleaved, then 5 planes of n u8: struct code, speed limit (mph), cant (2 mm units, 128 = 0, + = right rail lower), cover/clearance (m), third-rail side (0 none, 1 left, 2 right); padded to 4 bytes'),
               tracks=tr_meta, junctions=junctions, stations=stations, lines=lines, patterns=pats)
    size = write_json(os.path.join(PUB, 'network.json'), net)
    log(f'network.json {size/1e6:.2f} MB, tracks.bin {size_bin/1e6:.2f} MB ({len(raw)/1e6:.2f} MB raw), {len(tracks)} tracks')


SOURCES = [
    'Track geometry, platforms, entrances: (c) OpenStreetMap contributors, ODbL 1.0 (Overpass API extract, see data/raw/metro/osm).',
    'Stations, platforms codes, entrances, patterns: BART GTFS static feed (google_transit_20260810-20270108_v02), https://www.bart.gov/schedules/developers (BART developer license).',
    'Ground heights: AWS Terrain Tiles (terrarium z15; USGS 3DEP and others).',
]

if __name__ == '__main__':
    main()
