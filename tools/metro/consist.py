"""Consist length (cars) per trip leg. BART's GTFS carries no train lengths; these rules follow BART's published train
sizing in force from 2026-07-20 and carried into the 10 Aug 2026 schedule (bart.gov news 2026-07-09; research
engineering.json 'consists'):
  Red     10 cars in the weekday peaks, 5 off-peak
  Yellow  9 cars; the 8 busiest AM-peak and 6 busiest PM-peak trains 10
  Green   6 cars; six AM-peak trains toward SF 8
  Blue    6 cars; about five PM-peak trains toward the East Bay 8
  Orange  6 cars; four trains 5 (assumed: the last four of the service day)
Weekend lengths are not published: weekday off-peak lengths are used (Red 5, Yellow 9, others 6). 'Busiest' trains are
approximated by departure time (AM: arrival downtown SF nearest 08:00; PM: departure from downtown SF nearest 17:15).
eBART (DMU): Stadler GTW 2/6 units (40.9 m each; 'cars' = units): 2 in the weekday peaks, 1 otherwise (2008 EIR plan).
Airport connector: 3-car Cable Liner trains."""
import collections

DOC = __doc__.replace('\n', ' ')
AM = (6.0 * 3600, 9.5 * 3600)
PM = (15.5 * 3600, 19.0 * 3600)
DOWNTOWN = {'EMBR', 'MONT', 'POWL', 'CIVC'}


def _time_at(trip_legs, pat, stations):
    """seconds when the trip is at the first of the given stations (arrival), else None"""
    for L, lt in zip(pat['legs'], trip_legs):
        for k, st in enumerate(L['stops']):
            if st['station'] in stations:
                return lt[2 * k]
    return None


def assign(trips, patterns, services):
    """trips: timetable trip dicts (line, dir, pat, svc, legs) -> sets trip['cars'] (list per leg)."""
    kind = {k: v['kind'] for k, v in services.items()}
    pick = collections.defaultdict(set)
    by = collections.defaultdict(list)
    for t in trips:
        if kind.get(t['svc']) != 'weekday':
            continue
        p = patterns[t['pat']]
        tm = _time_at(t['legs'], p, DOWNTOWN)
        if tm is None:
            continue
        tm %= 86400
        by[(t['line'], t['svc'])].append((tm, t))
    for (line, svc), lst in by.items():
        am = sorted([x for x in lst if AM[0] <= x[0] <= AM[1]], key=lambda x: abs(x[0] - 8 * 3600))
        pm = sorted([x for x in lst if PM[0] <= x[0] <= PM[1]], key=lambda x: abs(x[0] - 17.25 * 3600))
        if line == 'yellow':
            pick['long'] |= {id(t) for _, t in [x for x in am if x[1]['dir'] == 1][:8]} | {id(t) for _, t in [x for x in pm if x[1]['dir'] == 0][:6]}
        elif line == 'green':
            pick['long'] |= {id(t) for _, t in [x for x in am if x[1]['dir'] == 1][:6]}
        elif line == 'blue':
            pick['long'] |= {id(t) for _, t in [x for x in pm if x[1]['dir'] == 0][:5]}
    # orange: the last four trips of each service day
    orange = collections.defaultdict(list)
    for t in trips:
        if t['line'] == 'orange':
            orange[t['svc']].append(t)
    for svc, lst in orange.items():
        lst.sort(key=lambda t: t['legs'][0][1] if t['legs'] and t['legs'][0] else 0)
        pick['short'] |= {id(t) for t in lst[-4:]}
    for t in trips:
        p = patterns[t['pat']]
        wk = kind.get(t['svc']) == 'weekday'
        t0 = (t['legs'][0][1] if t['legs'] and t['legs'][0] else 0) % 86400
        peak = wk and (AM[0] <= t0 <= AM[1] or PM[0] <= t0 <= PM[1])
        out = []
        for L in p['legs']:
            if L['vehicle'] == 'dmu':
                out.append(2 if peak else 1)
            elif L['vehicle'] == 'apm':
                out.append(3)
            else:
                ln = t['line']
                if ln == 'red':
                    n = 10 if peak else 5
                elif ln == 'yellow':
                    n = 10 if id(t) in pick['long'] else 9
                elif ln in ('green', 'blue'):
                    n = 8 if id(t) in pick['long'] else 6
                else:
                    n = 5 if id(t) in pick['short'] else 6
                out.append(n)
        t['cars'] = out
