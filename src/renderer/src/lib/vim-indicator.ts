// How Vim's mode key cap (VimModeBadge) shows the mode's colour — a
// Settings → Appearance choice while Vim mode is on. The caps read it
// through useVimIndicator, so every cap follows a change at once, popups'
// included (they render from this window). The looks are kbd.vim-mode's
// [data-indicator] rules in globals.css.

import { useSyncExternalStore } from 'react'

export type VimIndicator = 'rim-label' | 'rim' | 'label' | 'tint' | 'base' | 'dot' | 'plain'

export const VIM_INDICATORS: readonly { id: VimIndicator; label: string; hint: string }[] = [
  { id: 'rim-label', label: 'Rim and label', hint: 'The rim and the label in the mode\'s colour.' },
  { id: 'rim', label: 'Rim', hint: 'Only the rim in the mode\'s colour.' },
  { id: 'label', label: 'Label', hint: 'Only the label in the mode\'s colour.' },
  { id: 'tint', label: 'Rim and tint', hint: 'The rim in the mode\'s colour over a faint wash of it.' },
  { id: 'base', label: 'Base', hint: 'A thick bottom edge in the mode\'s colour, like a key\'s base.' },
  { id: 'dot', label: 'Dot', hint: 'A dot in the mode\'s colour before the label.' },
  { id: 'plain', label: 'Plain', hint: 'No colour: the label alone tells the mode.' },
] as const

export const DEFAULT_VIM_INDICATOR: VimIndicator = 'rim-label'

export function normalizeVimIndicator(value: string | undefined): VimIndicator {
  return VIM_INDICATORS.some((v) => v.id === value) ? (value as VimIndicator) : DEFAULT_VIM_INDICATOR
}

let current: VimIndicator = DEFAULT_VIM_INDICATOR
const listeners = new Set<() => void>()

export function applyVimIndicator(indicator: VimIndicator): void {
  if (indicator === current) return
  current = indicator
  listeners.forEach((listener) => listener())
}

export function useVimIndicator(): VimIndicator {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => current,
  )
}
