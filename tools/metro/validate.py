#!/usr/bin/env python3
"""Validation renders for the metro data: tracks, rails and platforms drawn over aerial imagery (the game's own tiles
where fine enough, else a USGS NAIP chip), profile plots per line, and unit-sanity checks.

    python3 tools/metro/validate.py overlay [name ...]     # notes/bart/shots/data/ov_<name>.jpg
    python3 tools/metro/validate.py profiles               # notes/bart/shots/data/profile_<pattern>.png
    python3 tools/metro/validate.py checks                 # gauge/grade/continuity/junction sanity report
    python3 tools/metro/validate.py timetable              # trips vs pattern paths: order, dwell, implied hop speeds
    python3 tools/metro/validate.py runtimes               # minimum run time per hop from the speed limits vs the schedule
"""
import collections, io, json, math, os, struct, sys, zlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from metro.common import PUB, ROOT, ll2w, w2ll, log
from tiles import fetch as TF

SHOTS = os.path.join(ROOT, 'notes', 'bart', 'shots', 'data')
TILES = os.path.join(ROOT, 'data', 'pub', 'v2', 'tiles', 'img')
X0, Z0, SIZE = -45056.0, -49152.0, 102400.0

# name: (lat, lon, size m, note)
SPOTS = {
    'wye': (37.8003, -122.2790, 700, 'M-line portal (5th & Clay) toward the Oakland Wye'),
    'woak': (37.80488, -122.29515, 320, 'West Oakland station'),
    'mcar': (37.8288, -122.2671, 420, 'MacArthur: 4 tracks, two islands, C/R split'),
    'mcar_n': (37.8350, -122.2665, 600, 'north of MacArthur: SR-24 / R-line split and flyover'),
    'rock': (37.8447, -122.2512, 420, 'Rockridge in the SR-24 median'),
    'orin': (37.8785, -122.1837, 420, 'Orinda in the SR-24 median'),
    'ftvl': (37.7748, -122.2241, 360, 'Fruitvale aerial'),
    'cols': (37.7536, -122.1967, 420, 'Coliseum + airport connector'),
    'bayf': (37.6969, -122.1264, 600, 'Bay Fair junction (L line to Dublin)'),
    'daly': (37.7063, -122.4689, 480, 'Daly City turnback'),
    'colm': (37.6846, -122.4662, 500, 'Colma and the Daly City yard'),
    'sfia': (37.6161, -122.3920, 520, 'SFO station and wye'),
    'mlbr': (37.6002, -122.3868, 420, 'Millbrae shared with the Peninsula line'),
    'pitt': (38.0189, -121.9420, 600, 'Pittsburg/Bay Point + SR-4 median'),
    'pitt_t': (38.0190, -121.9340, 420, 'eBART transfer platform'),
    'bery': (37.3685, -121.8747, 420, 'Berryessa'),
    'dubl': (37.7016, -121.8992, 420, 'Dublin/Pleasanton in the I-580 median'),
    'glen': (37.7332, -122.4335, 360, 'Glen Park'),
    'balb': (37.7217, -122.4475, 420, 'Balboa Park'),
    'rich': (37.9368, -122.3530, 420, 'Richmond terminal'),
    'frmt': (37.5575, -121.9766, 420, 'Fremont'),
    'curve_ssf': (37.6560, -122.4330, 600, 'curve south of South San Francisco'),
    'ashb': (37.8531, -122.2698, 420, 'Ashby: island tracks spread to 11.1 m under Adeline St (M2b)'),
    'wdub': (37.6997, -121.9290, 420, 'West Dublin/Pleasanton: median, the OSM "tunnel" is a road bridge (M2b)'),
    'mlpt': (37.4103, -121.8912, 420, 'Milpitas: roofed U-trench, lidar floor through the openings (M2b)'),
    'antc': (37.9954, -121.7804, 300, 'Antioch: eBART island (M2b)'),
}


def load_net():
    net = json.load(open(os.path.join(PUB, 'network.json')))
    raw = zlib.decompress(open(os.path.join(PUB, os.path.basename(net.get('tracksBin', {}).get('path', 'tracks.bin'))), 'rb').read())
    for t in net['tracks']:
        n = t['n']
        P = np.frombuffer(raw, '<f4', n * 3, t['off']).reshape(n, 3).astype(np.float64)
        A = np.frombuffer(raw, np.uint8, n * 4, t['off'] + n * 12).reshape(4, n)
        t['P'] = P
        t['ST'] = A[0]; t['VL'] = A[1]; t['CA'] = (A[2].astype(np.float64) - 128) * 0.002; t['CV'] = A[3]
    return net


