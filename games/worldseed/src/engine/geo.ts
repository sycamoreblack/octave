import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * Low-poly modelling helpers. Every part is converted to non-indexed geometry with a
 * per-vertex colour, so whole props merge into one draw call and shade flat.
 */

const m4 = new THREE.Matrix4()
const q = new THREE.Quaternion()
const e = new THREE.Euler()

export function xf(
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    q.setFromEuler(e.set(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz)
  )
}

export function part(
  geo: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  matrix?: THREE.Matrix4
): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo
  if (g === geo) g = geo.clone()
  if (matrix) g.applyMatrix4(matrix)
  // Keep only position + colour so any parts can merge; merge() recomputes normals.
  if (g.getAttribute('uv')) g.deleteAttribute('uv')
  if (g.getAttribute('normal')) g.deleteAttribute('normal')
  const n = g.getAttribute('position').count
  const c = new THREE.Color(color)
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r
    arr[i * 3 + 1] = c.g
    arr[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  geo.dispose()
  return g
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)
  if (!g) throw new Error('mergeGeometries failed')
  for (const p of parts) p.dispose()
  g.computeVertexNormals()
  g.computeBoundingSphere()
  g.computeBoundingBox()
  return g
}

/** Deterministically wobble vertices by position, so shared corners stay welded. */
export function jitter(geo: THREE.BufferGeometry, amount: number, seed = 1): THREE.BufferGeometry {
  const p = geo.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const z = p.getZ(i)
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453
    const f = (h - Math.floor(h)) * 2 - 1
    const h2 = Math.sin(x * 93.989 + y * 67.345 + z * 12.345 + seed * 2) * 24634.6345
    const f2 = (h2 - Math.floor(h2)) * 2 - 1
    p.setXYZ(i, x * (1 + f * amount), y * (1 + f2 * amount * 0.6), z * (1 + f2 * amount))
  }
  p.needsUpdate = true
  return geo
}

export const tmpMatrix = m4
