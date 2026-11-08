// The keys of a page this window draws in the page area: Downloads, Bangs.
//
// In Vim mode such a page is COMMAND's, as the group page and the Bookshelf
// are: the window's keymap runs on it (lib/vim-mode.ts usePageKeys), and the
// page takes the commands it has a meaning for — the scroll keys move its
// cursor, dd deletes the row, u undoes that, y copies, <C-m> is the row's
// menu, i and / go to its search box. Every other key goes on to the
// window: the o / n / t / d verbs, Ctrl+h/j/k/l, Tab, ;. Keys of the page's
// own (Enter, Space, s for the sort…) it takes only while the window's
// keymap leaves them free: a key some binding starts with is the window's,
// and so is a row label's first letter, or any key while ; has its labels
// up. So a rebind carries over, and the page's hints show what's bound.
//
// Without Vim mode nothing runs the window's keymap, so the page runs its
// table itself: the commands on the default keymap's plain keys (dd, u, j).

import { useEffect, useMemo, useRef } from 'react'
import { KeySequencer, SEQUENCE_JOIN, isCtrlToken, keyTokenFromEvent, type VimKeymap } from '../../../shared/vim-keys'
import { DEFAULT_VIM_KEYMAP } from '../../../shared/vim-default-keymap'
import { displayKeySequence, keysFor, parseVimKeymap } from './vim-keymap'
import { keepsChromeKeyboard, usePageKeys, type PageKeys } from './vim-mode'
import { useWindowVimKeymap } from './window-vim-keymap'
import { hintAlphabet, hintLabels, useHintTargetList } from './hint-labels'
import { chromeHintsActive } from './chrome-hints'

/** A window command the page has a meaning of its own for: `cmd('close-tab')`
 *  — dd deletes the row rather than closing the tab. */
export interface CommandKey {
  readonly command: string
}
export const cmd = (command: string): CommandKey => ({ command })

/** One of an action's keys: a key token of the page's own (`s`, `<CR>`),
 *  taken while the window's keymap leaves it free, or a window command. */
export type PageKey = string | CommandKey

/** Action → its keys, in the order its hints list them. */
export type PageKeyTable<A extends string> = Readonly<Record<A, readonly PageKey[]>>

// Keys no keymap can bind, so never the window's: the menu key, Shift+F10.
const CONTEXT_MENU_KEY = '<ContextMenu>'
const SHIFT_F10_KEY = '<S-F10>'
/** The keyboard's own ways to a context menu, for a page's menu action. */
export const CONTEXT_MENU_KEYS: readonly string[] = [CONTEXT_MENU_KEY, SHIFT_F10_KEY]

/** How a list moves: the window's scroll keys, and the arrows & co. */
export type ListMove = 'down' | 'up' | 'halfDown' | 'halfUp' | 'pageDown' | 'pageUp' | 'first' | 'last'
export const LIST_MOVES: PageKeyTable<ListMove> = {
  down: [cmd('scroll-down'), '<Down>'],
  up: [cmd('scroll-up'), '<Up>'],
  halfDown: [cmd('half-page-down')],
  halfUp: [cmd('half-page-up')],
  pageDown: ['<PageDown>'],
  pageUp: ['<PageUp>'],
  first: [cmd('page-top'), '<Home>'],
  last: [cmd('page-bottom'), '<End>'],
}
// Held down, these keep going; every other action fires once per press.
const REPEATING = new Set<string>(Object.keys(LIST_MOVES))

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>

/** The token a keydown stands for on the page: the keymap's tokens
 *  (shared/vim-keys.ts — by position, so any input language), plus the
 *  menu key and Shift+F10. Null for a chord with Ctrl, Cmd or Alt: those
 *  are the window's. */
export function pageKeyToken(e: KeyLike): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null
  if (e.key === 'ContextMenu') return CONTEXT_MENU_KEY
  if (e.key === 'F10' && e.shiftKey) return SHIFT_F10_KEY
  return keyTokenFromEvent(e)
}

/** The tokens some binding of `keymap` starts with. */
function firstTokens(keymap: VimKeymap): Set<string> {
  const out = new Set<string>()
  for (const seq of keymap.keys()) out.add(seq.split(SEQUENCE_JOIN)[0])
  return out
}

export interface ResolvedPageKeys<A extends string> {
  /** A key of the page's own → its action: only keys `keymap` leaves free. */
  byToken: ReadonlyMap<string, A>
  /** A window command → the page's action for it. */
  byCommand: ReadonlyMap<string, A>
  /** Each action's keys as keycaps read (dd, Enter, ⌃M), in the table's
   *  order; empty when the keymap took them all. */
  caps: Readonly<Record<A, readonly string[]>>
}

