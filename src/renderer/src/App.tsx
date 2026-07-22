import { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore, withoutSave, setDefaultNewTabUrl, setNewTabFocusPref, getVisibleTabOrder, type NewTabFocus } from './store/app-store'
import { normalizeURL, setSearchEngine } from './lib/url'
import { log } from './lib/log'
import { focusAndSelectUrlBar } from './lib/focus-url-bar'
import { setHistory } from './lib/history'
import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { WebviewPanel } from './components/WebviewPanel'
import { FindBar } from './components/FindBar'
import { SearchDialog } from './components/SearchDialog'
import { SettingsDialog, type SettingsTabRequest } from './components/SettingsDialog'
import { CommandPalette } from './components/CommandPalette'
import { Bookshelf, type Reading, type ReadingGroup } from './components/Bookshelf'
import { InputDialog } from './components/InputDialog'
import { MoveCopyTabDialog } from './components/MoveCopyTabDialog'
import { MoveCopyGroupDialog } from './components/MoveCopyGroupDialog'
import { OpenExternalLinkDialog } from './components/OpenExternalLinkDialog'
import { CloudSyncSetupDialog } from './components/CloudSyncSetupDialog'
import { HttpAuthDialog } from './components/HttpAuthDialog'
import { resolveVariantId, normalizeLightVariant, normalizeDarkVariant, normalizeDensity, applyDensity, type ThemeChoice, type Density } from './lib/theme'
import type { PermissionKind, PermissionPolicy, PermissionGrant } from './lib/permissions'

interface Settings {
  proxy: {
    mode: 'system' | 'direct' | 'custom'
    proxyRules: string
    proxyBypassRules: string
  }
  theme: ThemeChoice
  lightVariant: string
  darkVariant: string
  density: Density
  newTabFocus: NewTabFocus
  showTabNumbers: boolean
  defaultPageUrl: string
  searchEngine: string
  dohMode: 'off' | 'automatic' | 'secure'
  authServerAllowlist: string
  passwordManager: {
    enabled: boolean
    offerToSave: boolean
    autofill: 'automatic' | 'on-focus' | 'off'
  }
  /** Each action accepts up to two accelerator strings. Pre-dual-binding
   *  saves are migrated to one-element arrays in the main process. */
  keybindings: Record<string, string[]>
  /** Default policy per gated permission kind (mic, camera, …). */
  permissionDefaults: Record<PermissionKind, PermissionPolicy>
}

function normalizeNewTabFocus(value: string | undefined): NewTabFocus {
  return value === 'url' ? 'url' : 'site'
}

export type SyncCategory = 'state' | 'settings' | 'bookshelf' | 'history' | 'permissions' | 'extensions'

/** Combined config + runtime status for the synced-folder cloud sync. Returned
 *  by every cloud-sync IPC call and pushed on the onCloudSyncStatus channel. */
export interface CloudSyncInfo {
  enabled: boolean
  folderPath: string
  deviceId: string
  categories: Record<SyncCategory, boolean>
  state: 'disabled' | 'idle' | 'syncing' | 'error'
  lastSync: number
  error: string | null
  /** Non-null only while a sync run is in flight (first-load progress bar). */
  progress: { done: number; total: number } | null
}

/** Result of claiming the first-run cloud-sync setup offer. */
export interface CloudSyncSetupPrompt {
  shouldPrompt: boolean
  icloudAvailable: boolean
  suggestedFolder: string | null
}

/** An HTTP auth challenge (Basic/Digest/NTLM/Negotiate) awaiting credentials. */
export interface HttpAuthRequest {
  id: string
  url: string
  host: string
  port: number
  realm: string
  scheme: string
  isProxy: boolean
  /** Username to pre-fill — set when a saved credential was just rejected. */
  savedUsername?: string
  /** True when a saved credential exists for this host but didn't work, so the
   *  dialog can say "saved sign-in didn't work, update it". */
  hadSavedCredential?: boolean
  /** Whether to offer the "Remember on this device" checkbox (server auth only). */
  canSave?: boolean
}

/** Password-free view of a saved HTTP-auth sign-in, for the settings list. */
export interface SavedCredentialInfo {
  host: string
  username: string
  scheme: string
  realm: string
  updatedAt: number
}

