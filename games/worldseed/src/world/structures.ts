import * as THREE from 'three'
import { Rng } from '../engine/rng'
import { jitter, merge, part, xf } from '../engine/geo'
import { Colliders } from '../engine/colliders'
import type { Structure, WorldSpec } from './spec'
import type { Terrain } from './terrain'

/**
 * Procedural landmarks. Each builder returns a merged, vertex-coloured group in local
 * space plus cylinder colliders, and says where the shard should float.
 */
export interface Built {
  group: THREE.Group
  /** Local-space point where the shard hovers. */
  shardAt: THREE.Vector3
  /** Animated bits (lighthouse lamp etc). */
  tick?: (t: number) => void
}

interface Ctx {
  spec: WorldSpec
  rng: Rng
  stone: THREE.Color
  dark: THREE.Color
  accent: THREE.Color
  wood: THREE.Color
  colliders: Colliders
  terrain: Terrain
  /** World transform of the structure, for registering colliders. */
  origin: { x: number; y: number; z: number; yaw: number }
}

const stoneMaterial = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 })

function glowMaterial(
  color: THREE.ColorRepresentation,
  intensity = 1.6
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    roughness: 0.4
  })
}

/** Register a walkable floor given local coordinates (circle r, or box hx × hz). */
function floor(
  ctx: Ctx,
  lx: number,
  lz: number,
  top: number,
  shape: { r: number } | { hx: number; hz: number }
): void {
  const { x, y, z, yaw } = ctx.origin
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const wx = x + lx * c + lz * s
  const wz = z - lx * s + lz * c
  if ('r' in shape)
    ctx.terrain.platforms.push({ x: wx, z: wz, top: y + top, r: shape.r, bound: shape.r })
  else
    ctx.terrain.platforms.push({
      x: wx,
      z: wz,
      top: y + top,
      hx: shape.hx,
      hz: shape.hz,
      yaw,
      bound: Math.hypot(shape.hx, shape.hz)
    })
}

