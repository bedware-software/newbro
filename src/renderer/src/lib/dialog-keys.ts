// Keys the yes-or-no dialogs share — a confirmation, the extension install
// prompt: y says yes and n no, as vim's own prompts take them; Esc is no as
// ever (the popup closes on it). By position on the keyboard, so they work in
// any input language. A dialog's popup is a window of its own, so the keys
// are read off it.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
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

/** The row (its `data-row-index`) a control sits in; null outside the rows. */
function rowIndexOf(target: EventTarget | null): number | null {
  const el = target as Element | null
  if (!el || typeof el.closest !== 'function') return null
  const row = el.closest('[data-row-index]')
  if (!row) return null
  const index = Number(row.getAttribute('data-row-index'))
  return Number.isInteger(index) && index >= 0 ? index : null
}

/**
 * The keys of a list of rows to tick (Import / Export Workspaces): the
 * scroll keys (j/k, gg/G, and the arrows) move a cursor through the rows,
 * Space ticks the one under it, the back and forward keys (h/l, ←/→) fold
 * and unfold its preview, Enter goes ahead. Esc is the popup's own (it
 * cancels). The cursor shows in Vim mode, or once a key has moved it.
 *
 * Tab still walks the controls: a focused button keeps its Enter, and its
 * Space too — all but `defaultButton`, the one focused on open, where Space
 * ticks the row under the cursor. A row's checkbox taking the focus brings
 * the cursor to its row, and the cursor moving takes the focus along, so
 * Space on it ticks the row the cursor is on.
 */
export function useChecklistKeys({ popup, open, count, onToggle, onFold, onConfirm, defaultButton }: {
  popup: Window | null
  open: boolean
  count: number
  onToggle: (index: number) => void
  onFold: (index: number, unfold: boolean) => void
  onConfirm: () => void
  /** The button focused on open (Import, Export): Space on it ticks the row
   *  under the cursor instead of pressing it. */
  defaultButton?: RefObject<HTMLButtonElement | null>
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

  const moveTo = (index: number): void => {
    cursorRef.current = index
    setCursor(index)
    // Tab put the focus on a row's checkbox: it goes along with the cursor,
    // so Space on it ticks the row the cursor is on.
    const doc = popup?.document
    const active = doc?.activeElement ?? null
    const from = rowIndexOf(active)
    if (!doc || from === null || from === index) return
    const control = doc.querySelector(`[data-row-index="${index}"]`)
      ?.querySelector<HTMLElement>('input, button, [tabindex]')
    control?.focus()
  }

  const { feed, reset } = useKeySequence(keymap, (command) => {
    const at = cursorRef.current
    setMoved(true)
    switch (command) {
      case 'cursor-down': moveTo(Math.min(at + 1, Math.max(count - 1, 0))); break
      case 'cursor-up': moveTo(Math.max(at - 1, 0)); break
      case 'cursor-first': moveTo(0); break
      case 'cursor-last': moveTo(Math.max(count - 1, 0)); break
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
      const target = e.target as HTMLElement | null
      const onButton = target?.tagName === 'BUTTON'
      // A focused button keeps its Enter, and its Space unless it's the one
      // focused on open (Space there ticks the row under the cursor).
      if (token === '<CR>' && onButton) return
      if (token === '<Space>' && onButton && target !== defaultButton?.current) return
      // Space on a row's checkbox ticks that row: its own, as ever.
      const onCheckbox = target?.tagName === 'INPUT' && (target as HTMLInputElement).type === 'checkbox'
      if (token === '<Space>' && (onCheckbox || rowIndexOf(target) !== null)) {
        reset()
        return
      }
      if (feed(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    // A row's control taking the focus (Tab, a click) brings the cursor to
    // its row; shown at once when Tab brought it.
    const onFocusIn = (e: FocusEvent): void => {
      const row = rowIndexOf(e.target)
      if (row === null || row >= count) return
      cursorRef.current = row
      setCursor(row)
      const el = e.target as Element
      if (typeof el.matches === 'function' && el.matches(':focus-visible')) setMoved(true)
    }
    popup.addEventListener('keydown', onKeyDown, true)
    popup.addEventListener('focusin', onFocusIn, true)
    // A prefix (gg) waits for its next key however long, while the keys
    // stay here.
    popup.addEventListener('blur', reset)
    return () => {
      popup.removeEventListener('keydown', onKeyDown, true)
      popup.removeEventListener('focusin', onFocusIn, true)
      popup.removeEventListener('blur', reset)
      reset()
    }
  }, [popup, open, count, feed, reset, defaultButton])

  return {
    cursor: cursorRef.current,
    setCursor: (index: number) => setCursor(index),
    shown: parsed !== null || moved,
    vim: parsed !== null,
  }
}
