import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { log } from '../lib/log'

interface LoadError {
  tabId: string
  url: string
  code: number
  description: string
}

export function WebviewPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const webviewsRef = useRef<Map<string, HTMLElement>>(new Map())
  // Track which tabs have been activated (had their real URL loaded)
  const activatedTabsRef = useRef<Set<string>>(new Set())
  const [error, setError] = useState<LoadError | null>(null)

  const activeTabId = useAppStore((s) => s.activeTabId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const profiles = useAppStore((s) => s.profiles)
  const activeProfileId = useAppStore((s) => s.activeProfileId)

  // Clear error when switching tabs
  useEffect(() => { setError(null) }, [activeTabId])

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

        wv.addEventListener('did-start-loading', () => dbg('did-start-loading'))
        wv.addEventListener('did-stop-loading', () => dbg('did-stop-loading', { url: wv.getURL?.() }))
        wv.addEventListener('did-start-navigation', (e: any) => dbg('did-start-navigation', { url: e.url, isMainFrame: e.isMainFrame }))
        wv.addEventListener('will-navigate', (e: any) => dbg('will-navigate', { url: e.url }))
        wv.addEventListener('dom-ready', () => dbg('dom-ready', { url: wv.getURL?.() }))
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
          useAppStore.getState().updateTabTitle(tabId, e.title)
        })
        wv.addEventListener('page-favicon-updated', (e: any) => {
          if (e.favicons && e.favicons.length > 0) {
            useAppStore.getState().updateTabFavicon(tabId, e.favicons[0])
          }
        })

        // Clear error when page starts loading successfully
        wv.addEventListener('did-start-loading', () => {
          setError((prev) => prev?.tabId === tabId ? null : prev)
        })

        wv.addEventListener('did-fail-load', (e: any) => {
          dbg('did-fail-load', { url: e.validatedURL, code: e.errorCode, desc: e.errorDescription, isMainFrame: e.isMainFrame })
          // Ignore aborted loads (navigation cancelled, redirects) and subframe errors
          if (e.errorCode === -3 || e.errorCode === -100 || !e.isMainFrame) return
          const url = e.validatedURL || getTabUrlById(tabId) || ''
          const desc = e.errorDescription || 'Unknown error'

          log.warn('page load failed', { url, code: e.errorCode, desc })

          // Show error banner for the active tab only
          setError({ tabId, url, code: e.errorCode, description: desc })
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

  const handleRetry = () => {
    if (!error) return
    const wv = document.querySelector(`webview[data-tab-id="${error.tabId}"]`) as any
    if (wv) {
      setError(null)
      const retryUrl = error.url || getTabUrlById(error.tabId)
      if (retryUrl && wv.loadURL) {
        wv.loadURL(retryUrl).catch(() => {})
      } else if (wv.reloadIgnoringCache) {
        wv.reloadIgnoringCache()
      } else {
        wv.reload()
      }
    }
  }

  // Only show error for the currently active tab
  const showError = error && error.tabId === activeTabId
  const failedHost = (() => {
    if (!showError?.url) return ''
    try {
      return new URL(showError.url).hostname
    } catch {
      return showError.url
    }
  })()

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
      <div ref={containerRef} style={{ flex: 1, display: 'flex' }} />

      {showError && (
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
            <p className="text-sm text-[#586070] mb-6">{error.description} ({error.code})</p>
            <button
              onClick={handleRetry}
              className="px-6 py-2.5 rounded bg-[#2f6ecb] text-white text-sm font-semibold hover:bg-[#245fb5]"
            >
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