/** Register a collider given local coordinates. */
function collide(ctx: Ctx, lx: number, lz: number, r: number, top: number): void {
  const { x, y, z, yaw } = ctx.origin
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  ctx.colliders.add(x + lx * c + lz * s, z - lx * s + lz * c, r, y + top)
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

function column(
  ctx: Ctx,
  x: number,
  z: number,
  h: number,
  r = 0.9,
  broken = false
): THREE.BufferGeometry[] {
  const parts = [
    part(new THREE.CylinderGeometry(r * 1.35, r * 1.45, 0.6, 8), ctx.stone, xf(x, 0.3, z)),
    part(
      jitter(new THREE.CylinderGeometry(r, r * 1.08, h, 8, 3), broken ? 0.05 : 0.015, x + z),
      ctx.stone,
      xf(x, 0.6 + h / 2, z)
    )
  ]
  if (!broken)
    parts.push(
      part(new THREE.BoxGeometry(r * 2.8, 0.55, r * 2.8), ctx.stone, xf(x, 0.6 + h + 0.27, z))
    )
  collide(ctx, x, z, r * 1.3, h + 1)
  return parts
}

const BUILD: Record<Structure, (ctx: Ctx) => Built> = {
  ruins(ctx) {
    const { rng } = ctx
    const parts: THREE.BufferGeometry[] = [
      part(new THREE.CylinderGeometry(13, 13.6, 0.7, 14), ctx.dark, xf(0, 0.1, 0)),
      part(new THREE.CylinderGeometry(4, 4.4, 0.9, 10), ctx.stone, xf(0, 0.5, 0))
    ]
    const n = 10
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const broken = rng.chance(0.45)
      const h = broken ? rng.range(1.5, 5) : rng.range(7, 8.5)
      parts.push(...column(ctx, Math.cos(a) * 10.5, Math.sin(a) * 10.5, h, 0.8, broken))
      if (broken && rng.chance(0.6)) {
        const fa = a + rng.range(-0.3, 0.3)
        parts.push(
          part(
            new THREE.CylinderGeometry(0.8, 0.8, rng.range(2.5, 4), 8),
            ctx.stone,
            xf(Math.cos(fa) * 14, 0.7, Math.sin(fa) * 14, Math.PI / 2, 0, fa)
          )
        )
      }
    }
    floor(ctx, 0, 0, 0.45, { r: 13 })
    floor(ctx, 0, 0, 0.95, { r: 4 })
    // A surviving lintel segment.
    parts.push(
      part(
        new THREE.BoxGeometry(7, 0.8, 1.6),
        ctx.stone,
        xf(10.4, 9.4, 1.6, 0, Math.PI / 2 - 0.15, 0)
      )
    )
    const g = new THREE.Group()
    g.add(mesh(merge(parts), stoneMaterial()))
    return { group: g, shardAt: new THREE.Vector3(0, 2.6, 0) }
  },

  tower(ctx) {
    const parts: THREE.BufferGeometry[] = []
    const tiers = 4
    let y = 0
    let r = 5.5
    for (let i = 0; i < tiers; i++) {
      const h = 7 - i * 0.6
      parts.push(
        part(
          jitter(new THREE.CylinderGeometry(r * 0.92, r, h, 9, 2), 0.02, i),
          i % 2 ? ctx.stone : ctx.stone.clone().multiplyScalar(0.9),
          xf(0, y + h / 2, 0)
        )
      )
      parts.push(
        part(new THREE.CylinderGeometry(r * 1.02, r * 1.02, 0.5, 9), ctx.dark, xf(0, y + h, 0))
      )
      y += h
      r *= 0.86
    }
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      parts.push(
        part(
          new THREE.BoxGeometry(1.1, 1.3, 1.1),
          ctx.stone,
          xf(Math.cos(a) * r * 1.05, y + 0.6, Math.sin(a) * r * 1.05, 0, -a)
        )
      )
    }
    parts.push(part(new THREE.ConeGeometry(r * 1.1, 6, 9), ctx.dark, xf(0, y + 3.6, 0)))
    // Door and stairs facing the heart (+z local).
    parts.push(part(new THREE.BoxGeometry(2.6, 4, 1.2), '#151214', xf(0, 2, 5.15)))
    parts.push(part(new THREE.BoxGeometry(5, 0.5, 3), ctx.stone, xf(0, 0.25, 6.6)))
    floor(ctx, 0, 6.6, 0.5, { hx: 2.5, hz: 1.5 })
    collide(ctx, 0, 0, 5.6, y + 8)
    const g = new THREE.Group()
    g.add(mesh(merge(parts), stoneMaterial()))
    // Glowing windows.
    const winGeo: THREE.BufferGeometry[] = []
    for (let i = 1; i < tiers; i++) {
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + i
        const rr = 5.5 * Math.pow(0.86, i) * 0.93
        winGeo.push(
          part(
            new THREE.BoxGeometry(0.7, 1.4, 0.3),
            '#ffffff',
            xf(Math.cos(a) * rr, i * 6.6 + 3, Math.sin(a) * rr, 0, -a + Math.PI / 2)
          )
        )
      }
    }
    g.add(new THREE.Mesh(merge(winGeo), glowMaterial('#ffcf7a', 1.2)))
    return { group: g, shardAt: new THREE.Vector3(0, 2.2, 9.5) }
  },

  henge(ctx) {
    const { rng } = ctx
    const parts: THREE.BufferGeometry[] = []
    const n = 9
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const h = rng.range(6, 9.5)
      const x = Math.cos(a) * 11
      const z = Math.sin(a) * 11
      parts.push(
        part(
          jitter(new THREE.BoxGeometry(2.2, h, 1.3, 1, 2, 1), 0.08, i),
          ctx.stone,
          xf(x, h / 2 - 0.4, z, rng.range(-0.06, 0.06), -a + Math.PI / 2, rng.range(-0.05, 0.05))
        )
      )
      collide(ctx, x, z, 1.4, h)
      if (i % 3 === 0) {
        const b = ((i + 1) / n) * Math.PI * 2
        const mx = (Math.cos(a) + Math.cos(b)) * 5.4
        const mz = (Math.sin(a) + Math.sin(b)) * 5.4
        parts.push(
          part(
            new THREE.BoxGeometry(8, 1.1, 1.5),
            ctx.stone,
            xf(mx, h - 0.1, mz, 0, -(a + b) / 2, 0)
          )
        )
      }
    }
    parts.push(part(jitter(new THREE.BoxGeometry(3.2, 1.2, 2.2), 0.05, 3), ctx.dark, xf(0, 0.6, 0)))
    collide(ctx, 0, 0, 1.6, 1.2)
    // Runes on the altar.
    const g = new THREE.Group()
    g.add(mesh(merge(parts), stoneMaterial()))
    const runes = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 0.06, 0.25),
      glowMaterial(ctx.accent, 2)
    )
    runes.position.set(0, 1.23, 0)
    g.add(runes)
    return { group: g, shardAt: new THREE.Vector3(0, 3.1, 0) }
  },

  arch(ctx) {
    const parts: THREE.BufferGeometry[] = []
    for (const side of [-1, 1]) {
      parts.push(
        part(
          jitter(new THREE.BoxGeometry(2.8, 13, 2.8, 1, 4, 1), 0.03, side),
          ctx.stone,
          xf(side * 5.5, 6.5, 0)
        )
      )
      parts.push(part(new THREE.BoxGeometry(3.6, 1, 3.6), ctx.dark, xf(side * 5.5, 0.5, 0)))
      collide(ctx, side * 5.5, 0, 2.1, 14)
    }
    // Curved top made of wedge blocks.
    const segs = 9
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI
      parts.push(
        part(
          new THREE.BoxGeometry(2.2, 1.8, 2.9),
          i % 2 ? ctx.stone : ctx.stone.clone().multiplyScalar(0.92),
          xf(Math.cos(a) * 5.5, 13 + Math.sin(a) * 4, 0, 0, 0, a - Math.PI / 2)
        )
      )
    }
    parts.push(part(new THREE.BoxGeometry(15, 0.4, 9), ctx.dark, xf(0, 0.1, 0)))
    floor(ctx, 0, 0, 0.3, { hx: 7.5, hz: 4.5 })
    for (let s = 0; s < 3; s++) {
      parts.push(
        part(new THREE.BoxGeometry(9, 0.35, 1.4), ctx.stone, xf(0, 0.3 + s * 0.3, 4.4 - s * 1.2))
      )
      floor(ctx, 0, 4.4 - s * 1.2, 0.475 + s * 0.3, { hx: 4.5, hz: 0.7 })
    }
    const g = new THREE.Group()
    g.add(mesh(merge(parts), stoneMaterial()))
    const keystone = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.9, 0),
      glowMaterial(ctx.accent, 1.5)
    )
    keystone.position.set(0, 17.6, 1.5)
    g.add(keystone)
    return { group: g, shardAt: new THREE.Vector3(0, 3, 0) }
  },

  lighthouse(ctx) {
    const parts: THREE.BufferGeometry[] = []
    const bands = 6
    for (let i = 0; i < bands; i++) {
      const r0 = 3.6 - i * 0.28
      const r1 = 3.6 - (i + 1) * 0.28
      parts.push(
        part(
          new THREE.CylinderGeometry(r1, r0, 4, 10),
          i % 2 ? '#c8423b' : '#f1ece2',
          xf(0, 2 + i * 4, 0)
        )
      )
    }
    const top = bands * 4
    parts.push(part(new THREE.CylinderGeometry(2.6, 2.6, 0.5, 10), ctx.dark, xf(0, top + 0.25, 0)))
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2
      parts.push(
        part(
          new THREE.CylinderGeometry(0.08, 0.08, 2.4, 4),
          ctx.dark,
          xf(Math.cos(a) * 1.7, top + 1.6, Math.sin(a) * 1.7)
        )
      )
    }
    parts.push(part(new THREE.ConeGeometry(2.3, 2, 10), '#3a3a44', xf(0, top + 3.6, 0)))
    parts.push(part(new THREE.CylinderGeometry(5, 5.5, 1.2, 12), ctx.stone, xf(0, 0.2, 0)))
    floor(ctx, 0, 0, 0.8, { r: 5.1 })
    parts.push(part(new THREE.BoxGeometry(1.8, 3, 0.6), '#1d1a1a', xf(0, 1.5, 3.3)))
    collide(ctx, 0, 0, 3.7, top + 4)
    const g = new THREE.Group()
    g.add(mesh(merge(parts), stoneMaterial()))
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), glowMaterial('#fff2b0', 3))
    lamp.position.y = top + 1.6
    g.add(lamp)
    // Sweeping beam: an open cone, additive.
    const beamGeo = new THREE.ConeGeometry(6, 60, 16, 1, true)
    beamGeo.translate(0, -30, 0)
    beamGeo.rotateZ(Math.PI / 2)
    const beam = new THREE.Mesh(
      beamGeo,
      new THREE.MeshBasicMaterial({
        color: '#fff3c4',
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false
      })
    )
    beam.position.y = top + 1.6
    g.add(beam)
    return {
      group: g,
      shardAt: new THREE.Vector3(0, 2.2, 6.5),
      tick: (t) => {
        beam.rotation.y = t * 0.45
      }
    }
  },

  colossus(ctx) {
    const { rng } = ctx
    const parts: THREE.BufferGeometry[] = []
    const metal = ctx.stone.clone().lerp(ctx.dark, 0.35)
    // A titanic half-buried head.
    parts.push(
      part(
        jitter(new THREE.IcosahedronGeometry(7, 1), 0.06, 7),
        metal,
        xf(-6, 3.5, -3, 0.3, 0.4, 0.25, 1, 0.9, 1.1)
      )
    )
    parts.push(part(new THREE.BoxGeometry(4, 1.2, 3), ctx.dark, xf(-6, 7.5, 1.5, 0.3, 0.4, 0.25)))
    collide(ctx, -6, -3, 7, 10)
    // Its open hand, palm up — the shard rests here.
    parts.push(
      part(jitter(new THREE.BoxGeometry(6, 1.6, 5), 0.05, 2), metal, xf(6, 0.6, 3, 0, 0.3, 0))
    )
    for (let f = 0; f < 4; f++) {
      parts.push(
        part(
          new THREE.CylinderGeometry(0.55, 0.65, 4, 6),
          metal,
          xf(4.2 + f * 1.3, 1.4, 6.4, Math.PI / 2 - 0.5 - f * 0.08, 0.3, 0)
        )
      )
    }
    parts.push(
      part(
        new THREE.CylinderGeometry(0.7, 0.8, 4, 6),
        metal,
        xf(9.2, 1.4, 2, 0, 0, Math.PI / 2 - 0.6)
      )
    )
    // Ribs or girders curving out of the ground behind.
    for (let i = 0; i < 6; i++) {
      const z = -10 - i * 3.2
      for (const side of [-1, 1]) {
        parts.push(
          part(
            new THREE.CylinderGeometry(0.6, 0.8, rng.range(8, 13), 6),
            metal,
            xf(side * 4.5 + 4, 4, z, 0, 0, side * -0.45)
          )
        )
        collide(ctx, side * 4.5 + 4, z, 1.1, 9)
      }
    }
    const g = new THREE.Group()
    g.add(mesh(merge(parts), stoneMaterial()))
    const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), glowMaterial(ctx.accent, 1.2))
    eye.position.set(-3.5, 5.2, 2.6)
    g.add(eye)
    return { group: g, shardAt: new THREE.Vector3(6, 3.4, 3) }
  },

  hamlet(ctx) {
    const { rng } = ctx
    const walls: THREE.BufferGeometry[] = []
    const windows: THREE.BufferGeometry[] = []
    const roofColor = new THREE.Color(rng.pick(['#7a3b2e', '#4a5a6a', '#6b5a3a', '#5a3f5f']))
    const n = 6
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2)
      const d = rng.range(11, 16)
      const x = Math.cos(a) * d
      const z = Math.sin(a) * d
      const w = rng.range(3.5, 5)
      const h = rng.range(2.6, 3.6)
      const face = -a - Math.PI / 2
      walls.push(
        part(
          new THREE.BoxGeometry(w, h, w * 0.8),
          ctx.wood.clone().lerp(ctx.stone, 0.5),
          xf(x, h / 2, z, 0, face)
        )
      )
      walls.push(
        part(
          new THREE.ConeGeometry(w * 0.85, 2.6, 4),
          roofColor,
          xf(x, h + 1.3, z, 0, face + Math.PI / 4, 0, 1, 1, 1)
        )
      )
      walls.push(
        part(
          new THREE.BoxGeometry(0.9, 1.7, 0.2),
          '#2a1f1a',
          xf(x - Math.cos(a) * w * 0.41, 0.85, z - Math.sin(a) * w * 0.41, 0, face)
        )
      )
      windows.push(
        part(
          new THREE.BoxGeometry(0.7, 0.7, 0.2),
          '#ffffff',
          xf(x - Math.cos(a + 0.35) * w * 0.43, h * 0.6, z - Math.sin(a + 0.35) * w * 0.43, 0, face)
        )
      )
      collide(ctx, x, z, w * 0.62, h + 2.5)
    }
    // The well, where the shard waits.
    walls.push(
      part(new THREE.CylinderGeometry(1.6, 1.7, 1.1, 10, 1, true), ctx.stone, xf(0, 0.55, 0))
    )
    walls.push(part(new THREE.CylinderGeometry(0.12, 0.12, 2.8, 4), ctx.wood, xf(-1.4, 1.4, 0)))
    walls.push(part(new THREE.CylinderGeometry(0.12, 0.12, 2.8, 4), ctx.wood, xf(1.4, 1.4, 0)))
    walls.push(part(new THREE.ConeGeometry(2.2, 1.2, 4), roofColor, xf(0, 3.3, 0, 0, Math.PI / 4)))
    collide(ctx, 0, 0, 1.7, 1.1)
    const g = new THREE.Group()
    g.add(mesh(merge(walls), stoneMaterial()))
    g.add(new THREE.Mesh(merge(windows), glowMaterial('#ffc66b', 1.4)))
    return { group: g, shardAt: new THREE.Vector3(0, 1.9, 0) }
  },

  shrine(ctx) {
    const parts: THREE.BufferGeometry[] = []
    for (let s = 0; s < 3; s++) {
      const w = 12 - s * 2.5
      parts.push(
        part(
          new THREE.BoxGeometry(w, 0.6, w),
          s % 2 ? ctx.dark : ctx.stone,
          xf(0, 0.3 + s * 0.6, 0)
        )
      )
      floor(ctx, 0, 0, 0.6 + s * 0.6, { hx: w / 2, hz: w / 2 })
    }
    const top = 1.8
    for (const [x, z] of [
      [-2.6, -2.6],
      [2.6, -2.6],
      [-2.6, 2.6],
      [2.6, 2.6]
    ]) {
      parts.push(
        part(new THREE.CylinderGeometry(0.35, 0.4, 4.4, 6), '#8a2f2a', xf(x, top + 2.2, z))
      )
      collide(ctx, x, z, 0.45, top + 4.4)
    }
    parts.push(part(new THREE.BoxGeometry(7.4, 0.5, 7.4), ctx.dark, xf(0, top + 4.6, 0)))
    parts.push(
      part(new THREE.ConeGeometry(5.8, 2.6, 4), '#3b3438', xf(0, top + 6.1, 0, 0, Math.PI / 4))
    )
    parts.push(part(new THREE.CylinderGeometry(0.8, 1, 1.2, 8), ctx.stone, xf(0, top + 0.6, 0)))
    const g = new THREE.Group()
    g.add(mesh(merge(parts), stoneMaterial()))
    const lanterns: THREE.BufferGeometry[] = []
    for (const [x, z] of [
      [-5, 5.6],
      [5, 5.6],
      [-5, -5.6],
      [5, -5.6]
    ]) {
      lanterns.push(part(new THREE.BoxGeometry(0.5, 0.7, 0.5), '#ffffff', xf(x, 1.3, z)))
      collide(ctx, x, z, 0.4, 1.6)
    }
    g.add(new THREE.Mesh(merge(lanterns), glowMaterial('#ffb35c', 1.6)))
    const posts: THREE.BufferGeometry[] = []
    for (const [x, z] of [
      [-5, 5.6],
      [5, 5.6],
      [-5, -5.6],
      [5, -5.6]
    ])
      posts.push(part(new THREE.CylinderGeometry(0.1, 0.12, 1, 4), ctx.dark, xf(x, 0.5, z)))
    g.add(mesh(merge(posts), stoneMaterial()))
    return { group: g, shardAt: new THREE.Vector3(0, top + 2.6, 0) }
  }
}

