# Worldseed

**Describe a world. Then walk into it.**

Worldseed is a third-person exploration game for the browser. You type a sentence like *"a drowned archipelago at dusk, where old lighthouses guard forgotten songs"*, and the game builds it: terrain, sky, weather, plants, ruins and wildlife. It also writes a short story to go with it.

Every world has the same story shape. Something precious broke into four pieces. Each piece rests at a landmark with a pillar of light you can see from anywhere, sealed until you wake the three waystones hidden around it. Wanderers along the way tell you about the past, point you toward the next light, and ask you to find something they lost. Echoes of memory drift over the land for anyone who strays off the path. Bring the pieces home to the world's heart and the whole land changes, and the epilogue remembers who you helped.

## Run it

```bash
cd games/worldseed
npm install
npm run dev        # http://localhost:5173
```

Other scripts: `npm test` (unit tests), `npm run typecheck`, `npm run build` (static site in `dist/`), `npm run preview`.

The static build runs anywhere, including GitHub Pages or a plain folder. It uses the offline world interpreter, which needs no network and no keys.

### Optional: let Claude dream the world

If the dev or preview server has Claude API credentials, the title screen shows a **"Let Claude dream up this world"** checkbox. With it ticked, the description is sent to Claude, which designs the world's settings and writes the whole story: prologue, lore, characters, dialogue and ending.

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run dev
# or, if you use `ant auth login` profiles:
WORLDSEED_AI=1 npm run dev
```

- The key never reaches the browser. The page posts to `/api/genesis` on the Vite server (`server/genesis.ts`), and the server calls the API.
- The server uses `claude-opus-5-5` by default (override with `WORLDSEED_MODEL`). Output is structured against a Zod schema, effort is `low` to keep loading fast, and server-side refusal fallbacks are turned on (`fallbacks: "default"`).
- Whatever comes back goes through `normalizeSpec()`. Any missing or invalid field is filled from the offline interpretation of the same words. If the call fails, the game says so and builds the world offline instead.
- Claude worlds are saved whole, so returning to one costs nothing. Share links for them carry the full compressed world, not just the prompt.

## Controls

| Action | Keyboard / mouse | Controller | Touch |
| --- | --- | --- | --- |
| Move | <kbd>WASD</kbd> / arrows | Left stick | Drag on the left half |
| Look | Click, then move the mouse (or drag) | Right stick | Drag on the right half |
| Run | <kbd>Shift</kbd> | RT or L3 | ⇧ button (toggle) |
| Jump / glide | <kbd>Space</kbd> (hold while falling to glide) | A | ⤒ button |
| Interact, talk, take | <kbd>E</kbd> | X | E button |
| Journal / map | <kbd>J</kbd> / <kbd>M</kbd> | Y / View | ☰ menu |
| Photo mode | <kbd>F</kbd> | R3 | ☰ menu |
| Zoom | Mouse wheel, <kbd>+</kbd> / <kbd>−</kbd> | LB / RB | — |
| Pause and settings | <kbd>Esc</kbd> or <kbd>P</kbd> | Menu | ☰ menu |

All keyboard keys can be rebound in **Pause → Controls**. Choosing a key that's already in use swaps the two. Hints and dialogue always show the key or button for the device you last used.

With a controller, menus, story cards and the title screen work without a mouse. The d-pad or left stick moves between options, A chooses, B goes back, left/right adjusts sliders and the quality picker, and the right stick scrolls long panels.

**Photo mode** hides the HUD and freezes you in place so you can orbit further out and lower down. Press jump to save a PNG with the world's name and your description in the corner. <kbd>H</kbd> hides your character.

**Settings** also include:
- **Auto-detail.** If frames drop below about 28 fps, the game lowers resolution and then turns off shadows. Picking a quality by hand turns this off.
- **Larger text and a high-contrast HUD.**
- **Reduce flashes and camera motion.** This removes the lightning flash and stops the camera swinging behind you on its own. It defaults to on if your system asks for reduced motion.

You can swim in water and murk. Ice and lava have a solid crust you can walk on.

## Between the lights

- **Waystones.** A sealed shard shimmers inside a shell of light. Three standing stones with faintly glowing runes stand 20–45 m around its landmark. The compass shows unwoken ones within 90 m. Wake all three (<kbd>E</kbd>) and the seal breaks.
- **Lost things.** Each wanderer lost something at one of the minor places. Once they've asked, it's pinned on your map and compass. You can also stumble on it first. Bring it back and they mark an unfound landmark on your map. Their fate appears in the epilogue.
- **Echoes.** Twelve drifting motes, each marked by a faint vertical shimmer. Walk through one to hear a single line of memory. They gather in the journal and are counted on the map and in the epilogue.

`ROADMAP.md` has what's planned next.

## What the description controls

The offline interpreter (`src/world/interpreter.ts`) reads keywords and phrases:

- **Biome:** meadow, forest, desert, tundra, volcanic, swamp, islands, alien, canyon
- **Time of day:** dawn, noon, dusk, night
- **Weather:** rain, storm and lightning, snow, fog, ash, fireflies, spores, petals
- **Terrain:** mountains, plateaus and mesas, rock spires, water level
- **Liquid:** water, lava, ice or murk
- **Plant kinds and density**
- **Landmarks:** ruins, towers, stone circles, arches, lighthouses, fallen colossi, hamlets, shrines
- **Creatures:** birds, wisps, butterflies, sky-whales
- **Sky:** moons ("two moons") and aurora
- **Mood:** sets the music's scale and the story's voice
- **Colour words aimed at a noun:** "red desert", "violet crystals", "green sky"
- **A name:** "…called Ellowmere"
- **Negation:** "no birds", "without trees"

Anything the description doesn't pin down comes from a hash of the words. The same sentence always builds the same world, which is how share links work.

## How it's built

TypeScript, [three.js](https://threejs.org), Vite. No art assets or audio files: every model, texture and sound is generated in code.

```
src/
  world/
    interpreter.ts   description → WorldSpec (deterministic)
    spec.ts          WorldSpec types + normalizeSpec() for untrusted input
    terrain.ts       noise heightfield, liquid line, walkable platforms
    layout.ts        where the heart, landmarks, spawn, places and people go
    structures.ts    procedural landmarks, the heart, minor markers
    flora.ts         instanced, chunked, wind-swayed vegetation
    sky.ts liquid.ts weather.ts fauna.ts beacon.ts npc.ts character.ts
    objectives.ts    waystones, seals, lost items, echoes, spot finding
    world.ts         assembles a scene from a WorldSpec
  engine/gamepad.ts  controller play and menu navigation (Gamepad API)
  story/
    narrator.ts      offline storyteller (grammar tables keyed by biome and mood)
    ai.ts            client for the optional Claude endpoint
  game/
    game.ts          frame loop, interactions, story progression, finale, saving
    player.ts camera.ts save.ts
  ui/  hud.ts map.ts
  engine/  rng, noise, colour, geometry helpers, input, audio, colliders, wind
server/genesis.ts    Vite middleware for /api/status and /api/genesis
```

Notes:

- **Physics matches the picture.** Ground height is read from the baked grid using the mesh's own triangle split, so feet sit on the rendered surface. Dais steps, stairs and plinths are registered as walkable platforms.
- **Performance.** Plants are instanced per spatial chunk, so the camera and the shadow camera can cull whole groves. Weather particles move entirely on the GPU. The far plane follows fog density. Phones default to Low quality, and auto-detail handles slow devices.
- **Sound by place.** All sound is generated at runtime. On top of the mood-based music, surf swells near open water, lava rumbles, crickets chirp in grassy places at night, frogs croak in the fens, and birds sing by day where there are birds. Wind gets stronger with altitude.
- **Saving.** Progress (pieces found, places discovered, people met, journal, explored map, position) autosaves to `localStorage` per world. The title screen lists your worlds to continue or forget.
- **Robustness.** Storage access is guarded everywhere. Specs from Claude, share links and old saves all pass through `normalizeSpec()`.

## Tests

`npm test` covers the interpreter and story generator: determinism, keyword reading, negation, names, story completeness for odd inputs (including echoes and requests), random-prompt variety, spec normalisation of hostile input, and migration of saves from before echoes and requests existed.
