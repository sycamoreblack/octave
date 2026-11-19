import { Rng, hashString } from '../engine/rng'
import { clamp } from '../engine/noise'
import { hexToHsl, hslToHex, mixHex, type HSL } from '../engine/color'
import { narrate, makeName } from '../story/narrator'
import type {
  Biome,
  Creature,
  Flora,
  Liquid,
  Mood,
  Palette,
  Structure,
  Weather,
  WorldSpec
} from './spec'

/**
 * The offline world interpreter: reads a free-text description and turns it into a
 * WorldSpec with a keyword lexicon. Anything the description doesn't pin down is
 * filled in from the prompt's hash, so the same words always build the same world.
 */

type Rule<T> = [RegExp, T, number?]

const BIOME_RULES: Rule<Biome>[] = [
  [
    /\b(meadows?|fields?|grass(land)?s?|prairies?|plains?|pastures?|valleys?|farm\w*|hills?|countryside|downs)\b/,
    'meadow'
  ],
  [
    /\b(forests?|woods?|woodlands?|groves?|jungles?|trees|pines?|taiga|rainforests?|thickets?|oaks?|birch\w*)\b/,
    'forest'
  ],
  [
    /\b(deserts?|sand\w*|dunes?|arid|wastelands?|oasis|sahara|scorched|sun-?baked|dust\w*)\b/,
    'desert'
  ],
  [
    /\b(frozen|ice|icy|snow\w*|glacier\w*|winter\w*|tundra|arctic|frost\w*|blizzards?|cold|polar|boreal)\b/,
    'tundra'
  ],
  [
    /\b(volcan\w*|lava|magma|ash(en)?|obsidian|embers?|burning|fire|infernal|molten|cinders?|smoulder\w*|smolder\w*)\b/,
    'volcanic'
  ],
  [/\b(swamps?|bogs?|marsh\w*|fens?|mires?|bayous?|wetlands?|murky|mangroves?)\b/, 'swamp'],
  [
    /\b(islands?|isles?|archipelago\w*|oceans?|seas?|coast\w*|drowned|sunken|tides?|shores?|lagoons?|beach\w*|atolls?|reefs?|harbou?rs?)\b/,
    'islands'
  ],
  [
    /\b(crystal\w*|alien|otherworldly|neon|biolumin\w*|dream\w*|surreal|cosmic|strange|psychedelic|prism\w*|fae|fairy|faerie)\b/,
    'alien'
  ],
  [
    /\b(canyons?|mesas?|cliffs?|gorges?|badlands|buttes?|ravines?|red rock|plateaus?|arroyos?)\b/,
    'canyon'
  ]
]

const WEATHER_RULES: Rule<Weather>[] = [
  [/\b(storms?|stormy|thunder\w*|lightning|tempest|hurricane|gale)\b/, 'storm', 2],
  [/\b(rain\w*|drizzl\w*|downpour|monsoon|showers?|wet)\b/, 'rain'],
  [/\b(snow\w*|blizzards?|flurr\w*)\b/, 'snow'],
  [/\b(fog\w*|mist\w*|haze|hazy|murk|cloud(y|ed))\b/, 'fog'],
  [/\b(ash|ashfall|cinders?|soot)\b/, 'ash'],
  [/\b(fireflies|firefly|glow-?worms?|lightning bugs?|will-?o-?wisps?)\b/, 'fireflies', 2],
  [/\b(spores?|pollen|motes?|floating lights?|drifting lights?)\b/, 'spores'],
  [/\b(petals?|blossoms?|cherry|sakura|falling leaves|autumn|fall leaves)\b/, 'petals']
]

const TIME_RULES: Rule<number>[] = [
  [/\b(dawn|sunrise|daybreak|first light|morning)\b/, 0.27],
  [/\b(noon|midday|bright|sunny|sunlit|daylight|daytime|blazing|summer)\b/, 0.46],
  [/\b(afternoon)\b/, 0.6],
  [/\b(dusk|sunset|sundown|twilight|evening|golden hour|gloaming)\b/, 0.74],
  [/\b(night\w*|midnight|moonlit|moonlight|starlit|starry|stars|dark(ness)?|nocturnal)\b/, 0.94]
]

const MOOD_RULES: Rule<Mood>[] = [
  [
    /\b(sad|melanchol\w*|lonely|forgotten|lost|mourn\w*|grief|abandoned|empty|faded|wistful|ruined|decay\w*)\b/,
    'melancholy'
  ],
  [
    /\b(eerie|haunt\w*|ghost\w*|uncanny|whisper\w*|spirits?|creepy|liminal|silent|strange)\b/,
    'eerie'
  ],
  [
    /\b(ominous|dread|dying|doom\w*|corrupt\w*|blight\w*|cursed|sinister|menac\w*|war|bleak|grim|apocalyp\w*|dead)\b/,
    'ominous'
  ],
  [/\b(hope\w*|warm|joy\w*|bloom\w*|spring|rebirth|reborn|healing|kind|gentle|new)\b/, 'hopeful'],
  [/\b(calm|quiet|still|serene|tranquil|peaceful|cozy|cosy|soft|idyllic|lazy)\b/, 'serene'],
  [
    /\b(whimsical|playful|candy|toy\w*|silly|odd|wonky|giggl\w*|cartoon\w*|bouncy|upside)\b/,
    'whimsical'
  ]
]

