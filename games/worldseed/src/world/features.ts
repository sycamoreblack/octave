import * as THREE from 'three'
import { Rng } from '../engine/rng'
import { jitter, merge, part, xf } from '../engine/geo'
import { LAND_RADIUS, Terrain } from './terrain'
import type { WorldSpec } from './spec'

/** River water ribbons and floating isles: the larger shapes a description can ask for. */

const riverVert = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`

const riverFrag = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uSky;
uniform int uKind; // 0 water, 1 lava, 2 ice, 3 murk
uniform float uRenew;
varying vec2 vUv;
varying vec3 vWorld;
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float across = abs(vUv.y - 0.5) * 2.0;
  float edge = 1.0 - smoothstep(0.7, 1.0, across);
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - max(V.y, 0.0), 3.0);
  vec3 col;
  float alpha = 0.85 * edge;
  if (uKind == 1) {
    vec2 q = vec2(vUv.x * 0.6 - uTime * 0.25, vUv.y * 3.0);
    float n = vn(q * 2.0) * 0.6 + vn(q * 5.0) * 0.4;
    float heat = smoothstep(0.35, 0.8, n) * (1.0 - 0.9 * uRenew);
    col = mix(vec3(0.12, 0.08, 0.07), uColor * 2.2, heat);
    alpha = edge;
  } else if (uKind == 2) {
    float n = vn(vec2(vUv.x * 0.8, vUv.y * 4.0));
    col = mix(uColor * 0.9, vec3(0.95, 0.97, 1.0), n * 0.5);
    col = mix(col, uSky, fres * 0.3);
    alpha = edge;
  } else {
    // Ripples streaming downstream, brighter in the middle where it runs fastest.
    vec2 q = vec2(vUv.x * 1.2 - uTime * 0.9, vUv.y * 6.0);
    float n = vn(q) * 0.6 + vn(q * 2.7 + 3.1) * 0.4;
    vec3 base = uKind == 3 ? mix(uColor * 0.8, uColor * 1.3 + vec3(0.02, 0.06, 0.08), uRenew) : uColor;
    col = mix(base * 0.7, base * 1.25, n);
    col = mix(col, uSky, 0.2 + fres * 0.45);
    float streak = smoothstep(0.72, 0.95, n) * (1.0 - across);
    col += vec3(0.25) * streak;
  }
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`

export interface RiverRig {
  mesh: THREE.Mesh
  uniforms: Record<string, THREE.IUniform>
}

/** One ribbon per river, laid on its water surface until it meets the sea. */
export function buildRivers(spec: WorldSpec, terrain: Terrain): RiverRig | null {
  if (terrain.riversDry || !terrain.rivers.rivers.length) return null
  const pos: number[] = []
  const uv: number[] = []
  const index: number[] = []
  for (const pts of terrain.rivers.rivers) {
    const base = pos.length / 3
    let n = 0
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      if (p.surface < terrain.liquidY - 0.3 && i > 0) break
      const a = pts[Math.max(0, i - 1)]
      const b = pts[Math.min(pts.length - 1, i + 1)]
      let dx = b.x - a.x
      let dz = b.z - a.z
      const len = Math.hypot(dx, dz) || 1
      dx /= len
      dz /= len
      const w = p.width * 1.6
      const y = p.surface - 0.3
      pos.push(p.x - dz * w, y, p.z + dx * w, p.x + dz * w, y, p.z - dx * w)
      uv.push(p.along / 10, 0, p.along / 10, 1)
      n++
    }
    for (let i = 0; i < n - 1; i++) {
      const v = base + i * 2
      index.push(v, v + 2, v + 1, v + 1, v + 2, v + 3)
    }
  }
  if (!index.length) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(index)
  geo.computeBoundingSphere()
  const kind = { water: 0, lava: 1, ice: 2, murk: 3 }[spec.liquid]
  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(spec.palette.liquid) },
    uSky: { value: new THREE.Color(spec.palette.skyHorizon) },
    uKind: { value: kind },
    uRenew: { value: 0 }
  }
  const mesh = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: riverVert,
      fragmentShader: riverFrag,
      fog: true,
      transparent: kind === 0 || kind === 3,
      depthWrite: kind === 1 || kind === 2,
      side: THREE.DoubleSide
    })
  )
  mesh.renderOrder = 2
  mesh.name = 'rivers'
  return { mesh, uniforms }
}

export interface IslesRig {
  group: THREE.Group
  update(t: number): void
}

/** Islands of rock and turf hanging in the sky, bobbing very slowly. */
export function buildFloatingIsles(
  spec: WorldSpec,
  terrain: Terrain,
  rng: Rng,
  quality: number
): IslesRig {
  const group = new THREE.Group()
  group.name = 'floating-isles'
  const rock = new THREE.Color(spec.palette.rock)
  const turf = new THREE.Color(spec.palette.groundMid)
  const leaves = new THREE.Color(spec.palette.foliage)
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.95
  })
  const isles: { mesh: THREE.Mesh; baseY: number; phase: number }[] = []
  const count = Math.round(7 + 6 * quality)
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, Math.PI * 2)
    const d = Math.sqrt(rng.next()) * LAND_RADIUS * 1.05
    const x = Math.cos(a) * d
    const z = Math.sin(a) * d
    const r = rng.range(8, 22)
    const ground = Math.max(terrain.groundAt(x, z), terrain.liquidY)
    const y = ground + rng.range(40, 95)
    const parts = [
      part(
        jitter(new THREE.ConeGeometry(r, r * 1.6, 7, 3), 0.12, i),
        rock,
        xf(0, -r * 0.8, 0, Math.PI)
      ),
      part(
        jitter(new THREE.CylinderGeometry(r * 1.02, r * 0.95, 1.2, 7), 0.05, i + 50),
        turf,
        xf(0, 0.4, 0)
      )
    ]
    const trees = rng.int(0, 3)
    for (let k = 0; k < trees; k++) {
      const ta = rng.range(0, Math.PI * 2)
      const td = rng.range(0, r * 0.6)
      const s = rng.range(0.8, 1.6)
      parts.push(
        part(
          new THREE.CylinderGeometry(0.2 * s, 0.3 * s, 2.4 * s, 5),
          '#5b4636',
          xf(Math.cos(ta) * td, 1.2 * s + 0.9, Math.sin(ta) * td)
        ),
        part(
          jitter(new THREE.IcosahedronGeometry(1.6 * s, 0), 0.15, k + i * 7),
          leaves,
          xf(Math.cos(ta) * td, 3.4 * s + 0.9, Math.sin(ta) * td)
        )
      )
    }
    // Loose stones trailing beneath, as if the isle tore free.
    for (let k = 0; k < 3; k++)
      parts.push(
        part(
          jitter(new THREE.DodecahedronGeometry(rng.range(0.6, 1.6), 0), 0.2, k + 90 + i),
          rock,
          xf(rng.range(-r, r) * 0.4, -r * 1.9 - k * 3.5, rng.range(-r, r) * 0.4)
        )
      )
    const mesh = new THREE.Mesh(merge(parts), mat)
    mesh.position.set(x, y, z)
    mesh.rotation.y = rng.range(0, Math.PI * 2)
    mesh.castShadow = quality >= 0.6
    group.add(mesh)
    isles.push({ mesh, baseY: y, phase: rng.range(0, Math.PI * 2) })
  }
  return {
    group,
    update(t) {
      for (const isle of isles)
        isle.mesh.position.y = isle.baseY + Math.sin(t * 0.25 + isle.phase) * 1.6
    }
  }
}
