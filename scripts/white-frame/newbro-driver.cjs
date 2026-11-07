// Drives the built Newbro for scripts/white-frame/record.mjs --newbro, which
// runs out/main/white-frame.js: this file, then Newbro's out/main/index.js.
// It opens a black page in a tab and goes back and forth between it and a
// black page on another site — the way Newbro's own back/forward does
// ('back': the IPC its mouse side buttons send), the page sending itself
// ('js'), or a click on a link ('click') — talking to record.mjs as app.cjs
// does (WF RECT / READY / END on stdout, WF_GO_FILE to start).
const { app, BrowserWindow, ipcMain, screen, webContents } = require('electron')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

// A profile of its own, set before Newbro's modules read it.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'newbro-white-frame-')))

const opt = { how: 'back', navs: 10, gap: 900, ...JSON.parse(process.env.WF_OPTIONS || '{}') }
const say = (...a) => process.stdout.write(`WF ${a.join(' ')}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const page = (other) => `<!doctype html><html><head><style>
html,body{margin:0;height:100%;background:#000}
a{position:fixed;inset:0;display:block}
</style></head><body><a href="${other}"></a></body></html>`

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    const port = server.address().port
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    if (req.url.startsWith('/ka.html')) res.end(page(`http://127.0.0.1:${port}/kb.html`))
    else res.end(page(`http://localhost:${port}/ka.html`))
  })
  await new Promise((r) => server.listen(0, r))
  const port = server.address().port
  const A = `http://localhost:${port}/ka.html`
  const B = `http://127.0.0.1:${port}/kb.html`

  let win
  for (let i = 0; i < 600 && !win; i++) {
    win = BrowserWindow.getAllWindows().find((w) => /renderer\/index\.html/.test(w.webContents.getURL()) && !w.webContents.isLoading())
    if (!win) await sleep(100)
  }
  if (!win) { say('FAIL no window'); app.exit(1); return }
  win.setBounds({ x: 40, y: 40, width: 880, height: 620 }) // fits a 1024x768 screen
  // On top for the recording, as app.cjs's window is: nothing else on the
  // runner's screen may cover it.
  win.setAlwaysOnTop(true)
  win.show()
  win.focus()
  await sleep(4000)
  say('NOTE', `window ${JSON.stringify(win.getBounds())}, visible ${win.isVisible()}, screen ${JSON.stringify(screen.getPrimaryDisplay().bounds)}`)
  win.webContents.send('open-url-as-tab', A)
  let wc
  for (let i = 0; i < 200 && !wc; i++) {
    wc = webContents.getAllWebContents().find((w) => w.getURL() === A && !w.isLoading())
    if (!wc) await sleep(100)
  }
  if (!wc) { say('FAIL no tab'); app.exit(1); return }
  if (opt.how === 'back') await wc.loadURL(B)
  // A new tab focuses the address bar, whose suggestions open in a window of
  // their own over the page: give the page the keyboard, and put away any
  // other window of Newbro's still showing.
  wc.focus()
  await sleep(1000)
  for (const other of BrowserWindow.getAllWindows()) {
    if (other === win || other.isDestroyed() || !other.isVisible()) continue
    say('NOTE', `hid another window: ${other.webContents.getURL().slice(0, 80)} ${JSON.stringify(other.getBounds())}`)
    other.hide()
  }
  await sleep(1000)

  const view = win.contentView.children.find((v) => v.webContents === wc)
  const cb = win.getContentBounds()
  const vb = view.getBounds()
  const sf = screen.getDisplayMatching(cb).scaleFactor
  const px = (v) => Math.round(v * sf)
  say('NOTE', `content ${JSON.stringify(cb)}, tab view ${JSON.stringify(vb)}, tabs ${win.contentView.children.length} views`)
  // The tab's own area: no border of ours around it to check (inset 0).
  say('RECT', JSON.stringify({ x: px(cb.x + vb.x), y: px(cb.y + vb.y), w: px(vb.width), h: px(vb.height), inset: 0, scaleFactor: sf }))
  say('READY')
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!fs.existsSync(process.env.WF_GO_FILE)) return
      clearInterval(poll)
      resolve()
    }, 20)
  })

  for (let i = 0; i < opt.navs; i++) {
    if (opt.how === 'back') {
      ipcMain.emit('newbro-nav', { sender: wc }, i % 2 === 0 ? 'back' : 'forward')
    } else if (opt.how === 'js') {
      const next = wc.getURL().includes('/ka.html') ? B : A
      wc.executeJavaScript(`location.href = ${JSON.stringify(next)}`).catch(() => {})
    } else {
      const x = 100, y = 100
      wc.sendInputEvent({ type: 'mouseMove', x, y })
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    }
    say('NAV', i)
    await sleep(opt.gap)
  }
  // The page the tab ended on got Newbro's tab preload: its main-world part
  // marks the window.
  const preload = await wc.executeJavaScript('window.__newbroPseudoFullscreenInstalled === true').catch((e) => String(e))
  say('NOTE', `tab preload ran on ${wc.getURL()}: ${preload}`)
  await sleep(400)
  say('END')
  app.exit(0)
})
