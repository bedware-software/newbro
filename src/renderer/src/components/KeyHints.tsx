// The key hint bar the Downloads page introduced, shared by every keyboard
// surface — Downloads, Search Everything, the Command Palette, Find in Page,
// the address editor, the pickers, the Sidebar and the Bookshelf: "Label
// <key> <key>" items in the toolbar tone, each key its own cap, always along
// the bottom.

import type { ReactNode } from 'react'
import { cn } from '../lib/utils'
import { displayKeySequence, keysFor, type VimKeymap } from '../lib/vim-keymap'
import type { WhichKeyEntry } from '../lib/which-key'

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
export function KeyCap({ children, onField = false, onPrimary = false }: {
  children: ReactNode
  onField?: boolean
  /** On a primary (filled) button: a see-through cap in the button's own
   *  text colour, readable in every theme. */
  onPrimary?: boolean
}) {
  return (
    <span className="inline-flex text-[11px] font-medium leading-none">
      <kbd data-on-field={onField ? '' : undefined} data-on-primary={onPrimary ? '' : undefined}>{children}</kbd>
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

/** The cap of the key that leaves a popup's field for COMMAND: Ctrl+C (⌃C
 *  on a Mac). Esc closes the popup. */
export const LEAVE_INSERT_CAP = displayKeySequence('<C-c>')

/** A list row's key in Vim mode, as a keycap filling the row's left padding
 *  (positioned by the row, so its content never moves; a span, as the
 *  global kbd style's padding would widen it): in COMMAND its label — the
 *  part typed so far lit, rows it no longer fits faded. Nothing in INSERT,
 *  where typing goes in the box and no key picks a row. */
export function RowHint({ mode, label, pending, className }: {
  mode: 'command' | 'insert' | null
  label?: string
  /** Keys typed so far of an unfinished sequence. */
  pending?: string
  className?: string
}) {
  if (mode !== 'command' || !label) return null
  const typed = pending && label.startsWith(pending) ? pending.length : 0
  const faded = !!pending && !typed
  return (
    <span
      aria-hidden="true"
      className={cn(
        'z-10 inline-flex items-center justify-center h-[18px] min-w-4 px-px rounded-md border border-border bg-popover text-foreground font-mono font-medium text-[10px] leading-none tabular-nums shadow-[0_0_2px_rgb(0_0_0/0.1)] select-none pointer-events-none transition-opacity',
        faded && 'opacity-30',
        className,
      )}
    >
      <span className="text-primary">{label.slice(0, typed)}</span>{label.slice(typed)}
    </span>
  )
}

/** The entries as hint bar items: the prefix typed, lit as the mode's
 *  showcmd is, then each next key with what it does. */
export function WhichKeyHints({ pending, entries }: { pending: string; entries: WhichKeyEntry[] }) {
  return (
    <>
      <span className="flex items-center gap-1 whitespace-nowrap text-foreground">
        <kbd className="font-mono text-primary">{displayKeySequence(pending)}</kbd>
        <span aria-hidden="true">→</span>
      </span>
      {entries.map((entry) => (
        <Hint key={entry.keys} label={entry.label} keys={[entry.keys]} />
      ))}
    </>
  )
}
