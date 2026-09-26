"""Station records for network.json: GTFS stations + platform codes, the tracks they serve (from the pattern paths),
platform edges and sides from OSM platform ways, entrances (GTFS + OSM), station type and levels, hero flags.
M2 adds researched layouts, descriptions and ridership (stations_research.json)."""
import collections, json, math, os
import numpy as np
from metro.common import ll2w, w2ll, log, RAW, HERE

PLAT_LEN = 213.4            # 700 ft (10-car trains)
PLAT_H = 1.02               # platform top above top of rail (BART level boarding; refined in M2)
HERO = {'EMBR', 'MONT', 'POWL', 'CIVC', '12TH', '19TH', 'MCAR', 'WOAK', 'SFIA', 'MLBR', 'COLS', 'BERY', 'ROCK', 'DALY'}
TYPE_OF = {'grade': 'surface', 'embankment': 'surface', 'aerial': 'aerial', 'bridge': 'aerial', 'trench': 'trench',
           'median': 'median', 'portal': 'trench', 'cutcover': 'subway', 'bored': 'subway', 'tube': 'subway'}


def _track_frame(tr, s):
    p = tr['pub']
    i = int(np.clip(round(s / p['step']), 0, len(p['s']) - 1))
    i0, i1 = max(0, i - 2), min(len(p['s']) - 1, i + 2)
    dx, dz = p['x'][i1] - p['x'][i0], p['z'][i1] - p['z'][i0]
    L = math.hypot(dx, dz) or 1.0
    return i, p['x'][i], p['z'][i], dx / L, dz / L


