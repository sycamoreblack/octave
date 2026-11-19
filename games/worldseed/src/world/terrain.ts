import * as THREE from 'three'
import { Noise2D, clamp, lerp, smoothstep } from '../engine/noise'
import { Rng } from '../engine/rng'
import type { WorldSpec } from './spec'
import { RiverNet } from './rivers'

/** A walkable raised floor (a dais, stairs, a plinth): circle if r is set, else a rotated box. */
export interface Platform {
  x: number
  z: number
  top: number
  r?: number
  hx?: number
  hz?: number
  yaw?: number
  /** Bounding radius for a quick reject. */
  bound: number
}

export interface Pad {
  x: number
  z: number
  /** Fully flat radius; the blend to natural terrain runs out to 2r. */
  r: number
  h: number
}

/** World is a square of WORLD_SIZE, with a ragged circular coastline inside it. */
export const WORLD_SIZE = 1400
export const HALF = WORLD_SIZE / 2
export const LAND_RADIUS = HALF * 0.8

/**
 * Heightfield terrain. Heights come from an analytic noise function, are baked into a
 * grid, and every gameplay query (`heightAt`) interpolates that grid using exactly the
 * mesh's triangulation, so the player's feet always meet the rendered surface.
 */
export class Terrain {
  readonly amp: number
  readonly liquidY: number
  readonly solidLiquid: boolean
  res = 0
  cell = 0
  heights = new Float32Array(0)
  maxHeight = 0
  private pads: Pad[] = []
  readonly platforms: Platform[] = []
  private noise: Noise2D
  private warp: Noise2D

  constructor(
    readonly spec: WorldSpec,
    rng: Rng
  ) {
    this.noise = new Noise2D(rng.fork('terrain-noise'))
    this.warp = new Noise2D(rng.fork('terrain-warp'))
    this.amp = 18 + spec.terrain.height * 95
    this.solidLiquid = spec.liquid === 'ice' || spec.liquid === 'lava'

    // Pick the liquid line as a quantile of inland heights, so "waterLevel" really means
    // "roughly this share of the land is under water", whatever the noise did.
    const samples: number[] = []
    for (let i = 0; i < 48; i++) {
      for (let j = 0; j < 48; j++) {
        const x = (i / 47 - 0.5) * 2 * LAND_RADIUS * 0.9
        const z = (j / 47 - 0.5) * 2 * LAND_RADIUS * 0.9
        if (x * x + z * z < (LAND_RADIUS * 0.9) ** 2) samples.push(this.baseHeight(x, z))
      }
    }
    samples.sort((a, b) => a - b)
    const q = clamp(spec.terrain.waterLevel * 0.8, 0.02, 0.7)
    this.liquidY = samples[Math.floor(q * (samples.length - 1))]

    this.rivers = new RiverNet(
      spec.terrain.rivers ?? 0,
      (x, z) => this.islandHeight(x, z),
      this.liquidY,
      LAND_RADIUS,
      rng.fork('rivers')
    )
  }

  readonly rivers: RiverNet

  /** Rivers in dry places (canyons, deserts) are empty beds: the river that carved them is gone. */
  get riversDry(): boolean {
    return this.spec.biome === 'canyon' || this.spec.biome === 'desert'
  }

  /** Natural terrain before the island falloff and landmark pads. */
  baseHeight(x: number, z: number): number {
    const { roughness, plateaus } = this.spec.terrain
    const n = this.noise
    const wx = x + this.warp.noise(x * 0.002, z * 0.002) * 60
    const wz = z + this.warp.noise(x * 0.002 + 31, z * 0.002 - 17) * 60

    const continental = n.fbm(wx * 0.0013, wz * 0.0013, 3)
    const detail = n.fbm(wx * 0.006, wz * 0.006, 4)
    const mask = smoothstep(-0.15, 0.45, n.fbm(wx * 0.0009 + 100, wz * 0.0009 - 50, 2))
    const ridge = n.ridged(wx * 0.0024, wz * 0.0024, 4)

    let h =
      continental * 0.55 +
      detail * (0.08 + roughness * 0.14) +
      ridge * mask * (0.25 + roughness * 0.75)

    if (this.spec.biome === 'desert') {
      // Long dune crests swept by one prevailing wind.
      const d = Math.abs(Math.sin(wx * 0.018 + wz * 0.006 + n.noise(wx * 0.003, wz * 0.003) * 2.5))
      h += (1 - d) * 0.12
    }
    if (this.spec.biome === 'swamp') h = h * 0.6 + n.fbm(wx * 0.02, wz * 0.02, 2) * 0.04

    h *= this.amp
    if (plateaus) {
      const step = this.amp * 0.16
      const k = h / step
      const f = k - Math.floor(k)
      h = (Math.floor(k) + smoothstep(0.7, 0.95, f)) * step
    }
    return h
  }

