#!/usr/bin/env python3
"""Extract the OpenStreetMap data for Bayline's towns v2 from Geofabrik's NorCal PBF.

Data (c) OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright

    pip install osmium                      # pyosmium
    python3 tools/fetch_osm.py              # downloads norcal-latest.osm.pbf if missing (~650 MB), extracts, keeps the PBF
    python3 tools/fetch_osm.py --delete-pbf # delete the PBF afterwards
    python3 tools/fetch_osm.py --metro      # Bayline Metro: + every BART corridor (3 km) and the north strip -> v3_*.pkl

Coverage ("towns v2", see SPEC_v2.md): everything within 3 km of the rail line or 1.5 km of a landmark (parsed from
src/js/50_landmarks.js), plus all of San Francisco and the downtown San Jose core:
  buildings and building:parts (footprints + height / levels / roof / colour / material / use tags),
  roads (motorway .. residential, service lanes, pedestrian streets), areas (parks, pitches, playgrounds, parking,
  plazas, cemeteries, landuse residential/commercial/retail/industrial, aerodromes), street lamps, mapped trees.

Output (projected to Bayline world metres, +X east, +Z south — see SPEC.md), pickled for tools/bake_towns.py:
  data/raw/osm/v2_buildings.pkl   [(osm_key, tags, [outer rings], [inner rings])]
  data/raw/osm/v2_roads.pkl       [(way_id, tags, node_refs, [(x, z), ...])]
  data/raw/osm/v2_areas.pkl       [(osm_key, tags, [outer rings])]
  data/raw/osm/v2_points.pkl      [(node_id, tags, x, z)]
"""
import json, math, os, pickle, re, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, 'data/raw/osm'); os.makedirs(RAW, exist_ok=True)
PBF = os.path.join(RAW, 'norcal-latest.osm.pbf')
PBF_URL = 'https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf'

corr = json.load(open(os.path.join(ROOT, 'data/baked/corridor.json')))
LAT0, LON0, MLAT, MLON = corr['lat0'], corr['lon0'], corr['mPerDegLat'], corr['mPerDegLon']
def W(lat, lon): return ((lon - LON0) * MLON, -(lat - LAT0) * MLAT)

R_TRACK = 3000.0          # buildings / roads / areas within this of the line
R_LANDMARK = 1500.0
CORES = {'sf_core': (37.7560, -122.4270, 37.8080, -122.3840), 'sj_core': (37.3200, -121.9050, 37.3460, -121.8750),
         'sf_city': (37.7030, -122.5160, 37.8125, -122.3550),     # all of San Francisco (matches the imagery AOI)
         'east_bay': (37.7600, -122.3350, 37.8429, -122.2150), 'treasure_island': (37.8050, -122.3800, 37.8350, -122.3550)}
CELL = 25.0

def landmarks():
    src = open(os.path.join(ROOT, 'src/js/50_landmarks.js'), encoding='utf-8').read()
    out = []
    for m in re.finditer(r"def\((['\"])(.+?)\1,\s*([0-9.+-]+),\s*([0-9.+-]+),\s*([0-9.]+)", src):
        out.append((m.group(2), float(m.group(3)), float(m.group(4)), float(m.group(5))))
    return out

METRO = '--metro' in sys.argv            # Bayline Metro (notes/bart/world.md): BART corridors + the north strip
OUT_PREFIX = 'v3_' if METRO else 'v2_'

def metro_lines():
    """BART centrelines (world x, z) from the data workstream's network (tools/tiles/metro.py)."""
    sys.path.insert(0, HERE)
    from tiles import metro
    return [l['xz'] for l in metro.lines()]

