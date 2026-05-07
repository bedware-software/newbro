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

/** Per-tab state machine for the two-finger horizontal swipe gesture.
 *  Lives in main so detection is fully independent of page content —
 *  see wireGestureDetection() for the rationale. */
interface GestureState {
  /** Touch session is active (between gestureScrollBegin and end). */
  touchActive: boolean
  /** We've decided this is a horizontal swipe and a direction is locked. */
  engaged: boolean
  /** Direction once engaged. */
  direction: 'back' | 'forward' | null
  /** Accumulated outward position (0…∞). 0 = overlay hidden,
   *  TRIGGER_PX = armed, past TRIGGER_PX commits eagerly. */
  position: number
  /** Already fired the navigation in this session — ignore further
   *  wheel input until the touch ends. */
  committed: boolean
  /** Last navigation history bounds so we don't engage a direction
   *  the tab can't actually go. */
  canGoBack: boolean
  canGoForward: boolean
}

interface TabRecord {
  tabId: string
  windowId: number
  partition: string
  view: WebContentsView
  activated: boolean
  /** The last bounds assigned by the renderer. Cached so we can
   *  restore them when re-activating after hide (width=0 trick). */
  lastBounds: TabBounds
  gesture: GestureState
}

const WEBVIEW_STEALTH_PRELOAD = join(__dirname, '../preload/webview-stealth.js')

const HIDDEN_BOUNDS: TabBounds = { x: 0, y: 0, width: 0, height: 0 }

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

  wireGestureDetection(rec)

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
  wc.on('close', () => {
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

  // Push the navigation history bounds onto the gesture state so the
  // swipe refuses to engage in a direction we can't actually go.
  const emitNavState = (): void => {
    if (wc.isDestroyed()) return
    const nav = wc.navigationHistory
    rec.gesture.canGoBack = nav.canGoBack()
    rec.gesture.canGoForward = nav.canGoForward()
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
  })
  wc.on('did-navigate', (_e, url) => {
    emit({ type: 'did-navigate', tabId: rec.tabId, url })
    emitNavState()
  })
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    emit({ type: 'did-navigate-in-page', tabId: rec.tabId, url, isMainFrame })
    emitNavState()
  })
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

    log.info('tab window-open: routing as new tab', { tabId: rec.tabId, url, disposition })
    sendToWindowRenderer(rec.windowId, 'open-url-as-tab', url)
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
      sendToWindowRenderer(rec.windowId, 'open-url-as-tab', d.url)
      return { action: 'deny' }
    })
    childWindow.once('closed', () => {
      log.info('tab popup closed', { tabId: rec.tabId, childId: childWindow.id })
    })
  })

  // Close any open extension popup when the user clicks the page. Second
  // input-event listener on this tab — wireGestureDetection() owns the
  // first one. We only react to the start of a click; the icon button's
  // own onClick handler takes care of the "click the icon while popup is
  // open" case.
  wc.on('input-event', (_e, input) => {
    if (input.type !== 'mouseDown') return
    if (extensionPopupByWindow.has(rec.windowId)) {
      closeExtensionPopup(rec.windowId)
    }
  })
}

// ── Two-finger horizontal swipe → back/forward ─────────────────────────
// All gesture state and detection lives here, in main, rather than in a
// page-level wheel listener inside the preload. The preload-based version
// broke on sites that aggressively claim wheel events (Confluence, Jira,
// GitLab, anything with a custom virtual-scroll app shell): those pages
// either preventDefault() the wheel before our isolated-world handler
// runs, or have non-document scroll containers that make the
// document.scrollingElement.scrollLeft "overscroll edge" check meaningless.
//
// `webContents.on('input-event')` is observed BEFORE the event reaches
// the page renderer, so site JS cannot suppress or steer it. The preload
// is now a thin overlay-rendering surface driven by IPC from here.
//
// Engagement rules (intentionally site-content-independent):
//   1. The wheel must come from a real touch (gestureScrollBegin seen,
//      gestureScrollEnd / gestureFlingStart not yet). Mouse wheels never
//      synthesize gestureScrollBegin, so they can't engage.
//   2. The first few pixels must be dominantly horizontal (dx vs dy
//      ratio); rejects vertical scrolls with tiny horizontal jitter.
//   3. Modifier keys (ctrl/cmd/alt/shift) disqualify — those are
//      page-zoom or alternate-tool gestures.
//   4. The chosen direction must be one the tab's history can actually
//      go in — bounds pushed from main on every navigation.
//
// Once engaged, position accumulates outward; pulling back to 0
// disengages and lets a fresh overscroll pick a different direction
// inside the same touch session. Past TRIGGER_PX, we commit eagerly
// (gestureScrollEnd is delayed by Chromium's momentum-decay wait, so we
// can't reliably commit on touch-up). After commit, every remaining
// wheel event in the session is preventDefault()-ed so neither the page
// nor Chromium's rubber-band animation reacts to the trailing momentum.