const FLORA_RULES: Rule<Flora>[] = [
  [/\b(pines?|conifers?|firs?|spruces?|evergreens?|cedars?|taiga)\b/, 'pine'],
  [
    /\b(oaks?|maples?|birch\w*|elms?|beech\w*|trees|orchards?|blossoms?|cherry|sakura|jungles?)\b/,
    'broadleaf'
  ],
  [/\b(palms?|coconuts?|tropical|jungle)\b/, 'palm'],
  [/\b(cact\w*|succulents?|saguaro)\b/, 'cactus'],
  [/\b(mushrooms?|fung\w*|toadstools?|mycel\w*|spores?)\b/, 'mushroom'],
  [/\b(crystal\w*|gems?|quartz|geodes?|amethyst|prism\w*)\b/, 'crystal'],
  [
    /\b(dead trees?|bare trees?|skeletal|petrified|withered|leafless|burnt trees?|husks?)\b/,
    'deadtree'
  ],
  [/\b(willows?|weeping|mangroves?|cypress\w*)\b/, 'willow'],
  [/\b(flowers?|bloom\w*|wildflowers?|poppies|poppy|lavender|roses?|lilies|lily)\b/, 'flower'],
  [/\b(reeds?|rushes|cattails?|bamboo)\b/, 'reeds'],
  [/\b(boulders?|rocks?|rocky|stones?|stony)\b/, 'rock']
]

const STRUCTURE_RULES: Rule<Structure>[] = [
  [/\b(ruin\w*|ancient|crumbl\w*|columns?|temples? ruins|remains|forgotten city)\b/, 'ruins'],
  [/\b(towers?|spires?|citadels?|keeps?|castles?|watchtowers?|fortress\w*)\b/, 'tower'],
  [
    /\b(monoliths?|obelisks?|standing stones?|menhirs?|henges?|stone circles?|dolmens?|runes?|runestones?)\b/,
    'henge'
  ],
  [/\b(arch(es|way)?|gates?|gateways?|portals?|doors?|doorways?)\b/, 'arch'],
  [/\b(lighthouses?|beacons?)\b/, 'lighthouse'],
  [
    /\b(statues?|colossus|colossi|giants?|titans?|idols?|bones|skeletons?|machines?|robots?|golems?|remains of)\b/,
    'colossus'
  ],
  [/\b(villages?|huts?|houses?|cottages?|towns?|settlements?|homes?|cabins?|hamlets?)\b/, 'hamlet'],
  [/\b(shrines?|temples?|altars?|chapels?|pagodas?|monaster\w*|sanctuar\w*|pilgrim\w*)\b/, 'shrine']
]

const CREATURE_RULES: Rule<Creature>[] = [
  [
    /\b(birds?|crows?|ravens?|gulls?|hawks?|flocks?|eagles?|owls?|swallows?|vultures?|herons?|cranes?)\b/,
    'birds'
  ],
  [/\b(spirits?|ghosts?|wisps?|souls?|lanterns?|glowing|wil?l-?o|fireflies|lights)\b/, 'wisps'],
  [
    /\b(whales?|leviathans?|sky ?(whales?|fish|serpents?)|flying fish|dragons?|floating beasts?)\b/,
    'skywhales'
  ],
  [/\b(butterfl\w*|moths?|insects?|bees?|dragonfl\w*)\b/, 'butterflies']
]

const COLOR_WORDS: [RegExp, HSL][] = [
  [/\b(red|crimson|scarlet|blood|ruby|vermilion)\b/, { h: 0.0, s: 0.7, l: 0.45 }],
  [/\b(orange|amber|copper|rust\w*|tangerine)\b/, { h: 0.07, s: 0.75, l: 0.5 }],
  [/\b(gold\w*|yellow|saffron|honey)\b/, { h: 0.12, s: 0.75, l: 0.55 }],
  [/\b(green|emerald|jade|verdant|lime)\b/, { h: 0.33, s: 0.55, l: 0.4 }],
  [/\b(teal|turquoise|aqua(marine)?)\b/, { h: 0.47, s: 0.6, l: 0.45 }],
  [/\b(cyan)\b/, { h: 0.5, s: 0.7, l: 0.5 }],
  [/\b(blue|azure|sapphire|cobalt|cerulean)\b/, { h: 0.6, s: 0.6, l: 0.5 }],
  [/\b(indigo)\b/, { h: 0.68, s: 0.55, l: 0.35 }],
  [/\b(purple|violet|amethyst|lavender|lilac|mauve)\b/, { h: 0.77, s: 0.5, l: 0.5 }],
  [/\b(pink|rose|magenta|fuchsia|blush)\b/, { h: 0.9, s: 0.6, l: 0.65 }],
  [/\b(white|silver\w*|pale|ivory|pearl\w*|bone)\b/, { h: 0.6, s: 0.08, l: 0.85 }],
  [/\b(black|onyx|ink\w*|jet|charcoal)\b/, { h: 0.7, s: 0.1, l: 0.12 }]
]

