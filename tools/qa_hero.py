#!/usr/bin/env python3
"""Hero before/after set: gameplay-framed views (train cab at speed, platform, street level, low flights, golden hour,
night, forest), each captured on two builds with the same place, time and weather, then laid out side by side (full
size and as phone-sized thumbnails). Needs the dev server (tools/devserver.py).

  python3 tools/qa_hero.py OUT --a http://localhost:8124/prod.html --b http://localhost:8124/lead.html [--hash q=high]
      [--views cab,platform,...] [--labels "production,branch"]
"""
import argparse, json, os, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
READY = 'new Promise(r=>{const f=()=>window.__bayline&&window.__bayline.Sim.TT?r():setTimeout(f,200);f();})'
# (hash, page-side setup run once the world is ready (may return a promise), note)
FLY = lambda rel: f'(()=>new Promise(r=>setTimeout(()=>{{const B=__bayline,P=B.Player;P.fly.y=B.Terrain.h(P.fly.x,P.fly.z)+{rel};r(1)}},3500)))()'
# a southbound train through Atherton's trees at speed, seen from its cab (the clock is set to when it is there, and
# paused, so every build is shot from the same spot)
CAB = ('(()=>{const B=__bayline,Sim=B.Sim,o={};const sAt=B.Track.byId.menlo_park.s-1900,after=10*3600+5*60;let best=null;'
       'for(const p of Sim.plans){if(p.dir!==1||p.tEnd<after)continue;const f=t=>Sim.stateAt(p,t,o).s-sAt;let a=Math.max(p.tStart,after),b=p.tEnd;'
       'if(f(a)>=0||f(b)<0)continue;for(let i=0;i<44;i++){const m=(a+b)/2;if(f(m)<0)a=m;else b=m;}const v=Sim.stateAt(p,a,o).v;'
       'if(v<18)continue;if(!best||b<best.t)best={t:b,key:p.key,v};}'
       'if(!best)return 0;B.Env.setClock(best.t);B.Env.time.scale=1;B.Env.time.paused=true;B.Player.setFocus(best.key);B.Player.setMode("cab");return Math.round(best.v)})()')
LOOK = lambda yaw, pitch: f'(()=>{{__bayline.Player.look.yaw={yaw};__bayline.Player.look.pitch={pitch};return 1}})()'
VIEWS = {
    'cab':       ('t=10:05&w=clear&at=menlo_park', CAB, 'from the cab at speed through Atherton'),
    'platform':  ('t=18:10&w=clear&at=palo_alto', LOOK(-0.9, 0.03), 'Palo Alto platform, early evening, up the line'),
    'street':    ('t=13:00&w=clear&ll=37.78290,-122.46400,0,1.57,0.05', FLY(2), 'Clement St, San Francisco, street level'),
    'flight_pen': ('t=17:30&w=clear&ll=37.56800,-122.32800,0,-1.75,-0.25', FLY(120), 'low flight over San Mateo toward the hills, 120 m'),
    'flight_sf': ('t=16:00&w=clear&ll=37.79900,-122.42300,0,0.90,-0.30', FLY(80), 'over Russian Hill toward the Bay, 80 m'),
    'golden':    ('t=18:25&w=clear&ll=37.44470,-122.16150,0,-1.95,-0.05', FLY(25), 'golden hour over Palo Alto, 25 m, into the sun'),
    'night':     ('t=21:30&w=clear&ll=37.78710,-122.41550,0,1.57,0.12', FLY(4), 'Post St at night, street level'),
    'forest':    ('t=14:00&w=clear&ll=37.44500,-122.28000,0,-1.20,-0.30', FLY(150), 'the Woodside hills, 150 m'),
    # the round's first framings (midday / sun behind): where the difference is smaller
    'platform_noon': ('t=17:35&w=clear&at=palo_alto', None, 'Palo Alto platform, afternoon, sun behind'),
    'flight_pen_noon': ('t=11:30&w=clear&ll=37.56800,-122.32800,0,0.55,-0.32', FLY(120), 'low flight over downtown San Mateo, 120 m, late morning'),
    'flight_sf_noon': ('t=15:00&w=clear&ll=37.75900,-122.41800,0,0.10,-0.25', FLY(260), 'over the Mission toward downtown, 260 m'),
    'golden_twinpeaks': ('t=18:40&w=clear&ll=37.75180,-122.44690,0,0.62,-0.12', FLY(260), 'golden hour from Twin Peaks, sun behind'),
    'meadow':    ('t=14:00&w=clear&ll=37.44500,-122.28000,0,-1.20,-0.30', None, 'a Woodside meadow, eye level'),
    'sunset_st': ('t=18:35&w=clear&ll=37.78290,-122.46400,0,-1.57,0.05', FLY(2), 'Clement St at sunset, into the sun'),
    # Ultra+ extras (compare --a ...lead.html#q=ultra vs --b ...#q=ultraplus!)
    'bay_bridge': ('t=17:30&w=clear&ll=37.79560,-122.39150,0,1.95,-0.06', FLY(12), 'the Bay Bridge from the Embarcadero'),
    'bay_night': ('t=21:00&w=clear&ll=37.81800,-122.36700,0,-2.25,-0.04', FLY(20), 'San Francisco across the water at night'),
    'sunset':    ('t=18:52&w=clear&ll=37.50500,-122.24000,0,-2.15,-0.16', FLY(420), 'sun behind the Santa Cruz Mountains'),
}


