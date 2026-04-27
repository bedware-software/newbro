import { ipcMain, BrowserWindow, dialog, app, Menu, session, screen } from 'electron'
import * as tls from 'tls'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { loadState, saveState } from './store'
import { loadSettings, saveSettings, type Settings } from './settings-store'
import { setupPartitionSession, createWorkspaceWindow, rebuildMenu, applyProxySettingsToAllSessions, addBypassedCertOrigin } from './index'
import { log } from './log'
import { checkForUpdatesNow, downloadUpdateNow, installUpdateNow, getLatestStatus } from './updater'
import {
  activateTab,
  createTab,
  destroyTab,
  toggleExtensionPopup,
  closeExtensionPopup,
  moveExtensionPopup,
  setWindowBounds,
  tabExecuteJS,
  tabGetState,
  tabGoBack,
  tabGoForward,
  tabNavigate,
  tabReload,
  tabStop,
  type TabBounds,
} from './tab-views'
import {
  listExtensions,
  installExtensionById,
  uninstallExtension,
  setExtensionEnabled,
  setExtensionPinned,
  openOptionsPageUrl,
  getActionPopupPathForTab,
  extractExtensionIdFromUrl,
} from './extensions/manager'
import { registerDropdownIpc } from './dropdown-window'

interface CertInfo {
  subject: { CN?: string; O?: string; OU?: string }
  issuer: { CN?: string; O?: string; OU?: string }
  validFrom: string
  validTo: string
  serialNumber: string
  fingerprint256: string
  pubkeyFingerprint?: string
  subjectAltNames?: string
  protocol?: string
  cipher?: string
  bits?: number
}

function getCertificate(hostname: string, port = 443): Promise<CertInfo | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { socket.destroy(); resolve(null) }, 5000)
    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false }, () => {
      clearTimeout(timeout)
      const cert = socket.getPeerCertificate(true)
      const cipher = socket.getCipher()
      const protocol = socket.getProtocol()
      if (!cert || !cert.subject) { socket.destroy(); resolve(null); return }
      // X.509 subjects/issuers in newer @types/node may surface multi-value
      // RDNs as `string[]`. We only display the first one — collapsing the
      // array on the way out keeps CertInfo's existing string-only shape.
      const flat = (v: string | string[] | undefined): string | undefined =>
        Array.isArray(v) ? v[0] : v
      resolve({
        subject: { CN: flat(cert.subject.CN), O: flat(cert.subject.O), OU: flat(cert.subject.OU) },
        issuer: { CN: flat(cert.issuer?.CN), O: flat(cert.issuer?.O), OU: flat(cert.issuer?.OU) },
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        serialNumber: cert.serialNumber || '',
        fingerprint256: cert.fingerprint256 || '',
        pubkeyFingerprint: cert.fingerprint || '',
        subjectAltNames: cert.subjectaltname || '',
        protocol: protocol || undefined,
        cipher: cipher?.name,
        bits: cipher?.version ? undefined : undefined,
      })
      socket.destroy()
    })
    socket.on('error', () => { clearTimeout(timeout); resolve(null) })
  })
}

// ── Detached popup window tracking ──
// Popups opened via window.open() from a workspace window (e.g. SettingsDialog,
// CommandPalette). We track them so the drag IPC handlers below can safely
// identify which window the renderer is trying to move.
const detachedPopups = new Set<BrowserWindow>()

export function registerDetachedPopup(popup: BrowserWindow): void {
  detachedPopups.add(popup)
  popup.once('closed', () => detachedPopups.delete(popup))
}

// Drag session state for detached popup dragging.
//
// Why this is complicated: on Windows with non-100% DPI scaling there is a
// long-standing Electron/Chromium bug (electron/electron#9477, open since 2017)
// where `BrowserWindow.setPosition()` silently grows the window by 1–3 px on
// every call. Dragging calls setPosition ~60×/sec, so the popup visibly
// "grows" while the user drags. Calling `setBounds({ width, height, x, y })`
// with CONSTANT width/height captured ONCE at drag start (never re-read via
// `getBounds()`/`getSize()`, which also return DPI-skewed values) is the
// accepted workaround from that issue's thread.
let detachedDragSession: {
  popup: BrowserWindow
  startWinX: number
  startWinY: number
  // Captured once, never updated during the drag — see the note above.
  winWidth: number
  winHeight: number
  startCursorX: number
  startCursorY: number
} | null = null

