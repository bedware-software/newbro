// The tab picker over a split's empty pane (lib/split-view.ts): Search
// Everything's look, narrowed to this workspace's tabs. A pinned popup, so
// it stays centred on the pane as the window moves. Enter (or a row's
// number in COMMAND) puts the tab in the pane; Esc gives up on the split.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Globe, Plus, Search } from 'lucide-react'
import { useAppStore } from '../store/app-store'
import { DetachedWindow, type PopupPlacement } from './DetachedWindow'
import { TabFavicon } from './TabFavicon'
import { CommentChip } from './CommentChip'
import { VimModeBadge } from './VimModeBadge'
import { Hint, HintBar, vimKeyCaps } from './KeyHints'
import { SplitGlyph } from './SplitPanes'
import { fuzzyFilter } from '../lib/fuzzy'
import { isInternalUrl } from '../lib/internal-pages'
import { closeSplit, fillSplit, workspaceTabs, type SplitView } from '../lib/split-view'
import { usePopupVimMode } from '../lib/vim-mode'
import type { VimKeymap } from '../lib/vim-keymap'

interface Props {
  split: SplitView
  /** The empty pane: the picker sits in its middle. */
  paneRef: React.RefObject<HTMLDivElement | null>
  /** The picker's COMMAND keys (the Command Palette's); null while Vim mode
   *  is off. */
  vimKeymap: VimKeymap | null
  /** Bumped to hand the keyboard back to the picker. */
  focusTick: number
}

const MAX_WIDTH = 620
const MAX_HEIGHT = 480
const MARGIN = 24
// Rows numbered for search-row-1…9 in COMMAND mode.
const NUMBERED_ROWS = 9
const NEW_TAB_ROW = '__new-tab__'

interface Row {
  id: string
  title: string
  url: string
  favicon: string
  comment?: string
}

