#!/usr/bin/env python3
"""Find NAIP exportImage responses with band dropouts: rectangular blocks where a band came back empty (green missing ->
magenta, blue missing -> yellow, red missing -> cyan), a server-side failure of the USGS ImageServer under load; and NIR
responses with dead blocks where the RGB of the same box has data.

  python3 tools/metro_world/naip_dropouts.py [--since EPOCH] [--delete]      -> data/raw/tiles/naip_dropouts.json
  check_rgb_bytes(jpeg bytes) / check_nir_bytes(...)                          (used by tools/tiles/fetch.py to retry)
"""
import io, os, re, sys, json
import numpy as np
from PIL import Image
import concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
RAW = os.path.join(ROOT, 'data', 'raw', 'naip_aar0')
G = 16


def _blocks(im, mode):
    im.draft(mode, (max(64, im.size[0] // 8), max(64, im.size[1] // 8)))
    a = np.asarray(im.convert(mode)).astype(np.float32)
    n = a.shape[0] // G
    a = a[:n * G, :n * G]
    return a.reshape(G, n, G, n, -1) if a.ndim == 3 else a.reshape(G, n, G, n, 1)


def rgb_dropout(im):
    sys.path.insert(0, os.path.join(ROOT, 'tools'))
    from tiles.fetch import rgb_dropout_array
    im.draft('RGB', (max(64, im.size[0] // 8), max(64, im.size[1] // 8)))
    return rgb_dropout_array(np.asarray(im.convert('RGB')).astype(np.float32))


def nir_dropout(nir_im, rgb_im):
    N = _blocks(nir_im, 'L'); R = _blocks(rgb_im, 'RGB')
    nhi = np.percentile(N.transpose(0, 2, 1, 3, 4).reshape(G, G, -1), 98, axis=2)
    rmean = R.mean((1, 3)).max(2)
    return bool(((nhi < 3) & (rmean > 30)).any())


def check_rgb_bytes(b):
    return not rgb_dropout(Image.open(io.BytesIO(b)))


def rgb_for(nir_path):
    """the RGB file of the same box (any size), or None"""
    key = os.path.basename(nir_path).rsplit('_', 2)[0]
    for px in ('2048', '1024', '512'):
        p = os.path.join(RAW, 'rgb', px, f'{key}_{px}_rgb.jpg')
        if os.path.exists(p):
            return p
    return None


def main():
    since = float(sys.argv[sys.argv.index('--since') + 1]) if '--since' in sys.argv else 0
    jobs = []
    for px in os.listdir(os.path.join(RAW, 'rgb')):
        for f in os.listdir(os.path.join(RAW, 'rgb', px)):
            p = os.path.join(RAW, 'rgb', px, f)
            if os.path.getmtime(p) >= since:
                jobs.append(('rgb', p))
    for px in os.listdir(os.path.join(RAW, 'nir')):
        for f in os.listdir(os.path.join(RAW, 'nir', px)):
            p = os.path.join(RAW, 'nir', px, f)
            if os.path.getmtime(p) >= since:
                jobs.append(('nir', p))
    print(len(jobs), 'files to scan', flush=True)

    def one(j):
        kind, p = j
        try:
            if kind == 'rgb':
                return rgb_dropout(Image.open(p))
            r = rgb_for(p)
            return nir_dropout(Image.open(p), Image.open(r)) if r else False
        except Exception:
            return True                                            # unreadable: treat as bad
    bad = []
    with cf.ThreadPoolExecutor(6) as ex:
        for j, r in zip(jobs, ex.map(one, jobs)):
            if r:
                bad.append(j[1])
    print(len(bad), 'with dropouts:', sum('/rgb/' in p for p in bad), 'rgb,', sum('/nir/' in p for p in bad), 'nir', flush=True)
    json.dump(bad, open(os.path.join(ROOT, 'data', 'raw', 'tiles', 'naip_dropouts.json'), 'w'))
    if '--delete' in sys.argv:
        for p in bad:
            os.remove(p)
        print('deleted', len(bad))


if __name__ == '__main__':
    main()
