#!/usr/bin/env python3
"""Bay water for the Globe around the Bayline area: data/pub/v2/tiles/globe/baywater.png (+ .json).

The Globe (15_globe.js) decides water from its photo (bluish or dark) and the DEM. The sediment-brown bays north and
east of the Bayline area (San Pablo Bay, Carquinez, Suisun, Grizzly and Honker Bays, the Delta's rivers) fail the
colour test and are drawn as flat land, and its ocean surf foam runs through every shallow bay: next to the Bayline
water that is a hard seam. This raster marks the inland water (OSM natural=bay / strait / water, water=*, waterway=
riverbank, landuse=reservoir) around the Bayline area, so in the Bay frame the Globe draws those as calm bay water
(no surf) where its DEM is near or below sea level.

  /usr/local/bin/python3 tools/metro_world/globe_water.py      # needs pyosmium; reads data/raw/osm_pbf/norcal-latest.osm.pbf

Raster: 1024 x 1024 grey PNG, north up, over BBOX (lon/lat, linear like the Bayline frame), 0 land .. 255 water
(2x supersampled). Map data (c) OpenStreetMap contributors, ODbL 1.0.
"""
import json, os, sys, time
import numpy as np
import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
PBF = os.path.join(ROOT, 'data', 'raw', 'osm_pbf', 'norcal-latest.osm.pbf')
OUT = os.path.join(ROOT, 'data', 'pub', 'v2', 'tiles', 'globe', 'baywater.png')
BBOX = (-123.30, 36.40, -120.90, 38.80)            # lon_w, lat_s, lon_e, lat_n
N = 1024


def main():
    import osmium
    t0 = time.time()
    polys = []
    lw, ls, le, ln = BBOX

    def to_px(ring):
        lon = np.fromiter((n.lon for n in ring), np.float64); lat = np.fromiter((n.lat for n in ring), np.float64)
        return np.stack([(lon - lw) / (le - lw) * N * 2, (ln - lat) / (ln - ls) * N * 2], 1)

    fp = (osmium.FileProcessor(PBF).with_locations()
          .with_areas(osmium.filter.KeyFilter('natural', 'water', 'waterway', 'landuse'))
          .with_filter(osmium.filter.KeyFilter('natural', 'water', 'waterway', 'landuse')))
    for o in fp:
        if not o.is_area():
            continue
        t = o.tags
        nat, wat, ww, lu = t.get('natural'), t.get('water'), t.get('waterway'), t.get('landuse')
        if not (nat in ('bay', 'strait', 'water') or wat or ww == 'riverbank' or lu == 'reservoir'):
            continue
        if wat in ('salt_pool', 'salt_pond', 'wastewater') or lu == 'salt_pond' or t.get('intermittent') == 'yes':
            continue
        try:
            for outer in o.outer_rings():
                P = to_px(outer)
                if P[:, 0].max() < 0 or P[:, 0].min() > 2 * N or P[:, 1].max() < 0 or P[:, 1].min() > 2 * N or len(P) < 3:
                    continue
                inners = [to_px(r) for r in o.inner_rings(outer)]
                polys.append((P, inners))
        except Exception:
            continue
    print(f'{len(polys)} water polygons in {time.time() - t0:.0f}s', flush=True)
    big = np.zeros((2 * N, 2 * N), np.uint8)
    for P, inners in polys:
        tmp = np.zeros_like(big)
        cv2.fillPoly(tmp, [np.round(P * 16).astype(np.int32)], 255, lineType=cv2.LINE_8, shift=4)
        if inners:
            cv2.fillPoly(tmp, [np.round(Q * 16).astype(np.int32) for Q in inners if len(Q) >= 3], 0, lineType=cv2.LINE_8, shift=4)
        big = np.maximum(big, tmp)
    small = cv2.resize(big.astype(np.float32), (N, N), interpolation=cv2.INTER_AREA)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    Image.fromarray(np.clip(small + 0.5, 0, 255).astype(np.uint8)).save(OUT, optimize=True)
    json.dump({'version': 1, 'bbox': BBOX, 'n': N, 'what': 'inland / bay water (not the open ocean) around the Bayline area, 0 land .. 255 water',
               'attribution': 'Map data (c) OpenStreetMap contributors, ODbL 1.0'}, open(OUT[:-4] + '.json', 'w'))
    print('wrote', OUT, os.path.getsize(OUT), 'bytes', flush=True)


if __name__ == '__main__':
    main()
