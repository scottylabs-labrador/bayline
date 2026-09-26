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

## APIs

### Underground cells, portals and cuts: `Under` (`src/js/24_metrounder.js`), M1 contract

Agreed with STATIONS (their 9 requests of 00:45, answered here; all accepted, notes inline). Every method is a no-op
unless `#metro=1` (`Under.enabled`).

```js
Under.addCell({
  id: 'st:MONT:plat',     // naming: stations 'st:<ID>:<level>' (plat, muni, conc, ent<k>), my tunnels 'tn:<track>:<k>',
                          // the Transbay Tube 'tb:<k>', portals 'pt:<...>' (ids are global: a second addCell with the same
                          // id replaces the first)
  poly: [[x, z], ...],    // footprint, world metres, any winding, simple polygon, up to 256 vertices
  // or strip: { pts: [[x, y, z], ...], half: m }   (a centreline strip: my tunnels)
  floor, ceil,            // world y (m ASL): lowest floor/track and highest ceiling of the cell (I pad both by 0.5 m)
  ambient: 0.8,           // average bounce light of the cell's fixtures, hemisphere-light units (see "Exposure" below);
                          // every lit material inside the cell's volume picks it up (trains, people, anything)
  daylight: [yBot, yTop], // optional (request 3): daylight 1 at yTop .. 0 at yBot inside this cell (entrance shafts)
  group,                  // optional Object3D: .visible follows portal visibility while the camera is underground
})
Under.addPortal({ id, a: cellId, b: cellId | null | 'auto', quad: [[x,y,z] x 4], probe: [x,y,z] })
  // any planar convex quad, any winding, any slope (request 8): horizontal slab openings, vertical tunnel faces and
  // sloped escalator wells all work (visibility projects the 4 corners, clipped to the near plane).
  // b: null = outdoors; 'auto' = whatever cell contains `probe` (resolved every frame, so a station can stream in
  // after my tunnel); unresolved 'auto' portals count as outdoors (safe: nothing is culled through them).
Under.addCut({ id, poly: [[x, z], ...], below: y })   // terrain above y inside poly is not drawn (request 7: `below` =
  // the well/trench floor; up to 256 vertices; no limit on the count, 64 alive at once is fine)
Under.remove(id)          // a cell (and every portal that names it), a portal or a cut
Under.cellAt(x, y, z)     // -> id | null (request 2): the cell whose poly contains (x, z) with floor <= y <= ceil
Under.keep(obj)           // top-level objects that must keep drawing while the outdoor world is culled (metro trains)
Under.state               // { cell, depth 0..1, outsideVisible, visible: Set<cellId>, daylight }
```

- **Stacked cells** (request 1): fine. The under map stores per column the lowest floor and highest ceiling of every
  cell over it (the slabs between stacked levels are solid, nothing draws there), the largest ambient, and the
  entrance daylight ramp; `Under.state.cell`/`cellAt` pick the cell by y exactly (CPU side, real polygons).
- **Tunnel-to-station portals** (request 2): I add them myself: each tunnel end gets `b: 'auto'` with a probe 2 m past
  the tunnel face. Station boxes ending at platform ends + 12 m, open to the full tunnel cross-section: agreed.
- **Station ends** (request 9): agreed. Inside `MetroStations.limits(id)` STATIONS builds the box / aerial deck and
  bents / trackway slab and undercar trench; I build rails, fastenings, third rail + coverboard + insulators through
  the station (third rail on the side away from the platform), and nothing else. My aerial girders end on your end
  bents (I stop girders at s0/s1 and skip my columns inside). Until `limits` exists I use MetroNet platform ranges
  + 12 m.

### GLSL hook (request 5)

When `#metro=1`, every lit built-in material (MeshStandard/Physical/Lambert/Phong, including ones with their own
`onBeforeCompile`, because the patch lives in `THREE.ShaderChunk`) gets, in `lights_pars_begin`:

```glsl
vec3 blUnderWorld(vec3 viewPos);   // view -> world position (undoes the earth-curve bend of 00_util.js)
vec4 blUnder(vec3 worldPos);       // x: inside an underground volume (0..1), y: daylight (0..1), z: ambient, w: 0
```

and at the top of `lights_fragment_begin` the locals `vec3 blUW` (world position) and `vec4 blU = blUnder(blUW)`, so
code appended after `#include <lights_fragment_begin>` can use them. The patch multiplies directional lights (sun,
moon), hemisphere, ambient/probe and IBL (diffuse and specular) by the daylight factor, and adds
`blU.z * UNDER_TINT` (neutral ~4000 K) to the indirect diffuse (and a little to the specular so metal isn't black).
Point/spot lights and emissive are untouched. Outside any cell, `blU = (0, 1, 0, 0)` and nothing changes.
(M2, request 6: `Under.addLights(cellId, [{ a, b, color, intensity, radius }])`, the nearest ~8-12 line lights
evaluated in the shared patch for fragments inside volumes: accepted, send the GLSL; I'll wire the uniform plumbing.)

### Exposure underground (request 4)

`Env.state.exposure` blends by `Under.state.depth` to a fixed **1.0** (same day and night); eye adaptation may lift
up to **×4 (2 EV)** underground (outdoors it stays 2.1 by day, 1.3 at night) and never darkens more than today. The AE
key is unchanged (0.1): a view whose centre-weighted log-average luminance is ~0.1 at exposure 1.0 (a platform with
albedo ~0.35 under ~0.9 units of irradiance) needs no adaptation. Street daylight seen from an entrance blows out.

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
