import { clamp } from '../engine/noise'
import { isHex } from '../engine/color'

/**
 * A WorldSpec is everything needed to rebuild a world: plain JSON with no three.js types.
 * It comes from either the offline interpreter (deterministic from the prompt) or from
 * Claude via the optional server endpoint. Either way it goes through `normalizeSpec`.
 */

export const BIOMES = [
  'meadow',
  'forest',
  'desert',
  'tundra',
  'volcanic',
  'swamp',
  'islands',
  'alien',
  'canyon'
] as const
export type Biome = (typeof BIOMES)[number]

export const WEATHERS = [
  'clear',
  'rain',
  'storm',
  'snow',
  'fog',
  'ash',
  'fireflies',
  'spores',
  'petals'
] as const
export type Weather = (typeof WEATHERS)[number]

export const LIQUIDS = ['water', 'lava', 'ice', 'murk'] as const
export type Liquid = (typeof LIQUIDS)[number]

export const FLORA = [
  'pine',
  'broadleaf',
  'palm',
  'cactus',
  'mushroom',
  'crystal',
  'deadtree',
  'willow',
  'rock',
  'grass',
  'flower',
  'reeds'
] as const
export type Flora = (typeof FLORA)[number]

export const STRUCTURES = [
  'ruins',
  'tower',
  'henge',
  'arch',
  'lighthouse',
  'colossus',
  'hamlet',
  'shrine'
] as const
export type Structure = (typeof STRUCTURES)[number]

export const CREATURES = ['birds', 'wisps', 'skywhales', 'butterflies'] as const
export type Creature = (typeof CREATURES)[number]

export const MOODS = ['serene', 'melancholy', 'eerie', 'hopeful', 'ominous', 'whimsical'] as const
export type Mood = (typeof MOODS)[number]

export interface Palette {
  skyTop: string
  skyHorizon: string
  sun: string
  groundLow: string
  groundMid: string
  groundHigh: string
  rock: string
  foliage: string
  foliageAlt: string
  accent: string
  liquid: string
  stone: string
}

export interface ShardStory {
  /** e.g. "The Ashen Verse" */
  name: string
  /** Region where it rests, e.g. "The Weeping Steps" */
  place: string
  /** 2–4 sentences of memory revealed on pickup. */
  lore: string
}

export interface WandererStory {
  name: string
  epithet: string
  /** Spoken in order. A directional hint is appended at runtime. */
  lines: string[]
}

/**
 * Something a wanderer lost at one of the minor places (wanderer i → places[i]).
 * `{place}` in any line is replaced with that place's name at runtime.
 */
export interface QuestStory {
  /** e.g. "a cracked lantern glass" */
  item: string
  /** The request, spoken by the wanderer. */
  ask: string
  /** Spoken when you bring the item back. */
  thanks: string
  /** One sentence for the epilogue: how their story ends. */
  after: string
}

export interface Story {
  title: string
  role: string
  prologue: string[]
  goal: string
  relic: string
  shardNoun: string
  shards: ShardStory[]
  wanderers: WandererStory[]
  places: { name: string; note: string }[]
  /** One-line memories found drifting over the land. */
  echoes: string[]
  quests: QuestStory[]
  finale: { place: string; text: string }
  epilogue: string[]
}

export interface WorldSpec {
  version: 1
  source: 'local' | 'claude'
  prompt: string
  seed: number
  name: string
  biome: Biome
  mood: Mood
  /** 0..1, 0.25 sunrise, 0.5 noon, 0.75 sunset, 0/1 midnight */
  timeOfDay: number
  weather: Weather
  /** 0..1 */
  fog: number
  terrain: {
    /** 0..1 overall vertical scale */
    height: number
    /** 0..1 how jagged */
    roughness: number
    /** 0..1 how much of the land sits under the liquid line */
    waterLevel: number
    plateaus: boolean
    spires: boolean
  }
  liquid: Liquid
  flora: { kinds: Flora[]; density: number }
  structures: Structure[]
  creatures: Creature[]
  moons: number
  aurora: boolean
  palette: Palette
  story: Story
}

export const SHARD_COUNT = 4
export const ECHO_COUNT = 12
export const QUEST_COUNT = 3
/** Waystones to wake around each landmark before its shard can be taken. */
export const WAYSTONES = 3

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback

const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback

const str = (v: unknown, fallback: string, max = 600): string =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)]

/**
 * Coerce untrusted input (Claude output, a share link, an old save) into a valid spec.
 * Any field that's missing or malformed is taken from `base`, so a partial spec still plays.
 */
