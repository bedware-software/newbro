import React, { useState, useEffect, useRef, useCallback } from 'react'
import { X, RotateCcw, Sun, Moon, Monitor, AlertTriangle, Trash2, Download, CheckCircle2, Loader2, Puzzle, ExternalLink, Plus, Globe, Pin, PinOff, SlidersHorizontal, Palette, Keyboard, Info, Compass, ShieldCheck, Cloud, FolderOpen, RefreshCw, Wifi, Building2, KeyRound, Search, FileUp, Pencil } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CloudSyncInfo, SyncCategory, SavedCredentialInfo, PasswordEntryInfo, PasswordImportResult, EdgePasswordSourceInfo, EdgePasswordImportResult } from '../App'
import { DetachedWindow } from './DetachedWindow'
import { ConfirmDialog } from './ConfirmDialog'
import { LIGHT_VARIANTS, DARK_VARIANTS, DENSITIES, normalizeLightVariant, normalizeDarkVariant, normalizeDensity, DEFAULT_DENSITY, type ThemeChoice, type Density } from '../lib/theme'
import { useAppStore } from '../store/app-store'
import {
  PERMISSION_KINDS,
  PERMISSION_LABEL,
  type PermissionKind,
  type PermissionPolicy,
  type PermissionGrant,
} from '../lib/permissions'

interface ProxySettings {
  mode: 'system' | 'direct' | 'custom'
  proxyRules: string
  proxyBypassRules: string
}

interface Settings {
  theme: ThemeChoice
  lightVariant: string
  darkVariant: string
  density: Density
  newTabFocus: 'site' | 'url'
  showTabNumbers: boolean
  defaultPageUrl: string
  searchEngine: string
  proxy: ProxySettings
  dohMode: 'off' | 'automatic' | 'secure'
  authServerAllowlist: string
  passwordManager: {
    enabled: boolean
    offerToSave: boolean
    autofill: 'automatic' | 'on-focus' | 'off'
  }
  /** Each action accepts up to {@link MAX_BINDINGS_PER_ACTION} accelerators. */
  keybindings: Record<string, string[]>
  permissionDefaults: Record<PermissionKind, PermissionPolicy>
}

const MAX_BINDINGS_PER_ACTION = 2

function buildDefaultPermissionDefaults(): Record<PermissionKind, PermissionPolicy> {
  return Object.fromEntries(PERMISSION_KINDS.map((k) => [k, 'ask'])) as Record<
    PermissionKind,
    PermissionPolicy
  >
}

const PERMISSION_POLICY_LABEL: Record<PermissionPolicy, string> = {
  ask: 'Ask first',
  allow: 'Allow',
  block: 'Block',
}

interface AppearancePreview {
  theme: ThemeChoice
  lightVariant: string
  darkVariant: string
  density: Density
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

const SEARCH_ENGINES: Record<string, string> = {
  Google: 'https://www.google.com/search?q=%s',
  Yandex: 'https://yandex.ru/search/?text=%s',
  DuckDuckGo: 'https://duckduckgo.com/?q=%s',
  Unduck: 'https://unduck.link?q=%s',
}

const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  mode: 'system',
  proxyRules: '',
  proxyBypassRules: '<-loopback>',
}

const DEFAULT_KEYBINDINGS: Record<string, string[]> = {
  'new-tab': ['CmdOrCtrl+T'],
  'close-tab': ['CmdOrCtrl+W'],
  'reopen-closed-tab': ['CmdOrCtrl+Shift+T'],
  'close-window': ['CmdOrCtrl+Shift+W'],
  'new-workspace': ['CmdOrCtrl+Shift+N'],
  'next-tab': ['CmdOrCtrl+Tab'],
  'prev-tab': ['CmdOrCtrl+Shift+Tab'],
  'toggle-sidebar': ['CmdOrCtrl+\\'],
  'focus-url': ['CmdOrCtrl+L'],
  search: ['CmdOrCtrl+O'],
  'command-palette': ['CmdOrCtrl+P'],
  back: ['CmdOrCtrl+['],
  forward: ['CmdOrCtrl+]'],
  reload: ['CmdOrCtrl+R'],
  settings: ['CmdOrCtrl+,'],
  'page-devtools': ['CmdOrCtrl+Shift+I'],
  'ui-devtools': [],
  'save-page': ['CmdOrCtrl+S'],
  // Move/Copy/Duplicate actions ship unbound — they're surfaced through
  // context menus and the command palette by default. An empty array keeps
  // the parsing path in main/index.ts a no-op (parseAcceleratorShortcut
  // returns null) until the user records a binding here.
  'duplicate-tab': [],
  'move-tab': [],
  'copy-tab': [],
  'move-group': [],
  'copy-group': [],
  'add-to-bookshelf': [],
  'toggle-bookshelf': ['CmdOrCtrl+Shift+B'],
}

function cloneDefaultKeybindings(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, list] of Object.entries(DEFAULT_KEYBINDINGS)) {
    out[key] = [...list]
  }
  return out
}

/** True when the action's current bindings differ from the defaults — used
 *  to decide whether to show the per-row "reset to default" affordance. */
function isCustomBinding(action: string, current: string[]): boolean {
  const defaults = DEFAULT_KEYBINDINGS[action] || []
  if (current.length !== defaults.length) return true
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== defaults[i]) return true
  }
  return false
}

const ACTION_LABELS: Record<string, string> = {
  'new-tab': 'New Tab',
  'close-tab': 'Close Tab',
  'reopen-closed-tab': 'Reopen Closed Tab',
  'close-window': 'Close Window',
  'new-workspace': 'New Workspace',
  'next-tab': 'Next Tab',
  'prev-tab': 'Previous Tab',
  'toggle-sidebar': 'Toggle Sidebar',
  'focus-url': 'Focus Address Bar',
  search: 'Search Everything',
  'command-palette': 'Command Palette',
  back: 'Navigate Back',
  forward: 'Navigate Forward',
  reload: 'Reload Page',
  settings: 'Open Settings',
  'page-devtools': 'Toggle Page Developer Tools',
  'ui-devtools': 'Toggle UI Developer Tools',
  'find-in-page': 'Find in Page',
  'save-page': 'Save Page As',
  'tab-1': 'Switch to Tab 1',
  'tab-2': 'Switch to Tab 2',
  'tab-3': 'Switch to Tab 3',
  'tab-4': 'Switch to Tab 4',
  'tab-5': 'Switch to Tab 5',
  'tab-6': 'Switch to Tab 6',
  'tab-7': 'Switch to Tab 7',
  'tab-8': 'Switch to Tab 8',
  'tab-9': 'Switch to Tab 9',
  'duplicate-tab': 'Duplicate Tab',
  'move-tab': 'Move Tab',
  'copy-tab': 'Copy Tab',
  'move-group': 'Move Group',
  'copy-group': 'Copy Group',
  'add-to-bookshelf': 'Add to Bookshelf',
  'toggle-bookshelf': 'Toggle Bookshelf',
}

interface Props {
  open: boolean
  onClose: () => void
  settings: Settings | null
  onSave: (settings: Settings) => void
  onAppearancePreview?: (preview: AppearancePreview) => void
  /** Versioned request to switch panes. See {@link SettingsTabRequest}. */
  tabRequest?: SettingsTabRequest | null
}

/** Convert a KeyboardEvent into an Electron accelerator string */
function eventToKeyToken(e: KeyboardEvent): string | null {
  // Ignore bare modifier presses
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null

  // Prefer physical key code so Alt/Option combos don't become layout symbols.
  if (/^Key[A-Z]$/.test(e.code)) {
    return e.code.slice(3)
  }
  if (/^Digit[0-9]$/.test(e.code)) {
    return e.code.slice(5)
  }

  const codeMap: Record<string, string> = {
    Numpad0: '0',
    Numpad1: '1',
    Numpad2: '2',
    Numpad3: '3',
    Numpad4: '4',
    Numpad5: '5',
    Numpad6: '6',
    Numpad7: '7',
    Numpad8: '8',
    Numpad9: '9',
    NumpadAdd: '+',
    NumpadSubtract: '-',
    NumpadMultiply: '*',
    NumpadDivide: '/',
    NumpadDecimal: '.',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
  }
  if (codeMap[e.code]) return codeMap[e.code]

  // Map key names to Electron names
  const keyMap: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ' ': 'Space',
    Enter: 'Return',
    Escape: 'Escape',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
    ',': ',',
    '.': '.',
    '/': '/',
    '\\': '\\',
    '[': '[',
    ']': ']',
    '-': '-',
    '=': '=',
    '`': '`',
    ';': ';',
    "'": "'",
  }

  let key = keyMap[e.key] || e.key.toUpperCase()
  // Single char keys
  if (key.length === 1) key = key.toUpperCase()
  return key
}

/** Convert a KeyboardEvent into an Electron accelerator string */
function eventToAccelerator(e: KeyboardEvent): string | null {
  const parts: string[] = []

  if (e.metaKey || e.ctrlKey) parts.push('CmdOrCtrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')

  const key = eventToKeyToken(e)
  if (!key) return null
  parts.push(key)
  return parts.join('+')
}

/** Format an Electron accelerator for display as <kbd> elements */
function formatAccelerator(accel: string): React.ReactNode {
  const isMac = navigator.platform.includes('Mac')
  const parts = accel
    .replace(/CmdOrCtrl/g, isMac ? '⌘' : 'Ctrl')
    .replace(/Shift/g, isMac ? '⇧' : 'Shift')
    .replace(/Alt/g, isMac ? '⌥' : 'Alt')
    .split('+')
    .filter(Boolean)
  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((part, i) => (
        <kbd key={i}>{part}</kbd>
      ))}
    </span>
  )
}

export type SettingsTab = 'general' | 'appearance' | 'passwords' | 'network' | 'enterprise' | 'shortcuts' | 'extensions' | 'permissions' | 'sync' | 'about'
type Tab = SettingsTab

/** Order + labels for the Cloud Sync category checkboxes. */
const SYNC_CATEGORY_LABELS: { id: SyncCategory; label: string; hint: string }[] = [
  { id: 'state', label: 'Tabs & workspaces', hint: 'Profiles, workspaces, tab groups and tabs' },
  { id: 'bookshelf', label: 'Bookshelf', hint: 'Reading queue and groups' },
  { id: 'settings', label: 'Settings & keybindings', hint: 'Appearance, search, shortcuts, proxy' },
  { id: 'history', label: 'History', hint: 'Address-bar autocomplete history' },
  { id: 'permissions', label: 'Site permissions', hint: 'Per-site mic / camera / location decisions' },
  { id: 'extensions', label: 'Extensions', hint: 'Installed extensions (re-downloaded per device)' },
]

function syncStatusLabel(info: CloudSyncInfo | null): string {
  if (!info || !info.enabled) return 'Off'
  if (info.state === 'syncing') return 'Syncing…'
  if (info.state === 'error') return `Error: ${info.error ?? 'sync failed'}`
  if (info.lastSync) return `Last synced ${new Date(info.lastSync).toLocaleString()}`
  return 'Idle'
}

/**
 * Versioned request from the parent to switch to a specific tab. The
 * version bump is what fires the effect — re-issuing the same tab after a
 * dismiss-and-reopen still triggers a switch. Used by the macOS app menu
 * "About Newbro" entry to deep-link into the About pane.
 */
