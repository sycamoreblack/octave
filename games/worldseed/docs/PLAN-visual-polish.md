# Plan: visual polish (terrain, ground cover, atmosphere, readability)

This plan turns the four requested technique groups into concrete work in this codebase, in a buildable order. It builds on the graphics pass in [`HANDOFF-graphics.md`](HANDOFF-graphics.md) and folds in that pass's open problems (snow over-blooming, washed-out pale skies).

**Design intent.** Every change should help the player *read* the world: where to walk, what is important, what kind of place this is. The intended focal hierarchy is:

1. Pillars of light and waystones.
2. The player and wanderers.
3. Landmarks.
4. Ground and foliage.

Polish that flattens this order is a regression, however pretty.

**Constraints that shape everything below:**
- **No art assets.** Every texture, mesh and colour is generated from the world description at load. Detail textures are made in code too.
- **Three quality tiers** (Low/Medium/High) plus auto-detail. Low must stay cheap enough for phones.
- **Deterministic from the words.** Placement and masks must come from the world seed, so share links reproduce the same world.
- **WebGL2 + three r182 GLSL patches today.** Keep shader logic in small self-contained GLSL functions so a future WebGPU/TSL port is a translation, not a redesign.

---

## 0. Foundations (do first)

### 0.1 A shader patch composer

Today four features each assign `material.onBeforeCompile`: wind (`engine/wind.ts`), growth (`world/renewal.ts`), ground detail (`graphics/surface.ts`) and flapping (`world/fauna.ts`). A second patch on the same material silently replaces the first. Almost everything below adds patches (snow cover, variation, rim light, cloud shadows), so this comes first.

- New `src/graphics/patch.ts`. Provide `patchMaterial(mat, patch)`, where a patch is `{ name, uniforms?, vertex?: Inject[], fragment?: Inject[] }` and an inject is `{ after: '#include <begin_vertex>', code }`.
- Patches stack in order. The program cache key is the sorted patch names, so materials with the same patches share programs.
- **Fail loudly.** If an anchor chunk is missing (a three.js upgrade renamed it), log once with the patch name instead of silently producing an unpatched material.
- Port the four existing patches to it. There should be no visual change.

### 0.2 One baked "ground mask" per world

Several techniques need the same per-location facts: is this spot rock, snow, path, wet, grassy? Compute them **once** at load into a world-space texture so every system agrees: terrain shader, ground cover, flora placement, map, footsteps.

- New `src/world/groundmask.ts`. Bake an RGBA8 texture covering the 1,400 m square at 512² (about 2.7 m per texel; 1 MB):

| Channel | Meaning | How it's computed |
| --- | --- | --- |
| R | rock | Slope (from the height grid), plus ridge noise and cliff edges |
| G | snow | Cold biome or high altitude, upward-facing, sheltered from steep faces. Also driven by weather (`snow`), and restoration can melt it. |
| B | moisture | Distance to sea/rivers (`terrain.rivers.nearest`, liquid line), plus hollows (height below local average), plus the swamp/rain biome factor |
| A | path | Trails from 0.3, softened by a small blur |

- Also keep a CPU copy (`Uint8Array`) for gameplay queries such as `mask.at(x, z)`.
- **Unit-testable** (pure functions over the height grid):
  - Rock appears on steep cells.
  - Snow never appears below the liquid line or in hot biomes.
  - Moisture is highest at river cells.
  - The bake is deterministic per seed.

### 0.3 Trails (environmental storytelling)

New `src/world/paths.ts`. Worn footpaths connect spawn, the wanderers' homes, each landmark and the heart. They are desire lines that quietly teach the player where things are.

- Use A* on a coarse grid (about 8 m cells). The cost is distance plus a slope penalty, with water and cliffs impassable and river crossings costly. Follow with Chaikin smoothing, then rasterise into the mask's path channel with a width of about 1.8 m.
- Paths fade with distance from landmarks, so the open land stays wild.
- Paths affect:
  - Terrain colour and roughness (compacted soil, or a trodden snow crust).
  - Ground cover density (sparse on the path, dense at the edges).
  - Flora placement (no trees on paths).
  - The map, which draws them as faint dotted lines.
- Tests: every landmark is connected, paths avoid water cells, and they are deterministic.

### 0.4 Extend the visual bench

