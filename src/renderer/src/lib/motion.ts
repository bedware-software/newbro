// Whether the app's own decorations move — the light round a field's edge
// (ModeEdge), the mark's glitch (BrandMark). A Settings → Appearance choice:
// 'system' goes by the OS (Reduce motion on macOS, "Animation effects" on
// Windows — Chromium's prefers-reduced-motion), 'always' moves them whatever
// the OS says, 'never' keeps them still. Null is no choice made yet, and
// nothing is saved for it: each platform takes its own default then, so
// settings synced or imported from a Mac don't pin 'system' onto Windows,
// nor the other way round.
//
// What it comes to is data-reduce-motion on the root, which globals.css
// stills them by. Every renderer document imports this, so each has the
// platform's default from its first frame; the main window then applies the
// saved choice (App.tsx), and a detached window — drawn from the main
// window's code into a document of its own — is handed the root's attribute
// along with the theme (DetachedWindow.tsx).

export type MotionChoice = 'system' | 'always' | 'never'

export const MOTIONS: readonly { id: MotionChoice; label: string; hint: string }[] = [
  { id: 'system', label: 'Follow system', hint: 'Still when the OS asks for less motion: Reduce motion on macOS, "Animation effects" turned off on Windows.' },
  { id: 'always', label: 'Always', hint: 'They move whatever the OS says.' },
  { id: 'never', label: 'Never', hint: 'They stay still.' },
] as const

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'
const ATTRIBUTE = 'data-reduce-motion'

/** Windows has "Animation effects" off on many machines for reasons that
 *  have nothing to do with a browser's own lights (remote desktop, a
 *  performance preset), so there they move until told otherwise; macOS and
 *  Linux go by the OS. */
export function defaultMotion(): MotionChoice {
  const onWindows = typeof navigator !== 'undefined' && navigator.platform.startsWith('Win')
  return onWindows ? 'always' : 'system'
}

/** A saved value as a choice, or null for none made (or one unknown here). */
export function normalizeMotion(value: unknown): MotionChoice | null {
  return MOTIONS.some((m) => m.id === value) ? (value as MotionChoice) : null
}

/** The choice in effect: the one made, or the platform's default. */
export function effectiveMotion(choice: MotionChoice | null | undefined): MotionChoice {
  return choice ?? defaultMotion()
}

let current: MotionChoice | null = null

function refresh(): void {
  if (typeof document === 'undefined') return
  const motion = effectiveMotion(current)
  const reduced = motion === 'never' || (motion === 'system' && window.matchMedia(REDUCE_QUERY).matches)
  document.documentElement.toggleAttribute(ATTRIBUTE, reduced)
}

export function applyMotion(choice: MotionChoice | null | undefined): void {
  current = choice ?? null
  refresh()
}

/** Hand this document's answer to a document drawn from here (a detached
 *  window's). */
export function syncMotionTo(doc: Document): void {
  doc.documentElement.toggleAttribute(ATTRIBUTE, document.documentElement.hasAttribute(ATTRIBUTE))
}

export const MOTION_ATTRIBUTE = ATTRIBUTE

// The platform's default until a choice is applied, and the OS's setting
// followed live while on 'system'.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  refresh()
  window.matchMedia(REDUCE_QUERY).addEventListener('change', refresh)
}
