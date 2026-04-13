import { useState, useEffect, useRef, useCallback } from 'react'
import { X, RotateCcw, Sun, Moon, Monitor } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'

interface ProxySettings {
  mode: 'system' | 'direct' | 'custom'
  proxyRules: string
  proxyBypassRules: string
}

interface Settings {
  theme: 'light' | 'dark' | 'system'
  defaultPageUrl: string
  searchEngine: string
  proxy: ProxySettings
  keybindings: Record<string, string>
}

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
  'next-tab': 'Tab+J',
  'prev-tab': 'Tab+K',
  'toggle-sidebar': 'CmdOrCtrl+B',
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

/** Format an Electron accelerator for display (replace CmdOrCtrl with platform symbol) */
function formatAccelerator(accel: string): string {
  const isMac = navigator.platform.includes('Mac')
  if (isMac && /^Tab\+/.test(accel)) {
    return accel.replace(/^Tab\+/, '\u21E5')
  }
  return accel
    .replace(/CmdOrCtrl/g, isMac ? '\u2318' : 'Ctrl')
    .replace(/Shift/g, isMac ? '\u21E7' : 'Shift')
    .replace(/Alt/g, isMac ? '\u2325' : 'Alt')
    .replace(/\+/g, isMac ? '' : '+')
}

type Tab = 'general' | 'shortcuts'

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

export function SettingsDialog({ open, onClose, settings, onSave }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('general')
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('dark')
  const [defaultUrl, setDefaultUrl] = useState('')
  const [searchEngine, setSearchEngine] = useState(SEARCH_ENGINES.Google)
  const [proxy, setProxy] = useState<ProxySettings>({ ...DEFAULT_PROXY_SETTINGS })
  const [keybindings, setKeybindings] = useState<Record<string, string>>({ ...DEFAULT_KEYBINDINGS })
  const [recordingAction, setRecordingAction] = useState<string | null>(null)
  const [hostWindow, setHostWindow] = useState<Window | null>(null)
  const recordingRef = useRef<string | null>(null)
  const pendingTabChordRef = useRef(false)
  recordingRef.current = recordingAction

  // Init from settings
  useEffect(() => {
    if (open && settings) {
      setTheme(settings.theme)
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

    if (e.key === 'Tab') {
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
      defaultPageUrl: defaultUrl,
      searchEngine,
      proxy: normalizedProxy,
      keybindings: normalizeKnownKeybindings(keybindings),
    })
    onClose()
  }

  const handleResetKeybindings = () => {
    setKeybindings({ ...DEFAULT_KEYBINDINGS })
  }

  if (!open) return null

  return (
    <DetachedWindow
      open={open}
      title="Settings - Newbro"
      width={920}
      height={720}
      onClose={onClose}
      onWindowChange={setHostWindow}
    >
      <div className="h-full bg-popover text-popover-foreground flex flex-col overflow-hidden">
        {/* Header */}
        <div
          data-detached-drag-handle
          className="flex items-center justify-between px-6 py-4 border-b border-border"
        >
          <h2 className="text-base font-semibold text-foreground">Settings</h2>
          <button
            data-detached-no-drag
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
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
            onClick={() => setActiveTab('shortcuts')}
            className={`px-5 py-2.5 text-sm font-medium transition-colors ${
              activeTab === 'shortcuts'
                ? 'text-foreground border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Keyboard Shortcuts
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 flex-1 min-h-0 overflow-y-auto">
          {activeTab === 'general' && (
            <div className="space-y-6">
              {/* Theme */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Theme</label>
                <div className="flex gap-2">
                  {([
                    { value: 'light' as const, label: 'Light', icon: Sun },
                    { value: 'dark' as const, label: 'Dark', icon: Moon },
                    { value: 'system' as const, label: 'System', icon: Monitor },
                  ]).map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      onClick={() => setTheme(value)}
                      className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                        theme === value
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary text-secondary-foreground hover:bg-accent'
                      }`}
                    >
                      <Icon size={16} />
                      {label}
                    </button>
                  ))}
                </div>
              </div>

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

              {/* Search engine */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Default Search Engine</label>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(SEARCH_ENGINES).map(([name, url]) => (
                    <button
                      key={name}
                      onClick={() => setSearchEngine(url)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        searchEngine === url
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary text-secondary-foreground hover:bg-accent'
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                  <button
                    onClick={() => setSearchEngine('')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      !Object.values(SEARCH_ENGINES).includes(searchEngine)
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-secondary-foreground hover:bg-accent'
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
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      proxy.mode === 'system'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-secondary-foreground hover:bg-accent'
                    }`}
                  >
                    System
                  </button>
                  <button
                    onClick={() => setProxy((prev) => ({ ...prev, mode: 'direct' }))}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      proxy.mode === 'direct'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-secondary-foreground hover:bg-accent'
                    }`}
                  >
                    Direct (No Proxy)
                  </button>
                  <button
                    onClick={() => setProxy((prev) => ({ ...prev, mode: 'custom' }))}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      proxy.mode === 'custom'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-secondary-foreground hover:bg-accent'
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
                  className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium bg-secondary text-secondary-foreground hover:bg-accent"
                >
                  <RotateCcw size={12} />
                  Reset to Defaults
                </button>
              </div>

              <div className="space-y-1">
                {Object.keys(ACTION_LABELS).map((action) => {
                  const isRecording = recordingAction === action
                  const isCustom = keybindings[action] !== DEFAULT_KEYBINDINGS[action]
                  return (
                    <div
                      key={action}
                      className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-accent/50"
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
                          className={`min-w-[120px] h-8 px-3 rounded-md text-xs font-mono transition-colors ${
                            isRecording
                              ? 'bg-primary/20 text-primary border border-primary/50 animate-pulse'
                              : isCustom
                                ? 'bg-primary/10 text-primary border border-primary/30'
                                : 'bg-secondary text-secondary-foreground border border-transparent hover:border-border'
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
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="h-8 px-4 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="h-8 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:opacity-90"
          >
            Save
          </button>
        </div>
      </div>
    </DetachedWindow>
  )
}
