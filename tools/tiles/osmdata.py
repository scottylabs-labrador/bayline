"""OSM vector data for masks and trees, extracted once from the Geofabrik NorCal PBF (data/raw/osm_pbf/) with pyosmium.

Output: data/raw/tiles/osm_extract.npz with world-coordinate (x, z) float32 geometry:
  areas: class codes (see AREA_*) + rings (outer/inner) with per-area bboxes,
  buildings: rings + area (m2) + light weight, roads: polylines + class, trees: points + species code,
  coastline: polylines (kept for reference).
Map data (c) OpenStreetMap contributors, ODbL 1.0.
"""
import os, time
import numpy as np
from .common import RAW, WORK, ll2w, log

PBF = os.path.join(RAW, 'osm_pbf', 'norcal-latest.osm.pbf')
OUT = os.path.join(WORK, 'osm_extract.npz')
BBOX = (-122.625, 36.905, -121.435, 37.860)          # lon_w, lat_s, lon_e, lat_n (world square + margin)

AREA_WATER, AREA_SALT, AREA_WETLAND, AREA_SAND, AREA_ROCK, AREA_FOREST, AREA_FARM, AREA_URBAN, AREA_PARK, AREA_GRASS, AREA_PAVE, AREA_BAY = range(1, 13)
AREA_NAMES = {AREA_WATER: 'water', AREA_SALT: 'salt pond', AREA_WETLAND: 'wetland', AREA_SAND: 'sand', AREA_ROCK: 'rock', AREA_FOREST: 'forest',
              AREA_FARM: 'farm', AREA_URBAN: 'urban', AREA_PARK: 'park', AREA_GRASS: 'natural grass', AREA_PAVE: 'pavement', AREA_BAY: 'bay'}

ROAD_CLASSES = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
                'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service', 'pedestrian', 'footway', 'cycleway', 'path', 'track']
ROAD_ID = {k: i for i, k in enumerate(ROAD_CLASSES)}

TREE_KINDS = {'oak': 0, 'redwood': 1, 'eucalyptus': 2, 'palm': 3, 'sycamore': 4, 'cypress': 5, 'pine': 6, 'street': 7, 'fanpalm': 8}


def area_class(t):
    g = t.get
    nat = g('natural'); lu = g('landuse'); wat = g('water'); ww = g('waterway'); aw = g('aeroway'); le = g('leisure'); am = g('amenity')
    if lu == 'salt_pond' or wat in ('salt_pool', 'salt_pond') or g('basin') == 'evaporation' or g('salt') == 'yes':
        return AREA_SALT
    if nat == 'bay' or nat == 'strait':
        return AREA_BAY
    if nat == 'water' or lu in ('reservoir', 'basin') or ww in ('riverbank', 'dock') or wat is not None and nat in (None, 'water'):
        if wat in ('wastewater',) or lu == 'basin' and g('basin') in ('detention', 'infiltration', 'retention') and nat != 'water':
            return AREA_WATER
        return AREA_WATER
    if nat in ('wetland', 'mud'):
        return AREA_WETLAND
    if nat in ('beach', 'sand', 'dune'):
        return AREA_SAND
    if nat in ('bare_rock', 'scree', 'shingle') or lu == 'quarry':
        return AREA_ROCK
    if nat == 'wood' or lu == 'forest':
        return AREA_FOREST
    if lu in ('farmland', 'orchard', 'vineyard', 'farmyard', 'greenhouse_horticulture', 'plant_nursery', 'meadow', 'allotments'):
        return AREA_FARM
    if aw in ('apron', 'runway', 'taxiway') or am == 'parking' or lu in ('railway',):
        return AREA_PAVE
    if le in ('park', 'golf_course', 'pitch', 'playground', 'garden', 'recreation_ground', 'dog_park', 'common') or lu in ('grass', 'recreation_ground', 'village_green', 'cemetery'):
        return AREA_PARK
    if nat in ('grassland', 'scrub', 'heath', 'fell'):
        return AREA_GRASS
    if lu in ('residential', 'commercial', 'industrial', 'retail', 'construction', 'garages', 'education', 'institutional', 'religious', 'military', 'brownfield') \
            or am in ('school', 'university', 'college', 'hospital'):
        return AREA_URBAN
    return 0