export interface SettingsTabRequest {
  tab: SettingsTab
  v: number
}

interface DefaultBrowserStatus {
  platform: string
  isDefault: boolean
  isDefaultHttp: boolean
  isDefaultHttps: boolean
  /** False on Windows: changing the default needs a manual confirm step in
   *  Settings → Default Apps, so the renderer surfaces a different button
   *  label and an extra hint when the system pane has just been opened. */
  canSetProgrammatically: boolean
}

interface SetAsDefaultBrowserResult {
  status: DefaultBrowserStatus
  openedSystemPane: boolean
}

interface ExtensionInfo {
  id: string
  name: string
  shortName?: string
  version: string
  description?: string
  enabled: boolean
  pinned: boolean
  path: string
  hostPermissions: string[]
  permissions: string[]
  hasOptionsPage: boolean
  hasAction: boolean
  actionDefaultTitle?: string
  iconUrl?: string | null
  installedAt: number
}

function normalizeKeybindingValue(raw: string): string {
  let value = raw.trim()
  if (!value) return ''

  value = value
    .replace(/\u21E5/g, 'Tab+')
    .replace(/\u2318/g, 'CmdOrCtrl+')
    .replace(/\u2325/g, 'Alt+')
    .replace(/\u21E7/g, 'Shift+')
    .replace(/\s+/g, '')
    .replace(/\+{2,}/g, '+')
    .replace(/^\+|\+$/g, '')

  return value
}

