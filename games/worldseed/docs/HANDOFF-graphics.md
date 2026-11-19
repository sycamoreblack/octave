# Handoff: graphics quality pass

**Status:** stopped at a clean point. All code below is committed, typechecks, passes the 27 unit tests and builds. The rendering pipeline works end to end. Two tuning problems are open, and the performance comparison still needs a like-for-like run.

## What was asked

Do a deep dive on improving graphics quality: research rendering techniques in code, decide what makes sense for higher-quality visuals, and implement it.

## Research and verdicts

| Approach | Verdict | Why |
| --- | --- | --- |
| **Post-processing (pmndrs `postprocessing` + N8AO)** | **Adopted** | Mature WebGL stack. `postprocessing` 6.39.6 supports three r168–r187 and merges effects into few passes. N8AO is the AO usually recommended with it. Gives contact shadows, bloom, a grade and better AA without per-object work. |
| **Image-based lighting from the procedural sky (PMREM)** | **Adopted** | Ambient light comes from the actual sky colours instead of a flat hemisphere. The forum consensus is to capture on change, not every frame, which is how it's implemented. |
| **Height fog + sun in-scattering (aerial perspective)** | **Adopted** | Classic, cheap, art-directable. Implemented with the closed-form mean of exponential height fog along each ray (as in Wenzel 2006 and Hoffman & Preetham 2002). LUT-based atmospheres (Eurographics 2023) are overkill for a stylized look. |
| **Procedural detail in shaders (noise, strata)** | **Adopted** | "Rendering with code" where it fits: per-pixel world-space noise breaks up flat facets with no textures to ship. |
| **Procedural clouds in the sky shader** | **Adopted** | A 2D noise layer on a curved sky plane, with one extra sample toward the sun for lighting. Near-free compared with raymarched volumetrics. |
| **WebGPU renderer + TSL node post-processing** | **Not now** | Usable, but the API is still moving: `PostProcessing` became `RenderPipeline` in r183, and some sources still mark it experimental. `EffectComposer` passes and our `onBeforeCompile` patches (wind, growth, ground detail, fog chunks) don't carry over and would all need rewriting as TSL nodes. Revisit when GPU-driven features (compute grass, GPU culling) are wanted. |
| **Raymarched SDF / full "code-rendered" world** | **No** | Gameplay needs meshes for collision, shadows and instancing. Raymarching a whole open world per pixel is too expensive for mobile and the web. It's worth using only locally: the cloud layer is the cheap 2D version of that idea. |
| **Cascaded shadow maps** | **Deferred** | Would give long-range shadows from mountains, but three's CSM patches global light chunks and would interact with our shader patches. Needs its own careful pass. |

