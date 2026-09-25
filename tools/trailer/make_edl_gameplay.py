#!/usr/bin/env python3
"""The gameplay video's edit decision list, timed to "Fate of the World" (115 bpm; beat n at 0.505 + 0.5218 n s), with
4 bars repeated at 62.07 s for the map scene (tools/trailer/extend_music.py writes WORKDIR/music/fate_ext.wav + .txt).
   python3 tools/trailer/make_edl_gameplay.py WORKDIR      -> tools/trailer/edl_gameplay.json"""
import json, os, sys
B0, P = 0.505, 0.5218
b0 = lambda n: B0 + P * n
INS_AT, INS = [float(v) for v in open(os.path.join(sys.argv[1], 'music', 'fate_ext.txt')).read().split()]
# the music has 4 bars repeated at INS_AT (the map scene): beat n from 118 on, and any time after INS_AT, is INS later
b = lambda n: round(b0(n) + (INS if n >= 118 else 0), 3)
sh = lambda t: round(t + (INS if t >= INS_AT - 0.01 else 0), 3)
MAP0 = round(b0(118), 3)                      # the map scene: the inserted 4 bars
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# (shot, start, end, in, extra)  -- start/end in output seconds
C = [
  # cold open: dawn (letterboxed)
  ('g_dawn_hills',       0.00,   b(9),   0.3, dict(lb=1, fade_in=1.6)),
  ('g_bay_dawn',         b(9),   b(17),  1.0, dict(lb=1)),
  ('g_platform_morning', b(17),  b(24),  4.8, dict(lb=1)),
  # rail: the bars open for gameplay
  ('g_board',            b(24),  b(30),  0.3, dict(lb=0, lb_t=0.8)),
  ('g_arrival',          b(30),  b(38),  3.2, dict(lb=0)),
  ('g_drive_depart',     b(38),  b(46),  2.4, dict(lb=0)),
  ('g_drone_train',      b(46),  b(52),  2.0, dict(lb=0)),
  ('g_trackside',        b(52),  b(60),  1.3, dict(lb=0, speed=0.35)),
  ('g_drive_speed',      b(60),  b(68),  0.5, dict(lb=0)),
  ('g_drive_stop',       b(68),  39.30,  1.0, dict(lb=0)),
  # the lift-off: cockpit, title, the breath before the drop
  ('g_lineup',           39.30,  b(82),  0.4, dict(lb=0, fade_out=0.9, flash=0.35)),
  # DROP (43.29): flight
  ('g_takeoff_744',      b(82),  b(90),  3.9, dict(lb=0, speed=0.6, shake=[[0.0, 7, 0.6]])),
  ('g_gear_up',          b(90),  b(98),  0.2, dict(lb=0, speed=0.9)),
  ('g_fly_hud',          b(98),  b(102), 0.5, dict(lb=0)),
  ('f16_chase',          b(102), b(106), 1.0, dict(lb=0)),
  ('heli_skyline',       b(106), b(110), 2.0, dict(lb=0)),
  ('traffic_sfo',        b(110), MAP0,   1.0, dict(lb=0)),
  ('g_map',              MAP0,   b(118), 0.0, dict(lb=0, zoom=[1.0, 0.5, 0.49], zoom_end=1.3, zoom_t=[1.9, 8.3])),
  ('concorde_mach2',     b(118), b(122), 2.0, dict(lb=0)),
  ('storm_night',        b(122), b(126), 1.0, dict(lb=0, lightning=[[0.35, 1.0], [1.35, 0.6]], vf='eq=brightness=-0.05:contrast=1.12:saturation=0.85')),
  ('storm_cockpit',      b(126), b(130), 1.0, dict(lb=0, lightning=[[0.9, 0.8]], vf='eq=brightness=-0.06:contrast=1.1:saturation=0.8')),
  ('gg_fog',             b(130), b(134), 2.0, dict(lb=0)),
  ('g_under_gg',         b(134), b(138), 6.0, dict(lb=0, speed=0.7, zoom=[1.14, 0.5, 0.0])),
  ('g_a380_final',       b(138), b(142), 2.0, dict(lb=0)),
  ('g_touchdown_744',    b(142), b(148), 5.0, dict(lb=0, speed=0.8)),
  # LIFT (77.73): the world, golden hour to night (letterboxed again)
  ('g_hills_gold',       b(148), b(156), 1.5, dict(lb=1, lb_t=0.6, flash=0.3)),
  ('g_pa_golden',        b(156), b(160), 2.0, dict(lb=1)),
  ('g_street_sunset',    b(160), b(164), 2.5, dict(lb=1)),
  ('g_night_fly',        b(164), b(168), 2.0, dict(lb=1)),
  ('g_bay_night',        b(168), b(176), 2.0, dict(lb=1)),
  ('night_train',        b(176), b(180), 2.5, dict(lb=1)),
  ('salesforce_night',   b(180), sh(96.52),  2.0, dict(lb=1, fade_out=0.25)),
  ('black',              sh(96.52), sh(97.56),  0.0, dict(lb=1)),
  # FINAL HIT (97.56): rail and flight in one frame
  ('g_finale',           sh(97.56), b(196), 1.0, dict(lb=1, ramp=[[0, 1.0], [0.9, 1.0], [1.4, 0.45], [4.2, 0.45], [4.9, 0.9]], shake=[[2.9, 5, 0.9]])),
  # outro: the end card over blue hour
  ('g_end_bg',           b(196), sh(113.0),  0.5, dict(lb=1)),
]
cuts = []
for shot, t0, t1, tin, x in C:
    c = {'shot': shot, 'in': tin, 'dur': round(t1 - t0, 3)}; c.update(x); cuts.append(c)