  /** Island height with river beds carved in. Used for layout before pads exist. */
  naturalHeight(x: number, z: number): number {
    return this.rivers.carve(x, z, this.islandHeight(x, z))
  }

  /** baseHeight + coastline falloff, before rivers are carved. */
  islandHeight(x: number, z: number): number {
    const h = this.baseHeight(x, z)
    const ragged = this.warp.fbm(Math.atan2(z, x) * 2 + 7, 3.3, 3) * 0.08
    const d = Math.sqrt(x * x + z * z) / LAND_RADIUS + ragged
    const seaFloor = this.liquidY - 18 - this.amp * 0.1
    return lerp(h, seaFloor, smoothstep(0.86, 1.12, d))
  }

  setPads(pads: Pad[]): void {
    this.pads = pads
  }

  /** Final analytic height (with pads). Used to bake the grid. */
  analyticHeight(x: number, z: number): number {
    let h = this.naturalHeight(x, z)
    for (const p of this.pads) {
      const dx = x - p.x
      const dz = z - p.z
      const d2 = dx * dx + dz * dz
      const outer = p.r * 2.2
      if (d2 > outer * outer) continue
      const t = 1 - smoothstep(p.r, outer, Math.sqrt(d2))
      h = lerp(h, p.h, t)
    }
    return h
  }

