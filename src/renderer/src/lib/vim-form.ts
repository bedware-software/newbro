// Vim keys for a form — Settings, and any popup or page built the same way.
// A cursor (a ring drawn round it) walks the form's controls in COMMAND:
// j/k from one to the next, h/l change the one under it, Enter or Space
// presses it, i types in a text field. Every control wears a two-letter
// label too (components/VimForm.tsx draws them), and typing one goes there.
//
// The form says which elements are its controls by marking them, so its
// markup stays its own:
//   data-vim-item="<id>"   a control; the id, stable across renders, keeps
//                          the cursor on it while the form changes round it
//   data-vim-kind="…"      what it is, when its tag and role don't say:
//                          `row` (a list's row: its buttons, marked
//                          data-vim-cell="<name>", are reached with h/l),
//                          `select` (a VimSelect)
//   data-vim-danger        what can't be taken back (Remove all, Wipe):
//                          Enter, Space and its label only go to it, and
//                          dd presses it. On a row's cell too; a cell named
//                          `remove` is always one
//   data-vim-nowalk        a label reaches it, j/k don't (a section's tab)
// Hidden and disabled controls are skipped. What a control is, otherwise:
// a checkbox or a role=switch toggles, a role=radiogroup steps through its
// role=radio buttons, a select or VimSelect picks, a range slides, a text
// input or textarea types, anything else is a button.
//
// A form shown in a popup (DetachedWindow) lives in the popup's realm:
// instanceof checks against this window's classes fail there, so elements
// are told apart by their tags, and events and observers are made from the
// element's own window.

import { createContext, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { isTypingElement } from './vim-mode'
import { log } from './log'

export type VimItemKind = 'toggle' | 'segment' | 'select' | 'range' | 'text' | 'row' | 'button'

const DECLARED_KINDS = new Set<VimItemKind>(['toggle', 'segment', 'select', 'range', 'text', 'row', 'button'])
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number'])
// Inputs whose caret can be put at the end (setSelectionRange throws on the others).
const CARET_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'password'])

/** What kind inference reads off an element — or off a stand-in for one. */
export interface KindSource {
  tagName: string
  type?: string | null
  role?: string | null
  /** Its data-vim-kind. */
  vimKind?: string | null
  isContentEditable?: boolean
}

/** What a control is, and so what the keys do to it. */
export function inferItemKind(src: KindSource): VimItemKind {
  if (src.vimKind && DECLARED_KINDS.has(src.vimKind as VimItemKind)) return src.vimKind as VimItemKind
  const tag = src.tagName.toUpperCase()
  const type = (src.type ?? '').toLowerCase()
  if (src.role === 'switch' || src.role === 'checkbox') return 'toggle'
  if (src.role === 'radiogroup') return 'segment'
  if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) return 'toggle'
  if (tag === 'SELECT') return 'select'
  if (tag === 'INPUT' && type === 'range') return 'range'
  if (src.isContentEditable || tag === 'TEXTAREA' || (tag === 'INPUT' && TEXT_INPUT_TYPES.has(type))) return 'text'
  return 'button'
}

/** The index `delta` steps on from `index` among `count`: held at the ends,
 *  or round them with `wrap`. From none yet (-1) it steps onto the first —
 *  or, going back, the last. -1 when there's nothing to step through. */
export function stepIndex(index: number, count: number, delta: number, wrap: boolean): number {
  if (count <= 0) return -1
  if (index < 0 || index >= count) return delta >= 0 ? 0 : count - 1
  const next = index + delta
  if (wrap) return ((next % count) + count) % count
  return Math.max(0, Math.min(count - 1, next))
}

/** A slider's value `steps` of its steps on, on its step grid, inside its
 *  range. */
export function stepRangeValue(value: number, min: number, max: number, step: number, steps: number): number {
  const size = Number.isFinite(step) && step > 0 ? step : 1
  const lo = Number.isFinite(min) ? min : 0
  const hi = Number.isFinite(max) ? max : 100
  const from = Number.isFinite(value) ? value : lo
  const snapped = lo + Math.round((from + steps * size - lo) / size) * size
  return Math.max(lo, Math.min(hi, Number(snapped.toFixed(10))))
}

