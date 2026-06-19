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

import { BrowserWindow, Menu, WebContentsView, clipboard, dialog, ipcMain, screen, session, app } from 'electron'
import type { Session, WebContents } from 'electron'
import { join } from 'path'
import { log } from './log'
import { addVisit as addHistoryVisit, updateTitle as updateHistoryTitle } from './history'
import { setupPartitionSession, shouldDropExtConsoleMessage } from './index'
import { ensureExtensionInSession } from './extensions/manager'
import { injectMatchingUserScripts } from './extensions/userscripts'
import { getExtensionsFor, suppressLibrarySelectTab } from './chrome-extensions-bridge'

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
  // findInPage result. `finalUpdate` is the canonical "this is the last
  // packet for this request" marker — intermediate updates may have stale
  // ordinals while Chromium walks the page.
  | {
      type: 'found-in-page'
      tabId: string
      requestId: number
      activeMatchOrdinal: number
      matches: number
      finalUpdate: boolean
    }
  // Page HTML fullscreen (video playback). The fullscreen element fills
  // only the tab's view rect, so the window chrome stays on screen — the
  // renderer reacts by hiding the sidebar and painting the toolbar pure
  // black ("cinema mode") until the page leaves fullscreen.
  | { type: 'enter-html-full-screen'; tabId: string }
  | { type: 'leave-html-full-screen'; tabId: string }

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

// Tab views are normally transparent so the renderer shows through during
// load. While a page is in HTML fullscreen we paint the view black as a
// belt-and-suspenders backdrop behind the edge-to-edge video.
const TAB_BG_TRANSPARENT = '#00000000'
const TAB_BG_FULLSCREEN = '#000000'
const DEFAULT_WINDOW_BG = '#161616'
const PAGE_FULLSCREEN_TOOLBAR_HEIGHT = 48
const PAGE_FULLSCREEN_WINDOWS_OVERSCAN = 8

/** Parse the comma-separated `features` string from window.open into the
 *  numeric subset BrowserWindow understands. Anything unrecognized is
 *  ignored — we only consume width/height/left/top so OAuth popups land
 *  near the dimensions the calling page asked for. */
function parsePopupFeatures(features: string): {
  width?: number
  height?: number
  left?: number
  top?: number
} {
  const out: { width?: number; height?: number; left?: number; top?: number } = {}
  if (!features) return out
  for (const part of features.split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const raw = part.slice(eq + 1).trim()
    const num = parseInt(raw, 10)
    if (!Number.isFinite(num)) continue
    if (key === 'width' || key === 'innerwidth') out.width = num
    else if (key === 'height' || key === 'innerheight') out.height = num
    else if (key === 'left' || key === 'screenx') out.left = num
    else if (key === 'top' || key === 'screeny') out.top = num
  }
  return out
}

// Minimum size for OAuth-style popups. Providers (Figma, Google, GitHub) ask
// for window dimensions tuned to a stripped-down browser frame; in our app
// the popup BrowserWindow has the OS title bar plus app chrome on Windows
// and a default frame on macOS, so the requested width leaves the actual
// content frame too narrow — text wraps awkwardly, the "Continue" button
// gets pushed off-screen on Windows. Clamp up to a comfortable floor.
const POPUP_MIN_WIDTH = 560
const POPUP_MIN_HEIGHT = 640

const tabs = new Map<string, TabRecord>()
/** windowId -> latest bounds reported by the renderer, applied to the
 *  active tab when it is shown. */
const windowBounds = new Map<number, TabBounds>()
/** windowId -> active tabId. Inactive tabs get HIDDEN_BOUNDS. */
const activeTabByWindow = new Map<number, string>()
/** windowId -> tabId whose page is currently in HTML fullscreen (video
 *  playback / "cinema mode"). Tracked so the window/view base colour is
 *  painted black for the duration and so the view can be forced to fill the
 *  whole window under the toolbar. */
const htmlFullscreenByWindow = new Map<number, string>()
interface PageFullscreenWindowState {
  bounds: Electron.Rectangle
  maximized: boolean
  fullscreen: boolean
  kiosk: boolean
  resizable: boolean
  alwaysOnTop: boolean
  hasShadow: boolean
}

/** windowId -> window state before page cinema mode. Windows uses kiosk mode
 *  to hide taskbar/caption affordances without showing a stretched decorated
 *  window; macOS uses native fullscreen for Dock/menu bar/Spaces behavior. */
const windowStateBeforePage = new Map<number, PageFullscreenWindowState>()
const normalWindowStateByWindow = new Map<number, PageFullscreenWindowState>()
const fullscreenWindowTimers = new Map<number, ReturnType<typeof setTimeout>[]>()
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

function getFullscreenTabBounds(windowId: number): TabBounds | null {
  const win = BrowserWindow.fromId(windowId)
  if (!win || win.isDestroyed()) return null
  // Keep the app toolbar visible and give the page the rest of the display.
  // The BrowserWindow itself may overscan right/bottom on Windows to cover
  // native white edges, but the WebContentsView must stay at the VISIBLE
  // display size. Otherwise the page gets a viewport larger than the screen
  // and sites lay controls/content into pixels the user cannot see.
  const [contentWidth, contentHeight] = win.getContentSize()
  const disp = screen.getDisplayMatching(win.getBounds())
  const width = process.platform === 'win32'
    ? disp.bounds.width
    : contentWidth
  const height = process.platform === 'win32'
    ? disp.bounds.height - PAGE_FULLSCREEN_TOOLBAR_HEIGHT
    : contentHeight - PAGE_FULLSCREEN_TOOLBAR_HEIGHT
  return {
    x: 0,
    y: PAGE_FULLSCREEN_TOOLBAR_HEIGHT,
    width: Math.max(0, width),
    height: Math.max(0, height),
  }
}

function applyCurrentBounds(rec: TabRecord): void {
  const fullscreenTabId = htmlFullscreenByWindow.get(rec.windowId)
  const bounds = fullscreenTabId === rec.tabId
    ? getFullscreenTabBounds(rec.windowId) ?? rec.lastBounds
    : rec.lastBounds
  rec.view.setBounds(bounds)
}

function syncFullscreenBounds(windowId: number): void {
  const tabId = htmlFullscreenByWindow.get(windowId)
  if (!tabId) return
  const rec = tabs.get(tabId)
  if (!rec) return
  applyCurrentBounds(rec)
}

function getRestorableWindowBounds(win: BrowserWindow): Electron.Rectangle {
  try {
    if (win.isMaximized()) return win.getNormalBounds()
  } catch { /* ignore */ }
  return win.getBounds()
}

function readPageFullscreenWindowState(win: BrowserWindow): PageFullscreenWindowState {
  return {
    bounds: getRestorableWindowBounds(win),
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    kiosk: win.isKiosk(),
    resizable: win.isResizable(),
    alwaysOnTop: win.isAlwaysOnTop(),
    hasShadow: win.hasShadow(),
  }
}

function isOverscannedWindowState(state: PageFullscreenWindowState): boolean {
  const display = screen.getDisplayMatching(state.bounds)
  const slop = 2
  const right = state.bounds.x + state.bounds.width
  const bottom = state.bounds.y + state.bounds.height
  const displayRight = display.bounds.x + display.bounds.width
  const displayBottom = display.bounds.y + display.bounds.height
  return (
    state.bounds.x < display.bounds.x - slop ||
    state.bounds.y < display.bounds.y - slop ||
    right > displayRight + slop ||
    bottom > displayBottom + slop ||
    state.bounds.width > display.bounds.width + slop ||
    state.bounds.height > display.bounds.height + slop ||
    (!state.fullscreen && !state.kiosk && state.bounds.height > display.workArea.height + PAGE_FULLSCREEN_WINDOWS_OVERSCAN + slop)
  )
}

function isNormalWindowState(state: PageFullscreenWindowState): boolean {
  return !state.fullscreen && !state.kiosk && !isOverscannedWindowState(state)
}

function rememberNormalWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const state = readPageFullscreenWindowState(win)
  if (isNormalWindowState(state)) normalWindowStateByWindow.set(win.id, state)
}

function getPageFullscreenEntryState(win: BrowserWindow): PageFullscreenWindowState {
  const state = readPageFullscreenWindowState(win)
  if (isNormalWindowState(state)) {
    normalWindowStateByWindow.set(win.id, state)
    return state
  }
  return normalWindowStateByWindow.get(win.id) ?? state
}

function clearFullscreenWindowTimers(windowId: number): void {
  const timers = fullscreenWindowTimers.get(windowId)
  if (!timers) return
  for (const timer of timers) clearTimeout(timer)
  fullscreenWindowTimers.delete(windowId)
}

function scheduleFullscreenWindowTimer(windowId: number, fn: () => void, ms: number): void {
  const timer = setTimeout(() => {
    const timers = fullscreenWindowTimers.get(windowId)
    if (timers) fullscreenWindowTimers.set(windowId, timers.filter((entry) => entry !== timer))
    fn()
  }, ms)
  fullscreenWindowTimers.set(windowId, [...(fullscreenWindowTimers.get(windowId) ?? []), timer])
}

function getTabViewBounds(rec: TabRecord): TabBounds | null {
  try {
    const view = rec.view as unknown as { getBounds?: () => TabBounds }
    return view.getBounds?.() ?? null
  } catch {
    return null
  }
}

function getFullscreenGeometry(win: BrowserWindow | null, rec: TabRecord): Record<string, unknown> {
  if (!win || win.isDestroyed()) return { tabBounds: getTabViewBounds(rec) }
  const display = screen.getDisplayMatching(win.getBounds())
  const [contentWidth, contentHeight] = win.getContentSize()
  return {
    windowBounds: win.getBounds(),
    contentSize: { width: contentWidth, height: contentHeight },
    displayBounds: display.bounds,
    workArea: display.workArea,
    isFullScreen: win.isFullScreen(),
    isKiosk: win.isKiosk(),
    isAlwaysOnTop: win.isAlwaysOnTop(),
    tabBounds: getTabViewBounds(rec),
  }
}

function enterPageFullscreenWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || windowStateBeforePage.has(win.id)) return
  clearFullscreenWindowTimers(win.id)
  const state = getPageFullscreenEntryState(win)
  windowStateBeforePage.set(win.id, state)

  if (process.platform === 'darwin') {
    try { win.setFullScreen(true) } catch { /* ignore */ }
    return
  }

  if (process.platform === 'win32') {
    const displayBounds = screen.getDisplayMatching(getRestorableWindowBounds(win)).bounds
    const coverDisplay = (): void => {
      if (win.isDestroyed()) return
      const bounds = {
        x: displayBounds.x,
        y: displayBounds.y,
        width: displayBounds.width + PAGE_FULLSCREEN_WINDOWS_OVERSCAN,
        height: displayBounds.height + PAGE_FULLSCREEN_WINDOWS_OVERSCAN,
      }
      try { win.setBackgroundColor(TAB_BG_FULLSCREEN) } catch { /* ignore */ }
      try { win.setHasShadow(false) } catch { /* ignore */ }
      try { win.setResizable(false) } catch { /* ignore */ }
      try { if (!win.isKiosk()) win.setKiosk(true) } catch { /* ignore */ }
      try { if (!win.isFullScreen()) win.setFullScreen(true) } catch { /* ignore */ }
      try { win.setBounds(bounds, false) } catch { /* ignore */ }
      try { win.setAlwaysOnTop(true, 'screen-saver') } catch { /* ignore */ }
      try { win.moveTop() } catch { /* ignore */ }
      syncFullscreenBounds(win.id)
    }
    coverDisplay()
    // Re-assert while Windows finishes the fullscreen/kiosk transition; this
    // catches the taskbar and the 1-8px compositor edge at fractional scale.
    scheduleFullscreenWindowTimer(win.id, coverDisplay, 40)
    scheduleFullscreenWindowTimer(win.id, coverDisplay, 120)
    scheduleFullscreenWindowTimer(win.id, coverDisplay, 320)
    scheduleFullscreenWindowTimer(win.id, coverDisplay, 900)
  } else {
    try { win.setResizable(false) } catch { /* ignore */ }
    try { win.setFullScreen(true) } catch { /* ignore */ }
  }
}

function leavePageFullscreenWindow(windowId: number): void {
  clearFullscreenWindowTimers(windowId)
  const state = windowStateBeforePage.get(windowId)
  windowStateBeforePage.delete(windowId)
  if (!state) return

  const win = BrowserWindow.fromId(windowId)
  if (!win || win.isDestroyed()) return

  if (process.platform === 'darwin') {
    if (!state.fullscreen && win.isFullScreen()) {
      try { win.setFullScreen(false) } catch { /* ignore */ }
    }
    return
  }

  const restoreNormalWindow = (): void => {
    if (win.isDestroyed()) return
    try { win.setAlwaysOnTop(state.alwaysOnTop) } catch { /* ignore */ }
    try { win.setHasShadow(state.hasShadow) } catch { /* ignore */ }
    try { win.setResizable(state.resizable) } catch { /* ignore */ }
    if (!state.fullscreen && !state.kiosk) {
      try { win.setBounds(state.bounds, false) } catch { /* ignore */ }
      if (state.maximized) {
        try { win.maximize() } catch { /* ignore */ }
      }
      rememberNormalWindowState(win)
    }
    try { win.setBackgroundColor(DEFAULT_WINDOW_BG) } catch { /* ignore */ }
  }

  const logRestoredWindowGeometry = (): void => {
    if (win.isDestroyed()) return
    const display = screen.getDisplayMatching(win.getBounds())
    const [contentWidth, contentHeight] = win.getContentSize()
    log.info('tab fullscreen restore geometry', {
      windowId,
      saved: {
        bounds: state.bounds,
        maximized: state.maximized,
        fullscreen: state.fullscreen,
        kiosk: state.kiosk,
      },
      current: {
        bounds: win.getBounds(),
        contentSize: { width: contentWidth, height: contentHeight },
        maximized: win.isMaximized(),
        fullscreen: win.isFullScreen(),
        kiosk: win.isKiosk(),
        alwaysOnTop: win.isAlwaysOnTop(),
      },
      displayBounds: display.bounds,
      workArea: display.workArea,
    })
  }

  if (process.platform === 'win32') {
    try {
      if (win.isKiosk() !== state.kiosk) win.setKiosk(state.kiosk)
    } catch { /* ignore */ }
  }
  try {
    if (state.fullscreen) {
      if (!win.isFullScreen()) win.setFullScreen(true)
    } else if (win.isFullScreen()) {
      win.setFullScreen(false)
    }
  } catch { /* ignore */ }

  if (process.platform === 'win32') {
    restoreNormalWindow()
    // Kiosk/fullscreen transitions on Windows are asynchronous. Re-apply the
    // saved normal geometry after the shell has released the window; otherwise
    // Electron may keep the overscanned fullscreen bounds as the restored size.
    scheduleFullscreenWindowTimer(windowId, restoreNormalWindow, 80)
    scheduleFullscreenWindowTimer(windowId, restoreNormalWindow, 220)
    scheduleFullscreenWindowTimer(windowId, restoreNormalWindow, 520)
    scheduleFullscreenWindowTimer(windowId, logRestoredWindowGeometry, 620)
  } else {
    restoreNormalWindow()
  }
}

function enterPageFullscreen(rec: TabRecord, source: string, pageMetrics?: unknown): void {
  if (activeTabByWindow.get(rec.windowId) !== rec.tabId) return
  const existing = htmlFullscreenByWindow.get(rec.windowId)
  if (existing === rec.tabId) {
    applyCurrentBounds(rec)
    return
  }
  if (existing) {
    const prev = tabs.get(existing)
    if (prev) leavePageFullscreen(prev, `${source}-replace`)
    else htmlFullscreenByWindow.delete(rec.windowId)
  }
  log.info('tab enter-html-full-screen', { tabId: rec.tabId, source })
  htmlFullscreenByWindow.set(rec.windowId, rec.tabId)
  const win = BrowserWindow.fromId(rec.windowId)
  if (win && !win.isDestroyed()) enterPageFullscreenWindow(win)
  applyCurrentBounds(rec)
  try { rec.view.setBackgroundColor(TAB_BG_FULLSCREEN) } catch { /* ignore */ }
  try { win?.setBackgroundColor(TAB_BG_FULLSCREEN) } catch { /* ignore */ }
  log.info('tab fullscreen geometry', {
    tabId: rec.tabId,
    source,
    host: (() => { try { return new URL(rec.view.webContents.getURL()).host } catch { return '' } })(),
    native: getFullscreenGeometry(win ?? null, rec),
    page: pageMetrics ?? null,
  })
  const evt: TabEvent = { type: 'enter-html-full-screen', tabId: rec.tabId }
  sendToWindowRenderer(rec.windowId, 'tab-event', evt)
}

function leavePageFullscreen(rec: TabRecord, source: string): void {
  if (htmlFullscreenByWindow.get(rec.windowId) !== rec.tabId) return
  log.info('tab leave-html-full-screen', { tabId: rec.tabId, source })
  htmlFullscreenByWindow.delete(rec.windowId)
  const win = BrowserWindow.fromId(rec.windowId)
  try { rec.view.setBackgroundColor(TAB_BG_TRANSPARENT) } catch { /* ignore */ }
  applyCurrentBounds(rec)
  try { win?.setBackgroundColor(DEFAULT_WINDOW_BG) } catch { /* ignore */ }
  leavePageFullscreenWindow(rec.windowId)
  const evt: TabEvent = { type: 'leave-html-full-screen', tabId: rec.tabId }
  sendToWindowRenderer(rec.windowId, 'tab-event', evt)
}

