// Vim mode's keymap: the plain-text config edited in Settings → Keyboard
// Shortcuts, its parser, and the descriptions its help (?) shows.
//
// One binding per line: `<command> <keys> [<keys>…]`. A command with no keys
// is listed but unbound. `"` (vim) or `#` starts a comment line. Keys are
// typed characters — Shift is the capital, so `J` is Shift+J — sequences
// like `gg`, and named keys in angle brackets (`<CR>`, `<Esc>`, `<Tab>`).
// The command's prefix says where it works: `web-` in WEB mode (the page),
// `search-` in Search Everything, anything else in COMMAND mode.

import { ACTION_LABELS } from './action-labels'
import { SEQUENCE_JOIN, type VimKeymap } from '../../../shared/vim-keys'

export { keyTokenFromEvent, matchKeys, type VimKeymap, type VimKeymapEntries } from '../../../shared/vim-keys'

export const DEFAULT_VIM_KEYMAP = `" Vim mode keys.
" One binding per line: <command> <keys> [<more keys>…]. A command with no
" keys is unbound. Lines starting with " are comments.
"
" Keys: a typed character (Shift is the capital: J is Shift+J), a sequence
" (gg), or a named key: <CR> <Esc> <Space> <Tab> <S-Tab> <BS> <Del>
" <Up> <Down> <Left> <Right> <Home> <End> <PageUp> <PageDown> <F1>…<F12>.
" Keys go by position on the keyboard, so they work in any input language.
"
" Modes, top to bottom:
"   COMMAND  the browser: tabs, panels, app commands
"   WEB      the page, as Vimium drives it: scroll, history, find a field
"   INSERT   keys go to the page or the field you type in
" <CR> on a tab goes COMMAND → WEB, i goes on to INSERT. Esc climbs back:
" INSERT → WEB, then (when the page has no use for it) WEB → COMMAND.
" Ctrl+[ jumps to COMMAND from anywhere. Clicking the page is WEB (a text
" field: INSERT), clicking the browser around it is COMMAND.
" The regular shortcuts (⌘T, ⌘L, …) are off while Vim mode is on.

" ── COMMAND: modes and panels ─────────────────────────────────────────
insert-mode         i
focus-sidebar       s
focus-bookshelf     b
help                ?

" ── COMMAND: cursor in the focused panel (Sidebar or Bookshelf) ───────
" The cursor only moves; row-open makes the tab under it active and goes
" into its page (WEB), or shows the group under it.
cursor-down         j <Down>
cursor-up           k <Up>
cursor-first        gg
cursor-last         G
row-move-down       J
row-move-up         K
row-collapse        h
row-expand          l
row-menu            m
row-close           x
row-open            <CR>

" ── COMMAND: app commands (the regular shortcuts' ids) ────────────────
new-tab             t
close-tab           w
reopen-closed-tab   T
close-window
new-workspace       N
next-tab            gt
prev-tab            gT
toggle-sidebar      \\
focus-url           o
search              p
command-palette     P :
back                [
forward             ]
reload              r
settings            ,
page-devtools       I
ui-devtools
find-in-page        f /
save-page
tab-1               1
tab-2               2
tab-3               3
tab-4               4
tab-5               5
tab-6               6
tab-7               7
tab-8               8
tab-9               9
duplicate-tab
move-tab
rename-tab-group
move-group
duplicate-group
add-to-bookshelf
toggle-bookshelf    B
open-downloads      d

" ── WEB: the page ─────────────────────────────────────────────────────
" Keys not listed here go to the page. web-focus-input outlines the page's
" text fields: h/j/k/l (or Tab) pick one, <CR> types into it, Esc cancels.
web-scroll-down     j
web-scroll-up       k
web-half-page-down  d
web-half-page-up    u
web-top             gg
web-bottom          G
web-back            h
web-forward         l
web-insert          i
web-focus-input     gi
web-help            ?

" ── Search Everything ─────────────────────────────────────────────────
" The window opens in COMMAND mode; insert-mode (i) drops into the search
" box and Esc comes back out. Esc in COMMAND closes the window. The cursor
" keys above move through the results, row-open opens one.
search-all          a
search-profiles     p
search-workspaces   w
search-groups       g
search-tabs         t
search-scope        <Tab>
search-row-1        1
search-row-2        2
search-row-3        3
search-row-4        4
search-row-5        5
search-row-6        6
search-row-7        7
search-row-8        8
search-row-9        9
`