def build(parents, plats, ents, tracks, plat_pos, st_tracks, E, raw_to_s, code_of):
    # OSM platform features and entrances
    feats = []
    ent_osm = []
    for e in E:
        t = e.get('tags', {})
        if e['type'] == 'way' and (t.get('railway') in ('platform', 'platform_edge') or t.get('public_transport') == 'platform'):
            op = t.get('operator', '') or ''
            if 'Muni' in op or 'Municipal' in op or 'Valley Transportation' in op:
                continue
            g = e.get('geometry') or []
            if len(g) < 2:
                continue
            x, z = ll2w(np.array([q['lat'] for q in g]), np.array([q['lon'] for q in g]))
            feats.append(dict(id=e['id'], x=x, z=z, tags=t, closed=e['nodes'][0] == e['nodes'][-1]))
        elif e['type'] == 'node' and t.get('railway') == 'subway_entrance':
            x, z = ll2w(e['lat'], e['lon'])
            ent_osm.append(dict(osm=e['id'], x=float(x), z=float(z), lat=e['lat'], lon=e['lon'], tags=t))
    by_track = {tr['id']: tr for tr in tracks}
    out = []
    for sid, p in sorted(parents.items(), key=lambda kv: code_of.get(kv[0], 'Z99')):
        lat, lon = float(p['stop_lat']), float(p['stop_lon'])
        x, z = ll2w(lat, lon)
        x, z = float(x), float(z)
        pl = []
        for pid, q in plats.items():
            if q['parent_station'] != sid or pid not in plat_pos:
                continue
            ti, sraw = plat_pos[pid]
            tr = tracks[ti]
            s = raw_to_s(tr, sraw)
            i, tx, tz, dx, dz = _track_frame(tr, s)
            rx, rz = -dz, dx
            # OSM platform points near this track position: lateral offsets
            lat_pts = []
            for f in feats:
                ddx = f['x'] - tx; ddz = f['z'] - tz
                along = ddx * dx + ddz * dz
                lateral = ddx * rx + ddz * rz
                m = (np.abs(along) < 130) & (np.abs(lateral) < 12) & (np.abs(lateral) > 0.8)
                if m.any():
                    lat_pts.extend(lateral[m].tolist())
            side = 0
            if lat_pts:
                side = 1 if np.median(lat_pts) > 0 else -1
            else:
                gx, gz = ll2w(float(q['stop_lat']), float(q['stop_lon']))
                lateral = (float(gx) - tx) * rx + (float(gz) - tz) * rz
                side = 1 if lateral > 0 else -1
            L = tr['length']
            s0, s1 = max(0.0, s - PLAT_LEN / 2), min(L, s + PLAT_LEN / 2)
            y = float(tr['pub']['y'][i])
            struct = tr['pub']['struct'][i]
            from metro.profile import STRUCT_NAMES
            pl.append(dict(gtfs=pid, code=q.get('platform_code') or '', track=tr['id'], s=round(s, 2), s0=round(s0, 2), s1=round(s1, 2),
                           side='right' if side > 0 else 'left', y=round(y + PLAT_H, 2), rail=round(y, 2),
                           structure=STRUCT_NAMES[struct], osmPts=len(lat_pts)))
        # layout guess (v0)
        layout = 'side'
        if sid in ('12TH', '19TH'):
            layout = 'stacked'
        elif len(pl) >= 2:
            a, b = pl[0], pl[1]
            ta, tb = by_track[a['track']], by_track[b['track']]
            ia, ax, az, adx, adz = _track_frame(ta, a['s'])
            ib, bx, bz, bdx, bdz = _track_frame(tb, b['s'])
            lat_b = (bx - ax) * (-adz) + (bz - az) * adx
            sa = 1 if a['side'] == 'right' else -1
            same_dir = (adx * bdx + adz * bdz) > 0
            sb = (1 if b['side'] == 'right' else -1) * (1 if same_dir else -1)   # b's side in a's frame
            if sa * lat_b > 0 and sb * lat_b < 0:
                layout = 'island'
            elif sa * lat_b < 0 and sb * lat_b > 0:
                layout = 'side'
            else:
                layout = 'split'
        if sid == 'MCAR':
            layout = 'island'      # two islands, four tracks
        typ = collections.Counter(TYPE_OF.get(q['structure'], 'surface') for q in pl).most_common(1)[0][0] if pl else 'surface'
        ents_g = []
        for q in ents:
            if q['parent_station'] == sid:
                ex, ez = ll2w(float(q['stop_lat']), float(q['stop_lon']))
                ents_g.append(dict(name=q['stop_name'], lat=float(q['stop_lat']), lon=float(q['stop_lon']), x=round(float(ex), 2), z=round(float(ez), 2), src='gtfs'))
        for q in ent_osm:
            if math.hypot(q['x'] - x, q['z'] - z) < 350:
                # skip duplicates of GTFS entrances within 12 m
                if any(math.hypot(q['x'] - g['x'], q['z'] - g['z']) < 12 for g in ents_g):
                    continue
                t = q['tags']
                ents_g.append(dict(name=t.get('name') or t.get('ref') or 'entrance', lat=q['lat'], lon=q['lon'], x=round(q['x'], 2), z=round(q['z'], 2),
                                   src='osm', osm=q['osm'], **({'wheelchair': t['wheelchair']} if t.get('wheelchair') else {})))
        from metro.elev import ground
        gnd = float(ground(np.array([x]), np.array([z]))[0])
        py = max((q['y'] for q in pl), default=gnd)
        out.append(dict(id=sid, name=p['stop_name'], code=code_of.get(sid, ''), lat=lat, lon=lon, x=round(x, 2), z=round(z, 2),
                        type=typ, layout=layout, hero=sid in HERO,
                        levels=dict(street=round(gnd, 2), platform=round(py, 2)),
                        platforms=pl, entrances=ents_g, url=p.get('stop_url', '')))
    log(f'stations: {len(out)}; platforms {sum(len(s["platforms"]) for s in out)}; entrances {sum(len(s["entrances"]) for s in out)}')
    missing = [s['id'] for s in out if not s['platforms']]
    if missing:
        log('stations without platforms:', missing)
    return out


