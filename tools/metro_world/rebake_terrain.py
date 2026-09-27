#!/usr/bin/env python3
"""Terrain rebake from the USGS 3DEP lidar where the terrarium base predates the roads (M3.7, world workstream).

DATA's check (notes/bart/data.md on bart-data, "Terrain check for WORLD"; tools/metro/terrain_check.py) found the base
surface (AWS terrarium z15 / z13) up to 45 m off along SR-4 at Willow Pass (the regraded summit cut and its fills are
missing) and 1.5-6 m off from Pittsburg Center to Antioch (a pre-widening surface), plus a few isolated ramps. Inside
each area (with a feathered rim) the base takes the lidar as the L7 grid sees it, the same low-pass the h9 lidar detail
is taken against (tools/tiles/lidar.py: box-averaged to 6.25 m), so base + detail = the lidar there:

  L7 (6.25 m)   old + w * (lidarLP - old)                     w: 1 in the area, a smooth ramp to 0 over FEATHER m,
  L6 (12.5 m)   old + the L7 change at its vertices             0 where the lidar has no data
  L5 (25 m)     old + the L7 change box-averaged over 25 m
  L4 .. L0      old + the L5 change at their vertices           (decimated from L5, as they were baked)
  h9 L8 / L9    published + the (quantised) L7 change under them  (the detail they were baked with stays as it is)

Nothing else is derived from the base heights: masks, imagery, trees and towns are placed on the terrain at runtime, as
are the metro carve, walls and stations (MetroGround, INFRA, STATIONS); the metro data is not touched.

Staged as a replacement set: data/raw/tiles/fix_terrain/tiles/{h,h9}/..., manifest.json (path, old_sha256, new_sha256,
bytes; tiles/h9/index.json too when an L8 offset changes), published with the other sets (publish_world.sh terrain).
  python3 tools/metro_world/rebake_terrain.py [--areas willow,antioch,...] [--list]
"""
import argparse, hashlib, json, os, shutil, sys
import numpy as np
import cv2

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from tiles.common import T, bounds, ll2w, PUB, RAW, HN          # noqa: E402
from tiles import heights as H_                                   # noqa: E402
from tiles import lidar as LI                                     # noqa: E402

STAGE = os.path.join(RAW, 'tiles', 'fix_terrain')
FEATHER = 250.0
# (name, lat0, lat1, lon0, lon1): DATA's rebake areas (the isolated spots only where the base is terrarium: all of it)
AREAS = [
    ('willow',   38.003, 38.023, -122.025, -121.978),      # Willow Pass and North Concord (C1/C2 s 33400-38200)
    ('bailey',   38.020, 38.024, -121.970, -121.963),      # the SR-4 Bailey Rd ramp (+10 m)
    ('antioch',  37.994, 38.013, -121.870, -121.765),      # SR-4 Pittsburg Center to Antioch (the eBART median)
    ('elcerrito', 37.9285, 37.9330, -122.3270, -122.3225), # I-80 at El Cerrito del Norte (-7 m)
    ('glenpark', 37.7305, 37.7322, -122.4362, -122.4340),  # I-280 at Glen Park (+12 m)
    ('warm',     37.4850, 37.4880, -121.9335, -121.9295),  # East Warren Ave and its ramp, Warm Springs (+7 m)
    ('macarthur', 37.8278, 37.8300, -122.2680, -122.2658), # 40th St and a ramp at MacArthur (+7 m)
    ('castro',   37.6898, 37.6918, -122.0740, -122.0700),  # a ramp at Castro Valley (+-4 m)
    ('orinda',   37.8625, 37.8640, -122.2105, -122.2088),  # a ramp at Orinda (+4 m)
]


def sha(b):
    return hashlib.sha256(b).hexdigest()


def boxes(names):
    out = []
    for (n, la0, la1, lo0, lo1) in AREAS:
        if names and n not in names:
            continue
        xa, za = ll2w(la1, lo0); xb, zb = ll2w(la0, lo1)        # (north-west, south-east corners)
        out.append((n, min(xa, xb), min(za, zb), max(xa, xb), max(za, zb)))
    return out


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def weight(B, X, Z):
    """1 inside any area, a smoothstep to 0 over FEATHER m beyond its edges."""
    w = np.zeros_like(X, dtype=np.float64)
    for (_, x0, z0, x1, z1) in B:
        wx = smooth(x0 - FEATHER, x0, X) * (1.0 - smooth(x1, x1 + FEATHER, X))
        wz = smooth(z0 - FEATHER, z0, Z) * (1.0 - smooth(z1, z1 + FEATHER, Z))
        w = np.maximum(w, wx * wz)
    return w


