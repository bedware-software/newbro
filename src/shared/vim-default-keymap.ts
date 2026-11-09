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
" to COMMAND. In a popup — Search Everything, Find, the address editor, a
" dialog — Ctrl+C or Ctrl+[ leaves its field for COMMAND, and Esc closes the
" popup. Clicking a text field is INSERT, anywhere else COMMAND. The
" browser's commands are these keys, not ⌘T or ⌘L; the system's copy,
" paste and undo work as ever.
"
" COMMAND reads like vim. The motions are vim's: j/k scroll, <C-d>/<C-u>
" half a page, gg/G to the top and the bottom, h/l back and forward. A
" letter that starts a pair is a verb, and the second letter says what it
" acts on:
"   n  new       nt (or nn) a tab, ng a group, nw a workspace, np a profile
"   d  delete    dd closes the tab, dg its group, dw deletes the workspace
"   o  open      ot ow og op search tabs, workspaces, groups, profiles;
"                od Downloads, ob Bangs, om the menu, and the rest below
"   t  toggle    ts the Sidebar, tb the Bookshelf
" u undoes: it brings back what dd or dg closed. Ctrl+h/j/k/l drive the
" Sidebar, and Tab shows or hides it.

" ── COMMAND: the page ─────────────────────────────────────────────────
" focus-input outlines the page's text fields: h/j/k/l (or Tab) pick one,
" <CR> types into it, Esc cancels. + and - zoom the page, = back to its
" actual size.
scroll-down         j
scroll-up           k
half-page-down      <C-d>
half-page-up        <C-u>
page-top            gg
page-bottom         G
back                h <C-o>
forward             l <C-i>
insert-mode         i
focus-input         gi
help                ?
zoom-in             +
zoom-out            -
zoom-reset          =

" ── COMMAND: the Sidebar ──────────────────────────────────────────────
" Ctrl+j/k step through its rows, showing each — a tab's page, or a
" group's tabs — with the keyboard kept in the browser until Ctrl is let
" go, when the page shown gets it. Ctrl+h folds the group the cursor is in
" and goes to its header; Ctrl+l unfolds a folded group, or steps into an
" unfolded one. They work with the Sidebar hidden too. Tab (or ts) shows
" or hides it; in a text field Tab moves on through the form as ever.
" While it's shown, each row wears a label of one to three letters (the
" more rows, the longer) — typing one shows that row — and m opens the
" menu of the row the cursor is on.
cursor-down-show    <C-j>
cursor-up-show      <C-k>
row-move-down       <C-S-j>
row-move-up         <C-S-k>
row-fold            <C-h>
row-unfold          <C-l>
row-menu            m
toggle-sidebar      <Tab> ts

" ── COMMAND: split view ───────────────────────────────────────────────
" V splits the page area with a pane on the right (vim's :vsplit), S with
" one below (:split), and offers the tabs to put there. <C-w> moves the focus to the other pane; q
" ends the split, keeping the focused pane's tab.
split-right         V
split-down          S
split-focus         <C-w>
split-close         q

" ── COMMAND: n, new ───────────────────────────────────────────────────
" A new group comes with a new tab in it; a new profile and a new
" workspace open in a window of their own. Each asks for a name first.
" nn is a new tab too: the verb doubled, as dd closes one.
new-tab             nt nn
new-group           ng
new-workspace       nw
new-profile         np

" ── COMMAND: d, delete ────────────────────────────────────────────────
" dd closes the tab and dg its group, all its tabs; u brings them back,
" the last closed first. dw deletes the workspace, once you say so.
close-tab           dd
close-group         dg
delete-workspace    dw
reopen-closed-tab   u

" ── COMMAND: o, open ──────────────────────────────────────────────────
" ot ow og op open Search Everything on one kind of thing, typing (INSERT);
" Ctrl+C goes to its COMMAND keys. The menus open with the keyboard on them:
" om the app's menu, oe extensions, oi the site's padlock, oD dark pages,
" oP and oW the toolbar's profile and workspace lists.
pick-tab            ot
pick-workspace      ow
pick-group          og
pick-profile        op
open-downloads      od
open-bangs          ob
app-menu            om
extensions-menu     oe
site-info           oi
dark-pages-menu     oD
profile-menu        oP
workspace-menu      oW

" ── COMMAND: t, toggle ────────────────────────────────────────────────
" ts is the Sidebar's (above); tb shows or hides the Bookshelf.
toggle-bookshelf    tb

