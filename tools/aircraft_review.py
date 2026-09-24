#!/usr/bin/env python3
"""Aircraft review sheets: screenshots of preview/aircraft.html for every type x view (x light), plus build time,
draw calls and triangles, and a labelled contact sheet (rows = types, columns = views).
   python3 tools/aircraft_review.py OUTDIR [--types a320,b738] [--views 34f,side,nose] [--tod day] [--base] [--q high]
                                          [--pose gear=0&flaps=max] [--port 8125] [--w 960 --h 540]
Needs the dev server (python3 tools/devserver.py PORT). --base renders the models as they are on main (dist/baseline/)."""
import argparse, json, os, subprocess, sys, time
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TYPES = ['c172', 'e330', 'dhc6', 'b350', 'dc3', 'a320', 'b738', 'b789', 'b744', 'a388', 'conc', 'f16', 'h125']
ap = argparse.ArgumentParser()
ap.add_argument('out'); ap.add_argument('--types', default=','.join(TYPES)); ap.add_argument('--views', default='34f,34r,side,nose,engine,gear')
ap.add_argument('--tod', default='day'); ap.add_argument('--base', action='store_true'); ap.add_argument('--q', default='high')
ap.add_argument('--pose', default=''); ap.add_argument('--port', default='8125'); ap.add_argument('--w', type=int, default=960); ap.add_argument('--h', type=int, default=540)
ap.add_argument('--sheet', default='sheet.jpg')
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
types, views = a.types.split(','), a.views.split(',')
WAIT = "new Promise(r => { const t0 = Date.now(); const f = () => (window.__ready || Date.now() - t0 > 20000) ? r(JSON.stringify(window.__stats || {})) : setTimeout(f, 100); f(); })"
stats = {}
for t in types:
    for v in views:
        name = f'{t}_{v}_{a.tod}{"_base" if a.base else ""}.png'
        url = f'http://localhost:{a.port}/preview/aircraft.html#type={t}&view={v}&tod={a.tod}&clean=1&q={a.q}' + ('&base=1' if a.base else '') + (('&' + a.pose) if a.pose else '')
        cmd = ['node', 'tools/shot.mjs', url, os.path.join(a.out, name), '--gpu', '--w', str(a.w), '--h', str(a.h), '--wait', '600', '--eval', WAIT]
        try:
            r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=90)
            out = r.stdout + r.stderr
            for line in out.splitlines():
                if line.startswith('[eval]'):
                    try:
                        st = json.loads(line[6:].strip())
                        if v == '34f' or t not in stats: stats[t] = st      # the 3/4 front view's numbers (the cockpit view's are misleading)
                    except Exception: pass
                elif 'rror' in line: print(f'  {t}/{v}: {line[:200]}')
        except subprocess.TimeoutExpired:
            print(f'  {t}/{v}: timeout')
    s = stats.get(t, {})
    print(f'{t:5s} build {s.get("buildMs", "?")} ms  calls {s.get("calls", "?")}  tris {s.get("tris", "?")}', flush=True)
json.dump(stats, open(os.path.join(a.out, 'stats' + ('_base' if a.base else '') + '.json'), 'w'), indent=1)
# contact sheet
W, H = 480, 270
sheet = Image.new('RGB', (130 + W * len(views), H * len(types)), (18, 18, 20)); d = ImageDraw.Draw(sheet)
for r, t in enumerate(types):
    s = stats.get(t, {})
    d.text((8, r * H + 8), f'{t}\n{s.get("buildMs", "?")} ms\n{s.get("calls", "?")} calls\n{round(s.get("tris", 0) / 1000)}k tris', fill=(235, 235, 235))
    for c, v in enumerate(views):
        p = os.path.join(a.out, f'{t}_{v}_{a.tod}{"_base" if a.base else ""}.png')
        if os.path.exists(p): sheet.paste(Image.open(p).convert('RGB').resize((W, H), Image.LANCZOS), (130 + c * W, r * H))
sheet.save(os.path.join(a.out, a.sheet), quality=86)
print('sheet', os.path.join(a.out, a.sheet))
