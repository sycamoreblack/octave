import * as THREE from 'three'
import { Rng } from '../engine/rng'
import { Noise2D, clamp } from '../engine/noise'
import { jitter, merge, part, xf } from '../engine/geo'
import { addWind } from '../engine/wind'
import { Colliders } from '../engine/colliders'
import { LAND_RADIUS, Terrain } from './terrain'
import type { Flora, Palette, WorldSpec } from './spec'
import type { Layout } from './layout'

const TRUNK = '#5b4636'
const DARK_TRUNK = '#3b3330'

type Builder = (p: Palette, rng: Rng, spec: WorldSpec) => THREE.BufferGeometry

const shade = (hex: string, f: number): THREE.Color => new THREE.Color(hex).multiplyScalar(f)

const BUILDERS: Record<Flora, Builder> = {
  pine: (p, _r, spec) => {
    const snow = spec.biome === 'tundra' || spec.weather === 'snow'
    const parts = [part(new THREE.CylinderGeometry(0.22, 0.35, 2.4, 6), TRUNK, xf(0, 1.2, 0))]
    const tiers: [number, number, number][] = [
      [2.5, 3.6, 3.0],
      [1.95, 3.0, 4.6],
      [1.35, 2.6, 6.1]
    ]
    tiers.forEach(([r, h, y], i) => {
      parts.push(
        part(
          jitter(new THREE.ConeGeometry(r, h, 7, 1), 0.08, i),
          shade(p.foliage, 0.85 + i * 0.1),
          xf(0, y, 0, 0, i * 0.4)
        )
      )
      if (snow)
        parts.push(
          part(
            new THREE.ConeGeometry(r * 0.55, h * 0.4, 7, 1),
            '#f3f7fb',
            xf(0, y + h * 0.31, 0, 0, i * 0.4)
          )
        )
    })
    return merge(parts)
  },
  broadleaf: (p) =>
    merge([
      part(new THREE.CylinderGeometry(0.25, 0.42, 3.4, 6), TRUNK, xf(0, 1.7, 0)),
      part(new THREE.CylinderGeometry(0.1, 0.16, 1.8, 5), TRUNK, xf(0.5, 3.2, 0, 0, 0, -0.7)),
      part(jitter(new THREE.IcosahedronGeometry(2.3, 0), 0.15, 1), p.foliage, xf(0, 4.6, 0)),
      part(
        jitter(new THREE.IcosahedronGeometry(1.7, 0), 0.15, 2),
        shade(p.foliage, 1.15),
        xf(1.3, 5.2, 0.5)
      ),
      part(
        jitter(new THREE.IcosahedronGeometry(1.5, 0), 0.15, 3),
        p.foliageAlt,
        xf(-1.1, 5.1, -0.7)
      )
    ]),
  palm: (p) => {
    const parts: THREE.BufferGeometry[] = []
    let x = 0
    let y = 0
    for (let i = 0; i < 5; i++) {
      const tilt = 0.08 + i * 0.05
      parts.push(
        part(
          new THREE.CylinderGeometry(0.22 - i * 0.02, 0.28 - i * 0.02, 1.55, 6),
          i % 2 ? TRUNK : '#6e5843',
          xf(x, y + 0.7, 0, 0, 0, -tilt)
        )
      )
      x += Math.sin(tilt) * 1.5
      y += Math.cos(tilt) * 1.5
    }
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2
      parts.push(
        part(
          new THREE.ConeGeometry(0.55, 3.6, 3, 1),
          k % 2 ? p.foliage : p.foliageAlt,
          xf(
            x + Math.cos(a) * 1.5,
            y - 0.3,
            Math.sin(a) * 1.5,
            Math.sin(a) * 1.25,
            0,
            -Math.cos(a) * 1.25,
            1,
            1,
            0.25
          )
        )
      )
    }
    parts.push(part(new THREE.IcosahedronGeometry(0.35, 0), '#5a4030', xf(x, y - 0.2, 0)))
    return merge(parts)
  },
  cactus: (p) => {
    const green = shade(p.foliage, 1.0)
    return merge([
      part(new THREE.CylinderGeometry(0.42, 0.48, 3.8, 8), green, xf(0, 1.9, 0)),
      part(
        new THREE.SphereGeometry(0.42, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
        green,
        xf(0, 3.8, 0)
      ),
      part(
        new THREE.CylinderGeometry(0.26, 0.26, 1.1, 6),
        green,
        xf(0.75, 1.9, 0, 0, 0, Math.PI / 2)
      ),
      part(new THREE.CylinderGeometry(0.26, 0.26, 1.3, 6), green, xf(1.25, 2.55, 0)),
      part(
        new THREE.CylinderGeometry(0.24, 0.24, 0.9, 6),
        green,
        xf(-0.65, 2.4, 0, 0, 0, Math.PI / 2)
      ),
      part(new THREE.CylinderGeometry(0.24, 0.24, 1.0, 6), green, xf(-1.05, 2.95, 0))
    ])
  },
  mushroom: (p, _r, spec) => {
    const cap = spec.biome === 'alien' ? p.foliageAlt : p.accent
    return merge([
      part(new THREE.CylinderGeometry(0.22, 0.32, 1.6, 7), '#efe6d8', xf(0, 0.8, 0)),
      part(
        new THREE.SphereGeometry(1.1, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2),
        cap,
        xf(0, 1.45, 0, 0, 0, 0, 1, 0.6, 1)
      ),
      part(new THREE.CylinderGeometry(1.0, 1.0, 0.08, 9), '#f2e9dc', xf(0, 1.47, 0))
    ])
  },
  crystal: (p) => {
    const parts: THREE.BufferGeometry[] = []
    const shards: [number, number, number, number, number][] = [
      [0, 0, 0, 0, 1],
      [0.5, 0.2, 0.35, -0.4, 0.7],
      [-0.4, -0.3, -0.3, 0.45, 0.6],
      [0.2, 0.5, -0.45, 0.3, 0.5]
    ]
    for (const [x, z, rx, rz, s] of shards) {
      parts.push(
        part(
          new THREE.OctahedronGeometry(0.5, 0),
          x > 0 ? p.accent : p.foliage,
          xf(x, 1.6 * s, z, rx, 0, rz, s, 3.4 * s, s)
        )
      )
    }
    return merge(parts)
  },
  deadtree: () =>
    merge([
      part(
        new THREE.CylinderGeometry(0.18, 0.38, 4.5, 5),
        DARK_TRUNK,
        xf(0, 2.25, 0, 0.05, 0, 0.06)
      ),
      part(new THREE.CylinderGeometry(0.06, 0.14, 2.2, 4), DARK_TRUNK, xf(0.7, 3.6, 0, 0, 0, -0.9)),
      part(
        new THREE.CylinderGeometry(0.05, 0.12, 1.8, 4),
        DARK_TRUNK,
        xf(-0.6, 3.1, 0.2, 0.3, 0, 0.9)
      ),
      part(
        new THREE.CylinderGeometry(0.04, 0.1, 1.4, 4),
        DARK_TRUNK,
        xf(0.1, 4.6, -0.4, -0.7, 0, 0.2)
      )
    ]),
  willow: (p) =>
    merge([
      part(new THREE.CylinderGeometry(0.35, 0.55, 3.6, 6), DARK_TRUNK, xf(0, 1.8, 0)),
      part(jitter(new THREE.ConeGeometry(3.4, 5.2, 9, 2, true), 0.1, 5), p.foliage, xf(0, 3.4, 0)),
      part(
        jitter(new THREE.IcosahedronGeometry(1.9, 0), 0.12, 6),
        shade(p.foliage, 1.15),
        xf(0, 5.4, 0, 0, 0, 0, 1, 0.7, 1)
      )
    ]),
  rock: (p) =>
    merge([
      part(
        jitter(new THREE.DodecahedronGeometry(1, 0), 0.22, 9),
        p.rock,
        xf(0, 0.25, 0, 0, 0, 0, 1.4, 0.85, 1.1)
      )
    ]),
  grass: (p) => {
    const parts: THREE.BufferGeometry[] = []
    for (let k = 0; k < 4; k++) {
      const blade = new THREE.BufferGeometry()
      blade.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([-0.07, 0, 0, 0.07, 0, 0, 0, 0.75, 0]), 3)
      )
      const a = (k / 4) * Math.PI
      parts.push(
        part(
          blade,
          k % 2 ? p.foliageAlt : p.groundMid,
          xf(Math.cos(a) * 0.12, 0, Math.sin(a) * 0.12, 0.2 * (k - 1.5), a, 0, 1, 0.8 + k * 0.12)
        )
      )
    }
    return merge(parts)
  },
  flower: () =>
    merge([
      part(new THREE.CylinderGeometry(0.025, 0.03, 0.55, 3), '#4f7a3a', xf(0, 0.27, 0)),
      part(new THREE.IcosahedronGeometry(0.13, 0), '#ffffff', xf(0, 0.6, 0))
    ]),
  reeds: (p) => {
    const parts: THREE.BufferGeometry[] = []
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2
      const h = 1.4 + (k % 3) * 0.35
      parts.push(
        part(
          new THREE.CylinderGeometry(0.03, 0.05, h, 3),
          k % 2 ? p.foliage : p.foliageAlt,
          xf(
            Math.cos(a) * 0.25,
            h / 2,
            Math.sin(a) * 0.25,
            0.08 * Math.sin(a),
            0,
            0.08 * Math.cos(a)
          )
        )
      )
      if (k % 2 === 0)
        parts.push(
          part(
            new THREE.CylinderGeometry(0.07, 0.07, 0.3, 4),
            '#6a4a32',
            xf(Math.cos(a) * 0.25, h, Math.sin(a) * 0.25)
          )
        )
    }
    return merge(parts)
  }
}