function wireEvents(rec: TabRecord): void {
  const wc: WebContents = rec.view.webContents
  const emit = (evt: TabEvent): void => sendToWindowRenderer(rec.windowId, 'tab-event', evt)

  // Diagnostic: log tab renderer crashes / hangs. Sites with heavy WebGL or
  // WASM (Figma in particular) have been observed to silently die under
  // memory pressure — without this listener the only signal would be the
  // tab's WebContentsView vanishing from the window.
  wc.on('render-process-gone', (_e, details) => {
    log.error('tab render-process-gone', {
      tabId: rec.tabId,
      windowId: rec.windowId,
      url: (() => { try { return wc.getURL() } catch { return '' } })(),
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })

  // Diagnostic: track every "the page wants to close itself" signal. The
  // reported case is Figma's Google-SSO callback page (`/finish_google_sso`)
  // appearing to close the entire workspace window instead of just dropping
  // the tab. We don't know yet whether Electron is propagating window.close()
  // from a child WebContentsView up to the parent BrowserWindow or whether
  // some other code path is involved — these logs let us tell.
  // WebContents emits 'close' at runtime (this log line fires regularly)
  // but electron.d.ts doesn't declare the event — go through the
  // EventEmitter base signature.
  ;(wc as NodeJS.EventEmitter).on('close', () => {
    log.info('tab wc close', {
      tabId: rec.tabId,
      windowId: rec.windowId,
      url: (() => { try { return wc.getURL() } catch { return '' } })(),
    })
  })
  wc.on('destroyed', () => {
    log.info('tab wc destroyed', {
      tabId: rec.tabId,
      windowId: rec.windowId,
    })
  })
  wc.on('will-prevent-unload', (event) => {
    log.info('tab will-prevent-unload', {
      tabId: rec.tabId,
      url: (() => { try { return wc.getURL() } catch { return '' } })(),
    })
    // Don't preventDefault — let the page's beforeunload prompt run if the
    // user has unsaved input. This listener is purely for visibility.
    void event
  })
  wc.on('unresponsive', () => {
    log.warn('tab unresponsive', {
      tabId: rec.tabId,
      url: (() => { try { return wc.getURL() } catch { return '' } })(),
    })
  })
  wc.on('responsive', () => {
    log.info('tab responsive again', { tabId: rec.tabId })
  })

  // Push the navigation history bounds into the page (isolated-world
  // preload) so the two-finger swipe overlay refuses to engage in a
  // direction we can't actually go. Detection itself lives in the preload
  // (src/preload/webview-stealth.ts) because the scroll deltas it needs
  // are only available on the DOM WheelEvent — webContents.on('input-event')
  // delivers the base InputEvent (type + modifiers only), with no deltaX.
  const emitNavState = (): void => {
    if (wc.isDestroyed()) return
    const nav = wc.navigationHistory
    wc.send('newbro-gesture-bounds', {
      canGoBack: nav.canGoBack(),
      canGoForward: nav.canGoForward(),
    })
  }

  wc.on('did-start-loading', () => emit({ type: 'did-start-loading', tabId: rec.tabId }))
  wc.on('did-stop-loading', () =>
    emit({ type: 'did-stop-loading', tabId: rec.tabId, url: wc.getURL() })
  )

  // chrome.userScripts injection. The SW shim forwards register() calls
  // to main where they're stored per partition; here we run any that
  // match the current page URL at the right Chrome runAt phase.
  // - document_start: fire on did-frame-finish-load for the main frame's
  //   first navigation (best proxy we have for "before scripts run").
  //   Electron exposes did-start-navigation but the JS context isn't
  //   ready there, so executeJavaScript would silently no-op.
  // - document_end: dom-ready (DOM parsed, before subresources finish).
  // - document_idle: did-finish-load.
  // We don't separate document_start from document_end yet because the
  // event ordering in Electron doesn't always give us a usable hook
  // BEFORE DOMContentLoaded; document_end via dom-ready covers both for
  // the practical-effects case. Tampermonkey's wrapper handles its own
  // run-at semantics inside the user script anyway.
  wc.on('dom-ready', () => {
    const url = (() => { try { return wc.getURL() } catch { return '' } })()
    if (!url) return
    injectMatchingUserScripts(rec.partition, url, 'document_start', wc)
    injectMatchingUserScripts(rec.partition, url, 'document_end', wc)
  })
  wc.on('did-finish-load', () => {
    const url = (() => { try { return wc.getURL() } catch { return '' } })()
    if (!url) return
    injectMatchingUserScripts(rec.partition, url, 'document_idle', wc)
    // Install the chrome.storage.onChanged → SW bridge for any tab that
    // loads an extension-owned page (options.html, diagnostics.html,
    // dashboard.html, …). Same isolated-vs-main-world issue as the popup:
    // chrome.storage lives in MAIN world only, and writes from that world
    // need to reach the SW for cross-context onChanged semantics. The
    // injected script is idempotent (window.__newbroStorageBridgeInjected
    // guard) so a tab navigating within the same chrome-extension origin
    // doesn't stack listeners.
    if (url.startsWith('chrome-extension://')) {
      const m = url.match(/^chrome-extension:\/\/([a-p]{32})\//i)
      const extId = m ? m[1] : 'unknown'
      installFrameStorageBridge(wc, `tab/${extId}/${rec.tabId}`).catch((err) => {
        log.warn('tab: storage bridge install threw', {
          tabId: rec.tabId,
          url,
          err: String(err),
        })
      })
    }
  })
  wc.on('did-navigate', (_e, url) => {
    emit({ type: 'did-navigate', tabId: rec.tabId, url })
    emitNavState()
    // Record an autocomplete entry for the URL bar. did-navigate fires once
    // per main-frame commit, so each real navigation is counted exactly once;
    // in-page hash changes go through did-navigate-in-page (skipped here on
    // purpose — they'd inflate the LRU with anchor variants of the same
    // page). The history module itself filters non-http schemes.
    try { addHistoryVisit(url) }
    catch (err) { log.warn('history.addVisit failed', String(err)) }
  })
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    emit({ type: 'did-navigate-in-page', tabId: rec.tabId, url, isMainFrame })
    emitNavState()
  })
  wc.on('enter-html-full-screen', () => {
    enterPageFullscreen(rec, 'native')
  })
  wc.on('leave-html-full-screen', () => {
    leavePageFullscreen(rec, 'native')
  })
  wc.on('page-title-updated', (_e, title) => {
    emit({ type: 'page-title-updated', tabId: rec.tabId, title })
    // Backfill the title onto the history entry — only updates the matching
    // URL if it's already in the store; no-op otherwise.
    try {
      const url = wc.getURL()
      if (url) updateHistoryTitle(url, title)
    } catch (err) {
      log.warn('history.updateTitle failed', String(err))
    }
  })
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
  // dom-ready is the first point the isolated-world preload has registered
  // its 'newbro-gesture-bounds' listener, so (re)push the current bounds.
  wc.on('dom-ready', () => { emitNavState(); emit({ type: 'dom-ready', tabId: rec.tabId, url: wc.getURL() }) })
  wc.on('did-finish-load', () =>
    emit({ type: 'did-finish-load', tabId: rec.tabId, url: wc.getURL() })
  )
  wc.on('found-in-page', (_e, result) =>
    emit({
      type: 'found-in-page',
      tabId: rec.tabId,
      requestId: result.requestId,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
      finalUpdate: result.finalUpdate,
    })
  )

  // window.open() handler. Two paths:
  //
  //   * `disposition: 'new-window'` — the page passed feature flags
  //     ("popup=yes,width=...,height=..."). This is the OAuth-popup
  //     contract: Figma / Google / GitHub providers spawn a popup whose
  //     `window.opener` they `postMessage` back to, and which closes itself
  //     once the handoff is done. We allow these as real BrowserWindows,
  //     re-using the tab's partition so cookies / localStorage are shared
  //     and the auth flow can complete.
  //
  //   * everything else — `_blank`, target=name, no features — becomes a
  //     new tab in the workspace, matching Edge-style "all popups are
  //     tabs" behavior. Most sites that do `window.open(url)` without
  //     features actually want a tab.
  wc.setWindowOpenHandler((details) => {
    const url = details.url
    const disposition = details.disposition
    const features = (details as { features?: string }).features ?? ''

    if (disposition === 'new-window') {
      log.info('tab window-open: allowing popup', { tabId: rec.tabId, url, features })
      const dims = parsePopupFeatures(features)
      const width = Math.max(dims.width ?? POPUP_MIN_WIDTH, POPUP_MIN_WIDTH)
      const height = Math.max(dims.height ?? POPUP_MIN_HEIGHT, POPUP_MIN_HEIGHT)
      return {
        action: 'allow',
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          width,
          height,
          ...(dims.left !== undefined ? { x: dims.left } : {}),
          ...(dims.top !== undefined ? { y: dims.top } : {}),
          autoHideMenuBar: true,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          webPreferences: {
            partition: rec.partition,
            session: session.fromPartition(rec.partition),
            preload: WEBVIEW_STEALTH_PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
          },
        },
      }
    }

    // Chromium tags Cmd/Ctrl+Click as 'background-tab' and Shift+Cmd+Click
    // as 'foreground-tab'. A plain LMB on a target="_blank" link arrives
    // as 'default' — that one switches to the new tab so the page's own
    // "click → see new content" flow keeps working unsurprisingly.
    const channel = disposition === 'background-tab'
      ? 'open-url-as-tab-background'
      : 'open-url-as-tab'
    log.info('tab window-open: routing as new tab', { tabId: rec.tabId, url, disposition, channel })
    sendToWindowRenderer(rec.windowId, channel, url)
    return { action: 'deny' }
  })

  // Track popups created from this tab so nested window.open calls inside
  // the popup follow the same partition + preload contract, and so we can
  // log lifecycle events for OAuth-flow triage.
  wc.on('did-create-window', (childWindow, eventDetails) => {
    log.info('tab did-create-window', {
      tabId: rec.tabId,
      childId: childWindow.id,
      url: eventDetails?.url,
    })
    // Pin the popup's webContents to the tab's partition so any further
    // window.open inside the popup can be routed back through the same
    // session — same overrideBrowserWindowOptions shape as the parent
    // handler above, just without the dimensions (the inner popup picks
    // its own).
    childWindow.webContents.setWindowOpenHandler((d) => {
      if (d.disposition === 'new-window') {
        return {
          action: 'allow',
          outlivesOpener: false,
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: {
              partition: rec.partition,
              session: session.fromPartition(rec.partition),
              preload: WEBVIEW_STEALTH_PRELOAD,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false,
            },
          },
        }
      }
      // Same disposition-based routing as the parent setWindowOpenHandler
      // — Cmd+Click inside a child popup also opens in background.
      const childChannel = d.disposition === 'background-tab'
        ? 'open-url-as-tab-background'
        : 'open-url-as-tab'
      sendToWindowRenderer(rec.windowId, childChannel, d.url)
      return { action: 'deny' }
    })
    childWindow.once('closed', () => {
      log.info('tab popup closed', { tabId: rec.tabId, childId: childWindow.id })
    })
  })

  // Close any open extension popup when the user clicks the page. We only
  // react to the start of a click; the icon button's own onClick handler
  // takes care of the "click the icon while popup is open" case.
  wc.on('input-event', (_e, input) => {
    if (input.type !== 'mouseDown') return
    if (extensionPopupByWindow.has(rec.windowId)) {
      closeExtensionPopup(rec.windowId)
    }
  })
}

// ── Two-finger horizontal swipe → back/forward ─────────────────────────
// Detection lives in the page (src/preload/webview-stealth.ts), NOT here.
// It needs the scroll delta (deltaX/deltaY), and Electron's
// webContents.on('input-event') only delivers the base InputEvent
// (type + modifiers) — the mouseWheel deltas are never populated on the
// observed event, so a main-process wheel reader can't measure the swipe.
// The preload reads the DOM WheelEvent, renders the overlay, and on commit
// sends 'newbro-nav' here (see installTabPreloadListeners). Main only
// pushes navigation bounds to the page via 'newbro-gesture-bounds'
// (see emitNavState in wireEvents).


export function setWindowBounds(windowId: number, bounds: TabBounds): void {
  windowBounds.set(windowId, bounds)
  const activeTabId = activeTabByWindow.get(windowId)
  if (!activeTabId) return
  const rec = tabs.get(activeTabId)
  if (!rec) return
  rec.lastBounds = bounds
  applyCurrentBounds(rec)
}

