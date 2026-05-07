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
//
// Why we never load extensions into `session.defaultSession`:
//   The workspace BrowserWindow's main webContents (the React UI) runs on
//   the default session. If we registered a content-script-bearing
//   extension (Tampermonkey, AdBlock, Unhook, …) there, its content
//   scripts would inject into our renderer's `localhost:5173` /
//   `file://…/index.html` page and break the chrome UI. We saw the
//   characteristic "white window after restart" symptom from Tampermonkey
//   doing exactly this. Extensions live ONLY in partitioned sessions
//   (the per-profile `persist:profile-<id>` ones used for tabs and
//   extension popups).

import { app, BrowserWindow, session, type Session } from 'electron'
import Store from 'electron-store'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { log } from '../log'
import { parseCrx, extractCrxPublicKey, deriveExtensionIdFromPublicKey } from './crx'
import { fetchCrx, extractExtensionIdFromUrl as _extract, clearCrxFetchSession } from './store'
import { unzipTo } from './zip'
import { SW_SHIM_SOURCE, SW_SHIM_MAGIC, SW_SHIM_LEGACY_MAGIC, SW_SHIM_FOOTER } from './sw-shim'
import { clearUserScriptsForExtension } from './userscripts'

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

/** Adapter for Electron's deprecated session-extension methods.
 *  Electron 41 deprecated `session.getAllExtensions / loadExtension /
 *  removeExtension` in favour of `session.extensions.*`. The new
 *  namespace is preferred when present; fall back to the legacy
 *  methods on older builds. Centralised so we have one place to
 *  swap when the legacy paths are removed entirely. */
type SesExtensions = {
  getAllExtensions?: () => Electron.Extension[]
  loadExtension?: (path: string, options?: Electron.LoadExtensionOptions) => Promise<Electron.Extension>
  removeExtension?: (id: string) => void
}
function sesExt(ses: Session): SesExtensions {
  const modern = (ses as unknown as { extensions?: SesExtensions }).extensions
  if (modern) return modern
  return ses as unknown as SesExtensions
}
function sessionGetAllExtensions(ses: Session): Electron.Extension[] {
  const e = sesExt(ses)
  try {
    return e.getAllExtensions ? e.getAllExtensions() : []
  } catch {
    return []
  }
}
async function sessionLoadExtension(
  ses: Session,
  path: string,
  options?: Electron.LoadExtensionOptions,
): Promise<Electron.Extension | null> {
  const e = sesExt(ses)
  if (!e.loadExtension) return null
  return e.loadExtension(path, options)
}
function sessionRemoveExtension(ses: Session, id: string): void {
  const e = sesExt(ses)
  try {
    if (e.removeExtension) e.removeExtension(id)
  } catch {
    /* extension may not be loaded in this session */
  }
}

/** Parse Chrome's relaxed `manifest.json` / `messages.json` dialect.
 *  Chrome accepts JSONC: line + block comments, trailing commas, plus
 *  whatever quirks Chromium's PicojsonReader tolerates (BOM, lone
 *  surrogates, etc.). Strict JSON.parse rejects all of it.
 *
 *  Browsec's manifest is the test case — its CRX failed our regex-
 *  based stripper at "position 5015 line 17 column 3" both before and
 *  after we added trailing-comma handling. jsonc-parser (VS Code's
 *  parser) handles every dialect quirk we've encountered, including
 *  comments inside strings (which our naive `//` regex stripped) and
 *  BOM at file start.
 *
 *  Returns the parsed object or throws — same contract as JSON.parse,
 *  so callers don't need to change. We feed parse errors through
 *  jsonc-parser's accumulator and surface the first one. */
function parseRelaxedJson(text: string): unknown {
  // Strip BOM if present — jsonc-parser handles it but old call sites
  // expect "what JSON.parse would do" semantics, so doing it here
  // avoids any surprise downstream.
  let input = text
  if (input.length > 0 && input.charCodeAt(0) === 0xfeff) input = input.slice(1)
  const errors: ParseError[] = []
  const result = parseJsonc(input, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    const e = errors[0]
    throw new SyntaxError(`manifest.json: parse error code ${e.error} at offset ${e.offset}, length ${e.length}`)
  }
  return result
}