type Target = 'sky' | 'liquid' | 'ground' | 'foliage' | 'accent'
const TARGET_NOUNS: [RegExp, Target][] = [
  [/^(sky|skies|clouds?|sun|suns|light|horizon|dusk|dawn|sunset|heavens?|aurora|moons?)$/, 'sky'],
  [
    /^(seas?|oceans?|water|waters|lakes?|rivers?|lava|magma|tides?|pools?|lagoons?|ice|streams?)$/,
    'liquid'
  ],
  [
    /^(sand|sands|earth|ground|dunes?|rocks?|stones?|soil|cliffs?|mountains?|hills?|deserts?|canyons?|mesas?|snow|plains?|land|lands)$/,
    'ground'
  ],
  [
    /^(trees?|forests?|woods?|leaves|grass|grasses|flowers?|moss|fung\w*|mushrooms?|crystals?|foliage|jungles?|blossoms?|meadows?|fields?|vines?|groves?)$/,
    'foliage'
  ]
]

export const EXAMPLE_PROMPTS = [
  'A drowned archipelago at dusk, where old lighthouses guard forgotten songs',
  'A red desert under two moons, scattered with the bones of colossal machines',
  'A snowbound pine forest at night, lit by wandering spirits and the northern lights',
  'An alien garden of violet crystals and giant mushrooms, with whales drifting through a green sky',
  'A quiet meadow at dawn with a little village, wildflowers and ancient standing stones',
  'A smouldering volcanic wasteland of obsidian towers and falling ash',
  'A misty swamp full of fireflies, weeping willows and a sunken shrine',
  'Vast red canyons at golden hour, carved with stone arches and ruins of a rain-dancing people'
]

const RANDOM_PARTS = {
  open: [
    'A',
    'An ancient',
    'A forgotten',
    'A gentle',
    'A strange',
    'A vast',
    'A lonely',
    'A hidden'
  ],
  land: [
    'archipelago',
    'pine forest',
    'desert',
    'tundra',
    'volcanic highland',
    'swamp',
    'meadow',
    'crystal garden',
    'canyon country'
  ],
  time: [
    'at dawn',
    'at dusk',
    'under the stars',
    'at noon',
    'in the twilight',
    'beneath two moons'
  ],
  detail: [
    'where stone giants sleep',
    'dotted with crumbling towers',
    'full of fireflies',
    'with lighthouses on every shore',
    'where whales drift through the sky',
    'with a ring of standing stones',
    'with petals on the wind',
    'with a village nobody remembers',
    'where it is always gently raining',
    'with arches carved by a vanished people'
  ]
}

/** A random but well-formed description, for players who'd rather be surprised. */
export function randomPrompt(rng: Rng): string {
  return `${rng.pick(RANDOM_PARTS.open)} ${rng.pick(RANDOM_PARTS.land)} ${rng.pick(RANDOM_PARTS.time)}, ${rng.pick(RANDOM_PARTS.detail)}`
}

function score<T>(text: string, rules: Rule<T>[]): Map<T, number> {
  const out = new Map<T, number>()
  for (const [re, value, w = 1] of rules) {
    const g = new RegExp(re.source, 'g')
    const hits = text.match(g)?.length ?? 0
    if (hits) out.set(value, (out.get(value) ?? 0) + hits * w)
  }
  return out
}

function top<T>(m: Map<T, number>): T | undefined {
  let best: T | undefined
  let bestScore = 0
  for (const [k, v] of m) {
    if (v > bestScore) {
      best = k
      bestScore = v
    }
  }
  return best
}

const NEGATION =
  /\b(no|without|never|devoid of|lacking|free of)\s+(any\s+)?[\w-]+(\s+(or|and|nor)\s+[\w-]+)*/g

/**
 * Splits "no X" / "without X" phrases out of the text, so "a forest without birds" neither
 * matches birds nor falls back to the forest's default birds.
 */
function splitNegations(text: string): { kept: string; negated: string } {
  const negated = (text.match(NEGATION) ?? []).join(' ')
  return { kept: text.replace(NEGATION, ' '), negated }
}

const BIOME_DEFAULTS: Record<
  Biome,
  {
    terrain: WorldSpec['terrain']
    liquid: Liquid
    flora: Flora[]
    density: number
    structures: Structure[]
    creatures: Creature[]
    fog: number
    weather: Weather[]
    moods: Mood[]
  }
