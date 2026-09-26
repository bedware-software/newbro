// Matching and ranking behind the address bar's history suggestions — the
// rules of Chromium's HistoryURLProvider (inline autocomplete) and
// HistoryQuickProvider (the dropdown), reduced to what Newbro needs. Pure
// functions over plain records: storage lives in history.ts.

export const DAY_MS = 24 * 60 * 60 * 1000

/** One URL's history, as stored. */
export interface HistoryRecord {
  url: string
  title: string
  favicon: string
  visitCount: number
  /** Visits the user started from the address bar (typed or picked there). */
  typedCount: number
  lastVisit: number
}

/** A record plus the forms matching works on, computed once per URL. */
export interface IndexedRecord extends HistoryRecord {
  scheme: string
  /** Decoded URL after "scheme://", lowercased: "www.google.com/maps". */
  afterScheme: string
  /** afterScheme without a leading "www.": "google.com/maps". */
  afterWww: string
  /** The same two in the URL's own case — completions are taken from these. */
  displayAfterScheme: string
  displayAfterWww: string
  titleLower: string
  /** Just the host: path "/", no query, no fragment. */
  hostOnly: boolean
  /** "scheme://host/" — the host root the URL lives under. */
  root: string
}

export interface ParsedInput {
  /** What the user typed, leading whitespace dropped. */
  text: string
  /** Scheme the user typed ("https"), or null. */
  scheme: string | null
  /** Lowercased input after the typed "scheme://", if any. */
  rest: string
  /** The input starts (after any scheme) with "www." — match with it, not past it. */
  restHasWww: boolean
  /** Still typing the host: nothing past it (no "/") yet. */
  withinHost: boolean
  /** Lowercased words, for the dropdown's word matching. */
  terms: string[]
}

export interface PrefixMatch {
  /** Text to append after the input — in the URL's own case, a bare host's
   *  trailing "/" dropped. Empty when the input already is the whole URL. */
  completion: string
}

export interface InlineCandidate {
  url: string
  title: string
  favicon: string
  /** Input + completion: what the address bar shows. */
  fill: string
  completion: string
  /** The input already is this URL — the default without any completion. */
  exact: boolean
}

export interface ShorterSuggestion {
  url: string
  display: string
}

// Chrome's thresholds for a "significant" URL (RowQualifiesAsSignificant):
// only these take part in suggestions at all.
const SIGNIFICANT_TYPED = 1
const SIGNIFICANT_VISITS = 4
const SIGNIFICANT_AGE_MS = 3 * DAY_MS

function safeDecode(s: string): string {
  try { return decodeURI(s) } catch { return s }
}

export function indexRecord(record: HistoryRecord): IndexedRecord | null {
  let parsed: URL
  try { parsed = new URL(record.url) } catch { return null }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(record.url)
  if (!schemeMatch) return null
  const displayAfterScheme = safeDecode(record.url.slice(schemeMatch[0].length))
  // "www." counts as a prefix only with more host after it.
  const displayAfterWww = /^www\.[^/]/i.test(displayAfterScheme) ? displayAfterScheme.slice(4) : displayAfterScheme
  return {
    ...record,
    scheme: schemeMatch[1].toLowerCase(),
    afterScheme: displayAfterScheme.toLowerCase(),
    afterWww: displayAfterWww.toLowerCase(),
    displayAfterScheme,
    displayAfterWww,
    titleLower: record.title.toLowerCase(),
    hostOnly: parsed.pathname === '/' && !parsed.search && !parsed.hash,
    root: `${parsed.protocol}//${parsed.host}/`,
  }
}

/** How a suggestion row shows a URL: no scheme, no "www.", no trailing "/"
 *  on a bare host — Chrome's omnibox formatting. */
export function displayUrl(record: IndexedRecord): string {
  return record.hostOnly ? record.displayAfterWww.replace(/\/$/, '') : record.displayAfterWww
}

/** Collapses the variants Chrome treats as one suggestion: scheme, "www."
 *  and a bare host's trailing "/" don't make a URL different. */
export function dedupeKey(url: string): string {
  const s = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\.(?=[^/])/i, '')
  const slash = s.indexOf('/')
  const host = (slash === -1 ? s : s.slice(0, slash)).toLowerCase()
  const path = slash === -1 ? '' : s.slice(slash)
  return host + (path === '/' ? '' : path)
}

export function parseInput(raw: string): ParsedInput {
  const text = raw.replace(/^\s+/, '')
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)
  const rest = (schemeMatch ? text.slice(schemeMatch[0].length) : text).toLowerCase()
  return {
    text,
    scheme: schemeMatch ? schemeMatch[1].toLowerCase() : null,
    rest,
    restHasWww: rest.startsWith('www.'),
    withinHost: !rest.includes('/'),
    terms: text.toLowerCase().split(/\s+/).filter(Boolean),
  }
}

export function isSignificant(r: HistoryRecord, now: number): boolean {
  return r.typedCount >= SIGNIFICANT_TYPED || r.visitCount >= SIGNIFICANT_VISITS || r.lastVisit >= now - SIGNIFICANT_AGE_MS
}

