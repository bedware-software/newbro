// Cloud sync via a user-picked folder.
//
// The "cloud" is whatever desktop client already replicates the chosen folder
// (OneDrive / Dropbox / Google Drive) — we never talk to a network. We mirror a
// handful of local data sets into `<folder>/newbro-sync/<category>.json` as
// self-describing envelopes, watch that folder for changes pushed by other
// devices, and merge with last-write-wins per category.
//
// Each data set ("category") is wired from the outside via registerSyncCategory
// with a read()/write() adapter, so this module stays free of imports from the
// individual stores (avoids import cycles — the stores only import
// notifyCloudChange from here). The actual adapters are wired in ipc.ts where
// the store + broadcast helpers are already in scope.

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import Store from 'electron-store'
import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { log } from './log'

export type SyncCategory =
  | 'state'
  | 'settings'
  | 'bookshelf'
  | 'history'
  | 'permissions'
  | 'extensions'

export const SYNC_CATEGORIES: readonly SyncCategory[] = [
  'state',
  'settings',
  'bookshelf',
  'history',
  'permissions',
  'extensions',
] as const

/** Adapter a category provides: read its current local payload, and apply an
 *  incoming payload (persist + rebroadcast to renderers). write may be async —
 *  extensions reconcile by re-downloading CRXs. */
export interface SyncAdapter {
  read: () => unknown
  write: (data: unknown) => void | Promise<void>
}

interface SeenMark {
  hash: string
  updatedAt: number
}

interface SyncEnvelope {
  schema: 1
  category: SyncCategory
  updatedAt: number
  deviceId: string
  hash: string
  data: unknown
}

interface SyncConfig {
  enabled: boolean
  folderPath: string
  deviceId: string
  categories: Record<SyncCategory, boolean>
  lastSync: number
  /** Per-category mark of the last payload we wrote or adopted. Persisted so a
   *  restart can do proper last-write-wins instead of blindly adopting the
   *  cloud copy and clobbering offline local edits. */
  lastSeen: Partial<Record<SyncCategory, SeenMark>>
  /** True once the user has dismissed the first-run "set up sync" offer for
   *  good ("Don't show again"). Local-only (the sync-config store isn't itself
   *  synced), so each device makes its own call. The offer also stops showing
   *  once sync is enabled — see buildSetupPromptInfo. */
  promptDismissed: boolean
}

export type SyncState = 'disabled' | 'idle' | 'syncing' | 'error'

export interface SyncInfo {
  enabled: boolean
  folderPath: string
  deviceId: string
  categories: Record<SyncCategory, boolean>
  state: SyncState
  lastSync: number
  error: string | null
}

const SYNC_SUBDIR = 'newbro-sync'

// The folder we propose by default lives at the iCloud Drive root. The sync
// engine still nests its envelopes under SYNC_SUBDIR inside it, so the user
// sees a tidy "Newbro Sync" folder in iCloud.
const ICLOUD_DEFAULT_FOLDER_NAME = 'Newbro Sync'

/** Best-effort path to the user's iCloud Drive root, or null if not present.
 *  Windows (iCloud for Windows): %USERPROFILE%\iCloudDrive (or "iCloud Drive").
 *  macOS: ~/Library/Mobile Documents/com~apple~CloudDocs. */
export function detectICloudDrive(): string | null {
  const home = app.getPath('home')
  const candidates = process.platform === 'darwin'
    ? [path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')]
    : [path.join(home, 'iCloudDrive'), path.join(home, 'iCloud Drive')]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c
    } catch { /* unreadable candidate — try the next */ }
  }
  return null
}

/** The default folder we offer to sync into: <iCloud Drive>/Newbro Sync, or
 *  null when iCloud Drive isn't installed (then the user picks a folder). */
export function suggestedSyncFolder(): string | null {
  const icloud = detectICloudDrive()
  return icloud ? path.join(icloud, ICLOUD_DEFAULT_FOLDER_NAME) : null
}

export interface SetupPromptInfo {
  /** Whether the renderer should pop the first-run setup offer. */
  shouldPrompt: boolean
  /** iCloud Drive was found — the suggested folder is an iCloud path. */
  icloudAvailable: boolean
  /** Pre-filled default folder (<iCloud>/Newbro Sync), or null. */
  suggestedFolder: string | null
}

// Only one window should pop the offer per launch. The first window to claim it
// flips this; later restored windows get shouldPrompt:false. Resets naturally
// on the next app start (module re-evaluates).
let setupPromptClaimed = false

