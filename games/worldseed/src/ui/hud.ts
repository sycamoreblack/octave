import type { JournalEntry } from '../game/save'

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`missing ${sel}`)
  return el
}

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

export interface CompassMark {
  angle: number
  kind: 'shard' | 'heart' | 'person' | 'cardinal' | 'minor' | 'stone' | 'item' | 'echo'
  label?: string
  distance?: number
}

export interface CardOptions {
  kicker?: string
  title: string
  epigraph?: string
  paragraphs: string[]
  statsHtml?: string
  actions?: { label: string; primary?: boolean; value: string }[]
}

/** Thin DOM layer over the HUD, cards and panels in index.html. */
export class Hud {
  private hud = $('#hud')
  private strip = $('#compass-strip')
  private objective = $('#objective')
  private banner = $('#banner')
  private hint = $('#hint')
  private dialogue = $('#dialogue')
  private toasts = $('#toasts')
  private card = $('#card')
  private clickHint = $('#clickhint')
  private bannerTimer = 0
  private lastHint = ''
  private markEls: HTMLElement[] = []

  show(on: boolean): void {
    this.hud.classList.toggle('hidden', !on)
  }

  setObjective(count: string, text: string): void {
    this.objective.querySelector('.count')!.textContent = count
    this.objective.querySelector('.text')!.textContent = text
  }

  /** Shows what the player is carrying back to someone (empty hides it). */
  setCarry(text: string): void {
    const el = $('#carry')
    el.textContent = text
    el.classList.toggle('hidden', !text)
  }

  showBanner(kicker: string, name: string, seconds = 4): void {
    this.banner.querySelector('small')!.textContent = kicker
    this.banner.querySelector('span')!.textContent = name
    this.banner.classList.add('show')
    window.clearTimeout(this.bannerTimer)
    this.bannerTimer = window.setTimeout(() => this.banner.classList.remove('show'), seconds * 1000)
  }

  setHint(html: string): void {
    if (html === this.lastHint) return
    this.lastHint = html
    if (html) this.hint.innerHTML = html
    this.hint.classList.toggle('show', !!html)
  }

  setClickHint(on: boolean): void {
    this.clickHint.classList.toggle('show', on)
  }

  toast(html: string): void {
    const el = document.createElement('div')
    el.className = 'toast'
    el.innerHTML = html
    this.toasts.appendChild(el)
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove()
    window.setTimeout(() => el.remove(), 6200)
  }

  showDialogue(name: string, epithet: string, line: string, key = 'E'): void {
    this.dialogue.classList.remove('hidden')
    this.dialogue.querySelector('.more')!.textContent = `${key} ▸`
    this.dialogue.querySelector('.who b')!.textContent = name
    this.dialogue.querySelector('.who span')!.textContent = epithet
    this.dialogue.querySelector('.line')!.textContent = line
    // Restart the fade-in for each line.
    this.dialogue.style.animation = 'none'
    void this.dialogue.offsetWidth
    this.dialogue.style.animation = ''
  }

  /** The line the player just said (empty hides it). */
  setYouSaid(text: string): void {
    const el = this.dialogue.querySelector<HTMLElement>('.you')!
    el.textContent = text ? `You: ${text}` : ''
    el.classList.toggle('hidden', !text)
  }

  /** Update the wanderer's line in place (for streamed replies). */
  setLine(text: string, thinking = false): void {
    const el = this.dialogue.querySelector<HTMLElement>('.line')!
    el.textContent = text
    el.classList.toggle('thinking', thinking)
  }

  setMore(text: string): void {
    this.dialogue.querySelector('.more')!.textContent = text
  }

  showSay(on: boolean): void {
    document.getElementById('say')!.classList.toggle('hidden', !on)
    const input = document.getElementById('say-input') as HTMLInputElement
    if (on) {
      input.disabled = false
      input.value = ''
      input.focus()
    }
  }

  hideDialogue(): void {
    document.getElementById('say-open')?.classList.add('hidden')
    this.showSay(false)
    this.setYouSaid('')
    this.dialogue.classList.add('hidden')
  }

  get dialogueOpen(): boolean {
    return !this.dialogue.classList.contains('hidden')
  }