/** Chrome's CanPromoteMatchForInlineAutocomplete: a bare host completes
 *  inline once it's been typed, a deeper URL once it's been typed twice. */
export function canInline(r: HistoryRecord & { hostOnly: boolean }): boolean {
  return r.typedCount > 0 && (r.typedCount > 1 || r.hostOnly)
}

/** Where the input lines up with a URL, by Chrome's URL-prefix rules: right
 *  after "scheme://www.", right after "scheme://", or from the start when
 *  the scheme was typed too. The longer prefix wins, so "w" completes
 *  "ashingtonpost.com" rather than "ww.washingtonpost.com". */
export function prefixMatch(record: IndexedRecord, input: ParsedInput): PrefixMatch | null {
  if (!input.rest) return null
  if (input.scheme && input.scheme !== record.scheme) return null
  const forms: Array<[string, string]> = input.restHasWww
    ? [[record.afterScheme, record.displayAfterScheme]]
    : [[record.afterWww, record.displayAfterWww], [record.afterScheme, record.displayAfterScheme]]
  for (const [key, display] of forms) {
    if (!key.startsWith(input.rest)) continue
    // Lowercasing can change a string's length (rare Unicode); fall back to
    // the lowercased form rather than slicing at the wrong place.
    let completion = (display.length === key.length ? display : key).slice(input.rest.length)
    if (record.hostOnly && completion.endsWith('/')) completion = completion.slice(0, -1)
    return { completion }
  }
  return null
}

/** Chrome's CompareHistoryMatch: typed beats untyped, then more typings,
 *  a bare host beats a page when both were typed once, then more visits,
 *  then the more recent visit. Negative when `a` ranks first. */
export function compareForInline(a: IndexedRecord, b: IndexedRecord): number {
  if ((a.typedCount > 0) !== (b.typedCount > 0)) return a.typedCount > 0 ? -1 : 1
  if (a.typedCount !== b.typedCount) return b.typedCount - a.typedCount
  if (a.typedCount === 1 && a.hostOnly !== b.hostOnly) return a.hostOnly ? -1 : 1
  if (a.visitCount !== b.visitCount) return b.visitCount - a.visitCount
  if (a.lastVisit !== b.lastVisit) return b.lastVisit - a.lastVisit
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0
}

function candidateFrom(record: IndexedRecord, input: ParsedInput, match: PrefixMatch): InlineCandidate {
  return {
    url: record.url,
    title: record.title,
    favicon: record.favicon,
    fill: input.text + match.completion,
    completion: match.completion,
    exact: match.completion === '',
  }
}

/**
 * The address bar's default history match (HistoryURLProvider):
 *  - the input spelling out a known URL makes that URL the default, typed or
 *    not ("what you typed", with the page's title);
 *  - otherwise the best-ranked significant URL the input is a prefix of, if
 *    it may complete inline (see canInline);
 *  - while the input is still inside the host, the host root is preferred
 *    over the deep page it was reached through, when the root has been
 *    visited at least a third as often (and typed, if the page was). With no
 *    such root, a bare-host suggestion is offered for the dropdown instead.
 */
export function findInline(
  records: Iterable<IndexedRecord>,
  byUrl: Map<string, IndexedRecord>,
  input: ParsedInput,
  now: number,
  opts: { allowInline: boolean; isSearchUrl: (url: string) => boolean },
): { inline: InlineCandidate | null; shorter: ShorterSuggestion | null } {
  const none = { inline: null, shorter: null }
  if (!input.rest || /\s/.test(input.text)) return none

  let exact: { record: IndexedRecord; match: PrefixMatch } | null = null
  const candidates: Array<{ record: IndexedRecord; match: PrefixMatch }> = []
  for (const record of records) {
    const match = prefixMatch(record, input)
    if (!match) continue
    if (match.completion === '') {
      if (!exact || compareForInline(record, exact.record) < 0) exact = { record, match }
      continue
    }
    if (!isSignificant(record, now) || opts.isSearchUrl(record.url)) continue
    candidates.push({ record, match })
  }
  if (exact) return { inline: candidateFrom(exact.record, input, exact.match), shorter: null }
  if (!opts.allowInline || candidates.length === 0) return none

  candidates.sort((a, b) => compareForInline(a.record, b.record))
  const best = candidates[0]
  let top = best
  // Chrome's "promoted" flag: a root taking a typed page's place may inline
  // on the page's merits.
  let promoted = false
  let shorter: ShorterSuggestion | null = null

  // Chrome's PromoteOrCreateShorterSuggestion, with the host root as the
  // only shorter URL considered.
  if (input.withinHost && !best.record.hostOnly) {
    const root = byUrl.get(best.record.root)
    const rootMatch = root ? prefixMatch(root, input) : null
    if (root && rootMatch && rootMatch.completion !== '') {
      const minVisits = Math.floor((best.record.visitCount - 1) / 3) + 1
      const minTyped = best.record.typedCount > 0 ? 1 : 0
      if (root.visitCount >= minVisits && root.typedCount >= minTyped) {
        top = { record: root, match: rootMatch }
        promoted = canInline(best.record)
      } else if (best.record.typedCount <= 1) {
        // A weaker root still takes the top from a page typed at most once;
        // it then completes inline only on its own merits.
        top = { record: root, match: rootMatch }
      }
    } else if (!root) {
      const synthetic = indexRecord({
        url: best.record.root, title: '', favicon: '', visitCount: 0, typedCount: 0, lastVisit: 0,
      })
      if (synthetic && prefixMatch(synthetic, input)) {
        shorter = { url: synthetic.url, display: displayUrl(synthetic) }
        // A made-up root takes the top spot from a page typed at most once,
        // and a made-up root never completes inline.
        if (best.record.typedCount <= 1) return { inline: null, shorter }
      }
    }
  }

  if (!promoted && !canInline(top.record)) return { inline: null, shorter }
  return { inline: candidateFrom(top.record, input, top.match), shorter }
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  return !/[\p{L}\p{N}]/u.test(text[index - 1])
}

