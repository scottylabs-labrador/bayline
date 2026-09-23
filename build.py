#!/usr/bin/env python3
"""Build Bayline into ONE self-contained HTML file.

    python3 build.py            -> dist/index.html  (three.js and all code inlined; data streams from ./data/v2/)

The page = src/head.html with three placeholders replaced:
  <!--THREE-->  vendor/three.min.js
  <!--DATA-->   every data/baked/*.bin and *.json as base64 <script type="application/octet-stream" id="blob-NAME">
  <!--APP-->    all src/js/*.js concatenated (sorted by file name) inside one function scope
"""
import base64, glob, os, sys, time
ROOT = os.path.dirname(os.path.abspath(__file__))
def read(p): return open(os.path.join(ROOT, p), encoding='utf-8').read()
head = read('src/head.html')
three = read('vendor/three.min.js').replace('console.warn(\'Scripts "build/three.js" and "build/three.min.js" are deprecated', '(()=>{})(\'')
# v2: data is streamed from DATA (./data/v2/), never embedded. BAYLINE_EMBED=1 restores the v1 single file.
blobs = []
if os.environ.get('BAYLINE_EMBED'):
    for path in sorted(glob.glob(os.path.join(ROOT, 'data/baked/*'))):
        name, ext = os.path.splitext(os.path.basename(path))
        if ext not in ('.bin', '.json') or name in ('corridor',): continue
        b = open(path, 'rb').read()
        blobs.append(f'<script type="application/octet-stream" id="blob-{name}{".json" if ext == ".json" else ""}">{base64.b64encode(b).decode()}</script>')
parts = []
skip = set(filter(None, os.environ.get('BAYLINE_SKIP', '').split(',')))   # e.g. BAYLINE_SKIP=50_landmarks.js for partial builds
JS_DIR = os.environ.get('BAYLINE_JS_DIR', os.path.join(ROOT, 'src/js'))   # tools/devbuild.sh stages a tolerant copy
for f in sorted(glob.glob(os.path.join(JS_DIR, '*.js'))):
    if os.path.basename(f) in skip: continue
    parts.append(f'// ===== {os.path.basename(f)} =====\n' + open(f, encoding='utf-8').read())
app = "(function(){'use strict';\n" + '\n'.join(parts) + '\n})();'
stamp = time.strftime('%Y-%m-%d %H:%M')
html = (head.replace('<!--THREE-->', '<script>' + three + '</script>')
            .replace('<!--DATA-->', '\n'.join(blobs))
            .replace('<!--APP-->', '<script>' + app.replace('</script', '<\\/script') + '</script>')
            .replace('__BUILD__', stamp))
os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
out = os.path.join(ROOT, os.environ.get('BAYLINE_OUT', 'dist/index.html')); open(out, 'w', encoding='utf-8').write(html)
print(f'{out}: {len(html)/1e6:.2f} MB ({len(blobs)} data blobs, {len(parts)} code files)')
