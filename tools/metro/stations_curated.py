"""Curated station facts (type, layout, levels, height anchors) with the reasoning for each, merged into network.json.

Sources (keys used in 'src'):
  A, B, C   research/stations_{A,B,C}.json: web research (Wikipedia, bart.gov station pages and news, BART Facilities
            Standards, 1961/62 engineering reports, VTA/BART EIRs, Architectural Record 1974, NRHP nomination, EPQS)
  STW       the stations workstream's research (notes/bart/stations.md in bart-stations: 1966-68 contract drawings, OFD
            manual, measured values)
  OSM       OpenStreetMap platform/track geometry and tags;  LIDAR  USGS 3DEP 1 m bare earth along the tracks;
  PHOTO     the NAIP photo (validation overlays in notes/bart/shots/data/)
Anchors: 'tor' = top of rail relative to the street/ground at the platform (m; negative = below), or 'plat' = platform
edge above the ground (TOR = plat - 0.991). 'w' = solver weight (200 = firm, 20 = typical-value guess). Absent =
the profile follows the lidar trackbed / structure constraints.
"""

PLAT_H = 0.991

C = {
    # ------------------------------------------------------------------ San Francisco: Market St + Mission St subway
    'EMBR': dict(type='subway', layout='island', tor=-20.0, w=120,
                 note='Cut-and-cover box under Market St, three levels (mezzanine, Muni Metro, BART lowest); BART level '
                      'descends NE into the Transbay Tube approach. Depth ~19-21 m per contract drawings (STW); '
                      'De Staebler relief spans ~11 m platform-to-concourse (A).', src=['A', 'STW']),
    'MONT': dict(type='subway', layout='island', tor=-18.6, w=200,
                 note='Three levels under Market St: mezzanine -6.4, Muni -11.6, BART floor -17.6 (contract drawing, STW).', src=['A', 'STW']),
    'POWL': dict(type='subway', layout='island', tor=-18.2, w=200,
                 note='Three levels under Market St; Hallidie Plaza concourse ~6 m below street; BART platform 685 x 36 ft (A).', src=['A', 'STW']),
    'CIVC': dict(type='subway', layout='island', tor=-19.8, w=200,
                 note='Three levels under Market St; excavation reached ~23 m (A); BART ~-19.8 (STW).', src=['A', 'STW']),
    '16TH': dict(type='subway', layout='island', tor=-13.1, w=200,
                 note='Two levels under Mission St: vaulted mezzanine over the island platform (A); depth STW.', src=['A', 'STW']),
    '24TH': dict(type='subway', layout='island', tor=-13.1, w=200,
                 note='Twin of 16th St (same architects), two levels under Mission St (A); depth STW.', src=['A', 'STW']),
    'GLEN': dict(type='subway', layout='island', tor=-11.6, w=120,
                 note='Brutalist headhouse; platform 11.6 m below the headhouse plaza (STW); the 60 ft quoted in the NRHP '
                      'nomination is the full structure height incl. the headhouse (A).', src=['A', 'STW']),
    'BALB': dict(type='trench', layout='island',
                 note='Island platform below grade beside the I-280 cut: open trench at both ends, covered by Geneva Ave '
                      'and the headhouse in the middle (A); the lidar sees the open-cut trackbed.', src=['A', 'LIDAR']),
    'DALY': dict(type='aerial', layout='split', plat=7.0, w=20,
                 note='Elevated 3-track station: west side platform (P3, terminating Blue/Green alight only since Aug 2026), '
                      'centre track (P1, southbound through) and east track (P2, SF-bound) share the island (A).', src=['A']),
    'COLM': dict(type='trench', layout='split',
                 note='Open-cut 3-track station in the Daly City yard valley; island between the two eastern (revenue) tracks, '
                      'unused western side platform (A).', src=['A', 'LIDAR']),
    'SSAN': dict(type='subway', layout='island', tor=-10.0, w=120,
                 note='Covered below-grade station in the former SP right-of-way (cut-and-cover); deep platform with light '
                      'slots (A); ~-10 m (STW).', src=['A', 'STW']),
    'SBRN': dict(type='trench', layout='island', tor=-8.6, w=120,
                 note='Cut-and-cover box ~7.6 m below ground with the roof cut away toward the platform ends (A).', src=['A', 'STW']),
    'SFIA': dict(type='aerial', layout='split', plat=10.0, w=40,
                 note='Elevated stub terminal inside the International Terminal complex: 3 dead-end tracks, 2 islands '
                      '(north track P1 Yellow, middle P2 Red + shuttle, south P3 unused) (A); platform ~+9-10 m (STW).', src=['A', 'STW']),
    'MLBR': dict(type='surface', layout='side',
                 note='At-grade intermodal station; BART track 3 (west) faces Caltrain NB across the shared island; the '
                      'middle and east BART tracks + island store trains (A).', src=['A']),
    # ------------------------------------------------------------------ Oakland
    'WOAK': dict(type='aerial', layout='side', plat=7.0, w=20,
                 note='Elevated with two side platforms (P1 north = SF-bound, P2 south) over a street-level fare lobby (A).', src=['A']),
    '12TH': dict(type='subway', layout='stacked', levelOf={'1': 'upper', '3': 'upper', '2': 'lower'},
                 torLevels={'upper': -17.0, 'lower': -27.0}, w=120,
                 note='Three-level station under Broadway: concourse; upper island (C1 east = P1 Richmond-bound, CX west = '
                      'P3 Antioch-bound); lower side platform (C2 = P2 southbound) (A). Depths ~-17 / ~-27 m (STW, OFD).', src=['A', 'STW']),
    '19TH': dict(type='subway', layout='stacked', levelOf={'1': 'upper', '3': 'upper', '2': 'lower'},
                 torLevels={'upper': -17.0, 'lower': -27.0}, w=120,
                 note='As 12th St: upper island C1/CX, lower side platform C2 (A); blue brick. Depths as 12th St (STW).', src=['A', 'STW']),
    'LAKE': dict(type='subway', layout='island', tor=-14.0, w=120,
                 note='Island platform two levels below ground under the former BART HQ site (A); ~-14 m (STW).', src=['A', 'STW']),
    'MCAR': dict(type='median', layout='island',
                 note='Four tracks, two islands in the SR-24 / I-980 median, cross-platform transfers between the Richmond '
                      'and Antioch branches (OSM, GTFS, STW).', src=['OSM', 'STW']),
    # ------------------------------------------------------------------ Richmond line
    'ASHB': dict(type='subway', layout='island', tor=-11.0, w=120, note='Cut-and-cover under Adeline St (STW).', src=['STW']),
    'DBRK': dict(type='subway', layout='island', tor=-11.0, w=120, note='Under Shattuck Ave, two levels (STW).', src=['STW']),
    'NBRK': dict(type='subway', layout='island', tor=-7.0, w=120, note='Shallow subway station (STW).', src=['STW']),
    'PLZA': dict(type='aerial', layout='side', plat=7.0, w=20, note='Elevated, side platforms (STW).', src=['STW']),
    'DELN': dict(type='aerial', layout='side', plat=7.0, w=20, note='Elevated, side platforms (STW).', src=['STW']),
    'RICH': dict(type='surface', layout='island', note='At-grade terminal (STW); lidar trackbed.', src=['STW', 'LIDAR']),
    # ------------------------------------------------------------------ Concord / Antioch
    'ROCK': dict(type='median', layout='island',
                 note='In the elevated SR-24 median on a ~420 m viaduct over College Ave and Forest St (B); platform ~5-10 m '
                      'above College Ave (B, STW); height from the lidar at the viaduct ends.', src=['B', 'STW', 'LIDAR']),
    'ORIN': dict(type='median', layout='island',
                 note='SR-24 median ~0.55 km east of the Berkeley Hills Tunnel; a short aerial span over Camino Pablo with the '
                      'fare lobby beneath, median trackbed ~151-154 m either side (B); lidar decides.', src=['B', 'LIDAR']),
    'LAFY': dict(type='median', layout='island', note='In the SR-24 median (lead, STW); lidar trackbed.', src=['STW', 'LIDAR']),
    'WCRK': dict(type='aerial', layout='side', plat=7.0, w=20, note='Elevated, side platforms (STW).', src=['STW']),
    'PHIL': dict(type='aerial', layout='side', plat=7.0, w=20, note='Elevated, side platforms (STW).', src=['STW']),
    'CONC': dict(type='aerial', layout='island', plat=6.96, w=150, note='Elevated; platform +6.96 m measured (STW).', src=['STW']),
    'NCON': dict(type='trench', layout='island', note='Shallow open cut, trackbed ~6 m below the ground either side at mid-platform (B, lidar); '
                      'overhead concourse and footbridge (B).', src=['B', 'STW', 'LIDAR']),
    'PITT': dict(type='median', layout='island', note='In the SR-4 median (lead, STW); eBART transfer platform ~1 km east.', src=['STW', 'OSM']),
    'PCTR': dict(type='median', layout='island', note='eBART; SR-4 median in a shallow depression under the Railroad Ave overcrossing, '
                      'stairs/elevator down from the overpass (B); lidar trackbed.', src=['B', 'STW', 'LIDAR']),
    'ANTC': dict(type='median', layout='side', note='eBART terminal by the SR-4 median (lead, STW).', src=['STW']),
    # ------------------------------------------------------------------ Fremont line
    'FTVL': dict(type='aerial', layout='side', plat=7.0, w=20,
                 note='Elevated, two side platforms on a 1972 viaduct; street-level fare lobby (C).', src=['C']),
    'COLS': dict(type='aerial', layout='island', plat=10.7, w=60,
                 note='Elevated island (C); platform ~10.7 m above San Leandro St derived from the OAC FEIR (C). The airport '
                      'connector platform (P3) is a separate, higher level west of San Leandro St.', src=['C']),
    'SANL': dict(type='aerial', layout='side', plat=7.0, w=20, note='Elevated, side platforms, "strong massiveness" (C).', src=['C']),
    'BAYF': dict(type='aerial', layout='island', plat=7.0, w=20,
                 note='Elevated island; the Dublin line leaves through a flying junction just SE (C).', src=['C']),
    'HAYW': dict(type='aerial', layout='side', plat=7.0, w=20, note='Elevated, side platforms on T-bents (C).', src=['C']),
    'SHAY': dict(type='aerial', layout='side', platformStructure='embankment',
                 note='"Aerial" per BART, but ballasted track on retained fill with an underpass (C, photos).', src=['C', 'STW']),
    'UCTY': dict(type='aerial', layout='side', platformStructure='embankment',
                 note='Side platforms raised on fill, passage underneath (C).', src=['C', 'STW']),
    'FRMT': dict(type='aerial', layout='island', platformStructure='embankment',
                 note='Island on a retaining-wall podium / embankment with underpasses (C).', src=['C', 'STW']),
    'WARM': dict(type='surface', layout='island', note='At-grade island with an overhead concourse (C); lidar trackbed.', src=['C', 'LIDAR']),
    'MLPT': dict(type='trench', layout='side',
                 note='Retained cut (U-trench) under a street-level station building; side platforms 700 x 16 ft (C); '
                      'lidar sees the trench floor.', src=['C', 'LIDAR']),
    'BERY': dict(type='aerial', layout='island', plat=10.7, w=150,
                 note='Aerial island 35 ft above ground (VTA fact sheet, C); tail tracks ~0.9 km south.', src=['C']),
    'CAST': dict(type='median', layout='island', note='I-580 median on a low embankment; lobby under the platform (C).', src=['C', 'LIDAR']),
    'WDUB': dict(type='median', layout='island', note='I-580 median at grade with a mezzanine over the platform (C).', src=['C', 'LIDAR']),
    'DUBL': dict(type='median', layout='island', note='I-580 median, freeway raised over a street underpass (C).', src=['C', 'LIDAR']),
    'OAKL': dict(type='aerial', layout='side', note='Airport connector terminus: single stub track, side platform with screen doors (C).', src=['C']),
}


def anchors_for(station_id):
    """[(level or None, tor_rel_ground, weight)]"""
    c = C.get(station_id) or {}
    out = []
    if 'torLevels' in c:
        for lv, v in c['torLevels'].items():
            out.append((lv, v, c.get('w', 120)))
    elif 'tor' in c:
        out.append((None, c['tor'], c.get('w', 120)))
    elif 'plat' in c:
        out.append((None, c['plat'] - PLAT_H, c.get('w', 20)))
    return out
