// Newbro → Vimperium: the first launch under the new name brings the user's
// data over from the old app. Once.
//
// Electron keeps everything under `<appData>/<app name>`, so renaming the app
// would otherwise start it on an empty profile while the real one (tabs,
// passwords, passkeys, extensions, history, every site's sign-in) sits next
// to it under the old name. So before anything opens userData we rename the
// old folder to the new one — one atomic rename on the same disk, never a
// copy, so there is no half-copied state to recover from — and then fix up
// the few things inside it that carry the old name:
//
//   - the app's own files, newbro-*.json / newbro-history.db (+ -wal, -shm) /
//     newbro.log, become vimperium-*: every electron-store, the history
//     database and the log are opened by name;
//   - the extensions store keeps each extension's folder as an absolute path,
//     and the manager drops an entry whose manifest.json isn't there, so every
//     path under the old folder is rewritten to the new one (a .bak first);
//   - so is each Bookshelf reading's offline copy (bookshelf.ts also finds
//     one by its file name, so a path left behind still opens);
//   - on macOS the key that encrypts saved passwords, passkeys and corporate
//     credentials lives in the login keychain under the app's name ("Newbro
//     Safe Storage"). Electron would make a new random one for "Vimperium",
//     and nothing saved before could be decrypted, so the secret is copied to
//     the new name before anything uses safeStorage. Windows keeps that key
//     DPAPI-wrapped in userData's Local State, which moves with the folder.
//     Until the copy lands (macOS asked and nobody allowed it), the stores
//     that use safeStorage stay off (vaultKeyMissingReason) and, once ready,
//     the user is told and offered another try (handleLegacyKeychainMissing).
//
// The old app's keychain item is never deleted, and nothing is left behind or
// removed at the old location: an old Newbro started later finds an empty
// folder and a fresh profile, and the marker in the new folder keeps this from
// running again.
//
// It has to run before anything resolves userData: branding.ts calls it right
// after deciding APP_NAME, before app.setName, before the first electron-store
// is constructed and before ./log is imported (log.ts fixes its file path at
// import). That is also why this module never imports ./log: it buffers its
// lines, and index.ts writes them into the log once the log session starts.
//
// Every step can be re-run: a marker written into the old folder just before
// the rename travels with it ("moving"), so a launch that dies half way
// through the fix-ups finishes them on the next launch, and only the final
// marker ("done") ends it. Files are renamed only when the new name is free,
// and JSON is written to a temp file and renamed over the old one.
//
// It refuses to move a folder a running Newbro still has open — on macOS the
// rename would succeed under the live process, which would go on writing into
// the moved profile. Starting on an empty profile instead would look like
// data loss, so that launch runs on a throwaway profile and, once ready, only
// asks the user to quit Newbro (index.ts → handleRenameMigrationBlocked).
//
// The core (runRenameMigration) gets the file system, the running-app check,
// the keychain and the clock injected, so it runs under plain Node against a
// fake appData tree; migrateFromNewbro is the thin Electron wrapper.

import { app, dialog } from 'electron'
import * as nodeFs from 'fs'
import { spawnSync } from 'child_process'
import { hostname, tmpdir } from 'os'
import { basename, join } from 'path'

// ── Names on disk ──

/** The marker in the new userData folder: { state: 'moving' | 'done', … }. */
export const MIGRATION_MARKER_FILE = 'vimperium-migration.json'

/** The prefix the old app's own files carry in userData (newbro-state.json,
 *  newbro-history.db, newbro.log, …). Kept so the first Vimperium launch can
 *  find and rename them. */
export const LEGACY_FILE_PREFIX = 'newbro'
const NEW_FILE_PREFIX = 'vimperium'
const LEGACY_FILE_RE = new RegExp(`^${LEGACY_FILE_PREFIX}(?=[-.])`)

/** SQLite keeps a database's journal next to it under the database's name plus
 *  a suffix; such a file may only move together with its database. */
const SQLITE_SIDECAR_RE = /^(.+)-(wal|shm|journal)$/

/** The tabs-and-workspaces store, written by every run that got as far as a
 *  window: its presence in the new folder means real Vimperium data. */
const STATE_FILE = 'vimperium-state.json'
/** The old app's name for the same store: a folder holding it under the new
 *  name but without a marker is one moved by hand or a migration that lost
 *  its marker. */
export const LEGACY_STATE_FILE = 'newbro-state.json'
/** Every profile's session (cookies, site storage) lives under Partitions. */
const PARTITIONS_DIR = 'Partitions'

/** The extensions store (src/main/extensions/manager.ts), holding absolute
 *  paths to each extension's folder. */
const EXTENSIONS_STORE_FILE = 'vimperium-extensions.json'
/** The Bookshelf's store (src/main/bookshelf.ts): a reading saved for offline
 *  use keeps the absolute path of its copy, userData/bookshelf/<id>.mhtml,
 *  under this key. */
const BOOKSHELF_STORE_FILE = 'vimperium-bookshelf.json'
const BOOKSHELF_PATH_KEY = 'offlinePath'
/** Each extension folder keeps the publisher's untouched manifest under this
 *  name (manager.ts ORIGINAL_MANIFEST_FILE); Newbro wrote it under the
 *  LEGACY_ name. The manager renames it too when it first reads it; doing it
 *  here, with the rest of the move, saves it the lookup. Its own copy of the
 *  name rather than an import from extensions/legacy-names.ts: nothing this
 *  module imports may ever pull in ./log. */
const ORIGINAL_MANIFEST_FILE = 'vimperium-original-manifest.json'
const LEGACY_ORIGINAL_MANIFEST_FILE = 'newbro-original-manifest.json'

/** Chromium's per-run files: the process-singleton lock (a symlink to
 *  `<host>-<pid>` on macOS and Linux, plus its cookie and socket; `lockfile`
 *  on Windows) and the DevTools port. A moved profile's copies are the old
 *  app's, from a run that has ended. */
const STALE_RUN_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'DevToolsActivePort']

/** A launch that has to wait for Newbro to quit runs on a throwaway profile
 *  under the system temp folder, named with this prefix and cleared by a
 *  later launch. */
const WAIT_PROFILE_PREFIX = 'vimperium-migration-wait-'

/** A user who keeps denying the keychain prompt is asked this many times in
 *  all (one launch each), then left alone. */
const MAX_KEYCHAIN_ATTEMPTS = 3

/** How long a keychain prompt may wait for the user before the launch goes on
 *  without the key (and tries again on the next one). */
const KEYCHAIN_PROMPT_TIMEOUT_MS = 180_000

/** Windows refuses to rename a folder while any process has a file in it open
 *  (an indexer, an antivirus scan, a just-exited app's last handle), so a
 *  rename there gets a few more tries before it counts as failed. */
const WINDOWS_RENAME_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000]
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

// ── Types ──

export type KeychainState =
  /** The old secret is in the new item. */
  | 'copied'
  /** The old app never had a key: nothing to copy. */
  | 'none'
  /** Not macOS, or the orchestrator's test mode. */
  | 'skipped'
  /** The copy failed (the user denied the prompt, it timed out, …); the next
   *  launch tries again. */
  | 'pending'
  /** Failed MAX_KEYCHAIN_ATTEMPTS times; no more prompts on their own, only
   *  when the user asks for another try (requestKeychainRetry). */
  | 'failed'

