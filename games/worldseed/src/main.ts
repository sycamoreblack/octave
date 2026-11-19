import * as THREE from 'three'
import { ACTIONS, ACTION_LABELS, DEFAULT_BINDINGS, Input, keyName } from './engine/input'
import { GamepadInput } from './engine/gamepad'
import { AudioEngine } from './engine/audio'
import { Rng } from './engine/rng'
import { Hud, esc } from './ui/hud'
import { Game } from './game/game'
import { EXAMPLE_PROMPTS, interpret, randomPrompt } from './world/interpreter'
import { normalizeSpec, type WorldSpec } from './world/spec'
import { claudeStatus, dreamWithClaude } from './story/ai'
import {
  decodeShare,
  deleteSave,
  encodeShare,
  listSaves,
  loadSave,
  loadSettings,
  storeSettings,
  worldId,
  type Progress,
  type Settings
} from './game/save'

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!

const canvas = $<HTMLCanvasElement>('#view')
let renderer: THREE.WebGLRenderer
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance'
  })
} catch {
  document.body.innerHTML = `<div style="padding:40px;font:18px/1.5 Georgia,serif;color:#eee;background:#111;height:100vh">
    Worldseed needs WebGL, which isn't available in this browser. Try a recent Chrome, Edge, Firefox or Safari.</div>`
  throw new Error('WebGL unavailable')
}
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const input = new Input(canvas)
const hud = new Hud()
const audio = new AudioEngine()
let settings: Settings = loadSettings()
audio.setVolume(settings.volume, settings.music)
input.bindings = { ...settings.bindings }

function applyAccessibility(): void {
  document.body.classList.toggle('a11y-large', settings.largeText)
  document.body.classList.toggle('a11y-contrast', settings.highContrast)
  document.body.classList.toggle('a11y-calm', settings.reduceMotion)
}
applyAccessibility()
let game: Game | null = null
let aiReady = false
/** Wanderers can hold free conversations (Claude, or the offline mock). */
let talkReady = false
let sharedSpec: unknown = null
let sharedPrompt = ''

// ---------------- title screen ----------------

const promptEl = $<HTMLTextAreaElement>('#prompt')
const beginBtn = $<HTMLButtonElement>('#begin')
const useAi = $<HTMLInputElement>('#use-ai')

function renderExamples(): void {
  const box = $('#examples')
  const pick = new Rng(Date.now() & 0xffff).shuffle([...EXAMPLE_PROMPTS]).slice(0, 4)
  box.innerHTML = pick
    .map((p) => `<button type="button" title="${esc(p)}">${esc(p)}</button>`)
    .join('')
  box.querySelectorAll('button').forEach(
    (b, i) =>
      (b.onclick = () => {
        promptEl.value = pick[i]
        promptEl.focus()
      })
  )
}

function renderRecent(): void {
  const box = $('#recent')
  const saves = listSaves()
  if (!saves.length) {
    box.innerHTML = ''
    return
  }
  box.innerHTML =
    `<h3>Your worlds</h3>` +
    saves
      .slice(0, 5)
      .map((s) => {
        const n = s.progress.collected.length
        const status = s.progress.restored ? 'restored' : `${n}/4 found`
        return `<div class="recent-item" data-id="${esc(s.id)}">
          <div class="meta"><b>${esc(s.spec.name)}</b><span>${esc(status)} · ${s.spec.source === 'claude' ? 'dreamed by Claude · ' : ''}“${esc(s.spec.prompt)}”</span></div>
          <button data-act="open">${s.progress.restored ? 'Revisit' : 'Continue'}</button>
          <button data-act="forget" class="forget" title="Forget this world" aria-label="Forget ${esc(s.spec.name)}">✕</button>
        </div>`
      })
      .join('')
  box.querySelectorAll<HTMLElement>('.recent-item').forEach((row) => {
    const id = row.dataset.id!
    row.querySelector<HTMLButtonElement>('[data-act=open]')!.onclick = () => {
      const save = loadSave(id)
      if (save)
        void startWorld(normalizeSpec(save.spec, interpret(save.spec.prompt)), save.progress)
    }
    row.querySelector<HTMLButtonElement>('[data-act=forget]')!.onclick = () => {
      deleteSave(id)
      renderRecent()
    }
  })
}

function showTitle(): void {
  $('#title').classList.remove('hidden')
  $('#title').classList.remove('over-world')
  renderRecent()
  renderExamples()
  beginBtn.disabled = false
  setTimeout(() => promptEl.focus(), 50)
}

