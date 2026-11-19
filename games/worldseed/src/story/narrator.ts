import { Rng } from '../engine/rng'
import type { Biome, Mood, Story, Structure, Weather, WorldSpec } from '../world/spec'
import { ECHO_COUNT, QUEST_COUNT, SHARD_COUNT } from '../world/spec'
import type { QuestStory } from '../world/spec'

/**
 * The offline storyteller. It builds the narrative from grammar tables keyed by biome,
 * mood and the structures the world contains, so every world gets a story without a
 * network call. The optional Claude path replaces this prose but keeps the same shape.
 */

type Traits = Omit<WorldSpec, 'story'>

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const RELICS: Record<Biome, { noun: string; piece: string }[]> = {
  meadow: [
    { noun: 'Harvest Bell', piece: 'note' },
    { noun: 'Heartseed', piece: 'seed' },
    { noun: 'Hearth Loom', piece: 'thread' }
  ],
  forest: [
    { noun: 'Heartwood Lantern', piece: 'ember' },
    { noun: 'Antler Crown', piece: 'tine' },
    { noun: 'Root Song', piece: 'verse' }
  ],
  desert: [
    { noun: 'Sun Compass', piece: 'needle' },
    { noun: 'Rain Song', piece: 'verse' },
    { noun: 'Glass Heart', piece: 'shard' }
  ],
  tundra: [
    { noun: 'Hearthfire', piece: 'ember' },
    { noun: 'Winter Harp', piece: 'string' },
    { noun: 'Northern Bell', piece: 'note' }
  ],
  volcanic: [
    { noun: 'Cold Star', piece: 'shard' },
    { noun: 'Obsidian Bell', piece: 'note' },
    { noun: 'Stillstone', piece: 'fragment' }
  ],
  swamp: [
    { noun: 'Moonlamp', piece: 'spark' },
    { noun: 'Drowned Bell', piece: 'note' },
    { noun: 'Reed Crown', piece: 'reed' }
  ],
  islands: [
    { noun: 'Tide Lantern', piece: 'spark' },
    { noun: 'Pearl Compass', piece: 'pearl' },
    { noun: 'Calling Conch', piece: 'verse' }
  ],
  alien: [
    { noun: 'Prism Heart', piece: 'facet' },
    { noun: 'Singing Lattice', piece: 'chord' },
    { noun: 'Star Seed', piece: 'seed' }
  ],
  canyon: [
    { noun: 'Rain Drum', piece: 'beat' },
    { noun: 'Echo Stone', piece: 'echo' },
    { noun: 'Sky Loom', piece: 'thread' }
  ]
}

const LIVELY: Record<Biome, string> = {
  meadow: 'rang with bells at every harvest, and no field was ever quiet',
  forest: 'whispered to anyone patient enough to listen, and every tree knew its own name',
  desert: 'bloomed once a year when the rain came, and the caravans sang it in',
  tundra: 'kept its fires burning through the longest nights, and nobody froze alone',
  volcanic: 'held its fire gently in its hands, the way a forge holds a promise',
  swamp: 'glowed at night with a thousand reed lanterns, drifting on black water',
  islands: 'was stitched together by bridges of light from isle to isle',
  alien: 'sang in colours, and the stars above sang back',
  canyon: 'had a river at its heart, and the river had a voice'
}

const CALAMITY: Record<Biome, string> = {
  meadow: 'the long silence settled over the fields',
  forest: 'the old roots forgot their names',
  desert: 'the last rain was stolen from the sky',
  tundra: 'the winter that never ends came down from the peaks',
  volcanic: 'the mountains broke open and swallowed the sky',
  swamp: 'the waters rose and would not fall',
  islands: 'the sea drowned the bridges between the isles',
  alien: 'the stars above went quiet',
  canyon: 'the river that carved this land ran dry'
}