def tile_img(L, tx, ty):
    p = os.path.join(TILES, str(L), f'{tx}_{ty}.jpg')
    if not os.path.exists(p):
        return None
    return Image.open(p).convert('RGB')


def imagery(x0, z0, x1, z1, px=1024):
    """RGB image covering [x0,x1]x[z0,z1] at px wide. Game tiles L9/L8 if available, else a USGS NAIP chip."""
    mpp_need = (x1 - x0) / px
    for L in (9, 8):
        T = SIZE / (1 << L)
        tx0, tx1 = int((x0 - X0) // T), int((x1 - X0) // T)
        tz0, tz1 = int((z0 - Z0) // T), int((z1 - Z0) // T)
        tiles = {}
        ok = True
        for ty in range(tz0, tz1 + 1):
            for tx in range(tx0, tx1 + 1):
                im = tile_img(L, tx, ty)
                if im is None:
                    ok = False
                    break
                tiles[(tx, ty)] = im
            if not ok:
                break
        if not ok:
            continue
        tp = next(iter(tiles.values())).size[0]
        mos = Image.new('RGB', ((tx1 - tx0 + 1) * tp, (tz1 - tz0 + 1) * tp))
        for (tx, ty), im in tiles.items():
            mos.paste(im, ((tx - tx0) * tp, (ty - tz0) * tp))
        mx0, mz0 = X0 + tx0 * T, Z0 + tz0 * T
        mpp = T / tp
        box = ((x0 - mx0) / mpp, (z0 - mz0) / mpp, (x1 - mx0) / mpp, (z1 - mz0) / mpp)
        return mos.crop(tuple(int(round(v)) for v in box)).resize((px, int(round(px * (z1 - z0) / (x1 - x0)))), Image.LANCZOS), f'tiles L{L} ({mpp:.2f} m/px)'
    lat_n, lon_w = w2ll(x0, z0)
    lat_s, lon_e = w2ll(x1, z1)
    raw = TF.naip((float(lon_w), float(lat_s), float(lon_e), float(lat_n)), px)
    return Image.open(io.BytesIO(raw)).convert('RGB').resize((px, int(round(px * (z1 - z0) / (x1 - x0)))), Image.LANCZOS), f'USGS NAIP chip ({(x1 - x0) / px:.2f} m/px)'


CLS_COL = {'main': (255, 214, 64), 'crossover': (255, 120, 40), 'yard': (120, 220, 255), 'siding': (255, 160, 60), 'spur': (200, 140, 255)}


def overlay(net, name, spot):
    lat, lon, size, note = spot
    cx, cz = ll2w(lat, lon)
    cx, cz = float(cx), float(cz)
    x0, z0, x1, z1 = cx - size / 2, cz - size / 2, cx + size / 2, cz + size / 2
    img, src = imagery(x0, z0, x1, z1, 1024)
    W, H = img.size
    sc = W / (x1 - x0)
    d = ImageDraw.Draw(img, 'RGBA')
    P = lambda x, z: ((x - x0) * sc, (z - z0) * sc)
    # tracks: rails (±0.8745 m) thin, centreline dashed
    for t in net['tracks']:
        Pt = t['P']
        m = (Pt[:, 0] > x0 - 50) & (Pt[:, 0] < x1 + 50) & (Pt[:, 2] > z0 - 50) & (Pt[:, 2] < z1 + 50)
        if not m.any():
            continue
        idx = np.where(m)[0]
        a, b = max(0, idx[0] - 1), min(len(Pt), idx[-1] + 2)
        seg = Pt[a:b]
        dx = np.gradient(seg[:, 0]); dz = np.gradient(seg[:, 2]); L = np.hypot(dx, dz) + 1e-9
        rx, rz = -dz / L, dx / L
        col = CLS_COL.get(t['cls'], (255, 255, 255))
        half = (1.676 + 0.0727) / 2 if t['gauge'] > 1.5 else (1.435 + 0.07) / 2
        for sgn in (-1, 1):
            pts = [P(x + sgn * half * rxx, z + sgn * half * rzz) for (x, _, z), rxx, rzz in zip(seg, rx, rz)]
            d.line(pts, fill=col + (230,), width=max(1, int(round(0.12 * sc))) if sc > 2 else 1)
        # structure ticks every 20 m on the left: colour by structure
        if sc > 1.2:
            for k in range(0, len(seg), max(1, int(20 / t['step']))):
                c = STRUCT_COL[net['structCodes'][t['ST'][a + k]]]
                x, _, z = seg[k]
                p0 = P(x - 3.2 * rx[k], z - 3.2 * rz[k]); p1 = P(x - 4.6 * rx[k], z - 4.6 * rz[k])
                d.line([p0, p1], fill=c + (255,), width=3)
        mid = seg[len(seg) // 2]
        if t['cls'] == 'main' or size < 500:
            px_, pz_ = P(mid[0], mid[2])
            if 0 < px_ < W and 0 < pz_ < H:
                d.text((px_ + 6, pz_ - 12), t['id'], fill=(255, 255, 255, 255), stroke_width=2, stroke_fill=(0, 0, 0, 255))
    # platforms: edge line along the platform side at 1.75 m + a translucent band 5 m deep
    byid = {t['id']: t for t in net['tracks']}
    for st in net['stations']:
        for p in st['platforms']:
            t = byid.get(p['track'])
            if t is None:
                continue
            s = np.arange(p['s0'], p['s1'], 4.0)
            i = np.clip((s / t['step']).astype(int), 0, t['n'] - 2)
            Pt = t['P']
            dx = Pt[i + 1, 0] - Pt[i, 0]; dz = Pt[i + 1, 2] - Pt[i, 2]; L = np.hypot(dx, dz) + 1e-9
            rx, rz = -dz / L, dx / L
            sg = 1 if p['side'] == 'right' else -1
            e = [P(Pt[k, 0] + sg * 1.72 * a_, Pt[k, 2] + sg * 1.72 * b_) for k, a_, b_ in zip(i, rx, rz)]
            f = [P(Pt[k, 0] + sg * 6.0 * a_, Pt[k, 2] + sg * 6.0 * b_) for k, a_, b_ in zip(i, rx, rz)]
            if len(e) > 1:
                d.polygon(e + f[::-1], fill=(255, 255, 255, 50))
                d.line(e, fill=(255, 255, 255, 255), width=2)
        sx, sz = P(st['x'], st['z'])
        if 0 < sx < W and 0 < sz < H:
            d.ellipse((sx - 5, sz - 5, sx + 5, sz + 5), outline=(255, 64, 64, 255), width=2)
            d.text((sx + 8, sz + 4), st['id'], fill=(255, 90, 90, 255), stroke_width=2, stroke_fill=(0, 0, 0, 255))
        for e in st.get('entrances', []):
            ex, ez = P(e['x'], e['z'])
            if 0 < ex < W and 0 < ez < H:
                d.rectangle((ex - 3, ez - 3, ex + 3, ez + 3), fill=(90, 255, 140, 220) if e['src'] == 'gtfs' else (90, 190, 255, 220))
    for j in net['junctions']:
        jx, jz = P(j['x'], j['z'])
        if 0 < jx < W and 0 < jz < H:
            d.ellipse((jx - 2.5, jz - 2.5, jx + 2.5, jz + 2.5), fill=(255, 0, 255, 200))
    # scale bar + caption
    bar = 50 if size <= 600 else 100
    d.rectangle((16, H - 36, 16 + bar * sc, H - 30), fill=(255, 255, 255, 230))
    d.text((16, H - 26), f'{bar} m', fill=(255, 255, 255, 255), stroke_width=2, stroke_fill=(0, 0, 0, 255))
    d.text((12, 10), f'{name}: {note}  ({lat:.5f}, {lon:.5f}; {src})', fill=(255, 255, 255, 255), stroke_width=2, stroke_fill=(0, 0, 0, 255))
    os.makedirs(SHOTS, exist_ok=True)
    out = os.path.join(SHOTS, f'ov_{name}.jpg')
    if img.size[0] > 900:
        img = img.resize((900, int(img.size[1] * 900 / img.size[0])), Image.LANCZOS)
    img.save(out, quality=72, optimize=True)
    return out


STRUCT_COL = {'grade': (140, 200, 100), 'aerial': (80, 180, 255), 'bridge': (160, 140, 255), 'embankment': (200, 220, 140), 'trench': (255, 160, 70),
              'median': (250, 215, 110), 'portal': (255, 90, 140), 'cutcover': (225, 85, 85), 'bored': (185, 60, 60), 'tube': (255, 50, 210)}


def profiles(net):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    byid = {t['id']: t for t in net['tracks']}
    os.makedirs(SHOTS, exist_ok=True)
    main = {}
    for p in net['patterns']:
        k = (p['line'], p['dir'])
        if k not in main or p['trips'] > main[k]['trips']:
            main[k] = p
    outs = []
    for (line, dirn), p in sorted(main.items()):
        if dirn != 1 and line not in ('grey',):
            continue
        for li, L in enumerate(p['legs']):
            ds, ys, gs, cs = [], [], [], []
            d0 = 0.0
            for tid, s0, s1 in L['path']:
                t = byid[tid]
                n = max(2, int(abs(s1 - s0) / 5) + 1)
                ss = np.linspace(s0, s1, n)
                i = np.clip(np.round(ss / t['step']).astype(int), 0, t['n'] - 1)
                y = t['P'][i, 1]
                c = t['ST'][i]
                cov = t['CV'][i].astype(float)
                und = np.isin(c, [6, 7, 8, 9])
                aer = np.isin(c, [1, 2])
                g = np.where(und, y + cov, np.where(aer, y - cov, y - 0.5))
                ds.append(d0 + np.abs(ss - s0)); ys.append(y); gs.append(g); cs.append(c)
                d0 += abs(s1 - s0)
            ds = np.concatenate(ds) / 1000; ys = np.concatenate(ys); gs = np.concatenate(gs); cs = np.concatenate(cs)
            fig, ax = plt.subplots(figsize=(16, 4.2), dpi=110)
            ax.fill_between(ds, gs, min(gs.min(), ys.min()) - 10, color='#d8cfbf', lw=0)
            ax.plot(ds, gs, color='#8a7a5a', lw=0.8)
            for k in range(len(net['structCodes'])):
                m = cs == k
                if m.any():
                    yy = np.where(m, ys, np.nan)
                    ax.plot(ds, yy, color=np.array(STRUCT_COL[net['structCodes'][k]]) / 255, lw=2.2, label=net['structCodes'][k])
            ax.axhline(0, color='#3a7bd5', lw=0.6, alpha=0.6)
            for s in L['stops']:
                if s['d'] >= 0:
                    ax.axvline(s['d'] / 1000, color='#444', lw=0.5, alpha=0.5)
                    ax.text(s['d'] / 1000, ax.get_ylim()[1], s['station'], rotation=90, va='top', ha='right', fontsize=7)
            # grade over 25 m on a uniform 5 m grid (path joins repeat samples a metre apart)
            order_ = np.argsort(ds, kind='stable'); dm_ = ds[order_] * 1000.0; ym_ = ys[order_]
            ug_ = np.arange(dm_[0], dm_[-1], 5.0)
            uy_ = np.interp(ug_, dm_, ym_)
            gr = np.abs(uy_[5:] - uy_[:-5]) / 25.0 if len(uy_) > 5 else np.array([0.0])
            ax.set_title(f"{p['id']} leg {li} ({L['sys']}): {L['length']/1000:.1f} km, top of rail {ys.min():.0f}…{ys.max():.0f} m (grades and curves: see validation.json)", fontsize=10)
            ax.set_xlabel('km along the path'); ax.set_ylabel('m above sea level')
            ax.legend(ncol=10, fontsize=7, loc='lower left')
            ax.grid(alpha=0.25)
            fig.tight_layout()
            out = os.path.join(SHOTS, f"profile_{p['id']}_{li}.png")
            fig.savefig(out); plt.close(fig)
            outs.append(out)
    return outs


def checks(net):
    rep = []
    byid = {t['id']: t for t in net['tracks']}
    # grades and vertical continuity
    for t in net['tracks']:
        P = t['P']
        if t['n'] < 3:
            continue
        g = np.diff(P[:, 1]) / t['step']
        gm = np.abs(g).max()
        if gm > 0.045 and t['cls'] == 'main':
            k = int(np.abs(g).argmax())
            la, lo = w2ll(P[k, 0], P[k, 2])
            rep.append(f'grade {gm*100:.1f} % on {t["id"]} at s={k*t["step"]:.0f} ({float(la):.5f},{float(lo):.5f})')
        dd = np.hypot(np.diff(P[:, 0]), np.diff(P[:, 2]))
        if abs(dd.mean() - t['step']) > 0.05 or dd.max() > t['step'] * 1.05:
            rep.append(f'spacing irregular on {t["id"]}: mean {dd.mean():.3f} max {dd.max():.3f} step {t["step"]:.3f}')
    # junction continuity: all member track points within 0.5 m (plan) and 0.3 m (height)
    bad = 0
    for j in net['junctions']:
        pts = []
        for tid, s in j['tracks']:
            t = byid[tid]
            i = min(t['n'] - 1, int(round(s / t['step'])))
            pts.append(t['P'][i])
        pts = np.array(pts)
        dxz = np.hypot(pts[:, 0] - pts[:, 0].mean(), pts[:, 2] - pts[:, 2].mean()).max()
        dy = pts[:, 1].max() - pts[:, 1].min()
        if dxz > 3.0 or dy > 0.35:
            bad += 1
            if bad <= 25:
                rep.append(f'junction {j["id"]} ({j["kind"]}) spread plan {dxz:.2f} m, height {dy:.2f} m: {[m[0] for m in j["tracks"]]}')
    rep.append(f'junctions with spread > 3 m or > 0.35 m height: {bad}/{len(net["junctions"])}')
    # parallel mains: centre spacing where two mains run side by side (check for overlaps)
    return rep


def check_timetable(net):
    tt = json.load(open(os.path.join(PUB, 'timetable.json')))
    P = {p['id']: p for p in net['patterns']}
    rep = collections_counter = {}
    bad_align = bad_order = 0
    fast, slow = [], []
    for t in tt['trips']:
        p = P[t['pat']]
        for L, lt in zip(p['legs'], t['legs']):
            if len(lt) != 2 * len(L['stops']):
                bad_align += 1
                continue
            if any(lt[i + 1] < lt[i] for i in range(len(lt) - 1)):
                bad_order += 1
            for k in range(len(L['stops']) - 1):
                dd = L['stops'][k + 1]['d'] - L['stops'][k]['d']
                dt = lt[2 * k + 2] - lt[2 * k + 1]
                if dd <= 0 or dt <= 0:
                    continue
                v = dd / dt / 0.44704
                hop = (L['stops'][k]['station'], L['stops'][k + 1]['station'])
                if v > 62:
                    fast.append((round(v, 1), hop, t['id']))
                if v < 8 and L['sys'] != 'oac':
                    slow.append((round(v, 1), hop, t['id']))
    print(f'trips {len(tt["trips"])}, legs misaligned {bad_align}, legs with times going backwards {bad_order}')
    fh = sorted(set((round(v), h) for v, h, _ in fast), reverse=True)[:12]
    sh = sorted(set((round(v), h) for v, h, _ in slow))[:12]
    print(f'hops with average > 62 mph (path distance / scheduled time; BART max 70): {len(fast)}', fh)
    print(f'hops with average < 8 mph: {len(slow)}', sh)


def leg_limits(net, L, ds=5.0):
    """Speed limit (m/s) sampled every ds along a pattern leg's path."""
    byid = {t['id']: t for t in net['tracks']}
    out = []
    for tid, s0, s1 in L['path']:
        t = byid[tid]
        n = max(1, int(abs(s1 - s0) / ds))
        for k in range(n):
            s = s0 + (s1 - s0) * k / n
            i = min(t['n'] - 1, int(round(s / t['step'])))
            out.append(t['VL'][i] * 0.44704)
    return np.array(out + [out[-1] if out else 0.0])


def min_run(lim, d0, d1, train_len, acc=1.0, dec=1.0, ds=5.0):
    """Time-optimal run between path distances d0 -> d1 (stop to stop) under limits held over the train's length."""
    i0, i1 = int(d0 / ds), int(d1 / ds)
    if i1 <= i0:
        return 0.0
    v = lim[i0:i1 + 1].astype(float)
    back = int(train_len / ds)
    # the whole train must respect a restriction: the front's limit is the min over the next... rear still inside
    from scipy.ndimage import minimum_filter1d
    seg = lim[max(0, i0 - back):i1 + 1]
    w = minimum_filter1d(seg, size=back + 1, origin=(back) // 2, mode='nearest')[-len(v):] if back > 0 else v
    v = np.minimum(v, w)
    v[0] = 0.0; v[-1] = 0.0
    for j in range(1, len(v)):
        v[j] = min(v[j], np.sqrt(v[j - 1] ** 2 + 2 * acc * ds))
    for j in range(len(v) - 2, -1, -1):
        v[j] = min(v[j], np.sqrt(v[j + 1] ** 2 + 2 * dec * ds))
    vm = 0.5 * (v[1:] + v[:-1])
    return float(np.sum(ds / np.maximum(vm, 0.3)))


def check_runtimes(net):
    """Minimum run per station hop (limits held over the train, 1.0 m/s2) vs the median scheduled hop over all weekday
    trips (GTFS times are whole minutes, so single trips can be a minute short), with the restrictions that cost time."""
    tt = json.load(open(os.path.join(PUB, 'timetable.json')))
    P = {p['id']: p for p in net['patterns']}
    byid = {t['id']: t for t in net['tracks']}
    sched_all = collections.defaultdict(list)
    for t in tt['trips']:
        if not t['svc'].endswith('Weekday-015'):
            continue
        p = P[t['pat']]
        for li, (L, lt) in enumerate(zip(p['legs'], t['legs'])):
            for k in range(len(L['stops']) - 1):
                a, b = L['stops'][k], L['stops'][k + 1]
                if lt[2 * k + 2] - lt[2 * k + 1] > 0:
                    sched_all[(a['station'], b['station'])].append(lt[2 * k + 2] - lt[2 * k + 1])
    worst = {}
    lims = {}
    for t in tt['trips']:
        if not t['svc'].endswith('Weekday-015') and 'DX1' not in t['svc'] and 'DX2' not in t['svc']:
            continue
        p = P[t['pat']]
        for li, (L, lt) in enumerate(zip(p['legs'], t['legs'])):
            if L['sys'] == 'oac':
                continue
            if (p['id'], li) not in lims:
                lims[(p['id'], li)] = leg_limits(net, L)
            lim = lims[(p['id'], li)]
            cars = (t['cars'] or [8])[li] if t.get('cars') else 8
            tl = cars * (40.9 if L['vehicle'] == 'dmu' else 21.3)
            for k in range(len(L['stops']) - 1):
                a, b = L['stops'][k], L['stops'][k + 1]
                sched = lt[2 * k + 2] - lt[2 * k + 1]
                if sched <= 0 or b['d'] <= a['d']:
                    continue
                key = (a['station'], b['station'])
                if key in worst:
                    continue
                mr = min_run(lim, a['d'], b['d'], tl)
                med = float(np.median(sched_all[key])) if sched_all.get(key) else sched
                # restrictions below 70 mph on the way and what set them
                rs = []
                dd = 0.0
                for tid, s0, s1 in L['path']:
                    tr_ = byid[tid]
                    n_ = max(1, int(abs(s1 - s0) / 5.0))
                    prev = None
                    for q in range(n_ + 1):
                        dq = dd + abs(s1 - s0) * q / n_
                        if a['d'] < dq < b['d']:
                            i = min(tr_['n'] - 1, int(round((s0 + (s1 - s0) * q / n_) / tr_['step'])))
                            v = int(tr_['VL'][i])
                            if v < 70 and v != prev:
                                rs.append(f'{v} mph on {tid} s={s0 + (s1 - s0) * q / n_:.0f}')
                            prev = v
                    dd += abs(s1 - s0)
                worst[key] = (round(mr), sched, round(b['d'] - a['d']), med, min(sched_all.get(key, [sched])), rs)
    bad = sorted([(v[0] - v[3], k, v) for k, v in worst.items() if v[0] > v[3] + 5], reverse=True)
    print(f'hops checked {len(worst)}; minimum run (1.0 m/s2 accel/brake, limits over the train length) > median scheduled + 5 s: {len(bad)}')
    for d, k, v in bad[:25]:
        print('  ', k, 'min', v[0], 's vs scheduled median', int(v[3]), 's (shortest', v[4], 's) over', v[2], 'm; restrictions:', '; '.join(v[5][:6]) or 'none')


if __name__ == '__main__':
    net = load_net()
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'overlay'
    if cmd == 'overlay':
        names = sys.argv[2:] or list(SPOTS)
        for nme in names:
            log(overlay(net, nme, SPOTS[nme]))
    elif cmd == 'profiles':
        for o in profiles(net):
            log(o)
    elif cmd == 'runtimes':
        check_runtimes(net)
    elif cmd == 'timetable':
        check_timetable(net)
    elif cmd == 'checks':
        for r in checks(net):
            print(r)
