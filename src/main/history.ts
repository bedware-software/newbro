// URL history for the address bar, modelled on Chromium's History database.
//
// Every main-frame visit to an http(s) page is kept for 90 days (Chrome's
// retention) — there's no count cap. Per URL: title, favicon, visit count,
// typed count (visits the user started from the address bar) and the last
// visit. Searches on the default engine are kept as search terms, like
// Chrome's keyword search terms. What suggests what, and in which order, is
// in history-match.ts.
//
// Storage is SQLite through node:sqlite (the Edge password import uses it
// too), one small write per visit. Queries run against an in-memory copy
// loaded at startup, so a keystroke never touches the disk. The old
// electron-store list (the last 200 URLs) is imported once.

import { app, ipcMain } from 'electron'
import Store from 'electron-store'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import * as fs from 'fs'
import * as path from 'path'
import { log } from './log'
import { notifyCloudChange } from './cloud-sync'
import { loadSettings } from './settings-store'
import {
  DAY_MS,
  dedupeKey,
  displayUrl,
  findInline,
  indexRecord,
  isSignificant,
  makeSearchUrlMatcher,
  normalizeSearchTerm,
  parseInput,
  scoreForDropdown,
  scoreSearchTerm,
  type HistoryRecord,
  type IndexedRecord,
  type InlineCandidate,
  type SearchTermRecord,
} from './history-match'

/** Legacy shape — still what Cloud Sync carries, so devices on older builds
 *  keep understanding each other. `typed` is new and optional. */
export interface HistoryEntry {
  url: string
  title?: string
  visitedAt: number
  visits: number
  typed?: number
}

export interface HistorySuggestion {
  url: string
  title: string
  favicon: string
  /** Chrome-style display: no scheme, no "www.". */
  display: string
  typed: boolean
}

export interface HistoryQueryResult {
  /** The default match: the input spelling out a known URL (`exact`), or a
   *  URL to complete inline. Null → the address bar's own "what you typed". */
  inline: (InlineCandidate & { display: string }) | null
  /** Dropdown candidates, best first, one per URL variant. */
  matches: HistorySuggestion[]
  /** Past searches starting with the input. */
  searchTerms: Array<{ term: string; display: string }>
}

const RETENTION_MS = 90 * DAY_MS
const EXPIRE_EVERY_MS = 6 * 60 * 60 * 1000
const MAX_URL_LENGTH = 8192
const MAX_TITLE_LENGTH = 1024
const MAX_FAVICON_LENGTH = 4096
const MAX_SEARCH_TERM_LENGTH = 512
const MAX_DROPDOWN_MATCHES = 12
const MAX_SEARCH_TERM_MATCHES = 4
// Cloud Sync carries what matters for autocomplete elsewhere — every typed
// URL (Chrome syncs typed URLs the same way) plus the most recent others —
// not the whole 90 days, and at most one push per half minute.
const SYNC_RECENT_UNTYPED = 500
const SYNC_NOTIFY_THROTTLE_MS = 30_000
// How long an address-bar navigation may take to commit and still count as
// typed.
const TYPED_NAVIGATION_TTL_MS = 60_000

const records = new Map<string, IndexedRecord>()
const searchTerms = new Map<string, SearchTermRecord>()
/** URLs removed from suggestions on this device (Shift+Delete), so a synced
 *  copy from another device can't bring them back unless visited again. */
const removedUrls = new Map<string, number>()

interface Statements {
  upsertVisit: StatementSync
  setTitle: StatementSync
  setFavicon: StatementSync
  mergeUrl: StatementSync
  deleteUrl: StatementSync
  upsertTerm: StatementSync
  deleteTerm: StatementSync
  upsertRemoved: StatementSync
  deleteRemoved: StatementSync
}