const CALAMITY_SHORT: Record<Biome, string> = {
  meadow: 'the bells went quiet',
  forest: 'the roots forgot',
  desert: 'the rain stopped coming',
  tundra: 'the long winter',
  volcanic: 'the sky burned',
  swamp: 'the flood',
  islands: 'the bridges drowned',
  alien: 'the stars went quiet',
  canyon: 'the river died'
}

const RESTORATION: Record<Biome, string> = {
  meadow: 'Somewhere across the fields, a bell rings. Then another, and another.',
  forest: 'The trees lean in, and for the first time in an age you hear them murmur their names.',
  desert: 'The air turns heavy and sweet. Far off, thunder rolls, and the dunes darken with rain.',
  tundra: 'Fires kindle in windows you never noticed, one by one across the snow.',
  volcanic:
    'The vents sigh and cool. Smoke thins, and stars show through for the first time in years.',
  swamp: 'Reed lanterns rise from the water, drifting up like slow sparks.',
  islands: 'Out on the water, ribbons of light stretch from isle to isle again.',
  alien: 'The sky answers in a chord so wide it fills your chest.',
  canyon: 'Deep below, water stirs in the dry riverbed and begins, very softly, to sing.'
}

const PEOPLE: Record<Biome, { who: string; did: string }> = {
  meadow: { who: 'the bell-ringers', did: 'ring in the harvest' },
  forest: { who: 'the root-singers', did: 'teach the saplings their names' },
  desert: { who: 'the caravan folk', did: 'trade water for stories' },
  tundra: { who: 'the hearth-keepers', did: 'keep the long fires burning' },
  volcanic: { who: 'the forge-wardens', did: "calm the mountain's temper" },
  swamp: { who: 'the reed-weavers', did: 'weave lanterns from rushes' },
  islands: { who: 'the tide-callers', did: 'call the boats home' },
  alien: { who: 'the lattice choir', did: 'sing the stars into their places' },
  canyon: { who: 'the rain-dancers', did: 'drum the clouds closer' }
}

const ROLE: Record<Mood, string> = {
  serene: 'Wayfarer',
  melancholy: 'Last Keeper',
  eerie: 'Lamplighter',
  hopeful: 'Seedbearer',
  ominous: 'Warden',
  whimsical: 'Cartographer of Odd Places'
}

const PLACE_ADJ: Record<Mood, string[]> = {
  serene: ['Quiet', 'Gentle', 'Still', 'Amber', 'Silver', 'Golden', 'Mild', 'Soft'],
  melancholy: ['Weeping', 'Forgotten', 'Hollow', 'Faded', 'Sunken', 'Lonely', 'Grey', 'Last'],
  eerie: ['Whispering', 'Pale', 'Crooked', 'Hushed', 'Unlit', 'Mirrored', 'Sleepless', 'Thin'],
  hopeful: ['Bright', 'Green', 'Waking', 'Rising', 'Morning', 'Kindled', 'Open', 'New'],
  ominous: ['Broken', 'Ashen', 'Black', 'Shattered', 'Cinder', 'Thorned', 'Hungry', 'Iron'],
  whimsical: [
    'Tumbling',
    'Giddy',
    'Painted',
    'Humming',
    'Upside',
    'Ticklish',
    'Wobbling',
    'Patchwork'
  ]
}

const PLACE_NOUN: Record<Biome, string[]> = {
  meadow: ['Fields', 'Downs', 'Barrow', 'Steps', 'Commons', 'Rise', 'Hedges', 'Ford'],
  forest: ['Wood', 'Glade', 'Thicket', 'Hollow', 'Grove', 'Boughs', 'Deeps', 'Clearing'],
  desert: ['Dunes', 'Wastes', 'Flats', 'Teeth', 'Basin', 'Mirage', 'Wells', 'Saltpan'],
  tundra: ['Reach', 'Drifts', 'Teeth', 'Firth', 'Barrows', 'Glacier', 'Pass', 'Cairns'],
  volcanic: ['Caldera', 'Cinders', 'Vents', 'Scar', 'Crown', 'Forge', 'Glass', 'Throat'],
  swamp: ['Mire', 'Fen', 'Shallows', 'Sink', 'Hollows', 'Bog', 'Rushes', 'Pools'],
  islands: ['Shallows', 'Reef', 'Strand', 'Cove', 'Isle', 'Sound', 'Skerries', 'Bay'],
  alien: ['Garden', 'Lattice', 'Bloom', 'Prism', 'Choir', 'Hollows', 'Veil', 'Orchard'],
  canyon: ['Mesa', 'Gorge', 'Steps', 'Spires', 'Wash', 'Narrows', 'Shelf', 'Bluffs']
}