export function createTab(opts: {
  windowId: number
  tabId: string
  partition: string
  url: string
  active: boolean
  /** When true, the tab starts loading immediately even if `active` is
   *  false. Used for user-opened background tabs (Cmd+Click, middle-
   *  click, RMB → Open in New Tab) so the page is already ready when
   *  the user switches to it. Restored / programmatic tabs leave this
   *  false to preserve the existing lazy-load behaviour. */
  eagerLoad?: boolean
  /** When true, keep OS keyboard focus on the renderer instead of handing
   *  it to the new page — the "focus URL on new tab" preference. The
   *  renderer then focuses the toolbar URL bar. Without this the page
   *  would grab focus as it settles, forcing the URL-bar focus to be
   *  deferred and letting the load clobber whatever the user typed. */
  focusUrlBar?: boolean
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
      // Never let Electron auto-focus the page on navigation. It defaults
      // to true (focus the WebContents whenever it navigates), which causes
      // two distinct focus-steal bugs:
      //   * "Focus URL on new tab": the load-time focus yanks OS keyboard
      //     focus away from the toolbar URL bar as the page settles.
      //   * Background error pages: when a tab's load fails (e.g. a DNS
      //     error during workspace restore), Chromium commits its internal
      //     error page — a navigation. With focusOnNavigation:true that
      //     commit calls webContents.focus(), and on Windows focusing a
      //     child WebContentsView activates its top-level window, pulling
      //     the whole window to the foreground across virtual desktops —
      //     long after the user switched to another app. The DNS lookup
      //     resolves slowly enough that this lands while they're elsewhere.
      // We hand focus to the page ourselves on every real user action that
      // should grab the keyboard (tab open/activate, URL-bar Enter,
      // back/forward/reload, Escape-into-page), all of which run while the
      // window is already focused — so disabling auto-focus loses nothing
      // and the page never grabs focus behind the user's back.
      focusOnNavigation: false,
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

  // Register the tab with electron-chrome-extensions so chrome.tabs.*
  // sees it. The library auto-marks each newly-added tab as the
  // window's active tab via observeTab → onActivated, which fires our
  // selectTab callback. With multiple tabs being created on workspace
  // restore, that cascade made every tab "active" in turn and the
  // renderer's URL bar cycled through all of them. Suppress the
  // library's selectTab callback during the addTab + corrective
  // selectTab pair so only OUR view of the active tab wins.
  try {
    const ext = getExtensionsFor(view.webContents.session)
    if (ext) {
      suppressLibrarySelectTab(() => {
        ext.addTab(view.webContents, win)
        // The library just marked THIS tab active. Correct it back to
        // our recorded active tab if they differ (i.e. when adding a
        // background tab while another tab is foreground).
        const realActive = activeTabByWindow.get(opts.windowId)
        if (realActive && realActive !== opts.tabId) {
          const activeRec = tabs.get(realActive)
          if (activeRec) ext.selectTab(activeRec.view.webContents)
        }
      })
    }
  } catch (err) {
    log.warn('tab-views: addTab to extensions failed', { tabId: opts.tabId, err: String(err) })
  }

  // Resolve any pending chrome.tabs.create awaiting THIS URL. See
  // createTabForExtension for the round-trip rationale.
  if (opts.url) {
    const pending = pendingExtTabs.get(opts.url)
    if (pending) pending(view.webContents)
  }

  // Let the owning window install its shortcut interceptor on this tab's
  // webContents so menu accelerators fire even when the page has focus.
  const install = shortcutInstallers.get(opts.windowId)
  if (install) install(view.webContents, win)

  if (opts.active) {
    setActiveTab(opts.windowId, opts.tabId)
    loadIfNeeded(rec, opts.url)
    if (opts.focusUrlBar) {
      // "Focus URL on new tab": keep OS keyboard focus on the parent
      // renderer so the toolbar URL bar can own it from the very start.
      // The renderer focuses the URL bar immediately (see WebviewPanel).
      // Crucially we do NOT focus the page here — otherwise it would steal
      // OS focus as it settles, blur the URL bar, and clobber the user's
      // typing. The page still loads; it just doesn't grab the keyboard.
      try {
        win.webContents.focus()
      } catch {
        /* ignore */
      }
    } else {
      // Hand OS keyboard focus to the new tab's webContents so the user can
      // start typing into the page right away — this is the "focus site"
      // default.
      try {
        rec.view.webContents.focus()
      } catch {
        /* ignore */
      }
    }
  } else if (opts.eagerLoad) {
    // User-opened background tab — start loading now so the page is
    // ready when they switch to it. Skip the focus call: the tab is
    // intentionally not active and shouldn't pull keyboard focus from
    // the page the user is still reading.
    loadIfNeeded(rec, opts.url)
  } else {
    // Keep lazy: inactive tabs stay at about:blank until first activation.
    // We don't even call loadURL so the guest webContents is effectively
    // idle — matches the old <webview> lazy-load behavior.
  }
}

/** Match a `chrome-extension://<id>/...` URL and return the extension id.
 *  Returns null for non-extension URLs. Used to gate any tab navigation
 *  that targets an extension's own page on a "session has the extension
 *  loaded" check — Chromium's navigation throttle 403s the load with
 *  `ERR_BLOCKED_BY_CLIENT (-20)` if the extension isn't registered for
 *  the navigating session, even when the resource is web-accessible. */
function extractExtensionIdFromExtUrl(url: string): string | null {
  const m = url.match(/^chrome-extension:\/\/([a-p]{32})\//i)
  return m ? m[1] : null
}

async function startTabNavigation(rec: TabRecord, url: string): Promise<void> {
  // Some extensions (Browsec's "Health Check" button) link to other
  // extensions using the legacy `extension://<id>/…` scheme. Chromium
  // accepts this as an alias for `chrome-extension://`, but Electron's
  // loadURL doesn't — it fails with ERR_FAILED. Normalise here so the
  // canonical chrome-extension:// path takes over (incl. ensureExtension-
  // InSession below).
  if (url.startsWith('extension://')) {
    url = 'chrome-' + url
  }
  const extId = extractExtensionIdFromExtUrl(url)
  if (extId) {
    // Extension is supposed to already be loaded into this partition
    // (setupPartitionSession → loadEnabledExtensionsInto), but on a fresh
    // partition the load is fire-and-forget. Awaiting here closes the
    // race with the loadURL below.
    await ensureExtensionInSession(rec.view.webContents.session, extId).catch(() => false)
  }
  rec.view.webContents.loadURL(url).catch((err) => {
    // ERR_ABORTED is normal during user-initiated redirects (e.g. Google's
    // consent.google.com flow interrupting a chromewebstore load). Skip.
    const msg = String(err)
    if (msg.includes('ERR_ABORTED')) return
    log.warn('tab-views: loadURL failed', { tabId: rec.tabId, url, err: msg })
  })
}

function loadIfNeeded(rec: TabRecord, url: string): void {
  if (rec.activated) return
  rec.activated = true
  if (!url || url === 'about:blank') return
  void startTabNavigation(rec, url)
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

/** Hand OS keyboard focus to a tab's page unconditionally. Unlike
 *  activateTab (which only focuses on a *new* activation), this works for
 *  the already-active tab — used by the renderer's Escape handler to move
 *  focus from the URL bar / chrome back into the site so keystrokes reach
 *  the page. */
export function focusTab(tabId: string): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  focusTabPage(rec)
}

/** Hand OS keyboard focus to a tab's page. Centralised so every "focus the
 *  site now" caller (activate, user navigation, back/forward/reload, Escape)
 *  goes through one guarded call — tabs are created with
 *  focusOnNavigation:false, so this is the only thing that moves focus into
 *  the page, and it must only ever fire from window-focused user actions. */
function focusTabPage(rec: TabRecord): void {
  try {
    rec.view.webContents.focus()
  } catch {
    /* ignore */
  }
}

function setActiveTab(windowId: number, tabId: string): void {
  const prev = activeTabByWindow.get(windowId)
  if (prev === tabId) return // already active — no need to re-bound or notify
  // Switching tabs drops out of the previous tab's HTML fullscreen (the
  // leave event isn't always emitted on a tab switch), so the new active tab
  // must not inherit cinema-mode bounds, and the window base must come
  // back from black.
  const fsTab = htmlFullscreenByWindow.get(windowId)
  if (fsTab && fsTab !== tabId) {
    const fsRec = tabs.get(fsTab)
    if (fsRec) leavePageFullscreen(fsRec, 'tab-switch')
    else {
      htmlFullscreenByWindow.delete(windowId)
      const fsWin = BrowserWindow.fromId(windowId)
      try { fsWin?.setBackgroundColor(DEFAULT_WINDOW_BG) } catch { /* ignore */ }
    }
  }
  if (prev && prev !== tabId) {
    const prevRec = tabs.get(prev)
    if (prevRec) {
      prevRec.lastBounds = HIDDEN_BOUNDS
      prevRec.view.setBounds(HIDDEN_BOUNDS)
      // Drop any fullscreen black base — leave-html-full-screen isn't always
      // emitted when a fullscreen tab is switched away from.
      try { prevRec.view.setBackgroundColor(TAB_BG_TRANSPARENT) } catch { /* ignore */ }
    }
  }
  activeTabByWindow.set(windowId, tabId)
  const rec = tabs.get(tabId)
  if (!rec) return
  const wb = windowBounds.get(windowId)
  if (wb) {
    rec.lastBounds = wb
    applyCurrentBounds(rec)
  }
  // Tell electron-chrome-extensions which tab is now active so
  // chrome.tabs.query({active:true}) and chrome.tabs.onActivated fire
  // with the right tab id. Wrapped in suppressLibrarySelectTab so the
  // library's internal active-tab-changed event can't bounce back as
  // a selectTab callback we'd then re-process (which would create the
  // exact loop we just fixed in createTab).
  try {
    const ext = getExtensionsFor(rec.view.webContents.session)
    if (ext) {
      suppressLibrarySelectTab(() => ext.selectTab(rec.view.webContents))
    }
  } catch (err) {
    log.warn('tab-views: selectTab to extensions failed', { tabId, err: String(err) })
  }
}

export function destroyTab(tabId: string): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  const wcId = rec.view.webContents.id
  // Notify electron-chrome-extensions so chrome.tabs.onRemoved fires
  // and any cached state about this tab is cleaned up. Done before we
  // tear down the WebContentsView — once the webContents is destroyed
  // the library can't read its id any more.
  try {
    const ext = getExtensionsFor(rec.view.webContents.session)
    if (ext) ext.removeTab(rec.view.webContents)
  } catch {
    /* ignore — library may not be initialised for this session */
  }
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
  if (htmlFullscreenByWindow.get(rec.windowId) === tabId) {
    // Closing a tab mid-fullscreen won't emit leave, so undo the black base
    // and tell the renderer to restore normal layout.
    leavePageFullscreen(rec, 'destroy')
  }
}

export function destroyAllTabsForWindow(windowId: number): void {
  for (const [id, rec] of tabs) {
    if (rec.windowId === windowId) destroyTab(id)
  }
  windowBounds.delete(windowId)
  activeTabByWindow.delete(windowId)
  htmlFullscreenByWindow.delete(windowId)
  windowStateBeforePage.delete(windowId)
  normalWindowStateByWindow.delete(windowId)
  clearFullscreenWindowTimers(windowId)
}

export function tabNavigate(tabId: string, url: string): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  rec.activated = true
  void startTabNavigation(rec, url)
  // A navigation through this path is always a real user action (Enter in the
  // URL bar, error-page retry, cert continue). Tabs no longer auto-focus on
  // navigation (focusOnNavigation:false — see createTab), so hand keyboard
  // focus to the page explicitly here. Safe to do unconditionally: every
  // caller runs while the window is already focused, so this can't pull the
  // window forward behind the user's back the way a background load could.
  focusTabPage(rec)
}

export function tabGoBack(tabId: string): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  const nav = rec.view.webContents.navigationHistory
  if (nav.canGoBack()) nav.goBack()
  // Back/forward/reload used to rely on focusOnNavigation to move keyboard
  // focus to the page once the navigation committed. With that disabled we
  // focus explicitly — these are user actions (toolbar button, shortcut,
  // swipe gesture) that always run while the window is focused.
  focusTabPage(rec)
}

export function tabGoForward(tabId: string): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  const nav = rec.view.webContents.navigationHistory
  if (nav.canGoForward()) nav.goForward()
  focusTabPage(rec)
}

/** Cmd+S / palette "Save Page As…". Suggests a filename from the URL's
 *  last path segment (so a viewed example.txt saves as example.txt) or
 *  the page title for extension-less routes, then hands the chosen path
 *  to Chromium's save machinery. 'HTMLOnly' saves the main resource's
 *  ORIGINAL bytes — raw text for text/plain documents, served HTML for
 *  pages; choosing a .mhtml name saves a full single-file snapshot. */
