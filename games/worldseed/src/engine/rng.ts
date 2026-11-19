/** FNV-1a 32-bit string hash. Stable across platforms, used to turn prompts into seeds. */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Small, fast, seedable PRNG (mulberry32). */
export class Rng {
  private state: number
  readonly seed: number

  constructor(seed: number) {
    this.seed = seed >>> 0
    this.state = this.seed || 0x9e3779b9
  }

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next()
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }

  chance(p: number): boolean {
    return this.next() < p
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length) % items.length]
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      ;[items[i], items[j]] = [items[j], items[i]]
    }
    return items
  }

  /**
   * An independent stream keyed by label. Forks don't depend on how many numbers
   * the parent has drawn, so adding a feature never reshuffles another one.
   */
  fork(label: string): Rng {
    return new Rng(hashString(label) ^ Math.imul(this.seed, 2654435761))
  }
}