function buildSetupPromptInfo(claim: boolean): SetupPromptInfo {
  const cfg = getConfig()
  const suggestedFolder = suggestedSyncFolder()
  // Offer until the user either enables sync or dismisses the offer for good.
  let shouldPrompt = !cfg.enabled && !cfg.promptDismissed
  if (claim && shouldPrompt) {
    if (setupPromptClaimed) shouldPrompt = false
    else setupPromptClaimed = true
  }
  return { shouldPrompt, icloudAvailable: !!suggestedFolder, suggestedFolder }
}

function defaultCategories(): Record<SyncCategory, boolean> {
  return { state: true, settings: true, bookshelf: true, history: true, permissions: true, extensions: true }
}

const store = new Store<{ config: SyncConfig }>({
  name: 'newbro-sync-config',
  defaults: {
    config: {
      enabled: false,
      folderPath: '',
      deviceId: '',
      categories: defaultCategories(),
      lastSync: 0,
      lastSeen: {},
      promptDismissed: false,
    },
  },
})

// ── In-memory runtime state ──
const adapters = new Map<SyncCategory, SyncAdapter>()
const lastSeen = new Map<SyncCategory, SeenMark>()
const pushTimers = new Map<SyncCategory, ReturnType<typeof setTimeout>>()
let watcher: fs.FSWatcher | null = null
let watchDebounce: ReturnType<typeof setTimeout> | null = null
let runtimeState: SyncState = 'disabled'
let runtimeError: string | null = null
// True while we apply an incoming payload, so the resulting local-change
// notification doesn't immediately bounce back as a push.
let applying = false

const PUSH_DEBOUNCE_MS = 500
const WATCH_DEBOUNCE_MS = 400

function getConfig(): SyncConfig {
  const cfg = store.get('config')
  // Merge defaults so a config saved before a new category existed still has
  // every key present.
  return {
    enabled: !!cfg.enabled,
    folderPath: cfg.folderPath || '',
    deviceId: cfg.deviceId || '',
    categories: { ...defaultCategories(), ...(cfg.categories || {}) },
    lastSync: cfg.lastSync || 0,
    lastSeen: cfg.lastSeen || {},
    promptDismissed: !!cfg.promptDismissed,
  }
}

function setConfig(patch: Partial<SyncConfig>): SyncConfig {
  const next = { ...getConfig(), ...patch }
  store.set('config', next)
  return next
}

function ensureDeviceId(): string {
  const cfg = getConfig()
  if (cfg.deviceId) return cfg.deviceId
  const id = randomUUID()
  setConfig({ deviceId: id })
  return id
}

function persistSeen(): void {
  const obj: Partial<Record<SyncCategory, SeenMark>> = {}
  for (const [cat, mark] of lastSeen) obj[cat] = mark
  setConfig({ lastSeen: obj })
}

function setSeen(cat: SyncCategory, hash: string, updatedAt: number): void {
  lastSeen.set(cat, { hash, updatedAt })
  persistSeen()
}

// ── Stable serialization + hashing ──
// A canonical JSON form (object keys sorted) so logically-identical payloads
// hash the same across devices regardless of key insertion order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
  return `{${parts.join(',')}}`
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

// ── Filesystem helpers ──
function syncDir(): string {
  return path.join(getConfig().folderPath, SYNC_SUBDIR)
}

function fileFor(cat: SyncCategory): string {
  return path.join(syncDir(), `${cat}.json`)
}

function ensureSyncDir(): boolean {
  const dir = syncDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch (err) {
    log.warn('cloud-sync: cannot create sync dir', { dir, err: String(err) })
    return false
  }
}

function readEnvelope(cat: SyncCategory): SyncEnvelope | null {
  const file = fileFor(cat)
  try {
    if (!fs.existsSync(file)) return null
    const raw = fs.readFileSync(file, 'utf-8')
    const env = JSON.parse(raw) as SyncEnvelope
    if (!env || env.category !== cat || typeof env.updatedAt !== 'number' || typeof env.hash !== 'string') {
      return null
    }
    return env
  } catch (err) {
    // A half-written file (sync client mid-flight) or malformed JSON — skip it
    // this round; the watcher fires again once the write settles.
    log.warn('cloud-sync: read envelope failed', { cat, err: String(err) })
    return null
  }
}

function writeEnvelope(cat: SyncCategory, data: unknown, hash: string, updatedAt: number): boolean {
  if (!ensureSyncDir()) return false
  const env: SyncEnvelope = { schema: 1, category: cat, updatedAt, deviceId: ensureDeviceId(), hash, data }
  const file = fileFor(cat)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(env), 'utf-8')
    fs.renameSync(tmp, file) // atomic on the same volume — watcher never sees a partial file
    return true
  } catch (err) {
    log.warn('cloud-sync: write envelope failed', { cat, err: String(err) })
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    return false
  }
}

