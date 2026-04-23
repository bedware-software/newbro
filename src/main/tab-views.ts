// TabViewManager — main-process tab hosting using WebContentsView.
//
// Each tab is a `WebContentsView` attached as a child of the workspace
// window's root content view. The renderer UI (Toolbar, Sidebar,
// WebviewPanel container) continues to paint into the BrowserWindow's
// main webContents; tab WebContentsViews are layered *on top of* the
// WebviewPanel's DOM rectangle, whose bounds the renderer reports via
// IPC (mount, resize, sidebar toggle).
//
// Why this layer exists: <webview> tags work fine, but Electron extensions
// (session.loadExtension) do not inject into <webview> — only into
// BrowserWindow / WebContentsView. Rehosting tabs here is the minimum
// architectural change that lets Chrome extensions actually run against
// real page content while keeping per-profile partition isolation.
//
// Event model: WebContents events fire in main; we forward a compact
// typed payload to the owning window's renderer over the 'tab-event'
// channel. The renderer's electronAPI.onTabEvent listener turns those
// back into store updates and error-banner state.

import { BrowserWindow, WebContentsView, session, app } from 'electron'
import type { Session, WebContents } from 'electron'
import { join } from 'path'
import { log } from './log'
import { setupPartitionSession } from './index'

export interface TabBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Compact event payload shipped to the renderer. Matches
 *  the event names the old <webview> code listened for so the
 *  renderer diff stays small. */
export type TabEvent =
  | { type: 'did-start-loading'; tabId: string }
  | { type: 'did-stop-loading'; tabId: string; url: string }
  | { type: 'did-navigate'; tabId: string; url: string }
  | { type: 'did-navigate-in-page'; tabId: string; url: string; isMainFrame: boolean }
  | { type: 'page-title-updated'; tabId: string; title: string }
  | { type: 'page-favicon-updated'; tabId: string; favicons: string[] }
  | {
      type: 'did-fail-load'
      tabId: string
      url: string
      errorCode: number
      errorDescription: string
      isMainFrame: boolean
    }
  | { type: 'dom-ready'; tabId: string; url: string }

interface TabRecord {
  tabId: string
  windowId: number
  partition: string
  view: WebContentsView
  activated: boolean
  /** The last bounds assigned by the renderer. Cached so we can
   *  restore them when re-activating after hide (width=0 trick). */
  lastBounds: TabBounds
}

const WEBVIEW_STEALTH_PRELOAD = join(__dirname, '../preload/webview-stealth.js')

const HIDDEN_BOUNDS: TabBounds = { x: 0, y: 0, width: 0, height: 0 }

const tabs = new Map<string, TabRecord>()
/** windowId -> latest bounds reported by the renderer, applied to the
 *  active tab when it is shown. */
const windowBounds = new Map<number, TabBounds>()
/** windowId -> active tabId. Inactive tabs get HIDDEN_BOUNDS. */
const activeTabByWindow = new Map<number, string>()
/** Per-window hook: given a tab's WebContents, install keyboard shortcut
 *  interception so Ctrl+T / Ctrl+Tab / etc. fire from page focus. The
 *  window's creator in main/index.ts registers the callback so the
 *  accelerator table stays in one place. */
type ShortcutInstaller = (wc: WebContents, targetWindow: BrowserWindow) => void
const shortcutInstallers = new Map<number, ShortcutInstaller>()

function sendToWindowRenderer(windowId: number, channel: string, payload: unknown): void {
  const win = BrowserWindow.fromId(windowId)
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function wireEvents(rec: TabRecord): void {
  const wc: WebContents = rec.view.webContents
  const emit = (evt: TabEvent): void => sendToWindowRenderer(rec.windowId, 'tab-event', evt)

  wc.on('did-start-loading', () => emit({ type: 'did-start-loading', tabId: rec.tabId }))
  wc.on('did-stop-loading', () =>
    emit({ type: 'did-stop-loading', tabId: rec.tabId, url: wc.getURL() })
  )
  wc.on('did-navigate', (_e, url) => emit({ type: 'did-navigate', tabId: rec.tabId, url }))
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) =>
    emit({ type: 'did-navigate-in-page', tabId: rec.tabId, url, isMainFrame })
  )
  wc.on('page-title-updated', (_e, title) =>
    emit({ type: 'page-title-updated', tabId: rec.tabId, title })
  )
  wc.on('page-favicon-updated', (_e, favicons) =>
    emit({ type: 'page-favicon-updated', tabId: rec.tabId, favicons })
  )
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) =>
    emit({
      type: 'did-fail-load',
      tabId: rec.tabId,
      url: validatedURL,
      errorCode,
      errorDescription,
      isMainFrame,
    })
  )
  // Cert handling is owned by the app-level `certificate-error` listener
  // in main/index.ts, which consults bypassedCertOrigins. The renderer's
  // CertWarningOverlay is triggered by did-fail-load with an ERR_CERT_*
  // code, which is already covered by the did-fail-load handler above.
  wc.on('dom-ready', () => emit({ type: 'dom-ready', tabId: rec.tabId, url: wc.getURL() }))

  // Route window.open() on the guest to the renderer as a new tab, matching
  // the legacy did-attach-webview behavior.
  wc.setWindowOpenHandler(({ url }) => {
    sendToWindowRenderer(rec.windowId, 'open-url-as-tab', url)
    return { action: 'deny' }
  })
}

