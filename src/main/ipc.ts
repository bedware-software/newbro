import { ipcMain, BrowserWindow, dialog, app, Menu, session, screen } from 'electron'
import * as tls from 'tls'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { loadState, saveState } from './store'
import { loadSettings, saveSettings, type Settings } from './settings-store'
import { setupPartitionSession, createWorkspaceWindow, rebuildMenu, applyProxySettingsToAllSessions, addBypassedCertOrigin } from './index'
import { log } from './log'

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
      resolve({
        subject: { CN: cert.subject.CN, O: cert.subject.O, OU: cert.subject.OU },
        issuer: { CN: cert.issuer?.CN, O: cert.issuer?.O, OU: cert.issuer?.OU },
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

// Drag session state for detached popup dragging. We compute every frame's new
// position in the main process using `screen.getCursorScreenPoint()` and
// `BrowserWindow.setPosition()` — both operate in consistent DIP coordinates,
// avoiding the DPI-scaling mismatch that `popup.screenX` / `popup.moveTo()`
// exhibit on Windows (which caused the window to grow while dragging).
let detachedDragSession: {
  popup: BrowserWindow
  startWinX: number
  startWinY: number
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
  // The renderer calls these during a header drag. We use main-process APIs
  // (screen.getCursorScreenPoint + BrowserWindow.setPosition) so the coordinate
  // space is always DIP and never mismatches with DOM `screenX`/`moveTo()`.
  ipcMain.handle('detached-window:drag-start', () => {
    const popup = BrowserWindow.getFocusedWindow()
    if (!popup || popup.isDestroyed() || !detachedPopups.has(popup)) {
      detachedDragSession = null
      return false
    }
    const [startWinX, startWinY] = popup.getPosition()
    const { x: startCursorX, y: startCursorY } = screen.getCursorScreenPoint()
    detachedDragSession = { popup, startWinX, startWinY, startCursorX, startCursorY }
    return true
  })

  ipcMain.handle('detached-window:drag-update', () => {
    const s = detachedDragSession
    if (!s || s.popup.isDestroyed()) return
    const { x, y } = screen.getCursorScreenPoint()
    const dx = x - s.startCursorX
    const dy = y - s.startCursorY
    s.popup.setPosition(Math.round(s.startWinX + dx), Math.round(s.startWinY + dy))
  })

  ipcMain.handle('detached-window:drag-end', () => {
    detachedDragSession = null
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

  ipcMain.handle('context-menu:show', (_e, items: { id: string; label: string; type?: string; enabled?: boolean; submenu?: { id: string; label: string }[] }[]) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return null
    return new Promise<string | null>((resolve) => {
      const template = items.map((item) => {
        if (item.type === 'separator') return { type: 'separator' as const }
        if (item.submenu) {
          return {
            label: item.label,
            submenu: item.submenu.map((sub) => ({
              label: sub.label,
              click: () => resolve(sub.id),
            })),
          }
        }
        return {
          label: item.label,
          enabled: item.enabled !== false,
          click: () => resolve(item.id),
        }
      })
      const menu = Menu.buildFromTemplate(template)
      menu.popup({ window: win, callback: () => resolve(null) })
    })
  })

  ipcMain.on('app:quit', () => {
    app.quit()
  })

  ipcMain.on('show-about-panel', (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    // On macOS the about panel can appear behind the window — use the menu item role approach
    if (process.platform === 'darwin') {
      const { Menu } = require('electron')
      Menu.sendActionToFirstResponder('orderFrontStandardAboutPanel:')
    } else {
      app.showAboutPanel()
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
      log.info('wipe-data: helper spawned', { pid: child.pid, scriptPath })
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
}