// ── Status broadcast ──
function buildInfo(): SyncInfo {
  const cfg = getConfig()
  return {
    enabled: cfg.enabled,
    folderPath: cfg.folderPath,
    deviceId: cfg.deviceId,
    categories: cfg.categories,
    state: cfg.enabled ? runtimeState : 'disabled',
    lastSync: cfg.lastSync,
    error: runtimeError,
  }
}

export function getSyncInfo(): SyncInfo {
  return buildInfo()
}

function broadcastStatus(): void {
  const info = buildInfo()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try { win.webContents.send('cloud-sync:status', info) } catch { /* ignore */ }
  }
}

function setRuntimeState(state: SyncState, error: string | null = null): void {
  runtimeState = state
  runtimeError = error
  broadcastStatus()
}

// ── Category registration (wired from ipc.ts) ──
export function registerSyncCategory(cat: SyncCategory, adapter: SyncAdapter): void {
  adapters.set(cat, adapter)
}

function isActive(cat: SyncCategory): boolean {
  const cfg = getConfig()
  return cfg.enabled && !!cfg.categories[cat] && adapters.has(cat) && !!cfg.folderPath
}

// ── Push (local → folder) ──
/** Called by a store when its data mutates. Schedules a debounced push. */
export function notifyCloudChange(cat: SyncCategory): void {
  if (applying) return
  if (!isActive(cat)) return
  const existing = pushTimers.get(cat)
  if (existing) clearTimeout(existing)
  pushTimers.set(cat, setTimeout(() => {
    pushTimers.delete(cat)
    pushIfChanged(cat)
  }, PUSH_DEBOUNCE_MS))
}

function pushIfChanged(cat: SyncCategory): void {
  if (!isActive(cat)) return
  const adapter = adapters.get(cat)!
  let data: unknown
  try { data = adapter.read() } catch (err) { log.warn('cloud-sync: read failed', { cat, err: String(err) }); return }
  const h = hashOf(data)
  const seen = lastSeen.get(cat)
  if (seen && seen.hash === h) return // nothing new (or echo of an applied payload)
  const updatedAt = Date.now()
  if (writeEnvelope(cat, data, h, updatedAt)) {
    setSeen(cat, h, updatedAt)
    touchLastSync()
    log.info('cloud-sync: pushed', { cat })
  }
}

// ── Pull (folder → local) ──
async function pullCategory(cat: SyncCategory): Promise<void> {
  if (!isActive(cat)) return
  const adapter = adapters.get(cat)!
  const env = readEnvelope(cat)
  if (!env) return
  const deviceId = ensureDeviceId()

  let localData: unknown
  try { localData = adapter.read() } catch (err) { log.warn('cloud-sync: read failed', { cat, err: String(err) }); return }
  const localHash = hashOf(localData)

  // Our own write coming back through the watcher — just record the mark.
  if (env.deviceId === deviceId) {
    setSeen(cat, env.hash, env.updatedAt)
    return
  }
  // Already identical to what we have locally.
  if (env.hash === localHash) {
    setSeen(cat, env.hash, env.updatedAt)
    return
  }
  // Content differs: last-write-wins by updatedAt. Don't clobber a local edit
  // that's newer than the remote copy (it'll get pushed instead).
  const localUpdatedAt = lastSeen.get(cat)?.updatedAt ?? 0
  if (env.updatedAt <= localUpdatedAt) return

  applying = true
  try {
    await adapter.write(env.data)
    // Claim we're at the remote's state. For pass-through categories the next
    // local read hashes identically so no echo push fires; settings normalize
    // on save, which converges in at most one extra round (normalization is
    // idempotent).
    setSeen(cat, env.hash, env.updatedAt)
    touchLastSync()
    log.info('cloud-sync: adopted', { cat })
  } catch (err) {
    log.warn('cloud-sync: apply failed', { cat, err: String(err) })
  } finally {
    applying = false
  }
}

function touchLastSync(): void {
  setConfig({ lastSync: Date.now() })
}

// ── Watcher ──
function startWatcher(): void {
  stopWatcher()
  if (!ensureSyncDir()) return
  try {
    watcher = fs.watch(syncDir(), { persistent: false }, () => {
      if (watchDebounce) clearTimeout(watchDebounce)
      watchDebounce = setTimeout(() => { void pullAll() }, WATCH_DEBOUNCE_MS)
    })
    log.info('cloud-sync: watching', syncDir())
  } catch (err) {
    log.warn('cloud-sync: watch failed', { dir: syncDir(), err: String(err) })
  }
}

function stopWatcher(): void {
  if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = null }
  if (watcher) {
    try { watcher.close() } catch { /* ignore */ }
    watcher = null
  }
}

async function pullAll(): Promise<void> {
  const cfg = getConfig()
  if (!cfg.enabled) return
  for (const cat of SYNC_CATEGORIES) {
    if (cfg.categories[cat]) await pullCategory(cat)
  }
  broadcastStatus()
}

