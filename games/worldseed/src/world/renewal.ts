import * as THREE from 'three'
import { Rng } from '../engine/rng'
import { jitter, merge, part, xf } from '../engine/geo'
import { Colliders } from '../engine/colliders'
import { Terrain } from './terrain'
import type { WorldSpec } from './spec'

/**
 * What the land does once the relic is restored: flowers spring up around the heart and
 * dead trees leaf out. Both are built hidden at load and grown by one shader uniform, so the
 * finale costs nothing until it happens and a restored world loads already in bloom.
 */

/** Scale vertices about `center` by uGrow (0 = hidden, 1 = full size). */
function growable(
  mat: THREE.Material,
  grow: { value: number },
  center: THREE.Vector3
): THREE.Material {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrow = grow
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uGrow;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  vec3 growCenter = vec3(${center.x.toFixed(3)}, ${center.y.toFixed(3)}, ${center.z.toFixed(3)});
#ifdef USE_INSTANCING
  // Each instance blooms a little after its neighbours, so growth ripples outward.
  float lag = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453) * 0.35;
#else
  float lag = 0.0;
#endif
  float g = clamp((uGrow - lag) / (1.0 - 0.35), 0.0, 1.0);
  g = g * g * (3.0 - 2.0 * g);
  transformed = growCenter + (transformed - growCenter) * g;`
      )
  }
  mat.customProgramCacheKey = () => `grow-${center.toArray().join(',')}`
  return mat
}

export class Renewal {
  readonly group = new THREE.Group()
  private grow = { value: 0 }
  private level = -1

  constructor(
    spec: WorldSpec,
    terrain: Terrain,
    colliders: Colliders,
    heart: THREE.Vector3,
    flora: THREE.Group,
    rng: Rng,
    quality: number
  ) {
    this.group.name = 'renewal'
    this.buildBloom(spec, terrain, colliders, heart, rng, quality)
    this.buildCanopies(spec, flora)
  }

  private buildBloom(
    spec: WorldSpec,
    terrain: Terrain,
    colliders: Colliders,
    heart: THREE.Vector3,
    rng: Rng,
    quality: number
  ): void {
    const geo = merge([
      part(new THREE.CylinderGeometry(0.03, 0.04, 0.6, 3), '#4f7a3a', xf(0, 0.3, 0)),
      part(new THREE.IcosahedronGeometry(0.16, 0), '#ffffff', xf(0, 0.66, 0)),
      part(new THREE.ConeGeometry(0.12, 0.25, 3), '#5f9a46', xf(0.08, 0.15, 0, 0, 0, -0.6))
    ])
    const mat = growable(
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      this.grow,
      new THREE.Vector3(0, 0, 0)
    )
    const count = Math.floor(900 * Math.max(0.4, quality))
    const mesh = new THREE.InstancedMesh(geo, mat, count)
    const hues = [spec.palette.accent, '#ffd35a', '#ffffff', '#ff9fd0', '#b58cff', '#9fd4ff']
    const dummy = new THREE.Object3D()
    let n = 0
    for (let t = 0; t < count * 5 && n < count; t++) {
      const a = rng.range(0, Math.PI * 2)
      // Denser near the heart, thinning out with distance.
      const d = 16 + Math.pow(rng.next(), 1.6) * 150
      const x = heart.x + Math.cos(a) * d
      const z = heart.z + Math.sin(a) * d
      if (!terrain.isDry(x, z, 0.6) || terrain.slopeAt(x, z) > 0.9) continue
      if (colliders.occupied(x, z, 0.4) || terrain.platformAt(x, z) > -Infinity) continue
      if (terrain.rivers.near(x, z, 1.1)) continue
      dummy.position.set(x, terrain.groundAt(x, z) - 0.05, z)
      dummy.rotation.set(0, rng.range(0, Math.PI * 2), 0)
      dummy.scale.setScalar(rng.range(0.8, 1.5))
      dummy.updateMatrix()
      mesh.setMatrixAt(n, dummy.matrix)
      mesh.setColorAt(n, new THREE.Color(rng.pick(hues)))
      n++
    }
    mesh.count = n
    mesh.computeBoundingSphere()
    mesh.frustumCulled = false
    mesh.name = 'renewal-bloom'
    this.group.add(mesh)
  }

  /** A crown of leaves for every dead tree, sharing its instance transforms. */
  private buildCanopies(spec: WorldSpec, flora: THREE.Group): void {
    const leaves = new THREE.Color(spec.palette.foliage).lerp(
      new THREE.Color('#5fae4a'),
      spec.biome === 'volcanic' ? 0.6 : 0.3
    )
    const geo = merge([
      part(jitter(new THREE.IcosahedronGeometry(1.5, 0), 0.15, 21), leaves, xf(0.4, 4.4, 0)),
      part(
        jitter(new THREE.IcosahedronGeometry(1.1, 0), 0.15, 22),
        leaves.clone().multiplyScalar(1.15),
        xf(-0.7, 4.0, 0.3)
      ),
      part(
        jitter(new THREE.IcosahedronGeometry(0.9, 0), 0.15, 23),
        leaves.clone().multiplyScalar(0.9),
        xf(0.1, 5.0, -0.5)
      )
    ])
    const mat = growable(
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      this.grow,
      new THREE.Vector3(0, 4.2, 0)
    )
    const m = new THREE.Matrix4()
    for (const child of flora.children) {
      if (!(child instanceof THREE.InstancedMesh) || !child.name.startsWith('flora-deadtree'))
        continue
      const canopy = new THREE.InstancedMesh(geo, mat, child.count)
      for (let i = 0; i < child.count; i++) {
        child.getMatrixAt(i, m)
        canopy.setMatrixAt(i, m)
      }
      canopy.castShadow = child.castShadow
      canopy.computeBoundingSphere()
      canopy.name = 'renewal-canopy'
      this.group.add(canopy)
    }
  }

  /** r: 0..1 restoration. */
  update(r: number): void {
    const g = THREE.MathUtils.clamp(r, 0, 1)
    if (Math.abs(g - this.level) < 1e-3) return
    this.level = g
    this.grow.value = g
    this.group.visible = g > 0.001
  }
}
