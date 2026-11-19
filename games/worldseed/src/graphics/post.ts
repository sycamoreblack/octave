import * as THREE from 'three'
import {
  BloomEffect,
  BrightnessContrastEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect
} from 'postprocessing'
import { N8AOPostPass } from 'n8ao'

/**
 * The post-processing stack (pmndrs/postprocessing, with N8AO for ambient occlusion).
 * The scene renders into a half-float buffer, so the passes see real HDR values:
 *
 *  1. N8AO ambient occlusion (High only): soft contact shadows where things meet the
 *     ground, under canopies and in crevices. This is what grounds a low-poly world.
 *  2. Bloom from bright pixels only (no per-object setup): beacons, lanterns, lava,
 *     crystals and windows glow because they are actually bright.
 *  3. A light grade: a touch more saturation and contrast, then a soft vignette.
 *  4. Tone mapping (ACES, as before) and SMAA anti-aliasing, all merged by EffectPass
 *     into as few full-screen draws as possible.
 */
export class PostFX {
  readonly composer: EffectComposer
  private ao: N8AOPostPass | null = null
  private bloom: BloomEffect

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    level: 'basic' | 'full'
  ) {
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      multisampling: 0
    })
    this.composer.addPass(new RenderPass(scene, camera))

    if (level === 'full') {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2())
      this.ao = new N8AOPostPass(scene, camera, size.x, size.y)
      const c = this.ao.configuration
      c.aoRadius = 3.2
      c.distanceFalloff = 1.2
      c.intensity = 2.4
      c.color = new THREE.Color(0, 0, 0)
      c.halfRes = true
      // Transparent water, beams and particles don't need AO and would cost extra passes.
      c.transparencyAware = false
      c.gammaCorrection = false
      this.ao.setQualityMode('Low')
      this.composer.addPass(this.ao)
    }

    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 0.82,
      luminanceSmoothing: 0.18,
      intensity: 0.85,
      radius: 0.72
    })
    const grade = new HueSaturationEffect({ saturation: 0.08 })
    const contrast = new BrightnessContrastEffect({ contrast: 0.06 })
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })
    const vignette = new VignetteEffect({ offset: 0.32, darkness: 0.42 })
    const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH })
    // Bloom and grading work on HDR values; tone mapping maps to display; AA runs last.
    this.composer.addPass(new EffectPass(camera, this.bloom, grade, contrast, tone, vignette))
    this.composer.addPass(new EffectPass(camera, smaa))

    // The tone mapping effect does the mapping now; the scene must render linear.
    renderer.toneMapping = THREE.NoToneMapping
  }

  /** Turn ambient occlusion off (used by auto-detail). */
  setAO(on: boolean): void {
    if (this.ao) this.ao.enabled = on
  }

  get hasAO(): boolean {
    return !!this.ao && this.ao.enabled
  }

  render(dt: number): void {
    this.composer.render(dt)
  }

  setSize(): void {
    const size = this.renderer.getSize(new THREE.Vector2())
    this.composer.setSize(size.x, size.y)
  }

  dispose(): void {
    this.composer.dispose()
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
  }
}
