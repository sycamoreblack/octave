import * as THREE from 'three'
import { Input, type Action } from '../engine/input'
import { AudioEngine, type Ambience } from '../engine/audio'
import { World, QUALITY, type ShardNode } from '../world/world'
import { ECHO_COUNT, QUEST_COUNT, SHARD_COUNT, type WorldSpec } from '../world/spec'
import type { Waystone } from '../world/objectives'
import { pluralize } from '../story/narrator'
import { talkToWanderer, type TalkPayload } from '../story/ai'
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

type Mode = 'loading' | 'playing' | 'card' | 'journal' | 'map' | 'paused' | 'photo' | 'chat'

type Target =
  | { kind: 'shard'; node: ShardNode }
  | { kind: 'wanderer'; index: number }
  | { kind: 'heart' }
  | { kind: 'stone'; node: ShardNode; stone: Waystone; id: string }
  | { kind: 'item'; index: number }

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

/** Real minutes for a full day when time passes. */
export const DAY_MINUTES = 20

const howFar = (d: number): string =>
  d < 160 ? 'not far' : d < 380 ? 'a fair walk' : 'a long way off'

function timeWord(t: number): string {
  if (t < 0.17 || t > 0.86) return 'night'
  if (t < 0.32) return 'dawn'
  if (t < 0.62) return 'day'
  if (t < 0.7) return 'late afternoon'
  return 'dusk'
}

