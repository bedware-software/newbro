// Chrome Web Store extension manager.
//
// Responsibilities:
//   - Fetch a CRX by extension ID (see store.ts).
//   - Strip the CRX prefix and unzip to `userData/extensions/<id>/<version>`.
//   - Read manifest.json, register in a persistent registry.
//   - Register/deregister with every partitioned session configured by
//     main/index.ts setupPartitionSession.
//   - Keep track of enabled/disabled state, and surface a normalized list
//     to the renderer (Settings → Extensions tab).
//
// Constraints / non-goals:
//   - No auto-update. Users reinstall to upgrade — we're not Google and
//     can't verify silent updates, so pulling them down in the background
//     would be a supply-chain risk.
//   - No MV2 webRequestBlocking support — Electron 34 follows Chrome's
//     MV3 migration. Ad blockers that still require the MV2 blocking
//     webRequest API will register but won't block. We surface this in
//     the UI as a best-effort warning.

import { app, BrowserWindow, session, type Session } from 'electron'
import Store from 'electron-store'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log'
import { parseCrx, extractCrxPublicKey } from './crx'
import { fetchCrx, extractExtensionIdFromUrl as _extract, clearCrxFetchSession } from './store'
import { unzipTo } from './zip'

export interface ExtensionInfo {
  id: string
  name: string
  shortName?: string
  version: string
  description?: string
  enabled: boolean
  /** When false, the toolbar action icon is hidden but the extension is
   *  still loaded and active. Mirrors Chrome's "Pin to toolbar" behavior. */
  pinned: boolean
  path: string
  hostPermissions: string[]
  permissions: string[]
  hasOptionsPage: boolean
  /** When true, the renderer should render a toolbar action button for
   *  this extension. True iff the manifest declares `action` /
   *  `browser_action` / `page_action`. */
  hasAction: boolean
  actionDefaultTitle?: string
  /** data: URL with the manifest icon, or null if none. We embed the bytes
   *  rather than serving a chrome-extension:// URL because the renderer's
   *  session can't resolve those unless the extension declares the icon as
   *  a web_accessible_resource — which is rare. */
  iconUrl?: string | null
  installedAt: number
}

interface PersistedEntry {
  id: string
  name: string
  shortName?: string
  version: string
  description?: string
  enabled: boolean
  /** Optional in storage so legacy entries (pre-pin support) round-trip
   *  without TypeScript complaining. Always defaulted to `true` via
   *  normalizeEntry on the read path. */
  pinned?: boolean
  path: string
  hostPermissions: string[]
  permissions: string[]
  hasOptionsPage: boolean
  hasAction: boolean
  actionDefaultTitle?: string
  iconUrl?: string | null
  installedAt: number
}

const store = new Store<{ extensions: Record<string, PersistedEntry> }>({
  name: 'newbro-extensions',
  defaults: { extensions: {} },
})

export const extractExtensionIdFromUrl = _extract

function extensionsRoot(): string {
  return join(app.getPath('userData'), 'extensions')
}

function readManifest(extDir: string): Record<string, unknown> {
  const manifestPath = join(extDir, 'manifest.json')
  const text = readFileSync(manifestPath, 'utf8')
  // Chrome allows comments in manifest.json; strip them conservatively.
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  return JSON.parse(withoutComments)
}

/** Apply our two install-time manifest patches:
 *
 *  1. Inject the CRX's public key into `key` so Electron derives the same
 *     extension id Chrome Web Store assigned. Without this, `loadExtension`
 *     hashes the on-disk path and produces a different id — every
 *     `chrome-extension://<expected-id>/<resource>` URL we hand to Electron
 *     ends up pointing at a non-existent extension and gets thrown out by
 *     Chromium's navigation throttle as `ERR_BLOCKED_BY_CLIENT`.
 *
 *  2. Add the action popup AND the options page to `web_accessible_resources`.
 *     Real Chrome opens these through privileged internal flows that skip
 *     the throttle; Electron doesn't, so a plain top-level loadURL gets
 *     blocked unless the resource is declared web-accessible. The patch is
 *     limited to those two specific files, not the whole extension.
 *
 *  Idempotent: re-running on an already-patched manifest is a no-op.
 *  publicKey may be null (CRX2 fallback or unparseable header); we still
 *  apply patch #2 in that case. Returns true if anything was written. */