function readBindingList(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : []
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Normalize and dedupe the user's keybindings into a Record<string, string[]>.
 *  Tolerates legacy single-string values (one-element array on output) and
 *  fills in defaults for any action absent from the input — matching the
 *  shape we send back to main on save. */
function normalizeKnownKeybindings(
  raw: Record<string, unknown> | undefined,
): Record<string, string[]> {
  const next: Record<string, string[]> = cloneDefaultKeybindings()
  if (!raw) return next
  for (const key of Object.keys(DEFAULT_KEYBINDINGS)) {
    if (!(key in raw)) continue
    const list: string[] = []
    for (const candidate of readBindingList(raw[key])) {
      const normalized = normalizeKeybindingValue(candidate)
      if (!normalized) continue
      if (list.includes(normalized)) continue
      list.push(normalized)
      if (list.length >= MAX_BINDINGS_PER_ACTION) break
    }
    next[key] = list
  }
  return next
}

/** When the user records a new accelerator, refuse it if it's already bound
 *  to a different action (or to a different slot of the SAME action). The
 *  caller surfaces the returned conflict in an inline error. */
function findBindingConflict(
  bindings: Record<string, string[]>,
  action: string,
  slot: number,
  accel: string,
): { action: string; slot: number } | null {
  for (const [otherAction, list] of Object.entries(bindings)) {
    for (let i = 0; i < list.length; i++) {
      if (otherAction === action && i === slot) continue
      if (list[i] === accel) return { action: otherAction, slot: i }
    }
  }
  return null
}

export function SettingsDialog({ open, onClose, settings, onSave, onAppearancePreview, tabRequest }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>(() => tabRequest?.tab ?? 'general')

  // Switch to the parent-requested tab whenever a fresh request arrives —
  // even if the dialog was already open, so re-clicking "About" in the
  // macOS app menu always lands on About regardless of the previous tab.
  useEffect(() => {
    if (tabRequest) setActiveTab(tabRequest.tab)
  }, [tabRequest?.v])
  const [theme, setTheme] = useState<ThemeChoice>('dark')
  const [lightVariant, setLightVariant] = useState<string>(LIGHT_VARIANTS[0].id)
  const [darkVariant, setDarkVariant] = useState<string>(DARK_VARIANTS[0].id)
  const [density, setDensity] = useState<Density>(DEFAULT_DENSITY)
  const [newTabFocus, setNewTabFocus] = useState<'site' | 'url'>('site')
  const [showTabNumbers, setShowTabNumbers] = useState(true)
  const [defaultUrl, setDefaultUrl] = useState('')
  const [searchEngine, setSearchEngine] = useState(SEARCH_ENGINES.Google)
  const [proxy, setProxy] = useState<ProxySettings>({ ...DEFAULT_PROXY_SETTINGS })
  const [dohMode, setDohMode] = useState<'off' | 'automatic' | 'secure'>('automatic')
  const [authServerAllowlist, setAuthServerAllowlist] = useState('')
  const [passwordManagerEnabled, setPasswordManagerEnabled] = useState(true)
  const [passwordOfferToSave, setPasswordOfferToSave] = useState(true)
  const [passwordAutofill, setPasswordAutofill] = useState<'automatic' | 'on-focus' | 'off'>('automatic')
  const [keybindings, setKeybindings] = useState<Record<string, string[]>>(() => cloneDefaultKeybindings())
  const [permissionDefaults, setPermissionDefaults] = useState<Record<PermissionKind, PermissionPolicy>>(
    () => buildDefaultPermissionDefaults(),
  )
  // Per-site exceptions live in their own main-process store (not in Settings),
  // so they load/clear independently of the Save button.
  const [permissionGrants, setPermissionGrants] = useState<PermissionGrant[]>([])
  // Saved HTTP-auth sign-ins also live in their own main-process store (never
  // synced), so they load/remove independently of the Save button.
  const [savedCredentials, setSavedCredentials] = useState<SavedCredentialInfo[]>([])
  const profiles = useAppStore((s) => s.profiles)
  const activeProfileId = useAppStore((s) => s.activeProfileId)
  const [passwordEntries, setPasswordEntries] = useState<PasswordEntryInfo[]>([])
  const [passwordPartition, setPasswordPartition] = useState('')
  const [passwordSearch, setPasswordSearch] = useState('')
  const [passwordImporting, setPasswordImporting] = useState(false)
  const [edgeSource, setEdgeSource] = useState<EdgePasswordSourceInfo | null>(null)
  const [edgeDetecting, setEdgeDetecting] = useState(false)
  const [edgeImporting, setEdgeImporting] = useState(false)
  const [edgeImportConfirmOpen, setEdgeImportConfirmOpen] = useState(false)
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordClearConfirmOpen, setPasswordClearConfirmOpen] = useState(false)
  const [passwordEditor, setPasswordEditor] = useState<{
    id?: string
    origin: string
    username: string
    password: string
  } | null>(null)
  // Manual "add a site" form (for when a site never triggers an auto-prompt).
  const [addSiteOrigin, setAddSiteOrigin] = useState('')
  const [addSiteKind, setAddSiteKind] = useState<PermissionKind>('microphone')
  const [addSiteDecision, setAddSiteDecision] = useState<'allow' | 'block'>('allow')
  const [addSitePartition, setAddSitePartition] = useState('')
  const [addSiteError, setAddSiteError] = useState<string | null>(null)
  const [recordingTarget, setRecordingTarget] = useState<{ action: string; slot: number } | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [hostWindow, setHostWindow] = useState<Window | null>(null)
  const [syncRestartConfirmOpen, setSyncRestartConfirmOpen] = useState(false)
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false)
  const [appVersion, setAppVersion] = useState<string>('')
  const [appPaths, setAppPaths] = useState<{ userData: string; cache: string; logs: string; appName: string } | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ phase: 'idle' })
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([])
  const [extInput, setExtInput] = useState('')
  const [extInstalling, setExtInstalling] = useState(false)
  const [extError, setExtError] = useState<string | null>(null)
  const [defaultBrowserStatus, setDefaultBrowserStatus] = useState<DefaultBrowserStatus | null>(null)
  const [defaultBrowserBusy, setDefaultBrowserBusy] = useState(false)
  // Set after the user clicks "Make default" on Windows — the OS pane has
  // been opened and we want to remind them to actually pick Newbro there
  // until the next status refresh confirms the change took effect.
  const [defaultBrowserSystemPaneOpened, setDefaultBrowserSystemPaneOpened] = useState(false)
  const recordingRef = useRef<{ action: string; slot: number } | null>(null)
  const pendingTabChordRef = useRef(false)
  const originalAppearanceRef = useRef<AppearancePreview>({
    theme: 'dark',
    lightVariant: LIGHT_VARIANTS[0].id,
    darkVariant: DARK_VARIANTS[0].id,
    density: DEFAULT_DENSITY,
  })
  recordingRef.current = recordingTarget

  // Subscribe to updater status while the dialog is open so the
  // General → Updates section reflects live download / install events.
  useEffect(() => {
    if (!open) return
    const api = (window as any).electronAPI
    if (!api) return
    api.getAppVersion?.().then((v: string) => { if (v) setAppVersion(v) })
    api.getAppPaths?.().then((p: typeof appPaths) => { if (p) setAppPaths(p) })
    api.getUpdaterStatus?.().then((s: UpdateStatus) => { if (s) setUpdateStatus(s) })
    const cleanup = api.onUpdaterStatus?.((s: UpdateStatus) => setUpdateStatus(s))
    return cleanup
  }, [open])

  const handleCheckForUpdates = useCallback(async () => {
    const api = (window as any).electronAPI
    if (!api) return
    setUpdateStatus({ phase: 'checking' })
    try {
      const s = await api.checkForUpdates?.()
      if (s) setUpdateStatus(s)
    } catch (err: unknown) {
      setUpdateStatus({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const handleInstallUpdate = useCallback(() => {
    const api = (window as any).electronAPI
    api?.installUpdate?.()
  }, [])

  // Load the default-browser status whenever the Settings dialog opens, and
  // refresh whenever the popup regains focus. macOS shows a system prompt
  // that we can't observe directly — refreshing on focus catches the user
  // returning to the app after accepting it. Same idea for Windows after the
  // user picks Newbro in Settings → Default Apps and Cmd/Alt-Tabs back.
  useEffect(() => {
    if (!open) return
    const api = (window as any).electronAPI
    if (!api?.getDefaultBrowserStatus) return

    const refresh = (): void => {
      api.getDefaultBrowserStatus().then((s: DefaultBrowserStatus) => {
        if (!s) return
        setDefaultBrowserStatus(s)
        if (s.isDefault) setDefaultBrowserSystemPaneOpened(false)
      })
    }

    refresh()
    setDefaultBrowserSystemPaneOpened(false)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [open])

  const handleMakeDefaultBrowser = useCallback(async () => {
    const api = (window as any).electronAPI
    if (!api?.setAsDefaultBrowser) return
    setDefaultBrowserBusy(true)
    try {
      const result: SetAsDefaultBrowserResult = await api.setAsDefaultBrowser()
      if (result?.status) setDefaultBrowserStatus(result.status)
      setDefaultBrowserSystemPaneOpened(!!result?.openedSystemPane)
      // setAsDefaultProtocolClient returns synchronously, but on macOS the
      // OS prompt shown to the user is asynchronous — the actual default
      // doesn't change until they click "Use Newbro". Re-poll a few times
      // so the UI updates without requiring a manual focus/refresh.
      const delays = [800, 2000, 5000]
      for (const delay of delays) {
        setTimeout(() => {
          api.getDefaultBrowserStatus().then((s: DefaultBrowserStatus) => {
            if (!s) return
            setDefaultBrowserStatus(s)
            if (s.isDefault) setDefaultBrowserSystemPaneOpened(false)
          })
        }, delay)
      }
    } finally {
      setDefaultBrowserBusy(false)
    }
  }, [])

  const handleRefreshDefaultBrowser = useCallback(async () => {
    const api = (window as any).electronAPI
    if (!api?.getDefaultBrowserStatus) return
    const s: DefaultBrowserStatus = await api.getDefaultBrowserStatus()
    if (s) setDefaultBrowserStatus(s)
    if (s?.isDefault) setDefaultBrowserSystemPaneOpened(false)
  }, [])

  // ── Extensions ──
  // Load + subscribe when the Extensions tab becomes visible, or when the
  // dialog first opens — broadcasts from main keep the list fresh even if
  // the user stays on this tab across installs/uninstalls from elsewhere.
  useEffect(() => {
    if (!open) return
    const api = (window as any).electronAPI
    if (!api?.listExtensions) return
    api.listExtensions().then((list: ExtensionInfo[]) => setExtensions(list || []))
    const cleanup = api.onExtensionsChanged?.((list: ExtensionInfo[]) => setExtensions(list || []))
    return cleanup
  }, [open])

  const handleInstallExtension = useCallback(async () => {
    const trimmed = extInput.trim()
    if (!trimmed) return
    setExtError(null)
    setExtInstalling(true)
    try {
      const api = (window as any).electronAPI
      await api.installExtension(trimmed)
      setExtInput('')
    } catch (err: unknown) {
      setExtError(err instanceof Error ? err.message : String(err))
    } finally {
      setExtInstalling(false)
    }
  }, [extInput])

  const handleToggleExtension = useCallback(async (id: string, next: boolean) => {
    const api = (window as any).electronAPI
    const updated = await api.setExtensionEnabled(id, next)
    if (Array.isArray(updated)) setExtensions(updated)
  }, [])

  const handleTogglePinned = useCallback(async (id: string, next: boolean) => {
    const api = (window as any).electronAPI
    const updated = await api.setExtensionPinned?.(id, next)
    if (Array.isArray(updated)) setExtensions(updated)
  }, [])

  const handleUninstallExtension = useCallback(async (id: string) => {
    const api = (window as any).electronAPI
    const updated = await api.uninstallExtension(id)
    if (Array.isArray(updated)) setExtensions(updated)
  }, [])

  const handleOpenExtensionOptions = useCallback(async (id: string) => {
    const api = (window as any).electronAPI
    await api.openExtensionOptions(id)
    // After opening a new tab with chrome-extension:// URL, close the
    // settings dialog so the tab is visible behind it.
    onClose()
  }, [onClose])

  // Open an extension store URL as a new tab in the active workspace, then
  // close Settings so the user lands on the freshly-opened page.
  const handleOpenStoreUrl = useCallback((url: string) => {
    const s = useAppStore.getState()
    if (s.activeTabGroupId) s.addTab(s.activeTabGroupId, url)
    else if (s.activeWorkspaceId) s.addUngroupedTab(s.activeWorkspaceId, url)
    onClose()
  }, [onClose])

  // Init from settings
  useEffect(() => {
    if (open && settings) {
      const lv = normalizeLightVariant(settings.lightVariant)
      const dv = normalizeDarkVariant(settings.darkVariant)
      const dens = normalizeDensity(settings.density)
      setTheme(settings.theme)
      setLightVariant(lv)
      setDarkVariant(dv)
      setDensity(dens)
      setNewTabFocus(settings.newTabFocus === 'url' ? 'url' : 'site')
      setShowTabNumbers(settings.showTabNumbers !== false)
      originalAppearanceRef.current = { theme: settings.theme, lightVariant: lv, darkVariant: dv, density: dens }
      setDefaultUrl(settings.defaultPageUrl)
      setSearchEngine(settings.searchEngine || SEARCH_ENGINES.Google)
      setProxy({ ...DEFAULT_PROXY_SETTINGS, ...settings.proxy })
      setDohMode(
        settings.dohMode === 'off' || settings.dohMode === 'secure' ? settings.dohMode : 'automatic'
      )
      setAuthServerAllowlist(typeof settings.authServerAllowlist === 'string' ? settings.authServerAllowlist : '')
      setPasswordManagerEnabled(settings.passwordManager?.enabled !== false)
      setPasswordOfferToSave(settings.passwordManager?.offerToSave !== false)
      setPasswordAutofill(
        settings.passwordManager?.autofill === 'on-focus' || settings.passwordManager?.autofill === 'off'
          ? settings.passwordManager.autofill
          : 'automatic',
      )
      setKeybindings(normalizeKnownKeybindings(settings.keybindings))
      setPermissionDefaults({
        ...buildDefaultPermissionDefaults(),
        ...(settings.permissionDefaults || {}),
      })
    }
  }, [open, settings])

  // Load the per-site permission exceptions when that tab is shown (and
  // refresh on open) so the list reflects decisions made since last view.
  useEffect(() => {
    if (!open || activeTab !== 'permissions') return
    window.electronAPI.permissionsList?.().then(setPermissionGrants).catch(() => {})
  }, [open, activeTab])

  // Passwords are scoped to a browser profile, just like cookies and login
  // sessions. Select the active profile on first open, then keep the list in
  // sync with the profile picker in this pane.
  useEffect(() => {
    if (!open || activeTab !== 'passwords') return
    const active = profiles.find((profile) => profile.id === activeProfileId)?.partition
    const partition = passwordPartition || active || profiles[0]?.partition || ''
    if (!partition) return
    if (partition !== passwordPartition) setPasswordPartition(partition)
    window.electronAPI.passwordsList(partition).then(setPasswordEntries).catch((err) => {
      setPasswordError(err instanceof Error ? err.message : String(err))
    })
  }, [open, activeTab, profiles, activeProfileId, passwordPartition])

  // Edge detection reads profile names and password counts only. The actual
  // password database is not decrypted until the user confirms an import.
  useEffect(() => {
    if (!open || activeTab !== 'passwords' || !window.electronAPI.edgePasswordsDetect) return
    let cancelled = false
    setEdgeDetecting(true)
    window.electronAPI.edgePasswordsDetect()
      .then((source) => { if (!cancelled) setEdgeSource(source) })
      .catch(() => { if (!cancelled) setEdgeSource(null) })
      .finally(() => { if (!cancelled) setEdgeDetecting(false) })
    return () => { cancelled = true }
  }, [open, activeTab])

  // Load saved HTTP-auth sign-ins when the Enterprise tab is shown (they live in
  // their own store and never sync). Passwords are never returned — metadata only.
  useEffect(() => {
    if (!open || activeTab !== 'enterprise') return
    window.electronAPI.savedCredentialsList?.().then(setSavedCredentials).catch(() => {})
  }, [open, activeTab])

  // ── Cloud sync (synced-folder) ──
  const [syncInfo, setSyncInfo] = useState<CloudSyncInfo | null>(null)
  // Fetch current config/status on open, and live-subscribe to status pushes
  // (a background sync, or a change from another window).
  useEffect(() => {
    if (!open) return
    window.electronAPI.cloudSyncGetInfo?.().then((i) => setSyncInfo(i)).catch(() => {})
    const cleanup = window.electronAPI.onCloudSyncStatus?.((i) => setSyncInfo(i))
    return cleanup
  }, [open])

  const chooseSyncFolder = useCallback(() => {
    window.electronAPI.cloudSyncSetFolder?.().then(setSyncInfo).catch(() => {})
  }, [])
  const setSyncEnabled = useCallback((enabled: boolean) => {
    window.electronAPI.cloudSyncSetEnabled?.(enabled).then(setSyncInfo).catch(() => {})
  }, [])
  const toggleSyncCategory = useCallback((cat: SyncCategory, on: boolean) => {
    window.electronAPI.cloudSyncSetCategories?.({ [cat]: on }).then(setSyncInfo).catch(() => {})
  }, [])
  const runSyncNow = useCallback(() => {
    window.electronAPI.cloudSyncNow?.().then(setSyncInfo).catch(() => {})
  }, [])
  const restartSyncSetup = useCallback(() => {
    setSyncRestartConfirmOpen(false)
    window.electronAPI.cloudSyncRestartSetup?.().then(setSyncInfo).catch(() => {})
  }, [])

  const clearPermissionGrant = useCallback((grant: PermissionGrant) => {
    window.electronAPI
      .permissionsClear?.(grant.partition, grant.origin, grant.kind)
      .then(setPermissionGrants)
      .catch(() => {})
  }, [])

  const clearAllPermissionGrants = useCallback(() => {
    window.electronAPI.permissionsClearAll?.().then(setPermissionGrants).catch(() => {})
  }, [])

  const removeSavedCredential = useCallback((host: string) => {
    window.electronAPI.savedCredentialDelete?.(host).then(setSavedCredentials).catch(() => {})
  }, [])

  const clearAllSavedCredentials = useCallback(() => {
    window.electronAPI.savedCredentialsClearAll?.().then(setSavedCredentials).catch(() => {})
  }, [])

  const handlePasswordProfileChange = useCallback((partition: string) => {
    setPasswordPartition(partition)
    setPasswordSearch('')
    setPasswordNotice(null)
    setPasswordError(null)
    setPasswordEditor(null)
  }, [])

  const handleImportPasswords = useCallback(async () => {
    if (!passwordPartition) return
    setPasswordImporting(true)
    setPasswordNotice(null)
    setPasswordError(null)
    try {
      const imported = await window.electronAPI.passwordsImportCsv(passwordPartition)
      if (!imported) return
      setPasswordEntries(imported.entries)
      const r: PasswordImportResult = imported.result
      const parts = [`${r.imported} imported`, `${r.updated} updated`]
      if (r.skipped) parts.push(`${r.skipped} skipped`)
      if (r.invalid) parts.push(`${r.invalid} invalid`)
      setPasswordNotice(`${parts.join(' · ')}. Delete the plaintext CSV when you no longer need it.`)
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err))
    } finally {
      setPasswordImporting(false)
    }
  }, [passwordPartition])

  const handleImportEdgePasswords = useCallback(async () => {
    setEdgeImportConfirmOpen(false)
    if (!passwordPartition) return
    setEdgeImporting(true)
    setPasswordNotice(null)
    setPasswordError(null)
    try {
      const imported = await window.electronAPI.passwordsImportEdge(passwordPartition)
      setPasswordEntries(imported.entries)
      const r: EdgePasswordImportResult = imported.result
      const parts = [`${r.imported} imported`, `${r.updated} updated`]
      if (r.skipped) parts.push(`${r.skipped} skipped`)
      if (r.invalid) parts.push(`${r.invalid} invalid`)
      if (r.unsupported) parts.push(`${r.unsupported} protected by Edge`)
      setPasswordNotice(`${parts.join(' · ')}. Microsoft Edge was left unchanged.`)
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err))
    } finally {
      setEdgeImporting(false)
    }
  }, [passwordPartition])

  const handleSavePasswordEntry = useCallback(async () => {
    if (!passwordPartition || !passwordEditor) return
    setPasswordNotice(null)
    setPasswordError(null)
    try {
      const entries = await window.electronAPI.passwordUpsert({
        id: passwordEditor.id,
        partition: passwordPartition,
        origin: passwordEditor.origin,
        username: passwordEditor.username,
        // A blank password while editing means "keep the encrypted value".
        password: passwordEditor.id && !passwordEditor.password ? undefined : passwordEditor.password,
      })
      setPasswordEntries(entries)
      setPasswordEditor(null)
      setPasswordNotice(passwordEditor.id ? 'Password entry updated.' : 'Password entry added.')
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err))
    }
  }, [passwordPartition, passwordEditor])

  const handleDeletePassword = useCallback(async (id: string) => {
    if (!passwordPartition) return
    setPasswordEntries(await window.electronAPI.passwordDelete(passwordPartition, id))
    setPasswordEditor((editor) => editor?.id === id ? null : editor)
  }, [passwordPartition])

  const handleClearPasswords = useCallback(async () => {
    setPasswordClearConfirmOpen(false)
    if (!passwordPartition) return
    setPasswordEntries(await window.electronAPI.passwordsClear(passwordPartition))
    setPasswordEditor(null)
    setPasswordNotice('All saved passwords were removed from this profile.')
  }, [passwordPartition])

  const filteredPasswordEntries = passwordEntries.filter((entry) => {
    const query = passwordSearch.trim().toLowerCase()
    if (!query) return true
    return entry.origin.toLowerCase().includes(query)
      || entry.username.toLowerCase().includes(query)
      || entry.name.toLowerCase().includes(query)
  })

  const handleAddSite = useCallback(() => {
    const partition = addSitePartition || profiles[0]?.partition
    if (!partition) {
      setAddSiteError('No profile available to attach the rule to.')
      return
    }
    let raw = addSiteOrigin.trim()
    if (!raw) {
      setAddSiteError('Enter a site, e.g. https://meet.google.com')
      return
    }
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
    let origin: string
    try {
      origin = new URL(raw).origin
    } catch {
      setAddSiteError("That doesn't look like a valid site URL.")
      return
    }
    setAddSiteError(null)
    window.electronAPI
      .permissionsSet?.(partition, origin, addSiteKind, addSiteDecision)
      .then(setPermissionGrants)
      .catch(() => {})
    setAddSiteOrigin('')
  }, [addSitePartition, profiles, addSiteOrigin, addSiteKind, addSiteDecision])

  const profileNameForPartition = useCallback(
    (partition: string): string =>
      profiles.find((p) => p.partition === partition)?.name ?? partition,
    [profiles],
  )

  // Apply a recorded accelerator into a specific (action, slot). Rejects
  // and surfaces an inline error if the new combo is already bound to a
  // DIFFERENT action — or to a DIFFERENT slot of the same action — so the
  // user can't accidentally collide two commands on the same key.
  const commitRecordedAccel = useCallback((action: string, slot: number, accel: string) => {
    setKeybindings((prev) => {
      const conflict = findBindingConflict(prev, action, slot, accel)
      if (conflict) {
        const otherLabel = ACTION_LABELS[conflict.action] || conflict.action
        setConflictError(`That shortcut is already bound to "${otherLabel}". Clear it there first.`)
        return prev
      }
      setConflictError(null)
      const list = [...(prev[action] || [])]
      if (slot < list.length) list[slot] = accel
      else list.push(accel)
      return { ...prev, [action]: list.slice(0, MAX_BINDINGS_PER_ACTION) }
    })
  }, [])

  // Record keybinding
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = recordingRef.current
    if (!target) return
    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape') {
      pendingTabChordRef.current = false
      setRecordingTarget(null)
      return
    }

    // Only treat a bare Tab press (no modifiers) as the start of a Tab+X chord.
    // Tab with modifiers (e.g. Ctrl+Tab) is a regular accelerator.
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      pendingTabChordRef.current = true
      return
    }

    if (pendingTabChordRef.current) {
      pendingTabChordRef.current = false
      const key = eventToKeyToken(e)
      if (key && key !== 'Tab') {
        commitRecordedAccel(target.action, target.slot, `Tab+${key}`)
        setRecordingTarget(null)
      }
      return
    }

    const accel = eventToAccelerator(e)
    if (accel) {
      commitRecordedAccel(target.action, target.slot, accel)
      setRecordingTarget(null)
    }
  }, [commitRecordedAccel])

  useEffect(() => {
    if (!recordingTarget) pendingTabChordRef.current = false
  }, [recordingTarget])

  useEffect(() => {
    if (!recordingTarget || !hostWindow) return
    hostWindow.addEventListener('keydown', handleKeyDown, true)
    return () => hostWindow.removeEventListener('keydown', handleKeyDown, true)
  }, [recordingTarget, handleKeyDown, hostWindow])

  // Clear a specific slot for an action. Compacts the array so a cleared
  // slot 0 + filled slot 1 collapses to a single binding at index 0 — the
  // simplest rule that keeps storage and the UI consistent.
  const clearBindingSlot = useCallback((action: string, slot: number) => {
    setKeybindings((prev) => {
      const list = [...(prev[action] || [])]
      if (slot < list.length) list.splice(slot, 1)
      setConflictError(null)
      return { ...prev, [action]: list }
    })
  }, [])

  const startRecording = useCallback((action: string, slot: number) => {
    setConflictError(null)
    setRecordingTarget((prev) =>
      prev && prev.action === action && prev.slot === slot ? null : { action, slot },
    )
  }, [])

  const handleSave = () => {
    const normalizedProxy: ProxySettings = {
      ...proxy,
      proxyRules: proxy.proxyRules.trim(),
      proxyBypassRules: proxy.proxyBypassRules.trim() || '<-loopback>',
    }

    onSave({
      theme,
      lightVariant,
      darkVariant,
      density,
      newTabFocus,
      showTabNumbers,
      defaultPageUrl: defaultUrl,
      searchEngine,
      proxy: normalizedProxy,
      dohMode,
      authServerAllowlist: authServerAllowlist.trim(),
      passwordManager: {
        enabled: passwordManagerEnabled,
        offerToSave: passwordOfferToSave,
        autofill: passwordAutofill,
      },
      keybindings: normalizeKnownKeybindings(keybindings),
      permissionDefaults,
    })
    onClose()
  }

  const handleCancel = () => {
    onAppearancePreview?.(originalAppearanceRef.current)
    onClose()
  }

  const previewAppearance = (next: Partial<AppearancePreview>): void => {
    onAppearancePreview?.({ theme, lightVariant, darkVariant, density, ...next })
  }

  const handleResetKeybindings = () => {
    setKeybindings(cloneDefaultKeybindings())
    setConflictError(null)
  }

  const handleWipeAllData = () => {
    setWipeConfirmOpen(false)
    // Fire-and-forget — the main process will relaunch the app immediately.
    window.electronAPI.wipeAllData()
  }

  const canRestartSyncSetup = !!syncInfo
    && syncInfo.state !== 'syncing'
    && (syncInfo.enabled || !!syncInfo.folderPath || !!syncInfo.lastSync)

  if (!open) return null

  return (
    <DetachedWindow
      open={open}
      title="Settings - Newbro"
      width={920}
      height={720}
      onClose={handleCancel}
      onWindowChange={setHostWindow}
    >
      <div className="h-full bg-card text-card-foreground flex flex-col overflow-hidden">
        {/* Header */}
        <div
          data-detached-drag-handle
          className="flex items-center justify-between px-6 py-4 border-b border-border"
        >
          <h2 className="text-base font-semibold text-foreground">Settings</h2>
          <button
            data-detached-no-drag
            onClick={handleCancel}
            className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex-1 min-h-0 flex">
          {/* Sidebar — top group for the main panes, About pinned to the
              bottom under a separator (Edge / runwa-style). */}
          <aside className="w-52 bg-card border-r border-border p-3 flex flex-col shrink-0">
            <nav className="flex flex-col gap-1">
              {(
                [
                  { id: 'general', label: 'General', icon: SlidersHorizontal },
                  { id: 'appearance', label: 'Appearance', icon: Palette },
                  { id: 'passwords', label: 'Passwords', icon: KeyRound },
                  { id: 'network', label: 'Network', icon: Wifi },
                  { id: 'enterprise', label: 'Enterprise', icon: Building2 },
                  { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: Keyboard },
                  { id: 'extensions', label: 'Extensions', icon: Puzzle },
                  { id: 'permissions', label: 'Site permissions', icon: ShieldCheck },
                  { id: 'sync', label: 'Cloud Sync', icon: Cloud },
                ] as { id: Tab; label: string; icon: LucideIcon }[]
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={`flex items-center gap-2 h-8 px-2 rounded-md text-sm text-left transition-colors ${
                    activeTab === id
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  }`}
                >
                  <Icon size={14} className="shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </nav>
            <nav className="mt-auto pt-3 border-t border-border flex flex-col gap-1">
              <button
                type="button"
                onClick={() => setActiveTab('about')}
                className={`flex items-center gap-2 h-8 px-2 rounded-md text-sm text-left transition-colors ${
                  activeTab === 'about'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                }`}
              >
                <Info size={14} className="shrink-0" />
                About
              </button>
            </nav>
          </aside>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          {activeTab === 'appearance' && (
            <div className="space-y-8">
              {/* Theme */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Theme</h3>
                <p className="text-[11px] text-muted-foreground mb-3">
                  Choose the overall family, then pick a brightness variant for each family.
                </p>
                <div className="flex gap-2">
                  {([
                    { value: 'system' as const, label: 'System', icon: Monitor },
                    { value: 'light' as const, label: 'Light', icon: Sun },
                    { value: 'dark' as const, label: 'Dark', icon: Moon },
                  ]).map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      onClick={() => { setTheme(value); previewAppearance({ theme: value }) }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        theme === value
                          ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                          : 'bg-secondary text-secondary-foreground hover:bg-muted'
                      }`}
                    >
                      <Icon size={14} />
                      {label}
                    </button>
                  ))}
                </div>

                {/* Variant pickers — show only the family the current theme
                    can actually render. On 'system' we show both so the
                    user can tune each OS state independently. */}
                {(theme === 'light' || theme === 'system') && (
                  <div className="mt-3">
                    <div className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5">
                      <Sun size={11} />
                      Light variant
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {LIGHT_VARIANTS.map((v) => (
                        <button
                          key={v.id}
                          onClick={() => { setLightVariant(v.id); previewAppearance({ lightVariant: v.id }) }}
                          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                            lightVariant === v.id
                              ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                              : 'bg-secondary text-secondary-foreground hover:bg-muted'
                          }`}
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {(theme === 'dark' || theme === 'system') && (
                  <div className="mt-3">
                    <div className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5">
                      <Moon size={11} />
                      Dark variant
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {DARK_VARIANTS.map((v) => (
                        <button
                          key={v.id}
                          onClick={() => { setDarkVariant(v.id); previewAppearance({ darkVariant: v.id }) }}
                          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                            darkVariant === v.id
                              ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                              : 'bg-secondary text-secondary-foreground hover:bg-muted'
                          }`}
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Density */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Density</h3>
                <p className="text-[11px] text-muted-foreground mb-3">
                  Vertical breathing room between sidebar rows.
                </p>
                <div className="flex gap-2">
                  {DENSITIES.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => { setDensity(d.id); previewAppearance({ density: d.id }) }}
                      title={d.hint}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        density === d.id
                          ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                          : 'bg-secondary text-secondary-foreground hover:bg-muted'
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'passwords' && (
            <div className="space-y-7">
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Password manager</h3>
                <p className="text-[11px] text-muted-foreground mb-4 leading-relaxed">
                  Fill website sign-ins and offer to save changes. Passwords are encrypted with
                  Windows DPAPI or macOS Keychain and stay on this device.
                </p>

                <div className="divide-y divide-border border-y border-border">
                  <label className="flex items-center justify-between gap-4 py-3 cursor-pointer">
                    <span>
                      <span className="block text-sm text-foreground">Use Newbro password manager</span>
                      <span className="block text-[11px] text-muted-foreground mt-0.5">Enable filling and save prompts in website forms.</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={passwordManagerEnabled}
                      onChange={(event) => setPasswordManagerEnabled(event.target.checked)}
                      className="h-4 w-4 accent-primary shrink-0"
                    />
                  </label>
                  <label className={`flex items-center justify-between gap-4 py-3 ${passwordManagerEnabled ? 'cursor-pointer' : 'opacity-50'}`}>
                    <span>
                      <span className="block text-sm text-foreground">Offer to save passwords</span>
                      <span className="block text-[11px] text-muted-foreground mt-0.5">Ask after a website sign-in or password change.</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={passwordOfferToSave}
                      disabled={!passwordManagerEnabled}
                      onChange={(event) => setPasswordOfferToSave(event.target.checked)}
                      className="h-4 w-4 accent-primary shrink-0"
                    />
                  </label>
                  <label className={`flex items-center justify-between gap-4 py-3 ${passwordManagerEnabled ? '' : 'opacity-50'}`}>
                    <span>
                      <span className="block text-sm text-foreground">Autofill behavior</span>
                      <span className="block text-[11px] text-muted-foreground mt-0.5">Exact website matches only.</span>
                    </span>
                    <select
                      value={passwordAutofill}
                      disabled={!passwordManagerEnabled}
                      onChange={(event) => setPasswordAutofill(event.target.value as 'automatic' | 'on-focus' | 'off')}
                      className="h-8 px-2.5 text-xs bg-input text-foreground rounded-md border border-input focus:outline-none focus:ring-2 focus:ring-ring shrink-0"
                    >
                      <option value="automatic">Fill automatically</option>
                      <option value="on-focus">Choose on field focus</option>
                      <option value="off">Never fill</option>
                    </select>
                  </label>
                </div>
              </div>

              <div>
                <div className="flex items-end justify-between gap-4 mb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground mb-1">Saved passwords</h3>
                    <p className="text-[11px] text-muted-foreground">Each browser profile has its own password vault.</p>
                  </div>
                  <select
                    value={passwordPartition}
                    onChange={(event) => handlePasswordProfileChange(event.target.value)}
                    className="h-8 max-w-52 px-2.5 text-xs bg-input text-foreground rounded-md border border-input focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.partition}>{profile.name}</option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-3 border-y border-border py-3 mb-3">
                  <div className="h-9 w-9 rounded-md bg-secondary flex items-center justify-center text-muted-foreground shrink-0">
                    {edgeDetecting ? <Loader2 size={15} className="animate-spin" /> : <Compass size={15} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">Microsoft Edge</p>
                    {edgeDetecting ? (
                      <p className="text-[11px] text-muted-foreground mt-0.5">Looking for saved passwords…</p>
                    ) : edgeSource?.installed && edgeSource.passwordCount > 0 ? (
                      <p className="text-[11px] text-muted-foreground mt-0.5 truncate" title={edgeSource.profiles.filter((profile) => profile.passwordCount > 0).map((profile) => profile.name).join(', ')}>
                        {edgeSource.passwordCount} saved {edgeSource.passwordCount === 1 ? 'password' : 'passwords'} in {edgeSource.profiles.filter((profile) => profile.passwordCount > 0).length} {edgeSource.profiles.filter((profile) => profile.passwordCount > 0).length === 1 ? 'profile' : 'profiles'}
                      </p>
                    ) : edgeSource?.installed ? (
                      <p className="text-[11px] text-muted-foreground mt-0.5">Edge was found, but it has no saved passwords to import.</p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground mt-0.5">Microsoft Edge password data was not found on this computer.</p>
                    )}
                  </div>
                  {edgeSource?.supported && edgeSource.passwordCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setEdgeImportConfirmOpen(true)}
                      disabled={!passwordPartition || edgeImporting}
                      className="flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 shrink-0"
                    >
                      {edgeImporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                      {edgeImporting ? 'Importing…' : 'Import from Edge'}
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <button
                    type="button"
                    onClick={() => { setPasswordEditor({ origin: '', username: '', password: '' }); setPasswordError(null); setPasswordNotice(null) }}
                    disabled={!passwordPartition}
                    className="flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    <Plus size={13} />
                    Add password
                  </button>
                  <button
                    type="button"
                    onClick={handleImportPasswords}
                    disabled={!passwordPartition || passwordImporting}
                    className="flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-secondary text-secondary-foreground hover:bg-muted disabled:opacity-50"
                  >
                    {passwordImporting ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
                    Import CSV…
                  </button>
                  {passwordEntries.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setPasswordClearConfirmOpen(true)}
                      className="ml-auto h-8 px-2 text-[11px] font-medium text-destructive hover:underline"
                    >
                      Remove all
                    </button>
                  )}
                </div>

                {passwordNotice && (
                  <p className="mb-3 text-[11px] leading-relaxed text-foreground/80">{passwordNotice}</p>
                )}
                {passwordError && (
                  <p className="mb-3 text-[11px] leading-relaxed text-destructive">{passwordError}</p>
                )}

                {passwordEditor && (
                  <div className="mb-4 border-y border-border py-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-semibold text-foreground">
                        {passwordEditor.id ? 'Edit password entry' : 'Add password entry'}
                      </p>
                      <button
                        type="button"
                        onClick={() => setPasswordEditor(null)}
                        className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground"
                        aria-label="Close password editor"
                      >
                        <X size={13} />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="col-span-2">
                        <span className="block text-[11px] font-medium text-muted-foreground mb-1">Website</span>
                        <input
                          type="text"
                          value={passwordEditor.origin}
                          onChange={(event) => setPasswordEditor((current) => current ? { ...current, origin: event.target.value } : current)}
                          placeholder="https://example.com"
                          spellCheck={false}
                          className="w-full h-9 px-3 rounded-md bg-secondary border border-input text-sm text-foreground outline-none focus:border-ring focus:bg-background"
                        />
                      </label>
                      <label>
                        <span className="block text-[11px] font-medium text-muted-foreground mb-1">Username or email</span>
                        <input
                          type="text"
                          value={passwordEditor.username}
                          onChange={(event) => setPasswordEditor((current) => current ? { ...current, username: event.target.value } : current)}
                          autoComplete="off"
                          className="w-full h-9 px-3 rounded-md bg-secondary border border-input text-sm text-foreground outline-none focus:border-ring focus:bg-background"
                        />
                      </label>
                      <label>
                        <span className="block text-[11px] font-medium text-muted-foreground mb-1">
                          Password {passwordEditor.id && <span className="font-normal">(blank keeps current)</span>}
                        </span>
                        <input
                          type="password"
                          value={passwordEditor.password}
                          onChange={(event) => setPasswordEditor((current) => current ? { ...current, password: event.target.value } : current)}
                          autoComplete="new-password"
                          className="w-full h-9 px-3 rounded-md bg-secondary border border-input text-sm text-foreground outline-none focus:border-ring focus:bg-background"
                        />
                      </label>
                    </div>
                    <div className="flex justify-end gap-2 mt-3">
                      <button
                        type="button"
                        onClick={() => setPasswordEditor(null)}
                        className="h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:bg-muted"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleSavePasswordEntry}
                        className="h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90"
                      >
                        {passwordEditor.id ? 'Save changes' : 'Add password'}
                      </button>
                    </div>
                  </div>
                )}

                {passwordEntries.length > 0 && (
                  <div className="relative mb-2">
                    <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                    <input
                      type="search"
                      value={passwordSearch}
                      onChange={(event) => setPasswordSearch(event.target.value)}
                      placeholder="Search websites and usernames"
                      className="w-full h-9 pl-9 pr-3 rounded-md bg-secondary border border-input text-sm text-foreground outline-none focus:border-ring focus:bg-background"
                    />
                  </div>
                )}

                {passwordEntries.length === 0 ? (
                  <div className="py-10 text-center border-y border-border">
                    <KeyRound size={21} className="mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-foreground">No saved passwords in this profile</p>
                    <p className="text-[11px] text-muted-foreground mt-1">Import from Edge or save one the next time you sign in.</p>
                  </div>
                ) : filteredPasswordEntries.length === 0 ? (
                  <p className="py-8 text-center text-xs text-muted-foreground border-y border-border">No passwords match your search.</p>
                ) : (
                  <div className="border-y border-border divide-y divide-border">
                    {filteredPasswordEntries.map((entry) => (
                      <div key={entry.id} className="flex items-center gap-3 py-3">
                        <div className="h-8 w-8 rounded-md bg-secondary flex items-center justify-center text-muted-foreground shrink-0">
                          <Globe size={14} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-foreground truncate" title={entry.origin}>
                            {entry.name || new URL(entry.origin).host}
                          </p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {entry.username} · {new URL(entry.origin).host}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => { setPasswordEditor({ id: entry.id, origin: entry.origin, username: entry.username, password: '' }); setPasswordError(null); setPasswordNotice(null) }}
                          className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                          aria-label={`Edit ${entry.username}`}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeletePassword(entry.id)}
                          className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                          aria-label={`Remove ${entry.username}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
                  Direct Edge import asks the operating system to unlock the local Edge vault and leaves Edge unchanged.
                  CSV files contain readable passwords, so delete them when you no longer need them. Passwords are not included in Cloud Sync.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'sync' && (
            <div className="space-y-8">
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Cloud Sync</h3>
                <p className="text-[11px] text-muted-foreground mb-3">
                  Sync your data across devices through a folder that OneDrive, Dropbox, or Google
                  Drive already keeps in the cloud. No account needed — newbro just reads and writes
                  JSON files in the folder you pick.
                </p>

                {/* Enable toggle */}
                <label className="flex items-center gap-2.5 mb-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!syncInfo?.enabled}
                    disabled={!syncInfo?.folderPath}
                    onChange={(e) => setSyncEnabled(e.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="text-sm text-foreground">Enable cloud sync</span>
                  {!syncInfo?.folderPath && (
                    <span className="text-[11px] text-muted-foreground">(choose a folder first)</span>
                  )}
                </label>

                {/* Folder picker */}
                <div className="mb-1">
                  <div className="text-[11px] font-medium text-muted-foreground mb-1.5">Sync folder</div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0 text-xs font-mono px-2.5 py-1.5 rounded-md bg-secondary text-secondary-foreground truncate">
                      {syncInfo?.folderPath || 'Not set'}
                    </div>
                    <button
                      onClick={chooseSyncFolder}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-secondary text-secondary-foreground hover:bg-muted shrink-0"
                    >
                      <FolderOpen size={14} />
                      Choose folder…
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Pick a folder inside OneDrive / Dropbox / Google Drive so the files reach your
                    other devices.
                  </p>
                </div>
              </div>

              {/* What to sync */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">What to sync</h3>
                <p className="text-[11px] text-muted-foreground mb-3">
                  Window positions, logins / cookies, and offline saved pages stay on each device.
                </p>
                <div className="space-y-2">
                  {SYNC_CATEGORY_LABELS.map(({ id, label, hint }) => (
                    <label key={id} className="flex items-start gap-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={syncInfo?.categories?.[id] ?? true}
                        disabled={!syncInfo?.enabled}
                        onChange={(e) => toggleSyncCategory(id, e.target.checked)}
                        className="h-4 w-4 mt-0.5 accent-primary"
                      />
                      <span>
                        <span className="text-sm text-foreground block leading-tight">{label}</span>
                        <span className="text-[11px] text-muted-foreground">{hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Status + manual sync */}
              <div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={runSyncNow}
                    disabled={!syncInfo?.enabled || syncInfo?.state === 'syncing'}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RefreshCw size={14} className={syncInfo?.state === 'syncing' ? 'animate-spin' : ''} />
                    Sync now
                  </button>
                  <span className="text-[11px] text-muted-foreground">{syncStatusLabel(syncInfo)}</span>
                </div>
              </div>

              {/* Restart setup */}
              <div className="pt-4 border-t border-border">
                <h3 className="text-sm font-semibold text-foreground mb-1">Setup</h3>
                <p className="text-[11px] text-muted-foreground mb-3">
                  Restart setup to choose a fresh sync folder. Local data and files already in the
                  sync folder are left untouched.
                </p>
                <button
                  onClick={() => setSyncRestartConfirmOpen(true)}
                  disabled={!canRestartSyncSetup}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-secondary text-secondary-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RotateCcw size={14} />
                  Restart setup
                </button>
              </div>

              <p className="text-[11px] text-muted-foreground">
                If two devices change the same thing, the most recent change wins. Extensions are
                re-downloaded from the Chrome Web Store on each device (needs internet); their own
                data and logins are not synced.
              </p>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="space-y-6">
              {/* Default page URL */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Default New Tab URL</label>
                <input
                  type="text"
                  value={defaultUrl}
                  onChange={(e) => setDefaultUrl(e.target.value)}
                  placeholder="about:blank (leave empty for blank page)"
                  className="w-full h-9 px-3 rounded-md bg-secondary border border-input text-sm text-foreground outline-none focus:border-ring focus:bg-background"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  The URL to load when creating a new tab. Leave empty for a blank page.
                </p>
              </div>

              {/* New-tab focus + tab-number badges, side by side (2-column row) */}
              <div className="grid grid-cols-2 gap-4">
                {/* New-tab focus target */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-2">Focus on New Tab</label>
                  <div className="flex gap-2">
                    {([
                      { value: 'site' as const, label: 'Site', hint: 'Keystrokes go straight to the loaded page.' },
                      { value: 'url' as const, label: 'URL bar', hint: 'Type a URL right away, like a fresh Chrome tab.' },
                    ]).map(({ value, label, hint }) => (
                      <button
                        key={value}
                        onClick={() => setNewTabFocus(value)}
                        title={hint}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                          newTabFocus === value
                            ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                            : 'bg-secondary text-secondary-foreground hover:bg-muted'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Where keyboard focus lands when a new tab is opened.
                  </p>
                </div>

                {/* Sidebar tab-number badges */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-2">Tab Number Badges</label>
                  <div className="flex gap-2">
                    {([
                      { value: true, label: 'Show' },
                      { value: false, label: 'Hide' },
                    ] as const).map(({ value, label }) => (
                      <button
                        key={String(value)}
                        onClick={() => setShowTabNumbers(value)}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                          showTabNumbers === value
                            ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                            : 'bg-secondary text-secondary-foreground hover:bg-muted'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Show a small "1"…"9" badge on the first nine visible sidebar tabs, advertising the CmdOrCtrl+N quick-jump shortcut.
                  </p>
                </div>
              </div>

              {/* Search engine */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Default Search Engine</label>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(SEARCH_ENGINES).map(([name, url]) => (
                    <button
                      key={name}
                      onClick={() => setSearchEngine(url)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        searchEngine === url
                          ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                          : 'bg-secondary text-secondary-foreground hover:bg-muted'
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                  <button
                    onClick={() => setSearchEngine('')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      !Object.values(SEARCH_ENGINES).includes(searchEngine)
                        ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                        : 'bg-secondary text-secondary-foreground hover:bg-muted'
                    }`}
                  >
                    Custom
                  </button>
                </div>
                {(() => {
                  const isCustom = !Object.values(SEARCH_ENGINES).includes(searchEngine)
                  return (
                    <>
                      <input
                        type="text"
                        value={searchEngine}
                        onChange={(e) => isCustom && setSearchEngine(e.target.value)}
                        readOnly={!isCustom}
                        placeholder="https://example.com/search?q=%s"
                        className={`w-full h-9 px-3 mt-2 rounded-md border border-input text-sm outline-none font-mono ${
                          isCustom
                            ? 'bg-secondary text-foreground focus:border-ring focus:bg-background'
                            : 'bg-secondary/50 text-muted-foreground cursor-default'
                        }`}
                        autoFocus={isCustom}
                      />
                      {isCustom && (
                        <p className="text-[11px] text-muted-foreground mt-1">
                          Use %s as placeholder for the search query.
                        </p>
                      )}
                    </>
                  )
                })()}
              </div>

              {/* Default browser */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Default browser</label>
                <div className="flex items-start gap-4 px-4 py-3 border border-input rounded-md bg-card">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                      {defaultBrowserStatus?.isDefault ? (
                        <>
                          <CheckCircle2 size={12} className="text-primary shrink-0" />
                          Newbro is your default browser
                        </>
                      ) : (
                        <>
                          <Compass size={12} className="text-muted-foreground shrink-0" />
                          {defaultBrowserStatus
                            ? "Newbro isn't your default browser"
                            : 'Checking default browser status…'}
                        </>
                      )}
                    </p>
                    {defaultBrowserStatus && !defaultBrowserStatus.isDefault && (
                      <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                        {defaultBrowserStatus.platform === 'darwin'
                          ? 'macOS will ask you to confirm the change.'
                          : defaultBrowserStatus.platform === 'win32'
                            ? 'Windows opens its Default Apps page; pick Newbro for HTTP and HTTPS there.'
                            : 'Best effort via xdg-mime — your desktop environment may still prompt or ignore the change.'}
                      </p>
                    )}
                    {defaultBrowserSystemPaneOpened && !defaultBrowserStatus?.isDefault && (
                      <p className="text-[11px] text-foreground/80 mt-1 leading-relaxed">
                        Settings opened. After picking Newbro for HTTP and HTTPS, click Refresh.
                      </p>
                    )}
                  </div>
                  {defaultBrowserStatus?.isDefault ? null : defaultBrowserSystemPaneOpened ? (
                    <button
                      onClick={handleRefreshDefaultBrowser}
                      disabled={defaultBrowserBusy}
                      className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border bg-secondary text-secondary-foreground border-input hover:bg-accent disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <RotateCcw size={12} />
                      Refresh
                    </button>
                  ) : (
                    <button
                      onClick={handleMakeDefaultBrowser}
                      disabled={defaultBrowserBusy || !defaultBrowserStatus}
                      className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border bg-primary text-primary-foreground border-primary hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {defaultBrowserBusy ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : defaultBrowserStatus?.canSetProgrammatically ? (
                        <Compass size={12} />
                      ) : (
                        <ExternalLink size={12} />
                      )}
                      {defaultBrowserStatus?.canSetProgrammatically === false
                        ? 'Open Default Apps'
                        : 'Make default'}
                    </button>
                  )}
                </div>
              </div>

              {/* Danger Zone */}
              <div className="pt-4 mt-2 border-t border-destructive/30">
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle size={14} className="text-destructive" />
                  <h3 className="text-sm font-semibold text-destructive">Danger Zone</h3>
                </div>
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">Wipe all data</p>
                    <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                      Permanently deletes the entire Newbro application directory, including every
                      workspace, tab, bookmark, cookie, login session, cache, history, setting, and
                      keybinding. The app will relaunch as if freshly installed. This action cannot
                      be undone.
                    </p>
                  </div>
                  <button
                    onClick={() => setWipeConfirmOpen(true)}
                    className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-destructive text-destructive-foreground hover:opacity-90"
                  >
                    <Trash2 size={12} />
                    Wipe all data
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'network' && (
            <div className="space-y-6">
              {/* Proxy */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Proxy</label>
                <div className="flex flex-wrap gap-2 mb-2">
                  <button
                    onClick={() => setProxy((prev) => ({ ...prev, mode: 'system' }))}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      proxy.mode === 'system'
                        ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                        : 'bg-secondary text-secondary-foreground hover:bg-muted'
                    }`}
                  >
                    System
                  </button>
                  <button
                    onClick={() => setProxy((prev) => ({ ...prev, mode: 'direct' }))}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      proxy.mode === 'direct'
                        ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                        : 'bg-secondary text-secondary-foreground hover:bg-muted'
                    }`}
                  >
                    Direct (No Proxy)
                  </button>
                  <button
                    onClick={() => setProxy((prev) => ({ ...prev, mode: 'custom' }))}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      proxy.mode === 'custom'
                        ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                        : 'bg-secondary text-secondary-foreground hover:bg-muted'
                    }`}
                  >
                    Custom Proxy
                  </button>
                </div>

                {proxy.mode === 'custom' && (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={proxy.proxyRules}
                      onChange={(e) => setProxy((prev) => ({ ...prev, proxyRules: e.target.value }))}
                      placeholder="http://127.0.0.1:8080 or socks5://127.0.0.1:1080"
                      className="w-full h-9 px-3 rounded-md bg-secondary border border-input text-sm text-foreground outline-none focus:border-ring focus:bg-background"
                    />
                    <input
                      type="text"
                      value={proxy.proxyBypassRules}
                      onChange={(e) => setProxy((prev) => ({ ...prev, proxyBypassRules: e.target.value }))}
                      placeholder="<-loopback>;localhost;*.internal"
                      className="w-full h-9 px-3 rounded-md bg-secondary border border-input text-sm text-foreground outline-none focus:border-ring focus:bg-background"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Server and bypass list are applied using Chromium proxy rules.
                    </p>
                  </div>
                )}

                {(proxy.mode === 'system' || proxy.mode === 'direct') && (
                  <p className="text-[11px] text-muted-foreground">
                    {proxy.mode === 'system'
                      ? 'Uses your OS proxy settings.'
                      : 'Disables proxy and connects directly.'}
                  </p>
                )}
              </div>

              {/* DNS-over-HTTPS */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">DNS-over-HTTPS</label>
                <select
                  value={dohMode}
                  onChange={(e) => setDohMode(e.target.value as 'off' | 'automatic' | 'secure')}
                  className="w-full px-3 py-2 text-sm bg-input text-foreground rounded-md border border-input focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="off">Off (use OS DNS only)</option>
                  <option value="automatic">Automatic (OS DNS first, DoH as fallback) — recommended</option>
                  <option value="secure">Secure (DoH only — breaks corporate VPN intranet)</option>
                </select>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  Resolves DNS through Cloudflare + Google DoH endpoints.
                  {dohMode === 'secure' && (
                    <>
                      {' '}
                      <span className="text-destructive">
                        Warning: corporate-VPN intranet hosts (e.g. internal Jira) may stop resolving — their
                        records exist only in the VPN&apos;s internal DNS, which DoH bypasses.
                      </span>
                    </>
                  )}
                  {' '}Restart Newbro after changing this — Chromium applies DNS configuration at startup.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'enterprise' && (
            <div className="space-y-6">
              {/* Integrated Windows Authentication (SSO) */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Integrated Windows Authentication (SSO)</label>
                <textarea
                  value={authServerAllowlist}
                  onChange={(e) => setAuthServerAllowlist(e.target.value)}
                  rows={2}
                  spellCheck={false}
                  placeholder="owa.example.com, *.corp.example.com"
                  className="w-full px-3 py-2 text-sm bg-input text-foreground rounded-md border border-input focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                />
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  Hosts listed here sign in automatically with your <span className="text-foreground">Windows account</span> (NTLM / Kerberos),
                  with no password prompt — like Edge in the Local Intranet zone. Separate entries with
                  commas, spaces, or new lines; wildcards like <span className="font-mono">*.corp.example.com</span> are allowed.
                  {' '}
                  <span className="text-amber-500">
                    Only add hosts you trust — your Windows credentials are sent to them automatically.
                  </span>
                  {' '}This uses the account this PC is logged in as. If that isn&apos;t your corporate account, leave
                  this empty and use a <span className="text-foreground">saved sign-in</span> below instead. Restart Newbro after
                  changing this — it applies at startup.
                </p>
              </div>

              {/* Saved sign-ins (remembered HTTP-auth credentials) */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Saved sign-ins</label>
                <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                  Corporate credentials you asked Newbro to remember from the sign-in prompt. Newbro answers
                  that site&apos;s password challenge automatically so you don&apos;t retype it on every launch. Passwords
                  are encrypted on this device and never leave it — they are not cloud-synced.
                </p>
                {savedCredentials.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic">
                    No saved sign-ins yet. When a site prompts you to sign in, tick “Remember on this device”.
                  </p>
                ) : (
                  <div className="rounded-lg border border-input divide-y divide-border overflow-hidden">
                    {savedCredentials.map((c) => (
                      <div key={c.host} className="flex items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-foreground truncate" title={c.host}>{c.host}</p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {c.username}{c.scheme ? ` · ${c.scheme.toUpperCase()}` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeSavedCredential(c.host)}
                          className="shrink-0 flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <Trash2 size={12} />
                          Remove
                        </button>
                      </div>
                    ))}
                    <div className="flex justify-end px-3 py-2 bg-toolbar">
                      <button
                        type="button"
                        onClick={clearAllSavedCredentials}
                        className="text-[11px] font-medium text-destructive hover:underline"
                      >
                        Remove all
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'extensions' && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2">
                  <Puzzle size={14} />
                  Chrome Web Store extensions
                </h3>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Paste a Chrome Web Store URL or a 32-character extension ID.
                  Newbro downloads the .crx, unpacks it locally, and loads it
                  into every profile. Manifest V3 extensions work best; some
                  Manifest V2 features (notably blocking webRequest) are not
                  supported by Electron.
                </p>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => handleOpenStoreUrl('https://chromewebstore.google.com/category/extensions')}
                  className="h-8 px-3 flex items-center gap-1.5 rounded-md text-xs font-medium bg-secondary text-secondary-foreground hover:bg-muted border border-input"
                  title="Open Chrome Web Store"
                >
                  <Globe size={13} />
                  Chrome Web Store
                  <ExternalLink size={11} className="text-muted-foreground" />
                </button>
                <button
                  onClick={() => handleOpenStoreUrl('https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home')}
                  className="h-8 px-3 flex items-center gap-1.5 rounded-md text-xs font-medium bg-secondary text-secondary-foreground hover:bg-muted border border-input"
                  title="Open Edge Add-ons store"
                >
                  <Puzzle size={13} />
                  Edge Add-ons
                  <ExternalLink size={11} className="text-muted-foreground" />
                </button>
              </div>

              <div className="flex items-stretch gap-2">
                <input
                  type="text"
                  value={extInput}
                  onChange={(e) => setExtInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !extInstalling) handleInstallExtension() }}
                  placeholder="https://chromewebstore.google.com/detail/…/<id> or <id>"
                  className="flex-1 h-9 px-3 rounded-md bg-secondary border border-input text-sm text-foreground outline-none focus:border-ring focus:bg-background font-mono"
                  disabled={extInstalling}
                />
                <button
                  onClick={handleInstallExtension}
                  disabled={extInstalling || !extInput.trim()}
                  className={`flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-medium transition-colors ${
                    extInstalling || !extInput.trim()
                      ? 'bg-secondary text-muted-foreground cursor-default'
                      : 'bg-primary text-primary-foreground hover:bg-primary/80'
                  }`}
                >
                  {extInstalling ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Plus size={12} />
                  )}
                  Install
                </button>
              </div>

              {extError && (
                <div className="text-xs text-destructive flex items-start gap-1.5">
                  <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{extError}</span>
                </div>
              )}

              <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
                {extensions.length === 0 ? (
                  <div className="px-4 py-8 text-xs text-center text-muted-foreground">
                    No extensions installed yet.
                  </div>
                ) : (
                  extensions.map((ext) => (
                    <div key={ext.id} className="flex items-start gap-3 px-4 py-3">
                      <div className="shrink-0 w-8 h-8 rounded-md bg-muted flex items-center justify-center overflow-hidden">
                        {ext.iconUrl ? (
                          <img
                            src={ext.iconUrl}
                            className="w-8 h-8"
                            alt=""
                            onError={(e) => { (e.currentTarget.style.display = 'none') }}
                          />
                        ) : (
                          <Puzzle size={14} className="text-muted-foreground" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-foreground font-medium truncate">{ext.name}</div>
                        <div className="text-[11px] text-muted-foreground">v{ext.version}</div>
                        {ext.description && (
                          <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                            {ext.description}
                          </div>
                        )}
                        {(ext.hostPermissions.length > 0 || ext.permissions.length > 0) && (
                          <div className="text-[10px] text-muted-foreground mt-1 font-mono line-clamp-1" title={[...ext.hostPermissions, ...ext.permissions].join(', ')}>
                            {[...ext.hostPermissions, ...ext.permissions].slice(0, 4).join(', ')}
                            {[...ext.hostPermissions, ...ext.permissions].length > 4 ? ' …' : ''}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {ext.hasAction && (
                          <button
                            onClick={() => handleTogglePinned(ext.id, !(ext.pinned ?? true))}
                            className={`h-7 w-7 rounded-md flex items-center justify-center hover:bg-muted ${
                              (ext.pinned ?? true) ? 'text-foreground' : 'text-muted-foreground'
                            }`}
                            title={(ext.pinned ?? true) ? 'Hide from toolbar (unpin)' : 'Show in toolbar (pin)'}
                          >
                            {(ext.pinned ?? true) ? <Pin size={12} /> : <PinOff size={12} />}
                          </button>
                        )}
                        {ext.hasOptionsPage && (
                          <button
                            onClick={() => handleOpenExtensionOptions(ext.id)}
                            className="h-7 px-2 rounded-md text-[11px] bg-secondary text-secondary-foreground hover:bg-muted flex items-center gap-1"
                            title="Open options page"
                          >
                            <ExternalLink size={11} />
                            Options
                          </button>
                        )}
                        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                          <input
                            type="checkbox"
                            checked={ext.enabled}
                            onChange={(e) => handleToggleExtension(ext.id, e.target.checked)}
                          />
                          Enabled
                        </label>
                        <button
                          onClick={() => handleUninstallExtension(ext.id)}
                          className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          title="Uninstall"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {activeTab === 'shortcuts' && (
            <div>
              <div className="flex items-center justify-between gap-4 mb-4">
                <p className="text-sm text-muted-foreground">
                  Click on a shortcut to reassign it. Each command supports up
                  to {MAX_BINDINGS_PER_ACTION} bindings. Press Escape to cancel.
                </p>
                <button
                  type="button"
                  onClick={handleResetKeybindings}
                  className="shrink-0 flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <RotateCcw size={12} />
                  Reset to Defaults
                </button>
              </div>

              {conflictError && (
                <div className="mb-3 px-3 py-2 rounded-md border border-destructive/40 bg-destructive/10 text-xs text-destructive">
                  {conflictError}
                </div>
              )}

              <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
                {Object.keys(ACTION_LABELS).map((action) => {
                  const bindings = keybindings[action] || []
                  const isCustom = isCustomBinding(action, bindings)
                  return (
                    <div
                      key={action}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <span className="text-sm text-foreground">{ACTION_LABELS[action]}</span>
                      <div className="flex items-center gap-2">
                        {isCustom && (
                          <button
                            onClick={() => {
                              setKeybindings((prev) => ({
                                ...prev,
                                [action]: [...(DEFAULT_KEYBINDINGS[action] || [])],
                              }))
                              setConflictError(null)
                            }}
                            className="h-5 w-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground"
                            title="Reset to default"
                          >
                            <RotateCcw size={10} />
                          </button>
                        )}
                        {Array.from({ length: MAX_BINDINGS_PER_ACTION }).map((_, slot) => {
                          const isRecording =
                            recordingTarget?.action === action && recordingTarget.slot === slot
                          const binding = bindings[slot]
                          // Don't let the user start in a slot that's "ahead"
                          // of any empty slot to its left — keeps storage
                          // compact (no holes) and matches what the user
                          // sees: filling slot 1 only makes sense once
                          // slot 0 has something.
                          const disabled = !binding && !isRecording && slot > bindings.length
                          return (
                            <div key={slot} className="relative inline-flex items-center">
                              <button
                                onClick={() => !disabled && startRecording(action, slot)}
                                disabled={disabled}
                                className={`min-w-[120px] h-8 px-3 ${binding && !isRecording ? 'pr-7' : ''} rounded-md text-xs flex items-center justify-center transition-colors ${
                                  isRecording
                                    ? 'bg-background border border-ring text-primary'
                                    : binding
                                      ? 'bg-card border border-input text-foreground hover:bg-accent/40'
                                      : 'bg-card border border-dashed border-input text-muted-foreground/70 hover:bg-accent/30'
                                } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                              >
                                {isRecording
                                  ? 'Press keys...'
                                  : binding
                                    ? formatAccelerator(binding)
                                    : 'Add shortcut'}
                              </button>
                              {binding && !isRecording && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    clearBindingSlot(action, slot)
                                  }}
                                  className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                                  title="Clear this shortcut"
                                >
                                  <X size={10} />
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {activeTab === 'permissions' && (
            <div className="space-y-8 max-w-2xl">
              {/* Default behavior per capability */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Default behavior</label>
                <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                  What happens when a site asks to use a capability and you haven&apos;t
                  already chosen for that site. &ldquo;Ask first&rdquo; shows a prompt; your
                  per-site choices are remembered under Exceptions below.
                </p>
                <div className="rounded-lg border border-border divide-y divide-border">
                  {PERMISSION_KINDS.map((kind) => (
                    <div key={kind} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <span className="text-sm text-foreground">{PERMISSION_LABEL[kind]}</span>
                      <select
                        value={permissionDefaults[kind]}
                        onChange={(e) =>
                          setPermissionDefaults((prev) => ({
                            ...prev,
                            [kind]: e.target.value as PermissionPolicy,
                          }))
                        }
                        className="w-32 px-2 py-1.5 text-sm bg-input text-foreground rounded-md border border-input focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        {(['ask', 'allow', 'block'] as PermissionPolicy[]).map((p) => (
                          <option key={p} value={p}>{PERMISSION_POLICY_LABEL[p]}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">
                  Changes to defaults take effect after you click Save.
                </p>
              </div>

              {/* Per-site exceptions */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-foreground">Exceptions</label>
                  {permissionGrants.length > 0 && (
                    <button
                      onClick={clearAllPermissionGrants}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Clear all
                    </button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                  Sites you&apos;ve allowed or blocked. Removing an entry makes the site
                  ask again next time. These apply immediately.
                </p>

                {/* Add a site manually */}
                <div className="rounded-lg border border-border p-3 mb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {profiles.length > 1 && (
                      <select
                        value={addSitePartition || profiles[0]?.partition || ''}
                        onChange={(e) => setAddSitePartition(e.target.value)}
                        className="h-9 px-2 text-sm bg-input text-foreground rounded-md border border-input focus:outline-none focus:ring-2 focus:ring-ring"
                        title="Profile"
                      >
                        {profiles.map((p) => (
                          <option key={p.id} value={p.partition}>{p.name}</option>
                        ))}
                      </select>
                    )}
                    <input
                      type="text"
                      value={addSiteOrigin}
                      onChange={(e) => { setAddSiteOrigin(e.target.value); setAddSiteError(null) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddSite() }}
                      placeholder="https://meet.google.com"
                      className="flex-1 min-w-[180px] h-9 px-3 rounded-md bg-secondary border border-input text-sm text-foreground outline-none focus:border-ring focus:bg-background"
                    />
                    <select
                      value={addSiteKind}
                      onChange={(e) => setAddSiteKind(e.target.value as PermissionKind)}
                      className="h-9 px-2 text-sm bg-input text-foreground rounded-md border border-input focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {PERMISSION_KINDS.map((k) => (
                        <option key={k} value={k}>{PERMISSION_LABEL[k]}</option>
                      ))}
                    </select>
                    <select
                      value={addSiteDecision}
                      onChange={(e) => setAddSiteDecision(e.target.value as 'allow' | 'block')}
                      className="h-9 px-2 text-sm bg-input text-foreground rounded-md border border-input focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="allow">Allow</option>
                      <option value="block">Block</option>
                    </select>
                    <button
                      onClick={handleAddSite}
                      className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
                    >
                      <Plus size={14} /> Add
                    </button>
                  </div>
                  {addSiteError && <p className="text-[11px] text-destructive mt-2">{addSiteError}</p>}
                </div>

                {permissionGrants.length === 0 ? (
                  <p className="text-xs text-muted-foreground rounded-lg border border-dashed border-border px-3 py-6 text-center">
                    No saved site permissions yet.
                  </p>
                ) : (
                  <div className="rounded-lg border border-border divide-y divide-border">
                    {permissionGrants.map((g) => (
                      <div
                        key={`${g.partition} ${g.origin} ${g.kind}`}
                        className="flex items-center gap-3 px-3 py-2.5"
                      >
                        <Globe size={14} className="shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-foreground">{g.origin}</div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {PERMISSION_LABEL[g.kind]} · {profileNameForPartition(g.partition)}
                          </div>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            g.decision === 'allow'
                              ? 'bg-primary/15 text-primary'
                              : 'bg-destructive/15 text-destructive'
                          }`}
                        >
                          {g.decision === 'allow' ? 'Allowed' : 'Blocked'}
                        </span>
                        <button
                          aria-label="Remove"
                          onClick={() => clearPermissionGrant(g)}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'about' && (
            <div className="flex flex-col gap-8 max-w-2xl">
              {/* App identity + version + storage paths in one divided card. */}
              <section>
                <h2 className="text-sm font-semibold text-foreground mb-1">
                  {appPaths?.appName || 'Newbro'}
                </h2>
                <p className="text-xs text-muted-foreground mb-3">
                  Workspace-based browser with profiles and tab groups.
                </p>
                <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="text-sm font-medium text-foreground">Version</div>
                    <div className="text-sm text-muted-foreground tabular-nums">
                      {appVersion ? `v${appVersion}` : '…'}
                    </div>
                  </div>
                  {appPaths &&
                    (
                      [
                        { label: 'User data', value: appPaths.userData },
                        { label: 'Cache', value: appPaths.cache },
                        { label: 'Logs', value: appPaths.logs },
                      ] as const
                    ).map((row) => (
                      <div
                        key={row.label}
                        className="flex items-center justify-between gap-4 px-4 py-3"
                      >
                        <div className="text-sm font-medium text-foreground shrink-0">
                          {row.label}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(row.value).catch((err) => {
                              console.warn('SettingsDialog: clipboard write failed', { value: row.value, err: String(err) })
                            })
                          }}
                          title="Click to copy"
                          className="text-xs text-muted-foreground font-mono truncate hover:text-foreground transition-colors text-right select-all"
                        >
                          {row.value}
                        </button>
                      </div>
                    ))}
                </div>
              </section>

              {/* Updates — same card pattern as the identity block; the
                  status line on the left, action button on the right. */}
              <section>
                <h2 className="text-sm font-semibold text-foreground mb-1">Updates</h2>
                <p className="text-xs text-muted-foreground mb-3">
                  Newbro checks GitHub for new releases on launch and every few hours.
                  The button below triggers a manual check.
                </p>
                <div className="flex items-start gap-4 px-4 py-3 border border-input rounded-md bg-card">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                      {updateStatus.phase === 'not-available' && (
                        <CheckCircle2 size={12} className="text-primary shrink-0" />
                      )}
                      {updateStatus.phase === 'error' && (
                        <AlertTriangle size={12} className="text-destructive shrink-0" />
                      )}
                      {(() => {
                        switch (updateStatus.phase) {
                          case 'idle':
                            return 'Newbro is ready to check for updates'
                          case 'checking':
                            return 'Checking for updates…'
                          case 'not-available':
                            return `You're up to date — v${updateStatus.version}`
                          case 'available':
                            return `Update available — v${updateStatus.version}`
                          case 'downloading':
                            return `Downloading v${updateStatus.version}…`
                          case 'downloaded':
                            return `v${updateStatus.version} ready to install`
                          case 'error':
                            return 'Update check failed'
                          case 'unsupported':
                            return 'Auto-update disabled in dev builds'
                        }
                      })()}
                    </p>
                    {(() => {
                      switch (updateStatus.phase) {
                        case 'available':
                          return (
                            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                              Downloading in the background.
                            </p>
                          )
                        case 'downloading':
                          return (
                            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                              {updateStatus.percent}% complete.
                            </p>
                          )
                        case 'downloaded':
                          return (
                            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                              Newbro will close, swap in the new version, and relaunch.
                            </p>
                          )
                        case 'error':
                          return (
                            <p className="text-[11px] text-destructive mt-1 leading-relaxed">
                              {updateStatus.message}
                            </p>
                          )
                        case 'unsupported':
                          return (
                            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                              Running from `npm run dev` — packaged releases get real auto-update.
                            </p>
                          )
                        default:
                          return null
                      }
                    })()}
                  </div>
                  {updateStatus.phase === 'downloaded' ? (
                    <button
                      onClick={handleInstallUpdate}
                      className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border bg-primary text-primary-foreground border-primary hover:opacity-90"
                    >
                      <Download size={12} />
                      Install now
                    </button>
                  ) : (
                    <button
                      onClick={handleCheckForUpdates}
                      disabled={
                        updateStatus.phase === 'checking' ||
                        updateStatus.phase === 'downloading' ||
                        updateStatus.phase === 'available' ||
                        updateStatus.phase === 'unsupported'
                      }
                      title={updateStatus.phase === 'unsupported' ? 'Updates are only available in installed builds.' : undefined}
                      className={`shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border transition-colors ${
                        updateStatus.phase === 'checking' ||
                        updateStatus.phase === 'downloading' ||
                        updateStatus.phase === 'available'
                          ? 'bg-secondary text-secondary-foreground border-input opacity-60 cursor-not-allowed'
                          : updateStatus.phase === 'unsupported'
                            ? 'bg-secondary text-muted-foreground border-input opacity-60 cursor-not-allowed'
                            : 'bg-secondary text-secondary-foreground border-input hover:bg-accent'
                      }`}
                    >
                      <RotateCcw
                        size={12}
                        className={
                          updateStatus.phase === 'checking' ||
                          updateStatus.phase === 'downloading' ||
                          updateStatus.phase === 'available'
                            ? 'animate-spin'
                            : ''
                        }
                      />
                      {updateStatus.phase === 'checking'
                        ? 'Checking…'
                        : updateStatus.phase === 'downloading' || updateStatus.phase === 'available'
                          ? 'Downloading…'
                          : updateStatus.phase === 'error'
                            ? 'Try again'
                            : updateStatus.phase === 'unsupported'
                              ? 'Unavailable'
                              : 'Check for updates'}
                    </button>
                  )}
                </div>
              </section>
            </div>
          )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border">
          <button
            onClick={handleCancel}
            className="h-8 px-4 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="h-8 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/80"
          >
            Save
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={syncRestartConfirmOpen}
        title="Restart Cloud Sync setup?"
        message="This turns off Cloud Sync on this device and forgets the selected sync folder. Your local data and files already in the sync folder are left untouched."
        confirmLabel="Restart setup"
        onConfirm={restartSyncSetup}
        onCancel={() => setSyncRestartConfirmOpen(false)}
      />

      <ConfirmDialog
        open={edgeImportConfirmOpen}
        title="Import passwords from Microsoft Edge?"
        message={`Newbro will ask the operating system to unlock Edge's local password data, then copy ${edgeSource?.passwordCount || 'the detected'} passwords into ${profileNameForPartition(passwordPartition)}. Microsoft Edge will not be changed.`}
        confirmLabel="Import passwords"
        tone="primary"
        onConfirm={handleImportEdgePasswords}
        onCancel={() => setEdgeImportConfirmOpen(false)}
      />

      <ConfirmDialog
        open={passwordClearConfirmOpen}
        title="Remove all saved passwords?"
        message={`This permanently removes every saved website password from ${profileNameForPartition(passwordPartition)}. Other browser profiles are not affected.`}
        confirmLabel="Remove all passwords"
        onConfirm={handleClearPasswords}
        onCancel={() => setPasswordClearConfirmOpen(false)}
      />

      <ConfirmDialog
        open={wipeConfirmOpen}
        title="Wipe all Newbro data?"
        message="This will permanently delete every workspace, tab, bookmark, cookie, login session, cache, setting, and keybinding, then relaunch the app. This cannot be undone."
        confirmLabel="Wipe everything"
        onConfirm={handleWipeAllData}
        onCancel={() => setWipeConfirmOpen(false)}
      />
    </DetachedWindow>
  )
}