// ── Public sync operations ──
/** Pull each enabled category (adopting newer remote copies), then push any
 *  local-newer / missing ones. */
export async function syncNow(): Promise<SyncInfo> {
  const cfg = getConfig()
  if (!cfg.enabled || !cfg.folderPath) return buildInfo()
  setRuntimeState('syncing')
  try {
    for (const cat of SYNC_CATEGORIES) {
      if (!cfg.categories[cat]) continue
      await pullCategory(cat)
      pushIfChanged(cat)
    }
    setConfig({ lastSync: Date.now() })
    setRuntimeState('idle')
  } catch (err) {
    setRuntimeState('error', String(err))
  }
  return buildInfo()
}

/** Synchronous best-effort flush of any locally-changed categories. Called from
 *  before-quit, where async work may not complete. */
export function flushPushSync(): void {
  const cfg = getConfig()
  if (!cfg.enabled || !cfg.folderPath) return
  for (const cat of SYNC_CATEGORIES) {
    if (cfg.categories[cat]) {
      const t = pushTimers.get(cat)
      if (t) { clearTimeout(t); pushTimers.delete(cat) }
      pushIfChanged(cat)
    }
  }
}

/** Load persisted lastSeen marks, run an initial reconcile, and start watching.
 *  Must run after all categories are registered and before the first windows
 *  open (so restored windows reflect synced state). */
export async function initCloudSync(): Promise<void> {
  ensureDeviceId()
  const cfg = getConfig()
  // Restore persisted marks for proper last-write-wins across restarts.
  lastSeen.clear()
  for (const cat of SYNC_CATEGORIES) {
    const mark = cfg.lastSeen[cat]
    if (mark) lastSeen.set(cat, mark)
  }
  if (!cfg.enabled || !cfg.folderPath) {
    setRuntimeState('disabled')
    return
  }
  setRuntimeState('syncing')
  try {
    await syncNow()
    startWatcher()
    setRuntimeState('idle')
  } catch (err) {
    setRuntimeState('error', String(err))
  }
}

// ── IPC ──
export function registerCloudSyncIpc(): void {
  ipcMain.handle('cloud-sync:get-info', () => buildInfo())

  ipcMain.handle('cloud-sync:set-folder', async (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose sync folder',
      message: 'Pick a folder inside OneDrive, Dropbox, or Google Drive so your data syncs across devices.',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return buildInfo()
    setConfig({ folderPath: result.filePaths[0] })
    if (getConfig().enabled) {
      await syncNow()
      startWatcher()
    }
    broadcastStatus()
    return buildInfo()
  })

  ipcMain.handle('cloud-sync:set-enabled', async (_e, enabled: boolean) => {
    if (enabled) {
      if (!getConfig().folderPath) return buildInfo() // can't enable without a folder
      // Turning sync on resolves the first-run offer for this device.
      setConfig({ enabled: true, promptDismissed: true })
      await initCloudSync()
    } else {
      setConfig({ enabled: false })
      stopWatcher()
      setRuntimeState('disabled')
    }
    return buildInfo()
  })

  ipcMain.handle('cloud-sync:set-categories', async (_e, patch: Partial<Record<SyncCategory, boolean>>) => {
    const cfg = getConfig()
    const categories = { ...cfg.categories, ...patch }
    setConfig({ categories })
    // Newly-enabled categories should reconcile right away.
    if (cfg.enabled && cfg.folderPath) await syncNow()
    broadcastStatus()
    return buildInfo()
  })

  ipcMain.handle('cloud-sync:now', async () => {
    return syncNow()
  })

  // ── First-run setup offer ──
  // Renderer asks (once, on launch) whether to show the offer; the claim makes
  // sure only the first window across a multi-window restore actually shows it.
  ipcMain.handle('cloud-sync:claim-setup-prompt', () => buildSetupPromptInfo(true))

  // "Don't show again" — never offer on this device until sync is set up.
  ipcMain.handle('cloud-sync:dismiss-prompt', () => {
    setConfig({ promptDismissed: true })
    return buildInfo()
  })

  // Enable sync into a specific folder (e.g. the suggested <iCloud>/Newbro Sync)
  // without the native picker. Creates the folder if it doesn't exist yet.
  ipcMain.handle('cloud-sync:setup-with-folder', async (_e, folderPath: string) => {
    if (!folderPath) return buildInfo()
    try {
      fs.mkdirSync(folderPath, { recursive: true })
    } catch (err) {
      log.warn('cloud-sync: cannot create setup folder', { folderPath, err: String(err) })
      return buildInfo()
    }
    setConfig({ folderPath, enabled: true, promptDismissed: true })
    await initCloudSync()
    broadcastStatus()
    return buildInfo()
  })
}
