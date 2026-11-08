// Cloud sync via a user-picked folder.
//
// The "cloud" is whatever desktop client already replicates the chosen folder
// (OneDrive / Dropbox / Google Drive / iCloud Drive) — we never talk to a
// network. We mirror a handful of local data sets straight into that folder as
// self-describing `<category>.<deviceId>.json` envelopes, watch it for changes
// pushed by other devices, and merge with last-write-wins per category. The
// folder may hold other things too, so only files named like an envelope are
// ever read, and only files that prove to be envelopes are ever deleted.
//
// Each data set ("category") is wired from the outside via registerSyncCategory
// with a read()/write() adapter, so this module stays free of imports from the
// individual stores (avoids import cycles — the stores only import
// notifyCloudChange from here). The actual adapters are wired in ipc.ts where
// the store + broadcast helpers are already in scope.

import { app, BrowserWindow, dialog, ipcMain, type MessageBoxOptions, type OpenDialogOptions } from 'electron'
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
  | 'darkPages'

export const SYNC_CATEGORIES: readonly SyncCategory[] = [
  'state',
  'settings',
  'bookshelf',
  'history',
  'permissions',
  'extensions',
  'darkPages',
] as const

/** Adapter a category provides: read its current local payload, and apply an
 *  incoming payload (persist + rebroadcast to renderers). write may be async —
 *  extensions reconcile by re-downloading CRXs. */
export interface SyncAdapter {
  read: () => unknown
  write: (data: unknown) => void | Promise<void>
  /** write() merges an incoming payload into local data (entry-level, its
   *  own conflict rules) instead of replacing it. Such a category folds in
   *  every other device's copy, not just the newest — an older copy can
   *  still carry entries we lack — and republishes when that changed ours. */
  merge?: boolean
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
  /** The sync folder layout this config was saved under — see SYNC_LAYOUT.
   *  Absent in a config saved before layout 2. */
  layout: number
}

export type SyncState = 'disabled' | 'idle' | 'syncing' | 'error'

export interface SyncProgress {
  /** Categories reconciled so far this run. */
  done: number
  /** Total categories being reconciled this run. */
  total: number
}

export interface SyncInfo {
  enabled: boolean
  folderPath: string
  deviceId: string
  categories: Record<SyncCategory, boolean>
  state: SyncState
  lastSync: number
  error: string | null
  /** Non-null only while a sync run is in flight — drives the setup dialog's
   *  first-load progress bar. */
  progress: SyncProgress | null
}

/** What choosing a folder replies (set-folder, setup-with-folder): the usual
 *  info, plus whether a folder was taken at all — false when the user backed
 *  out of the picker or one of the questions after it, or the folder was
 *  refused (the user was told why). */
export interface FolderPickInfo extends SyncInfo {
  picked: boolean
}

// The sync folder layout a config describes. Layout 1 (Newbro) nested the
// envelopes in a LEGACY_SYNC_SUBDIR subfolder of the folder the user picked;
// layout 2 keeps them straight in the folder the user picked. A config saved
// without a layout is layout 1 — see getConfig.
const SYNC_LAYOUT = 2

// Newbro's sync subfolder. Still known so an upgraded config keeps pointing at
// the very files it used before, and so a new setup can join devices still on
// Newbro, which keep writing there.
const LEGACY_SYNC_SUBDIR = 'newbro-sync'

// The folder we propose by default at the iCloud Drive root, and the one we
// offer to create when the folder the user picked already holds other things.
const SYNC_FOLDER_NAME = 'Vimperium Sync'

// Newbro's default folder at the iCloud Drive root; its envelopes are in
// LEGACY_SYNC_SUBDIR inside it. Proposed first when it's there, so this device
// joins the others instead of starting a separate set.
const LEGACY_ICLOUD_FOLDER_NAME = 'Newbro Sync'

/** Best-effort path to the user's iCloud Drive root, or null if not present.
 *  Windows (iCloud for Windows): %USERPROFILE%\iCloudDrive (or "iCloud Drive").
 *  macOS: ~/Library/Mobile Documents/com~apple~CloudDocs. */
export function detectICloudDrive(): string | null {
  const home = app.getPath('home')
  const candidates = process.platform === 'darwin'
    ? [path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')]
    : [path.join(home, 'iCloudDrive'), path.join(home, 'iCloud Drive')]
  for (const c of candidates) {
    if (isDirectory(c)) return c
  }
  return null
}

function isDirectory(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory()
  } catch (err) {
    log.warn('cloud-sync: cannot stat folder', { path: p, err: String(err) })
    return false
  }
}

/** The default folder we offer to sync into: Newbro's
 *  <iCloud Drive>/Newbro Sync/newbro-sync when it's there (shared with devices
 *  still on Newbro), else <iCloud Drive>/Vimperium Sync — or null when iCloud
 *  Drive isn't installed (then the user picks a folder). */
export function suggestedSyncFolder(): string | null {
  const icloud = detectICloudDrive()
  if (!icloud) return null
  const legacy = path.join(icloud, LEGACY_ICLOUD_FOLDER_NAME, LEGACY_SYNC_SUBDIR)
  return isDirectory(legacy) ? legacy : path.join(icloud, SYNC_FOLDER_NAME)
}

export interface SetupPromptInfo {
  /** Whether the renderer should pop the first-run setup offer. */
  shouldPrompt: boolean
  /** iCloud Drive was found — the suggested folder is an iCloud path. */
  icloudAvailable: boolean
  /** Pre-filled default folder (see suggestedSyncFolder), or null. */
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
  return { state: true, settings: true, bookshelf: true, history: true, permissions: true, extensions: true, darkPages: true }
}

const store = new Store<{ config: SyncConfig }>({
  name: 'vimperium-sync-config',
  defaults: {
    config: {
      enabled: false,
      folderPath: '',
      deviceId: '',
      categories: defaultCategories(),
      lastSync: 0,
      lastSeen: {},
      promptDismissed: false,
      // A fresh install starts on the current layout; a saved config keeps
      // its own `config` object, so this never reaches an old one.
      layout: SYNC_LAYOUT,
    },
  },
})