export async function tabSavePage(tabId: string): Promise<boolean> {
  const rec = tabs.get(tabId)
  if (!rec) return false
  const win = BrowserWindow.fromId(rec.windowId)
  if (!win || win.isDestroyed()) return false
  const wc = rec.view.webContents

  let base = ''
  try {
    const u = new URL(wc.getURL())
    base = decodeURIComponent(u.pathname.split('/').pop() || '')
  } catch (err) {
    log.warn('save-page: URL parse failed', { tabId, err: String(err) })
  }
  // Routes without a file-ish last segment ("/wiki/Electron", "/") get a
  // title-derived .html name instead.
  if (!base.includes('.')) {
    const title = wc.getTitle().replace(/[\\/:*?"<>|]+/g, ' ').trim()
    base = `${title || base || 'page'}.html`
  }

  const isHtmlName = /\.(html?|mhtml)$/i.test(base)
  const result = await dialog.showSaveDialog(win, {
    title: 'Save Page',
    defaultPath: base,
    filters: isHtmlName
      ? [
          { name: 'Webpage, HTML Only', extensions: ['html', 'htm'] },
          { name: 'Web Archive, Single File', extensions: ['mhtml'] },
        ]
      : [{ name: 'All Files', extensions: ['*'] }],
  })
  if (result.canceled || !result.filePath) return false
  const saveType = /\.mhtml$/i.test(result.filePath) ? 'MHTML' : 'HTMLOnly'
  try {
    await wc.savePage(result.filePath, saveType)
    log.info('save-page: saved', { tabId, path: result.filePath, saveType })
    return true
  } catch (err) {
    log.warn('save-page: savePage failed', { tabId, path: result.filePath, err: String(err) })
    return false
  }
}

export function tabReload(tabId: string, ignoreCache: boolean): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  if (ignoreCache) rec.view.webContents.reloadIgnoringCache()
  else rec.view.webContents.reload()
  // Match the pre-focusOnNavigation:false behaviour: a user-triggered reload
  // moves keyboard focus back into the page. Always a window-focused action.
  focusTabPage(rec)
}

export function tabStop(tabId: string): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  rec.view.webContents.stop()
}

export function tabFindInPage(
  tabId: string,
  text: string,
  options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
): number {
  const rec = tabs.get(tabId)
  if (!rec) return 0
  if (!text) return 0
  return rec.view.webContents.findInPage(text, options)
}

export function tabStopFindInPage(
  tabId: string,
  action: 'clearSelection' | 'keepSelection' | 'activateSelection',
): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  rec.view.webContents.stopFindInPage(action)
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

/** Hidden-but-alive popups, keyed by `${windowId}::${extensionId}`.
 *  When the user dismisses a popup we DETACH the WebContentsView from
 *  the window's contentView (so it's invisible) but keep the
 *  webContents alive — Browsec's popup-side store, in-flight port
 *  connections to its SW, and any attached DevTools session all
 *  survive. The next toggleExtensionPopup call for the same
 *  (window, extension) pair re-attaches the cached view rather than
 *  rebuilding from scratch. Without this caching every popup-close
 *  destroyed the WC, popup-side state was lost, the runtime.connect
 *  port to the SW closed, and chrome.storage updates the popup made
 *  earlier looked stale on reopen — symptoms the user reported as
 *  "state doesn't persist" / "it works inconsistently". */
const hiddenExtensionPopups = new Map<string, ExtensionPopupRecord>()
function popupCacheKey(windowId: number, extensionId: string): string {
  return `${windowId}::${extensionId}`
}

const POPUP_DEFAULT_WIDTH = 360
const POPUP_DEFAULT_HEIGHT = 520
/** Padding between window edge and popup so the panel never butts up
 *  against the sash. Matches Chrome's spacing. */
const POPUP_VIEWPORT_MARGIN = 6
/** Resize the popup WebContentsView to its content's natural size.
 *
 *  We tried `webContents.enablePreferredSizeMode(true)` +
 *  `'preferred-size-changed'` (Chrome's own mechanism) but the event
 *  never fires for our extension popup WebContents — likely because
 *  Electron's preferred-size signal needs init paths we don't go
 *  through. So we measure ourselves.
 *
 *  Naïvely reading `body.scrollWidth` doesn't work: body's `display:
 *  block` fills the viewport, so scrollWidth reports the WebContentsView
 *  width regardless of the actual UI size and the popup can grow but
 *  never shrink. Instead we walk body's flow children, take the largest
 *  intrinsic `offsetWidth` (the popup's design width is whatever its
 *  root container set explicitly) and sum heights for the stacked total.
 *  This reports the same number whether the view is 360 or 1200 wide. */
async function fitExtensionPopupToContent(windowId: number): Promise<void> {
  const rec = extensionPopupByWindow.get(windowId)
  if (!rec) return
  if (rec.view.webContents.isDestroyed()) return
  try {
    const result = (await rec.view.webContents.executeJavaScript(
      `(() => {
        const body = document.body;
        if (!body) return null;
        const html = document.documentElement;
        const bs = getComputedStyle(body);
        const hs = getComputedStyle(html);
        // Paint html with body's background so the body-margin gap doesn't
        // render as a transparent strip showing the page through. Browsers
        // don't render html.background by default, but assigning inline
        // here forces it.
        if (bs.backgroundColor && bs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          html.style.backgroundColor = bs.backgroundColor;
        }
        const flowChildren = Array.from(body.children).filter((c) => {
          const cs = getComputedStyle(c);
          return cs.display !== 'none'
            && cs.position !== 'fixed'
            && cs.position !== 'absolute';
        });
        if (flowChildren.length === 0) return null;
        // getBoundingClientRect reflects POST-zoom rendered dimensions —
        // Browsec's popup applies inline \`zoom: 0.85\` on its
        // MainContainer, so offsetWidth (logical/pre-zoom) reported 402
        // while the visible content was only ~343 wide. Sizing the
        // WebContentsView to 402 left a ~59px invisible strip on the
        // right: solid popup-bg color but no clickable UI inside it.
        // rect.width/height bake zoom in, so the view tracks the
        // rendered extent.
        const bodyRect = body.getBoundingClientRect();
        let maxRight = bodyRect.left;
        let maxBottom = bodyRect.top;
        for (const c of flowChildren) {
          const cs = getComputedStyle(c);
          const mr = parseFloat(cs.marginRight) || 0;
          const mb = parseFloat(cs.marginBottom) || 0;
          const cr = c.getBoundingClientRect();
          if (cr.right + mr > maxRight) maxRight = cr.right + mr;
          if (cr.bottom + mb > maxBottom) maxBottom = cr.bottom + mb;
        }
        // Distance from html's top-left to the right/bottom of content.
        // Then add html's right/bottom padding+border so a popup whose
        // root container has decorations on the inside still gets a
        // box that fully contains them.
        const htmlRight = (parseFloat(hs.paddingRight) || 0) + (parseFloat(hs.borderRightWidth) || 0);
        const htmlBottom = (parseFloat(hs.paddingBottom) || 0) + (parseFloat(hs.borderBottomWidth) || 0);
        const bodyMarginRight = parseFloat(bs.marginRight) || 0;
        const bodyMarginBottom = parseFloat(bs.marginBottom) || 0;
        const width = maxRight + bodyMarginRight + htmlRight;
        const height = maxBottom + bodyMarginBottom + htmlBottom;
        const pickColor = (s) => {
          const m = (s.backgroundColor || '').match(/^rgba?\\(([^)]+)\\)$/);
          if (!m) return null;
          const parts = m[1].split(',').map((v) => parseFloat(v.trim()));
          const [r, g, b, a = 1] = parts;
          if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || a <= 0) return null;
          const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
          return '#' + toHex(r) + toHex(g) + toHex(b);
        };
        const bgHex = pickColor(bs) || pickColor(hs);
        return { width, height, bgColor: bgHex };
      })()`,
    )) as { width?: number; height?: number; bgColor?: string | null } | null
    if (!result || typeof result.width !== 'number' || typeof result.height !== 'number') return
    // Ceil rather than round — under-sizing by a subpixel forces a
    // scrollbar in the popup, which we'd rather avoid in exchange for
    // an invisible 1px overshoot.
    const w = Math.ceil(result.width)
    const h = Math.ceil(result.height)
    if (w <= 0 || h <= 0) return
    log.info('extension popup: fit', {
      extensionId: rec.extensionId,
      w,
      h,
      bgColor: result.bgColor,
      prev: { w: rec.width, h: rec.height },
    })
    // Match the view's background to the popup body so any unfilled gap
    // between body's outer box and the WebContentsView (e.g. body margin
    // on a page that didn't reset it) doesn't render as a transparent
    // strip showing the page underneath.
    if (result.bgColor) {
      try { rec.view.setBackgroundColor(result.bgColor) }
      catch (err) {
        log.warn('extension popup: setBackgroundColor threw', {
          extensionId: rec.extensionId,
          bgColor: result.bgColor,
          err: String(err),
        })
      }
    }
    if (w === rec.width && h === rec.height) return
    rec.width = w
    rec.height = h
    const ownerWindow = BrowserWindow.fromId(rec.windowId)
    if (!ownerWindow || ownerWindow.isDestroyed()) return
    const bounds = clampPopupBounds(ownerWindow, rec.anchor, w, h)
    rec.view.setBounds(bounds)
  } catch {
    /* page may have torn down between read and resize */
  }
}

/** Register chrome.storage.onChanged in a chrome-extension:// frame's
 *  MAIN world and bridge every event to main via the existing
 *  newbro-ext-ipc.test handler.
 *
 *  Why this lives in main (not preload): contextIsolation:true means our
 *  preloads run in the ISOLATED world. Chromium's chrome.storage binding
 *  is wired to the frame's MAIN world only. Empirically (from runtime
 *  logs), `chrome` is present in isolated world but `chrome.storage` is
 *  absent there; 60 polling attempts × 50ms all returned hasStorage:
 *  false. executeJavaScript runs in the MAIN world, which IS where
 *  chrome.storage lives — and bypasses the extension's CSP.
 *
 *  Used by:
 *    - openExtensionPopup (popup webContents, did-finish-load hook)
 *    - createTab via wireEvents (any chrome-extension:// page loaded as a
 *      regular tab, e.g. options.html, diagnostics.html, etc.)
 *
 *  Idempotent across reloads: the injected script guards on a
 *  window-level flag so a renderer-internal navigation doesn't stack
 *  duplicate listeners. The popup webContents is reused across hide/show
 *  cycles (we cache it instead of destroying — see hideExtensionPopup),
 *  so this is installed once per popup lifetime. For options-page tabs
 *  the listener persists for the tab's lifetime. */
