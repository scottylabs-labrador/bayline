"""OSM BART track graph: select the system's track ways, split them into edges between vertices (switches, ends,
way junctions with degree != 2), pair edge ends at each vertex into straight-through continuations, and chain them
into strokes: one stroke = one physical track (a main, a pocket/tail track, a crossover, a yard lead ...).

Map data (c) OpenStreetMap contributors, ODbL 1.0.
"""
import json, math, collections
import numpy as np
from metro.common import OSM_JSON, ll2w, log

MAX_DEFLECT = math.radians(28.0)      # beyond this, two edge ends are not one continuous track
PROBE = 18.0                           # m along an edge to measure its direction at a vertex


def load_osm(path=OSM_JSON):
    d = json.load(open(path))
    E = d['elements']
    byid = {(e['type'], e['id']): e for e in E}
    return d, E, byid


def system_of(t, lat, lon):
    """'bart' (1676 mm heavy rail), 'ebart' (eBART DMU, standard gauge), 'oac' (airport connector) or None."""
    r = t.get('railway')
    g = t.get('gauge', '') or ''
    op = t.get('operator', '') or ''
    name = t.get('name', '') or ''
    if r in ('subway', 'rail') and ('1676' in g and '1435' not in g):
        return 'bart'
    if r == 'subway' and ('Rapid Transit' in op or op == 'BART'):
        return 'bart'
    if r == 'light_rail' and g == '1435' and not op and lat > 37.985 and lon > -121.96:
        return 'ebart'
    if r in ('funicular', 'monorail') and (name == 'H-Line' or 'Coliseum' in name or 'Oakland International' in name):
        return 'oac'
    return None


