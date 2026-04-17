import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { log } from '../lib/log'

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

/**
 * Theme the webview's root document scrollbar so it matches the rest of the
 * app (search window, command palette, etc.). We intentionally set *only*
 * `scrollbar-width` + `scrollbar-color` on `html`, matching what the renderer
 * effectively gets from `globals.css` under modern Chromium (where
 * `scrollbar-width: thin` wins over `::-webkit-scrollbar` rules).
 *
 * Why this scope and nothing more:
 *   - `scrollbar-width` is not inherited, so we touch only the root scrollbar
 *     and leave inner scroll containers (code viewers, app sidebars, etc.)
 *     using whatever the site decided — no more double scrollbars from sites
 *     that hide the native one and paint their own inside a container, and no
 *     more thickness inconsistencies from sites that pick a non-10px width.
 *   - No `!important`: if a site styles its own `html` scrollbar, let it win.
 *   - Literal oklch values because the webview document can't read the
 *     renderer's CSS custom properties.
 */
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

function applyScrollbarStyle(wv: any): void {
  const css = buildScrollbarCss()
  const js = `(() => {
    let s = document.getElementById('__newbro_scrollbar_style__');
    if (!s) {
      s = document.createElement('style');
      s.id = '__newbro_scrollbar_style__';
      (document.head || document.documentElement).appendChild(s);
    }
    s.textContent = ${JSON.stringify(css)};
  })()`
  wv.executeJavaScript?.(js).catch(() => {})
}

// Transfer keyboard focus to `wv`. Blurs whatever currently owns focus
// (toolbar button, URL bar, sidebar item, OR the previously active
// webview that's now hidden) so it releases its claim on keystrokes.
// Blurring is the critical step: Electron's <webview> won't actually
// receive keystrokes if another element — especially a sibling webview
// that was just display:none'd — still holds :focus.
function handoffFocusTo(wv: HTMLElement): void {
  const active = document.activeElement as HTMLElement | null
  if (active && active !== document.body && active !== wv) {
    active.blur?.()
  }
  ;(wv as any).focus?.()
}

