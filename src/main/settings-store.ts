import Store from 'electron-store'
import { migrateVimKeymap as migrateVimKeymapText } from '../shared/vim-default-keymap'
import { log } from './log'
import { PERMISSION_KINDS, type PermissionKind, type PermissionPolicy } from './permissions-store'

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
  /** The mode the address editor opens in: on a click on the address bar,
   *  on a new tab (nt / nn), on Vim's e. */
  urlEditorClickMode: 'insert' | 'command'
  urlEditorNewTabMode: 'insert' | 'command'
  urlEditorEditMode: 'insert' | 'command'
  /** Vim mode: windows switch between COMMAND mode (plain keys run the
   *  commands in {@link vimKeymap} — scrolling the page, tabs, app commands)
   *  and INSERT mode (keys go to the page or the field being typed in) —
   *  renderer lib/vim-mode.ts. Vim is Vimperium's only mode: always true —
   *  load, save and Cloud Sync's apply path all make it so (a synced false
   *  from a device on an older build too). The field stays for those older
   *  builds, which read the synced settings and turn Vim off without it. */
  vimMode: true
  /** With Vim mode on: going into INSERT in a page hides the Sidebar and
   *  COMMAND brings it back (renderer App.tsx) — derived from the mode, the
   *  Sidebar's own shown/hidden toggle stays as it was. */
  hideSidebarInInsert: boolean
  /** How Vim's mode key cap shows the mode's colour (renderer
   *  lib/vim-indicator.ts): 'rim-label', 'rim', 'label', 'tint', 'base',
   *  'dot' or 'plain'. */
  vimIndicator: string
  /** How a field's edge shows Vim's mode (renderer lib/vim-edge.ts):
   *  'comet-rail', 'comet-rail-sides', 'comet', 'comet-sides', 'aurora',
   *  'living', 'glint' or 'off'. */
  vimEdge: string
  /** The edge on every field that shows the mode, not the address bar
   *  alone. */
  vimEdgeEverywhere: boolean
  /** Whether the app's own decorations move — the edge's light, the mark's
   *  glitch (renderer lib/motion.ts): 'system' goes by the OS's Reduce
   *  motion, 'always' and 'never' don't. Null is no choice made: the
   *  renderer takes the platform's default then ('always' on Windows,
   *  'system' elsewhere), and nothing is saved for it, so settings synced
   *  from a Mac don't pin its default onto Windows, nor the other way. */
  motion: 'system' | 'always' | 'never' | null
  /** COMMAND-mode keymap as the user wrote it in Settings — plain text, one
   *  `<command> <keys>` binding per line, parsed by the renderer
   *  (lib/vim-keymap.ts). Null means the built-in default, so users who never
   *  edited it pick up new default bindings. */
  vimKeymap: string | null
  /** The keymap version {@link vimKeymap}'s text was written under —
   *  {@link VIM_KEYMAP_VERSION}, or a later one from a newer build. Present
   *  only with a keymap text. Newbro never wrote it, so a text without it
   *  that Cloud Sync brings in is carried over (syncedSettingsForSave). */
  vimKeymapVersion?: number
  defaultPageUrl: string
  searchEngine: string
  /** Fetch search suggestions from the default engine while typing in the
   *  address bar, as Chrome / Edge do (see omnibox-suggest.ts). */
  searchSuggestions: boolean
  /** `!w vim` in the address bar opens Wikipedia's search for "vim" —
   *  resolved locally from the bang table (bangs-store.ts), whatever the
   *  search engine. */
  bangsEnabled: boolean
  proxy: ProxySettings
  /** DNS-over-HTTPS mode.
   *  - 'off': use the OS resolver only (system DNS, hosts file, corp VPN's
   *           internal DNS, etc.).
   *  - 'automatic' (default): try the OS resolver first, fall back to DoH
   *           for queries the OS doesn't answer. Corp intranet hosts that
   *           only exist in the VPN's internal DNS keep working.
   *  - 'secure': route every query through DoH; the OS resolver is
   *           bypassed entirely. Maximum privacy but breaks corp VPN
   *           and any setup with internal-only DNS.
   *  Chromium-level setting; takes effect at app start (configureHostResolver
   *  must run after app.ready and stays for the app's lifetime). Changes
   *  here require restart to apply. */
  dohMode: 'off' | 'automatic' | 'secure'
  /** Comma/space/newline-separated host patterns that may use Integrated
   *  Windows Authentication (NTLM/Negotiate SSO). For these hosts Chromium
   *  sends the logged-in Windows user's credentials automatically — no prompt.
   *  Maps to the `--auth-server-allowlist` switch, read once at startup, so
   *  changes require a restart. Empty = SSO disabled (every challenge prompts,
   *  unless a saved credential answers it). Wildcards allowed, e.g.
   *  `*.corp.example.com`. */
  authServerAllowlist: string
  /** Browser-form password manager. Secrets live in password-store and are
   *  never part of this settings object or Cloud Sync. */
  passwordManager: PasswordManagerSettings
  /** Each action accepts up to {@link MAX_BINDINGS_PER_ACTION} accelerators.
   *  An empty array means the action has no keyboard binding. The shape is
   *  always an array — pre-dual-binding saves (single string per action)
   *  are migrated on load by {@link normalizeAndFilterKeybindings}. */
  keybindings: Record<string, string[]>
  /** Default policy per gated permission kind, used when a site has no
   *  remembered per-site decision. 'ask' shows the in-page prompt; 'allow' /
   *  'block' apply silently. Per-site decisions live in permissions-store. */
  permissionDefaults: Record<PermissionKind, PermissionPolicy>
}

