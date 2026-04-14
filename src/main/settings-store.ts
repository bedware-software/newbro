import Store from 'electron-store'

export interface Settings {
  theme: 'light' | 'dark' | 'system'
  defaultPageUrl: string
  searchEngine: string
  proxy: ProxySettings
  keybindings: Record<string, string>
}

export interface ProxySettings {
  mode: 'system' | 'direct' | 'custom'
  proxyRules: string
  proxyBypassRules: string
}

export const SEARCH_ENGINES: Record<string, string> = {
  'Google': 'https://www.google.com/search?q=%s',
  'Yandex': 'https://yandex.ru/search/?text=%s',
  'DuckDuckGo': 'https://duckduckgo.com/?q=%s',
  'Unduck': 'https://unduck.link?q=%s',
}

export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  'new-tab': 'CmdOrCtrl+T',
  'close-tab': 'CmdOrCtrl+W',
  'close-window': 'CmdOrCtrl+Shift+W',
  'new-workspace': 'CmdOrCtrl+Shift+N',
  'next-tab': 'Alt+J',
  'prev-tab': 'Alt+K',
  'toggle-sidebar': 'CmdOrCtrl+\\',
  'focus-url': 'CmdOrCtrl+L',
  'search': 'CmdOrCtrl+O',
  'command-palette': 'CmdOrCtrl+P',
  'back': 'CmdOrCtrl+[',
  'forward': 'CmdOrCtrl+]',
  'reload': 'CmdOrCtrl+R',
  'settings': 'CmdOrCtrl+,',
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  defaultPageUrl: '',
  searchEngine: 'https://www.google.com/search?q=%s',
  proxy: {
    mode: 'system',
    proxyRules: '',
    proxyBypassRules: '<-loopback>',
  },
  keybindings: { ...DEFAULT_KEYBINDINGS },
}

const LEGACY_KEYBINDING_KEYS: Record<string, string[]> = {
  'next-tab': ['next-workspace'],
  'prev-tab': ['prev-workspace'],
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

function isValidShortcut(binding: string): boolean {
  const parts = binding.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return false
  const modifiers = new Set(['cmdorctrl', 'ctrl', 'control', 'cmd', 'command', 'shift', 'alt', 'option'])
  let keyCount = 0
  for (const part of parts) {
    const token = part.toLowerCase()
    if (modifiers.has(token)) continue
    if (token === 'tab') continue
    keyCount += 1
  }
  return keyCount === 1
}

function normalizeAndFilterKeybindings(
  raw: Record<string, unknown> | undefined,
): Record<string, string> {
  const next: Record<string, string> = {}
  const source = raw || {}
  for (const key of Object.keys(DEFAULT_KEYBINDINGS)) {
    const directValue = typeof source[key] === 'string' ? source[key] : ''
    const aliasValue = (LEGACY_KEYBINDING_KEYS[key] || [])
      .map((legacyKey) => source[legacyKey])
      .find((v) => typeof v === 'string')
    const rawValue = directValue || (typeof aliasValue === 'string' ? aliasValue : '')
    if (!rawValue) continue
    const normalized = normalizeKeybindingValue(rawValue)
    if (normalized && isValidShortcut(normalized)) {
      next[key] = normalized
    }
  }
  return next
}

const store = new Store<{ settings: Settings }>({
  name: 'newbro-settings',
  defaults: {
    settings: { ...DEFAULT_SETTINGS },
  },
})

export function loadSettings(): Settings {
  const saved = store.get('settings')
  const savedProxy = saved?.proxy || {}
  const savedKeybindings = saved?.keybindings || {}
  const migratedKeybindings = normalizeAndFilterKeybindings(savedKeybindings)
  const mode = (() => {
    if (savedProxy.mode === 'direct') return 'direct'
    if (savedProxy.mode === 'custom' || savedProxy.mode === 'fixed_servers' || savedProxy.mode === 'pac_script') return 'custom'
    return 'system'
  })()
  // Merge with defaults so new keys are always present
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    proxy: {
      ...DEFAULT_SETTINGS.proxy,
      ...savedProxy,
      mode,
    },
    keybindings: { ...DEFAULT_KEYBINDINGS, ...migratedKeybindings },
  }
}

export function saveSettings(settings: Settings): void {
  const normalizedSettings: Settings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    proxy: {
      ...DEFAULT_SETTINGS.proxy,
      ...settings.proxy,
    },
    keybindings: {
      ...DEFAULT_KEYBINDINGS,
      ...normalizeAndFilterKeybindings(settings.keybindings as Record<string, unknown>),
    },
  }
  store.set('settings', normalizedSettings)
}
