/**
 * Keyboard + mouse (with pointer lock) + touch (virtual stick on the left, look on the right),
 * with a gamepad layered on top by engine/gamepad.ts. Gameplay reads named actions, so keys
 * can be remapped; everything is read once per frame and `endFrame()` clears the deltas.
 */

export const ACTIONS = [
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'run',
  'interact',
  'journal',
  'map',
  'photo'
] as const
export type Action = (typeof ACTIONS)[number] | 'pause'

export type Bindings = Record<(typeof ACTIONS)[number], string>

export const DEFAULT_BINDINGS: Bindings = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  run: 'ShiftLeft',
  interact: 'KeyE',
  journal: 'KeyJ',
  map: 'KeyM',
  photo: 'KeyF'
}

export const ACTION_LABELS: Record<(typeof ACTIONS)[number], string> = {
  forward: 'Move forward',
  back: 'Move back',
  left: 'Move left',
  right: 'Move right',
  jump: 'Jump / glide',
  run: 'Run',
  interact: 'Interact',
  journal: 'Journal',
  map: 'Map',
  photo: 'Photo mode'
}

/** Keys that always work alongside the player's bindings. */
const ALTERNATES: Partial<Record<Action, string[]>> = {
  forward: ['ArrowUp'],
  back: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  run: ['ShiftRight'],
  pause: ['Escape', 'KeyP']
}

/** Gamepad button names shown in hints when a controller is in use. */
const PAD_LABELS: Partial<Record<Action, string>> = {
  jump: 'A',
  interact: 'X',
  journal: 'Y',
  map: 'View',
  run: 'RT',
  photo: 'R3',
  pause: 'Menu'
}

export function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`
  const named: Record<string, string> = {
    Space: 'Space',
    ShiftLeft: 'Shift',
    ShiftRight: 'Right Shift',
    ControlLeft: 'Ctrl',
    ControlRight: 'Right Ctrl',
    AltLeft: 'Alt',
    AltRight: 'Right Alt',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Enter: 'Enter',
    Tab: 'Tab',
    Backquote: '`',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '='
  }
  return named[code] ?? code
}

export type Device = 'keys' | 'touch' | 'pad'

export class Input {
  private down = new Set<string>()
  private pressedThisFrame = new Set<string>()
  lookX = 0
  lookY = 0
  wheel = 0
  /** Touch joystick vector, -1..1 each axis (y = forward). */
  stick = { x: 0, y: 0 }
  /** Gamepad left stick, same convention. */
  pad = { x: 0, y: 0 }
  touchActive = false
  enabled = true
  bindings: Bindings = { ...DEFAULT_BINDINGS }
  /** The device used most recently, so hints can show the right button names. */
  device: Device = 'keys'
  onDeviceChange?: (d: Device) => void
  private stickId: number | null = null
  private stickOrigin = { x: 0, y: 0 }
  private lookId: number | null = null
  private lookLast = { x: 0, y: 0 }
  private dragging = false
  private stickEl: HTMLElement | null
  private knobEl: HTMLElement | null

