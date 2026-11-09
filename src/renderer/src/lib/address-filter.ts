// The address bar as a page's filter. A page this window draws in the page
// area — the group page, Search Everything, the keys, the Bookshelf,
// Downloads, Bangs — has no box of its own to type in: while it shows, the
// address bar (components/Omnibox.tsx) is its filter, the page's name in a
// chip before it. What's typed is the page's query; ↑/↓, PageUp/PageDown
// and Tab typed there move through the page's rows, Enter opens the
// selected one — or, with nothing to open, what's typed as an address. Esc
// leaves the box for COMMAND, the filter kept.
//
// e (or a click on the bar, Cmd+L, the page's gi, i and /) types in it;
// E is the address editor, as on any page.

import { useEffect, useLayoutEffect, useRef } from 'react'
import { create } from 'zustand'

export interface AddressFilterKeyEvent {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

export interface AddressFilterSpec {
  /** The page's name, in the chip before the box. */
  label: string
  /** A group's colour for the chip, as its pill in the Sidebar wears it. */
  color?: string
  /** The box's placeholder. */
  placeholder: string
  /** A key typed in the box but Enter and Esc (↑ ↓ PageUp PageDown Tab…):
   *  true when the page took it. */
  onKey?: (e: AddressFilterKeyEvent) => boolean
  /** Enter: opens the selected row — false when there's none, and the bar
   *  opens what's typed as an address instead. */
  onEnter?: (e: AddressFilterKeyEvent) => boolean
}

interface AddressFilterState {
  /** The page whose filter the bar is; null on a web page. */
  owner: string | null
  spec: AddressFilterSpec | null
  query: string
  /** Which mounted page made the claim: two pages can share an owner (two
   *  Search Everything tabs), and only the claimant may give the bar back. */
  token: object | null
}

export const useAddressFilterStore = create<AddressFilterState>(() => ({ owner: null, spec: null, query: '', token: null }))

export function setAddressQuery(query: string): void {
  useAddressFilterStore.setState({ query })
}

/** Types in the filter: the window takes the keyboard from a page's view
 *  first. False when no page has the bar for its filter. */
export function focusAddressFilter(select = true): boolean {
  if (!useAddressFilterStore.getState().owner) return false
  window.electronAPI?.focusWindowRenderer?.()
  const bar = document.getElementById('url-bar')
  if (!(bar instanceof HTMLInputElement)) return false
  bar.focus()
  if (select) bar.select()
  return true
}

/**
 * Makes the address bar the filter of the page calling it, while it's
 * mounted and `spec` isn't null; returns what's typed. Another `owner`
 * (another group parked on, another page) starts from an empty filter.
 * The spec's callbacks are read when they're called: no need to keep them
 * stable.
 */
export function useAddressFilter(owner: string, spec: AddressFilterSpec | null): string {
  const specRef = useRef(spec)
  specRef.current = spec
  /** This mounted page's mark on its claim. */
  const token = useRef<object>({}).current
  const on = spec !== null
  const label = spec?.label
  const color = spec?.color
  const placeholder = spec?.placeholder

  useLayoutEffect(() => {
    if (!on) return
    const live: AddressFilterSpec = {
      label: label ?? '',
      color,
      placeholder: placeholder ?? '',
      onKey: (e) => specRef.current?.onKey?.(e) ?? false,
      onEnter: (e) => specRef.current?.onEnter?.(e) ?? false,
    }
    // A new name or placeholder (Search Everything's filter switched) keeps
    // what's typed; another owner, or another page with the same one,
    // starts from an empty filter.
    useAddressFilterStore.setState((s) => ({
      owner,
      spec: live,
      token,
      query: s.token === token && s.owner === owner ? s.query : '',
    }))
  }, [on, owner, label, color, placeholder, token])

  // Unmounting (or turning off) gives the bar back to the address — only
  // while the claim is still this page's own, for this owner. This runs
  // after the commit, so a page swapped for another in one go (one Search
  // Everything tab for the next) finds the incoming page's claim already
  // made and leaves it be; so does this page once it moved on to another
  // owner (another group parked on). Not in the claim's own cleanup: that
  // runs on every name or placeholder change too, and would wipe what's
  // typed each time.
  useEffect(() => {
    if (!on) return
    return () => {
      const s = useAddressFilterStore.getState()
      if (s.token === token && s.owner === owner) {
        useAddressFilterStore.setState({ owner: null, spec: null, query: '', token: null })
      }
    }
  }, [on, owner, token])

  const query = useAddressFilterStore((s) => (s.token === token && s.owner === owner ? s.query : ''))
  return query
}
