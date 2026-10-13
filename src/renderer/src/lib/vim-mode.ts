import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeySequencer, isCtrlToken, keyTokenFromEvent, type VimKeymap, type VimKeymapEntries } from '../../../shared/vim-keys'
import type { PanelCommand } from './vim-keymap'
import { log } from './log'

// Vim mode. A window is in one of three modes:
//   COMMAND — the browser chrome holds the keyboard; plain keys run the
//             commands from Settings' keymap. A block cursor sits in one
//             panel (Sidebar or Bookshelf); each panel decides what a cursor
//             command means for its rows.
//   BROWSE  — the page holds the keyboard and the page's preload
//             (webview-stealth.ts) runs the browse-* keys, the way Vimium
//             did: scrolling, history, picking a text field. Other keys
//             reach the page.
//   INSERT  — keys go where you type: a page field, the page itself (i),
//             the URL bar, a rename box.
// Clicking the chrome is COMMAND, clicking the page BROWSE (a field: INSERT).
// Esc climbs INSERT → BROWSE → COMMAND. This module holds the window's mode
// and tells main, which passes it on to the pages.

export type VimMode = 'command' | 'browse' | 'insert'
export type VimPanel = 'sidebar' | 'bookshelf'

// Window-wide flag read by WebviewPanel: in COMMAND mode activating a tab
// (Ctrl+J/K and o show tabs live) must not hand OS keyboard focus to the
// page, or the next keystroke would go to the site instead of the command
// keys. Set synchronously with the React state so an activation in the same
// render as the mode change already sees it.
let commandModeActive = false

export function isCommandMode(): boolean {
  return commandModeActive
}

// How long after we pull keyboard focus back to the renderer it is still
// settling. When a popup (context menu, Search) hides, the OS hands focus
// back to the window, where the active tab's view may claim it a beat after
// we asked for the renderer — a page focus inside this window is that
// handoff, not the user clicking into the page, so we take focus back
// instead of switching modes. Taking it back only succeeds while our window
// is the focused one, so a dialog opened from a menu keeps its focus.
const FOCUS_SETTLE_MS = 300
// Commands that keep going while their key is held.
const REPEATABLE = new Set([
  'cursor-down', 'cursor-up', 'cursor-down-show', 'cursor-up-show', 'row-move-down', 'row-move-up',
  'find-next', 'find-prev',
])

// App commands a page's BROWSE keys may ask for (browse-close-tab & co.).
const PAGE_COMMANDS = new Set(['close-tab', 'copy-url', 'paste-url', 'paste-url-new-tab', 'focus-url', 'split-focus'])

let settleUntil = 0
// Until when focus arriving in the renderer is the OS handing it back after
// a popup we opened from the page (help) — the page should get it, not
// COMMAND.
let returnToPageUntil = 0

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

/** The mode keyboard focus on `target` in this renderer stands for: a text
 *  field is INSERT, a page this renderer draws itself (marked
 *  `data-vim-page`, e.g. Downloads — it has keys of its own) is BROWSE, the
 *  rest of the chrome is COMMAND. */
function modeForRendererFocus(target: EventTarget | null): VimMode {
  if (isEditable(target)) return 'insert'
  if (target instanceof HTMLElement && target.closest('[data-vim-page]') !== null) return 'browse'
  return 'command'
}

/** Move OS keyboard focus to this renderer, retrying while a popup hide or
 *  tab view is still pulling it away. `force` takes it even from another
 *  window — right for a hotkey, which only reaches us while ours is in use. */
export function claimRendererFocus(force: boolean): void {
  if (force) window.electronAPI?.focusWindowRenderer?.()
  else window.electronAPI?.reclaimWindowRendererFocus?.()
  settleUntil = Date.now() + FOCUS_SETTLE_MS
  for (const delay of [60, 180]) {
    setTimeout(() => {
      // Only for COMMAND: a w pressed meanwhile gave the keyboard to the page.
      if (commandModeActive && !document.hasFocus()) window.electronAPI?.reclaimWindowRendererFocus?.()
    }, delay)
  }
}

// ── Panels ──

const panelHandlers = new Map<VimPanel, (cmd: PanelCommand) => void>()

/** Runs a cursor command in `panel`; false when the panel isn't listening
 *  (hidden, or not the one with the cursor). */
export function dispatchPanelCommand(panel: VimPanel, cmd: PanelCommand): boolean {
  const handler = panelHandlers.get(panel)
  if (!handler) return false
  handler(cmd)
  return true
}

