// Floating dropdown popup. The site `WebContentsView` is a native compositing
// layer that always sits above the main renderer's HTML, which would otherwise
// hide a `position: absolute` dropdown rendered inside the toolbar. Hosting
// the dropdown inside its own transparent, frameless, always-on-top child
// `BrowserWindow` puts it at a higher z-order than any `WebContentsView` in
// the parent — the site stays fully live while the dropdown is open.
//
// One popup window is created per parent window on first use and reused for
// the lifetime of that parent (cheaper than create/destroy on every click).
// The popup window is hidden between uses; the popup renderer keeps the last
// spec around so a quick re-open feels instant.

import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { log } from './log'

interface DropdownAnchor {
  x: number
  y: number
  width: number
  height: number
}

interface DropdownPosition {
  x: number
  y: number
}

interface DropdownSpecPayload {
  openerId: string
  kind: 'list' | 'menu'
  // Exactly one of these should be set; we prefer position when both arrive.
  anchor?: DropdownAnchor
  position?: DropdownPosition
  theme?: string
  themeVariant?: string
  iconName?: string
  selectedId?: string | null
  items?: Array<{ id: string; name: string }>
  reorder?: boolean
  editable?: boolean
  deletable?: boolean
  canDelete?: boolean
  newAction?: { label: string }
  actions?: Array<{
    id: string
    label: string
    iconName: string
    shortcut?: string
    destructive?: boolean
    divider?: 'before'
  }>
}

interface PopupRecord {
  win: BrowserWindow
  // Direct BrowserWindow reference — events get routed back via
  // `parent.webContents.send(...)`. Earlier we stored
  // `parent.webContents.id` and tried to recover the parent via
  // `BrowserWindow.fromId`, but `fromId` takes a `BrowserWindow.id`
  // (different counter from `webContents.id`); for the first window
  // they often coincidentally match, for the second+ window they
  // diverge and `fromId` returns null, so popup events from those
  // windows silently dropped. The Map key is still the webContents id
  // (one popup per parent webContents) — only the routing changes.
  parent: BrowserWindow
  parentWebContentsId: number
  // Opener id of the trigger that opened the currently-shown popup. Echoed
  // back on every event so the parent renderer can route to the right
  // component (multiple Dropdowns share a single popup window).
  currentOpenerId: string | null
  // Set true while we're hiding the popup ourselves so the resulting `blur`
  // event doesn't get reported back as a user-initiated cancel.
  closingProgrammatically: boolean
  // Becomes true after the popup HTML's first did-finish-load. Open requests
  // arriving before this point are queued and replayed once it fires (a
  // single second open while loading is enough to clobber the queued one).
  loaded: boolean
  pendingOpen: (() => void) | null
  // Last placement — either an anchor (popup BELOW a trigger button) or a
  // position (popup AT a cursor point). Stored on the record so the resize
  // handler can re-place the window once the popup reports its real size.
  lastAnchor: DropdownAnchor | null
  lastPosition: DropdownPosition | null
  // Most recently measured menu size (from popup-resize), kept so we can
  // place the window precisely on the next show before the popup re-measures.
  lastSize: { width: number; height: number } | null
}

// Keyed by parent.webContents.id — one popup window per parent renderer.
const popups = new Map<number, PopupRecord>()
// Parent's webContents id currently displaying a popup, so popup-event IPC
// (which arrives on the popup's webContents) can be routed back to its
// parent.
let currentParentWebContentsId: number | null = null

// Generous initial size so the popup can render its full content from the
// first paint, even before the popup-resize round-trip arrives. Both axes
// are clipped by the popup's overflow-hidden body if a menu happens to be
// larger; the resize callback then snaps the window snugly around it.
const INITIAL_WIDTH = 320
const INITIAL_HEIGHT = 600
// Vertical gap between the trigger button and the popup's top edge
// (anchor mode only — position mode opens at the cursor exactly).
const ANCHOR_GAP = 4
// Inner padding (every side) where the menu's CSS box-shadow paints. Must
// match the body padding in dropdown.html.
const SHADOW_PADDING = 16
// Smallest distance to keep between the menu and the parent's content edge
// when clamping; prevents the menu from butting up against the window chrome.
const EDGE_MARGIN = 6

function popupHtmlPath(): { url?: string; file?: string } {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return { url: `${process.env['ELECTRON_RENDERER_URL']}/dropdown.html` }
  }
  return { file: join(__dirname, '../renderer/dropdown.html') }
}