/** What each Vim command does, for the help window. App commands use the
 *  regular shortcuts' names. */
const VIM_COMMAND_LABELS: Record<string, string> = {
  'insert-mode': 'INSERT mode in the page',
  'focus-sidebar': 'Cursor to the Sidebar',
  'focus-bookshelf': 'Cursor to the Bookshelf',
  help: 'This help',
  'cursor-down': 'Cursor down',
  'cursor-up': 'Cursor up',
  'cursor-first': 'Cursor to the first row',
  'cursor-last': 'Cursor to the last row',
  'row-move-down': 'Move the row down',
  'row-move-up': 'Move the row up',
  'row-collapse': 'Collapse the group',
  'row-expand': 'Expand the group',
  'row-menu': 'Row menu',
  'row-close': 'Close the row',
  'row-open': 'Open the row (a tab: into its page, WEB)',
  'web-scroll-down': 'Scroll down',
  'web-scroll-up': 'Scroll up',
  'web-half-page-down': 'Half a page down',
  'web-half-page-up': 'Half a page up',
  'web-top': 'Top of the page',
  'web-bottom': 'Bottom of the page',
  'web-back': 'Back in history',
  'web-forward': 'Forward in history',
  'web-insert': 'INSERT mode',
  'web-focus-input': 'Pick a text field',
  'web-help': 'This help',
  'search-all': 'Show everything',
  'search-profiles': 'Profiles only',
  'search-workspaces': 'Workspaces only',
  'search-groups': 'Tab groups only',
  'search-tabs': 'Tabs only',
  'search-scope': 'This workspace / all',
}
for (let n = 1; n <= 9; n++) VIM_COMMAND_LABELS[`search-row-${n}`] = `Open result ${n}`

export function vimCommandLabel(command: string): string {
  return VIM_COMMAND_LABELS[command] ?? ACTION_LABELS[command] ?? command
}

/** Commands that drive the focused panel's cursor. Their keys also work in
 *  the Search Everything results list. */
export const PANEL_COMMANDS = [
  'cursor-down',
  'cursor-up',
  'cursor-first',
  'cursor-last',
  'row-move-down',
  'row-move-up',
  'row-collapse',
  'row-expand',
  'row-menu',
  'row-close',
  'row-open',
] as const
export type PanelCommand = (typeof PANEL_COMMANDS)[number]

export function isPanelCommand(command: string): command is PanelCommand {
  return (PANEL_COMMANDS as readonly string[]).includes(command)
}

/** Commands from the main window's map that also work in Search Everything,
 *  under the window's own search-* bindings. */
const SEARCH_SHARED_COMMANDS = new Set(['insert-mode', 'cursor-down', 'cursor-up', 'cursor-first', 'cursor-last', 'row-open'])

export type VimContext = 'command' | 'web' | 'search'

export function contextOf(command: string): VimContext {
  if (command.startsWith('web-')) return 'web'
  if (command.startsWith('search-')) return 'search'
  return 'command'
}

export interface ParsedVimKeymap {
  /** The main window's COMMAND mode. */
  main: VimKeymap
  /** WEB mode, run in the page (src/preload/webview-stealth.ts). */
  web: VimKeymap
  /** The Search Everything window's COMMAND mode. */
  search: VimKeymap
  errors: string[]
}

// Named keys, lower-cased name → canonical token.
const NAMED_KEYS: Record<string, string> = {
  cr: '<CR>', enter: '<CR>', return: '<CR>',
  esc: '<Esc>', escape: '<Esc>',
  space: '<Space>',
  tab: '<Tab>', 's-tab': '<S-Tab>',
  bs: '<BS>', backspace: '<BS>',
  del: '<Del>', delete: '<Del>',
  up: '<Up>', down: '<Down>', left: '<Left>', right: '<Right>',
  home: '<Home>', end: '<End>',
  pageup: '<PageUp>', pagedown: '<PageDown>',
  lt: '<', bslash: '\\', bar: '|',
}
for (let n = 1; n <= 12; n++) NAMED_KEYS[`f${n}`] = `<F${n}>`

