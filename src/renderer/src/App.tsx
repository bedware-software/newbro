import { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore, withoutSave, setDefaultNewTabUrl, getSidebarOrder } from './store/app-store'
import { setSearchEngine } from './lib/url'
import { log } from './lib/log'
import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { WebviewPanel } from './components/WebviewPanel'
import { SearchDialog } from './components/SearchDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { CommandPalette } from './components/CommandPalette'
import { InputDialog } from './components/InputDialog'
import { GroupPicker } from './components/GroupPicker'

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
      openWorkspaceWindow: (profileId: string, workspaceId: string, workspaceName: string, targetTabId?: string) => Promise<void>
      setWindowTitle: (title: string) => Promise<void>
      setTitleBarOverlay: (options: { color: string; symbolColor: string; height: number }) => Promise<void>
      closeWindow: () => Promise<void>
      minimizeWindow: () => Promise<void>
      maximizeWindow: () => Promise<void>
      restoreWindow: () => Promise<void>
      detachedWindowDragStart: () => Promise<boolean>
      detachedWindowDragUpdate: () => void
      detachedWindowDragEnd: () => void
      closeWorkspaceWindows: (workspaceIds: string[]) => Promise<void>
      quit: () => void
      getCertInfo: (url: string) => Promise<unknown>
      bypassCertForUrl: (url: string) => Promise<void>
      logWrite: (level: string, msg: string) => void
      loadSettings: () => Promise<Settings>
      saveSettings: (settings: Settings) => Promise<void>
      wipeAllData: () => Promise<void>
      onShortcut: (callback: (action: string) => void) => () => void
      onStateUpdated: (callback: (state: unknown) => void) => () => void
      onOpenUrlAsTab: (callback: (url: string) => void) => () => void
      onSettingsUpdated: (callback: (settings: unknown) => void) => () => void
      onActivateTab: (callback: (tabId: string) => void) => () => void
    }
  }
}

function getWindowParams(): { profileId: string | null; workspaceId: string | null; tabId: string | null } {
  const params = new URLSearchParams(window.location.search)
  return {
    profileId: params.get('profileId') || null,
    workspaceId: params.get('workspaceId') || null,
    tabId: params.get('tabId') || null,
  }
}

function getOverlayColors(theme: 'light' | 'dark' | 'system'): { color: string; symbolColor: string; height: number } {
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  return isDark
    ? { color: '#0f0f0f', symbolColor: '#d7d7d7', height: 47 }
    : { color: '#e3e4eb', symbolColor: '#37394a', height: 47 }
}

function applyTheme(theme: 'light' | 'dark' | 'system'): void {
  document.documentElement.setAttribute('data-theme', theme)
  window.electronAPI.setTitleBarOverlay(getOverlayColors(theme))
  log.info('theme applied:', theme)
}

const SIDEBAR_VISIBLE_KEY = 'newbro-sidebar-visible'

