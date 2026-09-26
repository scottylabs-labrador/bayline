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
# (+-20 m) with cosine tapers of up to 150 m that stop short of any junction. Where a siding complex sits between the
# mains next to the platform (San Bruno's middle pocket track and its two crossovers), its switch points first slide out
# of the platform (slide_switches: >= 10 m past the end) and the whole complex is spread with the mains, keeping every
# point's fractional position across the corridor (spread_corridor).
ISLAND_MIN = 8.2           # m track centres below which the island would be < 5 m wide (2 x 1.616 m edges)
ISLAND_SPACING = 11.1
TAPER = 150.0
JUNCTION_CLEAR = 25.0


def spread_corridor(tracks, st, ia, ib, a0, a1, junctions_of, H_TARGET=ISLAND_SPACING / 2):
    """Spread the island tracks ia, ib (indices) to H_TARGET either side of their midline along the platform [a0, a1]
    (fine s on ia), together with every siding / crossover that lies between them near the platform (San Bruno's middle
    pocket track and its crossovers), so switch points stay on their tracks and the island gets its width. Points keep
    their fractional position across the corridor; cosine tapers beyond the zone stop short of any other junction.
    junctions_of[i] = [(fine s, set of other track indices)] for every junction vertex on track i."""
    from scipy.spatial import cKDTree
    ta, tb = tracks[ia], tracks[ib]
    fa, fb = ta['fine'], tb['fine']
    PA = np.stack([fa['x'], fa['z']], 1); PB = np.stack([fb['x'], fb['z']], 1)
    kda = cKDTree(PA)

    def on_a(P):                                   # fine s on ta of points P (nearest)
        return fa['s'][kda.query(P)[1]]

    z0, z1 = a0 - 20.0, a1 + 20.0
    members = set()
    for _ in range(6):
        changed = False
        for i in [ia, ib] + sorted(members):
            tr = tracks[i]
            P = np.stack([tr['fine']['x'], tr['fine']['z']], 1)
            for (sj, others) in junctions_of.get(i, []):
                pj = P[int(np.argmin(np.abs(tr['fine']['s'] - sj)))]
                sa = float(on_a(pj[None])[0])
                if not (z0 - 40 <= sa <= z1 + 40):
                    continue
                for o in others:
                    if o in (ia, ib) or o in members:
                        continue
                    to = tracks[o]
                    if to['service'] is None or to['length'] > 1200:
                        return None, f'{to["id"]} (a main or long track) joins inside the island zone'
                    members.add(o); changed = True
                    Po = np.stack([to['fine']['x'], to['fine']['z']], 1)
                    so = on_a(Po)
                    z0, z1 = min(z0, float(so.min()) - 20.0), max(z1, float(so.max()) + 20.0)
        if not changed:
            break
    # taper room: to the nearest junction on ia / ib outside the zone that is not a member's
    def room(side):
        best = TAPER + JUNCTION_CLEAR
        for i in (ia, ib):
            tr = tracks[i]
            P = np.stack([tr['fine']['x'], tr['fine']['z']], 1)
            for (sj, others) in junctions_of.get(i, []):
                if others and others <= (members | {ia, ib}):
                    continue
                sa = float(on_a(P[int(np.argmin(np.abs(tr['fine']['s'] - sj)))][None])[0])
                if side < 0 and sa < z0:
                    best = min(best, z0 - sa)
                if side > 0 and sa > z1:
                    best = min(best, sa - z1)
        return best - JUNCTION_CLEAR
    t0, t1 = min(TAPER, room(-1)), min(TAPER, room(+1))
    if min(t0, t1) < 60.0 or z0 - t0 < fa['s'][0] or z1 + t1 > fa['s'][-1]:
        return None, f'no room for the tapers ({t0:.0f} m / {t1:.0f} m)'
    # midline along ta
    m_s = fa['s'][(fa['s'] >= z0 - t0) & (fa['s'] <= z1 + t1)]
    ia0 = int(np.searchsorted(fa['s'], m_s[0])); pa = PA[ia0:ia0 + len(m_s)]
    kdb = cKDTree(PB)
    pb = PB[kdb.query(pa)[1]]
    mid = 0.5 * (pa + pb); hv = 0.5 * (pa - pb); h = np.hypot(hv[:, 0], hv[:, 1]) + 1e-9; nv = hv / h[:, None]
    w = np.ones(len(m_s))
    lo = m_s < z0; w[lo] = 0.5 - 0.5 * np.cos(np.pi * (m_s[lo] - (z0 - t0)) / t0)
    hi = m_s > z1; w[hi] = 0.5 - 0.5 * np.cos(np.pi * ((z1 + t1) - m_s[hi]) / t1)
    kdm = cKDTree(mid)
    moved = 0.0
    for i in [ia, ib] + sorted(members):
        tr = tracks[i]
        P = np.stack([tr['fine']['x'], tr['fine']['z']], 1)
        dd, j = kdm.query(P)
        rel = P - mid[j]
        lat = rel[:, 0] * nv[j, 0] + rel[:, 1] * nv[j, 1]
        inside = (np.abs(lat) <= h[j] + 1.5) & (dd < h[j] + 6.0) & (w[j] > 0)
        scale = 1.0 + w[j] * (H_TARGET / h[j] - 1.0)
        dl = np.where(inside, lat * (scale - 1.0), 0.0)
        nx = P[:, 0] + dl * nv[j, 0]; nz = P[:, 1] + dl * nv[j, 1]
        moved = max(moved, float(np.abs(dl).max()))
        tr['fine']['x'] = nx; tr['fine']['z'] = nz
    return dict(members=[tracks[i]['id'] for i in sorted(members)], zone=(round(z0), round(z1)), tapers=(round(t0), round(t1)),
                spacing=round(float(2 * np.median(h[(m_s >= a0) & (m_s <= a1)])), 1), moved=round(moved, 2)), None


