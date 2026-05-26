// Download manager — per-session 'will-download' hook, persistent history,
// IPC for the renderer panel.
//
// Lifecycle of a download:
//  1. Tab triggers a download → Electron emits 'will-download' on its session.
//  2. attachDownloadHandler() captures the DownloadItem, assigns us a stable
//     id, and starts an entry in `entries` (the live in-memory record).
//  3. While the item is alive we listen for 'updated' (progress / pause /
//     resume) and 'done' (completed / cancelled / interrupted). Every state
//     change is broadcast to all renderers.
//  4. On 'done' we persist the entry so it survives app restarts. The
//     DownloadItem reference is dropped — pause/resume/cancel no longer
//     work, but show-in-folder and open-file still do via the saved path.
//
// History is capped (HISTORY_LIMIT) and stored in the same electron-store
// instance as the rest of the app — separate key so it doesn't entangle
// with the renderer-managed workspace state.

import { ipcMain, session as electronSession, BrowserWindow, shell, app } from 'electron'
import { randomUUID } from 'crypto'
import * as path from 'path'
import Store from 'electron-store'
import { log } from './log'
import { findTabByWebContents } from './tab-views'

export type DownloadState =
  | 'progressing'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'interrupted'

export interface DownloadEntry {
  id: string
  url: string
  filename: string
  savePath: string
  mimeType: string
  totalBytes: number
  receivedBytes: number
  state: DownloadState
  startedAt: number
  endedAt?: number
  /** Source page URL so users can locate the origin of a download. */
  originUrl?: string
  /** Bytes/sec, computed on the renderer side from receivedBytes deltas. */
  bytesPerSecond?: number
}

const HISTORY_LIMIT = 500
const BROADCAST_THROTTLE_MS = 150

interface LiveDownload {
  entry: DownloadEntry
  item: Electron.DownloadItem | null
  /** Tracks bytesPerSecond between updates. */
  lastSampleAt: number
  lastSampleBytes: number
}

const live = new Map<string, LiveDownload>()

const store = new Store({
  name: 'newbro-downloads',
  defaults: {
    history: [] as DownloadEntry[],
  },
})

function loadHistory(): DownloadEntry[] {
  const raw = store.get('history') as DownloadEntry[] | undefined
  return Array.isArray(raw) ? raw : []
}

function saveHistory(history: DownloadEntry[]): void {
  // Cap at HISTORY_LIMIT — drop oldest entries first.
  const trimmed = history.length > HISTORY_LIMIT
    ? history.slice(history.length - HISTORY_LIMIT)
    : history
  store.set('history', trimmed)
}

// Rebuild the renderer-visible list from history + in-flight downloads.
// In-flight entries take precedence over any persisted copy of the same id.
function buildSnapshot(): DownloadEntry[] {
  const liveIds = new Set(live.keys())
  const out: DownloadEntry[] = []
  for (const dl of live.values()) out.push({ ...dl.entry })
  for (const e of loadHistory()) {
    if (!liveIds.has(e.id)) out.push(e)
  }
  // Newest first.
  out.sort((a, b) => b.startedAt - a.startedAt)
  return out
}

let broadcastPending: ReturnType<typeof setTimeout> | null = null
function broadcast(): void {
  if (broadcastPending) return
  broadcastPending = setTimeout(() => {
    broadcastPending = null
    const snapshot = buildSnapshot()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try { win.webContents.send('downloads:updated', snapshot) }
      catch (err) { log.warn('downloads: broadcast failed', String(err)) }
    }
  }, BROADCAST_THROTTLE_MS)
}

function mapItemState(item: Electron.DownloadItem): DownloadState {
  const s = item.getState()
  if (s === 'completed') return 'completed'
  if (s === 'cancelled') return 'cancelled'
  if (s === 'interrupted') return 'interrupted'
  return item.isPaused() ? 'paused' : 'progressing'
}

