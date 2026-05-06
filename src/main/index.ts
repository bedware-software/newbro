// Branding MUST run before any electron-store instance is constructed
// (which happens transitively when './ipc' is imported below). The
// side-effect import below calls app.setName so userData / appData /
// cache directories pick up the dev-vs-stable split — otherwise every
// store grabs the default name during the import cascade and we never
// get a separate dev folder. Keep this as the FIRST internal import.
import { APP_NAME } from './branding'
import { app, BrowserWindow, session, Menu, nativeImage, screen, protocol } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers, registerDetachedPopup } from './ipc'
import { setupAutoUpdater } from './updater'
import {
  loadState,
  loadOpenWindows,
  saveOpenWindows,
  loadWorkspaceBounds,
  saveWorkspaceBounds,
  type OpenWindowEntry,
} from './store'
import { loadSettings, DEFAULT_KEYBINDINGS, type ProxySettings, type Settings } from './settings-store'
import { log } from './log'
import {
  registerWorkspaceWindowForTabs,
  installTabPreloadListeners,
  closeExtensionPopup,
  getActiveTabInfoForWindow,
  createTabForExtension,
  getRecordByWebContents,
  selectTabByWebContents,
  destroyTabByWebContents,
} from './tab-views'
import { getOrCreateExtensions, isLibrarySelectTabSuppressed } from './chrome-extensions-bridge'
import { loadEnabledExtensionsInto, rehydrateExtensionsOnStartup } from './extensions/manager'
import {
  registerUserScripts,
  unregisterUserScripts,
  type RegisteredUserScript,
} from './extensions/userscripts'

// ── Chromium flags ──

// Register newbro-ipc:// as a privileged scheme so the SW shim we
// inject into MV3 background scripts can do `fetch('newbro-ipc://...')`
// to query main and get a JSON response back. Without privileged +
// supportFetchAPI, fetch() of a custom scheme from a service worker
// just errors. MUST run before app.ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'newbro-ipc',
    privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true },
  },
])

// Disable Chromium's User-Agent Client Hints so we don't send sec-ch-ua/
// sec-ch-ua-mobile/sec-ch-ua-platform headers or expose navigator.userAgentData.
// Google's sign-in rejection ("Couldn't sign you in — This browser or app may
// not be secure") is triggered by sec-ch-ua containing only "Chromium" without
// a recognized product brand like "Google Chrome". With the feature disabled,
// Google falls back to the User-Agent string alone — which is a clean Chrome UA
// after the stripping below — and sign-in goes through.
app.commandLine.appendSwitch(
  'disable-features',
  'UserAgentClientHint,UserAgentClientHintFullVersionList,GreaseUACH,CriticalClientHint'
)

// ── Certificate error bypass ──
// Origins the user has explicitly chosen to bypass for this session.
// Cleared when the app quits — not persisted.
const bypassedCertOrigins = new Set<string>()

export function addBypassedCertOrigin(url: string): void {
  try {
    bypassedCertOrigins.add(new URL(url).origin)
  } catch {
    /* ignore invalid URLs */
  }
}

// Diagnostic: log any child-process crash. Each tab is its own renderer,
// each profile has a session-process, GPU + utility helpers run separately.
// When a heavy site (Figma is the reported case) takes one of these down,
// the symptom is a workspace window that disappears with no error in the
// console — these listeners give us at least the reason code to triage on.
app.on('child-process-gone', (_e, details) => {
  log.error('child-process-gone', {
    type: details.type,
    name: (details as { name?: string }).name ?? null,
    serviceName: (details as { serviceName?: string }).serviceName ?? null,
    reason: details.reason,
    exitCode: details.exitCode,
  })
})
app.on('render-process-gone', (_e, wc, details) => {
  let url = ''
  try { url = wc.getURL() } catch { /* ignore */ }
  log.error('app-level render-process-gone', {
    wcId: wc.id,
    type: wc.getType(),
    url,
    reason: details.reason,
    exitCode: details.exitCode,
  })
})

app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
  try {
    if (bypassedCertOrigins.has(new URL(url).origin)) {
      event.preventDefault()
      callback(true)
      return
    }
  } catch {
    /* fall through */
  }
  callback(false)
})

// ── Branding ──
// `app.setName` runs in `./branding`, which is imported above before any
// electron-store gets constructed. The APP_NAME constant comes from there
// so visible-branding sites in this file (window titles, menus, About)
// stay in sync with the chosen userData directory.

// Remove "Electron/x.y.z" from the default user agent string. The "Newbro"
// regex stays as-is — even in dev mode the UA token (when present) uses
// the production product name; the dev suffix is purely for branding /
// directory isolation.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s*Electron\/[\w.]+/, '')
  .replace(/\s*newbro-browser\/[\w.]+/, '')
  .replace(/\s*Newbro\/[\w.]+/, '')

// In dev mode, patch the Electron binary's Info.plist so macOS menu bar
// shows the dev name instead of "Electron".
if (is.dev && process.platform === 'darwin') {
  try {
    const plistPath = join(
      process.execPath, '..', '..', 'Info.plist'
    )
    const plist = readFileSync(plistPath, 'utf8')
    if (plist.includes('<string>Electron</string>')) {
      const patched = plist.replace(/<string>Electron<\/string>/g, `<string>${APP_NAME}</string>`)
      writeFileSync(plistPath, patched, 'utf8')
      log.info(`patched Info.plist: Electron → ${APP_NAME} (restart to take full effect)`)
    }
  } catch (err) {
    log.warn('could not patch Info.plist for branding', err)
  }
}

// Suppress harmless Electron GUEST_VIEW_MANAGER_CALL errors caused by webview redirects
const _origConsoleError = console.error
console.error = (...args: unknown[]) => {
  if (
    typeof args[0] === 'string' &&
    args[0].includes('GUEST_VIEW_MANAGER_CALL')
  ) return
  _origConsoleError(...args)
}