/** `table` against the window's keymap: which keys the page may take. */
export function resolvePageKeys<A extends string>(keymap: VimKeymap, table: PageKeyTable<A>): ResolvedPageKeys<A> {
  const taken = firstTokens(keymap)
  const byToken = new Map<string, A>()
  const byCommand = new Map<string, A>()
  const caps = {} as Record<A, string[]>
  for (const action of Object.keys(table) as A[]) {
    const out: string[] = []
    for (const key of table[action]) {
      if (typeof key === 'string') {
        if (taken.has(key) || byToken.has(key)) continue
        byToken.set(key, action)
        if (!CONTEXT_MENU_KEYS.includes(key)) out.push(displayKeySequence(key))
      } else {
        if (!byCommand.has(key.command)) byCommand.set(key.command, action)
        for (const seq of keysFor(keymap, key.command)) out.push(displayKeySequence(seq))
      }
    }
    caps[action] = [...new Set(out)]
  }
  return { byToken, byCommand, caps }
}

let defaultMain: VimKeymap | null = null

/** Without Vim mode: the default keymap's bindings of the commands `table`
 *  takes — plain keys only, as Ctrl chords are the app's shortcuts then. */
export function vimOffKeymap<A extends string>(table: PageKeyTable<A>): VimKeymap {
  if (!defaultMain) defaultMain = parseVimKeymap(DEFAULT_VIM_KEYMAP).main
  const commands = new Set<string>()
  for (const keys of Object.values(table) as Array<readonly PageKey[]>) {
    for (const key of keys) if (typeof key !== 'string') commands.add(key.command)
  }
  const out: VimKeymap = new Map()
  for (const [seq, command] of defaultMain) {
    if (commands.has(command) && !isCtrlToken(seq.split(SEQUENCE_JOIN)[0])) out.set(seq, command)
  }
  return out
}

/** Where a page action came from. */
export interface PageKeySource {
  /** The window command it came as (dd: close-tab); none for a key of the
   *  page's own. */
  command?: string
  /** The keydown, for a key of the page's own. */
  event?: KeyboardEvent
}

/** Runs `action`; false when it doesn't apply now, and the key or the
 *  command goes on to the window (r retries only a failed download). */
export type PageKeyRunner<A extends string> = (action: A, source: PageKeySource) => boolean

/** The page's entry in vim-mode's page-keys stack (usePageKeys). */
export function pageKeyHandlers<A extends string>({ resolved, run, claimedNow, walking }: {
  /** The page's keys against the window's keymap; null while Vim mode is off. */
  resolved: () => ResolvedPageKeys<A> | null
  run: PageKeyRunner<A>
  /** The window takes `token` right now though no binding starts with it:
   *  a row label's first letter, or any key while ; has its labels up. */
  claimedNow: (token: string) => boolean
  /** Ctrl is walking the Sidebar: its keys aren't the page's. */
  walking: () => boolean
}): PageKeys {
  return {
    intercept: (e) => {
      const keys = resolved()
      if (!keys || walking()) return false
      const token = pageKeyToken(e)
      if (!token || claimedNow(token)) return false
      const action = keys.byToken.get(token)
      if (action === undefined) return false
      // Held down, only a move repeats; the rest wait for the next press.
      if (e.repeat && !REPEATING.has(action)) return true
      return run(action, { event: e })
    },
    command: (command) => {
      const keys = resolved()
      if (!keys || walking()) return false
      const action = keys.byCommand.get(command)
      return action !== undefined && run(action, { command })
    },
  }
}

/** Without Vim mode: the page runs its keys itself — its table's commands
 *  on the default keymap's plain keys, sequences (dd, gg) and all, and its
 *  own keys while nothing is pending. `onKey` is true when the page took
 *  the key; `reset` drops a pending one. */
export function vimOffKeyRouter<A extends string>(table: PageKeyTable<A>, run: PageKeyRunner<A>): {
  onKey: (e: KeyboardEvent) => boolean
  reset: () => void
} {
  const keymap = vimOffKeymap(table)
  const resolved = resolvePageKeys(keymap, table)
  let pending = false
  const sequencer = new KeySequencer(
    () => keymap,
    (command, e) => {
      const action = resolved.byCommand.get(command)
      if (action === undefined || (e.repeat && !REPEATING.has(action))) return
      run(action, { command })
    },
    (typed) => { pending = typed !== '' },
  )
  return {
    onKey: (e) => {
      if (!pending) {
        const token = pageKeyToken(e)
        const action = token ? resolved.byToken.get(token) : undefined
        if (action !== undefined) {
          if (e.repeat && !REPEATING.has(action)) return true
          if (run(action, { event: e })) return true
        }
      }
      return sequencer.feed(e)
    },
    reset: () => sequencer.reset(),
  }
}

/** A help row's keys: one action's (`dd, Del`), or two side by side
 *  (`j / k, ↓ / ↑`). */
