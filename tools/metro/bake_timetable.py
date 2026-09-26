#!/usr/bin/env python3
"""Bayline Metro timetable bake: BART GTFS -> data/pub/v2/metro/timetable.json (needs network.json for the patterns).

Every trip of every service day in the feed (weekday / Saturday / Sunday variants and the calendar_dates
exceptions), times in seconds after the service day's midnight (after-midnight times stay > 86400), the network
pattern it follows (network.json patterns[].id) and per-leg stop times aligned with that pattern's legs[].stops.
Yellow Line trips through Antioch are split into the eBART DMU leg and the BART EMU leg at the Pittsburg/Bay Point
transfer platform (PITT-T), with the transfer times documented in notes/bart-data.md. Consist lengths: consist.py.
"""
import collections, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from metro.common import PUB, gtfs, tsec, write_json, log
from metro import consist as CS

LINES = {'1': ('yellow', 1), '2': ('yellow', 0), '3': ('orange', 0), '4': ('orange', 1), '5': ('green', 1), '6': ('green', 0),
         '7': ('red', 1), '8': ('red', 0), '11': ('blue', 1), '12': ('blue', 0), '19': ('grey', 0), '20': ('grey', 1)}
XFER_EMU = 120        # s: EMU between the transfer platform (PITT-T) and Pittsburg/Bay Point station
XFER_DMU = 180        # s: cross-platform transfer allowance at PITT-T (shrinks to XFER_MIN when the GTFS times are tight)
XFER_MIN = 60         # s: shortest cross-platform transfer
DMU_RUN = 240        # s: shortest DMU run Pittsburg Center <-> transfer platform (3.9 km; research: ~3 min)


def main():
    net = json.load(open(os.path.join(PUB, 'network.json')))
    pat_by_key = {(p['route'], tuple(p['gtfs'])): p for p in net['patterns']}
    feed = gtfs('feed_info.txt')[0]
    cal = gtfs('calendar.txt')
    cald = gtfs('calendar_dates.txt')
    attrs = {r['service_id']: r['service_description'] for r in gtfs('calendar_attributes.txt')}
    services = {}
    for c in cal:
        days = [int(c[d]) for d in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')]
        services[c['service_id']] = dict(kind=(attrs.get(c['service_id']) or '').lower() or ('weekday' if days[0] else 'saturday' if days[5] else 'sunday'),
                                         days=days, start=c['start_date'], end=c['end_date'], add=[], remove=[])
    for r in cald:
        s = services.setdefault(r['service_id'], dict(kind='special', days=[0] * 7, start=r['date'], end=r['date'], add=[], remove=[]))
        (s['add'] if r['exception_type'] == '1' else s['remove']).append(r['date'])
    trips = gtfs('trips.txt')
    rows = collections.defaultdict(list)
    for r in gtfs('stop_times.txt'):
        rows[r['trip_id']].append(r)
    routes = {r['route_id']: r for r in gtfs('routes.txt')}
    out = []
    buses = []
    miss = collections.Counter()
    for t in trips:
        rr = sorted(rows[t['trip_id']], key=lambda r: int(r['stop_sequence']))
        seq = tuple(r['stop_id'] for r in rr)
        times = [(tsec(r['arrival_time']), tsec(r['departure_time'])) for r in rr]
        if t['route_id'] not in LINES:
            buses.append(dict(id=t['trip_id'], svc=t['service_id'], route=routes[t['route_id']]['route_short_name'], head=t['trip_headsign'],
                              stops=[r['stop_id'] for r in rr], t=[v for ad in times for v in ad]))
            continue
        p = pat_by_key.get((t['route_id'], seq))
        if p is None:
            miss[t['route_id']] += 1
            continue
        line, dirn = LINES[t['route_id']]
        # align GTFS times with the pattern legs' stops (which add PITT-T and repeat reversal stations once)
        legs_t = []
        gi = 0                                # index into GTFS rows
        for li, leg in enumerate(p['legs']):
            lt = []
            for k, st in enumerate(leg['stops']):
                if st['station'] == 'PITT-T':
                    if leg['sys'] == 'ebart':
                        if k == 0:            # DMU departs the transfer after the EMU from SF arrives there
                            arr_pitt = times[gi - 1][0] if gi > 0 else times[gi][0]
                            emu_arr = arr_pitt + XFER_EMU
                            nxt = times[gi][0]                     # its arrival at Pittsburg Center
                            dep = max(emu_arr + XFER_MIN, min(emu_arr + XFER_DMU, nxt - DMU_RUN))
                            lt += [dep, dep]
                        else:                 # DMU arrives at the transfer before the EMU leaves it
                            arr_pitt = times[gi][0]
                            emu_dep = arr_pitt - XFER_EMU
                            prev_dep = lt[-1] if lt else emu_dep - 600   # its departure from Pittsburg Center
                            a = min(emu_dep - XFER_MIN, max(emu_dep - XFER_DMU, prev_dep + DMU_RUN))
                            lt += [a, a]
                    else:
                        if k == 0:            # EMU departs the transfer platform
                            a = times[gi][0] - XFER_EMU
                            lt += [a - 60, a]
                        else:                 # EMU arrives at the transfer platform after Pittsburg/Bay Point
                            a = times[gi - 1][1] + XFER_EMU
                            lt += [a, a + 60]
                    continue
                # reversal stations appear twice in GTFS (arrive, depart): merge
                a, d = times[gi]
                if st.get('reverse') and gi + 1 < len(seq) and seq[gi + 1] == seq[gi]:
                    d = times[gi + 1][1]
                    gi += 1
                lt += [a, d]
                gi += 1
            legs_t.append(lt)
        out.append(dict(id=t['trip_id'], svc=t['service_id'], line=line, dir=dirn, pat=p['id'], head=t['trip_headsign'], cars=None, legs=legs_t))
    if miss:
        log('trips without a pattern path:', dict(miss))
    CS.assign(out, {p['id']: p for p in net['patterns']}, services)
    out.sort(key=lambda r: (r['svc'], r['legs'][0][1] if r['legs'] and r['legs'][0] else 0))
    tt = dict(version=0, format='bayline-metro-timetable', generated=__import__('time').strftime('%Y-%m-%dT%H:%M:%S'),
              feed=dict(publisher=feed['feed_publisher_name'], version=feed['feed_version'], start=feed['feed_start_date'], end=feed['feed_end_date'],
                        file='google_transit_20260810-20270108_v02.zip', calendarStart=min(s['start'] for s in services.values()),
                        calendarEnd=max(s['end'] for s in services.values()), timezone='America/Los_Angeles',
                        license='BART developer license agreement (https://www.bart.gov/schedules/developers/developer-license-agreement)'),
              services=services, transfer=dict(emuTransferToStation=XFER_EMU, dmuTransferAllowance=XFER_DMU),
              consist=CS.DOC, trips=out, busBridge=buses)
    size = write_json(os.path.join(PUB, 'timetable.json'), tt)
    c = collections.Counter((r['line'], services[r['svc']]['kind']) for r in out)
    log(f'timetable.json {size/1e6:.2f} MB: {len(out)} train trips, {len(buses)} bus-bridge trips;', dict(c))


if __name__ == '__main__':
    main()