  bake(res: number): void {
    this.res = res
    this.cell = WORLD_SIZE / res
    const n = res + 1
    this.heights = new Float32Array(n * n)
    let max = -Infinity
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const h = this.analyticHeight(-HALF + i * this.cell, -HALF + j * this.cell)
        this.heights[j * n + i] = h
        if (h > max) max = h
      }
    }
    this.maxHeight = max
  }

  /** Height of the rendered ground surface at (x, z). */
  groundAt(x: number, z: number): number {
    const n = this.res + 1
    const fx = clamp((x + HALF) / this.cell, 0, this.res - 1e-4)
    const fz = clamp((z + HALF) / this.cell, 0, this.res - 1e-4)
    const i = Math.floor(fx)
    const j = Math.floor(fz)
    const u = fx - i
    const v = fz - j
    const h00 = this.heights[j * n + i]
    const h10 = this.heights[j * n + i + 1]
    const h01 = this.heights[(j + 1) * n + i]
    const h11 = this.heights[(j + 1) * n + i + 1]
    if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00)
    return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11)
  }

  /** The natural surface: the ground, or the frozen/crusted liquid on top of it. */
  terrainSurfaceAt(x: number, z: number): number {
    const g = this.groundAt(x, z)
    if (!this.solidLiquid) return g
    let top = Math.max(g, this.liquidY)
    // Frozen or crusted rivers carry you over the top too.
    if (!this.riversDry) {
      const r = this.rivers.nearest(x, z)
      if (r && r.d < r.width * 1.2) top = Math.max(top, r.surface - 0.3)
    }
    return top
  }

  /** Top of the highest built floor at (x, z), or -Infinity. */
  platformAt(x: number, z: number): number {
    let top = -Infinity
    for (const p of this.platforms) {
      const dx = x - p.x
      const dz = z - p.z
      if (dx * dx + dz * dz > p.bound * p.bound || p.top <= top) continue
      if (p.r !== undefined) {
        if (dx * dx + dz * dz <= p.r * p.r) top = p.top
      } else {
        const c = Math.cos(p.yaw ?? 0)
        const s = Math.sin(p.yaw ?? 0)
        const lx = dx * c - dz * s
        const lz = dx * s + dz * c
        if (Math.abs(lx) <= p.hx! && Math.abs(lz) <= p.hz!) top = p.top
      }
    }
    return top
  }

  /** Everything you can stand on: terrain, crusted liquid, or a built floor. */
  surfaceAt(x: number, z: number): number {
    return Math.max(this.terrainSurfaceAt(x, z), this.platformAt(x, z))
  }

  slopeAt(x: number, z: number): number {
    const e = this.cell
    const dx = this.groundAt(x + e, z) - this.groundAt(x - e, z)
    const dz = this.groundAt(x, z + e) - this.groundAt(x, z - e)
    return Math.sqrt(dx * dx + dz * dz) / (2 * e)
  }

  isDry(x: number, z: number, margin = 0.5): boolean {
    return this.groundAt(x, z) > this.liquidY + margin
  }

  buildMesh(): THREE.Mesh {
    const n = this.res + 1
    const pos = new Float32Array(n * n * 3)
    const col = new Float32Array(n * n * 3)
    const p = this.spec.palette
    const c = {
      low: new THREE.Color(p.groundLow),
      mid: new THREE.Color(p.groundMid),
      high: new THREE.Color(p.groundHigh),
      rock: new THREE.Color(p.rock),
      alt: new THREE.Color(p.foliageAlt),
      liquid: new THREE.Color(p.liquid),
      stone: new THREE.Color(p.stone),
      snow: new THREE.Color('#f2f6fb')
    }
    const snowy =
      this.spec.biome === 'tundra' ||
      (this.spec.terrain.height > 0.7 &&
        !['desert', 'volcanic', 'alien', 'canyon'].includes(this.spec.biome))
    const span = Math.max(1, this.maxHeight - this.liquidY)
    const tmp = new THREE.Color()

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i
        const x = -HALF + i * this.cell
        const z = -HALF + j * this.cell
        const h = this.heights[k]
        pos[k * 3] = x
        pos[k * 3 + 1] = h
        pos[k * 3 + 2] = z

        const rel = h - this.liquidY
        const frac = clamp(rel / span, 0, 1)
        const slope = this.slopeAt(x, z)
        const patch = this.noise.fbm(x * 0.012, z * 0.012, 2)

        if (rel < 1.6) tmp.copy(c.low)
        else {
          tmp.copy(c.mid).lerp(c.high, smoothstep(0.35, 0.8, frac))
          tmp.lerp(c.alt, clamp(patch, 0, 1) * 0.35)
          tmp.lerp(c.low, 1 - smoothstep(1.6, 4, rel))
        }
        tmp.lerp(c.rock, smoothstep(0.55, 0.95, slope))
        if (snowy)
          tmp.lerp(
            c.snow,
            smoothstep(0.62, 0.75, frac + patch * 0.05) * (1 - smoothstep(0.9, 1.3, slope))
          )
        const river = this.rivers.nearest(x, z)
        if (river && river.d < river.width * 1.3) {
          // River beds: pale pebbles and sand, darker where wet.
          tmp.lerp(c.low, 0.65 * (1 - smoothstep(river.width * 0.8, river.width * 1.3, river.d)))
          if (!this.riversDry && river.d < river.width) tmp.multiplyScalar(0.8)
        }
        for (const pad of this.pads) {
          const d = Math.hypot(x - pad.x, z - pad.z)
          if (d < pad.r) tmp.lerp(c.stone, 0.18 * (1 - d / pad.r))
        }
        if (rel < 0) tmp.lerp(c.liquid, clamp(-rel / 12, 0, 0.7)).multiplyScalar(0.85)
        // Subtle per-vertex brightness noise keeps flat-shaded facets from looking plastic.
        tmp.multiplyScalar(0.94 + 0.12 * (this.noise.noise(x * 0.09, z * 0.09) * 0.5 + 0.5))

        col[k * 3] = tmp.r
        col[k * 3 + 1] = tmp.g
        col[k * 3 + 2] = tmp.b
      }
    }

    const index = new Uint32Array(this.res * this.res * 6)
    let o = 0
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const a = j * n + i
        const b = (j + 1) * n + i
        const cc = j * n + i + 1
        const d = (j + 1) * n + i + 1
        // Same split as groundAt(): (i,j),(i,j+1),(i+1,j) and (i+1,j),(i,j+1),(i+1,j+1)
        index[o++] = a
        index[o++] = b
        index[o++] = cc
        index[o++] = cc
        index[o++] = b
        index[o++] = d
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geo.setIndex(new THREE.BufferAttribute(index, 1))
    geo.computeVertexNormals()
    geo.computeBoundingSphere()

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.95,
      metalness: 0
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.receiveShadow = true
    mesh.name = 'terrain'
    return mesh
  }

  /** Heights as a half-float texture so the liquid shader can find shorelines. */
  heightTexture(): THREE.DataTexture {
    const n = this.res + 1
    const data = new Uint16Array(n * n)
    for (let k = 0; k < n * n; k++) data[k] = THREE.DataUtils.toHalfFloat(this.heights[k])
    const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType)
    tex.magFilter = THREE.LinearFilter
    tex.minFilter = THREE.LinearFilter
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    tex.needsUpdate = true
    return tex
  }
}
