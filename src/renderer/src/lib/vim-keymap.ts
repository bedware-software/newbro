// Vim mode's keymap: the plain-text config edited in Settings → Keyboard
// Shortcuts (the default lives in src/shared/vim-default-keymap.ts), its
// parser, and the descriptions its help (?) shows.
//
// One binding per line: `<command> <keys> [<keys>…]`. A command with no keys
// is listed but unbound. `"` (vim) or `#` starts a comment line. Keys are
// typed characters — Shift is the capital, so `J` is Shift+J — sequences
// like `gg`, Ctrl with a letter (`<C-l>`), and named keys in angle brackets
// (`<CR>`, `<Esc>`, `<Tab>`). The command's prefix says where it works:
// `browse-` in BROWSE mode (the page), `search-` in Search Everything and
// the Command Palette, `find-` in Find in Page, `url-` in the address editor,
// anything else in COMMAND mode.

import { ACTION_LABELS } from './action-labels'
import { SEQUENCE_JOIN, type VimKeymap } from '../../../shared/vim-keys'
import { DEFAULT_VIM_KEYMAP, renamedVimCommand } from '../../../shared/vim-default-keymap'

export { keyTokenFromEvent, matchKeys, type VimKeymap, type VimKeymapEntries } from '../../../shared/vim-keys'
export { DEFAULT_VIM_KEYMAP } from '../../../shared/vim-default-keymap'

/** What each Vim command does, for the help window. App commands use the
 *  regular shortcuts' names. */
const VIM_COMMAND_LABELS: Record<string, string> = {
  'insert-mode': 'INSERT mode in the page',
  'browse-mode': 'BROWSE mode in the page',
  'focus-sidebar': 'Cursor to the Sidebar',
  'focus-bookshelf': 'Cursor to the Bookshelf',
  help: 'This help',
  'cursor-down': 'Cursor down',
  'cursor-up': 'Cursor up',
  'cursor-down-show': 'Cursor down, showing its tab',
  'cursor-up-show': 'Cursor up, showing its tab',
  'cursor-first': 'Cursor to the first row',
  'cursor-last': 'Cursor to the last row',
  'row-move-down': 'Move the row down',
  'row-move-up': 'Move the row up',
  'row-collapse': 'Collapse the group',
  'row-expand': 'Expand the group',
  'row-menu': 'Row menu',
  'row-close': 'Close the row',
  'row-show': 'Show the row (stay in COMMAND)',
  'row-open': 'Open the row (a tab: into its page, BROWSE)',
  'copy-url': 'Copy the page address',
  'paste-url': 'Open the copied address here',
  'paste-url-new-tab': 'Open the copied address in a new tab',
  'split-right': 'Split: new pane on the right',
  'split-down': 'Split: new pane below',
  'split-focus': 'Focus the other split pane',
  'split-close': 'End the split (keep this pane)',
  'edit-url': 'Edit the address (block by block)',
  'url-change': 'Change a block: c, then its key (cc: the whole address)',
  'url-remove': 'Remove a block: r, then its key (rr: the whole address)',
  'url-copy': 'Copy a block: y, then its key (yy: the whole address)',
  'url-paste': 'Paste over a block: p, then its key',
  'url-paste-all': 'Paste over the whole address',
  'url-up': 'Up a level (drop the last path level)',
  'url-site': 'Only the site (protocol and domain)',
  'url-copy-title': 'Copy the page title',
  'url-clear': 'Clear and type',
  'url-append': 'Type at the end',
  'url-insert-start': 'Type at the start',
  'url-insert': 'Type where you left off',
  'url-undo': 'Undo the last change',
  'url-go': 'Go to the address',
  'browse-scroll-down': 'Scroll down',
  'browse-scroll-up': 'Scroll up',
  'browse-half-page-down': 'Half a page down',
  'browse-half-page-up': 'Half a page up',
  'browse-top': 'Top of the page',
  'browse-bottom': 'Bottom of the page',
  'browse-back': 'Back in history',
  'browse-forward': 'Forward in history',
  'browse-insert': 'INSERT mode',
  'browse-focus-input': 'Pick a text field',
  'browse-close-tab': 'Close the tab',
  'browse-copy-url': 'Copy the page address',
  'browse-paste-url': 'Open the copied address here',
  'browse-paste-url-new-tab': 'Open the copied address in a new tab',
  'browse-focus-url': 'Focus the address bar',
  'browse-split-focus': 'Focus the other split pane',
  'browse-help': 'This help',
  'search-all': 'Show everything',
  'search-profiles': 'Profiles only',
  'search-workspaces': 'Workspaces only',
  'search-groups': 'Tab groups only',
  'search-tabs': 'Tabs only',
  'search-scope': 'This workspace / all',
  'find-next': 'Next match',
  'find-prev': 'Previous match',
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
  'cursor-down-show',
  'cursor-up-show',
  'cursor-first',
  'cursor-last',
  'row-move-down',
  'row-move-up',
  'row-collapse',
  'row-expand',
  'row-menu',
  'row-close',
  'row-show',
  'row-open',
] as const
export type PanelCommand = (typeof PANEL_COMMANDS)[number]

export function isPanelCommand(command: string): command is PanelCommand {
  return (PANEL_COMMANDS as readonly string[]).includes(command)
}

/** Commands from the main window's map that also work in a popup's own
 *  COMMAND mode, under the popup's own bindings. */
