// The address bar input, behaving like Chrome's / Edge's omnibox:
//
//  * Typing completes inline (the completion shown selected) only when
//    history says the URL may be — see src/main/history-match.ts — and never
//    right after deleting, pasting, mid-IME, or with the caret before the end.
//    Typing on through a completion keeps it instead of flickering.
//  * A suggestion list opens under the bar (a separate non-focusable window,
//    src/main/omnibox-popup.ts): the default match, history, past searches
//    and the search engine's suggestions.
//  * Keys: ↑/↓ (and Tab / Shift+Tab, PageUp/PageDown) move through the list,
//    showing the selected row's text; Enter opens it, Alt+Enter in a new tab,
//    Ctrl+Enter turns a bare word into www.<word>.com; Shift+Delete forgets
//    the selected history entry; Esc first returns to what you typed, then
//    restores the page's URL, then hands the keyboard back to the page.
//  * Opening a URL from here counts as a typed visit (Chrome's typed count,
//    which is what inline completion is based on) — except a URL that was
//    only pasted, which counts like a link click.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { isInternalUrl } from '../lib/internal-pages'
import {
  MAX_ROWS,
  buildMatches,
  wantsSearchSuggestions,
  whatYouTyped,
  type HistoryQueryResult,
  type OmniboxMatch,
} from '../lib/omnibox'
import type { OmniboxPopupEvent, OmniboxPopupRow, OmniboxPopupSpec } from './omnibox-protocol'

interface Props {
  tabId: string | null
  tabUrl: string
  /** The URL bar box: the suggestion list opens under it, as wide as it. */
  anchorRef: React.RefObject<HTMLDivElement | null>
}

type Disposition = 'current' | 'foreground-tab' | 'background-tab'

// Wait this long after the last keystroke before asking the search engine.
const SUGGEST_DELAY_MS = 90

function readThemeAttrs(): { theme?: string; themeVariant?: string; density?: string } {
  const root = document.documentElement
  return {
    theme: root.getAttribute('data-theme') ?? undefined,
    themeVariant: root.getAttribute('data-theme-variant') ?? undefined,
    density: root.getAttribute('data-density') ?? undefined,
  }
}

function toRow(m: OmniboxMatch): OmniboxPopupRow {
  return {
    kind: m.kind,
    contents: m.contents,
    description: m.description,
    favicon: m.favicon,
    removable: !!(m.removeUrl || m.removeTerm),
  }
}

