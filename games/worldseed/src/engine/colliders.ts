/** Vertical cylinders on a spatial hash: enough for trunks, columns, rocks and walls. */
export interface Cylinder {
  x: number
  z: number
  r: number
  /** Collides only while the mover's feet are below this height. */
  top: number
}

const CELL = 16

export class Colliders {
  private cells = new Map<number, Cylinder[]>()
  count = 0

  private key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096)
  }

  add(x: number, z: number, r: number, top: number): void {
    const c: Cylinder = { x, z, r, top }
    const i0 = Math.floor((x - r) / CELL)
    const i1 = Math.floor((x + r) / CELL)
    const j0 = Math.floor((z - r) / CELL)
    const j1 = Math.floor((z + r) / CELL)
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j)
        let list = this.cells.get(k)
        if (!list) this.cells.set(k, (list = []))
        list.push(c)
      }
    }
    this.count++
  }

  /** Push a circle of radius `radius` at (pos.x, pos.z) out of every cylinder it overlaps. */
  resolve(pos: { x: number; y: number; z: number }, radius: number): boolean {
    const list = this.cells.get(this.key(Math.floor(pos.x / CELL), Math.floor(pos.z / CELL)))
    if (!list) return false
    let hit = false
    for (const c of list) {
      if (pos.y > c.top - 0.2) continue
      const dx = pos.x - c.x
      const dz = pos.z - c.z
      const min = c.r + radius
      const d2 = dx * dx + dz * dz
      if (d2 >= min * min) continue
      const d = Math.sqrt(d2) || 1e-4
      const push = min - d
      pos.x += (dx / d) * push
      pos.z += (dz / d) * push
      hit = true
    }
    return hit
  }

  /** True if the 3D point is inside any cylinder (with `pad` of clearance). */
  contains(x: number, y: number, z: number, pad = 0): boolean {
    const list = this.cells.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)))
    if (!list) return false
    for (const c of list) {
      if (y > c.top + pad) continue
      const dx = x - c.x
      const dz = z - c.z
      const r = c.r + pad
      if (dx * dx + dz * dz < r * r) return true
    }
    return false
  }

  /** True if a cylinder blocks the point (used to keep scatter off structures). */
  occupied(x: number, z: number, pad = 0): boolean {
    const list = this.cells.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)))
    return !!list?.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + pad)
  }
}