// ── In-memory runtime state ──
const adapters = new Map<SyncCategory, SyncAdapter>()
const lastSeen = new Map<SyncCategory, SeenMark>()
const pushTimers = new Map<SyncCategory, ReturnType<typeof setTimeout>>()
let watcher: fs.FSWatcher | null = null
let watchDebounce: ReturnType<typeof setTimeout> | null = null
let watchRearm: ReturnType<typeof setTimeout> | null = null
// Next re-arm's delay; reset to WATCH_REARM_FIRST_MS once a watch holds.
let watchRearmDelay = 0
let runtimeState: SyncState = 'disabled'
let runtimeError: string | null = null
// True while we apply an incoming payload, so the resulting local-change
// notification doesn't immediately bounce back as a push.
let applying = false
// Incremented whenever setup/config changes invalidate an in-flight sync run.
// Async folder reads can outlive a settings click; this keeps stale runs from
// applying data or touching files after the user has disabled/restarted setup.
let syncGeneration = 0

const PUSH_DEBOUNCE_MS = 500
const WATCH_DEBOUNCE_MS = 400
// Cap on how long we wait for a single envelope to read. Generous enough for a
// real cloud download to complete, short enough that a wedged sync client
// doesn't leave the user staring at a frozen "Setting up…" forever.
const READ_TIMEOUT_MS = 20000
// Envelopes run to a few hundred KB (316 KB is the biggest seen). A file far
// past that isn't one of ours, and reading it would only stall the sync — or
// make a cloud client download it.
const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024
// The watcher is re-armed after an error or a vanished folder, backing off
// from the first delay to the last.
const WATCH_REARM_FIRST_MS = 2000
const WATCH_REARM_MAX_MS = 60000

// Set once the layout-1 → 2 rewrite has been saved (or tried) this run.
let layoutSaved = false