const ABSTRACT = [
  'Echoes',
  'Lanterns',
  'Small Gods',
  'Long Shadows',
  'First Light',
  'Old Songs',
  'Bones',
  'Tides',
  'Stars',
  'Kept Promises',
  'Lost Names',
  'Ashes'
]

const PIECE_ADJ = [
  'Ashen',
  'Amber',
  'Silver',
  'Hollow',
  'Last',
  'Quiet',
  'Bright',
  'Drowned',
  'Crowned',
  'Wandering',
  'Sleeping',
  'Burning',
  'Frozen',
  'Singing',
  'First',
  'Patient'
]

const STRUCTURE_MEMORY: Record<Structure, (who: string, did: string, world: string) => string> = {
  ruins: (who, did) => `These broken columns once held up a hall where ${who} gathered to ${did}.`,
  tower: (_, __, world) =>
    `From the top of this tower, the watchers could see all of ${world} at once, and they swore to keep it.`,
  henge: (who, did) =>
    `The stones were raised in a ring so that ${who} could ${did} under an open sky.`,
  arch: (_, __, world) =>
    `Every traveller who came to ${world} passed beneath this arch, and every one of them was welcomed.`,
  lighthouse: () =>
    `Its lamp guided the lost home for a hundred years, and never once went dark — until it did.`,
  colossus: (_, __, world) =>
    `Before it fell, the giant walked the edges of ${world}, keeping the dark from crossing over.`,
  hamlet: (who, did) =>
    `In these little houses lived ${who}, who would leave their doors open to ${did}.`,
  shrine: (who) =>
    `Pilgrims left small gifts here: buttons, ribbons, a child's drawing. ${cap(who)} tended it.`
}

const QUOTES: Record<Mood, string[]> = {
  serene: [
    'Stay a while. The light is kinder here in the evening.',
    'Nothing is ever really lost. It just waits for someone to look in the right place.',
    'We planted it for whoever comes after us. Maybe that is you.'
  ],
  melancholy: [
    'We thought the light would always come back on its own.',
    'I kept the door open every night. Nobody came. I kept it open anyway.',
    "If you are reading this, I'm sorry we didn't hold on longer."
  ],
  eerie: [
    'Do not answer when the hills call your name. They only know how to say it.',
    'Count the lights. If there is one more than yesterday, do not follow it.',
    'The quiet here is listening. Be kind to it.'
  ],
  hopeful: [
    'Every dark has a far edge. Walk until you find it.',
    'We hid the pieces so they could be found, not so they would stay lost.',
    'Someone will come. Someone always comes.'
  ],
  ominous: [
    'It did not break. It was broken. Remember the difference.',
    'Keep the pieces apart until you are ready to carry what they become.',
    'The dark is not empty. It is full of things that were forgotten.'
  ],
  whimsical: [
    'If you find my left boot, it belongs to the hill now. Let it be.',
    'The map is upside down on purpose. So is the world, a little.',
    'Hum while you walk. The path likes it.'
  ]
}

const SENSATION: Record<Biome, string[]> = {
  meadow: ['the grass around your feet brightens', 'a single bell rings far across the fields'],
  forest: [
    'the leaves overhead whisper a word you almost know',
    'moss creeps a little greener over the stones'
  ],
  desert: ['the air smells briefly of rain', 'the sand at your feet cools and darkens'],
  tundra: ['your breath warms in the cold air', 'the frost on the stones melts into tiny stars'],
  volcanic: [
    'the ground beneath you cools and settles',
    'the ash in the air drifts upward like snow in reverse'
  ],
  swamp: [
    'the black water stills and shows the stars',
    'a reed lantern flickers awake on the water'
  ],
  islands: ['the waves pause, as if listening', 'gulls wheel overhead, calling'],
  alien: [
    'the air chimes softly in a colour you have no name for',
    'the crystals around you hum in harmony'
  ],
  canyon: ['a faint echo answers from the far cliffs', 'a single drop of rain falls on your hand']
}

