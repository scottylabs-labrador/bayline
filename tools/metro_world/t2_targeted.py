#!/usr/bin/env python3
"""t2 for a given list of L7 tiles only (data/raw/tiles/t2_rebake.json), then the t2 index."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles import common as C, trees2 as T2   # noqa: E402
import bake_trees2 as B                        # noqa: E402
todo = [tuple(t) for t in json.load(open(os.path.join(C.WORK, 't2_rebake.json')))]
shifts = json.load(open(B.SHIFTS)) if os.path.exists(B.SHIFTS) else {}
n = 0
for t in sorted(todo, key=lambda c: (c[1], c[0])):
    r = T2.bake_tile(t[0], t[1], force=False, shift=B.shift_for(t, shifts)); n += r[2] == 'ok'
print(n, 'of', len(todo), 't2 tiles made', flush=True)
