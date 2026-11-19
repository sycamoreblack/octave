import { beforeEach, describe, expect, it } from 'vitest'
import { ACTIONS, DEFAULT_BINDINGS, keyName } from './input'
import { loadSettings, storeSettings } from '../game/save'

describe('keyName', () => {
  it('names keys the way players read them', () => {
    expect(keyName('KeyE')).toBe('E')
    expect(keyName('Digit3')).toBe('3')
    expect(keyName('ShiftLeft')).toBe('Shift')
    expect(keyName('ArrowUp')).toBe('↑')
    expect(keyName('Numpad5')).toBe('Num 5')
    expect(keyName('F7')).toBe('F7')
  })

  it('has a default binding for every action, all different', () => {
    for (const a of ACTIONS) expect(DEFAULT_BINDINGS[a]).toBeTruthy()
    expect(new Set(Object.values(DEFAULT_BINDINGS)).size).toBe(ACTIONS.length)
  })
})

describe('settings', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v)
    }
  })

  it('fills in settings added since an old save', () => {
    store.set(
      'worldseed.settings.v1',
      JSON.stringify({ quality: 'low', volume: 0.3, bindings: { interact: 'KeyG' } })
    )
    const s = loadSettings()
    expect(s.quality).toBe('low')
    expect(s.volume).toBe(0.3)
    expect(s.autoQuality).toBe(true)
    expect(s.bindings.interact).toBe('KeyG')
    expect(s.bindings.jump).toBe('Space')
  })

  it('round-trips', () => {
    const s = { ...loadSettings(), largeText: true, bindings: { ...DEFAULT_BINDINGS, map: 'Tab' } }
    storeSettings(s)
    expect(loadSettings()).toEqual(s)
  })
})
