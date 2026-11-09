// The keys' help (Vim's ?) as a page (vimperium://keys, lib/internal-pages.ts):
// a tab of its own, drawn in the page area as Downloads and Bangs are. Its
// sections are the keymap's own (lib/help-sections.ts) under headings that
// read — Page, Sidebar, Open (o), Address editor… — and Settings', each
// listing what a key does and the keys, as the user's keymap has them; two
// columns of them once the page is wide enough.
//
// The filter is the address bar (lib/address-filter.ts): it finds a key by
// what it does, by the keys, by the command or by its section — what matches
// stays under its section's heading, counted. ? on an empty filter closes
// the page, as ? opened it; Esc leaves the filter for COMMAND, where j/k,
// Ctrl+D/U and gg/G scroll the page and i (or gi) types in the filter again.
// Keys typed so far of a sequence dim the page's rows they can't become.

import { useEffect, useMemo, useRef } from 'react'
import { Keyboard } from 'lucide-react'
import { fuzzyFilter } from '../lib/fuzzy'
import { helpSections, type HelpContext, type HelpSection } from '../lib/help-sections'
import { closeHelpPanel } from '../lib/help-panel'
import { focusAddressFilter, useAddressFilter, type AddressFilterKeyEvent } from '../lib/address-filter'
import { isBlockKey } from '../lib/url-blocks'
import {
  displayKeySequence, keysFor, settingsCommandLabel, settingsCommandsInOrder, settingsKeymap, vimCommandLabel,
  type ParsedVimKeymap, type VimKeymap,
} from '../lib/vim-keymap'
import { usePageKeys } from '../lib/vim-mode'
import { SEQUENCE_JOIN } from '../../../shared/vim-keys'
import { LEAVE_INSERT_CAP } from './KeyHints'
import { cn } from '../lib/utils'

export interface KeysPageProps {
  keymap: ParsedVimKeymap
  /** Keys typed so far of a sequence: rows they can still become stay lit. */
  vimPending: string
}

/** A line of j/k, as a web page's (VIM_SCROLL_STEP in the preload). */
const SCROLL_STEP = 60

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
      return `Its COMMAND mode, out of typing (Enter or ${LEAVE_INSERT_CAP}); Esc closes from either${typesAgain(keymap.find)} ? shows its keys.`
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

interface ShownSection {
  section: HelpSection
  rows: Row[]
  total: number
}

/** The sections split in two runs of about the same height, in order: the
 *  first column reads down, then the second. */
function splitInTwo(sections: ShownSection[], withNotes: boolean, keymap: ParsedVimKeymap): [ShownSection[], ShownSection[]] {
  const weight = (s: ShownSection): number =>
    s.rows.length + 2.5 + (withNotes && sectionNote(s.section.context, keymap) ? 1.5 : 0)
  const total = sections.reduce((n, s) => n + weight(s), 0)
  let best = sections.length
  let bestCost = Infinity
  let before = 0
  for (let i = 0; i <= sections.length; i++) {
    const cost = Math.max(before, total - before)
    if (cost < bestCost) {
      bestCost = cost
      best = i
    }
    if (i < sections.length) before += weight(sections[i])
  }
  return [sections.slice(0, best), sections.slice(best)]
}

