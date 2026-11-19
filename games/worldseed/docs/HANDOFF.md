# Handoff: Worldseed (whole project)

**Read this first.** Then read [`PLAN-visual-polish.md`](PLAN-visual-polish.md) (the next work) and [`HANDOFF-graphics.md`](HANDOFF-graphics.md) (the last graphics pass and its open issues).

- **Branch:** `claude/procedural-3d-exploration-game-on9gm4`. Everything is committed and pushed, and the working tree was clean at handoff.
- **Location:** `games/worldseed/`, a self-contained Vite + TypeScript + three.js (r182) app inside the unrelated OCTAVE Electron repo. Leave OCTAVE alone; the only change to it is `!games/**` in `electron-builder.yml`. Formatting uses the repo-root Prettier config: `npx prettier@3.7.4 --config ../../.prettierrc.yaml --write "src/**/*.{ts,css}" "server/**/*.ts" index.html`.
- **Health at handoff:** `npm run typecheck` is clean, `npm test` passes 27 tests, `npm run build` succeeds, and the scripted playthroughs pass with no console errors. One exception: the graphics pass (the last commit before the plan) was checked with the visual bench, but the playthroughs weren't rerun after it.

## What the game is

The player describes a world in words. An offline interpreter (or, optionally, Claude) turns it into a `WorldSpec`, and the game builds the island:
- Terrain, sky, weather, plants, creatures and four landmarks.
- A story: four shards sealed by waystones, three wanderers with lost-item requests and live directions, twelve echoes, and a finale that restores the land.

It's playable with keyboard and mouse, touch or a controller. Saves are per world, and share links carry the prompt or the full spec.

## Run it

```bash
cd games/worldseed && npm install
npm run dev                                   # http://localhost:5173
ANTHROPIC_API_KEY=... npm run dev             # Claude world-building + wanderer conversation
WORLDSEED_MOCK_AI=1 npm run dev               # canned conversation replies, no key needed (for testing)
npm run typecheck && npm test && npm run build
```

## Map of the code (where to change what)

| Area | Files |
| --- | --- |
| Words → world | `src/world/interpreter.ts` (lexicon, palette, defaults), `src/world/spec.ts` (types + `normalizeSpec` for untrusted input and migrations), `src/story/narrator.ts` (offline story) |
| Terrain and placement | `src/world/terrain.ts` (heightfield, platforms, `surfaceAt`), `rivers.ts`, `layout.ts` (where landmarks go), `flora.ts` (chunked instancing), `structures.ts`, `objectives.ts` (waystones, seals, lost items, echoes) |
| World assembly | `src/world/world.ts`: build stages, lights, `setTime`, restoration, atmosphere and cloud feeds, `QUALITY` presets |
| Look | `src/world/sky.ts` (sky, clouds), `liquid.ts`, `features.ts` (river ribbons, floating isles), `weather.ts`, `renewal.ts`, `daycycle.ts`, and `src/graphics/*` (fog chunks, ground detail, sky IBL, post-processing) |
| Game loop and story flow | `src/game/game.ts` (modes, interactions, quests, chat, finale, photo mode, auto-detail, saving), `player.ts`, `camera.ts`, `save.ts` |
| Input | `src/engine/input.ts` (actions and remapping), `gamepad.ts` |
| UI | `index.html`, `src/style.css`, `src/ui/hud.ts`, `src/ui/map.ts`, `src/main.ts` (title, settings, wiring) |
| Server (optional Claude) | `server/genesis.ts` (`/api/status`, `/api/genesis`, structured output), `server/talk.ts` (`/api/talk`, streamed in-character replies) |

## State of features

- **Phases 1–3 of `ROADMAP.md` are done:**
  - waystones, requests, echoes
  - controller, auto-detail, photo mode, place sounds, accessibility, key remapping
  - wanderer conversation, passing time, visible restoration, rivers, floating isles
- **Deferred:** caves and settlements.
- **Graphics pass (in progress):**
  - Done: height fog with sun in-scattering, sky clouds, ground detail, sky IBL (Medium/High), and post-processing (N8AO on High, bloom, grade, SMAA).
  - Open: snow particles over-bloom, the pale-sky alien world is washed out, and before/after timing isn't like-for-like.
