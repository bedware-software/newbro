// Floating update notification popup. The tab content is hosted in native
// WebContentsViews, which draw above the main React renderer. A separate
// transparent child BrowserWindow keeps the notification visible without
// shrinking or otherwise changing the page viewport.

import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { log } from './log'

type UpdateToastStatus =
  | { phase: 'checking' }
  | { phase: 'not-available'; version: string }
  | { phase: 'available'; version: string; releaseNotes?: string | null }
  | { phase: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { phase: 'downloaded'; version: string; releaseNotes?: string | null }
  | { phase: 'error'; message: string }

interface ToastTargetRect {
  x: number
  y: number
  width: number
  height: number
}

interface UpdateToastSpec {
  status: UpdateToastStatus
  targetRect?: ToastTargetRect
  theme?: string
  themeVariant?: string
}

interface ToastRecord {
  win: BrowserWindow
  parent: BrowserWindow
  parentWebContentsId: number
  loaded: boolean
  /** Whether this window's renderer currently wants its toast shown. The
   *  toast is only actually painted when this window is also the owner
   *  (see reconcileVisibility) — so multiple open workspaces never stack
   *  duplicate toasts. */
  wantShown: boolean
  /** The spec last pushed to the popup, by reference. Lets reconcile skip
   *  redundant resends (which would restart the measure loop) while still
   *  repositioning / re-showing. */
  shownSpec: UpdateToastSpec | null
  lastSpec: UpdateToastSpec | null
  lastSize: { width: number; height: number } | null
  lastStatusKey: string | null
}

const toasts = new Map<number, ToastRecord>()

// The update notification is a single, app-wide affordance — it must never
// appear on more than one workspace window at a time. We track the most
// recently focused workspace window and only show the toast there; as focus
// moves between windows, the toast follows. `null` until the first focus is
// observed, in which case reconcile falls back to any window that wants it.
let lastFocusedParentId: number | null = null

const INITIAL_WIDTH = 360
const INITIAL_HEIGHT = 140
const SHADOW_PADDING = 16
const EDGE_MARGIN = 12

function popupHtmlPath(): { url?: string; file?: string } {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return { url: `${process.env['ELECTRON_RENDERER_URL']}/update-toast.html` }
  }
  return { file: join(__dirname, '../renderer/update-toast.html') }
}

function statusKey(status: UpdateToastStatus): string {
  switch (status.phase) {
    case 'not-available':
    case 'available':
    case 'downloaded':
      return `${status.phase}:${status.version}`
    case 'downloading':
      return `${status.phase}:${status.version}`
    case 'error':
      return `${status.phase}:${status.message}`
    default:
      return status.phase
  }
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.max(min, Math.min(max, value))
}

function getOrCreateToast(parent: BrowserWindow): ToastRecord {
  const parentWebContentsId = parent.webContents.id
  const existing = toasts.get(parentWebContentsId)
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
    // Never take focus. A focusable, always-on-top child window can grab
    // activation the moment it first paints (Windows raises it to the
    // foreground even when shown via showInactive), stealing focus from
    // whatever the user just opened — e.g. the Settings popup right after
    // launch. focusable:false (WS_EX_NOACTIVATE / non-activating panel) means
    // the toast can never be activated, so it never pulls focus from the
    // active window or raises its owner over a sibling popup. Mouse clicks on
    // the dismiss / install buttons still register on a non-activating window.
    focusable: false,
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
  win.setAlwaysOnTop(true, 'pop-up-menu')

  const html = popupHtmlPath()
  if (html.url) win.loadURL(html.url)
  else if (html.file) win.loadFile(html.file)

  const record: ToastRecord = {
    win,
    parent,
    parentWebContentsId,
    loaded: false,
    wantShown: false,
    shownSpec: null,
    lastSpec: null,
    lastSize: null,
    lastStatusKey: null,
  }
  toasts.set(parentWebContentsId, record)

  win.webContents.once('did-finish-load', () => {
    record.loaded = true
    // The renderer may have asked to show before the popup finished loading;
    // reconcile now that we can actually paint it.
    reconcileVisibility()
  })

  const reposition = (): void => {
    if (!win.isDestroyed() && win.isVisible()) positionToast(record)
  }
  const onFocus = (): void => {
    lastFocusedParentId = parentWebContentsId
    // Focus moved to this window — it becomes the toast owner, so move the
    // notification here and hide it everywhere else.
    reconcileVisibility()
  }
  parent.on('move', reposition)
  parent.on('resize', reposition)
  parent.on('focus', onFocus)
  parent.once('closed', () => {
    parent.removeListener('move', reposition)
    parent.removeListener('resize', reposition)
    parent.removeListener('focus', onFocus)
    if (lastFocusedParentId === parentWebContentsId) lastFocusedParentId = null
    if (!win.isDestroyed()) win.destroy()
    toasts.delete(parentWebContentsId)
    // Ownership may have just vacated — let another window pick the toast up.
    reconcileVisibility()
  })

  return record
}

/** The single window allowed to display the toast right now: the most
 *  recently focused workspace window, falling back to any live window that
 *  wants the toast (then any live window) when no focus has been seen yet. */
function currentOwnerId(): number | null {
  if (lastFocusedParentId !== null) {
    const r = toasts.get(lastFocusedParentId)
    if (r && !r.win.isDestroyed() && !r.parent.isDestroyed()) return lastFocusedParentId
  }
  let firstLive: number | null = null
  for (const [parentId, r] of toasts) {
    if (r.win.isDestroyed() || r.parent.isDestroyed()) continue
    if (firstLive === null) firstLive = parentId
    if (r.wantShown) return parentId
  }
  return firstLive
}

