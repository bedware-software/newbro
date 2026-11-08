import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeySequencer, isCtrlToken, keyTokenFromEvent, type VimKeymap, type VimKeymapEntries } from '../../../shared/vim-keys'
import type { SidebarCommand } from './vim-keymap'
import { log } from './log'

// Vim mode. A window is in one of two modes:
//   COMMAND — plain keys run the commands from Settings' keymap: scrolling
//             the page, history, tabs, app commands. Mostly the page has the
//             keyboard: its preload (webview-stealth.ts) runs the page's
//             keys, the way Vimium does, passes the browser's commands on
//             here and lets unbound keys reach the page. The chrome has it
//             only with no page to go to, or while Ctrl steps through the
//             tabs; this module passes the page's keys on to the page then.
//   INSERT  — keys go where you type: a page field, the page itself (i),
//             the URL bar, a rename box.
// Clicking a text field is INSERT, anywhere else COMMAND; Esc (or Ctrl+[)
// leaves INSERT. A Sidebar key in COMMAND (Ctrl+J/K step through the rows,
// Ctrl+H/L fold and unfold) is the Sidebar's turn: a cursor on the active
// row — with the keyboard kept in the chrome, so a page's text field can't
// take it on the way — until Ctrl is let go, which hands it to the page
// shown (one rebound to a plain key ends after a pause instead). Ctrl alone
// does nothing, so its other chords never flash the cursor.
// This module holds the window's mode and tells main, which passes it on to
// the pages.

export type VimMode = 'command' | 'insert'

// Set while the Sidebar keys step through the tabs: activating a tab then must not hand
// OS keyboard focus to its page (WebviewPanel), or the next keystroke would
// go to the site — or a field of it — instead of the Sidebar's keys.
let walkingTabs = false

export function keepsChromeKeyboard(): boolean {
  return walkingTabs
}

// With no Ctrl held (a plain key a Sidebar command is rebound to), how long
// the Sidebar keys stay live after the last one.
const WALK_IDLE_MS = 1000
// Commands that keep going while their key is held.
const REPEATABLE = new Set([
  'scroll-down', 'scroll-up', 'half-page-down', 'half-page-up',
  'cursor-down-show', 'cursor-up-show', 'row-move-down', 'row-move-up',
  'cursor-down', 'cursor-up', 'find-next', 'find-prev',
  // Settings' h / l (H / L): a slider keeps sliding.
  'value-next', 'value-prev', 'value-next-big', 'value-prev-big',
])

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

// Inputs whose keys type text — not a checkbox, a slider or a button.
const TYPING_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number'])

/** A field keys type into: a text input, a textarea, something editable.
 *  By its tag rather than instanceof, which fails for a popup's elements —
 *  a DetachedWindow's content belongs to that window's realm, whose
 *  HTMLElement isn't this one's. */
export function isTypingElement(target: unknown): boolean {
  const el = target as { nodeType?: number; tagName?: string; type?: unknown; isContentEditable?: boolean } | null
  if (!el || el.nodeType !== 1) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName !== 'INPUT') return false
  return TYPING_INPUT_TYPES.has(typeof el.type === 'string' ? el.type.toLowerCase() : '')
}

/** A page this renderer draws itself (marked `data-vim-page`, e.g.
 *  Downloads): it has keys of its own, the way a tab's page does. */
function isInternalPage(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('[data-vim-page]') !== null
}

/** The mode keyboard focus on `target` in this renderer stands for: a text
 *  field is INSERT, and so is a page this renderer draws (Downloads, Bangs)
 *  — its own keys (j/k through its rows) are the page's, as a web page's are
 *  in INSERT; the rest COMMAND. */
function modeForRendererFocus(target: EventTarget | null): VimMode {
  return isEditable(target) || isInternalPage(target) ? 'insert' : 'command'
}

/** INSERT in the chrome (a URL bar, a rename) rather than in a page. */
function isChromeField(target: EventTarget | null): boolean {
  return isEditable(target) && !isInternalPage(target)
}

/** Move OS keyboard focus to this renderer, retrying while a tab view is
 *  still pulling it away. `force` takes it even from another window — right
 *  for a hotkey, which only reaches us while ours is in use. */
function claimRendererFocus(force: boolean): void {
  if (force) window.electronAPI?.focusWindowRenderer?.()
  else window.electronAPI?.reclaimWindowRendererFocus?.()
  for (const delay of [60, 180]) {
    setTimeout(() => {
      if (walkingTabs && !document.hasFocus()) window.electronAPI?.reclaimWindowRendererFocus?.()
    }, delay)
  }
}

// ── The Sidebar ──