SWITCH_CLEAR = 10.0        # m from a platform end to the first switch point beyond it


def corridor_members(tracks, ia, ib, z0, z1, junctions_of):
    """Sidings / crossovers that join the island tracks ia, ib within [z0 - 40, z1 + 40] (fine s on ia), transitively."""
    from scipy.spatial import cKDTree
    fa = tracks[ia]['fine']; kda = cKDTree(np.stack([fa['x'], fa['z']], 1))
    members = set()
    for _ in range(6):
        changed = False
        for i in [ia, ib] + sorted(members):
            tr = tracks[i]
            for (sj, others) in junctions_of.get(i, []):
                if i in (ia, ib):                       # on the mains: only switches near the platform
                    k = int(np.argmin(np.abs(tr['fine']['s'] - sj)))
                    sa = float(fa['s'][kda.query([[tr['fine']['x'][k], tr['fine']['z'][k]]])[1][0]])
                    if not (z0 - 40 <= sa <= z1 + 40):
                        continue
                for o in others - {ia, ib} - members:     # the whole siding complex, wherever it connects
                    if tracks[o]['service'] is None or tracks[o]['length'] > 1200:
                        return None
                    members.add(o); changed = True
        if not changed:
            break
    return members


def slide_switches(tracks, st, ia, ib, plat, junctions_of, node_of):
    """Switch points of a siding complex that sit inside (or within SWITCH_CLEAR of) an island platform's end move out:
    the whole complex (San Bruno's middle pocket track and its crossovers) slides along the corridor away from the
    platform, keeping each point's fractional position across the corridor, and the mains' junction positions move
    with it. plat[i] = (s0, s1) fine s of the platform on island track i; node_of[(i, j)] = index into tracks[i]['nodes']
    of the junction shared with track j. Returns a log line or None."""
    from scipy.spatial import cKDTree
    fa, fb = tracks[ia]['fine'], tracks[ib]['fine']
    PA = np.stack([fa['x'], fa['z']], 1); PB = np.stack([fb['x'], fb['z']], 1)
    a0, a1 = plat[ia]
    members = corridor_members(tracks, ia, ib, a0, a1, junctions_of)
    if not members:
        return None
    # how far inside is the worst switch, and which platform end is it at (as fine s on ia)
    kda = cKDTree(PA)
    need, end_sign = 0.0, 0
    for i in (ia, ib):
        s0, s1 = plat[i]
        for (sj, others) in junctions_of.get(i, []):
            if not (others & members):
                continue
            for e_s, sgn in ((s0, -1), (s1, +1)):            # sgn: + = the end at larger s on track i
                depth = (e_s - sj) * sgn + SWITCH_CLEAR           # > 0: inside or too close
                if -60 < (sj - e_s) * sgn < SWITCH_CLEAR and depth > need:
                    # direction of that end on ia: which way along ia is "away from the platform"
                    tr = tracks[i]; k = int(np.argmin(np.abs(tr['fine']['s'] - sj)))
                    sa = float(fa['s'][kda.query([[tr['fine']['x'][k], tr['fine']['z'][k]]])[1][0]])
                    need, end_sign = depth, (1 if sa > 0.5 * (a0 + a1) else -1)
    if need <= 0:
        return None
    # midline along ia (whole track), fractional lateral coordinates
    kdb = cKDTree(PB)
    pb = PB[kdb.query(PA)[1]]
    mid = 0.5 * (PA + pb); hv = 0.5 * (PA - pb); h = np.hypot(hv[:, 0], hv[:, 1]) + 1e-9; nv = hv / h[:, None]
    ms = fa['s']; kdm = cKDTree(mid)
    for i in sorted(members):
        tr = tracks[i]
        P = np.stack([tr['fine']['x'], tr['fine']['z']], 1)
        _, j = kdm.query(P)
        rel = P - mid[j]
        f = (rel[:, 0] * nv[j, 0] + rel[:, 1] * nv[j, 1]) / h[j]
        tng = np.stack([nv[j, 1], -nv[j, 0]], 1)
        lon = rel[:, 0] * tng[:, 0] + rel[:, 1] * tng[:, 1]
        s_new = ms[j] + end_sign * need
        m2 = np.stack([np.interp(s_new, ms, mid[:, 0]), np.interp(s_new, ms, mid[:, 1])], 1)
        n2 = np.stack([np.interp(s_new, ms, nv[:, 0]), np.interp(s_new, ms, nv[:, 1])], 1)
        n2 /= np.hypot(n2[:, 0], n2[:, 1])[:, None]
        h2 = np.interp(s_new, ms, h)
        t2 = np.stack([n2[:, 1], -n2[:, 0]], 1)
        Q = m2 + (f * h2)[:, None] * n2 + lon[:, None] * t2
        tr['fine']['x'] = Q[:, 0]; tr['fine']['z'] = Q[:, 1]
    # the mains' junction nodes with members move along the mains by the same arc length
    moved = []
    for i in (ia, ib):
        tr = tracks[i]; f_ = tr['fine']
        # direction on track i that corresponds to +s on ia
        k0 = len(f_['s']) // 2
        j0 = int(kda.query([[f_['x'][k0], f_['z'][k0]]])[1][0]); k1 = min(k0 + 20, len(f_['s']) - 1)
        j1 = int(kda.query([[f_['x'][k1], f_['z'][k1]]])[1][0])
        same = 1 if fa['s'][j1] >= fa['s'][j0] else -1
        for o in members:
            k = node_of.get((i, o))
            if k is None:
                continue
            s_old = float(np.interp(tr['s_raw_nodes'][k], f_['raw'], f_['s']))
            s_new = s_old + same * end_sign * need
            tr['s_raw_nodes'][k] = float(np.interp(s_new, f_['s'], f_['raw']))
            moved.append(f"{tr['id']} {s_old:.0f}->{s_new:.0f}")
    return f"{st}: switches moved {need:.0f} m out of the platform with {[tracks[i]['id'] for i in sorted(members)]} ({', '.join(moved)})"
