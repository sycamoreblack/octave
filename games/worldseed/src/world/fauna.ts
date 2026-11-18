import * as THREE from 'three'
import { Rng } from '../engine/rng'
import { merge, part, xf } from '../engine/geo'
import { LAND_RADIUS, Terrain } from './terrain'
import type { WorldSpec } from './spec'

/** Ambient life: flocks, drifting wisps, butterflies and enormous sky whales. */
export interface FaunaRig {
  group: THREE.Group
  update(t: number, dt: number, player: THREE.Vector3): void
}

const flapUniform = { value: 0 }

/** Wings: any vertex far from the body's centre line flaps up and down. */
function flapping(mat: THREE.Material, speed: number, amount: number): THREE.Material {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFlap = flapUniform
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uFlap;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  float ph = instanceMatrix[3][0] * 0.37 + instanceMatrix[3][2] * 0.21;
#else
  float ph = 0.0;
#endif
  transformed.y += sin(uFlap * ${speed.toFixed(2)} + ph) * abs(transformed.x) * ${amount.toFixed(2)};`
      )
  }
  mat.customProgramCacheKey = () => `flap-${speed}-${amount}`
  return mat
}

export function buildFauna(
  spec: WorldSpec,
  terrain: Terrain,
  rng: Rng,
  anchors: THREE.Vector3[]
): FaunaRig {
  const group = new THREE.Group()
  group.name = 'fauna'
  const updaters: ((t: number, dt: number, player: THREE.Vector3) => void)[] = []
  const night = spec.timeOfDay < 0.17 || spec.timeOfDay > 0.86
  const dummy = new THREE.Object3D()

  if (spec.creatures.includes('birds')) {
    const r = rng.fork('birds')
    const flocks = 4
    const per = 9
    const geo = merge([
      part(new THREE.ConeGeometry(0.18, 0.9, 4), '#2a2a30', xf(0, 0, 0, Math.PI / 2)),
      part(
        new THREE.BufferGeometry().setAttribute(
          'position',
          new THREE.BufferAttribute(
            new Float32Array([
              0, 0, -0.2, 1.4, 0.05, 0.1, 0, 0, 0.3, 0, 0, -0.2, 0, 0, 0.3, -1.4, 0.05, 0.1
            ]),
            3
          )
        ),
        night ? '#1b1b22' : '#3a3a44'
      )
    ])
    const mesh = new THREE.InstancedMesh(
      geo,
      flapping(
        new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
        9,
        0.7
      ),
      flocks * per
    )
    const centers = Array.from({ length: flocks }, () => ({
      x: r.range(-LAND_RADIUS, LAND_RADIUS) * 0.7,
      z: r.range(-LAND_RADIUS, LAND_RADIUS) * 0.7,
      radius: r.range(40, 120),
      height: r.range(35, 70),
      speed: r.range(0.08, 0.16) * (r.chance(0.5) ? 1 : -1),
      offsets: Array.from(
        { length: per },
        (_, i) => new THREE.Vector3(r.range(-6, 6), r.range(-2, 2), (i - per / 2) * 1.6)
      )
    }))
    group.add(mesh)
    updaters.push((t) => {
      let k = 0
      for (const c of centers) {
        const a = t * c.speed
        const cx = c.x + Math.cos(a) * c.radius
        const cz = c.z + Math.sin(a) * c.radius
        const baseY = Math.max(terrain.groundAt(cx, cz), terrain.liquidY) + c.height
        // Velocity of the circle path; birds face along it (+z is a bird's nose).
        const heading = Math.atan2(
          -Math.sin(a) * Math.sign(c.speed),
          Math.cos(a) * Math.sign(c.speed)
        )
        const ch = Math.cos(heading)
        const sh = Math.sin(heading)
        for (const o of c.offsets) {
          const ox = o.x * ch + o.z * sh
          const oz = -o.x * sh + o.z * ch
          dummy.position.set(cx + ox, baseY + o.y + Math.sin(t + o.x) * 0.6, cz + oz)
          dummy.rotation.set(0, heading, Math.sin(t * 0.5 + o.z) * 0.2)
          dummy.scale.setScalar(1.3)
          dummy.updateMatrix()
          mesh.setMatrixAt(k++, dummy.matrix)
        }
      }
      mesh.instanceMatrix.needsUpdate = true
    })
    mesh.frustumCulled = false
  }

  if (spec.creatures.includes('butterflies') && !night) {
    const r = rng.fork('butterflies')
    const n = 60
    const geo = merge([
      part(
        new THREE.BufferGeometry().setAttribute(
          'position',
          new THREE.BufferAttribute(
            new Float32Array([
              0, 0, -0.1, 0.35, 0, 0.15, 0, 0, 0.15, 0, 0, -0.1, 0, 0, 0.15, -0.35, 0, 0.15
            ]),
            3
          )
        ),
        '#ffffff'
      )
    ])
    const mesh = new THREE.InstancedMesh(
      geo,
      flapping(
        new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
        22,
        1.4
      ),
      n
    )
    const hues = [spec.palette.accent, '#ffd35a', '#ffffff', '#ff9fd0', '#9fd4ff']
    const bugs = Array.from({ length: n }, (_, i) => {
      mesh.setColorAt(i, new THREE.Color(r.pick(hues)))
      return { home: new THREE.Vector3(), seed: r.range(0, 100), active: false }
    })
    group.add(mesh)
    mesh.frustumCulled = false
    updaters.push((t, _dt, player) => {
      for (let i = 0; i < n; i++) {
        const b = bugs[i]
        // Butterflies keep near the player so they're always somewhere to be seen.
        if (!b.active || b.home.distanceTo(player) > 70) {
          b.home.set(player.x + r.range(-60, 60), 0, player.z + r.range(-60, 60))
          b.active = true
        }
        const x = b.home.x + Math.sin(t * 0.4 + b.seed) * 4 + Math.sin(t * 1.3 + b.seed * 2) * 1.5
        const z = b.home.z + Math.cos(t * 0.35 + b.seed) * 4
        const g = terrain.groundAt(x, z)
        dummy.position.set(
          x,
          Math.max(g, terrain.liquidY) + 1.2 + Math.sin(t * 2 + b.seed) * 0.5,
          z
        )
        dummy.rotation.set(0, t * 0.5 + b.seed, 0)
        dummy.scale.setScalar(g < terrain.liquidY ? 0 : 1)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
    })
  }

  if (spec.creatures.includes('wisps')) {
    const r = rng.fork('wisps')
    const n = 70
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(spec.palette.accent).lerp(new THREE.Color('#ffffff'), 0.5),
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.22, 1), mat, n)
    const halo = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.6, 1),
      new THREE.MeshBasicMaterial({
        color: spec.palette.accent,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      }),
      n
    )
    const homes = Array.from({ length: n }, (_, i) => {
      const a = anchors[i % anchors.length]
      const ang = r.range(0, Math.PI * 2)
      const d = r.range(8, 50)
      return { x: a.x + Math.cos(ang) * d, z: a.z + Math.sin(ang) * d, seed: r.range(0, 100) }
    })
    group.add(mesh, halo)
    mesh.frustumCulled = halo.frustumCulled = false
    updaters.push((t) => {
      for (let i = 0; i < n; i++) {
        const h = homes[i]
        const x = h.x + Math.sin(t * 0.21 + h.seed) * 6
        const z = h.z + Math.cos(t * 0.17 + h.seed * 1.3) * 6
        const y =
          Math.max(terrain.groundAt(x, z), terrain.liquidY) + 1.8 + Math.sin(t * 0.8 + h.seed) * 0.8
        dummy.position.set(x, y, z)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.setScalar(0.8 + 0.3 * Math.sin(t * 3 + h.seed))
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        halo.setMatrixAt(i, dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
      halo.instanceMatrix.needsUpdate = true
    })
  }

  if (spec.creatures.includes('skywhales')) {
    const r = rng.fork('whales')
    const body = new THREE.Color(spec.palette.foliageAlt).lerp(
      new THREE.Color(spec.palette.skyTop),
      0.4
    )
    const belly = body.clone().lerp(new THREE.Color('#ffffff'), 0.5)
    const whaleGeo = merge([
      part(new THREE.IcosahedronGeometry(1, 1), body, xf(0, 0, 0, 0, 0, 0, 3.2, 2.2, 9)),
      part(new THREE.IcosahedronGeometry(1, 1), belly, xf(0, -0.7, 0.5, 0, 0, 0, 2.6, 1.4, 7.5)),
      part(new THREE.ConeGeometry(1.1, 4.5, 3), body, xf(3.4, -0.8, 1.5, 0, 0, -1.9, 1, 1, 0.3)),
      part(new THREE.ConeGeometry(1.1, 4.5, 3), body, xf(-3.4, -0.8, 1.5, 0, 0, 1.9, 1, 1, 0.3))
    ])
    const tailGeo = merge([
      part(new THREE.ConeGeometry(1.4, 7, 6), body, xf(0, 0, -3.5, -Math.PI / 2)),
      part(new THREE.BoxGeometry(8, 0.35, 2.6), body, xf(0, 0, -7))
    ])
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      emissive: new THREE.Color(spec.palette.accent),
      emissiveIntensity: night ? 0.15 : 0.03
    })
    const whales = Array.from({ length: 3 }, (_, i) => {
      const g = new THREE.Group()
      const b = new THREE.Mesh(whaleGeo, mat)
      const tail = new THREE.Mesh(tailGeo, mat)
      tail.position.z = -7.5
      g.add(b, tail)
      g.scale.setScalar(r.range(1.6, 2.6))
      group.add(g)
      return {
        g,
        tail,
        cx: r.range(-300, 300),
        cz: r.range(-300, 300),
        radius: r.range(150, 320),
        height: r.range(110, 170) + i * 15,
        speed: r.range(0.012, 0.022),
        phase: r.range(0, 6.28)
      }
    })
    updaters.push((t) => {
      for (const w of whales) {
        const a = t * w.speed + w.phase
        w.g.position.set(
          w.cx + Math.cos(a) * w.radius,
          w.height + Math.sin(t * 0.2 + w.phase) * 6,
          w.cz + Math.sin(a) * w.radius
        )
        w.g.rotation.set(Math.sin(t * 0.2 + w.phase) * 0.06, -a, Math.sin(t * 0.3) * 0.05)
        w.tail.rotation.x = Math.sin(t * 0.8 + w.phase) * 0.25
      }
    })
  }

  return {
    group,
    update(t, dt, player) {
      flapUniform.value = t
      for (const u of updaters) u(t, dt, player)
    }
  }
}