function patchManifest(extDir: string, publicKey: Buffer | null): boolean {
  const manifestPath = join(extDir, 'manifest.json')
  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch {
    return false
  }
  // Chrome allows comments in manifest.json; strip before parsing.
  const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(cleaned)
  } catch (err) {
    log.warn('extensions: failed to parse manifest for patching', String(err))
    return false
  }

  let modified = false

  // ── Patch 1: ensure `key` is set so the id is derived from the CRX
  //    public key, not the on-disk path.
  if (publicKey && typeof manifest.key !== 'string') {
    manifest.key = publicKey.toString('base64')
    modified = true
  }

  // ── Patch 2: gather paths that need to be web-accessible.
  const action = (manifest.action || manifest.browser_action || manifest.page_action) as
    | Record<string, unknown>
    | undefined
  const popup = action && typeof action.default_popup === 'string' ? (action.default_popup as string) : null
  const optionsPage =
    typeof manifest.options_page === 'string'
      ? (manifest.options_page as string)
      : (manifest.options_ui as Record<string, string> | undefined)?.page
  const wantPaths: string[] = []
  if (popup) wantPaths.push(popup.replace(/^\/+/, ''))
  if (optionsPage) wantPaths.push(optionsPage.replace(/^\/+/, ''))

  if (wantPaths.length > 0) {
    const isMv3 = manifest.manifest_version === 3
    if (isMv3) {
      // MV3: array of { resources: string[], matches: string[], … }
      const arr = Array.isArray(manifest.web_accessible_resources)
        ? (manifest.web_accessible_resources as Array<Record<string, unknown>>)
        : []
      const already = (path: string): boolean =>
        arr.some((entry) => {
          const resources = entry?.resources
          if (!Array.isArray(resources)) return false
          return (resources as string[]).some((r) => r === path || r === '*' || r === '/*')
        })
      const missing = wantPaths.filter((p) => !already(p))
      if (missing.length > 0) {
        arr.push({ resources: missing, matches: ['<all_urls>'] })
        manifest.web_accessible_resources = arr
        modified = true
      }
    } else {
      // MV2: array of strings.
      const arr = Array.isArray(manifest.web_accessible_resources)
        ? (manifest.web_accessible_resources as string[])
        : []
      const already = (path: string): boolean =>
        arr.includes(path) || arr.includes('*') || arr.includes('/*')
      const missing = wantPaths.filter((p) => !already(p))
      if (missing.length > 0) {
        for (const p of missing) arr.push(p)
        manifest.web_accessible_resources = arr
        modified = true
      }
    }
  }

  if (modified) {
    try {
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
      log.info('extensions: patched manifest', {
        path: extDir,
        injectedKey: !!publicKey && typeof manifest.key === 'string',
        accessiblePaths: wantPaths,
      })
    } catch (err) {
      log.warn('extensions: failed to write patched manifest', String(err))
      return false
    }
  }
  return modified
}

/** Pick the best icon path declared in the manifest. We prefer ≤48 (the
 *  toolbar slot is ≤32px on screen) and fall back to the largest available.
 *  Returns the path RELATIVE to the extension directory. */
function pickIconRelativePath(manifest: Record<string, unknown>): string | null {
  const icons = manifest.icons as Record<string, string> | undefined
  if (icons && typeof icons === 'object') {
    const sizes = Object.keys(icons)
      .map((k) => parseInt(k, 10))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a)
    const preferred = sizes.find((s) => s <= 48) ?? sizes[0]
    if (preferred && icons[String(preferred)]) return icons[String(preferred)]
  }
  const action = (manifest.action || manifest.browser_action || manifest.page_action) as
    | Record<string, unknown>
    | undefined
  if (action && typeof action.default_icon === 'string') return action.default_icon as string
  if (action && typeof action.default_icon === 'object' && action.default_icon !== null) {
    const di = action.default_icon as Record<string, string>
    const sizes = Object.keys(di).sort((a, b) => parseInt(b, 10) - parseInt(a, 10))
    if (sizes.length > 0) return di[sizes[0]]
  }
  return null
}

