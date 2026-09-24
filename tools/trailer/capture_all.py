#!/usr/bin/env python3
"""Full-quality captures of trailer shots (3840x2160: 1920x1080 at device scale 2), one after another, resumable.
   python3 tools/trailer/capture_all.py WORKDIR shot1 shot2 ...   [BASE=http://localhost:8123/lead.html] [DSF=2]
Frames land in WORKDIR/frames/<shot>/; a shot with a .done marker is skipped (delete it to capture again)."""
import os, sys, subprocess, time
W = sys.argv[1]; shots = sys.argv[2:]
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
base = os.environ.get('BASE', 'http://localhost:8123/lead.html'); dsf = os.environ.get('DSF', '2')
for s in shots:
    out = os.path.join(W, 'frames', s); done = out + '.done'
    if os.path.exists(done): print(s, 'already captured', flush=True); continue
    for attempt in (1, 2):                 # one retry: a capture occasionally wedges (it times out and exits)
        subprocess.run(['rm', '-rf', out]); t0 = time.time()
        try:
            r = subprocess.run(['node', 'tools/capture.mjs', '--shot', f'tools/trailer/shots/{s}.mjs', '--out', out, '--dsf', dsf, '--base', base],
                               cwd=root, capture_output=True, text=True, timeout=5400)
            log = (r.stdout + r.stderr).strip().splitlines()
            ok = r.returncode == 0 and any('done' in l for l in log)
        except subprocess.TimeoutExpired:
            log, ok = ['timeout'], False
        if ok: break
        print(s, f'attempt {attempt} failed:', ' / '.join(log[-2:])[:200], flush=True)
    n = len([f for f in os.listdir(out) if f.endswith('.jpg')]) if os.path.isdir(out) else 0
    print(f'{s} | {"ok" if ok else "FAILED"} | {n} frames | {time.time() - t0:.0f}s |', ' / '.join(l for l in log if any(w in l for w in ('setup', 'prime', 'rror', 'timeout')))[:300], flush=True)
    if ok: open(done, 'w').write(time.strftime('%Y-%m-%d %H:%M:%S'))
