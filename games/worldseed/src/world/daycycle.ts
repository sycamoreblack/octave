import { clamp } from '../engine/noise'
import { hexToHsl, hslToHex, mixHex, type HSL } from '../engine/color'
import { skyFor } from './interpreter'
import type { Palette } from './spec'

/**
 * A continuous sky for any time of day, and a way to keep a world's own colouring as
 * time passes: we measure how its palette differs from the neutral sky at the time it was
 * described, and apply the same shift at every other hour.
 */

interface Sky {
  top: HSL
  horizon: HSL
  sun: string
}

const NIGHT = skyFor(0.95)
const DAWN = skyFor(0.27)
const DAY = skyFor(0.46)
const DUSK = skyFor(0.75)

const KEYS: [number, Sky][] = [
  [0, NIGHT],
  [0.17, NIGHT],
  [0.26, DAWN],
  [0.34, DAY],
  [0.64, DAY],
  [0.73, DUSK],
  [0.84, NIGHT],
  [1, NIGHT]
]

function mixHsl(a: HSL, b: HSL, t: number): HSL {
  let dh = b.h - a.h
  if (dh > 0.5) dh -= 1
  if (dh < -0.5) dh += 1
  return { h: a.h + dh * t, s: a.s + (b.s - a.s) * t, l: a.l + (b.l - a.l) * t }
}

/** The neutral sky at time t (0..1), blended smoothly between keyframes. */
export function skyAt(t: number): Sky {
  t = ((t % 1) + 1) % 1
  for (let i = 0; i < KEYS.length - 1; i++) {
    const [t0, a] = KEYS[i]
    const [t1, b] = KEYS[i + 1]
    if (t >= t0 && t <= t1) {
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0
      const e = f * f * (3 - 2 * f)
      return {
        top: mixHsl(a.top, b.top, e),
        horizon: mixHsl(a.horizon, b.horizon, e),
        sun: mixHex(a.sun, b.sun, e)
      }
    }
  }
  return NIGHT
}

export interface SkyShift {
  dh: number
  ds: number
  lr: number
}

function shiftBetween(neutral: HSL, actual: HSL): SkyShift {
  let dh = actual.h - neutral.h
  if (dh > 0.5) dh -= 1
  if (dh < -0.5) dh += 1
  return { dh, ds: actual.s - neutral.s, lr: actual.l / Math.max(neutral.l, 0.03) }
}

function applyShift(c: HSL, s: SkyShift): HSL {
  return { h: c.h + s.dh, s: clamp(c.s + s.ds, 0, 1), l: clamp(c.l * s.lr, 0.01, 0.95) }
}

/** How this world's sky differs from the neutral sky at the time it was described. */
export function measureShift(
  palette: Palette,
  describedTime: number
): { top: SkyShift; horizon: SkyShift } {
  const n = skyAt(describedTime)
  return {
    top: shiftBetween(n.top, hexToHsl(palette.skyTop)),
    horizon: shiftBetween(n.horizon, hexToHsl(palette.skyHorizon))
  }
}

/** This world's sky colours at time t. */
export function worldSkyAt(
  t: number,
  shift: { top: SkyShift; horizon: SkyShift }
): { top: string; horizon: string; sun: string } {
  const n = skyAt(t)
  return {
    top: hslToHex(applyShift(n.top, shift.top)),
    horizon: hslToHex(applyShift(n.horizon, shift.horizon)),
    sun: n.sun
  }
}
