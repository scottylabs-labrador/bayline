# Bayline Metro: INFRA workstream status

Owner: infra workstream. Branch `bart-infra`, worktree `.worktrees/bart-infra`, dev port 8134.
Files owned: `src/js/23_metrotrack.js`, `src/js/24_metro*.js`, `preview/metrotrack.html`, `notes/bart/infra.md`,
`notes/bart/shots/infra/`, plus small, clearly marked hooks in `10_env.js`, `12_terrain.js`, `13_gfx.js`, `14_post.js`,
`90_main.js` (underground support). Everything is behind `#metro=1`.

## Status

- 2026-09-26 00:40: started. Read the engine (env, terrain, post, trackgeo, main loop). Research running.

## Plan (M1 → M2)

1. Research BART track and structure standards (dimensions below, with sources and assumptions).
2. `23_metrotrack.js` (`MetroTrack`): streamed guideway generator over MetroNet tracks: chunks ≤ 500 m per track,
   time-sliced jobs (≤ 3 ms/frame), three LOD rings (near full detail, mid simplified, far silhouette), merged
   materials. Rails (broad gauge 1,676 mm), direct fixation / ties on ballast, third rail with coverboard and
   insulators, aerial box girders + columns by era, parapets, walkways, retaining walls, trenches, medians, fences.
3. `24_metrotube.js`: bored tunnels, cut-and-cover boxes, the Transbay Tube (twin bores + gallery), portals,
   tunnel lights, walkways, cable trays, cross passages.
4. `24_metrounder.js` (`Under`): the underground engine: cells + portals, portal-based visibility, the
   "under map" (a camera-centred clipmap of underground volumes that every lit material reads so daylight never
   reaches inside a tunnel), terrain cut-outs at portals and entrances, underground exposure and post.

## APIs (draft, will be finalised at M1)

### Underground cells and portals (for STATIONS, `26_metrostations.js`)

```js
Under.addCell({ id, kind: 'station'|'tunnel'|'tube'|'shaft',
  poly: [[x, z], ...],            // footprint (world metres), any winding; or strip: { pts: [[x,y,z],...], half: m }
  floor, ceil,                    // world Y (m ASL) of the lowest floor / highest ceiling inside the cell
  ambient: [r, g, b],             // average artificial light inside (linear, hemisphere-light units), lights materials here
  group })                        // optional THREE.Object3D: hidden when portal visibility says the cell can't be seen
Under.addPortal({ a: cellId, b: cellId | null /* null = outdoors */, quad: [[x,y,z] x 4], day: 0..1 })
Under.addCut({ id, poly: [[x, z], ...], below: y })   // terrain hole (stair wells, trench openings): terrain above y inside
                                                       // the polygon is not drawn
Under.remove(id)                  // a cell (and its portals) or a cut
Under.keep(obj)                   // objects that must draw underground while the outdoor world is culled (trains)
Under.state                       // { cell, depth 0..1, outsideVisible, visible: Set<cellId> }
```

## Research: BART infrastructure facts (dimensions, sources, assumptions)

(in progress)

## Costs

(to be measured: High tier, same views with `metro=0` vs `metro=1`)

## Preview

(to come) `preview/metrotrack.html`, in-game `#auto&metro=1&...`

## Open problems

## Requests for other workstreams

- DATA: per-segment structure types and portal positions (tunnel=yes spans from OSM), the Transbay Tube profile,
  a `side` for the third rail if known (else I derive it: BART's contact rail is on the side away from platforms).
- WORLD: where BART runs at grade or in trenches, the terrain should be carved to the bed (like the Peninsula
  carve); until then I cut the terrain at runtime (Under.addCut) and build retaining walls/embankments to meet it.