/** Of a row's cells (`names`, in order), the one named `name` nearest the
 *  cursor's (`at`): at it or after it first, else the last before it. -1
 *  for none — so dd on a row of shortcuts clears the one the cursor is by. */
export function nearestCell(names: readonly string[], at: number, name: string): number {
  for (let i = Math.max(0, at); i < names.length; i++) if (names[i] === name) return i
  for (let i = Math.min(at, names.length) - 1; i >= 0; i--) if (names[i] === name) return i
  return -1
}

// ── Elements ──

type RealmWindow = Window & typeof globalThis

function realmOf(el: Element): RealmWindow | null {
  return el.ownerDocument.defaultView as RealmWindow | null
}

function kindOf(el: Element): VimItemKind {
  return inferItemKind({
    tagName: el.tagName,
    type: el.getAttribute('type') ?? (el.tagName === 'INPUT' ? 'text' : null),
    role: el.getAttribute('role'),
    vimKind: el.getAttribute('data-vim-kind'),
    isContentEditable: (el as HTMLElement).isContentEditable,
  })
}

function isShown(el: Element): boolean {
  return el.getClientRects().length > 0
}

function isDisabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true'
}

function usable(el: Element): boolean {
  return isShown(el) && !isDisabled(el)
}

/** A row's cells — its own, not those of a row inside it. */
function cellsOf(row: Element): Element[] {
  return Array.from(row.querySelectorAll('[data-vim-cell]')).filter(
    (cell) => cell.parentElement?.closest('[data-vim-item]') === row && usable(cell),
  )
}

/** A row's cell that only dd presses, never Enter or Space: its Remove, or
 *  one marked data-vim-danger. */
function isDangerCell(cell: Element): boolean {
  return cell.getAttribute('data-vim-cell') === 'remove' || cell.hasAttribute('data-vim-danger')
}

/** A radio group's choices — its own. */
function radiosOf(group: Element): Element[] {
  return Array.from(group.querySelectorAll('[role="radio"]')).filter(
    (radio) => radio.closest('[role="radiogroup"]') === group && usable(radio),
  )
}

function isOn(el: Element): boolean {
  if (el.tagName === 'INPUT') return (el as HTMLInputElement).checked
  return el.getAttribute('aria-checked') === 'true'
}

function press(el: Element): void {
  ;(el as HTMLElement).click()
}

/** Into the field, typing — the caret at the end of a one-line field (a
 *  textarea keeps where it was, or the keymap's would jump to its end). */
function typeInto(el: Element): void {
  const field = el as HTMLInputElement
  field.focus()
  if (el.tagName !== 'INPUT' || !CARET_INPUT_TYPES.has((el.getAttribute('type') ?? '').toLowerCase())) return
  const end = field.value.length
  field.setSelectionRange(end, end)
}

/** A slider moved the way a hand would: the value set through the native
 *  setter (so React sees it change) and an input event. */
function slide(el: Element, steps: number): boolean {
  const input = el as HTMLInputElement
  const win = realmOf(el)
  if (!win) return false
  const current = Number(input.value)
  const next = stepRangeValue(current, Number(input.min || 0), Number(input.max || 100), Number(input.step || 1), steps)
  if (next === current) return true
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set
  if (!setter) {
    log.warn('vim-form: no value setter on the slider', el.getAttribute('data-vim-item'))
    return false
  }
  setter.call(input, String(next))
  input.dispatchEvent(new win.Event('input', { bubbles: true }))
  input.dispatchEvent(new win.Event('change', { bubbles: true }))
  return true
}

/** A native select's next or previous choice, as picking it would. */
function stepNativeSelect(el: Element, delta: number): boolean {
  const select = el as HTMLSelectElement
  const win = realmOf(el)
  if (!win) return false
  const enabled = Array.from(select.options).map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0)
  const at = enabled.indexOf(select.selectedIndex)
  const next = enabled[stepIndex(at, enabled.length, delta, false)]
  if (next === undefined || next === select.selectedIndex) return true
  select.selectedIndex = next
  select.dispatchEvent(new win.Event('change', { bubbles: true }))
  return true
}

