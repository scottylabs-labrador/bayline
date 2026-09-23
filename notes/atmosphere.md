# Atmosphere, sky & post (atmosphere agent)

Files: `src/js/10_env.js` (renderer, time, sun/moon, lights, adaptive shadows, PMREM), `src/js/11_sky.js`
(physically based sky, clouds, marine layer, weather), `src/js/14_post.js` (render pipeline),
`preview/atmosphere.html` (standalone test bed on the real 64 m Bay terrain).

## What it does

- **Sky.** Single-scattering Rayleigh, Mie and ozone over a spherical planet. A transmittance LUT is built on
  the CPU at startup (256×64, optical depth to space). The sky is baked into a 512×256 HDR equirect whenever the
  sun, haze, camera-altitude bucket or night state changes (one cheap pass). The dome, `skyRadiance(dir)`
  (reflections), the PMREM environment map and the aerial perspective all come from the same model. The sun disk
  has limb darkening and atmospheric reddening. The moon is real size, with lunar phase and position from the
  date. Stars twinkle. At night, the Bay's orange light pollution hugs the horizon.
- **Clouds.** A cumulus deck (1.6–2.3 km, three slices, so tops are domed, bases darker, with silver linings) and
  a cirrus veil (9 km). Both drift with the sea breeze (WNW). Cloud shadows sweep across the land.
- **Marine layer ("Karl").** The fog is a density field with a volume:
  - A 256² reach map is derived from the terrain by a minimax flood from the open Pacific. It stores the ridge
    height the fog must overtop to reach each 400 m cell, and how far it has travelled over land or bay.
  - So the fog pours through the Golden Gate and the San Bruno Gap first, spills over the coastal ridge when it
    is deep, and almost never reaches the South Bay.
  - Daily schedule: deep at night (top about 480 m, about 16 km inland), burns off by late morning, sits
    offshore in the afternoon, and advances again from about 16:30.
  - Strength varies by month and by a deterministic hash of the date.
  - It is raymarched at half resolution (16 steps on high), with sun-side billow shading and forward-scatter
    glow. At night, fog over the towns glows orange; over the ocean it stays blue-grey.
- **Weather.** `Env.state.weather = 'auto' | 'clear' | 'fog' | 'cloudy' | 'haze'`. Auto picks a
  deterministic daily fog, cloud, cirrus and haze mix from the date and season, so every multiplayer client
  agrees. `Sky.weather` and `Env.state.wx` report today's values.
- **Aerial perspective.** Analytic exponential-atmosphere in-scattering from the camera to each pixel (from
  depth), with sun reddening from the LUT, so distant hills go blue-grey and the sun side glows. `scene.fog`
  is now `null`; nothing should add material fog.