const configuredPartitions = new Set<string>()
const workspaceWindows = new Map<string, BrowserWindow>()
const workspaceProfiles = new Map<string, string>() // workspaceId → profileId
let lastKnownOpenWindows: OpenWindowEntry[] = []

// Resolve icon paths once
const iconPng = join(__dirname, '../../resources/icon.png')

function normalizeShortcutKeyToken(raw: string): string {
  const key = raw.trim().toLowerCase()
  switch (key) {
    case 'return':
      return 'enter'
    case 'space':
      return ' '
    default:
      return key
  }
}

function keyTokenFromInput(input: Electron.Input): string {
  const code = (input.code || '').trim()
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5).toLowerCase()
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6).toLowerCase()
  return normalizeShortcutKeyToken(input.key || '')
}

function parseTabLeaderShortcut(binding: string | undefined): string | null {
  if (!binding) return null
  const parts = binding.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length !== 2) return null
  if (parts[0].toLowerCase() !== 'tab') return null
  const key = normalizeShortcutKeyToken(parts[1])
  return key || null
}

interface ParsedAccelerator {
  key: string
  shift: boolean
  alt: boolean
  cmdOrCtrl: boolean
}

function parseAcceleratorShortcut(binding: string | undefined): ParsedAccelerator | null {
  if (!binding) return null
  const parts = binding.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return null

  let shift = false
  let alt = false
  let cmdOrCtrl = false
  let key: string | null = null

  for (const rawPart of parts) {
    const part = rawPart.toLowerCase()
    if (part === 'shift') {
      shift = true
      continue
    }
    if (part === 'alt' || part === 'option') {
      alt = true
      continue
    }
    if (part === 'cmdorctrl') {
      cmdOrCtrl = true
      continue
    }
    // Tab+X chord (Tab as leader) is handled by parseTabLeaderShortcut — only
    // reject when Tab appears at the leader position (first token, no modifiers
    // seen yet). With modifiers like CmdOrCtrl+Tab, Tab is a regular key.
    if (part === 'tab' && !shift && !alt && !cmdOrCtrl && !key) return null
    if (key) return null
    key = normalizeShortcutKeyToken(rawPart)
  }

  if (!key) return null
  return { key, shift, alt, cmdOrCtrl }
}

function resolveTabCycleBindings(
  keybindings: Record<string, string[]>,
  action: 'next-tab' | 'prev-tab',
  fallback: string,
): string[] {
  const stored = keybindings[action]
  // An empty array means the user explicitly cleared all bindings; respect
  // that. Only a missing key falls back to the platform default.
  const candidates = Array.isArray(stored) ? stored : [fallback]
  const out: string[] = []
  for (const raw of candidates) {
    const trimmed = (raw || '').trim()
    if (!trimmed) continue
    if (parseTabLeaderShortcut(trimmed) || parseAcceleratorShortcut(trimmed)) {
      out.push(trimmed)
    }
  }
  return out
}

function matchesAccelerator(input: Electron.Input, shortcut: ParsedAccelerator | null): boolean {
  if (!shortcut) return false
  const key = keyTokenFromInput(input)
  if (!key || key !== shortcut.key) return false

  const hasShift = !!input.shift
  const hasAlt = !!input.alt
  const hasCmdOrCtrl = !!input.meta || !!input.control

  if (hasShift !== shortcut.shift) return false
  if (hasAlt !== shortcut.alt) return false
  if (hasCmdOrCtrl !== shortcut.cmdOrCtrl) return false
  return true
}

function installShortcutInterceptor(source: Electron.WebContents, targetWindow: BrowserWindow): void {
  let tabDown = false
  let tabResetTimer: NodeJS.Timeout | null = null

  const clearTabState = () => {
    tabDown = false
    if (tabResetTimer) {
      clearTimeout(tabResetTimer)
      tabResetTimer = null
    }
  }

  const armTabState = () => {
    tabDown = true
    if (tabResetTimer) clearTimeout(tabResetTimer)
    tabResetTimer = setTimeout(() => {
      tabDown = false
      tabResetTimer = null
    }, 900)
  }

  source.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return

    const key = keyTokenFromInput(input)
    const noOtherModifiers = !input.alt && !input.control && !input.meta && !input.shift

    const settings = loadSettings()
    const keybindings = { ...DEFAULT_KEYBINDINGS, ...settings.keybindings }

    // Tab-leader chord support (e.g. "Tab+J" for next-tab): resolved separately
    // because parseAcceleratorShortcut rejects Tab-as-leader bindings. Each
    // action may carry up to two bindings; collect every Tab-leader from
    // both slots so either fires the chord.
    const nextBindings = resolveTabCycleBindings(keybindings, 'next-tab', 'CmdOrCtrl+Tab')
    const prevBindings = resolveTabCycleBindings(keybindings, 'prev-tab', 'CmdOrCtrl+Shift+Tab')
    const nextLeaderKeys = nextBindings
      .map(parseTabLeaderShortcut)
      .filter((k): k is string => !!k)
    const prevLeaderKeys = prevBindings
      .map(parseTabLeaderShortcut)
      .filter((k): k is string => !!k)

    // Plain Tab: arm the chord if the user has a Tab-leader binding configured.
    if (key === 'tab' && noOtherModifiers) {
      if (nextLeaderKeys.length > 0 || prevLeaderKeys.length > 0) {
        armTabState()
        // Prevent native focus traversal so Tab+J/K remains reliable.
        event.preventDefault()
        log.info('tab-chord: armed', { nextLeaderKeys, prevLeaderKeys })
      }
      return
    }

    // Second key in an armed Tab-leader chord.
    if (tabDown && noOtherModifiers) {
      if (key && nextLeaderKeys.includes(key)) {
        event.preventDefault()
        if (!targetWindow.isDestroyed()) targetWindow.webContents.send('shortcut', 'next-tab')
        clearTabState()
        return
      }
      if (key && prevLeaderKeys.includes(key)) {
        event.preventDefault()
        if (!targetWindow.isDestroyed()) targetWindow.webContents.send('shortcut', 'prev-tab')
        clearTabState()
        return
      }
      if (key !== 'tab') {
        clearTabState()
      }
    }

    // Match against every user-defined accelerator-style keybinding. We run
    // here (before-input-event) rather than relying only on native menu
    // accelerators because menu accelerators can lose the race when a page's
    // own keydown handler calls preventDefault — e.g. Yandex Code capturing
    // Ctrl+P to jump to a matching parenthesis. Intercepting at
    // before-input-event runs BEFORE any page script sees the key, and
    // calling event.preventDefault() here cancels both the page keydown
    // AND the menu shortcut, so there's no double dispatch. Each action
    // may have up to two bindings; either should fire.
    for (const action of Object.keys(keybindings)) {
      const bindings = keybindings[action] || []
      for (const binding of bindings) {
        const parsed = parseAcceleratorShortcut(binding)
        if (!parsed) continue
        if (matchesAccelerator(input, parsed)) {
          event.preventDefault()
          if (!targetWindow.isDestroyed()) targetWindow.webContents.send('shortcut', action)
          return
        }
      }
    }
  })

  source.once('destroyed', clearTabState)
}

