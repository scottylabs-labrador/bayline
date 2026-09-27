#!/usr/bin/env python3
"""The 1024 px L8 replacement set (after `BAYLINE_SR_STAGE=data/raw/tiles/sr_l8_stage python3 tools/sr_l8.py`):
data/raw/tiles/sr_l8_stage/manifest.json with, for every path of pending_512.json (the L8 tiles published at 512 px),
path, old_sha256 (the 512 px file as published), new_sha256 (the staged 1024 px file), bytes, px; plus a before / after
sheet. Only paths from pending_512.json can be in it; a path whose staged file is missing is reported, not listed.

  python3 tools/metro_world/sr_manifest.py
"""
import hashlib, json, os, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles.common import jpeg_truncated   # noqa: E402
STAGE = os.path.join(ROOT, 'data', 'raw', 'tiles', 'sr_l8_stage')
PUB = os.path.join(ROOT, 'data', 'pub', 'v2')


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def main():
    pend = json.load(open(os.path.join(STAGE, 'pending_512.json')))['files']
    # a 512 px file may since have been replaced by another published set (the truncated-JPEG fixes): its new sha is then
    # the expected old one here
    also = {}
    for other in ('fix_jpeg', 'fix_water'):
        mp = os.path.join(ROOT, 'data', 'raw', 'tiles', other, 'manifest.json')
        if os.path.exists(mp):
            for f in json.load(open(mp))['files']:
                also.setdefault(f['path'], set()).add(f['new_sha256'])
    man, missing, changed, truncated = [], [], [], []
    for r in pend:
        new, old = os.path.join(STAGE, r['path']), os.path.join(PUB, r['path'])
        cur = sha(old)
        if cur != r['sha256'] and cur not in also.get(r['path'], ()):
            changed.append(r['path'])                        # (the local 512 px file changed otherwise: stop)
            continue
        r = dict(r, sha256=cur)
        if not os.path.exists(new):
            missing.append(r['path']); continue
        with Image.open(new) as im:
            im.load(); px = im.size[0]; mode = im.mode; arr = np.asarray(im.convert('RGB'))
        if px != 1024 or mode != 'RGB':
            missing.append(r['path']); continue
        if jpeg_truncated(arr):                               # (truncated encode: removed, tools/sr_l8.py re-makes it)
            os.remove(new); truncated.append(r['path']); continue
        man.append({'path': r['path'], 'old_sha256': r['sha256'], 'new_sha256': sha(new), 'bytes': os.path.getsize(new), 'px': px, 'old_px': r['px']})
    json.dump({'what': 'L8 imagery tiles published at 512 px on the Bayline Metro world publish, replaced by their 1024 px '
                       'Real-ESRGAN versions (tools/sr_l8.py); same paths, nothing else changes',
               'staged_root': 'data/raw/tiles/sr_l8_stage', 'files': man}, open(os.path.join(STAGE, 'manifest.json'), 'w'), indent=1)
    items = man[:: max(1, len(man) // 12)][:12]
    sheet = Image.new('RGB', (max(1, len(items)) * 200, 400))
    for i, m in enumerate(items):
        sheet.paste(Image.open(os.path.join(PUB, m['path'])).convert('RGB').resize((200, 200)), (i * 200, 0))
        sheet.paste(Image.open(os.path.join(STAGE, m['path'])).convert('RGB').resize((200, 200)), (i * 200, 200))
    sheet.save(os.path.join(STAGE, 'before_after.jpg'), quality=82)
    print(f'{len(man)} of {len(pend)} staged ({sum(m["bytes"] for m in man) / 1e6:.1f} MB); missing {len(missing)}; '
          f'local 512 px file changed {len(changed)}; truncated (removed, re-run tools/sr_l8.py) {len(truncated)}',
          missing[:10], changed[:10], truncated[:10], flush=True)


if __name__ == '__main__':
    main()
