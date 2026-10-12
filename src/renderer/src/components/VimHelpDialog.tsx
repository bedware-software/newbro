import { useEffect, useState } from 'react'
import { DetachedWindow } from './DetachedWindow'
import { VimModeBadge } from './VimModeBadge'
import type { VimMode } from '../lib/vim-mode'
import { keysFor, vimCommandLabel, vimCommandsInOrder, type ParsedVimKeymap, type VimContext } from '../lib/vim-keymap'

interface Props {
  open: boolean
  keymap: ParsedVimKeymap
  /** The mode it was opened from — its keys come first. */
  fromMode: VimMode
  onClose: () => void
}

const SECTIONS: Array<{ context: VimContext; title: string; mode: VimMode | null; note: string }> = [
  { context: 'command', title: 'COMMAND', mode: 'command', note: 'The browser: tabs, panels, app commands.' },
  { context: 'web', title: 'WEB', mode: 'web', note: 'The page. Keys not listed here reach the page.' },
  { context: 'search', title: 'Search Everything', mode: null, note: 'The search window, before i drops into the search box.' },
]

/** Vim mode's keys, as the keymap in Settings has them. ? or Esc closes it. */
export function VimHelpDialog({ open, keymap, fromMode, onClose }: Props) {
  const [popup, setPopup] = useState<Window | null>(null)

  useEffect(() => {
    if (!popup) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === '?' || e.key === 'q') {
        e.preventDefault()
        onClose()
      }
    }
    popup.addEventListener('keydown', onKeyDown)
    return () => popup.removeEventListener('keydown', onKeyDown)
  }, [popup, onClose])

  if (!open) return null

  const maps: Record<VimContext, ParsedVimKeymap['main']> = { command: keymap.main, web: keymap.web, search: keymap.search }
  const commands = vimCommandsInOrder()
  const ordered = [...SECTIONS].sort((a, b) => Number(b.mode === fromMode) - Number(a.mode === fromMode))

  return (
    <DetachedWindow
      open={open}
      title="Vim Keys - Newbro"
      width={760}
      height={640}
      closeOnBlur
      onClose={onClose}
      onWindowChange={setPopup}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div data-detached-drag-handle className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
          <span className="text-sm font-semibold">Vim keys</span>
          <span className="text-[11px] text-muted-foreground">
            Esc climbs INSERT → WEB → COMMAND · Ctrl+[ jumps to COMMAND · edit in Settings → Keyboard Shortcuts
          </span>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-5">
          {ordered.map((section) => {
            const map = maps[section.context]
            // Each map holds its own context's commands (Search also borrows
            // the cursor keys); list the bound ones in the config's order.
            const rows = commands
              .map((command) => ({ command, keys: keysFor(map, command) }))
              .filter((row) => row.keys.length > 0)
            return (
              <section key={section.context}>
                <div className="flex items-center gap-2 mb-2">
                  {section.mode ? <VimModeBadge mode={section.mode} /> : <span className="text-xs font-semibold uppercase tracking-wider">{section.title}</span>}
                  <span className="text-[11px] text-muted-foreground">{section.note}</span>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                  {rows.map(({ command, keys }) => (
                    <div key={command} className="flex items-center justify-between gap-3 text-xs py-0.5">
                      <span className="truncate text-foreground">{vimCommandLabel(command)}</span>
                      <span className="flex items-center gap-1 shrink-0">
                        {keys.map((k) => <kbd key={k} className="font-mono">{k}</kbd>)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </DetachedWindow>
  )
}