export interface MigrationMarker {
  version: 1
  state: 'moving' | 'done'
  /** The folder the data came from (its absolute paths are rewritten from it). */
  from: string
  to: string
  startedAt?: string
  at?: string
  appVersion?: string
  /** Where a new folder that held no real data was moved before the rename. */
  movedAside?: string
  keychain?: KeychainState
  keychainAttempts?: number
  keychainError?: string
  renamed?: string[]
  extensionPathsRewritten?: number
  /** Only when there were any. */
  bookshelfPathsRewritten?: number
}

export interface RunningCheck {
  running: boolean
  detail: string
}

/** The macOS keychain, by service and account. */
export interface KeychainOps {
  /** Whether the item exists; reads attributes only, so it never prompts.
   *  Throws when it can't tell. */
  has(service: string, account: string): boolean
  /** The item's secret. macOS asks the user to allow it. Throws on denial,
   *  timeout or any other failure. */
  read(service: string, account: string): string
  /** Adds the item; with `overwrite`, replaces an existing one. Throws on
   *  failure. */
  add(service: string, account: string, secret: string, opts: { overwrite: boolean }): void
}

/** The node:fs calls the migration makes; tests wrap these to fail on cue. */
export type MigrationFs = Pick<
  typeof nodeFs,
  'lstatSync' | 'readdirSync' | 'renameSync' | 'readFileSync' | 'writeFileSync' | 'unlinkSync'
>

export type MigrationLogLevel = 'info' | 'warn' | 'error'

export interface MigrationDeps {
  appData: string
  /** The old app's name: 'Newbro', or 'Newbro Dev' for a dev build. */
  legacyName: string
  /** APP_NAME: 'Vimperium', 'Vimperium Dev' or 'Vimperium Test'. */
  newName: string
  platform: NodeJS.Platform
  fs: MigrationFs
  /** Whether an app holds the profile in `dir` (its process-singleton lock). */
  isAppRunning(dir: string): RunningCheck
  /** null skips the keychain copy, for `keychainSkipReason`. */
  keychain: KeychainOps | null
  keychainSkipReason?: string
  now(): Date
  sleep(ms: number): void
  appVersion: string
  log(level: MigrationLogLevel, msg: string): void
}

export type BlockedReason =
  /** The old app still has its folder open. */
  | 'old-app-running'
  /** The rename itself failed; the old folder is untouched. */
  | 'move-failed'
  /** Moved, but a fix-up inside the new folder failed. */
  | 'fixup-failed'
  /** Something the migration didn't expect (a bug). */
  | 'error'

export type MigrationResult =
  /** Nothing to move: no old folder (a fresh install). */
  | { kind: 'fresh' }
  /** Moved on an earlier launch. */
  | { kind: 'already'; keychain?: KeychainState }
  /** The new folder already holds Vimperium's own data; the old one is left
   *  where it is, never merged in. */
  | { kind: 'skipped'; reason: string }
  /** This launch moved the data (or finished moving it). */
  | { kind: 'migrated'; resumed: boolean; keychain: KeychainState }
  /** Couldn't move now; this launch must not use either folder. */
  | { kind: 'blocked'; reason: BlockedReason; detail: string }

class FixupError extends Error {}

// ── Core ──

/** The whole migration, synchronously. Never throws for a failure it
 *  expects: those come back as a result, with the reason in the log. */
export function runRenameMigration(d: MigrationDeps): MigrationResult {
  // A pass returns 'again' when a folder appeared or vanished under it, which
  // only another launch migrating at the same moment does; the next pass sees
  // what that one did.
  for (let pass = 0; pass < 3; pass++) {
    const result = migrationPass(d)
    if (result !== 'again') return result
    d.log('info', 'the folders changed during the move (another launch at the same time?), looking again')
  }
  return blocked(d, 'move-failed', 'the folders kept changing while Vimperium was moving them')
}

function migrationPass(d: MigrationDeps): MigrationResult | 'again' {
  const oldDir = join(d.appData, d.legacyName)
  const newDir = join(d.appData, d.newName)
  const marker = readMarker(d, join(newDir, MIGRATION_MARKER_FILE))

  if (marker?.state === 'done') {
    const keychain = marker.keychain === 'pending' ? retryKeychain(d, newDir, marker) : marker.keychain
    return { kind: 'already', keychain }
  }

  const newEntry = entry(d, newDir)
  const halfMoved =
    newEntry &&
    (marker?.state === 'moving' ||
      (exists(d, join(newDir, LEGACY_STATE_FILE)) && !exists(d, join(newDir, STATE_FILE))))
  if (halfMoved) {
    // A launch that died between the rename and the final marker, or a folder
    // renamed by hand: finish the fix-ups. Unless a Vimperium is running on
    // it — then that launch got past this point already, and this one is a
    // second instance about to hand over to it.
    const running = d.isAppRunning(newDir)
    if (running.running) {
      d.log('info', `${newDir} is in use (${running.detail}); leaving the unfinished move to that instance`)
      return { kind: 'already' }
    }
    const from = typeof marker?.from === 'string' && marker.from ? marker.from : oldDir
    d.log('info', `finishing the move from ${from} into ${newDir}`)
    return finishMigration(d, { from, to: newDir, resumed: true, marker: marker ?? undefined })
  }

  const oldEntry = entry(d, oldDir)
  if (!oldEntry) return { kind: 'fresh' }
  if (!oldEntry.isDirectory() && !oldEntry.isSymbolicLink()) {
    d.log('warn', `${oldDir} is not a folder; nothing to move`)
    return { kind: 'fresh' }
  }

  if (newEntry && hasRealData(d, newDir)) {
    const reason = `${newDir} already holds Vimperium data, so ${oldDir} stays where it is (never merged)`
    d.log('warn', reason)
    return { kind: 'skipped', reason }
  }

  const running = d.isAppRunning(oldDir)
  if (running.running) {
    return blocked(d, 'old-app-running', `${d.legacyName} is running (${running.detail})`)
  }

  // A rename only works within one disk. Both folders sit in appData, so this
  // only trips when the old folder is a mount point.
  const parent = entry(d, d.appData)
  if (parent && oldEntry.dev !== parent.dev) {
    return blocked(d, 'move-failed', `${oldDir} is on a different disk from ${d.appData}, so it can't be moved in one step`)
  }

  // A new folder without real data (an aborted run, a stray crash dump) would
  // stop the rename. Move it aside rather than delete it.
  let movedAside: string | undefined
  if (newEntry) {
    movedAside = `${newDir}.pre-migration-${stamp(d.now())}`
    try {
      renameWithRetry(d, newDir, movedAside)
    } catch (err) {
      if (errCode(err) === 'ENOENT') return 'again'
      return blocked(d, 'move-failed', `couldn't move the existing ${newDir} aside: ${errText(err)}`)
    }
    d.log('info', `moved ${newDir}, which held no Vimperium data, aside to ${movedAside}`)
  }

  const startMarker: MigrationMarker = {
    version: 1,
    state: 'moving',
    from: oldDir,
    to: newDir,
    startedAt: d.now().toISOString(),
    appVersion: d.appVersion,
    ...(movedAside ? { movedAside } : {}),
  }
  const oldMarkerFile = join(oldDir, MIGRATION_MARKER_FILE)
  try {
    writeJsonAtomic(d, oldMarkerFile, startMarker)
  } catch (err) {
    if (errCode(err) === 'ENOENT') return 'again'
    return blocked(d, 'move-failed', `couldn't write to ${oldDir}: ${errText(err)}`)
  }

  // The commit point.
  try {
    renameWithRetry(d, oldDir, newDir)
  } catch (err) {
    removeOwnFile(d, oldMarkerFile)
    const code = errCode(err)
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') return 'again'
    return blocked(d, 'move-failed', `couldn't move ${oldDir} to ${newDir}: ${errText(err)}`)
  }
  d.log('info', `moved ${oldDir} to ${newDir}`)
  return finishMigration(d, { from: oldDir, to: newDir, resumed: false, marker: startMarker })
}

