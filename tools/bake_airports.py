#!/usr/bin/env python3
"""World airports for Bayline Flight: OurAirports (public domain, https://ourairports.com/data/) ->
data/pub/v2/air/airports.json (streamed by src/js/16_airports.js).

    python3 tools/bake_airports.py          # downloads the CSVs into data/raw/ourairports/ if missing

Kept: large, medium and small airports (not heliports, seaplane bases, balloonports or closed fields) with at
least one open runway of 250 m or more (helipads dropped). Runway ends come from the data when present; where
they are missing the ends are placed from the airport reference point, the runway heading and its length
(flagged approximate: the runway is then not drawn, only used to line up).

Output (compact arrays):
  { "v": 1, "countries": {"US": "United States", ...},
    "a": [[ident, iata, name, city, country, type(0 large 1 medium 2 small), lat, lon, elev_ft, twr_mhz,
           [[le_ident, he_ident, le_lat, le_lon, he_lat, he_lon, le_elev_ft, he_elev_ft, length_ft, width_ft,
             surface(0 hard 1 soft 2 water), lighted, le_disp_ft, he_disp_ft, approx], ...]], ...] }
"""
import csv, json, math, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, 'data/raw/ourairports'); OUT = os.path.join(ROOT, 'data/pub/v2/air/airports.json')
BASE = 'https://davidmegginson.github.io/ourairports-data/'
TYPES = {'large_airport': 0, 'medium_airport': 1, 'small_airport': 2}
HARD = ('ASP', 'CON', 'BIT', 'PEM', 'PAV', 'TAR', 'MAC', 'MET', 'CEM', 'BRI', 'COP', 'PSP', 'ASF', 'HARD', 'TARMAC', 'CONC', 'ASPH', 'BITUMEN')
SOFT = ('TURF', 'GRASS', 'GRS', 'GRV', 'GRAVEL', 'DIRT', 'SAND', 'CLAY', 'SOIL', 'EARTH', 'GRE', 'CORAL', 'LAT', 'SNOW', 'ICE', 'UNPAVED', 'MATS', 'GRAAS')


def fetch(name):
    p = os.path.join(RAW, name)
    if not os.path.exists(p):
        os.makedirs(RAW, exist_ok=True)
        print('downloading', name, flush=True)
        urllib.request.urlretrieve(BASE + name, p)
    return p


def num(v, d=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def surface(s, lighted):
    u = (s or '').upper()
    if 'WATER' in u:
        return 2
    if any(k in u for k in HARD):
        return 0
    if any(k in u for k in SOFT):
        return 1
    return 0 if lighted else 1


def dest(lat, lon, brg, dist):
    """Point `dist` metres from (lat, lon) on bearing `brg` degrees (spherical)."""
    R = 6371008.8; d = dist / R; b = math.radians(brg); p1 = math.radians(lat); l1 = math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


def ident_heading(ident):
    digits = ''.join(ch for ch in (ident or '') if ch.isdigit())
    return int(digits) * 10.0 if digits and 1 <= int(digits) <= 36 else None


def main():
    countries = {r['code']: r['name'] for r in csv.DictReader(open(fetch('countries.csv'), encoding='utf-8'))}
    twr = {}
    for r in csv.DictReader(open(fetch('airport-frequencies.csv'), encoding='utf-8')):
        t = (r['type'] or '').upper(); f = num(r['frequency_mhz'])
        if not f:
            continue
        rank = {'TWR': 0, 'CTAF': 1, 'UNIC': 2, 'AFIS': 3}.get(t, 9)
        if rank < 9 and (r['airport_ident'] not in twr or rank < twr[r['airport_ident']][0]):
            twr[r['airport_ident']] = (rank, round(f, 3))
    runways = {}
    for r in csv.DictReader(open(fetch('runways.csv'), encoding='utf-8')):
        if r['closed'] == '1':
            continue
        L = num(r['length_ft']); W = num(r['width_ft'])
        le, he = (r['le_ident'] or '').strip().upper(), (r['he_ident'] or '').strip().upper()
        if not L or L < 820 or le.startswith('H'):
            continue
        runways.setdefault(r['airport_ident'], []).append(r)
    out = []; n_rw = 0; n_approx = 0
    for a in csv.DictReader(open(fetch('airports.csv'), encoding='utf-8')):
        t = TYPES.get(a['type'])
        if t is None or a['ident'] not in runways:
            continue
        lat, lon = num(a['latitude_deg']), num(a['longitude_deg'])
        if lat is None or lon is None:
            continue
        elev = num(a['elevation_ft'], 0.0)
        rws = []
        for r in runways[a['ident']]:
            L = num(r['length_ft']); W = num(r['width_ft']) or (150 if t == 0 else 100 if t == 1 else 60)
            lit = 1 if r['lighted'] == '1' else 0
            la1, lo1, la2, lo2 = num(r['le_latitude_deg']), num(r['le_longitude_deg']), num(r['he_latitude_deg']), num(r['he_longitude_deg'])
            approx = 0
            if None in (la1, lo1, la2, lo2):
                hdg = num(r['le_heading_degT']) or ident_heading(r['le_ident'])
                if hdg is None:
                    continue
                half = L * 0.3048 / 2
                la1, lo1 = dest(lat, lon, hdg + 180, half); la2, lo2 = dest(lat, lon, hdg, half); approx = 1; n_approx += 1
            e1 = num(r['le_elevation_ft'], elev); e2 = num(r['he_elevation_ft'], elev)
            rws.append([(r['le_ident'] or '').strip()[:4], (r['he_ident'] or '').strip()[:4], round(la1, 6), round(lo1, 6), round(la2, 6), round(lo2, 6),
                        round(e1), round(e2), round(L), round(W), surface(r['surface'], lit), lit,
                        round(num(r['le_displaced_threshold_ft'], 0)), round(num(r['he_displaced_threshold_ft'], 0)), approx])
        if not rws:
            continue
        rws.sort(key=lambda w: -w[8]); n_rw += len(rws)
        name = (a['name'] or '').strip()
        out.append([a['ident'], (a['iata_code'] or '').strip(), name, (a['municipality'] or '').strip(), a['iso_country'], t,
                    round(lat, 6), round(lon, 6), round(elev), twr.get(a['ident'], (0, 0))[1], rws])
    out.sort(key=lambda a: (a[5], a[0]))
    used = {a[4] for a in out}
    doc = {'v': 1, 'source': 'OurAirports (public domain), https://ourairports.com/data/', 'countries': {k: v for k, v in countries.items() if k in used}, 'a': out}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    s = json.dumps(doc, separators=(',', ':'), ensure_ascii=False)
    tmp = OUT + '.tmp'; open(tmp, 'w', encoding='utf-8').write(s); os.replace(tmp, OUT)
    by = [sum(1 for a in out if a[5] == k) for k in (0, 1, 2)]
    print(f'{len(out)} airports ({by[0]} large, {by[1]} medium, {by[2]} small), {n_rw} runways ({n_approx} approximate), {len(s) / 1e6:.1f} MB -> {OUT}')


if __name__ == '__main__':
    main()
