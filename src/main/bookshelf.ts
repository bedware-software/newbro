// Per-profile "Bookshelf" reading queue.
//
// Each profile keeps its own shelf: a flat list of readings plus a set of
// groups (mirroring workspace Tab Groups — named, colored, collapsible). A
// reading optionally belongs to a group via `groupId`. The shelf is persisted
// to its own electron-store and broadcast to every window via
// 'bookshelf:updated' so the right-hand sidebar stays live across windows.
//
// A reading can also be saved for offline use: we load its URL in a hidden
// BrowserWindow under the profile's partition (so cookies/auth carry over) and
// write a self-contained .mhtml into userData/bookshelf, then point the entry
// at that file. The original `url` is always preserved.

import { ipcMain, BrowserWindow, app } from 'electron'
import Store from 'electron-store'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { log } from './log'
import { notifyCloudChange } from './cloud-sync'

export type ReadingStatus = 'toread' | 'archived'

export interface Reading {
  id: string
  url: string
  title: string
  favicon?: string
  status: ReadingStatus
  addedAt: number
  /** Group membership (only meaningful while status === 'toread'). */
  groupId?: string
  /** Absolute path to a saved single-file MHTML, set once saved offline. */
  offlinePath?: string
}

export interface ReadingGroup {
  id: string
  name: string
  color: string
  isCollapsed: boolean
}

interface Shelf {
  readings: Reading[]
  groups: ReadingGroup[]
}

interface AddInput {
  url: string
  title?: string
  favicon?: string
}

// Same palette as workspace Tab Groups (src/renderer/.../app-store.ts) so a
// shelf group looks at home next to the tab UI.
const GROUP_COLORS = [
  '#7AAFAF', '#9C9C9C', '#5681B8', '#D08866', '#C4A140', '#B488C9',
  '#8E81C9', '#BD5E94', '#7FB87F', '#D6A87F', '#C46161', '#7FA8D6',
]

const store = new Store({
  name: 'newbro-bookshelf',
  defaults: { byProfile: {} as Record<string, unknown> },
})

function loadAll(): Record<string, unknown> {
  const raw = store.get('byProfile') as Record<string, unknown> | undefined
  return raw && typeof raw === 'object' ? raw : {}
}

/** Read a profile's shelf, migrating the legacy flat-array shape on the fly. */
function shelfFor(profileId: string): Shelf {
  if (!profileId) return { readings: [], groups: [] }
  const raw = loadAll()[profileId]
  if (Array.isArray(raw)) return { readings: raw as Reading[], groups: [] }
  if (raw && typeof raw === 'object') {
    const s = raw as Partial<Shelf>
    return { readings: s.readings ?? [], groups: s.groups ?? [] }
  }
  return { readings: [], groups: [] }
}

function persistShelf(profileId: string, shelf: Shelf): void {
  const all = loadAll()
  all[profileId] = shelf
  store.set('byProfile', all)
}

// Debounced broadcast, coalescing per-profile dirty marks into one flush.
let broadcastPending: ReturnType<typeof setTimeout> | null = null
const dirtyProfiles = new Set<string>()
function scheduleBroadcast(profileId: string): void {
  dirtyProfiles.add(profileId)
  if (broadcastPending) return
  broadcastPending = setTimeout(() => {
    broadcastPending = null
    const profiles = [...dirtyProfiles]
    dirtyProfiles.clear()
    for (const pid of profiles) {
      const shelf = shelfFor(pid)
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        try { win.webContents.send('bookshelf:updated', { profileId: pid, ...shelf }) }
        catch (err) { log.warn('bookshelf: broadcast failed', String(err)) }
      }
    }
  }, 50)
}

function commit(profileId: string, shelf: Shelf): void {
  persistShelf(profileId, shelf)
  scheduleBroadcast(profileId)
  notifyCloudChange('bookshelf')
}

// ── Cloud sync adapters ──
// The whole per-profile map is one sync category. exportShelves reads it;
// importShelves replaces it and refreshes every window's right-hand sidebar.
export function exportShelves(): Record<string, unknown> {
  return loadAll()
}

export function importShelves(all: Record<string, unknown>): void {
  store.set('byProfile', all && typeof all === 'object' ? all : {})
  for (const pid of Object.keys(all || {})) scheduleBroadcast(pid)
}

/** Add a reading. Re-adding an existing URL refreshes its title/favicon,
 *  un-archives it, and floats it to the top instead of duplicating. */
function addReading(profileId: string, input: AddInput): Reading | null {
  const url = (input.url || '').trim()
  if (!profileId || !url) return null
  const shelf = shelfFor(profileId)
  const existing = shelf.readings.find((r) => r.url === url)
  if (existing) {
    existing.status = 'toread'
    if (input.title?.trim()) existing.title = input.title.trim()
    if (input.favicon) existing.favicon = input.favicon
    const i = shelf.readings.indexOf(existing)
    shelf.readings.splice(i, 1)
    shelf.readings.unshift(existing)
    commit(profileId, shelf)
    return existing
  }
  const reading: Reading = {
    id: randomUUID(),
    url,
    title: input.title?.trim() || url,
    favicon: input.favicon || undefined,
    status: 'toread',
    addedAt: Date.now(),
  }
  shelf.readings.unshift(reading)
  commit(profileId, shelf)
  return reading
}