class Graph:
    def __init__(self, E):
        self.ways = {}
        for e in E:
            if e['type'] != 'way' or not e.get('geometry') or len(e['geometry']) < 2:
                continue
            t = e.get('tags', {})
            g = e['geometry']
            la = sum(p['lat'] for p in g) / len(g)
            lo = sum(p['lon'] for p in g) / len(g)
            sysn = system_of(t, la, lo)
            if not sysn:
                continue
            if t.get('railway') in ('turntable',):
                continue
            self.ways[e['id']] = dict(id=e['id'], tags=t, nodes=e['nodes'], sys=sysn,
                                      ll=[(p['lat'], p['lon']) for p in g])
        # node positions + tags
        self.pos = {}
        for w in self.ways.values():
            for nid, (la, lo) in zip(w['nodes'], w['ll']):
                self.pos[nid] = (la, lo)
        self.ntags = {}
        for e in E:
            if e['type'] == 'node' and e['id'] in self.pos and e.get('tags'):
                self.ntags[e['id']] = e['tags']
        ids = list(self.pos)
        la = np.array([self.pos[i][0] for i in ids])
        lo = np.array([self.pos[i][1] for i in ids])
        x, z = ll2w(la, lo)
        self.xz = {i: (float(a), float(b)) for i, a, b in zip(ids, x, z)}
        log(f'osm graph: {len(self.ways)} track ways, {len(self.pos)} nodes', collections.Counter(w['sys'] for w in self.ways.values()))
        self._split()
        self._pair()
        self._strokes()

    # ---------------------------------------------------------------- edges
    def _split(self):
        deg = collections.Counter()
        for w in self.ways.values():
            n = w['nodes']
            for i, nid in enumerate(n):
                deg[nid] += (1 if i in (0, len(n) - 1) else 2)
            if n[0] == n[-1]:          # closed way: its first/last node is an ordinary interior node
                deg[n[0]] += 0
        self.deg = deg
        vert = {nid for nid, d in deg.items() if d != 2}
        for nid, t in self.ntags.items():
            if t.get('railway') in ('switch', 'buffer_stop', 'railway_crossing'):
                vert.add(nid)
        self.vert = vert
        edges = []
        for w in self.ways.values():
            n = w['nodes']
            cur = [n[0]]
            for nid in n[1:]:
                cur.append(nid)
                if nid in vert:
                    edges.append(dict(nodes=cur, way=w['id'], sys=w['sys'], tags=w['tags']))
                    cur = [nid]
            if len(cur) > 1:
                edges.append(dict(nodes=cur, way=w['id'], sys=w['sys'], tags=w['tags']))
        # merge chains of edges that meet at non-vertex nodes (way joins with degree 2): they are the same track
        # piece; keep per-segment way ids so tags survive.
        for i, e in enumerate(edges):
            e['id'] = i
            e['segway'] = [e['way']] * (len(e['nodes']) - 1)
        at = collections.defaultdict(list)          # non-vertex endpoints -> edges
        for e in edges:
            for end in (0, -1):
                if e['nodes'][end] not in vert:
                    at[e['nodes'][end]].append(e['id'])
        alive = {e['id']: e for e in edges}
        for nid, lst in at.items():
            if len(lst) != 2:
                continue
            a, b = lst
            if a == b or a not in alive or b not in alive:
                continue
            ea, eb = alive[a], alive[b]
            # orient so ea ends at nid and eb starts at nid
            if ea['nodes'][-1] != nid:
                ea['nodes'].reverse(); ea['segway'].reverse()
            if eb['nodes'][0] != nid:
                eb['nodes'].reverse(); eb['segway'].reverse()
            if ea['nodes'][-1] != nid or eb['nodes'][0] != nid:
                continue
            ea['nodes'] = ea['nodes'] + eb['nodes'][1:]
            ea['segway'] = ea['segway'] + eb['segway']
            del alive[b]
            # re-point any other pending endpoint of eb to ea
            for end in (0, -1):
                other = ea['nodes'][end]
                if other in at:
                    at[other] = [a if x == b else x for x in at[other]]
        self.edges = list(alive.values())
        for i, e in enumerate(self.edges):
            e['id'] = i
            e['xz'] = np.array([self.xz[n] for n in e['nodes']])
            d = np.hypot(*np.diff(e['xz'], axis=0).T)
            e['len'] = float(d.sum())
            e['service'] = e['tags'].get('service')
        self.inc = collections.defaultdict(list)    # vertex -> [(edge id, end 0|1)]
        for e in self.edges:
            self.inc[e['nodes'][0]].append((e['id'], 0))
            self.inc[e['nodes'][-1]].append((e['id'], 1))
        log(f'edges: {len(self.edges)}, vertices: {len(self.inc)}, total {sum(e["len"] for e in self.edges)/1000:.1f} km')

    def end_dir(self, eid, end):
        """Unit direction pointing from the vertex into the edge at edge end (0 = start, 1 = end)."""
        p = self.edges[eid]['xz']
        if end == 1:
            p = p[::-1]
        d = np.hypot(*np.diff(p, axis=0).T)
        s = np.concatenate([[0], np.cumsum(d)])
        L = min(PROBE, s[-1])
        q = np.array([np.interp(L, s, p[:, 0]), np.interp(L, s, p[:, 1])])
        v = q - p[0]
        n = np.hypot(*v) or 1.0
        return v / n

    # ---------------------------------------------------------------- pairing
    def _pair(self):
        self.pair = {}                 # (eid, end) -> (eid2, end2)
        self.junction_kind = {}
        for v, lst in self.inc.items():
            if len(lst) < 2:
                continue
            dirs = [self.end_dir(*k) for k in lst]
            cand = []
            for i in range(len(lst)):
                for j in range(i + 1, len(lst)):
                    if lst[i][0] == lst[j][0] and len(lst) > 2:
                        continue
                    dot = float(np.dot(dirs[i], -dirs[j]))
                    defl = math.acos(max(-1.0, min(1.0, dot)))
                    ei, ej = self.edges[lst[i][0]], self.edges[lst[j][0]]
                    pen = 0.0
                    if (ei['service'] is None) != (ej['service'] is None):
                        pen += 0.02            # prefer main-main continuation on near ties
                    if ei['sys'] != ej['sys']:
                        pen += 1.0
                    cand.append((defl + pen, defl, i, j))
            cand.sort()
            used = set()
            for cost, defl, i, j in cand:
                if defl > MAX_DEFLECT or i in used or j in used:
                    continue
                used.add(i); used.add(j)
                self.pair[lst[i]] = lst[j]
                self.pair[lst[j]] = lst[i]

    # ---------------------------------------------------------------- strokes
    def _strokes(self):
        seen = set()
        strokes = []
        for e in self.edges:
            if e['id'] in seen:
                continue
            # walk backwards from e's start to the stroke start
            chain = [(e['id'], 0)]           # (edge, orientation 0 = as stored, 1 = reversed)
            seen.add(e['id'])
            # extend forward from e's end
            cur = (e['id'], 1)
            while cur in self.pair:
                nxt = self.pair[cur]
                if nxt[0] in seen:
                    break
                seen.add(nxt[0])
                o = 0 if nxt[1] == 0 else 1       # entering at its start -> as stored
                chain.append((nxt[0], o))
                cur = (nxt[0], 1 - nxt[1])
            # extend backward from e's start
            cur = (e['id'], 0)
            pre = []
            while cur in self.pair:
                nxt = self.pair[cur]
                if nxt[0] in seen:
                    break
                seen.add(nxt[0])
                o = 1 if nxt[1] == 0 else 0       # we walk backwards: entering at its start means it runs reversed
                pre.append((nxt[0], o))
                cur = (nxt[0], 1 - nxt[1])
            chain = pre[::-1] + chain
            strokes.append(chain)
        self.strokes = strokes
        log(f'strokes: {len(strokes)}')

    def stroke_geometry(self, chain):
        """Concatenated node ids, xz and per-segment way ids along a stroke."""
        nodes, segway = [], []
        for eid, o in chain:
            e = self.edges[eid]
            n = e['nodes'] if o == 0 else e['nodes'][::-1]
            sw = e['segway'] if o == 0 else e['segway'][::-1]
            if nodes:
                assert nodes[-1] == n[0], (nodes[-1], n[0])
                nodes += n[1:]
            else:
                nodes = list(n)
            segway += sw
        return nodes, np.array([self.xz[k] for k in nodes]), segway