async function installFrameStorageBridge(
  wc: Electron.WebContents,
  contextLabel: string,
): Promise<void> {
  if (wc.isDestroyed()) return
  const code = `
    (function () {
      if (window.__newbroStorageBridgeInjected) return 'already-injected';
      window.__newbroStorageBridgeInjected = true;
      var ready = function () {
        return typeof chrome !== 'undefined'
          && chrome.storage
          && chrome.storage.onChanged
          && typeof chrome.storage.onChanged.addListener === 'function'
          && chrome.runtime
          && typeof chrome.runtime.id === 'string';
      };
      var install = function () {
        var extId = chrome.runtime.id;
        // chrome.storage.onChanged is a single event that fires for ALL
        // areas (local/sync/session/managed) with the areaName argument.
        // So a single listener covers every area — areaName flows all the
        // way through to fireStorageChange in the SW shim, where each
        // bridged listener gets called with the original area string.
        chrome.storage.onChanged.addListener(function (changes, areaName) {
          try {
            fetch('https://newbro-ext-ipc.test/storage-bridge', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ extId: extId, areaName: areaName, changes: changes }),
            }).catch(function () {});
          } catch (e) { /* ignore */ }
        });
        try {
          fetch('https://newbro-ext-ipc.test/storage-bridge-mainworld-installed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              extId: extId,
              href: location.href,
              // Surface which areas exist in this context so we can spot
              // an extension that uses .sync/.session and find out at
              // install time whether the bridge will cover it.
              areas: {
                local: !!(chrome.storage && chrome.storage.local),
                sync: !!(chrome.storage && chrome.storage.sync),
                session: !!(chrome.storage && chrome.storage.session),
                managed: !!(chrome.storage && chrome.storage.managed),
              },
            }),
          }).catch(function () {});
        } catch (e) { /* ignore */ }
      };
      if (ready()) { install(); return 'installed-sync'; }
      var attempts = 0;
      var poll = function () {
        attempts++;
        if (ready()) { install(); return; }
        if (attempts >= 60) {
          try {
            fetch('https://newbro-ext-ipc.test/storage-bridge-mainworld-gaveup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                href: location.href,
                hasChrome: typeof chrome !== 'undefined',
                hasStorage: !!(typeof chrome !== 'undefined' && chrome.storage),
                hasOnChanged: !!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged),
              }),
            }).catch(function () {});
          } catch (e) { /* ignore */ }
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
      return 'installing-async';
    })();
  `
  try {
    const result = await wc.executeJavaScript(code)
    log.info('extensions: frame storage bridge injected', { contextLabel, result })
  } catch (err) {
    log.warn('extensions: frame storage bridge executeJavaScript failed', {
      contextLabel,
      err: String(err),
    })
  }
}

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

/** Hard-destroy: tear down the webContents. Used when the popup's
 *  owner window itself goes away — at that point Chromium will reap
 *  the WC anyway, and any state in it is moot. NEVER use this for the
 *  user-dismiss flow — that goes through hideExtensionPopup so the
 *  popup's chrome.runtime port + Lit components survive between opens. */
function destroyExtensionPopup(rec: ExtensionPopupRecord): void {
  const win = BrowserWindow.fromId(rec.windowId)
  if (win && !win.isDestroyed()) {
    try {
      win.removeListener('blur', rec.onBlur)
    } catch (err) {
      log.warn('destroyExtensionPopup: removeListener threw', { err: String(err) })
    }
    try {
      win.contentView.removeChildView(rec.view)
    } catch (err) {
      log.warn('destroyExtensionPopup: removeChildView threw', { err: String(err) })
    }
  }
  const wc = rec.view && (rec.view as { webContents?: Electron.WebContents }).webContents
  if (!wc) return
  try {
    wc.close()
  } catch (closeErr) {
    log.warn('destroyExtensionPopup: wc.close threw', { err: String(closeErr) })
    try {
      ;(wc as unknown as { destroy?: () => void }).destroy?.()
    } catch (destroyErr) {
      log.warn('destroyExtensionPopup: wc.destroy threw', { err: String(destroyErr) })
    }
  }
}

/** Soft-dismiss: detach the popup view from the window so it stops
 *  being rendered, but keep the underlying webContents alive in the
 *  hidden cache. The window 'blur' listener is removed (it would
 *  re-fire on the next open and immediately re-close). We DON'T
 *  destroy / close the WC — Browsec's popup state, port connections,
 *  and any attached DevTools session all survive until the owning
 *  window itself closes. */
function hideExtensionPopup(rec: ExtensionPopupRecord): void {
  const win = BrowserWindow.fromId(rec.windowId)
  if (win && !win.isDestroyed()) {
    try {
      win.removeListener('blur', rec.onBlur)
    } catch (err) {
      log.warn('hideExtensionPopup: removeListener threw', { err: String(err) })
    }
    try {
      win.contentView.removeChildView(rec.view)
    } catch (err) {
      log.warn('hideExtensionPopup: removeChildView threw', { err: String(err) })
    }
  }
  // `rec.view` and its `webContents` can be undefined if the popup's
  // owner window/webContents was disposed between when blur fired and
  // when this setImmediate ran (TM's "create new script" navigates the
  // popup away, which can race with our soft-dismiss). Treat any
  // already-gone state as "skip cache, nothing to keep alive".
  const wc = rec.view && (rec.view as { webContents?: Electron.WebContents }).webContents
  if (!wc || wc.isDestroyed()) return
  const key = popupCacheKey(rec.windowId, rec.extensionId)
  const existing = hiddenExtensionPopups.get(key)
  if (existing && existing !== rec) {
    // A previous instance for this (window, extension) is already
    // cached — that shouldn't happen if open/close are paired, but
    // be defensive: dispose the older one so we don't leak it.
    destroyExtensionPopup(existing)
  }
  hiddenExtensionPopups.set(key, rec)
}

/** Wipe every cached popup whose windowId matches. Called from the
 *  owner window's 'closed' listener so we don't leak webContents
 *  pointing at a dead BrowserWindow. */
function purgeHiddenPopupsForWindow(windowId: number): void {
  for (const [key, rec] of hiddenExtensionPopups) {
    if (rec.windowId === windowId) {
      destroyExtensionPopup(rec)
      hiddenExtensionPopups.delete(key)
    }
  }
}

export function closeExtensionPopup(windowId: number): boolean {
  const rec = extensionPopupByWindow.get(windowId)
  if (!rec) return false
  extensionPopupByWindow.delete(windowId)
  hideExtensionPopup(rec)
  sendToWindowRenderer(windowId, 'extension-popup-closed', { extensionId: rec.extensionId })
  return true
}

/** Re-attach a cached (hidden) popup to its owner window. The
 *  webContents is alive — we just removed the view from contentView
 *  on close — so no reload, no port reconnect, no DevTools detach.
 *  The caller has already pulled the record out of
 *  hiddenExtensionPopups; we install the new anchor + blur listeners
 *  and put the record back in extensionPopupByWindow. */
