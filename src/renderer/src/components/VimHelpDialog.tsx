import { useCallback, useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import { InputField } from './InputField'
import { VimModeBadge } from './VimModeBadge'
import { usePopupVimMode, type VimMode } from '../lib/vim-mode'
import { LEAVE_INSERT_CAP, vimKeyCaps } from './KeyHints'
import { fuzzyFilter } from '../lib/fuzzy'
import { isBlockKey } from '../lib/url-blocks'
import { keysFor, settingsCommandLabel, settingsCommandsInOrder, settingsKeymap, vimCommandLabel, vimCommandsInOrder, type ParsedVimKeymap, type VimContext, type VimKeymap } from '../lib/vim-keymap'
import { SEQUENCE_JOIN } from '../../../shared/vim-keys'

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

// Settings isn't a context of the keymap's own: its keys come from the
// main window's (settingsKeymap), and are listed here with the rest.
type HelpContext = VimContext | 'settings'

const SECTIONS: Array<{ context: HelpContext; title: string; mode: VimMode | null }> = [
  { context: 'command', title: 'COMMAND', mode: 'command' },
  { context: 'search', title: 'Search Everything · Command Palette', mode: null },
  { context: 'find', title: 'Find in Page', mode: null },
  { context: 'url', title: 'Address editor', mode: null },
  { context: 'settings', title: 'Settings', mode: null },
]

/** The keys `map` binds to `command` on their own, not as a sequence. */
function singleKeys(map: VimKeymap, command: string): string[] {
  const out: string[] = []
  for (const [seq, bound] of map) if (bound === command && !seq.includes(SEQUENCE_JOIN)) out.push(seq)
  return out
}

/** "a", "a and b", "a, b and c". */
function listed(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** What a section says above its keys, naming them as the keymap has them
 *  (the user's own included). */
function sectionNote(context: HelpContext, keymap: ParsedVimKeymap): string {
  const typesAgain = (map: VimKeymap): string => {
    const key = keysFor(map, 'insert-mode')[0]
    return key ? `; ${key} types again.` : '.'
  }
  switch (context) {
    case 'command':
      return 'The page and the browser. In the page, keys not listed here reach it.'
    case 'search':
      return `Their COMMAND mode, out of the box (${LEAVE_INSERT_CAP}); Esc closes from either${typesAgain(keymap.search)}`
    case 'find':
      return `Its COMMAND mode, out of typing (Enter or ${LEAVE_INSERT_CAP}); Esc closes from either${typesAgain(keymap.find)}`
    case 'url': {
      const opens = keysFor(keymap.main, 'edit-url')[0]
      // An intent's key pressed again is the whole address, unless it's a
      // block's key too (d: dd is the domain) — UrlEditor's intercept.
      const twice = ['url-copy', 'url-change']
        .map((command) => singleKeys(keymap.url, command).find((key) => !isBlockKey(key)))
        .filter((key): key is string => key !== undefined)
        .map((key) => key + key)
      const removeAll = keysFor(keymap.url, 'url-remove-all')[0]
      const pasteAll = keysFor(keymap.url, 'url-paste-all')[0]
      const whole = [
        twice.length > 0 ? `${listed(twice)} act${twice.length === 1 ? 's' : ''} on the whole address` : '',
        removeAll ? `${removeAll} removes all of it` : '',
        pasteAll ? `${pasteAll} pastes over all of it` : '',
      ].filter(Boolean)
      return [
        opens ? `Opens with ${opens} in COMMAND.` : 'Opens from the Command Palette (Edit Address).',
        `${LEAVE_INSERT_CAP} leaves typing; Esc closes.`,
        'Blocks: h protocol, d domain, n port, 1–9 path levels, p parameters, f fragment.',
        whole.length > 0 ? `${listed(whole)}.` : '',
      ].filter(Boolean).join(' ')
    }
    case 'settings':
      return `Its COMMAND mode, which it opens in. Every setting wears a label too; typing it goes there. ${LEAVE_INSERT_CAP} leaves a field; Esc steps back out — a list, the filter — then closes.`
  }
}

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
 *  does: it opens in COMMAND, where j / k (and Ctrl+D / Ctrl+U, gg / G)
 *  scroll the keys, i types in the filter and ? or Esc closes; Ctrl+C in
 *  the filter goes back to COMMAND, keeping what was typed, and Esc there
 *  closes too. Out of Vim mode the
 *  filter has the keyboard: Esc clears it, then closes; ? closes while it's
 *  empty. */
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

  // INSERT in Vim mode: ? on an empty filter still closes. Ctrl+C (back to
  // COMMAND, keeping the filter) and Esc (closing) are usePopupVimMode's.
  const onFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!vim.modeRef.current) return
    if (e.key === '?' && !query) {
      e.preventDefault()
      onClose()
    }
  }

  if (!open) return null

  const insertKey = vimKeyCaps(vimKeymap, 'insert-mode')[0]
  const scrollKeys = vimKeyCaps(vimKeymap, 'cursor-down', 'cursor-up')

  const maps: Record<HelpContext, ParsedVimKeymap['main']> = {
    command: keymap.main, search: keymap.search, find: keymap.find, url: keymap.url, settings: settingsKeymap(keymap),
  }
  const commands = vimCommandsInOrder()
  const settingsCommands = settingsCommandsInOrder()
  const ordered = [...SECTIONS].sort((a, b) => Number(b.mode === fromMode) - Number(a.mode === fromMode))
  const sections = ordered.map((section) => {
    const map = maps[section.context]
    // Each map holds its own context's commands (Search also borrows the
    // cursor keys); list the bound ones in the config's order, or by match.
    const settings = section.context === 'settings'
    const rows: Row[] = (settings ? settingsCommands : commands)
      .map((command) => ({ command, label: settings ? settingsCommandLabel(command) : vimCommandLabel(command), keys: keysFor(map, command) }))
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
      title="Vim Keys - Vimperium"
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
                <span className="text-[11px] text-muted-foreground">{sectionNote(section.context, keymap)}</span>
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
          <span>Esc or Ctrl+[ leaves INSERT; in a popup {LEAVE_INSERT_CAP} does, and Esc closes it · edit in Settings → Keyboard Shortcuts</span>
          {vim.mode === 'command' ? (
            <span className="flex items-center gap-1 shrink-0">
              {scrollKeys.length > 0 && <>Scroll {scrollKeys.map((k) => <kbd key={k}>{k}</kbd>)} · </>}
              {insertKey && <>Filter <kbd>{insertKey}</kbd> · </>}
              Close <kbd>Esc</kbd>
            </span>
          ) : vim.mode === 'insert' ? (
            <span className="flex items-center gap-1 shrink-0">Keys <kbd>{LEAVE_INSERT_CAP}</kbd> · Close <kbd>Esc</kbd></span>
          ) : (
            <span className="flex items-center gap-1 shrink-0">{query ? 'Clear' : 'Close'} <kbd>Esc</kbd></span>
          )}
        </div>
      </div>
    </DetachedWindow>
  )
}