/** Resolve the manifest icon to a data: URL the renderer can use directly.
 *  We can't return chrome-extension://<id>/icon.png because the main
 *  renderer's session is forbidden from loading extension resources unless
 *  the extension declares them as web_accessible_resources — which most
 *  don't. Reading the file off disk and embedding it sidesteps that. */
function resolveIcon(manifest: Record<string, unknown>, extDir: string): string | null {
  const rel = pickIconRelativePath(manifest)
  if (!rel) return null
  const cleanRel = rel.replace(/^\/+/, '')
  // Block path-traversal escapes; manifest paths are extension-local only.
  if (cleanRel.includes('..')) return null
  const abs = join(extDir, cleanRel)
  try {
    if (!existsSync(abs)) return null
    const buf = readFileSync(abs)
    const ext = cleanRel.split('.').pop()?.toLowerCase() ?? ''
    const mime =
      ext === 'png' ? 'image/png'
      : ext === 'svg' ? 'image/svg+xml'
      : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : 'application/octet-stream'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

function derivePersistedEntry(
  id: string,
  extDir: string,
  enabled: boolean,
  installedAt: number,
  pinned: boolean = true
): PersistedEntry {
  const manifest = readManifest(extDir)
  const name = typeof manifest.name === 'string' ? (manifest.name as string) : id
  const shortName = typeof manifest.short_name === 'string' ? (manifest.short_name as string) : undefined
  const version = typeof manifest.version === 'string' ? (manifest.version as string) : '0.0.0'
  const description = typeof manifest.description === 'string' ? (manifest.description as string) : undefined
  const permissions = Array.isArray(manifest.permissions) ? (manifest.permissions as string[]) : []
  const hostPermissions = Array.isArray(manifest.host_permissions)
    ? (manifest.host_permissions as string[])
    : []
  const optionsPage =
    typeof manifest.options_page === 'string'
      ? (manifest.options_page as string)
      : (manifest.options_ui as Record<string, string> | undefined)?.page
  const action = (manifest.action || manifest.browser_action || manifest.page_action) as
    | Record<string, unknown>
    | undefined
  const hasAction = Boolean(action)
  const actionDefaultTitle =
    action && typeof action.default_title === 'string' ? (action.default_title as string) : undefined
  const iconUrl = resolveIcon(manifest, extDir)
  return {
    id,
    name,
    shortName,
    version,
    description,
    enabled,
    pinned,
    path: extDir,
    hostPermissions,
    permissions,
    hasOptionsPage: typeof optionsPage === 'string' && optionsPage.length > 0,
    hasAction,
    actionDefaultTitle,
    iconUrl,
    installedAt,
  }
}

function getAllSessions(): Session[] {
  // Include default + every partitioned session we've configured so far.
  // A freshly created partition will pick up its extensions via
  // setupPartitionSession → loadEnabledExtensionsInto.
  const sessions = new Set<Session>([session.defaultSession])
  // Inspect every live BrowserWindow / WebContents session as a
  // best-effort fallback — these always mirror configuredPartitions but
  // we don't want a circular import to pull that in.
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      sessions.add(win.webContents.session)
      for (const view of win.contentView.children) {
        const wc = (view as unknown as { webContents?: Electron.WebContents }).webContents
        if (wc && !wc.isDestroyed()) sessions.add(wc.session)
      }
    } catch {
      /* ignore */
    }
  }
  return Array.from(sessions)
}

