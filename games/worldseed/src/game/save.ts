import { DEFAULT_BINDINGS, type Bindings } from '../engine/input'
import type { WorldSpec } from '../world/spec'

/**
 * Progress lives in localStorage, keyed per world. Every read and write is guarded:
 * private windows and blocked storage just mean nothing is remembered.
 */
export interface JournalEntry {
  kind: 'story' | 'shard' | 'place' | 'person' | 'finale' | 'request' | 'echo'
  title: string
  text: string
}

export interface Progress {
  collected: number[]
  discovered: string[]
  met: number[]
  restored: boolean
  journal: JournalEntry[]
  player: { x: number; z: number; facing: number } | null
  explored: string
  playTime: number
  distance: number
  /** Woken waystones, as "shard-stone" ids. */
  stones: string[]
  /** Echo indices heard. */
  echoes: number[]
  /** Quest indices (= wanderer indices): asked about, item found, item returned. */
  asked: number[]
  found: number[]
  returned: number[]
  /** Recent free conversation with each wanderer, keyed by wanderer index. */
  chats: Record<string, { role: 'user' | 'assistant'; text: string }[]>
}

export interface SaveEntry {
  id: string
  spec: WorldSpec
  progress: Progress
  updated: number
}

export interface Settings {
  quality: 'low' | 'medium' | 'high'
  volume: number
  music: number
  sensitivity: number
  invertY: boolean
  useClaude: boolean
  /** Lower resolution/shadows automatically if frames are slow. */
  autoQuality: boolean
  largeText: boolean
  highContrast: boolean
  /** Fewer flashes and less automatic camera movement. */
  reduceMotion: boolean
  bindings: Bindings
}

const SAVES = 'worldseed.saves.v1'
const SETTINGS = 'worldseed.settings.v1'
const MAX_SAVES = 8

export const worldId = (spec: WorldSpec): string => `${spec.source}-${spec.seed.toString(36)}`

export function emptyProgress(): Progress {
  return {
    collected: [],
    discovered: [],
    met: [],
    restored: false,
    journal: [],
    player: null,
    explored: '',
    playTime: 0,
    distance: 0,
    stones: [],
    echoes: [],
    asked: [],
    found: [],
    returned: [],
    chats: {}
  }
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full or blocked: progress just isn't remembered */
  }
}

export function listSaves(): SaveEntry[] {
  const saves = read<SaveEntry[]>(SAVES, [])
  return Array.isArray(saves)
    ? saves.filter((s) => s && s.spec && s.progress).sort((a, b) => b.updated - a.updated)
    : []
}

export function loadSave(id: string): SaveEntry | undefined {
  return listSaves().find((s) => s.id === id)
}

export function storeSave(entry: SaveEntry): void {
  const rest = listSaves().filter((s) => s.id !== entry.id)
  write(SAVES, [{ ...entry, updated: Date.now() }, ...rest].slice(0, MAX_SAVES))
}

export function deleteSave(id: string): void {
  write(
    SAVES,
    listSaves().filter((s) => s.id !== id)
  )
}

export function defaultSettings(): Settings {
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  return {
    quality: coarse ? 'low' : 'high',
    volume: 0.8,
    music: 0.7,
    sensitivity: 1,
    invertY: false,
    useClaude: true,
    autoQuality: true,
    largeText: false,
    highContrast: false,
    reduceMotion:
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    bindings: { ...DEFAULT_BINDINGS }
  }
}

export function loadSettings(): Settings {
  const stored = read<Partial<Settings>>(SETTINGS, {})
  const d = defaultSettings()
  // Merge bindings key by key so new actions get defaults in old settings.
  return { ...d, ...stored, bindings: { ...d.bindings, ...(stored.bindings ?? {}) } }
}

export function storeSettings(s: Settings): void {
  write(SETTINGS, s)
}

/** Share links: the prompt alone for offline worlds; the whole (compressed) spec for Claude's. */
export async function encodeShare(spec: WorldSpec): Promise<string> {
  if (spec.source === 'local') return `#p=${encodeURIComponent(spec.prompt)}`
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(spec))
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    const buf = new Uint8Array(await new Response(stream).arrayBuffer())
    let bin = ''
    for (const b of buf) bin += String.fromCharCode(b)
    return `#s=${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
  } catch {
    return `#p=${encodeURIComponent(spec.prompt)}`
  }
}

export async function decodeShare(hash: string): Promise<{ prompt?: string; spec?: unknown }> {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const p = params.get('p')
  if (p) return { prompt: p }
  const s = params.get('s')
  if (!s) return {}
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    return { spec: JSON.parse(await new Response(stream).text()) }
  } catch {
    return {}
  }
}