function getConfig(): SyncConfig {
  const cfg = (store.get('config') || {}) as Partial<SyncConfig>
  const storedFolder = typeof cfg.folderPath === 'string' ? cfg.folderPath : ''
  // A config from before layout 2 names the folder the user picked, and its
  // envelopes are in LEGACY_SYNC_SUBDIR inside it — always: the old engine put
  // them nowhere else, and made that subfolder on its first write. Pointing
  // folderPath at the subfolder keeps this device on the very same files (a
  // path change, nothing moved), whatever the disk looks like right now — a
  // cloud folder that isn't mounted yet included. Done here so no caller ever
  // sees the old meaning.
  const oldLayout = typeof cfg.layout !== 'number' || cfg.layout < SYNC_LAYOUT
  const folderPath = oldLayout && storedFolder ? path.join(storedFolder, LEGACY_SYNC_SUBDIR) : storedFolder
  // Merge defaults so a config saved before a new category existed still has
  // every key present.
  const next: SyncConfig = {
    enabled: !!cfg.enabled,
    folderPath,
    deviceId: cfg.deviceId || '',
    categories: { ...defaultCategories(), ...(cfg.categories || {}) },
    lastSync: cfg.lastSync || 0,
    lastSeen: cfg.lastSeen || {},
    promptDismissed: !!cfg.promptDismissed,
    layout: SYNC_LAYOUT,
  }
  if (oldLayout && !layoutSaved) {
    layoutSaved = true
    // The new path and the layout mark go in one write, so the subfolder can
    // never be appended twice. Should the write fail, this read still hands
    // out the new path, and the next setConfig saves it.
    try {
      store.set('config', next)
      log.info('cloud-sync: config moved to layout 2', { from: storedFolder, to: folderPath })
    } catch (err) {
      log.error('cloud-sync: saving the layout 2 config failed', { err: String(err) })
    }
  }
  return next
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
// The envelopes sit straight in the chosen folder (layout 2).
function syncDir(): string {
  return getConfig().folderPath
}

// With no folder set, a path joined onto it would be relative — and land in
// the app's working directory. Every file operation checks this first.
function isUsableDir(dir: string): boolean {
  return !!dir && path.isAbsolute(dir)
}

// ── Envelope file names ──
// The only files this module reads, writes or deletes are named like an
// envelope: `<cat>.<deviceId>.json`, or a copy of one a cloud client forked.
// The device id is a UUID, so no other file matches by accident, which is
// what makes a folder that holds other things safe to sync into.
const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`)
// What cloud clients add to a file's name when they fork it: iCloud's " 2",
// Dropbox's " (… conflicted copy …)" (any note in brackets, so its localised
// wordings and Google Drive's " (1)" count too), OneDrive's "-HOSTNAME". They
// can stack when a fork gets forked.
const FORK_SUFFIX_PATTERN = '(?: \\d{1,4}| \\([^()\\\\/]{1,160}\\)|-[A-Za-z0-9][A-Za-z0-9_-]{0,62})'
const ENVELOPE_NAME_RE = new RegExp(
  `^(${SYNC_CATEGORIES.join('|')})\\.(${UUID_PATTERN})(${FORK_SUFFIX_PATTERN}{0,3})\\.json$`,
)
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

interface EnvelopeName {
  cat: SyncCategory
  /** Lower-cased. */
  deviceId: string
  /** A cloud client's copy, not the file the device itself writes. */
  fork: boolean
}

function parseEnvelopeName(name: string): EnvelopeName | null {
  const m = ENVELOPE_NAME_RE.exec(name)
  if (!m) return null
  return { cat: m[1] as SyncCategory, deviceId: m[2].toLowerCase(), fork: m[3] !== '' }
}

// `ownId` comes from the caller, once per listing: ensureDeviceId reads the
// config store, which reads its file from disk on every get.
function isOwnFileName(name: string, cat: SyncCategory, ownId: string): boolean {
  const parsed = parseEnvelopeName(name)
  return !!parsed && parsed.cat === cat && parsed.deviceId === ownId.toLowerCase()
}

/** Whether a file may be deleted: stricter than what reading accepts. Its name
 *  and its content must agree it's a whole envelope of `cat` — schema 1, a
 *  sha256 hash, a UUID device id that the name carries — and, with `ownerId`,
 *  one of that device's. */
function isDeletableEnvelope(name: string, env: SyncEnvelope, cat: SyncCategory, ownerId?: string): boolean {
  const parsed = parseEnvelopeName(name)
  if (!parsed || parsed.cat !== cat) return false
  if (env.schema !== 1 || env.category !== cat) return false
  if (typeof env.updatedAt !== 'number' || !Number.isFinite(env.updatedAt)) return false
  if (typeof env.hash !== 'string' || !SHA256_HEX_RE.test(env.hash)) return false
  if (typeof env.deviceId !== 'string' || !UUID_RE.test(env.deviceId)) return false
  const deviceId = env.deviceId.toLowerCase()
  if (parsed.deviceId !== deviceId) return false
  return ownerId === undefined || deviceId === ownerId.toLowerCase()
}

// Per-device file naming. The whole point: every device writes ONLY its own
// `<cat>.<deviceId>.json` and reads everyone's, so two devices never write the
// same file. iCloud / OneDrive create "state 2.json" style conflict copies when
// two machines write one shared file around the same time — per-device files
// remove that race entirely.
function selfFileName(cat: SyncCategory): string {
  return `${cat}.${ensureDeviceId()}.json`
}

/** Names of every file in the sync dir that belongs to THIS device for `cat`:
 *  the canonical `<cat>.<deviceId>.json` PLUS any cloud client's fork of it
 *  (`<cat>.<deviceId> 2.json`, ` 3.json`, …). Matched by filename — the deviceId
 *  is unique, so it can't collide with another device's file or a user's.
 *  Sync (readdir) because selfFileExists is on the synchronous push path. */
function ownFileNames(cat: SyncCategory, dir = syncDir()): string[] {
  if (!isUsableDir(dir)) return []
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    // No folder yet is normal before the first write.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('cloud-sync: readdir failed', { dir, err: String(err) })
    }
    return []
  }
  const ownId = ensureDeviceId()
  return names.filter((n) => isOwnFileName(n, cat, ownId))
}

// True if ANY copy of our own file exists — including an iCloud-renamed fork.
// Critical: if we only checked the exact canonical name, then every time iCloud
// renames our upload to "<id> 2.json" we'd think our file vanished and rewrite
// it, which iCloud renames again → an endless stream of fork files.
function selfFileExists(cat: SyncCategory): boolean {
  return ownFileNames(cat).length > 0
}

async function removeSyncFile(dir: string, name: string, cat: SyncCategory, what: string): Promise<void> {
  try {
    await fs.promises.unlink(path.join(dir, name))
    log.info(`cloud-sync: ${what}`, { cat, name })
  } catch (err) {
    // Another run, or the device it belongs to, got there first.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      log.info('cloud-sync: copy already gone', { cat, name })
      return
    }
    log.warn('cloud-sync: cleanup unlink failed', { name, err: String(err) })
  }
}

/** Delete every one of our own files for `cat` except `keepName`. Keeps exactly
 *  one copy after a write so older copies / iCloud forks don't pile up. Each
 *  one is read first and goes only if it proves to be our envelope. Async (and
 *  so not awaited on the push path): a fork may still be a cloud placeholder,
 *  and reading one synchronously would freeze the app until it downloads. */
async function pruneOwnFiles(cat: SyncCategory, keepName: string, dir: string): Promise<void> {
  const ownId = ensureDeviceId()
  for (const name of ownFileNames(cat, dir)) {
    if (name === keepName) continue
    const file = path.join(dir, name)
    if (keptOwnCopies.has(file)) continue
    const env = await readEnvelopeFromFile(file, cat)
    if (!env || !isDeletableEnvelope(name, env, cat, ownId)) {
      keptOwnCopies.add(file)
      log.info('cloud-sync: kept own copy that is not a whole envelope', { cat, name })
      continue
    }
    await removeSyncFile(dir, name, cat, 'pruned own copy')
  }
}

// Own copies pruneOwnFiles left alone this run. It runs on every push, so a
// broken copy would otherwise be re-read (and re-logged) each time; syncNow's
// cleanup still looks at them all.
const keptOwnCopies = new Set<string>()

function ensureSyncDir(dir = syncDir()): boolean {
  if (!isUsableDir(dir)) {
    log.warn('cloud-sync: no usable sync folder', { dir })
    return false
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch (err) {
    log.warn('cloud-sync: cannot create sync dir', { dir, err: String(err) })
    return false
  }
}

/** Await `work`, but give up after `ms`. Reading an iCloud / OneDrive file that
 *  the OS hasn't materialized yet (a "dataless" placeholder) blocks until the
 *  cloud client downloads it — which can be a long time, or forever if the
 *  client is wedged. We read ASYNCHRONOUSLY (off the main thread) AND cap how
 *  long we'll wait, so a stuck file can never freeze the whole app. The reject
 *  doesn't cancel the underlying read; it just lets us move on and let the
 *  watcher retry once the file finishes downloading. */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms (file not yet downloaded?)`)), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readEnvelopeFromFile(file: string, cat: SyncCategory): Promise<SyncEnvelope | null> {
  try {
    // Size first: stat answers from metadata, without downloading anything.
    const stat = await withTimeout(fs.promises.stat(file), READ_TIMEOUT_MS, 'stat')
    if (!stat.isFile()) {
      log.warn('cloud-sync: skipped a non-file', { cat, file })
      return null
    }
    if (stat.size > MAX_ENVELOPE_BYTES) {
      log.warn('cloud-sync: skipped an oversized file', { cat, file, size: stat.size })
      return null
    }
    const raw = await withTimeout(fs.promises.readFile(file, 'utf-8'), READ_TIMEOUT_MS, 'read')
    const env = JSON.parse(raw) as SyncEnvelope
    if (!env || env.category !== cat || typeof env.updatedAt !== 'number' || typeof env.hash !== 'string') {
      return null
    }
    return env
  } catch (err) {
    // Missing file is normal. A timeout, half-written file (sync client
    // mid-flight), or malformed JSON — skip it this round; the watcher fires
    // again once the write/download settles.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    log.warn('cloud-sync: read envelope failed', { cat, file, err: String(err) })
    return null
  }
}

