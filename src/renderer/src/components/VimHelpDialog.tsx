import { useCallback, useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import { InputField } from './InputField'
import { VimModeBadge } from './VimModeBadge'
import { usePopupVimMode, type VimMode } from '../lib/vim-mode'
import { vimKeyCaps } from './KeyHints'
import { fuzzyFilter } from '../lib/fuzzy'
import { keysFor, vimCommandLabel, vimCommandsInOrder, type ParsedVimKeymap, type VimContext, type VimKeymap } from '../lib/vim-keymap'

interface Props {
  open: boolean
  keymap: ParsedVimKeymap
  /** The window's own COMMAND keys (helpKeymap); null while Vim mode is
   *  off, when the filter just takes the keyboard. */
  vimKeymap: VimKeymap | null
  /** The mode it was opened from — its keys come first. */
  fromMode: VimMode
  onClose: () => void
}

const SECTIONS: Array<{ context: VimContext; title: string; mode: VimMode | null; note: string }> = [
  { context: 'command', title: 'COMMAND', mode: 'command', note: 'The page and the browser. In the page, keys not listed here reach it.' },
  { context: 'search', title: 'Search Everything · Command Palette', mode: null, note: 'Their COMMAND mode, out of the box (Esc); i types again.' },
  { context: 'find', title: 'Find in Page', mode: null, note: 'Its COMMAND mode, out of typing (Enter or Esc); i types again.' },
  { context: 'url', title: 'Address editor', mode: null, note: 'E in COMMAND. Blocks: h protocol, d domain, n port, 1–9 path levels, p parameters, f fragment. The intent\'s key again (yy, cc, rr): the whole address.' },
]

interface Row {
  command: string
  label: string
  keys: string[]
}

/** One j / k: about two rows of keys. */
const LINE_PX = 48

/** Vim mode's keys, as the keymap in Settings has them, with a fuzzy filter
 *  over what each key does, the keys themselves and the command ids.
 *
 *  In Vim mode it has its own COMMAND / INSERT pair, as Search Everything
 *  does: it opens in COMMAND, where j / k (and d / u, gg / G) scroll the keys,
 *  i types in the filter and ? or Esc closes; Esc in the filter goes back to
 *  COMMAND, keeping what was typed. Out of Vim mode the filter has the
 *  keyboard: Esc clears it, then closes; ? closes while it's empty. */
export function VimHelpDialog({ open, keymap, vimKeymap, fromMode, onClose }: Props) {
  const [popup, setPopup] = useState<Window | null>(null)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const scroll = useCallback((to: (list: HTMLDivElement) => number): void => {
    const list = listRef.current
    if (list) list.scrollTop = to(list)
  }, [])

  const vim = usePopupVimMode({
    keymap: vimKeymap,
    popup,
    box: inputRef,
    initial: 'command',
    open,
    onCommand: (command) => {
      switch (command) {
        case 'insert-mode': inputRef.current?.focus(); break
        case 'cursor-down': scroll((l) => l.scrollTop + LINE_PX); break
        case 'cursor-up': scroll((l) => l.scrollTop - LINE_PX); break
        case 'half-page-down': scroll((l) => l.scrollTop + l.clientHeight / 2); break
        case 'half-page-up': scroll((l) => l.scrollTop - l.clientHeight / 2); break
        case 'cursor-first': scroll(() => 0); break
        case 'cursor-last': scroll((l) => l.scrollHeight); break
      }
    },
    onEscape: onClose,
    // ? closes, as it opened it — it's no key of the help's own map.
    intercept: (e) => {
      if (e.key !== '?' || e.ctrlKey) return false
      onClose()
      return true
    },
  })

  useEffect(() => {
    if (!open) return
    setQuery('')
    // In Vim mode it opens in COMMAND, the keyboard on the window; out of
    // it, in the filter.
    if (vimKeymap) return
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // A new filter starts from the top.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [query])

  // Out of Vim mode: Esc clears the filter, then closes; ? closes while it's
  // empty. In Vim mode COMMAND's keys are usePopupVimMode's, and the
  // filter's own are handled on it (onFilterKeyDown).
  useEffect(() => {
    if (!popup || vimKeymap) return
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
  }, [popup, vimKeymap, query, onClose])

  // INSERT in Vim mode: Esc goes back to COMMAND, keeping the filter; ? on
  // an empty filter still closes.
  const onFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!vim.modeRef.current) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      inputRef.current?.blur()
    } else if (e.key === '?' && !query) {
      e.preventDefault()
      onClose()
    }
  }

  if (!open) return null

  const insertKey = vimKeyCaps(vimKeymap, 'insert-mode')[0]
  const scrollKeys = vimKeyCaps(vimKeymap, 'cursor-down', 'cursor-up')

  const maps: Record<VimContext, ParsedVimKeymap['main']> = { command: keymap.main, search: keymap.search, find: keymap.find, url: keymap.url }
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
        <div data-detached-drag-handle className="px-4 py-2.5 border-b border-border shrink-0">
          <InputField inputRef={inputRef} mode={vim.mode} pending={vim.pending} className="h-10">
            <Search size={16} className="shrink-0 text-muted-foreground" />
            <input
              data-detached-drag-handle
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFilterKeyDown}
              onFocus={vim.onBoxFocus}
              onBlur={vim.onBoxBlur}
              placeholder={vim.mode === 'command' && insertKey
                ? `Filter Vim keys: what they do, the keys, the command… (${insertKey} to type)`
                : 'Filter Vim keys: what they do, the keys, the command…'}
              className="flex-1 min-w-0 h-full bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
            />
          </InputField>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-5">
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
          <span>Esc or Ctrl+[ leaves INSERT · edit in Settings → Keyboard Shortcuts</span>
          {vim.mode === 'command' ? (
            <span className="flex items-center gap-1 shrink-0">
              {scrollKeys.length > 0 && <>Scroll {scrollKeys.map((k) => <kbd key={k}>{k}</kbd>)} · </>}
              {insertKey && <>Filter <kbd>{insertKey}</kbd> · </>}
              Close <kbd>Esc</kbd>
            </span>
          ) : vim.mode === 'insert' ? (
            <span className="flex items-center gap-1 shrink-0">Keys <kbd>Esc</kbd></span>
          ) : (
            <span className="flex items-center gap-1 shrink-0">{query ? 'Clear' : 'Close'} <kbd>Esc</kbd></span>
          )}
        </div>
      </div>
    </DetachedWindow>
  )
}
