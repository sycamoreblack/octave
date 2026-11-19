import * as THREE from 'three'
import { Input } from '../engine/input'
import { Colliders } from '../engine/colliders'
import { clamp } from '../engine/noise'
import { HALF, Terrain } from '../world/terrain'
import { animateFigure, buildFigure, type Figure } from '../world/character'

const WALK = 7
const RUN = 13
const SWIM = 4.5
const GLIDE = 12
const GRAVITY = 30
const JUMP = 10.5
const COYOTE = 0.13
const JUMP_BUFFER = 0.14
/** Depth at which the player starts swimming instead of wading. */
const SWIM_DEPTH = 1.2
const RADIUS = 0.45
/** Highest ledge (stair, dais) the player walks up without jumping. */
const STEP = 0.95

export interface PlayerState {
  grounded: boolean
  swimming: boolean
  gliding: boolean
}

/** Third-person character controller over the heightfield. */
export class Player {
  readonly figure: Figure
  readonly position = new THREE.Vector3()
  readonly velocity = new THREE.Vector3()
  /** The way the figure faces (radians, +z at 0). */
  facing = 0
  state: PlayerState = { grounded: true, swimming: false, gliding: false }
  /** Metres walked, for animation and stats. */
  stride = 0
  distance = 0
  private sinceGrounded = 0
  private sinceJumpPressed = 99
  private lampLight: THREE.PointLight
  /** Fires on footfalls (for audio), with the surface underfoot. */
  onStep?: (surface: 'ground' | 'water') => void
  onJump?: () => void
  onSplash?: () => void
  private lastStepPhase = 0

  constructor(
    private terrain: Terrain,
    private colliders: Colliders,
    night: boolean,
    lampColor: string
  ) {
    this.figure = buildFigure({
      cloak: '#a8432f',
      trim: '#3b2d27',
      skin: '#e7c3a0',
      scarf: lampColor,
      lamp: '#ffd27a',
      hat: 'hood'
    })
    this.lampLight = new THREE.PointLight('#ffcf7a', night ? 18 : 0, 16, 1.6)
    this.lampLight.position.set(0.4, 1.0, 0.2)
    this.figure.root.add(this.lampLight)
    this.figure.root.name = 'player'
  }

  get object(): THREE.Group {
    return this.figure.root
  }

  place(x: number, z: number, facing: number): void {
    this.position.set(x, this.terrain.surfaceAt(x, z), z)
    this.velocity.set(0, 0, 0)
    this.facing = facing
    this.figure.root.position.copy(this.position)
    this.figure.root.rotation.y = facing
  }

