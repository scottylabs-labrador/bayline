"""Consist length (cars) per trip leg. BART's GTFS does not publish train lengths; this is a documented heuristic
(v0), refined from public sources in M2 (notes/bart-data.md, "Consists")."""

DOC = ('cars per leg. EMU (BART heavy rail, D/E cars): weekday peaks (first departure 06:00-09:30 or 15:30-19:00): '
       'Yellow/Red 10, Blue/Green/Orange 8; weekday base: Yellow/Red 8, others 6; weekday evening (>= 20:00) and weekends: '
       'Yellow 8, others 6. DMU (eBART, Stadler FLIRT): 2 cars. APM (airport connector, cable-hauled): 3 cars. Heuristic v0.')


def cars(line, svc, legs_t, pat):
    out = []
    t0 = next((lt[1] for lt in legs_t if lt), 0) % 86400
    weekday = 'Weekday' in svc
    peak = weekday and (6 * 3600 <= t0 < 9.5 * 3600 or 15.5 * 3600 <= t0 < 19 * 3600)
    evening = t0 >= 20 * 3600 or t0 < 5 * 3600
    for leg in pat['legs']:
        v = leg['vehicle']
        if v == 'dmu':
            out.append(2)
        elif v == 'apm':
            out.append(3)
        else:
            big = line in ('yellow', 'red')
            if peak:
                n = 10 if big else 8
            elif weekday and not evening:
                n = 8 if big else 6
            else:
                n = 8 if line == 'yellow' else 6
            out.append(n)
    return out
