#!/usr/bin/env python3
"""Strict JPEG check of imagery tiles: libjpeg-turbo's own warning ('Corrupt JPEG data: premature end of data segment',
the truncated-scan case that Chrome draws wrong) captured per file from OpenCV's decoder. Single-threaded (fd 2 is
redirected around each decode).

  python3 tools/metro_world/scan_corrupt.py new          # files written since the pre-Metro snapshot -> corrupt_new.json
  python3 tools/metro_world/scan_corrupt.py published    # the published (older) files               -> corrupt_published.json
  python3 tools/metro_world/scan_corrupt.py dir <root>   # every .jpg under <root> (e.g. a staging folder)
"""
import json, os, sys
import cv2

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from tiles import common as C   # noqa: E402

REF = os.path.getmtime(os.path.join(C.WORK, 'coverage_pre_bart.json'))


def corrupt(p, rfd, wfd):
    os.dup2(wfd, 2)
    try:
        img = cv2.imread(p, cv2.IMREAD_COLOR)
    finally:
        os.dup2(SAVED, 2)
    msg = b''
    try:
        while True:
            chunk = os.read(rfd, 65536)
            if not chunk:
                break
            msg += chunk
            if len(chunk) < 65536:
                break
    except BlockingIOError:
        pass
    return img is None or b'Corrupt JPEG' in msg or b'Premature' in msg or b'premature' in msg, msg.decode(errors='replace').strip()


SAVED = os.dup(2)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'new'
    files = []
    if mode == 'dir':
        for dp, dn, fn in os.walk(sys.argv[2]):
            files += [os.path.join(dp, f) for f in fn if f.endswith('.jpg')]
    else:
        for L in range(0, 10):
            d = os.path.join(C.PUB, 'img', str(L))
            if not os.path.isdir(d):
                continue
            for f in os.listdir(d):
                if not f.endswith('.jpg') or '_test' in f:
                    continue
                p = os.path.join(d, f); new = os.path.getmtime(p) >= REF
                if (mode == 'new') == new:
                    files.append(p)
    rfd, wfd = os.pipe(); os.set_blocking(rfd, False)
    bad = []
    for i, p in enumerate(sorted(files)):
        c, msg = corrupt(p, rfd, wfd)
        if c:
            bad.append([os.path.relpath(p, C.PUB if mode != 'dir' else sys.argv[2]), msg[:120]])
        if (i + 1) % 2000 == 0:
            print(f'{i + 1}/{len(files)} checked, {len(bad)} corrupt', flush=True)
    out = os.path.join(C.WORK, f'corrupt_{mode}.json')
    json.dump({'checked': len(files), 'corrupt': bad}, open(out, 'w'), indent=1)
    print(f'{len(files)} files checked, {len(bad)} corrupt -> {out}', bad[:20], flush=True)


if __name__ == '__main__':
    main()
