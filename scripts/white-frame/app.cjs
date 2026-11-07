// The minimal Electron app scripts/white-frame/record.mjs records: a window
// with a WebContentsView set up like a Newbro tab (see-through background,
// contextIsolation, sandbox on or off) going back and forth between two black
// pages on different sites — localhost and 127.0.0.1 — so every navigation
// swaps the renderer process. Nothing of Newbro's is loaded.
//
// Options come as JSON in WF_OPTIONS (record.mjs sets them):
//   sandbox  the view's webPreferences.sandbox
//   how      'back'  — history back/forward (no user activation on the page)
//            'js'    — the page sets location.href (no user activation)
//            'click' — a mouse click on a link (user activation)
//   navs     how many navigations, gap ms between them
//   stallMs  hold every new page's first paint this long (a sync IPC from the
//            preload), as a slow site would
//   fix      re-apply the view's background colour when a navigation commits
//            (what src/main/tab-views.ts does for tabs)
//
// It talks to record.mjs over stdio: prints "WF RECT {x,y,w,h}" (the view, in
// screen pixels) and "WF READY", waits for "GO" on stdin, navigates, prints
// "WF END" and quits.
const { app, BrowserWindow, WebContentsView, ipcMain, screen } = require('electron')
const http = require('node:http')
const path = require('node:path')

const opt = {
  sandbox: false,
  how: 'back',
  navs: 10,
  gap: 900,
  stallMs: 0,
  fix: false,
  ...JSON.parse(process.env.WF_OPTIONS || '{}'),
}
const t0 = Date.now()
const say = (...a) => process.stdout.write(`WF ${a.join(' ')}\n`)
const log = (...a) => process.stdout.write(`[wf +${Date.now() - t0}] ${a.join(' ')}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Black pages, the link covering the whole page.
const page = (other) => `<!doctype html><html><head><style>
html,body{margin:0;height:100%;background:#000}
a{position:fixed;inset:0;display:block}
</style></head><body><a href="${other}"></a></body></html>`

ipcMain.on('wf-stall', (event) => {
  setTimeout(() => { event.returnValue = 'ok' }, opt.stallMs)
})

const WINDOW_BG = '#400000' // what shows through a see-through view
const VIEW_BG = '#00000000' // Newbro's tabs: see-through

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

  const W = 640, H = 480, INSET = 40
  const win = new BrowserWindow({
    x: 80, y: 80, width: W, height: H,
    frame: false, resizable: false, alwaysOnTop: true,
    backgroundColor: WINDOW_BG,
    webPreferences: { sandbox: true },
  })
  await win.loadURL(`data:text/html,<body style="margin:0;background:${encodeURIComponent(WINDOW_BG)}"></body>`)

  const webPreferences = { sandbox: !!opt.sandbox, contextIsolation: true, nodeIntegration: false }
  if (opt.stallMs) webPreferences.preload = path.join(__dirname, 'stall-preload.cjs')
  const view = new WebContentsView({ webPreferences })
  view.setBackgroundColor(VIEW_BG)
  win.contentView.addChildView(view)
  view.setBounds({ x: INSET, y: INSET, width: W - 2 * INSET, height: H - 2 * INSET })
  const wc = view.webContents
  wc.on('did-navigate', (_e, url) => {
    // The fix: the view Chromium swaps in for a new renderer starts out white
    // and Electron colours only the view it replaces — colour the new one now,
    // in the same task as the swap, before it can be drawn.
    if (opt.fix) view.setBackgroundColor(VIEW_BG)
    log('navigated', url, 'pid', wc.getOSProcessId())
  })
  wc.on('render-process-gone', (_e, d) => log('gone', JSON.stringify(d)))

  await wc.loadURL(A)
  if (opt.how === 'back') {
    await wc.loadURL(B) // history: A, B — then back, forward, back…
  }
  await sleep(1500)

  const cb = win.getContentBounds()
  const vb = view.getBounds()
  const sf = screen.getDisplayMatching(cb).scaleFactor
  const px = (v) => Math.round(v * sf)
  say('RECT', JSON.stringify({ x: px(cb.x + vb.x), y: px(cb.y + vb.y), w: px(vb.width), h: px(vb.height), scaleFactor: sf }))
  say('READY')
  await new Promise((resolve) => {
    let buf = ''
    process.stdin.on('data', (d) => { buf += d; if (buf.includes('GO')) resolve() })
  })

  for (let i = 0; i < opt.navs; i++) {
    if (opt.how === 'back') {
      if (i % 2 === 0) wc.navigationHistory.goBack()
      else wc.navigationHistory.goForward()
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
    await sleep(opt.gap + opt.stallMs)
  }
  await sleep(400)
  say('END')
  app.exit(0)
})