Sources:
- [three.js WebGPU post-processing manual](https://threejs.org/manual/en/webgpu-postprocessing)
- [three.js WebGPURenderer manual](https://threejs.org/manual/en/webgpurenderer)
- [three.js r183 render pipeline change](https://app.cinevva.com/news/2026-03-18-threejs-r183-render-pipeline)
- [WebGPU + three.js migration guide (2026)](https://www.utsubo.com/blog/webgpu-threejs-migration-guide)
- [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing)
- [N8AO](https://github.com/N8python/n8ao)
- [HBAO vs N8AO discussion](https://discourse.threejs.org/t/new-ambient-occlusion-example-hbao-vs-n8ao/58847)
- [Animating a PMREM environment (performance)](https://discourse.threejs.org/t/bad-performances-when-animating-a-pmremgenerator-environment/48043)
- [PMREMGenerator docs](https://threejs.org/docs/pages/PMREMGenerator.html)
- [Hoffman & Preetham, GDC 2002](https://drivers.amd.com/developer/gdc/GDC02_HoffmanPreetham.pdf)
- [Wenzel, Real-time Atmospheric Effects in Games (2006)](https://advances.realtimerendering.com/s2006/Wenzel-Real-time_Atmospheric_Effects_in_Games.pdf)
- [Eurographics 2023 LUT-based sky and aerial perspective](https://diglib7.eg.org/bitstream/handle/10.1111/cgf14050/v39i4pp013-022.pdf)

## What's implemented

| File | What it does |
| --- | --- |
| `src/graphics/atmosphere.ts` | Replaces three's fog chunks globally. Adds **height fog** (mist pools low, peaks clear) and **sun/moon in-scattering** (haze glows toward the light). Extra uniforms are plain objects, so they stay shared through three's uniform cloning: one update per frame reaches every material. Installed in `main.ts` before any material compiles. Fed from `World.updateAtmosphere()`. |
| `src/world/sky.ts` | **Cloud layer** in the sky shader. Cover depends on weather (`World.updateClouds`) and thins after restoration. Colours follow the hour. |
| `src/graphics/surface.ts` | **Ground detail** shader patch on the terrain: speckle, soft blotches, strata on steep faces, faded with distance. Note: `patch` is a reserved word in GLSL ES 3.0, so don't use it as a variable name. |
| `src/graphics/environment.ts` | **Sky IBL**: captures the live sky dome into a PMREM. It re-captures only when time of day or restoration changes, and at most every 2 s (`Game.envKey`). `World.setSkyLighting(true)` lowers the hemisphere and fill lights so ambient light isn't counted twice. |
| `src/graphics/post.ts` | **Post stack**: half-float composer, then N8AO (High only, half-res, Low quality mode, transparency-aware off), then bloom (luminance threshold 0.82, mip blur), saturation +0.08, contrast +0.06, ACES tone mapping, vignette, and SMAA last. Sets `renderer.toneMapping = NoToneMapping` while active. |
| `src/world/world.ts` `QUALITY` | Low: none of IBL/post (as before). Medium: IBL + basic post. High: IBL + full post (with AO). |
| `src/world/flora.ts`, `renewal.ts` | Plants use `MeshStandardMaterial` on Medium/High so they receive sky IBL (Lambert on Low). |
| `src/game/game.ts` | `renderFrame()` goes through post when present (photo capture too). Resize and auto-detail call `post.setSize()`. Auto-detail level ≥2 turns AO off along with shadows. |
| `src/types/n8ao.d.ts` | Minimal typings for n8ao (it ships none). |
| `scripts/visual-bench/` | Harness that renders four contrasting worlds from fixed viewpoints and makes a contact sheet (see below). |

## What it looks like now

Compared with the baseline, at fixed viewpoints in four worlds:
- Clouds over every world.
- Bloom on beacons, lanterns, crystals and wisps.
- Soft AO under trees, rocks and figures.
- Visible ground mottling and a richer grade with a vignette.
- Dusk and noon skies read better.

**Open problems found at the last check (fix these first):**
1. **Snow and other bright particles bloom into large blobs** (snowy forest). Options: render weather points after the bloom input (separate layer), or lower their brightness/opacity when post is on, or raise the bloom threshold above 1.0 and push emissives (beacons, lamps, lava) higher to compensate.
2. **The alien world (pale green sky) is hazy and washed out.** Likely causes:
   - Height fog over its low terrain, plus in-scatter toward a pale sky.
   - Sky IBL adding pale green ambient on top.
   - Bloom of the bright sky.

   Try lowering `heightAmount` / in-scatter `glow` for bright-sky worlds, scaling `scene.environmentIntensity` by sky luminance, or clamping bloom on the sky.
3. **Tuning pass** on AO strength (`aoRadius` 3.2, `intensity` 2.4), bloom intensity, and the grade, across all nine biomes, not just the four in the bench.

## Performance: what's known and what isn't

All numbers come from **SwiftShader** (software rendering in headless Chromium), so they show relative cost only. They say nothing about real-GPU frame rates.

- **Baseline:** about 800 ms/frame at 1280×720 High. Measured with `SKIP_SHOTS=1`, which is timing at the starting position.
- **Full pipeline:** about 1,190 ms/frame. Measured *after* the viewpoint shots, a different camera position, so **not like-for-like**. Rerun both with `SKIP_SHOTS=1` (check out the commit before the graphics pass for the baseline).
- First frame with the full pipeline takes about 8 s here (shader compilation); the game already calls `renderer.compile` during loading.
- On real hardware, expect AO and bloom to be the main added costs. Auto-detail already drops resolution, then shadows plus AO, on slow devices. Medium has no AO.

**To verify on a real GPU:** Chrome DevTools performance panel, or `renderer.info` plus frame times, on a mid-range laptop and a phone, at Medium and High.

## How to run the visual bench

```bash
cd games/worldseed
npx vite --port 5173 &                                     # dev server
OUT=/path/to/out TAG=after node scripts/visual-bench/bench.cjs           # shots + timing
OUT=/path/to/out TAG=after SKIP_SHOTS=1 node scripts/visual-bench/bench.cjs   # timing only (like-for-like)
python3 scripts/visual-bench/sheet.py /path/to/out after /path/to/out/sheet-after.png
```

Notes:
- The bench needs Playwright with Chromium. It launches with SwiftShader flags and expects the dev server on port 5173.
- It uses `window.__worldseed.game` debug access, including private fields via bracket access (`follow['initialized']`, `game['renderer']`).
- It forces a GPU sync with a 1-pixel `readPixels`, because `gl.finish()` doesn't block in headless Chromium.

## Suggested next steps (in order)

1. Fix the two open problems above and run a tuning pass across all biomes; recapture the contact sheets.
2. Like-for-like timing (before vs after, `SKIP_SHOTS=1`), then real-GPU checks.
3. Add a "Post-processing" toggle or an "Ultra" preset in settings, so players can trade AO and bloom against frame rate independently of geometry detail.
4. Optional extras, ranked by value:
   - Foliage back-lighting (wrap/translucency when the sun is behind leaves).
   - Water reflecting the sky environment map.
   - Cascaded shadows for High.
   - God rays at dusk (pmndrs `GodRaysEffect` with the sun as the source).
5. Update `README.md` (graphics section) and `ROADMAP.md` once the tuning lands.
