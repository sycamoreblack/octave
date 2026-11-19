import { Rng } from '../engine/rng'
import { clamp, smoothstep } from '../engine/noise'

/**
 * Rivers: each starts on high ground and walks downhill (with a little momentum and meander)
 * until it reaches the sea. Its water surface never rises along the way, so the carved bed
 * always flows. Segments sit in a spatial hash for fast "how close is the nearest river?"
 * queries, which are used for carving, planting, placing landmarks and drawing the map.
 */

export interface RiverPoint {
  x: number
  z: number
  /** Water surface height here. */
  surface: number
  /** Half-width of the water here. */
  width: number
  /** Distance travelled from the source. */
  along: number
}

export interface RiverHit {
  /** Horizontal distance to the river's centre line. */
  d: number
  surface: number
  width: number
}

const CELL = 32
const STEP = 6
const BED = 0.85

export class RiverNet {
  readonly rivers: RiverPoint[][] = []
  private cells = new Map<number, [number, number][]>()
  private maxWidth = 0

  constructor(
    count: number,
    height: (x: number, z: number) => number,
    seaLevel: number,
    landRadius: number,
    rng: Rng
  ) {
    const sources: { x: number; z: number }[] = []
    for (let k = 0; k < count; k++) {
      // Source: the highest of a handful of candidates, away from other sources.
      let best: { x: number; z: number; h: number } | null = null
      for (let i = 0; i < 70; i++) {
        const a = rng.range(0, Math.PI * 2)
        const d = rng.range(0.15, 0.7) * landRadius
        const x = Math.cos(a) * d
        const z = Math.sin(a) * d
        if (sources.some((s) => Math.hypot(s.x - x, s.z - z) < landRadius * 0.45)) continue
        const h = height(x, z)
        if (h > seaLevel + 8 && (!best || h > best.h)) best = { x, z, h }
      }
      if (!best) continue
      const river = this.trace(best.x, best.z, height, seaLevel, landRadius, rng)
      if (river.length >= 15) {
        sources.push(best)
        this.rivers.push(river)
      }
    }
    this.index()
  }

  private trace(
    sx: number,
    sz: number,
    height: (x: number, z: number) => number,
    seaLevel: number,
    landRadius: number,
    rng: Rng
  ): RiverPoint[] {
    const pts: RiverPoint[] = []
    let x = sx
    let z = sz
    let dx = 0
    let dz = 0
    let surface = height(x, z)
    const wiggle = rng.range(0, 100)
    for (let step = 0; step < 420; step++) {
      const h = height(x, z)
      surface = Math.min(surface, h + 0.2)
      const f = step / 160
      pts.push({ x, z, surface, width: 2.2 + clamp(f, 0, 1) * 5.5, along: step * STEP })
      if (surface < seaLevel - 0.6) break
      if (Math.hypot(x, z) > landRadius * 1.15) break
      const e = 8
      let gx = height(x + e, z) - height(x - e, z)
      let gz = height(x, z + e) - height(x, z - e)
      const g = Math.hypot(gx, gz)
      const r = Math.hypot(x, z) || 1
      const ox = x / r
      const oz = z / r
      if (g < 0.02) {
        gx = ox
        gz = oz
      } else {
        gx /= -g
        gz /= -g
      }
      // Rivers always find the sea: a pull toward the coast that grows as the river ages,
      // and a strong one whenever it starts circling back on itself.
      const circling = pts.some(
        (q, k) => k < pts.length - 10 && Math.hypot(q.x - x, q.z - z) < STEP * 2.5
      )
      const pull = circling ? 0.85 : 0.18 + clamp((step - 50) / 160, 0, 0.55)
      gx = gx * (1 - pull) + ox * pull
      gz = gz * (1 - pull) + oz * pull
      // Momentum smooths zigzags; a slow meander keeps it from looking ruled.
      const m = Math.sin(step * 0.13 + wiggle) * 0.35
      const ndx = gx * Math.cos(m) - gz * Math.sin(m)
      const ndz = gx * Math.sin(m) + gz * Math.cos(m)
      dx = dx * 0.65 + ndx * 0.35
      dz = dz * 0.65 + ndz * 0.35
      const len = Math.hypot(dx, dz) || 1
      x += (dx / len) * STEP
      z += (dz / len) * STEP
    }
    return pts
  }

  private key(i: number, j: number): number {
    return (i + 512) * 1024 + (j + 512)
  }

  private index(): void {
    this.rivers.forEach((pts, r) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]
        const b = pts[i + 1]
        const pad = Math.max(a.width, b.width) * 2.2
        this.maxWidth = Math.max(this.maxWidth, a.width, b.width)
        const i0 = Math.floor((Math.min(a.x, b.x) - pad) / CELL)
        const i1 = Math.floor((Math.max(a.x, b.x) + pad) / CELL)
        const j0 = Math.floor((Math.min(a.z, b.z) - pad) / CELL)
        const j1 = Math.floor((Math.max(a.z, b.z) + pad) / CELL)
        for (let ci = i0; ci <= i1; ci++)
          for (let cj = j0; cj <= j1; cj++) {
            const k = this.key(ci, cj)
            let list = this.cells.get(k)
            if (!list) this.cells.set(k, (list = []))
            list.push([r, i])
          }
      }
    })
  }

  /** The nearest river to (x, z), if any segment is within reach. */
  nearest(x: number, z: number): RiverHit | null {
    const list = this.cells.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)))
    if (!list) return null
    let best: RiverHit | null = null
    for (const [r, i] of list) {
      const a = this.rivers[r][i]
      const b = this.rivers[r][i + 1]
      const ex = b.x - a.x
      const ez = b.z - a.z
      const len2 = ex * ex + ez * ez || 1
      const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / len2, 0, 1)
      const px = a.x + ex * t
      const pz = a.z + ez * t
      const d = Math.hypot(x - px, z - pz)
      if (!best || d < best.d)
        best = {
          d,
          surface: a.surface + (b.surface - a.surface) * t,
          width: a.width + (b.width - a.width) * t
        }
    }
    return best
  }

  /** Carve a natural height down into a river bed near any river. */
  carve(x: number, z: number, h: number): number {
    const hit = this.nearest(x, z)
    if (!hit) return h
    const w = hit.width
    const influence = 1 - smoothstep(w * 0.7, w * 2.1, hit.d)
    if (influence <= 0) return h
    // A rounded bed, deepest in the middle, rising to the banks.
    const across = clamp(hit.d / w, 0, 1)
    const bed = hit.surface - 0.25 - BED * (1 - across * across)
    return h + (Math.min(h, bed) - h) * influence
  }

  /** True where there's river water over the bed (for footsteps and the map). */
  wetAt(x: number, z: number, ground: number): boolean {
    const hit = this.nearest(x, z)
    return !!hit && hit.d < hit.width && ground < hit.surface - 0.1
  }

  /** True near a river's banks (keeps trees and landmarks out of the water). */
  near(x: number, z: number, factor = 1.4): boolean {
    const hit = this.nearest(x, z)
    return !!hit && hit.d < hit.width * factor
  }
}
