import React, { useState, useEffect, useRef, useCallback } from 'react'
import { X, RotateCcw, Sun, Moon, Monitor, AlertTriangle, Trash2, Download, CheckCircle2, Loader2, Puzzle, ExternalLink, Plus, Globe, Pin, PinOff } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import { ConfirmDialog } from './ConfirmDialog'
import { LIGHT_VARIANTS, DARK_VARIANTS, DENSITIES, normalizeLightVariant, normalizeDarkVariant, normalizeDensity, DEFAULT_DENSITY, type ThemeChoice, type Density } from '../lib/theme'
import { useAppStore } from '../store/app-store'

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
  defaultPageUrl: string
  searchEngine: string
  proxy: ProxySettings
  keybindings: Record<string, string>
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

const DEFAULT_KEYBINDINGS: Record<string, string> = {
  'new-tab': 'CmdOrCtrl+T',
  'close-tab': 'CmdOrCtrl+W',
  'close-window': 'CmdOrCtrl+Shift+W',
  'new-workspace': 'CmdOrCtrl+Shift+N',
  'next-tab': 'CmdOrCtrl+Tab',
  'prev-tab': 'CmdOrCtrl+Shift+Tab',
  'toggle-sidebar': 'CmdOrCtrl+\\',
  'focus-url': 'CmdOrCtrl+L',
  search: 'CmdOrCtrl+O',
  'command-palette': 'CmdOrCtrl+P',
  back: 'CmdOrCtrl+[',
  forward: 'CmdOrCtrl+]',
  reload: 'CmdOrCtrl+R',
  settings: 'CmdOrCtrl+,',
}

const ACTION_LABELS: Record<string, string> = {
  'new-tab': 'New Tab',
  'close-tab': 'Close Tab',
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
}