let db: DatabaseSync | null = null
let stmts: Statements | null = null
let initialized = false

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS urls (
    url TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    favicon TEXT NOT NULL DEFAULT '',
    visit_count INTEGER NOT NULL DEFAULT 0,
    typed_count INTEGER NOT NULL DEFAULT 0,
    last_visit INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS search_terms (
    term TEXT PRIMARY KEY,
    display TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS removed_urls (
    url TEXT PRIMARY KEY,
    removed_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
`

function dbFile(): string {
  return path.join(app.getPath('userData'), 'newbro-history.db')
}

function openDatabase(): DatabaseSync | null {
  const file = dbFile()
  const open = (): DatabaseSync => {
    const handle = new DatabaseSync(file)
    handle.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    handle.exec(SCHEMA)
    return handle
  }
  try {
    return open()
  } catch (err) {
    // A damaged file shouldn't cost the address bar its history for good:
    // set it aside and start a fresh one.
    log.warn('history: database unusable, starting a new one', String(err))
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* nothing to move */ }
    try {
      return open()
    } catch (err2) {
      log.error('history: cannot open database — history stays in memory this session', String(err2))
      return null
    }
  }
}

function prepare(handle: DatabaseSync): Statements {
  return {
    upsertVisit: handle.prepare(`
      INSERT INTO urls (url, title, visit_count, typed_count, last_visit) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        visit_count = visit_count + 1,
        typed_count = typed_count + excluded.typed_count,
        last_visit = excluded.last_visit,
        title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE urls.title END`),
    setTitle: handle.prepare('UPDATE urls SET title = ? WHERE url = ?'),
    setFavicon: handle.prepare('UPDATE urls SET favicon = ? WHERE url = ?'),
    mergeUrl: handle.prepare(`
      INSERT INTO urls (url, title, favicon, visit_count, typed_count, last_visit) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        title = excluded.title, favicon = excluded.favicon, visit_count = excluded.visit_count,
        typed_count = excluded.typed_count, last_visit = excluded.last_visit`),
    deleteUrl: handle.prepare('DELETE FROM urls WHERE url = ?'),
    upsertTerm: handle.prepare(`
      INSERT INTO search_terms (term, display, count, last_used) VALUES (?, ?, ?, ?)
      ON CONFLICT(term) DO UPDATE SET display = excluded.display, count = excluded.count, last_used = excluded.last_used`),
    deleteTerm: handle.prepare('DELETE FROM search_terms WHERE term = ?'),
    upsertRemoved: handle.prepare(`
      INSERT INTO removed_urls (url, removed_at) VALUES (?, ?)
      ON CONFLICT(url) DO UPDATE SET removed_at = excluded.removed_at`),
    deleteRemoved: handle.prepare('DELETE FROM removed_urls WHERE url = ?'),
  }
}

/** Run a write, logging instead of throwing — a failed write costs one
 *  history row, never the navigation that triggered it. */
function write(label: string, fn: (s: Statements) => void): void {
  if (!stmts) return
  try { fn(stmts) } catch (err) { log.warn(`history: ${label} failed`, String(err)) }
}

function transaction(label: string, fn: (s: Statements) => void): void {
  if (!db || !stmts) return
  try {
    db.exec('BEGIN')
    fn(stmts)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* not in a transaction */ }
    log.warn(`history: ${label} failed`, String(err))
  }
}

function setRecord(record: HistoryRecord): IndexedRecord | null {
  const indexed = indexRecord(record)
  if (indexed) records.set(record.url, indexed)
  return indexed
}

function loadAll(handle: DatabaseSync): void {
  const urlRows = handle.prepare('SELECT url, title, favicon, visit_count, typed_count, last_visit FROM urls').all() as Array<{
    url: string; title: string; favicon: string; visit_count: number; typed_count: number; last_visit: number
  }>
  for (const r of urlRows) {
    setRecord({
      url: r.url, title: r.title, favicon: r.favicon,
      visitCount: r.visit_count, typedCount: r.typed_count, lastVisit: r.last_visit,
    })
  }
  const termRows = handle.prepare('SELECT term, display, count, last_used FROM search_terms').all() as Array<{
    term: string; display: string; count: number; last_used: number
  }>
  for (const t of termRows) searchTerms.set(t.term, { term: t.term, display: t.display, count: t.count, lastUsed: t.last_used })
  const removedRows = handle.prepare('SELECT url, removed_at FROM removed_urls').all() as Array<{ url: string; removed_at: number }>
  for (const r of removedRows) removedUrls.set(r.url, r.removed_at)
}

/** One-time import of the pre-SQLite list (electron-store, last 200 URLs).
 *  That list completed any visited host, so every host in it gets a typed
 *  host root: what completed before keeps completing. The pages themselves
 *  come over as plain visits, and search results pages as past searches. */
function importLegacyOnce(handle: DatabaseSync): void {
  const done = handle.prepare("SELECT value FROM meta WHERE key = 'legacyImported'").get() as { value: string } | undefined
  if (done) return
  let legacy: HistoryEntry[] = []
  try {
    const store = new Store<{ entries: HistoryEntry[] }>({ name: 'newbro-history', defaults: { entries: [] } })
    const raw = store.get('entries')
    legacy = Array.isArray(raw) ? raw : []
  } catch (err) {
    log.warn('history: legacy list unreadable', String(err))
  }
  const now = Date.now()
  const roots = new Map<string, number>()
  transaction('legacy import', (s) => {
    for (const e of legacy) {
      if (!e || typeof e.url !== 'string' || !shouldTrack(e.url)) continue
      const lastVisit = Number.isFinite(e.visitedAt) ? e.visitedAt : now
      const existing = records.get(e.url)
      const merged: HistoryRecord = {
        url: e.url,
        title: existing?.title || (typeof e.title === 'string' ? e.title.slice(0, MAX_TITLE_LENGTH) : ''),
        favicon: existing?.favicon ?? '',
        visitCount: Math.max(existing?.visitCount ?? 0, Math.max(1, Math.floor(e.visits) || 1)),
        typedCount: existing?.typedCount ?? 0,
        lastVisit: Math.max(existing?.lastVisit ?? 0, lastVisit),
      }
      const indexed = setRecord(merged)
      if (!indexed) continue
      s.mergeUrl.run(merged.url, merged.title, merged.favicon, merged.visitCount, merged.typedCount, merged.lastVisit)
      roots.set(indexed.root, Math.max(roots.get(indexed.root) ?? 0, merged.lastVisit))
      const term = currentSearchMatcher().termOf(e.url)
      const key = term ? normalizeSearchTerm(term) : ''
      if (term && key) {
        const prev = searchTerms.get(key)
        const t: SearchTermRecord = {
          term: key,
          display: term.slice(0, MAX_SEARCH_TERM_LENGTH),
          count: (prev?.count ?? 0) + merged.visitCount,
          lastUsed: Math.max(prev?.lastUsed ?? 0, merged.lastVisit),
        }
        searchTerms.set(key, t)
        s.upsertTerm.run(t.term, t.display, t.count, t.lastUsed)
      }
    }
    for (const [root, lastVisit] of roots) {
      const existing = records.get(root)
      const merged: HistoryRecord = {
        url: root,
        title: existing?.title ?? '',
        favicon: existing?.favicon ?? '',
        visitCount: Math.max(1, existing?.visitCount ?? 0),
        typedCount: Math.max(1, existing?.typedCount ?? 0),
        lastVisit: Math.max(existing?.lastVisit ?? 0, lastVisit),
      }
      if (!setRecord(merged)) continue
      s.mergeUrl.run(merged.url, merged.title, merged.favicon, merged.visitCount, merged.typedCount, merged.lastVisit)
    }
    handle.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacyImported', '1')").run()
  })
  if (legacy.length > 0) log.info('history: imported legacy list', { urls: legacy.length, hosts: roots.size })
}

/** Drop everything older than the retention window (Chrome keeps 90 days). */
function expire(): void {
  const cutoff = Date.now() - RETENTION_MS
  for (const [url, r] of records) if (r.lastVisit < cutoff) records.delete(url)
  for (const [term, t] of searchTerms) if (t.lastUsed < cutoff) searchTerms.delete(term)
  for (const [url, at] of removedUrls) if (at < cutoff) removedUrls.delete(url)
  if (!db) return
  try {
    db.prepare('DELETE FROM urls WHERE last_visit < ?').run(cutoff)
    db.prepare('DELETE FROM search_terms WHERE last_used < ?').run(cutoff)
    db.prepare('DELETE FROM removed_urls WHERE removed_at < ?').run(cutoff)
  } catch (err) {
    log.warn('history: expiry failed', String(err))
  }
}

function init(): void {
  if (initialized) return
  initialized = true
  db = openDatabase()
  if (db) {
    stmts = prepare(db)
    try {
      loadAll(db)
      importLegacyOnce(db)
    } catch (err) {
      log.warn('history: load failed', String(err))
    }
  }
  expire()
  setInterval(expire, EXPIRE_EVERY_MS).unref?.()
  app.on('will-quit', () => {
    try { db?.close() } catch { /* already closed */ }
    db = null
    stmts = null
  })
  log.info('history: ready', { urls: records.size, searchTerms: searchTerms.size })
}

// ── Cloud Sync notification, throttled ──
let syncTimer: ReturnType<typeof setTimeout> | null = null
function scheduleCloudNotify(): void {
  if (syncTimer) return
  syncTimer = setTimeout(() => {
    syncTimer = null
    notifyCloudChange('history')
  }, SYNC_NOTIFY_THROTTLE_MS)
  syncTimer.unref?.()
}

// URLs the address bar should never offer — not stored in the first place.
function shouldTrack(url: string): boolean {
  return !!url && url.length <= MAX_URL_LENGTH && /^https?:\/\//i.test(url)
}

let searchMatcher: { template: string; matcher: ReturnType<typeof makeSearchUrlMatcher> } | null = null
function currentSearchMatcher(): ReturnType<typeof makeSearchUrlMatcher> {
  const template = loadSettings().searchEngine || 'https://www.google.com/search?q=%s'
  if (!searchMatcher || searchMatcher.template !== template) {
    searchMatcher = { template, matcher: makeSearchUrlMatcher(template) }
  }
  return searchMatcher.matcher
}

// Searches the address bar just recorded itself — the results page visit
// that follows must not count them a second time.
const recentlyRecordedTerms = new Map<string, number>()

/** Record one visit. `typed`: the user started it from the address bar. */
export function addVisit(url: string, opts: { typed?: boolean } = {}): void {
  if (!shouldTrack(url)) return
  init()
  const now = Date.now()
  const typed = opts.typed ? 1 : 0
  const existing = records.get(url)
  setRecord({
    url,
    title: existing?.title ?? '',
    favicon: existing?.favicon ?? '',
    visitCount: (existing?.visitCount ?? 0) + 1,
    typedCount: (existing?.typedCount ?? 0) + typed,
    lastVisit: now,
  })
  write('visit', (s) => {
    s.upsertVisit.run(url, '', typed, now)
    if (removedUrls.delete(url)) s.deleteRemoved.run(url)
  })
  // A results page of the default engine is also a search to remember.
  const term = currentSearchMatcher().termOf(url)
  if (term) {
    const key = normalizeSearchTerm(term)
    const recordedAt = recentlyRecordedTerms.get(key)
    if (recordedAt === undefined || now - recordedAt > TYPED_NAVIGATION_TTL_MS) addSearchTerm(term)
    recentlyRecordedTerms.delete(key)
  }
  scheduleCloudNotify()
}

/** Best-effort title backfill; ignores URLs not in history and repeats. */
export function updateTitle(url: string, title: string): void {
  if (!shouldTrack(url) || !title) return
  init()
  const existing = records.get(url)
  const clipped = title.slice(0, MAX_TITLE_LENGTH)
  if (!existing || existing.title === clipped) return
  setRecord({ ...existing, title: clipped })
  write('title', (s) => { s.setTitle.run(clipped, url) })
}

/** Remember a page's favicon for its suggestion row. Big inline images are
 *  skipped — the row falls back to a generic icon. */
export function updateFavicon(url: string, favicon: string): void {
  if (!shouldTrack(url) || !favicon || favicon.length > MAX_FAVICON_LENGTH) return
  if (!/^(https?:|data:image\/)/i.test(favicon)) return
  init()
  const existing = records.get(url)
  if (!existing || existing.favicon === favicon) return
  setRecord({ ...existing, favicon })
  write('favicon', (s) => { s.setFavicon.run(favicon, url) })
}

/** Remember a search the user ran from the address bar. */
export function addSearchTerm(term: string): void {
  const display = term.trim().replace(/\s+/g, ' ').slice(0, MAX_SEARCH_TERM_LENGTH)
  const key = normalizeSearchTerm(display)
  if (!key) return
  init()
  const now = Date.now()
  const existing = searchTerms.get(key)
  const next: SearchTermRecord = { term: key, display, count: (existing?.count ?? 0) + 1, lastUsed: now }
  searchTerms.set(key, next)
  write('search term', (s) => { s.upsertTerm.run(next.term, next.display, next.count, next.lastUsed) })
}

/** Address-bar search, recorded before its results page loads. */
function addSearchTermFromAddressBar(term: string): void {
  addSearchTerm(term)
  const key = normalizeSearchTerm(term)
  if (!key) return
  const now = Date.now()
  for (const [k, at] of recentlyRecordedTerms) if (now - at > TYPED_NAVIGATION_TTL_MS) recentlyRecordedTerms.delete(k)
  recentlyRecordedTerms.set(key, now)
}

/** Shift+Delete on a suggestion: forget the URL. */
export function removeUrl(url: string): void {
  init()
  const now = Date.now()
  records.delete(url)
  removedUrls.set(url, now)
  transaction('remove url', (s) => {
    s.deleteUrl.run(url)
    s.upsertRemoved.run(url, now)
  })
  scheduleCloudNotify()
}

export function removeSearchTerm(term: string): void {
  init()
  const key = normalizeSearchTerm(term)
  searchTerms.delete(key)
  write('remove search term', (s) => { s.deleteTerm.run(key) })
}

export function clearHistory(): void {
  init()
  records.clear()
  searchTerms.clear()
  removedUrls.clear()
  if (db) {
    try { db.exec('DELETE FROM urls; DELETE FROM search_terms; DELETE FROM removed_urls;') }
    catch (err) { log.warn('history: clear failed', String(err)) }
  }
  scheduleCloudNotify()
}

/** Everything the address bar needs for one input. */
export function queryHistory(text: string, allowInline: boolean): HistoryQueryResult {
  init()
  const input = parseInput(text)
  const now = Date.now()
  const search = currentSearchMatcher()
  if (!input.text.trim()) return { inline: null, matches: [], searchTerms: [] }

  const { inline, shorter } = findInline(records.values(), records, input, now, {
    allowInline,
    isSearchUrl: search.isSearchUrl,
  })

  const scored: Array<{ record: IndexedRecord; score: number }> = []
  for (const record of records.values()) {
    if (!isSignificant(record, now) || search.isSearchUrl(record.url)) continue
    const score = scoreForDropdown(record, input, now)
    if (score > 0) scored.push({ record, score })
  }
  scored.sort((a, b) => b.score - a.score || b.record.lastVisit - a.record.lastVisit)

  const matches: HistorySuggestion[] = []
  const seen = new Set<string>()
  if (inline) seen.add(dedupeKey(inline.url))
  const push = (s: HistorySuggestion): void => {
    const key = dedupeKey(s.url)
    if (seen.has(key)) return
    seen.add(key)
    matches.push(s)
  }
  // Chrome lists the bare host it offered in place of a deep page up top.
  if (shorter) push({ url: shorter.url, title: '', favicon: '', display: shorter.display, typed: false })
  for (const { record } of scored) {
    if (matches.length >= MAX_DROPDOWN_MATCHES) break
    push({ url: record.url, title: record.title, favicon: record.favicon, display: displayUrl(record), typed: record.typedCount > 0 })
  }

  const terms = [...searchTerms.values()]
    .map((t) => ({ t, score: scoreSearchTerm(t, input, now) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SEARCH_TERM_MATCHES)
    .map(({ t }) => ({ term: t.term, display: t.display }))

  const inlineRecord = inline ? records.get(inline.url) : undefined
  return {
    inline: inline ? { ...inline, display: inlineRecord ? displayUrl(inlineRecord) : inline.fill } : null,
    matches,
    searchTerms: terms,
  }
}

// ── Typed navigations ──
// The address bar notes a tab's navigation as typed just before starting
// it; the tab's next main-frame commit consumes the note (see tab-views).
const pendingTyped = new Map<string, { url: string; at: number }>()

export function noteTypedNavigation(tabId: string, url: string): void {
  let canonical = url
  // Chromium commits "https://example.com" as "https://example.com/" — keep
  // the typed address in that same form.
  try { canonical = new URL(url).href } catch { /* not a URL — dropped below */ }
  if (!shouldTrack(canonical)) {
    pendingTyped.delete(tabId)
    return
  }
  pendingTyped.set(tabId, { url: canonical, at: Date.now() })
}

/** The typed note no longer applies: the load failed, or the tab went
 *  somewhere else first. With `url`, only a note for a different URL is
 *  dropped (our own navigation starting keeps it). */
export function dropTypedNavigation(tabId: string, url?: string): void {
  const pending = pendingTyped.get(tabId)
  if (!pending) return
  if (url !== undefined && sameUrl(pending.url, url)) return
  pendingTyped.delete(tabId)
}

function sameUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    ua.hash = ''
    ub.hash = ''
    return ua.href === ub.href
  } catch {
    return a === b
  }
}

/** A tab committed a main-frame navigation: record the visit, typed when
 *  the address bar started it. When the typed address redirected elsewhere
 *  (http → https, a short link…), the typed address is what gets the typed
 *  visit — it's what the user will type again — and the page it landed on
 *  a plain one, as Chrome records a redirect chain. */
export function recordTabNavigation(tabId: string, url: string): void {
  const pending = pendingTyped.get(tabId)
  pendingTyped.delete(tabId)
  const typed = !!pending && Date.now() - pending.at <= TYPED_NAVIGATION_TTL_MS
  if (typed && pending && !sameUrl(pending.url, url)) {
    addVisit(pending.url, { typed: true })
    addVisit(url)
    return
  }
  addVisit(url, { typed })
}

// ── Cloud sync adapters ──
export function exportEntries(): HistoryEntry[] {
  init()
  const all = [...records.values()].sort((a, b) => b.lastVisit - a.lastVisit || (a.url < b.url ? -1 : 1))
  const out: HistoryEntry[] = []
  let untyped = 0
  for (const r of all) {
    if (r.typedCount === 0) {
      if (untyped >= SYNC_RECENT_UNTYPED) continue
      untyped += 1
    }
    const entry: HistoryEntry = { url: r.url, visitedAt: r.lastVisit, visits: r.visitCount }
    if (r.title) entry.title = r.title
    if (r.typedCount > 0) entry.typed = r.typedCount
    out.push(entry)
  }
  return out
}

/** Merge another device's list into ours — the union, keeping the larger
 *  counts and the later visit — rather than replacing it, so neither side's
 *  history is lost. URLs removed here stay removed unless visited again
 *  after the removal. */
export function replaceEntries(entries: unknown): void {
  init()
  const list = Array.isArray(entries) ? (entries as Partial<HistoryEntry>[]) : []
  const cutoff = Date.now() - RETENTION_MS
  const changed: HistoryRecord[] = []
  for (const e of list) {
    if (!e || typeof e.url !== 'string' || !shouldTrack(e.url)) continue
    const visitedAt = Number(e.visitedAt)
    if (!Number.isFinite(visitedAt) || visitedAt < cutoff) continue
    const removedAt = removedUrls.get(e.url)
    if (removedAt !== undefined && removedAt >= visitedAt) continue
    const existing = records.get(e.url)
    const remoteTitle = typeof e.title === 'string' ? e.title.slice(0, MAX_TITLE_LENGTH) : ''
    const merged: HistoryRecord = {
      url: e.url,
      title: (visitedAt > (existing?.lastVisit ?? 0) && remoteTitle) ? remoteTitle : existing?.title || remoteTitle,
      favicon: existing?.favicon ?? '',
      visitCount: Math.max(existing?.visitCount ?? 0, Math.max(1, Math.floor(Number(e.visits)) || 1)),
      typedCount: Math.max(existing?.typedCount ?? 0, Math.max(0, Math.floor(Number(e.typed)) || 0)),
      lastVisit: Math.max(existing?.lastVisit ?? 0, visitedAt),
    }
    if (existing && existing.title === merged.title && existing.visitCount === merged.visitCount &&
        existing.typedCount === merged.typedCount && existing.lastVisit === merged.lastVisit) continue
    if (setRecord(merged)) changed.push(merged)
  }
  if (changed.length === 0) return
  transaction('sync merge', (s) => {
    for (const m of changed) s.mergeUrl.run(m.url, m.title, m.favicon, m.visitCount, m.typedCount, m.lastVisit)
  })
  log.info('history: merged synced entries', { changed: changed.length })
}

export function registerHistoryIpc(): void {
  init()
  ipcMain.handle('history:query', (_e, text: string, allowInline: boolean) =>
    queryHistory(typeof text === 'string' ? text : '', allowInline === true))
  ipcMain.handle('history:remove', (_e, url: string) => {
    if (typeof url === 'string') removeUrl(url)
  })
  ipcMain.handle('history:remove-search-term', (_e, term: string) => {
    if (typeof term === 'string') removeSearchTerm(term)
  })
  ipcMain.handle('history:add-search-term', (_e, term: string) => {
    if (typeof term === 'string') addSearchTermFromAddressBar(term)
  })
  ipcMain.on('history:note-typed', (_e, tabId: string, url: string) => {
    if (typeof tabId === 'string' && typeof url === 'string') noteTypedNavigation(tabId, url)
  })
  ipcMain.handle('history:clear', () => { clearHistory(); return true })
}
