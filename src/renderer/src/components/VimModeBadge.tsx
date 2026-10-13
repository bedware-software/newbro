import type { VimMode } from '../lib/vim-mode'

interface Props {
  mode: VimMode
  /** Keys typed so far of an unfinished sequence (vim's showcmd). */
  pending?: string
  /** `field` ends a text field — the address bar, InputField — clear of
   *  its edge; `sm` sits in a text row. */
  size?: 'sm' | 'field'
}

const MODE_STYLE: Record<VimMode, { label: string; title: string }> = {
  command: { label: 'CMD', title: 'Vim: COMMAND mode — the browser has the keys' },
  browse: { label: 'WEB', title: 'Vim: BROWSE mode — the page, driven by its Vim keys' },
  insert: { label: 'INS', title: 'Vim: INSERT mode — keys go where you type; Esc to leave' },
}

/** Vim's mode as a key cap, the hint bars' kind: CMD, WEB or INS, its rim
 *  in the mode's colour (kbd.vim-mode in globals.css). The keys typed so
 *  far of an unfinished sequence show as a cap to its left. */
export function VimModeBadge({ mode, pending, size = 'sm' }: Props) {
  const style = MODE_STYLE[mode]
  return (
    <span
      className={`relative shrink-0 flex items-center select-none ${size === 'field' ? 'mr-2' : ''}`}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <kbd className="vim-mode" data-mode={mode} title={style.title}>{style.label}</kbd>
      {pending && (
        <span className="absolute right-full mr-1.5 top-1/2 -translate-y-1/2 flex text-[11px] font-medium">
          <kbd>{pending}</kbd>
        </span>
      )}
    </span>
  )
}