const EPITHETS = [
  'who lost the way home',
  'the ferryman without a boat',
  'keeper of a cold lantern',
  'who counts the stars each night',
  'mapmaker of vanished roads',
  'who speaks to stones',
  'the last of the bell-ringers',
  'who is waiting for someone',
  'the tired pilgrim',
  'collector of forgotten names'
]

/** Things wanderers lose. `{place}` and `{name}` are filled in later. */
const QUESTS: QuestStory[] = [
  {
    item: 'a lantern glass',
    ask: "I dropped the glass from my lantern somewhere near {place}. Without it the flame won't hold in the wind. If your feet take you that way…",
    thanks:
      "Not even cracked! The flame will hold now. Here — I've walked every road in this land. Let me mark one for you.",
    after: "{name}'s lantern burns steady, and nobody walks home in the dark."
  },
  {
    item: 'a bundle of letters',
    ask: "I left my letters under a stone at {place}, meaning to come back for them. I never did. I'm not sure I could bear to read them alone.",
    thanks:
      "They're all here. Every one. I'll read them tonight, slowly. Thank you — and here, I know where one of your lights is hiding.",
    after:
      '{name} reads old letters aloud by the fire, and laughs at the parts nobody else understands.'
  },
  {
    item: 'a little carved bird',
    ask: 'My brother carved me a wooden bird when we were small. I lost it near {place}. It is a silly thing to miss so much.',
    thanks:
      'Oh. Oh, look at it. Its wing is still chipped where I dropped it the first time. Let me show you something on your map in return.',
    after:
      '{name} keeps the wooden bird on a string around their neck, and talks to it when nobody is looking.'
  },
  {
    item: 'a tin music box',
    ask: 'There is a music box somewhere around {place}. It plays the only song I still remember all the way through.',
    thanks:
      "Listen — it still plays. Just. That's the one. Here, let me mark the way to somewhere you haven't been.",
    after:
      "{name}'s music box plays every evening, and the wanderers have started learning the words."
  },
  {
    item: 'a red ribbon',
    ask: 'I tie red ribbons to the places that still remember. I lost my last one at {place}, and now I have nothing to mark them with.',
    thanks:
      "A ribbon for the next place that remembers. I know one you haven't found yet — I'll mark it for you.",
    after: '{name} ties red ribbons everywhere now. There are so many places that remember.'
  },
  {
    item: 'a brass compass',
    ask: "My compass doesn't point north — it points home. I set it down at {place} and walked off without it. Typical.",
    thanks:
      "There — still pointing home. It's pointing at you a bit too, which is strange. Here, I'll mark your map.",
    after: "{name}'s compass finally points somewhere new, and they've decided to follow it."
  },
  {
    item: 'a pouch of seeds',
    ask: 'I was carrying seeds from before — real ones, from the old gardens. The pouch tore at {place}. Please, if you find it…',
    thanks:
      "Still dry. Still alive, I think. When this is over I'll plant them all. Let me mark something on your map.",
    after: '{name} plants the old seeds in rows, and the first green shoots are already up.'
  },
  {
    item: 'a folded map',
    ask: 'My map. The roads on it are all wrong now, but they were my roads. I last had it around {place}.',
    thanks: "My roads. Thank you. Here — one road that's still right. I'll draw it on yours.",
    after: '{name} is drawing a new map, and every road on it is named after someone they met.'
  }
]

