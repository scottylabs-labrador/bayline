"""Inspect the last profile solve (data/raw/metro/cache/profile_debug.npz): python3 tools/metro/debugprof.py TRACK s0 s1 [step]"""
import numpy as np, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from metro.common import w2ll, RAW
from metro.profile2 import STRUCT_NAMES
d = dict(np.load(os.path.join(RAW, 'cache', 'profile_debug.npz'), allow_pickle=True))
ids = list(d['ids']); off = d['off']
sepset = {}
for h, l in d['sep']:
    sepset.setdefault(int(h), []).append(('over', ids[d['tk'][l]])); sepset.setdefault(int(l), []).append(('under', ids[d['tk'][h]]))
tid, s0, s1 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]); step = float(sys.argv[4]) if len(sys.argv) > 4 else 10
k = ids.index(tid); a, b = off[k], off[k + 1]
last = -1e9
for q in range(a, b):
    s = float(d['s'][q])
    if s0 <= s <= s1 and s - last >= step - 1e-6:
        last = s
        la, lo = w2ll(d['x'][q], d['z'][q])
        f = lambda v, bad: '-' if bad else f'{v:.1f}'
        print(f"{tid} s={s:7.0f} {STRUCT_NAMES[d['code'][q]]:10s} y={d['y'][q]:7.2f} g={d['gc'][q]:7.2f} lo={f(d['lower'][q], d['lower'][q] < -1e8):>6s} hi={f(d['upper'][q], d['upper'][q] > 1e8):>6s} "
              f"tgt={f(d['tgt'][q], not np.isfinite(d['tgt'][q])):>6s} L={d['layer'][q]} {float(la):.5f},{float(lo):.5f} {sepset.get(q, '')}")
