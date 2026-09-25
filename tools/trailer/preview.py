#!/usr/bin/env python3
"""Preview trailer shots: capture K frames of each (stepping every frame, DSF 1) and build one contact sheet.
   python3 tools/trailer/preview.py OUTDIR shot1 shot2 ...   (shot names from tools/trailer/shots/, without .mjs)"""
import subprocess, sys, os, glob
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]; shots = sys.argv[2:]; K = int(os.environ.get('K', '4'))
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def run_group(cmd, timeout, **kw):
    """run cmd in its own process group; on timeout stop the whole group gracefully (SIGTERM, then SIGKILL)"""
    import signal
    p = subprocess.Popen(cmd, start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, **kw)
    try:
        out, _ = p.communicate(timeout=timeout); return p.returncode, out
    except subprocess.TimeoutExpired:
        for sig, wait in ((signal.SIGTERM, 8), (signal.SIGKILL, 2)):
            try: os.killpg(p.pid, sig)
            except ProcessLookupError: break
            try: out, _ = p.communicate(timeout=wait); return None, (out or '') + '\ntimeout'
            except subprocess.TimeoutExpired: pass
        return None, 'timeout'
rows = []
for s in shots:
    d = os.path.join(out, s)
    subprocess.run(['rm', '-rf', d])
    rc, out_ = run_group(['node', 'tools/capture.mjs', '--shot', f'tools/trailer/shots/{s}.mjs', '--out', d, '--preview', str(K)] + (['--frames', os.environ['FRAMES']] if os.environ.get('FRAMES') else []) + (['--base', os.environ['BASE']] if os.environ.get('BASE') else []),
                         900, cwd=root)
    log = out_.strip().splitlines()
    print(s, '|', ' / '.join(l for l in log if any(w in l for w in ('setup', 'prime', 'error', 'Error', 'done', 'timeout')))[:600], flush=True)
    rows.append((s, sorted(glob.glob(d + '/*.jpg'))))
W, H = 440, 248
sheet = Image.new('RGB', (W * K + 160, H * len(rows)), (16, 16, 18)); dr = ImageDraw.Draw(sheet)
for r, (s, fs) in enumerate(rows):
    dr.text((8, r * H + 8), s, fill=(240, 240, 240))
    for c, f in enumerate(fs[:K]):
        sheet.paste(Image.open(f).resize((W, H), Image.LANCZOS), (160 + c * W, r * H))
sheet.save(os.path.join(out, 'sheet.jpg'), quality=88)
print('sheet', os.path.join(out, 'sheet.jpg'))
