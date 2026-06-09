import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAppStore, consumeNewTabUrlFocus, consumeEagerLoad } from '../store/app-store'
import { log } from '../lib/log'
import { focusAndSelectUrlBar } from '../lib/focus-url-bar'
import { WifiOff, SearchX, Unplug, CloudOff, RotateCw, ShieldAlert, Mic, Camera, MapPin, Bell, Clipboard, Music, X, type LucideIcon } from 'lucide-react'
import { describePermissionKinds, type PermissionKind } from '../lib/permissions'

// Tab rendering lives in the main process now, as a WebContentsView per tab
// attached to the window's root contentView. This component is a thin layout
// shell: it measures its own bounds and reports them to main so the active
// tab's WebContentsView tracks the viewport. All tab lifecycle (create,
// activate, destroy, navigate) and all tab events (navigation, title,
// favicon, load errors, cert errors) flow through IPC.
//
// Why: Electron's session.loadExtension() only injects content scripts into
// BrowserWindow / WebContentsView, never into <webview> tags. Hosting tabs
// in main is the minimum change required to make Chrome extensions actually
// run against page content. See src/main/tab-views.ts.

interface LoadError {
  tabId: string
  url: string
  code: number
  description: string
}

interface CertError {
  tabId: string
  url: string
  code: number
  /** Electron's errorDescription, e.g. "ERR_CERT_AUTHORITY_INVALID" */
  description: string
}

/** A pending permission prompt routed from main. Shown as an infobar over the
 *  requesting tab; the user's click is reported back via respondPermission. */
interface PermissionRequest {
  requestId: string
  origin: string
  kinds: PermissionKind[]
  tabId: string
}

type TabEvent =
  | { type: 'did-start-loading'; tabId: string }
  | { type: 'did-stop-loading'; tabId: string; url: string }
  | { type: 'did-navigate'; tabId: string; url: string }
  | { type: 'did-navigate-in-page'; tabId: string; url: string; isMainFrame: boolean }
  | { type: 'page-title-updated'; tabId: string; title: string }
  | { type: 'page-favicon-updated'; tabId: string; favicons: string[] }
  | { type: 'did-fail-load'; tabId: string; url: string; errorCode: number; errorDescription: string; isMainFrame: boolean }
  | { type: 'dom-ready'; tabId: string; url: string }
  | { type: 'did-finish-load'; tabId: string; url: string }

