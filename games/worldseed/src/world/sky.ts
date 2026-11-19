import * as THREE from 'three'
import { Rng } from '../engine/rng'
import type { WorldSpec } from './spec'

export interface SkyRig {
  mesh: THREE.Mesh
  uniforms: Record<string, THREE.IUniform>
  sunDir: THREE.Vector3
  /** Direction of the main light: the sun by day, the brightest moon at night. */
  lightDir: THREE.Vector3
  night: number
  update(t: number, camera: THREE.Camera): void
  /** Move the sun (and the main light) to a new time of day. */
  setTime(time: number): void
}

/** The sun's direction for a time of day in [0, 1). 0.5 = noon, 0.25 = sunrise in the east. */
export function sunDirection(time: number, azimuth: number): THREE.Vector3 {
  const angle = (time - 0.25) * Math.PI * 2
  const elevation = Math.sin(angle)
  const horizontal = Math.cos(angle)
  // Tilt the arc so the sun never stands straight overhead: longer shadows, nicer light.
  return new THREE.Vector3(
    horizontal * Math.cos(azimuth),
    elevation * 0.85 + 0.03,
    horizontal * Math.sin(azimuth)
  ).normalize()
}

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`

const frag = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSunSize;
uniform float uNight;
uniform float uTime;
uniform vec3 uMoonDir[3];
uniform int uMoons;
uniform vec3 uMoonColor;
uniform float uAurora;
uniform vec3 uAuroraA;
uniform vec3 uAuroraB;
uniform float uFlash;
varying vec3 vDir;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1, 0)), f.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 col = mix(uHorizon, uTop, pow(max(y, 0.0), 0.55));
  col = mix(col, uGround, smoothstep(0.0, -0.25, y));

  // Sun: disc + halo, and a warm wash along the horizon on its side.
  float sd = max(dot(d, uSunDir), 0.0);
  float sunVisible = smoothstep(-0.08, 0.02, uSunDir.y);
  col += uSunColor * pow(sd, 6.0) * 0.35 * sunVisible;
  col += uSunColor * pow(sd, 90.0) * 0.6 * sunVisible;
  col += uSunColor * smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.6, sd) * 4.0 * sunVisible;

  // Stars.
  if (uNight > 0.01 && y > 0.0) {
    vec3 cell = floor(d * 180.0);
    float h = hash(cell);
    float star = step(0.9965, h) * (0.6 + 0.4 * sin(uTime * (1.0 + h * 4.0) + h * 40.0));
    vec3 local = fract(d * 180.0) - 0.5;
    star *= smoothstep(0.45, 0.0, length(local));
    col += vec3(star) * uNight * smoothstep(0.0, 0.25, y) * 1.4;
    // A faint band of galaxy.
    float band = exp(-pow(dot(d, normalize(vec3(0.4, 0.2, 1.0))) * 4.0, 2.0));
    col += vec3(0.25, 0.22, 0.35) * band * vnoise(d.xz * 30.0) * uNight * 0.25;
  }

  // Moons, with a soft terminator for phase.
  for (int i = 0; i < 3; i++) {
    if (i >= uMoons) break;
    vec3 md = uMoonDir[i];
    float size = 0.9993 - float(i) * 0.0003;
    float m = smoothstep(size, size + 0.0002, dot(d, md));
    vec3 side = normalize(cross(md, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 0.3, 0.0));
    float phase = smoothstep(-0.02, 0.03, dot(d - md, side) + 0.012 * float(i + 1) - 0.01);
    float glow = pow(max(dot(d, md), 0.0), 400.0) * 0.4;
    vec3 tint = mix(uMoonColor, vec3(1.0, 0.85, 0.75), float(i) * 0.4);
    col = mix(col, tint * (0.35 + 0.75 * phase), m);
    col += tint * glow * (0.3 + uNight);
  }

  // Aurora curtains.
  if (uAurora > 0.0 && y > 0.05) {
    vec2 p = d.xz / (y + 0.25);
    float n = vnoise(p * 2.0 + vec2(uTime * 0.05, 0.0)) * 0.6 + vnoise(p * 5.0 - vec2(0.0, uTime * 0.08)) * 0.4;
    float curtain = smoothstep(0.45, 0.85, n) * smoothstep(0.05, 0.3, y) * smoothstep(0.9, 0.4, y);
    col += mix(uAuroraA, uAuroraB, vnoise(p * 1.3)) * curtain * uAurora * 0.8;
  }

  col += vec3(0.8, 0.85, 1.0) * uFlash;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

export function buildSky(spec: WorldSpec, rng: Rng): SkyRig {
  const azimuth = rng.range(0, Math.PI * 2)
  const sunDir = sunDirection(spec.timeOfDay, azimuth)
  const moonDirs = [0, 1, 2].map((i) =>
    new THREE.Vector3().setFromSphericalCoords(
      1,
      rng.range(0.6, 1.25) - i * 0.1,
      azimuth + Math.PI + rng.range(-0.9, 0.9) + i * 0.5
    )
  )
  for (const m of moonDirs) {
    if (m.y < 0.15) m.y = 0.15
    m.normalize()
  }
  const night = THREE.MathUtils.smoothstep(-sunDir.y, -0.05, 0.25)

  const uniforms: Record<string, THREE.IUniform> = {
    uTop: { value: new THREE.Color(spec.palette.skyTop) },
    uHorizon: { value: new THREE.Color(spec.palette.skyHorizon) },
    uGround: { value: new THREE.Color(spec.palette.skyHorizon).multiplyScalar(0.6) },
    uSunColor: { value: new THREE.Color(spec.palette.sun) },
    uSunDir: { value: sunDir },
    uSunSize: { value: 0.0009 },
    uNight: { value: night },
    uTime: { value: 0 },
    uMoonDir: { value: moonDirs },
    uMoons: { value: spec.moons },
    uMoonColor: { value: new THREE.Color('#e9ecff') },
    uAurora: { value: spec.aurora ? 1 : 0 },
    uAuroraA: { value: new THREE.Color('#3dffa8') },
    uAuroraB: { value: new THREE.Color(spec.palette.accent).lerp(new THREE.Color('#8a5cff'), 0.5) },
    uFlash: { value: 0 }
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat)
  mesh.scale.setScalar(4000)
  mesh.renderOrder = -10
  mesh.frustumCulled = false
  mesh.name = 'sky'

  const lightDir =
    night > 0.5 && spec.moons > 0
      ? moonDirs[0].clone()
      : sunDir.y > -0.05
        ? sunDir.clone()
        : new THREE.Vector3(0.3, 0.8, 0.2).normalize()

  const rig: SkyRig = {
    mesh,
    uniforms,
    sunDir,
    lightDir,
    night,
    update(t, camera) {
      uniforms.uTime.value = t
      mesh.position.copy(camera.position)
    },
    setTime(time) {
      rig.sunDir.copy(sunDirection(time, azimuth))
      rig.night = THREE.MathUtils.smoothstep(-rig.sunDir.y, -0.05, 0.25)
      // The light follows whichever of sun or moon is doing more of the lighting.
      if (rig.sunDir.y > 0.02 || spec.moons === 0)
        rig.lightDir.copy(
          rig.sunDir.y > -0.05 ? rig.sunDir : new THREE.Vector3(0.3, 0.8, 0.2).normalize()
        )
      else rig.lightDir.copy(moonDirs[0])
      uniforms.uSunDir.value = rig.sunDir
      uniforms.uNight.value = rig.night
    }
  }
  return rig
}