async function begin(): Promise<void> {
  audio.unlock()
  const text = promptEl.value.trim() || randomPrompt(new Rng(Date.now()))
  promptEl.value = text
  beginBtn.disabled = true
  try {
    // A shared Claude world arrives as a full spec; use it if the prompt is untouched.
    if (sharedSpec && text === sharedPrompt) {
      const local = interpret(text)
      return await startWorld(
        normalizeSpec(sharedSpec, local),
        loadSave(worldId(normalizeSpec(sharedSpec, local)))?.progress ?? null
      )
    }
    const local = interpret(text)
    const wantClaude = aiReady && useAi.checked
    if (wantClaude) {
      const existing = loadSave(worldId({ ...local, source: 'claude' }))
      if (existing) return await startWorld(normalizeSpec(existing.spec, local), existing.progress)
      showLoading(text, 'Claude is dreaming your world', 0.04)
      const pulse = startDreamPulse()
      try {
        const spec = await dreamWithClaude(text, local)
        pulse()
        return await startWorld(spec, null)
      } catch (err) {
        pulse()
        console.warn('Claude generation failed, using the offline dreamer:', err)
        hud.toast(
          `Claude couldn't build this one (${esc(String((err as Error).message ?? err))}). Dreaming it offline instead.`
        )
      }
    }
    await startWorld(local, loadSave(worldId(local))?.progress ?? null)
  } finally {
    beginBtn.disabled = false
  }
}

/** Slowly creeps the bar while we wait on Claude, so the screen never looks frozen. */
function startDreamPulse(): () => void {
  let f = 0.04
  const phrases = [
    'Claude is dreaming your world',
    'Naming the places',
    'Writing down what was lost',
    'Choosing the colours of the sky',
    'Teaching the wanderers their lines'
  ]
  let i = 0
  const id = window.setInterval(() => {
    f = Math.min(0.5, f + (0.5 - f) * 0.06)
    if (Math.random() < 0.25) i = (i + 1) % phrases.length
    showLoading(null, phrases[i], f)
  }, 700)
  return () => clearInterval(id)
}

function showLoading(promptText: string | null, stage: string, f: number): void {
  $('#loading').classList.remove('hidden')
  if (promptText !== null) $('#loading .loading-prompt').textContent = `“${promptText}”`
  $('#loading .stage').textContent = stage
  $<HTMLElement>('#loading .bar i').style.width = `${Math.round(f * 100)}%`
}

async function startWorld(spec: WorldSpec, saved: Progress | null): Promise<void> {
  audio.unlock()
  if (game) {
    game.dispose()
    game = null
  }
  showLoading(spec.prompt, 'Raising the land', 0.5)
  const g = new Game(renderer, input, hud, audio, settings, spec)
  g.chatEnabled = talkReady
  try {
    await g.load(saved, (stage, f) => showLoading(null, stage, 0.5 + f * 0.5))
  } catch (err) {
    console.error(err)
    $('#loading').classList.add('hidden')
    hud.toast('Something went wrong building that world. Try another description.')
    showTitle()
    return
  }
  game = g
  ;(window as unknown as { __worldseed: unknown }).__worldseed = { game: g, spec }
  g.onExit = () => {
    g.dispose()
    game = null
    history.replaceState(null, '', location.pathname + location.search)
    showTitle()
  }
  g.onRebuild = (quality) => {
    settings = { ...settings, quality }
    storeSettings(settings)
    g.save()
    void startWorld(spec, g.progress)
  }
  g.onShare = () => void share()
  $('#title').classList.add('hidden')
  $('#loading').classList.add('hidden')
  await g.begin(!saved)
}

async function share(): Promise<void> {
  if (!game) return
  const url = location.origin + location.pathname + (await encodeShare(game.spec))
  history.replaceState(null, '', url)
  try {
    await navigator.clipboard.writeText(url)
    hud.toast('Link copied. Anyone who opens it walks the same world.')
  } catch {
    hud.toast(
      `Share this link: <b>${esc(url.length > 80 ? url.slice(0, 80) + '…' : url)}</b> (it's also in the address bar)`
    )
  }
}

beginBtn.onclick = () => void begin()
$<HTMLButtonElement>('#surprise').onclick = () => {
  promptEl.value = randomPrompt(new Rng((Date.now() ^ (Math.random() * 1e9)) >>> 0))
  void begin()
}
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void begin()
  }
})
useAi.onchange = () => {
  settings = { ...settings, useClaude: useAi.checked }
  storeSettings(settings)
}

// ---------------- pause menu & settings ----------------

const qualitySel = $<HTMLSelectElement>('#set-quality')
const volume = $<HTMLInputElement>('#set-volume')
const music = $<HTMLInputElement>('#set-music')
const sens = $<HTMLInputElement>('#set-sens')
const invert = $<HTMLInputElement>('#set-invert')
const autoQ = $<HTMLInputElement>('#set-auto')
const large = $<HTMLInputElement>('#set-large')
const contrast = $<HTMLInputElement>('#set-contrast')
const calm = $<HTMLInputElement>('#set-calm')
autoQ.checked = settings.autoQuality
large.checked = settings.largeText
contrast.checked = settings.highContrast
calm.checked = settings.reduceMotion
qualitySel.value = settings.quality
volume.value = String(settings.volume)
music.value = String(settings.music)
sens.value = String(settings.sensitivity)
invert.checked = settings.invertY
$('#quality-note').textContent = 'Changing quality rebuilds the world. Your progress is kept.'

function updateSettings(): void {
  settings = {
    ...settings,
    volume: +volume.value,
    music: +music.value,
    sensitivity: +sens.value,
    invertY: invert.checked,
    autoQuality: autoQ.checked,
    largeText: large.checked,
    highContrast: contrast.checked,
    reduceMotion: calm.checked
  }
  storeSettings(settings)
  audio.setVolume(settings.volume, settings.music)
  applyAccessibility()
  game?.applySettings(settings)
}
for (const el of [volume, music, sens, invert, autoQ, large, contrast, calm])
  el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', updateSettings)
