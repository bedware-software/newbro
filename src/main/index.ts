// Branding MUST run before any electron-store instance is constructed
// (which happens transitively when './ipc' is imported below). The
// side-effect import below calls app.setName so userData / appData /
// cache directories pick up the dev-vs-stable split — otherwise every
// store grabs the default name during the import cascade and we never
// get a separate dev folder. Keep this as the FIRST internal import.
import { APP_NAME } from './branding'
import { app, BrowserWindow, session, Menu, nativeImage, screen } from 'electron'
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
import { registerWorkspaceWindowForTabs, installTabPreloadListeners } from './tab-views'
import { loadEnabledExtensionsInto, rehydrateExtensionsOnStartup } from './extensions/manager'

// ── Chromium flags ──

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

function resolveTabCycleBinding(
  keybindings: Record<string, string>,
  action: 'next-tab' | 'prev-tab',
  fallback: string,
): string {
  const candidate = (keybindings[action] || '').trim()
  if (!candidate) return fallback
  if (parseTabLeaderShortcut(candidate) || parseAcceleratorShortcut(candidate)) {
    return candidate
  }
  return fallback
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
    // because parseAcceleratorShortcut rejects Tab-as-leader bindings.
    const nextBinding = resolveTabCycleBinding(keybindings, 'next-tab', 'CmdOrCtrl+Tab')
    const prevBinding = resolveTabCycleBinding(keybindings, 'prev-tab', 'CmdOrCtrl+Shift+Tab')
    const nextLeaderKey = parseTabLeaderShortcut(nextBinding)
    const prevLeaderKey = parseTabLeaderShortcut(prevBinding)

    // Plain Tab: arm the chord if the user has a Tab-leader binding configured.
    if (key === 'tab' && noOtherModifiers) {
      if (nextLeaderKey || prevLeaderKey) {
        armTabState()
        // Prevent native focus traversal so Tab+J/K remains reliable.
        event.preventDefault()
        log.info('tab-chord: armed', { nextLeaderKey, prevLeaderKey })
      }
      return
    }

    // Second key in an armed Tab-leader chord.
    if (tabDown && noOtherModifiers) {
      if (nextLeaderKey && key === nextLeaderKey) {
        event.preventDefault()
        if (!targetWindow.isDestroyed()) targetWindow.webContents.send('shortcut', 'next-tab')
        clearTabState()
        return
      }
      if (prevLeaderKey && key === prevLeaderKey) {
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
    // AND the menu shortcut, so there's no double dispatch.
    for (const action of Object.keys(keybindings)) {
      const parsed = parseAcceleratorShortcut(keybindings[action])
      if (!parsed) continue
      if (matchesAccelerator(input, parsed)) {
        event.preventDefault()
        if (!targetWindow.isDestroyed()) targetWindow.webContents.send('shortcut', action)
        return
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
}

export function setupPartitionSession(partition: string): void {
  if (configuredPartitions.has(partition)) return
  const ses = session.fromPartition(partition)
  configureSession(ses)
  // Only partitioned tab sessions get the stealth preload — the default
  // session belongs to the main renderer which doesn't need (and shouldn't
  // have) page-fingerprint overrides.
  ses.setPreloads([WEBVIEW_STEALTH_PRELOAD])
  configuredPartitions.add(partition)
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
  const kb = { ...DEFAULT_KEYBINDINGS, ...settings.keybindings }

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openInitialWindows()
      if (BrowserWindow.getAllWindows().length === 0) {
        createWorkspaceWindow('', '', 'Default')
      }
    }
  })
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
  if (process.platform !== 'darwin') app.quit()
})
