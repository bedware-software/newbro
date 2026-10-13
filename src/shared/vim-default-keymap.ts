// Vim mode's default keymap — the plain-text config edited in Settings →
// Keyboard Shortcuts (parsed by renderer lib/vim-keymap.ts) — and the
// migration that carries a keymap saved under older defaults forward. Shared
// so main can migrate the saved setting before any window reads it.

export const DEFAULT_VIM_KEYMAP = `" Vim mode keys.
" One binding per line: <command> <keys> [<more keys>…]. A command with no
" keys is unbound. Lines starting with " are comments.
"
" Keys: a typed character (Shift is the capital: J is Shift+J), a sequence
" (gg), Ctrl with a letter (<C-l>), or a named key: <CR> <Esc> <Space>
" <Tab> <S-Tab> <BS> <Del> <Up> <Down> <Left> <Right> <Home> <End>
" <PageUp> <PageDown> <F1>…<F12>.
" Keys go by position on the keyboard, so they work in any input language.
"
" Modes, top to bottom:
"   COMMAND  the browser: tabs, panels, app commands
"   BROWSE   the page, as Vimium drives it: scroll, history, find a field
"   INSERT   keys go to the page or the field you type in
" w (or <CR> on a tab) goes COMMAND → BROWSE, i goes on to INSERT. Esc
" climbs back: INSERT → BROWSE, then (when the page has no use for it)
" BROWSE → COMMAND. Ctrl+[ jumps to COMMAND from anywhere. Clicking the
" page is BROWSE (a text field: INSERT), clicking the browser around it is
" COMMAND. The regular shortcuts (⌘T, ⌘L, …) are off while Vim mode is on.

" ── COMMAND: modes and panels ─────────────────────────────────────────
insert-mode         i
browse-mode         w
focus-sidebar       s
focus-bookshelf     b
help                ?

" ── COMMAND: cursor in the focused panel (Sidebar or Bookshelf) ───────
" j/k only move the cursor. <C-j>/<C-k> move it and show the tab it lands
" on, o shows the tab under it — both stay in COMMAND. row-open makes the
" tab under it active and goes into its page (BROWSE), or shows the group.
cursor-down         j <Down>
cursor-up           k <Up>
cursor-down-show    <C-j>
cursor-up-show      <C-k>
cursor-first        gg
cursor-last         G
row-move-down       J
row-move-up         K
row-collapse        h
row-expand          l
row-menu            m
row-close           x
row-show            o
row-open            <CR>

" ── COMMAND: split view ───────────────────────────────────────────────
" S splits the page area with a pane on the right, V with one below, and
" offers the tabs to put there. <C-w> moves the focus to the other pane; q
" ends the split, keeping the focused pane's tab.
split-right         S
split-down          V
split-focus         <C-w>
split-close         q

" ── COMMAND: app commands (the regular shortcuts' ids) ────────────────
new-tab             t
close-tab
reopen-closed-tab   T
close-window
new-workspace       N
next-tab            gt
prev-tab            gT
toggle-sidebar      \\
focus-url           <C-l>
edit-url            e
search              f
command-palette     :
copy-url            y
paste-url           p
paste-url-new-tab   P
back                [
forward             ]
reload              r
settings            ,
page-devtools       I
ui-devtools
find-in-page        /
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

" ── BROWSE: the page ──────────────────────────────────────────────────
" Keys not listed here go to the page. browse-focus-input outlines the
" page's text fields: h/j/k/l (or Tab) pick one, <CR> types into it, Esc
" cancels.
browse-scroll-down        j
browse-scroll-up          k
browse-half-page-down     d
browse-half-page-up       u
browse-top                gg
browse-bottom             G
browse-back               h
browse-forward            l
browse-insert             i
browse-focus-input        gi
browse-close-tab          x
browse-copy-url           y
browse-paste-url          p
browse-paste-url-new-tab  P
browse-focus-url          <C-l>
browse-split-focus        <C-w>
browse-help               ?

" ── Search Everything and the Command Palette ─────────────────────────
" Search Everything opens in COMMAND mode, the Command Palette in INSERT;
" insert-mode (i) drops into the box and Esc comes back out. Esc in
" COMMAND closes the window. The cursor keys above move through the
" results, row-open runs one. The filters are Search Everything's.
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
" The page's address, big, cut into blocks with a key each: p protocol,
" d domain, 1–9 the path's levels, s parameters, f fragment. An intent and
" a block's key act on that block — c changes it (selects it to type
" over), r removes it, y copies it, p pastes over it; y and p on their own
" act on the whole address. <CR> goes there, Shift+<CR> in a new tab; Esc
" leaves typing, then closes.
url-change          c
url-remove          r
url-copy            y
url-paste           p
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
" Opens in INSERT, typing what to find; <CR> / Shift+<CR> step through the
" matches. Esc goes to COMMAND, where these keys step; i types again and
" Esc closes.
find-next           j n
find-prev           k N
`

