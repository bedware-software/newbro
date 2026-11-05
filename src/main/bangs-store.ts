// The bang table (see src/shared/bangs.ts), in its own electron-store like
// the other *-store.ts files. Until the user changes anything it is
// DEFAULT_BANGS; after that it is their table, plus any seeded bang added in
// a later version that they haven't deleted. Every window gets the table
// again on `bangs:updated` whenever it changes.

import { BrowserWindow, ipcMain } from 'electron'
import Store from 'electron-store'
import { DEFAULT_BANGS, MAX_BANGS, sanitizeBang, type Bang } from '../shared/bangs'
import { log } from './log'

interface BangsData {
  /** Null until the user first changes the table. */
  bangs: Bang[] | null
  /** Seeded bangs the user deleted — not brought back by new seeds. */
  removedBuiltins: string[]
}

const store = new Store<BangsData>({
  name: 'newbro-bangs',
  defaults: { bangs: null, removedBuiltins: [] },
})

function defaults(): Bang[] {
  return DEFAULT_BANGS.map((b) => ({ ...b }))
}

/** Valid entries only, one per id and per trigger, first wins. */
function clean(list: unknown): Bang[] {
  if (!Array.isArray(list)) return []
  const out: Bang[] = []
  const ids = new Set<string>()
  const triggers = new Set<string>()
  for (const raw of list) {
    const b = sanitizeBang(raw)
    if (!b) {
      log.warn('bangs: dropped an invalid entry', JSON.stringify(raw)?.slice(0, 200))
      continue
    }
    if (ids.has(b.id) || triggers.has(b.trigger)) continue
    ids.add(b.id)
    triggers.add(b.trigger)
    out.push(b)
    if (out.length >= MAX_BANGS) break
  }
  return out
}

export function loadBangs(): Bang[] {
  const saved = store.get('bangs')
  if (!Array.isArray(saved)) return defaults()
  const list = clean(saved)
  const removed = new Set(store.get('removedBuiltins') ?? [])
  const ids = new Set(list.map((b) => b.id))
  const triggers = new Set(list.map((b) => b.trigger))
  for (const b of DEFAULT_BANGS) {
    if (ids.has(b.id) || removed.has(b.id) || triggers.has(b.trigger)) continue
    list.push({ ...b })
  }
  return list
}

function broadcast(list: Bang[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('bangs:updated', list)
  }
}

export function saveBangs(raw: unknown): Bang[] {
  const list = clean(raw)
  const kept = new Set(list.map((b) => b.id))
  const removed = new Set(store.get('removedBuiltins') ?? [])
  for (const b of DEFAULT_BANGS) {
    if (kept.has(b.id)) removed.delete(b.id)
    else removed.add(b.id)
  }
  store.set('bangs', list)
  store.set('removedBuiltins', [...removed])
  log.info('bangs: saved', { count: list.length, removedBuiltins: removed.size })
  broadcast(list)
  return list
}

export function resetBangs(): Bang[] {
  store.set('bangs', null)
  store.set('removedBuiltins', [])
  const list = defaults()
  log.info('bangs: reset to defaults', { count: list.length })
  broadcast(list)
  return list
}

export function registerBangsIpc(): void {
  ipcMain.handle('bangs:list', () => loadBangs())
  ipcMain.handle('bangs:save', (_e, list: unknown) => saveBangs(list))
  ipcMain.handle('bangs:reset', () => resetBangs())
}
