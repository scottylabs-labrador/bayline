# Bayline v2: "Photoreal Bay" (read after SPEC.md; this file wins where they differ)

v1 shipped one 9 MB HTML file with a 64 m procedural world. v2 turns it into a streamed, photoreal
replica of the corridor: real 0.6 m NAIP aerial photography draped on high-res terrain, real
buildings with photo roofs, real tree positions, a physically based sky and atmosphere with the
Bay's marine layer, a post-processing pipeline, and a train-control stack that works flawlessly.
The server has unlimited bandwidth: stream generously, but only what the camera needs.

## Delivery

- `dist/index.html` is small: markup, three.js, and all code, plus NO big data. Everything else is
  fetched from `DATA = window.BAYLINE_DATA || './data/v2/'` (relative to the page).
- Data is built locally by `tools/*` into `data/pub/v2/` (gitignored, never committed), then
  published with `tools/publish_data.sh` into the server volume that nginx serves at `/data/v2/`
  (immutable, long cache). Files must never change in place: when a format or content changes,
  write it under a new name or bump `v2` → `v3`.
- Dev server: `python3 tools/devserver.py` serves http://localhost:8123/ with `/` = `dist/index.html`
  and `/data/v2/` = `data/pub/v2/`. Screenshots: `node tools/shot.mjs "http://localhost:8123/#auto&..." out.png --gpu`.
- Existing small core data (track.bin, track.json, timetable.json, terrain.bin 64 m fallback) moves to
  `data/pub/v2/core/`. `Data.bin(name)` / `Data.json(name)` keep working (they now fetch `core/NAME.ext`).
- Generic loader (lead, `03_stream.js`): `Stream.bin(path, prio)` → Promise<Uint8Array> (inflated
  if the file is zlib; see formats), `Stream.json(path, prio)`, `Stream.image(path, prio)` → Promise<ImageBitmap>,
  `Stream.range(path, off, len, prio)` → Promise<Uint8Array> (HTTP Range). ≤ 8 requests in flight, highest
  priority (lowest number) first, `Stream.cancel(path)` drops queued requests, retries with backoff.
  Use it for every fetch so the network stays orderly.

## World tiling (shared by all tile products)

- World square: `X0 = -45056`, `Z0 = -49152`, `SIZE = 102400` m (same as terrain.bin). Level L tile size
  `T = SIZE / 2**L`: L0 102.4 km … L4 6.4 km, L5 3.2 km, L6 1.6 km, L7 800 m, L8 400 m.
- Tile (L, tx, ty) covers `X ∈ [X0 + tx·T, X0 + (tx+1)·T)`, `Z ∈ [Z0 + ty·T, Z0 + (ty+1)·T)`; ty grows
  southward (+Z). Because `Geo.ll2w` is linear in lon/lat, every tile is an exact lon/lat rectangle:
  `lon = -122.10 + X / 88542.2`, `lat = 37.40 - Z / 110985.1`.
- Coverage (what exists): L0–L5 everywhere; L6 within 10 km of the track centreline; L7 within 3 km of the
  track or 1.5 km of a landmark; L8 within 1 km of the track or 600 m of a landmark. `tiles/index.json`:
  `{ version, levels: { "6": [[tx,ty],...], "7": ..., "8": ... }, products: {...} }` (L0–L5 implied complete).

## Tile products (paths relative to DATA)

