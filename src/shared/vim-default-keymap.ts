// Vim mode's default keymap — the plain-text config edited in Settings →
// Keyboard Shortcuts (parsed by renderer lib/vim-keymap.ts) — and the
// migration that carries a keymap saved under older defaults forward. Shared
// so main can migrate the saved setting before any window reads it.

export const DEFAULT_VIM_KEYMAP = `" Vim mode keys.
" One binding per line: <command> <keys> [<more keys>…]. A command with no
" keys is unbound. Lines starting with " are comments.
"
" Keys: a typed character (Shift is the capital: J is Shift+J), a sequence
" (gg), Ctrl with a letter or digit (<C-l>, <C-1>, <C-S-j> with Shift), or a
" named key: <CR> <Esc> <Space> <Tab> <S-Tab> <BS> <Del> <Up> <Down> <Left>
" <Right> <Home> <End> <PageUp> <PageDown> <F1>…<F12>.
" Keys go by position on the keyboard, so they work in any input language.
"
" Two modes:
"   COMMAND  the page and the browser: scrolling, history, tabs, app
"            commands. Keys not bound here reach the page.
"   INSERT   keys go to the page or the field you type in
" i (or gi, picking a text field) goes into INSERT; Esc or Ctrl+[ comes back
" to COMMAND. Clicking a text field is INSERT, anywhere else COMMAND. The
" regular shortcuts (⌘T, ⌘L, …) are off while Vim mode is on.

" ── COMMAND: the page ─────────────────────────────────────────────────
" focus-input outlines the page's text fields: h/j/k/l (or Tab) pick one,
" <CR> types into it, Esc cancels.
scroll-down         j
scroll-up           k
half-page-down      d
half-page-up        u
page-top            gg
page-bottom         G
back                h [
forward             l ]
insert-mode         i
focus-input         gi
help                ?

" ── COMMAND: the Sidebar, with Ctrl held ──────────────────────────────
" Holding Ctrl puts a cursor on the active tab's row (and shows the
" Sidebar while it's hidden — Settings → Keyboard Shortcuts). <C-j>/<C-k>
" step through the tabs, showing each; letting Ctrl go stays on the one
" shown. row-fold folds the group the cursor is in, or unfolds it.
cursor-down-show    <C-j>
cursor-up-show      <C-k>
row-move-down       <C-S-j>
row-move-up         <C-S-k>
row-fold            <C-h>
row-menu            <C-m>

" ── COMMAND: split view ───────────────────────────────────────────────
" S splits the page area with a pane on the right, V with one below, and
" offers the tabs to put there. <C-w> moves the focus to the other pane; q
" ends the split, keeping the focused pane's tab.
split-right         S
split-down          V
split-focus         <C-w>
split-close         q

" ── COMMAND: Search Everything on one kind of thing ───────────────────
" Opens typing (INSERT) with the filter set; Esc goes to its COMMAND keys.
pick-workspace      w
pick-tab            t
pick-group
pick-profile        p

" ── COMMAND: app commands (the regular shortcuts' ids) ────────────────
new-tab             <CR>
close-tab           x
reopen-closed-tab   T
close-window
new-workspace       N
next-tab
prev-tab
toggle-sidebar      \\
focus-url
edit-url            e
search              f
command-palette     :
copy-url            y
paste-url
paste-url-new-tab   P
reload              r
settings            ,
page-devtools       I
ui-devtools
find-in-page        /
save-page
tab-1               <C-1>
tab-2               <C-2>
tab-3               <C-3>
tab-4               <C-4>
tab-5               <C-5>
tab-6               <C-6>
tab-7               <C-7>
tab-8               <C-8>
tab-9               <C-9>
duplicate-tab
move-tab
rename-tab-group
move-group
duplicate-group
add-to-bookshelf
toggle-bookshelf    B
open-downloads      D

" ── Search Everything and the Command Palette ─────────────────────────
"Search Everything and the Command Palette open in INSERT; Esc goes to
" COMMAND, and insert-mode (i) drops back into the box. Esc in
" COMMAND closes the window. The scroll keys above (j/k, gg/G) move through
" the results, Enter runs one. The filters are Search Everything's.
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

" ── Address editor (e) ───────────────────────────────────────────────
" Opens typing (INSERT) over the whole address, selected, as other
" browsers' address bars do; Esc goes to its COMMAND keys.
" The page's title, and its address big, cut into blocks with a key each:
" h protocol, d domain, n port, 1–9 the path's levels, p parameters,
" f fragment. An intent and a block's key act on that block — c changes it
" (selects it to type over), r removes it, y copies it, p pastes over it;
" the intent's key again acts on the whole address (yy, cc, rr — pp is the
" parameters), and P pastes over all of it. <CR> goes there, Shift+<CR> in
" a new tab; Esc leaves typing, then closes.
url-change          c
url-remove          r
url-copy            y
url-paste           p
url-paste-all       P
url-up              u
url-site            t
url-copy-title      n
url-clear           C
url-append          A
url-insert-start    I
url-insert          i
url-undo            U
url-go              <CR>

" ── Find in page ──────────────────────────────────────────────────────
" Opens in INSERT, only for typing what to find (the first match lights up
" as you type). <CR> or Esc goes to COMMAND, where these keys step through
" the matches; i types again and Esc closes.
find-next           j n
find-prev           k N
`

