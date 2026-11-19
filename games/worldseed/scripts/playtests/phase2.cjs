const { chromium } = require('playwright')
const OUT = process.env.OUT
;(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, acceptDownloads: true })
  await page.addInitScript(() => {
    localStorage.setItem('worldseed.settings.v1', JSON.stringify({ quality: 'low' }))
    const pad = { id: 'Fake Pad', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], timestamp: 0, buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })) }
    window.__pad = pad
    navigator.getGamepads = () => [pad]
  })
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  const G = (fn, arg) => page.evaluate(fn, arg)
  const until = (fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { timeout, polling: 200 })
  const settle = async (n = 3) => { const f0 = await G(() => window.__worldseed.game.time); await until(([f0, n]) => window.__worldseed.game.time > f0 + n * 0.05, [f0, n]) }
  const tp = async (x, z) => { await G(([x, z]) => window.__worldseed.game.debug().teleport(x, z), [x, z]); await settle(3) }
  const btn = async (i, ms = 1300) => { await G((i) => { window.__pad.buttons[i].pressed = true; window.__pad.buttons[i].value = 1 }, i); await page.waitForTimeout(ms); await G((i) => { window.__pad.buttons[i].pressed = false; window.__pad.buttons[i].value = 0 }, i); await page.waitForTimeout(ms) }
  const axes = (a) => G((a) => { window.__pad.axes = a }, a)

  await page.goto('http://localhost:5173/')
  await page.fill('#prompt', 'A quiet meadow at dawn with a little village, wildflowers and ancient standing stones')
  await G(() => { const e = new Event('gamepadconnected'); e.gamepad = window.__pad; window.dispatchEvent(e) })
  await page.waitForTimeout(500)
  console.log('toast on connect:', await G(() => document.querySelector('#toasts').textContent))
  await btn(0) // A on the text box → begin
  await page.waitForSelector('#card:not(.hidden)', { timeout: 120000 })
  console.log('card opened by pad A')
  await btn(0) // A on the card → continue
  await until(() => window.__worldseed.game.mode === 'playing')
  console.log('device:', await G(() => window.__worldseed.game['input'].device))
  console.log('controls toast:', await G(() => document.querySelector('#toasts').textContent.slice(-150)))

  // Move with the left stick.
  const p0 = await G(() => window.__worldseed.game.player.position.toArray())
  await axes([0, -1, 0.5, 0]) // forward + look right
  await settle(30)
  await axes([0, 0, 0, 0])
  const p1 = await G(() => window.__worldseed.game.player.position.toArray())
  console.log('moved with stick:', Math.hypot(p1[0] - p0[0], p1[2] - p0[2]).toFixed(1), 'm')

  // Talk with X.
  const w = await G(() => window.__worldseed.game.world.wanderers[0].position.toArray())
  await tp(w[0] + 2, w[2] + 1)
  console.log('hint with pad:', await G(() => document.querySelector('#hint').textContent))
  await btn(2)
  console.log('dialogue via X:', await G(() => !document.querySelector('#dialogue').classList.contains('hidden')), await G(() => document.querySelector('#dialogue .more').textContent))
  for (let i = 0; i < 5; i++) await btn(2, 900)

  // Pause with Menu, navigate, back out with B.
  await btn(9)
  console.log('paused:', await G(() => window.__worldseed.game.mode))
  await btn(13, 900); await btn(13, 900)
  console.log('focused after d-pad:', await G(() => document.activeElement && document.activeElement.textContent.trim().slice(0, 30)))
  await page.screenshot({ path: `${OUT}/p2-pause.png` })
  await page.waitForTimeout(400)
  await btn(1)
  console.log('after B:', await G(() => window.__worldseed.game.mode))

  // Photo mode with R3, capture with A, exit with Menu.
  await btn(11)
  console.log('photo mode:', await G(() => window.__worldseed.game.mode))
  await page.screenshot({ path: `${OUT}/p2-photo-ui.png` })
  const dl = page.waitForEvent('download', { timeout: 60000 })
  await btn(0)
  const d = await dl
  await d.saveAs(`${OUT}/p2-photo.png`)
  console.log('photo saved:', d.suggestedFilename())
  await btn(9)
  console.log('after exit photo:', await G(() => window.__worldseed.game.mode), 'hud hidden:', await G(() => document.querySelector('#hud').classList.contains('hidden')))

  // Remap interact to G with the keyboard.
  await page.keyboard.press('Escape'); await settle(2)
  if ((await G(() => window.__worldseed.game.mode)) !== 'paused') { await G(() => window.__worldseed.game.pause(true)) }
  await page.click('#bindings button[data-action=interact]')
  await page.keyboard.press('KeyG')
  console.log('interact now bound to:', await G(() => document.querySelector('#bindings button[data-action=interact]').textContent))
  await page.click('#resume').catch(() => {})
  await G(() => window.__worldseed.game.closePanels())
  await page.keyboard.press('KeyW') // a key so hints switch back to keyboard names
  const w2 = await G(() => window.__worldseed.game.world.wanderers[0].position.toArray())
  await tp(w2[0] + 2, w2[2] + 1)
  console.log('hint after remap:', await G(() => document.querySelector('#hint').textContent))
  await page.keyboard.press('KeyG'); await settle(2)
  console.log('G talks:', await G(() => !document.querySelector('#dialogue').classList.contains('hidden')))

  // Accessibility toggles.
  await G(() => window.__worldseed.game.pause(true))
  await page.check('#set-large'); await page.check('#set-contrast')
  console.log('body classes:', await G(() => document.body.className))
  await G(() => window.__worldseed.game.closePanels())
  await settle(2)
  await page.screenshot({ path: `${OUT}/p2-a11y.png` })

  // Adaptive quality: SwiftShader at medium is slow, so it should step down by itself.
  await until(() => window.__worldseed.game['perf'].level >= 1, null, 240000)
  console.log('auto quality level:', await G(() => window.__worldseed.game['perf'].level), 'pixelRatio', await G(() => window.__worldseed.game['renderer'].getPixelRatio()))
  console.log('errors:', JSON.stringify(errors))
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