function showCachedExtensionPopup(
  rec: ExtensionPopupRecord,
  ownerWindow: BrowserWindow,
  anchor: { x: number; y: number; width: number; height: number },
): void {
  rec.anchor = anchor
  ownerWindow.contentView.addChildView(rec.view)
  rec.view.setBounds(clampPopupBounds(ownerWindow, anchor, rec.width, rec.height))
  ownerWindow.on('blur', rec.onBlur)
  extensionPopupByWindow.set(rec.windowId, rec)
  // Pull keyboard focus into the popup so input fields are typeable
  // immediately, matching the fresh-create flow's did-finish-load
  // focus call.
  try { rec.view.webContents.focus() }
  catch (err) {
    log.warn('extension popup: focus on cached re-show threw', {
      extensionId: rec.extensionId,
      err: String(err),
    })
  }
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

  // Cache reuse: if we have a hidden popup for this (window, extension)
  // pair from a previous open, re-attach it instead of building a new
  // WebContentsView. Browsec's popup-side store, runtime.connect port
  // to its SW, and any open DevTools session all stay intact — closing
  // and reopening the popup in quick succession no longer wipes the
  // user's selections or forces a full popup-side state reload.
  const cacheKey = popupCacheKey(windowId, extensionId)
  const cached = hiddenExtensionPopups.get(cacheKey)
  if (cached) {
    hiddenExtensionPopups.delete(cacheKey)
    if (!cached.view.webContents.isDestroyed()) {
      showCachedExtensionPopup(cached, ownerWindow, anchor)
      sendToWindowRenderer(windowId, 'extension-popup-opened', { extensionId })
      return 'opened'
    }
    // Cached WC was somehow destroyed (renderer crash?) — fall through
    // and create a fresh one.
    log.info('extension popup: cached webContents was destroyed, rebuilding', {
      extensionId,
      windowId,
    })
  }

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
    const sesExt = (ses as unknown as { extensions?: { getAllExtensions?: () => Electron.Extension[] } }).extensions
    const all = sesExt?.getAllExtensions?.() ?? []
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
  // the same surface — partition + session + sandbox off. The session-level
  // stealth preload is registered via `setPreloads` and runs here too, but
  // it self-disables on `chrome-extension://` URLs (see
  // src/preload/webview-stealth.ts STEALTH_ENABLED guard) so it doesn't
  // shadow the extension's `chrome.*` API surface or neuter window.close.
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
  // Transparent so any unfilled gap between our WebContentsView and the
  // popup HTML's own background colour doesn't render as a white border
  // around the popup. After fitExtensionPopupToContent runs there should
  // be no gap, but on first paint and during loadURL the gap is visible.
  view.setBackgroundColor('#00000000')
  ownerWindow.contentView.addChildView(view)

  // Tear down on owner-window blur. Listener is stored on the record so
  // closeExtensionPopup can remove it — without this, every open/close
  // cycle leaks a listener and Node hits MaxListenersExceeded after 11.
  // Exception: keep the popup alive while DevTools is attached.
  // Opening DevTools (detached mode) creates its own window and blurs
  // the workspace, which would tear down the popup the moment the user
  // tried to inspect it — destroying the WebContents that DevTools is
  // attached to. Skipping teardown while DevTools is open lets the user
  // actually use it; the popup will close on the next blur after they
  // dismiss DevTools.
  const onBlur = (): void => {
    try {
      if (!view.webContents.isDestroyed() && view.webContents.isDevToolsOpened()) return
    } catch (err) {
      // wc is gone — fall through and let closeExtensionPopup clean up
      // whatever's left.
      log.info('extension popup: isDevToolsOpened probe threw on blur', { err: String(err) })
    }
    closeExtensionPopup(windowId)
  }
  ownerWindow.on('blur', onBlur)

  // Close on popup-blur too — the window-blur listener above only fires
  // when the user switches AWAY from the whole window. If they click
  // somewhere else INSIDE the same window (a tab, the address bar, the
  // sidebar), the window stays focused; only the popup's webContents
  // loses focus. Without this listener the popup stays visible
  // overlaying the page until the user explicitly closes it — the
  // exact "popup doesn't hide, just blurs" symptom users have hit.
  view.webContents.on('blur', () => {
    try {
      if (!view.webContents.isDestroyed() && view.webContents.isDevToolsOpened()) return
    } catch (err) {
      log.info('extension popup: isDevToolsOpened probe threw on wc blur', { err: String(err) })
    }
    // Defer one tick so that re-opening the same popup via toolbar
    // click (which momentarily blurs then re-focuses) doesn't race
    // with the close-then-reopen path. If the popup is still the
    // active one for this window after the tick, dismiss it.
    setImmediate(() => {
      const cur = extensionPopupByWindow.get(windowId)
      if (cur === rec) closeExtensionPopup(windowId)
    })
  })

  // Diagnose silent popup failures: a renderer crash, hang, or aborted
  // load all surface as "click did nothing" / "blank white panel" to the
  // user. Logging the cause makes triage tractable.
  view.webContents.on('render-process-gone', (_e, details) => {
    log.error('extension popup: renderer gone', { extensionId, details })
  })
  view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    log.warn('extension popup: did-fail-load', {
      extensionId,
      url: validatedURL,
      errorCode,
      errorDescription,
    })
  })
  // Open extension-page links inside the popup as new tabs. Without this,
  // an extension's "Open dashboard" link inside the popup tries to navigate
  // the popup view itself, which we don't want — the popup should stay
  // small and the dashboard belongs in a regular tab.
  view.webContents.setWindowOpenHandler((details) => {
    sendToWindowRenderer(windowId, 'open-url-as-tab', details.url)
    closeExtensionPopup(windowId)
    return { action: 'deny' }
  })

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
    // Don't tear down the popup on initial load failure — the white panel
    // is at least visible feedback that the click landed, and the
    // did-fail-load listener above logs the cause for triage. Tearing down
    // here used to make Tampermonkey's icon-click look like a no-op when
    // the chrome-extension:// load was bouncing on a navigation throttle.
    log.warn('extension popup: loadURL failed', { url, err: String(err) })
  })

  // Auto-open DevTools on the popup when NEWBRO_EXT_DEVTOOLS=1 is set.
  // The popup is a free-standing WebContentsView with no chrome and
  // no right-click "Inspect" — there's otherwise no way to see what
  // its scripts log, so when the popup white-screens (e.g. an
  // exception inside the extension's popup.html) we have no signal
  // beyond an empty rectangle. Gated on env var so the production
  // experience isn't littered with devtools windows.
  if (process.env['NEWBRO_EXT_DEVTOOLS']) {
    try { view.webContents.openDevTools({ mode: 'detach' }) }
    catch (err) {
      log.warn('extension popup: openDevTools env-gated path threw', {
        extensionId,
        err: String(err),
      })
    }
  }
  // Right-click → Inspect, plus Cmd/Ctrl+Shift+I shortcut. The popup
  // has no native context menu and no toolbar, so without these the
  // only way to open DevTools is the env var above. Mirrors what
  // browsers offer for extension popups (chrome://extensions enables
  // "Inspect views" for the SW; this gives the same for the popup
  // window itself).
  view.webContents.on('context-menu', (_e, params) => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Inspect',
        click: () => {
          try {
            view.webContents.openDevTools({ mode: 'detach' })
            view.webContents.inspectElement(params.x, params.y)
          } catch (err) {
            log.warn('extension popup: Inspect context-menu click threw', {
              extensionId,
              err: String(err),
            })
          }
        },
      },
    ])
    menu.popup({ window: ownerWindow })
  })
  view.webContents.on('before-input-event', (_e, input) => {
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (mod && input.shift && input.key.toLowerCase() === 'i') {
      try { view.webContents.toggleDevTools() }
      catch (err) {
        log.warn('extension popup: toggleDevTools shortcut threw', {
          extensionId,
          err: String(err),
        })
      }
    }
  })
  // Also pipe in-popup console messages into the main log
  // unconditionally — even without devtools open, we'll see what
  // the popup page logs / warns / errors. Cheap, narrow signal that's
  // saved us hours of triage on the SW side and is just as useful
  // for popup-side white-screen bugs.
  view.webContents.on('console-message', (e) => {
    const detail = e as unknown as { level?: string; message?: string; sourceId?: string; line?: number }
    const msg = String(detail.message ?? '')
    const isError = detail.level === 'warning' || detail.level === 'error'
    if (!isError && shouldDropExtConsoleMessage(msg)) return
    const truncated = msg.length > 400 ? msg.slice(0, 400) + ` …(${msg.length - 400} more)` : msg
    log.info('extension popup console', {
      extensionId,
      level: detail.level,
      sourceId: detail.sourceId,
      line: detail.line,
      msg: truncated,
    })
  })

  // Pull keyboard focus into the popup once the page is rendered so typing
  // (form fields, search boxes inside the popup) routes there without the
  // user needing an extra click. Bail out if the popup was torn down before
  // load completed.
  view.webContents.once('did-finish-load', () => {
    if (!extensionPopupByWindow.has(windowId)) return
    try { view.webContents.focus() }
    catch (err) {
      log.warn('extension popup: focus on did-finish-load threw', {
        extensionId,
        err: String(err),
      })
    }
    // Install chrome.storage.onChanged bridge in the popup's MAIN world.
    //
    // The preloads we register (session-level extension-shim, plus
    // WEBVIEW_STEALTH_PRELOAD here) run in the ISOLATED world because
    // contextIsolation:true. Chromium's chrome.storage binding is
    // installed in the popup's MAIN world only — that's where the
    // extension's own scripts run, and where Browsec's popup updates
    // storage on country pick. From isolated world we see `chrome`
    // (added via electron-chrome-extensions's library preload bridge)
    // but `chrome.storage` is absent, which is why our previous
    // preload-based polling install gave up after 3s with
    // hasStorage:false on every attempt.
    //
    // executeJavaScript runs in the renderer's MAIN world and is not
    // subject to the extension's CSP (`script-src 'self'` blocks
    // inline <script> injection but doesn't apply to Electron's
    // direct script execution). So we just register the listener
    // here and POST changes to main via newbro-ext-ipc.test, where
    // the existing 'storage-bridge' webRequest IPC handler queues
    // them per extId for the SW long-poll.
    installFrameStorageBridge(view.webContents, `popup/${extensionId}`).catch((err) => {
      log.warn('extension popup: storage bridge install threw', {
        extensionId,
        err: String(err),
      })
    })
    // Fit the WebContentsView to the popup's natural content size.
    // Most popups settle synchronously on first paint, but Tampermonkey
    // / Dark Reader / Browsec hydrate UI from chrome.storage promises
    // and grow late, so we retry out to ~1.2s. Each attempt is a single
    // executeJavaScript round-trip + setBounds when changed.
    fitExtensionPopupToContent(windowId)
    setTimeout(() => fitExtensionPopupToContent(windowId), 50)
    setTimeout(() => fitExtensionPopupToContent(windowId), 200)
    setTimeout(() => fitExtensionPopupToContent(windowId), 600)
    setTimeout(() => fitExtensionPopupToContent(windowId), 1200)
  })

  // Tear down on owner-window destroy. Map cleanup happens here too in
  // case the popup outlived our explicit close (shouldn't, but defensive).
  // Also reap any popups parked in the hidden cache for this window —
  // their webContents would otherwise leak past the window's lifetime.
  ownerWindow.once('closed', () => {
    extensionPopupByWindow.delete(windowId)
    purgeHiddenPopupsForWindow(windowId)
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

/** Reverse lookup: find the tab record whose WebContentsView owns this
 *  WebContents. Used by the downloads manager to close a tab that was
 *  opened solely to trigger a download (target="_blank" → fresh tab →
 *  immediate Content-Disposition: attachment) so the user isn't left with
 *  a useless blank tab next to their download. */
export function findTabByWebContents(wc: WebContents): { tabId: string; windowId: number } | null {
  for (const [tabId, rec] of tabs) {
    if (rec.view.webContents === wc) return { tabId, windowId: rec.windowId }
  }
  return null
}

/** Find a tab's webContents by Chrome's tabs.Tab.id, which we map to
 *  Electron's webContents.id. Used by chrome.userScripts.execute and
 *  chrome.scripting.executeScript backends to run a script in a
 *  specific tab without going through the SW shim's chrome.tabs
 *  bookkeeping. */
export function getWebContentsByChromeTabId(chromeTabId: number): WebContents | null {
  const tabId = wcIdToTabId.get(chromeTabId)
  if (!tabId) return null
  const rec = tabs.get(tabId)
  if (!rec || rec.view.webContents.isDestroyed()) return null
  return rec.view.webContents
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
  rememberNormalWindowState(win)
  const sync = (): void => {
    syncFullscreenBounds(win.id)
    if (!htmlFullscreenByWindow.has(win.id) && !windowStateBeforePage.has(win.id)) {
      rememberNormalWindowState(win)
    }
  }
  win.on('move', sync)
  win.on('resize', sync)
  win.on('maximize', sync)
  win.on('unmaximize', sync)
  win.on('enter-full-screen', sync)
  win.on('leave-full-screen', sync)
  win.once('closed', () => {
    win.removeListener('move', sync)
    win.removeListener('resize', sync)
    win.removeListener('maximize', sync)
    win.removeListener('unmaximize', sync)
    win.removeListener('enter-full-screen', sync)
    win.removeListener('leave-full-screen', sync)
  })
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

  ipcMain.on('newbro-pseudo-fullscreen', (event, active: unknown) => {
    const tabId = wcIdToTabId.get(event.sender.id)
    if (!tabId) return
    const rec = tabs.get(tabId)
    if (!rec) return
    const payload = typeof active === 'object' && active !== null
      ? active as { active?: unknown; phase?: unknown; metrics?: unknown }
      : null
    const next = payload ? payload.active : active
    if (next === true) enterPageFullscreen(rec, 'pseudo', payload?.metrics)
    else if (next === false) leavePageFullscreen(rec, 'pseudo')
  })

  // chrome.tabs.create / chrome.windows.create / chrome.runtime.openOptionsPage
  // polyfill. The extension-shim preload runs inside chrome-extension://
  // frames AND in MV3 service workers, where it intercepts the missing
  // chrome.* tab-opening calls and forwards the URL here. Sender can be
  // any webContents (popup view, background SW, options page) — we
  // don't try to map it to a specific tab; we just open the URL in the
  // currently-focused workspace window. That matches how Chrome routes
  // chrome.tabs.create from a background page when it doesn't carry a
  // tabs.windowId.
  ipcMain.on('newbro-ext-open-tab', (_event, payload: unknown) => {
    const p = (typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {})
    const url = typeof p.url === 'string' ? p.url : ''
    if (!url) return
    // Close any open extension popup so it doesn't outlive its anchor
    // when the user clicks "Dashboard" or "Open settings" inside it.
    const focused = BrowserWindow.getFocusedWindow()
    const target =
      focused && !focused.isDestroyed()
        ? focused
        : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
    if (!target) return
    if (extensionPopupByWindow.has(target.id)) closeExtensionPopup(target.id)
    sendToWindowRenderer(target.id, 'open-url-as-tab', url)
  })

  // Diagnostic counterpart to extension-shim's reportLoaded(). Lets us
  // confirm in the main log that the shim actually ran in the SW and
  // that chrome.tabs.create was missing at the time we patched (i.e.
  // the polyfill is doing useful work, not duplicating Electron's API).
  ipcMain.on('newbro-ext-shim-loaded', (_event, info: unknown) => {
    log.info('extension shim loaded', info)
  })

  // Permission/management call traces from the frame shim. SW-context
  // calls go via the webRequest 'permission-check' action handled in
  // main/index.ts. Both surface here so we can see exactly which APIs
  // an extension is hitting when it decides "no access to this page".
  ipcMain.on('newbro-ext-shim-trace', (_event, info: unknown) => {
    log.info('extension shim trace (frame)', info)
  })

  // Popup → main: "what's the URL of the user's active tab in the
  // workspace that owns this popup?" Tampermonkey calls
  // chrome.tabs.query({active:true,currentWindow:true}) on popup
  // open, then matches that URL against host_permissions /
  // userscript matches to decide whether to show "no access to this
  // page". Electron's chrome.tabs.query returns the popup view itself
  // (URL = chrome-extension://…/action.html) so the match always
  // fails. The frame shim invokes this handler instead.
  ipcMain.handle('newbro-ext-active-tab-info', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return null
    const activeTabId = activeTabByWindow.get(win.id)
    if (!activeTabId) return null
    const rec = tabs.get(activeTabId)
    if (!rec) return null
    let url = ''
    let title = ''
    try { url = rec.view.webContents.getURL() }
    catch (err) { log.warn('active-tab-info: getURL threw', { tabId: rec.tabId, err: String(err) }) }
    try { title = rec.view.webContents.getTitle() }
    catch (err) { log.warn('active-tab-info: getTitle threw', { tabId: rec.tabId, err: String(err) }) }
    return {
      // chrome.tabs expects a numeric id. Hash the UUID to a stable
      // positive integer; collisions are vanishingly unlikely across
      // the handful of tabs a workspace holds.
      id: hashStringToInt(rec.tabId),
      url,
      title,
      active: true,
      highlighted: true,
      pinned: false,
      windowId: win.id,
      index: 0,
      status: 'complete',
      incognito: false,
      favIconUrl: '',
    }
  })

  ipcMain.on('newbro-open-in-new-tab', (event, url: unknown) => {
    const tabId = wcIdToTabId.get(event.sender.id)
    if (!tabId) return
    if (typeof url !== 'string' || !url) return
    const rec = tabs.get(tabId)
    if (!rec) return
    // Middle-click handoff from the stealth preload — Chrome / Firefox
    // open middle-clicked links in the background.
    sendToWindowRenderer(rec.windowId, 'open-url-as-tab-background', url)
  })

  ipcMain.on('newbro-context-menu', (event, payload: unknown) => {
    const tabId = wcIdToTabId.get(event.sender.id)
    if (!tabId) return
    const rec = tabs.get(tabId)
    if (!rec) return
    const win = BrowserWindow.fromId(rec.windowId)
    if (!win || win.isDestroyed()) return

    // Defensive payload unpack — preload sends a plain object but we still
    // gate on the shape to avoid crashing main on a malformed message.
    const p = (typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {})
    const selection = typeof p.selection === 'string' ? p.selection.trim() : ''
    const x = typeof p.x === 'number' ? p.x : 0
    const y = typeof p.y === 'number' ? p.y : 0
    const linkUrl = typeof p.linkUrl === 'string' ? p.linkUrl : null
    const imgUrl = typeof p.imgUrl === 'string' ? p.imgUrl : null

    const wc = rec.view.webContents
    const nav = wc.navigationHistory
    const items: Electron.MenuItemConstructorOptions[] = []

    if (linkUrl) {
      items.push({
        label: 'Open Link in New Tab',
        // Matches Chrome / Firefox: the explicit "open in new tab" menu
        // entry never steals focus from the current page.
        click: () => sendToWindowRenderer(rec.windowId, 'open-url-as-tab-background', linkUrl),
      })
      items.push({
        label: 'Copy Link Address',
        click: () => {
          try { clipboard.writeText(linkUrl) }
          catch (err) { log.warn('context-menu: copy link clipboard write failed', String(err)) }
        },
      })
      items.push({ type: 'separator' })
    }

    if (imgUrl) {
      items.push({
        label: 'Copy Image Address',
        click: () => {
          try { clipboard.writeText(imgUrl) }
          catch (err) { log.warn('context-menu: copy image clipboard write failed', String(err)) }
        },
      })
      items.push({ type: 'separator' })
    }

    if (selection) {
      items.push({
        label: 'Copy',
        click: () => {
          try { clipboard.writeText(selection) } catch (err) {
            log.warn('context-menu: clipboard write failed', String(err))
          }
        },
      })
      items.push({
        label: 'Copy and search',
        click: () => {
          try { clipboard.writeText(selection) }
          catch (err) { log.warn('context-menu: copy-and-search clipboard write failed', String(err)) }
          // Renderer owns the search-engine template; send the raw query.
          win.webContents.send('tab-context-search', selection)
        },
      })
    }

    // Paste is offered unconditionally: editability can't be detected
    // reliably from the click target (web consoles like xterm.js render
    // to a canvas and keep focus on a hidden textarea), and wc.paste()
    // is simply a no-op when nothing editable has focus.
    items.push({
      label: 'Paste',
      click: () => {
        try { wc.paste() }
        catch (err) { log.warn('context-menu: paste failed', String(err)) }
      },
    })
    items.push({ type: 'separator' })

    items.push({
      label: 'Back',
      enabled: nav.canGoBack(),
      click: () => tabGoBack(tabId),
    })
    items.push({
      label: 'Forward',
      enabled: nav.canGoForward(),
      click: () => tabGoForward(tabId),
    })
    items.push({
      label: 'Reload',
      click: () => tabReload(tabId, /* ignoreCache */ false),
    })
    items.push({ type: 'separator' })
    items.push({
      label: 'Inspect',
      // openDevTools first makes inspectElement actually highlight when the
      // panel was previously closed — calling inspectElement alone on a
      // closed devtools is silently a no-op on some Electron builds.
      click: () => {
        try {
          if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' })
          wc.inspectElement(x, y)
        } catch (err) {
          log.warn('context-menu: inspectElement failed', String(err))
        }
      },
    })

    const menu = Menu.buildFromTemplate(items)
    menu.popup({ window: win })
  })
}

/** Toggle DevTools for a specific tab's WebContents. Used by the View menu's
 *  "Page Developer Tools" item — Electron's `role: 'toggleDevTools'` only
 *  reaches the focused webContents, which is almost always the chrome
 *  renderer, so the user couldn't otherwise inspect a real page. */
export function tabToggleDevTools(tabId: string): void {
  const rec = tabs.get(tabId)
  if (!rec) return
  const wc = rec.view.webContents
  try {
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  } catch (err) {
    log.warn('tab-views: toggleDevTools failed', { tabId, err: String(err) })
  }
}

function hashStringToInt(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  // chrome tab ids are positive integers, so map into [1, 2^31).
  return Math.abs(h) || 1
}

/** Look up a tab record by its WebContents identity. Used by the
 *  electron-chrome-extensions integration so chrome.tabs.update /
 *  chrome.tabs.remove can map the library's WebContents argument
 *  back to a tab id we own. Returns null when no matching tab. */
export function getRecordByWebContents(wc: WebContents): { tabId: string; windowId: number } | null {
  for (const rec of tabs.values()) {
    if (rec.view.webContents === wc) {
      return { tabId: rec.tabId, windowId: rec.windowId }
    }
  }
  return null
}

/** chrome.tabs.update active:true bridge — promote the matching tab
 *  to the workspace's active tab. Only called from the library's
 *  selectTab callback path (gated by isLibrarySelectTabSuppressed in
 *  the bridge), so by the time we get here it's an extension-driven
 *  activation we want to honour. */
export function selectTabByWebContents(wc: WebContents): void {
  const rec = getRecordByWebContents(wc)
  if (!rec) return
  if (activeTabByWindow.get(rec.windowId) === rec.tabId) return
  setActiveTab(rec.windowId, rec.tabId)
  // Mirror to the renderer so its sidebar / URL bar / WebviewPanel
  // pick up the activation. The renderer's onActivateTab handler
  // updates the store, which triggers tab:activate IPC back to us —
  // but setActiveTab's prev===tabId early-return makes that round-
  // trip a no-op.
  sendToWindowRenderer(rec.windowId, 'activate-tab', rec.tabId)
}

/** chrome.tabs.remove bridge — close the matching tab. */
export function destroyTabByWebContents(wc: WebContents): void {
  const rec = getRecordByWebContents(wc)
  if (!rec) return
  destroyTab(rec.tabId)
  sendToWindowRenderer(rec.windowId, 'extension-closed-tab', rec.tabId)
}

/** Pending chrome.tabs.create requests waiting for the renderer's
 *  round-trip. Keyed by URL — the next tab:create with matching URL
 *  resolves the promise. Brittle if two extensions request the same
 *  URL simultaneously, but that's vanishingly rare in practice. */
const pendingExtTabs = new Map<string, (wc: WebContents) => void>()

/** chrome.tabs.create bridge — open a new tab in the given window via
 *  the renderer's regular new-tab flow, then resolve with its
 *  WebContents once it's created in main. The library uses the
 *  WebContents identity to wire chrome.tabs events. */
export async function createTabForExtension(
  win: BrowserWindow,
  _partition: string,
  url: string,
  _active: boolean,
): Promise<WebContents> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingExtTabs.delete(url)
      reject(new Error('createTabForExtension: timeout'))
    }, 5000)
    pendingExtTabs.set(url, (wc) => {
      clearTimeout(timer)
      pendingExtTabs.delete(url)
      resolve(wc)
    })
    sendToWindowRenderer(win.id, 'open-url-as-tab', url)
  })
}

