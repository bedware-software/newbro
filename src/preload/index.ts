import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  loadState: (): Promise<unknown> => ipcRenderer.invoke('store:load'),
  saveState: (state: unknown): Promise<void> => ipcRenderer.invoke('store:save', state),
  setupSession: (partition: string): Promise<void> => ipcRenderer.invoke('session:setup', partition),
  openWorkspaceWindow: (profileId: string, workspaceId: string, workspaceName: string, targetTabId?: string): Promise<void> =>
    ipcRenderer.invoke('workspace:open-window', profileId, workspaceId, workspaceName, targetTabId),
  getOpenWorkspaceWindows: (): Promise<{ profileId: string; workspaceId: string }[]> =>
    ipcRenderer.invoke('workspace:get-open-windows'),
  getLastUsedWorkspace: (profileId: string): Promise<string | null> =>
    ipcRenderer.invoke('workspace:get-last-used', profileId),
  setWindowTitle: (title: string): Promise<void> => ipcRenderer.invoke('window:set-title', title),
  setTitleBarOverlay: (options: { color: string; symbolColor: string; height: number }): Promise<void> =>
    ipcRenderer.invoke('window:set-titlebar-overlay', options),
  toggleUiDevTools: (): Promise<void> => ipcRenderer.invoke('window:toggle-ui-devtools'),
  // Toggle DevTools for whichever window is focused — used by detached popups
  // (Command Palette, dialogs) so F12 inside them inspects that popup rather
  // than the main window.
  toggleFocusedDevTools: (): Promise<void> => ipcRenderer.invoke('window:toggle-focused-devtools'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  // Pull OS-level keyboard focus back to the renderer (away from any
  // currently-focused WebContentsView tab). Call before .focus()-ing a
  // renderer-side input so typed characters actually land there.
  focusWindowRenderer: (): void => { ipcRenderer.send('window:focus-renderer') },
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: (): Promise<void> => ipcRenderer.invoke('window:maximize'),
  restoreWindow: (): Promise<void> => ipcRenderer.invoke('window:restore'),

  // Detached popup dragging. drag-start awaits a response (we need to know
  // whether tracking was accepted). drag-update / drag-end are fire-and-forget
  // — `send` avoids the ~60×/sec round-trip latency of `invoke`.
  detachedWindowDragStart: (): Promise<boolean> => ipcRenderer.invoke('detached-window:drag-start'),
  detachedWindowDragUpdate: (): void => { ipcRenderer.send('detached-window:drag-update') },
  detachedWindowDragEnd: (): void => { ipcRenderer.send('detached-window:drag-end') },
  detachedWindowShow: (alwaysOnTop?: boolean): void => { ipcRenderer.send('detached-window:show', { alwaysOnTop: !!alwaysOnTop }) },
  closeWorkspaceWindows: (workspaceIds: string[]): Promise<void> => ipcRenderer.invoke('workspace:close-windows', workspaceIds),

  // Logging — fire-and-forget (no await needed)
  logWrite: (level: string, msg: string): void => { ipcRenderer.send('log:write', level, msg) },

  // Clipboard write via main — needed for DetachedWindow popups where
  // navigator.clipboard fails because the parent renderer document isn't
  // focused. Fire-and-forget.
  clipboardWriteText: (text: string): void => { ipcRenderer.send('clipboard:write-text', text) },

  // Certificate info
  getCertInfo: (url: string): Promise<unknown> => ipcRenderer.invoke('cert:get-info', url),
  bypassCertForUrl: (url: string): Promise<void> => ipcRenderer.invoke('cert:bypass-origin', url),

  // Settings
  loadSettings: (): Promise<unknown> => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: unknown): Promise<void> => ipcRenderer.invoke('settings:save', settings),

  // Cloud sync (synced-folder). Config + status come back as one info object;
  // onCloudSyncStatus pushes the same shape whenever it changes.
  cloudSyncGetInfo: (): Promise<unknown> => ipcRenderer.invoke('cloud-sync:get-info'),
  cloudSyncSetFolder: (): Promise<unknown> => ipcRenderer.invoke('cloud-sync:set-folder'),
  cloudSyncSetEnabled: (enabled: boolean): Promise<unknown> => ipcRenderer.invoke('cloud-sync:set-enabled', enabled),
  cloudSyncSetCategories: (patch: Record<string, boolean>): Promise<unknown> =>
    ipcRenderer.invoke('cloud-sync:set-categories', patch),
  cloudSyncNow: (): Promise<unknown> => ipcRenderer.invoke('cloud-sync:now'),
  // First-run setup offer. claim returns whether THIS window should show it
  // (only the first caller per launch gets true); setup-with-folder enables
  // sync into a given path; dismiss-prompt is "Don't show again".
  cloudSyncClaimSetupPrompt: (): Promise<unknown> => ipcRenderer.invoke('cloud-sync:claim-setup-prompt'),
  cloudSyncSetupWithFolder: (folderPath: string): Promise<unknown> =>
    ipcRenderer.invoke('cloud-sync:setup-with-folder', folderPath),
  cloudSyncDismissPrompt: (): Promise<unknown> => ipcRenderer.invoke('cloud-sync:dismiss-prompt'),
  onCloudSyncStatus: (callback: (info: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, info: unknown): void => callback(info)
    ipcRenderer.on('cloud-sync:status', handler)
    return () => { ipcRenderer.removeListener('cloud-sync:status', handler) }
  },

  // Site permissions. Main sends 'permission:request' when a page asks for a
  // gated capability (mic, camera, location, …) with no remembered decision;
  // respondPermission carries the user's Allow/Block click back. The list /
  // clear methods back the Settings → Site permissions exceptions UI.
  onPermissionRequest: (
    callback: (payload: { requestId: string; origin: string; kinds: string[]; tabId: string }) => void,
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { requestId: string; origin: string; kinds: string[]; tabId: string },
    ): void => callback(payload)
    ipcRenderer.on('permission:request', handler)
    return () => { ipcRenderer.removeListener('permission:request', handler) }
  },
  respondPermission: (
    requestId: string,
    decision: 'allow' | 'block',
    remember: boolean,
  ): Promise<void> => ipcRenderer.invoke('permission:respond', requestId, decision, remember),
  permissionsList: (): Promise<unknown[]> => ipcRenderer.invoke('permissions:list'),
  permissionsSet: (
    partition: string,
    origin: string,
    kind: string,
    decision: 'allow' | 'block',
  ): Promise<unknown[]> => ipcRenderer.invoke('permissions:set', partition, origin, kind, decision),
  permissionsClear: (partition: string, origin: string, kind: string): Promise<unknown[]> =>
    ipcRenderer.invoke('permissions:clear', partition, origin, kind),
  permissionsClearAll: (): Promise<unknown[]> => ipcRenderer.invoke('permissions:clear-all'),
  // Fired when macOS/Windows blocks media at the OS level despite an in-app
  // grant — the renderer shows a bar pointing the user at System Settings.
  onPermissionOsBlocked: (
    callback: (payload: { tabId: string; kinds: string[] }) => void,
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { tabId: string; kinds: string[] },
    ): void => callback(payload)
    ipcRenderer.on('permission:os-blocked', handler)
    return () => { ipcRenderer.removeListener('permission:os-blocked', handler) }
  },
  openOsPermissionSettings: (kind: 'microphone' | 'camera'): Promise<void> =>
    ipcRenderer.invoke('permissions:open-os-settings', kind),

  // Danger zone: wipe the entire userData directory and relaunch.
  wipeAllData: (): Promise<void> => ipcRenderer.invoke('app:wipe-data'),

  // Default-browser registration. `getDefaultBrowserStatus` returns a snapshot
  // including whether one click can complete the change on this OS — on
  // Windows it can't, and `setAsDefaultBrowser` opens Settings → Default Apps
  // instead, signalled via `openedSystemPane` in the result.
  getDefaultBrowserStatus: (): Promise<unknown> => ipcRenderer.invoke('default-browser:get-status'),
  setAsDefaultBrowser: (): Promise<unknown> => ipcRenderer.invoke('default-browser:set-default'),

  // Import
  openBookmarkFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-bookmark-file'),

  // Export
  saveBookmarkFile: (html: string, suggestedName: string): Promise<boolean> =>
    ipcRenderer.invoke('dialog:save-bookmark-file', html, suggestedName),

  // Exit
  quit: (): void => { ipcRenderer.send('app:quit') },

  // Auto-updater
  checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke('updater:check'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('updater:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('updater:install'),
  getUpdaterStatus: (): Promise<unknown> => ipcRenderer.invoke('updater:get-status'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('updater:get-app-version'),
  getAppPaths: (): Promise<{ userData: string; cache: string; logs: string; appName: string }> =>
    ipcRenderer.invoke('app:get-paths'),

  // Tab hosting (WebContentsView in main). The renderer owns layout and
  // lifecycle *decisions*; main runs the actual page.
  tabCreate: (
    tabId: string,
    partition: string,
    url: string,
    active: boolean,
    /** When true, the tab starts loading immediately even if `active`
     *  is false. Used for background tabs opened by user action
     *  (Cmd+Click, middle-click, RMB → Open in New Tab) so the page is
     *  ready by the time the user switches to it. Omit (or pass false)
     *  for restored / programmatic tabs that should stay lazy. */
    eagerLoad = false,
    /** When true, main keeps OS keyboard focus on the renderer instead of
     *  the new page so the toolbar URL bar can own it — the "focus URL on
     *  new tab" preference. The renderer focuses the URL bar itself. */
    focusUrlBar = false,
  ): Promise<void> =>
    ipcRenderer.invoke('tab:create', tabId, partition, url, active, eagerLoad, focusUrlBar),
  tabDestroy: (tabId: string): Promise<void> => ipcRenderer.invoke('tab:destroy', tabId),
  tabActivate: (tabId: string, url: string): Promise<void> => ipcRenderer.invoke('tab:activate', tabId, url),
  // Move OS keyboard focus into the tab's page (used by the Esc handler so
  // keystrokes leave the URL bar and reach the site).
  tabFocus: (tabId: string): Promise<void> => ipcRenderer.invoke('tab:focus', tabId),
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
  tabToggleDevTools: (tabId: string): Promise<void> =>
    ipcRenderer.invoke('tab:toggle-devtools', tabId),
  tabSavePage: (tabId: string): Promise<boolean> =>
    ipcRenderer.invoke('tab:save-page', tabId),
  // Find-in-page: fire-and-forget. Match results arrive on the existing
  // 'tab-event' channel as { type: 'found-in-page', ... } payloads.
  tabFindInPage: (
    tabId: string,
    text: string,
    options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
  ): void => {
    ipcRenderer.send('tab:find-in-page', tabId, text, options)
  },
  tabStopFindInPage: (
    tabId: string,
    action: 'clearSelection' | 'keepSelection' | 'activateSelection',
  ): void => {
    ipcRenderer.send('tab:stop-find-in-page', tabId, action)
  },

  // Extensions
  listExtensions: (): Promise<unknown[]> => ipcRenderer.invoke('extensions:list'),
  installExtension: (idOrUrl: string): Promise<unknown> => ipcRenderer.invoke('extensions:install', idOrUrl),
  uninstallExtension: (extensionId: string): Promise<unknown[]> => ipcRenderer.invoke('extensions:uninstall', extensionId),
  setExtensionEnabled: (extensionId: string, enabled: boolean): Promise<unknown[]> =>
    ipcRenderer.invoke('extensions:set-enabled', extensionId, enabled),
  setExtensionPinned: (extensionId: string, pinned: boolean): Promise<unknown[]> =>
    ipcRenderer.invoke('extensions:set-pinned', extensionId, pinned),
  openExtensionOptions: (extensionId: string): Promise<string | null> =>
    ipcRenderer.invoke('extensions:open-options', extensionId),
  openExtensionAction: (
    extensionId: string,
    tabId: string | null,
    anchor: { x: number; y: number; width: number; height: number } | null
  ): Promise<'opened' | 'closed' | 'no-popup'> =>
    ipcRenderer.invoke('extensions:open-action', extensionId, tabId, anchor),
  closeExtensionPopup: (): Promise<boolean> => ipcRenderer.invoke('extensions:close-popup'),
  moveExtensionPopup: (
    extensionId: string,
    anchor: { x: number; y: number; width: number; height: number }
  ): void => {
    ipcRenderer.send('extensions:move-popup', extensionId, anchor)
  },
  onExtensionPopupOpened: (callback: (payload: { extensionId: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { extensionId: string }) => callback(payload)
    ipcRenderer.on('extension-popup-opened', handler)
    return () => { ipcRenderer.removeListener('extension-popup-opened', handler) }
  },
  onExtensionPopupClosed: (callback: (payload: { extensionId: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { extensionId: string }) => callback(payload)
    ipcRenderer.on('extension-popup-closed', handler)
    return () => { ipcRenderer.removeListener('extension-popup-closed', handler) }
  },

  // URL visit history (for address-bar autocomplete). list() returns the
  // full LRU snapshot; the renderer keeps a local mirror via the
  // onHistoryUpdated broadcast so per-keystroke lookups stay synchronous.
  historyList: (): Promise<unknown[]> => ipcRenderer.invoke('history:list'),
  historyClear: (): Promise<boolean> => ipcRenderer.invoke('history:clear'),
  onHistoryUpdated: (callback: (entries: unknown[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, entries: unknown[]) => callback(entries)
    ipcRenderer.on('history:updated', handler)
    return () => { ipcRenderer.removeListener('history:updated', handler) }
  },

  // Per-profile Bookshelf reading queue (src/main/bookshelf.ts). Each window
  // mirrors its own profile's list and refreshes on the onBookshelfUpdated
  // broadcast (filtered by profileId on the renderer side).
  bookshelfList: (profileId: string): Promise<unknown> => ipcRenderer.invoke('bookshelf:list', profileId),
  bookshelfAdd: (profileId: string, input: { url: string; title?: string; favicon?: string }): Promise<unknown> =>
    ipcRenderer.invoke('bookshelf:add', profileId, input),
  bookshelfUpdate: (profileId: string, id: string, patch: { title?: string; status?: 'toread' | 'archived' }): Promise<boolean> =>
    ipcRenderer.invoke('bookshelf:update', profileId, id, patch),
  bookshelfRemove: (profileId: string, id: string): Promise<boolean> => ipcRenderer.invoke('bookshelf:remove', profileId, id),
  bookshelfMoveReading: (profileId: string, readingId: string, groupId: string | null): Promise<boolean> =>
    ipcRenderer.invoke('bookshelf:move-reading', profileId, readingId, groupId),
  bookshelfAddGroup: (profileId: string, name: string): Promise<unknown> => ipcRenderer.invoke('bookshelf:add-group', profileId, name),
  bookshelfUpdateGroup: (profileId: string, id: string, patch: { name?: string; color?: string; isCollapsed?: boolean }): Promise<boolean> =>
    ipcRenderer.invoke('bookshelf:update-group', profileId, id, patch),
  bookshelfRemoveGroup: (profileId: string, id: string, deleteReadings: boolean): Promise<boolean> =>
    ipcRenderer.invoke('bookshelf:remove-group', profileId, id, deleteReadings),
  bookshelfSaveOffline: (profileId: string, id: string, partition: string): Promise<boolean> =>
    ipcRenderer.invoke('bookshelf:save-offline', profileId, id, partition),
  onBookshelfUpdated: (callback: (payload: { profileId: string; readings: unknown[]; groups: unknown[] }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { profileId: string; readings: unknown[]; groups: unknown[] }) => callback(payload)
    ipcRenderer.on('bookshelf:updated', handler)
    return () => { ipcRenderer.removeListener('bookshelf:updated', handler) }
  },

  // Downloads — manager backed by per-session 'will-download' in main.
  // List returns both in-flight and history entries (history is persisted
  // across restarts); pause/resume/cancel are no-ops once a download has
  // finished (the DownloadItem reference is dropped on 'done').
  downloadsList: (): Promise<unknown[]> => ipcRenderer.invoke('downloads:list'),
  downloadsPause: (id: string): Promise<boolean> => ipcRenderer.invoke('downloads:pause', id),
  downloadsResume: (id: string): Promise<boolean> => ipcRenderer.invoke('downloads:resume', id),
  downloadsCancel: (id: string): Promise<boolean> => ipcRenderer.invoke('downloads:cancel', id),
  downloadsRemove: (id: string): Promise<boolean> => ipcRenderer.invoke('downloads:remove', id),
  downloadsClear: (): Promise<boolean> => ipcRenderer.invoke('downloads:clear'),
  downloadsShowInFolder: (id: string): Promise<boolean> => ipcRenderer.invoke('downloads:show-in-folder', id),
  downloadsOpenFile: (id: string): Promise<boolean> => ipcRenderer.invoke('downloads:open-file', id),
  downloadsRefresh: (): Promise<unknown[]> => ipcRenderer.invoke('downloads:refresh'),
  onDownloadsUpdated: (callback: (entries: unknown[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, entries: unknown[]) => callback(entries)
    ipcRenderer.on('downloads:updated', handler)
    return () => { ipcRenderer.removeListener('downloads:updated', handler) }
  },
  // Main emits this when a tab was created solely to trigger a download
  // (target="_blank" → empty tab → Content-Disposition: attachment). The
  // renderer closes that tab so the user doesn't end up with a blank
  // tab sitting next to their download.
  onCloseBlankDownloadTab: (callback: (tabId: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string) => callback(tabId)
    ipcRenderer.on('downloads:close-blank-tab', handler)
    return () => { ipcRenderer.removeListener('downloads:close-blank-tab', handler) }
  },

  // Dynamic browser-action state — main process broadcasts updates whenever
  // an extension calls chrome.action.setIcon / setBadgeText / setTitle /
  // setPopup, or when the active tab changes. The toolbar uses this to
  // overlay live icons + badges over its static manifest icon.
  getBrowserActionState: (): Promise<{
    partition: string | null
    state: { activeTabId?: number; actions: unknown[] }
  }> => ipcRenderer.invoke('extensions:browser-action-state:get'),
  onBrowserActionState: (
    callback: (payload: { partition: string; activeTabId?: number; actions: unknown[] }) => void
  ) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: {
      partition: string
      activeTabId?: number
      actions: unknown[]
    }) => callback(payload)
    ipcRenderer.on('extensions:browser-action-state', handler)
    return () => { ipcRenderer.removeListener('extensions:browser-action-state', handler) }
  },

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
  // Background variant of open-url-as-tab — Cmd+Click, middle-click, and
  // RMB → "Open in New Tab" route here so the new tab opens behind the
  // current one. Separate channel (rather than a flag on the same one)
  // keeps each sender's intent explicit at the call site.
  onOpenUrlAsTabBackground: (callback: (url: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, url: string) => callback(url)
    ipcRenderer.on('open-url-as-tab-background', handler)
    return () => { ipcRenderer.removeListener('open-url-as-tab-background', handler) }
  },
  // OS-routed handoffs (default-browser link clicks, second-instance argv,
  // etc.) — separate channel so the renderer can route these to the
  // workspace/group picker. In-app new-tab actions stay on
  // open-url-as-tab and land directly.
  onOpenExternalUrl: (callback: (url: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, url: string) => callback(url)
    ipcRenderer.on('open-external-url', handler)
    return () => { ipcRenderer.removeListener('open-external-url', handler) }
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

  // ── Dropdown popup (separate transparent BrowserWindow) ──
  // Parent renderer (Toolbar) calls openDropdown / closeDropdown and listens
  // for onDropdownEvent. The popup renderer (dropdown.tsx) calls
  // dropdownPopupEvent / dropdownPopupResize and listens for onDropdownPopupSpec.
  // See src/main/dropdown-window.ts for the lifecycle.
  openDropdown: (spec: unknown): void => { ipcRenderer.send('dropdown:open', spec) },
  closeDropdown: (): void => { ipcRenderer.send('dropdown:close') },
  onDropdownEvent: (callback: (evt: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, evt: unknown) => callback(evt)
    ipcRenderer.on('dropdown:event', handler)
    return () => { ipcRenderer.removeListener('dropdown:event', handler) }
  },
  // Popup-renderer-only methods (no-ops in the parent renderer).
  dropdownPopupEvent: (evt: unknown): void => { ipcRenderer.send('dropdown:popup-event', evt) },
  dropdownPopupResize: (size: { width: number; height: number }): void => {
    ipcRenderer.send('dropdown:popup-resize', size)
  },
  onDropdownPopupSpec: (callback: (spec: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, spec: unknown) => callback(spec)
    ipcRenderer.on('dropdown:popup-spec', handler)
    return () => { ipcRenderer.removeListener('dropdown:popup-spec', handler) }
  },

  // ── Update toast popup (separate transparent BrowserWindow) ──
  showUpdateToast: (spec: unknown): void => { ipcRenderer.send('update-toast:show', spec) },
  hideUpdateToast: (): void => { ipcRenderer.send('update-toast:hide') },
  onUpdateToastEvent: (callback: (evt: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, evt: unknown) => callback(evt)
    ipcRenderer.on('update-toast:event', handler)
    return () => { ipcRenderer.removeListener('update-toast:event', handler) }
  },
  updateToastPopupEvent: (evt: unknown): void => { ipcRenderer.send('update-toast:popup-event', evt) },
  updateToastPopupResize: (size: { width: number; height: number }): void => {
    ipcRenderer.send('update-toast:popup-resize', size)
  },
  onUpdateToastPopupSpec: (callback: (spec: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, spec: unknown) => callback(spec)
    ipcRenderer.on('update-toast:popup-spec', handler)
    return () => { ipcRenderer.removeListener('update-toast:popup-spec', handler) }
  },
})
