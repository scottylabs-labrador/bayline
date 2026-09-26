"""Front-door data for SIM (M3): what a rider reads before and while riding. All additive to network.json.

  stations[].short        sign / list name (SIM's own short names, so nothing on screen changes when SIM switches)
  stations[].transfers    [{kind, text, to?, dir?, system?}] transfer hints; `text` is rider-facing and brand-neutral,
                          `system` names the real operator for reference only (never render it)
  lines[].short           'Yellow' ... 'Airport', 'Antioch shuttle'
  lines[].dirs            {'0' | '1': {toward, dest: [station ids by weekday trips]}}   0 = North, 1 = South (GTFS)
  patterns[].tripsWeekday trips of the pattern on weekday services (`trips` counts every service)
  patterns[].headsign     destination sign (short name of `dest`), `dest` its station, `to` the pattern's last stop
                          (they differ where the train continues after turning, e.g. the evening Millbrae -> SFO ->
                          Antioch trains), `via` the GTFS via-points, `gtfsHeadsign` the raw string
  patterns[].legs[].headsign / to / change
                          per vehicle: the Antioch DMU leg shows "Pittsburg / Bay Point" (change there for the
                          pattern's destination); the EMU leg to the transfer platform shows the rider's destination
                          (Antioch) with the change it involves
"""
import collections, re

STATION_SHORT = {       # = 46_metrosim.js NAMES_SHORT (keep in step)
    'SFIA': 'SFO Airport', 'MLBR': 'Millbrae', 'OAKL': 'Oakland Airport', 'PHIL': 'Pleasant Hill', 'BERY': 'Berryessa',
    'WARM': 'Warm Springs', 'WDUB': 'West Dublin', 'DUBL': 'Dublin / Pleasanton', '12TH': '12th St Oakland',
    '19TH': '19th St Oakland', 'CIVC': 'Civic Center', '16TH': '16th St Mission', '24TH': '24th St Mission',
    'NCON': 'North Concord', 'PITT': 'Pittsburg / Bay Point', 'PCTR': 'Pittsburg Center', 'DELN': 'El Cerrito del Norte',
    'PLZA': 'El Cerrito Plaza', 'DBRK': 'Downtown Berkeley', 'NBRK': 'North Berkeley', 'SSAN': 'South San Francisco',
    'MONT': 'Montgomery St', 'POWL': 'Powell St', 'MCAR': 'MacArthur', 'PITT-T': 'Pittsburg / Bay Point',
}
LINE_SHORT = {'yellow': 'Yellow', 'orange': 'Orange', 'green': 'Green', 'red': 'Red', 'blue': 'Blue', 'grey': 'Airport',
              'ebart': 'Antioch shuttle'}

LR = 'Muni Metro'
TRANSFERS = {
    'MLBR': [dict(kind='rail', to='peninsula', system='Caltrain',
                  text='Peninsula line: northbound trains across the platform, southbound trains from the west platform via the concourse')],
    'COLS': [dict(kind='metro', to='grey', text='Airport Connector to Oakland Airport: follow the signs to the connector platform'),
             dict(kind='rail', system='Amtrak Capitol Corridor', text='Intercity trains at the Coliseum rail station, over the footbridge')],
    'OAKL': [dict(kind='air', text='Oakland Airport terminals')],
    'PITT': [dict(kind='metro', to='ebart', dir=0,
                  text='For Pittsburg Center and Antioch: stay on to the transfer platform, then cross to the Antioch train')],
    'PITT-T': [dict(kind='metro', to='ebart',
                    text='Cross the platform: Antioch trains on the south side, San Francisco, SFO and Millbrae trains on the north side')],
    'PCTR': [dict(kind='metro', to='yellow', dir=1,
                  text='For San Francisco, SFO and Millbrae: change across the platform at Pittsburg / Bay Point')],
    'ANTC': [dict(kind='metro', to='yellow', dir=1,
                  text='For San Francisco, SFO and Millbrae: change across the platform at Pittsburg / Bay Point')],
    'SFIA': [dict(kind='air', system='SFO AirTrain', text='Airport terminals by the airport train')],
    'MCAR': [dict(kind='metro', to=['red', 'orange', 'yellow'],
                  text='Cross-platform between Richmond and Antioch trains: west island toward Oakland and San Francisco, east island toward Richmond and Antioch')],
    '19TH': [dict(kind='metro', to=['red', 'orange', 'yellow'], text='Transfer between Richmond and Antioch trains (the timed northbound transfer)')],
    '12TH': [dict(kind='metro', to=['red', 'orange', 'yellow'], text='Transfer between trains to San Francisco and trains to Fremont and Berryessa')],
    'BAYF': [dict(kind='metro', to=['blue', 'green', 'orange'], text='Transfer between Dublin / Pleasanton trains and Fremont / Berryessa trains')],
    'WOAK': [dict(kind='metro', text='Transfer between the Richmond and Antioch lines and the Fremont and Dublin lines')],
    'EMBR': [dict(kind='ferry', system='SF Bay Ferry, Golden Gate Ferry', text='Ferries at the Ferry Building'),
             dict(kind='lightrail', system=LR, text='City light rail in the same station')],
    'MONT': [dict(kind='lightrail', system=LR, text='City light rail in the same station')],
    'POWL': [dict(kind='lightrail', system=LR, text='City light rail in the same station'),
             dict(kind='cablecar', system='Muni cable car', text='Cable cars at Powell & Market')],
    'CIVC': [dict(kind='lightrail', system=LR, text='City light rail in the same station')],
    'GLEN': [dict(kind='lightrail', system=LR, text='City light rail on San Jose Avenue')],
    'BALB': [dict(kind='lightrail', system=LR, text='City light rail at the station')],
    'RICH': [dict(kind='rail', system='Amtrak', text='Intercity trains from the next platform, via the underpass')],
    'MLPT': [dict(kind='lightrail', system='VTA', text='Light rail across Capitol Avenue')],
}


