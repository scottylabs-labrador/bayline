"""Plan-geometry corrections where OSM's track centrelines are schematic (tunnels can't be traced from the photo).

Transbay Tube (M-line): the immersed tube runs 5.83 km (19,113 ft) between the SF ventilation structure (~137 m off
the Ferry Building) and the Oakland ventilation structure on 7th St; track centres there are 8.03 m apart (bore
centres 7.62 m + 0.20 m outward offset of each track; NTSB RAR-79-05 Fig. 3, via notes/bart/infra.md). OSM draws the
two tracks 5.07 m apart: both are moved symmetrically about their midline, blended over 120 m at each vent structure.
West of the SF vent the tracks run in twin compressed-air bores to Embarcadero; east of the Oakland vent in a ~1.08 km
twin-cell box (5.49 m centres, which OSM already has) to the portal near 7th St & Maritime St.
"""
import math
import numpy as np
from metro.common import ll2w, log

SF_VENT = (37.79645, -122.39050)      # on the tracks ~137 m off the Ferry Building seawall (Pier 1/2)
OAK_VENT_ALONG = 5830.0               # immersed length (m) along the track from the SF vent
TUBE_SPACING = 8.03
BLEND = 120.0


def _nearest_s(tr, x, z):
    f = tr['fine']
    d = np.hypot(f['x'] - x, f['z'] - z)
    k = int(np.argmin(d))
    return float(f['s'][k]), float(d[k])


def tube_zone(tr):
    """(s_sf_vent, s_oak_vent) on a Transbay track, or None."""
    x, z = ll2w(*SF_VENT)
    s_sf, d = _nearest_s(tr, float(x), float(z))
    if d > 25:
        return None
    f = tr['fine']
    # which way is Oakland along this track? (east = +x)
    i = int(np.searchsorted(f['s'], s_sf))
    j = min(len(f['s']) - 1, i + 20)
    east = (f['x'][j] - f['x'][max(0, i - 20)]) > 0
    s_oak = s_sf + OAK_VENT_ALONG if east else s_sf - OAK_VENT_ALONG
    if not (0 <= s_oak <= f['s'][-1]):
        return None
    return s_sf, s_oak


def fix_tube_spacing(tracks):
    zones = {}
    for tr in tracks:
        if tr['service'] is None and tr['sys'] == 'bart':
            z = tube_zone(tr)
            if z:
                zones[id(tr)] = (tr, z)
    if len(zones) != 2:
        log(f'tube spacing: expected 2 tube tracks, found {len(zones)}; skipped')
        return {}
    (ta, za), (tb, zb) = list(zones.values())
    moved = {}
    for tr, z, other in ((ta, za, tb), (tb, zb, ta)):
        f = tr['fine']
        lo, hi = min(z), max(z)
        s = f['s']
        m = (s > lo - BLEND) & (s < hi + BLEND)
        idx = np.where(m)[0]
        of = other['fine']
        P = np.stack([of['x'], of['z']], 1)
        nx, nz = f['x'].copy(), f['z'].copy()
        from scipy.spatial import cKDTree
        kd = cKDTree(P)
        d, k = kd.query(np.stack([f['x'][idx], f['z'][idx]], 1))
        for q, (dd, kk) in zip(idx, zip(d, k)):
            w = min(1.0, (s[q] - (lo - BLEND)) / BLEND, ((hi + BLEND) - s[q]) / BLEND)
            w = 0.5 - 0.5 * math.cos(math.pi * max(0.0, min(1.0, w)))
            bx, bz = P[kk]
            vx, vz = f['x'][q] - bx, f['z'][q] - bz
            L = math.hypot(vx, vz) or 1.0
            mx, mz = 0.5 * (f['x'][q] + bx), 0.5 * (f['z'][q] + bz)
            tx, tz = mx + vx / L * TUBE_SPACING / 2, mz + vz / L * TUBE_SPACING / 2
            nx[q] = f['x'][q] + w * (tx - f['x'][q]); nz[q] = f['z'][q] + w * (tz - f['z'][q])
        moved[tr['id'] if 'id' in tr else id(tr)] = float(np.hypot(nx - f['x'], nz - f['z']).max())
        tr['_newxz'] = (nx, nz)
        tr['tube'] = (lo, hi, z[0], z[1])
    for tr in (ta, tb):
        nx, nz = tr.pop('_newxz')
        tr['fine']['x'] = nx; tr['fine']['z'] = nz
    log(f'tube spacing: tracks moved up to {max(moved.values()):.2f} m to {TUBE_SPACING} m centres over {OAK_VENT_ALONG / 1000:.2f} km')
    return {'sfVent': za[0], 'oakVent': za[1]}