let sidebarHandler: ((cmd: SidebarCommand) => void) | null = null
// Ends the Sidebar keys (useVimMode's), for a row menu that swallowed the
// Ctrl release.
let endSidebarKeysHook: (() => void) | null = null

/** Runs a Sidebar command on the row under its cursor; false when no
 *  Sidebar is showing to take it. */
export function dispatchSidebarCommand(cmd: SidebarCommand): boolean {
  if (!sidebarHandler) return false
  sidebarHandler(cmd)
  return true
}

/**
 * Hooks a Sidebar up to its Ctrl commands while `active`. Wrap
 * keyboard-opened context menus in the returned `runMenu`: a native menu
 * keeps the Ctrl release from us, so its closing ends the Sidebar keys.
 */
export function useVimSidebar(
  active: boolean,
  onCommand: (cmd: SidebarCommand) => void,
): { runMenu: <T>(open: () => Promise<T>) => Promise<T> } {
  const commandRef = useRef(onCommand)
  commandRef.current = onCommand

  useEffect(() => {
    if (!active) return
    const handler = (cmd: SidebarCommand): void => commandRef.current(cmd)
    sidebarHandler = handler
    return () => {
      if (sidebarHandler === handler) sidebarHandler = null
    }
  }, [active])

  const runMenu = useCallback(async <T,>(open: () => Promise<T>): Promise<T> => {
    try {
      return await open()
    } finally {
      endSidebarKeysHook?.()
    }
  }, [])

  return { runMenu }
}

// ── A page drawn in the page's place ──
//
// The group page (a tab group parked on, its tabs in the page area) has no
// tab view to run COMMAND's keys, so it takes them here: the keymap's
// commands it knows (j/k move through its tabs, i types in its filter), and
// a few keys of its own ahead of the keymap (a digit, Enter). So do a page
// load's error over the page (r tries again), and the Bookshelf while it
// has the keyboard — over the group page, as the one mounted last.

export interface PageKeys {
  /** A key ahead of the keymap; true when the page took it. */
  intercept: (e: KeyboardEvent) => boolean
  /** A COMMAND command; true when the page took it. */
  command: (command: string) => boolean
}

// The one mounted last first; a key or command it doesn't take goes on to
// the one before.
const pageKeysStack: PageKeys[] = []

/** Runs a COMMAND command on the page drawn in the page's place; false when
 *  there's none or it doesn't take the command. */
export function dispatchPageCommand(command: string): boolean {
  for (let i = pageKeysStack.length - 1; i >= 0; i--) if (pageKeysStack[i].command(command)) return true
  return false
}

function interceptPageKey(e: KeyboardEvent): boolean {
  for (let i = pageKeysStack.length - 1; i >= 0; i--) if (pageKeysStack[i].intercept(e)) return true
  return false
}

/** Hooks a page drawn in the page's place up to COMMAND's keys while it's
 *  mounted. */