/** Wire a session so user-initiated downloads get tracked + broadcast. */
export function attachDownloadHandler(ses: Electron.Session): void {
  // Sessions may be configured multiple times (re-entry through
  // configureSession during partition recreation); guard against
  // attaching the same listener twice.
  const flag = ses as unknown as { __newbroDownloadsAttached?: boolean }
  if (flag.__newbroDownloadsAttached) return
  flag.__newbroDownloadsAttached = true

  ses.on('will-download', (_e, item, webContents) => {
    const id = randomUUID()
    const startedAt = Date.now()
    const savePath = item.getSavePath() || path.join(app.getPath('downloads'), item.getFilename())
    // Pre-bind a save path so Electron doesn't show the OS save dialog —
    // matches Chrome's default behavior of downloading straight to the
    // user's downloads folder.
    if (!item.getSavePath()) item.setSavePath(savePath)

    const entry: DownloadEntry = {
      id,
      url: item.getURL(),
      filename: path.basename(savePath),
      savePath,
      mimeType: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: item.getReceivedBytes(),
      state: mapItemState(item),
      startedAt,
      originUrl: webContents?.getURL?.() || undefined,
    }
    const dl: LiveDownload = {
      entry,
      item,
      lastSampleAt: startedAt,
      lastSampleBytes: entry.receivedBytes,
    }
    live.set(id, dl)
    log.info('downloads: started', { id, url: entry.url, filename: entry.filename, savePath })
    broadcast()

    // If the download came from a tab that was just opened solely to
    // trigger it (target="_blank" → fresh tab → immediate
    // Content-Disposition: attachment), close that tab. The user clicked
    // a "download" link expecting a file, not an empty tab.
    //
    // Heuristic: the tab's webContents has no committed URL yet — getURL
    // is empty / about:blank / a chrome-error page. If the tab navigated
    // to a real HTML page first (e.g. "your download will begin in 5
    // seconds…" intermediary), getURL is that page and we leave it alone.
    if (webContents) {
      try {
        const url = webContents.getURL() || ''
        const isFresh = !url || url === 'about:blank' || url.startsWith('chrome-error://')
        if (isFresh) {
          const tab = findTabByWebContents(webContents)
          if (tab) {
            const win = BrowserWindow.fromId(tab.windowId)
            if (win && !win.isDestroyed()) {
              log.info('downloads: closing blank download tab', { tabId: tab.tabId, url })
              win.webContents.send('downloads:close-blank-tab', tab.tabId)
            }
          }
        }
      } catch (err) {
        log.warn('downloads: blank-tab close failed', String(err))
      }
    }

    item.on('updated', (_evt, _state) => {
      const e = dl.entry
      e.receivedBytes = item.getReceivedBytes()
      e.totalBytes = item.getTotalBytes()
      e.filename = path.basename(item.getSavePath() || e.savePath)
      e.savePath = item.getSavePath() || e.savePath
      e.state = mapItemState(item)
      // Compute throughput from the delta since last sample. Skip when
      // paused so the bps doesn't tick stale numbers; reset baseline so
      // resume gives an accurate first sample.
      const now = Date.now()
      if (e.state === 'paused') {
        e.bytesPerSecond = 0
        dl.lastSampleAt = now
        dl.lastSampleBytes = e.receivedBytes
      } else {
        const elapsed = now - dl.lastSampleAt
        if (elapsed >= 250) {
          const delta = e.receivedBytes - dl.lastSampleBytes
          e.bytesPerSecond = Math.max(0, Math.round((delta * 1000) / elapsed))
          dl.lastSampleAt = now
          dl.lastSampleBytes = e.receivedBytes
        }
      }
      broadcast()
    })

    item.once('done', (_evt, state) => {
      const e = dl.entry
      e.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      e.endedAt = Date.now()
      e.bytesPerSecond = 0
      // Persist into history and drop the live ref — show-in-folder /
      // open-file work off the saved entry from here on.
      const history = loadHistory()
      history.push({ ...e })
      saveHistory(history)
      live.delete(id)
      log.info('downloads: done', { id, state: e.state, filename: e.filename })
      broadcast()
    })
  })
}

function findEntry(id: string): { entry: DownloadEntry; live: LiveDownload | null } | null {
  const liveDl = live.get(id)
  if (liveDl) return { entry: liveDl.entry, live: liveDl }
  const hist = loadHistory().find((e) => e.id === id)
  if (hist) return { entry: hist, live: null }
  return null
}

export function registerDownloadsIpc(): void {
  ipcMain.handle('downloads:list', () => buildSnapshot())

  ipcMain.handle('downloads:pause', (_e, id: string) => {
    const found = findEntry(id)
    if (!found?.live?.item) return false
    if (!found.live.item.isPaused()) found.live.item.pause()
    return true
  })

  ipcMain.handle('downloads:resume', (_e, id: string) => {
    const found = findEntry(id)
    if (!found?.live?.item) return false
    if (found.live.item.canResume()) found.live.item.resume()
    return true
  })

  ipcMain.handle('downloads:cancel', (_e, id: string) => {
    const found = findEntry(id)
    if (!found?.live?.item) return false
    found.live.item.cancel()
    return true
  })

  // Remove a single completed entry from history. Active downloads must be
  // cancelled first — this is a noop for live items so the UI can't
  // accidentally orphan a running DownloadItem.
  ipcMain.handle('downloads:remove', (_e, id: string) => {
    if (live.has(id)) return false
    const next = loadHistory().filter((e) => e.id !== id)
    saveHistory(next)
    broadcast()
    return true
  })

  // Clear every finished entry — leaves in-flight downloads alone.
  ipcMain.handle('downloads:clear', () => {
    saveHistory([])
    broadcast()
    return true
  })

  ipcMain.handle('downloads:show-in-folder', (_e, id: string) => {
    const found = findEntry(id)
    if (!found) return false
    try {
      shell.showItemInFolder(found.entry.savePath)
      return true
    } catch (err) {
      log.warn('downloads: showItemInFolder failed', { id, err: String(err) })
      return false
    }
  })

  ipcMain.handle('downloads:open-file', async (_e, id: string) => {
    const found = findEntry(id)
    if (!found || found.entry.state !== 'completed') return false
    try {
      const errMsg = await shell.openPath(found.entry.savePath)
      if (errMsg) {
        log.warn('downloads: openPath returned error', { id, errMsg })
        return false
      }
      return true
    } catch (err) {
      log.warn('downloads: openPath threw', { id, err: String(err) })
      return false
    }
  })

  // Re-broadcast the current snapshot to every window. Useful right after
  // a new window opens — the renderer asks for an immediate refresh via
  // its initial `downloads:list` call, this just gives callers a manual
  // re-push if they need it.
  ipcMain.handle('downloads:refresh', () => {
    broadcast()
    return buildSnapshot()
  })
}

/** Attach the handler to a session set up outside configureSession (e.g. the
 *  default session, or a partition created lazily). */
export function attachDownloadHandlerToDefault(): void {
  attachDownloadHandler(electronSession.defaultSession)
}