function finishMigration(
  d: MigrationDeps,
  ctx: { from: string; to: string; resumed: boolean; marker?: MigrationMarker },
): MigrationResult {
  const { from, to } = ctx
  let renamed: string[]
  let rewritten: number
  try {
    dropOwnTempFiles(d, to)
    dropStaleRunFiles(d, to)
    renamed = renameLegacyFiles(d, to)
    rewritten = rewriteExtensionPaths(d, to, from)
  } catch (err) {
    // A store left under its old name would start empty and then be written
    // under the new one, hiding the old data for good; an extension path left
    // pointing at the old folder gets its entry dropped. Neither may happen,
    // so this launch waits rather than run on a half-fixed profile. The
    // marker still says "moving": the next launch tries again.
    return blocked(d, 'fixup-failed', errText(err))
  }
  renameOriginalManifests(d, to)
  const shelfRewritten = rewriteBookshelfPaths(d, to, from)

  const keychain = copyKeychain(d, ctx.marker)
  const base: MigrationMarker = {
    ...(ctx.marker ?? {}),
    version: 1,
    state: 'moving',
    from,
    to,
    appVersion: d.appVersion,
  }
  if (keychain.state === 'copied' && ctx.marker?.keychain !== 'copied') {
    // Recorded at once, so a launch that dies before the final marker doesn't
    // copy (and prompt) again.
    try {
      writeJsonAtomic(d, join(to, MIGRATION_MARKER_FILE), { ...base, keychain: 'copied', keychainAttempts: keychain.attempts })
    } catch (err) {
      d.log('warn', `couldn't record the keychain copy: ${errText(err)}`)
    }
  }

  const done: MigrationMarker = {
    ...base,
    state: 'done',
    at: d.now().toISOString(),
    keychain: keychain.state,
    keychainAttempts: keychain.attempts,
    renamed: [...new Set([...(ctx.marker?.renamed ?? []), ...renamed])],
    extensionPathsRewritten: (ctx.marker?.extensionPathsRewritten ?? 0) + rewritten,
  }
  const shelfTotal = (ctx.marker?.bookshelfPathsRewritten ?? 0) + shelfRewritten
  if (shelfTotal) done.bookshelfPathsRewritten = shelfTotal
  if (keychain.error) done.keychainError = keychain.error
  else delete done.keychainError
  try {
    writeJsonAtomic(d, join(to, MIGRATION_MARKER_FILE), done)
  } catch (err) {
    // Everything above is done and safe to repeat; the next launch repeats it.
    d.log('error', `couldn't write the migration marker (the next launch finishes the move again): ${errText(err)}`)
  }
  d.log(
    'info',
    `done: ${renamed.length} files renamed, ${rewritten} extension paths and ${shelfRewritten} offline reading paths ` +
      `rewritten, keychain ${keychain.state}`,
  )
  return { kind: 'migrated', resumed: ctx.resumed, keychain: keychain.state }
}

/** True when the folder holds data a Vimperium run made: its tabs store, or
 *  any profile's session. */
function hasRealData(d: MigrationDeps, dir: string): boolean {
  return exists(d, join(dir, STATE_FILE)) || exists(d, join(dir, PARTITIONS_DIR))
}

/** Temp files of a launch that died between writing one and renaming it into
 *  place (the old folder's marker travels here with the rename). */
function dropOwnTempFiles(d: MigrationDeps, dir: string): void {
  for (const name of d.fs.readdirSync(dir)) {
    if (name.endsWith(TEMP_SUFFIX)) removeOwnFile(d, join(dir, name))
  }
}

function dropStaleRunFiles(d: MigrationDeps, dir: string): void {
  for (const name of STALE_RUN_FILES) {
    const file = join(dir, name)
    if (!exists(d, file)) continue
    try {
      d.fs.unlinkSync(file)
      d.log('info', `removed the old run's ${name}`)
    } catch (err) {
      // Chromium copes with a stale lock of its own; this is tidying.
      if (errCode(err) !== 'ENOENT') d.log('warn', `couldn't remove ${file}: ${errText(err)}`)
    }
  }
}

/** newbro-* / newbro.log → vimperium-*, each only when the new name is free.
 *  Returns the old names it renamed. Throws FixupError when a rename fails. */
function renameLegacyFiles(d: MigrationDeps, dir: string): string[] {
  const legacy = d.fs.readdirSync(dir).filter((name) => LEGACY_FILE_RE.test(name))
  // Databases before their journals: a journal moves only once its database
  // has, so it never ends up beside a different database.
  const ordered = [
    ...legacy.filter((name) => !SQLITE_SIDECAR_RE.test(name)),
    ...legacy.filter((name) => SQLITE_SIDECAR_RE.test(name)),
  ]
  const renamed: string[] = []
  for (const name of ordered) {
    const target = name.replace(LEGACY_FILE_RE, NEW_FILE_PREFIX)
    const sidecar = SQLITE_SIDECAR_RE.exec(name)
    if (sidecar && exists(d, join(dir, sidecar[1]))) {
      d.log('warn', `kept ${name}: its database ${sidecar[1]} kept its old name`)
      continue
    }
    if (exists(d, join(dir, target))) {
      d.log('warn', `kept ${name}: ${target} is already there`)
      continue
    }
    try {
      renameWithRetry(d, join(dir, name), join(dir, target))
      renamed.push(name)
    } catch (err) {
      if (errCode(err) === 'ENOENT') continue // renamed by a launch running beside this one
      throw new FixupError(`couldn't rename ${join(dir, name)} to ${target}: ${errText(err)}`)
    }
  }
  if (renamed.length) d.log('info', `renamed ${renamed.join(', ')}`)
  return renamed
}

/** Rewrites every absolute path under `from` in the extensions store to the
 *  same path under `to`. Returns how many it rewrote. Throws FixupError when
 *  the store can't be read or written. */
