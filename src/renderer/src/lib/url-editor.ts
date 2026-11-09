// Whether the address editor (components/UrlEditor.tsx) is up, and how it
// opened. Every edit of the address happens in it: a click on the address
// bar opens it, so does Vim's e, and a new tab (nt / nn) opens with it. The
// mode it starts in for each is Settings' (General → Address editor):
// typing (INSERT) for a click and a new tab, COMMAND for e — on a page
// you're on you mostly want its blocks, on a new one an address to type.
// The toolbar shows workspace stats where the address bar was while it's
// up.

import { create } from 'zustand'
import { useAppStore } from '../store/app-store'

export type UrlEditorMode = 'insert' | 'command'
/** What opened it: a click on the address bar (or its label), a new tab,
 *  Vim's e. */
export type UrlEditorOpening = 'click' | 'new-tab' | 'edit'

export const DEFAULT_URL_EDITOR_MODES: Readonly<Record<UrlEditorOpening, UrlEditorMode>> = {
  click: 'insert',
  'new-tab': 'insert',
  edit: 'command',
}

let modes: Record<UrlEditorOpening, UrlEditorMode> = { ...DEFAULT_URL_EDITOR_MODES }

/** Settings' choice of the mode each opening starts in. */
export function setUrlEditorModes(next: Partial<Record<UrlEditorOpening, UrlEditorMode>>): void {
  modes = { ...modes, ...next }
}

export const useUrlEditorStore = create<{
  open: boolean
  /** The mode it opened in. */
  mode: UrlEditorMode
  /** An empty box, whatever the tab's address: a new tab's. */
  blank: boolean
}>(() => ({ open: false, mode: 'insert', blank: false }))

/** Opens it on the active tab's address — a page of the browser's own
 *  (Downloads, Bangs) as any other — in the mode Settings gives `how`.
 *  Parked on a group there's no address: a click (or Cmd+L) opens it empty,
 *  what's typed going to a new tab; e has nothing to edit and returns
 *  false. */
export function openUrlEditor(how: UrlEditorOpening = 'edit'): boolean {
  const tab = useAppStore.getState().getActiveTab()
  if (!tab && how === 'edit') return false
  useUrlEditorStore.setState({ open: true, mode: modes[how], blank: how === 'new-tab' || !tab })
  return true
}

export function closeUrlEditor(): void {
  useUrlEditorStore.setState({ open: false })
}
