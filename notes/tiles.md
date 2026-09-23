# Tiles (v2 photoreal pyramid): tiles agent notes

## STATUS

**Full pyramid bake in progress** (started 07:13). Watch `data/raw/tiles/bake_full.log`; this section will say FULL when it is done.

- **Registration fix:** NAIP exportImage used to widen the latitude extent to keep square pixels, which misregistered every tile by up to ~50 m. All imagery, masks and trees from before 07:00 were deleted and are being re-fetched with `adjustAspectRatio=false`. Heights were never affected. Verified at Palo Alto: track.bin and the OSM streets sit exactly on the photographed rails and roads.
- **Available now:** imagery for the Palo Alto block (L7 48–50 × 54–56 plus its L8 children) and the Coyote Point block (L7 30–32 × 34–36). Heights L5–L7 are available wherever the bake has reached; L0–L4 are re-derived by decimation afterwards.
- **Being regenerated:** masks and trees, with the final water classifier. Bay glint is filled, low-lying streets and parking lots are no longer water, and salt ponds are landcover 3.

## Format recap (exactly what the files contain)

The world square, tile addressing and coverage are as in SPEC_v2.md. `tiles/index.json` holds `levels["6" | "7" | "8"]` as `[[tx,ty],...]`, and L0–L5 are complete.

- **Imagery** `tiles/img/L/tx_ty.jpg`, L0–8: 512×512 baseline JPEG, quality 87, 4:2:0 subsampling, sRGB, north up. Pixel (u,v) centre sits at X = x0 + (u+0.5)/512·T, Z = z0 + (v+0.5)/512·T.
- **Heights** `tiles/h/L/tx_ty.bin`, L0–7:
  - The zlib-inflated payload is exactly 33 282 bytes: 129×129 little-endian uint16 residuals, interleaved row-major. Row j = north→south, column i = west→east, sample (i,j) at X0+tx·T+i·T/128, Z0+ty·T+j·T/128.
  - The residuals are not split into byte planes the way terrain.bin was.
  - Height = q/16 − 200 m. Values below −200 m (Monterey Canyon at the SW corner of L0/L1) are clamped to −200.
  - Decoder, the same MED predictor as terrain.bin:
    ```js
    const zz = new Uint16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 33282)); // or DataView getUint16(2k, true)
    for (let j = 0; j < 129; j++) for (let i = 0; i < 129; i++) {
      const k = j * 129 + i, z = zz[k], r = (z >>> 1) ^ -(z & 1);
      let a, b, c;
      if (j === 0 && i === 0) { q[k] = r; continue; }
      if (j === 0) { a = q[k - 1]; b = a; c = a; } else if (i === 0) { b = q[k - 129]; a = b; c = b; }
      else { a = q[k - 1]; b = q[k - 129]; c = q[k - 130]; }
      const mx = a > b ? a : b, mn = a < b ? a : b;
      q[k] = r + (c >= mx ? mn : (c <= mn ? mx : a + b - c));
    }   // h = q / 16 - 200
    ```
  - L6 and L7 come from terrarium z15, sampled by the same function, so shared vertices match exactly across L6/L7. L5 comes from z13. L4–L0 are decimated from L5, so they are vertex-exact with L5.
  - Carved along the track as in bake_world.py, with platform and station zones flattened to bed level (Y−1). Tunnels untouched, bathymetry kept.
- **Masks** `tiles/m/L/tx_ty.bin`, L0–7: zlib of 128×128×4 uint8 (65 536 bytes), interleaved RGBA, row-major, north row first. Cell (i,j) centre sits at x0+(i+0.5)·T/128, z0+(j+0.5)·T/128.
  - R water 0–255.
  - G night-light intensity. Streets by class, lit building footprints with commercial brighter, a soft ~12 m glow, and none on water.
  - B tree canopy fraction.
  - A landcover: 0 grass/natural, 1 farmland, 2 marsh, 3 salt pond, 4 beach/sand, 5 rock, 6 pavement/urban, 7 forest.
  - L5–L7 are computed from their own NAIP RGB+NIR plus OSM. L0–L4 (and L5/L6 when all four children exist) are pooled from children. Water, canopy and landcover pool by mean or majority; lights by 0.7·mean + 0.45·max so street grids stay visible from the air.
- **Trees** `tiles/t/7/tx_ty.bin`: zlib of uint32 n (LE), then n × 8-byte records.
  - Record layout: uint16 x, uint16 z (tile-local, in units of 800/65536 m, x east, z south), uint8 crown radius (0.1 m), uint8 height (0.25 m), uint8 kind, uint8 tint.
  - kind: 0 oak, 1 redwood, 2 eucalyptus, 3 palm, 4 sycamore, 5 cypress, 6 pine, 7 street/deciduous, 8 fanpalm.
  - tint 0 = darkest crown in the photo … 255 = lightest.
  - Positions are the intensity-weighted centres of crowns detected in the 0.78 m NAIP imagery, so they line up with the crowns in the photo.
  - No trees within ~11 m (+ half the crown radius) of the track centreline, on water, or inside OSM building footprints.
  - The Palo Alto block has about 2 200 trees per L7 tile.