export function normalizeSpec(raw: unknown, base: WorldSpec): WorldSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const t = (r.terrain ?? {}) as Record<string, unknown>
  const p = (r.palette ?? {}) as Record<string, unknown>
  const s = (r.story ?? {}) as Record<string, any>
  const f = (r.flora ?? {}) as Record<string, unknown>

  const palette = { ...base.palette }
  for (const key of Object.keys(palette) as (keyof Palette)[]) {
    if (isHex(p[key])) palette[key] = (p[key] as string).toLowerCase()
  }

  const floraKinds = Array.isArray(f.kinds)
    ? uniq(f.kinds.filter((k): k is Flora => (FLORA as readonly string[]).includes(k as string)))
    : []
  const structures = Array.isArray(r.structures)
    ? uniq(
        r.structures.filter((k: unknown): k is Structure =>
          (STRUCTURES as readonly string[]).includes(k as string)
        )
      )
    : []
  const creatures = Array.isArray(r.creatures)
    ? uniq(
        r.creatures.filter((k: unknown): k is Creature =>
          (CREATURES as readonly string[]).includes(k as string)
        )
      )
    : base.creatures

  const baseStory = base.story
  const shardsIn: any[] = Array.isArray(s.shards) ? s.shards : []
  const shards: ShardStory[] = baseStory.shards.map((b, i) => ({
    name: str(shardsIn[i]?.name, b.name, 60),
    place: str(shardsIn[i]?.place, b.place, 60),
    lore: str(shardsIn[i]?.lore, b.lore, 900)
  }))
  const wanderersIn: any[] = Array.isArray(s.wanderers) ? s.wanderers : []
  const wanderers: WandererStory[] = baseStory.wanderers.map((b, i) => {
    const w = wanderersIn[i]
    const lines =
      Array.isArray(w?.lines) && w.lines.length
        ? w.lines
            .filter((l: unknown) => typeof l === 'string' && l.trim())
            .slice(0, 5)
            .map((l: string) => l.trim().slice(0, 400))
        : b.lines
    return {
      name: str(w?.name, b.name, 40),
      epithet: str(w?.epithet, b.epithet, 80),
      lines: lines.length ? lines : b.lines
    }
  })
  const placesIn: any[] = Array.isArray(s.places) ? s.places : []
  const places = baseStory.places.map((b, i) => ({
    name: str(placesIn[i]?.name, b.name, 60),
    note: str(placesIn[i]?.note, b.note, 400)
  }))
  const echoesIn: unknown[] = Array.isArray(s.echoes) ? s.echoes : []
  const echoes = baseStory.echoes.map((b, i) => str(echoesIn[i], b, 300))
  const questsIn: any[] = Array.isArray(s.quests) ? s.quests : []
  const quests: QuestStory[] = baseStory.quests.map((b, i) => {
    const q = questsIn[i]
    return {
      item: str(q?.item, b.item, 60),
      ask: str(q?.ask, b.ask, 500),
      thanks: str(q?.thanks, b.thanks, 500),
      after: str(q?.after, b.after, 300)
    }
  })
  const paras = (v: unknown, fb: string[]): string[] =>
    Array.isArray(v) && v.some((x) => typeof x === 'string' && x.trim())
      ? v
          .filter((x): x is string => typeof x === 'string' && !!x.trim())
          .slice(0, 5)
          .map((x) => x.trim().slice(0, 900))
      : fb

  return {
    version: 1,
    source: r.source === 'claude' ? 'claude' : base.source,
    prompt: str(r.prompt, base.prompt, 1000),
    seed: typeof r.seed === 'number' && Number.isFinite(r.seed) ? r.seed >>> 0 : base.seed,
    name: str(r.name, base.name, 50),
    biome: oneOf(BIOMES, r.biome, base.biome),
    mood: oneOf(MOODS, r.mood, base.mood),
    timeOfDay: num(r.timeOfDay, 0, 1, base.timeOfDay),
    weather: oneOf(WEATHERS, r.weather, base.weather),
    fog: num(r.fog, 0, 1, base.fog),
    terrain: {
      height: num(t.height, 0, 1, base.terrain.height),
      roughness: num(t.roughness, 0, 1, base.terrain.roughness),
      waterLevel: num(t.waterLevel, 0, 1, base.terrain.waterLevel),
      plateaus: typeof t.plateaus === 'boolean' ? t.plateaus : base.terrain.plateaus,
      spires: typeof t.spires === 'boolean' ? t.spires : base.terrain.spires
    },
    liquid: oneOf(LIQUIDS, r.liquid, base.liquid),
    flora: {
      kinds: floraKinds.length ? floraKinds : base.flora.kinds,
      density: num(f.density, 0, 1, base.flora.density)
    },
    structures: structures.length ? structures : base.structures,
    creatures,
    moons: Math.round(num(r.moons, 0, 3, base.moons)),
    aurora: typeof r.aurora === 'boolean' ? r.aurora : base.aurora,
    palette,
    story: {
      title: str(s.title, baseStory.title, 80),
      role: str(s.role, baseStory.role, 60),
      prologue: paras(s.prologue, baseStory.prologue),
      goal: str(s.goal, baseStory.goal, 200),
      relic: str(s.relic, baseStory.relic, 60),
      shardNoun: str(s.shardNoun, baseStory.shardNoun, 20).toLowerCase(),
      shards,
      wanderers,
      places,
      echoes,
      quests,
      finale: {
        place: str(s.finale?.place, baseStory.finale.place, 60),
        text: str(s.finale?.text, baseStory.finale.text, 900)
      },
      epilogue: paras(s.epilogue, baseStory.epilogue)
    }
  }
}