def coverage_raster():
    """Boolean 'in coverage' raster over the world, 25 m cells."""
    from scipy import ndimage
    x0, x1, z0, z1 = -46000.0, 58000.0, (-75800.0 if METRO else -50000.0), 54000.0
    NX, NZ = int((x1 - x0) / CELL), int((z1 - z0) / CELL)
    seed = np.ones((NZ, NX), bool)
    def mark_line(P):
        for (ax, az), (bx, bz) in zip(P, P[1:]):
            n = max(1, int(math.hypot(bx - ax, bz - az) / (CELL * 0.5)))
            for k in range(n + 1):
                x, z = ax + (bx - ax) * k / n, az + (bz - az) * k / n
                i, j = int((x - x0) / CELL), int((z - z0) / CELL)
                if 0 <= i < NX and 0 <= j < NZ: seed[j, i] = False
    for key in ('mainline', 'southCounty'):
        mark_line([W(*p) for p in corr[key]['pts']])
    if METRO:
        for P in metro_lines():
            mark_line([(float(x), float(z)) for x, z in P])
    d_line = ndimage.distance_transform_edt(seed).astype(np.float32) * CELL
    cov = d_line <= R_TRACK
    gx = x0 + (np.arange(NX) + 0.5) * CELL; gz = z0 + (np.arange(NZ) + 0.5) * CELL
    for name, la, lo, _r in landmarks():
        x, z = W(la, lo)
        i0, i1 = max(0, int((x - R_LANDMARK - x0) / CELL)), min(NX, int((x + R_LANDMARK - x0) / CELL) + 1)
        j0, j1 = max(0, int((z - R_LANDMARK - z0) / CELL)), min(NZ, int((z + R_LANDMARK - z0) / CELL) + 1)
        if i0 >= i1 or j0 >= j1: continue
        dx = gx[i0:i1][None, :] - x; dz = gz[j0:j1][:, None] - z
        cov[j0:j1, i0:i1] |= (dx * dx + dz * dz) <= R_LANDMARK * R_LANDMARK
    for la0, lo0, la1, lo1 in CORES.values():
        (ax, az), (bx, bz) = W(la1, lo0), W(la0, lo1)          # NW, SE corners
        cov[max(0, int((az - z0) / CELL)):int((bz - z0) / CELL) + 1, max(0, int((ax - x0) / CELL)):int((bx - x0) / CELL) + 1] = True
    print(f'coverage raster {NX}x{NZ}: {cov.sum() * CELL * CELL / 1e6:.0f} km²', flush=True)
    def inside(x, z):
        i, j = int((x - x0) / CELL), int((z - z0) / CELL)
        return 0 <= i < NX and 0 <= j < NZ and cov[j, i]
    return inside, d_line, (x0, z0, NX, NZ)

KEEP_B = ('building', 'building:part', 'height', 'min_height', 'building:levels', 'building:min_level', 'roof:levels', 'roof:shape',
          'roof:height', 'roof:colour', 'building:colour', 'building:material', 'roof:material', 'name', 'amenity', 'shop', 'aeroway',
          'tourism', 'historic', 'office', 'leisure', 'man_made', 'layer', 'location', 'parking', 'religion', 'craft', 'building:use')
KEEP_R = ('highway', 'lanes', 'oneway', 'junction', 'bridge', 'tunnel', 'covered', 'layer', 'service', 'access', 'name', 'ref', 'width',
          'sidewalk', 'maxspeed', 'area', 'lanes:forward', 'lanes:backward')
KEEP_A = ('leisure', 'landuse', 'amenity', 'place', 'highway', 'area', 'parking', 'aeroway', 'name', 'surface', 'sport', 'natural', 'layer', 'location')
KEEP_P = ('highway', 'natural', 'genus', 'species', 'taxon', 'leaf_type', 'height', 'circumference', 'diameter_crown', 'lamp_type', 'support')
ROAD_HW = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary',
           'tertiary_link', 'residential', 'unclassified', 'living_street', 'service', 'pedestrian'}
AREA_TAGS = {'leisure': {'park', 'playground', 'pitch', 'garden', 'dog_park', 'sports_centre', 'track', 'golf_course', 'stadium'},
             'landuse': {'grass', 'recreation_ground', 'village_green', 'cemetery', 'allotments', 'residential', 'commercial', 'retail', 'industrial',
                         'railway', 'construction', 'meadow'},
             'amenity': {'parking', 'school', 'university', 'college', 'hospital'}, 'place': {'square'}, 'aeroway': {'aerodrome', 'apron'}}