# ====================================================================== M2 station records
# names riders type (front-door search, SIM): official-name variants, neighbourhood/landmark names, abbreviations and the
# four-letter station code. Place names only (no operator names). Shared aliases (Dublin, Pleasanton, El Cerrito,
# Pittsburg) are deliberate: the search returns both stations.
ALIASES = {
    'LAKE': ['Lake Merritt', 'Laney College', 'Oakland Chinatown'],
    'FTVL': ['Fruitvale', 'Fruitvale Village'],
    'COLS': ['Coliseum', 'Oakland Coliseum', 'Oakland Arena', 'Coliseum/Oakland Airport'],
    'SANL': ['San Leandro', 'Downtown San Leandro'],
    'BAYF': ['Bay Fair', 'Bayfair', 'Bayfair Center', 'San Lorenzo'],
    'HAYW': ['Hayward', 'Downtown Hayward'],
    'SHAY': ['South Hayward', 'S Hayward'],
    'UCTY': ['Union City'],
    'FRMT': ['Fremont', 'Downtown Fremont'],
    'ROCK': ['Rockridge', 'College Ave'],
    'ORIN': ['Orinda'],
    'LAFY': ['Lafayette'],
    'WCRK': ['Walnut Creek'],
    'PHIL': ['Pleasant Hill', 'Contra Costa Centre', 'Pleasant Hill/Contra Costa Centre'],
    'CONC': ['Concord', 'Downtown Concord'],
    'NCON': ['North Concord', 'Martinez', 'North Concord/Martinez'],
    'PITT': ['Pittsburg/Bay Point', 'Pittsburg Bay Point', 'Bay Point', 'Pittsburg'],
    'PCTR': ['Pittsburg Center', 'Pittsburg', 'Railroad Ave'],
    'ANTC': ['Antioch', 'Hillcrest'],
    'OAKL': ['Oakland Airport', 'Oakland International Airport', 'Oakland Intl', 'OAK'],
    '12TH': ['12th St', '12th Street', '12th St Oakland', 'Oakland City Center', 'City Center', 'Downtown Oakland'],
    '19TH': ['19th St', '19th Street', '19th St Oakland', 'Uptown', 'Uptown Oakland'],
    'MCAR': ['MacArthur', 'Mac Arthur', 'McArthur', 'Temescal'],
    'CAST': ['Castro Valley'],
    'WDUB': ['West Dublin', 'West Dublin/Pleasanton', 'West Pleasanton', 'Stoneridge', 'Dublin', 'Pleasanton'],
    'DUBL': ['Dublin', 'Pleasanton', 'Dublin/Pleasanton', 'East Dublin'],
    'WOAK': ['West Oakland'],
    'EMBR': ['Embarcadero', 'Ferry Building'],
    'MONT': ['Montgomery', 'Montgomery St', 'Financial District'],
    'POWL': ['Powell', 'Powell St', 'Union Square'],
    'CIVC': ['Civic Center', 'Civic Center/UN Plaza', 'UN Plaza', 'City Hall'],
    '16TH': ['16th St', '16th Street', '16th St Mission', '16th Street Mission'],
    '24TH': ['24th St', '24th Street', '24th St Mission', '24th Street Mission'],
    'GLEN': ['Glen Park'],
    'BALB': ['Balboa Park', 'Balboa'],
    'DALY': ['Daly City'],
    'ASHB': ['Ashby', 'South Berkeley'],
    'DBRK': ['Downtown Berkeley', 'Berkeley', 'UC Berkeley'],
    'NBRK': ['North Berkeley'],
    'PLZA': ['El Cerrito Plaza', 'El Cerrito'],
    'DELN': ['El Cerrito Del Norte', 'Del Norte', 'El Cerrito'],
    'RICH': ['Richmond'],
    'WARM': ['Warm Springs', 'South Fremont', 'Warm Springs/South Fremont'],
    'MLPT': ['Milpitas', 'Great Mall'],
    'BERY': ['Berryessa', 'North San Jose', 'Berryessa/North San Jose', 'San Jose'],
    'COLM': ['Colma'],
    'SSAN': ['South San Francisco', 'South SF', 'SSF'],
    'SBRN': ['San Bruno', 'Tanforan'],
    'MLBR': ['Millbrae'],
    'SFIA': ['SFO', 'San Francisco Airport', 'SF Airport', 'San Francisco International Airport'],
    'PITT-T': [],                     # transfer platform only: no street access
}


