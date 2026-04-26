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

import { BrowserWindow, Menu, WebContentsView, clipboard, ipcMain, session, app } from 'electron'
import type { Session, WebContents } from 'electron'
import { join } from 'path'
import { log } from './log'
import { setupPartitionSession } from './index'
import { ensureExtensionInSession } from './extensions/manager'

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
  // Fires after the page's onload event (later than did-stop-loading and
  // after Electron's own auto-focus of the WebContentsView). Use this — not
  // did-stop-loading — when overriding focus on load completion.
  | { type: 'did-finish-load'; tabId: string; url: string }

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
/** webContents.id -> tabId. Used by the global ipcMain.on handlers to
 *  route preload-sent events (newbro-nav / newbro-open-in-new-tab /
 *  newbro-context-menu) back to the correct tab without leaking per-tab
 *  listeners on a global channel. */
const wcIdToTabId = new Map<number, string>()
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
  wc.on('did-finish-load', () =>
    emit({ type: 'did-finish-load', tabId: rec.tabId, url: wc.getURL() })
  )

  // Route window.open() on the guest to the renderer as a new tab, matching
  // the legacy did-attach-webview behavior.
  wc.setWindowOpenHandler(({ url }) => {
    sendToWindowRenderer(rec.windowId, 'open-url-as-tab', url)
    return { action: 'deny' }
  })

  // Close any open extension popup when the user clicks the page. This is
  // the second listener on input-event (the first lives a few lines up for
  // focus-intent). We only react to the start of a click — fires once per
  // press, even if the user drags. The icon button's own onClick handler
  // takes care of the "click the icon while popup is open" case.
  wc.on('input-event', (_e, input) => {
    if (input.type !== 'mouseDown') return
    if (extensionPopupByWindow.has(rec.windowId)) {
      closeExtensionPopup(rec.windowId)
    }
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
  wcIdToTabId.set(view.webContents.id, opts.tabId)
  wireEvents(rec)

  // Let the owning window install its shortcut interceptor on this tab's
  // webContents so menu accelerators fire even when the page has focus.
  const install = shortcutInstallers.get(opts.windowId)
  if (install) install(view.webContents, win)

  if (opts.active) {
    setActiveTab(opts.windowId, opts.tabId)
    loadIfNeeded(rec, opts.url)
    // Hand OS keyboard focus to the new tab's webContents so the user can
    // start typing into the page right away — this is the "focus site"
    // default. The "focus URL on new tab" override fires later, on the
    // tab's first did-finish-load (see WebviewPanel.tsx).
    try {
      rec.view.webContents.focus()
    } catch {
      /* ignore */
    }
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
  // Determine whether this is a real activation (different tab now active)
  // or a no-op re-activation. WebviewPanel calls tabActivate from an effect
  // that re-runs whenever `profiles` changes — and `profiles` changes any
  // time another window broadcasts state via 'state:updated'. Focusing
  // unconditionally would yank the OS focus to whichever window's effect
  // ran last, even when the user is interacting with a different window.
  const previouslyActive = activeTabByWindow.get(windowId)
  const isNewActivation = previouslyActive !== tabId
  setActiveTab(windowId, tabId)
  const rec = tabs.get(tabId)
  if (!rec) return
  loadIfNeeded(rec, url)
  if (isNewActivation) {
    // Take keyboard focus so typing lands in the page.
    try {
      rec.view.webContents.focus()
    } catch {
      /* ignore */
    }
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
  const wcId = rec.view.webContents.id
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
  wcIdToTabId.delete(wcId)
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

// Extension popups are floating WebContentsViews layered onto the main
// window's contentView (the same surface tabs render into). The earlier
// implementation opened a separate BrowserWindow but Chromium kept blocking
// chrome-extension://<id>/popup.html with ERR_BLOCKED_BY_CLIENT — top-level
// frames in non-extension BrowserWindows don't enjoy the same privileges
// the extension system grants WebContentsViews. Reusing the tab pipeline
// sidesteps that entirely AND gives us a chrome-less floating panel for
// free.
interface ExtensionPopupRecord {
  windowId: number
  extensionId: string
  view: WebContentsView
  /** Anchor rect in window-relative CSS pixels. The renderer sends this so
   *  the popup tracks the icon when the window resizes. Updated on each
   *  toggle call. */
  anchor: { x: number; y: number; width: number; height: number }
  width: number
  height: number
  /** Stored so we can `removeListener` when the popup closes. Without
   *  this, every open/close cycle leaked a window blur listener and
   *  Node started warning at 11 popups (MaxListenersExceededWarning). */
  onBlur: () => void
}

const extensionPopupByWindow = new Map<number, ExtensionPopupRecord>()

const POPUP_DEFAULT_WIDTH = 360
const POPUP_DEFAULT_HEIGHT = 520
/** Padding between window edge and popup so the panel never butts up
 *  against the sash. Matches Chrome's spacing. */
const POPUP_VIEWPORT_MARGIN = 6

function clampPopupBounds(
  ownerWindow: BrowserWindow,
  anchor: { x: number; y: number; width: number; height: number },
  width: number,
  height: number
): TabBounds {
  const [winW, winH] = ownerWindow.getContentSize()
  // Right-align the popup with the anchor (icon's right edge), Chrome-style.
  let x = Math.round(anchor.x + anchor.width - width)
  // Drop directly below the anchor with a small gap.
  let y = Math.round(anchor.y + anchor.height + 2)
  x = Math.max(POPUP_VIEWPORT_MARGIN, Math.min(x, winW - width - POPUP_VIEWPORT_MARGIN))
  y = Math.max(POPUP_VIEWPORT_MARGIN, Math.min(y, winH - height - POPUP_VIEWPORT_MARGIN))
  return { x, y, width, height }
}

function destroyExtensionPopup(rec: ExtensionPopupRecord): void {
  const win = BrowserWindow.fromId(rec.windowId)
  if (win && !win.isDestroyed()) {
    try {
      win.removeListener('blur', rec.onBlur)
    } catch {
      /* ignore */
    }
    try {
      win.contentView.removeChildView(rec.view)
    } catch {
      /* ignore */
    }
  }
  try {
    rec.view.webContents.close()
  } catch {
    try {
      ;(rec.view.webContents as unknown as { destroy?: () => void }).destroy?.()
    } catch {
      /* ignore */
    }
  }
}

export function closeExtensionPopup(windowId: number): boolean {
  const rec = extensionPopupByWindow.get(windowId)
  if (!rec) return false
  extensionPopupByWindow.delete(windowId)
  destroyExtensionPopup(rec)
  sendToWindowRenderer(windowId, 'extension-popup-closed', { extensionId: rec.extensionId })
  return true
}

/** Toggle an extension's popup. If the same extension's popup is already
 *  open, close it. If a different extension's popup is open, close it
 *  and open the new one. Returns 'opened' | 'closed'. Async because we
 *  may need to load the extension into the popup's session on demand. */
export async function toggleExtensionPopup(
  windowId: number,
  extensionId: string,
  popupPath: string,
  anchor: { x: number; y: number; width: number; height: number }
): Promise<'opened' | 'closed'> {
  const existing = extensionPopupByWindow.get(windowId)
  if (existing && existing.extensionId === extensionId) {
    closeExtensionPopup(windowId)
    return 'closed'
  }
  // Different extension already open — replace it.
  if (existing) closeExtensionPopup(windowId)

  const ownerWindow = BrowserWindow.fromId(windowId)
  if (!ownerWindow || ownerWindow.isDestroyed()) return 'closed'

  const partition = pickPartitionForWindow(windowId)
  // The partition session may not have THIS extension loaded — the install
  // loop iterates live BrowserWindows + their child views, but a session
  // can drop an extension between sessions if Electron silently rejects
  // the load (manifest quirk, MV2 webRequest, etc.) or if the partition
  // wasn't live at install time. Force-load on demand: chrome-extension://
  // navigations get ERR_BLOCKED_BY_CLIENT from Chromium when the session
  // doesn't have the destination extension registered.
  setupPartitionSession(partition)
  const ses = session.fromPartition(partition)
  const ok = await ensureExtensionInSession(ses, extensionId)
  if (!ok) {
    log.warn('extension popup: extension is not loadable in this session', {
      partition,
      extensionId,
    })
    return 'closed'
  }

  // Diagnostic: confirm post-load state in case the on-demand load above
  // succeeds but Chromium still bounces. Useful when triaging future
  // ERR_BLOCKED_BY_CLIENT reports.
  try {
    const all = ses.getAllExtensions?.() ?? []
    log.info('extension popup: opening', {
      partition,
      extensionId,
      loadedInSession: all.some((e) => e.id === extensionId),
      sessionExtCount: all.length,
    })
  } catch (err) {
    log.warn('extension popup: getAllExtensions failed', String(err))
  }

  // Match the webPreferences shape of regular tabs as closely as possible.
  // chrome-extension:// loads succeed in tab WebContentsViews, so we copy
  // the same surface — partition + session + stealth preload + sandbox
  // off — to avoid hitting whatever subtle gate diverging settings trip.
  const view = new WebContentsView({
    webPreferences: {
      partition,
      session: ses,
      preload: WEBVIEW_STEALTH_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const width = POPUP_DEFAULT_WIDTH
  const height = POPUP_DEFAULT_HEIGHT
  const bounds = clampPopupBounds(ownerWindow, anchor, width, height)
  view.setBounds(bounds)
  view.setBackgroundColor('#ffffff')
  ownerWindow.contentView.addChildView(view)

  // Tear down on owner-window blur. Listener is stored on the record so
  // closeExtensionPopup can remove it — without this, every open/close
  // cycle leaks a listener and Node hits MaxListenersExceeded after 11.
  const onBlur = (): void => { closeExtensionPopup(windowId) }
  ownerWindow.on('blur', onBlur)

  const rec: ExtensionPopupRecord = {
    windowId,
    extensionId,
    view,
    anchor,
    width,
    height,
    onBlur,
  }
  extensionPopupByWindow.set(windowId, rec)

  const url = `chrome-extension://${extensionId}/${popupPath.replace(/^\//, '')}`
  view.webContents.loadURL(url).catch((err) => {
    log.warn('extension popup: loadURL failed', { url, err: String(err) })
    closeExtensionPopup(windowId)
  })

  // Pull keyboard focus into the popup once the page is rendered so typing
  // (form fields, search boxes inside the popup) routes there without the
  // user needing an extra click. Bail out if the popup was torn down before
  // load completed.
  view.webContents.once('did-finish-load', () => {
    if (!extensionPopupByWindow.has(windowId)) return
    try { view.webContents.focus() } catch { /* ignore */ }
  })

  // Tear down on owner-window destroy. Map cleanup happens here too in
  // case the popup outlived our explicit close (shouldn't, but defensive).
  ownerWindow.once('closed', () => {
    extensionPopupByWindow.delete(windowId)
  })

  // Send opened notification so the renderer can update icon "active" state.
  sendToWindowRenderer(windowId, 'extension-popup-opened', { extensionId })

  return 'opened'
}

/** Reposition the open popup when the renderer reports the icon's anchor
 *  rect has moved (sidebar toggle, window resize). No-op if no popup is
 *  open or the extensionId doesn't match. */
export function moveExtensionPopup(
  windowId: number,
  extensionId: string,
  anchor: { x: number; y: number; width: number; height: number }
): void {
  const rec = extensionPopupByWindow.get(windowId)
  if (!rec || rec.extensionId !== extensionId) return
  const ownerWindow = BrowserWindow.fromId(windowId)
  if (!ownerWindow || ownerWindow.isDestroyed()) return
  rec.anchor = anchor
  rec.view.setBounds(clampPopupBounds(ownerWindow, anchor, rec.width, rec.height))
}

export function getOpenExtensionPopupId(windowId: number): string | null {
  return extensionPopupByWindow.get(windowId)?.extensionId ?? null
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

/** Listeners installed ONCE at app start for events relayed from tab
 *  preloads (webview-stealth.ts): mouse side-button navigation, middle-
 *  click-to-new-tab, and right-click context menu. Each channel is
 *  dispatched only for senders we recognise as tabs via wcIdToTabId; a
 *  message from the main renderer itself is ignored. */
let tabPreloadListenersInstalled = false

export function installTabPreloadListeners(): void {
  if (tabPreloadListenersInstalled) return
  tabPreloadListenersInstalled = true

  ipcMain.on('newbro-nav', (event, direction: unknown) => {
    const tabId = wcIdToTabId.get(event.sender.id)
    if (!tabId) return
    if (direction === 'back') tabGoBack(tabId)
    else if (direction === 'forward') tabGoForward(tabId)
  })

  ipcMain.on('newbro-open-in-new-tab', (event, url: unknown) => {
    const tabId = wcIdToTabId.get(event.sender.id)
    if (!tabId) return
    if (typeof url !== 'string' || !url) return
    const rec = tabs.get(tabId)
    if (!rec) return
    sendToWindowRenderer(rec.windowId, 'open-url-as-tab', url)
  })

  ipcMain.on('newbro-context-menu', async (event, payload: unknown) => {
    const tabId = wcIdToTabId.get(event.sender.id)
    if (!tabId) return
    const rec = tabs.get(tabId)
    if (!rec) return
    const win = BrowserWindow.fromId(rec.windowId)
    if (!win || win.isDestroyed()) return
    const selection =
      typeof payload === 'object' && payload !== null && typeof (payload as { selection?: unknown }).selection === 'string'
        ? (payload as { selection: string }).selection.trim()
        : ''
    if (!selection) return

    // Show a native menu anchored to the owner window. The renderer then
    // decides whether to copy or copy-and-search — we delegate the search
    // URL construction to the renderer so the user's configured search
    // engine is respected without main needing to know about settings.
    const chosen = await new Promise<'copy' | 'copy-and-search' | null>((resolve) => {
      const menu = Menu.buildFromTemplate([
        { label: 'Copy', click: () => resolve('copy') },
        { label: 'Copy and search', click: () => resolve('copy-and-search') },
      ])
      menu.popup({ window: win, callback: () => resolve(null) })
    })
    if (!chosen) return

    try {
      clipboard.writeText(selection)
    } catch (err) {
      log.warn('context-menu: clipboard write failed', String(err))
    }
    if (chosen === 'copy-and-search') {
      // Hand the renderer the raw query; the renderer already knows how
      // to normalise → search URL and open a new tab (mirrors the flow
      // the pre-merge <webview> path used).
      win.webContents.send('tab-context-search', selection)
    }
  })
}

// Silence unused-app warning on some bundlers — `app` is used indirectly
// via session.fromPartition / BrowserWindow.fromId, both of which need
// the app to be ready; leaving the import ensures the main module order
// is preserved.
void app