function readManifest(extDir: string): Record<string, unknown> {
  const manifestPath = join(extDir, 'manifest.json')
  const text = readFileSync(manifestPath, 'utf8')
  return parseRelaxedJson(text) as Record<string, unknown>
}

/** Read the extension's localized messages.json for the given locale. The
 *  `_locales/<lang>` directory may be missing entirely, the JSON may be
 *  malformed, or messages.json may simply not declare the message we need —
 *  we treat every failure mode as "no localization" and let the caller
 *  fall back to the next candidate (or the raw __MSG_…__ token). Comments
 *  are not allowed in messages.json per the spec but we strip /* … *\/ and
 *  // … blocks just in case so a single bad authoring choice doesn't
 *  flip the entire extension's name to its raw placeholder. */
function readLocaleMessages(extDir: string, locale: string): Record<string, { message?: string }> | null {
  if (!locale) return null
  const safeLocale = locale.replace(/[^A-Za-z0-9_-]/g, '')
  if (!safeLocale) return null
  const path = join(extDir, '_locales', safeLocale, 'messages.json')
  try {
    if (!existsSync(path)) return null
    const text = readFileSync(path, 'utf8')
    const parsed = parseRelaxedJson(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, { message?: string }>) : null
  } catch {
    return null
  }
}

/** Resolve a single `__MSG_<name>__` token. Lookup is case-insensitive
 *  per the Chrome i18n spec. Returns the original token unchanged when no
 *  locale catalog (or the specific message) is available — that matches
 *  what Chrome surfaces in the dev-tools "extension management" UI when
 *  a translation goes missing, and is far better than the empty string. */
function resolveMessageToken(
  token: string,
  primary: Record<string, { message?: string }> | null,
  fallback: Record<string, { message?: string }> | null
): string {
  const m = token.match(/^__MSG_([A-Za-z0-9_@]+)__$/)
  if (!m) return token
  const name = m[1].toLowerCase()
  const lookup = (cat: Record<string, { message?: string }> | null): string | null => {
    if (!cat) return null
    for (const key of Object.keys(cat)) {
      if (key.toLowerCase() === name) {
        const msg = cat[key]?.message
        if (typeof msg === 'string' && msg.length > 0) return msg
      }
    }
    return null
  }
  return lookup(primary) ?? lookup(fallback) ?? token
}

/** Replace every `__MSG_xxx__` placeholder in `value` with its localized
 *  string. Chrome itself only resolves placeholders in known manifest
 *  fields (name, short_name, description, default_title, etc.) but we
 *  apply it broadly because every value we surface through `ExtensionInfo`
 *  is a manifest field that Chrome would localize. */
function localizeString(
  value: string,
  primary: Record<string, { message?: string }> | null,
  fallback: Record<string, { message?: string }> | null
): string {
  if (!value.includes('__MSG_')) return value
  return value.replace(/__MSG_[A-Za-z0-9_@]+__/g, (token) =>
    resolveMessageToken(token, primary, fallback)
  )
}

/** Pre-load the locale catalogs for an extension. Returns `[primary, fallback]`
 *  where `primary` is the catalog matching `app.getLocale()` (best effort)
 *  and `fallback` is the manifest's `default_locale`. Either may be null. */