function sanitizeProxyRules(rules: string): string {
  return rules.replace(/\/\/[^@/]+@/g, '//***:***@')
}

function toElectronProxyConfig(proxy: ProxySettings): Electron.ProxyConfig {
  switch (proxy.mode) {
    case 'direct':
      return { mode: 'direct' }
    case 'custom': {
      const rules = (proxy.proxyRules || '').trim()
      if (!rules) return { mode: 'direct' }
      return {
        mode: 'fixed_servers',
        proxyRules: rules,
        proxyBypassRules: proxy.proxyBypassRules || '<-loopback>',
      }
    }
    case 'system':
    default:
      return { mode: 'system' }
  }
}

function applyProxyToSession(ses: Electron.Session, settings: Settings): void {
  const cfg = toElectronProxyConfig(settings.proxy)
  ses.setProxy(cfg)
    .then(async () => {
      await ses.forceReloadProxyConfig()
      await ses.closeAllConnections()
      log.info('proxy applied to session', {
        mode: settings.proxy.mode,
        proxyRules: sanitizeProxyRules(settings.proxy.proxyRules || ''),
      })
    })
    .catch((err) => {
      log.error('failed to apply proxy settings', err)
    })
}

export function applyProxySettingsToAllSessions(settings: Settings): void {
  const allSessions = new Set<Electron.Session>([session.defaultSession])
  for (const partition of configuredPartitions) {
    allSessions.add(session.fromPartition(partition))
  }
  for (const ses of allSessions) {
    applyProxyToSession(ses, settings)
  }
}

/** Absolute path to the webview stealth preload, compiled by electron-vite
 *  alongside the main preload. Injected into every webview session so the
 *  navigator/chrome fingerprint overrides run before any page script. */
const WEBVIEW_STEALTH_PRELOAD = join(__dirname, '../preload/webview-stealth.js')

/** Absolute path to the extension shim — a small chrome.* polyfill (mainly
 *  chrome.tabs.create / chrome.windows.create / chrome.runtime.openOptionsPage)
 *  that fills the gaps Electron 41 leaves. Self-disables outside
 *  chrome-extension:// contexts; registered on every partition session
 *  for both frames and MV3 service workers (the latter is where
 *  Tampermonkey's Dashboard-button click handler runs). */
const EXTENSION_SHIM_PRELOAD = join(__dirname, '../preload/extension-shim.js')

/** Configure a session: strip Electron branding from the UA, allow permissions,
 *  apply proxy settings. Applied to both the default session and partitioned
 *  webview sessions. */