> = {
  meadow: {
    terrain: { height: 0.35, roughness: 0.3, waterLevel: 0.28, plateaus: false, spires: false },
    liquid: 'water',
    flora: ['broadleaf', 'grass', 'flower', 'rock'],
    density: 0.45,
    structures: ['hamlet', 'henge', 'ruins', 'shrine'],
    creatures: ['birds', 'butterflies'],
    fog: 0.15,
    weather: ['clear', 'clear', 'petals', 'rain'],
    moods: ['serene', 'hopeful', 'whimsical']
  },
  forest: {
    terrain: { height: 0.45, roughness: 0.45, waterLevel: 0.25, plateaus: false, spires: false },
    liquid: 'water',
    flora: ['pine', 'broadleaf', 'grass', 'rock', 'mushroom'],
    density: 0.75,
    structures: ['shrine', 'ruins', 'tower', 'henge'],
    creatures: ['birds', 'wisps'],
    fog: 0.35,
    weather: ['clear', 'fog', 'rain', 'fireflies'],
    moods: ['serene', 'eerie', 'melancholy']
  },
  desert: {
    terrain: { height: 0.38, roughness: 0.2, waterLevel: 0.08, plateaus: false, spires: false },
    liquid: 'water',
    flora: ['cactus', 'rock', 'deadtree', 'grass'],
    density: 0.2,
    structures: ['colossus', 'ruins', 'arch', 'tower'],
    creatures: ['birds'],
    fog: 0.15,
    weather: ['clear', 'clear', 'clear'],
    moods: ['melancholy', 'serene', 'ominous']
  },
  tundra: {
    terrain: { height: 0.6, roughness: 0.55, waterLevel: 0.25, plateaus: false, spires: false },
    liquid: 'ice',
    flora: ['pine', 'rock', 'deadtree', 'grass'],
    density: 0.4,
    structures: ['henge', 'tower', 'ruins', 'shrine'],
    creatures: ['birds'],
    fog: 0.35,
    weather: ['snow', 'snow', 'clear'],
    moods: ['melancholy', 'serene', 'eerie']
  },
  volcanic: {
    terrain: { height: 0.7, roughness: 0.7, waterLevel: 0.2, plateaus: false, spires: true },
    liquid: 'lava',
    flora: ['deadtree', 'rock', 'crystal'],
    density: 0.25,
    structures: ['tower', 'colossus', 'arch', 'henge'],
    creatures: ['birds'],
    fog: 0.45,
    weather: ['ash', 'ash', 'clear'],
    moods: ['ominous', 'melancholy']
  },
  swamp: {
    terrain: { height: 0.18, roughness: 0.25, waterLevel: 0.5, plateaus: false, spires: false },
    liquid: 'murk',
    flora: ['willow', 'reeds', 'mushroom', 'deadtree', 'grass'],
    density: 0.6,
    structures: ['shrine', 'ruins', 'hamlet', 'tower'],
    creatures: ['wisps', 'birds'],
    fog: 0.6,
    weather: ['fog', 'fireflies', 'rain'],
    moods: ['eerie', 'melancholy']
  },
  islands: {
    terrain: { height: 0.45, roughness: 0.45, waterLevel: 0.6, plateaus: false, spires: false },
    liquid: 'water',
    flora: ['palm', 'broadleaf', 'grass', 'rock', 'flower'],
    density: 0.5,
    structures: ['lighthouse', 'ruins', 'shrine', 'arch'],
    creatures: ['birds'],
    fog: 0.15,
    weather: ['clear', 'clear', 'rain'],
    moods: ['serene', 'melancholy', 'hopeful']
  },
  alien: {
    terrain: { height: 0.55, roughness: 0.5, waterLevel: 0.3, plateaus: false, spires: true },
    liquid: 'water',
    flora: ['crystal', 'mushroom', 'grass', 'flower'],
    density: 0.55,
    structures: ['colossus', 'arch', 'henge', 'tower'],
    creatures: ['skywhales', 'wisps'],
    fog: 0.3,
    weather: ['spores', 'clear', 'spores'],
    moods: ['eerie', 'whimsical', 'serene']
  },
  canyon: {
    terrain: { height: 0.7, roughness: 0.4, waterLevel: 0.14, plateaus: true, spires: false },
    liquid: 'water',
    flora: ['cactus', 'rock', 'deadtree', 'grass'],
    density: 0.25,
    structures: ['arch', 'ruins', 'hamlet', 'colossus'],
    creatures: ['birds'],
    fog: 0.12,
    weather: ['clear', 'clear', 'storm'],
    moods: ['serene', 'melancholy']
  }
}

const BASE_GROUND: Record<
  Biome,
  {
    low: HSL
    mid: HSL
    high: HSL
    rock: HSL
    foliage: HSL
    alt: HSL
    liquid: HSL
    stone: HSL
    accent: HSL
  }
