import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { handleTalk } from './talk'
import { BIOMES, CREATURES, FLORA, LIQUIDS, MOODS, STRUCTURES, WEATHERS } from '../src/world/spec'

/**
 * Optional server-side world generation with Claude.
 *
 * The browser never sees an API key: it posts the player's description to /api/genesis
 * on the Vite dev/preview server, which calls the Claude API and returns a WorldSpec-shaped
 * JSON object. The game validates it with normalizeSpec() and falls back to the offline
 * interpreter if anything goes wrong.
 *
 * Enabled when ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set (or WORLDSEED_AI=1 when
 * credentials come from an `ant auth login` profile).
 */

const MODEL = process.env.WORLDSEED_MODEL || 'claude-opus-5-5'

const hex = z.string().describe('A colour as #rrggbb')

const WorldSchema = z.object({
  name: z
    .string()
    .describe(
      'The world’s proper name: one or two evocative words. Use the name the player gave, if any.'
    ),
  biome: z.enum(BIOMES),
  mood: z.enum(MOODS),
  timeOfDay: z
    .number()
    .describe('0..1: 0.27 dawn, 0.46 midday, 0.6 afternoon, 0.74 dusk, 0.94 night'),
  weather: z.enum(WEATHERS),
  fog: z.number().describe('0..1 haze density; 0.1 crisp, 0.4 hazy, 0.8 thick mist'),
  terrain: z.object({
    height: z.number().describe('0..1 overall relief; 0.2 gentle, 0.5 hilly, 0.85 mountainous'),
    roughness: z.number().describe('0..1 how jagged the ridges are'),
    waterLevel: z
      .number()
      .describe('0..1 share of land under the liquid; 0.1 dry, 0.3 lakes, 0.6 archipelago'),
    plateaus: z.boolean().describe('stepped mesas and terraces'),
    spires: z.boolean().describe('tall rock pillars scattered across the land')
  }),
  liquid: z
    .enum(LIQUIDS)
    .describe('water and murk can be swum in; lava and ice are solid crusts you can walk on'),
  flora: z.object({
    kinds: z
      .array(z.enum(FLORA))
      .describe('2 to 6 kinds; include ground cover such as grass or rock'),
    density: z.number().describe('0..1 how thickly things grow')
  }),
  structures: z
    .array(z.enum(STRUCTURES))
    .describe(
      'Exactly 4, one per shard; shard i rests at structures[i]. Prefer ones the description implies. lighthouse only if there is water.'
    ),
  creatures: z.array(z.enum(CREATURES)),
  moons: z.number().int().describe('0 to 3 moons visible in the sky'),
  aurora: z.boolean(),
  palette: z.object({
    skyTop: hex,
    skyHorizon: hex.describe('also the fog colour'),
    sun: hex.describe('sunlight colour (or moonlight at night)'),
    groundLow: hex.describe('shores and lowlands'),
    groundMid: hex.describe('most of the land'),
    groundHigh: hex.describe('high ground'),
    rock: hex,
    foliage: hex,
    foliageAlt: hex,
    accent: hex.describe(
      'the glowing colour of the shards and their pillars of light; must stand out vividly against the sky and ground'
    ),
    liquid: hex,
    stone: hex.describe('colour of the old structures')
  }),
  story: z.object({
    title: z.string().describe('Title of this world’s story, e.g. "The Embers of Varrow"'),
    role: z.string().describe('Who the player is, 1–4 words, e.g. "Lamplighter"'),
    prologue: z
      .array(z.string())
      .describe(
        '3 short paragraphs in second person: what this world was, what broke, and what the player must do'
      ),
    goal: z
      .string()
      .describe('One sentence objective naming the relic, the pieces and the heart place'),
    relic: z.string().describe('The broken thing, with article, e.g. "The Tide Lantern"'),
    shardNoun: z
      .string()
      .describe('Singular lowercase noun for one piece, e.g. "ember", "verse", "pearl"'),
    shards: z
      .array(
        z.object({
          name: z.string().describe('e.g. "The Drowned Verse"'),
          place: z.string().describe('Name of the region around its structure'),
          lore: z
            .string()
            .describe(
              '2–4 sentences revealed when the piece is taken: a specific memory tied to its structure'
            )
        })
      )
      .describe('Exactly 4'),
    wanderers: z
      .array(
        z.object({
          name: z.string(),
          epithet: z.string().describe('e.g. "the ferryman without a boat"'),
          lines: z
            .array(z.string())
            .describe(
              '3 lines of dialogue: a greeting, something about the world or relic, something personal'
            )
        })
      )
      .describe('Exactly 3 people the player meets'),
    places: z
      .array(
        z.object({
          name: z.string(),
          note: z.string().describe('One or two sentences about a small curious landmark')
        })
      )
      .describe('Exactly 4 minor places'),
    echoes: z
      .array(z.string())
      .describe(
        'Exactly 12 one-sentence memories of the world before it broke, each a small specific moment (a sound, a smell, a scene)'
      ),
    quests: z
      .array(
        z.object({
          item: z.string().describe('A small lost object with an article, e.g. "a tin music box"'),
          ask: z
            .string()
            .describe(
              'The wanderer asks you to find it. Must contain the literal token {place} where the place name goes.'
            ),
          thanks: z
            .string()
            .describe('What they say when you bring it back; they offer to mark your map'),
          after: z
            .string()
            .describe('One epilogue sentence about how this wanderer’s story ends, naming them')
        })
      )
      .describe('Exactly 3; quest i belongs to wanderers[i] and its item lies at places[i]'),
    finale: z.object({
      place: z.string().describe('Name of the central place where the relic is restored'),
      text: z
        .string()
        .describe('3–5 sentences: the moment of restoration and how the world changes')
    }),
    epilogue: z.array(z.string()).describe('2 short paragraphs of quiet aftermath')
  })
})

