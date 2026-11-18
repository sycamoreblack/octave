/**
 * Keyboard + mouse (with pointer lock) + touch (virtual stick on the left, look on the right).
 * Everything is read once per frame by the game and then `endFrame()` clears the deltas.
 */
export class Input {
  private down = new Set<string>()
  private pressedThisFrame = new Set<string>()
  lookX = 0
  lookY = 0
  wheel = 0
  /** Touch joystick vector, -1..1 each axis (y = forward). */
  stick = { x: 0, y: 0 }
  touchActive = false
  enabled = true
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
      if (!this.down.has(e.code)) this.pressedThisFrame.add(e.code)
      this.down.add(e.code)
      if (
        ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code) &&
        this.enabled
      )
        e.preventDefault()
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

    for (const [id, code] of [
      ['touch-jump', 'Space'],
      ['touch-act', 'KeyE'],
      ['touch-run', 'ShiftLeft']
    ] as const) {
      const el = document.getElementById(id)
      if (!el) continue
      el.addEventListener('touchstart', (e) => {
        e.preventDefault()
        if (code === 'ShiftLeft' && this.down.has(code)) {
          this.down.delete(code)
          el.classList.remove('on')
          return
        }
        this.pressedThisFrame.add(code)
        this.down.add(code)
        if (code === 'ShiftLeft') el.classList.add('on')
      })
      if (code !== 'ShiftLeft') el.addEventListener('touchend', () => this.down.delete(code))
    }
  }

  private onTouchStart(e: TouchEvent): void {
    e.preventDefault()
    this.touchActive = true
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

  isDown(...codes: string[]): boolean {
    return this.enabled && codes.some((c) => this.down.has(c))
  }

  pressed(...codes: string[]): boolean {
    return this.enabled && codes.some((c) => this.pressedThisFrame.has(c))
  }

  /** Movement intent: x = strafe right, y = forward. Length ≤ 1. */
  axis(): { x: number; y: number } {
    let x = 0
    let y = 0
    if (this.isDown('KeyW', 'ArrowUp')) y += 1
    if (this.isDown('KeyS', 'ArrowDown')) y -= 1
    if (this.isDown('KeyD', 'ArrowRight')) x += 1
    if (this.isDown('KeyA', 'ArrowLeft')) x -= 1
    if (this.enabled) {
      x += this.stick.x
      y += this.stick.y
    }
    const len = Math.hypot(x, y)
    return len > 1 ? { x: x / len, y: y / len } : { x, y }
  }

  requestLock(): void {
    if (this.touchActive || !this.canvas.requestPointerLock) return
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
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}
