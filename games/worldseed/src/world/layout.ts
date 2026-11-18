import { Rng } from '../engine/rng'
import { LAND_RADIUS, Terrain, type Pad } from './terrain'
import { SHARD_COUNT, type Structure, type WorldSpec } from './spec'

export interface Site {
  x: number
  z: number
  /** Facing angle (radians) — structures face the world's heart. */
  yaw: number
}

export interface ShardSite extends Site {
  structure: Structure
}

export interface Layout {
  spawn: Site
  heart: Site
  shards: ShardSite[]
  places: Site[]
  wanderers: Site[]
  pads: Pad[]
}

const PAD_RADIUS: Record<Structure, number> = {
  ruins: 16,
  tower: 12,
  henge: 16,
  arch: 12,
  lighthouse: 10,
  colossus: 20,
  hamlet: 22,
  shrine: 13
}

/**
 * Decides where the story happens: the heart near the middle, one landmark per shard
 * spread around the compass, a spawn point with a view, and minor places between.
 */
export function planLayout(spec: WorldSpec, terrain: Terrain, rng: Rng): Layout {
  const liquid = terrain.liquidY
  const walkable = (x: number, z: number, margin = 2): boolean =>
    terrain.solidLiquid ? true : terrain.naturalHeight(x, z) > liquid + margin
  const slope = (x: number, z: number): number => {
    const e = 4
    const dx = terrain.naturalHeight(x + e, z) - terrain.naturalHeight(x - e, z)
    const dz = terrain.naturalHeight(x, z + e) - terrain.naturalHeight(x, z - e)
    return Math.hypot(dx, dz) / (2 * e)
  }
  const taken: { x: number; z: number; r: number }[] = []
  const clear = (x: number, z: number, r: number): boolean =>
    taken.every((t) => Math.hypot(x - t.x, z - t.z) > t.r + r)

  /** Best-of-N search for a site that satisfies `score` (higher is better). */
  const search = (
    tries: number,
    gen: () => [number, number],
    score: (x: number, z: number) => number
  ): [number, number] => {
    let best: [number, number] = gen()
    let bestScore = -Infinity
    for (let i = 0; i < tries; i++) {
      const [x, z] = gen()
      const s = score(x, z)
      if (s > bestScore) {
        bestScore = s
        best = [x, z]
      }
    }
    return best
  }

  const r = rng.fork('layout')
  const polar =
    (minR: number, maxR: number, angle?: number, spread = Math.PI): (() => [number, number]) =>
    () => {
      const a = angle === undefined ? r.range(0, Math.PI * 2) : angle + r.range(-spread, spread)
      const d = Math.sqrt(r.range(minR * minR, maxR * maxR))
      return [Math.cos(a) * d, Math.sin(a) * d]
    }

  // The heart: central, flat, dry.
  const [hx, hz] = search(
    220,
    polar(0, LAND_RADIUS * 0.3),
    (x, z) => (walkable(x, z, 4) ? 0 : -1000) - slope(x, z) * 40 - Math.hypot(x, z) * 0.05
  )
  taken.push({ x: hx, z: hz, r: 60 })
  const heartH = Math.max(terrain.naturalHeight(hx, hz), liquid + 3)

  // Shards: one per compass quarter, spread out, each with its structure.
  const startAngle = r.range(0, Math.PI * 2)
  const shards: ShardSite[] = []
  for (let i = 0; i < SHARD_COUNT; i++) {
    const structure = spec.structures[i % spec.structures.length]
    const angle = startAngle + (i / SHARD_COUNT) * Math.PI * 2
    const pad = PAD_RADIUS[structure]
    const [x, z] = search(
      260,
      polar(LAND_RADIUS * 0.38, LAND_RADIUS * 0.82, angle, 0.5),
      (x, z) => {
        let s = walkable(x, z, structure === 'lighthouse' ? 1 : 3) ? 0 : -1000
        s -= slope(x, z) * 30
        if (!clear(x, z, pad + 30)) s -= 500
        if (structure === 'lighthouse') {
          // Lighthouses want the sea: reward water within 40 units.
          let wet = 0
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2
            if (terrain.naturalHeight(x + Math.cos(a) * 40, z + Math.sin(a) * 40) < liquid) wet++
          }
          s += wet * 6
        } else if (structure === 'tower' || structure === 'henge') {
          // Towers and stone rings like high ground with a view.
          s += (terrain.naturalHeight(x, z) - liquid) * 0.15
        }
        return s
      }
    )
    taken.push({ x, z, r: pad + 20 })
    shards.push({ x, z, yaw: Math.atan2(hx - x, hz - z), structure })
  }

  // Spawn: between the first two shards, partway out, so a beacon and the heart are both in view.
  const midAngle = Math.atan2(shards[0].z + shards[1].z, shards[0].x + shards[1].x)
  const [sx, sz] = search(
    260,
    polar(LAND_RADIUS * 0.25, LAND_RADIUS * 0.55, midAngle, 0.6),
    (x, z) => (walkable(x, z, 3) ? 0 : -1000) - slope(x, z) * 25 + (clear(x, z, 25) ? 0 : -300)
  )
  taken.push({ x: sx, z: sz, r: 20 })
  const spawn: Site = { x: sx, z: sz, yaw: Math.atan2(hx - sx, hz - sz) }

  // Minor places and wanderer homes.
  const places: Site[] = []
  for (let i = 0; i < 4; i++) {
    const [x, z] = search(
      160,
      polar(LAND_RADIUS * 0.15, LAND_RADIUS * 0.85),
      (x, z) => (walkable(x, z, 2) ? 0 : -1000) - slope(x, z) * 15 + (clear(x, z, 70) ? 0 : -400)
    )
    taken.push({ x, z, r: 12 })
    places.push({ x, z, yaw: r.range(0, Math.PI * 2) })
  }

  const wanderers: Site[] = []
  const anchors = [spawn, shards[2], shards[3]]
  for (let i = 0; i < 3; i++) {
    const a = anchors[i]
    const near = i === 0 ? 22 : 55
    const [x, z] = search(
      120,
      () => {
        const ang = r.range(0, Math.PI * 2)
        const d = r.range(near * 0.6, near)
        return [a.x + Math.cos(ang) * d, a.z + Math.sin(ang) * d]
      },
      (x, z) => (walkable(x, z, 2) ? 0 : -1000) - slope(x, z) * 20 + (clear(x, z, 4) ? 0 : -100)
    )
    wanderers.push({ x, z, yaw: 0 })
  }

  const pads: Pad[] = [
    { x: hx, z: hz, r: 26, h: heartH },
    ...shards.map((s) => ({
      x: s.x,
      z: s.z,
      r: PAD_RADIUS[s.structure],
      h: Math.max(
        terrain.naturalHeight(s.x, s.z),
        liquid + (s.structure === 'lighthouse' ? 2 : 2.5)
      )
    })),
    ...places.map((p) => ({
      x: p.x,
      z: p.z,
      r: 5,
      h: Math.max(terrain.naturalHeight(p.x, p.z), liquid + 1.5)
    })),
    { x: sx, z: sz, r: 6, h: Math.max(terrain.naturalHeight(sx, sz), liquid + 1.5) }
  ]

  return { spawn, heart: { x: hx, z: hz, yaw: 0 }, shards, places, wanderers, pads }
}