function rewriteExtensionPaths(d: MigrationDeps, to: string, from: string): number {
  return rewriteStorePaths(d, join(to, EXTENSIONS_STORE_FILE), from, to, 'extension paths')
}

/** The same for the Bookshelf's offline copies. Not a reason to hold the
 *  launch back: bookshelf.ts finds a copy by its file name under userData, so
 *  one whose path still names the old folder opens all the same. */
function rewriteBookshelfPaths(d: MigrationDeps, to: string, from: string): number {
  try {
    return rewriteStorePaths(d, join(to, BOOKSHELF_STORE_FILE), from, to, 'offline reading paths', BOOKSHELF_PATH_KEY)
  } catch (err) {
    d.log('warn', `${errText(err)} (the Bookshelf finds its offline copies by name, so they still open)`)
    return 0
  }
}

/** Rewrites the absolute paths under `from` in one JSON store to the same
 *  paths under `to` — every string, or with `onlyKey` only the strings under
 *  that key — keeping the untouched original as <file>.bak. Returns how many
 *  it rewrote. Throws FixupError when the store can't be read or written. */
function rewriteStorePaths(
  d: MigrationDeps,
  file: string,
  from: string,
  to: string,
  what: string,
  onlyKey?: string,
): number {
  if (!exists(d, file)) return 0
  let text: string
  try {
    text = d.fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new FixupError(`couldn't read ${file}: ${errText(err)}`)
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    // Already broken before the move; there are no paths in it to trust.
    d.log('error', `${file} isn't valid JSON, left as it is: ${errText(err)}`)
    return 0
  }
  const win = d.platform === 'win32'
  let count = 0
  const walk = (value: unknown, key: string | null): unknown => {
    if (typeof value === 'string') {
      if (onlyKey !== undefined && key !== onlyKey) return value
      const moved = rebasePath(value, from, to, win)
      if (moved === null) return value
      count++
      return moved
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, null))
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      for (const k of Object.keys(obj)) obj[k] = walk(obj[k], k)
    }
    return value
  }
  const next = walk(data, null)
  if (!count) return 0
  const backup = `${file}.bak`
  try {
    // The first backup is the untouched original; a re-run keeps it.
    if (!exists(d, backup)) writeFileAtomic(d, backup, text)
    // Tab-indented, as electron-store writes it.
    writeJsonAtomic(d, file, next, '\t')
  } catch (err) {
    throw new FixupError(`couldn't rewrite the ${what} in ${file}: ${errText(err)}`)
  }
  d.log('info', `rewrote ${count} ${what} from ${from} to ${to} (original kept as ${basename(backup)})`)
  return count
}

/** `p` re-based from `from` onto `to`, or null when it isn't under `from`.
 *  Windows paths compare without case and with either slash. */