interface KindRule {
  /** Instances per unit of density at quality 1. */
  count: number
  scale: [number, number]
  maxSlope: number
  /** Height window relative to the liquid line. */
  minRel: number
  maxRel?: number
  /** Clustering: 0 = uniform, 1 = tight groves. */
  cluster: number
  sway: number
  collider?: number
  castShadow: boolean
  tree?: boolean
}

const RULES: Record<Flora, KindRule> = {
  pine: {
    count: 1500,
    scale: [0.7, 1.5],
    maxSlope: 0.9,
    minRel: 1.5,
    cluster: 0.6,
    sway: 0.0018,
    collider: 0.45,
    castShadow: true,
    tree: true
  },
  broadleaf: {
    count: 1200,
    scale: [0.7, 1.4],
    maxSlope: 0.75,
    minRel: 1.5,
    cluster: 0.55,
    sway: 0.002,
    collider: 0.5,
    castShadow: true,
    tree: true
  },
  palm: {
    count: 700,
    scale: [0.8, 1.3],
    maxSlope: 0.6,
    minRel: 0.6,
    maxRel: 14,
    cluster: 0.3,
    sway: 0.003,
    collider: 0.35,
    castShadow: true,
    tree: true
  },
  cactus: {
    count: 700,
    scale: [0.6, 1.4],
    maxSlope: 0.6,
    minRel: 1.5,
    cluster: 0.2,
    sway: 0,
    collider: 0.5,
    castShadow: true,
    tree: true
  },
  mushroom: {
    count: 700,
    scale: [0.6, 1.6],
    maxSlope: 0.7,
    minRel: 1,
    cluster: 0.6,
    sway: 0.004,
    castShadow: true
  },
  crystal: {
    count: 600,
    scale: [0.6, 1.8],
    maxSlope: 1.2,
    minRel: 1,
    cluster: 0.55,
    sway: 0,
    collider: 0.6,
    castShadow: true
  },
  deadtree: {
    count: 600,
    scale: [0.7, 1.4],
    maxSlope: 0.9,
    minRel: 1,
    cluster: 0.4,
    sway: 0.0008,
    collider: 0.35,
    castShadow: true,
    tree: true
  },
  willow: {
    count: 700,
    scale: [0.8, 1.4],
    maxSlope: 0.6,
    minRel: 0.5,
    maxRel: 12,
    cluster: 0.4,
    sway: 0.004,
    collider: 0.55,
    castShadow: true,
    tree: true
  },
  rock: {
    count: 900,
    scale: [0.4, 3.2],
    maxSlope: 2,
    minRel: -2,
    cluster: 0.2,
    sway: 0,
    castShadow: true
  },
  grass: {
    count: 16000,
    scale: [0.7, 1.5],
    maxSlope: 0.8,
    minRel: 0.8,
    cluster: 0.35,
    sway: 0.25,
    castShadow: false
  },
  flower: {
    count: 4000,
    scale: [0.7, 1.4],
    maxSlope: 0.6,
    minRel: 1.2,
    cluster: 0.7,
    sway: 0.25,
    castShadow: false
  },
  reeds: {
    count: 2400,
    scale: [0.7, 1.4],
    maxSlope: 0.6,
    minRel: -0.6,
    maxRel: 1.8,
    cluster: 0.4,
    sway: 0.08,
    castShadow: false
  }
}

