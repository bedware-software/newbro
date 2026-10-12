import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import { VimModeBadge } from './VimModeBadge'
import type { VimMode } from '../lib/vim-mode'
import { fuzzyFilter } from '../lib/fuzzy'
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

interface Row {
  command: string
  label: string
  keys: string[]
}

/** Vim mode's keys, as the keymap in Settings has them, with a fuzzy filter
 *  over what each key does, the keys themselves and the command ids. Esc
 *  clears the filter, then closes; ? closes while the filter is empty. */
export function VimHelpDialog({ open, keymap, fromMode, onClose }: Props) {
  const [popup, setPopup] = useState<Window | null>(null)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  useEffect(() => {
    if (!popup) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (query) setQuery('')
        else onClose()
      } else if (e.key === '?' && !query) {
        e.preventDefault()
        onClose()
      }
    }
    popup.addEventListener('keydown', onKeyDown)
    return () => popup.removeEventListener('keydown', onKeyDown)
  }, [popup, query, onClose])

  if (!open) return null

  const maps: Record<VimContext, ParsedVimKeymap['main']> = { command: keymap.main, web: keymap.web, search: keymap.search }
  const commands = vimCommandsInOrder()
  const ordered = [...SECTIONS].sort((a, b) => Number(b.mode === fromMode) - Number(a.mode === fromMode))
  const sections = ordered.map((section) => {
    const map = maps[section.context]
    // Each map holds its own context's commands (Search also borrows the
    // cursor keys); list the bound ones in the config's order, or by match.
    const rows: Row[] = commands
      .map((command) => ({ command, label: vimCommandLabel(command), keys: keysFor(map, command) }))
      .filter((row) => row.keys.length > 0)
    const matching = fuzzyFilter(query, rows, (row) => [
      { value: row.label, weight: 1 },
      { value: row.keys.join(' '), weight: 0.9 },
      { value: row.command, weight: 0.7 },
      { value: section.title, weight: 0.3 },
    ])
    return { section, rows: matching }
  }).filter(({ rows }) => rows.length > 0)

  return (
    <DetachedWindow
      open={open}
      title="Vim Keys - Newbro"
      width={760}
      height={640}
      closeOnBlur
      // Esc clears the filter first; the window handles it.
      closeOnEscape={false}
      onClose={onClose}
      onWindowChange={setPopup}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div data-detached-drag-handle className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <span className="w-6 shrink-0 flex items-center">
            <Search size={16} className="text-muted-foreground" />
          </span>
          <input
            data-detached-drag-handle
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter Vim keys: what they do, the keys, the command…"
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-5">
          {sections.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No keys match</div>
          ) : sections.map(({ section, rows }) => (
            <section key={section.context}>
              <div className="flex items-center gap-2 mb-2">
                {section.mode ? <VimModeBadge mode={section.mode} /> : <span className="text-xs font-semibold uppercase tracking-wider">{section.title}</span>}
                <span className="text-[11px] text-muted-foreground">{section.note}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                {rows.map(({ command, label, keys }) => (
                  <div key={command} className="flex items-center justify-between gap-3 text-xs py-0.5" title={command}>
                    <span className="truncate text-foreground">{label}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {keys.map((k) => <kbd key={k} className="font-mono">{k}</kbd>)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
        <div
          data-detached-drag-handle
          className="h-10 px-4 flex items-center justify-between border-t border-border bg-toolbar text-[11px] font-medium text-muted-foreground shrink-0"
        >
          <span>Esc climbs INSERT → WEB → COMMAND · Ctrl+[ jumps to COMMAND · edit in Settings → Keyboard Shortcuts</span>
          <span className="flex items-center gap-1 shrink-0">{query ? 'Clear' : 'Close'} <kbd>Esc</kbd></span>
        </div>
      </div>
    </DetachedWindow>
  )
}