// ── Contexts ──

export type VimContext = 'command' | 'search' | 'find' | 'url'

// COMMAND-mode commands whose names happen to start with another context's
// prefix.
const COMMAND_CONTEXT_EXCEPTIONS = new Set(['find-in-page'])

/** Where a command works, by its name's prefix: `search-` in Search
 *  Everything and the Command Palette, `find-` in Find in Page, `url-` in
 *  the address editor, anything else in COMMAND mode. */
export function contextOf(command: string): VimContext {
  if (COMMAND_CONTEXT_EXCEPTIONS.has(command)) return 'command'
  if (command.startsWith('search-')) return 'search'
  if (command.startsWith('find-')) return 'find'
  if (command.startsWith('url-')) return 'url'
  return 'command'
}

// ── Migration ──
//
// v2 renamed the WEB mode BROWSE (web-* commands are browse-* now) and
// moved some COMMAND defaults. v3 folded BROWSE into COMMAND: the page's
// keys (browse-*) are COMMAND keys now, under plain names, and the Sidebar's
// cursor moved onto Ctrl chords, so j/k/h/l/gg/G/x are the page's. v4 put
// the tab numbers (tab-1…tab-9) on Ctrl too, with the Sidebar that shows
// them: a plain digit picked a tab out of sight when it's hidden. v5 took
// the address bar off Ctrl (<C-l> brought the Sidebar up on the way) and
// onto e, moving the address editor to E. v6 put the address editor on e
// (the plain address bar went unbound), opened Search Everything on one kind
// of thing from w/t/p (pick-*), moved new-tab to <CR> and unbound paste-url,
// next-tab and prev-tab, whose keys those took. A saved
// keymap keeps every binding its owner changed — unless it now clashes with
// another binding, then it takes the new default — and the new defaults for
// the rest, including commands it couldn't know about.

/** v3's name for an older command: null when v3 has no such command. */
const RENAMED_IN_V3: Record<string, string | null> = {
  'browse-scroll-down': 'scroll-down',
  'browse-scroll-up': 'scroll-up',
  'browse-half-page-down': 'half-page-down',
  'browse-half-page-up': 'half-page-up',
  'browse-top': 'page-top',
  'browse-bottom': 'page-bottom',
  'browse-back': 'back',
  'browse-forward': 'forward',
  'browse-insert': 'insert-mode',
  'browse-focus-input': 'focus-input',
  'browse-close-tab': 'close-tab',
  'browse-copy-url': 'copy-url',
  'browse-paste-url': 'paste-url',
  'browse-paste-url-new-tab': 'paste-url-new-tab',
  'browse-focus-url': 'focus-url',
  'browse-split-focus': 'split-focus',
  'browse-help': 'help',
  'row-collapse': 'row-fold',
  'row-expand': 'row-fold',
  'browse-mode': null,
  'focus-sidebar': null,
  'focus-bookshelf': null,
  'cursor-down': null,
  'cursor-up': null,
  'cursor-first': null,
  'cursor-last': null,
  'row-close': null,
  'row-show': null,
  'row-open': null,
}

