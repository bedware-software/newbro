import Store from 'electron-store'

export interface Settings {
  theme: 'light' | 'dark' | 'system'
  /** Selected variant within the Light family (e.g. 'light-default' | 'light-bright' | 'light-soft'). */
  lightVariant: string
  /** Selected variant within the Dark family (e.g. 'dark-default' | 'dark-deep' | 'dark-soft'). */
  darkVariant: string
  /** Layout density — 'compact' (tight, legacy) or 'normal' (extra row gaps). */
  density: 'compact' | 'normal'
  /** Where keyboard focus lands when a new tab is created —
   *  'site' focuses the page (current behavior), 'url' focuses the URL bar. */
  newTabFocus: 'site' | 'url'
  defaultPageUrl: string
  searchEngine: string
  proxy: ProxySettings
  keybindings: Record<string, string>
}

const KNOWN_LIGHT_VARIANTS = new Set(['light-default', 'light-bright', 'light-soft'])
const KNOWN_DARK_VARIANTS = new Set(['dark-default', 'dark-deep', 'dark-soft'])
const KNOWN_DENSITIES = new Set(['compact', 'normal'])
const KNOWN_NEW_TAB_FOCUS = new Set(['site', 'url'])

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
  'next-tab': 'CmdOrCtrl+Tab',
  'prev-tab': 'CmdOrCtrl+Shift+Tab',
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
  theme: 'system',
  lightVariant: 'light-default',
  darkVariant: 'dark-default',
  density: 'normal',
  newTabFocus: 'site',
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

  // Special case: "Tab+X" chord uses Tab as a leader, not a key. Accept if
  // there are exactly two tokens, the first is `tab`, and the second is not a modifier.
  if (parts.length === 2 && parts[0].toLowerCase() === 'tab') {
    return !modifiers.has(parts[1].toLowerCase())
  }

  let keyCount = 0
  for (const part of parts) {
    const token = part.toLowerCase()
    if (modifiers.has(token)) continue
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
    lightVariant: KNOWN_LIGHT_VARIANTS.has(saved?.lightVariant as string)
      ? (saved!.lightVariant as string)
      : DEFAULT_SETTINGS.lightVariant,
    darkVariant: KNOWN_DARK_VARIANTS.has(saved?.darkVariant as string)
      ? (saved!.darkVariant as string)
      : DEFAULT_SETTINGS.darkVariant,
    density: KNOWN_DENSITIES.has(saved?.density as string)
      ? (saved!.density as 'compact' | 'normal')
      : DEFAULT_SETTINGS.density,
    newTabFocus: KNOWN_NEW_TAB_FOCUS.has(saved?.newTabFocus as string)
      ? (saved!.newTabFocus as 'site' | 'url')
      : DEFAULT_SETTINGS.newTabFocus,
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
    lightVariant: KNOWN_LIGHT_VARIANTS.has(settings.lightVariant)
      ? settings.lightVariant
      : DEFAULT_SETTINGS.lightVariant,
    darkVariant: KNOWN_DARK_VARIANTS.has(settings.darkVariant)
      ? settings.darkVariant
      : DEFAULT_SETTINGS.darkVariant,
    density: KNOWN_DENSITIES.has(settings.density)
      ? settings.density
      : DEFAULT_SETTINGS.density,
    newTabFocus: KNOWN_NEW_TAB_FOCUS.has(settings.newTabFocus)
      ? settings.newTabFocus
      : DEFAULT_SETTINGS.newTabFocus,
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
