// Search suggestions for the address bar — what Chrome and Edge fetch from
// the default search engine as you type ("Autocomplete searches and URLs").
// Known engines only: each answers with the OpenSearch suggestions format,
// ["query", ["suggestion", …]]. Requests go through the profile's own
// session, so its proxy / VPN settings apply, and never carry anything but
// the typed text. Off with Settings → General → "Show search suggestions".

import { ipcMain, session } from 'electron'
import { log } from './log'
import { loadSettings } from './settings-store'

const TIMEOUT_MS = 1500
const MAX_SUGGESTIONS = 8
const MAX_QUERY_LENGTH = 200
const CACHE_TTL_MS = 2 * 60 * 1000
const CACHE_SIZE = 100

interface Endpoint {
  engine: RegExp
  url: (query: string) => string
}

const ENDPOINTS: Endpoint[] = [
  {
    engine: /^https?:\/\/([a-z0-9-]+\.)*google\.[a-z.]+\//i,
    url: (q) => `https://www.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=${encodeURIComponent(q)}`,
  },
  {
    engine: /^https?:\/\/([a-z0-9-]+\.)*(yandex|ya)\.[a-z.]+\//i,
    url: (q) => `https://suggest.yandex.ru/suggest-ff.cgi?part=${encodeURIComponent(q)}`,
  },
  {
    engine: /^https?:\/\/([a-z0-9-]+\.)*duckduckgo\.com\//i,
    url: (q) => `https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(q)}`,
  },
  {
    engine: /^https?:\/\/([a-z0-9-]+\.)*bing\.com\//i,
    url: (q) => `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`,
  },
  {
    // unduck.link routes plain searches to Google.
    engine: /^https?:\/\/unduck\.link\b/i,
    url: (q) => `https://www.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=${encodeURIComponent(q)}`,
  },
]

const cache = new Map<string, { at: number; items: string[] }>()

function endpointFor(template: string): Endpoint | null {
  return ENDPOINTS.find((e) => e.engine.test(template)) ?? null
}

function isProfilePartition(p: unknown): p is string {
  return typeof p === 'string' && /^persist:profile-[A-Za-z0-9-]+$/.test(p)
}

export async function fetchSearchSuggestions(query: string, partition?: string): Promise<string[]> {
  const settings = loadSettings()
  if (settings.searchSuggestions === false) return []
  const q = query.trim().slice(0, MAX_QUERY_LENGTH)
  if (!q) return []
  const endpoint = endpointFor(settings.searchEngine || '')
  if (!endpoint) return []
  const url = endpoint.url(q)

  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items

  const ses = isProfilePartition(partition) ? session.fromPartition(partition) : session.defaultSession
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await ses.fetch(url, { signal: controller.signal, credentials: 'omit' })
    if (!res.ok) return []
    const data = (await res.json()) as unknown
    const list = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : []
    const items = list
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim())
      .slice(0, MAX_SUGGESTIONS)
    cache.set(url, { at: Date.now(), items })
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string)
    return items
  } catch (err) {
    if (!controller.signal.aborted) log.warn('omnibox: search suggestions failed', String(err))
    return []
  } finally {
    clearTimeout(timer)
  }
}

export function registerOmniboxSuggestIpc(): void {
  ipcMain.handle('omnibox:suggest', (_e, query: string, partition?: string) =>
    fetchSearchSuggestions(typeof query === 'string' ? query : '', partition))
}
