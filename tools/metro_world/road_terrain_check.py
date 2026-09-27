#!/usr/bin/env python3
"""Where the terrain shows through the road ribbons (M3.7, world workstream).

For every road Towns draws (not bridges), at its ribbon stations (every 12 m, as roadRibbon builds them near the camera)
and across the asphalt every 2 m, the ribbon's surface (a flat strip from edge to edge, each edge taking the ground's
cross-slope toward the ribbon's outer edge, never more than 0.6 m under the centre, plus the road's lift) is compared
with the L7 base terrain there (the lidar detail is held at zero under roads) after MetroGround's runtime carve along
the ground-level tracks (metro_carve.py; --no-carve for the natural surface), which is what Towns builds on
(Terrain.hBase) and what the terrain draws. A sample "shows through" when the terrain is above the drawn asphalt by
more than 5 cm.

  python3 tools/metro_world/road_terrain_check.py [--overlay data/raw/tiles/fix_terrain] [--near 300] [--all] [--areas a,b|all]
      --near m   towns tiles within m of any metro track (default); --all every towns tile; --areas: the rebake areas
                 (rebake_terrain.AREAS) only; the counts inside each area are reported in every mode
      --overlay  a staged replacement set whose tiles/h/7 replace the published ones (the rebake, before publishing)
"""
import argparse, json, os, re, sys
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tiles.common import PUB, w2ll                    # noqa: E402
from tiles import heights as H_                         # noqa: E402
from tiles import towns_dec as TD                       # noqa: E402

CREST_CAP = 1.2                                          # (30_towns.js crestRaise)
LIFT = [0.40, 0.36, 0.38, 0.35, 0.33, 0.31, 0.30, 0.29, 0.28, 0.27, 0.25, 0.24, 0.24, 0.22, 0.23]
T7, X0, Z0 = 800.0, -45056.0, -49152.0


class L7:
    def __init__(self, overlay=None, carve=None):
        self.c = {}; self.ov = overlay; self.carve = carve

    def tile(self, tx, ty):
        k = (tx, ty)
        if k not in self.c:
            H = None
            if self.ov:
                p = os.path.join(self.ov, 'tiles', 'h', '7', f'{tx}_{ty}.bin')
                if os.path.exists(p):
                    H = H_.decode_fast(open(p, 'rb').read())
            if H is None:
                H = H_.load(7, tx, ty)
            if H is not None and self.carve is not None:
                H = self.carve.apply(X0 + tx * T7, Z0 + ty * T7, T7, H)
            self.c[k] = H
        return self.c[k]

    def at(self, X, Z):
        """Bilinear L7 height at world points (arrays); NaN where no tile."""
        X = np.asarray(X, np.float64); Z = np.asarray(Z, np.float64)
        out = np.full(X.shape, np.nan)
        TX = np.floor((X - X0) / T7).astype(int); TY = np.floor((Z - Z0) / T7).astype(int)
        for (tx, ty) in set(zip(TX.ravel().tolist(), TY.ravel().tolist())):
            H = self.tile(tx, ty)
            if H is None:
                continue
            m = (TX == tx) & (TY == ty)
            fx = (X[m] - (X0 + tx * T7)) / 6.25; fz = (Z[m] - (Z0 + ty * T7)) / 6.25
            i = np.clip(np.floor(fx).astype(int), 0, 127); j = np.clip(np.floor(fz).astype(int), 0, 127)
            u = fx - i; v = fz - j
            out[m] = (H[j, i] * (1 - u) + H[j, i + 1] * u) * (1 - v) + (H[j + 1, i] * (1 - u) + H[j + 1, i + 1] * u) * v
        return out


def stations(P, seg=12.0):
    out = [P[0]]
    for a, b in zip(P[:-1], P[1:]):
        L = np.hypot(b[0] - a[0], b[1] - a[1]); m = max(1, int(np.ceil(L / seg)))
        for k in range(1, m + 1):
            t = k / m; out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return np.array(out, np.float64)