export interface PasswordManagerSettings {
  enabled: boolean
  offerToSave: boolean
  autofill: 'automatic' | 'on-focus' | 'off'
}

export const MAX_BINDINGS_PER_ACTION = 2

const KNOWN_LIGHT_VARIANTS = new Set(['light-default', 'light-bright', 'light-soft'])
const KNOWN_DARK_VARIANTS = new Set(['dark-default', 'dark-deep', 'dark-soft'])
const KNOWN_DENSITIES = new Set(['compact', 'normal'])
const KNOWN_VIM_INDICATORS = new Set(['rim-label', 'rim', 'label', 'tint', 'base', 'dot', 'plain'])
const KNOWN_VIM_EDGES = new Set(['comet-rail', 'comet-rail-sides', 'comet', 'comet-sides', 'aurora', 'living', 'glint', 'off'])
const KNOWN_MOTIONS = new Set(['system', 'always', 'never'])
function motionChoice(value: unknown): Settings['motion'] {
  return KNOWN_MOTIONS.has(value as string) ? (value as Settings['motion']) : null
}
const KNOWN_NEW_TAB_FOCUS = new Set(['site', 'url'])
const KNOWN_URL_EDITOR_MODES = new Set(['insert', 'command'])
type UrlEditorModeKey = 'urlEditorClickMode' | 'urlEditorNewTabMode' | 'urlEditorEditMode'
function urlEditorMode(value: unknown, key: UrlEditorModeKey): 'insert' | 'command' {
  return KNOWN_URL_EDITOR_MODES.has(value as string) ? (value as 'insert' | 'command') : DEFAULT_SETTINGS[key]
}
const KNOWN_DOH_MODES = new Set(['off', 'automatic', 'secure'])
const KNOWN_PASSWORD_AUTOFILL = new Set(['automatic', 'on-focus', 'off'])
const KNOWN_PERMISSION_POLICIES = new Set<PermissionPolicy>(['ask', 'allow', 'block'])
// Generous cap on the Vim keymap text; the default is ~3 KB.
const MAX_VIM_KEYMAP_LENGTH = 64 * 1024

function normalizeVimKeymap(raw: unknown): string | null {
  return typeof raw === 'string' ? raw.slice(0, MAX_VIM_KEYMAP_LENGTH) : null
}

/** The Vim keymap version this build writes: v19, the one
 *  migrateVimKeymap below moves a saved keymap to. */
export const VIM_KEYMAP_VERSION = 19

/** Settings with the keymap's version stamp set for what's stored on this
 *  device: none without a keymap text, else the current version — every
 *  text here is current, the saved one migrated at load and a synced one
 *  in syncedSettingsForSave — or a later one a newer build stamped. */
