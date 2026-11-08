// One choice of a few, as a row of buttons (Settings' theme, density,
// search engine, proxy…): a radiogroup of radios, the chosen one filled.
// Vim's form keys (lib/vim-form.ts) step through it with h / l, and Enter
// or Space goes round it.

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../lib/utils'

export interface SegmentedOption<T> {
  value: T
  label: ReactNode
  icon?: LucideIcon
  title?: string
}

interface Props<T> {
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (value: T) => void
  /** What's being chosen, for screen readers. */
  label: string
  /** Its data-vim-item id, for Vim's form keys. */
  vimItem?: string
  /** More choices than fit on a line wrap onto the next. */
  wrap?: boolean
  className?: string
}

export function Segmented<T extends string | boolean>({ value, options, onChange, label, vimItem, wrap = false, className }: Props<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-vim-item={vimItem}
      className={cn('flex w-fit gap-2 rounded-md', wrap && 'flex-wrap', className)}
    >
      {options.map(({ value: option, label: text, icon: Icon, title }) => {
        const chosen = option === value
        return (
          <button
            key={String(option)}
            type="button"
            role="radio"
            aria-checked={chosen}
            title={title}
            onClick={() => onChange(option)}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              Icon && 'flex items-center gap-1.5',
              chosen
                ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                : 'bg-secondary text-secondary-foreground hover:bg-muted',
            )}
          >
            {Icon && <Icon size={14} />}
            {text}
          </button>
        )
      })}
    </div>
  )
}