def tiles_touching(B, L):
    t = T(L); out = set()
    for (_, x0, z0, x1, z1) in B:
        for ty in range(int(np.floor((z0 - FEATHER - (-49152.0)) / t)), int(np.floor((z1 + FEATHER - (-49152.0)) / t)) + 1):
            for tx in range(int(np.floor((x0 - FEATHER - (-45056.0)) / t)), int(np.floor((x1 + FEATHER - (-45056.0)) / t)) + 1):
                out.add((tx, ty))
    return sorted(out)


# ------------------------------------------------------------------ the new L7 base
_lp_cache = {}


def lidar_lp7(tx7, ty7):
    """The lidar's L7-grid low-pass at the 129 x 129 vertices of L7 tile (tx7, ty7), and where it is valid (away from
    no-data), from the four L8 fetches (lidar.mosaic_input: identical data on both sides of every tile edge)."""
    k = (tx7, ty7)
    if k in _lp_cache:
        return _lp_cache[k]
    LP = np.zeros((HN, HN), np.float32); OK = np.zeros((HN, HN), bool)
    for dy in (0, 1):
        for dx in (0, 1):
            tx8, ty8 = tx7 * 2 + dx, ty7 * 2 + dy
            try:
                a = LI.mosaic_input(tx8, ty8)
            except Exception as e:                    # (no fetch possible: leave this quarter as it is)
                print(f'  lidar {tx8},{ty8}: {e}', flush=True)
                continue
            nd = ~np.isfinite(a)
            if nd.all():
                continue
            fill = np.where(nd, np.nanmean(a), a).astype(np.float32)
            box = cv2.blur(fill, (5, 5), borderType=cv2.BORDER_REPLICATE)
            v = box[LI.M:LI.M + LI.NV:4, LI.M:LI.M + LI.NV:4]
            ndv = cv2.dilate(nd.astype(np.uint8), np.ones((13, 13), np.uint8))[LI.M:LI.M + LI.NV:4, LI.M:LI.M + LI.NV:4].astype(bool)
            sl = np.s_[dy * 64:dy * 64 + 65, dx * 64:dx * 64 + 65]
            LP[sl] = v; OK[sl] = ~ndv
    _lp_cache[k] = (LP, OK)
    return LP, OK


_new7 = {}


def new_l7(B, tx7, ty7):
    """(old, new) heights of L7 tile (tx7, ty7) (None if the tile does not exist)."""
    k = (tx7, ty7)
    if k in _new7:
        return _new7[k]
    old = H_.load(7, tx7, ty7)
    if old is None:
        _new7[k] = None
        return None
    X, Z = H_.grid(7, tx7, ty7)
    w = weight(B, X, Z)
    if w.max() <= 0:
        _new7[k] = (old, old)
        return _new7[k]
    LP, OK = lidar_lp7(tx7, ty7)
    w = np.where(OK, w, 0.0)
    new = (old + w * (LP - old)).astype(np.float32)
    _new7[k] = (old, new)
    return _new7[k]


def delta7_at(B, X, Z):
    """The L7 change (new - old) at world points that are L7 vertices (any shape)."""
    D = np.zeros(X.shape, np.float32)
    t = T(7)
    TX = np.floor((X - (-45056.0)) / t).astype(int); TY = np.floor((Z - (-49152.0)) / t).astype(int)
    I = np.rint((X - (-45056.0) - TX * t) / (t / 128)).astype(int); J = np.rint((Z - (-49152.0) - TY * t) / (t / 128)).astype(int)
    # a vertex on a tile's east / south edge (index 128) is the next tile's index 0 as well: either gives the same value
    for (tx, ty) in set(zip(TX.ravel().tolist(), TY.ravel().tolist())):
        r = new_l7(B, tx, ty)
        if r is None:
            continue
        old, new = r; m = (TX == tx) & (TY == ty)
        D[m] = (new - old)[np.clip(J[m], 0, 128), np.clip(I[m], 0, 128)]
    return D