def tree_kind(t):
    sp = (t.get('species') or t.get('species:en') or t.get('taxon') or '').lower()
    ge = (t.get('genus') or '').lower()
    s = sp + ' ' + ge
    if 'quercus' in s or 'oak' in s:
        return TREE_KINDS['oak']
    if 'sequoia' in s or 'redwood' in s:
        return TREE_KINDS['redwood']
    if 'eucalyptus' in s or 'corymbia' in s:
        return TREE_KINDS['eucalyptus']
    if 'washingtonia' in s or 'fan palm' in s or 'trachycarpus' in s or 'chamaerops' in s:
        return TREE_KINDS['fanpalm']
    if 'phoenix' in s or 'palm' in s or 'syagrus' in s or 'arecaceae' in s:
        return TREE_KINDS['palm']
    if 'platanus' in s or 'sycamore' in s or 'plane' in s:
        return TREE_KINDS['sycamore']
    if 'cupressus' in s or 'cypress' in s or 'hesperocyparis' in s or 'juniper' in s:
        return TREE_KINDS['cypress']
    if 'pinus' in s or 'pine' in s or 'cedrus' in s or 'cedar' in s:
        return TREE_KINDS['pine']
    lt = (t.get('leaf_type') or '').lower()
    if lt == 'needleleaved':
        return TREE_KINDS['pine']
    return 255     # unknown


def _in_bbox(lon, lat):
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]