const CHUNK = 140
const chunkKey = (x: number, z: number): number =>
  (Math.floor(x / CHUNK) + 64) * 128 + (Math.floor(z / CHUNK) + 64)

export interface FloraResult {
  group: THREE.Group
  /** Per-kind instance positions for the minimap / creatures. */
  counts: Record<string, number>
}

/** Scatter every flora kind over the land as instanced meshes. */
export function buildFlora(
  spec: WorldSpec,
  terrain: Terrain,
  layout: Layout,
  colliders: Colliders,
  rng: Rng,
  quality: number
): FloraResult {
  const group = new THREE.Group()
  group.name = 'flora'
  const counts: Record<string, number> = {}
  const mask = new Noise2D(rng.fork('flora-mask'))
  const liquid = terrain.liquidY
  const pads = layout.pads
  const treeKinds = spec.flora.kinds.filter((k) => RULES[k].tree)
  const giant = spec.biome === 'alien' ? 3.2 : 1

  for (const kind of spec.flora.kinds) {
    const rule = RULES[kind]
    const r = rng.fork(`flora-${kind}`)
    // Trees share one budget so naming three tree types doesn't triple the forest.
    const share = rule.tree ? 1 / Math.max(1, treeKinds.length) : 1
    const densityScale =
      kind === 'rock' ? 0.5 + spec.flora.density * 0.5 : 0.15 + spec.flora.density * 1.1
    const target = Math.floor(rule.count * share * densityScale * quality)
    if (target <= 0) continue
    if (kind === 'reeds' && terrain.solidLiquid) continue

    const geo = BUILDERS[kind](spec.palette, r, spec)
    const mat =
      kind === 'crystal'
        ? new THREE.MeshStandardMaterial({
            vertexColors: true,
            flatShading: true,
            emissive: new THREE.Color(spec.palette.accent),
            emissiveIntensity: 0.35,
            roughness: 0.25,
            metalness: 0.1
          })
        : new THREE.MeshLambertMaterial({
            vertexColors: true,
            flatShading: true,
            side: kind === 'grass' || kind === 'willow' ? THREE.DoubleSide : THREE.FrontSide
          })
    if (rule.sway > 0) addWind(mat, kind === 'mushroom' && giant > 1 ? rule.sway / 20 : rule.sway)

    // Instances are bucketed into spatial chunks so each chunk can be frustum-culled
    // (by the camera and by the shadow camera) instead of drawing the whole island.
    const chunks = new Map<number, { matrices: THREE.Matrix4[]; colors: THREE.Color[] }>()
    const dummy = new THREE.Object3D()
    const tint = new THREE.Color()
    const flowerHues = [spec.palette.accent, '#f2f2f2', '#ffd35a', '#ff8fb1', '#b58cff']
    const maskOffset = r.range(0, 1000)
    let placed = 0
    const maxTries = target * 6

    for (let t = 0; t < maxTries && placed < target; t++) {
      const a = r.range(0, Math.PI * 2)
      const d = Math.sqrt(r.next()) * LAND_RADIUS * 1.1
      const x = Math.cos(a) * d
      const z = Math.sin(a) * d
      const g = terrain.groundAt(x, z)
      const rel = g - liquid
      if (rel < rule.minRel || (rule.maxRel !== undefined && rel > rule.maxRel)) continue
      if (terrain.solidLiquid && rel < 0.5 && kind !== 'rock') continue
      if (terrain.slopeAt(x, z) > rule.maxSlope) continue
      if (rule.cluster > 0) {
        const m = mask.fbm(x * 0.006 + maskOffset, z * 0.006, 2) * 0.5 + 0.5
        if (m < rule.cluster * (1.05 - spec.flora.density * 0.4)) continue
      }
      const keepOut =
        rule.collider || kind === 'rock' ? 1.6 : kind === 'grass' || kind === 'flower' ? 0.45 : 1
      if (pads.some((p) => Math.hypot(x - p.x, z - p.z) < p.r * keepOut)) continue
      if ((rule.collider || kind === 'rock') && colliders.occupied(x, z, 1)) continue

      let s = r.range(rule.scale[0], rule.scale[1])
      if (kind === 'mushroom' || kind === 'crystal') s *= giant
      if (kind === 'rock')
        s = rule.scale[0] + Math.pow(r.next(), 3) * (rule.scale[1] - rule.scale[0])
      dummy.position.set(x, g - 0.15 * s, z)
      dummy.rotation.set(r.range(-0.06, 0.06), r.range(0, Math.PI * 2), r.range(-0.06, 0.06))
      dummy.scale.setScalar(s)
      dummy.updateMatrix()
      if (kind === 'flower') tint.set(r.pick(flowerHues))
      else tint.setScalar(1).multiplyScalar(r.range(0.85, 1.12))
      const ck = chunkKey(x, z)
      let chunk = chunks.get(ck)
      if (!chunk) chunks.set(ck, (chunk = { matrices: [], colors: [] }))
      chunk.matrices.push(dummy.matrix.clone())
      chunk.colors.push(tint.clone())

      if (rule.collider)
        colliders.add(x, z, rule.collider * s * (kind === 'crystal' ? 1.2 : 1), g + 6 * s)
      if (kind === 'rock' && s > 1.1) colliders.add(x, z, s * 1.05, g + s * 0.9)
      if (kind === 'mushroom' && s > 2) colliders.add(x, z, 0.35 * s, g + 1.5 * s)
      placed++
    }

    for (const [ck, chunk] of chunks) {
      const mesh = new THREE.InstancedMesh(geo, mat, chunk.matrices.length)
      chunk.matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
      chunk.colors.forEach((c, i) => mesh.setColorAt(i, c))
      mesh.castShadow = rule.castShadow && quality >= 0.6
      mesh.receiveShadow = kind !== 'grass'
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
      mesh.name = `flora-${kind}-${ck}`
      group.add(mesh)
    }
    counts[kind] = placed
  }

  if (spec.terrain.spires)
    group.add(buildSpires(spec, terrain, layout, colliders, rng.fork('spires'), quality))
  return { group, counts }
}

