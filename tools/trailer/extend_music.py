#!/usr/bin/env python3
"""Lengthen a music track by repeating a bar-aligned passage: the audio from t1 to t2 (two downbeats, a whole number of
bars apart) plays twice, the repeat starting at t2, with 6 ms crossfades at both joins so the splices don't click.
   python3 tools/trailer/extend_music.py in.wav out.wav T1 T2      (writes out.wav and out.txt: "insert-at length" in s)
The gameplay video: fate.wav, 53.719 62.079 (4 bars of the driving section, for the map scene)."""
import subprocess, sys, numpy as np
src, dst, t1, t2 = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
SR, pre = 48000, 0.006                               # cut just before the downbeat transients
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
x = np.frombuffer(raw, np.float32).reshape(-1, 2)
B = int(round((t2 - pre) * SR)); L = int(round((t2 - t1) * SR)); A = B - L
xf = int(0.006 * SR); up = np.sin(np.linspace(0, np.pi / 2, xf))[:, None] ** 2; dn = 1 - up
seg = x[A:B]; out = np.concatenate([x[:B], seg, x[B:]])
out[B:B + xf] = x[B:B + xf] * dn + seg[:xf] * up                  # into the repeat
out[B + L:B + L + xf] = x[A:A + xf] * dn + x[B:B + xf] * up        # out of it, back into the original
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-i', '-', '-c:a', 'pcm_s24le', dst], input=out.astype(np.float32).tobytes(), check=True)
open(dst.rsplit('.', 1)[0] + '.txt', 'w').write(f'{B / SR:.4f} {L / SR:.4f}\n')
print(f'{src}: {len(x) / SR:.3f} s -> {dst}: {len(out) / SR:.3f} s (+{L / SR:.3f} s at {B / SR:.3f} s)')