function withVimKeymapVersion(settings: Settings): Settings {
  const { vimKeymapVersion: stamped, ...rest } = settings
  if (rest.vimKeymap === null) return rest
  const later = typeof stamped === 'number' && Number.isInteger(stamped) && stamped > VIM_KEYMAP_VERSION
  return { ...rest, vimKeymapVersion: later ? stamped : VIM_KEYMAP_VERSION }
}

/** Settings keys that are no longer used — dropped on load and save so they
 *  don't linger in the store (and in Cloud Sync) forever. */
function withoutRetiredKeys<T extends object>(settings: T): T {
  const copy = { ...settings } as Record<string, unknown>
  // Superseded by vimMode: panel-only vim navigation.
  delete copy.vimNavigation
  // Hide the Sidebar (Vim mode's keys showed it, Esc twice pinned it):
  // retired with keymap v13, its Ctrl+H/J/K/L working with the Sidebar
  // hidden; hideSidebarInInsert is what's left of the idea.
  delete copy.sidebarAutoHide
  // The Sidebar's 1…9 tab-number badges (Settings → General → Tab Number
  // Badges): retired, the Sidebar shows no numbers; Cmd/Ctrl+1…9 still
  // switch to the Nth tab it shows.
  delete copy.showTabNumbers
  return copy as T
}

function buildDefaultPermissionDefaults(): Record<PermissionKind, PermissionPolicy> {
  const out = {} as Record<PermissionKind, PermissionPolicy>
  for (const kind of PERMISSION_KINDS) out[kind] = 'ask'
  return out
}

/** Coerce a stored permissionDefaults blob into a complete, valid map: every
 *  known kind present, every value one of ask/allow/block, unknown keys
 *  dropped, missing keys defaulted to 'ask'. */
function normalizePermissionDefaults(
  raw: Partial<Record<string, unknown>> | undefined,
): Record<PermissionKind, PermissionPolicy> {
  const out = buildDefaultPermissionDefaults()
  if (!raw) return out
  for (const kind of PERMISSION_KINDS) {
    const value = raw[kind]
    if (typeof value === 'string' && KNOWN_PERMISSION_POLICIES.has(value as PermissionPolicy)) {
      out[kind] = value as PermissionPolicy
    }
  }
  return out
}

export interface ProxySettings {
  mode: 'system' | 'direct' | 'custom'
  proxyRules: string
  proxyBypassRules: string
}

export { SEARCH_ENGINES } from '../shared/search-engines'