  constructor(private canvas: HTMLCanvasElement) {
    this.stickEl = document.getElementById('touch-stick')
    this.knobEl = document.getElementById('touch-knob')
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return
      if (e.isTrusted) this.setDevice('keys')
      if (!this.down.has(e.code)) this.pressedThisFrame.add(e.code)
      this.down.add(e.code)
      const moveKeys = [
        ...this.codesFor('forward'),
        ...this.codesFor('back'),
        ...this.codesFor('left'),
        ...this.codesFor('right'),
        ...this.codesFor('jump'),
        'Tab'
      ]
      if (moveKeys.includes(e.code) && this.enabled) e.preventDefault()
    })
    window.addEventListener('keyup', (e) => this.down.delete(e.code))
    window.addEventListener('blur', () => this.down.clear())

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 || e.button === 2) this.dragging = true
    })
    window.addEventListener('mouseup', () => (this.dragging = false))
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return
      if (document.pointerLockElement === canvas || this.dragging) {
        this.lookX += e.movementX
        this.lookY += e.movementY
        if (e.movementX || e.movementY) this.setDevice('keys')
      }
    })
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    canvas.addEventListener(
      'wheel',
      (e) => {
        this.wheel += Math.sign(e.deltaY)
        e.preventDefault()
      },
      { passive: false }
    )

    canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false })
    canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false })
    canvas.addEventListener('touchend', (e) => this.onTouchEnd(e))
    canvas.addEventListener('touchcancel', (e) => this.onTouchEnd(e))

    for (const [id, action] of [
      ['touch-jump', 'jump'],
      ['touch-act', 'interact'],
      ['touch-run', 'run']
    ] as const) {
      const el = document.getElementById(id)
      if (!el) continue
      el.addEventListener('touchstart', (e) => {
        e.preventDefault()
        this.setDevice('touch')
        const code = this.bindings[action]
        if (action === 'run' && this.down.has(code)) {
          this.down.delete(code)
          el.classList.remove('on')
          return
        }
        this.pressedThisFrame.add(code)
        this.down.add(code)
        if (action === 'run') el.classList.add('on')
      })
      if (action !== 'run')
        el.addEventListener('touchend', () => this.down.delete(this.bindings[action]))
    }
  }

  setDevice(d: Device): void {
    if (d === this.device) return
    this.device = d
    this.onDeviceChange?.(d)
  }

  private onTouchStart(e: TouchEvent): void {
    e.preventDefault()
    this.touchActive = true
    this.setDevice('touch')
    document.body.classList.add('touch')
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < window.innerWidth * 0.45 && this.stickId === null) {
        this.stickId = t.identifier
        this.stickOrigin = { x: t.clientX, y: t.clientY }
        if (this.stickEl) {
          this.stickEl.style.display = 'block'
          this.stickEl.style.left = `${t.clientX}px`
          this.stickEl.style.top = `${t.clientY}px`
        }
      } else if (this.lookId === null) {
        this.lookId = t.identifier
        this.lookLast = { x: t.clientX, y: t.clientY }
      }
    }
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault()
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        const dx = t.clientX - this.stickOrigin.x
        const dy = t.clientY - this.stickOrigin.y
        const len = Math.hypot(dx, dy)
        const max = 55
        const k = len > max ? max / len : 1
        this.stick.x = (dx * k) / max
        this.stick.y = (-dy * k) / max
        if (this.knobEl) this.knobEl.style.transform = `translate(${dx * k}px, ${dy * k}px)`
      } else if (t.identifier === this.lookId) {
        this.lookX += (t.clientX - this.lookLast.x) * 1.6
        this.lookY += (t.clientY - this.lookLast.y) * 1.6
        this.lookLast = { x: t.clientX, y: t.clientY }
      }
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        this.stickId = null
        this.stick.x = this.stick.y = 0
        if (this.stickEl) this.stickEl.style.display = 'none'
        if (this.knobEl) this.knobEl.style.transform = ''
      } else if (t.identifier === this.lookId) this.lookId = null
    }
  }

  codesFor(action: Action): string[] {
    const bound = action === 'pause' ? [] : [this.bindings[action]]
    return [...bound, ...(ALTERNATES[action] ?? [])]
  }

  isDown(...codes: string[]): boolean {
    return this.enabled && codes.some((c) => this.down.has(c))
  }

  pressed(...codes: string[]): boolean {
    return this.enabled && codes.some((c) => this.pressedThisFrame.has(c))
  }

  /** The action is held down (ignored while input is disabled). */
  held(action: Action): boolean {
    return this.isDown(...this.codesFor(action))
  }

  /** The action was pressed this frame (ignored while input is disabled). */
  hit(action: Action): boolean {
    return this.pressed(...this.codesFor(action))
  }

  /** Pressed this frame, even while gameplay input is disabled (menus, panels). */
  hitAlways(action: Action): boolean {
    return this.codesFor(action).some((c) => this.pressedThisFrame.has(c))
  }

  /** What to show for an action in a hint: a key name, or a controller button. */
  label(action: Action): string {
    if (this.device === 'pad' && PAD_LABELS[action]) return PAD_LABELS[action]!
    if (action === 'pause') return 'Esc'
    return keyName(this.bindings[action])
  }

  /**
   * Press or release an action as if its bound key were used. Dispatched as a real
   * keyboard event so story cards and menus react to the controller too.
   */
  synth(action: Action, down: boolean): void {
    const code = action === 'pause' ? 'Escape' : this.bindings[action]
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code }))
  }

  /** Movement intent: x = strafe right, y = forward. Length ≤ 1. */
  axis(): { x: number; y: number } {
    let x = 0
    let y = 0
    if (this.held('forward')) y += 1
    if (this.held('back')) y -= 1
    if (this.held('right')) x += 1
    if (this.held('left')) x -= 1
    if (this.enabled) {
      x += this.stick.x + this.pad.x
      y += this.stick.y + this.pad.y
    }
    const len = Math.hypot(x, y)
    return len > 1 ? { x: x / len, y: y / len } : { x, y }
  }

  requestLock(): void {
    if (this.touchActive || this.device === 'pad' || !this.canvas.requestPointerLock) return
    try {
      const p = this.canvas.requestPointerLock() as unknown
      if (p instanceof Promise) p.catch(() => undefined)
    } catch {
      /* not allowed right now: drag-to-look still works */
    }
  }

  endFrame(): void {
    this.pressedThisFrame.clear()
    this.lookX = this.lookY = 0
    this.wheel = 0
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  return (
    !!t &&
    'tagName' in t &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
  )
}
