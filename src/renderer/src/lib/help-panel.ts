// Whether the keys' help (Vim's ?) is open: a panel on the window's right,
// beside the page, as the Bookshelf is (components/HelpPanel.tsx). While
// it's open the header's buttons show their keys too (HeaderHint.tsx).

import { create } from 'zustand'

export const useHelpPanelStore = create<{ open: boolean }>(() => ({ open: false }))

export function toggleHelpPanel(): void {
  useHelpPanelStore.setState((s) => ({ open: !s.open }))
}

export function closeHelpPanel(): void {
  useHelpPanelStore.setState({ open: false })
}
