import * as THREE from 'three'
import { Rng } from '../engine/rng'
import { Colliders } from '../engine/colliders'
import { windUniforms } from '../engine/wind'
import { Terrain } from './terrain'
import { planLayout, type Layout } from './layout'
import { buildFlora } from './flora'
import { buildHeart, buildMarker, buildStructure, type Built } from './structures'
import { buildSky, type SkyRig } from './sky'
import { buildLiquid, type LiquidRig } from './liquid'
import { buildWeather, type WeatherRig } from './weather'
import { buildFauna, type FaunaRig } from './fauna'
import { Beacon } from './beacon'
import { Wanderer } from './npc'
import { SHARD_COUNT, type WorldSpec } from './spec'

export interface Quality {
  /** Multiplier on flora/particle counts. */
  detail: number
  terrainRes: number
  shadows: boolean
  shadowSize: number
  pixelRatio: number
}

export const QUALITY: Record<'low' | 'medium' | 'high', Quality> = {
  low: { detail: 0.35, terrainRes: 200, shadows: false, shadowSize: 1024, pixelRatio: 1 },
  medium: { detail: 0.7, terrainRes: 280, shadows: true, shadowSize: 2048, pixelRatio: 1.5 },
  high: { detail: 1, terrainRes: 340, shadows: true, shadowSize: 2048, pixelRatio: 2 }
}

export interface ShardNode {
  index: number
  beacon: Beacon
  /** World position of the floating gem. */
  at: THREE.Vector3
  structure: Built
  collected: boolean
}

export interface PlaceNode {
  name: string
  note: string
  at: THREE.Vector3
  radius: number
  kind: 'shard' | 'minor' | 'heart'
  discovered: boolean
}

export interface HeartNode {
  group: THREE.Group
  pedestals: THREE.Mesh[]
  ring: THREE.Mesh
  relic: THREE.Mesh
  center: THREE.Vector3
  beacon: Beacon
}

export class World {
  readonly scene = new THREE.Scene()
  terrain!: Terrain
  layout!: Layout
  colliders = new Colliders()
  sky!: SkyRig
  liquid!: LiquidRig
  weather: WeatherRig | null = null
  fauna!: FaunaRig
  sun!: THREE.DirectionalLight
  hemi!: THREE.HemisphereLight
  shards: ShardNode[] = []
  places: PlaceNode[] = []
  heart!: HeartNode
  wanderers: Wanderer[] = []
  private tickers: ((t: number, dt: number) => void)[] = []
  fogBase = 0
  /** 0..1, raised by the finale: brightens and saturates the world. */
  restoration = 0
  private baseColors: {
    top: THREE.Color
    horizon: THREE.Color
    hemiSky: THREE.Color
    hemiGround: THREE.Color
  } | null = null
  private lightningTimer = 4

  constructor(
    readonly spec: WorldSpec,
    readonly quality: Quality
  ) {}

  get night(): boolean {
    return this.sky.night > 0.5
  }

  /** Builds everything, yielding between stages so the loading screen can paint. */
  async build(onProgress: (stage: string, f: number) => void): Promise<void> {
    const spec = this.spec
    const rng = new Rng(spec.seed)
    const step = async (label: string, f: number): Promise<void> => {
      onProgress(label, f)
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
    }

    await step('Raising the land', 0.05)
    this.terrain = new Terrain(spec, rng.fork('terrain'))
    this.layout = planLayout(spec, this.terrain, rng.fork('layout'))
    this.terrain.setPads(this.layout.pads)
    this.terrain.bake(this.quality.terrainRes)
    const ground = this.terrain.buildMesh()
    this.scene.add(ground)

    await step('Painting the sky', 0.3)
    this.sky = buildSky(spec, rng.fork('sky'))
    this.scene.add(this.sky.mesh)
    this.setupLights()
    this.liquid = buildLiquid(spec, this.terrain, this.sky.sunDir, this.sky.sunDir.y > 0 ? 1 : 0.3)
    this.scene.add(this.liquid.mesh)

    await step('Raising the old places', 0.45)
    this.buildLandmarks(rng.fork('landmarks'))

    await step('Sowing seeds', 0.6)
    const flora = buildFlora(
      spec,
      this.terrain,
      this.layout,
      this.colliders,
      rng.fork('flora'),
      this.quality.detail
    )
    this.scene.add(flora.group)

    await step('Waking the wind', 0.8)
    this.weather = buildWeather(spec, rng.fork('weather'), this.quality.detail)
    if (this.weather) this.scene.add(this.weather.points)
    const anchors = [
      ...this.shards.map((s) => s.at),
      ...this.places.map((p) => p.at),
      this.heart.center
    ]
    this.fauna = buildFauna(spec, this.terrain, rng.fork('fauna'), anchors)
    this.scene.add(this.fauna.group)

    await step('Calling the wanderers', 0.92)
    const wr = rng.fork('wanderers')
    this.layout.wanderers.forEach((site, i) => {
      const story = spec.story.wanderers[i]
      if (!story) return
      const w = new Wanderer(
        story,
        i,
        new THREE.Vector3(site.x, 0, site.z),
        this.terrain,
        this.colliders,
        wr.fork(`w${i}`)
      )
      this.wanderers.push(w)
      this.scene.add(w.figure.root)
    })
    await step('Opening your eyes', 1)
  }