export function WebviewPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const webviewsRef = useRef<Map<string, HTMLElement>>(new Map())
  // Track which tabs have been activated (had their real URL loaded)
  const activatedTabsRef = useRef<Set<string>>(new Set())
  // Track which webviews have been focused at least once after attach, so
  // the first-paint focus only runs once per webview and dom-ready events
  // on subsequent navigations don't steal focus back from the user.
  const initiallyFocusedRef = useRef<Set<string>>(new Set())
  const [errors, setErrors] = useState<Map<string, LoadError>>(new Map())
  const [certErrors, setCertErrors] = useState<Map<string, CertError>>(new Map())

  const activeTabId = useAppStore((s) => s.activeTabId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const profiles = useAppStore((s) => s.profiles)
  const activeProfileId = useAppStore((s) => s.activeProfileId)

  // Only collect tabs from the active workspace
  const getWorkspaceTabs = useCallback(() => {
    const tabs: { id: string; url: string; partition: string }[] = []
    const profile = profiles.find(p => p.id === activeProfileId)
    if (!profile) return tabs
    const workspace = profile.workspaces.find(w => w.id === activeWorkspaceId)
    if (!workspace) return tabs
    for (const t of (workspace.tabs || [])) {
      tabs.push({ id: t.id, url: t.url, partition: profile.partition })
    }
    for (const g of workspace.tabGroups) {
      for (const t of g.tabs) {
        tabs.push({ id: t.id, url: t.url, partition: profile.partition })
      }
    }
    return tabs
  }, [profiles, activeProfileId, activeWorkspaceId])

  const getTabUrlById = useCallback((tabId: string): string => {
    const tabs = getWorkspaceTabs()
    return tabs.find((t) => t.id === tabId)?.url || ''
  }, [getWorkspaceTabs])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const currentTabs = getWorkspaceTabs()
    const currentTabIds = new Set(currentTabs.map((t) => t.id))
    const existingIds = new Set(webviewsRef.current.keys())

    // Remove webviews for deleted/out-of-scope tabs
    for (const id of existingIds) {
      if (!currentTabIds.has(id)) {
        const wv = webviewsRef.current.get(id)
        if (wv && container.contains(wv)) container.removeChild(wv)
        webviewsRef.current.delete(id)
        activatedTabsRef.current.delete(id)
        initiallyFocusedRef.current.delete(id)
      }
    }

    // Create webviews for new tabs (lazy: start with about:blank unless it's the active tab)
    for (const tab of currentTabs) {
      if (!webviewsRef.current.has(tab.id)) {
        const wv = document.createElement('webview') as any
        const isActiveNow = tab.id === activeTabId
        // Eager-load the active tab, lazy-load the rest
        const initialSrc = isActiveNow ? (tab.url || 'about:blank') : 'about:blank'
        if (isActiveNow) activatedTabsRef.current.add(tab.id)
        wv.setAttribute('src', initialSrc)
        wv.setAttribute('partition', tab.partition)
        wv.setAttribute('allowpopups', '')
        wv.setAttribute('data-tab-id', tab.id)
        wv.style.cssText = 'flex:1;width:100%;height:100%;border:none;display:none;'

        window.electronAPI?.setupSession(tab.partition)

        const tabId = tab.id

        // DEBUG: trace webview navigation lifecycle
        const dbg = (evt: string, detail?: any) => console.log(`[webview:${tabId.slice(0,6)}] ${evt}`, detail ?? '')

        wv.addEventListener('did-start-loading', () => {
          dbg('did-start-loading')
          // Clear any stale error/cert-error banners for this tab when a new load begins
          setErrors((prev) => { if (!prev.has(tabId)) return prev; const m = new Map(prev); m.delete(tabId); return m })
          setCertErrors((prev) => { if (!prev.has(tabId)) return prev; const m = new Map(prev); m.delete(tabId); return m })
        })
        wv.addEventListener('did-stop-loading', () => dbg('did-stop-loading', { url: wv.getURL?.() }))
        wv.addEventListener('did-start-navigation', (e: any) => dbg('did-start-navigation', { url: e.url, isMainFrame: e.isMainFrame }))
        wv.addEventListener('will-navigate', (e: any) => dbg('will-navigate', { url: e.url }))
        wv.addEventListener('dom-ready', () => {
          dbg('dom-ready', { url: wv.getURL?.() })
          applyScrollbarStyle(wv)
          // For a brand-new tab (Ctrl+T) the guest webContents isn't
          // attached when the activeTabId effect calls focus(), so that
          // call is a no-op on the page. The *first* dom-ready for this
          // webview is the earliest point we can reliably hand focus to
          // the guest. Subsequent dom-ready events (navigations, reloads)
          // are skipped so we don't yank focus back if the user
          // intentionally moved it to chrome.
          if (initiallyFocusedRef.current.has(tabId)) return
          initiallyFocusedRef.current.add(tabId)
          if (useAppStore.getState().activeTabId !== tabId) return
          handoffFocusTo(wv)
        })
        wv.addEventListener('did-finish-load', () => {
          dbg('did-finish-load', { url: wv.getURL?.() })
          // DEBUG: inspect guest DOM after load
          wv.executeJavaScript?.(`JSON.stringify({
            appHTML: document.getElementById('app')?.innerHTML?.slice(0, 500) || '<empty>',
            bodyChildren: document.body.children.length,
            scripts: document.querySelectorAll('script').length,
            styles: document.querySelectorAll('link[rel=stylesheet]').length,
            computedBg: getComputedStyle(document.body).backgroundColor,
            bodyTags: Array.from(document.body.children).slice(0, 20).map(el => el.tagName + (el.id ? '#'+el.id : '') + (el.className ? '.'+String(el.className).slice(0,30) : '')),
            headScripts: Array.from(document.querySelectorAll('head script')).map(s => (s.src || s.textContent?.slice(0,80) || '').slice(0, 100)),
            failedScripts: Array.from(document.querySelectorAll('script[src]')).filter(s => !s.src.startsWith('data:')).map(s => s.src).slice(0, 10),
          })`).then((r: string) => dbg('guest-dom', JSON.parse(r))).catch((e: any) => dbg('guest-dom-error', e.message))
        })
        // DEBUG: capture guest page console output (JS errors from the loaded site)
        wv.addEventListener('console-message', (e: any) => {
          const level = ['verbose','info','warning','error'][e.level] || e.level
          dbg(`guest-console[${level}]`, e.message)
        })

        // Mouse side-button navigation from the guest page. The stealth
        // preload listens for XButton1/XButton2 in the guest and relays via
        // `ipcRenderer.sendToHost('newbro-nav', 'back' | 'forward')`, which
        // surfaces here as an `ipc-message` event on the webview element.
        wv.addEventListener('ipc-message', (e: any) => {
          if (e.channel !== 'newbro-nav') return
          const dir = e.args?.[0]
          if (dir === 'back' && wv.canGoBack?.()) wv.goBack()
          else if (dir === 'forward' && wv.canGoForward?.()) wv.goForward()
        })

        wv.addEventListener('did-navigate', (e: any) => {
          dbg('did-navigate', { url: e.url })
          if (!e.url || e.url.startsWith('data:') || e.url === 'about:blank') return
          useAppStore.getState().updateTabUrl(tabId, e.url)
        })
        wv.addEventListener('did-navigate-in-page', (e: any) => {
          dbg('did-navigate-in-page', { url: e.url, isMainFrame: e.isMainFrame })
          if (e.isMainFrame && e.url && !e.url.startsWith('data:') && e.url !== 'about:blank') {
            useAppStore.getState().updateTabUrl(tabId, e.url)
          }
        })
        wv.addEventListener('page-title-updated', (e: any) => {
          // Pages like about:blank fire this with an empty title, which would
          // wipe out the user-facing tab name. Only accept non-empty titles.
          const title = (e.title || '').trim()
          if (!title) return
          useAppStore.getState().updateTabTitle(tabId, title)
        })
        wv.addEventListener('page-favicon-updated', (e: any) => {
          if (e.favicons && e.favicons.length > 0) {
            useAppStore.getState().updateTabFavicon(tabId, e.favicons[0])
          }
        })

        wv.addEventListener('did-fail-load', (e: any) => {
          dbg('did-fail-load', { url: e.validatedURL, code: e.errorCode, desc: e.errorDescription, isMainFrame: e.isMainFrame })
          // Ignore aborted loads (navigation cancelled, redirects) and subframe errors
          if (e.errorCode === -3 || e.errorCode === -100 || !e.isMainFrame) return
          const url = e.validatedURL || getTabUrlById(tabId) || ''
          const desc = e.errorDescription || 'Unknown error'

          // Cert / SSL error codes: ERR_CERT_* (-200..-215) and related SSL
          // codes (-216..-219), plus ERR_INSECURE_RESPONSE (-501).
          const isCert = (e.errorCode >= -219 && e.errorCode <= -200) || e.errorCode === -501
          if (isCert) {
            log.warn('cert error', { url, code: e.errorCode, desc })
            setCertErrors((prev) => new Map(prev).set(tabId, { tabId, url, code: e.errorCode, description: desc }))
            return
          }

          log.warn('page load failed', { url, code: e.errorCode, desc })
          setErrors((prev) => new Map(prev).set(tabId, { tabId, url, code: e.errorCode, description: desc }))
        })

        container.appendChild(wv)
        webviewsRef.current.set(tab.id, wv)
      }
    }

    // Show/hide based on active tab; lazy-load real URL on first activation
    for (const [id, wv] of webviewsRef.current) {
      const isActive = id === activeTabId
      ;(wv as HTMLElement).style.display = isActive ? 'flex' : 'none'
      if (isActive && !activatedTabsRef.current.has(id)) {
        activatedTabsRef.current.add(id)
        const tab = currentTabs.find((t) => t.id === id)
        const url = tab?.url || 'about:blank'
        if (url && url !== 'about:blank') {
          ;(wv as any).loadURL(url).catch(() => {})
        }
      }
    }
  }, [profiles, activeTabId, activeWorkspaceId, getWorkspaceTabs])

  // Re-apply the themed scrollbar style to every live webview when the app
  // theme changes (data-theme attribute on <html>) or when the OS colour
  // scheme flips while the app is set to "system".
  useEffect(() => {
    const reapply = () => {
      for (const wv of webviewsRef.current.values()) {
        applyScrollbarStyle(wv)
      }
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

  // Hand focus to the active webview whenever the active tab changes so
  // keyboard input goes to the page. Covers tab cycling (Ctrl+Tab /
  // Ctrl+Shift+Tab), Search Everything selection, sidebar clicks, etc.
  // The Enter-in-URL-bar path focuses directly from the Toolbar handler
  // because the URL may not change (reload case). Brand-new tabs
  // (Ctrl+T) are additionally handled by the first-dom-ready listener,
  // because the webview's guest webContents isn't attached yet when
  // this effect runs. Declared after the create/show effect so
  // display:flex is applied before we focus.
  useEffect(() => {
    if (!activeTabId) return
    const raf = requestAnimationFrame(() => {
      const wv = webviewsRef.current.get(activeTabId)
      if (!wv) return
      handoffFocusTo(wv)
    })
    return () => cancelAnimationFrame(raf)
  }, [activeTabId])

  const activeError = activeTabId ? errors.get(activeTabId) ?? null : null
  const activeCertError = activeTabId ? certErrors.get(activeTabId) ?? null : null
  const showCertError = activeCertError !== null
  // Only show the generic error banner when there's no cert-warning overlay on top
  const showError = activeError !== null && !showCertError

  const failedHost = (() => {
    if (!activeError?.url) return ''
    try { return new URL(activeError.url).hostname } catch { return activeError.url }
  })()

  const handleRetry = () => {
    if (!activeError) return
    const wv = webviewsRef.current.get(activeError.tabId) as any
    if (!wv) return
    setErrors((prev) => { const m = new Map(prev); m.delete(activeError.tabId); return m })
    const retryUrl = activeError.url || getTabUrlById(activeError.tabId)
    if (retryUrl && wv.loadURL) {
      wv.loadURL(retryUrl).catch(() => {})
    } else if (wv.reloadIgnoringCache) {
      wv.reloadIgnoringCache()
    } else {
      wv.reload()
    }
  }

  const handleCertContinue = async (err: CertError) => {
    // Tell main to allow the cert for this origin BEFORE we reload.
    try { await window.electronAPI.bypassCertForUrl(err.url) } catch { /* ignore */ }
    useAppStore.getState().markOriginCertBypassed(err.url)
    setCertErrors((prev) => { const m = new Map(prev); m.delete(err.tabId); return m })
    const wv = webviewsRef.current.get(err.tabId) as any
    if (wv && err.url) wv.loadURL(err.url).catch(() => {})
  }

  const handleCertBack = (err: CertError) => {
    setCertErrors((prev) => { const m = new Map(prev); m.delete(err.tabId); return m })
    const wv = webviewsRef.current.get(err.tabId) as any
    if (!wv) return
    if (wv.canGoBack?.()) {
      wv.goBack()
      return
    }
    wv.loadURL('about:blank').catch(() => {})
    useAppStore.getState().updateTabUrl(err.tabId, 'about:blank')
  }

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
      <div ref={containerRef} style={{ flex: 1, display: 'flex' }} />

      {showError && activeError && (
        <div className="absolute inset-0 z-50 bg-[#eaecf1] text-[#11151f] flex items-center justify-center">
          <div className="w-full max-w-[640px] px-8">
            <h2 className="text-4xl font-semibold mb-4">Hmmm... can&apos;t reach this page</h2>
            <p className="text-2xl mb-6">
              <strong>{failedHost || 'This site'}</strong> took too long to respond
            </p>
            <p className="text-lg font-semibold mb-2">Try:</p>
            <ul className="list-disc pl-6 text-base space-y-1 mb-6">
              <li>Checking the connection</li>
              <li>Checking the proxy and the firewall</li>
            </ul>
            <p className="text-sm text-[#586070] mb-6">{activeError.description} ({activeError.code})</p>
            <button
              onClick={handleRetry}
              className="px-6 py-2.5 rounded bg-[#2f6ecb] text-white text-sm font-semibold hover:bg-[#245fb5]"
            >
              Refresh
            </button>
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
  try { hostname = new URL(url).hostname } catch { /* ignore */ }
  return (
    <div className="absolute inset-0 z-50 bg-[#eaecf1] text-[#11151f] flex items-center justify-center">
      <div className="w-full max-w-[640px] px-8">
        <div className="w-16 h-16 mb-6 rounded-full bg-red-600 text-white flex items-center justify-center text-4xl font-bold leading-none">!</div>
        <h2 className="text-4xl font-semibold mb-4">Your connection isn&apos;t private</h2>
        <p className="text-base mb-4">
          Attackers might be trying to steal your information from{' '}
          <strong>{hostname}</strong> (for example, passwords, messages, or credit cards).
        </p>
        <p className="text-sm text-[#586070] mb-8 font-mono">{code}</p>
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="px-6 py-2.5 rounded bg-[#2f6ecb] text-white text-sm font-semibold hover:bg-[#245fb5]"
          >
            Back to safety
          </button>
          <button
            onClick={onContinue}
            className="px-2 py-2.5 text-sm text-[#586070] hover:text-[#11151f] underline"
          >
            Continue to {hostname} (unsafe)
          </button>
        </div>
      </div>
    </div>
  )
}
