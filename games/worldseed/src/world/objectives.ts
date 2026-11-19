import * as THREE from 'three'
import { Rng } from '../engine/rng'
import { Colliders } from '../engine/colliders'
import { jitter, merge, part, xf } from '../engine/geo'
import { LAND_RADIUS, Terrain } from './terrain'
import type { WorldSpec } from './spec'

/**
 * The small things you do between the pillars of light: waystones that unseal a shard,
 * things the wanderers lost, and echoes of memory drifting over the land.
 */

const glow = (color: THREE.ColorRepresentation, opacity: number): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })

/** Ease a value toward a target, frame-rate independent. */
const approach = (v: number, target: number, rate: number, dt: number): number =>
  v + (target - v) * (1 - Math.exp(-rate * dt))

// ---------------------------------------------------------------- waystones

export class Waystone {
  readonly group = new THREE.Group()
  readonly at: THREE.Vector3
  awake = false
  private rune: THREE.MeshStandardMaterial
  private halo: THREE.Mesh
  private level = 0

  constructor(
    spec: WorldSpec,
    position: THREE.Vector3,
    facing: number,
    colliders: Colliders,
    seed: number
  ) {
    this.at = position.clone()
    const stone = new THREE.Color(spec.palette.stone).multiplyScalar(0.8)
    const body = merge([
      part(
        jitter(new THREE.BoxGeometry(0.9, 2.4, 0.6, 1, 3, 1), 0.07, seed),
        stone,
        xf(0, 1.1, 0, 0.04, 0, 0.03)
      ),
      part(
        jitter(new THREE.DodecahedronGeometry(0.55, 0), 0.15, seed + 1),
        stone.clone().multiplyScalar(0.8),
        xf(0.35, 0.1, 0.25)
      ),
      part(
        jitter(new THREE.DodecahedronGeometry(0.4, 0), 0.15, seed + 2),
        stone.clone().multiplyScalar(0.7),
        xf(-0.4, 0.05, -0.2)
      )
    ])
    const mesh = new THREE.Mesh(
      body,
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 })
    )
    mesh.castShadow = mesh.receiveShadow = true
    this.group.add(mesh)

    this.rune = new THREE.MeshStandardMaterial({
      color: '#202024',
      emissive: new THREE.Color(spec.palette.accent),
      emissiveIntensity: 0.2,
      roughness: 0.5
    })
    for (const [y, w] of [
      [1.75, 0.34],
      [1.35, 0.18],
      [0.95, 0.28]
    ]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, 0.04), this.rune)
      r.position.set(0, y, 0.31)
      this.group.add(r)
    }
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.04), this.rune)
    v.position.set(0, 1.35, 0.31)
    this.group.add(v)

    this.halo = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.6, 28), glow(spec.palette.accent, 0))
    this.halo.rotation.x = -Math.PI / 2
    this.halo.position.y = 0.06
    this.group.add(this.halo)

    this.group.position.copy(position)
    this.group.rotation.y = facing
    this.group.name = 'waystone'
    colliders.add(position.x, position.z, 0.7, position.y + 2.4)
  }

  wake(instant = false): void {
    this.awake = true
    if (instant) this.level = 1
  }

  update(t: number, dt: number): void {
    this.level = approach(this.level, this.awake ? 1 : 0, 3, dt)
    // Asleep, the runes breathe faintly so the stones can still be found at night.
    const idle = 0.18 + 0.12 * Math.sin(t * 1.7 + this.at.x)
    this.rune.emissiveIntensity = idle * (1 - this.level) + 2.2 * this.level
    ;(this.halo.material as THREE.MeshBasicMaterial).opacity = 0.35 * this.level
    this.halo.scale.setScalar(1 + 0.08 * Math.sin(t * 2))
  }
}

// ---------------------------------------------------------------- seal

const sealVert = /* glsl */ `
varying vec3 vN;
varying vec3 vView;
varying vec3 vPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vView = normalize(cameraPosition - wp.xyz);
  vPos = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`
const sealFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uStrength;
varying vec3 vN;
varying vec3 vView;
varying vec3 vPos;
void main() {
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 2.0);
  float bands = 0.5 + 0.5 * sin(vPos.y * 9.0 - uTime * 2.0 + sin(atan(vPos.z, vPos.x) * 6.0) * 0.6);
  float a = (fres * 0.85 + bands * 0.12) * uStrength;
  gl_FragColor = vec4(uColor * (0.8 + fres), a);
}`

/** A shimmering shell around a sealed shard. */
export class Seal {
  readonly mesh: THREE.Mesh
  private uniforms: Record<string, THREE.IUniform>
  private strength = 1
  private broken = false

  constructor(color: string, center: THREE.Vector3) {
    this.uniforms = {
      uColor: { value: new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.25) },
      uTime: { value: 0 },
      uStrength: { value: 1 }
    }
    this.mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.9, 2),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: sealVert,
        fragmentShader: sealFrag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
      })
    )
    this.mesh.position.copy(center)
    this.mesh.name = 'seal'
  }

  get sealed(): boolean {
    return !this.broken
  }

  break(instant = false): void {
    this.broken = true
    if (instant) this.strength = 0
  }

  update(t: number, dt: number): void {
    this.strength = approach(this.strength, this.broken ? 0 : 1, 2.5, dt)
    this.uniforms.uTime.value = t
    this.uniforms.uStrength.value = this.strength
    // Bursts outward as it breaks.
    this.mesh.scale.setScalar(1 + (1 - this.strength) * 0.8)
    this.mesh.rotation.y = t * 0.3
    this.mesh.visible = this.strength > 0.01
  }
}

// ---------------------------------------------------------------- lost things

/** A small bundle left at a minor place, with a sparkle so it can be spotted. */
export class LostItem {
  readonly group = new THREE.Group()
  readonly at: THREE.Vector3
  taken = false
  private sparkle: THREE.Mesh
  private fade = 1

  constructor(position: THREE.Vector3, seed: number) {
    this.at = position.clone()
    const cloth = ['#7a4a3a', '#4a5a7a', '#6a6a3a'][seed % 3]
    const bundle = merge([
      part(new THREE.BoxGeometry(0.5, 0.32, 0.38), cloth, xf(0, 0.16, 0, 0, 0.3, 0)),
      part(new THREE.BoxGeometry(0.54, 0.06, 0.08), '#e8d9b0', xf(0, 0.2, 0, 0, 0.3, 0)),
      part(new THREE.BoxGeometry(0.08, 0.34, 0.42), '#e8d9b0', xf(0, 0.17, 0, 0, 0.3, 0))
    ])
    const mesh = new THREE.Mesh(
      bundle,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 0.8,
        emissive: '#3a2a10',
        emissiveIntensity: 0.4
      })
    )
    mesh.castShadow = true
    this.group.add(mesh)
    this.sparkle = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), glow('#ffe7b0', 0.9))
    this.sparkle.position.y = 0.9
    this.group.add(this.sparkle)
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.75, 20), glow('#ffe7b0', 0.25))
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.04
    this.group.add(ring)
    this.group.position.copy(position)
    this.group.name = 'lost-item'
  }

  take(instant = false): void {
    this.taken = true
    if (instant) {
      this.fade = 0
      this.group.visible = false
    }
  }

  update(t: number, dt: number): void {
    this.sparkle.position.y = 0.9 + Math.sin(t * 2.2 + this.at.x) * 0.15
    this.sparkle.rotation.y = t * 2
    if (this.taken) {
      this.fade = approach(this.fade, 0, 6, dt)
      this.group.scale.setScalar(Math.max(0.001, this.fade))
      this.group.visible = this.fade > 0.02
    }
  }
}

// ---------------------------------------------------------------- echoes

/** A drifting mote of memory. Walk through it to hear what it remembers. */
export class Echo {
  readonly group = new THREE.Group()
  readonly at: THREE.Vector3
  taken = false
  private core: THREE.Mesh
  private halo: THREE.Mesh
  private burst = 0

  constructor(color: string, position: THREE.Vector3) {
    this.at = position.clone()
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 1), glow('#ffffff', 0.95))
    this.halo = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.75, 1),
      glow(new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.4), 0.22)
    )
    // A faint vertical shimmer sets echoes apart from fireflies and spores at a distance.
    const streakGeo = new THREE.CylinderGeometry(0.02, 0.12, 7, 6, 1, true)
    streakGeo.translate(0, 1.5, 0)
    const streak = new THREE.Mesh(streakGeo, glow('#ffffff', 0.18))
    this.group.add(this.core, this.halo, streak)
    this.group.position.copy(position)
    this.group.name = 'echo'
  }

  take(instant = false): void {
    this.taken = true
    if (instant) this.group.visible = false
  }

  update(t: number, dt: number): void {
    if (!this.group.visible) return
    const bob = Math.sin(t * 1.3 + this.at.z) * 0.35
    this.group.position.set(
      this.at.x + Math.sin(t * 0.4 + this.at.x) * 0.6,
      this.at.y + bob,
      this.at.z + Math.cos(t * 0.37) * 0.6
    )
    this.halo.scale.setScalar(1 + 0.2 * Math.sin(t * 3 + this.at.x))
    if (this.taken) {
      this.burst = Math.min(1, this.burst + dt * 1.8)
      this.group.scale.setScalar(1 + this.burst * 3)
      ;(this.core.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - this.burst)
      ;(this.halo.material as THREE.MeshBasicMaterial).opacity = 0.22 * (1 - this.burst)
      if (this.burst >= 1) this.group.visible = false
    }
  }
}

// ---------------------------------------------------------------- placement

export interface SpotOptions {
  /** Centre and ring to search in. */
  cx: number
  cz: number
  rMin: number
  rMax: number
  /** Keep this far from every point in `avoid`. */
  avoid: { x: number; z: number }[]
  gap: number
  maxSlope?: number
}

/** Best-effort search for a dry, gentle, unobstructed spot. Returns null if none. */
export function findSpot(
  terrain: Terrain,
  colliders: Colliders,
  rng: Rng,
  o: SpotOptions,
  tries = 160
): THREE.Vector3 | null {
  for (let i = 0; i < tries; i++) {
    const a = rng.range(0, Math.PI * 2)
    const d = Math.sqrt(rng.range(o.rMin * o.rMin, o.rMax * o.rMax))
    const x = o.cx + Math.cos(a) * d
    const z = o.cz + Math.sin(a) * d
    if (Math.hypot(x, z) > LAND_RADIUS * 1.02) continue
    if (!terrain.solidLiquid && !terrain.isDry(x, z, 0.8)) continue
    if (terrain.slopeAt(x, z) > (o.maxSlope ?? 0.8)) continue
    if (colliders.occupied(x, z, 1.5)) continue
    if (terrain.platformAt(x, z) > -Infinity) continue
    if (terrain.rivers.near(x, z, 1.3)) continue
    if (o.avoid.some((p) => Math.hypot(p.x - x, p.z - z) < o.gap)) continue
    return new THREE.Vector3(x, terrain.surfaceAt(x, z), z)
  }
  return null
}
