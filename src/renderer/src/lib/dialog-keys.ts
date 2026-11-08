// Keys the yes-or-no dialogs share — a confirmation, the extension install
// prompt: y says yes and n no, as vim's own prompts take them; Esc is no as
// ever (the popup closes on it). By position on the keyboard, so they work in
// any input language. A dialog's popup is a window of its own, so the keys
// are read off it.

import { useEffect, useMemo, useRef, useState } from 'react'
import { isCtrlToken, keyTokenFromEvent, type VimKeymap } from '../../../shared/vim-keys'
import { useKeySequence } from './vim-mode'
import { useWindowVimKeymap, withKeysOf } from './window-vim-keymap'

function isTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName !== 'INPUT') return false
  const type = (el as HTMLInputElement).type
  return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit'
}

/** y runs `yes`, n runs `no` while `popup` has the keyboard and `enabled`. */
export function useYesNoKeys(popup: Window | null, { yes, no, enabled = true }: {
  yes: () => void
  no: () => void
  enabled?: boolean
}): void {
  const yesRef = useRef(yes)
  yesRef.current = yes
  const noRef = useRef(no)
  noRef.current = no
  useEffect(() => {
    if (!popup || !enabled) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat || e.ctrlKey || isTextField(e.target)) return
      const token = keyTokenFromEvent(e)
      if (token !== 'y' && token !== 'n') return
      e.preventDefault()
      e.stopPropagation()
      if (token === 'y') yesRef.current()
      else noRef.current()
    }
    popup.addEventListener('keydown', onKeyDown, true)
    return () => popup.removeEventListener('keydown', onKeyDown, true)
  }, [popup, enabled])
}

// ── A list of things to tick ──

/** Keys every keymap gets: the arrows and the rest, Vim mode or not. */
const FIXED_LIST_KEYS: Array<[string, string]> = [
  ['<Down>', 'cursor-down'], ['<Up>', 'cursor-up'], ['<Home>', 'cursor-first'], ['<End>', 'cursor-last'],
  ['<Left>', 'fold'], ['<Right>', 'unfold'], ['<Space>', 'toggle'], ['<CR>', 'confirm'],
]

function listKeymap(parsed: ReturnType<typeof useWindowVimKeymap>): VimKeymap {
  let map: VimKeymap = new Map()
  if (parsed) {
    // The page's scroll keys (j/k, gg/G) through the rows — straight from
    // COMMAND's map, as there are no filter letters here for gg to lose to
    // (Search Everything's g) — and its back and forward keys (h/l), the
    // Sidebar's fold keys too, to fold and unfold a row.
    map = withKeysOf(map, parsed.main, ['scroll-down'], 'cursor-down')
    map = withKeysOf(map, parsed.main, ['scroll-up'], 'cursor-up')
    map = withKeysOf(map, parsed.main, ['page-top'], 'cursor-first')
    map = withKeysOf(map, parsed.main, ['page-bottom'], 'cursor-last')
    map = withKeysOf(map, parsed.main, ['back', 'row-fold'], 'fold')
    map = withKeysOf(map, parsed.main, ['forward', 'row-unfold'], 'unfold')
  }
  for (const [seq, command] of FIXED_LIST_KEYS) if (!map.has(seq)) map.set(seq, command)
  return map
}

/**
 * The keys of a list of rows to tick (Import / Export Workspaces): the
 * scroll keys (j/k, gg/G, and the arrows) move a cursor through the rows,
 * Space ticks the one under it, the back and forward keys (h/l, ←/→) fold
 * and unfold its preview, Enter goes ahead. Esc is the popup's own (it
 * cancels). A focused button keeps its Enter. The cursor shows in Vim mode,
 * or once a key has moved it.
 */
export function useChecklistKeys({ popup, open, count, onToggle, onFold, onConfirm }: {
  popup: Window | null
  open: boolean
  count: number
  onToggle: (index: number) => void
  onFold: (index: number, unfold: boolean) => void
  onConfirm: () => void
}): {
  cursor: number
  setCursor: (index: number) => void
  /** Whether to draw the cursor. */
  shown: boolean
  /** Whether Vim mode's keys are on (j/k, h/l), for the hints. */
  vim: boolean
} {
  const parsed = useWindowVimKeymap()
  const keymap = useMemo(() => listKeymap(parsed), [parsed])
  const [cursor, setCursor] = useState(0)
  const [moved, setMoved] = useState(false)
  const cursorRef = useRef(cursor)
  cursorRef.current = Math.min(cursor, Math.max(count - 1, 0))
  const handlers = useRef({ onToggle, onFold, onConfirm })
  handlers.current = { onToggle, onFold, onConfirm }

  useEffect(() => {
    if (!open) return
    setCursor(0)
    setMoved(false)
  }, [open])

  const { feed, reset } = useKeySequence(keymap, (command) => {
    const at = cursorRef.current
    setMoved(true)
    switch (command) {
      case 'cursor-down': setCursor(Math.min(at + 1, Math.max(count - 1, 0))); break
      case 'cursor-up': setCursor(Math.max(at - 1, 0)); break
      case 'cursor-first': setCursor(0); break
      case 'cursor-last': setCursor(Math.max(count - 1, 0)); break
      case 'toggle': if (count > 0) handlers.current.onToggle(at); break
      case 'fold': if (count > 0) handlers.current.onFold(at, false); break
      case 'unfold': if (count > 0) handlers.current.onFold(at, true); break
      case 'confirm': handlers.current.onConfirm(); break
    }
  })

  useEffect(() => {
    if (!popup || !open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.altKey || isTextField(e.target)) return
      const token = keyTokenFromEvent(e)
      if (!token || (e.ctrlKey && !isCtrlToken(token))) return
      const onButton = (e.target as HTMLElement | null)?.tagName === 'BUTTON'
      if (token === '<CR>' && onButton) return
      if (feed(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    popup.addEventListener('keydown', onKeyDown, true)
    return () => {
      popup.removeEventListener('keydown', onKeyDown, true)
      reset()
    }
  }, [popup, open, feed, reset])

  return {
    cursor: cursorRef.current,
    setCursor: (index: number) => setCursor(index),
    shown: parsed !== null || moved,
    vim: parsed !== null,
  }
}
