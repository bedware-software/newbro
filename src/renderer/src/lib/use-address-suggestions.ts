// The address suggestions, as Chrome's / Edge's omnibox has them, for the
// box the address is typed in — the address editor (components/UrlEditor.tsx),
// where every edit of the address happens:
//
//  * Typing completes inline (the completion shown selected) only when
//    history says the URL may be — see src/main/history-match.ts — and never
//    right after deleting, pasting, mid-IME, or with the caret before the end.
//    Typing on through a completion keeps it instead of flickering.
//  * A suggestion list opens under the editor (a separate non-focusable
//    window, src/main/omnibox-popup.ts): the default match, history, past
//    searches and the search engine's suggestions.
//  * Keys: ↑/↓ (and Tab / Shift+Tab, PageUp/PageDown) move through the list,
//    showing the selected row's text; Enter opens it, Alt+Enter in a new tab,
//    Ctrl+Enter turns a bare word into www.<word>.com; Shift+Delete forgets
//    the selected history entry; Esc first returns to what you typed, then
//    closes the list.
//  * Opening a URL from here counts as a typed visit (Chrome's typed count,
//    which is what inline completion is based on) — except a URL that was
//    only pasted, which counts like a link click.
//
// The box lives in a popup window of its own: its document is the input's
// ownerDocument, never this window's.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { isInternalUrl } from './internal-pages'
import { resolveBang, resolveBangs, withBang } from './bangs'
import { openBangGroup } from './multi-bang'
import {
  MAX_ROWS,
  buildMatches,
  wantsSearchSuggestions,
  whatYouTyped,
  type HistoryQueryResult,
  type OmniboxMatch,
} from './omnibox'
import type { OmniboxPopupEvent, OmniboxPopupRow, OmniboxPopupSpec } from '../components/omnibox-protocol'

export type Disposition = 'current' | 'foreground-tab' | 'background-tab'

/** A box in the opener window's content area, CSS px. */
export interface SuggestionAnchor {
  x: number
  y: number
  width: number
  height: number
}

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
    ...(m.bang ? { bang: m.bang } : {}),
  }
}

/** Whether `input` has the keyboard in its own window. */
function isFocused(input: HTMLInputElement | null): boolean {
  return !!input && input.ownerDocument.activeElement === input
}

export interface AddressSuggestions {
  /** Whether the list is up. */
  popupOpen: boolean
  /** What's typed differs from the page's address. */
  editing: () => boolean
  /** The box's onInput (not onChange: see inside). */
  handleInput: (e: React.FormEvent<HTMLInputElement>) => void
  /** The box's keys but Enter and Esc: true when the list took the key. */
  handleKey: (e: React.KeyboardEvent<HTMLInputElement>) => boolean
  /** Esc: back to what was typed, then the list closes; false when there
   *  was nothing to do and Esc is the box's own. */
  escape: () => boolean
  /** Enter: opens what the box shows — the selected row, or what's typed. */
  commit: (disposition: Disposition, ctrl: boolean) => void
  /** Drops the list and everything typed into it, the box left as it is
   *  (an edit of the box that isn't typing: COMMAND's). */
  reset: () => void
}

