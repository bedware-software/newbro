import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  loadState: (): Promise<unknown> => ipcRenderer.invoke('store:load'),
  saveState: (state: unknown): Promise<void> => ipcRenderer.invoke('store:save', state),
  setupSession: (partition: string): Promise<void> => ipcRenderer.invoke('session:setup', partition),
  openWorkspaceWindow: (profileId: string, workspaceId: string, workspaceName: string, targetTabId?: string): Promise<void> =>
    ipcRenderer.invoke('workspace:open-window', profileId, workspaceId, workspaceName, targetTabId),
  setWindowTitle: (title: string): Promise<void> => ipcRenderer.invoke('window:set-title', title),
  setTitleBarOverlay: (options: { color: string; symbolColor: string; height: number }): Promise<void> =>
    ipcRenderer.invoke('window:set-titlebar-overlay', options),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: (): Promise<void> => ipcRenderer.invoke('window:maximize'),
  restoreWindow: (): Promise<void> => ipcRenderer.invoke('window:restore'),

  // Detached popup dragging. drag-start awaits a response (we need to know
  // whether tracking was accepted). drag-update / drag-end are fire-and-forget
  // — `send` avoids the ~60×/sec round-trip latency of `invoke`.
  detachedWindowDragStart: (): Promise<boolean> => ipcRenderer.invoke('detached-window:drag-start'),
  detachedWindowDragUpdate: (): void => { ipcRenderer.send('detached-window:drag-update') },
  detachedWindowDragEnd: (): void => { ipcRenderer.send('detached-window:drag-end') },
  detachedWindowShow: (): void => { ipcRenderer.send('detached-window:show') },
  closeWorkspaceWindows: (workspaceIds: string[]): Promise<void> => ipcRenderer.invoke('workspace:close-windows', workspaceIds),

  // Logging — fire-and-forget (no await needed)
  logWrite: (level: string, msg: string): void => { ipcRenderer.send('log:write', level, msg) },

  // Certificate info
  getCertInfo: (url: string): Promise<unknown> => ipcRenderer.invoke('cert:get-info', url),
  bypassCertForUrl: (url: string): Promise<void> => ipcRenderer.invoke('cert:bypass-origin', url),

  // Settings
  loadSettings: (): Promise<unknown> => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: unknown): Promise<void> => ipcRenderer.invoke('settings:save', settings),

  // Danger zone: wipe the entire userData directory and relaunch.
  wipeAllData: (): Promise<void> => ipcRenderer.invoke('app:wipe-data'),

  // Import
  openBookmarkFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-bookmark-file'),

  // About
  showAboutPanel: (): void => { ipcRenderer.send('show-about-panel') },

  // Exit
  quit: (): void => { ipcRenderer.send('app:quit') },

  // Context menu
  showContextMenu: (items: any[]): Promise<string | null> => ipcRenderer.invoke('context-menu:show', items),

  // Auto-updater
  checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke('updater:check'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('updater:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('updater:install'),
  getUpdaterStatus: (): Promise<unknown> => ipcRenderer.invoke('updater:get-status'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('updater:get-app-version'),

  // Tab hosting (WebContentsView in main). The renderer owns layout and
  // lifecycle *decisions*; main runs the actual page.
  tabCreate: (tabId: string, partition: string, url: string, active: boolean): Promise<void> =>
    ipcRenderer.invoke('tab:create', tabId, partition, url, active),
  tabDestroy: (tabId: string): Promise<void> => ipcRenderer.invoke('tab:destroy', tabId),
  tabActivate: (tabId: string, url: string): Promise<void> => ipcRenderer.invoke('tab:activate', tabId, url),
  // Fire-and-forget: high-frequency from ResizeObserver / sidebar toggles.
  tabSetBounds: (bounds: { x: number; y: number; width: number; height: number }): void => {
    ipcRenderer.send('tab:bounds', bounds)
  },
  tabNavigate: (tabId: string, url: string): Promise<void> => ipcRenderer.invoke('tab:navigate', tabId, url),
  tabGoBack: (tabId: string): Promise<void> => ipcRenderer.invoke('tab:go-back', tabId),
  tabGoForward: (tabId: string): Promise<void> => ipcRenderer.invoke('tab:go-forward', tabId),
  tabReload: (tabId: string, ignoreCache = false): Promise<void> =>
    ipcRenderer.invoke('tab:reload', tabId, ignoreCache),
  tabStop: (tabId: string): Promise<void> => ipcRenderer.invoke('tab:stop', tabId),
  tabGetState: (tabId: string): Promise<{ isLoading: boolean; url: string; canGoBack: boolean; canGoForward: boolean } | null> =>
    ipcRenderer.invoke('tab:get-state', tabId),
  tabExecuteJS: (tabId: string, code: string): Promise<unknown> =>
    ipcRenderer.invoke('tab:execute-js', tabId, code),

  // Extensions
  listExtensions: (): Promise<unknown[]> => ipcRenderer.invoke('extensions:list'),
  installExtension: (idOrUrl: string): Promise<unknown> => ipcRenderer.invoke('extensions:install', idOrUrl),
  uninstallExtension: (extensionId: string): Promise<unknown[]> => ipcRenderer.invoke('extensions:uninstall', extensionId),
  setExtensionEnabled: (extensionId: string, enabled: boolean): Promise<unknown[]> =>
    ipcRenderer.invoke('extensions:set-enabled', extensionId, enabled),
  openExtensionOptions: (extensionId: string): Promise<string | null> =>
    ipcRenderer.invoke('extensions:open-options', extensionId),
  openExtensionAction: (extensionId: string, tabId: string | null): Promise<boolean> =>
    ipcRenderer.invoke('extensions:open-action', extensionId, tabId),

  // Receive events from main process — return cleanup function
  onShortcut: (callback: (action: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, action: string) => callback(action)
    ipcRenderer.on('shortcut', handler)
    return () => { ipcRenderer.removeListener('shortcut', handler) }
  },
  onStateUpdated: (callback: (state: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on('state:updated', handler)
    return () => { ipcRenderer.removeListener('state:updated', handler) }
  },
  onOpenUrlAsTab: (callback: (url: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, url: string) => callback(url)
    ipcRenderer.on('open-url-as-tab', handler)
    return () => { ipcRenderer.removeListener('open-url-as-tab', handler) }
  },
  onSettingsUpdated: (callback: (settings: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, settings: unknown) => callback(settings)
    ipcRenderer.on('settings:updated', handler)
    return () => { ipcRenderer.removeListener('settings:updated', handler) }
  },
  onActivateTab: (callback: (tabId: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string) => callback(tabId)
    ipcRenderer.on('activate-tab', handler)
    return () => { ipcRenderer.removeListener('activate-tab', handler) }
  },
  onUpdaterStatus: (callback: (status: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on('updater:status', handler)
    return () => { ipcRenderer.removeListener('updater:status', handler) }
  },
  onTabEvent: (callback: (evt: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, evt: unknown) => callback(evt)
    ipcRenderer.on('tab-event', handler)
    return () => { ipcRenderer.removeListener('tab-event', handler) }
  },
  onExtensionsChanged: (callback: (extensions: unknown[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, extensions: unknown[]) => callback(extensions)
    ipcRenderer.on('extensions:changed', handler)
    return () => { ipcRenderer.removeListener('extensions:changed', handler) }
  },
  onTabContextSearch: (callback: (query: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, query: string) => callback(query)
    ipcRenderer.on('tab-context-search', handler)
    return () => { ipcRenderer.removeListener('tab-context-search', handler) }
  },
})