const SYSTEM = `You are the world-builder for Worldseed, a gentle third-person exploration game. A player describes a world in their own words; you turn that description into a world specification and a small story.

How the game uses your specification:
- The land is a single island, roughly 1.1 km across, surrounded by its liquid. Four landmarks (your four structures) sit around the compass, and a central heart, where the relic is restored, sits near the middle.
- Each landmark holds one piece of the broken relic, glowing in the accent colour, with a pillar of light visible from anywhere. The player finds all four pieces, meets three wanderers who talk and give directions, discovers four minor places, and then restores the relic at the heart.
- Each piece is sealed until the player wakes three waystones around its landmark. Each wanderer has lost something at one of the minor places and asks the player to bring it back. Twelve drifting echoes, each a one-line memory, are scattered over the land.
- The colours are rendered directly, so choose a coherent, beautiful palette that matches the description and the time of day. Night skies should be dark; dusk horizons warm. The accent must stay vivid against the sky.

Writing:
- Honour the player's description closely. Every detail they gave should show up in the world or the story, and their tone sets yours.
- Keep the prose concrete, warm and a little strange: specific sensory details, no clichés about "ancient evil", no game mechanics, no button names.
- Keep it suitable for all ages. If a description asks for gore or cruelty, keep the setting it names and handle the dark parts with restraint.
- The player is never named and has no gender.`

const Body = z.object({ prompt: z.string().min(1).max(1000) })

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 20_000) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

export function aiEnabled(): boolean {
  return (
    !!(
      process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.WORLDSEED_AI === '1'
    ) && process.env.WORLDSEED_AI !== '0'
  )
}

let client: Anthropic | null = null

async function dream(prompt: string): Promise<unknown> {
  client ??= new Anthropic()
  const message = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    // If the model declines on policy grounds, let the API retry on its default fallback.
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(WorldSchema) },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Here is the player's description of their world:\n\n<description>\n${prompt}\n</description>\n\nBuild the world specification.`
      }
    ]
  })
  if (message.stop_reason === 'refusal') throw Object.assign(new Error('declined'), { status: 422 })
  if (message.stop_reason === 'max_tokens' || !message.parsed_output)
    throw new Error('incomplete response')
  return message.parsed_output
}

async function handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
  const url = req.url?.split('?')[0] ?? ''
  if (!url.endsWith('/api/status') && !url.endsWith('/api/genesis') && !url.endsWith('/api/talk'))
    return next()
  if (url.endsWith('/api/status'))
    return send(res, 200, {
      ai: aiEnabled(),
      model: aiEnabled() ? MODEL : null,
      talk: aiEnabled() || process.env.WORLDSEED_MOCK_AI === '1'
    })
  if (url.endsWith('/api/talk')) return handleTalk(req, res, readJson, aiEnabled())
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  if (!aiEnabled()) return send(res, 503, { error: 'Claude is not configured on this server' })
  let prompt: string
  try {
    prompt = Body.parse(await readJson(req)).prompt
  } catch {
    return send(res, 400, { error: 'Expected {"prompt": "..."}' })
  }
  const started = Date.now()
  try {
    const world = await dream(prompt)
    console.log(`[worldseed] dreamed a world in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    send(res, 200, world)
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError)
      return send(res, 401, { error: 'The server’s Claude credentials were rejected' })
    if (err instanceof Anthropic.RateLimitError)
      return send(res, 429, { error: 'Claude is busy; try again in a moment' })
    if (err instanceof Anthropic.APIError)
      return send(res, 502, { error: `Claude API error ${err.status ?? ''}`.trim() })
    const status = (err as { status?: number }).status ?? 500
    console.error('[worldseed] genesis failed:', err)
    send(res, status, {
      error: status === 422 ? 'Claude declined to build that world' : 'World generation failed'
    })
  }
}

/** Vite plugin: serves /api/status and /api/genesis in `vite` and `vite preview`. */
export function genesisPlugin(): Plugin {
  const mount = (
    use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void
  ): void => use((req, res, next) => void handle(req, res, next))
  return {
    name: 'worldseed-genesis',
    configureServer(server) {
      mount((fn) => server.middlewares.use(fn))
    },
    configurePreviewServer(server) {
      mount((fn) => server.middlewares.use(fn))
    }
  }
}
