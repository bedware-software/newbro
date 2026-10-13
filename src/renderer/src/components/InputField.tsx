// The one-line text field the keyboard popups share — the address editor,
// Find in Page, Search Everything, the Command Palette, the pickers, Vim
// help: a .field (globals.css) box around the input, with Vim's mode, while
// Vim mode is on, in a block tucked into its right end.

import type { ReactNode, RefObject } from 'react'
import { cn } from '../lib/utils'
import type { VimMode } from '../lib/vim-mode'
import { VimModeBadge } from './VimModeBadge'

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
  className?: string
}

export function InputField({ children, inputRef, onPress, mode, pending, className }: Props) {
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
        'field flex items-center gap-2 min-w-0 overflow-hidden rounded-xl pl-3 cursor-text',
        !mode && 'pr-3',
        className,
      )}
    >
      {children}
      {mode && <VimModeBadge mode={mode} pending={pending} size="field" />}
    </div>
  )
}
