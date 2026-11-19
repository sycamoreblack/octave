import { normalizeSpec, type WorldSpec } from '../world/spec'

import type { TalkPayload } from '../../server/talk'

export type { TalkPayload }

/** What the optional server can do (see server/genesis.ts and server/talk.ts). */
export async function claudeStatus(): Promise<{ ai: boolean; talk: boolean }> {
  try {
    const r = await fetch('./api/status', { cache: 'no-store' })
    if (!r.ok) return { ai: false, talk: false }
    const j = (await r.json()) as { ai?: boolean; talk?: boolean }
    return { ai: j.ai === true, talk: j.talk === true }
  } catch {
    return { ai: false, talk: false }
  }
}

/** Talk to a wanderer. `onText` receives the reply so far as it streams in. */
export async function talkToWanderer(
  payload: TalkPayload,
  onText: (soFar: string) => void,
  timeoutMs = 60_000
): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch('./api/talk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    })
    if (!r.ok || !r.body) {
      const err = (await r.json().catch(() => ({}))) as { error?: string }
      throw new Error(err.error ?? `HTTP ${r.status}`)
    }
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      onText(text)
    }
    text += decoder.decode()
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask Claude to dream the world. `base` is the offline interpretation of the same prompt:
 * any field Claude leaves out or gets wrong is filled from it, so the result always plays.
 */
export async function dreamWithClaude(
  prompt: string,
  base: WorldSpec,
  timeoutMs = 150_000
): Promise<WorldSpec> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch('./api/genesis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: ctrl.signal
    })
    if (!r.ok) {
      const err = (await r.json().catch(() => ({}))) as { error?: string }
      throw new Error(err.error ?? `HTTP ${r.status}`)
    }
    const raw = (await r.json()) as Record<string, unknown>
    return normalizeSpec({ ...raw, source: 'claude', prompt: base.prompt, seed: base.seed }, base)
  } finally {
    clearTimeout(timer)
  }
}