const ECHOES = [
  "A child's laugh, carried on the wind from a day nobody remembers.",
  '{people} singing, off-key and happy, somewhere just over the hill.',
  "The smell of bread, and a voice: 'Come in, come in, you're letting the cold out.'",
  'Someone on a rooftop, counting the lights of {world}: one, two, three, four…',
  "A promise, whispered: 'When it's whole again, we'll meet here.'",
  'The weight of {relic} in two small hands, held up to the sky for the first time.',
  "Rain on a roof, and someone who didn't want the night to end.",
  'An argument about the best way home. Both of them were wrong. Both of them got there.',
  'Footsteps running toward something, not away.',
  '{name} trying to teach a dog to sit. The dog never learned. Nobody minded.',
  "A wedding under the open sky. Everyone cried, even the ones who said they wouldn't.",
  "The last thing someone said before the dark came: 'Leave the door open.'",
  'Bells, far away, ringing for no reason but joy.',
  'A map drawn by candlelight, every road named after a friend.',
  'Two old friends, not speaking, just watching the light change.',
  'A song with no words that everybody knew.',
  '{name}, very small, asking where the world ends. Nobody had a good answer.',
  'A market day: too many voices, too much colour, nobody in a hurry.',
  'Somebody planting a tree they knew they would never sit under.',
  'A lullaby, half-remembered, the last line hummed because the words were lost.'
]

const BIOME_ECHOES: Record<Biome, string[]> = {
  meadow: [
    'The first hay of summer, and everyone sneezing at once.',
    'A kite stuck in a tree for three whole days.'
  ],
  forest: [
    'A tree being told its name for the very first time. It seemed pleased.',
    'Mushrooms gathered in an apron, and a scolding for the wrong ones.'
  ],
  desert: [
    'A caravan arriving at night, bells on every camel.',
    'The first rain of the year, and everybody running out into it.'
  ],
  tundra: [
    'Hands held out to a fire, and someone saying it was the warmest they had ever been.',
    'Snow angels, dozens of them, in a field that is ice now.'
  ],
  volcanic: [
    'The mountain humming softly, like it was content.',
    'A forge-song, hammers keeping time.'
  ],
  swamp: [
    'Lanterns of woven reed set adrift, one for every name.',
    'Frogs, impossibly loud, and nobody able to sleep.'
  ],
  islands: [
    'A boat coming home, everyone on the shore waving.',
    'Shells laid in a spiral on the sand, one for every day of the year.'
  ],
  alien: [
    'The sky answering a song with a colour.',
    'Crystals ringing in a breeze, like a choir tuning up.'
  ],
  canyon: [
    'A voice shouting across the gorge, and the echo shouting back something different.',
    'The river, loud and cold, before it was gone.'
  ]
}

const PLACE_NOTES = [
  'A cairn of balanced stones. Each one has a name scratched into it, too worn to read.',
  'The remains of a campfire, still faintly warm. Whoever was here left in a hurry.',
  'A lone standing stone that hums so quietly you feel it more than hear it.',
  'Someone carved a map into this rock. None of the roads on it exist anymore.',
  'Faded ribbons tied to a leaning post, fluttering though there is no wind.',
  'A small grave with fresh flowers. No name, just a drawing of a lantern.',
  'Footprints that begin here and lead nowhere.',
  'A ring of flat stones, as if something large once slept here and simply woke and left.'
]

const SYL_A = [
  'Ael',
  'Bryn',
  'Cor',
  'Dun',
  'Esk',
  'Fal',
  'Gal',
  'Hal',
  'Isk',
  'Kel',
  'Lor',
  'Mor',
  'Nar',
  'Oss',
  'Pell',
  'Quel',
  'Rho',
  'Sar',
  'Thal',
  'Ul',
  'Vey',
  'Wyn',
  'Yr',
  'Zan',
  'Var',
  'Ith'
]
const SYL_B = ['a', 'e', 'i', 'o', 'ae', 'ei', 'ar', 'en', 'or', 'il', 'u', 'y']
const SYL_C = [
  'dor',
  'mere',
  'holt',
  'wyn',
  'vale',
  'reth',
  'goth',
  'marr',
  'sund',
  'fell',
  'ast',
  'ira',
  'on',
  'eth',
  'ys',
  'rin',
  'ow'
]