function ctxFor(
  spec: WorldSpec,
  rng: Rng,
  colliders: Colliders,
  terrain: Terrain,
  origin: Ctx['origin']
): Ctx {
  const stone = new THREE.Color(spec.palette.stone)
  return {
    spec,
    rng,
    colliders,
    terrain,
    origin,
    stone,
    dark: stone.clone().multiplyScalar(0.55),
    accent: new THREE.Color(spec.palette.accent),
    wood: new THREE.Color('#6b5038')
  }
}

export function buildStructure(
  kind: Structure,
  spec: WorldSpec,
  rng: Rng,
  colliders: Colliders,
  terrain: Terrain,
  origin: Ctx['origin']
): Built {
  const built = BUILD[kind](ctxFor(spec, rng, colliders, terrain, origin))
  built.group.position.set(origin.x, origin.y, origin.z)
  built.group.rotation.y = origin.yaw
  built.group.name = `structure-${kind}`
  return built
}

/** A small marker for minor places: a cairn, a lone stone, a ribboned post. */
export function buildMarker(
  spec: WorldSpec,
  rng: Rng,
  colliders: Colliders,
  terrain: Terrain,
  origin: Ctx['origin']
): THREE.Group {
  const ctx = ctxFor(spec, rng, colliders, terrain, origin)
  const parts: THREE.BufferGeometry[] = []
  const kind = rng.int(0, 2)
  if (kind === 0) {
    let y = 0
    for (let i = 0; i < 5; i++) {
      const s = 1.1 - i * 0.17
      parts.push(
        part(
          jitter(new THREE.DodecahedronGeometry(s, 0), 0.1, i),
          ctx.stone.clone().multiplyScalar(0.8 + i * 0.06),
          xf(rng.range(-0.1, 0.1), y + s * 0.6, rng.range(-0.1, 0.1), 0, i, 0, 1, 0.6, 1)
        )
      )
      y += s * 1.05
    }
    collide(ctx, 0, 0, 1.2, y)
  } else if (kind === 1) {
    parts.push(
      part(
        jitter(new THREE.BoxGeometry(1.6, 5.5, 1, 1, 3, 1), 0.08, 3),
        ctx.stone,
        xf(0, 2.5, 0, 0.08, 0.3, 0.05)
      )
    )
    collide(ctx, 0, 0, 1.1, 5.5)
  } else {
    parts.push(part(new THREE.CylinderGeometry(0.14, 0.18, 3.6, 5), ctx.wood, xf(0, 1.8, 0, 0.1)))
    for (let i = 0; i < 4; i++)
      parts.push(
        part(
          new THREE.BoxGeometry(0.08, 1.4, 0.25),
          new THREE.Color(spec.palette.accent).lerp(new THREE.Color('#ffffff'), i * 0.2),
          xf(0.15, 2.8 - i * 0.3, 0.1 * i, 0.2, i, 0.5)
        )
      )
    collide(ctx, 0, 0, 0.3, 3.6)
  }
  for (let i = 0; i < 4; i++) {
    const a = rng.range(0, Math.PI * 2)
    parts.push(
      part(
        jitter(new THREE.DodecahedronGeometry(rng.range(0.25, 0.5), 0), 0.15, i + 10),
        ctx.stone.clone().multiplyScalar(0.7),
        xf(Math.cos(a) * 2.3, 0.1, Math.sin(a) * 2.3)
      )
    )
  }
  const g = new THREE.Group()
  g.add(mesh(merge(parts), stoneMaterial()))
  g.position.set(origin.x, origin.y, origin.z)
  g.rotation.y = origin.yaw
  g.name = 'marker'
  return g
}