qualitySel.onchange = () => {
  const q = qualitySel.value as Settings['quality']
  // Choosing a quality by hand means the player wants that one: stop auto-adjusting.
  autoQ.checked = false
  settings = { ...settings, autoQuality: false }
  storeSettings(settings)
  if (game) game.onRebuild?.(q)
  else {
    settings = { ...settings, quality: q }
    storeSettings(settings)
  }
}

$<HTMLButtonElement>('#resume').onclick = () => {
  game?.pause(false)
  game?.canvasClicked()
}
$<HTMLButtonElement>('#open-journal').onclick = () => game?.togglePanel('journal')
$<HTMLButtonElement>('#open-map').onclick = () => game?.togglePanel('map')
$<HTMLButtonElement>('#share').onclick = () => void share()
$<HTMLButtonElement>('#photo').onclick = () => {
  game?.closePanels()
  game?.setPhoto(true)
}

// ---------------- key remapping ----------------

let listening: { action: (typeof ACTIONS)[number]; el: HTMLButtonElement } | null = null

function renderBindings(): void {
  const box = $('#bindings')
  box.innerHTML = ACTIONS.map(
    (a) =>
      `<span>${esc(ACTION_LABELS[a])}</span><button type="button" data-action="${a}" aria-label="${esc(ACTION_LABELS[a])}: ${esc(keyName(settings.bindings[a]))}. Press to change.">${esc(keyName(settings.bindings[a]))}</button>`
  ).join('')
  box.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.onclick = () => {
      listening?.el.classList.remove('listening')
      listening = { action: b.dataset.action as (typeof ACTIONS)[number], el: b }
      b.classList.add('listening')
      b.textContent = 'Press a key…'
    }
  })
}

function setBindings(next: Settings['bindings']): void {
  settings = { ...settings, bindings: next }
  input.bindings = { ...next }
  storeSettings(settings)
  renderBindings()
}

// Capture the next key for a binding before anything else sees it.
window.addEventListener(
  'keydown',
  (e) => {
    if (!listening) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const { action } = listening
    listening = null
    if (e.code === 'Escape' || e.code === 'KeyP') return renderBindings()
    const next = { ...settings.bindings }
    // If another action had this key, it takes this action's old key (a swap).
    const clash = ACTIONS.find((a) => a !== action && next[a] === e.code)
    if (clash) next[clash] = next[action]
    next[action] = e.code
    setBindings(next)
  },
  true
)
$<HTMLButtonElement>('#reset-keys').onclick = () => setBindings({ ...DEFAULT_BINDINGS })
renderBindings()

// ---------------- controllers ----------------

const pad = new GamepadInput(input)
pad.uiRoot = () => {
  const visible = (sel: string): HTMLElement | null => {
    const el = document.querySelector<HTMLElement>(sel)
    return el && !el.classList.contains('hidden') ? el : null
  }
  return (
    visible('#card') ??
    visible('#pause') ??
    visible('#journal') ??
    visible('#map') ??
    (visible('#loading') ? document.createElement('div') : null) ??
    visible('#title')
  )
}
pad.onTitleConfirm = () => void begin()
pad.onConnect = () =>
  hud.toast(
    'Controller connected. Left stick moves, right stick looks, <b>A</b> jumps, <b>X</b> interacts.'
  )
$<HTMLButtonElement>('#new-world').onclick = () => game?.onExit?.()
$<HTMLButtonElement>('#touch-menu').addEventListener('touchstart', (e) => {
  e.preventDefault()
  game?.pause(true)
})
document
  .querySelectorAll<HTMLButtonElement>('[data-close]')
  .forEach((b) => (b.onclick = () => game?.closePanels()))

canvas.addEventListener('click', () => game?.canvasClicked())
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement) game?.onPointerUnlock()
})
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  game?.resize()
})
document.addEventListener('visibilitychange', () => {
  audio.suspend(document.hidden)
  if (document.hidden) game?.save()
})
window.addEventListener('beforeunload', () => game?.save())

// ---------------- boot ----------------

async function boot(): Promise<void> {
  renderExamples()
  renderRecent()
  const shared = await decodeShare(location.hash)
  if (shared.prompt) {
    promptEl.value = shared.prompt
  } else if (shared.spec) {
    sharedSpec = shared.spec
    const p = (shared.spec as { prompt?: unknown }).prompt
    sharedPrompt = typeof p === 'string' ? p : ''
    promptEl.value = sharedPrompt
  }
  if (shared.prompt || shared.spec)
    $('.tag').textContent = 'Someone shared a world with you. Press Begin to walk into it.'
  const status = await claudeStatus()
  aiReady = status.ai
  talkReady = status.talk
  if (game) game.chatEnabled = talkReady
  if (aiReady) {
    $('#ai-row').hidden = false
    useAi.checked = settings.useClaude
  }
  promptEl.focus()
}
void boot()
