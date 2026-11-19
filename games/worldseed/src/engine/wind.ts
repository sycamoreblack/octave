import * as THREE from 'three'

/** Uniforms shared by every swaying material, ticked once per frame. */
export const windUniforms = {
  uTime: { value: 0 },
  uWind: { value: 1 }
}

/**
 * Patch a built-in material so instanced foliage sways. Sway grows with height above the
 * instance origin, and each instance gets its own phase from its world position.
 */
export function addWind<T extends THREE.Material>(mat: T, strength: number): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime
    shader.uniforms.uWind = windUniforms.uWind
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform float uWind;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
  vec3 ip = vec3(0.0);
#endif
  float hgt = max(transformed.y, 0.0);
  float phase = ip.x * 0.07 + ip.z * 0.05;
  float gust = 0.6 + 0.4 * sin(uTime * 0.35 + ip.x * 0.004);
  float sway = (sin(uTime * 1.6 + phase) * 0.7 + sin(uTime * 2.9 + phase * 1.7) * 0.3) * gust;
  float amt = ${strength.toFixed(4)} * uWind * hgt * hgt;
  transformed.x += sway * amt;
  transformed.z += sway * amt * 0.6;`
      )
  }
  mat.customProgramCacheKey = () => `wind-${strength}`
  return mat
}