" ── COMMAND: app commands (the regular shortcuts' ids) ────────────────
" ; labels every button of the browser's own, as f does a page's in
" vimium; typing a label presses it. search opens Search Everything on the
" kind of thing it showed last (ot ow og op on one kind).
chrome-hints        ;
close-window
next-tab
prev-tab
focus-url
edit-url            e
search
command-palette     <C-p>
copy-url            y
paste-url
paste-url-new-tab   P
reload              r
settings            ,
page-devtools       I
ui-devtools
find-in-page        /
save-page
tab-1
tab-2
tab-3
tab-4
tab-5
tab-6
tab-7
tab-8
tab-9
duplicate-tab
move-tab
set-comment         gcc
remove-comment
add-to-new-group
ungroup-tab
rename-tab-group
move-group
duplicate-group
ungroup-all-tabs
expand-all-groups
collapse-all-groups
add-to-bookshelf    nb
rename-workspace
close-workspace
import-workspaces
export-workspaces
rename-profile
delete-profile
" Dark pages: D turns them on or off for this site; dark-pages everywhere.
dark-pages
dark-pages-site     D
dark-pages-settings
manage-extensions
check-updates
install-update
about
minimize-window
maximize-window
restore-window
quit

" ── Search Everything and the Command Palette ─────────────────────────
" Search Everything and the Command Palette open in INSERT; Ctrl+C goes to
" COMMAND, and insert-mode (i) drops back into the box. Esc closes the
" window, from either. The scroll keys above (j/k, gg/G) move through
" the results, Enter runs one. Search Everything shows one kind of thing,
" the one ot / ow / og / op opened it on; in COMMAND p w g t switch to
" profiles, workspaces, groups, tabs.
" In COMMAND every result wears a label of one to three letters (the more
" results, the longer), drawn from its name where these keys leave the
" letters free, and typing it picks the result (vimium's hints); typing in
" the box, digits type. So does the group page. search-row-N picks result
" N, when bound.
search-profiles     p
search-workspaces   w
search-groups       g
search-tabs         t
search-scope        <Tab>
search-row-1
search-row-2
search-row-3
search-row-4
search-row-5
search-row-6
search-row-7
search-row-8
search-row-9

" ── Address editor (e) ───────────────────────────────────────────────
" Opens typing (INSERT) over the whole address, selected, as other
" browsers' address bars do; Ctrl+C goes to its COMMAND keys.
" The page's title, and its address big, cut into blocks with a key each:
" h protocol, d domain, n port, 1–9 the path's levels, p parameters,
" f fragment. An intent and a block's key act on that block — c changes it
" (selects it to type over), d removes it, y copies it, p pastes over it.
" A block key wins over the intent's own key — dd is the domain, pp the
" parameters — so yy and cc act on the whole address, D removes all of it,
" P pastes over all of it and C clears it to type; yt copies the title.
" gu goes up a level, gt keeps only the site; u undoes, <C-r> redoes.
" <CR> goes there, Shift+<CR> in a new tab; Esc closes, typing or not.
url-change          c
url-remove          d
url-remove-all      D
url-copy            y
url-paste           p
url-paste-all       P
url-up              gu
url-site            gt
url-copy-title
url-clear           C
url-append          A
url-insert-start    I
url-insert          i
url-undo            u
url-redo            <C-r>
url-go              <CR>