function configureSession(ses: Electron.Session): void {
  const rawUA = ses.getUserAgent()
  const cleanUA = rawUA
    .replace(/\s*Electron\/\S+/g, '')
    .replace(/\s*newbro-browser\/\S+/g, '')
    .replace(/\s*Newbro\/\S+/g, '')
  ses.setUserAgent(cleanUA)
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(true))
  applyProxyToSession(ses, loadSettings())

  // Synchronously allow TLS handshakes for user-bypassed origins. This is
  // called for every request (including subresources like favicons and
  // images), while app.on('certificate-error') is async and unreliable for
  // subresources — the renderer's <img src="https://bad-cert/favicon.ico">
  // needs this to succeed after the user has clicked through the warning.
  //
  // Callback values (from Electron docs):
  //   0  = trust (skip further checks)
  //   -3 = use Chromium's default verification
  //   -2 = hard failure (do NOT use for "just defer to default" — it rejects!)
  ses.setCertificateVerifyProc((request, callback) => {
    try {
      if (bypassedCertOrigins.has(new URL(`https://${request.hostname}`).origin)) {
        callback(0)
        return
      }
    } catch {
      /* fall through */
    }
    callback(-3)
  })

  const externalFilter = { urls: ['http://*/*', 'https://*/*'] }
  ses.webRequest.onBeforeSendHeaders(externalFilter, (details, callback) => {
    const headers = { ...details.requestHeaders }
    delete headers['X-Electron-Version']
    callback({ requestHeaders: headers })
  })

  // SW → main IPC channel. The shim we prepend into MV3 service workers
  // can't import { ipcRenderer } from 'electron' (no preload bridge in
  // an extension's own JS world), so it talks to us by sending a
  // fetch() to a sentinel host. We intercept that fetch before any
  // network resolution happens, drive the requested action, and cancel
  // the request — the .test TLD never reaches DNS even if the cancel
  // races. Pattern stays narrow (one host) so legitimate requests are
  // untouched.
  // Custom protocol that the SW shim can fetch from to get JSON back.
  // The webRequest sentinel pattern is one-way (we cancel, no body),
  // which is fine for "open this tab" but doesn't help when the SW
  // needs to ask "what's the URL of the active tab?" — that needs a
  // round-trip with content. protocol.handle returns a real Response.
  try {
    const handle = (ses.protocol as { handle?: (scheme: string, h: (req: Request) => Promise<Response> | Response) => void }).handle
    if (typeof handle === 'function') {
      handle.call(ses.protocol, 'newbro-ipc', async (req: Request): Promise<Response> => {
        try {
          const u = new URL(req.url)
          const action = u.hostname || u.pathname.replace(/^\/+/, '')
          if (action === 'active-tab-info' || action === 'active-tab-info/') {
            // Find the workspace window that owns this partition. We
            // pick the focused one; if none is focused, the first
            // window with a tab in this partition.
            const win = pickWindowForPartition(partition)
            if (!win) {
              log.info('extensions: ipc active-tab-info — no window for partition', { partition })
              return jsonResponse({ tab: null })
            }
            const tab = getActiveTabInfoForWindow(win.id)
            log.info('extensions: ipc active-tab-info', { partition, windowId: win.id, tab })
            return jsonResponse({ tab })
          }
          return jsonResponse({ error: 'unknown-action', action })
        } catch (err) {
          return jsonResponse({ error: String(err) }, 500)
        }
      })
    } else {
      log.warn('extensions: ses.protocol.handle missing — SW newbro-ipc:// won\'t work', { partition })
    }
  } catch (err) {
    log.warn('extensions: ses.protocol.handle setup failed', { partition, err: String(err) })
  }

  ses.webRequest.onBeforeRequest(
    { urls: ['https://newbro-ext-ipc.test/*', 'http://newbro-ext-ipc.test/*'] },
    (details, callback) => {
      try {
        const u = new URL(details.url)
        const action = u.pathname.replace(/^\/+/, '')
        if (action === 'open-tab') {
          const url = u.searchParams.get('url')
          if (typeof url === 'string' && url.length > 0) {
            const focused = BrowserWindow.getFocusedWindow()
            const target =
              focused && !focused.isDestroyed()
                ? focused
                : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
            if (target) {
              try { closeExtensionPopup(target.id) } catch { /* ignore */ }
              target.webContents.send('open-url-as-tab', url)
              log.info('extensions: SW shim opened tab', { url })
            }
          }
        } else if (action === 'userscripts-register' || action === 'userscripts-update') {
          const body = readUploadBody(details)
          const parsed = body ? safeJsonParse(body) : null
          if (parsed && typeof parsed === 'object') {
            const p = parsed as { extId?: unknown; scripts?: unknown }
            const extId = typeof p.extId === 'string' ? p.extId : ''
            const scripts = Array.isArray(p.scripts) ? (p.scripts as RegisteredUserScript[]) : []
            if (extId && scripts.length > 0) {
              registerUserScripts(getPartitionForSession(ses), extId, scripts)
            }
          }
        } else if (action === 'userscripts-unregister') {
          const body = readUploadBody(details)
          const parsed = body ? safeJsonParse(body) : null
          if (parsed && typeof parsed === 'object') {
            const p = parsed as { extId?: unknown; ids?: unknown }
            const extId = typeof p.extId === 'string' ? p.extId : ''
            const ids = Array.isArray(p.ids) ? (p.ids as string[]) : null
            if (extId) unregisterUserScripts(getPartitionForSession(ses), extId, ids)
          }
        } else if (action === 'sw-shim-ran') {
          const body = readUploadBody(details)
          const parsed = body ? safeJsonParse(body) : null
          log.info('extensions: SW shim ran', { partition, info: parsed })
        } else if (
          action === 'userscripts-getScripts' ||
          action === 'userscripts-configureWorld'
        ) {
          const body = readUploadBody(details)
          const parsed = body ? safeJsonParse(body) : null
          log.info('extensions: ' + action, { partition, info: parsed })
        } else if (action === 'permission-check') {
          // Diagnostic from the SW shim's chrome.permissions.contains.
          // Surfaces what URL/permissions Tampermonkey is gating on.
          log.info('extensions: permission-check (SW)', {
            origins: u.searchParams.get('origins') ?? '',
            permissions: u.searchParams.get('permissions') ?? '',
          })
        } else if (action === 'scripting-execute') {
          const body = readUploadBody(details)
          const parsed = body ? safeJsonParse(body) : null
          if (parsed && typeof parsed === 'object') {
            const p = parsed as { extId?: unknown; tabIds?: unknown; body?: unknown; world?: unknown }
            const extId = typeof p.extId === 'string' ? p.extId : ''
            const tabIds = Array.isArray(p.tabIds) ? (p.tabIds as number[]) : []
            const code = typeof p.body === 'string' ? p.body : ''
            log.info('extensions: scripting-execute', { extId, tabIds, codeLen: code.length })
            // Inject the code into every requested tab. Tab ids passed
            // by the SW shim come from our hashed UUIDs (see
            // tab-views.ts hashStringToInt) — find each matching tab
            // and run its code.
            if (code.length > 0 && tabIds.length > 0) {
              executeScriptOnHashedTabIds(getPartitionForSession(ses), tabIds, code)
            }
          }
        } else if (action === 'badge-set' || action === 'badge-color') {
          // Forward to every workspace renderer so it can update its
          // toolbar icon overlay. Renderer-side rendering ships in a
          // follow-up commit; for now we just log + broadcast.
          const extId = u.searchParams.get('extId') ?? ''
          const text = u.searchParams.get('text') ?? ''
          const color = u.searchParams.get('color') ?? ''
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) {
              w.webContents.send('extensions:badge', { extId, text, color, action })
            }
          }
        }
      } catch (err) {
        log.warn('extensions: SW shim ipc parse failed', { url: details.url, err: String(err) })
      }
      callback({ cancel: true })
    },
  )
}