  /** Draw compass marks. `angle` is relative to view: 0 ahead, +π/2 to the left. */
  setCompass(marks: CompassMark[]): void {
    while (this.markEls.length < marks.length) {
      const el = document.createElement('div')
      this.strip.appendChild(el)
      this.markEls.push(el)
    }
    this.markEls.forEach((el, i) => {
      const m = marks[i]
      if (!m || Math.abs(m.angle) > Math.PI * 0.55) {
        el.style.display = 'none'
        return
      }
      el.style.display = ''
      el.className = `cmark ${m.kind}`
      el.style.left = `${50 - (m.angle / (Math.PI * 0.55)) * 50}%`
      const dist =
        m.distance !== undefined && m.kind !== 'cardinal' && m.kind !== 'minor'
          ? `<span class="dist">${Math.round(m.distance)}m</span>`
          : ''
      const label = m.kind === 'cardinal' || m.kind === 'minor' ? esc(m.label ?? '') : ''
      if (el.innerHTML !== label + dist) el.innerHTML = label + dist
    })
  }

  /** Show a story card. Resolves with the chosen action's value when dismissed. */
  showCard(opts: CardOptions): Promise<string> {
    this.card.querySelector('.kicker')!.textContent = opts.kicker ?? ''
    this.card.querySelector('h2')!.textContent = opts.title
    this.card.querySelector('.epigraph')!.textContent = opts.epigraph ? `“${opts.epigraph}”` : ''
    this.card.querySelector('.body')!.innerHTML =
      opts.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('') + (opts.statsHtml ?? '')
    const actions = this.card.querySelector('.card-actions')!
    const list = opts.actions ?? [{ label: 'Continue', primary: true, value: 'ok' }]
    actions.innerHTML = list
      .map(
        (a, i) =>
          `<button data-v="${esc(a.value)}" class="${a.primary ? 'primary' : ''}" ${i === 0 ? 'autofocus' : ''}>${esc(a.label)}</button>`
      )
      .join('')
    this.card.classList.remove('hidden')
    const first =
      actions.querySelector<HTMLButtonElement>('button.primary') ?? actions.querySelector('button')
    first?.focus()
    return new Promise((resolve) => {
      let closed = false
      const done = (v: string): void => {
        if (closed) return
        closed = true
        this.card.classList.add('hidden')
        window.removeEventListener('keydown', onKey, true)
        ;(document.activeElement as HTMLElement | null)?.blur()
        resolve(v)
      }
      const onKey = (e: KeyboardEvent): void => {
        if (e.code === 'Enter' || e.code === 'KeyE' || e.code === 'Space' || e.code === 'Escape') {
          e.preventDefault()
          e.stopImmediatePropagation()
          done(
            e.code === 'Escape'
              ? list[list.length - 1].value
              : ((document.activeElement as HTMLElement)?.dataset?.v ?? list[0].value)
          )
        }
      }
      // Ignore the keypress that opened the card.
      // (If the card was already closed by a quick click, don't attach a listener that would never be removed.)
      window.setTimeout(() => {
        if (!closed) window.addEventListener('keydown', onKey, true)
      }, 250)
      actions
        .querySelectorAll<HTMLButtonElement>('button')
        .forEach((b) => (b.onclick = () => done(b.dataset.v!)))
    })
  }

  get cardOpen(): boolean {
    return !this.card.classList.contains('hidden')
  }

  renderJournal(entries: JournalEntry[]): void {
    const body = $('#journal .journal-body')
    const sections: [JournalEntry['kind'][], string][] = [
      [['story', 'finale'], 'The story so far'],
      [['shard'], 'Recovered'],
      [['person'], 'People met'],
      [['request'], 'Lost and found'],
      [['echo'], 'Echoes'],
      [['place'], 'Places found']
    ]
    body.innerHTML = sections
      .map(([kinds, title]) => {
        const items = entries.filter((e) => kinds.includes(e.kind))
        const html = items.length
          ? items
              .map((e) => `<div class="entry"><b>${esc(e.title)}</b><p>${esc(e.text)}</p></div>`)
              .join('')
          : `<p class="empty">Nothing yet.</p>`
        return `<h3>${title}</h3>${html}`
      })
      .join('')
  }
}

export { esc }