function updateReading(
  profileId: string,
  id: string,
  patch: { title?: string; status?: ReadingStatus },
): void {
  const shelf = shelfFor(profileId)
  const r = shelf.readings.find((r) => r.id === id)
  if (!r) return
  if (typeof patch.title === 'string') r.title = patch.title.trim() || r.url
  if (patch.status) {
    r.status = patch.status
    // Archiving drops group membership — groups live in the To Read area.
    if (patch.status === 'archived') r.groupId = undefined
  }
  commit(profileId, shelf)
}

function removeReading(profileId: string, id: string): void {
  const shelf = shelfFor(profileId)
  const r = shelf.readings.find((r) => r.id === id)
  if (!r) return
  cleanupOffline(r)
  shelf.readings = shelf.readings.filter((x) => x.id !== id)
  commit(profileId, shelf)
}

/** Move a reading into a group (or out to ungrouped when groupId is null),
 *  dropping it at the end of the target container. */
function moveReading(profileId: string, readingId: string, groupId: string | null): void {
  const shelf = shelfFor(profileId)
  const idx = shelf.readings.findIndex((r) => r.id === readingId)
  if (idx === -1) return
  const [r] = shelf.readings.splice(idx, 1)
  r.groupId = groupId ?? undefined
  r.status = 'toread' // dragging it into view un-archives it
  shelf.readings.push(r) // last within its container (array order = display order)
  commit(profileId, shelf)
}

function addGroup(profileId: string, name?: string): ReadingGroup | null {
  if (!profileId) return null
  const shelf = shelfFor(profileId)
  const group: ReadingGroup = {
    id: randomUUID(),
    name: name?.trim() || 'New Group',
    color: GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)],
    isCollapsed: false,
  }
  shelf.groups.push(group)
  commit(profileId, shelf)
  return group
}

function updateGroup(
  profileId: string,
  id: string,
  patch: { name?: string; color?: string; isCollapsed?: boolean },
): void {
  const shelf = shelfFor(profileId)
  const g = shelf.groups.find((g) => g.id === id)
  if (!g) return
  if (typeof patch.name === 'string') g.name = patch.name.trim() || g.name
  if (typeof patch.color === 'string') g.color = patch.color
  if (typeof patch.isCollapsed === 'boolean') g.isCollapsed = patch.isCollapsed
  commit(profileId, shelf)
}

/** Remove a group. By default its readings are ungrouped (kept); pass
 *  deleteReadings to discard them (and their offline copies) too. */
function removeGroup(profileId: string, id: string, deleteReadings: boolean): void {
  const shelf = shelfFor(profileId)
  if (!shelf.groups.some((g) => g.id === id)) return
  shelf.groups = shelf.groups.filter((g) => g.id !== id)
  if (deleteReadings) {
    for (const r of shelf.readings) if (r.groupId === id) cleanupOffline(r)
    shelf.readings = shelf.readings.filter((r) => r.groupId !== id)
  } else {
    for (const r of shelf.readings) if (r.groupId === id) r.groupId = undefined
  }
  commit(profileId, shelf)
}

function cleanupOffline(r: Reading): void {
  if (!r.offlinePath) return
  try { fs.rmSync(r.offlinePath, { force: true }) }
  catch (err) { log.warn('bookshelf: offline file cleanup failed', String(err)) }
}

function offlineDir(): string {
  const dir = path.join(app.getPath('userData'), 'bookshelf')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Load the reading's URL in a hidden window under the profile's partition,
 *  then snapshot the rendered page to a single-file MHTML for offline use. */
async function saveOffline(profileId: string, id: string, partition: string): Promise<boolean> {
  const shelf = shelfFor(profileId)
  const r = shelf.readings.find((r) => r.id === id)
  if (!r) return false
  const dest = path.join(offlineDir(), `${id}.mhtml`)
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition: partition || undefined },
  })
  try {
    await win.webContents.loadURL(r.url)
    // Give late async resources a beat to settle before snapshotting.
    await new Promise((res) => setTimeout(res, 600))
    await win.webContents.savePage(dest, 'MHTML')
    r.offlinePath = dest
    commit(profileId, shelf)
    log.info('bookshelf: saved offline', { id, dest })
    return true
  } catch (err) {
    log.warn('bookshelf: save offline failed', { id, url: r.url, err: String(err) })
    return false
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

export function registerBookshelfIpc(): void {
  ipcMain.handle('bookshelf:list', (_e, profileId: string) => shelfFor(profileId))
  ipcMain.handle('bookshelf:add', (_e, profileId: string, input: AddInput) => addReading(profileId, input))
  ipcMain.handle('bookshelf:update', (_e, profileId: string, id: string, patch: { title?: string; status?: ReadingStatus }) => {
    updateReading(profileId, id, patch)
    return true
  })
  ipcMain.handle('bookshelf:remove', (_e, profileId: string, id: string) => {
    removeReading(profileId, id)
    return true
  })
  ipcMain.handle('bookshelf:move-reading', (_e, profileId: string, readingId: string, groupId: string | null) => {
    moveReading(profileId, readingId, groupId)
    return true
  })
  ipcMain.handle('bookshelf:add-group', (_e, profileId: string, name: string) => addGroup(profileId, name))
  ipcMain.handle('bookshelf:update-group', (_e, profileId: string, id: string, patch: { name?: string; color?: string; isCollapsed?: boolean }) => {
    updateGroup(profileId, id, patch)
    return true
  })
  ipcMain.handle('bookshelf:remove-group', (_e, profileId: string, id: string, deleteReadings: boolean) => {
    removeGroup(profileId, id, deleteReadings)
    return true
  })
  ipcMain.handle('bookshelf:save-offline', (_e, profileId: string, id: string, partition: string) =>
    saveOffline(profileId, id, partition),
  )
}
