// The key hint bar the Downloads page introduced, shared by every keyboard
// surface — Downloads, Search Everything, the Command Palette, Find in Page,
// the address editor, the pickers, the Sidebar and the Bookshelf: "Label
// <key> <key>" items in the toolbar tone, each key its own cap, always along
// the bottom.

import type { ReactNode } from 'react'
import { cn } from '../lib/utils'
import { displayKeySequence, keysFor, type VimKeymap } from '../lib/vim-keymap'

export function Hint({ label, keys }: { label: ReactNode; keys: ReactNode[] }) {
  if (keys.length === 0) return null
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      {label}
      {keys.map((key, i) => <kbd key={i}>{key}</kbd>)}
    </span>
  )
}

/** One cap at the hint bar's size wherever it sits — in a search box, or
 *  on a button whose own text is bigger. `onField`: the cap sits on a text
 *  field, whose fill is the cap's own — it takes a lighter one so it reads
 *  as a cap, the way it does on the hint bar. */
export function KeyCap({ children, onField = false }: { children: ReactNode; onField?: boolean }) {
  return (
    <span className="inline-flex text-[11px] font-medium leading-none">
      <kbd data-on-field={onField ? '' : undefined}>{children}</kbd>
    </span>
  )
}

interface BarProps {
  children: ReactNode
  /** Narrow panels: hints wrap onto more rows instead of being cut off. */
  wrap?: boolean
  className?: string
}

/** The bar, for the bottom of whatever it's for: the line is on top. */
export function HintBar({ children, wrap = false, className }: BarProps) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center gap-x-3 border-t border-border bg-toolbar px-4 text-[11px] font-medium text-muted-foreground',
        wrap ? 'flex-wrap gap-y-1.5 py-2' : 'h-10 overflow-hidden whitespace-nowrap',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** The Sidebar's and the Bookshelf's keys, at the bottom of the panel —
 *  wrapping, since a panel is narrow. Faded while the COMMAND cursor is
 *  elsewhere (another panel, or the keys are in the page). */
export function PanelHintBar({ panel, keymap, active }: { panel: 'sidebar' | 'bookshelf'; keymap: VimKeymap; active: boolean }) {
  const caps = (...commands: string[]): string[] => vimKeyCaps(keymap, ...commands)
  return (
    <HintBar wrap className={cn('px-2 transition-opacity', !active && 'opacity-50')}>
      <Hint label="Navigate" keys={caps('cursor-down', 'cursor-up')} />
      <Hint label="Open" keys={caps('row-open')} />
      <Hint label="Show" keys={caps('row-show')} />
      {panel === 'sidebar' && <Hint label="Switch" keys={caps('cursor-down-show', 'cursor-up-show')} />}
      <Hint label="Move" keys={caps('row-move-down', 'row-move-up')} />
      <Hint label={panel === 'sidebar' ? 'Close' : 'Remove'} keys={caps('row-close')} />
      <Hint label="Menu" keys={caps('row-menu')} />
      {!active && <Hint label="Cursor here" keys={caps(panel === 'sidebar' ? 'focus-sidebar' : 'focus-bookshelf')} />}
    </HintBar>
  )
}

/** The caps for `commands` as `map` binds them — each command's first key,
 *  written the way a keycap reads (Enter, Ctrl+J). */
export function vimKeyCaps(map: VimKeymap | null, ...commands: string[]): string[] {
  if (!map) return []
  const out: string[] = []
  for (const command of commands) {
    const first = keysFor(map, command)[0]
    if (first) out.push(displayKeySequence(first))
  }
  return out
}

/** Every key `map` binds to `command`, as caps — for a command whose keys
 *  are all worth knowing (Find's j / n). */
export function vimKeyCapsAll(map: VimKeymap | null, command: string): string[] {
  return map ? keysFor(map, command).map(displayKeySequence) : []
}
