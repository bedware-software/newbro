import { useCallback, useEffect, useRef, useState } from 'react'
import { keyTokenFromEvent, matchKeys, type PanelCommand, type VimKeymap } from './vim-keymap'
import { log } from './log'

// Vim mode: the window is either in COMMAND mode — the browser chrome holds
// the keyboard and plain keys run the commands from Settings' keymap — or in
// INSERT mode — keys go where you type: the page, the URL bar, a rename box.
// The mode follows keyboard focus: clicking the page or a text field means
// INSERT, clicking the chrome or Esc on a page that doesn't use it means
// COMMAND. In COMMAND mode a block cursor sits in one panel (Sidebar or
// Bookshelf); each panel decides what a cursor command means for its rows.

export type VimMode = 'command' | 'insert'
export type VimPanel = 'sidebar' | 'bookshelf'

// Window-wide flag read by WebviewPanel: in COMMAND mode activating a tab
// (j/k switch tabs live) must not hand OS keyboard focus to the page, or the
// next keystroke would go to the site instead of the command keys. Set
// synchronously with the React state so an activation in the same render as
// the mode change already sees it.
let commandModeActive = false

export function isCommandMode(): boolean {
  return commandModeActive
}

// How long the next key of a sequence (gg, gt) may trail the previous one —
// vim's default timeoutlen.
const SEQUENCE_TIMEOUT_MS = 1000
// How long after we pull keyboard focus back to the renderer it is still
// settling. When a popup (context menu, Search) hides, the OS hands focus
// back to the window, where the active tab's view may claim it a beat after
// we asked for the renderer — a page focus inside this window is that
// handoff, not the user clicking into the page, so we take focus back
// instead of switching to INSERT. Taking it back only succeeds while our
// window is the focused one, so a dialog opened from a menu keeps its focus.
const FOCUS_SETTLE_MS = 300
// Commands that keep going while their key is held.
const REPEATABLE = new Set(['cursor-down', 'cursor-up', 'row-move-down', 'row-move-up'])

let settleUntil = 0

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

/** Where keys are INSERT-mode keys: a text field, or a page this renderer
 *  draws itself (marked `data-vim-page`, e.g. Downloads) with keys of its own. */
function isInsertTarget(target: EventTarget | null): boolean {
  return isEditable(target) || (target instanceof HTMLElement && target.closest('[data-vim-page]') !== null)
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
      if (!document.hasFocus()) window.electronAPI?.reclaimWindowRendererFocus?.()
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
  const tokensRef = useRef<string[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keymapRef = useRef(keymap)
  keymapRef.current = keymap
  const commandRef = useRef(onCommand)
  commandRef.current = onCommand

  const reset = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    tokensRef.current = []
    setPending('')
  }, [])

  useEffect(() => reset, [reset])

  const feed = useCallback((e: KeyboardEvent): boolean => {
    const token = keyTokenFromEvent(e)
    if (!token) return false
    const map = keymapRef.current
    if (token === '<Esc>' && tokensRef.current.length > 0) {
      reset()
      return true
    }
    const resolve = (tokens: string[]): boolean => {
      const match = matchKeys(map, tokens)
      if (match.kind === 'command') {
        reset()
        // Holding j/k (or J/K) keeps going; anything else fires once per press.
        if (!e.repeat || REPEATABLE.has(match.command)) commandRef.current(match.command)
        return true
      }
      if (match.kind === 'pending') {
        if (e.repeat) return true
        if (timerRef.current) clearTimeout(timerRef.current)
        tokensRef.current = tokens
        setPending(tokens.join(''))
        timerRef.current = setTimeout(reset, SEQUENCE_TIMEOUT_MS)
        return true
      }
      return false
    }
    if (resolve([...tokensRef.current, token])) return true
    // Not a continuation: drop what was pending and try the key on its own.
    const hadPending = tokensRef.current.length > 0
    reset()
    return resolve([token]) || hadPending
  }, [reset])

  return { pending, feed, reset }
}

// ── The main window's mode ──