/** Classify a sync-folder filename for a category:
 *   - 'device' → a device's own `<cat>.<uuid>.json` (each device writes only
 *                its own).
 *   - 'fork'   → a cloud client's copy of one ("state.<uuid> 2.json",
 *                "state.<uuid> (… conflicted copy …).json",
 *                "state.<uuid>-DESKTOP-X.json", …), made when it couldn't
 *                reconcile two versions. We read these so stranded data still
 *                merges, and clean them up once superseded.
 *   - null     → anything else: another category, a temp file, the user's own
 *                files. Newbro's early single-file `<cat>.json` (per-device
 *                files replaced it long ago) isn't read any more: in a folder
 *                shared with other things the name is too likely a user's. */
function classifyCategoryFile(name: string, cat: SyncCategory): 'device' | 'fork' | null {
  const parsed = parseEnvelopeName(name)
  if (!parsed || parsed.cat !== cat) return null
  return parsed.fork ? 'fork' : 'device'
}

/** All envelopes for a category across every device file and any cloud forks
 *  of one — each validated by its envelope's own `category` field, so a fork's
 *  looser name can't smuggle in the wrong data. */
async function listEnvelopes(cat: SyncCategory): Promise<SyncEnvelope[]> {
  const dir = syncDir()
  if (!isUsableDir(dir)) return []
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('cloud-sync: readdir failed', { dir, err: String(err) })
    }
    return []
  }
  const envs: SyncEnvelope[] = []
  for (const name of names) {
    if (!classifyCategoryFile(name, cat)) continue
    const env = await readEnvelopeFromFile(path.join(dir, name), cat)
    if (env) envs.push(env)
  }
  return envs
}

/** Delete fork files for a category that are strictly older than the newest
 *  data we already hold (lastSeen). Other devices' own files are never
 *  touched. Safe because we only remove copies whose content is provably
 *  superseded — their data lives on in a newer file — and that prove to be
 *  whole envelopes (isDeletableEnvelope). */
async function cleanupSupersededFiles(cat: SyncCategory, generation = syncGeneration): Promise<void> {
  if (!isRunCurrent(generation) || !isActive(cat)) return
  const dir = syncDir()
  if (!isUsableDir(dir)) return
  const newest = lastSeen.get(cat)?.updatedAt ?? 0
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch (err) {
    // No folder yet is normal before the first write.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('cloud-sync: cleanup readdir failed', { dir, err: String(err) })
    }
    return
  }
  if (!isRunCurrent(generation) || !isActive(cat)) return

  const ownId = ensureDeviceId()
  const isOwn = (n: string): boolean => isOwnFileName(n, cat, ownId)

  // 1) Collapse OUR own files (canonical + any iCloud forks of it) to a single
  //    newest copy. This mops up an existing fork pileup independent of whatever
  //    name iCloud has currently left our file under. A copy that doesn't
  //    prove to be our envelope is left alone.
  const own = names.filter(isOwn)
  if (own.length > 1) {
    const whole: string[] = []
    let best: { name: string; ts: number } | null = null
    for (const name of own) {
      const env = await readEnvelopeFromFile(path.join(dir, name), cat)
      if (!isRunCurrent(generation) || !isActive(cat)) return
      if (!env || !isDeletableEnvelope(name, env, cat, ownId)) continue
      whole.push(name)
      if (!best || env.updatedAt > best.ts) best = { name, ts: env.updatedAt }
    }
    for (const name of whole) {
      if (best && name === best.name) continue
      await removeSyncFile(dir, name, cat, 'pruned own copy')
    }
  }

  // 2) Drop OTHER devices' forks that are provably older than the newest data
  //    we already hold.
  if (!newest) return
  for (const name of names) {
    if (isOwn(name) || classifyCategoryFile(name, cat) !== 'fork') continue
    const env = await readEnvelopeFromFile(path.join(dir, name), cat)
    if (!isRunCurrent(generation) || !isActive(cat)) return
    if (!env || env.updatedAt >= newest || !isDeletableEnvelope(name, env, cat)) continue
    await removeSyncFile(dir, name, cat, 'removed superseded copy')
  }
}

/** Write ONLY this device's own file, IN PLACE (no temp-then-rename).
 *
 *  We used to write a temp file and rename it over the target for atomicity.
 *  On macOS that's a true APFS rename iCloud treats as an in-place update — so
 *  the Mac's files stay clean. But iCloud-on-Windows (CloudFilter) sees the
 *  rename as delete-old + create-new: the file identity changes every write, so
 *  it forks the version it was mid-uploading into conflict copies
 *  ("state.<id> 2.json", " 3.json", …) — exactly the spam observed on Windows.
 *
 *  Writing in place keeps the same file identity, so every cloud client treats
 *  it as a content update. Since each file has a single writer (this device) and
 *  readers tolerate a half-written file (parse fails → skipped, retried on the
 *  next watch/sync), we don't need rename atomicity here. */
function writeEnvelopeSelf(cat: SyncCategory, dir: string, data: unknown, hash: string, updatedAt: number): boolean {
  if (!ensureSyncDir(dir)) return false
  const env: SyncEnvelope = { schema: 1, category: cat, updatedAt, deviceId: ensureDeviceId(), hash, data }
  const file = path.join(dir, selfFileName(cat))
  try {
    fs.writeFileSync(file, JSON.stringify(env), 'utf-8')
    return true
  } catch (err) {
    log.warn('cloud-sync: write envelope failed', { cat, err: String(err) })
    return false
  }
}