function readUploadBody(details: Electron.OnBeforeRequestListenerDetails): string | null {
  const data = details.uploadData
  if (!Array.isArray(data) || data.length === 0) return null
  let out = ''
  for (const part of data) {
    const bytes = (part as { bytes?: Buffer }).bytes
    if (bytes && Buffer.isBuffer(bytes)) out += bytes.toString('utf8')
  }
  return out.length > 0 ? out : null
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

function getPartitionForSession(ses: Electron.Session): string {
  for (const partition of configuredPartitions) {
    if (session.fromPartition(partition) === ses) return partition
  }
  return 'persist:default'
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function executeScriptOnHashedTabIds(partition: string, hashedTabIds: number[], code: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    for (const view of win.contentView.children) {
      const wc = (view as unknown as { webContents?: Electron.WebContents }).webContents
      if (!wc || wc.isDestroyed()) continue
      if (wc.session !== session.fromPartition(partition)) continue
      // Cross-reference via a fresh getActiveTabInfoForWindow call —
      // its return value carries the same hashed id the SW shim
      // would have received from chrome.tabs.query, so a match here
      // means we're operating on the right WebContentsView.
      const info = getActiveTabInfoForWindow(win.id)
      if (info && hashedTabIds.includes(info.id)) {
        wc.executeJavaScript(code, true).catch((err) => {
          log.warn('scripting-execute: injection failed', { err: String(err) })
        })
      }
    }
  }
}

function pickWindowForPartition(partition: string): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) {
    for (const view of focused.contentView.children) {
      const wc = (view as unknown as { webContents?: Electron.WebContents }).webContents
      if (wc && !wc.isDestroyed() && wc.session === session.fromPartition(partition)) {
        return focused
      }
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    for (const view of win.contentView.children) {
      const wc = (view as unknown as { webContents?: Electron.WebContents }).webContents
      if (wc && !wc.isDestroyed() && wc.session === session.fromPartition(partition)) {
        return win
      }
    }
  }
  return null
}

export function setupPartitionSession(partition: string): void {
  if (configuredPartitions.has(partition)) return
  const ses = session.fromPartition(partition)
  configureSession(ses)
  // Only partitioned tab sessions get the stealth preload — the default
  // session belongs to the main renderer which doesn't need (and shouldn't
  // have) page-fingerprint overrides. The extension shim runs alongside
  // it; both self-disable on URLs outside their target scheme.
  ses.setPreloads([WEBVIEW_STEALTH_PRELOAD, EXTENSION_SHIM_PRELOAD])
  // The shim ALSO needs to run inside MV3 service workers, where most
  // extensions (Tampermonkey's icon-click handler in particular) host
  // their chrome.tabs.create calls. registerPreloadScript with
  // type='service-worker' is the API for that. Wrapped in try/catch
  // because the option name has shifted across Electron versions and we
  // don't want a missing API to break the partition.
  try {
    const ext = (ses as unknown as {
      registerPreloadScript?: (spec: {
        type: 'service-worker' | 'frame'
        filePath: string
        id?: string
      }) => string | void
    }).registerPreloadScript
    if (typeof ext === 'function') {
      ext.call(ses, {
        type: 'service-worker',
        filePath: EXTENSION_SHIM_PRELOAD,
        id: 'newbro-extension-shim-sw',
      })
      log.info('extensions: registered SW shim preload', { partition })
    } else {
      log.warn('extensions: ses.registerPreloadScript missing — SW shim won\'t inject', { partition })
    }
  } catch (err) {
    log.warn('extensions: registerPreloadScript(service-worker) failed', { partition, err: String(err) })
  }
  // Mirror chrome-extension service-worker console messages into the
  // main log. Drop the level filter — Tampermonkey logs at level 0/1
  // (info/debug) but those are exactly the lines we need to figure
  // out why chrome.userScripts.register isn't being called. We
  // exclude one known-noisy line (extension.isAllowedFileSchemeAccess
  // unimplemented) which fires every 30s and floods.
  try {
    const sw = (ses as unknown as { serviceWorkers?: { on?: Function } }).serviceWorkers
    if (sw && typeof sw.on === 'function') {
      sw.on(
        'console-message',
        (
          _e: unknown,
          details: { message?: string; sourceUrl?: string; level?: number },
        ) => {
          const msg = String(details?.message ?? '')
          if (msg.includes('extension.isAllowedFileSchemeAccess is not yet implemented')) return
          const url = String(details?.sourceUrl ?? '')
          log.info('ext sw console', { partition, level: details?.level, url, msg })
        },
      )
    }
  } catch (err) {
    log.warn('extensions: failed to wire SW console-message listener', { partition, err: String(err) })
  }
  configuredPartitions.add(partition)

  // Hand the partition over to electron-chrome-extensions BEFORE
  // loadEnabledExtensionsInto fires — the library installs its
  // session preload via registerPreloadScript, and chrome.* in
  // background-script and popup contexts only works for extensions
  // loaded AFTER that preload is registered.
  try {
    getOrCreateExtensions(ses, {
      createTab: async (details) => {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        if (!win || win.isDestroyed()) throw new Error('no live window for chrome.tabs.create')
        const url = typeof details.url === 'string' ? details.url : 'about:blank'
        const wc = await createTabForExtension(win, partition, url, details.active !== false)
        return [wc, win]
      },
      selectTab: (wc) => {
        // The library calls this for any setActiveTab in its store —
        // including the spurious one observeTab fires when we addTab
        // a background tab. Skip if we're orchestrating that addTab
        // round-trip ourselves; honour real chrome.tabs.update calls
        // from extensions otherwise.
        try {
          if (isLibrarySelectTabSuppressed()) return
          selectTabByWebContents(wc)
        } catch { /* ignore */ }
      },
      removeTab: (wc) => {
        try { destroyTabByWebContents(wc) } catch { /* ignore */ }
      },
    })
  } catch (err) {
    log.warn('extensions: ElectronChromeExtensions setup failed', { partition, err: String(err) })
  }

  // Load every user-installed, enabled extension into the partition so
  // content scripts / declarativeNetRequest rules / MV3 service workers
  // attach before the first page navigation in this partition. Fire and
  // forget — any individual extension failing shouldn't block partition
  // setup for the rest.
  loadEnabledExtensionsInto(ses).catch((err) => {
    log.warn('extensions: loadEnabledExtensionsInto failed', { partition, err: String(err) })
  })
}

