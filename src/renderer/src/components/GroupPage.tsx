// The page area while parked on a tab group (a click on its header, or
// Ctrl+J/K in Vim mode stopping on it): the group's tabs, the split
// picker's look laid out on the page. Enter on the selected one, or a
// click, shows that tab; the box filters them.
//
// Vim mode: there's no tab view to run COMMAND's keys, so the page takes
// them (lib/vim-mode.ts usePageKeys) — the keymap's scroll keys move
// through the tabs, insert-mode (i) types in the box, and Enter comes ahead
// of the keymap. In COMMAND each row wears a label that picks it
// (lib/hint-labels.ts); typing in the box, just its number, to read. Esc in
// the box goes back to COMMAND.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Globe, Search } from 'lucide-react'
import { useAppStore } from '../store/app-store'
import type { TabGroup } from '../store/types'
import { TabFavicon } from './TabFavicon'
import { CommentChip } from './CommentChip'
import { InputField } from './InputField'
import { Hint, HintBar, RowHint, vimKeyCaps } from './KeyHints'
import { useHintLabels, useHintTargets } from '../lib/hint-labels'
import { fuzzyFilter } from '../lib/fuzzy'
import { keyTokenFromEvent } from '../lib/vim-keymap'
import { usePageKeys, type VimMode } from '../lib/vim-mode'
import type { VimKeymap } from '../lib/vim-keymap'

interface Props {
  group: TabGroup
  /** COMMAND mode's keys, for the hints; null while Vim mode is off. */
  vimKeymap: VimKeymap | null
  /** The window's Vim mode; null while Vim mode is off. */
  vimMode: VimMode | null
  /** Keys typed so far of an unfinished COMMAND sequence. */
  vimPending: string
  /** Its rows may wear COMMAND's labels: no popup has its own up. */
  hintsOn: boolean
}

const HALF_PAGE_ROWS = 5
// Its rows' ids among the window's hint targets: the tab's own, as the
// Sidebar lists it too — one tab, one label in both places.
const hintId = (tabId: string): string => `tab:${tabId}`

