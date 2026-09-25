#!/usr/bin/env python3
"""Full-quality captures of trailer shots (3840x2160: 1920x1080 at device scale 2), one after another, resumable.
   python3 tools/trailer/capture_all.py WORKDIR shot1 shot2 ...   [BASE=http://localhost:8123/lead.html] [DSF=2] [SETTLE=ms] [LOD=f] [QUAL=97] [EDL=cuts.json: capture only the frames its cuts use]
Frames land in WORKDIR/frames/<shot>/; a shot with a .done marker is skipped (delete it to capture again)."""
import os, sys, subprocess, time
W = sys.argv[1]; shots = sys.argv[2:]
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
base = os.environ.get('BASE', 'http://localhost:8123/lead.html'); dsf = os.environ.get('DSF', '2')
# optional quality knobs passed through to capture.mjs: SETTLE (ms per frame), LOD (terrain LOD factor), QUAL (JPEG quality)
extra = sum([[f'--{k.lower()}', os.environ[k]] for k in ('SETTLE', 'LOD', 'QUAL') if os.environ.get(k)], [])
extra = [x.replace('--qual', '--quality') for x in extra]

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
def needed_frames(edl_path):
    """frames each shot needs for the cuts in an EDL (the source time its cuts reach, plus a margin)"""
    import json, re, math
    need = {}
    for c in json.load(open(edl_path))['cuts']:
        dur, ramp = c['dur'], c.get('ramp')
        if ramp:       # integrate the piecewise-linear rate over the cut
            span, n = 0.0, 200
            for i in range(n):
                u = (i + 0.5) * dur / n
                if u <= ramp[0][0]: r = ramp[0][1]
                elif u >= ramp[-1][0]: r = ramp[-1][1]
                else:
                    for (a_, ra), (b_, rb) in zip(ramp, ramp[1:]):
                        if a_ <= u <= b_: r = ra + (rb - ra) * (u - a_) / max(1e-6, b_ - a_); break
                span += r * dur / n
        else: span = dur * c.get('speed', 1.0)
        need[c['shot']] = max(need.get(c['shot'], 0), c['in'] + span + 0.3)
    out = {}
    for shot, t in need.items():
        try: src = open(os.path.join(root, 'tools/trailer/shots', shot + '.mjs')).read()
        except OSError: continue
        m = re.search(r'\bfps:\s*(\d+)', src); fps = int(m.group(1)) if m else 30
        m = re.search(r'\bframes:\s*(\d+)', src); cap = int(m.group(1)) if m else 90
        out[shot] = min(cap, math.ceil(t * fps))
    return out
NEED = needed_frames(os.environ['EDL']) if os.environ.get('EDL') else {}
for s in shots:
    out = os.path.join(W, 'frames', s); done = out + '.done'
    fr = ['--frames', str(NEED[s])] if s in NEED else []
    if os.path.exists(done): print(s, 'already captured', flush=True); continue
    for attempt in (1, 2):                 # one retry: a capture occasionally wedges (it times out and exits)
        subprocess.run(['rm', '-rf', out]); t0 = time.time()
        rc, out_ = run_group(['node', 'tools/capture.mjs', '--shot', f'tools/trailer/shots/{s}.mjs', '--out', out, '--dsf', dsf, '--base', base] + extra + fr, 5400, cwd=root)
        log = out_.strip().splitlines(); ok = rc == 0 and any('done' in l for l in log)
        if ok: break
        print(s, f'attempt {attempt} failed:', ' / '.join(log[-2:])[:200], flush=True)
    n = len([f for f in os.listdir(out) if f.endswith('.jpg')]) if os.path.isdir(out) else 0
    print(f'{s} | {"ok" if ok else "FAILED"} | {n} frames | {time.time() - t0:.0f}s |', ' / '.join(l for l in log if any(w in l for w in ('setup', 'prime', 'rror', 'timeout')))[:300], flush=True)
    if ok: open(done, 'w').write(time.strftime('%Y-%m-%d %H:%M:%S'))
