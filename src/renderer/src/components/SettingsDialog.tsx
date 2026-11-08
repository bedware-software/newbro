import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { X, RotateCcw, Sun, Moon, Monitor, AlertTriangle, Trash2, Download, Bell, CheckCircle2, Loader2, Puzzle, ExternalLink, Plus, Globe, Pin, PinOff, SlidersHorizontal, Palette, Keyboard, Info, Compass, ShieldCheck, Cloud, FolderOpen, RefreshCw, Wifi, Building2, KeyRound, Search, FileUp, Pencil, Copy, Check, Eye, EyeOff, ChevronDown, ChevronRight, UserRound, FingerprintPattern } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CloudSyncInfo, SyncCategory, SavedCredentialInfo, PasswordEntryInfo, PasskeyInfo, PasswordImportResult, EdgePasswordSourceInfo, EdgePasswordImportResult, OtherBrowser } from '../App'
import { DetachedWindow } from './DetachedWindow'
import { ConfirmDialog } from './ConfirmDialog'
import { DarkPagesSettings } from './DarkPagesSettings'
import { ExtensionPermissionList } from './ExtensionPermissionList'
import { requestExtensionInstall } from '../lib/extension-install'
import { LIGHT_VARIANTS, DARK_VARIANTS, DENSITIES, normalizeLightVariant, normalizeDarkVariant, normalizeDensity, DEFAULT_DENSITY, type ThemeChoice, type Density } from '../lib/theme'
import { VIM_INDICATORS, DEFAULT_VIM_INDICATOR, normalizeVimIndicator, type VimIndicator } from '../lib/vim-indicator'
import { VimModeBadge } from './VimModeBadge'
import { ModeEdge } from './ModeEdge'
import { BrandMark } from './BrandMark'
import { VIM_EDGES, DEFAULT_VIM_EDGE, DEFAULT_VIM_EDGE_EVERYWHERE, normalizeVimEdge, type VimEdge } from '../lib/vim-edge'
import { useAppStore } from '../store/app-store'
import { DEFAULT_VIM_KEYMAP, parseVimKeymap, settingsKeymap, settingsCommandLabel, settingsCommandsInOrder, type ParsedVimKeymap, type VimKeymap } from '../lib/vim-keymap'
import { usePopupVimMode, type VimMode } from '../lib/vim-mode'
import { hintIndex, usePopupHints } from '../lib/hint-labels'
import { VimFormContext, stepIndex, useCloseWarning, useVimForm, useVimFormLabelCount, useVimFormSnapshot, type VimFormController } from '../lib/vim-form'
import { SETTINGS_SECTIONS, filterSettingsIndex, settingsIndex, settingsSectionLabel, type SettingsIndexEntry, type SettingsSection } from '../lib/settings-index'
import { cn } from '../lib/utils'
import { InputField } from './InputField'
import { Hint, HintBar, LEAVE_INSERT_CAP, vimKeyCaps, vimKeyCapsAll } from './KeyHints'
import { VimFormCursorHints, VimFormLabels } from './VimForm'
import { VimSelect } from './VimSelect'
import { Segmented } from './Segmented'
import { Switch } from './Switch'
import { ACTION_LABELS } from '../lib/action-labels'
import { SEARCH_ENGINES } from '../../../shared/search-engines'
import { BANGS_URL } from '../lib/internal-pages'
import { AUTHORS, CREDIT_GROUPS, INSPIRATIONS } from '../lib/credits'
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
  /** Always saved true: Vim is the only mode (older builds read it). */
  vimMode: boolean
  /** INSERT in a page hides the Sidebar; COMMAND brings it back. */
  hideSidebarInInsert: boolean
  vimIndicator: VimIndicator
  vimEdge: VimEdge
  vimEdgeEverywhere: boolean
  /** Null = the built-in default keymap. */
  vimKeymap: string | null
  defaultPageUrl: string
  searchEngine: string
  searchSuggestions: boolean
  bangsEnabled: boolean
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
  vimIndicator: VimIndicator
  vimEdge: VimEdge
  vimEdgeEverywhere: boolean
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
  search: ['CmdOrCtrl+P'],
  'command-palette': ['CmdOrCtrl+Shift+P'],
  back: ['CmdOrCtrl+['],
  forward: ['CmdOrCtrl+]'],
  reload: ['CmdOrCtrl+R'],
  settings: ['CmdOrCtrl+,'],
  'page-devtools': ['CmdOrCtrl+Shift+I'],
  'ui-devtools': [],
  'find-in-page': ['CmdOrCtrl+F'],
  'save-page': ['CmdOrCtrl+S'],
  'tab-1': ['CmdOrCtrl+1'],
  'tab-2': ['CmdOrCtrl+2'],
  'tab-3': ['CmdOrCtrl+3'],
  'tab-4': ['CmdOrCtrl+4'],
  'tab-5': ['CmdOrCtrl+5'],
  'tab-6': ['CmdOrCtrl+6'],
  'tab-7': ['CmdOrCtrl+7'],
  'tab-8': ['CmdOrCtrl+8'],
  'tab-9': ['CmdOrCtrl+9'],
  // Move/Duplicate actions ship unbound — they're surfaced through context
  // menus and the command palette by default. An empty array keeps the
  // parsing path in main/index.ts a no-op (parseAcceleratorShortcut returns
  // null) until the user records a binding here.
  'duplicate-tab': [],
  'move-tab': [],
  'rename-tab-group': [],
  'move-group': [],
  'duplicate-group': [],
  'add-to-bookshelf': [],
  'toggle-bookshelf': ['CmdOrCtrl+Shift+B'],
  'open-downloads': ['CmdOrCtrl+J'],
  // Settings lists it (ACTION_LABELS), so a shortcut recorded for it must
  // survive the filter too.
  'open-bangs': [],
  'dark-pages': ['Alt+Shift+D'],
  'dark-pages-site': ['Alt+Shift+A'],
  // The rest of the app's commands ship unbound; listed so a recorded
  // shortcut survives (main's table has the same keys).
  'new-group': [],
  'close-group': [],
  'add-to-new-group': [],
  'ungroup-tab': [],
  'ungroup-all-tabs': [],
  'expand-all-groups': [],
  'collapse-all-groups': [],
  'rename-workspace': [],
  'close-workspace': [],
  'delete-workspace': [],
  'import-workspaces': [],
  'export-workspaces': [],
  'workspace-menu': [],
  'new-profile': [],
  'rename-profile': [],
  'delete-profile': [],
  'profile-menu': [],
  'app-menu': [],
  'extensions-menu': [],
  'manage-extensions': [],
  'site-info': [],
  'dark-pages-menu': [],
  'dark-pages-settings': [],
  'chrome-hints': [],
  'zoom-in': [],
  'zoom-out': [],
  'zoom-reset': [],
  'check-updates': [],
  'install-update': [],
  about: [],
  'minimize-window': [],
  'maximize-window': [],
  'restore-window': [],
  quit: [],
}

function cloneDefaultKeybindings(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, list] of Object.entries(DEFAULT_KEYBINDINGS)) {
    out[key] = [...list]
  }
  return out
}

interface Props {
  open: boolean
  onClose: () => void
  settings: Settings | null
  onSave: (settings: Settings) => void
  onAppearancePreview?: (preview: AppearancePreview) => void
  /** Versioned request to switch panes. See {@link SettingsTabRequest}. */
  tabRequest?: SettingsTabRequest | null
  /** The window's parsed Vim keymap, as saved; null (the beat at launch
   *  before the window's Vim starts) gives Settings no Vim keys. */
  vimKeymap?: ParsedVimKeymap | null
}

function originHost(origin: string): string {
  try { return new URL(origin).host } catch { return origin }
}

function formatPasswordDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
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

export type SettingsTab = SettingsSection
type Tab = SettingsTab

const SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  general: SlidersHorizontal,
  appearance: Palette,
  darkPages: Moon,
  passwords: KeyRound,
  network: Wifi,
  enterprise: Building2,
  shortcuts: Keyboard,
  extensions: Puzzle,
  permissions: ShieldCheck,
  sync: Cloud,
  about: Info,
}

/** The search engine segment's Custom choice (an address of one's own). */
const CUSTOM_ENGINE = '\u0000custom'

/** Order + labels for the Cloud Sync category checkboxes. */
const SYNC_CATEGORY_LABELS: { id: SyncCategory; label: string; hint: string }[] = [
  { id: 'state', label: 'Tabs & workspaces', hint: 'Profiles, workspaces, tab groups and tabs' },
  { id: 'bookshelf', label: 'Bookshelf', hint: 'Reading queue and groups' },
  { id: 'settings', label: 'Settings & keybindings', hint: 'Appearance, search, shortcuts, proxy' },
  { id: 'history', label: 'History', hint: 'Address-bar autocomplete history' },
  { id: 'permissions', label: 'Site permissions', hint: 'Per-site mic / camera / location decisions' },
  { id: 'extensions', label: 'Extensions', hint: 'Installed extensions (re-downloaded per device)' },
  { id: 'darkPages', label: 'Dark pages', hint: 'On / off, style, comfort and per-site rules' },
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
 * "About Vimperium" entry to deep-link into the About pane.
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
  optionalPermissions?: string[]
  contentScriptMatches?: string[]
  permissionsFromOriginal?: boolean
  hasOptionsPage: boolean
  hasAction: boolean
  actionDefaultTitle?: string
  iconUrl?: string | null
  installedAt: number
}