// ── Status broadcast ──
// Progress of the in-flight reconcile (null when idle). Broadcast so the
// first-run setup dialog can show a real progress bar.
let syncProgress: SyncProgress | null = null

function setProgress(progress: SyncProgress | null): void {
  syncProgress = progress
  broadcastStatus()
}

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
    progress: syncProgress,
  }
}

export function getSyncInfo(): SyncInfo {
  return buildInfo()
}

function broadcastStatus(): void {
  const info = buildInfo()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('cloud-sync:status', info)
    } catch (err) {
      // A window closing mid-broadcast; the others still get it.
      log.warn('cloud-sync: status broadcast failed', { windowId: win.id, err: String(err) })
    }
  }
}

function setRuntimeState(state: SyncState, error: string | null = null): void {
  runtimeState = state
  runtimeError = error
  broadcastStatus()
}

function advanceSyncGeneration(): number {
  syncGeneration += 1
  return syncGeneration
}

function isRunCurrent(generation: number): boolean {
  return generation === syncGeneration
}

// ── Category registration (wired from ipc.ts) ──
export function registerSyncCategory(cat: SyncCategory, adapter: SyncAdapter): void {
  adapters.set(cat, adapter)
}

function isActive(cat: SyncCategory): boolean {
  const cfg = getConfig()
  return cfg.enabled && !!cfg.categories[cat] && adapters.has(cat) && !!cfg.folderPath
}

function clearPushTimers(): void {
  for (const timer of pushTimers.values()) clearTimeout(timer)
  pushTimers.clear()
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
  if (seen && seen.hash === h && selfFileExists(cat)) return // nothing new (or echo of an applied payload)
  const updatedAt = Date.now()
  const dir = syncDir()
  if (writeEnvelopeSelf(cat, dir, data, h, updatedAt)) {
    setSeen(cat, h, updatedAt)
    touchLastSync()
    // Collapse to a single copy: drop older versions and any iCloud fork of a
    // previous write, keeping just the canonical we just wrote.
    void pruneOwnFiles(cat, selfFileName(cat), dir).catch((err: unknown) => {
      log.warn('cloud-sync: pruning own copies failed', { cat, err: String(err) })
    })
    log.info('cloud-sync: pushed', { cat })
  }
}

// ── Pull (folder → local) ──
/** Hashes of remote copies a merge category has already folded in (this
 *  run) — merging is idempotent, this just skips the work. */
const mergedHashes = new Map<SyncCategory, Set<string>>()

async function mergeCategory(
  cat: SyncCategory,
  adapter: SyncAdapter,
  envs: SyncEnvelope[],
  deviceId: string,
  generation: number,
): Promise<void> {
  const merged = mergedHashes.get(cat) ?? new Set<string>()
  mergedHashes.set(cat, merged)
  const others = envs
    .filter((env) => env.deviceId !== deviceId && !merged.has(env.hash))
    .sort((a, b) => a.updatedAt - b.updatedAt)
  if (others.length === 0) return
  applying = true
  try {
    for (const env of others) {
      if (!isRunCurrent(generation) || !isActive(cat)) return
      await adapter.write(env.data)
      merged.add(env.hash)
      log.info('cloud-sync: merged', { cat, from: env.deviceId })
    }
  } catch (err) {
    log.warn('cloud-sync: merge failed', { cat, err: String(err) })
  } finally {
    applying = false
  }
  touchLastSync()
  // Publish ours when the merge changed it (no-op when it didn't).
  pushIfChanged(cat)
}

async function pullCategory(cat: SyncCategory, generation = syncGeneration): Promise<void> {
  if (!isRunCurrent(generation) || !isActive(cat)) return
  const adapter = adapters.get(cat)!
  log.info('cloud-sync: pulling', { cat })
  const deviceId = ensureDeviceId()

  // Newest-wins across every OTHER device's file (and the legacy single file).
  // Our own file is authoritative for us, so it never overwrites local state.
  const envs = await listEnvelopes(cat)
  if (!isRunCurrent(generation) || !isActive(cat)) return
  if (adapter.merge) {
    await mergeCategory(cat, adapter, envs, deviceId, generation)
    return
  }
  let winner: SyncEnvelope | null = null
  for (const env of envs) {
    if (env.deviceId === deviceId) continue
    if (!winner || env.updatedAt > winner.updatedAt) winner = env
  }
  if (!winner) return

  let localData: unknown
  try { localData = adapter.read() } catch (err) { log.warn('cloud-sync: read failed', { cat, err: String(err) }); return }
  if (!isRunCurrent(generation) || !isActive(cat)) return
  const localHash = hashOf(localData)

  // Already identical to what we have locally — just record the mark.
  if (winner.hash === localHash) {
    setSeen(cat, winner.hash, winner.updatedAt)
    return
  }
  // Content differs: last-write-wins by updatedAt. Don't clobber a local edit
  // that's newer than the remote copy (it'll get pushed instead).
  const localUpdatedAt = lastSeen.get(cat)?.updatedAt ?? 0
  if (winner.updatedAt <= localUpdatedAt) return

  applying = true
  try {
    if (!isRunCurrent(generation) || !isActive(cat)) return
    await adapter.write(winner.data)
    if (!isRunCurrent(generation) || !isActive(cat)) return
    // Claim we're at the winner's state. For pass-through categories the next
    // local read hashes identically so no echo push fires; settings normalize
    // on save, which converges in at most one extra round (normalization is
    // idempotent).
    setSeen(cat, winner.hash, winner.updatedAt)
    touchLastSync()
    log.info('cloud-sync: adopted', { cat, from: winner.deviceId })
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
  if (!armWatcher()) scheduleWatcherRearm()
}

/** Watch the sync folder; false when it can't. Only events naming an envelope
 *  pull — the folder may also hold the user's files and the OS's
 *  (.DS_Store), whose churn would otherwise re-read every envelope each time.
 *  An event without a name (some platforms) pulls too. */
function armWatcher(): boolean {
  const dir = syncDir()
  if (!isUsableDir(dir)) return false
  let w: fs.FSWatcher
  try {
    w = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (watcher !== w) return
      if (filename && !parseEnvelopeName(filename)) {
        // A deleted folder reports under its own name, so a foreign name is
        // also the moment to check the folder is still there.
        if (!fs.existsSync(dir)) {
          log.warn('cloud-sync: sync folder disappeared', { dir })
          scheduleWatcherRearm()
        }
        return
      }
      if (watchDebounce) clearTimeout(watchDebounce)
      watchDebounce = setTimeout(() => {
        watchDebounce = null
        void pullAll()
      }, WATCH_DEBOUNCE_MS)
    })
  } catch (err) {
    log.warn('cloud-sync: watch failed', { dir, err: String(err) })
    return false
  }
  // Without a listener, an 'error' (Windows' EPERM when the watched folder is
  // deleted, say) is thrown as an uncaught exception. Node has closed the
  // watcher by then; watch again once the folder is back.
  w.on('error', (err) => {
    log.warn('cloud-sync: watcher error', { dir, err: String(err) })
    if (watcher === w) scheduleWatcherRearm()
  })
  watcher = w
  watchRearmDelay = WATCH_REARM_FIRST_MS
  log.info('cloud-sync: watching', dir)
  return true
}

