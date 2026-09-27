#!/usr/bin/env python3
"""Where the world's base terrain (AWS terrarium z15, from older USGS DEMs) disagrees with the USGS 3DEP 1 m bare-earth
lidar along the freeways and major roads beside the metro (WORLD's rebake list; the metro profile itself follows the
lidar). Roads: OSM motorway / trunk / primary / secondary (+ links) at grade (no bridge / tunnel / covered) within
R m of any metro track, sampled every STEP m along their centrelines.

    python3 tools/metro/terrain_check.py [--r 150] [--step 20] [--thr 3] [--json out.json]

Stretches: consecutive samples along a way that differ by more than THR m (one quiet sample may bridge two bad ones),
at least MIN_N samples; then stretches of the same road (ref or name) within 250 m of each other are merged (both
carriageways of a freeway, split OSM ways). diff = terrarium - lidar (> 0: the world's base is too HIGH there).
Map data (c) OpenStreetMap contributors, ODbL 1.0; lidar: USGS 3DEP (public domain).
"""
import argparse, collections, json, math, os, sys, time, zlib
import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from metro.common import RAW, ROOT, ll2w, w2ll, log          # noqa: E402
from metro.dem import ground as lidar_ground                    # noqa: E402
from metro import elev                                          # noqa: E402

LIB = os.path.join(RAW, 'pylib')
if os.path.isdir(LIB) and LIB not in sys.path:
    sys.path.insert(0, LIB)

CLASSES = ('motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link')
MIN_N = 3
MERGE_R = 250.0


def load_tracks(pub=os.path.join(ROOT, 'data/pub/v2/metro')):
    n = json.load(open(os.path.join(pub, 'network.json')))
    raw = zlib.decompress(open(os.path.join(os.path.dirname(pub.rstrip('/')), n['tracksBin']['path']), 'rb').read())
    tr = []
    for h in n['tracks']:
        P = np.frombuffer(raw, np.float32, h['n'] * 3, h['off']).reshape(-1, 3).astype(float)
        tr.append((h['id'], h['step'], P))
    return tr


def extract_roads(tracks, r, cache):
    if os.path.exists(cache):
        j = json.load(open(cache))
        if j.get('r', 0) >= r:
            return j['elements']
    import osmium
    PBF = next(p for p in (os.path.join(ROOT, 'data/raw/osm_pbf/norcal-latest.osm.pbf'), os.path.join(ROOT, 'data/raw/osm/norcal-latest.osm.pbf'))
               if os.path.exists(p))
    kd = cKDTree(np.concatenate([P[::2][:, [0, 2]] for _, _, P in tracks]))
    lat0, lat1, lon0, lon1 = 37.30, 38.08, -122.56, -121.70
    out = []
    t0 = time.time()
    fp = osmium.FileProcessor(PBF).with_locations().with_filter(osmium.filter.KeyFilter('highway'))
    for o in fp:
        if not o.is_way() or o.tags.get('highway') not in CLASSES:
            continue
        try:
            ll = [(nd.location.lat, nd.location.lon) for nd in o.nodes]
        except osmium.InvalidLocationError:
            continue
        if len(ll) < 2:
            continue
        la = np.array([p[0] for p in ll]); lo = np.array([p[1] for p in ll])
        if la.max() < lat0 or la.min() > lat1 or lo.max() < lon0 or lo.min() > lon1:
            continue
        x, z = ll2w(la, lo)
        L = np.hypot(np.diff(x), np.diff(z))
        k = np.maximum(1, (L / 30.0).astype(int))
        px = np.concatenate([x[i] + (x[i + 1] - x[i]) * np.arange(k[i]) / k[i] for i in range(len(L))] + [x[-1:]])
        pz = np.concatenate([z[i] + (z[i + 1] - z[i]) * np.arange(k[i]) / k[i] for i in range(len(L))] + [z[-1:]])
        d, _ = kd.query(np.stack([px, pz], 1), distance_upper_bound=r)
        if not np.isfinite(d).any():
            continue
        t = o.tags
        out.append(dict(id=o.id, tags={q: t.get(q) for q in ('highway', 'name', 'ref', 'bridge', 'tunnel', 'layer', 'covered') if t.get(q) is not None},
                        geometry=[[round(a, 7), round(b, 7)] for a, b in ll]))
    json.dump(dict(r=r, generated=time.strftime('%Y-%m-%dT%H:%M:%S'), source=os.path.basename(PBF), elements=out), open(cache, 'w'))
    log(f'{len(out)} major-road ways within {r:.0f} m of the metro tracks ({time.time() - t0:.0f} s) -> {cache}')
    return out


