"""Print a staged/published track's solved profile against the lidar ground (reads the files, not the debug dump):
    python3 tools/metro/trackprof.py TRACK s0 s1 [step] [dir=data/pub/v2/metro-next]"""
import json, os, sys, zlib
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from metro.common import ROOT, w2ll
from metro.dem import ground
tid, s0, s1 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
step = float(sys.argv[4]) if len(sys.argv) > 4 else 25.0
d = sys.argv[5] if len(sys.argv) > 5 else os.path.join(ROOT, 'data/pub/v2/metro-next')
n = json.load(open(os.path.join(d, 'network.json')))
h = next(t for t in n['tracks'] if t['id'] == tid)
raw = zlib.decompress(open(os.path.join(os.path.dirname(d.rstrip('/')), n['tracksBin']['path']), 'rb').read())
P = np.frombuffer(raw, np.float32, h['n'] * 3, h['off']).reshape(-1, 3).astype(float)
A = np.frombuffer(raw, np.uint8, h['n'] * h.get('planes', 4), h['off'] + h['n'] * 12)
st, vl = A[:h['n']], A[h['n']:2 * h['n']]
idx = [i for i in range(h['n']) if s0 <= i * h['step'] <= s1][::max(1, int(round(step / h['step'])))]
g, src = ground(P[idx, 0], P[idx, 2])
for k, i in enumerate(idx):
    la, lo = w2ll(P[i, 0], P[i, 2])
    gr = (P[min(i + 1, h['n'] - 1), 1] - P[max(i - 1, 0), 1]) / (2 * h['step'])
    print(f"{tid} s={i * h['step']:7.0f} {n['structCodes'][st[i]]:10s} y={P[i, 1]:7.2f} g={g[k]:7.2f} y-g={P[i, 1] - g[k]:6.2f} "
          f"grade={gr * 100:5.2f}% {vl[i]:2d}mph {float(la):.5f},{float(lo):.5f}")