/** Drop the current watcher and try again later, backing off, until the folder
 *  is there to watch. A pull follows, for whatever changed while unwatched.
 *  The folder isn't created here: a push recreates it when there's news. */
function scheduleWatcherRearm(): void {
  closeWatcher()
  if (watchRearm) return
  const delay = Math.max(watchRearmDelay, WATCH_REARM_FIRST_MS)
  watchRearmDelay = Math.min(delay * 2, WATCH_REARM_MAX_MS)
  watchRearm = setTimeout(() => {
    watchRearm = null
    const cfg = getConfig()
    if (!cfg.enabled || !cfg.folderPath) return
    if (fs.existsSync(cfg.folderPath) && armWatcher()) {
      void pullAll()
      return
    }
    scheduleWatcherRearm()
  }, delay)
}

function stopWatcher(): void {
  if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = null }
  if (watchRearm) { clearTimeout(watchRearm); watchRearm = null }
  watchRearmDelay = WATCH_REARM_FIRST_MS
  closeWatcher()
}

function closeWatcher(): void {
  const w = watcher
  if (!w) return
  watcher = null
  try {
    w.close()
  } catch (err) {
    log.warn('cloud-sync: closing the watcher failed', { err: String(err) })
  }
}

async function pullAll(): Promise<void> {
  const cfg = getConfig()
  if (!cfg.enabled) return
  const generation = syncGeneration
  for (const cat of SYNC_CATEGORIES) {
    if (!isRunCurrent(generation)) return
    if (cfg.categories[cat]) await pullCategory(cat, generation)
  }
  if (isRunCurrent(generation)) broadcastStatus()
}

// ── Public sync operations ──
/** Pull each enabled category (adopting newer remote copies), then push any
 *  local-newer / missing ones. */