function getOrCreatePopup(parent: BrowserWindow): PopupRecord {
  const parentWebContentsId = parent.webContents.id
  const existing = popups.get(parentWebContentsId)
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
    focusable: true,
    width: INITIAL_WIDTH,
    height: INITIAL_HEIGHT,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  // Float above other always-on-top windows so the popup is visible even when
  // the parent is in fullscreen on macOS.
  win.setAlwaysOnTop(true, 'pop-up-menu')

  const html = popupHtmlPath()
  if (html.url) win.loadURL(html.url)
  else if (html.file) win.loadFile(html.file)

  const record: PopupRecord = {
    win,
    parent,
    parentWebContentsId,
    currentOpenerId: null,
    closingProgrammatically: false,
    loaded: false,
    pendingOpen: null,
    lastAnchor: null,
    lastPosition: null,
    lastSize: null,
  }
  popups.set(parentWebContentsId, record)

  win.webContents.once('did-finish-load', () => {
    record.loaded = true
    const pending = record.pendingOpen
    record.pendingOpen = null
    if (pending) pending()
  })

  // Auto-close on focus loss (user clicked outside the popup). When *we*
  // hide the window, blur fires too — the flag suppresses that case.
  win.on('blur', () => {
    if (record.closingProgrammatically) return
    if (!win.isVisible()) return
    closePopup(record, /* fromBlur */ true)
  })

  // Tear down when the parent window is destroyed.
  parent.once('closed', () => {
    if (!win.isDestroyed()) win.destroy()
    popups.delete(parentWebContentsId)
    if (currentParentWebContentsId === parentWebContentsId) currentParentWebContentsId = null
  })

  return record
}

function positionPopup(record: PopupRecord, parent: BrowserWindow): void {
  const parentBounds = parent.getContentBounds()
  const measured = record.lastSize
  // Use the measured menu size if available, otherwise the generous initial
  // size. Clamping math operates on the MENU'S extent (shadow padding lives
  // inside the window but outside the visible menu rect, so we ignore it
  // here and add it back when computing window bounds).
  const menuWidth = measured ? measured.width : INITIAL_WIDTH - SHADOW_PADDING * 2
  const menuHeight = measured ? measured.height : INITIAL_HEIGHT - SHADOW_PADDING * 2

  // Compute natural placement (where the menu WOULD go if there were no
  // edges to worry about).
  let menuX: number
  let menuY: number
  if (record.lastPosition) {
    menuX = parentBounds.x + record.lastPosition.x
    menuY = parentBounds.y + record.lastPosition.y
  } else if (record.lastAnchor) {
    menuX = parentBounds.x + record.lastAnchor.x
    menuY = parentBounds.y + record.lastAnchor.y + record.lastAnchor.height + ANCHOR_GAP
  } else {
    return
  }

  // Off-screen clamping. Keep the menu inside the parent's content area on
  // both axes. For Y we prefer to FLIP above the trigger/cursor when the
  // menu wouldn't fit below — that matches native context-menu behavior.
  const minX = parentBounds.x + EDGE_MARGIN
  const maxX = parentBounds.x + parentBounds.width - menuWidth - EDGE_MARGIN
  if (menuX > maxX) menuX = maxX
  if (menuX < minX) menuX = minX

  const minY = parentBounds.y + EDGE_MARGIN
  const maxY = parentBounds.y + parentBounds.height - menuHeight - EDGE_MARGIN
  if (menuY > maxY) {
    if (record.lastAnchor) {
      // Flip above the trigger button.
      const flipped = parentBounds.y + record.lastAnchor.y - menuHeight - ANCHOR_GAP
      menuY = flipped >= minY ? flipped : maxY
    } else if (record.lastPosition) {
      // Flip above the cursor — keep the same x, place the menu so its
      // bottom-edge sits at the click point (matches macOS context menus).
      const flipped = parentBounds.y + record.lastPosition.y - menuHeight
      menuY = flipped >= minY ? flipped : maxY
    } else {
      menuY = maxY
    }
  }
  if (menuY < minY) menuY = minY

  // Window bounds = menu rect inflated by SHADOW_PADDING on every side, so
  // the menu's CSS shadow paints inside the transparent window.
  const winWidth = menuWidth + SHADOW_PADDING * 2
  const winHeight = menuHeight + SHADOW_PADDING * 2
  record.win.setBounds({
    x: Math.round(menuX - SHADOW_PADDING),
    y: Math.round(menuY - SHADOW_PADDING),
    width: Math.round(winWidth),
    height: Math.round(winHeight),
  })
}

