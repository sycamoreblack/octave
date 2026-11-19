const { chromium } = require('playwright')
const OUT = process.env.OUT
;(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
  await page.addInitScript(() => localStorage.setItem('worldseed.settings.v1', JSON.stringify({ quality: 'low', autoQuality: false })))
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const G = (fn, a) => page.evaluate(fn, a)
  const settle = async (n = 4) => { const f0 = await G(() => window.__worldseed.game.time); await page.waitForFunction(([f0, n]) => window.__worldseed.game.time > f0 + n * 0.05, [f0, n], { polling: 200, timeout: 60000 }) }
  await page.goto('http://localhost:5173/')
  await page.fill('#prompt', process.env.PROMPT)
  await page.click('#begin')
  await page.waitForSelector('#card:not(.hidden)', { timeout: 120000 })
  await page.click('#card button.primary')
  await G(() => { document.querySelector('#hud').style.visibility = 'hidden'; document.querySelector('#toasts').style.display = 'none'; const g = window.__worldseed.game; g.follow.pitch = 0.15; g.follow.distance = 10 })
  for (const [name, t] of [['dawn', 0.27], ['noon', 0.5], ['dusk', 0.74], ['night', 0.95]]) {
    await G((t) => window.__worldseed.game.setHour(t), t)
    await settle(4)
    await page.screenshot({ path: `${OUT}/h-${process.env.TAG}-${name}.png` })
  }
  console.log('errors', JSON.stringify(errors))
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