/**
 * The heart: a raised dais with a great standing ring and one pedestal per shard.
 * Pedestals light up as shards are brought home.
 */
export function buildHeart(
  spec: WorldSpec,
  rng: Rng,
  colliders: Colliders,
  terrain: Terrain,
  origin: Ctx['origin'],
  shardCount: number
): {
  group: THREE.Group
  pedestals: THREE.Mesh[]
  ring: THREE.Mesh
  relic: THREE.Mesh
  center: THREE.Vector3
} {
  const ctx = ctxFor(spec, rng, colliders, terrain, origin)
  const parts: THREE.BufferGeometry[] = []
  parts.push(part(new THREE.CylinderGeometry(17, 18.5, 1, 20), ctx.dark, xf(0, 0.2, 0)))
  parts.push(part(new THREE.CylinderGeometry(12.5, 13.5, 1, 20), ctx.stone, xf(0, 1, 0)))
  parts.push(part(new THREE.CylinderGeometry(7.5, 8, 0.8, 16), ctx.dark, xf(0, 1.8, 0)))
  floor(ctx, 0, 0, 0.7, { r: 17.5 })
  floor(ctx, 0, 0, 1.5, { r: 13 })
  floor(ctx, 0, 0, 2.2, { r: 7.8 })
  // The ring's footings.
  for (const side of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(3, 4, 3.4), ctx.stone, xf(side * 9.2, 3, 0)))
    collide(ctx, side * 9.2, 0, 2.2, 6)
  }
  const pedestals: THREE.Mesh[] = []
  const g = new THREE.Group()
  for (let i = 0; i < shardCount; i++) {
    const a = (i / shardCount) * Math.PI * 2 + Math.PI / 4
    const x = Math.cos(a) * 11
    const z = Math.sin(a) * 11
    parts.push(part(new THREE.CylinderGeometry(0.9, 1.2, 2.6, 6), ctx.stone, xf(x, 2.6, z)))
    collide(ctx, x, z, 1.2, 4)
    const gem = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.7, 0),
      new THREE.MeshStandardMaterial({
        color: '#30303a',
        roughness: 0.4,
        emissive: new THREE.Color(spec.palette.accent),
        emissiveIntensity: 0
      })
    )
    gem.position.set(x, 4.6, z)
    g.add(gem)
    pedestals.push(gem)
  }
  g.add(mesh(merge(parts), stoneMaterial()))

  const ringMat = new THREE.MeshStandardMaterial({
    color: ctx.stone.clone().multiplyScalar(0.8),
    roughness: 0.6,
    metalness: 0.2,
    flatShading: true,
    emissive: new THREE.Color(spec.palette.accent),
    emissiveIntensity: 0
  })
  const ring = new THREE.Mesh(new THREE.TorusGeometry(9.2, 1.1, 8, 36), ringMat)
  ring.position.y = 12
  ring.castShadow = true
  g.add(ring)

  const relic = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.6, 0),
    glowMaterial(spec.palette.accent, 2.5)
  )
  relic.position.y = 12
  relic.visible = false
  g.add(relic)

  g.position.set(origin.x, origin.y, origin.z)
  g.rotation.y = origin.yaw
  g.name = 'heart'
  return {
    group: g,
    pedestals,
    ring,
    relic,
    center: new THREE.Vector3(origin.x, origin.y + 2.2, origin.z)
  }
}
