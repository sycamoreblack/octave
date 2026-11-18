import * as THREE from 'three'
import { Rng } from '../engine/rng'
import { Colliders } from '../engine/colliders'
import { animateFigure, buildFigure, type Figure } from './character'
import { Terrain } from './terrain'
import type { WandererStory } from './spec'

const CLOAKS = ['#3f5f7a', '#6a4f7f', '#4e6b4a', '#7a6a4a', '#5a5a66', '#7a3f4f']

/** A wanderer who ambles around a home point and turns to face the player when near. */
export class Wanderer {
  readonly figure: Figure
  readonly position = new THREE.Vector3()
  private target = new THREE.Vector3()
  private facing = 0
  private wait = 0
  private stride = 0
  private speed = 0
  /** Index of the next line to say. */
  lineIndex = 0
  met = false

  constructor(
    readonly story: WandererStory,
    readonly index: number,
    private home: THREE.Vector3,
    private terrain: Terrain,
    private colliders: Colliders,
    private rng: Rng
  ) {
    this.figure = buildFigure({
      cloak: CLOAKS[(index * 2 + rng.int(0, 5)) % CLOAKS.length],
      trim: '#2e2a28',
      skin: rng.pick(['#e7c3a0', '#c8946a', '#8d5a3b', '#f0d2b8']),
      scarf: rng.pick(['#d9b44a', '#c9dfe8', '#e6a1a1', '#a1e6c0']),
      lamp: '#bfe3ff',
      hat: (['wide', 'pointed', 'hood'] as const)[index % 3]
    })
    this.figure.root.scale.setScalar(rng.range(0.92, 1.05))
    this.position.copy(home)
    this.position.y = terrain.surfaceAt(home.x, home.z)
    this.target.copy(this.position)
    this.figure.root.position.copy(this.position)
    this.figure.root.name = `wanderer-${story.name}`
  }

  update(t: number, dt: number, player: THREE.Vector3): void {
    const toPlayer = Math.hypot(player.x - this.position.x, player.z - this.position.z)
    let desiredSpeed = 0
    let face = this.facing
    if (toPlayer < 7) {
      face = Math.atan2(player.x - this.position.x, player.z - this.position.z)
    } else {
      const dx = this.target.x - this.position.x
      const dz = this.target.z - this.position.z
      const d = Math.hypot(dx, dz)
      if (d < 0.8) {
        this.wait -= dt
        if (this.wait <= 0) {
          const a = this.rng.range(0, Math.PI * 2)
          const r = this.rng.range(3, 18)
          const tx = this.home.x + Math.cos(a) * r
          const tz = this.home.z + Math.sin(a) * r
          if (this.terrain.isDry(tx, tz, 0.6) || this.terrain.solidLiquid)
            this.target.set(tx, 0, tz)
          this.wait = this.rng.range(2, 6)
        }
      } else {
        desiredSpeed = 1.8
        face = Math.atan2(dx, dz)
      }
    }
    this.speed += (desiredSpeed - this.speed) * (1 - Math.exp(-dt * 4))
    let d = face - this.facing
    d = Math.atan2(Math.sin(d), Math.cos(d))
    this.facing += d * (1 - Math.exp(-dt * 5))
    const step = this.speed * dt
    this.position.x += Math.sin(this.facing) * step
    this.position.z += Math.cos(this.facing) * step
    this.colliders.resolve(this.position, 0.4)
    this.position.y = this.terrain.surfaceAt(this.position.x, this.position.z)
    this.stride += step
    this.figure.root.position.copy(this.position)
    this.figure.root.rotation.y = this.facing
    animateFigure(this.figure, t + this.index * 3, this.speed * 2.5, this.stride, {
      grounded: true,
      swimming: false,
      gliding: false
    })
  }
}