export function usePageKeys(keys: PageKeys): void {
  const keysRef = useRef(keys)
  keysRef.current = keys
  useEffect(() => {
    const handler: PageKeys = {
      intercept: (e) => keysRef.current.intercept(e),
      command: (command) => keysRef.current.command(command),
    }
    pageKeysStack.push(handler)
    return () => {
      const at = pageKeysStack.indexOf(handler)
      if (at !== -1) pageKeysStack.splice(at, 1)
    }
  }, [])
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
      // Holding j/k (or Ctrl+J/K) keeps going; anything else fires once per press.
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
 *
 * A form (Settings) has many fields: with `anyField`, any text field taking
 * the keyboard is INSERT and leaving it COMMAND, no wiring needed, and Esc
 * or Ctrl+[ in one comes back to COMMAND, the field letting go.
 */
export function usePopupVimMode({ keymap, popup, box, initial, open, onCommand, onEscape, intercept, anyField = false, passThrough }: {
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
  /** INSERT whenever any text field in the popup has the keyboard. */
  anyField?: boolean
  /** True while the keys are the popup's own, not Vim's (a shortcut being
   *  recorded): each goes on as it would, COMMAND or not. */
  passThrough?: () => boolean
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
  const passThroughRef = useRef(passThrough)
  passThroughRef.current = passThrough
  // Ahead of the render, so a key right after a field took (or let go of)
  // the keyboard already finds the new mode.
  const switchMode = useCallback((next: VimMode) => {
    modeRef.current = next
    setMode(next)
  }, [])

  useEffect(() => {
    if (!open) return
    setMode(keymap ? initial : null)
    // Only on opening: the mode is the user's from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // A form's fields: one taking the keyboard is INSERT, one letting go of it
  // for anything but another field COMMAND.
  const active = mode !== null
  useEffect(() => {
    if (!popup || !anyField || !active) return
    const doc = popup.document
    const onFocusIn = (e: FocusEvent): void => {
      if (!isTypingElement(e.target)) return
      reset()
      switchMode('insert')
    }
    const onFocusOut = (e: FocusEvent): void => {
      if (!isTypingElement(e.target) || isTypingElement(e.relatedTarget)) return
      switchMode('command')
    }
    // A field that had the keyboard before this was listening.
    if (isTypingElement(doc.activeElement)) switchMode('insert')
    doc.addEventListener('focusin', onFocusIn)
    doc.addEventListener('focusout', onFocusOut)
    return () => {
      doc.removeEventListener('focusin', onFocusIn)
      doc.removeEventListener('focusout', onFocusOut)
    }
  }, [popup, anyField, active, reset, switchMode])

  // The box isn't focused in COMMAND mode, so keys land on the popup's body
  // — outside React's tree — and are read off its window.
  useEffect(() => {
    if (!popup || !mode) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (passThroughRef.current?.()) return
      if (anyField && modeRef.current === 'insert') {
        const focused = popup.document.activeElement
        // The field went away under the keyboard (a form closing) without
        // telling: COMMAND, this key and all.
        if (!isTypingElement(focused)) switchMode('command')
        else {
          const ctrlBracket = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'BracketLeft'
          if ((e.key === 'Escape' || ctrlBracket) && !e.isComposing) {
            e.preventDefault()
            e.stopPropagation()
            ;(focused as HTMLElement).blur()
          }
          return
        }
      }
      if (modeRef.current !== 'command' || e.target === box.current) return
      if (anyField && isTypingElement(e.target)) return
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
  }, [popup, mode, feed, box, anyField, switchMode])

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
  /** A command from the keymap: an app action id, a Sidebar command or a
   *  vim command — also one the page's keys asked for. */
  onCommand: (command: string) => void
  /** Hand the keyboard to the active tab's page, for `mode`. False when there
   *  is no page to go to, e.g. while parked on a group — or, in COMMAND, a
   *  page this renderer draws, which lets go of the keys: the window keeps
   *  them for COMMAND's. */
  focusPage: (mode: VimMode) => boolean
  isActiveTab: (tabId: string) => boolean
}

export interface VimModeState {
  /** Null while Vim mode is off. */
  mode: VimMode | null
  /** INSERT in a chrome field (the address bar, a rename in the Sidebar)
   *  rather than in a page. */
  insertInChrome: boolean
  /** Keys typed so far of an unfinished sequence (vim's showcmd). */
  pending: string
  /** A Sidebar command just ran in COMMAND, and Ctrl is still held (or,
   *  rebound to a plain key, a pause hasn't passed): the Sidebar's keys are
   *  live — a cursor on the active row. */
  sidebarKeys: boolean
  /** COMMAND, in the active tab's page when there is one. */
  enterCommand: (force: boolean) => void
  /** Into the active tab's page, in INSERT mode — keys reach the page. */
  enterInsert: () => void
  /** A Sidebar command is about to run: its keys stay live, with the
   *  keyboard in the chrome, until Ctrl is let go. */
  startTabWalk: () => void
  /** A popup closed: in COMMAND the page gets the keyboard back — unless
   *  what the popup did put it in a chrome field. */
  returnToPage: () => void
  /** The Sidebar keys end now, the walk's idle wait and all. */
  endSidebarKeys: () => void
}

export function useVimMode({ enabled, keymap, onCommand, focusPage, isActiveTab }: Options): VimModeState {
  const [mode, setModeState] = useState<VimMode | null>(null)
  const modeRef = useRef<VimMode | null>(null)
  // INSERT in a chrome field (URL bar, rename) rather than in the page. The
  // state is for the window (Settings' Hide the Sidebar in INSERT leaves a
  // chrome field's INSERT be), the ref for the handlers here.
  const insertInChromeRef = useRef(false)
  const [insertInChrome, setInsertInChrome] = useState(false)
  const [sidebarKeys, setSidebarKeys] = useState(false)
  const ctrlDownRef = useRef(false)
  const walkIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // What the pages get (main passes it on): the mode, COMMAND's keys, and a
  // count of trips out of INSERT on purpose (Ctrl+[), each of which makes a
  // page's focused field let go. Sent as the mode changes, not after the
  // render, so a page learns it before it's handed the keyboard.
  const keymapEntriesRef = useRef<VimKeymapEntries>([])
  const leaveInsertRef = useRef(0)
  const pushState = useCallback(() => {
    window.electronAPI.vimSetState?.({ mode: modeRef.current, keymap: keymapEntriesRef.current, leaveInsert: leaveInsertRef.current })
  }, [])

  const onCommandRef = useRef(onCommand)
  onCommandRef.current = onCommand
  const { pending: chromePending, feed, reset } = useKeySequence(keymap, (command) => onCommandRef.current(command))
  // An unfinished sequence typed in the active page, which runs COMMAND's
  // keys itself.
  const [pagePending, setPagePending] = useState('')
  const pending = chromePending || pagePending
  const pendingRef = useRef(chromePending)
  pendingRef.current = chromePending
  const focusPageRef = useRef(focusPage)
  focusPageRef.current = focusPage
  const isActiveTabRef = useRef(isActiveTab)
  isActiveTabRef.current = isActiveTab

  const clearCtrlTimers = useCallback(() => {
    if (walkIdleTimerRef.current) clearTimeout(walkIdleTimerRef.current)
    walkIdleTimerRef.current = null
  }, [])

  /** The Sidebar keys end: a pause after the last one, Ctrl let go after a
   *  Ctrl chord one (or the window lost it). The tab the walk stopped on
   *  gets the keyboard. */
  const endSidebarKeys = useCallback(() => {
    clearCtrlTimers()
    setSidebarKeys(false)
    if (!walkingTabs) return
    walkingTabs = false
    log.event('vim:tab walk', 'end')
    if (modeRef.current === 'command') focusPageRef.current('command')
  }, [clearCtrlTimers])

  useEffect(() => {
    endSidebarKeysHook = endSidebarKeys
    return () => {
      if (endSidebarKeysHook === endSidebarKeys) endSidebarKeysHook = null
    }
  }, [endSidebarKeys])

  const setMode = useCallback((next: VimMode | null, why: string, inChrome = false) => {
    const changed = modeRef.current !== next
    if (changed) log.event('vim:mode', next ?? 'off', why)
    modeRef.current = next
    insertInChromeRef.current = next === 'insert' && inChrome
    setInsertInChrome(insertInChromeRef.current)
    setModeState(next)
    if (changed) pushState()
    if (next !== 'command') {
      // The Sidebar keys are COMMAND's.
      walkingTabs = false
      clearCtrlTimers()
      setSidebarKeys(false)
    }
  }, [clearCtrlTimers, pushState])

  const enterCommand = useCallback((force: boolean) => {
    if (modeRef.current === null) return
    // A chrome field (the URL bar) lets go of the keys, and so does the
    // page's field: this is a trip out of INSERT on purpose.
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused !== document.body) focused.blur()
    leaveInsertRef.current++
    // Set first: the page must learn its mode before it gets the keys.
    setMode('command', 'enter-command')
    pushState()
    if (walkingTabs || !focusPageRef.current('command')) claimRendererFocus(force)
  }, [setMode, pushState])

  const enterInsert = useCallback(() => {
    if (modeRef.current === null) return
    walkingTabs = false
    // Set first: focusPage may activate a tab, which must now take the
    // keyboard, and the page must learn its mode before keys arrive.
    const previous = modeRef.current
    setMode('insert', 'enter-insert')
    if (!focusPageRef.current('insert')) setMode(previous, 'no page to go to')
  }, [setMode])

  const returnToPage = useCallback(() => {
    if (modeRef.current !== 'command' || walkingTabs || isEditable(document.activeElement)) return
    focusPageRef.current('command')
  }, [])

  const startTabWalk = useCallback(() => {
    if (modeRef.current !== 'command') return
    clearCtrlTimers()
    setSidebarKeys(true)
    if (!walkingTabs) {
      walkingTabs = true
      log.event('vim:tab walk', 'start')
      claimRendererFocus(true)
    }
    // A plain key a Sidebar command was rebound to: no Ctrl release will
    // end it.
    if (!ctrlDownRef.current) walkIdleTimerRef.current = setTimeout(endSidebarKeys, WALK_IDLE_MS)
  }, [clearCtrlTimers, endSidebarKeys])

  // Vim mode starts in COMMAND, like vim. Not forced: of several windows
  // restored at launch only the focused one takes the keyboard.
  useEffect(() => {
    if (!enabled) {
      setMode(null, 'disabled')
      reset()
      return
    }
    const initial = modeForRendererFocus(document.activeElement)
    setMode(initial, 'enabled', isChromeField(document.activeElement))
    if (initial === 'command' && document.hasFocus()) focusPageRef.current('command')
  }, [enabled, setMode, reset])

  // Pages run COMMAND's keys themselves.
  useEffect(() => {
    keymapEntriesRef.current = [...keymap]
    pushState()
  }, [keymap, pushState])

  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (e: KeyboardEvent): void => {
      if (modeRef.current !== 'command') return
      // Typing into a chrome field (URL bar, rename) stays typing.
      if (isEditable(e.target)) return
      if (e.metaKey || e.altKey) return
      if (e.ctrlKey) {
        // Ctrl with a letter is a Vim key when the keymap binds it (<C-j>);
        // other Ctrl chords go on as they would.
        const token = keyTokenFromEvent(e)
        if (token && isCtrlToken(token) && feed(e)) {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }
      // A page this renderer draws keeps its own plain keys.
      if (isInternalPage(e.target)) return
      // One drawn in the page's place takes some ahead of the keymap.
      if (!pendingRef.current && interceptPageKey(e)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      // COMMAND mode owns every plain key in the chrome — an unbound one
      // must not reach a focused toolbar button (Enter/Space) or move focus
      // (Tab) either. Capture phase on window, so App's global Escape
      // handler and any row handlers never see it.
      e.preventDefault()
      e.stopPropagation()
      feed(e)
    }

    // A text field taking focus is INSERT; the chrome taking it otherwise
    // (a click on it, the window coming back) is COMMAND, here in the
    // chrome — not handed on to the page, which would take it from under a
    // double-click that opens a rename box.
    const syncWithFocus = (): void => {
      if (!document.hasFocus()) return
      const next = modeForRendererFocus(document.activeElement)
      setMode(next, 'renderer focus', isChromeField(document.activeElement))
    }
    const onWindowFocus = (): void => { setTimeout(syncWithFocus, 0) }
    const onFocusIn = (e: FocusEvent): void => {
      if (isEditable(e.target)) setMode('insert', 'field focus', isChromeField(e.target))
      else if (isInternalPage(e.target)) setMode('insert', 'page focus', false)
      else syncWithFocus()
    }
    // Leaving a text field, or a page this renderer draws, for nothing (Esc,
    // Enter in a rename) is COMMAND; leaving it for the page is the page's
    // focus event's to decide.
    const onFocusOut = (e: FocusEvent): void => {
      if (!(isEditable(e.target) || isInternalPage(e.target)) || e.relatedTarget) return
      setTimeout(syncWithFocus, 0)
    }

    const cleanupTabEvents = window.electronAPI.onTabEvent?.((raw) => {
      const evt = raw as { type?: string; tabId?: string; byUser?: boolean; mode?: VimMode; why?: string; command?: string; pending?: string }
      // A sequence ending counts from any page — the one it was typed in may
      // have stopped being the active one on the way.
      if (evt.type === 'vim-pending' && !evt.pending) {
        setPagePending('')
        return
      }
      if (!evt.tabId || !isActiveTabRef.current(evt.tabId)) return
      if (evt.type === 'focus') {
        if (evt.byUser) {
          // A click into the page. A field it lands in makes the page
          // report INSERT right after.
          reset()
          setMode('command', 'page click')
          return
        }
        // The page took focus on its own — a reload, a load finishing. While
        // Ctrl walks the tabs the chrome keeps the keyboard; from a chrome
        // field the keys did move to the page, which is COMMAND.
        if (walkingTabs) claimRendererFocus(false)
        else if (modeRef.current === 'insert' && insertInChromeRef.current) setMode('command', 'page focus')
      } else if (evt.type === 'vim' && (evt.mode === 'command' || evt.mode === 'insert')) {
        // The page moved itself along: i, a field focused or left, Esc.
        if (!walkingTabs) setMode(evt.mode, `page: ${evt.why ?? ''}`)
      } else if (evt.type === 'vim-command') {
        setPagePending('')
        if (evt.command) onCommandRef.current(evt.command)
      } else if (evt.type === 'vim-pending') {
        setPagePending(evt.pending ?? '')
      }
    })

    // Ctrl pressed or let go anywhere in the window — the page or the
    // chrome (main sees both) — or the window losing it. Pressing it shows
    // nothing; letting it go ends what a Ctrl chord Sidebar key started.
    const cleanupCtrl = window.electronAPI.onVimCtrl?.((down) => {
      ctrlDownRef.current = down
      if (!down && walkingTabs) endSidebarKeys()
    })

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      cleanupTabEvents?.()
      cleanupCtrl?.()
      endSidebarKeys()
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [enabled, feed, reset, setMode, endSidebarKeys, clearCtrlTimers])

  return { mode, insertInChrome, pending, sidebarKeys, enterCommand, enterInsert, startTabWalk, returnToPage, endSidebarKeys }
}
