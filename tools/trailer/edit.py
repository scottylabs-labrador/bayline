#!/usr/bin/env python3
"""Assemble the trailer: captured frames -> retimed, graded 1080p cuts -> the cut list timed to the music -> titles -> mix.
   python3 tools/trailer/edit.py WORKDIR [--draft | --4k] [--edl other.json]
WORKDIR holds frames/<shot>/f00000.jpg ... (from capture.mjs), titles/*.png, music/arrows.wav, sfx/*.wav. The cut list,
titles and sound design are tools/trailer/edl.json; --draft renders fast (720p, x264) for review.

A cut is {shot, in, dur} plus optional:
  speed   playback rate (1 real time, 0.5 half-speed slow motion); `in` is in the shot's own (simulated) seconds
  ramp    [[t, rate], ...] a speed ramp over the cut's output time (piecewise linear), instead of `speed`
  blur    frames averaged into each output frame (motion blur; a shot captured at 60 fps played in real time has two
          source frames per output frame, so blur 2 = a 360-degree shutter)
  fade_in / fade_out (s), flash (white flash on the cut, 0..1)
  lightning [[t, strength], ...] flickering flashes; shake [[t, px, duration], ...] impact jolts (t from the cut's start)
  vf      extra ffmpeg filters for this cut's grade (e.g. 'eq=brightness=-0.06:saturation=0.85')
  zoom    [z, ax, ay] a z-times closer crop anchored at (ax, ay) (0..1 across the frame), e.g. [1.14, 0.5, 0] loses the bottom;
          zoom_end (and zoom_t [t0, t1]) ease it to another factor over that window: a digital push-in
  lb      letterbox amount 0..1 (only when the EDL sets `letterbox`, the bars' aspect, e.g. 2.2): the bars ease from the
          previous cut's amount over lb_t s (default 0.7) at the start of this cut; cuts default to 1
A title is {png, t0, t1, fade?, style: 'slam' | 'drift' | 'slide'} or {layers: [[png, delay], ...], ...} (revealed in turn).
The EDL may also set name (output base name), music (file in WORKDIR/music), lra (loudness range, default 11) and
letterbox (see lb); without letterbox
the whole picture gets 2.2:1 bars (the first trailer).
The capture rate of each shot comes from its shot module (fps, default 30)."""
import os, sys, subprocess, json, re, glob
import numpy as np
from PIL import Image

W = sys.argv[1]; DRAFT = '--draft' in sys.argv; UHD = '--4k' in sys.argv
FPS = 30
OUT_W, OUT_H = (1280, 720) if DRAFT else (3840, 2160) if UHD else (1920, 1080)
TITLES = 'titles4k' if UHD and os.path.isdir(os.path.join(W, 'titles4k')) else 'titles'   # cards rendered at scale 2 for 4K
HERE = os.path.dirname(os.path.abspath(__file__))
EDL = json.load(open(sys.argv[sys.argv.index('--edl') + 1] if '--edl' in sys.argv else os.path.join(HERE, 'edl.json')))
MUSIC = os.path.join(W, 'music', EDL.get('music', 'arrows.wav'))
NAME = EDL.get('name', 'bayline_trailer'); LB_ASPECT = EDL.get('letterbox')
# grade: a touch more contrast and colour, warm highlights / cool shadows, gentle vignette
GRADE = ('eq=contrast=1.06:saturation=1.10:gamma=0.98,'
         'colorbalance=rs=-0.02:gs=0.0:bs=0.035:rh=0.035:gh=0.01:bh=-0.03,'
         'vignette=angle=PI/5.2:mode=forward')

def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode: print(' '.join(cmd)[:600]); print(r.stderr[-3000:]); sys.exit(1)
    return r

def shot_fps(shot):
    try: src = open(os.path.join(HERE, 'shots', shot + '.mjs')).read()
    except OSError: return 30
    m = re.search(r'\bfps:\s*(\d+)', src); return int(m.group(1)) if m else 30

