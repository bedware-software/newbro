import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, Search, X } from 'lucide-react'
import { useAppStore } from '../store/app-store'
import { DetachedWindow, type PopupPlacement } from './DetachedWindow'
import { VimModeBadge } from './VimModeBadge'
import { Hint, HintBar, vimKeyCaps, vimKeyCapsAll } from './KeyHints'
import { usePopupVimMode } from '../lib/vim-mode'
import type { VimKeymap } from '../lib/vim-keymap'

const isMac = navigator.platform.toLowerCase().includes('mac')

const WIDTH = 460
// The hint bar (h-10), the search row (h-11) and the border.
const HEIGHT = 86
// Inset from the page area's top-right corner.
const INSET_TOP = 8
const INSET_RIGHT = 16

interface Props {
  open: boolean
  /** Increments on every find-in-page while the popup is open: hands the
   *  keyboard back to it and selects what's typed (Chrome / Firefox). The
   *  first press handles itself via `open`, so 0 is inert. */
  focusTick: number
  onClose: () => void
  /** The page area: the popup sits in its top-right corner. */
  anchorRef: React.RefObject<HTMLElement | null>
  /** Find's COMMAND keys; null while Vim mode is off. */
  vimKeymap: VimKeymap | null
}

interface FoundInPageEvent {
  type: 'found-in-page'
  tabId: string
  requestId: number
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

interface MatchInfo {
  active: number
  total: number
}

/** Where the popup goes: the page area's top-right corner, following it as
 *  the window and the panels around the page change size. */
function usePagePlacement(open: boolean, anchorRef: React.RefObject<HTMLElement | null>): PopupPlacement | undefined {
  const [placement, setPlacement] = useState<PopupPlacement>()
  useEffect(() => {
    const el = anchorRef.current
    if (!open || !el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const next = { left: Math.round(Math.max(r.left, r.right - WIDTH - INSET_RIGHT)), top: Math.round(r.top + INSET_TOP) }
      setPlacement((prev) => (prev?.left === next.left && prev.top === next.top ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open, anchorRef])
  return open ? placement : undefined
}

/**
 * Find in page: a small popup pinned to the page's top-right corner, over
 * the page rather than pushing it down. Calls into webContents.findInPage /
 * stopFindInPage via IPC and listens for 'found-in-page' on the tab-event
 * stream. In Vim mode it opens in INSERT, only for typing what to find (the
 * first match lights up as you type); Enter or Esc goes to COMMAND, the one
 * place j/k (n/N) step through the matches, i types again and Esc closes.
 * Without Vim mode Enter / Shift+Enter step, as in any browser.
 */
export function FindPopup({ open, focusTick, onClose, anchorRef, vimKeymap }: Props) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<MatchInfo | null>(null)
  const [popupWindow, setPopupWindow] = useState<Window | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Tab we most recently asked main to search. Used so that switching tabs
  // (or closing the popup) can clear highlights on the previous tab even
  // after activeTabId has already moved on.
  const lastSearchedTabIdRef = useRef<string | null>(null)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const placement = usePagePlacement(open, anchorRef)

  const findNext = useCallback((forward: boolean): void => {
    if (!query || !activeTabId) return
    // `findNext: false` = advance within the existing session (the typing
    // effect below seeded it with findNext: true). Pairing with `forward`
    // gives prev/next navigation over the same matches.
    window.electronAPI?.tabFindInPage?.(activeTabId, query, { findNext: false, forward })
    lastSearchedTabIdRef.current = activeTabId
  }, [query, activeTabId])

  const vim = usePopupVimMode({
    keymap: vimKeymap,
    popup: popupWindow,
    box: inputRef,
    initial: 'insert',
    open,
    onCommand: (command) => {
      switch (command) {
        case 'find-next': findNext(true); break
        case 'find-prev': findNext(false); break
        case 'insert-mode': inputRef.current?.focus(); break
      }
    },
    onEscape: onClose,
  })

  // Typing goes in the box on opening, and again (everything selected) on
  // every find-in-page while open — DetachedWindow hands the popup the
  // keyboard for the latter.
  useEffect(() => {
    if (!open || !popupWindow) return
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [open, focusTick, popupWindow])

  useEffect(() => {
    const cleanup = window.electronAPI?.onTabEvent?.((raw) => {
      const evt = raw as { type?: string }
      if (evt?.type !== 'found-in-page') return
      const found = raw as FoundInPageEvent
      if (!activeTabId || found.tabId !== activeTabId) return
      setResult({ active: found.activeMatchOrdinal, total: found.matches })
    })
    return cleanup
  }, [activeTabId])

  // Drive the search. Fires on open, query changes, and tab switches while
  // the popup is open. Switching tabs first clears highlights on the
  // previous tab so the user doesn't see two pages lit up at once.
  //
  // `findNext: true` is the counter-intuitive Electron flag for "begin a new
  // text finding session" — Chromium's underlying find API names it from the
  // session's perspective, not the request's. Each keystroke is a fresh
  // query so we always pass true here; prev/next use false to advance the
  // active match within the existing session.
  //
  // A short debounce collapses bursts of keystrokes into a single Chromium
  // request. Without it, each request cancels the previous one before
  // found-in-page settles, leaving the counter looking stuck.
  useEffect(() => {
    if (!open) return
    if (lastSearchedTabIdRef.current && lastSearchedTabIdRef.current !== activeTabId) {
      window.electronAPI?.tabStopFindInPage?.(lastSearchedTabIdRef.current, 'clearSelection')
      lastSearchedTabIdRef.current = null
    }
    if (!activeTabId) return
    if (!query) {
      setResult(null)
      if (lastSearchedTabIdRef.current) {
        window.electronAPI?.tabStopFindInPage?.(lastSearchedTabIdRef.current, 'clearSelection')
        lastSearchedTabIdRef.current = null
      }
      return
    }
    const t = setTimeout(() => {
      window.electronAPI?.tabFindInPage?.(activeTabId, query, { findNext: true })
      lastSearchedTabIdRef.current = activeTabId
    }, 40)
    return () => clearTimeout(t)
  }, [query, activeTabId, open])

  // Closing drops the highlights on whichever tab we searched last.
  useEffect(() => {
    if (open) return
    const tabId = lastSearchedTabIdRef.current
    if (tabId) {
      window.electronAPI?.tabStopFindInPage?.(tabId, 'clearSelection')
      lastSearchedTabIdRef.current = null
    }
    setResult(null)
  }, [open])

  if (!open || !placement) return null

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      // Vim: Esc leaves the box for COMMAND mode; Esc there closes.
      if (vim.modeRef.current) inputRef.current?.blur()
      else onClose()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      // Vim: Enter ends the typing, as / does — the stepping is COMMAND's.
      if (vim.modeRef.current) inputRef.current?.blur()
      else findNext(!e.shiftKey)
    }
  }

  const counter = result
    ? result.total > 0
      ? `${result.active}/${result.total}`
      : 'No results'
    : ''
  const shift = isMac ? '⇧' : 'Shift'
  // What steps through the matches, for the buttons' tooltips.
  const nextKeys = vimKeymap ? vimKeyCapsAll(vimKeymap, 'find-next').join(' / ') : 'Enter'
  const prevKeys = vimKeymap ? vimKeyCapsAll(vimKeymap, 'find-prev').join(' / ') : `${shift}+Enter`

  return (
    <DetachedWindow
      open={open}
      title="Find - Newbro"
      width={WIDTH}
      height={HEIGHT}
      resizable={false}
      // In Vim mode Esc first leaves the box; the popup handles it.
      closeOnEscape={!vimKeymap}
      placement={placement}
      focusTick={focusTick}
      onClose={onClose}
      onWindowChange={setPopupWindow}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border overflow-hidden flex flex-col">
        <HintBar>
          {vim.mode === 'command' ? (
            <>
              <Hint label="Next" keys={vimKeyCapsAll(vimKeymap, 'find-next')} />
              <Hint label="Previous" keys={vimKeyCapsAll(vimKeymap, 'find-prev')} />
              <Hint label="Type" keys={vimKeyCaps(vimKeymap, 'insert-mode')} />
              <Hint label="Close" keys={['Esc']} />
            </>
          ) : vim.mode ? (
            <Hint label="Command mode" keys={['Enter', 'Esc']} />
          ) : (
            <>
              <Hint label="Next" keys={['Enter']} />
              <Hint label="Previous" keys={[shift, 'Enter']} />
              <Hint label="Close" keys={['Esc']} />
            </>
          )}
        </HintBar>
        <div className="flex h-11 items-center gap-2 px-3">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={vim.onBoxFocus}
            onBlur={vim.onBoxBlur}
            placeholder="Find in page"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
          />
          <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap select-none">
            {counter}
          </span>
          <button
            type="button"
            onClick={() => findNext(false)}
            disabled={!query}
            title={`Previous match (${prevKeys})`}
            className="p-1 rounded hover:bg-accent disabled:opacity-40 disabled:cursor-default"
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            onClick={() => findNext(true)}
            disabled={!query}
            title={`Next match (${nextKeys})`}
            className="p-1 rounded hover:bg-accent disabled:opacity-40 disabled:cursor-default"
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="p-1 rounded hover:bg-accent"
          >
            <X size={14} />
          </button>
          {vim.mode && <VimModeBadge mode={vim.mode} pending={vim.pending} />}
        </div>
      </div>
    </DetachedWindow>
  )
}
