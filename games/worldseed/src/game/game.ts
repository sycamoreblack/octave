import * as THREE from 'three'
import { Input } from '../engine/input'
import { AudioEngine } from '../engine/audio'
import { World, QUALITY, type ShardNode } from '../world/world'
import { SHARD_COUNT, type WorldSpec } from '../world/spec'
import { pluralize } from '../story/narrator'
import { Player } from './player'
import { FollowCamera } from './camera'
import { Hud, esc, type CompassMark } from '../ui/hud'
import { WorldMap } from '../ui/map'
import {
  emptyProgress,
  storeSave,
  worldId,
  type JournalEntry,
  type Progress,
  type Settings
} from './save'

type Mode = 'loading' | 'playing' | 'card' | 'journal' | 'map' | 'paused'

type Target =
  | { kind: 'shard'; node: ShardNode }
  | { kind: 'wanderer'; index: number }
  | { kind: 'heart' }

const DIRS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west'
]

function compassWord(dx: number, dz: number): string {
  const a = Math.atan2(dx, -dz)
  return DIRS[(Math.round(a / (Math.PI / 4)) + 8) % 8]
}

/** "The Harvest Bell" → "the Harvest Bell", for use mid-sentence. */
const mid = (s: string): string => s.replace(/^The /, 'the ')

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${Math.floor(s % 60)}s`
}

/**
 * Owns one loaded world: the frame loop, the story's progression, interactions,
 * HUD, saving and the finale. main.ts creates one per world and disposes it after.
 */
export class Game {
  world!: World
  player!: Player
  follow!: FollowCamera
  map!: WorldMap
  progress: Progress = emptyProgress()
  mode: Mode = 'loading'
  private camera: THREE.PerspectiveCamera
  private clock = new THREE.Clock()
  private time = 0
  private target: Target | null = null
  private talking: { index: number; line: number; lines: string[] } | null = null
  private collecting: { node: ShardNode; t: number; from: THREE.Vector3 } | null = null
  private finale: { t: number; shown: boolean } | null = null
  private saveTimer = 0
  private checkTimer = 0
  private running = false
  private expectUnlock = false
  private raf = 0
  private distanceAtLoad = 0
  private pausedAt = 0
  /** Leaves the game (to the title screen). */
  onExit?: () => void
  onRebuild?: (quality: Settings['quality']) => void
  onShare?: () => void

  constructor(
    private renderer: THREE.WebGLRenderer,
    private input: Input,
    private hud: Hud,
    private audio: AudioEngine,
    public settings: Settings,
    readonly spec: WorldSpec
  ) {
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 5000)
  }

  async load(
    saved: Progress | null,
    onProgress: (stage: string, f: number) => void
  ): Promise<void> {
    const q = QUALITY[this.settings.quality]
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio))
    this.renderer.shadowMap.enabled = q.shadows
    this.world = new World(this.spec, q)
    await this.world.build(onProgress)
    this.world.onLightning = () => this.audio.thunder()

    // Nothing past where fog is ~opaque needs drawing; keep beacons (≤1.2 km away) in range.
    const fog = this.world.scene.fog as THREE.FogExp2
    this.camera.far = THREE.MathUtils.clamp(2.6 / fog.density, 1400, 4500)
    this.camera.updateProjectionMatrix()
    const night = this.world.night
    this.renderer.toneMappingExposure = night ? 1.4 : 1.1
    this.player = new Player(
      this.world.terrain,
      this.world.colliders,
      night || this.spec.weather === 'storm',
      this.spec.palette.accent
    )
    this.world.scene.add(this.player.object)
    this.follow = new FollowCamera(this.camera, this.world.terrain, this.world.colliders, {
      sensitivity: this.settings.sensitivity,
      invertY: this.settings.invertY
    })
    this.map = new WorldMap(this.world)

    this.progress = saved ? { ...emptyProgress(), ...saved } : emptyProgress()
    this.distanceAtLoad = this.progress.distance
    const { spawn } = this.world.layout
    const pp = this.progress.player
    this.player.place(pp?.x ?? spawn.x, pp?.z ?? spawn.z, pp?.facing ?? spawn.yaw)
    this.follow.snap(this.player.facing)
    this.map.restore(this.progress.explored)
    this.applyProgress()

    this.player.onStep = (s) => this.audio.step(s)
    this.player.onJump = () => this.audio.jump()
    this.player.onSplash = () => this.audio.splash()

    // Compile shaders and upload buffers before the first visible frame.
    this.follow.update(0.016, this.input, this.player.position, this.player.facing, 0)
    this.renderer.compile(this.world.scene, this.camera)
  }

  /** Re-apply saved progress to the freshly built world. */
  private applyProgress(): void {
    const p = this.progress
    for (const i of p.collected) {
      const node = this.world.shards[i]
      if (!node) continue
      node.collected = true
      node.beacon.strength = 0
      node.beacon.fade(0)
      node.beacon.gem.visible = false
      this.lightPedestal(i, true)
    }
    for (const place of this.world.places)
      if (p.discovered.includes(place.name)) place.discovered = true
    for (const i of p.met) if (this.world.wanderers[i]) this.world.wanderers[i].met = true
    if (p.restored) {
      this.world.restoration = 1
      this.world.heart.relic.visible = true
      ;(this.world.heart.ring.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.2
    } else if (p.collected.length >= SHARD_COUNT) {
      this.world.heart.beacon.fade(1)
    }
    this.updateObjective()
  }

  private lightPedestal(i: number, instant = false): void {
    const gem = this.world.heart.pedestals[i]
    if (!gem) return
    const mat = gem.material as THREE.MeshStandardMaterial
    mat.color.set(this.spec.palette.accent)
    if (instant) mat.emissiveIntensity = 1.6
    else {
      const start = performance.now()
      const tick = (): void => {
        const f = Math.min(1, (performance.now() - start) / 1500)
        mat.emissiveIntensity = f * 1.6
        if (f < 1) requestAnimationFrame(tick)
      }
      tick()
    }
  }

  async begin(isNew: boolean): Promise<void> {
    this.hud.show(true)
    this.audio.begin(this.spec)
    this.running = true
    this.clock.start()
    this.loop()
    const s = this.spec.story
    if (isNew) {
      this.addJournal({ kind: 'story', title: s.title, text: s.prologue.join(' ') })
      this.addJournal({ kind: 'story', title: 'Your task', text: s.goal })
      this.mode = 'card'
      await this.hud.showCard({
        kicker: `${s.role} · ${this.spec.name}`,
        title: s.title,
        epigraph: this.spec.prompt,
        paragraphs: s.prologue,
        actions: [{ label: 'Step into the world', primary: true, value: 'ok' }]
      })
      this.mode = 'playing'
      this.hud.showBanner('You arrive in', this.spec.name, 4.5)
      this.hud.toast(
        this.input.touchActive || matchMedia('(pointer: coarse)').matches
          ? 'Drag on the left to move, on the right to look. Tap <b>E</b> to interact.'
          : 'Click to look around. <b>WASD</b> to move, <b>Space</b> to jump (hold to glide), <b>E</b> to interact.'
      )
      this.hud.toast(`Follow the pillars of light. Someone nearby might have advice.`)
    } else {
      this.mode = 'playing'
      this.hud.showBanner('You return to', this.spec.name, 4)
    }
    this.save()
  }

  private loop = (): void => {
    if (!this.running) return
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(0.05, this.clock.getDelta())
    this.time += dt
    this.update(dt)
    this.renderer.render(this.world.scene, this.camera)
    this.input.endFrame()
  }

  private update(dt: number): void {
    const t = this.time
    const playing = this.mode === 'playing'
    this.input.enabled = playing
    this.handleGlobalKeys()

    if (playing) this.progress.playTime += dt
    this.player.update(dt, t, this.input, this.follow.yaw)
    const speed = Math.hypot(this.player.velocity.x, this.player.velocity.z)
    this.follow.update(dt, this.input, this.player.position, this.player.facing, speed)
    this.world.update(t, dt, this.camera, this.player.position)

    if (this.collecting) this.updateCollect(dt)
    if (this.finale) this.updateFinale(dt)

    this.checkTimer -= dt
    if (this.checkTimer <= 0) {
      this.checkTimer = 0.25
      if (playing) this.checkDiscoveries()
      if (this.map.reveal(this.player.position.x, this.player.position.z))
        this.progress.explored = this.map.serialize()
    }

    if (playing) this.updateTarget()
    else this.hud.setHint('')
    this.updateCompass()
    this.hud.setClickHint(
      playing && !document.pointerLockElement && this.time > 6 && this.time < 40
    )

    const alt = Math.max(
      0,
      Math.min(
        1,
        (this.player.position.y - this.world.terrain.liquidY) /
          Math.max(1, this.world.terrain.maxHeight - this.world.terrain.liquidY)
      )
    )
    this.audio.update(dt, alt, this.spec.weather === 'storm' ? 2 : 1)

    this.saveTimer += dt
    if (this.saveTimer > 12 && playing) this.save()
  }

  private handleGlobalKeys(): void {
    const raw = (code: string): boolean => {
      // Global keys work in every mode, so read them regardless of input.enabled.
      const was = this.input.enabled
      this.input.enabled = true
      const p = this.input.pressed(code)
      this.input.enabled = was
      return p
    }
    if (this.mode === 'card' || this.mode === 'loading') return
    if (raw('KeyJ')) this.togglePanel('journal')
    else if (raw('KeyM')) this.togglePanel('map')
    else if (raw('Escape') || raw('KeyP')) {
      if (this.mode === 'playing') this.pause(true)
      // The Escape that released pointer lock may also arrive as a keypress: don't let it un-pause.
      else if (performance.now() - this.pausedAt > 300) this.closePanels()
    } else if (raw('KeyE') && this.mode === 'playing') this.interact()
  }

  togglePanel(which: 'journal' | 'map'): void {
    if (this.mode === which) return this.closePanels()
    this.closePanels(false)
    this.mode = which
    this.unlockPointer()
    if (which === 'journal') {
      this.hud.renderJournal(this.progress.journal)
      document.getElementById('journal')!.classList.remove('hidden')
    } else {
      const canvas = document.getElementById('map-canvas') as HTMLCanvasElement
      document.getElementById('map-title')!.textContent =
        `${this.spec.name} — ${Math.round(this.map.exploredFraction * 100)}% explored`
      this.map.draw(canvas, this.player.position, this.player.facing, this.progress.met)
      document.getElementById('map')!.classList.remove('hidden')
    }
  }

  pause(on: boolean): void {
    if (on) {
      this.closePanels(false)
      this.mode = 'paused'
      this.pausedAt = performance.now()
      this.unlockPointer()
      document.getElementById('pause')!.classList.remove('hidden')
      this.save()
    } else this.closePanels()
  }

  closePanels(resume = true): void {
    for (const id of ['journal', 'map', 'pause'])
      document.getElementById(id)!.classList.add('hidden')
    if (resume && this.mode !== 'card' && this.mode !== 'loading') this.mode = 'playing'
  }

  private unlockPointer(): void {
    if (document.pointerLockElement) {
      this.expectUnlock = true
      document.exitPointerLock()
    }
  }

  /** Called by main when pointer lock is lost. */
  onPointerUnlock(): void {
    if (this.expectUnlock) {
      this.expectUnlock = false
      return
    }
    if (this.mode === 'playing') this.pause(true)
  }

  canvasClicked(): void {
    if (this.mode === 'playing') this.input.requestLock()
  }

  // ---------------- interaction ----------------

  private updateTarget(): void {
    const p = this.player.position
    let best = null as Target | null
    let bestD = Infinity
    for (const node of this.world.shards) {
      if (node.collected || this.collecting?.node === node) continue
      const d = Math.hypot(node.at.x - p.x, node.at.z - p.z)
      if (d < 4.5 && Math.abs(node.at.y - p.y) < 7 && d < bestD) {
        best = { kind: 'shard', node }
        bestD = d
      }
    }
    for (let i = 0; i < this.world.wanderers.length; i++) {
      const w = this.world.wanderers[i]
      const d = Math.hypot(w.position.x - p.x, w.position.z - p.z)
      if (d < 5 && d < bestD) {
        best = { kind: 'wanderer', index: i }
        bestD = d
      }
    }
    const h = this.world.heart.center
    if (!this.progress.restored && !this.finale && Math.hypot(h.x - p.x, h.z - p.z) < 13) {
      if (!best) best = { kind: 'heart' }
    }
    if (this.talking && (!best || best.kind !== 'wanderer' || best.index !== this.talking.index)) {
      this.talking = null
      this.hud.hideDialogue()
    }
    this.target = best
    this.hud.setHint(this.hintFor(best))
  }

  private hintFor(t: Target | null): string {
    if (!t || this.talking) return ''
    const key = '<kbd>E</kbd>'
    if (t.kind === 'shard')
      return `${key} Take ${esc(mid(this.spec.story.shards[t.node.index].name))}`
    if (t.kind === 'wanderer')
      return `${key} Talk to ${esc(this.world.wanderers[t.index].story.name)}`
    const have = this.progress.collected.length
    if (have < SHARD_COUNT) {
      const need = SHARD_COUNT - have
      return `The pedestals wait for ${need} more ${esc(need === 1 ? this.spec.story.shardNoun : pluralize(this.spec.story.shardNoun))}`
    }
    return `${key} Restore ${esc(mid(this.spec.story.relic))}`
  }

  private interact(): void {
    const t = this.target
    if (this.talking) return this.advanceTalk()
    if (!t) return
    if (t.kind === 'shard') this.startCollect(t.node)
    else if (t.kind === 'wanderer') this.startTalk(t.index)
    else if (this.progress.collected.length >= SHARD_COUNT) this.startFinale()
  }

  private startTalk(index: number): void {
    const w = this.world.wanderers[index]
    const lines = [...w.story.lines, this.hintLine(w.position)]
    const first = !w.met
    // Returning visitors skip straight to the advice.
    const start = first ? 0 : Math.max(0, lines.length - 1)
    this.talking = { index, line: start, lines }
    this.hud.showDialogue(w.story.name, w.story.epithet, lines[start])
    this.audio.blip()
    if (first) {
      w.met = true
      this.progress.met.push(index)
      this.addJournal({
        kind: 'person',
        title: `${w.story.name}, ${w.story.epithet}`,
        text: w.story.lines.slice(1).join(' ')
      })
      this.hud.toast(`Met <b>${esc(w.story.name)}</b>. Their words are in your journal.`)
    }
  }

  private advanceTalk(): void {
    if (!this.talking) return
    this.talking.line++
    if (this.talking.line >= this.talking.lines.length) {
      this.talking = null
      this.hud.hideDialogue()
      return
    }
    const w = this.world.wanderers[this.talking.index]
    this.hud.showDialogue(w.story.name, w.story.epithet, this.talking.lines[this.talking.line])
    this.audio.blip()
  }

  /** A wanderer's advice, computed live: where is the nearest light you haven't taken? */
  private hintLine(from: THREE.Vector3): string {
    const s = this.spec.story
    if (this.progress.restored)
      return `Can you hear it? Everything is singing again. Thank you, ${s.role}.`
    const remaining = this.world.shards.filter((n) => !n.collected)
    if (!remaining.length) {
      const h = this.world.heart.center
      return `You have them all. Go ${compassWord(h.x - from.x, h.z - from.z)}, to ${s.finale.place}. It's waiting for you.`
    }
    const near = remaining.reduce((a, b) => (a.at.distanceTo(from) < b.at.distanceTo(from) ? a : b))
    const d = near.at.distanceTo(from)
    const how = d < 160 ? 'not far' : d < 380 ? 'a fair walk' : 'a long way off'
    const place = s.shards[near.index].place
    return `If you're looking for the lights: ${compassWord(near.at.x - from.x, near.at.z - from.z)} of here, ${how}. Folk used to call that place ${place}.`
  }

  private startCollect(node: ShardNode): void {
    this.collecting = { node, t: 0, from: node.beacon.group.position.clone() }
    node.beacon.fade(0)
    this.audio.chime()
  }

  private updateCollect(dt: number): void {
    const c = this.collecting!
    c.t += dt
    const f = Math.min(1, c.t / 0.9)
    const ease = f * f * (3 - 2 * f)
    const to = this.player.position.clone().add(new THREE.Vector3(0, 1.4, 0))
    c.node.beacon.gem.position.copy(
      new THREE.Vector3().lerpVectors(c.from, to, ease).sub(c.node.beacon.group.position)
    )
    c.node.beacon.gem.scale.setScalar(1 - ease * 0.8).multiply(new THREE.Vector3(1, 1.6, 1))
    if (f >= 1) {
      c.node.beacon.gem.visible = false
      this.collecting = null
      this.completeCollect(c.node)
    }
  }

  private async completeCollect(node: ShardNode): Promise<void> {
    node.collected = true
    this.progress.collected.push(node.index)
    this.lightPedestal(node.index)
    const story = this.spec.story.shards[node.index]
    this.addJournal({ kind: 'shard', title: story.name, text: story.lore })
    this.updateObjective()
    this.save()
    const n = this.progress.collected.length
    this.mode = 'card'
    this.unlockPointer()
    await this.hud.showCard({
      kicker: `${n} of ${SHARD_COUNT} recovered · ${story.place}`,
      title: story.name,
      paragraphs: [story.lore]
    })
    this.mode = 'playing'
    if (n >= SHARD_COUNT) {
      this.world.heart.beacon.fade(1)
      this.hud.showBanner('The way is open', this.spec.story.finale.place, 5)
      this.hud.toast(
        `All ${pluralize(this.spec.story.shardNoun)} found. Follow the white light to <b>${esc(this.spec.story.finale.place)}</b>.`
      )
    } else {
      this.hud.toast(`${SHARD_COUNT - n} to go. The remaining lights still burn on the horizon.`)
    }
  }

  private startFinale(): void {
    this.finale = { t: 0, shown: false }
    this.world.heart.relic.visible = true
    this.world.heart.relic.scale.setScalar(0.01)
    this.audio.finale()
    this.world.heart.beacon.fade(0)
    this.hud.setHint('')
  }

  private updateFinale(dt: number): void {
    const f = this.finale!
    f.t += dt
    const heart = this.world.heart
    const k = Math.min(1, f.t / 3)
    heart.relic.scale.setScalar(0.01 + k * 0.99)
    ;(heart.ring.material as THREE.MeshStandardMaterial).emissiveIntensity = Math.min(
      1.2,
      f.t * 0.4
    )
    this.world.restoration = Math.max(
      this.world.restoration,
      Math.min(1, Math.max(0, (f.t - 1) / 6))
    )
    if (f.t > 7.5 && !f.shown) {
      f.shown = true
      void this.showEnding()
    }
  }

  private async showEnding(): Promise<void> {
    const s = this.spec.story
    this.progress.restored = true
    this.world.restoration = 1
    this.addJournal({ kind: 'finale', title: `${s.relic}, restored`, text: s.finale.text })
    this.updateObjective()
    this.save()
    this.mode = 'card'
    this.unlockPointer()
    await this.hud.showCard({
      kicker: s.finale.place,
      title: `${s.relic}, restored`,
      paragraphs: [s.finale.text]
    })
    const found = this.world.places.filter((p) => p.discovered).length
    const stats = `<div class="stats">
      <div><b>${fmtTime(this.progress.playTime)}</b>walking</div>
      <div><b>${(this.progress.distance / 1000).toFixed(1)} km</b>travelled</div>
      <div><b>${found}/${this.world.places.length}</b>places found</div>
      <div><b>${Math.round(this.map.exploredFraction * 100)}%</b>explored</div>
      <div><b>${this.progress.met.length}/${this.world.wanderers.length}</b>wanderers met</div>
    </div>`
    const choice = await this.hud.showCard({
      kicker: 'Epilogue',
      title: s.title,
      paragraphs: s.epilogue,
      statsHtml: stats,
      actions: [
        { label: 'Keep exploring', primary: true, value: 'stay' },
        { label: 'Copy link to this world', value: 'share' },
        { label: 'Dream a new world', value: 'new' }
      ]
    })
    this.finale = null
    this.mode = 'playing'
    if (choice === 'new') this.onExit?.()
    else if (choice === 'share') this.onShare?.()
  }

  // ---------------- discovery, compass, objective ----------------

  private checkDiscoveries(): void {
    const p = this.player.position
    for (const place of this.world.places) {
      if (place.discovered) continue
      if (Math.hypot(place.at.x - p.x, place.at.z - p.z) > place.radius) continue
      place.discovered = true
      this.progress.discovered.push(place.name)
      this.audio.discover()
      if (place.kind === 'minor') {
        this.hud.showBanner('Discovered', place.name)
        this.hud.toast(`<b>${esc(place.name)}</b> — ${esc(place.note)}`)
        this.addJournal({ kind: 'place', title: place.name, text: place.note })
      } else if (place.kind === 'heart') {
        this.hud.showBanner('The centre of everything', place.name, 5)
        this.addJournal({
          kind: 'place',
          title: place.name,
          text: `Where ${this.spec.story.relic} once stood. ${SHARD_COUNT} empty pedestals ring a great standing circle.`
        })
      } else {
        this.hud.showBanner('You have found', place.name)
        this.addJournal({
          kind: 'place',
          title: place.name,
          text: `A light burns here. Something waits for you.`
        })
      }
      this.save()
    }
  }

  private updateCompass(): void {
    const p = this.player.position
    const yaw = this.follow.yaw
    const rel = (bearing: number): number => wrap(bearing - yaw)
    const marks: CompassMark[] = [
      { angle: rel(Math.PI), kind: 'cardinal', label: 'N' },
      { angle: rel(Math.PI / 2), kind: 'cardinal', label: 'E' },
      { angle: rel(0), kind: 'cardinal', label: 'S' },
      { angle: rel(-Math.PI / 2), kind: 'cardinal', label: 'W' },
      { angle: rel((Math.PI * 3) / 4), kind: 'minor', label: 'NE' },
      { angle: rel(Math.PI / 4), kind: 'minor', label: 'SE' },
      { angle: rel(-Math.PI / 4), kind: 'minor', label: 'SW' },
      { angle: rel((-Math.PI * 3) / 4), kind: 'minor', label: 'NW' }
    ]
    for (const s of this.world.shards) {
      if (s.collected) continue
      marks.push({
        angle: rel(Math.atan2(s.at.x - p.x, s.at.z - p.z)),
        kind: 'shard',
        distance: Math.hypot(s.at.x - p.x, s.at.z - p.z)
      })
    }
    const h = this.world.heart.center
    if (!this.progress.restored && this.progress.collected.length >= SHARD_COUNT) {
      marks.push({
        angle: rel(Math.atan2(h.x - p.x, h.z - p.z)),
        kind: 'heart',
        distance: Math.hypot(h.x - p.x, h.z - p.z)
      })
    }
    for (const w of this.world.wanderers) {
      const d = Math.hypot(w.position.x - p.x, w.position.z - p.z)
      if (d < 140 && d > 5)
        marks.push({
          angle: rel(Math.atan2(w.position.x - p.x, w.position.z - p.z)),
          kind: 'person'
        })
    }
    this.hud.setCompass(marks)
  }

  private updateObjective(): void {
    const s = this.spec.story
    const n = this.progress.collected.length
    if (this.progress.restored)
      this.hud.setObjective('Restored', `${this.spec.name} remembers. Wander as long as you like.`)
    else if (n >= SHARD_COUNT)
      this.hud.setObjective(`${n}/${SHARD_COUNT}`, `Bring them to ${s.finale.place}`)
    else
      this.hud.setObjective(
        `${n}/${SHARD_COUNT}`,
        `Find the ${pluralize(s.shardNoun)} of ${mid(s.relic)}`
      )
  }

  private addJournal(e: JournalEntry): void {
    if (this.progress.journal.some((j) => j.title === e.title && j.kind === e.kind)) return
    this.progress.journal.push(e)
  }

  save(): void {
    this.saveTimer = 0
    if (!this.player) return
    this.progress.player = {
      x: this.player.position.x,
      z: this.player.position.z,
      facing: this.player.facing
    }
    this.progress.explored = this.map.serialize()
    this.progress.distance = this.distanceAtLoad + this.player.distance
    storeSave({
      id: worldId(this.spec),
      spec: this.spec,
      progress: this.progress,
      updated: Date.now()
    })
  }

  resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
  }

  applySettings(s: Settings): void {
    this.settings = s
    this.follow.settings = { sensitivity: s.sensitivity, invertY: s.invertY }
  }

  /** Debug/test hook: teleport and inspect. Not part of normal play. */
  debug(): Record<string, unknown> {
    return {
      mode: this.mode,
      player: this.player.position.toArray(),
      shards: this.world.shards.map((s) => ({ at: s.at.toArray(), collected: s.collected })),
      heart: this.world.heart.center.toArray(),
      wanderers: this.world.wanderers.map((w) => w.position.toArray()),
      liquidY: this.world.terrain.liquidY,
      colliders: this.world.colliders.count,
      teleport: (x: number, z: number) => this.player.place(x, z, this.player.facing)
    }
  }

  dispose(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
    this.save()
    this.hud.hideDialogue()
    this.hud.setHint('')
    this.closePanels(false)
    this.hud.show(false)
    this.world.dispose()
  }
}
