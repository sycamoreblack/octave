import * as THREE from 'three'

/**
 * Image-based lighting from the procedural sky. The sky dome (sharing the live sky
 * material, so it always matches) is captured into a prefiltered environment map that
 * every MeshStandardMaterial uses for ambient light and soft reflections. Surfaces then
 * pick up the real sky colour: warm on the sunward side at dusk, blue in shadow at noon,
 * green under an alien sky. This replaces a flat hemisphere fill.
 *
 * The capture is cheap but not free, so it runs only when the light has changed noticeably,
 * and never more often than every couple of seconds.
 */
export class SkyEnvironment {
  private pmrem: THREE.PMREMGenerator
  private envScene = new THREE.Scene()
  private target: THREE.WebGLRenderTarget | null = null
  private lastKey = ''
  private lastTime = -Infinity

  constructor(renderer: THREE.WebGLRenderer, skyMaterial: THREE.Material) {
    this.pmrem = new THREE.PMREMGenerator(renderer)
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMaterial)
    dome.scale.setScalar(50)
    dome.frustumCulled = false
    this.envScene.add(dome)
  }

  /**
   * Re-capture if `key` (a coarse fingerprint of time of day and restoration) changed and
   * enough time has passed. Returns the texture for scene.environment.
   */
  update(key: string, now: number, force = false): THREE.Texture | null {
    if (!force && (key === this.lastKey || now - this.lastTime < 2))
      return this.target?.texture ?? null
    this.lastKey = key
    this.lastTime = now
    const next = this.pmrem.fromScene(this.envScene, 0.035, 0.1, 200)
    this.target?.dispose()
    this.target = next
    return next.texture
  }

  dispose(): void {
    this.target?.dispose()
    this.pmrem.dispose()
  }
}
