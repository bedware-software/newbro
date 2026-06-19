// URL visit history for address-bar autocomplete.
//
// Stores up to HISTORY_LIMIT most-recently-visited http(s) URLs, persisted
// to its own electron-store so the autocomplete cache survives restarts.
// addVisit deduplicates (a re-visit moves the entry to the head, not a
// duplicate), and we cap by trimming the oldest entries.
//
// Lookup is intentionally synchronous from the renderer's perspective:
// every window keeps a local mirror via the broadcast on `history:updated`
// (see preload's onHistoryUpdated). That way the address bar doesn't pay
// an IPC round-trip on every keystroke.

import { ipcMain, BrowserWindow } from 'electron'
import Store from 'electron-store'
import { log } from './log'
import { notifyCloudChange } from './cloud-sync'

export interface HistoryEntry {
  /** Canonical URL with protocol (what tab navigation actually loaded). */
  url: string
  /** Optional page title — captured on page-title-updated. */
  title?: string
  /** Last visit timestamp (ms). MRU order keyed off this. */
  visitedAt: number
  /** Visit counter — currently unused for ranking, kept for future tuning. */
  visits: number
}

const HISTORY_LIMIT = 200

const store = new Store({
  name: 'newbro-history',
  defaults: { entries: [] as HistoryEntry[] },
})

let cached: HistoryEntry[] | null = null

function load(): HistoryEntry[] {
  if (cached) return cached
  const raw = store.get('entries') as HistoryEntry[] | undefined
  cached = Array.isArray(raw) ? raw : []
  return cached
}

function persist(entries: HistoryEntry[]): void {
  cached = entries
  store.set('entries', entries)
  notifyCloudChange('history')
}

let broadcastPending: ReturnType<typeof setTimeout> | null = null
function scheduleBroadcast(): void {
  if (broadcastPending) return
  broadcastPending = setTimeout(() => {
    broadcastPending = null
    const snapshot = load()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try { win.webContents.send('history:updated', snapshot) }
      catch (err) { log.warn('history: broadcast failed', String(err)) }
    }
  }, 50)
}

// URLs the address bar should never offer as a suggestion — skip storing
// them in the first place so the LRU stays full of useful entries.
function shouldTrack(url: string): boolean {
  if (!url) return false
  // Only real navigations to web pages. Internal schemes (chrome://,
  // about:, file://, data:, etc.) shouldn't pollute autocomplete.
  return /^https?:\/\//i.test(url)
}

/** Record a visit. Moves an existing entry to the head, otherwise inserts
 *  a new one. Caps the list at HISTORY_LIMIT by dropping the oldest. */
export function addVisit(url: string, title?: string): void {
  if (!shouldTrack(url)) return
  const entries = load()
  const now = Date.now()
  const idx = entries.findIndex((e) => e.url === url)
  if (idx !== -1) {
    const [existing] = entries.splice(idx, 1)
    existing.visitedAt = now
    existing.visits += 1
    if (title && !existing.title) existing.title = title
    entries.unshift(existing)
  } else {
    entries.unshift({ url, title, visitedAt: now, visits: 1 })
    if (entries.length > HISTORY_LIMIT) entries.length = HISTORY_LIMIT
  }
  persist(entries)
  scheduleBroadcast()
}

/** Best-effort title backfill — only writes if the URL is in history and the
 *  new title differs from what's stored. Avoids broadcast churn on identical
 *  updates (page-title-updated fires multiple times per nav). */
export function updateTitle(url: string, title: string): void {
  if (!shouldTrack(url) || !title) return
  const entries = load()
  const entry = entries.find((e) => e.url === url)
  if (!entry || entry.title === title) return
  entry.title = title
  persist(entries)
  scheduleBroadcast()
}

export function listEntries(): HistoryEntry[] {
  return load()
}

// ── Cloud sync adapters ──
export function exportEntries(): HistoryEntry[] {
  return load()
}

/** Replace the whole history list with an incoming (synced) snapshot, capping
 *  to the LRU limit, and refresh every window's autocomplete mirror. */
export function replaceEntries(entries: unknown): void {
  const list = Array.isArray(entries) ? (entries as HistoryEntry[]) : []
  if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT
  persist(list)
  scheduleBroadcast()
}

export function clearHistory(): void {
  persist([])
  scheduleBroadcast()
}

export function registerHistoryIpc(): void {
  ipcMain.handle('history:list', () => listEntries())
  ipcMain.handle('history:clear', () => { clearHistory(); return true })
}