T = lambda png, t0, t1, style='drift', fade=0.3: {'png': png + '.png', 't0': round(t0, 3), 't1': round(t1, 3), 'style': style, 'fade': fade}
titles = [
  T('kicker_open', 1.9, 5.0, 'drift', 0.5),
  T('lt_timetable', b(30) + 0.35, b(38) - 0.25, 'drift', 0.3),
  T('t_line', b(38) + 0.25, b(44), 'drift', 0.3),
  T('lt_drive', b(46) + 0.25, b(52) - 0.15, 'drift', 0.3),
  T('t_sky', 39.55, 42.55, 'drift', 0.35),
  T('logo_drop', b(82), b(89) - 0.1, 'slam', 0.35),
  T('lt_fly', b(90) + 0.3, b(98) - 0.25, 'drift', 0.3),
  T('lt_traffic', b(110) + 0.3, MAP0 - 0.25, 'drift', 0.3),
  T('lt_map', MAP0 + 2.3, MAP0 + 7.9, 'drift', 0.3),
  T('lt_weather', b(122) + 0.2, b(130) - 0.25, 'drift', 0.3),
  T('lt_world', b(148) + 0.35, b(156) - 0.25, 'drift', 0.3),
  T('lt_night', b(164) + 0.3, b(172) - 0.25, 'drift', 0.3),
  T('t_alive', sh(95.95), sh(97.50), 'drift', 0.25),
  {'layers': [['endcard_logo.png', 0.0], ['endcard_tag.png', 0.9], ['endcard_url.png', 1.9], ['endcard_fine.png', 2.9]], 't0': sh(103.3), 't1': sh(113.0), 'fade': 0.8, 'style': 'drift'},
]
S = lambda wav, at, frm, dur, gain, fin=0.05, fout=0.8: {'wav': wav, 'at': round(at, 3), 'from': frm, 'dur': dur, 'gain': gain, 'fin': fin, 'fout': fout}
sfx = [
  S('birds.wav', 0.0, 4.0, 13.8, 0.22, 2.5, 2.5),
  S('wind_high.wav', 0.0, 20.0, 13.5, 0.35, 3.0, 2.5),
  S('horn_pass.wav', b(30) + 0.2, 12.93, 4.6, 0.35, 0.25, 1.4),
  S('doors.wav', b(38) + 0.1, 2.6, 4.2, 0.55, 0.1, 0.6),
  S('train_pass.wav', b(52) - 0.2, 3.9, 4.6, 0.55, 0.3, 1.2),
  S('riser.wav', 36.32, 0.0, 2.98, 0.45, 0.8, 0.05),
  S('impact.wav', 39.30, 0.0, 3.2, 0.5, 0.02, 1.4),
  S('takeoff.wav', 39.9, 20.0, 2.6, 0.28, 0.6, 0.6),
  S('boom_deep.wav', b(82) - 0.02, 0.0, 2.8, 0.55),
  S('takeoff.wav', b(82), 29.5, 7.5, 0.55, 0.15, 1.2),
  S('whoosh.wav', b(102) - 1.3, 0.0, 2.2, 0.35),
  S('jet_pass.wav', b(102) - 0.4, 6.8, 3.2, 0.45, 0.3, 0.9),
  S('heli.wav', b(106), 8.0, 2.6, 0.3, 0.3, 0.7),
  S('whoosh.wav', MAP0 + 1.5 - 1.46, 0.0, 2.2, 0.25),
  S('rain.wav', b(122), 10.0, 8.4, 0.3, 0.4, 1.2),
  S('thunder.wav', b(122) + 0.3, 0.0, 5.0, 0.55, 0.02, 1.5),
  S('landing.wav', b(138), 29.0, 10.0, 0.5, 0.5, 1.0),
  S('whoosh.wav', b(148) - 1.4, 0.0, 2.2, 0.35),
  S('boom_rumble.wav', b(148) - 0.05, 0.0, 5.3, 0.6),
  S('wind_high.wav', b(148), 30.0, 8.0, 0.3, 1.0, 2.0),
  S('whoosh.wav', sh(95.3), 0.0, 2.2, 0.3),
  S('impact.wav', sh(97.56), 0.0, 5.0, 0.6, 0.02, 2.0),
  S('boom_rumble.wav', sh(97.50), 0.0, 5.3, 0.5),
  S('train_pass.wav', sh(97.9), 4.5, 3.8, 0.5, 0.2, 1.4),
  S('takeoff.wav', sh(99.0), 31.0, 5.0, 0.55, 0.5, 1.6),
  S('wind_high.wav', b(196), 4.0, 10.2, 0.6, 2.5, 3.0),
]
edl = {'name': 'bayline_gameplay', 'music': 'fate_ext.wav', 'letterbox': 2.2, 'lra': 20, 'cuts': cuts, 'titles': titles, 'sfx': sfx}
json.dump(edl, open(os.path.join(ROOT, 'tools/trailer/edl_gameplay.json'), 'w'), indent=1)
tot = sum(c['dur'] for c in cuts); print(f'{len(cuts)} cuts, {tot:.2f} s, {len(titles)} titles, {len(sfx)} sfx')
