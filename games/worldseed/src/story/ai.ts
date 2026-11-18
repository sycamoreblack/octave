import { normalizeSpec, type WorldSpec } from '../world/spec'

/** Client for the optional /api/genesis endpoint (see server/genesis.ts). */
export async function claudeAvailable(): Promise<boolean> {
  try {
    const r = await fetch('./api/status', { cache: 'no-store' })
    if (!r.ok) return false
    const j = (await r.json()) as { ai?: boolean }
    return j.ai === true
  } catch {
    return false
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