/** Partitions configured so far — exported so the extension manager can
 *  broadcast install/uninstall events to every live session. */
export function getConfiguredPartitions(): string[] {
  return Array.from(configuredPartitions)
}

// ── Per-workspace window bounds persistence ──
const DEFAULT_WINDOW_WIDTH = 1400
const DEFAULT_WINDOW_HEIGHT = 900
const persistBoundsTimers = new Map<string, NodeJS.Timeout>()

function boundsVisibleOnAnyDisplay(b: { x: number; y: number; width: number; height: number }): boolean {
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea
    const overlapX = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x)
    const overlapY = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y)
    if (overlapX > 100 && overlapY > 40) return true
  }
  return false
}

function captureWorkspaceBounds(workspaceId: string, win: BrowserWindow): void {
  if (!workspaceId || win.isDestroyed()) return
  const bounds = win.getNormalBounds()
  saveWorkspaceBounds(workspaceId, {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: win.isMaximized(),
  })
}

function scheduleCaptureWorkspaceBounds(workspaceId: string, win: BrowserWindow): void {
  if (!workspaceId) return
  const existing = persistBoundsTimers.get(workspaceId)
  if (existing) clearTimeout(existing)
  persistBoundsTimers.set(
    workspaceId,
    setTimeout(() => {
      persistBoundsTimers.delete(workspaceId)
      captureWorkspaceBounds(workspaceId, win)
    }, 500),
  )
}

function flushPendingBoundsCapture(workspaceId: string): void {
  const t = persistBoundsTimers.get(workspaceId)
  if (t) {
    clearTimeout(t)
    persistBoundsTimers.delete(workspaceId)
  }
}

export function closeWorkspaceWindow(workspaceId: string): void {
  const win = workspaceWindows.get(workspaceId)
  if (win && !win.isDestroyed()) {
    log.window('closeWorkspaceWindow', workspaceId, { stack: new Error().stack })
    win.close()
  }
  workspaceWindows.delete(workspaceId)
  workspaceProfiles.delete(workspaceId)
}