  private setupLights(): void {
    const spec = this.spec
    const fog = new THREE.FogExp2(spec.palette.skyHorizon, 0.0009 + spec.fog * 0.0075)
    this.fogBase = fog.density
    this.scene.fog = fog
    this.scene.background = new THREE.Color(spec.palette.skyHorizon)

    const night = this.sky.night
    const sunColor = new THREE.Color(spec.palette.sun)
    const low = 1 - THREE.MathUtils.smoothstep(this.sky.sunDir.y, 0.05, 0.4)
    const sunPower = THREE.MathUtils.lerp(2.8, 0.9, night) * (spec.weather === 'storm' ? 0.6 : 1)
    this.sun = new THREE.DirectionalLight(sunColor, sunPower)
    this.sun.position.copy(this.sky.lightDir).multiplyScalar(200)
    this.sun.castShadow = this.quality.shadows
    const sc = this.sun.shadow.camera
    sc.left = sc.bottom = -70
    sc.right = sc.top = 70
    sc.near = 1
    sc.far = 500
    this.sun.shadow.mapSize.set(this.quality.shadowSize, this.quality.shadowSize)
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.6
    this.scene.add(this.sun, this.sun.target)

    const skyCol = new THREE.Color(spec.palette.skyTop).lerp(
      new THREE.Color(spec.palette.skyHorizon),
      0.5
    )
    const groundCol = new THREE.Color(spec.palette.groundMid).multiplyScalar(0.5)
    // Low sun (dawn/dusk) leaves most facets in shade, so the sky fill rises to compensate.
    this.hemi = new THREE.HemisphereLight(
      skyCol,
      groundCol,
      THREE.MathUtils.lerp(1.7 + low * 0.9, 1.5, night)
    )
    if (night > 0.5) this.hemi.color.lerp(new THREE.Color('#7f96d8'), 0.6)
    if (night > 0.5) this.hemi.intensity *= 1.3
    this.scene.add(this.hemi)
    // Lava glows up onto everything; otherwise a soft sky-tinted fill keeps shadows readable.
    const fill =
      spec.liquid === 'lava'
        ? new THREE.AmbientLight('#ff8a4a', 0.9)
        : new THREE.AmbientLight(
            new THREE.Color(spec.palette.skyHorizon).lerp(new THREE.Color('#ffffff'), 0.5),
            night > 0.5 ? 0.45 : 0.3
          )
    this.scene.add(fill)
    this.baseColors = {
      top: (this.sky.uniforms.uTop.value as THREE.Color).clone(),
      horizon: (this.sky.uniforms.uHorizon.value as THREE.Color).clone(),
      hemiSky: this.hemi.color.clone(),
      hemiGround: this.hemi.groundColor.clone()
    }
  }