/** Enforce the "exactly one toast" invariant: the owner shows it (if its
 *  renderer wants it), every other window hides it. Cheap and idempotent —
 *  safe to call on any state change (status update, focus move, window
 *  open/close, resize). */
function reconcileVisibility(): void {
  const ownerId = currentOwnerId()
  for (const [parentId, record] of toasts) {
    if (record.win.isDestroyed()) continue
    const shouldShow =
      parentId === ownerId &&
      record.wantShown &&
      record.lastSpec !== null &&
      !record.parent.isDestroyed()

    if (shouldShow) {
      // Wait for the popup to load; did-finish-load re-runs reconcile.
      if (!record.loaded) continue
      if (record.shownSpec !== record.lastSpec) {
        record.win.webContents.send('update-toast:popup-spec', record.lastSpec)
        record.shownSpec = record.lastSpec
      }
      positionToast(record)
      if (!record.win.isVisible()) record.win.showInactive()
    } else if (record.win.isVisible()) {
      record.win.hide()
      record.shownSpec = null
    }
  }
}

function positionToast(record: ToastRecord): void {
  if (!record.lastSpec || record.win.isDestroyed() || record.parent.isDestroyed()) return

  const parentBounds = record.parent.getContentBounds()
  const target = record.lastSpec.targetRect ?? {
    x: 0,
    y: 0,
    width: parentBounds.width,
    height: parentBounds.height,
  }
  const measured = record.lastSize
  const toastWidth = measured?.width ?? INITIAL_WIDTH - SHADOW_PADDING * 2
  const toastHeight = measured?.height ?? INITIAL_HEIGHT - SHADOW_PADDING * 2

  const targetX = parentBounds.x + target.x
  const targetY = parentBounds.y + target.y
  const targetWidth = Math.max(0, target.width)
  const targetHeight = Math.max(0, target.height)

  const minCardX = parentBounds.x + EDGE_MARGIN
  const maxCardX = parentBounds.x + parentBounds.width - toastWidth - EDGE_MARGIN
  const minCardY = parentBounds.y + EDGE_MARGIN
  const maxCardY = parentBounds.y + parentBounds.height - toastHeight - EDGE_MARGIN

  const naturalCardX = targetX + targetWidth - toastWidth - EDGE_MARGIN
  const naturalCardY = targetY + targetHeight - toastHeight - EDGE_MARGIN
  const cardX = clamp(naturalCardX, minCardX, maxCardX)
  const cardY = clamp(naturalCardY, minCardY, maxCardY)

  record.win.setBounds({
    x: Math.round(cardX - SHADOW_PADDING),
    y: Math.round(cardY - SHADOW_PADDING),
    width: Math.round(toastWidth + SHADOW_PADDING * 2),
    height: Math.round(toastHeight + SHADOW_PADDING * 2),
  })
}

function openToast(parent: BrowserWindow, spec: UpdateToastSpec): void {
  const record = getOrCreateToast(parent)
  const nextStatusKey = statusKey(spec.status)
  if (record.lastStatusKey !== nextStatusKey) {
    record.lastSize = null
    record.lastStatusKey = nextStatusKey
  }
  record.lastSpec = spec
  record.wantShown = true
  // Claim ownership from the live focus state whenever the requesting window
  // is the focused one. This both seeds the very first toast after startup and
  // covers a just-opened window whose OS `focus` event fired before its toast
  // listener was attached — so the toast always lands on the window the user
  // is actually looking at, never an arbitrary background one.
  if (parent.isFocused()) {
    lastFocusedParentId = parent.webContents.id
  }
  reconcileVisibility()
}

function hideToast(parent: BrowserWindow): void {
  const record = toasts.get(parent.webContents.id)
  if (!record) return
  record.wantShown = false
  reconcileVisibility()
}

function hideAllToasts(): void {
  for (const record of toasts.values()) {
    if (!record.win.isDestroyed() && record.win.isVisible()) record.win.hide()
  }
}

function findOwnerByWebContents(senderId: number): ToastRecord | null {
  for (const record of toasts.values()) {
    if (record.win.isDestroyed()) continue
    if (record.win.webContents.id === senderId) return record
  }
  return null
}

export function registerUpdateToastIpc(): void {
  ipcMain.on('update-toast:show', (event, spec: UpdateToastSpec) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent || parent.isDestroyed()) return
    openToast(parent, spec)
  })

  ipcMain.on('update-toast:hide', (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent || parent.isDestroyed()) return
    hideToast(parent)
  })

  ipcMain.on('update-toast:popup-resize', (event, size: { width: number; height: number }) => {
    const owner = findOwnerByWebContents(event.sender.id)
    if (!owner) return
    owner.lastSize = size
    if (!owner.parent.isDestroyed()) positionToast(owner)
  })

  ipcMain.on('update-toast:popup-event', (event, evt: { type?: string; phase?: string }) => {
    const owner = findOwnerByWebContents(event.sender.id)
    if (!owner) return
    if (evt?.type === 'dismiss') {
      // Dismissal must stick across every workspace — otherwise the toast
      // would simply re-appear the moment focus moves to another window.
      // Tell all renderers to mark this phase dismissed and clear their
      // intent so reconcile keeps it hidden everywhere.
      for (const record of toasts.values()) {
        record.wantShown = false
        if (!record.parent.isDestroyed()) {
          record.parent.webContents.send('update-toast:event', evt)
        }
      }
      reconcileVisibility()
      return
    }
    if (!owner.parent.isDestroyed()) {
      owner.parent.webContents.send('update-toast:event', evt)
    }
  })

  app.on('before-quit', hideAllToasts)

  log.info('update-toast-window: ipc registered')
}