export function createWorkspaceWindow(profileId: string, workspaceId: string, workspaceName: string, targetTabId?: string): BrowserWindow {
  log.window('createWorkspaceWindow', { profileId, workspaceId, workspaceName, targetTabId })

  const existing = workspaceWindows.get(workspaceId)
  if (existing && !existing.isDestroyed()) {
    log.window('window already exists, focusing', workspaceId)
    existing.focus()
    if (targetTabId) {
      existing.webContents.send('activate-tab', targetTabId)
    }
    return existing
  }

  // Preconfigure the partition session BEFORE the renderer creates webviews,
  // so configureSession's onBeforeSendHeaders hook and UA are applied from the
  // very first request. The renderer's setupSession() IPC call is fire-and-forget
  // and races the webview attach — this preconfiguration closes that race for
  // the common case where the partition matches the profile id.
  if (profileId) {
    try {
      setupPartitionSession(`persist:profile-${profileId}`)
    } catch (err) {
      log.warn('failed to preconfigure partition session', err)
    }
  }

  const isMac = process.platform === 'darwin'
  const savedBounds = loadWorkspaceBounds(workspaceId)
  const useSavedPosition =
    !!savedBounds &&
    boundsVisibleOnAnyDisplay({
      x: savedBounds.x,
      y: savedBounds.y,
      width: savedBounds.width,
      height: savedBounds.height,
    })

  const win = new BrowserWindow({
    width: savedBounds?.width ?? DEFAULT_WINDOW_WIDTH,
    height: savedBounds?.height ?? DEFAULT_WINDOW_HEIGHT,
    ...(useSavedPosition ? { x: savedBounds!.x, y: savedBounds!.y } : {}),
    minWidth: 800,
    title: `${workspaceName} — ${APP_NAME}`,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { autoHideMenuBar: true, titleBarOverlay: { color: '#161616', symbolColor: '#d7d7d7', height: 47 } }),
    icon: iconPng,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Tabs are hosted as WebContentsView children of the window's content
      // view (see src/main/tab-views.ts). The <webview> tag is disabled so
      // Chrome extensions loaded via session.loadExtension() actually attach
      // to page content — Electron's extension system does not inject into
      // <webview>, only into BrowserWindow / WebContentsView.
      webviewTag: false,
      // nativeWindowOpen used to be opt-in here; modern Electron makes it
      // the only mode and removed the WebPreferences flag entirely. Drop
      // the property to keep TypeScript happy with @types/electron 41+.
    },
  })
  if (!isMac) {
    win.setMenuBarVisibility(false)
  }
  if (savedBounds?.maximized) {
    win.maximize()
  }

  workspaceWindows.set(workspaceId, win)
  workspaceProfiles.set(workspaceId, profileId)
  lastKnownOpenWindows = [...workspaceWindows.keys()].map(id => ({ profileId: workspaceProfiles.get(id)!, workspaceId: id }))
  installShortcutInterceptor(win.webContents, win)

  // Route the mouse side buttons (XButton1/XButton2 on Windows, matching
  // swipe gestures on macOS) to the renderer's existing back/forward shortcut
  // handler, which calls goBack()/goForward() on the active webview.
  win.on('app-command', (_event, command) => {
    if (command === 'browser-backward') {
      win.webContents.send('shortcut', 'back')
    } else if (command === 'browser-forward') {
      win.webContents.send('shortcut', 'forward')
    }
  })

  // Persist bounds on resize/move (debounced) and immediately on maximize
  // state changes so the window restores to its last size/position/maximized
  // state on the next launch or reopen.
  win.on('resize', () => scheduleCaptureWorkspaceBounds(workspaceId, win))
  win.on('move', () => scheduleCaptureWorkspaceBounds(workspaceId, win))
  win.on('maximize', () => {
    flushPendingBoundsCapture(workspaceId)
    captureWorkspaceBounds(workspaceId, win)
  })
  win.on('unmaximize', () => {
    flushPendingBoundsCapture(workspaceId)
    captureWorkspaceBounds(workspaceId, win)
  })

  win.on('close', () => {
    flushPendingBoundsCapture(workspaceId)
    captureWorkspaceBounds(workspaceId, win)

    // The 'close' event fires for both user-initiated closes (button, ⌘W,
    // app quit) and renderer-driven closes (renderer crash, win.close()
    // from the renderer). Capture the renderer state at the moment of
    // close so a Figma-style "window vanished mid-load" report has at
    // least something to triage from.
    const wc = win.webContents
    let crashed = false
    let activeUrl = ''
    try { crashed = wc.isCrashed() } catch { /* ignore */ }
    try { activeUrl = wc.getURL() } catch { /* ignore */ }
    log.info('window close', {
      workspaceId,
      windowId: win.id,
      crashed,
      activeUrl,
    })

    const allIds = [...workspaceWindows.keys()]
    const remainingIds = allIds.filter(id => id !== workspaceId)
    const toEntries = (ids: string[]) => ids.map(id => ({ profileId: workspaceProfiles.get(id)!, workspaceId: id }))
    if (remainingIds.length === 0) {
      // Last window closing — preserve it so it restores on next launch
      lastKnownOpenWindows = toEntries(allIds)
    } else {
      // User intentionally closed this window — exclude it
      lastKnownOpenWindows = toEntries(remainingIds)
    }
    log.info('window close: updated lastKnownOpenWindows', { closingWorkspaceId: workspaceId, lastKnownOpenWindows })
  })

  win.on('closed', () => {
    log.info('window closed', { workspaceId, windowId: win.id })
    workspaceWindows.delete(workspaceId)
    workspaceProfiles.delete(workspaceId)
  })

  // Allow renderer-created detached dialog windows and hide their native header.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Accept both `'about:blank'` and the empty string. `window.open('')`
    // and `window.open(undefined)` can surface here as either, depending on
    // the Chromium / Electron version, and treating only the literal
    // `'about:blank'` as openable made dialogs intermittently fail to
    // appear — the renderer-side React state would flip to "open" but the
    // native popup never spawned.
    if (url === 'about:blank' || url === '') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: false,
          frame: false,
          autoHideMenuBar: true,
          fullscreenable: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
          },
        },
      }
    }
    log.warn('setWindowOpenHandler: denying non-blank popup', { url })
    return { action: 'deny' }
  })

  // Diagnostic: log when the workspace window's MAIN renderer goes down.
  // Without this, a renderer crash on the main webContents looks identical
  // to a normal window close — we'd see only the BrowserWindow's `close`
  // event with no clue why the user lost their window.
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('main webContents render-process-gone', {
      windowId: win.id,
      workspaceId,
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })
  win.webContents.on('unresponsive', () => {
    log.warn('main webContents unresponsive', { windowId: win.id, workspaceId })
  })
  win.webContents.on('responsive', () => {
    log.info('main webContents responsive again', { windowId: win.id, workspaceId })
  })
  // The page-level 'close' on the BrowserWindow's MAIN webContents is what
  // fires when the workspace renderer or some script tied to it requests
  // the window to be closed (e.g. an Electron quirk where window.close()
  // from a child WebContentsView bubbles up). Surfacing it explicitly tells
  // us whether the BrowserWindow's close is renderer-driven or coming from
  // somewhere else in the main process.
  win.webContents.on('close', () => {
    log.info('main wc close', { windowId: win.id, workspaceId })
  })
  win.webContents.on('destroyed', () => {
    log.info('main wc destroyed', { windowId: win.id, workspaceId })
  })
  win.webContents.on('will-prevent-unload', () => {
    log.info('main will-prevent-unload', { windowId: win.id, workspaceId })
  })

  // Track detached popups so the drag IPC handlers can identify them when the
  // renderer requests a move. The popup is created synchronously after the
  // setWindowOpenHandler callback returns `allow`, and this event fires.
  win.webContents.on('did-create-window', (childWindow) => {
    registerDetachedPopup(childWindow)
    // The popup was created with show:false. Make it physically invisible via
    // OS compositor opacity, then "show" it so the renderer can paint into it.
    // The window stays at opacity 0 until the renderer signals that React has
    // finished rendering content (detached-window:show IPC).
    childWindow.setOpacity(0)
    childWindow.showInactive()
  })

  // Each tab is a WebContentsView child of this window (see tab-views.ts).
  // Register callbacks so the manager can install the shortcut interceptor
  // on every new tab's webContents, and tear down tabs on window close.
  registerWorkspaceWindowForTabs(win, installShortcutInterceptor)

  const tabSuffix = targetTabId ? `&tabId=${encodeURIComponent(targetTabId)}` : ''
  const params = `?profileId=${profileId}&workspaceId=${workspaceId}${tabSuffix}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + params)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      search: `profileId=${profileId}&workspaceId=${workspaceId}${tabSuffix}`,
    })
  }

  return win
}

export function rebuildMenu(): void {
  buildMenu()
}

/** Menu click handlers receive `BaseWindow | undefined` per Electron 41+
 *  types, but at runtime the focused window in our app is always a
 *  BrowserWindow with a webContents. Narrowing helper used by every menu
 *  item that fires a `shortcut` IPC. */
function sendShortcutToWindow(win: Electron.BaseWindow | undefined, action: string): void {
  const wc = (win as Electron.BrowserWindow | undefined)?.webContents
  if (wc && !wc.isDestroyed()) wc.send('shortcut', action)
}

function buildMenu(): void {
  const settings = loadSettings()
  const merged = { ...DEFAULT_KEYBINDINGS, ...settings.keybindings }
  // Electron menu items take a single accelerator string; with up-to-two
  // bindings per action we surface the FIRST one in the menu UI. The
  // second binding still fires via the before-input-event interceptor —
  // the menu just doesn't have a second column to advertise it.
  const kb: Record<string, string | undefined> = {}
  for (const key of Object.keys(merged)) {
    const list = merged[key]
    kb[key] = Array.isArray(list) && list.length > 0 ? list[0] : undefined
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: (_item, win) => sendShortcutToWindow(win, 'open-settings-about'),
        },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: kb['settings'],
          click: (_item, win) => sendShortcutToWindow(win, 'settings'),
        },
        { type: 'separator' },
        { label: `Hide ${APP_NAME}`, role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Exit ${APP_NAME}`, role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: kb['new-tab'],
          click: (_item, win) => sendShortcutToWindow(win, 'new-tab'),
        },
        {
          label: 'Close Tab',
          accelerator: kb['close-tab'],
          click: (_item, win) => sendShortcutToWindow(win, 'close-tab'),
        },
        {
          label: 'Close Window',
          accelerator: kb['close-window'],
          click: (_item, win) => {
            if (win && !win.isDestroyed()) {
              log.info('menu Close Window clicked', { windowId: (win as Electron.BrowserWindow).id })
              win.close()
            }
          },
        },
        { type: 'separator' },
        {
          label: 'New Workspace',
          accelerator: kb['new-workspace'],
          click: (_item, win) => sendShortcutToWindow(win, 'new-workspace'),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        // toggleDevTools targets the focused webContents — in practice that
        // is the workspace's chrome renderer. Keep it for debugging the UI.
        { label: 'Toggle UI Developer Tools', role: 'toggleDevTools' },
        // The active tab is rendered by a sibling WebContentsView, which
        // toggleDevTools never reaches. Route through the renderer's
        // shortcut handler so the active-tab id is resolved on its side.
        {
          label: 'Toggle Page Developer Tools',
          accelerator: kb['page-devtools'],
          click: (_item, win) => sendShortcutToWindow(win, 'page-devtools'),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        {
          label: 'Focus Address Bar',
          accelerator: kb['focus-url'],
          click: (_item, win) => sendShortcutToWindow(win, 'focus-url'),
        },
        {
          label: 'Search Everything',
          accelerator: kb['search'],
          click: (_item, win) => sendShortcutToWindow(win, 'search'),
        },
        {
          label: 'Command Palette',
          accelerator: kb['command-palette'],
          click: (_item, win) => sendShortcutToWindow(win, 'command-palette'),
        },
        {
          label: 'Toggle Sidebar',
          accelerator: kb['toggle-sidebar'],
          click: (_item, win) => sendShortcutToWindow(win, 'toggle-sidebar'),
        },
        { type: 'separator' },
        {
          label: 'Back',
          accelerator: kb['back'],
          click: (_item, win) => sendShortcutToWindow(win, 'back'),
        },
        {
          label: 'Forward',
          accelerator: kb['forward'],
          click: (_item, win) => sendShortcutToWindow(win, 'forward'),
        },
        {
          label: 'Reload Page',
          accelerator: kb['reload'],
          click: (_item, win) => sendShortcutToWindow(win, 'reload'),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // On Windows/Linux, hide the menu bar on all windows (shortcuts still work via the application menu)
  if (process.platform !== 'darwin') {
    for (const win of BrowserWindow.getAllWindows()) {
      win.setAutoHideMenuBar(true)
      win.setMenuBarVisibility(false)
    }
  }
}

function openInitialWindows(): void {
  const state = loadState() as any
  log.info('openInitialWindows', { hasState: !!state, profileCount: state?.profiles?.length })
  if (!state || !state.profiles || state.profiles.length === 0) return

  const savedWindows = loadOpenWindows()
  log.info('openInitialWindows', { savedWindows })

  if (savedWindows.length > 0) {
    // Restore windows that were open last time, across all profiles
    for (const entry of savedWindows) {
      const profile = state.profiles.find((p: any) => p.id === entry.profileId)
      if (!profile) continue
      const ws = profile.workspaces.find((w: any) => w.id === entry.workspaceId)
      if (ws) {
        createWorkspaceWindow(profile.id, ws.id, ws.name)
      }
    }
  } else {
    // First launch or no saved state — open all workspaces from active profile
    const activeProfile = state.profiles.find((p: any) => p.id === state.activeProfileId) || state.profiles[0]
    for (const ws of activeProfile.workspaces) {
      createWorkspaceWindow(activeProfile.id, ws.id, ws.name)
    }
  }
}

app.whenReady().then(() => {
  // ── Set dock icon on macOS ──
  if (process.platform === 'darwin' && app.dock) {
    try {
      const dockIcon = nativeImage.createFromPath(iconPng)
      log.info('dock icon size', dockIcon.getSize())
      if (!dockIcon.isEmpty()) {
        app.dock.setIcon(dockIcon)
      } else {
        log.warn('dock icon is empty, check icon.png path:', iconPng)
      }
    } catch (err) {
      log.error('failed to set dock icon', err)
    }
  }

  // ── About panel ──
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'Newbro Browser',
    version: '',
  })

  configureSession(session.defaultSession)
  applyProxySettingsToAllSessions(loadSettings())

  // Rehydrate installed extensions before any window opens. Each entry is
  // loaded into sessions as they get configured by setupPartitionSession.
  rehydrateExtensionsOnStartup().catch((err) => {
    log.warn('extensions: rehydrate failed', String(err))
  })

  buildMenu()
  registerIpcHandlers()
  installTabPreloadListeners()
  setupAutoUpdater()
  openInitialWindows()

  if (BrowserWindow.getAllWindows().length === 0) {
    createWorkspaceWindow('', '', 'Default')
  }
})

app.on('before-quit', () => {
  // Use lastKnownOpenWindows — by this point windows may already be destroyed (close-last-window path)
  let entries: OpenWindowEntry[]
  if (workspaceWindows.size > 0) {
    entries = [...workspaceWindows.keys()].map(id => ({ profileId: workspaceProfiles.get(id)!, workspaceId: id }))
  } else {
    entries = lastKnownOpenWindows
  }
  log.info('before-quit: saving open windows', { entries })
  saveOpenWindows(entries)
})

app.on('window-all-closed', () => {
  app.quit()
})
