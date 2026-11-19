// Fixed viewpoints across contrasting worlds, for before/after comparison.
const { chromium } = require('playwright')
const OUT = process.env.OUT
const TAG = process.env.TAG
const QUALITY = process.env.QUALITY || 'high'
const WORLDS = [
  ['arch', 'A drowned archipelago at dusk, where old lighthouses guard forgotten songs'],
  ['forest', 'A snowbound pine forest at night, lit by wandering spirits and the northern lights'],
  ['meadow', 'A quiet meadow at dawn with a little village, a winding river, wildflowers and ancient standing stones'],
  ['alien', 'An alien garden of violet crystals and giant mushrooms under a green sky']
]
;(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const results = []
  for (const [name, prompt] of WORLDS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    await page.addInitScript((q) => localStorage.setItem('worldseed.settings.v1', JSON.stringify({ quality: q, autoQuality: false })), QUALITY)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    const G = (fn, a) => page.evaluate(fn, a)
    const settle = async (n) => { const f0 = await G(() => window.__worldseed.game.time); await page.waitForFunction(([f0, n]) => window.__worldseed.game.time > f0 + n * 0.05, [f0, n], { polling: 200, timeout: 180000 }) }
    await page.goto('http://localhost:5173/')
    await page.fill('#prompt', prompt)
    await page.click('#begin')
    await page.waitForSelector('#card:not(.hidden)', { timeout: 180000 })
    await page.click('#card button.primary')
    await G(() => { document.querySelector('#hud').style.visibility = 'hidden'; document.querySelector('#toasts').style.display = 'none'; document.querySelector('#clickhint').style.display = 'none' })
    if (process.env.SKIP_SHOTS) { /* timing only */ }
    const views = process.env.SKIP_SHOTS ? [] : [
      ['near', 0.18, 9, 0],
      ['wide', 0.42, 18, 2.4]
    ]
    for (const [view, pitch, dist, yawOff] of views) {
      await G(([pitch, dist, yawOff]) => {
        const g = window.__worldseed.game
        const s = g.world.layout.spawn
        const h = g.world.heart.center
        g.debug().teleport(s.x, s.z)
        g.follow.yaw = Math.atan2(h.x - s.x, h.z - s.z) + yawOff
        g.follow.pitch = pitch
        g.follow.distance = dist
        g.follow['targetDistance'] = dist
        g.follow['initialized'] = false
      }, [pitch, dist, yawOff])
      await settle(8)
      await page.screenshot({ path: `${OUT}/${TAG}-${name}-${view}.png`, timeout: 180000 })
    }
    // Average render time over a few frames (SwiftShader: relative numbers only).
    const ms = await G(() => {
      const g = window.__worldseed.game
      const gl = g['renderer'].getContext()
      const px = new Uint8Array(4)
      // readPixels forces the GPU (here SwiftShader) to finish, unlike gl.finish().
      const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px) }
      g.renderFrame(); sync()
      const t = performance.now()
      for (let i = 0; i < 4; i++) { g.renderFrame(); sync() }
      return (performance.now() - t) / 4
    })
    results.push({ name, ms: Math.round(ms), errors: errors.length ? errors.slice(0, 3) : undefined })
    await page.close()
  }
  console.log(JSON.stringify(results))
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