function resolveTheme(): 'dark' | 'light' {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark') return 'dark'
  if (attr === 'light') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function buildScrollbarCss(): string {
  const isDark = resolveTheme() === 'dark'
  const card = isDark ? 'oklch(0.17 0 0)' : 'oklch(0.955 0 0)'
  const border = isDark ? 'oklch(0.30 0 0)' : 'oklch(0.88 0 0)'
  return `html { scrollbar-width: thin; scrollbar-color: ${border} ${card}; }`
}

/** Re-theme the scrollbar inside each tab's document. With <webview> we
 *  called executeJavaScript on the DOM element; now we route through IPC
 *  to the guest webContents in main.
 *
 *  Disabled for now: on macOS this injection makes Sheets' cell-iframe
 *  scrollbars (and other apps inheriting the document-level
 *  `scrollbar-color`) vanish at end-of-load — the inherited near-white-
 *  on-white colors blend into the page background. macOS already renders
 *  guest scrollbars with the OS-native overlay style, so the injection
 *  buys us nothing there.
 *
 *  Windows / Linux are likely a different story: their default Chromium
 *  scrollbar is a chunky light-gray bar that clashes with a dark-themed
 *  app, which is why this code was added. Re-enable selectively (e.g.
 *  `if (process.platform !== 'darwin')` via a preload-exposed flag, or
 *  a higher-contrast palette) when verifying on those platforms. The
 *  body is left in place so the fix is one paste away. */
function applyScrollbarStyle(tabId: string): void {
  void tabId
  return
  // const css = buildScrollbarCss()
  // const js = `(() => {
  //   let s = document.getElementById('__newbro_scrollbar_style__');
  //   if (!s) {
  //     s = document.createElement('style');
  //     s.id = '__newbro_scrollbar_style__';
  //     (document.head || document.documentElement).appendChild(s);
  //   }
  //   s.textContent = ${JSON.stringify(css)};
  // })()`
  // window.electronAPI.tabExecuteJS?.(tabId, js)
}

/** Focus + select the toolbar URL bar. Used when the user prefers the
 *  URL input to have focus after opening a new tab. */

/** Map a Chromium net-error code to a themed, human-readable explanation.
 *  Mirrors the buckets Chrome's own error page uses (offline / not-found /
 *  unreachable / timed-out) so the copy matches the actual failure instead
 *  of always claiming the site "took too long to respond". */
function describeLoadError(
  code: number,
  host: string
): { Icon: LucideIcon; title: string; message: ReactNode; suggestions: string[] } {
  const site = <span className="font-medium text-foreground">{host || 'This site'}</span>
  switch (code) {
    case -106: // ERR_INTERNET_DISCONNECTED
    case -21: // ERR_NETWORK_CHANGED
      return {
        Icon: WifiOff,
        title: "You're offline",
        message: <>Newbro can&apos;t load this page because your device isn&apos;t connected to the internet.</>,
        suggestions: ['Checking the network cables, modem, and router', 'Reconnecting to Wi-Fi'],
      }
    case -105: // ERR_NAME_NOT_RESOLVED
    case -137: // ERR_NAME_RESOLUTION_FAILED
    case -300: // ERR_INVALID_URL
      return {
        Icon: SearchX,
        title: "This site can't be found",
        message: <>{site}&apos;s server IP address could not be found.</>,
        suggestions: ['Checking the address for typos', 'Running a network diagnostic'],
      }
    case -102: // ERR_CONNECTION_REFUSED
      return {
        Icon: Unplug,
        title: "This site can't be reached",
        message: <>{site} refused to connect.</>,
        suggestions: ['Checking the connection', 'Checking the proxy and the firewall'],
      }
    case -101: // ERR_CONNECTION_RESET
    case -104: // ERR_CONNECTION_FAILED
    case -109: // ERR_ADDRESS_UNREACHABLE
    case -324: // ERR_EMPTY_RESPONSE
      return {
        Icon: Unplug,
        title: "This site can't be reached",
        message: <>The connection to {site} was interrupted.</>,
        suggestions: ['Checking the connection', 'Checking the proxy and the firewall'],
      }
    default: // -7 ERR_TIMED_OUT, -118 ERR_CONNECTION_TIMED_OUT, and the rest
      return {
        Icon: CloudOff,
        title: "Hmmm… can't reach this page",
        message: <>{site} took too long to respond.</>,
        suggestions: ['Checking the connection', 'Checking the proxy and the firewall'],
      }
  }
}

export function WebviewPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [errors, setErrors] = useState<Map<string, LoadError>>(new Map())
  const [certErrors, setCertErrors] = useState<Map<string, CertError>>(new Map())
  // Pending permission prompts (mic/camera/location/…). One infobar shows at
  // a time, for whichever pending request belongs to the active tab.
  const [permPrompts, setPermPrompts] = useState<PermissionRequest[]>([])
  // Set when the OS (macOS TCC) blocks media despite an in-app grant — shows a
  // bar with an "Open System Settings" action.
  const [osBlocked, setOsBlocked] = useState<{ tabId: string; kinds: PermissionKind[] } | null>(null)
  // Tabs we've already asked main to create, so we can diff against the store
  // and avoid duplicate create/destroy calls.
  const createdTabsRef = useRef<Set<string>>(new Set())
  // Tabs that have been activated at least once (main also tracks this, but
  // the renderer tracks a parallel bit for the "focus URL on new tab" flag).
  const activatedTabsRef = useRef<Set<string>>(new Set())

  const activeTabId = useAppStore((s) => s.activeTabId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const profiles = useAppStore((s) => s.profiles)
  const activeProfileId = useAppStore((s) => s.activeProfileId)

  // Collect tabs from the active workspace. We only host one workspace per
  // window; tabs from other workspaces are not reified as WebContentsViews.
  const getWorkspaceTabs = (): { id: string; url: string; partition: string }[] => {
    const tabs: { id: string; url: string; partition: string }[] = []
    const profile = profiles.find((p) => p.id === activeProfileId)
    if (!profile) return tabs
    const workspace = profile.workspaces.find((w) => w.id === activeWorkspaceId)
    if (!workspace) return tabs
    for (const t of workspace.tabs || []) {
      tabs.push({ id: t.id, url: t.url, partition: profile.partition })
    }
    for (const g of workspace.tabGroups) {
      for (const t of g.tabs) {
        tabs.push({ id: t.id, url: t.url, partition: profile.partition })
      }
    }
    return tabs
  }

  // Reconcile tabs with main. Create new ones, destroy removed ones,
  // activate the current one. Also trigger initial session setup per
  // partition (the tab:create handler does this in main, but keeping the
  // call preserves the old race-closing behavior when the partition is
  // used for other reasons — e.g. future devtools workflows).
  useEffect(() => {
    const currentTabs = getWorkspaceTabs()
    const currentTabIds = new Set(currentTabs.map((t) => t.id))

    // Destroy tabs no longer in scope
    for (const id of Array.from(createdTabsRef.current)) {
      if (!currentTabIds.has(id)) {
        window.electronAPI.tabDestroy?.(id)
        createdTabsRef.current.delete(id)
        activatedTabsRef.current.delete(id)
      }
    }

    // Drop pending permission prompts whose tab no longer exists (main also
    // denies these when the tab's webContents is destroyed). Return the prior
    // array unchanged when nothing was pruned so we don't force a re-render.
    setPermPrompts((prev) => {
      const next = prev.filter((p) => currentTabIds.has(p.tabId))
      return next.length === prev.length ? prev : next
    })
    setOsBlocked((prev) => (prev && !currentTabIds.has(prev.tabId) ? null : prev))

    // Create newly-seen tabs (lazy: only the active one eager-loads,
    // plus any tab the store has flagged for eager-load — currently
    // user-opened background tabs).
    let focusUrlBarForNewTab = false
    for (const tab of currentTabs) {
      if (!createdTabsRef.current.has(tab.id)) {
        const isActiveNow = tab.id === activeTabId
        const eagerLoad = consumeEagerLoad(tab.id)
        // "Focus URL on new tab": consume the single-shot flag now so we
        // can (a) tell main to keep OS keyboard focus on the renderer
        // instead of handing it to the page, and (b) focus the URL bar
        // ourselves right after activation below.
        const wantsUrlFocus = isActiveNow && consumeNewTabUrlFocus(tab.id)
        if (wantsUrlFocus) focusUrlBarForNewTab = true
        window.electronAPI.setupSession?.(tab.partition)
        window.electronAPI.tabCreate?.(tab.id, tab.partition, tab.url, isActiveNow, eagerLoad, wantsUrlFocus)
        createdTabsRef.current.add(tab.id)
        if (isActiveNow) activatedTabsRef.current.add(tab.id)
      }
    }

    // Activate the current tab (this also lazy-loads it if it's the first time)
    if (activeTabId && createdTabsRef.current.has(activeTabId)) {
      const tab = currentTabs.find((t) => t.id === activeTabId)
      const url = tab?.url || 'about:blank'
      window.electronAPI.tabActivate?.(activeTabId, url)
      activatedTabsRef.current.add(activeTabId)
      // Focus the URL bar immediately for a brand-new "focus URL" tab,
      // rather than waiting for did-finish-load. Because we asked main to
      // keep OS focus on the renderer (focusUrlBar passed to tabCreate),
      // the page never steals focus as it settles, so this focus sticks
      // and whatever the user types is never clobbered by the load.
      if (focusUrlBarForNewTab) {
        focusAndSelectUrlBar()
      }
    }
  }, [profiles, activeTabId, activeWorkspaceId, activeProfileId])

  // Track the WebviewPanel's bounds and forward them to main on mount,
  // on window resize, and any time the container's ClientRect changes
  // (sidebar toggle, detached popups, zoom level changes, etc.).
  //
  // Also listens for 'newbro-tab-hide' / 'newbro-tab-show' CustomEvents
  // dispatched by the Sidebar during drag/resize — with tabs hosted as
  // WebContentsViews (which compose *on top of* the renderer DOM), the
  // sidebar's pointermove handler can't run while the cursor is over a
  // visible tab. Hiding the tab bounds during drag routes mouse events
  // back to the renderer; the real bounds are re-applied on 'show'.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let frame = 0
    let suppressed = false

    const report = (force = false): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!el.isConnected) return
        if (suppressed && !force) return
        const rect = el.getBoundingClientRect()
        window.electronAPI.tabSetBounds?.({
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.max(0, Math.round(rect.width)),
          height: Math.max(0, Math.round(rect.height)),
        })
      })
    }

    const hide = (): void => {
      suppressed = true
      window.electronAPI.tabSetBounds?.({ x: 0, y: 0, width: 0, height: 0 })
    }
    const show = (): void => {
      suppressed = false
      report()
    }

    const onWindowResize = (): void => report()
    report()
    const ro = new ResizeObserver(() => report())
    ro.observe(el)
    window.addEventListener('resize', onWindowResize)
    window.addEventListener('newbro-tab-hide', hide)
    window.addEventListener('newbro-tab-show', show)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWindowResize)
      window.removeEventListener('newbro-tab-hide', hide)
      window.removeEventListener('newbro-tab-show', show)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  // Receive tab lifecycle events from main and drive the store + error UI
  useEffect(() => {
    const cleanup = window.electronAPI.onTabEvent?.((raw) => {
      const evt = raw as TabEvent
      switch (evt.type) {
        case 'did-start-loading': {
          setErrors((prev) => {
            if (!prev.has(evt.tabId)) return prev
            const m = new Map(prev); m.delete(evt.tabId); return m
          })
          setCertErrors((prev) => {
            if (!prev.has(evt.tabId)) return prev
            const m = new Map(prev); m.delete(evt.tabId); return m
          })
          break
        }
        case 'did-navigate': {
          if (!evt.url || evt.url.startsWith('data:') || evt.url === 'about:blank') break
          useAppStore.getState().updateTabUrl(evt.tabId, evt.url)
          break
        }
        case 'did-navigate-in-page': {
          if (!evt.isMainFrame) break
          if (!evt.url || evt.url.startsWith('data:') || evt.url === 'about:blank') break
          useAppStore.getState().updateTabUrl(evt.tabId, evt.url)
          break
        }
        case 'page-title-updated': {
          const title = (evt.title || '').trim()
          if (!title) break
          useAppStore.getState().updateTabTitle(evt.tabId, title)
          break
        }
        case 'page-favicon-updated': {
          if (evt.favicons && evt.favicons.length > 0) {
            useAppStore.getState().updateTabFavicon(evt.tabId, evt.favicons[0])
          }
          break
        }
        case 'did-fail-load': {
          if (evt.errorCode === -3 || evt.errorCode === -100 || !evt.isMainFrame) break
          const url = evt.url || ''
          const isCert = (evt.errorCode >= -219 && evt.errorCode <= -200) || evt.errorCode === -501
          if (isCert) {
            log.warn('cert error', { url, code: evt.errorCode, desc: evt.errorDescription })
            setCertErrors((prev) =>
              new Map(prev).set(evt.tabId, { tabId: evt.tabId, url, code: evt.errorCode, description: evt.errorDescription })
            )
          } else {
            log.warn('page load failed', { url, code: evt.errorCode, desc: evt.errorDescription })
            setErrors((prev) =>
              new Map(prev).set(evt.tabId, { tabId: evt.tabId, url, code: evt.errorCode, description: evt.errorDescription })
            )
          }
          break
        }
        case 'dom-ready': {
          applyScrollbarStyle(evt.tabId)
          break
        }
        case 'did-finish-load': {
          // "Focus URL on new tab" used to be deferred here, because main
          // handed OS focus to the page on activation and an early focus
          // call got clobbered as the page settled. Main now keeps focus
          // on the renderer for "focus URL" tabs (see createTab), so the
          // focus happens immediately in the reconcile effect above and
          // nothing is needed here.
          break
        }
        default:
          break
      }
    })
    return cleanup
  }, [])

  // Receive permission prompts from main. Queue them; the active-tab one is
  // rendered as an infobar. De-dupe by requestId so a re-render can't stack
  // duplicates.
  useEffect(() => {
    const cleanup = window.electronAPI.onPermissionRequest?.((payload) => {
      setPermPrompts((prev) =>
        prev.some((p) => p.requestId === payload.requestId) ? prev : [...prev, payload]
      )
    })
    return cleanup
  }, [])

  // OS-level media block (macOS denied the app in System Settings). Replace any
  // prior notice with the latest.
  useEffect(() => {
    const cleanup = window.electronAPI.onPermissionOsBlocked?.((payload) => {
      setOsBlocked({ tabId: payload.tabId, kinds: payload.kinds })
    })
    return cleanup
  }, [])

  // Re-apply the themed scrollbar style to every live tab when the app theme
  // changes (data-theme attribute on <html>) or when the OS colour scheme
  // flips while the app is set to "system".
  useEffect(() => {
    const reapply = () => {
      for (const id of createdTabsRef.current) applyScrollbarStyle(id)
    }
    const observer = new MutationObserver(reapply)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', reapply)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', reapply)
    }
  }, [])

  const activeError = activeTabId ? errors.get(activeTabId) ?? null : null
  const activeCertError = activeTabId ? certErrors.get(activeTabId) ?? null : null
  const showCertError = activeCertError !== null
  const showError = activeError !== null && !showCertError
  // Show the prompt belonging to the active tab (requests almost always come
  // from the focused page). Others stay queued until their tab is foregrounded.
  const activePrompt = activeTabId
    ? permPrompts.find((p) => p.tabId === activeTabId) ?? null
    : null
  const activeOsBlocked = osBlocked && osBlocked.tabId === activeTabId ? osBlocked : null

  const handlePermissionDecision = (
    req: PermissionRequest,
    decision: 'allow' | 'block',
    remember: boolean,
  ): void => {
    window.electronAPI.respondPermission?.(req.requestId, decision, remember)
    setPermPrompts((prev) => prev.filter((p) => p.requestId !== req.requestId))
  }

  // Hide the active tab's WebContentsView while an error overlay is up.
  // The native view composites above the renderer DOM and would otherwise
  // eat all clicks (Refresh button, text selection) even when the overlay
  // is the only thing the user can see. Same trick the sidebar drag uses.
  //
  // Also pull OS keyboard focus back to the parent webContents. Without
  // this, focus stays parked on the failed tab's (now hidden) WebContentsView;
  // its before-input-event still gets the key but the interceptor's
  // shortcut IPC has nowhere useful to land before the user clicks
  // somewhere. Routing focus to the renderer lets the main-webContents
  // interceptor run, so Cmd+T / Cmd+1…9 / Cmd+W keep working while the
  // error overlay is visible.
  useEffect(() => {
    if (showError || showCertError) {
      window.dispatchEvent(new CustomEvent('newbro-tab-hide'))
      window.electronAPI.focusWindowRenderer?.()
      return () => { window.dispatchEvent(new CustomEvent('newbro-tab-show')) }
    }
    return
  }, [showError, showCertError])

  const failedHost = (() => {
    if (!activeError?.url) return ''
    try { return new URL(activeError.url).hostname } catch { return activeError.url }
  })()

  const errorInfo = activeError ? describeLoadError(activeError.code, failedHost) : null

  const handleRetry = (): void => {
    if (!activeError) return
    setErrors((prev) => { const m = new Map(prev); m.delete(activeError.tabId); return m })
    const retryUrl = activeError.url || ''
    if (retryUrl) {
      window.electronAPI.tabNavigate?.(activeError.tabId, retryUrl)
    } else {
      window.electronAPI.tabReload?.(activeError.tabId, true)
    }
  }

  const handleCertContinue = async (err: CertError): Promise<void> => {
    try { await window.electronAPI.bypassCertForUrl(err.url) }
    catch (ipcErr) { console.warn('WebviewPanel: bypassCertForUrl IPC failed', { url: err.url, err: String(ipcErr) }) }
    useAppStore.getState().markOriginCertBypassed(err.url)
    setCertErrors((prev) => { const m = new Map(prev); m.delete(err.tabId); return m })
    if (err.url) window.electronAPI.tabNavigate?.(err.tabId, err.url)
  }

  const handleCertBack = (err: CertError): void => {
    setCertErrors((prev) => { const m = new Map(prev); m.delete(err.tabId); return m })
    // Best-effort: go back; if there's no history, route to about:blank.
    window.electronAPI.tabGoBack?.(err.tabId)
    useAppStore.getState().updateTabUrl(err.tabId, 'about:blank')
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {/* Permission prompt sits ABOVE the tab-view placeholder in normal flow,
          so it shrinks the placeholder's rect and the ResizeObserver pushes
          the WebContentsView down — keeping the bar visible (the native view
          composites over any renderer DOM that overlaps it). */}
      {activePrompt && (
        <PermissionInfobar
          key={activePrompt.requestId}
          request={activePrompt}
          onDecide={(decision, remember) => handlePermissionDecision(activePrompt, decision, remember)}
        />
      )}
      {activeOsBlocked && (
        <OsBlockedInfobar
          kinds={activeOsBlocked.kinds}
          onOpenSettings={(kind) => { window.electronAPI.openOsPermissionSettings?.(kind) }}
          onDismiss={() => setOsBlocked(null)}
        />
      )}
      {/* Transparent placeholder whose rect defines where main paints the
          active tab's WebContentsView. Must remain empty — any child DOM
          here would overlap the tab view in unpredictable ways. */}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />

      {showError && activeError && errorInfo && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background text-foreground">
          <div className="w-full max-w-[440px] px-8">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <errorInfo.Icon size={26} strokeWidth={1.75} />
            </div>
            <h2 className="mb-2 text-2xl font-semibold tracking-tight">{errorInfo.title}</h2>
            <p className="mb-6 text-sm leading-relaxed text-muted-foreground">{errorInfo.message}</p>
            <p className="mb-2 text-xs font-medium text-foreground">Try:</p>
            <ul className="mb-7 space-y-1.5">
              {errorInfo.suggestions.map((s) => (
                <li key={s} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-3">
              <button
                onClick={handleRetry}
                className="flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                <RotateCw size={15} />
                Reload
              </button>
              <span className="font-mono text-xs text-muted-foreground">
                {activeError.description} ({activeError.code})
              </span>
            </div>
          </div>
        </div>
      )}

      {showCertError && activeCertError && (
        <CertWarningOverlay
          url={activeCertError.url}
          code={activeCertError.description || `Error ${activeCertError.code}`}
          onBack={() => handleCertBack(activeCertError)}
          onContinue={() => handleCertContinue(activeCertError)}
        />
      )}
    </div>
  )
}

function CertWarningOverlay({
  url,
  code,
  onBack,
  onContinue,
}: {
  url: string
  code: string
  onBack: () => void
  onContinue: () => void
}) {
  let hostname = url
  try { hostname = new URL(url).hostname }
  catch (err) {
    // Some cert errors arrive without a parseable URL — fall back to
    // showing the raw string. Logged so an unexpectedly malformed URL
    // surfaces in DevTools rather than being silently shrugged off.
    console.warn('WebviewPanel: cert-error hostname parse failed', { url, err: String(err) })
  }
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-[440px] px-8">
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/15 text-destructive">
          <ShieldAlert size={26} strokeWidth={1.75} />
        </div>
        <h2 className="mb-2 text-2xl font-semibold tracking-tight">Your connection isn&apos;t private</h2>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          Attackers might be trying to steal your information from{' '}
          <span className="font-medium text-foreground">{hostname}</span> (for example, passwords, messages, or credit cards).
        </p>
        <p className="mb-7 font-mono text-xs text-muted-foreground">{code}</p>
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Back to safety
          </button>
          <button
            onClick={onContinue}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Continue to {hostname} (unsafe)
          </button>
        </div>
      </div>
    </div>
  )
}

