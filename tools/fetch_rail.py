#!/usr/bin/env python3
"""OSM railway data along the corridor via Overpass -> data/raw/rail/rail.json (cached)."""
import json, os, sys, time, urllib.request, urllib.parse, math
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
cor = json.load(open(os.path.join(ROOT, 'data/baked/corridor.json')))
def simplify(pts, step):
    out = [pts[0]]
    for p in pts[1:]:
        if math.hypot((p[0]-out[-1][0])*110985, (p[1]-out[-1][1])*88542) >= step: out.append(p)
    if out[-1] != pts[-1]: out.append(pts[-1])
    return out
line = simplify(cor['mainline']['pts'], 600) + simplify(cor['southCounty']['pts'], 600)
def around(r, pts): return f"around:{r}," + ",".join(f"{la:.5f},{lo:.5f}" for la, lo in pts)
m = simplify(cor['mainline']['pts'], 600); s = simplify(cor['southCounty']['pts'], 600)
q = f"""[out:json][timeout:180];
(
  way["railway"~"^(rail|light_rail|subway|platform|platform_edge|switch)$"]({around(120, m)});
  way["railway"~"^(rail|platform)$"]({around(120, s)});
  way["public_transport"="platform"]({around(120, m)});
  way["public_transport"="platform"]({around(120, s)});
  node["railway"~"^(level_crossing|crossing|signal|switch|buffer_stop|milestone)$"]({around(80, m)});
  node["railway"~"^(level_crossing|crossing|signal|switch|milestone)$"]({around(80, s)});
  way["bridge"]["railway"]({around(120, m)});
);
out body geom;"""
urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']
out = os.path.join(ROOT, 'data/raw/rail/rail.json')
for u in urls:
    try:
        t0 = time.time()
        import subprocess
        body = subprocess.run(['curl', '-sf', '-m', '240', '-A', 'bayline-sim/0.1 (ScottyLabs student project)', '--data-urlencode', 'data@-', u],
                              input=q.encode(), capture_output=True, check=True).stdout
        d = json.loads(body); open(out, 'wb').write(body)
        print('ok', u, len(body), 'bytes', len(d['elements']), 'elements', round(time.time()-t0, 1), 's'); break
    except Exception as e:
        print('fail', u, e); time.sleep(5)