/** The current name of a command written under an older keymap (web-*,
 *  browse-*), or null for one that's gone. Any other name comes back as is. */
export function renamedVimCommand(command: string): string | null {
  const v2 = command.startsWith('web-') ? `browse-${command.slice(4)}` : command
  return v2 in RENAMED_IN_V3 ? RENAMED_IN_V3[v2] : v2
}

/** v2 defaults of the commands v3 renamed, merged or rebound — the rest
 *  kept their keys. */
const V2_DEFAULT_KEYS: Record<string, string> = {
  'browse-scroll-down': 'j',
  'browse-scroll-up': 'k',
  'browse-half-page-down': 'd',
  'browse-half-page-up': 'u',
  'browse-top': 'gg',
  'browse-bottom': 'G',
  'browse-back': 'h',
  'browse-forward': 'l',
  'browse-insert': 'i',
  'browse-focus-input': 'gi',
  'browse-close-tab': 'x',
  'browse-copy-url': 'y',
  'browse-paste-url': 'p',
  'browse-paste-url-new-tab': 'P',
  'browse-focus-url': '<C-l>',
  'browse-split-focus': '<C-w>',
  'browse-help': '?',
  back: '[',
  forward: ']',
  'close-tab': '',
  'row-move-down': 'J',
  'row-move-up': 'K',
  'row-collapse': 'h',
  'row-expand': 'l',
  'row-menu': 'm',
  'open-downloads': 'd',
}

/** v1 defaults of the commands v2 rebound. */
const V1_DEFAULT_KEYS: Record<string, string> = {
  'close-tab': 'w',
  'focus-url': 'o',
  search: 'p',
  'command-palette': 'P :',
  'find-in-page': 'f /',
}

/** v3 defaults of the commands v4 rebound: the tab numbers, plain digits
 *  since v1. */
