// chrome.sidePanel for Newbro.
//
// Chrome docks an extension page beside the tab content. We do the same
// with a WebContentsView in the workspace window: the renderer lays out a
// right-hand column (SidePanel.tsx) and reports its placeholder rect, the
// same contract WebviewPanel uses for tabs, and the visible panel view is
// pinned there.
//
// Model — the subset of Chrome's that extensions rely on:
//  - Options per extension: a global { path, enabled } seeded from the
//    manifest's side_panel.default_path, plus per-tab overrides from
//    setOptions({ tabId }).
//  - open({ tabId }) on a tab with its own options opens a panel bound to
//    that tab, shown only while the tab is active (Claude keeps one panel
//    per tab this way). Otherwise open() opens the window-wide panel.
//  - One visible panel per window: the active tab's bound panel wins,
//    else the window-wide one. Hidden panels keep their page alive.
//  - window.close() from the panel page (Claude's toggle path) and the
//    column's close button both close it.
//
// The chrome.sidePanel namespace itself is installed into extension
// workers and pages by the extension-shim preload; its calls land in
// handleCall via api-ipc's 'sidepanel' channel.

import { BrowserWindow, Menu, WebContentsView, ipcMain, session } from 'electron'
import { join } from 'node:path'
import { log } from '../log'
import { registerExtensionApiHandler } from './api-ipc'
import { ensureExtensionInSession, getSidePanelDefaultPath } from './manager'
import { setupPartitionSession, shouldDropExtConsoleMessage } from '../index'
import {
  addTabActivityListener,
  getActiveChromeTabIdForWindow,
  getWindowIdForChromeTabId,
  installFrameStorageBridge,
  pickPartitionForWindow,
} from '../tab-views'

const WEBVIEW_STEALTH_PRELOAD = join(__dirname, '../preload/webview-stealth.js')

interface Rect {
  x: number
  y: number
  width: number
  height: number
}
const HIDDEN: Rect = { x: 0, y: 0, width: 0, height: 0 }

interface PanelOptions {
  path?: string
  enabled?: boolean
}

interface ExtensionPanelState {
  global: PanelOptions
  tabs: Map<number, PanelOptions>
  openOnActionClick: boolean
}

interface PanelEntry {
  windowId: number
  /** Partition whose extension state owns this panel. */
  partition: string
  extensionId: string
  /** Chrome tab id for a tab-bound panel; null = window-wide. */
  chromeTabId: number | null
  path: string
  view: WebContentsView
}

/** Keyed by partition + extension id: options are per profile, like Chrome's. */
const extensionState = new Map<string, ExtensionPanelState>()
const entries = new Set<PanelEntry>()
const visibleByWindow = new Map<number, PanelEntry>()
/** Latest placeholder rect reported by each window's renderer. */
const boundsByWindow = new Map<number, Rect>()
const hookedWindows = new Set<number>()

