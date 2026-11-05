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

/** The Sidebar's keys, at the bottom of it — wrapping, since it's narrow.
 *  Faded until one of them is used, which brings them to life. */
export function SidebarHintBar({ keymap, active }: { keymap: VimKeymap; active: boolean }) {
  const caps = (...commands: string[]): string[] => vimKeyCaps(keymap, ...commands)
  return (
    <HintBar wrap className={cn('px-2 transition-opacity', !active && 'opacity-50')}>
      <Hint label="Switch" keys={caps('cursor-down-show', 'cursor-up-show')} />
      <Hint label="Move" keys={caps('row-move-down', 'row-move-up')} />
      <Hint label="Fold" keys={caps('row-fold', 'row-unfold')} />
      <Hint label="Menu" keys={caps('row-menu')} />
      <Hint label="Close" keys={caps('close-tab')} />
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

/** A list row's key in Vim mode, as a keycap filling the row's left padding
 *  (positioned by the row, so its content never moves; a span, as the
 *  global kbd style's padding would widen it): in COMMAND its two-letter
 *  label — the part typed so far lit, rows it no longer fits faded — and in
 *  INSERT just its number, to read. Nothing while Vim mode is off. */
export function RowHint({ mode, label, number, pending, className }: {
  mode: 'command' | 'insert' | null
  label?: string
  number: number
  /** Keys typed so far of an unfinished sequence. */
  pending?: string
  className?: string
}) {
  if (!mode || (mode === 'command' && !label)) return null
  const typed = mode === 'command' && pending && label?.startsWith(pending) ? pending.length : 0
  const faded = mode === 'command' && !!pending && !typed
  return (
    <span
      aria-hidden="true"
      className={cn(
        'z-10 inline-flex items-center justify-center h-[18px] min-w-4 px-px rounded-md border border-border bg-popover text-foreground font-mono font-medium text-[10px] leading-none tabular-nums shadow-[0_0_2px_rgb(0_0_0/0.1)] select-none pointer-events-none transition-opacity',
        faded && 'opacity-30',
        className,
      )}
    >
      {mode === 'command'
        ? <><span className="text-primary">{label!.slice(0, typed)}</span>{label!.slice(typed)}</>
        : number}
    </span>
  )
}
