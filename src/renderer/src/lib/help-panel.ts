// Whether the keys' help (Vim's ?) is up: the Keys page (vimperium://keys,
// components/KeysPage.tsx) the tab in front. While it is, the header's
// buttons show their keys (HeaderHint.tsx), and the Sidebar its own.

import { useAppStore } from '../store/app-store'
import { KEYS_URL, internalPageOf } from './internal-pages'
import { closePage, togglePage } from './page-nav'

/** `select` of whether the keys' help is up. */
export function useHelpPanelStore<T>(select: (s: { open: boolean }) => T): T {
  return useAppStore((s) => select({ open: internalPageOf(s.getActiveTab()?.url) === 'keys' }))
}

export function toggleHelpPanel(): void {
  togglePage(KEYS_URL)
}

export function closeHelpPanel(): void {
  closePage('keys')
}
