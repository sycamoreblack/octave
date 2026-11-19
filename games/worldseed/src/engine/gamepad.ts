import { Input, type Action } from './input'

/**
 * Standard-mapping gamepad support. In play, the left stick moves, the right stick looks,
 * and buttons press actions (sent as key events, so remapping and story cards just work).
 * When a menu, card or the title screen is open, the pad navigates it instead:
 * d-pad / stick to move focus, A to choose, B to go back, left/right to adjust sliders.
 */

const DEAD = 0.18
const LOOK_SPEED = 820

/** Standard mapping button indices. */
const B = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  MENU: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15
} as const

const PLAY_MAP: [number, Action][] = [
  [B.A, 'jump'],
  [B.X, 'interact'],
  [B.Y, 'journal'],
  [B.VIEW, 'map'],
  [B.RT, 'run'],
  [B.L3, 'run'],
  [B.R3, 'photo'],
  [B.MENU, 'pause']
]

const FOCUSABLE = 'button:not([disabled]), [href], input:not([type=hidden]), select, textarea'

const dz = (v: number): number => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD))

export class GamepadInput {
  private prev: boolean[] = []
  private held = new Set<Action>()
  private raf = 0
  private last = 0
  private navCooldown = 0
  connected = false

  /**
   * Returns the open menu/card/title element the pad should navigate, or null during play.
   * Supplied by main.ts, which knows which layer is on top.
   */
  uiRoot: () => HTMLElement | null = () => null
  /** Called for A on the title screen when the text box is focused (start the game). */
  onTitleConfirm?: () => void
  onConnect?: (name: string) => void

  constructor(private input: Input) {
    window.addEventListener('gamepadconnected', (e) => {
      this.connected = true
      this.onConnect?.((e as GamepadEvent).gamepad.id)
      this.start()
    })
    window.addEventListener('gamepaddisconnected', () => {
      this.connected = this.pads().length > 0
      if (!this.connected) this.releaseAll()
    })
  }

  private pads(): Gamepad[] {
    return Array.from(navigator.getGamepads?.() ?? []).filter(
      (p): p is Gamepad => !!p && p.connected
    )
  }

  private start(): void {
    if (this.raf) return
    this.last = performance.now()
    const loop = (now: number): void => {
      const dt = Math.min(0.05, (now - this.last) / 1000)
      this.last = now
      this.poll(dt)
      this.raf = this.connected ? requestAnimationFrame(loop) : 0
    }
    this.raf = requestAnimationFrame(loop)
  }

  private releaseAll(): void {
    for (const a of this.held) this.input.synth(a, false)
    this.held.clear()
    this.input.pad.x = this.input.pad.y = 0
  }

  private poll(dt: number): void {
    const pad = this.pads()[0]
    if (!pad) return
    const btn = pad.buttons.map((b) => b.pressed || b.value > 0.5)
    const edge = (i: number): boolean => !!btn[i] && !this.prev[i]
    const ax = pad.axes.map(dz)
    if (btn.some(Boolean) || ax.some((a) => a !== 0)) this.input.setDevice('pad')

    const ui = this.uiRoot()
    if (ui) {
      this.releaseAll()
      this.navigate(ui, btn, edge, ax, dt)
    } else {
      // Play: sticks move and look; buttons hold actions.
      this.input.pad.x = ax[0] ?? 0
      this.input.pad.y = -(ax[1] ?? 0)
      this.input.lookX += (ax[2] ?? 0) * LOOK_SPEED * dt
      this.input.lookY += (ax[3] ?? 0) * LOOK_SPEED * dt
      if (edge(B.LB)) this.input.wheel -= 1
      if (edge(B.RB)) this.input.wheel += 1
      const want = new Set<Action>()
      for (const [i, action] of PLAY_MAP) if (btn[i]) want.add(action)
      for (const a of want) if (!this.held.has(a)) this.input.synth(a, true)
      for (const a of this.held) if (!want.has(a)) this.input.synth(a, false)
      this.held = want
    }
    this.prev = btn
  }

  private navigate(
    root: HTMLElement,
    btn: boolean[],
    edge: (i: number) => boolean,
    ax: number[],
    dt: number
  ): void {
    this.input.pad.x = this.input.pad.y = 0
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null
    )
    const active = document.activeElement as HTMLElement | null
    const idx = active ? items.indexOf(active) : -1

    // Right stick scrolls long panels (journal, settings, story cards).
    const scroller =
      root.querySelector<HTMLElement>('.journal-body, .pause-body, .card-inner') ?? root
    if (ax[3]) scroller.scrollTop += ax[3] * 700 * dt

    this.navCooldown -= dt
    const vy = (btn[B.DOWN] ? 1 : 0) - (btn[B.UP] ? 1 : 0) || Math.sign(ax[1] ?? 0)
    const vx = (btn[B.RIGHT] ? 1 : 0) - (btn[B.LEFT] ? 1 : 0) || Math.sign(ax[0] ?? 0)
    const fresh = edge(B.UP) || edge(B.DOWN) || edge(B.LEFT) || edge(B.RIGHT)
    if ((vy || vx) && (fresh || this.navCooldown <= 0)) {
      this.navCooldown = fresh ? 0.35 : 0.14
      const adjustable = active && (active as HTMLInputElement).type === 'range'
      if (vx && active instanceof HTMLSelectElement) {
        const n = active.options.length
        active.selectedIndex = (active.selectedIndex + vx + n) % n
        active.dispatchEvent(new Event('change', { bubbles: true }))
      } else if (vx && adjustable) {
        const r = active as HTMLInputElement
        const step = parseFloat(r.step || '1')
        r.value = String(
          Math.min(parseFloat(r.max), Math.max(parseFloat(r.min), parseFloat(r.value) + vx * step))
        )
        r.dispatchEvent(new Event('input', { bubbles: true }))
      } else if (items.length) {
        const dir = vy || vx
        const next = items[(idx + dir + items.length) % items.length] ?? items[0]
        next.focus()
        next.scrollIntoView({ block: 'nearest' })
      }
    }

    if (edge(B.A)) {
      if (!active || !items.includes(active))
        items.find((el) => el.classList.contains('primary'))?.focus() ?? items[0]?.focus()
      else if (active instanceof HTMLTextAreaElement) this.onTitleConfirm?.()
      else if (active instanceof HTMLInputElement && active.type === 'checkbox') active.click()
      else if (
        !(active instanceof HTMLSelectElement) &&
        (active as HTMLInputElement).type !== 'range'
      )
        active.click()
    }
    // B goes back; Menu and View still toggle their panels from anywhere.
    if (edge(B.B) || edge(B.MENU)) this.tap('pause')
    if (edge(B.VIEW)) this.tap('map')
    if (edge(B.Y)) this.tap('journal')
  }

  private tap(action: Action): void {
    this.input.synth(action, true)
    this.input.synth(action, false)
  }
}