export function GroupPage({ group, vimKeymap, vimMode, vimPending, hintsOn }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const setActiveTab = useAppStore((s) => s.setActiveTab)

  // Another group parked on starts afresh.
  useEffect(() => {
    setQuery('')
    setSelected(0)
  }, [group.id])

  const rows = useMemo(() => (query.trim()
    ? fuzzyFilter(query, group.tabs, (t) => [
      { value: t.title, weight: 1 },
      { value: t.comment, weight: 0.9 },
      { value: t.url, weight: 0.6 },
    ])
    : group.tabs), [query, group.tabs])

  useEffect(() => { setSelected(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const open = (index: number): boolean => {
    const tab = rows[index]
    if (!tab) return false
    setActiveTab(tab.id)
    return true
  }
  const moveBy = (delta: number): void => {
    setSelected((i) => Math.max(0, Math.min(rows.length - 1, i + delta)))
  }

  /** Enter, typed outside the box. */
  const rowKey = (e: KeyboardEvent): boolean => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    return keyTokenFromEvent(e) === '<CR>' && open(selected)
  }

  // COMMAND's labels on its rows.
  useHintTargets('group-page', 0, vimMode === 'command' && hintsOn
    ? rows.map((tab, i) => ({ id: hintId(tab.id), name: tab.title || tab.url, activate: () => { open(i) } }))
    : null)
  const hintLabels = useHintLabels()

  usePageKeys({
    intercept: rowKey,
    command: (command) => {
      switch (command) {
        case 'scroll-down': moveBy(1); return true
        case 'scroll-up': moveBy(-1); return true
        case 'half-page-down': moveBy(HALF_PAGE_ROWS); return true
        case 'half-page-up': moveBy(-HALF_PAGE_ROWS); return true
        case 'page-top': setSelected(0); return true
        case 'page-bottom': setSelected(Math.max(rows.length - 1, 0)); return true
        case 'insert-mode':
        case 'focus-input':
          inputRef.current?.focus()
          return true
      }
      return false
    },
  })

  // Without Vim mode: arrows and Enter, outside the box.
  // (In Vim's COMMAND the keys come through usePageKeys instead and never
  // get this far.)
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e) => {
    if (vimMode || e.defaultPrevented) return
    const target = e.target
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, button, a'))) return
    let handled = rowKey(e)
    if (!handled && !e.metaKey && !e.ctrlKey && !e.altKey) {
      handled = true
      if (e.key === 'ArrowDown') moveBy(1)
      else if (e.key === 'ArrowUp') moveBy(-1)
      else handled = false
    }
    if (handled) e.preventDefault()
  }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => keyRef.current(e)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const onBoxKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveBy(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveBy(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      open(selected)
    } else if (e.key === 'Escape') {
      // Vim: back to COMMAND, keeping the filter (the box letting go is
      // COMMAND). Without it, the filter goes first, then the box.
      e.preventDefault()
      if (!vimMode && query) setQuery('')
      else inputRef.current?.blur()
    }
  }

  const caps = (...commands: string[]): string[] => vimKeyCaps(vimKeymap, ...commands)

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background text-foreground select-none">
      <div className="flex min-h-0 flex-1 justify-center overflow-hidden px-8 pt-[10vh]">
        <div className="flex min-h-0 w-full max-w-2xl flex-col">
          <div
            data-group-container=""
            style={{ ['--gc' as string]: group.color }}
            className="mb-4 flex min-w-0 items-center gap-3"
          >
            <span
              data-group-pill=""
              className="min-w-0 truncate rounded-xl px-4 py-1.5 text-2xl font-semibold tracking-tight"
            >
              {group.name || 'Unnamed group'}
            </span>
            <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
              {group.tabs.length} {group.tabs.length === 1 ? 'tab' : 'tabs'}
            </span>
          </div>
          <InputField inputRef={inputRef} mode={vimMode} className="h-10 shrink-0">
            <Search size={14} className="shrink-0 text-muted-foreground/60" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onBoxKeyDown}
              placeholder={vimMode === 'command' && caps('insert-mode')[0]
                ? `Filter the group's tabs… (${caps('insert-mode')[0]} to type)`
                : "Filter the group's tabs…"}
              spellCheck={false}
              className="h-full min-w-0 flex-1 border-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </InputField>
          <div ref={listRef} className="mt-2 min-h-0 flex-1 overflow-y-auto pb-6">
            {rows.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                {group.tabs.length === 0 ? 'No tabs in this group' : 'No tabs match'}
              </div>
            )}
            {rows.map((tab, idx) => {
              return (
                <div
                  key={tab.id}
                  data-index={idx}
                  onClick={() => open(idx)}
                  onMouseMove={() => { if (selected !== idx) setSelected(idx) }}
                  className={`relative flex cursor-pointer items-center gap-2 rounded-lg py-2 pl-6 pr-4 ${
                    idx === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                  }`}
                >
                  <RowHint
                    mode={vimMode}
                    label={hintLabels.get(hintId(tab.id))}
                    pending={vimPending}
                    className="absolute left-0.5 top-1/2 -translate-y-1/2 bg-background"
                  />
                  <span className="flex w-6 shrink-0 items-center">
                    {tab.favicon ? <TabFavicon favicon={tab.favicon} /> : <Globe size={16} className="text-muted-foreground/60" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {tab.comment && <CommentChip comment={tab.comment} />}
                      <span className="truncate text-sm">{tab.title || tab.url}</span>
                    </div>
                    {tab.url && tab.url !== 'about:blank' && (
                      <div className="truncate text-[10px] text-muted-foreground">{tab.url}</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <HintBar>
        {vimMode === 'command' ? (
          <>
            <Hint label="Navigate" keys={caps('scroll-down', 'scroll-up')} />
            <Hint label="Open" keys={['Enter']} />
            {rows[0] && hintLabels.get(hintId(rows[0].id)) && <Hint label="Pick" keys={[`${hintLabels.get(hintId(rows[0].id))}…`]} />}
            <Hint label="Filter" keys={caps('insert-mode')} />
          </>
        ) : (
          <>
            <Hint label="Navigate" keys={['↓', '↑']} />
            <Hint label="Open" keys={['Enter']} />
            {vimMode === 'insert' && <Hint label="Command mode" keys={['Esc']} />}
          </>
        )}
      </HintBar>
    </div>
  )
}