export function SplitPicker({ split, paneRef, vimKeymap, focusTick }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [popupWindow, setPopupWindow] = useState<Window | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const profiles = useAppStore((s) => s.profiles)

  // Size is taken once (the popup's window keeps it); the spot follows the pane.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [placement, setPlacement] = useState<PopupPlacement>()
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const width = Math.round(Math.max(320, Math.min(MAX_WIDTH, r.width - MARGIN * 2)))
      const height = Math.round(Math.max(240, Math.min(MAX_HEIGHT, r.height - MARGIN * 2)))
      setSize((prev) => prev ?? { width, height })
      setPlacement((prev) => {
        const w = size?.width ?? width
        const h = size?.height ?? height
        const next = { left: Math.round(r.left + (r.width - w) / 2), top: Math.round(r.top + Math.max(MARGIN, (r.height - h) / 3)) }
        return prev?.left === next.left && prev.top === next.top ? prev : next
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [paneRef, size])

  const rows = useMemo<Row[]>(() => {
    const tabs = workspaceTabs().filter((t) => t.id !== split.first && !isInternalUrl(t.url))
    const matching = query.trim()
      ? fuzzyFilter(query, tabs, (t) => [
        { value: t.title, weight: 1 },
        { value: t.comment, weight: 0.9 },
        { value: t.url, weight: 0.6 },
      ])
      : tabs
    return [...matching, { id: NEW_TAB_ROW, title: 'New tab', url: '', favicon: '' }]
    // profiles: the tabs to pick from change with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, split.first, profiles])

  useEffect(() => { setSelected(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const pick = (row: Row | undefined): void => {
    if (!row) return
    if (row.id !== NEW_TAB_ROW) {
      fillSplit(row.id)
      return
    }
    // A new tab lands next to the active one and, being activated, fills the
    // pane (lib/split-view.ts).
    const s = useAppStore.getState()
    if (s.activeWorkspaceId) s.addTabNearActive(s.activeWorkspaceId)
  }

  const vim = usePopupVimMode({
    keymap: vimKeymap,
    popup: popupWindow,
    box: inputRef,
    initial: 'command',
    open: true,
    onCommand: (command) => {
      const numbered = /^search-row-(\d)$/.exec(command)
      if (numbered) {
        pick(rows[Number(numbered[1]) - 1])
        return
      }
      switch (command) {
        case 'insert-mode': inputRef.current?.focus(); break
        case 'cursor-down': setSelected((i) => Math.min(i + 1, rows.length - 1)); break
        case 'cursor-up': setSelected((i) => Math.max(i - 1, 0)); break
        case 'cursor-first': setSelected(0); break
        case 'cursor-last': setSelected(rows.length - 1); break
        case 'row-open': pick(rows[selected]); break
      }
    },
    onEscape: closeSplit,
  })

  // Without Vim mode the box has the keys from the start.
  useEffect(() => {
    if (!popupWindow || vimKeymap) return
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [popupWindow, vimKeymap, focusTick])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(rows[selected])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Vim: Esc leaves the box for COMMAND mode; Esc there gives up.
      if (vim.modeRef.current) inputRef.current?.blur()
      else closeSplit()
    }
  }

  if (!size || !placement) return null

  return (
    <DetachedWindow
      open
      title="Split - Newbro"
      width={size.width}
      height={size.height}
      resizable={false}
      closeOnEscape={false}
      placement={placement}
      focusTick={focusTick}
      onClose={closeSplit}
      onWindowChange={setPopupWindow}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <HintBar>
          {vim.mode === 'command' ? (
            <>
              <Hint label="Navigate" keys={vimKeyCaps(vimKeymap, 'cursor-down', 'cursor-up')} />
              <Hint label="Open here" keys={vimKeyCaps(vimKeymap, 'row-open')} />
              <Hint label="Row" keys={[`${vimKeyCaps(vimKeymap, 'search-row-1')[0] ?? '1'}…${vimKeyCaps(vimKeymap, `search-row-${NUMBERED_ROWS}`)[0] ?? '9'}`]} />
              <Hint label="Type" keys={vimKeyCaps(vimKeymap, 'insert-mode')} />
              <Hint label="Cancel split" keys={['Esc']} />
            </>
          ) : (
            <>
              <Hint label="Navigate" keys={['↓', '↑']} />
              <Hint label="Open here" keys={['Enter']} />
              <Hint label={vim.mode ? 'Command mode' : 'Cancel split'} keys={['Esc']} />
            </>
          )}
        </HintBar>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <SplitGlyph direction={split.direction} pane="second" className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={vim.onBoxFocus}
            onBlur={vim.onBoxBlur}
            placeholder={vim.mode === 'command' && vimKeyCaps(vimKeymap, 'insert-mode')[0]
              ? `Tab for the ${split.direction === 'right' ? 'right' : 'bottom'} side… (${vimKeyCaps(vimKeymap, 'insert-mode')[0]} to type)`
              : `Tab for the ${split.direction === 'right' ? 'right' : 'bottom'} side…`}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
          />
          <Search size={14} className="shrink-0 text-muted-foreground/60" />
          {vim.mode && <VimModeBadge mode={vim.mode} pending={vim.pending} />}
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto min-h-0 py-1">
          {rows.map((row, idx) => {
            const numberHint = vim.mode === 'command' && idx < NUMBERED_ROWS ? idx + 1 : undefined
            const isNew = row.id === NEW_TAB_ROW
            return (
              <div
                key={row.id}
                data-index={idx}
                onClick={() => pick(row)}
                className={`relative flex items-center gap-2 px-4 py-2 cursor-pointer ${
                  idx === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                } ${isNew ? 'border-t border-border' : ''}`}
              >
                {numberHint !== undefined && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-1/2 -translate-y-1/2 z-10 inline-flex items-center justify-center h-[18px] w-4 rounded-md border border-border bg-popover text-foreground font-mono font-medium text-[10px] leading-none shadow-[0_0_2px_rgb(0_0_0/0.1)] select-none pointer-events-none"
                  >
                    {numberHint}
                  </span>
                )}
                <span className="w-6 shrink-0 flex items-center">
                  {isNew ? <Plus size={16} className="text-muted-foreground" />
                    : row.favicon ? <TabFavicon favicon={row.favicon} />
                    : <Globe size={16} className="text-muted-foreground/60" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {row.comment && <CommentChip comment={row.comment} />}
                    <span className="truncate text-sm">{row.title || row.url}</span>
                  </div>
                  {!isNew && row.url && row.url !== 'about:blank' && (
                    <div className="truncate text-[10px] text-muted-foreground">{row.url}</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </DetachedWindow>
  )
}