interface Props {
  open: boolean
  onClose: () => void
  settings: Settings | null
  onSave: (settings: Settings) => void
  onAppearancePreview?: (preview: AppearancePreview) => void
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

type Tab = 'general' | 'appearance' | 'shortcuts' | 'extensions' | 'about'

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

function normalizeKnownKeybindings(raw: Record<string, string> | undefined): Record<string, string> {
  const next: Record<string, string> = { ...DEFAULT_KEYBINDINGS }
  if (!raw) return next
  for (const key of Object.keys(DEFAULT_KEYBINDINGS)) {
    const value = raw[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const normalized = normalizeKeybindingValue(value)
    if (normalized) next[key] = normalized
  }
  return next
}

export function SettingsDialog({ open, onClose, settings, onSave, onAppearancePreview }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('general')
  const [theme, setTheme] = useState<ThemeChoice>('dark')
  const [lightVariant, setLightVariant] = useState<string>(LIGHT_VARIANTS[0].id)
  const [darkVariant, setDarkVariant] = useState<string>(DARK_VARIANTS[0].id)
  const [density, setDensity] = useState<Density>(DEFAULT_DENSITY)
  const [newTabFocus, setNewTabFocus] = useState<'site' | 'url'>('site')
  const [defaultUrl, setDefaultUrl] = useState('')
  const [searchEngine, setSearchEngine] = useState(SEARCH_ENGINES.Google)
  const [proxy, setProxy] = useState<ProxySettings>({ ...DEFAULT_PROXY_SETTINGS })
  const [keybindings, setKeybindings] = useState<Record<string, string>>({ ...DEFAULT_KEYBINDINGS })
  const [recordingAction, setRecordingAction] = useState<string | null>(null)
  const [hostWindow, setHostWindow] = useState<Window | null>(null)
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false)
  const [appVersion, setAppVersion] = useState<string>('')
  const [appPaths, setAppPaths] = useState<{ userData: string; cache: string; logs: string; appName: string } | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ phase: 'idle' })
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([])
  const [extInput, setExtInput] = useState('')
  const [extInstalling, setExtInstalling] = useState(false)
  const [extError, setExtError] = useState<string | null>(null)
  const recordingRef = useRef<string | null>(null)
  const pendingTabChordRef = useRef(false)
  const originalAppearanceRef = useRef<AppearancePreview>({
    theme: 'dark',
    lightVariant: LIGHT_VARIANTS[0].id,
    darkVariant: DARK_VARIANTS[0].id,
    density: DEFAULT_DENSITY,
  })
  recordingRef.current = recordingAction

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
      originalAppearanceRef.current = { theme: settings.theme, lightVariant: lv, darkVariant: dv, density: dens }
      setDefaultUrl(settings.defaultPageUrl)
      setSearchEngine(settings.searchEngine || SEARCH_ENGINES.Google)
      setProxy({ ...DEFAULT_PROXY_SETTINGS, ...settings.proxy })
      setKeybindings(normalizeKnownKeybindings(settings.keybindings))
    }
  }, [open, settings])

  // Record keybinding
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!recordingRef.current) return
    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape') {
      pendingTabChordRef.current = false
      setRecordingAction(null)
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
        setKeybindings((prev) => ({ ...prev, [recordingRef.current!]: `Tab+${key}` }))
        setRecordingAction(null)
      }
      return
    }

    const accel = eventToAccelerator(e)
    if (accel) {
      setKeybindings((prev) => ({ ...prev, [recordingRef.current!]: accel }))
      setRecordingAction(null)
    }
  }, [])

  useEffect(() => {
    if (!recordingAction) pendingTabChordRef.current = false
  }, [recordingAction])

  useEffect(() => {
    if (!recordingAction || !hostWindow) return
    hostWindow.addEventListener('keydown', handleKeyDown, true)
    return () => hostWindow.removeEventListener('keydown', handleKeyDown, true)
  }, [recordingAction, handleKeyDown, hostWindow])

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
      defaultPageUrl: defaultUrl,
      searchEngine,
      proxy: normalizedProxy,
      keybindings: normalizeKnownKeybindings(keybindings),
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
    setKeybindings({ ...DEFAULT_KEYBINDINGS })
  }

  const handleWipeAllData = () => {
    setWipeConfirmOpen(false)
    // Fire-and-forget — the main process will relaunch the app immediately.
    window.electronAPI.wipeAllData()
  }

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

        {/* Tab bar */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setActiveTab('general')}
            className={`px-5 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'general'
                ? 'text-foreground border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            General
          </button>
          <button
            onClick={() => setActiveTab('appearance')}
            className={`px-5 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'appearance'
                ? 'text-foreground border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Appearance
          </button>
          <button
            onClick={() => setActiveTab('shortcuts')}
            className={`px-5 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'shortcuts'
                ? 'text-foreground border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Keyboard Shortcuts
          </button>
          <button
            onClick={() => setActiveTab('extensions')}
            className={`px-5 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'extensions'
                ? 'text-foreground border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Extensions
          </button>
          <button
            onClick={() => setActiveTab('about')}
            className={`px-5 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'about'
                ? 'text-foreground border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            About
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 flex-1 min-h-0 overflow-y-auto">
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
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-muted-foreground">
                  Click on a shortcut to reassign it. Press Escape to cancel.
                </p>
                <button
                  onClick={handleResetKeybindings}
                  className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium bg-secondary text-secondary-foreground hover:bg-muted"
                >
                  <RotateCcw size={12} />
                  Reset to Defaults
                </button>
              </div>

              <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
                {Object.keys(ACTION_LABELS).map((action) => {
                  const isRecording = recordingAction === action
                  const isCustom = keybindings[action] !== DEFAULT_KEYBINDINGS[action]
                  return (
                    <div
                      key={action}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <span className="text-sm text-foreground">{ACTION_LABELS[action]}</span>
                      <div className="flex items-center gap-2">
                        {isCustom && (
                          <button
                            onClick={() => setKeybindings((prev) => ({ ...prev, [action]: DEFAULT_KEYBINDINGS[action] }))}
                            className="h-5 w-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground"
                            title="Reset to default"
                          >
                            <RotateCcw size={10} />
                          </button>
                        )}
                        <button
                          onClick={() => setRecordingAction(isRecording ? null : action)}
                          className={`min-w-[120px] h-8 px-3 rounded-md text-xs flex items-center justify-center transition-colors ${
                            isRecording
                              ? 'bg-background border border-ring text-primary'
                              : 'bg-card border border-input text-foreground'
                          }`}
                        >
                          {isRecording
                            ? 'Press keys...'
                            : formatAccelerator(keybindings[action] || DEFAULT_KEYBINDINGS[action])}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {activeTab === 'about' && (
            <div className="space-y-6">
              {/* App identity */}
              <div className="flex flex-col items-center text-center py-2">
                <h2 className="text-xl font-semibold text-foreground">
                  {appPaths?.appName || 'Newbro'}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {appVersion ? `Version ${appVersion}` : 'Version unknown'}
                </p>
              </div>

              {/* Storage paths — useful for confirming dev vs stable
                  installs end up in different folders. The user-data
                  directory is where settings, the extensions store,
                  cookies, and per-profile partitions live. */}
              {appPaths && (
                <div>
                  <label className="block text-sm font-medium text-foreground mb-2">Storage</label>
                  <div className="space-y-2">
                    {[
                      { label: 'User data', value: appPaths.userData },
                      { label: 'Cache', value: appPaths.cache },
                      { label: 'Logs', value: appPaths.logs },
                    ].map((row) => (
                      <div key={row.label} className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground w-20 shrink-0">{row.label}</span>
                        <code
                          className="flex-1 text-[11px] font-mono px-2 py-1.5 rounded bg-secondary text-foreground truncate select-all"
                          title={row.value}
                        >
                          {row.value}
                        </code>
                        <button
                          onClick={() => { navigator.clipboard.writeText(row.value).catch(() => {}) }}
                          className="h-7 px-2 rounded-md text-[11px] bg-secondary text-secondary-foreground hover:bg-muted shrink-0"
                          title="Copy to clipboard"
                        >
                          Copy
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Updates */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Updates</label>
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={handleCheckForUpdates}
                    disabled={
                      updateStatus.phase === 'checking' ||
                      updateStatus.phase === 'downloading' ||
                      updateStatus.phase === 'unsupported'
                    }
                    title={updateStatus.phase === 'unsupported' ? 'Updates are only available in installed builds.' : undefined}
                    className={`flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium transition-colors ${
                      updateStatus.phase === 'checking' || updateStatus.phase === 'downloading'
                        ? 'bg-secondary text-muted-foreground cursor-default'
                        : updateStatus.phase === 'unsupported'
                          ? 'bg-secondary text-muted-foreground cursor-not-allowed opacity-60'
                          : 'bg-secondary text-secondary-foreground hover:bg-muted'
                    }`}
                  >
                    {updateStatus.phase === 'checking' ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Download size={12} />
                    )}
                    Check for updates
                  </button>
                  {updateStatus.phase === 'downloaded' && (
                    <button
                      onClick={handleInstallUpdate}
                      className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground hover:bg-primary/80 text-xs font-medium"
                    >
                      <RotateCcw size={12} />
                      Restart to install
                    </button>
                  )}
                </div>
                <div className="mt-2 text-[11px]">
                  {updateStatus.phase === 'idle' && (
                    <span className="text-muted-foreground">The app checks for updates automatically on startup.</span>
                  )}
                  {updateStatus.phase === 'checking' && (
                    <span className="text-muted-foreground">Checking for updates…</span>
                  )}
                  {updateStatus.phase === 'not-available' && (
                    <span className="text-muted-foreground flex items-center gap-1">
                      <CheckCircle2 size={11} className="text-primary" />
                      You're on the latest version.
                    </span>
                  )}
                  {updateStatus.phase === 'available' && (
                    <span className="text-foreground">Update v{updateStatus.version} available — downloading…</span>
                  )}
                  {updateStatus.phase === 'downloading' && (
                    <span className="text-foreground">
                      Downloading v{updateStatus.version} · {updateStatus.percent}%
                    </span>
                  )}
                  {updateStatus.phase === 'downloaded' && (
                    <span className="text-foreground">Update v{updateStatus.version} ready — restart to install.</span>
                  )}
                  {updateStatus.phase === 'error' && (
                    <span className="text-destructive flex items-center gap-1">
                      <AlertTriangle size={11} />
                      Check failed: {updateStatus.message}
                    </span>
                  )}
                  {updateStatus.phase === 'unsupported' && (
                    <span className="text-muted-foreground">
                      Updates are unavailable in development builds. Install a packaged release to receive updates.
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
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
