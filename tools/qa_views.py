#!/usr/bin/env python3
"""Fixed review views for graphics work: the same viewpoints, times and weather, for A/B comparison of builds, tiers and
data layers. Needs the dev server (tools/devserver.py). One headless Chrome per view (real GPU, 1440x900, DSF 1),
each under a watchdog; prints frame cost per view and writes a contact sheet when two runs are compared.

  python3 tools/qa_views.py OUT [--base http://localhost:8124/lead.html] [--hash q=ultra] [--views a,b] [--wait 24]
  python3 tools/qa_views.py --compare OUT_A OUT_B SHEET.jpg [--labels "before,after"]
"""
import argparse, json, os, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# name: (hash, relative altitude m or None = street level (the fly camera keeps 1.8 m above the ground), note)
# hash ll = lat,lon,0,yaw,pitch (yaw 0 = north, clockwise); w=clear keeps the weather out of the comparison
VIEWS = {
    'belmont_hills':   ('t=17:40&w=clear&ll=37.5160,-122.2830,0,-1.9,-0.34', 230, 'lidar relief of the Belmont hills, low sun'),
    'sancarlos_plat':  ('t=10:40&w=clear&at=san_carlos', None, 'platform eye level: ballast, paving, planting'),
    'alamo_victorians': ('t=16:10&w=clear&ll=37.77600,-122.43400,0,1.57,0.06', 6, 'the Painted Ladies on Steiner St from Alamo Square (facades)'),
    'tenderloin_post': ('t=15:20&w=clear&ll=37.78710,-122.41550,0,1.57,0.12', 4, 'mid-rise street, Post St (facades)'),
    'market_st':       ('t=13:30&w=clear&ll=37.78870,-122.40240,0,0.86,0.13', None, 'downtown street level (facades)'),
    'stanford_oval':   ('t=11:30&w=clear&ll=37.42760,-122.16930,0,0.0,-0.30', 55, 'lawns, paths, trees from low altitude'),
    'sanmateo_hills':  ('t=16:40&w=clear&ll=37.54700,-122.33500,0,-2.2,-0.38', 140, 'suburban hills: lidar + roofs + yards'),
    'golden_hills':    ('t=18:40&w=clear&ll=37.49000,-122.21000,0,-0.50,-0.25', 600, 'golden hour along the Peninsula (terrain shadows)'),
    'millbrae_track':  ('t=09:10&w=clear&at=millbrae', None, 'trackside eye level'),
    'twin_peaks':      ('t=18:25&w=clear&ll=37.75180,-122.44690,0,0.62,-0.12', 260, 'SF from Twin Peaks at golden hour'),
    'ecr_sanmateo':    ('t=12:10&w=clear&ll=37.56400,-122.32300,0,0.80,-0.20', 28, 'downtown San Mateo from 28 m (facades, roofs)'),
}
READY = 'new Promise(r=>{const f=()=>window.__bayline&&window.__bayline.Sim.TT?r():setTimeout(f,200);f();})'
PERF = ('new Promise(r=>{const B=__bayline,i=B.Env.renderer.info;for(const id of ["hud","toast"]){const e=document.getElementById(id);if(e)e.style.visibility="hidden"}let n=0,t0=performance.now();function f(){n++;if(n<90)requestAnimationFrame(f);'
        'else r(JSON.stringify({ms:+((performance.now()-t0)/n).toFixed(1),calls:i.render.calls,tris:i.render.triangles,nodes:B.Terrain.stats.nodes,'
        'hgt:B.Terrain.stats.hgt,lidar:!!B.Terrain.lidar,q:B.Post&&B.Post.quality,px:B.Env.renderer.getPixelRatio()}))}requestAnimationFrame(f)})')


def capture(out, name, base, extra, wait):
    h, rel, _ = VIEWS[name]
    url = f'{base}#auto&{h}' + (f'&{extra}' if extra else '')
    ev = READY + '.then(()=>1)'
    if rel is not None:       # aerial: hold the camera rel metres above the ground once the heights have streamed
        ev = READY + f'.then(()=>new Promise(r=>setTimeout(()=>{{const B=__bayline,P=B.Player;P.fly.y=B.Terrain.h(P.fly.x,P.fly.z)+{rel};r(1)}},4000)))'
    cmd = ['node', 'tools/shot.mjs', url, os.path.join(out, name + '.png'), '--gpu', '--w', '1440', '--h', '900',
           '--wait', str(wait * 1000), '--eval', ev, '--eval2', PERF]
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=wait + 90)
        lines = (r.stdout + r.stderr).splitlines()
    except subprocess.TimeoutExpired:
        lines = ['timeout']
    perf = None; errs = []
    for l in lines:
        if l.startswith('[eval] {'):
            try: perf = json.loads(l[7:])
            except ValueError: pass
        elif 'error' in l.lower() or 'pageerror' in l or l == 'timeout':
            errs.append(l[:300])
    return dict(view=name, perf=perf, errors=errs, s=round(time.time() - t0))


def compare(a, b, sheet, labels):
    from PIL import Image, ImageDraw
    names = [n for n in VIEWS if os.path.exists(os.path.join(a, n + '.png')) and os.path.exists(os.path.join(b, n + '.png'))]
    W = 960; rows = []
    for n in names:
        ims = [Image.open(os.path.join(d, n + '.png')).convert('RGB') for d in (a, b)]
        ims = [im.resize((W, round(im.height * W / im.width))) for im in ims]
        row = Image.new('RGB', (W * 2 + 8, ims[0].height + 30), (18, 18, 18))
        for k, im in enumerate(ims):
            row.paste(im, (k * (W + 8), 30))
        dr = ImageDraw.Draw(row)
        for k in range(2):
            dr.text((k * (W + 8) + 8, 8), f'{n} — {labels[k]}', fill=(235, 235, 235))
        rows.append(row)
    H = sum(r.height for r in rows); out = Image.new('RGB', (W * 2 + 8, H), (18, 18, 18)); y = 0
    for r in rows:
        out.paste(r, (0, y)); y += r.height
    out.save(sheet, quality=88)
    print('sheet', sheet, len(names), 'views')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('out', nargs='?')
    ap.add_argument('--base', default='http://localhost:8124/lead.html')
    ap.add_argument('--hash', default='')
    ap.add_argument('--views', default='')
    ap.add_argument('--wait', type=int, default=24)
    ap.add_argument('--compare', nargs=3)
    ap.add_argument('--labels', default='before,after')
    a = ap.parse_args()
    if a.compare:
        compare(*a.compare, a.labels.split(',')); sys.exit(0)
    os.makedirs(a.out, exist_ok=True)
    res = []
    for n in (a.views.split(',') if a.views else VIEWS):
        r = capture(a.out, n, a.base, a.hash, a.wait); res.append(r)
        print(json.dumps(r), flush=True)
    json.dump(res, open(os.path.join(a.out, 'views.json'), 'w'), indent=1)
