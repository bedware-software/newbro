import type { VimMode } from '../lib/vim-mode'

interface Props {
  mode: VimMode
  /** Keys typed so far of an unfinished sequence (vim's showcmd). */
  pending?: string
  /** `md` matches the toolbar's controls; `sm` sits in a text row. */
  size?: 'sm' | 'md'
}

const MODE_STYLE: Record<VimMode, { label: string; className: string; title: string }> = {
  command: { label: 'COMMAND', className: 'bg-blue-600', title: 'Vim: COMMAND mode — the browser has the keys' },
  web: { label: 'WEB', className: 'bg-purple-600', title: 'Vim: WEB mode — the page, driven by its Vim keys' },
  insert: { label: 'INSERT', className: 'bg-green-600', title: 'Vim: INSERT mode — keys go where you type; Esc to leave' },
}

/** Vim's mode block, as a statusline shows it: COMMAND on blue, WEB on
 *  purple, INSERT on green. Fixed width, so switching modes doesn't shift
 *  what follows. */
export function VimModeBadge({ mode, pending, size = 'sm' }: Props) {
  const style = MODE_STYLE[mode]
  return (
    <span
      className={`relative shrink-0 flex items-center justify-center font-mono font-bold tracking-wider text-white select-none ${style.className} ${
        size === 'md' ? 'h-8 w-[84px] rounded-md text-xs' : 'h-6 w-[74px] rounded-sm text-[11px]'
      }`}
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
