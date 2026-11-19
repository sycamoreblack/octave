import * as THREE from 'three'
import { HALF, Terrain } from './terrain'
import type { WorldSpec } from './spec'

/**
 * One big plane for the sea / lakes / lava / ice. It samples the terrain heightmap so
 * shallows are clear, shorelines get foam, and depth darkens the colour.
 */
const vert = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`

const frag = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uHeight;
uniform float uHalf;
uniform float uLevel;
uniform float uTime;
uniform int uKind; // 0 water, 1 lava, 2 ice, 3 murk
uniform vec3 uColor;
uniform vec3 uSky;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSunPower;
uniform float uRenew;
varying vec3 vWorld;

float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { return vn(p) * 0.55 + vn(p * 2.1) * 0.3 + vn(p * 4.3) * 0.15; }

void main() {
  vec2 uv = (vWorld.xz + uHalf) / (2.0 * uHalf);
  float ground = texture2D(uHeight, clamp(uv, 0.0, 1.0)).r;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) ground = uLevel - 60.0;
  float depth = uLevel - ground;
  if (depth < -0.3) discard;
  vec3 V = normalize(cameraPosition - vWorld);
  vec2 p = vWorld.xz;
  vec3 col;
  float alpha = 1.0;

  if (uKind == 1) {
    // Lava: a cooled crust with glowing cracks that slowly flow.
    vec2 flow = vec2(uTime * 0.6, uTime * 0.25);
    float n = fbm(p * 0.05 + flow * 0.02);
    float cracks = smoothstep(0.06, 0.0, abs(fbm(p * 0.09 - flow * 0.03) - 0.5));
    vec3 crust = vec3(0.08, 0.05, 0.05) + vec3(0.06, 0.03, 0.02) * n;
    // Restored: the lava cools to dark glassy stone with only a faint glow in the cracks.
    crust = mix(crust, vec3(0.16, 0.14, 0.15) + vec3(0.05) * n, uRenew);
    vec3 glow = mix(uColor, vec3(1.0, 0.85, 0.3), n);
    float heat = (cracks * 0.85 + smoothstep(1.5, 0.0, depth) * 0.4) * (1.0 - 0.9 * uRenew);
    col = mix(crust, glow * 2.2, heat);
  } else if (uKind == 2) {
    // Ice: pale, slightly glossy, with cracks and snow drift.
    float n = fbm(p * 0.04);
    float crack = smoothstep(0.02, 0.0, abs(vn(p * 0.15) - 0.5));
    col = mix(uColor * 0.85, vec3(0.95, 0.97, 1.0), n * 0.6);
    col = mix(col, uColor * 0.55, crack * 0.6);
    float fres = pow(1.0 - max(V.y, 0.0), 4.0);
    col = mix(col, uSky, fres * 0.35);
    col += uSunColor * pow(max(dot(reflect(-uSunDir, vec3(0, 1, 0)), V), 0.0), 60.0) * 0.5 * uSunPower;
  } else {
    float t = uTime;
    float e = 0.6;
    vec2 q = p * 0.09;
    float a = vn(q + vec2(t * 0.12, t * 0.07)) + vn(q * 2.3 - vec2(t * 0.08, -t * 0.11)) * 0.5;
    float bx = vn(q + vec2(e, 0) + vec2(t * 0.12, t * 0.07)) + vn((q + vec2(e, 0)) * 2.3 - vec2(t * 0.08, -t * 0.11)) * 0.5;
    float bz = vn(q + vec2(0, e) + vec2(t * 0.12, t * 0.07)) + vn((q + vec2(0, e)) * 2.3 - vec2(t * 0.08, -t * 0.11)) * 0.5;
    float calm = uKind == 3 ? 0.25 : 1.0;
    vec3 N = normalize(vec3((a - bx) * 0.9 * calm, 1.0, (a - bz) * 0.9 * calm));
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
    // Restored murk clears toward fresh water.
    vec3 base = uKind == 3 ? mix(uColor, uColor * 1.4 + vec3(0.02, 0.07, 0.09), uRenew) : uColor;
    vec3 deep = base * (uKind == 3 ? 0.45 : 0.35);
    vec3 shallow = mix(base * 1.3, vec3(0.9, 0.95, 0.9), uKind == 3 ? 0.0 : 0.15);
    col = mix(shallow, deep, smoothstep(0.0, 14.0, depth));
    col = mix(col, uSky, 0.15 + fres * 0.55);
    float spec = pow(max(dot(reflect(-uSunDir, N), V), 0.0), 180.0);
    col += uSunColor * spec * 2.5 * uSunPower;
    // Shore foam, broken up by noise and pulsing gently.
    float foamBand = smoothstep(1.4, 0.0, depth) * step(0.0, depth);
    float foam = foamBand * smoothstep(0.35, 0.75, vn(p * 0.6 + t * 0.4) * 0.6 + 0.4 * sin(depth * 6.0 - t * 2.0));
    col = mix(col, vec3(0.95), foam * (uKind == 3 ? 0.25 : 0.8));
    alpha = mix(0.55, 0.96, smoothstep(0.0, 6.0, depth));
    alpha = max(alpha, foam);
  }
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`

export interface LiquidRig {
  mesh: THREE.Mesh
  uniforms: Record<string, THREE.IUniform>
}

export function buildLiquid(
  spec: WorldSpec,
  terrain: Terrain,
  sunDir: THREE.Vector3,
  sunPower: number
): LiquidRig {
  const kind = { water: 0, lava: 1, ice: 2, murk: 3 }[spec.liquid]
  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uHeight: { value: terrain.heightTexture() },
    uHalf: { value: HALF },
    uLevel: { value: terrain.liquidY },
    uTime: { value: 0 },
    uKind: { value: kind },
    uColor: { value: new THREE.Color(spec.palette.liquid) },
    uSky: { value: new THREE.Color(spec.palette.skyHorizon) },
    uSunColor: { value: new THREE.Color(spec.palette.sun) },
    uSunDir: { value: sunDir.clone() },
    uSunPower: { value: sunPower },
    uRenew: { value: 0 }
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    fog: true,
    transparent: kind === 0 || kind === 3,
    depthWrite: kind === 1 || kind === 2
  })
  const geo = new THREE.PlaneGeometry(9000, 9000, 1, 1)
  geo.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.y = terrain.liquidY
  mesh.receiveShadow = false
  mesh.renderOrder = 1
  mesh.name = 'liquid'
  return { mesh, uniforms }
}