/**
 * Hooks a panel up to COMMAND mode: while `active` its rows get the cursor
 * commands. Wrap keyboard-opened context menus in the returned `runMenu` so
 * focus comes back to the renderer once the menu popup closes.
 */
export function useVimPanel(
  panel: VimPanel,
  active: boolean,
  onCommand: (cmd: PanelCommand) => void,
): { runMenu: <T>(open: () => Promise<T>) => Promise<T> } {
  const commandRef = useRef(onCommand)
  commandRef.current = onCommand

  useEffect(() => {
    if (!active) return
    const handler = (cmd: PanelCommand): void => commandRef.current(cmd)
    panelHandlers.set(panel, handler)
    return () => {
      if (panelHandlers.get(panel) === handler) panelHandlers.delete(panel)
    }
  }, [panel, active])

  const runMenu = useCallback(async <T,>(open: () => Promise<T>): Promise<T> => {
    try {
      return await open()
    } finally {
      // Not forced: if the menu's action opened a dialog window, it keeps focus.
      if (commandModeActive) claimRendererFocus(false)
    }
  }, [])

  return { runMenu }
}

// ── Key sequences ──

/**
 * Collects key tokens into sequences and resolves them against a keymap.
 * `feed` returns true when the key belongs to vim (a command ran or a
 * sequence is pending), so the caller can swallow it.
 */
export function useKeySequence(
  keymap: VimKeymap,
  onCommand: (command: string) => void,
): { pending: string; feed: (e: KeyboardEvent) => boolean; reset: () => void } {
  const [pending, setPending] = useState('')
  const keymapRef = useRef(keymap)
  keymapRef.current = keymap
  const commandRef = useRef(onCommand)
  commandRef.current = onCommand

  const sequencer = useMemo(() => new KeySequencer(
    () => keymapRef.current,
    (command, e) => {
      // Holding j/k (or J/K) keeps going; anything else fires once per press.
      if (!e.repeat || REPEATABLE.has(command)) commandRef.current(command)
    },
    setPending,
  ), [])

  const reset = useCallback(() => sequencer.reset(), [sequencer])
  useEffect(() => reset, [reset])
  const feed = useCallback((e: KeyboardEvent) => sequencer.feed(e), [sequencer])

  return { pending, feed, reset }
}

/**
 * A popup's own COMMAND / INSERT pair (Search Everything, the Command
 * Palette, Find in Page): INSERT while its box has focus, COMMAND otherwise,
 * where plain keys run `keymap`. Null while Vim mode is off. Wire the box's
 * focus and blur to `onBoxFocus` / `onBoxBlur`; keys typed outside the box
 * arrive on the popup's window, which `popup` names.
 */
