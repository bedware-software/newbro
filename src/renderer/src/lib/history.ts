// Renderer-side mirror of the main-process URL history (src/main/history.ts).
//
// We keep a local copy here so the address bar can compute autocomplete
// suggestions synchronously on every keystroke — round-tripping to main per
// keypress would be sluggish, especially as the user types fast. Main
// broadcasts the full list on every change (debounced 50ms) via
// onHistoryUpdated, and we replace the cache wholesale on each push. Initial
// hydration happens once at boot via historyList().
//
// Suggestion shape mirrors what browsers do: the user types a prefix of a
// URL's "display form" (no protocol, optional www stripped) and we surface
// the best match. We prefer host roots over deep URLs so "go" → "google.com"
// rather than the last deep-link they happened to visit.

export interface HistoryEntry {
  url: string
  title?: string
  visitedAt: number
  visits: number
}

let entries: HistoryEntry[] = []
const listeners = new Set<() => void>()

export function setHistory(next: HistoryEntry[]): void {
  entries = Array.isArray(next) ? next : []
  for (const l of listeners) {
    try { l() }
    catch (err) { console.warn('history listener threw', err) }
  }
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Strip protocol + leading "www." so we can match against the user's
 *  natural input form ("google.com" → "google.com", not "https://www.google.com"). */
function toDisplayForm(url: string): string {
  let s = url
  const protoMatch = s.match(/^[a-z][a-z0-9+\-.]*:\/\//i)
  if (protoMatch) s = s.slice(protoMatch[0].length)
  if (s.toLowerCase().startsWith('www.')) s = s.slice(4)
  return s
}

/** Whether `prefix` (case-insensitive) is the start of `candidate`.
 *  Returns the remaining suffix (the autocomplete tail) if so. */
function matchPrefix(candidate: string, prefix: string): string | null {
  if (!prefix) return null
  if (candidate.length <= prefix.length) return null
  if (candidate.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
    return candidate.slice(prefix.length)
  }
  return null
}

/** Build the URL we'd navigate to if the user accepts this suggestion.
 *  Matches normalizeURL's contract: hosts get a synthesized https:// scheme,
 *  full URLs are passed through. */
function navigationTarget(display: string, original: string): string {
  // If the original URL's display form equals what we're showing, return the
  // original — preserves path/query/fragment exactly. Otherwise return the
  // display form (a bare host; normalizeURL adds the protocol on Enter).
  if (toDisplayForm(original) === display) return original
  return display
}

export interface Suggestion {
  /** What the user sees in the address bar after autocomplete (no protocol). */
  display: string
  /** Just the part the user *didn't* type — used to drive the selection range. */
  suffix: string
  /** The canonical URL to navigate to on accept (with protocol). */
  url: string
}

/** Find the best autocomplete suggestion for what the user has typed so far.
 *
 *  Ranking:
 *    1. Host-only matches first (a typed prefix that completes to just the
 *       host, with no path), sorted by most-recently visited. Browsers
 *       behave this way — typing "go" should land on "google.com" before
 *       any deep link.
 *    2. Then full-URL matches (display form), most-recently-visited first.
 *
 *  Returns null if nothing matches or if the prefix already equals the
 *  candidate (no suffix to surface). */
export function suggestFor(typed: string): Suggestion | null {
  const t = typed.trim()
  if (!t) return null
  // Need at least 2 chars to suggest, otherwise we'd autocomplete on every
  // first keystroke and feel jumpy. Browsers behave the same way.
  if (t.length < 2) return null

  const all = entries
  // Pre-sort by visitedAt desc once; entries from main is already MRU so this
  // is essentially a no-op, but cheap and defensive.
  const sorted = all.slice().sort((a, b) => b.visitedAt - a.visitedAt)

  // Pass 1: host-root suggestions. We synthesize a "hostOnly" candidate
  // (display form truncated at the first slash) and match against it. The
  // suggestion's navigation target then drops to just the host so the user
  // lands on "google.com" — not "google.com/some/deep/path".
  const seenHosts = new Set<string>()
  for (const e of sorted) {
    const display = toDisplayForm(e.url)
    const slash = display.indexOf('/')
    const host = slash === -1 ? display : display.slice(0, slash)
    if (seenHosts.has(host)) continue
    seenHosts.add(host)
    const suffix = matchPrefix(host, t)
    if (suffix !== null) {
      return {
        display: host,
        suffix,
        // Navigate to the bare host — Enter will run it through normalizeURL
        // which prepends https://.
        url: host,
      }
    }
  }

  // Pass 2: full-display matches.
  for (const e of sorted) {
    const display = toDisplayForm(e.url)
    const suffix = matchPrefix(display, t)
    if (suffix !== null) {
      return {
        display,
        suffix,
        url: navigationTarget(display, e.url),
      }
    }
  }

  return null
}
