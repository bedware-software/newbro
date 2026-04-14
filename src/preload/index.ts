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
  closeWorkspaceWindows: (workspaceIds: string[]): Promise<void> => ipcRenderer.invoke('workspace:close-windows', workspaceIds),

  // Logging — fire-and-forget (no await needed)
  logWrite: (level: string, msg: string): void => { ipcRenderer.send('log:write', level, msg) },

  // Certificate info
  getCertInfo: (url: string): Promise<unknown> => ipcRenderer.invoke('cert:get-info', url),

  // Settings
  loadSettings: (): Promise<unknown> => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: unknown): Promise<void> => ipcRenderer.invoke('settings:save', settings),

  // Import
  openBookmarkFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-bookmark-file'),

  // About
  showAboutPanel: (): void => { ipcRenderer.send('show-about-panel') },

  // Exit
  quit: (): void => { ipcRenderer.send('app:quit') },

  // Context menu
  showContextMenu: (items: any[]): Promise<string | null> => ipcRenderer.invoke('context-menu:show', items),

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
})