export const DEFAULT_KEYBINDINGS: Record<string, string[]> = {
  'new-tab': ['CmdOrCtrl+T'],
  'close-tab': ['CmdOrCtrl+W'],
  'reopen-closed-tab': ['CmdOrCtrl+Shift+T'],
  'close-window': ['CmdOrCtrl+Shift+W'],
  'new-workspace': ['CmdOrCtrl+Shift+N'],
  'next-tab': ['CmdOrCtrl+Tab'],
  'prev-tab': ['CmdOrCtrl+Shift+Tab'],
  'toggle-sidebar': ['CmdOrCtrl+\\'],
  'focus-url': ['CmdOrCtrl+L'],
  'search': ['CmdOrCtrl+P'],
  'command-palette': ['CmdOrCtrl+Shift+P'],
  'back': ['CmdOrCtrl+['],
  'forward': ['CmdOrCtrl+]'],
  'reload': ['CmdOrCtrl+R'],
  'settings': ['CmdOrCtrl+,'],
  // Standard Chromium shortcut for inspecting the active page. Targets the
  // tab's WebContents (the View menu's other DevTools item targets the
  // chrome renderer instead).
  'page-devtools': ['CmdOrCtrl+Shift+I'],
  // UI DevTools target the workspace chrome renderer. They ship unbound so
  // the standard Chromium page-inspector shortcut remains reserved for sites.
  'ui-devtools': [],
  'find-in-page': ['CmdOrCtrl+F'],
  // Chromium-standard Save Page As. Saving is the only way to get a
  // viewed text/plain file (example.txt) onto the local FS.
  'save-page': ['CmdOrCtrl+S'],
  // Quick-jump to the Nth visible sidebar tab (counting nested tabs in
  // expanded groups). Collapsed groups are skipped so the numbering matches
  // exactly what the user sees. Edge / Chrome / Firefox all bind these,
  // but Vimperium's sidebar is vertical so the numbering reflects sidebar
  // order rather than tab-strip order.
  'tab-1': ['CmdOrCtrl+1'],
  'tab-2': ['CmdOrCtrl+2'],
  'tab-3': ['CmdOrCtrl+3'],
  'tab-4': ['CmdOrCtrl+4'],
  'tab-5': ['CmdOrCtrl+5'],
  'tab-6': ['CmdOrCtrl+6'],
  'tab-7': ['CmdOrCtrl+7'],
  'tab-8': ['CmdOrCtrl+8'],
  'tab-9': ['CmdOrCtrl+9'],
  // Move/Duplicate actions ship without a default accelerator — they're
  // driven primarily through context menus and the command palette. The keys
  // must still be present so normalizeAndFilterKeybindings preserves any user-
  // recorded binding (it iterates Object.keys(DEFAULT_KEYBINDINGS)).
  'duplicate-tab': [],
  'move-tab': [],
  'rename-tab-group': [],
  'move-group': [],
  'duplicate-group': [],
  // Add-to-bookshelf ships unbound (driven through the command palette);
  // toggle-bookshelf gets a default so the reading queue has a one-key show/
  // hide. Existing installs are seeded with it once — see migrateNewKeybindingDefaults.
  'add-to-bookshelf': [],
  'toggle-bookshelf': ['CmdOrCtrl+Shift+B'],
  // Chrome / Edge's Downloads shortcut. Opens (or switches to) the
  // vimperium://downloads tab. New keys fall back to their default on existing
  // installs through the loadSettings merge, so no seeding migration.
  'open-downloads': ['CmdOrCtrl+J'],
  // Settings lists it (ACTION_LABELS), so a shortcut recorded for it must
  // survive the filter too.
  'open-bangs': [],
  // Dark pages (main/dark-pages.ts) — Dark Reader's keys, so hands that
  // knew the extension still find them: on/off everywhere, and this site.
  'dark-pages': ['Alt+Shift+D'],
  'dark-pages-site': ['Alt+Shift+A'],
  // The rest of the app's commands — Vim keymap v13's new ones and the
  // Command Palette's — ship unbound, listed so a shortcut the user records
  // for one survives normalizeAndFilterKeybindings.
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

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  lightVariant: 'light-default',
  darkVariant: 'dark-default',
  density: 'normal',
  newTabFocus: 'site',
  urlEditorClickMode: 'insert',
  urlEditorNewTabMode: 'insert',
  urlEditorEditMode: 'command',
  vimMode: true,
  hideSidebarInInsert: false,
  vimIndicator: 'rim-label',
  vimEdge: 'comet-rail',
  vimEdgeEverywhere: false,
  motion: null,
  vimKeymap: null,
  defaultPageUrl: '',
  searchEngine: 'https://www.google.com/search?q=%s',
  searchSuggestions: true,
  bangsEnabled: true,
  proxy: {
    mode: 'system',
    proxyRules: '',
    proxyBypassRules: '<-loopback>',
  },
  dohMode: 'automatic',
  authServerAllowlist: '',
  passwordManager: {
    enabled: true,
    offerToSave: true,
    autofill: 'automatic',
  },
  keybindings: cloneDefaultKeybindings(),
  permissionDefaults: buildDefaultPermissionDefaults(),
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
  name: 'vimperium-settings',
  defaults: {
    settings: { ...DEFAULT_SETTINGS },
  },
})

/**
 * Move users who still have the original Search / Command Palette shortcut
 * pair to the new defaults. Treat the pair as a unit so any customization to
 * either action preserves both saved bindings.
 */