def extract():
    import osmium
    t0 = time.time()
    areas_cls, rings_area, rings_inner, rings_xy = [], [], [], []
    bld_rings, bld_area, bld_w = [], [], []
    roads, road_cls = [], []
    trees, tree_kind_ = [], []
    coast = []

    def ring_xy(ring):
        lons = np.fromiter((n.location.lon for n in ring), np.float64)
        lats = np.fromiter((n.location.lat for n in ring), np.float64)
        x, z = ll2w(lats, lons)
        return np.stack([x, z], 1).astype(np.float32)

    keys = ('natural', 'landuse', 'water', 'waterway', 'building', 'highway', 'aeroway', 'leisure', 'amenity', 'basin', 'salt')
    fp = (osmium.FileProcessor(PBF)
          .with_locations()
          .with_areas(osmium.filter.KeyFilter(*keys))
          .with_filter(osmium.filter.KeyFilter(*keys)))
    n = 0
    for o in fp:
        n += 1
        if n % 2000000 == 0:
            log(f'osm: {n} objects, {len(areas_cls)} areas, {len(bld_area)} buildings, {len(roads)} roads, {len(trees)} trees, {time.time() - t0:.0f}s')
        if o.is_node():
            if o.tags.get('natural') == 'tree':
                lo, la = o.location.lon, o.location.lat
                if _in_bbox(lo, la):
                    x, z = ll2w(la, lo)
                    trees.append((x, z)); tree_kind_.append(tree_kind(o.tags))
            continue
        if o.is_way():
            t = o.tags
            hw = t.get('highway'); nat = t.get('natural')
            if hw in ROAD_ID or nat == 'coastline':
                try:
                    nodes = o.nodes
                    if len(nodes) < 2:
                        continue
                    lo, la = nodes[0].location.lon, nodes[0].location.lat
                    lo2, la2 = nodes[len(nodes) - 1].location.lon, nodes[len(nodes) - 1].location.lat
                    if not (_in_bbox(lo, la) or _in_bbox(lo2, la2) or _in_bbox(nodes[len(nodes) // 2].location.lon, nodes[len(nodes) // 2].location.lat)):
                        continue
                    xy = ring_xy(nodes)
                except Exception:
                    continue
                if nat == 'coastline':
                    coast.append(xy)
                else:
                    roads.append(xy); road_cls.append(ROAD_ID[hw])
            continue
        if o.is_area():
            t = o.tags
            try:
                outers = list(o.outer_rings())
            except Exception:
                continue
            if not outers:
                continue
            first = outers[0]
            try:
                p0 = next(iter(first)).location
            except Exception:
                continue
            if t.get('building') is not None and t.get('building') != 'no':
                if not _in_bbox(p0.lon, p0.lat):
                    continue
                for ring in outers:
                    try:
                        xy = ring_xy(ring)
                    except Exception:
                        continue
                    if len(xy) < 3:
                        continue
                    a = 0.5 * abs(np.dot(xy[:-1, 0], xy[1:, 1]) - np.dot(xy[1:, 0], xy[:-1, 1]))
                    b = t.get('building')
                    w = 1.6 if b in ('commercial', 'retail', 'office', 'industrial', 'warehouse', 'hotel', 'hospital', 'supermarket') else \
                        0.9 if b in ('house', 'detached', 'residential', 'apartments', 'semidetached_house', 'terrace', 'yes') else 0.6
                    bld_rings.append(xy); bld_area.append(a); bld_w.append(w)
                continue
            c = area_class(t)
            if not c:
                continue
            # quick bbox check: any outer ring vertex bbox overlapping the world
            ok = False
            rr = []
            for ring in outers:
                try:
                    xy = ring_xy(ring)
                except Exception:
                    continue
                if len(xy) < 3:
                    continue
                rr.append((xy, False))
                try:
                    for inner in o.inner_rings(ring):
                        ixy = ring_xy(inner)
                        if len(ixy) >= 3:
                            rr.append((ixy, True))
                except Exception:
                    pass
            if not rr:
                continue
            allxy = np.concatenate([r[0] for r in rr], 0)
            lat_s, lon_w = (37.40 - allxy[:, 1].max() / 110985.1), (-122.10 + allxy[:, 0].min() / 88542.2)
            lat_n, lon_e = (37.40 - allxy[:, 1].min() / 110985.1), (-122.10 + allxy[:, 0].max() / 88542.2)
            if lon_e < BBOX[0] or lon_w > BBOX[2] or lat_n < BBOX[1] or lat_s > BBOX[3]:
                continue
            ai = len(areas_cls)
            areas_cls.append(c)
            for xy, inner in rr:
                rings_area.append(ai); rings_inner.append(inner); rings_xy.append(xy)
    log(f'osm done: {n} objects, {len(areas_cls)} areas, {len(rings_xy)} rings, {len(bld_area)} buildings, {len(roads)} roads, {len(trees)} trees, {len(coast)} coastline ways in {time.time() - t0:.0f}s')

    def pack(list_xy):
        if not list_xy:
            return np.zeros((0, 2), np.float32), np.zeros(1, np.int64)
        off = np.zeros(len(list_xy) + 1, np.int64)
        off[1:] = np.cumsum([len(a) for a in list_xy])
        return np.concatenate(list_xy, 0).astype(np.float32), off

    ring_xy_, ring_off = pack(rings_xy)
    bld_xy, bld_off = pack(bld_rings)
    road_xy, road_off = pack(roads)
    coast_xy, coast_off = pack(coast)
    os.makedirs(WORK, exist_ok=True)
    np.savez_compressed(OUT, area_cls=np.array(areas_cls, np.uint8), ring_area=np.array(rings_area, np.int32), ring_inner=np.array(rings_inner, bool),
                        ring_xy=ring_xy_, ring_off=ring_off, bld_xy=bld_xy, bld_off=bld_off, bld_area=np.array(bld_area, np.float32), bld_w=np.array(bld_w, np.float32),
                        road_xy=road_xy, road_off=road_off, road_cls=np.array(road_cls, np.uint8),
                        tree_xz=np.array(trees, np.float32).reshape(-1, 2), tree_kind=np.array(tree_kind_, np.uint8),
                        coast_xy=coast_xy, coast_off=coast_off)
    log('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')


class OSM:
    """Loaded extract with per-feature bboxes for fast tile queries."""

    def __init__(self):
        d = np.load(OUT)
        self.d = d
        self.area_cls = d['area_cls']; self.ring_area = d['ring_area']; self.ring_inner = d['ring_inner']
        self.ring_xy = d['ring_xy']; self.ring_off = d['ring_off']
        self.bld_xy = d['bld_xy']; self.bld_off = d['bld_off']; self.bld_area = d['bld_area']; self.bld_w = d['bld_w']
        self.road_xy = d['road_xy']; self.road_off = d['road_off']; self.road_cls = d['road_cls']
        self.tree_xz = d['tree_xz']; self.tree_kind = d['tree_kind']
        self.ring_bb = self._bboxes(self.ring_xy, self.ring_off)
        self.bld_bb = self._bboxes(self.bld_xy, self.bld_off)
        self.road_bb = self._bboxes(self.road_xy, self.road_off)

    @staticmethod
    def _bboxes(xy, off):
        n = len(off) - 1
        if n <= 0:
            return np.zeros((0, 4), np.float32)
        mins_x = np.minimum.reduceat(xy[:, 0], off[:-1]); maxs_x = np.maximum.reduceat(xy[:, 0], off[:-1])
        mins_z = np.minimum.reduceat(xy[:, 1], off[:-1]); maxs_z = np.maximum.reduceat(xy[:, 1], off[:-1])
        return np.stack([mins_x, mins_z, maxs_x, maxs_z], 1)

    @staticmethod
    def _hits(bb, x0, z0, x1, z1):
        return np.where((bb[:, 0] < x1) & (bb[:, 2] > x0) & (bb[:, 1] < z1) & (bb[:, 3] > z0))[0]

    def rings_in(self, x0, z0, x1, z1):
        return self._hits(self.ring_bb, x0, z0, x1, z1)

    def buildings_in(self, x0, z0, x1, z1):
        return self._hits(self.bld_bb, x0, z0, x1, z1)

    def roads_in(self, x0, z0, x1, z1):
        return self._hits(self.road_bb, x0, z0, x1, z1)

    def ring(self, i):
        return self.ring_xy[self.ring_off[i]:self.ring_off[i + 1]]

    def bld(self, i):
        return self.bld_xy[self.bld_off[i]:self.bld_off[i + 1]]

    def road(self, i):
        return self.road_xy[self.road_off[i]:self.road_off[i + 1]]

    def trees_in(self, x0, z0, x1, z1):
        t = self.tree_xz
        m = (t[:, 0] >= x0) & (t[:, 0] < x1) & (t[:, 1] >= z0) & (t[:, 1] < z1)
        return t[m], self.tree_kind[m]