/** Splits one written key sequence (`gg`, `<S-Tab>`, `g<CR>`) into canonical
 *  tokens, or returns an error message. */
function parseKeySequence(text: string): string[] | string {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '<') {
      const close = text.indexOf('>', i + 1)
      if (close > i + 1) {
        const named = NAMED_KEYS[text.slice(i + 1, close).toLowerCase()]
        if (!named) return `unknown key ${text.slice(i, close + 1)}`
        tokens.push(named)
        i = close + 1
        continue
      }
    }
    // One character — by code point, so a stray non-BMP glyph isn't split.
    const ch = String.fromCodePoint(text.codePointAt(i)!)
    tokens.push(ch)
    i += ch.length
  }
  return tokens
}

/** The canonical way to write a token sequence back out. */
export function formatKeySequence(tokens: readonly string[]): string {
  return tokens.join('')
}

let knownCommands: Set<string> | null = null

/** Every command the config may name: the ones the default config lists. */
function getKnownCommands(): Set<string> {
  if (!knownCommands) {
    knownCommands = new Set()
    for (const line of DEFAULT_VIM_KEYMAP.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith('#')) continue
      knownCommands.add(trimmed.split(/\s+/)[0])
    }
  }
  return knownCommands
}

/** Every command in the default config's order — for the help window. */
export function vimCommandsInOrder(): string[] {
  return [...getKnownCommands()]
}

/** Adds `seq → command` unless it clashes with a binding already there:
 *  the same keys, or one sequence being the start of the other (`g` would
 *  fire before `gg` could be typed). Returns the clash, if any. */
function bind(map: VimKeymap, seq: string[], command: string): string | null {
  const key = seq.join(SEQUENCE_JOIN)
  for (const [existing, other] of map) {
    const a = existing.split(SEQUENCE_JOIN)
    const shorter = a.length <= seq.length ? a : seq
    const longer = a.length <= seq.length ? seq : a
    if (shorter.every((t, idx) => t === longer[idx])) {
      return a.length === seq.length
        ? `${formatKeySequence(seq)} is already bound to ${other}`
        : `${formatKeySequence(seq)} clashes with ${formatKeySequence(a)} (${other})`
    }
  }
  map.set(key, command)
  return null
}

export function parseVimKeymap(text: string): ParsedVimKeymap {
  const known = getKnownCommands()
  const maps: Record<VimContext, VimKeymap> = { command: new Map(), web: new Map(), search: new Map() }
  const shared: Array<{ seq: string[]; command: string }> = []
  const errors: string[] = []

  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith('#')) return
    const [command, ...keys] = trimmed.split(/\s+/)
    const where = `Line ${index + 1}`
    if (!known.has(command)) {
      errors.push(`${where}: unknown command "${command}"`)
      return
    }
    for (const written of keys) {
      const seq = parseKeySequence(written)
      if (typeof seq === 'string') {
        errors.push(`${where}: ${seq}`)
        continue
      }
      const clash = bind(maps[contextOf(command)], seq, command)
      if (clash) {
        errors.push(`${where}: ${clash}`)
        continue
      }
      if (SEARCH_SHARED_COMMANDS.has(command)) shared.push({ seq, command })
    }
  })

  // The search window's own keys win: a shared key that clashes with one of
  // them (g for groups vs gg) just isn't available there.
  const search: VimKeymap = new Map(maps.search)
  for (const { seq, command } of shared) bind(search, seq, command)

  return { main: maps.command, web: maps.web, search, errors }
}

/** How `command` is bound in `map`, each sequence written out — for hints. */
export function keysFor(map: VimKeymap, command: string): string[] {
  const out: string[] = []
  for (const [seq, bound] of map) if (bound === command) out.push(seq.split(SEQUENCE_JOIN).join(''))
  return out
}
