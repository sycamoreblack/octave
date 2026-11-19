import * as THREE from 'three'
import { Input } from '../engine/input'
import { clamp } from '../engine/noise'
import { Terrain } from '../world/terrain'
import { Colliders } from '../engine/colliders'

export interface CameraSettings {
  sensitivity: number
  invertY: boolean
  /** Swing behind the player after a moment of no look input. */
  autoFollow: boolean
}

/** Orbiting third-person camera with terrain avoidance, zoom, and gentle auto-follow. */
export class FollowCamera {
  yaw = 0
  pitch = 0.28
  distance = 8
  private targetDistance = 8
  private idle = 0
  private readonly target = new THREE.Vector3()
  private readonly desired = new THREE.Vector3()
  private initialized = false
  /** Photo mode: zoom further out, look from further below/above, no auto-follow. */
  free = false

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private terrain: Terrain,
    private colliders: Colliders,
    public settings: CameraSettings
  ) {}

  snap(yaw: number): void {
    this.yaw = yaw
    this.initialized = false
  }

  update(
    dt: number,
    input: Input,
    focus: THREE.Vector3,
    playerFacing: number,
    playerSpeed: number
  ): void {
    const s = 0.0025 * this.settings.sensitivity
    const lx = input.lookX
    const ly = input.lookY * (this.settings.invertY ? -1 : 1)
    this.yaw -= lx * s
    const maxD = this.free ? 60 : 18
    const minD = this.free ? 2 : 3.5
    this.pitch = clamp(this.pitch + ly * s, this.free ? -0.9 : -0.45, this.free ? 1.45 : 1.25)
    if (input.wheel)
      this.targetDistance = clamp(
        this.targetDistance + input.wheel * (this.free ? 2.5 : 1.2),
        minD,
        maxD
      )
    if (input.isDown('Equal', 'NumpadAdd'))
      this.targetDistance = clamp(this.targetDistance - dt * 8, minD, maxD)
    if (input.isDown('Minus', 'NumpadSubtract'))
      this.targetDistance = clamp(this.targetDistance + dt * 8, minD, maxD)
    if (!this.free && this.targetDistance > 18) this.targetDistance = 18
    if (Math.abs(lx) + Math.abs(ly) > 0) this.idle = 0
    else this.idle += dt

    // After a moment without mouse input, swing gently behind a moving player.
    if (this.settings.autoFollow && !this.free && this.idle > 1.5 && playerSpeed > 2) {
      let d = playerFacing - this.yaw
      d = Math.atan2(Math.sin(d), Math.cos(d))
      this.yaw += d * (1 - Math.exp(-dt * 0.8))
    }

    this.distance += (this.targetDistance - this.distance) * (1 - Math.exp(-dt * 6))
    this.target.set(focus.x, focus.y + 1.7, focus.z)
    const cp = Math.cos(this.pitch)
    this.desired.set(
      this.target.x - Math.sin(this.yaw) * cp * this.distance,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z - Math.cos(this.yaw) * cp * this.distance
    )
    // Pull in if a hill sits between the player and the camera.
    for (let i = 1; i <= 6; i++) {
      const f = i / 6
      const px = this.target.x + (this.desired.x - this.target.x) * f
      const pz = this.target.z + (this.desired.z - this.target.z) * f
      const py = this.target.y + (this.desired.y - this.target.y) * f
      const ground = this.terrain.surfaceAt(px, pz) + 0.6
      if (py < ground) {
        this.desired.y += ground - py
      }
    }
    // Don't let rocks, trunks or walls come between the camera and the player.
    for (let i = 2; i <= 14; i++) {
      const f = i / 14
      const px = this.target.x + (this.desired.x - this.target.x) * f
      const py = this.target.y + (this.desired.y - this.target.y) * f
      const pz = this.target.z + (this.desired.z - this.target.z) * f
      if (this.colliders.contains(px, py, pz, 0.35)) {
        const back = Math.max(0, (i - 1) / 14)
        this.desired.set(
          this.target.x + (this.desired.x - this.target.x) * back,
          this.target.y + (this.desired.y - this.target.y) * back,
          this.target.z + (this.desired.z - this.target.z) * back
        )
        break
      }
    }
    const floor =
      Math.max(this.terrain.surfaceAt(this.desired.x, this.desired.z), this.terrain.liquidY) + 0.7
    this.desired.y = Math.max(this.desired.y, floor)

    if (!this.initialized) {
      this.camera.position.copy(this.desired)
      this.initialized = true
    } else {
      this.camera.position.lerp(this.desired, 1 - Math.exp(-dt * 12))
    }
    this.camera.lookAt(this.target)
  }
}
