import { describe, expect, it } from 'vitest'
import { Rng } from '../engine/rng'
import { RiverNet } from './rivers'
import { interpret } from './interpreter'
import { normalizeSpec } from './spec'

// A simple cone-shaped island: high in the middle, sea all around.
const island = (x: number, z: number): number => 60 - Math.hypot(x, z) * 0.12

describe('rivers', () => {
  const net = new RiverNet(3, island, 0, 560, new Rng(42))

  it('runs from high ground down to the sea', () => {
    expect(net.rivers.length).toBeGreaterThan(0)
    for (const r of net.rivers) {
      expect(r[0].surface).toBeGreaterThan(20)
      expect(r[r.length - 1].surface).toBeLessThan(1)
    }
  })

  it('never flows uphill, and widens downstream', () => {
    for (const r of net.rivers) {
      for (let i = 1; i < r.length; i++)
        expect(r[i].surface).toBeLessThanOrEqual(r[i - 1].surface + 1e-9)
      expect(r[r.length - 1].width).toBeGreaterThan(r[0].width)
    }
  })

  it('carves a bed below the water and leaves far land alone', () => {
    const p = net.rivers[0][20]
    expect(net.carve(p.x, p.z, island(p.x, p.z))).toBeLessThan(p.surface)
    expect(net.wetAt(p.x, p.z, net.carve(p.x, p.z, island(p.x, p.z)))).toBe(true)
    // A point well off to the side of every river is untouched.
    const far = { x: -p.x * 0.2 + 400, z: 400 }
    if (!net.near(far.x, far.z, 3))
      expect(net.carve(far.x, far.z, island(far.x, far.z))).toBe(island(far.x, far.z))
  })
})

describe('interpreting rivers and floating isles', () => {
  it('reads them from the description', () => {
    expect(interpret('a green valley with a winding river').terrain.rivers).toBe(2)
    expect(interpret('a land of many rivers and streams').terrain.rivers).toBe(3)
    expect(interpret('a meadow with no rivers').terrain.rivers).toBe(0)
    expect(interpret('a swamp').terrain.rivers).toBe(0)
    expect(interpret('islands floating in the sky above a sea of clouds').terrain.floating).toBe(
      true
    )
    expect(interpret('a quiet meadow').terrain.floating).toBe(false)
  })

  it('old specs without these fields still load', () => {
    const base = interpret('a green valley with a winding river')
    const old = JSON.parse(JSON.stringify(base))
    delete old.terrain.rivers
    delete old.terrain.floating
    const out = normalizeSpec(old, base)
    expect(out.terrain.rivers).toBe(2)
    expect(out.terrain.floating).toBe(false)
  })
})
