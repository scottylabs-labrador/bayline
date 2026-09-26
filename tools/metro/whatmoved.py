#!/usr/bin/env python3
"""'What moved' between two metro bakes (stations' rail levels, types, layouts; track km by structure; patterns).

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
print('| station | type (v0 -> M2) | layout | rail M2 (m) | platform v0 -> M2 | moved (m) |')
print('|---|---|---|---|---|---|')
rows = []
for s in new['stations']:
    o = os_.get(s['id'], {})
    pn = s['levels']['platform']
    rail = s['levels'].get('rail', pn - 0.991)
    p0 = v0.get(s['id'])
    mv = (pn - p0) if p0 is not None else None
    lv = s['levels'].get('byLevel')
    rtxt = f"{rail:.1f}" + (' (' + ', '.join(f"{k} {v['rail']:.1f}" for k, v in lv.items()) + ')' if lv else '')
    rows.append((abs(mv) if mv is not None else 0, f"| {s['id']} | {o.get('type', '?')} -> {s['type']} | {s['layout']} | {rtxt} | "
                                                     f"{p0 if p0 is not None else '-'} -> {pn:.1f} | {mv:+.1f} |" if mv is not None else f"| {s['id']} | new | {s['layout']} | {rtxt} | - -> {pn:.1f} | - |"))
for _, r in sorted(rows, key=lambda r: -r[0]):
    print(r)


def km(net):
    c = collections.Counter()
    for t in net['tracks']:
        for a, b, name in t['structure']:
            c[name] += (b - a) / 1000.0
    return c
kn, ko = km(new), km(old)
print('\n| structure | km before | km M2 |\n|---|---|---|')
for k in sorted(set(kn) | set(ko)):
    print(f'| {k} | {ko.get(k, 0):.1f} | {kn.get(k, 0):.1f} |')
