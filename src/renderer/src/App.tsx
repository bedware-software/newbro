import { useEffect, useState, useCallback } from 'react'
import { useAppStore, withoutSave, setDefaultNewTabUrl, getSidebarOrder } from './store/app-store'
import { setSearchEngine } from './lib/url'
import { log } from './lib/log'
import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { WebviewPanel } from './components/WebviewPanel'
import { SearchDialog } from './components/SearchDialog'
import { SettingsDialog } from './components/SettingsDialog'

interface Settings {
  proxy: {
    mode: 'system' | 'direct' | 'custom'
    proxyRules: string
    proxyBypassRules: string
  }
  theme: 'light' | 'dark' | 'system'
  defaultPageUrl: string
  searchEngine: string
  keybindings: Record<string, string>
}

declare global {
  interface Window {
    electronAPI: {
      loadState: () => Promise<unknown>
      saveState: (state: unknown) => Promise<void>
      setupSession: (partition: string) => Promise<void>
      openWorkspaceWindow: (profileId: string, workspaceId: string, workspaceName: string) => Promise<void>
      setWindowTitle: (title: string) => Promise<void>
      closeWindow: () => Promise<void>
      closeWorkspaceWindows: (workspaceIds: string[]) => Promise<void>
      getCertInfo: (url: string) => Promise<unknown>
      logWrite: (level: string, msg: string) => void
      loadSettings: () => Promise<Settings>
      saveSettings: (settings: Settings) => Promise<void>
      onShortcut: (callback: (action: string) => void) => () => void
      onStateUpdated: (callback: (state: unknown) => void) => () => void
      onOpenUrlAsTab: (callback: (url: string) => void) => () => void
      onSettingsUpdated: (callback: (settings: unknown) => void) => () => void
      onAuthComplete: (callback: (destinationUrl: string) => void) => () => void
    }
  }
}

function getWindowParams(): { profileId: string | null; workspaceId: string | null } {
  const params = new URLSearchParams(window.location.search)
  return {
    profileId: params.get('profileId') || null,
    workspaceId: params.get('workspaceId') || null,
  }
}

function applyTheme(theme: 'light' | 'dark' | 'system'): void {
  document.documentElement.setAttribute('data-theme', theme)
  log.info('theme applied:', theme)
}

const SIDEBAR_VISIBLE_KEY = 'newbro-sidebar-visible'