export function rebasePath(p: string, from: string, to: string, win: boolean): string | null {
  const root = from.replace(/[\\/]+$/, '')
  if (p.length < root.length) return null
  const norm = (s: string): string => (win ? s.replace(/\//g, '\\').toLowerCase() : s)
  if (norm(p.slice(0, root.length)) !== norm(root)) return null
  const rest = p.slice(root.length)
  if (rest && !(rest[0] === '/' || (win && rest[0] === '\\'))) return null // a sibling like "Newbro Dev"
  return to + rest
}

function renameOriginalManifests(d: MigrationDeps, dir: string): void {
  const file = join(dir, EXTENSIONS_STORE_FILE)
  if (!exists(d, file)) return
  let extensions: Record<string, { path?: unknown }>
  try {
    const parsed = JSON.parse(d.fs.readFileSync(file, 'utf8')) as { extensions?: Record<string, { path?: unknown }> }
    extensions = parsed.extensions ?? {}
  } catch (err) {
    d.log('warn', `couldn't read ${file} for the original manifests: ${errText(err)}`)
    return
  }
  let count = 0
  for (const ext of Object.values(extensions)) {
    if (!ext || typeof ext.path !== 'string') continue
    const legacy = join(ext.path, LEGACY_ORIGINAL_MANIFEST_FILE)
    const target = join(ext.path, ORIGINAL_MANIFEST_FILE)
    if (!exists(d, legacy) || exists(d, target)) continue
    try {
      d.fs.renameSync(legacy, target)
      count++
    } catch (err) {
      // The manager downloads the package again for it; nothing is lost.
      if (errCode(err) !== 'ENOENT') d.log('warn', `couldn't rename ${legacy}: ${errText(err)}`)
    }
  }
  if (count) d.log('info', `renamed ${count} extensions' ${LEGACY_ORIGINAL_MANIFEST_FILE} to ${ORIGINAL_MANIFEST_FILE}`)
}

// ── Keychain ──

interface KeychainOutcome {
  state: KeychainState
  attempts: number
  error?: string
}

/** Electron's names for its safeStorage key: `<app name> Safe Storage` /
 *  `<app name> Key`. */
function keychainItem(appName: string): { service: string; account: string } {
  return { service: `${appName} Safe Storage`, account: `${appName} Key` }
}

function copyKeychain(d: MigrationDeps, prev?: MigrationMarker): KeychainOutcome {
  const prevAttempts = prev?.keychainAttempts ?? 0
  if (!d.keychain) {
    d.log('info', `keychain: not copied (${d.keychainSkipReason ?? 'not macOS'})`)
    return { state: 'skipped', attempts: prevAttempts }
  }
  const oldItem = keychainItem(d.legacyName)
  const newItem = keychainItem(d.newName)
  const attempts = prevAttempts + 1
  try {
    if (!d.keychain.has(oldItem.service, oldItem.account)) {
      d.log('info', `keychain: no "${oldItem.service}" item, nothing to copy`)
      return { state: 'none', attempts: prevAttempts }
    }
    const newPresent = d.keychain.has(newItem.service, newItem.account)
    if (newPresent && prev?.keychain === 'copied') return { state: 'copied', attempts: prevAttempts }
    if (newPresent) {
      // Electron made its own random key under the new name on a launch that
      // ran without the copy (the user denied the prompt) — or this launch's
      // copy landed and its record didn't. Nothing in the moved data can be
      // decrypted with a random key, while everything saved before the move
      // needs the old one, so the old one wins.
      d.log('warn', `keychain: "${newItem.service}" exists already; replacing it with the key from "${oldItem.service}"`)
    }
    d.log('info', `keychain: copying "${oldItem.service}" to "${newItem.service}" (macOS asks to allow it)`)
    const secret = d.keychain.read(oldItem.service, oldItem.account)
    d.keychain.add(newItem.service, newItem.account, secret, { overwrite: newPresent })
    if (!d.keychain.has(newItem.service, newItem.account)) {
      throw new Error(`"${newItem.service}" isn't in the keychain after adding it`)
    }
    d.log('info', `keychain: copied`)
    return { state: 'copied', attempts }
  } catch (err) {
    const state: KeychainState = attempts >= MAX_KEYCHAIN_ATTEMPTS ? 'failed' : 'pending'
    d.log(
      'warn',
      `keychain: copy failed (attempt ${attempts} of ${MAX_KEYCHAIN_ATTEMPTS}), ` +
        `${state === 'pending' ? 'trying again on the next launch' : 'giving up'}: ${errText(err)}`,
    )
    return { state, attempts, error: errText(err) }
  }
}

function retryKeychain(d: MigrationDeps, newDir: string, marker: MigrationMarker): KeychainState {
  // A second instance on its way to hand over to the running one shouldn't
  // pop a prompt.
  const running = d.isAppRunning(newDir)
  if (running.running) return 'pending'
  const kc = copyKeychain(d, marker)
  const next: MigrationMarker = { ...marker, keychain: kc.state, keychainAttempts: kc.attempts }
  if (kc.error) next.keychainError = kc.error
  else delete next.keychainError
  try {
    writeJsonAtomic(d, join(newDir, MIGRATION_MARKER_FILE), next)
  } catch (err) {
    d.log('error', `couldn't update the migration marker after the keychain retry: ${errText(err)}`)
  }
  return kc.state
}

/**
 * The user asked for another try at the keychain copy (Try again in
 * handleLegacyKeychainMissing): the next launch copies the key — also when
 * the tries had run out ('failed'), which is why the count starts over.
 * Returns false when there's nothing to try again or the marker couldn't be
 * written (logged).
 */
export function requestKeychainRetry(d: MigrationDeps, newDir: string): boolean {
  const file = join(newDir, MIGRATION_MARKER_FILE)
  const marker = readMarker(d, file)
  if (!marker) {
    d.log('warn', `keychain: no migration marker in ${newDir}, nothing to try again`)
    return false
  }
  // An unfinished move copies the key when the next launch finishes it.
  if (marker.state === 'moving') return true
  if (marker.keychain !== 'pending' && marker.keychain !== 'failed') {
    d.log('info', `keychain: ${marker.keychain ?? 'no state'}, nothing to try again`)
    return false
  }
  const next: MigrationMarker = { ...marker, keychain: 'pending', keychainAttempts: 0 }
  try {
    writeJsonAtomic(d, file, next)
  } catch (err) {
    d.log('error', `keychain: couldn't record the request to try again: ${errText(err)}`)
    return false
  }
  d.log('info', `keychain: the user asked to try again (was ${marker.keychain}); the next launch copies the key`)
  return true
}

// ── Helpers ──

function blocked(d: MigrationDeps, reason: BlockedReason, detail: string): MigrationResult {
  d.log(reason === 'old-app-running' ? 'warn' : 'error', `not moved now (${reason}): ${detail}`)
  return { kind: 'blocked', reason, detail }
}

function entry(d: MigrationDeps, p: string): nodeFs.Stats | undefined {
  try {
    return d.fs.lstatSync(p, { throwIfNoEntry: false })
  } catch (err) {
    // A path through a file (the new "folder" is a stray file) doesn't exist.
    if (errCode(err) === 'ENOTDIR') return undefined
    throw err
  }
}

/** lstat, not existsSync: a stale SingletonLock is a dangling symlink. */
function exists(d: MigrationDeps, p: string): boolean {
  return entry(d, p) !== undefined
}

function readMarker(d: MigrationDeps, file: string): MigrationMarker | null {
  if (!exists(d, file)) return null
  try {
    const parsed = JSON.parse(d.fs.readFileSync(file, 'utf8')) as MigrationMarker
    if (parsed && (parsed.state === 'moving' || parsed.state === 'done')) return parsed
    d.log('warn', `${file} has no state, ignoring it`)
  } catch (err) {
    d.log('warn', `couldn't read ${file}, ignoring it: ${errText(err)}`)
  }
  return null
}

const TEMP_SUFFIX = '.tmp-migration'

function writeJsonAtomic(d: MigrationDeps, file: string, value: unknown, indent: string | number = 2): void {
  writeFileAtomic(d, file, JSON.stringify(value, null, indent))
}

/** Written beside `file` and renamed over it, so a launch that dies half way
 *  leaves the old content (and a temp file the next run removes). */
function writeFileAtomic(d: MigrationDeps, file: string, text: string): void {
  const tmp = `${file}${TEMP_SUFFIX}`
  d.fs.writeFileSync(tmp, text)
  try {
    renameWithRetry(d, tmp, file)
  } catch (err) {
    removeOwnFile(d, tmp)
    throw err
  }
}

function removeOwnFile(d: MigrationDeps, file: string): void {
  try {
    d.fs.unlinkSync(file)
  } catch (err) {
    if (errCode(err) !== 'ENOENT') d.log('warn', `couldn't remove ${file}: ${errText(err)}`)
  }
}

function renameWithRetry(d: MigrationDeps, from: string, to: string): void {
  const delays = d.platform === 'win32' ? WINDOWS_RENAME_RETRY_DELAYS_MS : []
  for (let attempt = 0; ; attempt++) {
    try {
      d.fs.renameSync(from, to)
      return
    } catch (err) {
      const code = errCode(err)
      if (attempt >= delays.length || !RETRYABLE_RENAME_CODES.has(code)) throw err
      d.log('info', `renaming ${from} failed with ${code}, trying again in ${delays[attempt]} ms`)
      d.sleep(delays[attempt])
    }
  }
}

function stamp(date: Date): string {
  // 2026-11-08T12:30:05.123Z → 20261108-123005 (no colons: Windows forbids them).
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? ''
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Running-app check (real) ──

/** What the browser on a profile runs as, for isAppRunningIn. */
export interface AppIdentity {
  /** The packaged app's executable names ('Newbro', 'Vimperium'), matched
   *  against the last part of the path `ps` names the process by. */
  names: readonly string[]
  /** Whole executable paths that count too: `npm run dev`'s Electron, which
   *  is this launch's own process.execPath. */
  paths?: readonly string[]
}

/** The packaged apps, old and new. Never a bare "Electron": other apps ship
 *  under that name too (MongoDB Compass's is …/Contents/MacOS/Electron). */
const PACKAGED_APPS: AppIdentity = { names: ['Newbro', 'Vimperium'] }

/** This launch's own idea of the browser: the packaged apps, or the very
 *  Electron binary it runs on (a dev run). */
function ownAppIdentity(): AppIdentity {
  return { names: PACKAGED_APPS.names, paths: [process.execPath] }
}

/**
 * Whether a Chromium-based app holds the profile in `dir`, judged by its
 * process-singleton lock (see runwa-palette.ts isRunning, which this extends).
 *
 * Windows: `lockfile` is held open without sharing while the app runs and is
 * deleted when it quits; one we can open is left over from a crash. Elsewhere:
 * `SingletonLock` is a symlink to `<host>-<pid>`. A dead pid is a stale lock;
 * a live one is checked against the process list, since the pid of an app
 * that quit long ago may belong to something else by now: it counts when the
 * process is the app itself (`identity`), or when its helpers run on this very
 * profile (Chromium hands each one --user-data-dir), which also catches a dev
 * run from another checkout. The host is only reported: macOS's host name
 * follows the network, so a mismatch doesn't make a live browser on this
 * machine any less live.
 *
 * Meant for before this launch takes a lock of its own: a lock that names
 * this very process is left over from an earlier one that had the same pid.
 */
export function isAppRunningIn(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  identity: AppIdentity = PACKAGED_APPS,
): RunningCheck {
  if (platform === 'win32') {
    const lockfile = join(dir, 'lockfile')
    if (!nodeFs.existsSync(lockfile)) return { running: false, detail: 'no lockfile' }
    try {
      nodeFs.closeSync(nodeFs.openSync(lockfile, 'r+'))
      return { running: false, detail: 'stale lockfile' }
    } catch (err) {
      const code = errCode(err)
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        return { running: true, detail: `its lockfile is held (${code})` }
      }
      return { running: false, detail: `lockfile unreadable (${errText(err)})` }
    }
  }
  let target: string
  try {
    target = nodeFs.readlinkSync(join(dir, 'SingletonLock'))
  } catch (err) {
    return { running: false, detail: errCode(err) === 'ENOENT' ? 'no SingletonLock' : `SingletonLock unreadable (${errText(err)})` }
  }
  const match = /^(.*)-(\d+)$/.exec(target)
  if (!match) return { running: false, detail: `SingletonLock points at "${target}"` }
  const host = match[1]
  const pid = Number(match[2])
  const ownHost = hostname()
  const hostNote = host === ownHost ? '' : `, locked on host "${host}" (this is "${ownHost}")`
  if (pid === process.pid) return { running: false, detail: `the lock names this process (pid ${pid}), so it is left over${hostNote}` }
  try {
    process.kill(pid, 0)
  } catch (err) {
    if (errCode(err) !== 'EPERM') return { running: false, detail: `pid ${pid} is gone${hostNote}` }
  }
  const comm = processCommand(pid)
  if (comm === 'gone') return { running: false, detail: `pid ${pid} is gone${hostNote}` }
  if (comm === null) return { running: true, detail: `pid ${pid} is alive${hostNote}` }
  if (isAppExecutable(comm, identity)) return { running: true, detail: `pid ${pid} (${comm})${hostNote}` }
  const helpers = helpersUseProfile(pid, dir)
  if (helpers === true) return { running: true, detail: `pid ${pid} (${comm}) runs helpers on ${dir}${hostNote}` }
  const unsure = helpers === null ? `, and its helpers couldn't be listed` : ''
  return { running: false, detail: `pid ${pid} now belongs to ${comm}${unsure}${hostNote}` }
}

function isAppExecutable(comm: string, identity: AppIdentity): boolean {
  const name = basename(comm).toLowerCase()
  const full = comm.toLowerCase()
  return (
    identity.names.some((n) => n.toLowerCase() === name) ||
    (identity.paths ?? []).some((p) => p.toLowerCase() === full)
  )
}

/** `ps` with its text as UTF-8: under the C locale it escapes every
 *  non-ASCII byte of a path (Cyrillic folder names, say). */
const PS_ENV = { ...process.env, LC_ALL: 'en_US.UTF-8' }

/** The executable `ps` names for a pid, 'gone' when there's no such process,
 *  or null when `ps` couldn't tell. */
function processCommand(pid: number): string | 'gone' | null {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000, env: PS_ENV })
  if (r.error) return null
  const out = (r.stdout ?? '').trim()
  if (r.status === 0 && out) return out
  if (r.status === 1 && !out) return 'gone'
  return null
}