export function Omnibox({ tabId, tabUrl, anchorRef }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(tabUrl)
  const [matches, setMatches] = useState<OmniboxMatch[]>([])
  const [selected, setSelected] = useState(0)
  const [popupOpen, setPopupOpen] = useState(false)
  const activePartition = useAppStore((s) => s.getActivePartition())

  // Everything async callbacks and key handlers must read fresh lives in refs.
  /** The user has edited the text since it last showed the page's URL. */
  const editingRef = useRef(false)
  /** Exactly what the user typed — without any inline completion. */
  const userTextRef = useRef('')
  /** Whether the last edit allows inline completion. */
  const allowInlineRef = useRef(false)
  /** The last edit was a paste (typed-visit accounting, see navigate). */
  const pastedRef = useRef(false)
  const historyRef = useRef<{ text: string; result: HistoryQueryResult } | null>(null)
  const suggestionsRef = useRef<{ text: string; items: string[] }>({ text: '', items: [] })
  const queryIdRef = useRef(0)
  const suggestIdRef = useRef(0)
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const matchesRef = useRef<OmniboxMatch[]>([])
  /** The rows the popup is showing — clicks resolve against these, so a
   *  click still lands if the bar reverted (blur) a moment before it. */
  const shownMatchesRef = useRef<OmniboxMatch[]>([])
  const selectedRef = useRef(0)
  const selectAllOnMouseUpRef = useRef(false)
  matchesRef.current = matches
  selectedRef.current = selected

  /** Show `text` and select [start, end). Written to the input right away,
   *  not after React re-renders: a keystroke arriving in between must land
   *  on this text and selection, or it would type into the middle of a
   *  completion that is about to replace it. React's state follows along
   *  (and then finds the input already up to date). */
  const showText = useCallback((text: string, start?: number, end?: number) => {
    setValue(text)
    const input = inputRef.current
    if (!input) return
    if (input.value !== text) input.value = text
    if (start !== undefined && document.activeElement === input) {
      try { input.setSelectionRange(start, end ?? text.length) }
      catch (err) { console.warn('Omnibox: setSelectionRange threw:', err) }
    }
  }, [])

  const closePopup = useCallback(() => {
    setPopupOpen(false)
    window.electronAPI.omniboxHide?.()
  }, [])

  /** Back to showing the page's URL, nothing being edited. */
  const revert = useCallback((selectAll: boolean) => {
    editingRef.current = false
    userTextRef.current = ''
    historyRef.current = null
    suggestionsRef.current = { text: '', items: [] }
    queryIdRef.current += 1
    suggestIdRef.current += 1
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
    setMatches([])
    setSelected(0)
    closePopup()
    if (selectAll) showText(tabUrl, 0, tabUrl.length)
    else showText(tabUrl)
  }, [tabUrl, closePopup, showText])

  // Follow the tab's URL while nothing is being edited (Chrome updates a
  // focused but untouched omnibox too). A full selection survives the update
  // — "focus the URL bar on new tab" selects it, and the page settling on
  // its final URL mustn't drop that.
  useEffect(() => {
    if (editingRef.current) return
    const input = inputRef.current
    const hadFullSelection = !!input && document.activeElement === input && input.value.length > 0 &&
      input.selectionStart === 0 && input.selectionEnd === input.value.length
    if (hadFullSelection) showText(tabUrl, 0, tabUrl.length)
    else showText(tabUrl)
  }, [tabUrl, showText])

  // Another tab: whatever was being typed belongs to the old one. (Only
  // tabId matters here — revert changes with every URL.)
  const revertRef = useRef(revert)
  revertRef.current = revert
  useEffect(() => {
    if (editingRef.current) revertRef.current(false)
  }, [tabId])

  /** Recompute the rows for the current input from the latest history and
   *  suggestion answers. The default takes the inline completion when the
   *  last edit allows it. */
  const rebuild = useCallback(() => {
    if (!editingRef.current) return
    const text = userTextRef.current
    const history = historyRef.current?.text === text ? historyRef.current.result : null
    const lower = text.trim().toLowerCase()
    const sugg = suggestionsRef.current
    // Older suggestions stay while they still fit what's typed, until the
    // engine answers for the new text — no list flicker on every key.
    const items = sugg.text === text ? sugg.items : sugg.items.filter((s) => s.toLowerCase().startsWith(lower))
    const next = buildMatches(text, history, items)
    const input = inputRef.current

    // Moving through the list: keep the selected row (by identity) and the
    // text it put in the bar.
    if (selectedRef.current > 0) {
      const current = matchesRef.current[selectedRef.current]
      const keep = current ? next.findIndex((m) => m.destination === current.destination && m.kind === current.kind) : -1
      if (keep > 0) {
        setMatches(next)
        setSelected(keep)
        return
      }
      if (current) {
        // It dropped out: pin it where it was rather than yank the text.
        const pinned = next.filter((m) => m.destination !== current.destination).slice(0, MAX_ROWS - 1)
        const at = Math.min(selectedRef.current, pinned.length)
        pinned.splice(at, 0, current)
        setMatches(pinned)
        setSelected(at)
        return
      }
    }

    const def = next[0]
    // Completing needs the caret where typing ended: at the end of the typed
    // text, whether or not the previous completion is still shown after it.
    if (def?.inlineCompletion && allowInlineRef.current && input && document.activeElement === input &&
        input.selectionStart === text.length && input.value.toLowerCase().startsWith(text.toLowerCase())) {
      showText(text + def.inlineCompletion, text.length, text.length + def.inlineCompletion.length)
    } else {
      if (def?.inlineCompletion) {
        // Not allowed to complete: the default is what was typed, as is.
        next[0] = { ...def, fill: text, inlineCompletion: undefined }
      }
      if (input && input.value !== text) showText(text, text.length, text.length)
    }
    setMatches(next)
    setSelected(0)
    setPopupOpen(next.length > 0 && document.activeElement === input)
  }, [showText])

  const requestHistory = useCallback((text: string, allowInline: boolean) => {
    const id = ++queryIdRef.current
    const query = window.electronAPI.historyQuery
    if (!query) return
    void query(text, allowInline).then((result) => {
      if (id !== queryIdRef.current || userTextRef.current !== text) return
      historyRef.current = { text, result: result as HistoryQueryResult }
      rebuild()
    }).catch((err) => console.warn('Omnibox: history query failed', err))
  }, [rebuild])

  const requestSuggestions = useCallback((text: string) => {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
    if (!wantsSearchSuggestions(text) || !window.electronAPI.omniboxSuggest) return
    suggestTimerRef.current = setTimeout(() => {
      const id = ++suggestIdRef.current
      void window.electronAPI.omniboxSuggest!(text, activePartition).then((items) => {
        if (id !== suggestIdRef.current || userTextRef.current !== text) return
        suggestionsRef.current = { text, items: items || [] }
        rebuild()
      }).catch(() => {})
    }, SUGGEST_DELAY_MS)
  }, [activePartition, rebuild])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.value
    const native = e.nativeEvent as InputEvent
    const inputType = native.inputType || ''
    const isDeletion = inputType ? inputType.startsWith('delete') : next.length < userTextRef.current.length
    const isPaste = inputType === 'insertFromPaste' || inputType === 'insertFromDrop'
    const composing = native.isComposing || inputType === 'insertCompositionText'
    const input = e.target
    const caretAtEnd = input.selectionStart === next.length && input.selectionEnd === next.length

    if (isPaste) pastedRef.current = true
    else if (!isDeletion) pastedRef.current = false

    editingRef.current = true
    userTextRef.current = next
    // Chrome: no inline completion right after deleting or pasting, while an
    // IME is composing, with the caret before the end, or after a trailing
    // space (that reads as a search).
    const allowInline = !isDeletion && !isPaste && !composing && caretAtEnd && !/\s$/.test(next)
    allowInlineRef.current = allowInline

    if (!next.trim()) {
      setValue(next)
      setMatches([])
      setSelected(0)
      closePopup()
      queryIdRef.current += 1
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
      return
    }

    // Typing on through the completion keeps it — the answer for the longer
    // text arrives a moment later and would otherwise flicker it off and on.
    const def = matchesRef.current[0]
    const shownFill = def?.inlineCompletion ? def.fill : null
    if (allowInline && shownFill && shownFill.length > next.length &&
        shownFill.toLowerCase().startsWith(next.toLowerCase())) {
      const completion = shownFill.slice(next.length)
      const updated = [...matchesRef.current]
      updated[0] = { ...def, fill: next + completion, inlineCompletion: completion }
      setMatches(updated)
      setSelected(0)
      showText(next + completion, next.length, next.length + completion.length)
    } else {
      setValue(next)
      if (selectedRef.current !== 0) setSelected(0)
    }

    requestHistory(next, allowInline)
    requestSuggestions(next)
  }

  /** The match Enter acts on: the selected row while its text is what the
   *  bar shows, else "what you typed" for whatever the bar now holds. */
  const currentMatch = (ctrl: boolean): OmniboxMatch | null => {
    const text = inputRef.current?.value ?? value
    const m = matchesRef.current[selectedRef.current]
    if (!ctrl && m && m.fill === text) return m
    return whatYouTyped(text, { ctrl })
  }

  const navigate = useCallback(async (m: OmniboxMatch, requested: Disposition) => {
    const api = window.electronAPI
    // Parked on a tab group there's no page to replace: open a tab instead.
    const disposition: Disposition = requested === 'current' && !tabId ? 'foreground-tab' : requested
    const url = m.destination
    // A URL that was only pasted in counts like a link click, not a typed
    // visit — it shouldn't start completing inline (Chrome's paste rule).
    const typed = m.typed && !(m.kind === 'navigate' && pastedRef.current)
    if (m.query) void api.historyAddSearchTerm?.(m.query)
    revert(false)
    inputRef.current?.blur()

    const store = useAppStore.getState()
    if (disposition !== 'current') {
      if (!store.activeWorkspaceId) return
      const newTabId = store.addTabNearActive(store.activeWorkspaceId, url, disposition === 'foreground-tab')
      if (newTabId && typed && !isInternalUrl(url)) api.historyNoteTyped?.(newTabId, url)
      return
    }
    if (!tabId) return
    // Internal pages (newbro://…) have no view to navigate: going to or from
    // one is a store change, and WebviewPanel drops or creates the view.
    if (isInternalUrl(url) || isInternalUrl(tabUrl)) {
      store.retargetTab(tabId, url)
      return
    }
    // Sent before the navigation starts, so main sees it first.
    if (typed) api.historyNoteTyped?.(tabId, url)
    // Enter on the page's own URL reloads it rather than stacking a history
    // entry (matches Cmd+R and the reload button).
    const state = await api.tabGetState?.(tabId)
    if (state && state.url === url) api.tabReload?.(tabId, true)
    else api.tabNavigate?.(tabId, url)
    store.updateTabUrl(tabId, url)
  }, [tabId, tabUrl, revert])

  /** Shift+Delete / the row's X: forget a history entry or past search, and
   *  refresh the list without it. */
  const removeMatch = useCallback((index: number) => {
    const m = matchesRef.current[index]
    if (!m || !(m.removeUrl || m.removeTerm)) return
    if (m.removeUrl) void window.electronAPI.historyRemove?.(m.removeUrl)
    else if (m.removeTerm) void window.electronAPI.historyRemoveSearchTerm?.(m.removeTerm)
    const rest = matchesRef.current.filter((_, i) => i !== index)
    setMatches(rest)
    const nextSelected = Math.min(index, rest.length - 1)
    setSelected(Math.max(0, nextSelected))
    const shown = rest[Math.max(0, nextSelected)]
    if (nextSelected > 0 && shown) showText(shown.fill, shown.fill.length, shown.fill.length)
    else showText(userTextRef.current, userTextRef.current.length, userTextRef.current.length)
    if (rest.length === 0) closePopup()
    // Ask again so the list fills back up — without re-completing inline.
    allowInlineRef.current = false
    requestHistory(userTextRef.current, false)
  }, [closePopup, requestHistory, showText])

  /** Move the list selection, showing the selected row's text in the bar;
   *  back on the default row, what was typed (and its completion) returns. */
  const moveSelection = useCallback((to: number) => {
    const list = matchesRef.current
    if (list.length === 0) return
    const index = Math.max(0, Math.min(list.length - 1, to))
    setSelected(index)
    const m = list[index]
    if (index === 0) {
      const text = userTextRef.current
      if (m.inlineCompletion) showText(text + m.inlineCompletion, text.length, text.length + m.inlineCompletion.length)
      else showText(m.fill, m.fill.length, m.fill.length)
    } else {
      showText(m.fill, m.fill.length, m.fill.length)
    }
  }, [showText])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const list = matchesRef.current
    const open = popupOpen && list.length > 0
    const sel = selectedRef.current

    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return
      e.preventDefault()
      const m = currentMatch(e.ctrlKey && !e.altKey)
      if (!m) return
      const disposition: Disposition = e.altKey
        ? 'foreground-tab'
        : e.metaKey ? 'background-tab' : 'current'
      void navigate(m, disposition)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) {
        if (e.key === 'ArrowDown' && editingRef.current && list.length > 0) {
          e.preventDefault()
          setPopupOpen(true)
        }
        return
      }
      e.preventDefault()
      moveSelection(sel + (e.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (open && (e.key === 'PageDown' || e.key === 'PageUp')) {
      e.preventDefault()
      moveSelection(e.key === 'PageDown' ? list.length - 1 : 0)
      return
    }
    if (open && e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Chrome: Tab steps through the list while it's open.
      const to = sel + (e.shiftKey ? -1 : 1)
      if (to >= 0 && to < list.length) {
        e.preventDefault()
        moveSelection(to)
      }
      return
    }
    if (e.key === 'Delete' && e.shiftKey && open) {
      const m = list[sel]
      if (m && (m.removeUrl || m.removeTerm)) {
        e.preventDefault()
        removeMatch(sel)
      }
      return
    }
    if ((e.key === 'ArrowRight' || e.key === 'End') && list[0]?.inlineCompletion && sel === 0) {
      // Accepting the completion: it becomes typed text.
      const input = e.currentTarget
      if (input.selectionEnd === input.value.length && input.selectionStart !== input.selectionEnd) {
        userTextRef.current = input.value
        const updated = [...list]
        updated[0] = { ...list[0], fill: input.value, inlineCompletion: undefined }
        setMatches(updated)
      }
      return
    }
    if (e.key === 'Escape') {
      if (sel > 0 && open) {
        // 1st: back to what was typed.
        e.preventDefault()
        e.stopPropagation()
        moveSelection(0)
        return
      }
      if (editingRef.current || popupOpen) {
        // 2nd: drop the edit, show the page's URL selected.
        e.preventDefault()
        e.stopPropagation()
        revert(true)
        return
      }
      // 3rd: App's global Esc handler hands the keyboard to the page.
    }
  }

  // Clicks and removals from the popup window.
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  const removeRef = useRef(removeMatch)
  removeRef.current = removeMatch
  useEffect(() => {
    const cleanup = window.electronAPI.onOmniboxEvent?.((raw) => {
      const evt = raw as OmniboxPopupEvent
      const m = shownMatchesRef.current[evt.index]
      if (!m) return
      if (evt.type === 'remove') {
        if (matchesRef.current[evt.index] === m) removeRef.current(evt.index)
        return
      }
      const background = evt.button === 1 || evt.ctrlKey || evt.metaKey
      const disposition: Disposition = background ? 'background-tab' : evt.shiftKey ? 'foreground-tab' : 'current'
      void navigateRef.current(m, disposition)
    })
    return cleanup
  }, [])

  // Show, update or hide the popup window.
  useEffect(() => {
    const anchor = anchorRef.current
    if (!popupOpen || matches.length === 0 || !anchor) {
      window.electronAPI.omniboxHide?.()
      return
    }
    shownMatchesRef.current = matches
    const rect = anchor.getBoundingClientRect()
    const spec: OmniboxPopupSpec = {
      anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      rows: matches.map(toRow),
      selected,
      terms: userTextRef.current.toLowerCase().split(/\s+/).filter(Boolean),
      ...readThemeAttrs(),
    }
    window.electronAPI.omniboxShow?.(spec)
  }, [popupOpen, matches, selected, anchorRef])

  // The popup is laid out for this window size; a resize closes it.
  useEffect(() => {
    if (!popupOpen) return
    const onResize = (): void => closePopup()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [popupOpen, closePopup])

  useEffect(() => () => {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
    window.electronAPI.omniboxHide?.()
  }, [])

  return (
    <input
      id="url-bar"
      ref={inputRef}
      type="text"
      value={value}
      role="combobox"
      aria-autocomplete="both"
      aria-expanded={popupOpen}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onFocus={() => { window.electronAPI.omniboxPrewarm?.() }}
      onMouseDown={(e) => {
        // Chrome's first click selects the whole address.
        selectAllOnMouseUpRef.current = document.activeElement !== e.currentTarget
      }}
      onMouseUp={(e) => {
        if (!selectAllOnMouseUpRef.current) return
        selectAllOnMouseUpRef.current = false
        const input = e.currentTarget
        if (input.selectionStart === input.selectionEnd) {
          e.preventDefault()
          input.select()
        }
      }}
      onBlur={(e) => {
        // Browsers keep a dimmed selection on a blurred input; collapse it so
        // the bar reads as plain text once focus moves away.
        try { e.currentTarget.setSelectionRange(0, 0) }
        catch (err) { console.warn('Omnibox: onBlur setSelectionRange threw:', err) }
        selectAllOnMouseUpRef.current = false
        // Leaving drops the edit and closes the list; the bar shows the
        // page's URL again.
        if (editingRef.current || popupOpen) revert(false)
      }}
      placeholder="Enter URL or search..."
      spellCheck={false}
      autoComplete="off"
      className="flex-1 h-full px-2.5 bg-transparent border-none text-sm text-foreground outline-none"
    />
  )
}