def is_area_feature(t):
    if any(t.get(k) in v for k, v in AREA_TAGS.items()): return True
    return t.get('highway') == 'pedestrian' and t.get('area') == 'yes'

def pick(tags, keys): return {k: tags[k] for k in keys if k in tags}

def extract():
    import osmium
    t0 = time.time()
    inside, d_line, _ = coverage_raster()
    def any_inside(pts):
        step = max(1, len(pts) // 10)
        for x, z in pts[::step]:
            if inside(x, z): return True
        return inside(*pts[-1])
    blds, roads, areas, points = [], [], [], []
    fp = (osmium.FileProcessor(PBF)
          .with_locations('sparse_mem_array')
          .with_areas(osmium.filter.KeyFilter('building', 'building:part', 'leisure', 'landuse', 'amenity', 'place', 'highway', 'aeroway'))
          .with_filter(osmium.filter.KeyFilter('highway', 'building', 'building:part', 'leisure', 'landuse', 'amenity', 'natural', 'place', 'aeroway')))
    n_seen = 0
    def ring_xz(r):
        return [W(n.lat, n.lon) for n in r]
    for o in fp:
        n_seen += 1
        if n_seen % 2_000_000 == 0:
            print(f'  {n_seen/1e6:.0f}M objects · {len(blds)} buildings {len(roads)} roads {len(areas)} areas {len(points)} points · {time.time()-t0:.0f}s', flush=True)
        if o.is_node():
            t = o.tags
            if t.get('highway') == 'street_lamp' or t.get('natural') == 'tree':
                try: x, z = W(o.location.lat, o.location.lon)
                except osmium.InvalidLocationError: continue
                if inside(x, z): points.append((o.id, pick(t, KEEP_P), round(x, 2), round(z, 2)))
            continue
        if o.is_way():
            t = o.tags; hw = t.get('highway')
            if not hw or hw not in ROAD_HW or t.get('area') == 'yes': continue
            if hw == 'service' and re.search('driveway|parking_aisle|drive-through', t.get('service', '')): continue
            try: pts = [W(n.lat, n.lon) for n in o.nodes]; refs = [n.ref for n in o.nodes]
            except osmium.InvalidLocationError: continue
            if len(pts) < 2 or not any_inside(pts): continue
            roads.append((o.id, pick(t, KEEP_R), refs, [(round(x, 2), round(z, 2)) for x, z in pts]))
            continue
        if o.is_area():
            t = o.tags; bld = t.get('building') or t.get('building:part'); feat = is_area_feature(t)
            if not bld and not feat: continue
            try:
                outers = []; inners = []
                for r in o.outer_rings():
                    outers.append(ring_xz(r))
                    for ir in o.inner_rings(r): inners.append(ring_xz(ir))
            except osmium.InvalidLocationError: continue
            if not outers or not outers[0]: continue
            if not any_inside([p for r in outers for p in r]): continue
            key = ('w' if o.from_way() else 'r') + str(o.orig_id())
            rnd = lambda R: [[(round(x, 2), round(z, 2)) for x, z in r] for r in R]
            if bld: blds.append((key, pick(t, KEEP_B), rnd(outers), rnd(inners)))
            else: areas.append((key, pick(t, KEEP_A), rnd(outers)))
    for name, obj in ((OUT_PREFIX + 'buildings', blds), (OUT_PREFIX + 'roads', roads), (OUT_PREFIX + 'areas', areas), (OUT_PREFIX + 'points', points)):
        path = os.path.join(RAW, name + '.pkl')
        with open(path + '.part', 'wb') as f: pickle.dump(obj, f, protocol=5)
        os.replace(path + '.part', path)
        print(f'{name}: {len(obj)} items, {os.path.getsize(path)/1e6:.1f} MB', flush=True)
    print(f'extract done in {time.time()-t0:.0f}s')

if __name__ == '__main__':
    if not os.path.exists(PBF):
        import subprocess
        print('downloading', PBF_URL, flush=True)
        subprocess.run(['curl', '-sSL', '-C', '-', '-o', PBF + '.part', PBF_URL], check=True)
        os.replace(PBF + '.part', PBF)
    extract()
    if '--delete-pbf' in sys.argv: os.remove(PBF)