  private buildLandmarks(rng: Rng): void {
    const spec = this.spec
    const { layout, terrain } = this
    const story = spec.story

    layout.shards.forEach((site, i) => {
      const y = terrain.groundAt(site.x, site.z)
      const built = buildStructure(
        site.structure,
        spec,
        rng.fork(`s${i}`),
        this.colliders,
        this.terrain,
        { x: site.x, y, z: site.z, yaw: site.yaw }
      )
      this.scene.add(built.group)
      if (built.tick) this.tickers.push((t) => built.tick!(t))
      built.group.updateMatrixWorld(true)
      const at = built.shardAt.clone().applyMatrix4(built.group.matrixWorld)
      const beacon = new Beacon(spec.palette.accent, at)
      this.scene.add(beacon.group)
      this.shards.push({ index: i, beacon, at, structure: built, collected: false })
      this.places.push({
        name: story.shards[i].place,
        note: '',
        at: new THREE.Vector3(site.x, y, site.z),
        radius: 55,
        kind: 'shard',
        discovered: false
      })
    })

    layout.places.forEach((site, i) => {
      const y = terrain.groundAt(site.x, site.z)
      this.scene.add(
        buildMarker(spec, rng.fork(`m${i}`), this.colliders, this.terrain, {
          x: site.x,
          y,
          z: site.z,
          yaw: site.yaw
        })
      )
      const p = story.places[i]
      if (p)
        this.places.push({
          name: p.name,
          note: p.note,
          at: new THREE.Vector3(site.x, y, site.z),
          radius: 22,
          kind: 'minor',
          discovered: false
        })
    })

    const h = layout.heart
    const hy = terrain.groundAt(h.x, h.z)
    const heart = buildHeart(
      spec,
      rng.fork('heart'),
      this.colliders,
      this.terrain,
      { x: h.x, y: hy, z: h.z, yaw: h.yaw },
      SHARD_COUNT
    )
    this.scene.add(heart.group)
    const heartBeacon = new Beacon('#ffffff', new THREE.Vector3(h.x, hy + 12, h.z), 260, false)
    heartBeacon.strength = 0
    heartBeacon.fade(0)
    this.scene.add(heartBeacon.group)
    this.heart = { ...heart, beacon: heartBeacon }
    this.places.push({
      name: story.finale.place,
      note: '',
      at: new THREE.Vector3(h.x, hy, h.z),
      radius: 40,
      kind: 'heart',
      discovered: false
    })
  }

  update(t: number, dt: number, camera: THREE.Camera, player: THREE.Vector3): void {
    windUniforms.uTime.value = t
    windUniforms.uWind.value =
      this.spec.weather === 'storm'
        ? 2.2
        : this.spec.biome === 'tundra' || this.spec.biome === 'islands'
          ? 1.4
          : 1
    this.sky.update(t, camera)
    this.liquid.uniforms.uTime.value = t
    this.weather?.update(t, player)
    this.fauna.update(t, dt, player)
    for (const s of this.shards) s.beacon.update(t, dt)
    this.heart.beacon.update(t, dt)
    this.heart.ring.rotation.y = t * 0.05 * (1 + this.restoration * 4)
    this.heart.relic.rotation.y = t * 0.8
    this.heart.relic.rotation.x = t * 0.3
    for (const tk of this.tickers) tk(t, dt)
    for (const w of this.wanderers) w.update(t, dt, player)

    // Shadow camera follows the player, snapped to texels to stop shimmering.
    if (this.sun.castShadow) {
      const texel = 140 / this.quality.shadowSize
      const fx = Math.round(player.x / texel) * texel
      const fz = Math.round(player.z / texel) * texel
      this.sun.target.position.set(fx, player.y, fz)
      this.sun.position.set(fx, player.y, fz).addScaledVector(this.sky.lightDir, 200)
    }

    if (this.spec.weather === 'storm') {
      this.lightningTimer -= dt
      const flash = this.sky.uniforms.uFlash
      flash.value = Math.max(0, (flash.value as number) - dt * 3)
      if (this.lightningTimer < 0) {
        this.lightningTimer = 5 + Math.random() * 10
        flash.value = 0.9
        this.onLightning?.()
      }
      this.hemi.intensity = 0.9 + (flash.value as number) * 2
    }

    if (this.restoration > 0 && this.baseColors) {
      const r = this.restoration
      const warm = new THREE.Color(this.spec.palette.accent)
      ;(this.sky.uniforms.uTop.value as THREE.Color)
        .copy(this.baseColors.top)
        .lerp(warm, r * 0.15)
        .multiplyScalar(1 + r * 0.25)
      ;(this.sky.uniforms.uHorizon.value as THREE.Color)
        .copy(this.baseColors.horizon)
        .lerp(warm, r * 0.3)
      this.hemi.color.copy(this.baseColors.hemiSky).lerp(warm, r * 0.2)
      const fog = this.scene.fog as THREE.FogExp2
      fog.density = this.fogBase * (1 - r * 0.45)
      fog.color.copy(this.sky.uniforms.uHorizon.value as THREE.Color)
      this.sky.uniforms.uAurora.value = Math.max(this.spec.aurora ? 1 : 0, r * (this.night ? 1 : 0))
    }
  }

  onLightning?: () => void

  dispose(): void {
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    })
    ;(this.liquid.uniforms.uHeight.value as THREE.Texture).dispose()
  }
}