export function setWindowBounds(windowId: number, bounds: TabBounds): void {
  windowBounds.set(windowId, bounds)
  const activeTabId = activeTabByWindow.get(windowId)
  if (!activeTabId) return
  const rec = tabs.get(activeTabId)
  if (!rec) return
  rec.lastBounds = bounds
  rec.view.setBounds(bounds)
}

export function createTab(opts: {
  windowId: number
  tabId: string
  partition: string
  url: string
  active: boolean
}): void {
  if (tabs.has(opts.tabId)) return
  const win = BrowserWindow.fromId(opts.windowId)
  if (!win || win.isDestroyed()) {
    log.warn('tab-views: createTab with no live window', opts)
    return
  }

  // Make sure the partition session is configured (UA, proxy, stealth
  // preload, cert bypass, extensions) before we attach the view.
  setupPartitionSession(opts.partition)

  const ses: Session = session.fromPartition(opts.partition)
  const view = new WebContentsView({
    webPreferences: {
      partition: opts.partition,
      session: ses,
      preload: WEBVIEW_STEALTH_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // Start with zero bounds — the renderer will call setBounds once the
  // WebviewPanel div has been measured. If this tab is inactive we stay
  // hidden; if active and we already have bounds for the window, apply
  // them on activation below.
  view.setBounds(HIDDEN_BOUNDS)
  view.setBackgroundColor('#00000000')
  win.contentView.addChildView(view)

  const rec: TabRecord = {
    tabId: opts.tabId,
    windowId: opts.windowId,
    partition: opts.partition,
    view,
    activated: false,
    lastBounds: HIDDEN_BOUNDS,
  }
  tabs.set(opts.tabId, rec)
  wireEvents(rec)

  // Let the owning window install its shortcut interceptor on this tab's
  // webContents so menu accelerators fire even when the page has focus.
  const install = shortcutInstallers.get(opts.windowId)
  if (install) install(view.webContents, win)

  if (opts.active) {
    setActiveTab(opts.windowId, opts.tabId)
    loadIfNeeded(rec, opts.url)
  } else {
    // Keep lazy: inactive tabs stay at about:blank until first activation.
    // We don't even call loadURL so the guest webContents is effectively
    // idle — matches the old <webview> lazy-load behavior.
  }
}

function loadIfNeeded(rec: TabRecord, url: string): void {
  if (rec.activated) return
  rec.activated = true
  if (!url || url === 'about:blank') return
  rec.view.webContents.loadURL(url).catch((err) => {
    log.warn('tab-views: loadURL failed', { tabId: rec.tabId, url, err: String(err) })
  })
}

export function activateTab(windowId: number, tabId: string, url: string): void {
  setActiveTab(windowId, tabId)
  const rec = tabs.get(tabId)
  if (!rec) return
  loadIfNeeded(rec, url)
  // Take keyboard focus so typing lands in the page.
  try {
    rec.view.webContents.focus()
  } catch {
    /* ignore */
  }
}

function setActiveTab(windowId: number, tabId: string): void {
  const prev = activeTabByWindow.get(windowId)
  if (prev && prev !== tabId) {
    const prevRec = tabs.get(prev)
    if (prevRec) {
      prevRec.lastBounds = HIDDEN_BOUNDS
      prevRec.view.setBounds(HIDDEN_BOUNDS)
    }
  }
  activeTabByWindow.set(windowId, tabId)
  const rec = tabs.get(tabId)
  if (!rec) return
  const wb = windowBounds.get(windowId)
  if (wb) {
    rec.lastBounds = wb
    rec.view.setBounds(wb)
  }
}

export function destroyTab(tabId: string): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  const win = BrowserWindow.fromId(rec.windowId)
  if (win && !win.isDestroyed()) {
    try {
      win.contentView.removeChildView(rec.view)
    } catch {
      /* ignore */
    }
  }
  try {
    // webContents.close() is the clean shutdown path in Electron 34+.
    // It unloads the page, runs beforeunload, and frees the renderer.
    rec.view.webContents.close()
  } catch {
    try {
      ;(rec.view.webContents as unknown as { destroy?: () => void }).destroy?.()
    } catch {
      /* ignore */
    }
  }
  tabs.delete(tabId)
  if (activeTabByWindow.get(rec.windowId) === tabId) {
    activeTabByWindow.delete(rec.windowId)
  }
}

export function destroyAllTabsForWindow(windowId: number): void {
  for (const [id, rec] of tabs) {
    if (rec.windowId === windowId) destroyTab(id)
  }
  windowBounds.delete(windowId)
  activeTabByWindow.delete(windowId)
}

export function tabNavigate(tabId: string, url: string): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  rec.activated = true
  rec.view.webContents.loadURL(url).catch((err) => {
    log.warn('tab-views: navigate failed', { tabId, url, err: String(err) })
  })
}

export function tabGoBack(tabId: string): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  const nav = rec.view.webContents.navigationHistory
  if (nav.canGoBack()) nav.goBack()
}