// A control that changes its value itself (VimSelect), by element.
const steppers = new WeakMap<Element, (delta: number) => void>()

/** `el`'s h / l, for a control that steps its own value (VimSelect); null
 *  lets go. */
export function setItemStepper(el: Element, step: ((delta: number) => void) | null): void {
  if (step) steppers.set(el, step)
  else steppers.delete(el)
}

// ── The controller ──

/** Something drawn over the form while it's open — a VimSelect's list,
 *  Settings' filter results — that takes the form's keys. */
export interface VimFormOverlay {
  /** A form command (cursor-down, activate…); true when it took it. */
  command: (command: string) => boolean
  /** Esc: it closes. */
  escape: () => void
}

export interface VimFormSnapshot {
  /** The control under the cursor, by its id. */
  cursor: string | null
  kind: VimItemKind | null
  danger: boolean
  /** The cursor's row's cells by name, and which one the cursor is on. */
  cells: readonly string[]
  cell: number
  /** The cell under the cursor is one only dd presses (a Remove): Enter
   *  and Space leave it alone. */
  cellDanger: boolean
  /** How many controls wear labels. */
  labelCount: number
  overlayOpen: boolean
}

const EMPTY_SNAPSHOT: VimFormSnapshot = {
  cursor: null, kind: null, danger: false, cells: [], cell: 0, cellDanger: false, labelCount: 0, overlayOpen: false,
}

/** How long a cursor asked for (a filter result) waits for its control to
 *  show up — a section's controls render as it opens, its lists a little
 *  later. */
const PENDING_CURSOR_MS = 1500

export class VimFormController {
  private enabled = false
  private root: HTMLElement | null = null
  private scrollRoot: HTMLElement | null = null
  private walk: Element[] = []
  private ids: string[] = []
  private labelEls: Element[] = []
  private cursorId: string | null = null
  private cursorIndex = 0
  private cellIndex = 0
  private marked: Element | null = null
  private markedCell: Element | null = null
  private overlays: VimFormOverlay[] = []
  private pendingCursor: { id: string; fallback?: string; until: number } | null = null
  private scanTimer: number | null = null
  private snapshot: VimFormSnapshot = EMPTY_SNAPSHOT
  private listeners = new Set<() => void>()
  private layoutListeners = new Set<() => void>()

