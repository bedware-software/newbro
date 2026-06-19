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
  pendingOpen: (() => void) | null
  lastSpec: UpdateToastSpec | null
  lastSize: { width: number; height: number } | null
  lastStatusKey: string | null
}

const toasts = new Map<number, ToastRecord>()

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
  win.setAlwaysOnTop(true, 'pop-up-menu')

  const html = popupHtmlPath()
  if (html.url) win.loadURL(html.url)
  else if (html.file) win.loadFile(html.file)

  const record: ToastRecord = {
    win,
    parent,
    parentWebContentsId,
    loaded: false,
    pendingOpen: null,
    lastSpec: null,
    lastSize: null,
    lastStatusKey: null,
  }
  toasts.set(parentWebContentsId, record)

  win.webContents.once('did-finish-load', () => {
    record.loaded = true
    const pending = record.pendingOpen
    record.pendingOpen = null
    if (pending) pending()
  })

  const reposition = (): void => {
    if (!win.isDestroyed() && win.isVisible()) positionToast(record)
  }
  parent.on('move', reposition)
  parent.on('resize', reposition)
  parent.once('closed', () => {
    parent.removeListener('move', reposition)
    parent.removeListener('resize', reposition)
    if (!win.isDestroyed()) win.destroy()
    toasts.delete(parentWebContentsId)
  })

  return record
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

  const send = (): void => {
    if (record.win.isDestroyed()) return
    record.win.webContents.send('update-toast:popup-spec', spec)
    positionToast(record)
    record.win.showInactive()
  }

  if (record.loaded) send()
  else record.pendingOpen = send
}

function hideToast(parent: BrowserWindow): void {
  const record = toasts.get(parent.webContents.id)
  if (!record || record.win.isDestroyed() || !record.win.isVisible()) return
  record.win.hide()
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
    if (!owner.parent.isDestroyed()) {
      owner.parent.webContents.send('update-toast:event', evt)
    }
    if (evt?.type === 'dismiss' && !owner.win.isDestroyed()) {
      owner.win.hide()
    }
  })

  app.on('before-quit', hideAllToasts)

  log.info('update-toast-window: ipc registered')
}