/** Whether a child of `pid` runs with --user-data-dir=`dir`, as every
 *  Chromium helper (GPU, network, renderer) of a browser on that profile
 *  does; null when `ps` couldn't tell. */
function helpersUseProfile(pid: number, dir: string): boolean | null {
  const r = spawnSync('ps', ['-axww', '-o', 'ppid=,args='], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024 * 1024,
    env: PS_ENV,
  })
  if (r.error || r.status !== 0) return null
  return psListsHelperOn(String(r.stdout ?? ''), pid, dir)
}

/** Over `ps -o ppid=,args=` output: whether a child of `pid` has
 *  --user-data-dir=`dir`. */
export function psListsHelperOn(psOutput: string, pid: number, dir: string): boolean {
  const flag = `--user-data-dir=${dir}`
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m || Number(m[1]) !== pid) continue
    const args = m[2].trimEnd()
    for (let at = args.indexOf(flag); at >= 0; at = args.indexOf(flag, at + 1)) {
      // ps joins the arguments with spaces, unquoted, and the folder has
      // spaces in it ("Application Support"): the value ends where the line
      // does or the next switch starts, so "…/Newbro" isn't "…/Newbro Dev".
      const rest = args.slice(at + flag.length)
      if (rest === '' || rest.startsWith(' --')) return true
    }
  }
  return false
}

/** pids of this user's processes named exactly `name`, or [] (pgrep). */
function userProcessesNamed(name: string): number[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const args = uid === null ? ['-x', name] : ['-x', '-U', String(uid), name]
  const r = spawnSync('/usr/bin/pgrep', args, { encoding: 'utf8', timeout: 5000 })
  if (r.error || r.status !== 0) return []
  return (r.stdout ?? '')
    .split(/\s+/)
    .map(Number)
    .filter((pid) => pid > 0 && pid !== process.pid)
}

// ── Keychain (real) ──

const SECURITY = '/usr/bin/security'

/** A secret `security -i` can take inside double quotes. Electron's keys are
 *  base64. */
const QUOTABLE_RE = /^[^"\\\r\n]*$/

/**
 * The login keychain through /usr/bin/security. `trustedApp` goes on the new
 * item's access list (-T), so the app that owns the key reads it.
 *
 * Reading the old secret makes macOS ask once ("security wants to use your
 * confidential information stored in 'Newbro Safe Storage'"). The new item is
 * added through `security -i` fed on stdin, so the secret never shows up in a
 * process list. The first time the app itself reads an item `security` made,
 * macOS may ask once more.
 */
export function createMacKeychainOps(trustedApp: string, promptTimeoutMs = KEYCHAIN_PROMPT_TIMEOUT_MS): KeychainOps {
  const quote = (s: string, what: string): string => {
    if (!QUOTABLE_RE.test(s)) throw new Error(`the ${what} has characters security -i can't take`)
    return `"${s}"`
  }
  const failure = (what: string, r: ReturnType<typeof spawnSync>, secret?: string): Error => {
    if (r.error) return new Error(`${what}: ${errText(r.error)}`)
    let stderr = String(r.stderr ?? '').trim()
    if (secret) stderr = stderr.split(secret).join('<secret>')
    const how = r.signal ? `was stopped (${r.signal}, no answer in time?)` : `exited with ${r.status}`
    return new Error(`${what} ${how}${stderr ? `: ${stderr}` : ''}`)
  }
  return {
    has(service, account) {
      const r = spawnSync(SECURITY, ['find-generic-password', '-s', service, '-a', account], {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
        timeout: 15_000,
      })
      if (!r.error && r.status === 0) return true
      if (!r.error && r.status === 44) return false // errSecItemNotFound
      throw failure('security find-generic-password', r)
    },
    read(service, account) {
      const r = spawnSync(SECURITY, ['find-generic-password', '-w', '-s', service, '-a', account], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: promptTimeoutMs,
      })
      if (r.error || r.status !== 0) throw failure('security find-generic-password -w', r)
      const secret = String(r.stdout ?? '').replace(/\r?\n$/, '')
      if (!secret) throw new Error(`"${service}" has an empty secret`)
      return secret
    },
    add(service, account, secret, { overwrite }) {
      const line =
        `add-generic-password ${overwrite ? '-U ' : ''}-s ${quote(service, 'service name')} ` +
        `-a ${quote(account, 'account name')} -T ${quote(trustedApp, 'app path')} -w ${quote(secret, 'key')}\n`
      const r = spawnSync(SECURITY, ['-i'], {
        input: line,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: promptTimeoutMs,
      })
      if (r.error || r.status !== 0) throw failure('security add-generic-password', r, secret)
    },
  }
}

