# Data workstream status (bart-data)

Owner: data workstream. Branch `bart-data`, worktree `.worktrees/bart-data`, dev port 8131.
Format spec (the contract): **`notes/bart-data.md`**. Outputs: `data/pub/v2/metro/` (shared, live for everyone).
Loader: `src/js/21_metronet.js` (`MetroNet`). Preview: `preview/metronet.html`.

## Status

**M2b: STAGED in `data/pub/v2/metro-next/` — publish-ready, ships with the next gated deploy (lead, 05:50).**
`data/pub/v2/metro/` is **production M2, byte-identical to both servers** (restored 05:52 from production after a
05:46 promotion; sha256: network.json 11a2cf17, timetable.json 3eddf454, validation.json 7383cd10,
tracks.6f6a7a6c04.bin = tracks.bin 6f6a7a6c). **Review M2b with `#metrodir=metro-next/`.** Bakes now write to
metro-next by default and `promote.py` needs `--yes` (only when the lead asks).

For the gated deploy, `python3 tools/metro/promote.py --yes` writes into data/pub/v2/metro (publish in this order):

| file | change | bytes | sha256 |
|---|---|---|---|
| `tracks.5bf8256c17.bin` | new (M2b binary, content-addressed) | 1,122,175 | 5bf8256c17295ac3… |
| `crossings.json` | new (on demand, new MetroNet only) | 236,801 | d6843a3aae094da8… |
| `network.json` | overwritten (M2: 423,035 B); `tracksBin.path` = `metro/tracks.5bf8256c17.bin` | 440,302 | 6aa8c8f72fa8ed2c… |
| `validation.json` | overwritten (not read by the game) | 6,408 | 174f13fc29f579c1… |
| `timetable.json` | identical to M2 except the `generated` stamp: no need to publish | 1,345,334 | 98dda8fa… |
| `tracks.bin`, `tracks.6f6a7a6c04.bin` | untouched (M2 bytes), keep both | 1,125,601 | 6f6a7a6c04e44e7d… |

Old network.json readers: a cached M2 network.json keeps reading `tracks.6f6a7a6c04.bin` (kept) and an unchanged
timetable; production code (2d1d290) reading the M2b network.json fetches `tracks.5bf8256c17.bin` (publish it
first); new fields are additive (`aliases`, `yards`, `constants`, platform `height`/`unused`). The one unsafe pair is a
stale pre-2d1d290 (M1) page with `#metro=1` reading the M2b network.json (it reads `metro/tracks.bin`, M2 bytes).
Tested in Node: the production loader and the new loader give identical frames, paths and platforms on M2b.
`21_metronet.js` on `bart-data` adds `loadCrossings()` / `crossings()` / `constants` / `yards`: please merge it.

### What changed in M2b (who should look)

- **Platform sides at side-platform stations were inverted in M2 (INFRA, STATIONS: thanks for the report).** Sides now
  come from the nearest OSM platform feature: FTVL SANL HAYW SHAY UCTY WCRK PHIL WOAK PLZA DELN MLPT and SFO's Y10-2
  flipped to the outside; the third-rail plane follows (rail between the tracks at side-platform stations, outside at
  islands). Audit: no platform side points at a track < 5 m away, except San Bruno's island (tracks 4.9 m apart, below).
- **Which track each platform is (SIM, STATIONS).** Where GTFS platform points are unambiguous (68 platforms, 34
  stations) they decide the platform's track, ahead of OSM route relations. Daly City: southbound through trains
  (M90-1) now use the centre track, terminating Blue/Green (M90-3) the west side-platform track, as GTFS, research and
  the Aug 2026 change say (M2 had them swapped). Berryessa departures (S50-2) use the second face (S2); Antioch departures
  (E30-2) use E2, the unused E30-1 face is E1. Track ids around Daly City/Colma were renamed as a result (use
  `pathFor` / `stationById`, never literal ids).
- **Island stations OSM drew too narrow (STATIONS, INFRA, WORLD).** Ashby 4.6 m, North Berkeley 6.7 m, Downtown
  Berkeley 7.7 m and Glen Park 7.7 m track centres (islands of 1.4-4.5 m) are spread to BART's usual 11.1 m along
  the platform (±20 m) with 150 m tapers. San Bruno (5.0 m, pocket-track turnouts at both platform ends) is left as
  mapped: a known limitation.
