// The window's Vim keymap for the dialogs that can open from anywhere — the
// pickers (Move Tab…, Open Link), the confirmations, the name prompts, the
// sign-in prompt — so each needn't be handed it through every component on
// the way there. App publishes the parsed keymap; it's null while Vim mode is
// off. A dialog takes the keys it needs from it the way the popups App hands
// a keymap to do (paletteKeymap and the like).

import { useEffect, useSyncExternalStore } from 'react'
import { SEQUENCE_JOIN, type VimKeymap } from '../../../shared/vim-keys'
import type { ParsedVimKeymap } from './vim-keymap'

let current: ParsedVimKeymap | null = null
const listeners = new Set<() => void>()

/** App: publishes the window's keymap; null while Vim mode is off. */
export function usePublishWindowVimKeymap(keymap: ParsedVimKeymap | null): void {
  useEffect(() => {
    current = keymap
    listeners.forEach((l) => l())
  }, [keymap])
}

/** The window's keymap as App last published it; null while Vim mode is off. */
export function useWindowVimKeymap(): ParsedVimKeymap | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => { listeners.delete(l) }
    },
    () => current,
  )
}

/** The part of `map` bound to `commands`, each under the same keys. */
export function keymapOnly(map: VimKeymap, commands: readonly string[]): VimKeymap {
  const wanted = new Set(commands)
  const out: VimKeymap = new Map()
  for (const [seq, command] of map) if (wanted.has(command)) out.set(seq, command)
  return out
}

/** `map` with every key `from` binds to one of `sources` added as `as` —
 *  the page's back key (h) folding a dialog's row, say. A key `map` already
 *  has, or one that would clash with it (one being the start of the other),
 *  is left out: the dialog's own keys win. */
export function withKeysOf(map: VimKeymap, from: VimKeymap, sources: readonly string[], as: string): VimKeymap {
  const wanted = new Set(sources)
  const out: VimKeymap = new Map(map)
  for (const [seq, command] of from) {
    if (!wanted.has(command)) continue
    const clashes = [...out.keys()].some((existing) =>
      existing === seq || existing.startsWith(seq + SEQUENCE_JOIN) || seq.startsWith(existing + SEQUENCE_JOIN))
    if (!clashes) out.set(seq, as)
  }
  return out
}