/** The .app bundle around the running executable (Electron.app in a dev run),
 *  or the executable itself when it isn't in one. */
function runningAppBundle(): string {
  const exe = process.execPath
  const at = exe.lastIndexOf('.app/Contents/MacOS/')
  return at >= 0 ? exe.slice(0, at + '.app'.length) : exe
}

// ── Electron wrapper ──

export interface RenameMigrationOutcome {
  result: MigrationResult
  /** True when this launch moved Newbro's data (or finished moving it). */
  migratedNow: boolean
  testMode: boolean
  legacyName: string
  newName: string
  from: string
  to: string
  /** The throwaway profile a blocked launch runs on. */
  waitingProfile?: string
}

let outcome: RenameMigrationOutcome | null = null
/** The deps this launch migrated with, for the keychain retry once ready. */
let launchDeps: MigrationDeps | null = null
const pendingLines: Array<{ level: MigrationLogLevel; msg: string }> = []

function note(level: MigrationLogLevel, msg: string): void {
  pendingLines.push({ level, msg })
}

/** What the migration did this launch (before it runs: nothing to move). */
export function getRenameMigrationOutcome(): RenameMigrationOutcome {
  return (
    outcome ?? {
      result: { kind: 'fresh' },
      migratedNow: false,
      testMode: false,
      legacyName: '',
      newName: '',
      from: '',
      to: '',
    }
  )
}

function keychainStateOf(result: MigrationResult): KeychainState | undefined {
  return result.kind === 'migrated' || result.kind === 'already' ? result.keychain : undefined
}

/**
 * Why saved passwords, passkeys and sign-ins can't be used this launch, or
 * null when they can. On macOS the key they're encrypted with is still only in
 * "Newbro Safe Storage" while the keychain copy is 'pending' or 'failed'.
 * Until it lands the stores must neither decrypt nor encrypt — nor touch
 * safeStorage at all: its first use makes up a random "Vimperium Safe
 * Storage" key, nothing moved over can be read with it, and whatever were
 * encrypted with it would be lost when the copy replaces it.
 */
export function vaultKeyMissingReason(): string | null {
  return vaultKeyMissingReasonFor(getRenameMigrationOutcome())
}

/** vaultKeyMissingReason for a given outcome. */
export function vaultKeyMissingReasonFor(o: RenameMigrationOutcome): string | null {
  const state = keychainStateOf(o.result)
  if (state !== 'pending' && state !== 'failed') return null
  return (
    `${o.newName} can't use saved passwords, passkeys or sign-ins yet: it still needs the key ${o.legacyName} ` +
    `saved them with, “${keychainItem(o.legacyName).service}” in your keychain. Restart ${o.newName} to try again, ` +
    `and allow access when macOS asks.`
  )
}

/**
 * Runs the migration for this launch. branding.ts calls it once, before
 * app.setName and before anything reads userData.
 *
 * `testMode` (the orchestrator's VIMPERIUM_TEST_APPDATA, dev builds only):
 * appData has been pointed at a scratch folder, the new name is "Vimperium
 * Test" and the old one "Newbro Dev" inside that folder, and the keychain is
 * left alone — so a test run never touches the user's real folders or their
 * real keychain items.
 */
