// Whether the address editor (components/UrlEditor.tsx, Vim's E) is up. The
// toolbar shows workspace stats where the address bar was while it is.

import { create } from 'zustand'
import { useAppStore } from '../store/app-store'
import { isInternalUrl } from './internal-pages'

export const useUrlEditorStore = create<{ open: boolean }>(() => ({ open: false }))

/** Opens it on the active tab's address. False with no address to edit:
 *  parked on a group, or on a page of the browser's own (Downloads, Bangs),
 *  where e is the page's or nothing — never the address editor over it. */
export function openUrlEditor(): boolean {
  const tab = useAppStore.getState().getActiveTab()
  if (!tab || isInternalUrl(tab.url)) return false
  useUrlEditorStore.setState({ open: true })
  return true
}

export function closeUrlEditor(): void {
  useUrlEditorStore.setState({ open: false })
}