" ── Find in page ──────────────────────────────────────────────────────
" Opens in INSERT, only for typing what to find (the first match lights up
" as you type). <CR> or Ctrl+C goes to COMMAND, where these keys step
" through the matches; i types again. Esc closes, from either.
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
// next-tab and prev-tab, whose keys those took. v7 swapped the splits to
// vim's (V side by side, S one above the other) and put row-unfold on <C-l>,
// with row-fold only folding, and set-comment on gcc. v8 made the address
// editor's keys vim's: u undoes (was U) and <C-r> redoes, up a level and the
// site went behind g (gu, gt), the title's copy behind y (yt, was n), and
// removing onto d (was r), D removing the whole address. v9 left results
// to two-letter labels in COMMAND, unbinding the digits of search-row-N. v10
// took the Sidebar off Ctrl held (it flashed on every Ctrl chord) and onto
// the arrows, history onto <C-o>/<C-i> (was [ and ]), the Command Palette
// onto <C-p> (was :) and toggling the Sidebar onto <Space> (was \). v11
// put the browser's own pages behind o: od Downloads (was D), ob Bangs.
// v12 added dark pages (D this site). v13 made COMMAND read like vim's:
// half a page on <C-d>/<C-u> (was d/u), the Sidebar back on Ctrl chords
// (<C-j>/<C-k>/<C-h>/<C-l>, was the arrows) and toggled by <Tab> or ts (was
// <Space>), and verbs as prefixes — n new (nt, was <CR>; nv, was N; ng and
// np new), d delete (dd, was x; dg and dv new), o open (ot ow op, were t w
// p; og, the menus), t toggle (tb, was B) — with u reopening a closed tab
// (was T); it also listed the palette's commands, unbound, so they can be
// bound. v14 put a new workspace on nw (was nv: w is a workspace, as in ow
// and oW) and gave a new tab nn beside nt. v15 put deleting the workspace
// on dw (was dv), w as in nw and ow; labelled the Sidebar's rows, so the
// tab numbers lost <C-1>…<C-9> (unbound now), and put the row's menu on m
// (was <C-m>), live while the Sidebar is shown. v16 left Search Everything
// on everything unbound (was f): what COMMAND opens goes through o. v17
// dropped Search Everything's All filter (search-all, a) and moved its
// filters onto Ctrl+1–4 (were p w g t); and it put adding the page to the
// Bookshelf on nb (n new, as nt and ng). v18 put the filters back on p w g
// t, the letters they're named by. A saved
// keymap keeps every binding its owner changed — unless it now clashes with
// another binding, then it takes the new default — and the new defaults for
// the rest, including commands it couldn't know about. A key a version
// brings in that the owner's own binding already uses stays the owner's:
// the command it's new for goes without it (unbound, if it was its only
// one). A command v13 to v15 moved that loses all its new keys that way keeps its
// old key instead, when nothing uses that now — x still closes the tab for
// an owner whose own d took dd's place; one v13 added has no old key and
// goes unbound. And a line the owner changed that kept a moved command's
// old default beside keys of their own (`half-page-down d <C-d>`) keeps
// their keys, with the new default in place of the old one, so the old d
// doesn't take dd, dg and dw's place.

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

/** Commands a later keymap dropped: a saved line naming one is ignored.
 *  search-all (v17): Search Everything shows one kind of thing. */
const RETIRED_COMMANDS = new Set(['search-all'])

/** The current name of a command written under an older keymap (web-*,
 *  browse-*), or null for one that's gone. Any other name comes back as is. */