const SHARED_COMMANDS: Record<'search' | 'find', Set<string>> = {
  search: new Set(['insert-mode', 'cursor-down', 'cursor-up', 'cursor-first', 'cursor-last', 'row-open']),
  find: new Set(['insert-mode']),
}

export type VimContext = 'command' | 'browse' | 'search' | 'find' | 'url'

// COMMAND-mode commands whose names happen to start with another context's
// prefix.
const COMMAND_CONTEXT_EXCEPTIONS = new Set(['browse-mode', 'find-in-page'])

export function contextOf(command: string): VimContext {
  if (COMMAND_CONTEXT_EXCEPTIONS.has(command)) return 'command'
  if (command.startsWith('browse-')) return 'browse'
  if (command.startsWith('search-')) return 'search'
  if (command.startsWith('find-')) return 'find'
  if (command.startsWith('url-')) return 'url'
  return 'command'
}

export interface ParsedVimKeymap {
  /** The main window's COMMAND mode. */
  main: VimKeymap
  /** BROWSE mode, run in the page (src/preload/webview-stealth.ts). */
  browse: VimKeymap
  /** COMMAND mode of Search Everything and the Command Palette. */
  search: VimKeymap
  /** COMMAND mode of Find in Page. */
  find: VimKeymap
  /** COMMAND mode of the address editor. */
  url: VimKeymap
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

/** A named key in angle brackets, without them: `cr`, `C-l`, `c-s-j`. */
function namedKeyToken(name: string): string | null {
  const ctrl = /^c-(s-)?([a-z])$/i.exec(name)
  if (ctrl) return `<C-${ctrl[1] ? 'S-' : ''}${ctrl[2].toLowerCase()}>`
  return NAMED_KEYS[name.toLowerCase()] ?? null
}

/** Splits one written key sequence (`gg`, `<S-Tab>`, `g<CR>`) into canonical
 *  tokens, or returns an error message. */
function parseKeySequence(text: string): string[] | string {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '<') {
      const close = text.indexOf('>', i + 1)
      if (close > i + 1) {
        const named = namedKeyToken(text.slice(i + 1, close))
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

const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')

const TOKEN_DISPLAY: Record<string, string> = {
  '<CR>': 'Enter', '<Esc>': 'Esc', '<Space>': 'Space', '<Tab>': 'Tab', '<S-Tab>': 'Shift+Tab',
  '<BS>': 'Backspace', '<Del>': 'Del', '<Up>': '↑', '<Down>': '↓', '<Left>': '←', '<Right>': '→',
  '<Home>': 'Home', '<End>': 'End', '<PageUp>': 'PgUp', '<PageDown>': 'PgDn',
}

/** How a written sequence reads on a keycap: `<CR>` as Enter, `<C-j>` as
 *  Ctrl+J (⌃J on a Mac), `gg` as is. */
export function displayKeySequence(written: string): string {
  const tokens = parseKeySequence(written)
  if (typeof tokens === 'string') return written
  return tokens.map((token) => {
    const ctrl = /^<C-(S-)?(.)>$/.exec(token)
    if (ctrl) {
      const letter = ctrl[2].toUpperCase()
      if (isMac) return `⌃${ctrl[1] ? '⇧' : ''}${letter}`
      return `Ctrl+${ctrl[1] ? 'Shift+' : ''}${letter}`
    }
    return TOKEN_DISPLAY[token] ?? token
  }).join('')
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
  const maps: Record<VimContext, VimKeymap> = { command: new Map(), browse: new Map(), search: new Map(), find: new Map(), url: new Map() }
  const shared: Array<{ seq: string[]; command: string }> = []
  const errors: string[] = []

  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith('#')) return
    const [written, ...keys] = trimmed.split(/\s+/)
    // A keymap saved before WEB mode became BROWSE (another device's, via
    // Cloud Sync) still names its commands web-*.
    const command = known.has(written) ? written : renamedVimCommand(written)
    const where = `Line ${index + 1}`
    if (!known.has(command)) {
      errors.push(`${where}: unknown command "${written}"`)
      return
    }
    for (const writtenKeys of keys) {
      const seq = parseKeySequence(writtenKeys)
      if (typeof seq === 'string') {
        errors.push(`${where}: ${seq}`)
        continue
      }
      const clash = bind(maps[contextOf(command)], seq, command)
      if (clash) {
        errors.push(`${where}: ${clash}`)
        continue
      }
      shared.push({ seq, command })
    }
  })

  // A popup's own keys win: a shared key that clashes with one of them (g
  // for groups vs gg) just isn't available there.
  const withShared = (context: 'search' | 'find'): VimKeymap => {
    const map: VimKeymap = new Map(maps[context])
    for (const { seq, command } of shared) if (SHARED_COMMANDS[context].has(command)) bind(map, seq, command)
    return map
  }

  return { main: maps.command, browse: maps.browse, search: withShared('search'), find: withShared('find'), url: maps.url, errors }
}

/** The Command Palette's COMMAND keys: Search Everything's, less its filters. */
export function paletteKeymap(search: VimKeymap): VimKeymap {
  const map: VimKeymap = new Map()
  for (const [seq, command] of search) {
    if (SHARED_COMMANDS.search.has(command) || /^search-row-\d$/.test(command)) map.set(seq, command)
  }
  return map
}

/** How `command` is bound in `map`, each sequence written out — for hints. */
export function keysFor(map: VimKeymap, command: string): string[] {
  const out: string[] = []
  for (const [seq, bound] of map) if (bound === command) out.push(seq.split(SEQUENCE_JOIN).join(''))
  return out
}
