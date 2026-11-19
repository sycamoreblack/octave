const { chromium } = require('playwright')
const OUT = process.env.OUT
;(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.addInitScript(() => localStorage.setItem('worldseed.settings.v1', JSON.stringify({ quality: 'low' })))
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  const G = (fn, arg) => page.evaluate(fn, arg)
  const until = (fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout, polling: 200 })
  const settle = async (n = 3) => { const f0 = await G(() => window.__worldseed.game.time); await until(([f0, n]) => window.__worldseed.game.time > f0 + n * 0.05, [f0, n]) }
  const tp = async (x, z) => { await G(([x, z]) => window.__worldseed.game.debug().teleport(x, z), [x, z]); await settle(3) }
  const press = async (k) => { await page.keyboard.press(k); await settle(2) }
  const state = () => G(() => { const g = window.__worldseed.game; const p = g.progress; return { mode: g.mode, target: g.target && g.target.kind, hint: document.querySelector('#hint').textContent, stones: p.stones.length, collected: p.collected.length, asked: p.asked, found: p.found, returned: p.returned, echoes: p.echoes.length, carry: document.querySelector('#carry').textContent } })

  await page.goto('http://localhost:5173/')
  await page.fill('#prompt', 'A misty swamp full of fireflies, weeping willows and a sunken shrine')
  await page.click('#begin')
  await page.waitForSelector('#card:not(.hidden)', { timeout: 120000 })
  await page.click('#card button.primary')
  await settle(4)
  const info = await G(() => { const d = window.__worldseed.game.debug(); return { ...d, teleport: undefined } })
  console.log('stones per shard:', info.stones.map((s) => s.length), 'items:', info.items.length, 'echoes:', info.echoes.length)

  // 1. Sealed shard refuses
  const s0 = info.shards[0].at
  await tp(s0[0] + 2.5, s0[2] + 2.5)
  console.log('at sealed shard:', JSON.stringify(await state()))
  await page.screenshot({ path: `${OUT}/p1-sealed.png` })
  await press('KeyE')
  console.log('after E on sealed:', (await state()).mode)

  // 2. Wake stones, then take each shard
  for (let i = 0; i < 4; i++) {
    for (const st of info.stones[i]) {
      await tp(st[0] + 1.6, st[2] + 1.6)
      if (i === 0 && st === info.stones[0][0]) { console.log('at stone:', JSON.stringify(await state())); await page.screenshot({ path: `${OUT}/p1-stone.png` }) }
      await press('KeyE')
    }
    const s = info.shards[i].at
    await tp(s[0] + 2.5, s[2] + 2.5)
    if (i === 0) { console.log('unsealed:', JSON.stringify(await state())); await page.screenshot({ path: `${OUT}/p1-unsealed.png` }) }
    await press('KeyE')
    await until(() => window.__worldseed.game.mode === 'card')
    await page.waitForTimeout(300)
    await page.keyboard.press('Enter')
    await until(() => window.__worldseed.game.mode === 'playing')
  }
  console.log('after shards:', JSON.stringify(await state()))

  // 3. Request: talk to wanderer 0 (asks), find item, return
  const talkThrough = async (i) => {
    const w = await G((i) => window.__worldseed.game.world.wanderers[i].position.toArray(), i)
    await tp(w[0] + 2, w[2] + 1)
    const lines = []
    await press('KeyE')
    for (let k = 0; k < 8; k++) {
      const open = await G(() => !document.querySelector('#dialogue').classList.contains('hidden'))
      if (!open) break
      lines.push(await G(() => document.querySelector('#dialogue .line').textContent))
      await press('KeyE')
    }
    return lines
  }
  console.log('talk 1:', JSON.stringify(await talkThrough(0), null, 1))
  const it = info.items[0]
  await tp(it[0] + 1.5, it[2] + 1.2)
  console.log('at item:', JSON.stringify(await state()))
  await page.screenshot({ path: `${OUT}/p1-item.png` })
  await press('KeyE')
  console.log('after pickup:', JSON.stringify(await state()))
  console.log('talk 2:', JSON.stringify(await talkThrough(0), null, 1))
  console.log('after return:', JSON.stringify(await state()))

  // 4. Echo
  const e = info.echoes[0]
  await tp(e[0], e[2])
  await settle(8)
  console.log('after echo:', JSON.stringify(await state()), await G(() => document.querySelector('#toasts').textContent.slice(-160)))
  await page.screenshot({ path: `${OUT}/p1-echo.png` })

  // 5. Map + journal
  await press('KeyM')
  await page.screenshot({ path: `${OUT}/p1-map.png` })
  await press('KeyM')
  await press('KeyJ')
  await page.screenshot({ path: `${OUT}/p1-journal.png` })
  await press('KeyJ')

  // 6. Finale with wanderer fate in the epilogue
  const h = info.heart
  await tp(h[0] + 7, h[2] + 7)
  await press('KeyE')
  await until(() => window.__worldseed.game.mode === 'card', null, 120000)
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  console.log('epilogue:', await G(() => document.querySelector('#card .body').innerText))
  await page.screenshot({ path: `${OUT}/p1-epilogue.png` })

  // 7. Reload: progress survives
  await page.keyboard.press('Enter')
  await until(() => window.__worldseed.game.mode === 'playing')
  await G(() => window.__worldseed.game.save())
  await page.reload()
  await page.waitForSelector('.recent-item')
  await page.click('.recent-item [data-act=open]')
  await until(() => window.__worldseed && window.__worldseed.game.mode === 'playing', null, 120000)
  console.log('after reload:', JSON.stringify(await G(() => { const g = window.__worldseed.game; return { sealsBroken: g.world.shards.map((s) => !s.seal.sealed), echoTaken: g.world.echoes.filter((e) => e.taken).length, itemTaken: g.world.items.map((i) => i.taken) } })))
  console.log('errors:', JSON.stringify(errors))
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
