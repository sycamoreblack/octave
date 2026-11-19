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
import { ECHO_COUNT, QUEST_COUNT, SHARD_COUNT, WAYSTONES, type WorldSpec } from './spec'
import { Echo, findSpot, LostItem, Seal, Waystone } from './objectives'
import { Renewal } from './renewal'
import { buildFloatingIsles, buildRivers, type IslesRig, type RiverRig } from './features'
import { LAND_RADIUS } from './terrain'
import { measureShift, worldSkyAt, type SkyShift } from './daycycle'
import { setAtmosphere } from '../graphics/atmosphere'

export interface Quality {
  /** Multiplier on flora/particle counts. */
  detail: number
  terrainRes: number
  shadows: boolean
  shadowSize: number
  pixelRatio: number
  /** Image-based lighting from the sky (and PBR plants). */
  ibl: boolean
  /** Post-processing: none, basic (AA, bloom, grade), or full (+ ambient occlusion). */
  post: 'none' | 'basic' | 'full'
}

export const QUALITY: Record<'low' | 'medium' | 'high', Quality> = {
  low: {
    detail: 0.35,
    terrainRes: 200,
    shadows: false,
    shadowSize: 1024,
    pixelRatio: 1,
    ibl: false,
    post: 'none'
  },
  medium: {
    detail: 0.7,
    terrainRes: 280,
    shadows: true,
    shadowSize: 2048,
    pixelRatio: 1.5,
    ibl: true,
    post: 'basic'
  },
  high: {
    detail: 1,
    terrainRes: 340,
    shadows: true,
    shadowSize: 2048,
    pixelRatio: 2,
    ibl: true,
    post: 'full'
  }
}

export interface ShardNode {
  index: number
  beacon: Beacon
  /** World position of the floating gem. */
  at: THREE.Vector3
  structure: Built
  collected: boolean
  /** Wake every stone to break the seal. May be fewer than WAYSTONES on cramped terrain. */
  stones: Waystone[]
  seal: Seal
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
  /** Things the wanderers lost: items[i] belongs to wanderers[i]. */
  items: LostItem[] = []
  echoes: Echo[] = []
  private tickers: ((t: number, dt: number) => void)[] = []
  fogBase = 0
  /** Current time of day (0..1); starts at the described time and may advance. */
  timeOfDay = 0
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
    this.timeOfDay = spec.timeOfDay
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
    this.river = buildRivers(spec, this.terrain)
    if (this.river) this.scene.add(this.river.mesh)
    if (spec.terrain.floating) {
      this.isles = buildFloatingIsles(spec, this.terrain, rng.fork('isles'), this.quality.detail)
      this.scene.add(this.isles.group)
    }

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
    this.renewal = new Renewal(
      spec,
      this.terrain,
      this.colliders,
      this.heart.center,
      flora.group,
      rng.fork('renewal'),
      this.quality.detail
    )
    this.scene.add(this.renewal.group)

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
    this.hemiBase = this.hemi.intensity
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
    this.fill = fill
    this.fillBase = fill.intensity
    this.skyShift = measureShift(spec.palette, spec.timeOfDay)
    this.updateClouds(
      new THREE.Color(spec.palette.skyTop),
      new THREE.Color(spec.palette.skyHorizon),
      new THREE.Color(spec.palette.sun),
      this.sky.night
    )
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
      const seal = new Seal(spec.palette.accent, at)
      this.scene.add(seal.mesh)
      const stones = this.placeWaystones(site.x, site.z, rng.fork(`stones${i}`), i)
      this.shards.push({ index: i, beacon, at, structure: built, collected: false, stones, seal })
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