def short_of(st):
    return STATION_SHORT.get(st['id'], st['name'])


def annotate_stations(stations):
    for st in stations:
        st['short'] = short_of(st)
        st['transfers'] = [dict(t) for t in TRANSFERS.get(st['id'], [])]


def _norm(s):
    s = re.sub(r'\(.*?\)', '', s or '').lower()
    return re.sub(r'[^a-z0-9]+', '', s.replace('int\'l', 'international'))


def _resolver(stations):
    idx = {}
    for st in stations:
        if st['id'] == 'PITT-T':
            continue
        for nm in [st['name'], short_of(st), st['id']] + list(st.get('aliases', [])):
            idx.setdefault(_norm(nm), st['id'])
    idx.update({_norm('SFO'): 'SFIA', _norm('SF Int\'l Airport SFO'): 'SFIA', _norm('OAK Airport'): 'OAKL'})
    return lambda s: idx.get(_norm(s))


def annotate(lines, pats, stations, heads):
    """heads: {pattern id: Counter(GTFS trip_headsign)}."""
    by_id = {s['id']: s for s in stations}
    res = _resolver(stations)
    name = lambda sid: short_of(by_id[sid]) if sid in by_id else sid
    starts = collections.defaultdict(set)             # (line, dir, first stop) -> last stops of patterns starting there
    for p in pats:
        starts[(p['line'], p['dir'], p['legs'][0]['stops'][0]['station'])].add(p['legs'][-1]['stops'][-1]['station'])
    for p in pats:
        cnt = heads.get(p['id']) or collections.Counter()
        raw = cnt.most_common(1)[0][0] if cnt else ''
        comps = [c.strip() for c in raw.split(' / ')] if raw else []
        last = p['legs'][-1]['stops'][-1]['station']
        served = {s['station'] for L in p['legs'] for s in L['stops']}
        dest = res(comps[-1]) if comps else None
        # the sign names the GTFS destination when this train gets there: on this pattern, or by continuing after it
        # turns at its last stop (a pattern of the same line and direction runs on from there to it, e.g. the evening
        # Millbrae -> SFO -> Antioch trains); otherwise where it really ends (bus-bridge weekends: Berryessa -> Warm
        # Springs trains carry "Richmond", the rest of the way is by bus)
        if not dest or not (dest in served or dest in starts.get((p['line'], p['dir'], last), set())):
            dest = last
        p['gtfsHeadsign'] = raw
        p['dest'] = dest
        p['to'] = last
        p['headsign'] = name(dest)
        p['via'] = comps[:-1]
        nl = len(p['legs'])
        for li, L in enumerate(p['legs']):
            L['to'] = L['stops'][-1]['station']
            L['headsign'] = p['headsign']
            if L['sys'] == 'ebart' and L['to'] == 'PITT-T':            # Antioch -> transfer platform
                L['headsign'] = name('PITT')
                L['change'] = dict(at='PITT-T', text=f"Change at Pittsburg / Bay Point for {p['headsign']}")
            elif L['sys'] == 'bart' and L['to'] == 'PITT-T' and li + 1 < nl:   # EMU to the transfer platform, riders to Antioch
                L['change'] = dict(at='PITT-T', text='Change at Pittsburg / Bay Point for Pittsburg Center and Antioch')
    for ln in lines:
        ln['short'] = LINE_SHORT.get(ln['id'], ln['name'])
        dirs = {}
        for d in (0, 1):
            if ln['id'] == 'ebart':
                dest_c = collections.Counter()
                for p in pats:
                    if p['dir'] == d:
                        for L in p['legs']:
                            if L['sys'] == 'ebart':
                                dest_c[L['to']] += p['trips']
            else:                                    # the weekday service decides what a line is "toward"
                dest_c = collections.Counter()
                for p in pats:
                    if p['line'] == ln['id'] and p['dir'] == d:
                        dest_c[p['dest']] += p.get('tripsWeekday', p['trips'])
                dest_c = +dest_c or collections.Counter({p['dest']: p['trips'] for p in pats if p['line'] == ln['id'] and p['dir'] == d})
            if not dest_c:
                continue
            tot = sum(dest_c.values())
            order = [k for k, _ in dest_c.most_common()]
            main = [k for k in order if dest_c[k] >= 0.35 * tot][:2]      # a second destination only if it is a big share
            dirs[str(d)] = dict(toward=' / '.join(name(k) for k in main), dest=order)
        ln['dirs'] = dirs
