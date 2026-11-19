# Worldseed improvement plan

What a playthrough looks like today: describe a world → walk to four pillars of light → press E at each → restore the heart. The world looks good and the story frames it well. But the time between pillars is just walking, taking a shard is a single key press, and the wanderers only talk. This plan adds things to *do* first, then polish, then a more alive story.

## Phase 1 — Things to do between the lights *(done)*

| # | Feature | Why | Done when |
| --- | --- | --- | --- |
| 1.1 ✅ | **Waystone trials.** Each shard is sealed until you wake three waystones hidden 20–45 m around its landmark. | Makes each landmark a short search, not a key press, and gets you to look around. | A sealed shard can't be taken. Waking all three breaks the seal with sound and light. Hint text counts stones and the compass shows unlit ones nearby. Progress is saved. |
| 1.2 ✅ | **Wanderer requests.** Each wanderer has lost something at one of the minor places. Find it, bring it back, and they reward you by marking an unfound landmark on your map. Their fate gets a line in the epilogue. | Gives the wanderers a story of their own and a reason to visit minor places. | Ask → find → return → thanks works in any order (you can find the item first). The carried item shows in the HUD. Rewards reveal the map. Saved and listed in the journal. |
| 1.3 ✅ | **Echoes.** Twelve drifting motes of memory scattered over the land. Walk through one to hear a one-line memory of the world before. | Rewards wandering off the straight path and adds world texture in small pieces. | Picked up automatically. They appear on the compass when near, gather in the journal, and are counted in the map title and epilogue. Saved. |
| 1.4 ✅ | **Claude writes them too.** Add echoes and requests to the Claude schema. Old saves and share links still load. | The Claude path stays a complete story writer. | `normalizeSpec` fills any missing pieces from the offline story. Old saves migrate. Tests cover this. |

## Phase 2 — Feel and reach *(done)*

| # | Feature | Status |
| --- | --- | --- |
| 2.1 ✅ | **Controller support.** Play with sticks and buttons, and navigate the title screen, story cards and menus too (focus, sliders, scrolling). Hints show button names whenever a controller was used last. | Done |
| 2.2 ✅ | **Auto-detail.** Watches real frame times. Below about 28 fps it steps down resolution, then shadows, one step at a time, and never steps back up, so it can't oscillate. Picking a quality by hand turns it off. | Done |
| 2.3 ✅ | **Photo mode** (<kbd>F</kbd> / R3). Hides the HUD, freezes you in place, widens the orbit, saves a captioned PNG, and <kbd>H</kbd> hides you. | Done |
| 2.4 ✅ | **Sound by place.** Surf near water, lava rumble, crickets at night, frogs in fens, birdsong by day, and wind that grows with altitude. | Done |
| 2.5 ✅ | **Accessibility.** Remappable keys (with swap on conflict), larger text, a high-contrast HUD, and fewer flashes and less camera motion (honours `prefers-reduced-motion`). | Done |

Not yet: rebinding controller buttons, and on-screen glyphs drawn as button icons instead of letters.

## Phase 3 — A living story *(done, with two shapes deferred)*

| # | Feature | Status |
| --- | --- | --- |
| 3.1 ✅ | **Talk freely with wanderers.** With a conversation server, the scripted lines lead into a text box. Replies stream in character, built from what that wanderer knows: the world, their own request, and live directions from where they stand. History is kept per wanderer. Offline or on a controller, wanderers keep their scripted lines. `WORLDSEED_MOCK_AI=1` gives canned replies for testing. | Done |
| 3.2 ✅ | **Time passes (optional).** "Let time pass" (a 20-minute day) and "Jump to" an hour. Each world keeps its own sky tint at every hour. Sun, moonlight, fog and water follow, and the lantern lights itself at night. | Done |
| 3.3 ✅ | **Restoration you can see.** Flowers spread out from the heart, dead trees leaf out, lava cools, murk clears, ash stops, storms stop flashing, and the wanderers gather at the heart. | Done |
| 3.4 ◐ | **More world shapes.** Rivers that run downhill to the sea (water, lava or ice, or dry beds in canyons and deserts) and floating isles are done. Caves and large settlements are deferred: caves need a terrain representation beyond a heightfield, and settlements need their own layout pass. | Rivers and isles done |

## Graphics pass *(in progress — see docs/HANDOFF-graphics.md)*

Done:
- Height fog with sun in-scattering.
- A procedural cloud layer.
- Terrain surface detail.
- Sky-based ambient light (IBL).
- Post-processing: ambient occlusion, bloom, grading, SMAA.

Open: snow particles bloom too much, the alien sky is washed out, a tuning pass across biomes, and like-for-like performance numbers.

## Visual polish *(planned — see docs/PLAN-visual-polish.md)*

Milestones M0–M7:
- terrain splatting, triplanar detail and grounded props
- camera-following instanced ground cover with trails and variation
- atmosphere alignment, bloom by intent and per-mood grading
- character and landmark readability

## Next ideas

- Caves (a separate mesh layer under cliffs) and settlements (clusters of hamlets with paths between them).
- Rebindable controller buttons, and button icons in hints.
- Claude-written echoes that respond to what the player has already found.

## Principles

- Everything keeps working offline and deterministically from the words. Claude makes it richer but is never required.
- New fields are optional in saved specs. `normalizeSpec` keeps old saves and links loading.
- Each feature ships with tests for the deterministic parts and a scripted playthrough check.
