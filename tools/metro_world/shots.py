#!/usr/bin/env python3
"""Before/after screenshot sets for the Bayline Metro world work (one headless Chrome at a time, through tools/wd.py).

  python3 tools/metro_world/shots.py OUTDIR [--page world.html] [--port 8132] [--only name,name] [--set flight|bart|all]
         [--t 12:00] [--wait 45000] [--q high] [--extra "&h9=0"]

Views are named `ll=` viewpoints (lat, lon, altitude m, yaw rad (0 = north, +pi/2 = east), pitch rad). Each PNG is
converted to a small JPEG (OUTDIR/<name>.jpg) and the PNG removed. Prints the page's console errors.
"""
import argparse, os, subprocess, sys, time
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))

FLIGHT = {
    # the Golden Gate / Marin: the Globe north of lat 37.8429 today
    'marin_sausalito': (37.800, -122.470, 2500, 0.35, -0.30),
    'boundary_oakland_6km': (37.760, -122.300, 6000, 0.0, -0.55),
    'boundary_berkeley_3km': (37.815, -122.290, 3000, 0.1, -0.45),
    'sanpablo_bay': (37.930, -122.420, 3000, 0.45, -0.30),
    'kccr_final_32r': (37.955, -122.030, 700, -0.72, -0.12),
    'diablo_wc_3km': (37.875, -122.120, 3000, 1.30, -0.28),
    'rsr_bridge': (37.915, -122.400, 1200, -1.30, -0.25),
    'tiburon_low': (37.860, -122.440, 500, -0.60, -0.15),
}
BART = {
    'rockridge_sr24': (37.8420, -122.2560, 180, 1.35, -0.22),
    'orinda': (37.8765, -122.1950, 160, 1.20, -0.20),
    'lafayette': (37.8915, -122.1330, 160, 1.25, -0.20),
    'walnut_creek': (37.8990, -122.0700, 200, 0.45, -0.25),
    'concord': (37.9650, -122.0330, 200, 0.10, -0.25),
    'pittsburg_sr4': (38.0150, -121.9650, 200, 1.40, -0.20),
    'antioch': (37.9960, -121.8000, 200, 1.40, -0.18),
    'el_cerrito': (37.9180, -122.3180, 200, 0.25, -0.22),
    'berkeley': (37.8620, -122.2700, 220, 0.00, -0.30),
    'macarthur': (37.8240, -122.2690, 200, 0.10, -0.25),
    'fruitvale': (37.7700, -122.2330, 180, 2.30, -0.20),
    'coliseum_oak': (37.7480, -122.2010, 250, 2.80, -0.30),
    'hayward': (37.6760, -122.0950, 200, 2.60, -0.22),
    'castro_valley': (37.6900, -122.0900, 200, 1.40, -0.20),
    'dublin_i580': (37.7000, -121.9400, 200, 1.55, -0.20),
    'fremont': (37.5650, -121.9900, 200, 2.60, -0.22),
    'warm_springs': (37.5100, -121.9480, 200, 2.70, -0.20),
    'berryessa': (37.3760, -121.8820, 200, 2.80, -0.20),
    'daly_city': (37.7100, -122.4640, 200, 2.80, -0.22),
    'south_sf': (37.6700, -122.4450, 200, 2.70, -0.20),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--page', default='world.html')
    ap.add_argument('--port', default='8132')
    ap.add_argument('--only', default='')
    ap.add_argument('--set', default='all')
    ap.add_argument('--t', default='12:00')
    ap.add_argument('--wait', type=int, default=45000)
    ap.add_argument('--q', default='high')
    ap.add_argument('--extra', default='&w=clear')
    ap.add_argument('--w', default='1600')
    ap.add_argument('--h', default='900')
    a = ap.parse_args()
    views = {}
    if a.set in ('flight', 'all'):
        views.update(FLIGHT)
    if a.set in ('bart', 'all'):
        views.update(BART)
    if a.only:
        allv = {**FLIGHT, **BART}
        views = {k: allv[k] for k in a.only.split(',') if k in allv}
    os.makedirs(a.out, exist_ok=True)
    for name, (la, lo, al, yw, pt) in views.items():
        url = f'http://localhost:{a.port}/{a.page}#auto&t={a.t}&q={a.q}&ll={la},{lo},{al},{yw},{pt}{a.extra}'
        png = os.path.join(a.out, name + '.png')
        t0 = time.time()
        r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools/wd.py'), str(a.wait / 1000 + 90), 'node', os.path.join(ROOT, 'tools/shot.mjs'),
                            url, png, '--gpu', '--w', a.w, '--h', a.h, '--wait', str(a.wait),
                            '--eval2', "document.body.classList.add('photo'); new Promise(r => setTimeout(r, 400))"], capture_output=True, text=True)
        errs = [l for l in r.stdout.splitlines() if 'pageerror' in l or 'error' in l.lower()][:4]
        if os.path.exists(png):
            Image.open(png).convert('RGB').save(os.path.join(a.out, name + '.jpg'), quality=82)
            os.remove(png)
        print(f'{name}: {time.time() - t0:.0f}s rc={r.returncode}', *errs, sep='\n  ', flush=True)


if __name__ == '__main__':
    main()