export async function syncNow(): Promise<SyncInfo> {
  const cfg = getConfig()
  if (!cfg.enabled || !cfg.folderPath) return buildInfo()
  const generation = syncGeneration
  const active = SYNC_CATEGORIES.filter((cat) => cfg.categories[cat])
  setRuntimeState('syncing')
  setProgress({ done: 0, total: active.length })
  log.info('cloud-sync: sync starting', { total: active.length, folder: cfg.folderPath })
  try {
    let done = 0
    for (const cat of active) {
      if (!isRunCurrent(generation)) break
      await pullCategory(cat, generation)
      if (!isRunCurrent(generation)) break
      pushIfChanged(cat)
      await cleanupSupersededFiles(cat, generation)
      if (!isRunCurrent(generation)) break
      done += 1
      setProgress({ done, total: active.length })
    }
    if (isRunCurrent(generation) && getConfig().enabled && getConfig().folderPath) {
      setConfig({ lastSync: Date.now() })
      setRuntimeState('idle')
      log.info('cloud-sync: sync complete', { total: active.length })
    } else {
      log.info('cloud-sync: sync abandoned after setup changed')
    }
  } catch (err) {
    if (isRunCurrent(generation)) {
      setRuntimeState('error', String(err))
      log.warn('cloud-sync: sync failed', { err: String(err) })
    } else {
      log.info('cloud-sync: ignored stale sync failure', { err: String(err) })
    }
  } finally {
    if (isRunCurrent(generation)) setProgress(null)
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

/** Restart setup on this device without deleting local browser data or the
 *  chosen cloud folder. We deliberately keep deviceId stable so this install's
 *  old per-device files remain "ours", and preserve lastSeen so an older cloud
 *  copy cannot clobber newer local data when setup starts again. */
export function restartCloudSyncSetup(): SyncInfo {
  advanceSyncGeneration()
  clearPushTimers()
  stopWatcher()
  syncProgress = null
  setupPromptClaimed = false
  setConfig({
    enabled: false,
    folderPath: '',
    lastSync: 0,
    promptDismissed: false,
  })
  setRuntimeState('disabled')
  log.info('cloud-sync: setup restarted')
  return buildInfo()
}

/** Load persisted lastSeen marks, run an initial reconcile, and start watching.
 *  Must run after all categories are registered and before the first windows
 *  open (so restored windows reflect synced state). */
export async function initCloudSync(): Promise<void> {
  ensureDeviceId()
  const generation = syncGeneration
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
    if (!isRunCurrent(generation) || !getConfig().enabled || !getConfig().folderPath) return
    startWatcher()
    setRuntimeState('idle')
  } catch (err) {
    if (isRunCurrent(generation)) setRuntimeState('error', String(err))
  }
}

// ── Choosing a folder ──
// Files an OS or a cloud client drops into folders by itself. They don't make
// a folder "already in use".
const FOLDER_CLUTTER = new Set(['.DS_Store', '.localized', 'Icon\r', 'desktop.ini', 'Thumbs.db'])

type FolderRefusal = 'drive' | 'home' | 'appData'

const REFUSAL_DETAIL: Record<FolderRefusal, string> = {
  drive: 'That’s the top of a drive.',
  home: 'That’s your home folder, or a folder that holds it.',
  appData: 'Vimperium keeps its own data there.',
}

function comparablePath(p: string): string {
  const resolved = path.resolve(p)
  // macOS and Windows file systems ignore case unless set up otherwise.
  return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** Why a folder can't be the sync folder, or null when it can. The sync files
 *  go straight into it, so a drive's top, the home folder (and what holds it)
 *  and Vimperium's own data folder (and what's in it or holds it) are refused
 *  outright. */
function syncFolderRefusal(dir: string): FolderRefusal | null {
  const p = comparablePath(dir)
  if (path.parse(p).root === p) return 'drive'
  // macOS mounts other disks at /Volumes/<name>.
  if (process.platform === 'darwin' && path.dirname(p) === '/volumes') return 'drive'
  const home = comparablePath(app.getPath('home'))
  const userData = comparablePath(app.getPath('userData'))
  if (isSameOrInside(p, userData)) return 'appData'
  if (isSameOrInside(home, p)) return 'home'
  if (isSameOrInside(userData, p)) return 'appData'
  return null
}

/** The folder with symlinks resolved, so a link can't sneak home or a drive
 *  past syncFolderRefusal. A folder that doesn't exist yet stays as it is. */
async function realFolderPath(dir: string): Promise<string> {
  try {
    return await fs.promises.realpath(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('cloud-sync: cannot resolve folder', { dir, err: String(err) })
    }
    return dir
  }
}

/** Named like one of our files: an envelope, iCloud's stand-in for one it
 *  hasn't downloaded (".<name>.icloud", older macOS), or a temp file left by
 *  Newbro's old write-then-rename. */
function looksLikeSyncFile(name: string): boolean {
  if (parseEnvelopeName(name)) return true
  const evicted = /^\.(.+)\.icloud$/.exec(name)
  if (evicted && parseEnvelopeName(evicted[1])) return true
  const temp = /^(.+\.json)\.tmp-[^\\/]*$/.exec(name)
  return !!temp && !!parseEnvelopeName(temp[1])
}

interface FolderSurvey {
  /** Our files: envelopes of any device. */
  syncFiles: number
  /** Everything else, OS clutter aside. */
  others: number
  /** Envelopes in a LEGACY_SYNC_SUBDIR inside it — looked for only when the
   *  folder has none of its own. */
  legacySyncFiles: number
}

async function countEntries(dir: string): Promise<{ names: string[]; syncFiles: number; others: number }> {
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch (err) {
    // A folder that doesn't exist yet is as empty as they come.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { names: [], syncFiles: 0, others: 0 }
    throw err
  }
  let syncFiles = 0
  let others = 0
  for (const name of names) {
    if (FOLDER_CLUTTER.has(name)) continue
    if (looksLikeSyncFile(name)) syncFiles += 1
    else others += 1
  }
  return { names, syncFiles, others }
}

async function surveyFolder(dir: string): Promise<FolderSurvey> {
  const top = await countEntries(dir)
  let legacySyncFiles = 0
  if (top.syncFiles === 0 && top.names.includes(LEGACY_SYNC_SUBDIR)) {
    try {
      legacySyncFiles = (await countEntries(path.join(dir, LEGACY_SYNC_SUBDIR))).syncFiles
    } catch (err) {
      log.warn('cloud-sync: cannot look into the legacy sync folder', { dir, err: String(err) })
    }
  }
  return { syncFiles: top.syncFiles, others: top.others, legacySyncFiles }
}

async function ask(win: BrowserWindow | null, options: MessageBoxOptions): Promise<number> {
  const full: MessageBoxOptions = { noLink: true, ...options }
  const { response } = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, full)
    : await dialog.showMessageBox(full)
  return response
}

async function tell(win: BrowserWindow | null, message: string, detail: string): Promise<void> {
  await ask(win, { type: 'warning', message, detail, buttons: ['OK'] })
}

// How deep "a folder of its own" may nest when every candidate is taken
// already — only a folder tree built to loop gets this far.
const MAX_FOLDER_NESTING = 8

/** Turn the folder the user pointed at into the folder to sync into, asking
 *  where that's called for, and create it. A drive's top, the home folder and
 *  Vimperium's data are refused outright. A folder that has no sync files but
 *  holds Newbro's LEGACY_SYNC_SUBDIR with some is offered as that subfolder,
 *  shared with devices still on Newbro. A folder that holds other things gets
 *  the choice of a SYNC_FOLDER_NAME folder inside it (the default) or itself
 *  as it is. Null when the user backed out, or it can't be used (they're
 *  told why). */