function stateFor(partition: string, extensionId: string): ExtensionPanelState {
  const key = `${partition}\n${extensionId}`
  let st = extensionState.get(key)
  if (!st) {
    st = {
      global: { path: getSidePanelDefaultPath(extensionId) ?? undefined, enabled: true },
      tabs: new Map(),
      openOnActionClick: false,
    }
    extensionState.set(key, st)
  }
  return st
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function panelUrl(extensionId: string, path: string): string {
  return `chrome-extension://${extensionId}/${path.replace(/^\/+/, '')}`
}

function sendState(windowId: number): void {
  const win = BrowserWindow.fromId(windowId)
  if (!win || win.isDestroyed()) return
  win.webContents.send('sidepanel-state', stateForWindow(windowId))
}

function stateForWindow(windowId: number): { extensionId: string | null } {
  return { extensionId: visibleByWindow.get(windowId)?.extensionId ?? null }
}

/** Re-pick which panel the window shows after anything that can change
 *  it: open/close, tab switch, tab teardown. */
function refreshWindow(windowId: number): void {
  const win = BrowserWindow.fromId(windowId)
  const activeTab = getActiveChromeTabIdForWindow(windowId)
  let next: PanelEntry | undefined
  for (const e of entries) {
    if (e.windowId !== windowId) continue
    if (activeTab !== null && e.chromeTabId === activeTab) {
      next = e
      break
    }
    if (e.chromeTabId === null) next = e
  }
  const current = visibleByWindow.get(windowId)
  if (current === next) return
  if (current) {
    visibleByWindow.delete(windowId)
    if (win && !win.isDestroyed()) {
      try { win.contentView.removeChildView(current.view) } catch { /* already detached */ }
    }
  }
  if (next && win && !win.isDestroyed()) {
    win.contentView.addChildView(next.view)
    next.view.setBounds(boundsByWindow.get(windowId) ?? HIDDEN)
    visibleByWindow.set(windowId, next)
  }
  sendState(windowId)
}

function closeEntry(entry: PanelEntry, reason: string): void {
  if (!entries.delete(entry)) return
  log.info('sidepanel: closed', { extensionId: entry.extensionId, chromeTabId: entry.chromeTabId, reason })
  // Detaches the view if it was showing, picks what shows instead and
  // tells the renderer.
  refreshWindow(entry.windowId)
  // A page that closed itself is already being destroyed by Electron.
  if (reason === 'page-closed') return
  const wc = entry.view.webContents
  if (!wc.isDestroyed()) {
    try { wc.close() } catch (err) { log.warn('sidepanel: wc.close threw', { err: String(err) }) }
  }
}

function hookWindow(windowId: number, win: BrowserWindow): void {
  if (hookedWindows.has(windowId)) return
  hookedWindows.add(windowId)
  win.once('closed', () => {
    hookedWindows.delete(windowId)
    boundsByWindow.delete(windowId)
    visibleByWindow.delete(windowId)
    for (const e of [...entries]) {
      if (e.windowId !== windowId) continue
      entries.delete(e)
      try { if (!e.view.webContents.isDestroyed()) e.view.webContents.close() } catch { /* window teardown */ }
    }
  })
}

function wireView(entry: PanelEntry): void {
  const { view, extensionId } = entry
  const wc = view.webContents
  // window.close() from the panel page (Claude's own close path):
  // Electron emits 'close' and then destroys the webContents. Detach
  // here, while it's still alive — detaching after 'destroyed' hangs the
  // main process.
  ;(wc as unknown as NodeJS.EventEmitter).once('close', () => {
    if (entries.has(entry)) closeEntry(entry, 'page-closed')
  })
  wc.on('did-finish-load', () => {
    installFrameStorageBridge(wc, `sidepanel/${extensionId}`).catch((err) => {
      log.warn('sidepanel: storage bridge install threw', { extensionId, err: String(err) })
    })
  })
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    log.warn('sidepanel: did-fail-load', { extensionId, url: validatedURL, errorCode, errorDescription })
  })
  wc.on('render-process-gone', (_e, details) => {
    log.error('sidepanel: renderer gone', { extensionId, details })
  })
  wc.on('console-message', (e) => {
    const detail = e as unknown as { level?: string; message?: string; sourceId?: string; line?: number }
    const msg = String(detail.message ?? '')
    const isError = detail.level === 'warning' || detail.level === 'error'
    if (!isError && shouldDropExtConsoleMessage(msg)) return
    log.info('sidepanel console', {
      extensionId,
      level: detail.level,
      sourceId: detail.sourceId,
      line: detail.line,
      msg: msg.length > 400 ? msg.slice(0, 400) + ` …(${msg.length - 400} more)` : msg,
    })
  })
  // Links the panel opens belong in regular tabs.
  wc.setWindowOpenHandler((details) => {
    const win = BrowserWindow.fromId(entry.windowId)
    if (win && !win.isDestroyed()) win.webContents.send('open-url-as-tab', details.url)
    return { action: 'deny' }
  })
  // Right-click → Inspect and Ctrl/Cmd+Shift+I, as for extension popups.
  wc.on('context-menu', (_e, params) => {
    const win = BrowserWindow.fromId(entry.windowId)
    Menu.buildFromTemplate([
      {
        label: 'Inspect',
        click: () => {
          wc.openDevTools({ mode: 'detach' })
          wc.inspectElement(params.x, params.y)
        },
      },
    ]).popup(win && !win.isDestroyed() ? { window: win } : {})
  })
  wc.on('before-input-event', (_e, input) => {
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (mod && input.shift && input.key.toLowerCase() === 'i') wc.toggleDevTools()
  })
}

function loadEntry(entry: PanelEntry): void {
  const url = panelUrl(entry.extensionId, entry.path)
  entry.view.webContents.loadURL(url).catch((err) => {
    log.warn('sidepanel: loadURL failed', { url, err: String(err) })
  })
}