export function registerIpcHandlers(): void {
  ipcMain.handle('store:load', () => {
    const state = loadState()
    log.ipc('store:load', state ? 'has data' : 'null')
    return state
  })

  ipcMain.handle('store:save', (_e, state: unknown) => {
    log.ipc('store:save', 'saving state')
    saveState(state)
    const senderWindow = BrowserWindow.fromWebContents(_e.sender)
    const allWindows = BrowserWindow.getAllWindows()
    const otherCount = allWindows.filter(w => w !== senderWindow && !w.isDestroyed()).length
    if (otherCount > 0) {
      log.ipc('store:save', `broadcasting to ${otherCount} other windows`)
    }
    // Only broadcast the profiles data — active* fields are window-specific
    const profilesOnly = { profiles: (state as any)?.profiles }
    for (const win of allWindows) {
      if (win !== senderWindow && !win.isDestroyed()) {
        win.webContents.send('state:updated', profilesOnly)
      }
    }
  })

  ipcMain.handle('session:setup', (_e, partition: string) => {
    log.ipc('session:setup', partition)
    setupPartitionSession(partition)
  })

  // ── Tab hosting (WebContentsView) ──
  // The renderer tells main when to create/destroy/activate/position a tab;
  // main runs each tab as a WebContentsView child of the owning window's
  // contentView. See src/main/tab-views.ts for the implementation and why
  // we replaced <webview> tags.
  ipcMain.handle('tab:create', (_e, tabId: string, partition: string, url: string, active: boolean) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return
    createTab({ windowId: win.id, tabId, partition, url, active })
  })

  ipcMain.handle('tab:destroy', (_e, tabId: string) => {
    destroyTab(tabId)
  })

  ipcMain.handle('tab:activate', (_e, tabId: string, url: string) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return
    activateTab(win.id, tabId, url)
  })

  // High-frequency: bounds update on resize/sidebar toggle. `send` (no
  // round-trip) matches the detached-window drag pattern.
  ipcMain.on('tab:bounds', (_e, bounds: TabBounds) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return
    setWindowBounds(win.id, bounds)
  })

  ipcMain.handle('tab:navigate', (_e, tabId: string, url: string) => {
    tabNavigate(tabId, url)
  })

  ipcMain.handle('tab:go-back', (_e, tabId: string) => {
    tabGoBack(tabId)
  })

  ipcMain.handle('tab:go-forward', (_e, tabId: string) => {
    tabGoForward(tabId)
  })

  ipcMain.handle('tab:reload', (_e, tabId: string, ignoreCache: boolean) => {
    tabReload(tabId, ignoreCache)
  })

  ipcMain.handle('tab:stop', (_e, tabId: string) => {
    tabStop(tabId)
  })

  ipcMain.handle('tab:get-state', (_e, tabId: string) => {
    return tabGetState(tabId)
  })

  ipcMain.handle('tab:execute-js', (_e, tabId: string, code: string) => {
    return tabExecuteJS(tabId, code)
  })

  // ── Extensions ──
  ipcMain.handle('extensions:list', () => {
    return listExtensions()
  })

  ipcMain.handle('extensions:install', async (_e, idOrUrl: string) => {
    const id = extractExtensionIdFromUrl(idOrUrl)
    if (!id) throw new Error('Could not parse extension ID from input')
    return await installExtensionById(id)
  })

  ipcMain.handle('extensions:uninstall', async (_e, extensionId: string) => {
    await uninstallExtension(extensionId)
    return listExtensions()
  })

  ipcMain.handle('extensions:set-enabled', async (_e, extensionId: string, enabled: boolean) => {
    await setExtensionEnabled(extensionId, enabled)
    return listExtensions()
  })

  ipcMain.handle('extensions:set-pinned', async (_e, extensionId: string, pinned: boolean) => {
    await setExtensionPinned(extensionId, pinned)
    return listExtensions()
  })

  ipcMain.handle('extensions:open-options', (_e, extensionId: string) => {
    const url = openOptionsPageUrl(extensionId)
    if (!url) return null
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (win && !win.isDestroyed()) {
      win.webContents.send('open-url-as-tab', url)
    }
    return url
  })

  // Toggle the extension's popup. Pass the icon's bounding rect (in window-
  // relative CSS pixels) so main can position the floating popup relative
  // to it. Returns 'opened' | 'closed' | 'no-popup' so the renderer can
  // update the icon's pressed state.
  ipcMain.handle(
    'extensions:open-action',
    (
      _e,
      extensionId: string,
      tabId: string | null,
      anchor: { x: number; y: number; width: number; height: number } | null
    ) => {
      const popupPath = getActionPopupPathForTab(extensionId, tabId)
      if (!popupPath) return 'no-popup'
      const win = BrowserWindow.fromWebContents(_e.sender)
      if (!win) return 'closed'
      const a = anchor ?? { x: 0, y: 0, width: 0, height: 0 }
      return toggleExtensionPopup(win.id, extensionId, popupPath, a)
    }
  )

  ipcMain.handle('extensions:close-popup', (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return false
    return closeExtensionPopup(win.id)
  })

  // Fire-and-forget: high-frequency from ResizeObserver on the icon row.
  ipcMain.on(
    'extensions:move-popup',
    (
      e,
      extensionId: string,
      anchor: { x: number; y: number; width: number; height: number }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return
      moveExtensionPopup(win.id, extensionId, anchor)
    }
  )

  ipcMain.handle('workspace:open-window', (_e, profileId: string, workspaceId: string, workspaceName: string, targetTabId?: string) => {
    log.ipc('workspace:open-window', { profileId, workspaceId, workspaceName, targetTabId })
    createWorkspaceWindow(profileId, workspaceId, workspaceName, targetTabId)
  })

  ipcMain.handle('window:set-title', (_e, title: string) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (win && !win.isDestroyed()) {
      win.setTitle(title)
    }
  })

  ipcMain.handle('window:set-titlebar-overlay', (_e, options: { color: string; symbolColor: string; height: number }) => {
    if (process.platform === 'darwin') return
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (win && !win.isDestroyed()) {
      win.setTitleBarOverlay(options)
    }
  })

  // Move OS-level keyboard focus from any active WebContentsView (a tab page)
  // back to the parent window's main webContents (the renderer). DOM .focus()
  // on a renderer-side input only sets DOM focus within its own webContents
  // — it doesn't make that webContents the OS focus owner when a sibling
  // WebContentsView currently is. Without this, e.g. Cmd+L visually selects
  // the URL bar text but typed characters still go to the underlying page.
  ipcMain.on('window:focus-renderer', (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win || win.isDestroyed()) return
    win.webContents.focus()
  })

  ipcMain.handle('window:close', (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (win && !win.isDestroyed()) {
      win.close()
    }
  })

  ipcMain.handle('window:minimize', (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (win && !win.isDestroyed()) {
      win.minimize()
    }
  })

  ipcMain.handle('window:maximize', (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (win && !win.isDestroyed()) {
      win.maximize()
    }
  })

  ipcMain.handle('window:restore', (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) {
      win.restore()
    } else if (win.isMaximized()) {
      win.unmaximize()
    }
  })

  // ── Detached popup drag ──
  // drag-start is `handle` (needs response). drag-update / drag-end are `on`
  // (fire-and-forget `ipcRenderer.send`) — `invoke` round-trips on every
  // mousemove created noticeable lag during the drag.
  ipcMain.handle('detached-window:drag-start', () => {
    const popup = BrowserWindow.getFocusedWindow()
    if (!popup || popup.isDestroyed() || !detachedPopups.has(popup)) {
      detachedDragSession = null
      return false
    }
    // getBounds is only called HERE, once. See the session-state comment above
    // for why we never re-read size during the drag.
    const bounds = popup.getBounds()
    const { x: startCursorX, y: startCursorY } = screen.getCursorScreenPoint()
    detachedDragSession = {
      popup,
      startWinX: bounds.x,
      startWinY: bounds.y,
      winWidth: bounds.width,
      winHeight: bounds.height,
      startCursorX,
      startCursorY,
    }
    return true
  })

  ipcMain.on('detached-window:drag-update', () => {
    const s = detachedDragSession
    if (!s || s.popup.isDestroyed()) return
    const { x, y } = screen.getCursorScreenPoint()
    const dx = x - s.startCursorX
    const dy = y - s.startCursorY
    // setBounds with constant width/height — the Windows DPI workaround.
    s.popup.setBounds({
      x: Math.round(s.startWinX + dx),
      y: Math.round(s.startWinY + dy),
      width: s.winWidth,
      height: s.winHeight,
    })
  })

  ipcMain.on('detached-window:drag-end', () => {
    detachedDragSession = null
  })

  // Reveal a detached popup once the renderer has finished rendering content.
  // Popups start at opacity 0 (set in did-create-window) so they are physically
  // invisible at the OS compositor level while React paints.  Setting opacity
  // back to 1 makes the fully-rendered window appear in a single
  // compositor frame — no white flash.
  ipcMain.on('detached-window:show', (_e) => {
    for (const popup of detachedPopups) {
      if (!popup.isDestroyed() && popup.getOpacity() < 1) {
        popup.setOpacity(1)
        popup.focus()
      }
    }
  })

  ipcMain.handle('workspace:close-windows', (_e, workspaceIds: string[]) => {
    log.ipc('workspace:close-windows', workspaceIds)
    for (const wsId of workspaceIds) {
      const { closeWorkspaceWindow } = require('./index')
      closeWorkspaceWindow(wsId)
    }
  })

  // ── Settings ──
  // Receive renderer logs and write to log file
  ipcMain.on('log:write', (_e, level: string, msg: string) => {
    log.renderer(level, msg)
  })

  ipcMain.handle('cert:get-info', async (_e, url: string) => {
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:') return null
      const port = u.port ? parseInt(u.port) : 443
      return await getCertificate(u.hostname, port)
    } catch {
      return null
    }
  })

  ipcMain.handle('cert:bypass-origin', (_e, url: string) => {
    log.ipc('cert:bypass-origin', url)
    addBypassedCertOrigin(url)
  })

  ipcMain.handle('settings:load', () => {
    log.ipc('settings:load')
    return loadSettings()
  })

  ipcMain.handle('settings:save', (_e, settings: unknown) => {
    log.ipc('settings:save')
    const nextSettings = settings as Settings
    saveSettings(nextSettings)
    applyProxySettingsToAllSessions(nextSettings)
    // Rebuild menu with new keybindings
    rebuildMenu()
    // Broadcast settings to all windows
    const allWindows = BrowserWindow.getAllWindows()
    for (const win of allWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('settings:updated', nextSettings)
      }
    }
  })

  ipcMain.handle('dialog:open-bookmark-file', async (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import Bookmarks',
      filters: [{ name: 'HTML Files', extensions: ['html', 'htm'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const content = fs.readFileSync(result.filePaths[0], 'utf-8')
    return content
  })

  ipcMain.on('app:quit', () => {
    app.quit()
  })

  // Returns where the app keeps its mutable state on disk. Used by the
  // About tab in Settings so users can verify they're running dev vs
  // stable (each maps to a different folder once we set the app name).
  ipcMain.handle('app:get-paths', () => {
    return {
      userData: app.getPath('userData'),
      cache: app.getPath('cache'),
      logs: app.getPath('logs'),
      appName: app.getName(),
    }
  })

  ipcMain.handle('app:wipe-data', async () => {
    log.ipc('app:wipe-data', 'start')
    const userDataDir = app.getPath('userData')

    // Best-effort in-process clear of session data. This frees most Chromium
    // file locks before we relaunch, so the post-quit rmdir has a much better
    // chance of succeeding on Windows.
    try {
      const sessions = new Set<Electron.Session>([session.defaultSession])
      // Also clear any partitioned sessions we know about via existing windows.
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          sessions.add(win.webContents.session)
        } catch {
          /* ignore */
        }
      }
      await Promise.all(
        Array.from(sessions).map(async (ses) => {
          try {
            await ses.clearStorageData()
            await ses.clearCache()
            await ses.clearAuthCache()
            await ses.clearHostResolverCache()
          } catch (err) {
            log.warn('wipe-data: failed to clear a session', err)
          }
        })
      )
    } catch (err) {
      log.warn('wipe-data: session clear failed', err)
    }

    // Spawn a detached helper that waits for this process to exit, then
    // recursively deletes the userData directory and relaunches the app.
    // Running the delete after quit avoids file-lock failures on Windows
    // where Chromium holds onto files under Partitions/ and GPUCache/ until
    // the process fully exits. The helper — not app.relaunch() — starts the
    // new instance so the relaunched app can't race with the wipe and
    // re-create files mid-delete.
    //
    // In dev mode we skip the relaunch: `electron-vite dev` (our parent
    // wrapper) tears down the Vite dev server when its Electron child
    // exits, so a relaunched Electron would point at a dead
    // ELECTRON_RENDERER_URL and show a blank window. The developer just
    // runs `npm run dev` again, which restarts both the dev server and
    // the app cleanly.
    const shouldRelaunch = app.isPackaged
    try {
      const pid = process.pid
      const tmpDir = app.getPath('temp')
      const scriptPath = path.join(tmpDir, `newbro-wipe-${pid}-${Date.now()}.js`)

      // Capture the current launch command so the helper can relaunch a
      // fresh instance with the same executable and args. ELECTRON_RUN_AS_NODE
      // must be stripped from the child env — otherwise the relaunched app
      // would start in Node mode and never open a window.
      const relaunchExec = process.execPath
      const relaunchArgs = process.argv.slice(1)
      const relaunchEnv: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (key === 'ELECTRON_RUN_AS_NODE') continue
        if (typeof value === 'string') relaunchEnv[key] = value
      }

      const script = `
const fs = require('fs');
const { spawn } = require('child_process');
const pid = ${pid};
const target = ${JSON.stringify(userDataDir)};
const relaunchExec = ${JSON.stringify(relaunchExec)};
const relaunchArgs = ${JSON.stringify(relaunchArgs)};
const relaunchEnv = ${JSON.stringify(relaunchEnv)};
const shouldRelaunch = ${JSON.stringify(shouldRelaunch)};

function alive(p) {
  try { process.kill(p, 0); return true } catch { return false }
}

(async () => {
  // Wait for parent to exit (max ~15s)
  for (let i = 0; i < 150; i++) {
    if (!alive(pid)) break
    await new Promise(r => setTimeout(r, 100))
  }
  // Give Chromium a final moment to release file handles
  await new Promise(r => setTimeout(r, 500))
  // Retry deletion — locks can linger briefly
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      break
    } catch (err) {
      await new Promise(r => setTimeout(r, 500))
    }
  }
  // Relaunch the app AFTER the wipe is fully done, so the fresh instance
  // sees an empty userData and re-creates it cleanly.
  if (shouldRelaunch) {
    try {
      const child = spawn(relaunchExec, relaunchArgs, {
        detached: true,
        stdio: 'ignore',
        env: relaunchEnv,
      })
      child.unref()
    } catch (err) {
      // Best-effort — if relaunch fails the user can start the app manually.
    }
  }
  try { fs.unlinkSync(__filename) } catch {}
})()
`
      fs.writeFileSync(scriptPath, script, 'utf8')

      const child = spawn(process.execPath, [scriptPath], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      child.unref()
      log.info('wipe-data: helper spawned', {
        pid: child.pid,
        scriptPath,
        willRelaunch: shouldRelaunch,
      })
    } catch (err) {
      log.error('wipe-data: failed to spawn helper', err)
    }

    // Tear down every window and exit. The detached helper will wipe
    // userData once this process dies, then launch a fresh instance.
    log.info('wipe-data: quitting so helper can take over')
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.removeAllListeners('close')
        win.destroy()
      } catch {
        /* ignore */
      }
    }
    app.exit(0)
  })

  // ── Auto-updater ──
  ipcMain.handle('updater:check', async () => {
    return await checkForUpdatesNow()
  })
  ipcMain.handle('updater:download', async () => {
    await downloadUpdateNow()
  })
  ipcMain.handle('updater:install', () => {
    installUpdateNow()
  })
  ipcMain.handle('updater:get-status', () => {
    return getLatestStatus()
  })
  ipcMain.handle('updater:get-app-version', () => {
    return app.getVersion()
  })

  registerDropdownIpc()
}