`scripts/visual-bench/bench.cjs` currently covers four worlds and two views. Extend it as follows:
- Cover all nine biomes, each with a fixed prompt.
- Add a third, close-up view at knee height, which is where terrain detail and ground cover are judged.
- Add a `DEBUG=mask` mode that renders the ground mask as false colour, to check splat placement at a glance.
- Always time with `SKIP_SHOTS=1` at a fixed pose, so numbers are comparable between runs.

---

## 1. Terrain surface detail and biome splatting

**Today:** terrain colour is baked per vertex in `Terrain.buildMesh()` (shore, mid, high, rock-by-slope, snowline, river bed, pads). It's then flat-shaded, with `graphics/surface.ts` adding world-space speckle, blotches and strata.

### 1.1 Splatting in the terrain shader (slope, height, moisture, snow, paths)

Move the material *decision* from vertex colours into a terrain material (`src/graphics/materials/terrain.ts`), driven by the ground mask plus per-pixel terms.

- **Layers.** Each biome has four layers from its palette (`groundMid`/`foliageAlt`, `groundLow`, `rock`, snow or sand), each with its own albedo, roughness and detail-texture slot. Vertex colours keep the large-scale gradient (lowlands to highlands, shore). The shader splats layers on top.
- **Per-pixel weights:**
  - Rock from the mask's R channel, sharpened by the facet's true steepness (`dFdx`/`dFdy` normal, which is exact with flat shading).
  - Snow from the mask's G channel times an upward-facing term (`smoothstep(0.6, 0.9, n.y)`), so snow sits on tops and leaves cliff faces bare.
  - Paths from the A channel.
  - Moisture (the B channel) darkens albedo and lowers roughness: wet banks catch sun and sky highlights.
