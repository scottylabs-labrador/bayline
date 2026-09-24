"""Reader for the Towns street tiles (tiles/b/7/tx_ty.bin, 'BLT3', written by tools/bake_towns.py and drawn by
src/js/30_towns.js), for bakes that must agree with what Towns draws: the lidar detail is suppressed under the road
ribbons and infill yards, and the ground-material classes take asphalt, sidewalks and roofs from them.

decode(tx, ty) -> None | dict(ox, oz, region, infill (32x32 bool or None),
                               roads [dict(cls, flags, lanes, width, pts (n,2) world)], buildings [dict(kind, h, flags, pts)],
                               areas [dict(kind, pts)])
road_extent(road, region) -> half-width (m) of the widest ribbon Towns draws for it (carriageway + curb strip + walk,
                             or carriageway + shoulder), mirroring roadRibbon() in 30_towns.js.
"""
import functools, os, struct, zlib
import numpy as np
from .common import PUB

TILE = 800.0
X0, Z0 = -45056.0, -49152.0


def tile_path(tx, ty):
    return os.path.join(PUB, 'b', '7', f'{tx}_{ty}.bin')


def _pts(buf, o, n, ox, oz):
    a = np.frombuffer(buf, '<i2', n * 2, o).reshape(n, 2).astype(np.int64)
    a = np.cumsum(a, 0)                                   # first vertex absolute, the rest delta-coded (0.1 m units)
    return a.astype(np.float64) * 0.1 + (ox, oz), o + n * 4


@functools.lru_cache(maxsize=64)
def decode(tx, ty):
    p = tile_path(tx, ty)
    if not os.path.exists(p):
        return None
    buf = zlib.decompress(open(p, 'rb').read())
    if buf[:4] != b'BLT3':
        raise ValueError(f'towns tile {tx},{ty}: bad magic {buf[:4]!r}')
    nB, nR, nA, nT, nI, nL = struct.unpack_from('<6H', buf, 4)
    flags, region = struct.unpack_from('<BB', buf, 16)
    o = 18
    infill = None
    if flags & 1:
        bits = np.unpackbits(np.frombuffer(buf, np.uint8, 128, o), bitorder='little')
        infill = bits.reshape(32, 32).astype(bool); o += 128
    ox, oz = X0 + tx * TILE, Z0 + ty * TILE
    blds = []
    for _ in range(nB):
        kind, roof, h4, mh4, wall, roofc, bf, mat, lev, front, nv = struct.unpack_from('<BBHHHHBBBBH', buf, o); o += 16
        pts, o = _pts(buf, o, nv, ox, oz)
        blds.append(dict(kind=kind, h=h4 / 4.0, flags=bf, pts=pts))
    roads = []
    for _ in range(nR):
        cls, rf, lanes, w4, nv = struct.unpack_from('<BBBBH', buf, o); o += 6
        pts, o = _pts(buf, o, nv, ox, oz)
        if rf & 2:
            o += nv                                       # bridge deck offsets (the ribbon is on the deck, not the ground)
        roads.append(dict(cls=cls, flags=rf, lanes=lanes, width=w4 / 4.0, pts=pts))
    areas = []
    for _ in range(nA):
        kind, _pad, nv = struct.unpack_from('<BBH', buf, o); o += 4
        pts, o = _pts(buf, o, nv, ox, oz)
        areas.append(dict(kind=kind, pts=pts))
    return dict(ox=ox, oz=oz, region=region, infill=infill, roads=roads, buildings=blds, areas=areas)


def road_extent(r, region):
    """Half-width of the widest ribbon roadRibbon() draws (the detail level near the camera)."""
    c, f = r['cls'], r['flags']
    bridge, urban, core = bool(f & 2), bool(f & 8), bool(f & 4)
    hw = r['width'] / 2.0
    walks = urban and not bridge and 4 <= c <= 12 and c not in (5, 7, 9)
    if walks:
        strip = 1.5 if (not core and region >= 1 and c >= 8) else 0.0
        sw = (3.8 if c <= 8 else 3.0) if core else (3.0 if c <= 7 else 1.9)
        return hw + strip + sw
    return hw + ((1.6 if c <= 3 else 1.0) if not bridge else 0.0)