export function tabGoForward(tabId: string): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  const nav = rec.view.webContents.navigationHistory
  if (nav.canGoForward()) nav.goForward()
}

export function tabReload(tabId: string, ignoreCache: boolean): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  if (ignoreCache) rec.view.webContents.reloadIgnoringCache()
  else rec.view.webContents.reload()
}

export function tabStop(tabId: string): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  rec.view.webContents.stop()
}

export function tabGetState(
  tabId: string
): { isLoading: boolean; url: string; canGoBack: boolean; canGoForward: boolean } | null {
  const rec = tabs.get(tabId)
  if (!rec) return null
  const wc = rec.view.webContents
  const nav = wc.navigationHistory
  return {
    isLoading: wc.isLoading(),
    url: wc.getURL(),
    canGoBack: nav.canGoBack(),
    canGoForward: nav.canGoForward(),
  }
}

export function tabExecuteJS(tabId: string, code: string): Promise<unknown> {
  const rec = tabs.get(tabId)
  if (!rec) return Promise.resolve(null)
  return rec.view.webContents.executeJavaScript(code, false).catch(() => null)
}

export function openExtensionPopup(
  windowId: number,
  extensionId: string,
  popupPath: string
): void {
  const ownerWindow = BrowserWindow.fromId(windowId)
  if (!ownerWindow || ownerWindow.isDestroyed()) return
  const popup = new BrowserWindow({
    width: 360,
    height: 520,
    parent: ownerWindow,
    modal: false,
    frame: true,
    resizable: true,
    title: 'Extension',
    useContentSize: true,
    webPreferences: {
      // Popup must run inside a session that has the extension registered.
      // We pick the active tab's partition so the extension sees the same
      // storage/cookies as the page it's acting on.
      partition: pickPartitionForWindow(windowId),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  const url = `chrome-extension://${extensionId}/${popupPath.replace(/^\//, '')}`
  popup.loadURL(url).catch((err) => {
    log.warn('extension popup: loadURL failed', { url, err: String(err) })
  })
}

function pickPartitionForWindow(windowId: number): string {
  const activeTabId = activeTabByWindow.get(windowId)
  if (activeTabId) {
    const rec = tabs.get(activeTabId)
    if (rec) return rec.partition
  }
  // Fallback: the first tab's partition (there is always at least one
  // profile partition configured in practice).
  const first = tabs.values().next().value as TabRecord | undefined
  return first?.partition ?? 'persist:default'
}

export function getPartitionForTab(tabId: string): string | null {
  return tabs.get(tabId)?.partition ?? null
}

export function __internal_getTabRecord(tabId: string): TabRecord | undefined {
  return tabs.get(tabId)
}

// Ensure app-wide cleanup so no stray child windows linger when a tab's
// owner window is destroyed. The BrowserWindow `closed` event is a
// reliable teardown point.
export function attachWindowLifecycle(win: BrowserWindow): void {
  const id = win.id
  win.once('closed', () => {
    destroyAllTabsForWindow(id)
    shortcutInstallers.delete(id)
  })
}

/** Register a workspace window with the TabViewManager. Stores the
 *  shortcut-installer callback used when a new tab is created, and sets
 *  up the cleanup hook. Called once per window from
 *  main/index.ts createWorkspaceWindow. */
export function registerWorkspaceWindowForTabs(
  win: BrowserWindow,
  installShortcuts: ShortcutInstaller,
): void {
  shortcutInstallers.set(win.id, installShortcuts)
  attachWindowLifecycle(win)
}

// Silence unused-app warning on some bundlers — `app` is used indirectly
// via session.fromPartition / BrowserWindow.fromId, both of which need
// the app to be ready; leaving the import ensures the main module order
// is preserved.
void app