def source_times(cut):
    """the shot time (s) shown by each output frame of a cut"""
    n = max(1, round(cut['dur'] * FPS)); t, out = cut['in'], []
    ramp = cut.get('ramp')
    for i in range(n):
        out.append(t)
        if ramp:
            u = i / FPS; pts = ramp
            if u <= pts[0][0]: rate = pts[0][1]
            elif u >= pts[-1][0]: rate = pts[-1][1]
            else:
                for (a, ra), (b, rb) in zip(pts, pts[1:]):
                    if a <= u <= b: rate = ra + (rb - ra) * (u - a) / max(1e-6, b - a); break
        else: rate = cut.get('speed', 1.0)
        t += rate / FPS
    return out

_cache = {}
def frame(shot, k):
    """one source frame at output size (float32), with a small LRU"""
    key = (shot, k)
    if key in _cache: return _cache[key]
    files = SRC[shot]; k = max(0, min(len(files) - 1, k))
    im = Image.open(files[k]); im.draft('RGB', (OUT_W, OUT_H)); im = im.convert('RGB')     # DCT scaling: 4K decodes at 1/2 size
    if im.size != (OUT_W, OUT_H): im = im.resize((OUT_W, OUT_H), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float32)
    _cache[key] = a
    if len(_cache) > 24: _cache.pop(next(iter(_cache)))
    return a

SRC = {}
def render_cut(i, cut):
    """one cut -> a graded intermediate clip (cached by its parameters)"""
    shot = cut['shot']
    if shot not in SRC: SRC[shot] = sorted(glob.glob(os.path.join(W, 'frames', shot, 'f*.jpg')))
    if not SRC[shot]: print('no frames for', shot); sys.exit(1)
    fc = shot_fps(shot); blur = int(cut.get('blur', 1))
    sig = json.dumps([cut, OUT_H, fc, len(SRC[shot]), os.path.getmtime(SRC[shot][-1])], sort_keys=True)
    dst = os.path.join(W, 'cuts', f'{i:02d}_{shot}_{OUT_H}.mov'); sigf = dst + '.sig'
    if os.path.exists(dst) and os.path.exists(sigf) and open(sigf).read() == sig: return dst
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    codec = (['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p'] if DRAFT else
             ['-c:v', 'libx264', '-preset', 'fast', '-crf', '11', '-pix_fmt', 'yuv420p'] if UHD else      # near-lossless (4K ProRes would be ~13 GB)
             ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'])
    p = subprocess.Popen(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{OUT_W}x{OUT_H}', '-r', str(FPS), '-i', '-',
                          '-vf', GRADE + (',' + cut['vf'] if cut.get('vf') else ''), *codec, dst], stdin=subprocess.PIPE)
    bolts, shakes = cut.get('lightning', []), cut.get('shake', [])
    rng = np.random.default_rng(i)
    for fi, t in enumerate(source_times(cut)):
        k0 = t * fc
        if blur <= 1: img = frame(shot, int(round(k0)))
        else:   # average `blur` consecutive source frames centred on the sample time (linear light would be purer; sRGB is fine here)
            ks = [int(round(k0 - (blur - 1) / 2 + j)) for j in range(blur)]
            img = sum(frame(shot, k) for k in ks) / blur
        u = fi / FPS
        if cut.get('zoom'):      # [z, ax, ay]: a z-times closer crop anchored at (ax, ay) in 0..1, e.g. to lose an edge;
            z, ax, ay = cut['zoom']  # with zoom_end the crop eases to zoom_end over zoom_t = [t0, t1] (s into the cut): a push-in
            if 'zoom_end' in cut:
                za, zb = cut.get('zoom_t', [0, cut['dur']]); e = min(1.0, max(0.0, (u - za) / max(1e-6, zb - za))); e = e * e * (3 - 2 * e)
                z = z + (cut['zoom_end'] - z) * e
            cw, ch = OUT_W / z, OUT_H / z; x0, y0 = (OUT_W - cw) * ax, (OUT_H - ch) * ay
            img = np.asarray(Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).resize((OUT_W, OUT_H), Image.LANCZOS, box=(x0, y0, x0 + cw, y0 + ch)), np.float32)
        # lightning: [[t, strength], ...] a double flicker (flash, dip, second flash, decay), cold white
        L = 0.0
        for tb, st in bolts:
            v = u - tb
            if 0 <= v < 0.6: L = max(L, st * (1.0 if v < 0.05 else 0.25 if v < 0.1 else 0.8 if v < 0.16 else 0.8 * np.exp(-(v - 0.16) / 0.12)))
        if L > 0: img = img * (1 + 0.55 * L) + np.array([190.0, 200.0, 255.0], np.float32) * 0.3 * L
        # shake: [[t, amplitude px, duration], ...] an impact jolt, decaying
        for ts, amp, dur in shakes:
            v = u - ts
            if 0 <= v < dur:
                a = amp * (1 - v / dur) ** 2 * (OUT_H / 1080); dx, dy = rng.uniform(-a, a, 2)
                im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)); z = 1 + 2.2 * a / OUT_H
                im = im.resize((round(OUT_W * z), round(OUT_H * z)), Image.BILINEAR)
                ox, oy = (im.width - OUT_W) / 2 + dx, (im.height - OUT_H) / 2 + dy
                img = np.asarray(im.crop((round(ox), round(oy), round(ox) + OUT_W, round(oy) + OUT_H)), np.float32)
        if LB_ASPECT:      # per-cut letterbox: ease from the previous cut's amount at the start of this cut
            a0, a1, lt = cut.get('_lb_from', cut.get('lb', 1)), cut.get('lb', 1), cut.get('lb_t', 0.7)
            e = min(1.0, u / lt) if lt > 0 else 1.0; e = e * e * (3 - 2 * e); amt = a0 + (a1 - a0) * e
            bar = int(round(amt * OUT_H * (1 - (OUT_W / LB_ASPECT) / OUT_H) / 2))
            if bar > 0: img = img.copy(); img[:bar] = 0; img[-bar:] = 0
        p.stdin.write(np.clip(img + 0.5, 0, 255).astype(np.uint8).tobytes())
    p.stdin.close(); p.wait()
    if p.returncode: print('ffmpeg failed on cut', i, shot); sys.exit(1)
    open(sigf, 'w').write(sig)
    return dst

