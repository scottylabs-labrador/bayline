#!/usr/bin/env python3
"""Raw inputs for the Bayline Metro bake, cached under data/raw/metro/ (re-runs reuse the cache; --force refetches).

    python3 tools/metro/fetch.py [--force]

  gtfs/                    BART GTFS static feed (https://www.bart.gov/dev/schedules/google_transit.zip), unzipped;
                           the zip is kept under its published name
  osm/bart_osm.json        Overpass extract: BART/eBART/airport-connector track ways (all service tracks), route
                           relations, switches/buffer stops, platforms, entrances, stations (query: osm/q_bart.overpassql)
Terrain tiles are fetched on demand by the bake (tools/metro/elev.py, shared data/raw/terrarium/).
"""
import os, subprocess, sys, time, zipfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from metro.common import RAW, log

UA = 'bayline-sim/0.2 (ScottyLabs student project; metro data bake)'
GTFS_URL = 'https://www.bart.gov/dev/schedules/google_transit.zip'
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
QUERY = r"""[out:json][timeout:600][maxsize:1073741824][bbox:37.30,-122.56,38.08,-121.70];
(
  relation["network"~"BART"];
  relation["operator"~"BART|Bay Area Rapid Transit"];
  relation["route"~"subway|light_rail|train|monorail"]["name"~"BART|Oakland Airport|eBART|Antioch"];
)->.r;
.r out body;
(
  way(r.r);
  way["railway"]["gauge"~"1676"];
  way["railway"]["operator"~"BART|Bay Area Rapid Transit"];
)->.w;
(.w; way(around.w:3)["railway"~"^(subway|rail|light_rail|monorail|construction|disused|abandoned)$"];)->.w2;
.w2 out body geom;
node(w.w2)["railway"];
out body;
(
  way(around.w2:60)["railway"~"^(platform|platform_edge)$"];
  way(around.w2:60)["public_transport"="platform"];
  relation(around.w2:60)["public_transport"="platform"];
  node(around.w2:800)["railway"="subway_entrance"];
  node(around.w2:800)["entrance"]["railway"];
  node(around.w2:300)["railway"~"^(station|halt|stop)$"];
  node(around.w2:300)["public_transport"~"^(station|stop_position)$"];
  way(around.w2:300)["public_transport"="station"];
  way(around.w2:300)["railway"="station"];
  relation(around.w2:400)["public_transport"="stop_area"];
);
out body geom;
"""


def curl(args, **kw):
    return subprocess.run(['curl', '-sfL', '-A', UA] + args, check=True, **kw)


def main(force=False):
    os.makedirs(os.path.join(RAW, 'gtfs'), exist_ok=True)
    os.makedirs(os.path.join(RAW, 'osm'), exist_ok=True)
    have = [f for f in os.listdir(RAW) if f.startswith('google_transit') and f.endswith('.zip')]
    if force or not have:
        tmp = os.path.join(RAW, 'google_transit.zip.part')
        eff = curl(['-o', tmp, '-w', '%{url_effective}', GTFS_URL], capture_output=True).stdout.decode()
        name = os.path.basename(eff) if eff.endswith('.zip') else 'google_transit.zip'
        os.replace(tmp, os.path.join(RAW, name))
        have = [name]
        log('GTFS', name)
    z = os.path.join(RAW, sorted(have)[-1])
    with zipfile.ZipFile(z) as zf:
        zf.extractall(os.path.join(RAW, 'gtfs'))
    out = os.path.join(RAW, 'osm', 'bart_osm.json')
    open(os.path.join(RAW, 'osm', 'q_bart.overpassql'), 'w').write(QUERY)
    if force or not os.path.exists(out):
        for u in OVERPASS:
            try:
                t0 = time.time()
                curl(['-m', '900', '--data-urlencode', 'data@' + os.path.join(RAW, 'osm', 'q_bart.overpassql'), '-o', out + '.part', u])
                os.replace(out + '.part', out)
                log('OSM', u, os.path.getsize(out), 'bytes', round(time.time() - t0), 's')
                break
            except subprocess.CalledProcessError as e:
                log('overpass failed', u, e)
    log('raw inputs ready in', RAW)


if __name__ == '__main__':
    main('--force' in sys.argv)