export function renamedVimCommand(command: string): string | null {
  if (RETIRED_COMMANDS.has(command)) return null
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

/** v6 defaults of the commands v7 rebound. */
const V6_DEFAULT_KEYS: Record<string, string> = {
  'split-right': 'S',
  'split-down': 'V',
}

/** v9 defaults of the commands v10 rebound. */
const V9_DEFAULT_KEYS: Record<string, string> = {
  back: 'h [',
  forward: 'l ]',
  'cursor-down-show': '<C-j>',
  'cursor-up-show': '<C-k>',
  'row-fold': '<C-h>',
  'row-unfold': '<C-l>',
  'toggle-sidebar': '\\',
  'command-palette': ':',
}

/** v10 defaults of the commands v11 rebound. */
const V10_DEFAULT_KEYS: Record<string, string> = {
  'open-downloads': 'D',
}

/** v12 defaults of the commands v13 rebound. */
const V12_DEFAULT_KEYS: Record<string, string> = {
  'half-page-down': 'd',
  'half-page-up': 'u',
  'cursor-down-show': '<Down>',
  'cursor-up-show': '<Up>',
  'row-fold': '<Left>',
  'row-unfold': '<Right>',
  'new-tab': '<CR>',
  'new-workspace': 'N',
  'close-tab': 'x',
  'reopen-closed-tab': 'T',
  'pick-workspace': 'w',
  'pick-tab': 't',
  'pick-group': '',
  'pick-profile': 'p',
  'toggle-sidebar': '<Space>',
  'toggle-bookshelf': 'B',
}

/** v13 defaults of the commands v14 rebound. */
const V13_DEFAULT_KEYS: Record<string, string> = {
  'new-tab': 'nt',
  'new-workspace': 'nv',
}

/** v14 defaults of the commands v15 rebound: the tab numbers, on Ctrl
 *  since v4, and the row menu, on <C-m> since v3. */
const V14_DEFAULT_KEYS: Record<string, string> = {
  'delete-workspace': 'dv',
  'row-menu': '<C-m>',
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tab-${n}`, `<C-${n}>`])),
}

/** v17 defaults of the commands v18 rebound: Search Everything's filters,
 *  back on p w g t. */
const V17_DEFAULT_KEYS: Record<string, string> = {
  'search-profiles': '<C-1>',
  'search-workspaces': '<C-2>',
  'search-groups': '<C-3>',
  'search-tabs': '<C-4>',
}

/** v16 defaults of the commands v17 rebound: Search Everything's filters
 *  (on Ctrl+1–4 in v17, back on their letters since v18) and the
 *  Bookshelf's add. */
const V16_DEFAULT_KEYS: Record<string, string> = {
  // Unbound till v17, which put it on nb (n, new: a new reading).
  'add-to-bookshelf': '',
  'search-profiles': 'p',
  'search-workspaces': 'w',
  'search-groups': 'g',
  'search-tabs': 't',
}

/** v15 defaults of the commands v16 rebound: Search Everything on
 *  everything, unbound now — an owner who kept f loses it, one who chose a
 *  key of their own keeps that. */
const V15_DEFAULT_KEYS: Record<string, string> = {
  search: 'f',
}

/** Old keys a moved command never falls back to: Enter makes no tab. */
const NO_FALLBACK_KEYS: Record<string, string[]> = {
  'new-tab': ['<CR>'],
}

/** v8 defaults of the commands v9 rebound: the results' digits. */
const V8_DEFAULT_KEYS: Record<string, string> = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`search-row-${n}`, String(n)]),
)

/** v7 defaults of the commands v8 rebound. */
const V7_DEFAULT_KEYS: Record<string, string> = {
  'url-remove': 'r',
  'url-up': 'u',
  'url-site': 't',
  'url-copy-title': 'n',
  'url-undo': 'U',
}

/** Commands v6 added; no older keymap mentions them. */
const NEW_IN_V6 = new Set(['pick-workspace', 'pick-tab', 'pick-group', 'pick-profile'])

/** Commands v7 added. */
const NEW_IN_V7 = new Set(['row-unfold', 'set-comment', 'remove-comment'])

/** Commands v8 added. */
const NEW_IN_V8 = new Set(['url-redo', 'url-remove-all'])

/** Commands v11 added to the keymap. */
const NEW_IN_V11 = new Set(['open-bangs'])

/** Commands v12 added. A default key of theirs that an owner's own binding
 *  already uses stays the owner's: the new command goes unbound. */
const NEW_IN_V12 = new Set(['dark-pages', 'dark-pages-site'])

/** Commands v13 added: new ones, and the Command Palette's that had no line
 *  (delete-workspace and the unbound ones). Their keys yield to an owner's
 *  as v12's do. */
const NEW_IN_V13 = new Set([
  'new-group', 'new-profile', 'close-group', 'delete-workspace',
  'app-menu', 'extensions-menu', 'site-info', 'dark-pages-menu', 'profile-menu', 'workspace-menu',
  'chrome-hints', 'zoom-in', 'zoom-out', 'zoom-reset',
  'check-updates', 'install-update', 'manage-extensions',
  'rename-workspace', 'close-workspace', 'import-workspaces', 'export-workspaces',
  'rename-profile', 'delete-profile', 'ungroup-tab', 'ungroup-all-tabs', 'add-to-new-group',
  'expand-all-groups', 'collapse-all-groups', 'dark-pages-settings',
  'about', 'quit', 'minimize-window', 'maximize-window', 'restore-window',
])

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

/** Whether two written sequences are the same keys (`<cr>` is `<CR>`). */
function sameKeys(a: string, b: string): boolean {
  return keyTokens(a).join('\u0000') === keyTokens(b).join('\u0000')
}

/**
 * Carries a keymap saved under older defaults (v1 to v17) over to the
 * current ones: the default text, with each binding the owner changed (or
 * removed) as they had it. Null when that comes out as the plain default —
 * nothing to keep. `log` hears each key the migration had to decide on for
 * the owner: a command that keeps its old key, one left unbound, an old
 * default moved on.
 */
export function migrateVimKeymap(
  saved: string,
  fromVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17,
  log: (message: string) => void = () => {},
): string | null {
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
    (fromVersion <= 5 ? V5_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 6 ? V6_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 7 ? V7_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 8 ? V8_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 9 ? V9_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 10 ? V10_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 12 ? V12_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 13 ? V13_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 14 ? V14_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 15 ? V15_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 16 ? V16_DEFAULT_KEYS[command] : undefined) ??
    (fromVersion <= 17 ? V17_DEFAULT_KEYS[command] : undefined) ??
    fallback
  // Whether the saved keymap's version had the command: one it lacks isn't
  // missing because its owner unbound it.
  const existed = (command: string): boolean =>
    (fromVersion <= 12 && NEW_IN_V13.has(command)) || (fromVersion <= 11 && NEW_IN_V12.has(command)) || (fromVersion <= 10 && NEW_IN_V11.has(command)) || (fromVersion <= 7 && NEW_IN_V8.has(command)) || (fromVersion <= 6 && NEW_IN_V7.has(command)) || (fromVersion <= 5 && NEW_IN_V6.has(command)) ? false
    : fromVersion >= 3
      ? !(command in RENAMED_IN_V3)
      : !NEW_IN_V3.has(command) && !(fromVersion === 1 && NEW_IN_V2.has(command))
  // The old commands that make up each current one: itself, and what was
  // renamed or merged into it.
  const sourcesOf = (command: string): string[] => [
    command,
    ...Object.keys(RENAMED_IN_V3).filter((old) => RENAMED_IN_V3[old] === command),
  ].filter(existed)

  // Commands v13 to v18 moved off their old keys.
  const movedInV13 = (command: string): boolean =>
    (fromVersion <= 12 && command in V12_DEFAULT_KEYS) || (fromVersion <= 13 && command in V13_DEFAULT_KEYS) ||
    // Only where the saved keymap had it: v13 added delete-workspace, so an
    // older one never had dv to keep.
    (fromVersion <= 14 && command in V14_DEFAULT_KEYS && existed(command)) ||
    (fromVersion <= 15 && command in V15_DEFAULT_KEYS) ||
    (fromVersion <= 16 && command in V16_DEFAULT_KEYS) ||
    (fromVersion <= 17 && command in V17_DEFAULT_KEYS)

  const lines = DEFAULT_VIM_KEYMAP.split('\n')
  // command → [line index, keys] for every binding line, as it stands.
  const bindings = new Map<string, { index: number; keys: string[] }>()
  const changed: string[] = []
  // The command of `among`, other than `command` and in its context, whose
  // binding already uses `key` (or starts it, or is started by it); null for
  // none.
  const takenBy = (key: string, command: string, among: Iterable<string>): string | null => {
    for (const other of among) {
      if (other === command || contextOf(other) !== contextOf(command)) continue
      if (bindings.get(other)!.keys.some((k) => sequencesClash(key, k))) return other
    }
    return null
  }
  // Owner-changed lines of moved commands that kept the old default beside
  // keys of their own: those keys, which go with the new default.
  const keptOldDefault = new Map<string, string[]>()
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!isBindingLine(trimmed)) return
    const [command, ...defaults] = trimmed.split(/\s+/)
    bindings.set(command, { index, keys: defaults })
    // The owner's keys over all of its sources, against those sources' old
    // defaults: equal is untouched.
    let touched = false
    const ownKeys: string[] = []
    // The sources' old default keys the new default dropped.
    const oldKeys: string[] = []
    for (const source of sourcesOf(command)) {
      const before = oldDefault(source, defaults.join(' '))
      // A line the owner deleted is a command they unbound.
      const theirs = mine.get(source) ?? ''
      if (theirs !== before) touched = true
      for (const key of theirs.split(' ')) if (key && !ownKeys.includes(key)) ownKeys.push(key)
      for (const key of before.split(' ')) if (key && !defaults.some((d) => sameKeys(d, key))) oldKeys.push(key)
    }
    if (!touched) return
    if (movedInV13(command)) {
      // A key that's the old default isn't the owner's choice but the
      // default they kept, beside keys of their own: it moves on with the
      // default.
      const theirOwn = ownKeys.filter((key) => !oldKeys.some((old) => sameKeys(old, key)))
      if (theirOwn.length < ownKeys.length) {
        // Nothing of their own (the old key twice): untouched, as it were.
        if (theirOwn.length === 0) return
        keptOldDefault.set(command, theirOwn)
        bindings.set(command, { index, keys: theirOwn })
        changed.push(command)
        return
      }
    }
    bindings.set(command, { index, keys: ownKeys })
    changed.push(command)
  })

  // The owner's own bindings, before the new keys yield to them.
  const owned = new Set(changed)
  // A moved command whose line kept its old default gets the new default
  // instead, where no key of the owner's own uses it.
  for (const [command, theirOwn] of keptOldDefault) {
    const binding = bindings.get(command)!
    const defaults = lines[binding.index].trim().split(/\s+/).slice(1)
    // Not one of theirs, nor started by one of theirs or starting one (their
    // n beside nt would clash on the line itself).
    const free = defaults.filter((key) => !theirOwn.some((k) => sequencesClash(k, key)) && takenBy(key, command, owned) === null)
    binding.keys = [...free, ...theirOwn]
    log(`${command}: your line kept its old default beside your ${theirOwn.join(' ')}; now ${binding.keys.join(' ')}`)
  }

  // Keys this step brings in: those of commands new since the saved
  // keymap's version, and the new keys of commands it moved. Where the owner
  // never touched such a command, a key of its that one of the owner's own
  // bindings already uses (or starts, or is started by) stays the owner's:
  // the command goes without it, unbound if it was its only one.
  const bringsKeys = new Set([
    ...(fromVersion <= 12 ? NEW_IN_V13 : []),
    ...(fromVersion <= 11 ? NEW_IN_V12 : []),
    ...(fromVersion <= 12 ? Object.keys(V12_DEFAULT_KEYS) : []),
    ...(fromVersion <= 13 ? Object.keys(V13_DEFAULT_KEYS) : []),
    ...(fromVersion <= 14 ? Object.keys(V14_DEFAULT_KEYS) : []),
    ...(fromVersion <= 16 ? Object.keys(V16_DEFAULT_KEYS) : []),
    ...(fromVersion <= 17 ? Object.keys(V17_DEFAULT_KEYS) : []),
  ])
  // Commands that lost every key that way, with what took them ("dd (your
  // d, half-page-down)").
  const keyless: Array<{ command: string; lost: string }> = []
  for (const command of bringsKeys) {
    if (owned.has(command)) continue
    const fresh = bindings.get(command)
    if (!fresh || fresh.keys.length === 0) continue
    const free = fresh.keys.filter((key) => takenBy(key, command, owned) === null)
    if (free.length === fresh.keys.length) continue
    if (free.length === 0) {
      const lost = fresh.keys.map((key) => {
        const other = takenBy(key, command, owned)!
        return `${key} (your ${bindings.get(other)!.keys.join(' ')}, ${other})`
      })
      keyless.push({ command, lost: lost.join(', ') })
    }
    fresh.keys = free
    changed.push(command)
  }

  // An owner's binding that clashes with another in its context goes back
  // to the default.
  for (const command of changed) {
    if (!owned.has(command)) continue
    const own = bindings.get(command)!
    const clashes = own.keys.some((key) => takenBy(key, command, bindings.keys()) !== null)
    if (!clashes) continue
    const line = lines[own.index].trim().split(/\s+/)
    own.keys = line.slice(1)
  }

  // A command v13 to v15 moved that lost all its new keys to the owner's
  // keeps its old one — x for close-tab, T for reopen-closed-tab, B for
  // toggle-bookshelf, nv for new-workspace, dv for delete-workspace, <C-m>
  // for row-menu — where nothing in its context
  // uses that now; never <CR> for new-tab: Enter makes no tab. The keys it had at the saved keymap's version first, then
  // v12's (a v9 keymap migrated straight to v13 never had v10's <Down>, but
  // would have got it on the way). A command v13 added has no old key.
  for (const { command, lost } of keyless) {
    const binding = bindings.get(command)!
    const free = (keys: string[]): string[] => {
      const out: string[] = []
      for (const key of keys) {
        if (key && !out.some((k) => sequencesClash(k, key)) && takenBy(key, command, bindings.keys()) === null) out.push(key)
      }
      return out
    }
    // Its new keys are free again when the binding that took them clashed
    // elsewhere and went back to the default.
    const again = free(lines[binding.index].trim().split(/\s+/).slice(1))
    if (again.length > 0) {
      binding.keys = again
      continue
    }
    if (movedInV13(command)) {
      const never = NO_FALLBACK_KEYS[command] ?? []
      const usable = (keys: string): string[] => free(keys.split(' ').filter((key) => !never.some((k) => sameKeys(k, key))))
      const old = usable(oldDefault(command, ''))
      binding.keys = old.length > 0 ? old : usable(V12_DEFAULT_KEYS[command] ?? '')
    } else binding.keys = []
    log(binding.keys.length > 0
      ? `${command}: its new key is taken — ${lost}; keeps its old ${binding.keys.join(' ')}`
      : `${command}: its new key is taken — ${lost}; left unbound`)
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
