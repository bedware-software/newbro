let searchEngineUrl = 'https://www.google.com/search?q=%s'

export function setSearchEngine(url: string): void {
  searchEngineUrl = url || 'https://www.google.com/search?q=%s'
}

/** Results page URL for a query on the default search engine. */
export function searchUrlFor(query: string): string {
  return searchEngineUrl.replace('%s', encodeURIComponent(query.trim()))
}

const ENGINE_NAMES: Array<[RegExp, string]> = [
  [/^https?:\/\/([a-z0-9-]+\.)*google\./i, 'Google'],
  [/^https?:\/\/([a-z0-9-]+\.)*(yandex|ya)\./i, 'Yandex'],
  [/^https?:\/\/([a-z0-9-]+\.)*duckduckgo\./i, 'DuckDuckGo'],
  [/^https?:\/\/([a-z0-9-]+\.)*bing\./i, 'Bing'],
  [/^https?:\/\/unduck\.link/i, 'Unduck'],
]

/** "Google", "Yandex", … — or the engine's host for a custom one. For the
 *  address bar's "Search Google" rows. */
export function searchEngineName(): string {
  const known = ENGINE_NAMES.find(([re]) => re.test(searchEngineUrl))
  if (known) return known[1]
  try { return new URL(searchEngineUrl.replace('%s', '')).host.replace(/^www\./, '') } catch { return 'the web' }
}

/** file:// URL for a local Windows path — a drive path (`C:\dir\page.html`,
 *  `C:/dir/page.html`) or a UNC share (`\\server\share\page.html`). Segments
 *  are percent-encoded so spaces and `#`/`%`/`?` in file names survive, while
 *  the separators and the drive letter stay literal. Returns null for anything
 *  that isn't unmistakably a path: a bare POSIX-looking string (`/r/rust`) is
 *  ambiguous in an address bar, so it keeps going to the search engine. */
export function windowsPathToFileURL(raw: string): string | null {
  if (/^[a-zA-Z]:[\\/]/.test(raw)) {
    const [drive, ...segments] = raw.replace(/\\/g, '/').split('/')
    return 'file:///' + drive + '/' + segments.map(encodeURIComponent).join('/')
  }
  if (/^\\\\[^\\/]/.test(raw)) {
    const [host, ...segments] = raw.slice(2).replace(/\\/g, '/').split('/')
    return 'file://' + host + '/' + segments.map(encodeURIComponent).join('/')
  }
  return null
}

// Local places, not queries — localhost and IP addresses, with an optional
// port and path. Chrome opens these over http:// (no certificate to be had).
const LOCAL_HOST = /^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\])(:\d{1,5})?([/?#].*)?$/i

export function normalizeURL(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return trimmed

  // A pasted local path is never a search query. Checked before the dot/space
  // heuristics below, which would otherwise send `C:\Users\me\My Files\a.html`
  // to the search engine because of the space in the folder name.
  const fileURL = windowsPathToFileURL(trimmed)
  if (fileURL) return fileURL

  if (!trimmed.includes(' ') && LOCAL_HOST.test(trimmed)) return 'http://' + trimmed

  if (!trimmed.includes(' ') && trimmed.includes('.')) {
    return 'https://' + trimmed
  }

  return searchUrlFor(trimmed)
}

/** Whether normalizeURL would search for this input rather than open it. */
export function looksLikeSearch(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return false
  if (windowsPathToFileURL(trimmed)) return false
  if (!trimmed.includes(' ') && (LOCAL_HOST.test(trimmed) || trimmed.includes('.'))) return false
  return true
}
