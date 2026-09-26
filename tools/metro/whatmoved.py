#!/usr/bin/env python3
"""'What moved' between two metro bakes (stations' rail levels, types, layouts, platform tracks/sides/extents; track km
by structure).

    python3 tools/metro/whatmoved.py [NEW_DIR] [OLD_DIR]      defaults: data/pub/v2/metro-next vs data/pub/v2/metro
The M1 v0 station heights are in research/v0_platform_heights.json (platform = rail + 1.02 then)."""
import collections, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
new_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'data/pub/v2/metro-next')
old_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'data/pub/v2/metro')
new = json.load(open(os.path.join(new_dir, 'network.json')))
old = json.load(open(os.path.join(old_dir, 'network.json')))
v0 = json.load(open(os.path.join(HERE, 'research', 'v0_platform_heights.json')))['platform']
os_ = {s['id']: s for s in old['stations']}

print('| station | type | layout | rail (m) | platform v0 / before / now | moved since before | since v0 |')
print('|---|---|---|---|---|---|---|')
rows = []
for s in new['stations']:
    o = os_.get(s['id'])
    pn = s['levels']['platform']
    po = o['levels']['platform'] if o else None
    rail = s['levels'].get('rail', pn - 0.991)
    p0 = v0.get(s['id'])
    lv = s['levels'].get('byLevel')
    rtxt = f"{rail:.1f}" + (' (' + ', '.join(f"{k} {v['rail']:.1f}" for k, v in lv.items()) + ')' if lv else '')
    typ = s['type'] if not o or o['type'] == s['type'] else f"{o['type']} -> **{s['type']}**"
    lay = s['layout'] if not o or o['layout'] == s['layout'] else f"{o['layout']} -> **{s['layout']}**"
    d_old = (pn - po) if po is not None else None
    d_v0 = (pn - p0) if p0 is not None else None
    f = lambda v: '-' if v is None else f'{v:+.1f}'
    g = lambda v: '-' if v is None else f'{v:.1f}'
    rows.append((abs(d_old) if d_old is not None else 99, f"| {s['id']} | {typ} | {lay} | {rtxt} | {g(p0)} / {g(po)} / {pn:.1f} | {f(d_old)} | {f(d_v0)} |"))
for _, r in sorted(rows, key=lambda r: -r[0]):
    print(r)

# platform records: track, side, extent, height changes
print('\n| platform | before (track side s0-s1) | now | change |\n|---|---|---|---|')
op = {p['gtfs']: p for s in old['stations'] for p in s['platforms']}
for s in new['stations']:
    for p in s['platforms']:
        q = op.get(p['gtfs'])
        if q is None:
            print(f"| {p['gtfs']} ({s['id']}) | - | {p['track']} {p['side']} {p['s0']:.0f}-{p['s1']:.0f} | new{' (unused)' if p.get('unused') else ''} |")
            continue
        ch = []
        if q['track'] != p['track']:
            ch.append('track')
        if q['side'] != p['side']:
            ch.append('side')
        if abs((q['s1'] - q['s0']) - (p['s1'] - p['s0'])) > 5:
            ch.append(f"length {q['s1'] - q['s0']:.0f}->{p['s1'] - p['s0']:.0f} m")
        if abs(q['rail'] - p['rail']) > 0.5:
            ch.append(f"rail {q['rail'] - p['rail']:+.1f}"[:0] + f"rail {p['rail'] - q['rail']:+.1f} m")
        if ch:
            print(f"| {p['gtfs']} ({s['id']}) | {q['track']} {q['side']} {q['s0']:.0f}-{q['s1']:.0f} | {p['track']} {p['side']} {p['s0']:.0f}-{p['s1']:.0f} | {', '.join(ch)} |")


def km(net):
    c = collections.Counter()
    for t in net['tracks']:
        for a, b, name in t['structure']:
            c[name] += (b - a) / 1000.0
    return c
kn, ko = km(new), km(old)
print('\n| structure | km before | km now |\n|---|---|---|')
for k in sorted(set(kn) | set(ko)):
    print(f'| {k} | {ko.get(k, 0):.1f} | {kn.get(k, 0):.1f} |')