async function settleSyncFolder(win: BrowserWindow | null, picked: string, depth = 0): Promise<string | null> {
  const dir = path.resolve(picked)
  const refusal = syncFolderRefusal(dir) ?? syncFolderRefusal(await realFolderPath(dir))
  if (refusal) {
    log.warn('cloud-sync: refused sync folder', { dir, refusal })
    await tell(
      win,
      'Vimperium can’t sync into this folder',
      `${REFUSAL_DETAIL[refusal]} Choose or create a folder inside OneDrive, Dropbox, Google Drive or iCloud Drive.`,
    )
    return null
  }
  let survey: FolderSurvey
  try {
    survey = await surveyFolder(dir)
  } catch (err) {
    log.warn('cloud-sync: cannot read the chosen folder', { dir, err: String(err) })
    await tell(win, 'Vimperium can’t open this folder', String((err as Error)?.message ?? err))
    return null
  }
  if (survey.syncFiles > 0) return createSyncFolder(win, dir)

  if (survey.legacySyncFiles > 0) {
    const choice = await ask(win, {
      type: 'question',
      message: `Use the “${LEGACY_SYNC_SUBDIR}” folder in it?`,
      detail: 'It holds the synced data of devices still on Newbro. Syncing into it keeps this device in step with them.',
      buttons: [`Use “${LEGACY_SYNC_SUBDIR}”`, 'Don’t use it', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    })
    log.info('cloud-sync: legacy sync folder offered', { dir, choice })
    if (choice === 2) return null
    if (choice === 0) return createSyncFolder(win, path.join(dir, LEGACY_SYNC_SUBDIR))
  }

  if (survey.others > 0) {
    const choice = await ask(win, {
      type: 'question',
      message: `This folder already has ${survey.others} ${survey.others === 1 ? 'item' : 'items'} in it`,
      detail: 'Vimperium keeps its sync files straight in the sync folder. It only ever reads, writes and removes '
        + 'files named like “settings.<device-id>.json”, but a folder of its own keeps them apart.',
      buttons: [`Create “${SYNC_FOLDER_NAME}” in it`, 'Use this folder', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    })
    log.info('cloud-sync: busy sync folder confirmed', { dir, others: survey.others, choice })
    if (choice === 2) return null
    if (choice === 0) {
      if (depth >= MAX_FOLDER_NESTING) {
        log.warn('cloud-sync: gave up nesting sync folders', { dir })
        return null
      }
      return settleSyncFolder(win, path.join(dir, SYNC_FOLDER_NAME), depth + 1)
    }
  }
  return createSyncFolder(win, dir)
}

async function createSyncFolder(win: BrowserWindow | null, dir: string): Promise<string | null> {
  try {
    await fs.promises.mkdir(dir, { recursive: true })
    return dir
  } catch (err) {
    log.warn('cloud-sync: cannot create sync folder', { dir, err: String(err) })
    await tell(win, 'Couldn’t create the sync folder', String((err as Error)?.message ?? err))
    return null
  }
}

function pickInfo(picked: boolean): FolderPickInfo {
  return { ...buildInfo(), picked }
}

// ── IPC ──
export function registerCloudSyncIpc(): void {
  ipcMain.handle('cloud-sync:get-info', () => buildInfo())

  // The native picker, then settleSyncFolder's checks and questions.
  ipcMain.handle('cloud-sync:set-folder', async (e): Promise<FolderPickInfo> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const current = getConfig().folderPath
    const options: OpenDialogOptions = {
      title: 'Choose sync folder',
      message: 'Pick a folder inside OneDrive, Dropbox, Google Drive or iCloud Drive. Vimperium keeps its sync files straight in it.',
      properties: ['openDirectory', 'createDirectory'],
      ...(current ? { defaultPath: current } : {}),
    }
    const result = win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return pickInfo(false)
    const folderPath = await settleSyncFolder(win, result.filePaths[0])
    if (!folderPath) return pickInfo(false)
    log.info('cloud-sync: sync folder chosen', { folderPath })
    advanceSyncGeneration()
    clearPushTimers()
    // The old folder's watcher must not pull into the new setup.
    stopWatcher()
    setConfig({ folderPath })
    if (getConfig().enabled) {
      await syncNow()
      if (getConfig().enabled && getConfig().folderPath) startWatcher()
    }
    broadcastStatus()
    return pickInfo(true)
  })

  ipcMain.handle('cloud-sync:set-enabled', async (_e, enabled: boolean) => {
    advanceSyncGeneration()
    if (enabled) {
      if (!getConfig().folderPath) return buildInfo() // can't enable without a folder
      // Turning sync on resolves the first-run offer for this device.
      setConfig({ enabled: true, promptDismissed: true })
      await initCloudSync()
    } else {
      setConfig({ enabled: false })
      clearPushTimers()
      stopWatcher()
      syncProgress = null
      setRuntimeState('disabled')
    }
    return buildInfo()
  })

  ipcMain.handle('cloud-sync:set-categories', async (_e, patch: Partial<Record<SyncCategory, boolean>>) => {
    const cfg = getConfig()
    const categories = { ...cfg.categories, ...patch }
    if (cfg.enabled && cfg.folderPath) advanceSyncGeneration()
    setConfig({ categories })
    // Newly-enabled categories should reconcile right away.
    if (cfg.enabled && cfg.folderPath) await syncNow()
    broadcastStatus()
    return buildInfo()
  })

  ipcMain.handle('cloud-sync:now', async () => {
    return syncNow()
  })

  ipcMain.handle('cloud-sync:restart-setup', () => {
    return restartCloudSyncSetup()
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

  // Enable sync into a specific folder (the suggested one — see
  // suggestedSyncFolder) without the native picker. The same checks as a
  // picked folder; creates it if it doesn't exist yet.
  ipcMain.handle('cloud-sync:setup-with-folder', async (e, requested: unknown): Promise<FolderPickInfo> => {
    if (typeof requested !== 'string' || !path.isAbsolute(requested)) {
      log.warn('cloud-sync: setup-with-folder without a usable folder', { requested })
      return pickInfo(false)
    }
    log.info('cloud-sync: setup-with-folder', { folderPath: requested })
    const folderPath = await settleSyncFolder(BrowserWindow.fromWebContents(e.sender), requested)
    if (!folderPath) return pickInfo(false)
    advanceSyncGeneration()
    clearPushTimers()
    stopWatcher()
    setConfig({ folderPath, enabled: true, promptDismissed: true })
    await initCloudSync()
    broadcastStatus()
    return pickInfo(true)
  })
}
