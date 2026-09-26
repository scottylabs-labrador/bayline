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
