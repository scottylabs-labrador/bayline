#!/usr/bin/env python3
"""Bayline Metro world: index consistency + the publish manifest.

  python3 tools/metro_world/verify.py            # checks; writes data/raw/tiles/publish_manifest.json

Checks (square and the north strip): every tile an index lists exists (tiles/index.json levels + north.levels: img, and
h + m up to L7; north.complete: every strip tile of L2-L5; h9 l8 / l8n rows and their L9 children; mat / t2 tiles + north;
b2 tiles); no new file is left unlisted; published (pre-Metro) files are unchanged (only index.json files may differ).
Manifest: every file added or changed since the pre-Metro snapshot (data/raw/tiles/coverage_pre_bart.json), grouped
by directory with counts and bytes.
"""
import json, os, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles import common as C   # noqa: E402

PUB = C.PUB
REF = os.path.getmtime(os.path.join(C.WORK, 'coverage_pre_bart.json'))


def load(p):
    return json.load(open(os.path.join(PUB, p)))


def main():
    problems = []; changed_old = []
    listed = set()
    idx = load('index.json')
    lv = idx['levels']; nv = (idx.get('north') or {}).get('levels', {})
    for src, levels in (('levels', lv), ('north', nv)):
        for L, tl in levels.items():
            L = int(L)
            for (x, y) in tl:
                p = C.path('img', L, x, y, 'jpg'); listed.add(p)
                if not os.path.exists(p):
                    problems.append(f'{src} L{L} {x}_{y}: no img')
                if L <= 7:
                    for prod in ('h', 'm'):
                        q = C.path(prod, L, x, y, 'bin'); listed.add(q)
                        if not os.path.exists(q):
                            problems.append(f'{src} L{L} {x}_{y}: no {prod}')
                if src == 'north' and y >= 0 or src == 'levels' and y < 0:
                    problems.append(f'{src} L{L} {x}_{y}: in the wrong list')
    n = idx.get('north') or {}
    if n.get('complete'):
        for L in range(n['complete'][0], n['complete'][1] + 1):
            for (x, y) in C.north_tiles(L):
                for prod, ext in (('img', 'jpg'), ('h', 'bin'), ('m', 'bin')):
                    p = C.path(prod, L, x, y, ext); listed.add(p)
                    if not os.path.exists(p):
                        problems.append(f'north complete L{L} {x}_{y}: no {prod}')
    for L in range(0, 6):                                  # the square's complete levels
        for (x, y) in [(x, y) for y in range(1 << L) for x in range(1 << L)]:
            for prod, ext in (('img', 'jpg'), ('h', 'bin'), ('m', 'bin')):
                listed.add(C.path(prod, L, x, y, ext))
    # tree crowns: every listed L7 tile may have one (Flora probes levels['7'] / north)
    for L7 in [tuple(t) for t in lv.get('7', [])] + [tuple(t) for t in nv.get('7', [])]:
        listed.add(C.path('t', 7, *L7, 'bin'))
    # h9
    h9 = load('h9/index.json')
    for r in h9['l8'] + h9.get('l8n', []):
        x, y, m, o = r
        p = os.path.join(PUB, 'h9', '8', f'{x}_{y}.bin'); listed.add(p)
        if not os.path.exists(p):
            problems.append(f'h9 L8 {x}_{y} missing')
        for b in range(4):
            q = os.path.join(PUB, 'h9', '9', f'{2 * x + (b & 1)}_{2 * y + (b >> 1)}.bin')
            if m & (1 << b):
                listed.add(q)
                if not os.path.exists(q):
                    problems.append(f'h9 L9 {q} missing')
        if (y < 0) != (r in h9.get('l8n', [])):
            problems.append(f'h9 {x}_{y} in the wrong list')
    for prod in ('mat', 't2'):
        j = load(f'{prod}/index.json')
        for (x, y) in j['tiles'] + j.get('north', []):
            p = os.path.join(PUB, prod, '7', f'{x}_{y}.bin'); listed.add(p)
            if not os.path.exists(p):
                problems.append(f'{prod} {x}_{y} missing')
    for layer in ('b', 'b2'):
        if not os.path.exists(os.path.join(PUB, layer, 'index.json')):
            continue
        for t in load(f'{layer}/index.json')['tiles']:
            p = os.path.join(PUB, layer, '7', f'{t[0]}_{t[1]}.bin'); listed.add(p)
            if not os.path.exists(p):
                problems.append(f'{layer} {t[0]}_{t[1]} missing')
            if t[4]:
                q = p[:-4] + '.sky.bin'; listed.add(q)
                if not os.path.exists(q):
                    problems.append(f'{layer} sky {t[0]}_{t[1]} missing')
    # published (pre-Metro) tiles must be untouched: the old coverage's img / h / m and the square's L0-L5
    pre = json.load(open(os.path.join(C.WORK, 'coverage_pre_bart.json')))
    old = [(L, x, y) for L in range(6) for y in range(1 << L) for x in range(1 << L)]
    old += [(int(L), x, y) for L in ('6', '7', '8') for (x, y) in pre[L]]
    for (L, x, y) in old:
        for prod, ext in (('img', 'jpg'), ('h', 'bin'), ('m', 'bin')):
            if L > 7 and prod != 'img':
                continue
            p = C.path(prod, L, x, y, ext)
            if os.path.exists(p) and os.path.getmtime(p) >= REF:
                changed_old.append(os.path.relpath(p, PUB))
    # manifest + orphans + changed old files
    groups = defaultdict(lambda: [0, 0]); orphans = []
    for dp, dn, fn in os.walk(PUB):
        for f in fn:
            p = os.path.join(dp, f)
            if os.path.getmtime(p) < REF:
                continue
            rel = os.path.relpath(p, PUB)
            g = groups[os.path.dirname(rel)]; g[0] += 1; g[1] += os.path.getsize(p)
            if f.endswith('.json') or '/globe/' in p:
                continue
            if p not in listed and not f.endswith('.tmp'):
                orphans.append(rel)
    total = sum(v[1] for v in groups.values())
    man = {'files': sum(v[0] for v in groups.values()), 'bytes': total,
           'dirs': {k: {'files': v[0], 'MB': round(v[1] / 1e6, 1)} for k, v in sorted(groups.items())}}
    json.dump(man, open(os.path.join(C.WORK, 'publish_manifest.json'), 'w'), indent=1)
    print(f'{len(problems)} problems'); [print('  ', p) for p in problems[:30]]
    print(f'{len(orphans)} new files no index lists'); [print('  ', o) for o in orphans[:15]]
    print(f'{len(changed_old)} pre-Metro tile files changed'); [print('  ', o) for o in changed_old[:15]]
    print(f'manifest: {man["files"]} files, {total / 1e9:.2f} GB')
    for k, v in man['dirs'].items():
        print(f'  tiles/{k}: {v["files"]} files, {v["MB"]} MB')


if __name__ == '__main__':
    main()