async function loadExtensionInto(ses: Session, entry: PersistedEntry): Promise<void> {
  if (!entry.enabled) return
  if (!existsSync(join(entry.path, 'manifest.json'))) {
    log.warn('extensions: missing manifest on disk', entry.path)
    return
  }
  // Path-aware dedup: skip only when the SAME path is already registered.
  // After a CRX reinstall the new path differs from the stale registration,
  // and a plain "id matches → skip" would leave the session pointing at a
  // directory that no longer exists. Force a remove + reload in that case.
  let stale = false
  try {
    const existing = ses.getAllExtensions?.() ?? []
    const same = existing.find((e) => e.id === entry.id)
    if (same) {
      if (same.path === entry.path) return
      stale = true
    }
  } catch {
    /* ignore — getAllExtensions might not exist on older build */
  }
  if (stale) {
    try { ses.removeExtension(entry.id) } catch { /* not loaded */ }
  }
  try {
    await ses.loadExtension(entry.path, { allowFileAccess: false })
  } catch (err) {
    log.warn('extensions: loadExtension failed', { id: entry.id, path: entry.path, err: String(err) })
  }
}

function removeExtensionFromAllSessions(extensionId: string): void {
  for (const ses of getAllSessions()) {
    try {
      ses.removeExtension(extensionId)
    } catch {
      /* extension may not be loaded in this session */
    }
  }
}

function broadcastExtensionsChanged(): void {
  const list = listExtensions()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('extensions:changed', list)
    }
  }
}

// ── Public API ──

// Older installs predate the `pinned` field. electron-store loads the JSON
// verbatim, so legacy entries arrive missing `pinned`. Normalize once at
// every read site and trust the in-memory shape after that. Returns
// ExtensionInfo (pinned guaranteed present) so call sites can flow it
// straight through to the renderer / Promise<ExtensionInfo> APIs.
function normalizeEntry(raw: Partial<PersistedEntry> & { id: string }): ExtensionInfo {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    shortName: raw.shortName,
    version: raw.version ?? '0.0.0',
    description: raw.description,
    enabled: raw.enabled ?? true,
    pinned: raw.pinned ?? true,
    path: raw.path ?? '',
    hostPermissions: raw.hostPermissions ?? [],
    permissions: raw.permissions ?? [],
    hasOptionsPage: raw.hasOptionsPage ?? false,
    hasAction: raw.hasAction ?? false,
    actionDefaultTitle: raw.actionDefaultTitle,
    iconUrl: raw.iconUrl,
    installedAt: raw.installedAt ?? Date.now(),
  }
}

export function listExtensions(): ExtensionInfo[] {
  const raw = store.get('extensions') as Record<string, Partial<PersistedEntry> & { id: string }>
  return Object.values(raw)
    .map(normalizeEntry)
    .sort((a, b) => a.installedAt - b.installedAt)
}

/** Look up an installed extension by id and return enough info to load
 *  it on demand. Returns null if not installed (or the on-disk path is
 *  stale). Used by tab-views.ts when opening an extension's popup so we
 *  can force-load the extension into the popup view's session even if
 *  the install loop missed it. */
export function getExtensionEntry(
  extensionId: string
): { id: string; path: string; enabled: boolean } | null {
  const raw = store.get('extensions') as Record<string, Partial<PersistedEntry> & { id: string }>
  const e = raw[extensionId]
  if (!e || typeof e.path !== 'string') return null
  if (!existsSync(join(e.path, 'manifest.json'))) return null
  return { id: extensionId, path: e.path, enabled: e.enabled ?? true }
}

/** Idempotently load an extension into a specific session. Returns true if
 *  the session already had it at the right path (or we successfully loaded
 *  it), false on error.
 *
 *  Why this is path-aware: Electron's loadExtension dedups by id against
 *  the in-memory extension list. After a CRX reinstall the entry on disk
 *  moves to a new <id>/<version> directory, but the session can still be
 *  pointing at the OLD path. chrome-extension:// loads against the new
 *  files get ERR_BLOCKED_BY_CLIENT because the resource handler is wired
 *  to a directory that no longer exists. Comparing path lets us detect
 *  that case and force a fresh load. */
