// The keys' help (Vim's ?): a panel on the window's right, beside the page,
// as the Bookshelf is — a reference kept open while you work, not a popup
// over it. Its sections are the keymap's own (lib/help-sections.ts) under
// headings that read: Page, Sidebar, Open (o), Address editor… Each lists
// what a key does and the keys, as the user's keymap has them.
//
// The filter at the top finds a key by what it does, by the keys, or by
// its section — what matches stays under its section's heading, the count
// beside it. ? opens the panel with the filter taking the keys (typing,
// INSERT); Esc gives them back to the page (COMMAND), the panel staying;
// ? again closes it. While it's open the header's buttons show their keys
// too (HeaderHint.tsx).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, Search, X } from 'lucide-react'
import { fuzzyFilter } from '../lib/fuzzy'
import { helpSections, type HelpContext } from '../lib/help-sections'
import { isBlockKey } from '../lib/url-blocks'
import {
  displayKeySequence, keysFor, settingsCommandLabel, settingsCommandsInOrder, settingsKeymap, vimCommandLabel,
  type ParsedVimKeymap, type VimKeymap,
} from '../lib/vim-keymap'
import { SEQUENCE_JOIN } from '../../../shared/vim-keys'
import { LEAVE_INSERT_CAP } from './KeyHints'
import { cn } from '../lib/utils'

const MIN_WIDTH = 260
const DEFAULT_WIDTH = 360
const WIDTH_KEY = 'vimperium-help-panel-width'

function loadWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(WIDTH_KEY) ?? '', 10)
    return Number.isFinite(v) ? Math.max(MIN_WIDTH, v) : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

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

/** A line under a section's heading, naming keys as the keymap has them. */
function sectionNote(context: HelpContext, keymap: ParsedVimKeymap): string | null {
  const typesAgain = (map: VimKeymap): string => {
    const key = keysFor(map, 'insert-mode')[0]
    return key ? `; ${key} types again.` : '.'
  }
  switch (context) {
    case 'search':
      return `Their COMMAND mode, out of the box (${LEAVE_INSERT_CAP}); Esc closes from either${typesAgain(keymap.search)}`
    case 'find':
      return `Its COMMAND mode, out of typing (Enter or ${LEAVE_INSERT_CAP}); Esc closes from either${typesAgain(keymap.find)}`
    case 'url': {
      const twice = ['url-copy', 'url-change']
        .map((command) => singleKeys(keymap.url, command).find((key) => !isBlockKey(key)))
        .filter((key): key is string => key !== undefined)
        .map((key) => key + key)
      return [
        'Blocks: h protocol, d domain, n port, 1–9 path levels, p parameters, f fragment.',
        twice.length > 0 ? `${listed(twice)} act${twice.length === 1 ? 's' : ''} on the whole address.` : '',
      ].filter(Boolean).join(' ')
    }
    case 'settings':
      return `Every setting wears a label; typing it goes there. ${LEAVE_INSERT_CAP} leaves a field; Esc steps back out, then closes.`
    default:
      return null
  }
}

interface Row {
  command: string
  label: string
  keys: string[]
}