/** Used by the newbro-ipc:// protocol handler in main/index.ts so the
 *  SW shim's chrome.tabs.query polyfill can return the workspace's
 *  actual active tab. The popup-side handler that does the same job
 *  lives in this file's installTabPreloadListeners as
 *  'newbro-ext-active-tab-info' ipcMain.handle — same shape, fed by
 *  the IPC sender's window. The protocol path can't read the sender,
 *  so the caller passes the windowId explicitly. */
export function getActiveTabInfoForWindow(windowId: number): {
  id: number
  url: string
  title: string
  active: boolean
  highlighted: boolean
  pinned: boolean
  windowId: number
  index: number
  status: string
  incognito: boolean
  favIconUrl: string
} | null {
  const activeTabId = activeTabByWindow.get(windowId)
  if (!activeTabId) return null
  const rec = tabs.get(activeTabId)
  if (!rec) return null
  let url = ''
  let title = ''
  try { url = rec.view.webContents.getURL() }
  catch (err) { log.warn('getActiveTabInfoForWindow: getURL threw', { tabId: rec.tabId, err: String(err) }) }
  try { title = rec.view.webContents.getTitle() }
  catch (err) { log.warn('getActiveTabInfoForWindow: getTitle threw', { tabId: rec.tabId, err: String(err) }) }
  return {
    id: hashStringToInt(rec.tabId),
    url,
    title,
    active: true,
    highlighted: true,
    pinned: false,
    windowId,
    index: 0,
    status: 'complete',
    incognito: false,
    favIconUrl: '',
  }
}

// Silence unused-app warning on some bundlers — `app` is used indirectly
// via session.fromPartition / BrowserWindow.fromId, both of which need
// the app to be ready; leaving the import ensures the main module order
// is preserved.
void app