export function KeysPage({ keymap, vimPending }: KeysPageProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const query = useAddressFilter('keys', {
    label: 'Keys',
    placeholder: 'Find a key: what it does, the keys, the section',
    onKey: (e) => filterKey(e),
    // Enter leaves the filter for COMMAND, to scroll what it found; with
    // nothing found, what's typed goes as an address.
    onEnter: () => found > 0,
  })

  // A new filter starts from the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [query])

  const sections = useMemo((): ShownSection[] => {
    const maps: Record<HelpContext, VimKeymap> = {
      command: keymap.main, search: keymap.search, find: keymap.find, url: keymap.url, settings: settingsKeymap(keymap),
    }
    const all: HelpSection[] = [
      ...helpSections(),
      { id: 'settings', title: 'Settings', context: 'settings', commands: settingsCommandsInOrder() },
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

  const found = sections.reduce((n, s) => n + s.rows.length, 0)
  const total = useMemo(() => sections.reduce((n, s) => n + s.total, 0), [sections])
  const columns = useMemo(() => splitInTwo(sections, !query, keymap), [sections, query, keymap])

  const scrollBy = (top: number): void => { scrollRef.current?.scrollBy({ top, behavior: 'smooth' }) }
  const page = (): number => scrollRef.current?.clientHeight ?? 0

  /** A key typed in the address bar, the page's filter. */
  const filterKey = (e: AddressFilterKeyEvent): boolean => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    switch (e.key) {
      // ? on an empty filter closes, as it opened the page.
      case '?':
        if (query) return false
        closeHelpPanel()
        return true
      case 'ArrowDown': scrollBy(SCROLL_STEP); return true
      case 'ArrowUp': scrollBy(-SCROLL_STEP); return true
      case 'PageDown': scrollBy(page() * 0.9); return true
      case 'PageUp': scrollBy(-page() * 0.9); return true
    }
    return false
  }

  // COMMAND's keys on the page: the scroll keys scroll it, i and gi type in
  // the filter.
  usePageKeys({
    intercept: () => false,
    command: (command) => {
      const el = scrollRef.current
      if (!el) return false
      switch (command) {
        case 'scroll-down': scrollBy(SCROLL_STEP); return true
        case 'scroll-up': scrollBy(-SCROLL_STEP); return true
        case 'half-page-down': scrollBy(el.clientHeight / 2); return true
        case 'half-page-up': scrollBy(-el.clientHeight / 2); return true
        case 'page-top': el.scrollTo({ top: 0, behavior: 'smooth' }); return true
        case 'page-bottom': el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); return true
        case 'insert-mode':
        case 'focus-input':
          focusAddressFilter()
          return true
      }
      return false
    },
  })

  const renderSection = ({ section, rows, total: sectionTotal }: ShownSection) => {
    const note = query ? null : sectionNote(section.context, keymap)
    return (
      <section key={section.id} aria-label={section.title} className="pb-5 last:pb-0">
        {/* The heading stays in sight while its keys scroll by. */}
        <div className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-border bg-background pb-1.5 pt-2">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">{section.title}</h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {query ? `${rows.length} of ${sectionTotal}` : sectionTotal}
          </span>
        </div>
        {note && <p className="pt-2 text-xs leading-snug text-muted-foreground">{note}</p>}
        <div className="pt-1">
          {rows.map(({ command, label, keys }) => {
            const dim = !!vimPending && section.context === 'command' && !keys.some((k) => k.startsWith(vimPending))
            return (
              <div
                key={command}
                title={command}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-md px-1.5 py-1 text-[13px] transition-opacity hover:bg-accent/40',
                  dim && 'opacity-35',
                )}
              >
                <span className="min-w-0 truncate text-foreground">{label}</span>
                <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                  {keys.map((k) => <kbd key={k} className="font-mono">{displayKeySequence(k)}</kbd>)}
                </span>
              </div>
            )
          })}
        </div>
      </section>
    )
  }

  return (
    <div
      // Its scroller is the one COMMAND's scroll keys move
      // (lib/internal-page-commands.ts). Never focused itself: the page's
      // keys are COMMAND's, its typing is the address bar's.
      data-vim-page=""
      role="region"
      aria-label="Keys"
      className="absolute inset-0 z-50 flex flex-col bg-background text-foreground"
    >
      {/* The same space above the header as below the list. */}
      <div className="flex min-h-0 flex-1 justify-center overflow-hidden px-8 py-[max(2rem,6vh)]">
        <div className="flex min-h-0 w-full max-w-5xl flex-col">
          <div className="mb-4 flex min-w-0 shrink-0 items-center gap-3">
            <Keyboard size={20} className="shrink-0 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">Keys</h1>
            <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
              {query ? `${found} of ${total}` : total}
            </span>
            <span className="ml-auto hidden truncate text-xs text-muted-foreground sm:block">
              ? closes · Settings → Keyboard Shortcuts edits them
            </span>
          </div>
          <div ref={scrollRef} data-vim-scroll="" className="@container min-h-0 flex-1 overflow-y-auto">
            {sections.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">No keys match “{query.trim()}”</div>
            ) : (
              <div className="grid grid-cols-1 gap-x-10 @3xl:grid-cols-2">
                <div className="min-w-0">{columns[0].map(renderSection)}</div>
                <div className="min-w-0">{columns[1].map(renderSection)}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
