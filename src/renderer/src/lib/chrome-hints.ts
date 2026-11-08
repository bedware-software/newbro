// Vim's ; (chrome-hints): a label on every clickable control of the
// browser's own UI — the toolbar, the Sidebar's rows and buttons, the
// Bookshelf, the side panel's header, the page area's error screens, and
// popups that opt in — as vimium's f does a page's links. Typing a label
// presses it: a button clicks, a text field takes the keyboard (INSERT).
// Esc, a key no label starts with, or ; again puts the labels away.
//
// The labels ride the window's hint registry (lib/hint-labels.ts) as its
// exclusive provider, so they're bound in the window's COMMAND keymap —
// the one a tab's page runs too, so they work wherever the keyboard is.
// The overlay that draws them is components/ChromeHintsOverlay.tsx.
//
// What counts: a visible, enabled `button`, `[role=button]`,
// `[role=switch]`, `[role=menuitem]`, `a[href]`, `input`, `select`,
// `textarea` or `[data-chrome-hint]`, in the window's document — and in the
// document of each open popup (DetachedWindow), inside a root marked
// `data-chrome-hints`. `data-chrome-hint="skip"` keeps an element (and what
// is inside it) out.

import { useSyncExternalStore } from 'react'
import { log } from './log'

// ── On or off ──

let active = false
const activeListeners = new Set<() => void>()

function setActive(next: boolean, why: string): void {
  if (active === next) return
  active = next
  log.event('chrome-hints', next ? 'on' : `off (${why})`)
  activeListeners.forEach((l) => l())
}

/** ; — the labels come up, or go if they're up. */
export function toggleChromeHints(): void {
  setActive(!active, 'toggled')
}

/** The labels go (a label was typed, Esc, a key no label starts with…). */
export function cancelChromeHints(why = 'cancelled'): void {
  setActive(false, why)
}

export function chromeHintsActive(): boolean {
  return active
}

export function useChromeHintsActive(): boolean {
  return useSyncExternalStore(
    (l) => {
      activeListeners.add(l)
      return () => { activeListeners.delete(l) }
    },
    () => active,
  )
}

// ── The popups' documents ──

/** An open popup window (DetachedWindow) whose marked roots get labels. */
export interface HintPopup {
  win: Window
  /** Gives the popup the keyboard — for a text field picked in it. */
  focus: () => void
}

const popups = new Set<HintPopup>()

/** DetachedWindow: `popup` is open; the returned function, when it closes.
 *  Labels already up stay as they are — the overlay drops a closed popup's,
 *  and a label picked in it after it closed does nothing. */
export function registerHintPopup(popup: HintPopup): () => void {
  popups.add(popup)
  return () => { popups.delete(popup) }
}

// ── The targets ──

export const CHROME_HINT_SELECTOR = [
  'button', '[role="button"]', '[role="switch"]', '[role="menuitem"]', 'a[href]',
  'input', 'select', 'textarea', '[data-chrome-hint]',
].join(', ')

/** A control found to wear a label, where it was when found. */
export interface ChromeHintTarget {
  id: string
  el: HTMLElement
  /** Null: the window's own document. */
  popup: HintPopup | null
  rect: { left: number; top: number; width: number; height: number }
}

// Stable ids per element, so the registry keeps a label on the same
// control while the targets are found again.
const ids = new WeakMap<Element, string>()
let nextId = 1
function idOf(el: Element): string {
  let id = ids.get(el)
  if (!id) {
    id = `chrome-hint-${nextId++}`
    ids.set(el, id)
  }
  return id
}

// A popup's elements are of its own window's realm, so the checks below go
// by tag name, not instanceof.

/** An HTML element (an SVG one has no click()). */
function asHtmlElement(node: Element): HTMLElement | null {
  return typeof (node as HTMLElement).click === 'function' ? (node as HTMLElement) : null
}

/** Typing goes into it: focusing it is INSERT. */
export function isTextEntry(el: HTMLElement): boolean {
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true
  if (el.tagName !== 'INPUT') return false
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden'].includes((el as HTMLInputElement).type)
}

/** It takes the keyboard rather than a click: a text field, a list, a
 *  slider (its arrows step it). */
function takesKeyboard(el: HTMLElement): boolean {
  return isTextEntry(el) || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range')
}

function isDisabled(el: HTMLElement): boolean {
  if (el.matches(':disabled')) return true
  return el.closest('[aria-disabled="true"], [inert]') !== null
}

/** The element is on screen where it can be clicked: laid out, not hidden
 *  or see-through, inside the viewport, and the topmost thing at its middle
 *  (a hover-only button that takes no clicks until hovered isn't). */
function visibleRect(el: HTMLElement, win: Window): ChromeHintTarget['rect'] | null {
  if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return null
  const vw = win.innerWidth
  const vh = win.innerHeight
  if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return null
  // The middle of the part inside the viewport.
  const x = (Math.max(r.left, 0) + Math.min(r.right, vw)) / 2
  const y = (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2
  const hit = el.ownerDocument.elementFromPoint(x, y)
  if (!hit || (hit !== el && !el.contains(hit))) return null
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function collectIn(root: ParentNode, win: Window, popup: HintPopup | null, out: ChromeHintTarget[]): void {
  for (const node of root.querySelectorAll(CHROME_HINT_SELECTOR)) {
    const el = asHtmlElement(node)
    if (!el || el.closest('[data-chrome-hint="skip"]')) continue
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden') continue
    if (isDisabled(el)) continue
    const rect = visibleRect(el, win)
    if (!rect) continue
    out.push({ id: idOf(el), el, popup, rect })
  }
}

/** Every control that should wear a label now: the window's first, in the
 *  order they come in it (the toolbar, the Sidebar, …), then the opted-in
 *  popups'. */
export function collectChromeHintTargets(): ChromeHintTarget[] {
  const out: ChromeHintTarget[] = []
  collectIn(document, window, null, out)
  for (const popup of popups) {
    if (popup.win.closed) continue
    for (const root of popup.win.document.querySelectorAll('[data-chrome-hints]')) collectIn(root, popup.win, popup, out)
  }
  return out
}

/** What typing a target's label does: a text field (or a list, a slider)
 *  gets the keyboard, anything else is clicked. The labels go first, so
 *  what the click opens isn't counted as a reason to put them away. */
export function activateChromeHint(target: ChromeHintTarget): void {
  cancelChromeHints('picked')
  const { el, popup } = target
  if (!el.isConnected) {
    log.warn('chrome-hints: the picked control is gone', { id: target.id })
    return
  }
  log.action('chrome-hints: pick', { tag: el.tagName.toLowerCase(), label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '' })
  if (!takesKeyboard(el)) {
    el.click()
    return
  }
  // The keyboard may be in a tab's page (a view of its own): the window, or
  // the popup, takes it back first, or the focus would only be the DOM's.
  if (popup) popup.focus()
  else window.electronAPI.focusWindowRenderer?.()
  el.focus({ preventScroll: true })
  if (el.tagName === 'SELECT') {
    try {
      (el as HTMLSelectElement).showPicker()
    } catch (err) {
      log.warn('chrome-hints: showPicker failed', err)
    }
  }
}
