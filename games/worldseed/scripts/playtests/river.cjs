const { chromium } = require('playwright')
const OUT = process.env.OUT
;(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
  await page.addInitScript(() => localStorage.setItem('worldseed.settings.v1', JSON.stringify({ quality: 'medium', autoQuality: false })))
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const G = (fn, a) => page.evaluate(fn, a)
  const settle = async (n = 4) => { const f0 = await G(() => window.__worldseed.game.time); await page.waitForFunction(([f0, n]) => window.__worldseed.game.time > f0 + n * 0.05, [f0, n], { polling: 200, timeout: 120000 }) }
  await page.goto('http://localhost:5173/')
  await page.fill('#prompt', process.env.PROMPT)
  const t0 = Date.now()
  await page.click('#begin')
  await page.waitForSelector('#card:not(.hidden)', { timeout: 120000 })
  console.log('build ms', Date.now() - t0)
  await page.click('#card button.primary')
  await G(() => { document.querySelector('#hud').style.visibility = 'hidden'; document.querySelector('#toasts').style.display = 'none' })
  const info = await G(() => { const t = window.__worldseed.game.world.terrain; return { rivers: t.rivers.rivers.map((r) => r.length), pt: t.rivers.rivers[0] && t.rivers.rivers[0][Math.floor(t.rivers.rivers[0].length * 0.55)], prev: t.rivers.rivers[0] && t.rivers.rivers[0][Math.floor(t.rivers.rivers[0].length * 0.55) - 6], isles: window.__worldseed.spec.terrain.floating } })
  console.log('rivers:', info.rivers, 'floating:', info.isles)
  if (info.pt) {
    // Stand on the bank, looking along the river.
    const ox = info.pt.x + (info.pt.x - info.prev.x) * 0.2 + 14, oz = info.pt.z + 14
    await G(([x, z, tx, tz]) => { const g = window.__worldseed.game; g.debug().teleport(x, z); g.follow.pitch = 0.32; g.follow.distance = 14; g.follow['targetDistance'] = 14; g.follow.yaw = Math.atan2(tx - x, tz - z) }, [ox, oz, info.prev.x, info.prev.z])
    await settle(6)
    await page.screenshot({ path: `${OUT}/rv-${process.env.TAG}-a.png` })
    await G(([x, z]) => window.__worldseed.game.debug().teleport(x, z), [info.pt.x, info.pt.z])
    await settle(4)
    console.log('in river: wading y', await G(() => window.__worldseed.game.player.position.y.toFixed(2)), 'surface', info.pt.surface.toFixed(2))
  }
  await G(() => { const g = window.__worldseed.game; g.follow.pitch = -0.3; g.follow.distance = 8 })
  await settle(5)
  await page.screenshot({ path: `${OUT}/rv-${process.env.TAG}-sky.png` })
  console.log('errors', JSON.stringify(errors))
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