- **Visual polish:** fully planned, not started.

## Next work: M0 of the visual polish plan

M0 is detailed in `PLAN-visual-polish.md` §0. Done means all of the following:

1. **`src/graphics/patch.ts`, a shader patch composer.**
   - Today `engine/wind.ts`, `world/renewal.ts`, `graphics/surface.ts` and `world/fauna.ts` each *assign* `material.onBeforeCompile`, so a second patch replaces the first.
   - Port all four to the composer with no visual change.
   - A missing anchor chunk must produce a warning, not a silent failure.
2. **`src/world/groundmask.ts`, a baked RGBA8 world texture (512²) plus a CPU copy.**
   - Channels: R rock, G snow, B moisture, A path.
   - Unit tests: rock on steep cells, no snow below the liquid line or in hot biomes, moisture highest at rivers, deterministic per seed.
3. **`src/world/paths.ts`: trails by A* on an 8 m grid.**
   - Connect spawn → wanderers → landmarks → heart, avoiding water and cliffs, with Chaikin smoothing.
   - Rasterise into mask A. Keep trees off paths, and show paths on the map.
   - Tests: everything is connected, no water cells, deterministic.
4. **Extend `scripts/visual-bench/bench.cjs`:**
   - all nine biomes
   - a knee-height third view
   - a `DEBUG=mask` false-colour view
   - timing always via `SKIP_SHOTS=1` at a fixed pose

After that, M1 fixes the two open graphics issues: bloom by HDR intent (threshold above white, emitters pushed above it, particles and sky capped), and per-biome atmosphere profiles that cap pale-sky haze.

## Testing kit

- **Unit tests** (`npm test`): interpreter, narrator, spec migration, rivers, day cycle, input names and settings migration, and the conversation server prompt and validation.
- **Browser playtests** in `scripts/playtests/`: Playwright scripts that need the dev server on :5173 and run headless with SwiftShader.

| Script | What it checks |
| --- | --- |
| `phase1.cjs` | Waystones → shards → request → echo → finale → reload |
| `chat.cjs` | Conversation with mock replies; needs `WORLDSEED_MOCK_AI=1` on the dev server |
| `phase2.cjs` | Fake gamepad, photo download, key remap, accessibility, auto-detail |
| `hours.cjs`, `renew.cjs`, `river.cjs` | Visual spot checks |

  Run with `OUT=<dir> node scripts/playtests/phase1.cjs`. Some scripts also need `PROMPT` and `TAG`; see their headers.
- **Visual bench** in `scripts/visual-bench/` (see `HANDOFF-graphics.md`).

## Gotchas learned the hard way

- **SwiftShader is very slow** (about 1 s per frame at High with post-processing).
  - Wait on game time (`game.time`), not wall-clock time.
  - Hold simulated gamepad buttons for about 1.3 s, because polling happens once per frame.
  - Give screenshots long timeouts.
  - `gl.finish()` doesn't block in headless Chromium; time frames with a 1-pixel `readPixels`.
- **`patch` is a reserved word in GLSL ES 3.0.** Shader compile errors only appear in the browser console, so check it.
- **Shared uniforms across all materials** work by putting plain objects (not `Vector3`/`Color`) in uniforms, because three's uniform cloning keeps them by reference. `graphics/atmosphere.ts` relies on this. Install it before any material compiles (`main.ts` does).
- **Story-card key listeners** attach after 250 ms. A card closed before then must not attach one; this is fixed, so don't regress it.
- **With a conversation server running, talking is opt-in:** E finishes and Enter opens the text box. Auto-opening it trapped players and broke the playthrough script.
- **Real-GPU performance has never been measured.** All timings are relative SwiftShader numbers.
- **The Claude happy path has never run:** no API key was ever available. The failure, fallback and mock paths are tested.

## Agreed working style (from this project's history)

- Commit per feature with descriptive messages, and push to the branch. Don't open a pull request unless asked.
- Keep Low quality cheap and unchanged unless a milestone says otherwise.
- Keep everything deterministic from the description, and keep old saves and share links loading (`normalizeSpec` fills missing fields).
- Verify each change in the browser (screenshots or playtests), not just with types and tests, and say plainly what wasn't verified.