export function usePopupVimMode({ keymap, popup, box, initial, open, onCommand, onEscape, intercept }: {
  /** Null while Vim mode is off. */
  keymap: VimKeymap | null
  popup: Window | null
  box: React.RefObject<HTMLInputElement | null>
  initial: 'command' | 'insert'
  open: boolean
  onCommand: (command: string) => void
  /** Esc in COMMAND: usually closes the popup. */
  onEscape: () => void
  /** Sees each COMMAND-mode key first; true when it took the key (the
   *  address editor's block key after c / r / y / p). */
  intercept?: (e: KeyboardEvent) => boolean
}): {
  mode: VimMode | null
  modeRef: React.RefObject<VimMode | null>
  pending: string
  onBoxFocus: () => void
  onBoxBlur: () => void
} {
  const [mode, setMode] = useState<VimMode | null>(null)
  const modeRef = useRef<VimMode | null>(null)
  modeRef.current = mode
  const { pending, feed, reset } = useKeySequence(keymap ?? NO_KEYMAP, onCommand)
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape
  const interceptRef = useRef(intercept)
  interceptRef.current = intercept

  useEffect(() => {
    if (!open) return
    setMode(keymap ? initial : null)
    // Only on opening: the mode is the user's from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // The box isn't focused in COMMAND mode, so keys land on the popup's body
  // — outside React's tree — and are read off its window.
  useEffect(() => {
    if (!popup || !mode) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (modeRef.current !== 'command' || e.target === box.current) return
      if (e.metaKey || e.altKey) return
      if (interceptRef.current?.(e)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      const token = keyTokenFromEvent(e)
      if (e.ctrlKey && !(token && isCtrlToken(token))) return
      if (feed(e)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') onEscapeRef.current()
    }
    popup.addEventListener('keydown', onKeyDown, true)
    return () => popup.removeEventListener('keydown', onKeyDown, true)
  }, [popup, mode, feed, box])

  const onBoxFocus = useCallback(() => {
    if (!modeRef.current) return
    reset()
    setMode('insert')
  }, [reset])
  const onBoxBlur = useCallback(() => {
    if (modeRef.current) setMode('command')
  }, [])

  return { mode, modeRef, pending, onBoxFocus, onBoxBlur }
}

const NO_KEYMAP: VimKeymap = new Map()

// ── The main window's mode ──

interface Options {
  enabled: boolean
  keymap: VimKeymap
  /** BROWSE mode's keys, handed to the pages. */
  browseKeymap: VimKeymap
  /** A command from the keymap: an app action id or a vim command. Also an
   *  app command a page's BROWSE key asked for (browse-close-tab). */
  onCommand: (command: string) => void
  /** Hand the keyboard to the active tab's page. False when there is no
   *  page to go to, e.g. while parked on a group. */
  focusPage: () => boolean
  isActiveTab: (tabId: string) => boolean
  /** True while Esc from the page must not switch modes (it just left a
   *  fullscreen video). */
  ignorePageEscape: () => boolean
  /** browse-help (?) pressed in the page. */
  onHelp: () => void
}

export interface VimModeState {
  /** Null while Vim mode is off. */
  mode: VimMode | null
  /** Keys typed so far of an unfinished sequence (vim's showcmd). */
  pending: string
  enterCommand: (force: boolean) => void
  /** Into the active tab's page, in BROWSE mode. */
  enterBrowse: () => void
  /** Into the active tab's page, in INSERT mode — keys reach the page. */
  enterInsert: () => void
  /** Back into the page after a popup opened from it closes: focus the OS
   *  gives the renderer meanwhile goes on to the page. */
  returnToPage: () => void
}

export function useVimMode({ enabled, keymap, browseKeymap, onCommand, focusPage, isActiveTab, ignorePageEscape, onHelp }: Options): VimModeState {
  const [mode, setModeState] = useState<VimMode | null>(null)
  const modeRef = useRef<VimMode | null>(null)
  // INSERT in a chrome field (URL bar, rename) rather than in the page.
  const insertInChromeRef = useRef(false)
  const setMode = useCallback((next: VimMode | null, why: string, inChrome = false) => {
    if (modeRef.current !== next) log.event('vim:mode', next ?? 'off', why)
    modeRef.current = next
    insertInChromeRef.current = next === 'insert' && inChrome
    commandModeActive = next === 'command'
    setModeState(next)
  }, [])

  const onCommandRef = useRef(onCommand)
  onCommandRef.current = onCommand
  const { pending, feed, reset } = useKeySequence(keymap, (command) => onCommandRef.current(command))
  const focusPageRef = useRef(focusPage)
  focusPageRef.current = focusPage
  const isActiveTabRef = useRef(isActiveTab)
  isActiveTabRef.current = isActiveTab
  const ignoreEscapeRef = useRef(ignorePageEscape)
  ignoreEscapeRef.current = ignorePageEscape
  const onHelpRef = useRef(onHelp)
  onHelpRef.current = onHelp

  const enterCommand = useCallback((force: boolean) => {
    if (modeRef.current === null) return
    // Otherwise taking focus back would land in the URL bar (or whatever
    // chrome field had it before the page did), which is INSERT again.
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused !== document.body) focused.blur()
    setMode('command', 'enter-command')
    claimRendererFocus(force)
  }, [setMode])

  const enterPage = useCallback((next: 'browse' | 'insert') => {
    if (modeRef.current === null) return
    settleUntil = 0
    // Set first: focusPage may activate a tab, which must now take the
    // keyboard, and the page must learn its mode before keys arrive.
    const previous = modeRef.current
    setMode(next, `enter-${next}`)
    if (!focusPageRef.current()) setMode(previous, 'no page to go to')
  }, [setMode])
  const enterBrowse = useCallback(() => enterPage('browse'), [enterPage])
  const enterInsert = useCallback(() => enterPage('insert'), [enterPage])
  const returnToPage = useCallback(() => {
    returnToPageUntil = Date.now() + FOCUS_SETTLE_MS
    enterPage('browse')
  }, [enterPage])

  // Vim mode starts in COMMAND, like vim. Not forced: of several windows
  // restored at launch only the focused one takes the keyboard.
  useEffect(() => {
    if (!enabled) {
      setMode(null, 'disabled')
      reset()
      return
    }
    const initial = modeForRendererFocus(document.activeElement)
    setMode(initial, 'enabled', initial === 'insert')
    if (modeRef.current === 'command') claimRendererFocus(false)
  }, [enabled, setMode, reset])

  // Pages run BROWSE mode themselves: main hands them the mode and the keys.
  const browseEntries = useMemo<VimKeymapEntries>(() => [...browseKeymap], [browseKeymap])
  useEffect(() => {
    window.electronAPI.vimSetState?.({ mode, browseKeymap: browseEntries })
  }, [mode, browseEntries])

  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (e: KeyboardEvent): void => {
      if (modeRef.current !== 'command') return
      // Typing into a chrome field (URL bar, rename) stays typing, and a
      // page this renderer draws keeps its own keys.
      if (modeForRendererFocus(e.target) !== 'command') return
      if (e.metaKey || e.altKey) return
      if (e.ctrlKey) {
        // Ctrl with a letter is a Vim key when the keymap binds it (<C-l>);
        // other Ctrl chords go on as they would.
        const token = keyTokenFromEvent(e)
        if (token && isCtrlToken(token) && feed(e)) {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }
      // COMMAND mode owns every plain key — an unbound one must not reach a
      // focused toolbar button (Enter/Space) or move focus (Tab) either.
      // Capture phase on window, so App's global Escape handler and any row
      // handlers never see it.
      e.preventDefault()
      e.stopPropagation()
      feed(e)
    }

    // A click into the chrome (or the window coming back with the chrome
    // focused) is COMMAND; a text field taking focus is INSERT.
    const syncWithFocus = (): void => {
      if (!document.hasFocus()) return
      const next = modeForRendererFocus(document.activeElement)
      if (next === 'command' && Date.now() < returnToPageUntil && modeRef.current === 'browse') {
        focusPageRef.current()
        return
      }
      setMode(next, 'renderer focus', next === 'insert')
    }
    const onWindowFocus = (): void => { setTimeout(syncWithFocus, 0) }
    const onFocusIn = (e: FocusEvent): void => {
      const next = modeForRendererFocus(e.target)
      if (next !== 'command') setMode(next, 'field focus', next === 'insert')
      else syncWithFocus()
    }
    // Leaving a text field for nothing (Esc, Enter in a rename) is COMMAND;
    // leaving it for the page is the page's focus event's to decide.
    const onFocusOut = (e: FocusEvent): void => {
      if (modeForRendererFocus(e.target) === 'command' || e.relatedTarget) return
      setTimeout(syncWithFocus, 0)
    }

    const cleanupTabEvents = window.electronAPI.onTabEvent?.((raw) => {
      const evt = raw as { type?: string; tabId?: string; byUser?: boolean; mode?: VimMode; why?: string; command?: string }
      if (!evt.tabId || !isActiveTabRef.current(evt.tabId)) return
      if (evt.type === 'focus') {
        if (evt.byUser) {
          // A click into the page. A field it lands in makes the page
          // report INSERT right after.
          reset()
          setMode('browse', 'page click')
          return
        }
        // The page took focus on its own — a reload, a load finishing, the
        // OS handing it back after a popup. COMMAND keeps the keyboard;
        // from a chrome field the keys did move to the page, which is BROWSE.
        if (modeRef.current === 'command') {
          claimRendererFocus(false)
        } else if (modeRef.current === 'insert' && insertInChromeRef.current) {
          setMode('browse', 'page focus')
        }
      } else if (evt.type === 'vim' && (evt.mode === 'browse' || evt.mode === 'insert')) {
        // The page moved itself along: i, a field focused or left, Esc.
        if (modeRef.current !== 'command') setMode(evt.mode, `page: ${evt.why ?? ''}`)
      } else if (evt.type === 'vim-command') {
        if (evt.command && PAGE_COMMANDS.has(evt.command)) onCommandRef.current(evt.command)
      } else if (evt.type === 'vim-help') {
        onHelpRef.current()
      } else if (evt.type === 'unhandled-escape') {
        if (modeRef.current !== 'browse') return
        if (ignoreEscapeRef.current()) {
          log.event('vim:page-escape ignored (fullscreen)')
          return
        }
        enterCommand(true)
      }
    })

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      cleanupTabEvents?.()
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [enabled, feed, reset, setMode, enterCommand])

  return { mode, pending, enterCommand, enterBrowse, enterInsert, returnToPage }
}
