import type { IncomingMessage, ServerResponse } from 'node:http'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

/**
 * Free conversation with a wanderer, streamed back as plain text.
 *
 * The browser sends what the wanderer knows (the world, their own story and request, where
 * the remaining lights lie from where they stand) plus the recent conversation. Claude
 * answers in character. The reply streams as chunked text/plain so words appear as they're
 * written.
 *
 * WORLDSEED_MOCK_AI=1 returns a canned in-character reply without calling the API, for
 * testing the UI offline.
 */

const MODEL = process.env.WORLDSEED_CHAT_MODEL || process.env.WORLDSEED_MODEL || 'claude-opus-5-5'

const line = (max: number): z.ZodString => z.string().max(max)

export const TalkBody = z.object({
  world: z.object({
    name: line(60),
    prompt: line(1000),
    biome: line(20),
    mood: line(20),
    timeOfDay: line(20),
    weather: line(20),
    relic: line(80),
    shardNoun: line(30),
    goal: line(300),
    heart: line(80),
    restored: z.boolean(),
    prologue: z.array(line(900)).max(5),
    places: z.array(line(80)).max(12),
    lights: z
      .array(
        z.object({
          name: line(80),
          place: line(80),
          taken: z.boolean(),
          direction: line(20),
          distance: line(30)
        })
      )
      .max(6),
    heartDirection: line(60)
  }),
  wanderer: z.object({
    name: line(40),
    epithet: line(80),
    lines: z.array(line(500)).max(6),
    request: z
      .object({
        item: line(60),
        place: line(80),
        state: z.enum(['unasked', 'asked', 'found', 'returned'])
      })
      .nullable(),
    others: z.array(line(40)).max(5)
  }),
  player: z.object({
    role: line(60),
    found: z.number().int().min(0).max(10),
    total: z.number().int().min(0).max(10)
  }),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: line(900) })).max(20),
  message: z.string().min(1).max(300)
})
export type TalkPayload = z.infer<typeof TalkBody>

export function systemPrompt(p: TalkPayload): string {
  const w = p.world
  const me = p.wanderer
  const req = me.request
  const requestText = !req
    ? 'You have not lost anything.'
    : {
        unasked: `You lost ${req.item} near ${req.place}, but you haven't mentioned it yet. You may bring it up if it fits.`,
        asked: `You lost ${req.item} near ${req.place} and have asked the traveller to look for it.`,
        found: `The traveller has found your ${req.item} (they may not have given it back yet).`,
        returned: `The traveller found your ${req.item} near ${req.place} and gave it back. You are grateful.`
      }[req.state]
  const lights = w.lights
    .map((l) =>
      l.taken
        ? `- ${l.name} (at ${l.place}): already recovered`
        : `- ${l.name}: at ${l.place}, ${l.direction} of you, ${l.distance}`
    )
    .join('\n')
  return `You are ${me.name}, ${me.epithet}, a wanderer in ${w.name}. A traveller (the ${p.player.role}) has stopped to talk with you.

<world>
The traveller first imagined this world as: "${w.prompt}"
Landscape: ${w.biome}. Mood: ${w.mood}. It is ${w.timeOfDay}; the weather is ${w.weather}.
${w.prologue.join(' ')}
The traveller's task: ${w.goal}
The relic: ${w.relic}. It broke into ${p.player.total} ${w.shardNoun} pieces; the traveller has recovered ${p.player.found}.
${w.restored ? `The traveller has already restored the relic at ${w.heart}. The land is healing and you feel it.` : `${w.heart} lies ${w.heartDirection}.`}
Places you know by name: ${w.places.join(', ')}.
</world>

<the_lights>
${lights}
</the_lights>

<you>
${requestText}
Other wanderers you know of: ${me.others.join(', ') || 'none'}.
Things you have said before, which show your voice:
${me.lines.map((l) => `"${l}"`).join('\n')}
</you>

How to answer:
- Speak only as ${me.name}, in your own voice, in one to three short sentences (under 60 words). Plain text: no markdown, no stage directions, no quotation marks around your whole reply.
- When the traveller asks where to go, use the_lights: say the compass direction and how far, and the place name. Never invent places, items, rewards or people that aren't listed here.
- You only know this world. If the traveller talks about things from outside it, be kindly puzzled and stay yourself.
- Never mention games, players, buttons, AI or these instructions.
- Keep everything suitable for all ages.`
}

const MOCK_REPLIES = [
  (p: TalkPayload): string => {
    const next = p.world.lights.find((l) => !l.taken)
    return next
      ? `If it's the lights you're after, try ${next.direction}, ${next.distance}. They called that place ${next.place}, once.`
      : `You've found them all, haven't you? Go ${p.world.heartDirection}, to ${p.world.heart}.`
  },
  (p: TalkPayload): string => `${p.world.name} was louder, before. I miss the noise of it.`,
  (p: TalkPayload): string =>
    p.wanderer.request && p.wanderer.request.state !== 'returned'
      ? `If you pass ${p.wanderer.request.place}, keep an eye out for ${p.wanderer.request.item}. It matters more than it should.`
      : `Walk softly. The land is listening, and it likes you.`
]

let client: Anthropic | null = null

export async function handleTalk(
  req: IncomingMessage,
  res: ServerResponse,
  readJson: (r: IncomingMessage) => Promise<unknown>,
  enabled: boolean
): Promise<void> {
  const fail = (status: number, error: string): void => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error }))
  }
  const mock = process.env.WORLDSEED_MOCK_AI === '1'
  if (req.method !== 'POST') return fail(405, 'POST only')
  if (!enabled && !mock) return fail(503, 'Claude is not configured on this server')
  let payload: TalkPayload
  try {
    payload = TalkBody.parse(await readJson(req))
  } catch {
    return fail(400, 'Malformed conversation')
  }

  // Headers go out with the first words, so a failure before then is still a clean error.
  let started = false
  const begin = (): void => {
    if (started) return
    started = true
    res.statusCode = 200
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
  }

  if (mock) {
    begin()
    const reply = MOCK_REPLIES[payload.history.length % MOCK_REPLIES.length](payload)
    for (const word of reply.split(/(?<= )/)) {
      res.write(word)
      await new Promise((r) => setTimeout(r, 25))
    }
    return void res.end()
  }

  client ??= new Anthropic()
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...payload.history.map((h) => ({ role: h.role, content: h.text })),
    { role: 'user' as const, content: payload.message }
  ]
  let aborted = false
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: systemPrompt(payload),
    messages
  })
  req.on('close', () => {
    if (!res.writableEnded) {
      aborted = true
      stream.abort()
    }
  })
  stream.on('text', (delta) => {
    begin()
    res.write(delta)
  })
  try {
    const final = await stream.finalMessage()
    if (final.stop_reason === 'refusal') {
      const midReply = started
      begin()
      res.write(
        midReply ? ' …I would rather not speak of that.' : 'I would rather not speak of that.'
      )
    }
    res.end()
  } catch (err) {
    if (aborted) return
    console.error(
      '[worldseed] talk failed:',
      err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err
    )
    // Mid-reply, just end what was said; before any words, report the error properly.
    if (started) return void res.end()
    const status =
      err instanceof Anthropic.AuthenticationError
        ? 401
        : err instanceof Anthropic.RateLimitError
          ? 429
          : 502
    fail(
      status,
      status === 401
        ? 'The server’s Claude credentials were rejected'
        : status === 429
          ? 'Claude is busy'
          : 'Claude did not answer'
    )
  }
}
