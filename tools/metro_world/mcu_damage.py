#!/usr/bin/env python3
"""How visible is the damage of a truncated JPEG scan (the last MCU, bottom-right 16 x 16 px): the mean jump across its
top and left borders minus the same measure for the MCU to its left and the one above it (natural imagery is continuous
across MCU borders). Input: corrupt_<mode>.json (tools/metro_world/scan_corrupt.py) -> mcu_damage_<mode>.json
  python3 tools/metro_world/mcu_damage.py new|published
"""
import json, os, sys
import numpy as np
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles import common as C   # noqa: E402


def jump(a, y0, x0, G=16):
    blk = a[y0:y0 + G, x0:x0 + G]
    top = np.abs(blk[0] - a[y0 - 1, x0:x0 + G]).mean(); left = np.abs(blk[:, 0] - a[y0:y0 + G, x0 - 1]).mean()
    return (top + left) / 2


def damage(p):
    a = np.asarray(Image.open(p).convert('RGB')).astype(np.float32); n = a.shape[0]; G = 16
    last = jump(a, n - G, n - G)
    ref = (jump(a, n - G, n - 2 * G) + jump(a, n - 2 * G, n - G)) / 2
    blk = a[n - G:, n - G:].astype(np.int16)
    green = float(((blk[..., 1] - np.maximum(blk[..., 0], blk[..., 2])) >= 80).mean())
    return round(float(last - ref), 1), round(green, 2)


def main():
    mode = sys.argv[1]
    d = json.load(open(os.path.join(C.WORK, f'corrupt_{mode}.json')))
    out = []
    for rel, msg in d['corrupt']:
        kind = 'premature' if 'premature' in msg else 'extraneous' if 'extraneous' in msg else 'other'
        dm, g = damage(os.path.join(C.PUB, rel))
        out.append([rel, kind, dm, g])
    json.dump(out, open(os.path.join(C.WORK, f'mcu_damage_{mode}.json'), 'w'))
    import collections
    k = collections.Counter(o[1] for o in out); print(mode, d['checked'], 'checked', dict(k))
    for kind in ('premature', 'extraneous'):
        v = np.array([o[2] for o in out if o[1] == kind]) if any(o[1] == kind for o in out) else np.zeros(1)
        print(f'  {kind}: damage p50 {np.percentile(v, 50):.1f} p90 {np.percentile(v, 90):.1f} p99 {np.percentile(v, 99):.1f} max {v.max():.1f};'
              f' >10: {(v > 10).sum()}, >20: {(v > 20).sum()}, >40: {(v > 40).sum()}; green corners {sum(1 for o in out if o[1] == kind and o[3] >= 0.9)}')


if __name__ == '__main__':
    main()