export function helpKeys<A extends string>(caps: Readonly<Record<A, readonly string[]>>, actions: readonly A[]): string {
  if (actions.length === 1) return caps[actions[0]].join(', ')
  const [a, b] = [caps[actions[0]], caps[actions[1]]]
  const pairs: string[] = []
  for (let i = 0; i < Math.min(a.length, b.length); i++) pairs.push(`${a[i]} / ${b[i]}`)
  return pairs.join(', ')
}

/** A button's tooltip with its key, when it has one: `Delete (dd)`. */
export function titleWithKey(label: string, key: string | undefined): string {
  return key ? `${label} (${key})` : label
}

/** The help's last line in Vim mode: the window's own keys work here too. */
export function windowKeysNote(keymap: VimKeymap): string | null {
  const first = (command: string): string | null => {
    const key = keysFor(keymap, command)[0]
    return key ? displayKeySequence(key) : null
  }
  const parts: string[] = []
  const sidebar = first('toggle-sidebar')
  if (sidebar) parts.push(`${sidebar} shows or hides the Sidebar`)
  const down = first('cursor-down-show')
  const up = first('cursor-up-show')
  if (down && up) parts.push(`${down} / ${up} step through the tabs`)
  const hints = first('chrome-hints')
  if (hints) parts.push(`${hints} labels the buttons`)
  return parts.length > 0 ? `Every other key is the window's, as on any page: ${parts.join(', ')}.` : null
}

/**
 * Hooks a page drawn in the page area up to the keyboard. `table` must be
 * a module constant. In Vim mode the window's COMMAND keys reach the page
 * through usePageKeys; without it the page listens itself, while
 * `ownsKeyboard` says a key is its (focus on it, not in a field).
 */
export function useInternalPageKeys<A extends string>({ table, run, ownsKeyboard }: {
  table: PageKeyTable<A>
  run: PageKeyRunner<A>
  ownsKeyboard: (e: KeyboardEvent) => boolean
}): {
  /** Vim mode is on: the keys are the window keymap's. */
  vim: boolean
  /** The window's COMMAND keymap; null while Vim mode is off. */
  keymap: VimKeymap | null
  caps: Readonly<Record<A, readonly string[]>>
  /** An action's first key as its cap reads, for a hint or a tooltip. */
  key: (action: A) => string | undefined
} {
  const parsed = useWindowVimKeymap()
  const keymap = parsed?.main ?? null
  const offKeymap = useMemo(() => vimOffKeymap(table), [table])
  const resolved = useMemo(() => resolvePageKeys(keymap ?? offKeymap, table), [keymap, offKeymap, table])

  // The first letters of the labels the window's rows wear now (the
  // Bookshelf's, while it has the keys): App numbers them the same way.
  const targets = useHintTargetList()
  const labelLetters = useMemo(
    () => new Set(keymap ? hintLabels(targets.length, hintAlphabet(keymap)).map((label) => label[0]) : []),
    [keymap, targets],
  )

  const runRef = useRef(run)
  runRef.current = run
  const ownsRef = useRef(ownsKeyboard)
  ownsRef.current = ownsKeyboard
  const resolvedRef = useRef(resolved)
  resolvedRef.current = resolved
  const vimRef = useRef(keymap !== null)
  vimRef.current = keymap !== null
  const labelLettersRef = useRef(labelLetters)
  labelLettersRef.current = labelLetters

  const handlers = useMemo(() => pageKeyHandlers<A>({
    resolved: () => (vimRef.current ? resolvedRef.current : null),
    run: (action, source) => runRef.current(action, source),
    claimedNow: (token) => chromeHintsActive() || labelLettersRef.current.has(token),
    walking: keepsChromeKeyboard,
  }), [])
  usePageKeys(handlers)

  // Without Vim mode: the page's own listener (vimOffKeyRouter).
  useEffect(() => {
    const router = vimOffKeyRouter(table, (action, source) => runRef.current(action, source))
    const onKeyDown = (e: KeyboardEvent): void => {
      if (vimRef.current || e.defaultPrevented) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!ownsRef.current(e)) {
        router.reset()
        return
      }
      if (!router.onKey(e)) return
      e.preventDefault()
      // Keeps App's global Escape and other window listeners out of it.
      e.stopPropagation()
    }
    // A pending key (the first d of dd) waits however long, as Vim mode's
    // does: a click, or the window losing the keys, drops it.
    const dropPending = (): void => router.reset()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', dropPending)
    window.addEventListener('mousedown', dropPending, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', dropPending)
      window.removeEventListener('mousedown', dropPending, true)
      router.reset()
    }
  }, [table])

  return {
    vim: keymap !== null,
    keymap,
    caps: resolved.caps,
    key: (action) => resolved.caps[action][0],
  }
}
