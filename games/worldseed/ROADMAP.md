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

## Phase 3 — A living story *(next)*

- **Talk freely with wanderers (Claude, optional).** Type anything; they answer in character, knowing the world, the relic and your progress. Falls back to scripted lines offline.
- **Time passes (optional).** A slow day/night cycle, or "rest at a campfire" to change the hour. The world's described time stays the default.
- **Restoration you can see.** After the finale, dead trees leaf out, lava cools, fog lifts, and new wanderers appear at the heart.
- **More world shapes:** rivers that run downhill, caves, floating isles, and big settlements built from many hamlets.

## Principles

- Everything keeps working offline and deterministically from the words. Claude makes it richer but is never required.
- New fields are optional in saved specs. `normalizeSpec` keeps old saves and links loading.
- Each feature ships with tests for the deterministic parts and a scripted playthrough check.