def label(tags):
    ref, name = tags.get('ref'), tags.get('name')
    if ref and name:
        return f'{name} ({ref})'
    return name or ref or tags.get('highway', 'road')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--r', type=float, default=150.0)
    ap.add_argument('--step', type=float, default=20.0)
    ap.add_argument('--thr', type=float, default=3.0)
    ap.add_argument('--json', default=None)
    a = ap.parse_args()
    tracks = load_tracks()
    tid = np.concatenate([np.full(len(P), k) for k, (_, _, P) in enumerate(tracks)])
    ts = np.concatenate([np.arange(len(P)) * st for _, st, P in tracks])
    kdt = cKDTree(np.concatenate([P[:, [0, 2]] for _, _, P in tracks]))
    ways = extract_roads(tracks, a.r, os.path.join(RAW, 'osm', 'majorroads_near_metro.json'))
    samples = []           # per way: arrays
    allx, allz = [], []
    for w in ways:
        t = w['tags']
        if t.get('bridge') not in (None, 'no') or t.get('tunnel') not in (None, 'no') or t.get('covered') == 'yes':
            continue
        g = np.array(w['geometry']); x, z = ll2w(g[:, 0], g[:, 1]); x = np.asarray(x, float); z = np.asarray(z, float)
        L = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(z)))])
        if L[-1] < a.step:
            continue
        s = np.arange(0, L[-1] + 1e-6, a.step)
        sx, sz = np.interp(s, L, x), np.interp(s, L, z)
        d, j = kdt.query(np.stack([sx, sz], 1), distance_upper_bound=a.r)
        m = np.isfinite(d)
        if not m.any():
            continue
        samples.append(dict(w=w, s=s, x=sx, z=sz, near=m, d=np.where(m, d, np.inf), j=np.where(m, j, 0)))
        allx.append(sx); allz.append(sz)
    X = np.concatenate(allx); Z = np.concatenate(allz)
    elev.ensure_along(X[::5], Z[::5], 200)
    t0 = time.time()
    G, SRC = lidar_ground(X, Z)
    T = np.asarray(elev.ground(X, Z), float).ravel()
    log(f'{len(samples)} ways, {len(X)} samples every {a.step:.0f} m (lidar + terrarium in {time.time() - t0:.0f} s)')
    o = 0
    raw_st = []
    n_near = n_bad = 0
    for smp in samples:
        n = len(smp['s'])
        g, src, t = G[o:o + n], SRC[o:o + n], T[o:o + n]; o += n
        diff = t - g
        ok = smp['near'] & (src == 1) & np.isfinite(g) & np.isfinite(t)
        bad = ok & (np.abs(diff) > a.thr)
        n_near += int(ok.sum()); n_bad += int(bad.sum())
        # runs of bad samples; one quiet sample between two bad ones does not break a run
        k = 0
        while k < n:
            if not bad[k]:
                k += 1; continue
            j = k
            while j + 1 < n and (bad[j + 1] or (j + 2 < n and bad[j + 2] and ok[j + 1])):
                j += 1
            idx = np.arange(k, j + 1)
            idx = idx[ok[idx]]
            if bad[idx].sum() >= MIN_N:
                la, lo = w2ll(smp['x'][idx], smp['z'][idx])
                raw_st.append(dict(label=label(smp['w']['tags']), cls=smp['w']['tags'].get('highway'), way=smp['w']['id'],
                                   x=smp['x'][idx], z=smp['z'][idx], lat=np.asarray(la), lon=np.asarray(lo), diff=diff[idx],
                                   tr=[tracks[tid[q]][0] for q in smp['j'][idx]], ts=ts[smp['j'][idx]], d=smp['d'][idx]))
            k = j + 1
    # merge stretches of the same road that are near each other (carriageways, split ways)
    groups = []
    for r_ in sorted(raw_st, key=lambda r: r['label']):
        P = np.stack([r_['x'], r_['z']], 1)
        for gq in groups:
            if gq['label'] != r_['label']:
                continue
            if cKDTree(gq['P']).query(P, distance_upper_bound=MERGE_R)[0].min() < MERGE_R:
                gq['P'] = np.concatenate([gq['P'], P]); gq['parts'].append(r_)
                break
        else:
            groups.append(dict(label=r_['label'], P=P, parts=[r_]))
    out = []
    for gq in groups:
        diff = np.concatenate([p['diff'] for p in gq['parts']])
        lat = np.concatenate([p['lat'] for p in gq['parts']]); lon = np.concatenate([p['lon'] for p in gq['parts']])
        trs = collections.Counter(t for p in gq['parts'] for t in p['tr'])
        main_tr = trs.most_common(1)[0][0]
        sv = np.concatenate([np.asarray(p['ts'])[[t == main_tr for t in p['tr']]] for p in gq['parts']])
        k = int(np.argmax(np.abs(diff)))
        pos, neg = int((diff > a.thr).sum()), int((diff < -a.thr).sum())
        sign = 'terrarium HIGH' if neg == 0 else 'terrarium LOW' if pos == 0 else f'mixed ({pos} high / {neg} low)'
        out.append(dict(road=gq['label'], cls=sorted({p['cls'] for p in gq['parts']}), n=len(diff),
                        length_m=round(len(diff) * a.step), lat=[round(float(lat.min()), 5), round(float(lat.max()), 5)],
                        lon=[round(float(lon.min()), 5), round(float(lon.max()), 5)],
                        max=round(float(diff[k]), 1), mean=round(float(diff.mean()), 1), mean_abs=round(float(np.abs(diff).mean()), 1),
                        sign=sign, track=main_tr, track_s=[int(sv.min()), int(sv.max())] if len(sv) else None,
                        ways=sorted({p['way'] for p in gq['parts']})))
    out.sort(key=lambda r: -abs(r['max']) * math.sqrt(r['n']))
    log(f'{n_near} road samples with lidar within {a.r:.0f} m of the tracks, {n_bad} differ by > {a.thr:.0f} m; '
        f'{len(out)} stretches (>= {MIN_N} samples, same road merged within {MERGE_R:.0f} m)')
    if a.json:
        json.dump(dict(generated=time.strftime('%Y-%m-%dT%H:%M:%S'), r=a.r, step=a.step, thr=a.thr, samples=n_near, bad=n_bad,
                       note='diff = terrarium z15 - USGS 3DEP 1 m lidar (m); > 0: terrarium (the world base) too high',
                       stretches=out), open(a.json, 'w'), indent=1)
    for r_ in out:
        print(f"{r_['road'][:48]:48s} {r_['length_m']:5d} m  max {r_['max']:+6.1f}  mean {r_['mean']:+5.1f}  {r_['sign']:24s} "
              f"{r_['lat'][0]:.4f}-{r_['lat'][1]:.4f} N {r_['lon'][0]:.4f}-{r_['lon'][1]:.4f}  {r_['track']} {r_['track_s']}")


if __name__ == '__main__':
    main()
