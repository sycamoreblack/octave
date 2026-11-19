import * as THREE from 'three'

/**
 * Aerial perspective for every fogged material, by replacing three.js's fog shader chunks:
 *
 *  - Height fog: density falls off exponentially with altitude, so mist pools in valleys and
 *    over water while peaks stand clear. The average density along each view ray has a
 *    closed form, so this costs a handful of ALU ops per pixel and no extra passes.
 *  - Sun in-scattering: fog looking toward the sun (or moon) takes on its colour, which is
 *    what gives dusk haze its glow.
 *
 * The extra uniforms are plain objects (not three.js Vector/Color instances), so when three
 * clones a material's uniforms they stay shared by reference. One update per frame reaches
 * every material that uses fog, built-in or custom.
 */

export const atmosphere = {
  /** Unit direction toward the sun or moon. */
  sunDir: { x: 0, y: 1, z: 0 },
  /** In-scatter colour (linear RGB in x/y/z). */
  sunColor: { x: 1, y: 0.9, z: 0.7 },
  /**
   * x: height falloff (1/m), y: reference height (density there = fogDensity),
   * z: how strongly height shapes the fog (0..1), w: in-scatter strength (0..1).
   */
  params: { x: 0.02, y: 0, z: 0.65, w: 0.6 }
}

const pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif
`

const vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // World position from view space: world = R^T (view - t), with R, t from the view matrix.
  vFogWorld = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
#endif
`

const pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform vec3 fogSunDir;
  uniform vec3 fogSunColor;
  uniform vec4 fogParams;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
`

const fragment = /* glsl */ `
#ifdef USE_FOG
  vec3 fogRay = vFogWorld - cameraPosition;
  float fogDist = max( length( fogRay ), 1e-3 );
  // Mean of exp(-k h) along the ray from the camera, relative to the reference height.
  float fogK = fogParams.x * fogRay.y;
  float fogAlong = abs( fogK ) > 1e-3 ? ( 1.0 - exp( - fogK ) ) / fogK : 1.0;
  float fogHeight = clamp( exp( - fogParams.x * ( cameraPosition.y - fogParams.y ) ) * fogAlong, 0.0, 3.5 );
  float fogShape = mix( 1.0, fogHeight, fogParams.z );
  #ifdef FOG_EXP2
    float fogD = fogDensity * fogShape;
    float fogFactor = 1.0 - exp( - fogD * fogD * fogDist * fogDist );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth ) * clamp( fogShape, 0.0, 1.0 );
  #endif
  float fogSun = pow( max( dot( fogRay / fogDist, fogSunDir ), 0.0 ), 8.0 );
  vec3 fogTint = mix( fogColor, fogSunColor, fogSun * fogParams.w );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTint, fogFactor );
#endif
`

let installed = false

/** Swap in the atmospheric fog. Call once, before any material is compiled. */
export function installAtmosphere(): void {
  if (installed) return
  installed = true
  THREE.ShaderChunk.fog_pars_vertex = pars_vertex
  THREE.ShaderChunk.fog_vertex = vertex
  THREE.ShaderChunk.fog_pars_fragment = pars_fragment
  THREE.ShaderChunk.fog_fragment = fragment
  const extra = {
    fogSunDir: { value: atmosphere.sunDir },
    fogSunColor: { value: atmosphere.sunColor },
    fogParams: { value: atmosphere.params }
  }
  // Custom ShaderMaterials clone UniformsLib.fog; built-ins clone their ShaderLib entry.
  Object.assign(THREE.UniformsLib.fog, extra)
  for (const shader of Object.values(THREE.ShaderLib)) {
    if (shader.uniforms && 'fogColor' in shader.uniforms) Object.assign(shader.uniforms, extra)
  }
}

/** Per-frame update from the world's light and terrain. */
export function setAtmosphere(opts: {
  sunDir: THREE.Vector3
  sunColor: THREE.Color
  /** 0..1 how bright the in-scatter is (dimmer at night). */
  glow: number
  /** Height (m) where fog density equals the scene's fogDensity. */
  referenceHeight: number
  /** Vertical scale of the land (m): falloff is relative to it. */
  relief: number
  /** 0..1 how much fog hugs the ground (swamps more, open sky less). */
  heightAmount: number
}): void {
  atmosphere.sunDir.x = opts.sunDir.x
  atmosphere.sunDir.y = opts.sunDir.y
  atmosphere.sunDir.z = opts.sunDir.z
  atmosphere.sunColor.x = opts.sunColor.r
  atmosphere.sunColor.y = opts.sunColor.g
  atmosphere.sunColor.z = opts.sunColor.b
  atmosphere.params.x = 2.2 / Math.max(20, opts.relief)
  atmosphere.params.y = opts.referenceHeight
  atmosphere.params.z = opts.heightAmount
  atmosphere.params.w = opts.glow
}
