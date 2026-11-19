import * as THREE from 'three'

/**
 * A shard floating over its landmark, with a pillar of light that is visible from
 * anywhere in the world (it ignores fog) so players can always navigate by it.
 */
const beamVert = /* glsl */ `
varying float vH;
varying vec3 vN;
varying vec3 vView;
void main() {
  vH = uv.y;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vView = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`
const beamFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uStrength;
varying float vH;
varying vec3 vN;
varying vec3 vView;
void main() {
  float edge = pow(1.0 - abs(dot(normalize(vN.xz), normalize(vView.xz))), 1.5);
  float core = 1.0 - edge;
  float fade = smoothstep(1.0, 0.25, vH) * smoothstep(0.0, 0.02, vH);
  float ripple = 0.75 + 0.25 * sin(vH * 60.0 - uTime * 3.0);
  float a = (core * 0.8 + 0.2) * fade * ripple * uStrength;
  gl_FragColor = vec4(uColor * (0.7 + core * 0.6), a);
}`

export class Beacon {
  readonly group = new THREE.Group()
  readonly gem: THREE.Mesh
  private beam: THREE.Mesh
  private ring: THREE.Mesh
  private light: THREE.PointLight
  private uniforms: Record<string, THREE.IUniform>
  strength = 1
  private targetStrength = 1
  baseY: number

  constructor(color: string, position: THREE.Vector3, height = 220, withGem = true) {
    this.baseY = position.y
    this.group.position.copy(position)
    this.uniforms = {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uStrength: { value: 1 }
    }
    const beamGeo = new THREE.CylinderGeometry(1.6, 2.4, height, 16, 1, true)
    beamGeo.translate(0, height / 2, 0)
    this.beam = new THREE.Mesh(
      beamGeo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: beamVert,
        fragmentShader: beamFrag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false
      })
    )
    this.beam.renderOrder = 10
    this.beam.frustumCulled = false
    this.group.add(this.beam)

    this.gem = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.7, 0),
      new THREE.MeshStandardMaterial({
        color,
        emissive: new THREE.Color(color),
        emissiveIntensity: 1.3,
        roughness: 0.2,
        flatShading: true
      })
    )
    this.gem.scale.set(1, 1.6, 1)
    this.gem.visible = withGem
    this.group.add(this.gem)

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(1.4, 2.2, 32),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    )
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = -1.0
    this.ring.visible = withGem
    this.group.add(this.ring)

    this.light = new THREE.PointLight(color, 25, 22, 1.8)
    this.light.position.y = 0.5
    this.group.add(this.light)
  }

  fade(to: number): void {
    this.targetStrength = to
  }

  update(t: number, dt: number): void {
    this.strength += (this.targetStrength - this.strength) * (1 - Math.exp(-dt * 2))
    this.uniforms.uTime.value = t
    this.uniforms.uStrength.value = this.strength
    this.gem.rotation.y = t * 1.2
    this.gem.position.y = Math.sin(t * 1.6) * 0.25
    this.ring.scale.setScalar(1 + 0.15 * Math.sin(t * 2))
    ;(this.ring.material as THREE.MeshBasicMaterial).opacity = 0.45 * this.strength
    this.light.intensity = 25 * this.strength
    this.group.visible = this.strength > 0.01
  }
}
