import * as THREE from 'three'
import { Rng } from '../engine/rng'
import type { Weather, WorldSpec } from './spec'

/**
 * Weather particles live in a box that wraps around the player, all moved on the GPU,
 * so heavy rain costs the CPU nothing.
 */
interface Style {
  count: number
  box: [number, number, number]
  vel: [number, number, number]
  sway: number
  size: number
  color: string
  additive: boolean
  shape: 0 | 1 | 2 // 0 soft dot, 1 streak, 2 petal
  pulse: number
  yOffset: number
}

const STYLES: Partial<Record<Weather, Style>> = {
  rain: {
    count: 7000,
    box: [80, 50, 80],
    vel: [1.5, -32, 0.8],
    sway: 0,
    size: 1.6,
    color: '#b8c6d8',
    additive: false,
    shape: 1,
    pulse: 0,
    yOffset: 12
  },
  storm: {
    count: 11000,
    box: [80, 50, 80],
    vel: [7, -40, 3],
    sway: 0,
    size: 1.8,
    color: '#a9b6c8',
    additive: false,
    shape: 1,
    pulse: 0,
    yOffset: 12
  },
  snow: {
    count: 6000,
    box: [90, 50, 90],
    vel: [1.2, -2.6, 0.6],
    sway: 1.2,
    size: 1.2,
    color: '#ffffff',
    additive: false,
    shape: 0,
    pulse: 0,
    yOffset: 12
  },
  ash: {
    count: 4000,
    box: [90, 50, 90],
    vel: [1.5, -1.4, 0.4],
    sway: 1.6,
    size: 1.1,
    color: '#8e8a88',
    additive: false,
    shape: 0,
    pulse: 0,
    yOffset: 12
  },
  fireflies: {
    count: 500,
    box: [110, 10, 110],
    vel: [0, 0, 0],
    sway: 1.8,
    size: 1.5,
    color: '#fff38a',
    additive: true,
    shape: 0,
    pulse: 1,
    yOffset: 2.5
  },
  spores: {
    count: 1600,
    box: [100, 40, 100],
    vel: [0.3, 0.9, 0.2],
    sway: 1.4,
    size: 1.4,
    color: '#ffffff',
    additive: true,
    shape: 0,
    pulse: 0.6,
    yOffset: 8
  },
  petals: {
    count: 1300,
    box: [90, 40, 90],
    vel: [2.4, -1.3, 1.1],
    sway: 2.2,
    size: 1.6,
    color: '#ffc2d6',
    additive: false,
    shape: 2,
    pulse: 0,
    yOffset: 10
  },
  fog: {
    count: 300,
    box: [140, 14, 140],
    vel: [0.6, 0, 0.2],
    sway: 0.5,
    size: 60,
    color: '#ffffff',
    additive: false,
    shape: 0,
    pulse: 0,
    yOffset: 3
  }
}

const vert = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform vec3 uCenter;
uniform vec3 uBox;
uniform vec3 uVel;
uniform float uSway;
uniform float uSize;
uniform float uPixelRatio;
uniform float uPulse;
varying float vAlpha;
varying float vSeed;
void main() {
  vec3 p = position + uVel * uTime;
  p.x += sin(uTime * 0.7 + aSeed * 6.283) * uSway;
  p.z += cos(uTime * 0.53 + aSeed * 12.7) * uSway;
  p.y += sin(uTime * 0.9 + aSeed * 3.1) * uSway * 0.3;
  p = mod(p - uCenter + uBox * 0.5, uBox) - uBox * 0.5 + uCenter;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelRatio * (260.0 / max(-mv.z, 1.0));
  float edge = 1.0 - smoothstep(0.32, 0.5, max(abs(p.x - uCenter.x) / uBox.x, abs(p.z - uCenter.z) / uBox.z));
  float flicker = mix(1.0, 0.5 + 0.5 * sin(uTime * (1.5 + aSeed * 2.0) + aSeed * 40.0), uPulse);
  vAlpha = edge * flicker;
  vSeed = aSeed;
}`

const frag = /* glsl */ `
uniform vec3 uColor;
uniform int uShape;
uniform float uOpacity;
varying float vAlpha;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a;
  if (uShape == 1) {
    a = smoothstep(0.09, 0.0, abs(c.x)) * smoothstep(0.5, 0.1, abs(c.y));
  } else if (uShape == 2) {
    float r = vSeed * 6.283;
    vec2 q = mat2(cos(r), -sin(r), sin(r), cos(r)) * c;
    a = smoothstep(0.5, 0.35, length(q * vec2(1.0, 2.2)));
  } else {
    a = smoothstep(0.5, 0.0, length(c));
  }
  if (a * vAlpha < 0.01) discard;
  gl_FragColor = vec4(uColor, a * vAlpha * uOpacity);
}`

export interface WeatherRig {
  points: THREE.Points
  uniforms: Record<string, THREE.IUniform>
  kind: Weather
  update(t: number, center: THREE.Vector3): void
}

export function buildWeather(spec: WorldSpec, rng: Rng, quality: number): WeatherRig | null {
  const style = STYLES[spec.weather]
  if (!style) return null
  const count = Math.floor(style.count * (style.size > 20 ? 1 : quality))
  const pos = new Float32Array(count * 3)
  const seed = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rng.range(-1, 1) * style.box[0]
    pos[i * 3 + 1] = rng.range(-1, 1) * style.box[1]
    pos[i * 3 + 2] = rng.range(-1, 1) * style.box[2]
    seed[i] = rng.next()
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  let color = style.color
  if (spec.weather === 'spores' || spec.weather === 'fireflies') {
    color = spec.weather === 'spores' ? spec.palette.accent : style.color
  }
  if (spec.weather === 'petals')
    color = new THREE.Color(spec.palette.foliageAlt)
      .lerp(new THREE.Color('#ffd0e0'), 0.6)
      .getStyle()
  if (spec.weather === 'fog') color = spec.palette.skyHorizon
  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uBox: { value: new THREE.Vector3(...style.box) },
    uVel: { value: new THREE.Vector3(...style.vel) },
    uSway: { value: style.sway },
    uSize: { value: style.size },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    uPulse: { value: style.pulse },
    uColor: { value: new THREE.Color(color) },
    uShape: { value: style.shape },
    uOpacity: {
      value:
        spec.weather === 'fog'
          ? 0.07
          : spec.weather === 'rain' || spec.weather === 'storm'
            ? 0.55
            : 0.9
    }
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending: style.additive ? THREE.AdditiveBlending : THREE.NormalBlending
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = 5
  points.name = 'weather'
  return {
    points,
    uniforms,
    kind: spec.weather,
    update(t, center) {
      uniforms.uTime.value = t
      ;(uniforms.uCenter.value as THREE.Vector3).set(center.x, center.y + style.yOffset, center.z)
    }
  }
}