interface Options {
  enabled: boolean
  keymap: VimKeymap
  /** A command from the keymap: an app action id or a vim command. */
  onCommand: (command: string) => void
  /** Hand the keyboard to the page (INSERT). False when there is no page to
   *  type into, e.g. while parked on a group. */
  focusPage: () => boolean
  /** True while Esc from the page must not switch modes (it just left a
   *  fullscreen video). */
  ignorePageEscape: () => boolean
}

export interface VimModeState {
  /** Null while Vim mode is off. */
  mode: VimMode | null
  /** Keys typed so far of an unfinished sequence (vim's showcmd). */
  pending: string
  enterCommand: (force: boolean) => void
  enterInsert: () => void
}

export function useVimMode({ enabled, keymap, onCommand, focusPage, ignorePageEscape }: Options): VimModeState {
  const [mode, setModeState] = useState<VimMode | null>(null)
  const modeRef = useRef<VimMode | null>(null)
  const setMode = useCallback((next: VimMode | null, why: string) => {
    if (modeRef.current !== next) log.event('vim:mode', next ?? 'off', why)
    modeRef.current = next
    commandModeActive = next === 'command'
    setModeState(next)
  }, [])

  const onCommandRef = useRef(onCommand)
  onCommandRef.current = onCommand
  const { pending, feed, reset } = useKeySequence(keymap, (command) => onCommandRef.current(command))
  const focusPageRef = useRef(focusPage)
  focusPageRef.current = focusPage
  const ignoreEscapeRef = useRef(ignorePageEscape)
  ignoreEscapeRef.current = ignorePageEscape

  const enterCommand = useCallback((force: boolean) => {
    if (modeRef.current === null) return
    // Otherwise taking focus back would land in the URL bar (or whatever
    // chrome field had it before the page did), which is INSERT again.
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused !== document.body) focused.blur()
    setMode('command', 'enter-command')
    claimRendererFocus(force)
  }, [setMode])

  const enterInsert = useCallback(() => {
    if (modeRef.current === null) return
    settleUntil = 0
    // Clear the flag first: focusPage may activate a tab, which must now
    // take the keyboard.
    const previous = modeRef.current
    setMode('insert', 'enter-insert')
    if (!focusPageRef.current()) setMode(previous, 'no page to insert into')
  }, [setMode])

  // Vim mode starts in COMMAND, like vim. Not forced: of several windows
  // restored at launch only the focused one takes the keyboard.
  useEffect(() => {
    if (!enabled) {
      setMode(null, 'disabled')
      reset()
      return
    }
    setMode(isInsertTarget(document.activeElement) ? 'insert' : 'command', 'enabled')
    if (modeRef.current === 'command') claimRendererFocus(false)
  }, [enabled, setMode, reset])

  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (e: KeyboardEvent): void => {
      if (modeRef.current !== 'command') return
      // Typing into a chrome field (URL bar, rename) stays typing; Ctrl/Alt/
      // Cmd chords stay app shortcuts (main handles the bound ones).
      if (isInsertTarget(e.target)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
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
      setMode(isInsertTarget(document.activeElement) ? 'insert' : 'command', 'renderer focus')
    }
    const onWindowFocus = (): void => { setTimeout(syncWithFocus, 0) }
    const onFocusIn = (e: FocusEvent): void => {
      if (isInsertTarget(e.target)) setMode('insert', 'field focus')
      else syncWithFocus()
    }
    // Leaving a text field for nothing (Esc, Enter in a rename) is COMMAND;
    // leaving it for the page is the page's focus event's to decide.
    const onFocusOut = (e: FocusEvent): void => {
      if (!isInsertTarget(e.target) || e.relatedTarget) return
      setTimeout(syncWithFocus, 0)
    }

    const cleanupTabEvents = window.electronAPI.onTabEvent?.((raw) => {
      const evt = raw as { type?: string; tabId?: string }
      if (evt.type === 'focus') {
        if (modeRef.current === 'command' && Date.now() < settleUntil) {
          window.electronAPI.reclaimWindowRendererFocus?.()
          return
        }
        reset()
        setMode('insert', 'page focus')
      } else if (evt.type === 'unhandled-escape') {
        if (modeRef.current !== 'insert') return
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

  return { mode, pending, enterCommand, enterInsert }
}