export default function App() {
  const [ready, setReady] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [commentDialogOpen, setCommentDialogOpen] = useState(false)
  const [commentDefault, setCommentDefault] = useState('')
  const [newGroupDialogOpen, setNewGroupDialogOpen] = useState(false)
  const [newGroupForTabId, setNewGroupForTabId] = useState<string | null>(null)
  const [groupPickerOpen, setGroupPickerOpen] = useState(false)
  const shortcutHandlerRef = useRef<((action: string) => void) | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(() => {
    const v = localStorage.getItem(SIDEBAR_VISIBLE_KEY)
    return v === null ? true : v === 'true'
  })
  const hydrate = useAppStore((s) => s.hydrate)
  const { profileId: windowProfileId, workspaceId: windowWorkspaceId, tabId: windowTabId } = getWindowParams()

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

          const workspaceContainsTab = (tabId: string): boolean => {
            if (ws.tabs?.some((t) => t.id === tabId)) return true
            for (const g of ws.tabGroups) {
              if (g.tabs.some((t) => t.id === tabId)) return true
            }
            return false
          }

          // Resolve which tab to activate, in priority order:
          //   1. windowTabId from URL query param (explicit target when opening a new window)
          //   2. ws.lastActiveTabId — per-workspace persisted last-active tab
          //      (required so every workspace window restores its own tab, not just the last-focused one)
          //   3. hydrated global activeTabId — transitional fallback for pre-existing state
          //      that doesn't yet have lastActiveTabId set on each workspace
          //   4. First tab in the workspace
          let resolvedTabId: string | null = null
          if (windowTabId && workspaceContainsTab(windowTabId)) {
            resolvedTabId = windowTabId
          }
          if (!resolvedTabId && ws.lastActiveTabId && workspaceContainsTab(ws.lastActiveTabId)) {
            resolvedTabId = ws.lastActiveTabId
          }
          if (!resolvedTabId) {
            const hydratedActiveId = useAppStore.getState().activeTabId
            if (hydratedActiveId && workspaceContainsTab(hydratedActiveId)) {
              resolvedTabId = hydratedActiveId
            }
          }
          if (!resolvedTabId) {
            const firstUngrouped = ws.tabs?.[0]
            const firstGrouped = ws.tabGroups[0]
            if (firstUngrouped) {
              resolvedTabId = firstUngrouped.id
            } else if (firstGrouped) {
              resolvedTabId = firstGrouped.tabs[0]?.id || null
            }
          }

          if (resolvedTabId) {
            // Use setActiveTab so the containing tab group is expanded and the tab is visible in the sidebar.
            useAppStore.getState().setActiveTab(resolvedTabId)
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
  }, [hydrate, windowProfileId, windowWorkspaceId, windowTabId, loadAndApplySettings])

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

    const handleAction = (action: string) => {
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
        case 'command-palette':
          setCommandPaletteOpen((v) => !v)
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
            wv.loadURL(targetUrl).catch(() => {})
          } else if (wv?.reloadIgnoringCache) {
            wv.reloadIgnoringCache()
          } else {
            wv?.reload()
          }
          // Hand focus to the page so the cursor doesn't stay trapped in the URL bar
          wv?.focus?.()
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
        case 'about':
          (window as any).electronAPI.showAboutPanel()
          break
        case 'set-comment': {
          const tab = s.getActiveTab()
          if (tab) {
            setCommentDefault(tab.comment || '')
            setCommentDialogOpen(true)
          }
          break
        }
        case 'remove-comment':
          if (s.activeTabId) s.setTabComment(s.activeTabId, '')
          break
        case 'move-to-group':
          if (s.activeTabId) {
            setGroupPickerOpen(true)
          }
          break
        case 'add-to-new-group':
          if (s.activeTabId) {
            setNewGroupForTabId(s.activeTabId)
            setNewGroupDialogOpen(true)
          }
          break
        case 'close-workspace':
        case 'close-window':
          (window as any).electronAPI.closeWindow()
          break
        case 'minimize-window':
          (window as any).electronAPI.minimizeWindow()
          break
        case 'maximize-window':
          (window as any).electronAPI.maximizeWindow()
          break
        case 'restore-window':
          (window as any).electronAPI.restoreWindow()
          break
        case 'quit':
          (window as any).electronAPI.quit()
          break
        case 'expand-all-groups': {
          const profile = s.profiles.find((p) => p.id === s.activeProfileId)
          const ws = profile?.workspaces.find((w) => w.id === s.activeWorkspaceId)
          if (ws) ws.tabGroups.forEach((g) => { if (g.isCollapsed) s.toggleTabGroupCollapse(g.id) })
          break
        }
        case 'collapse-all-groups': {
          const profile = s.profiles.find((p) => p.id === s.activeProfileId)
          const ws = profile?.workspaces.find((w) => w.id === s.activeWorkspaceId)
          if (ws) ws.tabGroups.forEach((g) => { if (!g.isCollapsed) s.toggleTabGroupCollapse(g.id) })
          break
        }
      }
    }
    shortcutHandlerRef.current = handleAction

    const cleanupShortcut = window.electronAPI.onShortcut((action) => {
      log.event('shortcut received', action)
      handleAction(action)
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

    const cleanupActivateTab = window.electronAPI.onActivateTab((tabId) => {
      log.event('activate-tab', tabId)
      useAppStore.getState().setActiveTab(tabId)
    })

    return () => { cleanupShortcut(); cleanupState(); cleanupPopup(); cleanupSettings(); cleanupActivateTab() }
  }, [hydrate, windowWorkspaceId, toggleSidebar])

  // Global Escape handler: when a chrome button or the URL bar has keyboard
  // focus, blur it and hand focus back to the active webview. Prevents
  // Chromium's :focus-visible ring from sticking on toolbar/sidebar buttons
  // after the user hits Esc, and lets Esc exit the URL bar back to the page.
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const active = document.activeElement as HTMLElement | null
      if (!active) return
      const isButton = active.tagName === 'BUTTON'
      const isUrlBar = active.id === 'url-bar'
      if (!isButton && !isUrlBar) return
      active.blur()
      const s = useAppStore.getState()
      if (!s.activeTabId) return
      const wv = document.querySelector(`webview[data-tab-id="${s.activeTabId}"]`) as any
      wv?.focus?.()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [])

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
      <Toolbar windowWorkspaceId={windowWorkspaceId} sidebarVisible={sidebarVisible} onToggleSidebar={toggleSidebar} onOpenSettings={() => setSettingsOpen(true)} onOpenAbout={() => (window as any).electronAPI.showAboutPanel()} onOpenSearch={() => setSearchOpen(true)} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar visible={sidebarVisible} />
        <WebviewPanel />
      </div>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} windowWorkspaceId={windowWorkspaceId} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSave={handleSaveSettings} onThemePreview={applyTheme} />
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        onAction={(action) => {
          setCommandPaletteOpen(false)
          // Dispatch the action through the same shortcut handler
          setTimeout(() => {
            const handler = shortcutHandlerRef.current
            if (handler) handler(action)
          }, 100)
        }}
      />
      <InputDialog
        open={commentDialogOpen}
        title="Tab Comment"
        placeholder="Enter comment..."
        defaultValue={commentDefault}
        confirmLabel="Save"
        onConfirm={(value) => {
          const s = useAppStore.getState()
          if (s.activeTabId) s.setTabComment(s.activeTabId, value)
          setCommentDialogOpen(false)
        }}
        onCancel={() => setCommentDialogOpen(false)}
      />
      <InputDialog
        open={newGroupDialogOpen}
        title="New Group"
        placeholder="Group name"
        onConfirm={(name) => {
          if (newGroupForTabId) {
            useAppStore.getState().moveTabsToNewGroup([newGroupForTabId], name)
          }
          setNewGroupForTabId(null)
          setNewGroupDialogOpen(false)
        }}
        onCancel={() => {
          setNewGroupForTabId(null)
          setNewGroupDialogOpen(false)
        }}
      />
      <GroupPicker
        open={groupPickerOpen}
        onClose={() => setGroupPickerOpen(false)}
        onSelect={(groupId) => {
          const s = useAppStore.getState()
          if (s.activeTabId) s.moveTabToGroup(s.activeTabId, groupId)
          setGroupPickerOpen(false)
        }}
        onNewGroup={() => {
          setGroupPickerOpen(false)
          const s = useAppStore.getState()
          if (s.activeTabId) {
            setNewGroupForTabId(s.activeTabId)
            setNewGroupDialogOpen(true)
          }
        }}
      />
    </>
  )
}
