// The address bar's suggestion list. Like the dropdown menus it's its own
// transparent child window — tab pages are native views that paint over the
// app's DOM — but it never takes focus: focusable:false and shown inactive,
// so the address bar keeps the keyboard (arrows, Enter, Esc all stay there)
// and the list only reports clicks back. See components/omnibox-protocol.ts.

import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { log } from './log'

interface Anchor {
  x: number
  y: number
  width: number
  height: number
}

interface PopupSpec {
  anchor: Anchor
  rows: unknown[]
}

interface PopupRecord {
  win: BrowserWindow
  parent: BrowserWindow
  loaded: boolean
  visible: boolean
  spec: PopupSpec | null
  /** The list's measured height (without the shadow margin). */
  height: number | null
}

// Keyed by the parent's webContents id — one popup per workspace window.
const popups = new Map<number, PopupRecord>()

// Transparent margin around the list where its CSS shadow paints; must match
// the body padding in omnibox.html.
const SHADOW_PADDING = 12
// Gap between the URL bar and the list.
const ANCHOR_GAP = 4
// Height guess until the popup has measured itself: rows are ~40px plus the
// list's padding.
const ROW_HEIGHT_ESTIMATE = 40
const LIST_PADDING_ESTIMATE = 8
const EDGE_MARGIN = 6

function popupHtml(): { url?: string; file?: string } {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return { url: `${process.env['ELECTRON_RENDERER_URL']}/omnibox.html` }
  }
  return { file: join(__dirname, '../renderer/omnibox.html') }
}

function getOrCreate(parent: BrowserWindow): PopupRecord {
  const key = parent.webContents.id
  const existing = popups.get(key)
  if (existing && !existing.win.isDestroyed()) return existing

  const win = new BrowserWindow({
    parent,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never take focus: clicks still land on a non-activating window, while
    // the address bar in the parent keeps focus and the keyboard.
    focusable: false,
    width: 600,
    height: 300,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  // Above a macOS fullscreen parent too, like the dropdown menus.
  win.setAlwaysOnTop(true, 'pop-up-menu')

  const record: PopupRecord = { win, parent, loaded: false, visible: false, spec: null, height: null }
  popups.set(key, record)

  const html = popupHtml()
  if (html.url) void win.loadURL(html.url)
  else if (html.file) void win.loadFile(html.file)
  win.webContents.once('did-finish-load', () => {
    record.loaded = true
    if (record.visible && record.spec) present(record)
  })

  // The list belongs to the address bar as it was laid out: moving, resizing
  // or leaving the window closes it (the renderer reopens it on the next
  // keystroke).
  const close = (): void => hide(record)
  parent.on('move', close)
  parent.on('resize', close)
  parent.on('blur', close)
  parent.on('minimize', close)
  parent.once('closed', () => {
    if (!win.isDestroyed()) win.destroy()
    popups.delete(key)
  })
  return record
}

function position(record: PopupRecord): void {
  const spec = record.spec
  if (!spec || record.win.isDestroyed() || record.parent.isDestroyed()) return
  const content = record.parent.getContentBounds()
  const listHeight = record.height ?? spec.rows.length * ROW_HEIGHT_ESTIMATE + LIST_PADDING_ESTIMATE
  const x = content.x + spec.anchor.x
  const y = content.y + spec.anchor.y + spec.anchor.height + ANCHOR_GAP
  // Keep the list inside the window: a short window scrolls the list instead.
  const maxHeight = Math.max(80, content.y + content.height - EDGE_MARGIN - y)
  const height = Math.min(listHeight, maxHeight)
  record.win.setBounds({
    x: Math.round(x - SHADOW_PADDING),
    y: Math.round(y - SHADOW_PADDING),
    width: Math.round(spec.anchor.width + SHADOW_PADDING * 2),
    height: Math.round(height + SHADOW_PADDING * 2),
  })
}

function present(record: PopupRecord): void {
  if (!record.spec || record.win.isDestroyed()) return
  record.win.webContents.send('omnibox:popup-spec', record.spec)
  position(record)
  if (!record.win.isVisible()) record.win.showInactive()
}

function show(parent: BrowserWindow, spec: PopupSpec): void {
  const record = getOrCreate(parent)
  // A different row count makes the last measurement stale.
  if (record.spec && record.spec.rows.length !== spec.rows.length) record.height = null
  record.spec = spec
  record.visible = true
  if (record.loaded) present(record)
}

function hide(record: PopupRecord): void {
  record.visible = false
  if (!record.win.isDestroyed() && record.win.isVisible()) record.win.hide()
}

function findByPopup(senderId: number): PopupRecord | null {
  for (const record of popups.values()) {
    if (!record.win.isDestroyed() && record.win.webContents.id === senderId) return record
  }
  return null
}

export function registerOmniboxPopupIpc(): void {
  ipcMain.on('omnibox:show', (event, spec: PopupSpec) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent || parent.isDestroyed() || !spec?.anchor || !Array.isArray(spec.rows)) return
    // Opening while the window isn't focused would float the list over
    // whatever the user switched to.
    if (!parent.isFocused()) return
    show(parent, spec)
  })

  // Create the window (and load its page) ahead of the first keystroke, so
  // the first list appears without waiting for it.
  ipcMain.on('omnibox:prewarm', (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (parent && !parent.isDestroyed()) getOrCreate(parent)
  })

  ipcMain.on('omnibox:hide', (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent) return
    const record = popups.get(parent.webContents.id)
    if (record) hide(record)
  })

  ipcMain.on('omnibox:popup-event', (event, evt: unknown) => {
    const record = findByPopup(event.sender.id)
    if (!record || record.parent.isDestroyed()) return
    record.parent.webContents.send('omnibox:event', evt)
  })

  ipcMain.on('omnibox:popup-resize', (event, size: { height: number }) => {
    const record = findByPopup(event.sender.id)
    if (!record || !Number.isFinite(size?.height)) return
    record.height = size.height
    if (record.visible) position(record)
  })

  app.on('before-quit', () => {
    for (const record of popups.values()) hide(record)
  })

  log.info('omnibox-popup: ipc registered')
}