- **Height-blended transitions.** Each layer's detail texture includes a height value. Blend by layer weight *plus* that height (the standard "height lerp"), so rock pokes through snow in its own cracks rather than as a soft cross-fade.
- **Cold, wet and restored states come from the same mask.** Snow-covered worlds get a trodden crust on paths. After the finale, `restoration` melts a share of the snow and turns barren soil green (it lerps the mask's influence), extending the existing renewal.

### 1.2 Triplanar mapping with detail normals and roughness

- **Procedural detail textures.** New `src/graphics/detailTextures.ts`. At load, generate tileable 256² textures from seeded noise, one small set per world, for these material classes:
  - soil and grass grit
  - sand ripples
  - rock grit with cracks
  - snow crust with sparkle
  - mud/wet
  - alien "crystal dust"

  Each is an RGBA texture: normal in xy (z reconstructed), roughness in z, height in w. Render them on the GPU with a tiny full-screen pass (fast), or on the CPU for Low. Enable mipmaps and anisotropic filtering where available.
- **Triplanar sampling.** Project along world x, y and z using the facet normal for blend weights. Use a sharp blend (power about 4) so it stays crisp, and the "whiteout" normal blend so detail follows the facet orientation. That's 3 taps per layer. Only sample layers whose weight is above a small epsilon (an early-out per pixel).
- **Distance fade.** Fully on within about 25 m, gone by about 90 m. This hides tiling at distance, saves fill rate on far terrain, and keeps the faceted low-poly silhouette dominant. At distance, the existing `surface.ts` blotches remain.
- **Tiers:**

| Tier | Detail |
| --- | --- |
| Low | Planar (xz) only, one layer sample, albedo-only grain, no normal |
| Medium | Triplanar normal |
| High | Triplanar normal, roughness and height-blended splats |

  Auto-detail turns triplanar off before it touches resolution.

### 1.3 Contact shadows and grounded props

Floating props are the most visible "CG" tell. Ground them with layered, cheap techniques, so it works without ambient occlusion on Low and Medium:

1. **Shadow tuning.**
   - Bias per tier, with `normalBias` tuned against the terrain cell size.
   - On High: a tighter player-centred shadow frustum (±45 m) at 4096², plus a second, wider, cheaper shadow (a second directional light with a ±220 m frustum at 1024², shadows only) for long tree and landmark shadows. That's a manual two-cascade setup without three's `CSM` global chunk patching.
   - Keep texel snapping (already in `World.update`).
2. **Baked ground AO.** When building the terrain mesh, darken vertices under canopies and around large rocks and structures. Accumulate from flora and collider positions into a small AO grid, then sample per vertex. Forest floors read as shaded. The cost is zero at runtime.
3. **Contact blobs.** A soft radial "AO ring" decal under every tree, crystal, mushroom, rock, landmark base and character:
   - One instanced quad per prop, sharing the flora chunk matrices so each chunk gets a matching blob chunk.
   - Multiplied into the ground, with `depthWrite` off and polygon offset.
   - Faded by distance (gone past about 60 m).
   - The player's and wanderers' blobs follow them and shrink while airborne, which also helps judge jumps.
4. **Props sink and flare.** Bury instance bases slightly (already `-0.15·s`). Add a tiny "root flare" ring of the ground colour on trunks so the intersection line disappears.
5. **N8AO** (High) stays, retuned once 1–4 are in, so it adds fine creases rather than doing all the grounding.

---

## 2. Instanced ground cover and environmental storytelling

**Today:** `world/flora.ts` scatters every kind across the island once at load, in chunked `InstancedMesh`es with wind. At High, grass is at most about 16,000 tufts (scaled down by the world's plant density), spread over 1.1 km, which is thin near the camera.

### 2.1 A camera-following ground cover ring (GPU-placed)

New `src/world/groundcover.ts`. Density belongs near the camera, so cover is placed there:

- **Layout.** A fixed pool of instances laid out on a jittered grid in a ring around the player:

| Tier | Radius | Instances |
| --- | --- | --- |
| Low | 30 m | ~8k |
| Medium | 45 m | ~25k |
| High | 70 m | ~50k |

  The grid snaps to world cells, so as the player walks, instances whose cell leaves the ring wrap to the far side. This is the same idea as the GPU weather box.
- **Placement in the vertex shader. No CPU work per frame.** Each instance's world xz comes from (cell + hash jitter). Height comes from the terrain height texture (it already exists for the water shader). Kind, density and hue come from the ground mask texture at that spot.
  - Grass is suppressed on rock, paths, deep water and snow.
  - Snow tufts and drifts appear on snow.
  - Pebbles appear near paths and shores.
  - Reeds appear where it's wet.
  - Alien fronds and crystal dust appear in alien worlds.

  Instances with zero density collapse to a degenerate triangle (zero cost beyond the vertex shader).
- **Kinds as one geometry atlas.** Each pool uses a single merged geometry containing 4–6 small variants, with the variant selected per instance by hash. One draw call per pool. Use two pools (blades and solids) for different materials, double-sided versus not.
- **Fade at the ring edge.** Scale instances down over the outer 15%. Combined with fog, this makes the boundary invisible: no popping.
- **Wind.** Use the existing `windUniforms` through the patch composer. Add a slow-moving gust field so waves visibly roll across the meadow.
- **Interaction.** Blades within about 1.5 m of the player bend away (pass player position as a uniform). It's cheap and makes the world feel touched.
- **Restoration.** After the finale, a `uBloom` uniform raises density and mixes in flowers, tying into `renewal.ts`.
- The existing scattered grass and flowers become a sparse far layer (about 30% of today's count), and flora chunks get **distance culling**: a per-frame check hides chunks beyond a per-kind range (grass 140 m, flowers 160 m, rocks 450 m; trees always on), in addition to frustum culling.

### 2.2 Silhouette and scale variation

Wide shots look stamped because instances differ only in uniform scale and a brightness tint. Changes in `flora.ts` and the patch composer:

- **Geometry variants.** Build 2–3 variants per tree kind (different seeds, tier counts and canopy blob layouts) and assign one per instance. The extra draw calls cost little thanks to chunking.
- **Non-uniform scale and lean.** Vary height and width independently (for example ±20% height at fixed width). Lean trees downhill on slopes (from the terrain gradient) and toward open sky at forest edges. Crystals cluster at shared angles, like real formations.
- **Per-instance variation attribute.** An `InstancedBufferAttribute` `aVariant` (vec4) carries a hue shift, saturation, roughness and a canopy squash. The shader applies it, so neighbouring trees differ in season and age.
- **Clustering by age.** Big old trees at grove centres, saplings at the edges (use the existing cluster mask as an age field).
- **Landmarks.** Per-stone tint and a moss, snow or ash cover on upward faces, via the same world-normal "cover" patch used for props (§3.3). Old stones then belong to their biome.

---

## 3. Lighting, atmosphere and post-processing

**Today:**
- Fog is height fog with sun in-scattering (`graphics/atmosphere.ts`), and its colour is the sky's horizon colour.
- There's sky-based ambient light (PMREM), a cloud layer in the sky, and post-processing: N8AO (High), bloom (threshold 0.82), saturation/contrast, ACES, vignette, SMAA.

### 3.1 Atmospheric depth and fog alignment

- **Fog colour from the sky in the view direction**, not one colour. In the fog chunk, derive the fog colour from the same gradient the sky shader uses (horizon to zenith by view elevation), plus the sun in-scatter. Distant ridges then dissolve into exactly the sky behind them: amber at a meadow sunset, mint or lavender in alien worlds, crisp blue-white in snow. The gradient colours join the shared atmosphere uniforms.
- **Per-biome atmosphere profiles.** Height-fog falloff, in-scatter strength and haze colour bias per biome and weather, as one table:
  - snow: low, cold, bright
  - swamp: heavy and low
  - desert: thin with heat haze
  - alien: tinted, but **capped**, which fixes the current washout

  The profile also controls how much the sky lighting contributes, so bright pale skies don't flood the ambient light.
- **Light pillars fog correctly.** Beams are `fog: false` today, so they never blend into the horizon. Apply partial fog in the beam shader (for example 40% of the scene fog factor), so near pillars stay crisp and far ones sink into the haze. They stay visible because they still sit above the bloom threshold.
- **Cloud shadows.** Project the sky's cloud noise onto the ground in a shared patch (terrain, props, ground cover): slow-moving soft shadows that dim direct light only. One noise lookup per pixel. It ties the sky to the ground and gives wide shots motion.

### 3.2 Selective bloom and contrast polish

- **Bloom by HDR intent, not by brightness accident.**
  - Raise the bloom threshold above display white (about 1.1–1.2 in HDR).
  - Give intended emitters values that clear it: lantern, beacons, waystone runes, windows, lava, crystals, wisps, echoes, the relic. Centralise this as an `emissive` scale table in one place so the hierarchy is tunable.
  - Cap weather particles and the sky below the threshold. This fixes the snow over-bloom in the handoff.
  - Prefer this over pmndrs `SelectiveBloomEffect` (which uses an extra layer render), because one threshold bloom costs less.
- **Tone mapping and grade.**
  - Compare ACES against AgX and Neutral on all nine biomes in the bench. AgX usually keeps saturated emissives (lanterns, lava) from going yellow-white.
  - Replace the global saturation/contrast with a **procedural 3D LUT per mood** (pmndrs `LUT3DEffect` with a `LookupTexture` generated in code): warm/cool split toning (melancholy cooler shadows, hopeful warmer highlights) and a gentle S-curve that protects midtones.
- **Vignette** stays subtle, and is reduced in photo mode, where players frame their own shots.

### 3.3 Sky and horizon continuity

- **Ground bounce in the sky capture.** The sky dome's lower half uses `horizon × 0.6` today. Use the world's average ground colour instead, so ambient light from below matches the terrain (green bounce in meadows, white in snow, violet in alien worlds).
- **Sun and moon glow.** Unify the sun disc, halo, cloud silver-lining and fog in-scatter on one sun colour and intensity, so they move together through the day cycle. Add a moon halo with the same treatment at night.
- **Prop "cover" patch.** One world-normal-driven patch adds the biome's surface cover to every prop: snow on tops in cold worlds, ash in volcanic worlds, moss in damp ones, dust in deserts. It's controlled by the same atmosphere/biome profile, so ground and objects share a mood.

---

## 4. Character and landmark readability

### 4.1 Rim light and silhouette contrast

- **Rim term on figures** (`world/character.ts` materials, via the patch composer): `pow(1 − N·V, 3)`, tinted by the sky horizon colour, stronger when back-lit (when the view direction faces the sun). The player stays readable against bright snow, sunlit grass and pale alien skies in wide shots. Apply a weaker rim to wanderers, so the player stays first in the hierarchy.
- **Palette-aware cloak colour.** The player's cloak is fixed red today. On red deserts and volcanic worlds it disappears. Pick the cloak from a small set by maximum contrast in hue and lightness against the world's ground and sky. The scarf keeps the accent colour, so the player always carries the colour of the lights.
- **Wide-shot assist (optional, High).** A faint screen-space outline only on the player and wanderers (stencil or layer mask), fading in beyond about 30 m camera distance.
- **Lantern pool.** The lantern's light already exists at night. Add a soft ground-light decal (it can reuse the contact-blob system in additive mode), so the warm pool reads even with shadows off.

### 4.2 Layered foliage and material contrast

- **Material classes**, so surfaces separate by response rather than just colour:

| Class | Surfaces | Response |
| --- | --- | --- |
| Matte | cloth, soil, snow, bark | Roughness 0.9–1 |
| Satin | stone, mushrooms | Roughness 0.6–0.75 |
| Glossy | ice, crystals, wet banks, lantern glass | Roughness 0.1–0.3, with sky-capture reflections |
| Emissive | runes, windows, lanterns, lava | Above the bloom threshold, per §3.2 |

  Centralise these in `src/graphics/materials/classes.ts` and use them from structures, flora, characters and objectives.
- **Layered canopies.** Two-tone canopies in the geometry builders: darker inner and lower blobs, lighter outer and upper ones. Add a **leaf translucency** term in the foliage patch: wrap lighting plus a back-light glow when the sun is behind the leaves, the "golden hour through trees" look.
- **Wet patches.** Moisture from the ground mask lowers roughness on the terrain and on props near water (shared patch), so riverbanks and swamps glint.

---

## Order of work, budgets and verification

| # | Milestone | Covers | Size | Why this position |
| --- | --- | --- | --- | --- |
| M0 | Patch composer, ground mask, trails, bench extension | §0 | M | Everything else depends on it |
| M1 | Bloom by intent, atmosphere profiles, pillar fog | §3.1–3.2 (part) | S | Fixes the two open graphics bugs before adding more light sources |
| M2 | Terrain splatting (slope/height/moisture/snow/paths) and cloud shadows | §1.1, §3.1 | M | The largest visible change on every screen |
| M3 | Grounding: shadow tiers, baked ground AO, contact blobs | §1.3 | M | Fixes floating props, cheap on all tiers |
| M4 | Ground cover ring, variation, distance culling | §2 | L | Needs the mask (M0) and blobs (M3) |
| M5 | Procedural detail textures and triplanar detail | §1.2 | M | Close-up polish once the large-scale look is settled |
| M6 | Readability: rim light, cloak contrast, material classes, canopy translucency, prop cover | §4, §3.3 | M | Final hierarchy pass over everything above |
| M7 | Grade: tone-mapper comparison, per-mood LUTs, vignette and photo-mode tuning | §3.2 | S | Grade last, once content and lighting stop moving |

**Per-tier budgets.** These are targets, to verify on real hardware:

| Tier | Target | New cost allowed |
| --- | --- | --- |
| Low (phones) | 30 fps at 1× pixel ratio | Splat (no triplanar), 8k cover, blobs, rim, cloud shadows. No post, no sky lighting. |
| Medium (integrated GPUs) | 60 fps at 1080p | + triplanar normals, 25k cover, wet and snow response, basic post |
| High (discrete GPUs) | 60 fps at 1440p | + triplanar roughness and height blends, 50k cover, two shadow cascades, N8AO |

**Auto-detail order.** When a device can't hold its target, shed the most expensive-for-least-visible first:
1. Ground cover radius.
2. Triplanar detail.
3. Ambient occlusion.
4. Second shadow cascade.
5. Resolution.
6. Shadows.

**Verification for every milestone:**
- **Unit tests** for the deterministic parts: the mask bake, trails, ground cover hashing and placement, variation ranges, and atmosphere profile clamping.
- **Visual bench:** all nine biomes, three views and the mask debug view. Compare contact sheets before and after, and record them in the milestone's commit message.
- **Timing:** `SKIP_SHOTS=1` before and after at a fixed pose. These are relative SwiftShader numbers, plus a real-GPU spot check (Chrome performance panel, `renderer.info.render.calls` and triangle counts) on one integrated and one discrete GPU before calling a milestone done.
- **Playthrough regression:** the existing Phase 1, conversation and controller scripts must still pass. Paths must never block placement of waystones, echoes or lost items.

**Risks and mitigations:**
- **Shader complexity on mobile.** Strict tiering, early-outs on zero-weight layers, and detail fading with distance.
- **`onBeforeCompile` fragility across three.js versions.** The patch composer's missing-anchor warnings, plus three pinned at 0.182 until a deliberate upgrade.
- **Flat shading plus normal detail.** Detail perturbs the facet normal only within its fade distance, so the low-poly silhouette is untouched.
- **Ground cover popping.** Edge fade plus fog, with the ring radius always inside the fog's half-density distance.
- **A future WebGPU port.** Keep every effect as a small named GLSL function behind the composer; each maps to one TSL node later.