/** One manifest `commands` entry and its current binding ('' = none). */
interface ExtensionCommand {
  name: string
  description: string
  shortcut: string
  suggested: string
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

export function SettingsDialog({ open, onClose, settings, onSave, onAppearancePreview, tabRequest, vimKeymap }: Props) {
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
  const [hideSidebarInInsert, setHideSidebarInInsert] = useState(false)
  const [vimIndicator, setVimIndicator] = useState<VimIndicator>(DEFAULT_VIM_INDICATOR)
  const [vimEdge, setVimEdge] = useState<VimEdge>(DEFAULT_VIM_EDGE)
  const [vimEdgeEverywhere, setVimEdgeEverywhere] = useState(DEFAULT_VIM_EDGE_EVERYWHERE)
  const [vimKeymapText, setVimKeymapText] = useState(DEFAULT_VIM_KEYMAP)
  const [defaultUrl, setDefaultUrl] = useState('')
  const [searchEngine, setSearchEngine] = useState(SEARCH_ENGINES.Google)
  const [searchSuggestions, setSearchSuggestions] = useState(true)
  const [bangsEnabled, setBangsEnabled] = useState(true)
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
  // Passkeys exist only on macOS, where Vimperium is its own authenticator.
  const passkeysSupported = navigator.platform.includes('Mac')
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([])
  const [passkeyToRemove, setPasskeyToRemove] = useState<PasskeyInfo | null>(null)
  const [passwordPartition, setPasswordPartition] = useState('')
  const [passwordSearch, setPasswordSearch] = useState('')
  const [passwordImporting, setPasswordImporting] = useState(false)
  const [edgeSource, setEdgeSource] = useState<EdgePasswordSourceInfo | null>(null)
  const [edgeDetecting, setEdgeDetecting] = useState(false)
  const [edgeImporting, setEdgeImporting] = useState(false)
  const [edgeImportConfirmOpen, setEdgeImportConfirmOpen] = useState(false)
  const [edgeExportHelpOpen, setEdgeExportHelpOpen] = useState(false)
  const [edgeExportOpeningProfile, setEdgeExportOpeningProfile] = useState<string | null>(null)
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordClearConfirmOpen, setPasswordClearConfirmOpen] = useState(false)
  const [passwordEditor, setPasswordEditor] = useState<{
    id?: string
    origin: string
    username: string
    password: string
    /** The saved password the editor was filled with, when it could be
     *  fetched — saving it unchanged keeps the stored value as is. */
    original?: string
  } | null>(null)
  const [editorPasswordVisible, setEditorPasswordVisible] = useState(false)
  // Edge-style record view: the open entry shows its details, the password
  // masked until clicked. Revealed passwords are kept only while this pane
  // shows the profile they belong to.
  const [openPasswordId, setOpenPasswordId] = useState<string | null>(null)
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, string>>({})
  const [passwordBusyId, setPasswordBusyId] = useState<string | null>(null)
  const [copiedPasswordField, setCopiedPasswordField] = useState<{ id: string; field: 'username' | 'password' } | null>(null)
  // Manual "add a site" form (for when a site never triggers an auto-prompt).
  const [addSiteOrigin, setAddSiteOrigin] = useState('')
  const [addSiteKind, setAddSiteKind] = useState<PermissionKind>('microphone')
  const [addSiteDecision, setAddSiteDecision] = useState<'allow' | 'block'>('allow')
  const [addSitePartition, setAddSitePartition] = useState('')
  const [addSiteError, setAddSiteError] = useState<string | null>(null)
  const [hostWindow, setHostWindow] = useState<Window | null>(null)
  // Vim mode's keys (further down): what Save would keep as Settings
  // opened, the filter, the hint bar's states, and the form's elements.
  const [baselineTick, setBaselineTick] = useState(0)
  const [filterQuery, setFilterQuery] = useState('')
  const [filterActive, setFilterActive] = useState(false)
  const [filterSelected, setFilterSelected] = useState(0)
  const [showAllKeys, setShowAllKeys] = useState(false)
  const [formRoot, setFormRoot] = useState<HTMLDivElement | null>(null)
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null)
  const [syncRestartConfirmOpen, setSyncRestartConfirmOpen] = useState(false)
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false)
  const [appVersion, setAppVersion] = useState<string>('')
  const [appPaths, setAppPaths] = useState<{ userData: string; cache: string; logs: string; appName: string } | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ phase: 'idle' })
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([])
  const [extInput, setExtInput] = useState('')
  // Rows showing their permissions & shortcuts.
  const [expandedExtensions, setExpandedExtensions] = useState<Set<string>>(new Set())
  const [extCommands, setExtCommands] = useState<Record<string, ExtensionCommand[]>>({})
  const [recordingCommand, setRecordingCommand] = useState<{ extensionId: string; command: string } | null>(null)
  const [commandError, setCommandError] = useState<{ extensionId: string; message: string } | null>(null)
  const [extInstalling, setExtInstalling] = useState(false)
  const [extError, setExtError] = useState<string | null>(null)
  const [defaultBrowserStatus, setDefaultBrowserStatus] = useState<DefaultBrowserStatus | null>(null)
  const edgeAppBoundPasswordCount = edgeSource?.appBoundPasswordCount || 0
  const edgeDirectPasswordCount = Math.max(0, (edgeSource?.passwordCount || 0) - edgeAppBoundPasswordCount)
  const [defaultBrowserBusy, setDefaultBrowserBusy] = useState(false)
  // Set after the user clicks "Make default" on Windows — the OS pane has
  // been opened and we want to remind them to actually pick Vimperium there
  // until the next status refresh confirms the change took effect.
  const [defaultBrowserSystemPaneOpened, setDefaultBrowserSystemPaneOpened] = useState(false)
  // The browser the Open Link picker's ⌘↵ / Ctrl+Enter passes links on to —
  // this computer's,
  // saved as soon as it's picked rather than with the other settings.
  const otherBrowserOnMac = navigator.platform.includes('Mac')
  const otherBrowserSupported = otherBrowserOnMac || navigator.platform.startsWith('Win')
  const passOnKeys = otherBrowserOnMac ? '⌘↵' : 'Ctrl+Enter'
  const [otherBrowser, setOtherBrowser] = useState<OtherBrowser | null>(null)
  const [installedBrowsers, setInstalledBrowsers] = useState<OtherBrowser[]>([])
  const originalAppearanceRef = useRef<AppearancePreview>({
    theme: 'dark',
    lightVariant: LIGHT_VARIANTS[0].id,
    darkVariant: DARK_VARIANTS[0].id,
    density: DEFAULT_DENSITY,
    vimIndicator: DEFAULT_VIM_INDICATOR,
    vimEdge: DEFAULT_VIM_EDGE,
    vimEdgeEverywhere: DEFAULT_VIM_EDGE_EVERYWHERE,
  })

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

  const [testNotice, setTestNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const handleTestNotification = useCallback(async () => {
    setTestNotice({ ok: true, text: 'Sending…' })
    const api = (window as any).electronAPI
    const result = (await api?.sendTestNotification?.()) as
      | { shown: boolean; error?: string; unconfirmed?: boolean }
      | undefined
    if (!result) setTestNotice({ ok: false, text: 'Not available in this build.' })
    else if (!result.shown) setTestNotice({ ok: false, text: `Windows didn't show it: ${result.error ?? 'unknown error'}` })
    else {
      setTestNotice({
        ok: true,
        text: result.unconfirmed
          ? 'Sent. If nothing appeared, check Focus assist / Do not disturb and that Vimperium is allowed in Windows notification settings.'
          : 'Shown — look at the corner of the screen or the notification center.',
      })
    }
  }, [])

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
  // user picks Vimperium in Settings → Default Apps and Cmd/Alt-Tabs back.
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

  useEffect(() => {
    if (!open || !otherBrowserSupported) return
    Promise.all([window.electronAPI.otherBrowserGet(), window.electronAPI.otherBrowserList()])
      .then(([chosen, browsers]) => {
        setOtherBrowser(chosen)
        setInstalledBrowsers(browsers)
      })
      .catch((err) => {
        console.warn('SettingsDialog: other browser load failed', String(err))
      })
  }, [open, otherBrowserSupported])

  const handleOtherBrowserChange = useCallback((id: string) => {
    const pick = installedBrowsers.find((browser) => browser.id === id) ?? null
    window.electronAPI.otherBrowserSet(pick).then(setOtherBrowser).catch((err) => {
      console.warn('SettingsDialog: other browser save failed', String(err))
    })
  }, [installedBrowsers])

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
      // doesn't change until they click "Use Vimperium". Re-poll a few times
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
    const loadCommands = (): void => {
      api.listExtensionCommands?.().then((list: Array<{ extensionId: string; commands: ExtensionCommand[] }>) =>
        setExtCommands(Object.fromEntries((list || []).map((e) => [e.extensionId, e.commands]))),
      )
    }
    api.listExtensions().then((list: ExtensionInfo[]) => setExtensions(list || []))
    loadCommands()
    const cleanup = api.onExtensionsChanged?.((list: ExtensionInfo[]) => {
      setExtensions(list || [])
      loadCommands()
    })
    return cleanup
  }, [open])

  const toggleExtensionDetails = useCallback((id: string) => {
    setExpandedExtensions((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const applyExtensionCommand = useCallback((extensionId: string, command: string, accelerator: string) => {
    const api = (window as any).electronAPI
    api.setExtensionCommand?.(extensionId, command, accelerator).then(
      (list: Array<{ extensionId: string; commands: ExtensionCommand[] }>) =>
        setExtCommands(Object.fromEntries((list || []).map((e) => [e.extensionId, e.commands]))),
    )
  }, [])

  // Record an extension shortcut: the next key combination (Escape
  // cancels). Like Chrome, it must use Ctrl or Alt, and may not take a
  // combination Vimperium or another extension already uses.
  useEffect(() => {
    if (!recordingCommand || !hostWindow) return
    const { extensionId, command } = recordingCommand
    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecordingCommand(null)
        return
      }
      const accel = eventToAccelerator(e)
      if (!accel) return // a bare modifier — wait for the key
      const fail = (message: string): void => {
        setCommandError({ extensionId, message })
        setRecordingCommand(null)
      }
      if (!/(^|\+)(CmdOrCtrl|Alt)\+/.test(accel)) {
        fail('Extension shortcuts need Ctrl or Alt.')
        return
      }
      const pretty = accel.replace(/CmdOrCtrl/g, navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')
      const appAction = Object.entries(keybindings).find(([, list]) => list.includes(accel))?.[0]
      if (appAction) {
        fail(`${pretty} is already used by Vimperium (“${ACTION_LABELS[appAction] ?? appAction}”).`)
        return
      }
      for (const [otherId, commands] of Object.entries(extCommands)) {
        const taken = commands.find((c) => c.shortcut === accel && !(otherId === extensionId && c.name === command))
        if (taken) {
          const owner = extensions.find((x) => x.id === otherId)?.name ?? otherId
          fail(`${pretty} is already used by ${owner} (“${taken.description}”).`)
          return
        }
      }
      setCommandError(null)
      setRecordingCommand(null)
      applyExtensionCommand(extensionId, command, accel)
    }
    hostWindow.addEventListener('keydown', onKeyDown, true)
    return () => hostWindow.removeEventListener('keydown', onKeyDown, true)
  }, [recordingCommand, hostWindow, keybindings, extCommands, extensions, applyExtensionCommand])

  const handleInstallExtension = useCallback(async () => {
    const trimmed = extInput.trim()
    if (!trimmed) return
    setExtError(null)
    setExtInstalling(true)
    try {
      if ((await requestExtensionInstall(trimmed)) === 'installed') setExtInput('')
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
    if (s.activeWorkspaceId) s.addTabNearActive(s.activeWorkspaceId, url)
    onClose()
  }, [onClose])

  // Init from settings
  useEffect(() => {
    if (open && settings) {
      const lv = normalizeLightVariant(settings.lightVariant)
      const dv = normalizeDarkVariant(settings.darkVariant)
      const dens = normalizeDensity(settings.density)
      const indicator = normalizeVimIndicator(settings.vimIndicator)
      const edge = normalizeVimEdge(settings.vimEdge)
      const edgeEverywhere = settings.vimEdgeEverywhere === true
      setTheme(settings.theme)
      setLightVariant(lv)
      setDarkVariant(dv)
      setDensity(dens)
      setNewTabFocus(settings.newTabFocus === 'url' ? 'url' : 'site')
      setHideSidebarInInsert(settings.hideSidebarInInsert === true)
      setVimIndicator(indicator)
      setVimEdge(edge)
      setVimEdgeEverywhere(edgeEverywhere)
      setVimKeymapText(settings.vimKeymap ?? DEFAULT_VIM_KEYMAP)
      originalAppearanceRef.current = { theme: settings.theme, lightVariant: lv, darkVariant: dv, density: dens, vimIndicator: indicator, vimEdge: edge, vimEdgeEverywhere: edgeEverywhere }
      setDefaultUrl(settings.defaultPageUrl)
      setSearchEngine(settings.searchEngine || SEARCH_ENGINES.Google)
      setSearchSuggestions(settings.searchSuggestions !== false)
      setBangsEnabled(settings.bangsEnabled !== false)
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
      // What Save would keep now is what there is to lose (below).
      setBaselineTick((tick) => tick + 1)
    }
  }, [open, settings])

  // Load the per-site permission exceptions when that tab is shown (and
  // refresh on open) so the list reflects decisions made since last view.
  useEffect(() => {
    if (!open || activeTab !== 'permissions') return
    window.electronAPI.permissionsList?.().then(setPermissionGrants).catch((err) => {
      console.warn('SettingsDialog: site permissions load failed', String(err))
    })
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
    if (passkeysSupported) {
      window.electronAPI.passkeysList(partition).then(setPasskeys).catch((err) => {
        setPasswordError(err instanceof Error ? err.message : String(err))
      })
    }
  }, [open, activeTab, profiles, activeProfileId, passwordPartition, passkeysSupported])

  // Revealed passwords don't outlive the pane: forget them (and close the open
  // record) when Settings closes or moves to another pane.
  useEffect(() => {
    if (open && activeTab === 'passwords') return
    setRevealedPasswords({})
    setOpenPasswordId(null)
  }, [open, activeTab])

  useEffect(() => {
    if (!copiedPasswordField) return
    const t = setTimeout(() => setCopiedPasswordField(null), 1400)
    return () => clearTimeout(t)
  }, [copiedPasswordField])

  // Edge detection reads profile names and password counts only. The actual
  // password database is not decrypted until the user confirms an import.
  useEffect(() => {
    if (!open || activeTab !== 'passwords' || !window.electronAPI.edgePasswordsDetect) return
    let cancelled = false
    setEdgeDetecting(true)
    window.electronAPI.edgePasswordsDetect()
      .then((source) => { if (!cancelled) setEdgeSource(source) })
      .catch((err) => {
        console.warn('SettingsDialog: looking for Edge passwords failed', String(err))
        if (!cancelled) setEdgeSource(null)
      })
      .finally(() => { if (!cancelled) setEdgeDetecting(false) })
    return () => { cancelled = true }
  }, [open, activeTab])

  // Load saved HTTP-auth sign-ins when the Enterprise tab is shown (they live in
  // their own store and never sync). Passwords are never returned — metadata only.
  useEffect(() => {
    if (!open || activeTab !== 'enterprise') return
    window.electronAPI.savedCredentialsList?.().then(setSavedCredentials).catch((err) => {
      console.warn('SettingsDialog: saved sign-ins load failed', String(err))
    })
  }, [open, activeTab])

  // ── Cloud sync (synced-folder) ──
  const [syncInfo, setSyncInfo] = useState<CloudSyncInfo | null>(null)
  // Fetch current config/status on open, and live-subscribe to status pushes
  // (a background sync, or a change from another window).
  useEffect(() => {
    if (!open) return
    window.electronAPI.cloudSyncGetInfo?.().then((i) => setSyncInfo(i)).catch((err) => {
      console.warn('SettingsDialog: cloud sync info load failed', String(err))
    })
    const cleanup = window.electronAPI.onCloudSyncStatus?.((i) => setSyncInfo(i))
    return cleanup
  }, [open])

  const chooseSyncFolder = useCallback(() => {
    window.electronAPI.cloudSyncSetFolder?.().then(setSyncInfo).catch((err) => {
      console.warn('SettingsDialog: choosing the sync folder failed', String(err))
    })
  }, [])
  const setSyncEnabled = useCallback((enabled: boolean) => {
    window.electronAPI.cloudSyncSetEnabled?.(enabled).then(setSyncInfo).catch((err) => {
      console.warn('SettingsDialog: switching cloud sync failed', { enabled, err: String(err) })
    })
  }, [])
  const toggleSyncCategory = useCallback((cat: SyncCategory, on: boolean) => {
    window.electronAPI.cloudSyncSetCategories?.({ [cat]: on }).then(setSyncInfo).catch((err) => {
      console.warn('SettingsDialog: changing what syncs failed', { cat, on, err: String(err) })
    })
  }, [])
  const runSyncNow = useCallback(() => {
    window.electronAPI.cloudSyncNow?.().then(setSyncInfo).catch((err) => {
      console.warn('SettingsDialog: sync now failed', String(err))
    })
  }, [])
  const restartSyncSetup = useCallback(() => {
    setSyncRestartConfirmOpen(false)
    window.electronAPI.cloudSyncRestartSetup?.().then(setSyncInfo).catch((err) => {
      console.warn('SettingsDialog: restarting cloud sync setup failed', String(err))
    })
  }, [])

  const clearPermissionGrant = useCallback((grant: PermissionGrant) => {
    window.electronAPI
      .permissionsClear?.(grant.partition, grant.origin, grant.kind)
      .then(setPermissionGrants)
      .catch((err) => {
        console.warn('SettingsDialog: removing a site permission failed', { origin: grant.origin, kind: grant.kind, err: String(err) })
      })
  }, [])

  const clearAllPermissionGrants = useCallback(() => {
    window.electronAPI.permissionsClearAll?.().then(setPermissionGrants).catch((err) => {
      console.warn('SettingsDialog: clearing site permissions failed', String(err))
    })
  }, [])

  const removeSavedCredential = useCallback((host: string) => {
    window.electronAPI.savedCredentialDelete?.(host).then(setSavedCredentials).catch((err) => {
      console.warn('SettingsDialog: removing a saved sign-in failed', { host, err: String(err) })
    })
  }, [])

  const clearAllSavedCredentials = useCallback(() => {
    window.electronAPI.savedCredentialsClearAll?.().then(setSavedCredentials).catch((err) => {
      console.warn('SettingsDialog: clearing saved sign-ins failed', String(err))
    })
  }, [])

  const handlePasswordProfileChange = useCallback((partition: string) => {
    setPasswordPartition(partition)
    setPasswordSearch('')
    setPasswordNotice(null)
    setPasswordError(null)
    setPasswordEditor(null)
    setOpenPasswordId(null)
    setRevealedPasswords({})
  }, [])

  /** Fetch a saved password from main. The first call in a session may show
   *  the OS device check (Touch ID); null when it was declined or failed. */
  const fetchSavedPassword = useCallback(async (id: string): Promise<string | null> => {
    if (!passwordPartition) return null
    setPasswordBusyId(id)
    try {
      const value = await window.electronAPI.passwordReveal(passwordPartition, id)
      if (value === null) setPasswordError('Showing saved passwords needs your device confirmation.')
      return value
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setPasswordBusyId(null)
    }
  }, [passwordPartition])

  /** Click on the dots / the eye: show the password, or hide it again. */
  const togglePasswordReveal = useCallback(async (id: string) => {
    if (revealedPasswords[id] !== undefined) {
      setRevealedPasswords(({ [id]: _hidden, ...rest }) => rest)
      return
    }
    setPasswordError(null)
    const value = await fetchSavedPassword(id)
    if (value !== null) setRevealedPasswords((current) => ({ ...current, [id]: value }))
  }, [revealedPasswords, fetchSavedPassword])

  const copyPasswordEntryField = useCallback(async (entry: PasswordEntryInfo, field: 'username' | 'password') => {
    setPasswordError(null)
    if (field === 'username') {
      window.electronAPI.clipboardWriteText(entry.username)
    } else if (revealedPasswords[entry.id] !== undefined) {
      window.electronAPI.clipboardWriteText(revealedPasswords[entry.id])
    } else {
      if (!passwordPartition) return
      // Copied in main, so the password doesn't have to be shown first.
      setPasswordBusyId(entry.id)
      try {
        const copied = await window.electronAPI.passwordCopy(passwordPartition, entry.id)
        if (!copied) {
          setPasswordError('Copying saved passwords needs your device confirmation.')
          return
        }
      } catch (err) {
        setPasswordError(err instanceof Error ? err.message : String(err))
        return
      } finally {
        setPasswordBusyId(null)
      }
    }
    setCopiedPasswordField({ id: entry.id, field })
  }, [passwordPartition, revealedPasswords])

  /** Edit opens with the current password filled in (behind the same device
   *  check as showing it); if it can't be fetched the field starts blank and
   *  a blank field keeps the saved password. */
  const startEditPassword = useCallback(async (entry: PasswordEntryInfo) => {
    setPasswordError(null)
    setPasswordNotice(null)
    setEditorPasswordVisible(false)
    setPasswordEditor({ id: entry.id, origin: entry.origin, username: entry.username, password: '' })
    const current = revealedPasswords[entry.id] ?? await fetchSavedPassword(entry.id)
    if (current === null) return
    // Only fill a form still editing this entry and untouched meanwhile.
    setPasswordEditor((editor) =>
      editor && editor.id === entry.id && editor.password === '' && editor.original === undefined
        ? { ...editor, password: current, original: current }
        : editor)
  }, [revealedPasswords, fetchSavedPassword])

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
      if (r.appBound) parts.push(`${r.appBound} require Edge export`)
      if (r.unsupported) parts.push(`${r.unsupported} unsupported`)
      setPasswordNotice(
        `${parts.join(' · ')}. Microsoft Edge was left unchanged.${r.appBound ? ' Use Import from Edge for the protected passwords.' : ''}`,
      )
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err))
    } finally {
      setEdgeImporting(false)
    }
  }, [passwordPartition])

  const handleOpenEdgePasswordExport = useCallback(async (profileId: string) => {
    setEdgeExportOpeningProfile(profileId)
    setPasswordNotice(null)
    setPasswordError(null)
    try {
      await window.electronAPI.edgePasswordsOpenExport(profileId)
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err))
    } finally {
      setEdgeExportOpeningProfile(null)
    }
  }, [])

  const handleSavePasswordEntry = useCallback(async () => {
    if (!passwordPartition || !passwordEditor) return
    setPasswordNotice(null)
    setPasswordError(null)
    try {
      const keepPassword = !!passwordEditor.id &&
        (!passwordEditor.password || passwordEditor.password === passwordEditor.original)
      const entries = await window.electronAPI.passwordUpsert({
        id: passwordEditor.id,
        partition: passwordPartition,
        origin: passwordEditor.origin,
        username: passwordEditor.username,
        // Blank (or unchanged) while editing means "keep the encrypted value".
        password: keepPassword ? undefined : passwordEditor.password,
      })
      setPasswordEntries(entries)
      if (passwordEditor.id && !keepPassword) {
        const editedId = passwordEditor.id
        setRevealedPasswords(({ [editedId]: _stale, ...rest }) => rest)
      }
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
    setOpenPasswordId((current) => current === id ? null : current)
    setRevealedPasswords(({ [id]: _deleted, ...rest }) => rest)
  }, [passwordPartition])

  const handleRemovePasskey = useCallback(async () => {
    const passkey = passkeyToRemove
    setPasskeyToRemove(null)
    if (!passkey) return
    try {
      setPasskeys(await window.electronAPI.passkeyDelete(passkey.partition, passkey.id))
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err))
    }
  }, [passkeyToRemove])

  const handleClearPasswords = useCallback(async () => {
    setPasswordClearConfirmOpen(false)
    if (!passwordPartition) return
    setPasswordEntries(await window.electronAPI.passwordsClear(passwordPartition))
    setPasswordEditor(null)
    setOpenPasswordId(null)
    setRevealedPasswords({})
    setPasswordNotice('All saved passwords were removed from this profile.')
  }, [passwordPartition])

  const vimKeymapErrors = useMemo(() => parseVimKeymap(vimKeymapText).errors, [vimKeymapText])

  /** ↑ / ↓ step between saved passwords, from wherever focus sits in an entry. */
  const handlePasswordListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    // Settings renders into its own window; its document holds the focus.
    const focused = event.currentTarget.ownerDocument.activeElement
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-password-item]'))
    // Not instanceof Node: the popup's nodes are of its realm, not this one's.
    const at = items.findIndex((item) => !!focused && item.contains(focused))
    if (at === -1) return
    const next = items[at + (event.key === 'ArrowDown' ? 1 : -1)]
    const row = next?.querySelector<HTMLElement>('[data-password-row]')
    if (!row) return
    event.preventDefault()
    row.focus()
  }, [])

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
      .catch((err) => {
        console.warn('SettingsDialog: adding a site permission failed', { origin, kind: addSiteKind, err: String(err) })
      })
    setAddSiteOrigin('')
  }, [addSitePartition, profiles, addSiteOrigin, addSiteKind, addSiteDecision])

  const profileNameForPartition = useCallback(
    (partition: string): string =>
      profiles.find((p) => p.partition === partition)?.name ?? partition,
    [profiles],
  )

  /** What Save keeps. */
  const buildDraft = (): Settings => {
    const normalizedProxy: ProxySettings = {
      ...proxy,
      proxyRules: proxy.proxyRules.trim(),
      proxyBypassRules: proxy.proxyBypassRules.trim() || '<-loopback>',
    }

    return {
      theme,
      lightVariant,
      darkVariant,
      density,
      newTabFocus,
      // Vim is the only mode; kept for older builds reading synced settings.
      vimMode: true,
      hideSidebarInInsert,
      vimIndicator,
      vimEdge,
      vimEdgeEverywhere,
      // Left at the default it stays null, so later default bindings reach it.
      vimKeymap: vimKeymapText === DEFAULT_VIM_KEYMAP ? null : vimKeymapText,
      defaultPageUrl: defaultUrl,
      searchEngine,
      searchSuggestions,
      bangsEnabled,
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
    }
  }

  const handleSave = () => {
    onSave(buildDraft())
    onClose()
  }

  const handleCancel = () => {
    onAppearancePreview?.(originalAppearanceRef.current)
    onClose()
  }

  const previewAppearance = (next: Partial<AppearancePreview>): void => {
    onAppearancePreview?.({ theme, lightVariant, darkVariant, density, vimIndicator, vimEdge, vimEdgeEverywhere, ...next })
  }

  const handleWipeAllData = () => {
    setWipeConfirmOpen(false)
    // Fire-and-forget — the main process will relaunch the app immediately.
    window.electronAPI.wipeAllData()
  }

  // ── Vim mode's keys ──
  // Settings has a COMMAND / INSERT of its own, on the window's keymap as
  // saved (an edit to it takes effect on Save). It
  // opens in COMMAND, a cursor on the section's first setting: j / k walk
  // the settings, h / l change the one under the cursor, Enter or Space
  // presses it, J / K go through the sections, a setting's two-letter label
  // goes to it, / finds a setting in any section (lib/vim-keymap.ts has the
  // keys, lib/vim-form.ts the cursor). A text field taking the keyboard is
  // INSERT; Esc comes back to COMMAND. Esc in COMMAND steps back out: an
  // open list or the filter's results close, then Settings — asking once
  // first while there are changes Save would keep. ZZ saves, ZQ throws the
  // changes away. Before the window's Vim starts (vimKeymap null, a beat at
  // launch) it's a form like any other, Tab going round it, a ring on what
  // has the keyboard.
  const settingsVimKeymap = useMemo(() => (vimKeymap ? settingsKeymap(vimKeymap) : null), [vimKeymap])
  const vimNav = settingsVimKeymap !== null
  const form = useVimForm({ enabled: vimNav, root: formRoot, scrollRoot: contentEl, resetKey: activeTab })
  const labelCount = useVimFormLabelCount(form)
  const hints = usePopupHints(settingsVimKeymap, labelCount)
  const filterRef = useRef<HTMLInputElement>(null)
  const filterBoxRef = useRef<HTMLDivElement>(null)
  const filterListRef = useRef<HTMLDivElement>(null)
  const recordingCommandRef = useRef(recordingCommand)
  recordingCommandRef.current = recordingCommand

  // Changes Save would keep: what it would save now against what it would
  // have saved as the settings came in.
  const draftJson = JSON.stringify(buildDraft())
  const baselineRef = useRef<string | null>(null)
  useEffect(() => {
    if (baselineTick > 0) baselineRef.current = draftJson
    // Only as the settings come in, when the draft is all theirs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baselineTick])
  const unsaved = baselineRef.current !== null && baselineRef.current !== draftJson
  // Closing with those asks first (requestClose); any change after the
  // warning, made with the keys, the mouse or by typing, takes it down, so
  // the next close asks again rather than throwing the new change away.
  const [closeWarning, setCloseWarning] = useCloseWarning(draftJson)

  useEffect(() => {
    if (open) return
    baselineRef.current = null
    setCloseWarning(false)
    setShowAllKeys(false)
    setFilterQuery('')
    setFilterActive(false)
  }, [open])

  // Finding a setting (/): a static index, as only the section shown is
  // rendered (lib/settings-index.ts).
  const indexEntries = useMemo(
    () => settingsIndex({ otherBrowser: otherBrowserSupported }),
    [otherBrowserSupported],
  )
  const filterResults = useMemo(() => filterSettingsIndex(filterQuery, indexEntries).slice(0, 12), [filterQuery, indexEntries])
  const filterShown = filterActive && filterQuery.trim() !== ''
  useEffect(() => { setFilterSelected(0) }, [filterQuery])
  useEffect(() => {
    filterListRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [filterSelected, filterShown])

  const closeFilter = useCallback(() => {
    setFilterQuery('')
    setFilterActive(false)
    filterRef.current?.blur()
  }, [])

  const openFilter = (): void => {
    setFilterActive(true)
    const input = filterRef.current
    if (!input) return
    input.focus()
    input.select()
  }

  const pickFilterResult = (entry: SettingsIndexEntry): void => {
    // Asked for first, so the section's first look puts the cursor there.
    form.requestCursor(entry.item, entry.fallback)
    setActiveTab(entry.section)
    closeFilter()
  }

  const stepFilterSelection = (delta: number): void => {
    setFilterSelected((at) => Math.max(0, stepIndex(at, filterResults.length, delta, false)))
  }

  const onFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      stepFilterSelection(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = filterResults[filterSelected]
      if (entry) pickFilterResult(entry)
    } else if (e.key === 'Escape' && filterQuery) {
      // Out of Vim mode (in it, Esc never gets here: Vim's keys take it,
      // usePopupVimMode):
      // the first Esc clears the filter rather than closing Settings.
      e.preventDefault()
      e.stopPropagation()
      setFilterQuery('')
    }
  }

  // In COMMAND, the results take j / k and Enter while they're up.
  const filterStateRef = useRef({ results: filterResults, selected: filterSelected, pick: pickFilterResult })
  filterStateRef.current = { results: filterResults, selected: filterSelected, pick: pickFilterResult }
  useEffect(() => {
    if (!vimNav || !filterShown) return
    return form.openOverlay({
      command: (command) => {
        const { results, selected, pick } = filterStateRef.current
        const step = (delta: number): void => setFilterSelected((at) => Math.max(0, stepIndex(at, results.length, delta, false)))
        switch (command) {
          case 'cursor-down': step(1); break
          case 'cursor-up': step(-1); break
          case 'cursor-first': setFilterSelected(0); break
          case 'cursor-last': setFilterSelected(Math.max(0, results.length - 1)); break
          case 'activate':
          case 'toggle': {
            const entry = results[selected]
            if (entry) pick(entry)
            break
          }
          case 'insert-mode': filterRef.current?.focus(); break
        }
        return true
      },
      escape: closeFilter,
    })
  }, [vimNav, filterShown, form, closeFilter])

  // A press anywhere else puts the results away.
  useEffect(() => {
    if (!filterShown || !hostWindow) return
    const doc = hostWindow.document
    const onPress = (e: MouseEvent): void => {
      if (!filterBoxRef.current?.contains(e.target as Node | null)) setFilterActive(false)
    }
    doc.addEventListener('mousedown', onPress, true)
    return () => doc.removeEventListener('mousedown', onPress, true)
  }, [filterShown, hostWindow])

  // A confirmation is a window of its own: once it's gone, Settings takes
  // the keyboard back, rather than whichever window the OS picks next.
  const confirmOpen = syncRestartConfirmOpen || edgeImportConfirmOpen || passwordClearConfirmOpen || passkeyToRemove !== null || wipeConfirmOpen
  const confirmWasOpenRef = useRef(confirmOpen)
  useEffect(() => {
    const wasOpen = confirmWasOpenRef.current
    confirmWasOpenRef.current = confirmOpen
    if (!wasOpen || confirmOpen || !open || !hostWindow) return
    const t = setTimeout(() => { if (!hostWindow.closed) hostWindow.focus() }, 50)
    return () => clearTimeout(t)
  }, [confirmOpen, open, hostWindow])

  const switchSection = (delta: number): void => {
    const order = SETTINGS_SECTIONS.map((section) => section.id)
    setActiveTab(order[stepIndex(order.indexOf(activeTab), order.length, delta, true)])
  }

  /** Closing, as Esc or , does: once there are changes Save would keep, it
   *  asks first (the hint bar), and closing again straight after throws
   *  them away. A change in between asks again (useCloseWarning). */
  const requestClose = (): void => {
    if (unsaved && !closeWarning) {
      setCloseWarning(true)
      return
    }
    handleCancel()
  }

  /** A link in About: its page in a new tab of the active workspace, then
   *  Settings closes as Cancel does, so the page is what's in front. With
   *  changes Save would keep, Settings stays — the tab opens in the
   *  background rather than the changes going. A button, never an <a>: the popup has
   *  no window-open handler of its own, so a link would open a bare window
   *  or navigate Settings away. */
  const openLink = (url: string): void => {
    const s = useAppStore.getState()
    if (!s.activeWorkspaceId) return
    // With changes to keep, the tab opens behind: activating it would bring
    // the main window up over Settings, its draft out of sight.
    s.addTabNearActive(s.activeWorkspaceId, url, !unsaved)
    if (!unsaved) handleCancel()
  }

  const runSettingsCommand = (command: string): void => {
    const hinted = hintIndex(command)
    if (command !== 'close') setCloseWarning(false)
    if (hinted !== null) {
      if (!form.getSnapshot().overlayOpen) form.pickLabel(hinted)
      return
    }
    switch (command) {
      case 'save': handleSave(); return
      case 'discard': handleCancel(); return
      case 'close': requestClose(); return
      case 'help': setShowAllKeys((shown) => !shown); return
      case 'filter': openFilter(); return
      case 'section-next':
      case 'section-prev':
        if (filterShown) closeFilter()
        switchSection(command === 'section-next' ? 1 : -1)
        return
    }
    form.run(command)
  }

  const escapeSettings = (): void => {
    if (form.escapeOverlay()) return
    // The filter's results up: Esc takes them down first. A filter with
    // nothing showing (empty, or left behind by a click elsewhere) is
    // tidied away on the way out, as the hint bar's Close says.
    if (filterShown) {
      closeFilter()
      return
    }
    if (filterActive || filterQuery) closeFilter()
    if (showAllKeys) {
      setShowAllKeys(false)
      return
    }
    requestClose()
  }

  const vim = usePopupVimMode({
    keymap: hints.keymap,
    popup: hostWindow,
    box: filterRef,
    initial: 'command',
    open,
    anyField: true,
    // An extension shortcut being recorded takes the next keys, whatever
    // they are.
    passThrough: () => recordingCommandRef.current !== null,
    onCommand: runSettingsCommand,
    onEscape: escapeSettings,
  })

  // A field taking the keyboard takes a close warning down: Esc in it
  // closes (escapeSettings), and with unsaved changes that asks again
  // rather than throwing them away on the earlier warning's word.
  useEffect(() => {
    if (vim.mode === 'insert') setCloseWarning(false)
  }, [vim.mode, setCloseWarning])

  const canRestartSyncSetup = !!syncInfo
    && syncInfo.state !== 'syncing'
    && (syncInfo.enabled || !!syncInfo.folderPath || !!syncInfo.lastSync)

  if (!open) return null

  return (
    <DetachedWindow
      open={open}
      title="Settings - Vimperium"
      width={920}
      height={720}
      // In Vim mode Esc steps back out (escapeSettings) instead.
      closeOnEscape={!vimNav}
      onClose={handleCancel}
      onWindowChange={setHostWindow}
    >
      <VimFormContext.Provider value={vimNav ? form : null}>
      <div data-vim-form className="h-full bg-card text-card-foreground flex flex-col overflow-hidden">
        {/* Header: the title, the filter that finds a setting, close */}
        <div
          data-detached-drag-handle
          className="flex items-center gap-4 px-6 py-3 border-b border-border"
        >
          <h2 className="text-base font-semibold text-foreground shrink-0">Settings</h2>
          <div ref={filterBoxRef} data-detached-no-drag className="relative ml-auto w-80">
            <InputField inputRef={filterRef} mode={vim.mode} pending={vim.pending} className="h-9">
              <Search size={14} className="shrink-0 text-muted-foreground" />
              <input
                ref={filterRef}
                type="text"
                value={filterQuery}
                onChange={(e) => { setFilterQuery(e.target.value); setFilterActive(true) }}
                onFocus={() => setFilterActive(true)}
                // In Vim mode the results stay for COMMAND's keys.
                onBlur={() => { if (!vimNav) setFilterActive(false) }}
                onKeyDown={onFilterKeyDown}
                spellCheck={false}
                aria-label="Find a setting"
                placeholder={vim.mode === 'command' && vimKeyCaps(settingsVimKeymap, 'filter')[0]
                  ? `Find a setting… (${vimKeyCaps(settingsVimKeymap, 'filter')[0]} to type)`
                  : 'Find a setting…'}
                className="flex-1 min-w-0 h-full bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
              />
            </InputField>
            {filterShown && (
              <div
                ref={filterListRef}
                role="listbox"
                aria-label="Settings found"
                // The filter keeps the keyboard while a result is pressed.
                onMouseDown={(e) => e.preventDefault()}
                className="absolute right-0 top-full z-50 mt-1.5 max-h-[360px] w-[440px] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
              >
                {filterResults.length === 0 ? (
                  <div className="px-2.5 py-2 text-xs text-muted-foreground">No settings match</div>
                ) : filterResults.map((entry, i) => (
                  <div
                    key={entry.item}
                    role="option"
                    aria-selected={i === filterSelected}
                    onMouseEnter={() => setFilterSelected(i)}
                    onClick={() => pickFilterResult(entry)}
                    className={cn(
                      'flex h-8 cursor-default select-none items-center gap-1.5 rounded-md px-2.5 text-xs',
                      i === filterSelected && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <span className="shrink-0 text-muted-foreground">{settingsSectionLabel(entry.section)} ›</span>
                    <span className="truncate text-foreground">{entry.title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            data-detached-no-drag
            onClick={handleCancel}
            aria-label="Close Settings"
            className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div ref={setFormRoot} className="flex-1 min-h-0 flex">
          {/* Sidebar — top group for the main panes, About pinned to the
              bottom under a separator (Edge / runwa-style). Labels reach
              each, j / k don't: J / K go through them. */}
          <aside className="w-52 bg-card border-r border-border p-3 flex flex-col shrink-0">
            {[SETTINGS_SECTIONS.filter((section) => section.id !== 'about'), SETTINGS_SECTIONS.filter((section) => section.id === 'about')].map((group, g) => (
              <nav key={g} className={cn('flex flex-col gap-1', g === 1 && 'mt-auto pt-3 border-t border-border')}>
                {group.map(({ id, label }) => {
                  const Icon = SECTION_ICONS[id]
                  return (
                    <button
                      key={id}
                      type="button"
                      data-vim-item={`nav:${id}`}
                      data-vim-nowalk
                      aria-current={activeTab === id ? 'page' : undefined}
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
                  )
                })}
              </nav>
            ))}
          </aside>

          {/* Content */}
          <div ref={setContentEl} className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          {activeTab === 'appearance' && (
            <div className="space-y-8">
              {/* Theme */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Theme</h3>
                <p className="text-[11px] text-muted-foreground mb-3">
                  Choose the overall family, then pick a brightness variant for each family.
                </p>
                <Segmented
                  label="Theme"
                  vimItem="appearance:theme"
                  value={theme}
                  onChange={(value) => { setTheme(value); previewAppearance({ theme: value }) }}
                  options={[
                    { value: 'system', label: 'System', icon: Monitor },
                    { value: 'light', label: 'Light', icon: Sun },
                    { value: 'dark', label: 'Dark', icon: Moon },
                  ]}
                />

                {/* Variant pickers — show only the family the current theme
                    can actually render. On 'system' we show both so the
                    user can tune each OS state independently. */}
                {(theme === 'light' || theme === 'system') && (
                  <div className="mt-3">
                    <div className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5">
                      <Sun size={11} />
                      Light variant
                    </div>
                    <Segmented
                      label="Light variant"
                      vimItem="appearance:light-variant"
                      wrap
                      value={lightVariant}
                      onChange={(id) => { setLightVariant(id); previewAppearance({ lightVariant: id }) }}
                      options={LIGHT_VARIANTS.map((v) => ({ value: v.id, label: v.label }))}
                    />
                  </div>
                )}

                {(theme === 'dark' || theme === 'system') && (
                  <div className="mt-3">
                    <div className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5">
                      <Moon size={11} />
                      Dark variant
                    </div>
                    <Segmented
                      label="Dark variant"
                      vimItem="appearance:dark-variant"
                      wrap
                      value={darkVariant}
                      onChange={(id) => { setDarkVariant(id); previewAppearance({ darkVariant: id }) }}
                      options={DARK_VARIANTS.map((v) => ({ value: v.id, label: v.label }))}
                    />
                  </div>
                )}
              </div>

              {/* Density */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Density</h3>
                <p className="text-[11px] text-muted-foreground mb-3">
                  Vertical breathing room between sidebar rows.
                </p>
                <Segmented
                  label="Density"
                  vimItem="appearance:density"
                  value={density}
                  onChange={(id) => { setDensity(id); previewAppearance({ density: id }) }}
                  options={DENSITIES.map((d) => ({ value: d.id, label: d.label, title: d.hint }))}
                />
              </div>

              {/* Vim's mode key cap. */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Vim mode indicator</h3>
                <p className="text-[11px] text-muted-foreground mb-3">
                  How the mode's key cap — CMD, WEB, INS — shows the mode's colour.
                </p>
                <div
                  role="radiogroup"
                  aria-label="Vim mode indicator"
                  data-vim-item="appearance:vim-indicator"
                  className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2 rounded-lg"
                >
                  {VIM_INDICATORS.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      role="radio"
                      aria-checked={vimIndicator === v.id}
                      onClick={() => { setVimIndicator(v.id); previewAppearance({ vimIndicator: v.id }) }}
                      title={v.hint}
                      className={`flex flex-col items-start gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        vimIndicator === v.id
                          ? 'border-primary bg-primary/10'
                          : 'border-border hover:bg-secondary'
                      }`}
                    >
                      <span className="flex gap-1.5">
                        <VimModeBadge mode="command" indicator={v.id} />
                        <VimModeBadge mode="insert" indicator={v.id} />
                      </span>
                      <span className="text-xs font-medium text-foreground">{v.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* The mode as a light on the address bar's edge. */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Vim mode edge</h3>
                <p className="text-[11px] text-muted-foreground mb-3">
                  A light moving round the address bar's edge in the mode's colours — cool for
                  COMMAND, green for INSERT — fading from one to the other as the mode changes.
                </p>
                <div
                  role="radiogroup"
                  aria-label="Vim mode edge"
                  data-vim-item="appearance:vim-edge"
                  className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2 rounded-lg"
                >
                  {VIM_EDGES.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      role="radio"
                      aria-checked={vimEdge === v.id}
                      onClick={() => { setVimEdge(v.id); previewAppearance({ vimEdge: v.id }) }}
                      title={v.hint}
                      className={`flex flex-col items-stretch gap-3 rounded-lg border px-3 pt-3.5 pb-2.5 text-left transition-colors ${
                        vimEdge === v.id
                          ? 'border-primary bg-primary/10'
                          : 'border-border hover:bg-secondary'
                      }`}
                    >
                      {(['command', 'insert'] as const).map((mode) => (
                        <span key={mode} className="field relative flex items-center justify-end h-6 rounded-md pr-1">
                          <VimModeBadge mode={mode} />
                          <ModeEdge mode={mode} edge={v.id} />
                        </span>
                      ))}
                      <span className="text-xs font-medium text-foreground">{v.label}</span>
                    </button>
                  ))}
                </div>
                <label className="mt-3 flex items-center gap-2.5 text-xs text-foreground cursor-pointer">
                  <Switch
                    label="Vim mode edge on every field"
                    vimItem="appearance:vim-edge-everywhere"
                    checked={vimEdgeEverywhere}
                    disabled={vimEdge === 'off'}
                    onChange={(on) => { setVimEdgeEverywhere(on); previewAppearance({ vimEdgeEverywhere: on }) }}
                  />
                  On every field that shows the mode too — Search Everything, the Command Palette,
                  Find, the address editor
                </label>
              </div>
            </div>
          )}

          {activeTab === 'darkPages' && (
            <DarkPagesSettings hintSettings={{ vimKeymap: vimKeymapText, keybindings }} />
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
                      <span className="block text-sm text-foreground">Use Vimperium password manager</span>
                      <span className="block text-[11px] text-muted-foreground mt-0.5">Enable filling and save prompts in website forms.</span>
                    </span>
                    <Switch label="Use Vimperium password manager" vimItem="pw:enabled" checked={passwordManagerEnabled} onChange={setPasswordManagerEnabled} />
                  </label>
                  <label className={`flex items-center justify-between gap-4 py-3 ${passwordManagerEnabled ? 'cursor-pointer' : 'opacity-50'}`}>
                    <span>
                      <span className="block text-sm text-foreground">Offer to save passwords</span>
                      <span className="block text-[11px] text-muted-foreground mt-0.5">Ask after a website sign-in or password change.</span>
                    </span>
                    <Switch label="Offer to save passwords" vimItem="pw:offer" checked={passwordOfferToSave} disabled={!passwordManagerEnabled} onChange={setPasswordOfferToSave} />
                  </label>
                  <div className={`flex items-center justify-between gap-4 py-3 ${passwordManagerEnabled ? '' : 'opacity-50'}`}>
                    <span>
                      <span className="block text-sm text-foreground">Autofill behavior</span>
                      <span className="block text-[11px] text-muted-foreground mt-0.5">Exact website matches only.</span>
                    </span>
                    <VimSelect
                      label="Autofill behavior"
                      vimItem="pw:autofill"
                      value={passwordAutofill}
                      disabled={!passwordManagerEnabled}
                      onChange={setPasswordAutofill}
                      options={[
                        { value: 'automatic', label: 'Fill automatically' },
                        { value: 'on-focus', label: 'Choose on field focus' },
                        { value: 'off', label: 'Never fill' },
                      ]}
                      className="h-8 px-2.5 text-xs field rounded-lg shrink-0"
                    />
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-end justify-between gap-4 mb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground mb-1">Saved passwords</h3>
                    <p className="text-[11px] text-muted-foreground">Each browser profile has its own password vault. Open an entry to see or copy its password.</p>
                  </div>
                  <VimSelect
                    label="Profile"
                    vimItem="pw:profile"
                    value={passwordPartition}
                    onChange={handlePasswordProfileChange}
                    options={profiles.map((profile) => ({ value: profile.partition, label: profile.name }))}
                    className="h-8 max-w-52 px-2.5 text-xs field rounded-lg"
                  />
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
                    {!edgeDetecting && edgeAppBoundPasswordCount > 0 && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {edgeAppBoundPasswordCount === edgeSource?.passwordCount ? 'All' : edgeAppBoundPasswordCount} protected by Edge; Using temporary CSV-file is required.
                      </p>
                    )}
                  </div>
                  {edgeSource?.supported && edgeSource.passwordCount > 0 && (
                    <div className="flex items-center gap-2 shrink-0">
                      {edgeDirectPasswordCount > 0 && (
                        <button
                          type="button"
                          data-vim-item="pw:edge-import"
                          onClick={() => setEdgeImportConfirmOpen(true)}
                          disabled={!passwordPartition || edgeImporting}
                          className="flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                        >
                          {edgeImporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                          {edgeImporting ? 'Importing…' : 'Import from Edge'}
                        </button>
                      )}
                      {edgeAppBoundPasswordCount > 0 && (
                        <button
                          type="button"
                          data-vim-item="pw:edge-export-help"
                          onClick={() => setEdgeExportHelpOpen((current) => !current)}
                          disabled={!passwordPartition}
                          className={`flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium hover:opacity-90 disabled:opacity-50 ${
                            edgeDirectPasswordCount > 0
                              ? 'bg-secondary text-secondary-foreground'
                              : 'bg-primary text-primary-foreground'
                          }`}
                        >
                          <ExternalLink size={13} />
                          Import from Edge…
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {edgeExportHelpOpen && edgeAppBoundPasswordCount > 0 && edgeSource && (
                  <div className="mb-3 rounded-md border border-input bg-secondary/40 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold text-foreground">Move Edge-protected passwords</p>
                        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                          Edge's app-bound encryption only lets Edge unlock these passwords. Export each profile below, then import each CSV into {profileNameForPartition(passwordPartition)}. Exported CSV files contain plaintext passwords.
                        </p>
                      </div>
                      <button
                        type="button"
                        data-vim-item="pw:edge-help-close"
                        onClick={() => setEdgeExportHelpOpen(false)}
                        className="h-6 w-6 shrink-0 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label="Close Edge export help"
                      >
                        <X size={13} />
                      </button>
                    </div>
                    <div className="mt-3 space-y-2">
                      {edgeSource.profiles.filter((profile) => profile.appBoundPasswordCount > 0).map((profile) => (
                        <div key={profile.id} className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-xs text-foreground">{profile.name}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {profile.appBoundPasswordCount} protected {profile.appBoundPasswordCount === 1 ? 'password' : 'passwords'}
                            </p>
                          </div>
                          <button
                            type="button"
                            data-vim-item={`pw:edge-open:${profile.id}`}
                            onClick={() => handleOpenEdgePasswordExport(profile.id)}
                            disabled={edgeExportOpeningProfile !== null}
                            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-secondary px-3 text-xs font-medium text-secondary-foreground hover:bg-muted disabled:opacity-50"
                          >
                            {edgeExportOpeningProfile === profile.id
                              ? <Loader2 size={12} className="animate-spin" />
                              : <ExternalLink size={12} />}
                            Open in Edge
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
                      <p className="text-[10px] leading-relaxed text-muted-foreground">
                        In Edge choose More → Export passwords, approve Windows authentication, and save the CSV. Delete it after import.
                      </p>
                      <button
                        type="button"
                        data-vim-item="pw:edge-choose-csv"
                        onClick={handleImportPasswords}
                        disabled={!passwordPartition || passwordImporting}
                        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                      >
                        {passwordImporting ? <Loader2 size={12} className="animate-spin" /> : <FileUp size={12} />}
                        Choose CSV to import
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <button
                    type="button"
                    data-vim-item="pw:add"
                    onClick={() => { setPasswordEditor({ origin: '', username: '', password: '' }); setPasswordError(null); setPasswordNotice(null) }}
                    disabled={!passwordPartition}
                    className="flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    <Plus size={13} />
                    Add password
                  </button>
                  <button
                    type="button"
                    data-vim-item="pw:import-csv"
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
                      data-vim-item="pw:remove-all"
                      data-vim-danger
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
                        data-vim-item="pw:editor-close"
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
                          data-vim-item="pw:editor-origin"
                          type="text"
                          value={passwordEditor.origin}
                          onChange={(event) => setPasswordEditor((current) => current ? { ...current, origin: event.target.value } : current)}
                          placeholder="https://example.com"
                          spellCheck={false}
                          className="w-full h-9 px-3 field rounded-xl text-sm text-foreground outline-none"
                        />
                      </label>
                      <label>
                        <span className="block text-[11px] font-medium text-muted-foreground mb-1">Username or email</span>
                        <input
                          data-vim-item="pw:editor-username"
                          type="text"
                          value={passwordEditor.username}
                          onChange={(event) => setPasswordEditor((current) => current ? { ...current, username: event.target.value } : current)}
                          autoComplete="off"
                          className="w-full h-9 px-3 field rounded-xl text-sm text-foreground outline-none"
                        />
                      </label>
                      <label>
                        <span className="block text-[11px] font-medium text-muted-foreground mb-1">
                          Password {passwordEditor.id && passwordEditor.original === undefined && passwordBusyId !== passwordEditor.id && (
                            <span className="font-normal">(blank keeps current)</span>
                          )}
                        </span>
                        <div className="relative">
                          <input
                            data-vim-item="pw:editor-password"
                            type={editorPasswordVisible ? 'text' : 'password'}
                            value={passwordEditor.password}
                            onChange={(event) => setPasswordEditor((current) => current ? { ...current, password: event.target.value } : current)}
                            autoComplete="new-password"
                            spellCheck={false}
                            placeholder={passwordEditor.id && passwordBusyId === passwordEditor.id ? 'Loading…' : undefined}
                            className="w-full h-9 pl-3 pr-9 field rounded-xl text-sm text-foreground outline-none"
                          />
                          <button
                            type="button"
                            data-vim-item="pw:editor-show"
                            onClick={() => setEditorPasswordVisible((visible) => !visible)}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label={editorPasswordVisible ? 'Hide password' : 'Show password'}
                            title={editorPasswordVisible ? 'Hide password' : 'Show password'}
                          >
                            {editorPasswordVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        </div>
                      </label>
                    </div>
                    <div className="flex justify-end gap-2 mt-3">
                      <button
                        type="button"
                        data-vim-item="pw:editor-cancel"
                        onClick={() => setPasswordEditor(null)}
                        className="h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:bg-muted"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        data-vim-item="pw:editor-save"
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
                      data-vim-item="pw:search"
                      type="search"
                      value={passwordSearch}
                      onChange={(event) => setPasswordSearch(event.target.value)}
                      placeholder="Search websites and usernames"
                      className="w-full h-9 pl-9 pr-3 field rounded-xl text-sm text-foreground outline-none"
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
                  <div className="border-y border-border divide-y divide-border" onKeyDown={handlePasswordListKeyDown}>
                    {filteredPasswordEntries.map((entry) => {
                      const host = originHost(entry.origin)
                      const isOpen = openPasswordId === entry.id
                      const revealed = revealedPasswords[entry.id]
                      const busy = passwordBusyId === entry.id
                      const copied = (field: 'username' | 'password'): boolean =>
                        copiedPasswordField?.id === entry.id && copiedPasswordField.field === field
                      const rowButton = 'h-7 w-7 shrink-0 flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'
                      return (
                        <div key={entry.id} data-password-item>
                          <div data-vim-item={`pw-row:${entry.id}`} data-vim-kind="row" className="group flex items-center gap-1 py-2 rounded-md">
                            {/* The row opens the record — Edge's password details. */}
                            <button
                              type="button"
                              data-password-row
                              data-vim-cell="open"
                              onClick={() => setOpenPasswordId(isOpen ? null : entry.id)}
                              aria-expanded={isOpen}
                              className="min-w-0 flex-1 flex items-center gap-3 rounded-md py-1 pl-1 pr-2 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <div className="h-8 w-8 rounded-md bg-secondary flex items-center justify-center text-muted-foreground shrink-0">
                                <Globe size={14} />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm text-foreground truncate" title={entry.origin}>
                                  {entry.name || host}
                                </p>
                                <p className="text-[11px] text-muted-foreground truncate">
                                  {entry.username} · {host}
                                </p>
                              </div>
                              <ChevronDown size={14} className={`shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                            </button>
                            <button
                              type="button"
                              data-vim-cell="copy"
                              onClick={() => copyPasswordEntryField(entry, 'username')}
                              className={rowButton}
                              aria-label={`Copy username ${entry.username}`}
                              title="Copy username"
                            >
                              {copied('username') ? <Check size={12} className="text-green-500" /> : <UserRound size={12} />}
                            </button>
                            <button
                              type="button"
                              data-vim-cell="copy-password"
                              onClick={() => copyPasswordEntryField(entry, 'password')}
                              disabled={busy}
                              className={rowButton}
                              aria-label={`Copy password for ${entry.username}`}
                              title="Copy password"
                            >
                              {busy ? <Loader2 size={12} className="animate-spin" /> : copied('password') ? <Check size={12} className="text-green-500" /> : <KeyRound size={12} />}
                            </button>
                            <button
                              type="button"
                              data-vim-cell="edit"
                              onClick={() => startEditPassword(entry)}
                              className={rowButton}
                              aria-label={`Edit ${entry.username}`}
                              title="Edit"
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              type="button"
                              data-vim-cell="remove"
                              onClick={() => handleDeletePassword(entry.id)}
                              className={`${rowButton} hover:text-destructive`}
                              aria-label={`Remove ${entry.username}`}
                              title="Remove"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>

                          {isOpen && (
                            <div data-vim-item={`pw-detail:${entry.id}`} data-vim-kind="row" className="mb-3 ml-11 mr-1 rounded-md border border-border bg-secondary/40 px-3 py-1">
                              <dl className="divide-y divide-border">
                                <div className="flex items-center gap-3 py-2">
                                  <dt className="w-20 shrink-0 text-[11px] font-medium text-muted-foreground">Website</dt>
                                  <dd className="min-w-0 flex-1 truncate text-sm text-foreground select-text" title={entry.origin}>{entry.origin}</dd>
                                </div>
                                <div className="flex items-center gap-3 py-2">
                                  <dt className="w-20 shrink-0 text-[11px] font-medium text-muted-foreground">Username</dt>
                                  <dd className="min-w-0 flex-1 truncate text-sm text-foreground select-text">{entry.username}</dd>
                                  <button
                                    type="button"
                                    data-vim-cell="copy"
                                    onClick={() => copyPasswordEntryField(entry, 'username')}
                                    className="h-7 px-2 shrink-0 flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                                  >
                                    {copied('username') ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                                    {copied('username') ? 'Copied' : 'Copy'}
                                  </button>
                                </div>
                                <div className="flex items-center gap-3 py-2">
                                  <dt className="w-20 shrink-0 text-[11px] font-medium text-muted-foreground">Password</dt>
                                  <dd className="min-w-0 flex-1">
                                    {revealed !== undefined ? (
                                      <span className="font-mono text-sm text-foreground break-all select-text">{revealed}</span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => togglePasswordReveal(entry.id)}
                                        disabled={busy}
                                        className="font-mono text-sm tracking-[0.2em] text-foreground hover:text-primary disabled:opacity-60"
                                        title="Show password"
                                      >
                                        ••••••••••
                                      </button>
                                    )}
                                  </dd>
                                  <button
                                    type="button"
                                    data-vim-cell="reveal"
                                    onClick={() => togglePasswordReveal(entry.id)}
                                    disabled={busy}
                                    className="h-7 w-7 shrink-0 flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                                    aria-label={revealed !== undefined ? 'Hide password' : 'Show password'}
                                    title={revealed !== undefined ? 'Hide password' : 'Show password'}
                                  >
                                    {busy ? <Loader2 size={12} className="animate-spin" /> : revealed !== undefined ? <EyeOff size={12} /> : <Eye size={12} />}
                                  </button>
                                  <button
                                    type="button"
                                    data-vim-cell="copy-password"
                                    onClick={() => copyPasswordEntryField(entry, 'password')}
                                    disabled={busy}
                                    className="h-7 px-2 shrink-0 flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                                  >
                                    {copied('password') ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                                    {copied('password') ? 'Copied' : 'Copy'}
                                  </button>
                                </div>
                                <div className="flex items-center gap-3 py-2">
                                  <dt className="w-20 shrink-0 text-[11px] font-medium text-muted-foreground">Activity</dt>
                                  <dd className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                                    {entry.lastUsedAt ? `Last used ${formatPasswordDate(entry.lastUsedAt)}` : 'Never used to sign in'}
                                    {' · '}Saved {formatPasswordDate(entry.createdAt)}
                                    {entry.updatedAt > entry.createdAt && ` · Changed ${formatPasswordDate(entry.updatedAt)}`}
                                  </dd>
                                </div>
                              </dl>
                              <div className="flex justify-end gap-2 py-2">
                                <button
                                  type="button"
                                  data-vim-cell="edit"
                                  onClick={() => startEditPassword(entry)}
                                  className="h-7 px-2.5 flex items-center gap-1.5 rounded-md text-xs font-medium bg-secondary text-secondary-foreground hover:bg-muted"
                                >
                                  <Pencil size={12} />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  data-vim-cell="remove"
                                  onClick={() => handleDeletePassword(entry.id)}
                                  className="h-7 px-2.5 flex items-center gap-1.5 rounded-md text-xs font-medium text-destructive hover:bg-destructive/10"
                                >
                                  <Trash2 size={12} />
                                  Remove
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
                  Direct Edge import asks the operating system to unlock the local Edge vault and leaves Edge unchanged.
                  CSV files contain readable passwords, so delete them when you no longer need them. Passwords are not included in Cloud Sync.
                </p>
              </div>

              {passkeysSupported && (
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-1">Passkeys</h3>
                  <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
                    Saved when a website offers to create a passkey. Signing in with one asks for Touch ID.
                    They stay on this Mac and aren&apos;t included in Cloud Sync. For a passkey from iCloud Keychain
                    (Safari, the Passwords app), choose Use iPhone when signing in, or sign in to a site with no
                    passkey here: Vimperium shows a QR code to scan with your iPhone.
                  </p>
                  {passkeys.length === 0 ? (
                    <div className="py-8 text-center border-y border-border">
                      <FingerprintPattern size={21} className="mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-foreground">No passkeys in this profile</p>
                      <p className="text-[11px] text-muted-foreground mt-1">Add one in a website&apos;s security settings to sign in with Touch ID.</p>
                    </div>
                  ) : (
                    <div className="border-y border-border divide-y divide-border">
                      {passkeys.map((passkey) => (
                        <div key={passkey.id} data-vim-item={`passkey:${passkey.id}`} data-vim-kind="row" className="flex items-center gap-3 py-2 rounded-md">
                          <div className="h-8 w-8 rounded-md bg-secondary flex items-center justify-center text-muted-foreground shrink-0">
                            <FingerprintPattern size={14} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-foreground truncate">{passkey.rpId}</p>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {passkey.userName || passkey.userDisplayName || 'No username'}
                              {' · '}
                              {passkey.lastUsedAt ? `Last used ${formatPasswordDate(passkey.lastUsedAt)}` : 'Never used to sign in'}
                              {' · '}Saved {formatPasswordDate(passkey.createdAt)}
                            </p>
                          </div>
                          <button
                            type="button"
                            data-vim-cell="remove"
                            onClick={() => setPasskeyToRemove(passkey)}
                            className="h-7 px-2.5 flex items-center gap-1.5 rounded-md text-xs font-medium text-destructive hover:bg-destructive/10 shrink-0"
                          >
                            <Trash2 size={12} />
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'sync' && (
            <div className="space-y-8">
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-1">Cloud Sync</h3>
                <p className="text-[11px] text-muted-foreground mb-3">
                  Sync your data across devices through a folder that OneDrive, Dropbox, Google
                  Drive or iCloud Drive already keeps in the cloud. No account needed — Vimperium just
                  reads and writes JSON files directly in the folder you pick.
                </p>

                {/* Enable toggle */}
                <label className="flex items-center gap-2.5 mb-4 cursor-pointer">
                  <Switch
                    label="Enable cloud sync"
                    vimItem="sync:enabled"
                    checked={!!syncInfo?.enabled}
                    disabled={!syncInfo?.folderPath}
                    onChange={setSyncEnabled}
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
                      data-vim-item="sync:choose-folder"
                      onClick={chooseSyncFolder}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-secondary text-secondary-foreground hover:bg-muted shrink-0"
                    >
                      <FolderOpen size={14} />
                      Choose folder…
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Pick a folder inside OneDrive / Dropbox / Google Drive / iCloud Drive so the files
                    reach your other devices. They go straight into it, named like
                    settings.&lt;device-id&gt;.json; anything else in the folder is left alone.
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
                      <Switch
                        label={label}
                        vimItem={`sync-cat:${id}`}
                        checked={syncInfo?.categories?.[id] ?? true}
                        disabled={!syncInfo?.enabled}
                        onChange={(on) => toggleSyncCategory(id, on)}
                        className="mt-0.5"
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
                    data-vim-item="sync:now"
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
                  data-vim-item="sync:restart"
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
                  data-vim-item="general:default-url"
                  type="text"
                  value={defaultUrl}
                  onChange={(e) => setDefaultUrl(e.target.value)}
                  placeholder="about:blank (leave empty for blank page)"
                  className="w-full h-9 px-3 field rounded-xl text-sm text-foreground outline-none"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  The URL to load when creating a new tab. Leave empty for a blank page.
                </p>
              </div>

              {/* New-tab focus target */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Focus on New Tab</label>
                <Segmented
                  label="Focus on New Tab"
                  vimItem="general:new-tab-focus"
                  value={newTabFocus}
                  onChange={setNewTabFocus}
                  options={[
                    { value: 'site', label: 'Site', title: 'Keystrokes go straight to the loaded page.' },
                    { value: 'url', label: 'URL bar', title: 'Type a URL right away, like a fresh Chrome tab.' },
                  ]}
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Where keyboard focus lands when a new tab is opened.
                </p>
              </div>

              {/* Search engine */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Default Search Engine</label>
                <Segmented
                  label="Default Search Engine"
                  vimItem="general:search-engine"
                  wrap
                  value={Object.values(SEARCH_ENGINES).includes(searchEngine) ? searchEngine : CUSTOM_ENGINE}
                  onChange={(url) => setSearchEngine(url === CUSTOM_ENGINE ? '' : url)}
                  options={[
                    ...Object.entries(SEARCH_ENGINES).map(([name, url]) => ({ value: url, label: name })),
                    { value: CUSTOM_ENGINE, label: 'Custom' },
                  ]}
                />
                {(() => {
                  const isCustom = !Object.values(SEARCH_ENGINES).includes(searchEngine)
                  return (
                    <>
                      <input
                        // Read-only, it's no setting for the keys to stop at.
                        data-vim-item={isCustom ? 'general:custom-engine' : undefined}
                        type="text"
                        value={searchEngine}
                        onChange={(e) => isCustom && setSearchEngine(e.target.value)}
                        readOnly={!isCustom}
                        placeholder="https://example.com/search?q=%s"
                        className={`w-full h-9 px-3 mt-2 rounded-xl text-sm outline-none font-mono ${
                          isCustom
                            ? 'field text-foreground'
                            : 'bg-secondary/50 text-muted-foreground cursor-default'
                        }`}
                        // Not in Vim mode, where h / l stepping onto Custom
                        // would land the next key in the field.
                        autoFocus={isCustom && !vimNav}
                      />
                      {isCustom && (
                        <p className="text-[11px] text-muted-foreground mt-1">
                          Use %s as placeholder for the search query.
                        </p>
                      )}
                    </>
                  )
                })()}
                <label className="flex items-center justify-between gap-4 mt-3 cursor-pointer">
                  <span>
                    <span className="block text-sm text-foreground">Show search suggestions</span>
                    <span className="block text-[11px] text-muted-foreground mt-0.5">
                      Ask the search engine for suggestions while you type in the address bar (Google, Yandex, DuckDuckGo, Bing).
                    </span>
                  </span>
                  <Switch label="Show search suggestions" vimItem="general:suggestions" checked={searchSuggestions} onChange={setSearchSuggestions} />
                </label>
                <label className="flex items-center justify-between gap-4 mt-3 cursor-pointer">
                  <span>
                    <span className="block text-sm text-foreground">Bangs</span>
                    <span className="block text-[11px] text-muted-foreground mt-0.5">
                      <span className="font-mono">!w vim</span> or <span className="font-mono">vim !w</span> in the address bar goes straight to Wikipedia's search — resolved here in the browser, whichever engine is chosen.
                    </span>
                  </span>
                  <Switch label="Bangs" vimItem="general:bangs" checked={bangsEnabled} onChange={setBangsEnabled} />
                </label>
                <button
                  data-vim-item="general:manage-bangs"
                  onClick={() => {
                    handleSave()
                    useAppStore.getState().showInternalPage(BANGS_URL)
                  }}
                  className="mt-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-secondary"
                  title="Save Settings and open the Bangs page (vimperium://bangs)"
                >
                  Manage bangs…
                  <ExternalLink size={12} />
                </button>
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
                          Vimperium is your default browser
                        </>
                      ) : (
                        <>
                          <Compass size={12} className="text-muted-foreground shrink-0" />
                          {defaultBrowserStatus
                            ? "Vimperium isn't your default browser"
                            : 'Checking default browser status…'}
                        </>
                      )}
                    </p>
                    {defaultBrowserStatus && !defaultBrowserStatus.isDefault && (
                      <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                        {defaultBrowserStatus.platform === 'darwin'
                          ? 'macOS will ask you to confirm the change.'
                          : defaultBrowserStatus.platform === 'win32'
                            ? 'Windows opens its Default Apps page; pick Vimperium for HTTP and HTTPS there.'
                            : 'Best effort via xdg-mime — your desktop environment may still prompt or ignore the change.'}
                      </p>
                    )}
                    {defaultBrowserSystemPaneOpened && !defaultBrowserStatus?.isDefault && (
                      <p className="text-[11px] text-foreground/80 mt-1 leading-relaxed">
                        Settings opened. After picking Vimperium for HTTP and HTTPS, click Refresh.
                      </p>
                    )}
                  </div>
                  {defaultBrowserStatus?.isDefault ? null : defaultBrowserSystemPaneOpened ? (
                    <button
                      data-vim-item="general:default-browser"
                      onClick={handleRefreshDefaultBrowser}
                      disabled={defaultBrowserBusy}
                      className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border bg-secondary text-secondary-foreground border-input hover:bg-accent disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <RotateCcw size={12} />
                      Refresh
                    </button>
                  ) : (
                    <button
                      data-vim-item="general:default-browser"
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

              {/* Another browser for links — the Open Link picker's ⌘↵ / Ctrl+Enter. */}
              {otherBrowserSupported && (
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <label className="block text-sm font-medium text-foreground">Open links in another browser</label>
                    <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                      When a link from another app asks where to open, {passOnKeys} sends it to this browser instead
                      {otherBrowserOnMac
                        ? ' — say, for a site whose passkey is in iCloud Keychain, to sign in with Touch ID there.'
                        : ' — say, for a site that works better there.'}
                    </p>
                  </div>
                  <VimSelect
                    label="Open links in another browser"
                    vimItem="general:other-browser"
                    value={otherBrowser?.id ?? ''}
                    onChange={handleOtherBrowserChange}
                    options={[
                      { value: '', label: `Ask on first ${passOnKeys}` },
                      ...installedBrowsers.map((browser) => ({ value: browser.id, label: browser.name })),
                      ...(otherBrowser && !installedBrowsers.some((browser) => browser.id === otherBrowser.id)
                        ? [{ value: otherBrowser.id, label: `${otherBrowser.name} (not found)` }]
                        : []),
                    ]}
                    className="h-8 max-w-52 px-2.5 text-xs field rounded-lg shrink-0"
                  />
                </div>
              )}

              {/* Notifications — checks that the OS shows Vimperium's toasts, the
                  kind extensions (Claude's "needs your attention") send. */}
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <label className="block text-sm font-medium text-foreground">Notifications</label>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Send a test notification — the same kind extensions such as Claude use to ask for your attention.
                  </p>
                  {testNotice && (
                    <p className={`text-[11px] mt-1 ${testNotice.ok ? 'text-foreground' : 'text-destructive'}`}>
                      {testNotice.text}
                    </p>
                  )}
                </div>
                <button
                  data-vim-item="general:test-notification"
                  onClick={handleTestNotification}
                  className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border bg-secondary text-secondary-foreground border-input hover:bg-accent"
                >
                  <Bell size={12} />
                  Send test notification
                </button>
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
                      Permanently deletes the entire Vimperium application directory, including every
                      workspace, tab, bookmark, cookie, login session, cache, history, setting, and
                      keybinding. The app will relaunch as if freshly installed. This action cannot
                      be undone.
                    </p>
                  </div>
                  <button
                    data-vim-item="general:wipe"
                    data-vim-danger
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
                <Segmented
                  label="Proxy"
                  vimItem="network:proxy"
                  wrap
                  className="mb-2"
                  value={proxy.mode}
                  onChange={(mode) => setProxy((prev) => ({ ...prev, mode }))}
                  options={[
                    { value: 'system', label: 'System' },
                    { value: 'direct', label: 'Direct (No Proxy)' },
                    { value: 'custom', label: 'Custom Proxy' },
                  ]}
                />

                {proxy.mode === 'custom' && (
                  <div className="space-y-2">
                    <input
                      data-vim-item="network:proxy-rules"
                      type="text"
                      value={proxy.proxyRules}
                      onChange={(e) => setProxy((prev) => ({ ...prev, proxyRules: e.target.value }))}
                      placeholder="http://127.0.0.1:8080 or socks5://127.0.0.1:1080"
                      className="w-full h-9 px-3 field rounded-xl text-sm text-foreground outline-none"
                    />
                    <input
                      data-vim-item="network:proxy-bypass"
                      type="text"
                      value={proxy.proxyBypassRules}
                      onChange={(e) => setProxy((prev) => ({ ...prev, proxyBypassRules: e.target.value }))}
                      placeholder="<-loopback>;localhost;*.internal"
                      className="w-full h-9 px-3 field rounded-xl text-sm text-foreground outline-none"
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
                <VimSelect
                  label="DNS-over-HTTPS"
                  vimItem="network:doh"
                  value={dohMode}
                  onChange={setDohMode}
                  options={[
                    { value: 'off', label: 'Off (use OS DNS only)' },
                    { value: 'automatic', label: 'Automatic (OS DNS first, DoH as fallback) — recommended' },
                    { value: 'secure', label: 'Secure (DoH only — breaks corporate VPN intranet)' },
                  ]}
                  className="w-full h-9 px-3 text-sm field rounded-xl"
                />
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
                  {' '}Restart Vimperium after changing this — Chromium applies DNS configuration at startup.
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
                  data-vim-item="enterprise:sso"
                  value={authServerAllowlist}
                  onChange={(e) => setAuthServerAllowlist(e.target.value)}
                  rows={2}
                  spellCheck={false}
                  placeholder="owa.example.com, *.corp.example.com"
                  className="w-full px-3 py-2 text-sm field text-foreground rounded-xl outline-none font-mono"
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
                  this empty and use a <span className="text-foreground">saved sign-in</span> below instead. Restart Vimperium after
                  changing this — it applies at startup.
                </p>
              </div>

              {/* Saved sign-ins (remembered HTTP-auth credentials) */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Saved sign-ins</label>
                <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                  Corporate credentials you asked Vimperium to remember from the sign-in prompt. Vimperium answers
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
                      <div key={c.host} data-vim-item={`cred:${c.host}`} data-vim-kind="row" className="flex items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-foreground truncate" title={c.host}>{c.host}</p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {c.username}{c.scheme ? ` · ${c.scheme.toUpperCase()}` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          data-vim-cell="remove"
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
                        data-vim-item="enterprise:clear-creds"
                        data-vim-danger
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
                  Vimperium downloads the .crx, unpacks it locally, and loads it
                  into every profile. Manifest V3 extensions work best; some
                  Manifest V2 features (notably blocking webRequest) are not
                  supported by Electron.
                </p>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  data-vim-item="ext:store-chrome"
                  onClick={() => handleOpenStoreUrl('https://chromewebstore.google.com/category/extensions')}
                  className="h-8 px-3 flex items-center gap-1.5 rounded-md text-xs font-medium bg-secondary text-secondary-foreground hover:bg-muted border border-input"
                  title="Open Chrome Web Store"
                >
                  <Globe size={13} />
                  Chrome Web Store
                  <ExternalLink size={11} className="text-muted-foreground" />
                </button>
                <button
                  data-vim-item="ext:store-edge"
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
                  data-vim-item="ext:install-input"
                  type="text"
                  value={extInput}
                  onChange={(e) => setExtInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !extInstalling) handleInstallExtension() }}
                  placeholder="https://chromewebstore.google.com/detail/…/<id> or <id>"
                  className="flex-1 h-9 px-3 field rounded-xl text-sm text-foreground outline-none font-mono"
                  disabled={extInstalling}
                />
                <button
                  data-vim-item="ext:install"
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
                    <div key={ext.id} data-vim-item={`ext-row:${ext.id}`} data-vim-kind="row" className="flex items-start gap-3 px-4 py-3">
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
                        {(() => {
                          const commands = extCommands[ext.id] ?? []
                          const expanded = expandedExtensions.has(ext.id)
                          const permissionCount = new Set([
                            ...ext.hostPermissions,
                            ...ext.permissions,
                            ...(ext.optionalPermissions ?? []),
                            ...(ext.contentScriptMatches ?? []),
                          ]).size
                          return (
                            <>
                              <button
                                type="button"
                                data-vim-cell="details"
                                aria-expanded={expanded}
                                onClick={() => toggleExtensionDetails(ext.id)}
                                className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                              >
                                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                {permissionCount} permission{permissionCount === 1 ? '' : 's'}
                                {commands.length > 0 &&
                                  ` · ${commands.length} keyboard shortcut${commands.length === 1 ? '' : 's'}`}
                              </button>
                              {expanded && (
                                <div className="mt-2 flex flex-col gap-3 rounded-md border border-border p-3">
                                  {!ext.permissionsFromOriginal && (
                                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                                      Read from Vimperium's adjusted manifest, which also grants access to all
                                      sites. The extension's own list appears once Vimperium re-downloads it.
                                    </p>
                                  )}
                                  <ExtensionPermissionList
                                    permissions={ext.permissions}
                                    hostPermissions={ext.hostPermissions}
                                    optionalPermissions={ext.optionalPermissions}
                                    contentScriptMatches={ext.contentScriptMatches}
                                  />
                                  {commands.length > 0 && (
                                    <div>
                                      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                        Keyboard shortcuts
                                      </div>
                                      <div className="flex flex-col gap-1">
                                        {commands.map((c) => {
                                          const recording =
                                            recordingCommand?.extensionId === ext.id && recordingCommand.command === c.name
                                          return (
                                            <div key={c.name} data-vim-item={`ext-cmd:${ext.id}:${c.name}`} data-vim-kind="row" className="flex items-center justify-between gap-3 rounded">
                                              <span className="min-w-0 truncate text-xs text-foreground" title={c.description}>
                                                {c.description}
                                              </span>
                                              <div className="flex shrink-0 items-center gap-1">
                                                <button
                                                  type="button"
                                                  data-vim-cell="record"
                                                  onClick={() => {
                                                    setCommandError(null)
                                                    setRecordingCommand(recording ? null : { extensionId: ext.id, command: c.name })
                                                  }}
                                                  title="Click, then press the new shortcut (Escape cancels)"
                                                  className={`h-6 min-w-[96px] rounded border px-2 text-[11px] ${
                                                    recording
                                                      ? 'border-primary text-primary'
                                                      : 'border-input text-foreground hover:bg-muted'
                                                  }`}
                                                >
                                                  {recording ? 'Press keys…' : c.shortcut ? formatAccelerator(c.shortcut) : 'Not set'}
                                                </button>
                                                {c.shortcut && !recording && (
                                                  <button
                                                    type="button"
                                                    data-vim-cell="remove"
                                                    onClick={() => applyExtensionCommand(ext.id, c.name, '')}
                                                    title="Remove shortcut"
                                                    className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                                  >
                                                    <X size={11} />
                                                  </button>
                                                )}
                                              </div>
                                            </div>
                                          )
                                        })}
                                      </div>
                                      {commandError?.extensionId === ext.id && (
                                        <p className="mt-1 text-[11px] text-destructive">{commandError.message}</p>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </>
                          )
                        })()}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {ext.hasAction && (
                          <button
                            data-vim-cell="pin"
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
                            data-vim-cell="options"
                            onClick={() => handleOpenExtensionOptions(ext.id)}
                            className="h-7 px-2 rounded-md text-[11px] bg-secondary text-secondary-foreground hover:bg-muted flex items-center gap-1"
                            title="Open options page"
                          >
                            <ExternalLink size={11} />
                            Options
                          </button>
                        )}
                        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                          <Switch
                            label={`${ext.name} enabled`}
                            vimCell="enabled"
                            checked={ext.enabled}
                            onChange={(on) => handleToggleExtension(ext.id, on)}
                          />
                          Enabled
                        </label>
                        <button
                          data-vim-cell="remove"
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
              {/* Vim is Vimperium's only mode: no switch, and no regular
                  shortcuts to record — the keymap below is all the keys. */}
              <div>
                <h3 className="text-lg font-semibold text-foreground">Vim Mode</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  Vimperium runs on two modes, shown in the address bar. COMMAND: plain keys drive the
                  page and the browser, the way Vimium does — scrolling, history, tabs, app commands;
                  keys not bound reach the page. INSERT: keys go to the page or the field you're typing in.
                  i goes into INSERT, Esc or Ctrl+[ comes back; in a popup (Search Everything, Find,
                  the address editor, a dialog, Settings) Ctrl+C or Ctrl+[ leaves its field and Esc
                  closes it. Clicking a text field is INSERT,
                  anywhere else COMMAND. Ctrl+J/K step through the Sidebar's tabs and groups, Ctrl+H/L
                  fold and unfold, Tab shows or hides it. ? lists every key. The system's own shortcuts
                  — copy, paste, undo, quit — work as everywhere else.
                </p>
              </div>

              <div className="mt-4 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm text-foreground">Hide the Sidebar in INSERT</div>
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                    Going into INSERT in a page hides the Sidebar; COMMAND brings it back.
                  </p>
                </div>
                <Switch
                  size="md"
                  label="Hide the Sidebar in INSERT"
                  vimItem="shortcuts:hide-sidebar-insert"
                  checked={hideSidebarInInsert}
                  onChange={setHideSidebarInInsert}
                  className="mt-1"
                />
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between gap-4 mb-2">
                  <p className="text-sm text-muted-foreground">
                    One <code className="font-mono text-xs">command keys…</code> per line;
                    the <code className="font-mono text-xs">search-</code>,{' '}
                    <code className="font-mono text-xs">find-</code> and <code className="font-mono text-xs">url-</code> prefixes say where a command works.
                  </p>
                  <button
                    type="button"
                    data-vim-item="shortcuts:vim-reset"
                    onClick={() => setVimKeymapText(DEFAULT_VIM_KEYMAP)}
                    disabled={vimKeymapText === DEFAULT_VIM_KEYMAP}
                    className="shrink-0 flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <RotateCcw size={12} />
                    Reset to Defaults
                  </button>
                </div>
                <textarea
                  data-vim-item="shortcuts:vim-keymap"
                  value={vimKeymapText}
                  onChange={(event) => setVimKeymapText(event.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  wrap="off"
                  rows={24}
                  className="w-full px-3 py-2 field rounded-xl font-mono text-xs leading-relaxed text-foreground outline-none resize-y"
                />
                {vimKeymapErrors.length > 0 && (
                  <div className="mt-2 px-3 py-2 rounded-md border border-destructive/40 bg-destructive/10 text-xs text-destructive space-y-0.5">
                    <div className="font-medium">These lines are ignored:</div>
                    {vimKeymapErrors.map((error) => (
                      <div key={error} className="font-mono">{error}</div>
                    ))}
                  </div>
                )}
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
                      <VimSelect
                        label={PERMISSION_LABEL[kind]}
                        vimItem={`perm-default:${kind}`}
                        value={permissionDefaults[kind]}
                        onChange={(policy) => setPermissionDefaults((prev) => ({ ...prev, [kind]: policy }))}
                        options={(['ask', 'allow', 'block'] as PermissionPolicy[]).map((p) => ({ value: p, label: PERMISSION_POLICY_LABEL[p] }))}
                        className="w-32 h-8 px-2.5 text-sm field rounded-xl"
                      />
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
                      data-vim-item="perm:clear-all"
                      data-vim-danger
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
                      <VimSelect
                        label="Profile"
                        title="Profile"
                        vimItem="perm:add-profile"
                        value={addSitePartition || profiles[0]?.partition || ''}
                        onChange={setAddSitePartition}
                        options={profiles.map((p) => ({ value: p.partition, label: p.name }))}
                        className="h-9 px-2.5 text-sm field rounded-xl"
                      />
                    )}
                    <input
                      data-vim-item="perm:add-origin"
                      type="text"
                      value={addSiteOrigin}
                      onChange={(e) => { setAddSiteOrigin(e.target.value); setAddSiteError(null) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddSite() }}
                      placeholder="https://meet.google.com"
                      className="flex-1 min-w-[180px] h-9 px-3 field rounded-xl text-sm text-foreground outline-none"
                    />
                    <VimSelect
                      label="Permission"
                      vimItem="perm:add-kind"
                      value={addSiteKind}
                      onChange={setAddSiteKind}
                      options={PERMISSION_KINDS.map((k) => ({ value: k, label: PERMISSION_LABEL[k] }))}
                      className="h-9 px-2.5 text-sm field rounded-xl"
                    />
                    <VimSelect
                      label="Decision"
                      vimItem="perm:add-decision"
                      value={addSiteDecision}
                      onChange={setAddSiteDecision}
                      options={[
                        { value: 'allow', label: 'Allow' },
                        { value: 'block', label: 'Block' },
                      ]}
                      className="h-9 px-2.5 text-sm field rounded-xl"
                    />
                    <button
                      data-vim-item="perm:add"
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
                        data-vim-item={`perm-grant:${g.partition} ${g.origin} ${g.kind}`}
                        data-vim-kind="row"
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
                          data-vim-cell="remove"
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
                <div className="flex items-center gap-3 mb-3">
                  {/* The orb's badge, live: it glitches as the pointer comes onto it. */}
                  <BrandMark variant="full" size={48} glitchOnHover />
                  <div>
                    <h2 className="text-sm font-semibold text-foreground mb-1">
                      {appPaths?.appName || 'Vimperium'}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Workspace-based browser with profiles and tab groups.
                    </p>
                    {/* Who made it (lib/credits.ts): a name opens its page in a tab. */}
                    <p className="text-xs text-muted-foreground mt-1">
                      Made by{' '}
                      {AUTHORS.map((author, i) => (
                        <React.Fragment key={author.id}>
                          {i > 0 && ' & '}
                          <AboutLink item={`about:author:${author.id}`} url={author.url} onOpen={openLink}>
                            {author.name}
                          </AboutLink>
                        </React.Fragment>
                      ))}
                    </p>
                  </div>
                </div>
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
                          data-vim-item={`about:path:${row.label}`}
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
                  Vimperium checks GitHub for new releases on launch and every few hours.
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
                            return 'Vimperium is ready to check for updates'
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
                              Vimperium will close, swap in the new version, and relaunch.
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
                      data-vim-item="about:update"
                      onClick={handleInstallUpdate}
                      className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border bg-primary text-primary-foreground border-primary hover:opacity-90"
                    >
                      <Download size={12} />
                      Install now
                    </button>
                  ) : (
                    <button
                      data-vim-item="about:update"
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

              {/* Open source — what Vimperium is built on (lib/credits.ts), a
                  row a project: a row opens its site in a tab. The cards pad
                  rather than clip, so the cursor's ring round a row shows. */}
              <section>
                <h2 className="text-sm font-semibold text-foreground mb-1">Open source</h2>
                <p className="text-xs text-muted-foreground mb-3">
                  Vimperium is built on these projects — thanks to everyone who makes them. Its keys
                  come from{' '}
                  {INSPIRATIONS.map((link, i) => (
                    <React.Fragment key={link.id}>
                      {i > 0 && (i === INSPIRATIONS.length - 1 ? ' and ' : ', ')}
                      <AboutLink item={`about:inspired:${link.id}`} url={link.url} onOpen={openLink}>
                        {link.name}
                      </AboutLink>
                    </React.Fragment>
                  ))}
                  .
                </p>
                <div className="flex flex-col gap-4">
                  {CREDIT_GROUPS.map((group) => (
                    <div key={group.id}>
                      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {group.label}
                      </div>
                      <div className="flex flex-col rounded-md border border-input bg-card p-1">
                        {group.credits.map((credit) => (
                          <button
                            key={credit.id}
                            type="button"
                            data-vim-item={`about:oss:${credit.id}`}
                            onClick={() => openLink(credit.url)}
                            title={credit.url}
                            className="flex items-center gap-3 rounded px-3 py-1.5 text-left transition-colors hover:bg-accent/50"
                          >
                            <span className="shrink-0 text-sm font-medium text-foreground">{credit.name}</span>
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{credit.role}</span>
                            <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                              {credit.license}
                            </span>
                            <ExternalLink size={11} className="shrink-0 text-muted-foreground" />
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}
          </div>
        </div>

        {vimNav && vim.mode && (
          <SettingsHintBar
            form={form}
            keymap={settingsVimKeymap}
            mode={vim.mode}
            firstLabel={hints.labels[0]}
            closeWarning={closeWarning}
            showAllKeys={showAllKeys}
            filterShown={filterShown}
          />
        )}

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
        {/* Outside the form's root: drawing them isn't the form changing. */}
        {vimNav && <VimFormLabels form={form} labels={hints.labels} mode={vim.mode} pending={vim.pending} />}
      </div>
      </VimFormContext.Provider>

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
        message={`Vimperium will use the operating system to unlock ${edgeDirectPasswordCount || 'the detected'} compatible Edge passwords and copy them into ${profileNameForPartition(passwordPartition)}. Microsoft Edge will not be changed.${edgeAppBoundPasswordCount ? ` The remaining ${edgeAppBoundPasswordCount} must be exported by Edge.` : ''}`}
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
        open={passkeyToRemove !== null}
        title="Remove this passkey?"
        message={passkeyToRemove
          ? `Vimperium will no longer sign in to ${passkeyToRemove.rpId} as ${passkeyToRemove.userName || passkeyToRemove.userDisplayName || 'this account'} with Touch ID. The site keeps it listed until you remove it in the site's security settings too.`
          : ''}
        confirmLabel="Remove passkey"
        onConfirm={handleRemovePasskey}
        onCancel={() => setPasskeyToRemove(null)}
      />

      <ConfirmDialog
        open={wipeConfirmOpen}
        title="Wipe all Vimperium data?"
        message="This will permanently delete every workspace, tab, bookmark, cookie, login session, cache, setting, and keybinding, then relaunch the app. This cannot be undone."
        confirmLabel="Wipe everything"
        onConfirm={handleWipeAllData}
        onCancel={() => setWipeConfirmOpen(false)}
      />
    </DetachedWindow>
  )
}

/** A name in About's text that opens its page: a button, so Vim's keys reach
 *  it as they do any control (its label presses it, as Enter does). */
function AboutLink({ item, url, onOpen, children }: {
  /** Its data-vim-item. */
  item: string
  url: string
  onOpen: (url: string) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      data-vim-item={item}
      onClick={() => onOpen(url)}
      title={url}
      className="font-medium text-foreground underline-offset-2 hover:underline"
    >
      {children}
    </button>
  )
}

/** Settings' hint bar in Vim mode, above the footer: the keys for where
 *  the cursor is, the filter's results, an open list — or, once asked, all
 *  of Settings' keys, or what closing would throw away. */
function SettingsHintBar({ form, keymap, mode, firstLabel, closeWarning, showAllKeys, filterShown }: {
  form: VimFormController
  keymap: VimKeymap | null
  mode: VimMode
  /** The first control's label, as an example of them. */
  firstLabel?: string
  closeWarning: boolean
  showAllKeys: boolean
  filterShown: boolean
}) {
  const { overlayOpen } = useVimFormSnapshot(form)
  const caps = (...commands: string[]): string[] => vimKeyCaps(keymap, ...commands)
  const bar = (children: React.ReactNode) => <HintBar wrap className="min-h-10">{children}</HintBar>

  if (showAllKeys) {
    return bar(
      <>
        {settingsCommandsInOrder().map((command) => (
          <Hint key={command} label={settingsCommandLabel(command)} keys={vimKeyCapsAll(keymap, command)} />
        ))}
        {firstLabel && <Hint label="Go to a setting by its label" keys={[`${firstLabel}…`]} />}
        <Hint label="Back" keys={caps('help')} />
      </>,
    )
  }
  // INSERT: Ctrl+C leaves the field; Esc steps back out from it as from
  // COMMAND — the filter's results, else closing, which asks first with
  // unsaved changes (a field taking the keys took an earlier warning down).
  if (mode === 'insert') {
    return bar(
      <>
        {filterShown && (
          <>
            <Hint label="Navigate" keys={['↓', '↑']} />
            <Hint label="Go" keys={['Enter']} />
          </>
        )}
        <Hint label="Command mode" keys={[LEAVE_INSERT_CAP]} />
        <Hint label={filterShown ? 'Clear' : 'Close'} keys={['Esc']} />
      </>,
    )
  }
  if (closeWarning) {
    return bar(
      <>
        <span className="text-foreground">There are unsaved changes.</span>
        <Hint label="Save" keys={caps('save')} />
        <Hint label="Close without saving" keys={['Esc', ...caps('discard')]} />
      </>,
    )
  }
  if (filterShown) {
    return bar(
      <>
        <Hint label="Navigate" keys={caps('cursor-down', 'cursor-up')} />
        <Hint label="Go" keys={caps('activate')} />
        <Hint label="Type" keys={caps('insert-mode')} />
        <Hint label="Clear" keys={['Esc']} />
      </>,
    )
  }
  if (overlayOpen) {
    return bar(
      <>
        <Hint label="Navigate" keys={caps('cursor-down', 'cursor-up')} />
        <Hint label="Pick" keys={caps('activate')} />
        <Hint label="Close" keys={['Esc']} />
      </>,
    )
  }
  return bar(
    <>
      <Hint label="Navigate" keys={caps('cursor-down', 'cursor-up')} />
      <Hint label="Section" keys={caps('section-next', 'section-prev')} />
      <VimFormCursorHints form={form} keymap={keymap} />
      {firstLabel && <Hint label="Go to" keys={[`${firstLabel}…`]} />}
      <Hint label="Find" keys={caps('filter')} />
      <Hint label="Save" keys={caps('save')} />
      <Hint label="Close" keys={['Esc']} />
      <Hint label="Keys" keys={caps('help')} />
    </>,
  )
}
