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
  /** Each action accepts up to {@link MAX_BINDINGS_PER_ACTION} accelerators.
   *  An empty array means the action has no keyboard binding. The shape is
   *  always an array — pre-dual-binding saves (single string per action)
   *  are migrated on load by {@link normalizeAndFilterKeybindings}. */
  keybindings: Record<string, string[]>
}

export const MAX_BINDINGS_PER_ACTION = 2

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

export const DEFAULT_KEYBINDINGS: Record<string, string[]> = {
  'new-tab': ['CmdOrCtrl+T'],
  'close-tab': ['CmdOrCtrl+W'],
  'close-window': ['CmdOrCtrl+Shift+W'],
  'new-workspace': ['CmdOrCtrl+Shift+N'],
  'next-tab': ['CmdOrCtrl+Tab'],
  'prev-tab': ['CmdOrCtrl+Shift+Tab'],
  'toggle-sidebar': ['CmdOrCtrl+\\'],
  'focus-url': ['CmdOrCtrl+L'],
  'search': ['CmdOrCtrl+O'],
  'command-palette': ['CmdOrCtrl+P'],
  'back': ['CmdOrCtrl+['],
  'forward': ['CmdOrCtrl+]'],
  'reload': ['CmdOrCtrl+R'],
  'settings': ['CmdOrCtrl+,'],
  // Standard Chromium shortcut for inspecting the active page. Targets the
  // tab's WebContents (the View menu's other DevTools item targets the
  // chrome renderer instead).
  'page-devtools': ['CmdOrCtrl+Shift+I'],
  // Move/Copy actions ship without a default accelerator — they're driven
  // primarily through context menus and the command palette. The keys must
  // still be present so normalizeAndFilterKeybindings preserves any user-
  // recorded binding (it iterates Object.keys(DEFAULT_KEYBINDINGS)).
  'move-tab': [],
  'copy-tab': [],
  'move-group': [],
  'copy-group': [],
}

function cloneDefaultKeybindings(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, list] of Object.entries(DEFAULT_KEYBINDINGS)) {
    out[key] = [...list]
  }
  return out
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
  keybindings: cloneDefaultKeybindings(),
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

/** Pull a list of accelerator strings from a stored value that may be either
 *  a single string (legacy single-binding shape) or an array of strings
 *  (current dual-binding shape). Unknown shapes return an empty list. */
function readBindingList(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function normalizeAndFilterKeybindings(
  raw: Record<string, unknown> | undefined,
): Record<string, string[]> {
  const next: Record<string, string[]> = {}
  const source = raw || {}
  for (const key of Object.keys(DEFAULT_KEYBINDINGS)) {
    // Pull the user's saved value first, then any legacy aliases. Each may
    // be either a single string (pre-dual-binding shape) or an array.
    const candidates = [
      ...readBindingList(source[key]),
      ...(LEGACY_KEYBINDING_KEYS[key] || []).flatMap((legacyKey) => readBindingList(source[legacyKey])),
    ]
    const list: string[] = []
    for (const candidate of candidates) {
      const normalized = normalizeKeybindingValue(candidate)
      if (!normalized) continue
      if (!isValidShortcut(normalized)) continue
      if (list.includes(normalized)) continue
      list.push(normalized)
      if (list.length >= MAX_BINDINGS_PER_ACTION) break
    }
    // If the key is present in source (even with no surviving entries),
    // preserve the user's intent — they may have explicitly cleared the
    // binding. Keys absent from source fall back to defaults via the outer
    // merge in loadSettings / saveSettings.
    const keyExplicitlyPresent =
      key in source || (LEGACY_KEYBINDING_KEYS[key] || []).some((legacy) => legacy in source)
    if (list.length > 0 || keyExplicitlyPresent) next[key] = list
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
    // Older saves used Chromium's raw mode names ('fixed_servers', 'pac_script')
    // before we normalized to 'system' | 'direct' | 'custom'. Cast through the
    // legacy union so the comparisons type-check while we migrate them in.
    const m = savedProxy.mode as string | undefined
    if (m === 'direct') return 'direct'
    if (m === 'custom' || m === 'fixed_servers' || m === 'pac_script') return 'custom'
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
    keybindings: { ...cloneDefaultKeybindings(), ...migratedKeybindings },
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
      ...cloneDefaultKeybindings(),
      ...normalizeAndFilterKeybindings(settings.keybindings as Record<string, unknown>),
    },
  }
  store.set('settings', normalizedSettings)
}