function findEntry(windowId: number, extensionId: string, chromeTabId: number | null): PanelEntry | undefined {
  for (const e of entries) {
    if (e.windowId === windowId && e.extensionId === extensionId && e.chromeTabId === chromeTabId) return e
  }
  return undefined
}

async function showPanel(
  windowId: number,
  partition: string,
  extensionId: string,
  chromeTabId: number | null,
  path: string,
): Promise<void> {
  const win = BrowserWindow.fromId(windowId)
  if (!win || win.isDestroyed()) throw new Error(`No window with id: ${windowId}.`)
  let entry = findEntry(windowId, extensionId, chromeTabId)
  if (!entry) {
    // The view lives in the window's profile session, next to the tabs
    // it sits beside.
    const viewPartition = pickPartitionForWindow(windowId)
    setupPartitionSession(viewPartition)
    const ses = session.fromPartition(viewPartition)
    if (!(await ensureExtensionInSession(ses, extensionId))) {
      throw new Error(`Extension ${extensionId} is not loaded in this window.`)
    }
    // A concurrent open() may have created it while we awaited.
    entry = findEntry(windowId, extensionId, chromeTabId)
  }
  // One panel per slot (per tab / window-wide): opening another
  // extension's panel there replaces it, as in Chrome.
  for (const e of [...entries]) {
    if (e.windowId === windowId && e.chromeTabId === chromeTabId && e.extensionId !== extensionId) {
      closeEntry(e, 'replaced')
    }
  }
  if (!entry) {
    const viewPartition = pickPartitionForWindow(windowId)
    const view = new WebContentsView({
      webPreferences: {
        partition: viewPartition,
        session: session.fromPartition(viewPartition),
        preload: WEBVIEW_STEALTH_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        // Extension pages must be sandboxed for their shared renderer
        // process to run the service worker's preload (see createTab).
        sandbox: true,
      },
    })
    // Transparent while loading so the column's own background shows.
    view.setBackgroundColor('#00000000')
    entry = { windowId, partition, extensionId, chromeTabId, path, view }
    entries.add(entry)
    hookWindow(windowId, win)
    wireView(entry)
    loadEntry(entry)
    log.info('sidepanel: opened', { extensionId, windowId, chromeTabId, path })
  } else if (entry.path !== path) {
    entry.path = path
    loadEntry(entry)
  }
  refreshWindow(windowId)
  if (visibleByWindow.get(windowId) === entry) {
    try { entry.view.webContents.focus() } catch { /* view torn down */ }
  }
}

async function openPanel(partition: string, extensionId: string, args: Record<string, unknown>): Promise<void> {
  const tabId = numberOrNull(args.tabId)
  let windowId = numberOrNull(args.windowId)
  if (tabId !== null) {
    windowId = getWindowIdForChromeTabId(tabId)
    if (windowId === null) throw new Error(`No tab with id: ${tabId}.`)
  } else if (windowId === null) {
    throw new Error('Either tabId or windowId must be specified.')
  }
  const st = stateFor(partition, extensionId)
  const tabOpts = tabId !== null ? st.tabs.get(tabId) : undefined
  if (tabOpts && tabOpts.enabled !== false) {
    const path = tabOpts.path ?? st.global.path
    if (path) return showPanel(windowId, partition, extensionId, tabId, path)
  }
  if (st.global.enabled !== false && st.global.path) {
    return showPanel(windowId, partition, extensionId, null, st.global.path)
  }
  throw new Error(`No active side panel for ${tabId !== null ? `tabId: ${tabId}` : `windowId: ${windowId}`}`)
}

function closePanel(extensionId: string, args: Record<string, unknown>): void {
  const tabId = numberOrNull(args.tabId)
  let windowId = numberOrNull(args.windowId)
  if (tabId !== null) {
    for (const e of [...entries]) {
      if (e.extensionId === extensionId && e.chromeTabId === tabId) {
        closeEntry(e, 'api')
        return
      }
    }
    windowId = getWindowIdForChromeTabId(tabId)
  }
  if (windowId === null) throw new Error('Either tabId or windowId must be specified.')
  const global = findEntry(windowId, extensionId, null)
  if (global) closeEntry(global, 'api')
}