  // ── For React ──

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): VimFormSnapshot => this.snapshot

  /** Called after every look at the form, changed or not — for what's
   *  drawn at the controls' places (the labels). */
  subscribeLayout(listener: () => void): () => void {
    this.layoutListeners.add(listener)
    return () => { this.layoutListeners.delete(listener) }
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return
    this.enabled = on
    if (on) this.scan()
    else {
      this.unmark()
      this.publish()
    }
  }

  /** Watches `root` for its controls — the form's markup changing, the
   *  pointer pressing one or the keyboard going to one (Tab out of a field):
   *  the cursor goes there. `scrollRoot` is what scrolls them, for half a
   *  page at a time. Returns the cleanup. */
  attach(root: HTMLElement | null, scrollRoot: HTMLElement | null): () => void {
    this.root = root
    this.scrollRoot = scrollRoot
    if (!root) {
      this.walk = []
      this.ids = []
      this.labelEls = []
      this.publish()
      return () => {}
    }
    const win = realmOf(root)
    if (!win) {
      log.warn('vim-form: the form has no window')
      return () => {}
    }
    // A batch of changes at a time (a render's), so it looks straight away —
    // no frame to wait for, which a window in the background never gets.
    const observer = new win.MutationObserver(() => this.scan())
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-vim-item', 'data-vim-cell', 'data-vim-kind', 'disabled', 'aria-disabled', 'aria-checked', 'hidden', 'class', 'style', 'type'],
    })
    const onPointerOrFocus = (e: Event): void => this.cursorToElement(e.target)
    root.addEventListener('mousedown', onPointerOrFocus, true)
    root.addEventListener('focusin', onPointerOrFocus)
    this.scan()
    return () => {
      observer.disconnect()
      root.removeEventListener('mousedown', onPointerOrFocus, true)
      root.removeEventListener('focusin', onPointerOrFocus)
      // The popup may be gone already, its window with it.
      if (this.scanTimer !== null && !win.closed) win.clearTimeout(this.scanTimer)
      this.scanTimer = null
      this.unmark()
      if (this.root === root) {
        this.root = null
        this.scrollRoot = null
        this.walk = []
        this.ids = []
        this.labelEls = []
        this.publish()
      }
    }
  }

  /** The form now shows something else (Settings' next section): the
   *  cursor starts again at its first control — or at one asked for. */
  restart(): void {
    this.cursorId = null
    this.cursorIndex = 0
    this.cellIndex = 0
    if (!this.pendingCursor && this.enabled && this.scrollRoot) this.scrollRoot.scrollTop = 0
    this.scan()
  }

  /** The cursor goes to `id` once it's there (a section just switched to
   *  is still rendering), or to `fallback`. Out of Vim mode the control
   *  takes the keyboard instead, the way Tab would have brought it. */
  requestCursor(id: string, fallback?: string): void {
    this.pendingCursor = { id, fallback, until: Date.now() + PENDING_CURSOR_MS }
    this.scheduleScan()
  }

  // ── What the controls are ──

  /** A look once what's happening now is done (a render on its way). */
  private scheduleScan(): void {
    const win = this.root ? realmOf(this.root) : null
    if (!win || win.closed || this.scanTimer !== null) return
    this.scanTimer = win.setTimeout(() => {
      this.scanTimer = null
      this.scan()
    }, 0)
  }

  /** Looks the form over: its controls, in order, and where the cursor is. */
  scan(): void {
    const root = this.root
    if (!root) return
    const found = Array.from(root.querySelectorAll('[data-vim-item]')).filter(usable)
    this.walk = found.filter((el) => !el.hasAttribute('data-vim-nowalk'))
    this.ids = this.walk.map((el) => el.getAttribute('data-vim-item') ?? '')
    // The section tabs first: their labels then stay the same section to
    // section.
    this.labelEls = [...found.filter((el) => el.hasAttribute('data-vim-nowalk')), ...this.walk]
    this.resolveCursor()
    this.mark()
    this.publish()
    this.layoutListeners.forEach((l) => l())
  }

  private resolveCursor(): void {
    const pending = this.pendingCursor
    if (pending) {
      const at = this.ids.indexOf(pending.id)
      const fallback = at < 0 && pending.fallback ? this.ids.indexOf(pending.fallback) : -1
      if (at >= 0 || fallback >= 0 || Date.now() > pending.until) {
        this.pendingCursor = null
        const index = at >= 0 ? at : fallback
        if (index >= 0) {
          this.place(index)
          const el = this.walk[index]
          el.scrollIntoView({ block: 'center' })
          if (!this.enabled) focusControl(el)
          return
        }
      }
    }
    if (this.cursorId !== null) {
      const at = this.ids.indexOf(this.cursorId)
      if (at >= 0) {
        this.cursorIndex = at
        return
      }
    }
    // Gone (removed, hidden, disabled): the control now in its place.
    if (this.ids.length === 0) {
      this.cursorId = null
      return
    }
    this.place(Math.min(this.cursorIndex, this.ids.length - 1), false)
  }

  private place(index: number, resetCell = true): void {
    const id = this.ids[index] ?? null
    if (resetCell && id !== this.cursorId) this.cellIndex = 0
    this.cursorIndex = Math.max(0, index)
    this.cursorId = id
  }

  private cursorEl(): Element | null {
    const el = this.walk[this.cursorIndex]
    return el && el.isConnected && this.ids[this.cursorIndex] === this.cursorId ? el : null
  }

  private mark(): void {
    if (!this.enabled) {
      this.unmark()
      return
    }
    const el = this.cursorEl()
    if (this.marked !== el) {
      this.marked?.removeAttribute('data-vim-cursor')
      el?.setAttribute('data-vim-cursor', '')
      this.marked = el
    }
    let cell: Element | null = null
    if (el && kindOf(el) === 'row') {
      const cells = cellsOf(el)
      if (cells.length > 0) {
        this.cellIndex = Math.min(this.cellIndex, cells.length - 1)
        cell = cells[this.cellIndex]
      }
    }
    if (this.markedCell !== cell) {
      this.markedCell?.removeAttribute('data-vim-cell-cursor')
      cell?.setAttribute('data-vim-cell-cursor', '')
      this.markedCell = cell
    }
  }

  private unmark(): void {
    this.marked?.removeAttribute('data-vim-cursor')
    this.markedCell?.removeAttribute('data-vim-cell-cursor')
    this.marked = null
    this.markedCell = null
  }

  private publish(): void {
    const el = this.enabled ? this.cursorEl() : null
    const kind = el ? kindOf(el) : null
    const rowCells = el && kind === 'row' ? cellsOf(el) : []
    const cells = rowCells.map((c) => c.getAttribute('data-vim-cell') ?? '')
    const cell = cells.length > 0 ? Math.min(this.cellIndex, cells.length - 1) : 0
    const next: VimFormSnapshot = {
      cursor: el ? this.cursorId : null,
      kind,
      danger: !!el?.hasAttribute('data-vim-danger'),
      cells,
      cell,
      cellDanger: rowCells.length > 0 && isDangerCell(rowCells[cell]),
      labelCount: this.enabled ? this.labelEls.length : 0,
      overlayOpen: this.overlays.length > 0,
    }
    const prev = this.snapshot
    if (
      prev.cursor === next.cursor && prev.kind === next.kind && prev.danger === next.danger &&
      prev.cell === next.cell && prev.cellDanger === next.cellDanger &&
      prev.labelCount === next.labelCount && prev.overlayOpen === next.overlayOpen &&
      prev.cells.join('\n') === next.cells.join('\n')
    ) return
    this.snapshot = next
    this.listeners.forEach((l) => l())
  }

  /** The labelled controls, in label order (the overlay draws at them). */
  labelTargets(): readonly Element[] {
    return this.labelEls
  }

  /** What `el`'s label is cut to: the scrolling area it's in, if any. */
  clipFor(el: Element): Element | null {
    return this.scrollRoot && this.scrollRoot.contains(el) ? this.scrollRoot : null
  }

  // ── Moving ──

  private moveTo(index: number): boolean {
    if (this.walk.length === 0) return false
    this.place(Math.max(0, Math.min(this.walk.length - 1, index)))
    this.mark()
    this.publish()
    this.cursorEl()?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    return true
  }

  private moveBy(delta: number): boolean {
    const from = this.cursorEl() ? this.cursorIndex : -1
    return this.moveTo(stepIndex(from, this.walk.length, delta, false))
  }

  /** Vim's <C-d> / <C-u>: the form scrolls half its height, and the cursor
   *  goes to the control now where it was on the screen — or, at the end,
   *  on by what couldn't be scrolled. */
  private halfPage(direction: 1 | -1): boolean {
    const scroller = this.scrollRoot
    if (!scroller || this.walk.length === 0) return false
    const half = scroller.clientHeight / 2
    const anchor = this.cursorEl()?.getBoundingClientRect().top ?? scroller.getBoundingClientRect().top
    const before = scroller.scrollTop
    scroller.scrollTop = before + direction * half
    const scrolled = Math.abs(scroller.scrollTop - before)
    const target = anchor + direction * (half - scrolled)
    let best = 0
    let bestDistance = Infinity
    this.walk.forEach((el, i) => {
      const distance = Math.abs(el.getBoundingClientRect().top - target)
      if (distance < bestDistance) {
        best = i
        bestDistance = distance
      }
    })
    return this.moveTo(best)
  }

  /** The cursor to the control `target` is (in), if it's one of the walk's. */
  private cursorToElement(target: EventTarget | null): void {
    const node = target as Element | null
    if (!node || node.nodeType !== 1) return
    const item = node.closest('[data-vim-item]')
    if (!item) return
    const at = this.walk.indexOf(item)
    if (at < 0) return
    this.place(at)
    if (kindOf(item) === 'row') {
      const cell = node.closest('[data-vim-cell]')
      const index = cell ? cellsOf(item).indexOf(cell) : -1
      if (index >= 0) this.cellIndex = index
    }
    this.mark()
    this.publish()
  }

  // ── Changing ──

  /** h / l (H / L: a slider ten steps). */
  private adjust(delta: 1 | -1, big: boolean): boolean {
    const el = this.cursorEl()
    if (!el) return false
    switch (kindOf(el)) {
      case 'toggle':
        if (isOn(el) !== delta > 0) press(el)
        return true
      case 'segment': {
        const radios = radiosOf(el)
        const at = radios.findIndex(isOn)
        const next = stepIndex(at, radios.length, delta, false)
        if (next >= 0 && next !== at) press(radios[next])
        return true
      }
      case 'select': {
        const stepper = steppers.get(el)
        if (stepper) {
          stepper(delta)
          return true
        }
        return el.tagName === 'SELECT' ? stepNativeSelect(el, delta) : false
      }
      case 'range':
        return slide(el, delta * (big ? 10 : 1))
      case 'row': {
        const cells = cellsOf(el)
        if (cells.length === 0) return false
        this.cellIndex = stepIndex(Math.min(this.cellIndex, cells.length - 1), cells.length, delta, false)
        this.mark()
        this.publish()
        return true
      }
      default:
        return false
    }
  }

  /** Enter or Space on the cursor. Never on what can't be taken back — a
   *  danger button, a row's Remove — even with the cursor on it: that's
   *  dd's (pressCell). */
  private activate(): boolean {
    const el = this.cursorEl()
    if (!el || el.hasAttribute('data-vim-danger')) return false
    switch (kindOf(el)) {
      case 'segment': {
        // Round the choices, the way pressing a switch goes round its two.
        const radios = radiosOf(el)
        const next = stepIndex(radios.findIndex(isOn), radios.length, 1, true)
        if (next >= 0) press(radios[next])
        return true
      }
      case 'text':
        typeInto(el)
        return true
      case 'range':
        return false
      case 'row': {
        const cells = cellsOf(el)
        const cell = cells[Math.min(this.cellIndex, cells.length - 1)]
        if (!cell || isDangerCell(cell)) return false
        press(cell)
        return true
      }
      default:
        press(el)
        return true
    }
  }

  /** dd, y, e…: the cursor's row's cell of that name — for dd, the nearest
   *  cell only it presses (a Remove, or one marked data-vim-danger). dd on
   *  a danger button presses it. */
  private pressCell(name: string): boolean {
    const el = this.cursorEl()
    if (!el) return false
    if (kindOf(el) !== 'row') {
      if (name !== 'remove' || !el.hasAttribute('data-vim-danger') || kindOf(el) !== 'button') return false
      press(el)
      return true
    }
    const cells = cellsOf(el)
    const names = cells.map((c) => (name === 'remove' && isDangerCell(c) ? 'remove' : c.getAttribute('data-vim-cell') ?? ''))
    const at = nearestCell(names, this.cellIndex, name)
    if (at < 0) return false
    this.cellIndex = at
    this.mark()
    this.publish()
    press(cells[at])
    return true
  }

  /** A label typed: the cursor goes to its control, and a control a press
   *  does no harm to — a button, a switch, a list, a field — takes it. */
  pickLabel(index: number): void {
    const el = this.labelEls[index]
    if (!el || !el.isConnected) return
    if (el.hasAttribute('data-vim-nowalk')) {
      press(el)
      return
    }
    const at = this.walk.indexOf(el)
    if (at < 0) return
    this.moveTo(at)
    if (el.hasAttribute('data-vim-danger')) return
    switch (kindOf(el)) {
      case 'text':
        typeInto(el)
        break
      case 'button':
      case 'toggle':
      case 'select':
        press(el)
        break
    }
  }

  // ── Overlays ──

  /** `overlay` takes the form's keys until the returned function closes it. */
  openOverlay(overlay: VimFormOverlay): () => void {
    this.overlays.push(overlay)
    this.publish()
    return () => {
      const at = this.overlays.lastIndexOf(overlay)
      if (at >= 0) this.overlays.splice(at, 1)
      this.publish()
    }
  }

  /** Esc: the overlay on top closes; false when there's none. */
  escapeOverlay(): boolean {
    const top = this.overlays[this.overlays.length - 1]
    if (!top) return false
    top.escape()
    return true
  }

  /** A form command from the keymap; false when it isn't one, or does
   *  nothing here. */
  run(command: string): boolean {
    const overlay = this.overlays[this.overlays.length - 1]
    if (overlay) return overlay.command(command)
    switch (command) {
      case 'cursor-down': return this.moveBy(1)
      case 'cursor-up': return this.moveBy(-1)
      case 'cursor-first': return this.moveTo(0)
      case 'cursor-last': return this.moveTo(this.walk.length - 1)
      case 'half-page-down': return this.halfPage(1)
      case 'half-page-up': return this.halfPage(-1)
      case 'value-next': return this.adjust(1, false)
      case 'value-prev': return this.adjust(-1, false)
      case 'value-next-big': return this.adjust(1, true)
      case 'value-prev-big': return this.adjust(-1, true)
      case 'activate':
      case 'toggle':
        return this.activate()
      case 'insert-mode': {
        const el = this.cursorEl()
        if (!el || kindOf(el) !== 'text') return false
        typeInto(el)
        return true
      }
      case 'row-remove': return this.pressCell('remove')
      case 'row-copy': return this.pressCell('copy')
      case 'row-copy-password': return this.pressCell('copy-password')
      case 'row-edit': return this.pressCell('edit')
      default: return false
    }
  }
}

