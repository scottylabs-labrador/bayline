#!/usr/bin/env python3
"""Promote a staged bake (data/pub/v2/metro-next/) to the live data/pub/v2/metro/: the content-addressed binary first,
then network.json (its tracksBin.path rewritten to metro/), timetable.json and validation.json, each via an atomic
rename, so a client never sees a network.json that names a missing binary. Old hashed binaries are kept (48 h rule in
common.write_hashed).

    python3 tools/metro/promote.py [--from data/pub/v2/metro-next] [--to data/pub/v2/metro]
"""
import json, os, shutil, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
a = sys.argv
src = a[a.index('--from') + 1] if '--from' in a else os.path.join(ROOT, 'data/pub/v2/metro-next')
dst = a[a.index('--to') + 1] if '--to' in a else os.path.join(ROOT, 'data/pub/v2/metro')
net = json.load(open(os.path.join(src, 'network.json')))
bin_name = os.path.basename(net['tracksBin']['path'])
dst_dir = os.path.basename(dst.rstrip('/'))


def put(name, data=None):
    tmp = os.path.join(dst, name + '.tmp')
    if data is None:
        shutil.copyfile(os.path.join(src, name), tmp)
    else:
        open(tmp, 'w').write(data)
    os.replace(tmp, os.path.join(dst, name))


os.makedirs(dst, exist_ok=True)
put(bin_name)
put('tracks.bin', None) if os.path.exists(os.path.join(src, 'tracks.bin')) else None
net['tracksBin']['path'] = f'{dst_dir}/{bin_name}'
put('network.json', json.dumps(net, separators=(',', ':')))
for f in ('timetable.json', 'validation.json'):
    if os.path.exists(os.path.join(src, f)):
        put(f)
print(f'promoted {src} -> {dst} (binary {bin_name}, network {os.path.getsize(os.path.join(dst, "network.json")) / 1e6:.2f} MB)')