# ---------------------------------------------------------------------------------------------------------------------
# Island platforms where OSM draws the two tracks too close for any island (Ashby 4.8 m, San Bruno 4.3-5.1 m, North /
# Downtown Berkeley 6.7 / 7.7 m, Glen Park 7.7 m: islands of 1-4.5 m). Mappers trace subway tracks schematically and
# San Bruno's under the station roof. The two tracks are moved apart symmetrically to BART's usual island spacing
# (11.1 m track centres, as measured at Fremont, Bay Fair, Orinda, Castro Valley, West Dublin ...) along the platform
# (+-20 m) with cosine tapers of up to 150 m that stop short of any junction.
ISLAND_MIN = 8.2           # m track centres below which the island would be < 5 m wide (2 x 1.616 m edges)
ISLAND_SPACING = 11.1
TAPER = 150.0
JUNCTION_CLEAR = 25.0


def spread_islands(tracks, pairs, junction_s):
    """pairs: [(station, track A, s_A (fine s at the platform centre), s0_A, s1_A, track B)] for island stations;
    junction_s: {id(track): [fine s of every junction vertex on it]}. Moves tr['fine'] x/z in place."""
    done = []
    for (st, ta, sa, a0, a1, tb) in pairs:
        fa, fb = ta['fine'], tb['fine']
        PB = np.stack([fb['x'], fb['z']], 1)
        i = int(np.clip(np.searchsorted(fa['s'], sa), 1, len(fa['s']) - 2))
        d0 = float(np.hypot(PB[:, 0] - fa['x'][i], PB[:, 1] - fa['z'][i]).min())
        if d0 >= ISLAND_MIN:
            continue
        shift = 0.5 * (ISLAND_SPACING - d0)
        moved = []
        ok = True
        plan = []
        for tr, other in ((ta, tb), (tb, ta)):
            f = tr['fine']; of = other['fine']
            PO = np.stack([of['x'], of['z']], 1)
            # platform zone on this track: nearest points to the ends of A's platform
            if tr is ta:
                p0, p1 = min(a0, a1), max(a0, a1)
            else:
                ends = []
                for sv in (a0, a1):
                    k = int(np.clip(np.searchsorted(fa['s'], sv), 0, len(fa['s']) - 1))
                    ends.append(float(f['s'][int(np.argmin(np.hypot(f['x'] - fa['x'][k], f['z'] - fa['z'][k])))]))
                p0, p1 = min(ends), max(ends)
            p0 -= 20.0; p1 += 20.0
            js = [j for j in junction_s.get(id(tr), [])]
            if any(p0 - 5 <= j <= p1 + 5 for j in js):
                ok = False
                break
            lo_room = min([p0 - j for j in js if j < p0] + [TAPER + JUNCTION_CLEAR]) - JUNCTION_CLEAR
            hi_room = min([j - p1 for j in js if j > p1] + [TAPER + JUNCTION_CLEAR]) - JUNCTION_CLEAR
            t0, t1 = min(TAPER, lo_room), min(TAPER, hi_room)
            if min(t0, t1) < 60.0 or p0 - t0 < 0 or p1 + t1 > f['s'][-1]:
                ok = False
                break
            s = f['s']
            w = np.zeros(len(s))
            w[(s >= p0) & (s <= p1)] = 1.0
            m = (s > p0 - t0) & (s < p0)
            w[m] = 0.5 - 0.5 * np.cos(np.pi * (s[m] - (p0 - t0)) / t0)
            m = (s > p1) & (s < p1 + t1)
            w[m] = 0.5 - 0.5 * np.cos(np.pi * ((p1 + t1) - s[m]) / t1)
            idx = np.where(w > 0)[0]
            gx = np.gradient(f['x']); gz = np.gradient(f['z']); L = np.hypot(gx, gz) + 1e-12
            nx_, nz_ = -gz / L, gx / L                       # right-hand normal
            from scipy.spatial import cKDTree
            kd = cKDTree(PO)
            _, kk = kd.query(np.stack([f['x'][idx], f['z'][idx]], 1))
            side = np.sign((PO[kk, 0] - f['x'][idx]) * nx_[idx] + (PO[kk, 1] - f['z'][idx]) * nz_[idx])   # other track: +1 right
            plan.append((tr, idx, -side * w[idx] * shift, nx_[idx], nz_[idx]))
        if not ok:
            log(f'  island spacing at {st}: {d0:.1f} m, junction too close to spread; left as mapped')
            continue
        for (tr, idx, off, nx_, nz_) in plan:
            tr['fine']['x'] = tr['fine']['x'].copy(); tr['fine']['z'] = tr['fine']['z'].copy()
            tr['fine']['x'][idx] += off * nx_; tr['fine']['z'][idx] += off * nz_
        done.append(f'{st} {d0:.1f}->{ISLAND_SPACING}')
    log('island spacing (OSM tracks too close for the island platform): ' + (', '.join(done) if done else 'none'))
    return done