- **Post.**
  - HDR half-float MSAA target with resolved logarithmic depth.
  - SSAO: half resolution, 12 taps, bilateral blur, joint-bilateral upsample; fades out beyond ~1 km.
  - Marine-layer raymarch, then a composite: AO, cloud shadows, aerial perspective, clouds, fog.
  - Bloom: 6-level mip chain with firefly tamer, stronger at night.
  - ACES (same fit as three's) with exposure from `Env.state.exposure`, then grading: golden-hour white
    balance, split toning (cool shadows, warm highlights), slight saturation, vignette, fine grain.
  - `Post.setQuality('low')` swaps MSAA for FXAA and drops SSAO.
- **Shadows.** The frustum follows the camera: ±90 m at street level, growing with altitude to ±2.2 km.
  - It is quantised in size (×1.35 steps) and pushed ahead of the view.
  - It is snapped to shadow texels in the light's own basis, so there is no swimming.
  - `normalBias` = 1.15 texels; `bias` = −(0.015 m + 0.25 texel) over the shadow depth range, so both scale
    with frustum size. Verified clean on flat receivers at street level: shadows on vs off matched within ±2
    luminance.
  - Shadow-map size is 4096 on high, 2048 otherwise.
- **Exposure.** Calibrated so a sunlit 18% grey reads mid-grey at noon (aerial-photo albedos ≈ 0.1–0.25):
  0.66 at noon, 0.84 at low sun, 1.2 in twilight, 1.85 at night (lights pop, sky deep blue).

## API

```
Env      (unchanged API) + Env.moon, Env.moonDir; Env.state: { exposure, moonPhase, moonDir, weather, wx, shadowSize, ... }
Sky.glsl            GLSL chunk: uniforms + skyRadiance(dir), skySunTrans(h, mu), skyPhaseR/M/HG(mu), skyEquirectUV/Dir
Sky.glslFx          GLSL chunk (needs Sky.glsl): skyScatter, skyAerial, skyCloudDens(H), skyCirrus, skyFogReach, skyFogDensity, skyFogGlow
Sky.uniforms        shared live uniforms (Object.assign into your material's uniforms)
Sky.update(dt, camPos)       (called by Env.update)
Sky.sunLight {color, intensity}   Sky.ambient (Color)   Sky.weather   Sky.debug {fogDens, clouds}
Sky.rebuildFogMap()          re-derive the marine-layer reach map (auto-built once terrain heights exist)
Sky.transmittance(h, mu)     CPU sun transmittance [r,g,b]
Post.render(dt)              replaces renderer.render(scene, camera)
Post.setQuality('high'|'medium'|'low')   Post.quality   Post.enabled   Post.stats {calls, triangles}   Post.debug {ao, fog, msaa}
```

Uniform scale: `skyRadiance()` and `uSkySunColor` are in scene units, the same HDR scale as lit materials.
The overhead sun gives ≈ 3.1 irradiance, and a mid-grey sunlit surface ≈ 0.2 radiance.

## Integration for lead (exact steps)

1. **90_main.js, the render call.** Replace
   ```js
   Env.renderer.render(Env.scene, Env.camera);
   ```
   with
   ```js
   (typeof Post !== 'undefined' && Post.enabled) ? Post.render(dt) : Env.renderer.render(Env.scene, Env.camera);
   ```
2. **90_main.js, adaptive quality** (optional, recommended). In the fps monitor, before touching the pixel
   ratio:
   ```js
   if (avg > 0.024) { if (Post.quality === 'high') Post.setQuality('medium'); else if (Post.quality === 'medium') Post.setQuality('low'); else /* then lower DPR as today */ }
   else if (avg < 0.012 && Post.quality !== 'high') Post.setQuality(Post.quality === 'low' ? 'medium' : 'high');
   ```
   Changing quality rebuilds the targets on the next frame. It also switches the shadow map between 4096 and
   2048.
3. **Draw-call readouts.** Post sets `renderer.info.autoReset = false` and resets it at the start of each
   frame, so `renderer.info.render.calls` / `triangles` cover the whole frame, including about 20 post draws.
   You can also read `Post.stats`.
4. **Terrain water, and any shiny surface that should reflect the sky.** In `onBeforeCompile`:
   ```js
   Object.assign(sh.uniforms, Sky.uniforms);
   sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + Sky.glsl);
   // then in the shader: vec3 refl = skyRadiance(reflect(-viewDirWorld, nWorld));
   //                     sun glint: uSkySunColor * pow(max(dot(refl, uSkySunDir), 0.0), 800.0) * k
   ```
   `skyRadiance` takes a world-space direction and is one texture fetch.
5. **Weather UI** (optional). Set `Env.state.weather` to one of `'auto'`, `'clear'`, `'fog'`, `'cloudy'` or
   `'haze'`.
6. **Nothing may set `scene.fog`.** Materials with `toneMapped: false` (Bay Lights, glows) are now tone mapped
   by the final pass along with everything else. They stay bright and bloom.
7. **Marine layer and terrain.** The reach map builds itself once `Terrain.h` returns real heights (it probes
   San Bruno Mountain). If the terrain changes a lot later, call `Sky.rebuildFogMap()` once.
