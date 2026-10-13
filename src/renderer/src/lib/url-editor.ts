// Whether the address editor (components/UrlEditor.tsx, Vim's e) is up. The
// toolbar shows workspace stats where the address bar was while it is.

import { create } from 'zustand'
import { useAppStore } from '../store/app-store'

export const useUrlEditorStore = create<{ open: boolean }>(() => ({ open: false }))

/** Opens it on the active tab's address. False with no tab to edit (parked
 *  on a group). */
export function openUrlEditor(): boolean {
  if (!useAppStore.getState().getActiveTab()) return false
  useUrlEditorStore.setState({ open: true })
  return true
}

export function closeUrlEditor(): void {
  useUrlEditorStore.setState({ open: false })
}
