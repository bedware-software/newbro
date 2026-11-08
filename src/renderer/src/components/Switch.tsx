// An on/off switch (role=switch), the one Settings and Dark pages' popover
// share: a pill with a knob, the knob to the right and the pill coloured
// while it's on. Inside a <label>, a click on the label's text flips it too.
// Vim's form keys (lib/vim-form.ts) know it as a toggle: Space or Enter
// flips it, h turns it off and l on.

import { cn } from '../lib/utils'

interface Props {
  checked: boolean
  onChange: (checked: boolean) => void
  /** What it switches, for screen readers (and its tooltip, without `title`). */
  label: string
  title?: string
  disabled?: boolean
  /** `md` heads a section (Vim Mode); `sm` sits in a row. */
  size?: 'sm' | 'md'
  /** Its data-vim-item id, for Vim's form keys. */
  vimItem?: string
  /** Its data-vim-cell name, as a row's button. */
  vimCell?: string
  className?: string
}

export function Switch({ checked, onChange, label, title, disabled = false, size = 'sm', vimItem, vimCell, className }: Props) {
  const md = size === 'md'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      data-vim-item={vimItem}
      data-vim-cell={vimCell}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full px-0.5 transition-colors',
        md ? 'h-6 w-11' : 'h-5 w-9',
        checked ? 'bg-primary' : 'bg-muted-foreground/30 hover:bg-muted-foreground/40',
        disabled && 'opacity-50 cursor-not-allowed hover:bg-muted-foreground/30',
        className,
      )}
    >
      <span
        className={cn(
          'rounded-full bg-white shadow-sm transition-transform duration-200',
          md ? 'h-5 w-5' : 'h-4 w-4',
          checked ? (md ? 'translate-x-5' : 'translate-x-4') : 'translate-x-0',
        )}
      />
    </button>
  )
}
