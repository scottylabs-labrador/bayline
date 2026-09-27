#!/usr/bin/env python3
"""No lidar relief beside BART trenches (M3.8, world workstream; INFRA's request at A1.2 ~33300).

INFRA walls every trench from 3 m out, with a coping and a skirt at the natural ground, which it reads from the L7 base
beyond the carve (7.2 and 10.2 m out). The lidar layer (tiles/h9) has the real walls, fences and spoil in it, up to ~1 m
over the natural ground (A1.2 33300: 3.2-3.7 m over the rail 4-6 m right of the track, the L7 base 2.5 m), and buries
the coping. The rule (tools/tiles/lidar.py trench_weight, applied by every future bake too): no lidar detail within
TRENCH_KEEP = 10 m of a trench centreline (7 m behind its wall), smoothstep to full detail over TRENCH_RAMP = 3 m.

The published h9 tiles are rewritten by that rule without the detail cache: h = base + w * (h_published - base), base the
L7 surface bilinear at the tile's samples (what the bake added the detail to), so outside the ramp nothing changes, and
two tiles still agree on their shared edges. h9 offsets are unchanged (the new heights lie between base and published).

Built on top of the M3.7 terrain set (data/raw/tiles/fix_terrain): where it stages a file, that file is the source and
its new hash is this set's old_sha256, so publish fix_terrain first. Staged as a replacement set:
data/raw/tiles/fix_trench/tiles/h9/{8,9}/..., manifest.json (path, old_sha256, new_sha256, bytes), published with
publish_world.sh trench-check / trench.
  python3 tools/metro_world/fix_trench.py [--stats-only]
"""
import argparse, hashlib, json, os, shutil, sys
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from tiles.common import PUB, RAW, HN, bounds, w2ll          # noqa: E402
from tiles import heights as H_                                # noqa: E402
from tiles import lidar as LI                                  # noqa: E402

STAGE = os.path.join(RAW, 'tiles', 'fix_trench')
BEFORE = [os.path.join(RAW, 'tiles', 'fix_terrain')]          # sets published before this one (their staged files win)
PUBROOT = os.path.dirname(PUB)                                 # data/pub/v2


def sha(b):
    return hashlib.sha256(b).hexdigest()


def effective(rel):
    """The bytes of rel (tiles/...) as the server will have them once the sets before this one are published."""
    for root in BEFORE:
        p = os.path.join(root, rel)
        if os.path.exists(p):
            return open(p, 'rb').read(), os.path.basename(root)
    p = os.path.join(PUBROOT, rel)
    return (open(p, 'rb').read(), 'pub') if os.path.exists(p) else (None, None)