export async function ensureExtensionInSession(
  ses: Session,
  extensionId: string
): Promise<boolean> {
  const entry = getExtensionEntry(extensionId)
  if (!entry || !entry.enabled) {
    log.warn('ensureExtensionInSession: no enabled entry', {
      id: extensionId,
      hasEntry: !!entry,
      enabled: entry?.enabled,
    })
    return false
  }
  // Compare existing registration against the on-disk path.
  let stalePath: string | null = null
  let alreadyLoadedAtRightPath = false
  try {
    const all = ses.getAllExtensions?.() ?? []
    const same = all.find((e) => e.id === extensionId)
    if (same) {
      if (same.path === entry.path) {
        alreadyLoadedAtRightPath = true
      } else {
        stalePath = same.path
      }
    }
  } catch { /* ignore */ }

  if (alreadyLoadedAtRightPath) return true

  if (stalePath) {
    log.info('ensureExtensionInSession: stale registration, removing', {
      id: extensionId,
      stalePath,
      newPath: entry.path,
    })
    try { ses.removeExtension(extensionId) } catch { /* not loaded */ }
  }

  try {
    const ext = await ses.loadExtension(entry.path, { allowFileAccess: false })
    let postCount = 0
    let postIds: string[] = []
    try {
      const all = ses.getAllExtensions?.() ?? []
      postCount = all.length
      postIds = all.map((e) => e.id)
    } catch { /* ignore */ }
    log.info('ensureExtensionInSession: loadExtension resolved', {
      id: extensionId,
      path: entry.path,
      resolvedId: ext?.id ?? null,
      postCount,
      postIds,
    })
    return true
  } catch (err) {
    log.warn('ensureExtensionInSession: loadExtension failed', {
      id: extensionId,
      path: entry.path,
      err: String(err),
    })
    return false
  }
}

export async function setExtensionPinned(extensionId: string, pinned: boolean): Promise<void> {
  const raw = store.get('extensions') as Record<string, Partial<PersistedEntry> & { id: string }>
  const all = { ...raw }
  const existing = all[extensionId]
  if (!existing) return
  const entry = normalizeEntry(existing)
  if (entry.pinned === pinned) return
  entry.pinned = pinned
  all[extensionId] = entry
  store.set('extensions', all)
  broadcastExtensionsChanged()
}