const GESTURE_TRIGGER_PX = 100  // overscroll distance to fire navigation
const GESTURE_ENGAGE_PX = 6     // minimum cumulative dx before we engage

function makeInitialGestureState(): GestureState {
  return {
    touchActive: false,
    engaged: false,
    direction: null,
    position: 0,
    committed: false,
    canGoBack: false,
    canGoForward: false,
  }
}

function resetGestureSession(rec: TabRecord, sendUpdate = true): void {
  rec.gesture.engaged = false
  rec.gesture.direction = null
  rec.gesture.position = 0
  if (sendUpdate) sendGestureUpdate(rec, false)
}

function sendGestureUpdate(rec: TabRecord, visible: boolean): void {
  const wc = rec.view.webContents
  if (wc.isDestroyed()) return
  if (!visible) {
    wc.send('newbro-gesture-update', { visible: false })
    return
  }
  if (!rec.gesture.direction) return
  wc.send('newbro-gesture-update', {
    visible: true,
    direction: rec.gesture.direction,
    progress: Math.min(1, rec.gesture.position / GESTURE_TRIGGER_PX),
    armed: rec.gesture.position >= GESTURE_TRIGGER_PX,
  })
}

function wireGestureDetection(rec: TabRecord): void {
  const wc: WebContents = rec.view.webContents

  wc.on('input-event', (event, input) => {
    const g = rec.gesture

    if (input.type === 'gestureScrollBegin') {
      g.touchActive = true
      g.committed = false
      resetGestureSession(rec, false)
      return
    }

    if (input.type === 'gestureScrollEnd' || input.type === 'gestureFlingStart') {
      // End-of-touch hint. Chromium delays gestureScrollEnd until momentum
      // decays (~1s on macOS), so we don't rely on it for commit timing —
      // we commit eagerly when the threshold is crossed below. This is
      // just the "tear down anything still showing" cleanup. We leave
      // `committed` as-is so post-commit momentum wheel events keep being
      // suppressed until the next gestureScrollBegin clears it.
      g.touchActive = false
      resetGestureSession(rec, true)
      return
    }

    if (input.type !== 'mouseWheel') return

    // Cast for the wheel-specific fields. Electron's listener signature
    // surfaces only the base InputEvent; the doc-level structure for
    // mouseWheel events carries deltaX/deltaY/hasPreciseScrollingDeltas.
    const wheel = input as unknown as {
      type: 'mouseWheel'
      deltaX?: number
      deltaY?: number
      hasPreciseScrollingDeltas?: boolean
    }

    // Already committed in this gesture — keep eating wheels (including
    // any post-touch momentum events) so the page doesn't bounce and our
    // overlay doesn't reappear. Cleared on the next gestureScrollBegin.
    if (g.committed) {
      event.preventDefault()
      return
    }

    // Mouse wheels (ticked, no precise deltas) and any wheel outside a
    // touch session can never trigger this gesture.
    if (!g.touchActive) return
    if (wheel.hasPreciseScrollingDeltas === false) return

    // Modifier keys hijack the wheel for zoom / alt-tools — never claim
    // those.
    const mods = input.modifiers ?? []
    if (mods.some((m) => m === 'control' || m === 'ctrl' || m === 'meta' || m === 'cmd' || m === 'command' || m === 'alt' || m === 'shift')) {
      if (g.engaged) resetGestureSession(rec, true)
      return
    }

    const dx = wheel.deltaX ?? 0
    const dy = wheel.deltaY ?? 0
    if (Math.abs(dx) < 1) return

    // Reject mostly-vertical gestures: vertical scrolling with tiny
    // horizontal jitter shouldn't engage.
    if (!g.engaged && Math.abs(dx) < Math.abs(dy) * 1.5) return

    if (!g.engaged) {
      // dx<0 = swiping right-to-left (content moves left) = "back" gesture.
      // dx>0 = swiping left-to-right = "forward" gesture.
      const dir: 'back' | 'forward' = dx < 0 ? 'back' : 'forward'
      if (dir === 'back' && !g.canGoBack) return
      if (dir === 'forward' && !g.canGoForward) return
      g.direction = dir
      g.position = 0
      g.engaged = true
    }

    // Suppress page delivery for engaged-gesture wheels so Chromium's
    // own rubber-band animation and any page-level scroll listener stay
    // quiet while our overlay tracks the finger.
    event.preventDefault()

    // 1:1 outward-position tracking. Reversing the swipe (pulling back)
    // shrinks position; once it hits 0 we disengage so the next overscroll
    // can pick a (possibly different) direction within the same touch.
    const delta = g.direction === 'back' ? -dx : dx
    g.position += delta
    if (g.position <= 0) {
      g.position = 0
      g.engaged = false
      g.direction = null
      sendGestureUpdate(rec, false)
      return
    }

    if (g.position < GESTURE_ENGAGE_PX) {
      sendGestureUpdate(rec, false)
      return
    }

    sendGestureUpdate(rec, true)

    // Eager commit: the moment the user crosses the trigger threshold,
    // fire the navigation. We can't observe true finger-lift in time
    // (gestureScrollEnd is delayed by Chromium momentum), so the
    // threshold itself is the commit point. Pull-back-to-cancel still
    // works for anything below the threshold.
    if (g.position >= GESTURE_TRIGGER_PX && g.direction) {
      const dir = g.direction
      g.committed = true
      g.engaged = false
      g.direction = null
      sendGestureUpdate(rec, false)
      if (dir === 'back') tabGoBack(rec.tabId)
      else tabGoForward(rec.tabId)
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
    gesture: makeInitialGestureState(),
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
  const extId = extractExtensionIdFromExtUrl(url)
  if (extId) {
    // Extension is supposed to already be loaded into this partition
    // (setupPartitionSession → loadEnabledExtensionsInto), but on a fresh
    // partition the load is fire-and-forget. Awaiting here closes the
    // race with the loadURL below.
    await ensureExtensionInSession(rec.view.webContents.session, extId).catch(() => false)
  }
  rec.view.webContents.loadURL(url).catch((err) => {
    log.warn('tab-views: loadURL failed', { tabId: rec.tabId, url, err: String(err) })
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

function setActiveTab(windowId: number, tabId: string): void {
  const prev = activeTabByWindow.get(windowId)
  if (prev === tabId) return // already active — no need to re-bound or notify
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
  void startTabNavigation(rec, url)
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
  view.setBackgroundColor('#ffffff')
  ownerWindow.contentView.addChildView(view)

  // Tear down on owner-window blur. Listener is stored on the record so
  // closeExtensionPopup can remove it — without this, every open/close
  // cycle leaks a listener and Node hits MaxListenersExceeded after 11.
  const onBlur = (): void => { closeExtensionPopup(windowId) }
  ownerWindow.on('blur', onBlur)

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
    try { view.webContents.openDevTools({ mode: 'detach' }) } catch { /* ignore */ }
  }
  // Also pipe in-popup console messages into the main log
  // unconditionally — even without devtools open, we'll see what
  // the popup page logs / warns / errors. Cheap, narrow signal that's
  // saved us hours of triage on the SW side and is just as useful
  // for popup-side white-screen bugs.
  view.webContents.on('console-message', (e) => {
    const detail = e as unknown as { level?: string; message?: string; sourceId?: string; line?: number }
    log.info('extension popup console', {
      extensionId,
      level: detail.level,
      sourceId: detail.sourceId,
      line: detail.line,
      msg: detail.message,
    })
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
    try { url = rec.view.webContents.getURL() } catch { /* ignore */ }
    try { title = rec.view.webContents.getTitle() } catch { /* ignore */ }
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
    sendToWindowRenderer(rec.windowId, 'open-url-as-tab', url)
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
        click: () => sendToWindowRenderer(rec.windowId, 'open-url-as-tab', linkUrl),
      })
      items.push({
        label: 'Copy Link Address',
        click: () => {
          try { clipboard.writeText(linkUrl) } catch { /* ignore */ }
        },
      })
      items.push({ type: 'separator' })
    }

    if (imgUrl) {
      items.push({
        label: 'Copy Image Address',
        click: () => {
          try { clipboard.writeText(imgUrl) } catch { /* ignore */ }
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
          try { clipboard.writeText(selection) } catch { /* ignore */ }
          // Renderer owns the search-engine template; send the raw query.
          win.webContents.send('tab-context-search', selection)
        },
      })
      items.push({ type: 'separator' })
    }

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
  try { url = rec.view.webContents.getURL() } catch { /* ignore */ }
  try { title = rec.view.webContents.getTitle() } catch { /* ignore */ }
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