export function useAddressSuggestions({ inputRef, tabId, tabUrl, blankTab, enabled, onText, getAnchor, onNavigated, onSelected }: {
  inputRef: React.RefObject<HTMLInputElement | null>
  /** The tab the address is for; null parked on a group. */
  tabId: string | null
  /** Its address now. */
  tabUrl: string
  /** The tab is a new one being typed into: a group of bang searches puts
   *  its first search in it rather than open one more. */
  blankTab: boolean
  /** Typing in the box (INSERT, the editor up); off, the list goes. */
  enabled: boolean
  /** The box's text, for the owner's state. */
  onText: (text: string) => void
  /** Where the list hangs from. */
  getAnchor: () => SuggestionAnchor | null
  /** Something was opened — by Enter or a click on a row. */
  onNavigated: () => void
  /** The box selected part of its text itself (an inline completion). */
  onSelected?: () => void
}): AddressSuggestions {
  const [matches, setMatches] = useState<OmniboxMatch[]>([])
  const [selected, setSelected] = useState(0)
  const [popupOpen, setPopupOpen] = useState(false)
  const activePartition = useAppStore((s) => s.getActivePartition())

  // Everything async callbacks and key handlers must read fresh lives in refs.
  /** The user has typed since the box last showed the page's URL. */
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
  /** The rows the popup is showing — clicks resolve against these. */
  const shownMatchesRef = useRef<OmniboxMatch[]>([])
  const selectedRef = useRef(0)
  matchesRef.current = matches
  selectedRef.current = selected
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const onSelectedRef = useRef(onSelected)
  onSelectedRef.current = onSelected
  const getAnchorRef = useRef(getAnchor)
  getAnchorRef.current = getAnchor

  /** Show `text` and select [start, end). Written to the input right away,
   *  not after React re-renders: a keystroke arriving in between must land
   *  on this text and selection, or it would type into the middle of a
   *  completion that is about to replace it. */
  const showText = useCallback((text: string, start?: number, end?: number) => {
    onTextRef.current(text)
    const input = inputRef.current
    if (!input) return
    if (input.value !== text) input.value = text
    if (start !== undefined && isFocused(input)) {
      try {
        input.setSelectionRange(start, end ?? text.length)
        if ((end ?? text.length) > start) onSelectedRef.current?.()
      } catch (err) { console.warn('address suggestions: setSelectionRange threw:', err) }
    }
  }, [inputRef])

  const closePopup = useCallback(() => {
    setPopupOpen(false)
    window.electronAPI.omniboxHide?.()
  }, [])

  const reset = useCallback(() => {
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
  }, [closePopup])

  // Off (COMMAND, the editor closing): nothing typed is left, nor its list.
  useEffect(() => {
    if (!enabled) reset()
  }, [enabled, reset])

  // Another tab: whatever was being typed belongs to the old one.
  const resetRef = useRef(reset)
  resetRef.current = reset
  useEffect(() => {
    if (editingRef.current) resetRef.current()
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
    // text it put in the box.
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
    if (def?.inlineCompletion && allowInlineRef.current && input && isFocused(input) &&
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
    setPopupOpen(next.length > 0 && isFocused(input))
  }, [inputRef, showText])

  const requestHistory = useCallback((text: string, allowInline: boolean) => {
    const id = ++queryIdRef.current
    const query = window.electronAPI.historyQuery
    if (!query) return
    void query(text, allowInline).then((result) => {
      if (id !== queryIdRef.current || userTextRef.current !== text) return
      historyRef.current = { text, result: result as HistoryQueryResult }
      rebuild()
    }).catch((err) => console.warn('address suggestions: history query failed', err))
  }, [rebuild])

  const requestSuggestions = useCallback((text: string) => {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
    if (!wantsSearchSuggestions(text) || !window.electronAPI.omniboxSuggest) return
    // With a bang the engine is asked about the query alone, and each answer
    // keeps the bang: "!w vim" → "!w vim editor", still Wikipedia.
    const bang = resolveBang(text)
    if (bang && !bang.query.trim()) return
    const asked = bang ? bang.query : text
    suggestTimerRef.current = setTimeout(() => {
      const id = ++suggestIdRef.current
      void window.electronAPI.omniboxSuggest!(asked, activePartition).then((items) => {
        if (id !== suggestIdRef.current || userTextRef.current !== text) return
        const list = items || []
        suggestionsRef.current = { text, items: bang ? list.map((q) => withBang(bang, q)) : list }
        rebuild()
      }).catch((err) => console.warn('address suggestions: search suggestions failed', err))
    }, SUGGEST_DELAY_MS)
  }, [activePartition, rebuild])

  /** Every edit, including one that leaves the text as it was: typing the
   *  last letter of a completion over its selection gives the same string
   *  showText put there, and React's onChange skips that as "no change" —
   *  the typed text would stay a letter short, and an answer still on its
   *  way for it would cut that letter off the box. Hence onInput. */
  const handleInput = (e: React.FormEvent<HTMLInputElement>): void => {
    const input = e.currentTarget
    const next = input.value
    const native = e.nativeEvent as InputEvent
    const inputType = native.inputType || ''
    const isDeletion = inputType ? inputType.startsWith('delete') : next.length < userTextRef.current.length
    const isPaste = inputType === 'insertFromPaste' || inputType === 'insertFromDrop'
    const composing = native.isComposing || inputType === 'insertCompositionText'
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
      onTextRef.current(next)
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
      onTextRef.current(next)
      if (selectedRef.current !== 0) setSelected(0)
    }

    requestHistory(next, allowInline)
    requestSuggestions(next)
  }

  const tabIdRef = useRef(tabId)
  tabIdRef.current = tabId
  const tabUrlRef = useRef(tabUrl)
  tabUrlRef.current = tabUrl
  const blankTabRef = useRef(blankTab)
  blankTabRef.current = blankTab
  const onNavigatedRef = useRef(onNavigated)
  onNavigatedRef.current = onNavigated

  const navigate = useCallback(async (m: OmniboxMatch, requested: Disposition) => {
    const api = window.electronAPI
    const tab = tabIdRef.current
    // Parked on a tab group there's no page to replace: open a tab instead.
    const disposition: Disposition = requested === 'current' && !tab ? 'foreground-tab' : requested
    // A URL that was only pasted in counts like a link click, not a typed
    // visit — it shouldn't start completing inline (Chrome's paste rule).
    const typed = m.typed && !(m.kind === 'navigate' && pastedRef.current)
    if (m.query) void api.historyAddSearchTerm?.(m.query)
    reset()
    onNavigatedRef.current()

    const store = useAppStore.getState()
    // Several bangs (or a label of bangs): each site's search in a tab of
    // its own, together in a group named for the query.
    const many = m.query !== undefined ? resolveBangs(m.query) : null
    if (many && many.bangs.length > 1) {
      openBangGroup(many, disposition === 'current' && blankTabRef.current ? tab : null, disposition !== 'background-tab')
      return
    }
    const url = m.destination
    if (disposition !== 'current') {
      if (!store.activeWorkspaceId) return
      const newTabId = store.addTabNearActive(store.activeWorkspaceId, url, disposition === 'foreground-tab')
      if (newTabId && typed && !isInternalUrl(url)) api.historyNoteTyped?.(newTabId, url)
      return
    }
    if (!tab) return
    // Internal pages (vimperium://…) have no view to navigate: going to or from
    // one is a store change, and WebviewPanel drops or creates the view.
    if (isInternalUrl(url) || isInternalUrl(tabUrlRef.current)) {
      store.retargetTab(tab, url)
      return
    }
    // Sent before the navigation starts, so main sees it first.
    if (typed) api.historyNoteTyped?.(tab, url)
    // Enter on the page's own URL reloads it rather than stacking a history
    // entry (matches Cmd+R and the reload button).
    const state = await api.tabGetState?.(tab)
    if (state && state.url === url) api.tabReload?.(tab, true)
    else api.tabNavigate?.(tab, url)
    store.updateTabUrl(tab, url)
  }, [reset])

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

  /** Move the list selection, showing the selected row's text in the box;
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

  const popupOpenRef = useRef(popupOpen)
  popupOpenRef.current = popupOpen

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    const list = matchesRef.current
    const open = popupOpenRef.current && list.length > 0
    const sel = selectedRef.current
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) {
        if (e.key === 'ArrowDown' && editingRef.current && list.length > 0) {
          e.preventDefault()
          setPopupOpen(true)
          return true
        }
        return false
      }
      e.preventDefault()
      moveSelection(sel + (e.key === 'ArrowDown' ? 1 : -1))
      return true
    }
    if (open && (e.key === 'PageDown' || e.key === 'PageUp')) {
      e.preventDefault()
      moveSelection(e.key === 'PageDown' ? list.length - 1 : 0)
      return true
    }
    if (open && e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Chrome: Tab steps through the list while it's open.
      e.preventDefault()
      const to = sel + (e.shiftKey ? -1 : 1)
      if (to >= 0 && to < list.length) moveSelection(to)
      return true
    }
    if (e.key === 'Delete' && e.shiftKey && open) {
      const m = list[sel]
      if (m && (m.removeUrl || m.removeTerm)) {
        e.preventDefault()
        removeMatch(sel)
        return true
      }
      return false
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
      return false
    }
    return false
  }

  const escape = (): boolean => {
    const open = popupOpenRef.current && matchesRef.current.length > 0
    if (open && selectedRef.current > 0) {
      // 1st: back to what was typed.
      moveSelection(0)
      return true
    }
    if (open) {
      // 2nd: the list goes, what's typed stays.
      closePopup()
      return true
    }
    return false
  }

  /** The match Enter acts on: the selected row while its text is what the
   *  box shows, else "what you typed" for whatever the box now holds. */
  const commit = (disposition: Disposition, ctrl: boolean): void => {
    const text = inputRef.current?.value ?? ''
    const m = matchesRef.current[selectedRef.current]
    const match = !ctrl && m && m.fill === text ? m : whatYouTyped(text, { ctrl })
    if (match) void navigate(match, disposition)
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
    const anchor = popupOpen && matches.length > 0 ? getAnchorRef.current() : null
    if (!anchor) {
      window.electronAPI.omniboxHide?.()
      return
    }
    shownMatchesRef.current = matches
    const spec: OmniboxPopupSpec = {
      anchor,
      rows: matches.map(toRow),
      selected,
      terms: userTextRef.current.toLowerCase().split(/\s+/).filter(Boolean),
      ...readThemeAttrs(),
    }
    window.electronAPI.omniboxShow?.(spec)
  }, [popupOpen, matches, selected])

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

  return {
    popupOpen,
    editing: () => editingRef.current,
    handleInput,
    handleKey,
    escape,
    commit,
    reset,
  }
}