/** How well one word of the input matches a text: 3 at the very start,
 *  2 at a word start, 1 inside a word (words of 3+ characters only). */
function termHit(text: string, term: string): number {
  let best = 0
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    if (at === 0) return 3
    if (isWordStart(text, at)) best = 2
    else if (best === 0 && term.length >= 3) best = 1
  }
  return best
}

/** Chrome's recency buckets for frecency: full weight within 4 days, then
 *  70% at two weeks, 50% at a month, 30% at 90 days (interpolated). */
export function recencyWeight(lastVisit: number, now: number): number {
  const days = Math.max(0, (now - lastVisit) / DAY_MS)
  const points: Array<[number, number]> = [[4, 1], [14, 0.7], [31, 0.5], [90, 0.3]]
  if (days <= points[0][0]) return 1
  for (let i = 1; i < points.length; i++) {
    const [d1, w1] = points[i]
    const [d0, w0] = points[i - 1]
    if (days <= d1) return w0 + ((days - d0) / (d1 - d0)) * (w1 - w0)
  }
  return 0.1
}

/**
 * Dropdown relevance of one URL (HistoryQuickProvider): every word typed
 * must match the URL or the title — at the start of the host counts most,
 * then word starts (URL above title), then mid-word — and the average match
 * quality is weighted by frecency, typed visits counting triple. 0 = no match.
 */
export function scoreForDropdown(record: IndexedRecord, input: ParsedInput, now: number): number {
  if (input.terms.length === 0) return 0
  let topicality = 0
  for (const term of input.terms) {
    const urlHit = termHit(record.afterWww, term)
    const hostStart = urlHit === 3 ? 10 : urlHit === 2 ? 6 : urlHit === 1 ? 2 : 0
    const titleHit = termHit(record.titleLower, term)
    const inTitle = titleHit >= 2 ? 5 : titleHit === 1 ? 2 : 0
    const best = Math.max(hostStart, inTitle)
    if (best === 0) return 0
    topicality += best
  }
  topicality /= input.terms.length
  const frequency = 1 + Math.log2(1 + record.visitCount + 2 * record.typedCount)
  return topicality * frequency * recencyWeight(record.lastVisit, now)
}

export interface SearchTermRecord {
  /** Lowercased, whitespace-collapsed — the key. */
  term: string
  /** As the user last typed it. */
  display: string
  count: number
  lastUsed: number
}

export function normalizeSearchTerm(term: string): string {
  return term.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** A past search the input is the beginning of (Chrome's search history
 *  suggestions), by frecency. 0 = no match, or the input is the whole query. */
export function scoreSearchTerm(record: SearchTermRecord, input: ParsedInput, now: number): number {
  const typed = normalizeSearchTerm(input.text)
  if (!typed || record.term === typed || !record.term.startsWith(typed)) return 0
  return (1 + Math.log2(1 + record.count)) * recencyWeight(record.lastUsed, now)
}

/**
 * Recognises results pages of the default search engine from its URL
 * template (".../search?q=%s"), so they're offered as past searches rather
 * than as URLs, the way Chrome keeps keyword search terms.
 */
export function makeSearchUrlMatcher(template: string): {
  isSearchUrl: (url: string) => boolean
  termOf: (url: string) => string | null
} {
  let base: { host: string; path: string; param: string } | null = null
  try {
    const marker = 'newbroquerymarker'
    const u = new URL(template.replace('%s', marker))
    for (const [key, value] of u.searchParams) {
      if (value === marker) {
        base = { host: u.host.replace(/^www\./i, '').toLowerCase(), path: u.pathname, param: key }
        break
      }
    }
  } catch {
    base = null
  }
  const termOf = (url: string): string | null => {
    if (!base) return null
    try {
      const u = new URL(url)
      if (u.host.replace(/^www\./i, '').toLowerCase() !== base.host || u.pathname !== base.path) return null
      const q = u.searchParams.get(base.param)
      return q && q.trim() ? q.trim() : null
    } catch {
      return null
    }
  }
  return { termOf, isSearchUrl: (url) => termOf(url) !== null }
}
