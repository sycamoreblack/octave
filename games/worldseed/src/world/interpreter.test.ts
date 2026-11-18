import { describe, expect, it } from 'vitest'
import { interpret, randomPrompt, EXAMPLE_PROMPTS } from './interpreter'
import { normalizeSpec, SHARD_COUNT } from './spec'
import { Rng } from '../engine/rng'

describe('interpret', () => {
  it('is deterministic for the same words', () => {
    const a = interpret('A drowned archipelago at dusk')
    const b = interpret('  a drowned   archipelago at dusk ')
    expect(a.seed).toBe(b.seed)
    expect(a.story).toEqual(b.story)
    expect(a.palette).toEqual(b.palette)
  })

  it('reads biome, time, weather and structures from the description', () => {
    const w = interpret(
      'A red desert under two moons at night, scattered with the bones of colossal machines'
    )
    expect(w.biome).toBe('desert')
    expect(w.moons).toBe(2)
    expect(w.timeOfDay).toBeGreaterThan(0.85)
    expect(w.structures[0]).toBe('colossus')
  })

  it('handles islands, volcanoes, swamps and tundra', () => {
    expect(interpret('a chain of tropical islands with lighthouses').biome).toBe('islands')
    expect(interpret('a volcano spilling lava into the sea of ash').liquid).toBe('lava')
    expect(interpret('a misty swamp full of fireflies').weather).toMatch(/fog|fireflies/)
    expect(interpret('a frozen glacier wasteland of ice').biome).toBe('tundra')
  })

  it('respects negation', () => {
    const w = interpret('a quiet forest with no birds')
    expect(w.creatures).not.toContain('birds')
  })

  it("adds named ground cover without losing the biome's trees", () => {
    const w = interpret(
      'A quiet meadow at dawn with a little village, wildflowers and ancient standing stones'
    )
    expect(w.flora.kinds).toContain('broadleaf')
    expect(w.flora.kinds).toContain('flower')
    expect(w.structures).toEqual(expect.arrayContaining(['hamlet', 'henge']))
    expect(interpret('a dark pine forest').flora.kinds).toContain('pine')
    expect(interpret('a desert with no trees').flora.kinds).not.toContain('deadtree')
    expect(interpret('a forest without birds or spirits').creatures).toEqual([])
  })

  it('picks up a world name', () => {
    expect(interpret('A misty valley called Ellowmere, full of ruins').name).toBe('Ellowmere')
  })

  it('always produces a complete story', () => {
    for (const prompt of [...EXAMPLE_PROMPTS, '', '???', 'x'.repeat(2000)]) {
      const w = interpret(prompt)
      expect(w.story.shards).toHaveLength(SHARD_COUNT)
      expect(new Set(w.story.shards.map((s) => s.place)).size).toBe(SHARD_COUNT)
      expect(w.story.wanderers).toHaveLength(3)
      expect(w.story.places).toHaveLength(4)
      expect(w.structures.length).toBeGreaterThan(0)
      expect(w.flora.kinds.length).toBeGreaterThan(0)
      for (const c of Object.values(w.palette)) expect(c).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('random prompts are varied and interpretable', () => {
    const rng = new Rng(7)
    const prompts = new Set(Array.from({ length: 20 }, () => randomPrompt(rng)))
    expect(prompts.size).toBeGreaterThan(10)
    for (const p of prompts) expect(interpret(p).story.title).toBeTruthy()
  })
})

describe('normalizeSpec', () => {
  const base = interpret('a quiet meadow')

  it('keeps valid fields and repairs invalid ones', () => {
    const out = normalizeSpec(
      {
        biome: 'volcanic',
        timeOfDay: 7,
        palette: { skyTop: '#123456', accent: 'not a colour' },
        flora: { kinds: ['pine', 'banana'], density: 0.5 },
        story: { title: 'Ash and Song', shards: [{ name: 'One' }] }
      },
      base
    )
    expect(out.biome).toBe('volcanic')
    expect(out.timeOfDay).toBe(1)
    expect(out.palette.skyTop).toBe('#123456')
    expect(out.palette.accent).toBe(base.palette.accent)
    expect(out.flora.kinds).toEqual(['pine'])
    expect(out.story.title).toBe('Ash and Song')
    expect(out.story.shards[0].name).toBe('One')
    expect(out.story.shards[0].lore).toBe(base.story.shards[0].lore)
    expect(out.story.shards).toHaveLength(SHARD_COUNT)
  })

  it('survives garbage', () => {
    expect(normalizeSpec(null, base)).toEqual(base)
    expect(normalizeSpec('nope', base)).toEqual(base)
  })
})
