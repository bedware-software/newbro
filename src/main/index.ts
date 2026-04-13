import { app, BrowserWindow, session, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { loadState, loadOpenWorkspaceIds, saveOpenWorkspaceIds } from './store'
import { loadSettings, DEFAULT_KEYBINDINGS, type ProxySettings, type Settings } from './settings-store'
import { log } from './log'

// ── Chromium flags ──

// ── Branding ──
app.setName('Newbro')

// Remove "Electron/x.y.z" from the default user agent string
app.userAgentFallback = app.userAgentFallback
  .replace(/\s*Electron\/[\w.]+/, '')
  .replace(/\s*newbro-browser\/[\w.]+/, '')
  .replace(/\s*Newbro\/[\w.]+/, '')

// In dev mode, patch the Electron binary's Info.plist so macOS menu bar shows "Newbro"
if (is.dev && process.platform === 'darwin') {
  try {
    const plistPath = join(
      process.execPath, '..', '..', 'Info.plist'
    )
    const plist = readFileSync(plistPath, 'utf8')
    if (plist.includes('<string>Electron</string>')) {
      const patched = plist.replace(/<string>Electron<\/string>/g, '<string>Newbro</string>')
      writeFileSync(plistPath, patched, 'utf8')
      log.info('patched Info.plist: Electron → Newbro (restart to take full effect)')
    }
  } catch (err) {
    log.warn('could not patch Info.plist for branding', err)
  }
}

const configuredPartitions = new Set<string>()
const workspaceWindows = new Map<string, BrowserWindow>()

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
    // Tab+X is handled separately as a two-step chord.
    if (part === 'tab' && parts.length > 1) return null
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

function installTabCycleInputShortcuts(source: Electron.WebContents, targetWindow: BrowserWindow): void {
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
    const key = keyTokenFromInput(input)
    const noOtherModifiers = !input.alt && !input.control && !input.meta && !input.shift

    if (input.type === 'keyUp') {
      if (key === 'tab') {
        // Tab released — keep chord armed (timer handles expiry)
      }
      return
    }

    if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return

    const settings = loadSettings()
    const keybindings = { ...DEFAULT_KEYBINDINGS, ...settings.keybindings }
    const nextBinding = resolveTabCycleBinding(keybindings, 'next-tab', 'Tab+J')
    const prevBinding = resolveTabCycleBinding(keybindings, 'prev-tab', 'Tab+K')
    const nextLeaderKey = parseTabLeaderShortcut(nextBinding)
    const prevLeaderKey = parseTabLeaderShortcut(prevBinding)

    if (key === 'tab' && noOtherModifiers) {
      if (nextLeaderKey || prevLeaderKey) {
        armTabState()
        // Prevent native focus traversal so Tab+J/K remains reliable.
        event.preventDefault()
        log.info('tab-chord: armed', { nextLeaderKey, prevLeaderKey })
      }
      return
    }

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

    const nextAccelerator = parseAcceleratorShortcut(nextBinding)
    const prevAccelerator = parseAcceleratorShortcut(prevBinding)
    if (matchesAccelerator(input, nextAccelerator)) {
      event.preventDefault()
      if (!targetWindow.isDestroyed()) targetWindow.webContents.send('shortcut', 'next-tab')
      return
    }
    if (matchesAccelerator(input, prevAccelerator)) {
      event.preventDefault()
      if (!targetWindow.isDestroyed()) targetWindow.webContents.send('shortcut', 'prev-tab')
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

/** Configure a session to look like a standard Chrome browser */
function configureSession(ses: Electron.Session): void {
  // Build a clean UA: strip Electron/app identifiers, extract real Chrome version
  const rawUA = ses.getUserAgent()
  const cleanUA = rawUA
    .replace(/\s*Electron\/\S+/g, '')
    .replace(/\s*newbro-browser\/\S+/g, '')
    .replace(/\s*Newbro\/\S+/g, '')
  ses.setUserAgent(cleanUA)
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(true))
  applyProxyToSession(ses, loadSettings())

  // Extract actual Chrome version from the UA (e.g. "Chrome/132.0.6834.210")
  const chromeMatch = cleanUA.match(/Chrome\/([\d.]+)/)
  const chromeVersion = chromeMatch ? chromeMatch[1] : '132.0.0.0'
  const chromeMajor = chromeVersion.split('.')[0]

  // Only clean up external web requests — skip internal/localhost/devtools
  // This avoids interfering with system-level ad blockers (AdGuard) and dev tools
  const externalFilter = { urls: ['http://*/*', 'https://*/*'] }
  ses.webRequest.onBeforeSendHeaders(externalFilter, (details, callback) => {
    // Skip localhost / 127.0.0.1 (used by ad blockers, proxies, dev servers)
    try {
      const u = new URL(details.url)
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1') {
        return callback({ requestHeaders: details.requestHeaders })
      }
    } catch { /* proceed with cleanup */ }

    const headers = { ...details.requestHeaders }
    delete headers['X-Electron-Version']
    // Set client hints matching the real Chromium build (not "Google Chrome" — TLS fingerprint won't match)
    if (!headers['sec-ch-ua']) {
      headers['sec-ch-ua'] = `"Chromium";v="${chromeMajor}", "Not-A.Brand";v="8"`
    }
    if (!headers['sec-ch-ua-mobile']) {
      headers['sec-ch-ua-mobile'] = '?0'
    }
    if (!headers['sec-ch-ua-platform']) {
      headers['sec-ch-ua-platform'] = `"${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'}"`
    }
    callback({ requestHeaders: headers })
  })
}

export function setupPartitionSession(partition: string): void {
  if (configuredPartitions.has(partition)) return
  const ses = session.fromPartition(partition)
  configureSession(ses)
  configuredPartitions.add(partition)
}

/** Auth provider hostnames known to block webview-based sign-in */
const AUTH_HOSTNAMES = new Set([
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'id.atlassian.com',
])

/** Check if a URL is an auth provider page known to block webviews */
function isAuthUrl(url: string): boolean {
  try {
    return AUTH_HOSTNAMES.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Extract the auth provider hostname from a URL (e.g. accounts.google.com) */
function getAuthHostname(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

/** Open a real BrowserWindow for auth flows (many providers block webview sign-in) */
function openAuthWindow(url: string, ses: Electron.Session, parent: BrowserWindow): void {
  log.info('opening auth window', { url: url.slice(0, 120) })

  const authHostname = getAuthHostname(url)

  // Try to extract final destination from common redirect params
  let destinationUrl = ''
  try {
    const u = new URL(url)
    destinationUrl = u.searchParams.get('continue') ||
      u.searchParams.get('redirect_uri') ||
      u.searchParams.get('return_to') ||
      u.searchParams.get('redirect') ||
      ''
  } catch { /* ignore */ }

  const authWin = new BrowserWindow({
    width: 500,
    height: 700,
    parent,
    modal: false,
    title: 'Sign In',
    icon: iconPng,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Use the session's clean UA (already configured by configureSession)
  authWin.loadURL(url)

  // Close the auth popup and tell the main window to navigate to the destination
  let authClosed = false
  const closeAuth = (navUrl?: string) => {
    if (authClosed) return
    authClosed = true
    const finalUrl = navUrl || destinationUrl
    log.info('auth complete, closing auth window', { destination: finalUrl })
    setTimeout(() => {
      if (!parent.isDestroyed()) {
        parent.webContents.send('auth-complete', finalUrl)
      }
      if (!authWin.isDestroyed()) authWin.close()
    }, 300)
  }

  // Detect when auth finishes: user navigates away from the auth provider's hostname
  const checkAuthDone = (_e: Event, navUrl: string) => {
    try {
      const navHost = new URL(navUrl).hostname
      if (navHost !== authHostname) closeAuth(navUrl)
    } catch { /* ignore */ }
  }

  authWin.webContents.on('will-navigate', checkAuthDone)
  authWin.webContents.on('did-navigate', checkAuthDone)

  authWin.on('closed', () => {
    if (!authClosed && !parent.isDestroyed()) {
      if (destinationUrl) {
        parent.webContents.send('auth-complete', destinationUrl)
      }
    }
  })
}

export function closeWorkspaceWindow(workspaceId: string): void {
  const win = workspaceWindows.get(workspaceId)
  if (win && !win.isDestroyed()) {
    log.window('closeWorkspaceWindow', workspaceId)
    win.close()
  }
  workspaceWindows.delete(workspaceId)
}

export function createWorkspaceWindow(profileId: string, workspaceId: string, workspaceName: string): BrowserWindow {
  log.window('createWorkspaceWindow', { profileId, workspaceId, workspaceName })

  const existing = workspaceWindows.get(workspaceId)
  if (existing && !existing.isDestroyed()) {
    log.window('window already exists, focusing', workspaceId)
    existing.focus()
    return existing
  }

  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    title: `${workspaceName} — Newbro`,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { autoHideMenuBar: true, titleBarOverlay: true }),
    icon: iconPng,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      nativeWindowOpen: true,
    },
  })
  if (!isMac) {
    win.setMenuBarVisibility(false)
  }

  workspaceWindows.set(workspaceId, win)
  saveOpenWorkspaceIds([...workspaceWindows.keys()])
  installTabCycleInputShortcuts(win.webContents, win)

  win.on('closed', () => {
    workspaceWindows.delete(workspaceId)
    saveOpenWorkspaceIds([...workspaceWindows.keys()])
  })

  // Allow renderer-created detached dialog windows and hide their native header.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
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
    return { action: 'deny' }
  })

  // Redirect webview popups to the renderer as new tabs
  win.webContents.on('did-attach-webview', (_event, webContents) => {
    installTabCycleInputShortcuts(webContents, win)

    webContents.setWindowOpenHandler(({ url }) => {
      if (!win.isDestroyed()) {
        win.webContents.send('open-url-as-tab', url)
      }
      return { action: 'deny' }
    })

    // Intercept auth pages: open in a real BrowserWindow so providers don't block webview sign-in.
    // The webview's session is shared with the auth window so cookies transfer automatically.
    webContents.on('will-navigate', (e, url) => {
      if (isAuthUrl(url)) {
        e.preventDefault()
        openAuthWindow(url, webContents.session, win)
      }
    })
  })

  const params = `?profileId=${profileId}&workspaceId=${workspaceId}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + params)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      search: `profileId=${profileId}&workspaceId=${workspaceId}`,
    })
  }

  return win
}

export function rebuildMenu(): void {
  buildMenu()
}

function buildMenu(): void {
  const settings = loadSettings()
  const kb = { ...DEFAULT_KEYBINDINGS, ...settings.keybindings }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Newbro',
      submenu: [
        {
          label: 'About Newbro',
          click: () => {
            app.setAboutPanelOptions({
              applicationName: 'Newbro',
              applicationVersion: app.getVersion(),
              copyright: 'Newbro Browser',
              version: '',
            })
            app.showAboutPanel()
          },
        },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: kb['settings'],
          click: (_item, win) => win?.webContents.send('shortcut', 'settings'),
        },
        { type: 'separator' },
        { label: 'Hide Newbro', role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Newbro', role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: kb['new-tab'],
          click: (_item, win) => win?.webContents.send('shortcut', 'new-tab'),
        },
        {
          label: 'Close Tab',
          accelerator: kb['close-tab'],
          click: (_item, win) => win?.webContents.send('shortcut', 'close-tab'),
        },
        {
          label: 'Close Window',
          accelerator: kb['close-window'],
          click: (_item, win) => {
            if (win && !win.isDestroyed()) win.close()
          },
        },
        { type: 'separator' },
        {
          label: 'New Workspace',
          accelerator: kb['new-workspace'],
          click: (_item, win) => win?.webContents.send('shortcut', 'new-workspace'),
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
        { role: 'toggleDevTools' },
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
          click: (_item, win) => win?.webContents.send('shortcut', 'focus-url'),
        },
        {
          label: 'Search Everything',
          accelerator: kb['search'],
          click: (_item, win) => win?.webContents.send('shortcut', 'search'),
        },
        {
          label: 'Command Palette',
          accelerator: kb['command-palette'],
          click: (_item, win) => win?.webContents.send('shortcut', 'command-palette'),
        },
        {
          label: 'Toggle Sidebar',
          accelerator: kb['toggle-sidebar'],
          click: (_item, win) => win?.webContents.send('shortcut', 'toggle-sidebar'),
        },
        { type: 'separator' },
        {
          label: 'Back',
          accelerator: kb['back'],
          click: (_item, win) => win?.webContents.send('shortcut', 'back'),
        },
        {
          label: 'Forward',
          accelerator: kb['forward'],
          click: (_item, win) => win?.webContents.send('shortcut', 'forward'),
        },
        {
          label: 'Reload Page',
          accelerator: kb['reload'],
          click: (_item, win) => win?.webContents.send('shortcut', 'reload'),
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

  const activeProfile = state.profiles.find((p: any) => p.id === state.activeProfileId) || state.profiles[0]
  const savedOpenIds = loadOpenWorkspaceIds()
  log.info('opening workspaces for profile', { name: activeProfile.name, workspaceCount: activeProfile.workspaces.length, savedOpenIds })

  if (savedOpenIds.length > 0) {
    // Only open workspaces that were open last time and still exist
    for (const wsId of savedOpenIds) {
      const ws = activeProfile.workspaces.find((w: any) => w.id === wsId)
      if (ws) {
        createWorkspaceWindow(activeProfile.id, ws.id, ws.name)
      }
    }
  } else {
    // First launch or no saved state — open all workspaces
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
    applicationName: 'Newbro',
    applicationVersion: app.getVersion(),
    copyright: 'Newbro Browser',
    version: '',
  })

  configureSession(session.defaultSession)
  applyProxySettingsToAllSessions(loadSettings())

  buildMenu()
  registerIpcHandlers()
  openInitialWindows()

  if (BrowserWindow.getAllWindows().length === 0) {
    createWorkspaceWindow('', '', 'General')
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openInitialWindows()
      if (BrowserWindow.getAllWindows().length === 0) {
        createWorkspaceWindow('', '', 'General')
      }
    }
  })
})

app.on('before-quit', () => {
  const openIds = [...workspaceWindows.keys()]
  log.info('before-quit: saving open workspace IDs', { openIds })
  saveOpenWorkspaceIds(openIds)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