# research for the pseudo station (from research B's PITT record, "ebart_transfer_platform")
_EXTRA_RESEARCH = {
    'PITT-T': dict(opened=2018, opened_date='2018-05-26', era='2018 eBART (BART to Antioch)',
                   recognisable='A bare concrete island in the middle of SR-4 with a canopy over its middle: ten-car trains on '
                                'the north face, one- or two-unit diesel trains on the south face, and nobody leaving the platform.',
                   structure_notes='At grade in the SR-4 median east of Bailey Road. The two BART mainline tracks merge into one '
                                   'along the north face and split into two dead-end tail tracks beyond the east end (storage '
                                   'for up to three 10-car trains, EIR). The eBART stub track ends at a buffer stop at the west '
                                   'end; its trackbed is raised ~1-1.5 ft so the DMU floor meets the platform.',
                   platforms=dict(detail='Single at-grade concrete island, 700 ft (213 m) long (2008 EIR): BART face north '
                                         '(C80-T), eBART face south (E10-T), cross-platform transfer.'),
                   entrances='None: no street access, no faregates; emergency egress at the west end only.',
                   sources=['https://www.bart.gov/about/projects/ecc', 'BART eBART (East Contra Costa BART Extension) FEIR, 2008 (via research B)']),
}


def _research():
    out = dict(_EXTRA_RESEARCH)
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'research')
    for f in ('stations_A.json', 'stations_B.json', 'stations_C.json'):
        p = os.path.join(d, f)
        if os.path.exists(p):
            for r in json.load(open(p)):
                if r.get('id') and not r['id'].startswith('_'):
                    out[r['id']] = r
    return out


