let searchEngineUrl = 'https://www.google.com/search?q=%s'

export function setSearchEngine(url: string): void {
  searchEngineUrl = url || 'https://www.google.com/search?q=%s'
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

export function normalizeURL(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return trimmed

  // A pasted local path is never a search query. Checked before the dot/space
  // heuristics below, which would otherwise send `C:\Users\me\My Files\a.html`
  // to the search engine because of the space in the folder name.
  const fileURL = windowsPathToFileURL(trimmed)
  if (fileURL) return fileURL

  if (!trimmed.includes(' ') && trimmed.includes('.')) {
    return 'https://' + trimmed
  }

  return searchEngineUrl.replace('%s', encodeURIComponent(trimmed))
}
