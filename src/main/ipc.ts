import { ipcMain, BrowserWindow, dialog } from 'electron'
import * as tls from 'tls'
import * as fs from 'fs'
import { loadState, saveState } from './store'
import { loadSettings, saveSettings, type Settings } from './settings-store'
import { setupPartitionSession, createWorkspaceWindow, rebuildMenu, applyProxySettingsToAllSessions } from './index'
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

  ipcMain.handle('workspace:open-window', (_e, profileId: string, workspaceId: string, workspaceName: string) => {
    log.ipc('workspace:open-window', { profileId, workspaceId, workspaceName })
    createWorkspaceWindow(profileId, workspaceId, workspaceName)
  })

  ipcMain.handle('window:set-title', (_e, title: string) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (win && !win.isDestroyed()) {
      win.setTitle(title)
    }
  })

  ipcMain.handle('window:close', (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (win && !win.isDestroyed()) {
      win.close()
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
}
