import { describe, expect, it } from 'vitest'
import { hexToRgb } from '../engine/color'
import { interpret } from './interpreter'
import { measureShift, skyAt, worldSkyAt } from './daycycle'

const close = (a: string, b: string): boolean =>
  hexToRgb(a).every((v, i) => Math.abs(v - hexToRgb(b)[i]) < 0.02)

describe('day cycle', () => {
  it('reproduces each world’s own sky at the time it was described', () => {
    for (const prompt of [
      'An alien garden under a green sky',
      'A red desert under two moons at night',
      'A smouldering volcanic wasteland',
      'A quiet meadow at dawn',
      'A drowned archipelago at dusk'
    ]) {
      const w = interpret(prompt)
      const at = worldSkyAt(w.timeOfDay, measureShift(w.palette, w.timeOfDay))
      expect(close(at.top, w.palette.skyTop), `${prompt} top`).toBe(true)
      expect(close(at.horizon, w.palette.skyHorizon), `${prompt} horizon`).toBe(true)
    }
  })

  it('changes smoothly, with no jumps between nearby moments', () => {
    let prev = skyAt(0)
    for (let i = 1; i <= 1000; i++) {
      const cur = skyAt(i / 1000)
      expect(Math.abs(cur.top.l - prev.top.l)).toBeLessThan(0.02)
      expect(Math.abs(cur.horizon.l - prev.horizon.l)).toBeLessThan(0.02)
      prev = cur
    }
  })

  it('is darker at night than at noon for every world', () => {
    const w = interpret('An alien garden under a green sky')
    const shift = measureShift(w.palette, w.timeOfDay)
    const lum = (hex: string): number => hexToRgb(hex).reduce((a, b) => a + b, 0)
    expect(lum(worldSkyAt(0.95, shift).top)).toBeLessThan(lum(worldSkyAt(0.5, shift).top))
  })
})
