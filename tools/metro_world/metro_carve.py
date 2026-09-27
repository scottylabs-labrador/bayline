#!/usr/bin/env python3
"""MetroGround's runtime carve (src/js/19_metroground.js, filter) in numpy, for checks run off the browser.

The same segments (every ground-level track sample: grade / embankment / median to the bed, trench cut, the platform
strips of ground-level stations) and the same rule, applied to a height tile's vertex grid. Used by
road_terrain_check.py: Towns builds its road ribbons on Terrain.hBase, the L7 surface after this filter.

  C = Carve(); C.apply(x0, z0, T, H)     # H: (129, 129) natural heights of a tile at (x0, z0), size T m -> carved copy
"""
import json, os, sys
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from tiles import metro as MT                              # noqa: E402

BED, CORE, SLOPE, SLOPE_MIN, SLOPE_MAX = 0.85, 2.4, 2.0, 1.5, 16.0
TRENCH_D, TRENCH_CORE, TRENCH_EDGE = 1.2, 3.0, 0.9
PLAT_IN, PLAT_W, PLAT_EDGE = 1.2, 11.0, 1.5
REACH = CORE + SLOPE_MAX + 1
CELL = 100.0


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


class Carve:
    def __init__(self):
        segs = []
        tracks = MT.network_tracks()
        by = {t['id']: t for t in tracks}
        for t in tracks:
            P, ST = t['P'], t['struct']
            for i in range(len(P) - 1):
                s = int(ST[i])
                if s in (0, 3, 5):
                    segs.append((P[i, 0], P[i, 2], P[i + 1, 0], P[i + 1, 2], P[i, 1] - BED, P[i + 1, 1] - BED, 0, 0))
                elif s == 4:
                    segs.append((P[i, 0], P[i, 2], P[i + 1, 0], P[i + 1, 2], P[i, 1] - TRENCH_D, P[i + 1, 1] - TRENCH_D, 1, 0))
        net = json.load(open(MT.NETWORK))
        for st in net.get('stations', []):
            for p in st.get('platforms', []):
                if p.get('structure') not in ('grade', 'embankment', 'median', 'trench'):
                    continue
                tr = by.get(p.get('track'))
                if tr is None:
                    continue
                side = -1 if p.get('side') == 'left' else 1
                length = (len(tr['P']) - 1) * tr['step']
                s0 = max(0.0, min(p['s0'], p['s1']) - 5); s1 = min(length, max(p['s0'], p['s1']) + 5)
                prev = None; s = s0; stp = min(5.0, (s1 - s0) or 5.0)
                while s <= s1 + 0.01:
                    x, y, z = self._frame(tr, min(s, s1))
                    cur = (x, z, y - BED)
                    if prev:
                        segs.append((prev[0], prev[1], cur[0], cur[1], prev[2], cur[2], 2, side))
                    prev = cur
                    if s >= s1:
                        break
                    s += stp
        self.S = np.array(segs, np.float64).reshape(-1, 8)
        self.grid = {}
        for k, (ax, az, bx, bz, _, _, kind, _) in enumerate(self.S):
            r = REACH if kind == 0 else (TRENCH_CORE + TRENCH_EDGE + 1 if kind == 1 else PLAT_W + PLAT_EDGE + 1)
            for cz in range(int(np.floor((min(az, bz) - r) / CELL)), int(np.floor((max(az, bz) + r) / CELL)) + 1):
                for cx in range(int(np.floor((min(ax, bx) - r) / CELL)), int(np.floor((max(ax, bx) + r) / CELL)) + 1):
                    self.grid.setdefault((cx, cz), []).append(k)

    @staticmethod
    def _frame(t, s):
        P, st = t['P'], t['step']; n = len(P)
        f = min(max(s / st, 0.0), n - 1.000001); i = int(f); a = f - i
        q = P[i] + (P[i + 1] - P[i]) * a
        return float(q[0]), float(q[1]), float(q[2])

    def apply(self, x0, z0, T, H):
        """The carved copy of H (N x N vertex heights over [x0, x0 + T] x [z0, z0 + T]); H itself if nothing changes."""
        N = H.shape[0]; step = T / (N - 1)
        cand = set()
        for cz in range(int(np.floor(z0 / CELL)), int(np.floor((z0 + T) / CELL)) + 1):
            for cx in range(int(np.floor(x0 / CELL)), int(np.floor((x0 + T) / CELL)) + 1):
                cand.update(self.grid.get((cx, cz), ()))
        if not cand:
            return H
        h = H.astype(np.float64)
        tw = np.zeros_like(h); tt = np.zeros_like(h); tc = np.full_like(h, 1e9)
        for k in sorted(cand):
            ax, az, bx, bz, ta, tb, kind, side = self.S[k]
            r = REACH if kind == 0 else (TRENCH_CORE + TRENCH_EDGE if kind == 1 else PLAT_W + PLAT_EDGE)
            i0 = max(0, int(np.floor((min(ax, bx) - r - x0) / step))); i1 = min(N - 1, int(np.ceil((max(ax, bx) + r - x0) / step)))
            j0 = max(0, int(np.floor((min(az, bz) - r - z0) / step))); j1 = min(N - 1, int(np.ceil((max(az, bz) + r - z0) / step)))
            if i0 > i1 or j0 > j1:
                continue
            px = x0 + np.arange(i0, i1 + 1) * step; pz = z0 + np.arange(j0, j1 + 1) * step
            PX, PZ = np.meshgrid(px, pz)
            dx, dz = bx - ax, bz - az; L2 = dx * dx + dz * dz; ln = np.sqrt(L2) or 1.0
            u = np.clip(((PX - ax) * dx + (PZ - az) * dz) / L2, 0.0, 1.0) if L2 > 1e-9 else np.zeros_like(PX)
            d = np.hypot(PX - (ax + dx * u), PZ - (az + dz * u)); tgt = ta + (tb - ta) * u
            sl = np.s_[j0:j1 + 1, i0:i1 + 1]
            hn = h[sl]
            if kind == 0:
                wid = np.clip(SLOPE * np.abs(hn - tgt), SLOPE_MIN, SLOPE_MAX)
                w = 1 - sstep(CORE, CORE + wid, d)
                m = w > tw[sl]
                tw[sl] = np.where(m, w, tw[sl]); tt[sl] = np.where(m, tgt, tt[sl])
            else:
                if kind == 1:
                    w = 1 - sstep(TRENCH_CORE, TRENCH_CORE + TRENCH_EDGE, d)
                else:
                    lat = ((PX - ax) * -dz + (PZ - az) * dx) / ln * side
                    w = (1 - sstep(PLAT_W, PLAT_W + PLAT_EDGE, lat)) * sstep(PLAT_IN - PLAT_EDGE, PLAT_IN, lat) * (1 - sstep(0.5, 3, np.abs(d - np.abs(lat))))
                    w = np.where(lat < PLAT_IN - PLAT_EDGE, 0.0, w)
                hc = hn - np.maximum(0.0, hn - tgt) * w
                tc[sl] = np.where(w > 0, np.minimum(tc[sl], hc), tc[sl])
        v = np.where(tw > 0, h + (tt - h) * tw, h)
        v = np.minimum(v, tc)
        return v.astype(np.float32)