export default function App() {
  const [ready, setReady] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(() => {
    const v = localStorage.getItem(SIDEBAR_VISIBLE_KEY)
    return v === null ? true : v === 'true'
  })
  const hydrate = useAppStore((s) => s.hydrate)
  const { profileId: windowProfileId, workspaceId: windowWorkspaceId } = getWindowParams()

  const toggleSidebar = useCallback(() => {
    setSidebarVisible((v) => {
      const next = !v
      localStorage.setItem(SIDEBAR_VISIBLE_KEY, String(next))
      return next
    })
  }, [])

  const loadAndApplySettings = useCallback(async () => {
    try {
      const s = await window.electronAPI.loadSettings()
      setSettings(s)
      applyTheme(s.theme)
      setDefaultNewTabUrl(s.defaultPageUrl)
      setSearchEngine(s.searchEngine)
    } catch (err) {
      log.error('failed to load settings', err)
    }
  }, [])

  useEffect(() => {
    const load = async () => {
      log.info('App init', { windowProfileId, windowWorkspaceId })
      await loadAndApplySettings()

      try {
        const saved = await window.electronAPI.loadState()
        log.state('loaded from disk', saved ? 'has data' : 'null')
        if (saved) hydrate(saved)
      } catch (err) {
        log.error('failed to load state', err)
      }

      const store = useAppStore.getState()
      if (windowProfileId) {
        const found = store.profiles.find((p) => p.id === windowProfileId)
        if (found) useAppStore.setState({ activeProfileId: windowProfileId })
      }

      if (windowWorkspaceId) {
        const profileId = windowProfileId || useAppStore.getState().activeProfileId
        const profile = useAppStore.getState().profiles.find((p) => p.id === profileId)
        const ws = profile?.workspaces.find((w) => w.id === windowWorkspaceId)
        if (ws) {
          useAppStore.setState({ activeWorkspaceId: windowWorkspaceId })
          const firstUngrouped = ws.tabs?.[0]
          const firstGrouped = ws.tabGroups[0]
          if (firstUngrouped) {
            useAppStore.setState({ activeTabGroupId: null, activeTabId: firstUngrouped.id })
          } else if (firstGrouped) {
            useAppStore.setState({ activeTabGroupId: firstGrouped.id, activeTabId: firstGrouped.tabs[0]?.id || null })
          }
        }
      }

      log.state('final state', {
        activeProfileId: useAppStore.getState().activeProfileId,
        activeWorkspaceId: useAppStore.getState().activeWorkspaceId,
      })
      setReady(true)
    }
    load()
  }, [hydrate, windowProfileId, windowWorkspaceId, loadAndApplySettings])

  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const getActiveWorkspace = useAppStore((s) => s.getActiveWorkspace)
  const getActiveProfile = useAppStore((s) => s.getActiveProfile)

  useEffect(() => {
    const ws = getActiveWorkspace()
    const profile = getActiveProfile()
    if (ws && profile) {
      window.electronAPI.setWindowTitle(`${ws.name} — ${profile.name} — Newbro`)
    }
  }, [activeWorkspaceId, getActiveWorkspace, getActiveProfile])

  useEffect(() => {
    const cycleTab = (direction: 1 | -1) => {
      const state = useAppStore.getState()
      const profile = state.profiles.find((p) => p.id === state.activeProfileId)
      if (!profile || !state.activeWorkspaceId) return

      const workspace = profile.workspaces.find((w) => w.id === state.activeWorkspaceId)
      if (!workspace) return

      // Build visible tab order using sidebarOrder, skipping collapsed groups
      const order = getSidebarOrder(workspace)
      const tabMap = new Map((workspace.tabs || []).map((t) => [t.id, t]))
      const groupMap = new Map(workspace.tabGroups.map((g) => [g.id, g]))
      const orderedTabIds: string[] = []
      for (const id of order) {
        if (tabMap.has(id)) {
          orderedTabIds.push(id)
        } else {
          const group = groupMap.get(id)
          if (group && !group.isCollapsed) {
            for (const t of group.tabs) orderedTabIds.push(t.id)
          }
        }
      }
      if (orderedTabIds.length === 0) return

      const currentIndex = state.activeTabId ? orderedTabIds.indexOf(state.activeTabId) : -1
      const nextIndex = currentIndex === -1
        ? 0
        : (currentIndex + direction + orderedTabIds.length) % orderedTabIds.length
      const nextTabId = orderedTabIds[nextIndex]
      if (!nextTabId) return

      state.setActiveTab(nextTabId)
    }

    const cleanupShortcut = window.electronAPI.onShortcut((action) => {
      log.event('shortcut received', action)
      const s = useAppStore.getState()
      switch (action) {
        case 'new-tab':
          if (s.activeTabGroupId) s.addTab(s.activeTabGroupId)
          else if (s.activeWorkspaceId) s.addUngroupedTab(s.activeWorkspaceId)
          break
        case 'close-tab':
          if (s.activeTabId) s.closeTab(s.activeTabId)
          break
        case 'focus-url': {
          const urlBar = document.querySelector('#url-bar') as HTMLInputElement
          urlBar?.focus(); urlBar?.select()
          break
        }
        case 'search':
          setSearchOpen((v) => !v)
          break
        case 'settings':
          setSettingsOpen((v) => !v)
          break
        case 'toggle-sidebar':
          toggleSidebar()
          break
        case 'back': {
          const wv = document.querySelector(`webview[data-tab-id="${s.activeTabId}"]`) as any
          if (wv?.canGoBack()) wv.goBack()
          break
        }
        case 'forward': {
          const wv = document.querySelector(`webview[data-tab-id="${s.activeTabId}"]`) as any
          if (wv?.canGoForward()) wv.goForward()
          break
        }
        case 'reload': {
          const wv = document.querySelector(`webview[data-tab-id="${s.activeTabId}"]`) as any
          const activeTab = s.getActiveTab()
          const targetUrl = activeTab?.url || ''
          if (wv && targetUrl && wv.loadURL) {
            wv.loadURL(targetUrl)
          } else if (wv?.reloadIgnoringCache) {
            wv.reloadIgnoringCache()
          } else {
            wv?.reload()
          }
          break
        }
        case 'next-tab':
          cycleTab(1)
          break
        case 'prev-tab':
          cycleTab(-1)
          break
        case 'new-workspace':
          break
      }
    })

    const cleanupState = window.electronAPI.onStateUpdated((state) => {
      log.ipc('state:updated received from another window')
      const data = state as any
      if (!data?.profiles) return

      withoutSave(() => {
        const current = useAppStore.getState()
        const profiles = data.profiles
        for (const p of profiles) for (const w of p.workspaces) if (!w.tabs) w.tabs = []

        useAppStore.setState({ profiles })

        const profileId = current.activeProfileId
        const profile = profiles.find((p: any) => p.id === profileId)
        if (!profile) return
        const wsId = current.activeWorkspaceId
        const ws = profile.workspaces.find((w: any) => w.id === wsId)
        if (!ws) return

        const allTabs = [...(ws.tabs || []), ...ws.tabGroups.flatMap((g: any) => g.tabs)]
        if (current.activeTabId && !allTabs.some((t: any) => t.id === current.activeTabId)) {
          const firstGroup = ws.tabGroups[0]
          useAppStore.setState({
            activeTabGroupId: firstGroup?.id || null,
            activeTabId: firstGroup?.tabs[0]?.id || ws.tabs?.[0]?.id || null,
          })
        }
      })
    })

    const cleanupPopup = window.electronAPI.onOpenUrlAsTab((url) => {
      log.event('open-url-as-tab', url)
      const s = useAppStore.getState()
      if (s.activeTabGroupId) s.addTab(s.activeTabGroupId, url)
      else if (s.activeWorkspaceId) s.addUngroupedTab(s.activeWorkspaceId, url)
    })

    const cleanupSettings = window.electronAPI.onSettingsUpdated((newSettings) => {
      log.ipc('settings:updated received')
      const s = newSettings as Settings
      setSettings(s)
      applyTheme(s.theme)
      setDefaultNewTabUrl(s.defaultPageUrl)
      setSearchEngine(s.searchEngine)
    })

    // After external auth completes, navigate webview to the destination
    const cleanupAuth = window.electronAPI.onAuthComplete((destinationUrl) => {
      log.event('auth-complete', { destinationUrl })
      const s = useAppStore.getState()
      const wv = document.querySelector(`webview[data-tab-id="${s.activeTabId}"]`) as any
      if (wv && destinationUrl) {
        if (wv.loadURL) wv.loadURL(destinationUrl)
        else wv.src = destinationUrl
        if (s.activeTabId) s.updateTabUrl(s.activeTabId, destinationUrl)
      } else if (wv) {
        const activeTab = s.getActiveTab()
        const targetUrl = activeTab?.url || ''
        if (targetUrl && wv.loadURL) wv.loadURL(targetUrl)
        else if (wv.reloadIgnoringCache) wv.reloadIgnoringCache()
        else wv.reload()
      }
    })

    return () => { cleanupShortcut(); cleanupState(); cleanupPopup(); cleanupSettings(); cleanupAuth() }
  }, [hydrate, windowWorkspaceId, toggleSidebar])

  const handleSaveSettings = async (newSettings: Settings) => {
    setSettings(newSettings)
    applyTheme(newSettings.theme)
    setDefaultNewTabUrl(newSettings.defaultPageUrl)
    setSearchEngine(newSettings.searchEngine)
    await window.electronAPI.saveSettings(newSettings)
  }

  if (!ready) return null

  return (
    <>
      <Toolbar windowWorkspaceId={windowWorkspaceId} sidebarVisible={sidebarVisible} onToggleSidebar={toggleSidebar} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar visible={sidebarVisible} />
        <WebviewPanel />
      </div>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} windowWorkspaceId={windowWorkspaceId} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSave={handleSaveSettings} />
    </>
  )
}
