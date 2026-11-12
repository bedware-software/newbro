// How a text field's edge shows Vim's mode — the address bar, and the
// keyboard popups' boxes (InputField) too when asked for: a light that keeps moving round the
// edge in the mode's colours, COMMAND cool and INSERT green, crossfading as
// the mode changes. A Settings → Appearance choice while Vim mode is on; the
// fields read it through useVimEdge, so every field follows a change at
// once, popups' included (they render from this window). The looks are
// .mode-edge's [data-edge] rules in globals.css; ModeEdge draws them.

import { useSyncExternalStore } from 'react'

export type VimEdge = 'comet-rail' | 'comet-rail-sides' | 'comet' | 'comet-sides' | 'aurora' | 'living' | 'glint' | 'off'

export const VIM_EDGES: readonly { id: VimEdge; label: string; hint: string }[] = [
  { id: 'comet-rail', label: 'Comet on rail', hint: 'A comet runs round the edge over a faint ring in the mode\'s colours.' },
  { id: 'comet-rail-sides', label: 'Comet on rail, resting at the sides', hint: 'The same comet over its ring, slowing to rest at the left and right ends instead of the top and bottom.' },
  { id: 'comet', label: 'Comet', hint: 'A lone comet runs round the edge; the rest of it stays dark.' },
  { id: 'comet-sides', label: 'Comet, resting at the sides', hint: 'The lone comet, slowing to rest at the left and right ends instead of the top and bottom.' },
  { id: 'aurora', label: 'Aurora', hint: 'The mode\'s three colours slowly circle the edge, with a soft halo.' },
  { id: 'living', label: 'Living border', hint: 'The colours drift in place while the glow slowly swells and fades.' },
  { id: 'glint', label: 'Glint', hint: 'A ring in the mode\'s colours with a glint passing along it now and then.' },
  { id: 'off', label: 'Off', hint: 'A plain edge: the mode\'s key cap alone shows the mode.' },
] as const

export const DEFAULT_VIM_EDGE: VimEdge = 'comet-rail'

export function normalizeVimEdge(value: string | undefined): VimEdge {
  return VIM_EDGES.some((v) => v.id === value) ? (value as VimEdge) : DEFAULT_VIM_EDGE
}

/** Where it shows: the address bar alone (the default), or every field
 *  that shows the mode — the popups' boxes, Find, the address editor. */
export const DEFAULT_VIM_EDGE_EVERYWHERE = false

let current: VimEdge = DEFAULT_VIM_EDGE
let everywhere = DEFAULT_VIM_EDGE_EVERYWHERE
const listeners = new Set<() => void>()

export function applyVimEdge(edge: VimEdge, onEveryField: boolean): void {
  if (edge === current && onEveryField === everywhere) return
  current = edge
  everywhere = onEveryField
  listeners.forEach((listener) => listener())
}

// The window's in use or not, from main (the renderer's own focus goes to
// the page's view whenever the page has the keys): the edge stands still in
// a window that isn't, shown by data-window-inactive on the root.
if (typeof window !== 'undefined') {
  window.electronAPI?.onWindowActive?.((active) => {
    document.documentElement.toggleAttribute('data-window-inactive', !active)
  })
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useVimEdge(): VimEdge {
  return useSyncExternalStore(subscribe, () => current)
}

export function useVimEdgeEverywhere(): boolean {
  return useSyncExternalStore(subscribe, () => everywhere)
}