export function makeName(rng: Rng, short = false): string {
  if (short) return rng.pick(SYL_A) + rng.pick(['a', 'in', 'e', 'o', 'is', 'en', 'ra', 'ek'])
  return rng.pick(SYL_A) + (rng.chance(0.5) ? rng.pick(SYL_B) : '') + rng.pick(SYL_C)
}

function placeName(rng: Rng, biome: Biome, mood: Mood, used: Set<string>): string {
  for (let tries = 0; tries < 40; tries++) {
    const roll = rng.next()
    let name: string
    if (roll < 0.6) name = `The ${rng.pick(PLACE_ADJ[mood])} ${rng.pick(PLACE_NOUN[biome])}`
    else if (roll < 0.8) name = `${rng.pick(PLACE_NOUN[biome])} of ${rng.pick(ABSTRACT)}`
    else name = `${makeName(rng, true)}'s ${rng.pick(PLACE_NOUN[biome])}`
    if (!used.has(name)) {
      used.add(name)
      return name
    }
  }
  const fallback = `The ${rng.pick(PLACE_NOUN[biome])} ${used.size + 1}`
  used.add(fallback)
  return fallback
}

function timePhrase(t: number): string {
  if (t < 0.17 || t > 0.86) return 'Night'
  if (t < 0.32) return 'Dawn'
  if (t < 0.62) return 'Day'
  if (t < 0.7) return 'Late afternoon'
  return 'Dusk'
}

const BIOME_PLACE: Record<Biome, string> = {
  meadow: 'the rolling fields',
  forest: 'the deep woods',
  desert: 'the endless dunes',
  tundra: 'the frozen reaches',
  volcanic: 'the smouldering highlands',
  swamp: 'the drowned fens',
  islands: 'the scattered isles',
  alien: 'the strange gardens',
  canyon: 'the red canyons'
}

const WEATHER_CLAUSE: Record<Weather, string> = {
  clear: 'and the air is very still',
  rain: 'and a soft rain is falling',
  storm: 'and a storm is circling, restless',
  snow: 'and snow drifts down without a sound',
  fog: 'and a thick mist hides the far hills',
  ash: 'and ash falls like grey snow',
  fireflies: 'and small lights drift between the grasses',
  spores: 'and glowing motes rise from the ground',
  petals: 'and petals ride the wind'
}

export function pluralize(noun: string): string {
  if (/(s|sh|ch|x)$/.test(noun)) return noun + 'es'
  if (/[^aeiou]y$/.test(noun)) return noun.slice(0, -1) + 'ies'
  return noun + 's'
}

