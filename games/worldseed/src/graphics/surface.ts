import * as THREE from 'three'

/**
 * Procedural surface detail for the terrain, computed per pixel in world space. No textures:
 *  - fine speckle and soft patches break up the flat colour of each facet,
 *  - faint horizontal strata show on steep faces (rock layers),
 *  - it all fades out with distance so far hills stay calm and don't shimmer.
 * The low-poly facets themselves are kept: this only varies the colour within them.
 */
export function addGroundDetail(
  mat: THREE.MeshStandardMaterial,
  strength = 1
): THREE.MeshStandardMaterial {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: strength }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
  vGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uDetail;
varying vec3 vGroundPos;
float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y);
}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  {
    vec2 gp = vGroundPos.xz;
    float near = 1.0 - smoothstep(60.0, 220.0, distance(vGroundPos, cameraPosition));
    float speck = gNoise(gp * 1.9) * 0.6 + gNoise(gp * 5.3) * 0.4;
    float blotch = gNoise(gp * 0.11) * 0.65 + gNoise(gp * 0.37) * 0.35;
    // Facet normal from screen-space derivatives (the mesh is flat-shaded anyway).
    vec3 fn = normalize(cross(dFdx(vGroundPos), dFdy(vGroundPos)));
    float steep = smoothstep(0.45, 0.9, 1.0 - abs(fn.y));
    float strata = 0.5 + 0.5 * sin(vGroundPos.y * 1.7 + gNoise(gp * 0.2) * 3.0);
    float shade = 1.0
      + (speck - 0.5) * 0.26 * near
      + (blotch - 0.5) * 0.28
      - steep * strata * 0.2 * near;
    diffuseColor.rgb *= mix(1.0, shade, uDetail);
  }`
      )
  }
  mat.customProgramCacheKey = () => `ground-detail-${strength}`
  return mat
}