function migrateChangedKeybindingDefaults(): void {
  const raw = store as unknown as { get(key: string): unknown; set(key: string, value: unknown): void }
  const marker = 'search-command-palette-v2'
  const migratedList = raw.get('migratedKeybindingDefaults')
  const migrated = new Set(Array.isArray(migratedList) ? (migratedList as string[]) : [])
  if (migrated.has(marker)) return

  const saved = store.get('settings')
  const keybindings = { ...(saved?.keybindings ?? {}) }
  const search = readBindingList(keybindings.search)
  const palette = readBindingList(keybindings['command-palette'])
  const stillUsesOldPair =
    search.length === 1 &&
    search[0] === 'CmdOrCtrl+O' &&
    palette.length === 1 &&
    palette[0] === 'CmdOrCtrl+P'

  if (stillUsesOldPair) {
    keybindings.search = [...DEFAULT_KEYBINDINGS.search]
    keybindings['command-palette'] = [...DEFAULT_KEYBINDINGS['command-palette']]
    store.set('settings', { ...(saved ?? DEFAULT_SETTINGS), keybindings })
  }

  migrated.add(marker)
  raw.set('migratedKeybindingDefaults', [...migrated])
}

/**
 * Seed accelerators for actions that shipped unbound and have since gained a
 * default. Existing installs persist an empty array for such an action, which
 * masks the new default forever (the empty array wins the cloneDefaultKeybindings
 * merge in loadSettings). Seed each one exactly once — tracked by a per-action
 * marker — and never touch a binding the user has already customised. Runs at
 * module load so the persisted value is in place before the first loadSettings.
 */
function migrateNewKeybindingDefaults(): void {
  // electron-store accepts arbitrary top-level keys at runtime; the typed
  // generic only knows about `settings`, so reach the marker through a cast.
  const raw = store as unknown as { get(key: string): unknown; set(key: string, value: unknown): void }
  const NEWLY_DEFAULTED = ['toggle-bookshelf']
  const seededList = raw.get('seededKeybindingDefaults')
  const seeded = new Set(Array.isArray(seededList) ? (seededList as string[]) : [])

  const pending = NEWLY_DEFAULTED.filter((action) => !seeded.has(action))
  if (pending.length === 0) return

  const saved = store.get('settings')
  const keybindings = { ...(saved?.keybindings ?? {}) }
  let changedSettings = false
  for (const action of pending) {
    const def = DEFAULT_KEYBINDINGS[action] || []
    const current = keybindings[action]
    if (def.length > 0 && (!Array.isArray(current) || current.length === 0)) {
      keybindings[action] = [...def]
      changedSettings = true
    }
    seeded.add(action)
  }
  if (changedSettings) store.set('settings', { ...(saved ?? DEFAULT_SETTINGS), keybindings })
  raw.set('seededKeybindingDefaults', [...seeded])
}

/**
 * Vim mode's keymap v14 (v3: BROWSE folded into COMMAND, the Sidebar's cursor
 * on Ctrl chords; v4: the tab numbers on Ctrl; v5: the address bar on e;
 * v6: the address editor on e, Search Everything's filters on w/t/p, new tab
 * on Enter; v7: V/S split like vim's, row-unfold on <C-l>, gcc comments;
 * v8: the address editor's u / <C-r> / gu / gt / yt / d / D; v9: results
 * picked by two-letter labels, not digits; v10: the Sidebar on the arrows,
 * not Ctrl held, <C-o>/<C-i>/<C-p>/<Space>; v11: od Downloads, ob Bangs;
 * v12: D Dark pages on this site; v13: vim's grammar — <C-d>/<C-u>, the
 * Sidebar on <C-h/j/k/l> and <Tab>, n new, d delete, o open, t toggle, u
 * reopens; v14: nw a new workspace (was nv), nn a new tab beside nt; v15:
 * dw deletes the workspace (was dv), the Sidebar's rows labelled (no
 * <C-1>…<C-9>) and m their menu (was <C-m>) — see
 * src/shared/vim-default-keymap.ts): a keymap saved under v1 to v18 keeps what its owner changed and takes the new defaults for
 * everything else.
 * Once.
 */