# ------------------------------------------------------------------ bake
def stage_file(rel, data, manifest):
    old_p = os.path.join(os.path.dirname(PUB), rel)          # data/pub/v2/<rel>
    old = open(old_p, 'rb').read() if os.path.exists(old_p) else None
    if old is not None and sha(old) == sha(data):
        return False
    p = os.path.join(STAGE, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p + '.tmp', 'wb') as f:
        f.write(data)
    os.replace(p + '.tmp', p)
    manifest.append(dict(path=rel, old_sha256=sha(old) if old is not None else None, new_sha256=sha(data), bytes=len(data)))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--areas', default='')
    ap.add_argument('--list', action='store_true')
    a = ap.parse_args()
    names = [s for s in a.areas.split(',') if s]
    B = boxes(names)
    if a.list:
        for L in range(0, 8):
            print(L, len(tiles_touching(B, L)))
        return
    manifest, stats = [], {}
    if os.path.isdir(os.path.join(STAGE, 'tiles')):      # (a fresh set: nothing staged by an earlier run lingers)
        shutil.rmtree(os.path.join(STAGE, 'tiles'))
    # L7 (every touched tile whose encoding changes: a tile left out rounds to its published values everywhere, its edges
    # included, so the staged neighbours meet it exactly)
    n7 = 0; dmax = 0.0; q7 = {}
    for (tx, ty) in tiles_touching(B, 7):
        r = new_l7(B, tx, ty)
        if r is None:
            continue
        old, new = r
        enc = H_.encode(new)
        if stage_file(f'tiles/h/7/{tx}_{ty}.bin', enc, manifest):
            n7 += 1; dmax = max(dmax, float(np.abs(new - old).max()))
            q7[(tx, ty)] = (old, H_.decode_fast(enc))
    stats['L7'] = dict(tiles=n7, max_change_m=round(dmax, 1))
    print('L7', stats['L7'], flush=True)
    # L6: the L7 change at its vertices (the two levels share vertices exactly)
    n6 = 0
    for (tx, ty) in tiles_touching(B, 6):
        old = H_.load(6, tx, ty)
        if old is None:
            continue
        X, Z = H_.grid(6, tx, ty)
        if weight(B, X, Z).max() <= 0:
            continue
        if stage_file(f'tiles/h/6/{tx}_{ty}.bin', H_.encode(old + delta7_at(B, X, Z)), manifest):
            n6 += 1
    stats['L6'] = n6; print('L6', n6, flush=True)
    # L5: the L7 change box-averaged over the 25 m cell (a 5 x 5 vertex neighbourhood, triangle weights)
    k5 = np.array([1, 2, 2, 2, 1], np.float64) / 8.0
    d5 = {}
    n5 = 0
    for (tx, ty) in tiles_touching(B, 5):
        old = H_.load(5, tx, ty)
        if old is None:
            continue
        X, Z = H_.grid(5, tx, ty)
        if weight(B, X, Z).max() <= 0:
            continue
        s = T(7) / 128
        D = np.zeros(X.shape, np.float64)
        for j, wj in zip(range(-2, 3), k5):
            for i, wi in zip(range(-2, 3), k5):
                D += wj * wi * delta7_at(B, X + i * s, Z + j * s)
        d5[(tx, ty)] = D.astype(np.float32)
        if stage_file(f'tiles/h/5/{tx}_{ty}.bin', H_.encode(old + D.astype(np.float32)), manifest):
            n5 += 1
    stats['L5'] = n5; print('L5', n5, flush=True)
    # L4 .. L0: the L5 change at their vertices
    for L in range(4, -1, -1):
        nL = 0
        for (tx, ty) in tiles_touching(B, L):
            old = H_.load(L, tx, ty)
            if old is None:
                continue
            X, Z = H_.grid(L, tx, ty)
            t5 = T(5)
            TX = np.floor((X - (-45056.0)) / t5).astype(int); TY = np.floor((Z - (-49152.0)) / t5).astype(int)
            I = np.rint((X - (-45056.0) - TX * t5) / (t5 / 128)).astype(int); J = np.rint((Z - (-49152.0) - TY * t5) / (t5 / 128)).astype(int)
            D = np.zeros(X.shape, np.float32)
            for (a5, b5), dd in d5.items():
                m = (TX == a5) & (TY == b5)
                if m.any():
                    D[m] = dd[np.clip(J[m], 0, 128), np.clip(I[m], 0, 128)]
            if not np.any(D):
                continue
            if stage_file(f'tiles/h/{L}/{tx}_{ty}.bin', H_.encode(old + D), manifest):
                nL += 1
        stats[f'L{L}'] = nL; print(f'L{L}', nL, flush=True)
    # h9: the published lidar tiles plus the (quantised) L7 change under them, bilinear as the renderer draws the base:
    # the detail they were baked with stays exactly as published (H9 = base + detail), and where the L7 change is zero
    # (every staged tile's edge toward an unchanged one) the h9 edge is unchanged too
    idx_p = os.path.join(PUB, 'h9', 'index.json')
    idx = json.load(open(idx_p)); rows = {(r[0], r[1]): r for r in idx['l8'] + idx.get('l8n', [])}   # (l8n: the north strip)
    n8 = n9 = 0; changed_o = 0
    dec = lambda rel, o: H_.decode_fast(open(os.path.join(PUB, rel), 'rb').read(), LI.QS, -o)
    for (tx7, ty7), (old7, new7) in sorted(q7.items()):
        D7 = (new7 - old7).astype(np.float32)
        for dy in (0, 1):
            for dx in (0, 1):
                tx8, ty8 = tx7 * 2 + dx, ty7 * 2 + dy
                row = rows.get((tx8, ty8))
                if row is None:
                    continue
                o = int(row[3]); mask = row[2]
                D9 = LI._bilin_up4(D7[dy * 64:dy * 64 + 65, dx * 64:dx * 64 + 65])
                parts = []                                   # (rel path, new heights)
                r8 = f'tiles/h9/8/{tx8}_{ty8}.bin'
                if os.path.exists(os.path.join(os.path.dirname(PUB), r8)):
                    parts.append((r8, dec(r8[6:], o) + D9[::2, ::2]))
                for cy in (0, 1):
                    for cx in (0, 1):
                        r9 = f'tiles/h9/9/{tx8 * 2 + cx}_{ty8 * 2 + cy}.bin'
                        if (mask >> (cy * 2 + cx)) & 1 and os.path.exists(os.path.join(os.path.dirname(PUB), r9)):
                            parts.append((r9, dec(r9[6:], o) + D9[cy * 128:cy * 128 + HN, cx * 128:cx * 128 + HN]))
                if not parts:
                    continue
                lo = min(float(h.min()) for _, h in parts); hi = max(float(h.max()) for _, h in parts)
                # keep the published offset whenever the new heights still fit it (an index.json change would pair cached
                # tiles with the wrong offset); else a new one, as lidar.bake_l9 picks it
                if lo - o < 0.5 or hi - o > 511.0:
                    o = int(np.floor((lo - 16.0) / 8.0)) * 8
                    if hi + 16.0 - o > 511.0:
                        raise ValueError(f'h9 {tx8},{ty8}: relief {lo:.0f}..{hi:.0f}')
                    row[3] = o; changed_o += 1
                for rel, h in parts:
                    if stage_file(rel, H_.encode(h, LI.QS, -o), manifest):
                        if '/h9/8/' in rel:
                            n8 += 1
                        else:
                            n9 += 1
    stats['h9'] = dict(L8=n8, L9=n9, offsets_changed=changed_o)
    print('h9', stats['h9'], flush=True)
    if changed_o:
        stage_file('tiles/h9/index.json', json.dumps(idx, separators=(',', ':')).encode(), manifest)
    os.makedirs(STAGE, exist_ok=True)
    json.dump(dict(what='terrain rebake from the 3DEP lidar (M3.7): ' + ', '.join(b[0] for b in B), staged_root=STAGE, stats=stats, files=manifest),
              open(os.path.join(STAGE, 'manifest.json'), 'w'), indent=1)
    print('staged', len(manifest), 'files', flush=True)


if __name__ == '__main__':
    main()
