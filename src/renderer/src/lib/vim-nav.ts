import { useCallback, useEffect, useRef } from 'react'

// Vim-style keyboard navigation for the Sidebar and the Bookshelf. With the
// "Vim navigation" setting on, a panel's toggle hotkey cycles
// open → vim mode → closed; in vim mode a block cursor sits on one row and
// the keys below drive it. Each panel decides what a command means for its
// own rows — this module only owns key parsing and keyboard focus.

export type VimCommand =
  | 'down' // j
  | 'up' // k
  | 'move-down' // J — move the row under the cursor one row down
  | 'move-up' // K — …or up
  | 'collapse' // h
  | 'expand' // l
  | 'top' // gg
  | 'bottom' // G
  | 'menu' // m
  | 'close' // x
  | 'enter' // Enter
  | 'escape' // Esc

// Window-wide flag read by WebviewPanel: while a panel is in vim mode,
// activating a tab (j/k switch tabs live) must not hand OS keyboard focus to
// the page, or the next keystroke would go to the site instead of the panel.
// Set synchronously alongside the React state so an activation in the same
// render as the mode change already sees the new value.
let vimNavActive = false

export function setVimNavActive(active: boolean): void {
  vimNavActive = active
}

export function isVimNavActive(): boolean {
  return vimNavActive
}

// How long the second `g` of `gg` may trail the first.
const GG_TIMEOUT_MS = 1000
// How long after a context menu closes focus is still settling. When the
// popup window hides, the OS hands focus back to the parent window, where the
// active tab's WebContentsView may claim it a beat after we asked for the
// renderer (see InlineRenameInput) — a blur inside this window is that
// handoff, not the user leaving, so we take focus back instead of exiting.
// Taking it back only succeeds while our window is the focused one, so a
// dialog opened from the menu (Set Comment…, Move Tab…) keeps its focus.
const FOCUS_SETTLE_MS = 300

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

/** Move OS keyboard focus to this renderer, retrying while a popup hide or
 *  tab view is still pulling it away. `force` takes it even from another
 *  window — right for a hotkey, which only reaches us while ours is in use. */
function claimRendererFocus(force: boolean): () => void {
  if (force) window.electronAPI?.focusWindowRenderer?.()
  else window.electronAPI?.reclaimWindowRendererFocus?.()
  const timers = [60, 180].map((delay) => setTimeout(() => {
    if (!document.hasFocus()) window.electronAPI?.reclaimWindowRendererFocus?.()
  }, delay))
  return () => { for (const t of timers) clearTimeout(t) }
}

/**
 * Listens for vim keys while `active`. `onCommand` gets each parsed command;
 * `onFocusLost` fires when keyboard focus leaves the renderer (the user
 * clicked into the page or another window), which ends vim mode.
 *
 * Wrap context-menu opens in the returned `runMenu`: the menu popup is its
 * own window, so focus leaving for it must not end vim mode, and focus has to
 * come back to the renderer once it closes.
 */
export function useVimNav(
  active: boolean,
  onCommand: (cmd: VimCommand) => void,
  onFocusLost: () => void,
): { runMenu: <T>(open: () => Promise<T>) => Promise<T> } {
  const commandRef = useRef(onCommand)
  commandRef.current = onCommand
  const focusLostRef = useRef(onFocusLost)
  focusLostRef.current = onFocusLost
  const menuOpenRef = useRef(false)
  const settleUntilRef = useRef(0)
  const releaseClaimRef = useRef<(() => void) | null>(null)

  const claimFocus = useCallback((force: boolean) => {
    releaseClaimRef.current?.()
    releaseClaimRef.current = claimRendererFocus(force)
    settleUntilRef.current = Date.now() + FOCUS_SETTLE_MS
  }, [])

  useEffect(() => {
    if (!active) return
    // Keystrokes must reach this renderer's document rather than the page or
    // a chrome input (the URL bar) that happened to hold focus.
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused !== document.body) focused.blur()
    claimFocus(true)

    let pendingG: ReturnType<typeof setTimeout> | null = null
    const clearPendingG = (): void => {
      if (pendingG) clearTimeout(pendingG)
      pendingG = null
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      // Modified keys stay app shortcuts; typing into a field (an inline
      // rename started from the menu) stays typing.
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return
      if (isEditable(e.target)) return

      let cmd: VimCommand | null = null
      if (e.key === 'g') {
        if (e.repeat) return
        if (pendingG) {
          clearPendingG()
          cmd = 'top'
        } else {
          pendingG = setTimeout(() => { pendingG = null }, GG_TIMEOUT_MS)
          e.preventDefault()
          e.stopPropagation()
          return
        }
      } else {
        clearPendingG()
        switch (e.key) {
          case 'j': cmd = 'down'; break
          case 'k': cmd = 'up'; break
          // Checking Shift, not just the capital, keeps Caps Lock from
          // turning navigation into moves.
          case 'J': cmd = e.shiftKey ? 'move-down' : 'down'; break
          case 'K': cmd = e.shiftKey ? 'move-up' : 'up'; break
          case 'h': cmd = 'collapse'; break
          case 'l': cmd = 'expand'; break
          case 'G': cmd = 'bottom'; break
          case 'm': cmd = 'menu'; break
          case 'x': cmd = 'close'; break
          case 'Enter': cmd = 'enter'; break
          case 'Escape': cmd = 'escape'; break
        }
      }
      if (!cmd) return
      // Holding j/k (or J/K) keeps going; anything else fires once per press.
      if (e.repeat && cmd !== 'down' && cmd !== 'up' && cmd !== 'move-down' && cmd !== 'move-up') return
      e.preventDefault()
      // Capture phase on window, so App's global Escape handler and any row
      // handlers never see a key vim mode consumed.
      e.stopPropagation()
      commandRef.current(cmd)
    }

    const onBlur = (): void => {
      if (menuOpenRef.current) return
      if (Date.now() < settleUntilRef.current) {
        window.electronAPI?.reclaimWindowRendererFocus?.()
        return
      }
      focusLostRef.current()
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      clearPendingG()
      releaseClaimRef.current?.()
      releaseClaimRef.current = null
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [active, claimFocus])

  const runMenu = useCallback(async <T,>(open: () => Promise<T>): Promise<T> => {
    menuOpenRef.current = true
    try {
      return await open()
    } finally {
      menuOpenRef.current = false
      // Not forced: if the menu's action opened a dialog window, it keeps focus.
      claimFocus(false)
    }
  }, [claimFocus])

  return { runMenu }
}