function migrateVimKeymap(): void {
  const raw = store as unknown as { get(key: string): unknown; set(key: string, value: unknown): void }
  const marker = 'vim-keymap-v19'
  const migratedList = raw.get('migratedKeybindingDefaults')
  const migrated = new Set(Array.isArray(migratedList) ? (migratedList as string[]) : [])
  if (migrated.has(marker)) return

  const saved = store.get('settings')
  // A keymap stamped current or later (Cloud Sync brought it from a newer
  // device) is on the current keys already: carrying it over again would
  // undo what its owner chose there.
  const stamp = saved?.vimKeymapVersion
  const alreadyCurrent = typeof stamp === 'number' && Number.isInteger(stamp) && stamp >= VIM_KEYMAP_VERSION
  if (saved && typeof saved.vimKeymap === 'string' && !alreadyCurrent) {
    // The text's own stamp, when a newer build wrote it (Cloud Sync brought
    // it before this device had that build), says better than the markers.
    const byMarker = migrated.has('vim-keymap-v18') ? 18 : migrated.has('vim-keymap-v17') ? 17 : migrated.has('vim-keymap-v16') ? 16 : migrated.has('vim-keymap-v15') ? 15 : migrated.has('vim-keymap-v14') ? 14 : migrated.has('vim-keymap-v13') ? 13 : migrated.has('vim-keymap-v12') ? 12 : migrated.has('vim-keymap-v11') ? 11 : migrated.has('vim-keymap-v10') ? 10 : migrated.has('vim-keymap-v9') ? 9 : migrated.has('vim-keymap-v8') ? 8 : migrated.has('vim-keymap-v7') ? 7 : migrated.has('vim-keymap-v6') ? 6 : migrated.has('vim-keymap-v5') ? 5 : migrated.has('vim-keymap-v4') ? 4 : migrated.has('vim-keymap-v3') ? 3 : migrated.has('vim-keymap-v2') ? 2 : 1
    const from = (typeof stamp === 'number' && Number.isInteger(stamp) && stamp > byMarker
      ? Math.min(stamp, VIM_KEYMAP_VERSION - 1)
      : byMarker) as Parameters<typeof migrateVimKeymapText>[1]
    store.set('settings', { ...saved, vimKeymap: migrateVimKeymapText(saved.vimKeymap, from, (note) => log.info(`vim keymap v${from} → v${VIM_KEYMAP_VERSION}: ${note}`)) })
  }

  migrated.add('vim-keymap-v2')
  migrated.add('vim-keymap-v3')
  migrated.add('vim-keymap-v4')
  migrated.add('vim-keymap-v5')
  migrated.add('vim-keymap-v6')
  migrated.add('vim-keymap-v7')
  migrated.add('vim-keymap-v8')
  migrated.add('vim-keymap-v9')
  migrated.add('vim-keymap-v10')
  migrated.add('vim-keymap-v11')
  migrated.add('vim-keymap-v12')
  migrated.add('vim-keymap-v13')
  migrated.add('vim-keymap-v14')
  migrated.add('vim-keymap-v15')
  migrated.add('vim-keymap-v16')
  migrated.add('vim-keymap-v17')
  migrated.add('vim-keymap-v18')
  migrated.add(marker)
  raw.set('migratedKeybindingDefaults', [...migrated])
}

migrateChangedKeybindingDefaults()
migrateNewKeybindingDefaults()
migrateVimKeymap()

type VimKeymapVersion = Parameters<typeof migrateVimKeymapText>[1] | typeof VIM_KEYMAP_VERSION

/** Commands each keymap version brought in, newest first: what a keymap
 *  text with no version stamp shows of the defaults it was written under.
 *  Versions that added no command read as the newest that looks the same:
 *  v8 to v10 as v10, v3 to v5 as v5, v14 to v19 as v13. */
const VIM_KEYMAP_VERSION_MARKS: ReadonlyArray<readonly [VimKeymapVersion, readonly string[]]> = [
  [13, [
    'new-group', 'new-profile', 'close-group', 'app-menu', 'extensions-menu', 'site-info',
    'dark-pages-menu', 'profile-menu', 'workspace-menu', 'chrome-hints', 'zoom-in', 'zoom-out', 'zoom-reset',
  ]],
  [12, ['dark-pages', 'dark-pages-site']],
  [11, ['open-bangs']],
  [10, ['url-redo', 'url-remove-all']],
  [7, ['row-unfold', 'set-comment', 'remove-comment']],
  [6, ['pick-workspace', 'pick-tab', 'pick-group', 'pick-profile']],
  [5, ['scroll-down', 'scroll-up', 'half-page-down', 'half-page-up', 'page-top', 'page-bottom', 'focus-input', 'row-fold']],
  [2, ['browse-mode', 'cursor-down-show', 'cursor-up-show', 'row-show', 'copy-url', 'paste-url', 'split-right', 'edit-url']],
]