/** Build the full story for a world. Deterministic for a given seed and traits. */
export function narrate(traits: Traits, rng: Rng): Story {
  const { biome, mood, name: world } = traits
  const relicDef = rng.pick(RELICS[biome])
  const relic = `the ${relicDef.noun}`
  const piece = relicDef.piece
  const pieces = pluralize(piece)
  const used = new Set<string>()
  const finalePlace = `The Heart of ${world}`
  used.add(finalePlace)
  const people = PEOPLE[biome]
  const role = ROLE[mood]

  const pieceAdj = rng.shuffle([...PIECE_ADJ])
  const quotes = rng.shuffle([
    ...QUOTES[mood],
    ...QUOTES[rng.pick(['serene', 'melancholy', 'hopeful'] as Mood[])]
  ])
  const keeperNames = Array.from({ length: SHARD_COUNT }, () => makeName(rng, true))

  const shards = Array.from({ length: SHARD_COUNT }, (_, i) => {
    const structure = traits.structures[i % traits.structures.length]
    const memory = STRUCTURE_MEMORY[structure](people.who, people.did, world)
    const quote = quotes[i % quotes.length]
    const sense = rng.pick(SENSATION[biome])
    return {
      name: `The ${pieceAdj[i]} ${cap(piece)}`,
      place: placeName(rng, biome, mood, used),
      lore: `${memory} Someone named ${keeperNames[i]} scratched a line into the stone: “${quote}” As you lift the ${piece}, ${sense}.`
    }
  })

  const epithets = rng.shuffle([...EPITHETS])
  const greetings: Record<Mood, string> = {
    serene: `Well met, traveller. It's a fine day to be walking, isn't it? Even now.`,
    melancholy: `Oh. A traveller. ${world} doesn't see many anymore. Not since ${CALAMITY_SHORT[biome]}.`,
    eerie: `You can see me? Good. Some days I'm not sure I'm really here.`,
    hopeful: `A new face! Then it's true — someone did come.`,
    ominous: `Keep your voice low. The land is listening, and it isn't kind anymore.`,
    whimsical: `Hello, hello! Mind the path — it moved this morning and hasn't apologised.`
  }
  const wanderers = Array.from({ length: 3 }, (_, i) => ({
    name: makeName(rng, true),
    epithet: epithets[i],
    lines: [
      i === 0
        ? greetings[mood]
        : rng.pick([
            greetings[mood],
            `Another one walking toward the lights. Good.`,
            `Ah — you have the look of someone searching.`
          ]),
      i === 0
        ? `They say ${relic} could make the whole land remember itself. Four ${pieces}, scattered. Find them, and bring them to ${finalePlace}.`
        : i === 1
          ? `${cap(people.who)} used to ${people.did}. I was only small, but I remember the sound of it.`
          : `When you hold one of the ${pieces}, listen. They remember things the rest of us forgot.`
    ]
  }))

  const notePool = rng.shuffle([...PLACE_NOTES])
  const places = Array.from({ length: 4 }, (_, i) => ({
    name: placeName(rng, biome, mood, used),
    note: notePool[i]
  }))

  const questPool = rng.shuffle([...QUESTS])
  const quests = Array.from({ length: QUEST_COUNT }, (_, i) => {
    const q = questPool[i]
    return { ...q, after: q.after.replace(/\{name\}/g, wanderers[i].name) }
  })

  const echoNames = Array.from({ length: 4 }, () => makeName(rng, true))
  const echoes = rng
    .shuffle([...BIOME_ECHOES[biome], ...rng.shuffle([...ECHOES]).slice(0, ECHO_COUNT)])
    .slice(0, ECHO_COUNT)
    .map((line, i) =>
      line
        .replace(/\{people\}/g, cap(people.who))
        .replace(/\{world\}/g, world)
        .replace(/\{relic\}/g, relic)
        .replace(/\{name\}/g, echoNames[i % echoNames.length])
    )

  const prologue = [
    `Once, ${world} ${LIVELY[biome]}. Then ${CALAMITY[biome]}, and ${relic} shattered into ${SHARD_COUNT} ${pieces}, scattered to the far corners of the land.`,
    `${timePhrase(traits.timeOfDay)} lies over ${BIOME_PLACE[biome]}, ${WEATHER_CLAUSE[traits.weather]}.`,
    `You are the ${role}. Find the ${pieces} — their light rises like pillars beyond the hills — and carry them to ${finalePlace}.`
  ]

  return {
    title: `The ${cap(pieces)} of ${world}`,
    role,
    prologue,
    goal: `Recover the ${SHARD_COUNT} ${pieces} of ${relic} and bring them to ${finalePlace}.`,
    relic: cap(relic),
    shardNoun: piece,
    shards,
    wanderers,
    places,
    echoes,
    quests,
    finale: {
      place: finalePlace,
      text: `You set the ${pieces} into ${relic}. For a moment nothing happens. Then light runs outward like water finding old riverbeds, and ${world} begins to remember itself. ${RESTORATION[biome]}`
    },
    epilogue: [
      `All across ${world}, the wanderers stop and look up at the light. ${wanderers[0].name} is the first to laugh, surprised by the sound.`,
      `There is no hurry now. ${world} is yours to walk, for as long as you like.`
    ]
  }
}