> = {
  meadow: {
    low: { h: 0.12, s: 0.35, l: 0.66 },
    mid: { h: 0.25, s: 0.45, l: 0.42 },
    high: { h: 0.2, s: 0.3, l: 0.5 },
    rock: { h: 0.1, s: 0.08, l: 0.5 },
    foliage: { h: 0.29, s: 0.5, l: 0.34 },
    alt: { h: 0.2, s: 0.55, l: 0.45 },
    liquid: { h: 0.55, s: 0.5, l: 0.42 },
    stone: { h: 0.1, s: 0.06, l: 0.66 },
    accent: { h: 0.12, s: 0.9, l: 0.6 }
  },
  forest: {
    low: { h: 0.11, s: 0.3, l: 0.5 },
    mid: { h: 0.27, s: 0.42, l: 0.28 },
    high: { h: 0.22, s: 0.2, l: 0.38 },
    rock: { h: 0.1, s: 0.06, l: 0.42 },
    foliage: { h: 0.33, s: 0.45, l: 0.24 },
    alt: { h: 0.26, s: 0.5, l: 0.32 },
    liquid: { h: 0.5, s: 0.4, l: 0.3 },
    stone: { h: 0.25, s: 0.08, l: 0.55 },
    accent: { h: 0.14, s: 0.85, l: 0.62 }
  },
  desert: {
    low: { h: 0.1, s: 0.45, l: 0.72 },
    mid: { h: 0.09, s: 0.55, l: 0.62 },
    high: { h: 0.07, s: 0.45, l: 0.52 },
    rock: { h: 0.06, s: 0.35, l: 0.45 },
    foliage: { h: 0.25, s: 0.3, l: 0.38 },
    alt: { h: 0.18, s: 0.3, l: 0.45 },
    liquid: { h: 0.5, s: 0.55, l: 0.45 },
    stone: { h: 0.09, s: 0.3, l: 0.72 },
    accent: { h: 0.55, s: 0.8, l: 0.6 }
  },
  tundra: {
    low: { h: 0.58, s: 0.15, l: 0.8 },
    mid: { h: 0.58, s: 0.12, l: 0.9 },
    high: { h: 0.6, s: 0.08, l: 0.95 },
    rock: { h: 0.6, s: 0.08, l: 0.45 },
    foliage: { h: 0.42, s: 0.3, l: 0.22 },
    alt: { h: 0.38, s: 0.25, l: 0.3 },
    liquid: { h: 0.55, s: 0.35, l: 0.78 },
    stone: { h: 0.6, s: 0.06, l: 0.6 },
    accent: { h: 0.08, s: 0.95, l: 0.6 }
  },
  volcanic: {
    low: { h: 0.05, s: 0.1, l: 0.26 },
    mid: { h: 0.02, s: 0.08, l: 0.22 },
    high: { h: 0.0, s: 0.05, l: 0.17 },
    rock: { h: 0.0, s: 0.05, l: 0.1 },
    foliage: { h: 0.05, s: 0.25, l: 0.2 },
    alt: { h: 0.0, s: 0.3, l: 0.25 },
    liquid: { h: 0.05, s: 1, l: 0.55 },
    stone: { h: 0.0, s: 0.04, l: 0.22 },
    accent: { h: 0.06, s: 1, l: 0.55 }
  },
  swamp: {
    low: { h: 0.17, s: 0.25, l: 0.28 },
    mid: { h: 0.2, s: 0.3, l: 0.24 },
    high: { h: 0.18, s: 0.2, l: 0.32 },
    rock: { h: 0.2, s: 0.08, l: 0.35 },
    foliage: { h: 0.22, s: 0.35, l: 0.24 },
    alt: { h: 0.16, s: 0.35, l: 0.3 },
    liquid: { h: 0.22, s: 0.35, l: 0.2 },
    stone: { h: 0.2, s: 0.1, l: 0.45 },
    accent: { h: 0.2, s: 0.9, l: 0.6 }
  },
  islands: {
    low: { h: 0.12, s: 0.5, l: 0.78 },
    mid: { h: 0.3, s: 0.5, l: 0.42 },
    high: { h: 0.25, s: 0.3, l: 0.45 },
    rock: { h: 0.08, s: 0.1, l: 0.5 },
    foliage: { h: 0.32, s: 0.6, l: 0.33 },
    alt: { h: 0.24, s: 0.6, l: 0.42 },
    liquid: { h: 0.5, s: 0.7, l: 0.42 },
    stone: { h: 0.1, s: 0.08, l: 0.82 },
    accent: { h: 0.08, s: 0.9, l: 0.62 }
  },
  alien: {
    low: { h: 0.72, s: 0.3, l: 0.4 },
    mid: { h: 0.75, s: 0.35, l: 0.28 },
    high: { h: 0.8, s: 0.3, l: 0.38 },
    rock: { h: 0.7, s: 0.15, l: 0.3 },
    foliage: { h: 0.85, s: 0.6, l: 0.55 },
    alt: { h: 0.5, s: 0.7, l: 0.55 },
    liquid: { h: 0.8, s: 0.6, l: 0.38 },
    stone: { h: 0.72, s: 0.1, l: 0.75 },
    accent: { h: 0.5, s: 0.95, l: 0.6 }
  },
  canyon: {
    low: { h: 0.08, s: 0.45, l: 0.6 },
    mid: { h: 0.04, s: 0.55, l: 0.45 },
    high: { h: 0.03, s: 0.5, l: 0.38 },
    rock: { h: 0.02, s: 0.45, l: 0.35 },
    foliage: { h: 0.22, s: 0.3, l: 0.35 },
    alt: { h: 0.15, s: 0.35, l: 0.42 },
    liquid: { h: 0.52, s: 0.5, l: 0.42 },
    stone: { h: 0.07, s: 0.3, l: 0.7 },
    accent: { h: 0.55, s: 0.85, l: 0.6 }
  }
}

export function skyFor(t: number): { top: HSL; horizon: HSL; sun: string } {
  if (t < 0.17 || t > 0.86)
    return {
      top: { h: 0.64, s: 0.55, l: 0.05 },
      horizon: { h: 0.64, s: 0.35, l: 0.16 },
      sun: '#c8d4ff'
    }
  if (t < 0.32)
    return {
      top: { h: 0.6, s: 0.45, l: 0.45 },
      horizon: { h: 0.07, s: 0.75, l: 0.72 },
      sun: '#ffc896'
    }
  if (t < 0.66)
    return {
      top: { h: 0.58, s: 0.62, l: 0.5 },
      horizon: { h: 0.56, s: 0.45, l: 0.84 },
      sun: '#fff3dc'
    }
  return { top: { h: 0.69, s: 0.42, l: 0.3 }, horizon: { h: 0.05, s: 0.8, l: 0.6 }, sun: '#ff9a5a' }
}