/** Gives `el` the keyboard the way Tab would have: itself if it takes it,
 *  else its chosen radio, or its row's first button. */
function focusControl(el: Element): void {
  const kind = kindOf(el)
  const target = kind === 'segment'
    ? radiosOf(el).find(isOn) ?? radiosOf(el)[0]
    : kind === 'row'
      ? cellsOf(el)[0]
      : el
  ;(target as HTMLElement | undefined)?.focus()
}

// ── Hooks ──

/**
 * A form's Vim keys: a controller watching `root` (null until it's
 * rendered), cursor and all, while `enabled`. `resetKey` changing (the
 * section shown) starts the cursor again at the top. Run the keymap's
 * commands through `run`, a label's through `pickLabel`.
 */
export function useVimForm({ enabled, root, scrollRoot, resetKey }: {
  enabled: boolean
  root: HTMLElement | null
  scrollRoot: HTMLElement | null
  resetKey?: unknown
}): VimFormController {
  const form = useMemo(() => new VimFormController(), [])
  useLayoutEffect(() => form.setEnabled(enabled), [form, enabled])
  useLayoutEffect(() => form.attach(root, scrollRoot), [form, root, scrollRoot])
  useLayoutEffect(() => form.restart(), [form, resetKey])
  return form
}

/** Where the cursor is, for what shows it (the hint bar). */
export function useVimFormSnapshot(form: VimFormController): VimFormSnapshot {
  return useSyncExternalStore(form.subscribe, form.getSnapshot)
}

/**
 * A form's "there are unsaved changes" warning, which closing shows first.
 * Once set it stays up until the form changes (`draft`, what Save would
 * keep), however the change was made: a key, the mouse, typing. So a second
 * close throws the changes away only when nothing changed since the
 * warning, and an edit made after it gets a fresh warning.
 */
export function useCloseWarning(draft: string): [boolean, (on: boolean) => void] {
  // The draft as it was when the warning went up.
  const [warnedDraft, setWarnedDraft] = useState<string | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  // Changed since: down, in this render, before anything reads it.
  if (warnedDraft !== null && warnedDraft !== draft) setWarnedDraft(null)
  const setWarning = useCallback((on: boolean) => setWarnedDraft(on ? draftRef.current : null), [])
  return [warnedDraft !== null && warnedDraft === draft, setWarning]
}

/** How many controls wear labels — all a form's owner needs to re-render
 *  for (usePopupHints). */
export function useVimFormLabelCount(form: VimFormController): number {
  return useSyncExternalStore(form.subscribe, () => form.getSnapshot().labelCount)
}

/** The form a control is in, while its Vim keys are on: a VimSelect's list
 *  takes them while it's open. */
export const VimFormContext = createContext<VimFormController | null>(null)