const V3_DEFAULT_KEYS: Record<string, string> = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tab-${n}`, String(n)]),
)

/** v4 defaults of the commands v5 rebound. */
const V4_DEFAULT_KEYS: Record<string, string> = {
  'focus-url': '<C-l>',
  'edit-url': 'e',
}

/** v5 defaults of the commands v6 rebound. */
const V5_DEFAULT_KEYS: Record<string, string> = {
  'new-tab': 't',
  'paste-url': 'p',
  'next-tab': 'gt',
  'prev-tab': 'gT',
  'focus-url': 'e',
  'edit-url': 'E',
}

/** Commands v6 added; no older keymap mentions them. */
const NEW_IN_V6 = new Set(['pick-workspace', 'pick-tab', 'pick-group', 'pick-profile'])

/** Commands v3 added under new names; no older keymap mentions them. */
const NEW_IN_V3 = new Set([
  'scroll-down', 'scroll-up', 'half-page-down', 'half-page-up', 'page-top', 'page-bottom',
  'focus-input', 'row-fold',
])

/** Commands v2 added; a v1 keymap never mentions them. */
const NEW_IN_V2 = new Set([
  'browse-mode', 'cursor-down-show', 'cursor-up-show', 'row-show', 'copy-url', 'paste-url',
  'paste-url-new-tab', 'browse-close-tab', 'browse-copy-url', 'browse-paste-url',
  'browse-paste-url-new-tab', 'browse-focus-url', 'find-next', 'find-prev', 'split-right',
  'split-down', 'split-focus', 'split-close', 'browse-split-focus', 'edit-url', 'url-change',
  'url-remove', 'url-copy', 'url-paste', 'url-paste-all', 'url-up', 'url-site', 'url-copy-title',
  'url-clear', 'url-append', 'url-insert-start', 'url-insert', 'url-undo', 'url-go',
])

function isBindingLine(trimmed: string): boolean {
  return trimmed !== '' && !trimmed.startsWith('"') && !trimmed.startsWith('#')
}

/** Splits written keys into tokens, enough to tell clashes apart: `<C-j>`
 *  is one, `gg` two. */
function keyTokens(written: string): string[] {
  return (written.match(/<[^<>\s]+>|./gu) ?? []).map((t) => (t.length > 1 ? t.toLowerCase() : t))
}

/** Whether one sequence is the other or starts it (`g` before `gg`). */
function sequencesClash(a: string, b: string): boolean {
  const x = keyTokens(a)
  const y = keyTokens(b)
  const n = Math.min(x.length, y.length)
  return n > 0 && x.slice(0, n).every((t, i) => t === y[i])
}

/**
 * Carries a keymap saved under older defaults (v1 to v5) over to the
 * current ones: the default text, with each binding the owner changed (or
 * removed) as they had it. Null when that comes out as the plain default —
 * nothing to keep.
 */
export function migrateVimKeymap(saved: string, fromVersion: 1 | 2 | 3 | 4 | 5): string | null {
  // What the owner had, by the old name.
  const mine = new Map<string, string>()
  for (const line of saved.split('\n')) {
    const trimmed = line.trim()
    if (!isBindingLine(trimmed)) continue
    const [written, ...keys] = trimmed.split(/\s+/)
    const v2 = written.startsWith('web-') ? `browse-${written.slice(4)}` : written
    mine.set(v2, keys.join(' '))
  }
  const oldDefault = (command: string, fallback: string): string =>
    (fromVersion === 1 ? V1_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 2 ? V2_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 3 ? V3_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 4 ? V4_DEFAULT_KEYS[command] : undefined) ??
    V5_DEFAULT_KEYS[command] ??
    fallback
  // Whether the saved keymap's version had the command: one it lacks isn't
  // missing because its owner unbound it.
  const existed = (command: string): boolean =>
    NEW_IN_V6.has(command) ? false
    : fromVersion >= 3
      ? !(command in RENAMED_IN_V3)
      : !NEW_IN_V3.has(command) && !(fromVersion === 1 && NEW_IN_V2.has(command))
  // The old commands that make up each current one: itself, and what was
  // renamed or merged into it.
  const sourcesOf = (command: string): string[] => [
    command,
    ...Object.keys(RENAMED_IN_V3).filter((old) => RENAMED_IN_V3[old] === command),
  ].filter(existed)

  const lines = DEFAULT_VIM_KEYMAP.split('\n')
  // command → [line index, keys] for every binding line, as it stands.
  const bindings = new Map<string, { index: number; keys: string[] }>()
  const changed: string[] = []
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!isBindingLine(trimmed)) return
    const [command, ...defaults] = trimmed.split(/\s+/)
    bindings.set(command, { index, keys: defaults })
    // The owner's keys over all of its sources, against those sources' old
    // defaults: equal is untouched.
    let touched = false
    const ownKeys: string[] = []
    for (const source of sourcesOf(command)) {
      const before = oldDefault(source, defaults.join(' '))
      // A line the owner deleted is a command they unbound.
      const theirs = mine.get(source) ?? ''
      if (theirs !== before) touched = true
      for (const key of theirs.split(' ')) if (key && !ownKeys.includes(key)) ownKeys.push(key)
    }
    if (!touched) return
    bindings.set(command, { index, keys: ownKeys })
    changed.push(command)
  })

  // An owner's binding that clashes with another in its context goes back
  // to the default.
  for (const command of changed) {
    const own = bindings.get(command)!
    const clashes = own.keys.some((key) => [...bindings].some(([other, b]) =>
      other !== command && contextOf(other) === contextOf(command) && b.keys.some((k) => sequencesClash(key, k))))
    if (!clashes) continue
    const line = lines[own.index].trim().split(/\s+/)
    own.keys = line.slice(1)
  }

  for (const command of changed) {
    const { index, keys } = bindings.get(command)!
    const line = lines[index]
    const column = /^\S+\s+/.exec(line)?.[0] ?? `${command.padEnd(19)} `
    lines[index] = keys.length > 0 ? column + keys.join(' ') : command
  }
  const migrated = lines.join('\n')
  return migrated === DEFAULT_VIM_KEYMAP ? null : migrated
}