export async function installExtensionById(extensionId: string): Promise<ExtensionInfo> {
  log.info('extensions: installing', extensionId)
  // Clean any cookies/cache from the dedicated fetch session before each
  // install. We saw second-install-after-uninstall fail with net::ERR_FAILED
  // because the request layer remembered a poisoned response from the prior
  // attempt; wiping at the start of every install keeps things deterministic.
  await clearCrxFetchSession()
  const crxBuf = await fetchCrx(extensionId)
  const zipBuf = parseCrx(crxBuf)
  // Extract the CRX's signing public key BEFORE we strip the prefix and
  // forget about it — it's the only way Electron can reproduce the same
  // extension id Chrome Web Store assigned, instead of hashing the on-disk
  // path and inventing a new one.
  const publicKey = extractCrxPublicKey(crxBuf)
  if (!publicKey) {
    log.warn('extensions: no public key found in CRX header', { extensionId })
  }

  // Unpack into a temp dir first, read manifest to discover the version,
  // then rename into its final resting place. This avoids leaving a
  // half-extracted directory around if the user's disk fills up.
  const root = extensionsRoot()
  mkdirSync(root, { recursive: true })
  const tmpDir = join(root, `${extensionId}.tmp-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  try {
    unzipTo(zipBuf, tmpDir)
    // Patch BEFORE we read for derivation — the patched manifest is what
    // ends up at the extension's permanent path, so the entry we persist
    // (and what loadExtension sees) matches the patched version.
    patchManifest(tmpDir, publicKey)
    const manifest = readManifest(tmpDir)
    const version =
      typeof manifest.version === 'string' ? (manifest.version as string) : 'unknown'
    const finalDir = join(root, extensionId, version)
    // Clean any prior version of this same extensionId — we don't support
    // keeping multiple versions side-by-side.
    try {
      rmSync(join(root, extensionId), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    mkdirSync(join(root, extensionId), { recursive: true })
    // Use fs.renameSync via require to avoid pulling node:fs's promises API
    // into a tight import. rmSync already exists at top.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    fs.renameSync(tmpDir, finalDir)

    const entry = derivePersistedEntry(extensionId, finalDir, true, Date.now())
    const all = { ...store.get('extensions') }
    all[extensionId] = entry
    store.set('extensions', all)

    for (const ses of getAllSessions()) {
      await loadExtensionInto(ses, entry)
    }
    broadcastExtensionsChanged()
    log.info('extensions: installed', { id: extensionId, name: entry.name, version: entry.version })
    return normalizeEntry(entry)
  } catch (err) {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw err
  }
}

export async function uninstallExtension(extensionId: string): Promise<void> {
  log.info('extensions: uninstalling', extensionId)
  removeExtensionFromAllSessions(extensionId)
  const all = { ...store.get('extensions') }
  const entry = all[extensionId]
  delete all[extensionId]
  store.set('extensions', all)
  if (entry) {
    try {
      rmSync(join(extensionsRoot(), extensionId), { recursive: true, force: true })
    } catch (err) {
      log.warn('extensions: failed to remove directory', { id: extensionId, err: String(err) })
    }
  }
  broadcastExtensionsChanged()
}

export async function setExtensionEnabled(extensionId: string, enabled: boolean): Promise<void> {
  const all = { ...store.get('extensions') }
  const entry = all[extensionId]
  if (!entry) return
  if (entry.enabled === enabled) return
  entry.enabled = enabled
  all[extensionId] = entry
  store.set('extensions', all)

  if (enabled) {
    for (const ses of getAllSessions()) {
      await loadExtensionInto(ses, entry)
    }
  } else {
    removeExtensionFromAllSessions(extensionId)
  }
  broadcastExtensionsChanged()
}

export function openOptionsPageUrl(extensionId: string): string | null {
  const entry = store.get('extensions')[extensionId]
  if (!entry || !entry.hasOptionsPage) return null
  const manifest = readManifest(entry.path)
  const optionsPage =
    typeof manifest.options_page === 'string'
      ? (manifest.options_page as string)
      : (manifest.options_ui as Record<string, string> | undefined)?.page
  if (!optionsPage) return null
  return `chrome-extension://${extensionId}/${optionsPage.replace(/^\//, '')}`
}

export function getActionPopupPathForTab(extensionId: string, _tabId: string | null): string | null {
  // `_tabId` is here for future chrome.action.getPopup routing once we
  // support per-tab popup overrides via chrome.action.setPopup.
  const entry = store.get('extensions')[extensionId]
  if (!entry || !entry.hasAction) return null
  const manifest = readManifest(entry.path)
  const action = (manifest.action || manifest.browser_action || manifest.page_action) as
    | Record<string, unknown>
    | undefined
  if (!action) return null
  const popup = action.default_popup
  if (typeof popup === 'string' && popup.length > 0) return popup
  return null
}

export async function loadEnabledExtensionsInto(ses: Session): Promise<void> {
  const all = store.get('extensions')
  for (const entry of Object.values(all)) {
    await loadExtensionInto(ses, entry)
  }
}

/** Called once during app.whenReady. Reconciles on-disk state with the
 *  store: any entry whose directory disappeared is removed from the store;
 *  loading into sessions happens lazily as setupPartitionSession runs. */
export async function rehydrateExtensionsOnStartup(): Promise<void> {
  const all = { ...store.get('extensions') }
  let changed = false
  for (const [id, entry] of Object.entries(all)) {
    if (!existsSync(join(entry.path, 'manifest.json'))) {
      log.warn('extensions: rehydrate dropped missing entry', { id, path: entry.path })
      delete all[id]
      changed = true
      continue
    }
    // Re-apply manifest patches to extensions installed before we shipped
    // them. The CRX is long gone, so we can only fix the
    // web_accessible_resources part — but that's enough for popup/options
    // pages to load. The `key` patch is install-time-only because the
    // public key only exists in the CRX header. Existing entries that
    // were derived under the wrong id will need a reinstall.
    try {
      patchManifest(entry.path, null)
    } catch (err) {
      log.warn('extensions: rehydrate manifest patch failed', { id, err: String(err) })
    }
  }
  if (changed) store.set('extensions', all)
  // Load into the default session now, so popup BrowserWindows that use
  // the default session can resolve chrome-extension:// URLs too.
  await loadEnabledExtensionsInto(session.defaultSession)
}