function openPopup(parent: BrowserWindow, spec: DropdownSpecPayload): void {
  const record = getOrCreatePopup(parent)

  // Superseding a different opener: tell the previous one it was cancelled
  // so its parent-side state stays in sync. Same opener re-asking is just
  // a no-op (e.g. user clicked the trigger they already had open).
  if (
    record.win.isVisible() &&
    record.currentOpenerId &&
    record.currentOpenerId !== spec.openerId
  ) {
    parent.webContents.send('dropdown:event', {
      type: 'cancel',
      openerId: record.currentOpenerId,
    })
  }

  record.lastAnchor = spec.anchor ?? null
  record.lastPosition = spec.position ?? null
  // Reset the measured size when the spec changes — content height likely
  // differs, and a stale size would mis-position the new dropdown.
  record.lastSize = null
  record.currentOpenerId = spec.openerId

  const send = (): void => {
    if (record.win.isDestroyed()) return
    record.win.webContents.send('dropdown:popup-spec', spec)
    positionPopup(record, parent)
    currentParentWebContentsId = record.parentWebContentsId
    record.closingProgrammatically = false
    record.win.show()
    record.win.focus()
  }

  if (record.loaded) {
    send()
  } else {
    // First open before the popup HTML has finished loading: stash the latest
    // request so did-finish-load replays it. A second open arriving in this
    // window simply overwrites the first — the most recent spec wins.
    record.pendingOpen = send
  }
}

function closePopup(record: PopupRecord, fromBlur: boolean): void {
  if (record.win.isDestroyed()) return
  const closingOpenerId = record.currentOpenerId
  record.closingProgrammatically = true
  record.win.hide()
  // If close originated from blur, tell the parent so it can update its
  // own state. Programmatic close from a popup-event already triggered a
  // forwarded event upstream, so no second cancel is needed.
  if (fromBlur && closingOpenerId) {
    if (!record.parent.isDestroyed()) {
      record.parent.webContents.send('dropdown:event', { type: 'cancel', openerId: closingOpenerId })
    }
  }
  record.currentOpenerId = null
  if (currentParentWebContentsId === record.parentWebContentsId) currentParentWebContentsId = null
}

function closeAnyOpen(): void {
  for (const record of popups.values()) {
    if (record.win.isDestroyed()) continue
    if (record.win.isVisible()) closePopup(record, /* fromBlur */ false)
  }
}

function findOwnerByWebContents(senderId: number): PopupRecord | null {
  for (const r of popups.values()) {
    if (r.win.isDestroyed()) continue
    if (r.win.webContents.id === senderId) return r
  }
  return null
}

export function registerDropdownIpc(): void {
  // Renderer asks main to open the popup.
  ipcMain.on('dropdown:open', (event, spec: DropdownSpecPayload) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent) return
    openPopup(parent, spec)
  })

  // Renderer asks main to force-close the popup (e.g. trigger toggle).
  ipcMain.on('dropdown:close', (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent) return
    const record = popups.get(parent.webContents.id)
    if (record && record.win.isVisible()) closePopup(record, /* fromBlur */ false)
  })

  // Popup forwards a user action. Route to parent window's renderer; close
  // on terminal events (everything except 'reorder', which lets the user keep
  // dragging items without reopening the popup).
  ipcMain.on('dropdown:popup-event', (event, evt: { type: string }) => {
    const owner = findOwnerByWebContents(event.sender.id)
    if (!owner) return
    const openerId = owner.currentOpenerId
    if (!openerId) return
    if (!owner.parent.isDestroyed()) {
      owner.parent.webContents.send('dropdown:event', { ...evt, openerId })
    }
    if (evt.type !== 'reorder') {
      closePopup(owner, /* fromBlur */ false)
    }
  })

  // Popup reports its measured natural size; we resize the window snugly.
  ipcMain.on('dropdown:popup-resize', (event, size: { width: number; height: number }) => {
    const owner = findOwnerByWebContents(event.sender.id)
    if (!owner) return
    owner.lastSize = size
    if (!owner.parent.isDestroyed()) {
      positionPopup(owner, owner.parent)
    }
  })

  app.on('before-quit', () => {
    closeAnyOpen()
  })

  log.info('dropdown-window: ipc registered')
}