def check_road(r, region, G):
    """-> (samples, showing, worst (m, x, z)) for one road."""
    P = np.array(r['pts'], np.float64)
    if len(P) < 2:
        return 0, 0, None, None
    S = stations(P); n = len(S)
    if n < 2:
        return 0, 0, None, None
    tng = np.zeros_like(S); tng[1:-1] = S[2:] - S[:-2]; tng[0] = S[1] - S[0]; tng[-1] = S[-1] - S[-2]
    L = np.hypot(tng[:, 0], tng[:, 1]); L[L < 1e-9] = 1
    nx = -tng[:, 1] / L; nz = tng[:, 0] / L
    hw = r['width'] / 2.0; outer = TD.road_extent(r, region) + 0.4; k = min(1.0, hw / outer); lift = LIFT[min(r['cls'], 14)]
    gC = G.at(S[:, 0], S[:, 1]); gP = G.at(S[:, 0] + nx * outer, S[:, 1] + nz * outer); gN = G.at(S[:, 0] - nx * outer, S[:, 1] - nz * outer)
    yP = np.maximum(gC + (gP - gC) * k, gC - 0.6); yN = np.maximum(gC + (gN - gC) * k, gC - 0.6)
    offs = np.arange(-hw + 0.5, hw - 0.49, 2.0)
    if not len(offs):
        offs = np.array([0.0])
    O = offs[None, :]
    X = S[:, 0:1] + nx[:, None] * O; Z = S[:, 1:2] + nz[:, None] * O
    strip = yN[:, None] + (yP - yN)[:, None] * (O + hw) / (2 * hw) + lift
    ter = G.at(X, Z)
    d = ter - strip
    ok = np.isfinite(d)
    show = ok & (d > 0.05)
    worst = None
    if show.any():
        a = np.argmax(np.where(show, d, -1e9)); j, i = np.unravel_index(a, d.shape); worst = (float(d[j, i]), float(X[j, i]), float(Z[j, i]))
    return int(ok.sum()), int(show.sum()), worst, (X[ok], Z[ok], show[ok])