| product | path | levels | format |
|---|---|---|---|
| imagery | `tiles/img/L/tx_ty.jpg` | 0–8 | 512×512 JPEG, north up, pixel centres at `(u+0.5)/512` of the tile; colour-balanced NAIP |
| heights | `tiles/h/L/tx_ty.bin` | 0–7 | 129×129 samples at `X0+tx·T+i·T/128` (edges shared with neighbours); `q = round((h+200)·16)` uint16, row-major (i fastest), stored as MED-predicted zigzag residuals (exactly the terrain.bin predictor), then zlib. Carved along the track like `bake_world.py` |
| masks | `tiles/m/L/tx_ty.bin` | 0–7 | 128×128 RGBA uint8 (cell centred), zlib. R water 0–255 (soft shore), G night-light intensity 0–255 (streets and buildings), B tree-canopy fraction, A landcover class (0 grass/natural, 1 farmland, 2 marsh, 3 salt pond, 4 beach/sand, 5 rock, 6 pavement/urban, 7 forest) |
| trees | `tiles/t/7/tx_ty.bin` | 7 | zlib of: uint32 n, then n × 8 bytes: uint16 x, uint16 z (tile-local, `T7/65536` m units), uint8 crown radius (0.1 m), uint8 height (0.25 m), uint8 kind (0 oak, 1 redwood, 2 eucalyptus, 3 palm, 4 sycamore, 5 cypress, 6 pine, 7 street/deciduous, 8 fanpalm), uint8 tint 0–255 |
| buildings | `tiles/b/...` | towns agent's choice | documented in `notes/towns.md` |

L8 has imagery only; renderers use the L7 heights/masks for it (UV-scaled). A missing tile means "use the
nearest ancestor", never an error.

## Runtime modules

| file | owner | role |
|---|---|---|
| `03_stream.js` | lead | fetch queue, cache, decode (above) |
| `11_sky.js` | atmosphere agent | physically based sky dome, sun/moon, clouds, marine-layer fog field; exports GLSL chunks (`Sky.glsl`: `skyRadiance(dir)`, `sunDir`, `fogDensity(wp)` …) other shaders may include |
| `12_terrain.js` | lead | chunked LOD terrain: per-tile mesh, height/mask/imagery textures with ancestor fallback, water, night lights, near-camera detail |
| `14_post.js` | atmosphere agent | render pipeline: MSAA HDR target + depth, SSAO, aerial perspective and fog, bloom, ACES + grading, vignette; `Post.render()` replaces `renderer.render` |
| `30_towns.js` | buildings agent | streamed real buildings with photo roofs |
| `61_flora.js` | vegetation agent | streamed real trees (uses `Life.createTrees` or its own instanced models) |
| everything else | lead | as before |

Terrain API (lead) that other modules rely on:
- `Terrain.h(x, z)`: height from the finest data loaded (fallback: the 64 m field).
- `Terrain.hasDetail(x0, z0, x1, z1)`: true when L7 heights for that rectangle are loaded.
- `Terrain.ensure(x0, z0, x1, z1)`: Promise, resolves when L7 heights for the rectangle are loaded.
  Build anything that sits on the ground only after this, so buildings and trees never float or sink.
- `Terrain.imagery(x, z)`: `{ tex, x0, z0, size }` for the finest loaded imagery covering (x, z), used
  for photo roofs (UV = `(X - x0) / size`, `(Z - z0) / size`). Textures stay alive while referenced;
  call `Terrain.retain(tex)` / `Terrain.release(tex)` if you keep one.
- `Terrain.isWater(x, z)`, `Terrain.maskAt(x, z, ch)`, `Terrain.urbanAt(x, z)`, `Terrain.update(camera)`, `Terrain.group`.

## Art direction v2

"Chillingly similar." Ground truth is the photograph: anything built on top (buildings, trees, roads,
water) must agree with what the NAIP image shows at that spot. Physically based light: ACES, exposure
from sun elevation, no clipped whites at noon. Aerial perspective: distant hills go blue-grey, and the
sun side glows. The Bay's signature weather: afternoon/evening marine layer pouring over the coastal
ridge and through the Golden Gate and San Bruno Gap, burning off by late morning. Night: sodium and LED
street grids, lit windows, glowing bridges.

## Budgets

60 fps on an M1/M2 laptop at 1440p with high settings; quality tiers auto-degrade (SSAO off, lower
shadow size, fewer tiles) below ~45 fps. ≤ 1500 draw calls. GPU texture memory ≤ ~600 MB (LRU caches).
Main-thread work per frame ≤ 4 ms for streaming and building (time-sliced). Decode images with
`createImageBitmap` (off the main thread) and inflate with `DecompressionStream`.