/** Password-free metadata shown by Settings → Passwords. */
export interface PasswordEntryInfo {
  id: string
  partition: string
  origin: string
  name: string
  username: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

export interface PasswordImportResult {
  imported: number
  updated: number
  skipped: number
  invalid: number
}

export interface EdgePasswordSourceInfo {
  installed: boolean
  supported: boolean
  profiles: Array<{ id: string; name: string; passwordCount: number }>
  passwordCount: number
  reason?: string
}

export interface EdgePasswordImportResult extends PasswordImportResult {
  unsupported: number
  profiles: number
}

declare global {
  interface Window {
    electronAPI: {
      loadState: () => Promise<unknown>
      saveState: (state: unknown) => Promise<void>
      setupSession: (partition: string) => Promise<void>
      openWorkspaceWindow: (profileId: string, workspaceId: string, workspaceName: string, targetTabId?: string) => Promise<void>
      getOpenWorkspaceWindows: () => Promise<{ profileId: string; workspaceId: string }[]>
      getLastUsedWorkspace: (profileId: string) => Promise<string | null>
      setWindowTitle: (title: string) => Promise<void>
      setTitleBarOverlay: (options: { color: string; symbolColor: string; height: number }) => Promise<void>
      toggleUiDevTools?: () => Promise<void>
      toggleFocusedDevTools?: () => Promise<void>
      closeWindow: () => Promise<void>
      focusWindowRenderer: () => void
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
      clipboardWriteText: (text: string) => void
      loadSettings: () => Promise<Settings>
      saveSettings: (settings: Settings) => Promise<void>
      cloudSyncGetInfo: () => Promise<CloudSyncInfo>
      cloudSyncSetFolder: () => Promise<CloudSyncInfo>
      cloudSyncSetEnabled: (enabled: boolean) => Promise<CloudSyncInfo>
      cloudSyncSetCategories: (patch: Partial<Record<SyncCategory, boolean>>) => Promise<CloudSyncInfo>
      cloudSyncNow: () => Promise<CloudSyncInfo>
      cloudSyncRestartSetup: () => Promise<CloudSyncInfo>
      cloudSyncClaimSetupPrompt: () => Promise<CloudSyncSetupPrompt>
      cloudSyncSetupWithFolder: (folderPath: string) => Promise<CloudSyncInfo>
      cloudSyncDismissPrompt: () => Promise<CloudSyncInfo>
      onCloudSyncStatus: (callback: (info: CloudSyncInfo) => void) => () => void
      wipeAllData: () => Promise<void>
      getDefaultBrowserStatus: () => Promise<DefaultBrowserStatus>
      setAsDefaultBrowser: () => Promise<SetAsDefaultBrowserResult>
      openBookmarkFile: () => Promise<string | null>
      saveBookmarkFile: (html: string, suggestedName: string) => Promise<boolean>
      detachedWindowShow: (alwaysOnTop?: boolean) => void
      onShortcut: (callback: (action: string) => void) => () => void
      onStateUpdated: (callback: (state: unknown) => void) => () => void
      onOpenUrlAsTab: (callback: (url: string) => void) => () => void
      onOpenUrlAsTabBackground: (callback: (url: string) => void) => () => void
      onOpenExternalUrl: (callback: (url: string) => void) => () => void
      onHttpAuthRequest: (callback: (req: HttpAuthRequest) => void) => () => void
      httpAuthRespond: (resp: { id: string; username?: string; password?: string; remember?: boolean; cancel?: boolean }) => Promise<void>
      savedCredentialsList: () => Promise<SavedCredentialInfo[]>
      savedCredentialDelete: (host: string) => Promise<SavedCredentialInfo[]>
      savedCredentialsClearAll: () => Promise<SavedCredentialInfo[]>
      passwordsList: (partition: string) => Promise<PasswordEntryInfo[]>
      passwordUpsert: (input: {
        id?: string
        partition: string
        origin: string
        name?: string
        username: string
        password?: string
      }) => Promise<PasswordEntryInfo[]>
      passwordDelete: (partition: string, id: string) => Promise<PasswordEntryInfo[]>
      passwordsClear: (partition: string) => Promise<PasswordEntryInfo[]>
      passwordsImportCsv: (partition: string) => Promise<{
        result: PasswordImportResult
        entries: PasswordEntryInfo[]
      } | null>
      edgePasswordsDetect: () => Promise<EdgePasswordSourceInfo>
      passwordsImportEdge: (partition: string) => Promise<{
        result: EdgePasswordImportResult
        entries: PasswordEntryInfo[]
      }>
      onSettingsUpdated: (callback: (settings: unknown) => void) => () => void
      onActivateTab: (callback: (tabId: string) => void) => () => void
      checkForUpdates: () => Promise<UpdateStatus>
      downloadUpdate: () => Promise<void>
      installUpdate: () => Promise<void>
      getUpdaterStatus: () => Promise<UpdateStatus>
      getAppVersion: () => Promise<string>
      onUpdaterStatus: (callback: (status: UpdateStatus) => void) => () => void

      // Tab hosting (WebContentsView in main)
      tabCreate?: (tabId: string, partition: string, url: string, active: boolean, eagerLoad?: boolean, focusUrlBar?: boolean) => Promise<void>
      tabDestroy?: (tabId: string) => Promise<void>
      tabActivate?: (tabId: string, url: string) => Promise<void>
      tabFocus?: (tabId: string) => Promise<void>
      tabSetBounds?: (bounds: { x: number; y: number; width: number; height: number }) => void
      tabNavigate?: (tabId: string, url: string) => Promise<void>
      tabGoBack?: (tabId: string) => Promise<void>
      tabGoForward?: (tabId: string) => Promise<void>
      tabReload?: (tabId: string, ignoreCache?: boolean) => Promise<void>
      tabStop?: (tabId: string) => Promise<void>
      tabGetState?: (tabId: string) => Promise<{ isLoading: boolean; url: string; canGoBack: boolean; canGoForward: boolean } | null>
      tabExecuteJS?: (tabId: string, code: string) => Promise<unknown>
      tabToggleDevTools?: (tabId: string) => Promise<void>
      tabSavePage?: (tabId: string) => Promise<boolean>
      tabFindInPage?: (
        tabId: string,
        text: string,
        options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
      ) => void
      tabStopFindInPage?: (
        tabId: string,
        action: 'clearSelection' | 'keepSelection' | 'activateSelection',
      ) => void
      onTabEvent?: (callback: (evt: unknown) => void) => () => void

      // Extensions
      listExtensions?: () => Promise<unknown[]>
      installExtension?: (idOrUrl: string) => Promise<unknown>
      uninstallExtension?: (extensionId: string) => Promise<unknown[]>
      setExtensionEnabled?: (extensionId: string, enabled: boolean) => Promise<unknown[]>
      openExtensionOptions?: (extensionId: string) => Promise<string | null>
      openExtensionAction?: (extensionId: string, tabId: string | null) => Promise<boolean>
      onExtensionsChanged?: (callback: (extensions: unknown[]) => void) => () => void
      onTabContextSearch?: (callback: (query: string) => void) => () => void

      // Dropdown popup (separate transparent BrowserWindow)
      openDropdown?: (spec: unknown) => void
      closeDropdown?: () => void
      onDropdownEvent?: (callback: (evt: unknown) => void) => () => void
      dropdownPopupEvent?: (evt: unknown) => void
      dropdownPopupResize?: (size: { width: number; height: number }) => void
      onDropdownPopupSpec?: (callback: (spec: unknown) => void) => () => void

      // Update toast popup (separate transparent BrowserWindow)
      showUpdateToast?: (spec: unknown) => void
      hideUpdateToast?: () => void
      onUpdateToastEvent?: (callback: (evt: unknown) => void) => () => void
      updateToastPopupEvent?: (evt: unknown) => void
      updateToastPopupResize?: (size: { width: number; height: number }) => void
      onUpdateToastPopupSpec?: (callback: (spec: unknown) => void) => () => void

      // Downloads (per-session 'will-download' in main; see src/main/downloads.ts)
      downloadsList?: () => Promise<DownloadEntry[]>
      downloadsPause?: (id: string) => Promise<boolean>
      downloadsResume?: (id: string) => Promise<boolean>
      downloadsCancel?: (id: string) => Promise<boolean>
      downloadsRemove?: (id: string) => Promise<boolean>
      downloadsClear?: () => Promise<boolean>
      downloadsShowInFolder?: (id: string) => Promise<boolean>
      downloadsOpenFile?: (id: string) => Promise<boolean>
      downloadsRefresh?: () => Promise<DownloadEntry[]>
      onDownloadsUpdated?: (callback: (entries: DownloadEntry[]) => void) => () => void
      onCloseBlankDownloadTab?: (callback: (tabId: string) => void) => () => void

      // URL visit history for address-bar autocomplete (src/main/history.ts).
      historyList?: () => Promise<HistoryEntry[]>
      historyClear?: () => Promise<boolean>
      onHistoryUpdated?: (callback: (entries: HistoryEntry[]) => void) => () => void

      // Per-profile Bookshelf reading queue (src/main/bookshelf.ts).
      bookshelfList?: (profileId: string) => Promise<{ readings: Reading[]; groups: ReadingGroup[] }>
      bookshelfAdd?: (profileId: string, input: { url: string; title?: string; favicon?: string }) => Promise<Reading | null>
      bookshelfUpdate?: (profileId: string, id: string, patch: { title?: string; status?: 'toread' | 'archived' }) => Promise<boolean>
      bookshelfRemove?: (profileId: string, id: string) => Promise<boolean>
      bookshelfMoveReading?: (profileId: string, readingId: string, groupId: string | null) => Promise<boolean>
      bookshelfAddGroup?: (profileId: string, name: string) => Promise<ReadingGroup | null>
      bookshelfUpdateGroup?: (profileId: string, id: string, patch: { name?: string; color?: string; isCollapsed?: boolean }) => Promise<boolean>
      bookshelfRemoveGroup?: (profileId: string, id: string, deleteReadings: boolean) => Promise<boolean>
      bookshelfSaveOffline?: (profileId: string, id: string, partition: string) => Promise<boolean>
      onBookshelfUpdated?: (callback: (payload: { profileId: string; readings: Reading[]; groups: ReadingGroup[] }) => void) => () => void

      // Site permissions (src/main/permissions-store.ts + the index.ts gate).
      onPermissionRequest?: (
        callback: (payload: { requestId: string; origin: string; kinds: PermissionKind[]; tabId: string }) => void,
      ) => () => void
      respondPermission?: (requestId: string, decision: 'allow' | 'block', remember: boolean) => Promise<void>
      permissionsList?: () => Promise<PermissionGrant[]>
      permissionsSet?: (
        partition: string,
        origin: string,
        kind: PermissionKind,
        decision: 'allow' | 'block',
      ) => Promise<PermissionGrant[]>
      permissionsClear?: (partition: string, origin: string, kind: PermissionKind) => Promise<PermissionGrant[]>
      permissionsClearAll?: () => Promise<PermissionGrant[]>
      onPermissionOsBlocked?: (
        callback: (payload: { tabId: string; kinds: PermissionKind[] }) => void,
      ) => () => void
      openOsPermissionSettings?: (kind: 'microphone' | 'camera') => Promise<void>
    }
  }
}

export interface HistoryEntry {
  url: string
  title?: string
  visitedAt: number
  visits: number
}

export type DownloadState =
  | 'progressing'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'interrupted'

export interface DownloadEntry {
  id: string
  url: string
  filename: string
  savePath: string
  mimeType: string
  totalBytes: number
  receivedBytes: number
  state: DownloadState
  startedAt: number
  endedAt?: number
  originUrl?: string
  bytesPerSecond?: number
}

interface DefaultBrowserStatus {
  platform: string
  isDefault: boolean
  isDefaultHttp: boolean
  isDefaultHttps: boolean
  canSetProgrammatically: boolean
}

interface SetAsDefaultBrowserResult {
  status: DefaultBrowserStatus
  openedSystemPane: boolean
}

type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'not-available'; version: string }
  | { phase: 'available'; version: string; releaseNotes?: string | null }
  | { phase: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { phase: 'downloaded'; version: string; releaseNotes?: string | null }
  | { phase: 'error'; message: string }
  | { phase: 'unsupported' }

function getWindowParams(): { profileId: string | null; workspaceId: string | null; tabId: string | null } {
  const params = new URLSearchParams(window.location.search)
  return {
    profileId: params.get('profileId') || null,
    workspaceId: params.get('workspaceId') || null,
    tabId: params.get('tabId') || null,
  }
}

/** Convert an "rgb(r, g, b)" or "rgba(r, g, b, a)" string to "#rrggbb". */
function rgbStringToHex(rgb: string): string | null {
  const m = rgb.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i)
  if (!m) return null
  const hex = (n: string) => Number(n).toString(16).padStart(2, '0')
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`
}

/**
 * Resolve a CSS custom property (declared on :root via @theme or a
 * [data-theme*=""] override) to its final sRGB hex value by letting the
 * browser compute it on a hidden element. Needed because setTitleBarOverlay
 * expects "#rrggbb" strings, not the oklch() values used in CSS. Must be
 * called AFTER the theme/variant data attributes have been written so the
 * computed value reflects the currently active variant.
 */
function resolveCssVarToHex(varName: string): string | null {
  const el = document.createElement('div')
  el.style.backgroundColor = `var(${varName})`
  el.style.position = 'absolute'
  el.style.visibility = 'hidden'
  el.style.pointerEvents = 'none'
  document.body.appendChild(el)
  const rgb = getComputedStyle(el).backgroundColor
  document.body.removeChild(el)
  return rgbStringToHex(rgb)
}

function getOverlayColors(theme: ThemeChoice): { color: string; symbolColor: string; height: number } {
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  // Match the title bar background to the active variant's toolbar color
  // so the Windows min/max/close buttons blend in. Fall back to the legacy
  // hardcoded values if CSS resolution fails (shouldn't happen in practice).
  const toolbarHex = resolveCssVarToHex('--color-toolbar')
  return {
    color: toolbarHex ?? (isDark ? '#161616' : '#f7f7f7'),
    symbolColor: isDark ? '#d7d7d7' : '#303030',
    height: 47,
  }
}

function applyTheme(theme: ThemeChoice, lightVariant: string, darkVariant: string): void {
  const variant = resolveVariantId(theme, lightVariant, darkVariant)
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.setAttribute('data-theme-variant', variant)
  window.electronAPI.setTitleBarOverlay(getOverlayColors(theme))
  log.info('theme applied:', theme, variant)
}

const SIDEBAR_VISIBLE_KEY = 'newbro-sidebar-visible'

export default function App() {
  const [ready, setReady] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTabRequest, setSettingsTabRequest] = useState<SettingsTabRequest | null>(null)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  // First-run Cloud Sync offer. Null until this window claims the prompt (only
  // the first window across a multi-window restore wins the claim in main).
  const [syncPrompt, setSyncPrompt] = useState<CloudSyncSetupPrompt | null>(null)
  // Pending HTTP auth challenges (Basic/Digest/NTLM/Negotiate) for this window's
  // tabs. Shown one at a time; each is answered or cancelled back to main.
  const [httpAuthQueue, setHttpAuthQueue] = useState<HttpAuthRequest[]>([])
  // Right-hand Bookshelf sidebar visibility, persisted per machine.
  const [bookshelfOpen, setBookshelfOpen] = useState<boolean>(() => localStorage.getItem('newbro-bookshelf-open') === '1')
  useEffect(() => { localStorage.setItem('newbro-bookshelf-open', bookshelfOpen ? '1' : '0') }, [bookshelfOpen])

  // Offer to set up Cloud Sync on launch — and every launch until the user
  // enables it or picks "Don't show again". main's claim guarantees only one
  // window shows the offer across a multi-window restore; the short delay lets
  // the window finish painting first.
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      window.electronAPI.cloudSyncClaimSetupPrompt?.()
        .then((p) => { if (!cancelled && p?.shouldPrompt) setSyncPrompt(p) })
        .catch(() => {})
    }, 1200)
    return () => { cancelled = true; clearTimeout(t) }
  }, [])

  // HTTP auth prompts (Basic/Digest/NTLM/Negotiate) pushed from main when a
  // tab in this window hits a 401/407 challenge. Queue them; the dialog shows
  // one at a time.
  useEffect(() => {
    const cleanup = window.electronAPI.onHttpAuthRequest?.((req) => {
      log.event('http-auth:request', { host: req.host, scheme: req.scheme })
      setHttpAuthQueue((q) => [...q, req])
    })
    return cleanup
  }, [])
  const [findBarOpen, setFindBarOpen] = useState(false)
  // Counter that ticks on every find-in-page shortcut so a second Cmd+F
  // while the bar is already open re-focuses + selects the input (matches
  // Chrome / Firefox). The FindBar runs a focus effect on every increment.
  const [findBarFocusTick, setFindBarFocusTick] = useState(0)
  const [commentDialogOpen, setCommentDialogOpen] = useState(false)
  const [commentDefault, setCommentDefault] = useState('')
  const [newGroupDialogOpen, setNewGroupDialogOpen] = useState(false)
  const [newGroupForTabId, setNewGroupForTabId] = useState<string | null>(null)
  // Move/Copy Tab and Move/Copy Group dialogs. The pickers are fully
  // controlled — App owns the open state plus the source id, and resets
  // both on close so a fresh invocation always opens against the *current*
  // active tab/group rather than a stale one.
  const [tabPickerOpen, setTabPickerOpen] = useState(false)
  const [tabPickerMode, setTabPickerMode] = useState<'move' | 'copy'>('move')
  const [tabPickerTabIds, setTabPickerTabIds] = useState<string[]>([])
  const [groupPickerOpen, setGroupPickerOpen] = useState(false)
  const [groupPickerMode, setGroupPickerMode] = useState<'move' | 'copy'>('move')
  const [groupPickerGroupId, setGroupPickerGroupId] = useState<string | null>(null)
  // External-link picker. The URL the user is being asked to place sits in
  // `pendingUrl`; any URLs that arrive while the picker is already open are
  // parked in `queue` so we never silently drop a handoff. The dialog is
  // open whenever `pendingUrl` is non-null — no separate open flag needed.
  const [externalUrlPending, setExternalUrlPending] = useState<string | null>(null)
  const [externalUrlQueue, setExternalUrlQueue] = useState<string[]>([])
  const shortcutHandlerRef = useRef<((action: string) => void) | null>(null)
  const webviewColumnRef = useRef<HTMLDivElement>(null)
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

  // Page-fullscreen "cinema mode". A video going fullscreen fills only the
  // tab's view rect, so the window chrome stays on screen. We lean into
  // that: hide the sidebar for extra width and let the Toolbar drop to
  // pure black (data-cinema) so it blends with the video's letterbox
  // bars; both are restored when the page leaves fullscreen.
  const [pageFullscreen, setPageFullscreen] = useState(false)
  const fullscreenTabRef = useRef<string | null>(null)
  const sidebarBeforeFullscreenRef = useRef<boolean | null>(null)

  useEffect(() => {
    const exitCinema = (): void => {
      if (fullscreenTabRef.current === null) return
      fullscreenTabRef.current = null
      setPageFullscreen(false)
      const saved = sidebarBeforeFullscreenRef.current
      sidebarBeforeFullscreenRef.current = null
      // Restore without touching localStorage — the persisted preference
      // must reflect the user's own toggle, not our temporary hide.
      if (saved !== null) setSidebarVisible(saved)
    }
    const cleanupEvents = window.electronAPI.onTabEvent?.((raw) => {
      const evt = raw as { type?: string; tabId?: string }
      if (evt.type === 'enter-html-full-screen' && evt.tabId) {
        if (fullscreenTabRef.current === null) {
          setSidebarVisible((v) => {
            sidebarBeforeFullscreenRef.current = v
            return false
          })
        }
        fullscreenTabRef.current = evt.tabId
        setPageFullscreen(true)
      } else if (evt.type === 'leave-html-full-screen' && evt.tabId === fullscreenTabRef.current) {
        exitCinema()
      }
    })
    // Switching to another tab (or closing the fullscreen one) doesn't
    // reliably emit leave-html-full-screen — restore the chrome ourselves.
    const unsubActive = useAppStore.subscribe((state, prev) => {
      if (
        state.activeTabId !== prev.activeTabId &&
        fullscreenTabRef.current !== null &&
        state.activeTabId !== fullscreenTabRef.current
      ) {
        exitCinema()
      }
    })
    return () => {
      cleanupEvents?.()
      unsubActive()
    }
  }, [])

  // Page fullscreen is hosted as cinema mode under the toolbar. Keep the UI
  // renderer's document black too, so any native fallback/backdrop exposed
  // around a video never flashes the themed app background.
  useEffect(() => {
    const root = document.documentElement
    if (pageFullscreen) {
      root.setAttribute('data-page-fullscreen', '')
      // The Windows caption buttons (titleBarOverlay) are OS-drawn, so CSS
      // can't reach them — during cinema they kept their light theme color and
      // showed as a strip over the video. Repaint them black to blend into the
      // cinema toolbar. If Windows briefly keeps titlebar controls visible
      // during the transition, black symbols keep them from flashing white.
      window.electronAPI.setTitleBarOverlay({ color: '#000000', symbolColor: '#000000', height: 47 })
    } else {
      root.removeAttribute('data-page-fullscreen')
      // Restore the theme's caption-button colors.
      if (settings) window.electronAPI.setTitleBarOverlay(getOverlayColors(settings.theme))
    }
    return () => {
      root.removeAttribute('data-page-fullscreen')
      if (settings) window.electronAPI.setTitleBarOverlay(getOverlayColors(settings.theme))
    }
  }, [pageFullscreen, settings])

  const loadAndApplySettings = useCallback(async () => {
    try {
      const s = await window.electronAPI.loadSettings()
      const normalized: Settings = {
        ...s,
        lightVariant: normalizeLightVariant(s.lightVariant),
        darkVariant: normalizeDarkVariant(s.darkVariant),
        density: normalizeDensity(s.density),
        newTabFocus: normalizeNewTabFocus(s.newTabFocus),
      }
      setSettings(normalized)
      applyTheme(normalized.theme, normalized.lightVariant, normalized.darkVariant)
      applyDensity(normalized.density)
      setDefaultNewTabUrl(normalized.defaultPageUrl)
      setNewTabFocusPref(normalized.newTabFocus)
      setSearchEngine(normalized.searchEngine)
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

  // Address-bar autocomplete cache. Pull the full URL history snapshot once
  // at boot and keep it in sync with the per-update broadcast from main.
  // Suggestions resolve against this local mirror so keystrokes don't pay
  // an IPC round-trip — see src/renderer/src/lib/history.ts.
  useEffect(() => {
    let alive = true
    void window.electronAPI.historyList?.().then((list) => {
      if (!alive) return
      setHistory((list as HistoryEntry[]) || [])
    })
    const cleanup = window.electronAPI.onHistoryUpdated?.((list) => {
      setHistory((list as HistoryEntry[]) || [])
    })
    return () => { alive = false; cleanup?.() }
  }, [])

  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeProfileId = useAppStore((s) => s.activeProfileId)
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
    const getOrderedTabIdsForActive = (): string[] => {
      const state = useAppStore.getState()
      const profile = state.profiles.find((p) => p.id === state.activeProfileId)
      if (!profile || !state.activeWorkspaceId) return []
      const workspace = profile.workspaces.find((w) => w.id === state.activeWorkspaceId)
      if (!workspace) return []
      return getVisibleTabOrder(workspace)
    }

    const cycleTab = (direction: 1 | -1) => {
      const orderedTabIds = getOrderedTabIdsForActive()
      const state = useAppStore.getState()
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
      // tab-1..tab-9 quick-jump: parse the digit and index into the same
      // visible-order list cycleTab uses, so what you press matches what
      // you see numbered in the sidebar.
      if (action.startsWith('tab-')) {
        const n = parseInt(action.slice('tab-'.length), 10)
        if (Number.isInteger(n) && n >= 1 && n <= 9) {
          const orderedTabIds = getOrderedTabIdsForActive()
          const target = orderedTabIds[n - 1]
          if (target) s.setActiveTab(target)
          return
        }
      }
      switch (action) {
        case 'new-tab':
          if (s.activeTabGroupId) s.addTab(s.activeTabGroupId)
          else if (s.activeWorkspaceId) s.addUngroupedTab(s.activeWorkspaceId)
          break
        case 'close-tab':
          if (s.activeTabId) s.closeTab(s.activeTabId)
          break
        case 'reopen-closed-tab':
          s.reopenClosedTab(windowWorkspaceId ?? undefined)
          break
        case 'add-to-bookshelf': {
          const tab = s.getActiveTab()
          const pid = windowProfileId ?? s.activeProfileId
          log.action('add-to-bookshelf', {
            hasTab: !!tab,
            pid,
            bridge: typeof window.electronAPI.bookshelfAdd,
          })
          if (tab && pid && window.electronAPI.bookshelfAdd) {
            window.electronAPI.bookshelfAdd(pid, { url: tab.url, title: tab.title, favicon: tab.favicon })
            setBookshelfOpen(true)
          }
          break
        }
        case 'toggle-bookshelf':
          setBookshelfOpen((v) => !v)
          break
        case 'duplicate-tab':
          if (s.activeTabId) s.duplicateTab(s.activeTabId)
          break
        case 'focus-url': {
          // The shared helper also asks main to pull OS keyboard focus back
          // to the parent webContents — necessary because tab pages live in
          // sibling WebContentsViews that otherwise keep OS focus and
          // intercept all typed characters.
          focusAndSelectUrlBar()
          break
        }
        case 'search':
          setSearchOpen((v) => !v)
          break
        case 'settings':
          setSettingsOpen((v) => !v)
          break
        case 'about':
        case 'open-settings-about':
          // Sent by the macOS app menu's "About Newbro" entry and the
          // in-app About affordances. Opens the settings window (if not
          // already open) and forces the About pane via a versioned
          // request so re-clicking always lands there.
          setSettingsTabRequest({ tab: 'about', v: Date.now() })
          setSettingsOpen(true)
          break
        case 'command-palette':
          setCommandPaletteOpen((v) => !v)
          break
        case 'find-in-page':
          setFindBarOpen(true)
          setFindBarFocusTick((t) => t + 1)
          break
        case 'toggle-sidebar':
          toggleSidebar()
          break
        case 'back': {
          if (s.activeTabId) window.electronAPI.tabGoBack?.(s.activeTabId)
          break
        }
        case 'forward': {
          if (s.activeTabId) window.electronAPI.tabGoForward?.(s.activeTabId)
          break
        }
        case 'reload': {
          if (!s.activeTabId) break
          // Reload, not re-navigate. Going through tabNavigate(currentUrl)
          // would push a fresh history entry every time the user hits Cmd+R
          // and diverge from the URL-bar-Enter-on-unchanged-URL path, which
          // already lands here via tabReload. Match Chrome's behaviour and
          // keep all three refresh entry points (Cmd+R, refresh icon,
          // Enter on unchanged URL) on the same call.
          window.electronAPI.tabReload?.(s.activeTabId, true)
          break
        }
        case 'page-devtools':
          if (s.activeTabId) window.electronAPI.tabToggleDevTools?.(s.activeTabId)
          break
        case 'ui-devtools':
          window.electronAPI.toggleUiDevTools?.()
          break
        case 'save-page':
          // Main owns the dialog + Chromium save call; fire-and-forget here.
          if (s.activeTabId) window.electronAPI.tabSavePage?.(s.activeTabId)
          break
        case 'next-tab':
          cycleTab(1)
          break
        case 'prev-tab':
          cycleTab(-1)
          break
        case 'new-workspace':
          // Workspace creation needs a name from a dialog; the Toolbar already
          // owns that dialog (it's used by the New Workspace button), so we
          // just ping it via a window event rather than duplicating the UI.
          window.dispatchEvent(new Event('newbro-open-new-workspace-dialog'))
          break
        case 'import-workspaces':
          // Same pattern as new-workspace: the Toolbar owns the file picker
          // + ImportWorkspaceDialog state, we just trigger it from afar.
          window.dispatchEvent(new Event('newbro-open-import-workspaces'))
          break
        case 'export-workspaces':
          // Same pattern: the Toolbar owns the ExportWorkspaceDialog and the
          // save-bookmark-file IPC call.
          window.dispatchEvent(new Event('newbro-open-export-workspaces'))
          break
        case 'rename-profile':
          // Toolbar owns the rename InputDialog + the rename-profile case
          // in handleDialogConfirm. The listener side picks "active profile"
          // as the rename target — same thing the user would get from the
          // profile-dropdown row.
          window.dispatchEvent(new Event('newbro-rename-active-profile'))
          break
        case 'delete-profile':
          // Toolbar owns the confirm dialog + window-close cascade.
          window.dispatchEvent(new Event('newbro-delete-active-profile'))
          break
        case 'rename-workspace':
          window.dispatchEvent(new Event('newbro-rename-active-workspace'))
          break
        case 'delete-workspace':
          window.dispatchEvent(new Event('newbro-delete-active-workspace'))
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
        case 'move-tab':
          if (s.activeTabId) {
            setTabPickerMode('move')
            setTabPickerTabIds([s.activeTabId])
            setTabPickerOpen(true)
          }
          break
        case 'copy-tab':
          if (s.activeTabId) {
            setTabPickerMode('copy')
            setTabPickerTabIds([s.activeTabId])
            setTabPickerOpen(true)
          }
          break
        case 'move-group':
          if (s.activeTabGroupId) {
            setGroupPickerMode('move')
            setGroupPickerGroupId(s.activeTabGroupId)
            setGroupPickerOpen(true)
          }
          break
        case 'copy-group':
          if (s.activeTabGroupId) {
            setGroupPickerMode('copy')
            setGroupPickerGroupId(s.activeTabGroupId)
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

    // Lands an in-app new-tab handoff in the active group of the current
    // workspace (falling back to the workspace's ungrouped surface), in
    // either foreground or background. Shared between the foreground
    // and background IPC channels — only the `background` arg differs.
    const placeIncomingTab = (url: string, background: boolean): void => {
      const s = useAppStore.getState()
      const wsId = s.activeWorkspaceId
      const groupId = s.activeTabGroupId
      // Verify the active group actually lives in the active workspace
      // before reusing it — activeTabGroupId is global state and can
      // briefly point at a group from a different workspace during
      // workspace switches.
      let groupInWorkspace = false
      if (wsId && groupId) {
        for (const p of s.profiles) {
          const w = p.workspaces.find((w) => w.id === wsId)
          if (w && w.tabGroups.some((g) => g.id === groupId)) {
            groupInWorkspace = true
            break
          }
        }
      }
      const activate = !background
      if (groupInWorkspace && groupId) {
        s.addTab(groupId, url, activate)
      } else if (wsId) {
        s.addUngroupedTab(wsId, url, activate)
      }
    }

    // Foreground new-tab handoffs (plain LMB on target="_blank",
    // Shift+Cmd+Click, programmatic chrome.tabs.create, etc.). Switches
    // to the new tab — matches Chrome / Firefox default for unmodified
    // clicks that produce a new tab.
    const cleanupPopup = window.electronAPI.onOpenUrlAsTab((url) => {
      log.event('open-url-as-tab', url)
      placeIncomingTab(url, /* background */ false)
    })

    // Main asks us to close a tab that was created solely to trigger a
    // download (see src/main/downloads.ts). We route through closeTab so
    // the store's sidebar order, active-tab fallback, and history all
    // update consistently.
    const cleanupBlankDownloadTab = window.electronAPI.onCloseBlankDownloadTab?.((tabId) => {
      log.event('downloads:close-blank-tab', tabId)
      useAppStore.getState().closeTab(tabId)
    })

    // Background new-tab handoffs (Cmd/Ctrl+Click, middle-click, RMB →
    // Open in New Tab). Opens behind the current tab. The background
    // tab is also flagged for eager loading in the store so the page
    // starts fetching immediately instead of waiting for the user to
    // switch — without this, the user would land on a blank page when
    // they finally pick it up.
    const cleanupBackground = window.electronAPI.onOpenUrlAsTabBackground((url) => {
      log.event('open-url-as-tab-background', url)
      placeIncomingTab(url, /* background */ true)
    })

    // OS-routed handoffs (default-browser link click, second-instance
    // argv, etc.) — different channel. Route to the picker so the user
    // can choose where the incoming link lands. If the picker is already
    // showing a previous URL, queue the newcomer so we drain them one
    // at a time.
    const cleanupExternal = window.electronAPI.onOpenExternalUrl((url) => {
      log.event('open-external-url', url)
      setExternalUrlPending((current) => {
        if (current) {
          setExternalUrlQueue((q) => [...q, url])
          return current
        }
        return url
      })
    })

    const cleanupSettings = window.electronAPI.onSettingsUpdated((newSettings) => {
      log.ipc('settings:updated received')
      const raw = newSettings as Settings
      const s: Settings = {
        ...raw,
        lightVariant: normalizeLightVariant(raw.lightVariant),
        darkVariant: normalizeDarkVariant(raw.darkVariant),
        density: normalizeDensity(raw.density),
        newTabFocus: normalizeNewTabFocus(raw.newTabFocus),
      }
      setSettings(s)
      applyTheme(s.theme, s.lightVariant, s.darkVariant)
      applyDensity(s.density)
      setDefaultNewTabUrl(s.defaultPageUrl)
      setNewTabFocusPref(s.newTabFocus)
      setSearchEngine(s.searchEngine)
    })

    const cleanupActivateTab = window.electronAPI.onActivateTab((tabId) => {
      log.event('activate-tab', tabId)
      useAppStore.getState().setActiveTab(tabId)
    })

    // "Copy and search" from the tab's right-click menu: main relays the
    // selection here, we resolve it through the user's configured search
    // engine (normalizeURL) and open it as a new tab.
    const cleanupContextSearch = window.electronAPI.onTabContextSearch?.((query) => {
      const searchUrl = normalizeURL(query)
      if (!searchUrl) return
      const s = useAppStore.getState()
      if (s.activeTabGroupId) s.addTab(s.activeTabGroupId, searchUrl)
      else if (s.activeWorkspaceId) s.addUngroupedTab(s.activeWorkspaceId, searchUrl)
    })

    // Open Move/Copy pickers in response to context-menu choices in the
    // sidebar. The Sidebar dispatches a CustomEvent rather than reaching
    // into App's setters directly so the cross-component contract stays
    // narrow — App is the sole owner of the dialogs' open/source state.
    const handleOpenMoveCopyTab = (e: Event): void => {
      const detail = (e as CustomEvent<{ mode: 'move' | 'copy'; tabIds: string[] }>).detail
      if (!detail?.tabIds || detail.tabIds.length === 0) return
      setTabPickerMode(detail.mode)
      setTabPickerTabIds(detail.tabIds)
      setTabPickerOpen(true)
    }
    const handleOpenMoveCopyGroup = (e: Event): void => {
      const detail = (e as CustomEvent<{ mode: 'move' | 'copy'; groupId: string }>).detail
      if (!detail?.groupId) return
      setGroupPickerMode(detail.mode)
      setGroupPickerGroupId(detail.groupId)
      setGroupPickerOpen(true)
    }
    window.addEventListener('newbro:open-move-copy-tab', handleOpenMoveCopyTab)
    window.addEventListener('newbro:open-move-copy-group', handleOpenMoveCopyGroup)

    return () => {
      cleanupShortcut()
      cleanupState()
      cleanupPopup()
      cleanupBackground()
      cleanupBlankDownloadTab?.()
      cleanupExternal()
      cleanupSettings()
      cleanupActivateTab()
      cleanupContextSearch?.()
      window.removeEventListener('newbro:open-move-copy-tab', handleOpenMoveCopyTab)
      window.removeEventListener('newbro:open-move-copy-group', handleOpenMoveCopyGroup)
    }
  }, [hydrate, windowWorkspaceId, toggleSidebar])

  // When the user has the theme set to "system", follow the OS when it
  // flips between light and dark by re-resolving which variant to apply.
  // For explicit 'light' / 'dark' themes the OS preference is irrelevant,
  // so skip the update in that case.
  useEffect(() => {
    if (!settings) return
    if (settings.theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => {
      applyTheme(settings.theme, settings.lightVariant, settings.darkVariant)
    }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [settings])

  // Global Escape handler: whenever focus is parked somewhere in the chrome
  // (toolbar button, URL bar, sidebar item, etc.) instead of the active
  // webview, Esc blurs it and hands focus back to the page. Prevents
  // Chromium's :focus-visible ring from sticking on chrome buttons and
  // lets keystrokes always end up in the site content.
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const s = useAppStore.getState()
      if (!s.activeTabId) return
      const active = document.activeElement as HTMLElement | null
      // Already parked on the body — nothing to blur; main's tab view
      // already owns keystrokes.
      if (!active || active === document.body) return
      active.blur?.()
      // Hand OS keyboard focus to the active tab's page so keystrokes go to
      // the site. tabActivate only focuses on a *new* activation (it no-ops
      // for the already-active tab, which is exactly this case), so use the
      // dedicated focus call instead.
      window.electronAPI.tabFocus?.(s.activeTabId)
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [])

  const handleSaveSettings = async (newSettings: Settings) => {
    const normalized: Settings = {
      ...newSettings,
      lightVariant: normalizeLightVariant(newSettings.lightVariant),
      darkVariant: normalizeDarkVariant(newSettings.darkVariant),
      density: normalizeDensity(newSettings.density),
      newTabFocus: normalizeNewTabFocus(newSettings.newTabFocus),
    }
    setSettings(normalized)
    applyTheme(normalized.theme, normalized.lightVariant, normalized.darkVariant)
    applyDensity(normalized.density)
    setDefaultNewTabUrl(normalized.defaultPageUrl)
    setNewTabFocusPref(normalized.newTabFocus)
    setSearchEngine(normalized.searchEngine)
    await window.electronAPI.saveSettings(normalized)
  }

  if (!ready) return null

  return (
    <>
      <Toolbar windowWorkspaceId={windowWorkspaceId} sidebarVisible={sidebarVisible} pageFullscreen={pageFullscreen} onToggleSidebar={toggleSidebar} onOpenSettings={() => setSettingsOpen(true)} onOpenAbout={() => { setSettingsTabRequest({ tab: 'about', v: Date.now() }); setSettingsOpen(true) }} onOpenSearch={() => setSearchOpen(true)} onManageExtensions={() => { setSettingsTabRequest({ tab: 'extensions', v: Date.now() }); setSettingsOpen(true) }} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar visible={sidebarVisible} showTabNumbers={settings?.showTabNumbers ?? true} />
        <div ref={webviewColumnRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <FindBar
            open={findBarOpen}
            focusTick={findBarFocusTick}
            onClose={() => setFindBarOpen(false)}
          />
          <WebviewPanel />
        </div>
        {/* Hide the bookshelf while a page is in fullscreen (cinema mode) so
            the tab view can fill the full width — it reappears with its prior
            open state when fullscreen exits. */}
        <Bookshelf open={bookshelfOpen && !pageFullscreen} profileId={windowProfileId ?? activeProfileId} onClose={() => setBookshelfOpen(false)} />
      </div>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} windowWorkspaceId={windowWorkspaceId} />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
        onAppearancePreview={(p) => { applyTheme(p.theme, p.lightVariant, p.darkVariant); applyDensity(p.density) }}
        tabRequest={settingsTabRequest}
      />
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
      <MoveCopyTabDialog
        open={tabPickerOpen}
        mode={tabPickerMode}
        tabIds={tabPickerTabIds}
        currentWorkspaceId={activeWorkspaceId}
        onClose={() => {
          setTabPickerOpen(false)
          setTabPickerTabIds([])
        }}
      />
      <MoveCopyGroupDialog
        open={groupPickerOpen}
        mode={groupPickerMode}
        groupId={groupPickerGroupId}
        currentProfileId={activeProfileId}
        onClose={() => {
          setGroupPickerOpen(false)
          setGroupPickerGroupId(null)
        }}
      />
      <OpenExternalLinkDialog
        open={externalUrlPending !== null}
        url={externalUrlPending}
        currentWorkspaceId={activeWorkspaceId}
        onClose={() => {
          // Drain the queue so a backlog of OS handoffs (e.g. user clicked
          // several links while we weren't focused) gets walked through
          // instead of vanishing with the first dismissal.
          setExternalUrlQueue((q) => {
            const [next, ...rest] = q
            setExternalUrlPending(next ?? null)
            return rest
          })
        }}
      />
      {syncPrompt && (
        <CloudSyncSetupDialog
          open={syncPrompt.shouldPrompt}
          prompt={syncPrompt}
          onClose={() => setSyncPrompt(null)}
        />
      )}
      {httpAuthQueue[0] && (
        <HttpAuthDialog
          key={httpAuthQueue[0].id}
          request={httpAuthQueue[0]}
          onDone={() => setHttpAuthQueue((q) => q.slice(1))}
        />
      )}
    </>
  )
}