function buildPalette(
  biome: Biome,
  t: number,
  mood: Mood,
  colors: { target: Target; hsl: HSL }[],
  rng: Rng
): Palette {
  const g = BASE_GROUND[biome]
  const jitter = (c: HSL, amt = 0.02): HSL => ({
    h: c.h + rng.range(-amt, amt),
    s: c.s,
    l: c.l + rng.range(-amt, amt)
  })
  const sky = skyFor(t)
  let top = { ...sky.top }
  let horizon = { ...sky.horizon }
  if (biome === 'alien') {
    const shift = rng.pick([0.25, 0.4, -0.2])
    top.h += shift
    horizon.h += shift
    top.s = Math.min(1, top.s + 0.2)
  }
  if (biome === 'volcanic') {
    horizon = { h: 0.03, s: 0.6, l: Math.max(0.25, horizon.l * 0.6) }
    top.s *= 0.4
    top.l *= 0.6
  }
  if (biome === 'swamp' || mood === 'ominous') {
    top.s *= 0.5
    horizon.s *= 0.5
  }
  if (mood === 'eerie') horizon.h = horizon.h * 0.5 + 0.3 * 0.5
  if (mood === 'whimsical') {
    top.s = Math.min(1, top.s + 0.2)
    horizon.s = Math.min(1, horizon.s + 0.15)
  }

  const out = {
    low: jitter(g.low),
    mid: jitter(g.mid),
    high: jitter(g.high),
    rock: jitter(g.rock),
    foliage: jitter(g.foliage, 0.03),
    alt: jitter(g.alt, 0.03),
    liquid: { ...g.liquid },
    stone: { ...g.stone },
    accent: { h: g.accent.h + rng.range(-0.05, 0.05), s: g.accent.s, l: g.accent.l }
  }

  for (const { target, hsl } of colors) {
    switch (target) {
      case 'sky':
        top = { h: hsl.h, s: Math.max(top.s, hsl.s * 0.8), l: top.l }
        horizon = { h: hsl.h + 0.03, s: Math.max(horizon.s, hsl.s * 0.7), l: horizon.l }
        break
      case 'liquid':
        if (biome !== 'volcanic') out.liquid = { ...hsl, l: clamp(hsl.l, 0.25, 0.7) }
        break
      case 'ground':
        // Ground colours read best a little earthier than the word itself.
        out.mid = { h: hsl.h + 0.01, s: hsl.s * 0.62, l: clamp(hsl.l, 0.2, 0.8) }
        out.low = { h: hsl.h + 0.03, s: hsl.s * 0.5, l: clamp(hsl.l + 0.12, 0.25, 0.85) }
        out.high = { h: hsl.h, s: hsl.s * 0.55, l: clamp(hsl.l - 0.08, 0.1, 0.8) }
        break
      case 'foliage':
        out.foliage = { ...hsl, l: clamp(hsl.l, 0.25, 0.7) }
        out.alt = { h: hsl.h + 0.06, s: hsl.s, l: clamp(hsl.l + 0.1, 0.3, 0.8) }
        break
      case 'accent':
        out.accent = { h: hsl.h, s: Math.max(0.7, hsl.s), l: clamp(hsl.l, 0.5, 0.7) }
        if (biome === 'alien') out.foliage = { ...hsl, l: clamp(hsl.l, 0.35, 0.65) }
        break
    }
  }

  return {
    skyTop: hslToHex(top),
    skyHorizon: hslToHex(horizon),
    sun: sky.sun,
    groundLow: hslToHex(out.low),
    groundMid: hslToHex(out.mid),
    groundHigh: hslToHex(out.high),
    rock: hslToHex(out.rock),
    foliage: hslToHex(out.foliage),
    foliageAlt: hslToHex(out.alt),
    accent: hslToHex(out.accent),
    liquid: hslToHex(out.liquid),
    stone: hslToHex(out.stone)
  }
}

/** Finds "<colour> <noun>" pairs and decides what the colour should paint. */
function extractColors(text: string): { target: Target; hsl: HSL }[] {
  const words = text.split(/[^a-z-]+/).filter(Boolean)
  const found: { target: Target; hsl: HSL }[] = []
  for (let i = 0; i < words.length; i++) {
    const match = COLOR_WORDS.find(([re]) => re.test(words[i]))
    if (!match) continue
    let target: Target = 'accent'
    for (let k = 1; k <= 3 && i + k < words.length; k++) {
      const hit = TARGET_NOUNS.find(([re]) => re.test(words[i + k]))
      if (hit) {
        target = hit[1]
        break
      }
    }
    found.push({ target, hsl: match[1] })
  }
  return found
}

function extractName(original: string): string | undefined {
  const m =
    original.match(
      /\b(?:called|named|known as|land of|realm of|world of|kingdom of)\s+(?:the\s+)?([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,2})/
    ) ?? original.match(/^([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)?)\s*[,:—-]/)
  const name = m?.[1]?.trim()
  if (!name || /^(A|An|The|In|On|At|Under)$/.test(name)) return undefined
  return name
}