function vimKeymapVersionOf(text: string): VimKeymapVersion {
  const commands = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('"') || trimmed.startsWith('#')) continue
    commands.add(trimmed.split(/\s+/)[0])
  }
  for (const [version, marks] of VIM_KEYMAP_VERSION_MARKS) {
    if (marks.some((command) => commands.has(command))) return version
  }
  return 1
}

/**
 * Settings Cloud Sync brought from another device, ready for saveSettings:
 * a Vim keymap written under older defaults — by a device still on Newbro,
 * which stamps no version — carried over to the current ones, as
 * migrateVimKeymap does for the saved one at load. A keymap stamped current
 * or later is taken as it is: carrying a current keymap over again would
 * undo what its owner changed. One with an older stamp or none reads as the
 * newest version whose commands it names — v13 at most: v14 to v19 brought
 * in no command, and their steps leave a text already on their keys as it is. Says
 * which version it carried the keymap over from, or null.
 */
export function syncedSettingsForSave(incoming: Settings): { settings: Settings; vimKeymapFrom: number | null; vimTurnedOn: boolean } {
  // Vim is the only mode, whatever the other device had (an older build may
  // have it off) — and what this returns is what the windows are sent.
  // vimTurnedOn: it was off there, so what's saved here isn't what came in,
  // and this device's copy is to be published (SyncAdapter.write returning
  // true) for that device to take Vim on as well.
  const vimTurnedOn = !!incoming && typeof incoming === 'object' && incoming.vimMode !== true
  if (vimTurnedOn) incoming = { ...incoming, vimMode: true }
  const unchanged = { settings: incoming, vimKeymapFrom: null, vimTurnedOn }
  if (!incoming || typeof incoming !== 'object' || typeof incoming.vimKeymap !== 'string') return unchanged
  const stamped = incoming.vimKeymapVersion
  if (typeof stamped === 'number' && stamped >= VIM_KEYMAP_VERSION) return unchanged
  // Stamps began with v13, so one from v13 on is the text's real version (a v13
  // text whose owner deleted every v13-only line would otherwise read as v12).
  // No stamp, or a lower one, is worked out from the text.
  const from: VimKeymapVersion =
    typeof stamped === 'number' && Number.isInteger(stamped) && stamped >= 13
      ? (stamped as VimKeymapVersion)
      : vimKeymapVersionOf(incoming.vimKeymap)
  if (from === VIM_KEYMAP_VERSION) return unchanged
  return {
    settings: {
      ...incoming,
      vimKeymap: migrateVimKeymapText(incoming.vimKeymap, from, (note) => log.info(`synced vim keymap v${from} → v${VIM_KEYMAP_VERSION}: ${note}`)),
      vimKeymapVersion: VIM_KEYMAP_VERSION,
    },
    vimKeymapFrom: from,
    vimTurnedOn,
  }
}

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
  return withVimKeymapVersion({
    ...DEFAULT_SETTINGS,
    ...withoutRetiredKeys(saved ?? DEFAULT_SETTINGS),
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
    urlEditorClickMode: urlEditorMode(saved?.urlEditorClickMode, 'urlEditorClickMode'),
    urlEditorNewTabMode: urlEditorMode(saved?.urlEditorNewTabMode, 'urlEditorNewTabMode'),
    urlEditorEditMode: urlEditorMode(saved?.urlEditorEditMode, 'urlEditorEditMode'),
    // Vim is the only mode, whatever an older build saved.
    vimMode: true,
    hideSidebarInInsert: saved?.hideSidebarInInsert === true,
    vimIndicator: KNOWN_VIM_INDICATORS.has(saved?.vimIndicator as string)
      ? (saved!.vimIndicator as string)
      : DEFAULT_SETTINGS.vimIndicator,
    vimEdge: KNOWN_VIM_EDGES.has(saved?.vimEdge as string)
      ? (saved!.vimEdge as string)
      : DEFAULT_SETTINGS.vimEdge,
    vimEdgeEverywhere: saved?.vimEdgeEverywhere === true,
    motion: motionChoice(saved?.motion),
    vimKeymap: normalizeVimKeymap(saved?.vimKeymap),
    searchSuggestions: saved?.searchSuggestions !== false,
    bangsEnabled: saved?.bangsEnabled !== false,
    dohMode: KNOWN_DOH_MODES.has(saved?.dohMode as string)
      ? (saved!.dohMode as 'off' | 'automatic' | 'secure')
      : DEFAULT_SETTINGS.dohMode,
    authServerAllowlist: typeof saved?.authServerAllowlist === 'string'
      ? saved.authServerAllowlist
      : DEFAULT_SETTINGS.authServerAllowlist,
    passwordManager: {
      enabled: saved?.passwordManager?.enabled !== false,
      offerToSave: saved?.passwordManager?.offerToSave !== false,
      autofill: KNOWN_PASSWORD_AUTOFILL.has(saved?.passwordManager?.autofill as string)
        ? saved!.passwordManager.autofill
        : DEFAULT_SETTINGS.passwordManager.autofill,
    },
    proxy: {
      ...DEFAULT_SETTINGS.proxy,
      ...savedProxy,
      mode,
    },
    keybindings: { ...cloneDefaultKeybindings(), ...migratedKeybindings },
    permissionDefaults: normalizePermissionDefaults(
      saved?.permissionDefaults as Record<string, unknown> | undefined,
    ),
  })
}

