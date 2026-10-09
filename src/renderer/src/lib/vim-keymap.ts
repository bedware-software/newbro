// Vim mode's COMMAND-mode keymap: the plain-text config edited in
// Settings → Keyboard Shortcuts, its parser, and the KeyboardEvent → key
// token translation both sides share.
//
// One binding per line: `<command> <keys> [<keys>…]`. A command with no keys
// is listed but unbound. `"` (vim) or `#` starts a comment line. Keys are
// typed characters — Shift is the capital, so `J` is Shift+J — sequences
// like `gg`, and named keys in angle brackets (`<CR>`, `<Esc>`, `<Tab>`).

export const DEFAULT_VIM_KEYMAP = `" Vim mode — keys for COMMAND mode.
" One binding per line: <command> <keys> [<more keys>…]. A command with no
" keys is unbound. Lines starting with " are comments.
"
" Keys: a typed character (Shift is the capital: J is Shift+J), a sequence
" (gg), or a named key: <CR> <Esc> <Space> <Tab> <S-Tab> <BS> <Del>
" <Up> <Down> <Left> <Right> <Home> <End> <PageUp> <PageDown> <F1>…<F12>.
" Keys go by position on the keyboard, so they work in any input language.
"
" Esc on a page that doesn't use it switches INSERT → COMMAND. Clicking the
" page, a text field or the URL bar switches back to INSERT.

" ── Modes and panels ──────────────────────────────────────────────────
insert-mode         i
focus-sidebar       s
focus-bookshelf     b

" ── Cursor in the focused panel (Sidebar or Bookshelf) ────────────────
" In the Sidebar the cursor switches tabs as it moves.
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

" ── App commands (the regular shortcuts, same ids) ────────────────────
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
`

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

const isSearchCommand = (command: string): boolean => command.startsWith('search-')

/** Key sequence (tokens joined by {@link SEQUENCE_JOIN}) → command, for one window. */
export type VimKeymap = Map<string, string>

const SEQUENCE_JOIN = '\u0000'

export interface ParsedVimKeymap {
  /** The main window's COMMAND mode. */
  main: VimKeymap
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
  const main: VimKeymap = new Map()
  const searchOwn: VimKeymap = new Map()
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
      const clash = bind(isSearchCommand(command) ? searchOwn : main, seq, command)
      if (clash) {
        errors.push(`${where}: ${clash}`)
        continue
      }
      if (SEARCH_SHARED_COMMANDS.has(command)) shared.push({ seq, command })
    }
  })

  // The search window's own keys win: a shared key that clashes with one of
  // them (g for groups vs gg) just isn't available there.
  const search: VimKeymap = new Map(searchOwn)
  for (const { seq, command } of shared) bind(search, seq, command)

  return { main, search, errors }
}

// ── Key events ──────────────────────────────────────────────────────────

const NAMED_EVENT_KEYS: Record<string, string> = {
  Enter: '<CR>', Escape: '<Esc>', ' ': '<Space>', Backspace: '<BS>', Delete: '<Del>',
  ArrowUp: '<Up>', ArrowDown: '<Down>', ArrowLeft: '<Left>', ArrowRight: '<Right>',
  Home: '<Home>', End: '<End>', PageUp: '<PageUp>', PageDown: '<PageDown>',
}

// US-layout characters by physical key, [plain, shifted], for keys typed in
// another input language (Russian: the j key gives "о").
const US_LAYOUT: Record<string, [string, string]> = {
  Backquote: ['`', '~'], Minus: ['-', '_'], Equal: ['=', '+'],
  BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'],
  Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'],
  Digit1: ['1', '!'], Digit2: ['2', '@'], Digit3: ['3', '#'], Digit4: ['4', '$'], Digit5: ['5', '%'],
  Digit6: ['6', '^'], Digit7: ['7', '&'], Digit8: ['8', '*'], Digit9: ['9', '('], Digit0: ['0', ')'],
}

/** The key token a keydown stands for, or null for a bare modifier, a dead
 *  key or a key with Ctrl/Alt/Cmd held (those stay app shortcuts). */
export function keyTokenFromEvent(e: KeyboardEvent): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null
  if (e.key === 'Tab') return e.shiftKey ? '<S-Tab>' : '<Tab>'
  const named = NAMED_EVENT_KEYS[e.key]
  if (named) return named
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return `<${e.key}>`
  if (e.key.length !== 1) return null
  // Printable ASCII as typed; anything else by its physical key.
  if (e.key >= '!' && e.key <= '~') return e.key
  const letter = /^Key([A-Z])$/.exec(e.code)
  if (letter) return e.shiftKey ? letter[1] : letter[1].toLowerCase()
  const other = US_LAYOUT[e.code]
  if (other) return e.shiftKey ? other[1] : other[0]
  return e.key
}

export type KeymapMatch =
  | { kind: 'command'; command: string }
  | { kind: 'pending' }
  | { kind: 'none' }

/** Looks the pending tokens up: a full binding, the start of one, or nothing. */
export function matchKeys(map: VimKeymap, tokens: readonly string[]): KeymapMatch {
  const key = tokens.join(SEQUENCE_JOIN)
  const command = map.get(key)
  if (command) return { kind: 'command', command }
  const prefix = key + SEQUENCE_JOIN
  for (const seq of map.keys()) if (seq.startsWith(prefix)) return { kind: 'pending' }
  return { kind: 'none' }
}

/** How `command` is bound in `map`, each sequence written out — for hints. */
export function keysFor(map: VimKeymap, command: string): string[] {
  const out: string[] = []
  for (const [seq, bound] of map) if (bound === command) out.push(seq.split(SEQUENCE_JOIN).join(''))
  return out
}
