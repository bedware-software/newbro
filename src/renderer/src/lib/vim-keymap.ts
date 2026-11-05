// Vim mode's keymap: the plain-text config edited in Settings → Keyboard
// Shortcuts (the default lives in src/shared/vim-default-keymap.ts), its
// parser, and the descriptions its help (?) shows.
//
// One binding per line: `<command> <keys> [<keys>…]`. A command with no keys
// is listed but unbound. `"` (vim) or `#` starts a comment line. Keys are
// typed characters — Shift is the capital, so `J` is Shift+J — sequences
// like `gg`, Ctrl with a letter or digit (`<C-l>`, `<C-1>`), and named keys in angle brackets
// (`<CR>`, `<Esc>`, `<Tab>`). The command's prefix says where it works:
// `search-` in Search Everything and the Command Palette, `find-` in Find in
// Page, `url-` in the address editor, anything else in COMMAND mode.

import { ACTION_LABELS } from './action-labels'
import { SEQUENCE_JOIN, type VimKeymap } from '../../../shared/vim-keys'
import { DEFAULT_VIM_KEYMAP, contextOf, renamedVimCommand, type VimContext } from '../../../shared/vim-default-keymap'

export { keyTokenFromEvent, matchKeys, isPageCommand, type VimKeymap, type VimKeymapEntries } from '../../../shared/vim-keys'
export { DEFAULT_VIM_KEYMAP, type VimContext } from '../../../shared/vim-default-keymap'

/** What each Vim command does, for the help window. App commands use the
 *  regular shortcuts' names. */
const VIM_COMMAND_LABELS: Record<string, string> = {
  'scroll-down': 'Scroll down',
  'scroll-up': 'Scroll up',
  'half-page-down': 'Half a page down',
  'half-page-up': 'Half a page up',
  'page-top': 'Top of the page',
  'page-bottom': 'Bottom of the page',
  'insert-mode': 'INSERT mode in the page',
  'focus-input': 'Pick a text field',
  help: 'This help',
  'cursor-down-show': 'Next row (tab or group), showing it',
  'cursor-up-show': 'Previous row (tab or group), showing it',
  'row-move-down': 'Move the tab down',
  'row-move-up': 'Move the tab up',
  'row-fold': 'Fold the group, onto its header',
  'row-unfold': 'Unfold the group, or step into it',
  'row-menu': 'Tab menu',
  'cursor-down': 'Next result',
  'cursor-up': 'Previous result',
  'cursor-first': 'First result',
  'cursor-last': 'Last result',
  'row-open': 'Open the result',
  'copy-url': 'Copy the page address',
  'paste-url': 'Open the copied address here',
  'paste-url-new-tab': 'Open the copied address in a new tab',
  'split-right': 'Split: new pane on the right',
  'split-down': 'Split: new pane below',
  'split-focus': 'Focus the other split pane',
  'split-close': 'End the split (keep this pane)',
  'edit-url': 'Edit the address (block by block)',
  'set-comment': 'Comment the tab',
  'remove-comment': 'Remove the tab\'s comment',
  'pick-workspace': 'Search workspaces',
  'pick-tab': 'Search tabs',
  'pick-group': 'Search tab groups',
  'pick-profile': 'Search profiles',
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

/** Commands that act on the Sidebar's row under the cursor — the active
 *  tab's. Bound to Ctrl chords, so holding Ctrl shows the cursor (and a
 *  hidden Sidebar). */
export const SIDEBAR_COMMANDS = [
  'cursor-down-show',
  'cursor-up-show',
  'row-move-down',
  'row-move-up',
  'row-fold',
  'row-unfold',
  'row-menu',
] as const
export type SidebarCommand = (typeof SIDEBAR_COMMANDS)[number]

export function isSidebarCommand(command: string): command is SidebarCommand {
  return (SIDEBAR_COMMANDS as readonly string[]).includes(command)
}

/** A popup's list commands (the results of Search Everything, the Command
 *  Palette, the split picker) and the main window's commands whose keys they
 *  take: the keys that scroll the page step through the results. Enter,
 *  fixed, opens one. */
const LIST_COMMANDS: Record<string, string> = {
  'cursor-down': 'scroll-down',
  'cursor-up': 'scroll-up',
  'cursor-first': 'page-top',
  'cursor-last': 'page-bottom',
}
const LIST_OPEN_KEY = ['<CR>']

/** Commands from the main window's map that also work in a popup's own
 *  COMMAND mode, as popup command → main command. */
const SHARED_COMMANDS: Record<'search' | 'find', Record<string, string>> = {
  search: { 'insert-mode': 'insert-mode', ...LIST_COMMANDS },
  find: { 'insert-mode': 'insert-mode' },
}

export interface ParsedVimKeymap {
  /** COMMAND mode: the main window's chrome and its pages
   *  (src/preload/webview-stealth.ts). */
  main: VimKeymap
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

/** A named key in angle brackets, without them: `cr`, `C-l`, `c-s-j`, `C-1`. */
function namedKeyToken(name: string): string | null {
  const ctrl = /^c-(s-)?([a-z0-9])$/i.exec(name)
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

/** Every command in the default config's order, then the popups' list
 *  commands — for the help window. */
export function vimCommandsInOrder(): string[] {
  return [...getKnownCommands(), ...Object.keys(LIST_COMMANDS), 'row-open']
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
  const maps: Record<VimContext, VimKeymap> = { command: new Map(), search: new Map(), find: new Map(), url: new Map() }
  const shared: Array<{ seq: string[]; command: string }> = []
  const errors: string[] = []

  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith('#')) return
    const [written, ...keys] = trimmed.split(/\s+/)
    // A keymap saved under older defaults (another device's, via Cloud Sync)
    // names commands web-* or browse-*, or ones that are gone.
    const command = known.has(written) ? written : renamedVimCommand(written)
    if (command === null) return
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
    const sharedHere = Object.entries(SHARED_COMMANDS[context])
    for (const { seq, command } of shared) {
      for (const [popupCommand, mainCommand] of sharedHere) if (mainCommand === command) bind(map, seq, popupCommand)
    }
    if (context === 'search') bind(map, LIST_OPEN_KEY, 'row-open')
    return map
  }

  return { main: maps.command, search: withShared('search'), find: withShared('find'), url: maps.url, errors }
}

/** The Command Palette's COMMAND keys: Search Everything's, less its filters. */
export function paletteKeymap(search: VimKeymap): VimKeymap {
  const map: VimKeymap = new Map()
  for (const [seq, command] of search) {
    if (command in SHARED_COMMANDS.search || command === 'row-open' || /^search-row-\d$/.test(command)) map.set(seq, command)
  }
  return map
}

/** How `command` is bound in `map`, each sequence written out — for hints. */
export function keysFor(map: VimKeymap, command: string): string[] {
  const out: string[] = []
  for (const [seq, bound] of map) if (bound === command) out.push(seq.split(SEQUENCE_JOIN).join(''))
  return out
}
