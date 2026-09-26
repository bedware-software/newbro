// The address bar's suggestion model — Chrome's omnibox, reduced to its
// visible behavior. One default match comes first: a history URL completed
// inline, a known URL spelled out in full, or "what you typed" (open it, or
// search for it). History rows, past searches and the search engine's
// suggestions follow, eight rows at most. Matching and ranking history is
// main's job (src/main/history.ts, history-match.ts); this module turns its
// answer into rows.

import type { OmniboxRowKind } from '../components/omnibox-protocol'
import { looksLikeSearch, normalizeURL, searchEngineName, searchUrlFor } from './url'

/** Main's answer to one input (see HistoryQueryResult in src/main/history.ts). */
export interface HistoryQueryResult {
  inline: {
    url: string
    title: string
    favicon: string
    fill: string
    completion: string
    exact: boolean
    display: string
  } | null
  matches: Array<{ url: string; title: string; favicon: string; display: string; typed: boolean }>
  searchTerms: Array<{ term: string; display: string }>
}

export interface OmniboxMatch {
  kind: OmniboxRowKind
  /** Where Enter takes you. */
  destination: string
  /** What the address bar shows while this match is selected. */
  fill: string
  /** Row text: the URL as shown, or the query. */
  contents: string
  /** Row secondary text: the page title, or "Search Google". */
  description: string
  favicon?: string
  /** Search rows: the query, remembered as a past search when run. */
  query?: string
  /** History rows: the URL Shift+Delete forgets. */
  removeUrl?: string
  /** Past-search rows: the search Shift+Delete forgets. */
  removeTerm?: string
  /** Opening it counts as a typed visit (Chrome's typed count). */
  typed: boolean
  /** Default match only: text appended after the input and shown selected. */
  inlineCompletion?: string
}

export const MAX_ROWS = 8

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** Same collapsing as main's dedupeKey: scheme, "www." and a bare host's
 *  trailing "/" don't make two suggestions different. */
function urlKey(url: string): string {
  const s = url.replace(SCHEME, '').replace(/^www\.(?=[^/])/i, '')
  const slash = s.indexOf('/')
  const host = (slash === -1 ? s : s.slice(0, slash)).toLowerCase()
  const path = slash === -1 ? '' : s.slice(slash)
  return host + (path === '/' ? '' : path)
}

function searchMatch(query: string, kind: 'search' | 'search-history' | 'suggest', fill = query): OmniboxMatch {
  return {
    kind,
    destination: searchUrlFor(query),
    fill,
    contents: query,
    description: kind === 'search' ? `Search ${searchEngineName()}` : '',
    query,
    typed: false,
    ...(kind === 'search-history' ? { removeTerm: query } : {}),
  }
}

/**
 * "What you typed": open the input as an address, or search for it.
 * `ctrl` is Ctrl+Enter — Chrome's "www." + input + ".com" for a bare word.
 */
export function whatYouTyped(text: string, opts: { ctrl?: boolean } = {}): OmniboxMatch | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (opts.ctrl && /^[^\s./:?#]+$/.test(trimmed)) {
    const url = `https://www.${trimmed}.com/`
    return { kind: 'navigate', destination: url, fill: `www.${trimmed}.com`, contents: `www.${trimmed}.com`, description: '', typed: true }
  }
  if (looksLikeSearch(trimmed)) return searchMatch(trimmed, 'search', text)
  const url = normalizeURL(trimmed)
  if (!url) return null
  return { kind: 'navigate', destination: url, fill: text, contents: trimmed, description: '', typed: true }
}

/** The rows for one input: the default first, then the rest by kind of
 *  input — a query leads with past searches and suggestions, an address
 *  with history. */
export function buildMatches(text: string, history: HistoryQueryResult | null, suggestions: string[]): OmniboxMatch[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const rows: OmniboxMatch[] = []
  const seenUrls = new Set<string>()
  const seenQueries = new Set<string>()
  const add = (m: OmniboxMatch | null): void => {
    if (!m || rows.length >= MAX_ROWS) return
    if (m.query !== undefined) {
      const key = m.query.trim().toLowerCase()
      if (seenQueries.has(key)) return
      seenQueries.add(key)
    } else {
      const key = urlKey(m.destination)
      if (seenUrls.has(key)) return
      seenUrls.add(key)
    }
    rows.push(m)
  }

  const inline = history?.inline
  if (inline) {
    add({
      kind: 'history',
      destination: inline.url,
      // A known URL typed in full keeps the text exactly as typed.
      fill: inline.exact ? text : inline.fill,
      contents: inline.display,
      description: inline.title,
      favicon: inline.favicon || undefined,
      removeUrl: inline.url,
      typed: true,
      ...(inline.completion ? { inlineCompletion: inline.completion } : {}),
    })
  } else {
    add(whatYouTyped(text))
  }

  const historyRows = (history?.matches ?? []).map((h): OmniboxMatch => ({
    kind: 'history',
    destination: h.url,
    fill: h.display,
    contents: h.display,
    description: h.title,
    favicon: h.favicon || undefined,
    removeUrl: h.url,
    typed: true,
  }))
  const pastSearches = (history?.searchTerms ?? []).map((t) => searchMatch(t.display, 'search-history'))
  const suggested = suggestions.map((s) => searchMatch(s, 'suggest'))
  // "<input> – Search Google" stays on offer when the default opens a page.
  const verbatimSearch = SCHEME.test(trimmed) ? null : searchMatch(trimmed, 'search', text)

  if (looksLikeSearch(trimmed)) {
    // A word completed to a URL ("git" → github.com) is still one Enter-less
    // step from being searched for, right below.
    add(verbatimSearch)
    pastSearches.slice(0, 2).forEach(add)
    historyRows.slice(0, 3).forEach(add)
    suggested.forEach(add)
    historyRows.slice(3).forEach(add)
    pastSearches.slice(2).forEach(add)
  } else {
    historyRows.slice(0, 4).forEach(add)
    add(verbatimSearch)
    pastSearches.slice(0, 1).forEach(add)
    suggested.slice(0, 3).forEach(add)
    historyRows.slice(4).forEach(add)
    suggested.slice(3).forEach(add)
  }
  return rows
}

/** Whether to ask the search engine about this input: not for anything that
 *  is plainly an address with a scheme, or a local path. */
export function wantsSearchSuggestions(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || SCHEME.test(trimmed)) return false
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) return false
  return true
}
