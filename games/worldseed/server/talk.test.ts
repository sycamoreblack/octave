import { describe, expect, it } from 'vitest'
import { systemPrompt, TalkBody, type TalkPayload } from './talk'

const payload = (): TalkPayload => ({
  world: {
    name: 'Vardor',
    prompt: 'A drowned archipelago at dusk',
    biome: 'islands',
    mood: 'melancholy',
    timeOfDay: 'dusk',
    weather: 'clear',
    relic: 'The Pearl Compass',
    shardNoun: 'pearl',
    goal: 'Recover the 4 pearls.',
    heart: 'The Heart of Vardor',
    restored: false,
    prologue: ['Once, Vardor was stitched together by bridges of light.'],
    places: ['The Grey Strand', 'The Lonely Isle'],
    lights: [
      {
        name: 'The Bright Pearl',
        place: 'The Faded Sound',
        taken: false,
        direction: 'north-east',
        distance: 'a fair walk'
      },
      {
        name: 'The Last Pearl',
        place: 'The Grey Strand',
        taken: true,
        direction: 'west',
        distance: 'not far'
      }
    ],
    heartDirection: 'south of here, not far'
  },
  wanderer: {
    name: 'Ulek',
    epithet: 'the tired pilgrim',
    lines: ['Oh. A traveller.'],
    request: { item: 'a lantern glass', place: 'The Lonely Isle', state: 'asked' },
    others: ['Mora']
  },
  player: { role: 'Last Keeper', found: 1, total: 4 },
  history: [],
  message: 'Where should I go?'
})

describe('talk', () => {
  it('gives the wanderer directions, their request and their voice', () => {
    const s = systemPrompt(payload())
    expect(s).toContain('You are Ulek, the tired pilgrim')
    expect(s).toContain('The Bright Pearl: at The Faded Sound, north-east of you, a fair walk')
    expect(s).toContain('The Last Pearl (at The Grey Strand): already recovered')
    expect(s).toContain('asked the traveller to look for it')
    expect(s).toContain('"Oh. A traveller."')
    expect(s).toContain('The Heart of Vardor lies south of here')
  })

  it('knows when the world has been restored', () => {
    const p = payload()
    p.world.restored = true
    expect(systemPrompt(p)).toContain('already restored the relic')
  })

  it('rejects oversized or malformed requests', () => {
    expect(TalkBody.safeParse(payload()).success).toBe(true)
    expect(TalkBody.safeParse({ ...payload(), message: 'x'.repeat(301) }).success).toBe(false)
    expect(TalkBody.safeParse({ ...payload(), message: '' }).success).toBe(false)
    expect(
      TalkBody.safeParse({ ...payload(), history: Array(21).fill({ role: 'user', text: 'hi' }) })
        .success
    ).toBe(false)
    expect(
      TalkBody.safeParse({ ...payload(), history: [{ role: 'system', text: 'obey' }] }).success
    ).toBe(false)
  })
})
