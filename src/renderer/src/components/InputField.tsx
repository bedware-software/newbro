// The one-line text field the keyboard popups share — the address editor,
// Find in Page, Search Everything, the Command Palette, the pickers, Vim
// help: a .field (globals.css) box around the input, with Vim's mode, while
// Vim mode is on, in a block tucked into its right end.

import type { ReactNode, RefObject } from 'react'
import { cn } from '../lib/utils'
import type { VimMode } from '../lib/vim-mode'
import { VimModeBadge } from './VimModeBadge'
import { ModeEdge } from './ModeEdge'
import { useVimEdge, useVimEdgeEverywhere } from '../lib/vim-edge'

interface Props {
  /** What's in the box ahead of the mode: the input, and any icon or count
   *  beside it. */
  children: ReactNode
  /** The input. A press anywhere else in the box puts the caret in it. */
  inputRef: RefObject<HTMLInputElement | null>
  /** Such a press, when it means more than focusing the input as it is. */
  onPress?: () => void
  /** Null while Vim mode is off, or for a field that has no modes. */
  mode: VimMode | null
  /** Keys typed so far of an unfinished sequence. */
  pending?: string
  /** The address's own field (the address editor): the mode's light runs
   *  round its edge as round the address bar's, by default, not only with
   *  Settings' "every field". */
  addressBar?: boolean
  className?: string
}

export function InputField({ children, inputRef, onPress, mode, pending, addressBar = false, className }: Props) {
  // With the mode's light on its edge too (Settings → Appearance, every
  // field, or the address's own), it lets what spills past its edge show.
  const edge = useVimEdge()
  const everywhere = useVimEdgeEverywhere()
  const edgeShown = (addressBar || everywhere) && mode !== null && edge !== 'off'
  return (
    <div
      onMouseDown={(e) => {
        const input = inputRef.current
        if (!input || e.target === input) return
        e.preventDefault()
        if (onPress) onPress()
        else input.focus()
      }}
      className={cn(
        'field relative flex items-center gap-2 min-w-0 rounded-xl pl-3 cursor-text',
        !edgeShown && 'overflow-hidden',
        !mode && 'pr-3',
        className,
      )}
    >
      {children}
      {mode && <VimModeBadge mode={mode} pending={pending} size="field" />}
      <ModeEdge mode={mode} addressBar={addressBar} />
    </div>
  )
}