function buildSpires(
  spec: WorldSpec,
  terrain: Terrain,
  layout: Layout,
  colliders: Colliders,
  r: Rng,
  quality: number
): THREE.InstancedMesh {
  const geo = merge([
    part(
      jitter(new THREE.CylinderGeometry(0.45, 1, 1, 6, 3), 0.12, 4),
      spec.palette.rock,
      xf(0, 0.5, 0)
    ),
    part(new THREE.ConeGeometry(0.46, 0.12, 6), shade(spec.palette.rock, 1.25), xf(0, 1.05, 0))
  ])
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 1
  })
  const target = Math.floor(70 * quality)
  const mesh = new THREE.InstancedMesh(geo, mat, target)
  mesh.castShadow = true
  mesh.receiveShadow = true
  const dummy = new THREE.Object3D()
  let placed = 0
  for (let t = 0; t < target * 10 && placed < target; t++) {
    const a = r.range(0, Math.PI * 2)
    const d = Math.sqrt(r.next()) * LAND_RADIUS * 1.05
    const x = Math.cos(a) * d
    const z = Math.sin(a) * d
    const g = terrain.groundAt(x, z)
    if (g < terrain.liquidY - 6) continue
    if (layout.pads.some((p) => Math.hypot(x - p.x, z - p.z) < p.r * 2.5 + 10)) continue
    if (colliders.occupied(x, z, 8)) continue
    const radius = r.range(3, 7.5)
    const height = clamp(radius * r.range(4, 9), 18, 70)
    dummy.position.set(x, g - 2, z)
    dummy.rotation.set(r.range(-0.05, 0.05), r.range(0, Math.PI), r.range(-0.05, 0.05))
    dummy.scale.set(radius, height, radius)
    dummy.updateMatrix()
    mesh.setMatrixAt(placed++, dummy.matrix)
    colliders.add(x, z, radius * 0.9, g + height)
  }
  mesh.count = placed
  mesh.computeBoundingSphere()
  mesh.name = 'spires'
  return mesh
}