export function migrateFromNewbro(opts: { appName: string; legacyName: string; testMode: boolean }): void {
  const appData = app.getPath('appData')
  const from = join(appData, opts.legacyName)
  const to = join(appData, opts.appName)
  const platform = process.platform
  // A packaged Newbro runs as "Newbro"; also look for one by name in case its
  // lock is gone. A dev run is a plain "Electron", found by its lock alone
  // (and its helpers' --user-data-dir).
  const legacyProcessName = platform === 'darwin' && opts.legacyName === 'Newbro' ? opts.legacyName : null

  let keychain: KeychainOps | null = null
  let keychainSkipReason: string | undefined
  if (platform !== 'darwin') keychainSkipReason = `${platform} keeps its key in Local State, which moved with the folder`
  else if (opts.testMode) keychainSkipReason = 'test mode leaves the keychain alone'
  else keychain = createMacKeychainOps(runningAppBundle())

  const deps: MigrationDeps = {
    appData,
    legacyName: opts.legacyName,
    newName: opts.appName,
    platform,
    fs: nodeFs,
    isAppRunning: (dir) => {
      const lock = isAppRunningIn(dir, platform, ownAppIdentity())
      if (lock.running || dir !== from || !legacyProcessName) return lock
      const pids = userProcessesNamed(legacyProcessName)
      return pids.length ? { running: true, detail: `${legacyProcessName} is running as pid ${pids.join(', ')}` } : lock
    },
    keychain,
    keychainSkipReason,
    now: () => new Date(),
    sleep: sleepSync,
    appVersion: app.getVersion(),
    log: note,
  }
  launchDeps = deps

  let result: MigrationResult
  try {
    result = runRenameMigration(deps)
  } catch (err) {
    // A bug, not a failure the core expects. Where the data stands is
    // unknown, so don't start on either folder; the marker lets the next
    // launch pick up from wherever this one stopped.
    note('error', `failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    result = { kind: 'blocked', reason: 'error', detail: errText(err) }
  }

  outcome = {
    result,
    migratedNow: result.kind === 'migrated',
    testMode: opts.testMode,
    legacyName: opts.legacyName,
    newName: opts.appName,
    from,
    to,
  }

  if (result.kind === 'blocked') {
    // Neither the old folder (still in use, or half moved) nor an empty new
    // one: a throwaway profile, for just the dialog that explains it.
    const waiting = nodeFs.mkdtempSync(join(tmpdir(), WAIT_PROFILE_PREFIX))
    app.setPath('userData', waiting)
    outcome.waitingProfile = waiting
    note('warn', `this launch runs on the throwaway profile ${waiting} and only shows why it can't go on`)
    return
  }

  if (opts.testMode) {
    // Pinned explicitly, so nothing can resolve userData to anywhere else.
    nodeFs.mkdirSync(to, { recursive: true })
    app.setPath('userData', to)
    app.setAppLogsPath(join(appData, 'logs'))
    note('info', `test mode: userData is ${to}`)
  }
  sweepWaitingProfiles()
}

/** Removes the throwaway profiles of earlier blocked launches that have quit. */
function sweepWaitingProfiles(): void {
  const root = tmpdir()
  let names: string[]
  try {
    names = nodeFs.readdirSync(root)
  } catch (err) {
    note('warn', `couldn't list ${root} for old waiting profiles: ${errText(err)}`)
    return
  }
  for (const name of names) {
    if (!name.startsWith(WAIT_PROFILE_PREFIX)) continue
    const dir = join(root, name)
    try {
      const st = nodeFs.lstatSync(dir)
      if (!st.isDirectory() || st.isSymbolicLink()) continue
      if (isAppRunningIn(dir, process.platform, ownAppIdentity()).running) continue
      nodeFs.rmSync(dir, { recursive: true, force: true })
      note('info', `removed the waiting profile ${dir}`)
    } catch (err) {
      note('warn', `couldn't remove the waiting profile ${dir}: ${errText(err)}`)
    }
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch (err) {
    note('warn', `Atomics.wait unavailable (${errText(err)}), spinning instead`)
    const until = Date.now() + ms
    while (Date.now() < until) {
      // spin: this runs before the app is ready, with nothing else to do
    }
  }
}

interface MigrationLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Writes the migration's buffered lines into the app log. index.ts calls it
 *  right after startLogSession(). */
export function flushRenameMigrationLog(logger: MigrationLogger): void {
  for (const { level, msg } of pendingLines.splice(0)) logger[level](`rename-migration: ${msg}`)
}

/** Whether this launch can start itself again. Not under `npm run dev`:
 *  electron-vite stops its dev server once its Electron exits, so a relaunched
 *  one would open on a dead renderer URL — a blank window (ipc.ts wipe-data
 *  skips its relaunch for the same reason). The developer runs it again. */
function canRelaunch(): boolean {
  return app.isPackaged
}

/**
 * When this launch couldn't move the data, asks the user to quit Newbro (or
 * says what went wrong) and ends the launch: Retry starts Vimperium again,
 * Quit just quits (in `npm run dev` only Quit, and the developer runs it
 * again). Returns true when it handled the launch, so the caller opens
 * nothing. index.ts calls it first thing in the ready handler.
 */
export async function handleRenameMigrationBlocked(logger: MigrationLogger): Promise<boolean> {
  const current = getRenameMigrationOutcome()
  const result = current.result
  if (result.kind !== 'blocked') return false
  const oldApp = current.legacyName
  const newApp = current.newName
  const relaunch = canRelaunch()
  const then = relaunch ? 'choose Retry' : 'choose Quit and run npm run dev again'
  const tryAgain = relaunch ? 'Choose Retry to try again.' : 'Choose Quit, then run npm run dev again to try again.'
  const copy =
    result.reason === 'old-app-running'
      ? {
          message: `Quit ${oldApp} to finish moving to ${newApp}`,
          detail:
            `${newApp} brings over your tabs, passwords, extensions and history from ${oldApp} ` +
            `the first time it starts, and ${oldApp} is still open. Quit ${oldApp}, then ${then}.`,
        }
      : result.reason === 'move-failed'
        ? {
            message: `${newApp} couldn't move your data from ${oldApp}`,
            detail: `${result.detail}\n\nYour data is untouched in ${current.from}. Close anything that may be using that folder, then ${then}.`,
          }
        : result.reason === 'fixup-failed'
          ? {
              message: `${newApp} couldn't finish moving your data from ${oldApp}`,
              detail: `${result.detail}\n\nYour data is in ${current.to}. ${tryAgain}`,
            }
          : {
              message: `${newApp} couldn't move your data from ${oldApp}`,
              detail: `${result.detail}\n\n${tryAgain}`,
            }
  const buttons = relaunch ? ['Retry', 'Quit'] : ['Quit']
  const quitId = buttons.indexOf('Quit')
  if (process.platform === 'darwin') app.focus({ steal: true })
  let response = quitId
  try {
    const answer = await dialog.showMessageBox({
      type: 'warning',
      buttons,
      defaultId: 0,
      cancelId: quitId,
      noLink: true,
      message: copy.message,
      detail: copy.detail,
    })
    response = answer.response
  } catch (err) {
    logger.error('rename-migration: the dialog failed, quitting', String(err))
  }
  if (relaunch && response === 0) {
    logger.info('rename-migration: Retry, relaunching')
    app.relaunch()
  } else {
    logger.info(`rename-migration: Quit${relaunch ? '' : ' (npm run dev: no relaunch, run it again)'}`)
  }
  app.exit(0)
  return true
}

/**
 * macOS, once ready: when the key the moved passwords are encrypted with is
 * still missing — macOS asked to let this app read "Newbro Safe Storage" and
 * nobody allowed it, so the copy is 'pending' or 'failed' — says so. Try
 * again asks for another copy, also after the automatic tries ran out, and
 * relaunches (in `npm run dev` it's Quit, and the developer runs it again);
 * Continue without saved passwords opens the app with saved passwords,
 * passkeys and sign-ins off for this launch (vaultKeyMissingReason keeps the
 * stores away from safeStorage). Returns true when it ended the launch.
 * index.ts calls it right after handleRenameMigrationBlocked.
 */
export async function handleLegacyKeychainMissing(logger: MigrationLogger): Promise<boolean> {
  const current = getRenameMigrationOutcome()
  const state = keychainStateOf(current.result)
  if (state !== 'pending' && state !== 'failed') return false
  const oldApp = current.legacyName
  const newApp = current.newName
  const item = keychainItem(oldApp).service
  const relaunch = canRelaunch()
  const buttons = [relaunch ? 'Try again' : 'Quit', 'Continue without saved passwords']
  const next = relaunch
    ? `Choose Try again, then allow access when macOS asks about “${item}”.`
    : `Choose Quit and run npm run dev again, then allow access when macOS asks about “${item}”.`
  if (process.platform === 'darwin') app.focus({ steal: true })
  let response = 1 // Continue
  try {
    const answer = await dialog.showMessageBox({
      type: 'warning',
      buttons,
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: `${newApp} couldn't get the key to your ${oldApp} passwords`,
      detail:
        `The passwords, passkeys and sign-ins you saved in ${oldApp} are encrypted with a key that macOS keeps ` +
        `in your keychain as “${item}”, and ${newApp} wasn't allowed to read it. Until it can, ${newApp} ` +
        `can't fill or save passwords, passkeys or sign-ins. Nothing you saved is lost.\n\n${next}`,
    })
    response = answer.response
  } catch (err) {
    logger.error('rename-migration: the keychain dialog failed, going on without saved passwords', String(err))
  }
  if (response !== 0) {
    logger.warn(`rename-migration: going on without saved passwords this launch (keychain ${state})`)
    return false
  }
  if (launchDeps) {
    const deps: MigrationDeps = { ...launchDeps, log: (level, msg) => logger[level](`rename-migration: ${msg}`) }
    requestKeychainRetry(deps, current.to)
  } else {
    logger.error('rename-migration: no migration deps for the keychain retry; the next launch may not try again')
  }
  if (relaunch) {
    logger.info('rename-migration: Try again, relaunching')
    app.relaunch()
  } else {
    logger.info('rename-migration: Quit (npm run dev: no relaunch, run it again)')
  }
  app.exit(0)
  return true
}
