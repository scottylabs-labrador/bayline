# Flora: every real tree, where the photograph shows it (vegetation agent notes)

`src/js/61_flora.js` (module `Flora`) streams the SPEC_v2 tree tiles (`tiles/t/7/tx_ty.bin`: position, crown radius,
height, species and tint of every tree crown detected in the NAIP photography). It draws them as instanced 3D trees
in three rings around the camera. Beyond the far ring, the ground photo carries the canopy.

| ring | reach (high) | what | draw calls |
|---|---|---|---|
| near | 135 m | full trees: bark tubes (tiling bark textures) + alpha-tested leaf cards (octagons for round clusters), wind sway and leaf flutter, back-lit translucent leaves, crown AO | 1 per species (9) |
| mid | 560 m × species factor (0.5–1.0) | same trees, trunk and main limbs, 1/8 of the leaf cards at 2.75× size | 1 per species (9) |
| far | 1650 m | one camera-facing impostor per tree, rendered from the near model at start-up (4×4 atlas, 256² cells) | 1 |
| shadows | near ring | cheap opaque crown proxies (5 blobs + trunk per species), dappled by a world-space noise in the depth shader. They share the near ring's instance buffer and are invisible in the main pass | 1 per species (9) |

All nine species share one foliage material, and each has a procedural 2048² canvas atlas: leaf clusters, redwood
sprays, pine tufts, cypress clumps, palm fronds, fan leaves and six tileable barks. The species are:
- coast live oak (0): broad, low, spreading
- coast redwood (1): tall spire, bare trunk, drooping sprays
- blue gum eucalyptus (2): tall pale forked trunk, open hanging crown
- Canary Island date palm (3)
- London plane / sycamore (4)
- Monterey cypress (5): wind-swept plates
- pine (6)
- street tree (7)
- Mexican fan palm (8): very tall, dead-frond skirt

Instances are scaled to the data (height and crown radius per tree, clamped to plausible aspect ratios), yawed and
tinted per tree (tint = crown brightness in the photo), and dropped onto `Terrain.h` after `Terrain.ensure()` resolves
for the tile. Trees on the track bed or on a platform are discarded.

## API

```js
await Flora.init(ctx)      // ctx: { renderer?, scene?, quality?: 'high'|'medium'|'low', index?, suffix? }
                           //   renderer/scene default to Env.renderer / Env.scene; the group is added to the scene.
                           //   Reads tiles/index.json (products.t or levels["7"]) to know which tiles have trees.
Flora.update(camPos, env)  // every frame: streams tiles (<= ~1.9 km), rebuilds the rings every ~12 m of movement
Flora.group                // THREE.Group (already in the scene after init)
Flora.hasData(x, z)        // true when a tree tile covers (x, z). Alias Flora.covers (what 30_towns.js calls)
Flora.setQuality(name)     // 'high' | 'medium' | 'low' (radii, capacities, shadows) — call from the auto-degrade
Flora.stats                // { tiles, loading, trees, near, mid, far, rebuildMs, farMs, loadMs, initMs }
Flora.dispose()            // drop all tiles (e.g. after a teleport far away; update() reloads)
```

`90_main.js` already calls `Flora.init(ctx)` and `Flora.update(cp, envArg)`, so no further integration is needed.
Worth adding:
1. `Flora` in `window.__bayline` (debug and screenshot tooling reads `Flora.stats`).
2. The quality auto-degrade should call `Flora.setQuality('medium' | 'low')` together with the other modules.
3. Shared uniforms: the wind reads `U.uWind` (0..1). A gusty afternoon (0.5–0.7) looks great in the eucalyptus.

Dev hook: `window.BAYLINE_FLORA_SUFFIX = '_test'` makes Flora fetch `tiles/t/7/tx_ty_test.bin`. I used this for
NAIP-derived test tiles while the tiles agent re-baked the pyramid. Test tiles live under `data/pub/v2/tiles/t/7/*_test.bin`
and must not be published: `publish_data.sh` should exclude `*_test.*`, or just delete them.

## Coordination

- **Towns** calls `Flora.covers(x, z)` and skips its own trees where tree tiles exist, so there are no double trees.
- **Tiles agent:** tree records must not sit on buildings. The baker has the OSM footprints; the runtime only
  rejects trees on the track bed and platforms. Kinds follow SPEC_v2. When `height` or `radius` is 0, the species
  default is used.
- **Shadows:** near foliage does not cast directly; the proxies do. That keeps the shadow pass to a few opaque blobs
  per tree instead of about 400 alpha-tested cards. Leaves receive shadows in the near ring only (the sun's shadow
  camera covers about ±90 m).

## Performance

Measured in `preview/flora.html` on an M2 (ANGLE Metal), 1400×850. GPU timings used `EXT_disjoint_timer_query`
under heavy machine contention (load average about 20 from other agents' headless browsers), so read them as upper bounds.

| scene | trees loaded | near / mid / far | vegetation draw calls | CPU |
|---|---|---|---|---|
| Palo Alto, 300 m above, real tiles over NAIP L8 | 19,765 | 184 / 1,694 / 13k | 46 (incl. 36 ground-photo quads) | ring rebuild 0.4–1.9 ms every 12 m; far rewrite ~3 ms on tile arrival only |
| Palo Alto street level, real tiles | 19,765 | 89 / 2,399 / 17k | 36 | same |
| stress forest (3.9 trees per 1000 m², like the leafiest Menlo Park blocks) | 40,000 | 234 / 1,831 / 40k | ~30 | ring rebuild 0.4–0.5 ms, far rewrite 6 ms (tile arrival only) |

- **Triangles per tree (near/mid):**

  | species | near | mid |
  |---|---|---|
  | oak | 1.9k | 214 |
  | redwood | 1.9k | 200 |
  | eucalyptus | 1.4k | 156 |
  | Canary palm | 1.7k | 276 |
  | sycamore | 1.6k | 182 |
  | cypress | 0.7k | 206 |
  | pine | 1.2k | 320 |
  | street | 1.1k | 130 |
  | fan palm | 0.3k | 90 |

  Vegetation totals are about 0.3–1.2 M triangles in leafy views.
- **Init:** 0.5–1.6 s, spent on the atlas painting (canvas), 18 model builds and the impostor bake.
- **GPU:** the cost is fill rate (overdraw of alpha-tested cards) when the camera stands inside dense crowns.
  Mitigations already in:
  - octagon cards (about 30% fewer fragments)
  - front-to-back instance order in the near ring
  - near ring drawn first (`renderOrder -2`)
  - interior cards culled
  - mid-ring and impostor shaders skip shadow receiving
  - shadow proxies instead of card shadows (cut the shadow pass by about 60%)

  `setQuality('medium')` narrows the near ring to 95 m, and `'low'` to 55 m with no tree shadows.

## Known limits

- Leaf textures are procedural: convincing at 3 m and beyond, but not photographic at arm's length.
- Species come from the tile baker's classification. The runtime cannot tell a sycamore from an oak by itself.
- Impostors are single-view (no octahedral views), so tall asymmetric trees (cypress, eucalyptus) look the same from
  every side past 560 m.
- Tree tiles only exist at L7 (within about 3 km of the track). Farther away the canopy is the photo.