def ease_out(k): k = min(1.0, max(0.0, k)); return 1 - (1 - k) ** 3

def animate_title(j, ti):
    """a title card -> an RGBA frame sequence at output size: 'slam' (fast scale-down punch) or 'drift' (slow push);
    `layers` [[png, delay], ...] reveal one after another (the end card)"""
    style = ti.get('style', 'drift'); t0, t1 = ti['t0'], ti['t1']; fd = ti.get('fade', 0.18)
    layers = ti.get('layers') or [[ti['png'], 0.0]]
    imgs = [(Image.open(os.path.join(W, TITLES, png)).convert('RGBA').resize((OUT_W, OUT_H), Image.LANCZOS), dl) for png, dl in layers]
    sig = json.dumps([ti, OUT_H, [os.path.getmtime(os.path.join(W, TITLES, png)) for png, _ in layers]], sort_keys=True)
    d = os.path.join(W, 'titles_anim', f'{j:02d}_{OUT_H}'); sigf = d + '.sig'
    n = max(1, round((t1 - t0) * FPS))
    if os.path.isdir(d) and os.path.exists(sigf) and open(sigf).read() == sig: return d, n
    if os.path.isdir(d):         # a stale set (e.g. titles renumbered): old frames past this title's length would play on
        import shutil; shutil.rmtree(d)
    os.makedirs(d, exist_ok=True)
    for i in range(n):
        u = i / FPS; frame_ = Image.new('RGBA', (OUT_W, OUT_H), (0, 0, 0, 0))
        for im, dl in imgs:
            v = u - dl
            if v < 0: continue
            dx = 0
            if style == 'slam': sc = 1.10 - 0.10 * ease_out(v / 0.2) - 0.015 * min(1, v / max(0.3, t1 - t0)); a = min(1, v / 0.06)
            elif style == 'slide': sc = 1.0; a = min(1, v / 0.35); dx = round(-70 * (1 - ease_out(v / 0.6)) * OUT_W / 1920)
            else: sc = 1.03 - 0.03 * ease_out(v / max(0.8, t1 - t0 - dl)); a = min(1, v / fd)
            a = min(a, max(0.0, (t1 - t0 - u) / fd))
            if a <= 0: continue
            w, h = round(OUT_W * sc), round(OUT_H * sc); lay = im.resize((w, h), Image.BICUBIC)
            lay = lay.crop(((w - OUT_W) // 2, (h - OUT_H) // 2, (w - OUT_W) // 2 + OUT_W, (h - OUT_H) // 2 + OUT_H)) if sc >= 1 else lay
            if a < 1: al = lay.getchannel('A').point(lambda x: int(x * a)); lay.putalpha(al)
            if dx: frame_.alpha_composite(lay.crop((max(0, -dx), 0, OUT_W, OUT_H)) if dx < 0 else lay, (max(0, dx), 0))
            elif sc >= 1: frame_.alpha_composite(lay)
            else: frame_.alpha_composite(lay, ((OUT_W - w) // 2, (OUT_H - h) // 2))
        frame_.save(os.path.join(d, f'{i:04d}.png'), compress_level=1)
    open(sigf, 'w').write(sig)
    return d, n

def render_cut_job(a):
    i, cut = a; return render_cut(i, cut)

def main():
    from concurrent.futures import ProcessPoolExecutor
    jobs = os.cpu_count() // 2 or 2
    if LB_ASPECT:
        prev = EDL['cuts'][0].get('lb', 1)
        for c in EDL['cuts']: c['_lb_from'] = prev; prev = c.get('lb', 1)
    if '--cuts-only' in sys.argv:        # pre-render the cuts whose shots are fully captured, nothing else
        done = lambda sh: os.path.exists(os.path.join(W, 'frames', sh + '.done')) and os.path.isdir(os.path.join(W, 'frames', sh)) and os.listdir(os.path.join(W, 'frames', sh))
        ready = [(i, c) for i, c in enumerate(EDL['cuts']) if done(c['shot'])]
        with ProcessPoolExecutor(jobs) as ex: list(ex.map(render_cut_job, ready))
        print(f'pre-rendered {len(ready)} of {len(EDL["cuts"])} cuts'); return
    if LB_ASPECT:
        prev = EDL['cuts'][0].get('lb', 1)
        for c in EDL['cuts']: c['_lb_from'] = prev; prev = c.get('lb', 1)
    with ProcessPoolExecutor(jobs) as ex:
        clips = list(ex.map(render_cut_job, list(enumerate(EDL['cuts']))))
        titles = list(ex.map(animate_title, range(len(EDL['titles'])), EDL['titles']))
    segs, total = [], 0.0
    for clip, cut in zip(clips, EDL['cuts']):
        segs.append((clip, cut['dur'], cut.get('fade_in', 0), cut.get('fade_out', 0), cut.get('flash', 0))); total += cut['dur']
    print(f'cuts: {len(segs)}, picture {total:.2f} s', flush=True)
    # 1. picture: fades, flashes, concat
    inputs, filt, labels = [], [], []
    for i, (clip, d, fi, fo, fl) in enumerate(segs):
        inputs += ['-i', clip]
        f = f'[{i}:v]trim=duration={d:.4f},setpts=PTS-STARTPTS,fps={FPS}'
        if fi: f += f',fade=t=in:st=0:d={fi}'
        if fo: f += f',fade=t=out:st={d - fo:.4f}:d={fo}'
        if fl: f += f",eq=brightness='{0.35 * fl}*max(0,1-t/0.18)':eval=frame"
        f += f',setsar=1[v{i}]'; filt.append(f); labels.append(f'[v{i}]')
    filt.append(''.join(labels) + f'concat=n={len(segs)}:v=1:a=0[pic]')
    # 2. letterbox (2.2:1) on the picture
    if LB_ASPECT: filt.append('[pic]null[lb]')          # (bars already drawn per cut)
    else:
        bar = round(OUT_H * (1 - (OUT_W / 2.2) / OUT_H) / 2)
        filt.append(f"[pic]drawbox=x=0:y=0:w=iw:h={bar}:color=black:t=fill,drawbox=x=0:y=ih-{bar}:w=iw:h={bar}:color=black:t=fill[lb]")
    # 3. animated titles over it, then the final fade to black
    last = 'lb'
    for j, (ti, (d, n)) in enumerate(zip(EDL['titles'], titles)):
        k = sum(1 for x in inputs if x == '-i')
        inputs += ['-framerate', str(FPS), '-i', os.path.join(d, '%04d.png')]
        filt.append(f"[{k}:v]format=rgba,setpts=PTS-STARTPTS+{ti['t0']:.4f}/TB[t{j}]")
        filt.append(f"[{last}][t{j}]overlay=0:0:eof_action=pass:format=auto[o{j}]"); last = f'o{j}'
    filt.append(f"[{last}]fade=t=out:st={total - 1.6:.3f}:d=1.6,format=yuv420p[vout]")     # (no synthetic grain: it costs 5x the bitrate)
    base = os.path.join(W, NAME + ('_draft' if DRAFT else '_4k' if UHD else ''))
    open(base + '.vf.txt', 'w').write(';'.join(filt))
    venc = ['-c:v', 'libx264', '-preset', 'veryfast' if DRAFT else 'slow', '-crf', '22' if DRAFT else '17' if UHD else '16', '-profile:v', 'high', '-pix_fmt', 'yuv420p']
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', *inputs, '-filter_complex_script', base + '.vf.txt', '-map', '[vout]', *venc, '-t', f'{total:.3f}', base + '.video.mp4'])
    print('picture done', flush=True)
    # 4. sound: the music plus designed effects, then loudness-normalised (two passes) to -14 LUFS, -1 dBTP
    ain = ['-i', MUSIC]; afilt = [f"[0:a]atrim=0:{total + 0.05:.3f},afade=t=out:st={total - 3.5:.3f}:d=3.5[mus]"]; mix = ['[mus]']
    for s_i, fx in enumerate(EDL['sfx']):
        ain += ['-i', os.path.join(W, 'sfx', fx['wav'])]; k = 1 + s_i; d = fx.get('dur', 6); off = fx.get('from', 0)
        afilt.append(f"[{k}:a]atrim=start={off:.3f}:duration={d:.3f},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:d={fx.get('fin', 0.05)},"
                     f"afade=t=out:st={max(0.1, d - fx.get('fout', 0.8)):.3f}:d={fx.get('fout', 0.8)},volume={fx.get('gain', 0.5)},adelay={int(fx['at'] * 1000)}|{int(fx['at'] * 1000)}[s{s_i}]")
        mix.append(f'[s{s_i}]')
    afilt.append(''.join(mix) + f'amix=inputs={len(mix)}:normalize=0:duration=first,alimiter=limit=0.97:level=false[aout]')
    open(base + '.af.txt', 'w').write(';'.join(afilt))
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', *ain, '-filter_complex_script', base + '.af.txt', '-map', '[aout]', '-t', f'{total:.3f}', '-c:a', 'pcm_s24le', '-ar', '48000', base + '.mix.wav'])
    LN = f"loudnorm=I=-14:TP=-1.0:LRA={EDL.get('lra', 11)}"      # (lra 20: keep the music's dynamics, so the drops still hit)
    r = run(['ffmpeg', '-hide_banner', '-i', base + '.mix.wav', '-af', LN + ':print_format=json', '-f', 'null', '-'])
    m = json.loads(r.stderr[r.stderr.rindex('{'):r.stderr.rindex('}') + 1])
    ln2 = (f"{LN}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}"
           f":offset={m['target_offset']}:linear=true,aresample=48000")
    print(f"loudness in {m['input_i']} LUFS / {m['input_tp']} dBTP -> -14 LUFS", flush=True)
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', base + '.mix.wav', '-af', ln2, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', base + '.audio.m4a'])
    out = base + '.mp4'
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', base + '.video.mp4', '-i', base + '.audio.m4a', '-map', '0:v', '-map', '1:a', '-c', 'copy', '-shortest', '-movflags', '+faststart', out])
    print('wrote', out)

if __name__ == '__main__':
    main()
