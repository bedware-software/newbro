let searchEngineUrl = 'https://www.google.com/search?q=%s'

export function setSearchEngine(url: string): void {
  searchEngineUrl = url || 'https://www.google.com/search?q=%s'
}

export function normalizeURL(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return trimmed

  if (!trimmed.includes(' ') && trimmed.includes('.')) {
    return 'https://' + trimmed
  }

  return searchEngineUrl.replace('%s', encodeURIComponent(trimmed))
}
