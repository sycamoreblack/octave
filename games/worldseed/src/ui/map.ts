import * as THREE from 'three'
import { HALF, WORLD_SIZE } from '../world/terrain'
import type { World } from '../world/world'

const FOG_RES = 96
const REVEAL = 95

/** A parchment-tinted map with fog of war that clears as you walk. */
export class WorldMap {
  private base: HTMLCanvasElement
  private fog: HTMLCanvasElement
  readonly explored = new Uint8Array(FOG_RES * FOG_RES)

  constructor(private world: World) {
    this.base = document.createElement('canvas')
    this.base.width = this.base.height = 384
    this.fog = document.createElement('canvas')
    this.fog.width = this.fog.height = FOG_RES
    this.paintBase()
  }

  private paintBase(): void {
    const { terrain, spec } = this.world
    const size = this.base.width
    const ctx = this.base.getContext('2d')!
    const img = ctx.createImageData(size, size)
    const water = new THREE.Color(spec.palette.liquid)
    const paper = new THREE.Color('#e9dcc0')
    const c = new THREE.Color()
    const low = new THREE.Color(spec.palette.groundLow)
    const mid = new THREE.Color(spec.palette.groundMid)
    const high = new THREE.Color(spec.palette.groundHigh)
    const span = Math.max(1, terrain.maxHeight - terrain.liquidY)
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const x = -HALF + ((i + 0.5) / size) * WORLD_SIZE
        const z = -HALF + ((j + 0.5) / size) * WORLD_SIZE
        const h = terrain.groundAt(x, z)
        const rel = h - terrain.liquidY
        if (
          (rel < 0 && !terrain.solidLiquid) ||
          (!terrain.riversDry && terrain.rivers.wetAt(x, z, h))
        ) {
          c.copy(water).multiplyScalar(1 - Math.min(0.5, -rel / 40))
        } else {
          const f = Math.max(0, rel) / span
          c.copy(rel < 1.5 ? low : mid).lerp(high, Math.min(1, f * 1.4))
          if (rel < 0) c.lerp(water, 0.35)
          // Hillshade from the north-west.
          const e = 6
          const dx = terrain.groundAt(x + e, z) - terrain.groundAt(x - e, z)
          const dz = terrain.groundAt(x, z + e) - terrain.groundAt(x, z - e)
          const shade = Math.max(0.55, Math.min(1.35, 1 - (dx + dz) * 0.05))
          c.multiplyScalar(shade)
          // Contour lines every so often.
          const band = (h / (span / 8)) % 1
          if (band < 0.06 && rel > 2) c.multiplyScalar(0.82)
        }
        c.lerp(paper, 0.28)
        c.convertLinearToSRGB()
        const k = (j * size + i) * 4
        img.data[k] = Math.min(255, c.r * 255)
        img.data[k + 1] = Math.min(255, c.g * 255)
        img.data[k + 2] = Math.min(255, c.b * 255)
        img.data[k + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }

  reveal(x: number, z: number, radius = REVEAL): boolean {
    const cell = WORLD_SIZE / FOG_RES
    const ci = Math.floor((x + HALF) / cell)
    const cj = Math.floor((z + HALF) / cell)
    const r = Math.ceil(radius / cell)
    let changed = false
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || j < 0 || i >= FOG_RES || j >= FOG_RES) continue
        if ((i - ci) ** 2 + (j - cj) ** 2 > r * r) continue
        const k = j * FOG_RES + i
        if (!this.explored[k]) {
          this.explored[k] = 1
          changed = true
        }
      }
    }
    return changed
  }

  serialize(): string {
    let bin = ''
    for (let k = 0; k < this.explored.length; k += 8) {
      let byte = 0
      for (let b = 0; b < 8; b++) byte |= (this.explored[k + b] ? 1 : 0) << b
      bin += String.fromCharCode(byte)
    }
    return btoa(bin)
  }

  restore(s: string): void {
    if (!s) return
    try {
      const bin = atob(s)
      for (let k = 0; k < this.explored.length; k++)
        this.explored[k] = (bin.charCodeAt(k >> 3) >> (k & 7)) & 1
    } catch {
      /* corrupt: start unexplored */
    }
  }

  get exploredFraction(): number {
    let n = 0
    let land = 0
    for (let k = 0; k < this.explored.length; k++) {
      const i = k % FOG_RES
      const j = Math.floor(k / FOG_RES)
      const x = -HALF + ((i + 0.5) / FOG_RES) * WORLD_SIZE
      const z = -HALF + ((j + 0.5) / FOG_RES) * WORLD_SIZE
      if (this.world.terrain.groundAt(x, z) > this.world.terrain.liquidY) {
        land++
        n += this.explored[k]
      }
    }
    return land ? n / land : 0
  }

  draw(
    canvas: HTMLCanvasElement,
    player: THREE.Vector3,
    facing: number,
    metWanderers: number[],
    /** Extra pins, e.g. lost things you've been asked to find. */
    pins: { x: number; z: number; label: string }[] = []
  ): void {
    const ctx = canvas.getContext('2d')!
    const W = canvas.width
    const toPx = (v: number): number => ((v + HALF) / WORLD_SIZE) * W
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(this.base, 0, 0, W, W)

    // Fog of war.
    const fctx = this.fog.getContext('2d')!
    const fimg = fctx.createImageData(FOG_RES, FOG_RES)
    for (let k = 0; k < this.explored.length; k++) {
      fimg.data[k * 4] = 34
      fimg.data[k * 4 + 1] = 30
      fimg.data[k * 4 + 2] = 28
      fimg.data[k * 4 + 3] = this.explored[k] ? 0 : 235
    }
    fctx.putImageData(fimg, 0, 0)
    ctx.save()
    ctx.filter = 'blur(10px)'
    ctx.drawImage(this.fog, 0, 0, W, W)
    ctx.restore()

    const accent = this.world.spec.palette.accent
    ctx.font = '600 15px "Cormorant Garamond", Georgia, serif'
    ctx.textAlign = 'center'
    ctx.lineWidth = 3
    const label = (text: string, x: number, y: number): void => {
      ctx.strokeStyle = 'rgba(20,16,12,0.8)'
      ctx.fillStyle = '#f6efe2'
      ctx.strokeText(text, x, y)
      ctx.fillText(text, x, y)
    }

    for (const p of this.world.places) {
      if (!p.discovered || p.kind !== 'minor') continue
      const x = toPx(p.at.x)
      const y = toPx(p.at.z)
      ctx.fillStyle = '#f6efe2'
      ctx.beginPath()
      ctx.arc(x, y, 3.5, 0, Math.PI * 2)
      ctx.fill()
      label(p.name, x, y - 9)
    }

    for (const s of this.world.shards) {
      const x = toPx(s.at.x)
      const y = toPx(s.at.z)
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = s.collected ? 'rgba(255,255,255,0.25)' : accent
      ctx.strokeStyle = '#1b1408'
      ctx.lineWidth = 1.5
      ctx.fillRect(-7, -7, 14, 14)
      ctx.strokeRect(-7, -7, 14, 14)
      ctx.restore()
      // World pushes one place per shard first, in shard order.
      const place = this.world.places[s.index]
      if (place?.discovered) label(place.name, x, y - 14)
    }

    const h = this.world.heart.center
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(toPx(h.x), toPx(h.z), 9, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(toPx(h.x), toPx(h.z), 3, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    label(this.world.spec.story.finale.place, toPx(h.x), toPx(h.z) - 16)

    for (const pin of pins) {
      const x = toPx(pin.x)
      const y = toPx(pin.z)
      ctx.fillStyle = '#ffe7b0'
      ctx.strokeStyle = '#1b1408'
      ctx.lineWidth = 1.5
      ctx.fillRect(x - 5, y - 5, 10, 10)
      ctx.strokeRect(x - 5, y - 5, 10, 10)
      label(pin.label, x, y - 10)
    }

    for (const i of metWanderers) {
      const w = this.world.wanderers[i]
      if (!w) continue
      ctx.fillStyle = '#bfe3ff'
      ctx.beginPath()
      ctx.arc(toPx(w.position.x), toPx(w.position.z), 4, 0, Math.PI * 2)
      ctx.fill()
      label(w.story.name, toPx(w.position.x), toPx(w.position.z) + 18)
    }

    // The player: an arrow pointing the way they face (+z is down on the map).
    ctx.save()
    ctx.translate(toPx(player.x), toPx(player.z))
    ctx.rotate(Math.PI - facing)
    ctx.fillStyle = '#ff6a4a'
    ctx.strokeStyle = '#1b1408'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, -12)
    ctx.lineTo(8, 9)
    ctx.lineTo(0, 4)
    ctx.lineTo(-8, 9)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.restore()

    // Compass rose.
    ctx.fillStyle = 'rgba(20,16,12,0.7)'
    ctx.font = '600 16px Inter, sans-serif'
    label('N', W - 28, 34)
  }
}