/** Turn a description into a full, playable WorldSpec. Pure and deterministic. */
export function interpret(prompt: string): WorldSpec {
  const original =
    prompt.trim().replace(/\s+/g, ' ').slice(0, 1000) || randomPrompt(new Rng(Date.now()))
  const { kept: lower, negated } = splitNegations(original.toLowerCase())
  const banned = <T>(rules: Rule<T>[]): Set<T> => new Set(score(negated, rules).keys())
  const seed = hashString(original.toLowerCase())
  const rng = new Rng(seed)

  const biomeScores = score(lower, BIOME_RULES)
  const biome: Biome =
    top(biomeScores) ?? rng.fork('biome').pick(Object.keys(BIOME_DEFAULTS) as Biome[])
  const defaults = BIOME_DEFAULTS[biome]

  const mood: Mood = top(score(lower, MOOD_RULES)) ?? rng.fork('mood').pick(defaults.moods)

  const timeScores = score(lower, TIME_RULES)
  const moodTimes: Record<Mood, number[]> = {
    serene: [0.42, 0.55, 0.62],
    melancholy: [0.74, 0.72, 0.92],
    eerie: [0.94, 0.76, 0.9],
    hopeful: [0.27, 0.3, 0.45],
    ominous: [0.76, 0.95, 0.5],
    whimsical: [0.5, 0.6, 0.3]
  }
  const timeOfDay = top(timeScores) ?? rng.fork('time').pick(moodTimes[mood])

  const weatherScores = score(lower, WEATHER_RULES)
  const sunny = /\b(sunny|sunlit|bright|clear|noon|midday|summer|blazing)\b/.test(lower)
  let weather: Weather =
    top(weatherScores) ?? (sunny ? 'clear' : rng.fork('weather').pick(defaults.weather))
  const isNight = timeOfDay > 0.86 || timeOfDay < 0.17
  if (weather === 'fireflies' && !isNight && !weatherScores.has('fireflies')) weather = 'clear'
  if (biome === 'forest' && isNight && weather === 'clear') weather = 'fireflies'
  if (weather === 'snow' && biome === 'desert') weather = 'clear'

  const terrain = { ...defaults.terrain }
  const tr = rng.fork('terrain')
  terrain.height = clamp(terrain.height + tr.range(-0.08, 0.08), 0, 1)
  terrain.roughness = clamp(terrain.roughness + tr.range(-0.08, 0.08), 0, 1)
  if (
    /\b(mountain\w*|peaks?|alp\w*|jagged|towering|soaring|highlands?|summits?|crags?)\b/.test(lower)
  ) {
    terrain.height = Math.max(terrain.height, 0.8)
    terrain.roughness = Math.max(terrain.roughness, 0.6)
  }
  if (/\b(flat|gentle|rolling|low|plains?)\b/.test(lower))
    terrain.height = Math.min(terrain.height, 0.3)
  if (/\b(mesas?|plateaus?|terrac\w*|tiers?|steps?|buttes?)\b/.test(lower)) terrain.plateaus = true
  if (/\b(spires?|pillars?|needles?|hoodoos?|stacks?|columns of rock)\b/.test(lower))
    terrain.spires = true
  if (/\b(lakes?|flood\w*|drowned|sunken|waterlogged|waters?)\b/.test(lower))
    terrain.waterLevel = Math.max(terrain.waterLevel, 0.42)
  if (/\b(islands?|archipelago\w*|isles?)\b/.test(lower))
    terrain.waterLevel = Math.max(terrain.waterLevel, 0.6)
  if (/\b(dry|arid|parched)\b/.test(lower)) terrain.waterLevel = Math.min(terrain.waterLevel, 0.1)
  // Rivers: asked for by name, or sometimes by default where rivers belong.
  const riverWords = lower.match(
    /\b(rivers?|streams?|brooks?|creeks?|waterfalls?|rivulets?|rapids|deltas?)\b/g
  )
  const riverChance: Record<Biome, number> = {
    meadow: 0.6,
    forest: 0.6,
    tundra: 0.5,
    alien: 0.4,
    volcanic: 0.5,
    canyon: 0.8,
    desert: 0.3,
    swamp: 0,
    islands: 0.2
  }
  terrain.rivers = riverWords
    ? riverWords.some((w) => /(rivers|streams|brooks|creeks|rapids|deltas)$/.test(w))
      ? 3
      : 2
    : rng.fork('rivers').chance(riverChance[biome])
      ? 1
      : 0
  if (/\b(rivers?|streams?|brooks?|creeks?)\b/.test(negated)) terrain.rivers = 0
  terrain.floating =
    /\b(floating|levitating|hovering|sky[- ]islands?|islands? in the sky|suspended|airborne)\b/.test(
      lower
    ) ||
    (biome === 'alien' && rng.fork('floating').chance(0.5))

  let liquid: Liquid = defaults.liquid
  if (/\b(lava|magma|molten)\b/.test(lower)) liquid = 'lava'
  else if (/\b(frozen (lakes?|seas?|rivers?)|ice|icy)\b/.test(lower)) liquid = 'ice'
  else if (/\b(seas?|oceans?|water|lakes?|rivers?|tides?)\b/.test(lower) && liquid !== 'murk')
    liquid = 'water'
  else if (/\b(swamp\w*|bogs?|murky|toxic)\b/.test(lower)) liquid = 'murk'

  const floraMentioned = [...score(lower, FLORA_RULES).keys()]
  const ground: Flora[] = defaults.flora.filter(
    (f) => f === 'grass' || f === 'rock' || f === 'flower' || f === 'reeds'
  )
  // Naming a tree replaces the biome's trees; naming ground cover (flowers, reeds, rocks) only adds to it.
  const GROUND_COVER: Flora[] = ['grass', 'rock', 'flower', 'reeds']
  const mentionedTrees = floraMentioned.filter((f) => !GROUND_COVER.includes(f))
  const trees = mentionedTrees.length
    ? mentionedTrees
    : defaults.flora.filter((f) => !GROUND_COVER.includes(f))
  let floraKinds = [
    ...new Set([...trees, ...ground, ...floraMentioned.filter((f) => GROUND_COVER.includes(f))])
  ]
  if (biome === 'tundra' && !floraMentioned.length)
    floraKinds = floraKinds.filter((f) => f !== 'flower')
  let density = defaults.density + rng.fork('density').range(-0.08, 0.08)
  if (/\b(dense|lush|overgrown|thick|teeming|verdant|tangled|jungle)\b/.test(lower))
    density = Math.max(density, 0.85)
  if (/\b(barren|sparse|empty|desolate|bleak|bare|lifeless)\b/.test(lower))
    density = Math.min(density, 0.15)
  if (/\btreeless\b/.test(lower))
    floraKinds = floraKinds.filter(
      (f) => !['pine', 'broadleaf', 'palm', 'willow', 'deadtree'].includes(f)
    )
  const bannedFlora = banned(FLORA_RULES)
  if (/\btrees?\b/.test(negated))
    floraKinds = floraKinds.filter(
      (f) => !['pine', 'broadleaf', 'palm', 'willow', 'deadtree'].includes(f)
    )
  floraKinds = floraKinds.filter((f) => !bannedFlora.has(f))
  if (!floraKinds.length) floraKinds = ['grass', 'rock']

  const structuresMentioned = [...score(lower, STRUCTURE_RULES).entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
  const bannedStructures = banned(STRUCTURE_RULES)
  const structures = [
    ...new Set([
      ...structuresMentioned,
      ...rng.fork('structures').shuffle([...defaults.structures])
    ])
  ]
    .filter((st) => !bannedStructures.has(st))
    .slice(0, 4)
  if (!structures.length) structures.push('henge')
  if (!terrain.waterLevel || terrain.waterLevel < 0.15) {
    // Lighthouses need a coast to stand on.
    const i = structures.indexOf('lighthouse')
    if (i >= 0 && !structuresMentioned.includes('lighthouse')) structures.splice(i, 1, 'tower')
  }

  const creatureScores = score(lower, CREATURE_RULES)
  let creatures: Creature[] = creatureScores.size
    ? [...creatureScores.keys()]
    : [...defaults.creatures]
  if (/\b(lifeless|silent|empty|dead)\b/.test(lower) && !creatureScores.size) creatures = []
  const bannedCreatures = banned(CREATURE_RULES)
  if (/\b(animals?|creatures?|life|wildlife)\b/.test(negated)) creatures = []
  creatures = creatures.filter((c) => !bannedCreatures.has(c))
  if (creatures.includes('wisps') && !isNight && !creatureScores.has('wisps') && biome !== 'swamp')
    creatures = creatures.filter((c) => c !== 'wisps')

  let moons = isNight ? 1 : 0
  const moonMatch = lower.match(/\b(two|twin|three|triple|2|3|many|several)\s+moons?\b/)
  if (moonMatch) moons = /three|triple|3|many|several/.test(moonMatch[1]) ? 3 : 2
  else if (/\bmoons?\b/.test(lower)) moons = Math.max(moons, 1)
  else if (biome === 'alien') moons = 2

  const aurora =
    /\b(auroras?|northern lights|southern lights|borealis)\b/.test(lower) ||
    (biome === 'tundra' && isNight && rng.fork('aurora').chance(0.6))

  let fog = defaults.fog + rng.fork('fog').range(-0.05, 0.05)
  if (weather === 'fog') fog = Math.max(fog, 0.75)
  if (weather === 'storm' || weather === 'rain') fog = Math.max(fog, 0.4)
  if (weather === 'snow' || weather === 'ash') fog = Math.max(fog, 0.45)
  if (/\b(vast|endless|open|clear|crisp|wide)\b/.test(lower)) fog = Math.max(0.05, fog - 0.12)

  const colors = extractColors(lower)
  const palette = buildPalette(biome, timeOfDay, mood, colors, rng.fork('palette'))
  if (biome !== 'tundra' && (weather === 'snow' || biomeScores.has('tundra'))) {
    // A snowy forest or meadow: dust the ground white but keep the biome's shape.
    palette.groundMid = mixHex(palette.groundMid, '#eef3fa', 0.7)
    palette.groundHigh = mixHex(palette.groundHigh, '#f6f9ff', 0.8)
    palette.groundLow = mixHex(palette.groundLow, '#dfe7f0', 0.5)
  }
  if (liquid === 'lava') palette.liquid = '#ff5a1a'
  if (liquid === 'ice') palette.liquid = mixHex(palette.liquid, '#e8f4ff', 0.6)
  // Keep the accent readable against the sky: shard beacons must pop.
  const acc = hexToHsl(palette.accent)
  palette.accent = hslToHex({ h: acc.h, s: Math.max(acc.s, 0.75), l: clamp(acc.l, 0.55, 0.7) })

  const name = extractName(original) ?? makeName(rng.fork('name'))

  const traits: Omit<WorldSpec, 'story'> = {
    version: 1,
    source: 'local',
    prompt: original,
    seed,
    name,
    biome,
    mood,
    timeOfDay,
    weather,
    fog: clamp(fog, 0, 1),
    terrain,
    liquid,
    flora: { kinds: floraKinds, density: clamp(density, 0, 1) },
    structures,
    creatures,
    moons,
    aurora,
    palette
  }
  return { ...traits, story: narrate(traits, rng.fork('story')) }
}