function setOptions(partition: string, extensionId: string, args: Record<string, unknown>): void {
  const st = stateFor(partition, extensionId)
  const patch: PanelOptions = {}
  if (typeof args.path === 'string') patch.path = args.path
  if (typeof args.enabled === 'boolean') patch.enabled = args.enabled
  const tabId = numberOrNull(args.tabId)
  if (tabId !== null) st.tabs.set(tabId, { ...st.tabs.get(tabId), ...patch })
  else st.global = { ...st.global, ...patch }
  for (const e of [...entries]) {
    if (e.partition !== partition || e.extensionId !== extensionId || e.chromeTabId !== tabId) continue
    if (patch.enabled === false) closeEntry(e, 'disabled')
    else if (patch.path && patch.path !== e.path) {
      e.path = patch.path
      loadEntry(e)
    }
  }
}

function getOptions(partition: string, extensionId: string, args: Record<string, unknown>): PanelOptions & { tabId?: number } {
  const st = stateFor(partition, extensionId)
  const tabId = numberOrNull(args.tabId)
  const tabOpts = tabId !== null ? st.tabs.get(tabId) : undefined
  return {
    path: tabOpts?.path ?? st.global.path,
    enabled: tabOpts?.enabled ?? st.global.enabled ?? true,
    ...(tabId !== null ? { tabId } : {}),
  }
}

async function handleCall(partition: string, extensionId: string, payload: unknown): Promise<unknown> {
  const { op, args } = (payload ?? {}) as { op?: unknown; args?: unknown }
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  if (op !== 'getOptions' && op !== 'getPanelBehavior') {
    log.info('sidepanel: call', { extensionId, op, args: a })
  }
  switch (op) {
    case 'setOptions':
      return setOptions(partition, extensionId, a)
    case 'getOptions':
      return getOptions(partition, extensionId, a)
    case 'setPanelBehavior':
      if (typeof a.openPanelOnActionClick === 'boolean') {
        stateFor(partition, extensionId).openOnActionClick = a.openPanelOnActionClick
      }
      return undefined
    case 'getPanelBehavior':
      return { openPanelOnActionClick: stateFor(partition, extensionId).openOnActionClick }
    case 'open':
      return openPanel(partition, extensionId, a)
    case 'close':
      return closePanel(extensionId, a)
    default:
      throw new Error(`sidePanel.${String(op)} is not supported`)
  }
}

/** chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }). */
export function sidePanelOpensOnActionClick(partition: string, extensionId: string): boolean {
  return extensionState.get(`${partition}\n${extensionId}`)?.openOnActionClick ?? false
}

/** Toolbar click for an extension whose panel opens on action click:
 *  close its visible panel, else open it for the active tab. */
export async function toggleSidePanelForActionClick(
  windowId: number,
  partition: string,
  extensionId: string,
  chromeTabId: number,
): Promise<void> {
  const current = visibleByWindow.get(windowId)
  if (current && current.extensionId === extensionId) {
    closeEntry(current, 'action-toggle')
    return
  }
  await openPanel(partition, extensionId, { tabId: chromeTabId })
}

export function registerSidePanelIpc(): void {
  registerExtensionApiHandler('sidepanel', (caller, payload) =>
    handleCall(caller.partition, caller.extensionId, payload),
  )

  ipcMain.on('sidepanel:bounds', (e, bounds: Rect) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    const rect: Rect = {
      x: Math.round(Number(bounds?.x) || 0),
      y: Math.round(Number(bounds?.y) || 0),
      width: Math.max(0, Math.round(Number(bounds?.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds?.height) || 0)),
    }
    boundsByWindow.set(win.id, rect)
    visibleByWindow.get(win.id)?.view.setBounds(rect)
  })

  ipcMain.handle('sidepanel:close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const current = win ? visibleByWindow.get(win.id) : undefined
    if (current) closeEntry(current, 'user')
  })

  ipcMain.handle('sidepanel:get-state', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return win ? stateForWindow(win.id) : { extensionId: null }
  })

  addTabActivityListener({
    onActiveTabChanged: (windowId) => {
      for (const e of entries) {
        if (e.windowId === windowId) {
          refreshWindow(windowId)
          return
        }
      }
    },
    onTabDestroyed: (chromeTabId) => {
      for (const e of [...entries]) {
        if (e.chromeTabId === chromeTabId) closeEntry(e, 'tab-closed')
      }
      for (const st of extensionState.values()) st.tabs.delete(chromeTabId)
    },
  })
}