- **Heights (STATIONS, INFRA).** Milpitas +6.6 m: M2 buried its roofed U-trench (the lidar sees the floor through the
  station's openings at ~9.5 m; research: cut < 30 ft). West Dublin +1.8 m: OSM's 100 m "tunnel" there is a road
  bridge over the median (now open track). Balboa Park +0.7 m. Everything else within 0.4 m of M2.
- **PITT-T (SIM, STATIONS).** The transfer island is 700 ft (226 m of OSM geometry; M2 had cut it to 150 m), so
  berths moved: BART face `C80-T` 21-247 m on `CT`, eBART face `E10-T` 0-224 m on `ET` (buffer stop at the west end).
  Platform tops equal (35.0 m); eBART rail +0.36 m (height 0.635).
- **Layouts:** Antioch `island` (was `side`: one 410 ft island between the tracks per EIR/NAIP), Millbrae `split`
  (one face of the shared Caltrain island + the BART storage island). PITT-T type `median`.
- **Speed limits / vertical curves (SIM).** Vertical curves now hold ≤ 0.05 g at the civil limit (2 km radius at
  70 mph) as a hard constraint. Speed codes unchanged in method (see the runtime check below).
- **New data:** `stations[].aliases` (search names, see below), `metro/crossings.json` (streets/rails/water crossing
  every track: s, class, over/under/level, width, angle, name, dy = rail height above the ground there), `yards[]`,
  `constants` (gauge, platform edge/heights, third rail 1.4986 m / +0.1715 m, car lengths), platform `height` and
  `unused`, PITT-T research record, platform arrangement text for all 50 stations.
- **Validator:** checks exactly what the solver holds; every remaining finding is a data conflict (next section).

### For SIM: station search names

`MetroNet.stationById[id].aliases` (network.json `stations[].aliases`): what riders type besides the official
`name`: short/alternate names ("Powell St", "Civic Center/UN Plaza", "UN Plaza", "12th St", "19th St", "Uptown",
"MacArthur"/"McArthur"), landmarks and neighbourhoods ("Ferry Building", "Union Square", "Coliseum", "Oakland Arena",
"Great Mall"), airports ("SFO", "San Francisco Airport", "SF Airport", "OAK", "Oakland Airport"), cities ("Dublin",
"Pleasanton", "Walnut Creek", "Pleasant Hill", "Berryessa", "North San Jose", "San Jose") and the official
four-letter code ("EMBR", "12TH" ...). Shared on purpose where riders are ambiguous: "Dublin"/"Pleasanton" (DUBL, WDUB),
"El Cerrito" (PLZA, DELN), "Pittsburg" (PITT, PCTR). No operator names. PITT-T has none (no street access).

### Runtime check (lead item 1): minimum run at our limits vs the published times

`python3 tools/metro/validate.py runtimes` (1.0 m/s² accelerate/brake, limits held over the train, against the MEDIAN
scheduled hop over all weekday trips; GTFS times are whole minutes):

| hop | min run | scheduled (median) | restrictions on the way | verdict |
|---|---|---|---|---|
| GLEN → 24TH | 138 s | 120 s | 36 mph Mission St & Cesar Chavez (R ≈ 206-260 m), 50 either side | M2's **18 mph (and 27 mph near 30th St) were OSM digitising kinks** in the Mission St subway trace: fixed by the tunnel plan smoothing + 15 m curvature smoothing. The remaining 36 is the real 32° turn from San Jose Ave onto Mission St as OSM traces it (~150 m); with 70 everywhere the run would be 116 s, so BART's real radius is probably larger (≥ 360 m gives 50 mph); no published civil speed, left as geometry says |
| NBRK → PLZA | 149 s | 120 s | 50 mph leaving North Berkeley (curvature) | GTFS minute rounding: 3.54 km in 2:00 needs a 66 mph average, impossible at 70 mph max even with no restriction (144 s) |
| COLM → DALY | 193 s | 180 s (shortest 120) | 27/36 mph: **OSM `maxspeed` = BART civil codes** on the Colma cut and the curve south of Daly City | real (source: OSM maxspeed tags); 13 s over the median |
| WOAK → 12TH (Wye) | within 5 s of the median | 180 s | 18/27/36 mph through the Wye: OSM `maxspeed` (BART civil codes) | real, consistent |
| SSAN ↔ SBRN, DALY ↔ BALB | within 5 s | | | M2's gap was the first-trip sample; the median fits |

### Validator (M2b, every bake, `metro/validation.json`)

platform mismatch 0 · grades 0 (4 %, Tube 3 %, airport connector 6.5 %) · vertical curves 0 (≥ 800 m and ≤ 0.05 g)
· aerial clearance 0 · tunnel cover 0 · junction steps 0 · open track > 1 m below the lidar: **5** (A2.2/A1.2 at the
Bay Fair L-line flyover 1.2-1.3 m, the grade separation pushes the lower track down; C1/C2 at the Berkeley Hills
east portal 1.2-1.3 m over 1-2 samples; S2 1.0 m one sample) · researched heights missed: **3** (19th St lower
+3.1: the portal 460 m north limits the depth at 4 %; North Berkeley −3.2: the 7.5 m cut-and-cover cover where the
ground drops 3 m along the platform; Concord −1.4 vs the measured +6.96 m platform: the ≤ 0.05 g vertical curves on
the 70 mph approaches). Remaining soft-constraint conflicts (reported by the solver): Oakland Wye grade separation
K-main.3/K-main.2 1.05 m short of 5.6 m, 19 cover and 162 clearance samples within 1.3/1.8 m (portal and abutment
approaches).

### What moved (M2 -> M2b)

| station | type | layout | rail (m) | platform v0 / before / now | moved since before | since v0 |
|---|---|---|---|---|---|---|
| MLPT | trench | side | 10.6 | 12.8 / 4.9 / 11.5 | +6.6 | -1.3 |
| WDUB | median | island | 107.5 | 106.6 / 106.7 / 108.5 | +1.8 | +1.9 |
| BALB | trench | island | 62.3 | 64.8 / 62.6 / 63.3 | +0.7 | -1.5 |
| ANTC | median | side -> **island** | 23.1 | 22.4 / 24.1 / 23.7 | -0.4 | +1.3 |
| PCTR | median | island | 17.0 | 18.3 / 18.0 / 17.6 | -0.4 | -0.7 |
| SHAY | aerial | side | 12.5 | 12.2 / 13.2 / 13.5 | +0.3 | +1.3 |
| CAST | median | island | 59.2 | 57.6 / 60.0 / 60.2 | +0.2 | +2.6 |
| GLEN | subway | island | 41.7 | 49.0 / 42.5 / 42.7 | +0.2 | -6.3 |
| PITT-T | surface -> **median** | island | 34.2 | - / 35.2 / 35.0 | -0.2 | - |
| FRMT | aerial | island | 23.0 | 23.7 / 23.8 / 24.0 | +0.1 | +0.3 |
| MCAR | median | island | 34.5 | 34.9 / 35.6 / 35.5 | -0.1 | +0.6 |
| NCON | trench | island | 30.9 | 38.8 / 32.0 / 31.9 | -0.1 | -6.9 |
| UCTY | aerial | side | 19.9 | 23.6 / 20.8 / 20.9 | +0.1 | -2.7 |
| MLBR | surface | side -> **split** | 3.9 | 5.1 / 5.0 / 4.9 | -0.1 | -0.2 |
| DALY | aerial | split | 91.9 | 89.6 / 92.9 / 92.9 | +0.1 | +3.3 |
| ASHB | subway | island | 25.9 | 25.9 / 27.0 / 26.9 | -0.1 | +1.1 |
| CONC | aerial | island | 35.7 | 28.4 / 36.7 / 36.7 | -0.0 | +8.3 |
| RICH | surface | island | 16.1 | 14.9 / 17.1 / 17.1 | +0.0 | +2.2 |
| ORIN | median | island | 155.0 | 198.4 / 156.0 / 156.0 | +0.0 | -42.4 |
| LAFY | median | island | 114.3 | 114.0 / 115.3 / 115.3 | -0.0 | +1.3 |
| PITT | median | island | 46.1 | 48.2 / 47.1 / 47.1 | +0.0 | -1.1 |
| PLZA | aerial | side | 22.0 | 26.3 / 23.0 / 23.0 | +0.0 | -3.3 |
| DELN | aerial | side | 26.6 | 30.8 / 27.6 / 27.6 | +0.0 | -3.2 |
| HAYW | aerial | side | 36.4 | 40.9 / 37.3 / 37.4 | +0.0 | -3.5 |
| 19TH | subway | stacked | -11.7 (upper -9.4, lower -16.4) | -3.0 / -8.4 / -8.4 | +0.0 | -5.4 |
| 16TH | subway | island | -3.3 | -0.5 / -2.3 / -2.3 | -0.0 | -1.8 |
| BAYF | aerial | island | 16.8 | 20.8 / 17.8 / 17.8 | -0.0 | -3.0 |
| NBRK | subway | island | 23.1 | 22.0 / 24.1 / 24.1 | -0.0 | +2.1 |
| CIVC | subway | island | -4.8 | 4.3 / -3.8 / -3.8 | +0.0 | -8.1 |
| LAKE | subway | island | -3.9 | -1.1 / -2.9 / -2.9 | -0.0 | -1.8 |
| MONT | subway | island | -9.0 | -0.9 / -8.0 / -8.0 | +0.0 | -7.1 |
| 24TH | subway | island | 9.2 | 10.7 / 10.2 / 10.2 | +0.0 | -0.5 |
| WARM | surface | island | 14.3 | 15.8 / 15.3 / 15.3 | +0.0 | -0.5 |
| SSAN | subway | island | 14.7 | 13.0 / 15.7 / 15.7 | -0.0 | +2.7 |
| DBRK | subway | island | 46.1 | 45.5 / 47.1 / 47.1 | -0.0 | +1.6 |
| BERY | aerial | island | 35.9 | 36.6 / 36.9 / 36.9 | -0.0 | +0.2 |
| COLM | trench | split | 47.4 | 49.8 / 48.4 / 48.4 | +0.0 | -1.4 |
| FTVL | aerial | side | 17.9 | 22.0 / 18.9 / 18.9 | +0.0 | -3.1 |
| COLS | aerial | island | 14.4 | 15.2 / 15.4 / 15.4 | +0.0 | +0.2 |
| SANL | aerial | side | 21.7 | 26.5 / 22.7 / 22.7 | +0.0 | -3.8 |
| ROCK | median | island | 63.7 | 65.8 / 64.7 / 64.7 | +0.0 | -1.1 |
| WCRK | aerial | side | 60.0 | 63.8 / 61.0 / 61.0 | +0.0 | -2.8 |
| PHIL | aerial | side | 33.4 | 37.6 / 34.4 / 34.4 | +0.0 | -3.2 |
| OAKL | aerial | side | 10.4 | 7.9 / 11.4 / 11.4 | +0.0 | +3.5 |
| 12TH | subway | stacked | -7.1 (upper -3.8, lower -13.7) | 1.2 / -2.8 / -2.8 | +0.0 | -4.0 |
| DUBL | median | island | 109.7 | 109.8 / 110.7 / 110.7 | +0.0 | +0.9 |
| WOAK | aerial | side | 11.1 | 15.3 / 12.1 / 12.1 | +0.0 | -3.2 |
| EMBR | subway | island | -16.5 | -8.1 / -15.5 / -15.5 | +0.0 | -7.4 |
| POWL | subway | island | -6.7 | 0.1 / -5.7 / -5.7 | +0.0 | -5.8 |
| SBRN | trench | island | 2.6 | 3.0 / 3.6 / 3.6 | +0.0 | +0.6 |
| SFIA | aerial | split | 11.4 | 13.3 / 12.4 / 12.4 | +0.0 | -0.9 |

Platform records that changed (track, side, extent or > 0.5 m of rail height; island spreading at ASHB/NBRK/DBRK/GLEN
moves each track ~1.7-3.3 m sideways and isn't listed):

| platform | before (track side s0-s1) | now | change |
|---|---|---|---|
| A20-1 (FTVL) | A1.1 left 5029-5239 | A1.1 right 5028-5239 | side |
| A20-2 (FTVL) | A2.1 right 5030-5240 | A2.1 left 5030-5240 | side |
| A40-1 (SANL) | A1.1 left 13196-13406 | A1.1 right 13196-13407 | side |
| A40-2 (SANL) | A2.1 right 13199-13410 | A2.1 left 13199-13409 | side |
| A60-1 (HAYW) | A1.2 left 4325-4532 | A1.2 right 4325-4532 | side |
| A60-2 (HAYW) | A2.2 right 3478-3685 | A2.2 left 3479-3685 | side |
| A70-1 (SHAY) | A1.2 left 9068-9277 | A1.2 right 9068-9277 | side |
| A80-1 (UCTY) | A1.2 left 15112-15320 | A1.2 right 15111-15319 | side |
| C40-1 (WCRK) | C1 left 20432-20643 | C1 right 20432-20643 | side |
| C40-2 (WCRK) | C2 right 20411-20622 | C2 left 20411-20622 | side |
| C50-1 (PHIL) | C1 left 23189-23401 | C1 right 23189-23401 | side |
| C50-2 (PHIL) | C2 right 23170-23383 | C2 left 23170-23382 | side |
| C80-T (PITT-T) | CT right 55-205 | CT right 21-247 | length 150->226 m |
| E10-T (PITT-T) | ET left 32-182 | ET left 0-224 | length 150->224 m |
| E30-1 (ANTC) | - | E1 left 13164-13293 | new (unused) |
| E30-2 (ANTC) | E1 left 13164-13293 | E2 right 13167-13297 | track, side |
| L20-1 (WDUB) | L1 left 18184-18398 | L1 left 18184-18398 | rail +1.8 m |
| L20-2 (WDUB) | L2 left 3857-4071 | L2 left 3857-4071 | rail +1.8 m |
| M10-1 (WOAK) | M1.1 left 1381-1598 | M1.1 right 1381-1598 | side |
| M10-2 (WOAK) | M2 left 33850-34067 | M2 right 33842-34059 | side |
| M80-1 (BALB) | M1.1 left 20706-20915 | M1.1 left 20701-20910 | rail +0.7 m |
| M80-2 (BALB) | M2 left 14546-14755 | M2 left 14544-14753 | rail +0.7 m |
| M90-1 (DALY) | M1.2 left 238-447 | M1.2 right 2802-3012 | side |
| R40-1 (PLZA) | R1 left 9714-9927 | R1 right 9705-9918 | side |
| R40-2 (PLZA) | R2 left 6928-7141 | R2 right 6928-7140 | side |
| R50-1 (DELN) | R1 left 12683-12893 | R1 right 12674-12884 | side |
| R50-2 (DELN) | R2 left 3962-4171 | R2 right 3961-4171 | side |
| S40-1 (MLPT) | S1 left 3503-3712 | S1 right 3503-3712 | side, rail +6.6 m |
| S40-2 (MLPT) | S2 right 3412-3621 | S2 left 3412-3621 | side, rail +6.6 m |
| S50-2 (BERY) | S1 left 8318-8531 | S2 right 8228-8440 | track, side |
| W10-1 (COLM) | M3 right 236-444 | M1.2 right 236-444 | track |
| Y10-2 (SFIA) | Y2 right 339-562 | Y2 left 339-562 | side |
| Y10-3 (SFIA) | - | Y-main.5 left 1327-1550 | new (unused) |

| structure | km before | km now |
|---|---|---|
| aerial | 98.9 | 98.9 |
| bored | 11.5 | 11.5 |
| bridge | 8.9 | 8.9 |
| cutcover | 70.1 | 69.6 |
| embankment | 14.1 | 14.1 |
| grade | 168.6 | 168.4 |
| median | 116.8 | 116.9 |
| portal | 2.8 | 2.6 |
| trench | 8.0 | 8.7 |
| tube | 11.7 | 11.7 |


### Answers to requests (this round)

- **Lead**: (1) runtime check above; (2) `stations[].aliases` done; (3) staged in `metro-next`, promoted, legacy
  binary untouched, new binary content-addressed. `bart` merged into `bart-data` (7ec1d13).
- **Infra**: platform sides and the third-rail plane fixed (see above); Berkeley Hills bore spacing still OSM's ~20 m
  (sources disagree: 15.2 m vs 30 → 17 m); OSM tunnels that are only road bridges are open track now (West Dublin).
- **Stations**: road crossings with class, over/under, width, angle, name and `dy` (the "clearance" you asked for:
  rail height above the ground/road at the crossing) in `crossings.json` (`await MetroNet.loadCrossings()`);
  PITT-T eBART face raised 0.356 m (one walking surface), 226 m long; Antioch second face (`E30-1`, unused); eBART
  platform height 0.635; Antioch island; island spacing fixed at 4 stations (San Bruno not: tell me if you want its
  pocket tracks moved too).
- **Trains**: `constants.thirdRail` = offset 1.4986 m, contact surface +0.1715 m (BFS R3.2.3); GTW 2/6 wording done.
- **Sim**: the runtime check above; Daly City platform tracks corrected (M90-1 centre, M90-3 west); PITT-T berths
  moved with the longer platform; berths are still one number per direction (per-length berths not added).

### (history) M2, 03:29

**M2 data: PROMOTED to the shared `data/pub/v2/metro/` (2026-09-26 03:29, `tools/metro/promote.py`) — OK to publish.**
Compatibility, tested (Node, both loaders against the promoted files, 03:35): the **M1-era MetroNet (commit 3d9009f)
loads the promoted network.json fine**: it fetches `metro/tracks.bin` (kept, same bytes as `tracks.6f6a7a6c04.bin`),
reads 4 attribute planes at each track's `off` (the 5th plane and the 4-byte padding are skipped), and every v0 field
is unchanged (additions only). Results identical to the M2 loader (374 tracks, same frames/paths/platform heights).
Semantic changes the M1 code sees: stops are berths now, and there is a `PITT-T` station record; the current `bart`
code handles both (smoke-tested in the merged game with `#metro=1`). Same schema as v0 plus
additions (spec: notes/bart-data.md, M2 marked). Binary is content-addressed: `metro/tracks.6f6a7a6c04.bin`, named by
`network.json.tracksBin.path`; `metro/tracks.bin` holds the same bytes for the integration's current MetroNet (it reads
by per-track offset, so the new 5th plane is harmless). `21_metronet.js` on `bart-data` loads the hashed name
(+ `dir` / `#metrodir=` for staged bakes, `frame().third`, `track.TR`): please merge it.

What M2 changes (details in notes/bart-data.md):
- **Vertical profile**: one exact QP (OSQP) over all 103k samples: lidar trackbed (USGS 3DEP 1 m, 610 new L8 tiles
  along BART incl. north of the square), hard grade <= 4 % (3 % Transbay Tube), vertical curves >= 800 m, equal
  heights at all 578 junctions, **every track of a station level equal and level along the platform (+15 m)**,
  grade separations from OSM layers (Wye, MacArthur flyover, 12th/19th), researched anchors (station depths, SF vent
  structure -85 ft, the 1965 Tube profile, the Berkeley Hills Tunnel's as-built 1.75 % / -0.3 % grades).
  Validator (every bake; `metro/validation.json`): platform rail mismatch 0, grade violations 0, vertical curves
  >= 800 m everywhere, junction steps 0. Remaining flags are explained below.
- **Structure**: medians from OSM freeways (116.8 km of `median`), trench/embankment from the lidar cross-section, OSM
  bridge extents trimmed where the lidar shows fill (135 samples -> `embankment`), the Tube by geometry (5.83 km
  immersed from the SF vent, 560 m of SF bores, the Oakland box), portals at real tunnel ends only.
- **Plan**: Transbay Tube track centres 8.03 m (OSM had 5.07).
- **Stations**: all 105 platforms from OSM platform geometry (both faces of an island share one extent), platform
  top 0.991 m, edge 1.616 m, berths per direction, curated type/layout per station with reasoning + sources, research
  (opened, architect, era, what riders recognise, sources), ridership (weekday exits CY2025/FY2026), PITT-T station.
- **Patterns**: stops are berths (front of train at the leaving platform end); legs start at the first platform's
  rear end. Terminal platform codes get distinct tracks where paths allow (Berryessa).
- **Speed limits**: curvature, capped by OSM maxspeed (BART civil codes: Wye 18 mph, Balboa Park / Daly City 36 ...),
  quantised to BART's ATC codes 6/18/27/36/50/70. **Third-rail side** per sample (new 5th plane).
- **Timetable**: 2026 train sizing (Red 10/5, Yellow 9-10, Green/Blue 6-8, Orange 5-6), eBART = Stadler GTW 2/6
  units (`cars` = units, 1 off-peak / 2 peak), realistic eBART transfer timing.

### What moved (station platform level, v0 -> M2, m above sea level)

| station | type (M2) | layout | rail M2 (m) | platform v0 -> M2 | moved (m) |
|---|---|---|---|---|---|
| ORIN | median | island | 155.0 | 198.4 -> 156.0 | -42.4 |
| CONC | aerial | island | 35.7 | 28.4 -> 36.7 | +8.3 |
| CIVC | subway | island | -4.8 | 4.3 -> -3.8 | -8.1 |
| MLPT | trench | side | 3.9 | 12.8 -> 4.9 | -7.9 |
| EMBR | subway | island | -16.5 | -8.1 -> -15.5 | -7.4 |
| MONT | subway | island | -9.0 | -0.9 -> -8.0 | -7.1 |
| NCON | trench | island | 31.0 | 38.8 -> 32.0 | -6.8 |
| GLEN | subway | island | 41.5 | 49.0 -> 42.5 | -6.5 |
| POWL | subway | island | -6.7 | 0.1 -> -5.7 | -5.8 |
| 19TH | subway | stacked | -11.7 (upper -9.4, lower -16.4) | -3.0 -> -8.4 | -5.4 |
| 12TH | subway | stacked | -7.1 (upper -3.8, lower -13.7) | 1.2 -> -2.8 | -4.0 |
| SANL | aerial | side | 21.7 | 26.5 -> 22.7 | -3.8 |
| HAYW | aerial | side | 36.3 | 40.9 -> 37.3 | -3.6 |
| OAKL | aerial | side | 10.4 | 7.9 -> 11.4 | +3.5 |
| PLZA | aerial | side | 22.0 | 26.3 -> 23.0 | -3.3 |
| DALY | aerial | split | 91.9 | 89.6 -> 92.9 | +3.3 |
| DELN | aerial | side | 26.6 | 30.8 -> 27.6 | -3.2 |
| WOAK | aerial | side | 11.1 | 15.3 -> 12.1 | -3.2 |
| PHIL | aerial | side | 33.4 | 37.6 -> 34.4 | -3.2 |
| FTVL | aerial | side | 17.9 | 22.0 -> 18.9 | -3.1 |
| BAYF | aerial | island | 16.8 | 20.8 -> 17.8 | -3.0 |
| UCTY | aerial | side | 19.8 | 23.6 -> 20.8 | -2.8 |
| WCRK | aerial | side | 60.0 | 63.8 -> 61.0 | -2.8 |
| SSAN | subway | island | 14.7 | 13.0 -> 15.7 | +2.7 |
| CAST | median | island | 59.0 | 57.6 -> 60.0 | +2.4 |
| RICH | surface | island | 16.1 | 14.9 -> 17.1 | +2.2 |
| BALB | trench | island | 61.7 | 64.8 -> 62.6 | -2.1 |
| NBRK | subway | island | 23.1 | 22.0 -> 24.1 | +2.1 |
| 16TH | subway | island | -3.3 | -0.5 -> -2.3 | -1.8 |
| LAKE | subway | island | -3.9 | -1.1 -> -2.9 | -1.8 |
| ANTC | median | side | 23.1 | 22.4 -> 24.1 | +1.7 |
| DBRK | subway | island | 46.1 | 45.5 -> 47.1 | +1.6 |
| COLM | trench | split | 47.4 | 49.8 -> 48.4 | -1.4 |
| LAFY | median | island | 114.3 | 114.0 -> 115.3 | +1.3 |
| PITT | median | island | 46.1 | 48.2 -> 47.1 | -1.1 |
| ROCK | median | island | 63.7 | 65.8 -> 64.7 | -1.1 |
| ASHB | subway | island | 26.0 | 25.9 -> 27.0 | +1.1 |
| SHAY | aerial | side | 12.3 | 12.2 -> 13.2 | +1.1 |
| DUBL | median | island | 109.7 | 109.8 -> 110.7 | +0.9 |
| SFIA | aerial | split | 11.4 | 13.3 -> 12.4 | -0.9 |
| MCAR | median | island | 34.6 | 34.9 -> 35.6 | +0.7 |
| SBRN | trench | island | 2.6 | 3.0 -> 3.6 | +0.6 |
| WARM | surface | island | 14.3 | 15.8 -> 15.3 | -0.5 |
| 24TH | subway | island | 9.2 | 10.7 -> 10.2 | -0.5 |
| PCTR | median | island | 17.0 | 18.3 -> 18.0 | -0.3 |
| BERY | aerial | island | 35.9 | 36.6 -> 36.9 | +0.3 |
| COLS | aerial | island | 14.4 | 15.2 -> 15.4 | +0.2 |
| FRMT | aerial | island | 22.8 | 23.7 -> 23.8 | +0.1 |
| MLBR | surface | side | 4.0 | 5.1 -> 5.0 | -0.1 |
| WDUB | median | island | 105.7 | 106.6 -> 106.7 | +0.1 |
| PITT-T | new | island | 34.2 | - -> 35.2 | - |

| structure | track km (M2) |
|---|---|
| aerial | 98.9 |
| bored | 11.5 |
| bridge | 8.9 |
| cutcover | 70.1 |
| embankment | 14.1 |
| grade | 168.6 |
| median | 116.8 |
| portal | 2.8 |
| trench | 8.0 |
| tube | 11.7 |


### Researched heights vs the solved profile (anchor = street/ground + rel; solved at the platform centre)

| station | rel | target | solved | delta |
|---|---|---|---|---|
| HAYW | +6.0 | 36.6 | 36.3 | -0.3 |
| BAYF | +6.0 | 16.2 | 16.8 | +0.6 |
| SANL | +6.0 | 21.3 | 21.7 | +0.4 |
| COLS | +9.7 | 13.8 | 13.7 | -0.0 |
| FTVL | +6.0 | 16.9 | 17.9 | +1.0 |
| LAKE | -14.0 | -3.9 | -3.9 | +0.0 |
| WOAK | +6.0 | 10.2 | 11.1 | +0.9 |
| EMBR | -20.0 | -16.6 | -16.5 | +0.1 |
| MONT | -18.6 | -9.1 | -9.0 | +0.0 |
| POWL | -18.2 | -6.7 | -6.7 | +0.1 |
| CIVC | -19.8 | -4.8 | -4.8 | +0.1 |
| 16TH | -13.1 | -3.3 | -3.3 | +0.0 |
| 24TH | -13.1 | 9.2 | 9.2 | +0.0 |
| GLEN | -11.6 | 41.4 | 41.5 | +0.1 |
| DALY | +6.0 | 86.4 | 91.9 | +5.5 |
| BERY | +9.7 | 35.9 | 35.9 | +0.0 |
| 12TH/upper | -17.0 | -3.9 | -3.8 | +0.1 |
| 12TH/lower | -27.0 | -13.9 | -13.7 | +0.2 |
| 19TH/upper | -17.0 | -9.4 | -9.4 | +0.1 |
| 19TH/lower | -27.0 | -19.5 | -16.4 | +3.0 |
| ASHB | -11.0 | 26.0 | 26.0 | +0.0 |
| DBRK | -11.0 | 46.1 | 46.1 | +0.0 |
| NBRK | -7.0 | 26.3 | 23.1 | -3.2 |
| PLZA | +6.0 | 20.5 | 22.0 | +1.4 |
| DELN | +6.0 | 25.4 | 26.6 | +1.2 |
| CONC | +6.0 | 37.1 | 35.7 | -1.4 |
| PHIL | +6.0 | 32.4 | 33.4 | +1.1 |
| WCRK | +6.0 | 59.9 | 60.0 | +0.1 |
| SSAN | -10.0 | 14.7 | 14.7 | -0.0 |
| SBRN | -8.6 | 2.6 | 2.6 | -0.0 |
| SFIA | +9.0 | 11.4 | 11.4 | -0.0 |

Misses > 1 m, explained: **19TH lower +3.0** (the K-line portal at 23rd St is 460 m north of the platform: at 4 % the
lower level can't be deeper than ~street-21 m); **DALY +5.5** (the anchor was a typical-aerial guess; the lidar and
the Colma / Balboa Park approaches decide); **NBRK -3.2** (north portal ~0.7 km away + Ohlone Greenway grades);
PLZA/DELN/PHIL/CONC within 1.5 m (anchors were typical values, except CONC's measured +6.96 m).

### Answers to requests

- **Stations**: (1) platform top 0.991 m: done. (2) Your depths are anchors (table above); Market St: MONT/POWL/CIVC/
  EMBR rails 18-20 m below the street, 12th St upper street-16.8 / lower street-26.7, 19th St upper street-17.1 /
  lower street-24.1 (see above). (3) Platform s-ranges: from the OSM platform geometry, both faces of an island share
  one extent; berths per direction in `platforms[].berth`. (4) Types/layouts: adopted your list (+ research A/B/C);
  SHAY/UCTY/FRMT are `aerial` with `platformStructure: "embankment"`; per-station reasoning in `stations[].note`.
- **Infra**: (1) Tube centres 8.03 m done; the Oakland box already has ~5.5 m in OSM; Market St and Mission St run in
  twin bores ~14 m / 9-10 m apart in OSM (kept); Berkeley Hills: kept OSM's ~20 m because sources disagree (15.2 m
  Wikipedia vs 30 m narrowing to 17 m at the portals, Rogers & Peck): tell me if you want 15.2 m and I'll move them.
  (2) Tube extent: done by geometry (tube 5.83 km, SF bores 560 m, Oakland box ~1.1 km to the portal near 7th St).
  (3) consistent platform ranges: done. (4) `median`: done. (5) third-rail side: 5th plane / `frame().third`
  (rule-based). (6) smoother profiles: hard 4 % + 800 m vertical curves; the West Oakland portal now descends a smooth
  4 % from the aerial through the trench into the portal.
- **Trains**: GTW 2/6 wording fixed; `cars` for eBART legs = GTW units.

**M1 v0: READY (2026-09-26 00:50).** Everyone can build on it now:

- `data/pub/v2/metro/network.json` (0.3 MB) + `tracks.bin` (1.1 MB zlib): 374 physical tracks (57 main, 102
  crossovers, 177 yard, sidings/spurs; 511 km of track in total), 578 junctions, all 50 stations (+ the eBART
  transfer platform `PITT-T`), 7 lines, 34 GTFS patterns with exact track paths (per vehicle leg).
- `data/pub/v2/metro/timetable.json` (1.3 MB): all 3,762 train trips of every service in the Aug 2026 – Jan 2027 feed,
  per-leg stop times (eBART DMU leg split at Pittsburg/Bay Point), consist lengths (heuristic), bus bridges.
- `MetroNet` works in the game (through `Stream`) and in plain pages (`load({ base: '/data/v2/' })`).

## API (short; full in notes/bart-data.md)

```js
await MetroNet.load();                              // network + tracks
MetroNet.frame('M2', s, out)                        // x,y,z top of rail; tangent/right/up (banked); grade, cant, struct, vlim, cover
MetroNet.point(track, s, lat, up)                   // lateral/vertical offsets in the banked frame
MetroNet.nearest(x, z, r) / nearAll(x, z, r)        // {track, s, dist, lat}
MetroNet.pathFor('yellow', 1) / pathFor('red-S-0')  // {legs: [{length, stops[{station, d}], frame(d), locate(d)}]}
MetroNet.stationsNear(x, z, r) / stationById.EMBR   // platforms: {track, s0, s1, side, y, rail, gtfs}
MetroNet.inTunnelAt(x, y, z)                        // tunnel / underground station test
await MetroNet.loadTimetable(); MetroNet.tripsOn('20260928')
```

## How to preview

`python3 tools/devserver.py 8131` then http://localhost:8131/preview/metronet.html (map colour by structure, line, speed,
grade or class; hover any track; the bottom strip is the vertical profile of the selected pattern; `3D` button).

## Open problems (v0) → M2

- Vertical profile is rough (ground + structure offset + 4 % clamp). Tunnels/aerials/portals/Tube depths not researched.
- Freeway medians not detected yet (show as `grade`); portals are the last 35 m of each tunnel.
- Platform extents are s ± 106.7 m around the GTFS stop; platform sides from OSM geometry (a few `split` misfires).
- Consist lengths heuristic; station descriptions, ridership, levels: M2.
- Helper tracks at junctions are named `X-main.N` (ids may change: use `pathFor`/`stationById`, not literal ids).

## Assumptions

See the table in notes/bart-data.md (platform height, transfer timings, grades, speed limit model, consists).

## Requests for other workstreams

- **sim**: the timetable's `legs[k]` align with `patterns[pat].legs[k].stops`; a trip's DMU leg and EMU leg are separate
  vehicles. Include yesterday's trips after midnight (times > 86400).
- **infra**: `tracks[].structure` + per-sample `ST` codes drive guideway type; `cover` gives aerial clearance / tunnel
  cover; junctions give turnout points. Heights will change in M2 (don't bake them into caches).
- **stations**: `stations[].platforms[]` give track, s-range, side and rail height; `entrances[]` from GTFS + OSM.
- **world**: the corridor to cover = every track in network.json (bbox lat 37.36–38.02, lon −122.47 – −121.77).