export function HelpPanel({ open, suppressed = false, keymap, vimPending, onClose, onReleaseKeys }: {
  open: boolean
  /** Hidden for a while (the page in fullscreen), still open: back after,
   *  without taking the keys. */
  suppressed?: boolean
  keymap: ParsedVimKeymap
  /** Keys typed so far of a sequence: rows they can still become stay lit. */
  vimPending?: string
  onClose: () => void
  /** Hands the keys back to the page (COMMAND): Esc in the filter. */
  onReleaseKeys: () => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(loadWidth)
  const resizing = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)
  const currentW = useRef(width)

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizing.current = true
    startX.current = e.clientX
    startW.current = currentW.current
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.dispatchEvent(new CustomEvent('vimperium-tab-hide'))
  }, [])
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!resizing.current) return
      const next = Math.min(Math.floor(window.innerWidth / 2), Math.max(MIN_WIDTH, startW.current - (e.clientX - startX.current)))
      currentW.current = next
      setWidth(next)
    }
    const end = (): void => {
      if (!resizing.current) return
      resizing.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try { localStorage.setItem(WIDTH_KEY, String(currentW.current)) } catch { /* the width just isn't kept */ }
      window.dispatchEvent(new CustomEvent('vimperium-tab-show'))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', end)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', end)
      end()
    }
  }, [])

  // Opening: the filter takes the keys, empty — a key is found by typing.
  // Only on opening: coming back after the page's fullscreen leaves the
  // keys where they are.
  useEffect(() => {
    if (!open) return
    setQuery('')
    window.electronAPI.focusWindowRenderer?.()
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open])

  // A new filter starts from the top.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [query])

  const sections = useMemo(() => {
    const maps: Record<HelpContext, VimKeymap> = {
      command: keymap.main, search: keymap.search, find: keymap.find, url: keymap.url, settings: settingsKeymap(keymap),
    }
    const all = [
      ...helpSections(),
      { id: 'settings', title: 'Settings', context: 'settings' as const, commands: settingsCommandsInOrder() },
    ]
    return all.map((section) => {
      const map = maps[section.context]
      const rows: Row[] = section.commands
        .map((command) => ({
          command,
          label: section.context === 'settings' ? settingsCommandLabel(command) : vimCommandLabel(command),
          keys: keysFor(map, command),
        }))
        .filter((row) => row.keys.length > 0)
      const matching = fuzzyFilter(query, rows, (row) => [
        { value: row.label, weight: 1 },
        { value: row.keys.join(' '), weight: 0.9 },
        { value: row.command, weight: 0.6 },
        { value: section.title, weight: 0.5 },
      ])
      return { section, rows: matching, total: rows.length }
    }).filter(({ rows }) => rows.length > 0)
  }, [keymap, query])

  if (!open || suppressed) return null

  const pending = vimPending ?? ''
  const found = sections.reduce((n, s) => n + s.rows.length, 0)

  return (
    <div
      role="region"
      aria-label="Keys help"
      style={{ width }}
      className="bg-toolbar border-l border-border flex flex-col shrink-0 overflow-hidden relative"
    >
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border shrink-0">
        <Keyboard size={15} className="text-primary" />
        <span className="text-sm font-semibold text-foreground flex-1">Keys</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the keys help"
          title="Close (?)"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-3 py-2 border-b border-border shrink-0">
        <div className="field relative flex items-center gap-2 h-9 rounded-lg px-2.5">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // ? on an empty filter closes, as it opened it.
              if (e.key === '?' && !query) {
                e.preventDefault()
                onClose()
              } else if (e.key === 'Escape' && !e.nativeEvent.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey) {
                // Esc gives the keys back to the page, the panel staying.
                e.preventDefault()
                e.stopPropagation()
                inputRef.current?.blur()
                onReleaseKeys()
              }
            }}
            placeholder="Find a key: what it does, the keys…"
            spellCheck={false}
            className="flex-1 min-w-0 h-full bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
          />
          {query && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{found}</span>}
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto min-h-0 pb-3">
        {sections.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">No keys match “{query}”</div>
        ) : sections.map(({ section, rows, total }) => {
          const note = sectionNote(section.context, keymap)
          return (
            <section key={section.id} className="pt-3">
              {/* The heading stays in sight while its keys scroll by. */}
              <div className="sticky top-0 z-10 bg-toolbar px-3 pb-1.5 pt-1 flex items-baseline gap-2 border-b border-border/60">
                <h3 className="text-[13px] font-semibold text-foreground">{section.title}</h3>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {query ? `${rows.length} of ${total}` : total}
                </span>
              </div>
              {note && !query && <p className="px-3 pt-1.5 text-[11px] leading-snug text-muted-foreground">{note}</p>}
              <div className="px-3 pt-1">
                {rows.map(({ command, label, keys }) => {
                  const dim = !!pending && section.context === 'command' && !keys.some((k) => k.startsWith(pending))
                  return (
                    <div
                      key={command}
                      title={command}
                      className={cn('flex items-center justify-between gap-3 py-[3px] text-xs transition-opacity', dim && 'opacity-35')}
                    >
                      <span className="min-w-0 truncate text-foreground">{label}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {keys.map((k) => <kbd key={k} className="font-mono">{displayKeySequence(k)}</kbd>)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>

      <div className="h-9 px-3 flex items-center border-t border-border text-[11px] text-muted-foreground shrink-0">
        Esc gives the keys back · ? closes · Settings → Keyboard Shortcuts edits them
      </div>

      <div
        className="absolute top-0 left-0 w-1.5 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
        onMouseDown={onResizeStart}
      />
    </div>
  )
}
