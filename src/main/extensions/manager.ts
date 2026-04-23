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
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log'
import { parseCrx } from './crx'
import { fetchCrx, extractExtensionIdFromUrl as _extract } from './store'
import { unzipTo } from './zip'

export interface ExtensionInfo {
  id: string
  name: string
  shortName?: string
  version: string
  description?: string
  enabled: boolean
  path: string
  hostPermissions: string[]
  permissions: string[]
  hasOptionsPage: boolean
  /** When true, the renderer should render a toolbar action button for
   *  this extension. True iff the manifest declares `action` /
   *  `browser_action` / `page_action`. */
  hasAction: boolean
  actionDefaultTitle?: string
  /** Icon URL (chrome-extension://<id>/<path>) or null if the manifest
   *  doesn't declare one. The renderer resolves and displays it directly;
   *  chrome-extension:// URLs resolve in any session the extension is
   *  loaded into. */
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

function resolveIcon(manifest: Record<string, unknown>, extId: string): string | null {
  const icons = manifest.icons as Record<string, string> | undefined
  if (icons && typeof icons === 'object') {
    // Pick the largest declared size that fits comfortably in a 16–32px slot.
    const sizes = Object.keys(icons)
      .map((k) => parseInt(k, 10))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a)
    const preferred = sizes.find((s) => s <= 48) ?? sizes[0]
    if (preferred && icons[String(preferred)]) {
      return `chrome-extension://${extId}/${icons[String(preferred)].replace(/^\//, '')}`
    }
  }
  const action = (manifest.action || manifest.browser_action || manifest.page_action) as
    | Record<string, unknown>
    | undefined
  if (action && typeof action.default_icon === 'string') {
    return `chrome-extension://${extId}/${(action.default_icon as string).replace(/^\//, '')}`
  }
  if (action && typeof action.default_icon === 'object' && action.default_icon !== null) {
    const di = action.default_icon as Record<string, string>
    const sizes = Object.keys(di).sort((a, b) => parseInt(b, 10) - parseInt(a, 10))
    if (sizes.length > 0) {
      return `chrome-extension://${extId}/${di[sizes[0]].replace(/^\//, '')}`
    }
  }
  return null
}

function derivePersistedEntry(
  id: string,
  extDir: string,
  enabled: boolean,
  installedAt: number
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
  const iconUrl = resolveIcon(manifest, id)
  return {
    id,
    name,
    shortName,
    version,
    description,
    enabled,
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
  // Electron dedups by path: loading the same path into the same session
  // twice is a no-op on modern Electron, but we guard anyway by checking
  // the already-loaded list.
  try {
    const existing = ses.getAllExtensions?.() ?? []
    if (existing.some((e) => e.id === entry.id)) return
  } catch {
    /* ignore — getAllExtensions might not exist on older build */
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

export function listExtensions(): ExtensionInfo[] {
  const raw = store.get('extensions')
  return Object.values(raw).sort((a, b) => a.installedAt - b.installedAt)
}

export async function installExtensionById(extensionId: string): Promise<ExtensionInfo> {
  log.info('extensions: installing', extensionId)
  const crxBuf = await fetchCrx(extensionId)
  const zipBuf = parseCrx(crxBuf)

  // Unpack into a temp dir first, read manifest to discover the version,
  // then rename into its final resting place. This avoids leaving a
  // half-extracted directory around if the user's disk fills up.
  const root = extensionsRoot()
  mkdirSync(root, { recursive: true })
  const tmpDir = join(root, `${extensionId}.tmp-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  try {
    unzipTo(zipBuf, tmpDir)
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
    return entry
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
    }
  }
  if (changed) store.set('extensions', all)
  // Load into the default session now, so popup BrowserWindows that use
  // the default session can resolve chrome-extension:// URLs too.
  await loadEnabledExtensionsInto(session.defaultSession)
}