export function saveSettings(settings: Settings): void {
  const normalizedSettings: Settings = {
    ...DEFAULT_SETTINGS,
    ...withoutRetiredKeys(settings),
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
    urlEditorClickMode: urlEditorMode(settings.urlEditorClickMode, 'urlEditorClickMode'),
    urlEditorNewTabMode: urlEditorMode(settings.urlEditorNewTabMode, 'urlEditorNewTabMode'),
    urlEditorEditMode: urlEditorMode(settings.urlEditorEditMode, 'urlEditorEditMode'),
    // Written true, too: a device still on an older build reads it from
    // Cloud Sync, and turns Vim off without it.
    vimMode: true,
    hideSidebarInInsert: settings.hideSidebarInInsert === true,
    vimIndicator: KNOWN_VIM_INDICATORS.has(settings.vimIndicator)
      ? settings.vimIndicator
      : DEFAULT_SETTINGS.vimIndicator,
    vimEdge: KNOWN_VIM_EDGES.has(settings.vimEdge)
      ? settings.vimEdge
      : DEFAULT_SETTINGS.vimEdge,
    vimEdgeEverywhere: settings.vimEdgeEverywhere === true,
    motion: motionChoice(settings.motion),
    vimKeymap: normalizeVimKeymap(settings.vimKeymap),
    searchSuggestions: settings.searchSuggestions !== false,
    bangsEnabled: settings.bangsEnabled !== false,
    dohMode: KNOWN_DOH_MODES.has(settings.dohMode as string)
      ? settings.dohMode
      : DEFAULT_SETTINGS.dohMode,
    authServerAllowlist: typeof settings.authServerAllowlist === 'string'
      ? settings.authServerAllowlist.trim()
      : DEFAULT_SETTINGS.authServerAllowlist,
    passwordManager: {
      enabled: settings.passwordManager?.enabled !== false,
      offerToSave: settings.passwordManager?.offerToSave !== false,
      autofill: KNOWN_PASSWORD_AUTOFILL.has(settings.passwordManager?.autofill as string)
        ? settings.passwordManager.autofill
        : DEFAULT_SETTINGS.passwordManager.autofill,
    },
    proxy: {
      ...DEFAULT_SETTINGS.proxy,
      ...settings.proxy,
    },
    keybindings: {
      ...cloneDefaultKeybindings(),
      ...normalizeAndFilterKeybindings(settings.keybindings as Record<string, unknown>),
    },
    permissionDefaults: normalizePermissionDefaults(
      settings.permissionDefaults as Record<string, unknown> | undefined,
    ),
  }
  store.set('settings', withVimKeymapVersion(normalizedSettings))
}