def check_road_fine(r, region, G, guard=False, sub=4):
    """As check_road, but sampled between the ribbon's stations as well (sub samples per 12 m span, the strip linear
    between its stations as the quads draw it), optionally with the crest guard as 30_towns.js crestRaise builds it
    (each station's strip raised by the most the terrain stands above it across the asphalt there or halfway to either
    neighbour, at most CREST_CAP m)."""
    P = np.array(r['pts'], np.float64)
    if len(P) < 2:
        return 0, 0, None, None
    S = stations(P); n = len(S)
    if n < 2:
        return 0, 0, None, None
    tng = np.zeros_like(S); tng[1:-1] = S[2:] - S[:-2]; tng[0] = S[1] - S[0]; tng[-1] = S[-1] - S[-2]
    L = np.hypot(tng[:, 0], tng[:, 1]); L[L < 1e-9] = 1
    nx = -tng[:, 1] / L; nz = tng[:, 0] / L
    hw = r['width'] / 2.0; outer = TD.road_extent(r, region) + 0.4; k = min(1.0, hw / outer); lift = LIFT[min(r['cls'], 14)]
    gC = G.at(S[:, 0], S[:, 1]); gP = G.at(S[:, 0] + nx * outer, S[:, 1] + nz * outer); gN = G.at(S[:, 0] - nx * outer, S[:, 1] - nz * outer)
    yP = np.maximum(gC + (gP - gC) * k, gC - 0.6); yN = np.maximum(gC + (gN - gC) * k, gC - 0.6)
    offs = np.arange(-hw + 0.5, hw - 0.49, 2.0)
    if not len(offs):
        offs = np.array([0.0])
    O = offs[None, :]
    if guard:
        gof = np.linspace(-hw, hw, max(3, int(np.ceil(2 * hw / 2.0)) + 1))[None, :]
        def exc(X0, Z0, NX, NZ, yn, yp):
            X = X0[:, None] + NX[:, None] * gof; Z = Z0[:, None] + NZ[:, None] * gof
            st = yn[:, None] + (yp - yn)[:, None] * (gof + hw) / (2 * hw)
            e = G.at(X, Z) - st
            return np.nan_to_num(np.nanmax(np.where(np.isfinite(e), e, -1e9), axis=1), nan=0.0)
        e_st = exc(S[:, 0], S[:, 1], nx, nz, yN, yP)
        mx = (S[:-1] + S[1:]) / 2; mnx = (nx[:-1] + nx[1:]) / 2; mnz = (nz[:-1] + nz[1:]) / 2; ml = np.hypot(mnx, mnz); ml[ml < 1e-9] = 1
        e_mid = exc(mx[:, 0], mx[:, 1], mnx / ml, mnz / ml, (yN[:-1] + yN[1:]) / 2, (yP[:-1] + yP[1:]) / 2)
        R = np.maximum(0.0, e_st)
        R[:-1] = np.maximum(R[:-1], e_mid); R[1:] = np.maximum(R[1:], e_mid)
        R = np.minimum(R, CREST_CAP)
        yN = yN + R; yP = yP + R
    tt = np.arange(sub) / sub
    ia = np.repeat(np.arange(n - 1), sub); tv = np.tile(tt, n - 1)
    ia = np.append(ia, n - 2); tv = np.append(tv, 1.0)
    ib = ia + 1
    PX = S[ia, 0] + (S[ib, 0] - S[ia, 0]) * tv; PZ = S[ia, 1] + (S[ib, 1] - S[ia, 1]) * tv
    NX = nx[ia] + (nx[ib] - nx[ia]) * tv; NZ = nz[ia] + (nz[ib] - nz[ia]) * tv; NL = np.hypot(NX, NZ); NL[NL < 1e-9] = 1; NX /= NL; NZ /= NL
    YN = yN[ia] + (yN[ib] - yN[ia]) * tv; YP = yP[ia] + (yP[ib] - yP[ia]) * tv
    X = PX[:, None] + NX[:, None] * O; Z = PZ[:, None] + NZ[:, None] * O
    strip = YN[:, None] + (YP - YN)[:, None] * (O + hw) / (2 * hw) + lift
    d = G.at(X, Z) - strip
    ok = np.isfinite(d)
    show = ok & (d > 0.05)
    worst = None
    if show.any():
        a = np.argmax(np.where(show, d, -1e9)); j, i = np.unravel_index(a, d.shape); worst = (float(d[j, i]), float(X[j, i]), float(Z[j, i]))
    return int(ok.sum()), int(show.sum()), worst, (X[ok], Z[ok], show[ok])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--overlay', default='')
    ap.add_argument('--near', type=float, default=300.0)
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--json', default='')
    ap.add_argument('--no-carve', action='store_true', help='the natural L7 (without MetroGround\'s runtime carve)')
    ap.add_argument('--fine', action='store_true', help='sample between the ribbon stations too (4 per 12 m span)')
    ap.add_argument('--guard', action='store_true', help='with the crest guard (implies --fine)')
    ap.add_argument('--areas', default='', help='only towns tiles touching these rebake areas (comma list, or "all")')
    a = ap.parse_args()
    import rebake_terrain as RB
    AB = RB.boxes([])
    C = None
    if not a.no_carve:
        from metro_carve import Carve
        C = Carve()
    G = L7(a.overlay or None, C)
    b7 = os.path.join(PUB, 'b', '7'); b27 = os.path.join(PUB, 'b2', '7')
    keys = set()
    for d in (b7, b27):
        if os.path.isdir(d):
            for f in os.listdir(d):
                m = re.match(r'^(-?\d+)_(-?\d+)\.bin$', f)
                if m:
                    keys.add((int(m.group(1)), int(m.group(2))))
    if a.areas:
        want = [x for x in AB if a.areas == 'all' or x[0] in a.areas.split(',')]
        keys = {(tx, ty) for (tx, ty) in keys if any(X0 + tx * T7 < x1 + RB.FEATHER and X0 + (tx + 1) * T7 > x0 - RB.FEATHER and
                                                     Z0 + ty * T7 < z1 + RB.FEATHER and Z0 + (ty + 1) * T7 > z0 - RB.FEATHER
                                                     for (_, x0, z0, x1, z1) in want)}
    elif not a.all:
        from tiles import metro as MT
        from scipy.spatial import cKDTree
        pts = np.concatenate([t['P'][::4][:, [0, 2]] for t in MT.network_tracks()])
        kd = cKDTree(pts)
        keep = set()
        for (tx, ty) in keys:
            cx, cz = X0 + (tx + 0.5) * T7, Z0 + (ty + 0.5) * T7
            if kd.query([cx, cz])[0] < a.near + 570:          # (the tile's half-diagonal)
                keep.add((tx, ty))
        keys = keep
    tot = show = 0; worst = []; per = {}
    for (tx, ty) in sorted(keys):
        d = TD.decode(tx, ty)
        if d is None:
            continue
        for r in d['roads']:
            if r['flags'] & 2:
                continue
            n, s, w, arr = check_road_fine(r, d['region'], G, a.guard) if (a.fine or a.guard) else check_road(r, d['region'], G)
            tot += n; show += s
            if arr is not None and n:
                X, Z, S = arr
                for (nm, x0, z0, x1, z1) in AB:
                    m = (X >= x0) & (X <= x1) & (Z >= z0) & (Z <= z1)
                    if m.any():
                        q = per.setdefault(nm, [0, 0]); q[0] += int(m.sum()); q[1] += int(S[m].sum())
            if w and w[0] > 0.3:
                la, lo = w2ll(w[1], w[2]); worst.append((round(w[0], 2), round(float(la), 5), round(float(lo), 5), r['cls']))
    worst.sort(reverse=True)
    res = dict(tiles=len(keys), samples=tot, showing=show, pct=round(100.0 * show / max(1, tot), 3), worst=worst[:15],
               areas={k: dict(samples=v[0], showing=v[1]) for k, v in sorted(per.items())})
    print(json.dumps(res))
    if a.json:
        json.dump(res, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
