import type { VimMode } from '../lib/vim-mode'

interface Props {
  mode: VimMode
  /** Keys typed so far of an unfinished sequence (vim's showcmd). */
  pending?: string
  /** `bar` fills the height of the address bar it sits in; `sm` sits in a
   *  text row. */
  size?: 'sm' | 'bar'
  className?: string
}

const MODE_STYLE: Record<VimMode, { label: string; className: string; title: string }> = {
  command: {
    label: 'COMMAND',
    className: 'bg-vim-command/15 text-vim-command',
    title: 'Vim: COMMAND mode — the browser has the keys',
  },
  browse: {
    label: 'BROWSE',
    className: 'bg-vim-browse-wash text-vim-browse',
    title: 'Vim: BROWSE mode — the page, driven by its Vim keys',
  },
  insert: {
    label: 'INSERT',
    className: 'bg-vim-insert/15 text-vim-insert',
    title: 'Vim: INSERT mode — keys go where you type; Esc to leave',
  },
}

/** Vim's mode block, as a statusline shows it: COMMAND in blue, BROWSE in
 *  yellow, INSERT in green — each a faint wash of its colour under text in
 *  it (BROWSE's wash is its own token, see globals.css), so the block reads
 *  at a glance without shouting. Square, and fixed
 *  width, so switching modes doesn't shift what follows. */
export function VimModeBadge({ mode, pending, size = 'sm', className = '' }: Props) {
  const style = MODE_STYLE[mode]
  return (
    <span
      className={`relative shrink-0 flex items-center justify-center font-mono font-bold select-none ${style.className} ${
        size === 'bar' ? 'h-full w-[96px] text-sm tracking-wide' : 'h-6 w-[74px] text-[11px] tracking-wider'
      } ${className}`}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      title={style.title}
    >
      {style.label}
      {pending && (
        <span className="absolute -bottom-1.5 -right-1.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded border border-border bg-popover text-popover-foreground text-[10px] font-medium tracking-normal">
          {pending}
        </span>
      )}
    </span>
  )
}