function loadLocaleCatalogs(
  extDir: string,
  manifest: Record<string, unknown>
): [Record<string, { message?: string }> | null, Record<string, { message?: string }> | null] {
  const defaultLocale = typeof manifest.default_locale === 'string' ? (manifest.default_locale as string) : ''
  if (!defaultLocale) return [null, null]
  let userLocale = ''
  try { userLocale = app.getLocale() } catch { /* before-ready */ }
  // Chrome i18n resolution: try the user's exact locale first
  // (e.g. en_GB), then the language-only fallback (en), then the
  // manifest's default_locale. We collapse hyphenated BCP-47 (en-GB) into
  // underscored Chrome-style (en_GB) so the directory lookup matches.
  const candidates: string[] = []
  if (userLocale) {
    const norm = userLocale.replace('-', '_')
    candidates.push(norm)
    const lang = norm.split('_')[0]
    if (lang && lang !== norm) candidates.push(lang)
  }
  candidates.push(defaultLocale)
  let primary: Record<string, { message?: string }> | null = null
  for (const c of candidates) {
    primary = readLocaleMessages(extDir, c)
    if (primary) break
  }
  const fallback = readLocaleMessages(extDir, defaultLocale)
  return [primary, fallback]
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
  let manifest: Record<string, unknown>
  try {
    manifest = parseRelaxedJson(raw) as Record<string, unknown>
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

  // ── Patch 3: strip permissions Electron 41 doesn't recognise.
  //    Chromium's extension loader prints `Permission '<name>' is unknown`
  //    for each one, but more importantly some Electron builds outright
  //    REJECT the load when a single bogus permission is present
  //    (electron/electron#22175 — webRequestBlocking historically
  //    short-circuited the entire load on MV3). We can't add functionality
  //    by stripping permissions, but we CAN keep the rest of the extension
  //    alive so popup, options, and any chrome.* APIs Electron does
  //    support continue to function. The list mirrors what Electron 41
  //    surfaces as warnings against Tampermonkey 5.4, plus the always-
  //    deprecated `chrome://favicon/` pseudo-host.
  const isMv3 = manifest.manifest_version === 3
  const UNSUPPORTED_PERMISSIONS = new Set<string>([
    'notifications',
    'webNavigation',
    'contextMenus',
    'cookies',
    'downloads',
    'chrome://favicon/',
    'management',
    // VPN / privacy extensions (Browsec, etc.) — Electron's manifest
    // validator emits an ExtensionLoadWarning per unknown permission.
    // Our SW shim's chrome.* polyfill handles the runtime API surface;
    // stripping the permission here just silences the warning.
    'proxy',
    'privacy',
    'browsingData',
    'background',
  ])
  // `webRequestBlocking` is MV2-only on real Chrome; in MV3 Electron will
  // refuse the load. For MV2 extensions we leave it alone — our build
  // does support the blocking variant on MV2.
  if (isMv3) UNSUPPORTED_PERMISSIONS.add('webRequestBlocking')

  const filterPerms = (key: 'permissions' | 'optional_permissions'): boolean => {
    const list = manifest[key]
    if (!Array.isArray(list)) return false
    const next = (list as unknown[]).filter(
      (p) => typeof p !== 'string' || !UNSUPPORTED_PERMISSIONS.has(p)
    )
    if (next.length === list.length) return false
    manifest[key] = next
    return true
  }
  if (filterPerms('permissions')) modified = true
  if (filterPerms('optional_permissions')) modified = true

  // ── Patch 3.5: ensure host_permissions includes <all_urls> so the
  //    extension can run content scripts on every site without a
  //    per-origin grant prompt. We don't have a per-site grant UX, and
  //    the partitioned session boundary already isolates extension
  //    state per profile — so the coarse grant is appropriate. This
  //    also keeps Tampermonkey's chrome.permissions.contains() check
  //    happy (it queries before injecting userscripts).
  const hp = Array.isArray(manifest.host_permissions)
    ? (manifest.host_permissions as string[]).slice()
    : []
  if (!hp.includes('<all_urls>')) {
    hp.push('<all_urls>')
    manifest.host_permissions = hp
    modified = true
  }

  // ── Patch 4: when an extension declares `options_ui.open_in_tab=false`
  //    (the default), Chrome embeds the options page inside chrome://extensions
  //    in an iframe. We don't have a chrome://extensions surface, so flip
  //    the flag to true and surface options.html as a regular tab. Without
  //    this, choosing "Options" from the right-click menu opens nothing
  //    visible to the user.
  const optionsUi = manifest.options_ui as Record<string, unknown> | undefined
  if (optionsUi && typeof optionsUi === 'object' && optionsUi.open_in_tab !== true) {
    optionsUi.open_in_tab = true
    manifest.options_ui = optionsUi
    modified = true
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

/** Prepend our chrome.tabs.create / chrome.windows.create /
 *  chrome.runtime.openOptionsPage shim into the manifest's MV3 service
 *  worker file (typically `background.js`). Idempotent: a re-install
 *  over an already-shimmed file sees the magic comment and skips.
 *
 *  WHY this exists despite us also registering a session-level
 *  type='service-worker' preload: in Electron 41 that registration
 *  doesn't actually inject into chrome-extension service workers
 *  (verified empirically by the absence of a shim "preload-start" log
 *  line for the SW context). Patching the file on disk is the only
 *  reliable injection point we have right now. The session-level
 *  preload still does useful work for FRAME contexts (popup,
 *  options.html), so we keep both code paths.
 *
 *  Returns true if the file was modified — used by callers that want
 *  to log "we patched in the SW shim". MV2 background pages and
 *  extensions without `background.service_worker` are no-ops. */
function injectSwShim(extDir: string, manifest: Record<string, unknown>): boolean {
  if (manifest.manifest_version !== 3) return false
  const bg = manifest.background as { service_worker?: string } | undefined
  if (!bg || typeof bg.service_worker !== 'string' || bg.service_worker.length === 0) return false
  // Strip any leading slashes to keep the join inside the extension dir.
  const swRel = bg.service_worker.replace(/^\/+/, '')
  if (swRel.includes('..')) return false
  const swPath = join(extDir, swRel)
  let original: string
  try {
    original = readFileSync(swPath, 'utf8')
  } catch (err) {
    log.warn('extensions: SW shim — service worker file missing', {
      extDir,
      swRel,
      err: String(err),
    })
    return false
  }
  // Already on the current shim version — no work to do.
  if (original.startsWith(SW_SHIM_MAGIC)) return false
  // Strip an older shim version so we don't stack them. V2 ships a
  // dedicated footer marker we can match exactly. V1 didn't — its
  // outer IIFE closed with `\n})();\n` on its own line and there are
  // no other `})();` sequences inside the V1 source, so we search for
  // the FIRST occurrence after the V1 marker. Either way, body is
  // everything that follows the shim's closing line.
  let body = original
  if (original.startsWith(SW_SHIM_LEGACY_MAGIC)) {
    const v1Close = '\n})();\n'
    const closeIdx = original.indexOf(v1Close, SW_SHIM_LEGACY_MAGIC.length)
    if (closeIdx === -1) {
      log.warn('extensions: SW shim — found legacy V1 marker without recognisable IIFE close; not migrating', {
        extDir,
        swRel,
      })
      return false
    }
    body = original.slice(closeIdx + v1Close.length)
    log.info('extensions: SW shim — migrating V1 → V2', { extDir, swRel })
  } else {
    // V2+ shim with footer (future versions). When the marker doesn't
    // match the current MAGIC, we walk to the FOOTER line and strip
    // everything before it.
    const footerIdx = original.indexOf(SW_SHIM_FOOTER)
    if (footerIdx !== -1 && original.indexOf(SW_SHIM_MAGIC) !== 0) {
      // The file starts with SOME shim header (not our current MAGIC and
      // not V1). Strip up to the line after the footer.
      const startsWithSomeShim = original.startsWith('// __NEWBRO_SW_SHIM_')
      if (startsWithSomeShim) {
        const afterFooter = original.indexOf('\n', footerIdx)
        body = afterFooter === -1 ? '' : original.slice(afterFooter + 1)
        log.info('extensions: SW shim — replacing older shim header', { extDir, swRel })
      }
    }
  }
  try {
    writeFileSync(swPath, SW_SHIM_SOURCE + '\n' + body)
    log.info('extensions: SW shim injected', { extDir, swRel })
    return true
  } catch (err) {
    log.warn('extensions: SW shim — write failed', { extDir, swRel, err: String(err) })
    return false
  }
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
  // Resolve __MSG_xxx__ tokens so Settings → Extensions and the toolbar's
  // right-click menu show the actual extension name (e.g. "Tampermonkey")
  // instead of the raw `__MSG_extName__` placeholder. Tampermonkey, Unhook,
  // uBlock Origin, and most internationalised extensions ship every visible
  // string as a placeholder backed by `_locales/<lang>/messages.json`.
  const [primary, fallback] = loadLocaleCatalogs(extDir, manifest)
  const localize = (s: string): string => localizeString(s, primary, fallback)
  const rawName = typeof manifest.name === 'string' ? (manifest.name as string) : id
  const name = localize(rawName)
  const shortName =
    typeof manifest.short_name === 'string' ? localize(manifest.short_name as string) : undefined
  const version = typeof manifest.version === 'string' ? (manifest.version as string) : '0.0.0'
  const description =
    typeof manifest.description === 'string' ? localize(manifest.description as string) : undefined
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
    action && typeof action.default_title === 'string' ? localize(action.default_title as string) : undefined
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

/** Every partition session that should host extensions. We DELIBERATELY
 *  exclude `session.defaultSession`: the workspace BrowserWindow's main
 *  webContents (the React UI) runs there, and registering an extension
 *  on it would let content scripts (`<all_urls>` matches are typical)
 *  inject into our chrome page. The white-window-after-restart
 *  regression with Tampermonkey installed was Tampermonkey's content
 *  scripts crashing the renderer's own bundle on `localhost:5173` /
 *  `file:///…/index.html`. Tab WebContentsViews and extension-popup
 *  WebContentsViews use partitioned sessions instead, and extensions
 *  live there. */
function getAllSessions(): Session[] {
  const sessions = new Set<Session>()
  // Inspect every live BrowserWindow / WebContents session and pick up
  // anything that ISN'T the default session. These always mirror the
  // partitions configured by setupPartitionSession but doing it via
  // window inspection lets us avoid a circular import on
  // `getConfiguredPartitions`.
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      const winSes = win.webContents.session
      if (winSes !== session.defaultSession) sessions.add(winSes)
      for (const view of win.contentView.children) {
        const wc = (view as unknown as { webContents?: Electron.WebContents }).webContents
        if (wc && !wc.isDestroyed() && wc.session !== session.defaultSession) {
          sessions.add(wc.session)
        }
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
  const existing = sessionGetAllExtensions(ses)
  const same = existing.find((e) => e.id === entry.id)
  if (same) {
    if (same.path === entry.path) return
    stale = true
  }
  if (stale) sessionRemoveExtension(ses, entry.id)
  try {
    const ext = await sessionLoadExtension(ses, entry.path, { allowFileAccess: false })
    // The resolved id is what Electron derived from manifest.key (or the
    // path hash when key was missing). If it disagrees with the id the
    // user installed under, every chrome-extension://<entry.id>/… URL
    // we hand to Chromium will hit ERR_BLOCKED_BY_CLIENT — the
    // extension is registered, just under a different id. Surface this
    // loudly so the regression doesn't silently rebroke popups again.
    if (ext && ext.id !== entry.id) {
      log.error('extensions: id mismatch — loadExtension resolved a different id', {
        persistedId: entry.id,
        resolvedId: ext.id,
        path: entry.path,
      })
    }
  } catch (err) {
    log.warn('extensions: loadExtension failed', { id: entry.id, path: entry.path, err: String(err) })
  }
}

function removeExtensionFromAllSessions(extensionId: string): void {
  for (const ses of getAllSessions()) {
    sessionRemoveExtension(ses, extensionId)
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
  const all = sessionGetAllExtensions(ses)
  const same = all.find((e) => e.id === extensionId)
  if (same) {
    if (same.path === entry.path) alreadyLoadedAtRightPath = true
    else stalePath = same.path
  }

  if (alreadyLoadedAtRightPath) return true

  if (stalePath) {
    log.info('ensureExtensionInSession: stale registration, removing', {
      id: extensionId,
      stalePath,
      newPath: entry.path,
    })
    sessionRemoveExtension(ses, extensionId)
  }

  try {
    const ext = await sessionLoadExtension(ses, entry.path, { allowFileAccess: false })
    const post = sessionGetAllExtensions(ses)
    log.info('ensureExtensionInSession: loadExtension resolved', {
      id: extensionId,
      path: entry.path,
      resolvedId: ext?.id ?? null,
      postCount: post.length,
      postIds: post.map((e) => e.id),
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
  //
  // Pass the expected id so extractCrxPublicKey can pick the publisher's
  // proof out of CRX3's repeated sha256_with_rsa[]. Without the id we
  // returned the first proof, which on a Chrome Web Store CRX is Google's
  // CWS enrollment key — every extension we installed ended up with the
  // same Google-derived id and the chrome-extension://<real-id>/popup
  // load got `ERR_BLOCKED_BY_CLIENT (-20)` because no extension with the
  // real id was registered.
  const publicKey = extractCrxPublicKey(crxBuf, extensionId)
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
    // Inject our chrome.tabs.create polyfill into the MV3 service
    // worker file. Has to happen here — Electron 41's
    // registerPreloadScript({ type: 'service-worker' }) doesn't actually
    // fire for chrome-extension service workers, so patching the SW
    // file on disk is our only reliable injection point.
    injectSwShim(tmpDir, manifest)
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
  // Drop any chrome.userScripts the extension had registered so we
  // don't keep injecting after uninstall. Static import — main is
  // bundled by electron-vite into a single out/main/index.js, so the
  // earlier runtime require('./userscripts') resolved against that
  // bundled file and threw MODULE_NOT_FOUND.
  clearUserScriptsForExtension(extensionId)
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
 *  loading into sessions happens lazily as setupPartitionSession runs.
 *
 *  Why we DON'T load into `session.defaultSession` here: see
 *  `getAllSessions()` for the full rationale — content scripts would
 *  bleed into our React UI and break the renderer (this is the
 *  "white-window-after-restart" regression with Tampermonkey installed).
 *  Earlier builds also DID register on defaultSession, so we clear
 *  anything the previous run left behind on every startup. */
export async function rehydrateExtensionsOnStartup(): Promise<void> {
  // Clear any stale extensions left on the default session by older
  // builds of Newbro. No-op when nothing was registered.
  const stale = sessionGetAllExtensions(session.defaultSession)
  for (const e of stale) {
    try {
      sessionRemoveExtension(session.defaultSession, e.id)
      log.info('extensions: cleared stale default-session registration', { id: e.id })
    } catch (err) {
      log.warn('extensions: failed to clear default-session entry', { id: e.id, err: String(err) })
    }
  }

  const all = { ...store.get('extensions') }
  let changed = false
  for (const [id, entry] of Object.entries(all)) {
    if (!existsSync(join(entry.path, 'manifest.json'))) {
      log.warn('extensions: rehydrate dropped missing entry', { id, path: entry.path })
      delete all[id]
      changed = true
      continue
    }
    // Detect installs from the broken-CRX-key build (≤1.1.37): those
    // wrote Google's CWS enrollment key into manifest.key instead of the
    // publisher's, so Electron derived the wrong extension id at load
    // time and every chrome-extension://<expected-id>/… URL bounced
    // with ERR_BLOCKED_BY_CLIENT. Auto-uninstall those entries; the user
    // will see them disappear from Settings → Extensions and can
    // reinstall under the now-fixed code path.
    try {
      const manifestRaw = parseRelaxedJson(
        readFileSync(join(entry.path, 'manifest.json'), 'utf8')
      ) as Record<string, unknown>
      const key = typeof manifestRaw.key === 'string' ? manifestRaw.key : null
      if (key) {
        const derived = deriveExtensionIdFromPublicKey(Buffer.from(key, 'base64'))
        if (derived && derived !== id) {
          log.warn('extensions: rehydrate dropping mis-keyed install (reinstall required)', {
            id,
            derivedFromManifestKey: derived,
            path: entry.path,
          })
          try {
            rmSync(join(extensionsRoot(), id), { recursive: true, force: true })
          } catch (rmErr) {
            log.warn('extensions: failed to remove mis-keyed dir', { id, err: String(rmErr) })
          }
          delete all[id]
          changed = true
          continue
        }
      }
    } catch (err) {
      log.warn('extensions: rehydrate key check failed', { id, err: String(err) })
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
    // Re-inject the SW shim. Idempotent — installs already shimmed by
    // a prior boot detect the magic-comment header and skip the write.
    try {
      const m = readManifest(entry.path)
      injectSwShim(entry.path, m)
    } catch (err) {
      log.warn('extensions: rehydrate SW shim inject failed', { id, err: String(err) })
    }
    // Re-derive the persisted entry so localized fields (name,
    // description, default_title) refresh retroactively for extensions
    // installed before __MSG_*__ resolution shipped. Preserve the user's
    // enabled / pinned / installedAt choices.
    try {
      const fresh = derivePersistedEntry(
        id,
        entry.path,
        entry.enabled ?? true,
        entry.installedAt ?? Date.now(),
        entry.pinned ?? true
      )
      const next: PersistedEntry = { ...fresh, enabled: entry.enabled ?? true, pinned: entry.pinned ?? true }
      // Avoid an unnecessary write when nothing actually changed.
      if (JSON.stringify(next) !== JSON.stringify(entry)) {
        all[id] = next
        changed = true
      }
    } catch (err) {
      log.warn('extensions: rehydrate derive failed', { id, err: String(err) })
    }
  }
  if (changed) store.set('extensions', all)
  // Loading into partition sessions happens via setupPartitionSession in
  // index.ts — there's no work to do here for the default session.
}
