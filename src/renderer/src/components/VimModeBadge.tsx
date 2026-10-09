import type { VimMode } from '../lib/vim-mode'

interface Props {
  mode: VimMode
  /** Keys typed so far of an unfinished sequence (vim's showcmd). */
  pending?: string
}

/** Vim's mode block, as a statusline shows it: COMMAND on blue, INSERT on
 *  green. Fixed width, so switching modes doesn't shift what follows. */
export function VimModeBadge({ mode, pending }: Props) {
  return (
    <span
      className={`relative h-6 w-[74px] shrink-0 flex items-center justify-center rounded-sm font-mono text-[11px] font-bold tracking-wider text-white select-none ${
        mode === 'command' ? 'bg-blue-600' : 'bg-green-600'
      }`}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      title={mode === 'command' ? 'Vim: COMMAND mode — i for INSERT' : 'Vim: INSERT mode — Esc for COMMAND'}
    >
      {mode === 'command' ? 'COMMAND' : 'INSERT'}
      {pending && (
        <span className="absolute -bottom-1.5 -right-1.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded border border-border bg-popover text-popover-foreground text-[10px] font-medium tracking-normal">
          {pending}
        </span>
      )}
    </span>
  )
}