def l7(tx, ty):
    b, _ = effective(f'tiles/h/7/{tx}_{ty}.bin')
    return None if b is None else H_.decode_fast(b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stats-only', action='store_true')
    a = ap.parse_args()
    A, kd = LI._trench_segs()
    idx = json.load(open(os.path.join(PUB, 'h9', 'index.json')))
    rows = {(r[0], r[1]): r for r in idx['l8'] + idx.get('l8n', [])}
    reach = LI.TRENCH_KEEP + LI.TRENCH_RAMP
    # L8 tiles within reach of a trench segment
    lo_x = np.minimum(A[:, 0], A[:, 2]) - reach; hi_x = np.maximum(A[:, 0], A[:, 2]) + reach
    lo_z = np.minimum(A[:, 1], A[:, 3]) - reach; hi_z = np.maximum(A[:, 1], A[:, 3]) + reach
    cand = set()
    for k in range(len(A)):
        for ty in range(int(np.floor((lo_z[k] + 49152.0) / 400.0)), int(np.floor((hi_z[k] + 49152.0) / 400.0)) + 1):
            for tx in range(int(np.floor((lo_x[k] + 45056.0) / 400.0)), int(np.floor((hi_x[k] + 45056.0) / 400.0)) + 1):
                if (tx, ty) in rows:
                    cand.add((tx, ty))
    if not a.stats_only and os.path.isdir(os.path.join(STAGE, 'tiles')):
        shutil.rmtree(os.path.join(STAGE, 'tiles'))
    manifest = []; n8 = n9 = 0; over_terrain = 0
    touched = np.zeros(len(A), bool); side = {}                  # segment -> set of sides (+1 right, -1 left) changed
    big = np.zeros(len(A), bool); dmax = 0.0; worst = None; changes = []; outside = []; big_out = np.zeros(len(A), bool)
    for (tx8, ty8) in sorted(cand):
        row = rows[(tx8, ty8)]; o = int(row[3]); mask = row[2]
        tx7, ty7 = tx8 >> 1, ty8 >> 1
        H7 = l7(tx7, ty7)
        if H7 is None:
            continue
        ox, oy = (tx8 - tx7 * 2) * 64, (ty8 - ty7 * 2) * 64
        base = LI._bilin_up4(H7[oy:oy + 65, ox:ox + 65].astype(np.float32))
        x0, z0, _, _ = bounds(8, tx8, ty8)
        g = np.arange(LI.NV) * (400.0 / 256.0)
        X, Z = np.meshgrid(x0 + g, z0 + g)
        w = LI.trench_weight(X, Z)
        if w.min() >= 1.0:
            continue
        d, kk = LI.trench_dist(X, Z)
        parts = []
        r8 = f'tiles/h9/8/{tx8}_{ty8}.bin'
        b8, org8 = effective(r8)
        if b8 is not None:
            parts.append((r8, b8, org8, np.s_[::2, ::2]))
        for cy in (0, 1):
            for cx in (0, 1):
                if not (mask >> (cy * 2 + cx)) & 1:
                    continue
                r9 = f'tiles/h9/9/{tx8 * 2 + cx}_{ty8 * 2 + cy}.bin'
                b9, org9 = effective(r9)
                if b9 is not None:
                    parts.append((r9, b9, org9, np.s_[cy * 128:cy * 128 + HN, cx * 128:cx * 128 + HN]))
        for rel, blob, org, sl in parts:
            H = H_.decode_fast(blob, LI.QS, -o)
            new = base[sl] + w[sl] * (H - base[sl])
            ch = np.abs(new - H)
            if ch.max() < 1 / 128:                         # (below the 1/64 m quantisation step)
                continue
            if new.min() - o < 0.0 or new.max() - o > 511.0:
                raise ValueError(f'{rel}: new heights {new.min():.1f}..{new.max():.1f} do not fit offset {o}')
            m = ch >= 0.01
            if '/h9/9/' in rel:                               # (count on the finest samples only)
                ks = kk[sl][m]
                touched[ks[ks >= 0]] = True
                big[kk[sl][ch >= 0.3][kk[sl][ch >= 0.3] >= 0]] = True
                Xs, Zs = X[sl][m], Z[sl][m]
                for k, px, pz in zip(ks, Xs, Zs):
                    if k < 0:
                        continue
                    ax, az, bx, bz = A[k]
                    sd = np.sign(-(px - ax) * (bz - az) + (pz - az) * (bx - ax))        # (+1: right of the track's +s)
                    side.setdefault(int(k), set()).add(int(sd))
                changes.append(ch[m])
                mo = m & (d[sl] > 3.9)                               # beyond the carve's reach (behind the walls)
                outside.append(ch[mo]); ko = kk[sl][mo & (ch >= 0.3)]; big_out[ko[ko >= 0]] = True
                j = np.unravel_index(np.argmax(ch), ch.shape)
                if ch[j] > dmax:
                    dmax = float(ch[j]); la, lo = w2ll(X[sl][j], Z[sl][j]); worst = (round(dmax, 2), round(float(la), 5), round(float(lo), 5))
            if a.stats_only:
                continue
            enc = H_.encode(new, LI.QS, -o)
            if sha(enc) == sha(blob):
                continue
            p = os.path.join(STAGE, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p + '.tmp', 'wb') as f:
                f.write(enc)
            os.replace(p + '.tmp', p)
            manifest.append(dict(path=rel, old_sha256=sha(blob), new_sha256=sha(enc), bytes=len(enc), after=org if org != 'pub' else None))
            over_terrain += org != 'pub'
            if '/h9/8/' in rel:
                n8 += 1
            else:
                n9 += 1
    C = np.concatenate(changes) if changes else np.zeros(0)
    O = np.concatenate(outside) if outside else np.zeros(0)
    wall_rows = sum(len(v) for v in side.values())
    stats = dict(trench_segments=int(len(A)), segments_touched=int(touched.sum()), segments_over_30cm=int(big.sum()),
                 wall_rows_touched=int(wall_rows), samples_changed=int(C.size),
                 change_p50=round(float(np.median(C)), 3) if C.size else 0, change_p95=round(float(np.percentile(C, 95)), 3) if C.size else 0,
                 change_max=worst, behind_walls=dict(samples=int(O.size), p50=round(float(np.median(O)), 3) if O.size else 0,
                                                     p95=round(float(np.percentile(O, 95)), 3) if O.size else 0,
                                                     max=round(float(O.max()), 2) if O.size else 0, segments_over_30cm=int(big_out.sum())),
                 h9=dict(L8=n8, L9=n9, over_fix_terrain=over_terrain))
    print(json.dumps(stats), flush=True)
    if a.stats_only:
        return
    os.makedirs(STAGE, exist_ok=True)
    json.dump(dict(what='no lidar relief within 10 m of a BART trench centreline (M3.8, lidar.trench_weight); publish after fix_terrain',
                   staged_root=STAGE, requires=['fix_terrain'], stats=stats, files=manifest),
              open(os.path.join(STAGE, 'manifest.json'), 'w'), indent=1)
    print('staged', len(manifest), 'files', flush=True)


if __name__ == '__main__':
    main()