    // Each of the first wanderers lost something at a minor place.
    for (let i = 0; i < QUEST_COUNT && i < layout.places.length; i++) {
      const site = layout.places[i]
      const spot =
        findSpot(terrain, this.colliders, rng.fork(`item${i}`), {
          cx: site.x,
          cz: site.z,
          rMin: 2.6,
          rMax: 6,
          avoid: [],
          gap: 0,
          maxSlope: 1.4
        }) ?? new THREE.Vector3(site.x + 3, terrain.surfaceAt(site.x + 3, site.z), site.z)
      const item = new LostItem(spot, i)
      this.items.push(item)
      this.scene.add(item.group)
    }

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
    this.placeEchoes(rng.fork('echoes'))
  }

  /** Three waystones in a loose ring 20–45 m out from a landmark. */
  private placeWaystones(cx: number, cz: number, rng: Rng, seed: number): Waystone[] {
    const stones: Waystone[] = []
    const taken: { x: number; z: number }[] = []
    for (let k = 0; k < WAYSTONES; k++) {
      const spot =
        findSpot(this.terrain, this.colliders, rng, {
          cx,
          cz,
          rMin: 20,
          rMax: 45,
          avoid: taken,
          gap: 14
        }) ??
        findSpot(this.terrain, this.colliders, rng, {
          cx,
          cz,
          rMin: 12,
          rMax: 70,
          avoid: taken,
          gap: 6,
          maxSlope: 1.3
        })
      if (!spot) continue
      taken.push(spot)
      const stone = new Waystone(
        this.spec,
        spot,
        Math.atan2(cx - spot.x, cz - spot.z),
        this.colliders,
        seed * 10 + k
      )
      stones.push(stone)
      this.scene.add(stone.group)
    }
    return stones
  }

  /** Echoes drift well away from everything else, so finding them means wandering. */
  private placeEchoes(rng: Rng): void {
    const avoid: { x: number; z: number }[] = [
      ...this.shards.map((s) => s.at),
      ...this.places.map((p) => p.at),
      ...this.shards.flatMap((s) => s.stones.map((w) => w.at))
    ]
    for (let i = 0; i < ECHO_COUNT; i++) {
      const spot =
        findSpot(this.terrain, this.colliders, rng, {
          cx: 0,
          cz: 0,
          rMin: 30,
          rMax: LAND_RADIUS * 0.95,
          avoid,
          gap: 70,
          maxSlope: 1.2
        }) ??
        findSpot(this.terrain, this.colliders, rng, {
          cx: 0,
          cz: 0,
          rMin: 10,
          rMax: LAND_RADIUS,
          avoid,
          gap: 25,
          maxSlope: 2
        })
      if (!spot) continue
      spot.y += 1.6
      avoid.push(spot)
      const echo = new Echo(this.spec.palette.accent, spot)
      this.echoes.push(echo)
      this.scene.add(echo.group)
    }
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
    if (this.river) {
      this.river.uniforms.uTime.value = t
      this.river.uniforms.uRenew.value = this.restoration
      ;(this.river.uniforms.uSky.value as THREE.Color).copy(
        this.liquid.uniforms.uSky.value as THREE.Color
      )
    }
    this.isles?.update(t)
    this.weather?.update(t, player)
    this.fauna.update(t, dt, player)
    for (const s of this.shards) {
      s.beacon.update(t, dt)
      s.seal.update(t, dt)
      for (const w of s.stones) w.update(t, dt)
    }
    for (const it of this.items) it.update(t, dt)
    for (const e of this.echoes) e.update(t, dt)
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
      if (this.lightningTimer < 0 && this.restoration < 0.5) {
        this.lightningTimer = 5 + Math.random() * 10
        flash.value = this.reduceFlashes ? 0.08 : 0.9
        this.onLightning?.()
      }
      this.hemi.intensity = this.hemiBase * this.hemiScale * 0.55 + (flash.value as number) * 2
    }

    this.updateAtmosphere()
    this.renewal.update(this.restoration)
    this.liquid.uniforms.uRenew.value = this.restoration
    if (this.weather && this.weather.kind === 'ash') {
      // The ash stops falling.
      this.weather.uniforms.uOpacity.value = 0.9 * (1 - this.restoration)
      this.weather.points.visible = this.restoration < 0.99
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
      // A restored land is a brighter one.
      this.hemi.intensity = this.hemiBase * this.hemiScale * (1 + 0.3 * r)
      const fog = this.scene.fog as THREE.FogExp2
      fog.density = this.fogBase * (1 - r * 0.45)
      fog.color.copy(this.sky.uniforms.uHorizon.value as THREE.Color)
      this.sky.uniforms.uAurora.value = Math.max(this.spec.aurora ? 1 : 0, r * (this.night ? 1 : 0))
    }
  }

  private fill!: THREE.AmbientLight
  private renewal!: Renewal
  river: RiverRig | null = null
  private isles: IslesRig | null = null
  private hemiBase = 1
  /** Lower when sky lighting (IBL) supplies the ambient light instead. */
  private hemiScale = 1

  /** Hand ambient light over to the sky environment map (or back). */
  setSkyLighting(on: boolean): void {
    this.hemiScale = on ? 0.4 : 1
    this.hemi.intensity = this.hemiBase * this.hemiScale
    this.fillScale = on ? 0.5 : 1
    this.fill.intensity = this.fillBase * this.fillScale
  }
  private fillBase = 0.3
  private fillScale = 1

  private atmoColor = new THREE.Color()

  /** Cloud colours for the current sky: bright and soft by day, warm at dusk, dim at night. */
  private updateClouds(
    top: THREE.Color,
    horizon: THREE.Color,
    sunColor: THREE.Color,
    night: number
  ): void {
    const u = this.sky.uniforms
    const cover: Record<string, number> = {
      clear: 0.5,
      rain: 0.72,
      storm: 0.86,
      snow: 0.66,
      fog: 0.6,
      ash: 0.62,
      fireflies: 0.3,
      spores: 0.32,
      petals: 0.42
    }
    u.uCloudCover.value = (cover[this.spec.weather] ?? 0.4) * (1 - 0.35 * this.restoration)
    const lit = u.uCloudLit.value as THREE.Color
    const shade = u.uCloudShade.value as THREE.Color
    const grey =
      this.spec.weather === 'storm' || this.spec.weather === 'ash'
        ? 0.55
        : this.spec.weather === 'rain'
          ? 0.75
          : 1
    lit
      .copy(horizon)
      .lerp(new THREE.Color('#ffffff'), 0.55)
      .lerp(sunColor, 0.25)
      .multiplyScalar(grey * (1 - 0.82 * night))
    shade
      .copy(top)
      .lerp(horizon, 0.5)
      .multiplyScalar(0.75 * grey * (1 - 0.6 * night))
  }

  /** Feed the shared fog uniforms: where the light is, its colour, and how mist sits on this land. */
  private updateAtmosphere(): void {
    const day = THREE.MathUtils.smoothstep(this.sky.sunDir.y, -0.05, 0.2)
    this.atmoColor.copy(this.sun.color)
    const t = this.terrain
    const heavy =
      this.spec.biome === 'swamp' || this.spec.weather === 'fog'
        ? 0.85
        : this.spec.biome === 'islands'
          ? 0.75
          : 0.6
    setAtmosphere({
      sunDir: this.sky.lightDir,
      sunColor: this.atmoColor,
      glow: 0.25 + 0.5 * day,
      referenceHeight: t.liquidY + t.amp * 0.25,
      relief: t.amp,
      heightAmount: heavy
    })
  }

  /** After the finale, the wanderers come to stand around the heart. */
  gatherWanderers(): void {
    const h = this.heart.center
    this.wanderers.forEach((w, i) => {
      const a = (i / Math.max(1, this.wanderers.length)) * Math.PI * 2 + 0.6
      for (let r = 24; r < 60; r += 4) {
        const x = h.x + Math.cos(a) * r
        const z = h.z + Math.sin(a) * r
        if (
          (this.terrain.solidLiquid || this.terrain.isDry(x, z, 0.6)) &&
          !this.colliders.occupied(x, z, 1)
        ) {
          w.moveHome(new THREE.Vector3(x, 0, z))
          return
        }
      }
    })
  }
  private skyShift!: { top: SkyShift; horizon: SkyShift }

  /**
   * Move the world to a new time of day: sun and moon, sky colours (keeping this world's
   * own tint), light strength and colour, fog, and the water's reflections.
   */
  setTime(t: number): void {
    const spec = this.spec
    this.timeOfDay = ((t % 1) + 1) % 1
    this.sky.setTime(this.timeOfDay)
    const night = this.sky.night
    const sunDir = this.sky.sunDir
    const colors = worldSkyAt(this.timeOfDay, this.skyShift)
    const top = new THREE.Color(colors.top)
    const horizon = new THREE.Color(colors.horizon)
    const sunColor = new THREE.Color(colors.sun)
    const storm = spec.weather === 'storm' ? 0.6 : 1

    // Sun by day, moonlight by night, never fully dark.
    const day = THREE.MathUtils.smoothstep(sunDir.y, -0.05, 0.15)
    const moon = 0.9 * night * (spec.moons > 0 ? 1 : 0.7)
    this.sun.intensity = Math.max(2.8 * day, moon) * storm
    this.sun.color.copy(day * 2.8 >= moon ? sunColor : new THREE.Color('#c8d4ff'))
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sky.lightDir, 200)

    const low = 1 - THREE.MathUtils.smoothstep(sunDir.y, 0.05, 0.4)
    this.hemiBase = THREE.MathUtils.lerp(1.7 + low * 0.9, 1.5, night) * (1 + 0.3 * night)
    this.hemi.intensity = this.hemiBase * this.hemiScale
    this.hemi.color
      .copy(top)
      .lerp(horizon, 0.5)
      .lerp(new THREE.Color('#7f96d8'), 0.6 * night)
    if (spec.liquid !== 'lava') {
      this.fill.color.copy(horizon).lerp(new THREE.Color('#ffffff'), 0.5)
      this.fillBase = THREE.MathUtils.lerp(0.3, 0.45, night)
      this.fill.intensity = this.fillBase * this.fillScale
    }

    if (this.baseColors) {
      this.baseColors.top.copy(top)
      this.baseColors.horizon.copy(horizon)
      this.baseColors.hemiSky.copy(this.hemi.color)
    }
    const u = this.sky.uniforms
    ;(u.uTop.value as THREE.Color).copy(top)
    ;(u.uHorizon.value as THREE.Color).copy(horizon)
    ;(u.uGround.value as THREE.Color).copy(horizon).multiplyScalar(0.6)
    ;(u.uSunColor.value as THREE.Color).copy(sunColor)
    const fog = this.scene.fog as THREE.FogExp2
    fog.color.copy(horizon)
    ;(this.scene.background as THREE.Color).copy(horizon)

    this.updateClouds(top, horizon, sunColor, night)
    const lu = this.liquid.uniforms
    ;(lu.uSunDir.value as THREE.Vector3).copy(sunDir)
    ;(lu.uSunColor.value as THREE.Color).copy(sunColor)
    ;(lu.uSky.value as THREE.Color).copy(horizon)
    lu.uSunPower.value = sunDir.y > 0 ? 1 : 0.3
  }

  onLightning?: () => void
  /** Accessibility: no sky flash for lightning (the thunder still rolls). */
  reduceFlashes = false

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