  update(dt: number, t: number, input: Input, cameraYaw: number): void {
    const axis = input.axis()
    const running = input.held('run')
    const fwd = new THREE.Vector3(Math.sin(cameraYaw), 0, Math.cos(cameraYaw))
    const right = new THREE.Vector3(-Math.cos(cameraYaw), 0, Math.sin(cameraYaw))
    const wish = fwd.multiplyScalar(axis.y).add(right.multiplyScalar(axis.x))
    const wishLen = Math.min(1, wish.length())
    if (wishLen > 0.01) wish.normalize()

    const ground = this.terrain.groundAt(this.position.x, this.position.z)
    const liquid = this.terrain.liquidY
    const deepWater = !this.terrain.solidLiquid && ground < liquid - SWIM_DEPTH
    const wasSwimming = this.state.swimming
    this.state.swimming = deepWater && this.position.y <= liquid - SWIM_DEPTH + 0.35
    if (this.state.swimming && !wasSwimming) this.onSplash?.()

    const wading =
      !this.terrain.riversDry && this.terrain.rivers.wetAt(this.position.x, this.position.z, ground)
    let speed = this.state.swimming ? SWIM : running ? RUN : WALK
    if (wading && this.state.grounded) speed *= 0.75
    if (this.terrain.spec.liquid === 'lava' && this.position.y <= liquid + 0.05 && ground < liquid)
      speed *= 0.7

    // Jump input with buffer + coyote time, so jumps feel forgiving.
    this.sinceJumpPressed = input.hit('jump') ? 0 : this.sinceJumpPressed + dt
    if (this.state.grounded) this.sinceGrounded = 0
    else this.sinceGrounded += dt
    if (
      this.sinceJumpPressed < JUMP_BUFFER &&
      this.sinceGrounded < COYOTE &&
      !this.state.swimming
    ) {
      this.velocity.y = JUMP
      this.state.grounded = false
      this.sinceGrounded = COYOTE
      this.sinceJumpPressed = 99
      this.onJump?.()
    }

    // Glide: hold jump while falling.
    this.state.gliding =
      !this.state.grounded && !this.state.swimming && this.velocity.y < 0 && input.held('jump')
    if (this.state.gliding) speed = Math.max(speed, GLIDE)

    // Horizontal velocity eases toward the wish; less control in the air.
    const control = this.state.grounded || this.state.swimming ? 12 : this.state.gliding ? 3 : 2.5
    const k = 1 - Math.exp(-control * dt)
    let tx = wish.x * speed * wishLen
    let tz = wish.z * speed * wishLen
    if (this.state.gliding && wishLen < 0.1) {
      // Gliding with no input keeps drifting forward.
      tx = Math.sin(this.facing) * GLIDE * 0.7
      tz = Math.cos(this.facing) * GLIDE * 0.7
    }
    this.velocity.x += (tx - this.velocity.x) * k
    this.velocity.z += (tz - this.velocity.z) * k

    // Vertical.
    if (this.state.swimming) {
      const target = liquid - SWIM_DEPTH + 0.25 + Math.sin(t * 2) * 0.05
      this.velocity.y = (target - this.position.y) * 6
    } else {
      this.velocity.y -= GRAVITY * dt
      if (this.state.gliding) this.velocity.y = Math.max(this.velocity.y, -3.2)
    }

    // Move horizontally, refusing steps up cliffs that are too steep.
    const ox = this.position.x
    const oz = this.position.z
    const oldSurface = this.terrain.terrainSurfaceAt(ox, oz)
    const nx = ox + this.velocity.x * dt
    const nz = oz + this.velocity.z * dt
    const tryMove = (x: number, z: number): boolean => {
      // Built floors: step up anything up to STEP, otherwise it's a wall.
      if (this.terrain.platformAt(x, z) > this.position.y + STEP) return false
      // Natural slopes: refuse cliffs while walking, by gradient.
      const s = this.terrain.terrainSurfaceAt(x, z)
      const rise = s - Math.max(oldSurface, this.position.y)
      const run = Math.hypot(x - ox, z - oz) || 1e-4
      return (
        !(this.state.grounded && rise / run > 1.6 && rise > 0.15) && !(this.position.y < s - 1.2)
      )
    }
    if (tryMove(nx, nz)) {
      this.position.x = nx
      this.position.z = nz
    } else if (tryMove(nx, oz)) {
      this.position.x = nx
      this.velocity.z *= 0.5
    } else if (tryMove(ox, nz)) {
      this.position.z = nz
      this.velocity.x *= 0.5
    } else {
      this.velocity.x *= 0.2
      this.velocity.z *= 0.2
    }

    this.colliders.resolve(this.position, RADIUS)

    // Keep inside the world with a gentle push back from the edge.
    const r = Math.hypot(this.position.x, this.position.z)
    const limit = HALF * 0.97
    if (r > limit) {
      this.position.x *= limit / r
      this.position.z *= limit / r
    }

    this.position.y += this.velocity.y * dt
    const surface = this.terrain.surfaceAt(this.position.x, this.position.z)
    const wasGrounded = this.state.grounded
    if (this.position.y <= surface) {
      this.position.y = surface
      if (this.velocity.y < 0) this.velocity.y = 0
      this.state.grounded = true
    } else if (wasGrounded && this.velocity.y <= 0 && this.position.y - surface < 1.0) {
      // Stick to the ground walking downhill instead of skipping off every facet.
      this.position.y = surface
      this.velocity.y = 0
      this.state.grounded = true
    } else {
      this.state.grounded = false
    }
    if (this.state.swimming) this.state.grounded = false

    // Face the direction of travel.
    const hs = Math.hypot(this.velocity.x, this.velocity.z)
    if (hs > 0.5) {
      const targetYaw = Math.atan2(this.velocity.x, this.velocity.z)
      let d = targetYaw - this.facing
      d = Math.atan2(Math.sin(d), Math.cos(d))
      this.facing += d * (1 - Math.exp(-dt * 12))
    }

    const moved = Math.hypot(this.position.x - ox, this.position.z - oz)
    this.distance += moved
    this.stride +=
      this.state.grounded || this.state.swimming ? moved * (this.state.swimming ? 0.5 : 1) : 0
    const stepPhase = Math.floor((this.stride * 1.25) / Math.PI)
    if (stepPhase !== this.lastStepPhase && (this.state.grounded || this.state.swimming)) {
      this.lastStepPhase = stepPhase
      this.onStep?.(
        this.state.swimming || wading || this.position.y < liquid + 0.1 ? 'water' : 'ground'
      )
    }

    const root = this.figure.root
    root.position.copy(this.position)
    root.rotation.y = this.facing
    // Lean slightly into turns and speed.
    root.rotation.z = clamp(
      -(this.velocity.x * Math.cos(this.facing) - this.velocity.z * Math.sin(this.facing)) * 0.004,
      -0.15,
      0.15
    )
    animateFigure(this.figure, t, hs, this.stride, this.state)
  }

  setLamp(on: boolean): void {
    this.lampLight.intensity = on ? 18 : 0
  }
}
