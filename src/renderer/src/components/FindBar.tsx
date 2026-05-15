import { useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, CornerDownLeft, X } from 'lucide-react'
import { useAppStore } from '../store/app-store'

const isMac = navigator.platform.toLowerCase().includes('mac')

interface Props {
  open: boolean
  /** Increments on every Cmd+F press. A second press while the bar is
   *  already open re-focuses + selects the input — Chrome / Firefox
   *  parity. The first press handles itself via `open` transitioning to
   *  true, so the initial value (0) is intentionally inert. */
  focusTick: number
  onClose: () => void
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

/**
 * In-page find. Docks above the WebviewPanel container so it sits above the
 * active tab's WebContentsView (which is layered on top of the renderer DOM
 * — anything inside the WebviewPanel's bounds would be obscured by the
 * native view). Calls into webContents.findInPage / stopFindInPage via IPC
 * and listens for 'found-in-page' on the existing tab-event stream.
 */
export function FindBar({ open, focusTick, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<MatchInfo | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Tab we most recently asked main to search. Used so that switching tabs
  // (or closing the bar) can clear highlights on the previous tab even after
  // activeTabId has already moved on.
  const lastSearchedTabIdRef = useRef<string | null>(null)
  const activeTabId = useAppStore((s) => s.activeTabId)

  // Focus input + pull OS focus back from the active tab whenever the bar
  // opens OR Cmd+F fires again while open. Without focusWindowRenderer()
  // the active WebContentsView keeps OS keyboard focus and our input is
  // decorative — the same trick the URL bar uses (see lib/focus-url-bar.ts).
  useEffect(() => {
    if (!open) return
    window.electronAPI?.focusWindowRenderer?.()
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [open, focusTick])

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
  // the bar is open. Switching tabs first clears highlights on the previous
  // tab so the user doesn't see two pages lit up at once.
  //
  // `findNext: true` is the counter-intuitive Electron flag for "begin a new
  // text finding session" — Chromium's underlying find API names it from the
  // session's perspective, not the request's. Each keystroke is a fresh
  // query so we always pass true here; the prev/next buttons below use
  // false to advance the active match within the existing session.
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

  // Cleanup when the bar closes — drop highlights on whichever tab we
  // searched last.
  useEffect(() => {
    if (open) return
    const tabId = lastSearchedTabIdRef.current
    if (tabId) {
      window.electronAPI?.tabStopFindInPage?.(tabId, 'clearSelection')
      lastSearchedTabIdRef.current = null
    }
    setResult(null)
  }, [open])

  if (!open) return null

  const findNext = (forward: boolean): void => {
    if (!query || !activeTabId) return
    // `findNext: false` = advance within the existing session (the typing
    // effect above seeded it with findNext: true). Pairing with `forward`
    // gives prev/next navigation over the same matches.
    window.electronAPI?.tabFindInPage?.(activeTabId, query, { findNext: false, forward })
    lastSearchedTabIdRef.current = activeTabId
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      findNext(!e.shiftKey)
    }
  }

  const counter = result
    ? result.total > 0
      ? `${result.active}/${result.total}`
      : 'No results'
    : ''

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-toolbar text-foreground shrink-0">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in page"
        className="flex-1 bg-input/40 border border-border rounded px-2 py-1 text-sm outline-none focus:border-ring"
      />
      <span className="text-xs text-muted-foreground tabular-nums min-w-[64px] text-right select-none">
        {counter}
      </span>
      <div className="flex items-center gap-0.5">
        <kbd className="text-[10px]">{isMac ? '⇧' : 'Shift'}</kbd>
        <kbd className="text-[10px]"><CornerDownLeft size={10} strokeWidth={2.5} /></kbd>
        <button
          type="button"
          onClick={() => findNext(false)}
          disabled={!query}
          title="Previous match"
          className="ml-0.5 p-1 rounded hover:bg-accent disabled:opacity-40 disabled:cursor-default"
        >
          <ChevronUp size={14} />
        </button>
      </div>
      <div className="flex items-center gap-0.5">
        <kbd className="text-[10px]"><CornerDownLeft size={10} strokeWidth={2.5} /></kbd>
        <button
          type="button"
          onClick={() => findNext(true)}
          disabled={!query}
          title="Next match"
          className="ml-0.5 p-1 rounded hover:bg-accent disabled:opacity-40 disabled:cursor-default"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      <button
        type="button"
        onClick={onClose}
        title="Close (Esc)"
        className="p-1 rounded hover:bg-accent"
      >
        <X size={14} />
      </button>
    </div>
  )
}