/** "The Harvest Bell" → "the Harvest Bell", for use mid-sentence. */
const mid = (s: string): string => s.replace(/^The /, 'the ')
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

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
    this.world.reduceFlashes = this.settings.reduceMotion

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
      invertY: this.settings.invertY,
      autoFollow: !this.settings.reduceMotion
    })
    this.map = new WorldMap(this.world)

    this.progress = saved ? { ...emptyProgress(), ...saved } : emptyProgress()
    this.distanceAtLoad = this.progress.distance
    const { spawn } = this.world.layout
    const pp = this.progress.player
    this.player.place(pp?.x ?? spawn.x, pp?.z ?? spawn.z, pp?.facing ?? spawn.yaw)
    this.follow.snap(this.player.facing)
    this.map.restore(this.progress.explored)
    if (
      typeof this.progress.timeOfDay === 'number' &&
      Math.abs(this.progress.timeOfDay - this.spec.timeOfDay) > 1e-4
    )
      this.setHour(this.progress.timeOfDay)
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
    for (const node of this.world.shards) {
      node.stones.forEach((stone, k) => {
        if (p.stones.includes(`${node.index}-${k}`)) stone.wake(true)
      })
      if (node.collected || node.stones.every((s) => s.awake)) node.seal.break(true)
    }
    for (const i of p.found) this.world.items[i]?.take(true)
    for (const i of p.echoes) this.world.echoes[i]?.take(true)
    for (const place of this.world.places)
      if (p.discovered.includes(place.name)) place.discovered = true
    for (const i of p.met) if (this.world.wanderers[i]) this.world.wanderers[i].met = true
    if (p.restored) {
      this.world.restoration = 1
      this.world.gatherWanderers()
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
      this.hud.toast(this.controlsHint())
      this.hud.toast(`Follow the pillars of light. Someone nearby might have advice.`)
    } else {
      this.mode = 'playing'
      this.hud.showBanner('You return to', this.spec.name, 4)
    }
    this.save()
  }

  /** A one-line how-to-play, worded for whatever the player is holding. */
  private controlsHint(): string {
    const i = this.input
    if (i.device === 'pad')
      return 'Left stick to move, right stick to look. <b>A</b> to jump (hold to glide), <b>X</b> to interact, <b>R3</b> for photos.'
    if (i.touchActive || matchMedia('(pointer: coarse)').matches)
      return 'Drag on the left to move, on the right to look. Tap <b>E</b> to interact.'
    const move = [i.label('forward'), i.label('left'), i.label('back'), i.label('right')].join('')
    return `Click to look around. <b>${esc(move)}</b> to move, <b>${esc(i.label('jump'))}</b> to jump (hold to glide), <b>${esc(i.label('interact'))}</b> to interact.`
  }

  private key(action: Action): string {
    return `<kbd>${esc(this.input.label(action))}</kbd>`
  }

  private loop = (): void => {
    if (!this.running) return
    this.raf = requestAnimationFrame(this.loop)
    const raw = this.clock.getDelta()
    const dt = Math.min(0.05, raw)
    this.time += dt
    this.watchPerformance(raw)
    this.update(dt)
    this.renderer.render(this.world.scene, this.camera)
    this.input.endFrame()
  }

  private update(dt: number): void {
    const t = this.time
    const playing = this.mode === 'playing'
    const photo = this.mode === 'photo'
    // In photo mode the camera still listens to look and zoom, but the player stands still.
    this.input.enabled = playing || photo
    this.handleGlobalKeys()

    if (playing) this.progress.playTime += dt
    if (this.settings.timePasses && (playing || photo || this.mode === 'chat'))
      this.setHour(this.world.timeOfDay + dt / (DAY_MINUTES * 60))
    if (!photo) this.player.update(dt, t, this.input, this.follow.yaw)
    const speed = Math.hypot(this.player.velocity.x, this.player.velocity.z)
    this.follow.update(dt, this.input, this.player.position, this.player.facing, speed)
    this.world.update(t, dt, this.camera, this.player.position)

    if (this.collecting) this.updateCollect(dt)
    if (this.finale) this.updateFinale(dt)

    this.checkTimer -= dt
    if (this.checkTimer <= 0) {
      this.checkTimer = 0.25
      if (playing) this.checkDiscoveries()
      this.audio.setAmbience(this.ambience())
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
    // Global keys work in every mode, so read them regardless of input.enabled.
    const hit = (a: Action): boolean => this.input.hitAlways(a)
    if (this.mode === 'card' || this.mode === 'loading' || this.mode === 'chat') return
    if (this.mode === 'photo') {
      if (hit('photo') || hit('pause')) this.setPhoto(false)
      else if (hit('jump')) void this.capture()
      else if (this.input.pressed('KeyH')) this.player.object.visible = !this.player.object.visible
      return
    }
    if (hit('journal')) this.togglePanel('journal')
    else if (hit('map')) this.togglePanel('map')
    else if (hit('pause')) {
      if (this.mode === 'playing') this.pause(true)
      // The Escape that released pointer lock may also arrive as a keypress: don't let it un-pause.
      else if (performance.now() - this.pausedAt > 300) this.closePanels()
    } else if (hit('photo') && this.mode === 'playing') this.setPhoto(true)
    else if (this.talking && this.canChat() && this.input.pressed('Enter', 'NumpadEnter'))
      this.enterChat(this.talking.index)
    else if (hit('interact') && this.mode === 'playing') this.interact()
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
        `${this.spec.name} — ${Math.round(this.map.exploredFraction * 100)}% explored · ${this.progress.echoes.length}/${ECHO_COUNT} echoes`
      const pins = this.world.items
        .map((it, i) => ({ it, i }))
        .filter(({ it, i }) => !it.taken && this.progress.asked.includes(i))
        .map(({ it, i }) => ({
          x: it.at.x,
          z: it.at.z,
          label: this.spec.story.quests[i]?.item ?? ''
        }))
      this.map.draw(canvas, this.player.position, this.player.facing, this.progress.met, pins)
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
      if (this.input.device === 'pad') document.getElementById('resume')?.focus()
      this.save()
    } else this.closePanels()
  }

  closePanels(resume = true): void {
    // Any open menu ends a conversation; it would otherwise sit behind the panel.
    if (!resume || this.mode === 'playing' || this.mode === 'chat') {
      this.talking = null
      this.hud.hideDialogue()
    }
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
    if (this.mode === 'playing' || this.mode === 'photo') this.input.requestLock()
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
    for (const node of this.world.shards) {
      node.stones.forEach((stone, k) => {
        if (stone.awake) return
        const d = Math.hypot(stone.at.x - p.x, stone.at.z - p.z)
        if (d < 3.4 && d < bestD) {
          best = { kind: 'stone', node, stone, id: `${node.index}-${k}` }
          bestD = d
        }
      })
    }
    this.world.items.forEach((item, i) => {
      if (item.taken) return
      const d = Math.hypot(item.at.x - p.x, item.at.z - p.z)
      if (d < 3 && d < bestD) {
        best = { kind: 'item', index: i }
        bestD = d
      }
    })
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
    const key = this.key('interact')
    if (t.kind === 'shard') {
      if (t.node.seal.sealed) {
        const awake = t.node.stones.filter((s) => s.awake).length
        return `Sealed. Wake the waystones nearby (${awake}/${t.node.stones.length})`
      }
      return `${key} Take ${esc(mid(this.spec.story.shards[t.node.index].name))}`
    }
    if (t.kind === 'stone') return `${key} Wake the waystone`
    if (t.kind === 'item')
      return `${key} Pick up ${esc(this.spec.story.quests[t.index]?.item ?? 'something')}`
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
    if (t.kind === 'shard') {
      if (t.node.seal.sealed)
        this.hud.toast('A shimmering seal holds it fast. Look for the waystones around this place.')
      else this.startCollect(t.node)
    } else if (t.kind === 'stone') this.wakeStone(t.node, t.stone, t.id)
    else if (t.kind === 'item') this.takeItem(t.index)
    else if (t.kind === 'wanderer') this.startTalk(t.index)
    else if (this.progress.collected.length >= SHARD_COUNT) this.startFinale()
  }

  private startTalk(index: number): void {
    const w = this.world.wanderers[index]
    const first = !w.met
    const lines: string[] = first ? [...w.story.lines] : []
    const request = this.requestLine(index)
    if (request) lines.push(request)
    lines.push(this.hintLine(w.position))
    this.talking = { index, line: 0, lines }
    this.hud.showDialogue(w.story.name, w.story.epithet, lines[0], this.input.label('interact'))
    this.offerChat(index)
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
    this.save()
  }

  /** What a wanderer says about the thing they lost, advancing the request as a side effect. */
  private requestLine(index: number): string | null {
    const q = this.spec.story.quests[index]
    const place = this.spec.story.places[index]?.name
    if (!q || !place || index >= QUEST_COUNT) return null
    const fill = (s: string): string => s.replace(/\{place\}/g, place)
    const w = this.world.wanderers[index]
    const p = this.progress
    if (p.returned.includes(index))
      return `Thank you again for ${q.item}. I keep checking it's still there.`
    if (p.found.includes(index)) {
      p.returned.push(index)
      if (!p.asked.includes(index)) p.asked.push(index)
      this.audio.chime()
      this.addJournal({
        kind: 'request',
        title: `${cap(q.item)}, returned to ${w.story.name}`,
        text: fill(q.thanks)
      })
      this.giveReward(w.story.name)
      this.updateCarry()
      return fill(q.thanks)
    }
    if (!p.asked.includes(index)) {
      p.asked.push(index)
      this.addJournal({
        kind: 'request',
        title: `${w.story.name} lost ${q.item}`,
        text: fill(q.ask)
      })
      this.hud.toast(
        `<b>${esc(w.story.name)}</b> lost ${esc(q.item)} near <b>${esc(place)}</b>. It's marked on your map.`
      )
      return fill(q.ask)
    }
    return `Any luck near ${place}? It's ${q.item}. You'll know it when you see it… I hope.`
  }

  /** A returned favour: the wanderer marks somewhere you haven't been on your map. */
  private giveReward(name: string): void {
    const p = this.player.position
    const shardTargets = this.world.shards
      .filter((s) => !s.collected && !this.world.places[s.index]?.discovered)
      .map((s) => ({ at: s.at, name: this.spec.story.shards[s.index].place }))
    const minorTargets = this.world.places
      .filter((pl) => pl.kind === 'minor' && !pl.discovered)
      .map((pl) => ({ at: pl.at, name: pl.name }))
    const pool = shardTargets.length ? shardTargets : minorTargets
    if (!pool.length) return
    const best = pool.reduce((a, b) => (a.at.distanceTo(p) < b.at.distanceTo(p) ? a : b))
    this.map.reveal(best.at.x, best.at.z, 140)
    this.progress.explored = this.map.serialize()
    this.hud.toast(
      `<b>${esc(name)}</b> marked <b>${esc(best.name)}</b> on your map. Press <b>${esc(this.input.label('map'))}</b> to look.`
    )
  }

  private wakeStone(node: ShardNode, stone: Waystone, id: string): void {
    stone.wake()
    if (!this.progress.stones.includes(id)) this.progress.stones.push(id)
    const awake = node.stones.filter((s) => s.awake).length
    this.audio.wake(awake)
    if (awake >= node.stones.length) {
      node.seal.break()
      this.audio.chime()
      this.hud.toast(
        `The seal around <b>${esc(mid(this.spec.story.shards[node.index].name))}</b> breaks.`
      )
    } else {
      this.hud.toast(`A waystone wakes (${awake}/${node.stones.length}).`)
    }
    this.save()
  }

  private takeItem(index: number): void {
    const item = this.world.items[index]
    const q = this.spec.story.quests[index]
    if (!item || item.taken || !q) return
    item.take()
    this.progress.found.push(index)
    this.audio.discover()
    const w = this.world.wanderers[index]
    this.hud.toast(
      this.progress.asked.includes(index)
        ? `You found ${esc(q.item)}. <b>${esc(w.story.name)}</b> will be glad.`
        : `You found ${esc(q.item)}. Someone must be missing it.`
    )
    this.updateCarry()
    this.save()
  }

  private updateCarry(): void {
    const carrying = this.progress.found
      .filter((i) => !this.progress.returned.includes(i))
      .map((i) => this.spec.story.quests[i]?.item)
      .filter(Boolean)
    this.hud.setCarry(carrying.length ? `Carrying ${carrying.join(', ')}` : '')
  }

  private advanceTalk(): void {
    if (!this.talking) return
    this.talking.line++
    if (this.talking.line >= this.talking.lines.length) {
      // With a conversation server, the scripted lines lead into free talk (keyboard/touch only).
      this.talking = null
      this.hud.hideDialogue()
      return
    }
    const w = this.world.wanderers[this.talking.index]
    this.hud.showDialogue(
      w.story.name,
      w.story.epithet,
      this.talking.lines[this.talking.line],
      this.input.label('interact')
    )
    this.audio.blip()
    this.offerChat(this.talking.index)
  }

  // ---------------- free conversation ----------------

  /** Set by main.ts when the server can hold conversations (Claude, or the offline mock). */
  chatEnabled = false
  private chatBusy = false

  private canChat(): boolean {
    return this.chatEnabled && this.input.device !== 'pad'
  }

  /** While a wanderer is talking, offer to talk back (Enter, or the button on touch). */
  private offerChat(index: number): void {
    const btn = document.getElementById('say-open') as HTMLButtonElement
    btn.classList.toggle('hidden', !this.canChat())
    btn.onclick = () => this.enterChat(index)
    if (this.canChat()) this.hud.setMore(`${this.input.label('interact')} ▸ · Enter to talk`)
  }

  private enterChat(index: number): void {
    document.getElementById('say-open')!.classList.add('hidden')
    this.mode = 'chat'
    this.unlockPointer()
    const w = this.world.wanderers[index]
    this.hud.setMore('Enter to speak · Esc to walk on')
    this.hud.showSay(true)
    const input = document.getElementById('say-input') as HTMLInputElement
    input.placeholder = `Say something to ${w.story.name}…`
    const form = document.getElementById('say') as HTMLFormElement
    form.onsubmit = (e) => {
      e.preventDefault()
      const text = input.value.trim()
      if (!text) return this.exitChat()
      void this.say(index, text)
    }
    input.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        this.exitChat()
      }
    }
  }

  private exitChat(): void {
    if (this.mode !== 'chat') return
    this.talking = null
    this.hud.hideDialogue()
    this.mode = 'playing'
    this.save()
  }

  private async say(index: number, text: string): Promise<void> {
    if (this.chatBusy) return
    this.chatBusy = true
    const w = this.world.wanderers[index]
    const input = document.getElementById('say-input') as HTMLInputElement
    input.value = ''
    input.disabled = true
    this.hud.setYouSaid(text)
    this.hud.setLine('…', true)
    const history = (this.progress.chats[index] ??= [])
    try {
      const reply = await talkToWanderer(this.talkPayload(index, text), (soFar) =>
        this.hud.setLine(soFar)
      )
      this.hud.setLine(reply || '…')
      this.audio.blip()
      history.push({ role: 'user', text }, { role: 'assistant', text: reply || '…' })
      // Keep the last few exchanges: enough for continuity, small enough to send each time.
      if (history.length > 16) history.splice(0, history.length - 16)
    } catch (err) {
      this.hud.setLine(`${w.story.name} looks at you for a long moment, lost in thought.`)
      this.hud.toast(
        `Couldn't reach the storyteller: ${esc(String((err as Error).message ?? err))}`
      )
    } finally {
      this.chatBusy = false
      if (this.mode === 'chat') {
        input.disabled = false
        input.focus()
      }
    }
  }

  /** Everything a wanderer knows, from where they stand, for the conversation server. */
  private talkPayload(index: number, message: string): TalkPayload {
    const s = this.spec.story
    const w = this.world.wanderers[index]
    const from = w.position
    const p = this.progress
    const q = s.quests[index]
    const h = this.world.heart.center
    const state = p.returned.includes(index)
      ? 'returned'
      : p.found.includes(index)
        ? 'found'
        : p.asked.includes(index)
          ? 'asked'
          : 'unasked'
    return {
      world: {
        name: this.spec.name,
        prompt: this.spec.prompt,
        biome: this.spec.biome,
        mood: this.spec.mood,
        timeOfDay: timeWord(this.world.timeOfDay),
        weather: this.spec.weather,
        relic: s.relic,
        shardNoun: s.shardNoun,
        goal: s.goal,
        heart: s.finale.place,
        restored: p.restored,
        prologue: s.prologue,
        places: [
          ...s.places.map((pl) => pl.name),
          ...s.shards.map((sh) => sh.place),
          s.finale.place
        ],
        lights: this.world.shards.map((n) => ({
          name: s.shards[n.index].name,
          place: s.shards[n.index].place,
          taken: n.collected,
          direction: compassWord(n.at.x - from.x, n.at.z - from.z),
          distance: howFar(n.at.distanceTo(from))
        })),
        heartDirection: `${compassWord(h.x - from.x, h.z - from.z)} of here, ${howFar(h.distanceTo(from))}`
      },
      wanderer: {
        name: w.story.name,
        epithet: w.story.epithet,
        lines: w.story.lines,
        request:
          q && index < QUEST_COUNT
            ? { item: q.item, place: s.places[index]?.name ?? '', state }
            : null,
        others: this.world.wanderers.filter((o) => o !== w).map((o) => o.story.name)
      },
      player: { role: s.role, found: p.collected.length, total: SHARD_COUNT },
      history: (p.chats[index] ?? []).slice(-12),
      message
    }
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
    const how = howFar(d)
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
    this.world.gatherWanderers()
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
      <div><b>${this.progress.returned.length}/${QUEST_COUNT}</b>lost things returned</div>
      <div><b>${this.progress.echoes.length}/${ECHO_COUNT}</b>echoes heard</div>
    </div>`
    // Each wanderer you helped gets a line about how their story ends.
    const fates = this.progress.returned
      .slice()
      .sort()
      .map((i) => s.quests[i]?.after.replace(/\{place\}/g, s.places[i]?.name ?? ''))
      .filter((x): x is string => !!x)
    const epilogue = [s.epilogue[0], ...fates, ...s.epilogue.slice(1)].filter(Boolean)
    const choice = await this.hud.showCard({
      kicker: 'Epilogue',
      title: s.title,
      paragraphs: epilogue,
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
    this.world.echoes.forEach((echo, i) => {
      if (echo.taken) return
      if (Math.hypot(echo.at.x - p.x, echo.at.z - p.z) > 2.6 || Math.abs(echo.at.y - p.y) > 4)
        return
      echo.take()
      this.progress.echoes.push(i)
      const line = this.spec.story.echoes[i] ?? ''
      this.audio.echo()
      this.hud.toast(`<i>“${esc(line)}”</i> <b>${this.progress.echoes.length}/${ECHO_COUNT}</b>`)
      this.addJournal({ kind: 'echo', title: `Echo ${this.progress.echoes.length}`, text: line })
      this.save()
    })
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
    const bearing = (x: number, z: number): number => rel(Math.atan2(x - p.x, z - p.z))
    for (const s of this.world.shards) {
      if (s.collected || !s.seal.sealed) continue
      for (const st of s.stones) {
        const d = Math.hypot(st.at.x - p.x, st.at.z - p.z)
        if (!st.awake && d < 90 && d > 3)
          marks.push({ angle: bearing(st.at.x, st.at.z), kind: 'stone', distance: d })
      }
    }
    this.world.items.forEach((it, i) => {
      if (it.taken || !this.progress.asked.includes(i)) return
      const d = Math.hypot(it.at.x - p.x, it.at.z - p.z)
      marks.push({ angle: bearing(it.at.x, it.at.z), kind: 'item', distance: d })
    })
    for (const e of this.world.echoes) {
      if (e.taken) continue
      const d = Math.hypot(e.at.x - p.x, e.at.z - p.z)
      if (d < 55 && d > 3) marks.push({ angle: bearing(e.at.x, e.at.z), kind: 'echo' })
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
    this.updateCarry()
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
    this.progress.timeOfDay = this.world.timeOfDay
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
    this.follow.settings = {
      sensitivity: s.sensitivity,
      invertY: s.invertY,
      autoFollow: !s.reduceMotion
    }
    this.world.reduceFlashes = s.reduceMotion
    if (!s.autoQuality) this.perf.samples = []
  }

  /** Jump (or step) to a time of day, updating everything that depends on light. */
  setHour(t: number): void {
    this.world.setTime(t)
    const night = this.world.sky.night
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(1.1, 1.4, night)
    this.player?.setLamp(night > 0.5 || this.spec.weather === 'storm')
  }

  // ---------------- adaptive quality ----------------

  /** How far we've stepped down: 0 = as configured. */
  private perf = { samples: [] as number[], level: 0, settledAt: 0 }

  /**
   * Watch real frame times; if a device can't keep ~28 fps, step down resolution and
   * then shadows, a step at a time. Never steps up, so it can't oscillate.
   */
  private watchPerformance(raw: number): void {
    if (!this.settings.autoQuality || this.mode !== 'playing' || this.time < 4) return
    if (this.time < this.perf.settledAt) return
    this.perf.samples.push(raw)
    if (this.perf.samples.length < 90) return
    const sorted = [...this.perf.samples].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    this.perf.samples = []
    if (median < 1 / 28 || this.perf.level >= 3) return
    this.perf.level++
    const q = QUALITY[this.settings.quality]
    const ratio = [q.pixelRatio, Math.min(q.pixelRatio, 1.25), 1, 0.75][this.perf.level]
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, ratio))
    if (this.perf.level >= 2 && this.world.sun.castShadow) {
      this.world.sun.castShadow = false
      this.renderer.shadowMap.enabled = false
      this.world.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
        for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.needsUpdate = true
      })
    }
    // Give the new settings a moment before judging again.
    this.perf.settledAt = this.time + 3
    if (this.perf.level === 1)
      this.hud.toast(
        'Lowered the rendering detail to keep things smooth. You can turn this off in Settings.'
      )
  }

  // ---------------- photo mode ----------------

  setPhoto(on: boolean): void {
    if (on === (this.mode === 'photo')) return
    this.mode = on ? 'photo' : 'playing'
    this.follow.free = on
    this.hud.show(!on)
    document.body.classList.toggle('photo', on)
    document.getElementById('photo-bar')!.classList.toggle('hidden', !on)
    if (on) {
      const pad = this.input.device === 'pad'
      document.getElementById('photo-keys')!.innerHTML = pad
        ? `${this.key('jump')} save photo · ${this.key('photo')} or ${this.key('pause')} exit · right stick to orbit, <kbd>LB</kbd>/<kbd>RB</kbd> to zoom`
        : `${this.key('jump')} save photo · <kbd>H</kbd> hide yourself · ${this.key('photo')} or ${this.key('pause')} exit · move the mouse to orbit, scroll to zoom`
      this.hud.setHint('')
      this.hud.hideDialogue()
      this.talking = null
    } else {
      this.player.object.visible = true
    }
  }

  /** Save the current view as a PNG with the world's name in the corner. */
  private async capture(): Promise<void> {
    this.renderer.render(this.world.scene, this.camera)
    const src = this.renderer.domElement
    const out = document.createElement('canvas')
    out.width = src.width
    out.height = src.height
    const ctx = out.getContext('2d')!
    // Read the WebGL canvas in the same task as the render, before the buffer is cleared.
    ctx.drawImage(src, 0, 0)
    const h = out.height
    const pad = Math.round(h * 0.035)
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = h * 0.01
    ctx.fillStyle = '#fff6e6'
    ctx.font = `600 ${Math.round(h * 0.05)}px "Cormorant Garamond", Georgia, serif`
    ctx.fillText(this.spec.name, pad, h - pad - h * 0.035)
    ctx.font = `italic 500 ${Math.round(h * 0.024)}px "Cormorant Garamond", Georgia, serif`
    ctx.fillStyle = 'rgba(255,246,230,0.85)'
    const prompt =
      this.spec.prompt.length > 110 ? this.spec.prompt.slice(0, 108) + '…' : this.spec.prompt
    ctx.fillText(`“${prompt}”`, pad, h - pad)
    const flash = document.getElementById('photo-flash')!
    flash.classList.remove('go')
    void flash.offsetWidth
    flash.classList.add('go')
    this.audio.discover()
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'))
    if (!blob) return
    const slug =
      this.spec.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'world'
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `worldseed-${slug}-${Date.now().toString(36)}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
    document.getElementById('photo-status')!.textContent = `Saved ${a.download}`
    this.lastPhoto = a.download
  }

  /** Name of the last photo saved (for tests). */
  lastPhoto = ''

  // ---------------- ambience ----------------

  /** Sample the player's surroundings for the place-dependent soundscape. */
  private ambience(): Ambience {
    const p = this.player.position
    const t = this.world.terrain
    let wet = 0
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      if (t.groundAt(p.x + Math.cos(a) * 30, p.z + Math.sin(a) * 30) < t.liquidY - 0.5) wet++
    }
    // A river close by sounds like gentle surf.
    const river = t.riversDry ? null : t.rivers.nearest(p.x, p.z)
    const riverNear = river ? 1 - Math.min(1, Math.max(0, (river.d - river.width) / 25)) : 0
    const nearLiquid = Math.max(wet / 8, riverNear * 0.6)
    const liquid = this.spec.liquid
    const grassy =
      this.spec.flora.kinds.some((k) => k === 'grass' || k === 'flower' || k === 'reeds') &&
      !['desert', 'volcanic', 'tundra'].includes(this.spec.biome)
    return {
      coast:
        liquid === 'water' || liquid === 'murk' ? nearLiquid * (liquid === 'murk' ? 0.4 : 1) : 0,
      lava: liquid === 'lava' ? Math.max(nearLiquid, 0.15) : 0,
      night: this.world.night,
      crickets: grassy && this.spec.weather !== 'snow' && this.spec.weather !== 'storm',
      frogs: this.spec.biome === 'swamp',
      birds: this.spec.creatures.includes('birds') && grassy && this.spec.weather !== 'storm'
    }
  }

  /** Debug/test hook: teleport and inspect. Not part of normal play. */
  debug(): Record<string, unknown> {
    return {
      mode: this.mode,
      player: this.player.position.toArray(),
      shards: this.world.shards.map((s) => ({ at: s.at.toArray(), collected: s.collected })),
      heart: this.world.heart.center.toArray(),
      wanderers: this.world.wanderers.map((w) => w.position.toArray()),
      stones: this.world.shards.map((s) => s.stones.map((w) => w.at.toArray())),
      items: this.world.items.map((it) => it.at.toArray()),
      echoes: this.world.echoes.map((e) => e.at.toArray()),
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