// ── Migration ──
//
// v2 renamed the WEB mode BROWSE (web-* commands are browse-* now) and
// moved some COMMAND defaults: search p → f, find-in-page f / → /,
// focus-url o → <C-l>, command-palette P : → :, close-tab w → unbound (x
// closes the row under the cursor; w goes into the page). A saved keymap
// keeps every binding its owner changed and takes the new defaults for the
// rest — including commands it couldn't know about.

/** v1 defaults of the commands v2 rebound. */
const V1_DEFAULT_KEYS: Record<string, string> = {
  'close-tab': 'w',
  'focus-url': 'o',
  search: 'p',
  'command-palette': 'P :',
  'find-in-page': 'f /',
}

/** Commands v2 added; a v1 keymap never mentions them. */
const NEW_IN_V2 = new Set([
  'browse-mode',
  'cursor-down-show',
  'cursor-up-show',
  'row-show',
  'copy-url',
  'paste-url',
  'paste-url-new-tab',
  'browse-close-tab',
  'browse-copy-url',
  'browse-paste-url',
  'browse-paste-url-new-tab',
  'browse-focus-url',
  'find-next',
  'find-prev',
  'split-right',
  'split-down',
  'split-focus',
  'split-close',
  'browse-split-focus',
  'edit-url',
  'url-change',
  'url-remove',
  'url-copy',
  'url-paste',
  'url-up',
  'url-site',
  'url-copy-title',
  'url-clear',
  'url-append',
  'url-insert-start',
  'url-insert',
  'url-undo',
  'url-go',
])

/** The v1 name of a command, read as v2's. */
export function renamedVimCommand(command: string): string {
  return command.startsWith('web-') ? `browse-${command.slice(4)}` : command
}

function isBindingLine(trimmed: string): boolean {
  return trimmed !== '' && !trimmed.startsWith('"') && !trimmed.startsWith('#')
}

/**
 * Carries a keymap saved under v1's defaults over to v2's: the v2 default
 * text, with each binding the owner changed (or removed) as they had it.
 * Null when that comes out as the plain default — nothing to keep.
 */
export function migrateVimKeymapV1(saved: string): string | null {
  const mine = new Map<string, string>()
  for (const line of saved.split('\n')) {
    const trimmed = line.trim()
    if (!isBindingLine(trimmed)) continue
    const [command, ...keys] = trimmed.split(/\s+/)
    mine.set(renamedVimCommand(command), keys.join(' '))
  }
  const migrated = DEFAULT_VIM_KEYMAP.split('\n').map((line) => {
    const trimmed = line.trim()
    if (!isBindingLine(trimmed)) return line
    const [command, ...defaults] = trimmed.split(/\s+/)
    if (NEW_IN_V2.has(command)) return line
    // A line the owner deleted is a command they unbound.
    const keys = mine.get(command) ?? ''
    const untouched = V1_DEFAULT_KEYS[command] ?? defaults.join(' ')
    if (keys === untouched) return line
    if (!keys) return command
    const column = /^\S+\s+/.exec(line)?.[0] ?? `${command.padEnd(19)} `
    return column + keys
  }).join('\n')
  return migrated === DEFAULT_VIM_KEYMAP ? null : migrated
}