const PERMISSION_ICON: Record<PermissionKind, LucideIcon> = {
  microphone: Mic,
  camera: Camera,
  geolocation: MapPin,
  notifications: Bell,
  clipboard: Clipboard,
  midi: Music,
}

/** Chrome-style permission prompt, rendered as a bar at the top of the page
 *  area. Allow / Block remember the choice for the site; the X dismisses it
 *  once (the site can ask again). */
function PermissionInfobar({
  request,
  onDecide,
}: {
  request: PermissionRequest
  onDecide: (decision: 'allow' | 'block', remember: boolean) => void
}) {
  let host = request.origin
  try {
    host = new URL(request.origin).hostname
  } catch {
    /* malformed origin — fall back to the raw string */
  }
  const Icon = PERMISSION_ICON[request.kinds[0]] ?? Mic
  return (
    <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5 text-foreground">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        <Icon size={16} strokeWidth={1.75} />
      </div>
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium">{host}</span>{' '}
        <span className="text-muted-foreground">wants to {describePermissionKinds(request.kinds)}</span>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => onDecide('block', true)}
          className="h-8 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          Block
        </button>
        <button
          onClick={() => onDecide('allow', true)}
          className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Allow
        </button>
        <button
          aria-label="Dismiss"
          onClick={() => onDecide('block', false)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}

/** Shown when the OS (macOS Privacy/TCC) blocks media even though the site was
 *  allowed in-app. The app can't grant this itself — only System Settings can —
 *  so we point the user there. */
function OsBlockedInfobar({
  kinds,
  onOpenSettings,
  onDismiss,
}: {
  kinds: PermissionKind[]
  onOpenSettings: (kind: 'microphone' | 'camera') => void
  onDismiss: () => void
}) {
  const label = kinds
    .map((k) => (k === 'camera' ? 'camera' : 'microphone'))
    .join(' and ')
  const primaryKind: 'microphone' | 'camera' = kinds.includes('camera') && !kinds.includes('microphone')
    ? 'camera'
    : 'microphone'
  return (
    <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5 text-foreground">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
        <ShieldAlert size={16} strokeWidth={1.75} />
      </div>
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        Your system is blocking Newbro from using your{' '}
        <span className="font-medium text-foreground">{label}</span>. Enable it in System Settings, then reload the page.
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => onOpenSettings(primaryKind)}
          className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Open System Settings
        </button>
        <button
          aria-label="Dismiss"
          onClick={onDismiss}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