def build2(parents, plats, ents, tracks, platforms, E, code_of, curated, extra_stations=()):
    """Station records from the platforms (platforms.py), the solved profile and the curated facts."""
    from metro.platforms import PLAT_H_SYS, EDGE_OFF, BERTH_MARGIN
    from metro.profile2 import STRUCT_NAMES
    from metro.dem import ground as dem_ground
    research = _research()
    try:
        eng = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'research', 'engineering.json')))['ridership']
    except Exception:
        eng = {}
    by_id = {t['id']: t for t in tracks}
    ent_osm = []
    for e in E:
        t = e.get('tags', {})
        if e['type'] == 'node' and t.get('railway') == 'subway_entrance':
            x, z = ll2w(e['lat'], e['lon'])
            ent_osm.append(dict(osm=e['id'], x=float(x), z=float(z), lat=e['lat'], lon=e['lon'], tags=t))

    def y_at(tr, s):
        p = tr['pub']; f = min(max(s / p['step'], 0), len(p['y']) - 1.000001); i = int(f); a = f - i
        return float(p['y'][i] * (1 - a) + p['y'][i + 1] * a), int(p['struct'][min(len(p['y']) - 1, int(round(f)))])

    stations = []
    rows = [(sid, p['stop_name'], float(p['stop_lat']), float(p['stop_lon']), p.get('stop_url', '')) for sid, p in parents.items()] + list(extra_stations)
    for sid, name, lat, lon, url in sorted(rows, key=lambda r: code_of.get(r[0], 'Z99')):
        x, z = ll2w(lat, lon); x, z = float(x), float(z)
        cur = curated.get(sid) or {}
        pl_out = []
        levels = {}
        for pid, pl in sorted(platforms.items()):
            if pl['station'] != sid:
                continue
            tr = by_id[pl['track']]
            c = 0.5 * (pl['s0'] + pl['s1'])
            rail, code = y_at(tr, c)
            lv = (cur.get('levelOf') or {}).get(pl['code'], 'main')
            levels.setdefault(lv, []).append(rail)
            ph = PLAT_H_SYS.get(pl['sys'], 0.991)
            pl_out.append(dict(gtfs=pid, code=pl['code'], track=pl['track'], level=lv, s0=round(pl['s0'], 2), s1=round(pl['s1'], 2), s=round(c, 2),
                               side='right' if pl['side'] > 0 else 'left', edge=EDGE_OFF, y=round(rail + ph, 3), rail=round(rail, 3), height=ph,
                               structure=STRUCT_NAMES[code], berth={'+': round(pl['s1'] - BERTH_MARGIN, 2), '-': round(pl['s0'] + BERTH_MARGIN, 2)},
                               src=pl['src'], sys=pl['sys'], **({'unused': True} if pl.get('unused') else {})))
        gnd = float(dem_ground(np.array([x]), np.array([z]))[0][0])
        main_rails = levels.get('main') or [r for v in levels.values() for r in v]
        rail = float(np.mean(main_rails)) if main_rails else gnd
        ph = max((q['height'] for q in pl_out), default=0.991)
        plats_y = [q['y'] for q in pl_out if q['level'] == 'main'] or [q['y'] for q in pl_out]
        lv_out = dict(street=round(gnd, 2), rail=round(rail, 2), platform=round(float(np.mean(plats_y)) if plats_y else rail + ph, 2))
        if len(levels) > 1:
            lv_out['byLevel'] = {k: dict(rail=round(float(np.mean(v)), 2), platform=round(float(np.mean(v)) + ph, 2)) for k, v in levels.items()}
            lv_out['platform'] = round(max(float(np.mean(v)) for v in levels.values()) + ph, 2)
        # entrances: GTFS + OSM subway_entrance nodes not duplicating them
        ents_g = []
        for q in ents:
            if q['parent_station'] == sid:
                ex, ez = ll2w(float(q['stop_lat']), float(q['stop_lon']))
                ents_g.append(dict(name=q['stop_name'], lat=float(q['stop_lat']), lon=float(q['stop_lon']), x=round(float(ex), 2), z=round(float(ez), 2), src='gtfs'))
        for q in ent_osm:
            if math.hypot(q['x'] - x, q['z'] - z) < 350 and not any(math.hypot(q['x'] - g['x'], q['z'] - g['z']) < 12 for g in ents_g):
                t = q['tags']
                ents_g.append(dict(name=t.get('name') or t.get('ref') or 'entrance', lat=q['lat'], lon=q['lon'], x=round(q['x'], 2), z=round(q['z'], 2),
                                   src='osm', osm=q['osm'], **({'wheelchair': t['wheelchair']} if t.get('wheelchair') else {})))
        r = research.get(sid) or {}
        res = {k: r.get(k) for k in ('opened', 'opened_date', 'architect', 'era', 'recognisable', 'structure_notes', 'entrances') if r.get(k)}
        if isinstance(r.get('platforms'), dict):
            res['platformsDetail'] = r['platforms'].get('detail') or r['platforms'].get('arrangement') or r['platforms'].get('serves')
        if r.get('sources'):
            res['sources'] = r['sources']
        st = dict(id=sid, name=name, code=code_of.get(sid, ''), lat=lat, lon=lon, x=round(x, 2), z=round(z, 2),
                  type=cur.get('type') or 'surface', layout=cur.get('layout') or 'island', hero=sid in HERO,
                  levels=lv_out, platforms=pl_out, entrances=ents_g, note=cur.get('note', ''), src=cur.get('src', []), url=url)
        if cur.get('platformStructure'):
            st['platformStructure'] = cur['platformStructure']
        al = list(ALIASES.get(sid, []))
        if sid != 'PITT-T' and sid not in al:
            al.append(sid)                                  # the official four-letter code
        st['aliases'] = [a for a in al if a != name]
        if res:
            st['research'] = res
        if eng.get('avg_weekday_exits_cy2025', {}).get(sid) is not None:
            st['ridership'] = dict(weekdayExits=eng['avg_weekday_exits_cy2025'][sid], weekdayExitsFY2026=eng.get('avg_weekday_exits_fy2026_jul2025_jun2026', {}).get(sid),
                                   source='BART ridership reports (origin-destination 2025; monthly FY2026), average weekday exits')
        stations.append(st)
    log(f'stations: {len(stations)}; platforms {sum(len(s["platforms"]) for s in stations)}; entrances {sum(len(s["entrances"]) for s in stations)}')
    return stations