def capture(base, name, extra, out, wait=16):
    h, setup, _ = VIEWS[name]
    url = f'{base}#auto&{h}' + (f'&{extra}' if extra else '')
    ev = READY + '.then(()=>{document.body.classList.add("photo")})' + (f'.then(()=>{setup})' if setup else '.then(()=>1)')   # photo mode: no traffic tags
    ev2 = ('(()=>{document.body.classList.add("photo");for(const id of ["hud","toast"]){const e=document.getElementById(id);if(e)e.style.visibility="hidden"}'
           'const B=__bayline;return JSON.stringify({q:B.Post&&B.Post.quality,px:B.Env.renderer.getPixelRatio()})})()')
    cmd = ['node', 'tools/shot.mjs', url, out, '--gpu', '--w', '1440', '--h', '900', '--wait', str(wait * 1000), '--eval', ev, '--eval2', ev2]
    try:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=wait + 100)
        lines = (r.stdout + r.stderr).splitlines()
    except subprocess.TimeoutExpired:
        lines = ['timeout']
    return [l[:300] for l in lines if 'rror' in l or l == 'timeout']


def sheet(pairs, path, labels, W, title=True):
    from PIL import Image, ImageDraw
    rows = []
    for name, a, b in pairs:
        ims = [Image.open(p).convert('RGB') for p in (a, b)]
        ims = [im.resize((W, round(im.height * W / im.width))) for im in ims]
        top = 26 if title else 0
        row = Image.new('RGB', (W * 2 + 6, ims[0].height + top), (16, 16, 16))
        for k, im in enumerate(ims):
            row.paste(im, (k * (W + 6), top))
        if title:
            d = ImageDraw.Draw(row)
            for k in range(2):
                d.text((k * (W + 6) + 8, 7), f'{VIEWS[name][2]} — {labels[k]}', fill=(236, 236, 236))
        rows.append(row)
    out = Image.new('RGB', (rows[0].width, sum(r.height for r in rows) + 4 * (len(rows) - 1)), (0, 0, 0)); y = 0
    for r in rows:
        out.paste(r, (0, y)); y += r.height + 4
    out.save(path, quality=90)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--a', required=True); ap.add_argument('--b', required=True)
    ap.add_argument('--hash', default='q=high'); ap.add_argument('--hash-b', default=None)
    ap.add_argument('--views', default='cab,platform,street,flight_pen,flight_sf,golden,night,forest')
    ap.add_argument('--labels', default='production,branch')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    pairs = []
    for n in a.views.split(','):
        fa, fb = os.path.join(a.out, f'{n}_a.png'), os.path.join(a.out, f'{n}_b.png')
        ea = capture(a.a, n, a.hash, fa); eb = capture(a.b, n, a.hash_b or a.hash, fb)
        print(json.dumps({'view': n, 'errors_a': ea, 'errors_b': eb}), flush=True)
        if os.path.exists(fa) and os.path.exists(fb):
            pairs.append((n, fa, fb))
    labels = a.labels.split(',')
    sheet(pairs, os.path.join(a.out, 'hero.jpg'), labels, 960)
    sheet(pairs, os.path.join(a.out, 'hero_thumbs.jpg'), labels, 300, title=False)
    for n, fa, fb in pairs:
        sheet([(n, fa, fb)], os.path.join(a.out, f'pair_{n}.jpg'), labels, 1200)
    print('done', len(pairs), 'pairs ->', a.out)
